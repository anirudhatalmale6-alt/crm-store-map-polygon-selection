'use strict';
/* Google Geocoding API wrapper: address -> {lat, lng} | null.
 *
 * Called once per store and the result is written to the stores table, so a page
 * refresh never costs a request. See the geocoded_at column in migration 001.
 */
const ENDPOINT = 'https://maps.googleapis.com/maps/api/geocode/json';
const { explainDenial } = require('./egress');

/* Google returns a LIST, and this code used to read results[0] and drop the rest.
 * That is not a saving — the whole list arrives in the one response that has already
 * been paid for. It cost accuracy on a real row:
 *
 *   "KM 1 VIA AEROPUERTO LAS PALMAS ..., Rionegro, Antioquia"
 *
 * results[0] was a neighbourhood of MEDELLIN, 23 km from where the store is, and
 * results[1] was RIONEGRO. Taking the first answer threw away the right one.
 *
 * So reporting what Google said is kept apart from choosing which answer to take:
 * this file reports, and the caller decides using a fact Google does not have —
 * where the customer's other stores in that same town are.
 */
function toCandidate(hit) {
  if (!hit || !hit.geometry || !hit.geometry.location) return null;
  const { lat, lng } = hit.geometry.location;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    lat, lng,
    formattedAddress: hit.formatted_address,
    precision: hit.geometry.location_type,
    /* Google's own admission that it did not match everything it was sent. Unlike
       location_type this is not a grade of the ANSWER, it is a statement about the
       QUESTION, which is why it survives as its own field rather than folding in. */
    partial: Boolean(hit.partial_match),
    types: hit.types || [],
  };
}

module.exports = function makeGeocoder({ apiKey, region, fetchImpl = fetch }) {
  if (!apiKey) throw new Error('geocoder: apiKey is required');

  /** geocode(address)              -> best-guess candidate | null   (unchanged)
   *  geocode(address, {all: true}) -> every candidate, in Google's order | []   */
  return async function geocode(address, opts = {}) {
    const all = Boolean(opts.all);
    if (!address || !String(address).trim()) return all ? [] : null;

    const url = new URL(ENDPOINT);
    url.searchParams.set('address', address);
    url.searchParams.set('key', apiKey);
    if (region) url.searchParams.set('region', region);   // e.g. 'es' — biases results

    const res = await fetchImpl(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`geocoder: HTTP ${res.status}`);
    const body = await res.json();

    switch (body.status) {
      case 'OK':
        break;
      case 'ZERO_RESULTS':
        return all ? [] : null;         // a bad address, not a failure — don't retry
      case 'OVER_QUERY_LIMIT':
      case 'OVER_DAILY_LIMIT':
        // Throw rather than return null: returning null would let the caller write
        // "not geocodable" into the database for an address that is perfectly fine,
        // and it would never be retried.
        throw new Error(`geocoder: quota exceeded (${body.status})`);
      case 'REQUEST_DENIED': {
        /* Nearly always an IP restriction rather than a bad key, and Google says
           which address it saw. Repeat that address back instead of sending the
           operator off to re-check a key that is fine. */
        const why = explainDenial(body.error_message);
        throw new Error('geocoder: request denied - '
          + (body.error_message || 'check the API key and that Geocoding API is enabled')
          + (why ? `\n  ${why.hint}` : ''));
      }
      default:
        throw new Error(`geocoder: ${body.status} ${body.error_message || ''}`.trim());
    }

    const hits = (body.results || []).map(toCandidate).filter(Boolean);
    return all ? hits : (hits[0] || null);
  };
};

module.exports.toCandidate = toCandidate;

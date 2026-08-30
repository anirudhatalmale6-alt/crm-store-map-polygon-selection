'use strict';
/* Google Geocoding API wrapper: address -> {lat, lng} | null.
 *
 * Called once per store and the result is written to the stores table, so a page
 * refresh never costs a request. See the geocoded_at column in migration 001.
 */
const ENDPOINT = 'https://maps.googleapis.com/maps/api/geocode/json';

module.exports = function makeGeocoder({ apiKey, region, fetchImpl = fetch }) {
  if (!apiKey) throw new Error('geocoder: apiKey is required');

  return async function geocode(address) {
    if (!address || !String(address).trim()) return null;

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
        return null;                    // a bad address, not a failure — don't retry
      case 'OVER_QUERY_LIMIT':
      case 'OVER_DAILY_LIMIT':
        // Throw rather than return null: returning null would let the caller write
        // "not geocodable" into the database for an address that is perfectly fine,
        // and it would never be retried.
        throw new Error(`geocoder: quota exceeded (${body.status})`);
      case 'REQUEST_DENIED':
        throw new Error(`geocoder: request denied - ${body.error_message || 'check the API key and that Geocoding API is enabled'}`);
      default:
        throw new Error(`geocoder: ${body.status} ${body.error_message || ''}`.trim());
    }

    const hit = body.results && body.results[0];
    if (!hit || !hit.geometry || !hit.geometry.location) return null;
    const { lat, lng } = hit.geometry.location;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    return { lat, lng, formattedAddress: hit.formatted_address, precision: hit.geometry.location_type };
  };
};

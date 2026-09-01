'use strict';
/* Your actual schema, as measured from ventas_api.sql — not as guessed.
 *
 * The demo was written against a single `stores` table with an `address` column,
 * because that is what I had to assume before seeing your database. Yours is
 * shaped differently in three ways that matter, and each one changes where the
 * location columns have to live:
 *
 *   1. Stores are rows in `clients`, keyed by `cl_id`.
 *   2. The address is NOT on `clients`. It is on `client_address`, one row per
 *      client, enforced by the unique key `uq_client_address (client_id)`.
 *      `clients.c_address` also exists but is empty for 1,755 of 2,657 rows, so
 *      it cannot be the column the map reads.
 *   3. The address is a set of columns (street / city / state / country), not one
 *      string, so the thing that gets geocoded has to be composed.
 *
 * Because the address lives on `client_address`, the coordinates go there too.
 * That is not a style preference: `location_address` only detects a stale pin by
 * comparing against the address it was placed for, and a same-row comparison
 * cannot drift out of sync with a join. It is also 1:1, so nothing fans out.
 */

const { ident } = require('./schema');

/** Column names as they exist in your database today. */
const VENTAS = {
  clients:       'clients',
  clientId:      'cl_id',
  clientName:    'c_name',
  clientType:    'type',       // ENUM('store','potential')
  clientStatus:  'c_status',   // 0 / 1
  clientNit:     'c_nit',
  siteId:        'site_id',

  addresses:     'client_address',
  addrId:        'ca_id',
  addrClientId:  'client_id',
  street:        'address',
  city:          'city_name',
  state:         'state_name',
  country:       'country_name',
};

/* The columns migration 002 adds. These are ours to name, so they are named for
   what they are rather than to match anything already in the CRM. */
const LOCATION_COLS = {
  latitude:        'latitude',
  longitude:       'longitude',
  geocodedAt:      'geocoded_at',
  source:          'location_source',
  precision:       'location_precision',
  locationAddress: 'location_address',
};

/** Quote every identifier once, at startup, so a typo fails here and not mid-query. */
function ventasSchema(overrides = {}) {
  const names = { ...VENTAS, ...LOCATION_COLS, ...overrides };
  const q = {};
  for (const key of Object.keys(names)) q[key] = ident(names[key], key);
  return { names, q };
}

/* ── The address that actually gets geocoded ──────────────────────────────────
 *
 * Google is given one string, so four columns have to become one. Two decisions
 * are load-bearing:
 *
 *   - Empty parts are DROPPED, not joined as blanks. 292 rows have no state and
 *     354 have no usable city; ", , Colombia" is a worse query than "Colombia",
 *     and worse still, it is a DIFFERENT string every time a blank moves, which
 *     would make `location_address` report stale pins that never changed.
 *   - 'No identificada' is treated as absent. It is a literal placeholder in 353
 *     of your rows, and handing it to a geocoder asks for a town by that name.
 *
 * The composed string is what gets stored in location_address, so staleness is
 * judged on exactly what was sent — change any part of the address and the pin
 * is correctly flagged, including a city correction that leaves the street alone.
 */
const CITY_PLACEHOLDERS = ['no identificada', 'no identificado', 'n/a', '-', '.', ''];

function isPlaceholder(value) {
  return value == null || CITY_PLACEHOLDERS.includes(String(value).trim().toLowerCase());
}

/* ── 24 of your stores are not in Colombia ────────────────────────────────────
 *
 * `country_name` says 'Colombia' on all 2,657 rows, but 24 of them are in
 * Ecuador, Chile, Costa Rica, Venezuela, Peru, Panama, the Dominican Republic,
 * France and Italy. Whoever entered them marked `state_name = 'Internacional'`
 * and put the COUNTRY in `city_name`.
 *
 * That marker is theirs, not a guess of mine, which is why this rule keys off it
 * rather than off a list of country names I would have to keep. Appending
 * ", Colombia" to "Via G. Buitoni 25, 52037 Sansepolcro, Italia" does not fail —
 * it succeeds, and returns a pin in Colombia. A wrong pin that looks right is the
 * expensive kind.
 */
const INTERNATIONAL_MARKER = 'internacional';

function isInternational(row) {
  return String(row.state == null ? '' : row.state).trim().toLowerCase() === INTERNATIONAL_MARKER;
}

/* Which columns go into the string, in order. The international branch drops
   `state` (it is the literal word "Internacional") and `country` (it is wrong).
   Both implementations below read this same list, so the only way they can
   disagree is by disagreeing about a single part — which is exactly what
   test_ventas.js checks, on every row of the real dump. */
function addressParts(row) {
  return isInternational(row) ? ['street', 'city'] : ['street', 'city', 'state', 'country'];
}

/* TRIM and nothing else. An earlier version also collapsed runs of internal
   whitespace, which reads as an improvement until you notice SQL's TRIM does not
   do it: "CL 108  80 60" would compose one way in the API and another way in the
   batch, and the two would then disagree about staleness on every row that has a
   double space — which here is hundreds of them. The geocoder does not care about
   double spaces. Agreement matters more than tidiness. */
const clean = v => (v == null ? '' : String(v).trim());

/** Compose the geocodable address from a row of client_address. */
function composeAddress(row) {
  const out = [];
  const seen = new Set();
  for (const part of addressParts(row)) {
    const v = clean(row[part]);
    if (v === '' || isPlaceholder(v)) continue;
    /* De-duplicate: 94 of your rows have city_name === state_name, and
       "Bogota, Bogota, Colombia" is not a better query than "Bogota, Colombia". */
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out.join(', ');
}

/* The same composition in SQL, so the batch geocoder can build its candidate set
 * without fetching 2,657 rows first. This has to agree with composeAddress()
 * above; test_ventas.js runs every row of a real dump through both and asserts
 * they produce byte-identical strings. */
function composeAddressSql(q) {
  /* Every comparison below is wrapped in CAST(... AS BINARY). Your columns are
     utf8mb4_general_ci, which is accent-insensitive: plain SQL says
     'Medellín' = 'Medellin' while JavaScript says they differ. Left alone, SQL
     would de-duplicate a city/state pair that JavaScript keeps, the two composed
     strings would differ by one part, and every such row would look permanently
     stale — re-geocoded on every run, forever, for nothing. */
  const key = col => `CAST(LOWER(TRIM(COALESCE(${col}, ''))) AS BINARY)`;
  const lit = s => `CAST('${s}' AS BINARY)`;

  const placeholders = CITY_PLACEHOLDERS.map(p => lit(p)).join(', ');
  /* A part survives if it is not a placeholder and does not repeat an earlier
     part. Comparing against earlier RAW parts rather than earlier KEPT parts is
     the same thing: if an earlier part was dropped as a placeholder, anything
     equal to it is a placeholder too and gets dropped on its own account. */
  const part = (col, earlier) => {
    const tests = [`${key(col)} IN (${placeholders})`, ...earlier.map(e => `${key(col)} = ${key(e)}`)];
    return `CASE WHEN ${tests.join(' OR ')} THEN NULL ELSE NULLIF(TRIM(${col}), '') END`;
  };

  const street  = part(q.street, []);
  const city    = part(q.city,    [q.street]);
  const state   = part(q.state,   [q.street, q.city]);
  const country = part(q.country, [q.street, q.city, q.state]);

  // Same two branches as composeAddress(), in the same order, for the same reason.
  const intl = `${key(q.state)} = ${lit(INTERNATIONAL_MARKER)}`;
  return `CASE WHEN ${intl} THEN CONCAT_WS(', ', ${street}, ${city}) ` +
         `ELSE CONCAT_WS(', ', ${street}, ${city}, ${state}, ${country}) END`;
}

/* ── Is there enough here to place a pin at all? ───────────────────────────────
 *
 * Separated into street and locality because they fail differently and cost
 * differently. A row with a usable city but no street CAN be pinned — at the
 * centre of the city, which is honest and useful at map zoom. A row with neither
 * cannot be pinned by any geocoder and should never be sent to one, because a
 * request that cannot succeed still costs the same as one that does.
 */
/* Two shapes of address count as a street, because your data contains both.
 *
 *   1. A numbered address — "CR 70 C 55 33", "Calle 45 C Bis # 23 -08". These have
 *      a digit, which is the cheapest reliable signal there is.
 *   2. A named place with no number at all — "Hospital Universitario San Jose
 *      Barrios Unidos", "Centro Comercial El Tesoro, El Poblado". 172 of your rows
 *      have no digit, and requiring one threw all of them away. Google finds named
 *      landmarks perfectly well.
 *
 * The dividing line between (2) and junk is length and word count, because the
 * junk is uniformly short: "Xxx", "_", "Ca", "Suba". Measured against your data,
 * 20 characters and 3 words separates the two groups cleanly. A URL is excluded
 * outright — one of your rows has an Instagram profile in the address field.
 */
function hasUsableStreet(row) {
  const s = row.street == null ? '' : String(row.street).trim();
  if (s.length < 5) return false;
  if (/^https?:\/\//i.test(s) || /(^|\W)(instagram|facebook|wa\.me)\./i.test(s)) return false;
  if (/[0-9]/.test(s)) return true;
  return s.length >= 20 && s.split(/\s+/).filter(Boolean).length >= 3;
}

function hasUsableLocality(row) {
  return !isPlaceholder(row.city) || !isPlaceholder(row.state);
}

/* Sometimes the street field holds a place name and the city field is empty:
 * "Mocoa - Putumayo", "Ciudad Jardin Norte", "Kennedy", "Quimbaya", "Vichada".
 * Those are all real Colombian places, and discarding them as junk was wrong —
 * they will not produce a rooftop pin, but they will produce the right town.
 *
 * What is genuinely junk in your data is narrow and identifiable: the literal
 * string "1503" (232 rows), single repeated characters ("xxxx", "___"), two-letter
 * fragments ("Ca"), and one Instagram URL. A place hint therefore needs a letter
 * in it, four characters, and more than one distinct character.
 */
function streetIsPlaceHint(row) {
  const s = row.street == null ? '' : String(row.street).trim();
  if (s.length < 4) return false;
  if (!/[A-Za-zÀ-ÿ]/.test(s)) return false;          // "1503" is not a place name
  if (/^(.)\1*$/.test(s)) return false;               // "xxxx", "____"
  if (/^https?:\/\//i.test(s) || /(^|\W)(instagram|facebook|wa\.me)\./i.test(s)) return false;
  return true;
}

/** 'street' = worth a full geocode, 'locality' = city-centre pin, 'none' = do not send.
 *
 * A usable street is enough on its own. An earlier version of this also demanded a
 * usable city, which threw away rows like
 * "Calle 45 C Bis # 23 -08 Barrio Palermo" — a perfectly findable address whose
 * city field happens to say "No identificada". The country is still appended, so
 * the geocoder has a country and a street, which is what it needs. If it comes
 * back vague, location_precision says so and the row lands on the review list;
 * that is a far better outcome than never asking.
 */
function geocodability(row) {
  if (hasUsableStreet(row)) return 'street';
  if (hasUsableLocality(row) || streetIsPlaceHint(row)) return 'locality';
  return 'none';
}

module.exports = {
  VENTAS, LOCATION_COLS, ventasSchema,
  composeAddress, composeAddressSql, isPlaceholder, isInternational, addressParts,
  hasUsableStreet, hasUsableLocality, streetIsPlaceHint, geocodability,
  CITY_PLACEHOLDERS, INTERNATIONAL_MARKER,
};

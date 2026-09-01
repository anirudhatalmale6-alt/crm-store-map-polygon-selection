'use strict';
/* Where your table and column names live — the ONE file to edit.
 *
 * Everything in the demo is written against a table called `stores` with a column
 * called `category`, because that is a guess. Your CRM almost certainly calls them
 * something else. Change the names here and the migration, the API and the tests
 * all follow; nothing else needs touching.
 *
 * Override without editing the file at all:
 *   STORES_TABLE=tiendas STORES_CATEGORY_COL=categoria node server.js
 */

const DEFAULTS = {
  table:       'stores',
  id:          'id',
  name:        'name',
  category:    'category',
  address:     'address',
  // These are added by migration 001 and are ours to name.
  latitude:    'latitude',
  longitude:   'longitude',
  geocodedAt:  'geocoded_at',
  source:      'location_source',
  precision:   'location_precision',
  // The address the pin was actually placed for. Renaming a store never moves its
  // pin, but editing its ADDRESS should — and without this column there is no way
  // to tell that a pin is now sitting on a street the store has moved away from.
  locationAddress: 'location_address',
};

/* Identifiers cannot be passed as query parameters — `SELECT ? FROM ?` is not a
 * thing — so they get concatenated into the SQL string. That makes this function
 * the only thing standing between a config typo (or a hostile environment
 * variable) and SQL injection. Allow exactly what MySQL identifiers need and
 * nothing else, and reject rather than sanitise: silently rewriting a name would
 * produce queries against a table nobody meant.
 */
const IDENT = /^[A-Za-z_][A-Za-z0-9_$]{0,63}$/;

function ident(value, what) {
  if (typeof value !== 'string' || !IDENT.test(value)) {
    throw new Error(
      `schema: ${what} must be a plain MySQL identifier (letters, digits, _ and $, ` +
      `not starting with a digit, max 64 chars) — got ${JSON.stringify(value)}`
    );
  }
  return '`' + value + '`';
}

/** Build a schema from overrides (env wins over argument wins over default). */
function makeSchema(overrides = {}, env = process.env) {
  const fromEnv = {
    table:      env.STORES_TABLE,
    id:         env.STORES_ID_COL,
    name:       env.STORES_NAME_COL,
    category:   env.STORES_CATEGORY_COL,
    address:    env.STORES_ADDRESS_COL,
    latitude:   env.STORES_LAT_COL,
    longitude:  env.STORES_LNG_COL,
    geocodedAt: env.STORES_GEOCODED_AT_COL,
    source:     env.STORES_SOURCE_COL,
    precision:  env.STORES_PRECISION_COL,
    locationAddress: env.STORES_LOCATION_ADDRESS_COL,
  };

  const names = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (overrides[key] != null) names[key] = overrides[key];
    if (fromEnv[key] != null && fromEnv[key] !== '') names[key] = fromEnv[key];
  }

  // Quote every one of them now, so a bad name fails at startup rather than on the
  // first request that happens to touch that column.
  const q = {};
  for (const key of Object.keys(names)) q[key] = ident(names[key], key);

  /* The SELECT list is aliased back to fixed names (lat, lng, ...), so the rest of
     the code never has to know what your columns are called. Rename a column in
     the CRM and only this file changes. */
  const selectCols = [
    `${q.id} AS id`,
    `${q.name} AS name`,
    `${q.category} AS category`,
    `${q.latitude} AS lat`,
    `${q.longitude} AS lng`,
    `${q.address} AS address`,
    `${q.source} AS location_source`,
    `${q.precision} AS location_precision`,
    `${q.locationAddress} AS location_address`,
  ].join(', ');

  /* ── The address as an EXPRESSION, not always a column ──────────────────────
   *
   * The demo table has one `address` column. Your CRM does not: the address a
   * geocoder can use is four columns of `client_address` joined together, and
   * `composeAddressSql()` in ventas.js is the agreed way to join them (the test
   * suite runs every one of your 2,657 rows through it and through the
   * JavaScript version and asserts the two produce byte-identical strings).
   *
   * So everything that READS an address reads this expression instead of a bare
   * column name. It defaults to the column, which is why the demo is unaffected.
   *
   * It has to be the SAME expression everywhere, and that is the whole point of
   * putting it here rather than at each call site. `location_address` stores what
   * was actually sent to Google, and staleness is "does the address now differ
   * from the one the pin came from". Compose it one way when selecting and
   * another way when storing and every row looks permanently stale — which means
   * re-geocoding all 2,657 of them on every run, forever.
   *
   * ⚠ This is raw SQL spliced into queries, so unlike every name above it is NOT
   * read from the environment. It comes from code, built out of already-quoted
   * identifiers. An environment variable that could inject an arbitrary SQL
   * expression would undo the whole point of ident() above. */
  const addressExpr = overrides.addressExpr || q.address;

  /* Extra `expr AS alias` columns the bulk runner needs to decide whether a row
     is worth sending to Google at all — the individual street/city/state parts,
     which are gone once they have been concatenated into one string. */
  const extraCols = overrides.extraCols || [];

  /* Derived from the table, not hardcoded: index names are global per schema in
     MySQL only in the sense that they must be unique per table, but a migration
     that adds `stores_latlng_idx` to a table called `client_address` is a puzzle
     for whoever reads it next. For the default table this still produces exactly
     `stores_latlng_idx`, so migration 001 is unchanged. */
  return { names, q, table: q.table, selectCols, addressExpr, extraCols,
           indexName: `${names.table}_latlng_idx` };
}

module.exports = { makeSchema, ident, DEFAULTS };

'use strict';
/* The real geocoding run: your `client_address` table, your 2,657 rows.
 *
 *   node server/geocode-ventas.js --dry-run                  # costs nothing
 *   node server/geocode-ventas.js --limit 50                 # 50 for real
 *   node server/geocode-ventas.js --limit 2500 --qps 10      # the whole thing
 *
 * Same engine as geocode-batch.js — this file only points it at your schema and
 * hands it the rule for which rows are worth paying for. There is deliberately
 * not a second copy of the batch logic here: the resume behaviour, the
 * never-touch-a-hand-placed-pin rule and the stop-on-quota rule are the ones the
 * 53 assertions in test_batch.js already cover, and a second implementation is a
 * second set of bugs.
 *
 * Three things it does that a naive loop would not:
 *
 *   1. The address sent to Google is composed from four columns by the SAME rule
 *      in SQL and in JavaScript (composeAddressSql / composeAddress). It is
 *      stored in location_address, so "has this address changed since we placed
 *      the pin" has an exact answer later.
 *   2. Rows no geocoder could place — no street AND no usable city — are never
 *      sent. A request that cannot succeed is charged the same as one that does.
 *   3. It is resumable. Interrupt it and run it again; it picks up what is left
 *      and nothing is paid for twice.
 *
 * Read-only against every table except client_address, and within that it only
 * writes the six columns migration 002 added.
 */
const mysql = require('mysql2/promise');
const { runBatch } = require('./geocode-batch');
const makeGeocoder = require('./geocoder');
const { pinToIPv4 } = require('./egress');
const { ventasSchema, composeAddressSql, geocodability } = require('./ventas');

// The key is IP-restricted; this machine has two addresses and only one of them
// is on the allow-list. See server/egress.js.
pinToIPv4();

const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};

const dryRun = process.argv.includes('--dry-run');
const limit = Number(arg('limit', 50));
const qps = Number(arg('qps', 10));

if (!Number.isFinite(limit) || limit < 1 || limit > 5000) {
  console.error('--limit must be between 1 and 5000. Raise it on purpose.');
  process.exit(2);
}

(async () => {
  const { q } = ventasSchema();

  /* The schema handed to the engine: your address table, keyed by ca_id, with the
     address as the four-column composition rather than the street column alone.
     Geocoding "CL 108 80 60" with no city is not a cheaper request, it is a
     wrong one. */
  const schema = {
    q: { ...q, table: q.addresses, id: q.addrId, address: q.street },
    table: q.addresses,
    addressExpr: composeAddressSql(q),
    /* The parts survive the concatenation as their own columns, because whether a
       row is worth sending is decided on the street and the city separately. */
    extraCols: [`${q.street} AS street`, `${q.city} AS city`,
                `${q.state} AS state`, `${q.country} AS country`],
  };

  const pool = mysql.createPool({
    host: arg('host', process.env.DB_HOST || '127.0.0.1'),
    port: Number(arg('port', process.env.DB_PORT || 3306)),
    user: arg('user', process.env.DB_USER || 'root'),
    password: arg('password', process.env.DB_PASSWORD || ''),
    database: arg('db', process.env.DB_NAME || 'ventas'),
    waitForConnections: true, connectionLimit: 4,
  });
  const db = { query: async (sql, p) => (await pool.query(sql, p))[0] };

  /* A dry run calls nobody, so it must not require a key — otherwise the one
     command that exists to be run before you have your billing sorted out is the
     one command you cannot run. */
  const geocode = makeGeocoder({
    apiKey: process.env.GOOGLE_GEOCODING_KEY || (dryRun ? 'dry-run' : undefined),
    // No region bias: 24 of these rows are not in Colombia, and biasing towards
    // Colombia is how "Sansepolcro, Italia" comes back as a pin near Bogota.
  });

  if (!dryRun) {
    process.stdout.write('preflight: one request, to check the key and our IP ... ');
    try {
      const hit = await geocode('Plaza de Bolivar, Bogota, Colombia');
      if (!hit) throw new Error('a known landmark returned nothing');
      console.log(`ok (${hit.precision})`);
    } catch (e) {
      console.error('FAILED\n' + String(e.message || e));
      console.error('\nNothing was geocoded and nothing was charged.');
      await pool.end();
      process.exit(3);
    }
  }

  /* The one implementation of "can this be placed at all", shared with the API
     and the tests. `none` means neither a street nor a city worth sending. */
  const skip = (row) => (geocodability(row) === 'none' ? 'no street and no usable city' : null);

  const stats = await runBatch({ db, geocode, schema, limit, dryRun, qps, skip });

  if (!dryRun) {
    console.log(`\ngeocoded ${stats.ok} · no result ${stats.noResult} · ` +
                `not sent ${stats.skipped} · errors ${stats.failed}`);
    for (const p of ['ROOFTOP', 'RANGE_INTERPOLATED', 'GEOMETRIC_CENTER', 'APPROXIMATE', 'UNKNOWN']) {
      if (stats.byPrecision[p]) console.log(`  ${p.padEnd(19)} ${stats.byPrecision[p]}`);
    }
    /* $5 per 1,000 for the Geocoding API. Skipped rows are not requests, so they
       are not in this number — which is the point of skipping them. */
    const calls = stats.ok + stats.noResult + stats.failed;
    console.log(`\n${calls} request(s) ≈ $${(calls * 0.005).toFixed(2)}`);
    if (stats.skipped) {
      console.log(`\n${stats.skipped} row(s) were NOT sent (${(stats.skipped * 0.005).toFixed(2)} saved):`);
      stats.skips.slice(0, 10).forEach(s => console.log(`  ${s.id}  ${s.why}  ${JSON.stringify(s.address)}`));
      if (stats.skips.length > 10) console.log(`  ... and ${stats.skips.length - 10} more`);
    }
    if (stats.failures.length) {
      console.log(`\n${stats.failures.length} address(es) to look at:`);
      stats.failures.slice(0, 20).forEach(f => console.log(`  ${f.id}  ${f.why}  ${f.address}`));
    }
    const left = stats.total - stats.ok - stats.noResult - stats.skipped;
    if (left > 0) console.log(`\n${left} still to do - run it again.`);
  }
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });

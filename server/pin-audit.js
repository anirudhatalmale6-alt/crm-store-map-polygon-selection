'use strict';
/* What the geocoding run actually produced, and which pins want a human.
 *
 *   node server/pin-audit.js --port 13307 --db ventas
 *
 * Read-only. Runs after geocode-ventas.js and answers the only question that
 * matters once the money is spent: which of these pins should nobody trust?
 *
 * Three separate reasons, because they are found in three different ways and
 * fixed in three different ways:
 *
 *   1. Google said it was unsure   (location_precision)
 *   2. The pin is in another country than the row claims  (pinLooksWrong)
 *   3. The address was a placeholder, so the pin is a city centre standing in
 *      for a shop whose address nobody ever entered
 *
 * (2) is the one worth having. Google's own confidence does NOT catch it — one of
 * these came back RANGE_INTERPOLATED, which reads as confident, and is in
 * Manhattan. Sorting a review list by precision alone puts it near the bottom.
 */
const mysql = require('mysql2/promise');
const { ventasSchema, composeAddressSql, pinLooksWrong } = require('./ventas');

const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const PLACEHOLDER_STREETS = ['1503'];
const SOFT = ['APPROXIMATE', 'GEOMETRIC_CENTER'];

(async () => {
  const { q } = ventasSchema();
  const pool = mysql.createPool({
    host: arg('host', '127.0.0.1'), port: Number(arg('port', 3306)),
    user: arg('user', 'root'), password: arg('password', ''),
    database: arg('db', 'ventas'), connectionLimit: 2,
  });

  const [rows] = await pool.query(
    `SELECT ${q.addrId} AS id, ${q.latitude} AS lat, ${q.longitude} AS lng,
            ${q.precision} AS precision_, ${q.source} AS source,
            ${q.street} AS street, ${q.state} AS state,
            ${composeAddressSql(q)} AS sent
       FROM ${q.addresses}`);
  await pool.end();

  const pinned = rows.filter(r => r.lat != null);
  const unresolved = rows.filter(r => r.source === 'unresolved');

  const byPrecision = {};
  for (const r of pinned) byPrecision[r.precision_ || 'UNKNOWN'] = (byPrecision[r.precision_ || 'UNKNOWN'] || 0) + 1;

  const wrongCountry = pinned.filter(r => pinLooksWrong(r));
  const soft = pinned.filter(r => SOFT.includes(r.precision_));
  const placeholder = pinned.filter(r => PLACEHOLDER_STREETS.includes(String(r.street || '').trim()));

  /* Stores sharing one exact coordinate. Not an error — it is what a city-centre
     fallback looks like — but it is why a map can show "one pin" where the CRM
     says there are thirty-eight shops. */
  const at = new Map();
  for (const r of pinned) {
    const k = r.lat.toFixed(5) + ',' + r.lng.toFixed(5);
    at.set(k, (at.get(k) || 0) + 1);
  }
  const stacked = [...at.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);

  const pct = n => (100 * n / pinned.length).toFixed(1) + '%';
  console.log(`${rows.length} address rows`);
  console.log(`  ${pinned.length} pinned`);
  console.log(`  ${unresolved.length} not placed (no street and no usable city - never sent to Google)`);
  console.log('\nprecision:');
  for (const [p, n] of Object.entries(byPrecision).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${p.padEnd(19)} ${String(n).padStart(5)}  ${pct(n)}`);
  }
  const exact = pinned.length - soft.length;
  console.log(`\n  exact enough to trust:  ${exact}  ${pct(exact)}`);
  console.log(`  wants a look:           ${soft.length}  ${pct(soft.length)}`);

  console.log(`\nwrong country (${wrongCountry.length}) - precision does NOT catch these:`);
  for (const r of wrongCountry) {
    console.log(`  ${String(r.id).padEnd(6)} ${r.lat.toFixed(4)},${r.lng.toFixed(4)}  ` +
                `${String(r.precision_).padEnd(18)} ${r.sent}`);
  }

  console.log(`\nplaceholder street "${PLACEHOLDER_STREETS.join('/')}" but pinned anyway: ${placeholder.length}`);
  console.log('  (pinned at the centre of whatever city the row named - honest, but not a shop)');

  console.log(`\n${stacked.length} coordinate(s) carry more than one store:`);
  for (const [k, n] of stacked.slice(0, 5)) console.log(`  ${n} stores at ${k}`);
  const stackedRows = stacked.reduce((s, [, n]) => s + n, 0);
  console.log(`  ${stackedRows} rows in total share a pin with at least one other`);
})().catch(e => { console.error(e); process.exit(1); });

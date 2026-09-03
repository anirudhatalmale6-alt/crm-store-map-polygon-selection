'use strict';
/* A second pass over the pins Google was not confident about.
 *
 * WHY THIS EXISTS
 * ---------------
 * The first run sent Google the ADDRESS. On this customer's data that is often not an
 * address at all - "KM 1 VIA AEROPUERTO LAS PALMAS CEN EMPRESARIAL LA REGIONAL BG 8 Y
 * 9" is a description of a landmark, and Google's address parser has nothing to grip.
 * It matched the words "LAS PALMAS" to a neighbourhood of MEDELLIN and dropped the pin
 * 23 km from the customer's other Rionegro stores.
 *
 * Google My Maps got the same row right, because it is a different service: it
 * searches the places index, which knows the business by NAME. We cannot call that
 * index (Places API is not enabled on the project), but we can get most of the way by
 * sending Google what My Maps effectively sends - the store name AND the address as
 * one query.
 *
 * MEASURED before writing this, on 40 rows Google had been unsure about:
 *   precision improved 26, worsened 1, unchanged 13
 *   median move 0.30 km; 2 answers landed OUTSIDE the right town
 *
 * Those 2 are the reason this script has an accept/reject rule instead of just
 * overwriting. A second opinion is only worth taking when it is better AND still
 * plausible; "Google sounded more confident" is not on its own a reason to move a pin.
 *
 * WHAT IT WILL NOT TOUCH
 * ----------------------
 *   - a pin someone corrected by hand (location_source='manual'). A human beat the
 *     geocoder once already; a re-run must never undo that.
 *   - a row Google was already confident about, unless --all is passed.
 *   - anything at all without --commit. The default is a dry run that costs the same
 *     API calls but writes nothing, so the numbers can be read before the database is.
 */
const mysql = require('mysql2/promise');
const makeGeocoder = require('./geocoder');
const { ventasSchema, composeAddressSql } = require('./ventas');

const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const has = n => process.argv.includes('--' + n);

/* Google's own grade, as a number we can compare. Worth being explicit that this is
   Google marking its own homework - it says how hard it looked, not whether it was
   right. It is used here only to REJECT a worse answer, never as proof of a good one;
   the town check below is the part that can actually disagree with Google. */
const RANK = { ROOFTOP: 3, RANGE_INTERPOLATED: 2, GEOMETRIC_CENTER: 1, APPROXIMATE: 0 };

const R_EARTH = 6371;
function kmApart(a, b) {
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2
          + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(h));
}
const median = xs => {
  const a = xs.slice().sort((p, q) => p - q), m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

/* Same normalisation and the same exclusions as the map, so a row the map calls
   "wrong town" and a row this script rejects are the same rows. A city column that
   is not a city cannot anchor anything: grouped together they form one cloud whose
   centre is nowhere, and then every store in it looks wrong. */
const NOT_A_TOWN = new Set(['', 'no identificada', 'internacional', 'sin ciudad',
  'chile', 'ecuador', 'peru', 'italia', 'costa rica', 'venezuela', 'panama', 'mexico']);
const townKey = c => String(c || '')
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\b\d{2}-\d{3}\b/g, '').replace(/\bd\.?c\.?\b/g, '')
  .replace(/[^a-z ]/g, ' ').trim().replace(/\s+/g, ' ');

const TOWN_MIN = 4, TOWN_MIN_KM = 8, TOWN_SPREAD_X = 6;

function buildTowns(rows) {
  const g = new Map();
  for (const r of rows) {
    if (r.lat == null || r.lng == null) continue;
    const k = townKey(r.city);
    if (!k || NOT_A_TOWN.has(k)) continue;
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(r);
  }
  const towns = new Map();
  for (const [k, list] of g) {
    if (list.length < TOWN_MIN) continue;
    const lat = median(list.map(r => Number(r.lat)));
    const lng = median(list.map(r => Number(r.lng)));
    const spread = median(list.map(r => kmApart({ lat: Number(r.lat), lng: Number(r.lng) }, { lat, lng })));
    towns.set(k, { lat, lng, spread, far: Math.max(TOWN_MIN_KM, TOWN_SPREAD_X * spread) });
  }
  return towns;
}

/** The whole judgement, kept pure so the tests can drive it without a database. */
function decide({ before, after, town }) {
  if (!after) return { take: false, why: 'no answer' };
  const better = RANK[after.precision] > RANK[before.precision];
  const same = RANK[after.precision] === RANK[before.precision];
  if (!better && !same) return { take: false, why: `worse (${before.precision} -> ${after.precision})` };
  if (town) {
    const gap = kmApart(after, town);
    if (gap > town.far) {
      return { take: false, why: `lands ${gap.toFixed(1)} km outside ${'its own town'}` };
    }
  }
  if (same && kmApart(before, after) < 0.05) return { take: false, why: 'no change' };
  if (same) return { take: false, why: 'no better, and moving a pin needs a reason' };
  return { take: true, why: `${before.precision} -> ${after.precision}` };
}

async function main() {
  const commit = has('commit');
  const limit = Number(arg('limit', 0)) || null;
  const { q } = ventasSchema();

  const pool = mysql.createPool({
    host: arg('host', process.env.DB_HOST || '127.0.0.1'),
    port: Number(arg('port', process.env.DB_PORT || 3306)),
    user: arg('user', process.env.DB_USER || 'root'),
    password: arg('password', process.env.DB_PASSWORD || ''),
    database: arg('db', process.env.DB_NAME || 'ventas'),
    waitForConnections: true, connectionLimit: 4,
  });

  const [all] = await pool.query(
    `SELECT a.${q.addrId} AS ca_id, c.${q.clientName} AS name,
            a.${q.latitude} AS lat, a.${q.longitude} AS lng,
            a.${q.precision} AS prec, a.${q.source} AS src,
            a.${q.city} AS city, ${composeAddressSql(q)} AS addr
       FROM ${q.addresses} a
       JOIN ${q.clients} c ON a.${q.addrClientId} = c.${q.clientId}
      WHERE a.${q.latitude} IS NOT NULL`);

  const towns = buildTowns(all);
  /* A hand-placed pin is excluded here and not merely skipped later, so it can never
     be counted, charged for, or reported as "considered". */
  let todo = all.filter(r => r.src !== 'manual'
                          && (has('all') || RANK[r.prec] < RANK.ROOFTOP));
  if (limit) todo = todo.slice(0, limit);

  console.log(`${all.length} pinned rows, ${towns.size} towns usable as a reference`);
  console.log(`${todo.length} to re-ask, at the store NAME plus the address`);
  console.log(commit ? 'COMMIT: accepted answers will be written\n'
                     : 'DRY RUN: nothing will be written (same API cost)\n');

  const geocode = makeGeocoder({ apiKey: process.env.GOOGLE_GEOCODING_KEY });
  const tally = { taken: 0, kept: 0, none: 0 };
  const reasons = {};
  for (const r of todo) {
    const before = { lat: Number(r.lat), lng: Number(r.lng), precision: r.prec };
    let after = null;
    try { after = await geocode(`${r.name}, ${r.addr}`); }
    catch (e) { console.error(`  ca_id=${r.ca_id}: ${e.message}`); break; }
    const town = towns.get(townKey(r.city));
    const d = decide({ before, after, town });
    reasons[d.why.replace(/[\d.]+/g, 'N')] = (reasons[d.why.replace(/[\d.]+/g, 'N')] || 0) + 1;
    if (!after) { tally.none++; continue; }
    if (!d.take) { tally.kept++; continue; }
    tally.taken++;
    console.log(`  ca_id=${r.ca_id} ${kmApart(before, after).toFixed(2)} km  ${d.why}  ${r.name.slice(0, 40)}`);
    if (commit) {
      await pool.query(
        `UPDATE ${q.addresses} SET ${q.latitude}=?, ${q.longitude}=?, ${q.precision}=?,
                ${q.locationAddress}=?, ${q.geocodedAt}=NOW()
          WHERE ${q.addrId}=? AND ${q.source} <> 'manual'`,
        [after.lat, after.lng, after.precision, after.formattedAddress, r.ca_id]);
    }
  }
  console.log(`\naccepted ${tally.taken}, kept the old pin ${tally.kept}, no answer ${tally.none}`);
  console.log('why the rest were kept:', reasons);
  if (!commit) console.log('\nNothing was written. Re-run with --commit to apply.');
  await pool.end();
}

module.exports = { decide, buildTowns, kmApart, townKey, RANK, NOT_A_TOWN };
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });

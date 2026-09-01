'use strict';
/* Spend $0.25 to find out whether spending $12 is worth it.
 *
 *   GOOGLE_KEY=... node server/geocode-sample.js --socket /path/mysql.sock --db ventas
 *   GOOGLE_KEY=... node server/geocode-sample.js --n 50 --seed 7 --json
 *   node server/geocode-sample.js --dry-run          # shows what WOULD be sent, costs nothing
 *
 * READ-ONLY against your database. It SELECTs a random sample and writes nothing
 * back — no columns are updated, so this can be pointed at production and run
 * twice without consequence. The only thing it spends is Google requests.
 *
 * Why this script exists at all
 * -----------------------------
 * readiness.js can tell you an address is worth SENDING. It cannot tell you Google
 * will FIND it, and nothing can except asking. Colombian addresses are cadastral
 * ("CR 70 C 55 33"), not street-name-and-number, and geocoders are measurably worse
 * at them. Sending all 2,423 to find out costs the whole budget; sending 50 costs a
 * quarter and answers the same question with a known margin of error.
 *
 * The measurement that actually matters
 * -------------------------------------
 * "Google returned a result" is NOT the number to report. Geocoders answer
 * something for almost any input: give it a Colombian cadastral string it cannot
 * parse and it will happily return the centre of the department, with status OK.
 * A pin in the wrong place looks identical on a map to a pin in the right place —
 * and is worse than a missing one, because nobody goes looking for it.
 *
 * So every result is checked against what was ASKED for:
 *   - country must match (Colombia, or the real country for the Internacional rows)
 *   - city must match the city column
 *   - location_type says how precise the answer is
 * and the row is graded on that, not on the HTTP status.
 */
const fs = require('fs');
const mysql = require('mysql2/promise');
const { ventasSchema, composeAddress, geocodability, isInternational } = require('./ventas');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes('--' + name);

const SOCKET = arg('socket', process.env.DB_SOCKET || '');
const CONF = SOCKET
  ? { socketPath: SOCKET, user: arg('user', process.env.DB_USER || 'root'),
      password: arg('pwd', process.env.DB_PWD || ''), database: arg('db', process.env.DB_NAME || 'ventas') }
  : { host: arg('host', process.env.DB_HOST || '127.0.0.1'),
      port: Number(arg('port', process.env.DB_PORT || 3306)),
      user: arg('user', process.env.DB_USER || 'root'),
      password: arg('pwd', process.env.DB_PWD || ''), database: arg('db', process.env.DB_NAME || 'ventas') };

const N = Number(arg('n', 50));
/* A fixed seed, so re-running measures the SAME 50 rows. Without it, a second run
   samples different rows and any change in the numbers is indistinguishable from
   noise — which is exactly the question you would be re-running to answer. */
const SEED = Number(arg('seed', 42));
const KEY = process.env.GOOGLE_KEY || arg('key', '');
const DRY = has('dry-run');
const AS_JSON = has('json');
const SAVE = arg('save', '');        // where to keep the raw responses
const REGRADE = arg('regrade', '');  // score a saved file again, for free
const COST_PER_1000 = 5.00;

/* Accent- and case-insensitive comparison, because their columns are
   utf8mb4_general_ci (so "Medellin" and "Medellín" are the same string to MySQL)
   while JavaScript's === is not. Comparing raw would score correct pins as wrong. */
const fold = (s) => String(s == null ? '' : s)
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim();

/* Comparing place names with === was wrong, and it was wrong in the direction that
   matters: it manufactured failures. The first run of this script reported 16% of
   pins in the WRONG PLACE. Six of the eight were correct pins my own comparison had
   misread — "Bogota D.C." against Google's "Bogotá", "Bogotá" against Google's
   "Bogotá, D.C.". Had I sent that number on, the client would have been told their
   address data was twice as bad as it is.
   So: compare as token SETS, either direction, with the administrative noise words
   dropped. "Bogota D.C." and "Bogotá, D.C." both reduce to {bogota}. */
const NOISE = new Set(['d', 'c', 'dc', 'distrito', 'capital', 'municipio',
                       'canton', 'ciudad', 'de', 'del', 'la', 'el']);
const tokens = (s) => new Set(fold(s).replace(/[.,#()\-\/]/g, ' ').split(/\s+/)
                                     .filter(t => t && !NOISE.has(t)));
const subsetOf = (a, b) => a.size > 0 && [...a].every(t => b.has(t));
/* Either direction, because the two are not symmetric in practice: the column may
   be coarser than Google's answer ("Bogotá" vs "Bogotá, D.C.") or finer than it. */
const samePlace = (want, got) => {
  const w = tokens(want), g = tokens(got);
  return subsetOf(w, g) || subsetOf(g, w);
};

/* Google returns the place hierarchy as a flat list of typed components; pull the
   ones we asked about. A Colombian city can come back as `locality` (Bogotá) or as
   `administrative_area_level_2` (many municipios), so both count as the city. */
function componentsOf(result) {
  const by = {};
  for (const c of result.address_components || []) {
    for (const t of c.types || []) (by[t] = by[t] || []).push(c.long_name);
  }
  return {
    country: (by.country || [])[0] || '',
    state:   (by.administrative_area_level_1 || [])[0] || '',
    /* admin1 belongs in the city list for Colombia specifically: Bogotá is its own
       department, so the city column and Google's admin1 are the same place. */
    cities:  [...(by.locality || []), ...(by.administrative_area_level_2 || []),
              ...(by.sublocality || []), ...(by.postal_town || []),
              ...(by.administrative_area_level_1 || [])],
  };
}

/* The grade. Deliberately harsher than Google's own status field — but only where
 * being harsh is warranted. "The country column disagrees" is NOT a bad pin: that
 * column reads Colombia on all 2,657 rows, so it cannot disagree with anything
 * meaningfully. It is reported separately, as information, not as a failure. */
function grade(row, result) {
  if (!result) return { verdict: 'not_found', why: 'no result' };
  const got = componentsOf(result);
  const intl = isInternational(row);

  /* On the Internacional rows the COUNTRY is what somebody typed into the city
     column, so that is what the city column has to be checked against. Checking it
     against Google's city list is comparing "Ecuador" to "Daule" and calling a
     correct pin wrong — which is exactly what the first version of this did. */
  if (intl) {
    if (!samePlace(row.city, got.country)) {
      return { verdict: 'wrong_place',
               why: `marked Internacional as ${row.city}, landed in ${got.country || '?'}` };
    }
  } else {
    const cityKnown = row.city && !/^no identificad[oa]$/i.test(String(row.city).trim());
    if (cityKnown && !got.cities.some(c => samePlace(row.city, c))) {
      return { verdict: 'wrong_place',
               why: `asked ${row.city}, got ${got.cities.slice(0, 2).join('/') || '?'}` };
    }
  }

  const outside = got.country && fold(got.country) !== 'colombia';
  const flag = outside ? ` [in ${got.country}, not Colombia]` : '';
  const lt = result.geometry && result.geometry.location_type;
  if (lt === 'ROOFTOP' || lt === 'RANGE_INTERPOLATED')
    return { verdict: 'exact', why: lt + flag, outside };
  if (result.partial_match) return { verdict: 'approx', why: `partial_match, ${lt}` + flag, outside };
  return { verdict: 'approx', why: (lt || 'no location_type') + flag, outside };
}

async function geocodeOne(address) {
  const url = 'https://maps.googleapis.com/maps/api/geocode/json?address=' +
              encodeURIComponent(address) + '&key=' + encodeURIComponent(KEY);
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url);
    const body = await res.json().catch(() => ({ status: 'BAD_JSON' }));
    // OVER_QUERY_LIMIT is the one status worth retrying; the rest are answers.
    if (body.status !== 'OVER_QUERY_LIMIT') return body;
    await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
  }
  return { status: 'OVER_QUERY_LIMIT' };
}

(async () => {
  const { q } = ventasSchema();
  const pool = mysql.createPool({ ...CONF, connectionLimit: 2 });
  const [rows] = await pool.query(
    `SELECT c.${q.clientId} AS id, c.${q.clientName} AS name,
            a.${q.street} AS street, a.${q.city} AS city,
            a.${q.state} AS state, a.${q.country} AS country
       FROM ${q.clients} c JOIN ${q.addresses} a ON a.${q.addrClientId} = c.${q.clientId}`);
  await pool.end();

  const sendable = rows.filter(r => geocodability(r) !== 'none');

  /* Sample deterministically from a fixed seed. A hand-rolled LCG rather than
     Math.random() for exactly one reason: the same --seed must select the same
     rows on your machine and mine, or we cannot discuss the same 50 addresses. */
  let s = SEED >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pool2 = sendable.slice();
  for (let i = pool2.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [pool2[i], pool2[j]] = [pool2[j], pool2[i]];
  }
  const sample = pool2.slice(0, Math.min(N, pool2.length));

  if (!AS_JSON) {
    console.log(`Sampling ${sample.length} of ${sendable.length} sendable addresses (seed ${SEED}).`);
    console.log(`Cost of this run: $${(sample.length * COST_PER_1000 / 1000).toFixed(2)}\n`);
  }

  if (DRY) {
    for (const r of sample.slice(0, 10)) console.log('  ' + composeAddress(r));
    console.log(`\n  ...and ${Math.max(0, sample.length - 10)} more. Nothing was sent.`);
    return;
  }
  /* Every response is kept. This run costs real money, and the FIRST version of the
     grading rules above was wrong — six correct pins scored as wrong. Re-running to
     re-grade would have meant paying twice for the same answers. Raw responses go to
     disk, and --regrade scores them again for free. */
  let raw = null;
  if (REGRADE) {
    raw = JSON.parse(fs.readFileSync(REGRADE, 'utf8'));
    if (!AS_JSON) console.log(`Re-grading ${raw.length} saved responses. Nothing sent, nothing spent.\n`);
  }
  if (!raw && !KEY) { console.error('No key. Set GOOGLE_KEY, or pass --dry-run.'); process.exit(2); }

  const results = [], saved = [];
  const work = raw ? raw : sample.map(r => ({ row: r, body: null }));
  for (const item of work) {
    const r = item.row;
    const address = composeAddress(r);
    const body = item.body || await geocodeOne(address);
    saved.push({ row: r, body });
    const top = (body.results || [])[0];
    const g = body.status === 'OK' ? grade(r, top)
            : { verdict: body.status === 'ZERO_RESULTS' ? 'not_found' : 'error', why: body.status };
    results.push({ id: r.id, name: r.name, address, kind: geocodability(r),
                   status: body.status, ...g,
                   lat: top && top.geometry.location.lat, lng: top && top.geometry.location.lng });
    if (!AS_JSON) {
      const mark = { exact: 'exact      ', approx: 'approximate', wrong_place: 'WRONG PLACE',
                     not_found: 'not found  ', error: 'ERROR      ' }[g.verdict];
      console.log(`  ${mark}  ${address.slice(0, 62).padEnd(62)}  ${g.why}`);
    }
  }

  if (SAVE && !REGRADE) {
    fs.writeFileSync(SAVE, JSON.stringify(saved, null, 1));
    if (!AS_JSON) console.log(`\n  raw responses saved to ${SAVE} — re-score with --regrade ${SAVE}`);
  }

  const count = (v) => results.filter(r => r.verdict === v).length;
  const pct = (n) => ((n / results.length) * 100).toFixed(0) + '%';
  const usable = count('exact') + count('approx');

  if (AS_JSON) { console.log(JSON.stringify({ sample: results.length, seed: SEED, results }, null, 2)); return; }
  console.log('\nResult');
  console.log('------');
  console.log(`  exact (rooftop or interpolated)   ${String(count('exact')).padStart(4)}   ${pct(count('exact'))}`);
  console.log(`  approximate (right city, coarse)  ${String(count('approx')).padStart(4)}   ${pct(count('approx'))}`);
  console.log(`  WRONG PLACE (looks fine, isn't)   ${String(count('wrong_place')).padStart(4)}   ${pct(count('wrong_place'))}`);
  console.log(`  not found                         ${String(count('not_found')).padStart(4)}   ${pct(count('not_found'))}`);
  console.log(`  error                             ${String(count('error')).padStart(4)}   ${pct(count('error'))}`);
  console.log(`\n  usable pins                       ${String(usable).padStart(4)}   ${pct(usable)}`);
  const outside = results.filter(r => r.outside).length;
  if (outside) console.log(`  of those, actually outside Colombia ${String(outside).padStart(2)}   ` +
                           `(the country column says Colombia for every row)`);
  console.log(`  extrapolated over ${sendable.length} sendable rows: ~${Math.round(sendable.length * usable / results.length)} pins`);
  console.log(`  full run would cost $${(sendable.length * COST_PER_1000 / 1000).toFixed(2)}`);
  if (count('wrong_place')) {
    console.log(`\n  The WRONG PLACE rows are the ones to look at. They come back with`);
    console.log(`  status OK and would be plotted as confidently as everything else.`);
  }
})().catch(e => { console.error(e.message); process.exit(1); });

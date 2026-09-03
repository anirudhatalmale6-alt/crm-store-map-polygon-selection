'use strict';
/* A second pass over the pins, to move the map closer to reality.
 *
 * WHY THIS EXISTS
 * ---------------
 * The customer compared this map against the one he had built himself in Google My
 * Maps and found My Maps more accurate. He was right, and reproducing his two
 * examples against the live API turned up two DIFFERENT faults, not one:
 *
 *   1. Hot Fill S.A.S — "KM 1 VIA AEROPUERTO LAS PALMAS CEN EMPRESARIAL LA REGIONAL
 *      BG 8 Y 9, Rionegro, Antioquia". That is not an address, it is the description
 *      of a landmark. Google matched the words "LAS PALMAS" to a neighbourhood of
 *      MEDELLIN and dropped the pin 23 km from the customer's other Rionegro stores.
 *      Its SECOND result was Rionegro. The old code read results[0] and binned the
 *      rest, so the right answer was fetched, paid for, and thrown away.
 *
 *   2. Maria Victoria Mona Posada — right city, wrong part of it, 3.65 km out. Here
 *      the address genuinely is thin, and what rescues it is sending the store NAME
 *      along with it, which is what My Maps effectively does: it searches the PLACES
 *      index, which knows businesses by name, while the Geocoding API only parses
 *      addresses. (Places API is not enabled on this project, so we approximate it.)
 *
 * MEASURED on his two examples before any of this was written:
 *
 *      query form                     Hot Fill     Mona Posada
 *      address alone (what we had)     23.1 km        3.65 km
 *      store NAME alone                 0.0 km        7.83 km   <- worse
 *      NAME + address together          0.3 km        0.93 km   <- wins on both
 *
 * The middle row is the reason this file exists in this shape. Shipping the fix that
 * came out of example 1 would have fixed his first pin and moved others further away.
 *
 * SO: ask BOTH questions, keep EVERY answer to each, and choose between them using a
 * fact Google does not have — where this customer's other stores in that town are.
 *
 * THE PART THAT MATTERS MOST
 * --------------------------
 * A pin that sits outside its own town is moved back inside EVEN IF GOOGLE GRADES THE
 * NEW ANSWER LOWER. Google's location_type says how hard it looked, not whether it was
 * right; ROOFTOP on a real building in the wrong town is the dangerous case precisely
 * because it looks like the best pin on the map. Ranking by Google's own confidence is
 * what put Hot Fill in Medellin in the first place.
 *
 * WHAT IT WILL NOT TOUCH
 * ----------------------
 *   - a pin someone corrected by hand (location_source='manual'). A human beat the
 *     geocoder once already; a re-run must never undo that. Excluded in the query, so
 *     it cannot be counted, charged for, or reported as "considered".
 *   - anything at all without --commit. The default costs the same API calls and
 *     writes nothing, so the numbers can be read before the database is.
 *   - a pin that is already in its own town, unless a strictly better answer turns up.
 *
 * Every answer is cached to a JSONL as it arrives. A re-run reads the cache first, so
 * an interrupted run is resumed rather than re-bought. This is the customer's money.
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const makeGeocoder = require('./geocoder');
const { pinToIPv4 } = require('./egress');
const { ventasSchema, composeAddressSql } = require('./ventas');

const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const has = n => process.argv.includes('--' + n);

/* Google's own grade, as a number we can compare. Used only to prefer one answer over
   another once BOTH are already known to be in the right town — never as evidence that
   an answer is correct. See the note at the top. */
const RANK = { ROOFTOP: 3, RANGE_INTERPOLATED: 2, GEOMETRIC_CENTER: 1, APPROXIMATE: 0 };
const rankOf = p => (RANK[p] === undefined ? -1 : RANK[p]);

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
   "wrong town" and a row this script rescues are the same rows. A city column that is
   not a city cannot anchor anything: grouped together they form one cloud whose centre
   is nowhere, and then every store inside it looks wrong. */
const NOT_A_TOWN = new Set(['', 'no identificada', 'internacional', 'sin ciudad',
  'chile', 'ecuador', 'peru', 'italia', 'costa rica', 'venezuela', 'panama', 'mexico']);
const townKey = c => String(c || '')
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\b\d{2}-\d{3}\b/g, '').replace(/\bd\.?c\.?\b/g, '')
  .replace(/[^a-z ]/g, ' ').trim().replace(/\s+/g, ' ');

const TOWN_MIN = 4, TOWN_MIN_KM = 8, TOWN_SPREAD_X = 6;

/* A flat "more than N km from the town centre" bar is the wrong instrument, because
   the towns are not alike: Bogota's stores genuinely spread 6.4 km, while Rionegro's
   24 sit inside 1.3 km. One number either misses Rionegro's outliers or condemns
   Bogota's real ones. Each town gets a bar built from its OWN spread.
   MEDIAN, never mean: with the mean an outlier drags the centre towards itself and
   then nothing looks wrong at all. */
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
    towns.set(k, { lat, lng, spread, far: Math.max(TOWN_MIN_KM, TOWN_SPREAD_X * spread), n: list.length });
  }
  return towns;
}

const inTown = (p, town) => !town || kmApart(p, town) <= town.far;

/* The two questions. Both are asked because each rescued one of his two examples and
   neither rescued the other. */
const QUERIES = [
  { tag: 'name+addr', build: r => `${r.name}, ${r.addr}` },
  { tag: 'addr',      build: r => r.addr },
];

const AGREE_KM = 0.3;   // two different questions landing this close is corroboration

/**
 * Choose one answer out of everything Google returned for both questions.
 *
 * Order of preference, and the order matters more than the list:
 *   1. inside the store's own town          <- evidence Google never saw
 *   2. corroborated by the other question   <- two questions, one answer
 *   3. Google's own grade                   <- only as a tie-break, never as proof
 *   4. Google's own ordering
 */
function pickCandidate({ pool, town }) {
  if (!pool || !pool.length) return null;
  const scored = pool.map((c, i) => {
    const agrees = pool.some(o => o.tag !== c.tag && kmApart(c, o) <= AGREE_KM);
    return { ...c, i, in: inTown(c, town), agrees };
  });
  scored.sort((a, b) =>
    (b.in - a.in) || (b.agrees - a.agrees)
    || (rankOf(b.precision) - rankOf(a.precision)) || (a.i - b.i));
  return scored[0];
}

/**
 * Whether to actually move the pin. Kept pure so the tests can drive it with no
 * database and no network.
 */
function decide({ before, after, town }) {
  if (!after) return { take: false, why: 'no answer' };

  if (town) {
    const wasIn = inTown(before, town);
    const nowIn = inTown(after, town);
    /* Never move a pin OUT of the town its own CRM record names, however sure Google
       sounds. On a 40-row trial two answers wanted to do exactly this. */
    if (!nowIn) {
      return { take: false, why: `lands ${kmApart(after, town).toFixed(1)} km outside its own town` };
    }
    /* ...and always move one back IN, even if Google grades it lower than the pin we
       have. This is the Hot Fill rescue, and the whole point of the pass. */
    if (!wasIn) {
      return { take: true, rescue: true,
               why: `was ${kmApart(before, town).toFixed(1)} km out of town, now inside` };
    }
  }

  const gain = rankOf(after.precision) - rankOf(before.precision);
  if (gain < 0) return { take: false, why: `worse (${before.precision} -> ${after.precision})` };
  if (gain === 0) {
    return kmApart(before, after) < 0.05
      ? { take: false, why: 'no change' }
      : { take: false, why: 'no better, and moving a pin needs a reason' };
  }
  /* A gain worth taking even when the pin does not visibly move. The coordinates may
     shift by metres, but the GRADE is what puts the "approximate position" warning on
     the customer's map, so confirming a guess as a real street address is the whole
     point - it is what makes a review flag go away honestly. */

  /* A precision gain is enough ONLY when the town check was there to catch a bad
     answer. With no town reference the sole remaining evidence is Google's grade of
     its own work, and that is the signal this whole file exists because it failed.
     Measured on the real 733: 54 accepted moves had no town behind them, 37 of those
     rested on one lone answer, and the two largest were "Clle 14, Colombia" flung
     742 km to Santa Marta and "Cra 53 #49-17, Colombia" landed ROOFTOP-sure in a
     village in Antioquia. Both look exactly like the 35 good ones next to them.

     So when there is no town, ask for the one independent thing left: that BOTH
     differently-phrased questions arrived at the same place. Two questions agreeing
     is evidence; one question sounding certain is not.

     This costs 37 pins that stay where they are. They keep their review flag, which
     is the honest outcome - "we still do not know where this is" - rather than a
     confident pin nobody has any reason to believe. */
  if (!town && !after.agrees) {
    return { take: false, why: 'no town to check against, and only one question found it' };
  }
  return { take: true, why: `${before.precision} -> ${after.precision}` };
}

/* ------------------------------------------------------------------ the run ---- */

const CACHE = path.join(__dirname, '..', 'regeocode-cache.jsonl');

function readCache() {
  const seen = new Map();
  if (!fs.existsSync(CACHE)) return seen;
  for (const line of fs.readFileSync(CACHE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line); seen.set(`${o.ca_id}|${o.tag}`, o.hits); } catch { /* half-written last line */ }
  }
  return seen;
}

async function main() {
  pinToIPv4();                       // the key is allow-listed by IPv4; Node prefers v6
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
  for (const r of all) { r.lat = Number(r.lat); r.lng = Number(r.lng); }

  const towns = buildTowns(all);
  const townOf = r => towns.get(townKey(r.city));

  /* The two failure classes, both included. Uncertain pins are the obvious ones; the
     out-of-town pins matter MORE, and some of those are ROOFTOP, so a precision filter
     alone would skip exactly the pins the customer complained about. */
  const target = r => r.src !== 'manual'
    && (has('all') || rankOf(r.prec) < RANK.ROOFTOP || !inTown(r, townOf(r)));
  let todo = all.filter(target);
  /* --ids lets a single row be re-checked without paying for the whole set. It ignores
     the target filter on purpose: the rows worth re-checking by hand are usually the
     ones the filter did not pick up. */
  const only = arg('ids', '');
  if (only) {
    const want = new Set(only.split(',').map(s => Number(s.trim())));
    todo = all.filter(r => want.has(Number(r.ca_id)));
  }
  if (limit) todo = todo.slice(0, limit);

  const cache = readCache();
  const needed = todo.reduce((n, r) =>
    n + QUERIES.filter(Q => !cache.has(`${r.ca_id}|${Q.tag}`)).length, 0);

  console.log(`${all.length} pinned rows, ${towns.size} towns usable as a reference`);
  console.log(`${all.filter(r => !inTown(r, townOf(r))).length} currently sit outside their own town`);
  console.log(`${todo.length} rows to re-ask, ${QUERIES.length} questions each`);
  console.log(`${cache.size} answers already cached, ${needed} requests to buy`);
  console.log(commit ? 'COMMIT: accepted answers will be written\n'
                     : 'DRY RUN: nothing will be written (same API cost)\n');
  if (has('estimate')) { await pool.end(); return; }

  /* Built on first use, not up front: a re-run that is fully cached buys nothing, and
     should not demand a key to tell you what it already knows. Re-reading the numbers
     after changing a rule is the commonest thing anyone does with this script. */
  let geocode = null;
  const geocoder = () => (geocode ||= makeGeocoder({ apiKey: process.env.GOOGLE_GEOCODING_KEY }));

  /* --sql writes the accepted moves out as plain UPDATE statements instead of (or as
     well as) applying them. Whoever owns the production database can then read every
     change before it happens, apply it in their own window, and keep it in their own
     migration history - rather than taking my word for 358 pins. Each statement keeps
     the location_source <> 'manual' guard, so it stays true even if someone corrects a
     pin by hand between the file being written and being run. */
  const sqlPath = arg('sql', '');
  const sql = sqlPath ? fs.createWriteStream(sqlPath) : null;
  const quote = s => (s == null ? 'NULL' : `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`);
  if (sql) {
    sql.write(`-- Second geocoding pass: accepted corrections only.\n`);
    sql.write(`-- Generated by server/regeocode.js. Every row was rejected unless it was\n`);
    sql.write(`-- either more precise than the pin held, or moved back into the town this\n`);
    sql.write(`-- CRM itself names for the store. Review before running.\n`);
    sql.write(`-- Take a backup first: mysqldump ... ${q.addresses.replace(/`/g, '')} > before.sql\n\n`);
  }
  const out = fs.createWriteStream(CACHE, { flags: 'a' });
  const tally = { taken: 0, rescued: 0, kept: 0, none: 0, bought: 0 };
  const reasons = {};
  const moves = [];

  for (const r of todo) {
    const pool2 = [];
    for (const Q of QUERIES) {
      const key = `${r.ca_id}|${Q.tag}`;
      let hits = cache.get(key);
      if (hits === undefined) {
        try { hits = await geocoder()(Q.build(r), { all: true }); }
        catch (e) { console.error(`  stopped at ca_id=${r.ca_id}: ${e.message}`); out.end(); await pool.end(); process.exit(1); }
        tally.bought++;
        out.write(JSON.stringify({ ca_id: r.ca_id, tag: Q.tag, hits }) + '\n');
      }
      for (const h of hits) pool2.push({ ...h, tag: Q.tag });
    }

    const town = townOf(r);
    const before = { lat: r.lat, lng: r.lng, precision: r.prec };
    const after = pickCandidate({ pool: pool2, town });
    const d = decide({ before, after, town });

    const bucket = d.why.replace(/[\d.]+/g, 'N');
    reasons[bucket] = (reasons[bucket] || 0) + 1;

    if (!after) { tally.none++; continue; }
    if (!d.take) { tally.kept++; continue; }
    tally.taken++;
    if (d.rescue) tally.rescued++;
    moves.push({ r, after, d, km: kmApart(before, after) });

    if (sql) {
      sql.write(`-- ${String(r.name).slice(0, 60).replace(/\s+/g, ' ')}  [${r.city}]  ${d.why}\n`);
      sql.write(`UPDATE ${q.addresses} SET ${q.latitude}=${after.lat}, ${q.longitude}=${after.lng},\n` +
                `       ${q.precision}=${quote(after.precision)}, ${q.locationAddress}=${quote(after.formattedAddress)},\n` +
                `       ${q.geocodedAt}=NOW()\n` +
                ` WHERE ${q.addrId}=${Number(r.ca_id)} AND ${q.source} <> 'manual';\n\n`);
    }
    if (commit) {
      await pool.query(
        `UPDATE ${q.addresses} SET ${q.latitude}=?, ${q.longitude}=?, ${q.precision}=?,
                ${q.locationAddress}=?, ${q.geocodedAt}=NOW()
          WHERE ${q.addrId}=? AND ${q.source} <> 'manual'`,
        [after.lat, after.lng, after.precision, after.formattedAddress, r.ca_id]);
    }
  }
  out.end();
  if (sql) { sql.write(`-- ${tally.taken} corrections above.\n`); sql.end(); }

  moves.sort((a, b) => b.km - a.km);
  console.log('the twenty biggest corrections:');
  for (const m of moves.slice(0, 20)) {
    console.log(`  ca_id=${String(m.r.ca_id).padEnd(5)} ${m.km.toFixed(2).padStart(7)} km  ` +
                `${m.after.tag.padEnd(9)} ${m.d.why}`);
  }

  const rescuedOut = todo.filter(r => !inTown(r, townOf(r))).length;
  console.log(`\naccepted ${tally.taken} (of which ${tally.rescued} were out of town), ` +
              `kept the old pin ${tally.kept}, no answer at all ${tally.none}`);
  console.log(`${rescuedOut} of the rows examined were out of town before this run`);
  console.log(`median correction ${moves.length ? median(moves.map(m => m.km)).toFixed(2) : 0} km`);
  console.log(`${tally.bought} requests bought this run`);
  console.log('why the rest were kept:', reasons);
  if (!commit) console.log('\nNothing was written. Re-run with --commit to apply (answers are cached, so it is free).');
  await pool.end();
}

module.exports = { decide, pickCandidate, buildTowns, kmApart, townKey, inTown,
                   RANK, rankOf, NOT_A_TOWN, QUERIES, AGREE_KM,
                   TOWN_MIN, TOWN_MIN_KM, TOWN_SPREAD_X };
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });

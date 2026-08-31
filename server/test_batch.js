'use strict';
/* The bulk geocoding run, against a real MySQL with a stubbed geocoder.
 *
 * This is the script that will be pointed at ~2,000 real addresses on a billed
 * Google account. The things that must be true are not "it geocodes": they are
 * that it never spends more than it was told to, never touches a hand-corrected
 * pin, and can be run again after it stops without redoing paid work.
 *
 * Expects MySQL on 127.0.0.1:13306, database `crmtest`, migrated (000 then 001).
 */
const mysql = require('mysql2/promise');
const { runBatch } = require('./geocode-batch');
const { makeSchema } = require('./schema');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ->  ' + JSON.stringify(extra) : '')); }
};
const quiet = () => {};

const SEED = [
  // name,          address,                     lat,  lng,  source
  ['Needs one',     'Gran Via 1, Madrid',        null, null, null],
  ['Needs two',     'Gran Via 2, Madrid',        null, null, null],
  ['Needs three',   'Gran Via 3, Madrid',        null, null, null],
  ['Vague address', 'Somewhere in Madrid',       null, null, null],   // GEOMETRIC_CENTER
  ['Nonsense',      'qqqq zzzz not an address',  null, null, null],   // no result
  ['Already done',  'Sol, Madrid',               40.4, -3.7, 'geocoded'],
  ['Hand adjusted', 'Chueca, Madrid',            40.5, -3.6, 'manual'],
  ['No address',    null,                        null, null, null],
  ['Blank address', '',                          null, null, null],
];

(async () => {
  const schema = makeSchema();
  const { q, table } = schema;
  const pool = mysql.createPool({
    host: '127.0.0.1', port: 13306, user: 'root', database: 'crmtest',
    waitForConnections: true, connectionLimit: 4,
  });
  const db = { query: async (sql, p) => (await pool.query(sql, p))[0] };

  async function reseed() {
    await db.query(`DELETE FROM ${table}`);
    await db.query(`ALTER TABLE ${table} AUTO_INCREMENT = 1`);
    for (const [name, address, lat, lng, source] of SEED) {
      await db.query(
        `INSERT INTO ${table} (${q.name}, ${q.category}, ${q.address}, ${q.latitude},
                               ${q.longitude}, ${q.source}) VALUES (?,?,?,?,?,?)`,
        [name, 'active', address, lat, lng, source]
      );
    }
  }
  const row = async (id) => (await db.query(
    `SELECT ${q.latitude} AS lat, ${q.longitude} AS lng, ${q.source} AS src,
            ${q.precision} AS prec, ${q.geocodedAt} AS at,
            ${q.address} AS addr, ${q.locationAddress} AS locAddr
       FROM ${table} WHERE ${q.id} = ?`,
    [id]))[0];

  let calls = [];
  const geocoder = (behaviour = {}) => async (address) => {
    calls.push(address);
    if (behaviour.quota) throw new Error('geocoder: quota exceeded (OVER_QUERY_LIMIT)');
    if (/qqqq/.test(address)) return null;
    if (/Somewhere/.test(address)) return { lat: 40.42, lng: -3.70, precision: 'GEOMETRIC_CENTER' };
    return { lat: 40.41, lng: -3.71, precision: 'ROOFTOP' };
  };

  console.log('picking the right rows');
  await reseed(); calls = [];
  let st = await runBatch({ db, geocode: geocoder(), schema, dryRun: true, log: quiet });
  ok('counts the rows that need doing', st.total === 5, st.total);
  ok('a dry run calls nobody', calls.length === 0, calls);
  // The subtle one. location_source is NULL for every never-positioned row, and
  // `!= 'manual'` is NULL - not true - for those. A non-null-safe comparison would
  // silently exclude exactly the rows that most need geocoding, and the script
  // would cheerfully report "0 to do".
  ok('rows with a NULL location_source are INCLUDED, not skipped', st.total >= 5, st);
  ok('the hand-adjusted row is counted as skipped', st.manual === 1, st.manual);
  ok('a dry run writes nothing', (await row(1)).lat === null);

  console.log('\nspending no more than it was told to');
  await reseed(); calls = [];
  st = await runBatch({ db, geocode: geocoder(), schema, limit: 2, qps: 50, log: quiet });
  ok('--limit caps the number of Google calls', calls.length === 2, calls.length);
  ok('...and the number of rows written', st.ok === 2, st);
  ok('control positive: without the cap there was more to do', st.total > 2, st.total);

  console.log('\nresuming');
  calls = [];
  st = await runBatch({ db, geocode: geocoder(), schema, limit: 100, qps: 50, log: quiet });
  // Three left: the two remaining good ones plus the vague one. The nonsense
  // address is also retried once here, then stamped so it stops costing money.
  ok('a second run picks up only what is left', st.total === 3, st.total);
  ok('...and does not re-pay for rows already done', !calls.includes('Gran Via 1, Madrid'), calls);
  calls = [];
  st = await runBatch({ db, geocode: geocoder(), schema, limit: 100, qps: 50, log: quiet });
  ok('a third run has nothing to do and costs nothing', calls.length === 0 && st.total === 0, st);

  console.log('\nnever touching a hand-corrected pin');
  const hand = await row(7);
  ok('the manual row still has its own coordinates',
     Number(hand.lat) === 40.5 && Number(hand.lng) === -3.6, hand);
  ok('...and is still marked manual', hand.src === 'manual', hand);
  ok('...and was never sent to Google', !calls.concat().includes('Chueca, Madrid'));
  // --force is the flag people reach for when they think nothing is happening.
  // It must widen the candidate set without touching manual rows.
  calls = [];
  st = await runBatch({ db, geocode: geocoder(), schema, limit: 100, force: true, qps: 50, log: quiet });
  ok('--force redoes the geocoded rows', st.ok >= 4, st);
  ok('--force still refuses to touch the manual row',
     !calls.includes('Chueca, Madrid'), calls);
  const hand2 = await row(7);
  ok('the manual coordinates survived --force',
     Number(hand2.lat) === 40.5 && hand2.src === 'manual', hand2);

  console.log('\nrecording how confident Google was');
  ok('a precise hit is stored as ROOFTOP', (await row(1)).prec === 'ROOFTOP', await row(1));
  ok('a vague hit is stored as GEOMETRIC_CENTER', (await row(4)).prec === 'GEOMETRIC_CENTER', await row(4));
  ok('the run reports the precision breakdown',
     st.byPrecision.ROOFTOP > 0 && st.byPrecision.GEOMETRIC_CENTER === 1, st.byPrecision);

  console.log('\nan address Google cannot resolve');
  const dud = await row(5);
  ok('is left without coordinates', dud.lat === null, dud);
  // If it were marked 'geocoded' it would drop off the review list and nobody
  // would ever fix the address.
  ok('is NOT marked as successfully geocoded', dud.src !== 'geocoded', dud);
  ok('but is stamped, so the next run does not pay to ask again', dud.at !== null, dud);
  calls = [];
  await runBatch({ db, geocode: geocoder(), schema, limit: 100, qps: 50, log: quiet });
  // The bug this catches: if "needs doing" is only "has no coordinates", a bad
  // address is billed on EVERY run forever and the script never says "nothing to
  // do". At 2,000 addresses with a tail of bad ones that is a permanent monthly
  // charge for nothing.
  ok('and it is indeed not retried', !calls.includes('qqqq zzzz not an address'), calls);

  // But it must still be reachable on purpose, or a corrected address can never
  // be geocoded without the blunt instrument of --force.
  calls = [];
  st = await runBatch({ db, geocode: geocoder(), schema, limit: 100, retryFailed: true, qps: 50, log: quiet });
  ok('--retry-failed picks it back up', calls.includes('qqqq zzzz not an address'), calls);
  ok('--retry-failed does not drag in rows that are already located',
     st.total === 1, st.total);
  ok('--retry-failed still skips the manual pin', !calls.includes('Chueca, Madrid'), calls);

  console.log('\nrows with no address');
  ok('a NULL address is never sent to Google', !calls.includes(null));
  ok('an empty address is never sent either', !calls.includes(''));
  ok('neither is counted as needing work',
     (await runBatch({ db, geocode: geocoder(), schema, dryRun: true, log: quiet })).total === 0);

  console.log('\nstopping when the quota is gone');
  await reseed(); calls = [];
  st = await runBatch({ db, geocode: geocoder({ quota: true }), schema, limit: 100, qps: 50, log: quiet });
  // Every remaining call would fail identically, so continuing turns one wasted
  // call into hundreds - and on a metered API that is real money.
  ok('gives up after the first quota error', calls.length === 1, calls.length);
  ok('and says so', st.stoppedEarly === true, st);
  ok('control positive: there were more rows it could have tried', st.total > 1, st.total);
  ok('nothing was written', (await row(1)).lat === null);

  /* ---- addresses that change after the pin was placed ----
     A rename in the CRM must cost nothing. An ADDRESS edit leaves the pin on the
     old street, and this is the run that fixes those - but only when asked, because
     an afternoon of address tidying should not turn into a Google bill by itself. */
  console.log('\naddresses edited after the pin was placed');
  await reseed(); calls = [];
  await runBatch({ db, geocode: geocoder(), schema, limit: 100, qps: 50, log: quiet });
  const done = await row(1);
  ok('a normal run records which address produced the coordinates',
     done.locAddr === done.addr && done.locAddr !== null, done);

  await db.query(`UPDATE ${table} SET ${q.address} = 'Gran Via 1 BIS, Madrid' WHERE ${q.id} = 1`);
  calls = [];
  st = await runBatch({ db, geocode: geocoder(), schema, limit: 100, qps: 50, log: quiet });
  ok('an edited address is NOT picked up by default - refreshing is opt-in',
     !calls.includes('Gran Via 1 BIS, Madrid'), calls);
  ok('...and the pin is left exactly where it was', (await row(1)).lat === 40.41);

  calls = [];
  st = await runBatch({ db, geocode: geocoder(), schema, limit: 100,
                        refreshChanged: true, qps: 50, log: quiet });
  ok('--refresh-changed picks it up', calls.includes('Gran Via 1 BIS, Madrid'), calls);
  ok('...and records the new address against the new pin',
     (await row(1)).locAddr === 'Gran Via 1 BIS, Madrid', await row(1));

  // Control positive: it terminates. Without this, "it found something" could just
  // mean it re-geocodes the whole table on every run.
  calls = [];
  st = await runBatch({ db, geocode: geocoder(), schema, limit: 100,
                        refreshChanged: true, qps: 50, log: quiet });
  ok('control positive: a second --refresh-changed run has nothing left to do',
     calls.length === 0 && st.total === 0, { calls, total: st.total });

  // A hand-placed pin whose address was edited. The script must not touch it, and
  // must not stay silent about it either.
  await db.query(`UPDATE ${table} SET ${q.locationAddress} = ${q.address} WHERE ${q.id} = 7`);
  await db.query(`UPDATE ${table} SET ${q.address} = 'Chueca 99, Madrid' WHERE ${q.id} = 7`);
  calls = [];
  st = await runBatch({ db, geocode: geocoder(), schema, limit: 100,
                        refreshChanged: true, qps: 50, log: quiet });
  ok('--refresh-changed never re-geocodes a hand-placed pin',
     !calls.includes('Chueca 99, Madrid'), calls);
  ok('...its coordinates are untouched', (await row(7)).lat === 40.5, await row(7));
  ok('...and it is reported rather than silently skipped, because only a person ' +
     'can say whether the store moved', st.manualStale === 1, st);

  /* An edited address that Google cannot resolve. This is the same cost bug as the
     unresolvable-address case, in a new place: if the failed attempt is not recorded
     against the new address, the row stays stale and is paid for on every future
     --refresh-changed run, forever. */
  await db.query(`UPDATE ${table} SET ${q.address} = 'qqqq zzzz not an address' WHERE ${q.id} = 2`);
  calls = [];
  await runBatch({ db, geocode: geocoder(), schema, limit: 100,
                   refreshChanged: true, qps: 50, log: quiet });
  ok('an edited address that cannot be geocoded is tried once', calls.length === 1, calls);
  const bad = await row(2);
  ok('...and marked unresolved rather than geocoded', bad.src === 'unresolved', bad);
  ok('...with its old pin left in place', bad.lat !== null, bad);
  calls = [];
  st = await runBatch({ db, geocode: geocoder(), schema, limit: 100,
                        refreshChanged: true, qps: 50, log: quiet });
  ok('...and it is NOT asked again on the next run', calls.length === 0, calls);
  calls = [];
  await runBatch({ db, geocode: geocoder(), schema, limit: 100,
                   retryFailed: true, qps: 50, log: quiet });
  ok('...but --retry-failed still reaches it once the address is corrected',
     calls.includes('qqqq zzzz not an address'), calls);

  console.log('\nworks against a differently-named table');
  // Proves schema.js is actually wired through, rather than the default names
  // simply happening to match.
  await db.query('DROP TABLE IF EXISTS tiendas');
  await db.query(`CREATE TABLE tiendas (
     id INT AUTO_INCREMENT PRIMARY KEY, nombre VARCHAR(191) NOT NULL,
     categoria VARCHAR(64) NOT NULL, direccion VARCHAR(255) NULL,
     lat DOUBLE NULL, lng DOUBLE NULL, geo_at DATETIME NULL,
     origen ENUM('geocoded','manual','unresolved') NULL, precision_geo VARCHAR(24) NULL,
     direccion_geo VARCHAR(512) NULL)`);
  await db.query(`INSERT INTO tiendas (nombre, categoria, direccion) VALUES ('T1','active','Gran Via 9, Madrid')`);
  const esSchema = makeSchema({
    table: 'tiendas', name: 'nombre', category: 'categoria', address: 'direccion',
    latitude: 'lat', longitude: 'lng', geocodedAt: 'geo_at', source: 'origen',
    precision: 'precision_geo', locationAddress: 'direccion_geo',
  }, {});
  calls = [];
  st = await runBatch({ db, geocode: geocoder(), schema: esSchema, limit: 10, qps: 50, log: quiet });
  ok('finds the rows in a renamed table', st.total === 1, st);
  ok('and writes to the renamed columns', st.ok === 1, st);
  const es = (await db.query('SELECT lat, origen, precision_geo FROM tiendas WHERE id = 1'))[0];
  ok('coordinates landed in the right column', Number(es.lat) === 40.41, es);
  ok('source landed in the right column', es.origen === 'geocoded', es);
  ok('precision landed in the right column', es.precision_geo === 'ROOFTOP', es);
  await db.query('DROP TABLE tiendas');

  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

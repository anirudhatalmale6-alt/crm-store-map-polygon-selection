'use strict';
/* Integration tests: real Express app, real MySQL server, real HTTP requests.
 * Nothing here is mocked except the geocoder (which would otherwise cost money).
 *
 * Expects a MySQL reachable on 127.0.0.1:13306 with database `crmtest` already
 * migrated (000 then 001). See README.
 */
const express = require('express');
const mysql = require('mysql2/promise');
const storeRoutes = require('./stores.routes');
const { pointInPolygon } = require('./geo');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ->  ' + JSON.stringify(extra) : '')); }
};

const SEED = [
  // name,               category,    lat,     lng,      address
  ['Gran Via 34',        'flagship',  40.4203, -3.7058, 'Gran Via 34, Madrid'],
  ['Sol',                'franchise', 40.4169, -3.7035, 'Puerta del Sol, Madrid'],
  ['Chueca',             'popup',     40.4235, -3.6975, 'Chueca, Madrid'],
  ['Retiro',             'partner',   40.4185, -3.6830, 'Retiro, Madrid'],
  ['Legazpi',            'franchise', 40.3910, -3.6950, 'Legazpi, Madrid'],
  ['Moncloa',            'partner',   40.4350, -3.7190, 'Moncloa, Madrid'],
  ['Not geocoded yet',   'popup',     null,    null,    'Calle Falsa 123, Madrid'],
  ['No address at all',  'popup',     null,    null,    null],
];

(async () => {
  const pool = mysql.createPool({
    host: '127.0.0.1', port: 13306, user: 'root', database: 'crmtest',
    waitForConnections: true, connectionLimit: 4,
  });
  const db = { query: async (sql, p) => (await pool.query(sql, p))[0] };

  await db.query('DELETE FROM stores');
  await db.query('ALTER TABLE stores AUTO_INCREMENT = 1');
  for (const [name, category, lat, lng, address] of SEED) {
    await db.query(
      `INSERT INTO stores (name, category, address, latitude, longitude,
                           geocoded_at, location_source) VALUES (?,?,?,?,?,?,?)`,
      [name, category, address, lat, lng,
       lat === null ? null : new Date('2026-01-01T00:00:00Z'),
       lat === null ? null : 'geocoded']
    );
  }

  // Mock geocoder: counts calls so we can prove the cache actually prevents them.
  let geocodeCalls = 0;
  const geocode = async (address) => {
    geocodeCalls++;
    if (address && address.includes('Calle Falsa')) return { lat: 40.4300, lng: -3.7000 };
    // A store that has been given a new address, so "the pin followed the edit"
    // can be checked by coordinate rather than by the absence of an error.
    if (address && address.includes('Nueva Direccion')) {
      return { lat: 41.0000, lng: -4.0000, precision: 'ROOFTOP' };
    }
    return null;
  };

  const app = express();
  app.use(express.json());
  app.use('/api/stores', storeRoutes({ db, geocode }));
  app.use((err, req, res, next) => res.status(500).json({ error: String(err && err.message) }));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/stores`;
  const get = async (u) => { const r = await fetch(base + u); return { status: r.status, body: await r.json() }; };
  const send = async (m, u, body) => {
    const r = await fetch(base + u, {
      method: m, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };

  console.log('GET /api/stores');
  let r = await get('');
  ok('returns only stores that have coordinates', r.body.stores.length === 6, r.body.stores.length);
  ok('excludes the two un-geocoded stores',
     !r.body.stores.some(s => s.lat === null || s.lng === null));
  ok('lat/lng come back as numbers, not strings',
     r.body.stores.every(s => typeof s.lat === 'number' && typeof s.lng === 'number'));

  r = await get('?bbox=-3.71,40.41,-3.69,40.43');
  ok('bbox narrows the result', r.body.stores.map(s => s.name).sort().join(',') === 'Chueca,Gran Via 34,Sol',
     r.body.stores.map(s => s.name));
  r = await get('?bbox=nonsense');
  ok('malformed bbox is a 400', r.status === 400);

  console.log('\nPOST /api/stores/in-polygon');
  // Convex box around central Madrid.
  const box = [
    { lat: 40.410, lng: -3.715 }, { lat: 40.410, lng: -3.690 },
    { lat: 40.430, lng: -3.690 }, { lat: 40.430, lng: -3.715 },
  ];
  r = await send('POST', '/in-polygon', { polygon: box });
  const allGeocoded = SEED.filter(s => s[2] !== null)
    .map(([name, category, lat, lng]) => ({ name, lat, lng }));
  const expectBox = allGeocoded.filter(s => pointInPolygon(s, box)).map(s => s.name).sort();
  ok('control positive: the box does contain stores', expectBox.length > 0, expectBox.length);
  ok('returns exactly the stores inside the box',
     r.body.stores.map(s => s.name).sort().join(',') === expectBox.join(','),
     { api: r.body.stores.map(s => s.name), expected: expectBox });
  ok('count field matches the array', r.body.count === r.body.stores.length);

  // Concave polygon: a C shape whose notch holds a store. The SQL bounding-box
  // prefilter WILL return that store; the exact test must then drop it. This is
  // the case that catches a bbox-only implementation.
  const cShape = [
    { lat: 40.400, lng: -3.720 }, { lat: 40.400, lng: -3.680 },
    { lat: 40.412, lng: -3.680 }, { lat: 40.412, lng: -3.700 },
    { lat: 40.428, lng: -3.700 }, { lat: 40.428, lng: -3.680 },
    { lat: 40.440, lng: -3.680 }, { lat: 40.440, lng: -3.720 },
  ];
  r = await send('POST', '/in-polygon', { polygon: cShape });
  const names = r.body.stores.map(s => s.name).sort();
  const expectC = allGeocoded.filter(s => pointInPolygon(s, cShape)).map(s => s.name).sort();
  ok('concave polygon matches an independent calculation',
     names.join(',') === expectC.join(','), { api: names, expected: expectC });
  ok('store sitting in the notch is excluded', !names.includes('Retiro'), names);
  ok('control positive: the notch store IS inside the bounding box',
     40.4185 >= 40.400 && 40.4185 <= 40.440 && -3.6830 >= -3.720 && -3.6830 <= -3.680,
     'otherwise this test proves nothing');

  for (const [label, poly] of [
    ['polygon with 2 points', [{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }]],
    ['polygon that is not an array', 'nope'],
    ['point with a missing lng', [{ lat: 1 }, { lat: 2, lng: 2 }, { lat: 3, lng: 3 }]],
    ['latitude out of range', [{ lat: 999, lng: 1 }, { lat: 2, lng: 2 }, { lat: 3, lng: 3 }]],
  ]) {
    const res = await send('POST', '/in-polygon', { polygon: poly });
    ok(`${label} is rejected with 400`, res.status === 400, res);
  }

  console.log('\nPATCH /api/stores/:id/location');
  r = await send('PATCH', '/1/location', { lat: 40.5, lng: -3.5 });
  ok('valid update returns 200', r.status === 200);
  const moved = (await db.query(
    'SELECT latitude, longitude, geocoded_at, location_source FROM stores WHERE id=1'))[0];
  ok('coordinates were actually written to MySQL',
     Number(moved.latitude) === 40.5 && Number(moved.longitude) === -3.5, moved);
  ok('the pin is marked as manually placed', moved.location_source === 'manual', moved);
  // geocoded_at answers "when did Google last run", so a hand drag must not touch
  // it - otherwise a hand-placed pin is indistinguishable from a machine-placed one.
  ok('geocoded_at is left at its original value',
     moved.geocoded_at instanceof Date && moved.geocoded_at.getUTCFullYear() === 2026
       && moved.geocoded_at.getUTCMonth() === 0, moved.geocoded_at);
  ok('lat above 90 is rejected', (await send('PATCH', '/1/location', { lat: 91, lng: 0 })).status === 400);
  ok('non-numeric lng is rejected', (await send('PATCH', '/1/location', { lat: 40, lng: 'x' })).status === 400);
  ok('unknown id is a 404', (await send('PATCH', '/99999/location', { lat: 40, lng: -3 })).status === 404);

  console.log('\nPOST /api/stores/:id/geocode');
  geocodeCalls = 0;
  r = await send('POST', '/2/geocode');
  ok('already-geocoded store is served from the database', r.body.cached === true, r.body);
  ok('...and did NOT call Google', geocodeCalls === 0, geocodeCalls);

  r = await send('POST', '/7/geocode');           // "Not geocoded yet"
  ok('un-geocoded store gets geocoded', r.status === 200 && r.body.cached === false, r.body);
  ok('geocoder was called exactly once', geocodeCalls === 1, geocodeCalls);
  const stored = (await db.query('SELECT latitude, longitude FROM stores WHERE id=7'))[0];
  ok('result was persisted', Number(stored.latitude) === 40.43, stored);

  r = await send('POST', '/7/geocode');
  ok('second call is served from cache', r.body.cached === true);
  ok('geocoder still called only once', geocodeCalls === 1, geocodeCalls);

  r = await send('POST', '/7/geocode?force=1');
  ok('force=1 re-geocodes', geocodeCalls === 2, geocodeCalls);

  r = await send('POST', '/8/geocode');           // "No address at all"
  ok('store with no address is a 422', r.status === 422, r);
  ok('unknown id is a 404', (await send('POST', '/99999/geocode')).status === 404);

  /* Manual corrections vs re-geocoding.
     Geocoding is never perfect, so people will drag pins. The failure that costs
     real money is not a bad geocode - it is a bulk re-geocode silently undoing
     hundreds of corrections that were made on purpose. These assertions are the
     ones standing between that and the client's data. */
  console.log('\nmanual corrections survive re-geocoding');
  // Store 5 (Legazpi) has a real address the mock geocoder deliberately cannot
  // resolve, so if the guard failed we would also see the damage as a 422.
  await send('PATCH', '/5/location', { lat: 40.1111, lng: -3.2222 });
  geocodeCalls = 0;

  r = await send('POST', '/5/geocode?force=1');
  ok('force=1 does NOT overwrite a hand-placed pin', r.body.skipped === 'manual', r.body);
  ok('...and Google was never called for it', geocodeCalls === 0, geocodeCalls);
  let kept = (await db.query(
    'SELECT latitude, longitude, location_source FROM stores WHERE id=5'))[0];
  ok('the corrected coordinates are still in the database',
     Number(kept.latitude) === 40.1111 && Number(kept.longitude) === -3.2222, kept);
  ok('and it is still marked manual', kept.location_source === 'manual', kept);

  // Control positive: the guard must be the reason nothing happened, not a broken
  // endpoint. The same call with the explicit override has to actually do the work.
  r = await send('POST', '/7/geocode?force=1');
  ok('control positive: force=1 still re-geocodes a machine-placed pin',
     geocodeCalls === 1 && r.body.skipped === undefined, { geocodeCalls, body: r.body });

  r = await send('POST', '/5/geocode?force=1&override_manual=1');
  ok('override_manual=1 is allowed to overwrite it', geocodeCalls === 2, geocodeCalls);
  ok('overriding with an unresolvable address is a 422, not a silent wipe',
     r.status === 422, r);
  kept = (await db.query(
    'SELECT latitude, longitude, location_source FROM stores WHERE id=5'))[0];
  ok('a failed override leaves the old coordinates intact',
     Number(kept.latitude) === 40.1111 && kept.location_source === 'manual', kept);

  // And a successful override does flip the source back to 'geocoded'.
  await send('PATCH', '/7/location', { lat: 1, lng: 1 });
  r = await send('POST', '/7/geocode?force=1&override_manual=1');
  const flipped = (await db.query(
    'SELECT latitude, location_source FROM stores WHERE id=7'))[0];
  ok('a successful override re-marks the pin as geocoded',
     flipped.location_source === 'geocoded' && Number(flipped.latitude) === 40.43, flipped);

  r = await get('/?bbox=-4,40,-3,41');
  ok('locationSource is exposed to the front end so it can show the badge',
     r.body.stores.every(s => 'locationSource' in s), r.body.stores[0]);

  /* GET /needs-review — the short list of pins worth a human's time.
     Geocoding 2,000 addresses always leaves a tail of bad ones. Without this the
     only way to find them is to look at 2,000 pins, which nobody does, so the bad
     ones just stay wrong. */
  console.log('\nGET /api/stores/needs-review');
  await db.query(`UPDATE stores SET location_source='geocoded', location_precision='ROOFTOP'
                   WHERE latitude IS NOT NULL`);
  await db.query(`UPDATE stores SET location_precision='APPROXIMATE' WHERE id=3`);
  await db.query(`UPDATE stores SET location_precision='GEOMETRIC_CENTER' WHERE id=4`);
  await db.query(`UPDATE stores SET location_source='manual', location_precision=NULL WHERE id=6`);

  r = await get('/needs-review');
  const flagged = r.body.stores.map(s => s.id).sort((a, b) => a - b);
  ok('lists exactly the imprecise pins', JSON.stringify(flagged) === '[3,4]', flagged);
  ok('count matches the array', r.body.count === r.body.stores.length, r.body);
  // Control positive: a query that returned everything, or nothing, would pass a
  // sloppier assertion. There must be precise pins that are deliberately absent.
  const all = (await get('/')).body.stores;
  ok('control positive: there are precise pins it correctly left out',
     all.length > flagged.length, { all: all.length, flagged: flagged.length });
  ok('a ROOFTOP pin is not flagged', !flagged.includes(1), flagged);
  ok('a hand-adjusted pin is never flagged for review', !flagged.includes(6), flagged);
  ok('the worst ones come first', r.body.stores[0].locationPrecision === 'APPROXIMATE', r.body.stores[0]);
  ok('precision is exposed to the front end', r.body.stores.every(s => 'locationPrecision' in s));

  /* ---- when the store record changes underneath the pin ----
     The client asked what happens to a pin when a store is renamed. Nothing, and
     that is worth proving rather than saying. The dangerous half is the sibling
     case: editing the ADDRESS, where the pin silently stays on the old street and
     nothing in the system knows it is wrong. */
  console.log('\nwhen the store record changes underneath the pin');

  const one = async (id) => (await get('')).body.stores.find(s => s.id === id);

  const before1 = await one(1);
  await db.query(`UPDATE stores SET name='Ani India', category='partner' WHERE id=1`);
  const after1 = await one(1);
  ok('renaming a store does not move its pin',
     after1.lat === before1.lat && after1.lng === before1.lng, { before1, after1 });
  ok('...it is the same store, not a new one', after1.id === before1.id);
  ok('...the new name is what comes back', after1.name === 'Ani India', after1);
  ok('...and a rename never marks the pin stale', after1.addressStale === false, after1);

  /* The clause that decides whether switching this feature on re-geocodes the whole
     table. Every row that existed before the column did has location_address NULL,
     and NULL must mean "unknown", not "changed". */
  const unrecorded = (await get('')).body.stores.filter(s => s.locationAddress === null);
  ok('control positive: the fixture really does contain rows from before this column',
     unrecorded.length > 0, unrecorded.length);
  ok('a pin with no recorded address is never stale, so enabling this re-geocodes nothing',
     unrecorded.every(s => s.addressStale === false), unrecorded.map(s => s.id));

  // An address edit, on a store whose pin we have just recorded an address for.
  await db.query(`UPDATE stores SET location_address = address WHERE id=2`);
  let s2 = await one(2);
  ok('control positive: recording the address a pin was placed for clears staleness',
     s2.addressStale === false, s2);
  const pin2 = { lat: s2.lat, lng: s2.lng };
  await db.query(`UPDATE stores SET address='Nueva Direccion 1, Madrid' WHERE id=2`);
  s2 = await one(2);
  ok('editing the address marks the pin stale', s2.addressStale === true, s2);
  ok('...but does not move the pin by itself', s2.lat === pin2.lat && s2.lng === pin2.lng, s2);

  let calls = geocodeCalls;
  r = await send('POST', '/2/geocode');
  ok('a stale pin is NOT served from the cache - the cache does not have this answer',
     geocodeCalls === calls + 1 && r.body.cached === false, { calls, geocodeCalls, body: r.body });
  ok('...the pin moves to the new address', r.body.lat === 41.0 && r.body.lng === -4.0, r.body);
  ok('...and it stops being stale', r.body.addressStale === false, r.body);

  calls = geocodeCalls;
  r = await send('POST', '/2/geocode');
  ok('control positive: the same call on a fresh pin is still cached, so the above is ' +
     'the staleness check and not a broken cache',
     geocodeCalls === calls && r.body.cached === true, { calls, geocodeCalls, body: r.body });

  /* An accent-only edit. This is the assertion that catches the JavaScript rule and
     the SQL rule drifting apart: MySQL 8's default collation is accent-insensitive,
     so a plain string comparison in SQL calls these two the same address while
     JavaScript calls them different. If they disagree, the API reports a store as
     stale and the bulk geocoder never picks it up. */
  await db.query(`UPDATE stores SET address='Gran Via 34, Madrid',
                                    location_address='Gran Vía 34, Madrid' WHERE id=1`);
  const s1 = await one(1);
  ok('an accent-only address change is stale in JavaScript', s1.addressStale === true, s1);
  ok('...and SQL agrees, so the batch and the API cannot disagree about it',
     (await get('/needs-review')).body.stores.some(s => s.id === 1));

  /* A hand-placed pin whose address was edited. It must still be protected, but it
     also must not sit there silently: only a person can say whether the store moved
     or somebody just tidied up the street name. */
  await db.query(`UPDATE stores SET location_address = address WHERE id=6`);
  await db.query(`UPDATE stores SET address='Otra Calle 5, Madrid' WHERE id=6`);
  const m6 = (await get('/needs-review')).body.stores.find(s => s.id === 6);
  ok('a hand-placed pin whose address changed does come up for review', !!m6, m6);
  ok('...and it is still marked manual, not downgraded', m6 && m6.locationSource === 'manual', m6);
  calls = geocodeCalls;
  r = await send('POST', '/6/geocode');
  ok('...but geocoding still refuses to move it',
     r.body.skipped === 'manual' && geocodeCalls === calls, { calls, geocodeCalls, body: r.body });

  /* An edited address that Google cannot place. It has to stop being stale - or the
     next run asks the same unanswerable question and pays for it, forever - while
     staying visible as a different kind of problem. */
  await db.query(`UPDATE stores SET location_address = address WHERE id=4`);
  await db.query(`UPDATE stores SET address='Direccion Imposible 999' WHERE id=4`);
  ok('control positive: the edited address starts out stale', (await one(4)).addressStale === true);
  r = await send('POST', '/4/geocode');
  ok('an address Google cannot place is a 422', r.status === 422, r);
  const s4 = await one(4);
  ok('...the store is marked unresolved', s4.locationSource === 'unresolved', s4);
  ok('...it stops being stale, so it is not paid for again on every future run',
     s4.addressStale === false, s4);
  ok('...its old pin is left exactly where it was', s4.lat !== null && s4.lng !== null, s4);
  ok('...and it stays on the review list, as a bad address rather than a bad pin',
     (await get('/needs-review')).body.stores.some(s => s.id === 4));

  // Dragging a pin records what it was placed for, or it would look stale at once.
  await send('PATCH', '/3/location', { lat: 40.5, lng: -3.5 });
  const s3 = await one(3);
  ok('dragging a pin records the address it was placed for',
     s3.locationAddress === s3.address, s3);
  ok('...so a hand-placed pin is not stale the moment it is made', s3.addressStale === false, s3);

  /* Four buckets, assigned by priority so they are disjoint. If they were assigned
     by test, a store that is both stale and imprecise would be counted twice and the
     four numbers would not add up to the fifth - which reads as a broken report. */
  const rv = (await get('/needs-review')).body;
  ok('the review buckets add up to the total, so nothing is double-counted',
     rv.stale + rv.unlocated + rv.unresolved + rv.imprecise === rv.count, rv);
  ok('control positive: more than one bucket is actually populated',
     [rv.stale, rv.unlocated, rv.unresolved, rv.imprecise].filter(n => n > 0).length >= 2, rv);
  ok('the stale ones are listed first - a pin on the wrong street beats a vague one',
     rv.stores[0].addressStale === true, rv.stores[0]);

  /* The whole router against a table and columns named nothing like the defaults.
     This is the assertion that says milestone 1 will fit the client's CRM whatever
     their names turn out to be - rather than me hoping they happen to match. */
  console.log('\nthe same router against a renamed table');
  const { makeSchema } = require('./schema');
  await db.query('DROP TABLE IF EXISTS tiendas');
  await db.query(`CREATE TABLE tiendas (
     id_tienda INT AUTO_INCREMENT PRIMARY KEY, nombre VARCHAR(191) NOT NULL,
     categoria VARCHAR(64) NOT NULL, direccion VARCHAR(255) NULL,
     lat DOUBLE NULL, lng DOUBLE NULL, geo_at DATETIME NULL,
     origen ENUM('geocoded','manual','unresolved') NULL, precision_geo VARCHAR(24) NULL,
     direccion_geo VARCHAR(512) NULL)`);
  for (const [n, c, la, lo, p] of [
    ['Sol ES', 'activa', 40.4169, -3.7035, 'ROOFTOP'],
    ['Chueca ES', 'potencial', 40.4235, -3.6975, 'APPROXIMATE'],
    ['Lejos ES', 'cadena', 41.9, -3.0, 'ROOFTOP'],
  ]) {
    await db.query(`INSERT INTO tiendas (nombre, categoria, direccion, lat, lng, origen, precision_geo)
                    VALUES (?,?,?,?,?,'geocoded',?)`, [n, c, n + ' address', la, lo, p]);
  }
  const esSchema = makeSchema({
    table: 'tiendas', id: 'id_tienda', name: 'nombre', category: 'categoria',
    address: 'direccion', latitude: 'lat', longitude: 'lng', geocodedAt: 'geo_at',
    source: 'origen', precision: 'precision_geo', locationAddress: 'direccion_geo',
  }, {});
  const esApp = express();
  esApp.use(express.json());
  esApp.use('/api/stores', storeRoutes({ db, geocode, schema: esSchema }));
  const esServer = esApp.listen(0);
  await new Promise(r2 => esServer.once('listening', r2));
  const esBase = `http://127.0.0.1:${esServer.address().port}/api/stores`;
  const esGet = async (u) => { const x = await fetch(esBase + u); return { status: x.status, body: await x.json() }; };
  const esSend = async (m, u, body) => {
    const x = await fetch(esBase + u, { method: m, headers: { 'content-type': 'application/json' },
                                        body: JSON.stringify(body) });
    return { status: x.status, body: await x.json() };
  };

  let e = await esGet('/');
  ok('GET works and aliases the renamed columns back',
     e.body.stores.length === 3 && e.body.stores.every(s => typeof s.lat === 'number'), e.body);
  ok('the renamed name column comes back as `name`',
     e.body.stores.map(s => s.name).includes('Sol ES'), e.body.stores);
  ok('the renamed category column comes back as `category`',
     e.body.stores.every(s => typeof s.category === 'string'), e.body.stores[0]);

  e = await esGet('/?bbox=-3.75,40.40,-3.65,40.45');
  ok('bbox filtering works on the renamed columns', e.body.stores.length === 2, e.body.stores.map(s => s.name));

  e = await esSend('POST', '/in-polygon', { polygon: [
    { lat: 40.40, lng: -3.75 }, { lat: 40.45, lng: -3.75 },
    { lat: 40.45, lng: -3.65 }, { lat: 40.40, lng: -3.65 }] });
  ok('polygon selection works on the renamed table', e.body.count === 2, e.body);
  ok('control positive: the far store was correctly excluded',
     !e.body.stores.some(s => s.name === 'Lejos ES'), e.body.stores.map(s => s.name));

  e = await esSend('PATCH', '/1/location', { lat: 40.1, lng: -3.1 });
  ok('PATCH writes to the renamed columns', e.status === 200, e);
  const esRow = (await db.query('SELECT lat, origen FROM tiendas WHERE id_tienda=1'))[0];
  ok('...and the value really landed there', Number(esRow.lat) === 40.1, esRow);
  ok('...and marked the renamed source column manual', esRow.origen === 'manual', esRow);

  e = await esGet('/needs-review');
  ok('needs-review works on the renamed table',
     e.body.stores.length === 1 && e.body.stores[0].name === 'Chueca ES', e.body.stores);

  esServer.close();
  await db.query('DROP TABLE tiendas');

  console.log('\nquery plan');
  const plan = await db.query(
    `EXPLAIN SELECT id FROM stores
      WHERE latitude IS NOT NULL AND longitude IS NOT NULL
        AND latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?`,
    [40.41, 40.43, -3.715, -3.69]
  );
  ok('bounding-box query uses stores_latlng_idx, not a full scan',
     plan[0].key === 'stores_latlng_idx' && plan[0].type === 'range',
     { key: plan[0].key, type: plan[0].type });

  server.close();
  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

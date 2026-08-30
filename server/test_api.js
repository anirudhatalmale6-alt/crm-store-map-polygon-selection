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
      'INSERT INTO stores (name, category, address, latitude, longitude, geocoded_at) VALUES (?,?,?,?,?,?)',
      [name, category, address, lat, lng, lat === null ? null : new Date('2026-01-01T00:00:00Z')]
    );
  }

  // Mock geocoder: counts calls so we can prove the cache actually prevents them.
  let geocodeCalls = 0;
  const geocode = async (address) => {
    geocodeCalls++;
    if (address && address.includes('Calle Falsa')) return { lat: 40.4300, lng: -3.7000 };
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
  const moved = (await db.query('SELECT latitude, longitude, geocoded_at FROM stores WHERE id=1'))[0];
  ok('coordinates were actually written to MySQL',
     Number(moved.latitude) === 40.5 && Number(moved.longitude) === -3.5, moved);
  ok('geocoded_at was stamped', moved.geocoded_at !== null);
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

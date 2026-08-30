'use strict';
/* Geocoder tests with a stubbed fetch — no real Google calls, no cost. */
const makeGeocoder = require('./geocoder');

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { c ? (pass++, console.log('  ok   ' + n))
                                 : (fail++, console.log('  FAIL ' + n + (e ? '  ->  ' + e : ''))); };

const reply = (body, status = 200) => async () => ({ ok: status === 200, status, json: async () => body });
const g = (body, status) => makeGeocoder({ apiKey: 'k', fetchImpl: reply(body, status) });

(async () => {
  const okBody = {
    status: 'OK',
    results: [{ geometry: { location: { lat: 40.4168, lng: -3.7038 }, location_type: 'ROOFTOP' },
                formatted_address: 'Puerta del Sol, Madrid' }],
  };

  let r = await g(okBody)('Puerta del Sol, Madrid');
  ok('returns lat/lng on OK', r.lat === 40.4168 && r.lng === -3.7038, JSON.stringify(r));
  ok('passes through the formatted address', r.formattedAddress === 'Puerta del Sol, Madrid');
  ok('reports precision', r.precision === 'ROOFTOP');

  ok('ZERO_RESULTS is null, not an error',
     (await g({ status: 'ZERO_RESULTS', results: [] })('nowhere')) === null);
  ok('empty address short-circuits without a request', (await g(okBody)('   ')) === null);
  ok('null address short-circuits', (await g(okBody)(null)) === null);

  for (const [status, label] of [['OVER_QUERY_LIMIT', 'quota'], ['REQUEST_DENIED', 'denied'],
                                 ['INVALID_REQUEST', 'unknown status']]) {
    let threw = false;
    try { await g({ status })('x'); } catch { threw = true; }
    ok(`${status} throws rather than returning null (${label})`, threw);
  }

  let threw = false;
  try { await g({}, 500)('x'); } catch { threw = true; }
  ok('HTTP 500 throws', threw);

  ok('missing geometry is null',
     (await g({ status: 'OK', results: [{}] })('x')) === null);
  ok('non-numeric coordinates are null',
     (await g({ status: 'OK', results: [{ geometry: { location: { lat: 'x', lng: 1 } } }] })('x')) === null);

  // the key must actually be sent, and region must be forwarded when given
  let seen = null;
  const spy = makeGeocoder({
    apiKey: 'SECRET', region: 'es',
    fetchImpl: async (url) => { seen = url; return { ok: true, status: 200, json: async () => okBody }; },
  });
  await spy('Madrid');
  ok('api key is sent', seen.searchParams.get('key') === 'SECRET');
  ok('region bias is sent', seen.searchParams.get('region') === 'es');
  ok('address is sent', seen.searchParams.get('address') === 'Madrid');

  let ctorThrew = false;
  try { makeGeocoder({}); } catch { ctorThrew = true; }
  ok('missing apiKey fails loudly at construction', ctorThrew);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

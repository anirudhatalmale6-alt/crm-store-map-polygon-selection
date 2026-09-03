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

  /* --- the IP restriction, which is what REQUEST_DENIED actually means here ---
     The real message Google sent when the client's key was allow-listed for this
     machine's IPv4 address and Node left over its IPv6 one. Verbatim. */
  const deniedV6 = {
    status: 'REQUEST_DENIED', results: [],
    error_message: 'This IP, site or mobile application is not authorized to use this '
      + 'API key. Request received from IP address 2a01:4f8:c17:292c::1, with empty referer',
  };
  let msg = '';
  try { await g(deniedV6)('x'); } catch (e) { msg = e.message; }
  ok('a denial repeats the address Google actually saw', msg.includes('2a01:4f8:c17:292c::1'), msg);
  ok('...and says it was the IPv6 one, which is the actionable part',
     /IPv6/.test(msg), msg);
  ok('...rather than blaming the key, which is not what is wrong',
     !/check the API key/.test(msg), msg);

  const { explainDenial, pinToIPv4, isPinned } = require('./egress');
  const v4 = explainDenial('Request received from IP address 203.0.113.9, with empty referer');
  ok('an IPv4 denial is reported as IPv4', v4 && v4.family === 4 && v4.ip === '203.0.113.9', v4);
  ok('...and tells you to add exactly that address to the IP restriction',
     /203\.0\.113\.9/.test(v4.hint) && /IP restriction/.test(v4.hint), v4.hint);
  ok('a denial with no address in it does not invent one',
     explainDenial('The provided API key is invalid.') === null);
  ok('...and such a message still surfaces Google\'s own text', await (async () => {
    let m = '';
    try { await g({ status: 'REQUEST_DENIED', error_message: 'The provided API key is invalid.' })('x'); }
    catch (e) { m = e.message; }
    return m.includes('The provided API key is invalid.');
  })());

  ok('the IPv4 pin is not applied merely by importing it', isPinned() === false);
  pinToIPv4();
  ok('...applies when asked', isPinned() === true);
  ok('...and is idempotent', pinToIPv4() === true && isPinned() === true);

  /* The Hot Fill shape: Google's FIRST answer is the wrong town and its SECOND is the
     right one. Reading results[0] silently discarded the answer we were paying for. */
  const twoBody = {
    status: 'OK',
    results: [
      { geometry: { location: { lat: 6.2387, lng: -75.5648 }, location_type: 'ROOFTOP' },
        formatted_address: 'Las Palmas, Medellin', partial_match: true, types: ['route'] },
      { geometry: { location: { lat: 6.1508, lng: -75.3800 }, location_type: 'GEOMETRIC_CENTER' },
        formatted_address: 'Rionegro, Antioquia', types: ['locality'] },
    ],
  };

  const list = await g(twoBody)('KM 1 VIA AEROPUERTO LAS PALMAS, Rionegro', { all: true });
  ok('every candidate is returned, not just the first', list.length === 2, JSON.stringify(list));
  ok('...in Google\'s own order', list[0].lat === 6.2387 && list[1].lat === 6.1508);
  ok('...each carrying its own precision',
     list[0].precision === 'ROOFTOP' && list[1].precision === 'GEOMETRIC_CENTER');
  // Not a grade of the answer but a statement about the question, so it must survive.
  ok('partial_match survives as its own field, apart from precision',
     list[0].partial === true && list[1].partial === false, JSON.stringify(list.map(c => c.partial)));
  ok('types survive, so a "locality" answer can be told from a street one',
     list[1].types.includes('locality'));

  // Control positive: the default call is unchanged by any of the above.
  const one = await g(twoBody)('KM 1 VIA AEROPUERTO LAS PALMAS, Rionegro');
  ok('control positive: the plain call still returns exactly the first candidate',
     one.lat === 6.2387 && one.precision === 'ROOFTOP', JSON.stringify(one));

  ok('ZERO_RESULTS with {all} is an empty list, not null',
     Array.isArray(await g({ status: 'ZERO_RESULTS', results: [] })('x', { all: true })));
  ok('an empty address with {all} costs no request and yields an empty list',
     (await g(twoBody)('  ', { all: true })).length === 0);

  /* A result with no usable geometry is skipped rather than ending the list, so one
     malformed entry cannot hide the good answers behind it. */
  const junkFirst = await g({ status: 'OK', results: [
    { formatted_address: 'no geometry at all' },
    { geometry: { location: { lat: 1, lng: 2 }, location_type: 'ROOFTOP' }, formatted_address: 'real' },
  ] })('x', { all: true });
  ok('a malformed candidate is dropped, not treated as the end of the list',
     junkFirst.length === 1 && junkFirst[0].formattedAddress === 'real', JSON.stringify(junkFirst));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

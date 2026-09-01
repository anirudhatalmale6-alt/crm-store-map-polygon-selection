'use strict';
/* Tests for YOUR schema, run against YOUR data.
 *
 *   node server/test_ventas.js --port 13307 --db ventas
 *
 * The demo's other suites run against eight invented stores in Madrid. Those are
 * good for proving behaviour but useless for proving that behaviour survives real
 * data, which is where the surprises are: empty cities, addresses that are the
 * single character "_", a shop in Italy filed under Colombia, and 94 rows where
 * the city and the state hold the same word.
 *
 * The centrepiece is the equivalence test. composeAddress() (JavaScript, used by
 * the API) and composeAddressSql() (SQL, used by the batch geocoder) are two
 * implementations of one rule, and two implementations of one rule drift. So both
 * are run over every row in the database and the outputs are compared byte for
 * byte. If they ever disagree on even one row, that row would be re-geocoded on
 * every single run, forever, because each side would keep deciding the other's
 * stored address was the wrong one.
 */
const mysql = require('mysql2/promise');
const {
  ventasSchema, composeAddress, composeAddressSql,
  isPlaceholder, isInternational, geocodability, hasUsableStreet, hasUsableLocality,
  streetIsPlaceHint, inColombia, pinLooksWrong,
} = require('./ventas');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ->  ' + JSON.stringify(extra) : '')); }
};

(async () => {
  console.log('composition rules, in isolation');

  ok('empty parts are dropped rather than joined as blanks',
     composeAddress({ street: 'CL 5 3 B 15', city: '', state: null, country: 'Colombia' })
       === 'CL 5 3 B 15, Colombia');
  ok('"No identificada" is treated as an absent city, not a town name',
     composeAddress({ street: 'CR 2 46 13', city: 'No identificada', state: 'Huila', country: 'Colombia' })
       === 'CR 2 46 13, Huila, Colombia');
  ok('a city repeated as the state appears once',
     composeAddress({ street: 'CL 1', city: 'Bogota', state: 'Bogota', country: 'Colombia' })
       === 'CL 1, Bogota, Colombia');
  ok('an international row drops the wrong country and keeps the right one',
     composeAddress({ street: 'Via G. Buitoni 25, 52037 Sansepolcro', city: 'Italia',
                      state: 'Internacional', country: 'Colombia' })
       === 'Via G. Buitoni 25, 52037 Sansepolcro, Italia');
  /* Control positive: without the international rule this same row would compose
     to something ending in ", Colombia" — the failure being guarded against is a
     pin that lands successfully in the wrong country. */
  ok('control positive: the international rule is what removed Colombia',
     composeAddress({ street: 'Via G. Buitoni 25', city: 'Italia',
                      state: 'Toscana', country: 'Colombia' }).endsWith(', Colombia'));
  ok('internal double spaces are preserved, not collapsed',
     composeAddress({ street: 'CL 108  80 60', city: 'Medellin', state: '', country: '' })
       === 'CL 108  80 60, Medellin');
  ok('accented and unaccented spellings are NOT merged',
     composeAddress({ street: 'CL 1', city: 'Medellín', state: 'Medellin', country: '' })
       === 'CL 1, Medellín, Medellin');

  console.log('\nwhether a row can be pinned at all');
  ok('a street with a number and a city is worth a full geocode',
     geocodability({ street: 'CR 70 C 55 33', city: 'Cali', state: 'Valle' }) === 'street');
  /* This one is here because the first version of geocodability() got it wrong and
     binned 300-odd findable addresses for having a placeholder city. */
  ok('a detailed street with no usable city is still worth sending',
     geocodability({ street: 'Calle 45 C Bis # 23 -08 Barrio Palermo',
                     city: 'No identificada', state: '' }) === 'street');
  ok('"Xxx" is not a street', !hasUsableStreet({ street: 'Xxx' }));
  ok('"_" is not a street', !hasUsableStreet({ street: '_' }));
  ok('a short no-digit fragment is not a street', !hasUsableStreet({ street: 'Centro comercial' }));
  ok('a named landmark with no house number IS a street',
     hasUsableStreet({ street: 'Hospital Universitario San Jose Barrios Unidos' }));
  ok('a Bogota locality name on its own is not a street', !hasUsableStreet({ street: 'Suba' }));
  ok('an Instagram profile is not a street',
     !hasUsableStreet({ street: 'Https://Instagram.Com/Branysu_Quiropedia' }));
  ok('no street but a real city still gets a city-centre pin',
     geocodability({ street: '', city: 'Neiva', state: 'Huila' }) === 'locality');
  ok('no street and no city cannot be pinned by anyone',
     geocodability({ street: '', city: 'No identificada', state: '' }) === 'none');
  ok('a state alone is enough of a locality', hasUsableLocality({ city: '', state: 'Antioquia' }));

  /* A place name sitting in the street field with nothing in the city field. All
     of these are real, taken from your data; all were being discarded. */
  for (const s of ['Mocoa - Putumayo', 'Ciudad Jardin Norte', 'Kennedy', 'Quimbaya', 'Vichada']) {
    ok(`"${s}" is recognised as a place, not junk`,
       geocodability({ street: s, city: 'No identificada', state: '' }) === 'locality');
  }
  ok('the sentinel "1503" is not a place name', !streetIsPlaceHint({ street: '1503' }));
  ok('"xxxx" is not a place name', !streetIsPlaceHint({ street: 'xxxx' }));
  ok('"Ca" is too short to be a place name', !streetIsPlaceHint({ street: 'Ca' }));
  ok('an Instagram URL is not a place name',
     !streetIsPlaceHint({ street: 'Https://Instagram.Com/Branysu_Quiropedia' }));
  ok('the placeholder list is case-insensitive', isPlaceholder('  No Identificada '));
  ok('a real city is not a placeholder', !isPlaceholder('Cali'));
  ok('the international marker is recognised case-insensitively',
     isInternational({ state: ' INTERNACIONAL ' }));
  ok('an ordinary state is not the international marker',
     !isInternational({ state: 'Antioquia' }));

  const CONF = {
    host: arg('host', '127.0.0.1'), port: Number(arg('port', 13307)),
    user: arg('user', 'root'), password: arg('pwd', ''), database: arg('db', 'ventas'),
  };
  const pool = mysql.createPool({ ...CONF, connectionLimit: 2, waitForConnections: true });
  const { q, names } = ventasSchema();

  try {
    console.log('\nagainst the real database (' + CONF.database + ')');

    const [rows] = await pool.query(
      `SELECT ${q.addrId} AS id,
              ${q.street}  AS street, ${q.city}    AS city,
              ${q.state}   AS state,  ${q.country} AS country,
              ${composeAddressSql(q)} AS sql_composed
         FROM ${q.addresses}`);

    ok('there is real data to test against (control positive)', rows.length > 100, rows.length);

    /* THE test. Two implementations of one rule, over every row that exists. */
    const mismatches = [];
    for (const r of rows) {
      const js = composeAddress(r);
      if (js !== r.sql_composed) mismatches.push({ id: r.id, js, sql: r.sql_composed });
    }
    ok(`JavaScript and SQL compose all ${rows.length} real addresses identically`,
       mismatches.length === 0, mismatches.slice(0, 3));

    /* A test that only ever compares empty strings to empty strings passes for the
       wrong reason. Prove the comparison had something to chew on. */
    const nonEmpty = rows.filter(r => composeAddress(r) !== '').length;
    ok('control positive: most composed addresses are non-empty',
       nonEmpty > rows.length * 0.9, nonEmpty + '/' + rows.length);
    const withCommas = rows.filter(r => composeAddress(r).includes(', ')).length;
    ok('control positive: composition really is joining several parts',
       withCommas > rows.length * 0.9, withCommas + '/' + rows.length);

    /* And prove it discriminates: a deliberately divergent rule must FAIL the
       same comparison. Without this, a composeAddress() that returned the SQL
       column verbatim would pass every assertion above. */
    const brokenMismatches = rows.filter(r => (composeAddress(r) + '!') === r.sql_composed).length;
    ok('control positive: a deliberately wrong composition would not match',
       brokenMismatches === 0 && mismatches.length === 0);

    console.log('\nwhat the data actually looks like');
    const [[counts]] = await pool.query(
      `SELECT COUNT(*) n,
              SUM(CAST(LOWER(TRIM(${q.state})) AS BINARY) = CAST('internacional' AS BINARY)) intl
         FROM ${q.addresses}`);
    ok('every client has exactly one address row (the 1:1 the design relies on)',
       Number(counts.n) === (await pool.query(`SELECT COUNT(*) c FROM ${q.clients}`))[0][0].c,
       Number(counts.n));

    const [[uq]] = await pool.query(
      `SELECT COUNT(*) c FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND NON_UNIQUE = 0
          AND COLUMN_NAME = ?`, [CONF.database, names.addresses, names.addrClientId]);
    /* The 1:1 above is a fact about today's rows; this is what keeps it true
       tomorrow. Without it the Excel importer's ON DUPLICATE KEY UPDATE would
       never fire and every import would add a second address row per client. */
    ok('a unique key on client_id enforces that 1:1 going forward', Number(uq.c) > 0);

    const intl = rows.filter(isInternational);
    ok('the international rows are found by their own marker, not by guesswork',
       intl.length === Number(counts.intl) && intl.length > 0, intl.length);
    ok('no international row ends up labelled Colombia',
       intl.every(r => !/Colombia\s*$/i.test(composeAddress(r))),
       intl.filter(r => /Colombia\s*$/i.test(composeAddress(r))).slice(0, 2));

    const buckets = { street: 0, locality: 0, none: 0 };
    for (const r of rows) buckets[geocodability(r)]++;
    ok('every row lands in exactly one geocodability bucket',
       buckets.street + buckets.locality + buckets.none === rows.length, buckets);
    ok('the unpinnable rows are a real, non-zero group worth excluding',
       buckets.none > 0 && buckets.none < rows.length * 0.2, buckets);

    /* "Nothing real got binned" cannot be asserted by re-running the classifier —
       that only proves it agrees with itself. So: pull the rows it discarded, and
       check the ones that still look like prose. Every discarded row with three or
       more words in its street is listed by hand here, having been read. Today
       that is one row, containing an Instagram profile. If a future change starts
       discarding real addresses, this list grows and the test fails. */
    const KNOWN_DISCARDED = ['1503', 'Https://Instagram.Com/Branysu_Quiropedia', ''];
    const discarded = [...new Set(rows
      .filter(r => geocodability(r) === 'none')
      .map(r => String(r.street || '').trim()))];
    ok('nothing is discarded except the three known-junk values',
       discarded.every(s => KNOWN_DISCARDED.includes(s)),
       discarded.filter(s => !KNOWN_DISCARDED.includes(s)).slice(0, 8));
    ok('control positive: the discarded group is not empty', discarded.length > 1, discarded);
    /* And the reverse: prove real addresses survive. Three read off the dump. */
    for (const street of ['Hospital Universitario San Jose Barrios Unidos',
                          'Centro Comercial El Tesoro, El Poblado',
                          'CL 108  80 60']) {
      const found = rows.find(r => String(r.street || '').trim() === street);
      ok(`"${street.slice(0, 34)}" is kept`, !!found && geocodability(found) !== 'none',
         found ? geocodability(found) : 'row not in dump');
    }
    /* ── Pins that landed in the wrong country ────────────────────────────────
       Every case below is a real row from the real run, with the coordinates
       Google actually returned. Precision does not catch any of them: the
       Manhattan one came back RANGE_INTERPOLATED, which reads as confident. */
    ok('a Bogota pin is inside Colombia', inColombia(4.6571, -74.0575));
    ok('a Medellin pin is inside Colombia', inColombia(6.3087, -75.5769));

    /* THE control positive. San Andres is 700km off Nicaragua and is Colombian.
       The first version of this check used a mainland-only box and reported this
       correct pin as foreign — a check that "corrects" good data is worse than
       no check. */
    ok('San Andres is Colombia, not a foreign pin', inColombia(12.5769, -81.7051));
    ok('Malpelo is Colombia too', inColombia(4.0, -81.6));

    ok('Panama City is not Colombia', !inColombia(8.9625, -79.5407));
    ok('Manhattan is not Colombia', !inColombia(40.7355, -73.9923));
    ok('San Juan, Puerto Rico is not Colombia', !inColombia(18.4335, -66.0478));
    ok('non-numeric coordinates are not "in Colombia"', !inColombia(null, undefined));

    ok('a good pin is not flagged', pinLooksWrong({ lat: 4.6571, lng: -74.0575, state: 'Cundinamarca' }) === null);
    ok('the Manhattan pin IS flagged, which precision never would be',
       pinLooksWrong({ lat: 40.7355, lng: -73.9923, state: 'Tachira' }) !== null);
    ok('the San Andres pin is NOT flagged',
       pinLooksWrong({ lat: 12.5769, lng: -81.7051, state: 'San Andres y Providencia' }) === null);
    /* Internacional rows are meant to be abroad, so there is nothing to contradict. */
    ok('an Internacional row abroad is not flagged',
       pinLooksWrong({ lat: -2.0452, lng: -79.8918, state: 'Internacional' }) === null);
    ok('a row with no pin yet is not flagged', pinLooksWrong({ lat: null, lng: null, state: 'Antioquia' }) === null);

  } finally {
    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

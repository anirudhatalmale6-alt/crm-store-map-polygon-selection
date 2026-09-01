'use strict';
/* Geocode the stores that have an address but no coordinates.
 *
 *   node server/geocode-batch.js --dry-run          # costs nothing, tells you the size
 *   node server/geocode-batch.js --limit 100        # do the first 100 for real
 *   node server/geocode-batch.js --limit 2000
 *
 * Written to be run several times. It only ever picks up rows that still need
 * doing, so if it stops - quota, network, Ctrl-C - you just run it again and it
 * carries on. Nothing is lost and nothing is paid for twice.
 *
 * Flags:
 *   --limit N          hard cap on Google calls this run (default 100)
 *   --dry-run          count and list, call nobody, spend nothing
 *   --retry-failed     also retry addresses that were tried and came back empty
 *                      (use this after correcting bad addresses)
 *   --refresh-changed  also redo rows whose ADDRESS was edited after the pin was
 *                      placed - the pin is sitting on the old street
 *   --force            also redo rows that already have coordinates
 *   --qps N            requests per second (default 10; Google's default cap is 50)
 *
 * Never touches a row whose location_source is 'manual'. See stores.routes.js.
 */
const makeGeocoder = require('./geocoder');
const { pinToIPv4 } = require('./egress');
const { makeSchema } = require('./schema');
const { staleSql } = require('./address');

/* The work itself, with the database and the geocoder handed in. Split out from the
 * command line so the tests can drive it against a real MySQL with a stubbed
 * geocoder - a batch job that has never been run against a database is a guess. */
async function runBatch({ db, geocode, schema = makeSchema(), limit = 100, force = false,
                          retryFailed = false, refreshChanged = false,
                          dryRun = false, qps = 10, log = console.log, skip = null }) {
  const { q, table } = schema;
  /* The address is an expression, not necessarily a column: one `address` field on
     the demo table, four columns concatenated on the real CRM. See schema.js. */
  const addressExpr = schema.addressExpr || q.address;
  const extraCols = schema.extraCols || [];

  const hasAddress = `${addressExpr} IS NOT NULL AND ${addressExpr} <> ''`;
  /* `location_source <=> 'manual'` is the null-safe comparison, and it matters.
     Plain `!= 'manual'` evaluates to NULL for every row that has never been
     positioned - and NULL is not true, so those rows, the ones that most need
     geocoding, would be silently skipped. The script would report "0 to do" and
     look like it had finished. */
  const notManual = `NOT (${q.source} <=> 'manual')`;
  const noCoords  = `(${q.latitude} IS NULL OR ${q.longitude} IS NULL)`;

  const stale = staleSql(q, addressExpr);
  /* Never even attempted. geocoded_at IS NULL is what makes this run finite: an
     address Google cannot resolve gets stamped and then stops being a candidate.
     Without that clause the same unresolvable addresses are paid for again on
     every single run, forever, and the script never reports "nothing to do". */
  const never  = `(${noCoords} AND ${q.geocodedAt} IS NULL)`;
  /* Attempted but still has no coordinates, plus the ones we tried and could not
     place. Use after fixing bad addresses. */
  const failed = `(${noCoords} OR ${q.source} = 'unresolved')`;

  /* Definitions of "needs doing", widened by flag. --refresh-changed adds the
     rows whose address was edited after the pin was placed; it is opt-in because
     turning a rename-heavy afternoon in the CRM into a Google bill should be a
     decision, not a side effect. Every branch excludes hand-corrected pins. */
  const base = refreshChanged
    ? `((${retryFailed ? failed : never}) OR ${stale})`
    : (retryFailed ? failed : never);
  const where = force ? `${hasAddress} AND ${notManual}`
                      : `${hasAddress} AND ${notManual} AND ${base}`;

  const [{ total }] = await db.query(`SELECT COUNT(*) AS total FROM ${table} WHERE ${where}`, []);
  const [{ manual }] = await db.query(
    `SELECT COUNT(*) AS manual FROM ${table} WHERE ${q.source} = 'manual'`, []);
  /* Hand-placed pins whose address has since been edited. The script deliberately
     will not touch these - the correction was made for the old address, and only a
     person can say whether the store moved or the address was just tidied up - so
     they are reported instead of silently skipped. */
  const [{ manualStale }] = await db.query(
    `SELECT COUNT(*) AS manualStale FROM ${table}
      WHERE ${q.source} = 'manual' AND ${stale}`, []);

  log(`${total} store(s) need geocoding${force ? ' (--force: including ones that already have coordinates)' : ''}`);
  log(`${manual} hand-adjusted store(s) will be skipped and left exactly as they are`);
  if (manualStale) {
    log(`${manualStale} of those had their address edited after the pin was placed - ` +
        `they need a person, not this script (GET /api/stores/needs-review)`);
  }
  if (total > limit) log(`this run will do ${limit} of them (--limit); run it again for the rest`);

  /* Its own SELECT rather than the schema's full one. This job needs an id and an
     address; the API's list of columns includes a name and a category that do not
     exist on every table this can be pointed at. */
  const cols = [`${q.id} AS id`, `${addressExpr} AS address`, ...extraCols].join(', ');
  const rows = await db.query(
    `SELECT ${cols} FROM ${table} WHERE ${where} ORDER BY ${q.id} LIMIT ?`,
    [Math.min(limit, total)]
  );

  const stats = { total, manual, manualStale, considered: rows.length, ok: 0, noResult: 0,
                  failed: 0, skipped: 0, stoppedEarly: false, byPrecision: {},
                  failures: [], skips: [] };

  if (dryRun) {
    /* Apply the skip rule here too. The whole reason to run --dry-run is to find
       out what the run will cost, and a count that includes rows the real run
       would never send is not that number. */
    for (const row of rows) {
      const why = skip ? skip(row) : null;
      if (why) { stats.skipped++; stats.skips.push({ id: row.id, address: row.address, why }); }
    }
    const willSend = rows.length - stats.skipped;
    log('\n--dry-run: nothing was called and nothing was written.');
    log(`${willSend} of these would be sent to Google ≈ $${(willSend * 0.005).toFixed(2)}` +
        (stats.skipped ? `; ${stats.skipped} would not be sent at all` : ''));
    rows.filter(r => !(skip && skip(r))).slice(0, 10).forEach(r => log(`  ${r.id}  ${r.address}`));
    if (willSend > 10) log(`  ... and ${willSend - 10} more`);
    if (stats.skipped) {
      log(`\nnot sent:`);
      stats.skips.slice(0, 5).forEach(s => log(`  ${s.id}  ${s.why}  ${JSON.stringify(s.address)}`));
      if (stats.skips.length > 5) log(`  ... and ${stats.skips.length - 5} more`);
    }
    return stats;
  }

  const interval = 1000 / qps;
  for (const row of rows) {
    const started = Date.now();

    /* Rows a geocoder cannot possibly place — no street and no usable city. A
       request that cannot succeed costs exactly as much as one that does, and
       234 of the real rows are in this state. They are stamped 'unresolved' for
       the same reason a no-result is: an unstamped row stays in the candidate
       set forever, eats the --limit budget on every future run, and the script
       never gets to say "nothing left to do". Nothing is sent and nothing is
       charged; they land on the review list, which is where a person can fix the
       address. */
    const why = skip ? skip(row) : null;
    if (why) {
      await db.query(
        `UPDATE ${table} SET ${q.geocodedAt} = NOW(), ${q.source} = 'unresolved',
                             ${q.precision} = NULL, ${q.locationAddress} = ?
          WHERE ${q.id} = ?`, [row.address, row.id]);
      stats.skipped++;
      stats.skips.push({ id: row.id, address: row.address, why });
      continue;                       // no wait: we did not call anybody
    }

    try {
      const hit = await geocode(row.address);
      if (!hit) {
        /* A bad address, not a broken run. Record the attempt AGAINST THE ADDRESS
           THAT FAILED - stamping geocoded_at alone is not enough once addresses can
           change, because a row edited to an ungeocodable address would stay stale
           forever and be paid for on every future --refresh-changed run. Leave
           lat/lng exactly as they are and mark the row 'unresolved', which keeps it
           on the review list needing a better address rather than a dragged pin.
           Marking it 'geocoded' would hide it. */
        await db.query(
          `UPDATE ${table} SET ${q.geocodedAt} = NOW(), ${q.source} = 'unresolved',
                               ${q.precision} = NULL, ${q.locationAddress} = ?
            WHERE ${q.id} = ?`, [row.address, row.id]);
        stats.noResult++;
        stats.failures.push({ id: row.id, address: row.address, why: 'no result' });
        continue;
      }
      await db.query(
        `UPDATE ${table} SET ${q.latitude} = ?, ${q.longitude} = ?, ${q.geocodedAt} = NOW(),
                             ${q.source} = 'geocoded', ${q.precision} = ?,
                             ${q.locationAddress} = ?
          WHERE ${q.id} = ?`,
        [hit.lat, hit.lng, hit.precision || null, row.address, row.id]
      );
      stats.ok++;
      const p = hit.precision || 'UNKNOWN';
      stats.byPrecision[p] = (stats.byPrecision[p] || 0) + 1;
    } catch (e) {
      stats.failed++;
      stats.failures.push({ id: row.id, address: row.address, why: String(e.message) });
      /* Quota and permission errors are not per-address problems: every remaining
         call will fail the same way. Carrying on would turn one wasted call into
         hundreds of them. */
      if (/quota|denied/i.test(e.message)) {
        stats.stoppedEarly = true;
        log(`\nStopping early: ${e.message}`);
        break;
      }
    }
    const wait = interval - (Date.now() - started);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
  }
  return stats;
}

module.exports = { runBatch };


/* ---- command line ---- */
if (require.main === module) {
  const mysql = require('mysql2/promise');

  const arg = (name, fallback) => {
    const i = process.argv.indexOf('--' + name);
    if (i === -1) return fallback;
    const v = process.argv[i + 1];
    return v === undefined || v.startsWith('--') ? true : v;
  };

  /* Before anything else: leave by the address the key is allow-listed for.
     See server/egress.js — this machine has both an IPv4 and an IPv6 address,
     only one of which the client allow-listed, and Node prefers the other. */
  pinToIPv4();

  const dryRun = process.argv.includes('--dry-run');
  const force  = process.argv.includes('--force');
  const retryFailed = process.argv.includes('--retry-failed');
  const refreshChanged = process.argv.includes('--refresh-changed');
  const limit  = Number(arg('limit', 100));
  const qps    = Number(arg('qps', 10));

  /* A cap you have to raise on purpose. The failure this prevents is the one where
     a loop over a table you thought had 2,000 rows turns out to run over 200,000
     and you find out from the bill. Defaulting to "all of them" is not a kindness. */
  if (!Number.isFinite(limit) || limit < 1 || limit > 5000) {
    console.error('--limit must be a number between 1 and 5000. Raise it deliberately, or run it twice.');
    process.exit(2);
  }
  if (!Number.isFinite(qps) || qps < 1 || qps > 50) {
    console.error('--qps must be a number between 1 and 50.');
    process.exit(2);
  }

  (async () => {
    const pool = mysql.createPool({
      host: process.env.DB_HOST || '127.0.0.1',
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'crmtest',
      waitForConnections: true, connectionLimit: 4,
    });
    const db = { query: async (sql, p) => (await pool.query(sql, p))[0] };

    // Built even for a dry run, so a missing or malformed key is reported now
    // rather than after you have decided the dry run looked fine.
    const geocode = makeGeocoder({
      apiKey: process.env.GOOGLE_GEOCODING_KEY,
      region: process.env.GEOCODE_REGION || undefined,
    });

    /* One request, on a landmark, before spending money on 2,400 of them.
       The failure this prevents: a key restriction that rejects us silently, a
       run that writes "could not be geocoded" against several hundred perfectly
       good addresses, and a bill for the privilege. Costs $0.005 and takes a
       second. Skipped on a dry run, which makes no calls at all. */
    if (!dryRun) {
      process.stdout.write('preflight: one request to check the key and our IP ... ');
      try {
        const hit = await geocode('Plaza de Bolivar, Bogota, Colombia');
        if (!hit) throw new Error('a known landmark returned no result - check GEOCODE_REGION');
        console.log(`ok (${hit.precision})`);
      } catch (e) {
        console.error('FAILED\n');
        console.error(String(e.message || e));
        console.error('\nNothing was geocoded and nothing was charged. Fix the above and re-run.');
        await pool.end();
        process.exit(3);
      }
    }

    const stats = await runBatch({ db, geocode, limit, force, retryFailed,
                                   refreshChanged, dryRun, qps });

    if (!dryRun) {
      console.log(`\ngeocoded ${stats.ok} · no result ${stats.noResult} · errors ${stats.failed}`);
      for (const p of ['ROOFTOP', 'RANGE_INTERPOLATED', 'GEOMETRIC_CENTER', 'APPROXIMATE', 'UNKNOWN']) {
        if (stats.byPrecision[p]) console.log(`  ${p.padEnd(19)} ${stats.byPrecision[p]}`);
      }
      const soft = (stats.byPrecision.GEOMETRIC_CENTER || 0) + (stats.byPrecision.APPROXIMATE || 0);
      if (soft) {
        console.log(`\n${soft} pin(s) Google itself was not confident about.`);
        console.log('GET /api/stores/needs-review lists them - drag those on the map.');
      }
      if (stats.failures.length) {
        console.log(`\n${stats.failures.length} address(es) to look at:`);
        stats.failures.slice(0, 20).forEach(f => console.log(`  ${f.id}  ${f.why}  ${f.address}`));
        if (stats.failures.length > 20) console.log(`  ... and ${stats.failures.length - 20} more`);
      }
      const left = stats.total - stats.ok - stats.noResult;
      if (left > 0) console.log(`\n${left} still to do - run it again.`);
    }
    await pool.end();
  })().catch(e => { console.error(e); process.exit(1); });
}

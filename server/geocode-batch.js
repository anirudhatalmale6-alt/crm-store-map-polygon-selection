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
 *   --limit N       hard cap on Google calls this run (default 100)
 *   --dry-run       count and list, call nobody, spend nothing
 *   --retry-failed  also retry addresses that were tried and came back empty
 *                   (use this after correcting bad addresses)
 *   --force         also redo rows that already have coordinates
 *   --qps N         requests per second (default 10; Google's default cap is 50)
 *
 * Never touches a row whose location_source is 'manual'. See stores.routes.js.
 */
const makeGeocoder = require('./geocoder');
const { makeSchema } = require('./schema');

/* The work itself, with the database and the geocoder handed in. Split out from the
 * command line so the tests can drive it against a real MySQL with a stubbed
 * geocoder - a batch job that has never been run against a database is a guess. */
async function runBatch({ db, geocode, schema = makeSchema(), limit = 100, force = false,
                          retryFailed = false, dryRun = false, qps = 10, log = console.log }) {
  const { q, table, selectCols } = schema;

  const hasAddress = `${q.address} IS NOT NULL AND ${q.address} <> ''`;
  /* `location_source <=> 'manual'` is the null-safe comparison, and it matters.
     Plain `!= 'manual'` evaluates to NULL for every row that has never been
     positioned - and NULL is not true, so those rows, the ones that most need
     geocoding, would be silently skipped. The script would report "0 to do" and
     look like it had finished. */
  const notManual = `NOT (${q.source} <=> 'manual')`;
  const noCoords  = `(${q.latitude} IS NULL OR ${q.longitude} IS NULL)`;

  /* Three widening definitions of "needs doing":
     default      - never even attempted. geocoded_at IS NULL is what makes this
                    run finite: an address Google cannot resolve gets stamped and
                    then stops being a candidate. Without that clause the same
                    unresolvable addresses are paid for again on every single run,
                    forever, and the script never reports "nothing to do".
     retryFailed  - attempted but still has no coordinates. This is the one to use
                    after fixing bad addresses.
     force        - everything with an address, coordinates or not.
     All three exclude hand-corrected pins. */
  const where = force      ? `${hasAddress} AND ${notManual}`
              : retryFailed ? `${hasAddress} AND ${noCoords} AND ${notManual}`
              :               `${hasAddress} AND ${noCoords} AND ${q.geocodedAt} IS NULL
                               AND ${notManual}`;

  const [{ total }] = await db.query(`SELECT COUNT(*) AS total FROM ${table} WHERE ${where}`, []);
  const [{ manual }] = await db.query(
    `SELECT COUNT(*) AS manual FROM ${table} WHERE ${q.source} = 'manual'`, []);

  log(`${total} store(s) need geocoding${force ? ' (--force: including ones that already have coordinates)' : ''}`);
  log(`${manual} hand-adjusted store(s) will be skipped and left exactly as they are`);
  if (total > limit) log(`this run will do ${limit} of them (--limit); run it again for the rest`);

  const rows = await db.query(
    `SELECT ${selectCols} FROM ${table} WHERE ${where} ORDER BY ${q.id} LIMIT ?`,
    [Math.min(limit, total)]
  );

  const stats = { total, manual, considered: rows.length, ok: 0, noResult: 0,
                  failed: 0, stoppedEarly: false, byPrecision: {}, failures: [] };

  if (dryRun) {
    log('\n--dry-run: nothing was called and nothing was written.');
    rows.slice(0, 10).forEach(r => log(`  ${r.id}  ${r.address}`));
    if (rows.length > 10) log(`  ... and ${rows.length - 10} more`);
    return stats;
  }

  const interval = 1000 / qps;
  for (const row of rows) {
    const started = Date.now();
    try {
      const hit = await geocode(row.address);
      if (!hit) {
        /* A bad address, not a broken run. Stamp geocoded_at so the next run does
           not pay to ask the same unanswerable question again, but leave lat/lng
           NULL and location_source NULL so the row still shows up as needing a
           human. Marking it 'geocoded' would hide it from the review list. */
        await db.query(
          `UPDATE ${table} SET ${q.geocodedAt} = NOW() WHERE ${q.id} = ?`, [row.id]);
        stats.noResult++;
        stats.failures.push({ id: row.id, address: row.address, why: 'no result' });
        continue;
      }
      await db.query(
        `UPDATE ${table} SET ${q.latitude} = ?, ${q.longitude} = ?, ${q.geocodedAt} = NOW(),
                             ${q.source} = 'geocoded', ${q.precision} = ?
          WHERE ${q.id} = ?`,
        [hit.lat, hit.lng, hit.precision || null, row.id]
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

  const dryRun = process.argv.includes('--dry-run');
  const force  = process.argv.includes('--force');
  const retryFailed = process.argv.includes('--retry-failed');
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

    const stats = await runBatch({ db, geocode, limit, force, retryFailed, dryRun, qps });

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

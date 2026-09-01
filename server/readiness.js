'use strict';
/* What is actually in your address data, measured — run this BEFORE spending a
 * peso on geocoding.
 *
 *   DB_HOST=... DB_USER=... DB_PWD=... DB_NAME=... node server/readiness.js
 *   node server/readiness.js --port 13307 --user root --db ventas
 *   node server/readiness.js --json          # same numbers, machine-readable
 *
 * READ-ONLY. Every statement in this file is a SELECT. It creates nothing, alters
 * nothing and writes nothing, so it is safe to point at production — and pointing
 * it at production is the whole idea, because a report about a copy of the data is
 * a report about a copy of the data.
 *
 * What it will NOT tell you: how many addresses Google can actually find. Nothing
 * can tell you that except asking Google, and asking Google costs money. What this
 * does is separate the rows that are worth asking about from the ones that cannot
 * possibly succeed, so the bill is spent on the first group only.
 */
const mysql = require('mysql2/promise');
const { ventasSchema, composeAddress, geocodability } = require('./ventas');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/* A unix socket is not a nicety: on a server where MySQL only listens locally —
   which is how it should be configured, and how many shared hosts ship it — TCP to
   127.0.0.1 is refused and the socket is the only way in. When one is given, host
   and port are meaningless, so they are dropped rather than printed as if they
   described the connection. */
const SOCKET = arg('socket', process.env.DB_SOCKET || '');
const CONF = SOCKET
  ? {
      socketPath: SOCKET,
      user: arg('user', process.env.DB_USER || 'root'),
      password: arg('pwd', process.env.DB_PWD || ''),
      database: arg('db', process.env.DB_NAME || 'ventas'),
    }
  : {
      host: arg('host', process.env.DB_HOST || '127.0.0.1'),
      port: Number(arg('port', process.env.DB_PORT || 3306)),
      user: arg('user', process.env.DB_USER || 'root'),
      password: arg('pwd', process.env.DB_PWD || ''),
      database: arg('db', process.env.DB_NAME || 'ventas'),
    };
const WHERE = SOCKET ? `socket ${SOCKET}` : `${CONF.host}:${CONF.port}`;
const AS_JSON = process.argv.includes('--json');

const { q } = ventasSchema();

/* The category the map will colour by. There is no single column for it: `type`
 * separates potential from existing, and `c_status` separates live from dormant.
 * Written as one expression so the report, the API and the legend cannot disagree
 * about what an "Active" store is.
 *
 * NOTE: there is no Chain category anywhere in the database — not in the enum, not
 * in the backend, not in the frontend. It has to be defined before it can be
 * coloured. See README, "The third category does not exist yet". */
const CATEGORY_SQL =
  `CASE WHEN ${q.clientType} = 'potential' THEN 'potential' ` +
  `     WHEN ${q.clientStatus} = 1        THEN 'active' ` +
  `     ELSE 'inactive' END`;

/* Deliberately NOT a second copy of the classifier in SQL. An earlier draft wrote
   the "is this street usable" rule twice — once here as a WHERE clause and once in
   ventas.js as a function — and they immediately disagreed, because the SQL
   version was never updated when the function learned that named landmarks count.
   2,657 rows is nothing to fetch, so the report fetches them and asks the one
   implementation. The report and the geocoder now cannot give different answers. */
const section = (title) => { if (!AS_JSON) console.log('\n' + title + '\n' + '-'.repeat(title.length)); };
const row = (label, value, note = '') => {
  if (AS_JSON) return;
  console.log('  ' + String(label).padEnd(46) + String(value).padStart(7) + (note ? '   ' + note : ''));
};

(async () => {
  const pool = mysql.createPool({ ...CONF, connectionLimit: 2, waitForConnections: true });
  const one = async (sql, params) => (await pool.query(sql, params))[0];
  const out = {};

  const C = q.clients, A = q.addresses;
  const join = `FROM ${C} c JOIN ${A} a ON a.${q.addrClientId} = c.${q.clientId}`;
  const leftJoin = `FROM ${C} c LEFT JOIN ${A} a ON a.${q.addrClientId} = c.${q.clientId}`;

  try {
    if (!AS_JSON) {
      console.log(`Address readiness report — ${CONF.database} on ${WHERE}`);
      console.log('Read-only: this script runs SELECTs and nothing else.');
    }

    /* ── 1. Scale ─────────────────────────────────────────────────────────── */
    section('How many stores, and do they all have an address row?');
    const [scale] = await one(
      `SELECT COUNT(*) AS clients,
              SUM(a.${q.addrId} IS NULL) AS without_address_row
       ${leftJoin}`);
    out.clients = Number(scale.clients);
    out.withoutAddressRow = Number(scale.without_address_row);
    row('stores in ' + C, out.clients);
    row('with no row in ' + A, out.withoutAddressRow,
        out.withoutAddressRow ? '<- cannot be pinned until one exists' : 'good');

    /* ── 2. Categories ────────────────────────────────────────────────────── */
    section('Categories the map can colour by, as they exist today');
    const cats = await one(`SELECT ${CATEGORY_SQL} AS category, COUNT(*) n ${leftJoin} GROUP BY category ORDER BY n DESC`);
    out.categories = {};
    for (const c of cats) { out.categories[c.category] = Number(c.n); row(c.category, c.n); }
    row('chain', 0, '<- no such category exists in the database');

    /* ── 3. Which address column is the real one ──────────────────────────── */
    section('Two address columns disagree — which one is the map reading?');
    const [addr] = await one(
      `SELECT
         SUM(TRIM(COALESCE(c.c_address,'')) = '' AND TRIM(COALESCE(a.${q.street.slice(1,-1)},'')) = '') AS both_empty,
         SUM(TRIM(COALESCE(c.c_address,'')) = '' AND TRIM(COALESCE(a.${q.street.slice(1,-1)},'')) <> '') AS only_client_address,
         SUM(TRIM(COALESCE(c.c_address,'')) <> '' AND TRIM(COALESCE(a.${q.street.slice(1,-1)},'')) = '') AS only_clients_c_address,
         SUM(TRIM(COALESCE(c.c_address,'')) <> '' AND TRIM(COALESCE(a.${q.street.slice(1,-1)},'')) <> ''
             AND CAST(TRIM(c.c_address) AS BINARY) <=> CAST(TRIM(a.${q.street.slice(1,-1)}) AS BINARY)) AS agree,
         SUM(TRIM(COALESCE(c.c_address,'')) <> '' AND TRIM(COALESCE(a.${q.street.slice(1,-1)},'')) <> ''
             AND NOT (CAST(TRIM(c.c_address) AS BINARY) <=> CAST(TRIM(a.${q.street.slice(1,-1)}) AS BINARY))) AS conflict
       ${join}`);
    out.addressColumns = {
      bothEmpty: Number(addr.both_empty),
      onlyClientAddress: Number(addr.only_client_address),
      onlyClientsCAddress: Number(addr.only_clients_c_address),
      agree: Number(addr.agree),
      conflict: Number(addr.conflict),
    };
    row('only client_address.address has one', out.addressColumns.onlyClientAddress);
    row('only clients.c_address has one', out.addressColumns.onlyClientsCAddress);
    row('both, and they match exactly', out.addressColumns.agree);
    row('both, and they say different streets', out.addressColumns.conflict,
        out.addressColumns.conflict ? '<- somebody has to decide' : '');
    row('neither has one', out.addressColumns.bothEmpty);

    /* ── 4. Can these addresses be geocoded at all ────────────────────────── */
    section('Of the addresses themselves: what can be pinned?');
    const addrRows = await one(
      `SELECT ${q.street} AS street, ${q.city} AS city,
              ${q.state}  AS state,  ${q.country} AS country
         FROM ${A}`);
    const buckets = { street: 0, locality: 0, none: 0 };
    for (const r of addrRows) buckets[geocodability(r)]++;
    out.geocodable = {
      streetLevel: buckets.street,
      localityOnly: buckets.locality,
      unpinnable: buckets.none,
    };
    row('street + city  -> a real pin', out.geocodable.streetLevel);
    row('city only      -> a city-centre pin', out.geocodable.localityOnly,
        '<- pin lands on the town, not the shop');
    row('neither        -> cannot be pinned', out.geocodable.unpinnable,
        '<- do not send these to Google');

    const worthSending = out.geocodable.streetLevel + out.geocodable.localityOnly;
    row('addresses worth sending to Google', worthSending);

    /* Google Geocoding is billed per request at $5.00 per 1,000 (first 10k/month
       free on the standard $200 credit). Reported as a range because the second
       number is what a re-run of everything costs, and people are surprised by it
       exactly once. */
    const cost = n => '$' + (n / 1000 * 5).toFixed(2);
    row('one-off cost at $5.00/1,000 requests', cost(worthSending));
    row('cost if all ' + out.clients + ' were sent blindly', cost(out.clients),
        '<- what NOT measuring first costs');

    /* ── 5. The duplicates that look like chains ──────────────────────────── */
    section('Candidates for a "Chain" category, if that is what it means');
    const dupNames = await one(
      `SELECT c.${q.clientName.slice(1,-1)} AS name, COUNT(*) n
       FROM ${C} c GROUP BY name HAVING n > 1 ORDER BY n DESC LIMIT 5`);
    const [dupTotal] = await one(
      `SELECT COUNT(*) groups_, COALESCE(SUM(n),0) rows_ FROM (
         SELECT COUNT(*) n FROM ${C} GROUP BY ${q.clientName} HAVING n > 1) t`);
    out.duplicateNameGroups = Number(dupTotal.groups_);
    out.clientsSharingAName = Number(dupTotal.rows_);
    row('groups of stores sharing a name', out.duplicateNameGroups);
    row('stores inside those groups', out.clientsSharingAName);
    if (!AS_JSON) for (const d of dupNames) console.log('      ' + d.n + '  x  ' + d.name);

    /* ── 6. What the geocoder would actually be sent ──────────────────────── */
    section('Three real composed addresses, exactly as they would be sent');
    const samples = addrRows.filter(r => geocodability(r) === 'street').slice(0, 3);
    if (!AS_JSON) for (const s of samples) console.log('      ' + composeAddress(s));

    /* ── 7. The rows that are not in Colombia ─────────────────────────────── */
    section('Stores outside Colombia that the country column calls Colombian');
    const intl = addrRows.filter(r => String(r.state || '').trim().toLowerCase() === 'internacional');
    out.international = intl.length;
    row('rows marked state_name = "Internacional"', intl.length,
        intl.length ? '<- country_name says Colombia on all of them' : '');
    if (!AS_JSON) {
      const where = [...new Set(intl.map(r => String(r.city || '').trim()))].filter(Boolean);
      if (where.length) console.log('      actually in: ' + where.join(', '));
    }

    if (!AS_JSON) {
      section('What this report does not tell you');
      console.log('  How many of those ' + worthSending + ' addresses Google can actually find.');
      console.log('  Colombian addresses are written cadastrally ("CR 70 C 55 33"), which');
      console.log('  geocodes far less reliably than a European street address. The honest');
      console.log('  way to find out is to send a random 50 and count, which costs $0.25.');
      console.log('  That number decides whether the other ' + (worthSending - 50) + ' are worth sending.');
    } else {
      console.log(JSON.stringify(out, null, 2));
    }
  } finally {
    await pool.end();
  }
})().catch(e => { console.error(e.message); process.exit(1); });

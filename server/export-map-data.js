'use strict';
/* Turn the geocoded rows into the JSON the map page eats.
 *
 *   node server/export-map-data.js --port 13307 --db ventas > ../map-data.json
 *
 * Deliberately writes to STDOUT and never into the repo: the output carries store
 * names and addresses, which are the client's data, not mine to publish.
 *
 * The category is derived here rather than in the browser, because it is a
 * business rule and it has to be the same rule the map, the legend and the CSV
 * export all use. Today it is two columns:
 *
 *   clients.type   ENUM('store','potential')
 *   clients.c_status  1 = active, 0 = not
 *
 * 'Chain' is NOT derived here. There is no column for it; it was going to come
 * from a spreadsheet the client is still cleaning up. Inventing a rule for it
 * would put stores in a bucket nobody agreed on, so the third category simply
 * does not exist yet — better an honest two than a wrong three.
 */
const mysql = require('mysql2/promise');
const { ventasSchema, composeAddressSql, pinLooksWrong } = require('./ventas');

const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

/** One row -> one category id. Kept tiny and pure so the tests can call it. */
function categoryOf(row) {
  if (row.type === 'store') return Number(row.status) === 1 ? 'active' : 'inactive';
  return 'potential';
}

async function main() {
  const { q } = ventasSchema();
  const pool = mysql.createPool({
    host: arg('host', '127.0.0.1'), port: Number(arg('port', 13307)),
    user: arg('user', 'root'), password: arg('password', ''),
    database: arg('db', 'ventas'), connectionLimit: 2,
  });

  /* Only rows that have a pin. A store with no coordinates is not "at 0,0" - it is
     absent from the map, and it belongs on the not-placed list instead. */
  const [rows] = await pool.query(
    `SELECT c.${q.clientId} AS id, c.${q.clientName} AS name,
            c.${q.clientType} AS type, c.${q.clientStatus} AS status,
            a.${q.latitude} AS lat, a.${q.longitude} AS lng,
            a.${q.precision} AS prec, a.${q.source} AS src,
            a.${q.city} AS city, a.${q.state} AS state,
            ${composeAddressSql(q)} AS addr
       FROM ${q.clients} c
       JOIN ${q.addresses} a ON a.${q.addrClientId} = c.${q.clientId}
      WHERE a.${q.latitude} IS NOT NULL AND a.${q.longitude} IS NOT NULL`);

  const [[missing]] = await pool.query(
    `SELECT COUNT(*) AS n FROM ${q.addresses} WHERE ${q.latitude} IS NULL`);
  await pool.end();

  const stores = rows.map(r => ({
    id: r.id,
    name: r.name,
    cat: categoryOf(r),
    lat: Number(r.lat),
    lng: Number(r.lng),
    prec: r.prec,
    src: r.src,
    city: r.city,
    state: r.state,
    addr: r.addr,
    // The pin is in a country the row does not claim. Google's own confidence does
    // not catch these, so the flag has to travel with the data.
    wrong: pinLooksWrong({ lat: Number(r.lat), lng: Number(r.lng), state: r.state }) || undefined,
  }));

  const payload = JSON.stringify({
    generated: 'geocoding run of 1-Sep-2026',
    pinned: stores.length,
    notPlaced: missing.n,
    stores,
  });

  /* --js writes what the page's <script src="map-data.js"> expects. A page opened
     from file:// cannot fetch() a JSON file next to it - the browser calls that a
     cross-origin request and blocks it - so the data has to arrive as a script. */
  process.stdout.write(process.argv.includes('--js')
    ? `window.__STORE_DATA__ = ${payload};\n`
    : payload);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });

module.exports = { categoryOf };

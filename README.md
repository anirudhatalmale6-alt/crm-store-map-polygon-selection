# CRM Store Map — polygon selection demo

Working demo for the store map + area-selection feature: stores from the CRM shown as
markers, coloured by category, with a polygon tool that selects everything inside it.

## Run it

Open `store-map-demo.html` in a browser. Nothing to install.

It starts in **offline preview** — a schematic basemap so you can click through the whole
feature with zero setup. Paste your Google Maps JavaScript API key in the top bar and hit
**Load Google Maps** to run the same thing on the real basemap.

The selection engine is identical in both modes; only the tiles change.

## What to try

1. **Draw polygon** → click 3+ points on the map → **Finish polygon**.
   The right panel lists every store inside, live.
2. **Add a store** in the left panel (the CRM simulator) with coordinates inside your
   polygon — it appears on the map and joins the selection immediately.
3. **×** next to any selected store deletes it from the CRM — the marker disappears.
4. Untick a category — those markers and list rows drop out.
5. **Export CSV** downloads the current selection.

## Tests

```
node test-selection.js        # 14 assertions on the selection engine
python3 test_ui.py            # 16 assertions driving the real browser + screenshots
node server/test_geocoder.js  # 16 assertions on the geocoder (stubbed fetch, no cost)
node server/test_api.js       # 32 assertions: real Express + real MySQL + real HTTP
```

`test_ui.py` and `test_api.js` both re-implement point-in-polygon independently and assert
the result matches — so they fail if the UI, the API and the engine ever disagree. Every
suite includes control positives, so an empty result can't be mistaken for a passing filter.

Screenshots land in `shots/`.

### Running the API tests

They need a MySQL on `127.0.0.1:13306` with a migrated `crmtest` database. A throwaway one:

```sh
D=$(mktemp -d)
mysqld --no-defaults --initialize-insecure --datadir=$D/data --basedir=/usr --log-error=$D/init.log
mysqld --no-defaults --datadir=$D/data --basedir=/usr --port=13306 \
       --socket=$D/s.sock --mysqlx=0 --log-error=$D/server.log &
mysql --no-defaults -h 127.0.0.1 -P 13306 -u root -e "CREATE DATABASE crmtest"
mysql --no-defaults -h 127.0.0.1 -P 13306 -u root crmtest < server/migrations/000_stores_table_for_testing.sql
mysql --no-defaults -h 127.0.0.1 -P 13306 -u root crmtest < server/migrations/001_add_store_location.sql
npm install && node server/test_api.js
```

Migration 001 is the one that runs on your VPS; 000 only stands in for the `stores` table
you already have, so the migration can be proven against a real MySQL 8 before it touches
your database.

## How this maps onto your stack

Your CRM: React + TypeScript front end, Node + Express back end, MySQL, VPS on Hostinger.

### 1. Store location fields — `server/migrations/001_add_store_location.sql`

Written for MySQL 8 and **verified against a real MySQL 8.0.45 server**, not just written
out. `DOUBLE`, not `FLOAT`: float carries ~7 significant digits, which rounds a coordinate
to 1–2 metres and visibly shifts markers.

The `geocoded_at` column matters: it lets us geocode an address **once** and reuse the
result forever. Geocoding on every page load would put your Google bill on a meter for no
reason.

### 2. API endpoints (Express) — `server/stores.routes.js`

| Method | Route | Purpose |
|---|---|---|
| `GET`  | `/api/stores?bbox=...` | stores for the current viewport, with lat/lng + category |
| `PATCH`| `/api/stores/:id/location` | save corrected coordinates |
| `POST` | `/api/stores/:id/geocode` | address → lat/lng, cached in `geocoded_at` |
| `POST` | `/api/stores/in-polygon` | body: polygon vertices → the stores inside |

The router takes a `db` with `query(sql, params)` — exactly what `mysql2/promise` gives you:

```js
const pool = mysql.createPool({ /* your CRM credentials */ });
const db   = { query: async (sql, p) => (await pool.query(sql, p))[0] };
const geocode = require('./server/geocoder')({ apiKey: process.env.GOOGLE_MAPS_KEY, region: 'es' });

app.use('/api/stores', require('./server/stores.routes')({ db, geocode }));
```

`in-polygon` narrows with a bounding box in SQL first (an index range scan on
`stores_latlng_idx` — asserted in the tests via `EXPLAIN`), then runs the exact
ray-casting test on that much smaller set. A bounding box alone is not enough: for a
concave polygon it over-selects, which the test suite proves with a C-shaped polygon
whose notch contains a store.

### 3. Why the selection engine is a plain function

`pointInPolygon` in the demo deliberately does **not** use `google.maps.geometry`. The same
function runs unchanged in Express, so once your store count outgrows "send them all to the
browser", the polygon query moves to the server (or straight into PostGIS with
`ST_Contains`) without the behaviour changing. Same code, same answers, tested once.

### 4. Sync

The three cases in the scope — added, removed, lat/lng updated — are all handled by the map
component reconciling against the store list it gets from the API, rather than by pushing
individual events at it. That's why the demo's marker layer diffs by store id: a store that
vanishes from the payload has its marker torn down, one that moved has its position set, and
a new one gets a marker created. No stale markers, no duplicate pins after an edit.

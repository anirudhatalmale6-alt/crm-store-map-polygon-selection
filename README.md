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
5. **Drag a pin** to correct where geocoding put it. It gets a dark centre dot and
   an **adjusted** badge, and **Undo move** appears in the left panel.
6. **Pins worth checking** filters to the ones Google placed imprecisely — the
   short list actually worth a person's time.
7. **Rename** a store in the second CRM panel — the pin does not move.
   Then **Change address** on the same store: the pin stays put and gets a pink
   ring and an **address changed** badge. **Re-geocode changed addresses**
   resolves them, except the hand-placed ones.
8. **Export CSV** downloads the current selection.

## Tests

```
node test-selection.js        # 23 assertions on the selection + clustering engines
python3 test_ui.py            # 75 assertions driving the real browser + screenshots
python3 test_gmaps_surface.py # 20 assertions on the GOOGLE surface, with no API key
node server/test_schema.js    # 42 assertions on the table/column config (no database)
node server/test_geocoder.js  # 26 assertions on the geocoder (stubbed fetch, no cost)
node server/test_api.js       # 89 assertions: real Express + real MySQL + real HTTP
node server/test_batch.js     # 53 assertions on the bulk geocoding run (real MySQL)
node server/test_ventas.js    # 60 assertions against YOUR schema and YOUR 2,657 rows
```

388 assertions. `test_ventas.js` is the one that matters most, because it is the
only suite whose inputs I did not choose — it runs over your actual data, and every
correction listed under "Your actual database, measured" below was forced by it.

`test_gmaps_surface.py` is the newest, and it exists because of a bug that all of the
others missed — see "The polygon tool was broken on the real map" below.

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
npm install && node server/test_api.js && node server/test_batch.js
```

`test_ventas.js` needs a database loaded from your dump instead:

```sh
mysql --no-defaults -h 127.0.0.1 -P 13307 -u root -e "CREATE DATABASE ventas"
mysql --no-defaults -h 127.0.0.1 -P 13307 -u root ventas < ventas_api.sql
mysql --no-defaults -h 127.0.0.1 -P 13307 -u root ventas \
  < server/migrations/002_ventas_client_address_location.sql
node server/test_ventas.js --port 13307 --db ventas
```

A second server on a second port, deliberately: running two suites that each hold
state against one database is how you get a failure that belongs to the other one.

Migration 001 is the one that runs on your VPS; 000 only stands in for the `stores` table
you already have, so the migration can be proven against a real MySQL 8 before it touches
your database.

## At your real scale: 2,000 stores

Your database holds roughly 2,000 stores in three categories (Active, Potential,
Chain). **Load 2,000 stores** in the left panel loads a stress set of that size so
the behaviour can be seen and measured rather than assumed.

Measured in Chromium at 1280×720, on the full 2,000:

| | |
|---|---|
| Selecting with a city-wide polygon | **0.4 ms** (1,856 stores selected) |
| Redrawing every pin after a change | **17.7 ms** |
| Shapes drawn, clustered vs one-per-store | **334 vs 2,000** |

So the polygon selection is not the problem at this size — it is thousands of times
faster than a single frame. Two things did need handling:

**Clustering.** 2,000 individual pins is unreadable (`shots/6-...png` — central
Madrid becomes a solid blob) and slow on Google Maps, which builds a DOM element
per marker. Nearby pins merge into a numbered bubble that splits apart as you zoom;
on Google Maps, clicking a bubble zooms to fit its members. A bubble is coloured by
category when everything in it shares one, and grey when it is mixed.

The clustering is a pure function like the selection engine, for the same reason:
the tests pin down that **every store lands in exactly one cluster, never dropped
and never double-counted**. A clustering bug that quietly loses a pin looks exactly
like "that store was never in the database", which is the kind of bug that gets
blamed on the data for weeks.

**The selected list is capped at 200 rows.** Selecting half the city would otherwise
mean 1,000 rows of DOM rebuilt on every change, and nobody reads row 700. The panel
says how many are hidden; Export CSV always writes the full selection.

## Correcting a pin by hand

Geocoding places most addresses correctly and some of them slightly wrong — a
building entrance on the wrong side of the block, a rural address landing on the
road rather than the yard. So pins can be corrected: **drag any single pin** and
it saves to the store. Cluster bubbles are not draggable, because "move these 40
stores" is not something anyone means; click one to zoom into it instead.

An adjusted pin gets a dark centre dot on the map and an **adjusted** badge in the
list, and the last move can be undone with one click — a drag is a mouse gesture
with no confirmation step, so an accidental one has to be reversible.

**The important part is in the database, not the UI.** A hand-placed pin is stored
with `location_source = 'manual'`, and `POST /api/stores/:id/geocode` refuses to
touch it:

| call | on a geocoded pin | on a stale geocoded pin | on a hand-adjusted pin |
|---|---|---|---|
| `POST /:id/geocode` | cached, no Google call | re-geocodes | `skipped: 'manual'` |
| `POST /:id/geocode?force=1` | re-geocodes | re-geocodes | `skipped: 'manual'` |
| `POST /:id/geocode?force=1&override_manual=1` | re-geocodes | re-geocodes | re-geocodes |

`force=1` means "we have coordinates, re-derive them from the address". It must not
*also* mean "discard the correction somebody made on purpose". Running a bulk
re-geocode over the whole table is a routine thing to do after cleaning up
addresses — and if that quietly undid every manual fix, nobody would find out
until a delivery went to the wrong street. Overriding is still possible, but you
have to ask for it by name.

The API tests cover both directions: that a manual pin survives `force=1`, and the
control positive that the same call still re-geocodes a machine-placed pin — so
"nothing happened" can't be mistaken for the guard working.

## Renaming a store, and changing its address

**Renaming a store does nothing to its pin.** The coordinates live on the store's
row and belong to its id, not to its name — rename it, change its category, change
its phone number, and the same pin stays exactly where it was, keeps its place in
any polygon selection, and keeps its marker on the map rather than being torn down
and rebuilt. Only `latitude` and `longitude` decide where a pin sits.

**Editing the address is the case that matters.** The pin does not follow the edit,
so without anything else it silently stays on the old street — and a wrong pin that
looks correct is worse than an obviously missing one.

So `location_address` records the address a pin was actually placed for, by Google
or by a person. When it stops matching the `address` column, that store is *stale*:
it gets a pink ring on the map, an **address changed** badge in the list, and a place
on `GET /api/stores/needs-review`.

| | |
|---|---|
| `location_address` is NULL | **not** stale — see below |
| matches `address` | not stale |
| differs from `address` | stale: the pin is on the old street |

The NULL row is the important one. Every store that existed before this column did
has `location_address` NULL, and "we never recorded it" must not be read as "it
changed" — otherwise switching this on marks all 2,000 stores stale and, on the
next bulk run, re-geocodes the entire table. Unknown is not the same as changed.

What happens next is a decision rather than a default:

- `POST /api/stores/:id/geocode` on a stale store **does** re-geocode it. That is
  not a policy, it is what a cache means: the stored coordinates answer a question
  about a different address, so there is nothing to serve.
- The bulk run leaves stale stores alone unless you pass `--refresh-changed`. An
  afternoon of tidying up addresses in the CRM should not turn into a Google bill
  as a side effect.
- A **hand-placed pin is never moved automatically**, stale or not. Somebody put it
  there deliberately, and only a person can say whether the store actually moved or
  the street name was just corrected. The bulk run reports how many of these there
  are instead of skipping them silently.
- An edited address that Google cannot resolve is marked `unresolved` against the
  address that failed, so it stops being asked about on every future run. It stays
  on the review list — as a bad address needing correction, which is a different job
  from a vague pin needing a drag.

The comparison rule lives in one file (`server/address.js`) because two things ask
it: the API in JavaScript, and the bulk geocoder in SQL. MySQL 8's default collation
is accent-insensitive, so a plain SQL string comparison calls `Gran Vía 34` and
`Gran Via 34` the same address while JavaScript calls them different — which would
mean the API reporting a store as stale that the batch never picks up. The SQL casts
to `BINARY`, and the test suite pushes exactly that accented pair through both paths
and asserts they agree.

## Your table is not called `stores`

Everything here is written against a table called `stores` with a column called
`category`, because that is a guess. **`server/schema.js` is the one file to
edit** — change the names there and the migration, all five endpoints, the bulk
geocoder and the tests all follow. Or set them without editing anything:

```sh
STORES_TABLE=tiendas STORES_CATEGORY_COL=categoria node server/print-migration.js
```

`print-migration.js` prints migration 001 with your names already filled in, so the
SQL you run and the SQL the API expects come from the same place. Hand-editing the
`.sql` to match your table is exactly how you end up with an API querying
`stores.latitude` against a database that has `tiendas.lat` — which fails at
runtime, in front of a user, rather than at migration time.

Table and column names can't be passed as query parameters, so they get
concatenated into the SQL. `schema.js` therefore validates every one of them
against a strict identifier pattern and **rejects** rather than sanitises: a
config typo should stop the process, not quietly query a different table. The test
suite feeds it backtick escapes, statement separators, qualified names and
over-length strings, and asserts each is refused.

The API and batch tests both run their whole flow a second time against a table
called `tiendas` with columns `id_tienda / nombre / categoria / direccion / lat /
lng / geo_at / origen / precision_geo` — so "it will fit your schema" is measured,
not hoped for.

## Your actual database, measured

Everything above this line was written before I had seen your schema. This section
is written after loading `ventas_api.sql` into a throwaway MySQL 8 and measuring
it. `server/ventas.js` holds the rules; `server/test_ventas.js` runs them against
the real rows.

### The shape is different from the demo's in three ways

| The demo assumed | Your database actually has |
|---|---|
| a `stores` table | stores are rows in **`clients`**, keyed by `cl_id` |
| an `address` column on it | the address is on **`client_address`**, one row per client |
| one address string | four columns: `address`, `city_name`, `state_name`, `country_name` |

`client_address` is strictly 1:1 with `clients` — 2,657 rows each, no client
without one, and a unique key `uq_client_address (client_id)` that keeps it that
way. **The location columns therefore go on `client_address`, not on `clients`.**
That is not a preference: a stale pin is detected by comparing the position
against the address it was placed for, and a same-row comparison cannot drift out
of step with a join.

`clients.c_address` also exists, but it is empty on 1,755 of 2,657 rows, so it
cannot be what the map reads. Where both columns hold something, they agree 868
times and **disagree 34 times** — different streets, not typos. Those 34 need a
human decision; nothing in the code guesses.

### Run the report yourself

```sh
DB_HOST=... DB_USER=... DB_PWD=... DB_NAME=... node server/readiness.js
```

Every statement in that file is a `SELECT`. It creates nothing, alters nothing and
writes nothing, so it is safe to point at production — which is the point, because
a report about a copy is a report about a copy. Output today:

```
  stores in `clients`                              2657
  with no row in `client_address`                     0   good

  potential                                        1487
  active                                           1132
  inactive                                           38
  chain                                               0   <- no such category exists

  street + city  -> a real pin                     2104
  city only      -> a city-centre pin               319
  neither        -> cannot be pinned                234   <- do not send these to Google
  one-off cost at $5.00/1,000 requests           $12.12
```

### The third category does not exist yet

You described three categories — Active, Potential, Chain. The first two are in
the data: `clients.type` is `ENUM('store','potential')` and `clients.c_status` is
0/1, which together give **active 1,132 / potential 1,487 / inactive 38**.

**There is no Chain anywhere** — not in the enum, not in the backend, not in the
frontend. I checked all three rather than assuming. So it has to be defined before
it can be coloured, and the obvious guesses do not survive contact with the data:

- *Stores sharing a tax ID?* Only 3 groups covering 6 clients. The 1,487 clients
  that appear to "share" a NIT all share the **empty string** — they are the
  potentials, which have no NIT yet.
- *Stores sharing a name?* 129 groups, 267 clients. `Droguería Colsubsidio` ×7,
  `Líneas Hospitalarias` ×4. This is the more plausible reading, but it also
  catches `Andres David Gomez Caro` ×2, who is a person entered twice.

Whichever rule you want is a one-line change in `readiness.js` and one more colour
in the legend. What I will not do is pick one and let the map imply it is a fact.

### 234 addresses cannot be pinned, and 232 of them are the same string

The unpinnable rows are not scattered bad data. They are:

| Count | `address` |
|---|---|
| 232 | `1503` |
| 1 | `Https://Instagram.Com/Branysu_Quiropedia` |
| 1 | *(empty)* |

`1503` is a sentinel someone used for "unknown". Excluding them is what makes the
difference between a bill for 2,657 lookups and a bill for 2,423 — small money
here, but the same discipline is what stops a re-run costing full price every time.

Getting that classifier right took three corrections, each caught by the suite
running over the real rows rather than over invented ones:

1. It first demanded a usable **city**, which threw away
   `Calle 45 C Bis # 23 -08 Barrio Palermo` for having `No identificada` in the
   city field. A good street and a known country is plenty.
2. It then demanded a **digit**, which threw away 172 named places —
   `Hospital Universitario San Jose Barrios Unidos`, `Centro Comercial El Tesoro`.
3. It then still discarded `Mocoa - Putumayo`, `Ciudad Jardin Norte`, `Kennedy`,
   `Quimbaya`, `Vichada` — real Colombian places sitting in the street field with
   an empty city. Those pin at town level, which beats not pinning them.

### 24 of your stores are not in Colombia

`country_name` says `Colombia` on all 2,657 rows. But 24 of them carry
`state_name = 'Internacional'`, with the **country** in `city_name`: Ecuador,
Chile, Costa Rica, Venezuela, Peru, Panamá, República Dominicana, Paraguay,
Nicaragua, China, Francia, Italia.

Appending `, Colombia` to `Via G. Buitoni 25, 52037 Sansepolcro, Italia` does not
fail. It succeeds, and returns a pin in Colombia. A wrong pin that looks right is
the expensive kind, so `composeAddress()` keys off your own `Internacional` marker
and drops the country column on those rows.

### One rule, two languages, checked on all 2,657 rows

The address that gets geocoded has to be assembled from four columns. The API
assembles it in JavaScript; the batch geocoder needs it in SQL to build its
candidate set without fetching every row. Two implementations of one rule drift —
so `test_ventas.js` runs **both over every row in the database and compares them
byte for byte**.

That test is not ceremony. Your columns are `utf8mb4_general_ci`, which is
accent-insensitive: plain SQL says `Medellín = Medellin` while JavaScript says they
differ. Left alone, SQL would de-duplicate a city/state pair that JavaScript keeps,
the two composed strings would differ by one part, and every such row would look
permanently stale — re-geocoded on every run, forever, for nothing. Every
comparison in the SQL is wrapped in `CAST(... AS BINARY)` for that reason.

The same test also caught a subtler one: an early version collapsed runs of
internal whitespace in JavaScript, which SQL's `TRIM` does not do. `CL 108  80 60`
composed one way in the API and another in the batch. The collapsing is gone —
agreement matters more than tidiness, and the geocoder does not care about double
spaces.

### Migration 002

```sh
mysql -u <user> -p <db> < server/migrations/002_ventas_client_address_location.sql
```

Same six columns as 001, pointed at `client_address`. Generated, not hand-written:

```sh
STORES_TABLE=client_address STORES_ID_COL=ca_id STORES_NAME_COL=address \
STORES_CATEGORY_COL=city_name STORES_ADDRESS_COL=address \
  node server/print-migration.js > server/migrations/002_ventas_client_address_location.sql
STORES_TABLE=client_address STORES_ID_COL=ca_id STORES_NAME_COL=address \
STORES_CATEGORY_COL=city_name STORES_ADDRESS_COL=address \
  node server/print-migration.js --rollback | sed 's/^/-- /' \
  >> server/migrations/002_ventas_client_address_location.sql
```

`test_schema.js` compares the committed file against what the generator produces
right now, and fails with that command in the message if they differ. Both 001 and
002 get this, because a generated file that is committed **will** drift from its
generator, and the tests build their database from the committed file — so the
suite and the test database agree with each other and both disagree with the code.
Everything green, broken on your server.

It has been applied to a copy of your real `client_address` table (all 2,657 rows)
on MySQL 8.0.45, and the columns and index verified afterwards with `SHOW COLUMNS`
and `SHOW INDEX`. Still run it on staging first — a branch cannot undo a schema
change.

### Notes for whoever reviews the PR

Five separate code paths write `client_address`: `addClient`, `updateClient`,
the Excel importer, the Siigo sync in `inngest/functions.js`, and
`orderControllers.js`. **None of them needs to change.** Staleness is detected by
comparing the stored `location_address` against the current address, so whichever
path edits the address, the map notices — rather than five hooks, one of which
someone forgets.

## Geocoding 2,000 addresses

`server/geocode-batch.js` does the bulk run. It is built around the assumption that
it will be interrupted:

```sh
node server/geocode-batch.js --dry-run       # costs nothing, tells you the size
node server/geocode-batch.js --limit 100     # do 100 for real, check the bill
node server/geocode-batch.js --limit 2000
```

- **`--limit` defaults to 100 and caps at 5,000.** A loop over a table you thought
  had 2,000 rows, that turns out to have 200,000, should not be something you find
  out about from an invoice.
- **Re-runnable.** It only picks up rows that still need doing, so quota errors,
  a dropped connection or Ctrl-C cost you nothing — run it again.
- **An address Google can't resolve is stamped and then left alone**, so it is not
  paid for again on every future run. `--retry-failed` picks those back up once
  you have corrected the addresses.
- **`--refresh-changed` re-geocodes stores whose address was edited** after the pin
  was placed. Off by default, so editing addresses never spends money by itself.
- **It stops on the first quota or permission error** instead of burning through
  the rest of the batch failing identically.
- **It never touches a hand-corrected pin.**

### Running it against YOUR database — `server/geocode-ventas.js`

`geocode-batch.js` above is written against the demo's single `stores` table.
Your addresses live in `client_address`, and the string worth sending to Google is
four of its columns joined together. `server/geocode-ventas.js` points the same
engine at your schema:

```sh
node server/geocode-ventas.js --dry-run --limit 5000    # costs nothing
node server/geocode-ventas.js --limit 50                # 50 for real
node server/geocode-ventas.js --limit 2500 --qps 12     # the rest
```

It is the same engine on purpose. Every rule listed above — resumable, never
re-pays for a failure, never touches a hand-placed pin, stops dead on a quota
error — is covered by the 53 assertions in `test_batch.js`, and a second copy of
that logic written for your table would be a second set of bugs. What this file
adds is only what is specific to your data:

- **The address is composed, not read from one column.** `composeAddressSql()`
  builds it in SQL and `composeAddress()` builds it in JavaScript, and
  `test_ventas.js` runs all 2,657 of your rows through both and asserts they come
  out byte-identical. That matters beyond tidiness: the composed string is stored
  in `location_address`, so "has this address changed since we placed the pin"
  compares like with like. Compose it one way to select and another way to store,
  and every row reports as permanently stale — meaning a full re-geocode, of
  everything, on every run.
- **Rows nothing could place are never sent.** 234 of yours have no street and no
  usable city. A request that cannot succeed is billed the same as one that does,
  so they are marked for review instead — that is $1.17 that buys nothing.
- **`--dry-run` prices the run**, using the same skip rule the real run uses. On
  your data it reports `2423 of these would be sent to Google ≈ $12.12`.

### The key restriction that silently refused every request

Worth writing down, because it cost an afternoon and looked like a broken key.

The Geocoding key is correctly restricted **by IP address** — that is what a
server-side key should be restricted by. The allow-list had this machine's IPv4
address on it. Every request was still refused:

```
REQUEST_DENIED — This IP, site or mobile application is not authorized to use
this API key. Request received from IP address 2a01:4f8:c17:292c::1
```

That address is this same machine. It has an IPv4 address *and* an IPv6 address,
and Node prefers IPv6 when both resolve, so requests left by an address that was
never on the list. The key was fine and the restriction was fine.

The nasty part is that it is **intermittent**. Happy Eyeballs races the two
address families and takes whichever connects first, so the same command can
succeed and then fail. A batch of 2,400 paid requests that half-fails is worse
than one that fails outright, because the failures get written to the database as
"could not be geocoded" against addresses that are perfectly good.

Two fixes, and the run needs both:

- `server/egress.js` pins outbound connections to IPv4 — better than asking you to
  allow-list an address I can simply stop using. Both `ipv4first` *and*
  `setDefaultAutoSelectFamily(false)` are needed; ordering alone is not a
  guarantee, because Happy Eyeballs may take the winner of the race regardless.
- **A preflight.** One request against a known landmark before spending anything,
  so a refused key stops the run at $0.005 instead of at $12 and several hundred
  wrongly-condemned addresses. If it does fail, the error now repeats back the IP
  address Google actually saw, instead of telling you to check a key that is not
  what is wrong.

### Finding the ones that came out wrong

Google returns how confident it was about each address, and we store it in
`location_precision`. `ROOFTOP` means it found the building; `APPROXIMATE` means it
fell back to the town.

On the 2,000-store demo set, **157 pins (7.8%) come back imprecise**. That is the
difference between "check 2,000 pins" — which nobody does, so the wrong ones stay
wrong — and "check 157". `GET /api/stores/needs-review` returns exactly that list,
worst first. In the demo, **Pins worth checking** in the left panel filters to them
and draws them hollow, so they are findable on the map. Drag one and it becomes an
adjusted pin, permanently protected from the next re-geocode.

## How this maps onto your stack

Your CRM: React + TypeScript front end, Node + Express back end, MySQL, VPS on Hostinger.

### 1. Store location fields — `server/migrations/001_add_store_location.sql`

Written for MySQL 8 and **verified against a real MySQL 8.0.45 server**, not just written
out. `DOUBLE`, not `FLOAT`: float carries ~7 significant digits, which rounds a coordinate
to 1–2 metres and visibly shifts markers.

The `geocoded_at` column matters: it lets us geocode an address **once** and reuse the
result forever. Geocoding on every page load would put your Google bill on a meter for no
reason. `location_source` is what protects hand-corrected pins from a later bulk
re-geocode — see "Correcting a pin by hand" above. `location_address` is what makes
"somebody edited the address and the pin stayed behind" detectable instead of
invisible — see "Renaming a store, and changing its address".

`server/print-migration.js` generates this file, and `test_schema.js` asserts that
the checked-in `.sql` is exactly what the generator produces today. That check is
there because it has already caught a real mistake: a column definition changed in
the generator while the `.sql` on disk — the thing that actually runs against your
database — stayed as it was. Every test still passed, because the test databases are
built from the same stale file, so the suite and the database agreed with each other
and both disagreed with the code.

### 2. API endpoints (Express) — `server/stores.routes.js`

| Method | Route | Purpose |
|---|---|---|
| `GET`  | `/api/stores?bbox=...` | stores for the current viewport, with lat/lng + category |
| `PATCH`| `/api/stores/:id/location` | save corrected coordinates |
| `POST` | `/api/stores/:id/geocode` | address → lat/lng, cached in `geocoded_at` |
| `POST` | `/api/stores/in-polygon` | body: polygon vertices → the stores inside |
| `GET`  | `/api/stores/needs-review` | the pins worth a person's time, worst first |

`needs-review` splits its answer into four counts — `stale`, `unlocated`,
`unresolved`, `imprecise` — assigned by priority so they are disjoint and add up to
`count`. A store can easily be both stale and imprecise; counting it in both buckets
would give four numbers that don't sum to the fifth, which reads as a broken report
rather than one store with two problems. The test suite asserts the sum.

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

## The polygon tool was broken on the real map

Your screenshot showed the demo with the Google basemap loaded, pins on it, and the
header still reading **offline preview**. The badge was the visible end of a real
defect.

`GoogleSurface.init()` created a `google.maps.drawing.DrawingManager`. Google
**removed** DrawingManager in Maps JavaScript API v3.65. A removal is not a console
warning that can be ignored — the constructor throws, and the throw aborted the rest
of `init()`. Everything above the throw ran, so the map appeared and looked healthy.
Everything below it silently did not:

- the `idle` listener, so **clusters stopped re-computing when you zoomed**;
- the `polygoncomplete` handler, so **polygon drawing did not work at all** — which
  is milestone 4, the whole point of the feature;
- the two lines that flip the badge and the banner, which is the part you could see.

The pins in your screenshot came from unticking **Active** — that re-runs the render
independently, which is why the map looked like it was working.

**What changed.** Drawing is now done directly against the map: click each corner,
then **Finish polygon**; drag a corner afterwards and the selection updates as you
drag. That is the same gesture as the offline preview, instead of two different ones
depending on whether a key is loaded, and it drops the `libraries=drawing` request
from the API URL entirely.

One subtlety worth knowing, because it is the kind of thing that bites later: the
overlay is only rebuilt when the shape actually changes. Dragging a corner fires an
event that re-renders the map, and a redraw-every-time implementation would destroy
the very overlay your mouse is holding, halfway through the drag.

### Why no test caught it

Every browser test drove the offline preview. The Google surface needs an API key, a
key costs money and cannot live in a repository, so it was never exercised — and
"we cannot test this" had quietly turned into "this does not work".

`test_gmaps_surface.py` fixes that with a stub of `google.maps`: about sixty lines
implementing the handful of classes the demo uses. That runs the **real** `init()`,
the **real** render and the **real** drawing code in a real browser, with no key, no
network and no bill.

The load-bearing detail is what the stub leaves out. It implements only what Google
currently documents, so it has no `google.maps.drawing` — because Google has no
`google.maps.drawing`. Reach for a retired API again and the suite fails. A stub
built to match whatever the page happened to call would have passed against
DrawingManager too, and been worth nothing. I checked that it discriminates by
putting the old line back: the suite fails, and passes again when removed.

What it does **not** prove: that your key is valid, that your referrer restrictions
are right, or that Google's tiles render. Those need a real key on the real domain.

`google.maps.Marker` is also deprecated (since Feb 2024) in favour of
`AdvancedMarkerElement`. Google says it is *not* scheduled for removal, so it still
works — but DrawingManager was "deprecated" once too, so it is written down here
rather than left as a surprise.

## The full run, done — 2,423 pins

The sample below predicted this. Then the whole thing was run, so the numbers here
are counted rather than extrapolated. **$12.12, exactly what the dry run quoted.**

```
2657 address rows
  2423 pinned
  234 not placed (no street and no usable city - never sent to Google)

  ROOFTOP              1701  70.2%
  RANGE_INTERPOLATED    152   6.3%     exact enough to trust:  1853  76.5%
  APPROXIMATE           380  15.7%
  GEOMETRIC_CENTER      190   7.8%     wants a look:            570  23.5%
```

**Nothing failed.** No errors, and not one address came back empty — every single
one of the 2,423 sent got a result. The sample had predicted ~2,326 pins; the true
figure is 2,423, so it was slightly pessimistic. Exactness landed almost exactly
where predicted (76.5% measured against 78% predicted), which is the useful part:
the sampling method can be trusted next time before spending.

`node server/pin-audit.js` produces all of the below. It is read-only.

### Three pins landed in the wrong country, and precision did not catch one of them

This is the finding worth having.

```
1978    8.9625,-79.5407   GEOMETRIC_CENTER    Calidonia, avenida central españa, ... Colombia
2165   40.7355,-73.9923   RANGE_INTERPOLATED  AV 9 ... BARRIO SAN MARTIN RUBIO TACHIRA ... Colombia
3482   18.4335,-66.0478   APPROXIMATE         Barrio Obrero, Calle 7 # 22 D -26, ... Pasto, Nariño, Colombia
```

Panama City, **Manhattan**, and San Juan in Puerto Rico. Google matched a
Colombian address to a foreign place with a similar name — Calidonia is a district
of Panama City, Barrio Obrero is a neighbourhood of San Juan. Appending
", Colombia" does not prevent it.

The important part: **row 2165 came back `RANGE_INTERPOLATED`**, which reads as
confident, and it is in New York. A review list sorted by Google's own confidence
puts that pin near the bottom, where nobody looks. Confidence answers "did I find
a precise address" — not "did I find the right one".

So `pinLooksWrong()` in `ventas.js` checks the pin against the country the row
claims, independently of precision, and `test_ventas.js` asserts all three of
these are flagged.

⚠ And row 2165 is your own point in reverse: `San Martin, Tachira` is in
**Venezuela**, not Colombia, but the row is not marked `Internacional`. So
alongside the 24 marked international rows that may have the wrong country, there
is at least one unmarked row that genuinely is abroad.

⚠ The first version of that check used a single mainland box, and reported a
correct San Andrés pin as foreign. San Andrés y Providencia is 700 km off
Nicaragua and is Colombian; Malpelo is far out in the Pacific. A check that
"corrects" good data is worse than no check, so all three territories are in the
test, San Andrés as an explicit control that must **not** be flagged.

### The placeholder address, again — 421 rows

`1503` is not an address. It appears as the street on **421 of your 2,657 rows**,
and it splits in two:

- **232** have no usable city either, so they were never sent. That is $1.16 not
  spent on requests that could not succeed.
- **189** do name a city, so they got pinned — at that city's centre. Every one of
  them came back `APPROXIMATE`; **none** falsely claims to be precise, so they all
  land on the review list on their own. They are honest pins of a city, standing in
  for shops whose address nobody ever typed.

### 910 rows share a pin with another row — and mostly that is fine

315 coordinates carry more than one store, the largest being 38 stores on one
point in Cali (all of them `1503`). But **544 of those 910 rows are `ROOFTOP`** —
genuinely the same building: shopping centres, and several units at one street
number. That is real, not an artefact.

It does affect the map though: without clustering, thirty-eight markers stack into
what looks like one. The demo already clusters, which is why this is a note rather
than a problem.

## What Google can actually find: measured, not estimated

`readiness.js` can say an address is worth **sending**. It cannot say Google will
**find** it. Colombian addresses are cadastral (`CR 70 C 55 33`), not
street-name-and-number, and geocoders are measurably worse at those. So rather than
guess, `geocode-sample.js` sends a random sample and counts.

```sh
GOOGLE_KEY=... node server/geocode-sample.js --socket /var/run/mysqld/mysqld.sock \
    --db ventas --n 50 --save sample.json
node server/geocode-sample.js --regrade sample.json     # re-score, free
node server/geocode-sample.js --dry-run                 # see what would be sent, costs nothing
```

Read-only against your database: it writes no columns, so it is safe to point at
production and safe to run twice. Result on 50 of your real addresses, $0.25:

```
  exact (rooftop or interpolated)     39   78%
  approximate (right city, coarse)     9   18%
  WRONG PLACE (looks fine, isn't)      2    4%
  not found                            0    0%
  usable pins                         48   96%
```

96%, extrapolating to roughly **2,326 pins of the 2,423 sendable rows** for $12.12.
The cadastral-address worry was worth having and turned out not to matter.

**"Google returned a result" is not the number to report.** A geocoder answers
something for almost any input: hand it a string it cannot parse and it will return
the centre of the department with status `OK`. A pin in the wrong place looks
exactly like a pin in the right place, and is worse than a missing one because
nobody goes looking for it. So every result is checked against what was *asked* for
— country, then city — and graded on that, not on the HTTP status.

The two wrong ones are both **data**, not Google:

- `Calle 14 # 9 -93 Sogamoso Boyaca` with the city column set to Bogotá. Google
  returned Sogamoso, which is what the street text says. Google was right.
- `Cra 3 #15 A-24 Serrezuelita, Mosquera` came back in Funza, the next municipality.

### I got this measurement wrong first

The first run of that script reported **16% in the wrong place**. Six of those eight
were correct pins my own comparison had misread: it compared place names with `===`,
so `Bogota D.C.` did not match Google's `Bogotá`, and `Bogotá` did not match Google's
`Bogotá, D.C.`. Sending that number on would have told you your address data was
twice as bad as it is.

Names are now compared as token sets with the administrative noise words dropped, so
both reduce to `{bogota}`. Two further rules came out of the same review:

- On the `Internacional` rows the **country** is what somebody typed into the *city*
  column, so that is what it has to be checked against. Comparing "Ecuador" to
  Google's "Daule" scored correct Ecuadorian pins as failures.
- "The country column disagrees" is not a bad pin. That column reads Colombia on all
  2,657 rows, so it cannot disagree with anything meaningfully. Three sampled stores
  came back in Ecuador and Venezuela — correctly. That is now reported as
  information, not counted as a failure.

Because the run costs money and the grading rules turned out to be wrong, every raw
response is saved with `--save` and can be re-scored with `--regrade` for free. I am
not paying Google twice for answers I already have.

## Your other three points, measured

**Consumers with no address.** They are already excluded, and cannot be included:
`consumers` is a separate table of 8,017 rows whose columns are id, name, NIT, email,
phone, sales rep and site — there is no address column at all. The map reads
`clients`, so nothing needs skipping.

**Subsidiaries.** This is the one to look at, because today the database *cannot*
store one. `client_address` has a unique key on `client_id`, so one client has
exactly one address, enforced — 2,657 clients, 2,657 addresses, no exceptions. A
subsidiary can only exist as a **separate client row**, and that is what is
happening: 129 groups of clients share a name (267 clients), and 96 of those groups
sit at different street addresses, 39 of them in more than one city. `Droguería
Colsubsidio` is 7 clients at 7 addresses in 4 cities.

That works fine for the map — each branch is its own row with its own pin. It only
matters for what "Chain" means, and for one thing worth knowing: shared **NIT**
identifies only 3 groups (6 clients), so the tax ID is not currently how branches are
linked. Name is the only signal in the data today.

(Also worth a moment: 129 groups share a name accent-insensitively, but only 104
match byte for byte. The 25-group gap is the same business typed twice with different
accents or capitalisation — `Drogueria` and `Droguería`.)

**The 34 conflicting addresses.** These are not subsidiaries — they are one client
with two *columns* disagreeing, `clients.c_address` against
`client_address.address`. The pattern is clear once they are lined up: `c_address` is
cadastral shorthand with no punctuation (`CR 2 46 13`), and `client_address.address`
is typed by a human with the unit and the neighbourhood (`CR 2 # 46 - 13`,
`Cc el puente local 168 calle 10 12-184`). About 13 of the 34 are the same place
written two ways; the other 21 are genuinely different, and the second column is
consistently the commercial premises — `local 13`, `local 114`, `pasaje comercial`,
`cc bulevar niza` — while the first looks like the registered address of the person
or company. Your `siigo_sync` table (9,571 rows) is very likely where the first one
comes from.

For a **store map** you want where the shop is, which is `client_address` — the
column the location data is being added to. Still your call, but that is what the
data says, and the full list of 34 is one query away if you want to eyeball it.

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
node test-selection.js   # 14 assertions on the selection engine
python3 test_ui.py       # 16 assertions driving the real browser + screenshots
```

`test_ui.py` re-implements point-in-polygon independently and asserts the on-screen list
matches it exactly — so the test fails if the UI and the engine ever disagree. Both suites
include control positives, so an empty result can't be mistaken for a passing filter.

Screenshots land in `shots/`.

## How this maps onto your stack

Your CRM: React + TypeScript front end, Node + Express back end, VPS on Hostinger.

### 1. Store location fields

```sql
-- PostgreSQL
ALTER TABLE stores
  ADD COLUMN latitude  DOUBLE PRECISION,
  ADD COLUMN longitude DOUBLE PRECISION,
  ADD COLUMN geocoded_at TIMESTAMPTZ;

CREATE INDEX stores_latlng_idx ON stores (latitude, longitude);
```

(MySQL is the same with `DOUBLE` and `DATETIME` — tell me which one you're on and I'll
ship the exact migration.)

The `geocoded_at` column matters: it lets us geocode an address **once** and reuse the
result forever. Geocoding on every page load would put your Google bill on a meter for no
reason.

### 2. API endpoints (Express)

| Method | Route | Purpose |
|---|---|---|
| `GET`  | `/api/stores?bbox=...` | stores for the current viewport, with lat/lng + category |
| `PATCH`| `/api/stores/:id/location` | save corrected coordinates |
| `POST` | `/api/stores/:id/geocode` | address → lat/lng, cached in `geocoded_at` |
| `POST` | `/api/stores/in-polygon` | body: polygon vertices → the stores inside |

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

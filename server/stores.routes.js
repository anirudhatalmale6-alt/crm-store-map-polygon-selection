'use strict';
/* Express routes for the store map.
 *
 * Takes a `db` with an async query(sql, params) -> rows, which is exactly what
 * mysql2/promise gives you:
 *
 *   const mysql = require('mysql2/promise');
 *   const pool  = await mysql.createPool({ ... });
 *   const db    = { query: async (sql, p) => (await pool.query(sql, p))[0] };
 *   app.use('/api/stores', require('./stores.routes')({ db, geocode }));
 *
 * `geocode` is any async (address) -> {lat, lng, precision} | null. See geocoder.js.
 *
 * Table and column names come from schema.js — pass `schema` to override them.
 * No table or column name is hard-coded below.
 */
const express = require('express');
const { storesInPolygon, polygonBounds, parsePolygon } = require('./geo');
const { makeSchema } = require('./schema');
const { addressIsStale, staleSql } = require('./address');

/** rows come back with lat/lng as strings from some drivers; normalise once. */
function toStore(r) {
  return {
    id: r.id,
    name: r.name,
    category: r.category,
    address: r.address,
    lat: r.lat === null ? null : Number(r.lat),
    lng: r.lng === null ? null : Number(r.lng),
    locationSource: r.location_source || null,
    locationPrecision: r.location_precision || null,
    // The address this pin was actually placed for, and whether the store has
    // been given a different one since.
    locationAddress: r.location_address == null ? null : r.location_address,
    addressStale: addressIsStale(r.address, r.location_address),
  };
}

module.exports = function storeRoutes({ db, geocode, schema = makeSchema() }) {
  const router = express.Router();
  const { q, table, selectCols } = schema;

  /* GET /api/stores?bbox=minLng,minLat,maxLng,maxLat
     Stores with coordinates. bbox is optional; without it you get all of them. */
  router.get('/', async (req, res, next) => {
    try {
      let sql = `SELECT ${selectCols} FROM ${table}
                 WHERE ${q.latitude} IS NOT NULL AND ${q.longitude} IS NOT NULL`;
      const params = [];
      if (req.query.bbox) {
        const n = String(req.query.bbox).split(',').map(Number);
        if (n.length !== 4 || n.some(v => !Number.isFinite(v))) {
          return res.status(400).json({ error: 'bbox must be minLng,minLat,maxLng,maxLat' });
        }
        const [minLng, minLat, maxLng, maxLat] = n;
        sql += ` AND ${q.latitude} BETWEEN ? AND ? AND ${q.longitude} BETWEEN ? AND ?`;
        params.push(minLat, maxLat, minLng, maxLng);
      }
      const rows = await db.query(sql, params);
      res.json({ stores: rows.map(toStore) });
    } catch (e) { next(e); }
  });

  /* GET /api/stores/needs-review
     The stores worth checking by hand: Google itself said it was not sure where
     they are. Geocoding 2,000 addresses always leaves a tail of bad ones, and
     without this the only way to find them is to stare at 2,000 pins. */
  router.get('/needs-review', async (req, res, next) => {
    try {
      const stale = staleSql(q);
      const rows = await db.query(
        `SELECT ${selectCols} FROM ${table}
          WHERE ${stale}
             OR ${q.source} = 'unresolved'
             OR (${q.source} = 'geocoded'
                 AND ${q.precision} IN ('APPROXIMATE', 'GEOMETRIC_CENTER'))
             OR (${q.latitude} IS NULL AND ${q.geocodedAt} IS NOT NULL)
          ORDER BY ${stale} DESC,
                   ${q.precision} = 'APPROXIMATE' DESC,
                   ${q.id}`, []
      );
      const stores = rows.map(toStore);
      /* Buckets are assigned by priority, not by test, so that they are disjoint
         and stale + unlocated + imprecise === count. A store can easily be both
         stale and imprecise; counting it twice gives three numbers that do not add
         up to the fourth, which reads as a bug in the report rather than a store
         with two problems. The test suite asserts the sum. */
      const bucket = s => s.addressStale                     ? 'stale'
                        : s.lat === null                     ? 'unlocated'
                        : s.locationSource === 'unresolved'  ? 'unresolved'
                        :                                      'imprecise';
      const count = k => stores.filter(s => bucket(s) === k).length;
      res.json({
        stores,
        count: stores.length,
        /* Each number is a different job:
           stale      - the address was edited and the pin stayed behind
           unlocated  - tried, no result, and no pin at all to show
           unresolved - tried, no result, but there is an older pin still on the map
           imprecise  - Google placed it but said it was not sure where */
        stale:      count('stale'),
        unlocated:  count('unlocated'),
        unresolved: count('unresolved'),
        imprecise:  count('imprecise'),
      });
    } catch (e) { next(e); }
  });

  /* POST /api/stores/in-polygon   body: { polygon: [{lat,lng}, ...] }
     Bounding box narrows it in SQL (index range scan), then the exact
     ray-casting test runs on that much smaller set. */
  router.post('/in-polygon', async (req, res, next) => {
    try {
      const parsed = parsePolygon(req.body && req.body.polygon);
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });

      const b = polygonBounds(parsed.polygon);
      const rows = await db.query(
        `SELECT ${selectCols} FROM ${table}
          WHERE ${q.latitude} IS NOT NULL AND ${q.longitude} IS NOT NULL
            AND ${q.latitude} BETWEEN ? AND ? AND ${q.longitude} BETWEEN ? AND ?`,
        [b.minLat, b.maxLat, b.minLng, b.maxLng]
      );
      const inside = storesInPolygon(rows.map(toStore), parsed.polygon);
      res.json({ stores: inside, count: inside.length });
    } catch (e) { next(e); }
  });

  /* PATCH /api/stores/:id/location   body: { lat, lng }
     This is a person dragging a pin, so it stamps location_source='manual' and
     leaves geocoded_at alone. geocoded_at answers "when did Google last run";
     overwriting it here would make a hand-placed pin look machine-placed. */
  router.patch('/:id/location', async (req, res, next) => {
    try {
      const lat = Number(req.body && req.body.lat);
      const lng = Number(req.body && req.body.lng);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
        return res.status(400).json({ error: 'lat must be a number between -90 and 90' });
      }
      if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
        return res.status(400).json({ error: 'lng must be a number between -180 and 180' });
      }
      /* location_address is set from the row's own address column in the same
         statement — the position a person just chose is a position for the address
         the store has right now. Reading it first and writing it back would leave a
         window where an address edit lands in between and the pin gets recorded
         against an address nobody placed it for. */
      const r = await db.query(
        `UPDATE ${table} SET ${q.latitude} = ?, ${q.longitude} = ?,
                             ${q.source} = 'manual', ${q.precision} = NULL,
                             ${q.locationAddress} = ${q.address}
          WHERE ${q.id} = ?`,
        [lat, lng, req.params.id]
      );
      if (r && r.affectedRows === 0) return res.status(404).json({ error: 'store not found' });
      res.json({ id: req.params.id, lat, lng, locationSource: 'manual' });
    } catch (e) { next(e); }
  });

  /* POST /api/stores/:id/geocode
     Address -> coordinates, written back once. Already-geocoded stores are
     returned from the database untouched unless ?force=1, so a page refresh
     never costs a Google call. */
  router.post('/:id/geocode', async (req, res, next) => {
    try {
      const rows = await db.query(
        `SELECT ${selectCols}, ${q.geocodedAt} FROM ${table} WHERE ${q.id} = ?`,
        [req.params.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'store not found' });
      const store = toStore(rows[0]);

      const force = req.query.force === '1';

      /* A hand-placed pin outranks the geocoder, and force=1 does NOT override it.
         force=1 means "we have coordinates but re-derive them from the address";
         it must not also mean "discard the correction someone made on purpose".
         Running a bulk re-geocode over the whole table is a routine thing to do
         after cleaning up addresses - if that quietly undid every manual fix, the
         damage would only show up when somebody drove to the wrong place.
         Overriding is possible, but you have to ask for it by name. */
      if (store.locationSource === 'manual' && req.query.override_manual !== '1') {
        return res.json({ ...store, cached: true, skipped: 'manual' });
      }

      /* A cached result is only a cache if it answers the question being asked.
         These coordinates were derived from whatever address was in the row at the
         time; if somebody has edited the address since, we do not have the answer
         for the new one and returning the old pin as `cached: true` is a lie the
         map has no way to see through. Note this is cache correctness, not a
         policy about bulk re-geocoding - the bulk run is opt-in, see
         geocode-batch.js --refresh-changed. */
      if (!force && store.lat !== null && store.lng !== null && !store.addressStale) {
        return res.json({ ...store, cached: true });
      }
      if (!store.address) return res.status(422).json({ error: 'store has no address to geocode' });

      const hit = await geocode(store.address);
      if (!hit) {
        /* Record the failed attempt against the address that failed, so the store
           stops being stale and no future run pays to ask the same unanswerable
           question. It stays on the review list as 'unresolved', which is a
           different job from 'imprecise': this one needs a better address, not a
           dragged pin.

           EXCEPT on a hand-placed pin. Overwriting location_source there would
           throw away the fact that a person positioned it, and 'manual' is the only
           thing keeping the bulk geocoder off that row - a failed call would
           quietly remove the protection that the successful call was refused. A
           manual pin is left completely untouched; it costs nothing to leave it,
           because the batch never picks manual rows up on its own. */
        if (store.locationSource !== 'manual') {
          await db.query(
            `UPDATE ${table} SET ${q.geocodedAt} = NOW(), ${q.source} = 'unresolved',
                                 ${q.precision} = NULL, ${q.locationAddress} = ?
              WHERE ${q.id} = ?`,
            [store.address, store.id]
          );
        }
        return res.status(422).json({
          error: 'address could not be geocoded', id: store.id,
          locationSource: store.locationSource === 'manual' ? 'manual' : 'unresolved',
        });
      }

      await db.query(
        `UPDATE ${table} SET ${q.latitude} = ?, ${q.longitude} = ?,
                             ${q.geocodedAt} = NOW(), ${q.source} = 'geocoded',
                             ${q.precision} = ?, ${q.locationAddress} = ?
          WHERE ${q.id} = ?`,
        [hit.lat, hit.lng, hit.precision || null, store.address, store.id]
      );
      res.json({ ...store, lat: hit.lat, lng: hit.lng,
                 locationSource: 'geocoded', locationPrecision: hit.precision || null,
                 locationAddress: store.address, addressStale: false,
                 cached: false });
    } catch (e) { next(e); }
  });

  return router;
};

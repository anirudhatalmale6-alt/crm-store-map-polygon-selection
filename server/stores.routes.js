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
      const rows = await db.query(
        `SELECT ${selectCols} FROM ${table}
          WHERE ${q.source} = 'geocoded'
            AND (${q.precision} IN ('APPROXIMATE', 'GEOMETRIC_CENTER')
                 OR ${q.latitude} IS NULL)
          ORDER BY ${q.precision} = 'APPROXIMATE' DESC, ${q.id}`, []
      );
      const stores = rows.map(toStore);
      res.json({
        stores,
        count: stores.length,
        // Split out so the number is actionable: "no coordinates at all" needs a
        // better address, "approximate" needs someone to drag the pin.
        unlocated: stores.filter(s => s.lat === null).length,
        imprecise: stores.filter(s => s.lat !== null).length,
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
      const r = await db.query(
        `UPDATE ${table} SET ${q.latitude} = ?, ${q.longitude} = ?,
                             ${q.source} = 'manual', ${q.precision} = NULL
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

      if (!force && store.lat !== null && store.lng !== null) {
        return res.json({ ...store, cached: true });
      }
      if (!store.address) return res.status(422).json({ error: 'store has no address to geocode' });

      const hit = await geocode(store.address);
      if (!hit) return res.status(422).json({ error: 'address could not be geocoded' });

      await db.query(
        `UPDATE ${table} SET ${q.latitude} = ?, ${q.longitude} = ?,
                             ${q.geocodedAt} = NOW(), ${q.source} = 'geocoded',
                             ${q.precision} = ?
          WHERE ${q.id} = ?`,
        [hit.lat, hit.lng, hit.precision || null, store.id]
      );
      res.json({ ...store, lat: hit.lat, lng: hit.lng,
                 locationSource: 'geocoded', locationPrecision: hit.precision || null,
                 cached: false });
    } catch (e) { next(e); }
  });

  return router;
};

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
 * `geocode` is any async (address) -> {lat, lng} | null. See geocoder.js.
 */
const express = require('express');
const { storesInPolygon, polygonBounds, parsePolygon } = require('./geo');

const SELECT_COLS = 'id, name, category, latitude AS lat, longitude AS lng, address';

/** rows come back with lat/lng as strings from some drivers; normalise once. */
function toStore(r) {
  return {
    id: r.id,
    name: r.name,
    category: r.category,
    address: r.address,
    lat: r.lat === null ? null : Number(r.lat),
    lng: r.lng === null ? null : Number(r.lng),
  };
}

module.exports = function storeRoutes({ db, geocode }) {
  const router = express.Router();

  /* GET /api/stores?bbox=minLng,minLat,maxLng,maxLat
     Stores with coordinates. bbox is optional; without it you get all of them. */
  router.get('/', async (req, res, next) => {
    try {
      let sql = `SELECT ${SELECT_COLS} FROM stores
                 WHERE latitude IS NOT NULL AND longitude IS NOT NULL`;
      const params = [];
      if (req.query.bbox) {
        const n = String(req.query.bbox).split(',').map(Number);
        if (n.length !== 4 || n.some(v => !Number.isFinite(v))) {
          return res.status(400).json({ error: 'bbox must be minLng,minLat,maxLng,maxLat' });
        }
        const [minLng, minLat, maxLng, maxLat] = n;
        sql += ' AND latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?';
        params.push(minLat, maxLat, minLng, maxLng);
      }
      const rows = await db.query(sql, params);
      res.json({ stores: rows.map(toStore) });
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
        `SELECT ${SELECT_COLS} FROM stores
          WHERE latitude IS NOT NULL AND longitude IS NOT NULL
            AND latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?`,
        [b.minLat, b.maxLat, b.minLng, b.maxLng]
      );
      const inside = storesInPolygon(rows.map(toStore), parsed.polygon);
      res.json({ stores: inside, count: inside.length });
    } catch (e) { next(e); }
  });

  /* PATCH /api/stores/:id/location   body: { lat, lng } */
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
        'UPDATE stores SET latitude = ?, longitude = ?, geocoded_at = NOW() WHERE id = ?',
        [lat, lng, req.params.id]
      );
      if (r && r.affectedRows === 0) return res.status(404).json({ error: 'store not found' });
      res.json({ id: req.params.id, lat, lng });
    } catch (e) { next(e); }
  });

  /* POST /api/stores/:id/geocode
     Address -> coordinates, written back once. Already-geocoded stores are
     returned from the database untouched unless ?force=1, so a page refresh
     never costs a Google call. */
  router.post('/:id/geocode', async (req, res, next) => {
    try {
      const rows = await db.query(
        `SELECT ${SELECT_COLS}, geocoded_at FROM stores WHERE id = ?`, [req.params.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'store not found' });
      const store = toStore(rows[0]);

      const force = req.query.force === '1';
      if (!force && store.lat !== null && store.lng !== null) {
        return res.json({ ...store, cached: true });
      }
      if (!store.address) return res.status(422).json({ error: 'store has no address to geocode' });

      const hit = await geocode(store.address);
      if (!hit) return res.status(422).json({ error: 'address could not be geocoded' });

      await db.query(
        'UPDATE stores SET latitude = ?, longitude = ?, geocoded_at = NOW() WHERE id = ?',
        [hit.lat, hit.lng, store.id]
      );
      res.json({ ...store, lat: hit.lat, lng: hit.lng, cached: false });
    } catch (e) { next(e); }
  });

  return router;
};

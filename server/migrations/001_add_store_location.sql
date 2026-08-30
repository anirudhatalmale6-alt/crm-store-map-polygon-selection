-- Milestone 1: store location fields.  MySQL 8.
--
-- MySQL (unlike MariaDB) has no ADD COLUMN IF NOT EXISTS, so this is written to be
-- run once.  Check first with:
--   SHOW COLUMNS FROM stores LIKE 'latitude';
--
-- Adjust the table name if your stores table is not called `stores`.

ALTER TABLE stores
  ADD COLUMN latitude    DOUBLE   NULL COMMENT 'WGS84, -90..90',
  ADD COLUMN longitude   DOUBLE   NULL COMMENT 'WGS84, -180..180',
  ADD COLUMN geocoded_at DATETIME NULL COMMENT 'when lat/lng was last derived from the address';

-- Composite index so the bounding-box prefilter in POST /api/stores/in-polygon
-- is an index range scan instead of a full table scan.
CREATE INDEX stores_latlng_idx ON stores (latitude, longitude);

-- DOUBLE, not DECIMAL: 15-17 significant digits, which is far more precision than
-- any geocoder gives you.  FLOAT would NOT do - it carries ~7 digits, which rounds
-- a coordinate to roughly 1-2 metres of error and visibly shifts markers.
--
-- Deliberately NOT using MySQL's POINT/SPATIAL type. It would let MySQL do
-- ST_Contains server-side, but it needs SRID handling, a NOT NULL column for a
-- SPATIAL index, and it locks the polygon query into MySQL. Two plain DOUBLEs keep
-- the same selection code running in Node, in the browser, and in the database
-- later if you ever move to PostGIS. Easy to switch if you outgrow it.

-- Rollback:
--   DROP INDEX stores_latlng_idx ON stores;
--   ALTER TABLE stores DROP COLUMN latitude, DROP COLUMN longitude, DROP COLUMN geocoded_at;

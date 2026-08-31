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
  ADD COLUMN geocoded_at DATETIME NULL COMMENT 'when lat/lng was last derived from the address',
  ADD COLUMN location_source ENUM('geocoded','manual') NULL
      COMMENT 'manual = a person dragged this pin; geocoding must not overwrite it';

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

-- `location_source` exists because geocoding is never perfect and someone will
-- correct pins by hand.  Without this column a later bulk re-geocode -- exactly the
-- thing you run after cleaning up addresses -- silently overwrites every manual
-- correction, and nobody finds out until a driver is sent to the wrong street.
-- NULL means "never positioned", 'geocoded' means Google put it there, 'manual'
-- means a person did and it is protected.

-- Rollback:
--   DROP INDEX stores_latlng_idx ON stores;
--   ALTER TABLE stores DROP COLUMN latitude, DROP COLUMN longitude,
--                      DROP COLUMN geocoded_at, DROP COLUMN location_source;

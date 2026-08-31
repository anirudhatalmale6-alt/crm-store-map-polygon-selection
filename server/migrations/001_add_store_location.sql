-- Milestone 1: store location fields.  MySQL 8.
-- Generated from schema.js — do not hand-edit; change the names there instead.
--
-- MySQL (unlike MariaDB) has no ADD COLUMN IF NOT EXISTS, so this runs ONCE.
-- Check first with:
--   SHOW COLUMNS FROM `stores` LIKE 'lat%';
--
-- Run it on STAGING first. A branch cannot undo a schema change.

ALTER TABLE `stores`
  ADD COLUMN `latitude`   DOUBLE   NULL COMMENT 'WGS84, -90..90',
  ADD COLUMN `longitude`  DOUBLE   NULL COMMENT 'WGS84, -180..180',
  ADD COLUMN `geocoded_at` DATETIME NULL COMMENT 'when lat/lng was last derived from the address',
  ADD COLUMN `location_source`     ENUM('geocoded','manual') NULL
      COMMENT 'manual = a person dragged this pin; geocoding must not overwrite it',
  ADD COLUMN `location_precision`  VARCHAR(24) NULL
      COMMENT 'Google location_type: ROOFTOP / RANGE_INTERPOLATED / GEOMETRIC_CENTER / APPROXIMATE';

-- Composite index so the bounding-box prefilter in POST /api/stores/in-polygon
-- is an index range scan instead of a full table scan.
CREATE INDEX `stores_latlng_idx` ON `stores` (`latitude`, `longitude`);

-- DOUBLE, not DECIMAL: 15-17 significant digits, far more than any geocoder gives.
-- FLOAT would NOT do - ~7 digits rounds a coordinate to 1-2 metres of error and
-- visibly shifts markers.
--
-- Deliberately NOT MySQL's POINT/SPATIAL type. It would let MySQL do ST_Contains
-- server-side, but it needs SRID handling and a NOT NULL column for a SPATIAL
-- index, and it locks the polygon query into MySQL. Two plain DOUBLEs keep the
-- same selection code running in Node, in the browser, and in PostGIS later.
--
-- `location_source` is what protects hand-corrected pins from a later bulk re-geocode.
-- `location_precision` is Google's own confidence, which is how you find the pins worth
-- checking without staring at all of them.

-- -- Rollback for `stores`
-- DROP INDEX `stores_latlng_idx` ON `stores`;
-- ALTER TABLE `stores`
--   DROP COLUMN `latitude`,
--   DROP COLUMN `longitude`,
--   DROP COLUMN `geocoded_at`,
--   DROP COLUMN `location_source`,
--   DROP COLUMN `location_precision`;

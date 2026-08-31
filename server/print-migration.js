'use strict';
/* Prints migration 001 with YOUR table and column names filled in.
 *
 *   node server/print-migration.js
 *   STORES_TABLE=tiendas STORES_CATEGORY_COL=categoria node server/print-migration.js
 *   node server/print-migration.js > 001-for-our-crm.sql
 *
 * The point is that the SQL you run and the SQL the API expects come from the same
 * place (schema.js). Hand-editing the .sql file to match your table is exactly how
 * you end up with an API querying `stores.latitude` and a database that has
 * `tiendas.lat` — which fails at runtime, not at migration time.
 *
 * Add --rollback for the undo script.
 */
const { makeSchema } = require('./schema');

const { q, table, indexName } = makeSchema();
const rollback = process.argv.includes('--rollback');

if (rollback) {
  console.log(`-- Rollback for ${table}
DROP INDEX \`${indexName}\` ON ${table};
ALTER TABLE ${table}
  DROP COLUMN ${q.latitude},
  DROP COLUMN ${q.longitude},
  DROP COLUMN ${q.geocodedAt},
  DROP COLUMN ${q.source},
  DROP COLUMN ${q.precision};`);
  process.exit(0);
}

console.log(`-- Milestone 1: store location fields.  MySQL 8.
-- Generated from schema.js — do not hand-edit; change the names there instead.
--
-- MySQL (unlike MariaDB) has no ADD COLUMN IF NOT EXISTS, so this runs ONCE.
-- Check first with:
--   SHOW COLUMNS FROM ${table} LIKE 'lat%';
--
-- Run it on STAGING first. A branch cannot undo a schema change.

ALTER TABLE ${table}
  ADD COLUMN ${q.latitude}   DOUBLE   NULL COMMENT 'WGS84, -90..90',
  ADD COLUMN ${q.longitude}  DOUBLE   NULL COMMENT 'WGS84, -180..180',
  ADD COLUMN ${q.geocodedAt} DATETIME NULL COMMENT 'when lat/lng was last derived from the address',
  ADD COLUMN ${q.source}     ENUM('geocoded','manual') NULL
      COMMENT 'manual = a person dragged this pin; geocoding must not overwrite it',
  ADD COLUMN ${q.precision}  VARCHAR(24) NULL
      COMMENT 'Google location_type: ROOFTOP / RANGE_INTERPOLATED / GEOMETRIC_CENTER / APPROXIMATE';

-- Composite index so the bounding-box prefilter in POST /api/stores/in-polygon
-- is an index range scan instead of a full table scan.
CREATE INDEX \`${indexName}\` ON ${table} (${q.latitude}, ${q.longitude});

-- DOUBLE, not DECIMAL: 15-17 significant digits, far more than any geocoder gives.
-- FLOAT would NOT do - ~7 digits rounds a coordinate to 1-2 metres of error and
-- visibly shifts markers.
--
-- Deliberately NOT MySQL's POINT/SPATIAL type. It would let MySQL do ST_Contains
-- server-side, but it needs SRID handling and a NOT NULL column for a SPATIAL
-- index, and it locks the polygon query into MySQL. Two plain DOUBLEs keep the
-- same selection code running in Node, in the browser, and in PostGIS later.
--
-- ${q.source} is what protects hand-corrected pins from a later bulk re-geocode.
-- ${q.precision} is Google's own confidence, which is how you find the pins worth
-- checking without staring at all of them.`);

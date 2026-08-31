'use strict';
/* "Is this pin still the pin for this address?" — one rule, written once.
 *
 * Two places need to ask it. The API asks in JavaScript, about a row it has
 * already fetched. The bulk geocoder asks in SQL, about rows it has not fetched
 * yet and does not want to. If those two rules ever disagree, the batch silently
 * skips stores the API is reporting as out of date, which looks exactly like the
 * detection not working at all.
 */

/**
 * True when a store's coordinates were derived from a different address than the
 * one the row holds now — i.e. somebody edited the address and the pin did not
 * follow.
 */
function addressIsStale(currentAddress, locationAddress) {
  /* NULL means "we never recorded which address this position came from". That is
     every row geocoded before this column existed. Unknown is NOT the same as
     changed: treating it as changed would mark the entire table stale and, if the
     bulk run is set to refresh stale rows, re-geocode all 2,000 of them. That is a
     bill, not a fix. */
  if (locationAddress == null || currentAddress == null) return false;
  return String(currentAddress) !== String(locationAddress);
}

/**
 * The same rule as SQL, for building a candidate set without fetching the rows.
 *
 * CAST(... AS BINARY) is doing real work here. MySQL 8's default collation
 * (utf8mb4_0900_ai_ci) is both case- AND accent-insensitive, so a plain
 * `addr <=> located_addr` reports 'Gran Vía 34' and 'Gran Via 34' as the same
 * string, while the JavaScript above reports them as different. Casting to BINARY
 * compares bytes and so cannot drift with the column's collation. The test suite
 * feeds exactly that accented pair through both paths and asserts they agree.
 */
function staleSql(q) {
  return `(${q.locationAddress} IS NOT NULL AND ${q.address} IS NOT NULL
           AND NOT (CAST(${q.address} AS BINARY) <=> CAST(${q.locationAddress} AS BINARY)))`;
}

module.exports = { addressIsStale, staleSql };

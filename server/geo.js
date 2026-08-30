'use strict';
/* Selection geometry. No Google dependency, no database dependency — the same
   functions run in the browser and in Express. */

/** Ray-casting point-in-polygon. polygon = [{lat,lng}, ...] (unclosed is fine). */
function pointInPolygon(pt, polygon) {
  if (!polygon || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lng, yi = polygon[i].lat;
    const xj = polygon[j].lng, yj = polygon[j].lat;
    const straddles = (yi > pt.lat) !== (yj > pt.lat);
    if (straddles && pt.lng < ((xj - xi) * (pt.lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function storesInPolygon(stores, polygon) {
  return stores.filter(s => pointInPolygon(s, polygon));
}

/** Bounding box of a polygon — used to prefilter in SQL before the exact test. */
function polygonBounds(polygon) {
  if (!polygon || !polygon.length) return null;
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const p of polygon) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  return { minLat, maxLat, minLng, maxLng };
}

/** Validates a polygon coming off the wire. Returns {ok, polygon} or {ok:false, error}. */
function parsePolygon(input) {
  if (!Array.isArray(input)) return { ok: false, error: 'polygon must be an array' };
  if (input.length < 3) return { ok: false, error: 'polygon needs at least 3 points' };
  if (input.length > 500) return { ok: false, error: 'polygon has too many points (max 500)' };
  const polygon = [];
  for (const p of input) {
    const lat = Number(p && p.lat), lng = Number(p && p.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return { ok: false, error: 'every point needs numeric lat and lng' };
    }
    if (lat < -90 || lat > 90)   return { ok: false, error: `latitude out of range: ${lat}` };
    if (lng < -180 || lng > 180) return { ok: false, error: `longitude out of range: ${lng}` };
    polygon.push({ lat, lng });
  }
  return { ok: true, polygon };
}

module.exports = { pointInPolygon, storesInPolygon, polygonBounds, parsePolygon };

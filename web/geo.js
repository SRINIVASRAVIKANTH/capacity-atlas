/* Distance math for the site check: how far a spot is from a line, and which line is nearest.
 *
 * Plain functions with no map code, so they are tested on their own (tests/js/geo.test.mjs).
 * Points are [longitude, latitude]. Distances are straight-line kilometres on the ground.
 */
/* global module */
(function (root) {
  "use strict";

  const KM_PER_MILE = 1.609344;

  // Length of one degree of latitude and longitude at a given latitude (WGS84 ellipsoid).
  function kmPerDegree(lat) {
    const r = (lat * Math.PI) / 180;
    return [111.41513 * Math.cos(r) - 0.09455 * Math.cos(3 * r), 111.13209 - 0.56605 * Math.cos(2 * r)];
  }

  // A flat map centred on `origin`, in kilometres. Within 100 km of the origin the error is
  // under 0.5%, which is plenty for "how far is the nearest line".
  function toLocalKm(origin, point) {
    const [kx, ky] = kmPerDegree(origin[1]);
    return [(point[0] - origin[0]) * kx, (point[1] - origin[1]) * ky];
  }

  function fromLocalKm(origin, xy) {
    const [kx, ky] = kmPerDegree(origin[1]);
    return [origin[0] + xy[0] / kx, origin[1] + xy[1] / ky];
  }

  // Closest point to the origin (0, 0) on the segment a-b, with its distance.
  function closestOnSegment(a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / lengthSq));
    const point = [a[0] + t * dx, a[1] + t * dy];
    return { point, km: Math.hypot(point[0], point[1]) };
  }

  function linesOf(geometry) {
    if (!geometry) return [];
    if (geometry.type === "LineString") return [geometry.coordinates];
    if (geometry.type === "MultiLineString") return geometry.coordinates;
    if (geometry.type === "Point") return [[geometry.coordinates, geometry.coordinates]];
    return [];
  }

  // Nearest point of a line or multi-line to `origin`: { km, at: [lng, lat] }, or null.
  function nearestOnGeometry(origin, geometry) {
    let best = null;
    for (const line of linesOf(geometry)) {
      const local = line.map((c) => toLocalKm(origin, c));
      if (local.length === 1) local.push(local[0]); // a single point: a zero-length segment
      for (let i = 0; i + 1 < local.length; i++) {
        const hit = closestOnSegment(local[i], local[i + 1]);
        if (!best || hit.km < best.km) best = { km: hit.km, local: hit.point };
      }
    }
    return best ? { km: best.km, at: fromLocalKm(origin, best.local) } : null;
  }

  // The feature nearest to `origin` among those `accept` keeps: { feature, km, at }, or null.
  function nearestFeature(origin, features, accept) {
    let best = null;
    for (const feature of features) {
      if (accept && !accept(feature)) continue;
      const hit = nearestOnGeometry(origin, feature.geometry);
      if (hit && (!best || hit.km < best.km)) best = { feature, km: hit.km, at: hit.at };
    }
    return best;
  }

  // Straight-line distance between two points, for checks and for the search radius.
  function distanceKm(a, b) {
    const local = toLocalKm(a, b);
    return Math.hypot(local[0], local[1]);
  }

  const api = { KM_PER_MILE, toLocalKm, fromLocalKm, nearestOnGeometry, nearestFeature, distanceKm };
  root.AtlasGeo = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

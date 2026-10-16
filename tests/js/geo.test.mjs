// Tests for web/geo.js, the distance math behind the site check. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const geo = createRequire(import.meta.url)("../../web/geo.js");
const ALBANY = [-73.7562, 42.6526];

// Great-circle distance, used only to check the flat-map shortcut in geo.js.
function haversineKm(a, b) {
  const r = 6371.0088, rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad, dLon = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

test("within 100 km, distances agree with the great-circle formula to within 0.5%", () => {
  for (const other of [[-73.69, 42.73], [-74.35, 42.95], [-73.92, 41.80], [-73.7562, 42.70], [-73.0, 42.65]]) {
    const flat = geo.distanceKm(ALBANY, other), exact = haversineKm(ALBANY, other);
    assert.ok(Math.abs(flat - exact) / exact < 0.005, `${flat} vs ${exact}`);
  }
});

test("the nearest point can be in the middle of a segment, not only at its ends", () => {
  const line = { type: "LineString", coordinates: [[-73.80, 42.66], [-73.70, 42.66]] };
  const hit = geo.nearestOnGeometry(ALBANY, line);
  assert.ok(Math.abs(hit.at[0] - ALBANY[0]) < 1e-9);          // straight above the point
  assert.ok(Math.abs(hit.km - 0.822) < 0.01, String(hit.km));   // 0.0074 degrees of latitude
});

test("multi-lines, single points and empty shapes are handled", () => {
  const multi = { type: "MultiLineString", coordinates: [[[-74, 43], [-74, 43.1]], [[-73.76, 42.65], [-73.75, 42.66]]] };
  assert.ok(geo.nearestOnGeometry(ALBANY, multi).km < 0.1);
  assert.equal(geo.nearestOnGeometry(ALBANY, { type: "Point", coordinates: ALBANY }).km, 0);
  assert.equal(geo.nearestOnGeometry(ALBANY, { type: "LineString", coordinates: [[-73.7, 42.6]] }).km > 0, true);
  assert.equal(geo.nearestOnGeometry(ALBANY, null), null);
  assert.equal(geo.nearestOnGeometry(ALBANY, { type: "Polygon", coordinates: [] }), null);
});

test("nearestFeature keeps only the features the filter accepts", () => {
  const near = { properties: { hc: 0.5 }, geometry: { type: "LineString", coordinates: [[-73.757, 42.652], [-73.756, 42.653]] } };
  const far = { properties: { hc: 3 }, geometry: { type: "LineString", coordinates: [[-73.70, 42.70], [-73.69, 42.71]] } };
  assert.equal(geo.nearestFeature(ALBANY, [near, far]).feature, near);
  const best = geo.nearestFeature(ALBANY, [near, far], (f) => f.properties.hc >= 2);
  assert.equal(best.feature, far);
  assert.ok(best.km > 5 && best.km < 8);
  assert.equal(geo.nearestFeature(ALBANY, [near], (f) => f.properties.hc >= 2), null);
});

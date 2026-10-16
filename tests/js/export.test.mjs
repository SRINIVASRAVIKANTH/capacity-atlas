// Tests for web/export.js: downloads and shared site check links. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const ex = createRequire(import.meta.url)("../../web/export.js");
const NY = [-79.8, 40.4, -71.8, 45.1];

test("CSV cells are quoted when needed and numbers stay numbers", () => {
  assert.equal(ex.csvCell(2.5), "2.5");
  assert.equal(ex.csvCell(null), "");
  assert.equal(ex.csvCell(NaN), "");
  assert.equal(ex.csvCell("Feeder, North"), '"Feeder, North"');
  assert.equal(ex.csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(ex.csvCell("two\nlines"), '"two\nlines"');
});

test("text that a spreadsheet would run as a formula is neutralised", () => {
  for (const evil of ["=HYPERLINK(\"http://x\")", "+1+1", "-2+3", "@SUM(A1)", "\tcmd", "\r=1"]) {
    assert.ok(ex.csvCell(evil).replace(/^"/, "").startsWith("'"), evil);
  }
  assert.equal(ex.csvCell(-3), "-3"); // a real negative number is still a number
});

test("a CSV file has a header row and one row per section", () => {
  const csv = ex.toCsv([{ a: 1, b: "x" }, { a: 2 }], [["a", "Capacity (MW)"], ["b", "Feeder"]]);
  assert.equal(csv, "Capacity (MW),Feeder\r\n1,x\r\n2,\r\n");
});

test("pieces of one section cut by tile edges are joined, others kept apart", () => {
  const piece = (id, coords) => ({ id, properties: { hc: id }, geometry: { type: "LineString", coordinates: coords } });
  const merged = ex.mergeSections([piece(1, [[0, 0], [1, 1]]), piece(2, [[5, 5], [6, 6]]), piece(1, [[1, 1], [2, 2]])]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].lines.length, 2);
  assert.equal(ex.lineGeometry(merged[0].lines).type, "MultiLineString");
  assert.equal(ex.lineGeometry(merged[1].lines).type, "LineString");
  assert.deepEqual(ex.lineGeometry([[[1.123456789, 2.987654321]]]).coordinates, [[1.123457, 2.987654]]);
});

test("shared links: a good link is read, anything odd is ignored", () => {
  assert.deepEqual(ex.parseSiteLink("?site=-73.78460,43.08310&mw=3", NY), { spot: [-73.7846, 43.0831], mw: 3 });
  assert.deepEqual(ex.parseSiteLink("?site=-73.7846,43.0831", NY).mw, 2);           // size missing: default
  assert.equal(ex.parseSiteLink("?site=-73.7846,43.0831&mw=1e9", NY).mw, 2);         // size out of range
  for (const bad of ["", "?site=", "?site=abc,def", "?site=-73.7,43.1,5", "?site=-118.24,34.05",
    "?site=-73.7%3Cscript%3E,43.1", "?site=Infinity,43", "?site=-73.7846 ,43.0831", "?site=1e2,43"]) {
    assert.equal(ex.parseSiteLink(bad, NY), null, bad);
  }
});

test("shared links contain only a location and a size", () => {
  const link = ex.siteLink("https://capacity-atlas.pages.dev/", [-73.784612345, 43.083109876], 3.456);
  assert.equal(link, "https://capacity-atlas.pages.dev/?site=-73.78461,43.08311&mw=3.46");
  assert.deepEqual(ex.parseSiteLink(new URL(link).search, NY), { spot: [-73.78461, 43.08311], mw: 3.46 });
});

test("only sections that reach into the view are kept", () => {
  const box = [0, 0, 10, 10];
  assert.equal(ex.touchesBox([[[1, 1], [2, 2]]], box), true);
  assert.equal(ex.touchesBox([[[-5, 5], [15, 5]]], box), true);   // crosses the view, no point inside
  assert.equal(ex.touchesBox([[[11, 11], [12, 12]]], box), false);
  assert.equal(ex.touchesBox([[[11, 11]], [[5, 5]]], box), true);  // one piece of several is enough
  assert.equal(ex.touchesBox([], box), false);
});

test("a GeoJSON file carries the readable fields, the shapes and the notes, nothing else", () => {
  const sections = [{ id: 7, properties: { sid: 7, q: 3 }, lines: [[[1, 2], [3, 4]]] }];
  const out = JSON.parse(ex.toGeoJson(sections, [{ utility: "Central Hudson", hosting_capacity_mw: 1.5 }], { note: "estimates" }));
  assert.equal(out.type, "FeatureCollection");
  assert.equal(out.metadata.note, "estimates");
  assert.deepEqual(out.features[0].properties, { utility: "Central Hudson", hosting_capacity_mw: 1.5 });
  assert.equal(out.features[0].id, undefined); // internal section numbers stay out
  assert.deepEqual(out.features[0].geometry, { type: "LineString", coordinates: [[1, 2], [3, 4]] });
});

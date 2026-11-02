// Tests for web/built.js: NYSERDA's list of connected solar, per feeder and per ZIP code. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const b = createRequire(import.meta.url)("../../web/built.js");
const fmtMW = (v) => (v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toFixed(2));
const DATA = {
  data_through: "2026-08-31",
  sources: { central_hudson_ny_pv: { 6011: [969.8, 123, "2026-08"], 7054: [0, 1, null], 4003: [16.1, 1, "2010-11"] } },
};

test("dates read the way the rest of the map writes them", () => {
  assert.equal(b.fmtMonth("2026-08"), "Aug 2026");
  assert.equal(b.fmtDay("2026-08-31"), "Aug 31, 2026");
  for (const bad of ["2026-13", "Aug 2026", null, 202608, "2026-8"]) assert.equal(b.fmtMonth(bad), "");
  assert.equal(b.fmtDay("2026-08"), "");
});

test("a feeder with solar on record", () => {
  const fact = b.feederFact(DATA, "central_hudson_ny_pv", "6011");
  assert.deepEqual(fact, { kw: 969.8, systems: 123, last: "2026-08", through: "2026-08-31" });
  assert.deepEqual(b.feederWords(fact, fmtMW), { value: "0.97 MW, 123 systems", note: "NYSERDA list to Aug 31, 2026" });
});

test("one system, and a system whose size is not published", () => {
  assert.equal(b.feederWords(b.feederFact(DATA, "central_hudson_ny_pv", "4003"), fmtMW).value, "0.02 MW, 1 system");
  const unsized = b.feederWords(b.feederFact(DATA, "central_hudson_ny_pv", "7054"), fmtMW);
  assert.equal(unsized.value, "1 system, size not published");
  assert.equal(unsized.note, "NYSERDA list to Aug 31, 2026");
});

test("a covered utility's feeder with no project says so; an uncovered utility shows nothing", () => {
  const none = b.feederFact(DATA, "central_hudson_ny_pv", "9999");
  assert.deepEqual(none, { none: true, through: "2026-08-31" });
  assert.equal(b.feederWords(none, fmtMW).value, "None on record");
  assert.equal(b.feederFact(DATA, "national_grid_ny_pv", "36_01_1"), null);
  assert.equal(b.feederWords(null, fmtMW), null);
});

test("anything odd in the file means nothing is shown, never a wrong number", () => {
  const odd = (entry, through = "2026-08-31") => ({ data_through: through, sources: { s: { f: entry } } });
  for (const data of [null, {}, "x", odd([1, 1, "2026-01"], "Aug 2026"), odd("x"), odd([1, 1]), odd([-5, 1, null]),
    odd(["5", 1, null]), odd([5, 0, null]), odd([5, 1.5, null]), { data_through: "2026-08-31", sources: { s: [] } }]) {
    assert.equal(b.feederFact(data, "s", "f"), null, JSON.stringify(data));
  }
  assert.equal(b.feederFact(odd([5, 1, "late"]), "s", "f").last, null);   // a bad month is dropped, the rest kept
  assert.equal(b.feederFact(odd([5, 1, null]), "s", "toString").none, true); // object keys are not feeders
});

const point = (zip, kw, n, extra = {}) => ({ type: "Feature", geometry: { type: "Point", coordinates: [-73.9, 41.7] },
  properties: { zip, kw, n, ...extra } });

test("only well-formed ZIP points are drawn", () => {
  const good = point("12601", 10282.1, 668, { place: "Poughkeepsie" });
  const fc = { type: "FeatureCollection", features: [good, point("1260", 1, 1), point("12602", -1, 1), point("12603", 5, 0),
    { ...good, geometry: { type: "Point", coordinates: [-73.9] } }, null, { properties: {} }] };
  assert.deepEqual(b.zipFeatures(fc), [good]);
  assert.deepEqual(b.zipFeatures(null), []);
  assert.deepEqual(b.zipFeatures({ type: "Feature" }), []);
});

test("search finds a ZIP code from its first digits and a town from any word", () => {
  const fs = [point("12601", 10282, 668, { place: "Poughkeepsie" }), point("12603", 16008, 1448, { place: "Poughkeepsie" }),
    point("12866", 17238, 643, { place: "Saratoga Springs" }), point("12020", 5000, 300, { place: "Ballston Spa" }), point("12000", 1, 1)];
  assert.deepEqual(b.searchZips(fs, "126").map((f) => f.properties.zip), ["12603", "12601"]);  // most solar first
  assert.deepEqual(b.searchZips(fs, "12601").map((f) => f.properties.zip), ["12601"]);
  assert.deepEqual(b.searchZips(fs, "springs").map((f) => f.properties.zip), ["12866"]);
  assert.deepEqual(b.searchZips(fs, "  POUGH ").map((f) => f.properties.zip), ["12603", "12601"]);
  assert.deepEqual(b.searchZips(fs, "spa").map((f) => f.properties.zip), ["12020"]);
  assert.deepEqual(b.searchZips(fs, "oughkeep"), []);   // the start of a word, not the middle
  assert.deepEqual(b.searchZips(fs, ""), []);
  assert.equal(b.searchZips(fs, "1", 2).length, 2);
});

test("the year chart is plain SVG built from numbers only", () => {
  const svg = b.yearBars([{ year: 2024, kw: 900000 }, { year: 2025, kw: 1000000 }, { year: 2026, kw: 300000 }, { year: "x", kw: 5 }], 300, 60, 2026);
  assert.equal((svg.match(/<rect /g) || []).length, 3);
  assert.match(svg, /class="yb yb-partial"[^>]*height="17\.4"/);   // 2026 is lighter, scaled to the largest year
  assert.match(svg, /<title>2025: 1000 MW<\/title>/);
  assert.match(svg, /aria-label="Solar built each year, 2024 to 2026"/);
  assert.equal(b.yearBars([], 300, 60), "");
  assert.equal(b.yearBars([{ year: 2020, kw: "<script>" }], 300, 60), "");
});

test("utility names read the way people know them", () => {
  assert.equal(b.utilityName("PSEGLI"), "PSEG Long Island");
  assert.equal(b.utilityName("Con Ed"), "Con Edison");
  assert.equal(b.utilityName("Someone New"), "Someone New");   // a new name in the list is shown as published
  assert.equal(b.utilityName(undefined), "Not stated");
  assert.equal(b.utilityName("toString"), "toString");
});

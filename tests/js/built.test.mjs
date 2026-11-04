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
  assert.deepEqual(b.feederWords(fact, fmtMW), { value: "0.97 MW, 123 systems", note: "From NYSERDA's list, through Aug 31, 2026" });
});

test("one system, and a system whose size is not published", () => {
  assert.equal(b.feederWords(b.feederFact(DATA, "central_hudson_ny_pv", "4003"), fmtMW).value, "0.02 MW, 1 system");
  const unsized = b.feederWords(b.feederFact(DATA, "central_hudson_ny_pv", "7054"), fmtMW);
  assert.equal(unsized.value, "1 system, size not published");
  assert.equal(unsized.note, "From NYSERDA's list, through Aug 31, 2026");
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

test("the summary keeps only its well-formed parts, and never breaks the page", () => {
  const good = {
    data_through: "2026-08-31", rows: 10,
    totals: { systems: 5, kw: 100, community_systems: 1, community_kw: 40 },
    last_12_months: { systems: 2, kw: 30 }, unplaced: { systems: 1, kw: 2 },
    by_year: [{ year: 2025, kw: 60, systems: 3 }, { year: 2024, kw: 40, systems: 2 }, { year: "x", kw: 1 }, null, 7],
    by_utility: [{ name: "Central Hudson", kw: 100, systems: 5 }, { name: "", kw: 1, systems: 1 }, { name: "X", kw: -1, systems: 1 }],
    feeders: { central_hudson_ny_pv: { nyserda_name: "Central Hudson", feeders_with_capacity: 3, feeders_with_solar: 2, kw_matched: 80, kw_utility: 100 }, bad: { nyserda_name: 5 } },
    checks: [{ status: "ran", severity: "error", flagged: 1, title: "No size", explanation: "..." }, { status: "ran", severity: "nope", flagged: 1, title: "x" }],
  };
  const s = b.cleanSummary(good);
  assert.deepEqual(s.by_year.map((y) => y.year), [2024, 2025]);   // sorted, odd rows dropped
  assert.deepEqual(s.by_utility.map((u) => u.name), ["Central Hudson"]);
  assert.deepEqual(Object.keys(s.feeders), ["central_hudson_ny_pv"]);
  assert.equal(s.checks.length, 1);
  assert.equal(s.data_through, "2026-08-31");
  for (const bad of [null, "x", [], {}, { totals: "x" }, { totals: { systems: -1, kw: 5 } }, { totals: { systems: 1, kw: "5" } }]) {
    assert.equal(b.cleanSummary(bad), null, JSON.stringify(bad));
  }
  const odd = b.cleanSummary({ totals: { systems: 1, kw: 1 }, data_through: "<b>", by_year: "y", checks: 5, feeders: [1], last_12_months: "z" });
  assert.equal(odd.data_through, null);
  assert.deepEqual([odd.by_year, odd.checks, odd.feeders, odd.last_12_months], [[], [], {}, { systems: 0, kw: 0 }]);
});

test("the time-lapse file is checked before use", () => {
  const good = { data_through: "2026-08-31", years: [2024, 2025, 2026], state: [10, 30, 60], undated_kw: 4.5,
    zips: { 12601: [0, 5, 9], 12602: [1, 0, 2], abc: [1, 2, 3], 12603: [1, 2], 12604: [0, 0, 7] } };
  const y = b.cleanYears(good);
  assert.deepEqual([...y.zips.keys()], ["12601", "12604"]);   // falling, short or odd entries are left out
  assert.equal(y.through, "2026-08-31");
  assert.equal(y.undatedKw, 4.5);
  for (const bad of [null, {}, { years: [2024, 2026], state: [1, 2], zips: { 12601: [1, 2] } },   // a gap in the years
    { years: [2025, 2026], state: [5, 3], zips: { 12601: [1, 2] } },                              // the state total falls
    { years: [2025, 2026], state: [1, 2], zips: { 12601: [1, 0] } },                              // no usable ZIP code
    { years: [2026], state: [1], zips: { 12601: [1] } }]) {
    assert.equal(b.cleanYears(bad), null, JSON.stringify(bad));
  }
});

test("the time-lapse blends between years and knows what each year added", () => {
  const list = [0, 10, 40];
  assert.deepEqual(b.yearValues(list, 0), { total: 0, added: 0 });
  assert.deepEqual(b.yearValues(list, 1), { total: 10, added: 10 });
  assert.deepEqual(b.yearValues(list, 1.5), { total: 25, added: 30 });   // halfway to the next year; it shows that year's growth
  assert.deepEqual(b.yearValues(list, 2), { total: 40, added: 30 });
  assert.deepEqual(b.yearValues(list, 9), { total: 40, added: 30 });     // past the end stays at the end
  assert.deepEqual(b.yearValues(list, -3), { total: 0, added: 0 });
});

test("a shared ZIP link accepts five digits and nothing else", () => {
  assert.equal(b.parseZipLink("?zip=12601"), "12601");
  assert.equal(b.parseZipLink("?data=x&zip=14414"), "14414");
  for (const bad of ["", "?zip=1260", "?zip=126011", "?zip=12601<script>", "?zip=%3Cb%3E", "?zip=", null]) {
    assert.equal(b.parseZipLink(bad), null, String(bad));
  }
});

test("the download holds the ZIP codes in view, in plain units, in a stable order", () => {
  const fs = [
    point("12603", 16008.4, 1448, { place: "Poughkeepsie", county: "Dutchess", u: "Central Hudson", r12: 1500, cn: 1, st: 590, last: "2026-08" }),
    point("12601", 10282.1, 668, { place: "Poughkeepsie", county: "Dutchess", u: "Central Hudson", last: "late" }),
    { ...point("14414", 23227.8, 51, { u: "National Grid" }), geometry: { type: "Point", coordinates: [-77.7, 42.9] } },
  ];
  const all = b.zipRows(fs);
  assert.deepEqual(all.map((r) => r.zip), ["12601", "12603", "14414"]);
  assert.deepEqual(all[1], { zip: "12603", town: "Poughkeepsie", county: "Dutchess", utility: "Central Hudson",
    solar_mw: 16.008, systems: 1448, last_12_months_mw: 1.5, community_solar_systems: 1, battery_storage_mw: 0.59,
    most_recent_connection: "2026-08", center_latitude: 41.7, center_longitude: -73.9 });
  assert.equal(all[0].most_recent_connection, null);   // a bad month is left empty
  assert.equal(all[0].last_12_months_mw, null);        // not in the file: empty, not 0
  assert.deepEqual(b.zipRows(fs, [-74.5, 41, -73, 42]).map((r) => r.zip), ["12601", "12603"]);   // the box keeps the Hudson Valley
  assert.deepEqual(b.zipRows(null), []);
  assert.equal(b.ZIP_COLUMNS.length, Object.keys(all[0]).length);
});

test("place names match the way people write them", () => {
  for (const [one, other] of [["St. James", "Saint James"], ["Mt Kisco", "Mount Kisco"], ["the Bronx", "Bronx"], ["Paul Smith's", "Paul Smiths"],
    ["Croton-on-Hudson", "Croton On Hudson"], ["  ALBANY ", "albany"], ["Town of Hempstead", "Hempstead"], ["Ft. Edward", "Fort Edward"],
    ["St. Lawrence", "St Lawrence"], ["Paul Smith’s", "Paul Smiths"]]) {
    assert.equal(b.placeKey(one), b.placeKey(other), `${one} / ${other}`);
  }
  for (const bad of [null, undefined, 42, {}, ["x"]]) assert.equal(b.placeKey(bad), "");
  assert.notEqual(b.placeKey("Long Island City"), b.placeKey("Long Island"));
});

test("regions and boroughs are their counties; New York alone is the state", () => {
  assert.deepEqual(b.namedArea("long island"), { label: "Long Island", counties: ["nassau", "suffolk"] });
  assert.deepEqual(b.namedArea(b.placeKey("The Bronx")).counties, ["bronx"]);
  assert.deepEqual(b.namedArea("queens").counties, ["queens"]);
  assert.deepEqual(b.namedArea("brooklyn").counties, ["kings"]);
  assert.deepEqual(b.namedArea("staten island").counties, ["richmond"]);
  assert.equal(b.namedArea("nyc").counties.length, 5);
  for (const k of ["new york", "ny", "new york state", "nys"]) assert.deepEqual(b.namedArea(k), { label: "New York State", counties: null });
  assert.equal(b.namedArea(b.placeKey("Mid-Hudson")).label, "the Hudson Valley");
  assert.deepEqual(b.namedArea("hudson valley").counties.sort(), ["dutchess", "orange", "putnam", "rockland", "sullivan", "ulster", "westchester"]);
  assert.ok(!b.namedArea("hudson valley").counties.includes("albany"));
  assert.ok(b.namedArea("capital region").counties.includes("albany"));
  assert.ok(b.namedArea("north country").counties.includes("st lawrence"));
  assert.deepEqual(b.namedArea("wny").counties, ["allegany", "cattaraugus", "chautauqua", "erie", "niagara"]);
  // the ten regions cover all 62 counties exactly once
  const counties = ["long island", "new york city", "hudson valley", "capital region", "central new york", "finger lakes",
    "mohawk valley", "north country", "southern tier", "western new york"].flatMap((k) => b.namedArea(k).counties);
  assert.equal(counties.length, 62);
  assert.equal(new Set(counties).size, 62);
  for (const k of ["albany", "", "rochester", "toString", "__proto__", "constructor"]) assert.equal(b.namedArea(k), null);
});

test("on Long Island, in Albany", () => {
  assert.equal(b.onOrIn("Long Island"), "on");
  assert.equal(b.onOrIn("Staten Island"), "on");
  assert.equal(b.onOrIn("Long Island City"), "in");
  assert.equal(b.onOrIn("Middle Island"), "in");
  assert.equal(b.onOrIn("Albany"), "in");
});

test("the place search's best result for an area question", () => {
  const pt = (x, y, props) => ({ type: "Feature", geometry: { type: "Point", coordinates: [x, y] }, properties: props });
  const poi = pt(-73.8, 42.7, { name: "Capital Region Welcome Center", osm_key: "tourism", type: "house", extent: [-73.81, 42.71, -73.79, 42.69] });
  const city = pt(-73.75, 42.65, { name: "Albany", osm_key: "place", type: "city", extent: [-73.9, 42.8, -73.7, 42.6] });
  // an area beats a landmark listed first, and its extent becomes [west, south, east, north]
  assert.deepEqual(b.pickPlace([poi, city], "Albany"), { center: [-73.75, 42.65], extent: [-73.9, 42.6, -73.7, 42.8], name: "Albany" });
  // a landmark alone is a point: its tiny extent is not used
  assert.deepEqual(b.pickPlace([poi], "welcome center"), { center: [-73.8, 42.7], extent: null, name: "Capital Region Welcome Center" });
  // an address wins when the question has a street number
  const house = pt(-73.76, 42.66, { name: "100 State St", type: "house", housenumber: "100" });
  assert.equal(b.pickPlace([poi, house], "100 State St, Albany").name, "100 State St");
  // broken results are skipped, nothing usable is null
  assert.equal(b.pickPlace([pt(NaN, 1, {}), { geometry: { type: "Polygon" } }, null], "x"), null);
  assert.equal(b.pickPlace(null, "x"), null);
  assert.deepEqual(b.pickPlace([pt(-74, 41, null)], "x"), { center: [-74, 41], extent: null, name: null });
  assert.equal(b.pickPlace([pt(-74, 41, { type: "county", name: "Ulster County", extent: [1, 2, "x", 4] })], "x").extent, null);
});

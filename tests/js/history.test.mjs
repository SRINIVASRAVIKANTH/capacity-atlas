// Tests for web/history.js: reading the feeder history and describing its trend. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const h = createRequire(import.meta.url)("../../web/history.js");
const DATES = ["2026-10-02", "2026-10-09", "2026-10-16", "2026-10-23", "2026-10-30"];
const data = (points, dates = DATES) => ({ sources: { ng: { dates, feeders: { F1: points } } } });
const fmtDate = (d) => d.slice(5);
const fmtMW = (v) => String(v);

test("change points expand to one value per date, and gaps drop out", () => {
  const s = h.seriesFor(data([[0, 6], [2, 4.8], [3, null], [4, 4.8]]), "ng", "F1");
  assert.deepEqual(s.map((p) => p.value), [6, 6, 4.8, 4.8]);
  assert.deepEqual(s.map((p) => p.date), ["2026-10-02", "2026-10-09", "2026-10-16", "2026-10-30"]);
});

test("anything odd in the file means no chart, never an error", () => {
  for (const bad of [null, {}, { sources: {} }, data("x"), data([[1, 2], [0, 3]]), data([[9, 1]]),
    data([[0, "6"]]), data([[0, Infinity]]), data([[0, 1, 2]]), data([[0, 1]], ["oct 2"])]) {
    assert.deepEqual(h.seriesFor(bad, "ng", "F1"), []);
  }
  assert.deepEqual(h.seriesFor(data([[0, 1]]), "ng", "__proto__"), []);
  assert.deepEqual(h.seriesFor(data([[0, 1]]), "constructor", "F1"), []);
});

test("the trend reads as a plain sentence, and needs at least four dates", () => {
  const series = (values) => values.map((value, i) => ({ date: DATES[i], value }));
  assert.equal(h.trend(series([6, 6, 6]), fmtDate, fmtMW), null);
  assert.equal(h.trend(series([6, 6, 6, 6]), fmtDate, fmtMW).short, "Unchanged since 10-02");
  assert.equal(h.trend(series([6, 5, 4.8, 4.1]), fmtDate, fmtMW).short, "Down 1.9 MW since 10-02");
  assert.equal(h.trend(series([6, 5, 4.8, 4.1]), fmtDate, fmtMW).long, "Down from 6 MW on 10-02 to 4.1 MW");
  assert.equal(h.trend(series([1, 2, 2, 3]), fmtDate, fmtMW).direction, 1);
  assert.equal(h.trend(series([3, 2, 4, 3]), fmtDate, fmtMW).direction, 0);
});

test("the chart is SVG made of numbers only", () => {
  const svg = h.sparkline([{ date: "2026-10-02", value: 6 }, { date: "2026-10-09", value: 6 }, { date: "2026-10-30", value: 4.1 }], 280, 64);
  assert.match(svg, /^<svg class="h-chart" viewBox="0 0 280 64"/);
  assert.equal((svg.match(/<circle/g) || []).length, 3);
  assert.ok(!/NaN|undefined/.test(svg));
  assert.ok(!/NaN/.test(h.sparkline([{ date: "2026-10-02", value: 5 }, { date: "2026-10-02", value: 5 }], 280, 64)));
});

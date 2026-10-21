/* Feeder capacity history: reading history.json and drawing a feeder's trend.
 *
 * The weekly run writes, for every feeder, its highest capacity on each snapshot date, stored
 * as change points (see capacity_atlas/history.py). Plain functions with no map code, so they
 * are tested on their own (tests/js/history.test.mjs).
 */
/* global module */
(function (root) {
  "use strict";

  const MIN_POINTS = 4;   // fewer dates than this is not a trend, so nothing is shown
  const DAY = /^\d{4}-\d{2}-\d{2}$/;

  // The file comes from our own pipeline, but it is still checked: anything odd means no chart.
  function seriesFor(data, sourceId, feeder) {
    const entry = data && data.sources && Object.prototype.hasOwnProperty.call(data.sources, sourceId) ? data.sources[sourceId] : null;
    if (!entry || !Array.isArray(entry.dates) || !entry.feeders) return [];
    const dates = entry.dates;
    if (!dates.every((d) => typeof d === "string" && DAY.test(d))) return [];
    const points = Object.prototype.hasOwnProperty.call(entry.feeders, feeder) ? entry.feeders[feeder] : null;
    if (!Array.isArray(points)) return [];
    const values = new Array(dates.length).fill(null);
    let previous = -1;
    for (const pair of points) {
      if (!Array.isArray(pair) || pair.length !== 2) return [];
      const [i, value] = pair;
      if (!Number.isInteger(i) || i <= previous || i >= dates.length) return [];
      if (value !== null && !Number.isFinite(value)) return [];
      for (let j = i; j < dates.length; j++) values[j] = value;
      previous = i;
    }
    return dates.map((date, i) => ({ date, value: values[i] })).filter((p) => p.value !== null);
  }

  // A plain sentence for the trend, or null when there are too few dates.
  // fmtDate and fmtMW are the page's own formatters, so the wording matches the rest of the map.
  function trend(series, fmtDate, fmtMW) {
    if (series.length < MIN_POINTS) return null;
    const first = series[0], last = series[series.length - 1];
    const since = fmtDate(first.date);
    const change = Math.round((last.value - first.value) * 100) / 100;
    if (series.every((p) => p.value === first.value)) {
      return { short: `Unchanged since ${since}`, long: `Unchanged at ${fmtMW(first.value)} MW since ${since}`, direction: 0 };
    }
    if (change === 0) {
      return { short: `Back to ${fmtMW(last.value)} MW, as on ${since}`, long: `Moved, then back to ${fmtMW(last.value)} MW, as on ${since}`, direction: 0 };
    }
    const word = change < 0 ? "Down" : "Up";
    return {
      short: `${word} ${fmtMW(Math.abs(change))} MW since ${since}`,
      long: `${word} from ${fmtMW(first.value)} MW on ${since} to ${fmtMW(last.value)} MW`,
      direction: change < 0 ? -1 : 1,
    };
  }

  // A small line chart as SVG markup. Only numbers go into it, so it is safe as HTML.
  function sparkline(series, width, height) {
    const pad = 6;
    const times = series.map((p) => Date.parse(p.date + "T12:00:00Z"));
    const t0 = times[0], t1 = times[times.length - 1];
    const values = series.map((p) => p.value);
    let lo = Math.min(...values), hi = Math.max(...values);
    if (hi - lo < 0.01) { lo -= 1; hi += 1; } // a flat line sits in the middle
    const x = (t) => pad + ((t - t0) / Math.max(t1 - t0, 1)) * (width - 2 * pad);
    const y = (v) => pad + (1 - (v - lo) / (hi - lo)) * (height - 2 * pad);
    const xy = series.map((p, i) => [x(times[i]).toFixed(1), y(p.value).toFixed(1)]);
    const path = xy.map(([px, py], i) => `${i ? "L" : "M"}${px} ${py}`).join(" ");
    const dots = xy.map(([px, py], i) =>
      `<circle class="${i === xy.length - 1 ? "h-dot h-last" : "h-dot"}" cx="${px}" cy="${py}" r="${i === xy.length - 1 ? 3.5 : 2.5}"/>`).join("");
    return `<svg class="h-chart" viewBox="0 0 ${width} ${height}" width="100%" aria-hidden="true">` +
      `<path class="h-line" d="${path}" pathLength="1"/>${dots}</svg>`;
  }

  const api = { MIN_POINTS, seriesFor, trend, sparkline };
  root.AtlasHistory = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

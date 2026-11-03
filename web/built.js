/* Solar already built: reading NYSERDA's list as the weekly run publishes it.
 *
 * Two files (see capacity_atlas/installed.py):
 *   solar_feeders.json  per utility and feeder: [kW built, systems, latest connection YYYY-MM]
 *   solar_zips.geojson  one point per ZIP code, for the "Built so far" page
 *
 * Plain functions with no map code, so they are tested on their own (tests/js/built.test.mjs).
 * Everything read here is checked: anything odd means "nothing to show", never a wrong number.
 */
/* global module */
(function (root) {
  "use strict";

  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  const MONTH = /^\d{4}-\d{2}$/;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const own = (obj, key) => !!obj && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key);

  // "2026-08" -> "Aug 2026"; "2026-08-31" -> "Aug 31, 2026". Anything else -> "".
  function fmtMonth(value) {
    if (typeof value !== "string" || !MONTH.test(value)) return "";
    const m = Number(value.slice(5, 7));
    return m >= 1 && m <= 12 ? `${MONTHS[m - 1]} ${value.slice(0, 4)}` : "";
  }
  function fmtDay(value) {
    if (typeof value !== "string" || !DAY.test(value)) return "";
    const month = fmtMonth(value.slice(0, 7));
    return month ? month.replace(" ", ` ${Number(value.slice(8, 10))}, `) : "";
  }

  // What the file says about one feeder:
  //   null                       the file is missing or odd, or does not cover this utility: show nothing
  //   { none: true, through }    the utility is covered but no project lists this feeder's ID
  //   { kw, systems, last, through }
  function feederFact(data, sourceId, feeder) {
    if (!data || typeof data !== "object" || !DAY.test(String(data.data_through)) || !own(data.sources, sourceId)) return null;
    const feeders = data.sources[sourceId];
    if (!feeders || typeof feeders !== "object" || Array.isArray(feeders)) return null;
    const through = data.data_through;
    if (!own(feeders, feeder)) return { none: true, through };
    const entry = feeders[feeder];
    if (!Array.isArray(entry) || entry.length !== 3) return null;
    const [kw, systems, last] = entry;
    if (!Number.isFinite(kw) || kw < 0 || !Number.isInteger(systems) || systems < 1) return null;
    return { kw, systems, last: last === null || MONTH.test(String(last)) ? last : null, through };
  }

  // The card's words, kept to one value and one short source line so the card stays calm.
  // fmtMW is the page's own number format, so it reads like the rest of the card.
  function feederWords(fact, fmtMW) {
    if (!fact) return null;
    const note = `From NYSERDA's list, through ${fmtDay(fact.through)}`;
    if (fact.none) return { value: "None on record", note };
    const count = `${fact.systems.toLocaleString("en-US")} ${fact.systems === 1 ? "system" : "systems"}`;
    return { value: fact.kw > 0 ? `${fmtMW(fact.kw / 1000)} MW, ${count}` : `${count}, size not published`, note };
  }

  // NYSERDA's short utility names, as people know them.
  const UTILITY_NAMES = {
    "Central Hudson": "Central Hudson", "Con Ed": "Con Edison", "National Grid": "National Grid", NYSEG: "NYSEG",
    "O&R": "Orange & Rockland", PSEGLI: "PSEG Long Island", RGE: "RG&E",
  };
  const utilityName = (name) => (own(UTILITY_NAMES, name) ? UTILITY_NAMES[name] : String(name || "Not stated"));

  // ---------- the "Built so far" page ----------
  // Only well-formed points are kept, with the numbers the page draws.
  function zipFeatures(collection) {
    if (!collection || collection.type !== "FeatureCollection" || !Array.isArray(collection.features)) return [];
    return collection.features.filter((f) => {
      const p = f && f.properties, g = f && f.geometry;
      return p && g && g.type === "Point" && Array.isArray(g.coordinates) && g.coordinates.length === 2 &&
        g.coordinates.every(Number.isFinite) && /^\d{5}$/.test(String(p.zip)) &&
        Number.isFinite(p.kw) && p.kw >= 0 && Number.isInteger(p.n) && p.n >= 1;
    });
  }

  // Search by ZIP code (from the first digits) or by town name (from the start of any word).
  function searchZips(features, query, limit) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return [];
    const max = limit || 6;
    const digits = /^\d{1,5}$/.test(q);
    const hits = [];
    for (const f of features) {
      const p = f.properties;
      const place = typeof p.place === "string" ? p.place.toLowerCase() : "";
      const match = digits ? p.zip.startsWith(q) : place && (place.startsWith(q) || place.includes(" " + q));
      if (match) hits.push(f);
    }
    // Exact ZIP first, then the ZIP codes with the most solar.
    hits.sort((a, b) => Number(b.properties.zip === q) - Number(a.properties.zip === q) || b.properties.kw - a.properties.kw);
    return hits.slice(0, max);
  }

  // Bars for the by-year chart, as SVG markup. Only numbers go into it, so it is safe as HTML.
  // partialYear: the last year is not over yet, so its bar is drawn lighter and labeled.
  function yearBars(years, width, height, partialYear) {
    const rows = (Array.isArray(years) ? years : []).filter((y) => Number.isInteger(y.year) && Number.isFinite(y.kw) && y.kw >= 0);
    if (!rows.length) return "";
    const max = Math.max(...rows.map((y) => y.kw)) || 1;
    const gap = 2;
    const w = (width - gap * (rows.length - 1)) / rows.length;
    const bars = rows.map((y, i) => {
      const h = Math.max(1, (y.kw / max) * (height - 2));
      const x = (i * (w + gap)).toFixed(1);
      const cls = y.year === partialYear ? "yb yb-partial" : "yb";
      return `<rect class="${cls}" x="${x}" y="${(height - h).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5"><title>${y.year}: ${Math.round(y.kw / 1000)} MW</title></rect>`;
    }).join("");
    return `<svg class="year-chart" viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="Solar built each year, ${rows[0].year} to ${rows[rows.length - 1].year}">${bars}</svg>`;
  }

  // The statewide summary (solar_summary.json), reduced to the parts that are well formed. A part
  // that is missing or odd comes back empty, so the panel leaves it out instead of failing; the
  // map works either way. Returns null when the totals themselves are unusable.
  const count = (v) => Number.isInteger(v) && v >= 0;
  const amount = (v) => Number.isFinite(v) && v >= 0;
  const text = (v) => typeof v === "string" && v.length > 0 && v.length <= 200;
  const list = (v, keep) => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object" && keep(x)) : []);
  const SEVERITIES = ["error", "warning", "info"];
  function cleanSummary(s) {
    if (!s || typeof s !== "object" || Array.isArray(s)) return null;
    const t = s.totals;
    if (!t || typeof t !== "object" || !count(t.systems) || !amount(t.kw)) return null;
    const recent = s.last_12_months;
    const unplaced = s.unplaced;
    const feeders = {};
    if (s.feeders && typeof s.feeders === "object" && !Array.isArray(s.feeders)) {
      for (const [id, m] of Object.entries(s.feeders)) {
        if (m && typeof m === "object" && text(m.nyserda_name) && count(m.feeders_with_capacity) && count(m.feeders_with_solar) &&
          amount(m.kw_matched) && amount(m.kw_utility)) feeders[id] = m;
      }
    }
    return {
      data_through: typeof s.data_through === "string" && fmtDay(s.data_through) ? s.data_through : null,
      rows: count(s.rows) ? s.rows : 0,
      totals: {
        systems: t.systems, kw: t.kw,
        community_systems: count(t.community_systems) ? t.community_systems : 0,
        community_kw: amount(t.community_kw) ? t.community_kw : 0,
      },
      last_12_months: recent && count(recent.systems) && amount(recent.kw) ? { systems: recent.systems, kw: recent.kw } : { systems: 0, kw: 0 },
      unplaced: unplaced && count(unplaced.systems) && amount(unplaced.kw) ? { systems: unplaced.systems, kw: unplaced.kw } : { systems: 0, kw: 0 },
      by_year: list(s.by_year, (y) => Number.isInteger(y.year) && y.year > 1900 && y.year < 2200 && amount(y.kw)).sort((a, b) => a.year - b.year),
      by_utility: list(s.by_utility, (u) => text(u.name) && amount(u.kw) && count(u.systems)),
      feeders,
      checks: list(s.checks, (c) => text(c.status) && SEVERITIES.includes(c.severity) && count(c.flagged) && text(c.title) &&
        (c.explanation === undefined || typeof c.explanation === "string")),
    };
  }

  const api = { fmtMonth, fmtDay, feederFact, feederWords, utilityName, zipFeatures, searchZips, yearBars, cleanSummary };
  root.AtlasBuilt = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

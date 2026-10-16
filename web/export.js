/* Turning the line sections on screen into files people can download, and reading shared
 * site check links. Downloads hold only what the map already shows anyone; links hold only a
 * spot and a project size.
 *
 * Plain functions with no map code, so they are tested on their own (tests/js/export.test.mjs).
 */
/* global module */
(function (root) {
  "use strict";

  // Spreadsheet programs run a cell that starts with one of these as a formula. Data from a
  // public utility layer must never be able to do that on someone's computer.
  const FORMULA_START = /^[=+\-@\t\r]/;

  function csvCell(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
    let text = String(value);
    if (FORMULA_START.test(text)) text = "'" + text;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  // rows: array of objects; columns: [[key, header], ...]
  function toCsv(rows, columns) {
    const lines = [columns.map(([, header]) => csvCell(header)).join(",")];
    for (const row of rows) lines.push(columns.map(([key]) => csvCell(row[key])).join(","));
    return lines.join("\r\n") + "\r\n";
  }

  // A section that crosses tile edges arrives as several pieces with the same id.
  // Join them back into one feature with all its pieces.
  function mergeSections(features) {
    const byId = new Map();
    for (const f of features) {
      const key = f.id !== undefined && f.id !== null ? f.id : `${byId.size}:anon`;
      const lines = !f.geometry ? [] : f.geometry.type === "LineString" ? [f.geometry.coordinates]
        : f.geometry.type === "MultiLineString" ? f.geometry.coordinates : [];
      const seen = byId.get(key);
      if (seen) seen.lines.push(...lines);
      else byId.set(key, { id: f.id, properties: f.properties || {}, lines: [...lines] });
    }
    return [...byId.values()];
  }

  const round6 = (n) => Math.round(n * 1e6) / 1e6;

  function lineGeometry(lines) {
    const coords = lines.map((line) => line.map(([x, y]) => [round6(x), round6(y)]));
    return coords.length === 1 ? { type: "LineString", coordinates: coords[0] }
      : { type: "MultiLineString", coordinates: coords };
  }

  // True when any piece of a section reaches into the box [west, south, east, north]. Tiles
  // hold a margin beyond the screen, so this keeps the download to what is actually in view.
  function touchesBox(lines, box) {
    return lines.some((line) => {
      let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
      for (const [x, y] of line) {
        if (x < w) w = x;
        if (x > e) e = x;
        if (y < s) s = y;
        if (y > n) n = y;
      }
      return w <= box[2] && e >= box[0] && s <= box[3] && n >= box[1];
    });
  }

  // sections: merged sections; rows: the readable fields of each, in the same order.
  function toGeoJson(sections, rows, metadata) {
    const features = sections.map((section, i) => ({
      type: "Feature", properties: rows[i], geometry: lineGeometry(section.lines),
    }));
    return JSON.stringify({ type: "FeatureCollection", metadata, features });
  }

  // Shared site check links: ?site=<longitude>,<latitude>&mw=<size>. Anything that is not
  // exactly two plain numbers inside the map's area, and a size in range, is ignored.
  const SITE = /^(-?\d{1,3}(?:\.\d{1,7})?),(-?\d{1,2}(?:\.\d{1,7})?)$/;

  function parseSiteLink(search, bbox) {
    const params = new URLSearchParams(search || "");
    const match = (params.get("site") || "").match(SITE);
    if (!match) return null;
    const lng = Number(match[1]), lat = Number(match[2]);
    if (lng < bbox[0] || lng > bbox[2] || lat < bbox[1] || lat > bbox[3]) return null;
    const mw = Number(params.get("mw"));
    return { spot: [lng, lat], mw: Number.isFinite(mw) && mw >= 0.1 && mw <= 10000 ? mw : 2 };
  }

  function siteLink(base, spot, mw) {
    return `${base}?site=${spot[0].toFixed(5)},${spot[1].toFixed(5)}&mw=${Math.round(mw * 100) / 100}`;
  }

  const api = { csvCell, toCsv, mergeSections, lineGeometry, touchesBox, toGeoJson, parseSiteLink, siteLink };
  root.AtlasExport = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

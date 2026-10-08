/* Capacity Atlas web map.
 *
 * Reads two files published every week by the GitHub pipeline:
 *   atlas.pmtiles  every line section with its capacity and data quality flags
 *   summary.json   per-utility totals and what each flag means
 */
(function () {
  "use strict";

  const cfg = window.ATLAS_CONFIG;
  const params = new URLSearchParams(window.location.search);
  const DATA_URL = (params.get("data") || cfg.dataUrl).replace(/\/+$/, "");
  const STYLE_URL = params.get("basemap") || cfg.basemapStyle;
  const SOURCE = "atlas";
  const LAYER = "lines";

  // Capacity bands. Must match --c0..--c5 in style.css and the legend in index.html.
  const COLORS = { c0: "#4a2c7a", c1: "#8b0aa5", c2: "#c7427c", c3: "#ef7b45", c4: "#fdb52e", c5: "#f0f921", none: "#5c6170" };
  const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };
  const HC = ["coalesce", ["get", "hc"], -1]; // lines without capacity compare as -1

  const state = { minMW: 0, hidden: new Set(), issuesOnly: false, summary: null, flagsByBit: new Map() };

  // ---------- helpers ----------
  const $ = (id) => document.getElementById(id);
  const fmtInt = (n) => Number(n).toLocaleString("en-US");
  const fmtMW = (v) => (v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1).replace(/\.0$/, "") : v.toFixed(2).replace(/0$/, ""));
  const fmtDate = (iso) => new Date(iso + (iso.length === 10 ? "T12:00:00Z" : "")).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  function colorFor(mw) {
    if (mw === null || mw === undefined) return COLORS.none;
    if (mw <= 0) return COLORS.c0;
    if (mw < 0.5) return COLORS.c1;
    if (mw < 1) return COLORS.c2;
    if (mw < 2) return COLORS.c3;
    if (mw < 5) return COLORS.c4;
    return COLORS.c5;
  }

  function showStatus(message, ms) {
    const el = $("status");
    el.textContent = message;
    el.hidden = false;
    clearTimeout(showStatus.timer);
    if (ms) showStatus.timer = setTimeout(() => (el.hidden = true), ms);
  }

  // ---------- basemap (falls back to a plain background if the basemap service is unreachable) ----------
  const FALLBACK_STYLE = {
    version: 8,
    sources: {},
    layers: [{ id: "background", type: "background", paint: { "background-color": "#12141a" } }],
  };

  async function loadBasemap() {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      const response = await fetch(STYLE_URL, { signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok) throw new Error("HTTP " + response.status);
      const style = await response.json();
      quietBasemap(style);
      return style;
    } catch (err) {
      console.warn("Basemap unavailable, using a plain background:", err);
      return FALLBACK_STYLE;
    }
  }

  // Tone the basemap down so the grid is the brightest thing on screen.
  function quietBasemap(style) {
    for (const layer of style.layers || []) {
      const paint = (layer.paint = layer.paint || {});
      if (layer.type === "symbol") {
        paint["text-opacity"] = 0.55;
        paint["icon-opacity"] = 0.4;
      } else if (layer.type === "line") {
        paint["line-opacity"] = 0.45;
      } else if (layer.type === "raster") {
        paint["raster-opacity"] = 0.35;
      }
    }
  }

  // ---------- map layers ----------
  const capacityColor = [
    "step", HC,
    COLORS.c0, 0.0001, COLORS.c1, 0.5, COLORS.c2, 1, COLORS.c3, 2, COLORS.c4, 5, COLORS.c5,
  ];
  const width = (base) => ["interpolate", ["linear"], ["zoom"], 5, base * 0.5, 9, base, 13, base * 2.2, 16, base * 4];

  function addLayers(map) {
    map.addSource(SOURCE, {
      type: "vector",
      url: "pmtiles://" + DATA_URL + "/atlas.pmtiles",
      attribution: 'Grid data: utility hosting capacity maps',
    });

    map.addLayer({
      id: "unanalyzed", type: "line", source: SOURCE, "source-layer": LAYER,
      filter: ["!", ["has", "hc"]],
      layout: { "line-cap": "butt" },
      paint: { "line-color": COLORS.none, "line-width": width(0.6), "line-dasharray": [2, 2], "line-opacity": 0.7 },
    });

    // Soft halo under lines with real room, so capacity glows on the dark map.
    map.addLayer({
      id: "glow", type: "line", source: SOURCE, "source-layer": LAYER,
      filter: [">=", HC, 2],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": capacityColor, "line-width": width(4), "line-blur": width(3), "line-opacity": 0.35 },
    });

    map.addLayer({
      id: "capacity", type: "line", source: SOURCE, "source-layer": LAYER,
      filter: ["has", "hc"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": capacityColor, "line-width": width(1) },
    });

    // Data issues: a white outline drawn over the flagged lines when the switch is on.
    map.addLayer({
      id: "issues", type: "line", source: SOURCE, "source-layer": LAYER,
      filter: [">", ["coalesce", ["get", "qs"], 0], 0],
      layout: { visibility: "none", "line-cap": "round" },
      paint: {
        "line-color": ["match", ["get", "qs"], 2, "#ff6b6b", "#ffffff"],
        "line-width": width(0.9),
        "line-dasharray": [1.5, 1.5],
        "line-opacity": 0.85,
      },
    });

    map.addSource("selected", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({
      id: "selected-halo", type: "line", source: "selected",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": cfg.accent || "#6e76f0", "line-width": width(5), "line-opacity": 0.55, "line-blur": 2 },
    });
    map.addLayer({
      id: "selected-line", type: "line", source: "selected",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#ffffff", "line-width": width(1.6) },
    });
  }

  // ---------- filters ----------
  function applyFilters(map) {
    const utility = state.hidden.size
      ? ["!", ["in", ["get", "src"], ["literal", Array.from(state.hidden)]]]
      : true;
    const minimum = state.minMW > 0 ? [">=", HC, state.minMW] : ["has", "hc"];

    map.setFilter("capacity", ["all", ["has", "hc"], minimum, utility]);
    map.setFilter("glow", ["all", [">=", HC, Math.max(2, state.minMW)], utility]);
    map.setFilter("unanalyzed", ["all", ["!", ["has", "hc"]], utility]);
    map.setLayoutProperty("unanalyzed", "visibility", state.minMW > 0 ? "none" : "visible");
    const flagged = [">", ["coalesce", ["get", "qs"], 0], 0];
    map.setFilter("issues", state.minMW > 0 ? ["all", flagged, minimum, utility] : ["all", flagged, utility]);
    map.setLayoutProperty("issues", "visibility", state.issuesOnly ? "visible" : "none");
    // With issues highlighted, fade the capacity colors so the flagged lines stand out.
    map.setPaintProperty("capacity", "line-opacity", state.issuesOnly ? 0.3 : 1);
    map.setPaintProperty("glow", "line-opacity", state.issuesOnly ? 0.1 : 0.35);
    map.setPaintProperty("unanalyzed", "line-opacity", state.issuesOnly ? 0.25 : 0.7);
  }

  function wireControls(map) {
    $("min-mw").addEventListener("change", (e) => {
      state.minMW = Number(e.target.value);
      applyFilters(map);
    });
    $("issues-toggle").addEventListener("change", (e) => {
      state.issuesOnly = e.target.checked;
      applyFilters(map);
    });
    $("utility-toggles").addEventListener("change", (e) => {
      const id = e.target.value;
      if (e.target.checked) state.hidden.delete(id);
      else state.hidden.add(id);
      applyFilters(map);
    });
    $("detail-close").addEventListener("click", () => clearSelection(map));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !$("detail").hidden) clearSelection(map);
    });
    $("sheet-toggle").addEventListener("click", () => {
      const panel = $("panel");
      const collapsed = panel.classList.toggle("is-collapsed");
      $("sheet-toggle").setAttribute("aria-expanded", String(!collapsed));
    });
    $("repo-link").href = cfg.repoUrl;
    if (window.matchMedia("(max-width: 760px)").matches) {
      $("panel").classList.add("is-collapsed");
      $("sheet-toggle").setAttribute("aria-expanded", "false");
    }
  }

  // ---------- summary panel ----------
  async function loadSummary() {
    try {
      const response = await fetch(DATA_URL + "/summary.json", { cache: "no-cache" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      return await response.json();
    } catch (err) {
      console.warn("Summary unavailable:", err);
      return null;
    }
  }

  function renderSummary(summary) {
    const quality = $("quality");
    const toggles = $("utility-toggles");
    if (!summary) {
      quality.innerHTML = '<p class="note">The weekly summary could not be loaded. The map still shows the latest published data.</p>';
      return;
    }
    for (const flag of summary.flags) state.flagsByBit.set(flag.bit, flag);

    toggles.innerHTML = summary.sources.map((s) => `
      <label class="check">
        <input type="checkbox" value="${escapeHtml(s.source_id)}" checked>
        <span>${escapeHtml(s.utility)}</span>
        <span class="count">${fmtInt(s.sections)} lines</span>
      </label>`).join("");

    quality.innerHTML = summary.sources.map((s) => {
      const findings = s.checks
        .filter((c) => c.flagged > 0 && c.id !== "no_analysis_published" && c.id !== "capacity_exactly_zero")
        .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.flagged - a.flagged);
      const analyzedPct = s.sections ? Math.round((100 * s.analyzed) / s.sections) : 0;
      const errorsClean = !s.checks.some((c) => c.severity === "error" && c.flagged > 0);
      const list = findings.map((c) => `
        <li><span class="dot sev-${c.severity}" aria-hidden="true"></span>
          <span>${escapeHtml(c.title)}</span>
          <span class="n">${fmtInt(c.flagged)}</span></li>`).join("");
      return `
        <div class="utility">
          <div class="utility-name">${escapeHtml(s.utility)}</div>
          <div class="utility-meta">Data from ${fmtDate(s.snapshot_date)}. Capacity published for ${analyzedPct}% of ${fmtInt(s.sections)} line sections.</div>
          <ul class="findings">
            ${list}
            ${errorsClean ? '<li><span class="dot" aria-hidden="true" style="background:#5fd39a"></span><span class="clean">No contradictory values found</span><span></span></li>' : ""}
          </ul>
        </div>`;
    }).join("");
  }

  // ---------- detail card ----------
  function utilityName(sourceId) {
    const s = state.summary && state.summary.sources.find((x) => x.source_id === sourceId);
    return s ? s.utility : sourceId;
  }

  function issuesFor(q) {
    const found = [];
    for (const [bit, flag] of state.flagsByBit) {
      if (q & bit) found.push(flag);
    }
    return found.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  }

  function renderDetail(props) {
    const hc = props.hc;
    const analyzed = hc !== undefined && hc !== null;
    const facts = [
      ["Feeder", props.feeder ? `<span class="code">${escapeHtml(props.feeder)}</span>` : "Not listed"],
      props.sub !== undefined ? ["Substation", props.sub ? escapeHtml(props.sub) : "Not listed"] : null,
      props.kv ? ["Voltage", `${props.kv} kV`] : null,
      props.ph !== undefined ? ["Phases", props.ph ? escapeHtml(props.ph) : "Not listed"] : null,
      props.ad ? ["Analysis date", fmtDate(props.ad)] : null,
    ].filter(Boolean);

    const issues = issuesFor(props.q || 0);
    const issuesHtml = issues.length
      ? `<div class="d-issues"><h3>Data issues on this line</h3><ul>${issues.map((f) => `
          <li><span class="dot sev-${f.severity}" aria-hidden="true"></span>
            <div><strong>${escapeHtml(f.title)}</strong><span>${escapeHtml(f.explanation)}</span></div></li>`).join("")}</ul></div>`
      : analyzed ? '<p class="d-clean">No data issues found on this line in the latest check.</p>' : "";

    const capacityHtml = analyzed
      ? `<div class="d-capacity">${fmtMW(hc)}<small>MW</small></div>
         <div class="d-caption"><span class="d-swatch" style="background:${colorFor(hc)}" aria-hidden="true"></span>${hc <= 0 ? "No room for new solar without upgrades" : "Estimated room for new solar here"}</div>`
      : `<div class="d-capacity is-none">Not analyzed</div>
         <div class="d-caption">The utility drew this line but published no capacity for it.</div>`;

    $("detail-body").innerHTML = `
      <div class="d-utility">${escapeHtml(utilityName(props.src))}</div>
      ${capacityHtml}
      <dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
      ${issuesHtml}`;
    $("detail").hidden = false;
  }

  function clearSelection(map) {
    $("detail").hidden = true;
    map.getSource("selected").setData({ type: "FeatureCollection", features: [] });
  }

  function wireClicks(map) {
    const clickable = ["capacity", "unanalyzed", "issues"];
    const hitBox = (point) => [[point.x - 6, point.y - 6], [point.x + 6, point.y + 6]];

    map.on("click", (e) => {
      const hits = map.queryRenderedFeatures(hitBox(e.point), { layers: clickable.filter((id) => map.getLayer(id)) });
      if (!hits.length) return clearSelection(map);
      const feature = hits[0];
      map.getSource("selected").setData({ type: "Feature", geometry: feature.geometry, properties: {} });
      renderDetail(feature.properties);
    });
    map.on("mousemove", (e) => {
      const hits = map.queryRenderedFeatures(hitBox(e.point), { layers: clickable.filter((id) => map.getLayer(id)) });
      map.getCanvas().style.cursor = hits.length ? "pointer" : "";
    });
  }

  // ---------- start ----------
  async function start() {
    const protocol = new pmtiles.Protocol();
    maplibregl.addProtocol("pmtiles", protocol.tile);

    const [style, summary] = await Promise.all([loadBasemap(), loadSummary()]);
    state.summary = summary;
    renderSummary(summary);

    const map = new maplibregl.Map({
      container: "map",
      style,
      center: cfg.startView.center,
      zoom: cfg.startView.zoom,
      minZoom: 4,
      maxZoom: 18,
      hash: true,
      attributionControl: { compact: true },
    });
    const padForPanel = () => {
      const wide = window.matchMedia("(min-width: 761px)").matches;
      map.setPadding(wide ? { left: $("panel").offsetWidth + 16, top: 0, right: 0, bottom: 0 } : { left: 0, top: 0, right: 0, bottom: 0 });
    };
    padForPanel();
    window.addEventListener("resize", padForPanel);
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "imperial" }), "bottom-right");

    map.on("load", () => {
      addLayers(map);
      applyFilters(map);
      wireClicks(map);
    });
    map.on("error", (e) => {
      if (e && e.sourceId === SOURCE) showStatus("The grid data could not be loaded. Try refreshing in a minute.");
    });
    wireControls(map);
    window.atlasMap = map; // handy for debugging in the browser console
  }

  start();
})();

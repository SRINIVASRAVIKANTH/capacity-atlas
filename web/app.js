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
  const BASEMAP_OVERRIDE = params.get("basemap"); // for testing: one style for both themes
  const SOURCE = "atlas";
  const LAYER = "lines";
  const PREFS_KEY = "capacity-atlas-display";

  // Capacity bands, darkest = no room, brightest = most room. Both scales stay readable with
  // common color blindness; cividis is tuned for red-green color blindness and keeps its order
  // even in grayscale. The plasma values must match --c0..--c5 in style.css.
  const PALETTES = {
    plasma: { c0: "#4a2c7a", c1: "#8b0aa5", c2: "#c7427c", c3: "#ef7b45", c4: "#fdb52e", c5: "#f0f921", none: "#5c6170" },
    cividis: { c0: "#273e6e", c1: "#4f576c", c2: "#777777", c3: "#a39a74", c4: "#d4c15f", c5: "#fee838", none: "#5c6170" },
  };

  // Everything on the map that changes with the light or dark theme.
  const THEMES = {
    // Halo colors are solid (no transparency): see-through lines darken wherever two
    // sections overlap at their ends, which made lines look like strings of beads.
    dark: {
      chrome: "#171A21", fallbackGround: "#12141a",
      casing: null, glow: 0.35,
      issueWarning: "#ffffff", issueError: "#ff6b6b",
      selectedLine: "#ffffff", selectedHalo: "#5960c8", feederHalo: "#353978",
    },
    light: {
      chrome: "#EEF0F3", fallbackGround: "#eef0f3",
      casing: "#4f5464", glow: 0,
      issueWarning: "#1b1e26", issueError: "#d62f2f",
      selectedLine: "#1b1e26", selectedHalo: "#7f86f0", feederHalo: "#b3b8f6",
    },
  };

  const ACCENT = "#6e76f0";
  const EMPTY = { type: "FeatureCollection", features: [] };
  const NOTHING = ["boolean", false]; // filter that matches no feature
  const HC = ["coalesce", ["get", "hc"], -1]; // lines without capacity compare as -1
  const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

  const state = {
    minMW: 0, hidden: new Set(), issuesOnly: false, summary: null, flagsByBit: new Map(),
    prefs: loadPrefs(), theme: null, selected: null, layersReady: false,
  };

  // ---------- helpers ----------
  const $ = (id) => document.getElementById(id);
  const fmtInt = (n) => Number(n).toLocaleString("en-US");
  const fmtMW = (v) => (v === 0 ? "0" : v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1).replace(/\.0$/, "") : v.toFixed(2).replace(/0$/, ""));
  const fmtLength = (m) => {
    const feet = m * 3.28084;
    return feet < 1000 ? `${fmtInt(Math.max(1, Math.round(feet / 10) * 10))} ft` : `${(feet / 5280).toFixed(feet < 52800 ? 1 : 0)} mi`;
  };
  const fmtDate = (iso) => new Date(iso + (iso.length === 10 ? "T12:00:00Z" : "")).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const colors = () => PALETTES[state.prefs.palette] || PALETTES.plasma;
  const look = () => THEMES[state.theme];

  function colorFor(mw) {
    const c = colors();
    if (mw === null || mw === undefined) return c.none;
    if (mw <= 0) return c.c0;
    if (mw < 0.5) return c.c1;
    if (mw < 1) return c.c2;
    if (mw < 2) return c.c3;
    if (mw < 5) return c.c4;
    return c.c5;
  }

  function showStatus(message, ms) {
    const el = $("status");
    el.textContent = message;
    el.hidden = false;
    clearTimeout(showStatus.timer);
    if (ms) showStatus.timer = setTimeout(() => (el.hidden = true), ms);
  }

  // ---------- display preferences (theme and color scale), remembered in this browser only ----------
  function loadPrefs() {
    const defaults = { theme: "auto", palette: "plasma" };
    try {
      const saved = JSON.parse(window.localStorage.getItem(PREFS_KEY) || "{}");
      return {
        theme: ["auto", "light", "dark"].includes(saved.theme) ? saved.theme : defaults.theme,
        palette: saved.palette in PALETTES ? saved.palette : defaults.palette,
      };
    } catch (err) {
      return defaults;
    }
  }

  function savePrefs() {
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs));
    } catch (err) {
      /* private windows can block storage; the choice still applies for this visit */
    }
  }

  const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
  const resolveTheme = () => (state.prefs.theme === "auto" ? (systemDark.matches ? "dark" : "light") : state.prefs.theme);

  function applyPageTheme(theme) {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]').setAttribute("content", THEMES[theme].chrome);
  }

  function applyPagePalette() {
    const root = document.documentElement.style;
    for (const [key, value] of Object.entries(colors())) root.setProperty("--" + key, value);
  }

  // ---------- basemap ----------
  const styleCache = new Map();

  async function loadBasemap(theme) {
    const url = BASEMAP_OVERRIDE || cfg.basemapStyles[theme];
    if (!styleCache.has(url)) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 6000);
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (!response.ok) throw new Error("HTTP " + response.status);
        styleCache.set(url, await response.json());
      } catch (err) {
        console.warn("Basemap unavailable, using a plain background:", err);
        return {
          version: 8, sources: {},
          layers: [{ id: "background", type: "background", paint: { "background-color": THEMES[theme].fallbackGround } }],
        };
      }
    }
    const style = structuredClone(styleCache.get(url));
    tuneBasemap(style, theme);
    return style;
  }

  // Keep roads and land quiet so the grid stands out, but keep place names easy to read.
  const DARK_PLACE_COLORS = {
    place_city_large: "#eceef3", place_city: "#e1e4ea", place_town: "#c4c8d2",
    place_village: "#a3a8b5", place_suburb: "#a3a8b5", place_other: "#9097a5",
    place_state: "#a9aebb", place_country_major: "#a9aebb", place_country_minor: "#a9aebb", place_country_other: "#a9aebb",
  };

  function tuneBasemap(style, theme) {
    for (const layer of style.layers || []) {
      const paint = (layer.paint = layer.paint || {});
      if (theme === "dark") {
        if (layer.type === "line") paint["line-opacity"] = 0.5;
        if (layer.type === "raster") paint["raster-opacity"] = 0.35;
        if (layer.type !== "symbol") continue;
        paint["icon-opacity"] = 0.6;
        const halo = "rgba(10, 11, 14, 0.92)";
        if (layer["source-layer"] === "place") {
          paint["text-color"] = DARK_PLACE_COLORS[layer.id] || "#a3a8b5";
          paint["text-halo-color"] = halo;
          paint["text-halo-width"] = 1.6;
        } else if (layer["source-layer"] === "transportation_name") {
          paint["text-color"] = "#8f94a1";
          paint["text-halo-color"] = halo;
          paint["text-halo-width"] = 1.4;
        } else if (layer["source-layer"] === "water_name") {
          paint["text-color"] = "#7088b3";
          paint["text-halo-color"] = halo;
          paint["text-halo-width"] = 1.2;
        }
      } else if (layer.type === "symbol" && layer["source-layer"] === "place") {
        paint["text-halo-width"] = 1.6; // light theme: keep the basemap's dark text, a little more halo over the lines
      }
    }
  }

  // Grid layers go under the basemap's labels, so city and street names stay on top.
  function firstLabelLayer(map) {
    const layer = map.getStyle().layers.find((l) => l.type === "symbol");
    return layer ? layer.id : undefined;
  }

  // ---------- map layers ----------
  // Two copies of every grid layer: "lines" (each section, zoom 11 and closer) and
  // "overview" (sections merged per feeder and capacity band, for zoomed-out views).
  // The tile file only holds each one at its own zooms, so they never draw together.
  const VARIANTS = [{ layer: LAYER, suffix: "" }, { layer: "overview", suffix: "-ov" }];
  const ids = (base) => VARIANTS.map((v) => base + v.suffix);
  const width = (base) => ["interpolate", ["linear"], ["zoom"], 5, base * 0.5, 9, base, 13, base * 2.2, 16, base * 4];
  const casingWidth = ["interpolate", ["linear"], ["zoom"], 5, 1.4, 9, 2.2, 13, 3.8, 16, 6.4];
  const round = { "line-cap": "round", "line-join": "round" };

  function capacityColor() {
    const c = colors();
    return ["step", HC, c.c0, 0.0001, c.c1, 0.5, c.c2, 1, c.c3, 2, c.c4, 5, c.c5];
  }

  function addLayers(map) {
    const t = look();
    const before = firstLabelLayer(map);
    const add = (layer) => map.addLayer(layer, before);
    const each = (make) => VARIANTS.forEach((v) => add(make({ source: SOURCE, "source-layer": v.layer }, v.suffix)));

    map.addSource(SOURCE, {
      type: "vector",
      url: "pmtiles://" + DATA_URL + "/atlas.pmtiles",
      attribution: "Grid data: utility hosting capacity maps",
    });

    // Light theme: a thin dark edge so pale yellow lines stay visible on a pale map.
    each((src, sfx) => ({ id: "casing" + sfx, type: "line", ...src, filter: ["has", "hc"], layout: round,
      paint: { "line-color": t.casing || "#000000", "line-width": casingWidth } }));
    each((src, sfx) => ({ id: "unanalyzed" + sfx, type: "line", ...src, filter: ["!", ["has", "hc"]], layout: { "line-cap": "butt" },
      paint: { "line-color": colors().none, "line-width": width(0.6), "line-dasharray": [2, 2], "line-opacity": 0.7 } }));
    // The whole feeder of the clicked line, a soft band under everything else.
    each((src, sfx) => ({ id: "feeder-halo" + sfx, type: "line", ...src, filter: NOTHING, layout: round,
      paint: { "line-color": t.feederHalo, "line-width": width(6), "line-blur": 1 } }));
    // Dark theme: a soft glow under lines with real room.
    each((src, sfx) => ({ id: "glow" + sfx, type: "line", ...src, filter: [">=", HC, 2], layout: round,
      paint: { "line-color": capacityColor(), "line-width": width(4), "line-blur": width(3), "line-opacity": t.glow } }));
    each((src, sfx) => ({ id: "capacity" + sfx, type: "line", ...src, filter: ["has", "hc"], layout: round,
      paint: { "line-color": capacityColor(), "line-width": width(1) } }));
    // Data issues, drawn over the flagged lines when the switch is on.
    each((src, sfx) => ({ id: "issues" + sfx, type: "line", ...src, filter: [">", ["coalesce", ["get", "qs"], 0], 0],
      layout: { visibility: "none", "line-cap": "round" },
      paint: {
        "line-color": ["match", ["get", "qs"], 2, t.issueError, t.issueWarning],
        "line-width": width(0.9), "line-dasharray": [1.5, 1.5], "line-opacity": 0.85,
      } }));

    // The clicked section, matched by its feature id (section number) so it is drawn
    // whole even where it crosses tile edges.
    const haloPaint = { "line-color": t.selectedHalo, "line-width": width(6.5), "line-blur": 1.5 };
    const linePaint = { "line-color": t.selectedLine, "line-width": width(2) };
    const lines = { source: SOURCE, "source-layer": LAYER };
    add({ id: "selected-halo", type: "line", ...lines, filter: NOTHING, layout: round, paint: haloPaint });
    add({ id: "selected-line", type: "line", ...lines, filter: NOTHING, layout: round, paint: linePaint });
    // Fallback for tiles built before sections were numbered: draw the clicked shape itself.
    map.addSource("selected", { type: "geojson", data: EMPTY });
    add({ id: "selected-shape-halo", type: "line", source: "selected", layout: round, paint: haloPaint });
    add({ id: "selected-shape", type: "line", source: "selected", layout: round, paint: linePaint });

    // A ring where the person clicked, so even a very short section is easy to find.
    map.addSource("click-point", { type: "geojson", data: EMPTY });
    map.addLayer({ id: "click-ring", type: "circle", source: "click-point",
      paint: { "circle-radius": 11, "circle-color": "rgba(0, 0, 0, 0)", "circle-stroke-width": 2.5, "circle-stroke-color": ACCENT } });
  }

  function applyPalette(map) {
    applyPagePalette();
    if (!state.layersReady) return;
    for (const id of [...ids("capacity"), ...ids("glow")]) map.setPaintProperty(id, "line-color", capacityColor());
    if (state.selected) renderDetail(state.selected.properties);
  }

  // ---------- filters ----------
  function applyFilters(map) {
    if (!state.layersReady) return;
    const t = look();
    const utility = state.hidden.size
      ? ["!", ["in", ["get", "src"], ["literal", Array.from(state.hidden)]]]
      : true;
    const minimum = state.minMW > 0 ? [">=", HC, state.minMW] : ["has", "hc"];
    const shown = ["all", ["has", "hc"], minimum, utility];
    const flagged = [">", ["coalesce", ["get", "qs"], 0], 0];

    for (const v of VARIANTS) {
      const id = (base) => base + v.suffix;
      map.setFilter(id("capacity"), shown);
      map.setFilter(id("casing"), shown);
      map.setLayoutProperty(id("casing"), "visibility", t.casing ? "visible" : "none");
      map.setFilter(id("glow"), ["all", [">=", HC, Math.max(2, state.minMW)], utility]);
      map.setFilter(id("unanalyzed"), ["all", ["!", ["has", "hc"]], utility]);
      map.setLayoutProperty(id("unanalyzed"), "visibility", state.minMW > 0 ? "none" : "visible");
      map.setFilter(id("issues"), state.minMW > 0 ? ["all", flagged, minimum, utility] : ["all", flagged, utility]);
      map.setLayoutProperty(id("issues"), "visibility", state.issuesOnly ? "visible" : "none");
      // With issues highlighted, fade the capacity colors so the flagged lines stand out.
      map.setPaintProperty(id("capacity"), "line-opacity", state.issuesOnly ? 0.3 : 1);
      map.setPaintProperty(id("casing"), "line-opacity", state.issuesOnly ? 0.25 : 1);
      map.setPaintProperty(id("glow"), "line-opacity", state.issuesOnly ? t.glow * 0.3 : t.glow);
      map.setPaintProperty(id("unanalyzed"), "line-opacity", state.issuesOnly ? 0.25 : 0.7);
    }
  }

  // ---------- theme switching ----------
  async function applyTheme(map) {
    const theme = resolveTheme();
    applyPageTheme(theme);
    if (theme === state.theme) return;
    state.theme = theme;
    state.layersReady = false;
    map.setStyle(await loadBasemap(theme), { diff: false });
    // "style.load" (wired in start) adds the grid layers back once the new basemap is ready.
  }

  function onStyleLoad(map) {
    if (map.getSource(SOURCE)) return; // already added for this basemap
    addLayers(map);
    state.layersReady = true;
    applyFilters(map);
    if (state.selected) select(map, state.selected);
  }

  // ---------- controls ----------
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

    document.querySelector(`#theme-choice input[value="${state.prefs.theme}"]`).checked = true;
    document.querySelector(`#palette-choice input[value="${state.prefs.palette}"]`).checked = true;
    $("theme-choice").addEventListener("change", (e) => {
      state.prefs.theme = e.target.value;
      savePrefs();
      applyTheme(map);
    });
    $("palette-choice").addEventListener("change", (e) => {
      state.prefs.palette = e.target.value;
      savePrefs();
      applyPalette(map);
    });
    systemDark.addEventListener("change", () => {
      if (state.prefs.theme === "auto") applyTheme(map);
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
          <span>${escapeHtml(c.title)}<span class="visually-hidden"> (${c.severity})</span></span>
          <span class="n">${fmtInt(c.flagged)}</span></li>`).join("");
      return `
        <div class="utility">
          <div class="utility-name">${escapeHtml(s.utility)}</div>
          <div class="utility-meta">Data from ${fmtDate(s.snapshot_date)}. Capacity published for ${analyzedPct}% of ${fmtInt(s.sections)} line sections.</div>
          <ul class="findings">
            ${list}
            ${errorsClean ? '<li><span class="dot sev-ok" aria-hidden="true"></span><span class="clean">No contradictory values found</span><span></span></li>' : ""}
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

  // Zoomed out, a click picks a whole feeder: show its range and offer to zoom in.
  function renderFeeder(props) {
    const range = props.fmax === undefined || props.fmax === null
      ? "Not analyzed"
      : props.fmin === props.fmax ? `${fmtMW(props.fmax)} MW` : `${fmtMW(props.fmin)} to ${fmtMW(props.fmax)} MW`;
    const facts = [
      ["Sections", fmtInt(props.fn)],
      ["Length", `${(props.fkm * 0.621371).toFixed(props.fkm < 16 ? 1 : 0)} mi`],
    ];
    $("detail-body").innerHTML = `
      <div class="d-utility">${escapeHtml(utilityName(props.src))}</div>
      <div class="d-capacity d-feeder">${props.feeder ? `Feeder <span class="code">${escapeHtml(props.feeder)}</span>` : "Lines with no feeder listed"}</div>
      <div class="d-caption">Room for new solar along this feeder: <strong>${range}</strong></div>
      <dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
      <div class="d-key">
        <div><span class="key-feeder" aria-hidden="true"></span>This feeder</div>
        <p>A feeder is one circuit leaving a substation. Zoom in to click its individual sections and see the capacity of each one.</p>
        ${props.fx0 !== undefined ? '<button class="d-action" id="zoom-feeder" type="button">Zoom to this feeder</button>' : ""}
      </div>`;
    $("detail").hidden = false;
    const button = $("zoom-feeder");
    if (button) {
      button.addEventListener("click", () => {
        window.atlasMap.fitBounds([[props.fx0, props.fy0], [props.fx1, props.fy1]], { padding: 60, maxZoom: 15 });
      });
    }
  }

  function renderDetail(props) {
    if (props.fn !== undefined) return renderFeeder(props);
    const hc = props.hc;
    const analyzed = hc !== undefined && hc !== null;
    const facts = [
      ["Feeder", props.feeder ? `<span class="code">${escapeHtml(props.feeder)}</span>` : "Not listed"],
      props.sub !== undefined ? ["Substation", props.sub ? escapeHtml(props.sub) : "Not listed"] : null,
      props.kv ? ["Voltage", `${props.kv} kV`] : null,
      props.m ? ["Section length", fmtLength(props.m)] : null,
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

    const keyHtml = `
      <div class="d-key">
        <div><span class="key-section" aria-hidden="true"></span>This section</div>
        ${props.feeder ? '<div><span class="key-feeder" aria-hidden="true"></span>Rest of the same feeder</div>' : ""}
        <p>Utilities split every feeder into short sections and publish a separate capacity for each one, so one street can change color from block to block.</p>
      </div>`;

    $("detail-body").innerHTML = `
      <div class="d-utility">${escapeHtml(utilityName(props.src))}</div>
      ${capacityHtml}
      <dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
      ${keyHtml}
      ${issuesHtml}`;
    $("detail").hidden = false;
  }

  function select(map, feature) {
    state.selected = feature;
    if (!state.layersReady) return;
    const p = feature.properties;
    const isFeeder = p.fn !== undefined; // zoomed-out click: the whole feeder, no single section
    const numbered = !isFeeder && feature.id !== undefined && feature.id !== null;
    const bySection = numbered ? ["==", ["id"], feature.id] : NOTHING;
    map.setFilter("selected-halo", bySection);
    map.setFilter("selected-line", bySection);
    map.getSource("selected").setData(numbered || isFeeder ? EMPTY : { type: "Feature", geometry: feature.geometry, properties: {} });
    const sameFeeder = p.feeder
      ? ["all", ["==", ["get", "src"], p.src], ["==", ["get", "feeder"], p.feeder]]
      : NOTHING;
    for (const id of ids("feeder-halo")) map.setFilter(id, sameFeeder);
    map.getSource("click-point").setData(isFeeder || !feature.at ? EMPTY
      : { type: "Feature", geometry: { type: "Point", coordinates: feature.at }, properties: {} });
  }

  function clearSelection(map) {
    state.selected = null;
    $("detail").hidden = true;
    if (!state.layersReady) return;
    for (const id of ["selected-halo", "selected-line", ...ids("feeder-halo")]) map.setFilter(id, NOTHING);
    map.getSource("selected").setData(EMPTY);
    map.getSource("click-point").setData(EMPTY);
  }

  function wireClicks(map) {
    const clickable = [...ids("capacity"), ...ids("unanalyzed"), ...ids("issues")];
    const hitBox = (point) => [[point.x - 6, point.y - 6], [point.x + 6, point.y + 6]];
    const hitsAt = (point) => (state.layersReady
      ? map.queryRenderedFeatures(hitBox(point), { layers: clickable.filter((id) => map.getLayer(id)) })
      : []);

    map.on("click", (e) => {
      const hits = hitsAt(e.point);
      if (!hits.length) return clearSelection(map);
      // Keep only what select() and renderDetail() need, so it survives a theme change.
      const feature = {
        id: hits[0].id, properties: { ...hits[0].properties }, geometry: hits[0].geometry,
        at: [e.lngLat.lng, e.lngLat.lat],
      };
      select(map, feature);
      renderDetail(feature.properties);
    });
    map.on("mousemove", (e) => {
      map.getCanvas().style.cursor = hitsAt(e.point).length ? "pointer" : "";
    });
  }

  // ---------- start ----------
  async function start() {
    const protocol = new pmtiles.Protocol();
    maplibregl.addProtocol("pmtiles", protocol.tile);

    state.theme = resolveTheme();
    applyPageTheme(state.theme);
    applyPagePalette();
    const [style, summary] = await Promise.all([loadBasemap(state.theme), loadSummary()]);
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

    map.on("style.load", () => onStyleLoad(map));
    if (map.isStyleLoaded()) onStyleLoad(map); // in case the first basemap finished before the listener
    map.on("error", (e) => {
      if (e && e.sourceId === SOURCE) showStatus("The grid data could not be loaded. Try refreshing in a minute.");
    });
    wireClicks(map);
    wireControls(map);
    window.atlasMap = map; // handy for debugging in the browser console
  }

  start();
})();

/* Capacity Atlas web map.
 *
 * Reads two files published every week by the GitHub pipeline:
 *   atlas.pmtiles  every line section with its capacity and data quality flags
 *   summary.json   per-utility totals and what each flag means
 */
(function () {
  "use strict";

  const cfg = window.ATLAS_CONFIG;
  // Test overrides (?data=...&basemap=...) work only on a local copy of the site. On the public
  // site they are ignored, so nobody can share a link that shows someone else's data here.
  const LOCAL = ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
  const params = LOCAL ? new URLSearchParams(window.location.search) : new URLSearchParams();
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
      issueWarning: "#fdb52e", issueError: "#ff6b6b", muted: "#3a3e49",
      selectedLine: "#ffffff", selectedHalo: "#5960c8", feederHalo: "#353978",
      chgMore: "#4d9dff", chgLess: "#ff9a3c", chgNew: "#c08cff", chgFeeder: "#e8e6e1",
    },
    light: {
      chrome: "#EEF0F3", fallbackGround: "#eef0f3",
      casing: "#4f5464", glow: 0,
      issueWarning: "#c27c00", issueError: "#d62f2f", muted: "#d2d5dc",
      selectedLine: "#1b1e26", selectedHalo: "#7f86f0", feederHalo: "#b3b8f6",
      chgMore: "#1f6fe0", chgLess: "#d96500", chgNew: "#8a4fe0", chgFeeder: "#1b1e26",
    },
  };

  const ACCENT = "#6e76f0";
  const EMPTY = { type: "FeatureCollection", features: [] };
  const NOTHING = ["boolean", false]; // filter that matches no feature
  const HC = ["coalesce", ["get", "hc"], -1]; // lines without capacity compare as -1
  const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

  const state = {
    minMW: 0, hidden: new Set(), issuesOnly: false, changesOnly: false, summary: null, flagsByBit: new Map(), limitsByBit: new Map(),
    prefs: loadPrefs(), theme: null, selected: null, layersReady: false,
    site: { picking: false, busy: false, data: null, marker: null }, lastPlace: null,
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

  // ---------- opening and closing panels ----------
  // Panels fold away with a short animation instead of vanishing. While one is leaving it
  // counts as closed, and opening it again cancels the fold. People who ask their system for
  // reduced motion get the instant version.
  const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const isShown = (el) => !el.hidden && !el.classList.contains("is-leaving");
  function showSoftly(el) {
    el.classList.remove("is-leaving");
    el.hidden = false;
  }
  function hideSoftly(el) {
    if (!isShown(el)) return;
    if (reduceMotion()) { el.hidden = true; return; }
    el.classList.add("is-leaving");
    const done = () => {
      el.removeEventListener("animationend", onEnd);
      if (!el.classList.contains("is-leaving")) return; // reopened meanwhile
      el.classList.remove("is-leaving");
      el.hidden = true;
    };
    const onEnd = (e) => { if (e.target === el && !e.pseudoElement) done(); }; // not the light or anything inside
    el.addEventListener("animationend", onEnd);
    setTimeout(done, 400); // in case the browser skips the animation
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
    } catch {
      return defaults;
    }
  }

  function savePrefs() {
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs));
    } catch {
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
      layout: { visibility: "none", "line-cap": "butt" },
      paint: {
        "line-color": ["match", ["get", "qs"], 2, t.issueError, t.issueWarning],
        "line-width": width(1.5), "line-dasharray": [2, 1],
      } }));

    // Changes since the previous weekly snapshot, drawn over the muted network when the switch
    // is on. Sections show the direction of the change; zoomed out, each changed feeder.
    each((src, sfx) => ({ id: "changes" + sfx, type: "line", ...src,
      filter: sfx ? [">", ["coalesce", ["get", "fc"], 0], 0] : ["has", "ch"],
      layout: { visibility: "none", ...round },
      paint: {
        "line-color": sfx ? t.chgFeeder : ["match", ["get", "ch"], 1, t.chgMore, 3, t.chgNew, t.chgLess],
        "line-width": width(1.6),
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

    // Site check: a dashed link from the chosen spot to the nearest line that fits the project.
    map.addSource("site", { type: "geojson", data: state.site.data || EMPTY });
    map.addLayer({ id: "site-link", type: "line", source: "site", filter: ["==", ["geometry-type"], "LineString"],
      layout: round, paint: { "line-color": t.selectedLine, "line-width": 2.5, "line-dasharray": [1.5, 1.5] } });
    map.addLayer({ id: "site-target", type: "circle", source: "site", filter: ["==", ["geometry-type"], "Point"],
      paint: { "circle-radius": 6, "circle-color": ACCENT, "circle-stroke-width": 2.5, "circle-stroke-color": "#ffffff" } });
  }

  function applyPalette(map) {
    applyPagePalette();
    if (!state.layersReady) return;
    for (const id of ids("glow")) map.setPaintProperty(id, "line-color", capacityColor());
    applyFilters(map); // sets the capacity colors (or the muted gray while issues are highlighted)
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
    const highlighting = state.issuesOnly || state.changesOnly;

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
      const changed = v.suffix ? [">", ["coalesce", ["get", "fc"], 0], 0] : ["has", "ch"];
      map.setFilter(id("changes"), ["all", changed, utility]);
      map.setLayoutProperty(id("changes"), "visibility", state.changesOnly ? "visible" : "none");
      // While issues or changes are highlighted, every other line turns one solid quiet gray.
      // Solid, not see-through: transparent lines darken where sections overlap and look dashed.
      map.setPaintProperty(id("capacity"), "line-color", highlighting ? t.muted : capacityColor());
      if (highlighting) {
        map.setLayoutProperty(id("casing"), "visibility", "none");
        map.setLayoutProperty(id("unanalyzed"), "visibility", "none");
      }
      map.setPaintProperty(id("glow"), "line-opacity", highlighting ? 0 : t.glow);
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
    $("min-mw").addEventListener("change", (e) => setMinMW(map, Number(e.target.value)));
    $("issues-toggle").addEventListener("change", (e) => setIssues(map, e.target.checked));
    $("changes-toggle").addEventListener("change", (e) => setChanges(map, e.target.checked));
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

    // Toolbar popovers (display settings, guide): one open at a time.
    const popovers = { display: ["display-toggle", "display-menu"], help: ["help-toggle", "help"] };
    const setPopover = (name, open) => {
      for (const [key, [button, panel]] of Object.entries(popovers)) {
        const show = key === name && open;
        if (show) showSoftly($(panel));
        else hideSoftly($(panel));
        $(button).setAttribute("aria-expanded", String(show));
      }
    };
    const isOpen = (name) => isShown($(popovers[name][1]));
    $("display-toggle").addEventListener("click", () => setPopover("display", !isOpen("display")));
    $("help-toggle").addEventListener("click", () => setPopover("help", !isOpen("help")));
    $("help-close").addEventListener("click", () => setPopover("help", false));
    document.addEventListener("click", (e) => {
      if (isOpen("display") && !e.target.closest(".display")) setPopover("display", false);
    });
    state.openGuide = () => setPopover("help", true);

    $("detail-close").addEventListener("click", () => clearSelection(map));
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (state.site.picking) stopPicking(map);
      else if (isOpen("display") || isOpen("help")) setPopover(null, false);
      else if (!$("search-results").hidden) $("search-results").hidden = true;
      else if (!$("detail").hidden) clearSelection(map);
      else if (state.closeAssistant && !$("assistant-panel").hidden) state.closeAssistant();
    });

    // The panel folds down to its title and color key, on any screen size.
    const setCollapsed = (collapsed) => {
      $("panel").classList.toggle("is-collapsed", collapsed);
      for (const id of ["panel-toggle", "sheet-toggle"]) $(id).setAttribute("aria-expanded", String(!collapsed));
      const label = collapsed ? "Expand panel" : "Collapse panel";
      $("panel-toggle").title = label;
      $("panel-toggle-label").textContent = label;
      padForPanel(map);
    };
    for (const id of ["panel-toggle", "sheet-toggle"]) {
      $(id).addEventListener("click", () => setCollapsed(!$("panel").classList.contains("is-collapsed")));
    }
    state.setCollapsed = setCollapsed;
    if (window.matchMedia("(max-width: 760px)").matches) setCollapsed(true);

    // First visit: offer the guide once.
    if (!readFlag(HINT_KEY)) $("hint").hidden = false;
    $("hint-close").addEventListener("click", dismissHint);
    $("hint-open").addEventListener("click", () => {
      dismissHint();
      state.openGuide();
    });

    wireSearch(map);
    wireSite(map);
    wireDownload(map);
    wireAssistant(map);

    $("repo-link").href = cfg.repoUrl;
  }

  const HINT_KEY = "capacity-atlas-hint-seen";
  function readFlag(key) {
    try { return window.localStorage.getItem(key) === "1"; } catch { return false; }
  }
  function dismissHint() {
    $("hint").hidden = true;
    try { window.localStorage.setItem(HINT_KEY, "1"); } catch { /* storage blocked: the tip just returns next visit */ }
  }

  // ---------- place search ----------
  // Photon (komoot) geocoder over OpenStreetMap data, biased to New York. It runs only when
  // the person presses Enter, never on each keystroke, to respect the free service's fair use.
  const NY_BBOX = [-79.8, 40.4, -71.8, 45.1];
  const COORDS = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

  // Photon place lookup, shared by place search and AI search.
  // A signal that cancels a request after `ms`, where the browser supports it.
  const withTimeout = (ms) => (typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);

  async function geocode(query, limit) {
    const url = `${cfg.searchUrl}?q=${encodeURIComponent(query)}&limit=${limit}&lang=en&bbox=${NY_BBOX.join(",")}`;
    const response = await fetch(url, { signal: withTimeout(10000) });
    if (!response.ok) throw new Error("HTTP " + response.status);
    return ((await response.json()).features || []).filter((f) => f.geometry && f.geometry.type === "Point");
  }

  function wireSearch(map) {
    const form = $("search");
    const input = $("search-input");
    const list = $("search-results");
    const show = (html) => { list.innerHTML = html; list.hidden = false; };
    let pin = null;
    const flyTo = (lng, lat, extent, zoom = 14) => {
      list.hidden = true;
      clearSelection(map);
      // A pin marks the searched place, so it is easy to find among the lines.
      if (pin) pin.remove();
      const el = document.createElement("div");
      el.className = "search-pin";
      pin = new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map);
      state.lastPlace = [lng, lat];
      $("site-here").hidden = false;
      if (extent) map.fitBounds([[extent[0], extent[3]], [extent[2], extent[1]]], { padding: 40, maxZoom: zoom, minZoom: 11 });
      else map.flyTo({ center: [lng, lat], zoom });
    };
    state.flyToPlace = flyTo;

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const query = input.value.trim();
      if (!query) return;
      const coords = query.match(COORDS);
      if (coords) {
        const lat = Number(coords[1]), lng = Number(coords[2]);
        if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return flyTo(lng, lat);
      }
      show('<li class="search-msg">Searching</li>');
      try {
        const results = await geocode(query, 6);
        if (!results.length) return show('<li class="search-msg">No places found in New York. Try a town name or lat, long. For questions, use the assistant.</li>');
        show(results.map((f, i) => {
          const p = f.properties || {};
          const where = [p.city && p.city !== p.name ? p.city : null, p.county, p.state].filter(Boolean).join(", ");
          return `<li><button type="button" data-i="${i}">${escapeHtml(p.name || p.street || "Unnamed place")}<small>${escapeHtml(where)}</small></button></li>`;
        }).join("") + '<li class="search-credit">Search by Photon, data from OpenStreetMap</li>');
        list.querySelectorAll("button[data-i]").forEach((b) => b.addEventListener("click", () => {
          const f = results[Number(b.dataset.i)];
          flyTo(f.geometry.coordinates[0], f.geometry.coordinates[1], f.properties && f.properties.extent);
        }));
      } catch (err) {
        console.warn("Search failed:", err);
        show('<li class="search-msg">Search is unavailable right now. You can enter coordinates instead, for example 42.65, -73.75.</li>');
      }
    });
    document.addEventListener("click", (e) => {
      if (!list.hidden && !form.contains(e.target)) list.hidden = true;
    });
  }

  // ---------- grid assistant (AI) ----------
  // Claude only turns the question into map settings. Every number in a reply, counts and
  // distances alike, is computed here from the utilities' data on the map.
  function setMinMW(map, value) {
    state.minMW = value || 0;
    let matched = false;
    document.querySelectorAll("#min-mw input").forEach((r) => {
      r.checked = Number(r.value) === state.minMW;
      matched = matched || r.checked;
    });
    // Volta can ask for any size (1.5 MW, 3 MW); say so when no button matches it.
    const note = $("min-custom");
    note.hidden = matched;
    if (!matched) note.innerHTML = `Minimum set by Volta: <strong>${fmtMW(state.minMW)} MW</strong>`;
    applyFilters(map);
  }

  function setUtility(map, only) {
    state.hidden = new Set();
    document.querySelectorAll("#utility-toggles input").forEach((box) => {
      box.checked = !only || box.value === only;
      if (!box.checked) state.hidden.add(box.value);
    });
    applyFilters(map);
  }

  // Issues and changes each gray out the rest of the network, so only one is on at a time.
  function setIssues(map, on) {
    $("issues-toggle").checked = on;
    state.issuesOnly = on;
    $("issues-details").hidden = !on;
    if (on && state.changesOnly) setChanges(map, false);
    applyFilters(map);
  }

  function setChanges(map, on) {
    on = on && !$("changes-toggle").disabled;
    $("changes-toggle").checked = on;
    state.changesOnly = on;
    $("changes-details").hidden = !on;
    if (on && state.issuesOnly) setIssues(map, false);
    applyFilters(map);
  }

  function highlightFeeder(map, src, feeder) {
    const same = ["all", ["==", ["get", "src"], src], ["==", ["get", "feeder"], feeder]];
    for (const id of ids("feeder-halo")) map.setFilter(id, same);
    const parts = map.queryRenderedFeatures({ layers: [...ids("capacity"), ...ids("unanalyzed")], filter: same });
    if (!parts.length) return;
    const bounds = new maplibregl.LngLatBounds();
    for (const f of parts) {
      const lines = f.geometry.type === "LineString" ? [f.geometry.coordinates] : f.geometry.coordinates;
      for (const line of lines) for (const c of line) bounds.extend(c);
    }
    map.fitBounds(bounds, { padding: 80, maxZoom: 15 });
  }

  // Count what the map shows now: sections (zoomed in) or feeders (zoomed out) meeting the minimum.
  function summarizeView(map) {
    const zoomedIn = map.getZoom() >= 11;
    const layer = zoomedIn ? "capacity" : "capacity-ov";
    const seen = new Set();
    const feeders = new Map();
    let sections = 0, meters = 0;
    for (const f of map.queryRenderedFeatures({ layers: [layer] })) {
      const p = f.properties;
      const key = zoomedIn ? f.id : `${p.src}|${p.feeder}|${p.hc}|${p.qs}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sections += 1;
      meters += p.m || 0;
      if (!p.feeder) continue;
      const fk = `${p.src}|${p.feeder}`;
      const best = feeders.get(fk);
      if (!best || p.hc > best.hc) feeders.set(fk, { src: p.src, feeder: p.feeder, hc: p.hc });
    }
    const top = [...feeders.values()].sort((a, b) => b.hc - a.hc).slice(0, 3);
    return { zoomedIn, sections, miles: meters / 1609.34, feeders: feeders.size, top };
  }

  // True when any utility line is loaded around the current view, whatever the filters are.
  function hasGridData(map) {
    const sourceLayer = map.getZoom() >= 11 ? LAYER : "overview";
    return map.querySourceFeatures(SOURCE, { sourceLayer }).length > 0;
  }

  // For data quality questions: count flagged lines in view, worst feeders first.
  function describeIssues(map) {
    const zoomedIn = map.getZoom() >= 11;
    const layer = zoomedIn ? "issues" : "issues-ov";
    const seen = new Set();
    const feeders = new Map();
    let warnings = 0, errors = 0;
    for (const f of map.queryRenderedFeatures({ layers: [layer] })) {
      const p = f.properties;
      const key = zoomedIn ? f.id : `${p.src}|${p.feeder}|${p.hc}|${p.qs}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (p.qs === 2) errors += 1; else warnings += 1;
      if (!p.feeder) continue;
      const fk = `${p.src}|${p.feeder}`;
      const entry = feeders.get(fk) || { src: p.src, feeder: p.feeder, n: 0 };
      entry.n += 1;
      feeders.set(fk, entry);
    }
    if (!warnings && !errors) return "<p>No warnings or errors in this view. The utility data here passed every check.</p>";
    const unit = zoomedIn ? "line sections" : "merged line groups";
    const facts = `In this view, <strong>${fmtInt(warnings + errors)} ${unit}</strong> on <strong>${fmtInt(feeders.size)} feeders</strong> are flagged: ${fmtInt(errors)} with errors, ${fmtInt(warnings)} with warnings. Select a dashed line to see why.`;
    const top = [...feeders.values()].sort((a, b) => b.n - a.n).slice(0, 3).map((t) =>
      `<li><button type="button" data-src="${escapeHtml(t.src)}" data-feeder="${escapeHtml(t.feeder)}">Feeder <span class="code">${escapeHtml(t.feeder)}</span></button><span>${fmtInt(t.n)} flagged</span></li>`).join("");
    return `<p>${facts}</p>${top ? `<p class="msg-sub">Most flagged feeders in view</p><ul class="msg-top">${top}</ul>` : ""}`;
  }

  function describeSite(result, mw, from) {
    const need = mw >= 0.1 ? `room for ${fmtMW(mw)} MW` : "published capacity";
    if (!result) return "<p>The site check could not finish. Please try again.</p>";
    if (result.none) {
      return `<p>No line with ${need} within about ${escapeHtml(fmtMiles(result.searchedKm))} of ${escapeHtml(from)}. Try a smaller project size.</p>`;
    }
    const p = result.feature.properties;
    const value = p.hc !== undefined ? `${fmtMW(p.hc)} MW at that section` : `up to ${fmtMW(p.fmax)} MW on that feeder`;
    return `<p>The nearest line with ${need} is <strong>${escapeHtml(fmtMiles(result.km))}</strong> from ${escapeHtml(from)}, in a straight line: ` +
      `${p.feeder ? `feeder <span class="code">${escapeHtml(p.feeder)}</span>, ` : ""}${value}.</p>`;
  }

  function describe(summary, minMW) {
    const need = minMW ? `at least ${fmtMW(minMW)} MW of hosting capacity` : "published hosting capacity";
    if (!summary.feeders && !summary.sections) {
      return `<p>No lines in this view have ${need}. Try a nearby area, zoom out, or a smaller project size.</p>`;
    }
    const facts = summary.zoomedIn
      ? `In this view, <strong>${fmtInt(summary.sections)} line sections</strong> (${summary.miles.toFixed(summary.miles < 10 ? 1 : 0)} mi) on <strong>${fmtInt(summary.feeders)} feeders</strong> have ${need}.`
      : `In this view, <strong>${fmtInt(summary.feeders)} feeders</strong> have lines with ${need}. Zoom in to count individual sections.`;
    const top = summary.top.map((t) =>
      `<li><button type="button" data-src="${escapeHtml(t.src)}" data-feeder="${escapeHtml(t.feeder)}">Feeder <span class="code">${escapeHtml(t.feeder)}</span></button><span>${summary.zoomedIn ? "up to" : "from"} ${fmtMW(t.hc)} MW</span></li>`).join("");
    return `<p>${facts}</p>${top ? `<p class="msg-sub">Highest capacity in view</p><ul class="msg-top">${top}</ul>` : ""}`;
  }

  function addMessage(who, html) {
    const el = document.createElement("div");
    el.className = `msg msg-${who}`;
    el.innerHTML = html;
    $("chat-log").appendChild(el);
    $("chat-log").scrollTop = $("chat-log").scrollHeight;
    return el;
  }

  // Volta: a small sun with a visor, colored with the map's own capacity scale,
  // circled by a current. Its eyes follow the pointer.
  function voltaSVG(id) {
    return `<svg viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <radialGradient id="${id}-sun" cx="0.35" cy="0.3" r="0.85">
          <stop offset="0" stop-color="#f0f921"/><stop offset="0.35" stop-color="#fdb52e"/>
          <stop offset="0.7" stop-color="#c7427c"/><stop offset="1" stop-color="#4a2c7a"/>
        </radialGradient>
      </defs>
      <path class="v-bolt" d="M34 2 28.5 11h4L30 18l7-10h-4.2L35.5 2z"/>
      <circle class="v-head" cx="32" cy="36" r="20" fill="url(#${id}-sun)"/>
      <rect class="v-visor" x="17" y="29" width="30" height="13" rx="6.5"/>
      <g class="v-eyes"><rect class="v-eye" x="23" y="32" width="5" height="7" rx="2.5"/><rect class="v-eye" x="36" y="32" width="5" height="7" rx="2.5"/></g>
      <ellipse class="v-orbit" cx="32" cy="36" rx="29" ry="9" transform="rotate(-16 32 36)"/>
      <circle class="v-spark" r="2.4"/>
    </svg>`;
  }

  function wireVoltaEyes() {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0;
    window.addEventListener("pointermove", (e) => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        document.querySelectorAll(".volta").forEach((el) => {
          const r = el.getBoundingClientRect();
          const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
          const d = Math.hypot(dx, dy) || 1;
          const eyes = el.querySelector(".v-eyes");
          if (eyes) eyes.style.transform = `translate(${(2.6 * dx / d).toFixed(2)}px, ${(1.6 * dy / d).toFixed(2)}px)`;
        });
      });
    });
  }

  function wireAssistant(map) {
    if (!cfg.askUrl) return;
    document.querySelectorAll("[data-volta]").forEach((el) => (el.innerHTML = voltaSVG("volta-" + el.dataset.volta)));
    wireVoltaEyes();
    $("assistant").hidden = false;
    const panel = $("assistant-panel");
    const greeting = $("greeting");
    const hideGreeting = () => {
      greeting.hidden = true;
      try { sessionStorage.setItem("volta-greeted", "1"); } catch { /* ignore */ }
    };
    let greeted = false;
    try { greeted = sessionStorage.getItem("volta-greeted") === "1"; } catch { /* ignore */ }
    if (!greeted) {
      setTimeout(() => { if (panel.hidden) greeting.hidden = false; }, 1500);
      // The greeting sits over the map's zoom buttons, so it steps aside on its own: after a
      // short while, or as soon as the person starts using the map.
      setTimeout(() => { if (!greeting.hidden) hideGreeting(); }, 12000);
      for (const type of ["mousedown", "touchstart", "wheel"]) {
        map.getCanvasContainer().addEventListener(type, () => { if (!greeting.hidden) hideGreeting(); }, { passive: true });
      }
    }
    $("greeting-close").addEventListener("click", hideGreeting);
    $("greeting-open").addEventListener("click", () => setOpen(true));
    const setOpen = (open) => {
      if (open) hideGreeting();
      if (open && state.foldCredits) state.foldCredits();
      if (open) showSoftly(panel);
      else hideSoftly(panel);
      $("assistant-toggle").setAttribute("aria-expanded", String(open));
      document.body.classList.toggle("assistant-open", open);
      if (open) setTimeout(() => $("chat-input").focus(), 50);
    };
    state.closeAssistant = () => setOpen(false);
    $("assistant-toggle").addEventListener("click", () => setOpen(!isShown(panel)));
    $("assistant-close").addEventListener("click", () => setOpen(false));
    // "New chat": back to the first message with its example questions, and every filter cleared.
    const welcome = $("chat-log").innerHTML;
    $("assistant-reset").addEventListener("click", () => {
      if (asking) return;
      setMinMW(map, 0);
      setUtility(map, null);
      setIssues(map, false);
      setChanges(map, false);
      clearSelection(map);
      $("chat-log").innerHTML = welcome;
      chat.length = 0; // a new chat starts without memory of the old one
      $("chat-input").value = "";
      $("chat-input").focus();
    });
    $("chat-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const q = $("chat-input").value.trim();
      if (!q || asking) return; // while Volta is answering, the typed question waits in the box
      $("chat-input").value = "";
      askAI(map, q);
    });
    $("chat-log").addEventListener("click", (e) => {
      const chip = e.target.closest(".chips button");
      if (chip) return askAI(map, chip.textContent);
      const b = e.target.closest("button[data-feeder]");
      if (b) highlightFeeder(map, b.dataset.src, b.dataset.feeder);
    });
    panel.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        $("assistant-toggle").focus();
      }
    });
  }

  let asking = false;
  // Volta remembers the last few questions of this chat and the settings it chose, so a
  // follow-up like "and for 5 MW?" keeps the place. Kept only in this page, never stored.
  const CHAT_MEMORY = 3;
  const chat = [];
  function remember(question, plan) {
    const { place, min_mw, utility, show_issues, nearest } = plan;
    chat.push({ question, plan: { place, min_mw, utility, show_issues, nearest } });
    if (chat.length > CHAT_MEMORY) chat.shift();
  }

  async function askAI(map, question) {
    if (asking) return;
    asking = true;
    $("chat-send").disabled = true;
    addMessage("user", `<p>${escapeHtml(question)}</p>`);
    const reply = addMessage("bot", '<p class="typing" aria-label="Thinking"><span></span><span></span><span></span></p>');
    try {
      let plan;
      try {
        const response = await fetch(cfg.askUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question, history: chat }),
          signal: withTimeout(25000),
        });
        plan = await response.json();
        if (!response.ok) throw new Error(plan.error || "HTTP " + response.status);
      } catch (err) {
        console.warn("Assistant failed:", err);
        const message = err && err.message && !/^HTTP|fetch|JSON|Unexpected/i.test(err.message) ? err.message : "The assistant is unavailable right now.";
        reply.innerHTML = `<p>${escapeHtml(message)} You can still use place search and the filters.</p>`;
        return;
      }
      if (!plan.out_of_scope) remember(question, plan);
      if (plan.out_of_scope) {
        reply.innerHTML = `<p>${escapeHtml(plan.reply || "I can help with solar hosting capacity in this part of New York.")}</p>`;
        return;
      }
      // A general question ("What does hosting capacity mean?") gets an answer in words and
      // leaves the map and the person's filters exactly as they were.
      if (!plan.place && !plan.min_mw && !plan.utility && !plan.show_issues) {
        reply.innerHTML = `<p>${escapeHtml(plan.reply || "Ask me about a place and a project size, and I will set the map.")}</p>`;
        return;
      }
      setUtility(map, plan.utility);
      setMinMW(map, plan.min_mw);
      setIssues(map, plan.show_issues);
      reply.innerHTML = `<p>${escapeHtml(plan.reply)}</p><p class="typing" aria-label="Updating the map"><span></span><span></span><span></span></p>`;
      let spot = null;
      const coords = plan.place && plan.place.match(COORDS);
      if (coords && Math.abs(coords[1]) <= 90 && Math.abs(coords[2]) <= 180) {
        spot = [Number(coords[2]), Number(coords[1])];
        state.flyToPlace(spot[0], spot[1], null, 12.5); // "42.65, -73.75" needs no lookup
      } else if (plan.place) {
        try {
          const [place] = await geocode(plan.place, 1);
          if (place) {
            const [lng, lat] = place.geometry.coordinates;
            spot = [lng, lat];
            state.flyToPlace(lng, lat, place.properties && place.properties.extent, 12.5);
          } else {
            reply.innerHTML = `<p>${escapeHtml(plan.reply)}</p><p>I could not find ${escapeHtml(plan.place)}, so the filters apply to the current view.</p><p class="typing"><span></span><span></span><span></span></p>`;
          }
        } catch (err) {
          console.warn("Place lookup failed:", err);
        }
      }
      if (plan.nearest) {
        const from = spot || map.getCenter().toArray();
        const mw = plan.min_mw || 0.01;
        if (plan.min_mw) $("site-mw").value = plan.min_mw;
        const result = await checkSite(map, from, mw);
        reply.querySelector(".typing")?.remove();
        reply.insertAdjacentHTML("beforeend", describeSite(result, mw, spot ? plan.place.replace(/, New York$/, "") : "the map center"));
        $("chat-log").scrollTop = $("chat-log").scrollHeight;
        return;
      }
      // Wait for the map to finish drawing, but never leave the answer hanging.
      await new Promise((resolve) => { map.once("idle", resolve); map.triggerRepaint(); setTimeout(resolve, 10000); });
      reply.querySelector(".typing")?.remove();
      reply.insertAdjacentHTML("beforeend", !hasGridData(map)
        ? "<p>No utility lines in this view. The map covers Central Hudson (Hudson Valley) and National Grid (upstate New York) so far.</p>"
        : plan.show_issues ? describeIssues(map) : describe(summarizeView(map), plan.min_mw));
      $("chat-log").scrollTop = $("chat-log").scrollHeight;
    } finally {
      asking = false;
      $("chat-send").disabled = false;
    }
  }

  // ---------- map controls ----------
  // Returns to the starting view of the whole service area.
  class HomeControl {
    onAdd(map) {
      this.container = document.createElement("div");
      this.container.className = "maplibregl-ctrl maplibregl-ctrl-group";
      this.container.innerHTML = '<button type="button" title="Reset view" aria-label="Reset view"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 11l8-7 8 7M6 9.5V20h12V9.5" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round" stroke-linecap="round"/></svg></button>';
      this.container.querySelector("button").addEventListener("click", () => map.flyTo({ center: cfg.startView.center, zoom: cfg.startView.zoom }));
      return this.container;
    }
    onRemove() { this.container.remove(); }
  }

  // Keep the map's center clear of the side panel on wide screens.
  function padForPanel(map) {
    const wide = window.matchMedia("(min-width: 761px)").matches;
    const open = !$("panel").classList.contains("is-collapsed");
    map.setPadding({ left: wide && open ? $("panel").offsetWidth + 16 : 0, top: 0, right: 0, bottom: 0 });
  }

  // ---------- summary panel ----------
  async function loadSummary() {
    try {
      const response = await fetch(DATA_URL + "/summary.json", { cache: "no-cache", signal: withTimeout(15000) });
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
      const message = '<p class="note">The weekly check results could not be loaded. The map still shows the latest published data.</p>';
      quality.innerHTML = message;
      $("check-summary").innerHTML = message;
      $("change-summary").innerHTML = '<p class="note">The weekly comparison could not be loaded.</p>';
      $("changes-toggle").disabled = true;
      $("changes-switch").hidden = true;
      return;
    }
    for (const flag of summary.flags) state.flagsByBit.set(flag.bit, flag);
    for (const limit of summary.limits || []) state.limitsByBit.set(limit.bit, limit); // older summaries have none
    $("rule-count").textContent = new Set(summary.sources.flatMap((x) => x.checks.map((c) => c.id))).size;

    toggles.innerHTML = summary.sources.map((s) => `
      <label class="check">
        <input type="checkbox" value="${escapeHtml(s.source_id)}" checked>
        <span>${escapeHtml(s.utility)}</span>
        <span class="count">${fmtInt(s.sections)} sections</span>
      </label>`).join("");

    // One line per utility, always visible: the overall result of this week's check.
    $("check-summary").innerHTML = summary.sources.map((s) => {
      const has = (severity) => s.checks.some((c) => c.severity === severity && c.flagged > 0);
      // A labeled badge, so the result reads as a status, not as something drawn on the map.
      const [cls, text] = has("error") ? ["badge-error", "Errors found"]
        : has("warning") ? ["badge-warning", "Warnings only"]
        : ["badge-ok", "All checks passed"];
      return `<div class="cs-result"><span class="cs-name">${escapeHtml(s.utility)}</span><span class="cs-badge ${cls}">${text}</span></div>`;
    }).join("");

    renderChanges(summary);

    // Coverage comes from the data, so adding a utility or a state updates it by itself.
    const STATE_NAMES = { NY: "New York", NJ: "New Jersey", MA: "Massachusetts", CT: "Connecticut", PA: "Pennsylvania" };
    const inWords = (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);
    const states = [...new Set(summary.sources.map((s) => STATE_NAMES[s.state] || s.state))];
    if (summary.sources.length) $("coverage").textContent = `Coverage: ${inWords(summary.sources.map((s) => s.utility))}, ${inWords(states)}.`;

    const newest = summary.sources.map((s) => s.snapshot_date).sort().pop();
    if (newest) $("updated").textContent = `Data as of ${fmtDate(newest)}. Updated every Monday.`;

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
          <div class="utility-meta">Data as of ${fmtDate(s.snapshot_date)}. Hosting capacity published for ${analyzedPct}% of ${fmtInt(s.sections)} line sections.</div>
          <ul class="findings">
            ${list}
            ${errorsClean ? '<li><span class="dot sev-ok" aria-hidden="true"></span><span class="clean">No contradictory values found</span><span></span></li>' : ""}
          </ul>
        </div>`;
    }).join("");
  }

  // One line per utility: what changed since its previous weekly snapshot.
  function renderChanges(summary) {
    let total = 0;
    $("change-summary").innerHTML = summary.sources.map((s) => {
      const c = s.changes;
      let text;
      let changed = false;
      if (!("changes" in s)) {
        text = "Changes appear after the next weekly update"; // map data built before this feature
      } else if (!c || !c.since) {
        text = "Changes appear after the second weekly update"; // the first week has nothing to compare with
      } else {
        const shown = (c.less || 0) + (c.more || 0) + (c.new || 0) + (c.unpublished || 0);
        const parts = [
          c.less ? `${fmtInt(c.less)} lost capacity` : null,
          c.more ? `${fmtInt(c.more)} gained capacity` : null,
          c.new ? `${fmtInt(c.new)} are new` : null,
          c.unpublished ? `${fmtInt(c.unpublished)} no longer have a value` : null,
        ].filter(Boolean);
        total += shown;
        changed = shown > 0 || c.removed > 0;
        const where = c.feeders ? ` on ${fmtInt(c.feeders)} ${c.feeders === 1 ? "feeder" : "feeders"}` : "";
        const removed = c.removed ? ` ${fmtInt(c.removed)} ${c.removed === 1 ? "section was" : "sections were"} removed.` : "";
        text = changed
          ? (shown ? `Since ${fmtDate(c.since)}, ${fmtInt(shown)} sections${where} changed: ${parts.join(", ")}.` : `Since ${fmtDate(c.since)}:`) + removed
          : `No changes since ${fmtDate(c.since)}.`;
      }
      return `<div class="cs-row"><span class="dot ${changed ? "chg-yes" : "chg-none"}" aria-hidden="true"></span><span class="cs-name">${escapeHtml(s.utility)}</span><span class="cs-detail">${escapeHtml(text)}</span></div>`;
    }).join("");
    // The switch appears only when there is something to highlight; the lines above say why not.
    $("changes-toggle").disabled = total === 0;
    $("changes-switch").hidden = total === 0;
  }

  // Since when a source's changes are counted, for the detail card.
  function changedSince(sourceId) {
    const s = state.summary && state.summary.sources.find((x) => x.source_id === sourceId);
    return s && s.changes && s.changes.since ? fmtDate(s.changes.since) : "last week";
  }

  function changeHtml(props) {
    if (!props.ch) return "";
    const since = changedSince(props.src);
    const was = props.hp !== undefined && props.hp !== null ? `${fmtMW(props.hp)} MW` : null;
    const [cls, text] = {
      1: ["more", `More capacity than on ${since}${was ? `, was ${was}` : ""}`],
      2: ["less", `Less capacity than on ${since}${was ? `, was ${was}` : ""}`],
      3: ["new", `New since ${since}`],
      4: ["less", `Value withdrawn since ${since}${was ? `, was ${was}` : ""}`],
    }[props.ch] || ["new", `Changed since ${since}`];
    return `<div class="d-change"><span class="bar bar-${cls}" aria-hidden="true"></span><span>${escapeHtml(text)}</span></div>`;
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

  // What limits a section, for utilities that publish a value for each engineering criterion
  // (National Grid). The tiles store the criteria at the lowest value as a bit mask (lf); where
  // none sets the total, the quality flags and the value tell which other case it is, so every
  // such line gets an answer. Returns null for utilities that publish no criteria.
  const flagBit = (id) => [...state.flagsByBit].find(([, flag]) => flag.id === id)?.[0] || 0;
  function publishesLimits(sourceId) {
    const s = state.summary && state.summary.sources.find((x) => x.source_id === sourceId);
    return !!s && s.checks.some((c) => c.id === "capacity_below_all_limits");
  }

  function limitAnswer(p) {
    if (!state.limitsByBit.size || !publishesLimits(p.src) || p.hc === undefined || p.hc === null) return null;
    if (p.lf) {
      const limits = [...state.limitsByBit].filter(([bit]) => p.lf & bit).map(([, limit]) => limit);
      return { limits, note: `${limits.length > 1 ? "These criteria all stop at the same value. " : ""}Worked out from the value the utility publishes for each criterion.` };
    }
    if ((p.q || 0) & flagBit("capacity_below_all_limits")) {
      return { limits: [{ title: "A limit the utility does not publish",
        explanation: "The value is lower than every criterion the utility publishes, so something else it studied holds this line back." }] };
    }
    if ((p.q || 0) & flagBit("capacity_above_limit")) {
      return { limits: [{ title: "Unclear",
        explanation: "The value is higher than one of the utility's own criteria, which should not happen. See the data quality note below." }] };
    }
    // The only case left: every criterion reaches the largest size the utility studies.
    return { limits: [{ title: `Nothing up to ${fmtMW(p.hc)} MW`,
      explanation: "This is the largest project size the utility studies, and the line passed every criterion at it." }] };
  }

  function limitHtml(props) {
    const answer = limitAnswer(props);
    if (!answer) return "";
    return `<div class="d-issues d-limits"><h3>What limits this line</h3><ul>${answer.limits.map((l) => `
      <li><span class="limit-mark" aria-hidden="true"></span>
        <div><strong>${escapeHtml(l.title)}</strong><span>${escapeHtml(l.explanation)}</span></div></li>`).join("")}</ul>
      ${answer.note ? `<p class="note">${answer.note}</p>` : ""}</div>`;
  }

  // ---------- capacity history ----------
  // history.json (about 50 KB) is fetched once, after the map has drawn, so it never slows
  // the first view. Without it, cards simply show no trend.
  let historyLoad = null;
  function loadHistory() {
    if (!historyLoad) {
      historyLoad = fetch(DATA_URL + "/history.json", { cache: "no-cache", signal: withTimeout(15000) })
        .then((r) => (r.ok ? r.json() : null))
        .catch((err) => { console.warn("Capacity history unavailable:", err); return null; });
    }
    return historyLoad;
  }

  const feederKey = (p) => (p && p.feeder ? `${p.src}|${p.feeder}` : null);
  const shownFeeder = () => feederKey(state.selected && state.selected.properties);

  // The trend arrives after the card is drawn; it is added only if the same feeder is still shown.
  function fillHistory(props, slot, fill) {
    const key = feederKey(props);
    if (!key) return;
    loadHistory().then((data) => {
      if (!data || shownFeeder() !== key || !$(slot) || $(slot).dataset.trend) return;
      const series = AtlasHistory.seriesFor(data, props.src, String(props.feeder));
      const t = AtlasHistory.trend(series, fmtDate, fmtMW);
      if (t) fill($(slot), series, t);
    });
  }

  function feederHistoryHtml(slot, series, t) {
    const values = series.map((p) => p.value);
    const hi = Math.max(...values), lo = Math.min(...values);
    // A flat line sits in the middle of the chart, with one label beside it.
    const axis = hi === lo ? `<div class="h-axis h-flat" aria-hidden="true"><span>${fmtMW(hi)} MW</span></div>`
      : `<div class="h-axis" aria-hidden="true"><span>${fmtMW(hi)} MW</span><span>${fmtMW(lo)} MW</span></div>`;
    slot.innerHTML = `
      <h3>Highest capacity, week by week</h3>
      <div class="h-wrap">
        ${axis}
        ${AtlasHistory.sparkline(series, 280, 64)}
      </div>
      <div class="h-dates" aria-hidden="true"><span>${escapeHtml(fmtDate(series[0].date))}</span><span>${escapeHtml(fmtDate(series[series.length - 1].date))}</span></div>
      <p class="h-text h-dir${t.direction}">${escapeHtml(t.long)}</p>`;
    slot.dataset.trend = "1";
    slot.hidden = false;
  }

  // Zoomed out, a click picks a whole feeder: show its range and offer to zoom in.
  function renderFeeder(props) {
    const range = props.fmax === undefined || props.fmax === null
      ? "Not published"
      : props.fmin === props.fmax ? `${fmtMW(props.fmax)} MW` : `${fmtMW(props.fmin)} to ${fmtMW(props.fmax)} MW`;
    const facts = [
      ["Sections", fmtInt(props.fn)],
      ["Length", `${(props.fkm * 0.621371).toFixed(props.fkm < 16 ? 1 : 0)} mi`],
      props.fc ? ["Changed", `${fmtInt(props.fc)} ${props.fc === 1 ? "section" : "sections"} since ${escapeHtml(changedSince(props.src))}`] : null,
    ].filter(Boolean);
    $("detail-body").innerHTML = `
      <div class="d-utility">${escapeHtml(utilityName(props.src))}</div>
      <div class="d-capacity d-feeder">${props.feeder ? `Feeder <span class="code">${escapeHtml(props.feeder)}</span>` : "Lines without a feeder ID"}</div>
      <div class="d-caption">Hosting capacity along this feeder: <strong>${range}</strong></div>
      <dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
      <div class="d-history" id="feeder-history" hidden></div>
      <div class="d-key">
        <div><span class="key-feeder" aria-hidden="true"></span>Selected feeder</div>
        <p>A feeder is one circuit leaving a substation. Zoom in and select a line to see the value for a single section.</p>
        ${props.fx0 !== undefined ? '<button class="d-action" id="zoom-feeder" type="button">Zoom to this feeder</button>' : ""}
      </div>
      ${shareHtml()}`;
    showSoftly($("detail"));
    wireShare();
    fillHistory(props, "feeder-history", feederHistoryHtml);
    const button = $("zoom-feeder");
    if (button) {
      button.addEventListener("click", () => {
        window.atlasMap.fitBounds([[props.fx0, props.fy0], [props.fx1, props.fy1]], { padding: 60, maxZoom: 15 });
      });
    }
  }

  // A link that opens the map at the selected spot, for sharing with a colleague.
  const shareHtml = () => '<div class="d-share"><button class="d-link" id="copy-link" type="button">Copy link to this location</button></div>';
  function wireShare() {
    const button = $("copy-link");
    if (!button) return;
    button.addEventListener("click", () => {
      const map = window.atlasMap;
      const at = state.selected && state.selected.at ? state.selected.at : map.getCenter().toArray();
      const zoom = Math.max(map.getZoom(), 13).toFixed(2);
      copyLink(button, `${location.origin}${location.pathname}#${zoom}/${at[1].toFixed(5)}/${at[0].toFixed(5)}`);
    });
  }

  // Copies a link and says so on the button; where the clipboard is blocked, shows the link.
  async function copyLink(button, url) {
    try {
      await navigator.clipboard.writeText(url);
      button.textContent = "Link copied";
    } catch {
      window.prompt("Copy this link:", url);
    }
  }

  function renderDetail(props) {
    if (props.fn !== undefined) return renderFeeder(props);
    const hc = props.hc;
    const analyzed = hc !== undefined && hc !== null;
    const facts = [
      ["Feeder", props.feeder ? `<span class="code">${escapeHtml(props.feeder)}</span>` : "Not listed"],
      props.sub !== undefined ? ["Substation", props.sub ? escapeHtml(props.sub) : "Not listed"] : null,
      props.kv ? ["Voltage", `${escapeHtml(props.kv)} kV`] : null,
      props.m ? ["Section length", fmtLength(props.m)] : null,
      props.ph !== undefined ? ["Phases", props.ph ? escapeHtml(props.ph) : "Not listed"] : null,
      props.ad ? ["Analysis date", fmtDate(props.ad)] : null,
    ].filter(Boolean);

    const issues = issuesFor(props.q || 0);
    const issuesHtml = issues.length
      ? `<div class="d-issues"><h3>Data quality</h3><ul>${issues.map((f) => `
          <li><span class="dot sev-${f.severity}" aria-hidden="true"></span>
            <div><strong>${escapeHtml(f.title)}</strong><span>${escapeHtml(f.explanation)}</span></div></li>`).join("")}</ul></div>`
      : analyzed ? '<p class="d-clean">No warnings or errors in this week\'s checks.</p>' : "";

    const capacityHtml = analyzed
      ? `<div class="d-capacity">${fmtMW(hc)}<small>MW</small></div>
         <div class="d-caption"><span class="d-swatch" style="background:${colorFor(hc)}" aria-hidden="true"></span>${hc <= 0 ? "No hosting capacity left without upgrades" : "Hosting capacity at this section"}</div>`
      : `<div class="d-capacity is-none">Not published</div>
         <div class="d-caption">The utility mapped this line but did not publish a hosting capacity value.</div>`;

    const keyHtml = `
      <div class="d-key">
        <div><span class="key-section" aria-hidden="true"></span>Selected section</div>
        ${props.feeder ? '<div><span class="key-feeder" aria-hidden="true"></span>Rest of its feeder</div>' : ""}
        <p>Utilities publish a value for each section, so capacity can change from one block to the next.</p>
      </div>`;

    $("detail-body").innerHTML = `
      <div class="d-utility">${escapeHtml(utilityName(props.src))}</div>
      ${capacityHtml}
      ${changeHtml(props)}
      <dl class="facts" id="section-facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
      ${limitHtml(props)}
      ${keyHtml}
      ${issuesHtml}
      ${shareHtml()}`;
    showSoftly($("detail"));
    wireShare();
    // One line in the facts; clicking it opens the same chart as the feeder card, right here.
    fillHistory(props, "section-facts", (list, series, t) => {
      if (list.dataset.trend) return; // already added by an earlier, slower answer
      list.dataset.trend = "1";
      list.insertAdjacentHTML("beforeend", `<dt>Feeder trend</dt><dd>
        <button class="d-link h-toggle h-dir${t.direction}" id="trend-toggle" type="button" aria-expanded="false" aria-controls="section-history">${escapeHtml(t.short)}</button></dd>`);
      list.insertAdjacentHTML("afterend", '<div class="d-history" id="section-history" hidden></div>');
      $("trend-toggle").addEventListener("click", (e) => {
        const slot = $("section-history");
        const open = slot.hidden;
        if (open && !slot.dataset.trend) feederHistoryHtml(slot, series, t);
        slot.hidden = !open;
        e.currentTarget.setAttribute("aria-expanded", String(open));
      });
    });
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
    hideSoftly($("detail"));
    clearSite(map);
    if (!state.layersReady) return;
    for (const id of ["selected-halo", "selected-line", ...ids("feeder-halo")]) map.setFilter(id, NOTHING);
    map.getSource("selected").setData(EMPTY);
    map.getSource("click-point").setData(EMPTY);
  }

  // ---------- site check: the nearest line that can take a project ----------
  // The tiles are already in the browser, so the search runs here: first among the sections
  // around the spot, then, if none fits, among whole feeders over a much wider area.
  const SEARCH_ZOOM = 11.5;   // sections are in the tiles from zoom 11
  const WIDE_ZOOM = 8;        // the overview layer: about 200 miles across on a laptop screen
  const REFINE_ZOOM = 12.5;

  const waitForMap = (map) => new Promise((resolve) => {
    map.once("idle", resolve);
    map.triggerRepaint();
    setTimeout(resolve, 10000);
  });

  async function lookAt(map, center, zoom) {
    map.jumpTo({ center, zoom });
    await waitForMap(map);
  }

  // Radius around the spot that the loaded tiles fully cover: anything nearer is certainly found.
  function coveredKm(map, spot) {
    const b = map.getBounds();
    const edges = [[b.getWest(), spot[1]], [b.getEast(), spot[1]], [spot[0], b.getSouth()], [spot[0], b.getNorth()]];
    return Math.min(...edges.map((edge) => AtlasGeo.distanceKm(spot, edge)));
  }

  async function findNearestLine(map, spot, mw) {
    const shown = (p) => !state.hidden.has(p.src);
    const fits = (f) => shown(f.properties) && f.properties.hc >= mw;
    const sections = () => map.querySourceFeatures(SOURCE, { sourceLayer: LAYER });

    await lookAt(map, spot, SEARCH_ZOOM);
    const near = AtlasGeo.nearestFeature(spot, sections(), fits);
    if (near && near.km <= coveredKm(map, spot)) return near;

    await lookAt(map, spot, WIDE_ZOOM);
    const searchedKm = coveredKm(map, spot);
    const feeder = AtlasGeo.nearestFeature(spot, map.querySourceFeatures(SOURCE, { sourceLayer: "overview" }),
      (f) => shown(f.properties) && f.properties.fmax >= mw);
    if (!feeder) return near || { none: true, searchedKm };

    await lookAt(map, feeder.at, REFINE_ZOOM);
    const exact = AtlasGeo.nearestFeature(spot, sections(), fits);
    return [near, exact].filter(Boolean).sort((a, b) => a.km - b.km)[0] || { ...feeder, approximate: true };
  }

  const siteSize = () => {
    const value = Number($("site-mw").value);
    return Number.isFinite(value) && value > 0 ? Math.min(value, 10000) : 0.01;
  };
  const fmtMiles = (km) => {
    const mi = km / AtlasGeo.KM_PER_MILE;
    return mi < 0.1 ? `${fmtInt(Math.max(10, Math.round((km * 3280.84) / 10) * 10))} ft` : `${mi.toFixed(mi < 10 ? 1 : 0)} mi`;
  };

  function drawSite(map, spot, result) {
    const features = [];
    if (result && !result.none) {
      features.push({ type: "Feature", geometry: { type: "LineString", coordinates: [spot, result.at] }, properties: {} });
      features.push({ type: "Feature", geometry: { type: "Point", coordinates: result.at }, properties: {} });
    }
    state.site.data = { type: "FeatureCollection", features };
    if (state.layersReady) map.getSource("site").setData(state.site.data);
    if (state.site.marker) state.site.marker.remove();
    const el = document.createElement("div");
    el.className = "site-pin";
    state.site.marker = new maplibregl.Marker({ element: el }).setLngLat(spot).addTo(map);
  }

  function clearSite(map) {
    forgetSiteLink();
    state.site.data = null;
    if (state.layersReady && map.getSource("site")) map.getSource("site").setData(EMPTY);
    if (state.site.marker) state.site.marker.remove();
    state.site.marker = null;
  }

  // A shared link (?site=...&mw=...) re-runs its site check once; afterwards the address
  // bar no longer carries it, so a reload or a new search starts clean.
  function forgetSiteLink() {
    const query = new URLSearchParams(location.search);
    if (!query.has("site") && !query.has("mw")) return;
    query.delete("site");
    query.delete("mw");
    const rest = query.toString();
    history.replaceState(null, "", location.pathname + (rest ? "?" + rest : "") + location.hash);
  }

  function openSharedSite(map) {
    const shared = AtlasExport.parseSiteLink(location.search, NY_BBOX);
    if (!shared) return forgetSiteLink(); // a broken or edited link: open the map normally
    $("site-mw").value = shared.mw;
    map.once("idle", () => checkSite(map, shared.spot, shared.mw));
  }

  // The answer, in the same card as a line's details, so it works the same on a phone.
  function renderSite(map, spot, mw, result) {
    const need = `room for ${fmtMW(mw)} MW`;
    if (!result || result.none) {
      $("detail-body").innerHTML = `
        <div class="d-utility">Site check</div>
        <div class="d-capacity d-feeder">No line found</div>
        <div class="d-caption">No line with ${need} within about ${fmtMiles(result ? result.searchedKm : 0)} of this spot${state.hidden.size ? " among the utilities shown" : ""}.</div>
        <div class="d-key"><p>Try a smaller project size, or a spot closer to the colored lines. Areas without lines are served by utilities that are not on the map yet.</p></div>`;
      showSoftly($("detail"));
      return;
    }
    const p = result.feature.properties;
    const facts = [
      p.hc !== undefined ? ["Capacity there", `${fmtMW(p.hc)} MW`] : ["Feeder can take", `up to ${fmtMW(p.fmax)} MW`],
      ["Feeder", p.feeder ? `<span class="code">${escapeHtml(p.feeder)}</span>` : "Not listed"],
      ["Utility", escapeHtml(utilityName(p.src))],
    ];
    $("detail-body").innerHTML = `
      <div class="d-utility">Site check</div>
      <div class="d-capacity">${fmtMiles(result.km).replace(/ (mi|ft)$/, "<small>$1</small>")}</div>
      <div class="d-caption">to the nearest line with ${need}${result.approximate ? " (approximate)" : ""}</div>
      <dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
      <div class="d-key">
        <div><span class="key-site" aria-hidden="true"></span>Straight line from your spot</div>
        <p>A real connection follows roads and rights of way, and the utility's interconnection study sets the final cost.</p>
        ${result.feature.id !== undefined ? '<button class="d-action" id="site-line" type="button">Show this line\'s details</button>' : ""}
      </div>
      <div class="d-share"><button class="d-link" id="site-share" type="button">Copy link to this site check</button></div>`;
    showSoftly($("detail"));
    $("site-share").addEventListener("click", () => copyLink($("site-share"), AtlasExport.siteLink(location.origin + location.pathname, spot, mw)));
    const button = $("site-line");
    if (button) {
      button.addEventListener("click", () => {
        const feature = { id: result.feature.id, properties: { ...p }, geometry: result.feature.geometry, at: result.at };
        select(map, feature);
        renderDetail(feature.properties);
      });
    }
  }

  // Room around the spot and the line so neither ends up under the card: the card sits at
  // the right on wide screens and at the bottom on phones.
  function clearOfCard() {
    const card = $("detail").getBoundingClientRect();
    const pad = { top: 90, bottom: 60, left: 60, right: 60 };
    if (window.matchMedia("(max-width: 760px)").matches) pad.bottom = Math.max(60, window.innerHeight - card.top + 30);
    else pad.right = Math.max(60, window.innerWidth - card.left + 30);
    return pad;
  }

  // Runs the search and shows the answer. Returns the result, for Volta's reply.
  async function checkSite(map, spot, mw) {
    if (state.site.busy) return null;
    state.site.busy = true;
    $("site-pick").disabled = true;
    clearSelection(map);
    showStatus("Looking for the nearest line with room for " + fmtMW(mw) + " MW");
    try {
      const result = await findNearestLine(map, spot, mw);
      drawSite(map, spot, result);
      renderSite(map, spot, mw, result);
      if (result && !result.none) {
        map.fitBounds([spot, result.at], { padding: clearOfCard(), maxZoom: 15, duration: 0 });
      } else {
        map.jumpTo({ center: spot, zoom: 10 });
      }
      return result;
    } catch (err) {
      console.error("Site check failed:", err);
      showStatus("The site check could not finish. Please try again.", 5000);
      return null;
    } finally {
      if (!showStatus.timer || $("status").textContent.startsWith("Looking")) $("status").hidden = true;
      state.site.busy = false;
      $("site-pick").disabled = false;
    }
  }

  function stopPicking(map) {
    state.site.picking = false;
    $("site-pick").setAttribute("aria-pressed", "false");
    $("site-pick").textContent = "Pick a spot on the map";
    map.getCanvas().style.cursor = "";
    $("status").hidden = true;
  }

  function wireSite(map) {
    $("site-pick").addEventListener("click", () => {
      if (state.site.picking) return stopPicking(map);
      state.site.picking = true;
      $("site-pick").setAttribute("aria-pressed", "true");
      $("site-pick").textContent = "Cancel";
      map.getCanvas().style.cursor = "crosshair";
      if (window.matchMedia("(max-width: 760px)").matches) state.setCollapsed(true);
      showStatus("Click the map where the project would go. Press Esc to cancel.");
    });
    $("site-here").addEventListener("click", () => {
      if (state.lastPlace) checkSite(map, state.lastPlace, siteSize());
    });
    $("site-form").addEventListener("submit", (e) => {
      e.preventDefault();
      if (state.lastPlace) checkSite(map, state.lastPlace, siteSize());
      else $("site-pick").click();
    });
  }

  // A card or the chat can open on top of the spot that was just clicked. Slide the map just
  // enough to bring that spot back into the clear: left on wide screens, up on phones.
  function keepInView(map, point) {
    const phone = window.matchMedia("(max-width: 760px)").matches;
    const margin = 40;
    const panelRight = phone ? 0 : $("panel").getBoundingClientRect().right;
    let dx = 0, dy = 0;
    for (const el of [$("detail"), $("assistant-panel")]) {
      if (!isShown(el)) continue;
      // Layout position, not the on-screen one: the card is still sliding in at this moment.
      const box = el.offsetParent === null && getComputedStyle(el).position === "fixed" ? el : el.offsetParent;
      const origin = box === el ? { left: 0, top: 0 } : box.getBoundingClientRect();
      const r = { left: origin.left + el.offsetLeft, top: origin.top + el.offsetTop };
      r.right = r.left + el.offsetWidth;
      r.bottom = r.top + el.offsetHeight;
      if (point.x < r.left - 8 || point.x > r.right + 8 || point.y < r.top - 8 || point.y > r.bottom + 8) continue;
      if (phone) dy = Math.max(dy, point.y - (r.top - margin));
      else dx = Math.max(dx, point.x - Math.max(r.left - margin, panelRight + margin));
    }
    if (dx > 0 || dy > 0) map.panBy([dx, dy], { duration: reduceMotion() ? 0 : 350 });
  }

  function wireClicks(map) {
    const clickable = [...ids("capacity"), ...ids("unanalyzed"), ...ids("issues"), ...ids("changes")];
    const hitBox = (point) => [[point.x - 6, point.y - 6], [point.x + 6, point.y + 6]];
    const hitsAt = (point) => (state.layersReady
      ? map.queryRenderedFeatures(hitBox(point), { layers: clickable.filter((id) => map.getLayer(id)) })
      : []);

    map.on("click", (e) => {
      if (state.site.picking) {
        stopPicking(map);
        return checkSite(map, [e.lngLat.lng, e.lngLat.lat], siteSize());
      }
      const hits = hitsAt(e.point);
      if (!hits.length) return clearSelection(map);
      // Keep only what select() and renderDetail() need, so it survives a theme change.
      const feature = {
        id: hits[0].id, properties: { ...hits[0].properties }, geometry: hits[0].geometry,
        at: [e.lngLat.lng, e.lngLat.lat],
      };
      select(map, feature);
      renderDetail(feature.properties);
      keepInView(map, e.point);
      if (!$("hint").hidden) dismissHint();
      // On phones the chat covers the map, so a line click closes it to show the card.
      if (state.closeAssistant && window.matchMedia("(max-width: 760px)").matches) state.closeAssistant();
    });
    map.on("mousemove", (e) => {
      map.getCanvas().style.cursor = state.site.picking ? "crosshair" : hitsAt(e.point).length ? "pointer" : "";
    });
  }

  // ---------- download the lines in view ----------
  // Built in the browser from the map tiles already loaded, so nothing new is fetched and the
  // file holds only what the map shows anyone: the published values and the check results,
  // in plain words. Internal codes (section numbers, flag bits) stay out.
  const DETAIL_ZOOM = 11;         // sections are in the tiles from this zoom (tiles.py DETAIL_MIN_ZOOM)
  const DOWNLOAD_MAX = 25000;     // sections per file, so a big download never freezes the page
  const CHANGE_WORDS = { 1: "More capacity", 2: "Less capacity", 3: "New", 4: "Value withdrawn" };
  const DOWNLOAD_COLUMNS = [
    ["utility", "Utility"], ["feeder", "Feeder"], ["substation", "Substation"],
    ["hosting_capacity_mw", "Hosting capacity (MW)"], ["section_length_ft", "Section length (ft)"],
    ["voltage_kv", "Voltage (kV)"], ["phases", "Phases"], ["analysis_date", "Analysis date"],
    ["limited_by", "Limited by"], ["data_issues", "Data quality issues"], ["change_since_last_week", "Change since last week"],
    ["previous_capacity_mw", "Previous capacity (MW)"], ["data_as_of", "Data as of"],
  ];
  const DOWNLOAD_NOTE = "Hosting capacity values are utility estimates for early screening and do not replace "
    + "an interconnection study. Shapes come from the map tiles and are simplified for display.";

  const known = (v) => v !== undefined && v !== null && v !== "";
  function downloadRow(p) {
    const source = state.summary && state.summary.sources.find((x) => x.source_id === p.src);
    return {
      utility: utilityName(p.src),
      feeder: known(p.feeder) ? String(p.feeder) : null,
      substation: known(p.sub) ? String(p.sub) : null,
      hosting_capacity_mw: known(p.hc) ? Number(p.hc) : null,
      section_length_ft: known(p.m) ? Math.round(p.m * 3.28084) : null,
      voltage_kv: known(p.kv) ? Number(p.kv) : null,
      phases: known(p.ph) ? String(p.ph) : null,
      analysis_date: known(p.ad) ? String(p.ad) : null,
      limited_by: (limitAnswer(p) || { limits: [] }).limits.map((l) => l.title).join("; ") || null,
      data_issues: issuesFor(p.q || 0).map((f) => f.title).join("; ") || null,
      change_since_last_week: CHANGE_WORDS[p.ch] || null,
      previous_capacity_mw: known(p.hp) ? Number(p.hp) : null,
      data_as_of: source ? source.snapshot_date : null,
    };
  }

  // The sections the map is showing: in view, from the utilities switched on, and at or above
  // the minimum capacity (lines without a value only when no minimum is set, as on the map).
  function sectionsInView(map) {
    const b = map.getBounds();
    const box = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    const shown = (p) => !state.hidden.has(p.src)
      && (known(p.hc) ? p.hc >= state.minMW : state.minMW === 0);
    const pieces = map.querySourceFeatures(SOURCE, { sourceLayer: LAYER }).filter((f) => shown(f.properties));
    return AtlasExport.mergeSections(pieces).filter((s) => AtlasExport.touchesBox(s.lines, box));
  }

  function saveFile(name, type, text) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function setDownloadNote(text) {
    $("download-note").textContent = text;
  }

  // Runs straight from the click, with no waiting, because browsers only let a page save a
  // file while the click that asked for it is fresh.
  function downloadView(map, format) {
    if (map.getZoom() < DETAIL_ZOOM) {
      return setDownloadNote("Zoom in closer first. Single sections are on the map from town level.");
    }
    // Every tile in view must be in, or the file would quietly miss lines.
    if (!state.layersReady || !map.loaded()) return setDownloadNote("The map is still loading lines. Try again in a moment.");
    try {
      const sections = sectionsInView(map);
      if (!sections.length) return setDownloadNote("No lines in view with the current filters.");
      if (sections.length > DOWNLOAD_MAX) {
        return setDownloadNote(`${fmtInt(sections.length)} sections in view. Zoom in to fewer than ${fmtInt(DOWNLOAD_MAX)} to download.`);
      }
      const rows = sections.map((s) => downloadRow(s.properties));
      const day = new Date().toISOString().slice(0, 10);
      const name = `capacity-atlas-lines-${day}.${format === "csv" ? "csv" : "geojson"}`;
      if (format === "csv") {
        // The byte order mark tells Excel the file is UTF-8, so names with accents read correctly.
        saveFile(name, "text/csv;charset=utf-8", "﻿" + AtlasExport.toCsv(rows, DOWNLOAD_COLUMNS));
      } else {
        const metadata = {
          source: "Capacity Atlas, https://capacity-atlas.pages.dev",
          note: DOWNLOAD_NOTE,
          exported: new Date().toISOString(),
          minimum_capacity_mw: state.minMW,
          utilities: (state.summary ? state.summary.sources : []).filter((x) => !state.hidden.has(x.source_id)).map((x) => x.utility),
          sections: sections.length,
        };
        saveFile(name, "application/geo+json", AtlasExport.toGeoJson(sections, rows, metadata));
      }
      setDownloadNote(`Saved ${fmtInt(sections.length)} line sections.`);
    } catch (err) {
      console.error("Download failed:", err);
      setDownloadNote("The file could not be made. Please try again.");
    }
  }

  function wireDownload(map) {
    $("download-csv").addEventListener("click", () => downloadView(map, "csv"));
    $("download-geojson").addEventListener("click", () => downloadView(map, "geojson"));
    // Say up front whether a download is possible from here, and clear old results on a move.
    const update = () => setDownloadNote(map.getZoom() < DETAIL_ZOOM
      ? "Zoom in to town level to download."
      : "Lines in view, with the filters above.");
    map.on("moveend", update);
    for (const id of ["min-mw", "utility-toggles"]) $(id).addEventListener("change", update);
    update();
  }

  // The data credits (the "i" box) open when the page loads, with a light running around
  // their edge so people notice where the data comes from. After 30 seconds they fold shut
  // into the "i", unless the person has opened or closed them in the meantime. Dragging the
  // map closes them sooner (MapLibre's own behavior).
  const CREDITS_OPEN_MS = 30000;
  function introduceCredits(map) {
    const box = map.getContainer().querySelector(".maplibregl-ctrl-attrib.maplibregl-compact");
    if (!box) return; // wide screens without the compact box show the credits as plain text
    box.classList.add("credits-intro");
    let touched = false, folded = false;
    box.addEventListener("click", () => { touched = true; box.classList.remove("credits-intro"); }, { once: true });
    const fold = () => {
      if (folded) return;
      folded = true;
      box.classList.remove("credits-intro");
      if (touched || !box.classList.contains("maplibregl-compact-show")) return;
      const inner = box.querySelector(".maplibregl-ctrl-attrib-inner");
      const close = () => {
        if (inner) inner.style.maxWidth = "";
        box.classList.remove("credits-folding", "maplibregl-compact-show");
        box.removeAttribute("open");
      };
      if (!inner || reduceMotion()) return close();
      // Fold: the text slides shut into the "i" instead of disappearing at once.
      inner.style.maxWidth = inner.scrollWidth + "px";
      box.classList.add("credits-folding");
      requestAnimationFrame(() => requestAnimationFrame(() => { inner.style.maxWidth = "0px"; }));
      setTimeout(close, 650);
    };
    setTimeout(fold, CREDITS_OPEN_MS);
    state.foldCredits = fold; // Volta's chat folds them at once, so its edge never cuts the text
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

    // A link saved while the map could still be tilted ends in /bearing/pitch, and MapLibre
    // ignores such a link entirely now that tilting is off, opening the start view instead.
    // Keep its zoom and place, and drop the rest, so it opens where it should, flat.
    const view = location.hash.slice(1).split("/");
    if (view.length > 3) history.replaceState(null, "", location.pathname + location.search + "#" + view.slice(0, 3).join("/"));

    const map = new maplibregl.Map({
      container: "map",
      style,
      center: cfg.startView.center,
      zoom: cfg.startView.zoom,
      minZoom: 4,
      maxZoom: 18,
      hash: true,
      attributionControl: { compact: true },
      // Always a flat, north-up map: a tilted or turned view distorts the lines and is hard to
      // undo, and nothing here needs 3D. This blocks right-drag, Ctrl-drag, two-finger tilt and
      // twist, and the keyboard shortcuts; maxPitch 0 also flattens any old link that asks for tilt.
      maxPitch: 0,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
    });
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    padForPanel(map);
    window.addEventListener("resize", () => padForPanel(map));
    map.addControl(new HomeControl(), "bottom-right");
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "imperial" }), "bottom-right");

    map.once("load", () => introduceCredits(map)); // the credits box takes its compact form on load
    map.on("style.load", () => onStyleLoad(map));
    if (map.isStyleLoaded()) onStyleLoad(map); // in case the first basemap finished before the listener
    map.on("error", (e) => {
      if (e && e.sourceId === SOURCE) showStatus("The grid data could not be loaded. Try refreshing in a minute.");
    });
    wireClicks(map);
    wireControls(map);
    openSharedSite(map);
    map.once("idle", () => loadHistory()); // ready before most people click a line
    window.atlasMap = map; // handy for debugging in the browser console
  }

  start().catch((err) => {
    // Something the page cannot recover from (for example the browser has no WebGL).
    console.error("Map failed to start:", err);
    showStatus("The map could not start in this browser. Try another browser, or turn on hardware acceleration.");
  });
})();

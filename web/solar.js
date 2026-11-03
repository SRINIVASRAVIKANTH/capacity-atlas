/* Capacity Atlas, "Built so far": solar already connected in New York, by ZIP code.
 *
 * Reads two files the weekly run builds from NYSERDA's statewide list (capacity_atlas/installed.py):
 *   solar_summary.json   statewide totals, by year, by utility, data quality checks
 *   solar_zips.geojson   one point per ZIP code with its totals
 *
 * The page shares its look, basemap, credits, panel and page switch with the capacity map
 * (kit.js), and reads the files with the checked helpers in built.js.
 */
(function () {
  "use strict";

  const cfg = window.ATLAS_CONFIG;
  const kit = window.AtlasKit;
  const B = window.AtlasBuilt;
  const DATA_URL = kit.dataUrl(cfg);
  const BASEMAP_OVERRIDE = kit.basemapOverride();
  const SOURCE = "zips";
  const { escapeHtml, isShown, showSoftly, hideSoftly, withTimeout } = kit;

  // Solar amber, a little deeper on the light basemap so the circles keep their contrast.
  const THEMES = {
    dark: {
      chrome: "#171A21", fallbackGround: "#12141a",
      total: "#fdb52e", totalOpacity: 0.34, stroke: "#fdb52e", strokeOpacity: 0.9,
      recent: "#ffe58a", selected: "#ffffff",
    },
    light: {
      chrome: "#EEF0F3", fallbackGround: "#eef0f3",
      total: "#f59e0b", totalOpacity: 0.32, stroke: "#b45309", strokeOpacity: 0.9,
      recent: "#c2410c", selected: "#1b1e26",
    },
  };

  const state = { theme: null, prefs: null, summary: null, features: [], selected: null, cardTucked: false, setCollapsed: null, foldCredits: null };

  // ---------- helpers ----------
  const $ = (id) => document.getElementById(id);
  const fmtInt = (n) => Number(n).toLocaleString("en-US");
  // kW to MW in words: 6,342 MW; 10.3 MW; 0.86 MW; under 10 kW reads in kW.
  const fmtPower = (kw) => {
    if (!(kw > 0)) return "0 MW";
    const mw = kw / 1000;
    if (kw < 10) return `${kw.toFixed(1).replace(/\.0$/, "")} kW`;
    if (mw >= 100) return `${fmtInt(Math.round(mw))} MW`;
    if (mw >= 10) return `${mw.toFixed(0)} MW`;
    if (mw >= 1) return `${mw.toFixed(1).replace(/\.0$/, "")} MW`;
    return `${mw.toFixed(2).replace(/0$/, "")} MW`;
  };
  // A share in words: 45%, 8%, 0.6%, "under 0.1%".
  const pct = (part, whole) => {
    const p = whole > 0 ? (100 * part) / whole : 0;
    if (p <= 0) return "0%";
    if (p < 0.1) return "under 0.1%";
    return p < 10 ? `${p.toFixed(1).replace(/\.0$/, "")}%` : `${Math.round(p)}%`;
  };
  const look = () => THEMES[state.theme];

  function showStatus(message, ms) {
    const el = $("status");
    el.textContent = message;
    el.hidden = false;
    clearTimeout(showStatus.timer);
    if (ms) showStatus.timer = setTimeout(() => (el.hidden = true), ms);
  }

  // ---------- data ----------
  async function loadJson(name) {
    try {
      const response = await fetch(`${DATA_URL}/${name}`, { cache: "no-cache", signal: withTimeout(20000) });
      if (!response.ok) throw new Error("HTTP " + response.status);
      return await response.json();
    } catch (err) {
      console.warn(`Could not load ${name}:`, err);
      return null;
    }
  }

  const coveredUtilities = () => new Set(Object.values((state.summary && state.summary.feeders) || {}).map((m) => m.nyserda_name));

  // ---------- panel ----------
  function renderSummary(s) {
    if (!s || !s.totals) {
      $("stats").innerHTML = "";
      $("insight").textContent = "The statewide totals could not be loaded. Try refreshing in a minute.";
      for (const id of ["years", "ubars", "match", "quality"]) $(id).innerHTML = "";
      return;
    }
    const t = s.totals;
    $("updated").textContent = s.data_through
      ? `NYSERDA data through ${B.fmtDay(s.data_through)}. NYSERDA updates the list about every three months.`
      : "NYSERDA updates the list about every three months.";
    const recent = s.last_12_months || { kw: 0, systems: 0 };
    $("stats").innerHTML = [
      [fmtPower(t.kw), "connected"],
      [fmtInt(t.systems), "systems"],
      [fmtPower(recent.kw), "in the last 12 months"],
    ].map(([value, label]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("");
    $("insight").textContent = t.community_systems > 0
      ? `Community solar is ${fmtInt(t.community_systems)} of these systems (${pct(t.community_systems, t.systems)}), but ${fmtPower(t.community_kw)}: ${pct(t.community_kw, t.kw)} of the capacity.`
      : "";

    // Connected each year. The data-through year is not over yet, so its bar is lighter.
    const years = s.by_year || [];
    const through = s.data_through || "";
    const partial = !through || through.endsWith("-12-31") ? null : Number(through.slice(0, 4));
    if (years.length) {
      const peak = years.reduce((a, y) => (y.kw > a.kw ? y : a), years[0]);
      $("years").innerHTML = `
        <div class="year-wrap">
          <span class="year-peak">${escapeHtml(fmtPower(peak.kw))} in ${peak.year}</span>
          ${B.yearBars(years, 300, 72, partial)}
        </div>
        <div class="h-dates" aria-hidden="true"><span>${years[0].year}</span><span>${years[years.length - 1].year}</span></div>
        ${partial ? `<p class="note">${partial} is drawn lighter because the data runs only to ${escapeHtml(B.fmtDay(through))}.</p>` : ""}`;
    }

    // By utility, largest first. Utilities on the capacity map are marked.
    const covered = coveredUtilities();
    const utilities = s.by_utility || [];
    const top = Math.max(1, ...utilities.map((u) => u.kw));
    $("ubars").innerHTML = utilities.map((u) => `
      <li>
        <div class="ub-head"><span class="ub-name">${escapeHtml(B.utilityName(u.name))}</span>${covered.has(u.name) ? '<span class="ub-tag">On the capacity map</span>' : ""}<span class="ub-value">${escapeHtml(fmtPower(u.kw))}</span></div>
        <div class="ub-bar" aria-hidden="true"><span style="width:${Math.max(1, (100 * u.kw) / top).toFixed(1)}%"></span></div>
        <div class="ub-sub">${fmtInt(u.systems)} systems</div>
      </li>`).join("");
    const unplaced = s.unplaced || { systems: 0 };
    $("ubars-note").textContent = unplaced.systems
      ? `${fmtInt(unplaced.systems)} systems (${fmtPower(unplaced.kw)}) have no ZIP code, or one that cannot be placed on the map. They are included in the totals but not drawn.`
      : "";

    $("match").innerHTML = Object.values(s.feeders || {}).map((m) => `
      <div class="match-row">
        <div class="ub-head"><span class="ub-name">${escapeHtml(B.utilityName(m.nyserda_name))}</span><span class="ub-value">${pct(m.kw_matched, m.kw_utility)}</span></div>
        <div class="ub-bar ub-bar-match" aria-hidden="true"><span style="width:${m.kw_utility > 0 ? Math.min(100, (100 * m.kw_matched) / m.kw_utility).toFixed(1) : 0}%"></span></div>
        <div class="ub-sub">${fmtInt(m.feeders_with_solar)} of its ${fmtInt(m.feeders_with_capacity)} feeders with a published capacity have solar connected, holding ${escapeHtml(fmtPower(m.kw_matched))} of the ${escapeHtml(fmtPower(m.kw_utility))} NYSERDA lists for the utility.</div>
      </div>`).join("");

    const order = { error: 0, warning: 1, info: 2 };
    const findings = (s.checks || []).filter((c) => c.status === "ran" && c.flagged > 0)
      .sort((a, b) => order[a.severity] - order[b.severity] || b.flagged - a.flagged);
    const ran = (s.checks || []).filter((c) => c.status === "ran").length;
    if (!ran) { // never claim "no problems" when the checks themselves are missing
      $("quality-note").textContent = "The results of the data checks could not be loaded. Try refreshing in a minute.";
      $("quality").innerHTML = "";
      return;
    }
    $("quality-note").textContent = `All ${fmtInt(s.rows)} rows of NYSERDA's list go through ${ran} checks. A flag marks a row worth a closer look, not a confirmed error. Flagged rows still count in the totals, as published.`;
    $("quality").innerHTML = findings.length ? `<ul class="findings">${findings.map((c) => `
        <li title="${escapeHtml(c.explanation || "")}"><span class="dot sev-${c.severity}" aria-hidden="true"></span>
          <span>${escapeHtml(c.title)}<span class="visually-hidden"> (${c.severity}). ${escapeHtml(c.explanation || "")}</span></span>
          <span class="n">${fmtInt(c.flagged)}</span></li>`).join("")}</ul>`
      : '<p class="note"><span class="dot sev-ok" aria-hidden="true"></span> No problems found.</p>';
  }

  // ---------- map layers ----------
  // Circle area grows with the amount of solar (radius with its square root), so a ZIP code with
  // four times the MW looks four times as big, not sixteen. Sizes grow with the zoom.
  function radius(prop) {
    const size = (k, min) => ["max", min, ["*", k, ["sqrt", ["/", ["coalesce", ["get", prop], 0], 1000]]]];
    return ["interpolate", ["linear"], ["zoom"], 5, size(1.7, 1.2), 8, size(3.4, 1.8), 11, size(8, 2.6), 14, size(18, 3.5)];
  }

  const hovered = ["boolean", ["feature-state", "hover"], false];

  function addLayers(map) {
    const t = look();
    const before = kit.firstLabelLayer(map);
    map.addSource(SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: state.features }, promoteId: "zip" });
    // Big circles first, so a small ZIP code next to a big one is never hidden under it.
    map.addLayer({
      id: "zip-total", type: "circle", source: SOURCE,
      layout: { "circle-sort-key": ["-", 0, ["get", "kw"]] },
      paint: {
        "circle-radius": radius("kw"),
        "circle-color": t.total, "circle-opacity": t.totalOpacity,
        "circle-stroke-color": t.stroke,
        "circle-stroke-opacity": ["case", hovered, 1, t.strokeOpacity],
        // A zoom curve must be the outermost part of a style value, so the hover case sits inside it.
        "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 5, ["case", hovered, 1.6, 0.6], 10, ["case", hovered, 2.4, 1.2]],
      },
    }, before);
    map.addLayer({
      id: "zip-recent", type: "circle", source: SOURCE,
      filter: [">", ["coalesce", ["get", "r12"], 0], 0],
      layout: { "circle-sort-key": ["-", 0, ["get", "kw"]] },
      paint: { "circle-radius": radius("r12"), "circle-color": t.recent, "circle-opacity": 0.95 },
    }, before);
    map.addLayer({
      id: "zip-selected", type: "circle", source: SOURCE,
      filter: ["==", ["get", "zip"], state.selected ? state.selected.properties.zip : ""],
      paint: {
        "circle-radius": radius("kw"), "circle-color": "rgba(0,0,0,0)",
        "circle-stroke-color": t.selected, "circle-stroke-width": 2.5,
      },
    }, before);
  }

  function onStyleLoad(map) {
    if (map.getSource(SOURCE)) return;
    addLayers(map);
  }

  async function applyTheme(map) {
    const theme = state.prefs.theme === "auto" ? (systemDark.matches ? "dark" : "light") : state.prefs.theme;
    if (theme === state.theme) return;
    state.theme = theme;
    applyPageTheme(theme);
    map.setStyle(await loadBasemap(theme), { diff: false });
  }

  const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
  const loadBasemap = (theme) => kit.loadBasemap(BASEMAP_OVERRIDE || cfg.basemapStyles[theme], theme, THEMES[theme].fallbackGround);
  function applyPageTheme(theme) {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]').setAttribute("content", THEMES[theme].chrome);
  }

  // ---------- the ZIP code card ----------
  function cardHtml(p) {
    const where = [p.place, p.county ? `${p.county} County` : ""].filter(Boolean).join(", ");
    const facts = [
      ["Solar systems", fmtInt(p.n)],
      Number.isFinite(p.r12) ? ["Connected in the last 12 months", p.r12 > 0 ? `${fmtPower(p.r12)} (${pct(p.r12, p.kw)} of total)` : "None"] : null,
      Number.isInteger(p.cn) ? ["Community solar", p.cn ? `${fmtInt(p.cn)} ${p.cn === 1 ? "system" : "systems"}` : "None"] : null,
      Number.isFinite(p.st) && p.st > 0 ? ["Battery storage", fmtPower(p.st)] : null,
      B.fmtMonth(p.last) ? ["Most recent connection", B.fmtMonth(p.last)] : null,
      p.u ? ["Primary utility", escapeHtml(B.utilityName(p.u))] : null,
    ].filter(Boolean);
    const covered = p.u && coveredUtilities().has(p.u);
    const next = covered
      ? '<button class="d-action" id="to-capacity" type="button">See room to connect here</button>'
      : p.u ? `<p>Hosting capacity for ${escapeHtml(B.utilityName(p.u))} is not on the capacity map yet.</p>` : "";
    const through = state.summary ? B.fmtDay(state.summary.data_through) : "";
    return `
      <div class="d-utility">ZIP code <span class="code">${escapeHtml(p.zip)}</span></div>
      <div class="d-capacity">${escapeHtml(fmtPower(p.kw).replace(/ (MW|kW)$/, ""))}<small>${p.kw > 0 && p.kw < 10 ? "kW" : "MW"}</small></div>
      <div class="d-caption"><span class="d-swatch d-swatch-solar" aria-hidden="true"></span>Solar connected${where ? ` in ${escapeHtml(where)}` : " in this ZIP code"}</div>
      <dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
      <div class="d-key">
        <p>These figures cover every project in ZIP code ${escapeHtml(p.zip)}. NYSERDA lists projects by ZIP code, not by address, so the circle is placed at the center of the ZIP code area.</p>
        ${next}
      </div>
      <div class="d-share"><p class="d-source">Data from NYSERDA${through ? `, through ${escapeHtml(through)}` : ""}. ZIP areas from the US Census Bureau. ` +
      `<a class="d-link" href="terms.html#source-nyserda" target="_blank" rel="noopener">About this data</a></p></div>`;
  }

  function select(map, feature) {
    state.selected = feature;
    state.cardTucked = false;
    if (map.getLayer("zip-selected")) map.setFilter("zip-selected", ["==", ["get", "zip"], feature.properties.zip]);
    $("detail-body").innerHTML = cardHtml(feature.properties);
    // On a phone the open panel and the card would share the lower screen: the panel steps aside.
    if (phone() && state.setCollapsed && !$("panel").classList.contains("is-collapsed")) state.setCollapsed(true);
    if (state.foldCredits) state.foldCredits();
    state.cardTucked = false;
    closePopovers();
    showSoftly($("detail"));
    const button = $("to-capacity");
    if (button) {
      button.addEventListener("click", () => {
        const [lng, lat] = feature.geometry.coordinates;
        const zoom = Math.max(map.getZoom(), 11.5).toFixed(2);
        window.location.href = kit.pageLink("./", `#${zoom}/${lat.toFixed(5)}/${lng.toFixed(5)}`);
      });
    }
  }

  function clearSelection(map) {
    state.selected = null;
    state.cardTucked = false;
    if (map.getLayer("zip-selected")) map.setFilter("zip-selected", ["==", ["get", "zip"], ""]);
    hideSoftly($("detail"));
  }

  // On a phone the card covers the lower screen, so a place is centered in the part above it.
  const phone = () => window.matchMedia("(max-width: 760px)").matches;
  const cardTop = () => $("detail").getBoundingClientRect().top || window.innerHeight * 0.55;
  const cardOffset = () => (phone() ? [0, -(window.innerHeight - cardTop()) / 2] : [0, 0]);
  function keepInView(map, lngLat) {
    if (!phone()) return;
    if (map.project(lngLat).y > cardTop() - 40) map.easeTo({ center: lngLat, offset: cardOffset(), duration: 400 });
  }

  function wireClicks(map) {
    let hoverZip = null;
    const setHover = (zip) => {
      if (hoverZip === zip) return;
      if (hoverZip !== null) map.setFeatureState({ source: SOURCE, id: hoverZip }, { hover: false });
      hoverZip = zip;
      if (zip !== null) map.setFeatureState({ source: SOURCE, id: zip }, { hover: true });
    };
    // Of the circles under the pointer, the one whose center is nearest.
    const pick = (point) => {
      const hits = map.queryRenderedFeatures(point, { layers: ["zip-total"] });
      let best = null, bestDistance = Infinity;
      for (const f of hits) {
        const c = map.project(f.geometry.coordinates);
        const d = Math.hypot(c.x - point.x, c.y - point.y);
        if (d < bestDistance) { best = f; bestDistance = d; }
      }
      return best;
    };
    map.on("mousemove", (e) => {
      if (!map.getLayer("zip-total")) return;
      const f = pick(e.point);
      map.getCanvas().style.cursor = f ? "pointer" : "";
      setHover(f ? f.properties.zip : null);
    });
    map.on("mouseout", () => { map.getCanvas().style.cursor = ""; setHover(null); });
    map.on("click", (e) => {
      if (!map.getLayer("zip-total")) return;
      const f = pick(e.point);
      if (!f) return clearSelection(map);
      const full = state.features.find((x) => x.properties.zip === f.properties.zip) || f;
      select(map, full);
      keepInView(map, full.geometry.coordinates);
    });
  }

  // ---------- search (in the browser, over the ZIP codes on the map) ----------
  function wireSearch(map) {
    const input = $("search-input");
    const list = $("search-results");
    let hits = [];
    const go = (feature) => {
      list.hidden = true;
      input.value = feature.properties.place ? `${feature.properties.zip} ${feature.properties.place}` : feature.properties.zip;
      select(map, feature);
      map.flyTo({ center: feature.geometry.coordinates, zoom: Math.max(map.getZoom(), 11), offset: cardOffset(), duration: 1200 });
    };
    const show = () => {
      const query = input.value.trim();
      hits = B.searchZips(state.features, query, 6);
      if (!query) { list.hidden = true; return; }
      list.innerHTML = hits.length
        ? hits.map((f, i) => `<li><button type="button" data-i="${i}">${escapeHtml(f.properties.zip)}${f.properties.place ? ` ${escapeHtml(f.properties.place)}` : ""}` +
          `<small>${escapeHtml(fmtPower(f.properties.kw))}, ${fmtInt(f.properties.n)} systems</small></button></li>`).join("")
        : '<li class="search-msg">No ZIP code on the map matches. Try the first digits of a ZIP code or a town name.</li>';
      list.hidden = false;
    };
    input.addEventListener("input", show);
    input.addEventListener("focus", () => { if (input.value.trim()) show(); });
    $("search").addEventListener("submit", (e) => {
      e.preventDefault();
      show();
      if (hits.length) go(hits[0]);
    });
    list.addEventListener("click", (e) => {
      const button = e.target.closest("button[data-i]");
      if (button) go(hits[Number(button.dataset.i)]);
    });
    document.addEventListener("click", (e) => { if (!e.target.closest("#search")) list.hidden = true; });
  }

  // ---------- guide, display menu, panel, credits, keys ----------
  // The right side shows one thing at a time, as on the capacity map: opening the guide or the
  // display menu folds the credits and tucks the ZIP code card away. The card comes back, with
  // its selection, when the guide or menu closes.
  const POPOVERS = { display: ["display-toggle", "display-menu"], help: ["help-toggle", "help"] };
  const isOpen = (name) => isShown($(POPOVERS[name][1]));
  function setPopover(name, open) {
    if (open) {
      if (state.foldCredits) state.foldCredits();
      if (isShown($("detail"))) { state.cardTucked = true; hideSoftly($("detail")); }
    } else if (state.cardTucked && state.selected) {
      state.cardTucked = false;
      showSoftly($("detail"));
    }
    for (const [key, [button, panel]] of Object.entries(POPOVERS)) {
      const show = key === name && open;
      if (show) showSoftly($(panel));
      else hideSoftly($(panel));
      $(button).setAttribute("aria-expanded", String(show));
    }
  }
  const anyPopover = () => isOpen("display") || isOpen("help");
  const closePopovers = () => { if (anyPopover()) setPopover(null, false); };

  function padForPanel(map) {
    const wide = window.matchMedia("(min-width: 761px)").matches;
    const open = !$("panel").classList.contains("is-collapsed");
    map.setPadding({ left: wide && open ? $("panel").offsetWidth + 16 : 0, top: 0, right: 0, bottom: 0 });
  }

  function wireControls(map) {
    document.querySelector(`#theme-choice input[value="${state.prefs.theme}"]`).checked = true;
    $("theme-choice").addEventListener("change", (e) => {
      state.prefs.theme = e.target.value;
      kit.savePrefs({ theme: state.prefs.theme });
      applyTheme(map);
    });
    systemDark.addEventListener("change", () => { if (state.prefs.theme === "auto") applyTheme(map); });
    $("display-toggle").addEventListener("click", () => setPopover("display", !isOpen("display")));
    $("help-toggle").addEventListener("click", () => setPopover("help", !isOpen("help")));
    $("help-close").addEventListener("click", () => {
      setPopover("help", false);
      $("help-toggle").focus({ preventScroll: true }); // keyboard users carry on from the "?" button
    });
    document.addEventListener("click", (e) => { if (isOpen("display") && !e.target.closest(".display")) setPopover("display", false); });
    $("detail-close").addEventListener("click", () => clearSelection(map));
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (anyPopover()) closePopovers();
      else if (!$("search-results").hidden) $("search-results").hidden = true;
      else if (!$("detail").hidden) clearSelection(map);
    });
    state.setCollapsed = kit.wirePanelFold({
      panel: $("panel"), body: $("panel-body"),
      buttons: [$("panel-toggle"), $("sheet-toggle")], label: $("panel-toggle"), labelText: $("panel-toggle-label"),
      shrink: [".key-sub", ".solar-key-list"],
      tweaks: [[".key", { marginTop: "16px" }, { marginTop: "10px" }]],
      onChange: () => padForPanel(map),
    });
    kit.wireModes();
    $("repo-link").href = cfg.repoUrl;
  }

  class HomeControl {
    onAdd(map) {
      this.container = document.createElement("div");
      this.container.className = "maplibregl-ctrl maplibregl-ctrl-group";
      this.container.innerHTML = '<button type="button" title="Reset view" aria-label="Reset view"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 11l8-7 8 7M6 9.5V20h12V9.5" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round" stroke-linecap="round"/></svg></button>';
      this.container.querySelector("button").addEventListener("click", () => {
        clearSelection(map);
        map.flyTo({ center: cfg.startView.center, zoom: cfg.startView.zoom });
      });
      return this.container;
    }
    onRemove() { this.container.remove(); }
  }

  // ---------- start ----------
  async function start() {
    const saved = kit.readPrefs();
    state.prefs = { theme: ["auto", "light", "dark"].includes(saved.theme) ? saved.theme : "auto" };
    state.theme = state.prefs.theme === "auto" ? (systemDark.matches ? "dark" : "light") : state.prefs.theme;
    applyPageTheme(state.theme);

    const [style, summary, zips] = await Promise.all([loadBasemap(state.theme), loadJson("solar_summary.json"), loadJson("solar_zips.geojson")]);
    state.summary = B.cleanSummary(summary); // only the well-formed parts (built.js)
    state.features = B.zipFeatures(zips);
    // The panel never stops the map: if drawing it fails, the map still starts and says so.
    try {
      renderSummary(state.summary);
    } catch (err) {
      console.warn("Could not draw the panel:", err);
      renderSummary(null);
    }
    if (!state.features.length) showStatus("The solar data could not be loaded. Try refreshing in a minute.");

    // Same address rules as the capacity map: a refresh starts at the start view, a link keeps its place.
    const nav = performance.getEntriesByType ? performance.getEntriesByType("navigation")[0] : null;
    if (nav && nav.type === "reload" && location.hash) history.replaceState(null, "", location.pathname + location.search);
    const view = location.hash.slice(1).split("/");
    if (view.length > 3) history.replaceState(null, "", location.pathname + location.search + "#" + view.slice(0, 3).join("/"));

    const map = new maplibregl.Map({
      container: "map", style,
      center: cfg.startView.center, zoom: cfg.startView.zoom, minZoom: 4, maxZoom: 18, hash: true,
      attributionControl: {
        compact: true,
        customAttribution: 'Solar data: <a href="https://data.ny.gov/d/wgsj-jt5f" target="_blank" rel="noopener">NYSERDA</a>, ZIP areas: US Census Bureau' +
          ' | <a href="terms.html#source-nyserda" target="_blank" rel="noopener">Data sources and terms</a>',
      },
      maxPitch: 0, dragRotate: false, pitchWithRotate: false, touchPitch: false,
    });
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    padForPanel(map);
    window.addEventListener("resize", () => padForPanel(map));
    map.addControl(new HomeControl(), "bottom-right");
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "imperial" }), "bottom-right");
    // The credits open first, with the running light, then fold into the "i" (kit.js).
    map.once("load", () => { state.foldCredits = kit.introduceCredits(map, { onOpen: closePopovers }); });
    map.on("style.load", () => onStyleLoad(map));
    if (map.isStyleLoaded()) onStyleLoad(map);
    wireClicks(map);
    wireSearch(map);
    wireControls(map);
    window.atlasMap = map; // handy for debugging in the browser console
  }

  start().catch((err) => {
    console.error("Map failed to start:", err);
    showStatus("The map could not start in this browser. Try another browser, or turn on hardware acceleration.");
  });
})();

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

  const state = { theme: null, prefs: null, summary: null, features: [], selected: null, cardTucked: false, setCollapsed: null, foldCredits: null,
    timelapse: null, closeAssistant: null };

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
  //   value     the kW to size by: today's total from the file, or a year of the time-lapse
  //   hideZero  draw nothing where the value is 0 (the time-lapse, before a ZIP code's first project)
  function radius(value, hideZero = false) {
    const kw = ["coalesce", value, 0];
    const size = (k, min) => {
      const r = ["max", min, ["*", k, ["sqrt", ["/", kw, 1000]]]];
      return hideZero ? ["case", [">", kw, 0], r, 0] : r;
    };
    return ["interpolate", ["linear"], ["zoom"], 5, size(1.7, 1.2), 8, size(3.4, 1.8), 11, size(8, 2.6), 14, size(18, 3.5)];
  }
  const TODAY = { total: ["get", "kw"], recent: ["get", "r12"] };
  const recentFilter = [">", ["coalesce", ["get", "r12"], 0], 0];
  const strokeOpacity = () => ["case", hovered, 1, look().strokeOpacity];

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
        "circle-radius": radius(TODAY.total),
        "circle-color": t.total, "circle-opacity": t.totalOpacity,
        "circle-stroke-color": t.stroke,
        "circle-stroke-opacity": strokeOpacity(),
        // A zoom curve must be the outermost part of a style value, so the hover case sits inside it.
        "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 5, ["case", hovered, 1.6, 0.6], 10, ["case", hovered, 2.4, 1.2]],
      },
    }, before);
    map.addLayer({
      id: "zip-recent", type: "circle", source: SOURCE,
      filter: recentFilter,
      layout: { "circle-sort-key": ["-", 0, ["get", "kw"]] },
      paint: { "circle-radius": radius(TODAY.recent), "circle-color": t.recent, "circle-opacity": 0.95 },
    }, before);
    map.addLayer({
      id: "zip-selected", type: "circle", source: SOURCE,
      filter: ["==", ["get", "zip"], state.selected ? state.selected.properties.zip : ""],
      paint: {
        "circle-radius": radius(TODAY.total), "circle-color": "rgba(0,0,0,0)",
        "circle-stroke-color": t.selected, "circle-stroke-width": 2.5,
      },
    }, before);
  }

  function onStyleLoad(map) {
    if (map.getSource(SOURCE)) return;
    addLayers(map);
    if (state.timelapse && state.timelapse.active) state.timelapse.redraw(); // a theme change mid-play
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

  // ---------- time-lapse: the circles grow year by year ----------
  // solar_years.json holds, for each ZIP code on the map, the solar connected by the end of each
  // year. Playing it sizes the circles from values kept per ZIP code as feature state, updated
  // each frame, instead of today's totals in the GeoJSON, so nothing is sent to the map again.
  // While it runs the circles show a past year, not today, so cards and hover are off until it
  // ends; the panel's key and year chart follow the year shown.
  const YEAR_MS = 700;      // one year of growth while playing
  const FRAME_MS = 40;      // at most 25 updates a second
  const STEP_MS = 900;      // reduced motion: one year at a time, no blending

  class TimeLapse {
    constructor(map, data) {
      this.map = map;
      this.data = data;
      this.active = false;
      this.playing = false;
      this.t = 0;
      this.shownYear = -1;
      this.frame = 0;
      this.stepTimer = 0;
      this.last = 0;
    }

    get end() { return this.data.years.length - 1; }

    // play: start playing at once; at: the year index to show first; focus: move focus to the
    // player (not when Volta started it, so typing in the chat carries on).
    start({ play = true, at = 0, focus = true } = {}) {
      if (this.active) return;
      clearSelection(this.map);
      closePopovers();
      if (state.foldCredits) state.foldCredits();
      // On a phone the panel would hide the map it is about.
      if (phone() && state.setCollapsed) state.setCollapsed(true);
      this.active = true;
      document.body.classList.add("timelapse-on");
      $("tl-slider").max = String(this.end);
      $("tl-start").setAttribute("aria-expanded", "true");
      this.applyStyle();
      this.render(at);
      showSoftly($("timelapse"));
      if (play) this.play();
      else {
        this.mark(); // the button shows Play, not the Pause it was left on
        this.announce();
      }
      if (focus) $("tl-play").focus({ preventScroll: true });
    }

    // Shows one year, paused (Volta: "how much solar was there in 2015?"). False if the year
    // is not on the time-lapse.
    jumpToYear(year) {
      const index = this.data.years.indexOf(year);
      if (index < 0) return false;
      if (this.active) this.seek(index);
      else this.start({ play: false, at: index, focus: false });
      return true;
    }

    stop() {
      if (!this.active) return;
      const fromPlayer = $("timelapse").contains(document.activeElement);
      this.pause(false);
      this.active = false;
      this.shownYear = -1;
      document.body.classList.remove("timelapse-on");
      this.restoreStyle();
      $("sk-total-text").textContent = "all solar connected";
      $("sk-recent-text").textContent = "connected in the last 12 months";
      document.querySelectorAll("#years .yb-now").forEach((bar) => bar.classList.remove("yb-now"));
      $("tl-start").setAttribute("aria-expanded", "false");
      hideSoftly($("timelapse"));
      if (fromPlayer) $("tl-start").focus({ preventScroll: true });
    }

    play() {
      if (this.t >= this.end) this.render(0); // at the end, play means from the start
      this.playing = true;
      this.mark();
      if (kit.reduceMotion()) {
        this.stepTimer = setInterval(() => {
          const next = Math.floor(this.t) + 1;
          this.render(Math.min(next, this.end));
          if (next >= this.end) this.pause();
        }, STEP_MS);
        return;
      }
      this.last = performance.now();
      const tick = (now) => {
        if (!this.playing) return;
        if (now - this.last >= FRAME_MS) {
          // A slow device still plays at full speed; a tab back from the background does not jump ahead.
          const dt = Math.min(now - this.last, 250);
          this.last = now;
          const t = this.t + dt / YEAR_MS;
          if (t >= this.end) {
            this.render(this.end);
            this.pause();
            return;
          }
          this.render(t);
        }
        this.frame = requestAnimationFrame(tick);
      };
      this.frame = requestAnimationFrame(tick);
    }

    pause(announce = true) {
      this.playing = false;
      cancelAnimationFrame(this.frame);
      clearInterval(this.stepTimer);
      this.frame = this.stepTimer = 0;
      this.mark();
      if (announce) this.announce();
    }

    // The slider: stop and show that year.
    seek(index) {
      if (this.playing) this.pause(false);
      this.render(index);
      this.announce();
    }

    // After a theme change the map rebuilds its layers with today's sizes: put the year back.
    redraw() {
      this.applyStyle();
      this.render(this.t);
    }

    applyStyle() {
      const map = this.map;
      if (!map.getLayer("zip-total")) return;
      const total = ["feature-state", "k"];
      map.setPaintProperty("zip-total", "circle-radius", radius(total, true));
      map.setPaintProperty("zip-total", "circle-stroke-opacity", ["case", [">", ["coalesce", total, 0], 0], look().strokeOpacity, 0]);
      map.setFilter("zip-recent", null);
      map.setPaintProperty("zip-recent", "circle-radius", radius(["feature-state", "a"], true));
    }

    restoreStyle() {
      const map = this.map;
      if (map.getLayer("zip-total")) {
        map.setPaintProperty("zip-total", "circle-radius", radius(TODAY.total));
        map.setPaintProperty("zip-total", "circle-stroke-opacity", strokeOpacity());
        map.setFilter("zip-recent", recentFilter);
        map.setPaintProperty("zip-recent", "circle-radius", radius(TODAY.recent));
      }
      if (map.getSource(SOURCE)) map.removeFeatureState({ source: SOURCE });
    }

    render(t) {
      this.t = Math.min(Math.max(t, 0), this.end);
      if (this.map.getSource(SOURCE)) {
        for (const [zip, values] of this.data.zips) {
          const v = B.yearValues(values, this.t);
          this.map.setFeatureState({ source: SOURCE, id: zip }, { k: v.total, a: v.added });
        }
      }
      $("tl-total").textContent = fmtPower(B.yearValues(this.data.state, this.t).total); // "in New York" follows in the page
      const year = Math.round(this.t);
      $("tl-slider").value = String(year);
      if (year !== this.shownYear) this.showYear(year);
    }

    // The year in words, for the player, the slider, the key and the year chart.
    yearWords(index) {
      const y = this.data.years[index];
      const through = this.data.through;
      const partial = index === this.end && through && !through.endsWith("-12-31");
      return { y, partial, by: partial ? `by ${B.fmtDay(through)}` : `by the end of ${y}`, during: partial ? `in ${y}, to ${B.fmtDay(through)}` : `during ${y}` };
    }

    showYear(index) {
      this.shownYear = index;
      const w = this.yearWords(index);
      $("tl-year").textContent = String(w.y);
      $("tl-slider").setAttribute("aria-valuetext", w.partial ? `${w.y}, to ${B.fmtDay(this.data.through)}` : String(w.y));
      $("sk-total-text").textContent = `all solar connected ${w.by}`;
      $("sk-recent-text").textContent = `connected ${w.during}`;
      document.querySelectorAll("#years .yb-now").forEach((bar) => bar.classList.remove("yb-now"));
      const bar = document.querySelector(`#years rect[data-year="${w.y}"]`);
      if (bar) bar.classList.add("yb-now");
    }

    announce() {
      const w = this.yearWords(Math.round(this.t));
      const kw = this.data.state[Math.round(this.t)];
      $("tl-live").textContent = `${fmtPower(kw)} of solar connected in New York ${w.by}.`;
    }

    mark() {
      const button = $("tl-play");
      button.classList.toggle("is-paused", !this.playing);
      button.setAttribute("aria-label", this.playing ? "Pause" : "Play");
      button.title = this.playing ? "Pause" : "Play";
    }
  }

  // Loads the yearly file after the map is up. Without it (a site whose weekly run has not built
  // it yet, or a damaged file) the button stays hidden and the page is exactly as before.
  async function loadTimeLapse(map) {
    const data = B.cleanYears(await loadJson("solar_years.json"));
    if (!data) return;
    const tl = new TimeLapse(map, data);
    state.timelapse = tl;
    $("tl-start-label").textContent = `Watch the growth since ${data.years[0]}`;
    $("tl-start").setAttribute("aria-controls", "timelapse");
    $("tl-start").setAttribute("aria-expanded", "false");
    $("tl-start").hidden = false;
    $("help-growth").hidden = false;
    $("tl-start").addEventListener("click", () => (tl.active ? tl.stop() : tl.start()));
    $("tl-play").addEventListener("click", () => (tl.playing ? tl.pause() : tl.play()));
    $("tl-close").addEventListener("click", () => tl.stop());
    $("tl-slider").addEventListener("input", (e) => tl.seek(Number(e.target.value)));
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
      <div class="d-share"><button class="d-link" id="zip-link" type="button">Copy link to this ZIP code</button>
      <p class="d-source">Data from NYSERDA${through ? `, through ${escapeHtml(through)}` : ""}. ZIP areas from the US Census Bureau. ` +
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
    const share = $("zip-link");
    share.addEventListener("click", () => kit.copyLink(share, zipLink(map, feature)));
    const button = $("to-capacity");
    if (button) {
      button.addEventListener("click", () => {
        const [lng, lat] = feature.geometry.coordinates;
        const zoom = Math.max(map.getZoom(), 11.5).toFixed(2);
        window.location.href = kit.pageLink("./", `#${zoom}/${lat.toFixed(5)}/${lng.toFixed(5)}`);
      });
    }
  }

  // A link that opens this page on one ZIP code's card, for sharing with a colleague.
  function zipLink(map, feature) {
    const [lng, lat] = feature.geometry.coordinates;
    const zoom = Math.max(map.getZoom(), 11).toFixed(2);
    return `${location.origin}${location.pathname}?zip=${feature.properties.zip}#${zoom}/${lat.toFixed(5)}/${lng.toFixed(5)}`;
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
    const playing = () => state.timelapse && state.timelapse.active;
    map.on("mousemove", (e) => {
      if (!map.getLayer("zip-total") || playing()) return;
      const f = pick(e.point);
      map.getCanvas().style.cursor = f ? "pointer" : "";
      setHover(f ? f.properties.zip : null);
    });
    map.on("mouseout", () => { map.getCanvas().style.cursor = ""; setHover(null); });
    map.on("click", (e) => {
      if (!map.getLayer("zip-total") || playing()) return;
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
      if (state.timelapse) state.timelapse.stop(); // a search answers with today's card
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

  // ---------- download (in the browser, from the ZIP codes on the map) ----------
  // Today's totals for the ZIP codes in view; a box that covers the state gives all of them.
  const DOWNLOAD_NOTE = "From NYSERDA's Statewide Distributed Solar Projects list. Each point is the center of a "
    + "ZIP code area (US Census Bureau), not where the projects are.";
  function zipsInView(map) {
    const b = map.getBounds();
    return B.zipRows(state.features, [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
  }
  function downloadView(map, format) {
    try {
      const rows = zipsInView(map);
      if (!rows.length) return setDownloadNote("No ZIP codes in view. Zoom out or move the map.");
      const day = new Date().toISOString().slice(0, 10);
      const name = `capacity-atlas-solar-by-zip-${day}.${format === "csv" ? "csv" : "geojson"}`;
      if (format === "csv") {
        // The byte order mark tells Excel the file is UTF-8.
        kit.saveFile(name, "text/csv;charset=utf-8", "\ufeff" + AtlasExport.toCsv(rows, B.ZIP_COLUMNS));
      } else {
        const features = rows.map((r) => ({ type: "Feature", properties: r,
          geometry: { type: "Point", coordinates: [r.center_longitude, r.center_latitude] } }));
        const metadata = {
          source: "Capacity Atlas, https://capacity-atlas.pages.dev",
          note: DOWNLOAD_NOTE,
          data_through: state.summary ? state.summary.data_through : null,
          exported: new Date().toISOString(),
          zip_codes: rows.length,
        };
        kit.saveFile(name, "application/geo+json", JSON.stringify({ type: "FeatureCollection", metadata, features }));
      }
      setDownloadNote(`Saved ${fmtInt(rows.length)} ZIP ${rows.length === 1 ? "code" : "codes"}.`);
    } catch (err) {
      console.error("Download failed:", err);
      setDownloadNote("The file could not be made. Please try again.");
    }
  }
  const setDownloadNote = (text) => { $("download-note").textContent = text; };
  function wireDownload(map) {
    $("download-csv").addEventListener("click", () => downloadView(map, "csv"));
    $("download-geojson").addEventListener("click", () => downloadView(map, "geojson"));
    // Say up front how many ZIP codes a download would hold, and clear an old result on a move.
    const update = () => {
      const n = zipsInView(map).length;
      setDownloadNote(n ? `${fmtInt(n)} ZIP ${n === 1 ? "code" : "codes"} in view, with today's totals.` : "No ZIP codes in view.");
    };
    map.on("moveend", update);
    update();
  }

  // ---------- Volta ----------
  // The chat is shared with the capacity map (volta.js). Here it gets answers in the settings
  // of this page: a place or ZIP code to show, ZIP codes to rank, a year, the time-lapse, a
  // panel section, or the way to the capacity map. The AI writes one sentence; every number
  // below it is counted here from NYSERDA's files.
  const BUILT_SECTIONS = { totals: "glance-title", years: "years-title", utilities: "utilities-title", linked: "match-title",
    download: "download-title", quality: "quality-title" };
  const NY_BBOX = [-79.8, 40.4, -71.8, 45.1];
  const plural = (n, one, many) => `${fmtInt(n)} ${n === 1 ? one : many}`;
  let volta = null;

  function wireAssistant(map) {
    volta = new AtlasVolta.Volta({
      map, page: "built", askUrl: cfg.askUrl,
      keep: ["place", "zip", "rank", "year", "timelapse", "section", "capacity", "reset"],
      fallback: { unclear: "Sorry, I did not catch that. Which town, ZIP code or year should I show?",
        scope: "I can help with solar already connected in New York: a town, a ZIP code or a year." },
      hooks: {
        foldCredits: () => state.foldCredits && state.foldCredits(),
        closePopovers: () => closePopovers(),
        setCollapsed: (collapsed) => state.setCollapsed && state.setCollapsed(collapsed),
      },
      // "New chat": back to today's map, with no card open.
      onReset: () => {
        if (state.timelapse) state.timelapse.stop();
        clearSelection(map);
      },
      onLogClick: (e) => {
        const zip = e.target.closest("button[data-zip]");
        if (zip) {
          const f = state.features.find((x) => x.properties.zip === zip.dataset.zip);
          if (f) showZip(map, f);
          return true;
        }
        if (e.target.closest("button[data-capacity]")) {
          const [lng, lat] = map.getCenter().toArray();
          const zoom = Math.max(map.getZoom(), 11).toFixed(2);
          window.location.href = kit.pageLink("./", `#${zoom}/${lat.toFixed(5)}/${lng.toFixed(5)}`);
          return true;
        }
        return false;
      },
      onPlan: (plan, reply) => carryOut(map, plan, reply),
    });
    if (!volta.mount()) return;
    state.closeAssistant = () => volta.setOpen(false);
    $("help-volta").hidden = false;
  }

  // Today's card for one ZIP code, and the map moved to it.
  function showZip(map, feature) {
    if (state.timelapse) state.timelapse.stop();
    select(map, feature);
    map.flyTo({ center: feature.geometry.coordinates, zoom: Math.max(map.getZoom(), 11), offset: cardOffset(), duration: 1200 });
  }

  // Where a place is: a town on the map first (its ZIP codes, found in the browser), then the
  // same place search as the capacity map (Photon, over OpenStreetMap) for anything else.
  async function goToPlace(map, name) {
    const town = name.replace(/,\s*(new york|ny)\s*$/i, "").trim().toLowerCase();
    const towns = state.features.filter((f) => typeof f.properties.place === "string" && f.properties.place.toLowerCase() === town);
    if (towns.length) {
      const xs = towns.map((f) => f.geometry.coordinates[0]), ys = towns.map((f) => f.geometry.coordinates[1]);
      map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: 90, maxZoom: 11.5, duration: 1200 });
      return true;
    }
    try {
      const url = `${cfg.searchUrl}?q=${encodeURIComponent(name)}&limit=1&lang=en&bbox=${NY_BBOX.join(",")}`;
      const response = await fetch(url, { signal: withTimeout(10000) });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const place = ((await response.json()).features || []).find((f) => f.geometry && f.geometry.type === "Point");
      if (!place) return false;
      const extent = place.properties && place.properties.extent;
      if (Array.isArray(extent) && extent.length === 4 && extent.every(Number.isFinite)) {
        map.fitBounds([[extent[0], extent[3]], [extent[2], extent[1]]], { padding: 60, maxZoom: 11, duration: 1200 });
      } else {
        map.flyTo({ center: place.geometry.coordinates, zoom: 10.5, duration: 1200 });
      }
      return true;
    } catch (err) {
      console.warn("Place lookup failed:", err);
      return false;
    }
  }

  const settle = (map) => new Promise((resolve) => { map.once("idle", resolve); map.triggerRepaint(); setTimeout(resolve, 10000); });
  function featuresInView(map) {
    const b = map.getBounds();
    return state.features.filter((f) => b.contains(f.geometry.coordinates));
  }
  const zipButton = (p) => `<button type="button" data-zip="${escapeHtml(p.zip)}">${escapeHtml(p.zip)}${p.place ? ` ${escapeHtml(p.place)}` : ""}</button>`;
  const topList = (label, rows) => (rows.length
    ? `<p class="msg-sub">${escapeHtml(label)}</p><ul class="msg-top">${rows.map(([p, value]) => `<li>${zipButton(p)}<span>${escapeHtml(value)}</span></li>`).join("")}</ul>` : "");

  function describeView(map) {
    const fs = featuresInView(map);
    if (!fs.length) return "<p>No ZIP codes with solar in this view. Try zooming out.</p>";
    const sum = (key) => fs.reduce((total, f) => total + (Number.isFinite(f.properties[key]) ? f.properties[key] : 0), 0);
    const top = [...fs].sort((a, b) => b.properties.kw - a.properties.kw).slice(0, 3).map((f) => [f.properties, fmtPower(f.properties.kw)]);
    return `<p>In this view: <strong>${fmtPower(sum("kw"))}</strong> from <strong>${plural(sum("n"), "system", "systems")}</strong> in ` +
      `${plural(fs.length, "ZIP code", "ZIP codes")}, with <strong>${fmtPower(sum("r12"))}</strong> connected in the last 12 months.</p>` +
      topList("Most solar in view", top);
  }

  // The ZIP codes in view that lead by one measure. With a year (and the time-lapse file), the
  // solar ranking is by what was connected by the end of that year.
  const RANKED = {
    solar: { label: "Most solar in view", value: (p) => p.kw, words: (p) => fmtPower(p.kw), none: "solar" },
    recent: { label: "Most connected in the last 12 months", value: (p) => p.r12 || 0, words: (p) => fmtPower(p.r12), none: "solar connected in the last 12 months" },
    community: { label: "Most community solar systems", value: (p) => p.cn || 0, words: (p) => plural(p.cn, "system", "systems"), none: "community solar" },
    storage: { label: "Most battery storage", value: (p) => p.st || 0, words: (p) => fmtPower(p.st), none: "battery storage" },
  };
  function describeRank(map, rank, year) {
    const r = RANKED[rank];
    const tl = state.timelapse;
    const index = year && rank === "solar" && tl ? tl.data.years.indexOf(year) : -1;
    const value = index >= 0 ? (p) => (tl.data.zips.get(p.zip) || [])[index] || 0 : r.value;
    const words = index >= 0 ? (p) => fmtPower(value(p)) : r.words;
    const rows = featuresInView(map).map((f) => f.properties).filter((p) => value(p) > 0)
      .sort((a, b) => value(b) - value(a)).slice(0, 5).map((p) => [p, words(p)]);
    if (!rows.length) return `<p>No ZIP codes in this view have ${r.none}${index >= 0 ? ` by the end of ${year}` : ""}. Try zooming out.</p>`;
    return topList(index >= 0 ? `Most solar in view by the end of ${year}` : r.label, rows) + "<p class=\"msg-sub\">Select a ZIP code to open its card.</p>";
  }

  function describeZip(p) {
    return `<p>ZIP code <strong>${escapeHtml(p.zip)}</strong>${p.place ? ` (${escapeHtml(p.place)})` : ""}: <strong>${fmtPower(p.kw)}</strong> from ` +
      `<strong>${plural(p.n, "system", "systems")}</strong>${p.r12 > 0 ? `, ${fmtPower(p.r12)} of it in the last 12 months` : ""}. Its card is open on the map.</p>`;
  }

  function describeYear(map, year, moved) {
    const s = state.summary;
    if (!s || !s.by_year.length) return "<p>The yearly totals could not be loaded. Try refreshing in a minute.</p>";
    const first = s.by_year[0].year;
    const through = s.data_through;
    const last = through ? Number(through.slice(0, 4)) : s.by_year[s.by_year.length - 1].year;
    if (year < first || year > last) {
      return `<p>NYSERDA's list runs from ${first} to ${through ? escapeHtml(B.fmtDay(through)) : last}, so ${year} is not on it.</p>`;
    }
    const row = s.by_year.find((y) => y.year === year);
    const partial = through && year === last && !through.endsWith("-12-31");
    const when = partial ? `${year} (to ${escapeHtml(B.fmtDay(through))})` : String(year);
    let text = row
      ? `In ${when}, <strong>${fmtPower(row.kw)}</strong> of solar was connected in New York${Number.isInteger(row.systems) ? `, from <strong>${plural(row.systems, "system", "systems")}</strong>` : ""}`
      : `No solar on NYSERDA's list was connected in ${when}`;
    const tl = state.timelapse;
    const index = tl ? tl.data.years.indexOf(year) : -1;
    if (index >= 0) text += `, bringing the total to <strong>${fmtPower(tl.data.state[index])}</strong>${partial ? "" : ` by the end of ${year}`}`;
    let html = `<p>${text}.</p>`;
    if (index >= 0 && moved) {
      const inView = featuresInView(map).reduce((total, f) => total + ((tl.data.zips.get(f.properties.zip) || [])[index] || 0), 0);
      html += `<p>In this view: <strong>${fmtPower(inView)}</strong> by the end of ${year}.</p>`;
    }
    if (index >= 0) html += "<p class=\"msg-sub\">The map shows that year. Press play at the top to watch the rest, or X to go back to today.</p>";
    return html;
  }

  // The numbers of a panel section, for a question about it.
  function describeSection(map, section) {
    const s = state.summary;
    if (section === "download") {
      const n = featuresInView(map).length;
      return `<p>The Download section in the panel saves the <strong>${plural(n, "ZIP code", "ZIP codes")} in view</strong> as a spreadsheet (CSV) or a map file (GeoJSON).</p>`;
    }
    if (!s) return "<p>The statewide totals could not be loaded. Try refreshing in a minute.</p>";
    const t = s.totals;
    if (section === "totals") {
      return `<p>New York has <strong>${fmtPower(t.kw)}</strong> of distributed solar from <strong>${plural(t.systems, "system", "systems")}</strong>, ` +
        `with <strong>${fmtPower(s.last_12_months.kw)}</strong> connected in the last 12 months.` +
        (t.community_systems > 0 ? ` Community solar is ${pct(t.community_systems, t.systems)} of the systems but ${pct(t.community_kw, t.kw)} of the capacity.` : "") + "</p>";
    }
    if (section === "years" && s.by_year.length) {
      const peak = s.by_year.reduce((a, y) => (y.kw > a.kw ? y : a), s.by_year[0]);
      return `<p>The year with the most solar connected was <strong>${peak.year}</strong>, with <strong>${fmtPower(peak.kw)}</strong>. ` +
        `In the last 12 months, <strong>${fmtPower(s.last_12_months.kw)}</strong> was connected.</p>`;
    }
    if (section === "utilities" && s.by_utility.length) {
      const top = s.by_utility.slice(0, 3).map((u) => `<li><span>${escapeHtml(B.utilityName(u.name))}</span><span>${escapeHtml(fmtPower(u.kw))}</span></li>`).join("");
      return `<p class="msg-sub">Most solar by utility</p><ul class="msg-top">${top}</ul>`;
    }
    if (section === "linked") {
      const rows = Object.values(s.feeders).map((m) => `<li><span>${escapeHtml(B.utilityName(m.nyserda_name))}</span>` +
        `<span>${fmtInt(m.feeders_with_solar)} of ${fmtInt(m.feeders_with_capacity)} feeders</span></li>`).join("");
      return rows ? `<p class="msg-sub">Feeders on the capacity map with solar connected</p><ul class="msg-top">${rows}</ul>` +
        "<p>Each project names its feeder; only exact matches are used. A line's card on Room to connect shows the solar on its feeder.</p>" : "";
    }
    if (section === "quality") {
      const ran = s.checks.filter((c) => c.status === "ran");
      const top = ran.filter((c) => c.flagged > 0).sort((a, b) => b.flagged - a.flagged).slice(0, 2);
      return `<p>All <strong>${fmtInt(s.rows)} rows</strong> of NYSERDA's list go through ${ran.length} checks.` +
        (top.length ? ` The most common flags: ${top.map((c) => `${escapeHtml(c.title)} (${fmtInt(c.flagged)})`).join(", ")}.` : " None found a problem.") +
        " A flag means worth a closer look, not a confirmed error.</p>";
    }
    return "";
  }

  function describeCapacity() {
    return "<p>Room to connect shows where power lines still have room for new solar, for Central Hudson and National Grid so far.</p>" +
      '<p><button class="d-action" type="button" data-capacity>Open Room to connect here</button></p>';
  }

  async function carryOut(map, plan, reply) {
    const tl = state.timelapse;
    const add = (html) => { if (html) reply.insertAdjacentHTML("beforeend", html); };
    reply.innerHTML = plan.reply ? `<p>${escapeHtml(plan.reply)}</p>` : "";
    const acts = plan.reset || plan.zip || plan.place || plan.rank || plan.year || plan.timelapse || plan.section || plan.capacity;
    if (!acts) {
      // A general question: words only, and the map stays as it is.
      if (!plan.reply) reply.innerHTML = "<p>Ask me about a town, a ZIP code or a year, and I will set the map.</p>";
      return;
    }
    if (plan.reset) {
      if (tl) tl.stop();
      clearSelection(map);
      map.flyTo({ center: cfg.startView.center, zoom: cfg.startView.zoom });
    }
    if (plan.timelapse === "stop" && tl) tl.stop();
    const section = plan.year || plan.timelapse === "play" ? "years" : plan.section;
    if (BUILT_SECTIONS[section]) volta.reveal(BUILT_SECTIONS[section]);
    reply.insertAdjacentHTML("beforeend", AtlasVolta.Volta.typing());
    try {
      // Where. Today's totals for a place or ZIP code, unless a year was asked for too.
      let moved = false;
      let zipFeature = null;
      const keepYear = plan.year || plan.timelapse === "play";
      if (plan.zip) {
        zipFeature = state.features.find((f) => f.properties.zip === plan.zip) || null;
        if (zipFeature) {
          if (tl && !keepYear) tl.stop();
          map.flyTo({ center: zipFeature.geometry.coordinates, zoom: Math.max(map.getZoom(), 11), offset: cardOffset(), duration: 1200 });
          moved = true;
        } else {
          add(`<p>ZIP code ${escapeHtml(plan.zip)} is not on the map: NYSERDA's list places no solar there, or it has no Census ZIP area.</p>`);
        }
      } else if (plan.place) {
        if (tl && !keepYear) tl.stop();
        moved = await goToPlace(map, plan.place);
        if (!moved) add(`<p>I could not find ${escapeHtml(plan.place.replace(/, New York$/i, ""))}, so I kept the current view.</p>`);
      }
      if ((plan.rank || plan.capacity) && tl && !plan.year) tl.stop(); // rankings and the capacity map are about today
      // When.
      if (plan.year && tl) tl.jumpToYear(plan.year);
      else if (plan.timelapse === "play") {
        if (tl && tl.active) tl.play();
        else if (tl) tl.start({ focus: false });
      }
      if (moved) await settle(map);
      // The numbers.
      if (zipFeature) {
        if (tl && tl.active && plan.year) {
          const index = tl.data.years.indexOf(plan.year);
          const kw = index >= 0 ? (tl.data.zips.get(zipFeature.properties.zip) || [])[index] || 0 : null;
          if (kw !== null) add(`<p>ZIP code <strong>${escapeHtml(zipFeature.properties.zip)}</strong>: <strong>${fmtPower(kw)}</strong> by the end of ${plan.year}.</p>`);
        } else {
          select(map, zipFeature);
          add(describeZip(zipFeature.properties));
        }
      }
      if (plan.year) add(describeYear(map, plan.year, moved && !zipFeature));
      if (plan.rank) add(describeRank(map, plan.rank, plan.year));
      else if (moved && !zipFeature && !plan.year) add(describeView(map));
      if (!plan.rank && !moved && !plan.year && !zipFeature && plan.section) add(describeSection(map, plan.section));
      if (plan.timelapse === "play") {
        add(tl ? `<p>Playing the growth since ${tl.data.years[0]}. Pause, or drag the slider at the top of the map to stop at any year.</p>`
          : "<p>The year-by-year view is not available yet. It appears after the next weekly update.</p>");
      }
      if (plan.timelapse === "stop") add("<p>Back to today's map.</p>");
      if (plan.capacity) add(describeCapacity());
    } finally {
      reply.querySelector(".typing")?.remove();
    }
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
      if (state.closeAssistant && isShown($("assistant-panel"))) state.closeAssistant();
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
      else if (state.timelapse && state.timelapse.active) state.timelapse.stop();
      else if (state.closeAssistant && !$("assistant-panel").hidden) state.closeAssistant();
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
  function forgetZipLink() {
    const query = new URLSearchParams(location.search);
    if (!query.has("zip")) return;
    query.delete("zip");
    const rest = query.toString();
    history.replaceState(null, "", location.pathname + (rest ? "?" + rest : "") + location.hash);
  }

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
    // A shared link (?zip=12601) opens that ZIP code's card once; afterwards the address bar no
    // longer carries it, so a reload starts clean (the same rule as a shared site check).
    const sharedZip = B.parseZipLink(location.search);
    const shared = sharedZip ? state.features.find((f) => f.properties.zip === sharedZip) : null;
    const hasPlace = location.hash.slice(1).split("/").filter((x) => x !== "" && Number.isFinite(Number(x))).length === 3;
    forgetZipLink();

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
    map.once("load", () => {
      state.foldCredits = kit.introduceCredits(map, {
        onOpen: () => {
          closePopovers();
          if (state.closeAssistant && isShown($("assistant-panel"))) state.closeAssistant(); // the chat would cover them
        },
      });
      if (shared) {
        if (!hasPlace) map.jumpTo({ center: shared.geometry.coordinates, zoom: 11 });
        select(map, shared);
      }
      loadTimeLapse(map); // a small file, after the map is up, so it never slows the first view
    });
    map.on("style.load", () => onStyleLoad(map));
    if (map.isStyleLoaded()) onStyleLoad(map);
    wireClicks(map);
    wireSearch(map);
    wireControls(map);
    wireDownload(map);
    wireAssistant(map);
    window.atlasMap = map; // handy for debugging in the browser console
  }

  start().catch((err) => {
    console.error("Map failed to start:", err);
    showStatus("The map could not start in this browser. Try another browser, or turn on hardware acceleration.");
  });
})();

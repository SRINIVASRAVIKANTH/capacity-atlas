/* Shared by both map pages ("Room to connect" in app.js and "Built so far" in solar.js):
 * test overrides, soft opening and closing, the basemap, the tidy credits, display preferences
 * and the switch between the two pages. Loaded before either page's own script.
 */
(function (root) {
  "use strict";

  // Test overrides (?data=...&basemap=...) work only on a local copy of the site. On the public
  // site they are ignored, so nobody can share a link that shows someone else's data here.
  const LOCAL = ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
  const params = LOCAL ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const dataUrl = (cfg) => (params.get("data") || cfg.dataUrl).replace(/\/+$/, "");
  const basemapOverride = () => params.get("basemap"); // one style for both themes

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const withTimeout = (ms) => (typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);

  // ---------- soft opening and closing ----------
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

  // ---------- display preferences, remembered in this browser only ----------
  // Both pages share one record, so a theme picked on one page holds on the other.
  const PREFS_KEY = "capacity-atlas-display";
  function readPrefs() {
    try {
      const saved = JSON.parse(window.localStorage.getItem(PREFS_KEY) || "{}");
      return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
    } catch {
      return {};
    }
  }
  function savePrefs(changes) {
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify({ ...readPrefs(), ...changes }));
    } catch {
      /* private windows can block storage; the choice still applies for this visit */
    }
  }

  // ---------- basemap ----------
  const styleCache = new Map();
  async function loadBasemap(url, theme, fallbackGround) {
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
          layers: [{ id: "background", type: "background", paint: { "background-color": fallbackGround } }],
        };
      }
    }
    const style = structuredClone(styleCache.get(url));
    tuneBasemap(style, theme);
    return style;
  }

  // Keep roads and land quiet so the data stands out, but keep place names easy to read.
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
        paint["text-halo-width"] = 1.6; // light theme: keep the basemap's dark text, a little more halo over the data
      }
    }
  }

  // Data layers go under the basemap's labels, so city and street names stay on top.
  function firstLabelLayer(map) {
    const layer = map.getStyle().layers.find((l) => l.type === "symbol");
    return layer ? layer.id : undefined;
  }

  // ---------- credits ----------
  // MapLibre writes every credit on one line joined by " | ", which wraps with a "|" at the start
  // of a line. This puts each credit on its own line instead: the data, the basemap, then the
  // link to the terms page. It moves MapLibre's own nodes (nothing is parsed again) and runs
  // again whenever MapLibre rewrites the credits, for example after a theme change.
  function tidyCredits(inner) {
    if (!inner) return;
    const tidy = () => {
      if (!inner.firstChild || inner.querySelector(":scope > .credit-line")) return;
      const lines = [[]];
      for (const node of [...inner.childNodes]) {
        if (node.nodeType === Node.TEXT_NODE && node.textContent.includes("|")) {
          node.textContent.split("|").forEach((piece, i) => {
            if (i > 0) lines.push([]);
            if (piece.trim()) lines[lines.length - 1].push(document.createTextNode(piece));
          });
        } else {
          lines[lines.length - 1].push(node);
        }
      }
      const rows = lines.filter((nodes) => nodes.some((n) => n.textContent.trim())).map((nodes) => {
        const row = document.createElement("span");
        row.className = "credit-line";
        nodes.forEach((n) => row.append(n));
        row.normalize();
        if (row.firstChild && row.firstChild.nodeType === Node.TEXT_NODE) row.firstChild.textContent = row.firstChild.textContent.trimStart();
        if (row.lastChild && row.lastChild.nodeType === Node.TEXT_NODE) row.lastChild.textContent = row.lastChild.textContent.trimEnd();
        return row;
      });
      // The link to the terms page goes last, under all the credits.
      rows.sort((a, b) => Number(!!a.querySelector('a[href^="terms.html"]')) - Number(!!b.querySelector('a[href^="terms.html"]')));
      inner.replaceChildren(...rows);
    };
    new MutationObserver(tidy).observe(inner, { childList: true });
    tidy();
  }

  // The data credits (the "i" box) open when a page loads, with a light running around their
  // edge so people notice where the data comes from. After 30 seconds they fold shut into the
  // "i", unless the person has opened or closed them in the meantime. Dragging the map closes
  // them sooner (MapLibre's own behavior). Both pages use this, so they behave the same.
  //   onOpen  called when the person opens the credits, so the page can close what they would cover
  // Returns a function that folds the credits now (a page calls it when a card or menu opens).
  const CREDITS_OPEN_MS = 30000;
  function introduceCredits(map, { onOpen } = {}) {
    const box = map.getContainer().querySelector(".maplibregl-ctrl-attrib.maplibregl-compact");
    if (!box) return () => {}; // wide screens without the compact box show the credits as plain text
    box.classList.add("credits-intro");
    tidyCredits(box.querySelector(".maplibregl-ctrl-attrib-inner"));
    let touched = false, closing = false;
    box.addEventListener("click", () => { touched = true; box.classList.remove("credits-intro"); }, { once: true });
    box.addEventListener("toggle", () => { if (box.open && onOpen) onOpen(); });
    const fold = () => {
      box.classList.remove("credits-intro");
      if (closing || !box.classList.contains("maplibregl-compact-show")) return;
      const inner = box.querySelector(".maplibregl-ctrl-attrib-inner");
      const close = () => {
        if (inner) { inner.style.maxWidth = ""; inner.style.maxHeight = ""; }
        box.classList.remove("credits-folding", "maplibregl-compact-show");
        box.removeAttribute("open");
        closing = false;
      };
      if (!inner || reduceMotion()) return close();
      // The text fades and the box closes into the "i" instead of vanishing at once. Its size is
      // pinned first, so the wrapped lines cannot reflow while it narrows.
      closing = true;
      inner.style.maxWidth = inner.offsetWidth + "px";
      inner.style.maxHeight = inner.offsetHeight + "px";
      box.classList.add("credits-folding");
      requestAnimationFrame(() => requestAnimationFrame(() => {
        inner.style.maxWidth = "0px";
        inner.style.maxHeight = "18px";
      }));
      setTimeout(close, 650);
    };
    setTimeout(() => { if (!touched) fold(); }, CREDITS_OPEN_MS);
    return fold;
  }

  // ---------- folding the side panel ----------
  // The panel folds down to its header, on any screen size. It rolls up (on a phone, the sheet
  // slides down) instead of jumping: the parts that disappear shrink while the panel's visible
  // edge moves to where the folded panel ends.
  //   shrink  selectors of header parts that disappear when folded
  //   tweaks  [selector, open style, folded style] for header parts that only change spacing
  // Returns a function that folds (true) or opens (false) the panel.
  function wirePanelFold({ panel, body, buttons, label, labelText, shrink = [], tweaks = [], onChange }) {
    let folding = [];
    const mark = (collapsed) => {
      for (const button of buttons) button.setAttribute("aria-expanded", String(!collapsed));
      const text = collapsed ? "Expand panel" : "Collapse panel";
      if (label) label.title = text;
      if (labelText) labelText.textContent = text;
      if (onChange) onChange(collapsed);
    };
    const fold = (collapsed) => {
      folding.forEach((a) => a.cancel());
      folding = [];
      const phone = window.matchMedia("(max-width: 760px)").matches;
      // Heights open and folded, measured in one go before the browser paints anything.
      const wasCollapsed = panel.classList.contains("is-collapsed");
      panel.classList.remove("is-collapsed");
      const open = panel.offsetHeight;
      const subs = shrink.flatMap((selector) => [...panel.querySelectorAll(selector)]);
      const subSizes = subs.map((el) => { const cs = getComputedStyle(el); return [el.offsetHeight + "px", cs.marginTop, cs.marginBottom]; });
      panel.classList.add("is-collapsed");
      const shut = panel.offsetHeight;
      panel.classList.toggle("is-collapsed", wasCollapsed);
      const gap = Math.max(open - shut, 0);
      const timing = { duration: 280, easing: "cubic-bezier(0.4, 0, 0.2, 1)" };
      const ends = (from, to) => (collapsed ? [from, to] : [to, from]);
      if (!collapsed) panel.classList.remove("is-collapsed");
      const run = (el, frames, extra) => { const a = el.animate(frames, { ...timing, ...extra }); folding.push(a); return a; };
      const main = phone
        ? run(panel, ends({ transform: "translateY(0)" }, { transform: `translateY(${gap}px)` }))
        : run(panel, ends({ clipPath: "inset(0 0 0 0 round 14px)" }, { clipPath: `inset(0 0 ${gap}px 0 round 14px)` }));
      subs.forEach((el, i) => {
        const [h, mt, mb] = subSizes[i];
        run(el, ends({ height: h, marginTop: mt, marginBottom: mb, opacity: 1, overflow: "hidden" },
          { height: "0px", marginTop: "0px", marginBottom: "0px", opacity: 0, overflow: "hidden" }));
      });
      for (const [selector, opened, folded] of tweaks) {
        const el = panel.querySelector(selector);
        if (el) run(el, ends(opened, folded));
      }
      if (collapsed) run(body, [{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: "forwards" });
      main.onfinish = () => {
        if (collapsed) panel.classList.add("is-collapsed");
        folding.forEach((a) => a.cancel());
        folding = [];
        mark(collapsed);
      };
    };
    const set = (collapsed, animate = true) => {
      if (panel.classList.contains("is-collapsed") === collapsed && !folding.length) return mark(collapsed);
      if (!animate || reduceMotion() || !panel.animate) {
        folding.forEach((a) => a.cancel());
        folding = [];
        panel.classList.toggle("is-collapsed", collapsed);
        return mark(collapsed);
      }
      fold(collapsed);
    };
    let heading = panel.classList.contains("is-collapsed"); // where the panel is heading
    for (const button of buttons) {
      button.addEventListener("click", () => {
        heading = folding.length ? !heading : !panel.classList.contains("is-collapsed");
        set(heading);
      });
    }
    if (window.matchMedia("(max-width: 760px)").matches) { heading = true; set(true, false); }
    return (collapsed) => { heading = collapsed; set(collapsed); };
  }

  // ---------- the switch between the two pages ----------
  // Each page answers one question about the same map. Switching keeps the place and zoom:
  // MapLibre keeps them in the address (#zoom/lat/lng), and the link carries them over.
  // A link to the other page at a place. A local test copy also keeps its ?data=&basemap=
  // overrides; on the public site there are none to keep.
  const pageLink = (page, hash) => page + (LOCAL ? location.search : "") + hash;
  function wireModes() {
    document.querySelectorAll(".modes a:not([aria-current])").forEach((link) => {
      const base = link.getAttribute("href").split("#")[0];
      const follow = () => { link.href = pageLink(base, location.hash); };
      link.addEventListener("pointerdown", follow);
      link.addEventListener("focus", follow);
      link.addEventListener("click", follow);
    });
  }

  root.AtlasKit = {
    LOCAL, dataUrl, basemapOverride, escapeHtml, withTimeout,
    reduceMotion, isShown, showSoftly, hideSoftly,
    readPrefs, savePrefs,
    loadBasemap, tuneBasemap, firstLabelLayer, tidyCredits, introduceCredits, wirePanelFold, pageLink, wireModes,
  };
})(window);

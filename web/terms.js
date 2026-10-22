/* The "Data sources and terms" page: highlights where you are in the contents, lets each
 * section rise into view once, and points out the disclaimer a map card linked to
 * (terms.html#source-<source id>). The page reads the same without this script. */
(function () {
  "use strict";

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const sections = Array.from(document.querySelectorAll(".doc-section"));
  const links = new Map(Array.from(document.querySelectorAll(".doc-toc a")).map((a) => [a.hash.slice(1), a]));

  // Sections rise into place as they first come into view.
  if (!reduceMotion && "IntersectionObserver" in window) {
    document.body.classList.add("reveal");
    const rise = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) { entry.target.classList.add("is-in"); rise.unobserve(entry.target); }
      }
    }, { rootMargin: "0px 0px -8% 0px" });
    sections.forEach((s) => rise.observe(s));
    // A section already on screen, or the one a link opens at, shows at once.
    requestAnimationFrame(() => sections.forEach((s) => {
      if (s.getBoundingClientRect().top < window.innerHeight) s.classList.add("is-in");
    }));
  }

  // The contents mark the section at the top of the reading area.
  let shown = null;
  function markCurrent() {
    const line = window.innerHeight * 0.3;
    let current = sections[0];
    for (const s of sections) if (s.getBoundingClientRect().top <= line) current = s;
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) current = sections[sections.length - 1];
    if (current === shown) return;
    shown = current;
    links.forEach((a, id) => {
      const on = id === current.id;
      a.classList.toggle("is-current", on);
      if (on) a.setAttribute("aria-current", "true"); else a.removeAttribute("aria-current");
    });
    // On phones the contents are a row of chips: keep the current one in sight.
    const chip = links.get(current.id);
    const row = chip && chip.parentElement.parentElement;
    if (row && row.scrollWidth > row.clientWidth) {
      const left = chip.offsetLeft - row.clientWidth / 2 + chip.offsetWidth / 2;
      row.scrollTo({ left, behavior: reduceMotion ? "auto" : "smooth" });
    }
  }
  let queued = false;
  window.addEventListener("scroll", () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; markCurrent(); });
  }, { passive: true });
  markCurrent();

  // A card on the map links straight to its utility's disclaimer: show it and outline it once.
  function pointAtHash() {
    const target = location.hash ? document.getElementById(location.hash.slice(1)) : null;
    if (!target || !target.classList.contains("notice")) return;
    const section = target.closest(".doc-section");
    if (section) section.classList.add("is-in");
    target.focus({ preventScroll: true });
    target.classList.remove("is-pointed");
    void target.offsetWidth; // restart the outline if the same link is followed again
    target.classList.add("is-pointed");
  }
  window.addEventListener("hashchange", pointAtHash);
  pointAtHash();
})();

/* Volta, the map's assistant: the chat both map pages share.
 *
 * This file owns everything the two pages have in common: the mascot and its eyes, the
 * first-visit greeting, opening and closing the chat, "New chat", the example questions, the
 * chat's short memory, the call to /api/ask with its calm error messages, and pointing the
 * side panel at the section an answer is about. Each page passes in what only it knows:
 *
 *   page       "capacity" (Room to connect) or "built" (Built so far); the server answers each
 *              with its own instructions and settings
 *   keep       the settings of an answer that the chat remembers for follow-ups
 *   onPlan     async (plan, reply) => void: carry out an answer on the map. `reply` is the
 *              message element; the page fills it with words and the numbers it counts itself.
 *   onReset    () => void: what "New chat" clears on the map
 *   onLogClick (event) => boolean: a click inside the chat the page handles (a feeder, a ZIP code)
 *   fallback   the words for a question Volta could not read
 *
 * Every number Volta shows is counted in the page from the data on screen; the AI only picks
 * the settings and writes one plain sentence.
 */
(function (root) {
  "use strict";

  const kit = root.AtlasKit;
  const { escapeHtml, isShown, showSoftly, hideSoftly, reduceMotion, withTimeout } = kit;
  const $ = (id) => document.getElementById(id);
  const phone = () => window.matchMedia("(max-width: 760px)").matches;
  const CHAT_MEMORY = 3;          // earlier questions sent back for follow-ups
  const ASK_TIMEOUT_MS = 25000;   // the server gives up on Claude after 15 s

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

  function wireEyes() {
    if (reduceMotion()) return;
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

  // Points the side panel at the section an answer is about: the panel opens if folded, the
  // section scrolls to its top, and an outline marks it. On a phone the chat covers the panel,
  // so it only scrolls there, ready for when the person opens the panel.
  //   setCollapsed  the page's panel fold, (collapsed) => void
  function revealSection(titleId, setCollapsed) {
    const title = $(titleId);
    const section = title && title.closest("section");
    const body = $("panel-body");
    if (!section || !body) return;
    const go = () => {
      body.scrollTo({ top: section.offsetTop - body.offsetTop - 8, behavior: reduceMotion() ? "auto" : "smooth" });
      // One section outlined at a time: the one this answer is about.
      document.querySelectorAll("#panel .is-pointed").forEach((el) => el.classList.remove("is-pointed"));
      void section.offsetWidth; // restart the outline when asked twice in a row
      section.classList.add("is-pointed");
    };
    const panel = $("panel");
    const folded = panel.classList.contains("is-collapsed");
    if (phone()) {
      if (!folded) return go();
      // The folded sheet cannot scroll: go there as soon as the person opens it.
      if (panel._pendingReveal) panel._pendingReveal.disconnect();
      const watch = new MutationObserver(() => {
        if (panel.classList.contains("is-collapsed")) return;
        watch.disconnect();
        panel._pendingReveal = null;
        setTimeout(go, 320);
      });
      watch.observe(panel, { attributes: true, attributeFilter: ["class"] });
      panel._pendingReveal = watch;
      return;
    }
    if (folded && setCollapsed) setCollapsed(false);
    setTimeout(go, folded ? 320 : 0); // after the panel has rolled open
  }

  class Volta {
    constructor({ map, page, askUrl, keep, onPlan, onReset, onLogClick, fallback, hooks = {} }) {
      this.map = map;
      this.page = page;
      this.askUrl = askUrl;
      this.keep = keep;
      this.onPlan = onPlan;
      this.onReset = onReset || (() => {});
      this.onLogClick = onLogClick || (() => false);
      this.fallback = fallback;
      this.hooks = hooks;           // foldCredits, closePopovers, setCollapsed: the page's own
      this.asking = false;
      this.chat = [];               // the last few questions and settings; kept in this page only
      this.panel = $("assistant-panel");
    }

    // ---------- the chat window ----------
    mount() {
      if (!this.askUrl || !this.panel) return false;
      document.querySelectorAll("[data-volta]").forEach((el) => (el.innerHTML = voltaSVG("volta-" + el.dataset.volta)));
      wireEyes();
      $("assistant").hidden = false;
      this.wireGreeting();
      $("assistant-toggle").addEventListener("click", () => this.setOpen(!this.isOpen()));
      $("assistant-close").addEventListener("click", () => this.setOpen(false));
      const welcome = $("chat-log").innerHTML;
      // "New chat": back to the first message with its example questions, and the map cleared.
      $("assistant-reset").addEventListener("click", () => {
        if (this.asking) return;
        this.onReset();
        $("chat-log").innerHTML = welcome;
        this.chat.length = 0; // a new chat starts without memory of the old one
        $("chat-input").value = "";
        $("chat-input").focus();
      });
      $("chat-form").addEventListener("submit", (e) => {
        e.preventDefault();
        const q = $("chat-input").value.trim();
        if (!q || this.asking) return; // while Volta is answering, the typed question waits in the box
        $("chat-input").value = "";
        this.ask(q);
      });
      $("chat-log").addEventListener("click", (e) => {
        const chip = e.target.closest(".chips button");
        if (chip) return this.ask(chip.textContent);
        this.onLogClick(e);
      });
      this.panel.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        this.setOpen(false);
        $("assistant-toggle").focus();
      });
      return true;
    }

    isOpen() { return isShown(this.panel); }

    setOpen(open) {
      if (open) {
        this.hideGreeting();
        if (this.hooks.foldCredits) this.hooks.foldCredits();
        if (this.hooks.closePopovers) this.hooks.closePopovers(); // the guide and display menu make way
        showSoftly(this.panel);
      } else {
        hideSoftly(this.panel);
      }
      $("assistant-toggle").setAttribute("aria-expanded", String(open));
      document.body.classList.toggle("assistant-open", open);
      if (open) setTimeout(() => $("chat-input").focus(), 50);
    }

    // ---------- the first-visit greeting ----------
    hideGreeting() {
      $("greeting").hidden = true;
      try { sessionStorage.setItem("volta-greeted", "1"); } catch { /* storage blocked: it may greet again */ }
    }

    wireGreeting() {
      const greeting = $("greeting");
      $("greeting-close").addEventListener("click", () => this.hideGreeting());
      $("greeting-open").addEventListener("click", () => this.setOpen(true));
      let greeted = false;
      try { greeted = sessionStorage.getItem("volta-greeted") === "1"; } catch { /* treat as not greeted */ }
      if (greeted) return;
      // The greeting sits over the map's zoom buttons, so it steps aside on its own: after a
      // short while, or as soon as the person starts using the map.
      let shown = false;
      const greet = () => {
        if (shown || this.isOpen()) return;
        shown = true;
        greeting.hidden = false;
        setTimeout(() => { if (!greeting.hidden) this.hideGreeting(); }, 12000);
      };
      // On a phone the open credits fill the same corner, so the greeting waits until they fold.
      const credits = () => this.map.getContainer().querySelector(".maplibregl-ctrl-attrib.maplibregl-compact-show");
      setTimeout(() => {
        if (!phone() || !credits()) return greet();
        const box = credits();
        const watch = new MutationObserver(() => {
          if (box.classList.contains("maplibregl-compact-show")) return;
          watch.disconnect();
          setTimeout(greet, 400);
        });
        watch.observe(box, { attributes: true, attributeFilter: ["class"] });
      }, 1500);
      for (const type of ["mousedown", "touchstart", "wheel"]) {
        this.map.getCanvasContainer().addEventListener(type, () => { if (!greeting.hidden) this.hideGreeting(); }, { passive: true });
      }
    }

    // ---------- messages ----------
    addMessage(who, html) {
      const el = document.createElement("div");
      el.className = `msg msg-${who}`;
      el.innerHTML = html;
      $("chat-log").appendChild(el);
      this.scrollLog();
      return el;
    }
    scrollLog() { $("chat-log").scrollTop = $("chat-log").scrollHeight; }
    static typing(label = "Updating the map") {
      return `<p class="typing" aria-label="${escapeHtml(label)}"><span></span><span></span><span></span></p>`;
    }

    remember(question, plan) {
      this.chat.push({ question, plan: Object.fromEntries(this.keep.map((key) => [key, plan[key]])) });
      if (this.chat.length > CHAT_MEMORY) this.chat.shift();
    }

    reveal(titleId) { revealSection(titleId, this.hooks.setCollapsed); }

    // ---------- asking ----------
    async ask(question) {
      if (this.asking) return;
      this.asking = true;
      $("chat-send").disabled = true;
      this.addMessage("user", `<p>${escapeHtml(question)}</p>`);
      const reply = this.addMessage("bot", Volta.typing("Thinking"));
      try {
        let plan;
        try {
          const response = await fetch(this.askUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ question, history: this.chat, page: this.page }),
            signal: withTimeout(ASK_TIMEOUT_MS),
          });
          plan = await response.json();
          if (!response.ok) throw new Error(plan && plan.error ? plan.error : "HTTP " + response.status);
          if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new Error("HTTP 200 without settings");
        } catch (err) {
          console.warn("Assistant failed:", err);
          // The server's own messages are written for visitors; anything technical is replaced.
          const message = err && err.message && !/^HTTP|fetch|JSON|Unexpected|abort|timed? ?out|network/i.test(err.message)
            ? err.message : "The assistant is unavailable right now.";
          reply.innerHTML = `<p>${escapeHtml(message)} You can still use the search and the panel.</p>`;
          return;
        }
        // Could not understand, or not about this map: answer in words, change nothing, and keep
        // the question out of the chat's memory so it does not confuse the next follow-up.
        if (plan.unclear || plan.out_of_scope) {
          reply.innerHTML = `<p>${escapeHtml(plan.reply || (plan.unclear ? this.fallback.unclear : this.fallback.scope))}</p>`;
          return;
        }
        this.remember(question, plan);
        try {
          await this.onPlan(plan, reply);
        } catch (err) {
          // A bug in carrying out an answer must never leave the chat stuck on its dots.
          console.error("Could not carry out the answer:", err);
          reply.querySelector(".typing")?.remove();
          reply.insertAdjacentHTML("beforeend", "<p>Something went wrong showing that. Please try again.</p>");
        }
        this.scrollLog();
      } finally {
        this.asking = false;
        $("chat-send").disabled = false;
      }
    }
  }

  root.AtlasVolta = { Volta, voltaSVG, revealSection };
})(window);

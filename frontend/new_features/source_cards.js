/* Feature 2: clickable source cards.
 *
 * Click a source chip under an answer to open the exact passage the answer
 * was based on. Click it again (or another chip) to close / switch.
 *
 * How it plugs in: it wraps app.js's renderAssistantMessage(). The original
 * draws the answer as before; then this file makes each chip clickable and
 * adds a passage panel under the chips. The passage text comes from the
 * "text" field the backend now sends with every source. That text already
 * went through the role filter, so a user only ever sees passages from
 * documents their role may read.
 *
 * To remove: delete the <script> line in index.html.
 */
(function () {
  "use strict";

  const css = `
    .source-chip[data-has-passage] { cursor: pointer; user-select: none; }
    .source-chip[data-has-passage]:hover { border-color: var(--accent, #6366f1); }
    .source-chip[aria-expanded="true"] { outline: 1.5px solid var(--accent, #6366f1); }
    .source-passage { margin: 6px 0 2px; padding: 10px 12px; border-radius: 10px;
                      border: 1px solid var(--border, rgba(128,128,128,.3));
                      background: var(--bg-panel, rgba(128,128,128,.08));
                      font-size: 13px; line-height: 1.55; }
    .source-passage-head { display:flex; justify-content:space-between; gap:8px;
                           font-size: 11px; opacity: .75; margin-bottom: 6px; }
    .source-passage-text { white-space: pre-wrap; max-height: 220px; overflow:auto; }
  `;

  function addStyles() {
    if (document.getElementById("source-cards-style")) return;
    const s = document.createElement("style");
    s.id = "source-cards-style";
    s.textContent = css;
    document.head.appendChild(s);
  }

  function enhance(msgEl, sources) {
    if (!msgEl || !sources || !sources.length) return;
    const box = msgEl.querySelector(".sources");
    if (!box) return;
    const chips = box.querySelectorAll(".source-chip");

    const panel = document.createElement("div");
    panel.className = "source-passage";
    panel.hidden = true;
    box.insertAdjacentElement("afterend", panel);

    let openIndex = -1;

    function close() {
      panel.hidden = true;
      if (openIndex >= 0) chips[openIndex].setAttribute("aria-expanded", "false");
      openIndex = -1;
    }

    function open(i) {
      const s = sources[i];
      if (openIndex >= 0) chips[openIndex].setAttribute("aria-expanded", "false");
      openIndex = i;
      chips[i].setAttribute("aria-expanded", "true");
      panel.textContent = "";
      const head = document.createElement("div");
      head.className = "source-passage-head";
      const l = document.createElement("span");
      l.textContent = s.file + " · page " + s.page;
      const r = document.createElement("span");
      r.textContent = "relevance " + s.relevance;
      head.append(l, r);
      const body = document.createElement("div");
      body.className = "source-passage-text";
      body.textContent = s.text; // textContent, never innerHTML: document text is untrusted
      panel.append(head, body);
      panel.hidden = false;
    }

    function toggle(i) {
      if (openIndex === i) close();
      else open(i);
    }

    chips.forEach((chip, i) => {
      if (!sources[i] || !sources[i].text) return; // old saved answers have no passage
      chip.dataset.hasPassage = "1";
      chip.setAttribute("role", "button");
      chip.tabIndex = 0;
      chip.setAttribute("aria-expanded", "false");
      chip.addEventListener("click", (e) => {
        if (e.target.closest(".chip-copy")) return; // the copy icon keeps its own job
        toggle(i);
      });
      chip.addEventListener("keydown", (e) => {
        if (e.target !== chip) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle(i);
        }
      });
    });
  }

  function start() {
    addStyles();
    const original = window.renderAssistantMessage;
    if (typeof original !== "function") {
      console.warn("source_cards.js: renderAssistantMessage not found; load this file after app.js");
      return;
    }
    window.renderAssistantMessage = function (thinkingMsg, opts) {
      const result = original.apply(this, arguments);
      try {
        enhance(thinkingMsg, opts && opts.sources);
      } catch (err) {
        console.error("source_cards.js:", err);
      }
      return result;
    };
  }

  start();
})();
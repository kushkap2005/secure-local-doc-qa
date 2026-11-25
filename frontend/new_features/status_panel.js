/* The left "System status" panel: what each role sees.
 *
 *   Admin        the full operator view:
 *                  Backend            reachable / unreachable              (filled by app.js)
 *                  Chunks indexed     chunks this role can search          (app.js)
 *                  Documents visible  documents this role can see          (app.js)
 *                  Questions asked    questions in your saved chats        (question_counter.js)
 *                  Language model     green / red light: is the local LLM server (Ollama)
 *                                     up, and is the model this app uses installed there?
 *                  Embedding model    green / red light: is it loaded in the server?
 *                  Last upload        the newest upload, and how long ago
 *                  Relevance cutoff   the minimum similarity a passage needs to be used
 *   Staff, Guest one line only:
 *                  Assistant          Ready / Unavailable
 *   Signed out   only the Backend row (is the server up at all?)
 *
 * Least privilege: the SERVER decides. GET /system/health sends the details only
 * to an Admin; everyone else gets just {"ready": true/false}. This file shows the
 * full view only when those details actually arrived, so an edited page can never
 * show more than the server sent.
 *
 * Refreshes every 15 seconds while the tab is visible, and right after
 * sign-in / sign-out. Text is set with textContent only.
 *
 * Standalone: one <script> line in index_new.html. To remove: delete that line.
 */
(function () {
  "use strict";

  const TOKEN_KEY = "docrag_token";
  const POLL_MS = 15000;

  // The rows that come from index_new.html, found through the value cell inside each one.
  const BASE_IDS = {
    backend: "status-backend",
    chunks: "status-chunks",
    docs: "status-docs",
    questions: "status-questions",
  };

  const css = `
    .sp-dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:7px; vertical-align:middle; background:#888; }
    .sp-ok   { background:#22c55e; box-shadow:0 0 6px rgba(34,197,94,.7); }
    .sp-bad  { background:#ef4444; box-shadow:0 0 6px rgba(239,68,68,.6); }
    .sp-warn { background:#f59e0b; }
    .sp-row[hidden] { display:none; }
    .sp-file { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;
               font-size:.78rem; font-weight:600; line-height:1.25; word-break:break-all; }
    .sp-ago { display:block; margin-top:3px; font-size:.7rem; font-weight:400; opacity:.65; }
    .status-grid .status-row.sp-row dd { font-size:.95rem; font-weight:600; letter-spacing:0; min-width:0; word-break:break-word; text-align:left; }
    /* The one-line "Assistant" row: full width, label on the left, light on the right. */
    .status-grid .status-row.sp-assistant { grid-column:1 / -1; flex-direction:row; align-items:center; justify-content:space-between; }
    .status-grid .status-row.sp-assistant dt { font-size:.8rem; text-transform:none; letter-spacing:0; color:var(--text-mute); }
    .status-grid .status-row.sp-assistant dd { font-size:.85rem; font-weight:600; letter-spacing:0; }
  `;

  const rows = {};       // the Admin-only rows added here: llm, embedding, upload, cutoff
  const base = {};       // the rows from index_new.html, by key (see BASE_IDS)
  let assistant = null;  // { row, dd }: the one-line view for Staff and Guest
  let lastView = null;   // "admin" or "user", from the last answer the server gave
  let timer = null;

  function token() {
    try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; }
  }

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function addRow(key, label) {
    const row = h("div", "status-row sp-row");
    row.hidden = true;
    const dt = h("dt", "", label);
    const dd = h("dd");
    row.append(dt, dd);
    rows[key] = { row, dd };
    return row;
  }

  function build() {
    const grid = document.querySelector(".status-grid");
    if (!grid) return false;
    if (rows.llm) return true; // already built

    const style = h("style");
    style.textContent = css;
    document.head.appendChild(style);

    Object.entries(BASE_IDS).forEach(([key, id]) => {
      const cell = document.getElementById(id);
      const row = cell && cell.closest(".status-row");
      if (row) base[key] = row;
    });

    // The Assistant row goes right AFTER the Backend row. style.css makes the first
    // and the last row of the grid full-width, so this keeps the Admin layout as it was.
    const aRow = h("div", "status-row sp-assistant");
    aRow.hidden = true;
    const aDd = h("dd");
    aRow.append(h("dt", "", "Assistant"), aDd);
    assistant = { row: aRow, dd: aDd };
    grid.insertBefore(aRow, base.backend ? base.backend.nextSibling : grid.firstChild);

    [["llm", "Language model"], ["embedding", "Embedding model"], ["upload", "Last upload"], ["cutoff", "Relevance cutoff"]]
      .forEach(([k, l]) => grid.appendChild(addRow(k, l)));
    return true;
  }

  function show(row, visible) {
    if (row) row.hidden = !visible;
  }

  function showBase(backendRow, otherRows) {
    show(base.backend, backendRow);
    ["chunks", "docs", "questions"].forEach((k) => show(base[k], otherRows));
  }

  function showAdminRows(visible) {
    Object.values(rows).forEach((r) => show(r.row, visible));
  }

  function light(dd, kind, text, hint) {
    dd.textContent = "";
    dd.appendChild(h("span", "sp-dot sp-" + kind));
    dd.appendChild(document.createTextNode(text));
    dd.title = hint || "";
  }

  function plain(dd, text, hint) {
    dd.textContent = text;
    dd.className = "mono";
    dd.title = hint || "";
  }

  function ago(iso) {
    const t = new Date(iso).getTime();
    if (isNaN(t)) return "";
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + " min ago";
    if (s < 86400) return Math.floor(s / 3600) + " h ago";
    return Math.floor(s / 86400) + " d ago";
  }

  /* ---------- the three views ---------- */

  function signedOutView() {
    lastView = null;
    showBase(true, false); // only "is the server up?"
    showAdminRows(false);
    show(assistant.row , false);
  }

  function userView(ready) {
    showBase(false, false);
    showAdminRows(false);
    show(assistant.row, true);
    if (ready) light(assistant.dd, "ok", "Ready", "The assistant can answer questions.");
    else light(assistant.dd, "bad", "Unavailable", "The assistant can't answer right now. Please tell your admin.");
  }

  // d = the details from the server, or null when they could not be fetched.
  function adminView(d) {
    showBase(true, true);
    show(assistant.row, false);
    if (!d) { showAdminRows(false); return; } // the Backend row already says what's wrong
    showAdminRows(true);

    if (d.llm === "ok") light(rows.llm.dd, "ok", "Ready", "The local LLM server answers and the model is installed.");
    else if (d.llm === "model_missing") light(rows.llm.dd, "warn", "Model not installed", "Ollama is running but the model this app uses is not pulled yet.");
    else light(rows.llm.dd, "bad", "Not running", "The local LLM server (Ollama) is not answering. Start Ollama.");

    if (d.embedding) light(rows.embedding.dd, "ok", "Loaded", "The embedding model used to search is loaded.");
    else light(rows.embedding.dd, "bad", "Not loaded", "The embedding model is not loaded in the server.");

    if (d.last_upload && d.last_upload.file) {
      const dd = rows.upload.dd;
      dd.textContent = "";
      dd.className = "";
      dd.title = d.last_upload.file; // hover shows the full name
      dd.appendChild(h("span", "sp-file", d.last_upload.file));
      const when = ago(d.last_upload.time);
      if (when) dd.appendChild(h("span", "sp-ago", when));
    } else {
      plain(rows.upload.dd, "none yet", "No upload has been recorded yet.");
    }

    const c = d.search && d.search.relevance_cutoff;
    plain(rows.cutoff.dd, c === null || c === undefined ? "unknown" : String(c), "A passage needs at least this similarity to be used in an answer.");
  }

  // The request failed (server down, or the token was just rejected). Keep showing the
  // view this person had; before the first answer, ask app.js which role is signed in.
  function failedView() {
    const admin = lastView ? lastView === "admin" : typeof hasRole === "function" && hasRole("Admin");
    if (admin) adminView(null);
    else userView(false);
  }

  async function refresh() {
    if (!build()) return;
    const t = token();
    if (!t) { signedOutView(); return; }
    try {
      const apiBase = typeof API_BASE !== "undefined" ? API_BASE : "";
      const res = await fetch(apiBase + "/system/health", { headers: { Authorization: "Bearer " + t } });
      if (!res.ok) { failedView(); return; }
      const d = await res.json();
      if (typeof d.llm === "string") {
        lastView = "admin"; // only an Admin's answer carries the details
        adminView(d);
      } else {
        lastView = "user"
        userView(d.ready === true);
      }
    } catch (e) {
      failedView();
    }
  }

  function start() {
    refresh();
    timer = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
    // refresh right after sign-in / sign-out (the account area changes)
    const area = document.getElementById("account-area");
    if (area) new MutationObserver(() => refresh()).observe(area, { childList: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
/* Extra rows for the left "System status" panel.
 *
 *   Language model     green / red light: is the local LLM server (Ollama) up,
 *                      and is the model this app uses installed there?
 *   Embedding model    green / red light: is it loaded in the server?
 *   Last upload        the newest upload YOUR role may see, and how long ago
 *   Relevance cutoff   the minimum similarity a passage needs to be used
 *
 * Data comes from GET /system/health (any signed-in role). It refreshes every
 * 15 seconds while the tab is visible, and immediately after sign-in. Before
 * sign-in the rows are hidden. Text is set with textContent only.
 *
 * Standalone: one <script> line in index_new.html. To remove: delete that line.
 */
(function () {
  "use strict";

  const TOKEN_KEY = "docrag_token";
  const POLL_MS = 15000;

  const css = `
    .sp-dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:7px; vertical-align:middle; background:#888; }
    .sp-ok   { background:#22c55e; box-shadow:0 0 6px rgba(34,197,94,.7); }
    .sp-bad  { background:#ef4444; box-shadow:0 0 6px rgba(239,68,68,.6); }
    .sp-warn { background:#f59e0b; }
    .sp-row[hidden] { display:none; }
    .status-grid .status-row.sp-row dd { font-size:.95rem; font-weight:600; letter-spacing:0; min-width:0; word-break:break-word; text-align:left; }
  `;

  const rows = {};
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
    if (!grid || rows.llm) return !!rows.llm;
    const style = h("style");
    style.textContent = css;
    document.head.appendChild(style);
    [["llm", "Language model"], ["embedding", "Embedding model"], ["upload", "Last upload"], ["cutoff", "Relevance cutoff"]]
      .forEach(([k, l]) => grid.appendChild(addRow(k, l)));
    return true;
  }

  function light(key, kind, text, hint) {
    const dd = rows[key].dd;
    dd.textContent = "";
    dd.appendChild(h("span", "sp-dot sp-" + kind));
    dd.appendChild(document.createTextNode(text));
    dd.title = hint || "";
  }

  function plain(key, text, hint) {
    rows[key].dd.textContent = text;
    rows[key].dd.className = "mono";
    rows[key].dd.title = hint || "";
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

  function hideAll() {
    Object.values(rows).forEach((r) => { r.row.hidden = true; });
  }

  function render(d) {
    Object.values(rows).forEach((r) => { r.row.hidden = false; });

    if (d.llm === "ok") light("llm", "ok", "Ready", "The local LLM server answers and the model is installed.");
    else if (d.llm === "model_missing") light("llm", "warn", "Model not installed", "Ollama is running but the model this app uses is not pulled yet.");
    else light("llm", "bad", "Not running", "The local LLM server (Ollama) is not answering. Start Ollama.");

    if (d.embedding) light("embedding", "ok", "Loaded", "The embedding model used to search is loaded.");
    else light("embedding", "bad", "Not loaded", "The embedding model is not loaded in the server.");

    if (d.last_upload && d.last_upload.file) {
      const when = ago(d.last_upload.time);
      plain("upload", d.last_upload.file + (when ? " (" + when + ")" : ""), "The newest upload your role can see.");
      rows.upload.dd.style.wordBreak = "break-word";
    } else {
      plain("upload", "none yet", "No upload your role can see has been recorded.");
    }

    const c = d.search && d.search.relevance_cutoff;
    plain("cutoff", c === null || c === undefined ? "unknown" : String(c), "A passage needs at least this similarity to be used in an answer.");
  }

  async function refresh() {
    if (!build()) return;
    const t = token();
    if (!t) { hideAll(); return; }
    try {
      const base = typeof API_BASE !== "undefined" ? API_BASE : "";
      const res = await fetch(base + "/system/health", { headers: { Authorization: "Bearer " + t } });
      if (!res.ok) { hideAll(); return; }
      render(await res.json());
    } catch (e) {
      hideAll(); // server unreachable: the Backend row already says so
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
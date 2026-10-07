/* Feature 15: Audit log viewer.
 *
 * Adds an "Audit log" button next to "Manage users" (Admins only). It opens a
 * panel listing who did what and when (sign-ins, failed sign-ins, uploads,
 * PDF opens, account and permission changes, refused requests), newest
 * first, with a filter by action and by username, and paging.
 * Data comes from GET /admin/audit, which the server only answers for Admins.
 *
 * Standalone: it builds its own panel and styles, so index_new.html only needs
 * the one <script> line. To remove: delete that line.
 */
(function () {
  "use strict";

  const TOKEN_KEY = "docrag_token"; // same key app.js uses
  const PAGE = 25;

  // plain-language names for the action codes the server writes
  const LABELS = {
    login: "Signed in",
    login_failed: "Failed sign-in",
    ask: "Asked a question",
    ask_failed: "Question failed",
    upload: "Uploaded a document",
    upload_duplicate: "Upload refused (duplicate)",
    upload_failed: "Upload refused",
    pdf_opened: "Opened a PDF",
    pdf_denied_or_missing: "PDF not available to them",
    clear_all_documents: "Cleared all documents",
    password_changed: "Changed their password",
    password_change_failed: "Password change failed",
    user_created: "Created an account",
    user_role_changed: "Changed a role",
    document_level_changed: "Changed who can see a document",
    access_denied: "Request refused (not allowed)",
  };
  // the ones an Admin should notice
  const WARN = new Set(["login_failed", "password_change_failed", "access_denied", "clear_all_documents", "pdf_denied_or_missing", "upload_failed", "ask_failed"]);

  const css = `
    .al-overlay { position:fixed; inset:0; z-index:60; background:rgba(0,0,0,.55);
                  display:flex; align-items:flex-start; justify-content:center; padding:4vh 16px; overflow:auto; }
    .al-overlay[hidden] { display:none; }
    .al { width:min(1100px,100%); background:var(--bg-panel, #11151f); color:inherit;
          border:1px solid var(--border, rgba(128,128,128,.3)); border-radius:16px; padding:20px 22px 22px; }
    .al-top { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:6px; }
    .al-top h2 { margin:0; font-size:18px; }
    .al-actions { display:flex; gap:8px; }
    .al-note { font-size:12px; opacity:.65; margin:0 0 12px; }
    .al-filters { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:12px; }
    .al-filters select, .al-filters input { font:inherit; font-size:13px; color:inherit; background:transparent;
          border:1px solid var(--border, rgba(128,128,128,.35)); border-radius:8px; padding:6px 10px; min-width:170px; }
    .al-filters select option { color:#111; }
    .al-wrap { overflow:auto; max-height:56vh; border:1px solid var(--border, rgba(128,128,128,.25)); border-radius:12px; }
    .al table { width:100%; border-collapse:collapse; font-size:13px; }
    .al th { text-align:left; font-weight:600; font-size:12px; opacity:.75; padding:8px 10px; position:sticky; top:0;
             background:var(--bg-panel, #11151f); border-bottom:1px solid var(--border, rgba(128,128,128,.3)); white-space:nowrap; }
    .al td { padding:7px 10px; border-top:1px solid var(--border, rgba(128,128,128,.18)); vertical-align:top; word-break:break-word; }
    .al td.al-when { white-space:nowrap; font-variant-numeric:tabular-nums; opacity:.85; }
    .al-act-warn { color:#fbbf24; font-weight:600; }
    :root[data-theme="light"] .al-act-warn { color:#b45309; }
    .al-badge { display:inline-block; padding:1px 8px; border-radius:999px; font-size:11px; font-weight:600; border:1px solid transparent; }
    .al-badge-guest { color:#4ade80; background:rgba(34,197,94,.14);  border-color:rgba(34,197,94,.35); }
    .al-badge-staff { color:#93c5fd; background:rgba(59,130,246,.14); border-color:rgba(59,130,246,.35); }
    .al-badge-admin { color:#fbbf24; background:rgba(245,158,11,.16); border-color:rgba(245,158,11,.40); }
    .al-bad { color:#f87171; }
    .al-pager { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:12px; font-size:13px; }
    .al-pager-btns { display:flex; gap:8px; }
    .al-msg { padding:30px 0; text-align:center; opacity:.8; }
  `;

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text; // text only, never innerHTML: log values are untrusted
    return e;
  }

  function addStyles() {
    if (document.getElementById("al-style")) return;
    const s = document.createElement("style");
    s.id = "al-style";
    s.textContent = css;
    document.head.appendChild(s);
  }

  let overlay, tableBox, pagerInfo, prevBtn, nextBtn, actionSel, userInp;
  let offset = 0;
  let total = 0;
  let loadId = 0;
  let typingTimer = null;

  function ensureOverlay() {
    if (overlay) return;
    overlay = h("div", "al-overlay");
    overlay.hidden = true;
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

    const box = h("div", "al");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", "Audit log");

    const top = h("div", "al-top");
    top.appendChild(h("h2", "", "Audit log"));
    const actions = h("div", "al-actions");
    const refresh = h("button", "btn btn-ghost", "Refresh");
    refresh.type = "button";
    refresh.addEventListener("click", () => load());
    const closeBtn = h("button", "btn btn-ghost", "Close");
    closeBtn.type = "button";
    closeBtn.addEventListener("click", close);
    actions.append(refresh, closeBtn);
    top.appendChild(actions);

    const note = h("p", "al-note", "Newest first. Times are in your local time zone. Entries can't be edited or deleted from the app. Passwords and answer text are never recorded.");

    const filters = h("div", "al-filters");
    actionSel = h("select");
    actionSel.setAttribute("aria-label", "Filter by action");
    actionSel.appendChild(new Option("All actions", ""));
    actionSel.addEventListener("change", () => { offset = 0; load(); });
    userInp = h("input");
    userInp.type = "search";
    userInp.placeholder = "Filter by username";
    userInp.setAttribute("aria-label", "Filter by username");
    userInp.addEventListener("input", () => {
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => { offset = 0; load(); }, 300);
    });
    filters.append(actionSel, userInp);

    tableBox = h("div", "al-wrap");

    const pager = h("div", "al-pager");
    pagerInfo = h("span", "", "");
    const btns = h("div", "al-pager-btns");
    prevBtn = h("button", "btn btn-ghost", "\u2039 Newer");
    prevBtn.type = "button";
    prevBtn.addEventListener("click", () => { offset = Math.max(0, offset - PAGE); load(); });
    nextBtn = h("button", "btn btn-ghost", "Older \u203a");
    nextBtn.type = "button";
    nextBtn.addEventListener("click", () => { offset += PAGE; load(); });
    btns.append(prevBtn, nextBtn);
    pager.append(pagerInfo, btns);

    box.append(top, note, filters, tableBox, pager);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !overlay.hidden) close();
    });
  }

  function open() {
    ensureOverlay();
    overlay.hidden = false;
    offset = 0;
    load();
  }

  function close() {
    if (overlay) overlay.hidden = true;
  }

  function message(text) {
    tableBox.textContent = "";
    tableBox.appendChild(h("div", "al-msg", text));
    pagerInfo.textContent = "";
    prevBtn.disabled = true;
    nextBtn.disabled = true;
  }

  async function load() {
    const myId = ++loadId; // ignore answers that arrive after a newer request
    message("Loading\u2026");
    const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (actionSel.value) params.set("action", actionSel.value);
    const who = userInp.value.trim();
    if (who) params.set("username", who);

    let res;
    try {
      const base = typeof API_BASE !== "undefined" ? API_BASE : "";
      let token = null;
      try { token = localStorage.getItem(TOKEN_KEY); } catch (e) { /* storage blocked */ }
      res = await fetch(base + "/admin/audit?" + params.toString(), {
        headers: token ? { Authorization: "Bearer " + token } : {},
      });
    } catch (e) {
      if (myId === loadId) message("Couldn't reach the server. Is it running?");
      return;
    }
    if (myId !== loadId) return;
    if (res.status === 401) return message("Your session expired. Please sign in again.");
    if (res.status === 403) return message("Only Admins can see the audit log.");
    if (!res.ok) return message("Couldn't load the audit log (error " + res.status + ").");
    const data = await res.json();
    if (myId !== loadId) return;
    render(data);
  }

  function fillActions(actions) {
    const chosen = actionSel.value;
    const known = new Set(Array.from(actionSel.options).map((o) => o.value));
    actions.forEach((a) => {
      if (!known.has(a)) actionSel.appendChild(new Option(LABELS[a] || a, a));
    });
    actionSel.value = chosen;
  }

  function when(ts) {
    const d = new Date(ts);
    return isNaN(d) ? ts : d.toLocaleString();
  }

  function render(data) {
    fillActions(data.actions || []);
    total = data.total;
    tableBox.textContent = "";
    if (!data.items.length) {
      message(actionSel.value || userInp.value.trim() ? "No entries match this filter." : "Nothing has been recorded yet.");
      pagerInfo.textContent = "0 entries";
      return;
    }
    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    ["When", "Who", "Role", "What happened", "About", "Details", "Result"].forEach((t) => hr.appendChild(h("th", "", t)));
    thead.appendChild(hr);
    const tbody = document.createElement("tbody");
    data.items.forEach((it) => {
      const tr = document.createElement("tr");
      const td = (child, cls) => {
        const c = document.createElement("td");
        if (cls) c.className = cls;
        if (child instanceof Node) c.appendChild(child);
        else c.textContent = child;
        tr.appendChild(c);
      };
      td(when(it.ts), "al-when");
      td(it.username || "\u2014");
      td(it.role ? h("span", "al-badge al-badge-" + it.role.toLowerCase(), it.role) : "\u2014");
      td(h("span", WARN.has(it.action) ? "al-act-warn" : "", LABELS[it.action] || it.action));
      td(it.target || "\u2014");
      td(it.detail || "\u2014");
      td(h("span", it.status >= 400 ? "al-bad" : "", String(it.status)));
      tbody.appendChild(tr);
    });
    table.append(thead, tbody);
    tableBox.appendChild(table);

    const from = data.offset + 1;
    const to = data.offset + data.items.length;
    pagerInfo.textContent = from + "\u2013" + to + " of " + data.total;
    prevBtn.disabled = data.offset <= 0;
    nextBtn.disabled = to >= data.total;
  }

  // ---- put the button next to "Manage users" ------------------------------
  function addButton() {
    const admin = document.getElementById("admin-btn");
    if (!admin || document.getElementById("audit-btn")) return;
    const b = h("button", "btn btn-ghost", "Audit log");
    b.id = "audit-btn";
    b.type = "button";
    b.addEventListener("click", open);
    admin.insertAdjacentElement("beforebegin", b);
  }

  function start() {
    addStyles();
    addButton();
    const area = document.getElementById("account-area");
    if (area) new MutationObserver(addButton).observe(area, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
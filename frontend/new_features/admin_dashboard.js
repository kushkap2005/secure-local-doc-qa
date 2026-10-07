/* Feature 14: Admin dashboard.
 *
 * Adds a "Dashboard" button next to "Manage users" (Admins only). It opens a
 * full-screen panel with totals, users per role, documents per access level,
 * and two tables (users, documents). Data comes from GET /admin/dashboard,
 * which the server only answers for Admins.
 *
 * Standalone: it builds its own panel and styles, so index.html only needs
 * the one <script> line. To remove: delete that line.
 */
(function () {
  "use strict";

  const TOKEN_KEY = "docrag_token"; // same key app.js uses
  const LEVEL_LABELS = { Guest: "Everyone", Staff: "Staff & Admin", Admin: "Admin only" };
  const ORDER = ["Guest", "Staff", "Admin"];

  const css = `
    .dash-overlay { position:fixed; inset:0; z-index:60; background:rgba(0,0,0,.55);
                    display:flex; align-items:flex-start; justify-content:center;
                    padding:4vh 16px; overflow:auto; }
    .dash-overlay[hidden] { display:none; }
    .dash { width:min(980px,100%); background:var(--bg-panel, #11151f); color:inherit;
            border:1px solid var(--border, rgba(128,128,128,.3)); border-radius:16px;
            padding:20px 22px 24px; }
    .dash-top { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:16px; }
    .dash-top h2 { margin:0; font-size:18px; }
    .dash-actions { display:flex; gap:8px; }
    .dash-tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-bottom:16px; }
    .dash-tile { border:1px solid var(--border, rgba(128,128,128,.3)); border-radius:12px; padding:12px 14px; }
    .dash-tile-num { font-size:28px; font-weight:700; line-height:1.1; }
    .dash-tile-label { font-size:12px; opacity:.7; margin-top:2px; }
    .dash-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:12px; margin-bottom:16px; }
    .dash-card { border:1px solid var(--border, rgba(128,128,128,.3)); border-radius:12px; padding:12px 14px; }
    .dash-card h3 { margin:0 0 10px; font-size:13px; opacity:.85; }
    .dash-bar-row { display:grid; grid-template-columns:110px 1fr 28px; align-items:center; gap:8px; margin:6px 0; font-size:13px; }
    .dash-bar { height:8px; border-radius:99px; background:rgba(128,128,128,.2); overflow:hidden; }
    .dash-bar > span { display:block; height:100%; border-radius:99px; }
    .dash-bar-guest > span { background:#22c55e; }
    .dash-bar-staff > span { background:#3b82f6; }
    .dash-bar-admin > span { background:#f59e0b; }
    .dash-num { text-align:right; font-variant-numeric:tabular-nums; }
    .dash-table-wrap { overflow:auto; max-height:260px; }
    .dash table { width:100%; border-collapse:collapse; font-size:13px; }
    .dash th { text-align:left; font-weight:600; font-size:12px; opacity:.7; padding:4px 8px 6px 0; position:sticky; top:0; background:var(--bg-panel, #11151f); }
    .dash td { padding:6px 8px 6px 0; border-top:1px solid var(--border, rgba(128,128,128,.2)); word-break:break-word; }
    .dash-badge { display:inline-block; padding:1px 8px; border-radius:999px; font-size:11px; font-weight:600;
                  line-height:18px; border:1px solid transparent; white-space:nowrap; }
    .dash-badge-guest { color:#4ade80; background:rgba(34,197,94,.14);  border-color:rgba(34,197,94,.35); }
    .dash-badge-staff { color:#93c5fd; background:rgba(59,130,246,.14); border-color:rgba(59,130,246,.35); }
    .dash-badge-admin { color:#fbbf24; background:rgba(245,158,11,.16); border-color:rgba(245,158,11,.40); }
    :root[data-theme="light"] .dash-badge-guest { color:#15803d; }
    :root[data-theme="light"] .dash-badge-staff { color:#1d4ed8; }
    :root[data-theme="light"] .dash-badge-admin { color:#b45309; }
    .dash-msg { padding:30px 0; text-align:center; opacity:.8; }
    @media (max-width:520px) { .dash-bar-row { grid-template-columns:90px 1fr 24px; } }
  `;

  function addStyles() {
    if (document.getElementById("dash-style")) return;
    const s = document.createElement("style");
    s.id = "dash-style";
    s.textContent = css;
    document.head.appendChild(s);
  }

  // small helper: make an element, set text safely (never innerHTML)
  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // coloured pill; "text" is what it says, "level" picks the colour
  function badge(level, text) {
    return h("span", "dash-badge dash-badge-" + level.toLowerCase(), text);
  }

  let overlay, body;

  function ensureOverlay() {
    if (overlay) return;
    overlay = h("div", "dash-overlay");
    overlay.hidden = true;
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

    const box = h("div", "dash");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", "Admin dashboard");

    const top = h("div", "dash-top");
    top.appendChild(h("h2", "", "Admin dashboard"));
    const actions = h("div", "dash-actions");
    const refresh = h("button", "btn btn-ghost", "Refresh");
    refresh.type = "button";
    refresh.addEventListener("click", load);
    const closeBtn = h("button", "btn btn-ghost", "Close");
    closeBtn.type = "button";
    closeBtn.addEventListener("click", close);
    actions.append(refresh, closeBtn);
    top.appendChild(actions);

    body = h("div", "dash-body");
    box.append(top, body);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !overlay.hidden) close();
    });
  }

  function open() {
    ensureOverlay();
    overlay.hidden = false;
    load();
  }

  function close() {
    if (overlay) overlay.hidden = true;
  }

  function message(text) {
    body.textContent = "";
    body.appendChild(h("div", "dash-msg", text));
  }

  async function load() {
    message("Loading…");
    let res;
    try {
      const base = typeof API_BASE !== "undefined" ? API_BASE : "";
      let token = null;
      try { token = localStorage.getItem(TOKEN_KEY); } catch (e) { /* storage blocked */ }
      res = await fetch(base + "/admin/dashboard", {
        headers: token ? { Authorization: "Bearer " + token } : {},
      });
    } catch (e) {
      return message("Couldn't reach the server. Is it running?");
    }
    if (res.status === 401) return message("Your session expired. Please sign in again.");
    if (res.status === 403) return message("Only Admins can see the dashboard.");
    if (!res.ok) return message("Couldn't load the dashboard (error " + res.status + ").");
    render(await res.json());
  }

  function tile(num, label) {
    const t = h("div", "dash-tile");
    t.append(h("div", "dash-tile-num", String(num)), h("div", "dash-tile-label", label));
    return t;
  }

  function barCard(title, counts, labelFor) {
    const card = h("div", "dash-card");
    card.appendChild(h("h3", "", title));
    const max = Math.max(1, ...ORDER.map((k) => counts[k] || 0));
    ORDER.forEach((k) => {
      const n = counts[k] || 0;
      const row = h("div", "dash-bar-row");
      const bar = h("div", "dash-bar dash-bar-" + k.toLowerCase());
      const fill = document.createElement("span");
      fill.style.width = Math.round((n / max) * 100) + "%";
      bar.appendChild(fill);
      row.append(h("span", "", labelFor(k)), bar, h("span", "dash-num", String(n)));
      card.appendChild(row);
    });
    return card;
  }

  function tableCard(title, headers, rows) {
    const card = h("div", "dash-card");
    card.appendChild(h("h3", "", title));
    if (!rows.length) {
      card.appendChild(h("div", "dash-msg", "Nothing here yet."));
      return card;
    }
    const wrap = h("div", "dash-table-wrap");
    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    headers.forEach((t) => hr.appendChild(h("th", "", t)));
    thead.appendChild(hr);
    const tbody = document.createElement("tbody");
    rows.forEach((cells) => {
      const tr = document.createElement("tr");
      cells.forEach((c) => {
        const td = document.createElement("td");
        if (c instanceof Node) td.appendChild(c);
        else td.textContent = c;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.append(thead, tbody);
    wrap.appendChild(table);
    card.appendChild(wrap);
    return card;
  }

  function render(d) {
    body.textContent = "";

    const tiles = h("div", "dash-tiles");
    tiles.append(
      tile(d.totals.users, "Users"),
      tile(d.totals.documents, "Documents"),
      tile(d.totals.chunks, "Searchable chunks")
    );

    const grid = h("div", "dash-grid");
    grid.append(
      barCard("Users by role", d.users_by_role, (k) => k),
      barCard("Documents by access level", d.documents_by_level, (k) => LEVEL_LABELS[k])
    );

    const users = tableCard(
      "Users",
      ["Username", "Role"],
      d.users.map((u) => [u.username, badge(u.role, u.role)])
    );
    const docs = tableCard(
      "Documents",
      ["Name", "Chunks", "Who can see it"],
      d.documents.map((x) => [x.name, String(x.chunks), badge(x.min_role, LEVEL_LABELS[x.min_role] || x.min_role)])
    );
    const tables = h("div", "dash-grid");
    tables.append(users, docs);

    body.append(tiles, grid, tables);
  }

  // ---- put the button next to "Manage users" ------------------------------
  function addButton() {
    const admin = document.getElementById("admin-btn");
    if (!admin || document.getElementById("dash-btn")) return;
    const b = h("button", "btn btn-ghost", "Dashboard");
    b.id = "dash-btn";
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
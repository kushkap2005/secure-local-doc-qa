/* Logo menu: click the logo / name (top-left) to open a small menu.
 *
 *   Settings            opens the account settings panel (if signed in)
 *   New conversation    same as the + button
 *   Keyboard shortcuts  same as the keyboard icon
 *   Privacy & security  a plain-language page: what stays here, who sees what
 *   Diagnostics         Admin only: models, counts, search settings, copy button
 *   Sign out            same as the sign-out icon (it asks for confirmation)
 *
 * The first, second, third and last items just click the existing buttons, so
 * they behave exactly as before and are hidden when that button isn't there
 * (for example before sign-in). Diagnostics reads GET /admin/diagnostics; the
 * server refuses anyone who isn't an Admin, hiding the item is only for tidiness.
 *
 * Standalone: one <script> line in index_new.html. To remove: delete that line.
 */
(function () {
  "use strict";

  const TOKEN_KEY = "docrag_token";

  const css = `
    .lm-brand { cursor:pointer; border-radius:12px; padding:2px 8px 2px 2px; margin:-2px -8px -2px -2px; }
    .lm-brand:hover, .lm-brand:focus-visible { background:rgba(128,128,128,.14); outline:none; }
    .lm-caret { margin-left:6px; opacity:.55; font-size:11px; }
    .lm-menu { position:fixed; z-index:55; min-width:230px; padding:6px; background:var(--bg-panel, #11151f); color:inherit;
               border:1px solid var(--border, rgba(128,128,128,.3)); border-radius:12px; box-shadow:0 10px 28px rgba(0,0,0,.4); }
    .lm-menu[hidden] { display:none; }
    .lm-item { display:block; width:100%; text-align:left; font:inherit; font-size:13px; color:inherit; background:transparent;
               border:0; border-radius:8px; padding:8px 10px; cursor:pointer; }
    .lm-item:hover, .lm-item:focus-visible { background:rgba(128,128,128,.18); outline:none; }
    .lm-sep { height:1px; margin:6px 4px; background:var(--border, rgba(128,128,128,.25)); }
    .lm-overlay { position:fixed; inset:0; z-index:60; background:rgba(0,0,0,.55); display:flex; align-items:flex-start;
                  justify-content:center; padding:6vh 16px; overflow:auto; }
    .lm-overlay[hidden] { display:none; }
    .lm-box { width:min(560px,100%); background:var(--bg-panel, #11151f); color:inherit; border:1px solid var(--border, rgba(128,128,128,.3));
              border-radius:16px; padding:20px 22px 22px; }
    .lm-top { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:12px; }
    .lm-top h2 { margin:0; font-size:18px; }
    .lm-box h3 { margin:16px 0 4px; font-size:13px; }
    .lm-box p, .lm-box li { font-size:13px; line-height:1.5; opacity:.88; margin:4px 0; }
    .lm-box ul { margin:4px 0; padding-left:18px; }
    .lm-diag { display:grid; grid-template-columns:auto 1fr; gap:5px 16px; font-size:13px; margin:0; }
    .lm-diag dt { opacity:.65; } .lm-diag dd { margin:0; word-break:break-word; }
    .lm-diag-head { grid-column:1 / -1; font-weight:600; margin-top:10px; opacity:.9; }
    .lm-ok { color:#4ade80; } .lm-bad { color:#f87171; }
    .lm-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:14px; }
  `;

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function addStyles() {
    if (document.getElementById("lm-style")) return;
    const s = h("style");
    s.id = "lm-style";
    s.textContent = css;
    document.head.appendChild(s);
  }

  function token() {
    try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; }
  }

  function myRole() {
    const t = token();
    if (!t) return "";
    try {
      return String(JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).role || "");
    } catch (e) { return ""; }
  }

  function say(text, type) {
    if (typeof showToast === "function") showToast(text, { type: type || "default" });
  }

  // ---- generic overlay ------------------------------------------------------
  let overlay, overlayTitle, overlayBody, overlayActions;

  function ensureOverlay() {
    if (overlay) return;
    overlay = h("div", "lm-overlay");
    overlay.hidden = true;
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeOverlay(); });
    const box = h("div", "lm-box");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    const top = h("div", "lm-top");
    overlayTitle = h("h2");
    const close = h("button", "btn btn-ghost", "Close");
    close.type = "button";
    close.addEventListener("click", closeOverlay);
    top.append(overlayTitle, close);
    overlayBody = h("div");
    overlayActions = h("div", "lm-actions");
    box.append(top, overlayBody, overlayActions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !overlay.hidden) closeOverlay();
    });
  }

  function openOverlay(title) {
    ensureOverlay();
    overlayTitle.textContent = title;
    overlay.firstChild.setAttribute("aria-label", title);
    overlayBody.textContent = "";
    overlayActions.textContent = "";
    overlay.hidden = false;
    return overlayBody;
  }

  function closeOverlay() {
    if (overlay) overlay.hidden = true;
  }

  // ---- Privacy & security ---------------------------------------------------
  function showPrivacy() {
    const b = openOverlay("Privacy & security");
    const section = (title, items) => {
      b.appendChild(h("h3", "", title));
      const ul = h("ul");
      items.forEach((t) => ul.appendChild(h("li", "", t)));
      b.appendChild(ul);
    };
    b.appendChild(h("p", "", "This system is built to run on one machine with no internet. Here is what that means in practice."));
    section("Your documents", [
      "Documents are read, split into passages and searched on this machine only.",
      "Answers come from a language model running on this machine. No question, document or answer is sent to an outside service.",
      "The PDF viewer and every script on this page are served locally, not from the internet.",
    ]);
    section("Who can see what", [
      "Every account has a role: Guest, Staff or Admin. Each document has a minimum role.",
      "New uploads start as Admin-only until an Admin lowers the level, so nothing is shared by accident.",
      "The server checks your role on every question, search and PDF request. Hiding something in the page is never the only protection.",
    ]);
    section("Accounts and passwords", [
      "Passwords are stored only as salted hashes, never as text, and are never shown to anyone, Admins included.",
      "Signing in gives a token that expires. Changing your password signs out your other browsers.",
    ]);
    section("The audit log", [
      "Admins can see who signed in, uploaded, deleted, asked a question or changed access, and when.",
      "It records actions, not content: never passwords, tokens or the text of answers. Entries cannot be edited or deleted.",
    ]);
    section("What is not covered yet", [
      "Files on this computer's disk are not encrypted by this app. Use disk encryption (BitLocker or FileVault) if the machine could be lost.",
    ]);
  }

  // ---- Diagnostics (Admin) --------------------------------------------------
  function yesNo(v) { return v === true ? "yes" : v === false ? "no" : "unknown"; }
  function show(v) { return v === null || v === undefined || v === "" ? "unknown" : String(v); }

  function diagnosticsRows(d) {
    const sys = d.system || {}, mod = d.models || {}, oll = d.ollama || {}, sea = d.search || {}, dat = d.data || {};
    return [
      ["Models"],
      ["Language model", show(mod.llm)],
      ["Installed in Ollama", yesNo(mod.llm_installed)],
      ["Embedding model", show(mod.embedding)],
      ["Local LLM server (Ollama)", oll.running ? "running" : "not reachable"],
      ...(!oll.running && oll.error ? [["Why", String(oll.error)]] : []),
      ["Search"],
      ["Relevance cutoff", show(sea.relevance_cutoff)],
      ["Passages per question (default)", show(sea.top_k)],
      ["Data"],
      ["Documents", show(dat.documents)],
      ["Chunks indexed", show(dat.chunks)],
      ["Users", show(dat.users)],
      ["Audit log entries", show(dat.audit_rows)],
      ["Database size", dat.database_kb === null || dat.database_kb === undefined ? "unknown" : dat.database_kb + " KB"],
      ["System"],
      ["Python", show(sys.python)],
      ["OS", show(sys.os)],
    ];
  }

  async function showDiagnostics() {
    const b = openOverlay("Diagnostics");
    b.appendChild(h("p", "", "Loading..."));
    let data = null, problem = "";
    try {
      const base = typeof API_BASE !== "undefined" ? API_BASE : "";
      const res = await fetch(base + "/admin/diagnostics", { headers: { Authorization: "Bearer " + (token() || "") } });
      if (res.ok) data = await res.json();
      else if (res.status === 403) problem = "Only an Admin can see diagnostics.";
      else if (res.status === 401) problem = "Your session has ended. Please sign in again.";
      else problem = "Couldn't load diagnostics (error " + res.status + ").";
    } catch (e) {
      problem = "Couldn't reach the server. Is it running?";
    }
    if (overlay.hidden) return; // closed while loading
    b.textContent = "";
    if (!data) { b.appendChild(h("p", "lm-bad", problem)); return; }

    const rows = diagnosticsRows(data);
    const dl = h("dl", "lm-diag");
    const lines = ["SecureDoc Q&A diagnostics", "Taken: " + new Date().toLocaleString()];
    rows.forEach((r) => {
      if (r.length === 1) {
        dl.appendChild(h("div", "lm-diag-head", r[0]));
        lines.push("", r[0]);
      } else {
        dl.appendChild(h("dt", "", r[0]));
        const dd = h("dd", "", r[1]);
        if (r[1] === "running" || r[1] === "yes") dd.className = "lm-ok";
        if (r[1] === "not reachable" || r[1] === "no") dd.className = "lm-bad";
        dl.appendChild(dd);
        lines.push(r[0] + ": " + r[1]);
      }
    });
    b.appendChild(dl);

    const copy = h("button", "btn", "Copy to clipboard");
    copy.type = "button";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(lines.join("\n"));
        say("Diagnostics copied.", "success");
      } catch (e) {
        say("Couldn't copy. Select the text and copy it by hand.", "error");
      }
    });
    overlayActions.appendChild(copy);
  }

  // ---- the menu -------------------------------------------------------------
  let menu, brand;

  function clickButton(id) {
    const el = document.getElementById(id);
    if (el) el.click();
  }

  function items() {
    const has = (id) => !!document.getElementById(id);
    const list = [];
    if (has("settings-btn")) list.push(["Account settings", () => clickButton("settings-btn")]);
    if (has("new-chat-btn")) list.push(["New conversation", () => clickButton("new-chat-btn")]);
    if (has("shortcuts-btn")) list.push(["Keyboard shortcuts", () => clickButton("shortcuts-btn")]);
    list.push(["sep"]);
    list.push(["Privacy & security", showPrivacy]);
    if (myRole() === "Admin") list.push(["Diagnostics", showDiagnostics]);
    if (has("signout-btn")) {
      list.push(["sep"]);
      list.push(["Sign out", () => clickButton("signout-btn")]);
    }
    return list;
  }

  function closeMenu() {
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    brand.setAttribute("aria-expanded", "false");
  }

  function openMenu() {
    menu.textContent = "";
    items().forEach((it) => {
      if (it[0] === "sep") return menu.appendChild(h("div", "lm-sep"));
      const b = h("button", "lm-item", it[0]);
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.addEventListener("click", () => { closeMenu(); it[1](); });
      menu.appendChild(b);
    });
    const r = brand.getBoundingClientRect();
    menu.style.left = Math.max(8, r.left) + "px";
    menu.style.top = r.bottom + 8 + "px";
    menu.hidden = false;
    brand.setAttribute("aria-expanded", "true");
    const first = menu.querySelector(".lm-item");
    if (first) first.focus();
  }

  function setup() {
    brand = document.querySelector(".brand");
    if (!brand || brand.classList.contains("lm-brand")) return;
    addStyles();
    brand.classList.add("lm-brand");
    brand.setAttribute("role", "button");
    brand.setAttribute("tabindex", "0");
    brand.setAttribute("aria-haspopup", "true");
    brand.setAttribute("aria-expanded", "false");
    brand.setAttribute("title", "Menu");
    const caret = h("span", "lm-caret", "▾");
    caret.setAttribute("aria-hidden", "true");
    brand.appendChild(caret);

    menu = h("div", "lm-menu");
    menu.hidden = true;
    menu.setAttribute("role", "menu");
    document.body.appendChild(menu);

    const toggle = () => (menu.hidden ? openMenu() : closeMenu());
    brand.addEventListener("click", (e) => { e.stopPropagation(); toggle(); });
    brand.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
    });
    document.addEventListener("click", (e) => { if (!menu.contains(e.target)) closeMenu(); });
    window.addEventListener("resize", closeMenu);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !menu.hidden) { closeMenu(); brand.focus(); }
    });
    menu.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const els = Array.from(menu.querySelectorAll(".lm-item"));
      const i = els.indexOf(document.activeElement);
      const n = e.key === "ArrowDown" ? (i + 1) % els.length : (i - 1 + els.length) % els.length;
      els[n].focus();
      e.preventDefault();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setup);
  else setup();
})();
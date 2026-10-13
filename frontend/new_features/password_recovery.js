/* Feature: Password recovery (the screens).
 *
 * Two halves, both in this one file:
 *
 *  1. Sign-in screen: a "Forgot password?" link. It opens a small dialog where
 *     the person (a) tells the administrators they are locked out, and (b)
 *     later types the one-time code they were given, plus a new password.
 *       POST /password/request   and   POST /password/reset
 *
 *  2. Admins: a "Password resets" button next to "Manage users" (with a count of
 *     people waiting). The panel lists who asked, and one click makes a
 *     one-time code, shown once, to pass on in person or by phone.
 *       GET /admin/password-requests   and   POST /admin/users/{name}/reset-code
 *
 * Standalone: builds its own panels and styles. index_new.html needs only the
 * one <script> line. To remove: delete that line.
 * Text is always set with textContent, never innerHTML.
 */
(function () {
  "use strict";

  const TOKEN_KEY = "docrag_token";
  const BASE = typeof API_BASE !== "undefined" ? API_BASE : "";

  const css = `
    .pr-overlay { position:fixed; inset:0; z-index:90; background:rgba(0,0,0,.6);
                  display:flex; align-items:flex-start; justify-content:center; padding:8vh 16px; overflow:auto; }
    .pr-overlay[hidden] { display:none; }
    .pr-box { width:min(520px,100%); background:var(--bg-panel, #11151f); color:inherit;
              border:1px solid var(--border, rgba(128,128,128,.3)); border-radius:16px; padding:20px 22px 22px; }
    .pr-box.pr-wide { width:min(720px,100%); }
    .pr-top { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:6px; }
    .pr-top h2 { margin:0; font-size:18px; }
    .pr-note { font-size:13px; opacity:.75; margin:6px 0 14px; line-height:1.45; }
    .pr-box label { display:block; font-size:13px; margin:12px 0 4px; opacity:.85; }
    .pr-box input[type=text], .pr-box input[type=password] { width:100%; box-sizing:border-box; font:inherit; color:inherit;
          background:transparent; border:1px solid var(--border, rgba(128,128,128,.4)); border-radius:10px; padding:9px 12px; }
    .pr-row { display:flex; gap:8px; flex-wrap:wrap; margin-top:16px; align-items:center; }
    .pr-link { background:none; border:none; padding:0; color:inherit; opacity:.8; text-decoration:underline; cursor:pointer; font:inherit; font-size:13px; }
    .pr-link:hover { opacity:1; }
    .pr-forgot { margin:12px 0 0; text-align:center; }
    .pr-err { color:#f87171; font-size:13px; margin:10px 0 0; }
    .pr-ok  { color:#4ade80; font-size:13px; margin:10px 0 0; line-height:1.45; }
    :root[data-theme="light"] .pr-ok { color:#15803d; }
    .pr-list { border:1px solid var(--border, rgba(128,128,128,.25)); border-radius:12px; overflow:hidden; margin-top:6px; }
    .pr-item { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 12px;
               border-top:1px solid var(--border, rgba(128,128,128,.18)); }
    .pr-item:first-child { border-top:none; }
    .pr-who { min-width:0; }
    .pr-who b { word-break:break-word; }
    .pr-sub { font-size:12px; opacity:.65; }
    .pr-empty { padding:18px 12px; text-align:center; opacity:.7; font-size:13px; }
    .pr-h3 { font-size:14px; margin:18px 0 0; }
    .pr-code { margin:14px 0 4px; padding:16px; text-align:center; border-radius:12px;
               border:1px dashed rgba(245,158,11,.55); background:rgba(245,158,11,.08); }
    .pr-code .pr-big { font-family:ui-monospace,Menlo,Consolas,monospace; font-size:30px; letter-spacing:.14em; font-weight:700; user-select:all; }
    .pr-warn { font-size:12.5px; margin:10px 0 0; padding:8px 10px; border-radius:8px; background:rgba(245,158,11,.12); border:1px solid rgba(245,158,11,.35); }
    .pr-badge { display:inline-block; margin-left:6px; min-width:18px; padding:0 6px; border-radius:999px; font-size:11px; font-weight:700;
                line-height:18px; text-align:center; color:#111; background:#fbbf24; }
  `;

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function button(label, cls, onClick) {
    const b = h("button", cls || "btn btn-ghost", label);
    b.type = "button";
    if (onClick) b.addEventListener("click", onClick);
    return b;
  }
  function field(box, label, type, autocomplete) {
    const l = h("label", "", label);
    const i = h("input");
    i.type = type;
    i.autocomplete = autocomplete || "off";
    i.spellcheck = false;
    box.append(l, i);
    return i;
  }
  function addStyles() {
    if (document.getElementById("pr-style")) return;
    const s = document.createElement("style");
    s.id = "pr-style";
    s.textContent = css;
    document.head.appendChild(s);
  }
  function makeOverlay(wide) {
    const overlay = h("div", "pr-overlay");
    overlay.hidden = true;
    const box = h("div", "pr-box" + (wide ? " pr-wide" : ""));
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    overlay.appendChild(box);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.hidden = true; });
    document.body.appendChild(overlay);
    return { overlay, box };
  }
  function problem(data, status) {
    const d = data && data.detail;
    if (typeof d === "string") return d;
    if (status === 422) return "Please check what you typed (the new password needs at least 8 characters).";
    return "Something went wrong. Please try again.";
  }
  async function call(method, path, body, auth) {
    const headers = { "Content-Type": "application/json" };
    if (auth) {
      let t = "";
      try { t = localStorage.getItem(TOKEN_KEY) || ""; } catch (e) { /* ignore */ }
      headers.Authorization = "Bearer " + t;
    }
    let res;
    try {
      res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch (e) {
      return { ok: false, status: 0, data: { detail: "Can't reach the server. Is the backend running?" } };
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }
    return { ok: res.ok, status: res.status, data };
  }

  /* ------------------------------------------------------------------ */
  /* 1. Sign-in screen: "Forgot password?"                               */
  /* ------------------------------------------------------------------ */
  let fOverlay, fBox;

  function showForgot(mode) {
    if (!fOverlay) {
      const m = makeOverlay(false);
      fOverlay = m.overlay;
      fBox = m.box;
    }
    const prefill = (document.getElementById("auth-username") || {}).value || "";
    fBox.textContent = "";
    const top = h("div", "pr-top");
    top.appendChild(h("h2", "", mode === "code" ? "Use a reset code" : "Forgot password?"));
    top.appendChild(button("Close", "btn btn-ghost", () => { fOverlay.hidden = true; }));
    fBox.appendChild(top);

    if (mode === "request") {
      fBox.appendChild(h("p", "pr-note", "Enter your username. An administrator will be told you need help and will give you a one-time code. Nothing is sent by email: this system runs offline."));
      const user = field(fBox, "Username", "text", "username");
      user.value = prefill;
      const msg = h("p", "");
      msg.hidden = true;
      fBox.appendChild(msg);
      const go = button("Notify an administrator", "btn btn-primary", async () => {
        const name = user.value.trim();
        if (!name) { msg.className = "pr-err"; msg.textContent = "Enter your username."; msg.hidden = false; return; }
        go.disabled = true;
        const r = await call("POST", "/password/request", { username: name }, false);
        go.disabled = false;
        msg.hidden = false;
        if (r.ok) {
          msg.className = "pr-ok";
          msg.textContent = (r.data && r.data.message) || "Done.";
        } else {
          msg.className = "pr-err";
          msg.textContent = problem(r.data, r.status);
        }
      });
      const row = h("div", "pr-row");
      row.append(go, button("I already have a code", "pr-link", () => showForgot("code")));
      fBox.appendChild(row);
      user.addEventListener("keydown", (e) => { if (e.key === "Enter") go.click(); });
      setTimeout(() => user.focus(), 30);
    } else {
      fBox.appendChild(h("p", "pr-note", "Type the code the administrator gave you (it looks like K7QH-2MXR). It works once and expires after 15 minutes."));
      const user = field(fBox, "Username", "text", "username");
      user.value = prefill;
      const code = field(fBox, "Reset code", "text", "off");
      code.placeholder = "XXXX-XXXX";
      const p1 = field(fBox, "New password (8+ characters)", "password", "new-password");
      const p2 = field(fBox, "New password again", "password", "new-password");
      const msg = h("p", "");
      msg.hidden = true;
      fBox.appendChild(msg);
      const go = button("Set new password", "btn btn-primary", async () => {
        msg.hidden = false;
        msg.className = "pr-err";
        if (!user.value.trim() || !code.value.trim()) { msg.textContent = "Enter your username and the code."; return; }
        if (p1.value.length < 8) { msg.textContent = "The new password needs at least 8 characters."; return; }
        if (p1.value !== p2.value) { msg.textContent = "The two passwords don't match."; return; }
        go.disabled = true;
        const r = await call("POST", "/password/reset", { username: user.value.trim(), code: code.value, new_password: p1.value }, false);
        go.disabled = false;
        if (r.ok) {
          msg.className = "pr-ok";
          msg.textContent = "Password changed. You can sign in with the new one now.";
          const au = document.getElementById("auth-username");
          const ap = document.getElementById("auth-password");
          if (au) au.value = user.value.trim();
          if (ap) ap.value = "";
          p1.value = p2.value = code.value = "";
          go.hidden = true;
        } else {
          msg.textContent = problem(r.data, r.status);
        }
      });
      const row = h("div", "pr-row");
      row.append(go, button("I don't have a code", "pr-link", () => showForgot("request")));
      fBox.appendChild(row);
      setTimeout(() => (prefill ? code : user).focus(), 30);
    }
    fOverlay.hidden = false;
  }

  function addForgotLink() {
    const form = document.getElementById("auth-form");
    if (!form || document.getElementById("pr-forgot")) return;
    const p = h("p", "pr-forgot");
    p.id = "pr-forgot";
    p.appendChild(button("Forgot password?", "pr-link", () => showForgot("request")));
    form.appendChild(p);
  }

  /* ------------------------------------------------------------------ */
  /* 2. Admin panel: "Password resets"                                   */
  /* ------------------------------------------------------------------ */
  let aOverlay, aBox, listBox, resultBox, manualInput, onlyAdminNote;
  let me = "";

  function ago(unix) {
    const s = Math.max(0, Math.floor(Date.now() / 1000 - unix));
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + " min ago";
    if (s < 86400) return Math.floor(s / 3600) + " h ago";
    return Math.floor(s / 86400) + " d ago";
  }

  async function copyText(text, btn) {
    const old = btn.textContent;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = "Copied";
    } catch (e) {
      btn.textContent = "Select and copy it";
    }
    setTimeout(() => { btn.textContent = old; }, 1600);
  }

  function showCode(data) {
    resultBox.textContent = "";
    const wrap = h("div", "pr-code");
    wrap.appendChild(h("div", "pr-sub", "One-time code for " + data.username));
    wrap.appendChild(h("div", "pr-big", data.code));
    wrap.appendChild(h("div", "pr-sub", "Valid for " + data.expires_in_minutes + " minutes, works once."));
    resultBox.appendChild(wrap);
    const row = h("div", "pr-row");
    const copy = button("Copy code", "btn btn-ghost");
    copy.addEventListener("click", () => copyText(data.code, copy));
    row.appendChild(copy);
    resultBox.appendChild(row);
    resultBox.appendChild(h("p", "pr-warn", "Give this to " + data.username + " in person or by phone. It is shown only now. Closing this panel hides it for good; you can always make a new one (that cancels this one)."));
  }

  async function issue(name, btn) {
    resultBox.textContent = "";
    if (btn) btn.disabled = true;
    const r = await call("POST", "/admin/users/" + encodeURIComponent(name) + "/reset-code", null, true);
    if (btn) btn.disabled = false;
    if (r.ok) {
      showCode(r.data);
      loadList();
    } else {
      resultBox.appendChild(h("p", "pr-err", problem(r.data, r.status)));
    }
  }

  async function loadList() {
    const r = await call("GET", "/admin/password-requests", null, true);
    listBox.textContent = "";
    if (!r.ok) {
      listBox.appendChild(h("div", "pr-empty", problem(r.data, r.status)));
      return;
    }
    me = r.data.me;
    setBadge(r.data.requests.length);
    if (!r.data.requests.length) {
      listBox.appendChild(h("div", "pr-empty", "Nobody is waiting for a code."));
      return;
    }
    r.data.requests.forEach((q) => {
      const item = h("div", "pr-item");
      const who = h("div", "pr-who");
      const b = h("b", "", q.username);
      who.append(b, h("div", "pr-sub", q.role + " · asked " + ago(q.requested_at)));
      item.appendChild(who);
      if (q.username === me) {
        item.appendChild(h("span", "pr-sub", "Another Admin must reset yours"));
      } else {
        const go = button("Make code", "btn btn-primary");
        go.addEventListener("click", () => issue(q.username, go));
        item.appendChild(go);
      }
      listBox.appendChild(item);
    });
  }

  async function checkOnlyAdmin() {
    onlyAdminNote.hidden = true;
    const r = await call("GET", "/admin/dashboard", null, true);
    if (r.ok && r.data && r.data.users_by_role && r.data.users_by_role.Admin <= 1) {
      onlyAdminNote.hidden = false;
    }
  }

  function ensureAdminPanel() {
    if (aOverlay) return;
    const m = makeOverlay(true);
    aOverlay = m.overlay;
    aBox = m.box;
    const top = h("div", "pr-top");
    top.appendChild(h("h2", "", "Password resets"));
    const acts = h("div", "pr-row");
    acts.style.marginTop = "0";
    acts.append(button("Refresh", "btn btn-ghost", loadList), button("Close", "btn btn-ghost", closeAdmin));
    top.appendChild(acts);
    aBox.appendChild(top);
    aBox.appendChild(h("p", "pr-note", "People who pressed “Forgot password?” appear here. Make a one-time code, then pass it on yourself. Everything you do here is recorded in the Audit log (the code itself never is)."));
    listBox = h("div", "pr-list");
    aBox.appendChild(listBox);
    resultBox = h("div", "");
    aBox.appendChild(resultBox);

    aBox.appendChild(h("h3", "pr-h3", "Reset someone who hasn't asked"));
    manualInput = h("input");
    manualInput.type = "text";
    manualInput.placeholder = "Username";
    manualInput.autocomplete = "off";
    const row = h("div", "pr-row");
    row.style.marginTop = "8px";
    const go = button("Make code", "btn btn-ghost", () => {
      const name = manualInput.value.trim();
      if (name) issue(name, go);
    });
    manualInput.addEventListener("keydown", (e) => { if (e.key === "Enter") go.click(); });
    aBox.appendChild(manualInput);
    row.appendChild(go);
    aBox.appendChild(row);

    onlyAdminNote = h("p", "pr-warn", "You are the only Admin. If you ever forget your own password, nobody can reset it from this screen. Create a second Admin account, or keep access to the server so you can run reset_password.py.");
    onlyAdminNote.hidden = true;
    aBox.appendChild(onlyAdminNote);
  }

  function openAdmin() {
    ensureAdminPanel();
    resultBox.textContent = "";
    manualInput.value = "";
    aOverlay.hidden = false;
    loadList();
    checkOnlyAdmin();
  }
  function closeAdmin() {
    if (!aOverlay) return;
    aOverlay.hidden = true;
    resultBox.textContent = ""; // the code is gone once the panel closes
  }

  function setBadge(n) {
    const b = document.getElementById("pr-btn");
    if (!b) return;
    b.textContent = "Password resets";
    if (n > 0) b.appendChild(h("span", "pr-badge", String(n)));
  }

  function currentToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (e) { return ""; }
  }
  let blockedToken = null; // the login the server refused; don't offer the button again for it

  function addAdminButton() {
    const admin = document.getElementById("admin-btn");
    if (!admin || document.getElementById("pr-btn")) return;
    if (blockedToken !== null && blockedToken === currentToken()) return;
    const b = button("Password resets", "btn btn-ghost", openAdmin);
    b.id = "pr-btn";
    admin.insertAdjacentElement("beforebegin", b);
    if (!pollTimer) pollTimer = setInterval(() => { if (!document.hidden) refreshBadge(); }, 60000);
    refreshBadge();
  }

  let pollTimer = null;
  async function refreshBadge() {
    const btn = document.getElementById("pr-btn");
    if (!btn) return;
    const r = await call("GET", "/admin/password-requests", null, true);
    if (r.ok) { setBadge(r.data.requests.length); return; }
    if (r.status === 401 || r.status === 403) {
      // this tab is no longer signed in as an Admin (for instance someone else signed in
      // in another tab): stop asking, so the audit log isn't filled with refusals
      blockedToken = currentToken();
      btn.remove();
      if (aOverlay) aOverlay.hidden = true;
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function start() {
    addStyles();
    addForgotLink();
    addAdminButton();
    const area = document.getElementById("account-area");
    if (area) new MutationObserver(addAdminButton).observe(area, { childList: true, subtree: true });
    pollTimer = setInterval(() => { if (!document.hidden) refreshBadge(); }, 60000);
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (fOverlay && !fOverlay.hidden) fOverlay.hidden = true;
      if (aOverlay && !aOverlay.hidden) closeAdmin();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
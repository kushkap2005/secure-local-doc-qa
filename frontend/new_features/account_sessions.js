/* Account settings extras: "Recent sign-ins" and "Sign out everywhere".
 *
 * Adds two sections at the bottom of the Account settings panel
 * (account_settings.js builds the panel; this file only adds to it).
 *
 *   Recent sign-ins     your last sign-ins and failed attempts: time, result,
 *                       address. It warns when someone tried your password since
 *                       your previous sign-in. Data: GET /account/sign-ins
 *   Sign out everywhere ends every sign-in of your account, this browser too,
 *                       after one confirm click. Data: POST /account/signout-all
 *
 * Both only ever concern the signed-in person's own account. Text is set with
 * textContent only.
 *
 * Standalone: one <script> line in index_new.html, after account_settings.js.
 * To remove: delete that line.
 */
(function () {
  "use strict";

  const TOKEN_KEY = "docrag_token";

  const css = `
    .asx-list { list-style:none; margin:6px 0 0; padding:0; font-size:13px; }
    .asx-list li { display:flex; gap:10px; align-items:baseline; padding:4px 0; border-bottom:1px solid var(--border, rgba(128,128,128,.18)); }
    .asx-list li:last-child { border-bottom:0; }
    .asx-when { flex:1; }
    .asx-ip { opacity:.6; font-size:12px; }
    .asx-ok { color:#4ade80; } .asx-bad { color:#f87171; }
    .asx-warn { font-size:13px; padding:8px 10px; border-radius:8px; margin:8px 0 0; color:#fbbf24;
                background:rgba(245,158,11,.12); border:1px solid rgba(245,158,11,.4); }
    .asx-note { font-size:12px; opacity:.65; margin:6px 0; }
    .asx-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:8px; }
  `;

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function token() {
    try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; }
  }

  function base() {
    return typeof API_BASE !== "undefined" ? API_BASE : "";
  }

  let box = null, listBox, warnBox, askRow, startBtn, msg;

  function build(panel) {
    if (!document.getElementById("asx-style")) {
      const s = h("style");
      s.id = "asx-style";
      s.textContent = css;
      document.head.appendChild(s);
    }
    box = h("div", "asx");

    box.appendChild(h("h3", "", "Recent sign-ins"));
    warnBox = h("p", "asx-warn");
    warnBox.hidden = true;
    listBox = h("div");
    box.append(warnBox, listBox);
    box.appendChild(h("p", "asx-note", "Taken from the audit log. If you see a sign-in you don't recognise, change your password."));

    box.appendChild(h("h3", "", "Sign out everywhere"));
    box.appendChild(h("p", "asx-note", "Ends every sign-in of this account, in every browser and on every device, including this one. You will need to sign in again."));
    const row = h("div", "asx-row");
    startBtn = h("button", "btn btn-ghost", "Sign out everywhere");
    startBtn.type = "button";
    askRow = h("span", "asx-row");
    askRow.hidden = true;
    askRow.style.margin = "0";
    const yes = h("button", "btn", "Yes, sign out everywhere");
    yes.type = "button";
    const no = h("button", "btn btn-ghost", "Cancel");
    no.type = "button";
    askRow.append(yes, no);
    row.append(startBtn, askRow);
    msg = h("p", "asx-note");
    msg.hidden = true;
    box.append(row, msg);

    startBtn.addEventListener("click", () => { startBtn.hidden = true; askRow.hidden = false; yes.focus(); });
    no.addEventListener("click", reset);
    yes.addEventListener("click", () => signOutEverywhere(yes));
    panel.appendChild(box);
  }

  function reset() {
    if (!box) return;
    askRow.hidden = true;
    startBtn.hidden = false;
    msg.hidden = true;
  }

  async function signOutEverywhere(btn) {
    btn.disabled = true;
    try {
      const res = await fetch(base() + "/account/signout-all", { method: "POST", headers: { Authorization: "Bearer " + (token() || "") } });
      if (res.ok || res.status === 401) {
        // 401 means the session was already gone, which is the same end state
        try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* storage blocked */ }
        location.reload();
        return;
      }
      msg.textContent = "Couldn't sign out everywhere (error " + res.status + ").";
    } catch (e) {
      msg.textContent = "Couldn't reach the server. Is it running?";
    }
    msg.hidden = false;
    btn.disabled = false;
  }

  function when(iso) {
    const d = new Date(iso);
    return isNaN(d) ? String(iso) : d.toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  }

  async function load() {
    listBox.textContent = "";
    warnBox.hidden = true;
    let data = null;
    try {
      const res = await fetch(base() + "/account/sign-ins?limit=8", { headers: { Authorization: "Bearer " + (token() || "") } });
      if (res.ok) data = await res.json();
    } catch (e) { /* offline */ }
    if (!data) { listBox.appendChild(h("p", "asx-note", "Couldn't load your recent sign-ins.")); return; }

    const n = data.failed_since_previous_login || 0;
    if (n > 0) {
      warnBox.textContent = n + " failed sign-in attempt" + (n === 1 ? "" : "s") + " on your account since your previous sign-in.";
      warnBox.hidden = false;
    }
    if (!data.sign_ins || !data.sign_ins.length) {
      listBox.appendChild(h("p", "asx-note", "Nothing recorded yet."));
      return;
    }
    const ul = h("ul", "asx-list");
    data.sign_ins.forEach((s) => {
      const li = h("li");
      li.appendChild(h("span", "asx-when", when(s.time)));
      li.appendChild(h("span", s.ok ? "asx-ok" : "asx-bad", s.ok ? "Signed in" : "Failed attempt"));
      if (s.ip) li.appendChild(h("span", "asx-ip", s.ip));
      ul.appendChild(li);
    });
    listBox.appendChild(ul);
  }

  // The panel is built once by account_settings.js on first open; (re)fill it each time it opens.
  document.addEventListener("click", (e) => {
    if (!e.target.closest || !e.target.closest("#settings-btn")) return;
    setTimeout(() => {
      const panel = document.querySelector(".as");
      if (!panel) return;
      if (!box || !panel.contains(box)) build(panel);
      reset();
      load();
    }, 0);
  });
})();
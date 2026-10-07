/* Feature 19: Account settings.
 *
 * Adds a "Settings" button next to the sign-out icon (every signed-in role).
 * It opens a panel that shows who you are signed in as, when this sign-in
 * runs out, and a form to change your own password.
 * Data goes to POST /account/password. The server checks the current password,
 * saves the new one, signs out every OTHER session of this account, and sends
 * back a fresh token so this browser stays signed in.
 *
 * Standalone: it builds its own panel and styles, so index_new.html only needs
 * the one <script> line. To remove: delete that line.
 */
(function () {
  "use strict";

  const TOKEN_KEY = "docrag_token"; // same key app.js uses
  const MIN_LEN = 8;
  const MAX_BYTES = 72; // bcrypt limit, same as the server

  const css = `
    .as-overlay { position:fixed; inset:0; z-index:60; background:rgba(0,0,0,.55);
                  display:flex; align-items:flex-start; justify-content:center; padding:6vh 16px; overflow:auto; }
    .as-overlay[hidden] { display:none; }
    .as { width:min(480px,100%); background:var(--bg-panel, #11151f); color:inherit;
          border:1px solid var(--border, rgba(128,128,128,.3)); border-radius:16px; padding:20px 22px 22px; }
    .as-top { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:14px; }
    .as-top h2 { margin:0; font-size:18px; }
    .as h3 { margin:18px 0 8px; font-size:13px; opacity:.85; }
    .as-rows { display:grid; grid-template-columns:auto 1fr; gap:6px 14px; font-size:13px; }
    .as-rows dt { opacity:.65; }
    .as-rows dd { margin:0; word-break:break-word; }
    .as-badge { display:inline-block; padding:1px 8px; border-radius:999px; font-size:11px; font-weight:600; border:1px solid transparent; }
    .as-badge-guest { color:#4ade80; background:rgba(34,197,94,.14);  border-color:rgba(34,197,94,.35); }
    .as-badge-staff { color:#93c5fd; background:rgba(59,130,246,.14); border-color:rgba(59,130,246,.35); }
    .as-badge-admin { color:#fbbf24; background:rgba(245,158,11,.16); border-color:rgba(245,158,11,.40); }
    .as form { display:flex; flex-direction:column; gap:10px; }
    .as label { font-size:12px; opacity:.75; display:flex; flex-direction:column; gap:4px; }
    .as input[type="password"], .as input[type="text"] { font:inherit; font-size:14px; color:inherit; background:transparent;
          border:1px solid var(--border, rgba(128,128,128,.35)); border-radius:8px; padding:8px 10px; }
    .as-show { flex-direction:row !important; align-items:center; gap:8px !important; font-size:12px; opacity:.8; cursor:pointer; }
    .as-note { font-size:12px; opacity:.65; margin:2px 0 0; }
    .as-msg { font-size:13px; padding:8px 10px; border-radius:8px; margin:0; }
    .as-msg[hidden] { display:none; }
    .as-msg-bad { color:#f87171; background:rgba(248,113,113,.12); border:1px solid rgba(248,113,113,.35); }
    .as-msg-ok  { color:#4ade80; background:rgba(34,197,94,.12);  border:1px solid rgba(34,197,94,.35); }
    .as-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:4px; }
  `;

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text; // text only, never innerHTML
    return e;
  }

  function addStyles() {
    if (document.getElementById("as-style")) return;
    const s = document.createElement("style");
    s.id = "as-style";
    s.textContent = css;
    document.head.appendChild(s);
  }

  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; }
  }

  /** Reads the (unsigned-checked-by-server) payload of our own token, for display only. */
  function readToken() {
    const t = getToken();
    if (!t) return null;
    try {
      const part = t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      const json = decodeURIComponent(
        atob(part).split("").map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join("")
      );
      return JSON.parse(json);
    } catch (e) {
      return null;
    }
  }

  let overlay, rows, form, curInp, newInp, repInp, showBox, msg, submitBtn;
  let busy = false;

  function setMsg(text, ok) {
    msg.hidden = !text;
    msg.textContent = text || "";
    msg.className = "as-msg " + (ok ? "as-msg-ok" : "as-msg-bad");
  }

  function fillAccountInfo() {
    rows.textContent = "";
    const p = readToken();
    const add = (label, node) => {
      rows.appendChild(h("dt", "", label));
      const dd = h("dd");
      dd.appendChild(typeof node === "string" ? document.createTextNode(node) : node);
      rows.appendChild(dd);
    };
    if (!p) {
      add("Status", "Not signed in.");
      return;
    }
    add("Username", String(p.sub || ""));
    const role = String(p.role || "");
    add("Role", h("span", "as-badge as-badge-" + role.toLowerCase(), role));
    if (p.exp) {
      const when = new Date(p.exp * 1000);
      const mins = Math.max(0, Math.round((when.getTime() - Date.now()) / 60000));
      add("Sign-in ends", when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) + " (in about " + mins + " min)");
    }
  }

  function ensureOverlay() {
    if (overlay) return;
    overlay = h("div", "as-overlay");
    overlay.hidden = true;
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

    const box = h("div", "as");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", "Account settings");

    const top = h("div", "as-top");
    top.appendChild(h("h2", "", "Account settings"));
    const closeBtn = h("button", "btn btn-ghost", "Close");
    closeBtn.type = "button";
    closeBtn.addEventListener("click", close);
    top.appendChild(closeBtn);

    rows = h("dl", "as-rows");

    form = h("form");
    form.noValidate = true;
    const field = (labelText, auto) => {
      const l = h("label", "", labelText);
      const i = h("input");
      i.type = "password";
      i.autocomplete = auto;
      l.appendChild(i);
      form.appendChild(l);
      return i;
    };
    curInp = field("Current password", "current-password");
    newInp = field("New password (at least " + MIN_LEN + " characters)", "new-password");
    repInp = field("Type the new password again", "new-password");

    const showLabel = h("label", "as-show");
    showBox = h("input");
    showBox.type = "checkbox";
    showBox.addEventListener("change", () => {
      const t = showBox.checked ? "text" : "password";
      curInp.type = newInp.type = repInp.type = t;
    });
    showLabel.append(showBox, document.createTextNode("Show passwords"));
    form.appendChild(showLabel);

    form.appendChild(h("p", "as-note", "Changing your password signs out every other browser or device using this account. This one stays signed in."));

    msg = h("p", "as-msg");
    msg.hidden = true;
    msg.setAttribute("role", "status");
    form.appendChild(msg);

    const actions = h("div", "as-actions");
    submitBtn = h("button", "btn", "Change password");
    submitBtn.type = "submit";
    actions.appendChild(submitBtn);
    form.appendChild(actions);
    form.addEventListener("submit", onSubmit);

    box.append(top, rows, h("h3", "", "Change password"), form);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !overlay.hidden) close();
    });
  }

  function open() {
    ensureOverlay();
    fillAccountInfo();
    setMsg("");
    overlay.hidden = false;
    curInp.focus();
  }

  function close() {
    if (!overlay) return;
    overlay.hidden = true;
    form.reset(); // never leave typed passwords sitting in a hidden form
    showBox.checked = false;
    curInp.type = newInp.type = repInp.type = "password";
    setMsg("");
  }

  function byteLength(s) {
    return new TextEncoder().encode(s).length;
  }

  function problem(cur, nw, rep) {
    if (!cur) return "Enter your current password.";
    if (nw.length < MIN_LEN) return "The new password needs at least " + MIN_LEN + " characters.";
    if (byteLength(nw) > MAX_BYTES) return "The new password is too long (72 bytes at most).";
    if (nw === cur) return "The new password must be different from the current one.";
    if (nw !== rep) return "The two new passwords don't match.";
    return "";
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (busy) return;
    const cur = curInp.value, nw = newInp.value, rep = repInp.value;
    const bad = problem(cur, nw, rep);
    if (bad) return setMsg(bad, false);

    const token = getToken();
    if (!token) return setMsg("You are not signed in. Please sign in again.", false);

    busy = true;
    submitBtn.disabled = true;
    setMsg("");
    try {
      const base = typeof API_BASE !== "undefined" ? API_BASE : "";
      const res = await fetch(base + "/account/password", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ current_password: cur, new_password: nw }),
      });
      let data = {};
      try { data = await res.json(); } catch (err) { /* no body */ }

      if (res.ok && data.access_token) {
        // Keep this browser signed in with the new token (the old one was just retired).
        try { localStorage.setItem(TOKEN_KEY, data.access_token); } catch (err) { /* storage blocked */ }
        if (typeof Api !== "undefined" && Api && typeof Api.setToken === "function") Api.setToken(data.access_token);
        form.reset();
        fillAccountInfo();
        setMsg("Password changed. Other devices have been signed out.", true);
      } else if (res.status === 401) {
        setMsg("Your session has ended. Please sign in again.", false);
      } else if (res.status === 429 || res.status === 400) {
        setMsg(typeof data.detail === "string" ? data.detail : "That didn't work. Check the passwords and try again.", false);
      } else if (res.status === 422) {
        setMsg("The new password was not accepted. Use at least " + MIN_LEN + " characters.", false);
      } else {
        setMsg("Couldn't change the password (error " + res.status + ").", false);
      }
    } catch (err) {
      setMsg("Couldn't reach the server. Is it running?", false);
    } finally {
      busy = false;
      submitBtn.disabled = false;
    }
  }

  // ---- put the button next to the sign-out icon ---------------------------
  function addButton() {
    const out = document.getElementById("signout-btn");
    if (!out || document.getElementById("settings-btn")) return;
    const b = h("button", "btn btn-ghost", "Settings");
    b.id = "settings-btn";
    b.type = "button";
    b.addEventListener("click", open);
    out.insertAdjacentElement("beforebegin", b);
  }

  function start() {
    addStyles();
    addButton();
    const area = document.getElementById("account-area");
    if (area) {
      new MutationObserver(() => {
        addButton();
        // signed out (or the session ended) while the panel was open: close it
        if (!document.getElementById("signout-btn") && overlay && !overlay.hidden) close();
      }).observe(area, { childList: true, subtree: true });
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
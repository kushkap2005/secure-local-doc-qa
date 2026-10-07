/* Feature 4: saved chat history (browser side).
 *
 * app.js already knows how to list, open, create and delete saved
 * conversations (it just had its switch turned off). What it does not do any
 * more is SAVE each answer, because the RBAC server's /ask no longer saves
 * anything. This file fills that gap: it wraps Api.ask(), and after every
 * successful answer it sends the question, answer and source list to
 * POST /conversations/{id}/messages.
 *
 * (A second block at the bottom adds the "Chat history" heading, a find-by-name
 * box and a rename button to the chat list.)
 *
 * Needs: SYNC_CONVERSATIONS = true in app.js, and chat_history.py on the server.
 * To remove: delete the <script> line and set SYNC_CONVERSATIONS back to false.
 */
(function () {
  "use strict";

  if (typeof Api === "undefined" || typeof request !== "function") {
    console.warn("chat_history.js: load it after api.js and app.js");
    return;
  }

  const originalAsk = Api.ask.bind(Api);
  let warned = false;

  Api.ask = async function (question, topK, conversationId) {
    const res = await originalAsk(question, topK, conversationId);

    // Only saved chats (signed in, id from the server) and only real answers.
    if (conversationId && res && res.ok && res.data && typeof res.data.answer === "string") {
      try {
        const sources = (res.data.sources || []).map((s) => ({
          file: s.file,
          page: s.page,
          relevance: s.relevance,
          // the passage text is deliberately not sent (see chat_history.py)
        }));
        const saved = await request(`/conversations/${encodeURIComponent(conversationId)}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question, answer: res.data.answer, sources }),
        });
        if (!saved.ok && !warned) {
          warned = true;
          console.warn("chat_history.js: could not save this answer:", saved.message);
          if (typeof showToast === "function") {
            showToast("This answer couldn't be saved to your history.", { type: "error" });
          }
        }
      } catch (err) {
        console.warn("chat_history.js:", err);
      }
    }
    return res;
  };
})();


/* ---------------------------------------------------------------------- *
 * Chat history panel: a "Chat history" heading, a "find a chat by name" box,
 * and a rename (pencil) button on every chat. Everything is added from here
 * by watching the chat list, so index.html and app.js stay as they were.
 * ---------------------------------------------------------------------- */
(function () {
  "use strict";

  const panel = document.getElementById("conversation-panel");
  const list = document.getElementById("conversation-list");
  if (!panel || !list) return;

  const NAME_MAX = 100;

  const css = `
    .hist-head { display:flex; align-items:center; justify-content:space-between; margin:8px 2px 6px; }
    .hist-head h3 { margin:0; font-size:13px; font-weight:700; }
    .hist-find { width:100%; box-sizing:border-box; margin:0 0 6px; padding:6px 10px; border-radius:8px;
                 border:1px solid var(--border, rgba(128,128,128,.35)); background:transparent; color:inherit; font:inherit; font-size:13px; }
    .hist-none { padding:10px 4px; font-size:13px; opacity:.7; }
    .conv-item-rename { background:none; border:0; padding:4px; cursor:pointer; color:inherit; opacity:.55; border-radius:6px; }
    .conv-item-rename:hover { opacity:1; }
    .conv-item-edit { flex:1; min-width:0; margin:2px 4px; padding:5px 8px; font:inherit; font-size:13px; color:inherit;
                      background:transparent; border-radius:8px; border:1.5px solid var(--accent, #6366f1); }
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  // ---- 1. heading + find box (added once) ---------------------------------
  const head = document.createElement("div");
  head.className = "hist-head";
  const h = document.createElement("h3");
  h.textContent = "Chat history";
  head.appendChild(h);

  const find = document.createElement("input");
  find.type = "search";
  find.className = "hist-find";
  find.placeholder = "Find a chat by name…";
  find.setAttribute("aria-label", "Find a chat by name");
  find.addEventListener("input", applyFilter);
  // typing in here must not trigger app.js keyboard shortcuts
  find.addEventListener("keydown", (e) => e.stopPropagation());

  const none = document.createElement("div");
  none.className = "hist-none";
  none.textContent = "No chats match that name.";
  none.hidden = true;

  list.insertAdjacentElement("beforebegin", head);
  list.insertAdjacentElement("beforebegin", find);
  list.insertAdjacentElement("afterend", none);

  // relabel the toolbar button's tooltip
  const switcher = document.getElementById("conversation-switcher");
  if (switcher) switcher.title = "Chat history";

  function applyFilter() {
    const q = find.value.trim().toLowerCase();
    let shown = 0;
    list.querySelectorAll(".conv-item").forEach((li) => {
      const t = (li.querySelector(".conv-item-title") || {}).textContent || "";
      const match = !q || t.toLowerCase().includes(q);
      li.hidden = !match;
      if (match) shown++;
    });
    none.hidden = shown > 0 || !q;
  }

  // ---- 2. rename --------------------------------------------------------
  function findConv(id) {
    return state.conversations.find((c) => c.id === id);
  }

  async function saveName(id, name) {
    const conv = findConv(id);
    if (!conv) {
      renderConversationList();
      return;
    }
    name = name.replace(/\s+/g, " ").trim();
    if (!name || name === conv.title) {
      renderConversationList(); // nothing to save: just close the edit box
      return;
    }

    if (conv.remote) {
      const res = await request(`/conversations/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: name }),
      });
      if (!res.ok) {
        if (typeof showToast === "function") showToast(res.message || "Couldn't rename this chat.", { type: "error" });
        renderConversationList(); // close the edit box, keep the old name
        return;
      }
      name = res.data.title; // the server's tidied version
    }
    conv.title = name;
    if (state.activeConversationId === id && el.activeConversationTitle) {
      el.activeConversationTitle.textContent = name;
    }
    renderConversationList(); // app.js redraws the list; the observer re-adds our buttons
  }

  function startRename(li) {
    const select = li.querySelector(".conv-item-select");
    if (!select || li.querySelector(".conv-item-edit")) return;
    const id = select.dataset.id;
    const conv = findConv(id);
    if (!conv) return;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "conv-item-edit";
    input.value = conv.title;
    input.maxLength = NAME_MAX;
    input.setAttribute("aria-label", "Chat name");

    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      if (save) saveName(id, input.value);
      else renderConversationList();
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation(); // keep app.js shortcuts out of the way
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("click", (e) => e.stopPropagation());

    select.hidden = true;
    li.querySelectorAll(".conv-item-rename").forEach((b) => (b.hidden = true));
    select.insertAdjacentElement("beforebegin", input);
    input.focus();
    input.select();
  }

  // ---- 3. keep our additions on every redraw of the list ---------------------
  function decorate() {
    list.querySelectorAll(".conv-item").forEach((li) => {
      if (li.dataset.renameReady) return;
      const del = li.querySelector(".conv-item-delete");
      if (!del) return;
      li.dataset.renameReady = "1";
      const b = document.createElement("button");
      b.type = "button";
      b.className = "conv-item-rename";
      b.title = "Rename chat";
      b.setAttribute("aria-label", "Rename chat");
      b.innerHTML =
        '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true"><path d="M5 19l1-4L16.5 4.5a2 2 0 0 1 3 3L9 18l-4 1Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        startRename(li);
      });
      del.insertAdjacentElement("beforebegin", b);
    });
    applyFilter();
  }

  new MutationObserver(decorate).observe(list, { childList: true });
  decorate();
})();
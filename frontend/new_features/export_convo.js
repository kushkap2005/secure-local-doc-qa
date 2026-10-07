/* Feature 18: Export a conversation.
 *
 * Adds an "Export" icon to the chat toolbar (next to "New conversation").
 * It saves the conversation you are looking at to a file on this computer,
 * as Markdown (.md) or plain text (.txt): every question, every answer, and
 * under each answer the sources it cited (file, page, relevance).
 *
 * Everything happens in the browser from the conversation already on screen.
 * Nothing is sent to the server, and the file is only created when you click.
 * Source PASSAGE text is never included, the same rule saved chat history
 * follows, so an export can't carry text from a document you may no longer see.
 *
 * Standalone: it only needs the one <script> line in index_new.html, placed
 * after app.js. To remove: delete that line.
 */
(function () {
  "use strict";

  const css = `
    .ec-wrap { position:relative; display:inline-flex; }
    .ec-menu { position:absolute; right:0; top:calc(100% + 6px); z-index:50; min-width:210px; padding:6px;
               background:var(--bg-panel, #11151f); color:inherit;
               border:1px solid var(--border, rgba(128,128,128,.3)); border-radius:12px;
               box-shadow:0 8px 24px rgba(0,0,0,.35); }
    .ec-menu[hidden] { display:none; }
    .ec-menu p { margin:2px 8px 6px; font-size:11px; opacity:.65; }
    .ec-item { display:block; width:100%; text-align:left; font:inherit; font-size:13px; color:inherit; background:transparent;
               border:0; border-radius:8px; padding:8px 10px; cursor:pointer; }
    .ec-item:hover, .ec-item:focus-visible { background:rgba(128,128,128,.18); outline:none; }
    .ec-item small { display:block; opacity:.6; font-size:11px; }
  `;

  function addStyles() {
    if (document.getElementById("ec-style")) return;
    const s = document.createElement("style");
    s.id = "ec-style";
    s.textContent = css;
    document.head.appendChild(s);
  }

  function say(text, type) {
    if (typeof showToast === "function") showToast(text, { type: type || "default" });
  }

  function activeConversation() {
    try {
      return typeof getActiveConversation === "function" ? getActiveConversation() : null;
    } catch (e) {
      return null;
    }
  }

  function who() {
    try {
      return typeof state !== "undefined" && state && state.username ? state.username : "";
    } catch (e) {
      return "";
    }
  }

  function when(iso) {
    const d = iso ? new Date(iso) : null;
    return d && !isNaN(d) ? d.toLocaleString() : "";
  }

  function sourceLine(s) {
    const rel = typeof s.relevance === "number" ? ", relevance " + s.relevance : "";
    return String(s.file) + ", page " + s.page + rel;
  }

  /** The conversation as a list of exchanges: [{question, qTime, answer, aTime, sources, isError}] */
  function exchanges(conv) {
    const out = [];
    let pending = null;
    for (const m of conv.messages || []) {
      if (m.role === "user") {
        if (pending) out.push(pending); // a question that never got an answer
        pending = { question: m.text, qTime: m.time, answer: null, aTime: "", sources: [], isError: false };
      } else if (m.role === "assistant") {
        const e = pending || { question: m.question || "", qTime: "", answer: null, aTime: "", sources: [], isError: false };
        e.answer = m.answer;
        e.aTime = m.time;
        e.sources = Array.isArray(m.sources) ? m.sources : [];
        e.isError = !!m.isError;
        out.push(e);
        pending = null;
      }
    }
    if (pending) out.push(pending);
    return out;
  }

  const NO_ANSWER = "(No answer was saved for this question.)";
  const ERR_ANSWER = "(This question failed with an error, so there is no answer.)";

  function buildMarkdown(conv, list) {
    const user = who();
    const lines = ["# " + (conv.title || "Conversation"), ""];
    lines.push("- Exported: " + new Date().toLocaleString());
    if (user) lines.push("- Exported by: " + user);
    lines.push("- Questions: " + list.length);
    lines.push("- Source passages are not included, only file, page and relevance.");
    lines.push("");
    list.forEach((e, i) => {
      lines.push("---", "", "## Question " + (i + 1) + (e.qTime ? "  (" + when(e.qTime) + ")" : ""), "");
      lines.push(String(e.question || "").split("\n").map((l) => "> " + l).join("\n"), "");
      lines.push("### Answer", "");
      lines.push(e.isError ? ERR_ANSWER : e.answer == null ? NO_ANSWER : String(e.answer), "");
      if (!e.isError && e.sources.length) {
        lines.push("**Sources**", "");
        e.sources.forEach((s) => lines.push("- " + sourceLine(s)));
        lines.push("");
      }
    });
    return lines.join("\n");
  }

  function buildText(conv, list) {
    const user = who();
    const lines = [conv.title || "Conversation", "=".repeat(Math.min(60, (conv.title || "Conversation").length)), ""];
    lines.push("Exported: " + new Date().toLocaleString());
    if (user) lines.push("Exported by: " + user);
    lines.push("Questions: " + list.length);
    lines.push("Source passages are not included, only file, page and relevance.", "");
    list.forEach((e, i) => {
      lines.push("-".repeat(60), "Question " + (i + 1) + (e.qTime ? " (" + when(e.qTime) + ")" : ""), "");
      lines.push(String(e.question || ""), "");
      lines.push("Answer:");
      lines.push(e.isError ? ERR_ANSWER : e.answer == null ? NO_ANSWER : String(e.answer), "");
      if (!e.isError && e.sources.length) {
        lines.push("Sources:");
        e.sources.forEach((s) => lines.push("  - " + sourceLine(s)));
        lines.push("");
      }
    });
    return lines.join("\n");
  }

  function fileName(title, ext) {
    const slug = String(title || "conversation")
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "") // drops quotes, slashes, accents' marks, anything a file name can't hold
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 50) || "conversation";
    const d = new Date();
    const stamp = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    return slug + "-" + stamp + "." + ext;
  }

  function download(name, text, mime) {
    // "\uFEFF" (a byte-order mark) makes Windows Notepad read the file as UTF-8
    const blob = new Blob(["\uFEFF", text], { type: mime + ";charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportAs(kind) {
    const conv = activeConversation();
    const list = conv ? exchanges(conv) : [];
    if (!conv || list.length === 0) {
      say("There is nothing to export yet. Ask a question first.", "error");
      return;
    }
    if (kind === "md") download(fileName(conv.title, "md"), buildMarkdown(conv, list), "text/markdown");
    else download(fileName(conv.title, "txt"), buildText(conv, list), "text/plain");
    say("Conversation exported.", "success");
  }

  // ---- the toolbar button and its small menu ---------------------------------
  let menu, button;

  function closeMenu() {
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
  }

  function addButton() {
    const bar = document.querySelector(".chat-toolbar-actions");
    if (!bar || document.getElementById("export-btn")) return;
    addStyles();

    const wrap = document.createElement("span");
    wrap.className = "ec-wrap";

    button = document.createElement("button");
    button.type = "button";
    button.className = "icon-btn";
    button.id = "export-btn";
    button.title = "Export this conversation";
    button.setAttribute("aria-label", "Export this conversation");
    button.setAttribute("aria-haspopup", "true");
    button.setAttribute("aria-expanded", "false");
    button.innerHTML =
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true">' +
      '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M5 19h14" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';

    menu = document.createElement("div");
    menu.className = "ec-menu";
    menu.hidden = true;
    menu.setAttribute("role", "menu");
    const note = document.createElement("p");
    note.textContent = "Save this conversation as a file";
    menu.appendChild(note);
    [
      ["md", "Markdown (.md)", "Headings and lists, opens in any editor"],
      ["txt", "Plain text (.txt)", "Opens anywhere, no formatting"],
    ].forEach(([kind, label, hint]) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "ec-item";
      item.setAttribute("role", "menuitem");
      item.textContent = label;
      const small = document.createElement("small");
      small.textContent = hint;
      item.appendChild(small);
      item.addEventListener("click", () => {
        closeMenu();
        exportAs(kind);
      });
      menu.appendChild(item);
    });

    button.addEventListener("click", (e) => {
      e.stopPropagation();
      const opening = menu.hidden;
      menu.hidden = !opening;
      button.setAttribute("aria-expanded", String(opening));
      if (opening) menu.querySelector(".ec-item").focus();
    });
    document.addEventListener("click", (e) => { if (!wrap.contains(e.target)) closeMenu(); });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !menu.hidden) { closeMenu(); button.focus(); }
    });

    wrap.append(button, menu);
    bar.insertBefore(wrap, bar.firstChild);
  }

  function start() {
    addButton();
    const bar = document.querySelector(".chat-toolbar");
    if (bar) new MutationObserver(addButton).observe(bar, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();

  window.__ecBuild = { buildMarkdown, buildText, exchanges, fileName }; // for tests
})();
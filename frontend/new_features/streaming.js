/* Feature 1: streaming answers (browser side).
 *
 * Instead of waiting for the whole answer, the page shows the words as the
 * model writes them. It works by replacing Api.ask(): the new version asks
 * the server's POST /ask/stream, writes each piece into the waiting answer
 * bubble as it arrives, and when the stream ends hands app.js the SAME result
 * shape the old Api.ask() returned ({ ok, data: { answer, sources } }). So
 * app.js draws the final answer, sources, copy button and so on exactly as
 * before. It never needs to know the answer was streamed.
 *
 * If the server has no /ask/stream (404/405), it quietly falls back to the
 * normal Api.ask() so the page keeps working.
 *
 * ORDER MATTERS: load this file BEFORE chat_history.js in index.html, so
 * that saving to chat history sees the finished (streamed) answer.
 *
 * To remove: delete the <script> line.
 */
(function () {
  "use strict";

  if (typeof Api === "undefined" || typeof API_BASE === "undefined") {
    console.warn("streaming.js: load it after api.js");
    return;
  }

  const css = `
    .stream-cursor { display:inline-block; width:7px; height:1.05em; margin-left:2px; vertical-align:text-bottom;
                     background:currentColor; opacity:.7; animation:stream-blink 1s steps(2,start) infinite; }
    @keyframes stream-blink { to { visibility:hidden; } }
    @media (prefers-reduced-motion: reduce) { .stream-cursor { animation:none; } }
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  const previousAsk = Api.ask.bind(Api);

  function chatBox() {
    return typeof el !== "undefined" && el.chat ? el.chat : document.getElementById("chat");
  }

  /** The answer bubble app.js just added (it still shows the "thinking" dots). */
  function liveBubble() {
    const box = chatBox();
    if (!box) return null;
    const rows = box.querySelectorAll(".msg-row-assistant");
    const last = rows[rows.length - 1];
    return last ? last.querySelector(".msg-bubble") : null;
  }

  function makeWriter() {
    const bubble = liveBubble();
    if (!bubble) return { write() {} };
    let textNode = null;
    return {
      write(piece, fullText) {
        const box = chatBox();
        const nearBottom = box ? box.scrollHeight - box.scrollTop - box.clientHeight < 80 : false;
        if (!textNode) {
          bubble.classList.remove("refusal"); // the dots bubble is styled as a refusal
          bubble.textContent = "";
          textNode = document.createTextNode("");
          const cursor = document.createElement("span");
          cursor.className = "stream-cursor";
          bubble.append(textNode, cursor);
        }
        textNode.nodeValue = fullText; // text only, never HTML
        if (nearBottom && typeof scrollChatToBottom === "function") scrollChatToBottom();
      },
    };
  }

  async function streamAsk(question, topK) {
    const controller = new AbortController();
    let timer = null;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), ASK_TIMEOUT_MS); // no data for this long = give up
    };

    try {
      arm();
      const res = await fetch(`${API_BASE}/ask/stream`, {
        method: "POST",
        headers: Object.assign(
          { "Content-Type": "application/json" },
          authToken ? { Authorization: `Bearer ${authToken}` } : {}
        ),
        body: JSON.stringify({ question, top_k: topK }),
        signal: controller.signal,
      });

      if (res.status === 404 || res.status === 405) return null; // no streaming route: use the normal way

      if (!res.ok) {
        let data = null;
        try { data = await res.json(); } catch (e) { data = null; }
        const message = detailToMessage(data && data.detail, `Request failed (${res.status}).`);
        if (res.status === 401 && authToken && unauthorizedHandler) unauthorizedHandler(message);
        return { ok: false, status: res.status, message, data };
      }

      const writer = makeWriter();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fullText = "";
      let finished = null;

      const handle = (line) => {
        if (!line.trim()) return null;
        let ev;
        try { ev = JSON.parse(line); } catch (e) { return null; }
        if (ev.type === "token") {
          fullText += ev.text;
          writer.write(ev.text, fullText);
        } else if (ev.type === "done") {
          finished = { ok: true, status: 200, data: { answer: ev.answer, sources: ev.sources || [] } };
        } else if (ev.type === "error") {
          finished = { ok: false, status: ev.status || 502, message: ev.message || "The model stopped answering.", data: null };
        }
        return finished;
      };

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        arm();
        buffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          handle(line);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) handle(buffer);

      return finished || { ok: false, status: 0, message: "The connection was interrupted.", data: null };
    } catch (err) {
      if (err && err.name === "AbortError") {
        return { ok: false, status: 0, message: "The request timed out.", data: null };
      }
      return { ok: false, status: 0, message: "Can't reach the backend.", data: null };
    } finally {
      clearTimeout(timer);
    }
  }

  Api.ask = async function (question, topK = 5, conversationId = null) {
    const result = await streamAsk(question, topK);
    if (result === null) return previousAsk(question, topK, conversationId);
    return result;
  };
})();
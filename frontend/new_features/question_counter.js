/* Small fix: make "Questions asked" show how many questions are in your saved
 * chat history, instead of how many were asked since the page loaded.
 *
 * Why: app.js keeps this number in memory only (state.questionsAsked), so a
 * refresh reset it to 0 even though the conversations were restored. The
 * conversation list already knows the real numbers (each saved conversation
 * has a question count), so this file simply adds them up.
 *
 * How it plugs in: it changes nothing in app.js. It watches the conversation
 * list and the counter itself, and rewrites the counter with the real total.
 * Load it after app.js and chat_history.js, e.g.
 *     <script src="new_features/question_counter.js"></script>
 * To remove it: delete the script line (and this file).
 *
 * Globals used from app.js: state, el.
 */
(function () {
  "use strict";

  function total() {
    if (typeof state === "undefined" || !Array.isArray(state.conversations)) return null;
    return state.conversations.reduce((sum, c) => {
      const n = c.messagesLoaded && Array.isArray(c.messages)
        ? c.messages.filter((m) => m.role === "user").length
        : Number(c.questionCount) || 0;
      return sum + n;
    }, 0);
  }

  let counter = null;
  let scheduled = false;

  function refresh() {
    scheduled = false;
    if (!counter) return;
    const n = total();
    if (n === null) return;
    const text = String(n);
    if (counter.textContent !== text) counter.textContent = text; // only write when it differs: no loop
    counter.title = "Questions in your saved chat history";
  }

  // run once after the current burst of DOM changes has settled
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(refresh, 0);
  }

  function start() {
    counter = document.getElementById("status-questions");
    if (!counter) return;
    const list = document.getElementById("conversation-list");
    if (list) new MutationObserver(schedule).observe(list, { childList: true, subtree: true });
    // app.js writes its own number here after every question; correct it right away
    new MutationObserver(schedule).observe(counter, { childList: true, characterData: true, subtree: true });
    schedule();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
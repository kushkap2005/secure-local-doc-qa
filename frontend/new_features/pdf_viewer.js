/* Feature 3: built-in PDF viewer.
 *
 * Two ways to open it:
 *   - click a document's name in the Documents list  -> opens at page 1
 *   - open a source chip under an answer, then click "Open PDF" -> opens at the
 *     cited page with the cited passage highlighted
 *
 * It downloads the PDF from the server (GET /documents/{hash}/pdf, which only
 * answers if your role may see that document) and draws it with pdf.js, which
 * is bundled in frontend/vendor/pdfjs/ so nothing is loaded from the internet.
 * If those two files are missing it falls back to the browser's own PDF
 * viewer (page jump works, highlighting does not).
 *
 * It does not change app.js: it watches the chat and the document list and
 * adds its buttons, the same way badges.js and source_cards.js do.
 * To remove: delete the <script> line in index.html.
 */
(function () {
  "use strict";

  const PDFJS_SRC = "vendor/pdfjs/pdf.min.js";
  const WORKER_SRC = "vendor/pdfjs/pdf.worker.min.js";
  const MIN_SCALE = 0.6;
  const MAX_SCALE = 3;

  const css = `
    .pv-overlay { position:fixed; inset:0; z-index:70; background:rgba(0,0,0,.65); display:flex;
                  align-items:center; justify-content:center; padding:2vh 2vw; }
    .pv-overlay[hidden] { display:none; }
    .pv { width:min(1000px,100%); height:100%; display:flex; flex-direction:column; border-radius:14px; overflow:hidden;
          background:var(--bg-panel, #11151f); color:inherit; border:1px solid var(--border, rgba(128,128,128,.3)); }
    .pv-bar { display:flex; flex-wrap:wrap; align-items:center; gap:8px; padding:10px 14px;
              border-bottom:1px solid var(--border, rgba(128,128,128,.3)); }
    .pv-title { font-weight:600; font-size:14px; flex:1 1 200px; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .pv-bar button { font:inherit; font-size:13px; padding:4px 10px; border-radius:8px; cursor:pointer; color:inherit;
                     background:transparent; border:1px solid var(--border, rgba(128,128,128,.4)); }
    .pv-bar button:disabled { opacity:.4; cursor:default; }
    .pv-pageinfo { font-size:13px; min-width:92px; text-align:center; font-variant-numeric:tabular-nums; }
    .pv-note { padding:6px 14px; font-size:12px; opacity:.85; border-bottom:1px solid var(--border, rgba(128,128,128,.25)); }
    .pv-stage { flex:1; overflow:auto; padding:16px; background:rgba(128,128,128,.12); position:relative; }
    .pv-page { position:relative; margin:0 auto; background:#fff; box-shadow:0 2px 14px rgba(0,0,0,.35); }
    .pv-page canvas { display:block; }
    .pv-text { position:absolute; inset:0; overflow:hidden; line-height:1; }
    .pv-text span { position:absolute; white-space:pre; color:transparent; transform-origin:0 0; cursor:text; }
    .pv-text .pv-hit { background:rgba(255,200,0,.42); border-radius:2px; }
    .pv-msg { padding:40px 16px; text-align:center; font-size:14px; }
    .pv-frame { width:100%; height:100%; border:0; background:#fff; }
    .doc-item-name.pv-link { cursor:pointer; }
    .doc-item-name.pv-link:hover { text-decoration:underline; }
    .pv-open { font:inherit; font-size:12px; padding:2px 10px; border-radius:8px; cursor:pointer; color:inherit;
               background:transparent; border:1px solid var(--accent, #6366f1); }
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  // ---------- helpers: finding the cited passage on a page -------------------
  const WORD_RE = /[a-z0-9\u00c0-\u024f]+|[^\s]/g; // a word, or one symbol on its own
  function words(s) {
    return String(s).toLowerCase().match(WORD_RE) || [];
  }
  function isWord(t) {
    return /[a-z0-9\u00c0-\u024f]/.test(t);
  }

  function indexOfSeq(hay, needle, from) {
    outer: for (let s = from; s + needle.length <= hay.length; s++) {
      for (let k = 0; k < needle.length; k++) if (hay[s + k].w !== needle[k]) continue outer;
      return s;
    }
    return -1;
  }

  /** itemStrings = the page's text pieces in order; passage = the cited chunk.
   *  Returns { from, to } (indexes into itemStrings) or null if it can't be located. */
  function findRange(itemStrings, passage) {
    const hay = [];
    itemStrings.forEach((str, i) => words(str).forEach((w) => hay.push({ w, i })));
    const pw = words(passage);
    if (!hay.length || pw.length < 3) return null;

    // chunks are cut by length, so the first/last word may be a fragment:
    // try anchors that skip a few words at either end.
    let startWord = -1;
    for (const K of [6, 5, 4, 3]) {
      for (let a = 0; a <= 8 && a + K <= pw.length && startWord < 0; a++) {
        const s = indexOfSeq(hay, pw.slice(a, a + K), 0);
        if (s >= 0) startWord = Math.max(0, s - a);
      }
      if (startWord >= 0) break;
    }
    if (startWord < 0) return null;

    let endWord = -1;
    for (const K of [6, 5, 4, 3]) {
      for (let b = 0; b <= 8 && pw.length - b - K >= 0 && endWord < 0; b++) {
        const needle = pw.slice(pw.length - b - K, pw.length - b);
        const e = indexOfSeq(hay, needle, startWord);
        if (e >= 0) endWord = Math.min(hay.length - 1, e + K - 1 + b);
      }
      if (endWord >= 0) break;
    }
    if (endWord < startWord) endWord = Math.min(hay.length - 1, startWord + pw.length - 1);
    return { from: hay[startWord].i, to: hay[endWord].i };
  }

  /** Order-independent fallback. PDF text pieces can come back in a different
   *  order than the saved chunk (columns, text boxes on slides), so a single
   *  unbroken match fails. This marks every piece whose words appear in the
   *  passage, then fills single-word gaps between two marked pieces.
   *  Returns the sorted list of piece indexes to highlight (empty = none). */
  function scatterHits(itemStrings, passage) {
    const pw = words(passage);
    if (pw.filter(isWord).length < 3) return [];
    const text = " " + pw.join(" ") + " ";
    const wl = itemStrings.map(words);
    const real = wl.map((iw) => iw.filter(isWord).length);
    const mark = new Array(itemStrings.length).fill(false);
    wl.forEach((iw, i) => {
      if (real[i] < 2) return;
      const n = Math.min(4, iw.length);
      for (let a = 0; a + n <= iw.length; a++) {
        const piece = iw.slice(a, a + n);
        if (piece.filter(isWord).length >= 2 && text.indexOf(" " + piece.join(" ") + " ") >= 0) {
          mark[i] = true;
          break;
        }
      }
    });
    // short pieces (bullets, symbols, one word) sitting between two hits belong to the passage
    const filled = mark.slice();
    for (let i = 1; i < mark.length - 1; i++) {
      if (mark[i] || real[i] > 1) continue;
      let l = i - 1;
      let r = i + 1;
      while (l > 0 && !mark[l] && real[l] <= 1) l--;
      while (r < mark.length - 1 && !mark[r] && real[r] <= 1) r++;
      if (mark[l] && mark[r]) filled[i] = true;
    }
    const out = [];
    filled.forEach((m, i) => m && out.push(i));
    return out;
  }

  // ---------- loading pdf.js and the PDF -------------------------------------
  let pdfjsPromise = null;
  function loadPdfJs() {
    if (window.pdfjsLib) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER_SRC;
      return Promise.resolve(window.pdfjsLib);
    }
    if (!pdfjsPromise) {
      pdfjsPromise = new Promise((resolve) => {
        const s = document.createElement("script");
        s.src = PDFJS_SRC;
        s.onload = () => {
          if (window.pdfjsLib) window.pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER_SRC;
          resolve(window.pdfjsLib || null);
        };
        s.onerror = () => resolve(null);
        document.head.appendChild(s);
      });
    }
    return pdfjsPromise;
  }

  async function fetchPdfBytes(hash) {
    const token = typeof authToken !== "undefined" ? authToken : null;
    let res;
    try {
      res = await fetch(`${API_BASE}/documents/${encodeURIComponent(hash)}/pdf`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    } catch (e) {
      return { error: "Can't reach the backend." };
    }
    if (res.status === 401) {
      if (token && typeof unauthorizedHandler === "function") unauthorizedHandler("Please sign in again.");
      return { error: "Please sign in again." };
    }
    if (res.status === 404) {
      return {
        error:
          "The PDF itself isn't stored for this document (it was uploaded before the viewer existed, or you can't see it). An Admin can clear and re-upload it to enable viewing.",
      };
    }
    if (!res.ok) return { error: `Couldn't load the PDF (error ${res.status}).` };
    return { buffer: await res.arrayBuffer() };
  }

  // ---------- the viewer window ----------------------------------------------
  let ui = null;
  let state_ = { hash: null, doc: null, bytes: null, page: 1, scale: 1.3, target: null, token: 0, native: null };

  function build() {
    if (ui) return ui;
    const overlay = document.createElement("div");
    overlay.className = "pv-overlay";
    overlay.hidden = true;
    overlay.innerHTML = `
      <div class="pv" role="dialog" aria-modal="true" aria-label="PDF viewer">
        <div class="pv-bar">
          <div class="pv-title"></div>
          <button type="button" data-a="prev" aria-label="Previous page">&lsaquo; Prev</button>
          <span class="pv-pageinfo"></span>
          <button type="button" data-a="next" aria-label="Next page">Next &rsaquo;</button>
          <button type="button" data-a="zoomout" aria-label="Zoom out">&minus;</button>
          <button type="button" data-a="zoomin" aria-label="Zoom in">+</button>
          <button type="button" data-a="close">Close</button>
        </div>
        <div class="pv-note" hidden></div>
        <div class="pv-stage"></div>
      </div>`;
    document.body.appendChild(overlay);
    ui = {
      overlay,
      title: overlay.querySelector(".pv-title"),
      info: overlay.querySelector(".pv-pageinfo"),
      note: overlay.querySelector(".pv-note"),
      stage: overlay.querySelector(".pv-stage"),
      btn: (a) => overlay.querySelector(`[data-a="${a}"]`),
    };
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
    ui.btn("close").addEventListener("click", close);
    ui.btn("prev").addEventListener("click", () => goTo(state_.page - 1));
    ui.btn("next").addEventListener("click", () => goTo(state_.page + 1));
    ui.btn("zoomin").addEventListener("click", () => zoom(1.2));
    ui.btn("zoomout").addEventListener("click", () => zoom(1 / 1.2));
    document.addEventListener("keydown", (e) => {
      if (ui.overlay.hidden) return;
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight") goTo(state_.page + 1);
      else if (e.key === "ArrowLeft") goTo(state_.page - 1);
    });
    return ui;
  }

  function close() {
    if (!ui) return;
    ui.overlay.hidden = true;
    state_.token++;
    ui.stage.textContent = "";
    if (state_.native) {
      URL.revokeObjectURL(state_.native);
      state_.native = null;
    }
    state_.doc = null;
    state_.bytes = null;
    state_.hash = null;
  }

  function message(text) {
    ui.stage.textContent = "";
    const m = document.createElement("div");
    m.className = "pv-msg";
    m.textContent = text;
    ui.stage.appendChild(m);
    ui.info.textContent = "";
    ["prev", "next", "zoomin", "zoomout"].forEach((a) => (ui.btn(a).disabled = true));
  }

  function setControls() {
    const n = state_.doc ? state_.doc.numPages : 0;
    ui.info.textContent = n ? `Page ${state_.page} of ${n}` : "";
    ui.btn("prev").disabled = !n || state_.page <= 1;
    ui.btn("next").disabled = !n || state_.page >= n;
    ui.btn("zoomin").disabled = !n || state_.scale >= MAX_SCALE;
    ui.btn("zoomout").disabled = !n || state_.scale <= MIN_SCALE;
  }

  function goTo(n) {
    if (!state_.doc || n < 1 || n > state_.doc.numPages) return;
    state_.page = n;
    renderPage();
  }

  function zoom(f) {
    if (!state_.doc) return;
    state_.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, state_.scale * f));
    renderPage();
  }

  async function renderPage() {
    const myToken = ++state_.token;
    setControls();
    const page = await state_.doc.getPage(state_.page);
    if (myToken !== state_.token) return;

    const viewport = page.getViewport({ scale: state_.scale });
    const ratio = window.devicePixelRatio || 1;

    const holder = document.createElement("div");
    holder.className = "pv-page";
    holder.style.width = `${Math.floor(viewport.width)}px`;
    holder.style.height = `${Math.floor(viewport.height)}px`;
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = holder.style.width;
    canvas.style.height = holder.style.height;
    const textLayer = document.createElement("div");
    textLayer.className = "pv-text";
    textLayer.style.setProperty("--scale-factor", String(viewport.scale));
    holder.append(canvas, textLayer);

    const ctx = canvas.getContext("2d");
    await page.render({
      canvasContext: ctx,
      viewport,
      transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null,
    }).promise;
    if (myToken !== state_.token) return;

    ui.stage.textContent = "";
    ui.stage.appendChild(holder);

    try {
      const textContent = await page.getTextContent();
      if (myToken !== state_.token) return;
      const divs = [];
      const strs = [];
      await window.pdfjsLib.renderTextLayer({
        textContentSource: textContent,
        container: textLayer,
        viewport,
        textDivs: divs,
        textContentItemsStr: strs,
      }).promise;
      if (myToken !== state_.token) return;

      const t = state_.target;
      if (t && t.passage && t.page === state_.page) {
        const range = findRange(strs, t.passage);
        const scattered = scatterHits(strs, t.passage);
        const wordsIn = (idx) => idx.reduce((n, i) => n + words(strs[i] || "").filter(isWord).length, 0);
        const rangeIdx = [];
        if (range) for (let i = range.from; i <= range.to && i < divs.length; i++) rangeIdx.push(i);
        // an unbroken match is best, but if it covers far less than the order-free
        // match (text order differs in this PDF), prefer the order-free one
        // The unbroken match fills EVERYTHING between its first and last anchor, so
        // when the passage's start and end sit far apart it lights up the whole
        // page. The piece-by-piece match marks only text that is really in the
        // passage, so it is preferred whenever it finds a decent part of it.
        const passageWords = words(t.passage).filter(isWord).length || 1;
        const useScatter = scattered.length >= 2 && (!range || wordsIn(scattered) / passageWords >= 0.4);
        const hits = useScatter ? scattered.filter((i) => i < divs.length) : rangeIdx;
        if (hits.length) {
          hits.forEach((i) => divs[i].classList.add("pv-hit"));
          if (divs[hits[0]]) divs[hits[0]].scrollIntoView({ block: "center" });
          ui.note.hidden = false;
          ui.note.textContent = "The passage the answer used is highlighted.";
        } else {
          ui.note.hidden = false;
          ui.note.textContent = "Couldn't pinpoint the passage on this page (the PDF's text layout differs from the saved text). Page shown instead.";
        }
      } else {
        ui.note.hidden = true;
      }
    } catch (e) {
      /* text layer is optional: the page is still readable */
    }
  }

  function showNative(bytes, page, note) {
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    state_.native = url;
    ui.stage.textContent = "";
    ui.stage.style.padding = "0";
    const frame = document.createElement("iframe");
    frame.className = "pv-frame";
    frame.src = `${url}#page=${page}`;
    ui.stage.appendChild(frame);
    ui.info.textContent = "";
    ["prev", "next", "zoomin", "zoomout"].forEach((a) => (ui.btn(a).disabled = true));
    ui.note.hidden = false;
    ui.note.textContent = note || "Using the browser's own PDF viewer. Add the pdf.js files in frontend/vendor/pdfjs to get highlighting.";
  }

  /** Open the viewer. hash: document id. page: 1-based. passage: text to highlight (optional). */
  async function openViewer({ hash, name, page = 1, passage = "" }) {
    build();
    ui.stage.style.padding = "";
    ui.title.textContent = name || "PDF";
    ui.note.hidden = true;
    ui.overlay.hidden = false;
    state_ = { hash, doc: null, bytes: null, page: Math.max(1, page), scale: 1.3, target: { page: Math.max(1, page), passage }, token: state_.token + 1, native: null };
    message("Loading\u2026");

    const [got, lib] = await Promise.all([fetchPdfBytes(hash), loadPdfJs()]);
    if (ui.overlay.hidden || state_.hash !== hash) return; // closed meanwhile
    if (got.error) return message(got.error);

    if (!lib) return showNative(got.buffer, state_.page);

    // pdf.js takes ownership of the buffer it is given, so give it a copy and
    // keep the original for the browser's own viewer as a fallback.
    const head = new Uint8Array(got.buffer.slice(0, 5));
    const looksLikePdf = String.fromCharCode(...head) === "%PDF-";
    try {
      if (!looksLikePdf) throw new Error("the stored file does not start with %PDF (" + got.buffer.byteLength + " bytes)");
      state_.doc = await lib.getDocument({ data: got.buffer.slice(0) }).promise;
    } catch (e) {
      console.error("PDF viewer: pdf.js could not open the file", e);
      if (looksLikePdf) return showNative(got.buffer, state_.page, "The built-in reader couldn't parse this file, so the browser's own PDF viewer is used (no highlighting)."); // the browser's viewer can usually still show it
      return message("The stored file is not a valid PDF (" + got.buffer.byteLength + " bytes). Clear all documents and upload it again.");
    }
    if (state_.page > state_.doc.numPages) state_.page = state_.doc.numPages;
    // Start at "fit to window width" instead of a fixed zoom, so wide slide
    // pages aren't cut off. The zoom buttons still work from there.
    try {
      const first = await state_.doc.getPage(state_.page);
      const pageWidth = first.getViewport({ scale: 1 }).width;
      const room = ui.stage.clientWidth - 40;
      if (pageWidth > 0 && room > 0) state_.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, 1.6, room / pageWidth));
    } catch (e) {
      /* keep the default zoom */
    }
    await renderPage();
  }

  window.openPdfViewer = openViewer; // handy for testing from the console

  // ---------- hook 1: document names in the sidebar --------------------------
  function hashForName(name) {
    const docs = typeof state !== "undefined" && state.documents ? state.documents : [];
    const d = docs.find((x) => x.name === name);
    return d ? d.file_hash : null;
  }

  function decorateDocs() {
    document.querySelectorAll("#doc-list .doc-item-name").forEach((n) => {
      if (n.dataset.pvReady) return;
      n.dataset.pvReady = "1";
      n.classList.add("pv-link");
      n.title = "Open this PDF";
      n.tabIndex = 0;
      n.setAttribute("role", "button");
      const go = () => {
        const name = n.textContent.trim();
        const hash = hashForName(name);
        if (hash) openViewer({ hash, name, page: 1 });
      };
      n.addEventListener("click", go);
      n.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          go();
        }
      });
    });
  }

  // ---------- closing an opened source card ------------------------------------
  // Both kinds of card are closed the same way a second click on their chip
  // would close them, so the card scripts keep their own state in step.
  function closePanel(panel) {
    if (!panel) return;
    const chip = panel.parentElement && panel.parentElement.querySelector('.source-chip[aria-expanded="true"]');
    if (chip) chip.click();
    else panel.hidden = true;
  }
  function closeAllPanels() {
    document.querySelectorAll("#chat .source-passage:not([hidden])").forEach(closePanel);
  }
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (ui && !ui.overlay.hidden) return; // the PDF window handles its own Esc
    closeAllPanels();
  });
  document.addEventListener("click", (e) => {
    if (e.target.closest(".source-passage, .source-chip, .pv-overlay")) return;
    closeAllPanels();
  });

  // ---------- hook 2: "Open PDF" inside an opened source card ------------------
  function decorateSources() {
    document.querySelectorAll(".source-passage:not([hidden]) .source-passage-head").forEach((head) => {
      if (!head.querySelector(".pv-close")) {
        const x = document.createElement("button");
        x.type = "button";
        x.className = "pv-open pv-close";
        x.textContent = "\u2715";
        x.title = "Close";
        x.setAttribute("aria-label", "Close this passage");
        x.addEventListener("click", () => closePanel(head.parentElement));
        head.appendChild(x);
      }
      if (head.querySelector(".pv-open:not(.pv-close)")) return;
      const label = head.firstElementChild ? head.firstElementChild.textContent : "";
      const m = /^(.*) \u00b7 page (\d+)$/.exec(label.trim());
      if (!m) return;
      const name = m[1];
      const page = parseInt(m[2], 10);
      const hash = hashForName(name);
      if (!hash) return;
      const body = head.parentElement.querySelector(".source-passage-text");
      const pageOnly = head.parentElement.dataset.pageText === "1"; // saved answer: whole page text, nothing to highlight
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pv-open";
      b.textContent = "Open PDF";
      b.title = "Open the PDF at this page with the passage highlighted";
      b.addEventListener("click", () => openViewer({ hash, name, page, passage: body && !pageOnly ? body.textContent : "" }));
      head.insertBefore(b, head.lastElementChild);
    });
  }

  // ---------- hook 3: chips of saved (older) answers --------------------------
  // After a refresh, answers come back from chat history without any document
  // text (by design: history never stores it). Clicking such a chip fetches
  // the text of that page again from the server, under the viewer's CURRENT
  // role, and shows it in the same kind of card as a fresh answer, with the
  // same "Open PDF" button. If the document is no longer visible to the
  // role, the server refuses and the card says so.
  const CHIP_LABEL = /(.+?)\s\u00b7\sp(\d+)/;

  async function fetchPageText(hash, page) {
    const token = typeof authToken !== "undefined" ? authToken : null;
    try {
      const res = await fetch(`${API_BASE}/documents/${encodeURIComponent(hash)}/pages/${page}/text`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.status === 401 && token && typeof unauthorizedHandler === "function") unauthorizedHandler("Please sign in again.");
      if (!res.ok) return null;
      const data = await res.json();
      return data.chunks && data.chunks.length ? data.chunks : null;
    } catch (e) {
      return null;
    }
  }

  function fillPagePanel(panel, name, page, chunks) {
    panel.textContent = "";
    panel.dataset.pageText = "1";
    const head = document.createElement("div");
    head.className = "source-passage-head";
    const l = document.createElement("span");
    l.textContent = name + " \u00b7 page " + page;
    const r = document.createElement("span");
    r.textContent = "text on this page";
    head.append(l, r);
    const body = document.createElement("div");
    body.className = "source-passage-text";
    // textContent only: document text is untrusted
    body.textContent = chunks
      ? chunks.join("\n\n")
      : "The text of this page isn't available (the document may no longer be visible to your role, or it was removed). You can still try opening the PDF.";
    panel.append(head, body);
  }

  function decorateChips() {
    document.querySelectorAll("#chat .source-chip:not([data-has-passage])").forEach((chip) => {
      if (chip.dataset.pvChip) return;
      const copy = chip.cloneNode(true);
      copy.querySelectorAll(".chip-copy, .relevance-bar, .relevance").forEach((x) => x.remove());
      const m = CHIP_LABEL.exec(copy.textContent.replace(/\s+/g, " ").trim());
      if (!m) return;
      const name = m[1].trim();
      const page = parseInt(m[2], 10);
      const box = chip.closest(".sources");
      if (!box) return;
      chip.dataset.pvChip = "1";
      chip.dataset.pvIndex = String(Math.random()).slice(2); // identifies this chip
      chip.style.cursor = "pointer";
      chip.tabIndex = 0;
      chip.setAttribute("role", "button");
      chip.setAttribute("aria-expanded", "false");
      chip.title = "Show the text of page " + page;

      const toggle = async () => {
        // one card per answer, placed under its chips
        let panel = box.nextElementSibling;
        if (!panel || !panel.classList.contains("pv-pagepanel")) {
          panel = document.createElement("div");
          panel.className = "source-passage pv-pagepanel";
          panel.hidden = true;
          box.insertAdjacentElement("afterend", panel);
        }
        const wasOpenHere = !panel.hidden && panel.dataset.owner === chip.dataset.pvIndex;
        box.querySelectorAll(".source-chip[aria-expanded]").forEach((c) => c.setAttribute("aria-expanded", "false"));
        if (wasOpenHere) {
          panel.hidden = true;
          return;
        }
        panel.dataset.owner = chip.dataset.pvIndex;
        chip.setAttribute("aria-expanded", "true");
        fillPagePanel(panel, name, page, null);
        panel.querySelector(".source-passage-text").textContent = "Loading\u2026";
        panel.hidden = false;
        const hash = hashForName(name);
        const chunks = hash ? await fetchPageText(hash, page) : null;
        if (panel.hidden || panel.dataset.owner !== chip.dataset.pvIndex) return; // closed or switched meanwhile
        fillPagePanel(panel, name, page, chunks);
      };

      chip.addEventListener("click", (e) => {
        if (e.target.closest(".chip-copy")) return; // the copy icon keeps its own job
        toggle();
      });
      chip.addEventListener("keydown", (e) => {
        if (e.target !== chip) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle();
        }
      });
    });
  }

  function decorateChat() {
    decorateSources();
    decorateChips();
  }

  function start() {
    decorateDocs();
    const docList = document.getElementById("doc-list");
    if (docList) new MutationObserver(decorateDocs).observe(docList, { childList: true, subtree: true });
    const chat = document.getElementById("chat");
    if (chat) new MutationObserver(decorateChat).observe(chat, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();

  window.__pvFindRange = findRange; // for tests
  window.__pvScatter = scatterHits; // for tests
})();
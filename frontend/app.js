/**
 * app.js — UI logic for the doc_rag frontend.
 * Structure: STRINGS -> state -> utils -> render -> handlers -> init.
 */

/* ---------------------------------------------------------------------- *
 * Strings — every user-facing string lives here so copy is easy to edit.
 * ---------------------------------------------------------------------- */
const STRINGS = {
  connOnline: "Online",
  connOffline: "Offline",
  connChecking: "Connecting…",
  offlineBanner: "Can't reach the backend. Is the API server running?",
  llmOfflineBanner: "The local LLM is unreachable. Check that Ollama is running.",

  statusOnline: "reachable",
  statusOffline: "unreachable",

  uploadOnlyPdf: "Only PDF files are supported.",
  uploadTooLarge: (mb) => `Too large — limit is ${mb} MB.`,
  uploadDuplicate: "Already indexed — this exact file is in the store.",
  uploadPasswordProtected: "Password-protected PDF, cannot read.",
  uploadNetworkError: "Can't reach the backend.",
  uploadGenericError: "Upload failed.",
  uploadSuccess: (name, chunks) => `Indexed "${name}" — ${chunks} chunks added.`,

  askNoDocuments: "Upload and ingest a document first.",
  askLlmUnreachable: "The local LLM is unreachable. Check that Ollama is running and try again.",
  askGenericError: "Something went wrong answering that question.",
  askRefusalNotFound: "I couldn't find this in the provided documents.",
  askRefusalNoDocs: "No documents have been ingested yet.",

  resetConfirmTitle: "Clear all documents?",
  resetConfirmBody: "This permanently removes every indexed chunk from the vector store. This can't be undone.",
  resetSuccess: "All documents and chunks cleared.",
  resetError: "Couldn't clear documents.",

  copyAnswer: "Copy",
  copied: "Copied",
  citationCopied: "Citation copied",
  newConversationStarted: "Started a new chat.",
  defaultConversationTitle: "New conversation",
  uploadCancelled: "Upload cancelled.",
  noSearchMatches: "No matches",

  signIn: "Sign in",
  createAccount: "Create account",
  needAccount: "Need an account?",
  haveAccount: "Already have one?",
  signedInAs: (name) => `Signed in as ${name}.`,
  signedOut: "Signed out.",
  sessionExpired: "Your session expired — signed out.",
  authGenericError: "Something went wrong. Try again.",
  couldntLoadConversations: "Couldn't load your saved conversations.",

  loginRequired: "Sign in to ask questions.",
  noDocsForRole: "No documents available to your role yet.",
  noDocsSignedOut: "Sign in to see documents.",
  docLevelSaved: (name, label) => `"${name}" is now visible to: ${label}.`,
  docLevelFailed: "Couldn't change who can see that document.",
  forbiddenGeneric: "Your role doesn't allow that.",
  uploadForbidden: "Your role can't upload documents.",
  resetForbidden: "Only an Admin can clear documents.",
  uploadRoleNote: (role) => `Your role (${role}) can't upload documents. Ask a Staff or Admin user.`,
  enterCredentials: "Enter your username and password.",
  userCreated: (name, role) => `Created ${role} account "${name}".`,
  roleChanged: (name, role) => `${name} is now ${role} and must sign in again.`,

  // Deliberately generic — this pipeline retrieves by embedding similarity and
  // refuses when a chunk only mentions a topic without fully explaining it, so
  // no canned prompt can be guaranteed to match an arbitrary uploaded PDF. These
  // are realistic *formats* to adapt, not promises of an answer.
  examplePrompts: [
    "What is [a specific term from your document] and how does it work?",
    "According to the document, what is [a claim it makes]?",
    "Define [a term you saw used] as this document explains it.",
  ],
};

const MAX_FILE_SIZE_MB = 100;
const CLEAR_ON_CLOSE_DEFAULT = true;
const STATUS_POLL_MS = 10000;
const RECENT_QUESTIONS_MAX = 8;
const DOC_FILTER_MIN_DOCS = 4; // filter input only appears once it's actually useful
const AUTH_TOKEN_KEY = "docrag_token"; // localStorage — deliberately NOT session-scoped,
                                        // since the whole point of an account is staying
                                        // signed in across visits, unlike everything else here

// Mirrors ROLE_HIERARCHY in database.py. Used only to show/hide controls — the
// API enforces the real permissions on every request.
const ROLE_LEVELS = { Guest: 0, Staff: 1, Admin: 2 };

// What a document's minimum role means to a person reading the list.
const LEVEL_LABELS = { Guest: "Everyone", Staff: "Staff & Admin", Admin: "Admin only" };

// Saved-conversation sync needs the server's /conversations routes, which the
// RBAC backend doesn't have yet. Conversations stay in-memory until it does.
const SYNC_CONVERSATIONS = true;

/* ---------------------------------------------------------------------- *
 * State
 * ---------------------------------------------------------------------- */
const state = {
  theme: null, // 'dark' | 'light'
  backendOnline: null, // null = unknown, true/false once checked
  chunksIndexed: null,
  documents: [], // [{ file_hash, name, chunks, minRole }] — the documents THIS role may see,
                 // fetched from GET /documents (a Guest and an Admin get different lists).
  editingDocHash: null, // which document the "who can see this" dialog is open for
  asking: false,
  clearOnClose: CLEAR_ON_CLOSE_DEFAULT,
  llmOffline: false, // separate from backendOnline — the API can be up while Ollama is down
  questionsAsked: 0,
  topK: 5, // passed straight through to /ask's top_k
  recentQuestions: [], // most-recent-first, deduped, session-scoped
  chatSearch: { active: false, marks: [], currentIndex: -1 },
  conversations: [], // separate transcripts — server-synced when signed in, local-only as guest
  activeConversationId: null,
  username: null, // null = signed out
  role: null, // 'Guest' | 'Staff' | 'Admin' — mirrors the server, for UI gating only
};

/* ---------------------------------------------------------------------- *
 * DOM refs
 * ---------------------------------------------------------------------- */
const el = {
  themeToggle: document.getElementById("theme-toggle"),
  sidebarToggle: document.getElementById("sidebar-toggle"),
  app: document.querySelector(".app"),
  sidebar: document.getElementById("sidebar"),

  connDot: document.getElementById("conn-dot"),
  connLabel: document.getElementById("conn-label"),
  offlineBanner: document.getElementById("offline-banner"),
  offlineBannerText: document.getElementById("offline-banner-text"),

  statusBackend: document.getElementById("status-backend"),
  statusChunks: document.getElementById("status-chunks"),
  statusDocs: document.getElementById("status-docs"),
  statusQuestions: document.getElementById("status-questions"),
  maxSize: document.getElementById("max-size"),

  dropzone: document.getElementById("dropzone"),
  fileInput: document.getElementById("file-input"),
  uploadQueue: document.getElementById("upload-queue"),

  docList: document.getElementById("doc-list"),
  docEmpty: document.getElementById("doc-empty"),
  docFilter: document.getElementById("doc-filter"),

  clearOnCloseToggle: document.getElementById("clear-on-close"),
  clearOnCloseRow: document.getElementById("clear-on-close-row"),
  clearOnCloseNote: document.getElementById("clear-on-close-note"),
  topKInput: document.getElementById("top-k-input"),
  topKValue: document.getElementById("top-k-value"),
  resetBtn: document.getElementById("reset-btn"),

  accountArea: document.getElementById("account-area"),
  authOverlay: document.getElementById("auth-overlay"),
  authTitle: document.getElementById("auth-title"),
  authForm: document.getElementById("auth-form"),
  authUsername: document.getElementById("auth-username"),
  authPassword: document.getElementById("auth-password"),
  authError: document.getElementById("auth-error"),
  authSubmit: document.getElementById("auth-submit"),

  uploadRoleNote: document.getElementById("upload-role-note"),
  uploadLevelRow: document.getElementById("upload-level-row"),
  uploadLevel: document.getElementById("upload-level"),

  docLevelOverlay: document.getElementById("doc-level-overlay"),
  docLevelForm: document.getElementById("doc-level-form"),
  docLevelName: document.getElementById("doc-level-name"),
  docLevelSelect: document.getElementById("doc-level-select"),
  docLevelError: document.getElementById("doc-level-error"),
  docLevelSave: document.getElementById("doc-level-save"),
  docLevelCancel: document.getElementById("doc-level-cancel"),

  adminOverlay: document.getElementById("admin-overlay"),
  adminCreateForm: document.getElementById("admin-create-form"),
  adminNewUsername: document.getElementById("admin-new-username"),
  adminNewPassword: document.getElementById("admin-new-password"),
  adminNewRole: document.getElementById("admin-new-role"),
  adminCreateSubmit: document.getElementById("admin-create-submit"),
  adminRoleForm: document.getElementById("admin-role-form"),
  adminRoleUsername: document.getElementById("admin-role-username"),
  adminRoleSelect: document.getElementById("admin-role-select"),
  adminRoleSubmit: document.getElementById("admin-role-submit"),
  adminError: document.getElementById("admin-error"),
  adminSuccess: document.getElementById("admin-success"),
  adminClose: document.getElementById("admin-close"),

  chat: document.getElementById("chat"),
  emptyState: document.getElementById("empty-state"),
  examplePrompts: document.getElementById("example-prompts"),
  newChatBtn: document.getElementById("new-chat-btn"),
  scrollBottomBtn: document.getElementById("scroll-bottom-btn"),

  conversationSwitcher: document.getElementById("conversation-switcher"),
  activeConversationTitle: document.getElementById("active-conversation-title"),
  conversationPanel: document.getElementById("conversation-panel"),
  conversationList: document.getElementById("conversation-list"),
  convPanelNew: document.getElementById("conv-panel-new"),

  chatSearchToggle: document.getElementById("chat-search-toggle"),
  chatSearchBar: document.getElementById("chat-search-bar"),
  chatSearchInput: document.getElementById("chat-search-input"),
  chatSearchCount: document.getElementById("chat-search-count"),
  chatSearchPrev: document.getElementById("chat-search-prev"),
  chatSearchNext: document.getElementById("chat-search-next"),
  chatSearchClose: document.getElementById("chat-search-close"),

  recentToggle: document.getElementById("recent-toggle"),
  recentPanel: document.getElementById("recent-panel"),
  recentList: document.getElementById("recent-list"),

  askForm: document.getElementById("ask-form"),
  questionInput: document.getElementById("question-input"),
  askBtn: document.getElementById("ask-btn"),

  dialogOverlay: document.getElementById("dialog-overlay"),
  dialogConfirm: document.getElementById("dialog-confirm"),
  dialogCancel: document.getElementById("dialog-cancel"),

  paletteBtn: document.getElementById("command-palette-btn"),
  paletteOverlay: document.getElementById("palette-overlay"),
  paletteInput: document.getElementById("palette-input"),
  paletteList: document.getElementById("palette-list"),

  shortcutsBtn: document.getElementById("shortcuts-btn"),
  shortcutsOverlay: document.getElementById("shortcuts-overlay"),
  shortcutsClose: document.getElementById("shortcuts-close"),

  toastStack: document.getElementById("toast-stack"),
};

/* ---------------------------------------------------------------------- *
 * Utils
 * ---------------------------------------------------------------------- */
// Escapes text for safe use in BOTH HTML content and double-quoted HTML
// attributes. A textContent->innerHTML DOM round-trip is not enough here:
// the HTML text-node serialization algorithm does not escape `"` or `'`
// (they're only unsafe inside attributes), and this app interpolates
// escaped, attacker-influenced strings (PDF filenames) directly into
// double-quoted attributes like title="..." and aria-label="..." — an
// unescaped quote there would break out of the attribute.
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const TOAST_LIFE_MS = 4000;

function showToast(message, { type = "default" } = {}) {
  const toast = document.createElement("div");
  toast.className = `toast${type !== "default" ? ` toast-${type}` : ""}`;
  toast.style.setProperty("--toast-life", `${TOAST_LIFE_MS}ms`);
  toast.innerHTML = `<span>${escapeHtml(message)}</span><span class="toast-life"></span>`;
  el.toastStack.appendChild(toast);
  setTimeout(() => {
    toast.classList.add("toast-out");
    setTimeout(() => toast.remove(), 200);
  }, TOAST_LIFE_MS);
}

/* ---------------------------------------------------------------------- *
 * Theme
 * ---------------------------------------------------------------------- */
function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.setAttribute("data-theme", theme);
}

function initTheme() {
  // Dark (black/navy) is the app's primary look — light is an explicit opt-out
  // via the toggle, not something the OS preference should override on load.
  applyTheme("dark");
}

function toggleTheme() {
  applyTheme(state.theme === "dark" ? "light" : "dark");
  el.themeToggle.classList.remove("spin");
  void el.themeToggle.offsetWidth; // restart the animation on repeated clicks
  el.themeToggle.classList.add("spin");
}

/* ---------------------------------------------------------------------- *
 * Status / connectivity
 * ---------------------------------------------------------------------- */
function updateOfflineBanner() {
  if (state.backendOnline === false) {
    el.offlineBanner.hidden = false;
    el.offlineBannerText.textContent = STRINGS.offlineBanner;
  } else if (state.llmOffline) {
    el.offlineBanner.hidden = false;
    el.offlineBannerText.textContent = STRINGS.llmOfflineBanner;
  } else {
    el.offlineBanner.hidden = true;
  }
}

function setConnection(online) {
  const changed = state.backendOnline !== online;
  state.backendOnline = online;

  el.connDot.classList.toggle("online", online === true);
  el.connDot.classList.toggle("offline", online === false);
  el.connLabel.textContent = online ? STRINGS.connOnline : online === false ? STRINGS.connOffline : STRINGS.connChecking;

  el.statusBackend.textContent = online ? STRINGS.statusOnline : STRINGS.statusOffline;
  el.statusBackend.className = `tag ${online ? "tag-online" : "tag-offline"}`;

  updateOfflineBanner();

  if (changed && online === true) {
    showToast("Connected to backend.", { type: "success" });
  }
}

async function refreshStatus() {
  const res = await Api.status();
  if (!res.ok) {
    setConnection(false);
    el.statusChunks.textContent = "–";
    return;
  }
  setConnection(true);
  const previousChunks = state.chunksIndexed;
  state.chunksIndexed = res.data.chunks_indexed;
  el.statusChunks.textContent = res.data.chunks_indexed;

  // /status is public, so it can't tell us whether our token is still good.
  // A signed-in client also asks /me on each poll: if an admin changed this
  // account's role (or the token expired) the API answers 401 and the
  // unauthorized handler signs us out and says why — even while idle.
  if (state.username) {
    await Api.me();
    // The visible chunk count moved (someone uploaded, or an Admin changed a level): refresh the list.
    if (previousChunks !== null && previousChunks !== res.data.chunks_indexed) loadDocuments();
  }
}

/* ---------------------------------------------------------------------- *
 * Session document list
 * ---------------------------------------------------------------------- */
function renderDocList() {
  el.statusDocs.textContent = state.documents.length;
  el.docFilter.hidden = state.documents.length < DOC_FILTER_MIN_DOCS;
  if (el.docFilter.hidden) el.docFilter.value = "";

  if (state.documents.length === 0) {
    el.docList.innerHTML = "";
    el.docEmpty.textContent = state.username ? STRINGS.noDocsForRole : STRINGS.noDocsSignedOut;
    el.docList.appendChild(el.docEmpty);
    return;
  }

  const canEdit = hasRole("Admin"); // only Admins may change who sees a document
  el.docList.innerHTML = state.documents
    .map(
      (doc) => `
      <li class="doc-item" data-name="${escapeHtml(doc.name.toLowerCase())}">
        <svg class="doc-item-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true">
          <path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="1.4"/>
          <path d="M14 3v4h4" stroke="currentColor" stroke-width="1.4"/>
        </svg>
        <span class="doc-item-name" title="${escapeHtml(doc.name)}">${escapeHtml(doc.name)}</span>
        <span class="doc-item-chunks" title="Who can see this document">${doc.chunks} chunks · ${escapeHtml(LEVEL_LABELS[doc.minRole] || doc.minRole)}</span>
        ${
          canEdit
            ? `<button type="button" class="icon-btn icon-btn-sm doc-level-btn" data-hash="${escapeHtml(doc.file_hash)}" aria-label="Change who can see ${escapeHtml(doc.name)}" title="Change who can see this">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true"><path d="M5 19l1-4L16.5 4.5a2 2 0 0 1 3 3L9 18l-4 1Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>
              </button>`
            : ""
        }
      </li>`
    )
    .join("");

  el.docList.querySelectorAll(".doc-level-btn").forEach((btn) => {
    btn.addEventListener("click", () => openDocLevelDialog(btn.dataset.hash));
  });
  applyDocFilter();
}

function applyDocFilter() {
  const query = el.docFilter.value.trim().toLowerCase();
  el.docList.querySelectorAll(".doc-item").forEach((li) => {
    li.classList.toggle("filtered-out", query.length > 0 && !li.dataset.name.includes(query));
  });
}

/** Fetches the documents this role may see. A 401 is handled globally (sign-out). */
async function loadDocuments() {
  if (!state.username) {
    state.documents = [];
    renderDocList();
    return;
  }
  const res = await Api.listDocuments();
  if (!state.username || !res.ok) return; // signed out meanwhile, or keep the list we have
  state.documents = res.data.map((d) => ({
    file_hash: d.file_hash,
    name: d.source_file,
    chunks: d.chunks,
    minRole: d.min_role,
  }));
  renderDocList();
}

/* ---------------------------------------------------------------------- *
 * Upload
 * ---------------------------------------------------------------------- */
function validateFile(file) {
  if (!file.name.toLowerCase().endsWith(".pdf")) {
    return STRINGS.uploadOnlyPdf;
  }
  if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
    return STRINGS.uploadTooLarge(MAX_FILE_SIZE_MB);
  }
  return null;
}

function uploadErrorMessage(res) {
  if (res.status === 0) return STRINGS.uploadNetworkError;
  if (res.status === 409) return STRINGS.uploadDuplicate;
  if (res.status === 403) return STRINGS.uploadForbidden;
  if (res.status === 423) return STRINGS.uploadPasswordProtected;
  if (res.status === 413) return STRINGS.uploadTooLarge(MAX_FILE_SIZE_MB);
  if (res.status === 400) return res.message || STRINGS.uploadGenericError;
  return res.message || STRINGS.uploadGenericError;
}

function createUploadCard(file) {
  const li = document.createElement("li");
  li.className = "upload-item";
  li.innerHTML = `
    <div class="upload-item-row">
      <span class="upload-item-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
      <span class="upload-item-meta">${formatBytes(file.size)}</span>
      <button type="button" class="upload-item-cancel" aria-label="Cancel upload of ${escapeHtml(file.name)}" title="Cancel upload">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
      </button>
    </div>
    <div class="upload-item-status status-uploading">Uploading…</div>
    <div class="upload-item-bar"><div class="upload-item-bar-fill"></div></div>
  `;
  el.uploadQueue.prepend(li);
  return {
    root: li,
    statusEl: li.querySelector(".upload-item-status"),
    barEl: li.querySelector(".upload-item-bar-fill"),
    barContainer: li.querySelector(".upload-item-bar"),
    cancelBtn: li.querySelector(".upload-item-cancel"),
    xhr: null,
  };
}

async function uploadFile(file) {
  const validationError = validateFile(file);
  if (validationError) {
    showToast(`"${file.name}": ${validationError}`, { type: "error" });
    return;
  }

  const card = createUploadCard(file);
  card.cancelBtn.addEventListener("click", () => {
    if (card.xhr) card.xhr.abort();
  });

  const res = await Api.upload(file, {
    minRole: el.uploadLevel.value,
    onProgress: (pct) => {
      card.barEl.style.width = `${pct}%`;
    },
    onXhrReady: (xhr) => {
      card.xhr = xhr;
    },
  });

  card.barContainer.remove();
  card.cancelBtn.remove(); // upload has settled one way or another — nothing left to cancel

  if (res.ok) {
    card.statusEl.textContent = "Indexed";
    card.statusEl.className = "upload-item-status status-ok";
    await loadDocuments();
    showToast(STRINGS.uploadSuccess(res.data.filename, res.data.chunks_added), { type: "success" });
    await refreshStatus();
  } else if (res.cancelled) {
    card.statusEl.textContent = "Cancelled";
    card.statusEl.className = "upload-item-status status-cancelled";
  } else {
    const message = uploadErrorMessage(res);
    card.statusEl.textContent = message;
    card.statusEl.className = "upload-item-status status-error";
    showToast(`"${file.name}": ${message}`, { type: "error" });
  }
}

function handleFiles(fileList) {
  if (!hasRole("Staff")) {
    showToast(STRINGS.uploadForbidden, { type: "error" });
    return;
  }
  const files = Array.from(fileList);
  files.forEach((file) => uploadFile(file));
}

/* ---------------------------------------------------------------------- *
 * Chat / ask
 * ---------------------------------------------------------------------- */
function autoGrowTextarea() {
  el.questionInput.style.height = "auto";
  el.questionInput.style.height = `${Math.min(el.questionInput.scrollHeight, 160)}px`;
}

function hideEmptyState() {
  if (el.emptyState.isConnected) el.emptyState.remove();
}

/* ---------------------------------------------------------------------- *
 * Auth + roles — the API issues a signed token at /login and enforces roles
 * on every route (Guest < Staff < Admin). Hiding or disabling controls below
 * is only a convenience: the API is the real gate, so a tampered page still
 * gets 401/403 back.
 *
 * The token lives in localStorage so a refresh doesn't sign you out. It
 * expires on its own, and is invalidated early when an admin changes this
 * account's role — the next /me poll then gets a 401 and signs us out.
 * Signing out here just discards the token on this device.
 * ---------------------------------------------------------------------- */
const COMPOSER_PLACEHOLDER = el.questionInput.placeholder;

function hasRole(minimum) {
  return state.role !== null && ROLE_LEVELS[state.role] >= ROLE_LEVELS[minimum];
}

function updateComposerState() {
  const enabled = !!state.username && !state.asking;
  el.questionInput.disabled = !enabled;
  el.askBtn.disabled = !enabled;
  el.questionInput.placeholder = state.username ? COMPOSER_PLACEHOLDER : STRINGS.loginRequired;
}

/** Shows or hides controls according to the signed-in role. */
function applyRoleToUI() {
  const canUpload = hasRole("Staff");
  el.dropzone.hidden = !canUpload;
  el.uploadLevelRow.hidden = !canUpload;

  // You can only share a document with roles up to your own: a Staff user
  // can't pick "Admin only" (the API refuses it too). While signed out the
  // control is hidden and left untouched, so its default isn't lost.
  if (state.role) {
    const myLevel = ROLE_LEVELS[state.role];
    Array.from(el.uploadLevel.options).forEach((opt) => {
      const allowed = ROLE_LEVELS[opt.value] <= myLevel;
      opt.disabled = !allowed;
      opt.hidden = !allowed;
    });
    const current = el.uploadLevel.value;
    if (!current || ROLE_LEVELS[current] > myLevel) {
      el.uploadLevel.value = myLevel >= ROLE_LEVELS.Staff ? "Staff" : "Guest";
    }
  }
  el.uploadRoleNote.hidden = canUpload || !state.username;
  el.uploadRoleNote.textContent = state.role ? STRINGS.uploadRoleNote(state.role) : "";
  el.resetBtn.hidden = !hasRole("Admin");
  updateComposerState();
}

function renderAccountArea() {
  if (state.username) {
    el.accountArea.innerHTML = `
      <span class="account-username mono">${escapeHtml(state.username)}</span>
      <span class="tag">${escapeHtml(state.role)}</span>
      ${hasRole("Admin") ? '<button class="btn btn-ghost" id="admin-btn" type="button">Manage users</button>' : ""}
      <button class="icon-btn" id="signout-btn" type="button" aria-label="Sign out" title="Sign out">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true"><path d="M15 17.5V19a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v1.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M10 12h11M17.5 8.5 21 12l-3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>`;
    document.getElementById("signout-btn").addEventListener("click", logoutFlow);
    const adminBtn = document.getElementById("admin-btn");
    if (adminBtn) adminBtn.addEventListener("click", openAdminDialog);
  } else {
    el.accountArea.innerHTML = `<button class="btn btn-ghost" id="signin-btn" type="button">${STRINGS.signIn}</button>`;
    document.getElementById("signin-btn").addEventListener("click", () => openAuthDialog());
  }
  applyRoleToUI();
}

/** Opens the sign-in dialog. `message` (optional) is shown above the button —
 *  used to explain why we're asking, e.g. an expired session. */
function openAuthDialog(message = null) {
  el.authForm.reset();
  el.authError.textContent = message || "";
  el.authError.hidden = !message;
  openOverlay(el.authOverlay, el.authUsername);
}

async function submitAuthForm(e) {
  e.preventDefault();
  const username = el.authUsername.value.trim();
  const password = el.authPassword.value;

  if (!username || !password) {
    el.authError.textContent = STRINGS.enterCredentials;
    el.authError.hidden = false;
    return;
  }

  el.authSubmit.disabled = true;
  el.authError.hidden = true;

  const res = await Api.login(username, password);
  el.authSubmit.disabled = false;

  if (!res.ok) {
    el.authError.textContent = res.message || STRINGS.authGenericError;
    el.authError.hidden = false;
    return;
  }

  closeOverlay(el.authOverlay, el.questionInput);
  await applyLogin(res.data.access_token, res.data.username, res.data.role);
  showToast(STRINGS.signedInAs(`${res.data.username} (${res.data.role})`), { type: "success" });
}

async function applyLogin(token, username, role) {
  state.username = username;
  state.role = role;
  localStorage.setItem(AUTH_TOKEN_KEY, token);
  Api.setToken(token);
  renderAccountArea();
  await loadConversationsForSession();
  await loadDocuments();
}

/** Forgets the session on this device (no server round trip — tokens are stateless). */
function clearSession() {
  Api.setToken(null);
  localStorage.removeItem(AUTH_TOKEN_KEY);
  state.username = null;
  state.role = null;
  state.documents = []; // the list belonged to the account that just left
  renderAccountArea();
  renderDocList();
}

async function logoutFlow() {
  clearSession();
  state.conversations = [];
  await createConversation(); // fresh, empty transcript — nothing carries over to the next person
  showToast(STRINGS.signedOut);
  openAuthDialog();
}

/** The API said our token is no longer valid (expired, or an admin changed our
 *  role). Sign out, then ask the user to sign in again with the reason. */
async function handleSessionExpired(message) {
  if (!state.username) return; // several requests can 401 at once — handle the first only
  clearSession();
  state.conversations = [];
  await createConversation();
  openAuthDialog(message || STRINGS.sessionExpired);
}

/** Restores a saved session on load. `notice` explains a rejected saved session. */
async function initAuth() {
  const stored = localStorage.getItem(AUTH_TOKEN_KEY);
  if (!stored) return { signedIn: false, notice: null };

  Api.setToken(stored);
  const res = await Api.me();
  if (res.ok) {
    state.username = res.data.username;
    state.role = res.data.role;
    renderAccountArea();
    return { signedIn: true, notice: null };
  }

  Api.setToken(null);
  if (res.status === 401) {
    // Expired, or the role changed since this token was issued — it's dead for good.
    localStorage.removeItem(AUTH_TOKEN_KEY);
    return { signedIn: false, notice: res.message };
  }
  // Backend unreachable: keep the token so a reload once it's back can restore the session.
  return { signedIn: false, notice: null };
}

/** Opens a transcript for the current session — saved ones if sync is on, else a fresh one. */
async function loadConversationsForSession() {
  if (SYNC_CONVERSATIONS && state.username) await loadRemoteConversations();
  else await createConversation();
}

/* ---------------------------------------------------------------------- *
 * Document level — an Admin chooses which role may see one document.
 * ---------------------------------------------------------------------- */
function openDocLevelDialog(fileHash) {
  const doc = state.documents.find((d) => d.file_hash === fileHash);
  if (!doc || !hasRole("Admin")) return;
  state.editingDocHash = fileHash;
  el.docLevelName.textContent = doc.name;
  el.docLevelSelect.value = doc.minRole;
  el.docLevelError.hidden = true;
  openOverlay(el.docLevelOverlay, el.docLevelSelect);
}

function closeDocLevelDialog() {
  closeOverlay(el.docLevelOverlay, el.accountArea);
  state.editingDocHash = null;
}

async function submitDocLevel(e) {
  e.preventDefault();
  const doc = state.documents.find((d) => d.file_hash === state.editingDocHash);
  if (!doc) return;
  const level = el.docLevelSelect.value;

  el.docLevelSave.disabled = true;
  el.docLevelError.hidden = true;
  const res = await Api.setDocumentLevel(doc.file_hash, level);
  el.docLevelSave.disabled = false;

  if (!res.ok) {
    el.docLevelError.textContent = res.status === 403 ? STRINGS.forbiddenGeneric : res.message || STRINGS.docLevelFailed;
    el.docLevelError.hidden = false;
    return;
  }
  closeDocLevelDialog();
  showToast(STRINGS.docLevelSaved(doc.name, LEVEL_LABELS[level]), { type: "success" });
  await loadDocuments();
}

/* ---------------------------------------------------------------------- *
 * Admin — create accounts and change roles. Only offered to Admins here, and
 * the API rejects everyone else with 403 regardless of what this page shows.
 * ---------------------------------------------------------------------- */
function clearAdminMessages() {
  el.adminError.hidden = true;
  el.adminSuccess.hidden = true;
}

function showAdminMessage(text, isError) {
  clearAdminMessages();
  const target = isError ? el.adminError : el.adminSuccess;
  target.textContent = text;
  target.hidden = false;
}

function openAdminDialog() {
  if (!hasRole("Admin")) {
    showToast(STRINGS.forbiddenGeneric, { type: "error" });
    return;
  }
  el.adminCreateForm.reset();
  el.adminRoleForm.reset();
  clearAdminMessages();
  openOverlay(el.adminOverlay, el.adminNewUsername);
}

function closeAdminDialog() {
  closeOverlay(el.adminOverlay, el.accountArea);
}

async function submitAdminCreate(e) {
  e.preventDefault();
  const username = el.adminNewUsername.value.trim();
  const password = el.adminNewPassword.value;
  const role = el.adminNewRole.value;

  if (!username || !password) {
    showAdminMessage(STRINGS.enterCredentials, true);
    return;
  }

  el.adminCreateSubmit.disabled = true;
  const res = await Api.createUser(username, password, role);
  el.adminCreateSubmit.disabled = false;

  if (!res.ok) {
    showAdminMessage(res.status === 403 ? STRINGS.forbiddenGeneric : res.message || STRINGS.authGenericError, true);
    return;
  }
  el.adminCreateForm.reset();
  showAdminMessage(STRINGS.userCreated(res.data.username, res.data.role), false);
}

async function submitAdminRole(e) {
  e.preventDefault();
  const username = el.adminRoleUsername.value.trim();
  const newRole = el.adminRoleSelect.value;

  if (!username) {
    showAdminMessage("Enter the username to change.", true);
    return;
  }

  el.adminRoleSubmit.disabled = true;
  const res = await Api.changeRole(username, newRole);
  el.adminRoleSubmit.disabled = false;

  if (!res.ok) {
    showAdminMessage(res.status === 403 ? STRINGS.forbiddenGeneric : res.message || STRINGS.authGenericError, true);
    return;
  }
  el.adminRoleForm.reset();
  showAdminMessage(STRINGS.roleChanged(res.data.username, res.data.new_role), false);
}

/* ---------------------------------------------------------------------- *
 * Conversations — multiple separate transcripts, all querying the SAME
 * shared document store (api.py has no per-conversation document scoping,
 * so "new chat" means a fresh transcript, not a fresh document context).
 * Guest transcripts are session-only, same as before; signed-in accounts
 * get theirs synced to the server (see /conversations in api.py) so they
 * survive a reload or a return visit. As a guest it's session state like
 * everything else, and "Clear documents when I close the tab" has no
 * bearing on it either way — that toggle only ever touches documents.
 * ---------------------------------------------------------------------- */
let conversationSeq = 0;

function conversationTitleFrom(question) {
  const trimmed = question.trim();
  return trimmed.length > 46 ? `${trimmed.slice(0, 46)}…` : trimmed;
}

function getActiveConversation() {
  return state.conversations.find((c) => c.id === state.activeConversationId) || null;
}

function replayConversation(conv) {
  el.chat.innerHTML = "";
  if (!conv || conv.messages.length === 0) {
    el.chat.appendChild(el.emptyState);
    return;
  }
  conv.messages.forEach((m) => {
    if (m.role === "user") {
      addUserMessage(m.text, new Date(m.time));
      return;
    }
    const row = addThinkingMessage();
    renderAssistantMessage(row, {
      question: m.question,
      answer: m.answer,
      sources: m.sources || [],
      isError: m.isError,
      time: new Date(m.time),
    });
  });
  scrollChatToBottom();
}

/** Server message rows use `text` for both roles (user text / assistant
 *  answer); the client shape used everywhere else in this file splits that
 *  into `text` (user) vs `answer` (assistant) — this is the one seam
 *  between them. */
function fromServerMessage(m) {
  return m.role === "user"
    ? { role: "user", text: m.text, time: m.time }
    : { role: "assistant", question: m.question, answer: m.text, sources: m.sources || [], isError: m.isError, time: m.time };
}

async function activateConversation(id) {
  state.activeConversationId = id;
  const conv = getActiveConversation();
  el.activeConversationTitle.textContent = conv ? conv.title : STRINGS.defaultConversationTitle;
  closeChatSearch();

  if (conv && conv.remote && !conv.messagesLoaded) {
    const res = await Api.getConversation(conv.id);
    if (res.ok) {
      conv.title = res.data.title;
      conv.messages = res.data.messages.map(fromServerMessage);
      el.activeConversationTitle.textContent = conv.title;
    } else {
      showToast(STRINGS.couldntLoadConversations, { type: "error" });
    }
    conv.messagesLoaded = true;
  }

  replayConversation(conv);
  renderConversationList();
}

async function createConversation() {
  conversationSeq++;
  let conv;

  if (SYNC_CONVERSATIONS && state.username) {
    const res = await Api.createConversation();
    conv = res.ok
      ? { id: res.data.id, title: res.data.title, messages: [], questionCount: 0, messagesLoaded: true, remote: true }
      : null;
    if (!conv) showToast("Couldn't start a synced chat — continuing locally only.", { type: "error" });
  }
  if (!conv) {
    conv = { id: `local-${Date.now()}-${conversationSeq}`, title: STRINGS.defaultConversationTitle, messages: [], questionCount: 0, messagesLoaded: true, remote: false };
  }

  state.conversations.unshift(conv);
  await activateConversation(conv.id);
  return conv;
}

async function switchConversation(id) {
  if (id !== state.activeConversationId) await activateConversation(id);
  hideConversationPanel();
}

async function deleteConversation(id) {
  const idx = state.conversations.findIndex((c) => c.id === id);
  if (idx === -1) return;
  const conv = state.conversations[idx];
  const wasActive = id === state.activeConversationId;
  state.conversations.splice(idx, 1);

  if (conv.remote) Api.deleteConversationRemote(id); // fire-and-forget — UI already reflects the deletion

  if (state.conversations.length === 0) await createConversation();
  else if (wasActive) await activateConversation(state.conversations[0].id);
  else renderConversationList();
}

function renderConversationList() {
  el.conversationList.innerHTML = state.conversations
    .map((c) => {
      const active = c.id === state.activeConversationId;
      const count = c.messagesLoaded ? c.messages.filter((m) => m.role === "user").length : c.questionCount;
      return `
      <li class="conv-item${active ? " active" : ""}">
        <button type="button" class="conv-item-select" data-id="${c.id}">
          <span class="conv-item-title">${escapeHtml(c.title)}</span>
          <span class="conv-item-meta">${count} question${count === 1 ? "" : "s"}</span>
        </button>
        <button type="button" class="conv-item-delete" data-id="${c.id}" aria-label="Delete conversation: ${escapeHtml(c.title)}" title="Delete conversation">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true"><path d="M5 6h14M9 6V4h6v2M7 6l1 14h8l1-14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </li>`;
    })
    .join("");

  el.conversationList.querySelectorAll(".conv-item-select").forEach((btn) => {
    btn.addEventListener("click", () => switchConversation(btn.dataset.id));
  });
  el.conversationList.querySelectorAll(".conv-item-delete").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteConversation(btn.dataset.id);
    });
  });
}

/** Fetches the signed-in user's saved conversations and opens the most
 *  recent one (or starts a fresh one if they have none yet). */
async function loadRemoteConversations() {
  const res = await Api.listConversations();
  if (!res.ok) {
    showToast(STRINGS.couldntLoadConversations, { type: "error" });
    await createConversation();
    return;
  }

  state.conversations = res.data.map((c) => ({
    id: c.id,
    title: c.title,
    messages: [],
    questionCount: c.question_count,
    messagesLoaded: false,
    remote: true,
  }));

  if (state.conversations.length === 0) await createConversation();
  else await activateConversation(state.conversations[0].id);
}

function showConversationPanel() {
  hideRecentPanel(); // only one floating panel open at a time
  el.conversationPanel.hidden = false;
  el.conversationSwitcher.setAttribute("aria-expanded", "true");
}

function hideConversationPanel() {
  el.conversationPanel.hidden = true;
  el.conversationSwitcher.setAttribute("aria-expanded", "false");
}

function toggleConversationPanel() {
  if (el.conversationPanel.hidden) showConversationPanel();
  else hideConversationPanel();
}

/** Starts a fresh transcript. Previous conversations stay in the list — only
 *  the indexed documents are shared, never wiped, by this action. */
async function startNewConversation() {
  hideRecentPanel();
  hideConversationPanel();
  await createConversation();
  showToast(STRINGS.newConversationStarted);
}

function updateScrollBottomButton() {
  const distanceFromBottom = el.chat.scrollHeight - el.chat.scrollTop - el.chat.clientHeight;
  el.scrollBottomBtn.hidden = distanceFromBottom < 120;
}

function scrollChatToBottom(smooth = false) {
  el.chat.scrollTo({ top: el.chat.scrollHeight, behavior: smooth ? "smooth" : "auto" });
}

function renderExamplePrompts() {
  el.examplePrompts.innerHTML = STRINGS.examplePrompts
    .map((prompt) => `<button type="button" class="example-prompt">${escapeHtml(prompt)}</button>`)
    .join("");
  el.examplePrompts.querySelectorAll(".example-prompt").forEach((btn, i) => {
    btn.addEventListener("click", () => {
      el.questionInput.value = STRINGS.examplePrompts[i];
      el.questionInput.focus();
      autoGrowTextarea();
    });
  });
}

/* ---------------------------------------------------------------------- *
 * Recent questions
 * ---------------------------------------------------------------------- */
function renderRecentQuestions() {
  el.recentToggle.hidden = state.recentQuestions.length === 0;
  el.recentList.innerHTML = state.recentQuestions
    .map((q, i) => `<li><button type="button" data-index="${i}" title="${escapeHtml(q)}">${escapeHtml(q)}</button></li>`)
    .join("");
  el.recentList.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      el.questionInput.value = state.recentQuestions[Number(btn.dataset.index)];
      hideRecentPanel();
      el.questionInput.focus();
      autoGrowTextarea();
    });
  });
}

function showRecentPanel() {
  hideConversationPanel(); // only one floating panel open at a time
  el.recentPanel.hidden = false;
}

function hideRecentPanel() {
  el.recentPanel.hidden = true;
}

function toggleRecentPanel() {
  if (el.recentPanel.hidden) showRecentPanel();
  else hideRecentPanel();
}

function addUserMessage(question, time = new Date()) {
  hideEmptyState();
  const row = document.createElement("div");
  row.className = "msg-row msg-row-user";
  row.innerHTML = `
    <div class="msg msg-user">
      <div class="msg-bubble">${escapeHtml(question)}</div>
      <div class="msg-meta"><span>${formatTime(time)}</span></div>
    </div>
    <span class="avatar avatar-user" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none"><circle cx="12" cy="8.5" r="3.2" stroke="currentColor" stroke-width="1.6"/><path d="M5 19.5c1.3-3.4 4-5 7-5s5.7 1.6 7 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
    </span>
  `;
  el.chat.appendChild(row);
  scrollChatToBottom();
  return row;
}

function addThinkingMessage() {
  const row = document.createElement("div");
  row.className = "msg-row msg-row-assistant";
  row.innerHTML = `
    <span class="avatar avatar-assistant" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none"><rect x="4" y="4" width="16" height="16" rx="4" stroke="currentColor" stroke-width="1.6"/><path d="M9 10.5v.01M15 10.5v.01M8.5 15c1 .9 2.2 1.3 3.5 1.3s2.5-.4 3.5-1.3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
    </span>
    <div class="msg msg-assistant">
      <div class="msg-bubble refusal">
        <span class="thinking"><span></span><span></span><span></span></span>
      </div>
    </div>
  `;
  el.chat.appendChild(row);
  scrollChatToBottom();
  return row.querySelector(".msg-assistant");
}

function isRefusal(answer) {
  return answer === STRINGS.askRefusalNotFound || answer === STRINGS.askRefusalNoDocs;
}

function renderAssistantMessage(thinkingMsg, { question, answer, sources = [], isError = false, time = new Date() }) {
  const bubbleClass = isError ? "error" : isRefusal(answer) ? "refusal" : "";
  const sourcesHtml =
    sources.length > 0
      ? `<div class="sources">${sources
          .map((s) => {
            const pct = Math.max(0, Math.min(100, Math.round(s.relevance * 100)));
            const citation = `${s.file}, page ${s.page}`;
            return `<span class="source-chip" title="Cosine relevance to your question: ${s.relevance}">
              <button type="button" class="chip-copy" data-cite="${encodeURIComponent(citation)}" aria-label="Copy citation: ${escapeHtml(citation)}">
                <svg viewBox="0 0 24 24" width="10" height="10" fill="none" aria-hidden="true"><rect x="7" y="7" width="11" height="11" rx="1.3" stroke="currentColor" stroke-width="1.6"/><path d="M4.5 14V5.5a1 1 0 0 1 1-1H14" stroke="currentColor" stroke-width="1.6"/></svg>
              </button>
              ${escapeHtml(s.file)} · p${s.page}
              <span class="relevance-bar"><span class="relevance-bar-fill" style="width:${pct}%"></span></span>
              <span class="relevance">${s.relevance}</span>
            </span>`;
          })
          .join("")}</div>`
      : "";

  thinkingMsg.innerHTML = `
    <div class="msg-bubble${bubbleClass ? ` ${bubbleClass}` : ""}">${escapeHtml(answer)}</div>
    ${sourcesHtml}
    <div class="msg-meta">
      <span>${formatTime(time)}</span>
      ${
        !isError
          ? `<button type="button" class="msg-copy" data-copy="${encodeURIComponent(answer)}" aria-label="${STRINGS.copyAnswer} answer">
               <svg viewBox="0 0 24 24" width="12" height="12" fill="none" aria-hidden="true">
                 <rect x="8" y="8" width="12" height="12" rx="1.5" stroke="currentColor" stroke-width="1.5"/>
                 <path d="M5 16V5a1 1 0 0 1 1-1h11" stroke="currentColor" stroke-width="1.5"/>
               </svg>
             </button>`
          : ""
      }
      <button type="button" class="msg-reask" data-question="${encodeURIComponent(question)}" aria-label="Ask this question again" title="Ask again">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" aria-hidden="true">
          <path d="M4 12a8 8 0 1 1 2.6 5.9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
          <path d="M4 17.5V13h4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    </div>
  `;

  const copyBtn = thinkingMsg.querySelector(".msg-copy");
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(decodeURIComponent(copyBtn.dataset.copy));
        copyBtn.setAttribute("aria-label", STRINGS.copied);
        showToast(STRINGS.copied);
      } catch {
        showToast("Couldn't copy to clipboard.", { type: "error" });
      }
    });
  }

  thinkingMsg.querySelectorAll(".chip-copy").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(decodeURIComponent(btn.dataset.cite));
        showToast(STRINGS.citationCopied);
      } catch {
        showToast("Couldn't copy to clipboard.", { type: "error" });
      }
    });
  });

  thinkingMsg.querySelector(".msg-reask").addEventListener("click", (e) => {
    if (state.asking) return;
    submitQuestion(decodeURIComponent(e.currentTarget.dataset.question));
  });

  scrollChatToBottom();
}

function askErrorMessage(res) {
  if (res.status === 0) return STRINGS.uploadNetworkError;
  if (res.status === 400) return res.message || STRINGS.askNoDocuments;
  if (res.status === 403) return STRINGS.forbiddenGeneric;
  if (res.status === 502) {
    state.llmOffline = true;
    updateOfflineBanner();
    return STRINGS.askLlmUnreachable;
  }
  return res.message || STRINGS.askGenericError;
}

function addRecentQuestion(question) {
  state.recentQuestions = [question, ...state.recentQuestions.filter((q) => q !== question)].slice(0, RECENT_QUESTIONS_MAX);
  renderRecentQuestions();
}

async function submitQuestion(question) {
  if (state.asking) return;
  if (!state.username) {
    openAuthDialog();
    return;
  }
  state.asking = true;
  el.askBtn.disabled = true;
  el.questionInput.disabled = true;
  hideRecentPanel();
  hideConversationPanel();

  const conv = getActiveConversation();
  const userTime = new Date();
  addUserMessage(question, userTime);
  const thinkingMsg = addThinkingMessage();
  addRecentQuestion(question);

  if (conv) {
    conv.messages.push({ role: "user", text: question, time: userTime.toISOString() });
    if (conv.title === STRINGS.defaultConversationTitle) {
      conv.title = conversationTitleFrom(question);
      el.activeConversationTitle.textContent = conv.title;
    }
    renderConversationList();
  }

  state.questionsAsked++;
  el.statusQuestions.textContent = state.questionsAsked;

  const res = await Api.ask(question, state.topK, conv && conv.remote ? conv.id : null);
  const answerTime = new Date();

  let record;
  if (res.ok) {
    if (state.llmOffline) {
      state.llmOffline = false;
      updateOfflineBanner();
    }
    renderAssistantMessage(thinkingMsg, { question, answer: res.data.answer, sources: res.data.sources || [], time: answerTime });
    record = { role: "assistant", question, answer: res.data.answer, sources: res.data.sources || [], isError: false, time: answerTime.toISOString() };
  } else {
    const message = askErrorMessage(res);
    renderAssistantMessage(thinkingMsg, { question, answer: message, isError: true, time: answerTime });
    record = { role: "assistant", question, answer: message, sources: [], isError: true, time: answerTime.toISOString() };
  }
  if (conv) conv.messages.push(record);

  state.asking = false;
  updateComposerState(); // stays disabled if we were signed out mid-question
  el.questionInput.focus();
}

/* ---------------------------------------------------------------------- *
 * Overlay helpers — shared by the reset-confirm dialog, the command palette,
 * and the shortcuts panel; all three reuse the same .dialog-overlay roll
 * in/out animation.
 * ---------------------------------------------------------------------- */
const DIALOG_CLOSE_MS = 220; // matches .dialog-overlay.closing animation-duration

function openOverlay(overlay, focusEl) {
  // Closing any other open overlay first avoids two roll-in animations
  // stacking if the user fires a shortcut while one is already open.
  document.querySelectorAll(".dialog-overlay:not([hidden])").forEach((o) => {
    if (o !== overlay) o.hidden = true;
  });
  hideRecentPanel();
  hideConversationPanel();
  overlay.classList.remove("closing");
  overlay.hidden = false;
  if (focusEl) focusEl.focus();
}

function closeOverlay(overlay, focusBackEl) {
  if (overlay.hidden) return; // already closed, nothing to animate
  overlay.classList.add("closing");
  setTimeout(() => {
    overlay.hidden = true;
    overlay.classList.remove("closing");
  }, DIALOG_CLOSE_MS);
  if (focusBackEl) focusBackEl.focus();
}

function anyOverlayOpen() {
  return !el.dialogOverlay.hidden || !el.paletteOverlay.hidden || !el.shortcutsOverlay.hidden || !el.authOverlay.hidden || !el.adminOverlay.hidden || !el.docLevelOverlay.hidden;
}

function closeTopOverlay() {
  if (!el.paletteOverlay.hidden) closeOverlay(el.paletteOverlay, el.paletteBtn);
  else if (!el.shortcutsOverlay.hidden) closeOverlay(el.shortcutsOverlay, el.shortcutsBtn);
  else if (!el.authOverlay.hidden) closeOverlay(el.authOverlay, el.accountArea);
  else if (!el.adminOverlay.hidden) closeAdminDialog();
  else if (!el.docLevelOverlay.hidden) closeDocLevelDialog();
  else if (!el.dialogOverlay.hidden) closeOverlay(el.dialogOverlay, el.resetBtn);
}

/* ---------------------------------------------------------------------- *
 * In-chat search — highlights matches across rendered message bubbles and
 * steps between them. Reads each bubble's plain text via .textContent
 * (which decodes back to the original string regardless of how it was
 * escaped into innerHTML), so no separate raw-text cache is needed.
 * ---------------------------------------------------------------------- */
function clearChatSearchHighlights() {
  document.querySelectorAll(".msg-bubble mark.search-hit").forEach((mark) => {
    const bubble = mark.closest(".msg-bubble");
    if (bubble) bubble.textContent = bubble.textContent; // strips markup, keeps text
  });
  state.chatSearch.marks = [];
  state.chatSearch.currentIndex = -1;
}

function runChatSearch(query) {
  clearChatSearchHighlights();
  const trimmed = query.trim();
  if (!trimmed) {
    el.chatSearchCount.textContent = "";
    return;
  }

  const needle = trimmed.toLowerCase();
  document.querySelectorAll(".msg-bubble").forEach((bubble) => {
    const raw = bubble.textContent;
    const lower = raw.toLowerCase();
    if (!lower.includes(needle)) return;

    let html = "";
    let cursor = 0;
    let idx = lower.indexOf(needle);
    while (idx !== -1) {
      html += escapeHtml(raw.slice(cursor, idx)) + `<mark class="search-hit">${escapeHtml(raw.slice(idx, idx + needle.length))}</mark>`;
      cursor = idx + needle.length;
      idx = lower.indexOf(needle, cursor);
    }
    html += escapeHtml(raw.slice(cursor));
    bubble.innerHTML = html;
  });

  state.chatSearch.marks = Array.from(document.querySelectorAll(".msg-bubble mark.search-hit"));
  state.chatSearch.currentIndex = state.chatSearch.marks.length > 0 ? 0 : -1;
  focusCurrentSearchMatch();
  updateChatSearchCount();
}

function updateChatSearchCount() {
  const { marks, currentIndex } = state.chatSearch;
  el.chatSearchCount.textContent = marks.length === 0 ? STRINGS.noSearchMatches : `${currentIndex + 1}/${marks.length}`;
}

function focusCurrentSearchMatch() {
  const { marks, currentIndex } = state.chatSearch;
  marks.forEach((m) => m.classList.remove("search-hit-current"));
  if (currentIndex < 0 || !marks[currentIndex]) return;
  const mark = marks[currentIndex];
  mark.classList.add("search-hit-current");
  mark.scrollIntoView({ block: "center", behavior: "smooth" });
}

function stepChatSearch(direction) {
  const { marks } = state.chatSearch;
  if (marks.length === 0) return;
  state.chatSearch.currentIndex = (state.chatSearch.currentIndex + direction + marks.length) % marks.length;
  focusCurrentSearchMatch();
  updateChatSearchCount();
}

function openChatSearch() {
  el.chatSearchBar.hidden = false;
  el.chatSearchInput.focus();
  el.chatSearchInput.select();
  state.chatSearch.active = true;
}

function closeChatSearch() {
  el.chatSearchBar.hidden = true;
  el.chatSearchInput.value = "";
  clearChatSearchHighlights();
  el.chatSearchCount.textContent = "";
  state.chatSearch.active = false;
}

function toggleChatSearch() {
  if (state.chatSearch.active) closeChatSearch();
  else openChatSearch();
}

/* ---------------------------------------------------------------------- *
 * Command palette
 * ---------------------------------------------------------------------- */
function paletteCommands() {
  return [
    {
      label: "Upload documents",
      icon: '<path d="M12 4v11M8 8l4-4 4 4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
      run: () => (hasRole("Staff") ? el.fileInput.click() : showToast(STRINGS.uploadForbidden, { type: "error" })),
    },
    {
      label: `Switch to ${state.theme === "dark" ? "light" : "dark"} theme`,
      icon: '<circle cx="12" cy="12" r="4.2" stroke="currentColor" stroke-width="1.6"/>',
      run: () => toggleTheme(),
    },
    {
      label: "New conversation",
      icon: '<path d="M4 19V6a2 2 0 0 1 2-2h9l5 5v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
      run: () => startNewConversation(),
    },
    {
      label: "Search this conversation",
      icon: '<circle cx="10.5" cy="10.5" r="6" stroke="currentColor" stroke-width="1.7"/><path d="M19 19l-4-4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
      run: () => openChatSearch(),
    },
    {
      label: "Focus question box",
      icon: '<path d="M4 19V6a2 2 0 0 1 2-2h9l5 5v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" stroke="currentColor" stroke-width="1.6"/>',
      run: () => el.questionInput.focus(),
    },
    {
      label: "Clear all documents…",
      icon: '<path d="M5 6h14M9 6V4h6v2M7 6l1 14h8l1-14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
      run: () => (hasRole("Admin") ? openDialog() : showToast(STRINGS.resetForbidden, { type: "error" })),
    },
    {
      label: "Show keyboard shortcuts",
      icon: '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6"/>',
      run: () => openOverlay(el.shortcutsOverlay, el.shortcutsClose),
    },
    ...(hasRole("Admin")
      ? [
          {
            label: "Manage users",
            icon: '<circle cx="12" cy="8" r="3.4" stroke="currentColor" stroke-width="1.6"/><path d="M5 20c0-3.6 3-6 7-6s7 2.4 7 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
            run: () => openAdminDialog(),
          },
        ]
      : []),
    state.username
      ? {
          label: `Sign out (${state.username})`,
          icon: '<path d="M15 17.5V19a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v1.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M10 12h11M17.5 8.5 21 12l-3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
          run: () => logoutFlow(),
        }
      : {
          label: "Sign in",
          icon: '<path d="M9 17.5V19a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v1.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M14 12H3M6.5 8.5 3 12l3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
          run: () => openAuthDialog(),
        },
  ];
}

let paletteActiveIndex = 0;
let paletteFiltered = [];

function renderPalette(query) {
  const q = query.trim().toLowerCase();
  paletteFiltered = paletteCommands().filter((c) => c.label.toLowerCase().includes(q));
  paletteActiveIndex = 0;

  if (paletteFiltered.length === 0) {
    el.paletteList.innerHTML = `<li class="palette-empty">No matching commands.</li>`;
    return;
  }

  el.paletteList.innerHTML = paletteFiltered
    .map(
      (c, i) => `
      <li>
        <button type="button" class="palette-item${i === 0 ? " active" : ""}" data-index="${i}">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true">${c.icon}</svg>
          <span>${escapeHtml(c.label)}</span>
        </button>
      </li>`
    )
    .join("");

  el.paletteList.querySelectorAll(".palette-item").forEach((btn) => {
    btn.addEventListener("click", () => runPaletteItem(Number(btn.dataset.index)));
  });
}

function setPaletteActive(index) {
  const items = el.paletteList.querySelectorAll(".palette-item");
  if (items.length === 0) return;
  paletteActiveIndex = (index + items.length) % items.length;
  items.forEach((item, i) => item.classList.toggle("active", i === paletteActiveIndex));
  items[paletteActiveIndex].scrollIntoView({ block: "nearest" });
}

function runPaletteItem(index) {
  const cmd = paletteFiltered[index];
  closeOverlay(el.paletteOverlay, el.paletteBtn);
  if (cmd) cmd.run();
}

function openPalette() {
  openOverlay(el.paletteOverlay, el.paletteInput);
  el.paletteInput.value = "";
  renderPalette("");
}

/* ---------------------------------------------------------------------- *
 * Reset
 * ---------------------------------------------------------------------- */
function openDialog() {
  openOverlay(el.dialogOverlay, el.dialogConfirm);
}

function closeDialog() {
  closeOverlay(el.dialogOverlay, el.resetBtn);
}

async function performReset() {
  el.dialogConfirm.disabled = true;
  const res = await Api.reset();
  el.dialogConfirm.disabled = false;
  closeDialog();

  if (res.ok) {
    state.chunksIndexed = res.data.chunks_indexed;
    el.statusChunks.textContent = res.data.chunks_indexed;
    state.documents = [];
    renderDocList();
    el.uploadQueue.innerHTML = "";
    showToast(STRINGS.resetSuccess, { type: "success" });
  } else {
    showToast(res.status === 403 ? STRINGS.resetForbidden : STRINGS.resetError, { type: "error" });
  }
}

/* ---------------------------------------------------------------------- *
 * Sidebar (mobile)
 * ---------------------------------------------------------------------- */
function toggleSidebar(open) {
  const isOpen = open ?? el.app.dataset.panelOpen !== "true";
  el.app.dataset.panelOpen = String(isOpen);
  el.sidebarToggle.setAttribute("aria-expanded", String(isOpen));
}

/* ---------------------------------------------------------------------- *
 * Event wiring
 * ---------------------------------------------------------------------- */
function initEvents() {
  el.themeToggle.addEventListener("click", toggleTheme);
  el.sidebarToggle.addEventListener("click", () => toggleSidebar());

  el.dropzone.addEventListener("click", () => el.fileInput.click());
  el.dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      el.fileInput.click();
    }
  });
  el.fileInput.addEventListener("change", (e) => {
    handleFiles(e.target.files);
    e.target.value = "";
  });

  ["dragenter", "dragover"].forEach((evt) =>
    el.dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      el.dropzone.classList.add("dragover");
    })
  );
  ["dragleave", "drop"].forEach((evt) =>
    el.dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      el.dropzone.classList.remove("dragover");
    })
  );
  el.dropzone.addEventListener("drop", (e) => handleFiles(e.dataTransfer.files));

  el.questionInput.addEventListener("input", autoGrowTextarea);
  el.questionInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      el.askForm.requestSubmit();
    }
  });

  el.askForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const question = el.questionInput.value.trim();
    if (!question || state.asking) return;
    el.questionInput.value = "";
    autoGrowTextarea();
    submitQuestion(question);
  });

  el.resetBtn.addEventListener("click", openDialog);
  el.dialogCancel.addEventListener("click", closeDialog);
  el.dialogConfirm.addEventListener("click", performReset);
  el.dialogOverlay.addEventListener("click", (e) => {
    if (e.target === el.dialogOverlay) closeDialog();
  });

  el.clearOnCloseToggle.addEventListener("change", (e) => {
    state.clearOnClose = e.target.checked;
  });

  el.topKInput.addEventListener("input", () => {
    state.topK = Number(el.topKInput.value);
    el.topKValue.textContent = state.topK;
  });

  el.docFilter.addEventListener("input", applyDocFilter);

  // New conversation
  el.newChatBtn.addEventListener("click", startNewConversation);

  // Scroll-to-bottom
  el.chat.addEventListener("scroll", updateScrollBottomButton, { passive: true });
  el.scrollBottomBtn.addEventListener("click", () => scrollChatToBottom(true));

  // Recent questions
  el.recentToggle.addEventListener("click", toggleRecentPanel);
  document.addEventListener("click", (e) => {
    if (!el.recentPanel.hidden && !el.recentPanel.contains(e.target) && e.target !== el.recentToggle && !el.recentToggle.contains(e.target)) {
      hideRecentPanel();
    }
  });

  // Conversations
  el.conversationSwitcher.addEventListener("click", toggleConversationPanel);
  el.convPanelNew.addEventListener("click", startNewConversation);
  document.addEventListener("click", (e) => {
    if (!el.conversationPanel.hidden && !el.conversationPanel.contains(e.target) && !el.conversationSwitcher.contains(e.target)) {
      hideConversationPanel();
    }
  });

  // In-chat search
  el.chatSearchToggle.addEventListener("click", toggleChatSearch);
  el.chatSearchInput.addEventListener("input", (e) => runChatSearch(e.target.value));
  el.chatSearchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      stepChatSearch(e.shiftKey ? -1 : 1);
    }
  });
  el.chatSearchPrev.addEventListener("click", () => stepChatSearch(-1));
  el.chatSearchNext.addEventListener("click", () => stepChatSearch(1));
  el.chatSearchClose.addEventListener("click", closeChatSearch);

  // Command palette
  el.paletteBtn.addEventListener("click", openPalette);
  el.paletteInput.addEventListener("input", (e) => renderPalette(e.target.value));
  el.paletteInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setPaletteActive(paletteActiveIndex + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setPaletteActive(paletteActiveIndex - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      runPaletteItem(paletteActiveIndex);
    }
  });
  el.paletteOverlay.addEventListener("click", (e) => {
    if (e.target === el.paletteOverlay) closeOverlay(el.paletteOverlay, el.paletteBtn);
  });

  // Shortcuts help
  el.shortcutsBtn.addEventListener("click", () => openOverlay(el.shortcutsOverlay, el.shortcutsClose));
  el.shortcutsClose.addEventListener("click", () => closeOverlay(el.shortcutsOverlay, el.shortcutsBtn));
  el.shortcutsOverlay.addEventListener("click", (e) => {
    if (e.target === el.shortcutsOverlay) closeOverlay(el.shortcutsOverlay, el.shortcutsBtn);
  });

  // Auth
  el.authForm.addEventListener("submit", submitAuthForm);
  el.adminCreateForm.addEventListener("submit", submitAdminCreate);
  el.adminRoleForm.addEventListener("submit", submitAdminRole);
  el.adminClose.addEventListener("click", closeAdminDialog);
  el.docLevelForm.addEventListener("submit", submitDocLevel);
  el.docLevelCancel.addEventListener("click", closeDocLevelDialog);
  el.docLevelOverlay.addEventListener("click", (e) => {
    if (e.target === el.docLevelOverlay) closeDocLevelDialog();
  });
  el.adminOverlay.addEventListener("click", (e) => {
    if (e.target === el.adminOverlay) closeAdminDialog();
  });
  el.authOverlay.addEventListener("click", (e) => {
    if (e.target === el.authOverlay) closeOverlay(el.authOverlay, el.accountArea);
  });

  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const typingInField = ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName);

    if (mod && e.key.toLowerCase() === "k") {
      e.preventDefault();
      openPalette();
      return;
    }
    if (mod && e.key.toLowerCase() === "f") {
      e.preventDefault();
      openChatSearch();
      return;
    }
    if (e.key === "/" && !typingInField) {
      e.preventDefault();
      el.questionInput.focus();
      return;
    }
    if (e.key === "?" && !typingInField) {
      e.preventDefault();
      openOverlay(el.shortcutsOverlay, el.shortcutsClose);
      return;
    }
    if (e.key === "Escape") {
      if (anyOverlayOpen()) closeTopOverlay();
      else if (state.chatSearch.active) closeChatSearch();
      else if (!el.recentPanel.hidden) hideRecentPanel();
      else if (!el.conversationPanel.hidden) hideConversationPanel();
      else if (el.app.dataset.panelOpen === "true") toggleSidebar(false);
    }
  });

}

/* ---------------------------------------------------------------------- *
 * Init
 * ---------------------------------------------------------------------- */
async function init() {
  initTheme();
  initEvents();

  el.maxSize.textContent = MAX_FILE_SIZE_MB;
  el.clearOnCloseToggle.checked = state.clearOnClose;
  el.topKInput.value = state.topK;
  el.topKValue.textContent = state.topK;
  renderExamplePrompts();
  renderDocList();
  renderRecentQuestions();
  Api.onUnauthorized(handleSessionExpired);
  renderAccountArea(); // signed-out view first; replaced below if a saved session is still valid

  const { signedIn, notice } = await initAuth();
  await loadConversationsForSession();
  if (signedIn) await loadDocuments();
  else openAuthDialog(notice);

  refreshStatus();
  setInterval(refreshStatus, STATUS_POLL_MS);
}

init();
/**
 * api.js — thin wrapper around the doc_rag FastAPI backend.
 * Every request is timed out and every error is normalized to
 * { status, message } so app.js never has to deal with raw exceptions.
 */

// Same-origin when the frontend is served by FastAPI itself; otherwise the
// default dev address from .claude/launch.json (frontend served on :5500,
// API on :8000).
const API_BASE = window.location.port === "8000" ? "" : "http://127.0.0.1:8000";

const REQUEST_TIMEOUT_MS = 15000;
const ASK_TIMEOUT_MS = 120000; // local LLM generation can be slow

// Held in module state, not exposed globally — app.js only ever touches it
// through Api.setToken(). Attached automatically to every request below;
// harmless for the guest-usable routes, which accept a missing/absent token.
let authToken = null;

// Set by app.js. Called when a request that carried a token comes back 401 —
// an expired or tampered token, or one invalidated because an admin changed
// this account's role. Lets the UI sign the user out and say why, from one place.
let unauthorizedHandler = null;

// FastAPI returns `detail` as a string for our own errors but as a list of
// objects for request-validation failures (HTTP 422).
function detailToMessage(detail, fallback) {
  if (typeof detail === "string" && detail) return detail;
  if (Array.isArray(detail) && detail.length) {
    return detail.map((d) => d.msg || "Invalid input.").join(" ");
  }
  return fallback;
}

function withTimeout(promise, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { controller, timer, promise };
}

async function request(path, { method = "GET", body, headers, timeout = REQUEST_TIMEOUT_MS } = {}) {
  const { controller, timer } = withTimeout(null, timeout);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      body,
      headers: authToken ? { ...headers, Authorization: `Bearer ${authToken}` } : headers,
      signal: controller.signal,
    });

    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    if (!res.ok) {
      const message = detailToMessage(data && data.detail, `Request failed (${res.status}).`);
      if (res.status === 401 && authToken && unauthorizedHandler) unauthorizedHandler(message);
      return { ok: false, status: res.status, message, data };
    }
    return { ok: true, status: res.status, data };
  } catch (err) {
    if (err.name === "AbortError") {
      return { ok: false, status: 0, message: "The request timed out.", data: null };
    }
    return { ok: false, status: 0, message: "Can't reach the backend.", data: null };
  } finally {
    clearTimeout(timer);
  }
}

const Api = {
  async status() {
    return request("/status");
  },

  async ask(question, topK = 5, conversationId = null) {
    const body = { question, top_k: topK };
    if (conversationId) body.conversation_id = conversationId;
    return request("/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      timeout: ASK_TIMEOUT_MS,
    });
  },

  async reset() {
    return request("/reset", { method: "DELETE" });
  },

  setToken(token) {
    authToken = token;
  },

  /** Registers the callback fired on a 401 for an authenticated request. */
  onUnauthorized(handler) {
    unauthorizedHandler = handler;
  },

  async login(username, password) {
    return request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
  },

  /** Who the server thinks we are. Also the cheapest way to find out the
   *  token has expired or been invalidated by a role change. */
  async me() {
    return request("/me");
  },

  /** The documents this account's role may see: [{ file_hash, source_file, chunks, min_role }]. */
  async listDocuments() {
    return request("/documents");
  },

  /** Admin-only: change which role may see one stored document. */
  async setDocumentLevel(fileHash, minRole) {
    return request(`/admin/documents/${encodeURIComponent(fileHash)}/role`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ min_role: minRole }),
    });
  },

  // Admin-only on the server; a non-admin gets 403 whatever this page shows.
  async createUser(username, password, role) {
    return request("/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, role }),
    });
  },

  async changeRole(username, newRole) {
    return request(`/admin/users/${encodeURIComponent(username)}/role`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ new_role: newRole }),
    });
  },

  async listConversations() {
    return request("/conversations");
  },

  async createConversation(title = null) {
    return request("/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
  },

  async getConversation(id) {
    return request(`/conversations/${encodeURIComponent(id)}`);
  },

  async deleteConversationRemote(id) {
    return request(`/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  /**
   * Upload with progress reporting via XHR (fetch has no upload progress event).
   * `onXhrReady` receives the live XMLHttpRequest synchronously, before send(),
   * so the caller can stash it and call `.abort()` later to cancel mid-flight.
   */
  upload(file, { onProgress, onXhrReady, minRole } = {}) {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      const formData = new FormData();
      formData.append("file", file);
      if (minRole) formData.append("min_role", minRole); // who may see this document

      xhr.open("POST", `${API_BASE}/upload`);
      if (authToken) xhr.setRequestHeader("Authorization", `Bearer ${authToken}`);
      xhr.timeout = ASK_TIMEOUT_MS;

      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable && onProgress) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      });

      xhr.addEventListener("load", () => {
        let data = null;
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          data = null;
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve({ ok: true, status: xhr.status, data });
        } else {
          const message = detailToMessage(data && data.detail, `Upload failed (${xhr.status}).`);
          if (xhr.status === 401 && authToken && unauthorizedHandler) unauthorizedHandler(message);
          resolve({ ok: false, status: xhr.status, message, data });
        }
      });

      xhr.addEventListener("error", () => {
        resolve({ ok: false, status: 0, message: "Can't reach the backend.", data: null });
      });

      xhr.addEventListener("timeout", () => {
        resolve({ ok: false, status: 0, message: "The upload timed out.", data: null });
      });

      xhr.addEventListener("abort", () => {
        resolve({ ok: false, status: 0, message: "Upload cancelled.", data: null, cancelled: true });
      });

      if (onXhrReady) onXhrReady(xhr);
      xhr.send(formData);
    });
  },
};
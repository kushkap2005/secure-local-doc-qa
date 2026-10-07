"""
audit_log.py — Feature 15: an append-only record of who did what, and when.

What it records (one row per event):
    time (UTC), who (username + role), what happened, what it was about,
    a short detail, the HTTP result code, and the caller's IP address.

Events:
    login, login_failed            sign-ins (a failed one records the username typed)
    ask, ask_failed                a question was asked (the question TEXT is NOT
                                   stored unless LOG_QUESTION_TEXT is switched on)
    upload, upload_duplicate,
    upload_failed                  document uploads and why one was refused
    pdf_opened, pdf_denied_or_missing   someone opened a stored PDF, or was refused
    clear_all_documents            "Clear all documents" was used
    user_created, user_role_changed     account changes (Admin)
    document_level_changed         who may see a document was changed (Admin)
    access_denied                  any request refused with 403 (role too low)

Passwords, tokens, answers and document text are never written to the log.

How it works: one small "middleware" sits in front of every request. It looks
at the request and the response, works out whether it was one of the events
above, and writes a row. The existing routes in api.py are not touched.

How it plugs into api.py (two lines, after `store = VectorStore()`):

    from audit_log import install as install_audit_log
    install_audit_log(app)

Admins read the log with  GET /admin/audit  (filter by action or username,
newest first, paged). There is no route that edits or deletes entries, and the
table has database triggers that refuse UPDATE and DELETE.

Honest limits:
  * Someone who can open the database FILE directly can still remove the
    triggers and edit rows. Protecting the file itself is the job of the
    "encryption at rest" phase, not of this feature.
  * Who made a request comes from the signed login token. A token that has
    since been revoked still names its owner here, but it is refused by the
    routes themselves (you will see that as a 401, which is not logged).
  * The log only grows. Nothing deletes old rows.

To remove the feature: delete those two lines and this file. (The audit_log
table stays in the database; it does no harm.)
"""

import json
import re
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Query

from auth import decode_access_token, require_role
from database import get_connection

# Switch to True to also store the first 200 characters of each question.
# Off by default: questions can contain private information.
LOG_QUESTION_TEXT = False

MAX_BODY = 4096  # never buffer more than this much of any body

_SCHEMA = """
CREATE TABLE IF NOT EXISTS audit_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        TEXT NOT NULL,
    username  TEXT NOT NULL DEFAULT '',
    role      TEXT NOT NULL DEFAULT '',
    action    TEXT NOT NULL,
    target    TEXT NOT NULL DEFAULT '',
    detail    TEXT NOT NULL DEFAULT '',
    status    INTEGER NOT NULL DEFAULT 0,
    ip        TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
"""


def init_audit_table() -> None:
    conn = get_connection()
    try:
        conn.executescript(_SCHEMA)
        conn.commit()
    finally:
        conn.close()


def _clip(value, n: int) -> str:
    return str(value if value is not None else "")[:n]


def record(username, role, action, target="", detail="", status=0, ip="") -> None:
    """Write one row. Logging must never break a request, so it never raises."""
    try:
        conn = get_connection()
        try:
            conn.execute(
                "INSERT INTO audit_log (ts, username, role, action, target, detail, status, ip) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                    _clip(username, 100), _clip(role, 20), _clip(action, 40),
                    _clip(target, 200), _clip(detail, 300), int(status), _clip(ip, 64),
                ),
            )
            conn.commit()
        finally:
            conn.close()
    except Exception:
        pass


# --------------------------------------------------------------------------
# Deciding what a request was
# --------------------------------------------------------------------------

_ROLE_PATH = re.compile(r"/admin/users/([^/]+)/role")
_DOC_LEVEL_PATH = re.compile(r"/admin/documents/([0-9a-fA-F]{64})/role")
_PDF_PATH = re.compile(r"/documents/([0-9a-fA-F]{64})/pdf")


def _wants_request_body(method: str, path: str) -> bool:
    if method == "POST" and path in ("/login", "/admin/users"):
        return True
    if method == "PUT" and (_ROLE_PATH.fullmatch(path) or _DOC_LEVEL_PATH.fullmatch(path)):
        return True
    return LOG_QUESTION_TEXT and method == "POST" and path in ("/ask", "/ask/stream")


def _wants_response_body(method: str, path: str) -> bool:
    return method == "POST" and path in ("/login", "/upload")


def _json(raw: bytes) -> dict:
    try:
        data = json.loads(raw.decode("utf-8")) if raw else {}
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def classify(method, path, status, req, resp, user, role):
    """Return (username, role, action, target, detail) or None if not worth recording."""
    if method == "POST" and path == "/login":
        if status == 200:
            return resp.get("username", ""), resp.get("role", ""), "login", "", ""
        if status == 401:
            return _clip(req.get("username"), 100), "", "login_failed", "", ""
        return None

    if method == "POST" and path == "/upload":
        if status == 200:
            detail = f"{resp.get('chunks_added', '?')} chunks, level {resp.get('min_role', '?')}"
            return user, role, "upload", resp.get("filename", ""), detail
        if status == 409:
            return user, role, "upload_duplicate", "", _clip(resp.get("detail"), 200)
        if status in (400, 413, 423, 500):
            return user, role, "upload_failed", "", _clip(resp.get("detail"), 200)

    if method in ("DELETE", "POST") and path == "/reset" and status == 200:
        return user, role, "clear_all_documents", "", ""

    if method == "POST" and path == "/admin/users" and status == 201:
        return user, role, "user_created", _clip(req.get("username"), 100), _clip(req.get("role"), 20)

    m = _ROLE_PATH.fullmatch(path) if method == "PUT" else None
    if m and status == 200:
        return user, role, "user_role_changed", m.group(1), _clip(req.get("role"), 20)

    m = _DOC_LEVEL_PATH.fullmatch(path) if method == "PUT" else None
    if m and status == 200:
        return user, role, "document_level_changed", m.group(1)[:12], _clip(req.get("min_role"), 20)

    if method == "POST" and path in ("/ask", "/ask/stream"):
        detail = _clip(req.get("question"), 200) if LOG_QUESTION_TEXT else ""
        if status == 200:
            return user, role, "ask", "", detail
        if status >= 500:
            return user, role, "ask_failed", "", detail

    m = _PDF_PATH.fullmatch(path) if method == "GET" else None
    if m:
        if status == 200:
            return user, role, "pdf_opened", m.group(1)[:12], ""
        if status == 404:
            return user, role, "pdf_denied_or_missing", m.group(1)[:12], ""

    if method == "POST" and path == "/account/password":
        if status == 200:
            return user, role, "password_changed", "", ""
        if status == 429:
            return user, role, "password_change_failed", "", "too many wrong attempts"
        if status in (400, 422):
            return user, role, "password_change_failed", "", "wrong current password, or new password refused"

    if status == 403:
        return user, role, "access_denied", f"{method} {path}", ""
    return None


def _identity(scope) -> tuple:
    """Who sent this, read from the signed token. ('', '') if there isn't a valid one."""
    for key, value in scope.get("headers", []):
        if key == b"authorization":
            text = value.decode("latin-1")
            if text.startswith("Bearer "):
                try:
                    payload = decode_access_token(text[7:].strip())
                    return str(payload.get("sub", "")), str(payload.get("role", ""))
                except Exception:
                    return "", ""
    return "", ""


class AuditMiddleware:
    """Plain ASGI middleware: watches every request, never changes one."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] == "OPTIONS":
            return await self.app(scope, receive, send)

        method, path = scope["method"], scope["path"]
        want_req = _wants_request_body(method, path)
        want_resp = _wants_response_body(method, path)
        req_buf, resp_buf = bytearray(), bytearray()
        state = {"status": None}

        async def watched_receive():
            message = await receive()
            if want_req and message["type"] == "http.request" and len(req_buf) < MAX_BODY:
                req_buf.extend(message.get("body", b"")[: MAX_BODY - len(req_buf)])
            return message

        async def watched_send(message):
            if message["type"] == "http.response.start":
                state["status"] = message["status"]
            elif message["type"] == "http.response.body" and want_resp and len(resp_buf) < MAX_BODY:
                resp_buf.extend(message.get("body", b"")[: MAX_BODY - len(resp_buf)])
            await send(message)

        try:
            await self.app(scope, watched_receive, watched_send)
        finally:
            try:
                status = state["status"] or 500
                user, role = _identity(scope)
                row = classify(method, path, status, _json(bytes(req_buf)), _json(bytes(resp_buf)), user, role)
                if row:
                    client = scope.get("client")
                    record(*row, status=status, ip=client[0] if client else "")
            except Exception:
                pass  # logging must never break a request


# --------------------------------------------------------------------------
# Reading the log (Admin only)
# --------------------------------------------------------------------------

def _like(text: str) -> str:
    return "%" + text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def make_router() -> APIRouter:
    router = APIRouter()

    @router.get("/admin/audit")
    def read_audit(
        limit: int = Query(50, ge=1, le=200),
        offset: int = Query(0, ge=0),
        action: Optional[str] = Query(None, max_length=40),
        username: Optional[str] = Query(None, max_length=100),
        current_user: dict = Depends(require_role("Admin")),
    ):
        where, args = [], []
        if action:
            where.append("action = ?")
            args.append(action)
        if username:
            where.append("username LIKE ? ESCAPE '\\'")
            args.append(_like(username))
        clause = (" WHERE " + " AND ".join(where)) if where else ""

        conn = get_connection()
        try:
            total = conn.execute(f"SELECT COUNT(*) AS n FROM audit_log{clause}", args).fetchone()["n"]
            rows = conn.execute(
                f"SELECT id, ts, username, role, action, target, detail, status, ip "
                f"FROM audit_log{clause} ORDER BY id DESC LIMIT ? OFFSET ?",
                args + [limit, offset],
            ).fetchall()
            actions = [r["action"] for r in conn.execute("SELECT DISTINCT action FROM audit_log ORDER BY action")]
        finally:
            conn.close()
        return {
            "total": total,
            "limit": limit,
            "offset": offset,
            "actions": actions,
            "items": [dict(r) for r in rows],
        }

    return router


def install(app) -> None:
    """Create the table, start watching requests, and add the read route."""
    init_audit_table()
    app.add_middleware(AuditMiddleware)
    app.include_router(make_router())
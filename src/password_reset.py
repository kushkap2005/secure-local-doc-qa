"""
password_reset.py - Batch 2: help someone who forgot their password, without email.

The flow (offline-friendly, an Admin is the "mail server"):

  1. The person tells an Admin they are locked out.
  2. The Admin presses "Reset password" next to that user. The server makes a
     ONE-TIME CODE (8 characters like  K7QH-2MXR), shows it to the Admin once,
     and stores only a bcrypt hash of it.
  3. The Admin passes the code on (in person, by phone).
  4. On the sign-in screen the person chooses "Forgot password?", enters their
     username, the code and a new password. The code works once and only for
     15 minutes.

Four routes:

    POST /password/request                      public; "I forgot", puts a request in front of the Admins
    GET  /admin/password-requests               Admin only; who is waiting for a code
    POST /admin/users/{username}/reset-code     Admin only; returns the code once
    POST /password/reset                        public; username + code + new password

A request is only a nudge: it grants nothing. The Admin still has to press the
button and pass the code on. /password/request always gives the same answer
whether or not the username exists, so it can't be used to find usernames.

Safety rules (each one is tested):
  * The code is random from an alphabet with no look-alike characters (no 0/O,
    1/I), is stored hashed, expires in 15 minutes and burns on first use.
  * Issuing a new code cancels any earlier unused code for that user.
  * Every failure gives the SAME answer ("not valid or expired"): unknown
    username, no code, wrong code, expired code. Nothing reveals which usernames exist.
  * Wrong codes count towards the same lock as wrong passwords (login_lockout.py),
    and after 5 wrong tries on one code that code is burned.
  * A successful reset signs the account out everywhere (token_version +1), burns
    every other code for it, and lifts a lockout (the owner has just proved who they are).
  * An Admin cannot issue a code for THEIR OWN account on this screen. Another
    Admin does it. If you are the only Admin and are locked out, use the server
    script  reset_password.py  (it needs access to the machine itself, which is
    the point).
  * The code and the new password are never written to the audit log.

How it plugs into api.py (two lines, near the other routers):

    from password_reset import make_router as make_reset_router
    app.include_router(make_reset_router())

To remove: delete those two lines and this file. (The password_resets table
stays in the database and does no harm.)
"""

import secrets
import time
from collections import defaultdict, deque

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

import login_lockout
from auth import hash_password, require_role, verify_password
from database import get_connection, get_user_by_username

CODE_MINUTES = 15
MAX_CODE_ATTEMPTS = 5          # wrong tries on ONE code before that code is burned
MAX_PASSWORD_BYTES = 72        # bcrypt only reads this much
ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # 32 symbols, no I, O, 0, 1
CODE_LENGTH = 8

INVALID = "That reset code is not valid, or it has expired. Ask an administrator for a new one."

# a real bcrypt hash of nothing useful: checked when the user/code doesn't exist,
# so "unknown user" takes about as long as "wrong code"
_DUMMY_HASH = hash_password("not-a-real-code")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS password_resets (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    username  TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    issued_by TEXT NOT NULL,
    created   INTEGER NOT NULL,
    expires   INTEGER NOT NULL,
    used      INTEGER,
    attempts  INTEGER NOT NULL DEFAULT 0
)
"""


REQUEST_HOURS = 24            # a request that nobody answered disappears after this
REQUESTS_PER_IP_HOUR = 10     # stops one machine flooding the Admin's list
REQUEST_REPLY = "If that account exists, an administrator has been notified. Ask them for your reset code."

_SCHEMA_REQUESTS = """
CREATE TABLE IF NOT EXISTS password_requests (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    created  INTEGER NOT NULL,
    handled  INTEGER
)
"""

_ip_times = defaultdict(deque)   # ip -> times of recent requests (in memory; a restart clears it)


def _ip_allowed(ip: str, now: float) -> bool:
    q = _ip_times[ip]
    while q and q[0] < now - 3600:
        q.popleft()
    if len(q) >= REQUESTS_PER_IP_HOUR:
        return False
    q.append(now)
    if len(_ip_times) > 5000:           # don't grow forever
        _ip_times.clear()
    return True


def init_table() -> None:
    conn = get_connection()
    try:
        conn.execute(_SCHEMA)
        conn.execute(_SCHEMA_REQUESTS)
        conn.commit()
    finally:
        conn.close()


def make_code() -> str:
    return "".join(secrets.choice(ALPHABET) for _ in range(CODE_LENGTH))


def pretty(code: str) -> str:
    return code[:4] + "-" + code[4:]


def normalise(typed: str) -> str:
    """Accept lower case, spaces and the hyphen the Admin was shown."""
    return "".join(ch for ch in typed.upper() if ch.isalnum())


class ForgotRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=100)


class ResetRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=100)
    code: str = Field(..., min_length=1, max_length=40)
    new_password: str = Field(..., min_length=8, max_length=256)


def make_router() -> APIRouter:
    init_table()
    router = APIRouter()

    @router.post("/password/request")
    def request_reset(body: ForgotRequest, request: Request):
        """Public. Same answer for every input; only a real, new request is recorded."""
        username = body.username.strip()
        client = request.client
        ip = client.host if client else ""
        now = int(time.time())
        if not _ip_allowed(ip, now):
            raise HTTPException(status_code=429, detail="Too many requests from this device. Try again later.")

        user = get_user_by_username(username) if username else None
        if user is not None:
            conn = get_connection()
            try:
                waiting = conn.execute(
                    "SELECT 1 FROM password_requests WHERE username = ? AND handled IS NULL AND created > ?",
                    (user["username"], now - REQUEST_HOURS * 3600),
                ).fetchone()
                if waiting is None:
                    conn.execute(
                        "INSERT INTO password_requests (username, created) VALUES (?, ?)",
                        (user["username"], now),
                    )
                    conn.commit()
                    try:
                        from audit_log import record
                        record(user["username"], "", "password_reset_requested", user["username"],
                               "asked an administrator for a reset code", status=200, ip=ip)
                    except Exception:
                        pass
            finally:
                conn.close()
        return {"ok": True, "message": REQUEST_REPLY}

    @router.get("/admin/password-requests")
    def list_requests(admin: dict = Depends(require_role("Admin"))):
        now = int(time.time())
        conn = get_connection()
        try:
            rows = conn.execute(
                "SELECT r.username AS username, r.created AS created, u.role AS role "
                "FROM password_requests r JOIN users u ON u.username = r.username "
                "WHERE r.handled IS NULL AND r.created > ? ORDER BY r.created ASC",
                (now - REQUEST_HOURS * 3600,),
            ).fetchall()
        finally:
            conn.close()
        return {
            "me": admin["username"],
            "requests": [{"username": r["username"], "role": r["role"], "requested_at": r["created"]} for r in rows],
        }

    @router.post("/admin/users/{username}/reset-code")
    def issue_code(username: str, response: Response, admin: dict = Depends(require_role("Admin"))):
        if username == admin["username"]:
            raise HTTPException(
                status_code=403,
                detail="You can't reset your own password here. Ask another Admin, or use the server script.",
            )
        if get_user_by_username(username) is None:
            raise HTTPException(status_code=404, detail="No such user.")

        code = make_code()
        now = int(time.time())
        conn = get_connection()
        try:
            # a new code cancels every earlier unused one for this user
            conn.execute("UPDATE password_resets SET used = ? WHERE username = ? AND used IS NULL", (now, username))
            conn.execute("UPDATE password_requests SET handled = ? WHERE username = ? AND handled IS NULL", (now, username))
            conn.execute(
                "INSERT INTO password_resets (username, code_hash, issued_by, created, expires) VALUES (?, ?, ?, ?, ?)",
                (username, hash_password(code), admin["username"], now, now + CODE_MINUTES * 60),
            )
            conn.commit()
        finally:
            conn.close()
        response.headers["Cache-Control"] = "no-store"
        return {"username": username, "code": pretty(code), "expires_in_minutes": CODE_MINUTES}

    @router.post("/password/reset")
    def use_code(body: ResetRequest, request: Request):
        username = body.username.strip()
        key = username.lower()
        client = request.client
        ip = client.host if client else ""

        if len(body.new_password.encode("utf-8")) > MAX_PASSWORD_BYTES:
            raise HTTPException(status_code=400, detail="The new password is too long (72 bytes at most).")

        wait = login_lockout.seconds_locked(key)
        if wait > 0:
            minutes = max(1, (wait + 59) // 60)
            raise HTTPException(
                status_code=429,
                detail=f"Too many failed attempts. Try again in about {minutes} minute(s).",
            )

        now = int(time.time())
        user = get_user_by_username(username)
        conn = get_connection()
        try:
            row = None
            if user is not None:
                row = conn.execute(
                    "SELECT id, code_hash, attempts FROM password_resets "
                    "WHERE username = ? AND used IS NULL AND expires > ? ORDER BY id DESC LIMIT 1",
                    (username, now),
                ).fetchone()

            typed = normalise(body.code)
            good = verify_password(typed, row["code_hash"] if row else _DUMMY_HASH) and row is not None

            if not good:
                login_lockout.fail_and_log(key, username, ip, "wrong password-reset code")
                if row is not None:
                    attempts = row["attempts"] + 1
                    burn = now if attempts >= MAX_CODE_ATTEMPTS else None
                    conn.execute("UPDATE password_resets SET attempts = ?, used = ? WHERE id = ?", (attempts, burn, row["id"]))
                    conn.commit()
                raise HTTPException(status_code=400, detail=INVALID)

            if verify_password(body.new_password, user["password_hash"]):
                raise HTTPException(status_code=400, detail="The new password must be different from the old one.")

            conn.execute(
                "UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE username = ?",
                (hash_password(body.new_password), username),
            )
            conn.execute("UPDATE password_resets SET used = ? WHERE username = ? AND used IS NULL", (now, username))
            conn.execute("UPDATE password_requests SET handled = ? WHERE username = ? AND handled IS NULL", (now, username))
            conn.commit()
        finally:
            conn.close()

        login_lockout.unlock(key)
        return {"ok": True}

    return router
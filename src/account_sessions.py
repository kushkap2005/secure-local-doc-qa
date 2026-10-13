"""
account_sessions.py - "Sign out everywhere" and "Recent sign-ins" for your own account.

Two routes, any signed-in role, each about the CALLER's own account only:

    POST /account/signout-all     ends every sign-in of this account, this browser too
    GET  /account/sign-ins        your recent sign-ins and failed attempts

Sign out everywhere works the same way the password change does: it bumps the
account's token_version, so every token issued before now stops working on the
next request. Nothing is stored per device, so there is no "list of devices";
the tokens simply all become invalid at once.

Recent sign-ins is read from the audit log (feature 15), and only rows whose
username is YOUR OWN are returned: time, success or failure, and the address the
request came from. Passwords are never in the log. If the audit log is not
installed the list is simply empty.

It also counts failed attempts on your account since your previous successful
sign-in, so you notice if someone has been guessing your password.

How it plugs into api.py (two lines, anywhere after the other routers):

    from account_sessions import make_router as make_sessions_router
    app.include_router(make_sessions_router())

To remove: delete those two lines and this file.
"""

from fastapi import APIRouter, Depends, Query

from auth import get_current_user
from database import get_connection


def make_router() -> APIRouter:
    router = APIRouter()

    @router.post("/account/signout-all")
    def signout_all(current_user: dict = Depends(get_current_user)):
        conn = get_connection()
        try:
            conn.execute(
                "UPDATE users SET token_version = token_version + 1 WHERE username = ?",
                (current_user["username"],),
            )
            conn.commit()
        finally:
            conn.close()
        return {"ok": True}

    @router.get("/account/sign-ins")
    def sign_ins(limit: int = Query(10, ge=1, le=20), current_user: dict = Depends(get_current_user)):
        name = current_user["username"]
        conn = get_connection()
        try:
            rows = conn.execute(
                "SELECT id, ts, action, ip FROM audit_log "
                "WHERE username = ? COLLATE NOCASE AND action IN ('login', 'login_failed') "
                "ORDER BY id DESC LIMIT ?",
                (name, limit),
            ).fetchall()
            logins = conn.execute(
                "SELECT id FROM audit_log WHERE username = ? COLLATE NOCASE AND action = 'login' "
                "ORDER BY id DESC LIMIT 2",
                (name,),
            ).fetchall()
            previous_id = logins[1][0] if len(logins) > 1 else 0
            failed = conn.execute(
                "SELECT COUNT(*) FROM audit_log WHERE username = ? COLLATE NOCASE "
                "AND action = 'login_failed' AND id > ?",
                (name, previous_id),
            ).fetchone()[0]
        except Exception:  # audit log not installed yet
            rows, failed = [], 0
        finally:
            conn.close()
        return {
            "sign_ins": [{"time": ts, "ok": action == "login", "ip": ip} for _id, ts, action, ip in rows],
            "failed_since_previous_login": failed,
        }

    return router
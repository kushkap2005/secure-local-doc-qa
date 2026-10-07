"""
account_settings.py - Feature 19: let a signed-in user change their own password.

One route, any signed-in role:

    POST /account/password     body: {"current_password": "...", "new_password": "..."}

What it does, in order:
  1. Throttle: after 5 wrong "current password" answers within 15 minutes the
     account gets a 429 for the rest of that window. Without this, someone who
     got hold of a signed-in browser could guess the old password here.
  2. Check the current password against the stored bcrypt hash.
  3. Check the new one (8 to 72 bytes, and different from the current one).
  4. Store the new hash and bump token_version. Bumping it is the same trick
     the role-change route uses: every token issued before now stops working,
     so a session left open on another machine is signed out.
  5. Return a fresh token for THIS session, so the person who just changed
     their password is not thrown out.

It never returns a password or a hash. A wrong current password answers 400,
not 401, because the front end treats any 401 as "your session ended" and
would sign the person out for a typo.

How it plugs into api.py (two lines, anywhere after the other routers):

    from account_settings import make_router as make_account_router
    app.include_router(make_account_router())

To remove the feature: delete those two lines and this file.
"""

import time
from typing import Dict, List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth import create_access_token, get_current_user, hash_password, verify_password
from database import get_connection, get_user_by_username

MAX_WRONG_ATTEMPTS = 5
WINDOW_SECONDS = 15 * 60
MAX_PASSWORD_BYTES = 72  # bcrypt only looks at the first 72 bytes, so refuse longer ones instead of silently cutting them

# username -> times (monotonic seconds) of recent wrong answers. Lives in memory:
# a server restart forgets it, which is fine for a throttle.
_wrong: Dict[str, List[float]] = {}


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(..., min_length=1, max_length=256)
    new_password: str = Field(..., min_length=8, max_length=256)


def _recent_wrong(username: str) -> List[float]:
    now = time.monotonic()
    kept = [t for t in _wrong.get(username, []) if now - t < WINDOW_SECONDS]
    if kept:
        _wrong[username] = kept
    else:
        _wrong.pop(username, None)
    return kept


def _store_new_password(username: str, new_hash: str) -> int:
    """Save the hash and bump token_version. Returns the new token_version."""
    conn = get_connection()
    try:
        conn.execute(
            "UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE username = ?",
            (new_hash, username),
        )
        conn.commit()
    finally:
        conn.close()
    return get_user_by_username(username)["token_version"]


def make_router() -> APIRouter:
    router = APIRouter()

    @router.post("/account/password")
    def change_password(body: ChangePasswordRequest, current_user: dict = Depends(get_current_user)):
        username = current_user["username"]

        wrong = _recent_wrong(username)
        if len(wrong) >= MAX_WRONG_ATTEMPTS:
            minutes = max(1, int((WINDOW_SECONDS - (time.monotonic() - wrong[0])) / 60) + 1)
            raise HTTPException(
                status_code=429,
                detail=f"Too many wrong attempts. Try again in about {minutes} minute(s).",
            )

        user = get_user_by_username(username)
        if user is None:  # deleted between the token check and here
            raise HTTPException(status_code=404, detail="Account not found.")

        if not verify_password(body.current_password, user["password_hash"]):
            _wrong.setdefault(username, []).append(time.monotonic())
            raise HTTPException(status_code=400, detail="Your current password is incorrect.")

        if len(body.new_password.encode("utf-8")) > MAX_PASSWORD_BYTES:
            raise HTTPException(status_code=400, detail="The new password is too long (72 bytes at most).")
        if body.new_password == body.current_password:
            raise HTTPException(status_code=400, detail="The new password must be different from the current one.")

        _wrong.pop(username, None)
        new_version = _store_new_password(username, hash_password(body.new_password))
        token = create_access_token(username=username, role=user["role"], token_version=new_version)
        return {
            "access_token": token,
            "token_type": "bearer",
            "username": username,
            "role": user["role"],
        }

    return router
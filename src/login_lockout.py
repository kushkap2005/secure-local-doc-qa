"""
login_lockout.py - Batch 2: stop password guessing on /login.

The rule (numbers at the top of this file, change them there):

    5 wrong passwords for the same username within 15 minutes
        -> that username is LOCKED for 15 minutes.

While a username is locked, the server refuses every sign-in for it, even one
with the CORRECT password, and never even looks the password up. Someone running
a list of guesses gets nowhere; the real owner waits a few minutes.

Details worth knowing (and being able to explain):
  * It is per USERNAME, not per computer. On an offline office network many
    people share one address, so blocking by address would punish everybody.
  * Unknown usernames are counted exactly like real ones, so the lock can't be
    used to find out which usernames exist.
  * The lock itself and each refused attempt are written to the audit log
    ("login_locked"), so an Admin can see an attack happening. Passwords are
    never logged.
  * Cost of this design: someone can lock ANOTHER person's account on purpose
    by typing wrong passwords for it. The lock is short, and it shows up in the
    audit log, which is the accepted trade-off.
  * A wrong password gets the SAME message for real and unknown usernames, plus
    how many tries are left ("3 attempts left before a 15-minute lock"). Because
    unknown names are counted too, the countdown tells an attacker nothing about
    which usernames exist. (Saying "wrong password" only for real usernames would.)
  * The counters live in memory. Restarting the server clears every lock, which
    also gives the owner a way out in an emergency. (Counting wrong attempts in
    the database would survive restarts but is not needed for an offline tool.)

How it works: a small "middleware" in front of the app looks at POST /login only.
It reads the (tiny) request body to learn the username, checks the lock, then
either answers 429 itself or lets the request through unchanged and watches
whether the answer was 401 (wrong password) or 200 (success). The /login code
in api.py is not touched.

How it plugs into api.py (two lines, right after the audit-log install):

    from login_lockout import install as install_login_lockout
    install_login_lockout(app)

To remove: delete those two lines and this file.
"""

import json
import time
from typing import Dict, List

MAX_FAILURES = 5          # wrong passwords allowed...
WINDOW_SECONDS = 15 * 60  # ...within this many seconds
LOCK_SECONDS = 15 * 60    # how long the username stays locked
MAX_BODY = 4096           # a real login body is tiny; anything bigger is refused
MAX_TRACKED = 10000       # memory cap: never remember more usernames than this

_failures: Dict[str, List[float]] = {}   # username -> times of recent wrong passwords
_locked_until: Dict[str, float] = {}     # username -> when the lock ends (monotonic seconds)


def _key(username: str) -> str:
    return username.strip().lower()


def _prune(now: float) -> None:
    """Forget expired locks and old failures so the dictionaries can't grow forever."""
    for k in [k for k, t in _locked_until.items() if t <= now]:
        del _locked_until[k]
    for k in list(_failures):
        _failures[k] = [t for t in _failures[k] if now - t < WINDOW_SECONDS]
        if not _failures[k]:
            del _failures[k]


def seconds_locked(key: str, now: float = None) -> int:
    """0 if the username may try, otherwise how many seconds remain."""
    now = time.monotonic() if now is None else now
    until = _locked_until.get(key, 0)
    return max(0, int(until - now) + (1 if until > now else 0))


def note_failure(key: str, now: float = None) -> bool:
    """Count one wrong password. Returns True if this one tripped the lock."""
    now = time.monotonic() if now is None else now
    if len(_failures) + len(_locked_until) > MAX_TRACKED:
        _prune(now)
        if len(_failures) + len(_locked_until) > MAX_TRACKED:
            return False  # table full of live entries: stay safe, never crash
    recent = [t for t in _failures.get(key, []) if now - t < WINDOW_SECONDS]
    recent.append(now)
    if len(recent) >= MAX_FAILURES:
        _failures.pop(key, None)
        _locked_until[key] = now + LOCK_SECONDS
        return True
    _failures[key] = recent
    return False


def attempts_left(key: str, now: float = None) -> int:
    """Wrong passwords still allowed before the lock (0 if locked)."""
    now = time.monotonic() if now is None else now
    if seconds_locked(key, now) > 0:
        return 0
    recent = [t for t in _failures.get(key, []) if now - t < WINDOW_SECONDS]
    return max(0, MAX_FAILURES - len(recent))


def note_success(key: str) -> None:
    _failures.pop(key, None)


def reset_all() -> None:
    """For tests."""
    _failures.clear()
    _locked_until.clear()


def _audit(username: str, detail: str, status: int, ip: str) -> None:
    try:
        from audit_log import record
        record(username, "", "login_locked", "", detail, status=status, ip=ip)
    except Exception:
        pass  # the audit log is optional, and logging must never break a request


async def _reply(send, status: int, detail: str, extra_headers=()):
    body = json.dumps({"detail": detail}).encode()
    headers = [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]
    headers.extend(extra_headers)
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": body})


class LoginLockoutMiddleware:
    """Plain ASGI middleware. Only POST /login is looked at; everything else passes straight through."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] != "POST" or scope["path"] != "/login":
            return await self.app(scope, receive, send)

        # Read the whole (small) body so we can see the username and still hand it on.
        chunks, size, more = [], 0, True
        while more:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            part = message.get("body", b"")
            size += len(part)
            if size > MAX_BODY:
                return await _reply(send, 413, "Request too large.")
            chunks.append(part)
            more = message.get("more_body", False)
        raw = b"".join(chunks)

        try:
            data = json.loads(raw.decode("utf-8")) if raw else {}
            username = data.get("username") if isinstance(data, dict) else None
        except Exception:
            username = None

        sent = {"done": False}

        async def replay():
            if not sent["done"]:
                sent["done"] = True
                return {"type": "http.request", "body": raw, "more_body": False}
            return await receive()

        if not isinstance(username, str) or not username.strip():
            return await self.app(scope, replay, send)  # malformed: the normal 422 path

        key = _key(username)
        client = scope.get("client")
        ip = client[0] if client else ""

        wait = seconds_locked(key)
        if wait > 0:
            minutes = max(1, (wait + 59) // 60)
            _audit(username.strip()[:100], "refused while locked", 429, ip)
            return await _reply(
                send, 429,
                f"Too many failed sign-in attempts. Try again in about {minutes} minute(s).",
                [(b"retry-after", str(wait).encode())],
            )

        state = {"status": None, "start": None, "buf": bytearray()}

        async def watched_send(message):
            if message["type"] == "http.response.start":
                state["status"] = message["status"]
                if message["status"] == 401:
                    state["start"] = message  # hold it: we add the "tries left" note to the body
                    return
                return await send(message)

            if state["start"] is None:
                return await send(message)  # not a 401: pass straight through

            state["buf"].extend(message.get("body", b""))
            if message.get("more_body", False):
                return
            # the complete 401 body is in: count this wrong password, then add the note
            tripped = note_failure(key)
            if tripped:
                _audit(username.strip()[:100], f"locked for {LOCK_SECONDS // 60} min after {MAX_FAILURES} wrong passwords", 401, ip)
                note = f"Too many failed attempts: this account is locked for {LOCK_SECONDS // 60} minutes."
            else:
                left = attempts_left(key)
                note = f"{left} attempt{'s' if left != 1 else ''} left before a {LOCK_SECONDS // 60}-minute lock."
            try:
                detail = json.loads(bytes(state["buf"]).decode("utf-8")).get("detail", "")
                body = json.dumps({"detail": f"{detail} {note}".strip()}).encode()
            except Exception:
                body = bytes(state["buf"])  # unexpected shape: leave it exactly as it was
            start = state["start"]
            headers = [h for h in start["headers"] if h[0].lower() != b"content-length"]
            headers.append((b"content-length", str(len(body)).encode()))
            await send({**start, "headers": headers})
            await send({"type": "http.response.body", "body": body})

        await self.app(scope, replay, watched_send)

        if state["status"] == 200:
            note_success(key)


def install(app) -> None:
    """Put the lockout INSIDE the other middleware (CORS, audit log).

    add_middleware() would make it the outermost layer, and then its own early
    "429 locked" answer would skip CORS and the browser would block it. Appending
    to the end of the list makes it the innermost layer instead, so every answer
    it gives travels back out through CORS like any other reply.
    """
    from starlette.middleware import Middleware
    app.user_middleware.append(Middleware(LoginLockoutMiddleware))
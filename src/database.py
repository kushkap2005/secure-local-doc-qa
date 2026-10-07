"""
database.py — SQLite storage for users and document permissions.
Powers RBAC: who can log in, what role they have, which documents each
role can access, and forcing re-login when a user's role changes.
"""

import os
import sqlite3
from typing import Optional

DB_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "app.db")

# Roles, ordered from lowest to highest access level.
# A role's position in this list is its access level — used to implement
# hierarchical access, where a higher role can do everything a lower
# role can, plus more.
ROLE_HIERARCHY = ["Guest", "Staff", "Admin"]


def get_connection() -> sqlite3.Connection:
    """Open a connection to the SQLite database, creating the file if needed."""
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row  # lets us access columns by name, e.g. row["username"]
    return conn


def init_db() -> None:
    """Create the users and document_permissions tables if they don't already exist."""
    conn = get_connection()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL,
            token_version INTEGER NOT NULL DEFAULT 1
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS document_permissions (
            file_hash TEXT PRIMARY KEY,
            required_role TEXT NOT NULL
        )
    """)
    conn.commit()
    conn.close()


# ---------------------------------------------------------------------
# User management
# ---------------------------------------------------------------------

def create_user(username: str, password_hash: str, role: str) -> None:
    """
    Create a new user account. password_hash must already be a bcrypt
    hash (from passlib) — never pass a plain-text password here.
    New users start at token_version 1.
    """
    if role not in ROLE_HIERARCHY:
        raise ValueError(f"Invalid role '{role}'. Must be one of {ROLE_HIERARCHY}")

    conn = get_connection()
    try:
        conn.execute(
            "INSERT INTO users (username, password_hash, role, token_version) VALUES (?, ?, ?, 1)",
            (username, password_hash, role),
        )
        conn.commit()
    except sqlite3.IntegrityError:
        raise ValueError(f"Username '{username}' already exists")
    finally:
        conn.close()


def get_user_by_username(username: str) -> Optional[dict]:
    """
    Look up a user by username. Returns a plain dict with their stored
    data (including password_hash, role, token_version), or None if no
    such user exists.
    """
    conn = get_connection()
    row = conn.execute(
        "SELECT id, username, password_hash, role, token_version FROM users WHERE username = ?",
        (username,),
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def update_user_role(username: str, new_role: str) -> None:
    """
    Change an existing user's role, and bump their token_version.
    Bumping token_version invalidates every token already issued to this
    user — their next request with an old token will be rejected,
    forcing them to log in again and receive a token reflecting the new
    role. This is what makes a role change take effect immediately,
    rather than silently waiting for their old token to expire.
    """
    if new_role not in ROLE_HIERARCHY:
        raise ValueError(f"Invalid role '{new_role}'. Must be one of {ROLE_HIERARCHY}")

    conn = get_connection()
    cursor = conn.execute(
        "UPDATE users SET role = ?, token_version = token_version + 1 WHERE username = ?",
        (new_role, username),
    )
    conn.commit()
    conn.close()

    if cursor.rowcount == 0:
        raise ValueError(f"No user found with username '{username}'")


def is_token_version_current(username: str, token_version: int) -> bool:
    """
    Check whether a token's embedded token_version still matches what's
    currently stored for this user. False means the token is stale —
    either the user's role changed since this token was issued, or the
    user no longer exists — and the caller should reject the request.
    """
    user = get_user_by_username(username)
    if user is None:
        return False
    return user["token_version"] == token_version


# ---------------------------------------------------------------------
# Document-level permissions
# Each ingested document (identified by its content hash, the same SHA-256
# used for duplicate-upload detection in api.py) has a MINIMUM ROLE allowed
# to see it. A document with NO recorded level is treated as Admin-only
# ("default deny"): if anything ever goes wrong between storing a document's
# chunks and recording its level, the document stays hidden instead of
# silently becoming visible to everyone.
# ---------------------------------------------------------------------

DEFAULT_REQUIRED_ROLE = ROLE_HIERARCHY[-1]  # "Admin" — the most restrictive role


def set_document_permission(file_hash: str, required_role: str) -> None:
    """
    Set the minimum role required to see a specific ingested document.
    Overwrites any existing level for that file_hash.
    """
    if required_role not in ROLE_HIERARCHY:
        raise ValueError(f"Invalid role '{required_role}'. Must be one of {ROLE_HIERARCHY}")

    conn = get_connection()
    conn.execute(
        "INSERT INTO document_permissions (file_hash, required_role) VALUES (?, ?) "
        "ON CONFLICT(file_hash) DO UPDATE SET required_role = excluded.required_role",
        (file_hash, required_role),
    )
    conn.commit()
    conn.close()


def get_required_role(file_hash: str) -> str:
    """
    Return the minimum role required to see a document. If no level was ever
    recorded for it, returns the most restrictive role (Admin) — default deny.
    """
    conn = get_connection()
    row = conn.execute(
        "SELECT required_role FROM document_permissions WHERE file_hash = ?",
        (file_hash,),
    ).fetchone()
    conn.close()
    return row["required_role"] if row else DEFAULT_REQUIRED_ROLE


def get_all_document_roles() -> dict:
    """Every recorded document level as {file_hash: required_role}, in one query."""
    conn = get_connection()
    rows = conn.execute("SELECT file_hash, required_role FROM document_permissions").fetchall()
    conn.close()
    return {row["file_hash"]: row["required_role"] for row in rows}


def get_accessible_file_hashes(user_role: str, all_file_hashes: list) -> list:
    """
    Given a user's role and every document hash currently stored, return only
    the hashes that role may see. Hierarchical: a role sees every document whose
    minimum role is at or below its own level. Hashes with no recorded level
    count as Admin-only.
    """
    user_level = ROLE_HIERARCHY.index(user_role)
    recorded = get_all_document_roles()
    return [
        file_hash
        for file_hash in all_file_hashes
        if user_level >= ROLE_HIERARCHY.index(recorded.get(file_hash, DEFAULT_REQUIRED_ROLE))
    ]


def clear_document_permissions() -> None:
    """Forget every recorded document level (used when all documents are cleared)."""
    conn = get_connection()
    conn.execute("DELETE FROM document_permissions")
    conn.commit()
    conn.close()


# Quick self-test — run:  python database.py
# It uses a throwaway database file, so it never touches your real data/app.db.
if __name__ == "__main__":
    import tempfile

    DB_PATH = os.path.join(tempfile.mkdtemp(), "selftest.db")
    init_db()
    failures = 0

    def check(name, condition):
        global failures
        print(("PASS  " if condition else "FAIL  ") + name)
        if not condition:
            failures += 1

    # --- users and forced re-login ---
    create_user("selftest_user", "not-a-real-hash", "Admin")
    before = get_user_by_username("selftest_user")
    update_user_role("selftest_user", "Staff")
    after = get_user_by_username("selftest_user")
    check("role update changes the role", after["role"] == "Staff")
    check("role update bumps token_version", after["token_version"] == before["token_version"] + 1)
    check("the old token_version is no longer current", not is_token_version_current("selftest_user", before["token_version"]))

    # --- document-level permissions ---
    set_document_permission("open_doc", "Guest")
    set_document_permission("staff_doc", "Staff")
    set_document_permission("admin_doc", "Admin")
    everything = ["open_doc", "staff_doc", "admin_doc", "never_registered_doc"]

    check("Guest sees only Guest-level documents", get_accessible_file_hashes("Guest", everything) == ["open_doc"])
    check("Staff sees Guest + Staff documents", get_accessible_file_hashes("Staff", everything) == ["open_doc", "staff_doc"])
    check("Admin sees everything", get_accessible_file_hashes("Admin", everything) == everything)
    check("a document with no recorded level defaults to Admin-only", get_required_role("never_registered_doc") == "Admin")
    check("an unregistered document is hidden from Staff", "never_registered_doc" not in get_accessible_file_hashes("Staff", everything))

    set_document_permission("staff_doc", "Guest")
    check("changing a document's level takes effect", "staff_doc" in get_accessible_file_hashes("Guest", everything))

    try:
        set_document_permission("bad_doc", "Superuser")
        check("an invalid role name is rejected", False)
    except ValueError:
        check("an invalid role name is rejected", True)

    clear_document_permissions()
    check("after clearing, Staff sees nothing", get_accessible_file_hashes("Staff", everything) == [])
    check("after clearing, Admin still sees everything", get_accessible_file_hashes("Admin", everything) == everything)

    print("\nALL CHECKS PASSED" if failures == 0 else f"\n{failures} CHECK(S) FAILED")
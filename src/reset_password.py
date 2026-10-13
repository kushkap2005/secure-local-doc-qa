"""
reset_password.py - emergency password reset, run ON THE SERVER MACHINE.

Use it when no Admin can sign in (for example the only Admin forgot their
password), because the normal reset needs an Admin. Anyone who can run this
already has full access to the machine and its database, so it adds no new
power; it just does the job safely: hashed password, other sessions signed out,
and an entry in the audit log.

    cd src
    python reset_password.py <username>

It asks for the new password twice (typing is hidden) and asks you to retype the
username to confirm. If that account was locked by too many wrong passwords,
restart the server afterwards (the lock lives in the server's memory).
"""

import getpass
import sys

from auth import hash_password
from database import get_connection, get_user_by_username, init_db

MAX_PASSWORD_BYTES = 72


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: python reset_password.py <username>")
        return 2
    username = sys.argv[1].strip()
    init_db()
    user = get_user_by_username(username)
    if user is None:
        print(f"No user named '{username}'. Usernames are case-sensitive.")
        return 1

    print(f"Resetting the password for '{username}' (role {user['role']}).")
    if input("Type the username again to confirm: ").strip() != username:
        print("Username did not match. Nothing was changed.")
        return 1

    first = getpass.getpass("New password (at least 8 characters): ")
    if len(first) < 8:
        print("Too short. Nothing was changed.")
        return 1
    if len(first.encode("utf-8")) > MAX_PASSWORD_BYTES:
        print("Too long (72 bytes at most). Nothing was changed.")
        return 1
    if getpass.getpass("Type it again: ") != first:
        print("The two entries did not match. Nothing was changed.")
        return 1

    conn = get_connection()
    try:
        conn.execute(
            "UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE username = ?",
            (hash_password(first), username),
        )
        conn.commit()
    finally:
        conn.close()

    try:  # leave a trace in the audit log if it is installed
        from audit_log import init_audit_table, record
        init_audit_table()
        record("(server script)", "", "password_reset_script", username, "", status=0, ip="local")
    except Exception:
        print("Note: the audit log could not be written to.")

    print(f"Done. '{username}' is signed out everywhere and can sign in with the new password.")
    print("If the account was locked, restart the server to clear the lock.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
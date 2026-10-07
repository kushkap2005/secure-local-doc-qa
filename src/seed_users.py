"""
seed_users.py — one-off script that creates the initial Admin, Staff and
Guest accounts with real bcrypt-hashed passwords, and removes the
placeholder test_admin user left over from database.py's test block.

Run once from src/:   python seed_users.py
Passwords are typed at the prompt (hidden while typing) and are never
stored in this file or printed anywhere.
"""

from getpass import getpass

from auth import hash_password
from database import (
    create_user,
    get_connection,
    get_user_by_username,
    init_db,
)

ACCOUNTS = [
    ("admin1", "Admin"),
    ("staff1", "Staff"),
    ("guest1", "Guest"),
]
MIN_PASSWORD_LENGTH = 8


def remove_placeholder_user() -> None:
    """Delete test_admin, which has a fake non-bcrypt hash and can never log in."""
    conn = get_connection()
    cursor = conn.execute("DELETE FROM users WHERE username = ?", ("test_admin",))
    removed = cursor.rowcount
    conn.commit()
    conn.close()
    if removed:
        print("Removed placeholder user 'test_admin'.")


def prompt_password(username: str) -> str:
    """Ask for a password twice, re-asking until it's long enough and matches."""
    while True:
        password = getpass(f"Password for {username} (typing is hidden): ")
        if len(password) < MIN_PASSWORD_LENGTH:
            print(f"  Must be at least {MIN_PASSWORD_LENGTH} characters, try again.")
            continue
        if getpass("  Confirm password: ") != password:
            print("  Passwords didn't match, try again.")
            continue
        return password


def main() -> None:
    init_db()
    remove_placeholder_user()

    for username, role in ACCOUNTS:
        if get_user_by_username(username):
            print(f"Skipping '{username}': already exists.")
            continue
        password = prompt_password(username)
        create_user(username, hash_password(password), role)
        print(f"Created {role} account '{username}'.")

    print("\nUsers now in the database:")
    conn = get_connection()
    for row in conn.execute("SELECT id, username, role, token_version FROM users"):
        print(f"  id={row['id']}  username={row['username']}  role={row['role']}  token_version={row['token_version']}")
    conn.close()


if __name__ == "__main__":
    main()
"""
check_login.py — checks whether a username/password pair is correct by
verifying it against the stored bcrypt hash, exactly like a real login
will. Prints neither the password nor the hash.

Run from src/:   python check_login.py
"""

from getpass import getpass

from auth import verify_password
from database import get_user_by_username

username = input("Username: ").strip()
password = getpass("Password (typing is hidden): ")

user = get_user_by_username(username)
if user is None:
    print("No such user.")
elif verify_password(password, user["password_hash"]):
    print(f"Correct password. Role: {user['role']}")
else:
    print("Wrong password.")
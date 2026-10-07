"""
auth.py — password hashing and JWT-based authentication.

Two separate concerns, kept clearly apart:
- passlib handles PASSWORDS: hashing at signup, verifying at login.
- python-jose handles TOKENS: creating a JWT after login succeeds,
  decoding/verifying it on every later request.

The JWT payload carries the user's role and their token_version at the
moment of login. On every request, the current token_version is
re-checked against what's stored in the database — if an admin has
since changed this user's role (which bumps token_version in
database.py), the mismatch is caught here and the token is rejected,
forcing a fresh login. This is what makes a role change take effect
immediately instead of silently waiting for the old token to expire.
"""

import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import Depends, Header, HTTPException
from jose import JWTError, jwt
from passlib.context import CryptContext

from database import ROLE_HIERARCHY, get_user_by_username

# The signing key comes from the environment (or a .env file in the project
# root, doc_rag/.env), never from source code: anyone who knows it can forge
# a token for any user, including an Admin. The app refuses to start without
# a proper key instead of falling back to an insecure default.
load_dotenv(Path(__file__).resolve().parent.parent / ".env")
SECRET_KEY = os.environ.get("DOCRAG_SECRET_KEY", "")
if len(SECRET_KEY) < 32:
    raise RuntimeError(
        "DOCRAG_SECRET_KEY is missing or too short (it needs 32+ characters). "
        "Generate one and save it in doc_rag/.env as DOCRAG_SECRET_KEY=<key>."
    )
ALGORITHM = "HS256"
TOKEN_EXPIRE_MINUTES = 60

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


# ---------------------------------------------------------------------
# Passwords — passlib only, never touches tokens
# ---------------------------------------------------------------------

def hash_password(plain_password: str) -> str:
    return pwd_context.hash(plain_password)


def verify_password(plain_password: str, password_hash: str) -> bool:
    return pwd_context.verify(plain_password, password_hash)


# ---------------------------------------------------------------------
# Tokens — python-jose only, never touches passwords
# ---------------------------------------------------------------------

def create_access_token(username: str, role: str, token_version: int) -> str:
    """
    Build a signed JWT after a successful login. token_version is baked
    in as a snapshot of what the database said at this exact moment —
    it is what gets compared against the database on every later request.
    """
    expire = datetime.now(timezone.utc) + timedelta(minutes=TOKEN_EXPIRE_MINUTES)
    payload = {
        "sub": username,
        "role": role,
        "token_version": token_version,
        "exp": expire,
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def decode_access_token(token: str) -> dict:
    """
    Verify a token's signature and expiry, and return its payload.
    Raises HTTPException(401) on any failure — expired, tampered, or
    malformed — never returns a partially-trusted result.
    """
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token.")


# ---------------------------------------------------------------------
# FastAPI dependencies — the enforcement layer, used with Depends()
# ---------------------------------------------------------------------

def get_current_user(authorization: Optional[str] = Header(None)) -> dict:
    """
    Extracts and verifies the bearer token from the Authorization header,
    then confirms its token_version still matches the database — catching
    the case where an admin changed this user's role since they logged in.
    Always raises HTTPException on failure; there is no "guest" fallback
    here deliberately, since every RBAC-protected route needs a real,
    current identity to check a role against.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Not authenticated.")

    token = authorization[len("Bearer "):].strip()
    payload = decode_access_token(token)

    username = payload.get("sub")
    token_version_in_token = payload.get("token_version")

    user = get_user_by_username(username)
    if user is None:
        raise HTTPException(status_code=401, detail="User no longer exists.")

    if user["token_version"] != token_version_in_token:
        raise HTTPException(status_code=401, detail="Session expired, please log in again.")

    return {"username": user["username"], "role": user["role"]}


def require_role(minimum_role: str):
    """
    Dependency factory — use as Depends(require_role("Admin")) on any
    route that needs at least that role. Respects hierarchy: a higher
    role automatically satisfies a lower requirement (Admin passes a
    Staff-level check), matching database.py's ROLE_HIERARCHY.
    """
    def checker(current_user: dict = Depends(get_current_user)) -> dict:
        user_level = ROLE_HIERARCHY.index(current_user["role"])
        required_level = ROLE_HIERARCHY.index(minimum_role)
        if user_level < required_level:
            raise HTTPException(status_code=403, detail="Insufficient permissions.")
        return current_user
    return checker


if __name__ == "__main__":
    # Test password hashing
    hashed = hash_password("testpassword123")
    print("Hash:", hashed)
    print("Verify correct password:", verify_password("testpassword123", hashed))
    print("Verify wrong password:", verify_password("wrongpassword", hashed))

    # Test token creation and decoding
    token = create_access_token(username="test_admin", role="Admin", token_version=1)
    print("\nToken:", token)

    decoded = decode_access_token(token)
    print("Decoded payload:", decoded)
"""
crypto_store.py — Encryption at rest for the data this app keeps on disk.

What it protects against: someone getting the FILES (a stolen laptop, a copied
Docker volume, a leaked backup) without getting the running app and its
passphrase. It does not protect against a person who is logged in to the running
app; role-based access control (RBAC) handles that.

How it works
  * You give the app a passphrase (environment variable RAG_PASSPHRASE, or a file
    whose path is in RAG_PASSPHRASE_FILE, which is how Docker secrets are passed).
  * The passphrase is stretched into a 256-bit key with scrypt, a deliberately
    slow function, so guessing passphrases offline is expensive.
  * Every secret is encrypted with AES-256-GCM. GCM is "authenticated": if even
    one byte of the stored data is changed, decryption fails loudly instead of
    returning garbage.
  * Each encryption uses a fresh random 12-byte nonce, so encrypting the same
    text twice gives different results.
  * The key is never written to disk. Only a random salt and a small encrypted
    "check value" are stored (data/crypto_meta.json), so a wrong passphrase is
    caught at startup instead of silently corrupting things.

Modes
  * No passphrase and no crypto_meta.json yet: encryption is OFF (a warning is
    logged), so the app still runs exactly as before.
  * crypto_meta.json exists but no passphrase is supplied: the app REFUSES to
    start. Failing closed is safer than quietly writing new data in plaintext.

Old plaintext data still reads fine: decrypt_* returns anything that does not
carry our marker unchanged. That lets the migration script convert files one at
a time, and the app keeps working in between.
"""

import base64
import json
import logging
import os
import threading
from typing import Optional

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

log = logging.getLogger("rag.crypto")

# Where the salt and check value live (data/crypto_meta.json). Tests point this
# at a temporary folder with RAG_DATA_DIR so they never touch real data.
_DEFAULT_DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")

BYTES_MARKER = b"RAGENC1:"     # first bytes of every encrypted blob
TEXT_MARKER = "enc1:"           # first characters of every encrypted string
_CHECK_PLAINTEXT = b"rag-passphrase-check"

# scrypt cost: about 100 ms and 32 MB of memory per guess. Cheap for us once at
# startup, expensive for an attacker trying millions of guesses.
_SCRYPT_N, _SCRYPT_R, _SCRYPT_P = 2 ** 15, 8, 1

_lock = threading.Lock()
_state = {"loaded": False, "aes": None}


class EncryptionError(RuntimeError):
    """Raised for a wrong passphrase, a missing passphrase, or tampered data."""


def _data_dir() -> str:
    return os.environ.get("RAG_DATA_DIR") or _DEFAULT_DATA_DIR


def _meta_path() -> str:
    return os.path.join(_data_dir(), "crypto_meta.json")


def _passphrase() -> Optional[str]:
    """The passphrase from the environment, or None if none was supplied."""
    value = os.environ.get("RAG_PASSPHRASE")
    if value:
        return value
    path = os.environ.get("RAG_PASSPHRASE_FILE")
    if path:
        with open(path, "r", encoding="utf-8") as f:
            return f.read().strip() or None
    return None


def _derive_key(passphrase: str, salt: bytes) -> bytes:
    kdf = Scrypt(salt=salt, length=32, n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P)
    return kdf.derive(passphrase.encode("utf-8"))


def _raw_encrypt(aes: AESGCM, data: bytes, context: bytes) -> bytes:
    nonce = os.urandom(12)
    return nonce + aes.encrypt(nonce, data, context or None)


def _raw_decrypt(aes: AESGCM, blob: bytes, context: bytes) -> bytes:
    if len(blob) < 12 + 16:
        raise EncryptionError("Encrypted data is truncated.")
    nonce, body = blob[:12], blob[12:]
    try:
        return aes.decrypt(nonce, body, context or None)
    except InvalidTag:
        raise EncryptionError(
            "Could not decrypt: the data was altered, or it belongs to a different record or passphrase."
        )


def _load() -> Optional[AESGCM]:
    """Set up the cipher once. Returns None when encryption is switched off."""
    with _lock:
        if _state["loaded"]:
            return _state["aes"]

        meta_file = _meta_path()
        passphrase = _passphrase()
        meta = None
        if os.path.exists(meta_file):
            with open(meta_file, "r", encoding="utf-8") as f:
                meta = json.load(f)

        if meta is None and passphrase is None:
            log.warning("Encryption at rest is OFF: set RAG_PASSPHRASE to turn it on.")
            _state.update(loaded=True, aes=None)
            return None

        if meta is not None and passphrase is None:
            raise EncryptionError(
                "This data is encrypted, but no passphrase was supplied. "
                "Set RAG_PASSPHRASE (or RAG_PASSPHRASE_FILE) and start again."
            )

        if meta is None:  # first run with a passphrase: create the salt and check value
            salt = os.urandom(16)
            aes = AESGCM(_derive_key(passphrase, salt))
            check = _raw_encrypt(aes, _CHECK_PLAINTEXT, b"check")
            os.makedirs(os.path.dirname(meta_file), exist_ok=True)
            with open(meta_file, "w", encoding="utf-8") as f:
                json.dump({
                    "version": 1,
                    "kdf": "scrypt",
                    "salt": base64.b64encode(salt).decode(),
                    "check": base64.b64encode(check).decode(),
                }, f)
            log.info("Encryption at rest enabled (new key set up).")
        else:  # existing setup: rebuild the key and prove the passphrase is right
            salt = base64.b64decode(meta["salt"])
            aes = AESGCM(_derive_key(passphrase, salt))
            try:
                ok = _raw_decrypt(aes, base64.b64decode(meta["check"]), b"check") == _CHECK_PLAINTEXT
            except EncryptionError:
                ok = False
            if not ok:
                raise EncryptionError("Wrong passphrase for the encrypted data.")

        _state.update(loaded=True, aes=aes)
        return aes


def reset_for_tests() -> None:
    """Forget the loaded key so a test can start from a clean state."""
    with _lock:
        _state.update(loaded=False, aes=None)


def enabled() -> bool:
    """True when encryption is on (a passphrase is set and verified)."""
    return _load() is not None


def startup_check() -> None:
    """Call once when the app starts, so a missing or wrong passphrase stops it
    immediately with a clear message."""
    _load()


def is_encrypted_bytes(blob: bytes) -> bool:
    return blob.startswith(BYTES_MARKER)


def is_encrypted_text(text: str) -> bool:
    return isinstance(text, str) and text.startswith(TEXT_MARKER)


def encrypt_bytes(data: bytes, context: bytes = b"") -> bytes:
    """Encrypt bytes (for example a PDF). `context` is extra data that is
    authenticated but not stored, such as the file's hash: data encrypted for one
    record then fails to decrypt if someone moves it into another record."""
    aes = _load()
    if aes is None or is_encrypted_bytes(data):
        return data
    return BYTES_MARKER + _raw_encrypt(aes, data, context)


def decrypt_bytes(blob: bytes, context: bytes = b"") -> bytes:
    """Decrypt bytes made by encrypt_bytes. Plaintext (old data) is returned as is."""
    if not is_encrypted_bytes(blob):
        return blob
    aes = _load()
    if aes is None:
        raise EncryptionError("Data is encrypted but no passphrase is set.")
    return _raw_decrypt(aes, blob[len(BYTES_MARKER):], context)


def encrypt_text(text: str, context: str = "") -> str:
    """Encrypt a string into a string safe for a database column."""
    aes = _load()
    if aes is None or is_encrypted_text(text):
        return text
    blob = _raw_encrypt(aes, text.encode("utf-8"), context.encode("utf-8"))
    return TEXT_MARKER + base64.b64encode(blob).decode("ascii")


def decrypt_text(text: str, context: str = "") -> str:
    """Decrypt a string made by encrypt_text. Plaintext (old data) is returned as is."""
    if not is_encrypted_text(text):
        return text
    aes = _load()
    if aes is None:
        raise EncryptionError("Data is encrypted but no passphrase is set.")
    blob = base64.b64decode(text[len(TEXT_MARKER):])
    return _raw_decrypt(aes, blob, context.encode("utf-8")).decode("utf-8")

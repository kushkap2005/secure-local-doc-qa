"""
test_crypto_store.py — Checks every promise crypto_store.py makes.

Run:  python src/test_crypto_store.py

It works in a temporary folder (RAG_DATA_DIR), so it never touches your real data.
"""

import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import crypto_store as cs

failures = []


def check(name, condition):
    print(("PASS  " if condition else "FAIL  ") + name)
    if not condition:
        failures.append(name)


def fresh(passphrase=None, data_dir=None):
    """Start the module from scratch with the given environment."""
    for var in ("RAG_PASSPHRASE", "RAG_PASSPHRASE_FILE"):
        os.environ.pop(var, None)
    if passphrase is not None:
        os.environ["RAG_PASSPHRASE"] = passphrase
    os.environ["RAG_DATA_DIR"] = data_dir
    cs.reset_for_tests()


def raises(fn, *args, **kwargs):
    try:
        fn(*args, **kwargs)
    except cs.EncryptionError:
        return True
    return False


with tempfile.TemporaryDirectory() as tmp:
    # 1. Off by default: nothing changes, nothing is created.
    fresh(None, tmp)
    check("off: enabled() is False", cs.enabled() is False)
    check("off: text passes through unchanged", cs.encrypt_text("hello") == "hello")
    check("off: bytes pass through unchanged", cs.encrypt_bytes(b"hello") == b"hello")
    check("off: no crypto_meta.json created", not os.path.exists(os.path.join(tmp, "crypto_meta.json")))

    # 2. Turn on: first run creates the salt and check value.
    fresh("correct horse battery staple", tmp)
    check("on: enabled() is True", cs.enabled() is True)
    meta_path = os.path.join(tmp, "crypto_meta.json")
    check("on: crypto_meta.json created", os.path.exists(meta_path))
    meta = json.load(open(meta_path))
    check("on: meta holds salt and check but no key or passphrase",
          set(meta) == {"version", "kdf", "salt", "check"} and "staple" not in json.dumps(meta))

    # 3. Round trips
    secret_text = "The chlorophyll absorbs red and blue light. ünïcode ✓"
    enc = cs.encrypt_text(secret_text)
    check("text: ciphertext differs from plaintext", enc != secret_text and "chlorophyll" not in enc)
    check("text: ciphertext starts with the marker", enc.startswith("enc1:"))
    check("text: round trip is exact", cs.decrypt_text(enc) == secret_text)
    check("text: same input encrypts differently each time", cs.encrypt_text(secret_text) != enc)
    check("text: encrypting twice does not double-encrypt", cs.encrypt_text(enc) == enc)

    pdf = b"%PDF-1.7\n" + os.urandom(5000)
    blob = cs.encrypt_bytes(pdf, context=b"hash123")
    check("bytes: ciphertext hides the PDF header", b"%PDF-" not in blob)
    check("bytes: round trip is exact", cs.decrypt_bytes(blob, context=b"hash123") == pdf)

    # 4. Old plaintext still reads (this is what makes step-by-step migration safe).
    check("legacy: plaintext text reads unchanged", cs.decrypt_text("old plain text") == "old plain text")
    check("legacy: plaintext bytes read unchanged", cs.decrypt_bytes(b"old plain bytes") == b"old plain bytes")

    # 5. Tampering and moving data are detected.
    flipped = bytearray(blob)
    flipped[-5] ^= 0x01
    check("tamper: one changed byte is detected", raises(cs.decrypt_bytes, bytes(flipped), b"hash123"))
    check("context: ciphertext moved to another record is rejected", raises(cs.decrypt_bytes, blob, b"other-hash"))
    check("context: text moved to another record is rejected",
          raises(cs.decrypt_text, cs.encrypt_text("x", context="a"), "b"))
    check("tamper: truncated data is rejected", raises(cs.decrypt_bytes, cs.BYTES_MARKER + b"short"))

    # 6. Restart with the right passphrase: old ciphertext still opens.
    fresh("correct horse battery staple", tmp)
    check("restart: same passphrase decrypts earlier data", cs.decrypt_text(enc) == secret_text)

    # 7. Wrong passphrase stops the app with a clear error.
    fresh("wrong passphrase", tmp)
    check("wrong passphrase: startup_check fails", raises(cs.startup_check))

    # 8. Fail closed: data is encrypted but no passphrase supplied.
    fresh(None, tmp)
    check("no passphrase on encrypted data: startup refuses", raises(cs.startup_check))

    # 9. Passphrase from a file (how Docker secrets are passed).
    key_file = os.path.join(tmp, "pass.txt")
    open(key_file, "w").write("correct horse battery staple\n")
    fresh(None, tmp)
    os.environ["RAG_PASSPHRASE_FILE"] = key_file
    cs.reset_for_tests()
    check("passphrase file: works", cs.decrypt_text(enc) == secret_text)

print()
if failures:
    print(f"{len(failures)} check(s) FAILED")
    sys.exit(1)
print("All checks passed")

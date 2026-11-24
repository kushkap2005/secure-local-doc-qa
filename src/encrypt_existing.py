"""
encrypt_existing.py — Encrypt the data that was stored before encryption at rest
was switched on: saved PDFs, the page cache, chunk text in the vector database,
and chat history.

Run from the repo root, with the API STOPPED and the passphrase set:
    export RAG_PASSPHRASE_FILE=~/.rag_passphrase
    python src/encrypt_existing.py --dry-run   # only counts what would change
    python src/encrypt_existing.py             # does it

Safe to run more than once: anything already encrypted is skipped. Safe to stop
halfway: the app reads old plaintext and new ciphertext side by side, so a
half-finished run leaves the app working, and running it again finishes the job.

Before changing anything it copies data/ to data/_plain_backup_<time>/ (a
plaintext copy). Delete that folder once you've checked the app works; until
then the protection is not complete.

What is NOT changed:
  * the search vectors (the database needs them to search; see the write-up),
  * the audit log (append-only by design; holds actions and file names, no
    document text or questions),
  * user accounts (passwords are already stored as bcrypt hashes).
"""

import argparse
import os
import shutil
import socket
import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import crypto_store as cs  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("RAG_DATA_DIR") or ROOT / "data")
PDF_DIR = DATA / "pdfs"
CACHE_DIR = DATA / "page_cache"
CHROMA_DIR = DATA / "chroma_db"
APP_DB = DATA / "app.db"
COLLECTION = "documents"
BATCH = 200


def _write_atomic(path: Path, data: bytes) -> None:
    """Write to a .part file and rename it, so a crash never leaves half a file."""
    part = path.with_name(path.name + ".part")
    part.write_bytes(data)
    os.replace(part, path)


def _server_running(port: int = 8000) -> bool:
    with socket.socket() as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


def encrypt_pdfs(dry: bool) -> int:
    done = 0
    for f in sorted(PDF_DIR.glob("*.pdf")) if PDF_DIR.is_dir() else []:
        raw = f.read_bytes()
        if cs.is_encrypted_bytes(raw):
            continue
        if not dry:
            # bound to the document hash (the file name), exactly as pdf_files.py does
            _write_atomic(f, cs.encrypt_bytes(raw, context=f.stem.encode()))
        done += 1
    return done


def encrypt_page_cache(dry: bool) -> int:
    done = 0
    for f in sorted(CACHE_DIR.glob("*.json")) if CACHE_DIR.is_dir() else []:
        text = f.read_text(encoding="utf-8")
        if cs.is_encrypted_text(text):
            continue
        if not dry:
            # bound to the PDF hash (the file name), exactly as page_reader.py does
            _write_atomic(f, cs.encrypt_text(text, context=f.stem).encode("utf-8"))
        done += 1
    return done


def _chunk_context(meta: dict) -> str:
    # bound to document and page, exactly as vector_store.py does
    return f"{meta.get('file_hash')}:{meta.get('page_number')}"


def encrypt_chunks(dry: bool) -> int:
    """Rebuild the vector database with encrypted chunk text.

    Why rebuild instead of updating rows in place: ChromaDB keeps a write-ahead
    log (the embeddings_queue table) with a copy of every write, including the
    original plain text, until its search index is saved. Updating the rows
    would leave that plaintext in the log. So every record is copied (same id,
    same vector, same metadata, encrypted text) into a NEW database folder whose
    log only ever sees ciphertext, and the folders are then swapped.
    """
    if not CHROMA_DIR.is_dir():
        return 0
    import chromadb

    old_client = chromadb.PersistentClient(path=str(CHROMA_DIR))
    old = old_client.get_collection(COLLECTION)
    data = old.get(include=["documents", "metadatas", "embeddings"])
    collection_meta = old.metadata
    todo = sum(1 for d in data["documents"] if d is not None and not cs.is_encrypted_text(d))
    if dry:
        return todo

    new_dir = CHROMA_DIR.with_name(CHROMA_DIR.name + "_encrypting")
    if new_dir.exists():
        shutil.rmtree(new_dir)  # left over from an interrupted run
    new_client = chromadb.PersistentClient(path=str(new_dir))
    new = new_client.create_collection(COLLECTION, metadata=collection_meta, embedding_function=None)
    n = len(data["ids"])
    for start in range(0, n, BATCH):
        idx = range(start, min(start + BATCH, n))
        new.add(
            ids=[data["ids"][i] for i in idx],
            embeddings=[data["embeddings"][i] for i in idx],  # the SAME vectors: nothing is re-embedded
            metadatas=[data["metadatas"][i] for i in idx],
            documents=[
                cs.encrypt_text(data["documents"][i], context=_chunk_context(data["metadatas"][i]))
                for i in idx
            ],
        )

    # Check the copy before swapping: same count, and every text decrypts back exactly.
    check = new.get(include=["documents", "metadatas"])
    copied = dict(zip(check["ids"], zip(check["documents"], check["metadatas"])))
    if len(copied) != n:
        sys.exit(f"Copy check failed: {len(copied)} of {n} chunks copied. Nothing was swapped.")
    for i, cid in enumerate(data["ids"]):
        enc, meta = copied[cid]
        original = cs.decrypt_text(data["documents"][i], context=_chunk_context(data["metadatas"][i]))
        if cs.decrypt_text(enc, context=_chunk_context(meta)) != original:
            sys.exit(f"Copy check failed on chunk {cid}. Nothing was swapped.")

    del old, new, old_client, new_client
    try:
        chromadb.api.client.SharedSystemClient.clear_system_cache()  # release open files
    except Exception:
        pass
    retired = CHROMA_DIR.with_name(CHROMA_DIR.name + "_retired")
    if retired.exists():
        shutil.rmtree(retired)
    os.replace(CHROMA_DIR, retired)
    os.replace(new_dir, CHROMA_DIR)
    shutil.rmtree(retired)  # its plaintext copy also sits in the backup folder until you delete that
    return todo


def encrypt_chats(dry: bool) -> int:
    if not APP_DB.is_file():
        return 0
    conn = sqlite3.connect(APP_DB)
    done = 0
    try:
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "conversations" in tables:
            for cid, title in conn.execute("SELECT id, title FROM conversations").fetchall():
                if title is not None and not cs.is_encrypted_text(title):
                    if not dry:
                        conn.execute("UPDATE conversations SET title = ? WHERE id = ?",
                                     (cs.encrypt_text(title, context=f"{cid}:title"), cid))
                    done += 1
        if "conversation_messages" in tables:
            rows = conn.execute(
                "SELECT id, conversation_id, text, question, sources FROM conversation_messages"
            ).fetchall()
            for mid, cid, text, question, sources in rows:
                new = []
                for field, value in (("text", text), ("question", question), ("sources", sources)):
                    if value is None or cs.is_encrypted_text(value):
                        new.append(value)
                    else:
                        # bound to conversation and field, exactly as chat_history.py does
                        new.append(cs.encrypt_text(value, context=f"{cid}:{field}"))
                if new != [text, question, sources]:
                    if not dry:
                        conn.execute(
                            "UPDATE conversation_messages SET text = ?, question = ?, sources = ? WHERE id = ?",
                            (*new, mid),
                        )
                    done += 1
        conn.commit()
    finally:
        conn.close()
    return done


def scrub_sqlite(path: Path) -> None:
    """SQLite keeps old, overwritten text in free pages until the file is rebuilt.
    VACUUM rebuilds it, so the old plaintext is really gone from disk."""
    if not path.is_file():
        return
    conn = sqlite3.connect(path)
    try:
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.execute("VACUUM")
    finally:
        conn.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="only count what would change")
    parser.add_argument("--no-backup", action="store_true", help="skip the plaintext backup copy")
    args = parser.parse_args()

    if not args.dry_run and _server_running():
        sys.exit("The API seems to be running on port 8000. Stop it first (Ctrl+C), then run this again.")
    try:
        if not cs.enabled():
            sys.exit("No passphrase set. Set RAG_PASSPHRASE or RAG_PASSPHRASE_FILE first.")
    except cs.EncryptionError as e:
        sys.exit(str(e))

    if not args.dry_run and not args.no_backup:
        backup = DATA / f"_plain_backup_{time.strftime('%Y%m%d_%H%M%S')}"
        targets = [p for p in (PDF_DIR, CACHE_DIR, CHROMA_DIR, APP_DB) if p.exists()]
        backup.mkdir()
        for p in targets:
            (shutil.copytree if p.is_dir() else shutil.copy2)(p, backup / p.name)
        print(f"Backup (plaintext) written to {backup.relative_to(ROOT)}")

    label = "would encrypt" if args.dry_run else "encrypted"
    print(f"Stored PDFs:      {encrypt_pdfs(args.dry_run)} {label}")
    print(f"Page cache files: {encrypt_page_cache(args.dry_run)} {label}")
    print(f"Chunk texts:      {encrypt_chunks(args.dry_run)} {label}")
    print(f"Chat records:     {encrypt_chats(args.dry_run)} {label}")

    if not args.dry_run:
        scrub_sqlite(APP_DB)
        print("Old plaintext pages removed from the SQLite files (VACUUM).")
        print("\nDone. Start the app with the same passphrase and check it works.")
        print("Then delete the data/_plain_backup_* folder: until you do, a plaintext copy remains.")


if __name__ == "__main__":
    main()

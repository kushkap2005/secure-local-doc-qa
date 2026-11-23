"""
reingest.py — rebuild the stored chunks of documents you already uploaded,
using the saved copy of each PDF in data/pdfs/.

Why: Phase 4 changed how PDFs are read (OCR for scanned pages, written
descriptions for diagrams). Documents uploaded earlier were read the old way,
so their image pages are missing from the search index. This script re-reads
each saved PDF with the new reader and replaces that document's chunks.

What it keeps the same:
  * the document's name (it is restored from what is already stored),
  * its hash, so permissions and the chat history's source chips still match,
  * the owner id the chunks are stored under.

Order of work for each document (so a failure never loses data):
  1. read the saved PDF with the new reader (the slow part; uses the cache
     that `page_reader.py --warm` filled, so it is quick after that),
  2. only if that worked: delete the document's old chunks,
  3. add the new chunks.

Run from the repo root with the API stopped (two programs writing to the
same ChromaDB folder at once is not safe):
    python src/reingest.py --dry-run       # shows what it would do, changes nothing
    python src/reingest.py                 # does it, for owner "shared"
    python src/reingest.py --owner guest   # for a different owner id

Take a backup first:   cp -r data/chroma_db data/chroma_db_backup
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from ingest import ingest_pdf  # noqa: E402
from vector_store import VectorStore  # noqa: E402

PDF_DIR = Path(__file__).resolve().parent.parent / "data" / "pdfs"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--owner", default="shared", help="owner id the chunks are stored under")
    parser.add_argument("--dry-run", action="store_true", help="only show what would change")
    parser.add_argument("--db", default=None, help="ChromaDB folder (default: the project's data/chroma_db)")
    args = parser.parse_args()

    store = VectorStore(args.db) if args.db else VectorStore()
    documents = store.list_documents(args.owner)
    if not documents:
        print(f"No documents stored for owner '{args.owner}'. Nothing to do.")
        return

    print(f"{len(documents)} document(s) for owner '{args.owner}':\n")
    done = 0
    for doc in documents:
        file_hash, name, old_count = doc["file_hash"], doc["source_file"], doc["chunks"]
        pdf = PDF_DIR / f"{file_hash}.pdf"
        if not pdf.is_file():
            print(f"  SKIP  {name}: no saved copy at data/pdfs/{file_hash[:12]}...pdf")
            continue
        if args.dry_run:
            print(f"  would re-read {name}  (now {old_count} chunks)")
            continue

        try:
            chunks = ingest_pdf(str(pdf))  # step 1: read with the new reader
        except Exception as e:
            print(f"  FAILED {name}: {e}  -> old chunks left untouched")
            continue
        for c in chunks:
            c.source_file = name  # ingest_pdf names chunks after the file on disk (the hash); restore the real name

        store.vectorstore.delete(  # step 2: remove this document's old chunks
            where={"$and": [{"user_id": args.owner}, {"file_hash": file_hash}]}
        )
        added = store.add_chunks(chunks, file_hash, args.owner)  # step 3
        print(f"  OK    {name}: {old_count} -> {added} chunks")
        done += 1

    if not args.dry_run:
        print(f"\nRe-ingested {done} of {len(documents)} document(s).")


if __name__ == "__main__":
    main()
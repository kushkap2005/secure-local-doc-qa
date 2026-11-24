"""
pdf_files.py — Feature 3 (server side): keep the uploaded PDFs and serve them
back, but only to roles that are allowed to see them.

Until now the server read each PDF, stored its text chunks, and deleted the
file. The built-in PDF viewer needs the original, so this file:

  * save_pdf(path, file_hash)   copies an uploaded PDF into data/pdfs/
  * delete_all_pdfs()           empties that folder (used by "Clear all documents")
  * GET /documents/{file_hash}/pdf   sends one stored PDF to the viewer
  * GET /documents/{file_hash}/pages/{page}/text   the stored text of one page
        (used when an OLD saved answer's source chip is clicked: chat history
        keeps no document text, so the text is fetched again at that moment,
        under the viewer's CURRENT role). With ?q=<the old question> it also
        returns "best": the one or two chunks on that page closest in meaning
        to that question, so the viewer can highlight the passage again.

Access rule for the GET route: exactly the same as searching. The caller must
be signed in, and the document must be one their role may see
(visible_hashes). Anything else gets 404, the same answer as for a document
that doesn't exist, so a lower role can't tell a hidden document is there.
The file name on disk is the document's SHA-256 hash, and the route only
accepts 64 hex characters, so a request can never point at another path.

How it plugs into api.py (four small edits, shown with the upload message):
    from pdf_files import make_router as make_pdf_router, save_pdf, delete_all_pdfs
    app.include_router(make_pdf_router(visible_hashes, store, SHARED_DOCS_ID))
    ... save_pdf(tmp_path, file_hash)      inside /upload, after set_document_permission
    ... delete_all_pdfs()                  inside /reset

To remove: undo those edits and delete this file. The viewer then simply says
the PDF isn't available.
"""

import logging
import os
import re

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from fastapi.responses import Response

from auth import require_role
from crypto_store import EncryptionError, decrypt_bytes, decrypt_text, encrypt_bytes

log = logging.getLogger("rag.pdf")

PDF_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "pdfs")
_HASH = re.compile(r"[0-9a-f]{64}")


def _path_for(file_hash: str) -> str:
    return os.path.join(PDF_DIR, f"{file_hash}.pdf")


def read_pdf(file_hash: str) -> bytes:
    """The stored PDF's bytes, decrypted when encryption is on. The document's
    hash is bound into the encryption, so a stored file copied under another
    document's name will not decrypt."""
    with open(_path_for(file_hash), "rb") as f:
        return decrypt_bytes(f.read(), context=file_hash.encode())


def save_pdf(source_path: str, file_hash: str) -> None:
    """Keep a copy of an uploaded PDF. Never fails the upload: if the copy
    can't be made, the document is still searchable, just not viewable."""
    try:
        if not _HASH.fullmatch(file_hash):
            return
        os.makedirs(PDF_DIR, exist_ok=True)
        target = _path_for(file_hash)
        partial = target + ".part"
        with open(source_path, "rb") as f:
            data = f.read()
        with open(partial, "wb") as f:
            f.write(encrypt_bytes(data, context=file_hash.encode()))  # no-op when encryption is off
        os.replace(partial, target)  # a half-copied file is never served
    except (OSError, EncryptionError):
        log.exception("Could not store the PDF copy for %s", file_hash[:12])


def delete_all_pdfs() -> None:
    """Remove every stored PDF (used when all documents are cleared)."""
    try:
        for name in os.listdir(PDF_DIR):
            if name.endswith(".pdf") or name.endswith(".part"):
                try:
                    os.unlink(os.path.join(PDF_DIR, name))
                except OSError:
                    pass
    except FileNotFoundError:
        pass


def _chunk_order(chunk_id: str) -> int:
    """Chunks of a page come back in any order; their ids end in _c<number>."""
    m = re.search(r"_c(\d+)$", chunk_id or "")
    return int(m.group(1)) if m else 0


def make_router(visible_hashes, store=None, shared_docs_id: str = "shared") -> APIRouter:
    router = APIRouter()

    @router.get("/documents/{file_hash}/pdf")
    def get_pdf(file_hash: str, current_user: dict = Depends(require_role("Guest"))):
        not_found = HTTPException(status_code=404, detail="PDF not available.")
        if not _HASH.fullmatch(file_hash):
            raise not_found
        if file_hash not in visible_hashes(current_user["role"]):
            raise not_found
        path = _path_for(file_hash)
        if not os.path.isfile(path):
            raise not_found  # e.g. uploaded before this feature existed
        try:
            data = read_pdf(file_hash)
        except (OSError, EncryptionError):
            log.exception("Could not read the stored PDF %s", file_hash[:12])
            raise HTTPException(status_code=500, detail="The stored PDF could not be opened.")
        return Response(
            content=data,
            media_type="application/pdf",
            headers={"Cache-Control": "private, no-store", "Content-Disposition": "inline"},
        )


    if store is not None:

        @router.get("/documents/{file_hash}/pages/{page}/text")
        def get_page_text(
            file_hash: str,
            page: int = Path(..., ge=1, le=100000),
            q: Optional[str] = Query(None, max_length=4000),
            current_user: dict = Depends(require_role("Guest")),
        ):
            not_found = HTTPException(status_code=404, detail="Text not available.")
            if not _HASH.fullmatch(file_hash):
                raise not_found
            if file_hash not in visible_hashes(current_user["role"]):
                raise not_found  # same answer as "doesn't exist"
            page_where = {
                "$and": [
                    {"user_id": shared_docs_id},
                    {"file_hash": file_hash},
                    {"page_number": page},
                ]
            }
            found = store.vectorstore.get(where=page_where, include=["documents"])
            pairs = sorted(zip(found.get("ids", []), found.get("documents", [])), key=lambda p: _chunk_order(p[0]))
            # stored chunk text may be encrypted; each chunk is bound to this document and page
            chunks = [decrypt_text(text, context=f"{file_hash}:{page}") for _id, text in pairs if text]
            if not chunks:
                raise not_found
            result = {"page": page, "chunks": chunks}
            if q and q.strip():
                # Which passage on this page was the answer built from? Not stored
                # (history keeps no document text), so find it again: same embedding
                # and distance as a normal search, but only this page's chunks.
                try:
                    scored = store.vectorstore.similarity_search_with_score(
                        q.strip(), k=min(2, len(chunks)), filter=page_where
                    )
                    best = [
                        (1 - dist, decrypt_text(doc.page_content, context=f"{file_hash}:{page}"))
                        for doc, dist in scored
                        if doc.page_content
                    ]
                    best.sort(key=lambda t: t[0], reverse=True)
                    # the best one, plus the runner-up only if it is nearly as close
                    result["best"] = [text for i, (score, text) in enumerate(best) if i == 0 or score >= best[0][0] - 0.05]
                except Exception:
                    pass  # no highlight is better than no page text
            return result

    return router
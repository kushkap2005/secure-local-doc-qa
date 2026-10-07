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
        under the viewer's CURRENT role)

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

import os
import re
import shutil

from fastapi import APIRouter, Depends, HTTPException, Path
from fastapi.responses import FileResponse

from auth import require_role

PDF_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "pdfs")
_HASH = re.compile(r"[0-9a-f]{64}")


def _path_for(file_hash: str) -> str:
    return os.path.join(PDF_DIR, f"{file_hash}.pdf")


def save_pdf(source_path: str, file_hash: str) -> None:
    """Keep a copy of an uploaded PDF. Never fails the upload: if the copy
    can't be made, the document is still searchable, just not viewable."""
    try:
        if not _HASH.fullmatch(file_hash):
            return
        os.makedirs(PDF_DIR, exist_ok=True)
        target = _path_for(file_hash)
        partial = target + ".part"
        shutil.copyfile(source_path, partial)
        os.replace(partial, target)  # a half-copied file is never served
    except OSError:
        pass


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
        return FileResponse(
            path,
            media_type="application/pdf",
            headers={"Cache-Control": "private, no-store", "Content-Disposition": "inline"},
        )


    if store is not None:

        @router.get("/documents/{file_hash}/pages/{page}/text")
        def get_page_text(
            file_hash: str,
            page: int = Path(..., ge=1, le=100000),
            current_user: dict = Depends(require_role("Guest")),
        ):
            not_found = HTTPException(status_code=404, detail="Text not available.")
            if not _HASH.fullmatch(file_hash):
                raise not_found
            if file_hash not in visible_hashes(current_user["role"]):
                raise not_found  # same answer as "doesn't exist"
            found = store.vectorstore.get(
                where={
                    "$and": [
                        {"user_id": shared_docs_id},
                        {"file_hash": file_hash},
                        {"page_number": page},
                    ]
                },
                include=["documents"],
            )
            pairs = sorted(zip(found.get("ids", []), found.get("documents", [])), key=lambda p: _chunk_order(p[0]))
            chunks = [text for _id, text in pairs if text]
            if not chunks:
                raise not_found
            return {"page": page, "chunks": chunks}

    return router
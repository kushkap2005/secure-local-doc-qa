"""
api.py — FastAPI backend for the RAG pipeline, with role-based access control.

Who can call what (roles are hierarchical: Admin > Staff > Guest):

  POST   /login                        anyone (this is how you get a token)
  GET    /status                       anyone (health check); chunk count only when signed in
  GET    /me                           any logged-in user
  GET    /documents                    Guest and above (lists only documents YOUR role may see)
  POST   /ask                          Guest and above (searches only documents your role may see)
  POST   /upload                       Staff and above (uploader picks who can see the document)
  DELETE /reset                        Admin only
  POST   /admin/users                  Admin only (create an account)
  PUT    /admin/users/{username}/role  Admin only (change someone's role)
  PUT    /admin/documents/{file_hash}/role  Admin only (change who can see a document)

Authentication and the role checks themselves live in auth.py; this file
only decides which routes need which role, via Depends(require_role(...)).

Document-level permissions: every uploaded document gets a minimum role (stored
in database.py by the document's content hash). Before searching or listing, the
API works out which documents the caller's role may see and passes that list down
to retrieval, so restricted text never reaches the model. A document with no
recorded level is Admin-only (default deny).
"""

import hashlib
import os
import tempfile
from typing import Optional

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from auth import (
    create_access_token,
    get_current_user,
    hash_password,
    require_role,
    verify_password,
)
from database import (
    DEFAULT_REQUIRED_ROLE,
    ROLE_HIERARCHY,
    clear_document_permissions,
    create_user,
    get_accessible_file_hashes,
    get_all_document_roles,
    get_user_by_username,
    init_db,
    set_document_permission,
    update_user_role,
)
from ingest import ingest_pdf

try:
    from ingest import PasswordRequiredError
except ImportError:  # an ingest.py without password-protected-PDF support
    class PasswordRequiredError(Exception):
        pass

from rag_pipeline import answer_question
from vector_store import VectorStore

app = FastAPI(title="Local Document Q&A API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

init_db()  # creates the users / document_permissions tables if missing
store = VectorStore()

from audit_log import install as install_audit_log
install_audit_log(app)

MAX_FILE_SIZE = 100 * 1024 * 1024  # 100 MB — matches the limit shown in the frontend
UPLOAD_CHUNK_SIZE = 1024 * 1024  # stream in 1 MB pieces so large files don't spike RAM

# vector_store.py scopes documents by a user_id argument. RBAC needs ONE
# shared document pool that every role queries (Staff upload, everyone asks),
# so every call passes this same constant instead of a per-account id.
SHARED_DOCS_ID = "shared"

# Feature 14: Admin dashboard (read-only numbers, Admin only) lives in its own file.
from admin_dashboard import make_router as make_dashboard_router
app.include_router(make_dashboard_router(store, SHARED_DOCS_ID))

# Feature 4: saved chat history (per-user conversations) lives in its own file.
from chat_history import make_router as make_chat_router
app.include_router(make_chat_router())



def visible_hashes(role: str) -> list:
    """Content hashes of the stored documents this role may see (hierarchy +
    default deny, decided in database.py)."""
    all_hashes = [d["file_hash"] for d in store.list_documents(SHARED_DOCS_ID)]
    return get_accessible_file_hashes(role, all_hashes)
# Feature 1: streaming answers (POST /ask/stream) lives in its own file.
# It sits here, after visible_hashes(), because it is handed that function.
from streaming import make_router as make_stream_router
app.include_router(make_stream_router(store, SHARED_DOCS_ID, visible_hashes))

# Forgiving spelling: weak matches get a second search with the spelling fixed.
from spellfix import install as install_spellfix
install_spellfix(store)

# Feature 3: keep uploaded PDFs and serve them (role-checked) to the PDF viewer.
from pdf_files import make_router as make_pdf_router, save_pdf, delete_all_pdfs
app.include_router(make_pdf_router(visible_hashes, store, SHARED_DOCS_ID))
from account_settings import make_router as make_account_router
app.include_router(make_account_router())


def optional_user(authorization: Optional[str] = Header(None)) -> Optional[dict]:
    """Like get_current_user, but returns None instead of raising a 401 — for
    routes that are public but can say more to someone who is signed in."""
    try:
        return get_current_user(authorization)
    except HTTPException:
        return None


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class LoginRequest(BaseModel):
    username: str
    password: str


class AskRequest(BaseModel):
    question: str = Field(..., min_length=1)
    top_k: int = Field(default=5, ge=1, le=20)


class CreateUserRequest(BaseModel):
    username: str = Field(..., min_length=3)
    password: str = Field(..., min_length=8)
    role: str


class ChangeRoleRequest(BaseModel):
    new_role: str


class ChangeDocumentLevelRequest(BaseModel):
    min_role: str


# ---------------------------------------------------------------------------
# Authentication
# ---------------------------------------------------------------------------

@app.post("/login")
def login(body: LoginRequest):
    user = get_user_by_username(body.username.strip())

    # Same message whether the username or the password was wrong, so the
    # response never reveals which usernames exist.
    if user is None or not verify_password(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Incorrect username or password.")

    token = create_access_token(
        username=user["username"],
        role=user["role"],
        token_version=user["token_version"],
    )
    return {
        "access_token": token,
        "token_type": "bearer",
        "username": user["username"],
        "role": user["role"],
    }


@app.get("/me")
def me(current_user: dict = Depends(get_current_user)):
    return current_user


# ---------------------------------------------------------------------------
# Documents and Q&A
# ---------------------------------------------------------------------------

@app.get("/status")
def status(user: Optional[dict] = Depends(optional_user)):
    # Public so the page can show "online" before login, but the chunk count is
    # only revealed to a signed-in user, and only for documents their role may see.
    if user is None:
        return {"chunks_indexed": 0}
    return {"chunks_indexed": store.count(SHARED_DOCS_ID, visible_hashes(user["role"]))}


@app.get("/documents")
def list_documents(current_user: dict = Depends(require_role("Guest"))):
    """The documents this caller's role may see, with who may see each one."""
    documents = store.list_documents(SHARED_DOCS_ID)
    levels = get_all_document_roles()
    allowed = set(get_accessible_file_hashes(current_user["role"], [d["file_hash"] for d in documents]))
    return [
        {**doc, "min_role": levels.get(doc["file_hash"], DEFAULT_REQUIRED_ROLE)}
        for doc in documents
        if doc["file_hash"] in allowed
    ]


@app.post("/upload")
async def upload(
    file: UploadFile = File(...),
    min_role: str = Form("Staff"),
    current_user: dict = Depends(require_role("Staff")),
):
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported.")
    if min_role not in ROLE_HIERARCHY:
        raise HTTPException(status_code=400, detail=f"Level must be one of {ROLE_HIERARCHY}.")
    if ROLE_HIERARCHY.index(min_role) > ROLE_HIERARCHY.index(current_user["role"]):
        # A document the uploader's own role couldn't read back would be a trap.
        raise HTTPException(status_code=400, detail="You can't set a document level higher than your own role.")

    tmp_path = None
    hasher = hashlib.sha256()
    try:
        total_bytes = 0
        with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp:
            tmp_path = tmp.name
            while True:
                piece = await file.read(UPLOAD_CHUNK_SIZE)
                if not piece:
                    break
                total_bytes += len(piece)
                if total_bytes > MAX_FILE_SIZE:
                    raise HTTPException(
                        status_code=413,
                        detail=f"File exceeds the {MAX_FILE_SIZE // (1024 * 1024)} MB upload limit.",
                    )
                hasher.update(piece)
                tmp.write(piece)

        file_hash = hasher.hexdigest()
        if store.has_file(file_hash, SHARED_DOCS_ID):
            raise HTTPException(
                status_code=409,
                detail=f"'{file.filename}' has already been uploaded.",
            )

        try:
            chunks = ingest_pdf(tmp_path)
        except PasswordRequiredError:
            raise HTTPException(
                status_code=423,
                detail=f"'{file.filename}' is password-protected.",
            )
        except ValueError as e:
            # corrupted PDF, or no extractable text
            raise HTTPException(status_code=400, detail=str(e))

        for c in chunks:
            c.source_file = file.filename
        store.add_chunks(chunks, file_hash=file_hash, user_id=SHARED_DOCS_ID)
        # Recorded AFTER the chunks are stored. If anything fails in between, the
        # document has no level and stays Admin-only (default deny), not public.
        set_document_permission(file_hash, min_role)
        save_pdf(tmp_path, file_hash)  # keep the original so the PDF viewer can open it
    finally:
        if tmp_path:
            os.unlink(tmp_path)

    return {
        "filename": file.filename,
        "chunks_added": len(chunks),
        "min_role": min_role,
        "chunks_indexed": store.count(SHARED_DOCS_ID, visible_hashes(current_user["role"])),
    }


@app.post("/ask")
def ask(
    request: AskRequest,
    current_user: dict = Depends(require_role("Guest")),
):
    allowed = visible_hashes(current_user["role"])
    if store.count(SHARED_DOCS_ID, allowed) == 0:
        # Same message whether no documents exist or only restricted ones do,
        # so a low-level user can't tell the difference.
        raise HTTPException(status_code=400, detail="No documents are available to your role yet.")

    try:
        return answer_question(
            request.question, store, user_id=SHARED_DOCS_ID, top_k=request.top_k, allowed_hashes=allowed
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Couldn't reach the local LLM: {e}")


# NOTE: the old POST /reset route (added only so the browser's page-unload
# sendBeacon could call it) is intentionally gone. sendBeacon can't send an
# Authorization header, so keeping an unauthenticated /reset would let
# anyone wipe the document store and bypass RBAC entirely.
@app.delete("/reset")
def reset(current_user: dict = Depends(require_role("Admin"))):
    store.reset(SHARED_DOCS_ID)
    clear_document_permissions()  # no documents left, so forget their levels too
    delete_all_pdfs()  # and the stored PDF files
    return {"chunks_indexed": store.count(SHARED_DOCS_ID)}


# ---------------------------------------------------------------------------
# Admin: user management
# ---------------------------------------------------------------------------

@app.post("/admin/users", status_code=201)
def admin_create_user(
    body: CreateUserRequest,
    admin: dict = Depends(require_role("Admin")),
):
    username = body.username.strip()
    if len(username) < 3:
        raise HTTPException(status_code=400, detail="Username must be at least 3 characters.")
    if body.role not in ROLE_HIERARCHY:
        raise HTTPException(status_code=400, detail=f"Role must be one of {ROLE_HIERARCHY}.")
    if get_user_by_username(username):
        raise HTTPException(status_code=409, detail=f"Username '{username}' already exists.")

    create_user(username, hash_password(body.password), body.role)
    return {"username": username, "role": body.role}


@app.put("/admin/users/{username}/role")
def admin_change_role(
    username: str,
    body: ChangeRoleRequest,
    admin: dict = Depends(require_role("Admin")),
):
    if username == admin["username"]:
        # Guards against the only admin demoting themselves and leaving
        # nobody able to manage roles.
        raise HTTPException(status_code=400, detail="You can't change your own role.")
    if body.new_role not in ROLE_HIERARCHY:
        raise HTTPException(status_code=400, detail=f"Role must be one of {ROLE_HIERARCHY}.")
    if get_user_by_username(username) is None:
        raise HTTPException(status_code=404, detail=f"No user named '{username}'.")

    # Bumps token_version too, so the user's existing token stops working
    # on their next request and they must log in again.
    update_user_role(username, body.new_role)
    return {
        "username": username,
        "new_role": body.new_role,
        "message": f"{username} is now {body.new_role} and must log in again.",
    }


# ---------------------------------------------------------------------------
# Admin: document levels
# ---------------------------------------------------------------------------

@app.put("/admin/documents/{file_hash}/role")
def admin_change_document_level(
    file_hash: str,
    body: ChangeDocumentLevelRequest,
    admin: dict = Depends(require_role("Admin")),
):
    """Change the minimum role that may see one stored document. The document is
    identified by its content hash (the file_hash returned by GET /documents)."""
    if body.min_role not in ROLE_HIERARCHY:
        raise HTTPException(status_code=400, detail=f"Level must be one of {ROLE_HIERARCHY}.")

    stored_hashes = {d["file_hash"] for d in store.list_documents(SHARED_DOCS_ID)}
    if file_hash not in stored_hashes:
        raise HTTPException(status_code=404, detail="No such document.")

    set_document_permission(file_hash, body.min_role)
    return {"file_hash": file_hash, "min_role": body.min_role}
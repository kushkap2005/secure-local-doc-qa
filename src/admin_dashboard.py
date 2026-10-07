"""
admin_dashboard.py — Feature 14: the numbers behind the Admin dashboard.

One route, Admin only:

    GET /admin/dashboard

returns who has an account, which documents are stored, and each document's
access level, plus a few totals. It only READS. It never changes users,
documents or levels (those changes stay in api.py's existing admin routes),
and it never sends password hashes or document text.

How it plugs into api.py (two lines, placed after `store = VectorStore()`):

    from admin_dashboard import make_router as make_dashboard_router
    app.include_router(make_dashboard_router(store, SHARED_DOCS_ID))

It is a function that takes the store, instead of importing api.py, so the
two files never import each other (that would be a circular import).

To remove the feature: delete those two lines and this file.
"""

from fastapi import APIRouter, Depends

from auth import require_role
from database import (
    DEFAULT_REQUIRED_ROLE,
    ROLE_HIERARCHY,
    get_all_document_roles,
    get_connection,
)


def _list_users() -> list:
    """Username and role only. password_hash and token_version are never read."""
    conn = get_connection()
    try:
        rows = conn.execute("SELECT username, role FROM users ORDER BY username COLLATE NOCASE").fetchall()
    finally:
        conn.close()
    return [{"username": r["username"], "role": r["role"]} for r in rows]


def make_router(store, shared_docs_id: str) -> APIRouter:
    router = APIRouter()

    @router.get("/admin/dashboard")
    def dashboard(current_user: dict = Depends(require_role("Admin"))):
        users = _list_users()
        levels = get_all_document_roles()

        documents = []
        for d in store.list_documents(shared_docs_id):
            documents.append(
                {
                    "name": d["source_file"],
                    "file_hash": d["file_hash"],
                    "chunks": d["chunks"],
                    # A document with no recorded level is Admin-only (default deny),
                    # exactly as the rest of the app treats it.
                    "min_role": levels.get(d["file_hash"], DEFAULT_REQUIRED_ROLE),
                }
            )

        users_by_role = {role: 0 for role in ROLE_HIERARCHY}
        for u in users:
            users_by_role[u["role"]] = users_by_role.get(u["role"], 0) + 1

        docs_by_level = {role: 0 for role in ROLE_HIERARCHY}
        for d in documents:
            docs_by_level[d["min_role"]] = docs_by_level.get(d["min_role"], 0) + 1

        return {
            "totals": {
                "users": len(users),
                "documents": len(documents),
                "chunks": sum(d["chunks"] for d in documents),
            },
            "users_by_role": users_by_role,
            "documents_by_level": docs_by_level,
            "users": users,
            "documents": documents,
        }

    return router
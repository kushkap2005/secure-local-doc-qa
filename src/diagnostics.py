"""
diagnostics.py - the numbers behind the "Diagnostics" item in the logo menu.

One route, Admin only:

    GET /admin/diagnostics

Returns a read-only snapshot you can paste into a bug report or show in a demo:
which models are configured, whether the local LLM server (Ollama) answers,
how many documents, chunks and users exist, and the search settings in use.

It never returns passwords, hashes, tokens, file paths, document text or
anything a user typed. It only READS.

How it plugs into api.py (two lines, placed after `store = VectorStore()`):

    from diagnostics import make_router as make_diagnostics_router
    app.include_router(make_diagnostics_router(store, SHARED_DOCS_ID))

To remove: delete those two lines and this file.
"""

import json
import os
import platform
import sys
import urllib.request

from fastapi import APIRouter, Depends

from auth import require_role
from database import DB_PATH, get_connection

DEFAULT_TOP_K = 5  # the default in the /ask and streaming request models
OLLAMA_PORT_DEFAULT = "127.0.0.1:11434"  # the local Ollama server, same machine only


def _ollama_hosts():
    """Where to look: OLLAMA_HOST if set (same variable Ollama itself uses), else the default."""
    host = os.environ.get("OLLAMA_HOST", "").strip()
    if host:
        host = host.replace("http://", "").replace("https://", "").rstrip("/")
        if host.startswith("0.0.0.0"):
            host = "127.0.0.1" + host[len("0.0.0.0"):]
        if ":" not in host:
            host += ":11434"
        return [host]
    return [OLLAMA_PORT_DEFAULT, "localhost:11434", "[::1]:11434"]


def _count(table: str):
    """Row count of one of OUR tables (fixed names only), or None if it doesn't exist."""
    conn = get_connection()
    try:
        return conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
    except Exception:
        return None
    finally:
        conn.close()


def _ollama():
    """Is the local LLM server up, and which models does it have installed?

    Uses an opener with NO proxy: a company/VPN proxy in the environment would
    otherwise swallow this local request and make a running Ollama look dead.
    """
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    last_error = ""
    for host in _ollama_hosts():
        try:
            with opener.open(f"http://{host}/api/tags", timeout=4) as r:
                names = sorted(m.get("name", "") for m in json.load(r).get("models", []))
            return {"running": True, "installed_models": names, "error": ""}
        except Exception as e:  # keep the reason, it is what you need to fix it
            last_error = last_error or f"{host}: {type(e).__name__}: {e}"
    return {"running": False, "installed_models": [], "error": last_error[:300]}


def _is_installed(model, installed):
    """'qwen2.5:7b-instruct' matches itself; a bare name also matches ':latest'."""
    if not model:
        return False
    return model in installed or (":" not in model and model + ":latest" in installed)


def _setting(module_name: str, attr: str):
    """Read a constant from another module without importing it at load time."""
    try:
        return getattr(__import__(module_name), attr)
    except Exception:
        return None


def make_router(store, shared_docs_id) -> APIRouter:
    router = APIRouter()

    @router.get("/admin/diagnostics")
    def diagnostics(current_user: dict = Depends(require_role("Admin"))):
        ollama = _ollama()
        llm = _setting("rag_pipeline", "MODEL_NAME")
        try:
            chunks = store.count(shared_docs_id, None)
            documents = len(store.list_documents(shared_docs_id))
        except Exception:
            chunks = documents = None
        try:
            db_kb = round(os.path.getsize(DB_PATH) / 1024, 1)
        except OSError:
            db_kb = None
        return {
            "system": {
                "python": platform.python_version(),
                "os": platform.system() + " " + platform.release(),
            },
            "models": {
                "llm": llm,
                "llm_installed": _is_installed(llm, ollama["installed_models"]),
                "embedding": _setting("vector_store", "EMBEDDING_MODEL_NAME"),
            },
            "ollama": ollama,
            "search": {
                "relevance_cutoff": _setting("rag_pipeline", "RELEVANCE_THRESHOLD"),
                "top_k": DEFAULT_TOP_K,
            },
            "data": {
                "documents": documents,
                "chunks": chunks,
                "users": _count("users"),
                "audit_rows": _count("audit_log"),
                "database_kb": db_kb,
            },
        }

    return router
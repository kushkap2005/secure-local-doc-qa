"""
system_health.py - the numbers behind the extra rows in the left "System status" panel.

One route, any signed-in role (Guest, Staff or Admin):

    GET /system/health

Returns:
  - llm:        is the local LLM server (Ollama) answering, and is the model this
                app is set to use installed there? (yes/no only, no model list)
  - embedding:  is the embedding model loaded in this server process?
  - last_upload: the newest successful upload THIS ROLE IS ALLOWED TO SEE
                (file name and time). An upload of an Admin-only file never
                shows up for a Guest, not even as a name.
  - search:     the relevance cutoff the answers are filtered with.

It only READS. The Ollama answer is remembered for a few seconds so the page's
polling never hammers the local server.

How it plugs into api.py (two lines, placed after visible_hashes() is defined,
for example next to the diagnostics lines):

    from system_health import make_router as make_health_router
    app.include_router(make_health_router(store, SHARED_DOCS_ID, visible_hashes))

To remove: delete those two lines and this file.
"""

import time

from fastapi import APIRouter, Depends

from auth import require_role
from database import get_connection
from diagnostics import _is_installed, _ollama, _setting

CACHE_SECONDS = 8
_cache = {"at": 0.0, "value": None}


def _ollama_cached():
    now = time.monotonic()
    if _cache["value"] is None or now - _cache["at"] > CACHE_SECONDS:
        _cache["value"] = _ollama()
        _cache["at"] = now
    return _cache["value"]


def _last_visible_upload(visible_names: set):
    """Newest successful upload whose file this role may see, or None."""
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT ts, target FROM audit_log WHERE action = 'upload' AND status BETWEEN 200 AND 299 "
            "ORDER BY id DESC LIMIT 200"
        ).fetchall()
    except Exception:  # audit log not installed
        return None
    finally:
        conn.close()
    for ts, target in rows:
        if target in visible_names:
            return {"file": target, "time": ts}
    return None


def make_router(store, shared_docs_id, visible_hashes) -> APIRouter:
    router = APIRouter()

    @router.get("/system/health")
    def health(current_user: dict = Depends(require_role("Guest"))):
        oll = _ollama_cached()
        llm = _setting("rag_pipeline", "MODEL_NAME")
        if not oll["running"]:
            llm_state = "down"
        elif _is_installed(llm, oll["installed_models"]):
            llm_state = "ok"
        else:
            llm_state = "model_missing"

        allowed = set(visible_hashes(current_user["role"]))
        try:
            names = {d["source_file"] for d in store.list_documents(shared_docs_id) if d["file_hash"] in allowed}
        except Exception:
            names = set()

        return {
            "llm": llm_state,
            "embedding": bool(getattr(store, "embeddings", None)),
            "last_upload": _last_visible_upload(names),
            "search": {"relevance_cutoff": _setting("rag_pipeline", "RELEVANCE_THRESHOLD")},
        }

    return router
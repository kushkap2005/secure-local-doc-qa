"""
streaming.py — Feature 1: streaming answers.

POST /ask/stream does the same job as POST /ask (same sign-in rule, same role
filter, same relevance cut-off, same prompt, same model) but sends the answer
back piece by piece while the model is still writing it, so the page can show
words as they appear instead of a spinner for 20 seconds.

The reply is a stream of JSON lines. Each line is one event:

    {"type": "token", "text": "..."}                 a piece of the answer
    {"type": "done",  "answer": "...", "sources": [...]}   finished (full text + sources)
    {"type": "error", "status": 502, "message": "..."}     the model failed part-way

Problems that /ask reports as HTTP errors (nothing visible to your role, or
retrieval failing) are still plain HTTP errors here, sent BEFORE any streaming
starts. So the page handles them exactly as it does today.

Security: the role filter is the same call as in /ask. Retrieval runs with
allowed_hashes before the model is touched, so text from a document the
caller's role can't see never reaches the model or the stream.

How it plugs into api.py (two lines, AFTER visible_hashes() is defined):

    from streaming import make_router as make_stream_router
    app.include_router(make_stream_router(store, SHARED_DOCS_ID, visible_hashes))

It takes the store and visible_hashes as arguments instead of importing api.py,
so the two files never import each other.

To remove: delete those two lines and this file. /ask itself is untouched.
"""

import json

import ollama
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

import rag_pipeline
from auth import require_role
from rag_pipeline import MODEL_NAME, RELEVANCE_THRESHOLD, build_context

# Same wording rag_pipeline.py uses, so the page's refusal styling still matches.
NO_DOCS_ANSWER = "No documents have been ingested yet."
NOT_FOUND_ANSWER = "I couldn't find this in the provided documents."


class AskStreamRequest(BaseModel):
    question: str = Field(..., min_length=1)
    top_k: int = Field(default=5, ge=1, le=20)


def _line(event: dict) -> str:
    return json.dumps(event, ensure_ascii=False) + "\n"


def _single_answer(text: str):
    """A whole answer sent as one piece (used when we refuse to call the model)."""
    yield _line({"type": "token", "text": text})
    yield _line({"type": "done", "answer": text, "sources": []})


def make_router(store, shared_docs_id: str, visible_hashes) -> APIRouter:
    router = APIRouter()

    @router.post("/ask/stream")
    def ask_stream(
        request: AskStreamRequest,
        current_user: dict = Depends(require_role("Guest")),
    ):
        # --- same checks, in the same order, as POST /ask in api.py ---------
        allowed = visible_hashes(current_user["role"])
        if store.count(shared_docs_id, allowed) == 0:
            raise HTTPException(
                status_code=400, detail="No documents are available to your role yet."
            )

        try:
            retrieved = store.query(
                request.question,
                user_id=shared_docs_id,
                top_k=request.top_k,
                allowed_hashes=allowed,
            )
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Couldn't reach the local LLM: {e}")

        # --- same refusal rules as rag_pipeline.answer_question ---------------
        if not retrieved:
            return _streaming(_single_answer(NO_DOCS_ANSWER))
        if retrieved[0]["relevance_score"] < RELEVANCE_THRESHOLD:
            return _streaming(_single_answer(NOT_FOUND_ANSWER))

        retrieved = [c for c in retrieved if c["relevance_score"] >= RELEVANCE_THRESHOLD]
        context = build_context(retrieved)
        sources = [
            {
                "file": c["source_file"],
                "page": c["page_number"],
                "relevance": round(c["relevance_score"], 3),
                "text": c["text"],
            }
            for c in retrieved
        ]

        def events():
            parts = []
            try:
                # rag_pipeline.chain is looked up on every request, so it is
                # always the same chain /ask uses.
                for piece in rag_pipeline.chain.stream(
                    {"context": context, "question": request.question}
                ):
                    if piece:
                        parts.append(piece)
                        yield _line({"type": "token", "text": piece})
            except ollama.ResponseError as e:
                yield _line(
                    {
                        "type": "error",
                        "status": 502,
                        "message": f"Ollama model '{MODEL_NAME}' isn't available: {e}",
                    }
                )
                return
            except Exception as e:
                yield _line(
                    {
                        "type": "error",
                        "status": 502,
                        "message": f"Local LLM is unreachable. Is Ollama running? ({e})",
                    }
                )
                return
            yield _line({"type": "done", "answer": "".join(parts), "sources": sources})

        return _streaming(events())

    return router


def _streaming(generator) -> StreamingResponse:
    return StreamingResponse(
        generator,
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
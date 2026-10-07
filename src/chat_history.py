"""
chat_history.py — Feature 4: saved chat history.

Each signed-in user gets their own saved conversations. They survive a page
refresh, a sign-out and a server restart. The routes are the ones the
frontend already knows (it had them before the RBAC rewrite):

    GET    /conversations                  list my conversations
    POST   /conversations                  start a new one
    GET    /conversations/{id}             open one (with all its messages)
    POST   /conversations/{id}/messages    save one question + its answer
    PATCH  /conversations/{id}             rename one
    DELETE /conversations/{id}             delete one

Rules this file enforces:
  * Every route needs a signed-in user (Guest and above).
  * A conversation belongs to the user who made it. Someone else's id gets
    404 "not found", the same as an id that never existed, so ids can't be
    probed. Not even an Admin can read another person's chats here.
  * Saved sources keep file, page and relevance only. The passage text is
    NOT stored. If a document's level is later raised, or the user is
    demoted, old chats must not still hold the text of a document they can
    no longer read. (Old answers' source cards simply won't open a passage.)

It stores data in the same SQLite file as users (data/app.db) using two new
tables it creates itself, so database.py is untouched.

How it plugs into api.py (two lines, after the dashboard lines):

    from chat_history import make_router as make_chat_router
    app.include_router(make_chat_router())

To remove: delete those two lines and this file (the tables can stay).
"""

import json
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth import require_role
from database import get_connection

DEFAULT_TITLE = "New conversation"  # same text the frontend uses
TITLE_MAX = 46  # same cut-off the frontend uses
MAX_MESSAGES_PER_CONVERSATION = 400  # keeps one chat from growing without limit


def init_chat_tables() -> None:
    conn = get_connection()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            title TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS conversation_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id TEXT NOT NULL,
            role TEXT NOT NULL,
            text TEXT NOT NULL,
            question TEXT,
            sources TEXT,
            created_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations (username, updated_at)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_msg_conv ON conversation_messages (conversation_id, id)"
    )
    conn.commit()
    conn.close()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _title_from(question: str) -> str:
    q = question.strip()
    return q[:TITLE_MAX] + "…" if len(q) > TITLE_MAX else q


# --- request models ---------------------------------------------------------

class NewConversation(BaseModel):
    title: Optional[str] = Field(default=None, max_length=200)


class RenameConversation(BaseModel):
    title: str = Field(..., min_length=1, max_length=100)


class SourceIn(BaseModel):
    # Only these three fields are kept. Anything else a client sends
    # (including "text") is ignored on purpose.
    file: str = Field(..., max_length=300)
    page: int
    relevance: float


class SaveExchange(BaseModel):
    question: str = Field(..., min_length=1, max_length=4000)
    answer: str = Field(..., min_length=1, max_length=20000)
    sources: List[SourceIn] = Field(default_factory=list, max_length=20)


# --- helpers ----------------------------------------------------------------

def _get_owned(conn, conversation_id: str, username: str):
    row = conn.execute(
        "SELECT id, title FROM conversations WHERE id = ? AND username = ?",
        (conversation_id, username),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    return row


def make_router() -> APIRouter:
    init_chat_tables()
    router = APIRouter()

    @router.get("/conversations")
    def list_conversations(current_user: dict = Depends(require_role("Guest"))):
        conn = get_connection()
        try:
            rows = conn.execute(
                """
                SELECT c.id, c.title,
                       (SELECT COUNT(*) FROM conversation_messages m
                         WHERE m.conversation_id = c.id AND m.role = 'user') AS question_count
                  FROM conversations c
                 WHERE c.username = ?
                 ORDER BY c.updated_at DESC
                """,
                (current_user["username"],),
            ).fetchall()
        finally:
            conn.close()
        return [{"id": r["id"], "title": r["title"], "question_count": r["question_count"]} for r in rows]

    @router.post("/conversations")
    def create_conversation(
        body: NewConversation, current_user: dict = Depends(require_role("Guest"))
    ):
        conversation_id = uuid.uuid4().hex
        title = (body.title or "").strip() or DEFAULT_TITLE
        conn = get_connection()
        try:
            conn.execute(
                "INSERT INTO conversations (id, username, title, updated_at) VALUES (?, ?, ?, ?)",
                (conversation_id, current_user["username"], title, _now()),
            )
            conn.commit()
        finally:
            conn.close()
        return {"id": conversation_id, "title": title}

    @router.get("/conversations/{conversation_id}")
    def get_conversation(
        conversation_id: str, current_user: dict = Depends(require_role("Guest"))
    ):
        conn = get_connection()
        try:
            conv = _get_owned(conn, conversation_id, current_user["username"])
            rows = conn.execute(
                """
                SELECT role, text, question, sources, created_at
                  FROM conversation_messages
                 WHERE conversation_id = ?
                 ORDER BY id
                """,
                (conversation_id,),
            ).fetchall()
        finally:
            conn.close()

        messages = []
        for r in rows:
            m = {"role": r["role"], "text": r["text"], "time": r["created_at"]}
            if r["role"] == "assistant":
                m["question"] = r["question"]
                m["sources"] = json.loads(r["sources"]) if r["sources"] else []
                m["isError"] = False
            messages.append(m)
        return {"id": conversation_id, "title": conv["title"], "messages": messages}

    @router.post("/conversations/{conversation_id}/messages")
    def save_exchange(
        conversation_id: str,
        body: SaveExchange,
        current_user: dict = Depends(require_role("Guest")),
    ):
        conn = get_connection()
        try:
            conv = _get_owned(conn, conversation_id, current_user["username"])
            count = conn.execute(
                "SELECT COUNT(*) AS n FROM conversation_messages WHERE conversation_id = ?",
                (conversation_id,),
            ).fetchone()["n"]
            if count + 2 > MAX_MESSAGES_PER_CONVERSATION:
                raise HTTPException(
                    status_code=400,
                    detail="This conversation is full. Start a new one to keep saving.",
                )

            now = _now()
            sources_json = json.dumps([s.model_dump() for s in body.sources])
            conn.execute(
                "INSERT INTO conversation_messages (conversation_id, role, text, question, sources, created_at)"
                " VALUES (?, 'user', ?, NULL, NULL, ?)",
                (conversation_id, body.question, now),
            )
            conn.execute(
                "INSERT INTO conversation_messages (conversation_id, role, text, question, sources, created_at)"
                " VALUES (?, 'assistant', ?, ?, ?, ?)",
                (conversation_id, body.answer, body.question, sources_json, now),
            )
            title = conv["title"]
            if title == DEFAULT_TITLE:
                title = _title_from(body.question)
            conn.execute(
                "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?",
                (title, now, conversation_id),
            )
            conn.commit()
        finally:
            conn.close()
        return {"title": title}

    @router.patch("/conversations/{conversation_id}")
    def rename_conversation(
        conversation_id: str,
        body: RenameConversation,
        current_user: dict = Depends(require_role("Guest")),
    ):
        title = " ".join(body.title.split())  # trim and collapse stray whitespace
        if not title:
            raise HTTPException(status_code=422, detail="The name can't be empty.")
        conn = get_connection()
        try:
            _get_owned(conn, conversation_id, current_user["username"])
            # updated_at is left alone: renaming shouldn't reorder the history
            conn.execute("UPDATE conversations SET title = ? WHERE id = ?", (title, conversation_id))
            conn.commit()
        finally:
            conn.close()
        return {"id": conversation_id, "title": title}

    @router.delete("/conversations/{conversation_id}")
    def delete_conversation(
        conversation_id: str, current_user: dict = Depends(require_role("Guest"))
    ):
        conn = get_connection()
        try:
            _get_owned(conn, conversation_id, current_user["username"])
            conn.execute(
                "DELETE FROM conversation_messages WHERE conversation_id = ?", (conversation_id,)
            )
            conn.execute("DELETE FROM conversations WHERE id = ?", (conversation_id,))
            conn.commit()
        finally:
            conn.close()
        return {"deleted": conversation_id}

    return router
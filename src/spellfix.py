"""
spellfix.py — Feature: forgiving spelling in questions.

Searching works on meaning, but a misspelled key word ("trasnlation") can drag
a question's score under the cut-off, so the app says "I couldn't find this".
This file adds a safety net:

  1. Search with the question exactly as typed.
  2. If the best match is already strong, stop. Nothing extra happens and
     there is no extra delay.
  3. If the best match is weak, ask the local model to fix the spelling in
     the question (and nothing else), search again with the fixed question,
     and keep the best of both searches.

Why it is safe:
  * The model only ever sees the user's question, never any document text.
  * Both searches use the same allowed_hashes (the caller's role filter), so
    restricted documents stay hidden exactly as before.
  * If the model is off, slow to answer, or returns something odd (long,
    several lines, a different sentence), the fix is ignored and the original
    search result is used.
  * The original question is searched too, so a bad "fix" can only add
    results, never remove good ones.

How it plugs in (two lines in api.py, anywhere after `store = VectorStore()`):

    from spellfix import install as install_spellfix
    install_spellfix(store)

install() wraps store.query, which both /ask and /ask/stream already call, so
neither of them needs to change.

To remove: delete those two lines and this file.
"""

import os
import re

# If the first search already scores at least this high, don't bother fixing.
CONFIDENT_SCORE = 0.50

_SYSTEM = (
    "You fix spelling mistakes in a user's question.\n"
    "Rules:\n"
    "- Reply with ONLY the corrected question, on one line.\n"
    "- Fix misspelled words only. Do not answer the question.\n"
    "- Do not add, remove or reorder words. Do not explain. Do not translate.\n"
    "- If nothing needs fixing, reply with the question unchanged."
)

_llm = None


def _get_llm():
    global _llm
    if _llm is None:
        from langchain_ollama import ChatOllama
        from rag_pipeline import MODEL_NAME

        # temperature 0 = same input, same output. num_predict keeps it short.
        _llm = ChatOllama(model=MODEL_NAME, temperature=0, num_predict=64)
    return _llm


def _clean(original: str, reply: str):
    """Return the corrected question, or None if the reply can't be trusted."""
    text = (reply or "").strip()
    if not text or "\n" in text:
        return None
    text = text.strip("\"'` ")
    if not text:
        return None
    # A spelling fix keeps the same words, give or take one. Anything much
    # longer or shorter is the model doing something else.
    if abs(len(text.split()) - len(original.split())) > 1:
        return None
    if len(text) > 2 * len(original) + 20:
        return None
    return text


def fix_spelling(question: str):
    """Ask the local model for a spelling-fixed question. None = no usable fix."""
    try:
        reply = _get_llm().invoke(
            [("system", _SYSTEM), ("human", question)]
        ).content
    except Exception:
        return None  # model off or failing: carry on with the original question
    return _clean(question, reply)


def _merge(first, second, top_k):
    """Same chunk found twice keeps its higher score. Best first."""
    best = {}
    for c in list(first) + list(second):
        key = c["text"]
        if key not in best or c["relevance_score"] > best[key]["relevance_score"]:
            best[key] = c
    return sorted(best.values(), key=lambda c: c["relevance_score"], reverse=True)[:top_k]


def install(store):
    """Wrap store.query so weak matches get a second try with fixed spelling."""
    original_query = store.query

    def query(question, user_id, top_k=5, allowed_hashes=None):
        # Stray punctuation ("processing/?") shifts the embedding and can push
        # a good match under the cut-off, so search with it removed.
        tidy = re.sub(r"[^\w\s'-]+", " ", question)
        tidy = re.sub(r"\s+", " ", tidy).strip()
        if tidy:
            question = tidy
        results = original_query(
            question, user_id=user_id, top_k=top_k, allowed_hashes=allowed_hashes
        )
        if results and results[0]["relevance_score"] >= CONFIDENT_SCORE:
            return results  # strong match: nothing to fix

        fixed = fix_spelling(question)
        if not fixed or fixed.strip().lower() == question.strip().lower():
            return results

        print(f"spellfix: {question!r} -> {fixed!r}")
        # Same role filter on the second search as on the first.
        second = original_query(
            fixed, user_id=user_id, top_k=top_k, allowed_hashes=allowed_hashes
        )
        return _merge(results, second, top_k)

    store.query = query
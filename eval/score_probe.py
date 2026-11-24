"""Print the retrieval scores for any question and say what the gate would do.

Run from the repo root (with .venv active):
    python eval/score_probe.py "your question here" ["another question" ...]
With no questions it checks the chlorophyll question.

Read-only: it only retrieves, it never calls the LLM and changes nothing.
"""
import sys
from pathlib import Path

# put src/ on the import path so this script can sit in eval/
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from rag_pipeline import COSINE_GATE, RERANK_CHUNK_MIN, RERANK_GATE  # the live settings
from vector_store import VectorStore

DEFAULT_QUESTIONS = ["What are the structural parts of the chlorophyll molecule?"]


def main():
    questions = sys.argv[1:] or DEFAULT_QUESTIONS
    store = VectorStore()
    print(f"\nGate now: answer if cosine >= {COSINE_GATE} OR rerank >= {RERANK_GATE}")
    for q in questions:
        # same call answer_question() makes; no role filter, whole shared pool
        retrieved = store.query(q, user_id="shared", top_k=5, allowed_hashes=None)
        print(f"\nQ: {q}")
        if not retrieved:
            print("  nothing retrieved")
            continue
        best_cos = max(c["relevance_score"] for c in retrieved)
        top_rr = max(c["rerank_score"] for c in retrieved)
        answers = best_cos >= COSINE_GATE or top_rr >= RERANK_GATE
        print(f"  best cosine {best_cos:.3f} (gate {COSINE_GATE})   top rerank {top_rr:.2f} (gate {RERANK_GATE})")
        print(f"  -> {'ANSWER' if answers else 'REFUSE'}")
        for i, c in enumerate(retrieved):
            kept = "keep" if (i == 0 or c["rerank_score"] >= RERANK_CHUNK_MIN) else "drop"
            text = " ".join(c["text"].split())[:90]
            print(f"  {i + 1}. [{kept}] cos {c['relevance_score']:.3f} rerank {c['rerank_score']:6.2f}  "
                  f"{c['source_file']} p{c['page_number']}: {text}")


if __name__ == "__main__":
    main()

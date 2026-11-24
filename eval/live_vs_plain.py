"""Does the live app retrieve the same chunks as the plain pipeline we evaluated?

Run from the repo root (with .venv active):
    python eval/live_vs_plain.py

The running app wraps store.query with spellfix.py (strips punctuation, and for
weak matches asks the local model to fix spelling). Our evaluation scripts never
installed that wrapper. This script runs every eval question through BOTH
versions of the same store and compares what each would do.

Read-only: it never calls the answer LLM and changes nothing. (spellfix may call
the local model for a few weak questions; that is part of what is measured.)
"""
import csv
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from threshold_analysis import K, QUESTIONS, is_correct  # also puts src/ on sys.path

from rag_pipeline import COSINE_GATE, RERANK_GATE
from spellfix import install
from vector_store import VectorStore

CHLOROPHYLL = "What are the structural parts of the chlorophyll molecule?"


def answers(results):
    """The same answer/refuse decision rag_pipeline.answer_question makes."""
    if not results:
        return False
    return (max(c["relevance_score"] for c in results) >= COSINE_GATE
            or max(c["rerank_score"] for c in results) >= RERANK_GATE)


def best(results):
    if not results:
        return (0.0, -99.0)
    return (max(c["relevance_score"] for c in results), max(c["rerank_score"] for c in results))


def pct(a, b):
    return f"{a:3d}/{b} ({100 * a / b:4.1f}%)" if b else "n/a"


def main():
    store = VectorStore()
    plain = store.query     # untouched method: what the eval scripts used
    install(store)
    live = store.query      # wrapped method: what the running app uses

    # quick proof of what the wrapper does to one question
    no_mark = CHLOROPHYLL.rstrip("?")
    print("\nchlorophyll question, rerank scores of the 5 chunks:")
    for label, fn, text in (("plain, with '?'   ", plain, CHLOROPHYLL),
                            ("plain, without '?'", plain, no_mark),
                            ("live (spellfix)   ", live, CHLOROPHYLL)):
        res = fn(text, "shared", top_k=5)
        print(f"  {label}: {[round(c['rerank_score'], 2) for c in res]}")

    with open(QUESTIONS, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    tally = {n: dict(ans=0, n_ans=0, hit1=0, hit5=0, ref_wrong=0, n_ref=0) for n in ("plain", "live")}
    flips = []
    for q in rows:
        is_refusal = q["expected_behavior"].strip() == "refuse"
        decisions, scores = {}, {}
        for name, fn in (("plain", plain), ("live", live)):
            res = fn(q["question"], "shared", top_k=K)
            decisions[name] = answers(res)
            scores[name] = best(res)
            t = tally[name]
            if is_refusal:
                t["n_ref"] += 1
                t["ref_wrong"] += decisions[name]
            else:
                t["n_ans"] += 1
                t["ans"] += decisions[name]
                t["hit1"] += bool(res) and is_correct(res[0], q)
                t["hit5"] += any(is_correct(c, q) for c in res[:K])
        if decisions["plain"] != decisions["live"]:
            flips.append((q, is_refusal, decisions, scores))

    print(f"\nGate: answer if cosine >= {COSINE_GATE} OR rerank >= {RERANK_GATE}")
    print(f"{'':44s}{'plain':>18s}{'live':>18s}")
    n_ans, n_ref = tally["plain"]["n_ans"], tally["plain"]["n_ref"]
    for label, key, total in (("answerable questions answered", "ans", n_ans),
                              ("hit@1 (right page is first)", "hit1", n_ans),
                              ("hit@5 (right page in top 5)", "hit5", n_ans),
                              ("refusal questions wrongly answered", "ref_wrong", n_ref)):
        print(f"{label:44s}{pct(tally['plain'][key], total):>18s}{pct(tally['live'][key], total):>18s}")

    print(f"\n{len(flips)} question(s) where plain and live make a different answer/refuse decision:")
    for q, is_refusal, d, s in flips:
        kind = "REFUSE-type" if is_refusal else "answerable "
        print(f"  id {q['id']:>3} {kind} plain={'answer' if d['plain'] else 'refuse'} "
              f"(cos {s['plain'][0]:.2f}, rr {s['plain'][1]:.2f})  live={'answer' if d['live'] else 'refuse'} "
              f"(cos {s['live'][0]:.2f}, rr {s['live'][1]:.2f})  {q['question'][:50]}")


if __name__ == "__main__":
    main()

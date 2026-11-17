"""Phase 3: try many cutoff values and show what each one would do.

Run from the repo root (with .venv active):
    python eval/threshold_sweep.py shared

Uses the same retriever and questions as threshold_analysis.py. It prints three
tables:
  1. answer/refuse gate using the best COSINE score
  2. answer/refuse gate using the top RERANK score
  3. chunk filter: how many correct chunks survive vs how many wrong ones drop
Nothing is changed in your project; this only reads and prints.
"""
import csv
import sys

from threshold_analysis import K, QUESTIONS, is_correct  # also puts src/ on sys.path
from vector_store import RoleFilteredRetriever, VectorStore

USER_ID = sys.argv[1] if len(sys.argv) > 1 else "shared"


def pct(a, b):
    return f"{100 * a / b:5.1f}%" if b else "  n/a"


def main():
    store = VectorStore()
    retriever = RoleFilteredRetriever(
        vectorstore=store.vectorstore, embeddings=store.embeddings,
        reranker=store.reranker, user_id=USER_ID, allowed_hashes=None, k=K,
    )
    with open(QUESTIONS, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    ans, ref = [], []        # (best_cosine, top_rerank, id, question)
    good, bad = [], []       # (cosine, rerank) per retrieved chunk
    for q in rows:
        docs = retriever.invoke(q["question"])
        if not docs:
            continue
        best_cos = max(d.metadata["relevance_score"] for d in docs)
        top_rr = max(d.metadata["rerank_score"] for d in docs)
        record = (best_cos, top_rr, q["id"], q["question"])
        if q["expected_behavior"].strip() == "refuse":
            ref.append(record)
            continue
        ans.append(record)
        for d in docs:
            pair = (d.metadata["relevance_score"], d.metadata["rerank_score"])
            (good if is_correct(d.metadata, q) else bad).append(pair)

    print(f"\n{len(ans)} answerable questions, {len(ref)} refusal questions\n")

    print("=== 1. Gate on best COSINE score (old method; old threshold was 0.33) ===")
    print("cutoff | answerable wrongly refused | refusal questions wrongly answered")
    for t in [0.20, 0.25, 0.30, 0.35, 0.40, 0.43, 0.45, 0.50]:
        wrong_refused = sum(1 for r in ans if r[0] < t)
        wrong_answered = sum(1 for r in ref if r[0] >= t)
        print(f" {t:5.2f} | {wrong_refused:3d} of {len(ans)} ({pct(wrong_refused, len(ans))}) | {wrong_answered} of {len(ref)}")

    print("\n=== 2. Gate on top RERANK score ===")
    print("cutoff | answerable wrongly refused | refusal questions wrongly answered")
    for t in [-9, -7, -6, -5, -4, -3, -2, -1, 0, 1, 2]:
        wrong_refused = sum(1 for r in ans if r[1] < t)
        wrong_answered = sum(1 for r in ref if r[1] >= t)
        print(f" {t:5d} | {wrong_refused:3d} of {len(ans)} ({pct(wrong_refused, len(ans))}) | {wrong_answered} of {len(ref)}")

    print("\n=== 3. Chunk filter: keep a chunk only if its score is at least the cutoff ===")
    print("(a 'wrong' chunk is just not the page I listed; it can still be a useful neighbour)")
    print("RERANK cutoff | correct chunks kept | wrong chunks dropped")
    for t in [-9, -6, -4, -2, 0, 2, 4]:
        kept = sum(1 for _, rr in good if rr >= t)
        dropped = sum(1 for _, rr in bad if rr < t)
        print(f" {t:5d} | {kept:3d} of {len(good)} ({pct(kept, len(good))}) | {dropped:3d} of {len(bad)} ({pct(dropped, len(bad))})")
    print("COSINE cutoff | correct chunks kept | wrong chunks dropped")
    for t in [0.20, 0.30, 0.40, 0.43, 0.50]:
        kept = sum(1 for c, _ in good if c >= t)
        dropped = sum(1 for c, _ in bad if c < t)
        print(f" {t:5.2f} | {kept:3d} of {len(good)} ({pct(kept, len(good))}) | {dropped:3d} of {len(bad)} ({pct(dropped, len(bad))})")

    print("\n=== Answerable questions that a RERANK gate of -3 would refuse ===")
    for cos, rr, qid, text in sorted(ans, key=lambda r: r[1]):
        if rr < -3:
            print(f"  id {qid:>3}  cosine {cos:.2f}  rerank {rr:6.2f}  {text[:70]}")


    print("\n=== 4. Combined rule: answer if cosine >= C OR rerank >= R ===")
    
    print("    C      R | answerable wrongly refused | refusals wrongly answered")
    for c in [0.50, 0.55, 0.60, 0.65]:
        for r in [-3, -2, -1, 0]:
            wr = sum(1 for a in ans if a[0] < c and a[1] < r)
            wa = sum(1 for x in ref if x[0] >= c or x[1] >= r)
            print(f" {c:.2f} {r:5d} | {wr:3d} of {len(ans)} ({pct(wr, len(ans))}) | {wa} of {len(ref)}")

    print("\n=== Refusal questions the CURRENT rule (cosine>=0.50 OR rerank>=-3) would answer ===")
    for cos, rr, qid, text in ref:
        if cos >= 0.50 or rr >= -3:
            print(f"  id {qid:>3}  cosine {cos:.2f}  rerank {rr:6.2f}  {text[:70]}")


if __name__ == "__main__":
    main()
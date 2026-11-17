"""Phase 3: look at the scores the retriever gives, to choose good cutoffs.

Run from the repo root (with .venv active):
    python eval/threshold_analysis.py

For every question in eval/questions.csv it runs the real hybrid retriever and
records two scores per returned chunk:
  cosine  - how close the chunk's meaning is to the question (what the
            RELEVANCE_THRESHOLD gate in rag_pipeline.py uses)
  rerank  - the cross-encoder's score (higher = better match)
Then it compares the scores of CORRECT chunks (right file + page) against
WRONG chunks, and the scores of out-of-scope questions against answerable ones.
"""
import csv
import re
import statistics
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "src"))

from vector_store import RoleFilteredRetriever, VectorStore  # noqa: E402

QUESTIONS = Path(__file__).parent / "questions.csv"
USER_ID = sys.argv[1] if len(sys.argv) > 1 else "guest"   # owner id of the chunks to test  # the owner id your chunks are stored under (see --inspect)
K = 5
FILE_KEY, PAGE_KEY = "source_file", "page_number"


def norm(name):
    return re.sub(r"[^a-z0-9]", "", (name or "").lower())


def parse_pages(s):
    pages = set()
    for part in re.split(r"[;,]", s or ""):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-", 1)
            pages.update(range(int(a), int(b) + 1))
        elif part:
            pages.add(int(part))
    return pages


def is_correct(meta, q):
    return (norm(meta.get(FILE_KEY)) == norm(q["source_file"])
            and int(meta.get(PAGE_KEY, -1)) in parse_pages(q["source_pages"]))


def summary(values):
    if not values:
        return "n/a"
    return f"min {min(values):.2f}  median {statistics.median(values):.2f}  max {max(values):.2f}  (n={len(values)})"


def main():
    store = VectorStore()
    retriever = RoleFilteredRetriever(
        vectorstore=store.vectorstore, embeddings=store.embeddings,
        reranker=store.reranker, user_id=USER_ID, allowed_hashes=None, k=K,
    )
    with open(QUESTIONS, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    good_cos, good_rr, bad_cos, bad_rr = [], [], [], []
    ans_best_cos, ans_top_rr = [], []
    ref_best_cos, ref_top_rr = [], []
    ref_lines, weak_lines = [], []

    for q in rows:
        docs = retriever.invoke(q["question"])
        if not docs:
            continue
        best_cos = max(d.metadata["relevance_score"] for d in docs)
        top_rr = docs[0].metadata["rerank_score"]
        if q["expected_behavior"].strip() == "refuse":
            ref_best_cos.append(best_cos)
            ref_top_rr.append(top_rr)
            ref_lines.append(f"  id {q['id']:>3}  best cosine {best_cos:.2f}  top rerank {top_rr:6.2f}  {q['question'][:60]}")
            continue
        ans_best_cos.append(best_cos)
        ans_top_rr.append(top_rr)
        weak_lines.append((best_cos, f"  id {q['id']:>3}  best cosine {best_cos:.2f}  top rerank {top_rr:6.2f}  {q['question'][:60]}"))
        for d in docs:
            if is_correct(d.metadata, q):
                good_cos.append(d.metadata["relevance_score"])
                good_rr.append(d.metadata["rerank_score"])
            else:
                bad_cos.append(d.metadata["relevance_score"])
                bad_rr.append(d.metadata["rerank_score"])

    print("\n=== Chunk level (answerable questions, top 5 each) ===")
    print("CORRECT chunks  cosine :", summary(good_cos))
    print("CORRECT chunks  rerank :", summary(good_rr))
    print("WRONG chunks    cosine :", summary(bad_cos))
    print("WRONG chunks    rerank :", summary(bad_rr))

    print("\n=== Question level: does the question deserve an answer? ===")
    print("answerable  best cosine:", summary(ans_best_cos))
    print("refuse      best cosine:", summary(ref_best_cos))
    print("answerable  top rerank :", summary(ans_top_rr))
    print("refuse      top rerank :", summary(ref_top_rr))

    print("\n=== Refusal questions (these should score LOW) ===")
    print("\n".join(ref_lines))

    print("\n=== The 8 answerable questions with the LOWEST best cosine ===")
    for _, line in sorted(weak_lines)[:8]:
        print(line)

    if ans_best_cos and ref_best_cos:
        gap_low, gap_high = max(ref_best_cos), min(ans_best_cos)
        print("\n=== Cutoff window for the answer/refuse gate (cosine) ===")
        print(f"highest refusal score {gap_low:.2f}   lowest answerable score {gap_high:.2f}")
        if gap_low < gap_high:
            print("A threshold between these two values separates them cleanly.")
        else:
            print("The groups overlap: no single cosine threshold separates them perfectly.")


if __name__ == "__main__":
    main()
"""Phase 3: compare four retrieval setups on your question set.
Run from repo root:  python eval/retrieval_eval.py --inspect   (check data first)
                     python eval/retrieval_eval.py             (full comparison)
"""
import argparse, csv, re, sys
from pathlib import Path

import chromadb
from rank_bm25 import BM25Okapi
from sentence_transformers import SentenceTransformer, CrossEncoder

REPO_ROOT = Path(__file__).resolve().parent.parent
CHROMA_PATH = REPO_ROOT / "data" / "chroma_db"
COLLECTION_NAME = "documents"
FILE_KEY, PAGE_KEY = "source_file", "page_number"
EMBED_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
RERANK_MODEL = "cross-encoder/ms-marco-MiniLM-L-6-v2"
CANDIDATES, RRF_K, KS, MRR_CUTOFF = 20, 60, (1, 3, 5), 10
QUESTIONS = Path(__file__).parent / "questions.csv"


def tokenize(text):
    return re.findall(r"[a-z0-9]+", text.lower())


def load_collection():
    client = chromadb.PersistentClient(path=str(CHROMA_PATH))
    col = client.get_collection(COLLECTION_NAME)
    data = col.get(include=["documents", "metadatas"])
    return col, data["ids"], data["documents"], data["metadatas"]


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


def load_questions():
    with open(QUESTIONS, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    return [r for r in rows if r["expected_behavior"].strip() == "answer"]


def rrf(rank_lists, k=RRF_K):
    scores = {}
    for ranks in rank_lists:
        for pos, idx in enumerate(ranks):
            scores[idx] = scores.get(idx, 0) + 1 / (k + pos + 1)
    return sorted(scores, key=scores.get, reverse=True)


def norm(name):
    return re.sub(r"[^a-z0-9]", "", (name or "").lower())


def is_hit(meta, q):
    return norm(meta.get(FILE_KEY)) == norm(q["source_file"]) and int(meta.get(PAGE_KEY, -1)) in parse_pages(q["source_pages"])
    
def inspect():
    col, ids, docs, metas = load_collection()
    print(f"Chunks in collection: {len(ids)}")
    print("Sample metadata:", metas[0] if metas else None)
    print("Files:", sorted({m.get(FILE_KEY) for m in metas}))
    if len(ids) < 150:
        print("WARNING: fewer than ~150 chunks; comparison will be weak. Ingest more PDFs.")


def main():
    if "--inspect" in sys.argv:
        return inspect()
    col, ids, docs, metas = load_collection()
    questions = load_questions()
    embedder = SentenceTransformer(EMBED_MODEL)
    bm25 = BM25Okapi([tokenize(d) for d in docs])
    reranker = CrossEncoder(RERANK_MODEL)
    id_to_idx = {i: n for n, i in enumerate(ids)}

    setups = {"semantic": {}, "bm25": {}, "hybrid_rrf": {}, "hybrid+rerank": {}}
    results = {s: [] for s in setups}
    for q in questions:
        text = q["question"]
        emb = embedder.encode([text], normalize_embeddings=True).tolist()
        res = col.query(query_embeddings=emb, n_results=min(CANDIDATES, len(ids)))
        sem = [id_to_idx[i] for i in res["ids"][0]]
        scores = bm25.get_scores(tokenize(text))
        kw = sorted(range(len(docs)), key=lambda n: scores[n], reverse=True)[:CANDIDATES]
        hyb = rrf([sem, kw])[:CANDIDATES]
        pairs = [(text, docs[n]) for n in hyb]
        rr_scores = reranker.predict(pairs)
        rr = [hyb[n] for n in sorted(range(len(hyb)), key=lambda n: rr_scores[n], reverse=True)]
        for name, order in (("semantic", sem), ("bm25", kw), ("hybrid_rrf", hyb), ("hybrid+rerank", rr)):
            results[name].append([is_hit(metas[n], q) for n in order[:MRR_CUTOFF]])

    n = len(questions)
    print(f"\nQuestions evaluated: {n}")
    print(f"{'setup':<16}" + "".join(f"hit@{k:<5}" for k in KS) + "MRR")
    for name, runs in results.items():
        hits = [sum(any(r[:k]) for r in runs) / n for k in KS]
        mrr = sum((1 / (r.index(True) + 1)) if True in r else 0 for r in runs) / n
        print(f"{name:<16}" + "".join(f"{h:<9.2f}" for h in hits) + f"{mrr:.3f}")


     # NEW: list the questions each setup missed
    print("\nMisses (no correct page in top 5):")
    for name, runs in results.items():
        missed = [q["id"] for q, r in zip(questions, runs) if not any(r[:5])]
        print(f"{name:<16}{missed}")



if __name__ == "__main__":
    main()
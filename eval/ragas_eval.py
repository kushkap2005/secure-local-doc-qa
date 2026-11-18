"""Phase 3: RAGAS evaluation of the final pipeline (hybrid + rerank + gate), fully local.

Run from the repo root (with .venv active, Ollama running):
    python eval/ragas_eval.py --n 5      # quick smoke test first
    python eval/ragas_eval.py --n 30     # the real run

For each sampled answerable question it:
  1. retrieves chunks the same way the app does (hybrid + rerank, then the chunk filter),
  2. gets the app's real answer from answer_question(),
  3. asks a local judge model (Ollama) to score the answer with four RAGAS metrics.
Results go to eval/ragas_results.csv (per question) and the averages are printed.
No internet and no paid API is used: the judge is your own Ollama model.
"""
import argparse
import csv
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "src"))
sys.path.insert(0, str(Path(__file__).parent))

from langchain_ollama import ChatOllama                      # noqa: E402
from ragas import EvaluationDataset, evaluate                # noqa: E402
from ragas.embeddings import LangchainEmbeddingsWrapper      # noqa: E402
from ragas.llms import LangchainLLMWrapper                   # noqa: E402
from ragas.metrics import (                                  # noqa: E402
    Faithfulness, LLMContextPrecisionWithReference,
    LLMContextRecall, ResponseRelevancy,
)
from ragas.run_config import RunConfig                       # noqa: E402

from rag_pipeline import (                                   # noqa: E402
    COSINE_GATE, RERANK_CHUNK_MIN, RERANK_GATE, answer_question,
)
from vector_store import RoleFilteredRetriever, VectorStore  # noqa: E402

QUESTIONS = Path(__file__).parent / "questions.csv"
OUT_CSV = Path(__file__).parent / "ragas_results.csv"
USER_ID = "shared"            # same owner id as the threshold scripts
JUDGE_MODEL = "qwen2.5:7b-instruct"
K = 5


def pick_questions(rows, n):
    """Take n answerable questions spread evenly across the whole file."""
    answerable = [r for r in rows if r["expected_behavior"].strip() == "answer"]
    if n >= len(answerable):
        return answerable
    step = len(answerable) / n
    return [answerable[int(i * step)] for i in range(n)]


def get_contexts(retriever, question):
    """Same gate + chunk filter as rag_pipeline.answer_question. None means 'refused'."""
    docs = retriever.invoke(question)
    if not docs:
        return None
    best_cos = max(d.metadata["relevance_score"] for d in docs)
    top_rr = max(d.metadata["rerank_score"] for d in docs)
    if best_cos < COSINE_GATE and top_rr < RERANK_GATE:
        return None
    kept = [d for i, d in enumerate(docs)
            if i == 0 or d.metadata["rerank_score"] >= RERANK_CHUNK_MIN]
    return [d.page_content for d in kept]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--n", type=int, default=30, help="how many answerable questions to score")
    args = parser.parse_args()

    store = VectorStore()
    retriever = RoleFilteredRetriever(
        vectorstore=store.vectorstore, embeddings=store.embeddings,
        reranker=store.reranker, user_id=USER_ID, allowed_hashes=None, k=K,
    )
    with open(QUESTIONS, newline="", encoding="utf-8") as f:
        rows = pick_questions(list(csv.DictReader(f)), args.n)

    samples, ids = [], []
    for q in rows:
        contexts = get_contexts(retriever, q["question"])
        if contexts is None:
            print(f"  id {q['id']:>3}: refused by the gate, skipped (counts as a refusal error elsewhere)")
            continue
        result = answer_question(q["question"], store, USER_ID)
        samples.append({
            "user_input": q["question"],
            "retrieved_contexts": contexts,
            "response": result["answer"],
            "reference": q["reference_answer"],
        })
        ids.append(q["id"])
        print(f"  id {q['id']:>3}: answered")

    judge = LangchainLLMWrapper(ChatOllama(model=JUDGE_MODEL, temperature=0))
    embedder = LangchainEmbeddingsWrapper(store.embeddings)
    scores = evaluate(
        dataset=EvaluationDataset.from_list(samples),
        metrics=[Faithfulness(), ResponseRelevancy(),
                 LLMContextPrecisionWithReference(), LLMContextRecall()],
        llm=judge, embeddings=embedder,
        run_config=RunConfig(timeout=600, max_workers=1),  # one call at a time: kind to a laptop
    )

    df = scores.to_pandas()
    df.insert(0, "id", ids)
    df.to_csv(OUT_CSV, index=False)

    print(f"\n=== RAGAS averages over {len(df)} questions (higher is better, max 1.0) ===")
    for col in df.columns:
        if col not in ("id", "user_input", "retrieved_contexts", "response", "reference"):
            print(f"  {col:<40} {df[col].mean():.3f}   (NaN rows ignored: {int(df[col].isna().sum())})")
    print(f"\nPer-question scores saved to {OUT_CSV}")


if __name__ == "__main__":
    main()
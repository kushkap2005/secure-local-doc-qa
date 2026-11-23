"""
vector_store.py — Stores document chunks as embeddings in ChromaDB and searches
them with a hybrid retriever: semantic search + BM25 keyword search, merged by
Reciprocal Rank Fusion and re-ordered by a cross-encoder.

Every chunk carries a `user_id` in its metadata, and every read/write below
is filtered to that caller's own chunks — this is what gives each account
its own private document set inside one shared ChromaDB collection, instead
of standing up a separate collection per user. Callers pass a "guest" sentinel
for anonymous, not-logged-in use (see api.py), which keeps today's
no-login behavior working unchanged.

On top of that, query() and count() accept `allowed_hashes` — the content
hashes of the documents the caller's ROLE may see (see database.py). The
filter is applied BEFORE any searching: only the chunks the caller may see are
fetched, and both the semantic and the keyword search run on that set alone.
So chunks from documents a role can't see are never retrieved, never reach the
LLM, and can't leak into an answer or its source list.

Retrieval pipeline (chosen from the Phase 3 evaluation):
  1. fetch the chunks this caller may see
  2. semantic ranking  : cosine similarity (all-MiniLM-L6-v2 embeddings)
  3. keyword ranking   : BM25 (rank_bm25)
  4. merge             : Reciprocal Rank Fusion of the two rankings
  5. rerank            : cross-encoder reads question + chunk together

LangChain pieces used here:
  - HuggingFaceEmbeddings : the local all-MiniLM-L6-v2 model (text -> vector)
  - Chroma                : the vector store wrapping the same ChromaDB folder
  - RoleFilteredRetriever : a retriever (question -> relevant Documents) that
                            applies the user/role filter on every search
"""

import os

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

import re
from typing import Any, List, Optional

import chromadb
import numpy as np
from chromadb.config import Settings
from langchain_chroma import Chroma
from langchain_core.callbacks import CallbackManagerForRetrieverRun
from langchain_core.documents import Document
from langchain_core.retrievers import BaseRetriever
from langchain_huggingface import HuggingFaceEmbeddings
from rank_bm25 import BM25Okapi
from sentence_transformers import CrossEncoder

from ingest import Chunk

EMBEDDING_MODEL_NAME = "all-MiniLM-L6-v2"
RERANK_MODEL_NAME = "cross-encoder/ms-marco-MiniLM-L-6-v2"
COLLECTION_NAME = "documents"
PERSIST_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "chroma_db")

CANDIDATES = 20   # how many chunks each search hands to the merge/rerank step
RRF_K = 60        # standard smoothing constant for Reciprocal Rank Fusion
MIN_CHUNK_CHARS = 30   # ignore chunks shorter than this (slide titles, stray headings)


def tokenize(text: str) -> List[str]:
    """Lowercase words and numbers only — what the keyword search compares."""
    return re.findall(r"[a-z0-9]+", text.lower())


def rrf_fuse(rank_lists: List[List[int]], k: int = RRF_K) -> List[int]:
    """
    Merge several ranked lists by rank, not by score: each chunk earns
    1/(k + position) from every list it appears in, and the totals decide the
    order. (Cosine scores and BM25 scores sit on different scales, so they
    can't simply be added.)
    """
    scores = {}
    for ranks in rank_lists:
        for pos, idx in enumerate(ranks):
            scores[idx] = scores.get(idx, 0) + 1 / (k + pos + 1)
    return sorted(scores, key=scores.get, reverse=True)


def build_where(user_id: str, allowed_hashes: Optional[List[str]]) -> dict:
    """
    Builds the ChromaDB filter: this owner's chunks, and — if a list of allowed
    document hashes is given — only chunks of those documents.
    allowed_hashes=None means "no role filtering"; an empty list is handled by
    the callers (ChromaDB rejects an empty $in list).
    """
    if allowed_hashes is None:
        return {"user_id": user_id}
    return {"$and": [{"user_id": user_id}, {"file_hash": {"$in": list(allowed_hashes)}}]}


class RoleFilteredRetriever(BaseRetriever):
    """
    Hybrid retriever: give it a question, get back the most relevant Documents.
    It only ever looks at this owner's chunks, and — when allowed_hashes is
    given — only at chunks of the documents that list names.
    allowed_hashes=None means no role filtering; an empty list means "may see
    nothing", so nothing is returned.

    Each returned Document carries, in its metadata:
      relevance_score : cosine similarity between question and chunk
                        (= 1 - cosine distance, the same meaning as before) —
                        the relevance cutoff in rag_pipeline.py uses this.
      rerank_score    : the cross-encoder's score, kept for analysis.
    """

    vectorstore: Any
    embeddings: Any
    reranker: Any
    user_id: str
    allowed_hashes: Optional[List[str]] = None
    k: int = 5

    def _get_relevant_documents(
        self, query: str, *, run_manager: CallbackManagerForRetrieverRun
    ) -> List[Document]:
        if not query or not query.strip():
            return []
        if self.allowed_hashes is not None and len(self.allowed_hashes) == 0:
            return []

        # 1. Only the chunks this caller may see (user + role filter) —
        #    text, metadata and stored embedding for each.
        where = build_where(self.user_id, self.allowed_hashes)
        data = self.vectorstore.get(
            where=where, include=["documents", "metadatas", "embeddings"]
        )
        # Drop tiny chunks (title-only slides) before any ranking.
        keep = [i for i, t in enumerate(data["documents"]) if len(t.strip()) >= MIN_CHUNK_CHARS]
        if not keep:
            return []
        texts = [data["documents"][i] for i in keep]
        metas = [data["metadatas"][i] for i in keep]
        matrix = np.asarray(data["embeddings"], dtype=float)[keep]
        
        n = min(CANDIDATES, len(texts))  # never ask for more than exist

        # 2. Semantic ranking: cosine similarity of the question to every chunk.
        q = np.asarray(self.embeddings.embed_query(query), dtype=float)
        cosine = matrix @ q / (np.linalg.norm(matrix, axis=1) * np.linalg.norm(q) + 1e-12)
        semantic_rank = list(np.argsort(-cosine)[:n])

        # 3. Keyword ranking: BM25 over the same chunks.
        bm25 = BM25Okapi([tokenize(t) or ["_empty_"] for t in texts])
        keyword_scores = bm25.get_scores(tokenize(query))
        keyword_rank = list(np.argsort(-keyword_scores)[:n])

        # 4. Merge the two rankings by rank (RRF), keep the shortlist.
        fused = rrf_fuse([semantic_rank, keyword_rank])[:n]

        # 5. Rerank the shortlist: the cross-encoder reads question + chunk
        #    together; the best `k` are returned.
        rerank_scores = self.reranker.predict([(query, texts[i]) for i in fused])
        order = sorted(range(len(fused)), key=lambda j: rerank_scores[j], reverse=True)[: self.k]

        documents = []
        for j in order:
            i = fused[j]
            meta = dict(metas[i])
            meta["relevance_score"] = float(cosine[i])
            meta["rerank_score"] = float(rerank_scores[j])
            documents.append(Document(page_content=texts[i], metadata=meta))
        return documents


class VectorStore:
    def __init__(self, persist_dir: str = PERSIST_DIR):
        # The local embedding model — the "meaning fingerprint maker". Loaded once.
        self.embeddings = HuggingFaceEmbeddings(model_name=EMBEDDING_MODEL_NAME)

        # The local reranking model — reads question + chunk together and
        # scores how well they match. Loaded once (must be in the local
        # Hugging Face cache, since this project runs offline).
        self.reranker = CrossEncoder(RERANK_MODEL_NAME)

        # ChromaDB saves everything to a local folder on disk — no server, no network
        # (anonymized telemetry is switched off: this project is air-gapped).
        client = chromadb.PersistentClient(
            path=persist_dir, settings=Settings(anonymized_telemetry=False)
        )

        # LangChain's wrapper around the same "documents" collection as before.
        # "cosine" = the math method used to compare closeness, so that
        # 1 - distance later means "how similar".
        self.vectorstore = Chroma(
            client=client,
            collection_name=COLLECTION_NAME,
            embedding_function=self.embeddings,
            collection_metadata={"hnsw:space": "cosine"},
        )

    def add_chunks(self, chunks: List[Chunk], file_hash: str, user_id: str, batch_size: int = 64) -> int:
        """
        Turn each chunk into a LangChain Document, embed it, and store it in
        ChromaDB along with its citation info and owning user_id.
        Returns the number of chunks actually added.
        """
        if not chunks:
            return 0
        if not file_hash:
            raise ValueError("file_hash is required — duplicate detection depends on it.")
        if not user_id:
            raise ValueError("user_id is required — it's what keeps accounts' documents separate.")

        total_added = 0
        for i in range(0, len(chunks), batch_size):
            batch = chunks[i:i + batch_size]
            documents = [
                Document(
                    page_content=c.text,
                    metadata={
                        "source_file": c.source_file,
                        "page_number": c.page_number,
                        "file_hash": file_hash,
                        "user_id": user_id,
                    },
                )
                for c in batch
            ]
            self.vectorstore.add_documents(
                documents,
                ids=[f"{user_id}::{c.chunk_id}" for c in batch],  # keep ids globally unique across users
            )
            total_added += len(batch)

        return total_added

    def has_file(self, file_hash: str, user_id: str) -> bool:
        """Check if this user already has a chunk with this file's content hash."""
        if not file_hash:
            return False
        result = self.vectorstore.get(
            where={"$and": [{"user_id": user_id}, {"file_hash": file_hash}]}, limit=1
        )
        return len(result["ids"]) > 0

    def query(
        self,
        question: str,
        user_id: str,
        top_k: int = 5,
        allowed_hashes: Optional[List[str]] = None,
    ) -> List[dict]:
        """
        Ask the hybrid retriever for the top_k chunks — scoped to this user's
        own documents — that best answer the question (semantic + keyword
        search, merged and reranked).

        allowed_hashes restricts the search to those documents only (this is
        how a caller's role is enforced). None = no restriction; an empty list
        = the caller may see nothing, so nothing is returned.
        """
        retriever = RoleFilteredRetriever(
            vectorstore=self.vectorstore,
            embeddings=self.embeddings,
            reranker=self.reranker,
            user_id=user_id,
            allowed_hashes=allowed_hashes,
            k=top_k,
        )
        documents = retriever.invoke(question)

        seen_texts = set()
        retrieved = []
        for doc in documents:
            if doc.page_content in seen_texts:
                continue
            seen_texts.add(doc.page_content)
            retrieved.append({
                "text": doc.page_content,
                "source_file": doc.metadata["source_file"],
                "page_number": doc.metadata["page_number"],
                "relevance_score": doc.metadata["relevance_score"],
                "rerank_score": doc.metadata["rerank_score"],
            })
        return retrieved

    def count(self, user_id: str, allowed_hashes: Optional[List[str]] = None) -> int:
        """Chunk count scoped to one user — ChromaDB's own collection.count()
        is a fast O(1) global counter, but it can't tell accounts apart, so
        this filters instead (fine at the scale a local tool sees).
        With allowed_hashes, only chunks of those documents are counted."""
        if allowed_hashes is not None and len(allowed_hashes) == 0:
            return 0
        where = build_where(user_id, allowed_hashes)
        return len(self.vectorstore.get(where=where, include=[])["ids"])

    def list_documents(self, user_id: str) -> List[dict]:
        """
        Every distinct document stored for this owner, as
        [{"file_hash", "source_file", "chunks"}], sorted by file name.
        Role filtering is NOT applied here — callers decide which of these
        a role may see (see database.get_accessible_file_hashes).
        """
        result = self.vectorstore.get(where={"user_id": user_id}, include=["metadatas"])
        documents = {}
        for meta in result["metadatas"]:
            file_hash = meta.get("file_hash")
            if not file_hash:
                continue  # a chunk with no hash can't be given a permission level
            entry = documents.setdefault(
                file_hash,
                {"file_hash": file_hash, "source_file": meta["source_file"], "chunks": 0},
            )
            entry["chunks"] += 1
        return sorted(documents.values(), key=lambda d: d["source_file"].lower())

    def reset(self, user_id: str) -> None:
        """Wipe this user's stored chunks only — everyone else's documents
        are untouched, since they all share the one collection."""
        self.vectorstore.delete(where={"user_id": user_id})


# Quick self-test — run:  python vector_store.py
# It builds a throwaway vector store in a temp folder from made-up documents,
# so it never touches your real data/chroma_db.
if __name__ == "__main__":
    import tempfile
    from types import SimpleNamespace

    store = VectorStore(persist_dir=tempfile.mkdtemp())
    OWNER = "shared"
    failures = 0

    def check(name, condition):
        global failures
        print(("PASS  " if condition else "FAIL  ") + name)
        if not condition:
            failures += 1

    def make_chunk(doc, text):
        return SimpleNamespace(text=text, source_file=doc, page_number=1, chunk_id=f"{doc}_p1_c0")

    documents = {
        "open.pdf": ("hash_open", "The company holiday calendar lists all public holidays and office closing days."),
        "staff.pdf": ("hash_staff", "Staff expense claims must be submitted within thirty days of the purchase."),
        "admin.pdf": ("hash_admin", "Executive salary bands and bonus targets are strictly confidential."),
    }
    for name, (file_hash, text) in documents.items():
        store.add_chunks([make_chunk(name, text)], file_hash=file_hash, user_id=OWNER)

    question = "What are the executive salary bands?"
    everything = ["hash_open", "hash_staff", "hash_admin"]

    def sources(allowed):
        return {r["source_file"] for r in store.query(question, OWNER, top_k=5, allowed_hashes=allowed)}

    check("no filter: all 3 chunks are counted", store.count(OWNER) == 3)
    check("no filter: the admin document is the best match", store.query(question, OWNER, top_k=1)[0]["source_file"] == "admin.pdf")
    check("Guest filter: only the open document is counted", store.count(OWNER, ["hash_open"]) == 1)
    check("Guest filter: the admin document never comes back", "admin.pdf" not in sources(["hash_open"]))
    check("Guest filter: only the open document comes back", sources(["hash_open"]) == {"open.pdf"})
    check("Staff filter: open + staff documents only", sources(["hash_open", "hash_staff"]) == {"open.pdf", "staff.pdf"})
    check("Admin filter: all documents come back", sources(everything) == {"open.pdf", "staff.pdf", "admin.pdf"})
    check("empty allowed list: nothing counted", store.count(OWNER, []) == 0)
    check("empty allowed list: nothing returned", store.query(question, OWNER, allowed_hashes=[]) == [])
    check("a hash matching no document returns nothing", store.query(question, OWNER, allowed_hashes=["no_such_hash"]) == [])

    listing = {d["file_hash"]: d for d in store.list_documents(OWNER)}
    check("list_documents finds all 3 documents", set(listing) == set(everything))
    check("list_documents reports file name and chunk count", listing["hash_admin"]["source_file"] == "admin.pdf" and listing["hash_admin"]["chunks"] == 1)
    check("another owner id sees nothing", store.count("someone_else") == 0 and store.list_documents("someone_else") == [])

    retriever = RoleFilteredRetriever(
        vectorstore=store.vectorstore, embeddings=store.embeddings, reranker=store.reranker,
        user_id=OWNER, allowed_hashes=["hash_open"], k=5,
    )
    found = retriever.invoke(question)
    check("the retriever returns LangChain Documents with a relevance score", bool(found) and isinstance(found[0], Document) and "relevance_score" in found[0].metadata)
    check("the retriever also reports a rerank score", bool(found) and "rerank_score" in found[0].metadata)

    keyword_hit = store.query("thirty days", OWNER, top_k=1)
    check("a keyword-style question finds the staff document", bool(keyword_hit) and keyword_hit[0]["source_file"] == "staff.pdf")

    store.reset(OWNER)
    check("reset clears the owner's chunks", store.count(OWNER) == 0)

    print("\nALL CHECKS PASSED" if failures == 0 else f"\n{failures} CHECK(S) FAILED")
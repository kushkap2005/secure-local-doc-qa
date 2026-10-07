"""
vector_store.py — Stores document chunks as embeddings in ChromaDB and searches
them, through LangChain's Chroma vector store and a retriever.

Every chunk carries a `user_id` in its metadata, and every read/write below
is filtered to that caller's own chunks — this is what gives each account
its own private document set inside one shared ChromaDB collection, instead
of standing up a separate collection per user. Callers pass a "guest" sentinel
for anonymous, not-logged-in use (see api.py), which keeps today's
no-login behavior working unchanged.

On top of that, query() and count() accept `allowed_hashes` — the content
hashes of the documents the caller's ROLE may see (see database.py). The
filter is applied inside the ChromaDB search itself, so chunks from documents
a role can't see are never retrieved, never reach the LLM, and can't leak into
an answer or its source list.

LangChain pieces used here:
  - HuggingFaceEmbeddings : the local all-MiniLM-L6-v2 model (text -> vector)
  - Chroma                : the vector store wrapping the same ChromaDB folder
  - RoleFilteredRetriever : a retriever (question -> relevant Documents) that
                            applies the user/role filter on every search
"""

import os

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

from typing import Any, List, Optional

import chromadb
from chromadb.config import Settings
from langchain_chroma import Chroma
from langchain_core.callbacks import CallbackManagerForRetrieverRun
from langchain_core.documents import Document
from langchain_core.retrievers import BaseRetriever
from langchain_huggingface import HuggingFaceEmbeddings

from ingest import Chunk

EMBEDDING_MODEL_NAME = "all-MiniLM-L6-v2"
COLLECTION_NAME = "documents"
PERSIST_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "chroma_db")


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
    A LangChain retriever: give it a question, get back the most relevant
    Documents. It only ever looks at this owner's chunks, and — when
    allowed_hashes is given — only at chunks of the documents that list names.
    allowed_hashes=None means no role filtering; an empty list means "may see
    nothing", so nothing is returned.

    Each returned Document carries `relevance_score` in its metadata
    (1 - cosine distance), which the relevance cutoff in rag_pipeline.py uses.
    """

    vectorstore: Any
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

        where = build_where(self.user_id, self.allowed_hashes)
        available = len(self.vectorstore.get(where=where, include=[])["ids"])
        if available == 0:
            return []

        # never ask ChromaDB for more results than exist
        results = self.vectorstore.similarity_search_with_score(
            query, k=min(self.k, available), filter=where
        )
        documents = []
        for doc, distance in results:
            doc.metadata["relevance_score"] = 1 - distance  # closer distance = more relevant
            documents.append(doc)
        return documents


class VectorStore:
    def __init__(self, persist_dir: str = PERSIST_DIR):
        # The local embedding model — the "meaning fingerprint maker". Loaded once.
        self.embeddings = HuggingFaceEmbeddings(model_name=EMBEDDING_MODEL_NAME)

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
        Ask the retriever for the top_k chunks — scoped to this user's own
        documents — that are closest in meaning to the question.

        allowed_hashes restricts the search to those documents only (this is
        how a caller's role is enforced). None = no restriction; an empty list
        = the caller may see nothing, so nothing is returned.
        """
        retriever = RoleFilteredRetriever(
            vectorstore=self.vectorstore,
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

    retriever = RoleFilteredRetriever(vectorstore=store.vectorstore, user_id=OWNER, allowed_hashes=["hash_open"], k=5)
    found = retriever.invoke(question)
    check("the retriever returns LangChain Documents with a relevance score", bool(found) and isinstance(found[0], Document) and "relevance_score" in found[0].metadata)

    store.reset(OWNER)
    check("reset clears the owner's chunks", store.count(OWNER) == 0)

    print("\nALL CHECKS PASSED" if failures == 0 else f"\n{failures} CHECK(S) FAILED")
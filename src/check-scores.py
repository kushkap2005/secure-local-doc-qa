"""
check_scores.py — shows how well each question matches your stored documents.

Run from doc_rag\\src\\ with the venv active:

    python check_scores.py "what is ip" "what is image processing"

For every question it prints the 5 closest chunks with their relevance score
(the same number the app compares against RELEVANCE_THRESHOLD) and the start
of the chunk's text. It only READS the store; it never changes anything and
never calls the language model. It ignores roles (looks at every document),
so run it on your own machine only.
"""

import sys

from rag_pipeline import RELEVANCE_THRESHOLD
from vector_store import VectorStore

if len(sys.argv) < 2:
    sys.exit('Usage: python check_scores.py "question one" "question two" ...')

store = VectorStore()
print(f"The app refuses when the best score is below {RELEVANCE_THRESHOLD}\n")

for question in sys.argv[1:]:
    print(f'Question: "{question}"')
    chunks = store.query(question, user_id="shared", top_k=5)
    if not chunks:
        print("  (nothing stored)\n")
        continue
    for c in chunks:
        mark = "keep " if c["relevance_score"] >= RELEVANCE_THRESHOLD else "DROP "
        text = " ".join(c["text"].split())[:90]
        print(f'  {mark}{c["relevance_score"]:.3f}  {c["source_file"]} p{c["page_number"]}  | {text}')
    print()
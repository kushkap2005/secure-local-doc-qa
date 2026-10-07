"""
ingest.py — Parses PDF documents and splits them into overlapping text
chunks ready for embedding.
"""

import fitz  # PyMuPDF
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional


@dataclass
class Chunk:
    """A single retrievable unit of text plus metadata needed to cite it."""
    text: str
    source_file: str
    page_number: int
    chunk_id: str
    metadata: dict = field(default_factory=dict)


class PasswordRequiredError(Exception):
    '''Raised when a pdf is encrypted and no password was provided'''
    pass


def extract_pages(pdf_path: str, password: Optional[str] = None) -> List[tuple[int, str]]:
    try:
        doc = fitz.open(pdf_path)
    except Exception as e:
        raise ValueError(f"Could not open PDF '{pdf_path}': {e}")

    if doc.is_encrypted:
        if not password:
            doc.close()
            raise PasswordRequiredError(f"PDF '{pdf_path}' is password-protected.")
        if not doc.authenticate(password):
            doc.close()
            raise ValueError(f"Incorrect password for '{pdf_path}'.")

    pages = []
    for i, page in enumerate(doc):
        text = page.get_text("text")
        pages.append((i + 1, text))
    doc.close()
    return pages


def chunk_text(text: str, chunk_size: int = 800, overlap: int = 150) -> List[str]:
    """
    Split text into overlapping chunks by character count.
    """
    text = text.strip()
    if not text:
        return []

    chunks = []
    start = 0
    while start < len(text):
        end = start + chunk_size
        chunk = text[start:end]

        # Try to end at a sentence boundary instead of mid-word/mid-sentence
        if end < len(text):
            next_period = text.find(". ", end, end + 100)
            if next_period != -1:
                chunk = text[start:next_period + 1]
                end = next_period + 1

        chunks.append(chunk.strip())
        next_start = end - overlap  # step back so context carries into next chunk
        # don't begin the next chunk in the middle of a word
        while next_start < min(end, len(text)) and next_start > 0 and not text[next_start - 1].isspace():
            next_start += 1
        start = next_start if next_start > start else end

    return [c for c in chunks if c]


def _page_for_position(char_pos: int, page_boundaries: list) -> int:
    """Given a character position in the merged text, return which page it falls on."""
    for start, end, page_num in page_boundaries:
        if start <= char_pos < end:
            return page_num
    return page_boundaries[-1][2] if page_boundaries else 1  # fallback: last known page


def ingest_pdf(pdf_path, chunk_size: int = 800, overlap: int = 150, password: Optional[str] = None) -> List[Chunk]:
    """
    Full pipeline for one PDF: extract pages -> chunk each page on its own
    (so every chunk's page_number is always exactly one real page, never a
    range) -> but prepend a small tail of the PREVIOUS page's text before
    chunking the current page, so overlap still bridges page breaks.
    """

    filename = Path(pdf_path).name
    pages = extract_pages(pdf_path, password=password)

    if all(not text.strip() for _, text in pages):
        raise ValueError(
            f"No extractable text found in '{filename}' — it may be a scanned PDF with no text layer."
        )

    all_chunks = []
    previous_page_tail = ""

    for page_num, page_text in pages:
        if not page_text.strip() and not previous_page_tail:
            continue

        combined_text = (previous_page_tail + "\n" + page_text) if previous_page_tail else page_text
        page_chunks = chunk_text(combined_text, chunk_size, overlap)

        for i, chunk_str in enumerate(page_chunks):
            all_chunks.append(
                Chunk(
                    text=chunk_str,
                    source_file=filename,
                    page_number=page_num,
                    chunk_id=f"{filename}_p{page_num}_c{i}",
                )
            )

        previous_page_tail = ""
        if page_text:
            tail = page_text[-overlap:]
            if len(page_text) > overlap and not page_text[-overlap - 1].isspace():
                # the cut landed inside a word: drop that partial first word
                for j, ch in enumerate(tail):
                    if ch.isspace():
                        tail = tail[j + 1:]
                        break
                else:
                    tail = ""
            previous_page_tail = tail

    return all_chunks


def ingest_directory(directory: str, chunk_size: int = 800, overlap: int = 150) -> List[Chunk]:
    """Ingest every PDF in a directory. A failure on one file doesn't stop the rest."""
    all_chunks = []
    for pdf_path in Path(directory).glob("*.pdf"):
        try:
            chunks = ingest_pdf(str(pdf_path), chunk_size, overlap)
            all_chunks.extend(chunks)
            print(f"  {pdf_path.name}: {len(chunks)} chunks")
        except Exception as e:
            print(f"  {pdf_path.name}: FAILED — {e}")
    return all_chunks


# Quick manual test — run this file directly to sanity-check it works
if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage: python ingest.py <path_to_pdf>")
    else:
        chunks = ingest_pdf(sys.argv[1])
        print(f"\nTotal chunks: {len(chunks)}")
        print(f"\nFirst chunk preview:\n{chunks[0].text[:300]}")
"""
page_reader.py — Phase 4: make pages with little or no typed text searchable.

A PDF page can be one of three things for us:
  text     normal typed text. Nothing to do; ingest.py already reads it.
  scan     the page is (mostly) a picture of text, e.g. a scan or a photo of a
           slide. We run Tesseract OCR on it. If OCR finds almost nothing, we
           ask the vision model to describe it instead.
  figure   a diagram/chart with only a few labels typed on it (e.g. the
           photosystem Z-scheme). We keep the typed labels AND ask the vision
           model (Qwen-VL through Ollama) to write out what the figure shows.

All of this runs only when a PDF is ingested (uploaded), never when a question
is asked. Results are cached on disk by the PDF's SHA-256 hash, so ingesting
the same file again costs nothing.

Nothing here leaves your machine: Tesseract and Ollama both run locally.

Try it without changing anything else:
    python src/page_reader.py --scan  "some.pdf"          # classify pages only (fast)
    python src/page_reader.py --try   "some.pdf" 13        # OCR / describe one page and print it
    python src/page_reader.py --warm  "a.pdf" "b.pdf"      # process every flagged page now, fill the cache
"""

import argparse
import hashlib
import io
import json
import os
import sys
from pathlib import Path
from typing import Optional

import fitz  # PyMuPDF

CACHE_DIR = Path(__file__).resolve().parent.parent / "data" / "page_cache"

# --- settings (can be overridden with environment variables) -----------------
VISION_MODEL = os.environ.get("VISION_MODEL", "qwen2.5vl:7b")
ENABLE_OCR = os.environ.get("ENABLE_OCR", "1") == "1"
ENABLE_VISION = os.environ.get("ENABLE_VISION", "1") == "1"
VISION_TIMEOUT_S = 600

# --- page classification thresholds (calibrate with --scan) ------------------
SCAN_TEXT_CHARS = 40     # fewer typed characters than this = "almost no text"
DENSE_TEXT_CHARS = 600   # more than this = a normal text page, never a figure
IMAGE_COVER_MIN = 0.20   # pictures covering this share of the page count as a figure
DRAWINGS_MIN = 40        # this many vector shapes/lines count as a drawn diagram
MIN_OCR_CHARS = 300      # less OCR text than this = probably a labelled diagram, so add a vision description too
REPEAT_MIN_PAGES = 3     # a picture used on at least this many pages ...
REPEAT_SHARE = 0.20      # ... and on at least this share of the pages is a logo/template, not content

OCR_ZOOM = 2.0           # render scale for OCR (2.0 ~ 144 dpi)
VISION_ZOOM = 1.5        # smaller image is faster for the vision model

VISION_PROMPT = (
    "This is one page from a lecture document. Describe only what is visibly on "
    "the page, so that someone who cannot see it could answer questions about "
    "it. Write plain sentences, not a bullet list. Name every labelled part and "
    "say how the labelled parts are arranged or connected (arrows, order, "
    "inside/outside). Copy any visible text, numbers and equations exactly. Do "
    "not explain what things do or mean unless the page itself says so in "
    "words, and do not add facts from your own knowledge. If something is "
    "unreadable, say so."
)
# Bump this text if the prompt or logic changes, so old cache entries are ignored.
CACHE_SETTINGS = f"v1|{VISION_MODEL}|{hashlib.md5(VISION_PROMPT.encode()).hexdigest()[:8]}"


def _warn(msg: str) -> None:
    print(f"  [page_reader] {msg}", file=sys.stderr)


# ------------------------------------------------------------------ classify
def repeated_image_xrefs(doc) -> set:
    """
    Pictures that appear on many pages of the same document (a university logo,
    a slide background) are template decoration, not content. Return their ids
    so the page check can ignore them.
    """
    counts = {}
    for page in doc:
        try:
            ids = {info.get("xref", 0) for info in page.get_image_info(xrefs=True)}
        except Exception:
            continue
        for x in ids:
            if x:  # 0 means an inline image with no shared id
                counts[x] = counts.get(x, 0) + 1
    need = max(REPEAT_MIN_PAGES, int(REPEAT_SHARE * len(doc) + 0.999))
    return {x for x, c in counts.items() if c >= need}


def page_stats(page, text: str, ignore_xrefs=frozenset()) -> dict:
    """Cheap facts about one page: typed characters, picture coverage, drawn shapes."""
    page_area = (page.rect.width * page.rect.height) or 1.0
    covered = 0.0
    try:
        for info in page.get_image_info(xrefs=True):
            if info.get("xref", 0) in ignore_xrefs:
                continue  # logo / background repeated on many pages
            covered += (fitz.Rect(info["bbox"]) & page.rect).get_area()
    except Exception:
        pass
    try:
        drawings = len(page.get_drawings())
    except Exception:
        drawings = 0
    return {
        "chars": len(text.strip()),
        "cover": min(covered / page_area, 1.0),
        "drawings": drawings,
    }


def classify_page(stats: dict) -> str:
    """Return 'text', 'scan' or 'figure' (see the top of this file)."""
    visual = stats["cover"] >= IMAGE_COVER_MIN or stats["drawings"] >= DRAWINGS_MIN
    if stats["chars"] < SCAN_TEXT_CHARS:
        # (almost) no typed text: only worth working on if there is something to see
        return "scan" if (stats["cover"] >= 0.05 or stats["drawings"] >= DRAWINGS_MIN) else "text"
    if stats["chars"] < DENSE_TEXT_CHARS and visual:
        return "figure"
    return "text"


# -------------------------------------------------------------- OCR + vision
def render_png(page, zoom: float) -> bytes:
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
    return pix.tobytes("png")


def ocr_png(png: bytes) -> Optional[str]:
    """Tesseract OCR. Returns None (and warns) if Tesseract can't be used."""
    try:
        import pytesseract
        from PIL import Image

        return pytesseract.image_to_string(Image.open(io.BytesIO(png)), lang="eng").strip()
    except Exception as e:  # missing binary, bad image, ...
        _warn(f"OCR failed: {e}")
        return None


def describe_png(png: bytes) -> Optional[str]:
    """Ask the local vision model to describe the page. None if it can't."""
    try:
        import ollama

        client = ollama.Client(timeout=VISION_TIMEOUT_S)
        reply = client.chat(
            model=VISION_MODEL,
            messages=[{"role": "user", "content": VISION_PROMPT, "images": [png]}],
            options={"temperature": 0, "num_predict": 500, "repeat_penalty": 1.15},
        )
        return (reply["message"]["content"] or "").strip()
    except Exception as e:  # model not pulled, Ollama not running, timeout, ...
        _warn(f"vision model '{VISION_MODEL}' failed: {e}")
        return None


# --------------------------------------------------------------------- cache
def _sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


class PageEnricher:
    """
    Holds the cache for one PDF and turns a page's typed text into 'typed text
    + whatever OCR / the vision model could add'.
        enricher = PageEnricher(pdf_path)
        text = enricher.enrich(page, page.get_text("text"))
    """

    def __init__(self, pdf_path: str):
        self.path = CACHE_DIR / f"{_sha256_file(pdf_path)}.json"
        self.cache = {"settings": CACHE_SETTINGS, "pages": {}}
        self._repeated = None  # filled on first page, once the whole document is known
        try:
            loaded = json.loads(self.path.read_text(encoding="utf-8"))
            if loaded.get("settings") == CACHE_SETTINGS:
                self.cache = loaded  # same settings: reuse. Otherwise start fresh.
        except (OSError, ValueError):
            pass

    def _save(self) -> None:
        try:
            CACHE_DIR.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".part")
            tmp.write_text(json.dumps(self.cache), encoding="utf-8")
            os.replace(tmp, self.path)  # a half-written cache file is never read
        except OSError as e:
            _warn(f"could not save cache: {e}")

    def classify(self, page, text: str):
        """(kind, stats) for one page, ignoring logos/backgrounds repeated across the document."""
        if self._repeated is None:
            self._repeated = repeated_image_xrefs(page.parent)
        stats = page_stats(page, text, self._repeated)
        return classify_page(stats), stats

    def enrich(self, page, text: str) -> str:
        kind, _ = self.classify(page, text)
        if kind == "text":
            return text

        key = str(page.number + 1)
        entry = self.cache["pages"].setdefault(key, {"kind": kind})
        changed = False

        if kind == "scan" and ENABLE_OCR and "ocr" not in entry:
            result = ocr_png(render_png(page, OCR_ZOOM))
            if result is not None:
                entry["ocr"] = result
                changed = True

        ocr_text = (entry.get("ocr") or "").strip()
        needs_vision = kind == "figure" or (kind == "scan" and len(ocr_text) < MIN_OCR_CHARS)
        if needs_vision and ENABLE_VISION and "vision" not in entry:
            result = describe_png(render_png(page, VISION_ZOOM))
            if result:
                entry["vision"] = result
                changed = True

        if changed:
            self._save()  # save after every page so an interrupted run loses little

        parts = [text.strip()] if text.strip() else []
        if ocr_text:
            parts.append(ocr_text)
        if entry.get("vision"):
            parts.append("[Diagram description] " + entry["vision"])
        return "\n\n".join(parts)


# ----------------------------------------------------------------------- CLI
def _cmd_scan(paths) -> None:
    for p in paths:
        doc = fitz.open(p)
        counts = {"text": 0, "scan": 0, "figure": 0}
        repeated = repeated_image_xrefs(doc)
        print(f"\n{Path(p).name}  ({len(doc)} pages, {len(repeated)} repeated logo/background pictures ignored)")
        for page in doc:
            stats = page_stats(page, page.get_text("text"), repeated)
            kind = classify_page(stats)
            counts[kind] += 1
            if kind != "text":
                print(f"  page {page.number + 1:>3}  {kind:<6}  chars {stats['chars']:>4}  "
                      f"pictures {stats['cover'] * 100:>3.0f}%  drawings {stats['drawings']:>4}")
        print(f"  -> text {counts['text']}, scan {counts['scan']}, figure {counts['figure']}")
        doc.close()


def _cmd_try(path: str, page_no: int) -> None:
    doc = fitz.open(path)
    page = doc[page_no - 1]
    typed = page.get_text("text")
    print(f"--- typed text on page {page_no} ({len(typed.strip())} chars) ---\n{typed.strip()}\n")
    enricher = PageEnricher(path)
    print(f"--- classified as: {enricher.classify(page, typed)[0]} ---")
    print(f"--- final text for the index ---\n{enricher.enrich(page, typed)}")
    doc.close()


def _cmd_warm(paths) -> None:
    """Process every flagged page of every PDF now and fill the cache.
    Safe to stop (Ctrl+C) and run again: finished pages are skipped."""
    import time

    for p in paths:
        doc = fitz.open(p)
        enricher = PageEnricher(p)
        print(f"\n{Path(p).name[:16]}...  ({len(doc)} pages)")
        for page in doc:
            typed = page.get_text("text")
            kind, _ = enricher.classify(page, typed)
            if kind == "text":
                continue
            key = str(page.number + 1)
            before = dict(enricher.cache["pages"].get(key, {}))
            start = time.time()
            enricher.enrich(page, typed)
            after = enricher.cache["pages"].get(key, {})
            state = "cached already" if after == before and before else f"done in {time.time() - start:.0f}s"
            print(f"  page {page.number + 1:>3}  {kind:<6}  {state}", flush=True)
        doc.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--scan", nargs="+", metavar="PDF", help="classify every page, no OCR or vision")
    parser.add_argument("--warm", nargs="+", metavar="PDF", help="process all flagged pages and fill the cache")
    parser.add_argument("--try", dest="try_", nargs=2, metavar=("PDF", "PAGE"), help="process one page and print the result")
    args = parser.parse_args()
    if args.scan:
        _cmd_scan(args.scan)
    elif args.warm:
        _cmd_warm(args.warm)
    elif args.try_:
        _cmd_try(args.try_[0], int(args.try_[1]))
    else:
        parser.print_help()
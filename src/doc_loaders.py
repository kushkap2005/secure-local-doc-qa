"""
doc_loaders.py — Reads non-PDF documents (.txt .md .csv .html .docx .xlsx .xls .pptx) into the same
shape the PDF reader produces: a list of (page_number, text).

Only ingest.py and api.py use this file. Everything after it (chunking,
embedding, search, role filtering, answers) is unchanged, because by the time a
document reaches the chunker it is just numbered blocks of text.

"Page numbers" for most of these types are logical sections, since the files have
no fixed pages: about 3000 characters of text, or 40 table rows, per "page".
That is what shows up as the page in a citation. PowerPoint is the exception:
the page is the real slide number.

Safety notes:
  * Nothing here runs code. Spreadsheet formulas are read as their last saved
    value, macros are ignored, and HTML is reduced to its visible text (scripts
    and styles are thrown away, never executed).
  * Files are checked by their first bytes, not just their name (check_signature).
  * Very large tables are refused with a clear message (MAX_ROWS).
"""

import csv
import io
import re
from html.parser import HTMLParser
from pathlib import Path
from typing import List, Optional, Tuple

SUPPORTED_EXTENSIONS = {".pdf", ".txt", ".md", ".csv", ".html", ".htm", ".docx", ".xlsx", ".xls", ".pptx"}

TEXT_PAGE_CHARS = 3000   # text files: roughly this much text per logical "page"
ROWS_PER_PAGE = 40       # tables: this many rows per logical "page"
MAX_ROWS = 50_000        # refuse bigger tables instead of silently cutting them off

Page = Tuple[int, str]


def check_signature(first_bytes: bytes, ext: str) -> Optional[str]:
    """Cheap sanity check on the first bytes of an upload. Returns an error
    message, or None if the file looks like what its extension claims."""
    if ext == ".pdf":
        if b"%PDF-" not in first_bytes[:1024]:
            return "This file isn't a valid PDF."
    elif ext in (".docx", ".xlsx", ".pptx"):
        # All three are zip archives, and every zip starts with these four bytes.
        if not first_bytes.startswith(b"PK\x03\x04"):
            return f"This file isn't a valid {ext[1:].upper()} document."
    elif ext == ".xls":
        # The old Excel format is an "OLE2" container with this fixed start.
        if not first_bytes.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"):
            return "This file isn't a valid XLS spreadsheet."
    elif ext in (".txt", ".md", ".csv", ".html", ".htm"):
        if b"\x00" in first_bytes:
            return "This looks like a binary file, not a text file."
    return None


def _read_text(path: str) -> str:
    raw = Path(path).read_bytes()
    try:
        return raw.decode("utf-8-sig")          # normal UTF-8, with or without BOM
    except UnicodeDecodeError:
        return raw.decode("cp1252", errors="replace")  # common for Windows exports


def _pack(blocks: List[str], max_chars: int) -> List[Page]:
    """Group paragraphs into numbered pages of about max_chars characters."""
    pages, current, size = [], [], 0
    for block in blocks:
        block = block.strip()
        if not block:
            continue
        if current and size + len(block) > max_chars:
            pages.append("\n\n".join(current))
            current, size = [], 0
        current.append(block)
        size += len(block) + 2
    if current:
        pages.append("\n\n".join(current))
    return [(i + 1, text) for i, text in enumerate(pages)]


def _column_name(header: List[str], i: int) -> str:
    return header[i] if i < len(header) and header[i] else f"column {i + 1}"


def _rows_to_pages(rows: List[list], prefix: str = "", start_page: int = 1) -> List[Page]:
    """Turn table rows into text. The first row is the header; every later row
    becomes one line like 'Name: Asha; Dept: Sales; Salary: 50000', so each line
    carries its own column names and can be found by search on its own."""
    if not rows:
        return []
    header = [str(c).strip() for c in rows[0]]
    lines = []
    for row in rows[1:]:
        cells = [
            f"{_column_name(header, i)}: {str(v).strip()}"
            for i, v in enumerate(row)
            if v is not None and str(v).strip()
        ]
        if cells:
            lines.append("; ".join(cells))
    if not lines:  # a header and nothing else
        names = [_column_name(header, i) for i in range(len(header))]
        return [(start_page, prefix + "Columns: " + ", ".join(names))]
    pages = []
    for i in range(0, len(lines), ROWS_PER_PAGE):
        body = "\n".join(lines[i:i + ROWS_PER_PAGE])
        pages.append((start_page + len(pages), prefix + body))
    return pages


def load_text(path: str) -> List[Page]:
    """.txt and .md: split on blank lines, then group into pages."""
    text = _read_text(path)
    return _pack(re.split(r"\n\s*\n", text), TEXT_PAGE_CHARS)


def load_csv(path: str) -> List[Page]:
    text = _read_text(path)
    if not text.strip():
        return []
    try:
        dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    rows = []
    for row in csv.reader(io.StringIO(text), dialect):
        if any(cell.strip() for cell in row):
            rows.append(row)
            if len(rows) > MAX_ROWS:
                raise ValueError(f"This table has more than {MAX_ROWS} rows, which is over the limit.")
    return _rows_to_pages(rows)


def load_xlsx(path: str) -> List[Page]:
    """.xlsx: each sheet becomes pages of rows, starting with '[Sheet: name]'."""
    from openpyxl import load_workbook

    wb = load_workbook(path, read_only=True, data_only=True)
    pages: List[Page] = []
    try:
        for ws in wb.worksheets:
            rows = []
            for row in ws.iter_rows(values_only=True):
                if any(v is not None and str(v).strip() for v in row):
                    rows.append(list(row))
                    if len(rows) > MAX_ROWS:
                        raise ValueError(
                            f"Sheet '{ws.title}' has more than {MAX_ROWS} rows, which is over the limit."
                        )
            pages.extend(_rows_to_pages(rows, prefix=f"[Sheet: {ws.title}]\n", start_page=len(pages) + 1))
    finally:
        wb.close()
    return pages


def load_docx(path: str) -> List[Page]:
    """.docx: paragraphs and tables in reading order, grouped into pages."""
    from docx import Document
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    doc = Document(path)
    blocks: List[str] = []
    for child in doc.element.body.iterchildren():
        if child.tag.endswith("}p"):
            blocks.append(Paragraph(child, doc).text)
        elif child.tag.endswith("}tbl"):
            for row in Table(child, doc).rows:
                cells = [c.text.strip() for c in row.cells]
                if any(cells):
                    blocks.append(" | ".join(cells))
    return _pack(blocks, TEXT_PAGE_CHARS)


class _HtmlText(HTMLParser):
    """Collects the visible text of an HTML page. Scripts, styles and other
    non-visible parts are skipped; block tags (p, div, li, tr, h1...) start a new line."""

    SKIP = {"script", "style", "noscript", "template", "svg", "head"}
    BREAK = {"p", "div", "br", "li", "tr", "table", "ul", "ol", "section", "article", "header",
             "footer", "blockquote", "pre", "h1", "h2", "h3", "h4", "h5", "h6", "title"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: List[str] = []
        self._skip_depth = 0
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self._skip_depth += 1
        if tag == "title":
            self._in_title = True  # <title> sits inside <head>, but we want it
        if tag in self.BREAK:
            self.parts.append("\n")
        elif tag in ("td", "th"):
            self.parts.append(" | ")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self._skip_depth:
            self._skip_depth -= 1
        if tag == "title":
            self._in_title = False
        if tag in self.BREAK:
            self.parts.append("\n")

    def handle_data(self, data):
        if self._skip_depth == 0 or self._in_title:
            self.parts.append(data)


def load_html(path: str) -> List[Page]:
    """.html / .htm: the visible text only, grouped into pages."""
    parser = _HtmlText()
    parser.feed(_read_text(path))
    parser.close()
    lines = [re.sub(r"\s+", " ", line).strip(" |") for line in "".join(parser.parts).split("\n")]
    return _pack([line for line in lines if line], TEXT_PAGE_CHARS)


def _walk_shapes(shapes):
    """Every shape on a slide, including shapes inside groups."""
    for shape in shapes:
        yield shape
        if hasattr(shape, "shapes"):  # a group of shapes
            yield from _walk_shapes(shape.shapes)


def load_pptx(path: str) -> List[Page]:
    """.pptx: one page per slide (the real slide number): text boxes, tables and
    speaker notes. Text inside pictures is not read."""
    from pptx import Presentation

    prs = Presentation(path)
    pages: List[Page] = []
    for number, slide in enumerate(prs.slides, start=1):
        parts: List[str] = []
        for shape in _walk_shapes(slide.shapes):
            if getattr(shape, "has_text_frame", False) and shape.has_text_frame:
                text = "\n".join(p.text.strip() for p in shape.text_frame.paragraphs if p.text.strip())
                if text:
                    parts.append(text)
            if getattr(shape, "has_table", False) and shape.has_table:
                for row in shape.table.rows:
                    cells = [c.text.strip() for c in row.cells]
                    if any(cells):
                        parts.append(" | ".join(cells))
        if slide.has_notes_slide:
            notes = slide.notes_slide.notes_text_frame.text.strip()
            if notes:
                parts.append("Speaker notes: " + notes)
        pages.append((number, "\n".join(parts)))
    return pages


def _xls_value(cell, datemode):
    """One cell of an old .xls sheet as plain text-friendly Python."""
    import xlrd

    if cell.ctype in (xlrd.XL_CELL_EMPTY, xlrd.XL_CELL_BLANK, xlrd.XL_CELL_ERROR):
        return ""
    if cell.ctype == xlrd.XL_CELL_DATE:
        try:
            return xlrd.xldate_as_datetime(cell.value, datemode).isoformat(sep=" ")
        except Exception:
            return cell.value
    if cell.ctype == xlrd.XL_CELL_NUMBER and float(cell.value).is_integer():
        return int(cell.value)   # 120.0 -> 120
    if cell.ctype == xlrd.XL_CELL_BOOLEAN:
        return bool(cell.value)
    return cell.value


def load_xls(path: str) -> List[Page]:
    """.xls (old Excel): same treatment as .xlsx."""
    import xlrd

    book = xlrd.open_workbook(path, on_demand=True)
    pages: List[Page] = []
    try:
        for sheet in book.sheets():
            rows = []
            for r in range(sheet.nrows):
                row = [_xls_value(sheet.cell(r, c), book.datemode) for c in range(sheet.ncols)]
                if any(str(v).strip() for v in row):
                    rows.append(row)
                    if len(rows) > MAX_ROWS:
                        raise ValueError(
                            f"Sheet '{sheet.name}' has more than {MAX_ROWS} rows, which is over the limit."
                        )
            pages.extend(_rows_to_pages(rows, prefix=f"[Sheet: {sheet.name}]\n", start_page=len(pages) + 1))
    finally:
        book.release_resources()
    return pages


_LOADERS = {
    ".txt": load_text, ".md": load_text, ".csv": load_csv,
    ".html": load_html, ".htm": load_html,
    ".docx": load_docx, ".xlsx": load_xlsx, ".xls": load_xls, ".pptx": load_pptx,
}


def load_pages(path: str) -> List[Page]:
    """Read any supported non-PDF file into [(page_number, text), ...].
    Every failure becomes a ValueError with a readable message."""
    ext = Path(path).suffix.lower()
    loader = _LOADERS.get(ext)
    if loader is None:
        raise ValueError(f"Unsupported file type '{ext}'.")
    try:
        return loader(path)
    except ValueError:
        raise
    except ImportError as e:
        raise ValueError(f"Reading {ext} files needs a package that isn't installed: {e}")
    except Exception as e:
        raise ValueError(f"Could not read this {ext[1:].upper()} file ({type(e).__name__}): {e}")

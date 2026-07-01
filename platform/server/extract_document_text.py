#!/usr/bin/env python3
import json
import os
import re
import sys
import zipfile
import xml.etree.ElementTree as ET


XML_NS = {
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
}

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}


def compact(text, limit=30000):
    text = re.sub(r"\n{3,}", "\n\n", text or "").strip()
    return text[:limit]


def result(text="", parser="unknown", needs_ocr=False, warnings=None, meta=None):
    return {
        "text": compact(text),
        "parser": parser,
        "needs_ocr": bool(needs_ocr),
        "warnings": warnings or [],
        "meta": meta or {},
    }


def is_readable(text, min_chars=80):
    text = re.sub(r"\s+", "", text or "")
    return len(text) >= min_chars


def normalize_pdf_text(text):
    lines = []
    for line in (text or "").splitlines():
        line = re.sub(r"\s+", " ", line).strip()
        if line:
            lines.append(line)
    return "\n".join(lines)


def extract_docx(path):
    parts = []
    with zipfile.ZipFile(path) as zf:
        names = [n for n in zf.namelist() if n.startswith("word/") and n.endswith(".xml")]
        for name in ["word/document.xml"] + sorted(n for n in names if n != "word/document.xml"):
            if name not in zf.namelist():
                continue
            try:
                root = ET.fromstring(zf.read(name))
            except Exception:
                continue
            texts = [node.text for node in root.findall(".//w:t", XML_NS) if node.text]
            if texts:
                parts.append(" ".join(texts))
    text = "\n".join(parts)
    return result(
        text=text,
        parser="docx-openxml",
        needs_ocr=not is_readable(text, 40),
        warnings=[] if is_readable(text, 40) else ["DOCX has little readable text."],
    )


def extract_pptx(path):
    parts = []
    image_count = 0
    with zipfile.ZipFile(path) as zf:
        slide_names = sorted(
            [n for n in zf.namelist() if n.startswith("ppt/slides/slide") and n.endswith(".xml")],
            key=lambda n: int(re.search(r"slide(\d+)\.xml", n).group(1)) if re.search(r"slide(\d+)\.xml", n) else 0,
        )
        image_count = len([n for n in zf.namelist() if n.startswith("ppt/media/")])
        for idx, name in enumerate(slide_names, 1):
            try:
                root = ET.fromstring(zf.read(name))
            except Exception:
                continue
            texts = [node.text for node in root.findall(".//a:t", XML_NS) if node.text]
            if texts:
                parts.append("## Slide %s\n%s" % (idx, "\n".join(texts)))

        note_names = sorted(
            [n for n in zf.namelist() if n.startswith("ppt/notesSlides/notesSlide") and n.endswith(".xml")],
            key=lambda n: int(re.search(r"notesSlide(\d+)\.xml", n).group(1)) if re.search(r"notesSlide(\d+)\.xml", n) else 0,
        )
        for idx, name in enumerate(note_names, 1):
            try:
                root = ET.fromstring(zf.read(name))
            except Exception:
                continue
            texts = [node.text for node in root.findall(".//a:t", XML_NS) if node.text]
            if texts:
                parts.append("## Speaker Notes %s\n%s" % (idx, "\n".join(texts)))

    text = "\n\n".join(parts)
    needs_ocr = not is_readable(text, 80) and image_count > 0
    warnings = []
    if needs_ocr:
        warnings.append("PPTX appears image-heavy and has little readable text. Slide rendering plus OCR is recommended.")
    return result(
        text=text,
        parser="pptx-openxml",
        needs_ocr=needs_ocr,
        warnings=warnings,
        meta={"image_count": image_count},
    )


def extract_pdf(path):
    warnings = []
    errors = []

    try:
        import fitz
        doc = fitz.open(path)
        page_count = len(doc)
        parts = []
        image_pages = 0
        for page_index in range(min(page_count, 80)):
            idx = page_index + 1
            page = doc.load_page(page_index)
            text = normalize_pdf_text(page.get_text("text") or "")
            if text:
                parts.append("## Page %s\n%s" % (idx, text))
            try:
                if page.get_images(full=True):
                    image_pages += 1
            except Exception:
                pass
        text = "\n\n".join(parts)
        needs_ocr = not is_readable(text, 80)
        if needs_ocr:
            warnings.append("PDF has little or no extractable text. OCR is required for scanned/image PDF pages.")
        doc.close()
        return result(
            text=text,
            parser="pdf-pymupdf",
            needs_ocr=needs_ocr,
            warnings=warnings,
            meta={"pages": page_count, "image_pages": image_pages},
        )
    except Exception as exc:
        errors.append("PyMuPDF: %s" % exc)

    try:
        import pdfplumber
        parts = []
        with pdfplumber.open(path) as pdf:
            pages = pdf.pages
            for idx, page in enumerate(pages[:80], 1):
                text = normalize_pdf_text(page.extract_text() or "")
                if text:
                    parts.append("## Page %s\n%s" % (idx, text))
        text = "\n\n".join(parts)
        needs_ocr = not is_readable(text, 80)
        if needs_ocr:
            warnings.append("PDF has little or no extractable text. OCR is required for scanned/image PDF pages.")
        return result(
            text=text,
            parser="pdf-pdfplumber",
            needs_ocr=needs_ocr,
            warnings=warnings,
            meta={"pages": len(pages)},
        )
    except Exception as exc:
        errors.append("pdfplumber: %s" % exc)

    try:
        from pypdf import PdfReader
        reader = PdfReader(path)
        parts = []
        for idx, page in enumerate(reader.pages[:80], 1):
            try:
                text = normalize_pdf_text(page.extract_text() or "")
            except Exception:
                text = ""
            if text.strip():
                parts.append("## Page %s\n%s" % (idx, text.strip()))
        text = "\n\n".join(parts)
        needs_ocr = not is_readable(text, 80)
        if needs_ocr:
            warnings.append("PDF has little or no extractable text. OCR is required for scanned/image PDF pages.")
        return result(
            text=text,
            parser="pdf-pypdf",
            needs_ocr=needs_ocr,
            warnings=warnings,
            meta={"pages": len(reader.pages)},
        )
    except Exception as exc:
        errors.append("pypdf: %s" % exc)
        return result(
            text="",
            parser="pdf-parser-error",
            needs_ocr=True,
            warnings=["PDF text parser failed. OCR is required. " + " | ".join(errors)],
        )


def extract_text(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in [".txt", ".csv", ".tsv", ".md", ".json"]:
        with open(path, "r", encoding="utf-8-sig", errors="ignore") as f:
            return result(text=f.read(), parser="plain-text")
    if ext == ".docx":
        return extract_docx(path)
    if ext == ".pptx":
        return extract_pptx(path)
    if ext == ".pdf":
        return extract_pdf(path)
    if ext in IMAGE_EXTS:
        return result(
            text="",
            parser="image-file",
            needs_ocr=True,
            warnings=["Image files require OCR service extraction."],
        )
    return result(
        text="",
        parser="unsupported",
        needs_ocr=False,
        warnings=["Unsupported document type: %s" % (ext or "unknown")],
    )


if __name__ == "__main__":
    file_path = sys.argv[1]
    print(json.dumps(extract_text(file_path), ensure_ascii=True))

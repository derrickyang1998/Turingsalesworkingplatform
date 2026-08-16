#!/usr/bin/env python3
import json
import os
import re
import sys
import tempfile


IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}


def compact(text, limit=40000):
    text = re.sub(r"\n{3,}", "\n\n", text or "").strip()
    return text[:limit]


def result(text="", parser="local-rapidocr", warnings=None, meta=None):
    return {
        "text": compact(text),
        "parser": parser,
        "warnings": warnings or [],
        "meta": meta or {},
    }


def load_engine():
    from rapidocr import RapidOCR
    return RapidOCR()


def normalize_line(text):
    return re.sub(r"\s+", " ", text or "").strip()


def iter_recognized_lines(output):
    if hasattr(output, "txts") and hasattr(output, "scores"):
        texts = output.txts
        scores = output.scores
        if texts is None or scores is None:
            return
        for text, score in zip(texts, scores):
            yield text, score
        return

    legacy_output = output[0] if isinstance(output, tuple) else output
    if legacy_output is None:
        return
    for item in legacy_output:
        if not item or len(item) < 3:
            continue
        yield item[1], item[2]


def ocr_image(engine, image_path, min_score):
    output = engine(str(image_path))
    lines = []
    for raw_text, raw_score in iter_recognized_lines(output):
        text = normalize_line(raw_text)
        try:
            score = float(raw_score)
        except Exception:
            score = 0.0
        if text and score >= min_score:
            lines.append(text)
    return "\n".join(lines)


def ocr_pdf(engine, path, max_pages, zoom, min_score):
    import fitz

    parts = []
    doc = fitz.open(path)
    page_count = len(doc)
    pages_used = min(page_count, max_pages)
    with tempfile.TemporaryDirectory(prefix="tm_ocr_") as tmpdir:
        for page_index in range(pages_used):
            page = doc.load_page(page_index)
            pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
            image_path = os.path.join(tmpdir, "page_%03d.png" % (page_index + 1))
            pix.save(image_path)
            text = ocr_image(engine, image_path, min_score)
            if text:
                parts.append("## OCR Page %s\n%s" % (page_index + 1, text))
    doc.close()
    warnings = []
    if not parts:
        warnings.append("Local OCR completed but no text was recognized.")
    if page_count > pages_used:
        warnings.append("Local OCR read first %s of %s pages." % (pages_used, page_count))
    return result(
        text="\n\n".join(parts),
        warnings=warnings,
        meta={"pages": page_count, "ocr_pages": pages_used, "zoom": zoom},
    )


def ocr_file(path):
    path = str(path or "").strip()
    ext = os.path.splitext(path)[1].lower()
    max_pages = int(os.environ.get("LOCAL_OCR_MAX_PAGES", "20"))
    zoom = float(os.environ.get("LOCAL_OCR_ZOOM", "2.2"))
    min_score = float(os.environ.get("LOCAL_OCR_MIN_SCORE", "0.45"))

    engine = load_engine()
    if ext == ".pdf":
        return ocr_pdf(engine, path, max_pages, zoom, min_score)
    if ext in IMAGE_EXTS:
        text = ocr_image(engine, path, min_score)
        warnings = [] if text else ["Local OCR completed but no text was recognized."]
        return result(text=text, warnings=warnings, meta={"image": True})
    return result(
        text="",
        parser="local-rapidocr-unsupported",
        warnings=["Local OCR supports PDF and image files only: %s" % (ext or "unknown")],
    )


def self_test_image(path, expected_text):
    path = str(path or "").strip()
    expected_text = normalize_line(expected_text)
    ext = os.path.splitext(path)[1].lower()
    if ext not in IMAGE_EXTS:
        raise ValueError("OCR self-test requires an image file")
    if not os.path.isfile(path):
        raise ValueError("OCR self-test image does not exist")
    if not expected_text:
        raise ValueError("OCR self-test expected text is required")

    min_score = float(os.environ.get("LOCAL_OCR_MIN_SCORE", "0.45"))
    text = ocr_image(load_engine(), path, min_score)
    if expected_text.casefold() not in normalize_line(text).casefold():
        raise RuntimeError("OCR self-test did not recognize expected text")
    return result(
        text=text,
        meta={"image": True, "self_test": True, "expected_text": expected_text},
    )


if __name__ == "__main__":
    try:
        if len(sys.argv) == 4 and sys.argv[1] == "--self-test-image":
            payload = self_test_image(sys.argv[2], sys.argv[3])
        elif len(sys.argv) == 2:
            payload = ocr_file(sys.argv[1])
        else:
            raise ValueError(
                "Usage: ocr_document_text.py <file> or "
                "ocr_document_text.py --self-test-image <image> <expected-text>"
            )
        print(json.dumps(payload, ensure_ascii=True))
    except Exception as exc:
        print(json.dumps(result(text="", warnings=["Local OCR failed: %s" % exc]), ensure_ascii=True))
        sys.exit(2)

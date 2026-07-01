#!/usr/bin/env python3
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET


NS = {
    "main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
}


def cell_col(ref):
    match = re.match(r"([A-Z]+)", ref or "")
    if not match:
        return 0
    col = 0
    for ch in match.group(1):
        col = col * 26 + ord(ch) - 64
    return col - 1


def text_from_si(si):
    parts = []
    for t in si.findall(".//main:t", NS):
        if t.text:
            parts.append(t.text)
    return "".join(parts).strip()


def read_shared_strings(zf):
    try:
        root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
    except KeyError:
        return []
    return [text_from_si(si) for si in root.findall("main:si", NS)]


def read_workbook_sheets(zf):
    try:
        wb = ET.fromstring(zf.read("xl/workbook.xml"))
        rels = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
    except KeyError:
        return []

    rel_map = {}
    for rel in rels:
        rel_id = rel.attrib.get("Id")
        target = rel.attrib.get("Target", "")
        if rel_id and target:
            rel_map[rel_id] = "xl/" + target.lstrip("/")

    sheets = []
    for sheet in wb.findall(".//main:sheet", NS):
      name = sheet.attrib.get("name", "Sheet")
      rel_id = sheet.attrib.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")
      target = rel_map.get(rel_id)
      if target:
          sheets.append((name, target))
    return sheets


def read_cell_value(cell, shared_strings):
    cell_type = cell.attrib.get("t")
    if cell_type == "inlineStr":
        return "".join(t.text or "" for t in cell.findall(".//main:t", NS)).strip()
    v = cell.find("main:v", NS)
    if v is None or v.text is None:
        return ""
    raw = v.text.strip()
    if cell_type == "s":
        try:
            return shared_strings[int(raw)]
        except Exception:
            return raw
    return raw


def extract(path, max_rows=180, max_chars=20000):
    with zipfile.ZipFile(path) as zf:
        shared_strings = read_shared_strings(zf)
        sheets = read_workbook_sheets(zf)
        lines = []
        for sheet_name, sheet_path in sheets[:8]:
            try:
                root = ET.fromstring(zf.read(sheet_path))
            except KeyError:
                continue
            lines.append("## Sheet: " + sheet_name)
            row_count = 0
            for row in root.findall(".//main:sheetData/main:row", NS):
                cells = []
                for cell in row.findall("main:c", NS):
                    value = read_cell_value(cell, shared_strings)
                    if not value:
                        continue
                    col = cell_col(cell.attrib.get("r", ""))
                    cells.append((col, value))
                if not cells:
                    continue
                cells.sort(key=lambda item: item[0])
                row_text = " | ".join(value for _, value in cells if value)
                if row_text:
                    lines.append(row_text)
                    row_count += 1
                if row_count >= max_rows or len("\n".join(lines)) >= max_chars:
                    break
        return "\n".join(lines)[:max_chars]


if __name__ == "__main__":
    file_path = sys.argv[1]
    text = extract(file_path)
    print(json.dumps({"text": text}, ensure_ascii=True))

#!/usr/bin/env python3
"""Generate an editable 16:9 TuringMarket customer-decision deck."""

import json
import os
import sys

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_AUTO_SIZE, MSO_VERTICAL_ANCHOR, PP_ALIGN
from pptx.util import Inches, Pt


SLIDE_W = 13.333
SLIDE_H = 7.5
FONT = "Microsoft YaHei"

PURPLE = RGBColor(0x6D, 0x28, 0xD9)
PURPLE_DARK = RGBColor(0x20, 0x16, 0x38)
PURPLE_SOFT = RGBColor(0xF2, 0xED, 0xFF)
BLACK = RGBColor(0x11, 0x13, 0x18)
INK = RGBColor(0x17, 0x19, 0x23)
MUTED = RGBColor(0x66, 0x70, 0x85)
LINE = RGBColor(0xD9, 0xDD, 0xE7)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
YELLOW = RGBColor(0xF4, 0xC9, 0x5D)
GREEN = RGBColor(0x16, 0x9B, 0x62)
RED = RGBColor(0xD9, 0x4A, 0x4A)


def clean(value, fallback=""):
    if value is None:
        return fallback
    return str(value).strip() or fallback


def clean_list(value):
    if isinstance(value, list):
        return [clean(item) for item in value if clean(item)]
    if isinstance(value, str):
        return [item.strip() for item in value.replace("；", "\n").splitlines() if item.strip()]
    return []


def split_point(value):
    raw = clean(value)
    for separator in ("|", "｜", ":", "："):
        if separator in raw:
            label, body = raw.split(separator, 1)
            return clean(label, "要点"), clean(body, raw)
    return raw or "要点", raw


def resolve_layout(section):
    layout = clean(section.get("layout")).lower()
    allowed = {
        "cover-image", "recommendation", "brief-register", "four-challenges",
        "evidence-table", "positioning", "audience-scene", "sequence",
        "boundary-columns", "platform-roles", "creator-mix", "scorecard",
        "content-system", "creative-split", "format-storyboard", "dark-guardrail",
        "timeline", "asset-pillars", "comparison-table", "capability-proof",
        "next-steps",
    }
    if layout in allowed:
        return layout
    return {
        "cover": "cover-image", "recommendation": "recommendation",
        "brief": "brief-register", "challenge": "four-challenges",
        "market": "evidence-table", "research": "evidence-table",
        "sources": "evidence-table", "comparison": "comparison-table",
        "positioning": "positioning", "audience": "audience-scene",
        "sequence": "sequence", "boundaries": "boundary-columns",
        "platform": "platform-roles", "creator_mix": "creator-mix",
        "team": "creator-mix", "scoring": "scorecard",
        "content_system": "content-system", "creative": "creative-split",
        "format": "format-storyboard", "compliance": "dark-guardrail",
        "timeline": "timeline", "measurement": "asset-pillars",
        "kpi": "asset-pillars", "commercial": "comparison-table",
        "stats": "comparison-table", "capability": "capability-proof",
        "next": "next-steps", "closing": "next-steps",
    }.get(clean(section.get("type"), "content").lower(), "content-system")


def normalize_payload(source):
    source = source if isinstance(source, dict) else {}
    outline = source.get("outline") if isinstance(source.get("outline"), dict) else source
    demand = source.get("demand") if isinstance(source.get("demand"), dict) else {}
    brand = clean(
        outline.get("brand") or source.get("brand") or demand.get("brand")
        or demand.get("brand_name") or demand.get("company")
        or demand.get("company_name"), "CLIENT")
    product = clean(outline.get("product") or demand.get("product")
                    or demand.get("product_name"))
    title = clean(outline.get("title") or source.get("title"),
                  f"{brand} 海外红人营销方案")
    subtitle = clean(outline.get("subtitle") or source.get("tagline"), "客户决策版")
    narrative = clean(outline.get("narrative"),
                      "从客户问题出发，形成可执行、可审核、可复盘的方案。")
    raw_sections = outline.get("sections") if isinstance(outline.get("sections"), list) else []
    sections = []
    for item in raw_sections:
        if not isinstance(item, dict):
            continue
        section = {
            "title": clean(item.get("title"), "方案页"),
            "type": clean(item.get("type"), "content").lower(),
            "layout": clean(item.get("layout")).lower(),
            "points": clean_list(item.get("points")) or clean_list(item.get("items")),
            "note": clean(item.get("note")),
            "kicker": clean(item.get("kicker")),
            "visual_brief": clean(item.get("visual_brief")),
            "status": clean(item.get("status"), "inference").lower(),
            "evidence_labels": clean_list(item.get("evidence_labels"))[:6],
        }
        section["layout"] = resolve_layout(section)
        sections.append(section)
    if not sections or sections[0]["type"] != "cover":
        sections.insert(0, {
            "title": title, "type": "cover", "layout": "cover-image",
            "points": [subtitle], "note": "TuringMarket 图灵集市",
            "kicker": "", "visual_brief": "", "status": "confirmed",
            "evidence_labels": [],
        })
    return {
        "title": title, "subtitle": subtitle, "narrative": narrative,
        "brand": brand, "product": product, "sections": sections,
    }


def add_rect(slide, x, y, width, height, fill=WHITE, line=None, rounded=False):
    shape_type = MSO_SHAPE.ROUNDED_RECTANGLE if rounded else MSO_SHAPE.RECTANGLE
    shape = slide.shapes.add_shape(
        shape_type, Inches(x), Inches(y), Inches(width), Inches(height))
    shape.fill.solid()
    shape.fill.fore_color.rgb = fill
    if line is None:
        shape.line.fill.background()
    else:
        shape.line.color.rgb = line
        shape.line.width = Pt(0.8)
    if rounded:
        try:
            shape.adjustments[0] = 0.08
        except (IndexError, TypeError):
            pass
    return shape


def add_rule(slide, x, y, width, color=BLACK, height=0.012):
    return add_rect(slide, x, y, width, height, color)


def add_text(slide, value, x, y, width, height, size=18, color=INK,
             bold=False, align=PP_ALIGN.LEFT,
             valign=MSO_VERTICAL_ANCHOR.TOP, fit=True):
    shape = slide.shapes.add_textbox(
        Inches(x), Inches(y), Inches(width), Inches(height))
    frame = shape.text_frame
    frame.clear()
    frame.word_wrap = True
    frame.margin_left = 0
    frame.margin_right = 0
    frame.margin_top = 0
    frame.margin_bottom = 0
    frame.vertical_anchor = valign
    if fit:
        frame.auto_size = MSO_AUTO_SIZE.TEXT_TO_FIT_SHAPE
    paragraph = frame.paragraphs[0]
    paragraph.text = clean(value)
    paragraph.alignment = align
    paragraph.space_after = Pt(0)
    paragraph.line_spacing = 1.08
    paragraph.font.name = FONT
    paragraph.font.size = Pt(size)
    paragraph.font.bold = bold
    paragraph.font.color.rgb = color
    return shape


def title_size(value):
    length = len(clean(value))
    return 25 if length > 34 else (29 if length > 24 else 34)


def status_label(value):
    return {"confirmed": "已确认", "pending": "待确认"}.get(value, "策略建议")


def add_chrome(slide, section, index, total, dark=False):
    primary = WHITE if dark else BLACK
    secondary = WHITE if dark else MUTED
    add_text(slide, "TuringMarket 图灵集市", 0.6, 0.25, 3.2, 0.28,
             11, YELLOW if dark else PURPLE, True)
    add_text(slide, f"{index + 1:02d} / {total:02d}", 11.7, 0.25,
             1.0, 0.28, 9, secondary, True, PP_ALIGN.RIGHT)
    add_rule(slide, 0.6, 0.62, 12.1, primary)
    kicker = section["kicker"] or section["note"] or section["type"]
    add_text(slide, kicker.upper(), 0.6, 0.77, 3.3, 0.24, 9,
             YELLOW if dark else PURPLE, True)
    status_color = GREEN if section["status"] == "confirmed" else secondary
    add_text(slide, status_label(section["status"]), 3.55, 0.76,
             1.1, 0.26, 9, status_color, True)
    if section["evidence_labels"]:
        add_text(slide, " / ".join(section["evidence_labels"]),
                 4.75, 0.76, 4.9, 0.26, 8.5, secondary)
    add_text(slide, section["title"], 0.6, 1.11, 11.7, 0.58,
             title_size(section["title"]), primary, True)


def add_footer(slide, deck, dark=False):
    footer_color = RGBColor(0xB8, 0xBD, 0xCA) if dark else RGBColor(0x8A, 0x91, 0xA3)
    line_color = RGBColor(0x54, 0x57, 0x62) if dark else LINE
    add_rule(slide, 0.6, 7.13, 12.1, line_color, 0.008)
    add_text(slide, deck["brand"], 0.6, 7.18, 4.4, 0.18,
             7.5, footer_color)
    add_text(slide, "TuringMarket 海外红人营销提案", 8.3, 7.18,
             4.4, 0.18, 7.5, footer_color, False, PP_ALIGN.RIGHT)


def add_card(slide, label, body, x, y, width, height, index=None,
             dark=False, accent=PURPLE):
    fill = BLACK if dark else WHITE
    line = RGBColor(0x54, 0x57, 0x62) if dark else LINE
    add_rect(slide, x, y, width, height, fill, line)
    add_rect(slide, x, y, width, 0.05, YELLOW if dark else accent)
    if index is not None:
        add_text(slide, f"{index:02d}", x + 0.2, y + 0.18,
                 0.55, 0.25, 9, YELLOW if dark else accent, True)
    add_text(slide, label, x + 0.2, y + 0.58, width - 0.4,
             0.55, 16, WHITE if dark else INK, True)
    add_text(slide, body, x + 0.2, y + 1.22, width - 0.4,
             max(0.45, height - 1.42), 12.5,
             RGBColor(0xC8, 0xCC, 0xD6) if dark else MUTED)


def render_cover(slide, deck, section):
    add_rect(slide, 0, 0, 6.25, SLIDE_H, BLACK)
    add_rect(slide, 6.25, 0, SLIDE_W - 6.25, SLIDE_H, PURPLE_SOFT)
    add_text(slide, "OVERSEAS INFLUENCER MARKETING", 0.75, 0.7,
             4.8, 0.3, 10, YELLOW, True)
    cover_title = section["title"] or deck["title"]
    add_text(slide, cover_title, 0.75, 1.45, 4.95, 1.8,
             35 if len(cover_title) < 30 else 29, WHITE, True,
             valign=MSO_VERTICAL_ANCHOR.MIDDLE)
    add_text(slide, deck["subtitle"], 0.75, 3.45, 4.9, 0.44,
             16, RGBColor(0xD5, 0xD8, 0xE1))
    facts = section["points"][:4] or [deck["subtitle"]]
    for index, value in enumerate(facts):
        label, body = split_point(value)
        x = 0.75 + (index % 2) * 2.45
        y = 4.4 + (index // 2) * 0.8
        add_rule(slide, x, y, 2.15, RGBColor(0x44, 0x48, 0x54), 0.008)
        add_text(slide, label, x, y + 0.12, 2.15, 0.27,
                 12, WHITE, True)
        if body != label:
            add_text(slide, body, x, y + 0.39, 2.15, 0.22,
                     8.5, RGBColor(0xAE, 0xB4, 0xC2))
    add_text(slide, deck["brand"], 6.9, 1.13, 5.2, 0.4,
             17, PURPLE, True)
    product = deck["product"] or "客户增长方案"
    add_text(slide, product, 6.9, 2.05, 5.35, 1.25,
             38 if len(product) < 24 else 29, BLACK, True,
             valign=MSO_VERTICAL_ANCHOR.MIDDLE)
    add_rect(slide, 6.9, 3.65, 0.08, 1.2, YELLOW)
    add_text(slide, deck["narrative"], 7.2, 3.62, 4.75,
             1.3, 17, MUTED, valign=MSO_VERTICAL_ANCHOR.MIDDLE)
    add_text(slide, "TM", 10.3, 5.7, 2.3, 1.15, 72,
             RGBColor(0xDC, 0xD2, 0xF8), True, PP_ALIGN.RIGHT)


def render_recommendation(slide, deck, section):
    add_rect(slide, 0.65, 1.95, 0.08, 0.95, YELLOW)
    add_text(slide, deck["narrative"], 0.95, 1.92, 11.6,
             0.98, 23, PURPLE, True,
             valign=MSO_VERTICAL_ANCHOR.MIDDLE)
    values = section["points"][:4] or ["目标|建立清晰的客户决策路径"]
    width = 12.0 / len(values)
    for index, value in enumerate(values):
        label, body = split_point(value)
        add_card(slide, label, body, 0.65 + index * width,
                 3.25, width, 2.6, index + 1)


def render_rows(slide, section, mode):
    values = section["points"][:7]
    y = 1.95
    row_height = min(0.7, 4.35 / max(1, len(values)))
    add_rule(slide, 0.65, y, 12.0, BLACK, 0.015)
    for index, value in enumerate(values):
        label, body = split_point(value)
        urgent = mode == "brief" and any(
            token in f"{label}{body}" for token in ("P0", "待确认", "缺口"))
        if urgent:
            add_rect(slide, 0.65, y + index * row_height,
                     12.0, row_height, RGBColor(0xFF, 0xF8, 0xDC))
        add_text(slide, f"{index + 1:02d}", 0.82,
                 y + index * row_height + 0.11, 0.5, 0.25,
                 10, PURPLE, True)
        label_width = 2.4 if mode == "next" else 2.2
        add_text(slide, label, 1.5,
                 y + index * row_height + 0.07, label_width,
                 row_height - 0.08, 13, INK, True,
                 valign=MSO_VERTICAL_ANCHOR.MIDDLE)
        add_text(slide, body, 1.65 + label_width,
                 y + index * row_height + 0.07,
                 10.45 - label_width, row_height - 0.08,
                 12, MUTED, valign=MSO_VERTICAL_ANCHOR.MIDDLE)
        add_rule(slide, 0.65, y + (index + 1) * row_height,
                 12.0, LINE, 0.008)


def render_columns(slide, section, mode):
    limit = 5 if mode in ("sequence", "storyboard") else 4
    values = section["points"][:limit]
    width = 12.0 / max(1, len(values))
    for index, value in enumerate(values):
        label, body = split_point(value)
        x = 0.65 + index * width
        dark = mode == "sequence" and index == len(values) - 1
        first_story = mode == "storyboard" and index == 0
        bordered = mode == "storyboard"
        add_rect(slide, x + (0.04 if bordered else 0), 1.95,
                 width - (0.08 if bordered else 0), 4.45,
                 BLACK if dark or first_story else WHITE,
                 BLACK if dark or first_story else LINE, bordered)
        accent = YELLOW if dark or first_story else PURPLE
        if bordered:
            add_rect(slide, x + 0.04, 1.95,
                     width - 0.08, 0.07, accent)
        add_text(slide, f"{index + 1:02d}", x + 0.22,
                 2.25, width - 0.44, 0.52,
                 22 if mode == "challenge" else 14, accent, True)
        add_text(slide, label, x + 0.22, 4.05,
                 width - 0.44, 0.72, 15,
                 WHITE if dark or first_story else INK, True)
        add_text(slide, body, x + 0.22, 4.94,
                 width - 0.44, 1.05, 10.8,
                 RGBColor(0xCF, 0xD3, 0xDD)
                 if dark or first_story else MUTED)


def render_table(slide, section):
    values = section["points"][:6]
    columns = ((0.65, 2.8, "议题"), (3.45, 5.65, "证据或现状"),
               (9.1, 3.55, "本方案处理"))
    for x, width, heading in columns:
        add_rect(slide, x, 1.95, width, 0.48, BLACK)
        add_text(slide, heading, x + 0.15, 2.06,
                 width - 0.3, 0.22, 10.5, WHITE, True)
    row_height = min(0.72, 3.9 / max(1, len(values)))
    for index, value in enumerate(values):
        label, body = split_point(value)
        y = 2.43 + index * row_height
        fill = WHITE if index % 2 == 0 else RGBColor(0xF8, 0xF9, 0xFB)
        for x, width, _ in columns:
            add_rect(slide, x, y, width, row_height, fill)
            add_rule(slide, x, y + row_height, width, LINE, 0.008)
        add_text(slide, label, 0.8, y + 0.08, 2.5,
                 row_height - 0.12, 11, PURPLE, True,
                 valign=MSO_VERTICAL_ANCHOR.MIDDLE)
        add_text(slide, body, 3.62, y + 0.08, 5.3,
                 row_height - 0.12, 10.5, MUTED,
                 valign=MSO_VERTICAL_ANCHOR.MIDDLE)
        action = "执行前复核" if section["status"] == "pending" else (
            "作为判断依据" if index == 0 else "转化为执行动作")
        add_text(slide, action, 9.28, y + 0.08, 3.2,
                 row_height - 0.12, 10.5, INK,
                 valign=MSO_VERTICAL_ANCHOR.MIDDLE)


def render_split(slide, deck, section, mode):
    values = section["points"][:5]
    if mode == "positioning":
        lead = values.pop(0) if values else section["title"]
        add_text(slide, f"“{split_point(lead)[1]}”", 0.65, 2.0,
                 6.05, 3.8, 28, PURPLE, True,
                 valign=MSO_VERTICAL_ANCHOR.MIDDLE)
        add_rect(slide, 6.95, 1.95, 0.012, 4.45, LINE)
        for index, value in enumerate(values):
            label, body = split_point(value)
            y = 2.0 + index * 1.05
            add_text(slide, label, 7.3, y, 1.45, 0.4,
                     13, INK, True)
            add_text(slide, body, 8.85, y, 3.45, 0.75,
                     12, MUTED)
            add_rule(slide, 7.3, y + 0.88, 5.0, LINE, 0.008)
        return
    side_dark = mode == "creative"
    side_x = 0.65 if side_dark else 7.55
    side_width = 4.9 if side_dark else 5.1
    add_rect(slide, side_x, 1.95, side_width, 4.55,
             BLACK if side_dark else PURPLE_SOFT)
    add_text(slide, "CONTENT CONCEPT" if side_dark else "SCENE DIRECTION",
             side_x + 0.35, 2.35, 3.4, 0.28, 9,
             YELLOW if side_dark else PURPLE, True)
    add_text(slide, deck["product"] or deck["brand"],
             side_x + 0.35, 3.65, side_width - 0.8,
             0.85, 27, WHITE if side_dark else BLACK, True)
    visual = section["visual_brief"] or (
        "使用客户正式产品素材或与品类一致的概念场景示意。"
        if side_dark else
        f"用真实场景说明 {deck['product'] or '产品'} 与目标用户任务的关系。")
    add_text(slide, visual, side_x + 0.35, 4.72,
             side_width - 0.8, 1.15, 12,
             RGBColor(0xCF, 0xD3, 0xDD) if side_dark else MUTED)
    list_x = 5.95 if side_dark else 0.65
    label_width = 1.55 if side_dark else 1.7
    body_width = 4.65 if side_dark else 4.75
    for index, value in enumerate(values):
        label, body = split_point(value)
        y = 2.0 + index * 0.83
        add_text(slide, label, list_x, y, label_width,
                 0.32, 12.5, INK, True)
        add_text(slide, body, list_x + label_width + 0.15,
                 y, body_width, 0.6, 11.5, MUTED)
        add_rule(slide, list_x, y + 0.7,
                 label_width + body_width + 0.15, LINE, 0.008)


def render_boundaries(slide, section):
    labels = ("可使用", "待核实", "禁止")
    colors = (GREEN, YELLOW, RED)
    for index, value in enumerate(section["points"][:3]):
        label, body = split_point(value)
        x = 0.65 + index * 4.08
        add_rect(slide, x, 1.95, 3.82, 4.45, WHITE, LINE, True)
        add_rect(slide, x, 1.95, 3.82, 0.08, colors[index])
        add_text(slide, labels[index], x + 0.28, 2.28,
                 3.26, 0.26, 10, colors[index], True)
        add_text(slide, label, x + 0.28, 3.7,
                 3.26, 0.7, 19, INK, True)
        add_text(slide, body, x + 0.28, 4.6,
                 3.26, 1.2, 12.5, MUTED)


def render_scorecard(slide, section):
    for index, value in enumerate(section["points"][:7]):
        label, body = split_point(value)
        y = 2.0 + index * 0.62
        digit_text = "".join(
            char for char in f"{label} {body}" if char.isdigit())
        score = max(12, min(100, int(digit_text[:3]))) if digit_text else max(25, 88 - index * 10)
        add_text(slide, label, 0.65, y, 2.1,
                 0.3, 12, INK, True)
        add_rect(slide, 2.9, y + 0.08, 5.8,
                 0.13, RGBColor(0xEC, 0xEE, 0xF3), rounded=True)
        add_rect(slide, 2.9, y + 0.08, 5.8 * score / 100,
                 0.13, PURPLE, rounded=True)
        add_text(slide, body, 9.0, y - 0.02,
                 3.45, 0.34, 10.5, MUTED)


def render_grid(slide, section, dark=False):
    values = section["points"][:6] or [section["note"] or section["title"]]
    rows = (len(values) + 2) // 3
    card_height = 4.35 / max(1, rows)
    for index, value in enumerate(values):
        label, body = split_point(value)
        add_card(slide, label, body,
                 0.65 + (index % 3) * 4.0,
                 1.95 + (index // 3) * card_height,
                 4.0, card_height, index + 1, dark)


def render_timeline(slide, section):
    values = section["points"][:6]
    width = 12.0 / max(1, len(values))
    add_rule(slide, 0.65, 2.35, 12.0, BLACK, 0.015)
    for index, value in enumerate(values):
        parts = [clean(part) for part in clean(value).split("|")]
        label = parts[0] or f"阶段 {index + 1}"
        timing = parts[1] if len(parts) > 1 else "待确认"
        body = parts[2] if len(parts) > 2 else (
            parts[1] if len(parts) > 1 else clean(value))
        deliverable = parts[3] if len(parts) > 3 else "阶段交付物"
        x = 0.65 + index * width
        dot = slide.shapes.add_shape(
            MSO_SHAPE.OVAL, Inches(x + 0.2), Inches(2.16),
            Inches(0.38), Inches(0.38))
        dot.fill.solid()
        dot.fill.fore_color.rgb = PURPLE
        dot.line.fill.background()
        add_text(slide, f"{index + 1:02d}", x + 0.2,
                 2.23, 0.38, 0.13, 7.5, WHITE, True,
                 PP_ALIGN.CENTER)
        add_text(slide, label, x + 0.2, 2.85,
                 width - 0.4, 0.55, 14, INK, True)
        add_text(slide, timing, x + 0.2, 3.5,
                 width - 0.4, 0.3, 10, PURPLE, True)
        add_text(slide, body, x + 0.2, 4.05,
                 width - 0.4, 1.0, 10.5, MUTED)
        add_text(slide, deliverable, x + 0.2, 5.45,
                 width - 0.4, 0.45, 9.5, INK, True)


def render_body(slide, deck, section):
    layout = section["layout"]
    if layout == "recommendation":
        render_recommendation(slide, deck, section)
    elif layout == "brief-register":
        render_rows(slide, section, "brief")
    elif layout == "four-challenges":
        render_columns(slide, section, "challenge")
    elif layout in ("evidence-table", "comparison-table"):
        render_table(slide, section)
    elif layout == "positioning":
        render_split(slide, deck, section, "positioning")
    elif layout == "audience-scene":
        render_split(slide, deck, section, "audience")
    elif layout == "creative-split":
        render_split(slide, deck, section, "creative")
    elif layout == "sequence":
        render_columns(slide, section, "sequence")
    elif layout == "format-storyboard":
        render_columns(slide, section, "storyboard")
    elif layout == "boundary-columns":
        render_boundaries(slide, section)
    elif layout in ("platform-roles", "creator-mix"):
        render_rows(slide, section, "role")
    elif layout == "scorecard":
        render_scorecard(slide, section)
    elif layout == "timeline":
        render_timeline(slide, section)
    elif layout == "next-steps":
        render_rows(slide, section, "next")
    else:
        render_grid(slide, section,
                    layout in ("dark-guardrail", "capability-proof"))


def generate(source, output_path):
    deck = normalize_payload(source)
    presentation = Presentation()
    presentation.slide_width = Inches(SLIDE_W)
    presentation.slide_height = Inches(SLIDE_H)
    total = len(deck["sections"])
    for index, section in enumerate(deck["sections"]):
        slide = presentation.slides.add_slide(presentation.slide_layouts[6])
        if section["type"] == "cover" or section["layout"] == "cover-image":
            render_cover(slide, deck, section)
            continue
        dark = section["layout"] in ("dark-guardrail", "capability-proof")
        background = PURPLE_DARK if section["layout"] == "capability-proof" else (
            BLACK if dark else WHITE)
        slide.background.fill.solid()
        slide.background.fill.fore_color.rgb = background
        add_chrome(slide, section, index, total, dark)
        render_body(slide, deck, section)
        add_footer(slide, deck, dark)
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    presentation.save(output_path)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: generate_ppt.py INPUT_JSON OUTPUT_PPTX")
    with open(sys.argv[1], "r", encoding="utf-8") as handle:
        payload = json.load(handle)
    generate(payload, sys.argv[2])
    print("OK")

#!/usr/bin/env python3
"""TuringMarket PPT Generator - called from Node.js"""
import json, sys, os
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN

def generate(data, output_path):
    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)

    BLUE = RGBColor(0x1F, 0x4E, 0x79)
    DARK = RGBColor(0x33, 0x33, 0x33)
    WHITE = RGBColor(0xFF, 0xFF, 0xFF)

    def add_slide(title, bullets):
        slide = prs.slides.add_slide(prs.slide_layouts[6])
        # Title
        tb = slide.shapes.add_textbox(Inches(0.8), Inches(0.5), Inches(11.7), Inches(1))
        tf = tb.text_frame
        p = tf.paragraphs[0]
        p.text = title
        p.font.size = Pt(36)
        p.font.bold = True
        p.font.color.rgb = BLUE
        # Bullets
        tb2 = slide.shapes.add_textbox(Inches(0.8), Inches(1.6), Inches(11.7), Inches(5))
        tf2 = tb2.text_frame
        tf2.word_wrap = True
        for i, b in enumerate(bullets):
            p = tf2.paragraphs[0] if i == 0 else tf2.add_paragraph()
            p.text = b
            p.font.size = Pt(18)
            p.font.color.rgb = DARK
            p.space_after = Pt(12)

    def add_cover(title, subtitle):
        slide = prs.slides.add_slide(prs.slide_layouts[6])
        bg = slide.background
        bg.fill.solid()
        bg.fill.fore_color.rgb = BLUE
        tb = slide.shapes.add_textbox(Inches(1), Inches(2), Inches(11.3), Inches(2))
        tf = tb.text_frame
        p = tf.paragraphs[0]
        p.text = title
        p.font.size = Pt(44)
        p.font.bold = True
        p.font.color.rgb = WHITE
        p.alignment = PP_ALIGN.CENTER
        tb2 = slide.shapes.add_textbox(Inches(1), Inches(4.5), Inches(11.3), Inches(1))
        tf2 = tb2.text_frame
        p2 = tf2.paragraphs[0]
        p2.text = subtitle or "TuringMarket · 海外红人营销方案"
        p2.font.size = Pt(20)
        p2.font.color.rgb = RGBColor(0xCC, 0xDD, 0xFF)
        p2.alignment = PP_ALIGN.CENTER

    add_cover(data.get('brand', 'Brand') + ' Influencer Marketing Proposal', data.get('tagline', ''))
    for section in data.get('sections', []):
        add_slide(section.get('title', ''), section.get('items', []))

    os.makedirs(os.path.dirname(output_path) or '.', exist_ok=True)
    prs.save(output_path)
    return True

if __name__ == '__main__':
    data_path = sys.argv[1]
    out_path = sys.argv[2]
    with open(data_path, 'r') as f:
        data = json.load(f)
    generate(data, out_path)
    print('OK')

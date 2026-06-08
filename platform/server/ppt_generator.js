// PPT Generator using python-pptx
// Called from Node.js via child_process
// Generates a professional proposal PPTX from JSON content

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function generatePPTX(data, outputPath) {
  const script = `
import json, sys
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN

data = json.loads('''${JSON.stringify(data).replace(/'/g, "'\\''")}''')

prs = Presentation()
prs.slide_width = Inches(13.333)
prs.slide_height = Inches(7.5)

BLUE = RGBColor(0x1F, 0x4E, 0x79)
DARK = RGBColor(0x33, 0x33, 0x33)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
GRAY = RGBColor(0x66, 0x66, 0x66)

def add_slide(title, bullets, bg_color=None):
    slide_layout = prs.slide_layouts[6]  # blank
    slide = prs.slides.add_slide(slide_layout)

    # Title
    txBox = slide.shapes.add_textbox(Inches(0.8), Inches(0.5), Inches(11.7), Inches(1))
    tf = txBox.text_frame
    p = tf.paragraphs[0]
    p.text = title
    p.font.size = Pt(36)
    p.font.bold = True
    p.font.color.rgb = BLUE

    # Divider line
    from pptx.util import Emu
    line = slide.shapes.add_shape(
        1, Inches(0.8), Inches(1.3), Inches(4), Pt(4)  # rectangle
    )
    line.fill.background()
    line.line.color.rgb = BLUE
    line.line.width = Pt(4)

    # Bullets
    txBox2 = slide.shapes.add_textbox(Inches(0.8), Inches(1.6), Inches(11.7), Inches(5))
    tf2 = txBox2.text_frame
    tf2.word_wrap = True

    for i, bullet in enumerate(bullets):
        if i == 0:
            p = tf2.paragraphs[0]
        else:
            p = tf2.add_paragraph()
        p.text = bullet
        p.font.size = Pt(18)
        p.font.color.rgb = DARK
        p.space_after = Pt(12)
        p.level = 0

def add_cover_slide(title, subtitle):
    slide_layout = prs.slide_layouts[6]
    slide = prs.slides.add_slide(slide_layout)

    # Background
    bg = slide.background
    fill = bg.fill
    fill.solid()
    fill.fore_color.rgb = BLUE

    txBox = slide.shapes.add_textbox(Inches(1), Inches(2), Inches(11.3), Inches(2))
    tf = txBox.text_frame
    p = tf.paragraphs[0]
    p.text = title
    p.font.size = Pt(44)
    p.font.bold = True
    p.font.color.rgb = WHITE
    p.alignment = PP_ALIGN.CENTER

    txBox2 = slide.shapes.add_textbox(Inches(1), Inches(4.2), Inches(11.3), Inches(1.5))
    tf2 = txBox2.text_frame
    p2 = tf2.paragraphs[0]
    p2.text = subtitle
    p2.font.size = Pt(22)
    p2.font.color.rgb = RGBColor(0xCC, 0xDD, 0xFF)
    p2.alignment = PP_ALIGN.CENTER

    txBox3 = slide.shapes.add_textbox(Inches(1), Inches(6), Inches(11.3), Inches(1))
    tf3 = txBox3.text_frame
    p3 = tf3.paragraphs[0]
    p3.text = "TuringMarket 图灵集市 · 海外红人营销方案"
    p3.font.size = Pt(14)
    p3.font.color.rgb = RGBColor(0xAA, 0xBB, 0xEE)
    p3.alignment = PP_ALIGN.CENTER

# Build slides
add_cover_slide(data.get('brand', 'Brand') + ' Influencer Marketing Proposal',
                data.get('tagline', 'AI-Powered Cross-border Marketing Strategy'))

sections = data.get('sections', [])
for section in sections:
    add_slide(section.get('title', 'Section'), section.get('items', []))

# Save
prs.save('${outputPath.replace(/\\/g, '/')}')
print('OK')
`;

  const scriptPath = path.join(__dirname, '..', 'tmp_ppt_gen.py');
  fs.writeFileSync(scriptPath, script, 'utf8');

  try {
    const output = execSync(`python3 ${scriptPath}`, { timeout: 30000, cwd: __dirname });
    fs.unlinkSync(scriptPath);
    return { success: true, output: output.toString() };
  } catch (e) {
    try { fs.unlinkSync(scriptPath); } catch(e2) {}
    return { success: false, error: e.message };
  }
}

module.exports = { generatePPTX };

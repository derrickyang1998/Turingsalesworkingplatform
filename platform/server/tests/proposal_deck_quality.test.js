'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const latestUiCompat = require('../services/latest_ui_compat_service');

const generatorPath = path.join(__dirname, '..', 'generate_ppt.py');

function demand() {
  return {
    brand: 'Northstar Home',
    product: 'Home safety alarm',
    target_market: 'United States',
    budget_range: 'USD 100,000',
    platforms: ['YouTube', 'Instagram', 'TikTok'],
    competitors: ['Alpha', 'Beta']
  };
}

test('proposal and deck prompts require a client decision story with evidence boundaries', () => {
  const proposalPrompt = latestUiCompat.buildProposalDraftPrompt({
    demandText: JSON.stringify(demand()),
    template: { name: '全案战略方案' }
  });
  assert.match(proposalPrompt, /客户决策型/);
  assert.match(proposalPrompt, /已确认事实/);
  assert.match(proposalPrompt, /策略推断/);
  assert.match(proposalPrompt, /待客户确认/);
  assert.match(proposalPrompt, /推荐路径/);
  assert.match(proposalPrompt, /备选路径/);
  assert.match(proposalPrompt, /不要使用.*AI/);

  const deckPrompt = latestUiCompat.buildPptOutlinePrompt({
    demand: demand(),
    proposal: '# Approved proposal',
    knowledgeContext: '[KB-1] Approved playbook',
    research: { results: [] }
  });
  assert.match(deckPrompt, /18-24/);
  assert.match(deckPrompt, /80%/);
  assert.match(deckPrompt, /20%/);
  assert.match(deckPrompt, /brand, product/);
  assert.match(deckPrompt, /HTMLPPT.*PPTX/);
  assert.match(deckPrompt, /visual_brief/);
  assert.match(deckPrompt, /evidence_labels/);
});

test('fallback is the approved 24-page decision flow and preserves client identity', () => {
  const outline = latestUiCompat.buildPptOutlineFallback(
    demand(),
    '# Approved proposal',
    'offline',
    { used: false, results: [] }
  );
  assert.equal(outline.sections.length, 24);
  assert.equal(outline.brand, 'Northstar Home');
  assert.equal(outline.product, 'Home safety alarm');
  assert.equal(outline.sections[0].type, 'cover');
  assert.equal(outline.sections[1].type, 'recommendation');
  assert.ok(outline.sections.some((section) => section.type === 'comparison'));
  assert.ok(outline.sections.some((section) => section.type === 'creative'));
  assert.ok(outline.sections.some((section) => section.type === 'compliance'));
  assert.ok(outline.sections.some((section) => section.type === 'capability'));
  assert.equal(outline.sections.at(-1).type, 'next');
  const capabilityIndex = outline.sections.findIndex((section) => section.type === 'capability');
  assert.ok(capabilityIndex >= Math.floor(outline.sections.length * 0.7));
  assert.ok(outline.sections.every((section) => section.layout));
});

test('PPTX generator keeps canonical page count, client identity, content, and layout variety', { timeout: 30_000 }, () => {
  const outline = latestUiCompat.buildPptOutlineFallback(
    demand(), '# Approved proposal', '', { used: false, results: [] }
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-decision-deck-'));
  const inputPath = path.join(root, 'outline.json');
  const outputPath = path.join(root, 'proposal.pptx');
  fs.writeFileSync(inputPath, JSON.stringify(outline), 'utf8');

  const python = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
  const generated = childProcess.spawnSync(python, [generatorPath, inputPath, outputPath], {
    cwd: path.dirname(generatorPath), encoding: 'utf8', env
  });
  assert.equal(generated.status, 0, generated.stderr || generated.stdout);

  const inspectCode = [
    'import json, sys',
    'from pptx import Presentation',
    'prs = Presentation(sys.argv[1])',
    'slides = []',
    'for slide in prs.slides:',
    '    texts = [shape.text for shape in slide.shapes if hasattr(shape, "text") and shape.text]',
    '    slides.append({"text": "\\n".join(texts), "shape_count": len(slide.shapes)})',
    'print(json.dumps({"count": len(prs.slides), "slides": slides}, ensure_ascii=False))'
  ].join('\n');
  const inspected = childProcess.spawnSync(python, ['-c', inspectCode, outputPath], {
    encoding: 'utf8', env
  });
  assert.equal(inspected.status, 0, inspected.stderr || inspected.stdout);
  const report = JSON.parse(inspected.stdout);

  assert.equal(report.count, 24);
  assert.match(report.slides[0].text, /Northstar Home/);
  assert.match(report.slides[0].text, /Home safety alarm/);
  assert.doesNotMatch(report.slides[0].text, /CLIENT/);
  assert.match(report.slides[1].text, /建立产品理解与信任/);
  assert.match(report.slides[18].text, /Claims Matrix/);
  assert.ok(report.slides.slice(1).every((slide) => slide.text.includes('TuringMarket')));
  assert.ok(new Set(report.slides.map((slide) => slide.shape_count)).size >= 6);
});

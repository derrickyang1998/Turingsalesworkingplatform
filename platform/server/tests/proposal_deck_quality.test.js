'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const latestUiCompat = require('../services/latest_ui_compat_service');

const appPath = path.join(__dirname, '..', '..', 'app.js');
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
  assert.match(deckPrompt, /正好 24 页/);
  assert.doesNotMatch(deckPrompt, /18-24/);
  assert.match(deckPrompt, /80%/);
  assert.match(deckPrompt, /20%/);
  assert.match(deckPrompt, /brand, product/);
  assert.match(deckPrompt, /HTMLPPT.*PPTX/);
  assert.match(deckPrompt, /visual_brief/);
  assert.match(deckPrompt, /evidence_labels/);
});

test('fallback is the approved 24-page decision flow and preserves client identity', () => {
  const approvedProposal = 'APPROVED-HUMAN-PLAN: lead with a verified home-safety demonstration.';
  const outline = latestUiCompat.buildPptOutlineFallback(
    demand(),
    approvedProposal,
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
  assert.match(outline.sections[1].points.join('\n'), /APPROVED-HUMAN-PLAN/);
  assert.deepEqual(
    outline.sections.map((section) => section.type),
    [
      'cover', 'recommendation', 'brief', 'challenge', 'market', 'comparison',
      'positioning', 'audience', 'sequence', 'boundaries', 'platform', 'creator_mix',
      'scoring', 'content_system', 'creative', 'creative', 'format', 'format',
      'compliance', 'timeline', 'measurement', 'commercial', 'capability', 'next'
    ]
  );
  assert.equal(new Set(outline.sections.map((section) => section.slot_key)).size, 24);
  assert.ok(outline.sections[0].evidence_labels.length > 0);
  const capabilityIndex = outline.sections.findIndex((section) => section.type === 'capability');
  assert.ok(capabilityIndex >= Math.floor(outline.sections.length * 0.7));
  assert.ok(outline.sections.every((section) => section.layout));
});

test('AI outline normalization repairs noncanonical output to the approved 24-page flow', () => {
  const fallback = latestUiCompat.buildPptOutlineFallback(
    demand(),
    '# Approved proposal',
    '',
    { used: false, results: [] }
  );
  const repaired = latestUiCompat.normalizePptOutline({
    title: 'AI customer decision deck',
    brand: 'Northstar Home',
    product: 'Home safety alarm',
    sections: [{
      title: 'AI recommendation retained',
      type: 'recommendation',
      layout: 'recommendation',
      points: ['Use verified customer evidence']
    }]
  }, fallback, { used: false, results: [] });

  assert.equal(repaired.sections.length, 24);
  assert.equal(repaired.sections[0].type, 'cover');
  assert.equal(repaired.sections[1].title, 'AI recommendation retained');
  assert.equal(repaired.sections.at(-1).type, 'next');
  assert.equal(repaired.structure_repaired, true);

  const canonical = latestUiCompat.normalizePptOutline({ sections: fallback.sections }, fallback, {});
  assert.equal(canonical.sections.length, 24);
  assert.equal(canonical.structure_repaired, false);
});

test('AI outline normalization repairs malformed 24-page output without losing unmatched content', () => {
  const fallback = latestUiCompat.buildPptOutlineFallback(
    demand(),
    'APPROVED-HUMAN-SENTINEL',
    '',
    { used: false, results: [] }
  );
  const malformed = fallback.sections.slice(1).map((section) => ({ ...section }));
  const longTail = 'UNMAPPED-TAIL-' + 'x'.repeat(900) + '-TAIL-END';
  malformed.push({
    title: 'UNMAPPED-CRITICAL-SENTINEL',
    type: 'unexpected_ai_type',
    layout: 'content-system',
    points: ['Do not silently discard this approved customer constraint', longTail],
    status: 'confirmed',
    evidence_labels: []
  });
  const repaired = latestUiCompat.normalizePptOutline({
    brand: 'MODEL-DRIFT-BRAND',
    product: 'MODEL-DRIFT-PRODUCT',
    sections: malformed
  }, fallback, {});

  assert.equal(repaired.sections.length, 24);
  assert.equal(repaired.sections[0].type, 'cover');
  assert.equal(repaired.brand, 'Northstar Home');
  assert.equal(repaired.product, 'Home safety alarm');
  assert.equal(repaired.structure_repaired, true);
  assert.match(repaired.sections[2].points.join('\n'), /UNMAPPED-CRITICAL-SENTINEL/);
  assert.match(repaired.sections[2].points.join('\n'), /结构校验/);
  assert.match(repaired.sections[2].points.join('\n'), /TAIL-END/);
  assert.equal(repaired.unmapped_sections.length, 1);
});

test('declared slot keys cannot override incompatible section types or semantic duplicate slots', () => {
  const fallback = latestUiCompat.buildPptOutlineFallback(demand(), '', '', { used: false, results: [] });
  const generated = fallback.sections.map((section) => ({ ...section }));
  generated[1] = {
    title: 'Recommendation must stay in recommendation',
    type: 'recommendation',
    slot_key: 'next',
    points: ['RECOMMENDATION-SENTINEL']
  };
  generated[23] = {
    title: 'Next steps must stay last',
    type: 'next',
    slot_key: 'recommendation',
    points: ['NEXT-SENTINEL']
  };
  generated[14] = {
    title: 'Search comparison creative',
    type: 'creative',
    slot_key: 'creative_primary',
    points: ['SEARCH-SENTINEL']
  };
  generated[15] = {
    title: 'Real task creative',
    type: 'creative',
    slot_key: 'creative_search',
    points: ['PRIMARY-SENTINEL']
  };

  const repaired = latestUiCompat.normalizePptOutline({ sections: generated }, fallback, {});
  assert.match(repaired.sections[1].points.join('\n'), /RECOMMENDATION-SENTINEL/);
  assert.match(repaired.sections[23].points.join('\n'), /NEXT-SENTINEL/);
  assert.match(repaired.sections[14].points.join('\n'), /PRIMARY-SENTINEL/);
  assert.match(repaired.sections[15].points.join('\n'), /SEARCH-SENTINEL/);
  assert.equal(repaired.structure_repaired, true);
});

test('duplicate creative and format slots retain their intended semantic order', () => {
  const fallback = latestUiCompat.buildPptOutlineFallback(demand(), '', '', { used: false, results: [] });
  const generated = fallback.sections.map((section) => ({ ...section }));
  generated[14] = { title: 'Search comparison creative', type: 'creative', points: ['SEARCH-CREATIVE'] };
  generated[15] = { title: 'Real task creative', type: 'creative', points: ['PRIMARY-CREATIVE'] };
  generated[16] = { title: 'TikTok short format', type: 'format', points: ['SHORT-FORMAT'] };
  generated[17] = { title: 'YouTube long format', type: 'format', points: ['LONG-FORMAT'] };

  const repaired = latestUiCompat.normalizePptOutline({ sections: generated }, fallback, {});
  assert.match(repaired.sections[14].points.join('\n'), /PRIMARY-CREATIVE/);
  assert.match(repaired.sections[15].points.join('\n'), /SEARCH-CREATIVE/);
  assert.match(repaired.sections[16].points.join('\n'), /LONG-FORMAT/);
  assert.match(repaired.sections[17].points.join('\n'), /SHORT-FORMAT/);
});

test('confirmed AI claims without evidence are downgraded to pending', () => {
  const fallback = latestUiCompat.buildPptOutlineFallback(demand(), '', '', { used: false, results: [] });
  const generated = fallback.sections.map((section) => ({ ...section }));
  generated[4] = {
    title: 'Unsupported market certainty',
    type: 'market',
    layout: 'evidence-table',
    points: ['Unsupported statement'],
    status: 'confirmed',
    evidence_labels: ['   ']
  };
  const normalized = latestUiCompat.normalizePptOutline({ sections: generated }, fallback, {});
  assert.equal(normalized.sections[4].status, 'pending');
  assert.ok(normalized.sections[0].evidence_labels.length > 0);
  assert.equal(normalized.sections[0].status, 'confirmed');
});

test('HTML decision deck lets its runtime position the fixed 16:9 stage exactly once', () => {
  const source = fs.readFileSync(appPath, 'utf8');
  const marker = source.indexOf('// ===== DECISION DECK V2 RENDERER =====');
  assert.notEqual(marker, -1);
  const renderer = source.slice(marker);
  assert.match(renderer, /\.tm-deck-viewport\{position:fixed;inset:0;overflow:hidden\}/);
  assert.match(renderer, /\.tm-deck-stage\{position:absolute;left:0;top:0;width:1920px;height:1080px;transform-origin:0 0/);
  assert.doesNotMatch(renderer, /\.tm-deck-viewport\{[^}]*display:grid[^}]*place-items:center/);
  assert.match(renderer, /closest\(\"button,input,select,textarea,a,\[contenteditable=true\]\"\)/);
  assert.match(renderer, /event\.key===\" \"&&interactive/);
  assert.match(renderer, /slot_key:\s*String\(rich\.slot_key\s*\|\|\s*section\.slot_key\s*\|\|\s*''\)\.trim\(\)/);
  assert.match(renderer, /evidence_labels:\s*\['\[需求表\/客户资料\]'\]/);
});

test('PPTX generator keeps canonical page count, client identity, content, and layout variety', { timeout: 30_000 }, () => {
  const outline = latestUiCompat.buildPptOutlineFallback(
    demand(), '# Approved proposal', '', { used: false, results: [] }
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-decision-deck-'));
  const inputPath = path.join(root, 'outline.json');
  const outputPath = path.join(root, 'proposal.pptx');
  fs.writeFileSync(inputPath, JSON.stringify({
    demand: demand(),
    outline: { ...outline, brand: 'MODEL DRIFT BRAND', product: 'MODEL DRIFT PRODUCT' }
  }), 'utf8');

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
  assert.doesNotMatch(report.slides[0].text, /MODEL DRIFT/);
  assert.match(report.slides[1].text, /建立产品理解与信任/);
  assert.match(report.slides[18].text, /Claims Matrix/);
  assert.ok(report.slides.slice(1).every((slide) => slide.text.includes('TuringMarket')));
  assert.ok(new Set(report.slides.map((slide) => slide.shape_count)).size >= 6);
});

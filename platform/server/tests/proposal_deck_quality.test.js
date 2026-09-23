'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
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

function tideweDemand() {
  return {
    brand: 'TideWe',
    product: 'BL001: Vis Series 270 Degree See Through Hunting Blind | Portable 2 3 4 Person Ground Blind | Camo Pop Up Deer Blind for Deer & Hunters; BL008: Vis360 See Through Ground Blind | 360 Degree Camouflage Pop Up Hunting Blind for 2/3/4 Person | Portable Deer Blind with Orange Cover',
    area: '美国',
    budget: '$5-10万 USD',
    platform: 'YouTube',
    category: '户外打猎装备',
    competitors: 'KUIU, Sitka Gear',
    notes: '粉丝不限，关键看红人匹配度、均播和最终转化；类型要求：户外打猎；账号语言要求：英语；样品货值：100美元；样品赠送；预期视频发布日期范围：12月以内快速上线；受众定位：年龄30+，男性为主，兴趣词 hunting、deerhunting、bowhunting；项目背景：TideWe圣诞/新年YouTube红人推广需求',
    source_text: [
      '项目背景 | TideWe圣诞/新年YouTube红人推广需求',
      '推广产品关键卖点信息 | 关键卖点1:透视能力强，视野广',
      '关键卖点2:隐蔽性，静音防风防气味扩散',
      '关键卖点3:收放方便',
      '受众定位 | 年龄：30+ 性别：男性为主 兴趣词：hunting，deerhunting，bowhunting',
      '意向平台 | YouTube',
      '类型要求 | 户外打猎',
      '预期视频发布日期范围 | 12月以内快速上线'
    ].join('\n')
  };
}

function visibleDeckText(outline) {
  return [outline.title, outline.subtitle, outline.narrative, outline.brand, outline.product]
    .concat((outline.sections || []).flatMap((section) => [
      section.title,
      section.note,
      section.kicker,
      section.visual_brief,
      ...(section.points || [])
    ]))
    .filter(Boolean)
    .join('\n');
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
  assert.match(proposalPrompt, /不得出现.*AI/);

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
  assert.match(deckPrompt, /客户可见文案/);
  assert.match(deckPrompt, /不得出现.*AI/);
  assert.match(deckPrompt, /不得把.*\[KB-n\].*写入/);
});

test('client text repair removes mojibake, evidence markers, and internal authoring language', () => {
  const repaired = latestUiCompat.clientSafeDeckText(
    '[KB-2] BLUETTIæ°åElite 300çº¢äººæ¨å¹¿éæ±è¡¨ - AI outline was normalized - P0待确认'
  );
  assert.match(repaired, /BLUETTI新品Elite 300红人推广需求表/);
  assert.match(repaired, /启动前确认/);
  assert.doesNotMatch(repaired, /æ|çº|\[KB-|AI outline|P0/);
});

test('client text repair preserves legitimate AI product names and product facts', () => {
  const productFact = 'Acme AI Camera，支持 AI 分析告警、AI 分析建议：根据告警历史给出处置方案，以及 AI recommendation engine';
  assert.equal(latestUiCompat.clientSafeDeckText(productFact), productFact);
  assert.equal(latestUiCompat.clientSafeDeckText('AI生成的方案：客户版本'), '方案：客户版本');
});

test('proposal knowledge scope is bound to the current campaign or business entity', () => {
  assert.deepEqual(
    latestUiCompat.pptKnowledgeScope({ brand: 'Acme' }, 12),
    { business_type: 'campaign', business_id: '12' }
  );
  assert.deepEqual(
    latestUiCompat.pptKnowledgeScope({ id: 31, brand: 'Acme' }),
    { business_type: 'demand', business_id: '31' }
  );
  assert.deepEqual(
    latestUiCompat.pptKnowledgeScope({ brand: 'Acme' }),
    { business_type: 'brand', business_id: 'Acme' }
  );
  assert.deepEqual(
    latestUiCompat.pptKnowledgeScope({ customer_id: 41, brand: 'Acme' }, null, 'generated-demand-hash'),
    { business_type: 'customer', business_id: '41' }
  );
  assert.deepEqual(
    latestUiCompat.pptKnowledgeScope({ brand: 'Acme' }, null, 'generated-demand-hash'),
    { business_type: 'brand', business_id: 'Acme' }
  );
  assert.deepEqual(
    latestUiCompat.pptKnowledgeScope({}, null, 'generated-demand-hash'),
    { business_type: 'demand', business_id: 'generated-demand-hash' }
  );
  assert.equal(latestUiCompat.pptKnowledgeScope({}), null);
});

test('TideWe fallback uses demand facts and a presentation-safe product name', () => {
  const proposal = [
    '# TideWe 美国市场方案',
    '## 市场窗口与竞品位置',
    '- 12月圣诞与新年窗口必须前置锁定猎季内容档期。',
    '## 内容母题',
    '- 用林地实测呈现透视、静音与快速收放，而不是棚拍口播。'
  ].join('\n');
  const outline = latestUiCompat.buildPptOutlineFallback(
    tideweDemand(),
    proposal,
    '',
    { used: false, results: [] }
  );
  const text = visibleDeckText(outline);

  assert.equal(outline.sections.length, 24);
  assert.equal(outline.product, 'BL001 / BL008 Hunting Blind');
  assert.match(outline.product_full_name, /Vis Series 270 Degree/);
  assert.match(text, /透视/);
  assert.match(text, /静音/);
  assert.match(text, /30\+/);
  assert.match(text, /12月/);
  assert.match(text, /YouTube/);
  assert.match(text, /林地实测/);
  assert.doesNotMatch(text, /真实家庭|家庭或团队响应|客户决策版|P0待确认|人工确认方案/);

  const contentSystem = outline.sections.find((section) => section.slot_key === 'content_system');
  assert.deepEqual(
    contentSystem.points.filter((point) => /^卖点\s*\d+\|/.test(point)).slice(0, 3),
    [
      '卖点 1|透视能力强，视野广',
      '卖点 2|隐蔽性，静音防风防气味扩散',
      '卖点 3|收放方便'
    ]
  );
  assert.doesNotMatch(text, /关键卖点\s*\d/);

  const recommendationLabels = outline.sections[1].points.map((point) => point.split('|')[0]);
  assert.equal(new Set(recommendationLabels).size, recommendationLabels.length);
  assert.match(outline.sections[6].points[0], /看得更广.*藏得更稳.*收得更快/);
  assert.match(outline.sections[14].points.join('\n'), /猎场|猎人/);
  assert.doesNotMatch(outline.sections[22].points.join('\n'), /只使用客户可核验/);
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
  assert.doesNotMatch(visibleDeckText(repaired), /AI outline was normalized|结构校验/);

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
  assert.doesNotMatch(repaired.sections[2].points.join('\n'), /UNMAPPED-CRITICAL-SENTINEL/);
  assert.doesNotMatch(repaired.sections[2].points.join('\n'), /结构校验/);
  assert.doesNotMatch(repaired.sections[2].points.join('\n'), /TAIL-END/);
  assert.equal(repaired.unmapped_sections.length, 1);
  assert.match(repaired.unmapped_sections[0].title, /UNMAPPED-CRITICAL-SENTINEL/);
  assert.match(repaired.unmapped_sections[0].points.join('\n'), /TAIL-END/);
  assert.match(repaired.structure_warning, /24-page decision flow/);
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
  assert.match(renderer, /--tm-font:"Noto Sans SC"/);
  assert.match(renderer, /\.tm-storyboard\{[^}]*grid-template-columns:repeat\(4,1fr\)/);
  assert.match(renderer, /clientSafeDeckText/);
  const chromeSource = renderer.slice(
    renderer.indexOf('function renderDeckChrome'),
    renderer.indexOf('function renderDeckFooter')
  );
  assert.doesNotMatch(chromeSource, /tm-status|tm-evidence|evidence_labels|deckStatusLabel/);
  assert.doesNotMatch(renderer, /SCENE DIRECTION|CONTENT CONCEPT/);
});

test('browser local deck fallback keeps demand-specific facts when the outline service fails', () => {
  const source = fs.readFileSync(appPath, 'utf8');
  const marker = source.indexOf('// ===== DECISION DECK V2 RENDERER =====');
  const sandbox = { TextDecoder, TextEncoder, Uint8Array };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source.slice(marker), sandbox);

  const outline = sandbox.TMDecisionDeckRenderer.fallback(tideweDemand(), '', 'offline');
  const text = visibleDeckText(outline);
  assert.equal(outline.sections.length, 24);
  assert.equal(outline.product, 'BL001 / BL008 Hunting Blind');
  assert.match(text, /透视能力强，视野广/);
  assert.match(text, /隐蔽性，静音防风防气味扩散/);
  assert.match(text, /收放方便/);
  assert.match(text, /30\+/);
  assert.match(text, /真实猎场|林地/);
  assert.doesNotMatch(text, /团队资料\|只使用客户可核验/);

  const aiProduct = sandbox.TMDecisionDeckRenderer.normalize({
    title: 'Acme AI Camera 海外红人营销方案',
    product: 'Acme AI Camera',
    sections: [{
      title: '产品事实',
      type: 'cover',
      points: ['支持 AI 分析告警、AI 分析建议：根据告警历史给出处置方案，以及 AI recommendation engine']
    }]
  }, { brand: 'Acme', product: 'Acme AI Camera' });
  assert.match(visibleDeckText(aiProduct), /Acme AI Camera/);
  assert.match(visibleDeckText(aiProduct), /AI 分析告警/);
  assert.match(visibleDeckText(aiProduct), /AI 分析建议：根据告警历史给出处置方案/);
  assert.match(visibleDeckText(aiProduct), /AI recommendation engine/);
});

test('presentation product names remain concise while preserving model identity', () => {
  assert.equal(
    latestUiCompat.presentationProductName(tideweDemand().product),
    'BL001 / BL008 Hunting Blind'
  );
  assert.equal(latestUiCompat.presentationProductName('T5 Max Indoor Exercise Bike'), 'T5 Max Indoor Exercise Bike');
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
  assert.match(report.slides[1].text, /真实使用证明产品价值/);
  assert.match(report.slides[18].text, /卖点证据表/);
  assert.ok(report.slides.slice(1).every((slide) => slide.text.includes('TuringMarket')));
  assert.ok(new Set(report.slides.map((slide) => slide.shape_count)).size >= 6);
});

test('PPTX generator independently removes internal labels and mojibake from legacy outlines', { timeout: 30_000 }, () => {
  const outline = latestUiCompat.buildPptOutlineFallback(
    tideweDemand(), '# Confirmed proposal', '', { used: false, results: [] }
  );
  outline.sections[1].title = '[KB-1] AI outline was normalized to the approved flow';
  outline.sections[1].points = [
    'P0待确认|BLUETTIæ°åElite 300çº¢äººæ¨å¹¿éæ±è¡¨',
    '人工确认方案|AI赋能全链路闭环',
    '产品事实|Acme AI Camera 支持 AI 分析告警、AI 分析建议：根据告警历史给出处置方案，以及 AI recommendation engine'
  ];
  outline.sections[1].evidence_labels = ['[KB-1]'];
  outline.sections[1].status = 'pending';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-client-safe-deck-'));
  const inputPath = path.join(root, 'outline.json');
  const outputPath = path.join(root, 'proposal.pptx');
  fs.writeFileSync(inputPath, JSON.stringify({ demand: tideweDemand(), outline }), 'utf8');

  const python = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
  const generated = childProcess.spawnSync(python, [generatorPath, inputPath, outputPath], {
    cwd: path.dirname(generatorPath), encoding: 'utf8', env
  });
  assert.equal(generated.status, 0, generated.stderr || generated.stdout);

  const inspectCode = [
    'import json, re, sys, zipfile',
    'from pptx import Presentation',
    'prs = Presentation(sys.argv[1])',
    'texts = []',
    'fonts = []',
    'for slide in prs.slides:',
    '    for shape in slide.shapes:',
    '        if not hasattr(shape, "text_frame"): continue',
    '        texts.append(shape.text or "")',
    'with zipfile.ZipFile(sys.argv[1]) as archive:',
    '    for name in archive.namelist():',
    '        if not name.endswith(".xml"): continue',
    '        xml = archive.read(name).decode("utf-8", errors="ignore")',
    '        fonts.extend(re.findall(r\'typeface="([^\"]+)"\', xml))',
    'print(json.dumps({"text": "\\n".join(texts), "fonts": fonts}, ensure_ascii=False))'
  ].join('\n');
  const inspected = childProcess.spawnSync(python, ['-c', inspectCode, outputPath], {
    encoding: 'utf8', env
  });
  assert.equal(inspected.status, 0, inspected.stderr || inspected.stdout);
  const report = JSON.parse(inspected.stdout);

  assert.match(report.text, /BLUETTI新品Elite 300红人推广需求表/);
  assert.match(report.text, /启动前确认/);
  assert.match(report.text, /Acme AI Camera 支持 AI 分析告警、AI 分析建议：根据告警历史给出处置方案，以及 AI recommendation engine/);
  assert.doesNotMatch(report.text, /\[KB-|AI outline|AI赋能|全链路闭环|人工确认方案|P0待确认|æ|çº/);
  assert.ok(report.fonts.length > 0);
  assert.ok(report.fonts.includes('Noto Sans SC'));
  assert.ok(!report.fonts.includes('Microsoft YaHei'));
});

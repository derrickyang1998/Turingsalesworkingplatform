const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const knowledgeService = require('./knowledge_service');
const llm = require('./llm_service');

const TEXT_EXTS = new Set(['.txt', '.md', '.csv', '.json']);
const DOC_EXTS = new Set(['.pdf', '.docx', '.pptx']);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff']);

function compactText(value, max) {
  const text = String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!max || text.length <= max) return text;
  return text.slice(0, max - 1) + '...';
}

function normalizeKnowledgeLimit(value, fallback) {
  const defaultLimit = Number.isSafeInteger(fallback) && fallback > 0 ? fallback : 8;
  if (value === undefined || value === null || value === '') return defaultLimit;
  let parsed;
  if (typeof value === 'number') {
    parsed = value;
  } else if (typeof value === 'string' && /^\d+$/.test(value)) {
    parsed = Number(value);
  } else {
    return defaultLimit;
  }
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) return defaultLimit;
  return parsed;
}

function safeJson(text, fallback) {
  try { return JSON.parse(text); } catch (e) { return fallback; }
}

function safeUnlink(filePath) {
  try { if (filePath) fs.unlinkSync(filePath); } catch (e) {}
}

function pythonBin() {
  return process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
}

function runPython(scriptName, args, timeout) {
  const scriptPath = path.join(__dirname, '..', scriptName);
  const result = spawnSync(pythonBin(), [scriptPath].concat(args || []), {
    encoding: 'utf8',
    timeout: timeout || 25000,
    maxBuffer: 1024 * 1024 * 8
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || ('python exited ' + result.status)).slice(0, 600));
  }
  return result.stdout || '';
}

function fallbackFileText(file, reason) {
  return [
    'File name: ' + (file.originalname || path.basename(file.path || 'upload')),
    'File size: ' + (file.size || 0) + ' bytes',
    reason ? 'Parser note: ' + reason : '',
    'The file could not be fully parsed. Ask the user to confirm missing product, market, budget, platform, and campaign requirements.'
  ].filter(Boolean).join('\n');
}

async function parseDemandFile(file) {
  const ext = path.extname(file.originalname || file.path || '').toLowerCase();
  try {
    if (TEXT_EXTS.has(ext)) {
      const text = fs.readFileSync(file.path, 'utf8');
      return { text, parser: 'plain-text', fallback: false, warnings: [], needsOcr: false, ocrUsed: false };
    }
    if (ext === '.xlsx' || ext === '.xlsm') {
      const parsed = safeJson(runPython('extract_xlsx_text.py', [file.path], 20000), {});
      return {
        text: String(parsed.text || '').trim() || fallbackFileText(file, 'xlsx parser returned no text'),
        parser: parsed.parser || 'xlsx-openxml',
        fallback: !String(parsed.text || '').trim(),
        warnings: parsed.warnings || [],
        needsOcr: false,
        ocrUsed: false
      };
    }
    if (ext === '.xls') {
      return {
        text: fallbackFileText(file, 'Legacy .xls requires saving as .xlsx for full extraction.'),
        parser: 'xls-legacy-fallback',
        fallback: true,
        warnings: ['Legacy .xls binary workbooks are not parsed. Save as .xlsx for full cell extraction.'],
        needsOcr: false,
        ocrUsed: false
      };
    }
    if (DOC_EXTS.has(ext)) {
      const parsed = safeJson(runPython('extract_document_text.py', [file.path], 25000), {});
      const text = String(parsed.text || '').trim();
      return {
        text: text || fallbackFileText(file, parsed.needs_ocr ? 'OCR required but no readable text was extracted.' : 'document parser returned no text'),
        parser: parsed.parser || 'document',
        fallback: !text,
        warnings: parsed.warnings || [],
        needsOcr: !!(parsed.needs_ocr || parsed.needsOcr),
        ocrUsed: false
      };
    }
    if (IMAGE_EXTS.has(ext)) {
      let parsed = {};
      try { parsed = safeJson(runPython('ocr_document_text.py', [file.path], 30000), {}); } catch (e) {
        parsed = { warnings: ['OCR failed: ' + e.message], text: '' };
      }
      const text = String(parsed.text || '').trim();
      return {
        text: text || fallbackFileText(file, 'Image file requires OCR or pasted text context.'),
        parser: parsed.parser || 'image-ocr',
        fallback: !text,
        warnings: parsed.warnings || [],
        needsOcr: !text,
        ocrUsed: !!text
      };
    }
    return {
      text: fallbackFileText(file, 'Unsupported file type: ' + (ext || 'unknown')),
      parser: 'unsupported',
      fallback: true,
      warnings: ['Unsupported file type: ' + (ext || 'unknown')],
      needsOcr: false,
      ocrUsed: false
    };
  } catch (e) {
    return {
      text: fallbackFileText(file, e.message),
      parser: 'parser-error',
      fallback: true,
      warnings: [e.message],
      needsOcr: false,
      ocrUsed: false
    };
  }
}

function inferDemandAnalysis(input, reason, fileName) {
  const text = String(input || '');
  const lowered = text.toLowerCase();
  const platforms = ['TikTok', 'Instagram', 'YouTube', 'Amazon', 'Facebook'].filter(function(p) {
    return lowered.includes(p.toLowerCase());
  });
  return {
    brand: extractAfter(text, ['品牌', 'brand']) || '',
    company: extractAfter(text, ['公司', 'company']) || '',
    product: extractAfter(text, ['产品', 'product']) || '',
    usp: extractAfter(text, ['卖点', 'USP', '优势']) || compactText(text, 120),
    industry: guessIndustry(text),
    budget_range: extractAfter(text, ['预算', 'budget']) || '',
    target_market: extractAfter(text, ['市场', 'market', '国家']) || '',
    platforms: platforms.length ? platforms : ['TikTok', 'Instagram', 'YouTube'],
    competitors: [],
    requirements: text ? text.split(/[;\n。]/).map(function(v) { return v.trim(); }).filter(Boolean).slice(0, 6) : [],
    source_file: fileName || '',
    fallback_reason: reason || ''
  };
}

function extractAfter(text, labels) {
  for (const label of labels) {
    const re = new RegExp(label + '\\s*[:：]\\s*([^\\n;；。]+)', 'i');
    const match = String(text || '').match(re);
    if (match) return match[1].trim();
  }
  return '';
}

function guessIndustry(text) {
  const pairs = [
    ['beauty', /美妆|护肤|beauty|skin/i],
    ['consumer electronics', /3c|电子|充电|gadget|power|tech/i],
    ['outdoor', /户外|露营|camp|outdoor/i],
    ['pet', /宠物|pet/i],
    ['home', /家居|home|smart/i]
  ];
  for (const pair of pairs) if (pair[1].test(text || '')) return pair[0];
  return '';
}

function normalizeAnalysis(value, fallback) {
  const parsed = typeof value === 'string' ? safeJson(value, null) : value;
  const out = Object.assign({}, fallback || {}, parsed || {});
  ['platforms', 'competitors', 'requirements'].forEach(function(key) {
    if (Array.isArray(out[key])) return;
    out[key] = String(out[key] || '').split(/[,，、/;\n]+/).map(function(v) { return v.trim(); }).filter(Boolean);
  });
  return out;
}

async function generateJsonWithDeepSeek(prompt, fallback, opts) {
  const provider = llm.createDeepSeekProvider();
  const completion = await provider.complete({
    messages: [
      { role: 'system', content: 'Return JSON only. No markdown fences. No commentary.' },
      { role: 'user', content: prompt }
    ],
    temperature: opts && opts.temperature !== undefined ? opts.temperature : 0.2,
    max_tokens: opts && opts.max_tokens || 2200
  });
  recordTokenUsage(opts, completion);
  const raw = String(completion.content || '').replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  const parsed = safeJson(raw, null);
  if (!parsed) return { value: fallback, fallback: true, warning: completion.reason || 'AI JSON parse failed', completion };
  return { value: parsed, fallback: !!completion.degraded, warning: completion.reason || '', completion };
}

function recordTokenUsage(opts, completion) {
  opts = opts || {};
  const usage = completion && completion.usage || {};
  if (!opts.db || !opts.user || !(usage.total_tokens || usage.prompt_tokens || usage.completion_tokens)) return;
  try {
    opts.db.prepare('INSERT INTO token_usage (user_id, model, prompt_tokens, completion_tokens, total_tokens, endpoint) VALUES (?, ?, ?, ?, ?, ?)')
      .run(opts.user.id, completion.model || 'deepseek-chat', usage.prompt_tokens || 0, usage.completion_tokens || 0, usage.total_tokens || 0, opts.endpoint || 'ai_compat');
  } catch (e) {}
}

async function generateStrategy(db, user, prompt, input, opts) {
  opts = opts || {};
  const message = [prompt, input].filter(Boolean).join('\n\n');
  const aiService = opts.aiService || require('./ai_service');
  const result = await aiService.handleChat(db, {
    user,
    message,
    ragQuery: message,
    webQuery: message,
    allowWeb: opts.allowWeb !== false,
    source_module: 'strategy',
    summaryVisibility: opts.summaryVisibility || 'team',
    knowledgeLimit: normalizeKnowledgeLimit(opts.knowledgeLimit, 8),
    max_tokens: opts.max_tokens || 2500,
    provider: opts.provider,
    webSearchProvider: opts.webSearchProvider
  });
  return {
    content: result.answer,
    fallback: !!result.degraded,
    warning: result.reason || '',
    ai: result
  };
}

function proposalDemandText(body) {
  let value;
  if (Object.prototype.hasOwnProperty.call(body, 'demand_content')) value = body.demand_content;
  else if (Object.prototype.hasOwnProperty.call(body, 'content')) value = body.content;
  else value = body.demand || {};
  if (typeof value === 'string') return value.trim();
  try { return JSON.stringify(value || {}); } catch (e) { return '{}'; }
}

function proposalTemplateText(template) {
  if (!template || typeof template !== 'object' || Array.isArray(template)) return '';
  const sections = Array.isArray(template.sections)
    ? template.sections.map(function(section) { return String(section || '').trim(); }).filter(Boolean)
    : [];
  return [
    template.name ? 'Template: ' + String(template.name) : '',
    template.description ? 'Template purpose: ' + String(template.description) : '',
    sections.length ? 'Requested sections:\n- ' + sections.join('\n- ') : ''
  ].filter(Boolean).join('\n');
}

async function generateProposalDraft(db, user, body, opts) {
  body = body || {};
  opts = opts || {};
  const demandText = proposalDemandText(body);
  const templateText = proposalTemplateText(body.template);
  const retrievalQuery = [demandText, templateText].filter(Boolean).join('\n\n');
  const demandTitle = body.title || (
    body.demand && (body.demand.brand || body.demand.product)
  ) || '需求方案草稿';
  const knowledge = opts.knowledgeService || knowledgeService;
  const demandEntry = knowledge.ingestKnowledge(db, {
    title: '需求归档：' + demandTitle,
    summary: compactText(demandText, 240),
    content: demandText,
    entry_type: 'demand',
    source_type: body.source_type || 'proposal_draft_request',
    source_id: body.demand_id || body.source_id || demandTitle,
    visibility: body.visibility || 'private',
    tags: body.tags || ['demand', 'proposal'],
    business_type: 'demand',
    business_id: body.demand_id || '',
    created_by: user.id,
    actor_role: user.role,
    metadata: { demand: body.demand || null, template: body.template || null }
  });
  const message = [
    '请基于以下客户需求和平台知识库，生成可编辑的海外红人营销方案草稿。',
    '必须包含：执行摘要、市场/竞品判断、达人类型与平台建议、60-30-10预算建议、执行时间线、KPI、风险与下一步确认项。',
    '这是待人工编辑和确认的草稿，不要将其描述为最终已确认方案。',
    '',
    retrievalQuery
  ].join('\n');
  const aiService = opts.aiService || require('./ai_service');
  const knowledgeLimit = Object.prototype.hasOwnProperty.call(opts, 'knowledgeLimit')
    ? opts.knowledgeLimit
    : body.knowledge_limit;
  const allowWeb = Object.prototype.hasOwnProperty.call(opts, 'allowWeb')
    ? opts.allowWeb === true
    : body.allow_web === true;
  const result = await aiService.handleChat(db, {
    user,
    message,
    ragQuery: retrievalQuery,
    webQuery: retrievalQuery,
    allowWeb,
    source_module: 'proposal',
    summaryVisibility: opts.summaryVisibility || body.summary_visibility || 'private',
    knowledgeLimit: normalizeKnowledgeLimit(knowledgeLimit, 10),
    max_tokens: opts.max_tokens || 3000,
    temperature: 0.3,
    provider: opts.provider,
    webSearchProvider: opts.webSearchProvider
  });
  return {
    draft: result.answer,
    demand_entry: demandEntry,
    fallback: !!result.degraded,
    warning: result.reason || '',
    ai: result
  };
}

async function generateDemandAnalysis(prompt, input, fileName, opts) {
  opts = opts || {};
  const fallback = inferDemandAnalysis(input || prompt, '', fileName);
  const message = [
    'Analyze this overseas influencer marketing demand. Return JSON keys:',
    'brand, company, product, usp, industry, budget_range, target_market, platforms, competitors, requirements.',
    'platforms, competitors, requirements must be arrays.',
    'Return JSON only. No markdown fences. No commentary.',
    '',
    [prompt, input].filter(Boolean).join('\n\n')
  ].join('\n');

  if (opts.db && opts.user && opts.user.id) {
    const aiService = opts.aiService || require('./ai_service');
    const retrievalQuery = [prompt, input].filter(Boolean).join('\n\n');
    const aiResult = await aiService.handleChat(opts.db, {
      user: opts.user,
      message,
      ragQuery: retrievalQuery,
      webQuery: retrievalQuery,
      allowWeb: opts.allowWeb === true,
      source_module: 'demand_analysis',
      summaryVisibility: opts.summaryVisibility || 'private',
      knowledgeLimit: opts.knowledgeLimit || 8,
      temperature: 0.1,
      max_tokens: 1800,
      provider: opts.provider,
      webSearchProvider: opts.webSearchProvider
    });
    const raw = String(aiResult.answer || '').replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
    const parsed = safeJson(raw, null);
    const degraded = !parsed || !!aiResult.degraded;
    return {
      analysis: normalizeAnalysis(parsed, fallback),
      fallback: degraded,
      warning: aiResult.reason || (!parsed ? 'AI JSON parse failed' : ''),
      ai: aiResult
    };
  }

  const result = await generateJsonWithDeepSeek(message, fallback, Object.assign({}, opts, {
    temperature: 0.1,
    max_tokens: 1800,
    endpoint: 'demand_analysis'
  }));
  return {
    analysis: normalizeAnalysis(result.value, fallback),
    fallback: result.fallback,
    warning: result.warning
  };
}

function buildPptOutlineFallback(demand, proposal, reason, research) {
  const brand = demand.brand || demand.brand_name || demand.company || demand.company_name || '客户品牌';
  const product = demand.product || demand.product_name || '核心产品';
  const market = demand.target_market || demand.market || '目标市场';
  const budget = demand.budget || demand.budget_range || '待确认';
  const researchPoints = (research && research.results || []).slice(0, 4).map(function(item) {
    return '市场信号: ' + item.title + (item.snippet ? ' - ' + compactText(item.snippet, 120) : '');
  });
  const base = [
    { title: '01 ' + brand + ' Campaign Brief', type: 'cover', points: ['产品: ' + product, '市场: ' + market, '预算: ' + budget], note: reason || '' },
    { title: '02 执行摘要', type: 'content', points: ['目标: 围绕' + product + '在' + market + '形成达人种草与转化闭环', '策略: 内容场景、达人分层、预算节奏和 KPI 同步设计'] },
    { title: '03 联网调研与市场信号', type: 'stats', points: researchPoints.length ? researchPoints : ['调研状态: 暂未读取到可用联网来源，先基于需求与知识库生成'] },
    { title: '04 产品卖点与内容角度', type: 'content', points: ['卖点拆解: ' + compactText(demand.usp || proposal || product, 160), '内容方向: 评测、场景演示、对比、真实体验'] },
    { title: '05 达人组合建议', type: 'team', points: ['头部达人: 建立信任背书', '腰部达人: 扩大触达与内容多样性', '长尾达人: 控制成本并提升转化样本'] },
    { title: '06 平台与预算拆解', type: 'stats', points: ['预算: ' + budget, '平台: ' + [].concat(demand.platforms || demand.platform || ['TikTok', 'Instagram', 'YouTube']).join(' / ')] },
    { title: '07 Campaign 执行排期', type: 'timeline', points: ['启动|第1周|需求确认与达人建联|达人名单与脚本方向', '执行|第2-4周|内容生产与发布|上线内容与日报', '复盘|第5周|数据分析与优化|复盘报告'] },
    { title: '08 KPI 与复盘口径', type: 'kpi', points: ['曝光: 按平台拆分预估触达', '互动: 点赞评论收藏分享', '转化: 链接点击、询盘或销售线索'] },
    { title: '09 风险与保障', type: 'content', points: ['风险: 达人延期、内容偏差、平台数据波动', '保障: 脚本审核、备选达人池、周度复盘'] },
    { title: '10 下一步确认事项', type: 'next', points: ['确认预算与目标市场', '确认禁用表达和品牌合规边界', '确认产品样品和达人合作窗口'] }
  ];
  return { title: brand + ' 海外红人营销方案', subtitle: product + ' / ' + market, sections: base, research };
}

function booleanOption(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function researchFromAiResult(aiResult) {
  const web = aiResult && aiResult.web_search || {};
  return {
    used: !!web.used,
    provider: web.provider || 'tavily',
    results: Array.isArray(aiResult && aiResult.web_results) ? aiResult.web_results : [],
    reason: web.reason || ''
  };
}

async function generatePptOutline(db, user, body, opts) {
  body = body || {};
  opts = opts || {};
  const demand = body.demand || {};
  const proposal = [body.proposal || '', body.deckContext || ''].filter(Boolean).join('\n\n');
  const query = [demand.brand, demand.company, demand.product, demand.product_name, demand.target_market, demand.market, 'influencer marketing'].filter(Boolean).join(' ');
  const retrievalQuery = [query, JSON.stringify(demand), proposal].filter(Boolean).join('\n\n');
  const prompt = [
    'Create a client-facing overseas influencer marketing PPT outline for TuringMarket.',
    'Return JSON only with title, subtitle, sections. sections must include title, type, points array, note.',
    'Use 9-12 sections and include market research, product angle, creator mix, budget, timeline, KPI, risks, next steps.',
    'Use the internal knowledge base first when it is relevant. When using it, reference [KB-n] in slide points or notes.',
    'Demand JSON:', JSON.stringify(demand),
    'Proposal/context:', compactText(proposal, 5000)
  ].join('\n');
  const aiService = opts.aiService || require('./ai_service');
  const aiResult = await aiService.handleChat(db, {
    user,
    message: prompt,
    ragQuery: retrievalQuery,
    webQuery: query || 'overseas influencer marketing campaign',
    allowWeb: booleanOption(body.allow_web, true),
    source_module: 'ppt_outline',
    summaryVisibility: body.summary_visibility || 'private',
    knowledgeLimit: body.knowledge_limit || 8,
    business_type: body.business_type || undefined,
    temperature: 0.25,
    max_tokens: 3200,
    provider: opts.provider,
    webSearchProvider: opts.webSearchProvider
  });
  const research = researchFromAiResult(aiResult);
  const fallback = buildPptOutlineFallback(demand, proposal, aiResult.reason || '', research);
  const raw = String(aiResult.answer || '').replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  const parsed = safeJson(raw, null);
  const outline = normalizePptOutline(parsed, fallback, research);
  const knowledgeReferences = Array.isArray(aiResult.knowledge_references) ? aiResult.knowledge_references : [];
  outline.knowledge_references = knowledgeReferences;
  outline.research = research;
  try {
    knowledgeService.ingestKnowledge(db, {
      title: 'PPT outline: ' + (outline.title || demand.brand || 'campaign'),
      summary: compactText((outline.sections || []).map(function(s) { return s.title; }).join(' / '), 240),
      content: JSON.stringify(outline, null, 2),
      entry_type: 'ppt_outline',
      source_type: 'ai_ppt_outline',
      source_id: outline.title || Date.now(),
      visibility: 'team',
      tags: ['ppt', 'proposal', demand.brand || demand.product || 'campaign'],
      business_type: 'ppt',
      business_id: demand.id || demand.brand || '',
      created_by: user.id,
      actor_role: user.role,
      metadata: {
        research_used: !!research.used,
        knowledge_reference_ids: knowledgeReferences.map(function(ref) { return ref.id; }),
        ai_conversation_id: aiResult.conversation_id || null,
        ai_message_id: aiResult.message_id || null
      }
    });
  } catch (e) {}
  return {
    outline,
    knowledge_references: knowledgeReferences,
    research,
    fallback: !parsed || !!aiResult.degraded,
    warning: aiResult.reason || (!parsed ? 'AI JSON parse failed' : ''),
    ai: aiResult
  };
}

function normalizePptOutline(value, fallback, research) {
  const out = Object.assign({}, fallback || {}, value || {});
  out.title = out.title || (fallback && fallback.title) || '海外红人营销方案';
  out.subtitle = out.subtitle || (fallback && fallback.subtitle) || '';
  out.sections = Array.isArray(out.sections) ? out.sections : (fallback && fallback.sections) || [];
  out.sections = out.sections.map(function(sec, index) {
    return {
      title: sec.title || ('Slide ' + (index + 1)),
      type: sec.type || 'content',
      points: Array.isArray(sec.points) ? sec.points.map(String) : String(sec.points || '').split(/\n|;|；/).filter(Boolean),
      note: sec.note || ''
    };
  }).filter(function(sec) { return sec.title; });
  out.research = out.research || research || (fallback && fallback.research);
  return out;
}

function similarKnowledge(db, query, user) {
  const terms = [query.brand, query.industry, query.product, query.market].filter(Boolean).join(' ');
  return knowledgeService.searchKnowledge(db, {
    q: terms || query.q || '',
    entry_type: query.type || '',
    user,
    limit: query.limit || 5
  });
}

module.exports = {
  safeUnlink,
  parseDemandFile,
  inferDemandAnalysis,
  generateStrategy,
  generateProposalDraft,
  generateDemandAnalysis,
  generatePptOutline,
  similarKnowledge
};

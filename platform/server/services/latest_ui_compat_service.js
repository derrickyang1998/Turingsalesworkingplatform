const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const knowledgeService = require('./knowledge_service');
const llm = require('./llm_service');
const rag = require('./rag_service');
const webSearch = require('./web_search_service');
const aiQuota = require('./ai_quota_service');
const aiConcurrency = require('./ai_concurrency_service');
const crypto = require('node:crypto');

const TEXT_EXTS = new Set(['.txt', '.md', '.csv', '.json']);
const DOC_EXTS = new Set(['.pdf', '.docx', '.pptx']);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff']);

function compactText(value, max) {
  const text = String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!max || text.length <= max) return text;
  return text.slice(0, max - 1) + '...';
}

const PPT_RAG_SOURCE_TYPES = Object.freeze([
  'demand_record',
  'proposal_record',
  'campaign_demand',
  'campaign_proposal',
  'brand_profile',
  'crm_customer',
  'crm_opportunity',
  'obsidian',
  'manual'
]);

function mojibakeScore(value) {
  const text = String(value || '');
  const controls = (text.match(/[\u0080-\u009f]/g) || []).length * 3;
  const markers = (text.match(/(?:Ã.|Â.|â.|æ.|ç.|å.|ä.|è.|é.|ï¿½|锟斤拷|�)/g) || []).length * 2;
  return controls + markers;
}

function repairMojibakeText(value) {
  let text = String(value === undefined || value === null ? '' : value);
  text = text.replace(/[\u0080-\u00ff]{2,}/g, function(run) {
    const before = mojibakeScore(run);
    if (!before) return run;
    const decoded = Buffer.from(run, 'latin1').toString('utf8');
    if (!decoded || decoded.includes('�') || mojibakeScore(decoded) >= before) return run;
    return decoded;
  });
  return text
    .replace(/锟斤拷/g, '')
    .replace(/�/g, '')
    .normalize('NFC');
}

function clientSafeDeckText(value) {
  return repairMojibakeText(value)
    .replace(/\[(?:KB|WEB)-\d+\]/gi, '')
    .replace(/\[(?:需求表(?:\/客户资料)?|平台能力)\]/g, '')
    .replace(/AI outline was normalized(?: to the approved(?: 24-page)?(?: decision)? flow)?/gi, '')
    .replace(/\bAI[-\s]+generated\s+(?=(?:draft|outline|content|proposal)\b)/gi, '')
    .replace(/AI\s*生成(?:的)?\s*(?=方案|内容|文案|草稿|大纲)/gi, '')
    .replace(/AI\s*草稿(?=\s*(?:[:：|｜/]|$))/gi, '初稿')
    .replace(/AI\s*大纲(?=\s*(?:[:：|｜/]|$))/gi, '方案结构')
    .replace(/AI\s*赋能(?=\s*全链路闭环)/gi, '能力支持')
    .replace(/AI\s*赋能(?=\s*(?:[:：|｜/]|$))/gi, '能力支持')
    .replace(/智能增长引擎/g, '增长执行体系')
    .replace(/全链路闭环/g, '完整执行流程')
    .replace(/颠覆增长/g, '增长改进')
    .replace(/人工确认方案/g, '确认方案')
    .replace(/P0\s*待确认/g, '启动前确认')
    .replace(/客户决策版/g, '项目方案')
    .replace(/Claims architecture/gi, '内容表达边界')
    .replace(/Product Fact Sheet/gi, '产品事实清单')
    .replace(/Why TuringMarket/gi, '图灵集市项目能力')
    .replace(/执行\s*Roadmap/gi, '执行排期')
    .replace(/结构校验[｜|:]?[^\n；]*/g, '')
    .replace(/使用客户(?:提供的|正式)?产品主视觉[^。；]*[。；]?/g, '真实产品与核心使用场景。')
    .replace(/使用客户正式产品素材或与品类一致的概念场景示意[。；]?/g, '真实产品与核心使用场景。')
    .replace(/没有(?:正式|已授权)素材时[^。；]*[。；]?/g, '')
    .replace(/概念场景示意/g, '核心使用场景')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*[-–—]\s*[-–—]\s*/g, ' - ')
    .replace(/^\s*[-–—|｜:：]+\s*|\s*[-–—|｜:：]+\s*$/g, '')
    .trim();
}

function presentationProductName(value) {
  const raw = clientSafeDeckText(value).replace(/https?:\/\/\S+/gi, '').replace(/\s+/g, ' ').trim();
  if (!raw) return '核心产品';
  if (Array.from(raw).length <= 54) return raw;
  const modelCodes = [...new Set((raw.match(/\b[A-Z]{1,6}-?\d[A-Z0-9-]{1,14}\b/g) || []))].slice(0, 3);
  const categoryMatchers = [
    [/hunting\s+blind/i, 'Hunting Blind'],
    [/power\s+station/i, 'Power Station'],
    [/smoke\s+alarm/i, 'Smoke Alarm'],
    [/security\s+camera/i, 'Security Camera'],
    [/exercise\s+bike/i, 'Exercise Bike'],
    [/hunting\s+suit/i, 'Hunting Suit'],
    [/wader/i, 'Hunting Wader'],
    [/(?:打猎|狩猎)帐篷/, '狩猎帐篷']
  ];
  const category = (categoryMatchers.find(function(item) { return item[0].test(raw); }) || [null, ''])[1];
  if (modelCodes.length && category) return modelCodes.join(' / ') + ' ' + category;
  if (modelCodes.length > 1) return modelCodes.join(' / ');
  const first = raw.split(/[;；|｜\n]/)[0].replace(/\s+/g, ' ').trim();
  const chars = Array.from(first || raw);
  return chars.length <= 54 ? chars.join('') : chars.slice(0, 53).join('') + '…';
}

function stringValue(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join('；');
  return value === undefined || value === null ? '' : String(value);
}

function firstDemandValue(demand, keys) {
  for (const key of keys) {
    const value = stringValue(demand[key]).trim();
    if (value) return value;
  }
  return '';
}

function regexValue(text, expression) {
  const match = String(text || '').match(expression);
  return match ? compactText(match[1], 260) : '';
}

function uniqueFacts(values, limit) {
  const seen = new Set();
  const result = [];
  values.forEach(function(value) {
    const cleaned = clientSafeDeckText(String(value || '')
      .replace(/^[-*•\d.、\s]+/, '')
      .replace(/^关键卖点\s*\d*\s*[:：]?\s*/, ''));
    if (!cleaned || seen.has(cleaned)) return;
    seen.add(cleaned);
    result.push(cleaned);
  });
  return result.slice(0, limit || 6);
}

function labeledSellingPoints(value) {
  const text = repairMojibakeText(value);
  const points = [];
  const expression = /(?:关键卖点|卖点)\s*\d+\s*[:：]\s*([^\r\n]*?)(?=\s*(?:(?:关键卖点|卖点)\s*\d+\s*[:：])|\r?\n|$)/gi;
  let match;
  while ((match = expression.exec(text)) !== null) {
    const point = clientSafeDeckText(match[1]).replace(/[；;，,\s]+$/g, '').trim();
    if (point) points.push(point);
  }
  return points;
}

function buildDemandDeckFacts(demand) {
  demand = demand && typeof demand === 'object' ? demand : {};
  const sourceText = repairMojibakeText(firstDemandValue(demand, ['source_text', 'sourceText', 'raw_text']));
  const notes = repairMojibakeText(firstDemandValue(demand, ['notes', 'requirements', 'brief', 'description']));
  const directSelling = firstDemandValue(demand, ['usp', 'selling_points', 'key_selling_points', 'product_highlights']);
  const parsedSellingPoints = labeledSellingPoints([directSelling, sourceText, notes].filter(Boolean).join('\n'));
  const sellingBlock = String(sourceText || '').match(
    /推广产品关键卖点信息\s*\|\s*([\s\S]*?)(?=\n(?:受众定位|Top\s*3|KOL需求|目标受众|红人选择)|$)/i
  );
  const sellingSource = sellingBlock ? sellingBlock[1] : '';
  const sellingPoints = uniqueFacts(
    parsedSellingPoints
      .concat(parsedSellingPoints.length ? [] : [directSelling])
      .concat(parsedSellingPoints.length ? [] : sellingSource.split(/[\n；]+/))
      .concat(notes.split('；').filter(function(item) {
        return /卖点|透视|静音|防风|气味|收放|续航|性能|耐用|舒适/.test(item);
      })),
    5
  );
  const audience = clientSafeDeckText(
    firstDemandValue(demand, ['audience', 'target_audience', 'persona'])
      || regexValue(notes, /受众定位\s*[:：]\s*([^；\n]+)/i)
      || regexValue(sourceText, /受众定位\s*\|\s*([^\n]+(?:\n(?:性别|兴趣词)[^\n]*)*)/i)
      || '与产品真实使用任务高度相关的人群'
  );
  const campaignBackground = clientSafeDeckText(
    firstDemandValue(demand, ['campaign_background', 'project_background', 'background'])
      || regexValue(notes, /项目背景\s*[:：]\s*([^；\n]+)/i)
      || regexValue(sourceText, /项目背景\s*\|\s*([^\n]+)/i)
  );
  const launchWindow = clientSafeDeckText(
    firstDemandValue(demand, ['launch_window', 'publish_window', 'timeline', 'deadline'])
      || regexValue(notes, /(?:预期视频发布日期范围|视频发布时间)\s*[:：]\s*([^；\n]+)/i)
      || regexValue(sourceText, /(?:预期视频发布日期范围[^|]*|视频发布时间)\s*\|\s*([^\n]+)/i)
      || '以客户库存与上线节奏为准'
  );
  const creatorType = clientSafeDeckText(
    firstDemandValue(demand, ['creator_type', 'influencer_type'])
      || regexValue(notes, /类型要求\s*[:：]\s*([^；\n]+)/i)
      || regexValue(sourceText, /(?:类型要求[^|]*|红人类型)\s*\|\s*([^\n]+)/i)
      || firstDemandValue(demand, ['category', 'industry'])
      || '品类垂直创作者'
  );
  const language = clientSafeDeckText(
    firstDemandValue(demand, ['language', 'account_language'])
      || regexValue(notes, /账号语言要求\s*[:：]\s*([^；\n]+)/i)
      || regexValue(sourceText, /账号语言要求\s*\|\s*([^\n]+)/i)
      || '目标市场主要语言'
  );
  const creatorScale = clientSafeDeckText(
    firstDemandValue(demand, ['creator_scale', 'influencer_scale'])
      || regexValue(notes, /(粉丝不限[^；\n]*)/i)
      || regexValue(sourceText, /粉丝量级[^|]*\s*\|\s*([^\n]+)/i)
      || '不以粉丝量单一判断，以内容匹配和稳定播放为主'
  );
  return {
    sourceText,
    notes,
    sellingPoints,
    audience,
    campaignBackground,
    launchWindow,
    creatorType,
    language,
    creatorScale
  };
}

function pptKnowledgeScope(demand, campaignId, fallbackDemandId) {
  demand = demand && typeof demand === 'object' ? demand : {};
  const linkedCampaignId = Number(campaignId);
  if (Number.isSafeInteger(linkedCampaignId) && linkedCampaignId > 0) {
    return { business_type: 'campaign', business_id: String(linkedCampaignId) };
  }
  const demandId = demand.id || demand.demand_id;
  if (demandId !== undefined && demandId !== null && String(demandId).trim()) {
    return { business_type: 'demand', business_id: String(demandId).trim() };
  }
  const customerId = demand.customer_id || demand.customerId;
  if (customerId !== undefined && customerId !== null && String(customerId).trim()) {
    return { business_type: 'customer', business_id: String(customerId).trim() };
  }
  const brandId = demand.brand_id || demand.brandId || demand.brand || demand.brand_name;
  if (brandId !== undefined && brandId !== null && String(brandId).trim()) {
    return { business_type: 'brand', business_id: String(brandId).trim() };
  }
  if (fallbackDemandId !== undefined && fallbackDemandId !== null && String(fallbackDemandId).trim()) {
    return { business_type: 'demand', business_id: String(fallbackDemandId).trim() };
  }
  return null;
}

function proposalSections(markdown) {
  const sections = [];
  let current = { title: '', points: [] };
  String(markdown || '').split(/\r?\n/).forEach(function(line) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (heading) {
      if (current.title || current.points.length) sections.push(current);
      current = { title: clientSafeDeckText(heading[1]), points: [] };
      return;
    }
    const cleaned = clientSafeDeckText(line.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, ''));
    if (cleaned && !/^TuringMarket\s*图灵集市$/i.test(cleaned)) current.points.push(cleaned);
  });
  if (current.title || current.points.length) sections.push(current);
  return sections;
}

function proposalPointsFor(markdown, pattern, limit) {
  const matches = proposalSections(markdown).filter(function(section) {
    return pattern.test(section.title);
  });
  return uniqueFacts(matches.flatMap(function(section) { return section.points; }), limit || 4);
}

function safeJson(text, fallback) {
  try { return JSON.parse(text); } catch (e) { return fallback; }
}

function parseJsonObjectResponse(text, fallback) {
  const raw = String(text || '').trim();
  const direct = safeJson(raw, null);
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct;

  const starts = [];
  const ends = [];
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] === '{') starts.push(index);
    if (raw[index] === '}') ends.push(index);
  }
  for (const start of starts) {
    for (let index = ends.length - 1; index >= 0; index -= 1) {
      const end = ends[index];
      if (end <= start) continue;
      const parsed = safeJson(raw.slice(start, end + 1), null);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    }
  }
  return fallback;
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
  opts = opts || {};
  if (opts.db && opts.user && opts.user.id && opts.quotaAdmissionChecked !== true) {
    aiQuota.assertAdmission(opts.db, {
      organizationId: opts.organizationId,
      userId: opts.user.id,
      endpoint: opts.endpoint || 'ai_compat',
      requestId: opts.requestId,
      ipAddress: opts.ipAddress
    });
  }
  const provider = llm.createDeepSeekProvider();
  const completion = await provider.complete({
    messages: [
      { role: 'system', content: 'Return JSON only. No markdown fences. No commentary.' },
      { role: 'user', content: prompt }
    ],
    temperature: opts && opts.temperature !== undefined ? opts.temperature : 0.2,
    max_tokens: opts && opts.max_tokens || 2200,
    signal: opts.signal,
    deadlineAt: opts.deadlineAt
  });
  if (opts.signal && opts.signal.aborted) throw opts.signal.reason || new Error('AI provider operation aborted.');
  if (typeof opts.assertConcurrencyActive === 'function') opts.assertConcurrencyActive();
  recordTokenUsage(opts, completion);
  const raw = String(completion.content || '').replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  const parsed = safeJson(raw, null);
  if (!parsed) return { value: fallback, fallback: true, warning: completion.reason || 'AI JSON parse failed', completion };
  return { value: parsed, fallback: !!completion.degraded, warning: completion.reason || '', completion };
}

function recordTokenUsage(opts, completion) {
  opts = opts || {};
  const usage = completion && completion.usage || {};
  if (!opts.db || !opts.user || !completion || completion.degraded === true) return;
  aiQuota.recordUsageOrThrow(opts.db, {
    organizationId: opts.organizationId,
    requestId: opts.requestId,
    ipAddress: opts.ipAddress,
    userId: opts.user.id,
    model: completion.model || 'deepseek-chat',
    promptTokens: usage.prompt_tokens || 0,
    completionTokens: usage.completion_tokens || 0,
    totalTokens: usage.total_tokens || 0,
    endpoint: opts.endpoint || 'ai_compat'
  });
}

async function generateStrategy(db, user, prompt, input, opts) {
  opts = opts || {};
  const result = await require('./ai_service').handleChat(db, {
    user,
    organizationId: opts.organizationId,
    requestId: opts.requestId,
    ipAddress: opts.ipAddress,
    message: prompt || input || '',
    allowWeb: true,
    source_module: 'strategy',
    summaryVisibility: 'team',
    knowledgeLimit: 8,
    max_tokens: 2500
  });
  return { content: result.answer, fallback: false, ai: result };
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
      organizationId: opts.organizationId,
      message,
      ragQuery: retrievalQuery,
      webQuery: retrievalQuery,
      allowWeb: opts.allowWeb === true,
      source_module: 'demand_analysis',
      campaign_id: opts.campaignId,
      idempotencyKey: opts.idempotencyKey,
      requestId: opts.requestId,
      ipAddress: opts.ipAddress,
      visibility: 'private',
      archiveSummary: false,
      atomicOneShot: true,
      knowledgeLimit: 8,
      temperature: 0.1,
      max_tokens: 1800,
      operationTimeoutMs: opts.operationTimeoutMs,
      degradedContent: JSON.stringify(fallback),
      validateCompletion(content) {
        return parseJsonObjectResponse(content, null) !== null;
      },
      provider: opts.provider,
      webSearchProvider: opts.webSearchProvider,
      signal: opts.signal
    });
    const parsed = parseJsonObjectResponse(aiResult.answer, null);
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

function buildProposalDraftPrompt(input) {
  input = input && typeof input === 'object' ? input : {};
  const template = input.template && typeof input.template === 'object' ? input.template : {};
  const templateSections = Array.isArray(template.sections)
    ? template.sections.slice(0, 20).map(function(section) { return String(section).slice(0, 200); })
    : [];
  const auditContext = Array.isArray(input.auditContext) ? input.auditContext.filter(Boolean) : [];
  return [
    '请生成一份可直接向客户展示并进入项目评审的客户决策型海外红人营销方案草稿，而不是通用行业文章、章节清单或系统操作说明。',
    '输出 Markdown。先给出一句可执行的战略判断，再解释为什么、如何落地、如何验证。',
    '证据纪律：内部推理要区分已确认事实、平台知识库证据、公开资料、策略推断和待客户确认项；客户可见正文不得出现 [KB-n]、[WEB-n]、系统状态、检索过程或模型说明。不得编造产品功能、认证、团队资历、案例数据、预算承诺或 ROI。',
    '方案结构：执行建议；需求与成功标准；启动前确认事项；市场窗口与竞品位置；推荐路径及启用条件；两条备选路径；受众与真实使用场景；平台任务分工；达人组合与100分筛选/淘汰逻辑；内容母题、长视频和短视频格式；预算与商务模式；审核合规；排期；KPI与归因；风险预案；可沉淀资产；下一步。',
    '推荐路径必须具体到客户、产品、市场和预算，并说明放弃另外两条路径的原因。60-30-10只能在适用时使用，不得机械套用。',
    '文风要求：使用客户和执行团队能直接理解的业务语言。不得出现“AI生成”“AI草稿”“AI赋能”“智能增长引擎”“全链路闭环”“客户决策版”等创作过程或空泛套话；但客户资料中真实的 AI 产品名、AI 功能与技术事实必须原样保留。不写无法验证的第一、唯一、领先或保证性承诺。',
    '内容要求：至少一半章节必须直接使用本次需求中的产品、受众、市场、平台、档期、预算或卖点事实；不能把家居、消费电子等其他品类的场景套到当前客户。',
    '每个重要建议都要能回答：依据是什么、由谁执行、交付物是什么、客户需要确认什么。',
    template.name ? '方案模板：' + String(template.name).slice(0, 160) : '',
    template.description ? '模板说明：' + String(template.description).slice(0, 600) : '',
    templateSections.length ? '模板章节可作为参考，不得破坏上述客户决策顺序：' + templateSections.join('；') : '',
    auditContext.length ? '审计上下文：' + auditContext.join('，') : '',
    '',
    String(input.demandText || '')
  ].filter(Boolean).join('\n');
}

function buildPptOutlinePrompt(input) {
  input = input && typeof input === 'object' ? input : {};
  const research = input.research && typeof input.research === 'object' ? input.research : { results: [] };
  const auditContext = Array.isArray(input.auditContext) ? input.auditContext.filter(Boolean) : [];
  return [
    '为 TuringMarket 生成可直接向客户演示的海外红人营销方案大纲。HTMLPPT 与 PPTX 将共用这份结构化数据。',
    '只返回 JSON，不要 Markdown 代码块或解释。顶层字段：title, subtitle, narrative, brand, product, product_full_name, sections。brand 必须沿用需求表原文；product 使用适合演示的短名称，product_full_name 保留需求表原始全称。',
    'sections 必须正好 24 页且包含封面。约80%页面回答客户的产品、市场、策略、内容、执行和衡量问题，约20%页面用于图灵能力证明，并把公司能力放在后段。',
    '每页字段：slot_key, title, type, layout, points, note, kicker, visual_brief, evidence_labels, status。points 为 2-6 条短句；evidence_labels 为 [KB-n] 或公开来源标签数组；status 只能是 confirmed、inference、pending。',
    '固定顺序：1 cover；2 recommendation；3 brief；4 challenge；5 market；6 comparison；7 positioning；8 audience；9 sequence；10 boundaries；11 platform；12 creator_mix；13 scoring；14 content_system；15-16 creative；17-18 format（长视频、短视频各一页）；19 compliance；20 timeline；21 measurement；22 commercial；23 capability；24 next。不得删减、合并或调换页面。',
    'slot_key 必须依次为：cover, recommendation, brief, challenge, market, comparison, positioning, audience, sequence, boundaries, platform, creator_mix, scoring, content_system, creative_primary, creative_search, format_long, format_short, compliance, timeline, measurement, commercial, capability, next。',
    'layout 从 cover-image, recommendation, brief-register, four-challenges, evidence-table, positioning, audience-scene, sequence, boundary-columns, platform-roles, creator-mix, scorecard, content-system, creative-split, format-storyboard, dark-guardrail, timeline, asset-pillars, comparison-table, capability-proof, next-steps 中选择。',
    '页面标题必须表达本页判断，避免“市场分析”“内容策略”等空标题。先写结论，再给证据和动作。每页只解决一个问题。参考图灵集市既有客户方案：紫白黑为主、黄色强调、强判断标题、扁平版式、少装饰、客户问题优先、公司能力后置。',
    '不得编造产品功能、认证、团队、案例、数据、价格、投放结果或图片。visual_brief 只写客户能理解的场景判断，不写素材占位、设计说明或“使用客户提供素材”。',
    '客户可见文案只包括 title、subtitle、narrative、points、note、kicker、visual_brief。不得出现 AI生成、AI草稿、模型提示词、结构校验、P0、客户决策版、[KB-n]、[WEB-n]、[需求表]、[平台能力] 等创作过程或内部标签；客户资料中真实的 AI 产品名、AI 功能与技术事实必须原样保留。',
    'evidence_labels 与 status 仅供系统审计：可以在对应字段保存引用和状态，但不得把这些内容写入任何客户可见文案。不得把知识库中的 [KB-n] 原样写入 title、points、note、kicker 或 visual_brief。',
    '至少 16 页必须直接体现本次需求中的品牌、产品、核心卖点、受众、品类、平台、市场、档期、预算或竞品事实；严禁套用其他客户或其他品类的场景。',
    '不要使用“AI赋能”“智能增长引擎”“颠覆增长”“全链路闭环”等套话，也不要把图灵公司介绍放在方案开头。',
    auditContext.length ? '审计上下文：' + auditContext.join('，') : '',
    'Demand JSON:', JSON.stringify(input.demand || {}),
    'Approved proposal/context:', compactText(input.proposal || '', 8000),
    'Internal knowledge base context:', input.knowledgeContext || 'No relevant internal knowledge was found.',
    'Web research:', JSON.stringify((research.results || []).slice(0, 5))
  ].filter(Boolean).join('\n');
}

function pptSection(title, type, layout, points, note, status, visualBrief) {
  return {
    title,
    type,
    layout,
    points,
    note: note || '',
    kicker: '',
    visual_brief: visualBrief || '',
    evidence_labels: type === 'cover' ? ['需求表/客户资料'] : [],
    status: status || 'inference'
  };
}

const PPT_DECISION_SLOT_KEYS = Object.freeze([
  'cover', 'recommendation', 'brief', 'challenge', 'market', 'comparison',
  'positioning', 'audience', 'sequence', 'boundaries', 'platform', 'creator_mix',
  'scoring', 'content_system', 'creative_primary', 'creative_search',
  'format_long', 'format_short', 'compliance', 'timeline', 'measurement',
  'commercial', 'capability', 'next'
]);

function buildPptOutlineFallback(demand, proposal, reason, research) {
  demand = demand && typeof demand === 'object' ? demand : {};
  const brand = clientSafeDeckText(demand.brand || demand.brand_name || demand.company || demand.company_name || '客户品牌');
  const productFullName = repairMojibakeText(demand.product || demand.product_name || '核心产品');
  const product = presentationProductName(productFullName);
  const market = clientSafeDeckText(demand.target_market || demand.market || demand.area || '目标市场');
  const budget = clientSafeDeckText(demand.budget || demand.budget_range || '待确认');
  const platformValues = [].concat(demand.platforms || demand.platform || ['YouTube'])
    .flatMap(function(value) { return String(value || '').split(/[,，、]+/); })
    .map(clientSafeDeckText)
    .filter(Boolean);
  const platforms = [...new Set(platformValues)].join(' / ') || '待确认';
  const competitors = [].concat(demand.competitors || demand.competitor || [])
    .flatMap(function(value) { return String(value || '').split(/[,，\n]+/); })
    .map(function(value) {
      const cleaned = clientSafeDeckText(value);
      const domain = cleaned.match(/^https?:\/\/(?:www\.)?([^/?#]+)/i);
      return domain ? domain[1].replace(/\.(?:com|co|net|org).*$/i, '') : cleaned;
    })
    .filter(Boolean)
    .join(' / ') || '待客户确认';
  const facts = buildDemandDeckFacts(demand);
  const demandText = [productFullName, demand.category, demand.industry, facts.sourceText, facts.notes].join(' ');
  const huntingCampaign = /hunt|deer|bowhunting|狩猎|打猎|猎人|blind/i.test(demandText);
  const primaryScene = huntingCampaign ? '真实猎场与林地环境' : '目标用户真实使用场景';
  const primaryCreator = facts.creatorType || (huntingCampaign ? '资深猎人创作者' : '品类垂直创作者');
  const sellingPoints = facts.sellingPoints.length
    ? facts.sellingPoints
    : ['核心价值|围绕客户已确认的产品事实展开', '使用证明|通过真实操作与场景说明差异'];
  const sellingSummary = compactText(sellingPoints.join('；'), 180);
  const proposalMap = {
    recommendation: proposalPointsFor(proposal, /执行建议|战略判断|核心建议|执行推荐/, 3),
    market: proposalPointsFor(proposal, /市场|窗口|时机|趋势/, 3),
    comparison: proposalPointsFor(proposal, /竞品|竞争|对比/, 3),
    positioning: proposalPointsFor(proposal, /定位|价值主张|信息主张/, 3),
    audience: proposalPointsFor(proposal, /受众|人群|使用场景/, 3),
    platform: proposalPointsFor(proposal, /平台|YouTube|Instagram|TikTok/, 3),
    creator: proposalPointsFor(proposal, /达人|红人|创作者|筛选/, 4),
    content: proposalPointsFor(proposal, /内容母题|内容策略|内容方向|传播主线/, 4),
    creative: proposalPointsFor(proposal, /创意|脚本|钩子/, 4),
    compliance: proposalPointsFor(proposal, /合规|审核|风险|边界/, 3),
    timeline: proposalPointsFor(proposal, /排期|节奏|里程碑|时间/, 3),
    measurement: proposalPointsFor(proposal, /KPI|指标|衡量|归因|复盘/, 3),
    commercial: proposalPointsFor(proposal, /预算|商务|报价|费用/, 3),
    next: proposalPointsFor(proposal, /下一步|启动|客户确认/, 3)
  };
  if (!proposalMap.recommendation.length) {
    const unheaded = proposalSections(proposal).filter(function(section) { return !section.title; });
    proposalMap.recommendation = uniqueFacts(
      unheaded.flatMap(function(section) { return section.points; }),
      2
    );
  }
  function approved(label, values) {
    return values.map(function(value) { return label + '|' + value; });
  }
  function recommendationPoints(values) {
    const labels = ['优先动作', '内容路径', '成功标准'];
    return values.slice(0, labels.length).map(function(value, index) {
      return labels[index] + '|' + value;
    });
  }
  function mergePoints(mapped, defaults, limit) {
    return uniqueFacts([].concat(mapped || [], defaults || []), limit || 6);
  }
  const researchPoints = (research && research.results || []).slice(0, 3).map(function(item, index) {
    return '市场信号 ' + (index + 1) + '|' + clientSafeDeckText(compactText(item.title || item.snippet || item.url, 150));
  });
  const platformRolePoints = /youtube/i.test(platforms) && !/(instagram|tiktok)/i.test(platforms)
    ? [
        '深度内容|用完整使用过程回答购买前问题',
        '搜索承接|标题、描述区与章节结构覆盖高意向问题',
        '转化动作|链接、折扣码和评论区问答统一承接',
        '本次范围|' + platforms
      ]
    : [
        '长视频|负责深度解释、搜索沉淀和购买前决策',
        '短视频|负责测试钩子、场景和单一卖点',
        '社交触点|负责复访、评论互动与素材再利用',
        '本次范围|' + platforms
      ];
  const contentPoints = sellingPoints.map(function(value, index) {
    const pair = String(value).includes('|') ? value : ('卖点 ' + (index + 1) + '|' + value);
    return pair;
  });
  const proofSummary = compactText(sellingPoints.join('、'), 150)
    || '操作过程、场景细节和真实反馈';
  const primaryCreativePoints = huntingCampaign
    ? [
        '创意母题|一次真实猎场布置与等待任务',
        '开场钩子|猎物进入视野前，猎人如何同时看清环境并保持隐蔽',
        '内容证据|' + proofSummary,
        '行动入口|说明适用场景与型号选择，引导查看正式产品页面'
      ]
    : [
        '创意母题|把' + product + '放进目标受众本来就会完成的任务',
        '开场钩子|先出现具体问题或场景变化，不先念品牌卖点',
        '内容证据|' + proofSummary,
        '行动入口|说明适用场景并引导查看正式产品页面'
      ];
  const longFormatPoints = huntingCampaign
    ? [
        '0-15秒|从猎人进入林地后的视野与隐蔽难题切入',
        '15-90秒|完成搭建并展示帐篷内外视角与操作动线',
        '核心证明|' + proofSummary,
        '结尾|明确适用人群、型号选择、购买入口与合作披露'
      ]
    : [
        '0-15秒|具体使用问题与观看理由',
        '15-90秒|' + primaryScene + '、目标用户和产品任务',
        '核心证明|' + proofSummary,
        '结尾|适用人群、购买入口、折扣信息和合作披露'
      ];
  const shortFormatPoints = huntingCampaign
    ? [
        '0-3秒|用帐篷内外视角切换制造视觉钩子',
        '3-12秒|展示快速搭建或收纳中的关键动作',
        '12-30秒|一次只证明视野、隐蔽或收放中的一个卖点',
        '结尾|给出清晰结论、购买入口与合作披露'
      ]
    : [
        '0-3秒|一个具体问题、动作或结果画面',
        '3-12秒|展示场景和产品动作',
        '12-30秒|解释一个已确认卖点或关键差异',
        '结尾|一句结论、购买入口和合作披露'
      ];
  if (facts.campaignBackground) contentPoints.push('项目语境|' + facts.campaignBackground);
  contentPoints.push('购买承接|价格、渠道、链接与优惠以客户正式信息为准');
  const sections = [
    pptSection(brand + ' ' + product + ' 海外红人营销方案', 'cover', 'cover-image', [market, platforms, '项目预算|' + budget], '海外红人营销项目', 'confirmed', primaryScene + '中的产品价值与使用任务。'),
    pptSection(huntingCampaign ? '用真实猎场验证产品差异，再由内容承接购买决策' : '用真实使用证明产品价值，再由内容承接购买决策', 'recommendation', 'recommendation', mergePoints(recommendationPoints(proposalMap.recommendation), ['核心判断|' + (huntingCampaign ? '以真实猎场任务证明产品差异，让内容直接服务购买决策' : ('围绕' + primaryScene + '解释' + product + '的购买理由')), '项目资产|把达人、内容、数据和授权素材沉淀为下一轮资产'], 5), '执行建议', 'inference'),
    pptSection('项目目标、范围与启动条件需要一次对齐', 'brief', 'brief-register', ['品牌|' + brand, '产品|' + product, '市场与平台|' + market + ' / ' + platforms, '预算|' + budget, '项目目标|' + (facts.campaignBackground || '建立产品理解、内容信任与转化承接'), '启动前确认|价格库存、样品、购买链路、审核负责人及禁用表达'], '项目范围', 'pending'),
    pptSection('本次项目的难点不在曝光量，而在内容是否足够可信', 'challenge', 'four-challenges', ['时机窗口|' + facts.launchWindow, '产品理解|' + compactText(sellingSummary || product, 100), '达人匹配|' + facts.creatorScale, '执行确定性|提前锁定样品、审核、档期和替补'], '项目挑战', 'inference'),
    pptSection('上线节奏必须围绕客户档期和真实市场信号安排', 'market', 'evidence-table', mergePoints(approved('确认方案', proposalMap.market), researchPoints.length ? researchPoints : ['客户时间表|' + facts.launchWindow, '项目语境|' + (facts.campaignBackground || '以正式上市、库存和销售节奏为准'), '执行动作|先完成事实表和达人池，再锁定上线档期'], 6), '市场窗口', researchPoints.length ? 'confirmed' : 'pending'),
    pptSection('竞品比较只服务于定位，不替代客户产品事实', 'comparison', 'comparison-table', mergePoints(approved('确认方案', proposalMap.comparison), ['竞品范围|' + competitors, '比较维度|受众、使用任务、内容证明与购买链路', '表达边界|竞品功能、认证与参数不能写成客户产品能力'], 6), '竞争格局', 'pending'),
    pptSection(brand + '应占据一个可被实测证明的品类位置', 'positioning', 'positioning', mergePoints(approved('确认方案', proposalMap.positioning), ['核心主张|' + (huntingCampaign ? '看得更广、藏得更稳、收得更快' : (sellingPoints[0] || ('用' + primaryScene + '证明' + product + '价值'))), '证明方式|' + primaryScene + '、操作过程与真实反馈', '适用人群|' + facts.audience, '转化承接|购买链接、优惠机制和评论区问答'], 5), '定位建议', 'inference'),
    pptSection('先匹配真实使用者，再评估粉丝规模', 'audience', 'audience-scene', mergePoints(approved('确认方案', proposalMap.audience), ['核心受众|' + facts.audience, '创作者类型|' + primaryCreator, '筛选原则|' + facts.creatorScale, '内容语言|' + facts.language, '使用环境|' + primaryScene], 6), '受众与使用场景', 'inference', primaryScene + '应直接呈现人物、产品和任务之间的关系。'),
    pptSection('一条内容要完整回答“为什么需要、如何使用、结果如何”', 'sequence', 'sequence', ['01 真实问题|从目标受众正在面对的具体任务开始', '02 产品价值|' + compactText(sellingPoints[0] || sellingSummary || product, 100), '03 使用演示|按客户确认资料展示操作与边界', '04 结果证据|呈现场景细节、体验反馈或同口径对比', '05 行动入口|给出清楚的购买链路、折扣信息和合作披露'], '传播主线', 'inference'),
    pptSection('每一项卖点都要对应事实、演示和禁用表达', 'boundaries', 'boundary-columns', ['可使用|客户书面确认的功能、卖点、价格与渠道', '启动前核实|尚未发布的参数、服务承诺和上市信息', '禁止使用|竞品参数移植、危险测试和保证性效果承诺'], '内容表达边界', 'pending'),
    pptSection('平台选择决定内容的说服深度与转化动作', 'platform', 'platform-roles', mergePoints(approved('确认方案', proposalMap.platform), platformRolePoints, 6), '平台分工', 'inference'),
    pptSection('达人组合围绕内容任务配置，而不是按粉丝量堆人', 'creator_mix', 'creator-mix', mergePoints(approved('确认方案', proposalMap.creator), ['核心创作者|' + primaryCreator, '深度评测型|负责完整使用过程和购买前解释', '场景体验型|负责' + primaryScene + '中的自然使用', '搜索承接型|负责竞品问题、FAQ和长期搜索流量'], 6), '达人组合', 'inference'),
    pptSection('100分模型选人，风险项一票否决', 'scoring', 'scorecard', ['受众与市场匹配|25', '近10条同形式内容表现|25', '内容解释与演示能力|20', '评论质量与商业内容折损|15', '报价、授权和档期可执行性|15', '一票否决|假量、受众错位、竞品冲突、危险表达'], '筛选标准', 'inference'),
    pptSection('内容系统必须把核心卖点转成可拍、可审、可复用的证据', 'content_system', 'content-system', mergePoints(approved('确认方案', proposalMap.content), contentPoints, 6), '内容母题', 'inference'),
    pptSection(huntingCampaign ? '首批创意从一次真实猎场任务开始' : '首批创意从一次真实使用任务开始', 'creative', 'creative-split', mergePoints(approved('方案依据', proposalMap.creative), primaryCreativePoints, 6), '创意方向 01', 'inference', primaryScene + '中的实测任务，突出产品动作与结果。'),
    pptSection('第二组创意承接高意向搜索与同口径比较', 'creative', 'creative-split', huntingCampaign ? ['搜索问题|270°与360°视野分别适合哪些狩猎环境', '型号选择|围绕 BL001 与 BL008 的视野、人数和使用条件解释差异', '对比原则|只比较正式资料中可核验的参数与场景', '资产价值|沉淀型号 FAQ、评论语料和可复用内容片段'] : ['搜索问题|围绕用户购买前最常问的产品、场景和选择问题', '产品组合|解释' + product + '中不同型号或使用条件的差异', '对比原则|只比较正式资料中可核验的参数与场景', '资产价值|沉淀 FAQ、评论语料和可复用内容片段'], '创意方向 02', 'inference', product + '的选择问题与真实使用差异。'),
    pptSection('长视频负责完成一次完整的购买前解释', 'format', 'format-storyboard', longFormatPoints, 'YouTube 长视频', 'inference'),
    pptSection('短视频每条只验证一个钩子或一个卖点', 'format', 'format-storyboard', shortFormatPoints, '短视频切片', 'inference'),
    pptSection('发布前必须同时通过事实、演示与披露审核', 'compliance', 'dark-guardrail', mergePoints(approved('确认方案', proposalMap.compliance), ['卖点证据表|每项卖点对应客户证据和可用表达', '资料校验|安装、使用与限制必须与正式资料一致', '演示安全|禁止自行制造风险或不安全操作', '合作披露|口头、画面和描述区按市场要求披露合作关系', '授权与合同|明确修改、保留、剪辑、白名单和地域'], 6), '内容审核与安全红线', 'pending'),
    pptSection('排期并行推进，但每个关键门槛都要完成确认', 'timeline', 'timeline', mergePoints(approved('确认方案', proposalMap.timeline), ['启动|第1周|产品事实清单、项目目标与审核口径确认|项目启动表', '筛选|第1-2周|达人池、报价与风险核验|推荐名单', '制作|第2-4周|寄样、脚本、拍摄与修改|脚本和样片', '上线|' + facts.launchWindow + '|发布、监测与评论承接|上线链接和周报', '复盘|上线后7天与30天|数据回收与下一轮建议|复盘报告'], 6), '执行排期', 'inference'),
    pptSection('一次项目留下达人、内容与数据三类资产', 'measurement', 'asset-pillars', ['达人资产|报价、受众、履约和历史表现', '内容资产|钩子、脚本、授权素材和 FAQ', '数据资产|曝光、互动、点击、转化和成本口径', '复盘节奏|24小时、7天、30天按项目目标回收'], '数据与资产沉淀', 'inference'),
    pptSection('项目制承担主计划，单次采买用于边界清晰的补充测试', 'commercial', 'comparison-table', mergePoints(approved('确认方案', proposalMap.commercial), ['项目制|策略、达人组合、议价、审核、替补、归因和复盘', '单次采买|指定达人、单一交付物和明确授权边界', '同口径比较|统一达人条件、交付物、授权周期和税费口径', '预算|' + budget + '，具体拆分待报价和客户确认'], 6), '商务模式', 'pending'),
    pptSection('图灵的价值体现在执行证据与响应机制', 'capability', 'capability-proof', ['需求转译|把产品资料转成达人筛选、脚本和审核标准', '项目执行|名单、合同、寄样、内容审核和上线盯控', '数据复盘|统一回收链接、指标、评论和素材资产', '响应机制|关键节点明确负责人、反馈时限与替补方案'], 'Why TuringMarket', 'confirmed'),
    pptSection('关键资料确认后，即可启动达人建联与排期', 'next', 'next-steps', mergePoints(approved('确认方案', proposalMap.next), ['产品事实清单|功能、卖点、安装使用和禁用表达', '量产与样品|数量、时间、寄送区域和库存', '价格与购买链路|零售价、套装、渠道、链接和优惠', '审核节奏|品牌负责人、合规负责人和反馈时限', '启动动作|确认后进入达人长名单、首轮报价与寄样准备'], 6), '下一步', 'pending')
  ];
  sections.forEach(function(section, index) {
    section.slot_key = PPT_DECISION_SLOT_KEYS[index];
  });
  sections[0].evidence_labels = ['[需求表]'];
  sections[2].evidence_labels = ['[需求表]'];
  if (researchPoints.length) {
    sections[4].evidence_labels = researchPoints.map(function(_point, index) {
      return '[WEB-' + (index + 1) + ']';
    });
  }
  sections[22].evidence_labels = ['[平台能力]'];
  return {
    title: brand + ' ' + product + ' 海外红人营销方案',
    subtitle: market + ' / ' + platforms + ' / ' + budget,
    narrative: huntingCampaign
      ? '以真实猎场任务证明产品差异，让内容直接服务购买决策。'
      : '以真实使用任务证明产品价值，让内容直接服务购买决策。',
    brand,
    product,
    product_full_name: productFullName,
    sections,
    research,
    warning: reason || ''
  };
}

async function generatePptOutline(db, user, body, opts) {
  body = body && typeof body === 'object' ? body : {};
  opts = opts || {};
  const demand = body.demand || {};
  const proposal = [body.proposal || '', body.deckContext || ''].filter(Boolean).join('\n\n');
  const demandFacts = buildDemandDeckFacts(demand);
  const query = [
    demand.brand,
    demand.company,
    presentationProductName(demand.product || demand.product_name),
    demand.target_market,
    demand.market,
    demand.area,
    demand.category,
    demand.industry,
    demand.usp,
    demandFacts.sellingPoints.join(' '),
    demandFacts.audience
  ].filter(Boolean).join(' ');
  const campaignId = Number(opts.campaignId);
  const knowledgeScope = pptKnowledgeScope(demand, campaignId, body.demand_id || body.source_id);
  if (Number.isSafeInteger(campaignId) && campaignId > 0) {
    const research = {
      used: false,
      provider: 'tavily',
      results: [],
      reason: 'disabled'
    };
    const fallback = buildPptOutlineFallback(demand, proposal, '', research);
    const auditContext = [];
    if (opts.demandAudit) {
      auditContext.push('需求分析对话 #' + opts.demandAudit.conversation_id);
      auditContext.push('需求分析消息 #' + opts.demandAudit.message_id);
    }
    if (opts.proposalAudit) {
      auditContext.push('方案草稿对话 #' + opts.proposalAudit.conversation_id);
      auditContext.push('方案草稿消息 #' + opts.proposalAudit.message_id);
    }
    const message = buildPptOutlinePrompt({
      demand,
      proposal,
      auditContext,
      knowledgeContext: 'Use relevant Campaign demand, confirmed proposal, brand profile, CRM context, and approved methodology. Citation labels are audit metadata only and must not appear in client-visible copy.',
      research
    });
    const aiService = opts.aiService || require('./ai_service');
    const aiResult = await aiService.handleChat(db, {
      user,
      organizationId: opts.organizationId,
      message,
      ragQuery: [query, proposal].filter(Boolean).join('\n\n'),
      webQuery: query,
      allowWeb: false,
      source_module: 'ppt_outline',
      campaign_id: campaignId,
      idempotencyKey: opts.idempotencyKey,
      requestId: opts.requestId,
      ipAddress: opts.ipAddress,
      knowledge_entry_ids: body.knowledge_entry_ids,
      source_types: PPT_RAG_SOURCE_TYPES.slice(),
      business_type: knowledgeScope.business_type,
      business_id: knowledgeScope.business_id,
      visibility: 'private',
      archiveSummary: false,
      atomicOneShot: true,
      knowledgeLimit: 8,
      temperature: 0.25,
      max_tokens: 6800,
      operationTimeoutMs: opts.operationTimeoutMs,
      degradedContent: JSON.stringify(fallback),
      validateCompletion(content) {
        return parseJsonObjectResponse(content, null) !== null;
      },
      provider: opts.provider,
      webSearchProvider: opts.webSearchProvider,
      signal: opts.signal
    });
    const parsed = parseJsonObjectResponse(aiResult.answer, null);
    const outline = normalizePptOutline(parsed, fallback, research);
    outline.knowledge_references = aiResult.knowledge_references || [];
    return {
      outline,
      knowledge_references: aiResult.knowledge_references || [],
      research,
      fallback: !parsed || !!aiResult.degraded,
      warning: aiResult.reason || (!parsed ? 'AI JSON parse failed' : ''),
      ai: aiResult
    };
  }
  aiQuota.assertAdmission(db, {
    organizationId: opts.organizationId,
    userId: user.id,
    endpoint: 'ppt_outline',
    requestId: opts.requestId,
    ipAddress: opts.ipAddress
  });
  const concurrencyKey = 'ppt_outline:' + (
    typeof opts.requestId === 'string' && opts.requestId.trim()
      ? opts.requestId.trim()
      : crypto.randomUUID()
  );
  return aiConcurrency.createAIConcurrencyService(db).runWithPermit({
    organizationId: opts.organizationId,
    actorUserId: user.id,
    operationKey: concurrencyKey.slice(0, 200),
    provider: 'tavily_deepseek_sequence',
    signal: opts.signal
  }, async (permit) => {
  const ragContext = knowledgeScope
    ? rag.buildRagContext(db, {
        user,
        organizationId: opts.organizationId,
        query: [query, proposal].filter(Boolean).join('\n\n'),
        limit: body.knowledge_limit || 8,
        business_type: knowledgeScope.business_type,
        business_id: knowledgeScope.business_id,
        source_types: PPT_RAG_SOURCE_TYPES.slice()
      })
    : { query, contextText: '', references: [], hasKnowledge: false };
  const allowWeb = opts.allowWeb === true;
  const research = allowWeb
    ? await webSearch.searchWeb(query || 'overseas influencer marketing campaign', {
        db,
        maxResults: 5,
        signal: permit.signal,
        deadlineAt: permit.deadlineAt
      })
    : { used: false, provider: 'tavily', results: [], reason: 'disabled' };
  permit.assertActive();
  const fallback = buildPptOutlineFallback(demand, proposal, '', research);
  const prompt = buildPptOutlinePrompt({
    demand,
    proposal,
    auditContext: [],
    knowledgeContext: ragContext.contextText || 'No relevant internal knowledge was found.',
    research
  });
  const generated = await generateJsonWithDeepSeek(prompt, fallback, {
    db,
    user,
    organizationId: opts.organizationId,
    temperature: 0.25,
    max_tokens: 6800,
    endpoint: 'ppt_outline',
    requestId: opts.requestId,
    ipAddress: opts.ipAddress,
    quotaAdmissionChecked: true,
    signal: permit.signal,
    deadlineAt: permit.deadlineAt,
    assertConcurrencyActive: permit.assertActive
  });
  permit.assertActive();
  const outline = normalizePptOutline(generated.value, fallback, research);
  outline.knowledge_references = ragContext.references;
  if (allowWeb) {
    webSearch.cacheSearchResult(db, query || 'overseas influencer marketing campaign', research);
  }
  permit.assertActive();
  knowledgeService.recordKnowledgeUsageTelemetry(
    db,
    ragContext.references.map(function(ref) { return ref.id; }),
    user,
    { organizationId: opts.organizationId }
  );
  permit.assertActive();
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
      organizationId: opts.organizationId,
      metadata: {
        research_used: !!research.used,
        knowledge_reference_ids: ragContext.references.map(function(ref) { return ref.id; })
      }
    });
  } catch (e) {}
  return {
    outline,
    knowledge_references: ragContext.references,
    research,
    fallback: generated.fallback,
    warning: generated.warning
  };
  });
}

function normalizePptOutline(value, fallback, research) {
  const out = Object.assign({}, fallback || {}, value || {});
  out.title = clientSafeDeckText(out.title || (fallback && fallback.title) || '海外红人营销方案');
  out.subtitle = clientSafeDeckText(out.subtitle || (fallback && fallback.subtitle) || '');
  out.narrative = clientSafeDeckText(out.narrative || (fallback && fallback.narrative) || '');
  out.brand = clientSafeDeckText((fallback && fallback.brand) || out.brand || '');
  out.product_full_name = repairMojibakeText(
    (fallback && (fallback.product_full_name || fallback.product))
      || out.product_full_name
      || out.product
      || ''
  );
  out.product = presentationProductName(
    (fallback && (fallback.product_full_name || fallback.product))
      || out.product_full_name
      || out.product
      || ''
  );
  function normalizeSection(sec, index) {
    sec = sec && typeof sec === 'object' ? sec : {};
    const evidenceLabels = Array.isArray(sec.evidence_labels)
      ? sec.evidence_labels.map(function(label) { return String(label).trim(); }).filter(Boolean).slice(0, 6)
      : [];
    let status = ['confirmed', 'inference', 'pending'].includes(sec.status) ? sec.status : 'inference';
    if (status === 'confirmed' && evidenceLabels.length === 0) status = 'pending';
    return {
      slot_key: String(sec.slot_key || '').trim(),
      title: clientSafeDeckText(sec.title || ('Slide ' + (index + 1))),
      type: sec.type || 'content',
      layout: sec.layout || sec.type || 'content',
      points: (Array.isArray(sec.points) ? sec.points.map(String) : String(sec.points || '').split(/\n|;|；/))
        .map(clientSafeDeckText)
        .filter(Boolean),
      note: clientSafeDeckText(sec.note || ''),
      kicker: clientSafeDeckText(sec.kicker || ''),
      visual_brief: clientSafeDeckText(sec.visual_brief || ''),
      evidence_labels: evidenceLabels,
      status
    };
  }
  const generatedSections = (value && Array.isArray(value.sections) ? value.sections : [])
    .map(function(section, index) {
      return Object.assign(normalizeSection(section, index), { _source_index: index });
    })
    .filter(function(sec) { return sec.title; });
  const fallbackSections = (fallback && Array.isArray(fallback.sections) ? fallback.sections : [])
    .map(function(section, index) {
      const normalized = normalizeSection(section, index);
      normalized.slot_key = normalized.slot_key || PPT_DECISION_SLOT_KEYS[index] || '';
      return normalized;
    })
    .filter(function(sec) { return sec.title; });
  out.unmapped_sections = [];
  if (fallbackSections.length === PPT_DECISION_SLOT_KEYS.length && generatedSections.length) {
    const fallbackBySlot = new Map(fallbackSections.map(function(section) {
      return [section.slot_key, section];
    }));
    function inferredDuplicateSlot(section) {
      const text = [section.title, section.note].concat(section.points || []).join(' ').toLowerCase();
      if (section.type === 'creative') {
        if (/搜索|对比|高意向|购买前|search|comparison/.test(text)) return 'creative_search';
        if (/首批|真实|任务|场景|primary|real task|scene|creative 0?1/.test(text)) return 'creative_primary';
      }
      if (section.type === 'format') {
        if (/youtube|长视频|long[- ]?form|深度/.test(text)) return 'format_long';
        if (/tiktok|reels|shorts|短视频|short[- ]?form/.test(text)) return 'format_short';
      }
      return '';
    }
    function semanticSlot(section) {
      const inferred = inferredDuplicateSlot(section);
      const declaredBase = fallbackBySlot.get(section.slot_key);
      const declared = declaredBase && String(declaredBase.type) === String(section.type)
        ? section.slot_key
        : '';
      if (inferred && inferred !== declared) return inferred;
      return declared || inferred;
    }
    const canonicalInput = generatedSections.length === fallbackSections.length
      && generatedSections.every(function(section, index) {
        if (String(section.type) !== String(fallbackSections[index].type)) return false;
        const semantic = semanticSlot(section);
        if (section.slot_key && section.slot_key !== fallbackSections[index].slot_key) return false;
        return !semantic || semantic === fallbackSections[index].slot_key;
      });
    const used = new Set();
    function candidateIndex(baseSection, slotIndex) {
      let index = generatedSections.findIndex(function(section, candidate) {
        return !used.has(candidate) && semanticSlot(section) === baseSection.slot_key;
      });
      if (index >= 0) return index;
      if (generatedSections[slotIndex]
          && !used.has(slotIndex)
          && String(generatedSections[slotIndex].type) === String(baseSection.type)) {
        return slotIndex;
      }
      return generatedSections.findIndex(function(section, candidate) {
        return !used.has(candidate) && String(section.type) === String(baseSection.type);
      });
    }
    out.sections = fallbackSections.map(function(baseSection, slotIndex) {
      const matchIndex = candidateIndex(baseSection, slotIndex);
      if (matchIndex < 0) return Object.assign({}, baseSection);
      used.add(matchIndex);
      const candidate = generatedSections[matchIndex];
      const merged = Object.assign({}, baseSection, candidate, {
        type: baseSection.type,
        slot_key: baseSection.slot_key,
        layout: candidate.layout || baseSection.layout,
        points: candidate.points.length ? candidate.points : baseSection.points,
        evidence_labels: candidate.evidence_labels.length
          ? candidate.evidence_labels
          : baseSection.evidence_labels
      });
      if (slotIndex === 0) merged.title = (fallback && fallback.title) || baseSection.title;
      if (merged.status === 'confirmed' && merged.evidence_labels.length === 0) merged.status = 'pending';
      delete merged._source_index;
      return merged;
    });
    out.unmapped_sections = generatedSections
      .filter(function(_section, index) { return !used.has(index); })
      .map(function(section) {
        const copy = Object.assign({}, section);
        delete copy._source_index;
        return copy;
      });
    out.structure_repaired = !canonicalInput || out.unmapped_sections.length > 0;
    out.structure_warning = out.structure_repaired
      ? 'AI outline was normalized to the approved 24-page decision flow; unmatched content is visible on the brief page for review.'
      : '';
  } else {
    out.sections = generatedSections.length ? generatedSections : fallbackSections;
    out.structure_repaired = false;
    out.structure_warning = '';
  }
  out.research = out.research || research || (fallback && fallback.research);
  return out;
}

function similarKnowledge(db, query, user, opts) {
  opts = opts || {};
  const terms = [query.brand, query.industry, query.product, query.market].filter(Boolean).join(' ');
  return knowledgeService.searchKnowledge(db, {
    q: terms || query.q || '',
    entry_type: query.type || '',
    user,
    organizationId: opts.organizationId,
    limit: query.limit || 5
  });
}

module.exports = {
  safeUnlink,
  parseDemandFile,
  inferDemandAnalysis,
  generateStrategy,
  generateDemandAnalysis,
  buildProposalDraftPrompt,
  buildPptOutlinePrompt,
  repairMojibakeText,
  clientSafeDeckText,
  presentationProductName,
  pptKnowledgeScope,
  PPT_RAG_SOURCE_TYPES,
  buildPptOutlineFallback,
  normalizePptOutline,
  generatePptOutline,
  similarKnowledge
};

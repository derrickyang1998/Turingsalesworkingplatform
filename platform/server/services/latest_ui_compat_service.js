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
    '请生成一份可直接进入人工评审的客户决策型海外红人营销方案草稿，而不是通用行业文章或章节清单。',
    '输出 Markdown。先给出一句可执行的战略判断，再解释为什么、如何落地、如何验证。',
    '证据纪律：把已确认事实、平台知识库证据、公开资料、策略推断、待客户确认项分开；沿用系统提供的 [KB-n] 引用，不得编造产品功能、认证、团队资历、案例数据、预算承诺或 ROI。',
    '方案结构：执行建议；需求与成功标准；信息边界和 P0 待确认；市场窗口与竞品位置；推荐路径及启用条件；两条备选路径；受众与真实使用场景；平台任务分工；达人组合与100分筛选/淘汰逻辑；内容母题、长视频和短视频格式；预算与商务模式；审核合规；排期；KPI与归因；风险预案；可沉淀资产；下一步。',
    '推荐路径必须具体到客户、产品、市场和预算，并说明放弃另外两条路径的原因。60-30-10只能在适用时使用，不得机械套用。',
    '文风要求：使用客户和执行团队能直接理解的业务语言。不要使用“AI赋能”“智能增长引擎”“全链路闭环”等空泛 AI 套话，不写无法验证的第一、唯一、领先或保证性承诺。',
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
    '为 TuringMarket 生成客户决策型海外红人营销演示大纲。HTMLPPT 与 PPTX 将共用这份结构化数据。',
    '只返回 JSON，不要 Markdown 代码块或解释。顶层字段：title, subtitle, narrative, brand, product, sections。brand 与 product 必须沿用需求表原文。',
    'sections 必须为 18-24 页且包含封面。约80%页面回答客户的产品、市场、策略、内容、执行和衡量问题，约20%页面用于图灵能力证明，并把公司能力放在后段。',
    '每页字段：title, type, layout, points, note, kicker, visual_brief, evidence_labels, status。points 为 2-6 条短句；evidence_labels 为 [KB-n] 或公开来源标签数组；status 只能是 confirmed、inference、pending。',
    '建议顺序：cover；recommendation；brief；challenge；market；comparison；positioning；audience；sequence；boundaries；platform；creator_mix；scoring；content_system；creative（1-2页）；format（长视频与短视频）；compliance；timeline；measurement；commercial；capability；next。可以按资料删减，但不得跳过 recommendation、brief、boundaries、compliance、measurement、capability、next。',
    'layout 从 cover-image, recommendation, brief-register, four-challenges, evidence-table, positioning, audience-scene, sequence, boundary-columns, platform-roles, creator-mix, scorecard, content-system, creative-split, format-storyboard, dark-guardrail, timeline, asset-pillars, comparison-table, capability-proof, next-steps 中选择。',
    '页面标题必须表达本页判断，避免“市场分析”“内容策略”等空标题。先写结论，再给证据和动作。每页只解决一个问题。',
    '不得编造产品功能、认证、团队、案例、数据、价格、投放结果或图片。visual_brief 只描述应使用的真实产品/场景视觉；没有已授权素材时明确写“使用客户提供素材或概念场景示意”。',
    '保留事实边界与 P0 待确认项。知识库引用沿用 [KB-n]。不要使用“AI赋能”“颠覆增长”“全链路闭环”等 AI套话，也不要把图灵公司介绍放在方案开头。',
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
    evidence_labels: [],
    status: status || 'inference'
  };
}

function buildPptOutlineFallback(demand, proposal, reason, research) {
  demand = demand && typeof demand === 'object' ? demand : {};
  const brand = demand.brand || demand.brand_name || demand.company || demand.company_name || '客户品牌';
  const product = demand.product || demand.product_name || '核心产品';
  const market = demand.target_market || demand.market || demand.area || '目标市场';
  const budget = demand.budget || demand.budget_range || '待确认';
  const platforms = [].concat(demand.platforms || demand.platform || ['YouTube', 'Instagram', 'TikTok']).filter(Boolean).join(' / ');
  const competitors = [].concat(demand.competitors || demand.competitor || []).filter(Boolean).join(' / ') || '待客户确认';
  const proposalBrief = compactText(proposal || demand.usp || product, 180);
  const researchPoints = (research && research.results || []).slice(0, 3).map(function(item, index) {
    return '市场信号 ' + (index + 1) + '|' + compactText(item.title || item.snippet || item.url, 150);
  });
  const sections = [
    pptSection(brand + ' ' + product + ' 海外红人营销方案', 'cover', 'cover-image', [market, platforms, '预算口径|' + budget], reason || '客户汇报版', 'confirmed', '使用客户提供的产品主视觉；没有正式素材时使用与品类一致的概念场景示意。'),
    pptSection('建议先建立产品理解与信任，再推动购买', 'recommendation', 'recommendation', ['战略判断|围绕真实使用任务解释产品价值，再用表现最好的内容承接转化', '达人任务|用可信演示回答购买前问题', '项目任务|把内容、数据和授权素材沉淀为下一轮资产'], '执行建议', 'inference'),
    pptSection('先锁定产品事实，再锁定脚本卖点', 'brief', 'brief-register', ['品牌|' + brand, '产品|' + product, '市场|' + market, '预算|' + budget, 'P0待确认|SKU、功能与认证、价格库存、样品、购买链路、审核负责人'], '需求与信息边界', 'pending'),
    pptSection('本次项目要同时解决四个客户问题', 'challenge', 'four-challenges', ['品牌认知|目标受众为什么要关注', '产品理解|用一句话说清产品解决的问题', '内容可信|让演示和证据代替口号', '执行确定性|提前锁定样品、审核、档期和替补'], '项目挑战', 'inference'),
    pptSection('推广窗口由客户节奏与真实市场信号共同决定', 'market', 'evidence-table', researchPoints.length ? researchPoints : ['客户时间表|以正式上市和库存时间为准', '市场信号|当前未读取到可核验联网资料', '执行建议|先完成事实表和达人池，再确定上线节奏'], '市场窗口', researchPoints.length ? 'confirmed' : 'pending'),
    pptSection('竞品已占据认知位置，方案需要明确差异来源', 'comparison', 'comparison-table', ['竞品范围|' + competitors, '可比较项|受众、使用任务、内容证明、购买链路', '不可借用项|竞品功能、认证与参数不能写成客户产品能力'], '竞争格局', 'pending'),
    pptSection(brand + '需要先争取一个清楚、可证明的位置', 'positioning', 'positioning', ['客户问题|目标用户为什么现在需要' + product, '品牌角色|用已确认事实给出清楚答案', '内容证据|真实场景、操作过程和使用反馈', '转化承接|购买链接、优惠机制和评论区问答'], '定位建议', 'inference'),
    pptSection('先找有真实使用任务的人，再看粉丝规模', 'audience', 'audience-scene', ['核心受众|与' + product + '使用场景高度相关的人群', '专家型创作者|负责原理、边界与可信解释', '场景型创作者|负责真实使用任务和生活表达', '评测型创作者|负责对比、搜索沉淀与购买决策'], '受众与使用场景', 'inference', '使用目标市场中的真实家庭、工作或生活场景；人物与产品任务应自然发生。'),
    pptSection('一次内容完成从问题到行动的完整解释', 'sequence', 'sequence', ['01 真实问题|从用户会遇到的任务或风险开始', '02 产品价值|解释产品解决什么问题', '03 使用演示|按确认资料展示操作与边界', '04 结果证据|呈现体验、对比或状态变化', '05 行动入口|给出清楚 CTA 与购买链路'], '传播主线', 'inference'),
    pptSection('内容先分清可说、待确认和禁止三条边界', 'boundaries', 'boundary-columns', ['可说|客户书面确认的功能、认证、价格与渠道', '待确认|尚未发布的参数、服务承诺和上市信息', '禁止|竞品参数移植、危险测试、保证性效果承诺'], 'Claims architecture', 'pending'),
    pptSection('每个平台承担不同的说服任务', 'platform', 'platform-roles', ['YouTube|深度解释、搜索沉淀和购买前决策', 'Instagram|视觉化场景、生活方式和多触点复访', 'TikTok|快速测试钩子和单一问题短内容', '本次平台范围|' + platforms], '平台分工', 'inference'),
    pptSection('按说服任务配人，不按粉丝量堆人', 'creator_mix', 'creator-mix', ['权威解释型|解决可信度与专业问题', '场景体验型|把产品放进真实任务', '评测搜索型|承接竞品和购买前搜索', '短视频测试型|快速验证钩子与表达'], '达人组合', 'inference'),
    pptSection('100分模型选人，风险项一票否决', 'scoring', 'scorecard', ['受众与市场匹配|25', '近10条同形式内容表现|25', '内容解释与演示能力|20', '评论质量与商业内容折损|15', '报价、授权和档期可执行性|15', '一票否决|假量、受众错位、竞品冲突、危险表达'], '筛选标准', 'inference'),
    pptSection('内容系统覆盖理解、使用与购买', 'content_system', 'content-system', ['问题解释|为什么值得关注', '真实场景|何时、何地、谁会使用', '正确使用|展示流程和边界', '对比判断|只比较可核实的差异', '家庭或团队响应|说明使用后的行动', '购买承接|价格、渠道和 CTA 以正式信息为准'], '内容母题', 'inference'),
    pptSection('首批创意从一次真实使用任务开始', 'creative', 'creative-split', ['创意母题|把产品放进目标受众本来就会做的任务', '开场钩子|先提出具体问题，不先念品牌卖点', '内容证据|操作过程、场景细节和真实反馈', 'CTA|引导查看正式产品信息或购买页面'], '创意方向 01', 'inference', '使用一张能看到人物、环境和产品任务关系的真实场景图。'),
    pptSection('第二组创意负责高意向搜索与对比', 'creative', 'creative-split', ['搜索问题|围绕用户购买前最常问的问题', '比较边界|只使用已确认、同口径信息', '达人角色|选择能讲清原理和使用差异的人', '资产价值|沉淀 FAQ、评论语料和可复用片段'], '创意方向 02', 'inference'),
    pptSection('长视频负责把产品和购买理由讲清楚', 'format', 'format-storyboard', ['0-15秒|真实问题与观看理由', '15-90秒|场景、用户和产品任务', '核心段落|操作演示、边界与证据', '结尾|结论、适用人群、CTA和披露'], 'YouTube / 长视频格式', 'inference'),
    pptSection('短视频每条只解决一个问题', 'format', 'format-storyboard', ['0-3秒|一个具体问题或反常识画面', '3-12秒|展示场景和产品动作', '12-30秒|解释结果或关键差异', '结尾|一句结论、CTA和合作披露'], 'Reels / TikTok / Shorts', 'inference'),
    pptSection('高风险品类先过事实、演示与披露', 'compliance', 'dark-guardrail', ['Claims Matrix|每项卖点对应客户证据和可用表达', '说明书校验|安装、使用与限制必须与正式资料一致', '危险测试|禁止自行制造风险或不安全演示', 'FTC披露|口头、画面和描述区按要求披露合作关系', '授权与合同|明确修改、保留、剪辑、白名单和地域'], '内容审核与安全红线', 'pending'),
    pptSection('排期并行推进，关键门槛前不进入下一阶段', 'timeline', 'timeline', ['启动|第1周|Product Fact Sheet、目标与审核口径确认|项目启动表', '筛选|第1-2周|达人池、报价与风险核验|推荐名单', '制作|第2-4周|寄样、脚本、拍摄与修改|脚本和样片', '上线|第4-6周|发布、监测与评论承接|上线链接和周报', '复盘|D+7 / D+30|数据回收与下一轮建议|复盘报告'], '执行 Roadmap', 'inference'),
    pptSection('一次项目留下达人、内容与数据三类资产', 'measurement', 'asset-pillars', ['达人资产|报价、受众、履约和历史表现', '内容资产|钩子、脚本、授权素材和 FAQ', '数据资产|曝光、互动、点击、转化和成本口径', '复盘节奏|24小时、7天、30天按项目目标回收'], '数据与资产沉淀', 'inference'),
    pptSection('项目制承担主计划，单采只做可比测试', 'commercial', 'comparison-table', ['项目制|策略、达人组合、议价、审核、替补、归因和复盘', '单采|指定达人、单一交付物和明确边界', '同口径比较|统一达人条件、交付物、授权周期和税费口径', '预算|' + budget + '，具体拆分待报价和客户确认'], '商务模式', 'pending'),
    pptSection('图灵的价值体现在执行证据与响应机制', 'capability', 'capability-proof', ['需求转译|把产品资料转成达人筛选、脚本和审核标准', '项目执行|名单、合同、寄样、内容审核和上线盯控', '数据复盘|统一回收链接、指标、评论和素材资产', '团队资料|只使用客户可核验的公司、团队与案例信息'], 'Why TuringMarket', 'confirmed'),
    pptSection('收到关键资料即可启动建联与排期', 'next', 'next-steps', ['Product Fact Sheet|功能、认证、安装和禁用表达', '量产与样品|数量、时间、寄送区域和库存', '价格与购买链路|零售价、套装、渠道、链接和优惠', '审核节奏|品牌负责人、法务/合规、反馈时限', '启动动作|确认后进入达人长名单与首轮报价'], '下一步', 'pending')
  ];
  return {
    title: brand + ' ' + product + ' 海外红人营销方案',
    subtitle: market + ' 客户决策版 / ' + budget,
    narrative: '先建立产品理解与信任，再推动购买。',
    brand,
    product,
    sections,
    research
  };
}

async function generatePptOutline(db, user, body, opts) {
  body = body && typeof body === 'object' ? body : {};
  opts = opts || {};
  const demand = body.demand || {};
  const proposal = [body.proposal || '', body.deckContext || ''].filter(Boolean).join('\n\n');
  const query = [demand.brand, demand.company, demand.product, demand.product_name, demand.target_market, demand.market, 'influencer marketing'].filter(Boolean).join(' ');
  const campaignId = Number(opts.campaignId);
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
      knowledgeContext: 'Use the Campaign knowledge base first when it is relevant and preserve system [KB-n] citation labels.',
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
      visibility: 'private',
      archiveSummary: false,
      atomicOneShot: true,
      knowledgeLimit: 8,
      temperature: 0.25,
      max_tokens: 5200,
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
  const ragContext = rag.buildRagContext(db, {
    user,
    organizationId: opts.organizationId,
    query: [query, proposal].filter(Boolean).join('\n\n'),
    limit: body.knowledge_limit || 8,
    business_type: body.business_type || ''
  });
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
    max_tokens: 5200,
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
  out.title = out.title || (fallback && fallback.title) || '海外红人营销方案';
  out.subtitle = out.subtitle || (fallback && fallback.subtitle) || '';
  out.narrative = out.narrative || (fallback && fallback.narrative) || '';
  out.brand = out.brand || (fallback && fallback.brand) || '';
  out.product = out.product || (fallback && fallback.product) || '';
  out.sections = Array.isArray(out.sections) ? out.sections : (fallback && fallback.sections) || [];
  out.sections = out.sections.map(function(sec, index) {
    return {
      title: sec.title || ('Slide ' + (index + 1)),
      type: sec.type || 'content',
      layout: sec.layout || sec.type || 'content',
      points: Array.isArray(sec.points) ? sec.points.map(String) : String(sec.points || '').split(/\n|;|；/).filter(Boolean),
      note: sec.note || '',
      kicker: sec.kicker || '',
      visual_brief: sec.visual_brief || '',
      evidence_labels: Array.isArray(sec.evidence_labels) ? sec.evidence_labels.map(String).filter(Boolean) : [],
      status: ['confirmed', 'inference', 'pending'].includes(sec.status) ? sec.status : 'inference'
    };
  }).filter(function(sec) { return sec.title; });
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
  buildPptOutlineFallback,
  normalizePptOutline,
  generatePptOutline,
  similarKnowledge
};

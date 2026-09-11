'use strict';

const crypto = require('node:crypto');
const { getCampaignAccess: defaultGetCampaignAccess } = require('./campaign_access_service');
const idempotency = require('./idempotency_service');
const knowledge = require('./knowledge_service');
const { requestHash } = require('./sqlite_digest_service');

const DRAFT_CONTRACT_VERSION = 'performance-content-analysis-draft-v1';
const APPROVAL_CONTRACT_VERSION = 'performance-content-analysis-approval-v1';
const PROTOCOL_VERSION = 1;
const ACQUISITION_MODES = new Set([
  'client_supplied',
  'creator_supplied'
]);
const EVIDENCE_FIELDS = Object.freeze({
  caption: Object.freeze({ suffix: 'CAPTION', label: '视频文案', maxLength: 4000 }),
  cta_notes: Object.freeze({ suffix: 'CTA', label: 'CTA 观察', maxLength: 2000 }),
  hook_notes: Object.freeze({ suffix: 'HOOK', label: '开场钩子观察', maxLength: 2000 }),
  style_notes: Object.freeze({ suffix: 'STYLE', label: '风格观察', maxLength: 2000 }),
  transcript: Object.freeze({ suffix: 'TRANSCRIPT', label: '字幕或口播稿', maxLength: 12000 }),
  visual_notes: Object.freeze({ suffix: 'VISUAL', label: '画面观察', maxLength: 3000 })
});
const BODY_KEYS = Object.freeze([
  'acquisition_mode',
  'caption',
  'content_id',
  'cta_notes',
  'hook_notes',
  'rights_basis',
  'rights_confirmed',
  'style_notes',
  'transcript',
  'visual_notes'
]);
const CONFIDENCE_VALUES = new Set(['low', 'medium', 'high']);
const FINDING_DIMENSIONS = new Set(['content', 'cta', 'hook', 'structure', 'style', 'visual']);
const ACTION_PRIORITIES = new Set(['low', 'medium', 'high']);
const EXPECTED_KPIS = new Set([
  'views', 'likes', 'comments', 'saves', 'shares', 'core_view_er',
  'clicks', 'ctr', 'conversions', 'cvr', 'orders', 'revenue', 'roi', 'roas'
]);

class PerformanceContentAnalysisServiceError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'PerformanceContentAnalysisServiceError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function serviceError(statusCode, code, message, details) {
  return new PerformanceContentAnalysisServiceError(statusCode, code, message, details);
}

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return null;
    const result = {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

function positiveId(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && String(parsed) === value) return parsed;
  }
  return null;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function exactKeys(value, expected) {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected.slice().sort());
}

function boundedText(value, field, maxLength, required) {
  if (value === undefined || value === null || value === '') {
    if (!required) return '';
    throw serviceError(400, 'PERFORMANCE_CONTENT_ANALYSIS_INPUT_INVALID', `${field} is required.`, { field });
  }
  if (typeof value !== 'string' || value.includes('\u0000')) {
    throw serviceError(400, 'PERFORMANCE_CONTENT_ANALYSIS_INPUT_INVALID', `${field} must be text.`, { field });
  }
  const text = value.replace(/\r\n?/g, '\n').trim();
  if ((required && !text) || text.length > maxLength) {
    throw serviceError(400, 'PERFORMANCE_CONTENT_ANALYSIS_INPUT_INVALID', `${field} is invalid.`, { field });
  }
  return text;
}

function normalizeDraftInput(value) {
  const source = plainObject(value);
  if (!source) {
    throw serviceError(400, 'PERFORMANCE_CONTENT_ANALYSIS_INPUT_INVALID', 'Request body must be a JSON object.');
  }
  const unsupported = Object.keys(source).find((key) => !BODY_KEYS.includes(key));
  if (unsupported) {
    throw serviceError(400, 'PERFORMANCE_CONTENT_ANALYSIS_INPUT_INVALID', 'Request contains an unsupported field.', {
      field: unsupported
    });
  }
  const contentId = positiveId(source.content_id);
  if (contentId === null) {
    throw serviceError(400, 'PERFORMANCE_CONTENT_ANALYSIS_INPUT_INVALID', 'content_id is invalid.', {
      field: 'content_id'
    });
  }
  if (!ACQUISITION_MODES.has(source.acquisition_mode)) {
    throw serviceError(400, 'PERFORMANCE_CONTENT_ANALYSIS_INPUT_INVALID', 'acquisition_mode is invalid.', {
      field: 'acquisition_mode'
    });
  }
  if (source.rights_confirmed !== true) {
    throw serviceError(
      400,
      'PERFORMANCE_CONTENT_ANALYSIS_RIGHTS_REQUIRED',
      'Rights confirmation is required before content evidence can be analyzed.',
      { field: 'rights_confirmed' }
    );
  }
  const rightsBasis = boundedText(source.rights_basis, 'rights_basis', 500, true);
  const evidence = {};
  let totalLength = 0;
  for (const field of Object.keys(EVIDENCE_FIELDS)) {
    const text = boundedText(source[field], field, EVIDENCE_FIELDS[field].maxLength, false);
    if (!text) continue;
    evidence[field] = text;
    totalLength += text.length;
  }
  if (!Object.keys(evidence).length) {
    throw serviceError(
      400,
      'PERFORMANCE_CONTENT_ANALYSIS_EVIDENCE_REQUIRED',
      'At least one authorized text evidence field is required.'
    );
  }
  if (totalLength > 20000) {
    throw serviceError(413, 'PERFORMANCE_CONTENT_ANALYSIS_EVIDENCE_TOO_LARGE', 'Content evidence is too large.');
  }
  return {
    contentId,
    acquisitionMode: source.acquisition_mode,
    rightsBasis,
    evidence
  };
}

function evidenceReferences(request) {
  return Object.keys(request.evidence).sort().map((type) => ({
    id: `CONTENT-${request.contentId}-${EVIDENCE_FIELDS[type].suffix}`,
    type,
    label: EVIDENCE_FIELDS[type].label,
    character_count: request.evidence[type].length
  }));
}

function evidenceProjection(request, references) {
  const fields = {};
  for (const type of Object.keys(request.evidence).sort()) fields[type] = request.evidence[type];
  return {
    evidence_hash: sha256(canonicalJson({
      contract_version: DRAFT_CONTRACT_VERSION,
      content_id: request.contentId,
      acquisition_mode: request.acquisitionMode,
      rights_basis: request.rightsBasis,
      fields
    })),
    acquisition_mode: request.acquisitionMode,
    rights_basis: request.rightsBasis,
    rights_confirmed: true,
    raw_storage: 'not_retained',
    types: references.map((reference) => reference.type),
    character_counts: Object.fromEntries(references.map((reference) => [reference.type, reference.character_count])),
    references
  };
}

function publicMetricValue(metric) {
  const source = metric && typeof metric === 'object' ? metric : {};
  return {
    available: source.available === true,
    value: Number.isFinite(source.value) ? source.value : null,
    unit: typeof source.unit === 'string' ? source.unit : null,
    definition_version: typeof source.definitionVersion === 'string' ? source.definitionVersion : null,
    component_signature: typeof source.componentSignature === 'string' ? source.componentSignature : null,
    denominator_basis: typeof source.denominatorBasis === 'string' ? source.denominatorBasis : null
  };
}

function contextProjection(content) {
  const observation = content && content.latest_observation && typeof content.latest_observation === 'object'
    ? content.latest_observation
    : {};
  const metrics = content && content.metrics && typeof content.metrics === 'object' ? content.metrics : {};
  const observed = {};
  for (const key of ['views', 'impressions', 'likes', 'comments', 'saves', 'shares', 'clicks', 'conversions']) {
    observed[key] = Number.isFinite(observation[key]) ? observation[key] : null;
  }
  return {
    content: {
      id: positiveId(content && content.id),
      canonical_identity: typeof content.canonical_identity === 'string' ? content.canonical_identity : null,
      platform_content_id: typeof content.platform_content_id === 'string' ? content.platform_content_id : null,
      publication_version: positiveId(content && content.publication_version),
      source_mode: typeof content.source_mode === 'string' ? content.source_mode : null,
      platform: typeof content.platform === 'string' ? content.platform : null,
      creator_name: typeof content.creator_name === 'string' ? content.creator_name : null,
      creator_id: typeof content.creator_id === 'string' ? content.creator_id : null,
      product: typeof content.product === 'string' ? content.product : null,
      tags: Array.isArray(content.tags) ? content.tags.filter((tag) => typeof tag === 'string').slice(0, 30) : []
    },
    latest_observation: {
      id: positiveId(observation.id),
      observed_at: typeof observation.observed_at === 'string' ? observation.observed_at : null,
      source_mode: typeof observation.source_mode === 'string' ? observation.source_mode : null,
      storage_source: typeof observation.provider === 'string' && observation.provider ? 'provider' : 'manual',
      provider: typeof observation.provider === 'string' ? observation.provider : null,
      metrics: observed
    },
    derived_metrics: {
      core_view_er: publicMetricValue(metrics.core_view_er),
      extended_view_er: publicMetricValue(metrics.extended_view_er),
      ctr: publicMetricValue(metrics.ctr),
      cvr: publicMetricValue(metrics.cvr)
    }
  };
}

function providerRunId(db, campaignId, contentId, observation) {
  if (!observation || observation.storage_source !== 'provider' || positiveId(observation.id) === null) return null;
  const available = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='performance_provider_observations'").get();
  if (!available) return null;
  const row = db.prepare(`
    SELECT run_id FROM performance_provider_observations
    WHERE id=? AND campaign_id=? AND publication_id=?
    LIMIT 1
  `).get(observation.id, campaignId, contentId);
  return positiveId(row && row.run_id);
}

function performanceReference(db, campaignId, projection) {
  const content = projection && projection.content || {};
  const observation = projection && projection.latest_observation || {};
  const contentId = positiveId(content.id);
  const observationId = positiveId(observation.id);
  if (contentId === null || observationId === null || !observation.observed_at) {
    throw serviceError(
      409,
      'PERFORMANCE_CONTENT_ANALYSIS_METRICS_REQUIRED',
      'A current performance observation is required before content analysis.'
    );
  }
  const metricSignature = sha256(canonicalJson({
    observed_metrics: observation.metrics,
    derived_metrics: projection.derived_metrics
  }));
  return Object.freeze({
    id: `PERF-${contentId}-OBS-${observationId}`,
    type: 'performance_snapshot',
    label: '当前效果指标快照',
    publication_id: contentId,
    canonical_identity: content.canonical_identity,
    publication_version: content.publication_version,
    observation_id: observationId,
    storage_source: observation.storage_source,
    source_mode: observation.source_mode,
    provider: observation.provider,
    provider_run_id: providerRunId(db, campaignId, contentId, observation),
    observed_at: observation.observed_at,
    metric_signature: metricSignature
  });
}

function contentSnapshot(db, performanceService, user, campaignId, contentId) {
  let snapshot;
  try {
    snapshot = performanceService.getProjectionSnapshot({ userId: user.id, campaignId });
  } catch (error) {
    if (error && Number.isSafeInteger(error.statusCode)) throw error;
    throw serviceError(500, 'PERFORMANCE_CONTENT_ANALYSIS_CONTEXT_FAILED', 'Content context could not be prepared.');
  }
  const content = snapshot && Array.isArray(snapshot.items)
    ? snapshot.items.find((item) => positiveId(item && item.id) === contentId)
    : null;
  if (!content) {
    throw serviceError(404, 'PERFORMANCE_CONTENT_ANALYSIS_CONTENT_NOT_FOUND', 'Campaign content was not found.');
  }
  const projection = contextProjection(content);
  const performance = performanceReference(db, campaignId, projection);
  return {
    content,
    projection,
    performance,
    hash: sha256(canonicalJson({ projection, performance })),
    capabilities: snapshot.capabilities || {}
  };
}

function evidenceBlocks(request, references) {
  return references.map((reference) => [
    `[${reference.id}]`,
    `证据类型：${reference.label}`,
    request.evidence[reference.type]
  ].join('\n')).join('\n\n');
}

function analysisPrompt(request, references, performance, context) {
  const exampleContentId = references[0].id;
  const exampleDimension = {
    caption: 'content',
    cta_notes: 'cta',
    hook_notes: 'hook',
    style_notes: 'style',
    transcript: 'structure',
    visual_notes: 'visual'
  }[references[0].type];
  return [
    '你是海外红人营销项目的内容复盘分析员。',
    '仅使用下方结构化项目上下文和编号证据。不得联网，不得补充未提供的视频、画面、音频、转化或因果信息。',
    '只有 HOOK 证据可支撑 hook 判断；VISUAL 可支撑 visual；STYLE 或 VISUAL 可支撑 style；TRANSCRIPT 可支撑 structure/content；CAPTION 可支撑 content/cta；CTA 可支撑 cta。',
    `每条结论和建议必须同时引用至少一个 CONTENT 证据和效果快照 [${performance.id}]。`,
    '将所有判断表述为“有证据支持的假设”，不得声称已证明因果。不得大段复制或直接引用原始证据。',
    '只输出一个合法 JSON 对象，不得输出 Markdown 或额外字段。',
    '结构必须精确为：',
    `{"contract_version":1,"findings":[{"dimension":"${exampleDimension}","conclusion":"...","evidence_ids":["${exampleContentId}","${performance.id}"],"confidence":"medium"}],"reuse":[{"recommendation":"...","evidence_ids":["${exampleContentId}","${performance.id}"],"confidence":"medium"}],"test":[{"recommendation":"...","evidence_ids":["${exampleContentId}","${performance.id}"],"confidence":"low"}],"avoid":[{"recommendation":"...","evidence_ids":["${exampleContentId}","${performance.id}"],"confidence":"medium"}],"actions":[{"recommendation":"...","priority":"high","expected_kpi":"core_view_er","evidence_ids":["${exampleContentId}","${performance.id}"]}],"caveats":["..."],"human_confirmation":"required"}`,
    '每个数组 1-8 项；证据 ID 必须来自下方编号；confidence 只能为 low/medium/high；priority 只能为 low/medium/high。',
    '',
    '项目内容上下文：',
    `[${performance.id}]`,
    `效果快照来源：${JSON.stringify(performance)}`,
    JSON.stringify(context),
    '',
    '授权文本证据：',
    evidenceBlocks(request, references)
  ].join('\n');
}

function parseProtocol(answer) {
  if (typeof answer !== 'string' || !answer.trim() || answer.length > 16000) return null;
  try {
    return plainObject(JSON.parse(answer));
  } catch {
    return null;
  }
}

function safeOutputText(value, maxLength) {
  if (typeof value !== 'string' || value.includes('\u0000')) return null;
  const text = value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text || text.length > maxLength || /[<>]/.test(text)) return null;
  return text;
}

function uniqueEvidenceIds(value, knownIds, limit) {
  if (!Array.isArray(value) || !value.length || value.length > limit) return null;
  const ids = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== 'string' || !knownIds.has(item) || seen.has(item)) return null;
    seen.add(item);
    ids.push(item);
  }
  return ids;
}

function allowedEvidenceForDimension(dimension, references) {
  const allowedTypes = {
    content: new Set(['caption', 'transcript']),
    cta: new Set(['caption', 'cta_notes', 'transcript']),
    hook: new Set(['hook_notes']),
    structure: new Set(['transcript']),
    style: new Set(['style_notes', 'visual_notes']),
    visual: new Set(['visual_notes'])
  }[dimension] || new Set();
  return new Set(references.filter((reference) => allowedTypes.has(reference.type)).map((reference) => reference.id));
}

function hasDualEvidence(ids, allowedContentIds, performanceId) {
  return ids.includes(performanceId) && ids.some((id) => allowedContentIds.has(id));
}

function protocolItems(value, options) {
  if (!Array.isArray(value) || !value.length || value.length > 8) return null;
  const output = [];
  for (const item of value) {
    const source = plainObject(item);
    if (!source || !exactKeys(source, options.keys)) return null;
    const text = safeOutputText(source[options.textField], options.maxLength || 500);
    const confidence = options.confidence ? source.confidence : null;
    const evidenceIds = uniqueEvidenceIds(source.evidence_ids, options.knownIds, 4);
    if (!text || !evidenceIds || (options.confidence && !CONFIDENCE_VALUES.has(confidence))) return null;
    const normalized = Object.assign({}, source, {
      [options.textField]: text,
      evidence_ids: evidenceIds
    });
    if (options.confidence) normalized.confidence = confidence;
    output.push(normalized);
  }
  return output;
}

function evidenceTextLeakDetected(value, request) {
  const output = String(value || '').replace(/\s+/g, '');
  const outputScalars = Array.from(output);
  const windowsByLength = new Map();
  const outputWindows = (length) => {
    if (windowsByLength.has(length)) return windowsByLength.get(length);
    const windows = new Set();
    for (let index = 0; index + length <= outputScalars.length; index += 1) {
      windows.add(outputScalars.slice(index, index + length).join(''));
    }
    windowsByLength.set(length, windows);
    return windows;
  };
  for (const value of Object.values(request.evidence)) {
    const compact = Array.from(value.replace(/\s+/g, ''));
    if (compact.length < 16) continue;
    const windowLength = Math.min(24, compact.length);
    const candidateWindows = outputWindows(windowLength);
    for (let index = 0; index + windowLength <= compact.length; index += 1) {
      const sample = compact.slice(index, index + windowLength).join('');
      if (candidateWindows.has(sample)) return true;
    }
  }
  return false;
}

function evidenceLeakDetected(protocol, request) {
  return evidenceTextLeakDetected(canonicalJson(protocol), request);
}

function validateProtocol(answer, request, references, performance) {
  const protocol = parseProtocol(answer);
  const failure = (code) => ({ valid: false, code, protocol: null, citation_ids: [] });
  const expectedKeys = [
    'actions', 'avoid', 'caveats', 'contract_version', 'findings',
    'human_confirmation', 'reuse', 'test'
  ];
  if (!protocol || !exactKeys(protocol, expectedKeys) || protocol.contract_version !== PROTOCOL_VERSION || protocol.human_confirmation !== 'required') {
    return failure('protocol_shape_invalid');
  }
  const performanceId = performance.id;
  const allReferences = references.concat([performance]);
  const knownIds = new Set(allReferences.map((reference) => reference.id));
  const findings = protocolItems(protocol.findings, {
    keys: ['confidence', 'conclusion', 'dimension', 'evidence_ids'],
    textField: 'conclusion',
    confidence: true,
    knownIds
  });
  if (!findings) return failure('findings_invalid');
  for (const finding of findings) {
    if (!FINDING_DIMENSIONS.has(finding.dimension)) return failure('finding_dimension_invalid');
    const allowed = allowedEvidenceForDimension(finding.dimension, references);
    const allowedWithPerformance = new Set([...allowed, performanceId]);
    if (
      !allowed.size ||
      !hasDualEvidence(finding.evidence_ids, allowed, performanceId) ||
      finding.evidence_ids.some((id) => !allowedWithPerformance.has(id))
    ) {
      return failure('finding_evidence_mismatch');
    }
  }
  const recommendationOptions = {
    keys: ['confidence', 'evidence_ids', 'recommendation'],
    textField: 'recommendation',
    confidence: true,
    knownIds
  };
  const reuse = protocolItems(protocol.reuse, recommendationOptions);
  const tests = protocolItems(protocol.test, recommendationOptions);
  const avoid = protocolItems(protocol.avoid, recommendationOptions);
  if (!reuse || !tests || !avoid) return failure('recommendations_invalid');
  const contentIds = new Set(references.map((reference) => reference.id));
  if ([...reuse, ...tests, ...avoid].some((item) => (
    !hasDualEvidence(item.evidence_ids, contentIds, performanceId)
  ))) return failure('recommendation_evidence_mismatch');
  const actions = protocolItems(protocol.actions, {
    keys: ['evidence_ids', 'expected_kpi', 'priority', 'recommendation'],
    textField: 'recommendation',
    confidence: false,
    knownIds
  });
  if (!actions || actions.some((action) => (
    !ACTION_PRIORITIES.has(action.priority) ||
    !EXPECTED_KPIS.has(action.expected_kpi) ||
    !hasDualEvidence(action.evidence_ids, contentIds, performanceId)
  ))) return failure('actions_invalid');
  if (!Array.isArray(protocol.caveats) || !protocol.caveats.length || protocol.caveats.length > 8) {
    return failure('caveats_invalid');
  }
  const caveats = protocol.caveats.map((item) => safeOutputText(item, 500));
  if (caveats.some((item) => !item)) return failure('caveats_invalid');
  const normalized = {
    contract_version: PROTOCOL_VERSION,
    findings,
    reuse,
    test: tests,
    avoid,
    actions,
    caveats,
    human_confirmation: 'required'
  };
  if (evidenceLeakDetected(normalized, request)) return failure('verbatim_evidence_detected');
  const citationIds = [...new Set([
    ...findings.flatMap((item) => item.evidence_ids),
    ...reuse.flatMap((item) => item.evidence_ids),
    ...tests.flatMap((item) => item.evidence_ids),
    ...avoid.flatMap((item) => item.evidence_ids),
    ...actions.flatMap((item) => item.evidence_ids)
  ])].sort();
  return { valid: true, code: null, protocol: normalized, citation_ids: citationIds };
}

function confidenceLabel(value) {
  return { low: '低', medium: '中', high: '高' }[value] || '未知';
}

function dimensionLabel(value) {
  return {
    content: '内容主题',
    cta: '行动号召',
    hook: '开场钩子',
    structure: '内容结构',
    style: '内容风格',
    visual: '画面表达'
  }[value] || value;
}

function evidenceSuffix(ids) {
  return ids.map((id) => `[${id}]`).join(' ');
}

function renderDraft(protocol, content) {
  const label = [content.creator_name, content.product, content.platform].filter(Boolean).join(' / ') || `内容 #${content.id}`;
  const lines = [
    `### 内容证据分析：${label}`,
    '',
    '#### 证据支持的假设'
  ];
  protocol.findings.forEach((finding) => {
    lines.push(`- **${dimensionLabel(finding.dimension)}（${confidenceLabel(finding.confidence)}置信）**：${finding.conclusion} ${evidenceSuffix(finding.evidence_ids)}`);
  });
  lines.push('', '#### 下轮可执行方法');
  for (const [labelName, items] of [['复用', protocol.reuse], ['测试', protocol.test], ['避免', protocol.avoid]]) {
    items.forEach((item) => {
      lines.push(`- **${labelName}（${confidenceLabel(item.confidence)}置信）**：${item.recommendation} ${evidenceSuffix(item.evidence_ids)}`);
    });
  }
  lines.push('', '#### 优化动作');
  protocol.actions.forEach((action) => {
    lines.push(`- **${action.priority.toUpperCase()} / ${action.expected_kpi}**：${action.recommendation} ${evidenceSuffix(action.evidence_ids)}`);
  });
  lines.push('', '#### 证据限制');
  protocol.caveats.forEach((caveat) => lines.push(`- ${caveat}`));
  lines.push('- 本结论仅基于已授权文本证据和当前指标快照，必须人工确认后才能进入知识库。');
  return lines.join('\n');
}

function aiProjection(ai) {
  return {
    conversation_id: positiveId(ai && ai.conversation_id),
    message_id: positiveId(ai && ai.message_id),
    model: ai && ai.model || null,
    usage: ai && ai.usage || {},
    latency_ms: ai && ai.latency_ms || null,
    knowledge_references: ai && ai.knowledge_references || [],
    web_search: ai && ai.web_search || { used: false }
  };
}

function generatedResult(input) {
  return {
    contract_version: DRAFT_CONTRACT_VERSION,
    status: 'generated',
    campaign_id: input.campaignId,
    content_id: input.contentId,
    evidence: Object.assign({}, input.evidenceProjection, {
      context_snapshot_hash: input.contextSnapshotHash,
      citation_ids: input.citationIds,
      performance_reference: input.performanceReference
    }),
    draft: input.draft,
    ai: aiProjection(input.ai)
  };
}

function replayEnvelope(value) {
  const source = plainObject(value && value.response_envelope) || plainObject(value);
  if (
    !source ||
    source.contract_version !== DRAFT_CONTRACT_VERSION ||
    source.status !== 'generated' ||
    positiveId(source.campaign_id) === null ||
    positiveId(source.content_id) === null ||
    typeof source.draft !== 'string' ||
    !source.draft.trim() ||
    source.draft.length > 24000
  ) return null;
  const evidence = plainObject(source.evidence);
  const performance = plainObject(evidence && evidence.performance_reference);
  const ai = plainObject(source.ai);
  if (
    !evidence ||
    !/^[a-f0-9]{64}$/.test(String(evidence.evidence_hash || '')) ||
    !/^[a-f0-9]{64}$/.test(String(evidence.context_snapshot_hash || '')) ||
    evidence.raw_storage !== 'not_retained' ||
    !ACQUISITION_MODES.has(evidence.acquisition_mode) ||
    !Array.isArray(evidence.types) ||
    !Array.isArray(evidence.references) ||
    !Array.isArray(evidence.citation_ids) ||
    !performance ||
    typeof performance.id !== 'string' ||
    !/^PERF-[1-9][0-9]{0,15}-OBS-[1-9][0-9]{0,15}$/.test(performance.id) ||
    positiveId(performance.observation_id) === null ||
    !['manual', 'provider'].includes(performance.storage_source) ||
    typeof performance.metric_signature !== 'string' ||
    !/^[a-f0-9]{64}$/.test(performance.metric_signature) ||
    !evidence.citation_ids.includes(performance.id) ||
    !ai ||
    positiveId(ai.conversation_id) === null ||
    positiveId(ai.message_id) === null ||
    ai.web_search && ai.web_search.used === true
  ) return null;
  return {
    contract_version: DRAFT_CONTRACT_VERSION,
    status: 'generated',
    campaign_id: Number(source.campaign_id),
    content_id: Number(source.content_id),
    evidence,
    draft: source.draft,
    ai
  };
}

function requestId(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= 200 && !normalized.includes('\u0000') ? normalized : null;
}

function idempotencyKey(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(key)) {
    throw serviceError(
      400,
      'PERFORMANCE_CONTENT_ANALYSIS_IDEMPOTENCY_INVALID',
      'A valid Idempotency-Key is required.'
    );
  }
  return key;
}

function approvalRequestHash(campaignId, approval) {
  return requestHash({
    method: 'POST',
    path: '/api/campaigns/:id/performance/content-analysis-draft/approve',
    campaignId,
    kind: 'json',
    payload: {
      conversation_id: approval.conversationId,
      message_id: approval.messageId,
      expected_evidence_hash: approval.evidenceHash,
      expected_context_snapshot_hash: approval.contextSnapshotHash,
      evidence: {
        content_id: approval.evidenceRequest.contentId,
        acquisition_mode: approval.evidenceRequest.acquisitionMode,
        rights_basis: approval.evidenceRequest.rightsBasis,
        rights_confirmed: true,
        fields: approval.evidenceRequest.evidence
      },
      edited_draft: approval.editedDraft,
      visibility: approval.visibility
    }
  });
}

function approvalIdempotencyDisposition(disposition) {
  if (!disposition || disposition.state === 'absent') return null;
  if (disposition.state === 'replay') {
    if (disposition.statusCode >= 200 && disposition.statusCode <= 299) {
      const body = plainObject(disposition.responseBody);
      if (body) return body;
      throw serviceError(500, 'PERFORMANCE_CONTENT_ANALYSIS_RESPONSE_INVALID', 'Stored approval response is invalid.');
    }
    const body = plainObject(disposition.responseBody) || {};
    throw serviceError(
      disposition.statusCode || 500,
      body.code || 'PERFORMANCE_CONTENT_ANALYSIS_APPROVAL_FAILED',
      body.error || 'Content analysis approval failed.'
    );
  }
  if (disposition.state === 'conflict') {
    throw serviceError(409, 'IDEMPOTENCY_KEY_REUSED', 'The idempotency key was already used for a different request.');
  }
  if (disposition.state === 'processing') {
    throw serviceError(409, 'IDEMPOTENCY_IN_PROGRESS', 'Content analysis approval is still processing.');
  }
  if (disposition.state === 'expired') {
    throw serviceError(410, 'IDEMPOTENCY_EXPIRED', 'The retained approval response expired.');
  }
  throw serviceError(500, 'PERFORMANCE_CONTENT_ANALYSIS_APPROVAL_FAILED', 'Approval idempotency state is invalid.');
}

function approvalInput(value) {
  const source = plainObject(value);
  const expectedKeys = [
    'conversation_id', 'edited_draft', 'evidence', 'expected_context_snapshot_hash',
    'expected_evidence_hash', 'message_id', 'visibility'
  ];
  if (!source || !exactKeys(source, expectedKeys)) {
    throw serviceError(400, 'PERFORMANCE_CONTENT_ANALYSIS_APPROVAL_INVALID', 'Approval input is invalid.');
  }
  const conversationId = positiveId(source.conversation_id);
  const messageId = positiveId(source.message_id);
  const evidenceHash = typeof source.expected_evidence_hash === 'string'
    ? source.expected_evidence_hash
    : '';
  const contextSnapshotHash = typeof source.expected_context_snapshot_hash === 'string'
    ? source.expected_context_snapshot_hash
    : '';
  if (
    conversationId === null ||
    messageId === null ||
    !/^[a-f0-9]{64}$/.test(evidenceHash) ||
    !/^[a-f0-9]{64}$/.test(contextSnapshotHash)
  ) {
    throw serviceError(400, 'PERFORMANCE_CONTENT_ANALYSIS_APPROVAL_INVALID', 'Approval lineage is invalid.');
  }
  const editedDraft = boundedText(source.edited_draft, 'edited_draft', 24000, true);
  const evidenceRequest = normalizeDraftInput(source.evidence);
  if (!['private', 'team'].includes(source.visibility)) {
    throw serviceError(400, 'PERFORMANCE_CONTENT_ANALYSIS_APPROVAL_INVALID', 'visibility must be private or team.');
  }
  return {
    conversationId,
    messageId,
    evidenceHash,
    contextSnapshotHash,
    evidenceRequest,
    editedDraft,
    visibility: source.visibility
  };
}

function lineHasUnsupportedPositiveClaim(line, tokens) {
  if (!tokens.some((token) => line.includes(token))) return false;
  return !/(?:未|不|无法|不能|没有|尚无|缺少|待验证|假设|可能|推测|仅供测试)/.test(line);
}

function validateEditedDraft(editedDraft, request, requiredCitations) {
  if (evidenceTextLeakDetected(editedDraft, request)) {
    throw serviceError(
      400,
      'PERFORMANCE_CONTENT_ANALYSIS_RAW_EVIDENCE_RETAINED',
      'Edited content analysis must summarize rather than retain raw evidence.'
    );
  }
  const allowedCitations = new Set(requiredCitations);
  const cited = String(editedDraft).match(/\[(?:CONTENT|PERF)-[^\]\r\n]{1,160}\]/g) || [];
  if (cited.some((value) => !allowedCitations.has(value.slice(1, -1)))) {
    throw serviceError(
      400,
      'PERFORMANCE_CONTENT_ANALYSIS_CITATION_REQUIRED',
      'Edited content analysis contains an unverified evidence citation.'
    );
  }
  const unsupportedAlways = [
    '联网资料', '公开资料显示', '评论区反馈', '观众反馈',
    'ROI', 'ROAS', 'CPM', 'CPC', '花费', '成本', '收入', '销量', '销售增长',
    '证明', '导致', '直接带来', '因此提升', '直接造成', '决定了'
  ];
  const evidenceTypes = new Set(Object.keys(request.evidence));
  const conditional = [];
  if (!evidenceTypes.has('hook_notes')) conditional.push('钩子', '前三秒', '开场');
  if (!evidenceTypes.has('visual_notes')) conditional.push('画面', '镜头', '视觉', '剪辑', '运镜', '色彩');
  if (!evidenceTypes.has('style_notes') && !evidenceTypes.has('visual_notes')) conditional.push('风格');
  for (const line of String(editedDraft).split(/\r?\n/)) {
    if (
      lineHasUnsupportedPositiveClaim(line, unsupportedAlways) ||
      lineHasUnsupportedPositiveClaim(line, conditional)
    ) {
      throw serviceError(
        400,
        'PERFORMANCE_CONTENT_ANALYSIS_UNSUPPORTED_CLAIM',
        'Edited content analysis contains a claim that is not supported by the submitted evidence.'
      );
    }
  }
}

function enforceQuota(db, user) {
  const quota = Number(user && user.api_quota || 0);
  if (!quota || (user && user.role === 'admin')) return;
  const row = db.prepare('SELECT COALESCE(SUM(total_tokens),0) AS total FROM token_usage WHERE user_id=?').get(user.id);
  if (Number(row && row.total || 0) >= quota) {
    throw serviceError(429, 'AI_QUOTA_EXCEEDED', 'AI quota exceeded.');
  }
}

function summaryText(value) {
  return Array.from(String(value || '').replace(/\s+/g, ' ').trim()).slice(0, 1000).join('');
}

function createPerformanceContentAnalysisService(db, options = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('A SQLite database is required.');
  const performanceService = options.performanceService;
  const aiService = options.aiService;
  const getCampaignAccess = options.getCampaignAccess || defaultGetCampaignAccess;
  if (!performanceService || typeof performanceService.getProjectionSnapshot !== 'function') {
    throw new TypeError('A performance projection service is required.');
  }
  if (!aiService || typeof aiService.handleChat !== 'function') {
    throw new TypeError('An AI chat service is required.');
  }

  function approvalAccess(user, campaignIdValue) {
    const userId = positiveId(user && user.id);
    const campaignId = positiveId(campaignIdValue);
    if (userId === null) {
      throw serviceError(401, 'PERFORMANCE_CONTENT_ANALYSIS_UNAUTHORIZED', 'An authenticated user is required.');
    }
    if (campaignId === null) {
      throw serviceError(400, 'PERFORMANCE_CONTENT_ANALYSIS_APPROVAL_INVALID', 'Campaign is invalid.');
    }
    const access = getCampaignAccess(db, { userId, campaignId });
    if (!access || access.ok !== true) {
      throw serviceError(
        access && Number.isSafeInteger(access.status) ? access.status : 403,
        access && access.code ? access.code : 'PERFORMANCE_CONTENT_ANALYSIS_FORBIDDEN',
        'Campaign access is forbidden.'
      );
    }
    const privileged = access.role === 'org_admin' || access.role === 'owner';
    if (!privileged || !access.permissions || access.permissions.write !== true) {
      throw serviceError(
        403,
        'PERFORMANCE_CONTENT_ANALYSIS_APPROVAL_FORBIDDEN',
        'Only a campaign owner or organization administrator can confirm content analysis.'
      );
    }
    return { userId, campaignId, access };
  }

  async function createDraft(input) {
    const user = input && input.user;
    if (!user || positiveId(user.id) === null) {
      throw serviceError(401, 'PERFORMANCE_CONTENT_ANALYSIS_UNAUTHORIZED', 'An authenticated user is required.');
    }
    const request = normalizeDraftInput(input && input.body);
    const campaignId = positiveId(input && input.campaignId);
    if (campaignId === null) {
      throw serviceError(400, 'PERFORMANCE_CONTENT_ANALYSIS_INPUT_INVALID', 'Campaign is invalid.');
    }
    approvalAccess(user, campaignId);
    const key = idempotencyKey(input && input.idempotencyKey);
    const snapshot = contentSnapshot(db, performanceService, user, campaignId, request.contentId);
    const references = evidenceReferences(request);
    const projectedEvidence = evidenceProjection(request, references);
    const persistedMessage = [
      `对活动 #${campaignId} 的内容 #${request.contentId} 执行授权证据分析。`,
      `证据哈希：${projectedEvidence.evidence_hash}。`,
      `上下文快照哈希：${snapshot.hash}。`,
      `采集方式：${request.acquisitionMode}。`,
      `证据类型：${projectedEvidence.types.join(', ')}。`,
      `效果快照：${snapshot.performance.id}。`,
      '原始证据仅用于本次模型请求，平台未保留。'
    ].join('\n');
    const guard = { validation: null, draft: '', current: null };
    let ai;
    try {
      ai = await aiService.handleChat(db, {
        user,
        campaign_id: campaignId,
        idempotencyKey: key,
        requestId: input && input.requestId,
        source_module: 'performance_content_analysis',
        message: persistedMessage,
        provider_user_message: analysisPrompt(request, references, snapshot.performance, snapshot.projection),
        ragQuery: `活动内容复盘方法 ${snapshot.content.platform || ''} ${snapshot.content.product || ''}`,
        entry_type: 'campaign_performance_review',
        quality_state: 'confirmed',
        business_type: 'campaign',
        business_id: String(campaignId),
        allowWeb: false,
        archiveSummary: false,
        summaryVisibility: 'private',
        knowledgeLimit: 5,
        max_tokens: 1800,
        beforeProvider() {
          enforceQuota(db, user);
        },
        validateCompletion(answer) {
          guard.validation = validateProtocol(answer, request, references, snapshot.performance);
          if (!guard.validation.valid) return false;
          guard.draft = renderDraft(guard.validation.protocol, snapshot.content);
          return Boolean(guard.draft && guard.draft.length <= 24000);
        },
        transformCompletion() {
          return guard.draft;
        },
        validateBeforePersist() {
          try {
            guard.current = contentSnapshot(db, performanceService, user, campaignId, request.contentId);
            return guard.current.hash === snapshot.hash;
          } catch {
            return false;
          }
        },
        createResponseEnvelope(aiResponse) {
          return generatedResult({
            campaignId,
            contentId: request.contentId,
            evidenceProjection: projectedEvidence,
            contextSnapshotHash: snapshot.hash,
            citationIds: guard.validation.citation_ids,
            performanceReference: snapshot.performance,
            draft: guard.draft,
            ai: aiResponse
          });
        }
      });
    } catch (error) {
      if (error instanceof PerformanceContentAnalysisServiceError) throw error;
      if (error && error.name === 'AIServiceError' && Number.isSafeInteger(error.statusCode)) {
        throw serviceError(
          error.statusCode,
          error.code === 'IDEMPOTENCY_KEY_REUSED' ? error.code : 'PERFORMANCE_CONTENT_ANALYSIS_UNAVAILABLE',
          error.code === 'IDEMPOTENCY_KEY_REUSED'
            ? error.message
            : 'Content analysis could not be generated safely.'
        );
      }
      throw error;
    }
    const result = replayEnvelope(ai);
    if (!result) {
      throw serviceError(500, 'PERFORMANCE_CONTENT_ANALYSIS_RESPONSE_INVALID', 'Stored content analysis output is invalid.');
    }
    return result;
  }

  function storedDraft(access, request) {
    const conversation = db.prepare(`
      SELECT conversation.id,conversation.source_module,conversation.user_id
      FROM ai_conversations conversation
      JOIN campaign_record_links link
        ON link.record_type='ai_conversation'
       AND link.record_id=CAST(conversation.id AS TEXT)
       AND link.relation_type='ai_run'
       AND link.revoked_at IS NULL
      WHERE conversation.id=? AND link.org_id=? AND link.campaign_id=?
      LIMIT 1
    `).get(request.conversationId, access.campaign.org_id, access.campaign.id);
    if (!conversation || conversation.source_module !== 'performance_content_analysis') {
      throw serviceError(404, 'PERFORMANCE_CONTENT_ANALYSIS_DRAFT_NOT_FOUND', 'Content analysis draft was not found.');
    }
    const message = db.prepare(`
      SELECT id,conversation_id,role,content FROM ai_messages
      WHERE id=? AND conversation_id=? AND role='assistant' LIMIT 1
    `).get(request.messageId, request.conversationId);
    if (!message || typeof message.content !== 'string' || !message.content) {
      throw serviceError(404, 'PERFORMANCE_CONTENT_ANALYSIS_DRAFT_NOT_FOUND', 'Content analysis draft was not found.');
    }
    const retained = db.prepare(`
      SELECT response_json FROM request_idempotency
      WHERE org_id=? AND campaign_id=?
        AND scope='ai.conversation.create.linked'
        AND state='completed' AND response_kind='json' AND response_json IS NOT NULL
      ORDER BY id DESC
    `).all(access.campaign.org_id, access.campaign.id);
    for (const row of retained) {
      let parsed;
      try {
        parsed = JSON.parse(row.response_json);
      } catch {
        continue;
      }
      const generated = replayEnvelope(parsed);
      if (
        !generated ||
        generated.campaign_id !== access.campaign.id ||
        generated.ai.conversation_id !== request.conversationId ||
        generated.ai.message_id !== request.messageId
      ) continue;
      if (generated.draft !== message.content) {
        throw serviceError(409, 'PERFORMANCE_CONTENT_ANALYSIS_SOURCE_INVALID', 'Stored content analysis draft was changed.');
      }
      return { generated, message, draftSha256: sha256(generated.draft) };
    }
    throw serviceError(409, 'PERFORMANCE_CONTENT_ANALYSIS_SOURCE_INVALID', 'Stored content analysis evidence is unavailable.');
  }

  function existingConfirmation(entry, state) {
    let metadata;
    try {
      metadata = JSON.parse(entry && entry.metadata_json || 'null');
    } catch {
      return false;
    }
    return Boolean(
      entry &&
      entry.content === state.approval.editedDraft &&
      entry.visibility === state.approval.visibility &&
      metadata && metadata.source_ai && metadata.evidence && metadata.confirmation &&
      metadata.source_ai.conversation_id === state.approval.conversationId &&
      metadata.source_ai.message_id === state.approval.messageId &&
      metadata.evidence.evidence_hash === state.source.generated.evidence.evidence_hash &&
      metadata.confirmation.final_content_sha256 === state.finalContentSha256
    );
  }

  function approvalMetadata(state) {
    const evidence = state.source.generated.evidence;
    return {
      schema_version: 1,
      source_ai: {
        conversation_id: state.approval.conversationId,
        message_id: state.approval.messageId,
        draft_sha256: state.source.draftSha256,
        draft_contract_version: state.source.generated.contract_version
      },
      evidence: {
        content_id: state.source.generated.content_id,
        evidence_hash: evidence.evidence_hash,
        context_snapshot_hash: evidence.context_snapshot_hash,
        acquisition_mode: evidence.acquisition_mode,
        rights_basis: evidence.rights_basis,
        rights_confirmed: true,
        raw_storage: 'not_retained',
        types: evidence.types,
        character_counts: evidence.character_counts,
        citation_ids: evidence.citation_ids,
        performance_reference: evidence.performance_reference
      },
      confirmation: {
        approved_by: state.user.id,
        approved_at: new Date().toISOString(),
        final_content_sha256: state.finalContentSha256,
        request_id: state.requestId,
        idempotency_key: state.idempotencyKey,
        contract_version: APPROVAL_CONTRACT_VERSION
      }
    };
  }

  function approvalResult(status, entry, state) {
    return {
      contract_version: APPROVAL_CONTRACT_VERSION,
      status,
      campaign_id: state.campaignId,
      content_id: state.source.generated.content_id,
      conversation_id: state.approval.conversationId,
      message_id: state.approval.messageId,
      knowledge_entry_id: Number(entry.id),
      visibility: entry.visibility,
      evidence_hash: state.source.generated.evidence.evidence_hash,
      context_snapshot_hash: state.source.generated.evidence.context_snapshot_hash,
      final_content_sha256: state.finalContentSha256
    };
  }

  function writeApprovalAudit(state, entryId, outcome) {
    const available = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='activity_log'").get();
    if (!available) {
      throw serviceError(500, 'PERFORMANCE_CONTENT_ANALYSIS_AUDIT_FAILED', 'Content analysis audit is unavailable.');
    }
    db.prepare(`
      INSERT INTO activity_log (user_id,action,module,details,ip_address)
      VALUES (?,'confirm_performance_content_analysis','performance_content_analysis',?,NULL)
    `).run(state.user.id, JSON.stringify({
      request_id: state.requestId,
      idempotency_key: state.idempotencyKey,
      campaign_id: state.campaignId,
      content_id: state.source.generated.content_id,
      conversation_id: state.approval.conversationId,
      message_id: state.approval.messageId,
      knowledge_entry_id: entryId,
      evidence_hash: state.source.generated.evidence.evidence_hash,
      context_snapshot_hash: state.source.generated.evidence.context_snapshot_hash,
      outcome
    }));
  }

  function approveDraft(input) {
    const user = input && input.user;
    const approval = approvalInput(input && input.body);
    const key = idempotencyKey(input && input.idempotencyKey);
    const approvedAccess = approvalAccess(user, input && input.campaignId);
    const reqId = requestId(input && input.requestId);
    const hash = approvalRequestHash(approvedAccess.campaignId, approval);
    const reservationInput = {
      organizationId: approvedAccess.access.campaign.org_id,
      actorUserId: approvedAccess.userId,
      campaignId: approvedAccess.campaignId,
      secondaryCampaignId: null,
      resourceClaim: null,
      scope: 'performance.content-analysis.approve',
      key,
      requestHash: hash,
      expectedEventCount: 0,
      operationTimeoutSeconds: 60
    };
    const retained = idempotency.inspectRetained(db, reservationInput);
    if (
      retained.state !== 'absent' &&
      !(retained.state === 'processing' && retained.recoverable === true)
    ) {
      return approvalIdempotencyDisposition(retained);
    }

    return db.transaction(() => {
      const lockedAccess = approvalAccess(user, approvedAccess.campaignId);
      if (lockedAccess.access.campaign.org_id !== reservationInput.organizationId) {
        throw serviceError(403, 'PERFORMANCE_CONTENT_ANALYSIS_APPROVAL_FORBIDDEN', 'Campaign access is forbidden.');
      }
      let reservation = idempotency.recoverExpiredInTransaction(db, reservationInput);
      if (reservation.state === 'absent') {
        reservation = idempotency.reserveProcessingInTransaction(db, reservationInput);
      }
      if (reservation.state !== 'reserved') {
        return approvalIdempotencyDisposition(reservation);
      }

      const source = storedDraft(lockedAccess.access, approval);
      const suppliedReferences = evidenceReferences(approval.evidenceRequest);
      const suppliedEvidence = evidenceProjection(approval.evidenceRequest, suppliedReferences);
      if (
        source.generated.evidence.evidence_hash !== approval.evidenceHash ||
        source.generated.evidence.context_snapshot_hash !== approval.contextSnapshotHash ||
        source.generated.content_id !== approval.evidenceRequest.contentId ||
        suppliedEvidence.evidence_hash !== approval.evidenceHash
      ) {
        throw serviceError(409, 'PERFORMANCE_CONTENT_ANALYSIS_SNAPSHOT_MISMATCH', 'Content analysis lineage does not match.');
      }
      const requiredCitations = source.generated.evidence.citation_ids;
      if (
        !Array.isArray(requiredCitations) ||
        !requiredCitations.length ||
        requiredCitations.some((citation) => !approval.editedDraft.includes(`[${citation}]`))
      ) {
        throw serviceError(
          400,
          'PERFORMANCE_CONTENT_ANALYSIS_CITATION_REQUIRED',
          'Edited content analysis must retain every validated evidence citation.'
        );
      }
      validateEditedDraft(approval.editedDraft, approval.evidenceRequest, requiredCitations);
      const sourceId = `${approval.conversationId}:${approval.messageId}`;
      const finalContentSha256 = sha256(approval.editedDraft);
      const existingRows = db.prepare(`
        SELECT id,content,visibility,metadata_json FROM knowledge_entries
        WHERE business_type='campaign' AND business_id=?
          AND source_type='performance_content_analysis_confirmation' AND source_id=?
        ORDER BY id
      `).all(String(lockedAccess.campaignId), sourceId);
      const state = {
        user,
        campaignId: lockedAccess.campaignId,
        approval,
        source,
        finalContentSha256,
        requestId: reqId,
        idempotencyKey: key
      };
      if (existingRows.length > 1) {
        throw serviceError(409, 'PERFORMANCE_CONTENT_ANALYSIS_ARCHIVE_CONFLICT', 'Content analysis archives conflict.');
      }
      if (existingRows.length === 1 && existingConfirmation(existingRows[0], state)) {
        const existing = existingRows[0];
        const link = db.prepare(`
          SELECT id FROM campaign_record_links
          WHERE org_id=? AND campaign_id=? AND record_type='knowledge_entry'
            AND record_id=? AND relation_type='knowledge' AND revoked_at IS NULL
          LIMIT 1
        `).get(
          approvedAccess.access.campaign.org_id,
          approvedAccess.campaignId,
          String(existing.id)
        );
        if (!link) {
          throw serviceError(409, 'PERFORMANCE_CONTENT_ANALYSIS_ARCHIVE_CONFLICT', 'Knowledge custody is incomplete.');
        }
        const result = approvalResult('already_confirmed', existing, state);
        writeApprovalAudit(state, Number(existing.id), result.status);
        idempotency.completeJsonInTransaction(db, {
          ledgerId: reservation.ledgerId,
          requestHash: hash,
          leaseToken: reservation.leaseToken,
          statusCode: 200,
          responseBody: result
        });
        return result;
      }
      if (existingRows.length === 1) {
        throw serviceError(409, 'PERFORMANCE_CONTENT_ANALYSIS_ALREADY_CONFIRMED', 'This AI draft was already confirmed differently.');
      }
      const current = contentSnapshot(
        db,
        performanceService,
        user,
        lockedAccess.campaignId,
        source.generated.content_id
      );
      if (current.hash !== approval.contextSnapshotHash) {
        throw serviceError(409, 'PERFORMANCE_CONTENT_ANALYSIS_STALE', 'Performance context changed after analysis generation.');
      }
      const written = knowledge.ingestBusinessArtifact(db, {
        artifactType: 'performance_content_analysis_confirmation',
        artifactState: 'confirmed',
        organizationId: lockedAccess.access.campaign.org_id,
        campaignId: lockedAccess.campaignId,
        createdBy: user.id,
        sourceId,
        title: `内容证据分析 #${source.generated.content_id}`,
        summary: summaryText(approval.editedDraft),
        content: approval.editedDraft,
        tags: ['performance', 'content_analysis', 'human_confirmed'],
        visibility: approval.visibility,
        metadata: approvalMetadata(state)
      });
      if (!written || written.status !== 'created' || !written.entry || !written.entry.id) {
        throw serviceError(409, 'PERFORMANCE_CONTENT_ANALYSIS_ARCHIVE_CONFLICT', 'Content analysis archive already exists.');
      }
      db.prepare(`
        INSERT INTO campaign_record_links (
          org_id,campaign_id,record_type,bundle_id,record_id,relation_type,
          created_by,metadata_json
        ) VALUES (?,?,?,?,?,?,?,?)
      `).run(
        lockedAccess.access.campaign.org_id,
        lockedAccess.campaignId,
        'knowledge_entry',
        crypto.randomBytes(32).toString('hex'),
        String(written.entry.id),
        'knowledge',
        user.id,
        JSON.stringify({ source: 'performance_content_analysis_confirmation' })
      );
      knowledge.applyKnowledgeCapacityGaugePlanInTransaction(db, written.capacityGaugePlan);
      knowledge.confirmKnowledgeInTransaction(db, {
        entryId: Number(written.entry.id),
        expectedVersion: 1,
        reviewedBy: user.id,
        reason: '项目负责人已人工确认内容证据分析结论。'
      });
      const result = approvalResult('confirmed', written.entry, state);
      writeApprovalAudit(state, Number(written.entry.id), result.status);
      idempotency.completeJsonInTransaction(db, {
        ledgerId: reservation.ledgerId,
        requestHash: hash,
        leaseToken: reservation.leaseToken,
        statusCode: 200,
        responseBody: result
      });
      return result;
    }).immediate();
  }

  return Object.freeze({ createDraft, approveDraft });
}

module.exports = {
  DRAFT_CONTRACT_VERSION,
  APPROVAL_CONTRACT_VERSION,
  PerformanceContentAnalysisServiceError,
  createPerformanceContentAnalysisService
};

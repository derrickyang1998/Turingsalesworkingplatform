'use strict';

const crypto = require('node:crypto');
const { getCampaignAccess: defaultGetCampaignAccess } = require('./campaign_access_service');
const { buildPerformanceReviewEvidenceSnapshot } = require('./performance_manual_service');

const CUSTOMER_REPORT_CONTRACT_VERSION = 'customer_safe_v1';
const CUSTOMER_REPORT_REDACTION_POLICY_VERSION = 'customer-safe-v1';
const MAX_TITLE_LENGTH = 120;
const MAX_ACTIONS = 5;
const MAX_ACTION_LENGTH = 400;
const MAX_NEXT_CYCLE_PLAN_LENGTH = 800;
const OBSERVED_METRICS = Object.freeze(['views', 'likes', 'comments', 'saves', 'shares']);
const SELECTABLE_METRICS = Object.freeze([
  'views', 'likes', 'comments', 'saves', 'shares', 'clicks', 'conversions', 'core_view_er'
]);
const METRIC_LABELS = Object.freeze({
  views: '播放量',
  likes: '点赞数',
  comments: '评论数',
  saves: '收藏数',
  shares: '转发数',
  clicks: '点击数',
  conversions: '转化数',
  core_view_er: '核心播放互动率'
});
const METRIC_DEFINITIONS = Object.freeze({
  views: '当前已观测内容的播放量汇总。',
  likes: '当前已观测内容的点赞数汇总。',
  comments: '当前已观测内容的评论数汇总。',
  saves: '当前已观测内容的收藏数汇总。',
  shares: '当前已观测内容的转发数汇总。',
  clicks: '当前已观测内容的点击数汇总。',
  conversions: '当前已观测内容的转化数汇总。',
  core_view_er: '已观测点赞与评论之和相对于播放量的互动率。'
});
const CUSTOMER_LIMITATIONS = Object.freeze({
  metadata_only: '当前复盘基于已登记的项目数据，不包含素材或内容创意层面的分析。',
  commercial_metrics_restricted: '商业指标暂未纳入当前客户版复盘范围。',
  ranking_coverage_insufficient: '当前数据覆盖不足，暂不展示可比较的内容排名。',
  no_observed_metric: '当前没有足够的已观测指标用于比较。',
  insufficient_comparable_records: '当前可比较内容数量不足，暂不展示比较结论。',
  insufficient_metric_coverage: '当前指标覆盖不足，暂不展示比较结论。'
});
const SAFE_SOURCE_MODE_LABELS = Object.freeze({
  manual: '人工录入',
  csv_xlsx: '表格导入',
  import: '表格导入',
  feishu: '飞书同步',
  provider: '已接入数据源',
  api: '已接入数据源'
});
const UNSAFE_TEXT_PATTERNS = Object.freeze([
  /(?:https?|ftp):\/\//i,
  /\bwww\./i,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /(?:\+?\d[\d\s().-]{6,}\d)/,
  /[$€£¥]/,
  /\b(?:USD|CNY|RMB|EUR|GBP|JPY|AUD|CAD)\s*\d/i,
  /\b\d+(?:\.\d+)?\s*(?:USD|CNY|RMB|EUR|GBP|JPY|AUD|CAD)\b/i,
  /\d+(?:\.\d+)?\s*(?:元|块|人民币|美元|美金|欧元|英镑|日元|万|千)/i,
  /\b(?:CPM|CPC|CPE|CPI|CPS|CPV|ROI|ROAS|GMV|CTR|CVR|revenue|sales|cost|spend|budget|attributed[_\s-]?revenue)\b/i,
  /(?:花费|成本|预算|费用|报价|回款|利润|佣金|投放|收入|销售额|转化金额|千次展示成本|单次点击成本|商业机密|机密|保密|内部|仅限内部)/,
  /\b(?:confidential|internal(?:\s+only)?|private)\b/i
]);

class CustomerReportSnapshotServiceError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'CustomerReportSnapshotServiceError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function customerReportError(statusCode, code, message, details) {
  return new CustomerReportSnapshotServiceError(statusCode, code, message, details);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeJson(value, fallback) {
  if (typeof value !== 'string') return fallback;
  try {
    const parsed = JSON.parse(value);
    return plainObject(parsed) ? parsed : fallback;
  } catch (_error) {
    return fallback;
  }
}

function canonicalId(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && String(parsed) === value ? parsed : null;
  }
  return null;
}

function validHash(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON does not permit non-finite numbers.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  throw new TypeError('Canonical JSON contains an unsupported value.');
}

function canonicalHash(value) {
  return sha256(canonicalJson(value));
}

function characterLength(value) {
  return Array.from(String(value || '')).length;
}

function normalizeText(value, field, maxLength, options = {}) {
  if (typeof value !== 'string') {
    throw customerReportError(400, 'CUSTOMER_REPORT_INPUT_INVALID', `${field} must be text.`, { field });
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) {
    throw customerReportError(400, 'CUSTOMER_REPORT_INPUT_INVALID', `${field} contains control characters.`, { field });
  }
  const text = value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!options.allowEmpty && !text) {
    throw customerReportError(400, 'CUSTOMER_REPORT_INPUT_INVALID', `${field} is required.`, { field });
  }
  if (characterLength(text) > maxLength) {
    throw customerReportError(400, 'CUSTOMER_REPORT_INPUT_INVALID', `${field} is too long.`, { field, max_length: maxLength });
  }
  if (text && UNSAFE_TEXT_PATTERNS.some((pattern) => pattern.test(text))) {
    throw customerReportError(400, 'CUSTOMER_REPORT_INPUT_INVALID', `${field} contains unsupported customer-report content.`, { field });
  }
  return text;
}

function safeDerivedText(value, maxLength, fallback = null) {
  if (typeof value !== 'string') return fallback;
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) return fallback;
  const text = value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text || characterLength(text) > maxLength) return fallback;
  return UNSAFE_TEXT_PATTERNS.some((pattern) => pattern.test(text)) ? fallback : text;
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function publicMetric(value, options = {}) {
  const raw = plainObject(value) ? value : { value, available: Number.isFinite(Number(value)) };
  const number = finiteNonNegative(raw.value);
  const ratio = options.ratio === true;
  if (raw.available !== true || number === null || (ratio && number > 1)) {
    return { status: 'not_available', value: null };
  }
  return { status: 'available', value: number };
}

function selectedMetricValue(evidence, selectedMetric) {
  if (selectedMetric === 'core_view_er') {
    return publicMetric(evidence.metrics && evidence.metrics.core_view_er, { ratio: true });
  }
  return publicMetric(evidence.totals && evidence.totals[selectedMetric]);
}

function sourceMetric(value) {
  if (!plainObject(value)) return { status: 'not_available', value: null };
  const number = finiteNonNegative(value.value);
  if (value.available !== true || number === null) return { status: 'not_available', value: null };
  return { status: 'available', value: number };
}

function reportSourceModes(value) {
  const counts = plainObject(value) ? value : {};
  const output = [];
  let otherCount = 0;
  for (const [mode, count] of Object.entries(counts)) {
    const normalizedCount = Number.isSafeInteger(count) && count >= 0 ? count : 0;
    if (!normalizedCount) continue;
    const label = SAFE_SOURCE_MODE_LABELS[mode];
    if (label) output.push({ mode: label, count: normalizedCount });
    else otherCount += normalizedCount;
  }
  if (otherCount) output.push({ mode: '其他已登记来源', count: otherCount });
  return output.sort((left, right) => left.mode.localeCompare(right.mode, 'zh-CN'));
}

function reportCoverage(value) {
  const rows = Array.isArray(value) ? value : [];
  return rows.filter((row) => plainObject(row) && OBSERVED_METRICS.includes(row.metric))
    .map((row) => {
      const coverage = finiteNonNegative(row.coverage);
      const available = Number.isSafeInteger(row.available_records) && row.available_records >= 0
        ? row.available_records
        : 0;
      const total = Number.isSafeInteger(row.total_records) && row.total_records >= 0
        ? row.total_records
        : 0;
      return {
        metric: row.metric,
        coverage: coverage === null ? 0 : Math.min(1, coverage),
        available_records: available,
        total_records: total
      };
    });
}

function reportObservationWindow(value) {
  const source = plainObject(value) ? value : {};
  const date = (candidate) => (
    typeof candidate === 'string' && Number.isFinite(Date.parse(candidate)) ? candidate : null
  );
  return {
    min_observed_at: date(source.min_observed_at),
    max_observed_at: date(source.max_observed_at),
    freshness_policy: source.freshness_policy === 'not_configured'
      ? 'not_configured'
      : 'not_disclosed'
  };
}

function safeComparisonRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    if (!plainObject(row) || !plainObject(row.metric)) return null;
    const label = safeDerivedText(row.label, 100);
    const metric = sourceMetric(row.metric);
    const coverage = finiteNonNegative(row.metric.coverage);
    const count = Number.isSafeInteger(row.content_count) && row.content_count >= 0 ? row.content_count : 0;
    if (!label || metric.status !== 'available' || coverage === null || coverage < 0.8) return null;
    return {
      label,
      content_count: count,
      selected_metric: metric
    };
  }).filter(Boolean).slice(0, 5);
}

function reportComparisons(evidence, selectedMetric) {
  const rankings = plainObject(evidence.rankings) ? evidence.rankings : {};
  const eligibility = plainObject(rankings.eligibility) ? rankings.eligibility : {};
  const coverage = finiteNonNegative(eligibility.coverage);
  const eligible = rankings.status === 'available' && eligibility.eligible === true && coverage !== null && coverage >= 0.8;
  if (!eligible) {
    const reason = plainObject(eligibility.reason) && typeof eligibility.reason.code === 'string'
      ? eligibility.reason.code
      : 'insufficient_metric_coverage';
    return {
      status: 'not_available',
      selected_metric: selectedMetric,
      reason: CUSTOMER_LIMITATIONS[reason] || CUSTOMER_LIMITATIONS.insufficient_metric_coverage,
      minimum_coverage: 0.8,
      coverage: coverage === null ? 0 : Math.min(1, coverage)
    };
  }
  const breakdowns = plainObject(evidence.breakdowns) ? evidence.breakdowns : {};
  return {
    status: 'available',
    selected_metric: selectedMetric,
    minimum_coverage: 0.8,
    coverage: Math.min(1, coverage),
    platforms: safeComparisonRows(breakdowns.platforms),
    products: safeComparisonRows(breakdowns.products),
    creator_tiers: {
      status: 'not_available',
      reason: 'creator_tier_not_collected'
    }
  };
}

function reportCases(evidence, selectedMetric) {
  const rankings = plainObject(evidence.rankings) ? evidence.rankings : {};
  if (rankings.status !== 'available') {
    return { status: 'not_available', selected_metric: selectedMetric, cases: [] };
  }
  const cases = (Array.isArray(rankings.top_contents) ? rankings.top_contents : []).map((entry, index) => {
    const content = plainObject(entry && entry.content) ? entry.content : {};
    const platform = safeDerivedText(content.platform, 50);
    const product = safeDerivedText(content.product, 100);
    const metric = sourceMetric(entry && entry.metric);
    if (metric.status !== 'available') return null;
    const result = {
      reference: `case-${index + 1}`,
      selected_metric: metric
    };
    if (platform) result.platform = platform;
    if (product) result.product = product;
    return result;
  }).filter(Boolean).slice(0, 5);
  return {
    status: cases.length ? 'available' : 'not_available',
    selected_metric: selectedMetric,
    cases
  };
}

function reportLimitations(evidence) {
  const source = Array.isArray(evidence.limitations) ? evidence.limitations : [];
  const known = [];
  for (const item of source) {
    const code = plainObject(item) && typeof item.code === 'string' ? item.code : '';
    if (CUSTOMER_LIMITATIONS[code] && !known.some((existing) => existing.code === code)) {
      known.push({ code, disclosure: CUSTOMER_LIMITATIONS[code] });
    }
  }
  if (!known.some((item) => item.code === 'metadata_only')) {
    known.unshift({ code: 'metadata_only', disclosure: CUSTOMER_LIMITATIONS.metadata_only });
  }
  if (!known.some((item) => item.code === 'commercial_metrics_restricted')) {
    known.push({ code: 'commercial_metrics_restricted', disclosure: CUSTOMER_LIMITATIONS.commercial_metrics_restricted });
  }
  return known;
}

function reportDataSummary(evidence) {
  const totals = plainObject(evidence.totals) ? evidence.totals : {};
  const metrics = plainObject(evidence.metrics) ? evidence.metrics : {};
  return {
    observed_metrics: {
      views: publicMetric(totals.views),
      likes: publicMetric(totals.likes),
      comments: publicMetric(totals.comments),
      favorites: publicMetric(totals.saves),
      shares: publicMetric(totals.shares),
      interactions: publicMetric(metrics.observed_engagement_total),
      engagement_rate: publicMetric(metrics.core_view_er, { ratio: true })
    }
  };
}

function reportProjectOverview(access, evidence) {
  const breakdowns = plainObject(evidence.breakdowns) ? evidence.breakdowns : {};
  const platformMix = (Array.isArray(breakdowns.platforms) ? breakdowns.platforms : [])
    .map((row) => safeDerivedText(row && row.label, 50))
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(0, 10);
  const records = plainObject(evidence.records) ? evidence.records : {};
  const contentCount = Number.isSafeInteger(records.total) && records.total >= 0 ? records.total : 0;
  return {
    campaign_name: safeDerivedText(access.campaign && access.campaign.name, 120, '项目复盘'),
    platform_mix: platformMix,
    publish_window: { status: 'not_available', reason: 'publish_window_not_collected' },
    observation_window: reportObservationWindow(evidence.data_quality && evidence.data_quality.observation_window),
    content_count: contentCount,
    data_coverage: reportCoverage(evidence.data_quality && evidence.data_quality.metric_coverage)
  };
}

function normalizedBody(body, options = {}) {
  const source = plainObject(body) ? body : {};
  const allowed = new Set([
    'top_metric',
    'title',
    'optimization_actions',
    'next_cycle_plan',
    ...(options.sealing ? ['expected_evidence_snapshot_hash'] : [])
  ]);
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) {
      throw customerReportError(400, 'CUSTOMER_REPORT_INPUT_INVALID', 'Input contains an unsupported field.', { field: key });
    }
  }
  let topMetric = null;
  if (source.top_metric !== undefined && source.top_metric !== null && source.top_metric !== '') {
    topMetric = typeof source.top_metric === 'string' ? source.top_metric.trim() : '';
    if (!SELECTABLE_METRICS.includes(topMetric)) {
      throw customerReportError(400, 'CUSTOMER_REPORT_INPUT_INVALID', 'top_metric is invalid.', { field: 'top_metric' });
    }
  }
  const title = normalizeText(source.title, 'title', MAX_TITLE_LENGTH);
  if (!Array.isArray(source.optimization_actions) || source.optimization_actions.length > MAX_ACTIONS) {
    throw customerReportError(400, 'CUSTOMER_REPORT_INPUT_INVALID', 'optimization_actions is invalid.', {
      field: 'optimization_actions', max_items: MAX_ACTIONS
    });
  }
  const actions = source.optimization_actions.map((action, index) => (
    normalizeText(action, `optimization_actions[${index}]`, MAX_ACTION_LENGTH)
  ));
  const nextCyclePlan = normalizeText(
    source.next_cycle_plan === undefined ? '' : source.next_cycle_plan,
    'next_cycle_plan',
    MAX_NEXT_CYCLE_PLAN_LENGTH,
    { allowEmpty: true }
  );
  const expectedEvidenceSnapshotHash = options.sealing
    ? source.expected_evidence_snapshot_hash
    : null;
  if (options.sealing && !validHash(expectedEvidenceSnapshotHash)) {
    throw customerReportError(400, 'CUSTOMER_REPORT_INPUT_INVALID', 'expected_evidence_snapshot_hash is invalid.', {
      field: 'expected_evidence_snapshot_hash'
    });
  }
  return {
    topMetric,
    title,
    optimizationActions: actions,
    nextCyclePlan,
    expectedEvidenceSnapshotHash
  };
}

function idempotencyKey(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(key)) {
    throw customerReportError(400, 'CUSTOMER_REPORT_IDEMPOTENCY_INVALID', 'Idempotency-Key is required for customer report sealing.');
  }
  return key;
}

function requestId(value) {
  const request = typeof value === 'string' ? value.trim() : '';
  if (!request || request.length > 200 || /[\u0000-\u001F\u007F]/.test(request)) {
    throw customerReportError(400, 'CUSTOMER_REPORT_REQUEST_INVALID', 'Request identifier is invalid.');
  }
  return request;
}

function sourceMetadata(row) {
  const metadata = safeJson(row && row.metadata_json, null);
  const evidence = metadata && plainObject(metadata.evidence) ? metadata.evidence : null;
  const confirmation = metadata && plainObject(metadata.confirmation) ? metadata.confirmation : null;
  if (!metadata || !evidence || !confirmation ||
    metadata.artifact_type !== 'performance_review_confirmation' ||
    metadata.artifact_state !== 'confirmed' ||
    confirmation.contract_version !== 'performance-ai-review-approval-v1' ||
    !validHash(row && row.content_sha256) ||
    !validHash(evidence.snapshot_hash) ||
    !validHash(confirmation.final_content_sha256)) {
    throw customerReportError(409, 'CUSTOMER_REPORT_SOURCE_INVALID', 'The confirmed AI review source is incomplete.');
  }
  if (typeof evidence.selected_metric !== 'string' || !SELECTABLE_METRICS.includes(evidence.selected_metric)) {
    throw customerReportError(409, 'CUSTOMER_REPORT_SOURCE_INVALID', 'The confirmed AI review metric is invalid.');
  }
  if (typeof row.content !== 'string' || sha256(row.content) !== confirmation.final_content_sha256) {
    throw customerReportError(409, 'CUSTOMER_REPORT_SOURCE_INVALID', 'The confirmed AI review content cannot be verified.');
  }
  return {
    contentHash: confirmation.final_content_sha256,
    evidenceHash: evidence.snapshot_hash,
    selectedMetric: evidence.selected_metric
  };
}

function serializeStoredSnapshot(row) {
  const report = safeJson(row && row.report_json, null);
  if (!report || report.contract_version !== CUSTOMER_REPORT_CONTRACT_VERSION ||
    report.redaction_policy_version !== CUSTOMER_REPORT_REDACTION_POLICY_VERSION) {
    throw customerReportError(409, 'CUSTOMER_REPORT_SNAPSHOT_INVALID', 'Stored customer report snapshot is invalid.');
  }
  return {
    id: Number(row.id),
    created_at: row.created_at,
    report_sha256: row.report_sha256,
    report
  };
}

function compactStoredSnapshot(row) {
  const snapshot = serializeStoredSnapshot(row);
  const report = snapshot.report;
  return {
    id: snapshot.id,
    created_at: snapshot.created_at,
    title: typeof report.title === 'string' ? report.title : '客户复盘',
    selected_metric: report.selected_metric || null,
    evidence_snapshot_hash: report.lineage && report.lineage.current_evidence_snapshot_hash || null,
    report_sha256: snapshot.report_sha256
  };
}

function createCustomerReportSnapshotService(db, options = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('A SQLite database is required.');
  const performanceService = options.performanceService;
  if (!performanceService || typeof performanceService.getReviewEvidence !== 'function') {
    throw new TypeError('A performance review evidence service is required.');
  }
  const getCampaignAccess = options.getCampaignAccess || defaultGetCampaignAccess;

  function requireAccess(userIdValue, campaignIdValue, mode) {
    const userId = canonicalId(userIdValue);
    const campaignId = canonicalId(campaignIdValue);
    if (userId === null) {
      throw customerReportError(401, 'CUSTOMER_REPORT_UNAUTHORIZED', 'An authenticated user is required.');
    }
    if (campaignId === null) {
      throw customerReportError(400, 'CUSTOMER_REPORT_CAMPAIGN_INVALID', 'Campaign is invalid.');
    }
    const access = getCampaignAccess(db, { userId, campaignId });
    if (!access || access.ok !== true) {
      throw customerReportError(
        access && Number.isSafeInteger(access.status) ? access.status : 403,
        access && access.code ? access.code : 'CUSTOMER_REPORT_FORBIDDEN',
        'Campaign access is forbidden.'
      );
    }
    const campaign = access.campaign || {};
    const organizationId = canonicalId(campaign.org_id || campaign.organization_id);
    if (organizationId === null || canonicalId(campaign.id) !== campaignId) {
      throw customerReportError(409, 'CUSTOMER_REPORT_CAMPAIGN_INVALID', 'Campaign access context is invalid.');
    }
    const canRead = Boolean(access.permissions && access.permissions.read);
    const privileged = access.role === 'org_admin' || access.role === 'owner';
    const canWrite = privileged && Boolean(access.permissions && access.permissions.write);
    if ((mode === 'read' && !canRead) || (mode === 'write' && !canWrite)) {
      throw customerReportError(403, 'CUSTOMER_REPORT_FORBIDDEN', 'Customer report access is forbidden.');
    }
    return { userId, campaignId, organizationId, access };
  }

  function loadConfirmedSource(context) {
    const rows = db.prepare(`
      SELECT entry.id,entry.content,entry.content_sha256,entry.metadata_json
      FROM knowledge_entries entry
      JOIN knowledge_current_custody custody ON custody.knowledge_entry_id=entry.id
      WHERE custody.org_id=? AND custody.campaign_id=? AND custody.custody_state='active'
        AND entry.entry_type='campaign_performance_review'
        AND entry.source_type='performance_ai_review_confirmation'
        AND entry.business_type='campaign' AND entry.business_id=?
      ORDER BY entry.id DESC
    `).all(context.organizationId, context.campaignId, String(context.campaignId));
    if (!rows.length) {
      throw customerReportError(409, 'CUSTOMER_REPORT_SOURCE_MISSING', 'A confirmed performance review is required before creating a customer report.');
    }
    if (rows.length > 1) {
      throw customerReportError(409, 'CUSTOMER_REPORT_SOURCE_CONFLICT', 'The campaign has conflicting confirmed performance reviews.');
    }
    const row = rows[0];
    return Object.assign({ id: Number(row.id) }, sourceMetadata(row));
  }

  function loadCurrentEvidence(context, source, normalized, expectedHash) {
    const selectedMetric = normalized.topMetric || source.selectedMetric;
    if (selectedMetric !== source.selectedMetric) {
      throw customerReportError(409, 'CUSTOMER_REPORT_SOURCE_INVALID', 'The selected metric does not match the confirmed performance review.');
    }
    let evidence;
    try {
      evidence = performanceService.getReviewEvidence({
        userId: context.userId,
        campaignId: context.campaignId,
        query: { top_metric: selectedMetric }
      });
    } catch (_error) {
      throw customerReportError(409, 'CUSTOMER_REPORT_STALE_EVIDENCE', 'Current performance evidence could not be verified.');
    }
    const snapshot = buildPerformanceReviewEvidenceSnapshot(evidence);
    if (!evidence || Number(evidence.campaign_id) !== context.campaignId ||
      !plainObject(evidence.rankings) || evidence.rankings.status !== 'available' ||
      !plainObject(evidence.scope) || evidence.scope.selected_metric !== selectedMetric ||
      snapshot.snapshotHash !== source.evidenceHash ||
      (expectedHash && expectedHash !== snapshot.snapshotHash)) {
      throw customerReportError(409, 'CUSTOMER_REPORT_STALE_EVIDENCE', 'Current performance evidence no longer matches the confirmed review.');
    }
    return { evidence, snapshot };
  }

  function buildReport(context, source, evidenceState, normalized, status, sealedAt, idempotencyState) {
    const evidence = evidenceState.evidence;
    const selectedMetric = source.selectedMetric;
    const records = plainObject(evidence.records) ? evidence.records : {};
    const activeWithObservations = Number.isSafeInteger(records.active_with_observations) && records.active_with_observations >= 0
      ? records.active_with_observations
      : 0;
    const report = {
      contract_version: CUSTOMER_REPORT_CONTRACT_VERSION,
      redaction_policy_version: CUSTOMER_REPORT_REDACTION_POLICY_VERSION,
      recipient_profile: 'customer',
      status,
      title: normalized.title,
      selected_metric: selectedMetric,
      evidence_snapshot_hash: evidenceState.snapshot.snapshotHash,
      quality_disclosure: {
        evidence_mode: 'metadata_only',
        observed_content_count: activeWithObservations,
        commercial_scope: 'withheld_pending_approved_scope'
      },
      lineage: {
        source_review_content_sha256: source.contentHash,
        source_review_evidence_snapshot_hash: source.evidenceHash,
        current_evidence_snapshot_hash: evidenceState.snapshot.snapshotHash,
        request_fingerprint: idempotencyState && idempotencyState.requestFingerprint || null,
        idempotency_key_sha256: idempotencyState && idempotencyState.idempotencyKeyHash || null,
        request_payload_sha256: idempotencyState && idempotencyState.requestPayloadHash || null
      },
      actor: { type: 'authorized_campaign_operator' },
      sections: {
        project_overview: reportProjectOverview(context.access, evidence),
        data_summary: reportDataSummary(evidence),
        eligible_comparisons: reportComparisons(evidence, selectedMetric),
        key_indicators: {
          selected_metric: {
            key: selectedMetric,
            label: METRIC_LABELS[selectedMetric],
            definition: METRIC_DEFINITIONS[selectedMetric],
            ...selectedMetricValue(evidence, selectedMetric)
          },
          commercial: {
            status: 'withheld_pending_approved_scope',
            disclosure: '商业指标暂未纳入当前客户版复盘范围。'
          }
        },
        excellent_cases: reportCases(evidence, selectedMetric),
        data_limits_and_risks: {
          observation_window: reportObservationWindow(evidence.data_quality && evidence.data_quality.observation_window),
          metric_coverage: reportCoverage(evidence.data_quality && evidence.data_quality.metric_coverage),
          source_modes: reportSourceModes(evidence.data_quality && evidence.data_quality.source_mode_counts),
          limitations: reportLimitations(evidence)
        },
        optimization_and_next_cycle: {
          optimization_actions: normalized.optimizationActions,
          next_cycle_plan: normalized.nextCyclePlan
        }
      }
    };
    if (sealedAt) report.sealed_at = sealedAt;
    return report;
  }

  function preview(input) {
    const context = requireAccess(input && input.user && input.user.id, input && input.campaignId, 'write');
    const normalized = normalizedBody(input && input.body, { sealing: false });
    const source = loadConfirmedSource(context);
    const evidenceState = loadCurrentEvidence(context, source, normalized, null);
    return buildReport(context, source, evidenceState, normalized, 'preview', null, null);
  }

  function findIdempotencyRows(context, keyHash) {
    return db.prepare(`
      SELECT id,created_at,report_sha256,report_json
      FROM customer_report_snapshots
      WHERE org_id=? AND campaign_id=?
        AND json_extract(report_json,'$.lineage.idempotency_key_sha256')=?
      ORDER BY id
    `).all(context.organizationId, context.campaignId, keyHash);
  }

  function seal(input) {
    const normalized = normalizedBody(input && input.body, { sealing: true });
    const rawIdempotencyKey = idempotencyKey(input && input.idempotencyKey);
    requestId(input && input.requestId);
    const keyHash = sha256(rawIdempotencyKey);
    const payloadHash = canonicalHash({
      top_metric: normalized.topMetric,
      title: normalized.title,
      optimization_actions: normalized.optimizationActions,
      next_cycle_plan: normalized.nextCyclePlan,
      expected_evidence_snapshot_hash: normalized.expectedEvidenceSnapshotHash
    });

    return db.transaction(() => {
      const context = requireAccess(input && input.user && input.user.id, input && input.campaignId, 'write');
      const idempotencyRows = findIdempotencyRows(context, keyHash);
      if (idempotencyRows.length > 1) {
        throw customerReportError(409, 'CUSTOMER_REPORT_IDEMPOTENCY_CONFLICT', 'Customer report idempotency state is inconsistent.');
      }
      if (idempotencyRows.length === 1) {
        const existing = serializeStoredSnapshot(idempotencyRows[0]);
        const existingPayloadHash = existing.report.lineage && existing.report.lineage.request_payload_sha256;
        if (existingPayloadHash !== payloadHash) {
          throw customerReportError(409, 'CUSTOMER_REPORT_IDEMPOTENCY_CONFLICT', 'This idempotency key was already used for a different customer report request.');
        }
        return { status: 'already_sealed', snapshot: existing };
      }

      const source = loadConfirmedSource(context);
      const evidenceState = loadCurrentEvidence(
        context,
        source,
        normalized,
        normalized.expectedEvidenceSnapshotHash
      );
      const requestFingerprint = canonicalHash({
        contract_version: CUSTOMER_REPORT_CONTRACT_VERSION,
        campaign_id: context.campaignId,
        source_review_content_sha256: source.contentHash,
        source_review_evidence_snapshot_hash: source.evidenceHash,
        current_evidence_snapshot_hash: evidenceState.snapshot.snapshotHash,
        idempotency_key_sha256: keyHash,
        request_payload_sha256: payloadHash
      });
      const report = buildReport(
        context,
        source,
        evidenceState,
        normalized,
        'sealed',
        new Date().toISOString(),
        {
          requestFingerprint,
          idempotencyKeyHash: keyHash,
          requestPayloadHash: payloadHash
        }
      );
      const reportJson = JSON.stringify(report);
      const reportHash = canonicalHash(report);
      let result;
      try {
        result = db.prepare(`
          INSERT INTO customer_report_snapshots (
            org_id,campaign_id,created_by,source_knowledge_entry_id,report_contract_version,
            redaction_policy_version,selected_metric,source_review_content_sha256,source_review_snapshot_hash,
            current_evidence_snapshot_hash,request_fingerprint,report_sha256,report_json
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          context.organizationId,
          context.campaignId,
          context.userId,
          source.id,
          CUSTOMER_REPORT_CONTRACT_VERSION,
          CUSTOMER_REPORT_REDACTION_POLICY_VERSION,
          source.selectedMetric,
          source.contentHash,
          source.evidenceHash,
          evidenceState.snapshot.snapshotHash,
          requestFingerprint,
          reportHash,
          reportJson
        );
      } catch (error) {
        if (!error || error.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw error;
        const existing = db.prepare(`
          SELECT id,created_at,report_sha256,report_json
          FROM customer_report_snapshots
          WHERE org_id=? AND campaign_id=? AND request_fingerprint=?
          LIMIT 1
        `).get(context.organizationId, context.campaignId, requestFingerprint);
        if (!existing) throw error;
        return { status: 'already_sealed', snapshot: serializeStoredSnapshot(existing) };
      }
      const inserted = db.prepare(`
        SELECT id,created_at,report_sha256,report_json
        FROM customer_report_snapshots
        WHERE id=? AND org_id=? AND campaign_id=?
      `).get(result.lastInsertRowid, context.organizationId, context.campaignId);
      return { status: 'sealed', snapshot: serializeStoredSnapshot(inserted) };
    }).immediate();
  }

  function list(input) {
    const context = requireAccess(input && input.userId, input && input.campaignId, 'read');
    const rows = db.prepare(`
      SELECT id,created_at,report_sha256,report_json
      FROM customer_report_snapshots
      WHERE org_id=? AND campaign_id=?
      ORDER BY created_at DESC,id DESC
    `).all(context.organizationId, context.campaignId);
    return {
      contract_version: CUSTOMER_REPORT_CONTRACT_VERSION,
      campaign_id: context.campaignId,
      snapshots: rows.map(compactStoredSnapshot)
    };
  }

  function get(input) {
    const context = requireAccess(input && input.userId, input && input.campaignId, 'read');
    const snapshotId = canonicalId(input && input.snapshotId);
    if (snapshotId === null) {
      throw customerReportError(400, 'CUSTOMER_REPORT_SNAPSHOT_INVALID', 'Customer report snapshot is invalid.');
    }
    const row = db.prepare(`
      SELECT id,created_at,report_sha256,report_json
      FROM customer_report_snapshots
      WHERE id=? AND org_id=? AND campaign_id=?
      LIMIT 1
    `).get(snapshotId, context.organizationId, context.campaignId);
    if (!row) {
      throw customerReportError(404, 'CUSTOMER_REPORT_SNAPSHOT_NOT_FOUND', 'Customer report snapshot was not found.');
    }
    return {
      contract_version: CUSTOMER_REPORT_CONTRACT_VERSION,
      campaign_id: context.campaignId,
      snapshot: serializeStoredSnapshot(row)
    };
  }

  return Object.freeze({ preview, seal, list, get });
}

module.exports = {
  CUSTOMER_REPORT_CONTRACT_VERSION,
  CUSTOMER_REPORT_REDACTION_POLICY_VERSION,
  CustomerReportSnapshotServiceError,
  createCustomerReportSnapshotService
};

'use strict';

const crypto = require('node:crypto');
const {
  preparePerformanceContentImport,
  PerformanceContentImportServiceError
} = require('./performance_content_import_service');
const {
  calculatePerformanceMetrics,
  aggregateRatio,
  assessComparisonEligibility,
  MINIMUM_COMPARISON_COVERAGE
} = require('./performance_metrics_service');
const { getCampaignAccess: defaultGetCampaignAccess } = require('./campaign_access_service');

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;
const MAX_EXPORT_ROWS = 5000;
const MAX_QUERY_LENGTH = 160;
const MAX_TEXT_LENGTH = 500;
const PUBLIC_METRIC_KEYS = Object.freeze({
  observed_engagement_total: 'observedEngagement',
  core_view_er: 'coreViewEr',
  extended_view_er: 'extendedViewEr',
  impression_er: 'impressionEr',
  ctr: 'ctr',
  cvr: 'cvr'
});
const RESTRICTED_METRIC_KEYS = Object.freeze({
  total_campaign_cost: 'totalCampaignCost',
  paid_media_spend: 'paidMediaSpend',
  cpm: 'cpm',
  cpv: 'cpv',
  cpe: 'cpe',
  cpc: 'cpc',
  cpa: 'cpa',
  roi: 'roi',
  roas: 'roas',
  gross_margin_rate: 'grossMarginRate'
});
const OBSERVATION_FIELDS = Object.freeze([
  'views', 'impressions', 'likes', 'comments', 'saves', 'shares', 'clicks',
  'conversions', 'orders', 'visits', 'installs', 'leads', 'affiliate_sales'
]);
const COMMERCIAL_FIELDS = Object.freeze([
  'creator_fee', 'product_sample_cost', 'logistics_cost', 'paid_media_spend',
  'platform_agency_fee', 'other_cost', 'attributed_revenue', 'client_charge'
]);
const COST_FIELD_MAP = Object.freeze({
  creator_fee: 'creatorFee',
  product_sample_cost: 'productSampleCost',
  logistics_cost: 'logisticsCost',
  paid_media_spend: 'paidMediaSpend',
  platform_agency_fee: 'platformAgencyFee',
  other_cost: 'otherCost'
});
const ACTION_POLICIES = Object.freeze({
  PERF_VIEW: 'PERF_VIEW',
  PERF_CONTENT_MANAGE: 'PERF_CONTENT_MANAGE',
  PERF_COMMERCIAL_EDIT: 'PERF_COMMERCIAL_EDIT',
  PERF_COMMERCIAL_APPROVE: 'PERF_COMMERCIAL_APPROVE'
});
const INTEGRATION_PREVIEW_CONTRACT_VERSION = 'performance-integration-preview-v1';
const METRIC_IMPORT_CONTRACT_VERSION = 'performance-metric-import-v1';
const REVIEW_EVIDENCE_CONTRACT_VERSION = 'performance-review-evidence-v1';
const AI_REVIEW_DRAFT_CONTRACT_VERSION = 'performance-ai-review-draft-v1';
const AI_REVIEW_PROTOCOL_VERSION = 1;
const AI_REVIEW_EXPERIMENT_TYPES = Object.freeze({
  data_coverage: '补齐关键指标与统一观察时间，验证当前排名是否稳定。',
  cohort_comparison: '按平台、产品或达人分组对比当前指标，验证差异是否具有可重复性。',
  observation_timing: '在统一的后续观察窗口复测，避免不同观察时长影响当前比较。'
});
const REVIEW_RANKING_LIMIT = 3;
const REVIEW_BREAKDOWN_LIMIT = 5;
const METRIC_IMPORT_MAPPING_FIELDS = Object.freeze([
  'content_url', 'video_url', 'observed_at', ...OBSERVATION_FIELDS, 'correction_reason'
]);
const INTEGRATION_PREVIEW_SOURCES = Object.freeze([
  Object.freeze({
    id: 'manual',
    label: '手工录入',
    status: 'available',
    detail: '可登记视频链接，并录入视频表现与商业数据。',
    supports: Object.freeze(['content_registration', 'metric_input', 'commercial_input']),
    dispatch_available: false
  }),
  Object.freeze({
    id: 'csv_xlsx',
    label: 'CSV / XLSX 导入',
    status: 'available',
    detail: '可批量导入视频链接，也可为已监控视频追加指标快照。',
    supports: Object.freeze(['content_import', 'metric_input']),
    dispatch_available: false
  })
]);
function integrationPreviewField(sourceKey, sourceLabel, proposedTargetField, access) {
  return Object.freeze({
    source_key: sourceKey,
    source_label: sourceLabel,
    proposed_target_field: proposedTargetField,
    access: access || 'view'
  });
}
const INTEGRATION_PREVIEW_FIELDS = Object.freeze([
  integrationPreviewField('content.original_url', '视频链接', '视频链接'),
  integrationPreviewField('content.platform', '平台', '平台'),
  integrationPreviewField('content.creator_id', '达人 ID', '达人 ID'),
  integrationPreviewField('content.creator_name', '达人名称', '达人名称'),
  integrationPreviewField('content.product', '推广产品', '推广产品'),
  integrationPreviewField('content.tags', '内容标签', '内容标签'),
  integrationPreviewField('content.published_at', '发布日期', '发布日期'),
  integrationPreviewField('latest_observation.observed_at', '数据更新时间', '数据更新时间'),
  integrationPreviewField('latest_observation.views', '播放量', '播放量'),
  integrationPreviewField('latest_observation.impressions', '展示量', '展示量'),
  integrationPreviewField('latest_observation.likes', '点赞数', '点赞数'),
  integrationPreviewField('latest_observation.comments', '评论数', '评论数'),
  integrationPreviewField('latest_observation.saves', '收藏数', '收藏数'),
  integrationPreviewField('latest_observation.shares', '转发数', '转发数'),
  integrationPreviewField('latest_observation.clicks', '点击数', '点击数'),
  integrationPreviewField('latest_observation.conversions', '转化数', '转化数'),
  integrationPreviewField('metrics.observed_engagement_total', '互动总量', '互动总量'),
  integrationPreviewField('metrics.core_view_er', '互动率', '互动率'),
  integrationPreviewField('metrics.ctr', '点击率', '点击率'),
  integrationPreviewField('commercial.creator_fee', '视频花费', '视频花费', 'commercial'),
  integrationPreviewField('commercial.attributed_revenue', '归因收入', '归因收入', 'commercial'),
  integrationPreviewField('metrics.total_campaign_cost', '项目总成本', '项目总成本', 'commercial'),
  integrationPreviewField('metrics.cpm', 'CPM', 'CPM', 'commercial'),
  integrationPreviewField('metrics.cpc', 'CPC', 'CPC', 'commercial'),
  integrationPreviewField('metrics.roi', 'ROI', 'ROI', 'commercial'),
  integrationPreviewField('metrics.roas', 'ROAS', 'ROAS', 'commercial')
]);
const IMPORT_URL_ERROR_CODES = new Set([
  'PUBLICATION_URL_HTTPS_REQUIRED',
  'PUBLICATION_URL_INVALID',
  'PUBLICATION_URL_UNSUPPORTED',
  'PUBLICATION_URL_TOO_LONG'
]);

class PerformanceManualServiceError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'PerformanceManualServiceError';
    this.statusCode = statusCode;
    this.code = code;
    if (details !== undefined) this.details = details;
    Error.captureStackTrace(this, PerformanceManualServiceError);
  }
}

function serviceError(statusCode, code, message, details) {
  return new PerformanceManualServiceError(statusCode, code, message, details);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function canonicalId(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && String(parsed) === value ? parsed : null;
  }
  return null;
}

function boundedText(value, field, maximum, required) {
  if (value === undefined || value === null) {
    if (required) throw serviceError(400, 'PERFORMANCE_INPUT_INVALID', `${field} is required.`, { field });
    return null;
  }
  if (typeof value !== 'string') {
    throw serviceError(400, 'PERFORMANCE_INPUT_INVALID', `${field} must be text.`, { field });
  }
  const normalized = value.trim();
  if (required && !normalized) {
    throw serviceError(400, 'PERFORMANCE_INPUT_INVALID', `${field} is required.`, { field });
  }
  if (!normalized) return null;
  if (normalized.length > maximum || normalized.includes('\u0000')) {
    throw serviceError(400, 'PERFORMANCE_INPUT_INVALID', `${field} is invalid.`, { field });
  }
  return normalized;
}

function assertOnlyKeys(value, keys, code) {
  if (!isPlainObject(value)) {
    throw serviceError(400, code || 'PERFORMANCE_INPUT_INVALID', 'Input must be an object.');
  }
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw serviceError(400, code || 'PERFORMANCE_INPUT_INVALID', 'Input contains an unsupported field.', { field: key });
    }
  }
  return value;
}

function safeJson(value, fallback) {
  if (typeof value !== 'string') return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed === null || typeof parsed !== 'object' ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function isStrictIsoTimestamp(value) {
  return typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeTags(value) {
  if (value === undefined || value === null || value === '') return [];
  const values = Array.isArray(value) ? value : String(value).split(',');
  if (values.length > 30) {
    throw serviceError(400, 'PERFORMANCE_INPUT_INVALID', 'tags is too large.', { field: 'tags' });
  }
  const unique = new Set();
  values.forEach((item) => {
    const tag = boundedText(String(item), 'tags', 80, false);
    if (tag) unique.add(tag);
  });
  return [...unique];
}

function normalizeObservation(value) {
  if (value === undefined || value === null) return null;
  assertOnlyKeys(value, [...OBSERVATION_FIELDS, 'observed_at'], 'PERFORMANCE_OBSERVATION_INVALID');
  const output = {};
  for (const field of OBSERVATION_FIELDS) {
    if (!own(value, field) || value[field] === null || value[field] === '') continue;
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) {
      throw serviceError(400, 'PERFORMANCE_OBSERVATION_INVALID', `${field} must be a nonnegative integer.`, { field });
    }
    output[field] = value[field];
  }
  if (Object.keys(output).length === 0) {
    throw serviceError(400, 'PERFORMANCE_OBSERVATION_INVALID', 'At least one observation is required.');
  }
  const observedAt = own(value, 'observed_at') && value.observed_at !== '' && value.observed_at !== null
    ? boundedText(value.observed_at, 'observed_at', 40, true)
    : nowIso();
  if (!isStrictIsoTimestamp(observedAt)) {
    throw serviceError(400, 'PERFORMANCE_OBSERVATION_INVALID', 'observed_at must be a UTC ISO timestamp.', { field: 'observed_at' });
  }
  return { metrics: output, observedAt };
}

function normalizeCommercial(value) {
  if (value === undefined || value === null) return null;
  const fields = [
    'base_currency', ...COMMERCIAL_FIELDS, 'attribution_model', 'attribution_window'
  ];
  assertOnlyKeys(value, fields, 'PERFORMANCE_COMMERCIAL_INVALID');
  const present = fields.some((field) => own(value, field) && value[field] !== null && value[field] !== '');
  if (!present) return null;
  const currency = boundedText(value.base_currency, 'base_currency', 3, true);
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw serviceError(400, 'PERFORMANCE_COMMERCIAL_INVALID', 'base_currency must be a three-letter uppercase currency.', { field: 'base_currency' });
  }
  const output = { base_currency: currency };
  for (const field of COMMERCIAL_FIELDS) {
    if (!own(value, field) || value[field] === null || value[field] === '') continue;
    if (typeof value[field] !== 'number' || !Number.isFinite(value[field]) || value[field] < 0) {
      throw serviceError(400, 'PERFORMANCE_COMMERCIAL_INVALID', `${field} must be a nonnegative number.`, { field });
    }
    output[field] = value[field];
  }
  const model = boundedText(value.attribution_model, 'attribution_model', 80, false);
  const window = boundedText(value.attribution_window, 'attribution_window', 80, false);
  if ((model && !window) || (!model && window)) {
    throw serviceError(400, 'PERFORMANCE_COMMERCIAL_INVALID', 'Attribution model and window must be supplied together.');
  }
  if (model) {
    output.attribution_model = model;
    output.attribution_window = window;
  }
  return output;
}

function metricImportError(code, message, details) {
  return serviceError(400, code, message, details);
}

function metricImportMappingSnapshot(value) {
  let descriptors;
  try {
    if (!isPlainObject(value)) {
      throw metricImportError(
        'PERFORMANCE_METRIC_IMPORT_MAPPING_INVALID',
        'Metric import column mapping must be a plain object.',
        { field: 'column_mapping' }
      );
    }
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    if (error instanceof PerformanceManualServiceError) throw error;
    throw metricImportError(
      'PERFORMANCE_METRIC_IMPORT_MAPPING_INVALID',
      'Metric import column mapping cannot be inspected safely.',
      { field: 'column_mapping' }
    );
  }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length > METRIC_IMPORT_MAPPING_FIELDS.length || keys.some((key) => typeof key !== 'string' || !METRIC_IMPORT_MAPPING_FIELDS.includes(key))) {
    throw metricImportError(
      'PERFORMANCE_METRIC_IMPORT_MAPPING_INVALID',
      'Metric import column mapping contains an unsupported field.',
      { field: 'column_mapping' }
    );
  }
  const snapshot = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!Object.hasOwn(descriptor, 'value')) {
      throw metricImportError(
        'PERFORMANCE_METRIC_IMPORT_MAPPING_INVALID',
        'Metric import column mapping accessors are not supported.',
        { field: 'column_mapping' }
      );
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function normalizeMetricImportMapping(value) {
  const source = metricImportMappingSnapshot(value);
  const hasContentUrl = own(source, 'content_url');
  const hasVideoUrl = own(source, 'video_url');
  if (!hasContentUrl && !hasVideoUrl) {
    throw metricImportError(
      'PERFORMANCE_METRIC_IMPORT_URL_MAPPING_REQUIRED',
      'Metric import must map a content or video URL column.',
      { field: 'column_mapping.content_url' }
    );
  }
  if (hasContentUrl && hasVideoUrl) {
    throw metricImportError(
      'PERFORMANCE_METRIC_IMPORT_URL_MAPPING_AMBIGUOUS',
      'Metric import must map exactly one content or video URL column.',
      { field: 'column_mapping' }
    );
  }
  const normalized = {};
  const usedSourceColumns = new Set();
  for (const field of METRIC_IMPORT_MAPPING_FIELDS) {
    if (field === 'video_url') continue;
    const sourceField = field === 'content_url' && hasVideoUrl ? 'video_url' : field;
    if (!own(source, sourceField)) continue;
    const raw = source[sourceField];
    if (typeof raw !== 'string') {
      throw metricImportError(
        'PERFORMANCE_METRIC_IMPORT_MAPPING_INVALID',
        'Metric import column names must be text.',
        { field: `column_mapping.${field}` }
      );
    }
    const column = raw.trim();
    if (!column || column.length > 256 || column.includes('\u0000') || column === 'source_row_number') {
      throw metricImportError(
        'PERFORMANCE_METRIC_IMPORT_MAPPING_INVALID',
        'Metric import column names are invalid.',
        { field: `column_mapping.${field}` }
      );
    }
    if (usedSourceColumns.has(column)) {
      throw metricImportError(
        'PERFORMANCE_METRIC_IMPORT_MAPPING_DUPLICATE',
        'Each metric import field must use a distinct source column.',
        { field: 'column_mapping' }
      );
    }
    usedSourceColumns.add(column);
    normalized[field] = column;
  }
  if (!OBSERVATION_FIELDS.some((field) => own(normalized, field))) {
    throw metricImportError(
      'PERFORMANCE_METRIC_IMPORT_MAPPING_REQUIRED',
      'Metric import must map at least one performance metric column.',
      { field: 'column_mapping' }
    );
  }
  if (!own(normalized, 'observed_at')) {
    throw metricImportError(
      'PERFORMANCE_METRIC_IMPORT_TIMESTAMP_MAPPING_REQUIRED',
      'Metric import must map a data update time column.',
      { field: 'column_mapping.observed_at' }
    );
  }
  return normalized;
}

function metricImportRowError(row, code, message, field) {
  const details = { source_row_number: row && row.source_row_number ? row.source_row_number : null };
  if (field) details.field = field;
  return {
    index: row && Number.isSafeInteger(row.index) ? row.index : null,
    source_row_number: details.source_row_number,
    outcome: 'rejected',
    status: 'rejected',
    publication_id: null,
    observation_id: null,
    observed_at: null,
    error: { code, statusCode: 400, message, details }
  };
}

function metricImportDuplicateRow(row, publicationId, observationId) {
  return {
    index: row && Number.isSafeInteger(row.index) ? row.index : null,
    source_row_number: row && row.source_row_number ? row.source_row_number : null,
    outcome: 'duplicate',
    status: 'duplicate',
    publication_id: publicationId || null,
    observation_id: observationId || null,
    observed_at: null,
    error: null
  };
}

function metricImportAcceptedRow(row, publicationId, observationId, observedAt) {
  return {
    index: row && Number.isSafeInteger(row.index) ? row.index : null,
    source_row_number: row && row.source_row_number ? row.source_row_number : null,
    outcome: 'accepted',
    status: 'accepted',
    publication_id: publicationId,
    observation_id: observationId,
    observed_at: observedAt,
    error: null
  };
}

function parseMetricImportCount(value, field, row) {
  if (value === undefined || value === null || value === '') return undefined;
  if (Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string') {
    const normalized = value.trim().replace(/,/g, '');
    if (/^(?:0|[1-9][0-9]{0,15})$/.test(normalized)) {
      const parsed = Number(normalized);
      if (Number.isSafeInteger(parsed)) return parsed;
    }
  }
  throw metricImportError(
    'PERFORMANCE_METRIC_IMPORT_ROW_INVALID',
    'Metric values must be nonnegative integers.',
    { field, source_row_number: row.source_row_number }
  );
}

function normalizeMetricImportRow(row, customFields, mapping) {
  const observation = {};
  for (const field of OBSERVATION_FIELDS) {
    if (!own(mapping, field)) continue;
    const value = parseMetricImportCount(customFields[field], field, row);
    if (value !== undefined) observation[field] = value;
  }
  if (Object.keys(observation).length === 0) {
    throw metricImportError(
      'PERFORMANCE_METRIC_IMPORT_ROW_INVALID',
      'At least one metric value is required for every imported row.',
      { source_row_number: row.source_row_number }
    );
  }
  const rawObservedAt = customFields.observed_at;
  if (typeof rawObservedAt !== 'string' || !isStrictIsoTimestamp(rawObservedAt.trim())) {
    throw metricImportError(
      'PERFORMANCE_METRIC_IMPORT_ROW_INVALID',
      'Data update time must be a UTC ISO timestamp.',
      { field: 'observed_at', source_row_number: row.source_row_number }
    );
  }
  const observedAt = rawObservedAt.trim();
  let correctionReason = null;
  if (own(mapping, 'correction_reason')) {
    const raw = customFields.correction_reason;
    if (raw !== undefined && raw !== null && raw !== '') {
      if (typeof raw !== 'string') {
        throw metricImportError(
          'PERFORMANCE_METRIC_IMPORT_ROW_INVALID',
          'Correction reason must be text.',
          { field: 'correction_reason', source_row_number: row.source_row_number }
        );
      }
      correctionReason = raw.trim();
      if (!correctionReason || correctionReason.length > MAX_TEXT_LENGTH || correctionReason.includes('\u0000')) {
        throw metricImportError(
          'PERFORMANCE_METRIC_IMPORT_ROW_INVALID',
          'Correction reason is invalid.',
          { field: 'correction_reason', source_row_number: row.source_row_number }
        );
      }
    }
  }
  return { metrics: observation, observedAt, correctionReason };
}

function accessCapabilities(access) {
  const privileged = access && (access.role === 'org_admin' || access.role === 'owner');
  return Object.freeze({
    policies: ACTION_POLICIES,
    can_view: Boolean(access && access.permissions && access.permissions.read),
    can_manage_content: Boolean(access && access.permissions && access.permissions.write),
    can_edit_commercial: Boolean(privileged && access && access.permissions && access.permissions.write),
    can_approve_commercial: Boolean(privileged && access && access.permissions && access.permissions.write),
    can_view_commercial: Boolean(privileged)
  });
}

function apiMetrics(metrics, includeFinancial) {
  const output = {};
  for (const [apiKey, engineKey] of Object.entries(PUBLIC_METRIC_KEYS)) {
    output[apiKey] = metrics[engineKey];
  }
  if (includeFinancial) {
    for (const [apiKey, engineKey] of Object.entries(RESTRICTED_METRIC_KEYS)) {
      output[apiKey] = metrics[engineKey];
    }
  }
  return output;
}

function rowCommercialToMetricInput(row) {
  if (!row || row.manual_id === null || row.manual_id === undefined) return {};
  const commercial = safeJson(row.commercial_json, {});
  const approved = row.approval_state === 'approved';
  const provenance = approved ? {
    approvalId: `performance-manual-${row.manual_id}`,
    approvedBy: `user-${row.approved_by}`,
    approvedAt: row.approved_at,
    policyVersion: 'phase7b.1a-manual-confirmation'
  } : {};
  const money = (key) => {
    if (!own(commercial, key)) return undefined;
    return {
      amount: commercial[key],
      currency: commercial.base_currency,
      approvalState: approved ? 'approved' : 'draft',
      ...provenance
    };
  };
  const costs = {};
  Object.entries(COST_FIELD_MAP).forEach(([storedKey, engineKey]) => {
    const value = money(storedKey);
    if (value) costs[engineKey] = value;
  });
  const output = {
    baseCurrency: commercial.base_currency,
    costs,
    attributedRevenue: money('attributed_revenue'),
    clientCharge: money('client_charge')
  };
  if (commercial.attribution_model && commercial.attribution_window) {
    output.attribution = {
      model: commercial.attribution_model,
      window: commercial.attribution_window,
      approvalState: approved ? 'approved' : 'draft',
      ...provenance
    };
  }
  return output;
}

function calculateRowMetrics(row) {
  const observations = row && row.metrics_json ? safeJson(row.metrics_json, {}) : {};
  return calculatePerformanceMetrics({
    observations,
    engagementComponents: ['likes', 'comments', 'saves', 'shares'],
    commercial: rowCommercialToMetricInput(row),
    costBasis: 'total_campaign_cost',
    auditLineage: row && row.observation_id ? [{
      observation_id: row.observation_id,
      publication_id: row.id,
      observed_at: row.observed_at
    }] : []
  });
}

function serializePublication(row, capabilities) {
  const metrics = calculateRowMetrics(row);
  const latestObservation = row.observation_id === null || row.observation_id === undefined ? null : {
    id: row.observation_id,
    observed_at: row.observed_at,
    source_mode: row.observation_source_mode,
    ...safeJson(row.metrics_json, {})
  };
  if (latestObservation && capabilities.can_view_commercial) {
    latestObservation.correction_reason = row.observation_correction_reason;
  }
  const output = {
    id: row.id,
    campaign_id: row.campaign_id,
    original_url: row.original_url,
    canonical_url: row.canonical_url,
    canonical_identity: row.canonical_identity,
    platform: row.platform,
    platform_content_id: row.platform_content_id,
    creator_id: row.creator_id,
    creator_name: row.creator_name,
    product: row.product,
    tags: safeJson(row.tags_json, []),
    custom_fields: safeJson(row.custom_fields_json, {}),
    source_mode: row.source_mode,
    published_at: row.published_at,
    created_at: row.created_at,
    latest_observation: latestObservation,
    metrics: apiMetrics(metrics, capabilities.can_view_commercial)
  };
  if (capabilities.can_view_commercial && row.manual_id !== null && row.manual_id !== undefined) {
    output.commercial = {
      id: row.manual_id,
      approval_state: row.approval_state,
      correction_reason: row.manual_correction_reason,
      approved_at: row.approved_at,
      ...safeJson(row.commercial_json, {})
    };
  }
  return output;
}

function reviewMetricValue(content, metric) {
  if (!content || !metric) return null;
  if (metric === 'core_view_er') {
    const derived = content.metrics && content.metrics.core_view_er;
    if (!derived || derived.available !== true || !Number.isFinite(Number(derived.value))) return null;
    return {
      metric,
      value: Number(derived.value),
      source: 'derived',
      definition_version: derived.definitionVersion || null
    };
  }
  const observation = content.latest_observation;
  const value = observation && observation[metric];
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return { metric, value, source: 'latest_observation', definition_version: null };
}

function reviewContentReference(content) {
  return {
    id: content.id,
    original_url: content.original_url,
    canonical_url: content.canonical_url,
    platform: content.platform,
    creator_id: content.creator_id,
    creator_name: content.creator_name,
    product: content.product,
    tags: Array.isArray(content.tags) ? content.tags.slice() : [],
    published_at: content.published_at
  };
}

function reviewObservationReference(content) {
  const observation = content && content.latest_observation;
  if (!observation) return null;
  return {
    id: observation.id,
    observed_at: observation.observed_at,
    source_mode: observation.source_mode
  };
}

function reviewCoverage(contents, metric) {
  const totalRecords = contents.length;
  const availableRecords = contents.reduce((count, content) => (
    reviewMetricValue(content, metric) ? count + 1 : count
  ), 0);
  return {
    metric,
    available_records: availableRecords,
    total_records: totalRecords,
    coverage: totalRecords === 0 ? 0 : availableRecords / totalRecords
  };
}

function reviewMetricCoverage(contents) {
  return OBSERVATION_FIELDS.map((metric) => reviewCoverage(contents, metric));
}

function reviewRankingEligibility(contents, metric, scored) {
  const coverage = contents.length === 0 ? 0 : scored.length / contents.length;
  const common = {
    minimum_coverage: MINIMUM_COMPARISON_COVERAGE,
    coverage,
    comparable_records: scored.length,
    total_records: contents.length,
    missing_records: contents.length - scored.length
  };
  if (metric === 'core_view_er') {
    const engineEligibility = assessComparisonEligibility(contents.map((content) => (
      content.metrics && content.metrics.core_view_er
    )));
    const eligible = scored.length >= 2 && engineEligibility.eligible === true;
    return Object.assign({}, common, {
      eligible,
      coverage: engineEligibility.coverage,
      comparable_records: engineEligibility.comparableRecordCount,
      missing_records: engineEligibility.excludedRecordCount,
      reason: eligible ? null : (
        scored.length < 2
          ? { code: 'insufficient_comparable_records', minimum_records: 2, actual_records: scored.length }
          : engineEligibility.reason || { code: 'insufficient_metric_coverage' }
      ),
      signature: engineEligibility.signature || null
    });
  }
  const eligible = scored.length >= 2 && coverage >= MINIMUM_COMPARISON_COVERAGE;
  return Object.assign({}, common, {
    eligible,
    reason: eligible ? null : (
      scored.length < 2
        ? { code: 'insufficient_comparable_records', minimum_records: 2, actual_records: scored.length }
        : {
          code: 'insufficient_metric_coverage',
          minimum_coverage: MINIMUM_COMPARISON_COVERAGE,
          actual_coverage: coverage
        }
    ),
    signature: null
  });
}

function reviewRankingEntry(item, rank) {
  return {
    rank,
    content: reviewContentReference(item.content),
    metric: item.metric,
    evidence: { latest_observation: reviewObservationReference(item.content) }
  };
}

function buildReviewRankings(contents, metric) {
  const scored = contents.map((content) => ({ content, metric: reviewMetricValue(content, metric) }))
    .filter((item) => item.metric !== null);
  const eligibility = reviewRankingEligibility(contents, metric, scored);
  const status = eligibility.eligible
    ? 'available'
    : (scored.length === 0 ? 'no_observed_metric' : 'insufficient_coverage');
  if (!eligibility.eligible) {
    return {
      status,
      metric,
      eligibility,
      comparable_records: eligibility.comparable_records,
      missing_records: eligibility.missing_records,
      top_contents: [],
      bottom_contents: []
    };
  }
  const descending = scored.slice().sort((left, right) => (
    right.metric.value - left.metric.value || left.content.id - right.content.id
  ));
  const ascending = scored.slice().sort((left, right) => (
    left.metric.value - right.metric.value || left.content.id - right.content.id
  ));
  const cohortSize = Math.min(REVIEW_RANKING_LIMIT, Math.floor(scored.length / 2));
  return {
    status,
    metric,
    eligibility,
    comparable_records: eligibility.comparable_records,
    missing_records: eligibility.missing_records,
    top_contents: descending.slice(0, cohortSize)
      .map((item, index) => reviewRankingEntry(item, index + 1)),
    bottom_contents: ascending.slice(0, cohortSize)
      .map((item, index) => reviewRankingEntry(item, index + 1))
  };
}

function reviewGroupLabel(content, dimension) {
  if (dimension === 'platform') return content.platform || 'unassigned';
  if (dimension === 'product') return content.product || 'unassigned';
  return content.creator_name || content.creator_id || 'unassigned';
}

function reviewGroupMetric(contents, metric) {
  const coverage = reviewCoverage(contents, metric);
  if (metric === 'core_view_er') {
    const sourceMetrics = contents.map((content) => content.metrics && content.metrics.core_view_er);
    const aggregate = aggregateRatio(sourceMetrics);
    const eligibility = assessComparisonEligibility(sourceMetrics);
    const available = aggregate.available === true && eligibility.coverage >= MINIMUM_COMPARISON_COVERAGE;
    return {
      metric,
      aggregation: 'weighted_ratio',
      available,
      value: available ? aggregate.value : null,
      coverage: coverage.coverage,
      available_records: coverage.available_records,
      total_records: coverage.total_records,
      reason: available ? null : (
        aggregate.reason || eligibility.reason || { code: 'insufficient_metric_coverage' }
      )
    };
  }
  const values = contents.map((content) => reviewMetricValue(content, metric))
    .filter((value) => value !== null)
    .map((value) => value.value);
  const available = values.length > 0 && coverage.coverage >= MINIMUM_COMPARISON_COVERAGE;
  return {
    metric,
    aggregation: 'sum',
    available,
    value: available ? values.reduce((sum, value) => sum + value, 0) : null,
    coverage: coverage.coverage,
    available_records: coverage.available_records,
    total_records: coverage.total_records,
    reason: available ? null : (
      values.length === 0
        ? { code: 'no_observed_metric' }
        : {
          code: 'insufficient_metric_coverage',
          minimum_coverage: MINIMUM_COMPARISON_COVERAGE,
          actual_coverage: coverage.coverage
        }
    )
  };
}

function buildReviewBreakdown(contents, dimension, metric) {
  const groups = new Map();
  contents.forEach((content) => {
    const label = reviewGroupLabel(content, dimension);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(content);
  });
  return [...groups.entries()].map(([label, items]) => {
    const observedTimes = items.map((content) => (
      content.latest_observation && content.latest_observation.observed_at
    )).filter(Boolean).sort();
    return {
      key: label,
      label,
      content_count: items.length,
      observed_content_count: items.filter((content) => content.latest_observation !== null).length,
      latest_observed_at: observedTimes.length ? observedTimes[observedTimes.length - 1] : null,
      metric: reviewGroupMetric(items, metric)
    };
  }).sort((left, right) => {
    const leftValue = left.metric && left.metric.available ? left.metric.value : null;
    const rightValue = right.metric && right.metric.available ? right.metric.value : null;
    if (leftValue !== null && rightValue !== null && rightValue !== leftValue) return rightValue - leftValue;
    if (leftValue !== null && rightValue === null) return -1;
    if (leftValue === null && rightValue !== null) return 1;
    if (right.content_count !== left.content_count) return right.content_count - left.content_count;
    return left.label < right.label ? -1 : (left.label > right.label ? 1 : 0);
  }).slice(0, REVIEW_BREAKDOWN_LIMIT);
}

function reviewSourceModeCounts(contents) {
  const counts = {};
  contents.forEach((content) => {
    const sourceMode = content.latest_observation && content.latest_observation.source_mode;
    if (!sourceMode) return;
    counts[sourceMode] = (counts[sourceMode] || 0) + 1;
  });
  return counts;
}

function reviewObservationWindow(contents) {
  const observedAt = contents.map((content) => (
    content.latest_observation && content.latest_observation.observed_at
  )).filter(Boolean).sort();
  return {
    min_observed_at: observedAt.length ? observedAt[0] : null,
    max_observed_at: observedAt.length ? observedAt[observedAt.length - 1] : null,
    freshness_policy: 'not_configured'
  };
}

function reviewLimitations(records, rankings, capabilities) {
  const limits = [
    {
      code: 'metadata_only',
      detail: '本次复盘只使用活动内当前可见的结构化数据和指标快照。'
    },
    {
      code: 'manual_or_csv_only',
      detail: '当前数据来源仅包含手工录入和 CSV/XLSX 导入，不包含服务商自动采集。'
    },
    {
      code: 'feishu_sync_disabled',
      detail: '本版本不读取或写入飞书数据。'
    },
    {
      code: 'media_evidence_not_collected',
      detail: '未抓取、存储或分析视频内容、钩子、风格和画面。'
    },
    {
      code: 'causal_diagnosis_not_available',
      detail: '当前仅提供数据比较，不对内容效果原因作因果判断。'
    }
  ];
  if (records.total === 0) {
    limits.push({ code: 'no_registered_content', detail: '当前活动尚未登记任何监控内容。' });
  } else if (records.active_with_observations === 0) {
    limits.push({ code: 'no_media_metrics', detail: '当前活动尚未录入可用于复盘的内容指标。' });
  }
  if (rankings.status !== 'available') {
    limits.push({
      code: 'ranking_coverage_insufficient',
      detail: '排序依据未达到可比较覆盖率，当前不会标记最佳或最弱内容。'
    });
  }
  if (!capabilities.can_view_commercial) {
    limits.push({
      code: 'commercial_metrics_restricted',
      detail: '费用、收益、ROI 和 ROAS 仅向活动负责人或组织管理员展示。'
    });
  }
  return limits;
}

function exportMetricValue(content, key) {
  const metric = content && content.metrics && content.metrics[key];
  return metric && metric.available !== false && Number.isFinite(Number(metric.value)) ? metric.value : '';
}

function csvCell(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  const text = String(value).replace(/[\r\n]+/g, ' ').replace(/\u0000/g, '');
  const formulaSafe = /^\s*[=+\-@]/.test(text) ? "'" + text : text;
  return '"' + formulaSafe.replace(/"/g, '""') + '"';
}

function performanceExportColumns(canViewCommercial) {
  const columns = [
    ['视频链接', (content) => content.original_url],
    ['规范链接', (content) => content.canonical_url],
    ['平台', (content) => content.platform],
    ['内容 ID', (content) => content.platform_content_id],
    ['达人 ID', (content) => content.creator_id],
    ['达人名称', (content) => content.creator_name],
    ['推广产品', (content) => content.product],
    ['内容标签', (content) => Array.isArray(content.tags) ? content.tags.join(' | ') : ''],
    ['发布日期', (content) => content.published_at],
    ['数据来源', (content) => content.source_mode],
    ['最近观测时间', (content) => content.latest_observation && content.latest_observation.observed_at],
    ['播放量', (content) => content.latest_observation && content.latest_observation.views],
    ['展示量', (content) => content.latest_observation && content.latest_observation.impressions],
    ['点赞数', (content) => content.latest_observation && content.latest_observation.likes],
    ['评论数', (content) => content.latest_observation && content.latest_observation.comments],
    ['收藏数', (content) => content.latest_observation && content.latest_observation.saves],
    ['转发数', (content) => content.latest_observation && content.latest_observation.shares],
    ['点击数', (content) => content.latest_observation && content.latest_observation.clicks],
    ['转化数', (content) => content.latest_observation && content.latest_observation.conversions],
    ['互动率', (content) => exportMetricValue(content, 'core_view_er')]
  ];
  if (!canViewCommercial) return columns;
  return columns.concat([
    ['确认状态', (content) => content.commercial && content.commercial.approval_state],
    ['视频花费', (content) => content.commercial && content.commercial.creator_fee],
    ['寄样成本', (content) => content.commercial && content.commercial.product_sample_cost],
    ['物流成本', (content) => content.commercial && content.commercial.logistics_cost],
    ['付费投流', (content) => content.commercial && content.commercial.paid_media_spend],
    ['服务费', (content) => content.commercial && content.commercial.platform_agency_fee],
    ['其他成本', (content) => content.commercial && content.commercial.other_cost],
    ['归因收入', (content) => content.commercial && content.commercial.attributed_revenue],
    ['客户报价', (content) => content.commercial && content.commercial.client_charge],
    ['币种', (content) => content.commercial && content.commercial.base_currency],
    ['归因模型', (content) => content.commercial && content.commercial.attribution_model],
    ['归因窗口', (content) => content.commercial && content.commercial.attribution_window],
    ['CPM', (content) => exportMetricValue(content, 'cpm')],
    ['CPC', (content) => exportMetricValue(content, 'cpc')],
    ['ROI', (content) => exportMetricValue(content, 'roi')],
    ['ROAS', (content) => exportMetricValue(content, 'roas')]
  ]);
}

function performanceExportCsv(contents, canViewCommercial) {
  const columns = performanceExportColumns(canViewCommercial);
  const header = columns.map(([label]) => csvCell(label)).join(',');
  const rows = contents.map((content) => columns.map(([, value]) => csvCell(value(content))).join(','));
  return '\ufeff' + [header].concat(rows).join('\r\n') + '\r\n';
}

function normalizeExportScope(value) {
  if (value === undefined || value === null || value === '') return 'filtered';
  if (value === 'filtered' || value === 'all') return value;
  throw serviceError(400, 'PERFORMANCE_EXPORT_SCOPE_INVALID', 'Export scope is invalid.', { field: 'scope' });
}

function integerLimit(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_SIZE) {
    throw serviceError(400, 'PERFORMANCE_QUERY_INVALID', 'limit is invalid.', { field: 'limit' });
  }
  return parsed;
}

function integerOffset(value) {
  if (value === undefined || value === null || value === '') return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 1000000) {
    throw serviceError(400, 'PERFORMANCE_QUERY_INVALID', 'offset is invalid.', { field: 'offset' });
  }
  return parsed;
}

function normalizeQuery(value) {
  const query = value === undefined || value === null ? {} : value;
  assertOnlyKeys(query, ['q', 'platform', 'tag', 'limit', 'offset', 'top_metric'], 'PERFORMANCE_QUERY_INVALID');
  const q = boundedText(query.q, 'q', MAX_QUERY_LENGTH, false) || '';
  const platform = boundedText(query.platform, 'platform', 32, false) || '';
  const tag = boundedText(query.tag, 'tag', 80, false) || '';
  const topMetric = boundedText(query.top_metric, 'top_metric', 40, false) || 'views';
  const allowedTopMetrics = new Set(['views', 'likes', 'comments', 'saves', 'shares', 'clicks', 'core_view_er']);
  if (!allowedTopMetrics.has(topMetric)) {
    throw serviceError(400, 'PERFORMANCE_QUERY_INVALID', 'top_metric is invalid.', { field: 'top_metric' });
  }
  return {
    q,
    platform,
    tag,
    topMetric,
    limit: integerLimit(query.limit, DEFAULT_PAGE_SIZE),
    offset: integerOffset(query.offset)
  };
}

function createPerformanceManualService(db, options = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('A SQLite database is required.');
  }
  const getCampaignAccess = options.getCampaignAccess || defaultGetCampaignAccess;

  function requireAccess(userIdValue, campaignIdValue, mode) {
    const userId = canonicalId(userIdValue);
    const campaignId = canonicalId(campaignIdValue);
    if (userId === null || campaignId === null) {
      throw serviceError(400, 'PERFORMANCE_CAMPAIGN_INVALID', 'Campaign or user is invalid.');
    }
    const access = getCampaignAccess(db, { userId, campaignId });
    if (!access || access.ok !== true) {
      throw serviceError(
        access && access.status ? access.status : 403,
        access && access.code ? access.code : 'PERFORMANCE_FORBIDDEN',
        'Campaign access is forbidden.'
      );
    }
    const capabilities = accessCapabilities(access);
    if (mode === 'view' && !capabilities.can_view) {
      throw serviceError(403, 'PERFORMANCE_FORBIDDEN', 'Performance access is forbidden.');
    }
    if (mode === 'content' && !capabilities.can_manage_content) {
      throw serviceError(403, 'PERFORMANCE_CONTENT_FORBIDDEN', 'Content management is forbidden.');
    }
    if (mode === 'commercial' && !capabilities.can_edit_commercial) {
      throw serviceError(403, 'PERFORMANCE_COMMERCIAL_FORBIDDEN', 'Commercial input is forbidden.');
    }
    if (mode === 'approve' && !capabilities.can_approve_commercial) {
      throw serviceError(403, 'PERFORMANCE_COMMERCIAL_APPROVAL_FORBIDDEN', 'Commercial confirmation is forbidden.');
    }
    return { userId, campaignId, access, capabilities };
  }

  function writeAudit(userId, action, details) {
    const table = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='activity_log'").get();
    if (!table) return;
    db.prepare(`INSERT INTO activity_log (user_id,action,module,details,ip_address) VALUES (?,?,?,?,?)`)
      .run(userId, action, 'performance', JSON.stringify(details), null);
  }

  function insertDraft(draft, context) {
    try {
      const result = db.prepare(`
        INSERT INTO campaign_publications (
          org_id,campaign_id,canonical_identity,original_url,canonical_url,platform,
          platform_content_id,creator_id,creator_name,product,tags_json,custom_fields_json,
          search_payload_json,source_mode,source_file_hash,mapping_version,source_row_number,
          published_at,created_by
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        context.orgId,
        context.campaignId,
        draft.canonical_identity,
        draft.original_url,
        draft.canonical_url,
        draft.platform || 'custom',
        draft.platform_content_id || null,
        draft.creator_id || null,
        draft.creator_name || null,
        draft.product || null,
        JSON.stringify(draft.tags || []),
        JSON.stringify(draft.custom_fields || {}),
        JSON.stringify(draft.search_payload || {}),
        context.sourceMode,
        context.sourceFileHash || null,
        context.mappingVersion || null,
        draft.source_row_number || null,
        draft.published_at || null,
        context.userId
      );
      return Number(result.lastInsertRowid);
    } catch (error) {
      if (/UNIQUE constraint failed: campaign_publications\.org_id, campaign_publications\.campaign_id, campaign_publications\.canonical_identity/i.test(error.message || '')) {
        throw serviceError(409, 'PERFORMANCE_CONTENT_DUPLICATE', 'This canonical content link already belongs to the campaign.');
      }
      throw error;
    }
  }

  function currentRows(context, query, paged) {
    const where = ['publication.org_id=?', 'publication.campaign_id=?'];
    const params = [context.access.campaign.org_id, context.campaignId];
    if (query.platform) {
      where.push('publication.platform=?');
      params.push(query.platform.toLowerCase());
    }
    if (query.tag) {
      where.push('lower(publication.tags_json) LIKE ?');
      params.push('%' + query.tag.toLowerCase() + '%');
    }
    if (query.q) {
      const needle = '%' + query.q.toLowerCase() + '%';
      where.push(`(
        lower(publication.original_url) LIKE ? OR lower(publication.canonical_url) LIKE ? OR
        lower(coalesce(publication.creator_id,'')) LIKE ? OR lower(coalesce(publication.creator_name,'')) LIKE ? OR
        lower(coalesce(publication.product,'')) LIKE ? OR lower(publication.tags_json) LIKE ? OR
        lower(publication.search_payload_json) LIKE ?
      )`);
      params.push(needle, needle, needle, needle, needle, needle, needle);
    }
    const total = db.prepare(`SELECT COUNT(*) AS count FROM campaign_publications publication WHERE ${where.join(' AND ')}`)
      .get(...params).count;
    const limitClause = paged ? ' LIMIT ? OFFSET ?' : '';
    const listParams = paged ? [...params, query.limit, query.offset] : params;
    const rows = db.prepare(`
      SELECT
        publication.*,
        observation.id AS observation_id,observation.source_mode AS observation_source_mode,
        observation.metrics_json,observation.observed_at,
        observation.correction_reason AS observation_correction_reason,
        manual.id AS manual_id,manual.commercial_json,manual.approval_state,
        manual.correction_reason AS manual_correction_reason,manual.approved_by,manual.approved_at
      FROM campaign_publications publication
      LEFT JOIN performance_metric_observations observation ON observation.id=(
        SELECT current_observation.id
        FROM performance_metric_observations current_observation
        WHERE current_observation.org_id=publication.org_id
          AND current_observation.campaign_id=publication.campaign_id
          AND current_observation.publication_id=publication.id
        ORDER BY current_observation.observed_at DESC,current_observation.id DESC LIMIT 1
      )
      LEFT JOIN performance_manual_inputs manual ON manual.id=(
        SELECT current_input.id
        FROM performance_manual_inputs current_input
        WHERE current_input.org_id=publication.org_id
          AND current_input.campaign_id=publication.campaign_id
          AND current_input.publication_id=publication.id
        ORDER BY current_input.created_at DESC,current_input.id DESC LIMIT 1
      )
      WHERE ${where.join(' AND ')}
      ORDER BY publication.created_at DESC,publication.id DESC${limitClause}
    `).all(...listParams);
    return { total, rows };
  }

  function publicationById(context, contentIdValue) {
    const contentId = canonicalId(contentIdValue);
    if (contentId === null) {
      throw serviceError(400, 'PERFORMANCE_CONTENT_INVALID', 'Content id is invalid.');
    }
    const row = db.prepare(`
      SELECT id FROM campaign_publications WHERE id=? AND org_id=? AND campaign_id=?
    `).get(contentId, context.access.campaign.org_id, context.campaignId);
    if (!row) throw serviceError(404, 'PERFORMANCE_CONTENT_NOT_FOUND', 'Content was not found.');
    return contentId;
  }

  function createContent(input) {
    const context = requireAccess(input && input.userId, input && input.campaignId, 'content');
    const body = assertOnlyKeys((input && input.body) || {}, [
      'url', 'creator_id', 'creator_name', 'product', 'tags', 'published_at'
    ], 'PERFORMANCE_CONTENT_INVALID');
    const url = boundedText(body.url, 'url', 4096, true);
    const prepared = preparePerformanceContentImport({
      campaign_id: String(context.campaignId),
      mapping_version: 'manual-entry-v1',
      provenance: { source_mode: 'csv_xlsx', file_hash: sha256('manual:' + url) },
      column_mapping: {
        content_url: 'Content URL',
        creator_id: 'Creator ID',
        creator_name: 'Creator Name',
        tags: 'Tags',
        product: 'Product',
        published_at: 'Published At'
      },
      rows: [{
        source_row_number: 1,
        'Content URL': url,
        'Creator ID': body.creator_id || '',
        'Creator Name': body.creator_name || '',
        Tags: normalizeTags(body.tags),
        Product: body.product || '',
        'Published At': body.published_at || ''
      }]
    });
    const draft = prepared.drafts[0];
    if (!draft) {
      const rejected = prepared.rows[0] && prepared.rows[0].error;
      throw serviceError(
        rejected && rejected.statusCode ? rejected.statusCode : 400,
        rejected && rejected.code ? rejected.code : 'PERFORMANCE_CONTENT_INVALID',
        rejected && rejected.message ? rejected.message : 'Content URL is invalid.'
      );
    }
    const id = db.transaction(() => insertDraft(draft, {
      orgId: context.access.campaign.org_id,
      campaignId: context.campaignId,
      userId: context.userId,
      sourceMode: 'manual',
      sourceFileHash: null,
      mappingVersion: 'manual-entry-v1'
    }))();
    writeAudit(context.userId, 'performance_content_create', { campaign_id: context.campaignId, publication_id: id });
    const row = currentRows(context, { q: '', platform: '', tag: '', limit: 1, offset: 0 }, false)
      .rows.find((item) => item.id === id);
    return { content: serializePublication(row, context.capabilities), capabilities: context.capabilities };
  }

  function importContentRows(input) {
    const context = requireAccess(input && input.userId, input && input.campaignId, 'content');
    const body = assertOnlyKeys((input && input.body) || {}, [
      'mapping_version', 'provenance', 'column_mapping', 'rows'
    ], 'PERFORMANCE_IMPORT_INVALID');
    let prepared;
    try {
      prepared = preparePerformanceContentImport({
        campaign_id: String(context.campaignId),
        mapping_version: body.mapping_version,
        provenance: body.provenance,
        column_mapping: body.column_mapping,
        rows: body.rows
      });
    } catch (error) {
      if (error instanceof PerformanceContentImportServiceError) {
        throw serviceError(error.statusCode || 400, error.code, error.message, error.details);
      }
      throw error;
    }

    const existing = new Set();
    if (prepared.drafts.length > 0) {
      const identities = prepared.drafts.map((draft) => draft.canonical_identity);
      const placeholders = identities.map(() => '?').join(',');
      db.prepare(`
        SELECT canonical_identity FROM campaign_publications
        WHERE org_id=? AND campaign_id=? AND canonical_identity IN (${placeholders})
      `).all(context.access.campaign.org_id, context.campaignId, ...identities)
        .forEach((row) => existing.add(row.canonical_identity));
    }

    const inserted = [];
    const dbDuplicates = new Set();
    db.transaction(() => {
      for (const draft of prepared.drafts) {
        if (existing.has(draft.canonical_identity)) {
          dbDuplicates.add(draft.source_row_number);
          continue;
        }
        const id = insertDraft(draft, {
          orgId: context.access.campaign.org_id,
          campaignId: context.campaignId,
          userId: context.userId,
          sourceMode: 'csv_xlsx',
          sourceFileHash: prepared.file_hash,
          mappingVersion: prepared.mapping_version
        });
        inserted.push(id);
        existing.add(draft.canonical_identity);
      }
    })();

    const rows = prepared.rows.map((row) => {
      if (!dbDuplicates.has(row.source_row_number)) {
        if (!row.error || !IMPORT_URL_ERROR_CODES.has(row.error.code)) return row;
        return Object.assign({}, row, {
          error: Object.assign({}, row.error, {
            code: 'PERFORMANCE_CONTENT_IMPORT_URL_INVALID',
            message: 'Content URL is invalid or unsupported.'
          })
        });
      }
      return Object.assign({}, row, {
        outcome: 'duplicate',
        status: 'duplicate',
        draft: null,
        error: {
          code: 'PERFORMANCE_CONTENT_DUPLICATE',
          statusCode: 409,
          message: 'This canonical content link already belongs to the campaign.',
          details: { source_row_number: row.source_row_number }
        }
      });
    });
    const duplicateCount = prepared.duplicate_count + dbDuplicates.size;
    const result = {
      contract_version: prepared.contract_version,
      campaign_id: context.campaignId,
      source_mode: 'csv_xlsx',
      file_hash: prepared.file_hash,
      mapping_version: prepared.mapping_version,
      total_count: prepared.total_count,
      accepted_count: inserted.length,
      duplicate_count: duplicateCount,
      rejected_count: prepared.rejected_count,
      rows
    };
    writeAudit(context.userId, 'performance_content_import', {
      campaign_id: context.campaignId,
      accepted: inserted.length,
      duplicate: duplicateCount,
      rejected: prepared.rejected_count
    });
    return result;
  }

  function importMetricRows(input) {
    const context = requireAccess(input && input.userId, input && input.campaignId, 'content');
    const body = assertOnlyKeys((input && input.body) || {}, [
      'mapping_version', 'provenance', 'column_mapping', 'rows'
    ], 'PERFORMANCE_METRIC_IMPORT_INVALID');
    const mapping = normalizeMetricImportMapping(body.column_mapping);
    let prepared;
    try {
      prepared = preparePerformanceContentImport({
        campaign_id: String(context.campaignId),
        mapping_version: body.mapping_version,
        provenance: body.provenance,
        column_mapping: {
          content_url: mapping.content_url,
          custom_fields: Object.fromEntries(
            Object.entries(mapping).filter(([field]) => field !== 'content_url')
          )
        },
        rows: body.rows
      });
    } catch (error) {
      if (error instanceof PerformanceContentImportServiceError) {
        throw serviceError(error.statusCode || 400, error.code, error.message, error.details);
      }
      throw error;
    }

    const rows = new Array(prepared.rows.length);
    const candidates = [];
    prepared.rows.forEach((preparedRow) => {
      if (preparedRow.outcome === 'duplicate') {
        rows[preparedRow.index] = metricImportDuplicateRow(preparedRow, null, null);
        return;
      }
      if (preparedRow.outcome !== 'accepted' || !preparedRow.draft) {
        rows[preparedRow.index] = metricImportRowError(
          preparedRow,
          preparedRow.error && preparedRow.error.code || 'PERFORMANCE_METRIC_IMPORT_ROW_INVALID',
          preparedRow.error && preparedRow.error.message || 'Metric import row is invalid.'
        );
        return;
      }
      try {
        const normalized = normalizeMetricImportRow(preparedRow, preparedRow.draft.custom_fields || {}, mapping);
        candidates.push({ row: preparedRow, normalized });
      } catch (error) {
        if (!(error instanceof PerformanceManualServiceError)) throw error;
        rows[preparedRow.index] = metricImportRowError(
          preparedRow,
          error.code || 'PERFORMANCE_METRIC_IMPORT_ROW_INVALID',
          error.message || 'Metric import row is invalid.',
          error.details && error.details.field
        );
      }
    });

    db.transaction(() => {
      if (candidates.length === 0) return;
      const identities = [...new Set(candidates.map((candidate) => candidate.row.canonical_identity))];
      const placeholders = identities.map(() => '?').join(',');
      const publications = db.prepare(`
        SELECT id,canonical_identity FROM campaign_publications
        WHERE org_id=? AND campaign_id=? AND canonical_identity IN (${placeholders})
      `).all(context.access.campaign.org_id, context.campaignId, ...identities);
      const publicationByIdentity = new Map(publications.map((publication) => [publication.canonical_identity, publication.id]));
      const findExact = db.prepare(`
        SELECT id FROM performance_metric_observations
        WHERE org_id=? AND campaign_id=? AND publication_id=? AND source_mode='csv_xlsx'
          AND observed_at=? AND metrics_json=?
        ORDER BY id DESC LIMIT 1
      `);
      const insertObservation = db.prepare(`
        INSERT INTO performance_metric_observations (
          org_id,campaign_id,publication_id,source_mode,metrics_json,observed_at,correction_reason,created_by
        ) VALUES (?,?,?,?,?,?,?,?)
      `);
      candidates.forEach((candidate) => {
        const publicationId = publicationByIdentity.get(candidate.row.canonical_identity);
        if (!publicationId) {
          rows[candidate.row.index] = metricImportRowError(
            candidate.row,
            'PERFORMANCE_METRIC_IMPORT_CONTENT_NOT_FOUND',
            'Metric import can only update content already monitored in this campaign.'
          );
          return;
        }
        const metricsJson = JSON.stringify(candidate.normalized.metrics);
        const existing = findExact.get(
          context.access.campaign.org_id,
          context.campaignId,
          publicationId,
          candidate.normalized.observedAt,
          metricsJson
        );
        if (existing) {
          rows[candidate.row.index] = metricImportDuplicateRow(candidate.row, publicationId, Number(existing.id));
          return;
        }
        const observationId = Number(insertObservation.run(
          context.access.campaign.org_id,
          context.campaignId,
          publicationId,
          'csv_xlsx',
          metricsJson,
          candidate.normalized.observedAt,
          candidate.normalized.correctionReason,
          context.userId
        ).lastInsertRowid);
        rows[candidate.row.index] = metricImportAcceptedRow(
          candidate.row,
          publicationId,
          observationId,
          candidate.normalized.observedAt
        );
      });
    }).immediate();

    const acceptedCount = rows.filter((row) => row && row.outcome === 'accepted').length;
    const duplicateCount = rows.filter((row) => row && row.outcome === 'duplicate').length;
    const rejectedCount = rows.filter((row) => row && row.outcome === 'rejected').length;
    const result = {
      contract_version: METRIC_IMPORT_CONTRACT_VERSION,
      campaign_id: context.campaignId,
      source_mode: 'csv_xlsx',
      file_hash: prepared.file_hash,
      mapping_version: prepared.mapping_version,
      total_count: prepared.total_count,
      accepted_count: acceptedCount,
      duplicate_count: duplicateCount,
      rejected_count: rejectedCount,
      rows
    };
    writeAudit(context.userId, 'performance_metric_import', {
      campaign_id: context.campaignId,
      accepted: acceptedCount,
      duplicate: duplicateCount,
      rejected: rejectedCount,
      file_hash: prepared.file_hash,
      mapping_version: prepared.mapping_version
    });
    return result;
  }

  function recordManualInput(input) {
    const preliminary = requireAccess(input && input.userId, input && input.campaignId, 'view');
    const body = assertOnlyKeys((input && input.body) || {}, [
      'observation', 'commercial', 'confirmed', 'correction_reason'
    ], 'PERFORMANCE_MANUAL_INPUT_INVALID');
    const observation = normalizeObservation(body.observation);
    const commercial = normalizeCommercial(body.commercial);
    const correctionReason = boundedText(body.correction_reason, 'correction_reason', MAX_TEXT_LENGTH, false);
    const confirmed = body.confirmed === true;
    if (body.confirmed !== undefined && typeof body.confirmed !== 'boolean') {
      throw serviceError(400, 'PERFORMANCE_MANUAL_INPUT_INVALID', 'confirmed must be boolean.', { field: 'confirmed' });
    }
    if (!observation && !commercial) {
      throw serviceError(400, 'PERFORMANCE_MANUAL_INPUT_INVALID', 'An observation or commercial input is required.');
    }
    if (observation && !preliminary.capabilities.can_manage_content) {
      throw serviceError(403, 'PERFORMANCE_CONTENT_FORBIDDEN', 'Metric input is forbidden.');
    }
    if (commercial) requireAccess(input.userId, input.campaignId, 'commercial');
    if (confirmed) {
      if (!commercial) {
        throw serviceError(400, 'PERFORMANCE_MANUAL_INPUT_INVALID', 'confirmed requires commercial input.');
      }
      requireAccess(input.userId, input.campaignId, 'approve');
    }
    const contentId = publicationById(preliminary, input && input.contentId);
    const outcome = db.transaction(() => {
      let observationId = null;
      let manualInputId = null;
      if (observation) {
        observationId = Number(db.prepare(`
          INSERT INTO performance_metric_observations (
            org_id,campaign_id,publication_id,source_mode,metrics_json,observed_at,correction_reason,created_by
          ) VALUES (?,?,?,?,?,?,?,?)
        `).run(
          preliminary.access.campaign.org_id,
          preliminary.campaignId,
          contentId,
          'manual',
          JSON.stringify(observation.metrics),
          observation.observedAt,
          correctionReason,
          preliminary.userId
        ).lastInsertRowid);
      }
      if (commercial) {
        const previous = db.prepare(`
          SELECT id FROM performance_manual_inputs
          WHERE org_id=? AND campaign_id=? AND publication_id=?
          ORDER BY created_at DESC,id DESC LIMIT 1
        `).get(preliminary.access.campaign.org_id, preliminary.campaignId, contentId);
        manualInputId = Number(db.prepare(`
          INSERT INTO performance_manual_inputs (
            org_id,campaign_id,publication_id,commercial_json,approval_state,correction_reason,
            supersedes_input_id,created_by,approved_by,approved_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?)
        `).run(
          preliminary.access.campaign.org_id,
          preliminary.campaignId,
          contentId,
          JSON.stringify(commercial),
          confirmed ? 'approved' : 'draft',
          correctionReason,
          previous ? previous.id : null,
          preliminary.userId,
          confirmed ? preliminary.userId : null,
          confirmed ? nowIso() : null
        ).lastInsertRowid);
      }
      return { observationId, manualInputId };
    })();
    writeAudit(preliminary.userId, 'performance_manual_input', {
      campaign_id: preliminary.campaignId,
      publication_id: contentId,
      observation_id: outcome.observationId,
      manual_input_id: outcome.manualInputId,
      confirmed
    });
    const row = currentRows(preliminary, { q: '', platform: '', tag: '', limit: 1, offset: 0 }, false)
      .rows.find((item) => item.id === contentId);
    const content = serializePublication(row, preliminary.capabilities);
    return {
      content,
      observation: content.latest_observation,
      manual_input: content.commercial || null,
      capabilities: preliminary.capabilities
    };
  }

  function listContents(input) {
    const context = requireAccess(input && input.userId, input && input.campaignId, 'view');
    const query = normalizeQuery(input && input.query);
    const result = currentRows(context, query, true);
    return {
      items: result.rows.map((row) => serializePublication(row, context.capabilities)),
      total: result.total,
      limit: query.limit,
      offset: query.offset,
      capabilities: context.capabilities
    };
  }

  function getIntegrationPreview(input) {
    const context = requireAccess(input && input.userId, input && input.campaignId, 'view');
    const canViewCommercial = context.capabilities.can_view_commercial;
    return {
      contract_version: INTEGRATION_PREVIEW_CONTRACT_VERSION,
      campaign_id: context.campaignId,
      capabilities: context.capabilities,
      data_sources: INTEGRATION_PREVIEW_SOURCES.map((source) => ({
        id: source.id,
        label: source.label,
        status: source.status,
        detail: source.detail,
        supports: source.supports.filter((support) => support !== 'commercial_input' || canViewCommercial),
        dispatch_available: false
      })),
      feishu: {
        status: 'preview_only',
        detail: '仅展示拟定字段映射；不会访问或写入飞书。',
        mapping_scope: 'proposed_video_performance_schema',
        provider_validation: 'not_attempted',
        write_attempted: false,
        commercial_fields_included: canViewCommercial,
        field_mapping: INTEGRATION_PREVIEW_FIELDS
          .filter((field) => field.access !== 'commercial' || canViewCommercial)
          .map((field) => ({
            source_key: field.source_key,
            source_label: field.source_label,
            proposed_target_field: field.proposed_target_field,
            access: field.access
          }))
      }
    };
  }

  function exportContents(input) {
    const context = requireAccess(input && input.userId, input && input.campaignId, 'view');
    const query = normalizeQuery(input && input.query);
    const scope = normalizeExportScope(input && input.scope);
    const scopedQuery = scope === 'all'
      ? Object.assign({}, query, { q: '', platform: '', tag: '' })
      : query;
    const current = currentRows(context, scopedQuery, false);
    if (current.total > MAX_EXPORT_ROWS) {
      throw serviceError(413, 'PERFORMANCE_EXPORT_LIMIT_EXCEEDED', 'Export exceeds the current record limit.', {
        max_rows: MAX_EXPORT_ROWS,
        total: current.total
      });
    }
    const contents = current.rows.map((row) => serializePublication(row, context.capabilities));
    writeAudit(context.userId, 'performance_content_export', {
      campaign_id: context.campaignId,
      scope,
      total: contents.length,
      includes_commercial: context.capabilities.can_view_commercial
    });
    return {
      campaign_id: context.campaignId,
      scope,
      total: contents.length,
      filename: `performance_campaign_${context.campaignId}_${scope}_export.csv`,
      csv: performanceExportCsv(contents, context.capabilities.can_view_commercial)
    };
  }

  function observedTotal(rows, field) {
    const values = rows.map((row) => safeJson(row.metrics_json, {})[field])
      .filter((value) => Number.isSafeInteger(value) && value >= 0);
    const total = values.reduce((sum, value) => sum + value, 0);
    return {
      value: values.length ? total : null,
      available: values.length > 0,
      coverage: { available_records: values.length, total_records: rows.length }
    };
  }

  function aggregateCommercial(rows) {
    if (!rows.length) return {};
    const source = rows.map((row) => ({
      row,
      input: safeJson(row.commercial_json, {})
    }));
    if (source.some(({ row }) => row.manual_id === null || row.approval_state !== 'approved')) return {};
    const currencies = new Set(source.map(({ input }) => input.base_currency));
    if (currencies.size !== 1 || !/^[A-Z]{3}$/.test([...currencies][0] || '')) return {};
    const currency = [...currencies][0];
    const firstRow = source[0].row;
    const provenance = {
      approvalId: `performance-campaign-${firstRow.campaign_id}`,
      approvedBy: `campaign-${firstRow.campaign_id}`,
      approvedAt: firstRow.approved_at,
      policyVersion: 'phase7b.1a-manual-confirmation'
    };
    const sumMoney = (field) => {
      if (source.some(({ input }) => typeof input[field] !== 'number')) return undefined;
      return {
        amount: source.reduce((sum, { input }) => sum + input[field], 0),
        currency,
        approvalState: 'approved',
        ...provenance
      };
    };
    const costs = {};
    Object.entries(COST_FIELD_MAP).forEach(([stored, engine]) => {
      const value = sumMoney(stored);
      if (value) costs[engine] = value;
    });
    const models = new Set(source.map(({ input }) => input.attribution_model || null));
    const windows = new Set(source.map(({ input }) => input.attribution_window || null));
    const output = {
      baseCurrency: currency,
      costs,
      attributedRevenue: sumMoney('attributed_revenue'),
      clientCharge: sumMoney('client_charge')
    };
    if (models.size === 1 && windows.size === 1 && [...models][0] && [...windows][0]) {
      output.attribution = {
        model: [...models][0],
        window: [...windows][0],
        approvalState: 'approved',
        ...provenance
      };
    }
    return output;
  }

  function dashboard(input) {
    const context = requireAccess(input && input.userId, input && input.campaignId, 'view');
    const query = normalizeQuery(input && input.query);
    const current = currentRows(context, query, false);
    const totals = {};
    const aggregateObservations = {};
    for (const field of OBSERVATION_FIELDS) {
      totals[field] = observedTotal(current.rows, field);
      if (current.rows.length > 0 && totals[field].coverage.available_records === current.rows.length) {
        aggregateObservations[field] = totals[field].value;
      }
    }
    const aggregate = calculatePerformanceMetrics({
      observations: aggregateObservations,
      engagementComponents: ['likes', 'comments', 'saves', 'shares'],
      commercial: context.capabilities.can_view_commercial ? aggregateCommercial(current.rows) : {},
      costBasis: 'total_campaign_cost'
    });
    const serialized = current.rows.map((row) => serializePublication(row, context.capabilities));
    const metricFor = (item) => {
      if (query.topMetric === 'core_view_er') return item.metrics.core_view_er;
      const source = item.latest_observation || {};
      const value = source[query.topMetric];
      return {
        metric: query.topMetric,
        value: Number.isSafeInteger(value) ? value : null,
        available: Number.isSafeInteger(value),
        reason: Number.isSafeInteger(value) ? null : { code: 'missing_observation' }
      };
    };
    const topContents = serialized.map((content) => ({ content, metric: metricFor(content) }))
      .filter((item) => item.metric.available)
      .sort((left, right) => right.metric.value - left.metric.value || left.content.id - right.content.id)
      .slice(0, 10)
      .map((item, index) => Object.assign({ rank: index + 1 }, item));
    return {
      campaign_id: context.campaignId,
      records: {
        total: current.total,
        active_with_observations: current.rows.filter((row) => row.observation_id !== null).length,
        confirmed_commercial: current.rows.filter((row) => row.approval_state === 'approved').length
      },
      totals,
      metrics: apiMetrics(aggregate, context.capabilities.can_view_commercial),
      top_metric: query.topMetric,
      top_contents: topContents,
      capabilities: context.capabilities
    };
  }

  function getReviewEvidence(input) {
    const context = requireAccess(input && input.userId, input && input.campaignId, 'view');
    const sourceQuery = input && input.query && typeof input.query === 'object' ? input.query : {};
    const query = normalizeQuery({ top_metric: sourceQuery.top_metric });
    const current = currentRows(context, query, false);
    const contents = current.rows.map((row) => serializePublication(row, context.capabilities));
    const dashboardResult = dashboard({
      userId: context.userId,
      campaignId: context.campaignId,
      query: { top_metric: query.topMetric }
    });
    const records = Object.assign({}, dashboardResult.records);
    if (!context.capabilities.can_view_commercial) delete records.confirmed_commercial;
    const rankings = buildReviewRankings(contents, query.topMetric);
    return {
      contract_version: REVIEW_EVIDENCE_CONTRACT_VERSION,
      campaign_id: context.campaignId,
      scope: {
        type: 'campaign_current_snapshot',
        selected_metric: query.topMetric,
        observation_selector: 'observed_at_desc_id_desc',
        commercial_selector: 'created_at_desc_id_desc'
      },
      records,
      totals: dashboardResult.totals,
      metrics: dashboardResult.metrics,
      rankings,
      breakdowns: {
        platforms: buildReviewBreakdown(contents, 'platform', query.topMetric),
        products: buildReviewBreakdown(contents, 'product', query.topMetric),
        creators: buildReviewBreakdown(contents, 'creator', query.topMetric)
      },
      data_quality: {
        metric_coverage: reviewMetricCoverage(contents),
        source_mode_counts: reviewSourceModeCounts(contents),
        observation_window: reviewObservationWindow(contents)
      },
      analysis: {
        mode: 'metadata_only',
        media_evidence: {
          status: 'not_collected',
          reason: 'authorized_media_access_required'
        },
        external_collection: {
          status: 'not_connected',
          reason: 'provider_not_enabled'
        },
        causal_diagnosis: {
          status: 'not_available',
          reason: 'media_evidence_not_collected'
        },
        human_confirmation: {
          required: true,
          status: 'not_started'
        }
      },
      limitations: reviewLimitations(records, rankings, context.capabilities),
      capabilities: context.capabilities
    };
  }

  return Object.freeze({
    createContent,
    importContentRows,
    importMetricRows,
    recordManualInput,
    listContents,
    getIntegrationPreview,
    exportContents,
    getDashboard: dashboard,
    getReviewEvidence
  });
}

class PerformanceAiReviewServiceError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'PerformanceAiReviewServiceError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function aiReviewError(statusCode, code, message, details) {
  return new PerformanceAiReviewServiceError(statusCode, code, message, details);
}

function aiReviewPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result = {};
    for (const key of Object.keys(descriptors)) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

function aiReviewPositiveId(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0 && String(parsed) === value) return parsed;
  }
  return null;
}

function aiReviewInput(body) {
  const source = aiReviewPlainObject(body || {});
  if (!source || Object.keys(source).some((key) => key !== 'top_metric')) {
    throw aiReviewError(400, 'PERFORMANCE_AI_REVIEW_INVALID', 'AI review input is invalid.');
  }
  let topMetric = 'views';
  if (source.top_metric !== undefined) {
    if (typeof source.top_metric !== 'string' || !source.top_metric.trim() || source.top_metric.trim().length > 64) {
      throw aiReviewError(400, 'PERFORMANCE_AI_REVIEW_INVALID', 'top_metric is invalid.', { field: 'top_metric' });
    }
    topMetric = source.top_metric.trim();
  }
  return { topMetric };
}

function enforceAiReviewQuota(db, user) {
  const quota = Number(user && user.api_quota || 0);
  if (!quota || (user && user.role === 'admin')) return;
  const used = db.prepare(`
    SELECT COALESCE(SUM(total_tokens), 0) AS total
    FROM token_usage
    WHERE user_id=?
  `).get(user.id).total;
  if (used >= quota) {
    throw aiReviewError(429, 'AI_QUOTA_EXCEEDED', 'AI quota exceeded.');
  }
}

function aiReviewMetricLabel(metric) {
  const labels = {
    views: '播放量',
    likes: '点赞数',
    comments: '评论数',
    saves: '收藏数',
    shares: '转发数',
    clicks: '点击数',
    conversions: '转化数',
    core_view_er: '核心播放互动率'
  };
  return labels[metric] || metric || '所选指标';
}

function aiReviewSafeText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.slice(0, maxLength || 120);
}

function aiReviewContentLabel(content) {
  const source = content && typeof content === 'object' ? content : {};
  const parts = [
    aiReviewSafeText(source.creator_name, 80),
    aiReviewSafeText(source.product, 80),
    aiReviewSafeText(source.platform, 40)
  ].filter(Boolean);
  return parts.length ? parts.join(' / ') : `内容 #${source.id || '未知'}`;
}

function aiReviewEvidenceReferences(evidence) {
  const seen = new Map();
  const rankings = evidence && evidence.rankings && typeof evidence.rankings === 'object'
    ? evidence.rankings
    : {};
  const add = (items, classification) => {
    (Array.isArray(items) ? items : []).forEach((item) => {
      const content = item && item.content && typeof item.content === 'object' ? item.content : {};
      const contentId = aiReviewPositiveId(content.id);
      if (contentId === null) return;
      const observation = (item && item.evidence && item.evidence.latest_observation) || {};
      const metric = item && item.metric && typeof item.metric === 'object' ? item.metric : {};
      const existing = seen.get(contentId);
      const classifications = existing ? existing.classifications : [];
      if (!classifications.includes(classification)) classifications.push(classification);
      seen.set(contentId, {
        id: `PERF-${contentId}`,
        content_id: contentId,
        label: aiReviewContentLabel(content),
        classifications,
        platform: aiReviewSafeText(content.platform, 40),
        creator_name: aiReviewSafeText(content.creator_name, 80),
        product: aiReviewSafeText(content.product, 80),
        selected_metric: {
          key: aiReviewSafeText(metric.metric, 64),
          value: Number.isFinite(metric.value) ? metric.value : null,
          available: metric.available === true
        },
        source_mode: aiReviewSafeText(observation.source_mode, 40),
        observed_at: aiReviewSafeText(observation.observed_at, 64)
      });
    });
  };
  add(rankings.top_contents, 'top');
  add(rankings.bottom_contents, 'bottom');
  return [...seen.values()].sort((left, right) => left.content_id - right.content_id);
}

function aiReviewEvidenceProjection(evidence, evidenceReferences) {
  const rankings = evidence && evidence.rankings && typeof evidence.rankings === 'object'
    ? evidence.rankings
    : {};
  const dataQuality = evidence && evidence.data_quality && typeof evidence.data_quality === 'object'
    ? evidence.data_quality
    : {};
  const scope = evidence && evidence.scope && typeof evidence.scope === 'object' ? evidence.scope : {};
  const sourceRecords = evidence && evidence.records && typeof evidence.records === 'object'
    ? evidence.records
    : {};
  // Do not rely on a deny list: only non-commercial record counts enter the model prompt.
  const records = {
    total: Number.isSafeInteger(sourceRecords.total) ? sourceRecords.total : 0,
    active_with_observations: Number.isSafeInteger(sourceRecords.active_with_observations)
      ? sourceRecords.active_with_observations
      : 0
  };
  return {
    contract_version: evidence && evidence.contract_version || REVIEW_EVIDENCE_CONTRACT_VERSION,
    scope: {
      type: scope.type || 'campaign_current_snapshot',
      selected_metric: scope.selected_metric || null,
      selected_metric_label: aiReviewMetricLabel(scope.selected_metric),
      observation_selector: scope.observation_selector || null
    },
    records,
    ranking: {
      status: rankings.status || 'insufficient_data',
      eligibility: rankings.eligibility || null
    },
    data_quality: {
      source_mode_counts: dataQuality.source_mode_counts || {},
      observation_window: dataQuality.observation_window || null,
      metric_coverage: dataQuality.metric_coverage || []
    },
    evidence_references: evidenceReferences,
    limitations: Array.isArray(evidence && evidence.limitations) ? evidence.limitations : []
  };
}

function aiReviewSnapshotHash(projection) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(projection), 'utf8')
    .digest('hex');
}

function aiReviewAiProjection(ai) {
  return {
    conversation_id: ai && ai.conversation_id || null,
    message_id: ai && ai.message_id || null,
    model: ai && ai.model || null,
    usage: ai && ai.usage || {},
    latency_ms: ai && ai.latency_ms || null,
    knowledge_references: ai && ai.knowledge_references || [],
    web_search: ai && ai.web_search || { used: false },
    summary_promotion: ai && ai.summary_promotion || null,
    archived_summary_id: ai && ai.archived_summary_id || null
  };
}

function aiReviewGeneratedResult(input) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    contract_version: AI_REVIEW_DRAFT_CONTRACT_VERSION,
    campaign_id: source.campaignId || null,
    status: 'generated',
    analysis: aiReviewAnalysis(),
    confidence: source.confidence || null,
    evidence: Object.assign({}, source.evidenceProjection || {}, {
      snapshot_hash: source.snapshotHash || null,
      citation_validation: source.citationValidation || null,
      draft_validation: source.draftValidation || null,
      protocol_validation: source.protocolValidation || null
    }),
    draft: source.draft || '',
    ai: aiReviewAiProjection(source.ai)
  };
}

function aiReviewReplayAnalysisValid(value) {
  const source = aiReviewPlainObject(value);
  const mediaEvidence = source && aiReviewPlainObject(source.media_evidence);
  const webSearch = source && aiReviewPlainObject(source.web_search);
  const knowledgePromotion = source && aiReviewPlainObject(source.knowledge_promotion);
  const humanConfirmation = source && aiReviewPlainObject(source.human_confirmation);
  return !!source &&
    source.mode === 'metadata_only' &&
    mediaEvidence &&
    mediaEvidence.status === 'not_collected' &&
    mediaEvidence.reason === 'authorized_media_access_required' &&
    webSearch &&
    webSearch.used === false &&
    webSearch.reason === 'disabled_for_performance_review' &&
    knowledgePromotion &&
    knowledgePromotion.status === 'not_started' &&
    knowledgePromotion.reason === 'human_confirmation_required' &&
    humanConfirmation &&
    humanConfirmation.required === true &&
    humanConfirmation.status === 'not_started';
}

function aiReviewReplayTerminalResult(source) {
  const expectedKeys = [
    'ai', 'analysis', 'campaign_id', 'confidence', 'contract_version', 'draft', 'evidence', 'reason_code', 'status'
  ];
  const allowedWithheldReasons = new Set([
    'draft_safety_validation_failed',
    'ai_review_protocol_invalid',
    'citation_validation_failed',
    'ai_review_unavailable'
  ]);
  const confidence = aiReviewPlainObject(source && source.confidence);
  const evidence = aiReviewPlainObject(source && source.evidence);
  const terminalStatus = source && source.status;
  const validReason = terminalStatus === 'stale_snapshot'
    ? source.reason_code === 'review_evidence_changed'
    : terminalStatus === 'withheld' && allowedWithheldReasons.has(source.reason_code);
  if (
    !source ||
    Object.keys(source).sort().join('|') !== expectedKeys.join('|') ||
    source.contract_version !== AI_REVIEW_DRAFT_CONTRACT_VERSION ||
    !['withheld', 'stale_snapshot'].includes(terminalStatus) ||
    !validReason ||
    aiReviewPositiveId(source.campaign_id) === null ||
    source.draft !== null ||
    source.ai !== null ||
    !aiReviewReplayAnalysisValid(source.analysis) ||
    !confidence ||
    !['high', 'medium', 'insufficient'].includes(confidence.level) ||
    typeof confidence.detail !== 'string' ||
    !evidence ||
    !/^[a-f0-9]{64}$/.test(String(evidence.snapshot_hash || ''))
  ) {
    return null;
  }
  return {
    contract_version: source.contract_version,
    campaign_id: source.campaign_id,
    status: terminalStatus,
    reason_code: source.reason_code,
    analysis: source.analysis,
    confidence,
    evidence,
    draft: null,
    ai: null
  };
}

function aiReviewReplayEnvelope(ai) {
  const source = aiReviewPlainObject(ai && ai.response_envelope) || aiReviewPlainObject(ai);
  if (!source) return null;
  if (source.status === 'withheld' || source.status === 'stale_snapshot') {
    return aiReviewReplayTerminalResult(source);
  }
  const expectedKeys = [
    'ai', 'analysis', 'campaign_id', 'confidence', 'contract_version', 'draft', 'evidence', 'status'
  ];
  if (Object.keys(source).sort().join('|') !== expectedKeys.join('|')) return null;
  if (
    source.contract_version !== AI_REVIEW_DRAFT_CONTRACT_VERSION ||
    source.status !== 'generated' ||
    aiReviewPositiveId(source.campaign_id) === null ||
    typeof source.draft !== 'string' ||
    !source.draft.trim() ||
    source.draft.length > 24000
  ) {
    return null;
  }
  const confidence = aiReviewPlainObject(source.confidence);
  const evidence = aiReviewPlainObject(source.evidence);
  const evidenceValidation = evidence && aiReviewPlainObject(evidence.citation_validation);
  const draftValidation = evidence && aiReviewPlainObject(evidence.draft_validation);
  const protocolValidation = evidence && aiReviewPlainObject(evidence.protocol_validation);
  if (
    !aiReviewReplayAnalysisValid(source.analysis) ||
    !confidence ||
    !evidence ||
    !/^[a-f0-9]{64}$/.test(String(evidence.snapshot_hash || '')) ||
    !evidenceValidation || evidenceValidation.valid !== true ||
    !draftValidation || draftValidation.valid !== true ||
    !protocolValidation || protocolValidation.valid !== true
  ) {
    return null;
  }
  return aiReviewGeneratedResult({
    campaignId: source.campaign_id,
    confidence,
    evidenceProjection: evidence,
    snapshotHash: evidence.snapshot_hash,
    citationValidation: evidenceValidation,
    draftValidation,
    protocolValidation,
    draft: source.draft,
    ai: source.ai
  });
}

function aiReviewUniqueStrings(value, matcher, limit) {
  if (!Array.isArray(value) || !value.length || value.length > limit) return null;
  const seen = new Set();
  const result = [];
  for (const item of value) {
    if (typeof item !== 'string' || !matcher.test(item) || seen.has(item)) return null;
    seen.add(item);
    result.push(item);
  }
  return result;
}

function aiReviewProtocolValidation(answer, evidenceReferences) {
  const text = String(answer || '').trim();
  const failure = (code, details = {}) => Object.assign({
    valid: false,
    protocol: null,
    code,
    citations: [],
    unknown: [],
    includes_top: false,
    includes_bottom: false
  }, details);
  if (!text || text.length > 2400) return failure('output_size_invalid');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_error) {
    return failure('json_required');
  }
  const source = aiReviewPlainObject(parsed);
  if (!source) return failure('object_required');
  const expectedKeys = [
    'bottom_evidence_ids',
    'contract_version',
    'experiment_types',
    'human_confirmation',
    'top_evidence_ids'
  ];
  if (Object.keys(source).sort().join('|') !== expectedKeys.join('|')) return failure('fields_invalid');
  if (source.contract_version !== AI_REVIEW_PROTOCOL_VERSION) return failure('version_invalid');
  if (source.human_confirmation !== 'required') return failure('human_confirmation_required');
  const topEvidenceIds = aiReviewUniqueStrings(source.top_evidence_ids, /^PERF-[1-9][0-9]*$/, 3);
  const bottomEvidenceIds = aiReviewUniqueStrings(source.bottom_evidence_ids, /^PERF-[1-9][0-9]*$/, 3);
  const experimentTypes = aiReviewUniqueStrings(
    source.experiment_types,
    /^(?:data_coverage|cohort_comparison|observation_timing)$/,
    3
  );
  if (!topEvidenceIds || !bottomEvidenceIds || !experimentTypes) return failure('values_invalid');
  const known = new Map((evidenceReferences || []).map((reference) => [reference.id, reference]));
  const citations = [...new Set(topEvidenceIds.concat(bottomEvidenceIds))];
  const overlappingCitations = topEvidenceIds.filter((citation) => bottomEvidenceIds.includes(citation));
  const unknown = citations.filter((citation) => !known.has(citation));
  const topBound = topEvidenceIds.every((citation) => {
    const reference = known.get(citation);
    return reference && Array.isArray(reference.classifications) && reference.classifications.includes('top');
  });
  const bottomBound = bottomEvidenceIds.every((citation) => {
    const reference = known.get(citation);
    return reference && Array.isArray(reference.classifications) && reference.classifications.includes('bottom');
  });
  if (overlappingCitations.length || unknown.length || !topBound || !bottomBound) {
    return failure('evidence_binding_invalid', {
      citations,
      overlapping: overlappingCitations,
      unknown,
      includes_top: topBound,
      includes_bottom: bottomBound
    });
  }
  return {
    valid: true,
    code: 'ok',
    protocol: {
      contract_version: AI_REVIEW_PROTOCOL_VERSION,
      top_evidence_ids: topEvidenceIds,
      bottom_evidence_ids: bottomEvidenceIds,
      experiment_types: experimentTypes,
      human_confirmation: 'required'
    },
    citations,
    unknown: [],
    includes_top: true,
    includes_bottom: true
  };
}

function aiReviewCitationValidation(protocolValidation) {
  const source = protocolValidation || {};
  return {
    valid: source.valid === true,
    citations: Array.isArray(source.citations) ? source.citations : [],
    unknown: Array.isArray(source.unknown) ? source.unknown : [],
    includes_top: source.includes_top === true,
    includes_bottom: source.includes_bottom === true,
    required_citation_count: 2,
    protocol_code: source.code || 'invalid'
  };
}

function aiReviewDraftSafety(answer) {
  const text = String(answer || '');
  const mediaTermDetected = /钩子|画面|脚本|风格|创意|镜头|视觉|素材|CTA|call\s+to\s+action|\b(?:hook|visual|script|style|creative|scene|cta)\b/i.test(text);
  const causalMediaClaim = [
    /(?:由于|因为|归因于|导致|源于).{0,40}(?:钩子|画面|脚本|风格|创意|镜头|视觉|素材|CTA)/i,
    /(?:钩子|画面|脚本|风格|创意|镜头|视觉|素材|CTA).{0,40}(?:导致|提升|降低|驱动|影响|解释)/i,
    /(?:because|driven by|caused by).{0,80}(?:hook|visual|script|style|creative|scene|cta|call\s+to\s+action)/i,
    /(?:hook|visual|script|style|creative|scene|cta|call\s+to\s+action).{0,80}(?:caused|drove|improved|reduced|explains)/i
  ].some((pattern) => pattern.test(text));
  return {
    valid: !mediaTermDetected && !causalMediaClaim,
    media_term_detected: mediaTermDetected,
    causal_media_claim_detected: causalMediaClaim,
    human_confirmation_present: /人工(?:确认|复核|审核)|"human_confirmation"\s*:\s*"required"/.test(text)
  };
}

function aiReviewRenderedDraft(protocol, evidenceReferences, evidenceProjection) {
  const known = new Map((evidenceReferences || []).map((reference) => [reference.id, reference]));
  const metricLabel = aiReviewSafeText(
    evidenceProjection && evidenceProjection.scope && evidenceProjection.scope.selected_metric_label,
    64
  ) || '所选指标';
  const list = (ids, groupLabel) => ids.map((id) => {
    const reference = known.get(id) || {};
    return `- ${aiReviewSafeText(reference.label, 160) || id}：当前${metricLabel}处于${groupLabel} [${id}]。`;
  }).join('\n');
  const experiments = protocol.experiment_types.map((type) => (
    `- ${AI_REVIEW_EXPERIMENT_TYPES[type]}`
  )).join('\n');
  return [
    '## 数据范围与置信等级',
    '- 本草稿仅基于当前录入的结构化指标与已确认的方法论参考。',
    '- 所有结论均需人工确认；不包含视频、图片、字幕、脚本或创意证据。',
    '## 当前表现靠前内容',
    list(protocol.top_evidence_ids, '表现靠前组'),
    '## 当前待观察内容',
    list(protocol.bottom_evidence_ids, '待观察组'),
    '## 可验证的复用假设与下一步实验',
    experiments,
    '## 数据边界与人工确认项',
    '- 当前排名不构成内容因果判断，也不等同于内容质量结论。',
    '- 请由项目负责人结合后续数据与授权素材完成人工确认。'
  ].join('\n');
}

function aiReviewAnalysis() {
  return {
    mode: 'metadata_only',
    media_evidence: { status: 'not_collected', reason: 'authorized_media_access_required' },
    web_search: { used: false, reason: 'disabled_for_performance_review' },
    knowledge_promotion: { status: 'not_started', reason: 'human_confirmation_required' },
    human_confirmation: { required: true, status: 'not_started' }
  };
}

function aiReviewWithheldResult(input) {
  const source = input && typeof input === 'object' ? input : {};
  const evidence = Object.assign({}, source.evidenceProjection || {}, {
    snapshot_hash: source.snapshotHash || null
  });
  if (source.citationValidation) evidence.citation_validation = source.citationValidation;
  if (source.draftValidation) evidence.draft_validation = source.draftValidation;
  if (source.protocolValidation) evidence.protocol_validation = source.protocolValidation;
  return {
    contract_version: AI_REVIEW_DRAFT_CONTRACT_VERSION,
    campaign_id: source.campaignId || null,
    status: 'withheld',
    reason_code: source.reasonCode || 'ai_review_unavailable',
    analysis: aiReviewAnalysis(),
    confidence: source.confidence || null,
    evidence,
    draft: null,
    ai: source.ai === undefined ? null : aiReviewAiProjection(source.ai)
  };
}

function aiReviewStaleResult(input) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    contract_version: AI_REVIEW_DRAFT_CONTRACT_VERSION,
    campaign_id: source.campaignId || null,
    status: 'stale_snapshot',
    reason_code: 'review_evidence_changed',
    analysis: aiReviewAnalysis(),
    confidence: aiReviewConfidence(source.currentEvidence || source.evidence),
    evidence: Object.assign({}, source.currentProjection || source.evidenceProjection || {}, {
      snapshot_hash: source.currentSnapshotHash || source.snapshotHash || null
    }),
    draft: null,
    ai: null
  };
}

function aiReviewConfidence(evidence) {
  const rankings = evidence && evidence.rankings && typeof evidence.rankings === 'object'
    ? evidence.rankings
    : {};
  const eligibility = rankings.eligibility && typeof rankings.eligibility === 'object'
    ? rankings.eligibility
    : {};
  const coverage = Number(eligibility.coverage);
  const comparable = Number(eligibility.comparable_records || 0);
  const total = Number(eligibility.total_records || 0);
  if (rankings.status !== 'available') {
    return {
      level: 'insufficient',
      detail: '当前数据不满足可比排名门槛，不能生成 AI 优劣判断。'
    };
  }
  if (coverage >= 0.95 && comparable >= 5) {
    return {
      level: 'high',
      detail: '所选指标覆盖充分，且已有五条以上可比内容。'
    };
  }
  return {
    level: 'medium',
    detail: `所选指标已覆盖 ${comparable}/${total} 条内容；结论仍需人工确认。`
  };
}

function aiReviewPrompt(evidence, evidenceReferences) {
  const projection = aiReviewEvidenceProjection(evidence, evidenceReferences);
  return [
    '你是 TuringMarket 的项目复盘助手。仅基于下面的结构化活动指标和已授权的项目知识选择证据与实验类型。',
    '本次没有视频、图片、字幕、脚本、钩子或风格证据；不得判断内容创意、视频原因、转化原因或任何因果关系。不得联网，不得编造外部数据。',
    '只输出一个合法 JSON 对象，不得输出 Markdown、解释、句子或其他字段。对象必须精确符合以下结构：',
    '{"contract_version":1,"top_evidence_ids":["PERF-1"],"bottom_evidence_ids":["PERF-2"],"experiment_types":["data_coverage"],"human_confirmation":"required"}',
    'top_evidence_ids 只能从当前表现靠前证据中选择；bottom_evidence_ids 只能从当前待观察证据中选择；每个数组 1-3 项且不得重复。',
    'experiment_types 只能选择 data_coverage、cohort_comparison、observation_timing 中的 1-3 项。不得添加任何自由文本。',
    '',
    '结构化事实（不可补充未提供的内容）：',
    JSON.stringify(projection)
  ].join('\n');
}

function createPerformanceAiReviewService(db, options = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('A SQLite database is required.');
  const performanceService = options.performanceService;
  const aiService = options.aiService;
  if (!performanceService || typeof performanceService.getReviewEvidence !== 'function') {
    throw new TypeError('A performance review evidence service is required.');
  }
  if (!aiService || typeof aiService.handleChat !== 'function') {
    throw new TypeError('An AI chat service is required.');
  }

  async function createDraft(input) {
    const user = input && input.user;
    if (!user || aiReviewPositiveId(user.id) === null) {
      throw aiReviewError(401, 'PERFORMANCE_AI_REVIEW_UNAUTHORIZED', 'An authenticated user is required.');
    }
    const request = aiReviewInput(input && input.body);
    const linkedAiInput = {
      user,
      campaign_id: input && input.campaignId,
      idempotencyKey: input && input.idempotencyKey,
      requestId: input && input.requestId,
      source_module: 'performance_review',
      performance_review_idempotency_input: {
        contract_version: AI_REVIEW_DRAFT_CONTRACT_VERSION,
        top_metric: request.topMetric
      }
    };
    if (typeof aiService.replayLinkedPerformanceReview === 'function') {
      try {
        const replayed = aiService.replayLinkedPerformanceReview(db, linkedAiInput);
        if (replayed) {
          const replayedResult = aiReviewReplayEnvelope(replayed);
          if (replayedResult) return replayedResult;
          throw aiReviewError(
            500,
            'PERFORMANCE_AI_REVIEW_REPLAY_INVALID',
            'Saved AI review output was invalid.'
          );
        }
      } catch (error) {
        if (error instanceof PerformanceAiReviewServiceError) throw error;
        if (error && error.name === 'AIServiceError' && Number.isSafeInteger(error.statusCode)) {
          throw aiReviewError(error.statusCode, error.code || 'PERFORMANCE_AI_REVIEW_FAILED', error.message);
        }
        throw error;
      }
    }
    let evidence;
    try {
      evidence = performanceService.getReviewEvidence({
        userId: user.id,
        campaignId: input && input.campaignId,
        query: { top_metric: request.topMetric }
      });
    } catch (error) {
      if (error instanceof PerformanceManualServiceError) throw error;
      throw aiReviewError(500, 'PERFORMANCE_AI_REVIEW_EVIDENCE_FAILED', 'Review evidence could not be prepared.');
    }
    const evidenceReferences = aiReviewEvidenceReferences(evidence);
    const evidenceProjection = aiReviewEvidenceProjection(evidence, evidenceReferences);
    const snapshotHash = aiReviewSnapshotHash(evidenceProjection);
    const confidence = aiReviewConfidence(evidence);
    if (!evidence || !evidence.rankings || evidence.rankings.status !== 'available') {
      return {
        contract_version: AI_REVIEW_DRAFT_CONTRACT_VERSION,
        campaign_id: (evidence && evidence.campaign_id) || aiReviewPositiveId(input && input.campaignId),
        status: 'not_ready',
        reason_code: 'insufficient_comparable_data',
        analysis: aiReviewAnalysis(),
        confidence,
        evidence: Object.assign({}, evidenceProjection, { snapshot_hash: snapshotHash }),
        draft: null,
        ai: null
      };
    }
    const prompt = aiReviewPrompt(evidence, evidenceReferences);
    const generationGuard = {
      citationValidation: null,
      draftValidation: null,
      protocolValidation: null,
      renderedDraft: '',
      currentEvidence: null,
      currentProjection: null,
      currentSnapshotHash: null,
      failure: null
    };
    let ai;
    try {
      ai = await aiService.handleChat(db, Object.assign({}, linkedAiInput, {
        message: prompt,
        ragQuery: `${aiReviewMetricLabel(request.topMetric)} 项目复盘方法与可验证优化假设`,
        campaign_id: evidence.campaign_id,
        // Only curated, human-confirmed performance methodology is eligible for linked RAG here.
        entry_type: 'performance_review_methodology',
        source_type: 'performance_review_methodology',
        quality_state: 'confirmed',
        business_type: 'campaign',
        business_id: String(evidence.campaign_id),
        allowWeb: false,
        summaryVisibility: 'private',
        knowledgeLimit: 5,
        archiveSummary: false,
        max_tokens: 700,
        terminalRejectionAudit: true,
        beforeProvider() {
          enforceAiReviewQuota(db, user);
        },
        validateCompletion(answer) {
          generationGuard.draftValidation = aiReviewDraftSafety(answer);
          if (!generationGuard.draftValidation.valid) {
            generationGuard.failure = 'draft_safety_validation_failed';
            return false;
          }
          generationGuard.protocolValidation = aiReviewProtocolValidation(answer, evidenceReferences);
          generationGuard.citationValidation = aiReviewCitationValidation(generationGuard.protocolValidation);
          if (!generationGuard.protocolValidation.valid) {
            generationGuard.failure = 'ai_review_protocol_invalid';
            return false;
          }
          if (!generationGuard.citationValidation.valid) {
            generationGuard.failure = 'citation_validation_failed';
            return false;
          }
          generationGuard.renderedDraft = aiReviewRenderedDraft(
            generationGuard.protocolValidation.protocol,
            evidenceReferences,
            evidenceProjection
          );
          if (!generationGuard.renderedDraft) {
            generationGuard.failure = 'ai_review_protocol_invalid';
            return false;
          }
          return true;
        },
        transformCompletion() {
          return generationGuard.renderedDraft;
        },
        createResponseEnvelope(aiResponse) {
          return aiReviewGeneratedResult({
            campaignId: evidence.campaign_id,
            confidence,
            evidenceProjection,
            snapshotHash,
            citationValidation: generationGuard.citationValidation,
            draftValidation: generationGuard.draftValidation,
            protocolValidation: generationGuard.protocolValidation,
            draft: generationGuard.renderedDraft,
            ai: aiResponse
          });
        },
        validateBeforePersist() {
          try {
            const currentEvidence = performanceService.getReviewEvidence({
              userId: user.id,
              campaignId: input && input.campaignId,
              query: { top_metric: request.topMetric }
            });
            const currentReferences = aiReviewEvidenceReferences(currentEvidence);
            const currentProjection = aiReviewEvidenceProjection(currentEvidence, currentReferences);
            const currentSnapshotHash = aiReviewSnapshotHash(currentProjection);
            generationGuard.currentEvidence = currentEvidence;
            generationGuard.currentProjection = currentProjection;
            generationGuard.currentSnapshotHash = currentSnapshotHash;
            if (
              !currentEvidence ||
              !currentEvidence.rankings ||
              currentEvidence.rankings.status !== 'available' ||
              currentSnapshotHash !== snapshotHash
            ) {
              generationGuard.failure = 'stale_snapshot';
              return false;
            }
            return true;
          } catch (_error) {
            generationGuard.failure = 'stale_snapshot';
            return false;
          }
        },
        terminalRejection() {
          if (generationGuard.failure === 'stale_snapshot') {
            return aiReviewStaleResult({
              campaignId: evidence.campaign_id,
              evidence,
              evidenceProjection,
              snapshotHash,
              currentEvidence: generationGuard.currentEvidence,
              currentProjection: generationGuard.currentProjection,
              currentSnapshotHash: generationGuard.currentSnapshotHash
            });
          }
          return aiReviewWithheldResult({
            campaignId: evidence.campaign_id,
            confidence,
            evidenceProjection,
            snapshotHash,
            reasonCode: generationGuard.failure || 'ai_review_unavailable',
            citationValidation: generationGuard.citationValidation,
            draftValidation: generationGuard.draftValidation,
            protocolValidation: generationGuard.protocolValidation
          });
        }
      }));
    } catch (error) {
      if (error && error.name === 'AIServiceError' && Number.isSafeInteger(error.statusCode)) {
        if (generationGuard.failure === 'stale_snapshot') {
          return aiReviewStaleResult({
            campaignId: evidence.campaign_id,
            evidence,
            evidenceProjection,
            snapshotHash,
            currentEvidence: generationGuard.currentEvidence,
            currentProjection: generationGuard.currentProjection,
            currentSnapshotHash: generationGuard.currentSnapshotHash
          });
        }
        if (
          generationGuard.failure === 'citation_validation_failed' ||
          generationGuard.failure === 'draft_safety_validation_failed' ||
          generationGuard.failure === 'ai_review_protocol_invalid'
        ) {
          return aiReviewWithheldResult({
            campaignId: evidence.campaign_id,
            confidence,
            evidenceProjection,
            snapshotHash,
            reasonCode: generationGuard.failure,
            citationValidation: generationGuard.citationValidation,
            draftValidation: generationGuard.draftValidation,
            protocolValidation: generationGuard.protocolValidation
          });
        }
        if (error.code === 'AI_PROVIDER_UNAVAILABLE') {
          return aiReviewWithheldResult({
            campaignId: evidence.campaign_id,
            confidence,
            evidenceProjection,
            snapshotHash,
            reasonCode: 'ai_review_unavailable'
          });
        }
        throw aiReviewError(error.statusCode, error.code || 'PERFORMANCE_AI_REVIEW_FAILED', error.message);
      }
      throw error;
    }
    if (ai && (ai.status === 'withheld' || ai.status === 'stale_snapshot')) return ai;
    const replayedResult = aiReviewReplayEnvelope(ai);
    if (replayedResult) return replayedResult;
    if (!ai || ai.degraded === true || ai.status !== 'succeeded' || (ai.web_search && ai.web_search.used === true)) {
      return aiReviewWithheldResult({
        campaignId: evidence.campaign_id,
        confidence,
        evidenceProjection,
        snapshotHash,
        reasonCode: 'ai_review_unavailable',
        ai
      });
    }
    const protocolValidation = generationGuard.protocolValidation || aiReviewProtocolValidation(ai.answer, evidenceReferences);
    const citationValidation = generationGuard.citationValidation || aiReviewCitationValidation(protocolValidation);
    const draftValidation = generationGuard.draftValidation || aiReviewDraftSafety(ai.answer);
    if (!protocolValidation.valid || !citationValidation.valid || !draftValidation.valid) {
      return aiReviewWithheldResult({
        campaignId: evidence.campaign_id,
        confidence,
        evidenceProjection,
        snapshotHash,
        reasonCode: !draftValidation.valid
          ? 'draft_safety_validation_failed'
          : !protocolValidation.valid
            ? 'ai_review_protocol_invalid'
            : 'citation_validation_failed',
        citationValidation,
        draftValidation,
        protocolValidation,
        ai
      });
    }
    return aiReviewGeneratedResult({
      campaignId: evidence.campaign_id,
      confidence,
      evidenceProjection,
      snapshotHash,
      citationValidation,
      draftValidation,
      protocolValidation,
      draft: generationGuard.renderedDraft || ai.answer || '',
      ai
    });
  }

  return Object.freeze({ createDraft });
}

module.exports = {
  ACTION_POLICIES,
  PerformanceManualServiceError,
  PerformanceAiReviewServiceError,
  createPerformanceManualService,
  createPerformanceAiReviewService
};

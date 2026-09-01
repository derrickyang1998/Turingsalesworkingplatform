'use strict';

const crypto = require('node:crypto');
const {
  preparePerformanceContentImport,
  PerformanceContentImportServiceError
} = require('./performance_content_import_service');
const { calculatePerformanceMetrics } = require('./performance_metrics_service');
const { getCampaignAccess: defaultGetCampaignAccess } = require('./campaign_access_service');

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;
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
    latest_observation: row.observation_id === null || row.observation_id === undefined ? null : {
      id: row.observation_id,
      observed_at: row.observed_at,
      source_mode: row.observation_source_mode,
      correction_reason: row.observation_correction_reason,
      ...safeJson(row.metrics_json, {})
    },
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
        ORDER BY current_observation.created_at DESC,current_observation.id DESC LIMIT 1
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

  return Object.freeze({
    createContent,
    importContentRows,
    recordManualInput,
    listContents,
    getDashboard: dashboard
  });
}

module.exports = {
  ACTION_POLICIES,
  PerformanceManualServiceError,
  createPerformanceManualService
};

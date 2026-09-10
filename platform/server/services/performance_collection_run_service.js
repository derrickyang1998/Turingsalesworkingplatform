'use strict';

const { getCampaignAccess: defaultGetCampaignAccess } = require('./campaign_access_service');

const COLLECTION_RUN_CONTRACT_VERSION = 'performance-collection-runs-v1';
const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 50;
const MAX_HISTORY_ROWS = 5000;
const MAX_ACTIVITY_SCAN_ROWS = 25000;
const PUBLICATION_LOOKUP_CHUNK = 400;
const COLLECTION_ACTIONS = Object.freeze([
  'performance_content_import',
  'performance_metric_import',
  'performance_manual_input'
]);

class PerformanceCollectionRunServiceError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'PerformanceCollectionRunServiceError';
    this.statusCode = statusCode;
    this.code = code;
    if (details !== undefined) this.details = details;
    Error.captureStackTrace(this, PerformanceCollectionRunServiceError);
  }
}

function serviceError(statusCode, code, message, details) {
  return new PerformanceCollectionRunServiceError(statusCode, code, message, details);
}

function positiveId(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,15}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizedLimit(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_LIMIT;
  const parsed = typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    throw serviceError(
      400,
      'PERFORMANCE_COLLECTION_RUN_QUERY_INVALID',
      `limit must be an integer between 1 and ${MAX_LIMIT}.`,
      { field: 'limit' }
    );
  }
  return parsed;
}

function strictCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeJson(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return plainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let text = value.trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)) {
    text = text.replace(' ', 'T') + 'Z';
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function importRun(row, details, operation) {
  const succeededValue = strictCount(details.accepted);
  const duplicateValue = strictCount(details.duplicate);
  const failedValue = strictCount(details.rejected);
  const validCounts = succeededValue !== null && duplicateValue !== null && failedValue !== null;
  const rawTotal = validCounts ? succeededValue + duplicateValue + failedValue : 0;
  const auditRecordValid = validCounts && Number.isSafeInteger(rawTotal) && rawTotal > 0;
  const succeeded = auditRecordValid ? succeededValue : 0;
  const duplicate = auditRecordValid ? duplicateValue : 0;
  const failed = auditRecordValid ? failedValue : 0;
  const total = succeeded + duplicate + failed;
  const status = !auditRecordValid
    ? 'failed'
    : (failed === 0
    ? 'succeeded'
    : (succeeded + duplicate > 0 ? 'partial' : 'failed'));
  return {
    id: Number(row.id),
    operation,
    scope: 'campaign',
    publication_id: null,
    source_mode: 'csv_xlsx',
    provider: null,
    status,
    counts: { total, succeeded, duplicate, failed },
    safe_error_category: !auditRecordValid
      ? 'audit_record_invalid'
      : (failed > 0 ? 'row_validation' : null),
    completed_at: canonicalTimestamp(row.created_at)
  };
}

function manualRun(row, details, authorizedPublicationIds) {
  const publicationId = positiveId(details.publication_id);
  const observationId = positiveId(details.observation_id);
  if (
    publicationId === null || observationId === null ||
    !authorizedPublicationIds.has(publicationId)
  ) return null;
  return {
    id: Number(row.id),
    operation: 'manual_metric_update',
    scope: 'publication',
    publication_id: publicationId,
    source_mode: 'manual',
    provider: null,
    status: 'succeeded',
    counts: { total: 1, succeeded: 1, duplicate: 0, failed: 0 },
    safe_error_category: null,
    completed_at: canonicalTimestamp(row.created_at)
  };
}

function projectRun(row, campaignId, authorizedPublicationIds) {
  const details = safeJson(row && row.details);
  if (!details || positiveId(details.campaign_id) !== campaignId) return null;
  if (row.action === 'performance_content_import') {
    return importRun(row, details, 'content_import');
  }
  if (row.action === 'performance_metric_import') {
    return importRun(row, details, 'metric_import');
  }
  if (row.action === 'performance_manual_input') {
    return manualRun(row, details, authorizedPublicationIds);
  }
  return null;
}

function authorizedManualPublicationIds(db, rows, context) {
  const requested = [...new Set(rows.flatMap((row) => {
    if (row.action !== 'performance_manual_input') return [];
    const details = safeJson(row.details);
    const publicationId = details && positiveId(details.publication_id);
    return publicationId === null ? [] : [publicationId];
  }))];
  const authorized = new Set();
  for (let offset = 0; offset < requested.length; offset += PUBLICATION_LOOKUP_CHUNK) {
    const ids = requested.slice(offset, offset + PUBLICATION_LOOKUP_CHUNK);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`
      SELECT id FROM campaign_publications
      WHERE org_id=? AND campaign_id=? AND id IN (${placeholders})
    `).all(context.access.campaign.org_id, context.campaignId, ...ids)
      .forEach((row) => authorized.add(Number(row.id)));
  }
  return authorized;
}

function createPerformanceCollectionRunService(db, options = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('A SQLite database is required.');
  }
  const getCampaignAccess = options.getCampaignAccess || defaultGetCampaignAccess;

  function requireAccess(userIdValue, campaignIdValue) {
    const userId = positiveId(userIdValue);
    const campaignId = positiveId(campaignIdValue);
    if (userId === null || campaignId === null) {
      throw serviceError(400, 'PERFORMANCE_COLLECTION_RUN_QUERY_INVALID', 'Campaign or user is invalid.');
    }
    const access = getCampaignAccess(db, { userId, campaignId });
    if (!access || access.ok !== true || access.permissions && access.permissions.read === false) {
      throw serviceError(
        access && access.status ? access.status : 403,
        access && access.code ? access.code : 'PERFORMANCE_COLLECTION_RUN_FORBIDDEN',
        'Collection run history access is forbidden.'
      );
    }
    return { userId, campaignId, access };
  }

  function listRuns(input = {}) {
    const context = requireAccess(input.userId, input.campaignId);
    const query = input.query === undefined || input.query === null ? {} : input.query;
    if (!plainObject(query)) {
      throw serviceError(400, 'PERFORMANCE_COLLECTION_RUN_QUERY_INVALID', 'Query must be an object.');
    }
    const unsupported = Object.keys(query).find((key) => key !== 'limit');
    if (unsupported) {
      throw serviceError(
        400,
        'PERFORMANCE_COLLECTION_RUN_QUERY_INVALID',
        'Query contains an unsupported field.',
        { field: unsupported }
      );
    }
    const limit = normalizedLimit(query.limit);
    const activityTable = db.prepare(
      "SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name='activity_log'"
    ).get();
    if (!activityTable) {
      throw serviceError(503, 'PERFORMANCE_COLLECTION_RUN_HISTORY_UNAVAILABLE', 'Collection run history is unavailable.');
    }
    const scannedRows = db.prepare(`
      SELECT id,module,action,details,created_at
      FROM activity_log
      ORDER BY id DESC
      LIMIT ?
    `).all(MAX_ACTIVITY_SCAN_ROWS + 1);
    const auditScanTruncated = scannedRows.length > MAX_ACTIVITY_SCAN_ROWS;
    const rows = scannedRows
      .slice(0, MAX_ACTIVITY_SCAN_ROWS)
      .filter((row) => {
        if (row.module !== 'performance' || !COLLECTION_ACTIONS.includes(row.action)) return false;
        const details = safeJson(row.details);
        return details && positiveId(details.campaign_id) === context.campaignId;
      })
      .slice(0, MAX_HISTORY_ROWS + 1);
    const historyWindowTruncated = rows.length > MAX_HISTORY_ROWS;
    const windowRows = rows.slice(0, MAX_HISTORY_ROWS);
    const authorizedPublicationIds = authorizedManualPublicationIds(db, windowRows, context);
    const projected = windowRows
      .map((row) => projectRun(row, context.campaignId, authorizedPublicationIds))
      .filter(Boolean);
    const items = projected.slice(0, limit);
    const summary = projected.reduce((result, item) => {
      result.total += 1;
      result[item.status] += 1;
      return result;
    }, { total: 0, succeeded: 0, partial: 0, failed: 0 });
    summary.latest_completed_at = projected.length ? projected[0].completed_at : null;
    return {
      contract_version: COLLECTION_RUN_CONTRACT_VERSION,
      campaign_id: context.campaignId,
      source: {
        mode: 'audit_projection',
        provider_dispatch_available: false,
        audit_scan_limit: MAX_ACTIVITY_SCAN_ROWS,
        audit_scan_truncated: auditScanTruncated,
        history_window_limit: MAX_HISTORY_ROWS,
        history_window_truncated: historyWindowTruncated
      },
      summary,
      items,
      page: {
        limit,
        returned: items.length,
        has_more: projected.length > items.length
      },
      capabilities: {
        can_view: true,
        diagnostics_level: 'summary'
      }
    };
  }

  return Object.freeze({ listRuns });
}

module.exports = {
  COLLECTION_RUN_CONTRACT_VERSION,
  PerformanceCollectionRunServiceError,
  createPerformanceCollectionRunService
};

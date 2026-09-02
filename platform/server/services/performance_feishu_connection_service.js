'use strict';

const { types: utilTypes } = require('node:util');
const { getCampaignAccess: defaultGetCampaignAccess } = require('./campaign_access_service');

const SAFE_MAX = Number.MAX_SAFE_INTEGER;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]+$/;
const CONFIGURATION_FIELDS = Object.freeze([
  'bitable_app_token',
  'current_table_id',
  'daily_snapshot_table_id',
  'field_mapping'
]);
const ALLOWED_MAPPING_KEYS = new Set([
  'content.original_url',
  'content.platform',
  'content.creator_id',
  'content.creator_name',
  'content.product',
  'content.tags',
  'content.published_at',
  'latest_observation.observed_at',
  'latest_observation.views',
  'latest_observation.impressions',
  'latest_observation.likes',
  'latest_observation.comments',
  'latest_observation.saves',
  'latest_observation.shares',
  'latest_observation.clicks',
  'latest_observation.conversions',
  'metrics.observed_engagement_total',
  'metrics.core_view_er',
  'metrics.ctr'
]);
const REQUIRED_MAPPING_KEYS = Object.freeze([
  'content.original_url',
  'latest_observation.observed_at'
]);

class PerformanceFeishuConnectionServiceError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'PerformanceFeishuConnectionServiceError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function serviceError(statusCode, code, message, details) {
  return new PerformanceFeishuConnectionServiceError(statusCode, code, message, details);
}

function positiveInteger(value) {
  if (Number.isSafeInteger(value) && value > 0 && value <= SAFE_MAX) return value;
  if (typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0 && String(parsed) === value) return parsed;
  }
  return null;
}

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)) return null;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string')) return null;
    const snapshot = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function scalarText(value, minimum, maximum) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) return null;
  return normalized;
}

function identifier(value, field, optional) {
  if ((value === undefined || value === null || value === '') && optional) return null;
  const normalized = scalarText(value, 3, 160);
  if (!normalized || !IDENTIFIER_PATTERN.test(normalized)) {
    throw serviceError(400, 'PERFORMANCE_FEISHU_CONNECTION_IDENTIFIER_INVALID', `${field} is invalid.`, { field });
  }
  return normalized;
}

function mappingValue(value, field) {
  const normalized = scalarText(value, 1, 100);
  if (!normalized) {
    throw serviceError(400, 'PERFORMANCE_FEISHU_CONNECTION_MAPPING_INVALID', 'A Feishu field mapping is invalid.', { field });
  }
  return normalized;
}

function normalizeMapping(value) {
  const input = plainObject(value);
  if (!input) {
    throw serviceError(400, 'PERFORMANCE_FEISHU_CONNECTION_MAPPING_INVALID', 'field_mapping must be an object.');
  }
  const entries = Object.entries(input);
  if (entries.length < REQUIRED_MAPPING_KEYS.length || entries.length > ALLOWED_MAPPING_KEYS.size) {
    throw serviceError(400, 'PERFORMANCE_FEISHU_CONNECTION_MAPPING_INVALID', 'field_mapping has an invalid number of fields.');
  }
  const mapping = {};
  const targets = new Set();
  for (const [sourceKey, targetField] of entries) {
    if (!ALLOWED_MAPPING_KEYS.has(sourceKey)) {
      throw serviceError(400, 'PERFORMANCE_FEISHU_CONNECTION_MAPPING_INVALID', 'field_mapping contains an unsupported platform field.', { field: sourceKey });
    }
    const target = mappingValue(targetField, sourceKey);
    if (targets.has(target)) {
      throw serviceError(400, 'PERFORMANCE_FEISHU_CONNECTION_MAPPING_INVALID', 'Each platform field must map to a distinct Feishu field.', { field: sourceKey });
    }
    targets.add(target);
    mapping[sourceKey] = target;
  }
  for (const key of REQUIRED_MAPPING_KEYS) {
    if (!Object.hasOwn(mapping, key)) {
      throw serviceError(400, 'PERFORMANCE_FEISHU_CONNECTION_MAPPING_INVALID', 'Video link and observation time mappings are required.', { field: key });
    }
  }
  return Object.fromEntries(Object.entries(mapping).sort(([left], [right]) => left.localeCompare(right)));
}

function normalizeConfiguration(body) {
  const input = plainObject(body);
  if (!input || Object.keys(input).some((key) => !CONFIGURATION_FIELDS.includes(key))) {
    throw serviceError(400, 'PERFORMANCE_FEISHU_CONNECTION_INVALID', 'The Feishu connection configuration is invalid.');
  }
  return {
    bitableAppToken: identifier(input.bitable_app_token, 'bitable_app_token', false),
    currentTableId: identifier(input.current_table_id, 'current_table_id', false),
    dailySnapshotTableId: identifier(input.daily_snapshot_table_id, 'daily_snapshot_table_id', true),
    fieldMapping: normalizeMapping(input.field_mapping)
  };
}

function nowIso() {
  return new Date().toISOString();
}

function parseMapping(value) {
  try {
    return normalizeMapping(JSON.parse(String(value || '{}')));
  } catch (error) {
    if (error instanceof PerformanceFeishuConnectionServiceError) throw error;
    throw new Error('stored Feishu field mapping is invalid');
  }
}

function publicExternalSyncState() {
  return Object.freeze({
    enabled: false,
    reason: 'not_enabled_in_this_release',
    read_attempted: false,
    write_attempted: false
  });
}

function serializeConfiguration(row, includeSensitive) {
  if (!row) return null;
  const result = {
    id: Number(row.id),
    version: Number(row.version),
    status: row.status,
    created_at: row.created_at,
    approved_at: row.approved_at || null,
    superseded_at: row.superseded_at || null,
    external_sync: publicExternalSyncState()
  };
  if (includeSensitive) {
    result.bitable_app_token = row.bitable_app_token;
    result.current_table_id = row.current_table_id;
    result.daily_snapshot_table_id = row.daily_snapshot_table_id || null;
    result.field_mapping = parseMapping(row.field_mapping_json);
  }
  return result;
}

function createPerformanceFeishuConnectionService(db, options = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('A SQLite database is required.');
  const getCampaignAccess = options.getCampaignAccess || defaultGetCampaignAccess;

  function requireAccess(userIdValue, campaignIdValue, mode) {
    const userId = positiveInteger(userIdValue);
    const campaignId = positiveInteger(campaignIdValue);
    if (userId === null || campaignId === null) {
      throw serviceError(400, 'PERFORMANCE_FEISHU_CONNECTION_CAMPAIGN_INVALID', 'Campaign or user is invalid.');
    }
    const access = getCampaignAccess(db, { userId, campaignId });
    if (!access || !access.ok) {
      throw serviceError(access && access.status === 403 ? 403 : 404, access && access.code || 'CAMPAIGN_NOT_FOUND', 'Campaign access is unavailable.');
    }
    if (!access.permissions || access.permissions.read !== true) {
      throw serviceError(403, 'PERFORMANCE_FEISHU_CONNECTION_FORBIDDEN', 'Campaign access is forbidden.');
    }
    const canManage = access.permissions.write === true && (access.role === 'owner' || access.role === 'org_admin');
    const canApprove = access.permissions.write === true && access.role === 'org_admin';
    if (mode === 'manage' && !canManage) {
      throw serviceError(403, 'PERFORMANCE_FEISHU_CONNECTION_MANAGE_FORBIDDEN', 'Feishu connection configuration is not available.');
    }
    if (mode === 'approve' && !canApprove) {
      throw serviceError(403, 'PERFORMANCE_FEISHU_CONNECTION_APPROVAL_FORBIDDEN', 'Feishu connection approval is not available.');
    }
    return { userId, campaignId, orgId: access.campaign.org_id, canManage, canApprove };
  }

  function writeAudit(userId, action, details) {
    const table = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='activity_log'").get();
    if (!table) return;
    db.prepare('INSERT INTO activity_log (user_id,action,module,details,ip_address) VALUES (?,?,?,?,?)')
      .run(userId, action, 'performance', JSON.stringify(details), null);
  }

  function readRow(orgId, campaignId, configurationId) {
    return db.prepare(`
      SELECT * FROM performance_feishu_projection_configs
      WHERE org_id=? AND campaign_id=? AND id=?
    `).get(orgId, campaignId, configurationId);
  }

  function stateFor(context) {
    const active = db.prepare(`
      SELECT * FROM performance_feishu_projection_configs
      WHERE org_id=? AND campaign_id=? AND status='approved'
      ORDER BY version DESC,id DESC
      LIMIT 1
    `).get(context.orgId, context.campaignId);
    const draft = context.canManage ? db.prepare(`
      SELECT * FROM performance_feishu_projection_configs
      WHERE org_id=? AND campaign_id=? AND status='draft'
      ORDER BY version DESC,id DESC
      LIMIT 1
    `).get(context.orgId, context.campaignId) : null;
    return {
      campaign_id: context.campaignId,
      active_configuration: serializeConfiguration(active, context.canManage),
      draft_configuration: context.canManage ? serializeConfiguration(draft, true) : null,
      capabilities: {
        can_manage: context.canManage,
        can_approve: context.canApprove,
        external_sync_enabled: false
      },
      external_sync: publicExternalSyncState()
    };
  }

  function getConnection(input) {
    return stateFor(requireAccess(input && input.userId, input && input.campaignId, 'view'));
  }

  function createDraft(input) {
    const context = requireAccess(input && input.userId, input && input.campaignId, 'manage');
    const configuration = normalizeConfiguration(input && input.body);
    const row = db.transaction(() => {
      const version = Number(db.prepare(`
        SELECT COALESCE(MAX(version),0)+1 AS version
        FROM performance_feishu_projection_configs
        WHERE org_id=? AND campaign_id=?
      `).get(context.orgId, context.campaignId).version);
      const result = db.prepare(`
        INSERT INTO performance_feishu_projection_configs (
          org_id,campaign_id,version,bitable_app_token,current_table_id,daily_snapshot_table_id,
          field_mapping_json,status,created_by
        ) VALUES (?,?,?,?,?,?,?,?,?)
      `).run(
        context.orgId,
        context.campaignId,
        version,
        configuration.bitableAppToken,
        configuration.currentTableId,
        configuration.dailySnapshotTableId,
        JSON.stringify(configuration.fieldMapping),
        'draft',
        context.userId
      );
      return readRow(context.orgId, context.campaignId, Number(result.lastInsertRowid));
    })();
    writeAudit(context.userId, 'performance_feishu_connection_draft', {
      campaign_id: context.campaignId,
      configuration_id: Number(row.id),
      version: Number(row.version)
    });
    const state = stateFor(context);
    return Object.assign(state, { configuration: serializeConfiguration(row, true) });
  }

  function approveDraft(input) {
    const context = requireAccess(input && input.userId, input && input.campaignId, 'approve');
    const configurationId = positiveInteger(input && input.configurationId);
    if (configurationId === null) {
      throw serviceError(400, 'PERFORMANCE_FEISHU_CONNECTION_CONFIGURATION_INVALID', 'The configuration is invalid.');
    }
    const approved = db.transaction(() => {
      const draft = readRow(context.orgId, context.campaignId, configurationId);
      if (!draft) {
        throw serviceError(404, 'PERFORMANCE_FEISHU_CONNECTION_NOT_FOUND', 'The configuration was not found.');
      }
      if (draft.status !== 'draft') {
        throw serviceError(409, 'PERFORMANCE_FEISHU_CONNECTION_NOT_DRAFT', 'Only a draft configuration can be approved.');
      }
      const timestamp = nowIso();
      db.prepare(`
        UPDATE performance_feishu_projection_configs
        SET status='superseded', superseded_at=?
        WHERE org_id=? AND campaign_id=? AND status='approved'
      `).run(timestamp, context.orgId, context.campaignId);
      db.prepare(`
        UPDATE performance_feishu_projection_configs
        SET status='approved', approved_by=?, approved_at=?
        WHERE id=? AND org_id=? AND campaign_id=? AND status='draft'
      `).run(context.userId, timestamp, configurationId, context.orgId, context.campaignId);
      return readRow(context.orgId, context.campaignId, configurationId);
    })();
    writeAudit(context.userId, 'performance_feishu_connection_approved', {
      campaign_id: context.campaignId,
      configuration_id: Number(approved.id),
      version: Number(approved.version)
    });
    const state = stateFor(context);
    return Object.assign(state, { configuration: serializeConfiguration(approved, true) });
  }

  return Object.freeze({ getConnection, createDraft, approveDraft });
}

module.exports = {
  PerformanceFeishuConnectionServiceError,
  createPerformanceFeishuConnectionService
};

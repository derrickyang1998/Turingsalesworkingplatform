'use strict';

const MAX_PROJECTION_RECORDS = 5000;
const CONTRACT_VERSION = 'performance-feishu-projection-preview-v1';
const { TARGET_KINDS } = require('./performance_feishu_contract');

class PerformanceFeishuProjectionServiceError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'PerformanceFeishuProjectionServiceError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function projectionError(statusCode, code, message, details) {
  return new PerformanceFeishuProjectionServiceError(statusCode, code, message, details);
}

function sourceValue(content, sourceKey) {
  const parts = String(sourceKey || '').split('.');
  if (parts.length !== 2) return undefined;
  const [scope, field] = parts;
  if (scope === 'content') {
    const value = content && content[field];
    if (field === 'tags') return Array.isArray(value) ? value.join(', ') : undefined;
    return value;
  }
  if (scope === 'latest_observation') {
    return content && content.latest_observation && content.latest_observation[field];
  }
  if (scope === 'metrics') {
    const metric = content && content.metrics && content.metrics[field];
    if (!metric || metric.available !== true || !Number.isFinite(Number(metric.value))) return undefined;
    return Number(metric.value);
  }
  return undefined;
}

function csvCell(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  const text = String(value).replace(/[\r\n]+/g, ' ').replace(/\u0000/g, '');
  const formulaSafe = /^\s*[=+\-@]/.test(text) ? "'" + text : text;
  return '"' + formulaSafe.replace(/"/g, '""') + '"';
}

function createPerformanceFeishuProjectionService(options = {}) {
  const performanceService = options.performanceService;
  const feishuConnectionService = options.feishuConnectionService;
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  if (!performanceService || typeof performanceService.getProjectionSnapshot !== 'function') {
    throw new TypeError('A performance service is required.');
  }
  if (!feishuConnectionService || typeof feishuConnectionService.getConnection !== 'function') {
    throw new TypeError('A performance Feishu connection service is required.');
  }

  function readObservedContents(input) {
    const snapshot = performanceService.getProjectionSnapshot({
      userId: input.userId,
      campaignId: input.campaignId
    });
    const items = snapshot && Array.isArray(snapshot.items) ? snapshot.items : null;
    const total = snapshot && Number.isSafeInteger(Number(snapshot.total)) ? Number(snapshot.total) : null;
    if (!items || total === null || total < 0 || snapshot.consistency !== 'sqlite_read_transaction') {
      throw projectionError(503, 'PERFORMANCE_FEISHU_PROJECTION_SOURCE_INVALID', 'Performance snapshot data is unavailable.');
    }
    if (total > MAX_PROJECTION_RECORDS) {
      throw projectionError(413, 'PERFORMANCE_FEISHU_PROJECTION_LIMIT_EXCEEDED', 'The Feishu snapshot exceeds the current record limit.', {
        max_records: MAX_PROJECTION_RECORDS,
        total
      });
    }
    const publicationIds = items.map((item) => Number(item && item.id));
    if (items.length !== total || publicationIds.some((id) => !Number.isSafeInteger(id) || id < 1) ||
        new Set(publicationIds).size !== publicationIds.length) {
      throw projectionError(409, 'PERFORMANCE_FEISHU_PROJECTION_SOURCE_CHANGED', 'Performance rows changed while the snapshot was being prepared.');
    }
    return items;
  }

  function buildProjection(input, configuration, targetKind) {
    const mappingEntries = Object.entries(configuration.field_mapping)
      .sort(([left], [right]) => left.localeCompare(right));
    const columns = mappingEntries.map(([, targetField]) => targetField);
    const sourceItems = readObservedContents(input);
    const observedItems = sourceItems.filter((content) => (
      content && content.latest_observation && content.latest_observation.observed_at
    ));
    const records = observedItems.map((content) => {
      const fields = {};
      for (const [sourceKey, targetField] of mappingEntries) {
        const value = sourceValue(content, sourceKey);
        if (value !== undefined && value !== null && value !== '') fields[targetField] = value;
      }
      return { fields };
    });
    const observedTimes = observedItems.map((content) => content.latest_observation.observed_at).sort();
    const generatedAt = now().toISOString();
    return {
      contract_version: CONTRACT_VERSION,
      campaign_id: Number(input.campaignId),
      configuration: {
        id: Number(configuration.id),
        version: Number(configuration.version),
        status: configuration.status
      },
      target: {
        kind: targetKind,
        configured: Boolean(targetKind === 'daily_snapshot'
          ? configuration.daily_snapshot_table_id
          : configuration.current_table_id)
      },
      snapshot: {
        generated_at: generatedAt,
        source_total: sourceItems.length,
        record_count: records.length,
        excluded_without_observation: sourceItems.length - records.length,
        latest_observed_at: observedTimes.length ? observedTimes[observedTimes.length - 1] : null
      },
      columns,
      records
    };
  }

  function preview(input = {}) {
    const connection = feishuConnectionService.getConnection({
      userId: input.userId,
      campaignId: input.campaignId
    });
    if (!connection || !connection.capabilities || connection.capabilities.can_manage !== true) {
      throw projectionError(403, 'PERFORMANCE_FEISHU_PROJECTION_FORBIDDEN', 'Feishu performance snapshot export is not available.');
    }
    const configuration = connection.active_configuration;
    if (!configuration || configuration.status !== 'approved' || !configuration.field_mapping) {
      throw projectionError(409, 'PERFORMANCE_FEISHU_PROJECTION_CONFIGURATION_REQUIRED', 'An approved Feishu field mapping is required.');
    }
    const targetKind = configuration.daily_snapshot_table_id ? 'daily_snapshot' : 'current_state';
    const result = buildProjection(input, configuration, targetKind);
    result.campaign_id = Number(connection.campaign_id || input.campaignId);
    result.target.configured = Boolean(configuration.daily_snapshot_table_id || configuration.current_table_id);
    return result;
  }

  function prepareDelivery(input = {}) {
    if (!feishuConnectionService || typeof feishuConnectionService.getDeliveryConfiguration !== 'function') {
      throw projectionError(503, 'PERFORMANCE_FEISHU_PROJECTION_DELIVERY_UNAVAILABLE', 'Performance Feishu delivery is unavailable.');
    }
    const targetKind = input.targetKind || 'current_state';
    if (!TARGET_KINDS.includes(targetKind)) {
      throw projectionError(400, 'PERFORMANCE_FEISHU_PROJECTION_TARGET_INVALID', 'The performance Feishu target is invalid.');
    }
    const configuration = feishuConnectionService.getDeliveryConfiguration({
      userId: input.userId,
      campaignId: input.campaignId
    });
    if (!configuration || configuration.status !== 'approved' || !configuration.field_mapping) {
      throw projectionError(409, 'PERFORMANCE_FEISHU_PROJECTION_CONFIGURATION_REQUIRED', 'An approved Feishu field mapping is required.');
    }
    if (targetKind === 'daily_snapshot' && !configuration.daily_snapshot_table_id) {
      throw projectionError(409, 'PERFORMANCE_FEISHU_PROJECTION_TARGET_NOT_CONFIGURED', 'A daily snapshot table is not configured.');
    }
    const result = buildProjection(input, configuration, targetKind);
    if (result.snapshot.record_count < 1) {
      throw projectionError(409, 'PERFORMANCE_FEISHU_PROJECTION_NO_OBSERVED_RECORDS', 'No observed performance rows are available for Feishu delivery.');
    }
    const requiredFields = [
      configuration.field_mapping['content.original_url'],
      configuration.field_mapping['latest_observation.observed_at']
    ];
    if (result.records.some((record) => requiredFields.some((field) => !Object.hasOwn(record.fields, field)))) {
      throw projectionError(409, 'PERFORMANCE_FEISHU_PROJECTION_REQUIRED_FIELD_MISSING', 'A video link and observation time are required for Feishu delivery.');
    }
    return {
      target_kind: targetKind,
      configuration,
      records: result.records,
      snapshot: result.snapshot,
      columns: result.columns
    };
  }

  function exportCsv(input = {}) {
    const result = preview(input);
    const header = result.columns.map(csvCell).join(',');
    const rows = result.records.map((record) => (
      result.columns.map((column) => csvCell(record.fields[column])).join(',')
    ));
    return {
      filename: `performance_campaign_${result.campaign_id}_feishu_snapshot_${result.snapshot.generated_at.slice(0, 10)}.csv`,
      csv: '\ufeff' + [header].concat(rows).join('\r\n') + '\r\n',
      record_count: result.snapshot.record_count,
      snapshot: result.snapshot
    };
  }

  return Object.freeze({ preview, prepareDelivery, exportCsv });
}

module.exports = {
  CONTRACT_VERSION,
  PerformanceFeishuProjectionServiceError,
  createPerformanceFeishuProjectionService
};

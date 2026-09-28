'use strict';

const crypto = require('node:crypto');

const CONTRACT_VERSION = 'performance-feishu-scheduler-v1';
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;
const MAX_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_TIME_ZONE = 'Asia/Shanghai';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SKIPPABLE_CODES = new Set([
  'PERFORMANCE_FEISHU_CONNECTION_NOT_APPROVED',
  'PERFORMANCE_FEISHU_PROJECTION_NO_OBSERVED_RECORDS',
  'PERFORMANCE_FEISHU_PROJECTION_REQUIRED_FIELD_MISSING',
  'PERFORMANCE_FEISHU_PROJECTION_SOURCE_CHANGED',
  'PERFORMANCE_FEISHU_PROJECTION_CONFIGURATION_REQUIRED',
  'PERFORMANCE_FEISHU_PROJECTION_TARGET_NOT_CONFIGURED',
  'PERFORMANCE_FEISHU_PROJECTION_FORBIDDEN'
]);

class PerformanceFeishuSchedulerServiceError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'PerformanceFeishuSchedulerServiceError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function serviceError(statusCode, code, message, details) {
  return new PerformanceFeishuSchedulerServiceError(statusCode, code, message, details);
}

function positiveId(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,15}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && String(parsed) === value ? parsed : null;
}

function asIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('Performance Feishu scheduler clock is invalid.');
  return date.toISOString();
}

function safeExternalStatus(feishuClient) {
  const status = feishuClient.getPerformanceStatus();
  return {
    enabled: Boolean(status && status.enabled === true),
    mode: status && typeof status.mode === 'string' ? status.mode : 'performance_bitable',
    missing: status && Array.isArray(status.missing) ? status.missing.slice() : []
  };
}

function localDayKey(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('Performance Feishu scheduler clock is invalid.');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const fields = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  if (!/^\d{4}$/.test(fields.year) || !/^\d{2}$/.test(fields.month) || !/^\d{2}$/.test(fields.day)) {
    throw new TypeError('Performance Feishu scheduler time zone is invalid.');
  }
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function stableOperationId(parts) {
  const digest = crypto.createHash('sha256')
    .update(`${CONTRACT_VERSION}\u0000${parts.join('\u0000')}`)
    .digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString('hex').slice(0, 32);
  const value = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  if (!UUID_PATTERN.test(value)) throw new Error('Generated scheduler operation ID is invalid.');
  return value;
}

function safeErrorCode(error) {
  return error && typeof error.code === 'string' && /^[A-Z0-9_]{3,100}$/.test(error.code)
    ? error.code
    : 'PERFORMANCE_FEISHU_SCHEDULER_FAILED';
}

function createPerformanceFeishuSchedulerService(db, options = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('A SQLite database is required.');
  const connectionService = options.connectionService;
  const freshnessService = options.freshnessService;
  const deliveryService = options.deliveryService;
  const feishuClient = options.feishuClient;
  if (!connectionService || typeof connectionService.getConnection !== 'function' ||
      typeof connectionService.getDeliveryConfiguration !== 'function') {
    throw new TypeError('A performance Feishu connection service is required.');
  }
  if (!freshnessService || typeof freshnessService.getQueue !== 'function') {
    throw new TypeError('A performance freshness service is required.');
  }
  if (!deliveryService || typeof deliveryService.sync !== 'function') {
    throw new TypeError('A performance Feishu delivery service is required.');
  }
  if (!feishuClient || typeof feishuClient.getPerformanceStatus !== 'function') {
    throw new TypeError('A Feishu client is required.');
  }

  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const enabled = options.enabled === true;
  const timeZone = typeof options.timeZone === 'string' && options.timeZone.trim()
    ? options.timeZone.trim()
    : DEFAULT_TIME_ZONE;
  const intervalMs = Number.isSafeInteger(options.intervalMs) &&
      options.intervalMs >= MIN_INTERVAL_MS && options.intervalMs <= MAX_INTERVAL_MS
    ? options.intervalMs
    : DEFAULT_INTERVAL_MS;
  const runtime = {
    lastTickAt: null,
    lastResult: null,
    lastErrorCode: null
  };
  let inFlight = null;

  function activeCampaigns() {
    return db.prepare(`
      SELECT configuration.org_id,configuration.campaign_id,
        configuration.id AS configuration_id,configuration.version,
        configuration.daily_snapshot_table_id
      FROM performance_feishu_projection_configs configuration
      JOIN campaigns campaign
        ON campaign.org_id=configuration.org_id AND campaign.id=configuration.campaign_id
      WHERE configuration.status='approved' AND campaign.operational_status='active'
      ORDER BY configuration.org_id,configuration.campaign_id,configuration.version DESC,configuration.id DESC
    `).all();
  }

  function scheduledActor(orgId) {
    const admin = db.prepare(`
      SELECT membership.user_id
      FROM organization_memberships membership
      JOIN users user ON user.id=membership.user_id
      WHERE membership.org_id=? AND membership.role_code='org_admin'
        AND membership.status='active' AND user.is_active=1
      ORDER BY membership.user_id LIMIT 1
    `).get(orgId);
    return admin ? Number(admin.user_id) : null;
  }

  function campaignStatus(input = {}) {
    const userId = positiveId(input.userId);
    const campaignId = positiveId(input.campaignId);
    if (userId === null || campaignId === null) {
      throw serviceError(400, 'PERFORMANCE_FEISHU_SCHEDULER_REQUEST_INVALID', 'Campaign or user is invalid.');
    }
    const external = safeExternalStatus(feishuClient);
    const connection = connectionService.getConnection({ userId, campaignId });
    const queue = freshnessService.getQueue({ userId, campaignId });
    const active = connection && connection.active_configuration;
    let status = 'ready';
    let reason = null;
    if (!enabled) {
      status = 'disabled';
      reason = 'scheduler_disabled';
    } else if (!external.enabled) {
      status = 'not_configured';
      reason = 'external_sync_not_configured';
    } else if (!active || active.status !== 'approved') {
      status = 'mapping_required';
      reason = 'approved_mapping_required';
    } else if (!queue.schedule || !queue.schedule.latest_observation_at) {
      status = 'waiting_for_observation';
      reason = 'performance_observation_required';
    }
    return {
      contract_version: CONTRACT_VERSION,
      scheduler_enabled: enabled,
      status,
      reason,
      interval_seconds: intervalMs / 1000,
      time_zone: timeZone,
      external_sync: external,
      last_tick_at: runtime.lastTickAt,
      next_tick_at: runtime.lastTickAt
        ? new Date(Date.parse(runtime.lastTickAt) + intervalMs).toISOString()
        : null,
      last_result: runtime.lastResult,
      last_error_code: runtime.lastErrorCode,
      campaign: {
        id: campaignId,
        mapping_version: active && Number.isSafeInteger(Number(active.version)) ? Number(active.version) : null,
        latest_observation_at: queue.schedule && queue.schedule.latest_observation_at || null,
        next_current_state_due_at: queue.schedule && queue.schedule.next_due_at || null,
        daily_snapshot_local_day: localDayKey(now(), timeZone),
        daily_snapshot_enabled: Boolean(active && active.daily_snapshot_table_id)
      }
    };
  }

  function summaryBase(status, external, campaignsConsidered) {
    return {
      contract_version: CONTRACT_VERSION,
      status,
      scheduler_enabled: enabled,
      external_sync_enabled: external.enabled,
      external_sync_missing: external.missing,
      time_zone: timeZone,
      campaigns_considered: campaignsConsidered,
      campaigns_skipped: 0,
      campaigns_failed: 0,
      campaigns_attention: 0,
      deliveries_started: 0,
      deliveries_replayed: 0,
      completed_at: null,
      error_codes: []
    };
  }

  function recordSyncResult(summary, result) {
    if (!result || !Number.isSafeInteger(result.statusCode)) {
      summary.campaigns_attention += 1;
      summary.error_codes.push('PERFORMANCE_FEISHU_SCHEDULER_RESULT_INVALID');
      return;
    }
    if (result.statusCode === 202) {
      summary.campaigns_attention += 1;
      summary.error_codes.push(
        result.body && typeof result.body.code === 'string'
          ? result.body.code
          : 'PERFORMANCE_FEISHU_RECONCILIATION_REQUIRED'
      );
      return;
    }
    if (result.statusCode >= 400) {
      summary.campaigns_attention += 1;
      summary.error_codes.push(
        result.body && typeof result.body.code === 'string'
          ? result.body.code
          : 'PERFORMANCE_FEISHU_SCHEDULER_DELIVERY_REJECTED'
      );
      return;
    }
    if (result.body && result.body.configured === false) {
      summary.campaigns_attention += 1;
      summary.error_codes.push('FEISHU_BITABLE_WRITE_NOT_AVAILABLE');
      return;
    }
    if (result.body && result.body.replayed === true) summary.deliveries_replayed += 1;
    else summary.deliveries_started += 1;
  }

  async function runCampaign(campaign, actor, clock) {
    const configuration = connectionService.getDeliveryConfiguration({
      userId: actor,
      campaignId: Number(campaign.campaign_id)
    });
    const queue = freshnessService.getQueue({
      userId: actor,
      campaignId: Number(campaign.campaign_id)
    });
    const latestObservedAt = queue.schedule && queue.schedule.latest_observation_at;
    if (!latestObservedAt) {
      return { skipped: true, reason: 'performance_observation_required' };
    }

    const campaignId = Number(campaign.campaign_id);
    const currentOperationId = stableOperationId([
      'current_state',
      String(campaignId),
      String(configuration.id),
      String(configuration.version),
      String(latestObservedAt)
    ]);
    const results = [];
    results.push(await deliveryService.sync({
      userId: actor,
      campaignId,
      operationId: currentOperationId,
      body: { snapshot_kind: 'current_state' }
    }));

    if (configuration.daily_snapshot_table_id) {
      const day = localDayKey(clock, timeZone);
      const dailyOperationId = stableOperationId([
        'daily_snapshot',
        String(campaignId),
        String(configuration.id),
        String(configuration.version),
        day
      ]);
      results.push(await deliveryService.sync({
        userId: actor,
        campaignId,
        operationId: dailyOperationId,
        body: { snapshot_kind: 'daily_snapshot' }
      }));
    }
    return { skipped: false, results };
  }

  async function runScheduledDueDeliveries() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const clock = new Date(now());
      const completedAt = asIso(clock);
      const external = safeExternalStatus(feishuClient);
      const campaigns = activeCampaigns();
      const summary = summaryBase(
        !enabled ? 'disabled' : (!external.enabled ? 'not_configured' : 'completed'),
        external,
        campaigns.length
      );
      if (!enabled || !external.enabled) {
        summary.completed_at = completedAt;
        runtime.lastTickAt = completedAt;
        runtime.lastResult = summary;
        runtime.lastErrorCode = null;
        return summary;
      }

      for (const campaign of campaigns) {
        const actor = scheduledActor(Number(campaign.org_id));
        if (actor === null) {
          summary.campaigns_skipped += 1;
          continue;
        }
        try {
          const result = await runCampaign(campaign, actor, clock);
          if (result.skipped) {
            summary.campaigns_skipped += 1;
            continue;
          }
          result.results.forEach((delivery) => recordSyncResult(summary, delivery));
        } catch (error) {
          if (SKIPPABLE_CODES.has(safeErrorCode(error))) {
            summary.campaigns_skipped += 1;
          } else {
            summary.campaigns_failed += 1;
            summary.error_codes.push(safeErrorCode(error));
          }
        }
      }
      summary.error_codes = [...new Set(summary.error_codes)].sort();
      summary.completed_at = asIso(now());
      runtime.lastTickAt = summary.completed_at;
      runtime.lastResult = summary;
      runtime.lastErrorCode = summary.error_codes[0] || null;
      if (summary.campaigns_failed > 0) summary.status = 'degraded';
      return summary;
    })();
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  return Object.freeze({
    campaignStatus,
    runScheduledDueDeliveries
  });
}

function startPerformanceFeishuScheduler(service, options = {}) {
  if (!service || typeof service.runScheduledDueDeliveries !== 'function') {
    throw new TypeError('A performance Feishu scheduler service is required.');
  }
  const intervalMs = Number.isSafeInteger(options.intervalMs) &&
      options.intervalMs >= MIN_INTERVAL_MS && options.intervalMs <= MAX_INTERVAL_MS
    ? options.intervalMs
    : DEFAULT_INTERVAL_MS;
  const initialDelayMs = Number.isSafeInteger(options.initialDelayMs) && options.initialDelayMs >= 0
    ? options.initialDelayMs
    : 15000;
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  let stopped = false;
  let running = false;
  async function tick() {
    if (stopped || running) return;
    running = true;
    try {
      await service.runScheduledDueDeliveries();
    } catch (error) {
      onError(error);
    } finally {
      running = false;
    }
  }
  const initial = setTimeout(tick, initialDelayMs);
  const interval = setInterval(tick, intervalMs);
  if (typeof initial.unref === 'function') initial.unref();
  if (typeof interval.unref === 'function') interval.unref();
  return Object.freeze({
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(initial);
      clearInterval(interval);
    }
  });
}

module.exports = {
  CONTRACT_VERSION,
  DEFAULT_INTERVAL_MS,
  DEFAULT_TIME_ZONE,
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
  PerformanceFeishuSchedulerServiceError,
  createPerformanceFeishuSchedulerService,
  localDayKey,
  stableOperationId,
  startPerformanceFeishuScheduler
};

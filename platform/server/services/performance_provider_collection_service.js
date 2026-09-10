'use strict';

const crypto = require('node:crypto');
const { getCampaignAccess: defaultGetCampaignAccess } = require('./campaign_access_service');
const { assessContentFreshness } = require('./performance_freshness_service');

const CONTRACT_VERSION = 'performance-provider-collection-v1';
const PROVIDER = 'youtube';
const MAX_ITEMS_PER_RUN = 50;
const SCHEDULE_BUCKET_MS = 15 * 60 * 1000;
const DEFAULT_SCHEDULER_INTERVAL_MS = 5 * 60 * 1000;
const CLAIM_LEASE_MS = 10 * 60 * 1000;
const MANUAL_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
const USER_MANUAL_RUNS_PER_HOUR = 12;
const ORGANIZATION_RUNS_PER_HOUR = 120;
const ORGANIZATION_ITEMS_PER_DAY = 5000;
const GLOBAL_PROVIDER_QUOTA_UNITS_PER_DAY = 9000;
const MAX_PROVIDER_ATTEMPTS_PER_ITEM = 3;
const USER_ACTIVE_RUNS = 2;
const ORGANIZATION_ACTIVE_RUNS = 8;
const ELIGIBLE_SCHEDULE_STATES = new Set(['unobserved', 'due', 'stale', 'data_issue']);
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{16,160}$/;

class PerformanceProviderCollectionServiceError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'PerformanceProviderCollectionServiceError';
    this.statusCode = statusCode;
    this.code = code;
    if (details !== undefined) this.details = details;
    Error.captureStackTrace(this, PerformanceProviderCollectionServiceError);
  }
}

function serviceError(statusCode, code, message, details) {
  return new PerformanceProviderCollectionServiceError(statusCode, code, message, details);
}

function positiveId(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,15}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && String(parsed) === value ? parsed : null;
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function safeJson(value, fallback) {
  if (typeof value !== 'string') return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('Provider collection clock is invalid.');
  return date.toISOString();
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function runKey(triggerMode, campaignId, idempotencyKey) {
  return sha256(`${CONTRACT_VERSION}\n${PROVIDER}\n${triggerMode}\n${campaignId}\n${idempotencyKey}`);
}

function secondsUntil(value, clock) {
  const remaining = Date.parse(value) - Date.parse(clock);
  return Number.isFinite(remaining) ? Math.max(1, Math.ceil(remaining / 1000)) : 1;
}

function metricAvailability() {
  return {
    views: { available: true },
    likes: { available: true },
    comments: { available: true },
    saves: { available: false, reason_code: 'provider_metric_unavailable' },
    shares: { available: false, reason_code: 'provider_metric_unavailable' },
    clicks: { available: false, reason_code: 'manual_input_required' },
    revenue: { available: false, reason_code: 'manual_input_required' },
    cost: { available: false, reason_code: 'manual_input_required' }
  };
}

function normalizeMetrics(value) {
  if (!plainObject(value)) throw serviceError(502, 'PERFORMANCE_PROVIDER_RESPONSE_INVALID', 'Provider metrics are invalid.');
  const output = {};
  for (const field of ['views', 'likes', 'comments']) {
    if (!Object.hasOwn(value, field)) continue;
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) {
      throw serviceError(502, 'PERFORMANCE_PROVIDER_RESPONSE_INVALID', 'Provider metrics are invalid.');
    }
    output[field] = value[field];
  }
  if (Object.keys(output).length === 0) {
    throw serviceError(502, 'PERFORMANCE_PROVIDER_RESPONSE_INVALID', 'Provider metrics are unavailable.');
  }
  return output;
}

function normalizeAvailability(value) {
  if (!plainObject(value)) return metricAvailability();
  const output = {};
  for (const field of ['views', 'likes', 'comments', 'saves', 'shares']) {
    const entry = value[field];
    if (!plainObject(entry) || typeof entry.available !== 'boolean') continue;
    output[field] = entry.available
      ? { available: true }
      : { available: false, reason_code: typeof entry.reason_code === 'string' ? entry.reason_code : 'provider_metric_unavailable' };
  }
  return Object.assign(metricAvailability(), output);
}

function safeFailureCategory(error) {
  const code = error && typeof error.code === 'string' ? error.code : '';
  if (/QUOTA_EXCEEDED/.test(code)) return 'quota_exceeded';
  if (/RATE_LIMITED/.test(code)) return 'rate_limited';
  if (/TIMEOUT/.test(code)) return 'provider_timeout';
  if (/VIDEO_NOT_FOUND/.test(code)) return 'content_not_found';
  if (/FORBIDDEN/.test(code)) return 'provider_forbidden';
  if (/RESPONSE_INVALID/.test(code)) return 'provider_response_invalid';
  return 'provider_unavailable';
}

function canonicalProviderResult(raw, content) {
  if (!plainObject(raw) || raw.provider !== PROVIDER || raw.provider_content_id !== content.platform_content_id) {
    throw serviceError(502, 'PERFORMANCE_PROVIDER_RESPONSE_INVALID', 'Provider response identity is invalid.');
  }
  const observedAt = iso(raw.observed_at);
  return {
    provider: PROVIDER,
    provider_content_id: content.platform_content_id,
    observed_at: observedAt,
    metrics: normalizeMetrics(raw.metrics),
    availability: normalizeAvailability(raw.availability),
    attempts: Number.isSafeInteger(raw.attempts) && raw.attempts >= 1 && raw.attempts <= 3 ? raw.attempts : 1
  };
}

function createPerformanceProviderCollectionService(db, options = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('A SQLite database is required.');
  const providerClient = options.providerClient;
  if (!providerClient || typeof providerClient.getStatus !== 'function' || typeof providerClient.fetchStatistics !== 'function') {
    throw new TypeError('A YouTube provider client is required.');
  }
  const performanceService = options.performanceService;
  if (!performanceService || typeof performanceService.getProjectionSnapshot !== 'function') {
    throw new TypeError('A performance projection service is required.');
  }
  const getCampaignAccess = options.getCampaignAccess || defaultGetCampaignAccess;
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const schedulerEnabled = options.schedulerEnabled === true;
  const globalProviderQuotaUnitsPerDay = Number.isSafeInteger(options.globalProviderQuotaUnitsPerDay) &&
      options.globalProviderQuotaUnitsPerDay > 0
    ? options.globalProviderQuotaUnitsPerDay
    : GLOBAL_PROVIDER_QUOTA_UNITS_PER_DAY;
  const inFlight = new Map();

  function accessContext(userIdValue, campaignIdValue, action) {
    const userId = positiveId(userIdValue);
    const campaignId = positiveId(campaignIdValue);
    if (userId === null || campaignId === null) {
      throw serviceError(400, 'PERFORMANCE_PROVIDER_REQUEST_INVALID', 'Campaign or user is invalid.');
    }
    const access = getCampaignAccess(db, { userId, campaignId });
    if (!access || access.ok !== true || !access.permissions || access.permissions.read !== true) {
      throw serviceError(
        access && access.status ? access.status : 403,
        access && access.code ? access.code : 'PERFORMANCE_PROVIDER_FORBIDDEN',
        'Provider collection access is forbidden.'
      );
    }
    const privileged = access.role === 'org_admin' || access.role === 'owner';
    const canDispatch = privileged && access.permissions.write === true &&
      access.campaign && access.campaign.operational_status === 'active';
    if (action === 'dispatch' && !canDispatch) {
      throw serviceError(403, 'PERFORMANCE_PROVIDER_DISPATCH_FORBIDDEN', 'Provider collection cannot be started by this user.');
    }
    return {
      userId,
      campaignId,
      orgId: Number(access.campaign.org_id),
      access,
      canDispatch
    };
  }

  function lastRuns(context) {
    const latest = db.prepare(`
      SELECT status,completed_at
      FROM performance_provider_collection_runs
      WHERE org_id=? AND campaign_id=? AND provider=?
      ORDER BY completed_at DESC,id DESC
      LIMIT 1
    `).get(context.orgId, context.campaignId, PROVIDER) || null;
    const lastSuccess = db.prepare(`
      SELECT status,completed_at
      FROM performance_provider_collection_runs
      WHERE org_id=? AND campaign_id=? AND provider=?
        AND status IN ('succeeded','partial')
      ORDER BY completed_at DESC,id DESC
      LIMIT 1
    `).get(context.orgId, context.campaignId, PROVIDER) || null;
    return {
      latest,
      lastSuccess
    };
  }

  function getCampaignStatus(input = {}) {
    const context = accessContext(input.userId, input.campaignId, 'view');
    const clientStatus = providerClient.getStatus();
    const history = lastRuns(context);
    const configured = clientStatus && clientStatus.configured === true;
    return {
      contract_version: CONTRACT_VERSION,
      provider: PROVIDER,
      status: configured
        ? (history.latest && history.latest.status === 'failed' ? 'degraded' : 'ready')
        : 'not_configured',
      configured,
      dispatch_available: configured && context.canDispatch,
      scheduler_enabled: configured && schedulerEnabled,
      last_success_at: history.lastSuccess ? iso(history.lastSuccess.completed_at) : null,
      next_due_at: null,
      metric_availability: metricAvailability(),
      limits: {
        maximum_items_per_run: MAX_ITEMS_PER_RUN,
        manual_refresh_cooldown_seconds: MANUAL_REFRESH_COOLDOWN_MS / 1000,
        user_manual_runs_per_hour: USER_MANUAL_RUNS_PER_HOUR,
        organization_runs_per_hour: ORGANIZATION_RUNS_PER_HOUR,
        organization_items_per_day: ORGANIZATION_ITEMS_PER_DAY,
        shared_provider_quota_units_per_day: globalProviderQuotaUnitsPerDay,
        maximum_provider_attempts_per_item: MAX_PROVIDER_ATTEMPTS_PER_ITEM
      },
      capabilities: { can_dispatch_provider: configured && context.canDispatch }
    };
  }

  function snapshotCandidates(context, triggerMode, clock) {
    const snapshot = performanceService.getProjectionSnapshot({
      userId: context.userId,
      campaignId: context.campaignId
    });
    const candidates = (Array.isArray(snapshot.items) ? snapshot.items : []).filter((content) => {
      if (!content || content.platform !== PROVIDER || content.tracking_status === 'paused') return false;
      if (typeof content.platform_content_id !== 'string' || !VIDEO_ID_PATTERN.test(content.platform_content_id)) return false;
      if (triggerMode === 'manual') return true;
      const freshness = assessContentFreshness(content, clock);
      return ELIGIBLE_SCHEDULE_STATES.has(freshness.state);
    });
    return candidates.sort((left, right) => {
      const leftObserved = Date.parse(left.latest_observation && left.latest_observation.observed_at || '') || 0;
      const rightObserved = Date.parse(right.latest_observation && right.latest_observation.observed_at || '') || 0;
      return leftObserved - rightObserved || Number(left.id) - Number(right.id);
    }).slice(0, MAX_ITEMS_PER_RUN);
  }

  function readRun(context, key) {
    const row = db.prepare(`
      SELECT * FROM performance_provider_collection_runs
      WHERE org_id=? AND campaign_id=? AND provider=? AND run_key=?
    `).get(context.orgId, context.campaignId, PROVIDER, key);
    if (!row) return null;
    const observations = db.prepare(`
      SELECT id,run_id,publication_id,provider,provider_content_id,metrics_json,
        availability_json,observed_at,payload_sha256,created_at
      FROM performance_provider_observations
      WHERE run_id=? AND org_id=? AND campaign_id=?
      ORDER BY publication_id,id
    `).all(row.id, context.orgId, context.campaignId).map((observation) => ({
      id: Number(observation.id),
      run_id: Number(observation.run_id),
      publication_id: Number(observation.publication_id),
      provider: observation.provider,
      provider_content_id: observation.provider_content_id,
      metrics: safeJson(observation.metrics_json, {}),
      availability: safeJson(observation.availability_json, {}),
      observed_at: iso(observation.observed_at),
      payload_sha256: observation.payload_sha256,
      created_at: observation.created_at
    }));
    return {
      contract_version: CONTRACT_VERSION,
      replayed: true,
      run: {
        id: Number(row.id),
        provider: row.provider,
        trigger_mode: row.trigger_mode,
        status: row.status,
        counts: safeJson(row.counts_json, { total: 0, succeeded: 0, failed: 0 }),
        safe_error_category: row.safe_error_category,
        scheduled_for: iso(row.scheduled_for),
        started_at: iso(row.started_at),
        completed_at: iso(row.completed_at)
      },
      observations
    };
  }

  async function collectCandidate(content) {
    let raw = null;
    try {
      raw = await providerClient.fetchStatistics({ videoId: content.platform_content_id });
      const result = canonicalProviderResult(raw, content);
      return {
        publication_id: Number(content.id),
        provider_content_id: content.platform_content_id,
        status: 'succeeded',
        attempts: result.attempts,
        safe_error_category: null,
        result
      };
    } catch (error) {
      const reportedAttempts = error && error.details && Number.isSafeInteger(error.details.attempts) && error.details.attempts > 0
        ? error.details.attempts
        : (raw && Number.isSafeInteger(raw.attempts) && raw.attempts > 0 ? raw.attempts : 1);
      return {
        publication_id: Number(content.id),
        provider_content_id: content.platform_content_id,
        status: 'failed',
        attempts: Math.min(MAX_PROVIDER_ATTEMPTS_PER_ITEM, reportedAttempts),
        safe_error_category: safeFailureCategory(error),
        result: null
      };
    }
  }

  async function collectWithConcurrency(candidates) {
    const results = new Array(candidates.length);
    let nextIndex = 0;
    async function worker() {
      while (nextIndex < candidates.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await collectCandidate(candidates[index]);
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, () => worker()));
    return results;
  }

  function acquireClaim(context, triggerMode, key, clock, requestedItems) {
    return db.transaction(() => {
      const existing = readRun(context, key);
      if (existing) return { state: 'replay', result: existing };
      db.prepare(`
        DELETE FROM performance_provider_collection_claims
        WHERE julianday(lease_until)<=julianday(?)
      `).run(clock);
      const activeCampaign = db.prepare(`
        SELECT run_key,lease_until
        FROM performance_provider_collection_claims
        WHERE org_id=? AND campaign_id=? AND provider=?
        LIMIT 1
      `).get(context.orgId, context.campaignId, PROVIDER);
      if (activeCampaign) {
        throw serviceError(
          409,
          'PERFORMANCE_PROVIDER_COLLECTION_IN_PROGRESS',
          'YouTube data collection is already running for this campaign.',
          { retry_after_seconds: secondsUntil(activeCampaign.lease_until, clock) }
        );
      }
      const active = db.prepare(`
        SELECT
          SUM(CASE WHEN requested_by=? THEN 1 ELSE 0 END) AS user_active,
          COUNT(*) AS organization_active
        FROM performance_provider_collection_claims
        WHERE org_id=? AND provider=? AND julianday(lease_until)>julianday(?)
      `).get(context.userId, context.orgId, PROVIDER, clock);
      if (Number(active.user_active || 0) >= USER_ACTIVE_RUNS ||
        Number(active.organization_active || 0) >= ORGANIZATION_ACTIVE_RUNS) {
        throw serviceError(
          429,
          'PERFORMANCE_PROVIDER_RATE_LIMITED',
          'YouTube data collection concurrency is temporarily limited.',
          { retry_after_seconds: 60 }
        );
      }
      const priorReservation = db.prepare(`
        SELECT id
        FROM performance_provider_quota_reservations
        WHERE provider=? AND run_key=?
        LIMIT 1
      `).get(PROVIDER, key);
      if (priorReservation) {
        throw serviceError(
          409,
          'PERFORMANCE_PROVIDER_REQUEST_INDETERMINATE',
          'A previous YouTube request with this idempotency key has no durable result. Use a new request key.'
        );
      }
      const latest = db.prepare(`
        SELECT occurred_at
        FROM (
          SELECT completed_at AS occurred_at,id
          FROM performance_provider_collection_runs
          WHERE org_id=? AND campaign_id=? AND provider=?
          UNION ALL
          SELECT created_at AS occurred_at,id
          FROM performance_provider_quota_reservations
          WHERE org_id=? AND campaign_id=? AND provider=?
        )
        ORDER BY julianday(occurred_at) DESC,id DESC LIMIT 1
      `).get(
        context.orgId,
        context.campaignId,
        PROVIDER,
        context.orgId,
        context.campaignId,
        PROVIDER
      );
      if (triggerMode === 'manual' && latest) {
        const elapsed = Date.parse(clock) - Date.parse(latest.occurred_at);
        if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < MANUAL_REFRESH_COOLDOWN_MS) {
          const retryAt = new Date(Date.parse(latest.occurred_at) + MANUAL_REFRESH_COOLDOWN_MS).toISOString();
          throw serviceError(
            429,
            'PERFORMANCE_PROVIDER_REFRESH_COOLDOWN',
            'YouTube data was refreshed recently. Please wait before refreshing again.',
            { retry_after_seconds: secondsUntil(retryAt, clock) }
          );
        }
      }
      const reservationUsage = db.prepare(`
        SELECT
          COALESCE(SUM(CASE
            WHEN requested_by=? AND trigger_mode='manual'
              AND julianday(created_at)>=julianday(?,'-1 hour')
            THEN 1 ELSE 0 END),0) AS user_manual_runs,
          COALESCE(SUM(CASE
            WHEN julianday(created_at)>=julianday(?,'-1 hour')
            THEN 1 ELSE 0 END),0) AS organization_runs,
          COALESCE(SUM(requested_items),0) AS organization_items
        FROM performance_provider_quota_reservations
        WHERE org_id=? AND provider=?
          AND julianday(created_at)>=julianday(?,'-1 day')
      `).get(context.userId, clock, clock, context.orgId, PROVIDER, clock);
      if (
        (triggerMode === 'manual' &&
          Number(reservationUsage.user_manual_runs || 0) + 1 > USER_MANUAL_RUNS_PER_HOUR) ||
        Number(reservationUsage.organization_runs || 0) + 1 > ORGANIZATION_RUNS_PER_HOUR ||
        Number(reservationUsage.organization_items || 0) + requestedItems > ORGANIZATION_ITEMS_PER_DAY
      ) {
        throw serviceError(
          429,
          'PERFORMANCE_PROVIDER_RATE_LIMITED',
          'YouTube data collection capacity was reached.',
          { retry_after_seconds: 3600 }
        );
      }
      const reservedQuotaUnits = requestedItems * MAX_PROVIDER_ATTEMPTS_PER_ITEM;
      const sharedQuota = db.prepare(`
        SELECT COALESCE(SUM(reserved_quota_units),0) AS reserved_units
        FROM performance_provider_quota_reservations
        WHERE provider=? AND julianday(created_at)>=julianday(?,'-1 day')
      `).get(PROVIDER, clock);
      if (Number(sharedQuota.reserved_units || 0) + reservedQuotaUnits > globalProviderQuotaUnitsPerDay) {
        throw serviceError(
          429,
          'PERFORMANCE_PROVIDER_RATE_LIMITED',
          'Shared YouTube data collection capacity was reached.',
          { retry_after_seconds: 3600 }
        );
      }
      const leaseToken = crypto.randomBytes(32).toString('hex');
      const leaseUntil = iso(new Date(Date.parse(clock) + CLAIM_LEASE_MS));
      const reservationId = Number(db.prepare(`
        INSERT INTO performance_provider_quota_reservations (
          org_id,campaign_id,provider,run_key,trigger_mode,requested_by,
          requested_items,reserved_quota_units,created_at
        ) VALUES (?,?,?,?,?,?,?,?,?)
      `).run(
        context.orgId,
        context.campaignId,
        PROVIDER,
        key,
        triggerMode,
        context.userId,
        requestedItems,
        reservedQuotaUnits,
        clock
      ).lastInsertRowid);
      const claimId = Number(db.prepare(`
        INSERT INTO performance_provider_collection_claims (
          org_id,campaign_id,provider,run_key,trigger_mode,requested_by,
          requested_items,reserved_quota_units,lease_token,lease_until
        ) VALUES (?,?,?,?,?,?,?,?,?,?)
      `).run(
        context.orgId,
        context.campaignId,
        PROVIDER,
        key,
        triggerMode,
        context.userId,
        requestedItems,
        reservedQuotaUnits,
        leaseToken,
        leaseUntil
      ).lastInsertRowid);
      return {
        state: 'acquired',
        id: claimId,
        reservationId,
        runKey: key,
        leaseToken,
        leaseUntil,
        startedAt: clock
      };
    }).immediate();
  }

  function releaseClaim(claim) {
    if (!claim || claim.state !== 'acquired') return;
    db.transaction(() => {
      db.prepare(`
        DELETE FROM performance_provider_collection_claims
        WHERE id=? AND run_key=? AND lease_token=?
      `).run(claim.id, claim.runKey, claim.leaseToken);
    }).immediate();
  }

  async function executeRun(context, triggerMode, key, scheduledFor, candidates, claim) {
    const startedAt = claim.startedAt;
    const itemResults = await collectWithConcurrency(candidates);
    const succeededItems = itemResults.filter((item) => item.status === 'succeeded');
    const failed = itemResults.length - succeededItems.length;
    const counts = { total: itemResults.length, succeeded: succeededItems.length, failed };
    const status = failed === 0 ? 'succeeded' : (succeededItems.length ? 'partial' : 'failed');
    const safeErrorCategory = failed === 0 ? null : (
      succeededItems.length ? 'item_failure' : itemResults[0].safe_error_category
    );
    const completedAt = iso(now());

    const stored = db.transaction(() => {
      const ownedClaim = db.prepare(`
        SELECT id FROM performance_provider_collection_claims
        WHERE id=? AND org_id=? AND campaign_id=? AND provider=? AND run_key=?
          AND requested_by=? AND lease_token=? AND julianday(lease_until)>julianday(?)
      `).get(
        claim.id,
        context.orgId,
        context.campaignId,
        PROVIDER,
        key,
        context.userId,
        claim.leaseToken,
        completedAt
      );
      if (!ownedClaim) {
        throw serviceError(409, 'PERFORMANCE_PROVIDER_COLLECTION_LEASE_LOST', 'YouTube data collection lease expired before completion.');
      }
      const runId = Number(db.prepare(`
        INSERT INTO performance_provider_collection_runs (
          org_id,campaign_id,provider,run_key,trigger_mode,requested_by,status,
          counts_json,item_results_json,safe_error_category,scheduled_for,started_at,completed_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        context.orgId,
        context.campaignId,
        PROVIDER,
        key,
        triggerMode,
        context.userId,
        status,
        JSON.stringify(counts),
        JSON.stringify(itemResults.map((item) => ({
          publication_id: item.publication_id,
          provider_content_id: item.provider_content_id,
          status: item.status,
          attempts: item.attempts,
          safe_error_category: item.safe_error_category,
          observed_at: item.result ? item.result.observed_at : null
        }))),
        safeErrorCategory,
        scheduledFor,
        startedAt,
        completedAt
      ).lastInsertRowid);
      const insertObservation = db.prepare(`
        INSERT INTO performance_provider_observations (
          run_id,org_id,campaign_id,publication_id,provider,provider_content_id,
          metrics_json,availability_json,observed_at,payload_sha256,created_by
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `);
      for (const item of succeededItems) {
        const payload = JSON.stringify({
          provider: PROVIDER,
          provider_content_id: item.provider_content_id,
          metrics: item.result.metrics,
          availability: item.result.availability,
          observed_at: item.result.observed_at
        });
        insertObservation.run(
          runId,
          context.orgId,
          context.campaignId,
          item.publication_id,
          PROVIDER,
          item.provider_content_id,
          JSON.stringify(item.result.metrics),
          JSON.stringify(item.result.availability),
          item.result.observed_at,
          sha256(payload),
          context.userId
        );
      }
      db.prepare(`
        INSERT INTO activity_log (user_id,action,module,details)
        VALUES (?,'performance_provider_collection','performance',?)
      `).run(context.userId, JSON.stringify({
        campaign_id: context.campaignId,
        provider: PROVIDER,
        provider_run_id: runId,
        trigger_mode: triggerMode,
        status,
        counts,
        safe_error_category: safeErrorCategory
      }));
      const released = db.prepare(`
        DELETE FROM performance_provider_collection_claims
        WHERE id=? AND run_key=? AND lease_token=?
      `).run(claim.id, key, claim.leaseToken);
      if (released.changes !== 1) {
        throw serviceError(409, 'PERFORMANCE_PROVIDER_COLLECTION_LEASE_LOST', 'YouTube data collection lease could not be released safely.');
      }
      const result = readRun(context, key);
      result.replayed = false;
      return result;
    }).immediate();
    return stored;
  }

  async function runCampaign(input = {}) {
    const context = accessContext(input.userId, input.campaignId, 'dispatch');
    const triggerMode = input.triggerMode === 'scheduled' ? 'scheduled' : 'manual';
    const idempotencyKey = input.idempotencyKey;
    if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
      throw serviceError(400, 'PERFORMANCE_PROVIDER_IDEMPOTENCY_KEY_INVALID', 'A valid Idempotency-Key is required.');
    }
    const key = runKey(triggerMode, context.campaignId, idempotencyKey);
    const existing = readRun(context, key);
    if (existing) return existing;
    const providerStatus = providerClient.getStatus();
    if (!providerStatus || providerStatus.configured !== true) {
      throw serviceError(503, 'PERFORMANCE_PROVIDER_NOT_CONFIGURED', 'YouTube data collection is not configured.');
    }
    if (inFlight.has(key)) {
      const result = await inFlight.get(key);
      return Object.assign({}, result, { replayed: true });
    }
    const clock = iso(now());
    const candidates = snapshotCandidates(context, triggerMode, clock);
    if (candidates.length === 0) {
      throw serviceError(409, 'PERFORMANCE_PROVIDER_CONTENT_UNAVAILABLE', 'No eligible YouTube content is available for collection.');
    }
    const scheduledFor = triggerMode === 'scheduled'
      ? iso(input.scheduledFor || clock)
      : clock;
    const claim = acquireClaim(context, triggerMode, key, clock, candidates.length);
    if (claim.state === 'replay') return claim.result;
    const pending = executeRun(context, triggerMode, key, scheduledFor, candidates, claim)
      .catch((error) => {
        try { releaseClaim(claim); } catch (_releaseError) {}
        throw error;
      });
    inFlight.set(key, pending);
    try {
      return await pending;
    } finally {
      if (inFlight.get(key) === pending) inFlight.delete(key);
    }
  }

  function scheduledCampaigns() {
    return db.prepare(`
      SELECT DISTINCT publication.org_id,publication.campaign_id
      FROM campaign_publications publication
      JOIN campaigns campaign
        ON campaign.org_id=publication.org_id AND campaign.id=publication.campaign_id
      WHERE publication.platform='youtube' AND campaign.operational_status='active'
      ORDER BY publication.org_id,publication.campaign_id
    `).all();
  }

  function scheduledActor(orgId, campaignId) {
    const admin = db.prepare(`
      SELECT membership.user_id
      FROM organization_memberships membership
      JOIN users user ON user.id=membership.user_id
      WHERE membership.org_id=? AND membership.role_code='org_admin'
        AND membership.status='active' AND user.is_active=1
      ORDER BY membership.user_id LIMIT 1
    `).get(orgId);
    if (admin) return Number(admin.user_id);
    const owner = db.prepare(`
      SELECT campaign.owner_user_id AS user_id
      FROM campaigns campaign
      JOIN organization_memberships membership
        ON membership.org_id=campaign.org_id AND membership.user_id=campaign.owner_user_id
      JOIN users user ON user.id=campaign.owner_user_id
      WHERE campaign.org_id=? AND campaign.id=?
        AND membership.status='active' AND user.is_active=1
    `).get(orgId, campaignId);
    return owner ? Number(owner.user_id) : null;
  }

  async function runScheduledDueCampaigns() {
    const providerStatus = providerClient.getStatus();
    if (!providerStatus || providerStatus.configured !== true) {
      return {
        provider: PROVIDER,
        status: 'not_configured',
        campaigns_considered: 0,
        runs_started: 0,
        runs_replayed: 0,
        campaigns_skipped: 0,
        campaigns_failed: 0
      };
    }
    const clock = new Date(now());
    const bucket = Math.floor(clock.getTime() / SCHEDULE_BUCKET_MS) * SCHEDULE_BUCKET_MS;
    const scheduledFor = new Date(bucket).toISOString();
    const campaigns = scheduledCampaigns();
    const summary = {
      provider: PROVIDER,
      status: 'completed',
      campaigns_considered: campaigns.length,
      runs_started: 0,
      runs_replayed: 0,
      campaigns_skipped: 0,
      campaigns_failed: 0
    };
    const unexpectedFailures = [];
    for (const campaign of campaigns) {
      const actor = scheduledActor(Number(campaign.org_id), Number(campaign.campaign_id));
      if (actor === null) {
        summary.campaigns_skipped += 1;
        continue;
      }
      try {
        const result = await runCampaign({
          userId: actor,
          campaignId: Number(campaign.campaign_id),
          triggerMode: 'scheduled',
          idempotencyKey: `scheduled:${scheduledFor}`,
          scheduledFor
        });
        if (result.replayed) summary.runs_replayed += 1;
        else summary.runs_started += 1;
      } catch (error) {
        if (error instanceof PerformanceProviderCollectionServiceError && [
          'PERFORMANCE_PROVIDER_CONTENT_UNAVAILABLE',
          'PERFORMANCE_PROVIDER_COLLECTION_IN_PROGRESS',
          'PERFORMANCE_PROVIDER_REFRESH_COOLDOWN',
          'PERFORMANCE_PROVIDER_RATE_LIMITED'
        ].includes(error.code)) {
          summary.campaigns_skipped += 1;
          continue;
        }
        summary.campaigns_failed += 1;
        unexpectedFailures.push(safeFailureCategory(error));
      }
    }
    if (unexpectedFailures.length > 0) {
      throw serviceError(
        503,
        'PERFORMANCE_PROVIDER_SCHEDULER_FAILED',
        'One or more scheduled YouTube collection campaigns failed.',
        {
          campaigns_failed: summary.campaigns_failed,
          safe_error_categories: [...new Set(unexpectedFailures)].sort()
        }
      );
    }
    return summary;
  }

  return Object.freeze({
    getCampaignStatus,
    runCampaign,
    runScheduledDueCampaigns
  });
}

function startPerformanceProviderScheduler(service, options = {}) {
  if (!service || typeof service.runScheduledDueCampaigns !== 'function') {
    throw new TypeError('A performance provider collection service is required.');
  }
  const intervalMs = Number.isSafeInteger(options.intervalMs) && options.intervalMs >= 60000
    ? options.intervalMs
    : DEFAULT_SCHEDULER_INTERVAL_MS;
  const initialDelayMs = Number.isSafeInteger(options.initialDelayMs) && options.initialDelayMs >= 0
    ? options.initialDelayMs
    : 15000;
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  let stopped = false;
  let running = false;
  async function tick() {
    if (stopped || running) return;
    running = true;
    try { await service.runScheduledDueCampaigns(); }
    catch (error) { onError(error); }
    finally { running = false; }
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
  PerformanceProviderCollectionServiceError,
  createPerformanceProviderCollectionService,
  startPerformanceProviderScheduler
};

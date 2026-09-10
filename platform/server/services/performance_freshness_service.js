'use strict';

const FRESHNESS_CONTRACT_VERSION = 'performance-freshness-queue-v1';
const FRESHNESS_POLICY_VERSION = 'phase7b-default-cadence-v1';
const HOUR_MS = 60 * 60 * 1000;
const MONITORING_HOURS = 180 * 24;
const SLA_MULTIPLIER = 2;
const QUEUE_LIMIT = 100;
const ACTIONABLE_STATES = Object.freeze(new Set([
  'stale',
  'unobserved',
  'date_required',
  'data_issue',
  'due'
]));
const STATE_PRIORITY = Object.freeze({
  stale: 0,
  unobserved: 1,
  date_required: 2,
  data_issue: 3,
  due: 4
});

function timestampMs(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  let text = value.trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) text += 'T00:00:00.000Z';
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)) {
    text = text.replace(' ', 'T') + 'Z';
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function cadenceHours(ageHours) {
  if (ageHours <= 72) return 6;
  if (ageHours <= 14 * 24) return 12;
  if (ageHours <= 45 * 24) return 24;
  return 168;
}

function baseResult(content, state, reasonCode, values = {}) {
  return {
    publication_id: Number(content && content.id),
    original_url: content && content.original_url || null,
    platform: content && content.platform || null,
    creator_id: content && content.creator_id || null,
    creator_name: content && content.creator_name || null,
    product: content && content.product || null,
    published_at: values.publishedAt || null,
    state,
    reason_code: reasonCode,
    cadence_hours: values.cadenceHours === undefined ? null : values.cadenceHours,
    last_observed_at: values.lastObservedAt || null,
    next_due_at: values.nextDueAt || null,
    stale_at: values.staleAt || null,
    overdue_hours: values.overdueHours === undefined ? null : values.overdueHours
  };
}

function assessContentFreshness(content, nowValue) {
  const nowMs = timestampMs(nowValue);
  if (nowMs === null) throw new TypeError('A valid freshness clock is required.');
  const publishedMs = timestampMs(content && content.published_at);
  if (publishedMs === null) {
    return baseResult(content, 'date_required', content && content.published_at
      ? 'published_at_invalid'
      : 'published_at_required');
  }
  const publishedAt = iso(publishedMs);
  if (publishedMs > nowMs) {
    return baseResult(content, 'not_started', 'publication_not_started', {
      publishedAt,
      nextDueAt: publishedAt,
      overdueHours: 0
    });
  }

  const ageHours = (nowMs - publishedMs) / HOUR_MS;
  const monitoringStopMs = publishedMs + (MONITORING_HOURS * HOUR_MS);
  if (nowMs >= monitoringStopMs) {
    return baseResult(content, 'monitoring_complete', 'default_monitoring_window_complete', {
      publishedAt
    });
  }

  const cadence = cadenceHours(ageHours);
  const observationValue = content && content.latest_observation && content.latest_observation.observed_at;
  const observedMs = timestampMs(observationValue);
  if (!observationValue) {
    return baseResult(content, 'unobserved', 'first_observation_required', {
      publishedAt,
      cadenceHours: cadence,
      nextDueAt: publishedAt,
      overdueHours: Math.max(0, Math.round(ageHours * 100) / 100)
    });
  }
  if (observedMs === null || observedMs > nowMs || observedMs < publishedMs) {
    return baseResult(content, 'data_issue', observedMs === null
      ? 'observed_at_invalid'
      : (observedMs > nowMs ? 'observed_at_in_future' : 'observation_precedes_publication'), {
      publishedAt,
      lastObservedAt: observedMs === null ? null : iso(observedMs),
      cadenceHours: cadence
    });
  }

  const nextDueMs = observedMs + (cadence * HOUR_MS);
  const staleMs = observedMs + (cadence * SLA_MULTIPLIER * HOUR_MS);
  const common = {
    publishedAt,
    cadenceHours: cadence,
    lastObservedAt: iso(observedMs),
    nextDueAt: iso(nextDueMs),
    staleAt: iso(staleMs),
    overdueHours: Math.max(0, Math.round(((nowMs - nextDueMs) / HOUR_MS) * 100) / 100)
  };
  if (nowMs >= staleMs) return baseResult(content, 'stale', 'freshness_sla_missed', common);
  if (nowMs >= nextDueMs) return baseResult(content, 'due', 'scheduled_update_due', common);
  return baseResult(content, 'current', 'within_update_cadence', common);
}

function queueSort(left, right) {
  const priorityDelta = STATE_PRIORITY[left.state] - STATE_PRIORITY[right.state];
  if (priorityDelta) return priorityDelta;
  const leftDue = timestampMs(left.next_due_at);
  const rightDue = timestampMs(right.next_due_at);
  if (leftDue !== null && rightDue !== null && leftDue !== rightDue) return leftDue - rightDue;
  if (leftDue !== null && rightDue === null) return -1;
  if (leftDue === null && rightDue !== null) return 1;
  return left.publication_id - right.publication_id;
}

function createPerformanceFreshnessService(options = {}) {
  const performanceService = options.performanceService;
  if (!performanceService || typeof performanceService.getProjectionSnapshot !== 'function') {
    throw new TypeError('A performance projection service is required.');
  }
  const now = typeof options.now === 'function' ? options.now : () => new Date();

  function getQueue(input = {}) {
    const nowMs = timestampMs(now());
    if (nowMs === null) throw new TypeError('The freshness clock returned an invalid timestamp.');
    const snapshot = performanceService.getProjectionSnapshot({
      userId: input.userId,
      campaignId: input.campaignId
    });
    const allContents = Array.isArray(snapshot.items) ? snapshot.items.filter(Boolean) : [];
    const contents = allContents.filter((content) => content.tracking_status !== 'paused');
    const assessed = contents.map((content) => assessContentFreshness(content, nowMs));
    const contentsById = new Map(contents.map((content) => [Number(content.id), content]));
    const stateNames = [
      'current', 'due', 'stale', 'unobserved', 'date_required', 'data_issue',
      'not_started', 'monitoring_complete'
    ];
    const counts = Object.fromEntries(stateNames.map((state) => [state, 0]));
    assessed.forEach((item) => { counts[item.state] += 1; });
    const actionable = assessed.filter((item) => ACTIONABLE_STATES.has(item.state)).sort(queueSort);
    const canRequestManualUpdate = Boolean(
      snapshot.capabilities && snapshot.capabilities.can_manage_content
    );
    const observed = assessed.filter((item) => (
      item.state === 'current' || item.state === 'due' || item.state === 'stale'
    )).length;
    const nextDueTimes = assessed.map((item) => timestampMs(item.next_due_at)).filter((value) => value !== null);
    const successTimes = assessed.map((item) => timestampMs(item.last_observed_at)).filter((value) => value !== null && value <= nowMs);
    const summary = {
      total: allContents.length,
      monitored_total: contents.length,
      paused: allContents.length - contents.length,
      current: counts.current,
      due: counts.due,
      stale: counts.stale,
      unobserved: counts.unobserved,
      date_required: counts.date_required,
      data_issue: counts.data_issue,
      not_started: counts.not_started,
      monitoring_complete: counts.monitoring_complete,
      actionable: actionable.length,
      observed,
      observation_coverage: contents.length === 0 ? 0 : observed / contents.length,
      within_sla: counts.current + counts.due,
      outside_sla: counts.stale + counts.unobserved + counts.date_required + counts.data_issue
    };
    return {
      contract_version: FRESHNESS_CONTRACT_VERSION,
      campaign_id: Number(input.campaignId),
      generated_at: iso(nowMs),
      source_consistency: snapshot.consistency || null,
      policy: {
        version: FRESHNESS_POLICY_VERSION,
        sla_multiplier: SLA_MULTIPLIER,
        monitoring_days: 180,
        campaign_close_evidence: 'not_available',
        cadence_tiers: [
          { maximum_publication_age_hours: 72, cadence_hours: 6 },
          { maximum_publication_age_hours: 336, cadence_hours: 12 },
          { maximum_publication_age_hours: 1080, cadence_hours: 24 },
          { maximum_publication_age_hours: 4320, cadence_hours: 168 }
        ]
      },
      provider: {
        status: 'not_configured',
        dispatch_available: false,
        last_success_at: null,
        next_due_at: null
      },
      schedule: {
        latest_observation_at: successTimes.length ? iso(Math.max(...successTimes)) : null,
        next_due_at: nextDueTimes.length ? iso(Math.min(...nextDueTimes)) : null
      },
      summary,
      queue: {
        total: actionable.length,
        limit: QUEUE_LIMIT,
        truncated: actionable.length > QUEUE_LIMIT
      },
      items: actionable.slice(0, QUEUE_LIMIT).map((item) => Object.assign({}, item, {
        manual_update_available: canRequestManualUpdate,
        content: contentsById.get(item.publication_id) || null
      })),
      capabilities: Object.assign({}, snapshot.capabilities || {}, {
        can_request_manual_update: canRequestManualUpdate
      })
    };
  }

  return Object.freeze({ getQueue });
}

module.exports = {
  FRESHNESS_CONTRACT_VERSION,
  FRESHNESS_POLICY_VERSION,
  assessContentFreshness,
  createPerformanceFreshnessService
};

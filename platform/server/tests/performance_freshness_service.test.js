'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FRESHNESS_CONTRACT_VERSION,
  FRESHNESS_POLICY_VERSION,
  assessContentFreshness,
  createPerformanceFreshnessService
} = require('../services/performance_freshness_service');

const NOW = '2026-09-10T12:00:00.000Z';

function isoHoursBefore(hours) {
  return new Date(Date.parse(NOW) - (hours * 60 * 60 * 1000)).toISOString();
}

test('applies the approved publication-age cadence and deterministic monitoring stop', () => {
  for (const [hoursOld, expectedCadence] of [
    [48, 6],
    [96, 12],
    [20 * 24, 24],
    [60 * 24, 168]
  ]) {
    const result = assessContentFreshness({
      id: hoursOld,
      published_at: isoHoursBefore(hoursOld),
      latest_observation: { observed_at: isoHoursBefore(1) }
    }, NOW);
    assert.equal(result.cadence_hours, expectedCadence);
  }

  const completed = assessContentFreshness({
    id: 999,
    published_at: isoHoursBefore(181 * 24),
    latest_observation: null
  }, NOW);
  assert.equal(completed.state, 'monitoring_complete');
  assert.equal(completed.cadence_hours, null);
  assert.equal(completed.next_due_at, null);
});

test('keeps cadence, due, stale and monitoring transitions exact at every boundary', () => {
  const ageBoundaries = [
    [72, 6, 12],
    [14 * 24, 12, 24],
    [45 * 24, 24, 168]
  ];
  for (const [boundaryHours, atBoundary, afterBoundary] of ageBoundaries) {
    const exact = assessContentFreshness({
      id: boundaryHours,
      published_at: new Date(Date.parse(NOW) - (boundaryHours * 60 * 60 * 1000)).toISOString(),
      latest_observation: { observed_at: isoHoursBefore(1) }
    }, NOW);
    const after = assessContentFreshness({
      id: boundaryHours + 1,
      published_at: new Date(Date.parse(NOW) - (boundaryHours * 60 * 60 * 1000) - 1).toISOString(),
      latest_observation: { observed_at: isoHoursBefore(1) }
    }, NOW);
    assert.equal(exact.cadence_hours, atBoundary);
    assert.equal(after.cadence_hours, afterBoundary);
  }

  const justBeforeStop = assessContentFreshness({
    id: 4000,
    published_at: new Date(Date.parse(NOW) - (180 * 24 * 60 * 60 * 1000) + 1).toISOString(),
    latest_observation: { observed_at: isoHoursBefore(1) }
  }, NOW);
  const atStop = assessContentFreshness({
    id: 4001,
    published_at: isoHoursBefore(180 * 24),
    latest_observation: { observed_at: isoHoursBefore(1) }
  }, NOW);
  assert.equal(justBeforeStop.cadence_hours, 168);
  assert.equal(atStop.state, 'monitoring_complete');

  const publishedAt = isoHoursBefore(48);
  const observedAt = isoHoursBefore(6);
  const dueBefore = assessContentFreshness({ id: 5001, published_at: publishedAt, latest_observation: { observed_at: observedAt } }, new Date(Date.parse(NOW) - 1));
  const dueExact = assessContentFreshness({ id: 5002, published_at: publishedAt, latest_observation: { observed_at: observedAt } }, NOW);
  const staleBefore = assessContentFreshness({ id: 5003, published_at: publishedAt, latest_observation: { observed_at: observedAt } }, new Date(Date.parse(NOW) + (6 * 60 * 60 * 1000) - 1));
  const staleExact = assessContentFreshness({ id: 5004, published_at: publishedAt, latest_observation: { observed_at: observedAt } }, new Date(Date.parse(NOW) + (6 * 60 * 60 * 1000)));
  assert.equal(dueBefore.state, 'current');
  assert.equal(dueExact.state, 'due');
  assert.equal(dueExact.next_due_at, NOW);
  assert.equal(dueExact.stale_at, new Date(Date.parse(NOW) + (6 * 60 * 60 * 1000)).toISOString());
  assert.equal(staleBefore.state, 'due');
  assert.equal(staleExact.state, 'stale');
});

test('distinguishes current, due, stale, unobserved, missing-date and future content without inventing observations', () => {
  const cases = [
    [{ id: 1, published_at: null, latest_observation: null }, 'date_required'],
    [{ id: 2, published_at: '2026-09-11T12:00:00.000Z', latest_observation: null }, 'not_started'],
    [{ id: 3, published_at: isoHoursBefore(48), latest_observation: null }, 'unobserved'],
    [{ id: 4, published_at: isoHoursBefore(48), latest_observation: { observed_at: isoHoursBefore(3) } }, 'current'],
    [{ id: 5, published_at: isoHoursBefore(48), latest_observation: { observed_at: isoHoursBefore(7) } }, 'due'],
    [{ id: 6, published_at: isoHoursBefore(48), latest_observation: { observed_at: isoHoursBefore(12) } }, 'stale']
  ];

  for (const [content, expectedState] of cases) {
    const result = assessContentFreshness(content, NOW);
    assert.equal(result.state, expectedState, `content ${content.id}`);
  }

  const missingObservation = assessContentFreshness(cases[2][0], NOW);
  assert.equal(missingObservation.last_observed_at, null);
  assert.equal(missingObservation.reason_code, 'first_observation_required');
});

test('builds one bounded, permission-aware queue from the full atomic snapshot', () => {
  const calls = [];
  const contents = Array.from({ length: 105 }, (_value, index) => ({
    id: index + 1,
    original_url: `https://example.test/video/${index + 1}`,
    platform: 'youtube',
    creator_name: `Creator ${index + 1}`,
    product: 'Product',
    published_at: isoHoursBefore(48),
    latest_observation: null
  }));
  const performanceService = {
    getProjectionSnapshot(input) {
      calls.push(input);
      return {
        consistency: 'sqlite_read_transaction',
        total: contents.length,
        items: contents,
        capabilities: { can_view: true, can_manage_content: false }
      };
    }
  };
  const service = createPerformanceFreshnessService({
    performanceService,
    now: () => new Date(NOW)
  });

  const result = service.getQueue({ userId: 9, campaignId: 7 });

  assert.deepEqual(calls, [{ userId: 9, campaignId: 7 }]);
  assert.equal(result.contract_version, FRESHNESS_CONTRACT_VERSION);
  assert.equal(result.policy.version, FRESHNESS_POLICY_VERSION);
  assert.equal(result.policy.sla_multiplier, 2);
  assert.equal(result.provider.status, 'not_configured');
  assert.equal(result.provider.dispatch_available, false);
  assert.equal(result.provider.last_success_at, null);
  assert.equal(result.provider.next_due_at, null);
  assert.equal(result.summary.total, 105);
  assert.equal(result.summary.unobserved, 105);
  assert.equal(result.summary.actionable, 105);
  assert.equal(result.items.length, 100);
  assert.equal(result.queue.total, 105);
  assert.equal(result.queue.truncated, true);
  assert.equal(result.capabilities.can_request_manual_update, false);
  assert.ok(result.items.every((item) => item.last_observed_at === null));
  assert.ok(result.items.every((item) => item.manual_update_available === false));
  assert.equal(result.items[0].content.id, result.items[0].publication_id);
  assert.equal(result.items[0].content.original_url, result.items[0].original_url);
});

test('keeps manual observation timing provider-neutral', () => {
  const service = createPerformanceFreshnessService({
    performanceService: {
      getProjectionSnapshot() {
        return {
          consistency: 'sqlite_read_transaction',
          total: 1,
          items: [{
            id: 1,
            published_at: isoHoursBefore(48),
            latest_observation: {
              observed_at: isoHoursBefore(3),
              source_mode: 'manual'
            }
          }],
          capabilities: { can_view: true, can_manage_content: true }
        };
      }
    },
    now: () => NOW
  });

  const result = service.getQueue({ userId: 1, campaignId: 7 });

  assert.equal(result.provider.status, 'not_configured');
  assert.equal(result.provider.last_success_at, null);
  assert.equal(result.provider.next_due_at, null);
  assert.equal(result.schedule.latest_observation_at, isoHoursBefore(3));
  assert.equal(result.schedule.next_due_at, new Date(Date.parse(NOW) + (3 * 60 * 60 * 1000)).toISOString());
});

test('keeps full-dataset summary counts separate from the actionable queue', () => {
  const items = [
    { id: 1, published_at: null, latest_observation: null },
    { id: 2, published_at: '2026-09-11T12:00:00.000Z', latest_observation: null },
    { id: 3, published_at: isoHoursBefore(181 * 24), latest_observation: null },
    { id: 4, published_at: isoHoursBefore(48), latest_observation: { observed_at: isoHoursBefore(3) } },
    { id: 5, published_at: isoHoursBefore(48), latest_observation: { observed_at: isoHoursBefore(7) } },
    { id: 6, published_at: isoHoursBefore(48), latest_observation: { observed_at: isoHoursBefore(12) } },
    { id: 7, published_at: isoHoursBefore(5 * 24), latest_observation: null }
  ];
  const service = createPerformanceFreshnessService({
    performanceService: {
      getProjectionSnapshot() {
        return {
          consistency: 'sqlite_read_transaction',
          total: items.length,
          items,
          capabilities: { can_view: true, can_manage_content: true }
        };
      }
    },
    now: () => NOW
  });

  const result = service.getQueue({ userId: 1, campaignId: 7 });

  assert.deepEqual(result.summary, {
    total: 7,
    monitored_total: 7,
    paused: 0,
    current: 1,
    due: 1,
    stale: 1,
    unobserved: 1,
    date_required: 1,
    data_issue: 0,
    not_started: 1,
    monitoring_complete: 1,
    actionable: 4,
    observed: 3,
    observation_coverage: 3 / 7,
    within_sla: 2,
    outside_sla: 3
  });
  assert.deepEqual(result.items.map((item) => item.state), [
    'stale', 'unobserved', 'date_required', 'due'
  ]);
  assert.ok(result.items.every((item) => item.manual_update_available === true));
});

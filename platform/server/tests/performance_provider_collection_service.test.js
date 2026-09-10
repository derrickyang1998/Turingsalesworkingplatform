'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const migration = require('../migrations/019_performance_provider_collection');
const {
  PerformanceProviderCollectionServiceError,
  createPerformanceProviderCollectionService
} = require('../services/performance_provider_collection_service');

function createFixture(options = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      is_active INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE organizations (
      id INTEGER PRIMARY KEY
    ) STRICT;
    CREATE TABLE organization_memberships (
      org_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role_code TEXT NOT NULL,
      status TEXT NOT NULL,
      PRIMARY KEY(org_id,user_id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    ) STRICT;
    CREATE TABLE campaigns (
      id INTEGER PRIMARY KEY,
      org_id INTEGER NOT NULL,
      owner_user_id INTEGER NOT NULL,
      operational_status TEXT NOT NULL,
      UNIQUE(org_id,id)
    ) STRICT;
    CREATE TABLE campaign_publications (
      id INTEGER PRIMARY KEY,
      org_id INTEGER NOT NULL,
      campaign_id INTEGER NOT NULL,
      platform TEXT NOT NULL,
      platform_content_id TEXT,
      FOREIGN KEY(org_id,campaign_id) REFERENCES campaigns(org_id,id)
    ) STRICT;
    CREATE TABLE activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      module TEXT NOT NULL,
      details TEXT,
      ip_address TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    ) STRICT;
  `);
  db.prepare('INSERT INTO users (id,is_active) VALUES (1,1),(2,1)').run();
  db.prepare('INSERT INTO organizations (id) VALUES (1)').run();
  db.prepare(`
    INSERT INTO organization_memberships (org_id,user_id,role_code,status)
    VALUES (1,1,'org_admin','active'),(1,2,'member','active')
  `).run();
  db.prepare("INSERT INTO campaigns (id,org_id,owner_user_id,operational_status) VALUES (7,1,1,'active')").run();
  db.prepare(`
    INSERT INTO campaign_publications (id,org_id,campaign_id,platform,platform_content_id)
    VALUES (10,1,7,'youtube','abcDEF_1234'),(11,1,7,'tiktok','777')
  `).run();
  migration.apply(db);

  const contents = options.contents || [
    {
      id: 10,
      platform: 'youtube',
      platform_content_id: 'abcDEF_1234',
      original_url: 'https://www.youtube.com/watch?v=abcDEF_1234',
      published_at: '2026-09-10T00:00:00.000Z',
      tracking_status: 'active',
      latest_observation: null
    },
    {
      id: 11,
      platform: 'tiktok',
      platform_content_id: '777',
      original_url: 'https://www.tiktok.com/@creator/video/777',
      published_at: '2026-09-10T00:00:00.000Z',
      tracking_status: 'active',
      latest_observation: null
    }
  ];
  let providerCalls = 0;
  const providerClient = options.providerClient || {
    getStatus() { return { provider: 'youtube', configured: true, status: 'ready' }; },
    async fetchStatistics({ videoId }) {
      providerCalls += 1;
      return {
        provider: 'youtube',
        provider_content_id: videoId,
        observed_at: '2026-09-11T03:00:00.000Z',
        metrics: { views: 12000, likes: 340, comments: 18 },
        availability: {
          views: { available: true },
          likes: { available: true },
          comments: { available: true },
          saves: { available: false, reason_code: 'provider_metric_unavailable' },
          shares: { available: false, reason_code: 'provider_metric_unavailable' }
        },
        attempts: 1
      };
    }
  };
  const performanceService = {
    getProjectionSnapshot() {
      return {
        consistency: 'test',
        items: contents,
        total: contents.length,
        capabilities: { can_manage_content: true }
      };
    }
  };
  const getCampaignAccess = options.getCampaignAccess || ((_database, input) => ({
    ok: true,
    role: input.userId === 1 ? 'org_admin' : 'team_member',
    campaign: { id: 7, org_id: 1, operational_status: 'active' },
    permissions: { read: true, write: true }
  }));
  const createService = (overrides = {}) => createPerformanceProviderCollectionService(db, {
    providerClient,
    performanceService,
    getCampaignAccess,
    now: () => new Date('2026-09-11T03:05:00.000Z'),
    ...overrides
  });
  const service = createService();
  return { db, service, createService, getProviderCalls: () => providerCalls };
}

test('collects YouTube metrics into an immutable provider ledger and replays the same request', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.db.close());

  const first = await fixture.service.runCampaign({
    userId: 1,
    campaignId: 7,
    triggerMode: 'manual',
    idempotencyKey: 'provider-refresh-00000001'
  });
  const replay = await fixture.service.runCampaign({
    userId: 1,
    campaignId: 7,
    triggerMode: 'manual',
    idempotencyKey: 'provider-refresh-00000001'
  });

  assert.equal(first.replayed, false);
  assert.equal(first.run.status, 'succeeded');
  assert.deepEqual(first.run.counts, { total: 1, succeeded: 1, failed: 0 });
  assert.equal(first.observations[0].provider, 'youtube');
  assert.deepEqual(first.observations[0].metrics, { views: 12000, likes: 340, comments: 18 });
  assert.equal(replay.replayed, true);
  assert.equal(replay.run.id, first.run.id);
  assert.equal(fixture.getProviderCalls(), 1);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM performance_provider_collection_runs').get().count, 1);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM performance_provider_observations').get().count, 1);
  assert.equal(
    fixture.db.prepare("SELECT COUNT(*) AS count FROM activity_log WHERE module='performance' AND action='performance_provider_collection'").get().count,
    1
  );
});

test('exposes fail-closed configuration and permission-aware dispatch status', async (t) => {
  const fixture = createFixture({
    providerClient: {
      getStatus() { return { provider: 'youtube', configured: false, status: 'not_configured' }; },
      async fetchStatistics() { throw new Error('network must not run'); }
    }
  });
  t.after(() => fixture.db.close());

  const status = fixture.service.getCampaignStatus({ userId: 1, campaignId: 7 });
  assert.equal(status.status, 'not_configured');
  assert.equal(status.dispatch_available, false);
  assert.equal(status.metric_availability.saves.available, false);
  await assert.rejects(
    () => fixture.service.runCampaign({
      userId: 1,
      campaignId: 7,
      triggerMode: 'manual',
      idempotencyKey: 'provider-refresh-00000002'
    }),
    (error) => error instanceof PerformanceProviderCollectionServiceError &&
      error.statusCode === 503 && error.code === 'PERFORMANCE_PROVIDER_NOT_CONFIGURED'
  );

  const memberStatus = fixture.service.getCampaignStatus({ userId: 2, campaignId: 7 });
  assert.equal(memberStatus.dispatch_available, false);
});

test('scheduled collection processes only due YouTube campaigns once per schedule bucket', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.db.close());

  const first = await fixture.service.runScheduledDueCampaigns();
  const replay = await fixture.service.runScheduledDueCampaigns();

  assert.equal(first.campaigns_considered, 1);
  assert.equal(first.runs_started, 1);
  assert.equal(replay.runs_started, 0);
  assert.equal(replay.runs_replayed, 1);
  assert.equal(fixture.getProviderCalls(), 1);
  const run = fixture.db.prepare('SELECT trigger_mode,requested_by FROM performance_provider_collection_runs').get();
  assert.deepEqual(run, { trigger_mode: 'scheduled', requested_by: 1 });
});

test('persists a campaign lease before provider I/O and blocks a second process', async (t) => {
  let releaseProvider;
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const release = new Promise((resolve) => { releaseProvider = resolve; });
  let calls = 0;
  const providerClient = {
    getStatus() { return { provider: 'youtube', configured: true, status: 'ready' }; },
    async fetchStatistics({ videoId }) {
      calls += 1;
      signalStarted();
      await release;
      return {
        provider: 'youtube',
        provider_content_id: videoId,
        observed_at: '2026-09-11T03:05:00.000Z',
        metrics: { views: 120, likes: 10, comments: 3 },
        availability: {
          views: { available: true },
          likes: { available: true },
          comments: { available: true },
          saves: { available: false, reason_code: 'provider_metric_unavailable' },
          shares: { available: false, reason_code: 'provider_metric_unavailable' }
        },
        attempts: 1
      };
    }
  };
  const fixture = createFixture({ providerClient });
  t.after(() => fixture.db.close());
  const competingService = fixture.createService();

  const first = fixture.service.runCampaign({
    userId: 1,
    campaignId: 7,
    triggerMode: 'manual',
    idempotencyKey: 'provider-refresh-process-a'
  });
  await started;
  await assert.rejects(
    () => competingService.runCampaign({
      userId: 1,
      campaignId: 7,
      triggerMode: 'manual',
      idempotencyKey: 'provider-refresh-process-b'
    }),
    (error) => error instanceof PerformanceProviderCollectionServiceError &&
      error.statusCode === 409 && error.code === 'PERFORMANCE_PROVIDER_COLLECTION_IN_PROGRESS'
  );
  assert.equal(calls, 1);
  releaseProvider();
  await first;
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM performance_provider_collection_claims').get().count, 0);
});

test('enforces a campaign cooldown before another manual provider refresh', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.db.close());
  await fixture.service.runCampaign({
    userId: 1,
    campaignId: 7,
    triggerMode: 'manual',
    idempotencyKey: 'provider-refresh-cooldown-a'
  });

  await assert.rejects(
    () => fixture.service.runCampaign({
      userId: 1,
      campaignId: 7,
      triggerMode: 'manual',
      idempotencyKey: 'provider-refresh-cooldown-b'
    }),
    (error) => error instanceof PerformanceProviderCollectionServiceError &&
      error.statusCode === 429 && error.code === 'PERFORMANCE_PROVIDER_REFRESH_COOLDOWN' &&
      error.details && error.details.retry_after_seconds > 0
  );
  assert.equal(fixture.getProviderCalls(), 1);
});

test('rejects a collection that would exceed the daily organization item budget', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.db.close());
  const reserve = fixture.db.prepare(`
    INSERT INTO performance_provider_quota_reservations (
      org_id,campaign_id,provider,run_key,trigger_mode,requested_by,
      requested_items,reserved_quota_units,created_at
    ) VALUES (1,7,'youtube',?,'scheduled',1,50,150,'2026-09-10T04:00:00.000Z')
  `);
  for (let index = 1; index <= 100; index += 1) {
    reserve.run(index.toString(16).padStart(64, '0'));
  }

  await assert.rejects(
    () => fixture.service.runCampaign({
      userId: 1,
      campaignId: 7,
      triggerMode: 'scheduled',
      idempotencyKey: 'provider-refresh-daily-cap',
      scheduledFor: '2026-09-11T03:00:00.000Z'
    }),
    (error) => error instanceof PerformanceProviderCollectionServiceError &&
      error.statusCode === 429 && error.code === 'PERFORMANCE_PROVIDER_RATE_LIMITED'
  );
  assert.equal(fixture.getProviderCalls(), 0);
});

test('reserves worst-case retries against the shared provider quota before network I/O', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.db.close());
  const limitedService = fixture.createService({ globalProviderQuotaUnitsPerDay: 2 });

  await assert.rejects(
    () => limitedService.runCampaign({
      userId: 1,
      campaignId: 7,
      triggerMode: 'scheduled',
      idempotencyKey: 'provider-refresh-shared-cap',
      scheduledFor: '2026-09-11T03:00:00.000Z'
    }),
    (error) => error instanceof PerformanceProviderCollectionServiceError &&
      error.statusCode === 429 && error.code === 'PERFORMANCE_PROVIDER_RATE_LIMITED'
  );
  assert.equal(fixture.getProviderCalls(), 0);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM performance_provider_collection_claims').get().count, 0);
});

test('keeps an immutable quota reservation when persistence fails after provider I/O', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.db.close());
  fixture.db.exec(`
    CREATE TRIGGER performance_provider_test_reject_run
    BEFORE INSERT ON performance_provider_collection_runs
    BEGIN SELECT RAISE(ABORT,'forced run persistence failure'); END;
  `);

  await assert.rejects(
    () => fixture.service.runCampaign({
      userId: 1,
      campaignId: 7,
      triggerMode: 'manual',
      idempotencyKey: 'provider-refresh-persist-failure'
    }),
    /forced run persistence failure/
  );
  assert.equal(fixture.getProviderCalls(), 1);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM performance_provider_collection_claims').get().count, 0);
  assert.equal(fixture.db.prepare('SELECT reserved_quota_units FROM performance_provider_quota_reservations').get().reserved_quota_units, 3);

  const limitedService = fixture.createService({ globalProviderQuotaUnitsPerDay: 3 });
  await assert.rejects(
    () => limitedService.runCampaign({
      userId: 1,
      campaignId: 7,
      triggerMode: 'scheduled',
      idempotencyKey: 'provider-refresh-after-persist-failure',
      scheduledFor: '2026-09-11T03:00:00.000Z'
    }),
    (error) => error instanceof PerformanceProviderCollectionServiceError &&
      error.statusCode === 429 && error.code === 'PERFORMANCE_PROVIDER_RATE_LIMITED'
  );
  assert.equal(fixture.getProviderCalls(), 1);
});

test('records provider-reported retries when canonical response validation fails', async (t) => {
  const fixture = createFixture({
    providerClient: {
      getStatus() { return { provider: 'youtube', configured: true, status: 'ready' }; },
      async fetchStatistics() {
        return {
          provider: 'youtube',
          provider_content_id: 'wrong-video-id',
          observed_at: '2026-09-11T03:05:00.000Z',
          metrics: { views: 120, likes: 10, comments: 3 },
          availability: {},
          attempts: 3
        };
      }
    }
  });
  t.after(() => fixture.db.close());

  const result = await fixture.service.runCampaign({
    userId: 1,
    campaignId: 7,
    triggerMode: 'manual',
    idempotencyKey: 'provider-refresh-invalid-response'
  });
  assert.equal(result.run.status, 'failed');
  const items = JSON.parse(fixture.db.prepare('SELECT item_results_json FROM performance_provider_collection_runs').get().item_results_json);
  assert.equal(items[0].attempts, 3);
  assert.equal(items[0].safe_error_category, 'provider_response_invalid');
});

test('surfaces unexpected scheduled campaign failures to the scheduler error boundary', async (t) => {
  const fixture = createFixture({
    getCampaignAccess() {
      throw new Error('database read failed');
    }
  });
  t.after(() => fixture.db.close());

  await assert.rejects(
    () => fixture.service.runScheduledDueCampaigns(),
    (error) => error instanceof PerformanceProviderCollectionServiceError &&
      error.statusCode === 503 && error.code === 'PERFORMANCE_PROVIDER_SCHEDULER_FAILED' &&
      error.details && error.details.campaigns_failed === 1
  );
});

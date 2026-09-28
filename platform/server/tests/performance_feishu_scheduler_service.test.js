'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  createPerformanceFeishuSchedulerService,
  localDayKey,
  stableOperationId
} = require('../services/performance_feishu_scheduler_service');

function createFixture(options = {}) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, is_active INTEGER NOT NULL);
    CREATE TABLE organization_memberships (
      org_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role_code TEXT NOT NULL,
      status TEXT NOT NULL,
      PRIMARY KEY(org_id,user_id)
    );
    CREATE TABLE campaigns (
      id INTEGER PRIMARY KEY,
      org_id INTEGER NOT NULL,
      owner_user_id INTEGER NOT NULL,
      operational_status TEXT NOT NULL
    );
    CREATE TABLE performance_feishu_projection_configs (
      id INTEGER PRIMARY KEY,
      org_id INTEGER NOT NULL,
      campaign_id INTEGER NOT NULL,
      version INTEGER NOT NULL,
      status TEXT NOT NULL,
      daily_snapshot_table_id TEXT
    );
    INSERT INTO users (id,is_active) VALUES (1,1);
    INSERT INTO organization_memberships (org_id,user_id,role_code,status)
      VALUES (10,1,'org_admin','active');
    INSERT INTO campaigns (id,org_id,owner_user_id,operational_status)
      VALUES (7,10,1,'active');
    INSERT INTO performance_feishu_projection_configs (
      id,org_id,campaign_id,version,status,daily_snapshot_table_id
    ) VALUES (21,10,7,3,'approved','tbl_daily');
  `);
  const now = options.now || (() => new Date('2026-09-28T04:30:00.000Z'));
  const latestObservationAt = options.latestObservationAt === undefined
    ? '2026-09-28T04:00:00.000Z'
    : options.latestObservationAt;
  const operations = [];
  const connection = {
    getConnection() {
      return {
        campaign_id: 7,
        active_configuration: latestObservationAt === 'mapping-required'
          ? null
          : {
              id: 21,
              version: 3,
              status: 'approved',
              daily_snapshot_table_id: 'tbl_daily'
            },
        capabilities: { can_manage: true, can_approve: true },
        external_sync: { enabled: true, reason: 'ready', missing: [] }
      };
    },
    getDeliveryConfiguration() {
      if (latestObservationAt === 'mapping-required') {
        const error = new Error('mapping required');
        error.code = 'PERFORMANCE_FEISHU_CONNECTION_NOT_APPROVED';
        throw error;
      }
      return {
        id: 21,
        version: 3,
        status: 'approved',
        bitable_app_token: 'app-token',
        current_table_id: 'tbl_current',
        daily_snapshot_table_id: 'tbl_daily',
        field_mapping: {
          'content.original_url': '视频链接',
          'latest_observation.observed_at': '数据更新时间'
        }
      };
    }
  };
  const freshness = {
    getQueue() {
      return {
        schedule: {
          latest_observation_at: latestObservationAt === 'no-observation' ? null : latestObservationAt,
          next_due_at: '2026-09-28T10:00:00.000Z'
        },
        summary: { actionable: 0 },
        provider: { status: 'not_configured' }
      };
    }
  };
  const feishuClient = {
    getPerformanceStatus() {
      return options.externalEnabled === false
        ? { enabled: false, mode: 'performance_bitable', missing: ['FEISHU_PERFORMANCE_BITABLE_WRITE_ENABLED'] }
        : { enabled: true, mode: 'performance_bitable', missing: [] };
    }
  };
  const delivery = {
    async sync(input) {
      operations.push(input);
      const replayed = operations.filter((candidate) => candidate.operationId === input.operationId).length > 1;
      return {
        statusCode: 200,
        body: {
          configured: true,
          replayed,
          delivery: { status: 'succeeded' }
        }
      };
    }
  };
  const service = createPerformanceFeishuSchedulerService(db, {
    connectionService: connection,
    freshnessService: freshness,
    deliveryService: delivery,
    feishuClient,
    enabled: options.enabled !== false,
    now,
    intervalMs: 60 * 1000
  });
  return { db, service, operations };
}

test('creates stable UUID operation IDs and uses the configured local day', () => {
  const first = stableOperationId(['daily_snapshot', '7', '21', '3', '2026-09-28']);
  const replay = stableOperationId(['daily_snapshot', '7', '21', '3', '2026-09-28']);
  const changed = stableOperationId(['daily_snapshot', '7', '21', '3', '2026-09-29']);
  assert.equal(first, replay);
  assert.notEqual(first, changed);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(localDayKey('2026-09-28T16:30:00.000Z', 'Asia/Shanghai'), '2026-09-29');
});

test('fails closed without external Feishu configuration and does not create deliveries', async (t) => {
  const fixture = createFixture({ externalEnabled: false });
  t.after(() => fixture.db.close());

  const result = await fixture.service.runScheduledDueDeliveries();
  assert.equal(result.status, 'not_configured');
  assert.equal(result.external_sync_enabled, false);
  assert.equal(result.deliveries_started, 0);
  assert.equal(fixture.operations.length, 0);
});

test('delivers current state and one local-day snapshot with stable replay keys', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.db.close());

  const first = await fixture.service.runScheduledDueDeliveries();
  const replay = await fixture.service.runScheduledDueDeliveries();

  assert.equal(first.status, 'completed');
  assert.equal(first.campaigns_considered, 1);
  assert.equal(first.deliveries_started, 2);
  assert.equal(first.deliveries_replayed, 0);
  assert.equal(replay.deliveries_started, 0);
  assert.equal(replay.deliveries_replayed, 2);
  assert.equal(fixture.operations.length, 4);
  assert.deepEqual(fixture.operations.slice(0, 2).map((item) => item.body.snapshot_kind), [
    'current_state',
    'daily_snapshot'
  ]);
  assert.equal(fixture.operations[0].operationId, fixture.operations[2].operationId);
  assert.equal(fixture.operations[1].operationId, fixture.operations[3].operationId);
});

test('reports mapping and observation readiness in the campaign status', () => {
  const ready = createFixture().service.campaignStatus({ userId: 1, campaignId: 7 });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.campaign.mapping_version, 3);
  assert.equal(ready.campaign.daily_snapshot_local_day, '2026-09-28');

  const noObservation = createFixture({ latestObservationAt: 'no-observation' }).service.campaignStatus({
    userId: 1,
    campaignId: 7
  });
  assert.equal(noObservation.status, 'waiting_for_observation');
  assert.equal(noObservation.reason, 'performance_observation_required');

  const mappingRequired = createFixture({ latestObservationAt: 'mapping-required' }).service.campaignStatus({
    userId: 1,
    campaignId: 7
  });
  assert.equal(mappingRequired.status, 'mapping_required');
  assert.equal(mappingRequired.reason, 'approved_mapping_required');
});

test('skips campaigns with no observed performance data', async (t) => {
  const fixture = createFixture({ latestObservationAt: 'no-observation' });
  t.after(() => fixture.db.close());

  const result = await fixture.service.runScheduledDueDeliveries();
  assert.equal(result.campaigns_skipped, 1);
  assert.equal(result.deliveries_started, 0);
  assert.equal(fixture.operations.length, 0);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let projectionModule = {};
try {
  projectionModule = require('../services/performance_feishu_projection_service');
} catch (error) {
  const missingTarget = error && error.code === 'MODULE_NOT_FOUND' &&
    String(error.message || '').includes('performance_feishu_projection_service');
  if (!missingTarget) throw error;
}

function connectionState(overrides = {}) {
  return Object.assign({
    campaign_id: 7,
    active_configuration: {
      id: 21,
      version: 3,
      status: 'approved',
      bitable_app_token: 'bascnPerformanceApp',
      current_table_id: 'tblCurrentState',
      daily_snapshot_table_id: 'tblDailySnapshot',
      field_mapping: {
        'content.original_url': '视频链接',
        'content.tags': '内容标签',
        'latest_observation.observed_at': '数据更新时间',
        'latest_observation.views': '播放量',
        'metrics.core_view_er': '互动率'
      }
    },
    capabilities: { can_manage: true, can_approve: false }
  }, overrides);
}

function performanceContents() {
  return {
    consistency: 'sqlite_read_transaction',
    total: 2,
    limit: 100,
    offset: 0,
    items: [
      {
        id: 101,
        original_url: 'https://www.youtube.com/watch?v=abc123',
        platform: 'youtube',
        creator_id: 'creator-1',
        creator_name: 'Creator One',
        product: 'S19 Bike',
        tags: ['fitness', 'launch'],
        published_at: '2026-09-08T08:00:00.000Z',
        latest_observation: {
          id: 501,
          observed_at: '2026-09-10T08:30:00.000Z',
          views: 1234,
          likes: 80
        },
        metrics: {
          core_view_er: { available: true, value: 0.08 },
          ctr: { available: false, value: null }
        }
      },
      {
        id: 102,
        original_url: 'https://www.instagram.com/reel/no-observation/',
        platform: 'instagram',
        tags: [],
        latest_observation: null,
        metrics: {}
      }
    ]
  };
}

test('builds a deterministic approved Feishu snapshot from the latest observed performance rows', () => {
  assert.equal(
    typeof projectionModule.createPerformanceFeishuProjectionService,
    'function',
    'the performance Feishu projection service must exist'
  );
  const calls = [];
  const service = projectionModule.createPerformanceFeishuProjectionService({
    now: () => new Date('2026-09-10T09:00:00.000Z'),
    feishuConnectionService: {
      getConnection(input) {
        calls.push(['connection', input]);
        return connectionState();
      }
    },
    performanceService: {
      getProjectionSnapshot(input) {
        calls.push(['snapshot', input]);
        return performanceContents();
      }
    }
  });

  const result = service.preview({ userId: 1, campaignId: 7 });

  assert.equal(result.contract_version, 'performance-feishu-projection-preview-v1');
  assert.equal(result.campaign_id, 7);
  assert.deepEqual(result.configuration, { id: 21, version: 3, status: 'approved' });
  assert.deepEqual(result.target, { kind: 'daily_snapshot', configured: true });
  assert.deepEqual(result.snapshot, {
    generated_at: '2026-09-10T09:00:00.000Z',
    source_total: 2,
    record_count: 1,
    excluded_without_observation: 1,
    latest_observed_at: '2026-09-10T08:30:00.000Z'
  });
  assert.deepEqual(result.columns, [
    '视频链接',
    '内容标签',
    '数据更新时间',
    '播放量',
    '互动率'
  ]);
  assert.deepEqual(result.records, [{
    fields: {
      '视频链接': 'https://www.youtube.com/watch?v=abc123',
      '内容标签': 'fitness, launch',
      '数据更新时间': '2026-09-10T08:30:00.000Z',
      '播放量': 1234,
      '互动率': 0.08
    }
  }]);
  assert.deepEqual(calls, [
    ['connection', { userId: 1, campaignId: 7 }],
    ['snapshot', { userId: 1, campaignId: 7 }]
  ]);
});

test('exports the approved projection as a Feishu-ready UTF-8 CSV without inventing missing rows', () => {
  assert.equal(typeof projectionModule.createPerformanceFeishuProjectionService, 'function');
  const service = projectionModule.createPerformanceFeishuProjectionService({
    now: () => new Date('2026-09-10T09:00:00.000Z'),
    feishuConnectionService: { getConnection() { return connectionState(); } },
    performanceService: { getProjectionSnapshot() { return performanceContents(); } }
  });

  const exported = service.exportCsv({ userId: 1, campaignId: 7 });

  assert.equal(exported.filename, 'performance_campaign_7_feishu_snapshot_2026-09-10.csv');
  assert.equal(exported.record_count, 1);
  assert.equal(
    exported.csv,
    '\ufeff"视频链接","内容标签","数据更新时间","播放量","互动率"\r\n' +
      '"https://www.youtube.com/watch?v=abc123","fitness, launch","2026-09-10T08:30:00.000Z",1234,0.08\r\n'
  );
});

test('requires campaign management permission and an approved mapping', () => {
  assert.equal(typeof projectionModule.createPerformanceFeishuProjectionService, 'function');
  const service = projectionModule.createPerformanceFeishuProjectionService({
    feishuConnectionService: {
      getConnection(input) {
        if (input.userId === 3) return connectionState({ capabilities: { can_manage: false } });
        return connectionState({ active_configuration: null });
      }
    },
    performanceService: { getProjectionSnapshot() { throw new Error('must not read performance rows'); } }
  });

  assert.throws(() => service.preview({ userId: 3, campaignId: 7 }), (error) => (
    error && error.code === 'PERFORMANCE_FEISHU_PROJECTION_FORBIDDEN' && error.statusCode === 403
  ));
  assert.throws(() => service.preview({ userId: 1, campaignId: 7 }), (error) => (
    error && error.code === 'PERFORMANCE_FEISHU_PROJECTION_CONFIGURATION_REQUIRED' && error.statusCode === 409
  ));
});

test('rejects a snapshot whose stable read boundary contains duplicate publication members', () => {
  assert.equal(typeof projectionModule.createPerformanceFeishuProjectionService, 'function');
  const duplicate = performanceContents();
  duplicate.items[1] = Object.assign({}, duplicate.items[0]);
  const service = projectionModule.createPerformanceFeishuProjectionService({
    feishuConnectionService: { getConnection() { return connectionState(); } },
    performanceService: { getProjectionSnapshot() { return duplicate; } }
  });

  assert.throws(() => service.preview({ userId: 1, campaignId: 7 }), (error) => (
    error && error.code === 'PERFORMANCE_FEISHU_PROJECTION_SOURCE_CHANGED' && error.statusCode === 409
  ));
});

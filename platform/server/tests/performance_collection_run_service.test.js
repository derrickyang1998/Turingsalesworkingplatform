'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  COLLECTION_RUN_CONTRACT_VERSION,
  PerformanceCollectionRunServiceError,
  createPerformanceCollectionRunService
} = require('../services/performance_collection_run_service');

function createFixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE activity_log (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      module TEXT,
      details TEXT,
      ip_address TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE campaign_publications (
      id INTEGER PRIMARY KEY,
      org_id INTEGER NOT NULL,
      campaign_id INTEGER NOT NULL
    );
    CREATE TABLE performance_provider_collection_runs (
      id INTEGER PRIMARY KEY,
      org_id INTEGER NOT NULL,
      campaign_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      trigger_mode TEXT NOT NULL,
      status TEXT NOT NULL,
      counts_json TEXT NOT NULL,
      safe_error_category TEXT,
      completed_at TEXT NOT NULL
    );
    INSERT INTO campaign_publications (id,org_id,campaign_id) VALUES (42,3,7),(77,4,8);
  `);
  const service = createPerformanceCollectionRunService(db, {
    getCampaignAccess(_database, input) {
      if (Number(input.campaignId) !== 7) {
        return { ok: false, status: 404, code: 'CAMPAIGN_NOT_FOUND' };
      }
      if (Number(input.userId) !== 9) {
        return { ok: false, status: 403, code: 'CAMPAIGN_FORBIDDEN' };
      }
      return {
        ok: true,
        role: 'owner',
        campaign: { id: 7, org_id: 3, owner_user_id: 9 },
        permissions: { read: true, write: true }
      };
    }
  });
  return { db, service };
}

function insertLog(db, id, action, details, createdAt) {
  db.prepare(`
    INSERT INTO activity_log (id,user_id,action,module,details,created_at)
    VALUES (?,?,?,?,?,?)
  `).run(id, 9, action, 'performance', JSON.stringify(details), createdAt);
}

test('projects safe campaign-scoped collection history from existing performance audit records', () => {
  const { db, service } = createFixture();
  try {
    insertLog(db, 11, 'performance_content_import', {
      campaign_id: 7,
      accepted: 0,
      duplicate: 0,
      rejected: 2,
      file_hash: 'a'.repeat(64)
    }, '2026-09-10 10:01:00');
    insertLog(db, 12, 'performance_manual_input', {
      campaign_id: 7,
      publication_id: 42,
      observation_id: 99,
      manual_input_id: null
    }, '2026-09-10 10:02:00');
    insertLog(db, 13, 'performance_metric_import', {
      campaign_id: 7,
      accepted: 8,
      duplicate: 1,
      rejected: 1,
      file_hash: 'b'.repeat(64),
      mapping_version: 'private-mapping-name'
    }, '2026-09-10 10:03:00');
    insertLog(db, 14, 'performance_manual_input', {
      campaign_id: 7,
      publication_id: 42,
      observation_id: null,
      manual_input_id: 501
    }, '2026-09-10 10:04:00');
    insertLog(db, 15, 'performance_metric_import', {
      campaign_id: 8,
      accepted: 9,
      duplicate: 0,
      rejected: 0
    }, '2026-09-10 10:05:00');
    db.prepare(`
      INSERT INTO activity_log (id,user_id,action,module,details,created_at)
      VALUES (16,9,'performance_metric_import','performance','not-json','2026-09-10 10:06:00')
    `).run();
    insertLog(db, 17, 'performance_metric_import', {
      campaign_id: 7,
      accepted: '9',
      duplicate: -1,
      rejected: null
    }, '2026-09-10 10:07:00');
    insertLog(db, 18, 'performance_manual_input', {
      campaign_id: 7,
      publication_id: 77,
      observation_id: 100
    }, '2026-09-10 10:08:00');

    const result = service.listRuns({ userId: 9, campaignId: 7, query: { limit: 20 } });

    assert.equal(result.contract_version, COLLECTION_RUN_CONTRACT_VERSION);
    assert.equal(result.campaign_id, 7);
    assert.deepEqual(result.summary, {
      total: 4,
      succeeded: 1,
      partial: 1,
      failed: 2,
      latest_completed_at: '2026-09-10T10:07:00.000Z'
    });
    assert.deepEqual(result.items.map((item) => item.operation), [
      'metric_import',
      'metric_import',
      'manual_metric_update',
      'content_import'
    ]);
    assert.deepEqual(result.items.map((item) => item.status), ['failed', 'partial', 'succeeded', 'failed']);
    assert.deepEqual(result.items[0].counts, {
      total: 0,
      succeeded: 0,
      duplicate: 0,
      failed: 0
    });
    assert.equal(result.items[0].safe_error_category, 'audit_record_invalid');
    assert.deepEqual(result.items[1].counts, {
      total: 10,
      succeeded: 8,
      duplicate: 1,
      failed: 1
    });
    assert.equal(result.items[1].source_mode, 'csv_xlsx');
    assert.equal(result.items[1].safe_error_category, 'row_validation');
    assert.equal(result.items[2].publication_id, 42);
    assert.equal(result.items[2].source_mode, 'manual');
    assert.deepEqual(result.items[2].counts, {
      total: 1,
      succeeded: 1,
      duplicate: 0,
      failed: 0
    });
    assert.equal(result.capabilities.diagnostics_level, 'summary');
    assert.equal(result.source.history_window_limit, 5000);
    assert.equal(result.source.history_window_truncated, false);
    assert.doesNotMatch(JSON.stringify(result), /private-mapping-name|bbbbbbbbbbbbbbbb/);
    assert.doesNotMatch(JSON.stringify(result), /"publication_id":77/);
  } finally {
    db.close();
  }
});

test('validates and projects a provider collection run from its immutable ledger record', () => {
  const { db, service } = createFixture();
  try {
    db.prepare(`
      INSERT INTO performance_provider_collection_runs (
        id,org_id,campaign_id,provider,trigger_mode,status,counts_json,safe_error_category,completed_at
      ) VALUES (50,3,7,'youtube','scheduled','partial',?,'item_failure','2026-09-10T10:09:00.000Z')
    `).run(JSON.stringify({ total: 3, succeeded: 2, failed: 1 }));
    insertLog(db, 19, 'performance_provider_collection', {
      campaign_id: 7,
      provider: 'youtube',
      provider_run_id: 50,
      counts: { total: 999, succeeded: 999, failed: 0 },
      status: 'succeeded'
    }, '2026-09-10 10:09:01');

    const result = service.listRuns({ userId: 9, campaignId: 7, query: {} });

    assert.equal(result.items[0].operation, 'provider_refresh');
    assert.equal(result.items[0].source_mode, 'provider');
    assert.equal(result.items[0].provider, 'youtube');
    assert.equal(result.items[0].trigger_mode, 'scheduled');
    assert.equal(result.items[0].status, 'partial');
    assert.deepEqual(result.items[0].counts, {
      total: 3,
      succeeded: 2,
      duplicate: 0,
      failed: 1
    });
    assert.equal(result.items[0].safe_error_category, 'item_failure');
  } finally {
    db.close();
  }
});

test('bounds the projected history window while keeping the response page compact', () => {
  const { db, service } = createFixture();
  try {
    const insert = db.prepare(`
      INSERT INTO activity_log (id,user_id,action,module,details,created_at)
      VALUES (?,?,?,?,?,?)
    `);
    db.transaction(() => {
      for (let id = 1; id <= 5002; id += 1) {
        insert.run(
          id,
          9,
          'performance_metric_import',
          'performance',
          JSON.stringify({ campaign_id: 7, accepted: 1, duplicate: 0, rejected: 0 }),
          `2026-09-10 10:${String(Math.floor(id / 60) % 60).padStart(2, '0')}:${String(id % 60).padStart(2, '0')}`
        );
      }
    })();

    const result = service.listRuns({ userId: 9, campaignId: 7, query: { limit: 12 } });

    assert.equal(result.items.length, 12);
    assert.equal(result.summary.total, 5000);
    assert.equal(result.source.history_window_limit, 5000);
    assert.equal(result.source.history_window_truncated, true);
    assert.equal(result.page.has_more, true);
  } finally {
    db.close();
  }
});

test('enforces campaign access and validates the bounded list query', () => {
  const { db, service } = createFixture();
  try {
    const expressQuery = Object.create(null);
    expressQuery.limit = '12';
    assert.equal(
      service.listRuns({ userId: 9, campaignId: 7, query: expressQuery }).page.limit,
      12
    );
    assert.throws(
      () => service.listRuns({ userId: 8, campaignId: 7, query: {} }),
      (error) => error instanceof PerformanceCollectionRunServiceError &&
        error.statusCode === 403 && error.code === 'CAMPAIGN_FORBIDDEN'
    );
    assert.throws(
      () => service.listRuns({ userId: 9, campaignId: 7, query: { limit: '0' } }),
      (error) => error instanceof PerformanceCollectionRunServiceError &&
        error.statusCode === 400 && error.code === 'PERFORMANCE_COLLECTION_RUN_QUERY_INVALID'
    );
    assert.throws(
      () => service.listRuns({ userId: 9, campaignId: 7, query: { provider: 'tiktok' } }),
      (error) => error instanceof PerformanceCollectionRunServiceError &&
        error.statusCode === 400 && error.code === 'PERFORMANCE_COLLECTION_RUN_QUERY_INVALID'
    );
  } finally {
    db.close();
  }
});

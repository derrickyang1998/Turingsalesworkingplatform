'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const performanceMigration = require('../migrations/010_performance_manual_foundation');
const connectionMigration = require('../migrations/011_performance_feishu_connection_config');
const migrationService = require('../services/migration_service');
const migrationGate = require('../scripts/verify_campaign_migration_gate');
const {
  PerformanceFeishuConnectionServiceError,
  createPerformanceFeishuConnectionService
} = require('../services/performance_feishu_connection_service');

function createFixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE campaigns (
      id INTEGER PRIMARY KEY,
      org_id INTEGER NOT NULL,
      owner_user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      operational_status TEXT NOT NULL DEFAULT 'active',
      UNIQUE(org_id,id)
    ) STRICT;
    CREATE TABLE organization_memberships (
      org_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role_code TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      PRIMARY KEY(org_id,user_id)
    ) STRICT;
    CREATE TABLE activity_log (
      id INTEGER PRIMARY KEY,
      user_id INTEGER,
      action TEXT NOT NULL,
      module TEXT NOT NULL,
      details TEXT,
      ip_address TEXT
    ) STRICT;
    INSERT INTO campaigns (id,org_id,owner_user_id,name,operational_status)
    VALUES (7,1,1,'Merach Autumn Launch','active');
    INSERT INTO organization_memberships (org_id,user_id,role_code,status)
    VALUES (1,1,'member','active'),(1,2,'org_admin','active'),(1,3,'member','active');
  `);
  performanceMigration.apply(db);
  connectionMigration.apply(db);

  function getCampaignAccess(_database, input) {
    if (Number(input.campaignId) !== 7) {
      return { ok: false, status: 404, code: 'CAMPAIGN_NOT_FOUND' };
    }
    const userId = Number(input.userId);
    if (![1, 2, 3].includes(userId)) {
      return { ok: false, status: 403, code: 'CAMPAIGN_FORBIDDEN' };
    }
    const role = userId === 2 ? 'org_admin' : userId === 1 ? 'owner' : 'team_member';
    return {
      ok: true,
      role,
      organization: { id: 1, role_code: role === 'org_admin' ? 'org_admin' : 'member' },
      campaign: { id: 7, org_id: 1, owner_user_id: 1, operational_status: 'active' },
      permissions: { read: true, write: true }
    };
  }

  return {
    db,
    service: createPerformanceFeishuConnectionService(db, { getCampaignAccess })
  };
}

function draftBody(overrides = {}) {
  return Object.assign({
    bitable_app_token: 'bascnPerformanceApp',
    current_table_id: 'tblCurrentState',
    daily_snapshot_table_id: 'tblDailySnapshot',
    field_mapping: {
      'content.original_url': '视频链接',
      'latest_observation.observed_at': '数据更新时间',
      'latest_observation.views': '播放量',
      'latest_observation.likes': '点赞数',
      'latest_observation.comments': '评论数'
    }
  }, overrides);
}

test('stores a campaign-scoped, versioned Feishu projection draft without external sync', () => {
  const { db, service } = createFixture();
  try {
    const result = service.createDraft({ userId: 1, campaignId: 7, body: draftBody() });

    assert.equal(result.configuration.status, 'draft');
    assert.equal(result.configuration.version, 1);
    assert.equal(result.configuration.current_table_id, 'tblCurrentState');
    assert.equal(result.configuration.external_sync.enabled, false);
    assert.equal(result.configuration.external_sync.reason, 'not_enabled_in_this_release');
    assert.equal(result.capabilities.can_manage, true);
    assert.equal(result.capabilities.can_approve, false);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM performance_feishu_projection_configs').get().count, 1);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM activity_log WHERE action='performance_feishu_connection_draft'").get().count,
      1
    );
  } finally {
    db.close();
  }
});

test('requires organization-admin approval and atomically supersedes the prior approved mapping', () => {
  const { db, service } = createFixture();
  try {
    const first = service.createDraft({ userId: 1, campaignId: 7, body: draftBody() });
    assert.throws(() => service.approveDraft({
      userId: 1,
      campaignId: 7,
      configurationId: first.configuration.id
    }), (error) => (
      error instanceof PerformanceFeishuConnectionServiceError &&
      error.code === 'PERFORMANCE_FEISHU_CONNECTION_APPROVAL_FORBIDDEN'
    ));

    const firstApproval = service.approveDraft({
      userId: 2,
      campaignId: 7,
      configurationId: first.configuration.id
    });
    assert.equal(firstApproval.configuration.status, 'approved');
    assert.equal(firstApproval.active_configuration.id, first.configuration.id);
    assert.equal(firstApproval.configuration.external_sync.enabled, false);

    const second = service.createDraft({
      userId: 1,
      campaignId: 7,
      body: draftBody({ current_table_id: 'tblCurrentStateV2' })
    });
    assert.equal(second.configuration.version, 2);
    const secondApproval = service.approveDraft({
      userId: 2,
      campaignId: 7,
      configurationId: second.configuration.id
    });
    assert.equal(secondApproval.configuration.status, 'approved');
    assert.equal(secondApproval.active_configuration.id, second.configuration.id);
    assert.equal(
      db.prepare("SELECT status FROM performance_feishu_projection_configs WHERE id=?").get(first.configuration.id).status,
      'superseded'
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM performance_feishu_projection_configs WHERE status='approved'").get().count,
      1
    );
  } finally {
    db.close();
  }
});

test('does not disclose target identifiers to a team member and blocks their configuration writes', () => {
  const { db, service } = createFixture();
  try {
    const draft = service.createDraft({ userId: 1, campaignId: 7, body: draftBody() });
    service.approveDraft({ userId: 2, campaignId: 7, configurationId: draft.configuration.id });

    const member = service.getConnection({ userId: 3, campaignId: 7 });
    assert.equal(member.active_configuration.status, 'approved');
    assert.equal(Object.hasOwn(member.active_configuration, 'bitable_app_token'), false);
    assert.equal(Object.hasOwn(member.active_configuration, 'current_table_id'), false);
    assert.equal(Object.hasOwn(member.active_configuration, 'field_mapping'), false);
    assert.equal(member.capabilities.can_manage, false);
    assert.throws(() => service.createDraft({ userId: 3, campaignId: 7, body: draftBody() }), (error) => (
      error instanceof PerformanceFeishuConnectionServiceError &&
      error.code === 'PERFORMANCE_FEISHU_CONNECTION_MANAGE_FORBIDDEN'
    ));
  } finally {
    db.close();
  }
});

test('rejects incomplete or ambiguous mappings before persistence', () => {
  const { db, service } = createFixture();
  try {
    assert.throws(() => service.createDraft({
      userId: 1,
      campaignId: 7,
      body: draftBody({ field_mapping: { 'latest_observation.views': '播放量' } })
    }), (error) => (
      error instanceof PerformanceFeishuConnectionServiceError &&
      error.code === 'PERFORMANCE_FEISHU_CONNECTION_MAPPING_INVALID'
    ));
    assert.throws(() => service.createDraft({
      userId: 1,
      campaignId: 7,
      body: draftBody({
        field_mapping: {
          'content.original_url': '同一列',
          'latest_observation.observed_at': '同一列'
        }
      })
    }), (error) => (
      error instanceof PerformanceFeishuConnectionServiceError &&
      error.code === 'PERFORMANCE_FEISHU_CONNECTION_MAPPING_INVALID'
    ));
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM performance_feishu_projection_configs').get().count, 0);
  } finally {
    db.close();
  }
});

test('database protects configured projection history from arbitrary mutation or deletion', () => {
  const { db, service } = createFixture();
  try {
    const draft = service.createDraft({ userId: 1, campaignId: 7, body: draftBody() });
    assert.throws(() => db.prepare(
      "UPDATE performance_feishu_projection_configs SET current_table_id='tblTampered' WHERE id=?"
    ).run(draft.configuration.id), /immutable|state transition/i);
    assert.throws(() => db.prepare(
      'DELETE FROM performance_feishu_projection_configs WHERE id=?'
    ).run(draft.configuration.id), /append-only|cannot delete/i);
  } finally {
    db.close();
  }
});

test('checksum-bound migration replay reaches schema version 11 with the connection configuration table', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-performance-feishu-connection-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = migrationService.openMigratedDatabase(path.join(root, 'connection.db'), {
    rootDir: path.resolve(__dirname, '..'),
    registeredMigrations: migrationGate.REGISTERED_MIGRATIONS
  });
  try {
    assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 11);
    assert.ok(db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name='performance_feishu_projection_configs'").get());
  } finally {
    db.close();
  }
});

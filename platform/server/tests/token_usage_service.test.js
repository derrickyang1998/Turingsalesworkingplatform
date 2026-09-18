'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const migrationGate = require('../scripts/verify_campaign_migration_gate');

const SERVER_ROOT = path.resolve(__dirname, '..');

function loadService() {
  try {
    return require('../services/token_usage_service');
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') assert.fail('token usage service has not been implemented');
    throw error;
  }
}

function openDatabase() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrationService.runMigrations(db, {
    rootDir: SERVER_ROOT,
    registeredMigrations: migrationGate.REGISTERED_MIGRATIONS
  });
  return db;
}

function seedSecondOrganizationForSameUser(db) {
  db.prepare("INSERT INTO organizations (id,code,name) VALUES (2,'token-runtime-org-2','Token Runtime Org 2')").run();
  db.prepare(`
    INSERT INTO organization_memberships (org_id,user_id,role_code,status)
    VALUES (2,1,'org_admin','active')
  `).run();
}

test('token writes and ordinary reads stay inside trusted active organization context', () => {
  const service = loadService();
  const db = openDatabase();
  try {
    seedSecondOrganizationForSameUser(db);
    service.recordUsage(db, {
      organizationId: 1,
      userId: 1,
      model: 'deepseek-chat',
      promptTokens: 3,
      completionTokens: 4,
      totalTokens: 7,
      endpoint: 'ai_chat',
      org_id: 2
    });
    service.recordUsage(db, {
      organizationId: 2,
      userId: 1,
      model: 'deepseek-chat',
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      endpoint: 'ai_chat'
    });
    assert.equal(service.sumForUser(db, { organizationId: 1, userId: 1 }), 7);
    assert.equal(service.sumForUser(db, { organizationId: 2, userId: 1 }), 15);
    const rows = service.listUsage(db, {
      user: { id: 1, role: 'user' },
      organizationId: 1,
      requestId: 'token-self-org-one'
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].total_tokens, 7);
    assert.equal(Object.hasOwn(rows[0], 'org_id'), false);
  } finally {
    db.close();
  }
});

test('platform-wide aggregation requires explicit admin audit mode and records bounded audit evidence', () => {
  const service = loadService();
  const db = openDatabase();
  try {
    seedSecondOrganizationForSameUser(db);
    for (const organizationId of [1, 2]) {
      service.recordUsage(db, {
        organizationId,
        userId: 1,
        model: 'deepseek-chat',
        promptTokens: organizationId,
        completionTokens: 1,
        totalTokens: organizationId + 1,
        endpoint: 'ai_chat'
      });
    }
    const admin = { id: 1, role: 'admin' };
    assert.equal(service.listUsage(db, {
      user: admin,
      organizationId: 1,
      requestId: 'token-admin-local'
    }).length, 1);
    const global = service.listUsage(db, {
      user: admin,
      organizationId: 1,
      requestId: 'token-admin-global',
      adminAuditGlobal: true,
      ipAddress: '127.0.0.1'
    });
    assert.equal(global.length, 2);
    assert.deepEqual(global.map((row) => ({
      organization_id: row.organization_id,
      organization_name: row.organization_name,
      username: row.username,
      request_count: row.request_count,
      total_tokens: row.total_tokens
    })), [
      {
        organization_id: 2,
        organization_name: 'Token Runtime Org 2',
        username: 'admin',
        request_count: 1,
        total_tokens: 3
      },
      {
        organization_id: 1,
        organization_name: 'TuringMarket',
        username: 'admin',
        request_count: 1,
        total_tokens: 2
      }
    ]);
    const audit = db.prepare(`
      SELECT action,module,details FROM activity_log
      WHERE action='admin_list_token_usage' ORDER BY id DESC LIMIT 1
    `).get();
    assert.equal(audit.module, 'token_usage_audit');
    assert.deepEqual(JSON.parse(audit.details), {
      request_id: 'token-admin-global',
      scope: 'global',
      active_organization_id: 1,
      organization_count: 2,
      row_count: global.length
    });
    assert.throws(() => service.listUsage(db, {
      user: { id: 1, role: 'user' },
      organizationId: 1,
      requestId: 'token-user-global',
      adminAuditGlobal: true
    }), /administrator/i);
  } finally {
    db.close();
  }
});

test('runtime accounting fails closed when organization ownership schema is unavailable', () => {
  const service = loadService();
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        model TEXT NOT NULL,
        prompt_tokens INTEGER DEFAULT 0,
        completion_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        endpoint TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    assert.throws(() => service.recordUsage(db, {
      organizationId: 1,
      userId: 1,
      model: 'deepseek-chat',
      totalTokens: 1
    }), (error) => error && error.code === 'TOKEN_USAGE_SCHEMA_UNAVAILABLE');
    assert.throws(() => service.sumForUser(db, {
      organizationId: 1,
      userId: 1
    }), (error) => error && error.code === 'TOKEN_USAGE_SCHEMA_UNAVAILABLE');
  } finally {
    db.close();
  }
});

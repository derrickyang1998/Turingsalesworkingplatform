'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const migrationGate = require('../scripts/verify_campaign_migration_gate');

const SERVER_ROOT = path.resolve(__dirname, '..');

function loadMigration() {
  try {
    return require('../migrations/026_token_usage_tenant_ownership');
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') {
      assert.fail('migration 026 has not been implemented');
    }
    throw error;
  }
}

function openV25() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrationService.runMigrations(db, {
    rootDir: SERVER_ROOT,
    registeredMigrations: migrationGate.REGISTERED_MIGRATIONS.filter((item) => item.version <= 25)
  });
  return db;
}

function migrateToV26(db) {
  const migration = loadMigration();
  return migrationService.runMigrations(db, {
    rootDir: SERVER_ROOT,
    registeredMigrations: [
      ...migrationGate.REGISTERED_MIGRATIONS.filter((item) => item.version <= 25),
      migration
    ]
  });
}

function seedOrganizationTwo(db) {
  db.prepare("INSERT INTO organizations (id,code,name) VALUES (2,'token-org-2','Token Org 2')").run();
  db.prepare(`
    INSERT INTO users (id,username,password_hash,display_name,role,is_active)
    VALUES (100,'token-user-2','fixture-hash','Token User 2','user',1)
  `).run();
  db.prepare(`
    INSERT INTO organization_memberships (org_id,user_id,role_code,status)
    VALUES (2,100,'org_admin','active')
  `).run();
  db.prepare("INSERT INTO teams (id,org_id,code,name) VALUES (100,2,'token-team-2','Token Team 2')").run();
  db.prepare(`
    INSERT INTO team_memberships (org_id,team_id,user_id,role_code,status)
    VALUES (2,100,100,'team_lead','active')
  `).run();
  db.prepare(`
    INSERT INTO customers (id,brand_name,created_by,assigned_to,is_public,org_id,team_id)
    VALUES (1001,'Token Brand 2',100,100,0,2,100)
  `).run();
  db.prepare(`
    INSERT INTO opportunities (id,customer_id,name,created_by,org_id,team_id,owner_user_id)
    VALUES (2001,1001,'Token Opportunity 2',100,2,100,100)
  `).run();
  db.prepare(`
    INSERT INTO campaigns (id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id)
    VALUES (3001,2,'Token Campaign 2',1001,2001,100,100)
  `).run();
}

function insertReviewAudit(db) {
  const fingerprint = 'a'.repeat(64);
  const request = db.prepare(`
    INSERT INTO request_idempotency (
      org_id,user_id,campaign_id,resource_claim,scope,idempotency_key,reservation_nonce,
      request_hash,audit_fingerprint,expected_event_count,state,lease_until,lease_token,
      created_at,updated_at,operation_deadline,expires_at
    ) VALUES (
      2,100,3001,NULL,'ai.conversation.create.linked','token-v26-audit',?,
      ?,?,1,'processing',datetime('now','+10 minutes'),?,
      datetime('now','-1 minute'),datetime('now','-1 minute'),datetime('now','+1 hour'),NULL
    )
  `).run('b'.repeat(64), 'c'.repeat(64), fingerprint, 'token-v26-lease-token');
  const usage = db.prepare(`
    INSERT INTO token_usage (user_id,model,prompt_tokens,completion_tokens,total_tokens,endpoint)
    VALUES (100,'fixture-model',11,7,18,'ai_chat_linked_rejected')
  `).run();
  db.prepare(`
    INSERT INTO performance_ai_review_audits (
      request_idempotency_id,token_usage_id,org_id,campaign_id,actor_user_id,
      audit_fingerprint,outcome,reason_code,stage
    ) VALUES (?,?,?,?,?,?,'withheld','ai_review_protocol_invalid','completion_validation')
  `).run(
    Number(request.lastInsertRowid),
    Number(usage.lastInsertRowid),
    2,
    3001,
    100,
    fingerprint
  );
  return Number(usage.lastInsertRowid);
}

test('migration 026 backfills the sole organization and installs immutable tenant guards', () => {
  const db = openV25();
  try {
    db.prepare(`
      INSERT INTO users (id,username,password_hash,display_name,role,is_active)
      VALUES (101,'former-token-user','fixture-hash','Former Token User','user',1)
    `).run();
    db.prepare(`
      INSERT INTO organization_memberships (org_id,user_id,role_code,status,revoked_at)
      VALUES (1,101,'member','revoked',datetime('now'))
    `).run();
    const usageId = Number(db.prepare(`
      INSERT INTO token_usage (user_id,model,prompt_tokens,completion_tokens,total_tokens,endpoint)
      VALUES (1,'fixture-model',3,4,7,'ai_chat')
    `).run().lastInsertRowid);
    const formerMemberUsageId = Number(db.prepare(`
      INSERT INTO token_usage (user_id,model,prompt_tokens,completion_tokens,total_tokens,endpoint)
      VALUES (101,'fixture-model',2,3,5,'ai_chat')
    `).run().lastInsertRowid);
    assert.deepEqual(migrateToV26(db), { status: 'managed', currentVersion: 26 });
    assert.equal(db.prepare('SELECT org_id FROM token_usage WHERE id=?').get(usageId).org_id, 1);
    assert.equal(db.prepare('SELECT org_id FROM token_usage WHERE id=?').get(formerMemberUsageId).org_id, 1);
    assert.throws(() => db.prepare('UPDATE token_usage SET total_tokens=8 WHERE id=?').run(usageId), /append-only/i);
    assert.throws(() => db.prepare('DELETE FROM token_usage WHERE id=?').run(usageId), /append-only/i);
    assert.throws(() => db.prepare(`
      INSERT INTO token_usage (org_id,user_id,model,prompt_tokens,completion_tokens,total_tokens,endpoint)
      VALUES (2,1,'fixture-model',1,1,2,'ai_chat')
    `).run(), /organization ownership/i);
    assert.throws(() => db.prepare(`
      INSERT INTO token_usage (org_id,user_id,model,prompt_tokens,completion_tokens,total_tokens,endpoint)
      VALUES (1,101,'fixture-model',1,1,2,'ai_chat')
    `).run(), /organization ownership/i);
    assert.throws(() => db.prepare(`
      INSERT INTO token_usage (org_id,user_id,model,prompt_tokens,completion_tokens,total_tokens,endpoint)
      VALUES (1,1,'fixture-model',-1,1,0,'ai_chat')
    `).run(), /organization ownership/i);
    assert.throws(() => db.prepare(`
      INSERT INTO token_usage (org_id,user_id,model,prompt_tokens,completion_tokens,total_tokens,endpoint)
      VALUES (1,1,'fixture-model',1,1,'not-a-number','ai_chat')
    `).run(), /organization ownership/i);
    assert.equal(db.pragma('foreign_key_check').length, 0);
  } finally {
    db.close();
  }
});

test('migration 026 uses authoritative review-audit ownership in a multi-organization database', () => {
  const db = openV25();
  try {
    seedOrganizationTwo(db);
    const usageId = insertReviewAudit(db);
    migrateToV26(db);
    assert.equal(db.prepare('SELECT org_id FROM token_usage WHERE id=?').get(usageId).org_id, 2);
    assert.throws(() => db.prepare(`
      INSERT INTO performance_ai_review_audits (
        request_idempotency_id,token_usage_id,org_id,campaign_id,actor_user_id,
        audit_fingerprint,outcome,reason_code,stage
      ) SELECT request_idempotency_id,?,1,campaign_id,actor_user_id,
          lower(hex(randomblob(32))),'withheld','ai_review_protocol_invalid','completion_validation'
        FROM performance_ai_review_audits LIMIT 1
    `).run(usageId), /organization|reserved/i);
    assert.equal(db.pragma('foreign_key_check').length, 0);
  } finally {
    db.close();
  }
});

test('migration 026 fails closed for unresolved multi-organization history without partial schema', () => {
  const db = openV25();
  try {
    seedOrganizationTwo(db);
    db.prepare(`
      INSERT INTO token_usage (user_id,model,prompt_tokens,completion_tokens,total_tokens,endpoint)
      VALUES (1,'fixture-model',1,2,3,'ai_chat')
    `).run();
    assert.throws(() => migrateToV26(db), /unresolved token usage organization ownership/i);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('token_usage') WHERE name='org_id'").get().count,
      0
    );
    assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 25);
  } finally {
    db.close();
  }
});

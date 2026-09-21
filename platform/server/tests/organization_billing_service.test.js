'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');

function loadService() {
  try {
    return require('../services/organization_billing_service');
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') {
      assert.fail('organization billing service has not been implemented');
    }
    throw error;
  }
}

function fixture(now = new Date().toISOString()) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY, username TEXT NOT NULL, role TEXT NOT NULL,
      is_active INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE organizations (id INTEGER PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL) STRICT;
    CREATE TABLE organization_memberships (
      org_id INTEGER NOT NULL, user_id INTEGER NOT NULL, role_code TEXT NOT NULL,
      status TEXT NOT NULL, PRIMARY KEY (org_id,user_id)
    ) STRICT;
    CREATE TABLE organization_authority (
      org_id INTEGER PRIMARY KEY, owner_user_id INTEGER NOT NULL,
      created_by INTEGER NOT NULL, updated_by INTEGER NOT NULL, version INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE organization_member_policy (
      org_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
      access_mode TEXT NOT NULL CHECK(access_mode IN ('read_write','read_only')),
      PRIMARY KEY (org_id,user_id)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
      model TEXT NOT NULL, prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0,
      endpoint TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) STRICT;
    CREATE TABLE activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, action TEXT NOT NULL,
      module TEXT NOT NULL, details TEXT, ip_address TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) STRICT;
    INSERT INTO users VALUES
      (1,'platform','admin',1),(2,'owner','user',1),(3,'org-admin','user',1),
      (4,'member','user',1),(5,'beta-owner','user',1),(6,'inactive-admin','user',0);
    INSERT INTO organizations VALUES (10,'alpha','Alpha'),(20,'beta','Beta');
    INSERT INTO organization_memberships VALUES
      (10,2,'member','active'),(10,3,'org_admin','active'),(10,4,'member','active'),
      (10,6,'org_admin','active'),(20,5,'member','active');
    INSERT INTO organization_member_policy VALUES
      (10,2,'read_write'),(10,3,'read_write'),(10,4,'read_write'),
      (10,6,'read_write'),(20,5,'read_write');
    INSERT INTO organization_authority VALUES (10,2,1,1,1),(20,5,1,1,1);
  `);
  require('../migrations/031_organization_billing_statements').apply(db);
  const service = loadService().createOrganizationBillingService(db, {
    now: () => new Date(now)
  });
  return { db, service };
}

function addPolicy(db, values = {}) {
  db.prepare(`
    INSERT INTO organization_billing_policies (
      org_id,policy_version,effective_month,billing_enabled,currency,base_fee_cents,
      included_tokens,overage_cents_per_million_tokens,changed_by,reason,source
    ) VALUES (10,2,?,?,?,?,?,?,1,'approved pricing','admin_update')
  `).run(
    values.effectiveMonth || '2026-10-01',
    values.enabled === false ? 0 : 1,
    'USD',
    values.baseFeeCents ?? 2500,
    values.includedTokens ?? 1000,
    values.overageRate ?? 100
  );
}

function addUsage(db, organizationId, totalTokens, createdAt, userId = 2) {
  db.prepare(`
    INSERT INTO token_usage (
      org_id,user_id,model,prompt_tokens,completion_tokens,total_tokens,endpoint,created_at
    ) VALUES (?,?,'deepseek-chat',0,?,?, 'ai_chat',?)
  `).run(organizationId, userId, totalTokens, totalTokens, createdAt);
}

function databaseMonths(db) {
  return db.prepare(`
    SELECT
      strftime('%Y-%m','now','start of month','-1 month') AS previous_key,
      date('now','start of month','-1 month') AS previous_effective,
      strftime('%Y-%m','now','start of month') AS current_key,
      strftime('%Y-%m','now','start of month','+1 month') AS next_key
  `).get();
}

function addHistoricalPolicy(db, values = {}) {
  const months = databaseMonths(db);
  const migration = require('../migrations/031_organization_billing_statements');
  db.exec('DROP TRIGGER organization_billing_policy_insert_guard;');
  db.prepare(`
    INSERT INTO organization_billing_policies (
      org_id,policy_version,effective_month,billing_enabled,currency,base_fee_cents,
      included_tokens,overage_cents_per_million_tokens,changed_by,reason,source
    ) VALUES (10,2,?,1,'USD',?,?,?,1,'historical test policy','admin_update')
  `).run(
    months.previous_effective,
    values.baseFeeCents ?? 2500,
    values.includedTokens ?? 1000,
    values.overageRate ?? 100
  );
  db.exec(migration.schemaManifest.triggers.organization_billing_policy_insert_guard + ';');
  return months;
}

test('computes the canonical organization billing statement digest', () => {
  const { computeOrganizationBillingStatementDigest } = loadService();
  assert.equal(computeOrganizationBillingStatementDigest({
    organizationId: 10,
    periodKey: '2026-08',
    periodStart: '2026-08-01 00:00:00',
    periodEnd: '2026-09-01 00:00:00',
    policy: {
      policy_version: 2,
      effective_month: '2026-08-01',
      billing_enabled: true,
      currency: 'USD',
      base_fee_cents: 1000,
      included_tokens: 1000000,
      overage_cents_per_million_tokens: 250
    },
    usage: {
      total_tokens: 1500000,
      usage_record_count: 2,
      usage_max_id: 42,
      billable_tokens: 500000
    },
    charges: {
      base_fee_cents: 1000,
      overage_fee_cents: 125,
      total_cents: 1125
    },
    closedBy: 3,
    reason: 'monthly close',
    createdAt: '2026-09-21 08:00:00'
  }), '349347a7096d0c1bbe08bd73cd6a2f12e2f8e6abd658bf05fea292d6406ddb2b');
});

test('projects one organization UTC month with integer half-up cents and excludes other periods and tenants', () => {
  const { db, service } = fixture('2026-10-15T12:00:00Z');
  try {
    addPolicy(db);
    addUsage(db, 10, 6000, '2026-10-10 01:00:00');
    addUsage(db, 10, 999999, '2026-09-30 23:59:59');
    addUsage(db, 10, 999999, '2026-11-01 00:00:00');
    addUsage(db, 20, 999999, '2026-10-10 01:00:00', 5);
    addUsage(db, 10, 500, '2026-10-11 01:00:00', 1);

    const billing = service.projectOrganizationBilling({ organizationId: 10, month: '2026-10' });
    assert.deepEqual(billing.policy, {
      policy_version: 2,
      effective_month: '2026-10-01',
      billing_enabled: true,
      currency: 'USD',
      base_fee_cents: 2500,
      included_tokens: 1000,
      overage_cents_per_million_tokens: 100
    });
    assert.deepEqual(billing.usage, {
      total_tokens: 6500,
      usage_record_count: 2,
      usage_max_id: 5,
      billable_tokens: 5500
    });
    assert.deepEqual(billing.charges, {
      base_fee_cents: 2500,
      overage_fee_cents: 1,
      total_cents: 2501
    });
    assert.equal(billing.status, 'estimated');
    assert.equal(billing.statement, null);
    assert.equal(billing.policy_head_version, 2);
    assert.equal(service.projectOrganizationBilling({ organizationId: 10, month: '2026-11' }).status, 'scheduled');
  } finally {
    db.close();
  }
});

test('allows owner and organization administrator reads while denying members, inactive users, and cross-tenant reads', () => {
  const { db, service } = fixture('2026-10-15T12:00:00Z');
  try {
    addPolicy(db);
    assert.equal(service.currentOrganizationBilling({ actorUserId: 2, organizationId: 10, month: '2026-10' }).organization_id, 10);
    assert.equal(service.currentOrganizationBilling({ actorUserId: 3, organizationId: 10, month: '2026-10' }).organization_id, 10);
    db.prepare("UPDATE organization_member_policy SET access_mode='read_only' WHERE org_id=10 AND user_id=3").run();
    assert.throws(
      () => service.currentOrganizationBilling({ actorUserId: 3, organizationId: 10, month: '2026-10' }),
      (error) => error.status === 403 && error.code === 'ORGANIZATION_BILLING_FORBIDDEN'
    );
    for (const input of [
      { actorUserId: 4, organizationId: 10 },
      { actorUserId: 5, organizationId: 10 },
      { actorUserId: 6, organizationId: 10 }
    ]) {
      assert.throws(
        () => service.currentOrganizationBilling({ ...input, month: '2026-10' }),
        (error) => error.status === 403 && error.code === 'ORGANIZATION_BILLING_FORBIDDEN'
      );
    }

    const admin = service.currentOrganizationBilling({
      actorUserId: 1,
      organizationId: 10,
      month: '2026-10',
      adminAuditGlobal: true,
      requestId: 'billing-read-1',
      ipAddress: '127.0.0.1'
    });
    assert.equal(admin.organization_id, 10);
    const audit = db.prepare("SELECT details FROM activity_log WHERE action='admin_view_organization_billing'").get();
    assert.deepEqual(JSON.parse(audit.details), {
      schema_version: 1,
      actor_user_id: 1,
      organization_id: 10,
      month: '2026-10',
      request_id: 'billing-read-1'
    });
  } finally {
    db.close();
  }
});

test('appends next-month policy with optimistic versioning and atomic bounded audit', () => {
  const { db, service } = fixture();
  try {
    const changed = service.updateOrganizationBillingPolicy({
      actorUserId: 1,
      organizationId: 10,
      billingEnabled: true,
      baseFeeCents: 2500,
      includedTokens: 1000000,
      overageCentsPerMillionTokens: 300,
      effectiveMonth: '2026-10',
      expectedVersion: 1,
      reason: 'Approved October organization pricing',
      requestId: 'billing-policy-1',
      ipAddress: '127.0.0.1'
    });
    assert.equal(changed.changed, true);
    assert.equal(changed.policy.policy_version, 2);
    assert.equal(changed.policy.effective_month, '2026-10-01');
    assert.throws(
      () => service.updateOrganizationBillingPolicy({
        actorUserId: 1, organizationId: 10, billingEnabled: true,
        baseFeeCents: 1, includedTokens: 0, overageCentsPerMillionTokens: 1,
        effectiveMonth: '2026-09', expectedVersion: 2, reason: 'retroactive'
      }),
      (error) => error.status === 400 && error.code === 'ORGANIZATION_BILLING_EFFECTIVE_MONTH_INVALID'
    );
    assert.throws(
      () => service.updateOrganizationBillingPolicy({
        actorUserId: 1, organizationId: 10, billingEnabled: true,
        baseFeeCents: 1, includedTokens: 0, overageCentsPerMillionTokens: 1,
        effectiveMonth: '2026-11', expectedVersion: 1, reason: 'stale'
      }),
      (error) => error.status === 409 && error.code === 'ORGANIZATION_BILLING_VERSION_CONFLICT'
    );
    assert.throws(
      () => service.updateOrganizationBillingPolicy({
        actorUserId: 2, organizationId: 10, billingEnabled: true,
        baseFeeCents: 1, includedTokens: 0, overageCentsPerMillionTokens: 1,
        effectiveMonth: '2026-11', expectedVersion: 2, reason: 'forbidden'
      }),
      (error) => error.status === 403 && error.code === 'ORGANIZATION_BILLING_ADMIN_FORBIDDEN'
    );
    const audit = db.prepare("SELECT details FROM activity_log WHERE action='organization_billing_policy_changed'").get();
    assert.equal(JSON.parse(audit.details).after.policy_version, 2);

    db.exec(`
      CREATE TRIGGER reject_billing_policy_audit
      BEFORE INSERT ON activity_log
      WHEN NEW.action='organization_billing_policy_changed'
      BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END;
    `);
    assert.throws(
      () => service.updateOrganizationBillingPolicy({
        actorUserId: 1, organizationId: 10, billingEnabled: false,
        baseFeeCents: 0, includedTokens: 0, overageCentsPerMillionTokens: 0,
        effectiveMonth: '2026-11', expectedVersion: 2, reason: 'must roll back'
      }),
      (error) => error.status === 503 && error.code === 'ORGANIZATION_BILLING_AUDIT_FAILED'
    );
    assert.equal(db.prepare('SELECT MAX(policy_version) AS version FROM organization_billing_policies WHERE org_id=10').get().version, 2);
  } finally {
    db.close();
  }
});

test('closes an ended month once with immutable digest and idempotent replay', () => {
  const { db, service } = fixture();
  try {
    const months = addHistoricalPolicy(db);
    addUsage(db, 10, 6000, `${months.previous_key}-10 01:00:00`);
    const input = {
      actorUserId: 1,
      organizationId: 10,
      period: months.previous_key,
      expectedPolicyVersion: 2,
      reason: 'Close approved October statement',
      requestId: 'close-october',
      ipAddress: '127.0.0.1'
    };
    const closed = service.closeOrganizationBillingStatement(input);
    assert.equal(closed.status, 'closed');
    assert.equal(closed.statement.total_cents, 2501);
    assert.equal(closed.statement.usage_record_count, 1);
    assert.equal(closed.statement.usage_max_id, 1);
    assert.match(closed.statement.statement_sha256, /^[a-f0-9]{64}$/);
    assert.equal(closed.idempotent_replay, false);
    const replay = service.closeOrganizationBillingStatement(input);
    assert.equal(replay.statement.statement_sha256, closed.statement.statement_sha256);
    assert.equal(replay.idempotent_replay, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM organization_billing_statements').get().count, 1);
    addUsage(db, 10, 999999, `${months.previous_key}-11 01:00:00`);
    const stable = service.projectOrganizationBilling({ organizationId: 10, month: months.previous_key });
    assert.deepEqual(stable.usage, closed.usage);
    assert.deepEqual(stable.charges, closed.charges);
    assert.equal(stable.statement.statement_sha256, closed.statement.statement_sha256);
    assert.throws(() => db.prepare('UPDATE organization_billing_statements SET total_cents=0').run(), /immutable/i);
    assert.throws(() => db.prepare('DELETE FROM organization_billing_statements').run(), /immutable/i);
    assert.throws(
      () => service.closeOrganizationBillingStatement({ ...input, reason: 'different close intent' }),
      (error) => error.status === 409 && error.code === 'ORGANIZATION_BILLING_STATEMENT_CONFLICT'
    );
  } finally {
    db.close();
  }
});

test('closed statements fail closed on digest corruption and retain effective policy beside the history head', () => {
  const { db, service } = fixture();
  try {
    const months = addHistoricalPolicy(db);
    addUsage(db, 10, 6000, `${months.previous_key}-10 01:00:00`);
    const closed = service.closeOrganizationBillingStatement({
      actorUserId: 1,
      organizationId: 10,
      period: months.previous_key,
      expectedPolicyVersion: 2,
      reason: 'Close historical statement'
    });
    service.updateOrganizationBillingPolicy({
      actorUserId: 1,
      organizationId: 10,
      billingEnabled: true,
      baseFeeCents: 5000,
      includedTokens: 2000,
      overageCentsPerMillionTokens: 200,
      effectiveMonth: months.next_key,
      expectedVersion: 2,
      reason: 'Future policy head'
    });
    const stable = service.projectOrganizationBilling({ organizationId: 10, month: months.previous_key });
    assert.equal(stable.policy.policy_version, 2);
    assert.equal(stable.policy_head_version, 3);
    assert.equal(stable.statement.statement_sha256, closed.statement.statement_sha256);

    const migration = require('../migrations/031_organization_billing_statements');
    db.exec('DROP TRIGGER organization_billing_statement_no_update;');
    db.prepare("UPDATE organization_billing_statements SET statement_sha256=? WHERE org_id=10 AND period_key=?")
      .run('b'.repeat(64), months.previous_key);
    db.exec(migration.schemaManifest.triggers.organization_billing_statement_no_update + ';');
    assert.throws(
      () => service.projectOrganizationBilling({ organizationId: 10, month: months.previous_key }),
      (error) => error.status === 503 && error.code === 'ORGANIZATION_BILLING_STATEMENT_CORRUPT'
    );
  } finally {
    db.close();
  }
});

test('refuses current, disabled, unsafe, and audit-failed statement closure without persisting a charge', () => {
  const { db, service } = fixture();
  try {
    const months = databaseMonths(db);
    assert.throws(
      () => service.closeOrganizationBillingStatement({
        actorUserId: 1, organizationId: 10, period: months.current_key,
        expectedPolicyVersion: 1, reason: 'current month'
      }),
      (error) => error.status === 409 && error.code === 'ORGANIZATION_BILLING_PERIOD_OPEN'
    );
    assert.throws(
      () => service.closeOrganizationBillingStatement({
        actorUserId: 1, organizationId: 10, period: months.previous_key,
        expectedPolicyVersion: 1, reason: 'disabled month'
      }),
      (error) => error.status === 409 && error.code === 'ORGANIZATION_BILLING_DISABLED'
    );

    addHistoricalPolicy(db, { baseFeeCents: 10 });
    addUsage(db, 10, 6000, `${months.previous_key}-10 01:00:00`);
    db.exec(`
      CREATE TRIGGER reject_billing_statement_audit
      BEFORE INSERT ON activity_log
      WHEN NEW.action='organization_billing_statement_closed'
      BEGIN SELECT RAISE(ABORT,'synthetic statement audit failure'); END;
    `);
    assert.throws(
      () => service.closeOrganizationBillingStatement({
        actorUserId: 1, organizationId: 10, period: months.previous_key,
        expectedPolicyVersion: 2, reason: 'must roll back'
      }),
      (error) => error.status === 503 && error.code === 'ORGANIZATION_BILLING_AUDIT_FAILED'
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM organization_billing_statements').get().count, 0);

    db.exec('DROP TRIGGER reject_billing_statement_audit;');
    addUsage(db, 10, Number.MAX_SAFE_INTEGER, `${months.previous_key}-11 01:00:00`);
    assert.throws(
      () => service.projectOrganizationBilling({ organizationId: 10, month: months.previous_key }),
      (error) => error.status === 503 && error.code === 'ORGANIZATION_BILLING_USAGE_UNSAFE'
    );

    db.prepare(`
      INSERT INTO token_usage (
        org_id,user_id,model,prompt_tokens,completion_tokens,total_tokens,endpoint,created_at
      ) VALUES (10,2,'deepseek-chat',1,2,4,'ai_chat',?)
    `).run(`${months.current_key}-10 01:00:00`);
    assert.throws(
      () => service.projectOrganizationBilling({ organizationId: 10, month: months.current_key }),
      (error) => error.status === 503 && error.code === 'ORGANIZATION_BILLING_USAGE_UNSAFE'
    );
  } finally {
    db.close();
  }
});

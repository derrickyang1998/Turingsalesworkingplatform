'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  AIQuotaServiceError,
  assertAdmission,
  normalizeQuota,
  normalizeOrganizationMonthlyLimit,
  projectMembershipUsage,
  projectOrganizationQuotas,
  readOrganizationQuotaProjection,
  readLivePolicy,
  recordUsageOrThrow,
  updateOrganizationMonthlyQuota,
  updateUserQuota,
  writeQuotaUpdateAuditInTransaction
} = require('../services/ai_quota_service');
const Database = require('better-sqlite3');

function openDatabase({ withTenantLedger = true } = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL,
      api_quota,
      is_active INTEGER NOT NULL
    );
    CREATE TABLE organizations (
      id INTEGER PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL
    ) STRICT;
    CREATE TABLE organization_memberships (
      org_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role_code TEXT NOT NULL,
      status TEXT NOT NULL,
      revoked_at TEXT,
      PRIMARY KEY(org_id,user_id),
      FOREIGN KEY(org_id) REFERENCES organizations(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    ) STRICT;
    ${withTenantLedger ? `
      CREATE TABLE token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        org_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        model TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        endpoint TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(org_id) REFERENCES organizations(id),
        FOREIGN KEY(org_id,user_id) REFERENCES organization_memberships(org_id,user_id)
      ) STRICT;
    ` : `
      CREATE TABLE token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        model TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        endpoint TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
      ) STRICT;
    `}
    CREATE TABLE activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      module TEXT,
      details TEXT,
      ip_address TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    ) STRICT;
    CREATE TABLE organization_ai_quota_policies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL,
      policy_version INTEGER NOT NULL,
      monthly_limit INTEGER,
      changed_by INTEGER,
      reason TEXT,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(org_id,policy_version),
      FOREIGN KEY(org_id) REFERENCES organizations(id),
      FOREIGN KEY(changed_by) REFERENCES users(id)
    ) STRICT;

    INSERT INTO users (id,username,display_name,role,api_quota,is_active) VALUES
      (1,'platform-admin','Platform Admin','admin',0,1),
      (2,'alice','Alice','user',100,1),
      (3,'bob','Bob','user',50,1),
      (4,'inactive-user','Inactive User','user',100,0),
      (5,'disabled-user','Disabled User','user',0,1),
      (6,'invalid-quota','Invalid Quota','user','not-a-quota',1),
      (7,'no-membership','No Membership','user',100,1);
    INSERT INTO organizations (id,code,name) VALUES
      (10,'org-a','Organization A'),
      (20,'org-b','Organization B');
    INSERT INTO organization_memberships (org_id,user_id,role_code,status,revoked_at) VALUES
      (10,1,'org_admin','active',NULL),
      (20,1,'org_admin','active',NULL),
      (10,2,'member','active',NULL),
      (20,2,'member','active',NULL),
      (10,3,'member','active',NULL),
      (20,3,'member','active',NULL),
      (10,4,'member','active',NULL),
      (10,5,'member','active',NULL),
      (10,6,'member','active',NULL),
      (10,7,'member','revoked','2026-09-01 00:00:00');
    INSERT INTO organization_ai_quota_policies
      (org_id,policy_version,monthly_limit,changed_by,reason,source) VALUES
      (10,1,NULL,NULL,NULL,'migration_backfill'),
      (20,1,NULL,NULL,NULL,'migration_backfill');
  `);

  if (withTenantLedger) {
    db.exec(`
      INSERT INTO token_usage (
        org_id,user_id,model,prompt_tokens,completion_tokens,total_tokens,endpoint
      ) VALUES
        (10,1,'deepseek-chat',500,500,1000,'admin_seed'),
        (10,2,'deepseek-chat',10,5,15,'ai_chat'),
        (10,2,'deepseek-chat',15,10,25,'proposal_generate'),
        (20,2,'deepseek-chat',45,45,90,'ai_chat'),
        (20,3,'deepseek-chat',30,20,50,'ai_chat');
    `);
  }

  return db;
}

function quotaError(statusCode, code) {
  return (error) => {
    assert.ok(error instanceof AIQuotaServiceError);
    assert.equal(error.statusCode, statusCode);
    assert.equal(error.code, code);
    return true;
  };
}

function latestAudit(db, action) {
  return db.prepare(`
    SELECT user_id,action,module,details,ip_address
    FROM activity_log
    WHERE action=?
    ORDER BY id DESC
    LIMIT 1
  `).get(action);
}

function deniedAuditCount(db) {
  return Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM activity_log
    WHERE action='ai_quota_denied'
  `).get().count);
}

test('live SQLite user, active organization membership, and tenant ledger determine allowance', () => {
  const db = openDatabase();
  try {
    assert.deepEqual(readLivePolicy(db, {
      organizationId: 10,
      userId: 2,
      requestId: 'quota-live-1'
    }), {
      organization_id: 10,
      user_id: 2,
      period: 'legacy_lifetime',
      used: 40,
      limit: 100,
      remaining: 60,
      status: 'active'
    });

    db.prepare('UPDATE users SET api_quota=50 WHERE id=2').run();
    db.prepare(`
      INSERT INTO token_usage (
        org_id,user_id,model,prompt_tokens,completion_tokens,total_tokens,endpoint
      ) VALUES (10,2,'deepseek-chat',3,2,5,'ai_chat')
    `).run();
    const refreshed = readLivePolicy(db, {
      organizationId: 10,
      userId: 2,
      requestId: 'quota-live-2'
    });
    assert.equal(refreshed.limit, 50);
    assert.equal(refreshed.used, 45);
    assert.equal(refreshed.remaining, 5);
  } finally {
    db.close();
  }
});

test('usage in organization A does not consume organization B quota', () => {
  const db = openDatabase();
  try {
    const organizationA = readLivePolicy(db, { organizationId: 10, userId: 2 });
    const organizationB = readLivePolicy(db, { organizationId: 20, userId: 2 });
    assert.deepEqual(
      [organizationA.used, organizationA.remaining],
      [40, 60]
    );
    assert.deepEqual(
      [organizationB.used, organizationB.remaining],
      [90, 10]
    );
  } finally {
    db.close();
  }
});

test('quota zero denies an ordinary user and persists an ai_quota_denied audit', () => {
  const db = openDatabase();
  try {
    assert.throws(() => assertAdmission(db, {
      organizationId: 10,
      userId: 5,
      requestId: 'quota-disabled-request',
      ipAddress: '127.0.0.1'
    }), quotaError(429, 'AI_QUOTA_DISABLED'));

    const audit = latestAudit(db, 'ai_quota_denied');
    assert.equal(audit.user_id, 5);
    assert.equal(audit.module, 'ai_quota');
    assert.equal(audit.ip_address, '127.0.0.1');
    assert.deepEqual(JSON.parse(audit.details), {
      schema_version: 1,
      organization_id: 10,
      target_user_id: 5,
      period: 'legacy_lifetime',
      used_tokens: 0,
      limit_tokens: 0,
      remaining_tokens: 0,
      reason_code: 'AI_QUOTA_DISABLED',
      endpoint: null,
      request_id: 'quota-disabled-request'
    });
  } finally {
    db.close();
  }
});

test('used greater than or equal to limit denies with a bounded audit', () => {
  const db = openDatabase();
  try {
    assert.throws(() => assertAdmission(db, {
      organizationId: 20,
      userId: 3,
      requestId: 'x'.repeat(10000),
      ipAddress: '127.0.0.2'
    }), quotaError(429, 'AI_QUOTA_EXCEEDED'));

    const audit = latestAudit(db, 'ai_quota_denied');
    assert.ok(Buffer.byteLength(audit.details, 'utf8') <= 4096);
    const details = JSON.parse(audit.details);
    assert.deepEqual(Object.keys(details).sort(), [
      'endpoint',
      'limit_tokens',
      'organization_id',
      'period',
      'reason_code',
      'remaining_tokens',
      'request_id',
      'schema_version',
      'target_user_id',
      'used_tokens'
    ]);
    assert.equal(details.request_id, null);
    assert.equal(details.used_tokens, 50);
    assert.equal(details.limit_tokens, 50);
    assert.equal(details.remaining_tokens, 0);
    assert.equal(details.reason_code, 'AI_QUOTA_EXCEEDED');
  } finally {
    db.close();
  }
});

test('an active platform administrator is explicitly exempt', () => {
  const db = openDatabase();
  try {
    const result = assertAdmission(db, {
      organizationId: 10,
      userId: 1,
      requestId: 'quota-admin-exempt'
    });
    assert.equal(result.status, 'exempt');
    assert.equal(result.period, 'legacy_lifetime');
    assert.equal(deniedAuditCount(db), 0);
  } finally {
    db.close();
  }
});

test('an inactive user fails closed when quota policy is evaluated', () => {
  const db = openDatabase();
  try {
    assert.throws(
      () => readLivePolicy(db, { organizationId: 10, userId: 4 }),
      quotaError(503, 'AI_QUOTA_POLICY_UNAVAILABLE')
    );
    assert.equal(deniedAuditCount(db), 0);
  } finally {
    db.close();
  }
});

test('a user without an active organization membership fails closed', () => {
  const db = openDatabase();
  try {
    assert.throws(
      () => readLivePolicy(db, { organizationId: 10, userId: 7 }),
      quotaError(503, 'AI_QUOTA_POLICY_UNAVAILABLE')
    );
    assert.equal(deniedAuditCount(db), 0);
  } finally {
    db.close();
  }
});

test('an invalid persisted quota fails closed', () => {
  const db = openDatabase();
  try {
    assert.throws(
      () => readLivePolicy(db, { organizationId: 10, userId: 6 }),
      quotaError(503, 'AI_QUOTA_POLICY_UNAVAILABLE')
    );
    assert.equal(deniedAuditCount(db), 0);
  } finally {
    db.close();
  }
});

test('a token ledger without organization ownership fails closed', () => {
  const db = openDatabase({ withTenantLedger: false });
  try {
    assert.throws(
      () => readLivePolicy(db, { organizationId: 10, userId: 2 }),
      quotaError(503, 'AI_QUOTA_POLICY_UNAVAILABLE')
    );
    assert.equal(deniedAuditCount(db), 0);
  } finally {
    db.close();
  }
});

test('projectMembershipUsage returns tenant-specific legacy lifetime projections', () => {
  const db = openDatabase();
  try {
    const projected = projectMembershipUsage(db, { userIds: [2, 3] })
      .sort((left, right) => (
        left.organization_id - right.organization_id || left.user_id - right.user_id
      ));
    assert.equal(projected.length, 4);
    assert.deepEqual(projected.map((row) => ({
      organization_id: row.organization_id,
      user_id: row.user_id,
      period: row.period,
      used: row.used,
      limit: row.limit,
      remaining: row.remaining,
      status: row.status
    })), [
      {
        organization_id: 10,
        user_id: 2,
        period: 'legacy_lifetime',
        used: 40,
        limit: 100,
        remaining: 60,
        status: 'active'
      },
      {
        organization_id: 10,
        user_id: 3,
        period: 'legacy_lifetime',
        used: 0,
        limit: 50,
        remaining: 50,
        status: 'active'
      },
      {
        organization_id: 20,
        user_id: 2,
        period: 'legacy_lifetime',
        used: 90,
        limit: 100,
        remaining: 10,
        status: 'active'
      },
      {
        organization_id: 20,
        user_id: 3,
        period: 'legacy_lifetime',
        used: 50,
        limit: 50,
        remaining: 0,
        status: 'exhausted'
      }
    ]);
  } finally {
    db.close();
  }
});

test('normalizeQuota accepts safe non-negative integers', () => {
  for (const value of [0, 1, 50000, Number.MAX_SAFE_INTEGER]) {
    assert.equal(normalizeQuota(value), value);
  }
});

test('normalizeQuota rejects every other representation', () => {
  for (const value of [
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    '0',
    '50000',
    '',
    null,
    undefined,
    true
  ]) {
    assert.throws(
      () => normalizeQuota(value),
      quotaError(400, 'AI_QUOTA_INVALID'),
      `expected ${String(value)} to be rejected`
    );
  }
});

test('organization monthly quota uses only the current UTC calendar month', () => {
  const db = openDatabase();
  try {
    db.prepare('UPDATE token_usage SET created_at=?').run('2026-09-21 10:00:00');
    db.prepare(`
      INSERT INTO token_usage
        (org_id,user_id,model,prompt_tokens,completion_tokens,total_tokens,endpoint,created_at)
      VALUES (10,2,'deepseek-chat',400,599,999,'prior_month','2026-08-31 23:59:59')
    `).run();
    db.prepare('UPDATE organization_ai_quota_policies SET monthly_limit=1100 WHERE org_id=10').run();
    const projection = readOrganizationQuotaProjection(
      db,
      { organizationId: 10 },
      Date.UTC(2026, 8, 21, 12, 0, 0)
    );
    assert.deepEqual(projection, {
      organization_id: 10,
      period: 'utc_calendar_month',
      period_key: '2026-09',
      period_start: '2026-09-01T00:00:00Z',
      period_end: '2026-10-01T00:00:00Z',
      used: 1040,
      limit: 1100,
      remaining: 60,
      overage_tokens: 0,
      utilization_percent: 94.55,
      status: 'active',
      policy_version: 1
    });
  } finally {
    db.close();
  }
});

test('organization monthly shared quota denies before personal quota and audits its scope', () => {
  const db = openDatabase();
  try {
    db.prepare('UPDATE token_usage SET created_at=?').run('2026-09-21 10:00:00');
    db.prepare('UPDATE organization_ai_quota_policies SET monthly_limit=40 WHERE org_id=10').run();
    assert.throws(() => assertAdmission(db, {
      organizationId: 10,
      userId: 2,
      endpoint: 'ai_chat',
      requestId: 'organization-quota-denial'
    }, Date.UTC(2026, 8, 21, 12, 0, 0)), quotaError(429, 'AI_ORGANIZATION_QUOTA_EXCEEDED'));
    const details = JSON.parse(latestAudit(db, 'ai_quota_denied').details);
    assert.equal(details.schema_version, 2);
    assert.equal(details.scope, 'organization_monthly');
    assert.equal(details.organization_id, 10);
    assert.equal(details.period_key, '2026-09');
    assert.equal(details.used_tokens, 1040);
    assert.equal(details.limit_tokens, 40);
    assert.equal(details.reason_code, 'AI_ORGANIZATION_QUOTA_EXCEEDED');
  } finally {
    db.close();
  }
});

test('platform admin break-glass validates organization policy and audits exhausted admission', () => {
  const db = openDatabase();
  try {
    db.prepare('UPDATE organization_ai_quota_policies SET monthly_limit=0 WHERE org_id=10').run();
    const decision = assertAdmission(db, {
      organizationId: 10,
      userId: 1,
      requestId: 'admin-break-glass'
    }, Date.UTC(2026, 8, 21, 12, 0, 0));
    assert.equal(decision.status, 'exempt');
    assert.equal(deniedAuditCount(db), 0);
    const audit = latestAudit(db, 'ai_quota_break_glass_admitted');
    assert.equal(audit.user_id, 1);
    assert.equal(audit.module, 'ai_quota');
    const details = JSON.parse(audit.details);
    assert.equal(details.organization_id, 10);
    assert.equal(details.period_key, '2026-09');
    assert.equal(details.organization_status, 'disabled');
    assert.equal(details.request_id, 'admin-break-glass');
  } finally {
    db.close();
  }
});

test('organization quota projection supports unlimited and multiple organizations', () => {
  const db = openDatabase();
  try {
    db.prepare('UPDATE token_usage SET created_at=?').run('2026-09-21 10:00:00');
    const rows = projectOrganizationQuotas(db, {
      organizationIds: [10, 20]
    }, Date.UTC(2026, 8, 21, 12, 0, 0));
    assert.deepEqual(rows.map((row) => [row.organization_id, row.used, row.limit, row.status]), [
      [10, 1040, null, 'unlimited'],
      [20, 140, null, 'unlimited']
    ]);
  } finally {
    db.close();
  }
});

test('organization monthly limit normalization and audited versioned updates are strict', () => {
  assert.equal(normalizeOrganizationMonthlyLimit(null), null);
  assert.equal(normalizeOrganizationMonthlyLimit(0), 0);
  assert.equal(normalizeOrganizationMonthlyLimit(5000), 5000);
  for (const value of [-1, 1.5, '5000', undefined, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => normalizeOrganizationMonthlyLimit(value),
      quotaError(400, 'AI_ORGANIZATION_QUOTA_INVALID')
    );
  }

  const db = openDatabase();
  try {
    for (const expectedVersion of [true, '1', 1.5]) {
      assert.throws(() => updateOrganizationMonthlyQuota(db, {
        actorUserId: 2,
        organizationId: 10,
        monthlyLimit: 5000,
        expectedVersion,
        reason: 'CAS version must be a numeric integer'
      }), quotaError(400, 'AI_ORGANIZATION_QUOTA_INVALID'));
    }
    assert.throws(() => updateOrganizationMonthlyQuota(db, {
      actorUserId: 2,
      organizationId: 10,
      monthlyLimit: 5000,
      expectedVersion: 1,
      reason: 'Forbidden update'
    }), quotaError(403, 'AI_ORGANIZATION_QUOTA_UPDATE_FORBIDDEN'));
    const updated = updateOrganizationMonthlyQuota(db, {
      actorUserId: 1,
      organizationId: 10,
      monthlyLimit: 5000,
      expectedVersion: 1,
      reason: 'Approved monthly allocation',
      requestId: 'organization-quota-update',
      ipAddress: '127.0.0.8'
    }, Date.UTC(2026, 8, 21, 12, 0, 0));
    assert.equal(updated.limit, 5000);
    assert.equal(updated.policy_version, 2);
    assert.equal(updated.changed, true);
    assert.throws(() => updateOrganizationMonthlyQuota(db, {
      actorUserId: 1,
      organizationId: 10,
      monthlyLimit: 6000,
      expectedVersion: 1,
      reason: 'Stale update'
    }), quotaError(409, 'AI_ORGANIZATION_QUOTA_VERSION_CONFLICT'));
    const audit = latestAudit(db, 'organization_ai_monthly_quota_changed');
    assert.equal(audit.user_id, 1);
    assert.equal(audit.ip_address, '127.0.0.8');
    assert.deepEqual(JSON.parse(audit.details), {
      schema_version: 1,
      actor_user_id: 1,
      organization_id: 10,
      period: 'utc_calendar_month',
      before: { monthly_limit: null, policy_version: 1 },
      after: { monthly_limit: 5000, policy_version: 2 },
      reason: 'Approved monthly allocation',
      request_id: 'organization-quota-update'
    });
  } finally {
    db.close();
  }
});

test('recordUsageOrThrow maps token ledger persistence failure to a 503 service error', () => {
  const db = openDatabase();
  try {
    const before = db.prepare('SELECT COUNT(*) AS count FROM token_usage').get().count;
    db.exec(`
      CREATE TRIGGER fail_ai_usage_accounting
      BEFORE INSERT ON token_usage
      BEGIN SELECT RAISE(ABORT,'forced token ledger failure'); END;
    `);
    assert.throws(() => recordUsageOrThrow(db, {
      organizationId: 10,
      userId: 2,
      model: 'deepseek-chat',
      promptTokens: 2,
      completionTokens: 3,
      totalTokens: 5,
      endpoint: 'ai_chat'
    }), quotaError(503, 'AI_USAGE_ACCOUNTING_FAILED'));
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM token_usage').get().count,
      before
    );
  } finally {
    db.close();
  }
});

test('recordUsageOrThrow rejects missing, zero, and inconsistent successful provider usage', () => {
  const db = openDatabase();
  try {
    const base = {
      organizationId: 10,
      userId: 2,
      model: 'deepseek-chat',
      endpoint: 'ai_chat'
    };
    for (const usage of [
      {},
      { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      { promptTokens: 60, completionTokens: 40, totalTokens: 0 },
      { promptTokens: 60, completionTokens: 40, totalTokens: 101 }
    ]) {
      assert.throws(
        () => recordUsageOrThrow(db, Object.assign({}, base, usage)),
        quotaError(503, 'AI_USAGE_ACCOUNTING_FAILED')
      );
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM token_usage').get().count, 5);
  } finally {
    db.close();
  }
});

test('recordUsageOrThrow permits an explicit zero-usage provider failure audit', () => {
  const db = openDatabase();
  try {
    const recorded = recordUsageOrThrow(db, {
      organizationId: 10,
      userId: 2,
      model: 'deepseek-chat',
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      endpoint: 'ai_chat_provider_failed',
      allowZeroUsage: true
    });
    assert.ok(recorded.id > 0);
    assert.equal(recorded.totalTokens, 0);
  } finally {
    db.close();
  }
});

test('writeQuotaUpdateAuditInTransaction records before, after, and request id', () => {
  const db = openDatabase();
  try {
    db.transaction(() => {
      const before = db.prepare('SELECT api_quota FROM users WHERE id=2').get().api_quota;
      db.prepare('UPDATE users SET api_quota=250 WHERE id=2').run();
      const after = db.prepare('SELECT api_quota FROM users WHERE id=2').get().api_quota;
      writeQuotaUpdateAuditInTransaction(db, {
        actorUserId: 1,
        targetUserId: 2,
        before,
        after,
        requestId: 'quota-update-request-1',
        ipAddress: '127.0.0.3'
      });
    }).immediate();

    const audit = latestAudit(db, 'admin_update_ai_quota');
    assert.equal(audit.user_id, 1);
    assert.equal(audit.module, 'ai_quota');
    assert.equal(audit.ip_address, '127.0.0.3');
    assert.deepEqual(JSON.parse(audit.details), {
      schema_version: 1,
      actor_user_id: 1,
      target_user_id: 2,
      period: 'legacy_lifetime',
      request_id: 'quota-update-request-1',
      before: { api_quota: 100 },
      after: { api_quota: 250 }
    });
  } finally {
    db.close();
  }
});

test('updateUserQuota requires a live platform admin and commits one audited change', () => {
  const db = openDatabase();
  try {
    assert.throws(() => updateUserQuota(db, {
      actorUserId: 2,
      userId: 3,
      quota: 75,
      requestId: 'quota-update-forbidden'
    }), quotaError(403, 'AI_QUOTA_UPDATE_FORBIDDEN'));
    assert.equal(db.prepare('SELECT api_quota FROM users WHERE id=3').get().api_quota, 50);

    const result = updateUserQuota(db, {
      actorUserId: 1,
      userId: 3,
      quota: 75,
      requestId: 'quota-update-allowed',
      ipAddress: '127.0.0.4'
    });
    assert.deepEqual(result, {
      user_id: 3,
      period: 'legacy_lifetime',
      limit: 75,
      status: 'active',
      changed: true
    });
    assert.equal(db.prepare('SELECT api_quota FROM users WHERE id=3').get().api_quota, 75);
    const audit = latestAudit(db, 'admin_update_ai_quota');
    assert.equal(audit.user_id, 1);
    assert.equal(audit.ip_address, '127.0.0.4');
    assert.equal(JSON.parse(audit.details).request_id, 'quota-update-allowed');
  } finally {
    db.close();
  }
});

test('updateUserQuota returns the live exhausted or inactive state after the update', () => {
  const db = openDatabase();
  try {
    const exhausted = updateUserQuota(db, {
      actorUserId: 1,
      userId: 3,
      quota: 40,
      requestId: 'quota-update-exhausted'
    });
    assert.equal(exhausted.status, 'exhausted');

    const inactive = updateUserQuota(db, {
      actorUserId: 1,
      userId: 4,
      quota: 200,
      requestId: 'quota-update-inactive'
    });
    assert.equal(inactive.status, 'inactive');
  } finally {
    db.close();
  }
});

test('updateUserQuota rolls back the limit when its privileged audit cannot persist', () => {
  const db = openDatabase();
  try {
    db.exec(`
      CREATE TRIGGER fail_ai_quota_update_audit
      BEFORE INSERT ON activity_log
      WHEN NEW.action='admin_update_ai_quota'
      BEGIN SELECT RAISE(ABORT,'forced quota audit failure'); END;
    `);
    assert.throws(() => updateUserQuota(db, {
      actorUserId: 1,
      userId: 2,
      quota: 250,
      requestId: 'quota-update-audit-failure'
    }), quotaError(500, 'AI_QUOTA_AUDIT_FAILED'));
    assert.equal(db.prepare('SELECT api_quota FROM users WHERE id=2').get().api_quota, 100);
  } finally {
    db.close();
  }
});

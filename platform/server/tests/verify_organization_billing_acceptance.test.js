'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const migration = require('../migrations/031_organization_billing_statements');
const { createOrganizationBillingService } = require('../services/organization_billing_service');
const {
  resolveAcceptanceActor,
  runAcceptance
} = require('../scripts/verify_organization_billing_acceptance');

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-billing-acceptance-'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,username TEXT NOT NULL,role TEXT NOT NULL,is_active INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE organizations (id INTEGER PRIMARY KEY,code TEXT NOT NULL,name TEXT NOT NULL) STRICT;
    CREATE TABLE organization_memberships (
      org_id INTEGER NOT NULL,user_id INTEGER NOT NULL,role_code TEXT NOT NULL,status TEXT NOT NULL,
      PRIMARY KEY (org_id,user_id)
    ) STRICT;
    CREATE TABLE organization_authority (
      org_id INTEGER PRIMARY KEY,owner_user_id INTEGER NOT NULL,created_by INTEGER NOT NULL,
      updated_by INTEGER NOT NULL,version INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,org_id INTEGER NOT NULL,user_id INTEGER NOT NULL,
      model TEXT NOT NULL,prompt_tokens INTEGER NOT NULL,completion_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,endpoint TEXT,created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,action TEXT NOT NULL,module TEXT,
      details TEXT,ip_address TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) STRICT;
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,token TEXT UNIQUE NOT NULL,
      ip_address TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,expires_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO users VALUES
      (1,'derrick','admin',1),
      (2,'member','user',1),
      (3,'release-smoke','admin',1);
    INSERT INTO organizations VALUES (10,'alpha','Alpha');
    INSERT INTO organization_memberships VALUES
      (10,1,'org_admin','active'),
      (10,2,'member','active'),
      (10,3,'org_admin','active');
    INSERT INTO organization_authority VALUES (10,1,1,1,1);
  `);
  migration.apply(db);
  return {
    db,
    directory,
    evidencePath: path.join(directory, 'acceptance.json'),
    close() {
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

test('billing acceptance resolves only the dedicated release smoke actor', () => {
  const state = fixture();
  try {
    assert.deepEqual(resolveAcceptanceActor(state.db), {
      userId: 3,
      organizationId: 10,
      role: 'admin',
      username: 'release-smoke'
    });
    state.db.prepare('DELETE FROM organization_memberships WHERE user_id=3').run();
    state.db.prepare('DELETE FROM users WHERE id=3').run();
    assert.throws(
      () => resolveAcceptanceActor(state.db),
      /dedicated release smoke/i
    );
  } finally {
    state.close();
  }
});

test('production billing acceptance proves HTTP contract, isolated-clone close, and exact semantic restore', async () => {
  const state = fixture();
  try {
    const service = createOrganizationBillingService(state.db, { now: () => new Date('2026-09-21T08:00:00Z') });
    let calls = 0;
    const evidence = await runAcceptance({
      db: state.db,
      actor: { userId: 3, organizationId: 10, role: 'admin', username: 'release-smoke' },
      jwtSecret: 'acceptance-test-secret',
      runId: 'c'.repeat(32),
      evidencePath: state.evidencePath,
      baseUrl: 'http://127.0.0.1:3002',
      now: () => new Date('2026-09-21T08:00:00Z'),
      httpGet: async (url) => {
        calls += 1;
        if (url.includes('organizationId=')) {
          return { status: 400, body: { code: 'ORGANIZATION_BILLING_INVALID' } };
        }
        const projection = service.projectOrganizationBilling({ organizationId: 10, month: '2026-10' });
        return { status: 200, body: { billing: projection } };
      }
    });
    assert.equal(calls, 2);
    assert.equal(evidence.http.adminRead, true);
    assert.equal(evidence.http.tenantOverrideDenied, true);
    assert.equal(evidence.isolatedClose.isolatedClone, true);
    assert.equal(evidence.isolatedClose.sourceUnchanged, true);
    assert.equal(evidence.isolatedClose.idempotentReplay, true);
    assert.equal(evidence.isolatedClose.updateBlocked, true);
    assert.equal(evidence.isolatedClose.deleteBlocked, true);
    assert.equal(evidence.isolatedClose.integrityCheck, 'ok');
    assert.equal(evidence.restored.semanticMatch, true);
    assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM organization_billing_statements').get().count, 0);
    assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
    assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM organization_billing_policies WHERE org_id=10').get().count, 3);
    assert.equal(JSON.parse(fs.readFileSync(state.evidencePath, 'utf8')).runId, 'c'.repeat(32));
  } finally {
    state.close();
  }
});

test('failed billing acceptance restores policy, removes session, and leaves no evidence or statement', async () => {
  const state = fixture();
  try {
    await assert.rejects(
      runAcceptance({
        db: state.db,
        actor: { userId: 3, organizationId: 10, role: 'admin', username: 'release-smoke' },
        jwtSecret: 'acceptance-test-secret',
        runId: 'd'.repeat(32),
        evidencePath: state.evidencePath,
        baseUrl: 'http://127.0.0.1:3002',
        now: () => new Date('2026-09-21T08:00:00Z'),
        httpGet: async () => ({ status: 500, body: { code: 'WRONG' } })
      }),
      /Billing HTTP read contract/
    );
    const service = createOrganizationBillingService(state.db, { now: () => new Date('2026-09-21T08:00:00Z') });
    const restored = service.projectOrganizationBilling({ organizationId: 10, month: '2026-10' });
    assert.equal(restored.policy.billing_enabled, false);
    assert.equal(restored.charges.total_cents, 0);
    assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM organization_billing_statements').get().count, 0);
    assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
    assert.equal(fs.existsSync(state.evidencePath), false);
  } finally {
    state.close();
  }
});

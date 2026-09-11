'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  AdminTenantDirectoryServiceError,
  createAdminTenantDirectoryService
} = require('../services/admin_tenant_directory_service');

function openFixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL,
      department TEXT,
      email TEXT,
      api_quota INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      last_login TEXT,
      is_active INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE organizations (
      id INTEGER PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE organization_memberships (
      org_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role_code TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      PRIMARY KEY(org_id,user_id),
      FOREIGN KEY(org_id) REFERENCES organizations(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    ) STRICT;
    CREATE TABLE teams (
      id INTEGER PRIMARY KEY,
      org_id INTEGER NOT NULL,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(org_id,id),
      FOREIGN KEY(org_id) REFERENCES organizations(id)
    ) STRICT;
    CREATE TABLE team_memberships (
      org_id INTEGER NOT NULL,
      team_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role_code TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      PRIMARY KEY(org_id,team_id,user_id),
      FOREIGN KEY(org_id,team_id) REFERENCES teams(org_id,id),
      FOREIGN KEY(org_id,user_id) REFERENCES organization_memberships(org_id,user_id)
    ) STRICT;
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

    INSERT INTO users (id,username,display_name,role,department,email,api_quota,created_at,last_login,is_active) VALUES
      (1,'derrick','Derrick Admin','admin','Management','derrick@example.com',200000,'2025-12-01 00:00:00','2026-09-10 08:00:00',1),
      (2,'alice','Alice Zhang','user','Sales','alice@example.com',50000,'2026-01-02 00:00:00','2026-09-09 08:00:00',1),
      (3,'bob','Bob Chen','user','Creative','bob@example.com',50000,'2026-01-03 00:00:00',NULL,0),
      (4,'carol','Carol Wu','user','Operations','carol@example.com',50000,'2026-02-03 00:00:00','2026-09-08 08:00:00',1);
    INSERT INTO organizations (id,code,name,created_at) VALUES
      (10,'alpha-market','Alpha Market','2026-01-01 00:00:00'),
      (20,'beta-labs','Beta Labs','2026-02-01 00:00:00');
    INSERT INTO organization_memberships
      (org_id,user_id,role_code,status,created_at,revoked_at) VALUES
      (10,1,'org_admin','active','2026-01-01 00:00:00',NULL),
      (10,2,'member','active','2026-01-02 00:00:00',NULL),
      (10,3,'member','revoked','2026-01-03 00:00:00','2026-03-01 00:00:00'),
      (20,1,'org_admin','active','2026-02-01 00:00:00',NULL),
      (20,2,'member','active','2026-02-02 00:00:00',NULL),
      (20,4,'member','active','2026-02-03 00:00:00',NULL);
    INSERT INTO teams (id,org_id,code,name,created_at) VALUES
      (101,10,'alpha-sales','Alpha Sales','2026-01-01 00:00:00'),
      (102,10,'alpha-creative','Alpha Creative','2026-01-01 00:00:00'),
      (201,20,'beta-operations','Beta Operations','2026-02-01 00:00:00');
    INSERT INTO team_memberships
      (org_id,team_id,user_id,role_code,status,created_at,revoked_at) VALUES
      (10,101,1,'team_lead','active','2026-01-01 00:00:00',NULL),
      (10,101,2,'member','active','2026-01-02 00:00:00',NULL),
      (10,102,2,'team_lead','active','2026-01-02 00:00:00',NULL),
      (10,102,3,'member','revoked','2026-01-03 00:00:00','2026-03-01 00:00:00'),
      (20,201,1,'team_lead','active','2026-02-01 00:00:00',NULL),
      (20,201,2,'member','active','2026-02-02 00:00:00',NULL),
      (20,201,4,'member','active','2026-02-03 00:00:00',NULL);
  `);
  return db;
}

function admin() {
  return { id: 1, role: 'admin' };
}

test('organization directory searches membership identity, paginates, and persists redacted audits', () => {
  const db = openFixture();
  try {
    const service = createAdminTenantDirectoryService(db);
    const first = service.listOrganizations({
      actor: admin(),
      requestId: 'tenant-list-1',
      ipAddress: '127.0.0.1',
      query: { q: 'alice', limit: '1' }
    });
    assert.deepEqual(first, {
      organizations: [{
        id: 10,
        code: 'alpha-market',
        name: 'Alpha Market',
        created_at: '2026-01-01 00:00:00',
        team_count: 2,
        active_member_count: 2,
        revoked_member_count: 1
      }],
      page: { limit: 1, next_cursor: 10, has_more: true }
    });

    const second = service.listOrganizations({
      actor: admin(),
      requestId: 'tenant-list-2',
      query: { q: 'alice', limit: 1, cursor: first.page.next_cursor }
    });
    assert.equal(second.organizations[0].id, 20);
    assert.deepEqual(second.page, { limit: 1, next_cursor: null, has_more: false });

    const audits = db.prepare(`
      SELECT action,module,details,ip_address
      FROM activity_log
      ORDER BY id
    `).all();
    assert.deepEqual(audits.map((row) => [row.action, row.module]), [
      ['admin_list_organizations', 'tenant_admin'],
      ['admin_list_organizations', 'tenant_admin']
    ]);
    const details = JSON.parse(audits[0].details);
    assert.equal(details.actor_user_id, 1);
    assert.equal(details.request_id, 'tenant-list-1');
    assert.deepEqual(details.filter_names, ['limit', 'q']);
    assert.deepEqual(details.target_organization_ids, [10]);
    assert.equal(Object.hasOwn(details, 'filter_sha256'), false);
    assert.equal(audits[0].ip_address, '127.0.0.1');
    assert.equal(audits[0].details.includes('alice'), false);
  } finally {
    db.close();
  }
});

test('member directory keeps multi-team roles, supports status and team search, and avoids duplicate users', () => {
  const db = openFixture();
  try {
    const service = createAdminTenantDirectoryService(db);
    const active = service.listOrganizationMembers({
      actor: admin(),
      organizationId: 10,
      requestId: 'tenant-members-active',
      query: { q: 'creative', status: 'active', limit: 20 }
    });
    assert.equal(active.organization.id, 10);
    assert.equal(active.members.length, 1);
    assert.equal(active.members[0].user_id, 2);
    assert.equal(active.members[0].organization_role, 'member');
    assert.equal(active.members[0].membership_status, 'active');
    assert.deepEqual(active.members[0].teams.map((team) => ({
      id: team.id,
      role: team.role_code,
      status: team.status
    })), [
      { id: 101, role: 'member', status: 'active' },
      { id: 102, role: 'team_lead', status: 'active' }
    ]);

    const platformRole = service.listOrganizationMembers({
      actor: admin(),
      organizationId: 10,
      requestId: 'tenant-members-platform-role',
      query: { q: 'user', status: 'active' }
    });
    assert.deepEqual(platformRole.members.map((member) => member.user_id), [2]);

    const revoked = service.listOrganizationMembers({
      actor: admin(),
      organizationId: '10',
      requestId: 'tenant-members-revoked',
      query: { status: 'revoked' }
    });
    assert.deepEqual(revoked.members.map((member) => member.user_id), [3]);
    assert.equal(revoked.members[0].teams[0].status, 'revoked');

    const audit = db.prepare(`
      SELECT details FROM activity_log
      WHERE action='admin_list_organization_members'
      ORDER BY id LIMIT 1
    `).get();
    const details = JSON.parse(audit.details);
    assert.deepEqual(details.target_organization_ids, [10]);
    assert.deepEqual(details.target_user_ids, [2]);
    assert.deepEqual(details.filter_names, ['limit', 'q', 'status']);
    assert.equal(audit.details.includes('creative'), false);
  } finally {
    db.close();
  }
});

test('user entitlement directory searches stable roles, paginates, and audits only filter names', () => {
  const db = openFixture();
  try {
    const service = createAdminTenantDirectoryService(db);
    const first = service.listUsers({
      actor: admin(),
      requestId: 'tenant-users-1',
      ipAddress: '127.0.0.1',
      query: { q: 'alpha', role: 'team_lead', status: 'active', limit: '1' }
    });
    assert.equal(first.users.length, 1);
    assert.equal(first.users[0].id, 1);
    assert.deepEqual(first.users[0].access_roles, ['platform_admin', 'org_admin', 'team_lead']);
    assert.deepEqual(first.users[0].organizations.map((organization) => ({
      id: organization.id,
      role: organization.role_code,
      status: organization.status,
      teams: organization.teams.map((team) => [team.id, team.role_code, team.status])
    })), [
      { id: 10, role: 'org_admin', status: 'active', teams: [[101, 'team_lead', 'active']] },
      { id: 20, role: 'org_admin', status: 'active', teams: [[201, 'team_lead', 'active']] }
    ]);
    assert.deepEqual(first.page, { limit: 1, next_cursor: 1, has_more: true });

    const second = service.listUsers({
      actor: admin(),
      requestId: 'tenant-users-2',
      query: { q: 'alpha', role: 'team_lead', status: 'active', limit: 1, cursor: 1 }
    });
    assert.deepEqual(second.users.map((user) => user.id), [2]);
    assert.deepEqual(second.users[0].access_roles, ['team_lead', 'member']);
    assert.deepEqual(second.page, { limit: 1, next_cursor: null, has_more: false });

    const inactive = service.listUsers({
      actor: admin(),
      requestId: 'tenant-users-inactive',
      query: { q: 'bob@example.com', status: 'inactive' }
    });
    assert.deepEqual(inactive.users.map((user) => user.id), [3]);
    assert.equal(inactive.users[0].organizations[0].status, 'revoked');

    const audit = db.prepare(`
      SELECT action,module,details,ip_address
      FROM activity_log
      WHERE action='admin_list_users'
      ORDER BY id LIMIT 1
    `).get();
    assert.equal(audit.module, 'tenant_admin');
    assert.equal(audit.ip_address, '127.0.0.1');
    const details = JSON.parse(audit.details);
    assert.deepEqual(details.filter_names, ['limit', 'q', 'role', 'status']);
    assert.deepEqual(details.target_user_ids, [1]);
    assert.deepEqual(details.target_organization_ids, [10, 20]);
    assert.equal(audit.details.includes('alpha'), false);
    assert.equal(Object.hasOwn(details, 'filter_sha256'), false);
  } finally {
    db.close();
  }
});

test('directory rejects non-admin and malformed filters without creating an audit row', () => {
  const db = openFixture();
  try {
    const service = createAdminTenantDirectoryService(db);
    assert.throws(
      () => service.listOrganizations({ actor: { id: 2, role: 'user' }, query: {} }),
      (error) => error instanceof AdminTenantDirectoryServiceError &&
        error.statusCode === 403 && error.code === 'ADMIN_REQUIRED'
    );
    for (const query of [
      { q: 'x'.repeat(121) },
      { limit: 0 },
      { limit: 101 },
      { cursor: '01' }
    ]) {
      assert.throws(
        () => service.listOrganizations({ actor: admin(), query }),
        (error) => error instanceof AdminTenantDirectoryServiceError && error.statusCode === 400
      );
    }
    assert.throws(
      () => service.listOrganizationMembers({
        actor: admin(),
        organizationId: 10,
        query: { status: 'disabled' }
      }),
      (error) => error instanceof AdminTenantDirectoryServiceError &&
        error.statusCode === 400 && error.code === 'INVALID_TENANT_DIRECTORY_FILTER'
    );
    for (const query of [
      { status: 'disabled' },
      { role: 'owner' }
    ]) {
      assert.throws(
        () => service.listUsers({ actor: admin(), query }),
        (error) => error instanceof AdminTenantDirectoryServiceError &&
          error.statusCode === 400 && error.code === 'INVALID_TENANT_DIRECTORY_FILTER'
      );
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM activity_log').get().count, 0);
  } finally {
    db.close();
  }
});

test('directory fails closed when privileged read audit persistence is unavailable', () => {
  const db = openFixture();
  try {
    const service = createAdminTenantDirectoryService(db);
    db.exec(`
      CREATE TRIGGER fail_tenant_admin_audit
      BEFORE INSERT ON activity_log
      WHEN NEW.module='tenant_admin'
      BEGIN SELECT RAISE(ABORT,'forced tenant audit failure'); END;
    `);
    let result;
    assert.throws(
      () => {
        result = service.listOrganizations({ actor: admin(), query: {} });
      },
      (error) => error instanceof AdminTenantDirectoryServiceError &&
        error.statusCode === 500 && error.code === 'AUDIT_PERSISTENCE_FAILED'
    );
    assert.equal(result, undefined);
    assert.throws(
      () => service.listUsers({ actor: admin(), query: {} }),
      (error) => error instanceof AdminTenantDirectoryServiceError &&
        error.statusCode === 500 && error.code === 'AUDIT_PERSISTENCE_FAILED'
    );
  } finally {
    db.close();
  }
});

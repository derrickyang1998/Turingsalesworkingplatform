'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

function loadService() {
  try {
    return require('../services/organization_governance_service');
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') {
      assert.fail('organization governance service has not been implemented');
    }
    throw error;
  }
}

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
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_at TEXT,
      PRIMARY KEY(org_id,user_id)
    ) STRICT;
    CREATE TABLE teams (
      id INTEGER PRIMARY KEY,
      org_id INTEGER NOT NULL,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      UNIQUE(org_id,id)
    ) STRICT;
    CREATE TABLE team_memberships (
      org_id INTEGER NOT NULL,
      team_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role_code TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_at TEXT,
      PRIMARY KEY(org_id,team_id,user_id)
    ) STRICT;
    CREATE TABLE organization_member_policy (
      org_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      access_mode TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(org_id,user_id)
    ) STRICT;
    CREATE TABLE organization_authority (
      org_id INTEGER PRIMARY KEY,
      owner_user_id INTEGER NOT NULL,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) STRICT;
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      module TEXT,
      details TEXT,
      ip_address TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) STRICT;

    INSERT INTO users (id,username,display_name,role,department,is_active) VALUES
      (1,'platform','Platform Admin','admin','Leadership',1),
      (2,'owner','Company Owner','user','Leadership',1),
      (3,'administrator','Organization Admin','user','Operations',1),
      (4,'manager','Team Manager','user','Sales',1),
      (5,'member','Member User','user','Creative',1),
      (6,'readonly','Read Only User','user','Finance',1),
      (7,'alpha-admin','Alpha Admin','user','Operations',1),
      (8,'inactive','Inactive User','user','Sales',0);
    INSERT INTO organizations (id,code,name,created_at) VALUES
      (10,'alpha','Alpha','2026-01-01 00:00:00'),
      (20,'beta','Beta','2026-02-01 00:00:00'),
      (30,'gamma','Gamma','2026-03-01 00:00:00');
    INSERT INTO organization_memberships (org_id,user_id,role_code,status,revoked_at) VALUES
      (10,1,'org_admin','active',NULL),
      (10,3,'org_admin','active',NULL),
      (10,4,'member','active',NULL),
      (10,5,'member','active',NULL),
      (10,6,'member','active',NULL),
      (10,7,'org_admin','active',NULL),
      (20,2,'org_admin','active',NULL),
      (20,3,'org_admin','active',NULL),
      (20,4,'member','active',NULL),
      (20,5,'member','active',NULL),
      (30,5,'member','active',NULL),
      (30,8,'member','active',NULL);
    INSERT INTO organization_member_policy (org_id,user_id,access_mode)
      SELECT org_id,user_id,CASE WHEN org_id=10 AND user_id=6 THEN 'read_only' ELSE 'read_write' END
      FROM organization_memberships;
    INSERT INTO organization_authority (org_id,owner_user_id,created_by) VALUES
      (10,1,1),
      (20,2,1);
    INSERT INTO teams (id,org_id,code,name) VALUES
      (101,10,'alpha-main','Alpha Main'),
      (201,20,'beta-main','Beta Main');
    INSERT INTO team_memberships (org_id,team_id,user_id,role_code,status,revoked_at) VALUES
      (10,101,1,'team_lead','active',NULL),
      (10,101,3,'member','active',NULL),
      (10,101,4,'team_lead','active',NULL),
      (10,101,5,'member','active',NULL),
      (10,101,6,'member','active',NULL),
      (10,101,7,'member','active',NULL),
      (20,201,2,'member','active',NULL),
      (20,201,3,'member','active',NULL),
      (20,201,4,'team_lead','active',NULL),
      (20,201,5,'member','active',NULL);
    INSERT INTO sessions (user_id,token,expires_at) VALUES
      (3,'session-3','2030-01-01 00:00:00'),
      (4,'session-4','2030-01-01 00:00:00'),
      (5,'session-5','2030-01-01 00:00:00');
  `);
  return db;
}

function actor(id, role = 'user') {
  return { id, role };
}

test('projects all six server-owned access roles and a live organization access profile', () => {
  const db = openFixture();
  try {
    const { createOrganizationGovernanceService } = loadService();
    const service = createOrganizationGovernanceService(db);
    const cases = [
      [1, 10, 'company_owner', ['platform_admin', 'company_owner', 'administrator', 'manager', 'member']],
      [2, 20, 'company_owner', ['company_owner', 'administrator', 'member']],
      [3, 20, 'administrator', ['administrator', 'member']],
      [4, 20, 'manager', ['manager', 'member']],
      [5, 20, 'member', ['member']],
      [6, 10, 'read_only', ['read_only']]
    ];

    for (const [userId, organizationId, effectiveRole, accessRoles] of cases) {
      const projection = service.projectUserAccess({ userId, organizationId });
      assert.equal(projection.organization_access.effective_role, effectiveRole);
      assert.deepEqual(projection.access_roles, accessRoles);
      assert.equal(projection.organization_access.organization_id, organizationId);
    }

    db.prepare("UPDATE organization_member_policy SET access_mode='read_only' WHERE org_id=20 AND user_id=5").run();
    assert.equal(
      service.projectUserAccess({ userId: 5, organizationId: 20 }).organization_access.access_mode,
      'read_only'
    );
  } finally {
    db.close();
  }
});

test('lists only authorized organizations and members with contract fields and allowed actions', () => {
  const db = openFixture();
  try {
    const { createOrganizationGovernanceService } = loadService();
    const service = createOrganizationGovernanceService(db);

    const platformView = service.listOrganizations({
      actor: actor(1, 'admin'),
      requestId: 'organizations-platform',
      query: { limit: 2 }
    });
    assert.deepEqual(Object.keys(platformView), ['organizations', 'page']);
    assert.deepEqual(Object.keys(platformView.organizations[0]), [
      'id', 'code', 'name', 'created_at', 'team_count', 'active_member_count',
      'revoked_member_count', 'company_owner', 'allowed_actions'
    ]);
    assert.deepEqual(platformView.organizations.map((organization) => organization.id), [10, 20]);
    assert.deepEqual(platformView.page, { limit: 2, next_cursor: 20, has_more: true });
    assert.equal(platformView.organizations[0].allowed_actions.initialize_owner, false);

    const ownerView = service.listOrganizations({
      actor: actor(2),
      requestId: 'organizations-owner',
      query: {}
    });
    assert.deepEqual(ownerView.organizations.map((organization) => organization.id), [20]);

    const members = service.listMembers({
      actor: actor(2),
      organizationId: 20,
      requestId: 'members-owner',
      query: { limit: 20 }
    });
    assert.deepEqual(Object.keys(members), ['organization', 'members', 'page']);
    assert.deepEqual(Object.keys(members.organization), [
      'id', 'code', 'name', 'company_owner'
    ]);
    assert.deepEqual(Object.keys(members.members[0]), [
      'user_id', 'username', 'display_name', 'department', 'platform_role', 'is_active',
      'organization_role', 'membership_status', 'access_mode', 'effective_role',
      'is_company_owner', 'teams', 'allowed_actions'
    ]);
    const target = members.members.find((member) => member.user_id === 3);
    assert.equal(target.effective_role, 'administrator');
    assert.deepEqual(target.allowed_actions, {
      change_role: true,
      change_status: true,
      initialize_owner: false
    });
    const owner = members.members.find((member) => member.user_id === 2);
    assert.deepEqual(owner.allowed_actions, {
      change_role: false,
      change_status: false,
      initialize_owner: false
    });

    assert.throws(
      () => service.listMembers({ actor: actor(2), organizationId: 10, query: {} }),
      (error) => error && error.code === 'ORGANIZATION_GOVERNANCE_FORBIDDEN'
    );
    assert.throws(
      () => service.listOrganizations({ actor: actor(4), query: {} }),
      (error) => error && error.code === 'ORGANIZATION_GOVERNANCE_FORBIDDEN'
    );

    const audits = db.prepare(`
      SELECT action,details FROM activity_log
      WHERE module='organization_governance'
      ORDER BY id
    `).all();
    assert.deepEqual(audits.map((entry) => entry.action), [
      'organization_governance_list_organizations',
      'organization_governance_list_organizations',
      'organization_governance_list_members'
    ]);
    assert.equal(audits.some((entry) => entry.details.includes('session-')), false);
  } finally {
    db.close();
  }
});

test('applies bounded organization and member search filters before pagination', () => {
  const db = openFixture();
  try {
    const { createOrganizationGovernanceService } = loadService();
    const service = createOrganizationGovernanceService(db);

    const organizations = service.listOrganizations({
      actor: actor(1, 'admin'),
      requestId: 'organizations-filtered',
      query: { q: 'BeTa', limit: 20 }
    });
    assert.deepEqual(organizations.organizations.map((organization) => organization.id), [20]);
    assert.deepEqual(organizations.page, { limit: 20, next_cursor: null, has_more: false });

    const nullPrototypeQuery = Object.assign(Object.create(null), { q: 'alpha', limit: '20' });
    const nullPrototypeOrganizations = service.listOrganizations({
      actor: actor(1, 'admin'),
      requestId: 'organizations-null-prototype-filter',
      query: nullPrototypeQuery
    });
    assert.deepEqual(
      nullPrototypeOrganizations.organizations.map((organization) => organization.id),
      [10]
    );

    db.prepare(`
      UPDATE organization_memberships
      SET status='revoked',revoked_at='2026-09-16 00:00:00'
      WHERE org_id=20 AND user_id=5
    `).run();
    const members = service.listMembers({
      actor: actor(2),
      organizationId: 20,
      requestId: 'members-filtered',
      query: { q: 'creative', status: 'revoked', limit: 20 }
    });
    assert.deepEqual(members.members.map((member) => member.user_id), [5]);
    assert.deepEqual(members.page, { limit: 20, next_cursor: null, has_more: false });

    assert.throws(
      () => service.listOrganizations({ actor: actor(1, 'admin'), query: { q: 'x'.repeat(121) } }),
      (error) => error && error.code === 'INVALID_ORGANIZATION_GOVERNANCE_INPUT'
    );
    assert.throws(
      () => service.listMembers({ actor: actor(2), organizationId: 20, query: { status: 'inactive' } }),
      (error) => error && error.code === 'INVALID_ORGANIZATION_GOVERNANCE_INPUT'
    );
  } finally {
    db.close();
  }
});

test('enforces platform admin, owner, and organization admin mutation boundaries', () => {
  const db = openFixture();
  try {
    const { createOrganizationGovernanceService } = loadService();
    const service = createOrganizationGovernanceService(db);

    const changed = service.updateMember({
      actor: actor(7),
      organizationId: 10,
      userId: 4,
      body: { access_role: 'read_only' },
      requestId: 'make-read-only'
    });
    assert.equal(changed.changed, true);
    assert.deepEqual(
      db.prepare('SELECT role_code,status FROM organization_memberships WHERE org_id=10 AND user_id=4').get(),
      { role_code: 'member', status: 'active' }
    );
    assert.deepEqual(
      db.prepare('SELECT role_code,status FROM team_memberships WHERE org_id=10 AND user_id=4').get(),
      { role_code: 'member', status: 'active' }
    );
    assert.equal(
      db.prepare('SELECT access_mode FROM organization_member_policy WHERE org_id=10 AND user_id=4').get().access_mode,
      'read_only'
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id=4').get().count, 0);

    assert.throws(
      () => service.updateMember({
        actor: actor(7), organizationId: 10, userId: 3,
        body: { access_role: 'member' }, requestId: 'org-admin-peer'
      }),
      (error) => error && error.code === 'ORGANIZATION_MEMBER_CHANGE_FORBIDDEN'
    );
    assert.throws(
      () => service.updateMember({
        actor: actor(7), organizationId: 20, userId: 5,
        body: { access_role: 'member' }, requestId: 'cross-org'
      }),
      (error) => error && error.code === 'ORGANIZATION_GOVERNANCE_FORBIDDEN'
    );
    assert.throws(
      () => service.updateMember({
        actor: actor(4), organizationId: 20, userId: 5,
        body: { membership_status: 'revoked' }, requestId: 'manager-denied'
      }),
      (error) => error && error.code === 'ORGANIZATION_GOVERNANCE_FORBIDDEN'
    );
    assert.throws(
      () => service.updateMember({
        actor: actor(1, 'admin'), organizationId: 20, userId: 2,
        body: { membership_status: 'revoked' }, requestId: 'owner-denied'
      }),
      (error) => error && error.code === 'COMPANY_OWNER_IMMUTABLE'
    );
  } finally {
    db.close();
  }
});

test('protects platform administrators and rejects manager assignment without a team', () => {
  const db = openFixture();
  try {
    const { createOrganizationGovernanceService } = loadService();
    const service = createOrganizationGovernanceService(db);
    db.exec(`
      INSERT INTO users (id,username,display_name,role,department,is_active)
      VALUES (9,'platform-two','Platform Admin Two','admin','Leadership',1);
      INSERT INTO organization_memberships (org_id,user_id,role_code,status)
      VALUES (20,9,'org_admin','active');
      INSERT INTO organization_member_policy (org_id,user_id,access_mode)
      VALUES (20,9,'read_write');
    `);

    assert.throws(
      () => service.updateMember({
        actor: actor(2), organizationId: 20, userId: 9,
        body: { membership_status: 'revoked' }, requestId: 'owner-platform-admin-denied'
      }),
      (error) => error && error.code === 'ORGANIZATION_MEMBER_CHANGE_FORBIDDEN'
    );
    assert.throws(
      () => service.updateMember({
        actor: actor(1, 'admin'), organizationId: 20, userId: 9,
        body: { access_role: 'read_only' }, requestId: 'platform-admin-read-only-denied'
      }),
      (error) => error && error.code === 'ORGANIZATION_MEMBER_CHANGE_FORBIDDEN'
    );
    assert.throws(
      () => service.updateMember({
        actor: actor(1, 'admin'), organizationId: 30, userId: 5,
        body: { access_role: 'manager' }, requestId: 'manager-without-team-denied'
      }),
      (error) => error && error.code === 'MANAGER_TEAM_REQUIRED'
    );

    const ownerView = service.listMembers({
      actor: actor(2), organizationId: 20, query: { q: 'platform-two' }
    });
    assert.deepEqual(ownerView.members[0].allowed_actions, {
      change_role: false,
      change_status: false,
      initialize_owner: false
    });
  } finally {
    db.close();
  }
});

test('organization membership status changes preserve existing team assignment states', () => {
  const db = openFixture();
  try {
    const { createOrganizationGovernanceService } = loadService();
    const service = createOrganizationGovernanceService(db);
    db.exec(`
      INSERT INTO teams (id,org_id,code,name) VALUES (202,20,'beta-secondary','Beta Secondary');
      INSERT INTO team_memberships (org_id,team_id,user_id,role_code,status,revoked_at)
      VALUES (20,202,4,'member','revoked','2026-09-01 00:00:00');
    `);

    service.updateMember({
      actor: actor(1, 'admin'), organizationId: 20, userId: 4,
      body: { membership_status: 'revoked' }, requestId: 'revoke-organization-membership'
    });
    assert.deepEqual(
      db.prepare('SELECT team_id,status,revoked_at FROM team_memberships WHERE org_id=20 AND user_id=4 ORDER BY team_id').all(),
      [
        { team_id: 201, status: 'active', revoked_at: null },
        { team_id: 202, status: 'revoked', revoked_at: '2026-09-01 00:00:00' }
      ]
    );

    service.updateMember({
      actor: actor(1, 'admin'), organizationId: 20, userId: 4,
      body: { membership_status: 'active' }, requestId: 'reactivate-organization-membership'
    });
    assert.deepEqual(
      db.prepare('SELECT team_id,status,revoked_at FROM team_memberships WHERE org_id=20 AND user_id=4 ORDER BY team_id').all(),
      [
        { team_id: 201, status: 'active', revoked_at: null },
        { team_id: 202, status: 'revoked', revoked_at: '2026-09-01 00:00:00' }
      ]
    );
  } finally {
    db.close();
  }
});

test('rejects proxy mutation bodies before invoking proxy traps', () => {
  const db = openFixture();
  try {
    const { createOrganizationGovernanceService } = loadService();
    const service = createOrganizationGovernanceService(db);
    let trapInvoked = false;
    const body = new Proxy({ access_role: 'member' }, {
      ownKeys() {
        trapInvoked = true;
        return ['access_role'];
      }
    });

    assert.throws(
      () => service.updateMember({
        actor: actor(1, 'admin'), organizationId: 20, userId: 4,
        body, requestId: 'proxy-body-denied'
      }),
      (error) => error && error.code === 'INVALID_ORGANIZATION_GOVERNANCE_BODY'
    );
    assert.equal(trapInvoked, false);
  } finally {
    db.close();
  }
});

test('initializes an unowned organization only once for an eligible member and revokes sessions', () => {
  const db = openFixture();
  try {
    const { createOrganizationGovernanceService } = loadService();
    const service = createOrganizationGovernanceService(db);

    const initialized = service.initializeOwner({
      actor: actor(1, 'admin'),
      organizationId: 30,
      body: { user_id: 5 },
      requestId: 'initialize-owner'
    });
    assert.equal(initialized.changed, true);
    assert.deepEqual(
      db.prepare('SELECT owner_user_id,created_by FROM organization_authority WHERE org_id=30').get(),
      { owner_user_id: 5, created_by: 1 }
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id=5').get().count, 0);

    assert.throws(
      () => service.initializeOwner({
        actor: actor(1, 'admin'), organizationId: 30,
        body: { user_id: 8 }, requestId: 'replace-owner'
      }),
      (error) => error && error.code === 'COMPANY_OWNER_ALREADY_INITIALIZED'
    );
    assert.throws(
      () => service.initializeOwner({
        actor: actor(2), organizationId: 30,
        body: { user_id: 8 }, requestId: 'owner-cannot-initialize'
      }),
      (error) => error && error.code === 'PLATFORM_ADMIN_REQUIRED'
    );
  } finally {
    db.close();
  }
});

test('rolls back membership, policy, session revocation, and change result when audit persistence fails', () => {
  const db = openFixture();
  try {
    const { createOrganizationGovernanceService } = loadService();
    const service = createOrganizationGovernanceService(db);
    db.exec(`
      CREATE TRIGGER reject_governance_audit
      BEFORE INSERT ON activity_log
      WHEN NEW.module='organization_governance'
      BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END;
    `);

    assert.throws(
      () => service.updateMember({
        actor: actor(1, 'admin'),
        organizationId: 20,
        userId: 5,
        body: { access_role: 'administrator', membership_status: 'revoked' },
        requestId: 'atomic-audit'
      }),
      (error) => error && error.code === 'AUDIT_PERSISTENCE_FAILED'
    );
    assert.deepEqual(
      db.prepare('SELECT role_code,status,revoked_at FROM organization_memberships WHERE org_id=20 AND user_id=5').get(),
      { role_code: 'member', status: 'active', revoked_at: null }
    );
    assert.equal(
      db.prepare('SELECT access_mode FROM organization_member_policy WHERE org_id=20 AND user_id=5').get().access_mode,
      'read_write'
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id=5').get().count, 1);
  } finally {
    db.close();
  }
});

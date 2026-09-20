'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

function loadService() {
  try {
    return require('../services/module_action_permission_service');
  } catch (error) {
    if (
      error &&
      error.code === 'MODULE_NOT_FOUND' &&
      String(error.message).includes('module_action_permission_service')
    ) {
      assert.fail('module action permission service has not been implemented');
    }
    throw error;
  }
}

function createFixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      role TEXT NOT NULL,
      is_active INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE organization_memberships (
      org_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role_code TEXT NOT NULL,
      status TEXT NOT NULL,
      PRIMARY KEY (org_id, user_id)
    ) STRICT;
    CREATE TABLE team_memberships (
      org_id INTEGER NOT NULL,
      team_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role_code TEXT NOT NULL,
      status TEXT NOT NULL,
      PRIMARY KEY (org_id, team_id, user_id)
    ) STRICT;
    CREATE TABLE organization_member_policy (
      org_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      access_mode TEXT NOT NULL,
      PRIMARY KEY (org_id, user_id)
    ) STRICT;
    CREATE TABLE organization_authority (
      org_id INTEGER PRIMARY KEY,
      owner_user_id INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE plan_catalog (
      code TEXT PRIMARY KEY,
      status TEXT NOT NULL
    ) STRICT;
    CREATE TABLE plan_module_entitlements (
      plan_code TEXT NOT NULL,
      module_code TEXT NOT NULL,
      PRIMARY KEY (plan_code, module_code)
    ) STRICT;
    CREATE TABLE organization_plan_assignments (
      id INTEGER PRIMARY KEY,
      org_id INTEGER NOT NULL,
      plan_code TEXT NOT NULL,
      assignment_version INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE organization_subscription_terms (
      id INTEGER PRIMARY KEY,
      org_id INTEGER NOT NULL,
      term_version INTEGER NOT NULL,
      expires_at TEXT
    ) STRICT;
    INSERT INTO users (id, role, is_active) VALUES
      (1, 'admin', 1),
      (2, 'user', 1),
      (3, 'admin', 0),
      (4, 'user', 1),
      (5, 'admin', 1);
    INSERT INTO organization_memberships (org_id, user_id, role_code, status) VALUES
      (10, 1, 'org_admin', 'active'),
      (10, 2, 'org_admin', 'active'),
      (10, 3, 'org_admin', 'active'),
      (10, 4, 'member', 'active'),
      (10, 5, 'org_admin', 'active'),
      (20, 2, 'org_admin', 'active'),
      (20, 4, 'member', 'active');
    INSERT INTO organization_member_policy (org_id,user_id,access_mode) VALUES
      (10,1,'read_write'),
      (10,2,'read_write'),
      (10,3,'read_write'),
      (10,4,'read_write'),
      (10,5,'read_only'),
      (20,2,'read_only'),
      (20,4,'read_write');
    INSERT INTO organization_authority (org_id,owner_user_id) VALUES (10,1),(20,4);
    INSERT INTO plan_catalog (code,status) VALUES
      ('legacy_full','active'),
      ('crm_core','active'),
      ('inactive_plan','inactive');
    INSERT INTO plan_module_entitlements (plan_code,module_code) VALUES
      ('legacy_full','crm.customer'),
      ('legacy_full','crm.opportunity'),
      ('legacy_full','crm.contact'),
      ('legacy_full','crm.task'),
      ('legacy_full','campaign.performance'),
      ('legacy_full','campaign.customer_report'),
      ('legacy_full','influencer.data'),
      ('crm_core','crm.customer'),
      ('crm_core','crm.opportunity'),
      ('crm_core','crm.contact'),
      ('crm_core','crm.task');
    INSERT INTO organization_plan_assignments (id,org_id,plan_code,assignment_version) VALUES
      (1,10,'legacy_full',1),
      (2,20,'legacy_full',1);
    INSERT INTO organization_subscription_terms (id,org_id,term_version,expires_at) VALUES
      (1,10,1,NULL),
      (2,20,1,NULL);
    INSERT INTO team_memberships (org_id, team_id, user_id, role_code, status) VALUES
      (10, 100, 1, 'team_lead', 'active'),
      (10, 100, 2, 'team_lead', 'active'),
      (10, 101, 2, 'member', 'active'),
      (10, 100, 3, 'team_lead', 'active'),
      (10, 101, 4, 'member', 'active'),
      (20, 200, 2, 'team_lead', 'active'),
      (20, 200, 4, 'member', 'active');
  `);
  const { createModuleActionPermissionService } = loadService();
  return {
    db,
    service: createModuleActionPermissionService(db)
  };
}

function platformAdminRequest(principal) {
  return {
    principal,
    module: 'platform_administration',
    action: 'manage'
  };
}

function crmCustomerRequest(principal, organizationId, action) {
  return {
    principal,
    organizationId,
    module: 'crm.customer',
    action
  };
}

function crmOpportunityRequest(principal, organizationId, action) {
  return {
    principal,
    organizationId,
    module: 'crm.opportunity',
    action
  };
}

function crmContactRequest(principal, organizationId, action) {
  return {
    principal,
    organizationId,
    module: 'crm.contact',
    action
  };
}

function crmTaskRequest(principal, organizationId, action) {
  return {
    principal,
    organizationId,
    module: 'crm.task',
    action
  };
}

function campaignPerformanceRequest(principal, organizationId, action) {
  return {
    principal,
    organizationId,
    module: 'campaign.performance',
    action
  };
}

function campaignCustomerReportRequest(principal, organizationId, action) {
  return {
    principal,
    organizationId,
    module: 'campaign.customer_report',
    action
  };
}

function influencerDataRequest(principal, organizationId, action) {
  return {
    principal,
    organizationId,
    module: 'influencer.data',
    action
  };
}

test('allows the declared platform administration action for an active live platform admin', () => {
  const { db, service } = createFixture();
  try {
    const decision = service.authorize(platformAdminRequest({ id: 1, role: 'admin' }));

    assert.deepEqual(decision, {
      allowed: true,
      code: 'ALLOWED',
      principal: {
        user_id: 1,
        roles: ['platform_admin', 'company_owner', 'administrator', 'manager', 'member']
      }
    });
  } finally {
    db.close();
  }
});

test('keeps platform administration manage allowed for a live platform admin with read-only organization access', () => {
  const { db, service } = createFixture();
  try {
    assert.deepEqual(service.authorize(platformAdminRequest({ id: 5, role: 'admin' })), {
      allowed: true,
      code: 'ALLOWED',
      principal: {
        user_id: 5,
        roles: ['platform_admin', 'read_only']
      }
    });
  } finally {
    db.close();
  }
});

test('denies unresolved or mismatched principals for the platform administration action', () => {
  const { db, service } = createFixture();
  try {
    const cases = [
      ['ordinary user', { id: 4, role: 'user' }, 'ACTION_FORBIDDEN', true],
      ['inactive live user', { id: 3, role: 'admin' }, 'INACTIVE_USER', false],
      ['missing live user', { id: 99, role: 'admin' }, 'MISSING_USER', false],
      ['request live role mismatch', { id: 4, role: 'admin' }, 'ROLE_MISMATCH', false],
      ['malformed principal', { id: '4', role: 'user' }, 'MALFORMED_PRINCIPAL', false]
    ];

    for (const [label, principal, code, hasPrincipal] of cases) {
      const decision = service.authorize(platformAdminRequest(principal));
      assert.equal(decision.allowed, false, label);
      assert.equal(decision.code, code, label);
      assert.equal(Object.hasOwn(decision, 'principal'), hasPrincipal, label);
    }
  } finally {
    db.close();
  }
});

test('denies unknown module and action vocabulary', () => {
  const { db, service } = createFixture();
  try {
    const principal = { id: 1, role: 'admin' };
    const unknownModule = service.authorize({
      principal,
      module: 'unknown_module',
      action: 'manage'
    });
    const unknownAction = service.authorize({
      principal,
      module: 'platform_administration',
      action: 'unknown_action'
    });
    const inheritedModule = service.authorize({
      principal,
      module: 'toString',
      action: 'manage'
    });
    const inheritedAction = service.authorize({
      principal,
      module: 'platform_administration',
      action: 'toString'
    });

    assert.deepEqual(unknownModule, { allowed: false, code: 'UNKNOWN_MODULE' });
    assert.deepEqual(unknownAction, { allowed: false, code: 'UNKNOWN_ACTION' });
    assert.deepEqual(inheritedModule, { allowed: false, code: 'UNKNOWN_MODULE' });
    assert.deepEqual(inheritedAction, { allowed: false, code: 'UNKNOWN_ACTION' });
  } finally {
    db.close();
  }
});

test('fails closed without coercing malformed module and action values', () => {
  const { db, service } = createFixture();
  try {
    const principal = { id: 1, role: 'admin' };
    const cases = [
      ['array module', { module: ['platform_administration'], action: 'manage' }],
      ['array action', { module: 'platform_administration', action: ['manage'] }],
      ['boxed module', { module: new String('platform_administration'), action: 'manage' }],
      ['boxed action', { module: 'platform_administration', action: new String('manage') }],
      ['toString module', { module: { toString: () => 'platform_administration' }, action: 'manage' }],
      ['toString action', { module: 'platform_administration', action: { toString: () => 'manage' } }]
    ];

    for (const [label, fields] of cases) {
      assert.doesNotThrow(() => {
        assert.deepEqual(service.authorize({ principal, ...fields }), {
          allowed: false,
          code: 'MALFORMED_REQUEST'
        });
      }, label);
    }
  } finally {
    db.close();
  }
});

test('fails closed when request or principal property getters throw', () => {
  const { db, service } = createFixture();
  try {
    function throwingGetter(property) {
      const value = {};
      Object.defineProperty(value, property, {
        enumerable: true,
        get() {
          throw new Error(property + ' getter must not escape');
        }
      });
      return value;
    }

    const validPrincipal = { id: 1, role: 'admin' };
    const requestCases = [
      ['module getter', Object.assign(throwingGetter('module'), { action: 'manage', principal: validPrincipal })],
      ['action getter', Object.assign(throwingGetter('action'), { module: 'platform_administration', principal: validPrincipal })],
      ['principal getter', Object.assign(throwingGetter('principal'), { module: 'platform_administration', action: 'manage' })]
    ];
    for (const [label, input] of requestCases) {
      assert.doesNotThrow(() => {
        assert.deepEqual(service.authorize(input), {
          allowed: false,
          code: 'MALFORMED_REQUEST'
        });
      }, label);
    }

    for (const property of ['id', 'role']) {
      assert.doesNotThrow(() => {
        assert.deepEqual(service.authorize({
          module: 'platform_administration',
          action: 'manage',
          principal: throwingGetter(property)
        }), {
          allowed: false,
          code: 'MALFORMED_PRINCIPAL'
        });
      }, 'principal ' + property + ' getter');
    }
  } finally {
    db.close();
  }
});

test('projects only server-derived organization and team roles and ignores reserved or injected grants', () => {
  const { db, service } = createFixture();
  try {
    const decision = service.authorize(platformAdminRequest({
      id: 2,
      role: 'user',
      roles: ['company_owner', 'read_only', 'platform_admin'],
      permissions: ['platform_administration.manage'],
      auth_context: {
        organization: { role_code: 'company_owner' },
        teams: [{ role_code: 'read_only' }]
      }
    }));

    assert.deepEqual(decision, {
      allowed: false,
      code: 'ACTION_FORBIDDEN',
      principal: {
        user_id: 2,
        roles: ['administrator', 'manager', 'member', 'read_only']
      }
    });
  } finally {
    db.close();
  }
});

test('evaluates CRM customer permissions inside the requested organization without role bleed', () => {
  const { db, service } = createFixture();
  try {
    const writable = service.authorize(crmCustomerRequest({ id: 2, role: 'user' }, 10, 'update'));
    assert.deepEqual(writable, {
      allowed: true,
      code: 'ALLOWED',
      principal: {
        user_id: 2,
        organization_id: 10,
        roles: ['administrator', 'manager', 'member']
      }
    });

    const readOnlyRead = service.authorize(crmCustomerRequest({ id: 2, role: 'user' }, 20, 'read'));
    assert.deepEqual(readOnlyRead, {
      allowed: true,
      code: 'ALLOWED',
      principal: {
        user_id: 2,
        organization_id: 20,
        roles: ['read_only']
      }
    });

    const readOnlyWrite = service.authorize(crmCustomerRequest({ id: 2, role: 'user' }, 20, 'update'));
    assert.deepEqual(readOnlyWrite, {
      allowed: false,
      code: 'ACTION_FORBIDDEN',
      principal: {
        user_id: 2,
        organization_id: 20,
        roles: ['read_only']
      }
    });
  } finally {
    db.close();
  }
});

test('grants CRM customer actions to live organization roles but not to an unrelated platform role', () => {
  const { db, service } = createFixture();
  try {
    assert.equal(
      service.authorize(crmCustomerRequest({ id: 4, role: 'user' }, 20, 'update')).allowed,
      true,
      'company owner can update customers in the owned organization'
    );
    assert.equal(
      service.authorize(crmCustomerRequest({ id: 4, role: 'user' }, 10, 'create')).allowed,
      true,
      'writable organization member can create customers'
    );
    assert.deepEqual(
      service.authorize(crmCustomerRequest({ id: 1, role: 'admin' }, 20, 'read')),
      {
        allowed: false,
        code: 'ACTION_FORBIDDEN',
        principal: {
          user_id: 1,
          organization_id: 20,
          roles: ['platform_admin']
        }
      },
      'platform role alone does not grant tenant business data access'
    );
  } finally {
    db.close();
  }
});

test('projects the exact allowed CRM customer actions for server-rendered controls', () => {
  const { db, service } = createFixture();
  try {
    assert.deepEqual(service.projectModuleAccess({
      principal: { id: 2, role: 'user' },
      organizationId: 10,
      module: 'crm.customer'
    }), {
      allowed: true,
      code: 'ALLOWED',
      principal: {
        user_id: 2,
        organization_id: 10,
        roles: ['administrator', 'manager', 'member']
      },
      actions: ['read', 'create', 'update']
    });
    assert.deepEqual(service.projectModuleAccess({
      principal: { id: 2, role: 'user' },
      organizationId: 20,
      module: 'crm.customer'
    }), {
      allowed: true,
      code: 'ALLOWED',
      principal: {
        user_id: 2,
        organization_id: 20,
        roles: ['read_only']
      },
      actions: ['read']
    });
  } finally {
    db.close();
  }
});

test('fails closed when a tenant-scoped CRM permission omits or corrupts organization identity', () => {
  const { db, service } = createFixture();
  try {
    for (const [organizationId, code] of [
      [undefined, 'ORGANIZATION_SCOPE_REQUIRED'],
      [null, 'MALFORMED_ORGANIZATION'],
      ['10', 'MALFORMED_ORGANIZATION'],
      [0, 'MALFORMED_ORGANIZATION']
    ]) {
      const request = crmCustomerRequest({ id: 2, role: 'user' }, organizationId, 'read');
      if (organizationId === undefined) delete request.organizationId;
      assert.deepEqual(service.authorize(request), { allowed: false, code });
    }
  } finally {
    db.close();
  }
});

test('projects exact CRM opportunity actions for writable, read-only, and unrelated platform roles', () => {
  const { db, service } = createFixture();
  try {
    assert.deepEqual(service.projectModuleAccess({
      principal: { id: 2, role: 'user' },
      organizationId: 10,
      module: 'crm.opportunity'
    }), {
      allowed: true,
      code: 'ALLOWED',
      principal: {
        user_id: 2,
        organization_id: 10,
        roles: ['administrator', 'manager', 'member']
      },
      actions: ['read', 'create', 'update']
    });
    assert.deepEqual(service.projectModuleAccess({
      principal: { id: 2, role: 'user' },
      organizationId: 20,
      module: 'crm.opportunity'
    }), {
      allowed: true,
      code: 'ALLOWED',
      principal: {
        user_id: 2,
        organization_id: 20,
        roles: ['read_only']
      },
      actions: ['read']
    });
    assert.deepEqual(service.projectModuleAccess({
      principal: { id: 1, role: 'admin' },
      organizationId: 20,
      module: 'crm.opportunity'
    }), {
      allowed: true,
      code: 'ALLOWED',
      principal: {
        user_id: 1,
        organization_id: 20,
        roles: ['platform_admin']
      },
      actions: []
    });
  } finally {
    db.close();
  }
});

test('fails closed when CRM opportunity permission scope is missing or malformed', () => {
  const { db, service } = createFixture();
  try {
    for (const [organizationId, code] of [
      [undefined, 'ORGANIZATION_SCOPE_REQUIRED'],
      [null, 'MALFORMED_ORGANIZATION'],
      ['10', 'MALFORMED_ORGANIZATION'],
      [0, 'MALFORMED_ORGANIZATION']
    ]) {
      const request = crmOpportunityRequest({ id: 2, role: 'user' }, organizationId, 'read');
      if (organizationId === undefined) delete request.organizationId;
      assert.deepEqual(service.authorize(request), { allowed: false, code });
    }
  } finally {
    db.close();
  }
});

test('projects exact CRM contact actions for writable, read-only, and platform-admin-only principals', () => {
  const { db, service } = createFixture();
  try {
    assert.deepEqual(service.projectModuleAccess({
      principal: { id: 2, role: 'user' },
      organizationId: 10,
      module: 'crm.contact'
    }), {
      allowed: true,
      code: 'ALLOWED',
      principal: {
        user_id: 2,
        organization_id: 10,
        roles: ['administrator', 'manager', 'member']
      },
      actions: ['read', 'create', 'update']
    });
    assert.deepEqual(service.projectModuleAccess({
      principal: { id: 2, role: 'user' },
      organizationId: 20,
      module: 'crm.contact'
    }), {
      allowed: true,
      code: 'ALLOWED',
      principal: {
        user_id: 2,
        organization_id: 20,
        roles: ['read_only']
      },
      actions: ['read']
    });
    assert.deepEqual(service.projectModuleAccess({
      principal: { id: 1, role: 'admin' },
      organizationId: 20,
      module: 'crm.contact'
    }), {
      allowed: true,
      code: 'ALLOWED',
      principal: {
        user_id: 1,
        organization_id: 20,
        roles: ['platform_admin']
      },
      actions: []
    });
  } finally {
    db.close();
  }
});

test('authorizes CRM contact read and writes by action while failing closed without a valid organization scope', () => {
  const { db, service } = createFixture();
  try {
    assert.equal(
      service.authorize(crmContactRequest({ id: 2, role: 'user' }, 10, 'read')).allowed,
      true
    );
    assert.equal(
      service.authorize(crmContactRequest({ id: 2, role: 'user' }, 10, 'create')).allowed,
      true
    );
    assert.equal(
      service.authorize(crmContactRequest({ id: 2, role: 'user' }, 10, 'update')).allowed,
      true
    );
    for (const action of ['create', 'update']) {
      assert.deepEqual(
        service.authorize(crmContactRequest({ id: 2, role: 'user' }, 20, action)),
        {
          allowed: false,
          code: 'ACTION_FORBIDDEN',
          principal: {
            user_id: 2,
            organization_id: 20,
            roles: ['read_only']
          }
        }
      );
    }
    for (const [organizationId, code] of [
      [undefined, 'ORGANIZATION_SCOPE_REQUIRED'],
      [null, 'MALFORMED_ORGANIZATION'],
      ['10', 'MALFORMED_ORGANIZATION'],
      [0, 'MALFORMED_ORGANIZATION']
    ]) {
      const request = crmContactRequest({ id: 2, role: 'user' }, organizationId, 'read');
      if (organizationId === undefined) delete request.organizationId;
      assert.deepEqual(service.authorize(request), { allowed: false, code });
    }
  } finally {
    db.close();
  }
});

test('projects and authorizes exact CRM task actions for writable and read-only tenant roles', () => {
  const { db, service } = createFixture();
  try {
    assert.deepEqual(service.projectModuleAccess({
      principal: { id: 2, role: 'user' },
      organizationId: 10,
      module: 'crm.task'
    }), {
      allowed: true,
      code: 'ALLOWED',
      principal: {
        user_id: 2,
        organization_id: 10,
        roles: ['administrator', 'manager', 'member']
      },
      actions: ['read', 'create', 'update']
    });
    assert.deepEqual(service.projectModuleAccess({
      principal: { id: 2, role: 'user' },
      organizationId: 20,
      module: 'crm.task'
    }), {
      allowed: true,
      code: 'ALLOWED',
      principal: {
        user_id: 2,
        organization_id: 20,
        roles: ['read_only']
      },
      actions: ['read']
    });
    assert.deepEqual(service.projectModuleAccess({
      principal: { id: 1, role: 'admin' },
      organizationId: 20,
      module: 'crm.task'
    }), {
      allowed: true,
      code: 'ALLOWED',
      principal: {
        user_id: 1,
        organization_id: 20,
        roles: ['platform_admin']
      },
      actions: []
    });

    for (const action of ['read', 'create', 'update']) {
      assert.equal(
        service.authorize(crmTaskRequest({ id: 2, role: 'user' }, 10, action)).allowed,
        true
      );
    }
    for (const action of ['create', 'update']) {
      assert.deepEqual(
        service.authorize(crmTaskRequest({ id: 2, role: 'user' }, 20, action)),
        {
          allowed: false,
          code: 'ACTION_FORBIDDEN',
          principal: {
            user_id: 2,
            organization_id: 20,
            roles: ['read_only']
          }
        }
      );
    }
    for (const [organizationId, code] of [
      [undefined, 'ORGANIZATION_SCOPE_REQUIRED'],
      [null, 'MALFORMED_ORGANIZATION'],
      ['10', 'MALFORMED_ORGANIZATION'],
      [0, 'MALFORMED_ORGANIZATION']
    ]) {
      const request = crmTaskRequest({ id: 2, role: 'user' }, organizationId, 'read');
      if (organizationId === undefined) delete request.organizationId;
      assert.deepEqual(service.authorize(request), { allowed: false, code });
    }
  } finally {
    db.close();
  }
});

test('projects and authorizes campaign performance export only for writable tenant roles', () => {
  const { db, service } = createFixture();
  try {
    db.exec(`
      INSERT INTO users (id, role, is_active) VALUES
        (6, 'user', 1),
        (7, 'user', 1),
        (8, 'user', 1),
        (9, 'user', 1);
      INSERT INTO organization_memberships (org_id, user_id, role_code, status) VALUES
        (10, 6, 'member', 'active'),
        (10, 7, 'org_admin', 'active'),
        (10, 8, 'member', 'active'),
        (30, 9, 'member', 'active');
      INSERT INTO organization_member_policy (org_id,user_id,access_mode) VALUES
        (10,6,'read_write'),
        (10,7,'read_write'),
        (10,8,'read_write'),
        (30,9,'read_write');
      INSERT INTO organization_authority (org_id,owner_user_id) VALUES (30,9);
      INSERT INTO organization_plan_assignments (id,org_id,plan_code,assignment_version)
        VALUES (3,30,'legacy_full',1);
      INSERT INTO organization_subscription_terms (id,org_id,term_version,expires_at)
        VALUES (3,30,1,NULL);
      INSERT INTO team_memberships (org_id, team_id, user_id, role_code, status)
        VALUES (10,102,6,'team_lead','active');
    `);
    assert.deepEqual(service.projectModuleAccess({
      principal: { id: 2, role: 'user' },
      organizationId: 10,
      module: 'campaign.performance'
    }), {
      allowed: true,
      code: 'ALLOWED',
      principal: {
        user_id: 2,
        organization_id: 10,
        roles: ['administrator', 'manager', 'member']
      },
      actions: ['export']
    });
    for (const [userId, organizationId, roles] of [
      [6, 10, ['manager', 'member']],
      [7, 10, ['administrator', 'member']],
      [8, 10, ['member']],
      [9, 30, ['company_owner', 'member']]
    ]) {
      assert.deepEqual(
        service.authorize(campaignPerformanceRequest({ id: userId, role: 'user' }, organizationId, 'export')),
        {
          allowed: true,
          code: 'ALLOWED',
          principal: { user_id: userId, organization_id: organizationId, roles }
        }
      );
    }
    assert.deepEqual(
      service.authorize(campaignPerformanceRequest({ id: 2, role: 'user' }, 20, 'export')),
      {
        allowed: false,
        code: 'ACTION_FORBIDDEN',
        principal: {
          user_id: 2,
          organization_id: 20,
          roles: ['read_only']
        }
      }
    );
    assert.deepEqual(
      service.authorize(campaignPerformanceRequest({ id: 1, role: 'admin' }, 20, 'export')),
      {
        allowed: false,
        code: 'ACTION_FORBIDDEN',
        principal: {
          user_id: 1,
          organization_id: 20,
          roles: ['platform_admin']
        }
      }
    );
    for (const [organizationId, code] of [
      [undefined, 'ORGANIZATION_SCOPE_REQUIRED'],
      [null, 'MALFORMED_ORGANIZATION'],
      ['10', 'MALFORMED_ORGANIZATION'],
      [0, 'MALFORMED_ORGANIZATION']
    ]) {
      const request = campaignPerformanceRequest({ id: 2, role: 'user' }, organizationId, 'export');
      if (organizationId === undefined) delete request.organizationId;
      assert.deepEqual(service.authorize(request), { allowed: false, code });
    }
  } finally {
    db.close();
  }
});

test('projects and authorizes customer report export only for writable tenant roles', () => {
  const { db, service } = createFixture();
  try {
    assert.deepEqual(service.projectModuleAccess({
      principal: { id: 2, role: 'user' },
      organizationId: 10,
      module: 'campaign.customer_report'
    }), {
      allowed: true,
      code: 'ALLOWED',
      principal: {
        user_id: 2,
        organization_id: 10,
        roles: ['administrator', 'manager', 'member']
      },
      actions: ['export']
    });
    assert.deepEqual(
      service.authorize(campaignCustomerReportRequest({ id: 4, role: 'user' }, 20, 'export')),
      {
        allowed: true,
        code: 'ALLOWED',
        principal: {
          user_id: 4,
          organization_id: 20,
          roles: ['company_owner', 'member']
        }
      }
    );
    assert.deepEqual(
      service.authorize(campaignCustomerReportRequest({ id: 2, role: 'user' }, 20, 'export')),
      {
        allowed: false,
        code: 'ACTION_FORBIDDEN',
        principal: {
          user_id: 2,
          organization_id: 20,
          roles: ['read_only']
        }
      }
    );
    assert.deepEqual(
      service.authorize(campaignCustomerReportRequest({ id: 1, role: 'admin' }, 20, 'export')),
      {
        allowed: false,
        code: 'ACTION_FORBIDDEN',
        principal: {
          user_id: 1,
          organization_id: 20,
          roles: ['platform_admin']
        }
      }
    );
    for (const [organizationId, code] of [
      [undefined, 'ORGANIZATION_SCOPE_REQUIRED'],
      [null, 'MALFORMED_ORGANIZATION'],
      ['10', 'MALFORMED_ORGANIZATION'],
      [0, 'MALFORMED_ORGANIZATION']
    ]) {
      const request = campaignCustomerReportRequest(
        { id: 2, role: 'user' },
        organizationId,
        'export'
      );
      if (organizationId === undefined) delete request.organizationId;
      assert.deepEqual(service.authorize(request), { allowed: false, code });
    }
  } finally {
    db.close();
  }
});

test('projects and authorizes influencer data export and import only for writable tenant roles', () => {
  const { db, service } = createFixture();
  try {
    db.exec(`
      INSERT INTO users (id,role,is_active) VALUES (16,'user',1),(17,'user',1);
      INSERT INTO organization_memberships (org_id,user_id,role_code,status) VALUES
        (10,16,'member','active'),
        (10,17,'member','active');
      INSERT INTO organization_member_policy (org_id,user_id,access_mode) VALUES
        (10,16,'read_write'),
        (10,17,'read_write');
      INSERT INTO team_memberships (org_id,team_id,user_id,role_code,status) VALUES
        (10,102,16,'team_lead','active'),
        (10,102,17,'member','active');
    `);
    assert.deepEqual(service.projectModuleAccess({
      principal: { id: 2, role: 'user' },
      organizationId: 10,
      module: 'influencer.data'
    }), {
      allowed: true,
      code: 'ALLOWED',
      principal: {
        user_id: 2,
        organization_id: 10,
        roles: ['administrator', 'manager', 'member']
      },
      actions: ['export', 'import']
    });
    for (const action of ['export', 'import']) {
      assert.deepEqual(
        service.authorize(influencerDataRequest({ id: 4, role: 'user' }, 20, action)),
        {
          allowed: true,
          code: 'ALLOWED',
          principal: {
            user_id: 4,
            organization_id: 20,
            roles: ['company_owner', 'member']
          }
        }
      );
      for (const [userId, roles] of [
        [16, ['manager', 'member']],
        [17, ['member']]
      ]) {
        assert.deepEqual(
          service.authorize(influencerDataRequest({ id: userId, role: 'user' }, 10, action)),
          {
            allowed: true,
            code: 'ALLOWED',
            principal: {
              user_id: userId,
              organization_id: 10,
              roles
            }
          }
        );
      }
      assert.deepEqual(
        service.authorize(influencerDataRequest({ id: 2, role: 'user' }, 20, action)),
        {
          allowed: false,
          code: 'ACTION_FORBIDDEN',
          principal: {
            user_id: 2,
            organization_id: 20,
            roles: ['read_only']
          }
        }
      );
      assert.deepEqual(
        service.authorize(influencerDataRequest({ id: 1, role: 'admin' }, 20, action)),
        {
          allowed: false,
          code: 'ACTION_FORBIDDEN',
          principal: {
            user_id: 1,
            organization_id: 20,
            roles: ['platform_admin']
          }
        }
      );
      for (const [organizationId, code] of [
        [undefined, 'ORGANIZATION_SCOPE_REQUIRED'],
        [null, 'MALFORMED_ORGANIZATION'],
        ['10', 'MALFORMED_ORGANIZATION'],
        [0, 'MALFORMED_ORGANIZATION']
      ]) {
        const request = influencerDataRequest({ id: 2, role: 'user' }, organizationId, action);
        if (organizationId === undefined) delete request.organizationId;
        assert.deepEqual(service.authorize(request), { allowed: false, code });
      }
    }
  } finally {
    db.close();
  }
});

test('intersects role permissions with the live organization plan for every organization-scoped module', () => {
  const { db, service } = createFixture();
  try {
    db.prepare(`
      INSERT INTO organization_plan_assignments (id,org_id,plan_code,assignment_version)
      VALUES (4,10,'crm_core',2)
    `).run();

    assert.deepEqual(service.projectModuleAccess({
      principal: { id: 2, role: 'user' },
      organizationId: 10,
      module: 'crm.customer'
    }).actions, ['read', 'create', 'update']);
    assert.deepEqual(service.projectModuleAccess({
      principal: { id: 2, role: 'user' },
      organizationId: 10,
      module: 'campaign.performance'
    }), {
      allowed: true,
      code: 'ALLOWED',
      principal: {
        user_id: 2,
        organization_id: 10,
        roles: ['administrator', 'manager', 'member']
      },
      actions: []
    });
    assert.deepEqual(
      service.authorize(campaignPerformanceRequest({ id: 2, role: 'user' }, 10, 'export')),
      {
        allowed: false,
        code: 'PLAN_ENTITLEMENT_REQUIRED',
        principal: {
          user_id: 2,
          organization_id: 10,
          roles: ['administrator', 'manager', 'member']
        }
      }
    );
    assert.equal(
      service.authorize(campaignPerformanceRequest({ id: 4, role: 'user' }, 20, 'export')).allowed,
      true,
      'another organization retains its own legacy_full entitlement'
    );
  } finally {
    db.close();
  }
});

test('keeps role denial distinct from plan denial and leaves platform administration outside plans', () => {
  const { db, service } = createFixture();
  try {
    db.prepare(`
      INSERT INTO organization_plan_assignments (id,org_id,plan_code,assignment_version)
      VALUES (4,20,'crm_core',2)
    `).run();
    assert.deepEqual(
      service.authorize(crmCustomerRequest({ id: 2, role: 'user' }, 20, 'update')),
      {
        allowed: false,
        code: 'ACTION_FORBIDDEN',
        principal: {
          user_id: 2,
          organization_id: 20,
          roles: ['read_only']
        }
      }
    );
    assert.equal(
      service.authorize(platformAdminRequest({ id: 1, role: 'admin' })).allowed,
      true
    );
  } finally {
    db.close();
  }
});

test('fails closed when authoritative organization plan facts are missing, inactive, duplicated, or unreadable', () => {
  for (const mutate of [
    (db) => db.prepare('DELETE FROM organization_plan_assignments WHERE org_id=10').run(),
    (db) => db.prepare("UPDATE organization_plan_assignments SET plan_code='inactive_plan' WHERE org_id=10").run(),
    (db) => db.prepare(`
      INSERT INTO organization_plan_assignments (id,org_id,plan_code,assignment_version)
      VALUES (3,10,'legacy_full',1)
    `).run(),
    (db) => db.exec('DROP TABLE plan_module_entitlements')
  ]) {
    const { db, service } = createFixture();
    try {
      mutate(db);
      assert.deepEqual(
        service.authorize(crmCustomerRequest({ id: 2, role: 'user' }, 10, 'read')),
        { allowed: false, code: 'ENTITLEMENT_POLICY_UNAVAILABLE' }
      );
    } finally {
      db.close();
    }
  }
});

test('intersects role and plan permission with live subscription expiry for every governed module', () => {
  const { db, service } = createFixture();
  try {
    db.prepare(`
      INSERT INTO organization_subscription_terms (id,org_id,term_version,expires_at)
      VALUES (3,10,2,'2000-01-01T00:00:00Z')
    `).run();
    for (const [module, action] of [
      ['crm.customer', 'read'],
      ['crm.customer', 'create'],
      ['crm.customer', 'update'],
      ['crm.opportunity', 'read'],
      ['crm.opportunity', 'create'],
      ['crm.opportunity', 'update'],
      ['crm.contact', 'read'],
      ['crm.contact', 'create'],
      ['crm.contact', 'update'],
      ['crm.task', 'read'],
      ['crm.task', 'create'],
      ['crm.task', 'update'],
      ['campaign.performance', 'export'],
      ['campaign.customer_report', 'export'],
      ['influencer.data', 'import'],
      ['influencer.data', 'export']
    ]) {
      const projection = service.projectModuleAccess({
        principal: { id: 2, role: 'user' },
        organizationId: 10,
        module
      });
      assert.equal(projection.allowed, true);
      assert.deepEqual(projection.actions, []);
      assert.equal(service.authorize({
        principal: { id: 2, role: 'user' },
        organizationId: 10,
        module,
        action
      }).code, 'SUBSCRIPTION_EXPIRED', module);
    }
    assert.equal(
      service.authorize(platformAdminRequest({ id: 1, role: 'admin' })).allowed,
      true,
      'platform administration remains outside organization expiry'
    );
    db.prepare(`
      INSERT INTO organization_subscription_terms (id,org_id,term_version,expires_at)
      VALUES (4,20,2,'2000-01-01T00:00:00Z')
    `).run();
    assert.equal(
      service.authorize(crmCustomerRequest({ id: 2, role: 'user' }, 20, 'update')).code,
      'ACTION_FORBIDDEN',
      'role denial keeps precedence over subscription state'
    );
  } finally {
    db.close();
  }
});

test('uses one authoritative time and subscription snapshot at the exact expiry boundary', () => {
  const fixture = createFixture();
  const { db } = fixture;
  try {
    db.prepare(`
      INSERT INTO organization_subscription_terms (id,org_id,term_version,expires_at)
      VALUES (3,10,2,'2026-09-20T12:00:00Z')
    `).run();
    let clockReads = 0;
    const { createModuleActionPermissionService } = loadService();
    const service = createModuleActionPermissionService(db, {
      now() {
        clockReads += 1;
        return Date.parse('2026-09-20T12:00:00Z');
      }
    });
    const modules = [
      'crm.customer',
      'crm.opportunity',
      'crm.contact',
      'crm.task',
      'campaign.performance',
      'campaign.customer_report',
      'influencer.data'
    ];
    const batch = service.projectModulesAccess({
      principal: { id: 2, role: 'user' },
      organizationId: 10,
      modules
    });
    assert.equal(batch.allowed, true);
    assert.equal(batch.subscription.status, 'expired', 'expires_at equal to admission time is expired');
    assert.equal(clockReads, 1, 'the entire projection uses one server clock snapshot');
    assert.deepEqual(batch.projections.map((projection) => projection.actions), modules.map(() => []));

    db.prepare(`
      INSERT INTO organization_plan_assignments (id,org_id,plan_code,assignment_version)
      VALUES (4,10,'crm_core',2)
    `).run();
    assert.equal(
      service.authorize(campaignPerformanceRequest({ id: 2, role: 'user' }, 10, 'export')).code,
      'PLAN_ENTITLEMENT_REQUIRED',
      'plan denial takes precedence when both plan and subscription deny the action'
    );
  } finally {
    db.close();
  }
});

test('fails closed when current subscription facts are missing or duplicated', () => {
  for (const mutate of [
    (db) => db.prepare('DELETE FROM organization_subscription_terms WHERE org_id=10').run(),
    (db) => db.prepare(`
      INSERT INTO organization_subscription_terms (id,org_id,term_version,expires_at)
      VALUES (3,10,1,NULL)
    `).run(),
    (db) => db.exec('DROP TABLE organization_subscription_terms')
  ]) {
    const { db, service } = createFixture();
    try {
      mutate(db);
      assert.deepEqual(
        service.authorize(crmCustomerRequest({ id: 2, role: 'user' }, 10, 'read')),
        { allowed: false, code: 'ENTITLEMENT_POLICY_UNAVAILABLE' }
      );
    } finally {
      db.close();
    }
  }
});

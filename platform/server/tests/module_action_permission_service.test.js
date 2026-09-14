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
    INSERT INTO users (id, role, is_active) VALUES
      (1, 'admin', 1),
      (2, 'user', 1),
      (3, 'admin', 0),
      (4, 'user', 1);
    INSERT INTO organization_memberships (org_id, user_id, role_code, status) VALUES
      (10, 1, 'org_admin', 'active'),
      (10, 2, 'org_admin', 'active'),
      (10, 3, 'org_admin', 'active'),
      (10, 4, 'member', 'active');
    INSERT INTO team_memberships (org_id, team_id, user_id, role_code, status) VALUES
      (10, 100, 1, 'team_lead', 'active'),
      (10, 100, 2, 'team_lead', 'active'),
      (10, 101, 2, 'member', 'active'),
      (10, 100, 3, 'team_lead', 'active'),
      (10, 101, 4, 'member', 'active');
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

test('allows the declared platform administration action for an active live platform admin', () => {
  const { db, service } = createFixture();
  try {
    const decision = service.authorize(platformAdminRequest({ id: 1, role: 'admin' }));

    assert.deepEqual(decision, {
      allowed: true,
      code: 'ALLOWED',
      principal: {
        user_id: 1,
        roles: ['platform_admin', 'administrator', 'manager', 'member']
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
        roles: ['administrator', 'manager', 'member']
      }
    });
  } finally {
    db.close();
  }
});

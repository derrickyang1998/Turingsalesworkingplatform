'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const service = require('../services/crm_customer_service');

const SERVER_ROOT = path.resolve(__dirname, '..');
const FIXED_AT = '2026-08-09 00:00:00';
const IDS = Object.freeze({
  orgA: 101,
  orgB: 102,
  teamA1: 1001,
  teamA2: 1002,
  teamB1: 2001,
  ownerA: 101,
  teammateA: 102,
  orgAdminA: 103,
  originatorA: 104,
  barePlatformAdmin: 105,
  outsiderB: 106,
  revokedA: 107,
  noTeamA: 108,
  inactiveOwnerA: 109,
  ownedA: 10001,
  transferredA: 10002,
  teammateOwnedA: 10003,
  publicA: 10004,
  quarantinedA: 10005,
  inactiveOwnedA: 10006,
  ownedB: 20001
});

const REGISTERED_MIGRATIONS = Object.freeze([
  ['002_campaign_business_spine', 'campaign_business_spine'],
  ['003_campaign_workflow_dispatch_evidence', 'campaign_workflow_dispatch_evidence'],
  ['004_knowledge_capacity_observability', 'knowledge_capacity_observability'],
  ['005_knowledge_custody_projection', 'knowledge_custody_projection'],
  ['006_crm_sales_workspace', 'crm_sales_workspace']
].map(([name, fileName], index) => Object.freeze({
  version: index + 2,
  name,
  sourcePath: `migrations/00${index + 2}_${fileName}.js`,
  engineVersion: 1,
  dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
})));

function insertUser(db, id, username, role = 'user') {
  db.prepare(`
    INSERT INTO users (
      id,username,password_hash,display_name,role,email,department,
      api_quota,created_at,is_active
    ) VALUES (?,?,?,?,?,?,?,?,?,1)
  `).run(
    id,
    username,
    'not-used-by-tests',
    username,
    role,
    `${username}@example.invalid`,
    'sales',
    50000,
    FIXED_AT
  );
}

function insertOrganizationMembership(db, orgId, userId, roleCode = 'member', status = 'active') {
  db.prepare(`
    INSERT INTO organization_memberships (
      org_id,user_id,role_code,status,created_at,revoked_at
    ) VALUES (?,?,?,?,?,?)
  `).run(orgId, userId, roleCode, status, FIXED_AT, status === 'active' ? null : FIXED_AT);
}

function insertTeamMembership(db, orgId, teamId, userId, status = 'active') {
  db.prepare(`
    INSERT INTO team_memberships (
      org_id,team_id,user_id,role_code,status,created_at,revoked_at
    ) VALUES (?,?,?,?,?,?,?)
  `).run(orgId, teamId, userId, 'member', status, FIXED_AT, status === 'active' ? null : FIXED_AT);
}

function insertCustomer(db, {
  id,
  orgId,
  teamId,
  createdBy,
  assignedTo,
  isPublic,
  brandName
}) {
  db.prepare(`
    INSERT INTO customers (
      id,brand_name,company_name,stage,created_by,assigned_to,
      created_at,updated_at,is_public,priority,org_id,team_id,duplicate_enforced
    ) VALUES (?,?,?,'lead',?,?, ?,?,?,'medium',?,?,0)
  `).run(
    id,
    brandName,
    `${brandName} Company`,
    createdBy,
    assignedTo,
    FIXED_AT,
    FIXED_AT,
    isPublic,
    orgId,
    teamId
  );
}

function openFixture(t) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  t.after(() => {
    if (db.open) db.close();
  });

  assert.deepEqual(migrationService.runMigrations(db, {
    rootDir: SERVER_ROOT,
    registeredMigrations: REGISTERED_MIGRATIONS
  }), { status: 'managed', currentVersion: 6 });

  db.prepare('INSERT INTO organizations (id,code,name,created_at) VALUES (?,?,?,?)')
    .run(IDS.orgA, 'mutation-org-a', 'Mutation Organization A', FIXED_AT);
  db.prepare('INSERT INTO organizations (id,code,name,created_at) VALUES (?,?,?,?)')
    .run(IDS.orgB, 'mutation-org-b', 'Mutation Organization B', FIXED_AT);
  db.prepare('INSERT INTO teams (id,org_id,code,name,created_at) VALUES (?,?,?,?,?)')
    .run(IDS.teamA1, IDS.orgA, 'mutation-a1', 'Mutation Team A1', FIXED_AT);
  db.prepare('INSERT INTO teams (id,org_id,code,name,created_at) VALUES (?,?,?,?,?)')
    .run(IDS.teamA2, IDS.orgA, 'mutation-a2', 'Mutation Team A2', FIXED_AT);
  db.prepare('INSERT INTO teams (id,org_id,code,name,created_at) VALUES (?,?,?,?,?)')
    .run(IDS.teamB1, IDS.orgB, 'mutation-b1', 'Mutation Team B1', FIXED_AT);

  for (const [id, username, role] of [
    [IDS.ownerA, 'mutation-owner-a', 'user'],
    [IDS.teammateA, 'mutation-teammate-a', 'user'],
    [IDS.orgAdminA, 'mutation-org-admin-a', 'user'],
    [IDS.originatorA, 'mutation-originator-a', 'user'],
    [IDS.barePlatformAdmin, 'mutation-bare-platform-admin', 'admin'],
    [IDS.outsiderB, 'mutation-outsider-b', 'user'],
    [IDS.revokedA, 'mutation-revoked-a', 'user'],
    [IDS.noTeamA, 'mutation-no-team-a', 'user'],
    [IDS.inactiveOwnerA, 'mutation-inactive-owner-a', 'user']
  ]) insertUser(db, id, username, role);
  db.prepare('UPDATE users SET is_active=0 WHERE id=?').run(IDS.inactiveOwnerA);

  for (const [userId, roleCode] of [
    [IDS.ownerA, 'member'],
    [IDS.teammateA, 'member'],
    [IDS.orgAdminA, 'org_admin'],
    [IDS.originatorA, 'member'],
    [IDS.noTeamA, 'member'],
    [IDS.inactiveOwnerA, 'member']
  ]) insertOrganizationMembership(db, IDS.orgA, userId, roleCode);
  insertOrganizationMembership(db, IDS.orgA, IDS.revokedA, 'member', 'revoked');
  insertOrganizationMembership(db, IDS.orgB, IDS.outsiderB);

  for (const [orgId, teamId, userId] of [
    [IDS.orgA, IDS.teamA1, IDS.ownerA],
    [IDS.orgA, IDS.teamA1, IDS.teammateA],
    [IDS.orgA, IDS.teamA1, IDS.orgAdminA],
    [IDS.orgA, IDS.teamA1, IDS.inactiveOwnerA],
    [IDS.orgA, IDS.teamA2, IDS.originatorA],
    [IDS.orgB, IDS.teamB1, IDS.outsiderB]
  ]) insertTeamMembership(db, orgId, teamId, userId);
  insertTeamMembership(db, IDS.orgA, IDS.teamA1, IDS.revokedA, 'revoked');

  for (const customer of [
    { id: IDS.ownedA, orgId: IDS.orgA, teamId: IDS.teamA1, createdBy: IDS.ownerA, assignedTo: IDS.ownerA, isPublic: 0, brandName: 'Owned A' },
    { id: IDS.transferredA, orgId: IDS.orgA, teamId: IDS.teamA1, createdBy: IDS.originatorA, assignedTo: IDS.ownerA, isPublic: 0, brandName: 'Transferred A' },
    { id: IDS.teammateOwnedA, orgId: IDS.orgA, teamId: IDS.teamA1, createdBy: IDS.teammateA, assignedTo: IDS.teammateA, isPublic: 0, brandName: 'Teammate A' },
    { id: IDS.publicA, orgId: IDS.orgA, teamId: null, createdBy: IDS.ownerA, assignedTo: null, isPublic: 1, brandName: 'Public A' },
    { id: IDS.quarantinedA, orgId: IDS.orgA, teamId: null, createdBy: IDS.ownerA, assignedTo: IDS.ownerA, isPublic: 0, brandName: 'Quarantined A' },
    { id: IDS.inactiveOwnedA, orgId: IDS.orgA, teamId: IDS.teamA1, createdBy: IDS.inactiveOwnerA, assignedTo: IDS.inactiveOwnerA, isPublic: 0, brandName: 'Inactive Owned A' },
    { id: IDS.ownedB, orgId: IDS.orgB, teamId: IDS.teamB1, createdBy: IDS.outsiderB, assignedTo: IDS.outsiderB, isPublic: 0, brandName: 'Owned B' }
  ]) insertCustomer(db, customer);

  return db;
}

function customerUpdate(actorUserId, customerId, overrides = {}) {
  return {
    actorUserId,
    organizationId: IDS.orgA,
    requestId: 'mutation-request',
    correlationId: 'mutation-flow',
    command: {
      mode: 'update',
      customerId,
      values: { brand_name: 'Updated Brand' }
    },
    ...overrides
  };
}

function publicError(error) {
  return JSON.parse(JSON.stringify(error));
}

function captureError(callback) {
  try {
    callback();
  } catch (error) {
    return error;
  }
  assert.fail('expected CRM mutation error');
}

test('envelope: mutation service exposes the frozen S4 command boundary', () => {
  assert.deepEqual(Object.keys(service), [
    'CrmMutationError',
    'createOrUpdateCustomer',
    'transitionCustomerLifecycle',
    'mutateCustomerCustody',
    'createOrUpdateOpportunity',
    'mutateCustomerContact',
    'mutateCrmTask',
    'archiveCustomerResult',
    'recordCustomerActivity'
  ]);
});

test('envelope: structural snapshots reject hostile containers before database access', () => {
  let getterHits = 0;
  let transactionHits = 0;
  const db = {
    transaction() {
      transactionHits += 1;
      throw new Error('database should not be reached');
    }
  };
  const options = {};
  Object.defineProperty(options, 'actorUserId', {
    enumerable: true,
    get() {
      getterHits += 1;
      return IDS.ownerA;
    }
  });
  options.organizationId = IDS.orgA;
  options.command = { mode: 'create', values: {} };

  const accessorError = captureError(() => service.createOrUpdateCustomer(db, options));
  assert.equal(accessorError.code, 'CRM_MUTATION_INVALID');
  assert.equal(getterHits, 0);
  assert.equal(transactionHits, 0);

  const proxy = new Proxy(customerUpdate(IDS.ownerA, IDS.ownedA), {
    get() {
      getterHits += 1;
      throw new Error('proxy get trap must not run');
    }
  });
  const proxyError = captureError(() => service.createOrUpdateCustomer(db, proxy));
  assert.equal(proxyError.code, 'CRM_MUTATION_INVALID');
  assert.equal(getterHits, 0);

  const unknownOuter = customerUpdate(IDS.ownerA, IDS.ownedA);
  unknownOuter.hidden = true;
  const symbolOuter = customerUpdate(IDS.ownerA, IDS.ownedA);
  symbolOuter[Symbol('hidden')] = true;
  const sparseTags = customerUpdate(IDS.ownerA, IDS.ownedA);
  sparseTags.command.values.tags = new Array(1);
  const nonPlainValue = customerUpdate(IDS.ownerA, IDS.ownedA);
  nonPlainValue.command.values.brand_name = new Date(0);

  for (const hostile of [unknownOuter, symbolOuter, sparseTags, nonPlainValue]) {
    const error = captureError(() => service.createOrUpdateCustomer(db, hostile));
    assert.equal(error.code, 'CRM_MUTATION_INVALID');
  }
  assert.equal(transactionHits, 0);
});

test('envelope: request and correlation identifiers enforce exact bounds and safe characters', (t) => {
  const db = openFixture(t);
  const validRequest = 'r'.repeat(120);
  const validCorrelation = 'c'.repeat(128);
  const allowed = captureError(() => service.createOrUpdateCustomer(db, customerUpdate(
    IDS.ownerA,
    IDS.ownedA,
    { requestId: validRequest, correlationId: validCorrelation }
  )));
  assert.equal(allowed.code, 'CRM_MUTATION_INVALID');

  for (const [field, value] of [
    ['requestId', 'r'.repeat(121)],
    ['correlationId', 'c'.repeat(129)],
    ['requestId', 'unsafe request'],
    ['correlationId', 'unsafe\nflow']
  ]) {
    const error = captureError(() => service.createOrUpdateCustomer(db, customerUpdate(
      IDS.ownerA,
      IDS.ownedA,
      { [field]: value }
    )));
    assert.equal(error.code, 'CRM_MUTATION_INVALID');
  }
  assert.equal(db.inTransaction, false);
});

test('authorization: missing and wrong-organization customers are concealed identically', (t) => {
  const db = openFixture(t);
  const missing = captureError(() => service.createOrUpdateCustomer(
    db,
    customerUpdate(IDS.ownerA, 999999)
  ));
  const wrongOrganization = captureError(() => service.createOrUpdateCustomer(
    db,
    customerUpdate(IDS.ownerA, IDS.ownedB)
  ));
  assert.deepEqual(publicError(missing), publicError(wrongOrganization));
  assert.equal(missing.code, 'CRM_CUSTOMER_NOT_FOUND');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM crm_audit_events WHERE event_type='mutation_denied'").get().count, 0);
  assert.equal(db.inTransaction, false);
});

test('authorization: semantic payload validation follows aggregate authorization', (t) => {
  const db = openFixture(t);
  const options = customerUpdate(IDS.ownerA, IDS.ownedB);
  options.command.values.brand_name = 'x'.repeat(5000);
  const error = captureError(() => service.createOrUpdateCustomer(db, options));
  assert.equal(error.code, 'CRM_CUSTOMER_NOT_FOUND');
  assert.equal(db.inTransaction, false);
});

test('authorization: same-organization profile denial commits one bounded audit event', (t) => {
  const db = openFixture(t);
  const error = captureError(() => service.createOrUpdateCustomer(
    db,
    customerUpdate(IDS.teammateA, IDS.ownedA)
  ));
  assert.equal(error.code, 'CRM_CUSTOMER_FORBIDDEN');
  assert.equal(error.status, 403);
  assert.equal(db.inTransaction, false);

  const events = db.prepare(`
    SELECT customer_id,actor_user_id,event_type,metadata_json
    FROM crm_audit_events
    WHERE event_type='mutation_denied'
  `).all();
  assert.deepEqual(events, [{
    customer_id: null,
    actor_user_id: IDS.teammateA,
    event_type: 'mutation_denied',
    metadata_json: '{"operation":"customer_update","outcome":"forbidden"}'
  }]);
});

test('authorization: owner and organization admin reach the bounded Task 1 command stub', (t) => {
  const db = openFixture(t);
  for (const actorUserId of [IDS.ownerA, IDS.orgAdminA]) {
    const error = captureError(() => service.createOrUpdateCustomer(
      db,
      customerUpdate(actorUserId, IDS.ownedA)
    ));
    assert.equal(error.code, 'CRM_MUTATION_INVALID');
    assert.equal(error.status, 400);
  }
  assert.equal(db.inTransaction, false);
});

test('authorization: transferred originator has no retained profile authority', (t) => {
  const db = openFixture(t);
  const error = captureError(() => service.createOrUpdateCustomer(
    db,
    customerUpdate(IDS.originatorA, IDS.transferredA)
  ));
  assert.equal(error.code, 'CRM_CUSTOMER_FORBIDDEN');
});

test('authorization: public and quarantined custody expose only their approved commands', (t) => {
  const db = openFixture(t);
  const publicProfile = captureError(() => service.createOrUpdateCustomer(
    db,
    customerUpdate(IDS.ownerA, IDS.publicA)
  ));
  assert.equal(publicProfile.code, 'CRM_CUSTOMER_FORBIDDEN');

  const claim = captureError(() => service.mutateCustomerCustody(db, {
    actorUserId: IDS.teammateA,
    organizationId: IDS.orgA,
    command: { action: 'claim', customerId: IDS.publicA, team_id: IDS.teamA1 }
  }));
  assert.equal(claim.code, 'CRM_MUTATION_INVALID');

  const ordinaryRepair = captureError(() => service.mutateCustomerCustody(db, {
    actorUserId: IDS.ownerA,
    organizationId: IDS.orgA,
    command: {
      action: 'repair',
      customerId: IDS.quarantinedA,
      assigned_to: IDS.ownerA,
      team_id: IDS.teamA1,
      reason_code: 'legacy_custody_repair'
    }
  }));
  assert.equal(ordinaryRepair.code, 'CRM_CUSTOMER_FORBIDDEN');

  const adminRepair = captureError(() => service.mutateCustomerCustody(db, {
    actorUserId: IDS.orgAdminA,
    organizationId: IDS.orgA,
    command: {
      action: 'repair',
      customerId: IDS.quarantinedA,
      assigned_to: IDS.ownerA,
      team_id: IDS.teamA1,
      reason_code: 'legacy_custody_repair'
    }
  }));
  assert.equal(adminRepair.code, 'CRM_MUTATION_INVALID');
});

test('authorization: inactive owner custody matches the read-model quarantine policy', (t) => {
  const db = openFixture(t);
  const profile = captureError(() => service.createOrUpdateCustomer(
    db,
    customerUpdate(IDS.orgAdminA, IDS.inactiveOwnedA)
  ));
  assert.equal(profile.code, 'CRM_CUSTOMER_FORBIDDEN');

  const repair = captureError(() => service.mutateCustomerCustody(db, {
    actorUserId: IDS.orgAdminA,
    organizationId: IDS.orgA,
    command: {
      action: 'repair',
      customerId: IDS.inactiveOwnedA,
      assigned_to: IDS.ownerA,
      team_id: IDS.teamA1,
      reason_code: 'legacy_custody_repair'
    }
  }));
  assert.equal(repair.code, 'CRM_MUTATION_INVALID');
});

test('authorization: create authority is self-owned for members and delegated for organization admins', (t) => {
  const db = openFixture(t);
  const selfCreate = captureError(() => service.createOrUpdateCustomer(db, {
    actorUserId: IDS.ownerA,
    organizationId: IDS.orgA,
    command: {
      mode: 'create',
      values: { brand_name: 'Self Create', assigned_to: IDS.ownerA, team_id: IDS.teamA1 }
    }
  }));
  assert.equal(selfCreate.code, 'CRM_MUTATION_INVALID');

  const delegatedMember = captureError(() => service.createOrUpdateCustomer(db, {
    actorUserId: IDS.ownerA,
    organizationId: IDS.orgA,
    command: {
      mode: 'create',
      values: { brand_name: 'Delegated Member', assigned_to: IDS.teammateA, team_id: IDS.teamA1 }
    }
  }));
  assert.equal(delegatedMember.code, 'CRM_CUSTOMER_FORBIDDEN');

  const delegatedUnknownTarget = captureError(() => service.createOrUpdateCustomer(db, {
    actorUserId: IDS.ownerA,
    organizationId: IDS.orgA,
    command: {
      mode: 'create',
      values: { brand_name: 'Unknown Target', assigned_to: IDS.outsiderB, team_id: IDS.teamB1 }
    }
  }));
  assert.equal(delegatedUnknownTarget.code, 'CRM_CUSTOMER_FORBIDDEN');

  const delegatedAdmin = captureError(() => service.createOrUpdateCustomer(db, {
    actorUserId: IDS.orgAdminA,
    organizationId: IDS.orgA,
    command: {
      mode: 'create',
      values: { brand_name: 'Delegated Admin', assigned_to: IDS.teammateA, team_id: IDS.teamA1 }
    }
  }));
  assert.equal(delegatedAdmin.code, 'CRM_MUTATION_INVALID');
});

test('authorization: target assignment must be active and in the selected organization', (t) => {
  const db = openFixture(t);
  const valid = captureError(() => service.mutateCustomerCustody(db, {
    actorUserId: IDS.orgAdminA,
    organizationId: IDS.orgA,
    command: {
      action: 'transfer',
      customerId: IDS.ownedA,
      assigned_to: IDS.teammateA,
      team_id: IDS.teamA1,
      reason_code: 'manager_assignment'
    }
  }));
  assert.equal(valid.code, 'CRM_MUTATION_INVALID');

  const crossOrganization = captureError(() => service.mutateCustomerCustody(db, {
    actorUserId: IDS.orgAdminA,
    organizationId: IDS.orgA,
    command: {
      action: 'transfer',
      customerId: IDS.ownedA,
      assigned_to: IDS.outsiderB,
      team_id: IDS.teamB1,
      reason_code: 'manager_assignment'
    }
  }));
  assert.equal(crossOrganization.code, 'CRM_MUTATION_INVALID');
});

test('authorization: unavailable membership contexts fail closed without audit writes', (t) => {
  const db = openFixture(t);
  for (const actorUserId of [IDS.barePlatformAdmin, IDS.revokedA, IDS.noTeamA]) {
    const error = captureError(() => service.createOrUpdateCustomer(
      db,
      customerUpdate(actorUserId, IDS.ownedA)
    ));
    assert.equal(error.code, 'CRM_CUSTOMER_NOT_FOUND');
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM crm_audit_events WHERE event_type='mutation_denied'").get().count, 0);
});

test('transaction: sqlite busy and unexpected failures serialize to bounded public errors', () => {
  function failingDb(code, message) {
    return {
      transaction() {
        const transaction = () => undefined;
        transaction.immediate = () => {
          const error = new Error(message);
          error.name = 'SqliteError';
          error.code = code;
          throw error;
        };
        return transaction;
      }
    };
  }

  const options = {
    actorUserId: IDS.ownerA,
    organizationId: IDS.orgA,
    command: {
      mode: 'create',
      values: { brand_name: 'Failure', assigned_to: IDS.ownerA, team_id: IDS.teamA1 }
    }
  };
  const busy = captureError(() => service.createOrUpdateCustomer(
    failingDb('SQLITE_BUSY', 'secret busy database path'),
    options
  ));
  assert.deepEqual(publicError(busy), {
    code: 'CRM_STORAGE_BUSY',
    status: 503,
    title: 'CRM storage is temporarily unavailable',
    details: null,
    retryable: true
  });

  const failed = captureError(() => service.createOrUpdateCustomer(
    failingDb('SQLITE_ERROR', 'secret SQL and schema'),
    options
  ));
  assert.deepEqual(publicError(failed), {
    code: 'CRM_MUTATION_FAILED',
    status: 500,
    title: 'CRM mutation failed',
    details: null
  });
  assert.equal(JSON.stringify(publicError(failed)).includes('secret'), false);
});

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Worker } = require('node:worker_threads');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const service = require('../services/crm_customer_service');
const { buildCustomerIdentity } = require('../services/crm_contract');

const SERVER_ROOT = path.resolve(__dirname, '..');
const FIXED_AT = '2026-08-09 00:00:00';
const FUTURE_AT = '2099-01-01 09:00:00';
const PAST_AT = '2000-01-01 09:00:00';
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
  ownedB: 20001,
  leadA: 30001,
  leadB: 30002,
  leadDuplicate: 30003,
  leadRollback: 30004,
  taskDirect: 50001,
  taskLinked: 50002,
  taskCompleted: 50003,
  taskCancelled: 50004,
  taskUnrelated: 50005
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

function seedFixture(db) {
  db.pragma('foreign_keys = ON');
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

}

function openFixture(t) {
  const db = new Database(':memory:');
  t.after(() => {
    if (db.open) db.close();
  });
  seedFixture(db);
  return db;
}

function insertLead(db, {
  id,
  assignedTo,
  brandName,
  companyName = null,
  status = 'new',
  convertedCustomerId = null
}) {
  db.prepare(`
    INSERT INTO leads (
      id,brand_name,company_name,contact_person,contact_info,source,
      industry,status,assigned_to,notes,converted_customer_id,
      created_at,updated_at
    ) VALUES (?,?,?,?,?,'manual','consumer',?,?,?, ?,?,?)
  `).run(
    id,
    brandName,
    companyName,
    'Lead Contact',
    'lead@example.invalid',
    status,
    assignedTo,
    'Lead notes',
    convertedCustomerId,
    FIXED_AT,
    FIXED_AT
  );
}

function createFileFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'turingmarket-crm-s4-'));
  const databasePath = path.join(directory, 'crm.sqlite');
  const db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 10000');
  seedFixture(db);
  db.close();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return databasePath;
}

const MUTATION_WORKER_SOURCE = String.raw`
  'use strict';
  const { parentPort, workerData } = require('node:worker_threads');
  const Database = require(workerData.databaseModulePath);
  const customerService = require(workerData.servicePath);
  const db = new Database(workerData.databasePath);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 10000');
  parentPort.postMessage({ type: 'ready' });
  parentPort.once('message', () => {
    try {
      const operation = workerData.operation || 'createOrUpdateCustomer';
      parentPort.postMessage({
        type: 'result',
        value: customerService[operation](db, workerData.options)
      });
    } catch (error) {
      parentPort.postMessage({
        type: 'result',
        value: typeof error.toJSON === 'function' ? error.toJSON() : { code: 'WORKER_FAILURE' }
      });
    } finally {
      db.close();
    }
  });
`;

function createMutationWorker(databasePath, options, operation = 'createOrUpdateCustomer') {
  const worker = new Worker(MUTATION_WORKER_SOURCE, {
    eval: true,
    workerData: {
      databaseModulePath: require.resolve('better-sqlite3'),
      servicePath: path.resolve(__dirname, '../services/crm_customer_service.js'),
      databasePath,
      options,
      operation
    }
  });
  let readyResolve;
  let readyReject;
  let resultResolve;
  let resultReject;
  let exitResolve;
  let exitReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const result = new Promise((resolve, reject) => {
    resultResolve = resolve;
    resultReject = reject;
  });
  const exited = new Promise((resolve, reject) => {
    exitResolve = resolve;
    exitReject = reject;
  });
  worker.on('message', (message) => {
    if (message && message.type === 'ready') readyResolve();
    if (message && message.type === 'result') resultResolve(message.value);
  });
  worker.on('error', (error) => {
    readyReject(error);
    resultReject(error);
    exitReject(error);
  });
  worker.on('exit', (code) => {
    if (code === 0) exitResolve();
    else exitReject(new Error(`mutation worker exited with code ${code}`));
  });
  return { worker, ready, result, exited };
}

async function runConcurrentCreates(databasePath, leftOptions, rightOptions) {
  const left = createMutationWorker(databasePath, leftOptions);
  const right = createMutationWorker(databasePath, rightOptions);
  await Promise.all([left.ready, right.ready]);
  left.worker.postMessage('go');
  right.worker.postMessage('go');
  const values = await Promise.all([left.result, right.result]);
  await Promise.all([left.exited, right.exited]);
  return values;
}

async function runConcurrentCustody(databasePath, leftOptions, rightOptions) {
  const left = createMutationWorker(databasePath, leftOptions, 'mutateCustomerCustody');
  const right = createMutationWorker(databasePath, rightOptions, 'mutateCustomerCustody');
  await Promise.all([left.ready, right.ready]);
  left.worker.postMessage('go');
  right.worker.postMessage('go');
  const values = await Promise.all([left.result, right.result]);
  await Promise.all([left.exited, right.exited]);
  return values;
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

function customerCreate(actorUserId, brandName, overrides = {}) {
  return {
    actorUserId,
    organizationId: IDS.orgA,
    requestId: `create-${brandName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    correlationId: 'customer-identity-flow',
    command: {
      mode: 'create',
      values: {
        brand_name: brandName,
        assigned_to: actorUserId,
        team_id: IDS.teamA1
      }
    },
    ...overrides
  };
}

function customerLifecycle(actorUserId, customerId, toStage, commandOverrides = {}) {
  return {
    actorUserId,
    organizationId: IDS.orgA,
    requestId: `lifecycle-${customerId}-${toStage}`,
    correlationId: 'customer-lifecycle-flow',
    command: {
      customerId,
      to_stage: toStage,
      ...commandOverrides
    }
  };
}

function insertOpportunity(db, {
  id,
  customerId,
  stage,
  orgId = IDS.orgA,
  teamId = IDS.teamA1,
  ownerUserId = IDS.ownerA
}) {
  db.prepare(`
    INSERT INTO opportunities (
      id,customer_id,name,stage,value,win_probability,created_by,
      created_at,updated_at,org_id,team_id,owner_user_id
    ) VALUES (?,?,?,?,1000,100,?,?,?,?,?,?)
  `).run(
    id,
    customerId,
    `Opportunity ${id}`,
    stage,
    ownerUserId,
    FIXED_AT,
    FIXED_AT,
    orgId,
    teamId,
    ownerUserId
  );
}

function insertCrmTask(db, {
  id,
  customerId,
  opportunityId = null,
  ownerUserId = IDS.ownerA,
  teamId = IDS.teamA1,
  status = 'open'
}) {
  const completed = status === 'completed';
  db.prepare(`
    INSERT INTO crm_tasks (
      id,org_id,team_id,customer_id,opportunity_id,owner_user_id,
      title,description,due_at,status,source,completed_at,completed_by,
      completion_note,created_by,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,NULL,?,?,?,?,?,NULL,?,?,?)
  `).run(
    id,
    IDS.orgA,
    teamId,
    customerId,
    opportunityId,
    ownerUserId,
    `Task ${id}`,
    FUTURE_AT,
    status,
    'manual',
    completed ? FIXED_AT : null,
    completed ? ownerUserId : null,
    ownerUserId,
    FIXED_AT,
    FIXED_AT
  );
}

function customerCustody(actorUserId, command, overrides = {}) {
  return {
    actorUserId,
    organizationId: IDS.orgA,
    requestId: `custody-${command.action}-${command.customerId}-${actorUserId}`,
    correlationId: 'customer-custody-flow',
    command,
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
  const allowed = service.createOrUpdateCustomer(db, customerUpdate(
    IDS.ownerA,
    IDS.ownedA,
    { requestId: validRequest, correlationId: validCorrelation }
  ));
  assert.equal(allowed.ok, true);
  assert.equal(allowed.action, 'updated');

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

test('authorization: owner and organization admin reach customer profile mutation', (t) => {
  const db = openFixture(t);
  for (const actorUserId of [IDS.ownerA, IDS.orgAdminA]) {
    const result = service.createOrUpdateCustomer(
      db,
      customerUpdate(actorUserId, IDS.ownedA)
    );
    assert.equal(result.ok, true);
    assert.equal(result.action, 'updated');
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

  const claim = service.mutateCustomerCustody(db, {
    actorUserId: IDS.teammateA,
    organizationId: IDS.orgA,
    command: { action: 'claim', customerId: IDS.publicA, team_id: IDS.teamA1 }
  });
  assert.equal(claim.action, 'claimed');

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

  const adminRepair = service.mutateCustomerCustody(db, {
    actorUserId: IDS.orgAdminA,
    organizationId: IDS.orgA,
    command: {
      action: 'repair',
      customerId: IDS.quarantinedA,
      assigned_to: IDS.ownerA,
      team_id: IDS.teamA1,
      reason_code: 'legacy_custody_repair'
    }
  });
  assert.equal(adminRepair.action, 'repaired');
});

test('authorization: inactive owner custody matches the read-model quarantine policy', (t) => {
  const db = openFixture(t);
  const profile = captureError(() => service.createOrUpdateCustomer(
    db,
    customerUpdate(IDS.orgAdminA, IDS.inactiveOwnedA)
  ));
  assert.equal(profile.code, 'CRM_CUSTOMER_FORBIDDEN');

  const repair = service.mutateCustomerCustody(db, {
    actorUserId: IDS.orgAdminA,
    organizationId: IDS.orgA,
    command: {
      action: 'repair',
      customerId: IDS.inactiveOwnedA,
      assigned_to: IDS.ownerA,
      team_id: IDS.teamA1,
      reason_code: 'legacy_custody_repair'
    }
  });
  assert.equal(repair.action, 'repaired');
});

test('authorization: create authority is self-owned for members and delegated for organization admins', (t) => {
  const db = openFixture(t);
  const selfCreate = service.createOrUpdateCustomer(db, {
    actorUserId: IDS.ownerA,
    organizationId: IDS.orgA,
    command: {
      mode: 'create',
      values: { brand_name: 'Self Create', assigned_to: IDS.ownerA, team_id: IDS.teamA1 }
    }
  });
  assert.equal(selfCreate.action, 'created');

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

  const delegatedAdmin = service.createOrUpdateCustomer(db, {
    actorUserId: IDS.orgAdminA,
    organizationId: IDS.orgA,
    command: {
      mode: 'create',
      values: { brand_name: 'Delegated Admin', assigned_to: IDS.teammateA, team_id: IDS.teamA1 }
    }
  });
  assert.equal(delegatedAdmin.action, 'created');
});

test('authorization: target assignment must be active and in the selected organization', (t) => {
  const db = openFixture(t);
  const valid = service.mutateCustomerCustody(db, {
    actorUserId: IDS.orgAdminA,
    organizationId: IDS.orgA,
    command: {
      action: 'transfer',
      customerId: IDS.ownedA,
      assigned_to: IDS.teammateA,
      team_id: IDS.teamA1,
      reason_code: 'manager_assignment'
    }
  });
  assert.equal(valid.action, 'transferred');

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

test('customer identity: self-owned create derives identity defaults evidence and a frozen result', (t) => {
  const db = openFixture(t);
  const options = customerCreate(IDS.ownerA, '  New Brand  ');
  Object.assign(options.command.values, {
    company_name: 'New Company',
    country: 'US',
    tags: 'fitness,home',
    priority: 'high'
  });

  const result = service.createOrUpdateCustomer(db, options);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.record), true);
  assert.equal(Object.isFrozen(result.meta), true);
  assert.deepEqual(Object.keys(result), ['ok', 'entity', 'action', 'record', 'meta']);
  assert.equal(result.ok, true);
  assert.equal(result.entity, 'customer');
  assert.equal(result.action, 'created');
  assert.deepEqual(result.meta, {
    request_id: options.requestId,
    correlation_id: options.correlationId
  });

  const row = db.prepare('SELECT * FROM customers WHERE id=?').get(result.record.id);
  assert.equal(row.brand_name, 'New Brand');
  assert.equal(row.company_name, 'New Company');
  assert.equal(row.stage, 'lead');
  assert.equal(row.priority, 'high');
  assert.equal(row.created_by, IDS.ownerA);
  assert.equal(row.assigned_to, IDS.ownerA);
  assert.equal(row.team_id, IDS.teamA1);
  assert.equal(row.org_id, IDS.orgA);
  assert.equal(row.is_public, 0);
  assert.equal(row.duplicate_enforced, 1);
  assert.equal(row.normalized_identity_key, buildCustomerIdentity({
    brand_name: 'New Brand',
    company_name: 'New Company'
  }).key);

  const activity = db.prepare('SELECT action,stage_from,stage_to,notes FROM customer_activity WHERE customer_id=?').get(row.id);
  assert.deepEqual(activity, {
    action: 'created',
    stage_from: null,
    stage_to: 'lead',
    notes: 'customer_created'
  });
  const audit = db.prepare("SELECT metadata_json FROM crm_audit_events WHERE customer_id=? AND event_type='customer_created'").get(row.id);
  assert.ok(audit);
  assert.equal(audit.metadata_json.includes('New Brand'), false);
});

test('customer identity: organization admin creates for a validated delegated assignment', (t) => {
  const db = openFixture(t);
  const options = customerCreate(IDS.orgAdminA, 'Delegated Brand');
  options.command.values.assigned_to = IDS.teammateA;
  options.command.values.team_id = IDS.teamA1;

  const result = service.createOrUpdateCustomer(db, options);
  assert.equal(result.action, 'created');
  assert.equal(result.record.assigned_to, IDS.teammateA);
  assert.equal(result.record.team_id, IDS.teamA1);
  assert.equal(db.prepare('SELECT created_by FROM customers WHERE id=?').get(result.record.id).created_by, IDS.orgAdminA);
});

test('customer identity: update merges the final identity and rejects client custody changes', (t) => {
  const db = openFixture(t);
  const before = db.prepare('SELECT * FROM customers WHERE id=?').get(IDS.ownedA);
  const result = service.createOrUpdateCustomer(db, {
    actorUserId: IDS.ownerA,
    organizationId: IDS.orgA,
    requestId: 'identity-update',
    correlationId: 'identity-flow',
    command: {
      mode: 'update',
      customerId: IDS.ownedA,
      values: { company_name: 'Merged Company', notes: 'Follow up next week' }
    }
  });
  assert.equal(result.action, 'updated');

  const updated = db.prepare('SELECT * FROM customers WHERE id=?').get(IDS.ownedA);
  assert.equal(updated.brand_name, before.brand_name);
  assert.equal(updated.company_name, 'Merged Company');
  assert.equal(updated.assigned_to, before.assigned_to);
  assert.equal(updated.team_id, before.team_id);
  assert.equal(updated.normalized_identity_key, buildCustomerIdentity({
    brand_name: before.brand_name,
    company_name: 'Merged Company'
  }).key);
  assert.equal(updated.duplicate_enforced, 1);
  assert.deepEqual(db.prepare('SELECT action,notes FROM customer_activity WHERE customer_id=? ORDER BY id DESC LIMIT 1').get(IDS.ownedA), {
    action: 'updated',
    notes: 'customer_profile_updated'
  });

  const custodyError = captureError(() => service.createOrUpdateCustomer(db, {
    actorUserId: IDS.ownerA,
    organizationId: IDS.orgA,
    command: {
      mode: 'update',
      customerId: IDS.ownedA,
      values: { assigned_to: IDS.teammateA, team_id: IDS.teamA1 }
    }
  }));
  assert.equal(custodyError.code, 'CRM_MUTATION_INVALID');
  assert.equal(db.prepare('SELECT assigned_to FROM customers WHERE id=?').get(IDS.ownedA).assigned_to, IDS.ownerA);
});

test('customer identity: another organization is neither a conflict nor an oracle', (t) => {
  const db = openFixture(t);
  const identity = buildCustomerIdentity({ brand_name: 'Cross Org Brand', company_name: 'Cross Org Company' }).key;
  db.prepare(`
    UPDATE customers
    SET brand_name='Cross Org Brand',company_name='Cross Org Company',
        normalized_identity_key=?,duplicate_enforced=1
    WHERE id=?
  `).run(identity, IDS.ownedB);

  const options = customerCreate(IDS.ownerA, 'Cross Org Brand');
  options.command.values.company_name = 'Cross Org Company';
  const result = service.createOrUpdateCustomer(db, options);
  assert.equal(result.action, 'created');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM customers WHERE org_id=? AND normalized_identity_key=?').get(IDS.orgA, identity).count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM customers WHERE org_id=? AND normalized_identity_key=?').get(IDS.orgB, identity).count, 1);
});

test('customer identity: duplicate disclosure precedence is readable then public pool then restricted', (t) => {
  const db = openFixture(t);
  const identity = buildCustomerIdentity({ brand_name: 'Collision Brand', company_name: 'Collision Company' }).key;
  const legacyStage = `legacy-private-stage-marker-${'x'.repeat(4096)}`;
  db.prepare(`
    UPDATE customers
    SET brand_name='Collision Brand',company_name='Collision Company',
        normalized_identity_key=?,duplicate_enforced=0,stage=?
    WHERE id IN (?,?,?)
  `).run(identity, legacyStage, IDS.ownedA, IDS.publicA, IDS.quarantinedA);

  const options = customerCreate(IDS.ownerA, 'Collision Brand');
  options.command.values.company_name = 'Collision Company';
  const readable = captureError(() => service.createOrUpdateCustomer(db, options));
  assert.deepEqual(publicError(readable), {
    code: 'CRM_CUSTOMER_DUPLICATE',
    status: 409,
    title: 'Customer identity conflicts with an existing record',
    details: {
      conflict: {
        visibility: 'readable',
        customer: { id: IDS.ownedA, display_name: 'Collision Brand', stage: 'legacy_unknown' }
      }
    }
  });
  const readablePayload = JSON.stringify(publicError(readable));
  assert.equal(readablePayload.includes(identity), false);
  assert.equal(readablePayload.includes('legacy-private-stage-marker'), false);
  assert.ok(readablePayload.length < 1024);

  db.prepare('UPDATE customers SET normalized_identity_key=NULL WHERE id=?').run(IDS.ownedA);
  const publicPool = captureError(() => service.createOrUpdateCustomer(db, options));
  assert.deepEqual(publicError(publicPool).details, {
    conflict: { visibility: 'public_pool', action: 'review_public_pool' }
  });

  db.prepare('UPDATE customers SET normalized_identity_key=NULL WHERE id=?').run(IDS.publicA);
  const restricted = captureError(() => service.createOrUpdateCustomer(db, options));
  assert.deepEqual(publicError(restricted).details, {
    conflict: { visibility: 'restricted' }
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM crm_audit_events WHERE event_type='duplicate_detected'").get().count, 3);
});

test('customer identity: failed rename commits duplicate evidence and rolls back customer activity', (t) => {
  const db = openFixture(t);
  const identity = buildCustomerIdentity({ brand_name: 'Rename Collision', company_name: 'Rename Company' }).key;
  db.prepare(`
    UPDATE customers
    SET brand_name='Rename Collision',company_name='Rename Company',
        normalized_identity_key=?,duplicate_enforced=0,stage='legacy_unknown'
    WHERE id=?
  `).run(identity, IDS.teammateOwnedA);
  const before = db.prepare('SELECT brand_name,company_name,normalized_identity_key FROM customers WHERE id=?').get(IDS.ownedA);
  const beforeActivity = db.prepare('SELECT COUNT(*) AS count FROM customer_activity WHERE customer_id=?').get(IDS.ownedA).count;

  const error = captureError(() => service.createOrUpdateCustomer(db, {
    actorUserId: IDS.ownerA,
    organizationId: IDS.orgA,
    requestId: 'rename-collision',
    command: {
      mode: 'update',
      customerId: IDS.ownedA,
      values: { brand_name: 'Rename Collision', company_name: 'Rename Company' }
    }
  }));
  assert.equal(error.code, 'CRM_CUSTOMER_DUPLICATE');
  assert.deepEqual(db.prepare('SELECT brand_name,company_name,normalized_identity_key FROM customers WHERE id=?').get(IDS.ownedA), before);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM customer_activity WHERE customer_id=?').get(IDS.ownedA).count, beforeActivity);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM crm_audit_events WHERE customer_id=? AND event_type='duplicate_detected'").get(IDS.ownedA).count, 1);
});

test('customer identity: omitted legacy profile values stay byte-stable and empty company is equivalent', (t) => {
  const db = openFixture(t);
  db.prepare(`
    UPDATE customers
    SET company_name='',contact_info='  legacy spacing  ',priority=NULL,
        normalized_identity_key=NULL,duplicate_enforced=0
    WHERE id=?
  `).run(IDS.ownedA);

  const updated = service.createOrUpdateCustomer(db, {
    actorUserId: IDS.ownerA,
    organizationId: IDS.orgA,
    command: {
      mode: 'update',
      customerId: IDS.ownedA,
      values: { notes: 'Only this field changes' }
    }
  });
  assert.equal(updated.action, 'updated');
  assert.deepEqual(db.prepare('SELECT company_name,contact_info,priority FROM customers WHERE id=?').get(IDS.ownedA), {
    company_name: '',
    contact_info: '  legacy spacing  ',
    priority: null
  });

  const first = customerCreate(IDS.ownerA, 'Empty Company Brand');
  service.createOrUpdateCustomer(db, first);
  const second = customerCreate(IDS.ownerA, 'Empty Company Brand');
  second.requestId = 'empty-company-duplicate';
  second.command.values.company_name = '';
  const duplicate = captureError(() => service.createOrUpdateCustomer(db, second));
  assert.equal(duplicate.code, 'CRM_CUSTOMER_DUPLICATE');
});

test('customer identity: terminal profile update remains unenforced beside an active duplicate', (t) => {
  const db = openFixture(t);
  const identity = buildCustomerIdentity({ brand_name: 'Shared Terminal Brand', company_name: 'Shared Company' }).key;
  db.prepare(`
    UPDATE customers
    SET brand_name='Shared Terminal Brand',company_name='Shared Company',
        normalized_identity_key=?,duplicate_enforced=1,stage='lead'
    WHERE id=?
  `).run(identity, IDS.teammateOwnedA);
  db.prepare("UPDATE customers SET stage='lost',duplicate_enforced=0 WHERE id=?").run(IDS.ownedA);

  const result = service.createOrUpdateCustomer(db, {
    actorUserId: IDS.ownerA,
    organizationId: IDS.orgA,
    command: {
      mode: 'update',
      customerId: IDS.ownedA,
      values: { brand_name: 'Shared Terminal Brand', company_name: 'Shared Company' }
    }
  });
  assert.equal(result.action, 'updated');
  assert.equal(result.record.stage, 'lost');
  assert.equal(db.prepare('SELECT duplicate_enforced FROM customers WHERE id=?').get(IDS.ownedA).duplicate_enforced, 0);
});

test('customer identity: audit failures roll back create and update without storage leakage', (t) => {
  const db = openFixture(t);
  const customerCount = db.prepare('SELECT COUNT(*) AS count FROM customers').get().count;
  const activityCount = db.prepare('SELECT COUNT(*) AS count FROM customer_activity').get().count;
  db.exec(`
    CREATE TRIGGER reject_customer_created_audit
    BEFORE INSERT ON crm_audit_events
    WHEN NEW.event_type='customer_created'
    BEGIN
      SELECT RAISE(ABORT,'secret audit create failure');
    END
  `);

  const createError = captureError(() => service.createOrUpdateCustomer(
    db,
    customerCreate(IDS.ownerA, 'Rollback Create Brand')
  ));
  assert.equal(createError.code, 'CRM_MUTATION_FAILED');
  assert.equal(JSON.stringify(publicError(createError)).includes('secret'), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM customers').get().count, customerCount);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM customer_activity').get().count, activityCount);

  db.exec('DROP TRIGGER reject_customer_created_audit');
  db.exec(`
    CREATE TRIGGER reject_customer_updated_audit
    BEFORE INSERT ON crm_audit_events
    WHEN NEW.event_type='customer_updated'
    BEGIN
      SELECT RAISE(ABORT,'secret audit update failure');
    END
  `);
  const before = db.prepare('SELECT brand_name,normalized_identity_key,updated_at FROM customers WHERE id=?').get(IDS.ownedA);
  const beforeActivity = db.prepare('SELECT COUNT(*) AS count FROM customer_activity WHERE customer_id=?').get(IDS.ownedA).count;
  const updateError = captureError(() => service.createOrUpdateCustomer(db, {
    actorUserId: IDS.ownerA,
    organizationId: IDS.orgA,
    command: {
      mode: 'update',
      customerId: IDS.ownedA,
      values: { brand_name: 'Rollback Update Brand' }
    }
  }));
  assert.equal(updateError.code, 'CRM_MUTATION_FAILED');
  assert.equal(JSON.stringify(publicError(updateError)).includes('secret'), false);
  assert.deepEqual(db.prepare('SELECT brand_name,normalized_identity_key,updated_at FROM customers WHERE id=?').get(IDS.ownedA), before);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM customer_activity WHERE customer_id=?').get(IDS.ownedA).count, beforeActivity);
});

test('customer identity: client provenance identity stage and timestamp fields never reach SQL', () => {
  let transactionHits = 0;
  const db = {
    transaction() {
      transactionHits += 1;
      throw new Error('database must not be reached');
    }
  };
  const forbidden = {
    created_by: IDS.ownerA,
    org_id: IDS.orgA,
    is_public: 0,
    normalized_identity_key: 'a'.repeat(64),
    duplicate_enforced: 1,
    stage: 'lead',
    updated_at: FIXED_AT
  };

  for (const [field, value] of Object.entries(forbidden)) {
    const options = customerCreate(IDS.ownerA, `Forbidden ${field}`);
    options.command.values[field] = value;
    const error = captureError(() => service.createOrUpdateCustomer(db, options));
    assert.equal(error.code, 'CRM_MUTATION_INVALID');
  }
  assert.equal(transactionHits, 0);
});

test('customer identity: concurrent equal creates produce one customer and one bounded conflict', async (t) => {
  const databasePath = createFileFixture(t);
  const left = customerCreate(IDS.ownerA, 'Concurrent Brand');
  left.requestId = 'concurrent-left';
  left.command.values.company_name = 'Concurrent Company';
  const right = customerCreate(IDS.ownerA, 'Concurrent Brand');
  right.requestId = 'concurrent-right';
  right.command.values.company_name = 'Concurrent Company';

  const outcomes = await runConcurrentCreates(databasePath, left, right);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.action || outcome.code).sort(),
    ['CRM_CUSTOMER_DUPLICATE', 'created']
  );
  const duplicate = outcomes.find((outcome) => outcome.code === 'CRM_CUSTOMER_DUPLICATE');
  assert.deepEqual(Object.keys(duplicate).sort(), ['code', 'details', 'status', 'title']);
  assert.equal(duplicate.status, 409);

  const db = new Database(databasePath, { readonly: true });
  try {
    const identity = buildCustomerIdentity({
      brand_name: 'Concurrent Brand',
      company_name: 'Concurrent Company'
    }).key;
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count
      FROM customers
      WHERE org_id=? AND normalized_identity_key=?
    `).get(IDS.orgA, identity).count, 1);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count
      FROM customer_activity ca
      JOIN customers c ON c.id=ca.customer_id
      WHERE c.org_id=? AND c.normalized_identity_key=? AND ca.action='created'
    `).get(IDS.orgA, identity).count, 1);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count
      FROM crm_audit_events
      WHERE request_id IN ('concurrent-left','concurrent-right')
        AND event_type='customer_created'
    `).get().count, 1);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count
      FROM crm_audit_events
      WHERE request_id IN ('concurrent-left','concurrent-right')
        AND event_type='duplicate_detected'
    `).get().count, 1);
  } finally {
    db.close();
  }
});

test('customer identity: owned lead conversion maps defaults and commits lead evidence atomically', (t) => {
  const db = openFixture(t);
  insertLead(db, {
    id: IDS.leadA,
    assignedTo: IDS.ownerA,
    brandName: 'Lead Brand',
    companyName: 'Lead Company'
  });
  const options = customerCreate(IDS.ownerA, 'unused');
  options.requestId = 'lead-conversion-success';
  options.command = {
    mode: 'create',
    sourceLeadId: IDS.leadA,
    values: {
      assigned_to: IDS.ownerA,
      team_id: IDS.teamA1,
      country: 'US',
      notes: 'Caller notes override the lead default'
    }
  };

  const result = service.createOrUpdateCustomer(db, options);
  assert.equal(result.action, 'created');
  assert.deepEqual(result.meta, {
    request_id: options.requestId,
    correlation_id: options.correlationId,
    source_lead_id: IDS.leadA
  });
  assert.equal(Object.isFrozen(result.meta), true);

  const customer = db.prepare(`
    SELECT brand_name,company_name,contact_person,contact_info,source,industry,
           notes,country,assigned_to,team_id
    FROM customers WHERE id=?
  `).get(result.record.id);
  assert.deepEqual(customer, {
    brand_name: 'Lead Brand',
    company_name: 'Lead Company',
    contact_person: 'Lead Contact',
    contact_info: 'lead@example.invalid',
    source: 'manual',
    industry: 'consumer',
    notes: 'Caller notes override the lead default',
    country: 'US',
    assigned_to: IDS.ownerA,
    team_id: IDS.teamA1
  });
  assert.deepEqual(db.prepare('SELECT status,converted_customer_id FROM leads WHERE id=?').get(IDS.leadA), {
    status: 'converted',
    converted_customer_id: result.record.id
  });
  const audit = db.prepare(`
    SELECT metadata_json FROM crm_audit_events
    WHERE request_id=? AND event_type='customer_created'
  `).get(options.requestId);
  assert.equal(JSON.parse(audit.metadata_json).source_lead_id, IDS.leadA);
});

test('customer identity: organization admin may convert an assigned same-organization lead', (t) => {
  const db = openFixture(t);
  insertLead(db, {
    id: IDS.leadB,
    assignedTo: IDS.teammateA,
    brandName: 'Delegated Lead',
    companyName: 'Delegated Company'
  });
  const options = customerCreate(IDS.orgAdminA, 'unused');
  options.requestId = 'lead-conversion-admin';
  options.command = {
    mode: 'create',
    sourceLeadId: IDS.leadB,
    values: { assigned_to: IDS.teammateA, team_id: IDS.teamA1 }
  };

  const result = service.createOrUpdateCustomer(db, options);
  assert.equal(result.action, 'created');
  assert.equal(result.record.assigned_to, IDS.teammateA);
  assert.equal(db.prepare('SELECT converted_customer_id FROM leads WHERE id=?').get(IDS.leadB).converted_customer_id, result.record.id);
});

test('customer identity: inaccessible unassigned and converted leads share the same concealed 404', (t) => {
  const db = openFixture(t);
  insertLead(db, {
    id: IDS.leadA,
    assignedTo: IDS.outsiderB,
    brandName: 'Foreign Lead'
  });
  insertLead(db, {
    id: IDS.leadB,
    assignedTo: null,
    brandName: 'Unassigned Lead'
  });
  insertLead(db, {
    id: IDS.leadDuplicate,
    assignedTo: IDS.ownerA,
    brandName: 'Converted Lead',
    status: 'converted',
    convertedCustomerId: IDS.ownedA
  });

  for (const sourceLeadId of [IDS.leadA, IDS.leadB, IDS.leadDuplicate]) {
    const options = customerCreate(IDS.ownerA, 'unused');
    options.requestId = `concealed-lead-${sourceLeadId}`;
    options.command = {
      mode: 'create',
      sourceLeadId,
      values: { assigned_to: IDS.ownerA, team_id: IDS.teamA1 }
    };
    const error = captureError(() => service.createOrUpdateCustomer(db, options));
    assert.deepEqual(publicError(error), {
      code: 'CRM_CUSTOMER_NOT_FOUND',
      status: 404,
      title: 'CRM customer was not found',
      details: null
    });
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM crm_audit_events WHERE request_id LIKE 'concealed-lead-%'").get().count, 0);
});

test('customer identity: duplicate lead conversion commits conflict evidence and leaves the lead open', (t) => {
  const db = openFixture(t);
  db.prepare(`
    UPDATE customers
    SET normalized_identity_key=?,duplicate_enforced=1
    WHERE id=?
  `).run(buildCustomerIdentity({
    brand_name: 'Owned A',
    company_name: 'Owned A Company'
  }).key, IDS.ownedA);
  insertLead(db, {
    id: IDS.leadDuplicate,
    assignedTo: IDS.ownerA,
    brandName: 'Owned A',
    companyName: 'Owned A Company'
  });
  const beforeCustomers = db.prepare('SELECT COUNT(*) AS count FROM customers').get().count;
  const beforeActivity = db.prepare('SELECT COUNT(*) AS count FROM customer_activity').get().count;
  const options = customerCreate(IDS.ownerA, 'unused');
  options.requestId = 'lead-conversion-duplicate';
  options.command = {
    mode: 'create',
    sourceLeadId: IDS.leadDuplicate,
    values: { assigned_to: IDS.ownerA, team_id: IDS.teamA1 }
  };

  const error = captureError(() => service.createOrUpdateCustomer(db, options));
  assert.equal(error.code, 'CRM_CUSTOMER_DUPLICATE');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM customers').get().count, beforeCustomers);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM customer_activity').get().count, beforeActivity);
  assert.deepEqual(db.prepare('SELECT status,converted_customer_id FROM leads WHERE id=?').get(IDS.leadDuplicate), {
    status: 'new',
    converted_customer_id: null
  });
  const audit = db.prepare(`
    SELECT metadata_json FROM crm_audit_events
    WHERE request_id=? AND event_type='duplicate_detected'
  `).get(options.requestId);
  assert.equal(JSON.parse(audit.metadata_json).source_lead_id, IDS.leadDuplicate);
});

test('customer identity: lead conversion audit failure rolls customer activity and lead state back', (t) => {
  const db = openFixture(t);
  insertLead(db, {
    id: IDS.leadRollback,
    assignedTo: IDS.ownerA,
    brandName: 'Rollback Lead',
    companyName: 'Rollback Lead Company'
  });
  const beforeCustomers = db.prepare('SELECT COUNT(*) AS count FROM customers').get().count;
  const beforeActivity = db.prepare('SELECT COUNT(*) AS count FROM customer_activity').get().count;
  const beforeAudit = db.prepare('SELECT COUNT(*) AS count FROM crm_audit_events').get().count;
  db.exec(`
    CREATE TRIGGER reject_lead_conversion_audit
    BEFORE INSERT ON crm_audit_events
    WHEN NEW.event_type='customer_created'
    BEGIN
      SELECT RAISE(ABORT,'secret lead audit failure');
    END
  `);
  const options = customerCreate(IDS.ownerA, 'unused');
  options.requestId = 'lead-conversion-rollback';
  options.command = {
    mode: 'create',
    sourceLeadId: IDS.leadRollback,
    values: { assigned_to: IDS.ownerA, team_id: IDS.teamA1 }
  };

  const error = captureError(() => service.createOrUpdateCustomer(db, options));
  assert.equal(error.code, 'CRM_MUTATION_FAILED');
  assert.equal(JSON.stringify(publicError(error)).includes('secret'), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM customers').get().count, beforeCustomers);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM customer_activity').get().count, beforeActivity);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM crm_audit_events').get().count, beforeAudit);
  assert.deepEqual(db.prepare('SELECT status,converted_customer_id FROM leads WHERE id=?').get(IDS.leadRollback), {
    status: 'new',
    converted_customer_id: null
  });
});

test('customer lifecycle: active forward and reasoned backward transitions share exact evidence', (t) => {
  const db = openFixture(t);
  const forward = service.transitionCustomerLifecycle(
    db,
    customerLifecycle(IDS.ownerA, IDS.ownedA, 'info_confirmed')
  );
  assert.equal(forward.action, 'stage_changed');
  assert.equal(forward.record.stage, 'info_confirmed');
  assert.equal(forward.record.duplicate_enforced, undefined);
  assert.equal(Object.isFrozen(forward), true);

  db.prepare("UPDATE customers SET stage='proposal',duplicate_enforced=1 WHERE id=?").run(IDS.ownedA);
  const beforeActivity = db.prepare('SELECT COUNT(*) AS count FROM customer_activity WHERE customer_id=?').get(IDS.ownedA).count;
  const missingReason = captureError(() => service.transitionCustomerLifecycle(
    db,
    customerLifecycle(IDS.ownerA, IDS.ownedA, 'analysis')
  ));
  assert.equal(missingReason.code, 'CRM_TRANSITION_INVALID');
  assert.equal(db.prepare('SELECT stage FROM customers WHERE id=?').get(IDS.ownedA).stage, 'proposal');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM customer_activity WHERE customer_id=?').get(IDS.ownedA).count, beforeActivity);

  const options = customerLifecycle(IDS.ownerA, IDS.ownedA, 'analysis', {
    reason_code: 'requirements_changed'
  });
  options.requestId = 'lifecycle-backward-success';
  const backward = service.transitionCustomerLifecycle(db, options);
  assert.equal(backward.action, 'stage_changed');
  assert.deepEqual(db.prepare(`
    SELECT action,stage_from,stage_to,notes
    FROM customer_activity WHERE customer_id=? ORDER BY id DESC LIMIT 1
  `).get(IDS.ownedA), {
    action: 'stage_change',
    stage_from: 'proposal',
    stage_to: 'analysis',
    notes: 'customer_stage_changed'
  });
  const audit = db.prepare(`
    SELECT metadata_json FROM crm_audit_events
    WHERE request_id=? AND event_type='customer_stage_changed'
  `).get(options.requestId);
  assert.deepEqual(JSON.parse(audit.metadata_json), {
    from_stage: 'proposal',
    to_stage: 'analysis',
    reason_code: 'requirements_changed',
    no_opportunity_exception: false,
    changed_fields: []
  });
});

test('customer lifecycle: pause requires a closed reason and an explicit future next action', (t) => {
  const db = openFixture(t);
  for (const commandOverrides of [
    { reason_code: 'timeline_changed' },
    { reason_code: 'timeline_changed', next_action_at: null },
    { reason_code: 'timeline_changed', next_action_at: PAST_AT },
    { reason_code: 'free_form_reason', next_action_at: FUTURE_AT }
  ]) {
    const error = captureError(() => service.transitionCustomerLifecycle(
      db,
      customerLifecycle(IDS.ownerA, IDS.ownedA, 'paused', commandOverrides)
    ));
    assert.equal(error.code, 'CRM_TRANSITION_INVALID');
  }
  assert.equal(db.prepare('SELECT stage FROM customers WHERE id=?').get(IDS.ownedA).stage, 'lead');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM customer_activity WHERE customer_id=?').get(IDS.ownedA).count, 0);

  const result = service.transitionCustomerLifecycle(db, customerLifecycle(
    IDS.ownerA,
    IDS.ownedA,
    'paused',
    { reason_code: 'timeline_changed', next_action_at: FUTURE_AT }
  ));
  assert.equal(result.record.stage, 'paused');
  assert.deepEqual(db.prepare('SELECT stage,next_action_at,duplicate_enforced FROM customers WHERE id=?').get(IDS.ownedA), {
    stage: 'paused',
    next_action_at: FUTURE_AT,
    duplicate_enforced: 0
  });
});

test('customer lifecycle: won requires a same-organization won opportunity or the exact admin exception', (t) => {
  const db = openFixture(t);
  const noOpportunity = captureError(() => service.transitionCustomerLifecycle(
    db,
    customerLifecycle(IDS.ownerA, IDS.ownedA, 'won')
  ));
  assert.equal(noOpportunity.code, 'CRM_TRANSITION_INVALID');

  const ordinaryException = captureError(() => service.transitionCustomerLifecycle(
    db,
    customerLifecycle(IDS.ownerA, IDS.ownedA, 'won', {
      reason_code: 'no_opportunity_exception',
      no_opportunity_exception: true
    })
  ));
  assert.equal(ordinaryException.code, 'CRM_TRANSITION_INVALID');

  insertOpportunity(db, {
    id: 40002,
    customerId: IDS.teammateOwnedA,
    stage: 'won',
    ownerUserId: IDS.teammateA
  });
  insertOpportunity(db, {
    id: 40003,
    customerId: IDS.ownedB,
    stage: 'won',
    orgId: IDS.orgB,
    teamId: IDS.teamB1,
    ownerUserId: IDS.outsiderB
  });
  const wrongAggregateEvidence = captureError(() => service.transitionCustomerLifecycle(
    db,
    customerLifecycle(IDS.ownerA, IDS.ownedA, 'won')
  ));
  assert.equal(wrongAggregateEvidence.code, 'CRM_TRANSITION_INVALID');

  insertOpportunity(db, {
    id: 40001,
    customerId: IDS.ownedA,
    stage: 'won'
  });
  const won = service.transitionCustomerLifecycle(
    db,
    customerLifecycle(IDS.ownerA, IDS.ownedA, 'won')
  );
  assert.equal(won.record.stage, 'won');
  assert.equal(db.prepare('SELECT duplicate_enforced FROM customers WHERE id=?').get(IDS.ownedA).duplicate_enforced, 0);

  const adminException = service.transitionCustomerLifecycle(db, customerLifecycle(
    IDS.orgAdminA,
    IDS.teammateOwnedA,
    'won',
    { reason_code: 'no_opportunity_exception', no_opportunity_exception: true }
  ));
  assert.equal(adminException.record.stage, 'won');
});

test('customer lifecycle: active and paused customers require a reason to become lost', (t) => {
  const db = openFixture(t);
  db.prepare("UPDATE customers SET stage='paused',duplicate_enforced=0 WHERE id=?").run(IDS.transferredA);
  for (const customerId of [IDS.ownedA, IDS.transferredA]) {
    const missingReason = captureError(() => service.transitionCustomerLifecycle(
      db,
      customerLifecycle(IDS.ownerA, customerId, 'lost')
    ));
    assert.equal(missingReason.code, 'CRM_TRANSITION_INVALID');
    const result = service.transitionCustomerLifecycle(db, customerLifecycle(
      IDS.ownerA,
      customerId,
      'lost',
      { reason_code: 'competitive_loss' }
    ));
    assert.equal(result.record.stage, 'lost');
  }
});

test('customer lifecycle: paused and lost reactivation require reason future action and duplicate enforcement', (t) => {
  const db = openFixture(t);
  db.prepare("UPDATE customers SET stage='paused',duplicate_enforced=0 WHERE id=?").run(IDS.ownedA);
  db.prepare("UPDATE customers SET stage='lost',duplicate_enforced=0 WHERE id=?").run(IDS.transferredA);

  for (const commandOverrides of [
    { next_action_at: FUTURE_AT },
    { reason_code: 'requirements_changed' },
    { reason_code: 'requirements_changed', next_action_at: PAST_AT }
  ]) {
    const error = captureError(() => service.transitionCustomerLifecycle(
      db,
      customerLifecycle(IDS.ownerA, IDS.ownedA, 'proposal', commandOverrides)
    ));
    assert.equal(error.code, 'CRM_TRANSITION_INVALID');
  }

  const resumedPaused = service.transitionCustomerLifecycle(db, customerLifecycle(
    IDS.ownerA,
    IDS.ownedA,
    'proposal',
    { reason_code: 'requirements_changed', next_action_at: FUTURE_AT }
  ));
  assert.equal(resumedPaused.record.stage, 'proposal');
  assert.deepEqual(db.prepare('SELECT next_action_at,duplicate_enforced FROM customers WHERE id=?').get(IDS.ownedA), {
    next_action_at: FUTURE_AT,
    duplicate_enforced: 1
  });

  const resumedLost = service.transitionCustomerLifecycle(db, customerLifecycle(
    IDS.ownerA,
    IDS.transferredA,
    'lead',
    { reason_code: 'data_correction', next_action_at: FUTURE_AT }
  ));
  assert.equal(resumedLost.record.stage, 'lead');
  assert.equal(db.prepare('SELECT duplicate_enforced FROM customers WHERE id=?').get(IDS.transferredA).duplicate_enforced, 1);
});

test('customer lifecycle: same-state changes and won reopen are rejected without writes', (t) => {
  const db = openFixture(t);
  const noOp = captureError(() => service.transitionCustomerLifecycle(
    db,
    customerLifecycle(IDS.ownerA, IDS.ownedA, 'lead')
  ));
  assert.equal(noOp.code, 'CRM_TRANSITION_INVALID');

  db.prepare("UPDATE customers SET stage='won',duplicate_enforced=0 WHERE id=?").run(IDS.ownedA);
  const beforeActivity = db.prepare('SELECT COUNT(*) AS count FROM customer_activity WHERE customer_id=?').get(IDS.ownedA).count;
  const reopen = captureError(() => service.transitionCustomerLifecycle(
    db,
    customerLifecycle(IDS.ownerA, IDS.ownedA, 'proposal', {
      reason_code: 'data_correction',
      next_action_at: FUTURE_AT
    })
  ));
  assert.equal(reopen.code, 'CRM_TRANSITION_INVALID');
  assert.equal(db.prepare('SELECT stage FROM customers WHERE id=?').get(IDS.ownedA).stage, 'won');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM customer_activity WHERE customer_id=?').get(IDS.ownedA).count, beforeActivity);
});

test('customer lifecycle: unknown and null historical stages require organization-admin remediation', (t) => {
  const db = openFixture(t);
  const legacyStage = 'legacy-private-stage-marker';
  db.prepare('UPDATE customers SET stage=?,duplicate_enforced=0 WHERE id=?').run(legacyStage, IDS.ownedA);
  db.prepare('UPDATE customers SET stage=NULL,duplicate_enforced=0 WHERE id=?').run(IDS.transferredA);
  const deniedOptions = customerLifecycle(IDS.ownerA, IDS.ownedA, 'lead', {
    reason_code: 'data_correction',
    next_action_at: FUTURE_AT
  });
  deniedOptions.requestId = 'legacy-stage-owner-denied';
  const denied = captureError(() => service.transitionCustomerLifecycle(db, deniedOptions));
  assert.equal(denied.code, 'CRM_CUSTOMER_FORBIDDEN');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM crm_audit_events WHERE request_id=? AND event_type='mutation_denied'").get(deniedOptions.requestId).count, 1);
  assert.equal(db.prepare('SELECT stage FROM customers WHERE id=?').get(IDS.ownedA).stage, legacyStage);

  for (const customerId of [IDS.ownedA, IDS.transferredA]) {
    const result = service.transitionCustomerLifecycle(db, customerLifecycle(
      IDS.orgAdminA,
      customerId,
      'lead',
      { reason_code: 'data_correction', next_action_at: FUTURE_AT }
    ));
    assert.equal(result.record.stage, 'lead');
    assert.equal(db.prepare('SELECT duplicate_enforced FROM customers WHERE id=?').get(customerId).duplicate_enforced, 1);
    assert.equal(db.prepare(`
      SELECT stage_from FROM customer_activity
      WHERE customer_id=? ORDER BY id DESC LIMIT 1
    `).get(customerId).stage_from, 'legacy_unknown');
    const audit = db.prepare(`
      SELECT metadata_json FROM crm_audit_events
      WHERE customer_id=? AND event_type='customer_stage_changed'
      ORDER BY id DESC LIMIT 1
    `).get(customerId);
    assert.equal(JSON.parse(audit.metadata_json).from_stage, 'legacy_unknown');
    assert.equal(audit.metadata_json.includes('private-stage-marker'), false);
  }
});

test('customer lifecycle: profile updates preserve unknown-stage duplicate quarantine', (t) => {
  const db = openFixture(t);
  const legacyStage = 'legacy-private-stage-marker';
  db.prepare(`
    UPDATE customers
    SET stage=?,normalized_identity_key=?,duplicate_enforced=0
    WHERE id=?
  `).run(legacyStage, buildCustomerIdentity({
    brand_name: 'Owned A',
    company_name: 'Owned A Company'
  }).key, IDS.ownedA);

  const result = service.createOrUpdateCustomer(db, {
    actorUserId: IDS.ownerA,
    organizationId: IDS.orgA,
    command: {
      mode: 'update',
      customerId: IDS.ownedA,
      values: { notes: 'Profile-only legacy update' }
    }
  });
  assert.equal(result.action, 'updated');
  assert.equal(result.record.stage, 'legacy_unknown');
  assert.equal(JSON.stringify(result).includes(legacyStage), false);
  assert.deepEqual(db.prepare('SELECT stage,duplicate_enforced FROM customers WHERE id=?').get(IDS.ownedA), {
    stage: legacyStage,
    duplicate_enforced: 0
  });
});

test('customer lifecycle: reactivation duplicate commits evidence without stage or activity mutation', (t) => {
  const db = openFixture(t);
  const identity = buildCustomerIdentity({
    brand_name: 'Reactivation Collision',
    company_name: 'Collision Company'
  }).key;
  db.prepare(`
    UPDATE customers
    SET brand_name='Reactivation Collision',company_name='Collision Company',
        stage='lost',normalized_identity_key=?,duplicate_enforced=0
    WHERE id=?
  `).run(identity, IDS.ownedA);
  db.prepare(`
    UPDATE customers
    SET brand_name='Reactivation Collision',company_name='Collision Company',
        stage='lead',normalized_identity_key=?,duplicate_enforced=1
    WHERE id=?
  `).run(identity, IDS.teammateOwnedA);
  const beforeActivity = db.prepare('SELECT COUNT(*) AS count FROM customer_activity WHERE customer_id=?').get(IDS.ownedA).count;
  const options = customerLifecycle(IDS.ownerA, IDS.ownedA, 'proposal', {
    reason_code: 'requirements_changed',
    next_action_at: FUTURE_AT
  });
  options.requestId = 'reactivation-duplicate';

  const error = captureError(() => service.transitionCustomerLifecycle(db, options));
  assert.equal(error.code, 'CRM_CUSTOMER_DUPLICATE');
  assert.deepEqual(db.prepare('SELECT stage,duplicate_enforced FROM customers WHERE id=?').get(IDS.ownedA), {
    stage: 'lost',
    duplicate_enforced: 0
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM customer_activity WHERE customer_id=?').get(IDS.ownedA).count, beforeActivity);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM crm_audit_events WHERE request_id=? AND event_type='duplicate_detected'").get(options.requestId).count, 1);
});

test('customer lifecycle: mixed profile and transition commits one evidence set or rolls back together', (t) => {
  const db = openFixture(t);
  const success = service.createOrUpdateCustomer(db, {
    actorUserId: IDS.ownerA,
    organizationId: IDS.orgA,
    requestId: 'mixed-lifecycle-success',
    correlationId: 'mixed-lifecycle-flow',
    command: {
      mode: 'update',
      customerId: IDS.ownedA,
      values: { company_name: 'Mixed Lifecycle Company' },
      transition: { to_stage: 'info_confirmed' }
    }
  });
  assert.equal(success.action, 'stage_changed');
  assert.deepEqual(db.prepare('SELECT company_name,stage FROM customers WHERE id=?').get(IDS.ownedA), {
    company_name: 'Mixed Lifecycle Company',
    stage: 'info_confirmed'
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM crm_audit_events WHERE request_id='mixed-lifecycle-success' AND event_type='customer_stage_changed'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM crm_audit_events WHERE request_id='mixed-lifecycle-success' AND event_type='customer_updated'").get().count, 0);

  const before = db.prepare('SELECT brand_name,stage,normalized_identity_key FROM customers WHERE id=?').get(IDS.transferredA);
  const beforeActivity = db.prepare('SELECT COUNT(*) AS count FROM customer_activity WHERE customer_id=?').get(IDS.transferredA).count;
  db.exec(`
    CREATE TRIGGER reject_mixed_lifecycle_audit
    BEFORE INSERT ON crm_audit_events
    WHEN NEW.event_type='customer_stage_changed'
    BEGIN
      SELECT RAISE(ABORT,'secret mixed lifecycle failure');
    END
  `);
  const failed = captureError(() => service.createOrUpdateCustomer(db, {
    actorUserId: IDS.ownerA,
    organizationId: IDS.orgA,
    requestId: 'mixed-lifecycle-rollback',
    command: {
      mode: 'update',
      customerId: IDS.transferredA,
      values: { brand_name: 'Must Roll Back' },
      transition: { to_stage: 'info_confirmed' }
    }
  }));
  assert.equal(failed.code, 'CRM_MUTATION_FAILED');
  assert.equal(JSON.stringify(publicError(failed)).includes('secret'), false);
  assert.deepEqual(db.prepare('SELECT brand_name,stage,normalized_identity_key FROM customers WHERE id=?').get(IDS.transferredA), before);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM customer_activity WHERE customer_id=?').get(IDS.transferredA).count, beforeActivity);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM crm_audit_events WHERE request_id='mixed-lifecycle-rollback'").get().count, 0);
});

test('customer lifecycle: nested transition permits omitted values and rejects conflicting next-action sources', (t) => {
  const db = openFixture(t);
  const transitionOnly = service.createOrUpdateCustomer(db, {
    actorUserId: IDS.ownerA,
    organizationId: IDS.orgA,
    requestId: 'nested-transition-only',
    command: {
      mode: 'update',
      customerId: IDS.ownedA,
      transition: { to_stage: 'info_confirmed' }
    }
  });
  assert.equal(transitionOnly.action, 'stage_changed');
  assert.equal(transitionOnly.record.stage, 'info_confirmed');

  const before = db.prepare('SELECT * FROM customers WHERE id=?').get(IDS.transferredA);
  const conflicting = captureError(() => service.createOrUpdateCustomer(db, {
    actorUserId: IDS.ownerA,
    organizationId: IDS.orgA,
    requestId: 'nested-next-action-conflict',
    command: {
      mode: 'update',
      customerId: IDS.transferredA,
      values: { next_action_at: FUTURE_AT },
      transition: {
        to_stage: 'paused',
        reason_code: 'timeline_changed',
        next_action_at: '2099-02-01 09:00:00'
      }
    }
  }));
  assert.equal(conflicting.code, 'CRM_MUTATION_INVALID');
  assert.deepEqual(db.prepare('SELECT * FROM customers WHERE id=?').get(IDS.transferredA), before);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM crm_audit_events WHERE request_id='nested-next-action-conflict'").get().count, 0);
});

test('customer lifecycle: mixed duplicate rejection preserves every customer column', (t) => {
  const db = openFixture(t);
  const identity = buildCustomerIdentity({
    brand_name: 'Mixed Duplicate Brand',
    company_name: 'Mixed Duplicate Company'
  }).key;
  db.prepare(`
    UPDATE customers
    SET brand_name='Mixed Duplicate Brand',company_name='Mixed Duplicate Company',
        normalized_identity_key=?,duplicate_enforced=1,stage='lead'
    WHERE id=?
  `).run(identity, IDS.teammateOwnedA);
  db.prepare("UPDATE customers SET stage='lost',duplicate_enforced=0 WHERE id=?").run(IDS.ownedA);
  const before = db.prepare('SELECT * FROM customers WHERE id=?').get(IDS.ownedA);
  const beforeActivity = db.prepare('SELECT COUNT(*) AS count FROM customer_activity WHERE customer_id=?').get(IDS.ownedA).count;
  const options = {
    actorUserId: IDS.ownerA,
    organizationId: IDS.orgA,
    requestId: 'mixed-reactivation-duplicate',
    command: {
      mode: 'update',
      customerId: IDS.ownedA,
      values: {
        brand_name: 'Mixed Duplicate Brand',
        company_name: 'Mixed Duplicate Company',
        notes: 'Must not persist'
      },
      transition: {
        to_stage: 'proposal',
        reason_code: 'requirements_changed',
        next_action_at: FUTURE_AT
      }
    }
  };

  const error = captureError(() => service.createOrUpdateCustomer(db, options));
  assert.equal(error.code, 'CRM_CUSTOMER_DUPLICATE');
  assert.deepEqual(db.prepare('SELECT * FROM customers WHERE id=?').get(IDS.ownedA), before);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM customer_activity WHERE customer_id=?').get(IDS.ownedA).count, beforeActivity);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM crm_audit_events WHERE request_id=? AND event_type='duplicate_detected'").get(options.requestId).count, 1);
});

test('customer lifecycle: ignored stage compare-and-set cannot report false success or write evidence', (t) => {
  const db = openFixture(t);
  db.exec(`
    CREATE TRIGGER ignore_customer_stage_update
    BEFORE UPDATE OF stage ON customers
    WHEN OLD.id=${IDS.ownedA}
    BEGIN
      SELECT RAISE(IGNORE);
    END
  `);
  const beforeActivity = db.prepare('SELECT COUNT(*) AS count FROM customer_activity WHERE customer_id=?').get(IDS.ownedA).count;
  const options = customerLifecycle(IDS.ownerA, IDS.ownedA, 'info_confirmed');
  options.requestId = 'lifecycle-cas-ignored';

  const error = captureError(() => service.transitionCustomerLifecycle(db, options));
  assert.equal(error.code, 'CRM_TRANSITION_INVALID');
  assert.equal(db.prepare('SELECT stage FROM customers WHERE id=?').get(IDS.ownedA).stage, 'lead');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM customer_activity WHERE customer_id=?').get(IDS.ownedA).count, beforeActivity);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM crm_audit_events WHERE request_id=?").get(options.requestId).count, 0);
});

test('customer custody: owner and organization admin release only with a closed reason', (t) => {
  const db = openFixture(t);
  const before = db.prepare('SELECT assigned_to,team_id,is_public FROM customers WHERE id=?').get(IDS.ownedA);
  for (const command of [
    { action: 'release', customerId: IDS.ownedA },
    { action: 'release', customerId: IDS.ownedA, reason_code: 'free-form-reason' }
  ]) {
    const error = captureError(() => service.mutateCustomerCustody(
      db,
      customerCustody(IDS.ownerA, command)
    ));
    assert.equal(error.code, 'CRM_MUTATION_INVALID');
  }
  assert.deepEqual(db.prepare('SELECT assigned_to,team_id,is_public FROM customers WHERE id=?').get(IDS.ownedA), before);

  const ownerOptions = customerCustody(IDS.ownerA, {
    action: 'release',
    customerId: IDS.ownedA,
    reason_code: 'capacity_rebalance'
  }, { requestId: 'custody-owner-release' });
  const ownerRelease = service.mutateCustomerCustody(db, ownerOptions);
  assert.equal(ownerRelease.action, 'released');
  assert.deepEqual(ownerRelease.record, {
    ...ownerRelease.record,
    team_id: null,
    assigned_to: null,
    is_public: 1
  });

  const adminOptions = customerCustody(IDS.orgAdminA, {
    action: 'release',
    customerId: IDS.teammateOwnedA,
    reason_code: 'territory_change'
  }, { requestId: 'custody-admin-release' });
  assert.equal(service.mutateCustomerCustody(db, adminOptions).action, 'released');

  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM customers
    WHERE id IN (?,?) AND assigned_to IS NULL AND team_id IS NULL AND is_public=1
  `).get(IDS.ownedA, IDS.teammateOwnedA).count, 2);
  assert.deepEqual(JSON.parse(db.prepare(`
    SELECT metadata_json FROM crm_audit_events
    WHERE request_id=? AND event_type='customer_released_to_pool'
  `).get(ownerOptions.requestId).metadata_json), {
    reason_code: 'capacity_rebalance',
    from_assigned_to: IDS.ownerA,
    from_team_id: IDS.teamA1,
    to_assigned_to: null,
    to_team_id: null
  });
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM customer_activity
    WHERE notes='customer_released_to_pool' AND customer_id IN (?,?)
  `).get(IDS.ownedA, IDS.teammateOwnedA).count, 2);
});

test('customer custody: action-specific shapes and assignment pairs reject without mutation', (t) => {
  const db = openFixture(t);
  const before = db.prepare('SELECT * FROM customers WHERE id=?').get(IDS.ownedA);
  for (const command of [
    { action: 'release', customerId: IDS.ownedA, team_id: IDS.teamA1, reason_code: 'capacity_rebalance' },
    { action: 'claim', customerId: IDS.publicA, team_id: IDS.teamA1, reason_code: 'manager_assignment' },
    { action: 'transfer', customerId: IDS.ownedA, assigned_to: IDS.teammateA, team_id: IDS.teamA1 },
    { action: 'transfer', customerId: IDS.ownedA, assigned_to: IDS.inactiveOwnerA, team_id: IDS.teamA1, reason_code: 'manager_assignment' },
    { action: 'transfer', customerId: IDS.ownedA, assigned_to: IDS.teammateA, team_id: IDS.teamA2, reason_code: 'manager_assignment' },
    { action: 'transfer', customerId: IDS.ownedA, assigned_to: IDS.outsiderB, team_id: IDS.teamB1, reason_code: 'manager_assignment' }
  ]) {
    const error = captureError(() => service.mutateCustomerCustody(
      db,
      customerCustody(IDS.orgAdminA, command)
    ));
    assert.equal(error.code, 'CRM_MUTATION_INVALID');
  }
  assert.deepEqual(db.prepare('SELECT * FROM customers WHERE id=?').get(IDS.ownedA), before);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM crm_audit_events WHERE event_type LIKE 'customer_%'").get().count, 0);
});

test('customer custody: former owner denial commits one bounded decision and no custody write', (t) => {
  const db = openFixture(t);
  const options = customerCustody(IDS.originatorA, {
    action: 'release',
    customerId: IDS.transferredA,
    reason_code: 'capacity_rebalance'
  }, { requestId: 'custody-former-owner-denied' });
  const error = captureError(() => service.mutateCustomerCustody(db, options));
  assert.equal(error.code, 'CRM_CUSTOMER_FORBIDDEN');
  assert.deepEqual(db.prepare('SELECT assigned_to,team_id,is_public FROM customers WHERE id=?').get(IDS.transferredA), {
    assigned_to: IDS.ownerA,
    team_id: IDS.teamA1,
    is_public: 0
  });
  assert.deepEqual(db.prepare(`
    SELECT customer_id,event_type,metadata_json FROM crm_audit_events WHERE request_id=?
  `).get(options.requestId), {
    customer_id: null,
    event_type: 'mutation_denied',
    metadata_json: '{"operation":"customer_release","outcome":"forbidden"}'
  });
});

test('customer custody: two real connections produce one claim and one generic conflict', async (t) => {
  const databasePath = createFileFixture(t);
  const left = customerCustody(IDS.ownerA, {
    action: 'claim',
    customerId: IDS.publicA,
    team_id: IDS.teamA1
  }, { requestId: 'custody-claim-left' });
  const right = customerCustody(IDS.teammateA, {
    action: 'claim',
    customerId: IDS.publicA,
    team_id: IDS.teamA1
  }, { requestId: 'custody-claim-right' });

  const results = await runConcurrentCustody(databasePath, left, right);
  const successes = results.filter((result) => result && result.ok === true);
  const failures = results.filter((result) => result && result.code);
  assert.equal(successes.length, 1);
  assert.equal(successes[0].action, 'claimed');
  assert.deepEqual(failures.map((failure) => failure.code), ['CRM_PUBLIC_POOL_UNAVAILABLE']);
  assert.equal(Object.hasOwn(failures[0], 'retryable'), false);

  const db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  try {
    const customer = db.prepare('SELECT assigned_to,team_id,is_public FROM customers WHERE id=?').get(IDS.publicA);
    assert.ok([IDS.ownerA, IDS.teammateA].includes(customer.assigned_to));
    assert.equal(customer.team_id, IDS.teamA1);
    assert.equal(customer.is_public, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM customer_activity WHERE customer_id=? AND notes='customer_claimed'").get(IDS.publicA).count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM crm_audit_events WHERE customer_id=? AND event_type='customer_claimed'").get(IDS.publicA).count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM crm_audit_events WHERE event_type='mutation_denied'").get().count, 0);
  } finally {
    db.close();
  }
});

test('customer custody: an owned row is indistinguishable from a losing public-pool claim', (t) => {
  const db = openFixture(t);
  const options = customerCustody(IDS.teammateA, {
    action: 'claim',
    customerId: IDS.ownedA,
    team_id: IDS.teamA1
  }, { requestId: 'custody-owned-claim' });
  const error = captureError(() => service.mutateCustomerCustody(db, options));
  assert.deepEqual(publicError(error), {
    code: 'CRM_PUBLIC_POOL_UNAVAILABLE',
    status: 409,
    title: 'CRM public-pool customer is unavailable',
    details: null
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM crm_audit_events WHERE request_id=?').get(options.requestId).count, 0);
});

test('customer custody: transfer reassigns only open direct and opportunity tasks', (t) => {
  const db = openFixture(t);
  insertOpportunity(db, { id: 40010, customerId: IDS.ownedA, stage: 'proposal' });
  for (const task of [
    { id: IDS.taskDirect, customerId: IDS.ownedA },
    { id: IDS.taskLinked, customerId: IDS.ownedA, opportunityId: 40010 },
    { id: IDS.taskCompleted, customerId: IDS.ownedA, status: 'completed' },
    { id: IDS.taskCancelled, customerId: IDS.ownedA, status: 'cancelled' },
    { id: IDS.taskUnrelated, customerId: IDS.transferredA }
  ]) insertCrmTask(db, task);
  const options = customerCustody(IDS.ownerA, {
    action: 'transfer',
    customerId: IDS.ownedA,
    assigned_to: IDS.teammateA,
    team_id: IDS.teamA1,
    reason_code: 'manager_assignment'
  }, { requestId: 'custody-transfer-open-tasks' });

  const result = service.mutateCustomerCustody(db, options);
  assert.equal(result.action, 'transferred');
  assert.equal(result.record.assigned_to, IDS.teammateA);
  assert.deepEqual(db.prepare('SELECT assigned_to,team_id,is_public FROM customers WHERE id=?').get(IDS.ownedA), {
    assigned_to: IDS.teammateA,
    team_id: IDS.teamA1,
    is_public: 0
  });
  assert.deepEqual(db.prepare('SELECT id,owner_user_id,team_id,status FROM crm_tasks ORDER BY id').all(), [
    { id: IDS.taskDirect, owner_user_id: IDS.teammateA, team_id: IDS.teamA1, status: 'open' },
    { id: IDS.taskLinked, owner_user_id: IDS.teammateA, team_id: IDS.teamA1, status: 'open' },
    { id: IDS.taskCompleted, owner_user_id: IDS.ownerA, team_id: IDS.teamA1, status: 'completed' },
    { id: IDS.taskCancelled, owner_user_id: IDS.ownerA, team_id: IDS.teamA1, status: 'cancelled' },
    { id: IDS.taskUnrelated, owner_user_id: IDS.ownerA, team_id: IDS.teamA1, status: 'open' }
  ]);
  assert.deepEqual(JSON.parse(db.prepare(`
    SELECT metadata_json FROM crm_audit_events
    WHERE request_id=? AND event_type='customer_transferred'
  `).get(options.requestId).metadata_json), {
    reason_code: 'manager_assignment',
    from_assigned_to: IDS.ownerA,
    from_team_id: IDS.teamA1,
    to_assigned_to: IDS.teammateA,
    to_team_id: IDS.teamA1
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM customer_activity WHERE customer_id=? AND notes='customer_transferred'").get(IDS.ownedA).count, 1);
});

test('customer custody: transfer and repair compare-and-set misses roll back without evidence', (t) => {
  const db = openFixture(t);
  db.exec(`
    CREATE TRIGGER ignore_customer_transfer
    BEFORE UPDATE OF assigned_to,team_id,is_public ON customers
    WHEN OLD.id=${IDS.ownedA} AND NEW.assigned_to=${IDS.teammateA}
    BEGIN SELECT RAISE(IGNORE); END;
    CREATE TRIGGER ignore_customer_repair
    BEFORE UPDATE OF assigned_to,team_id,is_public ON customers
    WHEN OLD.id=${IDS.quarantinedA} AND NEW.assigned_to=${IDS.ownerA}
    BEGIN SELECT RAISE(IGNORE); END;
  `);
  const beforeTransfer = db.prepare('SELECT * FROM customers WHERE id=?').get(IDS.ownedA);
  const beforeRepair = db.prepare('SELECT * FROM customers WHERE id=?').get(IDS.quarantinedA);
  const transfer = captureError(() => service.mutateCustomerCustody(db, customerCustody(IDS.ownerA, {
    action: 'transfer',
    customerId: IDS.ownedA,
    assigned_to: IDS.teammateA,
    team_id: IDS.teamA1,
    reason_code: 'manager_assignment'
  }, { requestId: 'custody-transfer-cas-miss' })));
  const repair = captureError(() => service.mutateCustomerCustody(db, customerCustody(IDS.orgAdminA, {
    action: 'repair',
    customerId: IDS.quarantinedA,
    assigned_to: IDS.ownerA,
    team_id: IDS.teamA1,
    reason_code: 'legacy_custody_repair'
  }, { requestId: 'custody-repair-cas-miss' })));
  assert.equal(transfer.code, 'CRM_CUSTODY_CONFLICT');
  assert.equal(repair.code, 'CRM_CUSTODY_CONFLICT');
  assert.deepEqual(db.prepare('SELECT * FROM customers WHERE id=?').get(IDS.ownedA), beforeTransfer);
  assert.deepEqual(db.prepare('SELECT * FROM customers WHERE id=?').get(IDS.quarantinedA), beforeRepair);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM crm_audit_events WHERE request_id LIKE 'custody-%-cas-miss'").get().count, 0);
});

test('customer custody: only an organization admin repairs multiple quarantine shapes', (t) => {
  const db = openFixture(t);
  db.prepare('UPDATE customers SET assigned_to=NULL,team_id=?,is_public=1 WHERE id=?')
    .run(IDS.teamA1, IDS.inactiveOwnedA);
  const deniedOptions = customerCustody(IDS.ownerA, {
    action: 'repair',
    customerId: IDS.quarantinedA,
    assigned_to: IDS.ownerA,
    team_id: IDS.teamA1,
    reason_code: 'legacy_custody_repair'
  }, { requestId: 'custody-repair-denied' });
  const denied = captureError(() => service.mutateCustomerCustody(db, deniedOptions));
  assert.equal(denied.code, 'CRM_CUSTOMER_FORBIDDEN');
  assert.deepEqual(JSON.parse(db.prepare('SELECT metadata_json FROM crm_audit_events WHERE request_id=?').get(deniedOptions.requestId).metadata_json), {
    operation: 'customer_repair',
    outcome: 'forbidden'
  });

  for (const [customerId, targetOwner] of [
    [IDS.quarantinedA, IDS.ownerA],
    [IDS.inactiveOwnedA, IDS.teammateA]
  ]) {
    const result = service.mutateCustomerCustody(db, customerCustody(IDS.orgAdminA, {
      action: 'repair',
      customerId,
      assigned_to: targetOwner,
      team_id: IDS.teamA1,
      reason_code: 'legacy_custody_repair'
    }));
    assert.equal(result.action, 'repaired');
    assert.deepEqual(db.prepare('SELECT assigned_to,team_id,is_public FROM customers WHERE id=?').get(customerId), {
      assigned_to: targetOwner,
      team_id: IDS.teamA1,
      is_public: 0
    });
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM crm_audit_events WHERE event_type='customer_custody_repaired'").get().count, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM customer_activity WHERE notes='customer_custody_repaired'").get().count, 2);
});

test('customer custody: task activity and audit failures roll every custody effect back', (t) => {
  const cases = [
    {
      name: 'task',
      setup(db) {
        insertCrmTask(db, { id: IDS.taskDirect, customerId: IDS.ownedA });
        db.exec(`CREATE TRIGGER fail_custody_task BEFORE UPDATE ON crm_tasks
          WHEN OLD.customer_id=${IDS.ownedA} AND OLD.status='open'
          BEGIN SELECT RAISE(ABORT,'fixture task failure'); END`);
      },
      command: {
        action: 'transfer',
        customerId: IDS.ownedA,
        assigned_to: IDS.teammateA,
        team_id: IDS.teamA1,
        reason_code: 'manager_assignment'
      }
    },
    {
      name: 'activity',
      setup(db) {
        db.exec(`CREATE TRIGGER fail_custody_activity BEFORE INSERT ON customer_activity
          WHEN NEW.notes='customer_released_to_pool'
          BEGIN SELECT RAISE(ABORT,'fixture activity failure'); END`);
      },
      command: { action: 'release', customerId: IDS.ownedA, reason_code: 'capacity_rebalance' }
    },
    {
      name: 'audit',
      setup(db) {
        db.exec(`CREATE TRIGGER fail_custody_audit BEFORE INSERT ON crm_audit_events
          WHEN NEW.event_type='customer_released_to_pool'
          BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END`);
      },
      command: { action: 'release', customerId: IDS.ownedA, reason_code: 'capacity_rebalance' }
    }
  ];

  for (const failureCase of cases) {
    const db = openFixture(t);
    failureCase.setup(db);
    const beforeCustomer = db.prepare('SELECT * FROM customers WHERE id=?').get(IDS.ownedA);
    const beforeTasks = db.prepare('SELECT * FROM crm_tasks ORDER BY id').all();
    const beforeActivity = db.prepare('SELECT COUNT(*) AS count FROM customer_activity').get().count;
    const beforeAudit = db.prepare('SELECT COUNT(*) AS count FROM crm_audit_events').get().count;
    const error = captureError(() => service.mutateCustomerCustody(db, customerCustody(
      IDS.ownerA,
      failureCase.command,
      { requestId: `custody-rollback-${failureCase.name}` }
    )));
    assert.equal(error.code, 'CRM_MUTATION_FAILED');
    assert.deepEqual(db.prepare('SELECT * FROM customers WHERE id=?').get(IDS.ownedA), beforeCustomer);
    assert.deepEqual(db.prepare('SELECT * FROM crm_tasks ORDER BY id').all(), beforeTasks);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM customer_activity').get().count, beforeActivity);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM crm_audit_events').get().count, beforeAudit);
  }
});

'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const {
  CrmScopeError,
  resolveCrmAccessContext,
  compileCustomerScope,
  CUSTOMER_CUSTODY_CASE_SQL
} = require('../services/crm_scope_service');
const {
  CrmQueryError,
  listCustomers,
  listOpportunities,
  getCrmDashboard,
  getCustomerDetail,
  getOpportunityDetail
} = require('../services/crm_query_service');

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
  ownerA2: 103,
  originatorA2: 104,
  orgAdminA: 105,
  inactiveOwnerA: 106,
  barePlatformAdmin: 107,
  outsiderB: 108,
  revokedMemberA: 109,
  noTeamA: 110,
  noMembershipA: 111,
  ownedA: 10001,
  teammateOwnedA: 10002,
  ownedA2: 10003,
  transferredA: 10004,
  publicA: 10005,
  nullTeamA: 10006,
  inactiveOwnerCustomerA: 10007,
  malformedPublicA: 10008,
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

function insertUser(db, id, username, role = 'user', isActive = 1) {
  db.prepare(`
    INSERT INTO users (
      id,username,password_hash,display_name,role,email,department,
      api_quota,created_at,is_active
    ) VALUES (?,?,?, ?,?,?, ?,?, ?,?)
  `).run(
    id,
    username,
    'not-used-by-tests',
    username,
    role,
    `${username}@example.invalid`,
    'sales',
    50000,
    FIXED_AT,
    isActive
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
  brandName,
  companyName = `${brandName} Company`,
  industry = null,
  stage = 'lead',
  source = 'fixture',
  priority = 'medium',
  country = null,
  tags = null,
  nextActionAt = null,
  stalledAt = null,
  updatedAt = FIXED_AT
}) {
  db.prepare(`
    INSERT INTO customers (
      id,brand_name,company_name,industry,stage,source,created_by,assigned_to,
      created_at,updated_at,is_public,priority,tags,org_id,team_id,country,
      next_action_at,stalled_at,duplicate_enforced
    ) VALUES (?,?,?,?,?,?,?, ?,?,?,?, ?,?,?,?, ?,?,?,0)
  `).run(
    id,
    brandName,
    companyName,
    industry,
    stage,
    source,
    createdBy,
    assignedTo,
    FIXED_AT,
    updatedAt,
    isPublic,
    priority,
    tags,
    orgId,
    teamId,
    country,
    nextActionAt,
    stalledAt
  );
}

function insertOpportunity(db, {
  id,
  customerId,
  orgId = IDS.orgA,
  teamId = IDS.teamA1,
  ownerUserId = IDS.ownerA,
  stage = 'negotiation',
  name = `Opportunity ${id}`,
  value = 100,
  winProbability = 50,
  updatedAt = FIXED_AT,
  nextActionAt = null
}) {
  db.prepare(`
    INSERT INTO opportunities (
      id,customer_id,name,stage,value,win_probability,created_by,
      created_at,updated_at,org_id,team_id,owner_user_id,next_action_at
    ) VALUES (?,?,?,?,?,?,?, ?,?,?, ?,?,?)
  `).run(
    id,
    customerId,
    name,
    stage,
    value,
    winProbability,
    ownerUserId,
    FIXED_AT,
    updatedAt,
    orgId,
    teamId,
    ownerUserId,
    nextActionAt
  );
}

function insertFilterCustomer(db, id, overrides = {}) {
  const values = {
    id,
    orgId: IDS.orgA,
    teamId: IDS.teamA1,
    createdBy: IDS.ownerA,
    assignedTo: IDS.ownerA,
    isPublic: 0,
    brandName: `Conjunction Marker ${id}`,
    companyName: 'Conjunction Marker Company',
    industry: 'fitness',
    stage: 'proposal',
    source: 'referral',
    priority: 'high',
    country: 'us',
    tags: 'launch, vip ,retained',
    nextActionAt: '2026-08-09 10:00:00',
    stalledAt: '2026-08-09 02:30:00',
    ...overrides
  };
  insertCustomer(db, values);
  return values;
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
    .run(IDS.orgA, 'fixture-org-a', 'Fixture Organization A', FIXED_AT);
  db.prepare('INSERT INTO organizations (id,code,name,created_at) VALUES (?,?,?,?)')
    .run(IDS.orgB, 'fixture-org-b', 'Fixture Organization B', FIXED_AT);
  db.prepare('INSERT INTO teams (id,org_id,code,name,created_at) VALUES (?,?,?,?,?)')
    .run(IDS.teamA1, IDS.orgA, 'fixture-a1', 'Fixture Team A1', FIXED_AT);
  db.prepare('INSERT INTO teams (id,org_id,code,name,created_at) VALUES (?,?,?,?,?)')
    .run(IDS.teamA2, IDS.orgA, 'fixture-a2', 'Fixture Team A2', FIXED_AT);
  db.prepare('INSERT INTO teams (id,org_id,code,name,created_at) VALUES (?,?,?,?,?)')
    .run(IDS.teamB1, IDS.orgB, 'fixture-b1', 'Fixture Team B1', FIXED_AT);

  for (const [id, username, role] of [
    [IDS.ownerA, 'scope-owner-a', 'user'],
    [IDS.teammateA, 'scope-teammate-a', 'user'],
    [IDS.ownerA2, 'scope-owner-a2', 'user'],
    [IDS.originatorA2, 'scope-originator-a2', 'user'],
    [IDS.orgAdminA, 'scope-org-admin-a', 'user'],
    [IDS.inactiveOwnerA, 'scope-inactive-owner-a', 'user'],
    [IDS.barePlatformAdmin, 'scope-bare-platform-admin', 'admin'],
    [IDS.outsiderB, 'scope-outsider-b', 'user'],
    [IDS.revokedMemberA, 'scope-revoked-member-a', 'user'],
    [IDS.noTeamA, 'scope-no-team-a', 'user'],
    [IDS.noMembershipA, 'scope-no-membership-a', 'user']
  ]) {
    insertUser(db, id, username, role);
  }

  for (const [userId, roleCode] of [
    [IDS.ownerA, 'member'],
    [IDS.teammateA, 'member'],
    [IDS.ownerA2, 'member'],
    [IDS.originatorA2, 'member'],
    [IDS.orgAdminA, 'org_admin'],
    [IDS.inactiveOwnerA, 'member'],
    [IDS.noTeamA, 'member']
  ]) {
    insertOrganizationMembership(db, IDS.orgA, userId, roleCode);
  }
  insertOrganizationMembership(db, IDS.orgA, IDS.revokedMemberA, 'member', 'revoked');
  insertOrganizationMembership(db, IDS.orgB, IDS.outsiderB);

  for (const [teamId, userId] of [
    [IDS.teamA1, IDS.ownerA],
    [IDS.teamA1, IDS.teammateA],
    [IDS.teamA1, IDS.orgAdminA],
    [IDS.teamA2, IDS.ownerA2],
    [IDS.teamA2, IDS.originatorA2],
    [IDS.teamB1, IDS.outsiderB]
  ]) {
    insertTeamMembership(db, teamId === IDS.teamB1 ? IDS.orgB : IDS.orgA, teamId, userId);
  }
  insertTeamMembership(db, IDS.orgA, IDS.teamA1, IDS.inactiveOwnerA, 'revoked');

  const customers = [
    [IDS.ownedA, IDS.orgA, IDS.teamA1, IDS.ownerA, IDS.ownerA, 0, 'Owned A'],
    [IDS.teammateOwnedA, IDS.orgA, IDS.teamA1, IDS.teammateA, IDS.teammateA, 0, 'Teammate A'],
    [IDS.ownedA2, IDS.orgA, IDS.teamA2, IDS.ownerA2, IDS.ownerA2, 0, 'Owned A2'],
    [IDS.transferredA, IDS.orgA, IDS.teamA1, IDS.originatorA2, IDS.ownerA, 0, 'Transferred A'],
    [IDS.publicA, IDS.orgA, null, IDS.ownerA, null, 1, 'Public A'],
    [IDS.nullTeamA, IDS.orgA, null, IDS.ownerA, IDS.ownerA, 0, 'Null Team A'],
    [IDS.inactiveOwnerCustomerA, IDS.orgA, IDS.teamA1, IDS.inactiveOwnerA, IDS.inactiveOwnerA, 0, 'Inactive Owner A'],
    [IDS.malformedPublicA, IDS.orgA, IDS.teamA1, IDS.ownerA, IDS.ownerA, 1, 'Malformed Public A'],
    [IDS.ownedB, IDS.orgB, IDS.teamB1, IDS.outsiderB, IDS.outsiderB, 0, 'Owned B']
  ];
  for (const [id, orgId, teamId, createdBy, assignedTo, isPublic, brandName] of customers) {
    insertCustomer(db, { id, orgId, teamId, createdBy, assignedTo, isPublic, brandName });
  }

  return db;
}

function contextFor(db, actorUserId, organizationId = IDS.orgA) {
  return resolveCrmAccessContext(db, { actorUserId, organizationId });
}

function customerRowsFor(db, context, requestedScope) {
  const compiled = compileCustomerScope(context, requestedScope);
  return db.prepare(`
    SELECT
      c.id,
      c.assigned_to AS owner_user_id,
      ${CUSTOMER_CUSTODY_CASE_SQL} AS custody
    FROM customers c
    WHERE ${compiled.where_sql}
    ORDER BY c.id
  `).all(...compiled.params);
}

function customerIdsFor(db, context, requestedScope) {
  return customerRowsFor(db, context, requestedScope).map((row) => row.id);
}

function publicError(error) {
  return JSON.parse(JSON.stringify(error));
}

function seedDashboardFixture(db, {
  customerId = 36000,
  source = 'dashboard-test',
  brandName = 'Dashboard Target'
} = {}) {
  insertFilterCustomer(db, customerId, {
    brandName,
    companyName: `${brandName} Company`,
    source,
    stage: 'proposal',
    nextActionAt: null,
    stalledAt: '2026-08-09 02:30:00'
  });
  db.prepare('UPDATE customers SET opportunity_value=9999 WHERE id=?').run(customerId);
  insertOpportunity(db, {
    id: customerId + 10000,
    customerId,
    stage: 'discovery',
    value: 100,
    winProbability: 50
  });
  insertOpportunity(db, {
    id: customerId + 10001,
    customerId,
    stage: 'proposal',
    value: 200,
    winProbability: 25
  });
  insertOpportunity(db, {
    id: customerId + 10002,
    customerId,
    stage: 'won',
    value: 500,
    winProbability: 100
  });
  insertOpportunity(db, {
    id: customerId + 10003,
    customerId,
    stage: 'legacy-unknown',
    value: 1000,
    winProbability: 100
  });
  return customerId;
}

function injectSqliteFailure(db, callback) {
  const originalPrepare = db.prepare;
  db.prepare = function prepareWithFailure(sql) {
    if (String(sql).includes('SELECT COUNT(*) AS count')) {
      const error = new Error('sensitive sqlite fixture message');
      error.name = 'SqliteError';
      error.code = 'SQLITE_ERROR';
      throw error;
    }
    return originalPrepare.call(this, sql);
  };
  try {
    return callback();
  } finally {
    db.prepare = originalPrepare;
  }
}

function queryMutationSnapshot(db) {
  return {
    total_changes: db.prepare('SELECT total_changes() AS count').get().count,
    customers: db.prepare(`
      SELECT id,updated_at,stalled_at,next_action_at FROM customers ORDER BY id
    `).all(),
    opportunities: db.prepare(`
      SELECT id,customer_id,updated_at,value,win_probability FROM opportunities ORDER BY id
    `).all()
  };
}

test('scope context defaults members to my and org admins to organization', (t) => {
  const db = openFixture(t);
  const member = contextFor(db, IDS.ownerA);
  const orgAdmin = contextFor(db, IDS.orgAdminA);

  assert.equal(Object.isFrozen(member), true);
  assert.equal(Object.isFrozen(member.organization), true);
  assert.equal(Object.isFrozen(member.teams), true);
  assert.equal(Object.isFrozen(member.teams[0]), true);
  assert.equal(Object.isFrozen(member.team_ids), true);
  assert.equal(member.time_zone, 'Asia/Shanghai');
  assert.equal(member.is_org_admin, false);
  assert.equal(orgAdmin.is_org_admin, true);
  assert.equal(compileCustomerScope(member).scope, 'my');
  assert.equal(compileCustomerScope(orgAdmin).scope, 'organization');
});

test('owner team organization public and quarantine visibility is fail closed', (t) => {
  const db = openFixture(t);

  assert.deepEqual(customerIdsFor(db, contextFor(db, IDS.ownerA), 'my'), [
    IDS.ownedA,
    IDS.transferredA
  ]);
  assert.deepEqual(customerIdsFor(db, contextFor(db, IDS.teammateA), 'team'), [
    IDS.ownedA,
    IDS.teammateOwnedA,
    IDS.transferredA
  ]);
  assert.deepEqual(customerIdsFor(db, contextFor(db, IDS.ownerA2), 'team'), [
    IDS.ownedA2
  ]);
  assert.deepEqual(customerIdsFor(db, contextFor(db, IDS.orgAdminA), 'organization'), [
    IDS.ownedA,
    IDS.teammateOwnedA,
    IDS.ownedA2,
    IDS.transferredA,
    IDS.publicA,
    IDS.nullTeamA,
    IDS.inactiveOwnerCustomerA,
    IDS.malformedPublicA
  ]);
  assert.deepEqual(customerIdsFor(db, contextFor(db, IDS.ownerA), 'public_pool'), [
    IDS.publicA
  ]);
});

test('customer detail is team-readable and returns one bounded immutable aggregate', (t) => {
  const db = openFixture(t);
  db.prepare(`
    UPDATE customers
    SET contact_person=?,contact_info=?,notes=?
    WHERE id=?
  `).run('Owner Contact', 'owner@example.invalid', 'Detail notes', IDS.ownedA);
  insertOpportunity(db, {
    id: 41001,
    customerId: IDS.ownedA,
    name: 'Detail opportunity',
    stage: 'proposal',
    value: 12500,
    winProbability: 60
  });
  db.prepare('UPDATE opportunities SET notes=? WHERE id=?')
    .run('Opportunity detail notes', 41001);
  db.prepare(`
    INSERT INTO customer_activity (
      customer_id,user_id,action,stage_from,stage_to,notes,created_at
    ) VALUES (?,?,?,?,?,?,?)
  `).run(
    IDS.ownedA,
    IDS.ownerA,
    'follow_up',
    'lead',
    'proposal',
    'Customer activity notes',
    FIXED_AT
  );
  db.prepare(`
    INSERT INTO customer_activity (
      customer_id,user_id,action,stage_from,stage_to,notes,created_at
    ) VALUES (?,?,?,?,?,?,?)
  `).run(
    IDS.ownedA,
    IDS.outsiderB,
    'imported_history',
    null,
    null,
    'Historical activity remains visible without a cross-org actor name',
    FIXED_AT
  );
  db.prepare(`
    INSERT INTO customer_activity (
      customer_id,user_id,action,stage_from,stage_to,notes,created_at
    ) VALUES (?,?,?,?,?,?,?)
  `).run(
    IDS.ownedA,
    IDS.revokedMemberA,
    'revoked_author_history',
    null,
    null,
    'Revoked author history remains visible without the former member name',
    FIXED_AT
  );

  const detail = getCustomerDetail(db, {
    actorUserId: IDS.teammateA,
    organizationId: IDS.orgA,
    customerId: IDS.ownedA,
    requestId: 'detail-teammate'
  });

  assert.equal(detail.customer.id, IDS.ownedA);
  assert.equal(detail.customer.custody, 'owned');
  assert.equal(detail.customer.contact_person, 'Owner Contact');
  assert.equal(detail.customer.notes, 'Detail notes');
  assert.deepEqual(detail.opportunities.map((row) => row.id), [41001]);
  assert.equal(detail.opportunities[0].notes, 'Opportunity detail notes');
  assert.equal(detail.activity.length, 3);
  assert.equal(detail.activity[0].display_name, null);
  assert.equal(
    detail.activity[0].notes,
    'Revoked author history remains visible without the former member name'
  );
  assert.equal(detail.activity[1].display_name, null);
  assert.equal(
    detail.activity[1].notes,
    'Historical activity remains visible without a cross-org actor name'
  );
  assert.equal(detail.activity[2].display_name, 'scope-owner-a');
  assert.equal(detail.activity[2].notes, 'Customer activity notes');
  assert.deepEqual(detail.meta, {
    request_id: 'detail-teammate',
    scope: 'team',
    opportunities: { limit: 100, has_more: false }
  });
  assert.equal(Object.isFrozen(detail), true);
  assert.equal(Object.isFrozen(detail.customer), true);
  assert.equal(Object.isFrozen(detail.opportunities), true);
  assert.equal(Object.isFrozen(detail.activity), true);
  assert.equal(Object.isFrozen(detail.meta), true);
  assert.equal(Object.isFrozen(detail.opportunities[0]), true);
  assert.equal(Object.isFrozen(detail.activity[0]), true);
  assert.throws(() => { detail.opportunities[0].name = 'mutated'; }, TypeError);
  assert.throws(() => { detail.activity[0].notes = 'mutated'; }, TypeError);
});

test('customer detail conceals public quarantine other-team other-org and absent records', (t) => {
  const db = openFixture(t);
  const expected = {
    name: 'CrmScopeError',
    code: 'CRM_CUSTOMER_NOT_FOUND',
    status: 404,
    reason: 'not_found'
  };

  for (const customerId of [
    IDS.publicA,
    IDS.nullTeamA,
    IDS.ownedA2,
    IDS.ownedB,
    899999
  ]) {
    assert.throws(
      () => getCustomerDetail(db, {
        actorUserId: IDS.ownerA,
        organizationId: IDS.orgA,
        customerId,
        requestId: 'detail-concealment'
      }),
      (error) => {
        assert.deepEqual(publicError(error), expected);
        assert.equal(JSON.stringify(error).includes(String(customerId)), false);
        return true;
      }
    );
  }
});

test('organization admin may inspect a same-organization quarantined customer detail', (t) => {
  const db = openFixture(t);
  const detail = getCustomerDetail(db, {
    actorUserId: IDS.orgAdminA,
    organizationId: IDS.orgA,
    customerId: IDS.nullTeamA,
    requestId: 'detail-org-admin'
  });

  assert.equal(detail.customer.id, IDS.nullTeamA);
  assert.equal(detail.customer.custody, 'quarantined');
  assert.deepEqual(detail.opportunities, []);
  assert.deepEqual(detail.activity, []);
  assert.deepEqual(detail.meta, {
    request_id: 'detail-org-admin',
    scope: 'organization',
    opportunities: { limit: 100, has_more: false }
  });
});

test('customer detail bounds high-cardinality opportunity collections', (t) => {
  const db = openFixture(t);
  for (let index = 0; index < 101; index += 1) {
    insertOpportunity(db, {
      id: 50000 + index,
      customerId: IDS.ownedA,
      name: `Bounded detail opportunity ${index}`
    });
  }

  const detail = getCustomerDetail(db, {
    actorUserId: IDS.teammateA,
    organizationId: IDS.orgA,
    customerId: IDS.ownedA,
    requestId: 'detail-bounded-opportunities'
  });

  assert.equal(detail.opportunities.length, 100);
  assert.deepEqual(detail.meta.opportunities, { limit: 100, has_more: true });
  assert.equal(detail.opportunities[0].id, 50100);
  assert.equal(detail.opportunities[99].id, 50001);
});

test('opportunity detail resolves a recently updated target outside the bounded customer aggregate', (t) => {
  const db = openFixture(t);
  for (let index = 0; index < 101; index += 1) {
    insertOpportunity(db, {
      id: 51000 + index,
      customerId: IDS.ownedA,
      name: `Targeted opportunity ${index}`,
      updatedAt: index === 0 ? '2026-08-10 12:00:00' : FIXED_AT
    });
  }
  db.prepare('UPDATE opportunities SET decision_chain=?,notes=? WHERE id=?')
    .run('CMO > Procurement', 'Preserved targeted detail', 51000);

  const listed = listOpportunities(db, {
    actorUserId: IDS.teammateA,
    organizationId: IDS.orgA,
    filter: { scope: 'team', limit: 100 }
  });
  assert.equal(listed.items[0].id, 51000);

  const aggregate = getCustomerDetail(db, {
    actorUserId: IDS.teammateA,
    organizationId: IDS.orgA,
    customerId: IDS.ownedA,
    requestId: 'bounded-customer-detail'
  });
  assert.equal(aggregate.opportunities.some((row) => row.id === 51000), false);

  const detail = getOpportunityDetail(db, {
    actorUserId: IDS.teammateA,
    organizationId: IDS.orgA,
    opportunityId: 51000,
    requestId: 'targeted-opportunity-detail'
  });
  assert.equal(detail.opportunity.id, 51000);
  assert.equal(detail.opportunity.decision_chain, 'CMO > Procurement');
  assert.equal(detail.opportunity.notes, 'Preserved targeted detail');
  assert.deepEqual(detail.meta, {
    request_id: 'targeted-opportunity-detail',
    scope: 'team'
  });
  assert.equal(Object.isFrozen(detail), true);
  assert.equal(Object.isFrozen(detail.opportunity), true);
  assert.equal(Object.isFrozen(detail.meta), true);
});

test('opportunity detail uniformly conceals inaccessible and absent targets', (t) => {
  const db = openFixture(t);
  insertOpportunity(db, { id: 52001, customerId: IDS.publicA });
  insertOpportunity(db, {
    id: 52002,
    customerId: IDS.ownedA2,
    teamId: IDS.teamA2,
    ownerUserId: IDS.ownerA2
  });
  insertOpportunity(db, {
    id: 52003,
    customerId: IDS.ownedB,
    orgId: IDS.orgB,
    teamId: IDS.teamB1,
    ownerUserId: IDS.outsiderB
  });
  insertOpportunity(db, { id: 52004, customerId: IDS.nullTeamA, teamId: null });
  const expected = {
    name: 'CrmScopeError',
    code: 'CRM_CHILD_NOT_FOUND',
    status: 404,
    reason: 'not_found'
  };

  for (const opportunityId of [52001, 52002, 52003, 899999]) {
    assert.throws(
      () => getOpportunityDetail(db, {
        actorUserId: IDS.ownerA,
        organizationId: IDS.orgA,
        opportunityId,
        requestId: 'opportunity-detail-concealment'
      }),
      (error) => {
        assert.deepEqual(publicError(error), expected);
        assert.equal(JSON.stringify(error).includes(String(opportunityId)), false);
        return true;
      }
    );
  }

  const adminDetail = getOpportunityDetail(db, {
    actorUserId: IDS.orgAdminA,
    organizationId: IDS.orgA,
    opportunityId: 52004,
    requestId: 'opportunity-detail-admin'
  });
  assert.equal(adminDetail.opportunity.id, 52004);
  assert.equal(adminDetail.meta.scope, 'organization');
});

test('originator keeps read-only my visibility and customer detail after transfer', (t) => {
  const db = openFixture(t);
  const rows = customerRowsFor(db, contextFor(db, IDS.originatorA2), 'my');

  assert.deepEqual(rows, [{
    id: IDS.transferredA,
    owner_user_id: IDS.ownerA,
    custody: 'owned'
  }]);

  const detail = getCustomerDetail(db, {
    actorUserId: IDS.originatorA2,
    organizationId: IDS.orgA,
    customerId: IDS.transferredA,
    requestId: 'originator-transferred-customer-detail'
  });
  assert.equal(detail.customer.id, IDS.transferredA);
  assert.equal(detail.meta.scope, 'my');
});

test('originator may open an opportunity attached to a transferred visible customer', (t) => {
  const db = openFixture(t);
  insertOpportunity(db, {
    id: 53001,
    customerId: IDS.transferredA,
    name: 'Transferred customer opportunity'
  });

  const detail = getOpportunityDetail(db, {
    actorUserId: IDS.originatorA2,
    organizationId: IDS.orgA,
    opportunityId: 53001,
    requestId: 'originator-transferred-opportunity-detail'
  });
  assert.equal(detail.opportunity.id, 53001);
  assert.equal(detail.meta.scope, 'my');
});

test('organization scope rejects ordinary members with one bounded error', (t) => {
  const db = openFixture(t);
  const hostileScope = 'organization selector=fixture-org-a actor=101';

  assert.throws(
    () => compileCustomerScope(contextFor(db, IDS.ownerA), hostileScope),
    (error) => {
      assert.equal(error instanceof CrmScopeError, true);
      assert.deepEqual(publicError(error), {
        name: 'CrmScopeError',
        code: 'CRM_SCOPE_INVALID',
        status: 400,
        reason: 'invalid_context'
      });
      assert.equal(JSON.stringify(error).includes(hostileScope), false);
      return true;
    }
  );

  assert.throws(
    () => compileCustomerScope(contextFor(db, IDS.ownerA), 'organization'),
    (error) => {
      assert.deepEqual(publicError(error), {
        name: 'CrmScopeError',
        code: 'CRM_SCOPE_FORBIDDEN',
        status: 403,
        reason: 'insufficient_scope'
      });
      assert.equal(JSON.stringify(error).includes(String(IDS.ownerA)), false);
      return true;
    }
  );
});

test('explicit outside organization states and bare platform admin are concealed identically', (t) => {
  const db = openFixture(t);
  const attempts = [
    { actorUserId: IDS.ownerA, organizationId: 999999 },
    { actorUserId: IDS.noMembershipA, organizationId: IDS.orgA },
    { actorUserId: IDS.revokedMemberA, organizationId: IDS.orgA },
    { actorUserId: IDS.noTeamA, organizationId: IDS.orgA },
    { actorUserId: IDS.outsiderB, organizationId: IDS.orgA },
    { actorUserId: IDS.barePlatformAdmin, organizationId: IDS.orgA }
  ];
  const expected = {
    name: 'CrmScopeError',
    code: 'CRM_SCOPE_NOT_FOUND',
    status: 404,
    reason: 'not_found'
  };

  for (const attempt of attempts) {
    assert.throws(
      () => resolveCrmAccessContext(db, attempt),
      (error) => {
        assert.equal(error instanceof CrmScopeError, true);
        assert.deepEqual(publicError(error), expected);
        const serialized = JSON.stringify(error);
        for (const value of Object.values(attempt)) {
          assert.equal(serialized.includes(String(value)), false);
        }
        return true;
      }
    );
  }
});

test('customer filters are all conjunctive', (t) => {
  const db = openFixture(t);
  insertTeamMembership(db, IDS.orgA, IDS.teamA2, IDS.ownerA);
  const targetId = 30000;
  const variants = [
    {},
    { assignedTo: IDS.teammateA, createdBy: IDS.teammateA },
    { teamId: IDS.teamA2 },
    { stage: 'lead' },
    { priority: 'medium' },
    { industry: 'software' },
    { country: 'ca' },
    { tags: 'vip-plus, launch' },
    { source: 'outbound' },
    { nextActionAt: '2026-08-16 16:00:00' },
    { stalledAt: '2026-08-09 02:30:01' },
    { brandName: 'No Match', companyName: 'No Match Company' }
  ];

  for (let index = 0; index < variants.length; index += 1) {
    const id = targetId + index;
    insertFilterCustomer(db, id, variants[index]);
    insertOpportunity(db, {
      id: 40000 + index,
      customerId: id,
      teamId: variants[index].teamId || IDS.teamA1,
      ownerUserId: variants[index].assignedTo || IDS.ownerA,
      stage: 'negotiation'
    });
  }
  const opportunityStageDecoy = targetId + variants.length;
  insertFilterCustomer(db, opportunityStageDecoy);
  insertOpportunity(db, {
    id: 40000 + variants.length,
    customerId: opportunityStageDecoy,
    stage: 'discovery'
  });

  const result = listCustomers(db, {
    actorUserId: IDS.orgAdminA,
    organizationId: IDS.orgA,
    filter: {
      scope: 'organization',
      owner_id: IDS.ownerA,
      team_id: IDS.teamA1,
      customer_stage: ['proposal'],
      opportunity_stage: ['negotiation'],
      priority: ['high'],
      industry: 'FITNESS',
      country: 'US',
      tag: 'vip',
      source: 'Referral',
      next_action_due: 'today',
      stalled: true,
      keyword: 'Conjunction Marker',
      as_of: '2026-08-09T02:30:00.000Z',
      limit: 100
    }
  });

  assert.equal(result.total, 1);
  assert.deepEqual(result.items.map((item) => item.id), [targetId]);
  assert.equal(result.meta.applied_filters.owner_id, IDS.ownerA);
  assert.equal(result.meta.applied_filters.team_id, IDS.teamA1);
});

test('opportunity stage uses exists without duplicating customer totals', (t) => {
  const db = openFixture(t);
  const customerId = 31000;
  insertFilterCustomer(db, customerId, {
    brandName: 'Exists Marker',
    companyName: 'Exists Marker Company',
    source: 'exists-test'
  });
  insertOpportunity(db, { id: 41000, customerId, stage: 'negotiation' });
  insertOpportunity(db, { id: 41001, customerId, stage: 'negotiation' });

  const result = listCustomers(db, {
    actorUserId: IDS.orgAdminA,
    organizationId: IDS.orgA,
    filter: {
      scope: 'organization',
      source: 'exists-test',
      keyword: 'exists marker',
      opportunity_stage: ['negotiation'],
      as_of: '2026-08-09T02:30:00.000Z'
    }
  });

  assert.equal(result.total, 1);
  assert.deepEqual(result.items.map((item) => item.id), [customerId]);
});

test('tag and keyword matching are exact and wildcard safe', (t) => {
  const db = openFixture(t);
  insertFilterCustomer(db, 32000, {
    brandName: 'Tag Marker Exact',
    companyName: 'Tag Marker Company',
    source: 'tag-test',
    tags: 'other, vip ,last'
  });
  insertFilterCustomer(db, 32001, {
    brandName: 'Tag Marker Prefix',
    companyName: 'Tag Marker Company',
    source: 'tag-test',
    tags: 'other,vip-plus,last'
  });

  const tagged = listCustomers(db, {
    actorUserId: IDS.orgAdminA,
    organizationId: IDS.orgA,
    filter: {
      scope: 'organization',
      source: 'tag-test',
      keyword: 'tag marker',
      tag: 'VIP',
      as_of: '2026-08-09T02:30:00.000Z'
    }
  });
  assert.deepEqual(tagged.items.map((item) => item.id), [32000]);

  const wildcardRows = [
    [32100, 'Literal 100%', 'Percent Company'],
    [32101, 'Literal under_score', 'Underscore Company'],
    [32102, 'Literal back\\slash', 'Backslash Company'],
    [32103, 'Literal plain', 'Plain Company']
  ];
  for (const [id, brandName, companyName] of wildcardRows) {
    insertFilterCustomer(db, id, { brandName, companyName, source: 'wildcard-test' });
  }
  for (const [keyword, expectedId] of [['%', 32100], ['_', 32101], ['\\', 32102]]) {
    const result = listCustomers(db, {
      actorUserId: IDS.orgAdminA,
      organizationId: IDS.orgA,
      filter: {
        scope: 'organization',
        source: 'wildcard-test',
        keyword,
        as_of: '2026-08-09T02:30:00.000Z'
      }
    });
    assert.deepEqual(result.items.map((item) => item.id), [expectedId]);
  }
});

test('next action windows honor approved Asia Shanghai half-open boundaries', (t) => {
  const db = openFixture(t);
  const timestamps = [
    '2026-08-09 02:29:59',
    '2026-08-09 02:30:00',
    '2026-08-09 15:59:59',
    '2026-08-09 16:00:00',
    '2026-08-16 15:59:59',
    '2026-08-16 16:00:00',
    null
  ];
  for (let index = 0; index < timestamps.length; index += 1) {
    insertFilterCustomer(db, 33000 + index, {
      brandName: `Due Vector ${index}`,
      companyName: 'Due Vector Company',
      source: 'due-test',
      nextActionAt: timestamps[index]
    });
  }
  const expected = {
    overdue: [33000],
    today: [33002, 33001],
    next_7_days: [33004, 33003],
    later: [33005],
    none: [33006]
  };
  for (const [nextActionDue, expectedIds] of Object.entries(expected)) {
    const result = listCustomers(db, {
      actorUserId: IDS.orgAdminA,
      organizationId: IDS.orgA,
      filter: {
        scope: 'organization',
        source: 'due-test',
        keyword: 'due vector',
        next_action_due: nextActionDue,
        as_of: '2026-08-09T02:30:00.000Z',
        limit: 100
      }
    });
    assert.deepEqual(result.items.map((item) => item.id), expectedIds, nextActionDue);
  }
});

test('stalled true and false partition the authorized filtered set at as of', (t) => {
  const db = openFixture(t);
  const stalledValues = [
    '2026-08-09 02:29:59',
    '2026-08-09 02:30:00',
    null,
    '2026-08-09 02:30:01'
  ];
  for (let index = 0; index < stalledValues.length; index += 1) {
    insertFilterCustomer(db, 34000 + index, {
      brandName: `Stalled Vector ${index}`,
      companyName: 'Stalled Vector Company',
      source: 'stalled-test',
      stalledAt: stalledValues[index]
    });
  }
  const beforeChanges = db.prepare('SELECT total_changes() AS count').get().count;
  const beforeRows = db.prepare(`
    SELECT id,updated_at,stalled_at FROM customers ORDER BY id
  `).all();
  const common = {
    scope: 'organization',
    source: 'stalled-test',
    keyword: 'stalled vector',
    as_of: '2026-08-09T02:30:00.000Z',
    limit: 100
  };

  const stalled = listCustomers(db, {
    actorUserId: IDS.orgAdminA,
    organizationId: IDS.orgA,
    filter: { ...common, stalled: true }
  });
  const active = listCustomers(db, {
    actorUserId: IDS.orgAdminA,
    organizationId: IDS.orgA,
    filter: { ...common, stalled: false }
  });

  assert.deepEqual(stalled.items.map((item) => item.id), [34001, 34000]);
  assert.deepEqual(active.items.map((item) => item.id), [34003, 34002]);
  assert.deepEqual(
    [...stalled.items, ...active.items].map((item) => item.id).sort((a, b) => a - b),
    [34000, 34001, 34002, 34003]
  );
  assert.deepEqual(db.prepare(`
    SELECT id,updated_at,stalled_at FROM customers ORDER BY id
  `).all(), beforeRows);
  assert.equal(db.prepare('SELECT total_changes() AS count').get().count, beforeChanges);
  assert.equal(db.inTransaction, false);
});

test('opportunity reads require customer custody and both organization predicates', (t) => {
  const db = openFixture(t);
  const opportunities = [
    [50001, IDS.ownedA, IDS.orgA, IDS.teamA1, IDS.ownerA],
    [50002, IDS.teammateOwnedA, IDS.orgA, IDS.teamA1, IDS.teammateA],
    [50003, IDS.ownedA2, IDS.orgA, IDS.teamA2, IDS.ownerA2],
    [50004, IDS.publicA, IDS.orgA, null, null],
    [50005, IDS.nullTeamA, IDS.orgA, null, IDS.ownerA],
    [50006, IDS.ownedB, IDS.orgB, IDS.teamB1, IDS.outsiderB],
    [50007, IDS.ownedA, IDS.orgB, IDS.teamB1, IDS.outsiderB],
    [50008, IDS.transferredA, IDS.orgA, IDS.teamA1, IDS.ownerA]
  ];
  for (const [id, customerId, orgId, teamId, ownerUserId] of opportunities) {
    insertOpportunity(db, { id, customerId, orgId, teamId, ownerUserId });
  }
  const query = (actorUserId, scope, organizationId = IDS.orgA) => listOpportunities(db, {
    actorUserId,
    organizationId,
    filter: { scope, as_of: '2026-08-09T02:30:00.000Z', limit: 100 }
  }).items.map((item) => item.id);

  assert.deepEqual(query(IDS.ownerA, 'my'), [50008, 50001]);
  assert.deepEqual(query(IDS.teammateA, 'team'), [50008, 50002, 50001]);
  assert.deepEqual(query(IDS.ownerA2, 'team'), [50003]);
  assert.deepEqual(query(IDS.ownerA, 'public_pool'), []);
  assert.deepEqual(query(IDS.orgAdminA, 'organization'), [
    50008,
    50005,
    50004,
    50003,
    50002,
    50001
  ]);
  assert.deepEqual(query(IDS.outsiderB, 'team', IDS.orgB), [50006]);
});

test('customer keyset pagination is stable across timestamp ties', (t) => {
  const db = openFixture(t);
  const rows = [
    [35000, '2026-08-09 05:00:00'],
    [35001, '2026-08-09 05:00:00'],
    [35002, '2026-08-09 04:00:00'],
    [35003, '2026-08-09 04:00:00'],
    [35004, '2026-08-09 03:00:00']
  ];
  for (const [id, updatedAt] of rows) {
    insertFilterCustomer(db, id, {
      brandName: `Customer Page ${id}`,
      companyName: 'Customer Page Company',
      source: 'customer-page',
      updatedAt
    });
  }
  const found = [];
  let cursor = null;
  let pageCount = 0;
  do {
    const result = listCustomers(db, {
      actorUserId: IDS.orgAdminA,
      organizationId: IDS.orgA,
      filter: {
        scope: 'organization',
        source: 'customer-page',
        as_of: '2026-08-09T02:30:00.000Z',
        limit: 2,
        cursor
      }
    });
    found.push(...result.items.map((item) => item.id));
    cursor = result.page.next_cursor;
    pageCount += 1;
    if (!result.page.has_more) assert.equal(cursor, null);
  } while (cursor !== null && pageCount < 10);

  assert.deepEqual(found, [35001, 35000, 35003, 35002, 35004]);
  assert.equal(new Set(found).size, found.length);
  assert.equal(pageCount, 3);
});

test('newer inserts between keyset pages do not repeat prior rows', (t) => {
  const db = openFixture(t);
  for (const [id, updatedAt] of [
    [35100, '2026-08-09 05:00:00'],
    [35101, '2026-08-09 04:00:00'],
    [35102, '2026-08-09 03:00:00'],
    [35103, '2026-08-09 02:00:00']
  ]) {
    insertFilterCustomer(db, id, {
      brandName: `Newer Page ${id}`,
      companyName: 'Newer Page Company',
      source: 'newer-page',
      updatedAt
    });
  }
  const baseFilter = {
    scope: 'organization',
    source: 'newer-page',
    as_of: '2026-08-09T02:30:00.000Z',
    limit: 2
  };
  const first = listCustomers(db, {
    actorUserId: IDS.orgAdminA,
    organizationId: IDS.orgA,
    filter: baseFilter
  });
  assert.deepEqual(first.items.map((item) => item.id), [35100, 35101]);
  assert.equal(first.page.has_more, true);
  insertFilterCustomer(db, 35104, {
    brandName: 'Newer Page Insert',
    companyName: 'Newer Page Company',
    source: 'newer-page',
    updatedAt: '2026-08-10 00:00:00'
  });

  const second = listCustomers(db, {
    actorUserId: IDS.orgAdminA,
    organizationId: IDS.orgA,
    filter: { ...baseFilter, cursor: first.page.next_cursor }
  });
  assert.deepEqual(second.items.map((item) => item.id), [35102, 35103]);
  assert.equal(second.items.some((item) => first.items.some((prior) => prior.id === item.id)), false);
  assert.equal(second.items.some((item) => item.id === 35104), false);
});

test('opportunity keyset pagination uses updated time then id descending', (t) => {
  const db = openFixture(t);
  const customerId = 35200;
  insertFilterCustomer(db, customerId, {
    brandName: 'Opportunity Page Parent',
    companyName: 'Opportunity Page Company',
    source: 'opportunity-page'
  });
  for (const [id, updatedAt] of [
    [52000, '2026-08-09 05:00:00'],
    [52001, '2026-08-09 05:00:00'],
    [52002, '2026-08-09 04:00:00'],
    [52003, '2026-08-09 04:00:00'],
    [52004, '2026-08-09 03:00:00']
  ]) {
    insertOpportunity(db, { id, customerId, updatedAt });
  }
  const found = [];
  let cursor = null;
  do {
    const result = listOpportunities(db, {
      actorUserId: IDS.orgAdminA,
      organizationId: IDS.orgA,
      filter: {
        scope: 'organization',
        source: 'opportunity-page',
        as_of: '2026-08-09T02:30:00.000Z',
        limit: 2,
        cursor
      }
    });
    found.push(...result.items.map((item) => item.id));
    cursor = result.page.next_cursor;
  } while (cursor !== null);

  assert.deepEqual(found, [52001, 52000, 52003, 52002, 52004]);
  assert.equal(new Set(found).size, found.length);
});

test('cursor validation is bounded and tied to the effective filter fingerprint', (t) => {
  const db = openFixture(t);
  for (const [id, updatedAt] of [
    [35300, '2026-08-09 05:00:00'],
    [35301, '2026-08-09 04:00:00'],
    [35302, '2026-08-09 03:00:00'],
    [35303, '2026-08-09 02:00:00']
  ]) {
    insertFilterCustomer(db, id, {
      brandName: `Cursor Marker ${id}`,
      companyName: 'Cursor Marker Company',
      source: 'cursor-test',
      updatedAt
    });
  }
  const base = {
    scope: 'organization',
    source: 'cursor-test',
    as_of: '2026-08-09T02:30:00.000Z',
    limit: 1
  };
  const first = listCustomers(db, {
    actorUserId: IDS.orgAdminA,
    organizationId: IDS.orgA,
    filter: base
  });
  assert.equal(first.page.has_more, true);

  assert.throws(
    () => listCustomers(db, {
      actorUserId: IDS.orgAdminA,
      organizationId: IDS.orgA,
      filter: { ...base, cursor: 'abc' }
    }),
    (error) => error.code === 'CRM_CURSOR_INVALID' && error.field === 'cursor'
  );
  for (const changed of [
    { scope: 'team' },
    { keyword: 'cursor marker' },
    { as_of: '2026-08-09T02:30:01.000Z' }
  ]) {
    assert.throws(
      () => listCustomers(db, {
        actorUserId: IDS.orgAdminA,
        organizationId: IDS.orgA,
        filter: { ...base, ...changed, cursor: first.page.next_cursor }
      }),
      (error) => error.code === 'CRM_CURSOR_FILTER_MISMATCH' && error.reason === 'fingerprint_mismatch'
    );
  }

  const second = listCustomers(db, {
    actorUserId: IDS.orgAdminA,
    organizationId: IDS.orgA,
    filter: { ...base, limit: 3, cursor: first.page.next_cursor }
  });
  assert.equal(second.meta.query_fingerprint, first.meta.query_fingerprint);
  assert.deepEqual(second.items.map((item) => item.id), [35301, 35302, 35303]);
});

test('customer list and dashboard reconcile on total filters fingerprint and as of', (t) => {
  const db = openFixture(t);
  const customerId = seedDashboardFixture(db);
  const filter = {
    scope: 'organization',
    source: 'dashboard-test',
    keyword: 'dashboard target',
    as_of: '2026-08-09T02:30:00.000Z',
    limit: 10
  };
  const list = listCustomers(db, {
    actorUserId: IDS.orgAdminA,
    organizationId: IDS.orgA,
    filter
  });
  const dashboard = getCrmDashboard(db, {
    actorUserId: IDS.orgAdminA,
    organizationId: IDS.orgA,
    filter
  });

  assert.deepEqual(list.items.map((item) => item.id), [customerId]);
  assert.equal(list.total, dashboard.customers.total);
  assert.deepEqual(list.meta.applied_filters, dashboard.meta.applied_filters);
  assert.equal(list.meta.query_fingerprint, dashboard.meta.query_fingerprint);
  assert.equal(list.meta.scope, dashboard.meta.scope);
  assert.equal(list.meta.as_of, dashboard.meta.as_of);
});

test('dashboard counts customers once and open opportunities once each', (t) => {
  const db = openFixture(t);
  seedDashboardFixture(db);
  const dashboard = getCrmDashboard(db, {
    actorUserId: IDS.orgAdminA,
    organizationId: IDS.orgA,
    filter: {
      scope: 'organization',
      source: 'dashboard-test',
      keyword: 'dashboard target',
      as_of: '2026-08-09T02:30:00.000Z'
    }
  });

  assert.equal(dashboard.customers.total, 1);
  assert.equal(dashboard.customers.by_stage.proposal, 1);
  assert.equal(dashboard.customers.by_group.proposal_negotiation, 1);
  assert.equal(dashboard.customers.no_next_action, 1);
  assert.equal(dashboard.customers.stalled, 1);
  assert.equal(dashboard.customers.quarantined, 0);
  assert.deepEqual(dashboard.opportunities, {
    open_count: 2,
    open_amount: 300,
    weighted_forecast: 100
  });
});

test('dashboard never falls back to customer opportunity value', (t) => {
  const db = openFixture(t);
  const customerId = seedDashboardFixture(db);
  const options = {
    actorUserId: IDS.orgAdminA,
    organizationId: IDS.orgA,
    filter: {
      scope: 'organization',
      source: 'dashboard-test',
      keyword: 'dashboard target',
      as_of: '2026-08-09T02:30:00.000Z'
    }
  };
  const before = getCrmDashboard(db, options).opportunities;
  db.prepare('UPDATE customers SET opportunity_value=123456789 WHERE id=?').run(customerId);
  const after = getCrmDashboard(db, options).opportunities;

  assert.deepEqual(before, {
    open_count: 2,
    open_amount: 300,
    weighted_forecast: 100
  });
  assert.deepEqual(after, before);
});

test('terminal unknown and malformed numeric opportunities do not inflate forecast', (t) => {
  const db = openFixture(t);
  const customerId = 36100;
  insertFilterCustomer(db, customerId, {
    brandName: 'Numeric Guard Target',
    companyName: 'Numeric Guard Company',
    source: 'numeric-test'
  });
  const rows = [
    [46100, 'discovery', 100, 50],
    [46101, 'won', 1000, 100],
    [46102, 'lost', 1000, 100],
    [46103, 'legacy-unknown', 1000, 100],
    [46104, 'proposal', null, 50],
    [46105, 'proposal', -10, 50],
    [46106, 'proposal', 'not-a-number', 50],
    [46107, 'proposal', 200, -1],
    [46108, 'proposal', 200, 101],
    [46109, 'proposal', 200, 'bad-probability']
  ];
  for (const [id, stage, value, winProbability] of rows) {
    insertOpportunity(db, { id, customerId, stage, value, winProbability });
  }
  const dashboard = getCrmDashboard(db, {
    actorUserId: IDS.orgAdminA,
    organizationId: IDS.orgA,
    filter: {
      scope: 'organization',
      source: 'numeric-test',
      keyword: 'numeric guard',
      as_of: '2026-08-09T02:30:00.000Z'
    }
  });

  assert.deepEqual(dashboard.opportunities, {
    open_count: 7,
    open_amount: 700,
    weighted_forecast: 50
  });
});

test('query success and rejection are read only and close their transaction', (t) => {
  const db = openFixture(t);
  for (const [id, updatedAt] of [
    [36200, '2026-08-09 05:00:00'],
    [36201, '2026-08-09 04:00:00']
  ]) {
    insertFilterCustomer(db, id, {
      brandName: `Read Only ${id}`,
      companyName: 'Read Only Company',
      source: 'read-only-test',
      updatedAt
    });
  }
  const filter = {
    scope: 'organization',
    source: 'read-only-test',
    as_of: '2026-08-09T02:30:00.000Z',
    limit: 1
  };
  const first = listCustomers(db, {
    actorUserId: IDS.orgAdminA,
    organizationId: IDS.orgA,
    filter
  });
  const before = queryMutationSnapshot(db);

  listCustomers(db, {
    actorUserId: IDS.orgAdminA,
    organizationId: IDS.orgA,
    filter
  });
  assert.equal(db.inTransaction, false);
  assert.throws(
    () => listCustomers(db, {
      actorUserId: IDS.ownerA,
      organizationId: IDS.orgA,
      filter
    }),
    (error) => error.code === 'CRM_SCOPE_FORBIDDEN'
  );
  assert.equal(db.inTransaction, false);
  assert.throws(
    () => listCustomers(db, {
      actorUserId: IDS.orgAdminA,
      organizationId: IDS.orgA,
      filter: {
        ...filter,
        as_of: '2026-08-09T02:30:01.000Z',
        cursor: first.page.next_cursor
      }
    }),
    (error) => error.code === 'CRM_CURSOR_FILTER_MISMATCH'
  );
  assert.equal(db.inTransaction, false);
  assert.throws(
    () => injectSqliteFailure(db, () => listCustomers(db, {
      actorUserId: IDS.orgAdminA,
      organizationId: IDS.orgA,
      filter
    })),
    (error) => error instanceof CrmQueryError && error.code === 'CRM_QUERY_FAILED'
  );
  assert.equal(db.inTransaction, false);
  assert.deepEqual(queryMutationSnapshot(db), before);
});

test('public service errors expose only fixed fields', (t) => {
  const db = openFixture(t);
  const hostile = 'organization=fixture-org-a actor=101 SELECT secret';
  assert.throws(
    () => listCustomers(db, {
      actorUserId: IDS.orgAdminA,
      organizationId: IDS.orgA,
      filter: { hostile_filter: hostile }
    }),
    (error) => {
      assert.deepEqual(publicError(error), {
        name: 'CrmContractError',
        code: 'CRM_CONTRACT_INVALID',
        field: 'filter',
        reason: 'unknown_field',
        status: 400
      });
      assert.equal(JSON.stringify(error).includes(hostile), false);
      return true;
    }
  );
  assert.throws(
    () => listCustomers(db, {
      actorUserId: IDS.ownerA,
      organizationId: IDS.orgA,
      filter: { scope: 'organization' }
    }),
    (error) => {
      assert.deepEqual(publicError(error), {
        name: 'CrmScopeError',
        code: 'CRM_SCOPE_FORBIDDEN',
        status: 403,
        reason: 'insufficient_scope'
      });
      return true;
    }
  );
  assert.throws(
    () => injectSqliteFailure(db, () => listCustomers(db, {
      actorUserId: IDS.orgAdminA,
      organizationId: IDS.orgA,
      filter: { scope: 'organization' }
    })),
    (error) => {
      assert.deepEqual(publicError(error), {
        name: 'CrmQueryError',
        code: 'CRM_QUERY_FAILED',
        status: 500,
        reason: 'query_failed'
      });
      assert.equal(JSON.stringify(error).includes('sensitive sqlite fixture message'), false);
      return true;
    }
  );
});

test('public pool opportunity stage filters cannot reveal hidden opportunities', (t) => {
  const db = openFixture(t);
  insertOpportunity(db, {
    id: 47000,
    customerId: IDS.publicA,
    orgId: IDS.orgA,
    teamId: null,
    ownerUserId: null,
    stage: 'negotiation'
  });
  const options = {
    actorUserId: IDS.ownerA,
    organizationId: IDS.orgA
  };
  const visible = listCustomers(db, {
    ...options,
    filter: {
      scope: 'public_pool',
      as_of: '2026-08-09T02:30:00.000Z'
    }
  });
  assert.deepEqual(visible.items.map((item) => item.id), [IDS.publicA]);

  for (const opportunityStage of [['negotiation'], ['discovery']]) {
    const filter = {
      scope: 'public_pool',
      opportunity_stage: opportunityStage,
      as_of: '2026-08-09T02:30:00.000Z'
    };
    const list = listCustomers(db, { ...options, filter });
    const dashboard = getCrmDashboard(db, { ...options, filter });
    assert.deepEqual(list.items, [], opportunityStage[0]);
    assert.equal(list.total, 0, opportunityStage[0]);
    assert.equal(dashboard.customers.total, 0, opportunityStage[0]);
    assert.deepEqual(dashboard.opportunities, {
      open_count: 0,
      open_amount: 0,
      weighted_forecast: 0
    });
  }
});

test('as of milliseconds remain exact at due boundaries', (t) => {
  const db = openFixture(t);
  const customerId = 37100;
  insertFilterCustomer(db, customerId, {
    brandName: 'Millisecond Boundary',
    companyName: 'Millisecond Boundary Company',
    source: 'millisecond-test',
    nextActionAt: '2026-08-09 02:30:00'
  });
  const common = {
    scope: 'organization',
    source: 'millisecond-test',
    keyword: 'millisecond boundary',
    as_of: '2026-08-09T02:30:00.500Z'
  };
  const overdue = listCustomers(db, {
    actorUserId: IDS.orgAdminA,
    organizationId: IDS.orgA,
    filter: { ...common, next_action_due: 'overdue' }
  });
  const today = listCustomers(db, {
    actorUserId: IDS.orgAdminA,
    organizationId: IDS.orgA,
    filter: { ...common, next_action_due: 'today' }
  });

  assert.deepEqual(overdue.items.map((item) => item.id), [customerId]);
  assert.deepEqual(today.items, []);
  assert.equal(overdue.meta.as_of, '2026-08-09T02:30:00.500Z');
});

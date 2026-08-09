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
const { listCustomers } = require('../services/crm_query_service');

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

test('originator keeps read-only my visibility after transfer without becoming owner', (t) => {
  const db = openFixture(t);
  const rows = customerRowsFor(db, contextFor(db, IDS.originatorA2), 'my');

  assert.deepEqual(rows, [{
    id: IDS.transferredA,
    owner_user_id: IDS.ownerA,
    custody: 'owned'
  }]);
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

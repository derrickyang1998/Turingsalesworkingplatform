const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const {
  DEFAULT_ORGANIZATION_CODE,
  resolveOrganizationScope
} = require('../services/organization_access_service');

const SERVER_ROOT = path.resolve(__dirname, '..');
const CAMPAIGN_MIGRATIONS = Object.freeze([Object.freeze({
  version: 2,
  name: '002_campaign_business_spine',
  sourcePath: 'migrations/002_campaign_business_spine.js',
  engineVersion: 1,
  dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
})]);
const UNAVAILABLE = Object.freeze({
  ok: false,
  kind: 'organization_unavailable',
  code: 'ORGANIZATION_CONTEXT_UNAVAILABLE'
});

function openDatabase(t) {
  const db = new Database(':memory:');
  t.after(() => {
    if (db.open) db.close();
  });
  assert.deepEqual(
    migrationService.runMigrations(db, {
      rootDir: SERVER_ROOT,
      registeredMigrations: CAMPAIGN_MIGRATIONS
    }),
    { status: 'managed', currentVersion: 2 }
  );
  return db;
}

function insertOrganization(db, {
  id = 2,
  code = 'explicit-organization',
  name = 'Explicit Organization'
} = {}) {
  db.prepare(`
    INSERT INTO organizations (id,code,name,created_at)
    VALUES (?,?,?,'2026-08-09 00:00:00')
  `).run(id, code, name);
  return { id, code, name };
}

function insertOrganizationMembership(db, {
  orgId = 2,
  userId = 2,
  roleCode = 'member',
  status = 'active'
} = {}) {
  db.prepare(`
    INSERT INTO organization_memberships (
      org_id,user_id,role_code,status,created_at,revoked_at
    ) VALUES (?,?,?,?, '2026-08-09 00:00:00', ?)
  `).run(
    orgId,
    userId,
    roleCode,
    status,
    status === 'active' ? null : '2026-08-09 00:00:00'
  );
}

function insertTeamMembership(db, {
  orgId = 2,
  teamId = 201,
  userId = 2,
  teamCode = 'explicit-team',
  teamName = 'Explicit Team',
  roleCode = 'member',
  status = 'active'
} = {}) {
  db.prepare(`
    INSERT INTO teams (id,org_id,code,name,created_at)
    VALUES (?,?,?,?, '2026-08-09 00:00:00')
  `).run(teamId, orgId, teamCode, teamName);
  db.prepare(`
    INSERT INTO team_memberships (
      org_id,team_id,user_id,role_code,status,created_at,revoked_at
    ) VALUES (?,?,?,?,?, '2026-08-09 00:00:00', ?)
  `).run(
    orgId,
    teamId,
    userId,
    roleCode,
    status,
    status === 'active' ? null : '2026-08-09 00:00:00'
  );
}

function seedExplicitContext(db, options = {}) {
  const organization = insertOrganization(db, options);
  insertOrganizationMembership(db, {
    orgId: organization.id,
    userId: options.userId || 2,
    roleCode: options.roleCode || 'member',
    status: options.membershipStatus || 'active'
  });
  if (options.withTeam !== false) {
    insertTeamMembership(db, {
      orgId: organization.id,
      teamId: options.teamId || 201,
      userId: options.userId || 2,
      roleCode: options.teamRoleCode || 'member',
      status: options.teamStatus || 'active'
    });
  }
  return organization;
}

function mutationSnapshot(db) {
  return {
    organizationMemberships: db.prepare(
      'SELECT COUNT(*) AS count FROM organization_memberships'
    ).get().count,
    teamMemberships: db.prepare(
      'SELECT COUNT(*) AS count FROM team_memberships'
    ).get().count,
    sessions: db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count,
    activity: db.prepare('SELECT COUNT(*) AS count FROM activity_log').get().count
  };
}

function defaultExpectedContext(db, userId = 2) {
  const organization = db.prepare(`
    SELECT organization.id,organization.code,organization.name,membership.role_code
    FROM organizations organization
    JOIN organization_memberships membership ON membership.org_id=organization.id
    WHERE organization.code=? AND membership.user_id=?
  `).get(DEFAULT_ORGANIZATION_CODE, userId);
  const teams = db.prepare(`
    SELECT team.id,team.code,team.name,membership.role_code
    FROM team_memberships membership
    JOIN teams team
      ON team.org_id=membership.org_id
     AND team.id=membership.team_id
    WHERE membership.org_id=?
      AND membership.user_id=?
      AND membership.status='active'
    ORDER BY team.id
  `).all(organization.id, userId);
  return {
    ok: true,
    repaired: false,
    authContext: { organization, teams }
  };
}

test('implicit default organization behavior remains compatible', async (t) => {
  await t.test('success', () => {
    const db = openDatabase(t);
    assert.deepEqual(
      resolveOrganizationScope(db, { userId: 2, repairMissing: false }),
      defaultExpectedContext(db)
    );
  });

  await t.test('missing membership', () => {
    const db = openDatabase(t);
    db.prepare('DELETE FROM team_memberships WHERE org_id=1 AND user_id=2').run();
    db.prepare('DELETE FROM organization_memberships WHERE org_id=1 AND user_id=2').run();
    assert.deepEqual(resolveOrganizationScope(db, { userId: 2 }), {
      ok: false,
      kind: 'missing_membership',
      code: 'ORGANIZATION_MEMBERSHIP_MISSING'
    });
  });

  await t.test('inactive membership', () => {
    const db = openDatabase(t);
    db.prepare(`
      UPDATE organization_memberships
      SET status='revoked',revoked_at='2026-08-09 00:00:00'
      WHERE org_id=1 AND user_id=2
    `).run();
    assert.deepEqual(resolveOrganizationScope(db, { userId: 2 }), {
      ok: false,
      kind: 'inactive_membership',
      code: 'ORGANIZATION_MEMBERSHIP_INACTIVE'
    });
  });

  await t.test('no active team', () => {
    const db = openDatabase(t);
    db.prepare(`
      UPDATE team_memberships
      SET status='revoked',revoked_at='2026-08-09 00:00:00'
      WHERE org_id=1 AND user_id=2
    `).run();
    assert.deepEqual(resolveOrganizationScope(db, { userId: 2 }), {
      ok: false,
      kind: 'inactive_membership',
      code: 'ORGANIZATION_MEMBERSHIP_INACTIVE'
    });
  });

  await t.test('repair', () => {
    const db = openDatabase(t);
    db.prepare('DELETE FROM team_memberships WHERE org_id=1 AND user_id=2').run();
    db.prepare('DELETE FROM organization_memberships WHERE org_id=1 AND user_id=2').run();
    const beforeActivity = mutationSnapshot(db).activity;
    const result = resolveOrganizationScope(db, {
      userId: 2,
      repairMissing: true,
      actorUserId: 2,
      requestId: 'task3-default-repair'
    });
    assert.equal(result.ok, true);
    assert.equal(result.repaired, true);
    assert.equal(result.authContext.organization.code, DEFAULT_ORGANIZATION_CODE);
    assert.equal(mutationSnapshot(db).activity, beforeActivity + 1);
  });
});

test('organization id and code resolve the same active context', (t) => {
  const db = openDatabase(t);
  const organization = seedExplicitContext(db);

  const byNumber = resolveOrganizationScope(db, {
    userId: 2,
    organizationId: organization.id
  });
  const byString = resolveOrganizationScope(db, {
    userId: 2,
    organizationId: String(organization.id)
  });
  const byCode = resolveOrganizationScope(db, {
    userId: 2,
    organizationCode: organization.code
  });

  assert.deepEqual(byNumber, byString);
  assert.deepEqual(byNumber, byCode);
  assert.equal(byNumber.ok, true);
  assert.equal(byNumber.repaired, false);
  assert.deepEqual(byNumber.authContext.organization, {
    id: organization.id,
    code: organization.code,
    name: organization.name,
    role_code: 'member'
  });
  assert.deepEqual(byNumber.authContext.teams, [{
    id: 201,
    code: 'explicit-team',
    name: 'Explicit Team',
    role_code: 'member'
  }]);
});

test('selectors are mutually exclusive by property presence', (t) => {
  const db = openDatabase(t);
  for (const options of [
    { userId: 2, organizationId: 2, organizationCode: 'explicit-organization' },
    { userId: 2, organizationId: undefined, organizationCode: undefined },
    { userId: 2, organizationId: null, organizationCode: null }
  ]) {
    assert.throws(
      () => resolveOrganizationScope(db, options),
      { name: 'TypeError', message: 'organizationId and organizationCode are mutually exclusive' }
    );
  }
  assert.throws(
    () => resolveOrganizationScope(db, { userId: 2, organizationId: undefined }),
    /organizationId must be a positive canonical safe integer/
  );
  assert.throws(
    () => resolveOrganizationScope(db, { userId: 2, organizationCode: null }),
    /organizationCode must be an exact string of 1 to 80 characters/
  );
});

test('selector canonicalization never coerces caller values', (t) => {
  const db = openDatabase(t);
  for (const value of [0, -1, 1.5, '01', '+1', ' 1', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => resolveOrganizationScope(db, { userId: 2, organizationId: value }),
      /organizationId must be a positive canonical safe integer/
    );
  }
  for (const value of ['', ' leading', 'trailing ', 2, new String('explicit-organization')]) {
    assert.throws(
      () => resolveOrganizationScope(db, { userId: 2, organizationCode: value }),
      /organizationCode must be an exact string of 1 to 80 characters/
    );
  }

  let coercions = 0;
  const coercive = {
    valueOf() { coercions += 1; return 2; },
    toString() { coercions += 1; return 'explicit-organization'; },
    [Symbol.toPrimitive]() { coercions += 1; return 2; }
  };
  assert.throws(
    () => resolveOrganizationScope(db, { userId: 2, organizationId: coercive }),
    /organizationId must be a positive canonical safe integer/
  );
  assert.throws(
    () => resolveOrganizationScope(db, { userId: 2, organizationCode: coercive }),
    /organizationCode must be an exact string of 1 to 80 characters/
  );
  assert.equal(coercions, 0);
});

test('explicit context conceals every unavailable organization state without writes', async (t) => {
  const scenarios = [
    {
      name: 'missing organization',
      arrange() {},
      options: { organizationId: 999 }
    },
    {
      name: 'missing membership',
      arrange(db) { insertOrganization(db); },
      options: { organizationId: 2 }
    },
    {
      name: 'inactive membership',
      arrange(db) {
        seedExplicitContext(db, { membershipStatus: 'revoked' });
      },
      options: { organizationCode: 'explicit-organization' }
    },
    {
      name: 'no active team',
      arrange(db) {
        seedExplicitContext(db, { withTeam: false });
      },
      options: { organizationCode: 'explicit-organization' }
    }
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, () => {
      const db = openDatabase(t);
      scenario.arrange(db);
      const before = mutationSnapshot(db);
      assert.deepEqual(
        resolveOrganizationScope(db, { userId: 2, ...scenario.options }),
        UNAVAILABLE
      );
      assert.deepEqual(mutationSnapshot(db), before);
    });
  }
});

test('explicit context cannot request membership repair', (t) => {
  const db = openDatabase(t);
  const before = mutationSnapshot(db);
  for (const selector of [
    { organizationId: 1 },
    { organizationCode: DEFAULT_ORGANIZATION_CODE },
    { organizationId: 999 }
  ]) {
    assert.throws(
      () => resolveOrganizationScope(db, {
        userId: 2,
        repairMissing: true,
        actorUserId: 2,
        requestId: 'task3-explicit-repair',
        ...selector
      }),
      {
        name: 'TypeError',
        message: 'repairMissing is only supported for the implicit default organization'
      }
    );
    assert.deepEqual(mutationSnapshot(db), before);
  }
});

test('bare platform admin has no cross-organization bypass', (t) => {
  const db = openDatabase(t);
  const organization = insertOrganization(db);
  assert.equal(db.prepare('SELECT role FROM users WHERE id=1').get().role, 'admin');
  assert.deepEqual(
    resolveOrganizationScope(db, { userId: 1, organizationId: organization.id }),
    UNAVAILABLE
  );

  insertOrganizationMembership(db, {
    orgId: organization.id,
    userId: 1,
    roleCode: 'member'
  });
  insertTeamMembership(db, {
    orgId: organization.id,
    userId: 1,
    roleCode: 'member'
  });
  const result = resolveOrganizationScope(db, {
    userId: 1,
    organizationCode: organization.code
  });
  assert.equal(result.ok, true);
  assert.equal(result.authContext.organization.role_code, 'member');
  assert.equal(result.authContext.teams[0].role_code, 'member');
});

test('new selector options preserve hostile-container defenses', (t) => {
  const db = openDatabase(t);
  let getterCalls = 0;
  const accessorOptions = { userId: 2 };
  Object.defineProperty(accessorOptions, 'organizationId', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 2;
    }
  });
  assert.throws(
    () => resolveOrganizationScope(db, accessorOptions),
    /userId must be a positive canonical safe integer/
  );
  assert.equal(getterCalls, 0);

  let trapCalls = 0;
  const proxy = new Proxy({ userId: 2, organizationId: 2 }, {
    get() { trapCalls += 1; return undefined; },
    getOwnPropertyDescriptor() { trapCalls += 1; return undefined; },
    getPrototypeOf() { trapCalls += 1; return Object.prototype; }
  });
  assert.throws(
    () => resolveOrganizationScope(db, proxy),
    /userId must be a positive canonical safe integer/
  );
  assert.equal(trapCalls, 0);
});

test('ordinary explicit resolution never writes a support audit', (t) => {
  const db = openDatabase(t);
  const organization = seedExplicitContext(db);
  const beforeSuccess = mutationSnapshot(db);
  assert.equal(resolveOrganizationScope(db, {
    userId: 2,
    organizationId: organization.id
  }).ok, true);
  assert.deepEqual(mutationSnapshot(db), beforeSuccess);

  const beforeFailure = mutationSnapshot(db);
  assert.deepEqual(resolveOrganizationScope(db, {
    userId: 2,
    organizationId: 999
  }), UNAVAILABLE);
  assert.deepEqual(mutationSnapshot(db), beforeFailure);
});

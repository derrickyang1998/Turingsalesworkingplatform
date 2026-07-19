const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const path = require('node:path');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const {
  DEFAULT_ORGANIZATION_CODE,
  resolveOrganizationScope,
  getAssignmentDecision,
  getCampaignCreationDecision,
  projectIdentityState,
  runIdentityProjectionTransaction
} = require('../services/organization_access_service');
const {
  getCampaignAccess,
  resolveRecordCustody,
  getTargetAccess,
  buildCollectionAccessPredicate,
  serializeWorkspaceLink,
  serializeEventMetadata,
  serializeKnowledgeReference,
  resolveConversationCampaign,
  projectKnowledgeVisibility,
  projectKnowledgeSource,
  buildCrmDependencyQueries,
  listCrmDependencies
} = require('../services/campaign_access_service');

const SERVER_ROOT = path.resolve(__dirname, '..');
const CAMPAIGN_MIGRATIONS = Object.freeze([Object.freeze({
  version: 2,
  name: '002_campaign_business_spine',
  sourcePath: 'migrations/002_campaign_business_spine.js',
  engineVersion: 1,
  dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
})]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function openCampaignDatabase(t) {
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
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  assert.equal(db.pragma('recursive_triggers', { simple: true }), 1);
  return db;
}

function defaultIdentity(db) {
  const organization = db.prepare(
    'SELECT id FROM organizations WHERE code=?'
  ).get(DEFAULT_ORGANIZATION_CODE);
  assert.ok(organization);
  const teams = db.prepare(`
    SELECT team_id AS teamId,user_id AS userId
    FROM team_memberships
    WHERE org_id=? AND status='active'
    ORDER BY user_id
  `).all(organization.id);
  return {
    orgId: organization.id,
    adminId: 1,
    ownerId: 2,
    teammateId: 3,
    outsiderId: 4,
    ownerTeamId: teams.find((row) => row.userId === 2).teamId,
    outsiderTeamId: teams.find((row) => row.userId === 4).teamId
  };
}

function seedCampaigns(db) {
  const identity = defaultIdentity(db);
  db.prepare(`
    UPDATE team_memberships
    SET role_code='team_lead'
    WHERE org_id=? AND team_id=? AND user_id=?
  `).run(identity.orgId, identity.ownerTeamId, identity.ownerId);
  db.prepare(`
    INSERT INTO customers (
      id,brand_name,company_name,stage,source,created_by,assigned_to,is_public
    ) VALUES (1001,'Access Brand','Access Brand Ltd','qualified','access-test',2,2,1)
  `).run();
  db.prepare(`
    INSERT INTO opportunities (
      id,customer_id,name,stage,value,win_probability,product_name,channel_type,created_by
    ) VALUES (
      2001,1001,'Access Launch','proposal',12000,70,'Access Product','influencer',2
    )
  `).run();

  const insertCampaign = db.prepare(`
    INSERT INTO campaigns (
      id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,
      lifecycle_state,operational_status,row_version
    ) VALUES (
      @id,@orgId,@name,1001,2001,@ownerUserId,@teamId,
      'lead',@operationalStatus,1
    )
  `);
  const rows = [
    {
      id: 3001,
      orgId: identity.orgId,
      name: 'Active campaign',
      ownerUserId: identity.ownerId,
      teamId: identity.ownerTeamId,
      operationalStatus: 'active'
    },
    {
      id: 3002,
      orgId: identity.orgId,
      name: 'Held campaign',
      ownerUserId: identity.ownerId,
      teamId: identity.ownerTeamId,
      operationalStatus: 'on_hold'
    },
    {
      id: 3003,
      orgId: identity.orgId,
      name: 'Cancelled campaign',
      ownerUserId: identity.ownerId,
      teamId: identity.ownerTeamId,
      operationalStatus: 'cancelled'
    },
    {
      id: 3004,
      orgId: identity.orgId,
      name: 'Other team campaign',
      ownerUserId: identity.outsiderId,
      teamId: identity.outsiderTeamId,
      operationalStatus: 'active'
    },
    {
      id: 3006,
      orgId: identity.orgId,
      name: 'Move destination campaign',
      ownerUserId: identity.ownerId,
      teamId: identity.ownerTeamId,
      operationalStatus: 'active'
    }
  ];
  for (const row of rows) insertCampaign.run(row);

  db.prepare(`
    INSERT INTO organizations (id,code,name,created_at)
    VALUES (2,'access-other-organization','Other Organization','2026-07-01 00:00:00')
  `).run();
  db.prepare(`
    INSERT INTO organization_memberships (
      org_id,user_id,role_code,status,created_at
    ) VALUES (2,4,'org_admin','active','2026-07-01 00:00:00')
  `).run();
  db.prepare(`
    INSERT INTO teams (id,org_id,code,name,created_at)
    VALUES (201,2,'other-team','Other Team','2026-07-01 00:00:00')
  `).run();
  db.prepare(`
    INSERT INTO team_memberships (
      org_id,team_id,user_id,role_code,status,created_at
    ) VALUES (2,201,4,'team_lead','active','2026-07-01 00:00:00')
  `).run();
  insertCampaign.run({
    id: 3005,
    orgId: 2,
    name: 'Cross organization campaign',
    ownerUserId: 4,
    teamId: 201,
    operationalStatus: 'active'
  });
  return identity;
}

function insertLink(db, {
  label,
  orgId = 1,
  campaignId,
  recordType,
  recordId,
  relationType,
  createdBy = 2
}) {
  const result = db.prepare(`
    INSERT INTO campaign_record_links (
      org_id,campaign_id,record_type,bundle_id,record_id,relation_type,
      created_by,metadata_json
    ) VALUES (?,?,?,?,?,?,?,'{}')
  `).run(
    orgId,
    campaignId,
    recordType,
    sha256(`access-bundle:${label}`),
    String(recordId),
    relationType,
    createdBy
  );
  return Number(result.lastInsertRowid);
}

function revokeLink(db, linkId, revokedBy = 2) {
  assert.equal(db.prepare(`
    UPDATE campaign_record_links
    SET revoked_at='2026-07-02 00:00:00',
      revoked_by=?,
      revoke_reason='Access correction'
    WHERE id=?
  `).run(revokedBy, linkId).changes, 1);
}

function insertSession(db, userId, suffix) {
  db.prepare(`
    INSERT INTO sessions (user_id,token,expires_at)
    VALUES (?,?,datetime('now','+1 day'))
  `).run(userId, `access-session-${suffix}`);
}

describe('RED group 1: campaign access and operational status', () => {
  test('org admin, owner, and assigned-team member read while concealment stays deterministic', (t) => {
    const db = openCampaignDatabase(t);
    const identity = seedCampaigns(db);

    for (const userId of [
      identity.adminId,
      identity.ownerId,
      identity.teammateId
    ]) {
      const access = getCampaignAccess(db, { userId, campaignId: 3001 });
      assert.equal(access.ok, true);
      assert.equal(access.permissions.read, true);
    }

    assert.deepEqual(
      getCampaignAccess(db, {
        userId: identity.ownerId,
        campaignId: 999999
      }),
      {
        ok: false,
        kind: 'not_found',
        status: 404,
        code: 'CAMPAIGN_NOT_FOUND'
      }
    );
    assert.deepEqual(
      getCampaignAccess(db, {
        userId: identity.ownerId,
        campaignId: 3005
      }),
      {
        ok: false,
        kind: 'not_found',
        status: 404,
        code: 'CAMPAIGN_NOT_FOUND'
      }
    );
    assert.deepEqual(
      getCampaignAccess(db, {
        userId: identity.ownerId,
        campaignId: 3004
      }),
      {
        ok: false,
        kind: 'forbidden',
        status: 403,
        code: 'CAMPAIGN_FORBIDDEN'
      }
    );
  });

  test('active, on-hold, and cancelled campaigns expose a closed permission matrix', (t) => {
    const db = openCampaignDatabase(t);
    const identity = seedCampaigns(db);

    const active = getCampaignAccess(db, {
      userId: identity.teammateId,
      campaignId: 3001
    });
    assert.deepEqual(active.permissions, {
      read: true,
      write: true,
      recovery: false,
      resume: false,
      cancel: true,
      correct_links: true,
      revoke_links: true,
      correct_evidence: false
    });

    const held = getCampaignAccess(db, {
      userId: identity.teammateId,
      campaignId: 3002
    });
    assert.deepEqual(held.permissions, {
      read: true,
      write: false,
      recovery: true,
      resume: true,
      cancel: true,
      correct_links: true,
      revoke_links: true,
      correct_evidence: false
    });

    const cancelledTeamMember = getCampaignAccess(db, {
      userId: identity.teammateId,
      campaignId: 3003
    });
    assert.deepEqual(cancelledTeamMember.permissions, {
      read: true,
      write: false,
      recovery: false,
      resume: false,
      cancel: false,
      correct_links: false,
      revoke_links: false,
      correct_evidence: false
    });

    const cancelledOwner = getCampaignAccess(db, {
      userId: identity.ownerId,
      campaignId: 3003
    });
    assert.equal(cancelledOwner.permissions.recovery, true);
    assert.equal(cancelledOwner.permissions.correct_links, true);
    assert.equal(cancelledOwner.permissions.revoke_links, true);
    assert.equal(cancelledOwner.permissions.correct_evidence, true);
    assert.equal(cancelledOwner.permissions.write, false);
  });

  test('stored activity flags require primitive SQLite integer booleans', (t) => {
    const db = openCampaignDatabase(t);
    const identity = seedCampaigns(db);
    const campaigns = buildCollectionAccessPredicate('campaigns', {
      userId: identity.ownerId
    });
    const bound = buildCollectionAccessPredicate('knowledge', {
      userId: identity.ownerId
    });
    const malformedOutcomes = [];

    for (const malformed of ["X'31'", "X'3120'"]) {
      db.prepare(`UPDATE users SET is_active=${malformed} WHERE id=?`)
        .run(identity.ownerId);
      const scope = resolveOrganizationScope(db, {
        userId: identity.ownerId,
        repairMissing: false
      });
      const direct = getCampaignAccess(db, {
        userId: identity.ownerId,
        campaignId: 3001
      });
      malformedOutcomes.push({
        storedType: db.prepare(
          'SELECT typeof(is_active) AS type FROM users WHERE id=?'
        ).get(identity.ownerId).type,
        projectionActive: projectIdentityState(
          db,
          identity.ownerId
        ).user.is_active,
        scopeCode: scope.code || null,
        directCode: direct.code || null,
        campaignCount: db.prepare(`
          SELECT COUNT(*) AS count
          FROM campaigns campaign
          WHERE ${campaigns.sql}
        `).get(...campaigns.params).count,
        boundCount: db.prepare(`
          WITH campaign_scope(org_id,campaign_id) AS (VALUES (?,?))
          SELECT COUNT(*) AS count
          FROM campaign_scope
          WHERE ${bound.sql}
        `).get(identity.orgId, 3001, ...bound.params).count
      });
      db.prepare('UPDATE users SET is_active=1 WHERE id=?')
        .run(identity.ownerId);
    }

    assert.deepEqual(malformedOutcomes, [
      {
        storedType: 'blob',
        projectionActive: 0,
        scopeCode: 'USER_INACTIVE',
        directCode: 'CAMPAIGN_NOT_FOUND',
        campaignCount: 0,
        boundCount: 0
      },
      {
        storedType: 'blob',
        projectionActive: 0,
        scopeCode: 'USER_INACTIVE',
        directCode: 'CAMPAIGN_NOT_FOUND',
        campaignCount: 0,
        boundCount: 0
      }
    ]);
    assert.equal(projectIdentityState(
      db,
      identity.ownerId
    ).user.is_active, 1);
    assert.equal(resolveOrganizationScope(db, {
      userId: identity.ownerId,
      repairMissing: false
    }).ok, true);
    assert.equal(getCampaignAccess(db, {
      userId: identity.ownerId,
      campaignId: 3001
    }).ok, true);
    assert.ok(db.prepare(`
      SELECT COUNT(*) AS count
      FROM campaigns campaign
      WHERE ${campaigns.sql}
    `).get(...campaigns.params).count > 0);

    db.prepare(`
      INSERT INTO demands (
        id,user_id,brand_name,company_name,product_name,status,data_json
      ) VALUES (
        4310,2,'Admin target','Admin target Co','Product','confirmed','{}'
      )
    `).run();
    const actorRaceDb = {
      prepare(sql) {
        if (/SELECT\s+id,role,is_active\s+FROM users/u.test(sql)) {
          db.prepare("UPDATE users SET is_active=X'31' WHERE id=?")
            .run(identity.adminId);
        }
        return db.prepare(sql);
      }
    };
    assert.equal(getTargetAccess(actorRaceDb, {
      userId: identity.adminId,
      campaignId: 3001,
      recordType: 'demand',
      recordId: 4310,
      relationType: 'demand',
      intent: 'read'
    }).code, 'RECORD_NOT_FOUND');
    assert.equal(
      db.prepare(
        'SELECT typeof(is_active) AS type FROM users WHERE id=?'
      ).get(identity.adminId).type,
      'blob'
    );
    db.prepare('UPDATE users SET is_active=1 WHERE id=?')
      .run(identity.adminId);

    const influencer = db.prepare(`
      SELECT id
      FROM influencers
      WHERE typeof(is_active)='integer' AND is_active=1
      ORDER BY id
      LIMIT 1
    `).get();
    assert.ok(influencer);
    db.prepare("UPDATE influencers SET is_active=X'31' WHERE id=?")
      .run(influencer.id);
    assert.equal(
      db.prepare(`
        SELECT typeof(is_active) AS type
        FROM influencers
        WHERE id=?
      `).get(influencer.id).type,
      'blob'
    );
    for (const intent of ['read', 'manage', 'attach']) {
      assert.equal(getTargetAccess(db, {
        userId: identity.ownerId,
        campaignId: 3001,
        recordType: 'influencer',
        recordId: influencer.id,
        relationType: 'shortlist',
        intent
      }).code, 'RECORD_NOT_FOUND');
    }
    db.prepare('UPDATE influencers SET is_active=1 WHERE id=?')
      .run(influencer.id);
    assert.equal(getTargetAccess(db, {
      userId: identity.ownerId,
      campaignId: 3001,
      recordType: 'influencer',
      recordId: influencer.id,
      relationType: 'shortlist',
      intent: 'read'
    }).ok, true);
  });
});

describe('RED group 2: organization repair, assignment, and CRM manage', () => {
  test('organization resolution repairs only a genuinely missing default membership', (t) => {
    const db = openCampaignDatabase(t);
    const before = db.prepare(
      'SELECT role,department,is_active FROM users WHERE id=11'
    ).get();
    insertSession(db, 11, 'repair');
    db.prepare('DELETE FROM team_memberships WHERE org_id=1 AND user_id=11').run();
    db.prepare('DELETE FROM organization_memberships WHERE org_id=1 AND user_id=11').run();

    const repaired = resolveOrganizationScope(db, {
      userId: 11,
      repairMissing: true,
      actorUserId: 11,
      requestId: 'request-login-repair'
    });
    assert.equal(repaired.ok, true);
    assert.equal(repaired.repaired, true);
    assert.deepEqual(Object.keys(repaired.authContext), ['organization', 'teams']);
    assert.equal(repaired.authContext.organization.code, DEFAULT_ORGANIZATION_CODE);
    assert.equal(repaired.authContext.teams.length, 1);
    assert.deepEqual(
      db.prepare('SELECT role,department,is_active FROM users WHERE id=11').get(),
      before
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id=11').get().count,
      0
    );
    const audit = db.prepare(`
      SELECT details
      FROM activity_log
      WHERE module='identity' AND action='identity_state_changed'
        AND json_extract(details,'$.reason')='login_membership_repair'
        AND json_extract(details,'$.subject_user_id')=11
    `).get();
    assert.ok(audit);

    const revokedBefore = db.prepare(`
      SELECT role,department,is_active
      FROM users
      WHERE id=10
    `).get();
    db.prepare(`
      UPDATE team_memberships
      SET status='revoked',revoked_at='2026-07-03 00:00:00'
      WHERE org_id=1 AND user_id=10
    `).run();
    db.prepare(`
      UPDATE organization_memberships
      SET status='revoked',revoked_at='2026-07-03 00:00:00'
      WHERE org_id=1 AND user_id=10
    `).run();
    assert.deepEqual(
      resolveOrganizationScope(db, {
        userId: 10,
        repairMissing: true,
        actorUserId: 10,
        requestId: 'request-revoked-repair'
      }),
      {
        ok: false,
        kind: 'inactive_membership',
        code: 'ORGANIZATION_MEMBERSHIP_INACTIVE'
      }
    );
    assert.deepEqual(
      db.prepare('SELECT role,department,is_active FROM users WHERE id=10').get(),
      revokedBefore
    );
    assert.equal(
      db.prepare(`
        SELECT status
        FROM organization_memberships
        WHERE org_id=1 AND user_id=10
      `).get().status,
      'revoked'
    );

    db.prepare('UPDATE users SET is_active=0 WHERE id=9').run();
    db.prepare(`
      UPDATE team_memberships
      SET status='revoked',revoked_at='2026-07-03 00:00:00'
      WHERE org_id=1 AND user_id=9
    `).run();
    db.prepare(`
      UPDATE organization_memberships
      SET status='revoked',revoked_at='2026-07-03 00:00:00'
      WHERE org_id=1 AND user_id=9
    `).run();
    assert.deepEqual(
      resolveOrganizationScope(db, {
        userId: 9,
        repairMissing: true,
        actorUserId: 9,
        requestId: 'request-deactivated-repair'
      }),
      {
        ok: false,
        kind: 'inactive_user',
        code: 'USER_INACTIVE'
      }
    );
  });

  test('assignment and campaign-creation decisions recompute team and CRM manage rules', (t) => {
    const db = openCampaignDatabase(t);
    const identity = seedCampaigns(db);

    assert.equal(getAssignmentDecision(db, {
      actorUserId: identity.adminId,
      ownerUserId: identity.teammateId,
      teamId: identity.ownerTeamId,
      mode: 'create'
    }).allowed, true);
    assert.equal(getAssignmentDecision(db, {
      actorUserId: identity.ownerId,
      ownerUserId: identity.teammateId,
      teamId: identity.ownerTeamId,
      mode: 'create'
    }).allowed, true);
    assert.equal(getAssignmentDecision(db, {
      actorUserId: identity.teammateId,
      ownerUserId: identity.teammateId,
      teamId: identity.ownerTeamId,
      mode: 'create'
    }).allowed, true);
    assert.deepEqual(getAssignmentDecision(db, {
      actorUserId: identity.teammateId,
      ownerUserId: identity.ownerId,
      teamId: identity.ownerTeamId,
      mode: 'create'
    }), {
      allowed: false,
      code: 'CAMPAIGN_ASSIGNMENT_FORBIDDEN'
    });
    assert.equal(getAssignmentDecision(db, {
      actorUserId: identity.ownerId,
      currentOwnerUserId: identity.ownerId,
      ownerUserId: identity.ownerId,
      teamId: identity.ownerTeamId,
      mode: 'transfer'
    }).allowed, true);
    assert.equal(getAssignmentDecision(db, {
      actorUserId: identity.ownerId,
      currentOwnerUserId: identity.ownerId,
      ownerUserId: identity.teammateId,
      teamId: identity.ownerTeamId,
      mode: 'transfer'
    }).allowed, true);
    assert.equal(getAssignmentDecision(db, {
      actorUserId: identity.ownerId,
      currentOwnerUserId: identity.ownerId,
      ownerUserId: identity.outsiderId,
      teamId: identity.ownerTeamId,
      mode: 'transfer'
    }).allowed, false);
    assert.equal(getAssignmentDecision(db, {
      actorUserId: identity.teammateId,
      currentOwnerUserId: identity.ownerId,
      ownerUserId: identity.teammateId,
      teamId: identity.ownerTeamId,
      mode: 'transfer'
    }).allowed, false);
    assert.equal(getAssignmentDecision(db, {
      actorUserId: identity.ownerId,
      currentOwnerUserId: identity.ownerId,
      ownerUserId: identity.outsiderId,
      teamId: identity.outsiderTeamId,
      mode: 'transfer'
    }).allowed, false);

    const teamLeadCreate = getCampaignCreationDecision(db, {
      actorUserId: identity.ownerId,
      opportunityId: 2001,
      ownerUserId: identity.teammateId,
      teamId: identity.ownerTeamId
    });
    assert.equal(teamLeadCreate.allowed, true);
    assert.equal(teamLeadCreate.customerId, 1001);
    assert.equal(teamLeadCreate.opportunityId, 2001);

    assert.deepEqual(getCampaignCreationDecision(db, {
      actorUserId: identity.teammateId,
      opportunityId: 2001,
      ownerUserId: identity.teammateId,
      teamId: identity.ownerTeamId
    }), {
      allowed: false,
      code: 'CRM_MANAGE_REQUIRED'
    });
    assert.equal(getCampaignCreationDecision(db, {
      actorUserId: identity.adminId,
      opportunityId: 2001,
      ownerUserId: identity.outsiderId,
      teamId: identity.outsiderTeamId
    }).allowed, true);
  });
});

describe('RED group 3: transactional identity projection', () => {
  test('create, role, department, active state, sessions, audit, and rollback stay atomic', (t) => {
    const db = openCampaignDatabase(t);

    const created = runIdentityProjectionTransaction(db, {
      actorUserId: 1,
      subjectUserId: 50,
      reason: 'user_create',
      requestId: 'request-user-create',
      mutateUser() {
        db.prepare(`
          INSERT INTO users (
            id,username,password_hash,display_name,role,email,department,is_active
          ) VALUES (
            50,'identity-user','test-hash','Identity User','user',
            'identity@example.invalid','Identity Department',1
          )
        `).run();
      }
    });
    assert.equal(created.changed, true);
    assert.equal(created.before, null);
    assert.equal(created.after.user.platform_role, 'member');
    assert.equal(created.after.organization_membership.role_code, 'member');
    assert.equal(created.after.team_memberships.length, 1);
    assert.deepEqual(
      Object.keys(JSON.parse(created.audit.details)),
      [
        'schema_version',
        'actor_user_id',
        'subject_user_id',
        'organization_id',
        'reason',
        'request_id',
        'changed_fields',
        'before',
        'after'
      ]
    );

    const secondaryTeamId = db.prepare(`
      SELECT id
      FROM teams
      WHERE org_id=1 AND code<>?
      ORDER BY id
      LIMIT 1
    `).get(created.after.user.department_code).id;
    db.prepare(`
      INSERT INTO team_memberships (
        org_id,team_id,user_id,role_code,status
      ) VALUES (1,?,50,'member','active')
    `).run(secondaryTeamId);
    insertSession(db, 50, 'promote');
    const promoted = runIdentityProjectionTransaction(db, {
      actorUserId: 1,
      subjectUserId: 50,
      reason: 'admin_update',
      requestId: 'request-user-promote',
      mutateUser() {
        db.prepare("UPDATE users SET role='admin' WHERE id=50").run();
      }
    });
    assert.equal(promoted.after.user.platform_role, 'platform_admin');
    assert.equal(promoted.after.organization_membership.role_code, 'org_admin');
    assert.equal(promoted.after.team_memberships.length, 2);
    assert.equal(
      promoted.after.team_memberships.every((row) => (
        row.status === 'active' && row.role_code === 'team_lead'
      )),
      true
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id=50').get().count,
      0
    );

    const demoted = runIdentityProjectionTransaction(db, {
      actorUserId: 1,
      subjectUserId: 50,
      reason: 'admin_update',
      requestId: 'request-user-demote',
      mutateUser() {
        db.prepare("UPDATE users SET role='user' WHERE id=50").run();
      }
    });
    assert.equal(demoted.after.organization_membership.role_code, 'member');
    assert.equal(
      demoted.after.team_memberships.every((row) => (
        row.status === 'active' && row.role_code === 'member'
      )),
      true
    );

    const priorTeamId = demoted.after.team_memberships
      .find((row) => row.team_id !== secondaryTeamId).team_id;
    const transferred = runIdentityProjectionTransaction(db, {
      actorUserId: 1,
      subjectUserId: 50,
      reason: 'admin_update',
      requestId: 'request-user-transfer',
      mutateUser() {
        db.prepare(`
          UPDATE users
          SET department='Identity Destination'
          WHERE id=50
        `).run();
      }
    });
    assert.equal(
      transferred.after.team_memberships.some((row) => (
        row.team_id === secondaryTeamId && row.status === 'active'
      )),
      true
    );
    assert.equal(
      transferred.after.team_memberships.some((row) => (
        row.team_id !== secondaryTeamId && row.team_id !== priorTeamId
      )),
      true
    );
    assert.equal(
      db.prepare(`
        SELECT status
        FROM team_memberships
        WHERE org_id=1 AND team_id=? AND user_id=50
      `).get(priorTeamId).status,
      'revoked'
    );

    insertSession(db, 50, 'deactivate');
    const deactivated = runIdentityProjectionTransaction(db, {
      actorUserId: 1,
      subjectUserId: 50,
      reason: 'soft_deactivate',
      requestId: 'request-user-deactivate',
      mutateUser() {
        db.prepare('UPDATE users SET is_active=0 WHERE id=50').run();
      }
    });
    assert.equal(deactivated.after.user.is_active, 0);
    assert.equal(deactivated.after.organization_membership.status, 'revoked');
    assert.equal(deactivated.after.team_memberships[0].status, 'revoked');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id=50').get().count,
      0
    );

    const reactivated = runIdentityProjectionTransaction(db, {
      actorUserId: 1,
      subjectUserId: 50,
      reason: 'reactivate',
      requestId: 'request-user-reactivate',
      mutateUser() {
        db.prepare('UPDATE users SET is_active=1 WHERE id=50').run();
      }
    });
    assert.equal(reactivated.after.organization_membership.status, 'active');
    assert.equal(reactivated.after.team_memberships[0].status, 'active');
    assert.deepEqual(projectIdentityState(db, 50), reactivated.after);

    const beforeRollback = projectIdentityState(db, 50);
    assert.throws(
      () => runIdentityProjectionTransaction(db, {
        actorUserId: 999999,
        subjectUserId: 50,
        reason: 'admin_update',
        requestId: 'request-user-rollback',
        mutateUser() {
          db.prepare("UPDATE users SET role='admin' WHERE id=50").run();
        }
      }),
      /FOREIGN KEY constraint failed/
    );
    assert.deepEqual(projectIdentityState(db, 50), beforeRollback);
    assert.equal(
      db.prepare('SELECT role FROM users WHERE id=50').get().role,
      'user'
    );
    assert.equal(db.inTransaction, false);
  });

  test('combined role changes and deactivation keep revoked identity roles coherent', (t) => {
    const db = openCampaignDatabase(t);
    const cases = [
      {
        userId: 60,
        username: 'combined-promote',
        initialRole: 'user',
        finalRole: 'admin',
        expectedPlatformRole: 'platform_admin',
        expectedOrganizationRole: 'org_admin',
        expectedTeamRole: 'team_lead',
        requestId: 'request-combined-promote-deactivate'
      },
      {
        userId: 61,
        username: 'combined-demote',
        initialRole: 'admin',
        finalRole: 'user',
        expectedPlatformRole: 'member',
        expectedOrganizationRole: 'member',
        expectedTeamRole: 'member',
        requestId: 'request-combined-demote-deactivate'
      }
    ];
    const snapshot = (userId) => ({
      projection: projectIdentityState(db, userId),
      user: db.prepare(`
        SELECT role,is_active
        FROM users
        WHERE id=?
      `).get(userId),
      organization: db.prepare(`
        SELECT role_code,status,revoked_at
        FROM organization_memberships
        WHERE user_id=?
        ORDER BY org_id
      `).all(userId),
      teams: db.prepare(`
        SELECT team_id,role_code,status,revoked_at
        FROM team_memberships
        WHERE user_id=?
        ORDER BY org_id,team_id
      `).all(userId),
      sessions: db.prepare(`
        SELECT token
        FROM sessions
        WHERE user_id=?
        ORDER BY id
      `).all(userId),
      activity: db.prepare(`
        SELECT user_id,action,module,details
        FROM activity_log
        ORDER BY id
      `).all()
    });

    for (const definition of cases) {
      runIdentityProjectionTransaction(db, {
        actorUserId: 1,
        subjectUserId: definition.userId,
        reason: 'user_create',
        requestId: 'request-create-' + definition.username,
        mutateUser() {
          db.prepare(`
            INSERT INTO users (
              id,username,password_hash,display_name,role,email,department,is_active
            ) VALUES (?,?,?,?,?,?,?,1)
          `).run(
            definition.userId,
            definition.username,
            'test-hash',
            definition.username,
            definition.initialRole,
            definition.username + '@example.invalid',
            definition.username + '-department'
          );
        }
      });
      insertSession(db, definition.userId, definition.username);

      const beforeRollback = snapshot(definition.userId);
      assert.throws(
        () => runIdentityProjectionTransaction(db, {
          actorUserId: 999999,
          subjectUserId: definition.userId,
          reason: 'soft_deactivate',
          requestId: 'request-rollback-' + definition.username,
          mutateUser() {
            db.prepare(`
              UPDATE users
              SET role=?,is_active=0
              WHERE id=?
            `).run(definition.finalRole, definition.userId);
          }
        }),
        /FOREIGN KEY constraint failed/
      );
      assert.deepEqual(snapshot(definition.userId), beforeRollback);

      const result = runIdentityProjectionTransaction(db, {
        actorUserId: 1,
        subjectUserId: definition.userId,
        reason: 'soft_deactivate',
        requestId: definition.requestId,
        mutateUser() {
          db.prepare(`
            UPDATE users
            SET role=?,is_active=0
            WHERE id=?
          `).run(definition.finalRole, definition.userId);
        }
      });
      const audit = JSON.parse(result.audit.details);
      assert.deepEqual(audit, {
        schema_version: 1,
        actor_user_id: 1,
        subject_user_id: definition.userId,
        organization_id: 1,
        reason: 'soft_deactivate',
        request_id: definition.requestId,
        changed_fields: [
          'active',
          'organization_membership',
          'role',
          'team_memberships'
        ],
        before: result.before,
        after: result.after
      });
      assert.deepEqual(
        db.prepare(`
          SELECT details
          FROM activity_log
          WHERE json_extract(details,'$.subject_user_id')=?
          ORDER BY id DESC
          LIMIT 1
        `).get(definition.userId),
        { details: result.audit.details }
      );
      assert.deepEqual(
        projectIdentityState(db, definition.userId),
        result.after
      );
      assert.deepEqual(result.after.user, {
        platform_role: definition.expectedPlatformRole,
        department_code: result.before.user.department_code,
        is_active: 0
      });
      assert.deepEqual(result.after.organization_membership, {
        role_code: definition.expectedOrganizationRole,
        status: 'revoked'
      });
      assert.equal(
        result.after.team_memberships.every((membership) => (
          membership.role_code === definition.expectedTeamRole &&
          membership.status === 'revoked'
        )),
        true
      );
      assert.deepEqual(
        db.prepare(`
          SELECT role,is_active
          FROM users
          WHERE id=?
        `).get(definition.userId),
        { role: definition.finalRole, is_active: 0 }
      );
      assert.deepEqual(
        db.prepare(`
          SELECT role_code,status
          FROM organization_memberships
          WHERE user_id=?
          ORDER BY org_id
        `).all(definition.userId),
        [{
          role_code: definition.expectedOrganizationRole,
          status: 'revoked'
        }]
      );
      assert.equal(
        db.prepare(`
          SELECT COUNT(*) AS count
          FROM team_memberships
          WHERE user_id=?
            AND (role_code<>? OR status<>'revoked')
        `).get(
          definition.userId,
          definition.expectedTeamRole
        ).count,
        0
      );
      assert.equal(
        db.prepare(`
          SELECT COUNT(*) AS count
          FROM sessions
          WHERE user_id=?
        `).get(definition.userId).count,
        0
      );
    }
  });

  test('a nested projection failure rolls back to its savepoint while the outer transaction commits', (t) => {
    const db = openCampaignDatabase(t);
    runIdentityProjectionTransaction(db, {
      actorUserId: 1,
      subjectUserId: 50,
      reason: 'user_create',
      requestId: 'request-nested-create',
      mutateUser() {
        db.prepare(`
          INSERT INTO users (
            id,username,password_hash,display_name,role,email,department,is_active
          ) VALUES (
            50,'nested-user','test-hash','Nested User','user',
            'nested@example.invalid','Nested Department',1
          )
        `).run();
      }
    });
    insertSession(db, 50, 'nested-rollback');

    const snapshot = () => ({
      user: db.prepare(`
        SELECT id,role,department,is_active
        FROM users
        WHERE id=50
      `).get(),
      organizations: db.prepare(`
        SELECT org_id,user_id,role_code,status
        FROM organization_memberships
        WHERE user_id=50
        ORDER BY org_id
      `).all(),
      teams: db.prepare(`
        SELECT org_id,team_id,user_id,role_code,status
        FROM team_memberships
        WHERE user_id=50
        ORDER BY org_id,team_id
      `).all(),
      sessions: db.prepare(`
        SELECT user_id,token
        FROM sessions
        WHERE user_id=50
        ORDER BY id
      `).all(),
      activity: db.prepare(`
        SELECT user_id,action,module,details
        FROM activity_log
        ORDER BY id
      `).all()
    });
    const before = snapshot();
    const outerDisplayName = 'Outer transaction committed';
    let nestedError = null;

    db.transaction(() => {
      try {
        runIdentityProjectionTransaction(db, {
          actorUserId: 999999,
          subjectUserId: 50,
          reason: 'admin_update',
          requestId: 'request-nested-rollback',
          mutateUser() {
            db.prepare("UPDATE users SET role='admin' WHERE id=50").run();
          }
        });
      } catch (error) {
        nestedError = error;
      }
      db.prepare('UPDATE users SET display_name=? WHERE id=11')
        .run(outerDisplayName);
    })();

    assert.match(nestedError && nestedError.message, /FOREIGN KEY constraint failed/);
    assert.deepEqual(snapshot(), before);
    assert.equal(
      db.prepare('SELECT display_name FROM users WHERE id=11').get().display_name,
      outerDisplayName
    );
    assert.equal(db.inTransaction, false);
  });
});

describe('RED group 4: target access and immutable custody', () => {
  test('target decisions distinguish invalid, concealed, forbidden, custody, and shortlist states', (t) => {
    const db = openCampaignDatabase(t);
    const identity = seedCampaigns(db);
    db.prepare(`
      INSERT INTO demands (
        id,user_id,brand_name,company_name,product_name,status,data_json
      ) VALUES
        (4001,2,'Owner demand','Owner Co','Product','confirmed','{}'),
        (4002,4,'Hidden demand','Hidden Co','Product','confirmed','{}'),
        (4003,2,'Revoked demand','Owner Co','Product','confirmed','{}'),
        (4004,2,'Other custody demand','Owner Co','Product','confirmed','{}'),
        (4005,2,'Unlinked owner demand','Owner Co','Product','confirmed','{}')
    `).run();
    db.prepare(`
      INSERT INTO proposals (id,user_id,demand_id,template_id,content)
      VALUES (4101,2,4001,'access-template','Access proposal')
    `).run();
    db.prepare(`
      INSERT INTO knowledge_entries (
        id,entry_type,source_type,source_id,key_terms,content,created_by,is_public,
        title,summary,tags_json,visibility,metadata_json,
        source_identity_sha256,content_sha256
      ) VALUES (
        4201,'note','manual','4201','access','Team-visible private-owner content',
        4,0,'Team-visible knowledge','Access test','[]','team','{}',?,?
      )
    `).run(sha256('knowledge-source-4201'), sha256('knowledge-content-4201'));

    const activeId = insertLink(db, {
      label: 'active-demand',
      campaignId: 3001,
      recordType: 'demand',
      recordId: 4001,
      relationType: 'demand'
    });
    const revokedId = insertLink(db, {
      label: 'revoked-demand',
      campaignId: 3001,
      recordType: 'demand',
      recordId: 4003,
      relationType: 'demand'
    });
    revokeLink(db, revokedId);
    const movedSourceId = insertLink(db, {
      label: 'moved-proposal-source',
      campaignId: 3001,
      recordType: 'proposal',
      recordId: 4101,
      relationType: 'proposal'
    });
    revokeLink(db, movedSourceId);
    const movedDestinationId = insertLink(db, {
      label: 'moved-proposal-destination',
      campaignId: 3006,
      recordType: 'proposal',
      recordId: 4101,
      relationType: 'proposal'
    });
    const otherCustodyId = insertLink(db, {
      label: 'other-custody-demand',
      campaignId: 3004,
      recordType: 'demand',
      recordId: 4004,
      relationType: 'demand',
      createdBy: identity.outsiderId
    });
    const influencer = db.prepare(`
      SELECT id
      FROM influencers
      WHERE is_active=1
      ORDER BY id
      LIMIT 1
    `).get();
    assert.ok(influencer);
    insertLink(db, {
      label: 'shortlist-source',
      campaignId: 3001,
      recordType: 'influencer',
      recordId: influencer.id,
      relationType: 'shortlist'
    });
    insertLink(db, {
      label: 'shortlist-destination',
      campaignId: 3004,
      recordType: 'influencer',
      recordId: influencer.id,
      relationType: 'shortlist',
      createdBy: identity.outsiderId
    });

    assert.deepEqual(resolveRecordCustody(db, {
      recordType: 'demand',
      recordId: 4001
    }), {
      classification: 'campaign_classified',
      state: 'active',
      orgId: 1,
      campaignId: 3001,
      bundleId: sha256('access-bundle:active-demand'),
      linkIds: [activeId]
    });
    assert.equal(resolveRecordCustody(db, {
      recordType: 'demand',
      recordId: 4003
    }).state, 'revoke_only');
    assert.deepEqual(resolveRecordCustody(db, {
      recordType: 'proposal',
      recordId: 4101
    }), {
      classification: 'campaign_classified',
      state: 'moved',
      orgId: 1,
      campaignId: 3006,
      bundleId: sha256('access-bundle:moved-proposal-destination'),
      linkIds: [movedDestinationId]
    });
    assert.deepEqual(resolveRecordCustody(db, {
      recordType: 'influencer',
      recordId: influencer.id
    }), {
      classification: 'shortlist_only',
      state: 'shared',
      orgId: null,
      campaignId: null,
      bundleId: null,
      linkIds: []
    });

    assert.equal(getTargetAccess(db, {
      userId: identity.ownerId,
      campaignId: 3001,
      recordType: 'demand',
      recordId: '04001',
      relationType: 'demand',
      intent: 'attach'
    }).code, 'INVALID_CAMPAIGN_LINK');
    for (const recordType of ['__proto__', 'constructor', 'toString']) {
      assert.deepEqual(getTargetAccess(db, {
        userId: identity.ownerId,
        campaignId: 3001,
        recordType,
        recordId: 4001,
        relationType: 'demand',
        intent: 'attach'
      }), {
        ok: false,
        kind: 'invalid',
        status: 400,
        code: 'INVALID_CAMPAIGN_LINK'
      });
    }
    assert.equal(getTargetAccess(db, {
      userId: identity.ownerId,
      campaignId: 3001,
      recordType: 'demand',
      recordId: 999999,
      relationType: 'demand',
      intent: 'read'
    }).code, 'RECORD_NOT_FOUND');
    assert.equal(getTargetAccess(db, {
      userId: identity.ownerId,
      campaignId: 3001,
      recordType: 'demand',
      recordId: 4002,
      relationType: 'demand',
      intent: 'read'
    }).code, 'RECORD_NOT_FOUND');
    assert.equal(getTargetAccess(db, {
      userId: identity.ownerId,
      campaignId: 3001,
      recordType: 'knowledge_entry',
      recordId: 4201,
      relationType: 'knowledge',
      intent: 'manage'
    }).code, 'RECORD_FORBIDDEN');
    assert.equal(getTargetAccess(db, {
      userId: identity.ownerId,
      campaignId: 3001,
      recordType: 'demand',
      recordId: 4004,
      relationType: 'demand',
      intent: 'read'
    }).code, 'RECORD_NOT_FOUND');
    assert.equal(resolveRecordCustody(db, {
      recordType: 'demand',
      recordId: 4004
    }).linkIds[0], otherCustodyId);
    assert.equal(getTargetAccess(db, {
      userId: identity.ownerId,
      campaignId: 3001,
      recordType: 'demand',
      recordId: 4003,
      relationType: 'demand',
      intent: 'attach'
    }).code, 'RECORD_REQUIRES_LINK_CORRECTION');
    assert.equal(getTargetAccess(db, {
      userId: identity.ownerId,
      campaignId: 3001,
      recordType: 'collaboration',
      recordId: 1,
      relationType: 'order',
      intent: 'attach'
    }).code, 'INVALID_CAMPAIGN_LINK');
    assert.equal(getTargetAccess(db, {
      userId: identity.ownerId,
      campaignId: 3002,
      recordType: 'demand',
      recordId: 999999,
      relationType: 'demand',
      intent: 'manage'
    }).code, 'RECORD_NOT_FOUND');
    assert.equal(getTargetAccess(db, {
      userId: identity.ownerId,
      campaignId: 3002,
      recordType: 'knowledge_entry',
      recordId: 4201,
      relationType: 'knowledge',
      intent: 'manage'
    }).code, 'RECORD_FORBIDDEN');
    assert.equal(getTargetAccess(db, {
      userId: identity.ownerId,
      campaignId: 3002,
      recordType: 'demand',
      recordId: 4005,
      relationType: 'demand',
      intent: 'manage'
    }).code, 'CAMPAIGN_ON_HOLD');
  });

  test('classification conflicts are disclosed only after target manage authority', (t) => {
    const db = openCampaignDatabase(t);
    const identity = seedCampaigns(db);
    db.prepare(`
      INSERT INTO knowledge_entries (
        id,entry_type,source_type,source_id,key_terms,content,created_by,is_public,
        title,summary,tags_json,visibility,metadata_json,
        source_identity_sha256,content_sha256
      ) VALUES (
        4210,'note','manual','4210','classified','Classified team content',
        3,0,'Classified team knowledge','Access precedence','[]','team','{}',?,?
      ),(
        4211,'note','manual','4211','classified','Hidden-custody owner content',
        2,0,'Hidden-custody owner knowledge','Access precedence','[]','private',
        '{}',?,?
      )
    `).run(
      sha256('knowledge-source-4210'),
      sha256('knowledge-content-4210'),
      sha256('knowledge-source-4211'),
      sha256('knowledge-content-4211')
    );
    insertLink(db, {
      label: 'classified-team-knowledge',
      campaignId: 3001,
      recordType: 'knowledge_entry',
      recordId: 4210,
      relationType: 'knowledge',
      createdBy: identity.teammateId
    });
    insertLink(db, {
      label: 'inaccessible-custody-owner-knowledge',
      campaignId: 3004,
      recordType: 'knowledge_entry',
      recordId: 4211,
      relationType: 'knowledge',
      createdBy: identity.outsiderId
    });

    assert.equal(getTargetAccess(db, {
      userId: identity.ownerId,
      campaignId: 3001,
      recordType: 'knowledge_entry',
      recordId: 4210,
      relationType: 'knowledge',
      intent: 'read'
    }).ok, true);
    for (const intent of ['attach', 'manage']) {
      assert.deepEqual(getTargetAccess(db, {
        userId: identity.ownerId,
        campaignId: 3001,
        recordType: 'knowledge_entry',
        recordId: 4210,
        relationType: 'knowledge',
        intent
      }), {
        ok: false,
        kind: 'forbidden',
        status: 403,
        code: 'RECORD_FORBIDDEN'
      });
    }
    assert.equal(getTargetAccess(db, {
      userId: identity.adminId,
      campaignId: 3001,
      recordType: 'knowledge_entry',
      recordId: 4210,
      relationType: 'knowledge',
      intent: 'attach'
    }).code, 'RECORD_REQUIRES_LINK_CORRECTION');
    assert.equal(getTargetAccess(db, {
      userId: identity.adminId,
      campaignId: 3004,
      recordType: 'knowledge_entry',
      recordId: 4210,
      relationType: 'knowledge',
      intent: 'attach'
    }).code, 'RECORD_REQUIRES_LINK_CORRECTION');
    for (const intent of ['read', 'manage']) {
      assert.equal(getTargetAccess(db, {
        userId: identity.adminId,
        campaignId: 3004,
        recordType: 'knowledge_entry',
        recordId: 4210,
        relationType: 'knowledge',
        intent
      }).code, 'KNOWLEDGE_ENTRY_NOT_FOUND');
    }
    assert.equal(getTargetAccess(db, {
      userId: identity.ownerId,
      campaignId: 3001,
      recordType: 'knowledge_entry',
      recordId: 4211,
      relationType: 'knowledge',
      intent: 'attach'
    }).code, 'KNOWLEDGE_ENTRY_NOT_FOUND');
  });

  test('a non-platform org admin manages private targets only for active same-org owners', (t) => {
    const db = openCampaignDatabase(t);
    const identity = seedCampaigns(db);
    const orgAdminId = 11;
    assert.equal(
      db.prepare('SELECT role FROM users WHERE id=?').get(orgAdminId).role,
      'user'
    );
    db.prepare(`
      UPDATE organization_memberships
      SET role_code='org_admin'
      WHERE org_id=? AND user_id=?
    `).run(identity.orgId, orgAdminId);

    const revokedOwnerId = 10;
    db.prepare(`
      UPDATE organization_memberships
      SET status='revoked',revoked_at='2026-07-03 00:00:00'
      WHERE org_id=? AND user_id=?
    `).run(identity.orgId, revokedOwnerId);

    const deactivatedOwnerId = 9;
    runIdentityProjectionTransaction(db, {
      actorUserId: identity.adminId,
      subjectUserId: deactivatedOwnerId,
      reason: 'soft_deactivate',
      requestId: 'request-target-owner-deactivate',
      mutateUser() {
        db.prepare('UPDATE users SET is_active=0 WHERE id=?')
          .run(deactivatedOwnerId);
      }
    });

    const otherOrganizationOwnerId = 60;
    db.prepare(`
      INSERT INTO users (
        id,username,password_hash,display_name,role,email,department,is_active
      ) VALUES (
        60,'other-org-owner','test-hash','Other Org Owner','user',
        'other-org-owner@example.invalid','Other Organization',1
      )
    `).run();
    db.prepare(`
      INSERT INTO organization_memberships (
        org_id,user_id,role_code,status,created_at
      ) VALUES (2,60,'member','active','2026-07-03 00:00:00')
    `).run();
    db.prepare(`
      INSERT INTO team_memberships (
        org_id,team_id,user_id,role_code,status,created_at
      ) VALUES (2,201,60,'member','active','2026-07-03 00:00:00')
    `).run();
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM organization_memberships
        WHERE org_id=? AND user_id=?
      `).get(identity.orgId, otherOrganizationOwnerId).count,
      0
    );

    const influencer = db.prepare(`
      SELECT id
      FROM influencers
      WHERE is_active=1
      ORDER BY id
      LIMIT 1
    `).get();
    assert.ok(influencer);
    const ownerCases = [
      { label: 'active-same-org', ownerUserId: identity.ownerId, allowed: true },
      { label: 'revoked', ownerUserId: revokedOwnerId, allowed: false },
      { label: 'deactivated', ownerUserId: deactivatedOwnerId, allowed: false },
      {
        label: 'other-org-only',
        ownerUserId: otherOrganizationOwnerId,
        allowed: false
      }
    ];
    const insertDemand = db.prepare(`
      INSERT INTO demands (
        id,user_id,brand_name,company_name,product_name,status,data_json
      ) VALUES (?,?,?,'Owner Access Co','Product','confirmed','{}')
    `);
    const insertCollaboration = db.prepare(`
      INSERT INTO collaborations (
        id,demand_id,influencer_id,user_id,status
      ) VALUES (?,?,?,?, 'proposed')
    `);
    const insertConversation = db.prepare(`
      INSERT INTO ai_conversations (
        id,user_id,title,visibility,source_module
      ) VALUES (?,?,?,'private','assistant')
    `);

    ownerCases.forEach((ownerCase, index) => {
      const demandId = 6201 + index;
      const collaborationId = 6101 + index;
      const conversationId = 6001 + index;
      insertDemand.run(
        demandId,
        ownerCase.ownerUserId,
        `${ownerCase.label} demand`
      );
      insertCollaboration.run(
        collaborationId,
        demandId,
        influencer.id,
        ownerCase.ownerUserId
      );
      insertConversation.run(
        conversationId,
        ownerCase.ownerUserId,
        `${ownerCase.label} conversation`
      );

      for (const intent of ['read', 'manage']) {
        for (const target of [
          {
            recordType: 'collaboration',
            recordId: collaborationId,
            relationType: 'order'
          },
          {
            recordType: 'ai_conversation',
            recordId: conversationId,
            relationType: 'ai_run'
          }
        ]) {
          const decision = getTargetAccess(db, {
            userId: orgAdminId,
            campaignId: 3001,
            ...target,
            intent
          });
          if (ownerCase.allowed) {
            assert.equal(decision.ok, true, `${ownerCase.label} ${target.recordType} ${intent}`);
          } else {
            assert.equal(
              decision.code,
              'RECORD_NOT_FOUND',
              `${ownerCase.label} ${target.recordType} ${intent}`
            );
          }
          assert.equal(getTargetAccess(db, {
            userId: identity.adminId,
            campaignId: 3001,
            ...target,
            intent
          }).ok, true, `platform admin ${ownerCase.label} ${target.recordType} ${intent}`);
        }
      }
    });
  });
});

describe('RED group 5: bound collection predicates', () => {
  test('collection predicates conceal owners and org admins without an active team', (t) => {
    const db = openCampaignDatabase(t);
    const identity = seedCampaigns(db);
    const outcomes = [];

    for (const userId of [identity.ownerId, identity.adminId]) {
      db.prepare(`
        UPDATE team_memberships
        SET status='revoked',revoked_at='2026-07-03 00:00:00'
        WHERE org_id=? AND user_id=? AND status='active'
      `).run(identity.orgId, userId);

      const scope = resolveOrganizationScope(db, {
        userId,
        repairMissing: false
      });
      const direct = getCampaignAccess(db, {
        userId,
        campaignId: 3001
      });
      const campaigns = buildCollectionAccessPredicate('campaigns', {
        userId
      });
      const bound = buildCollectionAccessPredicate('knowledge', {
        userId
      });
      outcomes.push({
        userId,
        scopeCode: scope.code,
        directCode: direct.code,
        campaignCount: db.prepare(`
          SELECT COUNT(*) AS count
          FROM campaigns campaign
          WHERE ${campaigns.sql}
        `).get(...campaigns.params).count,
        boundCount: db.prepare(`
          WITH campaign_scope(org_id,campaign_id) AS (
            VALUES (?,?),(?,?)
          )
          SELECT COUNT(*) AS count
          FROM campaign_scope
          WHERE ${bound.sql}
        `).get(
          identity.orgId,
          3001,
          identity.orgId,
          3004,
          ...bound.params
        ).count
      });
    }

    assert.deepEqual(outcomes, [
      {
        userId: identity.ownerId,
        scopeCode: 'ORGANIZATION_MEMBERSHIP_INACTIVE',
        directCode: 'CAMPAIGN_NOT_FOUND',
        campaignCount: 0,
        boundCount: 0
      },
      {
        userId: identity.adminId,
        scopeCode: 'ORGANIZATION_MEMBERSHIP_INACTIVE',
        directCode: 'CAMPAIGN_NOT_FOUND',
        campaignCount: 0,
        boundCount: 0
      }
    ]);
  });

  test('service-owned predicates filter before count/page across every campaign-bound collection', (t) => {
    const db = openCampaignDatabase(t);
    const identity = seedCampaigns(db);
    const campaignPredicate = buildCollectionAccessPredicate('campaigns', {
      userId: identity.ownerId
    });
    assert.match(campaignPredicate.sql, /campaign\./);
    assert.match(campaignPredicate.sql, /\?/);
    assert.equal(campaignPredicate.sql.includes(String(identity.ownerId)), false);
    assert.deepEqual(
      db.prepare(`
        SELECT campaign.id
        FROM campaigns campaign
        WHERE ${campaignPredicate.sql}
        ORDER BY campaign.id
        LIMIT 100
      `).all(...campaignPredicate.params).map((row) => row.id),
      [3001, 3002, 3003, 3006]
    );
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM campaigns campaign
        WHERE ${campaignPredicate.sql}
      `).get(...campaignPredicate.params).count,
      4
    );

    const boundScopes = [
      'workflow_children',
      'ai_conversations',
      'ai_messages',
      'knowledge',
      'knowledge_dedup',
      'knowledge_rag',
      'knowledge_references',
      'knowledge_categories',
      'collaboration_stats'
    ];
    const first = buildCollectionAccessPredicate(boundScopes[0], {
      userId: identity.ownerId
    });
    for (const scope of boundScopes) {
      const predicate = buildCollectionAccessPredicate(scope, {
        userId: identity.ownerId
      });
      assert.deepEqual(predicate, first);
      assert.match(predicate.sql, /campaign_scope\./);
      assert.equal(predicate.sql.includes(String(identity.ownerId)), false);
      assert.deepEqual(
        db.prepare(`
          WITH campaign_scope(org_id,campaign_id) AS (
            VALUES (1,3001),(1,3004),(2,3005)
          )
          SELECT campaign_id
          FROM campaign_scope
          WHERE ${predicate.sql}
          ORDER BY campaign_id
        `).all(...predicate.params).map((row) => row.campaign_id),
        [3001]
      );
    }

    assert.deepEqual(
      buildCollectionAccessPredicate('influencer_library', {
        userId: identity.ownerId
      }),
      { sql: '1=1', params: [] }
    );
    assert.throws(
      () => buildCollectionAccessPredicate('unknown_collection', {
        userId: identity.ownerId
      }),
      /unsupported collection scope/
    );
  });
});

describe('RED group 6: key-closed authorization serializers', () => {
  function jsonRoundTrip(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function visibleFieldsOnly(fields) {
    const value = { ...fields };
    const inaccessibleFields = [
      'id',
      'record_type',
      'record_id',
      'created_at',
      'revoked_at',
      'entry_id',
      'chunk_id',
      'chunk_index',
      'title',
      'entry_type',
      'source_type',
      'visibility',
      'is_public',
      'snippet',
      'selection_origin',
      'source_identity_sha256',
      'entry_content_sha256',
      'chunk_content_sha256'
    ];
    for (const field of inaccessibleFields) {
      if (Object.hasOwn(value, field)) continue;
      Object.defineProperty(value, field, {
        enumerable: true,
        get() {
          throw new Error('inaccessible field was read: ' + field);
        }
      });
    }
    return value;
  }

  function validEventMetadataFixtures() {
    return {
      campaign_created: {
        customer_id: 1001,
        opportunity_id: 2001,
        owner_user_id: 2,
        team_id: 8,
        row_version: 1
      },
      lifecycle_transition: {
        previous_version: 1,
        next_version: 2
      },
      operational_status_changed: {
        previous_status: 'active',
        next_status: 'on_hold',
        previous_version: 2,
        next_version: 3
      },
      campaign_transferred: {
        previous_owner_user_id: 2,
        next_owner_user_id: 3,
        previous_team_id: 8,
        next_team_id: 9,
        previous_version: 3,
        next_version: 4
      },
      link_attached: {
        bundle_id: sha256('valid-attached-bundle'),
        relation_types: ['ppt', 'proposal'],
        record_type: 'proposal',
        record_id: '4101',
        link_ids: [71, 72]
      },
      link_revoked: {
        bundle_id: sha256('valid-revoked-bundle'),
        relation_types: ['execution', 'order', 'publication', 'settlement'],
        record_type: 'collaboration',
        record_id: '6101',
        revoked_link_ids: [73, 74]
      },
      link_moved: {
        source_bundle_id: sha256('valid-source-bundle'),
        destination_bundle_id: sha256('valid-destination-bundle'),
        relation_types: ['knowledge', 'review'],
        record_type: 'knowledge_entry',
        record_id: '4201',
        source_campaign_id: 3001,
        destination_campaign_id: 3006,
        revoked_link_ids: [75, 76],
        replacement_link_ids: [77, 78]
      },
      workflow_reconciliation: {
        original_dispatch_id: 81,
        replacement_dispatch_id: 82,
        template_id: 91,
        template_version: 3
      }
    };
  }

  function fullEventAuthorization(eventType) {
    if (eventType === 'link_moved') {
      return {
        target: 'available',
        sourceCampaign: 'available',
        destinationCampaign: 'available'
      };
    }
    if (eventType === 'link_attached' || eventType === 'link_revoked') {
      return { target: 'available' };
    }
    return undefined;
  }

  test('workspace links and move events emit only full, restricted, or missing variants', () => {
    const link = {
      id: 71,
      relation_type: 'proposal',
      record_type: 'proposal',
      record_id: '4101',
      created_at: '2026-07-01 00:00:00',
      revoked_at: null,
      campaign_id: 3001,
      bundle_id: sha256('serializer-secret'),
      metadata_json: '{"secret":true}',
      extra: 'must-not-leak'
    };
    const available = serializeWorkspaceLink(link, {
      target: 'available',
      label: 'Proposal'
    });
    assert.deepEqual(jsonRoundTrip(available), {
      link_id: 71,
      relation_type: 'proposal',
      record_type: 'proposal',
      record_id: '4101',
      access_state: 'available',
      label: 'Proposal',
      created_at: '2026-07-01 00:00:00',
      revoked_at: null
    });
    assert.equal(JSON.stringify(available).includes('must-not-leak'), false);

    assert.deepEqual(jsonRoundTrip(serializeWorkspaceLink(link, {
      target: 'restricted',
      restrictedCount: 2
    })), {
      relation_type: 'proposal',
      access_state: 'restricted',
      restricted_count: 2
    });
    assert.deepEqual(jsonRoundTrip(serializeWorkspaceLink(link, {
      target: 'missing'
    })), {
      link_id: 71,
      relation_type: 'proposal',
      access_state: 'missing',
      created_at: '2026-07-01 00:00:00',
      revoked_at: null
    });

    const moveMetadata = {
      source_bundle_id: sha256('source-bundle-secret'),
      destination_bundle_id: sha256('destination-bundle-secret'),
      relation_types: ['proposal'],
      record_type: 'proposal',
      record_id: '4101',
      source_campaign_id: 3001,
      destination_campaign_id: 3006,
      revoked_link_ids: [71],
      replacement_link_ids: [72]
    };
    const fullMove = serializeEventMetadata('link_moved', moveMetadata, {
      target: 'available',
      sourceCampaign: 'available',
      destinationCampaign: 'available'
    });
    assert.deepEqual(Object.keys(fullMove), [
      'source_bundle_id',
      'destination_bundle_id',
      'relation_types',
      'record_type',
      'record_id',
      'source_campaign_id',
      'destination_campaign_id',
      'revoked_link_ids',
      'replacement_link_ids'
    ]);
    const restrictedMove = serializeEventMetadata('link_moved', moveMetadata, {
      target: 'available',
      sourceCampaign: 'available',
      destinationCampaign: 'restricted'
    });
    assert.deepEqual(restrictedMove, { access_state: 'restricted' });
    const redactedJson = JSON.stringify(restrictedMove);
    for (const secret of [
      '3001',
      '3006',
      '4101',
      '71',
      '72',
      moveMetadata.source_bundle_id,
      moveMetadata.destination_bundle_id
    ]) {
      assert.equal(redactedJson.includes(secret), false);
    }
    assert.deepEqual(serializeEventMetadata('link_moved', moveMetadata, {
      target: 'missing',
      sourceCampaign: 'available',
      destinationCampaign: 'available'
    }), { access_state: 'missing' });
    assert.throws(
      () => serializeEventMetadata('link_moved', moveMetadata, {
        target: 'available',
        sourceCampaign: 'available'
      }),
      /explicit event authorization states are required/
    );
    assert.throws(
      () => serializeEventMetadata('link_moved', moveMetadata),
      /explicit event authorization states are required/
    );
  });

  test('workspace link variants validate every visible field and stay blind to redacted fields', () => {
    const link = {
      id: 71,
      relation_type: 'proposal',
      record_type: 'proposal',
      record_id: '4101',
      created_at: '2026-07-01 00:00:00',
      revoked_at: null
    };
    const invalid = (candidate, authorization) => {
      assert.throws(
        () => serializeWorkspaceLink(candidate, authorization),
        /invalid workspace link serialization/
      );
    };

    const without = (key) => {
      const candidate = { ...link };
      delete candidate[key];
      return candidate;
    };
    for (const candidate of [
      without('id'),
      { ...link, id: undefined },
      { ...link, id: '71' },
      { ...link, id: 0 },
      without('relation_type'),
      { ...link, relation_type: undefined },
      { ...link, relation_type: 1 },
      { ...link, relation_type: 'unknown' },
      without('record_type'),
      { ...link, record_type: undefined },
      { ...link, record_type: 1 },
      { ...link, record_type: 'collaboration' },
      without('record_id'),
      { ...link, record_id: undefined },
      { ...link, record_id: 4101 },
      { ...link, record_id: '04101' },
      without('created_at'),
      { ...link, created_at: undefined },
      { ...link, created_at: null },
      { ...link, created_at: '2026-02-30 00:00:00' },
      without('revoked_at'),
      { ...link, revoked_at: undefined },
      { ...link, revoked_at: 1 },
      { ...link, revoked_at: '2026-07-01T00:00:00Z' }
    ]) {
      invalid(candidate, { target: 'available', label: 'Proposal' });
    }
    for (const label of [
      undefined,
      1,
      '',
      '   ',
      'x'.repeat(201),
      '\ud800'
    ]) {
      invalid(link, { target: 'available', label });
    }

    const restrictedLink = visibleFieldsOnly({
      relation_type: 'proposal'
    });
    assert.deepEqual(jsonRoundTrip(serializeWorkspaceLink(restrictedLink, {
      target: 'restricted',
      restrictedCount: 2
    })), {
      relation_type: 'proposal',
      access_state: 'restricted',
      restricted_count: 2
    });
    for (const candidate of [
      {},
      { relation_type: undefined },
      { relation_type: 1 },
      { relation_type: 'unknown' }
    ]) {
      invalid(candidate, { target: 'restricted', restrictedCount: 2 });
    }
    for (const restrictedCount of [undefined, '2', 0, Number.MAX_SAFE_INTEGER + 1]) {
      invalid({ relation_type: 'proposal' }, {
        target: 'restricted',
        restrictedCount
      });
    }

    const missingLink = visibleFieldsOnly({
      id: 71,
      relation_type: 'proposal',
      created_at: '2026-07-01 00:00:00',
      revoked_at: null
    });
    assert.deepEqual(jsonRoundTrip(serializeWorkspaceLink(missingLink, {
      target: 'missing'
    })), {
      link_id: 71,
      relation_type: 'proposal',
      access_state: 'missing',
      created_at: '2026-07-01 00:00:00',
      revoked_at: null
    });
    for (const candidate of [
      { relation_type: 'proposal', created_at: link.created_at, revoked_at: null },
      { id: undefined, relation_type: 'proposal', created_at: link.created_at, revoked_at: null },
      { id: '71', relation_type: 'proposal', created_at: link.created_at, revoked_at: null },
      { id: 71, created_at: link.created_at, revoked_at: null },
      { id: 71, relation_type: 'unknown', created_at: link.created_at, revoked_at: null },
      { id: 71, relation_type: 'proposal', revoked_at: null },
      { id: 71, relation_type: 'proposal', created_at: undefined, revoked_at: null },
      { id: 71, relation_type: 'proposal', created_at: 'bad', revoked_at: null },
      { id: 71, relation_type: 'proposal', created_at: link.created_at },
      { id: 71, relation_type: 'proposal', created_at: link.created_at, revoked_at: undefined },
      { id: 71, relation_type: 'proposal', created_at: link.created_at, revoked_at: 'bad' }
    ]) {
      invalid(candidate, { target: 'missing' });
    }
  });

  test('full event metadata accepts every exact documented variant', () => {
    const fixtures = validEventMetadataFixtures();
    for (const [eventType, metadata] of Object.entries(fixtures)) {
      assert.deepEqual(
        serializeEventMetadata(
          eventType,
          metadata,
          fullEventAuthorization(eventType)
        ),
        metadata,
        eventType
      );
    }
  });

  test('event serializers reject inherited discriminator names deterministically', () => {
    const fixture = validEventMetadataFixtures().link_attached;
    for (const inheritedName of ['__proto__', 'constructor', 'toString']) {
      assert.throws(
        () => serializeEventMetadata(inheritedName, {}, undefined),
        /unsupported campaign event type/
      );
      assert.throws(
        () => serializeEventMetadata('link_attached', {
          ...fixture,
          record_type: inheritedName
        }, {
          target: 'available'
        }),
        /invalid campaign event metadata/
      );
    }
  });

  test('event authorization states are snapshotted once from own data properties', () => {
    const fixtures = validEventMetadataFixtures();
    const expectedError = 'explicit event authorization states are required';
    const captureError = (operation) => {
      try {
        operation();
        return null;
      } catch (error) {
        return error.message;
      }
    };
    const statefulAuthorization = (keys) => {
      const authorization = {};
      const reads = Object.fromEntries(keys.map((key) => [key, 0]));
      for (const key of keys) {
        Object.defineProperty(authorization, key, {
          enumerable: true,
          get() {
            reads[key] += 1;
            return reads[key] === 1 ? 'restricted' : 'available';
          }
        });
      }
      return { authorization, reads };
    };
    const throwingAuthorization = new Proxy({}, {
      get() {
        throw new Error('authorization proxy value was read');
      },
      getOwnPropertyDescriptor() {
        throw new Error('authorization proxy descriptor was read');
      }
    });

    const attachedAccessor = statefulAuthorization(['target']);
    const movedAccessor = statefulAuthorization([
      'target',
      'sourceCampaign',
      'destinationCampaign'
    ]);
    const cases = [
      () => serializeEventMetadata(
        'link_attached',
        fixtures.link_attached,
        Object.create({ target: 'available' })
      ),
      () => serializeEventMetadata(
        'link_attached',
        fixtures.link_attached,
        attachedAccessor.authorization
      ),
      () => serializeEventMetadata(
        'link_attached',
        fixtures.link_attached,
        throwingAuthorization
      ),
      () => serializeEventMetadata(
        'link_moved',
        fixtures.link_moved,
        Object.create({
          target: 'available',
          sourceCampaign: 'available',
          destinationCampaign: 'available'
        })
      ),
      () => serializeEventMetadata(
        'link_moved',
        fixtures.link_moved,
        movedAccessor.authorization
      ),
      () => serializeEventMetadata(
        'link_moved',
        fixtures.link_moved,
        throwingAuthorization
      )
    ];

    assert.deepEqual(cases.map(captureError), [
      expectedError,
      expectedError,
      expectedError,
      expectedError,
      expectedError,
      expectedError
    ]);
    assert.deepEqual(attachedAccessor.reads, { target: 0 });
    assert.deepEqual(movedAccessor.reads, {
      target: 0,
      sourceCampaign: 0,
      destinationCampaign: 0
    });
  });

  test('serializer and custody proxies are rejected without executing traps', (t) => {
    const captureError = (operation) => {
      try {
        operation();
        return null;
      } catch (error) {
        return error.message;
      }
    };
    const fabricatedAuthorization = (fields) => {
      let traps = 0;
      const value = new Proxy({}, {
        get() {
          traps += 1;
          throw new Error('authorization value trap executed');
        },
        getOwnPropertyDescriptor(target, property) {
          traps += 1;
          if (!Object.hasOwn(fields, property)) return undefined;
          return {
            configurable: true,
            enumerable: true,
            writable: true,
            value: fields[property]
          };
        },
        getPrototypeOf() {
          traps += 1;
          return Object.prototype;
        },
        ownKeys() {
          traps += 1;
          return Reflect.ownKeys(fields);
        }
      });
      return { value, traps: () => traps };
    };
    const reflectingProxy = (target) => {
      let traps = 0;
      const value = new Proxy(target, {
        get(proxyTarget, property, receiver) {
          traps += 1;
          return Reflect.get(proxyTarget, property, receiver);
        },
        getOwnPropertyDescriptor(proxyTarget, property) {
          traps += 1;
          return Reflect.getOwnPropertyDescriptor(proxyTarget, property);
        },
        getPrototypeOf(proxyTarget) {
          traps += 1;
          return Reflect.getPrototypeOf(proxyTarget);
        },
        ownKeys(proxyTarget) {
          traps += 1;
          return Reflect.ownKeys(proxyTarget);
        }
      });
      return { value, traps: () => traps };
    };
    const fixture = validEventMetadataFixtures().link_attached;
    const link = {
      id: 71,
      relation_type: 'proposal',
      record_type: 'proposal',
      record_id: '4101',
      created_at: '2026-07-01 00:00:00',
      revoked_at: null
    };
    const reference = {
      rank: 1,
      entry_id: 4201,
      chunk_id: 4301,
      chunk_index: 0,
      title: 'Reference title',
      entry_type: 'note',
      source_type: 'upload',
      visibility: 'team',
      is_public: 0,
      snippet: 'Bounded snippet',
      selection_origin: 'selected',
      source_identity_sha256: sha256('proxy-reference-source'),
      entry_content_sha256: sha256('proxy-reference-entry'),
      chunk_content_sha256: sha256('proxy-reference-chunk')
    };

    const eventAuthorization = fabricatedAuthorization({
      target: 'available'
    });
    const workspaceAuthorization = fabricatedAuthorization({
      target: 'available',
      label: 'Proposal'
    });
    const referenceAuthorization = fabricatedAuthorization({
      target: 'available'
    });
    const authorizationOutcomes = [
      {
        error: captureError(() => serializeEventMetadata(
          'link_attached',
          fixture,
          eventAuthorization.value
        )),
        traps: eventAuthorization.traps()
      },
      {
        error: captureError(() => serializeWorkspaceLink(
          link,
          workspaceAuthorization.value
        )),
        traps: workspaceAuthorization.traps()
      },
      {
        error: captureError(() => serializeKnowledgeReference(
          reference,
          referenceAuthorization.value
        )),
        traps: referenceAuthorization.traps()
      }
    ];
    assert.deepEqual(authorizationOutcomes, [
      {
        error: 'explicit event authorization states are required',
        traps: 0
      },
      {
        error: 'explicit workspace target state is required',
        traps: 0
      },
      {
        error: 'explicit reference target state is required',
        traps: 0
      }
    ]);

    const availableMetadata = reflectingProxy(fixture);
    const restrictedMetadata = reflectingProxy(fixture);
    const availableLink = reflectingProxy(link);
    const restrictedLink = reflectingProxy(link);
    const availableReference = reflectingProxy(reference);
    const restrictedReference = reflectingProxy(reference);
    const proxyOutcomes = [
      {
        error: captureError(() => serializeEventMetadata(
          'link_attached',
          availableMetadata.value,
          { target: 'available' }
        )),
        traps: availableMetadata.traps()
      },
      {
        error: captureError(() => serializeEventMetadata(
          'link_attached',
          restrictedMetadata.value,
          { target: 'restricted' }
        )),
        traps: restrictedMetadata.traps()
      },
      {
        error: captureError(() => serializeWorkspaceLink(
          availableLink.value,
          { target: 'available', label: 'Proposal' }
        )),
        traps: availableLink.traps()
      },
      {
        error: captureError(() => serializeWorkspaceLink(
          restrictedLink.value,
          { target: 'restricted', restrictedCount: 1 }
        )),
        traps: restrictedLink.traps()
      },
      {
        error: captureError(() => serializeKnowledgeReference(
          availableReference.value,
          { target: 'available' }
        )),
        traps: availableReference.traps()
      },
      {
        error: captureError(() => serializeKnowledgeReference(
          restrictedReference.value,
          { target: 'restricted' }
        )),
        traps: restrictedReference.traps()
      }
    ];
    assert.deepEqual(proxyOutcomes, [
      { error: 'invalid campaign event metadata', traps: 0 },
      { error: 'invalid campaign event metadata', traps: 0 },
      { error: 'invalid workspace link serialization', traps: 0 },
      { error: 'invalid workspace link serialization', traps: 0 },
      { error: 'invalid knowledge reference serialization', traps: 0 },
      { error: 'invalid knowledge reference serialization', traps: 0 }
    ]);

    const db = openCampaignDatabase(t);
    seedCampaigns(db);
    let recordTypeTraps = 0;
    const recordType = new Proxy({
      [Symbol.toPrimitive]() {
        return 'demand';
      }
    }, {
      get(target, property, receiver) {
        recordTypeTraps += 1;
        return Reflect.get(target, property, receiver);
      }
    });
    assert.equal(captureError(() => resolveRecordCustody(db, {
      recordType,
      recordId: 4001
    })), 'unsupported campaign record type');
    assert.equal(recordTypeTraps, 0);
  });

  test('event array elements are snapshotted from own data properties before validation', () => {
    const fixture = validEventMetadataFixtures().link_attached;
    const captureError = (operation) => {
      try {
        operation();
        return null;
      } catch (error) {
        return error.message;
      }
    };
    const accessorArray = (first, later) => {
      const value = [first];
      let reads = 0;
      Object.defineProperty(value, '0', {
        configurable: true,
        enumerable: true,
        get() {
          reads += 1;
          return reads === 1 ? first : later;
        }
      });
      return { value, reads: () => reads };
    };
    const mutatingProxyArray = (first, later) => {
      const target = [first];
      let reads = 0;
      const value = new Proxy(target, {
        get(proxyTarget, property, receiver) {
          if (property === '0') {
            reads += 1;
            const current = Reflect.get(proxyTarget, property, receiver);
            proxyTarget[0] = later;
            return current;
          }
          return Reflect.get(proxyTarget, property, receiver);
        }
      });
      return { value, reads: () => reads };
    };
    const throwingProxyArray = () => {
      let traps = 0;
      const value = new Proxy(['proposal'], {
        getPrototypeOf() {
          traps += 1;
          throw new Error('event array proxy prototype was read');
        },
        ownKeys() {
          traps += 1;
          throw new Error('event array proxy keys were read');
        },
        getOwnPropertyDescriptor() {
          traps += 1;
          throw new Error('event array proxy descriptor was read');
        }
      });
      return { value, traps: () => traps };
    };

    const relationAccessor = accessorArray('proposal', '__proto__');
    const idAccessor = accessorArray(71, 0);
    const relationMutation = mutatingProxyArray('proposal', '__proto__');
    const idMutation = mutatingProxyArray(71, 0);
    const relationThrowing = throwingProxyArray();
    const idThrowing = throwingProxyArray();
    const cases = [
      () => serializeEventMetadata('link_attached', {
        ...fixture,
        relation_types: relationAccessor.value
      }, { target: 'available' }),
      () => serializeEventMetadata('link_attached', {
        ...fixture,
        link_ids: idAccessor.value
      }, { target: 'available' }),
      () => serializeEventMetadata('link_attached', {
        ...fixture,
        relation_types: relationMutation.value
      }, { target: 'available' }),
      () => serializeEventMetadata('link_attached', {
        ...fixture,
        link_ids: idMutation.value
      }, { target: 'available' }),
      () => serializeEventMetadata('link_attached', {
        ...fixture,
        relation_types: relationThrowing.value
      }, { target: 'available' }),
      () => serializeEventMetadata('link_attached', {
        ...fixture,
        link_ids: idThrowing.value
      }, { target: 'available' })
    ];

    assert.deepEqual(
      cases.map(captureError),
      Array(cases.length).fill('invalid campaign event metadata')
    );
    assert.equal(relationAccessor.reads(), 0);
    assert.equal(idAccessor.reads(), 0);
    assert.equal(relationMutation.reads(), 0);
    assert.equal(idMutation.reads(), 0);
    assert.equal(relationThrowing.traps(), 0);
    assert.equal(idThrowing.traps(), 0);
  });

  test('full event metadata enforces the frozen 4096-byte JSON boundary', () => {
    const fixture = validEventMetadataFixtures().link_attached;
    const withIds = (linkIds) => ({
      ...fixture,
      link_ids: linkIds
    });
    const jsonBytes = (metadata) => Buffer.byteLength(
      JSON.stringify(metadata),
      'utf8'
    );
    const boundaryIds = [];
    let firstOversizedIds = null;
    for (let id = 1; id <= 2000; id += 1) {
      const candidate = [...boundaryIds, id];
      if (jsonBytes(withIds(candidate)) > 4096) {
        firstOversizedIds = candidate;
        break;
      }
      boundaryIds.push(id);
    }
    assert.ok(boundaryIds.length > 0);
    assert.ok(firstOversizedIds);
    assert.ok(jsonBytes(withIds(boundaryIds)) <= 4096);
    assert.ok(jsonBytes(withIds(firstOversizedIds)) > 4096);
    assert.deepEqual(
      serializeEventMetadata(
        'link_attached',
        withIds(boundaryIds),
        { target: 'available' }
      ).link_ids,
      boundaryIds
    );

    const twoThousandIds = Array.from({ length: 2000 }, (_, index) => index + 1);
    assert.ok(jsonBytes(withIds(twoThousandIds)) > 4096);
    for (const linkIds of [firstOversizedIds, twoThousandIds]) {
      assert.throws(
        () => serializeEventMetadata(
          'link_attached',
          withIds(linkIds),
          { target: 'available' }
        ),
        /invalid campaign event metadata/
      );
    }
  });

  test('full event metadata rejects malformed shapes, values, and incompatible arrays', () => {
    const fixtures = validEventMetadataFixtures();
    const invalid = (eventType, metadata) => {
      assert.throws(
        () => serializeEventMetadata(
          eventType,
          metadata,
          fullEventAuthorization(eventType)
        ),
        /invalid campaign event metadata/,
        eventType
      );
    };

    for (const [eventType, metadata] of Object.entries(fixtures)) {
      const keys = Object.keys(metadata);
      const missing = { ...metadata };
      delete missing[keys[0]];
      invalid(eventType, missing);
      invalid(eventType, { ...metadata, extra_key: 'not allowed' });
      invalid(eventType, { ...metadata, [keys[0]]: undefined });
      invalid(eventType, { ...metadata, [keys[0]]: null });
      invalid(
        eventType,
        Object.assign(Object.create({ inherited: true }), metadata)
      );
    }

    const integerKeys = {
      campaign_created: [
        'customer_id',
        'opportunity_id',
        'owner_user_id',
        'team_id',
        'row_version'
      ],
      lifecycle_transition: ['previous_version', 'next_version'],
      operational_status_changed: ['previous_version', 'next_version'],
      campaign_transferred: [
        'previous_owner_user_id',
        'next_owner_user_id',
        'previous_team_id',
        'next_team_id',
        'previous_version',
        'next_version'
      ],
      link_moved: ['source_campaign_id', 'destination_campaign_id'],
      workflow_reconciliation: [
        'original_dispatch_id',
        'replacement_dispatch_id',
        'template_id',
        'template_version'
      ]
    };
    for (const [eventType, keys] of Object.entries(integerKeys)) {
      for (const key of keys) {
        invalid(eventType, { ...fixtures[eventType], [key]: 0 });
        invalid(eventType, { ...fixtures[eventType], [key]: '1' });
        invalid(eventType, {
          ...fixtures[eventType],
          [key]: Number.MAX_SAFE_INTEGER + 1
        });
      }
    }

    for (const key of ['previous_status', 'next_status']) {
      invalid('operational_status_changed', {
        ...fixtures.operational_status_changed,
        [key]: 'ACTIVE'
      });
      invalid('operational_status_changed', {
        ...fixtures.operational_status_changed,
        [key]: 'paused'
      });
    }

    const bundleKeys = {
      link_attached: ['bundle_id'],
      link_revoked: ['bundle_id'],
      link_moved: ['source_bundle_id', 'destination_bundle_id']
    };
    for (const [eventType, keys] of Object.entries(bundleKeys)) {
      for (const key of keys) {
        invalid(eventType, { ...fixtures[eventType], [key]: 'A'.repeat(64) });
        invalid(eventType, { ...fixtures[eventType], [key]: 'g'.repeat(64) });
        invalid(eventType, { ...fixtures[eventType], [key]: 'a'.repeat(63) });
      }
    }

    for (const eventType of ['link_attached', 'link_revoked', 'link_moved']) {
      for (const recordId of [
        1,
        '',
        '01',
        '1.0',
        '9007199254740992',
        '12345678901234567'
      ]) {
        invalid(eventType, { ...fixtures[eventType], record_id: recordId });
      }
      invalid(eventType, {
        ...fixtures[eventType],
        record_type: 'customer'
      });
      invalid(eventType, {
        ...fixtures[eventType],
        relation_types: {}
      });
      invalid(eventType, {
        ...fixtures[eventType],
        relation_types: []
      });
      invalid(eventType, {
        ...fixtures[eventType],
        relation_types: [
          fixtures[eventType].relation_types[0],
          fixtures[eventType].relation_types[0]
        ]
      });
      invalid(eventType, {
        ...fixtures[eventType],
        relation_types: [...fixtures[eventType].relation_types].reverse()
      });
      invalid(eventType, {
        ...fixtures[eventType],
        relation_types: ['unknown']
      });
      invalid(eventType, {
        ...fixtures[eventType],
        relation_types: [1]
      });
    }
    invalid('link_attached', {
      ...fixtures.link_attached,
      relation_types: ['demand']
    });
    invalid('link_revoked', {
      ...fixtures.link_revoked,
      relation_types: ['proposal']
    });
    invalid('link_moved', {
      ...fixtures.link_moved,
      relation_types: ['workflow']
    });

    const idArrayKeys = {
      link_attached: ['link_ids'],
      link_revoked: ['revoked_link_ids'],
      link_moved: ['revoked_link_ids', 'replacement_link_ids']
    };
    for (const [eventType, keys] of Object.entries(idArrayKeys)) {
      for (const key of keys) {
        invalid(eventType, { ...fixtures[eventType], [key]: {} });
        invalid(eventType, { ...fixtures[eventType], [key]: [] });
        invalid(eventType, { ...fixtures[eventType], [key]: [1, 1] });
        invalid(eventType, { ...fixtures[eventType], [key]: [2, 1] });
        invalid(eventType, { ...fixtures[eventType], [key]: [0] });
        invalid(eventType, { ...fixtures[eventType], [key]: ['1'] });
        invalid(eventType, {
          ...fixtures[eventType],
          [key]: [Number.MAX_SAFE_INTEGER + 1]
        });
        invalid(eventType, { ...fixtures[eventType], [key]: [undefined] });
      }
    }

    invalid('link_moved', {
      ...fixtures.link_moved,
      destination_campaign_id: fixtures.link_moved.source_campaign_id
    });
    invalid('link_moved', {
      ...fixtures.link_moved,
      destination_bundle_id: fixtures.link_moved.source_bundle_id
    });
  });

  test('restricted and missing event variants never inspect inaccessible metadata', () => {
    const inaccessible = visibleFieldsOnly({});
    for (const eventType of ['link_attached', 'link_revoked']) {
      assert.deepEqual(serializeEventMetadata(eventType, inaccessible, {
        target: 'restricted'
      }), { access_state: 'restricted' });
      assert.deepEqual(serializeEventMetadata(eventType, inaccessible, {
        target: 'missing'
      }), { access_state: 'missing' });
    }
    assert.deepEqual(serializeEventMetadata('link_moved', inaccessible, {
      target: 'available',
      sourceCampaign: 'restricted',
      destinationCampaign: 'available'
    }), { access_state: 'restricted' });
    assert.deepEqual(serializeEventMetadata('link_moved', inaccessible, {
      target: 'missing',
      sourceCampaign: 'available',
      destinationCampaign: 'available'
    }), { access_state: 'missing' });
  });

  test('knowledge references are full only after explicit authorization', () => {
    const reference = {
      rank: 1,
      entry_id: 4201,
      chunk_id: 4301,
      chunk_index: 0,
      title: 'Reference title',
      entry_type: 'note',
      source_type: 'upload',
      visibility: 'public',
      is_public: 1,
      snippet: 'Bounded snippet',
      selection_origin: 'selected',
      source_identity_sha256: sha256('reference-source'),
      entry_content_sha256: sha256('reference-entry'),
      chunk_content_sha256: sha256('reference-chunk'),
      raw_source_id: 'C:\\secret\\source.docx',
      extra: 'drop-me'
    };
    const full = serializeKnowledgeReference(reference, {
      target: 'available'
    });
    assert.deepEqual(jsonRoundTrip(full), {
      citation_label: 'KB-1',
      entry_id: 4201,
      chunk_id: 4301,
      chunk_index: 0,
      title: 'Reference title',
      entry_type: 'note',
      source: {
        kind: 'upload',
        label: 'Uploaded knowledge'
      },
      visibility: 'team',
      snippet: 'Bounded snippet',
      selected: true,
      rank: 1,
      source_identity_sha256: sha256('reference-source'),
      entry_content_sha256: sha256('reference-entry'),
      chunk_content_sha256: sha256('reference-chunk')
    });
    assert.equal(JSON.stringify(full).includes('secret'), false);
    assert.deepEqual(jsonRoundTrip(serializeKnowledgeReference(reference, {
      target: 'restricted'
    })), {
      citation_label: 'KB-1',
      access_state: 'restricted'
    });
    assert.deepEqual(jsonRoundTrip(serializeKnowledgeReference(reference, {
      target: 'missing'
    })), {
      citation_label: 'KB-1',
      access_state: 'missing'
    });
  });

  test('knowledge reference variants validate exact visible fields and stay blind after access loss', () => {
    const reference = {
      rank: 1,
      entry_id: 4201,
      chunk_id: 4301,
      chunk_index: 0,
      title: 'Reference title',
      entry_type: 'note',
      source_type: 'upload',
      visibility: null,
      is_public: 1,
      snippet: 'Bounded snippet',
      selection_origin: 'retrieved',
      source_identity_sha256: sha256('reference-source'),
      entry_content_sha256: sha256('reference-entry'),
      chunk_content_sha256: sha256('reference-chunk')
    };
    assert.deepEqual(jsonRoundTrip(serializeKnowledgeReference(reference, {
      target: 'available'
    })), {
      citation_label: 'KB-1',
      entry_id: 4201,
      chunk_id: 4301,
      chunk_index: 0,
      title: 'Reference title',
      entry_type: 'note',
      source: {
        kind: 'upload',
        label: 'Uploaded knowledge'
      },
      visibility: 'team',
      snippet: 'Bounded snippet',
      selected: false,
      rank: 1,
      source_identity_sha256: sha256('reference-source'),
      entry_content_sha256: sha256('reference-entry'),
      chunk_content_sha256: sha256('reference-chunk')
    });
    assert.equal(serializeKnowledgeReference({
      ...reference,
      visibility: 'unknown-legacy-visibility'
    }, {
      target: 'available'
    }).visibility, 'private');
    assert.equal(serializeKnowledgeReference({
      ...reference,
      visibility: 'x'.repeat(81)
    }, {
      target: 'available'
    }).visibility, 'private');

    const invalid = (candidate) => {
      assert.throws(
        () => serializeKnowledgeReference(candidate, {
          target: 'available'
        }),
        /invalid knowledge reference serialization/
      );
    };
    const without = (key) => {
      const candidate = { ...reference };
      delete candidate[key];
      return candidate;
    };
    for (const candidate of [
      without('rank'),
      { ...reference, rank: undefined },
      { ...reference, rank: '1' },
      { ...reference, rank: 0 },
      without('entry_id'),
      { ...reference, entry_id: undefined },
      { ...reference, entry_id: '4201' },
      { ...reference, entry_id: 0 },
      without('chunk_id'),
      { ...reference, chunk_id: undefined },
      { ...reference, chunk_id: '4301' },
      { ...reference, chunk_id: 0 },
      without('chunk_index'),
      { ...reference, chunk_index: undefined },
      { ...reference, chunk_index: '0' },
      { ...reference, chunk_index: -1 },
      without('title'),
      { ...reference, title: undefined },
      { ...reference, title: 1 },
      { ...reference, title: 'x'.repeat(201) },
      { ...reference, title: '\ud800' },
      without('entry_type'),
      { ...reference, entry_type: undefined },
      { ...reference, entry_type: 1 },
      { ...reference, entry_type: '' },
      { ...reference, entry_type: 'x'.repeat(81) },
      without('source_type'),
      { ...reference, source_type: undefined },
      { ...reference, source_type: 1 },
      { ...reference, source_type: '' },
      { ...reference, source_type: 'x'.repeat(81) },
      without('visibility'),
      { ...reference, visibility: undefined },
      { ...reference, visibility: {} },
      { ...reference, visibility: '\ud800' },
      without('is_public'),
      { ...reference, is_public: undefined },
      { ...reference, is_public: '1' },
      { ...reference, is_public: true },
      without('snippet'),
      { ...reference, snippet: undefined },
      { ...reference, snippet: 1 },
      { ...reference, snippet: 'x'.repeat(1201) },
      { ...reference, snippet: '\ud800' },
      without('selection_origin'),
      { ...reference, selection_origin: undefined },
      { ...reference, selection_origin: 1 },
      { ...reference, selection_origin: 'manual' }
    ]) {
      invalid(candidate);
    }
    for (const digestKey of [
      'source_identity_sha256',
      'entry_content_sha256',
      'chunk_content_sha256'
    ]) {
      invalid(without(digestKey));
      invalid({ ...reference, [digestKey]: undefined });
      invalid({ ...reference, [digestKey]: 1 });
      invalid({ ...reference, [digestKey]: 'A'.repeat(64) });
      invalid({ ...reference, [digestKey]: 'a'.repeat(63) });
      invalid({ ...reference, [digestKey]: 'g'.repeat(64) });
    }

    const inaccessible = visibleFieldsOnly({ rank: 1 });
    assert.deepEqual(jsonRoundTrip(serializeKnowledgeReference(inaccessible, {
      target: 'restricted'
    })), {
      citation_label: 'KB-1',
      access_state: 'restricted'
    });
    assert.deepEqual(jsonRoundTrip(serializeKnowledgeReference(inaccessible, {
      target: 'missing'
    })), {
      citation_label: 'KB-1',
      access_state: 'missing'
    });
    for (const state of ['restricted', 'missing']) {
      for (const candidate of [{}, { rank: undefined }, { rank: '1' }, { rank: 0 }]) {
        assert.throws(
          () => serializeKnowledgeReference(candidate, { target: state }),
          /invalid knowledge reference serialization/
        );
      }
    }
  });
});

describe('RED group 7: conversation, visibility, and source projections', () => {
  test('conversation campaign is immutable and knowledge projections do not expose raw values', (t) => {
    const db = openCampaignDatabase(t);
    seedCampaigns(db);
    db.prepare(`
      INSERT INTO ai_conversations (id,user_id,title,visibility,source_module)
      VALUES (5001,2,'Campaign conversation','team','assistant')
    `).run();
    insertLink(db, {
      label: 'conversation-campaign',
      campaignId: 3001,
      recordType: 'ai_conversation',
      recordId: 5001,
      relationType: 'ai_run'
    });
    assert.deepEqual(resolveConversationCampaign(db, {
      conversationId: 5001,
      requestedCampaignId: null
    }), {
      ok: true,
      campaignId: 3001,
      derived: true
    });
    assert.deepEqual(resolveConversationCampaign(db, {
      conversationId: 5001,
      requestedCampaignId: 3001
    }), {
      ok: true,
      campaignId: 3001,
      derived: true
    });
    assert.deepEqual(resolveConversationCampaign(db, {
      conversationId: 5001,
      requestedCampaignId: 3006
    }), {
      ok: false,
      kind: 'conflict',
      status: 409,
      code: 'CONVERSATION_CAMPAIGN_MISMATCH'
    });

    assert.equal(projectKnowledgeVisibility({
      legacyVisibility: 'private',
      isPublic: 1
    }), 'private');
    for (const legacyVisibility of ['team', 'public', 'shared']) {
      assert.equal(projectKnowledgeVisibility({
        legacyVisibility,
        isPublic: 0
      }), 'team');
    }
    assert.equal(projectKnowledgeVisibility({
      legacyVisibility: 'legacy-secret-token',
      isPublic: 0
    }), 'private');
    assert.equal(projectKnowledgeVisibility({
      legacyVisibility: 'legacy-secret-token',
      isPublic: 1
    }), 'private');
    assert.equal(projectKnowledgeVisibility({
      legacyVisibility: null,
      isPublic: 1
    }), 'team');
    let coercionCalls = 0;
    const coercivePublicFlag = {
      valueOf() {
        coercionCalls += 1;
        return 1;
      }
    };
    for (const isPublic of ['1', true, [1], coercivePublicFlag, 1n, 0, null, undefined]) {
      assert.equal(projectKnowledgeVisibility({
        legacyVisibility: null,
        isPublic
      }), 'private');
    }
    assert.equal(coercionCalls, 0);
    for (const legacyVisibility of [
      '',
      'TEAM',
      'legacy-secret-token',
      false,
      0,
      { visibility: 'team' }
    ]) {
      assert.equal(projectKnowledgeVisibility({
        legacyVisibility,
        isPublic: 1
      }), 'private');
    }
    assert.deepEqual(projectKnowledgeSource('campaign_review'), {
      kind: 'review',
      label: 'Campaign review'
    });
    assert.deepEqual(projectKnowledgeSource('C:\\secret\\provider-cache'), {
      kind: 'other',
      label: 'Other knowledge'
    });
    for (const sourceType of ['__proto__', 'constructor', 'toString']) {
      assert.deepEqual(projectKnowledgeSource(sourceType), {
        kind: 'other',
        label: 'Other knowledge'
      });
    }
    assert.equal(
      JSON.stringify(projectKnowledgeSource('C:\\secret\\provider-cache'))
        .includes('secret'),
      false
    );
  });
});

describe('RED group 8: CRM dependency evidence', () => {
  test('bound dependency queries enumerate only customer/opportunity campaign evidence', (t) => {
    const db = openCampaignDatabase(t);
    seedCampaigns(db);

    const customerQueries = buildCrmDependencyQueries('customer', 1001);
    assert.deepEqual(customerQueries.map((query) => query.type), [
      'campaigns',
      'opportunities'
    ]);
    for (const query of customerQueries) {
      assert.match(query.sql, /\?/);
      assert.equal(query.sql.includes('1001'), false);
      assert.deepEqual(query.params, [1001]);
      assert.equal(query.sql.includes('workflow_templates'), false);
    }
    const expectedCampaigns = db.prepare(`
      SELECT COUNT(*) AS count
      FROM campaigns
      WHERE customer_id=1001
    `).get().count;
    assert.deepEqual(listCrmDependencies(db, {
      targetType: 'customer',
      targetId: 1001
    }), [
      { type: 'campaigns', count: expectedCampaigns },
      { type: 'opportunities', count: 1 }
    ]);
    assert.deepEqual(listCrmDependencies(db, {
      targetType: 'opportunity',
      targetId: 2001
    }), [
      { type: 'campaigns', count: expectedCampaigns }
    ]);
    assert.throws(
      () => buildCrmDependencyQueries('workflow_template', 1),
      /unsupported CRM dependency target/
    );
  });
});

describe('RED group 9: exported option-container boundaries', () => {
  test('all options-style exports reject hostile containers without traps', (t) => {
    const db = openCampaignDatabase(t);
    const identity = seedCampaigns(db);
    db.prepare(`
      INSERT INTO demands (
        id,user_id,brand_name,company_name,product_name,status,data_json
      ) VALUES (
        4401,2,'Option boundary','Option Boundary Co','Product','confirmed','{}'
      )
    `).run();
    db.prepare(`
      INSERT INTO ai_conversations (
        id,user_id,title,visibility,source_module
      ) VALUES (5401,2,'Option boundary conversation','private','assistant')
    `).run();

    const capture = (operation) => {
      try {
        return {
          kind: 'return',
          value: operation()
        };
      } catch (error) {
        return {
          kind: 'throw',
          name: error.name,
          message: String(error.message)
        };
      }
    };
    const expectTypeError = (outcome, pattern) => {
      assert.equal(outcome.kind, 'throw');
      assert.equal(outcome.name, 'TypeError');
      assert.match(outcome.message, pattern);
      assert.doesNotMatch(outcome.message, /revoked/i);
    };
    const expectCode = (outcome, code) => {
      assert.equal(outcome.kind, 'return');
      assert.equal(outcome.value.code, code);
    };
    const expectAssignmentFailure = (outcome) => {
      assert.deepEqual(outcome, {
        kind: 'return',
        value: {
          allowed: false,
          code: 'CAMPAIGN_ASSIGNMENT_FORBIDDEN'
        }
      });
    };
    const trackedProxy = () => {
      let traps = 0;
      const value = new Proxy({}, {
        get(target, property, receiver) {
          traps += 1;
          return Reflect.get(target, property, receiver);
        },
        getOwnPropertyDescriptor(target, property) {
          traps += 1;
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
        getPrototypeOf(target) {
          traps += 1;
          return Reflect.getPrototypeOf(target);
        },
        ownKeys(target) {
          traps += 1;
          return Reflect.ownKeys(target);
        }
      });
      return { value, traps: () => traps };
    };
    const revokedProxy = () => {
      const revocable = Proxy.revocable({}, {});
      revocable.revoke();
      return revocable.proxy;
    };
    const getterContainer = (keys, functionContainer) => {
      let getters = 0;
      const value = functionContainer ? function optionContainer() {} : {};
      for (const key of keys) {
        Object.defineProperty(value, key, {
          configurable: true,
          enumerable: true,
          get() {
            getters += 1;
            return undefined;
          }
        });
      }
      return { value, getters: () => getters };
    };
    const arrayContainer = (keys) => {
      let getters = 0;
      const value = [];
      for (const key of keys) {
        Object.defineProperty(value, key, {
          configurable: true,
          enumerable: true,
          get() {
            getters += 1;
            return undefined;
          }
        });
      }
      return { value, getters: () => getters };
    };
    const inheritedContainer = (keys) => {
      let getters = 0;
      const prototype = {};
      for (const key of keys) {
        Object.defineProperty(prototype, key, {
          configurable: true,
          enumerable: true,
          get() {
            getters += 1;
            return undefined;
          }
        });
      }
      return {
        value: Object.create(prototype),
        getters: () => getters
      };
    };
    const coerciveValue = () => {
      let coercions = 0;
      const value = {
        [Symbol.toPrimitive]() {
          coercions += 1;
          return 2;
        },
        valueOf() {
          coercions += 1;
          return 2;
        },
        toString() {
          coercions += 1;
          return '2';
        }
      };
      return { value, coercions: () => coercions };
    };

    const definitions = [
      {
        name: 'getCampaignAccess',
        keys: ['userId', 'campaignId'],
        invoke: (options) => getCampaignAccess(db, options),
        coerciveOptions: (value) => ({ userId: value, campaignId: 3001 }),
        assertInvalid: (outcome) => expectCode(outcome, 'CAMPAIGN_NOT_FOUND'),
        assertNested: (outcome) => expectCode(outcome, 'CAMPAIGN_NOT_FOUND'),
        assertValid: (outcome) => {
          assert.equal(outcome.kind, 'return');
          assert.equal(outcome.value.ok, true);
        },
        valid: { userId: identity.ownerId, campaignId: 3001 }
      },
      {
        name: 'resolveRecordCustody',
        keys: ['recordType', 'recordId'],
        invoke: (options) => resolveRecordCustody(db, options),
        coerciveOptions: (value) => ({
          recordType: 'demand',
          recordId: value
        }),
        assertInvalid: (outcome) => expectTypeError(
          outcome,
          /unsupported campaign record type/
        ),
        assertNested: (outcome) => expectTypeError(
          outcome,
          /recordId must be a positive canonical safe integer/
        ),
        assertValid: (outcome) => {
          assert.equal(outcome.kind, 'return');
          assert.equal(outcome.value.classification, 'unclassified');
        },
        valid: { recordType: 'demand', recordId: 4401 }
      },
      {
        name: 'getTargetAccess',
        keys: [
          'userId',
          'campaignId',
          'recordType',
          'recordId',
          'relationType',
          'intent'
        ],
        invoke: (options) => getTargetAccess(db, options),
        coerciveOptions: (value) => ({
          userId: value,
          campaignId: 3001,
          recordType: 'demand',
          recordId: 4401,
          relationType: 'demand',
          intent: 'read'
        }),
        assertInvalid: (outcome) => expectCode(
          outcome,
          'INVALID_CAMPAIGN_LINK'
        ),
        assertNested: (outcome) => expectCode(
          outcome,
          'INVALID_CAMPAIGN_LINK'
        ),
        assertValid: (outcome) => {
          assert.equal(outcome.kind, 'return');
          assert.equal(outcome.value.ok, true);
        },
        valid: {
          userId: identity.ownerId,
          campaignId: 3001,
          recordType: 'demand',
          recordId: 4401,
          relationType: 'demand',
          intent: 'read'
        }
      },
      {
        name: 'buildCollectionAccessPredicate',
        keys: ['userId'],
        invoke: (options) => buildCollectionAccessPredicate(
          'campaigns',
          options
        ),
        coerciveOptions: (value) => ({ userId: value }),
        assertInvalid: (outcome) => expectTypeError(
          outcome,
          /userId must be a positive safe integer/
        ),
        assertNested: (outcome) => expectTypeError(
          outcome,
          /userId must be a positive safe integer/
        ),
        assertValid: (outcome) => {
          assert.equal(outcome.kind, 'return');
          assert.equal(typeof outcome.value.sql, 'string');
        },
        valid: { userId: identity.ownerId }
      },
      {
        name: 'projectKnowledgeVisibility',
        keys: ['legacyVisibility', 'isPublic'],
        invoke: (options) => projectKnowledgeVisibility(options),
        coerciveOptions: (value) => ({
          legacyVisibility: null,
          isPublic: value
        }),
        assertInvalid: (outcome) => expectTypeError(
          outcome,
          /knowledge visibility options/
        ),
        assertNested: (outcome) => {
          assert.deepEqual(outcome, {
            kind: 'return',
            value: 'private'
          });
        },
        assertValid: (outcome) => {
          assert.deepEqual(outcome, {
            kind: 'return',
            value: 'team'
          });
        },
        valid: { legacyVisibility: null, isPublic: 1 },
        omittedAllowed: false
      },
      {
        name: 'resolveConversationCampaign',
        keys: ['conversationId', 'requestedCampaignId'],
        invoke: (options) => resolveConversationCampaign(db, options),
        coerciveOptions: (value) => ({
          conversationId: value,
          requestedCampaignId: null
        }),
        assertInvalid: (outcome) => expectCode(
          outcome,
          'INVALID_CAMPAIGN_INPUT'
        ),
        assertNested: (outcome) => expectCode(
          outcome,
          'INVALID_CAMPAIGN_INPUT'
        ),
        assertValid: (outcome) => {
          assert.deepEqual(outcome, {
            kind: 'return',
            value: {
              ok: true,
              campaignId: null,
              derived: false
            }
          });
        },
        valid: {
          conversationId: 5401,
          requestedCampaignId: null
        }
      },
      {
        name: 'listCrmDependencies',
        keys: ['targetType', 'targetId'],
        invoke: (options) => listCrmDependencies(db, options),
        coerciveOptions: (value) => ({
          targetType: 'customer',
          targetId: value
        }),
        assertInvalid: (outcome) => expectTypeError(
          outcome,
          /CRM dependency target id is invalid/
        ),
        assertNested: (outcome) => expectTypeError(
          outcome,
          /CRM dependency target id is invalid/
        ),
        assertValid: (outcome) => {
          assert.equal(outcome.kind, 'return');
          assert.deepEqual(
            outcome.value.map((dependency) => dependency.type),
            ['campaigns', 'opportunities']
          );
        },
        valid: { targetType: 'customer', targetId: 1001 }
      },
      {
        name: 'runIdentityProjectionTransaction',
        keys: [
          'actorUserId',
          'subjectUserId',
          'reason',
          'requestId',
          'mutateUser'
        ],
        invoke: (options) => runIdentityProjectionTransaction(db, options),
        coerciveOptions: (value) => ({
          actorUserId: identity.adminId,
          subjectUserId: value,
          reason: 'admin_update',
          requestId: 'option-boundary-coercion',
          mutateUser() {}
        }),
        assertInvalid: (outcome) => expectTypeError(
          outcome,
          /subjectUserId must be a positive canonical safe integer/
        ),
        assertNested: (outcome) => expectTypeError(
          outcome,
          /subjectUserId must be a positive canonical safe integer/
        ),
        assertValid: (outcome) => {
          assert.equal(outcome.kind, 'return');
          assert.equal(outcome.value.changed, false);
        },
        valid: {
          actorUserId: identity.adminId,
          subjectUserId: identity.teammateId,
          reason: 'admin_update',
          requestId: 'option-boundary-valid',
          mutateUser() {}
        }
      },
      {
        name: 'resolveOrganizationScope',
        keys: ['userId', 'repairMissing', 'actorUserId', 'requestId'],
        invoke: (options) => resolveOrganizationScope(db, options),
        coerciveOptions: (value) => ({
          userId: value,
          repairMissing: false
        }),
        assertInvalid: (outcome) => expectTypeError(
          outcome,
          /userId must be a positive canonical safe integer/
        ),
        assertNested: (outcome) => expectTypeError(
          outcome,
          /userId must be a positive canonical safe integer/
        ),
        assertValid: (outcome) => {
          assert.equal(outcome.kind, 'return');
          assert.equal(outcome.value.ok, true);
        },
        valid: {
          userId: identity.ownerId,
          repairMissing: false
        }
      },
      {
        name: 'getAssignmentDecision',
        keys: [
          'actorUserId',
          'ownerUserId',
          'teamId',
          'currentOwnerUserId',
          'mode'
        ],
        invoke: (options) => getAssignmentDecision(db, options),
        coerciveOptions: (value) => ({
          actorUserId: value,
          ownerUserId: identity.ownerId,
          teamId: identity.ownerTeamId,
          mode: 'create'
        }),
        assertInvalid: expectAssignmentFailure,
        assertNested: expectAssignmentFailure,
        assertValid: (outcome) => {
          assert.equal(outcome.kind, 'return');
          assert.equal(outcome.value.allowed, true);
        },
        valid: {
          actorUserId: identity.adminId,
          ownerUserId: identity.ownerId,
          teamId: identity.ownerTeamId,
          mode: 'create'
        }
      },
      {
        name: 'getCampaignCreationDecision',
        keys: [
          'actorUserId',
          'opportunityId',
          'ownerUserId',
          'teamId',
          'currentOwnerUserId'
        ],
        invoke: (options) => getCampaignCreationDecision(db, options),
        coerciveOptions: (value) => ({
          actorUserId: value,
          opportunityId: 2001,
          ownerUserId: identity.ownerId,
          teamId: identity.ownerTeamId
        }),
        assertInvalid: expectAssignmentFailure,
        assertNested: expectAssignmentFailure,
        assertValid: (outcome) => {
          assert.equal(outcome.kind, 'return');
          assert.equal(outcome.value.allowed, true);
          assert.equal(outcome.value.opportunityId, 2001);
        },
        valid: {
          actorUserId: identity.adminId,
          opportunityId: 2001,
          ownerUserId: identity.ownerId,
          teamId: identity.ownerTeamId
        }
      }
    ];

    assert.deepEqual(definitions.map((definition) => definition.name), [
      'getCampaignAccess',
      'resolveRecordCustody',
      'getTargetAccess',
      'buildCollectionAccessPredicate',
      'projectKnowledgeVisibility',
      'resolveConversationCampaign',
      'listCrmDependencies',
      'runIdentityProjectionTransaction',
      'resolveOrganizationScope',
      'getAssignmentDecision',
      'getCampaignCreationDecision'
    ]);

    const rows = [];
    for (const definition of definitions) {
      const proxy = trackedProxy();
      const functionOptions = getterContainer(definition.keys, true);
      const accessorOptions = getterContainer(definition.keys, false);
      const arrayOptions = arrayContainer(definition.keys);
      const inheritedOptions = inheritedContainer(definition.keys);
      const coercive = coerciveValue();
      const outcomes = {
        proxy: capture(() => definition.invoke(proxy.value)),
        revoked: capture(() => definition.invoke(revokedProxy())),
        function: capture(() => definition.invoke(functionOptions.value)),
        accessor: capture(() => definition.invoke(accessorOptions.value)),
        array: capture(() => definition.invoke(arrayOptions.value)),
        inherited: capture(() => definition.invoke(inheritedOptions.value)),
        nested: capture(() => definition.invoke(
          definition.coerciveOptions(coercive.value)
        ))
      };
      rows.push({
        api: definition.name,
        proxyTraps: proxy.traps(),
        functionGetters: functionOptions.getters(),
        accessorGetters: accessorOptions.getters(),
        arrayGetters: arrayOptions.getters(),
        inheritedGetters: inheritedOptions.getters(),
        nestedCoercions: coercive.coercions(),
        revokedNativeError: (
          outcomes.revoked.kind === 'throw' &&
          /revoked/i.test(outcomes.revoked.message)
        )
      });
      for (
        const kind of [
          'proxy',
          'revoked',
          'function',
          'accessor',
          'array',
          'inherited'
        ]
      ) {
        definition.assertInvalid(outcomes[kind]);
      }
      for (const primitive of [1, 'options', true, 1n, Symbol('options')]) {
        definition.assertInvalid(capture(() => definition.invoke(primitive)));
      }
      definition.assertNested(outcomes.nested);
      definition.assertValid(capture(() => definition.invoke(definition.valid)));
      const omittedOutcomes = [
        capture(() => definition.invoke(undefined)),
        capture(() => definition.invoke(null))
      ];
      for (const outcome of omittedOutcomes) {
        definition.assertInvalid(outcome);
      }
    }

    assert.deepEqual(rows, definitions.map((definition) => ({
      api: definition.name,
      proxyTraps: 0,
      functionGetters: 0,
      accessorGetters: 0,
      arrayGetters: 0,
      inheritedGetters: 0,
      nestedCoercions: 0,
      revokedNativeError: false
    })));
  });
});

describe('RED group 10: organization identity lifecycle hardening', () => {
  test('explicit revocations and global lifecycle transitions stay reason-aware', (t) => {
    const db = openCampaignDatabase(t);
    const revokedUserId = 10;
    const lifecycleUserId = 11;
    const revokedAt = '2026-07-20 00:00:00';

    db.prepare(`
      UPDATE team_memberships
      SET status='revoked',revoked_at=?
      WHERE org_id=1 AND user_id=?
    `).run(revokedAt, revokedUserId);
    db.prepare(`
      UPDATE organization_memberships
      SET status='revoked',revoked_at=?
      WHERE org_id=1 AND user_id=?
    `).run(revokedAt, revokedUserId);
    insertSession(db, revokedUserId, 'explicit-revocation');
    const revokedBefore = {
      organization: db.prepare(`
        SELECT role_code,status,revoked_at
        FROM organization_memberships
        WHERE org_id=1 AND user_id=?
      `).get(revokedUserId),
      teams: db.prepare(`
        SELECT team_id,role_code,status,revoked_at
        FROM team_memberships
        WHERE org_id=1 AND user_id=?
        ORDER BY team_id
      `).all(revokedUserId),
      auditCount: db.prepare(`
        SELECT COUNT(*) AS count
        FROM activity_log
        WHERE module='identity'
          AND json_extract(details,'$.subject_user_id')=?
      `).get(revokedUserId).count
    };

    const noOp = runIdentityProjectionTransaction(db, {
      actorUserId: 1,
      subjectUserId: revokedUserId,
      reason: 'admin_update',
      requestId: 'request-preserve-explicit-revocation',
      mutateUser() {}
    });
    assert.equal(noOp.changed, false);
    assert.deepEqual(
      db.prepare(`
        SELECT role_code,status,revoked_at
        FROM organization_memberships
        WHERE org_id=1 AND user_id=?
      `).get(revokedUserId),
      revokedBefore.organization
    );
    assert.deepEqual(
      db.prepare(`
        SELECT team_id,role_code,status,revoked_at
        FROM team_memberships
        WHERE org_id=1 AND user_id=?
        ORDER BY team_id
      `).all(revokedUserId),
      revokedBefore.teams
    );
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM activity_log
        WHERE module='identity'
          AND json_extract(details,'$.subject_user_id')=?
      `).get(revokedUserId).count,
      revokedBefore.auditCount
    );
    assert.equal(
      db.prepare(
        'SELECT COUNT(*) AS count FROM sessions WHERE user_id=?'
      ).get(revokedUserId).count,
      1
    );

    const currentTeamId = db.prepare(`
      SELECT membership.team_id
      FROM team_memberships membership
      JOIN teams team
        ON team.org_id=membership.org_id
       AND team.id=membership.team_id
      JOIN users subject ON subject.id=membership.user_id
      WHERE membership.org_id=1
        AND membership.user_id=?
        AND membership.status='active'
        AND team.name=subject.department
      ORDER BY membership.team_id
      LIMIT 1
    `).get(lifecycleUserId).team_id;
    const extraDefaultTeamId = 9101;
    const otherOrgId = 9102;
    const otherOrgTeamId = 9103;
    db.prepare(`
      INSERT INTO teams (id,org_id,code,name)
      VALUES (?,1,'identity-extra-default','Identity extra default')
    `).run(extraDefaultTeamId);
    db.prepare(`
      INSERT INTO team_memberships (
        org_id,team_id,user_id,role_code,status,revoked_at
      ) VALUES (1,?,?,'member','active',NULL)
    `).run(extraDefaultTeamId, lifecycleUserId);
    db.prepare(`
      INSERT INTO organizations (id,code,name)
      VALUES (?,'identity-other-org','Identity other organization')
    `).run(otherOrgId);
    db.prepare(`
      INSERT INTO teams (id,org_id,code,name)
      VALUES (?,?,'identity-other-team','Identity other team')
    `).run(otherOrgTeamId, otherOrgId);
    db.prepare(`
      INSERT INTO organization_memberships (
        org_id,user_id,role_code,status,revoked_at
      ) VALUES (?,?,'member','active',NULL)
    `).run(otherOrgId, lifecycleUserId);
    db.prepare(`
      INSERT INTO team_memberships (
        org_id,team_id,user_id,role_code,status,revoked_at
      ) VALUES (?,?,?,'member','active',NULL)
    `).run(otherOrgId, otherOrgTeamId, lifecycleUserId);

    const promoted = runIdentityProjectionTransaction(db, {
      actorUserId: 1,
      subjectUserId: lifecycleUserId,
      reason: 'admin_update',
      requestId: 'request-default-only-role-projection',
      mutateUser() {
        db.prepare("UPDATE users SET role='admin' WHERE id=?")
          .run(lifecycleUserId);
      }
    });
    assert.equal(promoted.after.user.platform_role, 'platform_admin');
    assert.deepEqual(
      db.prepare(`
        SELECT org_id,role_code
        FROM organization_memberships
        WHERE user_id=?
        ORDER BY org_id
      `).all(lifecycleUserId),
      [
        { org_id: 1, role_code: 'org_admin' },
        { org_id: otherOrgId, role_code: 'member' }
      ]
    );
    assert.deepEqual(
      db.prepare(`
        SELECT org_id,team_id,role_code
        FROM team_memberships
        WHERE user_id=? AND org_id=?
      `).get(lifecycleUserId, otherOrgId),
      {
        org_id: otherOrgId,
        team_id: otherOrgTeamId,
        role_code: 'member'
      }
    );
    insertSession(db, lifecycleUserId, 'global-deactivate');

    const deactivated = runIdentityProjectionTransaction(db, {
      actorUserId: 1,
      subjectUserId: lifecycleUserId,
      reason: 'soft_deactivate',
      requestId: 'request-global-soft-deactivate',
      mutateUser() {
        db.prepare('UPDATE users SET is_active=0 WHERE id=?')
          .run(lifecycleUserId);
      }
    });
    assert.equal(deactivated.changed, true);
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM organization_memberships
        WHERE user_id=? AND status<>'revoked'
      `).get(lifecycleUserId).count,
      0
    );
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM team_memberships
        WHERE user_id=? AND status<>'revoked'
      `).get(lifecycleUserId).count,
      0
    );
    assert.deepEqual(
      db.prepare(`
        SELECT role_code
        FROM organization_memberships
        WHERE org_id=? AND user_id=?
      `).get(otherOrgId, lifecycleUserId),
      { role_code: 'member' }
    );
    assert.deepEqual(
      db.prepare(`
        SELECT role_code
        FROM team_memberships
        WHERE org_id=? AND team_id=? AND user_id=?
      `).get(otherOrgId, otherOrgTeamId, lifecycleUserId),
      { role_code: 'member' }
    );
    assert.equal(
      db.prepare(
        'SELECT COUNT(*) AS count FROM sessions WHERE user_id=?'
      ).get(lifecycleUserId).count,
      0
    );

    const reactivated = runIdentityProjectionTransaction(db, {
      actorUserId: 1,
      subjectUserId: lifecycleUserId,
      reason: 'reactivate',
      requestId: 'request-deterministic-reactivate',
      mutateUser() {
        db.prepare('UPDATE users SET is_active=1 WHERE id=?')
          .run(lifecycleUserId);
      }
    });
    assert.equal(reactivated.changed, true);
    assert.deepEqual(
      db.prepare(`
        SELECT org_id,status
        FROM organization_memberships
        WHERE user_id=?
        ORDER BY org_id
      `).all(lifecycleUserId),
      [
        { org_id: 1, status: 'active' },
        { org_id: otherOrgId, status: 'revoked' }
      ]
    );
    assert.deepEqual(
      db.prepare(`
        SELECT org_id,team_id,status
        FROM team_memberships
        WHERE user_id=?
        ORDER BY org_id,team_id
      `).all(lifecycleUserId),
      [
        { org_id: 1, team_id: currentTeamId, status: 'active' },
        { org_id: 1, team_id: extraDefaultTeamId, status: 'revoked' },
        { org_id: otherOrgId, team_id: otherOrgTeamId, status: 'revoked' }
      ]
    );
    assert.deepEqual(
      db.prepare(`
        SELECT organization_membership.role_code AS organization_role,
          team_membership.role_code AS team_role
        FROM organization_memberships organization_membership
        JOIN team_memberships team_membership
          ON team_membership.org_id=organization_membership.org_id
         AND team_membership.user_id=organization_membership.user_id
        WHERE organization_membership.org_id=?
          AND organization_membership.user_id=?
      `).get(otherOrgId, lifecycleUserId),
      {
        organization_role: 'member',
        team_role: 'member'
      }
    );

    db.prepare(`
      UPDATE team_memberships
      SET status='revoked',revoked_at=?
      WHERE org_id=1 AND user_id=? AND status='active'
    `).run(revokedAt, lifecycleUserId);
    db.prepare(`
      UPDATE organization_memberships
      SET status='revoked',revoked_at=?
      WHERE org_id=1 AND user_id=?
    `).run(revokedAt, lifecycleUserId);
    insertSession(db, lifecycleUserId, 'bogus-reactivate');
    const bogusAuditCount = db.prepare(`
      SELECT COUNT(*) AS count
      FROM activity_log
      WHERE module='identity'
        AND json_extract(details,'$.subject_user_id')=?
    `).get(lifecycleUserId).count;
    const bogus = runIdentityProjectionTransaction(db, {
      actorUserId: 1,
      subjectUserId: lifecycleUserId,
      reason: 'reactivate',
      requestId: 'request-bogus-reactivate',
      mutateUser() {}
    });
    assert.equal(bogus.changed, false);
    assert.equal(
      db.prepare(`
        SELECT status
        FROM organization_memberships
        WHERE org_id=1 AND user_id=?
      `).get(lifecycleUserId).status,
      'revoked'
    );
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM team_memberships
        WHERE user_id=? AND status='active'
      `).get(lifecycleUserId).count,
      0
    );
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM activity_log
        WHERE module='identity'
          AND json_extract(details,'$.subject_user_id')=?
      `).get(lifecycleUserId).count,
      bogusAuditCount
    );
    assert.equal(
      db.prepare(
        'SELECT COUNT(*) AS count FROM sessions WHERE user_id=?'
      ).get(lifecycleUserId).count,
      1
    );
  });

  test('identity mutators are synchronous undefined-returning transaction callbacks', async (t) => {
    const db = openCampaignDatabase(t);
    const snapshot = (userId) => ({
      user: db.prepare(`
        SELECT role,display_name,is_active
        FROM users
        WHERE id=?
      `).get(userId),
      organizations: db.prepare(`
        SELECT org_id,role_code,status,revoked_at
        FROM organization_memberships
        WHERE user_id=?
        ORDER BY org_id
      `).all(userId),
      teams: db.prepare(`
        SELECT org_id,team_id,role_code,status,revoked_at
        FROM team_memberships
        WHERE user_id=?
        ORDER BY org_id,team_id
      `).all(userId),
      sessions: db.prepare(`
        SELECT token
        FROM sessions
        WHERE user_id=?
        ORDER BY id
      `).all(userId),
      activity: db.prepare(`
        SELECT user_id,action,module,details
        FROM activity_log
        ORDER BY id
      `).all()
    });

    let asyncInvocations = 0;
    let lateWrites = 0;
    const asyncBefore = snapshot(11);
    let asyncError = null;
    try {
      runIdentityProjectionTransaction(db, {
        actorUserId: 1,
        subjectUserId: 11,
        reason: 'admin_update',
        requestId: 'request-reject-async-mutator',
        async mutateUser() {
          asyncInvocations += 1;
          await Promise.resolve();
          db.prepare(`
            UPDATE users
            SET display_name='escaped async mutation'
            WHERE id=11
          `).run();
          lateWrites += 1;
        }
      });
    } catch (error) {
      asyncError = error;
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(asyncError && asyncError.name, 'TypeError');
    assert.match(
      asyncError && asyncError.message,
      /mutateUser must be synchronous/
    );
    assert.equal(asyncInvocations, 0);
    assert.equal(lateWrites, 0);
    assert.deepEqual(snapshot(11), asyncBefore);

    let boundInvocations = 0;
    let boundLateWrites = 0;
    async function boundAsyncTarget() {
      boundInvocations += 1;
      await Promise.resolve();
      db.prepare(`
        UPDATE users
        SET display_name='escaped bound async mutation'
        WHERE id=10
      `).run();
      boundLateWrites += 1;
    }
    const boundAsyncMutator = boundAsyncTarget.bind(null);
    const boundBefore = snapshot(10);
    let boundError = null;
    try {
      runIdentityProjectionTransaction(db, {
        actorUserId: 1,
        subjectUserId: 10,
        reason: 'admin_update',
        requestId: 'request-reject-bound-async-mutator',
        mutateUser: boundAsyncMutator
      });
    } catch (error) {
      boundError = error;
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(boundError && boundError.name, 'TypeError');
    assert.equal(
      boundError && boundError.message,
      'mutateUser must be synchronous'
    );
    assert.equal(boundInvocations, 0);
    assert.equal(boundLateWrites, 0);
    assert.deepEqual(snapshot(10), boundBefore);

    for (const opaqueMutator of [
      function boundOrdinaryTarget() {}.bind(null),
      Math.max
    ]) {
      assert.throws(
        () => runIdentityProjectionTransaction(db, {
          actorUserId: 1,
          subjectUserId: 11,
          reason: 'admin_update',
          requestId: 'request-reject-opaque-mutator',
          mutateUser: opaqueMutator
        }),
        {
          name: 'TypeError',
          message: 'mutateUser must be synchronous'
        }
      );
    }

    let ordinaryInvocations = 0;
    let callableGetterCalls = 0;
    function declaredMutator() {
      ordinaryInvocations += 1;
    }
    Object.defineProperty(declaredMutator, 'diagnostic', {
      configurable: true,
      get() {
        callableGetterCalls += 1;
        return 'not-read';
      }
    });
    const methodHolder = {
      methodMutator() {
        ordinaryInvocations += 1;
      }
    };
    const arrowMutator = () => {
      ordinaryInvocations += 1;
    };
    for (const ordinaryMutator of [
      declaredMutator,
      methodHolder.methodMutator,
      arrowMutator
    ]) {
      assert.equal(runIdentityProjectionTransaction(db, {
        actorUserId: 1,
        subjectUserId: 11,
        reason: 'admin_update',
        requestId: 'request-allow-ordinary-mutator',
        mutateUser: ordinaryMutator
      }).changed, false);
    }
    assert.equal(ordinaryInvocations, 3);
    assert.equal(callableGetterCalls, 0);

    let thenGetterCalls = 0;
    const thenable = {};
    Object.defineProperty(thenable, 'then', {
      configurable: true,
      enumerable: true,
      get() {
        thenGetterCalls += 1;
        return () => {};
      }
    });
    const returnCases = [
      { userId: 9, label: 'scalar', returned: true },
      {
        userId: 10,
        label: 'promise',
        returned: Promise.resolve('not-allowed')
      },
      { userId: 11, label: 'thenable', returned: thenable }
    ];
    for (const definition of returnCases) {
      insertSession(db, definition.userId, 'return-' + definition.label);
      const before = snapshot(definition.userId);
      let invocations = 0;
      assert.throws(
        () => runIdentityProjectionTransaction(db, {
          actorUserId: 1,
          subjectUserId: definition.userId,
          reason: 'admin_update',
          requestId: 'request-reject-return-' + definition.label,
          mutateUser() {
            invocations += 1;
            const role = db.prepare(
              'SELECT role FROM users WHERE id=?'
            ).get(definition.userId).role;
            db.prepare('UPDATE users SET role=? WHERE id=?').run(
              role === 'admin' ? 'user' : 'admin',
              definition.userId
            );
            return definition.returned;
          }
        }),
        {
          name: 'TypeError',
          message: 'mutateUser must return undefined'
        }
      );
      assert.equal(invocations, 1);
      assert.deepEqual(snapshot(definition.userId), before);
    }
    assert.equal(thenGetterCalls, 0);
  });

  test('large legal team state deactivates with a bounded canonical identity audit', (t) => {
    const db = openCampaignDatabase(t);
    const userId = 11;
    const firstTeamId = 12000;
    const additionalTeamCount = 105;
    const insertTeam = db.prepare(`
      INSERT INTO teams (id,org_id,code,name)
      VALUES (?,1,?,?)
    `);
    const insertMembership = db.prepare(`
      INSERT INTO team_memberships (
        org_id,team_id,user_id,role_code,status,revoked_at
      ) VALUES (1,?,?,'member','active',NULL)
    `);
    db.transaction(() => {
      for (let index = 0; index < additionalTeamCount; index += 1) {
        const teamId = firstTeamId + index;
        insertTeam.run(
          teamId,
          'large-audit-team-' + String(index).padStart(3, '0'),
          'Large audit team ' + String(index).padStart(3, '0')
        );
        insertMembership.run(teamId, userId);
      }
    })();
    insertSession(db, userId, 'large-audit');

    const snapshot = () => ({
      user: db.prepare(`
        SELECT role,is_active
        FROM users
        WHERE id=?
      `).get(userId),
      organizations: db.prepare(`
        SELECT org_id,role_code,status,revoked_at
        FROM organization_memberships
        WHERE user_id=?
        ORDER BY org_id
      `).all(userId),
      teams: db.prepare(`
        SELECT org_id,team_id,role_code,status,revoked_at
        FROM team_memberships
        WHERE user_id=?
        ORDER BY org_id,team_id
      `).all(userId),
      sessions: db.prepare(`
        SELECT token
        FROM sessions
        WHERE user_id=?
        ORDER BY id
      `).all(userId),
      activity: db.prepare(`
        SELECT user_id,action,module,details
        FROM activity_log
        ORDER BY id
      `).all()
    });
    const beforeRollback = snapshot();
    assert.ok(beforeRollback.teams.length >= 106);
    assert.throws(
      () => runIdentityProjectionTransaction(db, {
        actorUserId: 999999,
        subjectUserId: userId,
        reason: 'soft_deactivate',
        requestId: 'request-large-audit-rollback',
        mutateUser() {
          db.prepare('UPDATE users SET is_active=0 WHERE id=?').run(userId);
        }
      }),
      /FOREIGN KEY constraint failed/
    );
    assert.deepEqual(snapshot(), beforeRollback);

    const auditCountBefore = db.prepare(`
      SELECT COUNT(*) AS count
      FROM activity_log
      WHERE module='identity'
        AND json_extract(details,'$.subject_user_id')=?
    `).get(userId).count;
    const result = runIdentityProjectionTransaction(db, {
      actorUserId: 1,
      subjectUserId: userId,
      reason: 'soft_deactivate',
      requestId: 'request-large-audit-success',
      mutateUser() {
        db.prepare('UPDATE users SET is_active=0 WHERE id=?').run(userId);
      }
    });
    assert.equal(result.changed, true);
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM organization_memberships
        WHERE user_id=? AND status<>'revoked'
      `).get(userId).count,
      0
    );
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM team_memberships
        WHERE user_id=? AND status<>'revoked'
      `).get(userId).count,
      0
    );
    assert.equal(
      db.prepare(
        'SELECT COUNT(*) AS count FROM sessions WHERE user_id=?'
      ).get(userId).count,
      0
    );

    const storedAudit = db.prepare(`
      SELECT details
      FROM activity_log
      WHERE module='identity'
        AND json_extract(details,'$.subject_user_id')=?
      ORDER BY id DESC
      LIMIT 1
    `).get(userId);
    assert.deepEqual(storedAudit, { details: result.audit.details });
    assert.ok(Buffer.byteLength(storedAudit.details, 'utf8') <= 4096);
    const audit = JSON.parse(storedAudit.details);
    assert.deepEqual(Object.keys(audit), [
      'schema_version',
      'actor_user_id',
      'subject_user_id',
      'organization_id',
      'reason',
      'request_id',
      'changed_fields',
      'before',
      'after'
    ]);
    assert.equal(audit.reason, 'soft_deactivate');
    for (const [projection, exact] of [
      [audit.before, result.before],
      [audit.after, result.after]
    ]) {
      assert.deepEqual(
        Object.keys(projection),
        ['user', 'organization_membership', 'team_memberships']
      );
      assert.deepEqual(projection.user, exact.user);
      assert.deepEqual(
        projection.organization_membership,
        exact.organization_membership
      );
      assert.deepEqual(projection.team_memberships, {
        summary_version: 1,
        total_count: exact.team_memberships.length,
        active_count: exact.team_memberships.filter(
          (membership) => membership.status === 'active'
        ).length,
        revoked_count: exact.team_memberships.filter(
          (membership) => membership.status === 'revoked'
        ).length,
        sha256: sha256(JSON.stringify(exact.team_memberships))
      });
    }
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM activity_log
        WHERE module='identity'
          AND json_extract(details,'$.subject_user_id')=?
      `).get(userId).count,
      auditCountBefore + 1
    );
  });

  test('repairMissing accepts only primitive booleans without coercion or mutation', (t) => {
    const db = openCampaignDatabase(t);
    const userId = 11;
    db.prepare(
      'DELETE FROM team_memberships WHERE org_id=1 AND user_id=?'
    ).run(userId);
    db.prepare(
      'DELETE FROM organization_memberships WHERE org_id=1 AND user_id=?'
    ).run(userId);
    insertSession(db, userId, 'strict-repair-flag');

    const snapshot = () => ({
      user: db.prepare(`
        SELECT role,department,is_active
        FROM users
        WHERE id=?
      `).get(userId),
      organizations: db.prepare(`
        SELECT org_id,role_code,status,revoked_at
        FROM organization_memberships
        WHERE user_id=?
        ORDER BY org_id
      `).all(userId),
      teams: db.prepare(`
        SELECT org_id,team_id,role_code,status,revoked_at
        FROM team_memberships
        WHERE user_id=?
        ORDER BY org_id,team_id
      `).all(userId),
      sessions: db.prepare(`
        SELECT token
        FROM sessions
        WHERE user_id=?
        ORDER BY id
      `).all(userId),
      activity: db.prepare(`
        SELECT user_id,action,module,details
        FROM activity_log
        ORDER BY id
      `).all()
    });
    const missing = {
      ok: false,
      kind: 'missing_membership',
      code: 'ORGANIZATION_MEMBERSHIP_MISSING'
    };
    const before = snapshot();
    assert.deepEqual(resolveOrganizationScope(db, { userId }), missing);
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(resolveOrganizationScope(db, {
      userId,
      repairMissing: false
    }), missing);
    assert.deepEqual(snapshot(), before);

    let coercions = 0;
    const coercive = {
      [Symbol.toPrimitive]() {
        coercions += 1;
        return true;
      },
      valueOf() {
        coercions += 1;
        return true;
      },
      toString() {
        coercions += 1;
        return 'true';
      }
    };
    const malformed = [
      'false',
      'true',
      '',
      0,
      1,
      null,
      1n,
      Symbol('true'),
      {},
      [],
      new Boolean(true),
      function repairFlag() {},
      coercive
    ];
    for (const value of malformed) {
      assert.throws(
        () => resolveOrganizationScope(db, {
          userId,
          repairMissing: value,
          actorUserId: userId,
          requestId: 'request-strict-repair-flag'
        }),
        {
          name: 'TypeError',
          message: 'repairMissing must be a boolean'
        }
      );
      assert.deepEqual(snapshot(), before);
    }
    assert.equal(coercions, 0);

    const repaired = resolveOrganizationScope(db, {
      userId,
      repairMissing: true,
      actorUserId: userId,
      requestId: 'request-strict-repair-true'
    });
    assert.equal(repaired.ok, true);
    assert.equal(repaired.repaired, true);
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM organization_memberships
        WHERE org_id=1 AND user_id=? AND status='active'
      `).get(userId).count,
      1
    );
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM team_memberships
        WHERE org_id=1 AND user_id=? AND status='active'
      `).get(userId).count,
      1
    );
    assert.equal(
      db.prepare(
        'SELECT COUNT(*) AS count FROM sessions WHERE user_id=?'
      ).get(userId).count,
      0
    );
  });

  test('repair and department changes never resurrect explicitly revoked teams', (t) => {
    const db = openCampaignDatabase(t);
    const revokedAt = '2026-07-20 00:00:00';

    const repairUserId = 11;
    const repairTeamId = db.prepare(`
      SELECT team_id
      FROM team_memberships
      WHERE org_id=1 AND user_id=? AND status='active'
      ORDER BY team_id
      LIMIT 1
    `).get(repairUserId).team_id;
    db.prepare(`
      UPDATE team_memberships
      SET status='revoked',revoked_at=?
      WHERE org_id=1 AND team_id=? AND user_id=?
    `).run(revokedAt, repairTeamId, repairUserId);
    let repairResult;
    db.transaction(() => {
      db.pragma('defer_foreign_keys = ON');
      db.prepare(`
        DELETE FROM organization_memberships
        WHERE org_id=1 AND user_id=?
      `).run(repairUserId);
      repairResult = resolveOrganizationScope(db, {
        userId: repairUserId,
        repairMissing: true,
        actorUserId: repairUserId,
        requestId: 'request-preserve-revoked-repair-team'
      });
      assert.deepEqual(
        db.prepare(`
          SELECT status,revoked_at
          FROM team_memberships
          WHERE org_id=1 AND team_id=? AND user_id=?
        `).get(repairTeamId, repairUserId),
        { status: 'revoked', revoked_at: revokedAt }
      );
    })();
    assert.deepEqual(repairResult, {
      ok: false,
      kind: 'inactive_membership',
      code: 'ORGANIZATION_MEMBERSHIP_INACTIVE'
    });
    assert.equal(
      db.prepare(`
        SELECT status
        FROM organization_memberships
        WHERE org_id=1 AND user_id=?
      `).get(repairUserId).status,
      'active'
    );
    assert.equal(
      db.prepare(`
        SELECT status
        FROM team_memberships
        WHERE org_id=1 AND team_id=? AND user_id=?
      `).get(repairTeamId, repairUserId).status,
      'revoked'
    );

    const transferUserId = 10;
    const transferDestination = 'Explicitly Revoked Destination';
    const transferTeamId = 13001;
    db.prepare(`
      INSERT INTO teams (id,org_id,code,name)
      VALUES (?,1,?,?)
    `).run(
      transferTeamId,
      'legacy-dept-' + sha256(transferDestination),
      transferDestination
    );
    db.prepare(`
      INSERT INTO team_memberships (
        org_id,team_id,user_id,role_code,status,revoked_at
      ) VALUES (1,?,?,'member','revoked',?)
    `).run(transferTeamId, transferUserId, revokedAt);
    runIdentityProjectionTransaction(db, {
      actorUserId: 1,
      subjectUserId: transferUserId,
      reason: 'admin_update',
      requestId: 'request-preserve-revoked-transfer-team',
      mutateUser() {
        db.prepare('UPDATE users SET department=? WHERE id=?')
          .run(transferDestination, transferUserId);
      }
    });
    assert.deepEqual(
      db.prepare(`
        SELECT status,revoked_at
        FROM team_memberships
        WHERE org_id=1 AND team_id=? AND user_id=?
      `).get(transferTeamId, transferUserId),
      { status: 'revoked', revoked_at: revokedAt }
    );
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM team_memberships
        WHERE org_id=1 AND user_id=? AND status='active'
      `).get(transferUserId).count,
      0
    );

    const revokedOrgUserId = db.prepare(`
      SELECT id
      FROM users
      WHERE typeof(is_active)='integer'
        AND is_active=1
        AND role<>'admin'
        AND id NOT IN (?,?)
      ORDER BY id DESC
      LIMIT 1
    `).get(repairUserId, transferUserId).id;
    db.prepare(`
      UPDATE team_memberships
      SET status='revoked',revoked_at=?
      WHERE org_id=1 AND user_id=? AND status='active'
    `).run(revokedAt, revokedOrgUserId);
    db.prepare(`
      UPDATE organization_memberships
      SET status='revoked',revoked_at=?
      WHERE org_id=1 AND user_id=?
    `).run(revokedAt, revokedOrgUserId);
    const revokedOrgDestination = 'Revoked Organization Destination';
    const revokedOrgDestinationCode = (
      'legacy-dept-' + sha256(revokedOrgDestination)
    );
    runIdentityProjectionTransaction(db, {
      actorUserId: 1,
      subjectUserId: revokedOrgUserId,
      reason: 'admin_update',
      requestId: 'request-revoked-org-department-update',
      mutateUser() {
        db.prepare('UPDATE users SET department=? WHERE id=?')
          .run(revokedOrgDestination, revokedOrgUserId);
      }
    });
    assert.equal(
      db.prepare(`
        SELECT status
        FROM organization_memberships
        WHERE org_id=1 AND user_id=?
      `).get(revokedOrgUserId).status,
      'revoked'
    );
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM team_memberships
        WHERE org_id=1 AND user_id=? AND status='active'
      `).get(revokedOrgUserId).count,
      0
    );
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM teams
        WHERE org_id=1 AND code=?
      `).get(revokedOrgDestinationCode).count,
      0
    );
  });

  test('every final inactive identity globally revokes memberships regardless of reason', (t) => {
    const db = openCampaignDatabase(t);
    const fixedRevokedAt = '2026-07-20 00:00:00';
    const insertOrganizationState = ({
      userId,
      orgId,
      teamId,
      suffix,
      status,
      revokedAt
    }) => {
      db.prepare(`
        INSERT INTO organizations (id,code,name)
        VALUES (?,?,?)
      `).run(
        orgId,
        'inactive-invariant-org-' + suffix,
        'Inactive invariant organization ' + suffix
      );
      db.prepare(`
        INSERT INTO teams (id,org_id,code,name)
        VALUES (?,?,?,?)
      `).run(
        teamId,
        orgId,
        'inactive-invariant-team-' + suffix,
        'Inactive invariant team ' + suffix
      );
      db.prepare(`
        INSERT INTO organization_memberships (
          org_id,user_id,role_code,status,revoked_at
        ) VALUES (?,?, 'member',?,?)
      `).run(orgId, userId, status, revokedAt);
      db.prepare(`
        INSERT INTO team_memberships (
          org_id,team_id,user_id,role_code,status,revoked_at
        ) VALUES (?,?,?,'member',?,?)
      `).run(orgId, teamId, userId, status, revokedAt);
    };
    const snapshot = (userId) => ({
      user: db.prepare(`
        SELECT role,is_active
        FROM users
        WHERE id=?
      `).get(userId),
      organizations: db.prepare(`
        SELECT org_id,role_code,status,revoked_at
        FROM organization_memberships
        WHERE user_id=?
        ORDER BY org_id
      `).all(userId),
      teams: db.prepare(`
        SELECT org_id,team_id,role_code,status,revoked_at
        FROM team_memberships
        WHERE user_id=?
        ORDER BY org_id,team_id
      `).all(userId),
      sessions: db.prepare(`
        SELECT token
        FROM sessions
        WHERE user_id=?
        ORDER BY id
      `).all(userId),
      activity: db.prepare(`
        SELECT user_id,action,module,details
        FROM activity_log
        ORDER BY id
      `).all()
    });

    const transitionUserId = 11;
    insertOrganizationState({
      userId: transitionUserId,
      orgId: 16001,
      teamId: 16002,
      suffix: 'transition-active',
      status: 'active',
      revokedAt: null
    });
    insertOrganizationState({
      userId: transitionUserId,
      orgId: 16003,
      teamId: 16004,
      suffix: 'transition-revoked',
      status: 'revoked',
      revokedAt: fixedRevokedAt
    });
    insertSession(db, transitionUserId, 'admin-update-inactive');
    const transitionBeforeRollback = snapshot(transitionUserId);
    assert.throws(
      () => runIdentityProjectionTransaction(db, {
        actorUserId: 999999,
        subjectUserId: transitionUserId,
        reason: 'admin_update',
        requestId: 'request-admin-inactive-rollback',
        mutateUser() {
          db.prepare(`
            UPDATE users
            SET role='admin',is_active=0
            WHERE id=?
          `).run(transitionUserId);
        }
      }),
      /FOREIGN KEY constraint failed/
    );
    assert.deepEqual(snapshot(transitionUserId), transitionBeforeRollback);

    const transitionAuditBefore = db.prepare(`
      SELECT COUNT(*) AS count
      FROM activity_log
      WHERE module='identity'
        AND json_extract(details,'$.subject_user_id')=?
        AND json_extract(details,'$.reason')='admin_update'
    `).get(transitionUserId).count;
    const transitioned = runIdentityProjectionTransaction(db, {
      actorUserId: 1,
      subjectUserId: transitionUserId,
      reason: 'admin_update',
      requestId: 'request-admin-update-inactive',
      mutateUser() {
        db.prepare(`
          UPDATE users
          SET role='admin',is_active=0
          WHERE id=?
        `).run(transitionUserId);
      }
    });
    assert.equal(transitioned.changed, true);
    assert.equal(transitioned.after.user.is_active, 0);
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM organization_memberships
        WHERE user_id=? AND status<>'revoked'
      `).get(transitionUserId).count,
      0
    );
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM team_memberships
        WHERE user_id=? AND status<>'revoked'
      `).get(transitionUserId).count,
      0
    );
    assert.deepEqual(
      db.prepare(`
        SELECT role_code,status,revoked_at
        FROM organization_memberships
        WHERE org_id=16003 AND user_id=?
      `).get(transitionUserId),
      {
        role_code: 'member',
        status: 'revoked',
        revoked_at: fixedRevokedAt
      }
    );
    assert.deepEqual(
      db.prepare(`
        SELECT role_code,status,revoked_at
        FROM team_memberships
        WHERE org_id=16003 AND team_id=16004 AND user_id=?
      `).get(transitionUserId),
      {
        role_code: 'member',
        status: 'revoked',
        revoked_at: fixedRevokedAt
      }
    );
    assert.deepEqual(
      db.prepare(`
        SELECT role_code
        FROM organization_memberships
        WHERE org_id=16001 AND user_id=?
      `).get(transitionUserId),
      { role_code: 'member' }
    );
    assert.deepEqual(
      db.prepare(`
        SELECT role_code
        FROM team_memberships
        WHERE org_id=16001 AND team_id=16002 AND user_id=?
      `).get(transitionUserId),
      { role_code: 'member' }
    );
    assert.equal(
      db.prepare(
        'SELECT COUNT(*) AS count FROM sessions WHERE user_id=?'
      ).get(transitionUserId).count,
      0
    );
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM activity_log
        WHERE module='identity'
          AND json_extract(details,'$.subject_user_id')=?
          AND json_extract(details,'$.reason')='admin_update'
      `).get(transitionUserId).count,
      transitionAuditBefore + 1
    );

    const alreadyInactiveUserId = 9;
    db.prepare('UPDATE users SET is_active=0 WHERE id=?').run(alreadyInactiveUserId);
    db.prepare(`
      UPDATE organization_memberships
      SET status='active',revoked_at=NULL
      WHERE org_id=1 AND user_id=?
    `).run(alreadyInactiveUserId);
    db.prepare(`
      UPDATE team_memberships
      SET status='active',revoked_at=NULL
      WHERE org_id=1 AND user_id=?
    `).run(alreadyInactiveUserId);
    insertOrganizationState({
      userId: alreadyInactiveUserId,
      orgId: 16005,
      teamId: 16006,
      suffix: 'already-inactive-active',
      status: 'active',
      revokedAt: null
    });
    insertOrganizationState({
      userId: alreadyInactiveUserId,
      orgId: 16007,
      teamId: 16008,
      suffix: 'already-inactive-revoked',
      status: 'revoked',
      revokedAt: fixedRevokedAt
    });
    insertSession(db, alreadyInactiveUserId, 'already-inactive-repair');
    const inactiveAuditBefore = db.prepare(`
      SELECT COUNT(*) AS count
      FROM activity_log
      WHERE module='identity'
        AND json_extract(details,'$.subject_user_id')=?
        AND json_extract(details,'$.reason')='login_membership_repair'
    `).get(alreadyInactiveUserId).count;
    const normalized = runIdentityProjectionTransaction(db, {
      actorUserId: 1,
      subjectUserId: alreadyInactiveUserId,
      reason: 'login_membership_repair',
      requestId: 'request-normalize-inactive-repair',
      mutateUser() {}
    });
    assert.equal(normalized.changed, true);
    assert.equal(normalized.after.user.is_active, 0);
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM organization_memberships
        WHERE user_id=? AND status<>'revoked'
      `).get(alreadyInactiveUserId).count,
      0
    );
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM team_memberships
        WHERE user_id=? AND status<>'revoked'
      `).get(alreadyInactiveUserId).count,
      0
    );
    assert.deepEqual(
      db.prepare(`
        SELECT role_code,status,revoked_at
        FROM organization_memberships
        WHERE org_id=16007 AND user_id=?
      `).get(alreadyInactiveUserId),
      {
        role_code: 'member',
        status: 'revoked',
        revoked_at: fixedRevokedAt
      }
    );
    assert.deepEqual(
      db.prepare(`
        SELECT role_code,status,revoked_at
        FROM team_memberships
        WHERE org_id=16007 AND team_id=16008 AND user_id=?
      `).get(alreadyInactiveUserId),
      {
        role_code: 'member',
        status: 'revoked',
        revoked_at: fixedRevokedAt
      }
    );
    assert.equal(
      db.prepare(
        'SELECT COUNT(*) AS count FROM sessions WHERE user_id=?'
      ).get(alreadyInactiveUserId).count,
      0
    );
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM activity_log
        WHERE module='identity'
          AND json_extract(details,'$.subject_user_id')=?
          AND json_extract(details,'$.reason')='login_membership_repair'
      `).get(alreadyInactiveUserId).count,
      inactiveAuditBefore + 1
    );
  });
});

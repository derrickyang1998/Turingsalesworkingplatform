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
    assert.deepEqual(Object.keys(available), [
      'link_id',
      'relation_type',
      'record_type',
      'record_id',
      'access_state',
      'label',
      'created_at',
      'revoked_at'
    ]);
    assert.equal(available.access_state, 'available');
    assert.equal(JSON.stringify(available).includes('must-not-leak'), false);

    assert.deepEqual(serializeWorkspaceLink(link, {
      target: 'restricted',
      restrictedCount: 2
    }), {
      relation_type: 'proposal',
      access_state: 'restricted',
      restricted_count: 2
    });
    assert.deepEqual(serializeWorkspaceLink(link, {
      target: 'missing'
    }), {
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
    const inaccessible = new Proxy({}, {
      get() {
        throw new Error('inaccessible metadata was read');
      },
      getPrototypeOf() {
        throw new Error('inaccessible metadata prototype was read');
      },
      ownKeys() {
        throw new Error('inaccessible metadata keys were read');
      }
    });
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
    assert.deepEqual(Object.keys(full), [
      'citation_label',
      'entry_id',
      'chunk_id',
      'chunk_index',
      'title',
      'entry_type',
      'source',
      'visibility',
      'snippet',
      'selected',
      'rank',
      'source_identity_sha256',
      'entry_content_sha256',
      'chunk_content_sha256'
    ]);
    assert.deepEqual(full.source, {
      kind: 'upload',
      label: 'Uploaded knowledge'
    });
    assert.equal(full.visibility, 'team');
    assert.equal(JSON.stringify(full).includes('secret'), false);
    assert.deepEqual(serializeKnowledgeReference(reference, {
      target: 'restricted'
    }), {
      citation_label: 'KB-1',
      access_state: 'restricted'
    });
    assert.deepEqual(serializeKnowledgeReference(reference, {
      target: 'missing'
    }), {
      citation_label: 'KB-1',
      access_state: 'missing'
    });
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
    assert.equal(projectKnowledgeVisibility({
      legacyVisibility: null,
      isPublic: 0
    }), 'private');
    assert.deepEqual(projectKnowledgeSource('campaign_review'), {
      kind: 'review',
      label: 'Campaign review'
    });
    assert.deepEqual(projectKnowledgeSource('C:\\secret\\provider-cache'), {
      kind: 'other',
      label: 'Other knowledge'
    });
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

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const path = require('node:path');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const ai = require('../services/ai_service');
const llm = require('../services/llm_service');
const knowledge = require('../services/knowledge_service');

const SERVER_ROOT = path.resolve(__dirname, '..');
const MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 2,
    name: '002_campaign_business_spine',
    sourcePath: 'migrations/002_campaign_business_spine.js',
    engineVersion: 1,
    dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
  }),
  Object.freeze({
    version: 3,
    name: '003_campaign_workflow_dispatch_evidence',
    sourcePath: 'migrations/003_campaign_workflow_dispatch_evidence.js',
    engineVersion: 1,
    dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
  }),
  Object.freeze({
    version: 4,
    name: '004_knowledge_capacity_observability',
    sourcePath: 'migrations/004_knowledge_capacity_observability.js',
    engineVersion: 1,
    dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
  }),
  Object.freeze({
    version: 5,
    name: '005_knowledge_custody_projection',
    sourcePath: 'migrations/005_knowledge_custody_projection.js',
    engineVersion: 1,
    dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
  })
]);

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function openDatabase() {
  const db = new Database(':memory:');
  migrationService.runMigrations(db, {
    rootDir: SERVER_ROOT,
    registeredMigrations: MIGRATIONS
  });
  return db;
}

function user(db, userId) {
  const row = db.prepare('SELECT id,role FROM users WHERE id=?').get(userId);
  assert.ok(row, `fixture user ${userId} must exist`);
  return row;
}

function authContext(db, userId, organizationId = 1) {
  const organization = db.prepare(`
    SELECT organization.id,organization.code,organization.name,membership.role_code
    FROM organizations organization
    JOIN organization_memberships membership
      ON membership.org_id=organization.id AND membership.user_id=?
    WHERE organization.id=?
  `).get(userId, organizationId);
  assert.ok(organization, `fixture membership ${organizationId}:${userId} must exist`);
  return {
    organization,
    teams: db.prepare(`
      SELECT team.id,team.code,team.name,membership.role_code
      FROM team_memberships membership
      JOIN teams team
        ON team.org_id=membership.org_id AND team.id=membership.team_id
      WHERE membership.org_id=? AND membership.user_id=? AND membership.status='active'
      ORDER BY team.id
    `).all(organizationId, userId)
  };
}

function createCampaign(db, values) {
  db.prepare(`
    INSERT INTO campaigns (
      id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,
      lifecycle_state,operational_status,row_version
    ) VALUES (?,?,?,?,?,?,?,'lead','active',1)
  `).run(
    values.id,
    values.orgId,
    values.name,
    values.customerId,
    values.opportunityId,
    values.ownerUserId,
    values.teamId
  );
}

function createFixture(db) {
  const ownerTeamId = db.prepare(`
    SELECT team_id FROM team_memberships
    WHERE org_id=1 AND user_id=2 AND status='active'
  `).get().team_id;
  const otherTeamId = db.prepare(`
    SELECT team_id FROM team_memberships
    WHERE org_id=1 AND user_id=4 AND status='active'
  `).get().team_id;

  db.prepare(`
    UPDATE organization_memberships
    SET role_code='org_admin'
    WHERE org_id=1 AND user_id=11
  `).run();
  db.prepare(`
    UPDATE team_memberships
    SET role_code='team_lead'
    WHERE org_id=1 AND user_id=11
  `).run();

  db.prepare(`
    INSERT INTO customers (
      id,brand_name,company_name,stage,source,created_by,assigned_to,is_public
    ) VALUES (970001,'AI read fixture','AI read fixture Ltd','qualified','ai-read',2,2,0)
  `).run();
  db.prepare(`
    INSERT INTO opportunities (
      id,customer_id,name,stage,value,win_probability,product_name,channel_type,created_by
    ) VALUES (970101,970001,'AI read opportunity','proposal',1000,50,'AI read','influencer',2)
  `).run();

  createCampaign(db, {
    id: 971001,
    orgId: 1,
    name: 'Owner campaign',
    customerId: 970001,
    opportunityId: 970101,
    ownerUserId: 2,
    teamId: ownerTeamId
  });
  createCampaign(db, {
    id: 971002,
    orgId: 1,
    name: 'Other campaign',
    customerId: 970001,
    opportunityId: 970101,
    ownerUserId: 4,
    teamId: otherTeamId
  });

  db.prepare(`
    INSERT INTO organizations (id,code,name)
    VALUES (2,'ai-read-other-org','AI Read Other Org')
  `).run();
  db.prepare(`
    INSERT INTO organization_memberships (org_id,user_id,role_code,status)
    VALUES (2,4,'member','active')
  `).run();
  db.prepare(`
    INSERT INTO teams (id,org_id,code,name)
    VALUES (100,2,'ai-read-other-team','AI Read Other Team')
  `).run();
  db.prepare(`
    INSERT INTO team_memberships (org_id,team_id,user_id,role_code,status)
    VALUES (2,100,4,'member','active')
  `).run();
  createCampaign(db, {
    id: 971003,
    orgId: 2,
    name: 'Cross organization campaign',
    customerId: 970001,
    opportunityId: 970101,
    ownerUserId: 4,
    teamId: 100
  });

  return {
    owner: user(db, 2),
    teammate: user(db, 3),
    outsider: user(db, 4),
    orgAdmin: user(db, 11),
    platformAdmin: user(db, 1),
    ownerAuth: authContext(db, 2),
    teammateAuth: authContext(db, 3),
    outsiderAuth: authContext(db, 4),
    orgAdminAuth: authContext(db, 11),
    platformAdminAuth: authContext(db, 1),
    crossOrgOwnerAuth: authContext(db, 4, 2),
    ownerCampaignId: 971001,
    otherCampaignId: 971002,
    crossOrgCampaignId: 971003
  };
}

let conversationSequence = 0;

function createConversation(db, values = {}) {
  conversationSequence += 1;
  const createdAt = values.createdAt || '2026-07-01 00:00:00';
  const result = db.prepare(`
    INSERT INTO ai_conversations (
      user_id,title,visibility,source_module,created_at,updated_at
    ) VALUES (?,?,?,?,?,?)
  `).run(
    values.userId || 2,
    values.title || `Conversation ${conversationSequence}`,
    'private',
    values.sourceModule || 'assistant',
    createdAt,
    values.updatedAt || createdAt
  );
  const conversationId = Number(result.lastInsertRowid);
  if (values.message !== false) {
    db.prepare(`
      INSERT INTO ai_messages (
        conversation_id,user_id,role,content,model,prompt_tokens,
        completion_tokens,total_tokens,metadata_json,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(
      conversationId,
      values.userId || 2,
      values.role || 'assistant',
      values.content || `answer-${conversationSequence}`,
      values.model || 'fixture-model',
      values.promptTokens || 0,
      values.completionTokens || 0,
      values.totalTokens || 0,
      JSON.stringify(values.metadata || {}),
      createdAt
    );
  }
  return conversationId;
}

function addWebReference(db, conversationId, title = 'Tavily source needle') {
  const message = db.prepare(`
    SELECT id FROM ai_messages WHERE conversation_id=? ORDER BY id DESC LIMIT 1
  `).get(conversationId);
  db.prepare(`
    INSERT INTO ai_references (
      message_id,reference_type,reference_id,title,url,snippet,provider,metadata_json
    ) VALUES (?,'web',?,?,?,?,?,'{}')
  `).run(
    message.id,
    `audit-web-source-${conversationId}`,
    title,
    `https://example.com/evidence/${conversationId}`,
    'Evidence snippet',
    'tavily'
  );
}

function linkConversation(db, values) {
  const result = db.prepare(`
    INSERT INTO campaign_record_links (
      org_id,campaign_id,record_type,bundle_id,record_id,relation_type,
      created_by,metadata_json
    ) VALUES (?,?,'ai_conversation',?,?,'ai_run',?,'{}')
  `).run(
    values.orgId || 1,
    values.campaignId,
    sha256(`ai-read-link:${values.campaignId}:${values.conversationId}:${conversationSequence}`),
    String(values.conversationId),
    values.createdBy
  );
  return Number(result.lastInsertRowid);
}

function revokeLink(db, linkId, revokedBy, reason = 'AI read custody fixture') {
  db.prepare(`
    UPDATE campaign_record_links
    SET revoked_at='2026-07-20 00:00:00',revoked_by=?,revoke_reason=?
    WHERE id=?
  `).run(revokedBy, reason, linkId);
}

function moveConversation(db, values) {
  revokeLink(db, values.linkId, values.revokedBy, 'AI read custody moved');
  return linkConversation(db, {
    orgId: values.destinationOrgId || 1,
    campaignId: values.destinationCampaignId,
    conversationId: values.conversationId,
    createdBy: values.destinationCreatedBy
  });
}

function secureRead(actor, context, requestId, extra = {}) {
  return {
    user: actor,
    authContext: context,
    requestId,
    ...extra
  };
}

test('AI conversation reads enforce owner object access, bounded admins, and active/moved/revoke-only custody', () => {
  const db = openDatabase();
  try {
    const fixture = createFixture(db);
    const unlinked = createConversation(db, {
      title: 'Owner unlinked',
      updatedAt: '2026-07-01 00:00:01'
    });
    const active = createConversation(db, {
      title: 'Owner active custody',
      updatedAt: '2026-07-01 00:00:02'
    });
    linkConversation(db, {
      campaignId: fixture.ownerCampaignId,
      conversationId: active,
      createdBy: fixture.owner.id
    });
    const revokeOnly = createConversation(db, {
      title: 'Owner revoke-only custody',
      updatedAt: '2026-07-01 00:00:03'
    });
    const revokedLink = linkConversation(db, {
      campaignId: fixture.ownerCampaignId,
      conversationId: revokeOnly,
      createdBy: fixture.owner.id
    });
    revokeLink(db, revokedLink, fixture.owner.id);
    const moved = createConversation(db, {
      title: 'Owner moved custody',
      updatedAt: '2026-07-01 00:00:04'
    });
    const movedLink = linkConversation(db, {
      campaignId: fixture.ownerCampaignId,
      conversationId: moved,
      createdBy: fixture.owner.id
    });
    moveConversation(db, {
      linkId: movedLink,
      revokedBy: fixture.owner.id,
      destinationCampaignId: fixture.otherCampaignId,
      destinationCreatedBy: fixture.outsider.id,
      conversationId: moved
    });
    const crossOrg = createConversation(db, {
      userId: fixture.outsider.id,
      title: 'Cross organization custody',
      updatedAt: '2026-07-01 00:00:05'
    });
    linkConversation(db, {
      orgId: 2,
      campaignId: fixture.crossOrgCampaignId,
      conversationId: crossOrg,
      createdBy: fixture.outsider.id
    });

    const ownerRows = ai.listConversations(db, secureRead(
      fixture.owner,
      fixture.ownerAuth,
      'owner-list'
    ));
    assert.deepEqual(ownerRows.map((row) => row.id), [revokeOnly, active, unlinked]);
    assert.equal(ai.getConversation(db, secureRead(
      fixture.owner,
      fixture.ownerAuth,
      'owner-moved-detail',
      { id: moved }
    )), null);
    assert.equal(ai.getConversation(db, secureRead(
      fixture.owner,
      fixture.ownerAuth,
      'owner-revoked-detail',
      { id: revokeOnly }
    )).id, revokeOnly);

    const otherTeamId = db.prepare(`
      SELECT team_id FROM team_memberships
      WHERE org_id=1 AND user_id=? AND status='active'
    `).get(fixture.outsider.id).team_id;
    db.prepare(`
      UPDATE campaigns
      SET owner_user_id=?,team_id=?,row_version=row_version+1
      WHERE id=?
    `).run(fixture.outsider.id, otherTeamId, fixture.ownerCampaignId);
    assert.deepEqual(ai.listConversations(db, secureRead(
      fixture.owner,
      fixture.ownerAuth,
      'former-campaign-owner-list'
    )).map((row) => row.id), [unlinked]);
    assert.equal(ai.getConversation(db, secureRead(
      fixture.owner,
      fixture.ownerAuth,
      'former-campaign-owner-detail',
      { id: active }
    )), null);

    assert.deepEqual(ai.listConversations(db, secureRead(
      fixture.teammate,
      fixture.teammateAuth,
      'team-list'
    )), []);
    assert.equal(ai.getConversation(db, secureRead(
      fixture.teammate,
      fixture.teammateAuth,
      'team-detail',
      { id: active }
    )), null);

    const outsiderRows = ai.listConversations(db, secureRead(
      fixture.outsider,
      fixture.outsiderAuth,
      'outsider-list'
    ));
    assert.equal(outsiderRows.some((row) => row.id === active), false);
    assert.equal(outsiderRows.some((row) => row.id === crossOrg), false);

    const orgAdminRows = ai.listConversations(db, secureRead(
      fixture.orgAdmin,
      fixture.orgAdminAuth,
      'org-admin-list'
    ));
    assert.deepEqual(
      new Set(orgAdminRows.map((row) => row.id)),
      new Set([unlinked, active, revokeOnly, moved])
    );
    assert.equal(ai.getConversation(db, secureRead(
      fixture.orgAdmin,
      fixture.orgAdminAuth,
      'org-admin-detail',
      { id: moved }
    )).id, moved);
    assert.equal(ai.getConversation(db, secureRead(
      fixture.orgAdmin,
      fixture.orgAdminAuth,
      'org-admin-cross-org',
      { id: crossOrg }
    )), null);

    const platformRows = ai.listConversations(db, secureRead(
      fixture.platformAdmin,
      fixture.platformAdminAuth,
      'platform-admin-list'
    ));
    assert.deepEqual(
      new Set(platformRows.map((row) => row.id)),
      new Set([unlinked, active, revokeOnly, moved, crossOrg])
    );
    assert.equal(ai.getConversation(db, secureRead(
      fixture.platformAdmin,
      fixture.platformAdminAuth,
      'platform-cross-org-detail',
      { id: crossOrg }
    )).id, crossOrg);

    const staleOrgAdminContext = fixture.orgAdminAuth;
    db.prepare(`
      UPDATE team_memberships
      SET status='revoked',revoked_at='2026-07-25 00:00:00'
      WHERE org_id=1 AND user_id=? AND status='active'
    `).run(fixture.orgAdmin.id);
    db.prepare(`
      UPDATE organization_memberships
      SET status='revoked',revoked_at='2026-07-25 00:00:00'
      WHERE org_id=1 AND user_id=?
    `).run(fixture.orgAdmin.id);
    assert.deepEqual(ai.listConversations(db, secureRead(
      fixture.orgAdmin,
      staleOrgAdminContext,
      'revoked-org-admin-list'
    )), []);

    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM activity_log
      WHERE module='ai_audit' AND user_id=?
    `).get(fixture.owner.id).count, 0);
  } finally {
    db.close();
  }
});

test('legacy conversation signatures preserve unclassified reads but reauthorize linked custody from SQLite', () => {
  const db = openDatabase();
  try {
    const fixture = createFixture(db);
    const unlinked = createConversation(db, {
      title: 'Legacy owner unclassified',
      content: 'legacy-unclassified-body',
      updatedAt: '2026-07-01 00:00:01'
    });
    const accessibleLinked = createConversation(db, {
      title: 'Legacy owner accessible linked',
      content: 'legacy-accessible-linked-body',
      updatedAt: '2026-07-01 00:00:02'
    });
    linkConversation(db, {
      campaignId: fixture.ownerCampaignId,
      conversationId: accessibleLinked,
      createdBy: fixture.owner.id
    });
    const inaccessibleLinked = createConversation(db, {
      title: 'Legacy owner inaccessible linked',
      content: 'legacy-inaccessible-linked-body',
      updatedAt: '2026-07-01 00:00:03'
    });
    linkConversation(db, {
      campaignId: fixture.otherCampaignId,
      conversationId: inaccessibleLinked,
      createdBy: fixture.outsider.id
    });
    const crossOrgLinked = createConversation(db, {
      userId: fixture.outsider.id,
      title: 'Legacy platform admin cross organization',
      content: 'legacy-cross-org-linked-body',
      updatedAt: '2026-07-01 00:00:04'
    });
    linkConversation(db, {
      orgId: 2,
      campaignId: fixture.crossOrgCampaignId,
      conversationId: crossOrgLinked,
      createdBy: fixture.outsider.id
    });

    const spoofedAdminOwner = { ...fixture.owner, role: 'admin' };
    assert.deepEqual(
      ai.listConversations(db, { user: spoofedAdminOwner }).map((row) => row.id),
      [accessibleLinked, unlinked]
    );
    assert.equal(
      ai.getConversation(db, { id: unlinked, user: spoofedAdminOwner }).messages[0].content,
      'legacy-unclassified-body'
    );
    assert.equal(
      ai.getConversation(db, { id: accessibleLinked, user: spoofedAdminOwner }).messages[0].content,
      'legacy-accessible-linked-body'
    );
    assert.equal(ai.getConversation(db, {
      id: inaccessibleLinked,
      user: spoofedAdminOwner
    }), null);
    assert.equal(ai.getConversation(db, {
      id: crossOrgLinked,
      user: spoofedAdminOwner
    }), null);

    const platformRows = ai.listConversations(db, { user: fixture.platformAdmin });
    assert.deepEqual(new Set(platformRows.map((row) => row.id)), new Set([
      unlinked,
      accessibleLinked,
      inaccessibleLinked,
      crossOrgLinked
    ]));
    assert.equal(ai.getConversation(db, {
      id: crossOrgLinked,
      user: fixture.platformAdmin
    }).messages[0].content, 'legacy-cross-org-linked-body');
  } finally {
    db.close();
  }
});

test('AI conversation authorization and query matching happen before message count, ordering, and limit', () => {
  const db = openDatabase();
  try {
    const fixture = createFixture(db);
    const authorized = [];
    for (let index = 0; index < 2; index += 1) {
      const conversationId = createConversation(db, {
        title: `Authorized ${index}`,
        content: `prefilter-needle authorized-${index}`,
        updatedAt: `2026-07-01 00:00:0${index + 1}`
      });
      linkConversation(db, {
        campaignId: fixture.ownerCampaignId,
        conversationId,
        createdBy: fixture.owner.id
      });
      authorized.unshift(conversationId);
    }
    for (let index = 0; index < 205; index += 1) {
      const conversationId = createConversation(db, {
        title: `Inaccessible newer ${index}`,
        content: `prefilter-needle inaccessible-${index}`,
        updatedAt: `2026-07-02 00:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}`
      });
      linkConversation(db, {
        campaignId: fixture.otherCampaignId,
        conversationId,
        createdBy: fixture.outsider.id
      });
    }

    const rows = ai.listConversations(db, secureRead(
      fixture.owner,
      fixture.ownerAuth,
      'prefilter-list',
      { q: 'prefilter-needle', limit: 2 }
    ));
    assert.deepEqual(rows.map((row) => row.id), authorized);
    assert.deepEqual(rows.map((row) => row.message_count), [1, 1]);
    assert.equal(rows.every((row) => /authorized/.test(row.last_answer)), true);
  } finally {
    db.close();
  }
});

test('administrator audit filters combine user, date, source, archive, and reference evidence', () => {
  const db = openDatabase();
  try {
    const fixture = createFixture(db);
    const archive = knowledge.ingestKnowledge(db, {
      title: 'Audit filter archive',
      content: 'Approved audit filter archive content.',
      entry_type: 'ai_chat_summary',
      source_type: 'audit_filter_fixture',
      source_id: 'audit-filter-archive',
      visibility: 'private',
      created_by: fixture.owner.id
    });
    const target = createConversation(db, {
      userId: fixture.owner.id,
      title: 'Evidence-backed target',
      sourceModule: 'assistant',
      content: 'The answer itself does not contain the source keyword.',
      createdAt: '2026-06-30 23:59:59.999',
      updatedAt: '2026-07-05 23:59:59.999'
    });
    linkConversation(db, {
      campaignId: fixture.ownerCampaignId,
      conversationId: target,
      createdBy: fixture.owner.id
    });
    db.prepare('UPDATE ai_conversations SET archived_summary_id=? WHERE id=?')
      .run(archive.id, target);
    addWebReference(db, target);

    const unarchived = createConversation(db, {
      userId: fixture.owner.id,
      title: 'Unarchived distractor',
      sourceModule: 'assistant',
      content: 'Tavily source needle',
      createdAt: '2026-07-05 10:00:00'
    });
    linkConversation(db, {
      campaignId: fixture.ownerCampaignId,
      conversationId: unarchived,
      createdBy: fixture.owner.id
    });
    addWebReference(db, unarchived);
    const outsideDate = createConversation(db, {
      userId: fixture.owner.id,
      title: 'Outside-date distractor',
      sourceModule: 'assistant',
      content: 'Tavily source needle',
      createdAt: '2026-07-06 10:00:00'
    });
    linkConversation(db, {
      campaignId: fixture.ownerCampaignId,
      conversationId: outsideDate,
      createdBy: fixture.owner.id
    });
    db.prepare('UPDATE ai_conversations SET archived_summary_id=? WHERE id=?')
      .run(archive.id, outsideDate);
    addWebReference(db, outsideDate);

    const rows = ai.listConversations(db, secureRead(
      fixture.platformAdmin,
      fixture.platformAdminAuth,
      'audit-combined-filter-request',
      {
        q: 'Tavily source needle',
        user_id: fixture.owner.id,
        source_module: 'assistant',
        date_from: '2026-07-05',
        date_to: '2026-07-05',
        reference_type: 'web',
        archive_status: 'archived',
        limit: 20
      }
    ));

    assert.deepEqual(rows.map((row) => row.id), [target]);
    assert.equal(rows[0].campaign_id, fixture.ownerCampaignId);
    assert.equal(rows[0].knowledge_reference_count, 0);
    assert.equal(rows[0].web_reference_count, 1);
    assert.equal(rows[0].archived_summary_id, archive.id);
    const audit = db.prepare(`
      SELECT details FROM activity_log
      WHERE action='admin_list_ai_conversations' AND module='ai_audit'
      ORDER BY id DESC LIMIT 1
    `).get();
    assert.deepEqual(JSON.parse(audit.details).filter_names, [
      'q',
      'user_id',
      'source_module',
      'date_from',
      'date_to',
      'reference_type',
      'archive_status',
      'limit'
    ]);
  } finally {
    db.close();
  }
});

test('AI conversation audit dates include a persisted prompt even when completion never updates the conversation', () => {
  const db = openDatabase();
  try {
    const fixture = createFixture(db);
    const conversationId = createConversation(db, {
      userId: fixture.owner.id,
      title: 'Provider failure evidence',
      createdAt: '2026-07-01 09:00:00',
      updatedAt: '2026-07-01 09:00:00'
    });
    linkConversation(db, {
      campaignId: fixture.ownerCampaignId,
      conversationId,
      createdBy: fixture.owner.id
    });
    db.prepare(`
      INSERT INTO ai_messages (
        conversation_id,user_id,role,content,model,prompt_tokens,
        completion_tokens,total_tokens,metadata_json,created_at
      ) VALUES (?,?,'user','Prompt saved before provider failure',NULL,0,0,0,'{}',?)
    `).run(conversationId, fixture.owner.id, '2026-07-05 14:30:00');

    const rows = ai.listConversations(db, secureRead(
      fixture.platformAdmin,
      fixture.platformAdminAuth,
      'prompt-only-activity-request',
      {
        date_from: '2026-07-05',
        date_to: '2026-07-05'
      }
    ));

    assert.deepEqual(rows.map((row) => row.id), [conversationId]);
    assert.equal(rows[0].updated_at, '2026-07-01 09:00:00');
    assert.equal(rows[0].activity_at, '2026-07-05 14:30:00');
    assert.equal(Object.hasOwn(rows[0], 'last_message_at'), false);

    const detail = ai.getConversation(db, secureRead(
      fixture.platformAdmin,
      fixture.platformAdminAuth,
      'prompt-only-activity-detail-request',
      { id: conversationId }
    ));
    assert.equal(detail.activity_at, '2026-07-05 14:30:00');
    assert.equal(Object.hasOwn(detail, 'last_message_at'), false);
  } finally {
    db.close();
  }
});

test('AI conversation reads expose one bounded run projection for status, tokens, latency, and references', () => {
  const db = openDatabase();
  try {
    const fixture = createFixture(db);
    const conversationId = createConversation(db, {
      userId: fixture.owner.id,
      title: 'Run projection evidence',
      message: false
    });
    const insertMessage = db.prepare(`
      INSERT INTO ai_messages (
        conversation_id,user_id,role,content,model,prompt_tokens,
        completion_tokens,total_tokens,metadata_json,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?)
    `);
    insertMessage.run(
      conversationId,
      fixture.owner.id,
      'user',
      'Project one auditable run model',
      null,
      0,
      0,
      0,
      '{}',
      '2026-07-05 10:00:00'
    );
    const succeededId = Number(insertMessage.run(
      conversationId,
      fixture.owner.id,
      'assistant',
      'Succeeded answer',
      'deepseek-chat',
      10,
      5,
      15,
      JSON.stringify({ status: 'succeeded', latency_ms: 420 }),
      '2026-07-05 10:00:01'
    ).lastInsertRowid);
    const degradedId = Number(insertMessage.run(
      conversationId,
      fixture.owner.id,
      'assistant',
      'Degraded answer',
      'deepseek-chat',
      20,
      8,
      28,
      JSON.stringify({ degraded: true, latency_ms: 180 }),
      '2026-07-05 10:00:02'
    ).lastInsertRowid);
    const unknownId = Number(insertMessage.run(
      conversationId,
      fixture.owner.id,
      'assistant',
      'Legacy answer with malformed run metadata',
      'legacy-model',
      3,
      4,
      7,
      '{',
      '2026-07-05 10:00:03'
    ).lastInsertRowid);
    db.prepare(`
      INSERT INTO ai_references (
        message_id,reference_type,reference_id,title,url,snippet,provider,metadata_json
      ) VALUES (?,'knowledge','71','Internal method','','','knowledge','{}')
    `).run(succeededId);
    db.prepare(`
      INSERT INTO ai_references (
        message_id,reference_type,reference_id,title,url,snippet,provider,metadata_json
      ) VALUES (?,'web','web-1','External evidence','https://example.com/evidence','','tavily','{}')
    `).run(degradedId);

    const rows = ai.listConversations(db, secureRead(
      fixture.platformAdmin,
      fixture.platformAdminAuth,
      'run-projection-list-request',
      { q: 'Run projection evidence' }
    ));
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].run_summary, {
      status: 'mixed',
      run_count: 3,
      succeeded_count: 1,
      degraded_count: 1,
      failed_count: 0,
      unknown_count: 1,
      prompt_tokens: 33,
      completion_tokens: 17,
      total_tokens: 50,
      average_latency_ms: 300,
      latest_model: 'legacy-model',
      knowledge_reference_count: 1,
      web_reference_count: 1,
      cost_summary: {
        status: 'unavailable',
        currency: 'USD',
        priced_run_count: 0,
        unavailable_run_count: 3,
        total_cost_nano_usd: null
      }
    });
    for (const field of [
      'run_count',
      'succeeded_run_count',
      'degraded_run_count',
      'failed_run_count',
      'unknown_run_count',
      'run_prompt_tokens',
      'run_completion_tokens',
      'run_total_tokens',
      'average_run_latency_ms',
      'latest_run_model'
    ]) {
      assert.equal(Object.hasOwn(rows[0], field), false);
    }

    const detail = ai.getConversation(db, secureRead(
      fixture.platformAdmin,
      fixture.platformAdminAuth,
      'run-projection-detail-request',
      { id: conversationId }
    ));
    assert.deepEqual(detail.run_summary, rows[0].run_summary);
    assert.equal(Object.hasOwn(detail.messages[0], 'run'), false);
    assert.deepEqual(detail.messages[1].run, {
      run_id: succeededId,
      status: 'succeeded',
      model: 'deepseek-chat',
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      latency_ms: 420,
      knowledge_reference_count: 1,
      web_reference_count: 0,
      created_at: '2026-07-05 10:00:01',
      cost_projection: {
        status: 'unavailable',
        currency: 'USD',
        total_cost_nano_usd: null,
        policy_version: null,
        rate_period: null,
        reason: 'historical_snapshot_missing'
      }
    });
    assert.deepEqual(detail.messages[2].run, {
      run_id: degradedId,
      status: 'degraded',
      model: 'deepseek-chat',
      prompt_tokens: 20,
      completion_tokens: 8,
      total_tokens: 28,
      latency_ms: 180,
      knowledge_reference_count: 0,
      web_reference_count: 1,
      created_at: '2026-07-05 10:00:02',
      cost_projection: {
        status: 'unavailable',
        currency: 'USD',
        total_cost_nano_usd: null,
        policy_version: null,
        rate_period: null,
        reason: 'historical_snapshot_missing'
      }
    });
    assert.deepEqual(detail.messages[3].run, {
      run_id: unknownId,
      status: 'unknown',
      model: 'legacy-model',
      prompt_tokens: 3,
      completion_tokens: 4,
      total_tokens: 7,
      latency_ms: null,
      knowledge_reference_count: 0,
      web_reference_count: 0,
      created_at: '2026-07-05 10:00:03',
      cost_projection: {
        status: 'unavailable',
        currency: 'USD',
        total_cost_nano_usd: null,
        policy_version: null,
        rate_period: null,
        reason: 'invalid_snapshot'
      }
    });
    assert.equal(detail.messages[3].metadata_valid, false);
  } finally {
    db.close();
  }
});

test('AI conversation run summary marks a persisted prompt without an assistant result as incomplete', () => {
  const db = openDatabase();
  try {
    const fixture = createFixture(db);
    const conversationId = createConversation(db, {
      userId: fixture.owner.id,
      title: 'Incomplete run evidence',
      role: 'user',
      content: 'Prompt retained before provider failure'
    });

    const row = ai.listConversations(db, secureRead(
      fixture.platformAdmin,
      fixture.platformAdminAuth,
      'run-projection-incomplete-list',
      { q: 'Incomplete run evidence' }
    ))[0];
    assert.deepEqual(row.run_summary, {
      status: 'incomplete',
      run_count: 0,
      succeeded_count: 0,
      degraded_count: 0,
      failed_count: 0,
      unknown_count: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      average_latency_ms: null,
      latest_model: null,
      knowledge_reference_count: 0,
      web_reference_count: 0,
      cost_summary: {
        status: 'empty',
        currency: 'USD',
        priced_run_count: 0,
        unavailable_run_count: 0,
        total_cost_nano_usd: null
      }
    });
    const detail = ai.getConversation(db, secureRead(
      fixture.platformAdmin,
      fixture.platformAdminAuth,
      'run-projection-incomplete-detail',
      { id: conversationId }
    ));
    assert.deepEqual(detail.run_summary, row.run_summary);
  } finally {
    db.close();
  }
});

test('AI conversation run summary keeps totals bounded and marks a trailing prompt incomplete', () => {
  const db = openDatabase();
  try {
    const fixture = createFixture(db);
    const conversationId = createConversation(db, {
      userId: fixture.owner.id,
      title: 'Bounded incomplete run evidence',
      message: false
    });
    const insertMessage = db.prepare(`
      INSERT INTO ai_messages (
        conversation_id,user_id,role,content,model,prompt_tokens,
        completion_tokens,total_tokens,metadata_json,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?)
    `);
    for (const [index, latency] of [[1, null], [2, '']]) {
      insertMessage.run(
        conversationId,
        fixture.owner.id,
        'assistant',
        `Large token run ${index}`,
        `bounded-model-${index}`,
        Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER,
        JSON.stringify({ latency_ms: latency }),
        `2026-07-06 10:00:0${index}`
      );
    }
    insertMessage.run(
      conversationId,
      fixture.owner.id,
      'user',
      'The provider never completed this latest prompt',
      null,
      0,
      0,
      0,
      '{}',
      '2026-07-06 10:00:03'
    );

    const row = ai.listConversations(db, secureRead(
      fixture.platformAdmin,
      fixture.platformAdminAuth,
      'run-projection-bounded-list',
      { q: 'Bounded incomplete run evidence' }
    ))[0];
    assert.equal(row.run_summary.status, 'incomplete');
    assert.equal(row.run_summary.run_count, 2);
    assert.equal(row.run_summary.prompt_tokens, Number.MAX_SAFE_INTEGER);
    assert.equal(row.run_summary.completion_tokens, Number.MAX_SAFE_INTEGER);
    assert.equal(row.run_summary.total_tokens, Number.MAX_SAFE_INTEGER);
    assert.equal(row.run_summary.average_latency_ms, null);
    assert.equal(row.run_summary.latest_model, 'bounded-model-2');

    const detail = ai.getConversation(db, secureRead(
      fixture.platformAdmin,
      fixture.platformAdminAuth,
      'run-projection-bounded-detail',
      { id: conversationId }
    ));
    assert.deepEqual(detail.run_summary, row.run_summary);
    assert.equal(detail.messages[0].run.latency_ms, null);
    assert.equal(detail.messages[1].run.latency_ms, null);
  } finally {
    db.close();
  }
});

test('AI cost summaries reject an overflowing aggregate instead of presenting a capped amount', () => {
  const db = openDatabase();
  try {
    const fixture = createFixture(db);
    const conversationId = createConversation(db, {
      userId: fixture.owner.id,
      title: 'Cost aggregate overflow evidence',
      message: false
    });
    const insertMessage = db.prepare(`
      INSERT INTO ai_messages (
        conversation_id,user_id,role,content,model,prompt_tokens,
        completion_tokens,total_tokens,metadata_json,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?)
    `);
    const completionTokens = 7000000000000;
    const costSnapshot = llm.createDeepSeekCostSnapshot({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      occurredAt: '2026-08-23T12:00:00.000Z',
      usage: {
        prompt_tokens: 0,
        completion_tokens: completionTokens,
        total_tokens: completionTokens,
        prompt_cache_hit_tokens: 0,
        prompt_cache_miss_tokens: 0
      }
    });
    assert.equal(costSnapshot.total_cost_nano_usd, 4620000000000000);
    const costMetadata = JSON.stringify({
      status: 'succeeded',
      cost_snapshot: costSnapshot
    });
    for (const index of [1, 2]) {
      insertMessage.run(
        conversationId,
        fixture.owner.id,
        'assistant',
        `Overflowing priced run ${index}`,
        'deepseek-v4-flash',
        1,
        1,
        2,
        costMetadata,
        `2026-07-07 10:00:0${index}`
      );
    }

    const row = ai.listConversations(db, secureRead(
      fixture.platformAdmin,
      fixture.platformAdminAuth,
      'cost-overflow-list',
      { q: 'Cost aggregate overflow evidence' }
    ))[0];
    assert.deepEqual(row.run_summary.cost_summary, {
      status: 'overflow',
      currency: 'USD',
      priced_run_count: 2,
      unavailable_run_count: 0,
      total_cost_nano_usd: null
    });

    const detail = ai.getConversation(db, secureRead(
      fixture.platformAdmin,
      fixture.platformAdminAuth,
      'cost-overflow-detail',
      { id: conversationId }
    ));
    assert.deepEqual(detail.run_summary.cost_summary, row.run_summary.cost_summary);
    assert.equal(detail.messages.every((message) => message.run.cost_projection.status === 'priced'), true);
  } finally {
    db.close();
  }
});

test('AI list and detail projections agree on integral JSON real cost values', () => {
  const db = openDatabase();
  try {
    const fixture = createFixture(db);
    const conversationId = createConversation(db, {
      userId: fixture.owner.id,
      title: 'Integral real cost evidence',
      message: false
    });
    const costSnapshot = llm.createDeepSeekCostSnapshot({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      occurredAt: '2026-08-23T12:00:00.000Z',
      usage: {
        prompt_tokens: 10,
        completion_tokens: 8,
        total_tokens: 18,
        prompt_cache_hit_tokens: 4,
        prompt_cache_miss_tokens: 6
      }
    });
    const metadataJson = JSON.stringify({ status: 'succeeded', cost_snapshot: costSnapshot })
      .replace('"total_cost_nano_usd":6628', '"total_cost_nano_usd":6628.0');
    db.prepare(`
      INSERT INTO ai_messages (
        conversation_id,user_id,role,content,model,prompt_tokens,
        completion_tokens,total_tokens,metadata_json,created_at
      ) VALUES (?,?,'assistant','Integral real cost','deepseek-v4-flash',1,1,2,?,?)
    `).run(
      conversationId,
      fixture.owner.id,
      metadataJson,
      '2026-07-08 10:00:01'
    );

    const row = ai.listConversations(db, secureRead(
      fixture.platformAdmin,
      fixture.platformAdminAuth,
      'integral-real-cost-list',
      { q: 'Integral real cost evidence' }
    ))[0];
    assert.deepEqual(row.run_summary.cost_summary, {
      status: 'priced',
      currency: 'USD',
      priced_run_count: 1,
      unavailable_run_count: 0,
      total_cost_nano_usd: 6628
    });
    const detail = ai.getConversation(db, secureRead(
      fixture.platformAdmin,
      fixture.platformAdminAuth,
      'integral-real-cost-detail',
      { id: conversationId }
    ));
    assert.deepEqual(detail.run_summary.cost_summary, row.run_summary.cost_summary);
    assert.equal(detail.messages[0].run.cost_projection.total_cost_nano_usd, 6628);
  } finally {
    db.close();
  }
});

test('AI run counts retain restricted citation evidence without exposing its knowledge payload', () => {
  const db = openDatabase();
  try {
    const fixture = createFixture(db);
    let hidden;
    db.transaction(() => {
      hidden = knowledge.writeCampaignKnowledgeInTransaction(db, {
        organizationId: 2,
        campaignId: fixture.crossOrgCampaignId,
        createdBy: fixture.outsider.id,
        title: 'Restricted run citation',
        summary: '',
        content: 'Only the other owner may inspect this private knowledge payload.',
        entryType: 'document',
        sourceType: 'run_projection_fixture',
        sourceId: 'restricted-run-citation',
        visibility: 'private',
        tags: ['run', 'restricted'],
        metadata: { schema_version: 1 }
      });
      db.prepare(`
        INSERT INTO campaign_record_links (
          org_id,campaign_id,record_type,bundle_id,record_id,relation_type,
          created_by,metadata_json
        ) VALUES (2,?,'knowledge_entry',?,?,'knowledge',?,'{}')
      `).run(
        fixture.crossOrgCampaignId,
        sha256(`restricted-run-citation:${hidden.entry.id}`),
        String(hidden.entry.id),
        fixture.outsider.id
      );
      knowledge.applyKnowledgeCapacityGaugePlanInTransaction(db, hidden.capacityGaugePlan);
    }).immediate();
    const snapshot = db.prepare(`
      SELECT
        entry.id AS entry_id,entry.title,entry.source_identity_sha256,
        entry.content_sha256 AS entry_content_sha256,
        chunk.id AS chunk_id,chunk.content_sha256 AS chunk_content_sha256
      FROM knowledge_entries entry
      JOIN knowledge_chunks chunk ON chunk.entry_id=entry.id
      WHERE entry.id=?
      ORDER BY chunk.chunk_index
      LIMIT 1
    `).get(hidden.entry.id);
    const conversationId = createConversation(db, {
      userId: fixture.owner.id,
      title: 'Restricted reference run evidence'
    });
    const messageId = db.prepare(`
      SELECT id FROM ai_messages WHERE conversation_id=? ORDER BY id DESC LIMIT 1
    `).get(conversationId).id;
    db.prepare(`
      INSERT INTO ai_references (
        message_id,reference_type,reference_id,title,url,snippet,provider,metadata_json,
        reference_schema_version,knowledge_entry_id,knowledge_chunk_id,campaign_id,
        source_identity_sha256,entry_content_sha256,chunk_content_sha256,reference_rank,
        selection_origin
      ) VALUES (
        @messageId,'knowledge',@referenceId,@title,'','restricted snippet','','{}',
        1,@entryId,@chunkId,@campaignId,@sourceIdentitySha256,@entryContentSha256,
        @chunkContentSha256,1,'retrieved'
      )
    `).run({
      messageId,
      referenceId: String(snapshot.entry_id),
      title: snapshot.title,
      entryId: snapshot.entry_id,
      chunkId: snapshot.chunk_id,
      campaignId: fixture.crossOrgCampaignId,
      sourceIdentitySha256: snapshot.source_identity_sha256,
      entryContentSha256: snapshot.entry_content_sha256,
      chunkContentSha256: snapshot.chunk_content_sha256
    });

    const row = ai.listConversations(db, secureRead(
      fixture.owner,
      fixture.ownerAuth,
      'run-projection-restricted-list',
      { q: 'Restricted reference run evidence' }
    ))[0];
    assert.equal(row.run_summary.knowledge_reference_count, 1);

    const detail = ai.getConversation(db, secureRead(
      fixture.owner,
      fixture.ownerAuth,
      'run-projection-restricted-detail',
      { id: conversationId }
    ));
    assert.deepEqual(detail.messages[0].references, [{
      citation_label: 'KB-1',
      access_state: 'restricted'
    }]);
    assert.equal(detail.messages[0].run.knowledge_reference_count, 1);
    assert.equal(detail.run_summary.knowledge_reference_count, 1);
    assert.equal(JSON.stringify(detail).includes('restricted snippet'), false);
    assert.equal(JSON.stringify(detail).includes(snapshot.title), false);
  } finally {
    db.close();
  }
});

test('AI conversation audit rejects malformed or reversed bounded filters before audit persistence', () => {
  const db = openDatabase();
  try {
    const fixture = createFixture(db);
    const invalidInputs = [
      { reference_type: 'javascript' },
      { archive_status: 'deleted' },
      { date_from: '07/05/2026' },
      { date_from: '2026-07-06', date_to: '2026-07-05' }
    ];
    invalidInputs.forEach((extra, index) => {
      assert.throws(
        () => ai.listConversations(db, secureRead(
          fixture.platformAdmin,
          fixture.platformAdminAuth,
          `invalid-audit-filter-${index}`,
          extra
        )),
        (error) => error &&
          error.name === 'AIServiceError' &&
          error.statusCode === 400 &&
          error.code === 'INVALID_AI_AUDIT_FILTER'
      );
    });
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM activity_log WHERE module='ai_audit'
    `).get().count, 0);
  } finally {
    db.close();
  }
});

test('AI conversation detail rechecks custody before loading messages and references', () => {
  const db = openDatabase();
  try {
    const fixture = createFixture(db);
    const conversationId = createConversation(db, {
      title: 'Custody changes during detail',
      content: 'must-not-materialize-after-custody-change'
    });
    const linkId = linkConversation(db, {
      campaignId: fixture.ownerCampaignId,
      conversationId,
      createdBy: fixture.owner.id
    });
    let authorizationReads = 0;
    let messageMaterializations = 0;
    let broadMessageActivityAggregations = 0;
    let moved = false;
    const move = () => {
      if (moved) return;
      moved = true;
      moveConversation(db, {
        linkId,
        revokedBy: fixture.owner.id,
        destinationCampaignId: fixture.otherCampaignId,
        destinationCreatedBy: fixture.outsider.id,
        conversationId
      });
    };
    const observedDb = {
      prepare(sql) {
        const normalized = String(sql);
        if (/FROM\s+ai_conversations\s+c/i.test(normalized)) {
          authorizationReads += 1;
          if (authorizationReads === 2) move();
        }
        if (/SELECT\s+\*\s+FROM\s+ai_messages/i.test(normalized)) {
          if (!moved) move();
          messageMaterializations += 1;
        }
        if (
          /conversation_message_activity|MAX\s*\(\s*message\.created_at\s*\)/i.test(normalized) ||
          /FROM\s+ai_messages\s+activity_message/i.test(normalized) ||
          /SELECT\s+MAX\s*\(\s*created_at\s*\)[\s\S]*FROM\s+ai_messages/i.test(normalized)
        ) {
          broadMessageActivityAggregations += 1;
        }
        return db.prepare(sql);
      },
      transaction(callback) {
        return db.transaction(callback);
      }
    };

    const result = ai.getConversation(observedDb, secureRead(
      fixture.owner,
      fixture.ownerAuth,
      'detail-recheck',
      { id: conversationId }
    ));
    assert.equal(moved, true);
    assert.ok(authorizationReads >= 2);
    assert.equal(messageMaterializations, 0);
    assert.equal(broadMessageActivityAggregations, 0);
    assert.equal(result, null);
  } finally {
    db.close();
  }
});

test('privileged list/detail audits are sanitized and audit persistence failure is typed and fail closed', () => {
  const db = openDatabase();
  try {
    const fixture = createFixture(db);
    const secrets = {
      query: 'QUERY_VALUE_4af7f65b',
      prompt: 'PROMPT_CONTENT_51f51eca',
      reply: 'REPLY_CONTENT_8c7e4df8',
      provider: 'PROVIDER_PAYLOAD_ef694b95',
      source: 'SOURCE_CONTENT_a1f5c780',
      token: 7654321
    };
    const conversationId = createConversation(db, {
      title: 'Sensitive privileged target',
      sourceModule: 'SOURCE_MODULE_SECRET_aa81f222',
      role: 'user',
      content: `${secrets.query} ${secrets.prompt}`,
      promptTokens: secrets.token,
      totalTokens: secrets.token
    });
    db.prepare(`
      INSERT INTO ai_messages (
        conversation_id,user_id,role,content,model,prompt_tokens,
        completion_tokens,total_tokens,metadata_json
      ) VALUES (?,?, 'assistant',?,?,?,?,?,?)
    `).run(
      conversationId,
      fixture.owner.id,
      secrets.reply,
      secrets.provider,
      secrets.token,
      secrets.token,
      secrets.token,
      JSON.stringify({ provider_payload: secrets.provider })
    );
    const assistantMessageId = Number(db.prepare(`
      SELECT id FROM ai_messages
      WHERE conversation_id=? AND role='assistant'
      ORDER BY id DESC LIMIT 1
    `).get(conversationId).id);
    db.prepare(`
      INSERT INTO ai_references (
        message_id,reference_type,reference_id,title,url,snippet,provider,metadata_json
      ) VALUES (?,'web','secret-source','Secret source','https://example.invalid',?,?,?)
    `).run(
      assistantMessageId,
      secrets.source,
      secrets.provider,
      JSON.stringify({ raw_source: secrets.source })
    );
    linkConversation(db, {
      campaignId: fixture.ownerCampaignId,
      conversationId,
      createdBy: fixture.owner.id
    });

    const rows = ai.listConversations(db, secureRead(
      fixture.orgAdmin,
      fixture.orgAdminAuth,
      'audit-list-request',
      {
        q: secrets.query,
        user_id: fixture.owner.id,
        source_module: 'SOURCE_MODULE_SECRET_aa81f222',
        limit: 5
      }
    ));
    assert.deepEqual(rows.map((row) => row.id), [conversationId]);
    assert.equal(ai.getConversation(db, secureRead(
      fixture.orgAdmin,
      fixture.orgAdminAuth,
      'audit-detail-request',
      { id: conversationId }
    )).id, conversationId);

    const audits = db.prepare(`
      SELECT action,details
      FROM activity_log
      WHERE module='ai_audit' AND user_id=?
      ORDER BY id
    `).all(fixture.orgAdmin.id);
    assert.deepEqual(audits.map((row) => row.action), [
      'admin_list_ai_conversations',
      'admin_view_ai_conversation'
    ]);
    assert.deepEqual(JSON.parse(audits[0].details), {
      actor_user_id: fixture.orgAdmin.id,
      organization_id: 1,
      request_id: 'audit-list-request',
      filter_names: ['q', 'user_id', 'source_module', 'limit'],
      targets: [{
        conversation_id: conversationId,
        user_id: fixture.owner.id,
        organization_id: 1,
        campaign_id: fixture.ownerCampaignId
      }]
    });
    assert.deepEqual(JSON.parse(audits[1].details), {
      actor_user_id: fixture.orgAdmin.id,
      organization_id: 1,
      request_id: 'audit-detail-request',
      filter_names: ['id'],
      targets: [{
        conversation_id: conversationId,
        user_id: fixture.owner.id,
        organization_id: 1,
        campaign_id: fixture.ownerCampaignId
      }]
    });
    const serializedAudits = audits.map((row) => row.details).join('\n');
    for (const sensitive of Object.values(secrets)) {
      assert.equal(serializedAudits.includes(String(sensitive)), false);
    }
    assert.equal(serializedAudits.includes('SOURCE_MODULE_SECRET_aa81f222'), false);

    db.prepare(`
      CREATE TRIGGER fail_ai_read_audit
      BEFORE INSERT ON activity_log
      WHEN NEW.module='ai_audit'
      BEGIN SELECT RAISE(ABORT,'forced AI read audit failure'); END
    `).run();

    let listResult;
    assert.throws(
      () => {
        listResult = ai.listConversations(db, secureRead(
          fixture.platformAdmin,
          fixture.platformAdminAuth,
          'audit-list-failure'
        ));
      },
      (error) => error &&
        error.name === 'AIServiceError' &&
        error.statusCode === 500 &&
        error.code === 'AUDIT_PERSISTENCE_FAILED'
    );
    assert.equal(listResult, undefined);

    let detailResult;
    assert.throws(
      () => {
        detailResult = ai.getConversation(db, secureRead(
          fixture.platformAdmin,
          fixture.platformAdminAuth,
          'audit-detail-failure',
          { id: conversationId }
        ));
      },
      (error) => error &&
        error.name === 'AIServiceError' &&
        error.statusCode === 500 &&
        error.code === 'AUDIT_PERSISTENCE_FAILED'
    );
    assert.equal(detailResult, undefined);
  } finally {
    db.close();
  }
});

test('linked AI archive stores governed promotion metadata while links keep closed metadata objects', async () => {
  const db = openDatabase();
  try {
    const fixture = createFixture(db);
    const result = await ai.handleChat(db, {
      user: fixture.owner,
      campaign_id: fixture.ownerCampaignId,
      message: 'Archive metadata must be closed.',
      source_module: 'caller-controlled-source-module',
      knowledge_entry_ids: [],
      idempotencyKey: 'ai-read-metadata-contract',
      requestId: 'ai-read-metadata-contract-request',
      allowWeb: false,
      archiveSummary: true,
      provider: {
        async complete() {
          return {
            content: 'Closed archive metadata response.',
            model: 'metadata-contract-model',
            usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }
          };
        }
      }
    });

    const archive = db.prepare(`
      SELECT metadata_json
      FROM knowledge_entries
      WHERE id=?
    `).get(result.archived_summary_id);
    const links = db.prepare(`
      SELECT record_type,relation_type,metadata_json
      FROM campaign_record_links
      WHERE campaign_id=?
        AND (
          (record_type='ai_conversation' AND record_id=? AND relation_type='ai_run')
          OR
          (record_type='knowledge_entry' AND record_id=? AND relation_type='knowledge')
        )
      ORDER BY record_type,relation_type
    `).all(
      fixture.ownerCampaignId,
      String(result.conversation_id),
      String(result.archived_summary_id)
    );
    const archiveMetadata = JSON.parse(archive.metadata_json);
    assert.equal(archiveMetadata.conversation_id, result.conversation_id);
    assert.equal(archiveMetadata.assistant_message_id, result.message_id);
    assert.deepEqual(archiveMetadata.promotion, result.summary_promotion);
    assert.equal(archiveMetadata.promotion.reason, 'explicit_selection');
    assert.equal(Object.hasOwn(archiveMetadata, 'source_module'), false);
    assert.deepEqual(links, [
      { record_type: 'ai_conversation', relation_type: 'ai_run', metadata_json: '{}' },
      { record_type: 'knowledge_entry', relation_type: 'knowledge', metadata_json: '{}' }
    ]);
  } finally {
    db.close();
  }
});

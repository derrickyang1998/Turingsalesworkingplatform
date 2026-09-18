'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const migrationGate = require('../scripts/verify_campaign_migration_gate');
const ai = require('../services/ai_service');
const { createCampaignService } = require('../services/campaign_service');
const { getTargetAccess } = require('../services/campaign_access_service');

const SERVER_ROOT = path.resolve(__dirname, '..');

function loadMigration() {
  try {
    return require('../migrations/025_ai_conversation_tenant_ownership');
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') {
      assert.fail('migration 025 has not been implemented');
    }
    throw error;
  }
}

function openDatabase() {
  const migration = loadMigration();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrationService.runMigrations(db, {
    rootDir: SERVER_ROOT,
    registeredMigrations: [
      ...migrationGate.REGISTERED_MIGRATIONS.filter((registered) => registered.version <= 24),
      migration
    ]
  });
  return db;
}

function user(db, id) {
  return db.prepare('SELECT id,username,display_name,role FROM users WHERE id=?').get(id);
}

function authContext(organizationId, roleCode = 'member') {
  return {
    organization: {
      id: organizationId,
      role_code: roleCode
    },
    teams: []
  };
}

function seedSecondOrganization(db) {
  db.prepare("INSERT INTO organizations (id,code,name) VALUES (2,'runtime-org-2','Runtime Org 2')").run();
  db.prepare(`
    INSERT INTO organization_memberships (org_id,user_id,role_code,status)
    VALUES (2,2,'member','active')
  `).run();
  db.prepare(`
    INSERT INTO teams (id,org_id,code,name)
    VALUES (100,2,'runtime-team-2','Runtime Team 2')
  `).run();
  db.prepare(`
    INSERT INTO team_memberships (org_id,team_id,user_id,role_code,status)
    VALUES (2,100,2,'member','active')
  `).run();
}

function seedCampaigns(db) {
  const defaultTeamId = db.prepare(`
    SELECT team_id FROM team_memberships
    WHERE org_id=1 AND user_id=1 AND status='active'
    ORDER BY team_id LIMIT 1
  `).get().team_id;
  db.prepare(`
    INSERT INTO customers (id,brand_name,created_by,assigned_to,is_public,org_id,team_id)
    VALUES
      (4101,'Runtime Org 1 Brand',1,1,0,1,?),
      (4102,'Runtime Org 2 Brand',2,2,0,2,100)
  `).run(defaultTeamId);
  db.prepare(`
    INSERT INTO opportunities (
      id,customer_id,name,created_by,org_id,team_id,owner_user_id
    ) VALUES
      (4201,4101,'Runtime Org 1 Opportunity',1,1,?,1),
      (4202,4102,'Runtime Org 2 Opportunity',2,2,100,2)
  `).run(defaultTeamId);
  db.prepare(`
    INSERT INTO campaigns (
      id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id
    ) VALUES
      (4301,1,'Runtime Org 1 Campaign',4101,4201,1,?),
      (4302,2,'Runtime Org 2 Campaign',4102,4202,2,100)
  `).run(defaultTeamId);
}

function linkConversation(db, values) {
  db.prepare(`
    INSERT INTO campaign_record_links (
      org_id,campaign_id,record_type,bundle_id,record_id,relation_type,
      created_by,metadata_json
    ) VALUES (?,?,'ai_conversation',lower(hex(randomblob(32))),?,'ai_run',?,'{}')
  `).run(values.orgId, values.campaignId, String(values.conversationId), values.createdBy);
}

function insertConversation(db, values) {
  const result = db.prepare(`
    INSERT INTO ai_conversations (
      user_id,title,visibility,source_module,org_id,created_at,updated_at
    ) VALUES (?,?,'private',?,?, ?, ?)
  `).run(
    values.userId,
    values.title,
    values.sourceModule || 'assistant',
    values.orgId,
    values.createdAt || '2026-09-19 10:00:00',
    values.updatedAt || values.createdAt || '2026-09-19 10:00:00'
  );
  return Number(result.lastInsertRowid);
}

function secureRead(actor, organizationId, requestId, extra = {}) {
  return {
    user: actor,
    authContext: authContext(organizationId),
    requestId,
    ...extra
  };
}

test('AI conversation creation derives immutable ownership from server organization context', () => {
  const db = openDatabase();
  try {
    seedSecondOrganization(db);
    const actor = user(db, 2);
    const conversation = ai.ensureConversation(db, {
      user: actor,
      message: 'Create in active organization one',
      organizationId: 1,
      org_id: 2,
      organization_id: 2
    });
    assert.equal(conversation.org_id, 1);

    assert.throws(
      () => ai.ensureConversation(db, {
        user: actor,
        message: 'Missing server organization context',
        org_id: 2
      }),
      /organization context/i
    );
  } finally {
    db.close();
  }
});

test('AI conversation continuation is restricted to the active organization for owners and platform admins', () => {
  const db = openDatabase();
  try {
    seedSecondOrganization(db);
    const owner = user(db, 2);
    const platformAdmin = user(db, 1);
    const conversationId = insertConversation(db, {
      userId: owner.id,
      title: 'Tenant two conversation',
      orgId: 2
    });

    assert.equal(ai.ensureConversation(db, {
      user: owner,
      conversation_id: conversationId,
      organizationId: 2
    }).id, conversationId);
    assert.throws(
      () => ai.ensureConversation(db, {
        user: owner,
        conversation_id: conversationId,
        organizationId: 1
      }),
      /not found or forbidden/i
    );
    assert.throws(
      () => ai.ensureConversation(db, {
        user: platformAdmin,
        conversation_id: conversationId,
        organizationId: 1
      }),
      /not found or forbidden/i
    );
  } finally {
    db.close();
  }
});

test('ordinary AI reads stay in the active organization while audited platform-admin reads remain global', () => {
  const db = openDatabase();
  try {
    seedSecondOrganization(db);
    const owner = user(db, 2);
    const platformAdmin = user(db, 1);
    const orgOne = insertConversation(db, {
      userId: owner.id,
      title: 'Owner organization one',
      orgId: 1,
      updatedAt: '2026-09-19 10:00:01'
    });
    const orgTwo = insertConversation(db, {
      userId: owner.id,
      title: 'Owner organization two',
      orgId: 2,
      updatedAt: '2026-09-19 10:00:02'
    });

    assert.deepEqual(
      ai.listConversations(db, secureRead(owner, 1, 'owner-org-one')).map((row) => row.id),
      [orgOne]
    );
    assert.equal(ai.getConversation(db, secureRead(owner, 1, 'owner-cross-org', {
      id: orgTwo
    })), null);
    assert.deepEqual(
      ai.listConversations(db, secureRead(owner, 2, 'owner-org-two')).map((row) => row.id),
      [orgTwo]
    );

    const ordinaryAdminRows = ai.listConversations(db, secureRead(
      platformAdmin,
      1,
      'platform-admin-ordinary-org-one'
    ));
    assert.deepEqual(ordinaryAdminRows.map((row) => row.id), []);
    assert.equal(ai.getConversation(db, secureRead(platformAdmin, 1, 'platform-admin-ordinary-detail', {
      id: orgTwo
    })), null);

    const globalRows = ai.listConversations(db, secureRead(
      platformAdmin,
      1,
      'platform-admin-global-audit',
      { adminAuditGlobal: true }
    ));
    assert.deepEqual(new Set(globalRows.map((row) => row.id)), new Set([orgOne, orgTwo]));
    assert.equal(globalRows.some((row) => Object.hasOwn(row, 'org_id')), false);
    const globalDetail = ai.getConversation(db, secureRead(
      platformAdmin,
      1,
      'platform-admin-global-detail',
      { id: orgTwo, adminAuditGlobal: true }
    ));
    assert.equal(globalDetail.id, orgTwo);
    assert.equal(Object.hasOwn(globalDetail, 'org_id'), false);
    const audit = db.prepare(`
      SELECT details FROM activity_log
      WHERE module='ai_audit' AND action='admin_list_ai_conversations'
      ORDER BY id DESC LIMIT 1
    `).get();
    assert.ok(audit);
    assert.deepEqual(
      new Set(JSON.parse(audit.details).targets.map((target) => target.organization_id)),
      new Set([1, 2])
    );
  } finally {
    db.close();
  }
});

test('Campaign AI candidates and target access reject conversations owned by another organization', () => {
  const db = openDatabase();
  try {
    seedSecondOrganization(db);
    seedCampaigns(db);
    const sameOrganization = insertConversation(db, {
      userId: 2,
      title: 'Same organization candidate',
      orgId: 1
    });
    const otherOrganization = insertConversation(db, {
      userId: 2,
      title: 'Other organization secret candidate',
      orgId: 2
    });
    const service = createCampaignService(db);

    const candidates = service.listCampaignLinkCandidates({
      userId: 1,
      campaignId: 4301,
      query: {
        relation_type: 'ai_run',
        q: 'organization',
        limit: '20',
        offset: '0'
      }
    });
    assert.deepEqual(candidates.items.map((item) => item.record_id), [String(sameOrganization)]);
    assert.equal(candidates.total, 1);
    assert.equal(getTargetAccess(db, {
      userId: 1,
      campaignId: 4301,
      recordType: 'ai_conversation',
      recordId: otherOrganization,
      relationType: 'ai_run',
      intent: 'attach'
    }).code, 'RECORD_NOT_FOUND');
  } finally {
    db.close();
  }
});

test('proposal and PPT audit reuse cannot read a conversation outside the active organization', () => {
  const db = openDatabase();
  try {
    seedSecondOrganization(db);
    seedCampaigns(db);
    const platformAdmin = user(db, 1);
    const sameOrganization = insertConversation(db, {
      userId: 1,
      title: 'Same organization proposal audit',
      sourceModule: 'proposal',
      orgId: 1
    });
    const sameMessage = Number(db.prepare(`
      INSERT INTO ai_messages (conversation_id,user_id,role,content,metadata_json)
      VALUES (?,1,'assistant','Same organization proposal','{"campaign_id":4301}')
    `).run(sameOrganization).lastInsertRowid);
    linkConversation(db, {
      orgId: 1,
      campaignId: 4301,
      conversationId: sameOrganization,
      createdBy: 1
    });
    assert.deepEqual(ai.verifyProposalDraftAuditContext(db, {
      user: platformAdmin,
      authContext: authContext(1, 'org_admin'),
      organizationId: 1,
      requestId: 'same-org-proposal-audit',
      campaign_id: 4301,
      conversation_id: sameOrganization,
      message_id: sameMessage
    }), {
      conversation_id: sameOrganization,
      message_id: sameMessage
    });

    const otherOrganization = insertConversation(db, {
      userId: 2,
      title: 'Other organization proposal audit',
      sourceModule: 'proposal',
      orgId: 2
    });
    const otherMessage = Number(db.prepare(`
      INSERT INTO ai_messages (conversation_id,user_id,role,content,metadata_json)
      VALUES (?,2,'assistant','Other organization proposal','{"campaign_id":4302}')
    `).run(otherOrganization).lastInsertRowid);
    linkConversation(db, {
      orgId: 2,
      campaignId: 4302,
      conversationId: otherOrganization,
      createdBy: 2
    });
    assert.throws(
      () => ai.verifyProposalDraftAuditContext(db, {
        user: platformAdmin,
        authContext: authContext(1, 'org_admin'),
        organizationId: 1,
        requestId: 'cross-org-proposal-audit',
        campaign_id: 4302,
        conversation_id: otherOrganization,
        message_id: otherMessage
      }),
      (error) => error && error.code === 'INVALID_PROPOSAL_AUDIT_CONTEXT'
    );
  } finally {
    db.close();
  }
});

test('manual AI promotion rejects a globally auditable conversation outside the active organization', () => {
  const db = openDatabase();
  try {
    seedSecondOrganization(db);
    const platformAdmin = user(db, 1);
    const owner = user(db, 2);
    const conversationId = insertConversation(db, {
      userId: owner.id,
      title: 'Cross-organization promotion target',
      orgId: 2
    });
    const userMessageId = Number(db.prepare(`
      INSERT INTO ai_messages (conversation_id,user_id,role,content,metadata_json)
      VALUES (?,?,'user','Which method should be retained?','{}')
    `).run(conversationId, owner.id).lastInsertRowid);
    const assistantMessageId = Number(db.prepare(`
      INSERT INTO ai_messages (conversation_id,user_id,role,content,metadata_json)
      VALUES (?,?,'assistant',?,?)
    `).run(
      conversationId,
      owner.id,
      'A detailed reusable method that belongs only to organization two.'.repeat(8),
      JSON.stringify({ user_message_id: userMessageId })
    ).lastInsertRowid);
    const before = db.prepare('SELECT COUNT(*) AS count FROM knowledge_entries WHERE org_id=1').get().count;

    assert.throws(
      () => ai.promoteMessageToKnowledge(db, {
        user: platformAdmin,
        authContext: authContext(1),
        organizationId: 1,
        requestId: 'cross-org-promotion-rejection',
        conversation_id: conversationId,
        message_id: assistantMessageId,
        visibility: 'private'
      }),
      (error) => error && error.code === 'RECORD_NOT_FOUND'
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM knowledge_entries WHERE org_id=1').get().count,
      before
    );
  } finally {
    db.close();
  }
});

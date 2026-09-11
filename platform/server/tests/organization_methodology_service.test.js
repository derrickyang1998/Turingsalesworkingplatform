'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const path = require('node:path');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const migrationGate = require('../scripts/verify_campaign_migration_gate');
const knowledge = require('../services/knowledge_service');
const {
  createOrganizationMethodologyService
} = require('../services/organization_methodology_service');

const SERVER_ROOT = path.resolve(__dirname, '..');

function openDatabase() {
  const db = new Database(':memory:');
  migrationService.runMigrations(db, {
    rootDir: SERVER_ROOT,
    registeredMigrations: migrationGate.REGISTERED_MIGRATIONS
  });
  return db;
}

function createCampaign(db, input) {
  const customerId = input.campaignId * 10 + 1;
  const opportunityId = input.campaignId * 10 + 2;
  db.prepare(`
    INSERT INTO customers (
      id,brand_name,company_name,stage,source,created_by,assigned_to,is_public
    ) VALUES (?,?,?,?,?,?,?,0)
  `).run(
    customerId,
    `Methodology brand ${input.campaignId}`,
    `Methodology company ${input.campaignId}`,
    'qualified',
    'organization-methodology-test',
    input.ownerUserId,
    input.ownerUserId
  );
  db.prepare(`
    INSERT INTO opportunities (
      id,customer_id,name,stage,value,win_probability,product_name,channel_type,created_by
    ) VALUES (?,?,?,?,1000,50,?,?,?)
  `).run(
    opportunityId,
    customerId,
    `Methodology opportunity ${input.campaignId}`,
    'proposal',
    input.productName || 'Methodology product',
    input.channelType || 'influencer',
    input.ownerUserId
  );
  db.prepare(`
    INSERT INTO campaigns (
      id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,
      lifecycle_state,operational_status,row_version
    ) VALUES (?,?,?,?,?,?,?,'lead','active',1)
  `).run(
    input.campaignId,
    input.orgId,
    `Methodology campaign ${input.campaignId}`,
    customerId,
    opportunityId,
    input.ownerUserId,
    input.teamId
  );
}

function fixture(db) {
  const organization = db.prepare(
    "SELECT id FROM organizations WHERE code='turingmarket-default'"
  ).get();
  const team = db.prepare(`
    SELECT left_membership.team_id AS id
    FROM team_memberships left_membership
    JOIN team_memberships right_membership
      ON right_membership.org_id=left_membership.org_id
     AND right_membership.team_id=left_membership.team_id
     AND right_membership.user_id=3
     AND right_membership.status='active'
    WHERE left_membership.org_id=?
      AND left_membership.user_id=2
      AND left_membership.status='active'
    LIMIT 1
  `).get(organization.id);
  assert.ok(organization && team);

  db.prepare(`
    UPDATE organization_memberships
    SET role_code='org_admin'
    WHERE org_id=? AND user_id IN (2,3)
  `).run(organization.id);

  createCampaign(db, {
    campaignId: 980101,
    orgId: organization.id,
    ownerUserId: 2,
    teamId: team.id,
    productName: 'Portable power station',
    channelType: 'youtube'
  });
  createCampaign(db, {
    campaignId: 980102,
    orgId: organization.id,
    ownerUserId: 3,
    teamId: team.id,
    productName: 'Portable power station',
    channelType: 'youtube'
  });

  db.prepare(`
    INSERT INTO users (
      id,username,password_hash,display_name,role,is_active
    ) VALUES (980300,'platform-support-methodology','fixture-hash','Platform Support','admin',1)
  `).run();

  db.prepare(`
    UPDATE team_memberships
    SET status='revoked',revoked_at=CURRENT_TIMESTAMP
    WHERE org_id=? AND user_id=4
  `).run(organization.id);
  db.prepare(`
    UPDATE organization_memberships
    SET status='revoked',revoked_at=CURRENT_TIMESTAMP
    WHERE org_id=? AND user_id=4
  `).run(organization.id);

  db.prepare(`
    INSERT INTO organizations (id,code,name)
    VALUES (980200,'methodology-other-org','Methodology Other Org')
  `).run();
  db.prepare(`
    INSERT INTO organization_memberships (org_id,user_id,role_code,status)
    VALUES (980200,4,'org_admin','active'),(980200,5,'member','active')
  `).run();
  db.prepare(`
    INSERT INTO teams (id,org_id,code,name)
    VALUES (980201,980200,'methodology-other-team','Methodology Other Team')
  `).run();
  db.prepare(`
    INSERT INTO team_memberships (org_id,team_id,user_id,role_code,status)
    VALUES (980200,980201,4,'team_lead','active'),(980200,980201,5,'member','active')
  `).run();
  createCampaign(db, {
    campaignId: 980202,
    orgId: 980200,
    ownerUserId: 4,
    teamId: 980201,
    productName: 'Other product',
    channelType: 'instagram'
  });

  return {
    orgId: organization.id,
    sourceCampaignId: 980101,
    peerCampaignId: 980102,
    otherOrgId: 980200,
    otherCampaignId: 980202,
    firstApprover: { id: 2, role: 'user' },
    secondApprover: { id: 3, role: 'user' },
    otherOrgAdmin: { id: 4, role: 'member' },
    platformSupport: { id: 980300, role: 'admin' }
  };
}

function writeApprovedSource(db, state, input = {}) {
  const sourceType = input.sourceType || 'performance_ai_review_confirmation';
  const sourceId = input.sourceId || `source-${randomBytes(8).toString('hex')}`;
  const content = input.content || '复用清晰的问题钩子，并在首屏展示量化收益。';
  let written;
  db.transaction(() => {
    written = knowledge.writeCampaignKnowledgeInTransaction(db, {
      organizationId: state.orgId,
      campaignId: state.sourceCampaignId,
      createdBy: state.firstApprover.id,
      entryType: 'campaign_performance_review',
      sourceType,
      sourceId,
      title: input.title || '已确认项目复盘结论',
      summary: input.summary || content,
      content,
      tags: input.tags || ['performance', 'human_confirmed'],
      visibility: input.visibility || 'team',
      metadata: {
        schema_version: 1,
        evidence: {
          selected_metric: input.selectedMetric || 'core_view_er',
          content_id: input.contentId || null,
          platform: input.platform || 'youtube'
        },
        confirmation: {
          approved_by: state.firstApprover.id,
          approved_at: '2026-09-11T00:00:00.000Z',
          contract_version: sourceType === 'performance_ai_review_confirmation'
            ? 'performance-ai-review-approval-v1'
            : 'performance-content-analysis-approval-v1'
        }
      }
    });
    db.prepare(`
      INSERT INTO campaign_record_links (
        org_id,campaign_id,record_type,bundle_id,record_id,relation_type,
        created_by,metadata_json
      ) VALUES (?,?,?,?,?,'knowledge',?,'{}')
    `).run(
      state.orgId,
      state.sourceCampaignId,
      'knowledge_entry',
      createHash('sha256').update(`methodology-source:${sourceId}`).digest('hex'),
      String(written.entry.id),
      state.firstApprover.id
    );
    knowledge.applyKnowledgeCapacityGaugePlanInTransaction(db, written.capacityGaugePlan);
    knowledge.confirmKnowledgeInTransaction(db, {
      entryId: written.entry.id,
      expectedVersion: 1,
      reviewedBy: state.firstApprover.id,
      reason: '项目负责人已人工确认效果复盘结论。'
    });
  }).immediate();
  return db.prepare('SELECT * FROM knowledge_entries WHERE id=?').get(written.entry.id);
}

function requestPromotion(service, state, source, options = {}) {
  return service.requestPromotion({
    user: options.user || state.firstApprover,
    campaignId: state.sourceCampaignId,
    idempotencyKey: options.idempotencyKey || `methodology-request-${options.suffix || 'primary'}-12345678`,
    requestId: options.requestId || `methodology-request-id-${options.suffix || 'primary'}-12345678`,
    body: {
      source_knowledge_entry_id: source.id,
      expected_governance_version: options.expectedGovernanceVersion || 2,
      reason: options.reason || '申请将已确认结论纳入组织方法论。',
      supersedes_knowledge_entry_id: options.supersedesKnowledgeEntryId || null
    }
  });
}

function decidePromotion(service, state, request, options = {}) {
  return service.decidePromotion({
    user: options.user || state.secondApprover,
    campaignId: state.sourceCampaignId,
    promotionRequestId: request.promotion_request_id,
    idempotencyKey: options.idempotencyKey || `methodology-decision-${options.suffix || request.promotion_request_id}-12345678`,
    requestId: options.requestId || `methodology-decision-id-${options.suffix || request.promotion_request_id}-12345678`,
    body: {
      decision: options.decision || 'approved',
      reason: options.reason || '独立复核通过，可供同组织后续项目复用。'
    }
  });
}

test('promotion stays pending until a different organization administrator approves it', () => {
  const db = openDatabase();
  try {
    const state = fixture(db);
    const source = writeApprovedSource(db, state);
    const service = createOrganizationMethodologyService(db);

    const requested = requestPromotion(service, state, source);
    const replay = requestPromotion(service, state, source);
    assert.deepEqual(replay, requested);
    assert.equal(requested.contract_version, 'organization-methodology-promotion-v2');
    assert.equal(requested.status, 'pending');
    assert.equal(requested.first_approved_by, state.firstApprover.id);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM organization_methodology_promotion_decisions').get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM knowledge_entries WHERE source_type='organization_performance_methodology'").get().count, 0);

    assert.throws(
      () => decidePromotion(service, state, requested, { user: state.firstApprover, suffix: 'same-person' }),
      (error) => error && error.statusCode === 403 && error.code === 'ORGANIZATION_METHODOLOGY_FOUR_EYES_REQUIRED'
    );

    const approved = decidePromotion(service, state, requested);
    const approvedReplay = decidePromotion(service, state, requested);
    assert.deepEqual(approvedReplay, approved);
    assert.equal(approved.status, 'promoted');
    assert.equal(approved.decided_by, state.secondApprover.id);
    assert.notEqual(approved.target_knowledge_entry_id, source.id);

    const target = db.prepare('SELECT * FROM knowledge_entries WHERE id=?')
      .get(approved.target_knowledge_entry_id);
    assert.equal(target.entry_type, 'performance_review_methodology');
    assert.equal(target.source_type, 'organization_performance_methodology');
    assert.equal(target.business_type, 'organization');
    assert.equal(target.business_id, String(state.orgId));
    assert.equal(target.visibility, 'team');
    assert.equal(target.content, source.content);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM organization_knowledge_custody WHERE knowledge_entry_id=?').get(target.id).count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM campaign_record_links WHERE record_type='knowledge_entry' AND record_id=?").get(String(target.id)).count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM request_idempotency WHERE scope IN ('knowledge.methodology.request','knowledge.methodology.decide')").get().count, 2);
  } finally {
    db.close();
  }
});

test('bare platform support cannot request or approve organization methodology', () => {
  const db = openDatabase();
  try {
    const state = fixture(db);
    const source = writeApprovedSource(db, state);
    const service = createOrganizationMethodologyService(db);
    assert.throws(
      () => requestPromotion(service, state, source, { user: state.platformSupport, suffix: 'support-request' }),
      (error) => error && error.statusCode === 403 && error.code === 'ORGANIZATION_METHODOLOGY_FORBIDDEN'
    );
    const requested = requestPromotion(service, state, source);
    const auditView = service.listPromotions({
      user: state.platformSupport,
      campaignId: state.sourceCampaignId
    });
    assert.deepEqual(auditView.capabilities, {
      can_request: false,
      can_decide: false,
      support_audit: true
    });
    assert.equal(auditView.sources.length, 1);
    assert.equal(auditView.requests[0].promotion_request_id, requested.promotion_request_id);
    assert.equal(auditView.requests[0].can_decide, false);
    assert.equal(auditView.sources[0].can_request, false);
    assert.throws(
      () => decidePromotion(service, state, requested, { user: state.platformSupport, suffix: 'support-decision' }),
      (error) => error && error.statusCode === 403 && error.code === 'ORGANIZATION_METHODOLOGY_FORBIDDEN'
    );
  } finally {
    db.close();
  }
});

test('an organization administrator can reject a request without creating knowledge', () => {
  const db = openDatabase();
  try {
    const state = fixture(db);
    const service = createOrganizationMethodologyService(db);
    const source = writeApprovedSource(db, state, { sourceId: 'rejected-source' });
    const requested = requestPromotion(service, state, source, { suffix: 'rejected' });
    const rejected = decidePromotion(service, state, requested, {
      decision: 'rejected',
      reason: '结论适用范围不足，暂不晋升。',
      suffix: 'rejected'
    });

    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.target_knowledge_entry_id, null);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM knowledge_entries WHERE source_type='organization_performance_methodology'").get().count, 0);
    assert.equal(service.listPromotions({ user: state.firstApprover, campaignId: state.sourceCampaignId }).requests[0].status, 'rejected');
  } finally {
    db.close();
  }
});

test('normalized organization dimensions deduplicate equivalent methods and support supersession', () => {
  const db = openDatabase();
  try {
    const state = fixture(db);
    const service = createOrganizationMethodologyService(db);
    const firstSource = writeApprovedSource(db, state, { sourceId: 'same-1' });
    const secondSource = writeApprovedSource(db, state, { sourceId: 'same-2' });
    const first = decidePromotion(service, state, requestPromotion(service, state, firstSource, { suffix: 'same-1' }), { suffix: 'same-1' });
    const duplicateRequest = requestPromotion(service, state, secondSource, { suffix: 'same-2' });
    assert.equal(duplicateRequest.duplicate_target_knowledge_entry_id, first.target_knowledge_entry_id);
    const duplicate = decidePromotion(service, state, duplicateRequest, { suffix: 'same-2' });

    assert.equal(duplicate.status, 'deduplicated');
    assert.equal(duplicate.target_knowledge_entry_id, first.target_knowledge_entry_id);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM knowledge_entries WHERE source_type='organization_performance_methodology'").get().count, 1);

    const replacementSource = writeApprovedSource(db, state, {
      sourceId: 'replacement',
      content: '新版方法论：保留问题钩子，同时在前三秒加入场景证明。',
      title: '已确认项目复盘结论 v2',
      summary: '新版可复用方法'
    });
    const replacementRequest = requestPromotion(service, state, replacementSource, {
      suffix: 'replacement',
      supersedesKnowledgeEntryId: first.target_knowledge_entry_id
    });
    const replacement = decidePromotion(service, state, replacementRequest, { suffix: 'replacement' });
    const oldGovernance = db.prepare('SELECT * FROM knowledge_entry_governance WHERE knowledge_entry_id=?')
      .get(first.target_knowledge_entry_id);
    const newGovernance = db.prepare('SELECT * FROM knowledge_entry_governance WHERE knowledge_entry_id=?')
      .get(replacement.target_knowledge_entry_id);

    assert.equal(replacement.status, 'superseded');
    assert.equal(oldGovernance.is_current, 0);
    assert.equal(newGovernance.is_current, 1);
    assert.equal(newGovernance.lineage_root_entry_id, first.target_knowledge_entry_id);
    assert.equal(newGovernance.supersedes_entry_id, first.target_knowledge_entry_id);
    assert.equal(newGovernance.version_no, 2);
  } finally {
    db.close();
  }
});

test('organization methodology is available across its campaigns and hidden from another organization', () => {
  const db = openDatabase();
  try {
    const state = fixture(db);
    const source = writeApprovedSource(db, state, {
      sourceId: 'search-scope',
      content: '跨项目检索口令 methodology-scope-token'
    });
    const service = createOrganizationMethodologyService(db);
    const promoted = decidePromotion(
      service,
      state,
      requestPromotion(service, state, source, { suffix: 'search-scope' }),
      { suffix: 'search-scope' }
    );

    const sameOrg = knowledge.searchCampaignKnowledgeChunks(db, {
      user: state.secondApprover,
      campaignId: state.peerCampaignId,
      query: 'methodology-scope-token',
      entry_type: 'performance_review_methodology',
      source_types: ['performance_review_methodology', 'organization_performance_methodology'],
      quality_state: 'confirmed'
    });
    const otherOrg = knowledge.searchCampaignKnowledgeChunks(db, {
      user: state.otherOrgAdmin,
      campaignId: state.otherCampaignId,
      query: 'methodology-scope-token',
      entry_type: 'performance_review_methodology',
      source_types: ['performance_review_methodology', 'organization_performance_methodology'],
      quality_state: 'confirmed'
    });

    assert.ok(sameOrg.some((item) => item.record.entry.id === promoted.target_knowledge_entry_id));
    assert.equal(otherOrg.some((item) => item.record.entry.id === promoted.target_knowledge_entry_id), false);
  } finally {
    db.close();
  }
});

test('campaign RAG binds organization methodology to the campaign organization for multi-organization users', () => {
  const db = openDatabase();
  try {
    const state = fixture(db);
    db.prepare(`
      UPDATE organization_memberships
      SET role_code='org_admin'
      WHERE org_id=? AND user_id=5
    `).run(state.otherOrgId);
    const otherState = Object.assign({}, state, {
      orgId: state.otherOrgId,
      sourceCampaignId: state.otherCampaignId,
      firstApprover: state.otherOrgAdmin,
      secondApprover: { id: 5, role: 'user' }
    });
    const source = writeApprovedSource(db, otherState, {
      sourceId: 'multi-org-scope',
      content: '组织隔离检索口令 methodology-multi-org-token'
    });
    const service = createOrganizationMethodologyService(db);
    const promoted = decidePromotion(
      service,
      otherState,
      requestPromotion(service, otherState, source, { suffix: 'multi-org-scope' }),
      { suffix: 'multi-org-scope' }
    );

    db.prepare(`
      INSERT INTO organization_memberships (org_id,user_id,role_code,status)
      VALUES (?,3,'member','active')
    `).run(state.otherOrgId);
    db.prepare(`
      INSERT INTO team_memberships (org_id,team_id,user_id,role_code,status)
      VALUES (?,980201,3,'member','active')
    `).run(state.otherOrgId);

    const correctOrganization = knowledge.searchCampaignKnowledgeChunks(db, {
      user: state.secondApprover,
      campaignId: state.otherCampaignId,
      query: 'methodology-multi-org-token',
      entry_type: 'performance_review_methodology',
      source_types: ['performance_review_methodology', 'organization_performance_methodology'],
      quality_state: 'confirmed'
    });
    const wrongCampaignOrganization = knowledge.searchCampaignKnowledgeChunks(db, {
      user: state.secondApprover,
      campaignId: state.sourceCampaignId,
      query: 'methodology-multi-org-token',
      entry_type: 'performance_review_methodology',
      source_types: ['performance_review_methodology', 'organization_performance_methodology'],
      quality_state: 'confirmed'
    });

    assert.ok(correctOrganization.some((item) => item.record.entry.id === promoted.target_knowledge_entry_id));
    assert.equal(
      wrongCampaignOrganization.some((item) => item.record.entry.id === promoted.target_knowledge_entry_id),
      false
    );
  } finally {
    db.close();
  }
});

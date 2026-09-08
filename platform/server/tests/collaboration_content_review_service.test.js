'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const path = require('node:path');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const knowledgeService = require('../services/knowledge_service');
const { createCampaignCollaborationService } = require('../services/campaign_collaboration_service');

const SERVER_ROOT = path.resolve(__dirname, '..');
const MIGRATION_NAMES = Object.freeze([
  '002_campaign_business_spine',
  '003_campaign_workflow_dispatch_evidence',
  '004_knowledge_capacity_observability',
  '005_knowledge_custody_projection',
  '006_crm_sales_workspace',
  '007_knowledge_governance',
  '008_feishu_bitable_outbox',
  '009_feishu_bitable_retry_lineage',
  '010_performance_manual_foundation',
  '011_performance_feishu_connection_config',
  '012_performance_ai_review_audit',
  '013_customer_report_snapshot',
  '014_customer_report_ppt_artifact',
  '015_influencer_saved_views',
  '016_collaboration_contract_documents'
]);
const MIGRATIONS = Object.freeze(MIGRATION_NAMES.map((name, index) => Object.freeze({
  version: index + 2,
  name,
  sourcePath: `migrations/${name}.js`,
  engineVersion: 1,
  dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
})));

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function openDatabase(t) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  t.after(() => db.close());
  assert.deepEqual(migrationService.runMigrations(db, {
    rootDir: SERVER_ROOT,
    registeredMigrations: MIGRATIONS
  }), { status: 'managed', currentVersion: 16 });
  return db;
}

function v2Resource() {
  return {
    schema: 'turingmarket.collaboration-order.v2',
    project_name: 'Content review launch',
    product_name: 'Portable power station',
    order_type: 'paid',
    order_reference: 'PO-8191',
    deliverable: 'One dedicated video',
    creator_cost: 100,
    client_quote: 150,
    currency: 'USD',
    margin_amount: 50,
    payment_terms: 'net_30'
  };
}

function insertUser(db, id, username, displayName) {
  db.prepare(`
    INSERT INTO users (id,username,password_hash,display_name,role,api_quota,is_active)
    SELECT ?,?,password_hash,?,'user',50000,1
    FROM users
    WHERE id=(SELECT MIN(id) FROM users)
  `).run(id, username, displayName);
}

function seedFixture(db) {
  const orgId = db.prepare("SELECT id FROM organizations WHERE code='turingmarket-default'").get().id;
  const fixture = {
    orgId,
    ownerId: 819001,
    submitterId: 819002,
    outsiderId: 819003,
    teamId: 819004,
    customerId: 819005,
    opportunityId: 819006,
    campaignId: 819007,
    influencerId: 819008,
    collaborationId: 819009
  };
  insertUser(db, fixture.ownerId, 'content-review-owner', 'Review Owner');
  insertUser(db, fixture.submitterId, 'content-review-submitter', 'Review Submitter');
  insertUser(db, fixture.outsiderId, 'content-review-outsider', 'Review Outsider');
  db.prepare(`
    INSERT INTO organization_memberships (org_id,user_id,role_code,status)
    VALUES (?,?,'member','active'),(?,?,'member','active')
  `).run(orgId, fixture.ownerId, orgId, fixture.submitterId);
  db.prepare(`INSERT INTO teams (id,org_id,code,name) VALUES (?,?,'content-review','Content Review')`)
    .run(fixture.teamId, orgId);
  db.prepare(`
    INSERT INTO team_memberships (org_id,team_id,user_id,role_code,status)
    VALUES (?,?,?,'team_lead','active'),(?,?,?,'member','active')
  `).run(
    orgId, fixture.teamId, fixture.ownerId,
    orgId, fixture.teamId, fixture.submitterId
  );
  db.prepare(`
    INSERT INTO customers (id,brand_name,company_name,stage,source,created_by,assigned_to,is_public)
    VALUES (?,'Content Review Brand','Content Review Ltd','qualified','content-review-test',?,?,0)
  `).run(fixture.customerId, fixture.ownerId, fixture.ownerId);
  db.prepare(`
    INSERT INTO opportunities (id,customer_id,name,stage,value,win_probability,product_name,channel_type,created_by)
    VALUES (?,?,'Content review opportunity','proposal',1000,50,'Review product','influencer',?)
  `).run(fixture.opportunityId, fixture.customerId, fixture.ownerId);
  db.prepare(`
    INSERT INTO campaigns (
      id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,
      lifecycle_state,operational_status,row_version
    ) VALUES (?,?,'Content review campaign',?,?,?,?, 'executing','active',1)
  `).run(
    fixture.campaignId,
    orgId,
    fixture.customerId,
    fixture.opportunityId,
    fixture.ownerId,
    fixture.teamId
  );
  db.prepare(`
    INSERT INTO influencers (id,platform,kol_handle,profile_link,followers,is_active)
    VALUES (?,'TikTok','@content-review','https://example.invalid/content-review',1000,1)
  `).run(fixture.influencerId);
  db.prepare(`
    INSERT INTO collaborations (
      id,influencer_id,user_id,status,proposal_notes,cost_quoted,row_version
    ) VALUES (?,?,?,'live',?,100,4)
  `).run(
    fixture.collaborationId,
    fixture.influencerId,
    fixture.submitterId,
    JSON.stringify(v2Resource())
  );
  const bundleId = sha256('content-review-collaboration-bundle');
  const insertLink = db.prepare(`
    INSERT INTO campaign_record_links (
      org_id,campaign_id,record_type,bundle_id,record_id,relation_type,created_by,metadata_json
    ) VALUES (?,?,'collaboration',?,?,?,?,'{}')
  `);
  insertLink.run(orgId, fixture.campaignId, bundleId, String(fixture.collaborationId), 'order', fixture.submitterId);
  insertLink.run(orgId, fixture.campaignId, bundleId, String(fixture.collaborationId), 'execution', fixture.submitterId);
  return fixture;
}

function submissionInput(fixture, overrides = {}) {
  return {
    userId: fixture.submitterId,
    collaborationId: fixture.collaborationId,
    requestId: overrides.requestId || 'content-review-submit-request-0001',
    idempotencyKey: overrides.idempotencyKey || 'content-review-submit-0001',
    body: {
      campaign_id: fixture.campaignId,
      expected_version: 4,
      content_url: 'https://video.example.com/drafts/launch-v1',
      content_version: 'V1 client review',
      submission_note: 'Opening hook and product demo are ready for review.',
      ...(overrides.body || {})
    }
  };
}

function decisionInput(fixture, overrides = {}) {
  return {
    userId: fixture.ownerId,
    collaborationId: fixture.collaborationId,
    requestId: overrides.requestId || 'content-review-decision-request-0001',
    idempotencyKey: overrides.idempotencyKey || 'content-review-decision-0001',
    body: {
      campaign_id: fixture.campaignId,
      expected_version: 5,
      decision: 'approved',
      review_note: 'Hook, claims, CTA, and brand safety are approved.',
      ...(overrides.body || {})
    }
  };
}

function reviewWriteState(db, fixture) {
  return {
    collaboration: db.prepare(`
      SELECT status,row_version,content_url
      FROM collaborations WHERE id=?
    `).get(fixture.collaborationId),
    evidence: db.prepare(`
      SELECT COUNT(*) AS count FROM knowledge_entries
      WHERE source_type='collaboration_content_review'
    `).get().count,
    links: db.prepare(`
      SELECT COUNT(*) AS count FROM campaign_record_links
      WHERE record_type='knowledge_entry'
        AND json_extract(metadata_json,'$.producer_type')='collaboration_content_review'
    `).get().count,
    events: db.prepare(`
      SELECT COUNT(*) AS count FROM campaign_events
      WHERE source='collaboration_link' AND event_type='link_attached'
        AND json_extract(metadata_json,'$.record_type')='knowledge_entry'
    `).get().count,
    reservations: db.prepare(`
      SELECT COUNT(*) AS count FROM request_idempotency
      WHERE scope='collaboration.update.linked'
    `).get().count
  };
}

test('content review submission and independent approval are replay-safe, RAG-excluded, and unlock v2 publication', (t) => {
  const db = openDatabase(t);
  const fixture = seedFixture(db);
  const service = createCampaignCollaborationService(db);
  const submitted = service.submitContentReview(submissionInput(fixture));

  assert.equal(submitted.status, 201);
  assert.equal(submitted.body.status, 'content_review');
  assert.equal(submitted.body.row_version, 5);
  assert.equal(submitted.body.content_review.status, 'pending');
  assert.equal(submitted.body.content_review.publication_ready, false);
  assert.equal(submitted.body.content_review.can_submit, false);
  assert.equal(submitted.body.content_review.can_decide, false);
  assert.equal(submitted.body.content_review.current_submission.content_version, 'V1 client review');
  assert.equal(submitted.body.content_review.current_submission.content_url, 'https://video.example.com/drafts/launch-v1');
  assert.deepEqual(service.submitContentReview(submissionInput(fixture)), submitted);

  const reviewEntry = db.prepare(`
    SELECT id,title,summary,content,metadata_json
    FROM knowledge_entries
    WHERE source_type='collaboration_content_review'
  `).get();
  assert.ok(reviewEntry);
  assert.equal(JSON.parse(reviewEntry.metadata_json).retrieval_eligible, false);
  assert.equal(knowledgeService.isKnowledgeAiRetrievable(db, reviewEntry.id), false);
  assert.doesNotMatch(`${reviewEntry.title}\n${reviewEntry.summary}\n${reviewEntry.content}`, /video\.example\.com|Opening hook/);

  const approved = service.decideContentReview(decisionInput(fixture));
  assert.equal(approved.status, 201);
  assert.equal(approved.body.status, 'content_review');
  assert.equal(approved.body.row_version, 6);
  assert.equal(approved.body.content_review.status, 'approved');
  assert.equal(approved.body.content_review.publication_ready, true);
  assert.equal(approved.body.content_review.can_submit, false);
  assert.equal(approved.body.content_review.can_decide, false);
  assert.equal(approved.body.content_review.latest_decision.reviewed_by_name, 'Review Owner');
  assert.deepEqual(service.decideContentReview(decisionInput(fixture)), approved);

  const published = service.updateLinked({
    userId: fixture.submitterId,
    collaborationId: fixture.collaborationId,
    requestId: 'content-review-publish-request-0001',
    idempotencyKey: 'content-review-publish-0001',
    body: {
      campaign_id: fixture.campaignId,
      expected_version: 6,
      reason: 'Approved content URL was verified as published.',
      status: 'completed',
      campaign_relation: 'publication'
    }
  });
  assert.equal(published.body.row_version, 7);
  assert.deepEqual(published.body.active_relations, ['order', 'execution', 'publication']);
});

test('changes requested returns v2 execution to live and the next submission requires a new approval', (t) => {
  const db = openDatabase(t);
  const fixture = seedFixture(db);
  const service = createCampaignCollaborationService(db);
  service.submitContentReview(submissionInput(fixture));
  const rejected = service.decideContentReview(decisionInput(fixture, {
    idempotencyKey: 'content-review-changes-0001',
    body: {
      decision: 'changes_requested',
      review_note: 'Replace the unsupported performance claim and resubmit.'
    }
  }));
  assert.equal(rejected.body.status, 'live');
  assert.equal(rejected.body.row_version, 6);
  assert.equal(rejected.body.content_review.status, 'changes_requested');
  assert.equal(rejected.body.content_review.publication_ready, false);

  const resubmitted = service.submitContentReview(submissionInput(fixture, {
    requestId: 'content-review-resubmit-request-0002',
    idempotencyKey: 'content-review-resubmit-0002',
    body: {
      expected_version: 6,
      content_url: 'https://video.example.com/drafts/launch-v2',
      content_version: 'V2 claims corrected',
      submission_note: 'Performance claim removed and CTA tightened.'
    }
  }));
  assert.equal(resubmitted.body.row_version, 7);
  assert.equal(resubmitted.body.content_review.status, 'pending');
  assert.equal(resubmitted.body.content_review.events.length, 3);

  assert.throws(
    () => service.updateLinked({
      userId: fixture.submitterId,
      collaborationId: fixture.collaborationId,
      requestId: 'content-review-premature-publish',
      idempotencyKey: 'content-review-premature-publish-0001',
      body: {
        campaign_id: fixture.campaignId,
        expected_version: 7,
        reason: 'Attempt publication before the latest approval.',
        status: 'completed',
        campaign_relation: 'publication'
      }
    }),
    (error) => error && error.code === 'CONTENT_REVIEW_REQUIRED'
  );
  assert.equal(service.listContentReviews({
    userId: fixture.ownerId,
    collaborationId: fixture.collaborationId
  }).content_review.can_decide, true);
});

test('content review history supports more than forty immutable events without locking the workflow', (t) => {
  const db = openDatabase(t);
  const fixture = seedFixture(db);
  const service = createCampaignCollaborationService(db);
  let rowVersion = 4;

  for (let cycle = 1; cycle <= 21; cycle += 1) {
    const submitted = service.submitContentReview(submissionInput(fixture, {
      requestId: `content-review-long-submit-request-${cycle}`,
      idempotencyKey: `content-review-long-submit-${cycle}`,
      body: {
        expected_version: rowVersion,
        content_url: `https://video.example.com/drafts/long-review-v${cycle}`,
        content_version: `Long review V${cycle}`,
        submission_note: `Long review submission ${cycle}.`
      }
    }));
    rowVersion = submitted.body.row_version;
    if (cycle === 21) break;
    const changes = service.decideContentReview(decisionInput(fixture, {
      requestId: `content-review-long-decision-request-${cycle}`,
      idempotencyKey: `content-review-long-decision-${cycle}`,
      body: {
        expected_version: rowVersion,
        decision: 'changes_requested',
        review_note: `Long review change request ${cycle}.`
      }
    }));
    rowVersion = changes.body.row_version;
  }

  const pending = service.listContentReviews({
    userId: fixture.ownerId,
    collaborationId: fixture.collaborationId
  });
  assert.equal(pending.content_review.events.length, 41);
  assert.equal(pending.content_review.status, 'pending');
  assert.equal(pending.content_review.can_decide, true);

  const approved = service.decideContentReview(decisionInput(fixture, {
    requestId: 'content-review-long-approval-request',
    idempotencyKey: 'content-review-long-approval',
    body: {
      expected_version: rowVersion,
      decision: 'approved',
      review_note: 'The twenty-first revision is approved.'
    }
  }));
  assert.equal(approved.body.content_review.events.length, 42);
  assert.equal(approved.body.content_review.publication_ready, true);
});

test('historical completed v2 execution can enter the evidence-backed review recovery path', (t) => {
  const db = openDatabase(t);
  const fixture = seedFixture(db);
  db.prepare("UPDATE collaborations SET status='completed' WHERE id=?")
    .run(fixture.collaborationId);
  const service = createCampaignCollaborationService(db);

  const before = service.listContentReviews({
    userId: fixture.submitterId,
    collaborationId: fixture.collaborationId
  });
  assert.equal(before.content_review.status, 'not_submitted');
  assert.equal(before.content_review.can_submit, true);

  const submitted = service.submitContentReview(submissionInput(fixture, {
    idempotencyKey: 'content-review-historical-submit',
    body: { expected_version: before.row_version }
  }));
  assert.equal(submitted.body.status, 'content_review');
  assert.equal(submitted.body.content_review.status, 'pending');
});

test('content review rejects malformed, stale, self-reviewed, unauthorized, and out-of-order writes atomically', (t) => {
  const db = openDatabase(t);
  const fixture = seedFixture(db);
  const service = createCampaignCollaborationService(db);
  const baseline = reviewWriteState(db, fixture);

  for (const [index, body] of [
    { content_url: 'http://video.example.com/draft' },
    { content_url: 'https://user:secret@video.example.com/draft' },
    { content_version: '' },
    { submission_note: '' },
    { expected_version: 3 },
    { unexpected: true }
  ].entries()) {
    assert.throws(
      () => service.submitContentReview(submissionInput(fixture, {
        idempotencyKey: `content-review-invalid-000${index}`,
        body
      })),
      (error) => error && ['INVALID_CONTENT_REVIEW', 'STALE_COLLABORATION_VERSION', 'INVALID_CAMPAIGN_INPUT'].includes(error.code)
    );
    assert.deepEqual(reviewWriteState(db, fixture), baseline);
  }
  assert.throws(
    () => service.submitContentReview({
      ...submissionInput(fixture, { idempotencyKey: 'content-review-outsider-0001' }),
      userId: fixture.outsiderId
    }),
    (error) => error && error.code === 'RECORD_NOT_FOUND'
  );
  assert.deepEqual(reviewWriteState(db, fixture), baseline);

  const ownerSubmission = service.submitContentReview({
    ...submissionInput(fixture),
    userId: fixture.ownerId,
    idempotencyKey: 'content-review-owner-submit-0001'
  });
  assert.equal(ownerSubmission.body.row_version, 5);
  const beforeSelfReview = reviewWriteState(db, fixture);
  assert.throws(
    () => service.decideContentReview(decisionInput(fixture, {
      userId: fixture.ownerId,
      idempotencyKey: 'content-review-self-decision-0001'
    })),
    (error) => error && error.code === 'CONTENT_REVIEW_SELF_APPROVAL'
  );
  assert.deepEqual(reviewWriteState(db, fixture), beforeSelfReview);
});

test('content review rolls back collaboration, evidence, links, events, and idempotency when evidence storage fails', (t) => {
  const db = openDatabase(t);
  const fixture = seedFixture(db);
  const service = createCampaignCollaborationService(db);
  db.exec(`
    CREATE TEMP TRIGGER fail_content_review_evidence
    BEFORE INSERT ON knowledge_entries
    WHEN NEW.source_type='collaboration_content_review'
    BEGIN SELECT RAISE(ABORT,'forced content review evidence failure'); END;
  `);
  const before = reviewWriteState(db, fixture);
  assert.throws(
    () => service.submitContentReview(submissionInput(fixture)),
    /forced content review evidence failure/
  );
  assert.deepEqual(reviewWriteState(db, fixture), before);
});

test('content review evidence tampering fails closed before list or publication', (t) => {
  const db = openDatabase(t);
  const fixture = seedFixture(db);
  const service = createCampaignCollaborationService(db);
  service.submitContentReview(submissionInput(fixture));
  service.decideContentReview(decisionInput(fixture));
  const decision = db.prepare(`
    SELECT id,metadata_json FROM knowledge_entries
    WHERE source_type='collaboration_content_review'
    ORDER BY id DESC LIMIT 1
  `).get();
  const metadata = JSON.parse(decision.metadata_json);
  metadata.content_url_sha256 = '0'.repeat(64);
  // Simulate storage corruption after bypassing the normal payload-accounting trigger.
  db.exec('DROP TRIGGER campaign_knowledge_entry_content_immutable');
  db.exec('DROP TRIGGER trg_task7_knowledge_entry_payload_update');
  db.prepare('UPDATE knowledge_entries SET metadata_json=? WHERE id=?')
    .run(JSON.stringify(metadata), decision.id);

  assert.throws(
    () => service.listContentReviews({
      userId: fixture.ownerId,
      collaborationId: fixture.collaborationId
    }),
    (error) => error && error.code === 'CAMPAIGN_EVIDENCE_IN_USE'
  );
  assert.throws(
    () => service.updateLinked({
      userId: fixture.submitterId,
      collaborationId: fixture.collaborationId,
      requestId: 'content-review-tampered-publish',
      idempotencyKey: 'content-review-tampered-publish-0001',
      body: {
        campaign_id: fixture.campaignId,
        expected_version: 6,
        reason: 'Tampered evidence must not unlock publication.',
        status: 'completed',
        campaign_relation: 'publication'
      }
    }),
    (error) => error && error.code === 'CAMPAIGN_EVIDENCE_IN_USE'
  );
});

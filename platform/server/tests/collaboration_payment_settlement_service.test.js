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

function insertUser(db, id, username, displayName) {
  db.prepare(`
    INSERT INTO users (id,username,password_hash,display_name,role,api_quota,is_active)
    SELECT ?,?,password_hash,?,'user',50000,1
    FROM users
    WHERE id=(SELECT MIN(id) FROM users)
  `).run(id, username, displayName);
}

function v2Resource() {
  return {
    schema: 'turingmarket.collaboration-order.v2',
    project_name: 'Payment checkpoint launch',
    product_name: 'Portable power station',
    order_type: 'paid',
    order_reference: 'PO-8201',
    deliverable: 'One dedicated video',
    creator_cost: 100,
    client_quote: 150,
    currency: 'USD',
    margin_amount: 50,
    payment_terms: 'net_30'
  };
}

function seedFixture(db) {
  const orgId = db.prepare("SELECT id FROM organizations WHERE code='turingmarket-default'").get().id;
  const fixture = {
    orgId,
    ownerId: 820001,
    operatorId: 820002,
    outsiderId: 820003,
    teamId: 820004,
    customerId: 820005,
    opportunityId: 820006,
    campaignId: 820007,
    influencerId: 820008,
    collaborationId: 820009
  };
  insertUser(db, fixture.ownerId, 'payment-owner', 'Payment Owner');
  insertUser(db, fixture.operatorId, 'payment-operator', 'Payment Operator');
  insertUser(db, fixture.outsiderId, 'payment-outsider', 'Payment Outsider');
  db.prepare(`
    INSERT INTO organization_memberships (org_id,user_id,role_code,status)
    VALUES (?,?,'member','active'),(?,?,'member','active')
  `).run(orgId, fixture.ownerId, orgId, fixture.operatorId);
  db.prepare(`INSERT INTO teams (id,org_id,code,name) VALUES (?,?,'payment-checkpoint','Payment Checkpoint')`)
    .run(fixture.teamId, orgId);
  db.prepare(`
    INSERT INTO team_memberships (org_id,team_id,user_id,role_code,status)
    VALUES (?,?,?,'team_lead','active'),(?,?,?,'member','active')
  `).run(
    orgId, fixture.teamId, fixture.ownerId,
    orgId, fixture.teamId, fixture.operatorId
  );
  db.prepare(`
    INSERT INTO customers (id,brand_name,company_name,stage,source,created_by,assigned_to,is_public)
    VALUES (?,'Payment Brand','Payment Ltd','qualified','payment-test',?,?,0)
  `).run(fixture.customerId, fixture.ownerId, fixture.ownerId);
  db.prepare(`
    INSERT INTO opportunities (id,customer_id,name,stage,value,win_probability,product_name,channel_type,created_by)
    VALUES (?,?,'Payment opportunity','proposal',1000,50,'Payment product','influencer',?)
  `).run(fixture.opportunityId, fixture.customerId, fixture.ownerId);
  db.prepare(`
    INSERT INTO campaigns (
      id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,
      lifecycle_state,operational_status,row_version
    ) VALUES (?,?,'Payment campaign',?,?,?,?, 'ordered','active',1)
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
    VALUES (?,'TikTok','@payment-checkpoint','https://example.invalid/payment-checkpoint',1000,1)
  `).run(fixture.influencerId);
  db.prepare(`
    INSERT INTO collaborations (
      id,influencer_id,user_id,status,proposal_notes,cost_quoted,row_version
    ) VALUES (?,?,?,'contract_sent',?,100,1)
  `).run(
    fixture.collaborationId,
    fixture.influencerId,
    fixture.operatorId,
    JSON.stringify(v2Resource())
  );
  db.prepare(`
    INSERT INTO campaign_record_links (
      org_id,campaign_id,record_type,bundle_id,record_id,relation_type,created_by,metadata_json
    ) VALUES (?,?,'collaboration',?,?,'order',?,'{}')
  `).run(
    orgId,
    fixture.campaignId,
    sha256('payment-checkpoint-bundle'),
    String(fixture.collaborationId),
    fixture.operatorId
  );
  return fixture;
}

function signContract(service, fixture) {
  const bytes = Buffer.from('%PDF-1.7\n1 0 obj\n(Signed payment contract)\nendobj\n%%EOF\n', 'utf8');
  const document = service.uploadContractDocument({
    userId: fixture.operatorId,
    collaborationId: fixture.collaborationId,
    requestId: 'payment-contract-upload-request-0001',
    idempotencyKey: 'payment-contract-upload-0001',
    body: {
      campaign_id: fixture.campaignId,
      expected_version: 1,
      filename: 'signed-payment-contract.pdf',
      media_type: 'application/pdf',
      content_base64: bytes.toString('base64')
    }
  }).body.document;
  return service.confirmContract({
    userId: fixture.operatorId,
    collaborationId: fixture.collaborationId,
    requestId: 'payment-contract-confirm-request-0001',
    idempotencyKey: 'payment-contract-confirm-0001',
    body: {
      campaign_id: fixture.campaignId,
      expected_version: 1,
      contract_document_id: document.id,
      contract_reference: 'SIGNED-8201',
      counterparty_name: 'Creator Studio LLC',
      signed_at: '2026-09-08T10:00:00.000Z',
      confirmation_note: 'Signed contract verified before financial evidence.'
    }
  });
}

function recordInput(fixture, expectedVersion, direction, amount, reference, overrides = {}) {
  return {
    userId: overrides.userId || fixture.operatorId,
    collaborationId: fixture.collaborationId,
    requestId: overrides.requestId || `payment-record-${reference}-request`,
    idempotencyKey: overrides.idempotencyKey || `payment-record-${reference}`,
    body: {
      campaign_id: fixture.campaignId,
      expected_version: expectedVersion,
      direction,
      amount,
      paid_at: '2026-09-08T12:00:00.000Z',
      payment_method: 'bank_transfer',
      payment_reference: reference,
      counterparty_name: direction === 'creator_payment' ? 'Creator Studio LLC' : 'Payment Brand',
      tranche: amount === 40 ? 'deposit' : amount === 60 ? 'balance' : 'full',
      payment_note: direction === 'creator_payment' ? 'Creator payment verified.' : 'Client receipt verified.',
      ...(overrides.body || {})
    }
  };
}

test('manual receipts and creator payments require independent approval and settle the exact active digest', (t) => {
  const db = openDatabase(t);
  const fixture = seedFixture(db);
  const service = createCampaignCollaborationService(db);
  assert.equal(signContract(service, fixture).body.row_version, 2);

  const receiptInput = recordInput(fixture, 2, 'client_receipt', 150, 'CLIENT-RECEIPT-8201');
  const receipt = service.recordPayment(receiptInput);
  assert.equal(receipt.status, 201);
  assert.equal(receipt.body.row_version, 3);
  assert.equal(receipt.body.payment_settlement.client_receipt_total, 150);
  assert.equal(receipt.body.payment_settlement.creator_payment_total, 0);
  assert.equal(receipt.body.payment_settlement.status, 'recording');
  assert.deepEqual(service.recordPayment(receiptInput), receipt);

  const deposit = service.recordPayment(recordInput(
    fixture,
    3,
    'creator_payment',
    40,
    'CREATOR-DEPOSIT-8201'
  ));
  assert.equal(deposit.body.payment_settlement.creator_payment_remaining, 60);

  const execution = service.updateLinked({
    userId: fixture.operatorId,
    collaborationId: fixture.collaborationId,
    requestId: 'payment-execution-request-0001',
    idempotencyKey: 'payment-execution-0001',
    body: {
      campaign_id: fixture.campaignId,
      expected_version: 4,
      reason: 'Signed order moved into execution.',
      status: 'live',
      campaign_relation: 'execution'
    }
  });
  const submittedReview = service.submitContentReview({
    userId: fixture.operatorId,
    collaborationId: fixture.collaborationId,
    requestId: 'payment-content-submit-request-0001',
    idempotencyKey: 'payment-content-submit-0001',
    body: {
      campaign_id: fixture.campaignId,
      expected_version: execution.body.row_version,
      content_url: 'https://video.example.com/payment-checkpoint-v1',
      content_version: 'Payment checkpoint V1',
      submission_note: 'Final creator video submitted for review.'
    }
  });
  const approvedReview = service.decideContentReview({
    userId: fixture.ownerId,
    collaborationId: fixture.collaborationId,
    requestId: 'payment-content-decision-request-0001',
    idempotencyKey: 'payment-content-decision-0001',
    body: {
      campaign_id: fixture.campaignId,
      expected_version: submittedReview.body.row_version,
      decision: 'approved',
      review_note: 'Content is approved for publication.'
    }
  });
  const publication = service.updateLinked({
    userId: fixture.operatorId,
    collaborationId: fixture.collaborationId,
    requestId: 'payment-publication-request-0001',
    idempotencyKey: 'payment-publication-0001',
    body: {
      campaign_id: fixture.campaignId,
      expected_version: approvedReview.body.row_version,
      reason: 'Approved creator video was published.',
      status: 'completed',
      campaign_relation: 'publication'
    }
  });

  const balance = service.recordPayment(recordInput(
    fixture,
    publication.body.row_version,
    'creator_payment',
    60,
    'CREATOR-BALANCE-8201'
  ));
  assert.equal(balance.body.payment_settlement.status, 'ready');
  assert.equal(balance.body.payment_settlement.creator_payment_total, 100);
  assert.equal(balance.body.payment_settlement.client_receipt_total, 150);
  assert.equal(balance.body.payment_settlement.active_entry_count, 3);

  const settlementInput = {
    userId: fixture.operatorId,
    collaborationId: fixture.collaborationId,
    requestId: 'payment-settlement-submit-request-0001',
    idempotencyKey: 'payment-settlement-submit-0001',
    body: {
      campaign_id: fixture.campaignId,
      expected_version: balance.body.row_version,
      settlement_note: 'Client receipt and creator payments reconciled to the signed order.'
    }
  };
  const submitted = service.submitSettlement(settlementInput);
  assert.equal(submitted.status, 201);
  assert.equal(submitted.body.payment_settlement.status, 'pending_review');
  assert.match(submitted.body.payment_settlement.current_submission.payment_digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(service.submitSettlement(settlementInput), submitted);

  assert.throws(
    () => service.decideSettlement({
      userId: fixture.operatorId,
      collaborationId: fixture.collaborationId,
      requestId: 'payment-settlement-self-review-request-0001',
      idempotencyKey: 'payment-settlement-self-review-0001',
      body: {
        campaign_id: fixture.campaignId,
        expected_version: submitted.body.row_version,
        submission_entry_id: submitted.body.payment_settlement.current_submission.id,
        decision: 'approved',
        review_note: 'Self approval must be rejected.'
      }
    }),
    (error) => error && error.code === 'SETTLEMENT_INDEPENDENT_REVIEW_REQUIRED'
  );

  const approved = service.decideSettlement({
    userId: fixture.ownerId,
    collaborationId: fixture.collaborationId,
    requestId: 'payment-settlement-approve-request-0001',
    idempotencyKey: 'payment-settlement-approve-0001',
    body: {
      campaign_id: fixture.campaignId,
      expected_version: submitted.body.row_version,
      submission_entry_id: submitted.body.payment_settlement.current_submission.id,
      decision: 'approved',
      review_note: 'Payment digest, order terms, and variances independently verified.'
    }
  });
  assert.equal(approved.status, 201);
  assert.equal(approved.body.payment_settlement.status, 'settled');
  assert.deepEqual(approved.body.active_relations, ['order', 'execution', 'publication', 'settlement']);
  const persisted = db.prepare(`
    SELECT cost_actual,cost_actual_confirmed,row_version
    FROM collaborations WHERE id=?
  `).get(fixture.collaborationId);
  assert.deepEqual(persisted, { cost_actual: 100, cost_actual_confirmed: 1, row_version: approved.body.row_version });

  const evidence = db.prepare(`
    SELECT id,title,summary,content,metadata_json
    FROM knowledge_entries
    WHERE source_type='collaboration_payment_settlement'
    ORDER BY id
  `).all();
  assert.equal(evidence.length, 5);
  evidence.forEach((entry) => {
    assert.equal(JSON.parse(entry.metadata_json).retrieval_eligible, false);
    assert.equal(knowledgeService.isKnowledgeAiRetrievable(db, entry.id), false);
    assert.doesNotMatch(`${entry.title}\n${entry.summary}\n${entry.content}`, /CLIENT-RECEIPT|CREATOR-DEPOSIT|Creator Studio|Payment Brand/);
  });
});

test('payment corrections append a void event and reject duplicate active references', (t) => {
  const db = openDatabase(t);
  const fixture = seedFixture(db);
  const service = createCampaignCollaborationService(db);
  signContract(service, fixture);
  const recorded = service.recordPayment(recordInput(
    fixture,
    2,
    'creator_payment',
    40,
    'CREATOR-CORRECTION-8201'
  ));
  const paymentEntry = recorded.body.payment_settlement.entries.find((entry) => entry.status === 'active');
  assert.ok(paymentEntry);

  const voided = service.voidPayment({
    userId: fixture.operatorId,
    collaborationId: fixture.collaborationId,
    paymentId: paymentEntry.id,
    requestId: 'payment-void-request-0001',
    idempotencyKey: 'payment-void-0001',
    body: {
      campaign_id: fixture.campaignId,
      expected_version: 3,
      void_reason: 'Bank reference was attached to the wrong tranche.'
    }
  });
  assert.equal(voided.body.row_version, 4);
  assert.equal(voided.body.payment_settlement.creator_payment_total, 0);
  assert.equal(voided.body.payment_settlement.entries[0].status, 'voided');
  assert.equal(voided.body.payment_settlement.entries[0].voided_by, fixture.operatorId);

  const replacementInput = recordInput(
    fixture,
    4,
    'creator_payment',
    40,
    'CREATOR-CORRECTION-8201',
    { idempotencyKey: 'payment-replacement-0001', requestId: 'payment-replacement-request-0001' }
  );
  const replacement = service.recordPayment(replacementInput);
  assert.equal(replacement.body.payment_settlement.creator_payment_total, 40);
  assert.equal(replacement.body.payment_settlement.active_entry_count, 1);

  assert.throws(
    () => service.recordPayment(recordInput(
      fixture,
      replacement.body.row_version,
      'creator_payment',
      40,
      'CREATOR-CORRECTION-8201',
      { idempotencyKey: 'payment-duplicate-reference-0001' }
    )),
    (error) => error && error.code === 'PAYMENT_EVIDENCE_EXISTS'
  );
  assert.throws(
    () => service.listPayments({
      userId: fixture.outsiderId,
      collaborationId: fixture.collaborationId
    }),
    (error) => error && error.code === 'RECORD_NOT_FOUND'
  );
});

test('campaign-linked v2 orders cannot bypass the financial checkpoint through the legacy settlement patch', (t) => {
  const db = openDatabase(t);
  const fixture = seedFixture(db);
  const service = createCampaignCollaborationService(db);
  signContract(service, fixture);
  const bundleId = db.prepare(`
    SELECT bundle_id FROM campaign_record_links
    WHERE campaign_id=? AND record_type='collaboration' AND record_id=? AND relation_type='order'
  `).get(fixture.campaignId, String(fixture.collaborationId)).bundle_id;
  const insertRelation = db.prepare(`
    INSERT INTO campaign_record_links (
      org_id,campaign_id,record_type,bundle_id,record_id,relation_type,created_by,metadata_json
    ) VALUES (?,?,'collaboration',?,?,?,?,?)
  `);
  insertRelation.run(
    fixture.orgId,
    fixture.campaignId,
    bundleId,
    String(fixture.collaborationId),
    'execution',
    fixture.operatorId,
    '{}'
  );
  db.prepare("UPDATE collaborations SET status='completed' WHERE id=?")
    .run(fixture.collaborationId);
  insertRelation.run(
    fixture.orgId,
    fixture.campaignId,
    bundleId,
    String(fixture.collaborationId),
    'publication',
    fixture.operatorId,
    JSON.stringify({
      confirmed_by: fixture.operatorId,
      confirmed_at: db.prepare('SELECT CURRENT_TIMESTAMP AS now').get().now
    })
  );
  const before = db.prepare('SELECT cost_actual,cost_actual_confirmed,row_version FROM collaborations WHERE id=?')
    .get(fixture.collaborationId);

  assert.throws(
    () => service.updateLinked({
      userId: fixture.operatorId,
      collaborationId: fixture.collaborationId,
      requestId: 'payment-legacy-settlement-request-0001',
      idempotencyKey: 'payment-legacy-settlement-0001',
      body: {
        campaign_id: fixture.campaignId,
        expected_version: before.row_version,
        reason: 'Attempt to bypass the financial checkpoint.',
        status: 'completed',
        campaign_relation: 'settlement',
        cost_actual: 100,
        confirm_cost_actual: true
      }
    }),
    (error) => error && error.code === 'SETTLEMENT_CHECKPOINT_REQUIRED'
  );
  assert.deepEqual(
    db.prepare('SELECT cost_actual,cost_actual_confirmed,row_version FROM collaborations WHERE id=?')
      .get(fixture.collaborationId),
    before
  );
});

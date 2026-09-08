'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const zlib = require('node:zlib');
const path = require('node:path');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const knowledgeService = require('../services/knowledge_service');
const ragService = require('../services/rag_service');
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
    project_name: 'Contract custody launch',
    product_name: 'Portable power station',
    order_type: 'paid',
    order_reference: 'PO-8161',
    deliverable: 'One dedicated video',
    creator_cost: 100,
    client_quote: 150,
    currency: 'USD',
    margin_amount: 50,
    payment_terms: 'net_30'
  };
}

function seedFixture(db) {
  const identity = db.prepare(`
    SELECT organization.id AS orgId,user.id AS userId,team_membership.team_id AS teamId
    FROM organizations organization
    JOIN organization_memberships membership
      ON membership.org_id=organization.id AND membership.status='active'
    JOIN users user ON user.id=membership.user_id AND user.is_active=1 AND user.role<>'admin'
    JOIN team_memberships team_membership
      ON team_membership.org_id=organization.id
     AND team_membership.user_id=user.id
     AND team_membership.status='active'
    WHERE organization.code='turingmarket-default'
    ORDER BY user.id,team_membership.team_id
    LIMIT 1
  `).get();
  assert.ok(identity);
  const fixture = {
    ...identity,
    customerId: 826001,
    opportunityId: 826002,
    campaignId: 826003,
    influencerId: 826004,
    collaborationId: 826005
  };
  db.prepare(`
    INSERT INTO customers (id,brand_name,company_name,stage,source,created_by,assigned_to,is_public)
    VALUES (@customerId,'Contract service customer','Contract service Ltd','qualified','contract-service-test',@userId,@userId,0)
  `).run(fixture);
  db.prepare(`
    INSERT INTO opportunities (id,customer_id,name,stage,value,win_probability,product_name,channel_type,created_by)
    VALUES (@opportunityId,@customerId,'Contract service opportunity','proposal',1000,50,'Contract product','influencer',@userId)
  `).run(fixture);
  db.prepare(`
    INSERT INTO campaigns (
      id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,lifecycle_state,operational_status,row_version
    ) VALUES (
      @campaignId,@orgId,'Contract service campaign',@customerId,@opportunityId,@userId,@teamId,'ordered','active',1
    )
  `).run(fixture);
  db.prepare(`
    INSERT INTO influencers (id,platform,kol_handle,profile_link,followers,is_active)
    VALUES (@influencerId,'TikTok','@contract-service','https://example.invalid/contract-service',1000,1)
  `).run(fixture);
  db.prepare(`
    INSERT INTO collaborations (
      id,influencer_id,user_id,status,proposal_notes,cost_quoted,row_version
    ) VALUES (
      @collaborationId,@influencerId,@userId,'contract_sent',@proposalNotes,100,1
    )
  `).run({ ...fixture, proposalNotes: JSON.stringify(v2Resource()) });
  db.prepare(`
    INSERT INTO campaign_record_links (
      org_id,campaign_id,record_type,bundle_id,record_id,relation_type,created_by,metadata_json
    ) VALUES (@orgId,@campaignId,'collaboration',@bundleId,@recordId,'order',@userId,'{}')
  `).run({
    ...fixture,
    bundleId: sha256('contract-service-order-link'),
    recordId: String(fixture.collaborationId)
  });
  return fixture;
}

function pdfBytes(label = 'signed contract') {
  return Buffer.from(`%PDF-1.7\n1 0 obj\n(${label})\nendobj\n%%EOF\n`, 'utf8');
}

function compressedObjectStreamPdf() {
  const objectStream = zlib.deflateSync(Buffer.from('1 0 << /JavaScript 2 0 R >>', 'ascii'));
  return Buffer.concat([
    Buffer.from(`%PDF-1.7\n1 0 obj\n<< /Type /ObjStm /Filter /FlateDecode /Length ${objectStream.length} >>\nstream\n`, 'ascii'),
    objectStream,
    Buffer.from('\nendstream\nendobj\n%%EOF\n', 'ascii')
  ]);
}

function addCampaignReader(db, fixture) {
  const readerId = 826006;
  db.prepare(`
    INSERT INTO users (id,username,password_hash,display_name,role,api_quota,is_active)
    SELECT ?,?,password_hash,'Contract campaign reader','user',50000,1
    FROM users WHERE id=?
  `).run(readerId, 'contract-campaign-reader', fixture.userId);
  db.prepare(`
    INSERT INTO organization_memberships (org_id,user_id,role_code,status)
    VALUES (?,?,'member','active')
  `).run(fixture.orgId, readerId);
  db.prepare(`
    INSERT INTO team_memberships (org_id,team_id,user_id,role_code,status)
    VALUES (?,?,?,'member','active')
  `).run(fixture.orgId, fixture.teamId, readerId);
  return readerId;
}

function addContractOutsider(db, fixture) {
  const outsiderId = 826007;
  db.prepare(`
    INSERT INTO users (id,username,password_hash,display_name,role,api_quota,is_active)
    SELECT ?,?,password_hash,'Contract outsider','user',50000,1
    FROM users WHERE id=?
  `).run(outsiderId, 'contract-outsider', fixture.userId);
  return outsiderId;
}

function uploadInput(fixture, overrides = {}) {
  const bytes = overrides.bytes || pdfBytes();
  return {
    userId: fixture.userId,
    collaborationId: fixture.collaborationId,
    requestId: overrides.requestId || 'contract-document-upload-request-0001',
    idempotencyKey: overrides.idempotencyKey || 'contract-document-upload-0001',
    body: {
      campaign_id: fixture.campaignId,
      expected_version: 1,
      filename: 'signed-contract.pdf',
      media_type: 'application/pdf',
      content_base64: bytes.toString('base64'),
      ...(overrides.body || {})
    }
  };
}

test('contract PDF upload is idempotent, immutable, non-RAG evidence with authorized list and download', (t) => {
  const db = openDatabase(t);
  const fixture = seedFixture(db);
  const service = createCampaignCollaborationService(db);
  const input = uploadInput(fixture);

  const created = service.uploadContractDocument(input);
  assert.equal(created.status, 201);
  assert.equal(created.body.success, true);
  assert.equal(created.body.document.original_filename, 'signed-contract.pdf');
  assert.equal(created.body.document.media_type, 'application/pdf');
  assert.equal(created.body.document.file_sha256, sha256(pdfBytes()));
  assert.equal(created.body.document.file_bytes, pdfBytes().length);
  assert.equal(Object.hasOwn(created.body.document, 'document_blob'), false);
  assert.equal(Object.hasOwn(created.body.document, 'content_base64'), false);
  assert.deepEqual(service.uploadContractDocument(input), created);

  const listed = service.listContractDocuments({
    userId: fixture.userId,
    collaborationId: fixture.collaborationId
  });
  assert.deepEqual(listed.documents, [created.body.document]);
  const downloaded = service.downloadContractDocument({
    userId: fixture.userId,
    collaborationId: fixture.collaborationId,
    documentId: created.body.document.id
  });
  assert.deepEqual(downloaded.document, created.body.document);
  assert.deepEqual(downloaded.bytes, pdfBytes());

  const readerId = addCampaignReader(db, fixture);
  assert.deepEqual(service.listContractDocuments({
    userId: readerId,
    collaborationId: fixture.collaborationId
  }).documents, [created.body.document]);
  assert.deepEqual(service.downloadContractDocument({
    userId: readerId,
    collaborationId: fixture.collaborationId,
    documentId: created.body.document.id
  }).bytes, pdfBytes());

  const persisted = db.prepare(`
    SELECT document_blob,file_sha256,file_bytes,knowledge_entry_id
    FROM collaboration_contract_documents
    WHERE id=?
  `).get(created.body.document.id);
  assert.deepEqual(persisted.document_blob, pdfBytes());
  assert.equal(persisted.file_sha256, sha256(pdfBytes()));
  assert.equal(persisted.file_bytes, pdfBytes().length);
  const evidence = db.prepare('SELECT title,summary,content,metadata_json FROM knowledge_entries WHERE id=?')
    .get(persisted.knowledge_entry_id);
  assert.doesNotMatch(`${evidence.title}\n${evidence.summary}\n${evidence.content}`, /signed-contract\.pdf|signed contract/i);
  assert.deepEqual(JSON.parse(evidence.metadata_json), {
    schema_version: 1,
    collaboration_id: fixture.collaborationId,
    document_id: created.body.document.id,
    media_type: 'application/pdf',
    file_sha256: sha256(pdfBytes()),
    file_bytes: pdfBytes().length,
    original_filename: 'signed-contract.pdf',
    uploaded_by: fixture.userId,
    retrieval_eligible: false
  });
  const ragUser = { id: fixture.userId, role: 'user' };
  assert.deepEqual(knowledgeService.searchCampaignKnowledgeChunks(db, {
    query: 'contract document',
    user: ragUser,
    campaignId: fixture.campaignId
  }), []);
  assert.deepEqual(ragService.buildRagContext(db, {
    query: 'Campaign file evidence',
    user: ragUser
  }).references, []);
  assert.throws(
    () => db.prepare('DELETE FROM collaboration_contract_documents WHERE id=?').run(created.body.document.id),
    /append-only/
  );
});

test('contract PDF upload rejects malformed, active, duplicate, stale, hidden, and closed inputs without writes', (t) => {
  const db = openDatabase(t);
  const fixture = seedFixture(db);
  const service = createCampaignCollaborationService(db);
  const outsiderId = addContractOutsider(db, fixture);
  const baseline = () => db.prepare('SELECT COUNT(*) AS count FROM collaboration_contract_documents').get().count;

  for (const [index, body] of [
    { filename: '../signed-contract.pdf' },
    { media_type: 'text/html' },
    { content_base64: 'not canonical base64' },
    { content_base64: Buffer.from('%PDF-1.7\n/JavaScript\n%%EOF\n').toString('base64') },
    { content_base64: Buffer.from('%PDF-1.7\n/#4AavaScript\n%%EOF\n').toString('base64') },
    { content_base64: Buffer.from('%PDF-1.7\n/OpenAction 1 0 R\n%%EOF\n').toString('base64') },
    { content_base64: Buffer.from('%PDF-1.7\n/AA << /O 1 0 R >>\n%%EOF\n').toString('base64') },
    { content_base64: Buffer.from('%PDF-1.7\n/XFA 1 0 R\n%%EOF\n').toString('base64') },
    { content_base64: compressedObjectStreamPdf().toString('base64') },
    { content_base64: Buffer.from('%PDF-1.7\nmissing eof marker').toString('base64') }
  ].entries()) {
    assert.throws(
      () => service.uploadContractDocument(uploadInput(fixture, {
        idempotencyKey: `contract-document-invalid-000${index}`,
        body
      })),
      (error) => error && ['INVALID_CONTRACT_DOCUMENT', 'UNSAFE_CONTRACT_DOCUMENT'].includes(error.code)
    );
    assert.equal(baseline(), 0);
  }

  assert.throws(
    () => service.uploadContractDocument(uploadInput(fixture, {
      idempotencyKey: 'contract-document-stale-0001',
      body: { expected_version: 2 }
    })),
    (error) => error && error.code === 'STALE_COLLABORATION_VERSION'
  );
  assert.throws(
    () => service.uploadContractDocument({
      ...uploadInput(fixture, { idempotencyKey: 'contract-document-hidden-0001' }),
      userId: outsiderId
    }),
    (error) => error && error.code === 'RECORD_NOT_FOUND'
  );

  const created = service.uploadContractDocument(uploadInput(fixture));
  assert.equal(baseline(), 1);
  assert.throws(
    () => service.uploadContractDocument(uploadInput(fixture, {
      idempotencyKey: 'contract-document-duplicate-0001'
    })),
    (error) => error && error.code === 'CONTRACT_DOCUMENT_EXISTS'
  );
  assert.throws(
    () => service.listContractDocuments({ userId: outsiderId, collaborationId: fixture.collaborationId }),
    (error) => error && error.code === 'RECORD_NOT_FOUND'
  );
  assert.throws(
    () => service.downloadContractDocument({
      userId: fixture.userId,
      collaborationId: fixture.collaborationId,
      documentId: created.body.document.id + 1
    }),
    (error) => error && error.code === 'RECORD_NOT_FOUND'
  );
  db.prepare("UPDATE collaborations SET status='contracted' WHERE id=?").run(fixture.collaborationId);
  assert.throws(
    () => service.uploadContractDocument(uploadInput(fixture, {
      idempotencyKey: 'contract-document-closed-0001',
      body: { expected_version: 2, content_base64: pdfBytes('closed').toString('base64') }
    })),
    (error) => error && error.code === 'INVALID_COLLABORATION_TRANSITION'
  );
  assert.equal(baseline(), 1);
});

test('signed confirmation binds one same-campaign PDF and exposes immutable schema-v2 evidence', (t) => {
  const db = openDatabase(t);
  const fixture = seedFixture(db);
  const service = createCampaignCollaborationService(db);
  const uploaded = service.uploadContractDocument(uploadInput(fixture)).body.document;
  const confirmationInput = {
    userId: fixture.userId,
    collaborationId: fixture.collaborationId,
    requestId: 'contract-confirmation-document-request-0001',
    idempotencyKey: 'contract-confirmation-document-0001',
    body: {
      campaign_id: fixture.campaignId,
      expected_version: 1,
      contract_document_id: uploaded.id,
      contract_reference: 'SIGNED-8161',
      counterparty_name: 'Creator Studio LLC',
      signed_at: '2026-09-07T10:00:00.000Z',
      confirmation_note: 'Signed PDF verified in platform custody.'
    }
  };

  const confirmed = service.confirmContract(confirmationInput);
  assert.equal(confirmed.status, 201);
  assert.equal(confirmed.body.status, 'contracted');
  assert.equal(confirmed.body.contract_confirmation.document.id, uploaded.id);
  assert.equal(confirmed.body.contract_confirmation.document.file_sha256, uploaded.file_sha256);
  assert.deepEqual(service.confirmContract(confirmationInput), confirmed);
  const evidence = db.prepare(`
    SELECT metadata_json
    FROM knowledge_entries
    WHERE source_type='collaboration_contract_confirmation'
  `).get();
  const metadata = JSON.parse(evidence.metadata_json);
  assert.equal(metadata.schema_version, 2);
  assert.equal(metadata.contract_document_id, uploaded.id);
  assert.equal(metadata.contract_document_sha256, uploaded.file_sha256);
  assert.equal(metadata.retrieval_eligible, false);
});

test('signed confirmation requires a document owned by the same collaboration', (t) => {
  const db = openDatabase(t);
  const fixture = seedFixture(db);
  const service = createCampaignCollaborationService(db);
  const body = {
    campaign_id: fixture.campaignId,
    expected_version: 1,
    contract_reference: 'SIGNED-8161',
    counterparty_name: 'Creator Studio LLC',
    signed_at: '2026-09-07T10:00:00.000Z',
    confirmation_note: 'Signed PDF verified in platform custody.'
  };
  assert.throws(
    () => service.confirmContract({
      userId: fixture.userId,
      collaborationId: fixture.collaborationId,
      requestId: 'contract-confirmation-missing-document',
      idempotencyKey: 'contract-confirmation-missing-document-0001',
      body
    }),
    (error) => error && error.code === 'INVALID_CONTRACT_CONFIRMATION' && error.details.field === 'contract_document_id'
  );
  assert.throws(
    () => service.confirmContract({
      userId: fixture.userId,
      collaborationId: fixture.collaborationId,
      requestId: 'contract-confirmation-unknown-document',
      idempotencyKey: 'contract-confirmation-unknown-document-0001',
      body: { ...body, contract_document_id: 999999 }
    }),
    (error) => error && error.code === 'CONTRACT_DOCUMENT_REQUIRED'
  );
  assert.deepEqual(
    db.prepare('SELECT status,row_version FROM collaborations WHERE id=?').get(fixture.collaborationId),
    { status: 'contract_sent', row_version: 1 }
  );
});

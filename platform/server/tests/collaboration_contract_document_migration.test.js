'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const migration = require('../migrations/016_collaboration_contract_documents');

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

function openAtV15() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrationService.runMigrations(db, {
    rootDir: SERVER_ROOT,
    registeredMigrations: MIGRATIONS.slice(0, -1)
  });
  return db;
}

function upgradeToV16(db) {
  migrationService.runMigrations(db, {
    rootDir: SERVER_ROOT,
    registeredMigrations: MIGRATIONS
  });
}

function createFixture(db) {
  const identity = db.prepare(`
    SELECT organization.id AS orgId,user.id AS userId,team_membership.team_id AS teamId
    FROM organizations organization
    JOIN organization_memberships membership
      ON membership.org_id=organization.id AND membership.status='active'
    JOIN users user ON user.id=membership.user_id AND user.is_active=1
    JOIN team_memberships team_membership
      ON team_membership.org_id=organization.id
     AND team_membership.user_id=user.id
     AND team_membership.status='active'
    WHERE organization.code='turingmarket-default' AND user.role<>'admin'
    ORDER BY user.id,team_membership.team_id
    LIMIT 1
  `).get();
  assert.ok(identity, 'fixture requires an active organization member');
  const fixture = {
    ...identity,
    customerId: 816001,
    opportunityId: 816002,
    campaignId: 816003,
    influencerId: 816004,
    collaborationId: 816005,
    knowledgeEntryId: 816006
  };
  db.prepare(`
    INSERT INTO customers (id,brand_name,company_name,stage,source,created_by,assigned_to,is_public)
    VALUES (@customerId,'Contract customer','Contract customer Ltd','qualified','contract-test',@userId,@userId,0)
  `).run(fixture);
  db.prepare(`
    INSERT INTO opportunities (id,customer_id,name,stage,value,win_probability,product_name,channel_type,created_by)
    VALUES (@opportunityId,@customerId,'Contract opportunity','proposal',1000,50,'Contract product','influencer',@userId)
  `).run(fixture);
  db.prepare(`
    INSERT INTO campaigns (
      id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,lifecycle_state,operational_status,row_version
    ) VALUES (
      @campaignId,@orgId,'Contract campaign',@customerId,@opportunityId,@userId,@teamId,'ordered','active',1
    )
  `).run(fixture);
  db.prepare(`
    INSERT INTO influencers (id,platform,kol_handle,profile_link,followers,is_active)
    VALUES (@influencerId,'TikTok','@contract-fixture','https://example.invalid/contract-fixture',1000,1)
  `).run(fixture);
  db.prepare(`
    INSERT INTO collaborations (id,influencer_id,user_id,status,cost_quoted,row_version)
    VALUES (@collaborationId,@influencerId,@userId,'contract_sent',100,1)
  `).run(fixture);
  db.prepare(`
    INSERT INTO campaign_record_links (
      org_id,campaign_id,record_type,bundle_id,record_id,relation_type,created_by,metadata_json
    ) VALUES (@orgId,@campaignId,'collaboration',@bundleId,@recordId,'order',@userId,'{}')
  `).run({
    ...fixture,
    bundleId: sha256('contract-document-collaboration-link'),
    recordId: String(fixture.collaborationId)
  });
  db.prepare(`
    INSERT INTO knowledge_entries (
      id,entry_type,source_type,source_id,key_terms,content,created_by,is_public,
      title,summary,tags_json,visibility,business_type,business_id,metadata_json,
      source_identity_sha256,content_sha256
    ) VALUES (
      @knowledgeEntryId,'collaboration_contract_document','collaboration_contract_document','816007',
      'campaign collaboration contract','{"checkpoint":"contract_document"}',@userId,0,
      'Contract document evidence','Contract file uploaded','["contract-document"]','team',
      'campaign',@businessId,'{"schema_version":1,"retrieval_eligible":false}',
      @sourceIdentitySha256,@contentSha256
    )
  `).run({
    ...fixture,
    businessId: String(fixture.campaignId),
    sourceIdentitySha256: sha256('contract-document-source-identity'),
    contentSha256: sha256('{"checkpoint":"contract_document"}')
  });
  db.prepare(`
    INSERT INTO campaign_record_links (
      org_id,campaign_id,record_type,bundle_id,record_id,relation_type,created_by,metadata_json
    ) VALUES (@orgId,@campaignId,'knowledge_entry',@bundleId,@recordId,'knowledge',@userId,@metadata)
  `).run({
    ...fixture,
    bundleId: sha256('contract-document-knowledge-link'),
    recordId: String(fixture.knowledgeEntryId),
    metadata: JSON.stringify({
      producer_type: 'collaboration_contract_document',
      producer_id: fixture.collaborationId,
      source_type: 'collaboration_contract_document',
      source_id: '816007'
    })
  });
  return fixture;
}

function insertDocument(db, fixture, overrides = {}) {
  const documentId = overrides.id || 816007;
  let knowledgeEntryId = overrides.knowledgeEntryId || fixture.knowledgeEntryId;
  if (documentId !== 816007 && overrides.createEvidence !== false) {
    knowledgeEntryId = overrides.knowledgeEntryId || documentId + 1000;
    const content = '{"checkpoint":"contract_document"}';
    db.prepare(`
      INSERT INTO knowledge_entries (
        id,entry_type,source_type,source_id,key_terms,content,created_by,is_public,
        title,summary,tags_json,visibility,business_type,business_id,metadata_json,
        source_identity_sha256,content_sha256
      ) VALUES (
        @knowledgeEntryId,'collaboration_contract_document','collaboration_contract_document',@sourceId,
        'campaign collaboration contract',@content,@userId,0,
        'Contract document evidence','Contract file uploaded','["contract-document"]','team',
        'campaign',@businessId,'{"schema_version":1,"retrieval_eligible":false}',
        @sourceIdentitySha256,@contentSha256
      )
    `).run({
      ...fixture,
      knowledgeEntryId,
      sourceId: String(documentId),
      content,
      businessId: String(fixture.campaignId),
      sourceIdentitySha256: sha256(`contract-document-source-identity-${documentId}`),
      contentSha256: sha256(content)
    });
    db.prepare(`
      INSERT INTO campaign_record_links (
        org_id,campaign_id,record_type,bundle_id,record_id,relation_type,created_by,metadata_json
      ) VALUES (@orgId,@campaignId,'knowledge_entry',@bundleId,@recordId,'knowledge',@userId,@metadata)
    `).run({
      ...fixture,
      bundleId: sha256(`contract-document-knowledge-link-${documentId}`),
      recordId: String(knowledgeEntryId),
      metadata: JSON.stringify({
        producer_type: 'collaboration_contract_document',
        producer_id: fixture.collaborationId,
        source_type: 'collaboration_contract_document',
        source_id: String(documentId)
      })
    });
  }
  const bytes = overrides.documentBlob || Buffer.from('%PDF-1.4\ncontract fixture bytes\n%%EOF\n', 'ascii');
  return db.prepare(`
    INSERT INTO collaboration_contract_documents (
      id,org_id,campaign_id,collaboration_id,uploaded_by,knowledge_entry_id,
      original_filename,media_type,file_sha256,file_bytes,document_blob
    ) VALUES (
      @id,@orgId,@campaignId,@collaborationId,@userId,@knowledgeEntryId,
      @filename,'application/pdf',@fileSha256,@fileBytes,@documentBlob
    )
  `).run({
    ...fixture,
    id: documentId,
    knowledgeEntryId,
    filename: overrides.filename || 'signed-contract.pdf',
    fileSha256: overrides.fileSha256 || sha256(bytes),
    fileBytes: bytes.length,
    documentBlob: bytes,
    ...overrides
  });
}

test('migration 016 upgrades v15 with immutable campaign-scoped contract document custody', () => {
  const db = openAtV15();
  try {
    assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 15);
    upgradeToV16(db);
    assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 16);
    const table = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='collaboration_contract_documents'").get();
    assert.ok(table);
    assert.match(table.sql, /STRICT$/);
    assert.deepEqual(
      db.prepare("PRAGMA table_info('collaboration_contract_documents')").all().map((column) => column.name),
      [
        'id', 'org_id', 'campaign_id', 'collaboration_id', 'uploaded_by',
        'knowledge_entry_id', 'original_filename', 'media_type', 'file_sha256',
        'file_bytes', 'document_blob', 'created_at'
      ]
    );
    assert.ok(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='index' AND name='ux_collaboration_contract_documents_identity'").get());
    assert.ok(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='collaboration_contract_documents_no_update'").get());
    assert.ok(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='collaboration_contract_documents_scope_insert'").get());
  } finally {
    db.close();
  }
});

test('migration 016 enforces immutable bytes, custody, content identity, and five-file limit', () => {
  const db = openAtV15();
  try {
    upgradeToV16(db);
    const fixture = createFixture(db);
    insertDocument(db, fixture);
    assert.throws(
      () => db.prepare('UPDATE collaboration_contract_documents SET original_filename=? WHERE id=?')
        .run('changed.pdf', 816007),
      /append-only/
    );
    assert.throws(
      () => db.prepare('DELETE FROM collaboration_contract_documents WHERE id=?').run(816007),
      /append-only/
    );
    assert.throws(
      () => insertDocument(db, fixture, { id: 816008, filename: 'duplicate.pdf' }),
      /UNIQUE constraint failed/
    );
    assert.throws(
      () => insertDocument(db, fixture, {
        id: 816009,
        campaignId: fixture.campaignId + 1,
        fileSha256: sha256('wrong-campaign')
      }),
      /custody is invalid/
    );
    for (let index = 1; index < 5; index += 1) {
      const bytes = Buffer.from(`%PDF-1.4\ncontract fixture ${index}\n%%EOF\n`, 'ascii');
      insertDocument(db, fixture, {
        id: 816010 + index,
        filename: `signed-contract-${index}.pdf`,
        fileSha256: sha256(bytes),
        documentBlob: bytes
      });
    }
    const overflow = Buffer.from('%PDF-1.4\ncontract fixture overflow\n%%EOF\n', 'ascii');
    assert.throws(
      () => insertDocument(db, fixture, {
        id: 816020,
        filename: 'signed-contract-overflow.pdf',
        fileSha256: sha256(overflow),
        documentBlob: overflow
      }),
      /file limit exceeded/
    );
  } finally {
    db.close();
  }
});

test('migration 016 manifest and production registries expose schema version 16', () => {
  assert.equal(migration.version, 16);
  assert.equal(migration.name, '016_collaboration_contract_documents');
  assert.equal(migration.sourcePath, 'migrations/016_collaboration_contract_documents.js');
  assert.ok(migration.schemaManifest.columns.collaboration_contract_documents);
  const platformRoot = path.resolve(__dirname, '..', '..');
  const dbSource = fs.readFileSync(path.join(platformRoot, 'server', 'db.js'), 'utf8');
  const verifierSource = fs.readFileSync(path.join(platformRoot, 'server', 'scripts', 'verify_campaign_migration_gate.js'), 'utf8');
  const sanitizerSource = fs.readFileSync(path.join(platformRoot, 'server', 'scripts', 'sanitize_production_shape.js'), 'utf8');
  const trustedSource = fs.readFileSync(path.join(platformRoot, 'server', 'scripts', 'trusted_production_source_gate.js'), 'utf8');
  const deploySource = fs.readFileSync(path.join(platformRoot, 'deploy_v8.ps1'), 'utf8');
  assert.match(dbSource, /version:\s*16,[\s\S]*name:\s*'016_collaboration_contract_documents'/);
  assert.match(verifierSource, /version:\s*16,[\s\S]*name:\s*'016_collaboration_contract_documents'/);
  assert.match(sanitizerSource, /version:\s*16,[\s\S]*name:\s*'016_collaboration_contract_documents'/);
  assert.match(trustedSource, /server\/migrations\/016_collaboration_contract_documents\.js/);
  assert.match(deploySource, /server\\migrations\\016_collaboration_contract_documents\.js/);
  assert.match(trustedSource, /targetVersion:\s*16/);
});

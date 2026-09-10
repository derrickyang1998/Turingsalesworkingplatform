'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const migration016 = require('../migrations/016_collaboration_contract_documents');
const knowledgeService = require('../services/knowledge_service');
const {
  DEFAULT_ORGANIZATION_CODE
} = require('../services/organization_access_service');
const {
  createCampaignCollaborationService
} = require('../services/campaign_collaboration_service');

const SERVER_ROOT = path.resolve(__dirname, '..');
const CAMPAIGN_MIGRATIONS = Object.freeze([
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
  return createHash('sha256').update(value).digest('hex');
}

function openCampaignDatabase(t) {
  const db = new Database(':memory:');
  db.pragma('busy_timeout = 5000');
  t.after(() => db.close());
  assert.deepEqual(migrationService.runMigrations(db, {
    rootDir: SERVER_ROOT,
    registeredMigrations: CAMPAIGN_MIGRATIONS
  }), { status: 'managed', currentVersion: 5 });
  migration016.apply(db);
  return db;
}

function seedFixture(db) {
  const orgId = db.prepare('SELECT id FROM organizations WHERE code=?')
    .get(DEFAULT_ORGANIZATION_CODE).id;
  const teams = db.prepare(`
    SELECT team_id AS teamId,user_id AS userId
    FROM team_memberships
    WHERE org_id=? AND status='active'
    ORDER BY user_id
  `).all(orgId);
  const teamId = teams.find((row) => row.userId === 2).teamId;
  const influencerId = db.prepare(`
    INSERT INTO influencers (platform,kol_handle,profile_link,followers,is_active)
    VALUES ('TikTok','@collaboration-security','https://example.invalid/security',1000,1)
  `).run().lastInsertRowid;
  db.prepare(`
    INSERT INTO customers (
      id,brand_name,company_name,stage,source,created_by,assigned_to,is_public
    ) VALUES (7001,'Collaboration Brand','Collaboration Brand Ltd','qualified','test',2,2,1)
  `).run();
  db.prepare(`
    INSERT INTO opportunities (
      id,customer_id,name,stage,value,win_probability,product_name,channel_type,created_by
    ) VALUES (7001,7001,'Collaboration opportunity','proposal',1000,50,'Product','influencer',2)
  `).run();
  db.prepare(`
    INSERT INTO campaigns (
      id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,
      lifecycle_state,operational_status,row_version
    ) VALUES (7001,?,'Collaboration authorization',7001,7001,2,?,'lead','active',1)
  `).run(orgId, teamId);
  db.prepare(`
    INSERT INTO organizations (id,code,name,created_at)
    VALUES (701,'collaboration-other','Collaboration Other','2026-07-01 00:00:00')
  `).run();
  db.prepare(`
    INSERT INTO organization_memberships (org_id,user_id,role_code,status,created_at)
    VALUES (701,4,'org_admin','active','2026-07-01 00:00:00')
  `).run();
  db.prepare(`
    UPDATE organization_memberships
    SET status='revoked',revoked_at='2026-07-01 00:00:00'
    WHERE org_id=? AND user_id=4
  `).run(orgId);

  const insert = db.prepare(`
    INSERT INTO collaborations (id,influencer_id,user_id,status,cost_quoted,cost_actual,row_version)
    VALUES (?,?,?,?,?,?,1)
  `);
  insert.run(7101, influencerId, 2, 'confirmed', 100, 100);
  insert.run(7102, influencerId, 3, 'confirmed', 200, 200);
  insert.run(7103, influencerId, 4, 'confirmed', 300, 300);
  assert.equal(
    db.prepare('SELECT cost_quoted FROM collaborations WHERE id=7102').get().cost_quoted,
    200
  );
  db.prepare(`
    INSERT INTO campaign_record_links (
      org_id,campaign_id,record_type,bundle_id,record_id,relation_type,created_by,metadata_json
    ) VALUES (?,?, 'collaboration', ?, '7101', 'order', 2, '{}')
  `).run(orgId, 7001, sha256('collaboration-security-order'));
  return { orgId, teamId, influencerId: Number(influencerId) };
}

test('campaign closeout snapshot is permission-scoped and counts every linked collaboration beyond the list cap', (t) => {
  const db = openCampaignDatabase(t);
  const fixture = seedFixture(db);
  const insertCollaboration = db.prepare(`
    INSERT INTO collaborations (
      id,influencer_id,user_id,status,cost_quoted,cost_actual,row_version
    ) VALUES (?,?,?,?,0,NULL,1)
  `);
  for (let index = 0; index < 205; index += 1) {
    const collaborationId = 7200 + index;
    insertCollaboration.run(
      collaborationId,
      fixture.influencerId,
      2,
      index % 2 === 0 ? 'completed' : 'confirmed'
    );
    insertCampaignLink(db, {
      orgId: fixture.orgId,
      collaborationId,
      relationType: 'order',
      bundleId: sha256(`closeout-snapshot-${collaborationId}`)
    });
  }
  db.prepare(`
    UPDATE campaigns
    SET lifecycle_state='settled',currency='USD'
    WHERE id=7001
  `).run();
  const service = createCampaignCollaborationService(db);

  assert.deepEqual(service.closeoutSnapshot({ userId: 2, campaignId: 7001 }), {
    campaign_id: 7001,
    verified: true,
    source: 'campaign_collaboration_ledger',
    collaboration_count: 206,
    completed_count: 103,
    settled_count: 0,
    v2_settled_count: 0,
    legacy_settled_count: 0,
    currency: 'USD',
    creator_payment_total: 0,
    client_receipt_total: 0
  });
  assert.throws(
    () => service.closeoutSnapshot({ userId: 4, campaignId: 7001 }),
    (error) => error.code === 'CAMPAIGN_NOT_FOUND' && error.statusCode === 404
  );
});

function setV2CollaborationResource(db, collaborationId, overrides = {}) {
  const resource = Object.assign({
    schema: 'turingmarket.collaboration-order.v2',
    project_name: 'Signed contract launch',
    product_name: 'Portable power station',
    order_type: 'paid',
    order_reference: 'PO-7101',
    deliverable: 'One dedicated video',
    creator_cost: 100,
    client_quote: 150,
    currency: 'USD',
    margin_amount: 50,
    payment_terms: 'net_30'
  }, overrides);
  db.prepare(`
    UPDATE collaborations
    SET proposal_notes=?,cost_quoted=?,status='confirmed',row_version=1
    WHERE id=?
  `).run(JSON.stringify(resource), resource.creator_cost, collaborationId);
  return resource;
}

function contractConfirmationInput(overrides = {}) {
  return Object.assign({
    userId: 2,
    collaborationId: 7101,
    requestId: 'contract-confirmation-request-0001',
    idempotencyKey: 'contract-confirmation-0001',
    body: {
      campaign_id: 7001,
      expected_version: 2,
      contract_document_id: 1,
      contract_reference: 'SIGNED-7101',
      counterparty_name: 'Creator Management LLC',
      signed_at: '2026-09-07T10:00:00.000Z',
      confirmation_note: 'Signed PDF verified in the approved shared drive.'
    }
  }, overrides);
}

function uploadContractDocument(service, expectedVersion, suffix = '0001') {
  const bytes = Buffer.from('%PDF-1.7\ncontract security fixture\n%%EOF\n', 'ascii');
  return service.uploadContractDocument({
    userId: 2,
    collaborationId: 7101,
    requestId: `contract-document-request-${suffix}`,
    idempotencyKey: `contract-document-upload-${suffix}`,
    body: {
      campaign_id: 7001,
      expected_version: expectedVersion,
      filename: 'signed-contract.pdf',
      media_type: 'application/pdf',
      content_base64: bytes.toString('base64')
    }
  }).body.document;
}

function insertCampaignLink(db, {
  orgId,
  campaignId = 7001,
  collaborationId,
  relationType,
  bundleId,
  userId = 2
}) {
  return Number(db.prepare(`
    INSERT INTO campaign_record_links (
      org_id,campaign_id,record_type,bundle_id,record_id,relation_type,created_by,metadata_json
    ) VALUES (?,?,'collaboration',?,?,?,?, '{}')
  `).run(
    orgId,
    campaignId,
    bundleId,
    String(collaborationId),
    relationType,
    userId
  ).lastInsertRowid);
}

function revokeCampaignLink(db, linkId, userId, revokedAt) {
  assert.equal(db.prepare(`
    UPDATE campaign_record_links
    SET revoked_at=?,revoked_by=?,revoke_reason='Collaboration custody test'
    WHERE id=? AND revoked_at IS NULL
  `).run(revokedAt, userId, linkId).changes, 1);
}

function seedRestrictedCampaign(db, fixture) {
  const teamId = 7701;
  db.prepare(`
    INSERT INTO teams (id,org_id,code,name)
    VALUES (? ,?,'collaboration-restricted','Collaboration Restricted')
  `).run(teamId, fixture.orgId);
  db.prepare(`
    INSERT INTO team_memberships (org_id,team_id,user_id,role_code,status)
    VALUES (?,?,3,'team_lead','active')
  `).run(fixture.orgId, teamId);
  db.prepare(`
    INSERT INTO campaigns (
      id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,
      lifecycle_state,operational_status,row_version
    ) VALUES (7002,?,'Restricted collaboration custody',7001,7001,3,?,'lead','active',1)
  `).run(fixture.orgId, teamId);
  return { campaignId: 7002, teamId };
}

function collaborationWriteState(db, collaborationId = 7101) {
  return {
    collaborationCount: db.prepare('SELECT COUNT(*) AS count FROM collaborations').get().count,
    collaboration: db.prepare(`
      SELECT status,cost_actual,cost_actual_confirmed,row_version,notes
      FROM collaborations WHERE id=?
    `).get(collaborationId),
    links: db.prepare(`
      SELECT COUNT(*) AS count FROM campaign_record_links
      WHERE record_type='collaboration'
    `).get().count,
    archives: db.prepare(`
      SELECT COUNT(*) AS count FROM knowledge_entries
      WHERE source_type='campaign_collaboration'
    `).get().count,
    events: db.prepare('SELECT COUNT(*) AS count FROM campaign_events').get().count,
    reservations: db.prepare('SELECT COUNT(*) AS count FROM request_idempotency').get().count
  };
}

function establishSettlementAlias(service, keyPrefix) {
  service.updateLinked({
    userId: 2,
    collaborationId: 7101,
    requestId: `${keyPrefix}-execution`,
    idempotencyKey: `${keyPrefix}-execution-0001`,
    body: {
      campaign_id: 7001,
      expected_version: 1,
      reason: 'Execution started',
      status: 'live',
      campaign_relation: 'execution'
    }
  });
  service.updateLinked({
    userId: 2,
    collaborationId: 7101,
    requestId: `${keyPrefix}-publication`,
    idempotencyKey: `${keyPrefix}-publication-0001`,
    body: {
      campaign_id: 7001,
      expected_version: 2,
      reason: 'Publication verified',
      status: 'completed',
      campaign_relation: 'publication'
    }
  });
  return service.updateLinked({
    userId: 2,
    collaborationId: 7101,
    requestId: `${keyPrefix}-settlement`,
    idempotencyKey: `${keyPrefix}-settlement-0001`,
    body: {
      campaign_id: 7001,
      expected_version: 3,
      reason: 'Settlement confirmed',
      status: 'completed',
      campaign_relation: 'settlement',
      cost_actual: 100,
      confirm_cost_actual: true
    }
  });
}

function createCollaborationWorker(workerData) {
  const worker = new Worker(`
    'use strict';
    const { parentPort, workerData } = require('node:worker_threads');
    const Database = require(workerData.databaseModulePath);
    const { createCampaignCollaborationService } = require(workerData.servicePath);
    const db = new Database(workerData.dbPath);
    db.pragma('busy_timeout = 5000');
    parentPort.postMessage({ type: 'ready' });
    parentPort.once('message', (message) => {
      if (!message || message.type !== 'start') return;
      try {
        const result = createCampaignCollaborationService(db).updateLinked(workerData.input);
        parentPort.postMessage({ type: 'result', result });
      } catch (error) {
        parentPort.postMessage({
          type: 'result',
          error: {
            name: error && error.name,
            message: error && error.message,
            code: error && error.code,
            statusCode: error && (error.statusCode || error.status)
          }
        });
      } finally {
        db.close();
        parentPort.close();
      }
    });
  `, { eval: true, workerData });
  let resolveReady;
  let rejectReady;
  let resolveResult;
  let rejectResult;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const result = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  worker.on('message', (message) => {
    if (message && message.type === 'ready') resolveReady();
    if (message && message.type === 'result') resolveResult(message);
  });
  worker.once('error', (error) => {
    rejectReady(error);
    rejectResult(error);
  });
  return { worker, ready, result };
}

test('collaboration stats return an explicit empty currency breakdown when no rows are visible', (t) => {
  const db = openCampaignDatabase(t);
  const service = createCampaignCollaborationService(db);

  assert.deepEqual(service.stats({ userId: 2 }).stats, {
    byStatus: [],
    totalActive: 0,
    totalCompleted: 0,
    totalCost: 0,
    totalCostCurrency: null,
    costByCurrency: []
  });
});

test('global collaboration reads conceal IDs before list and stats aggregation', (t) => {
  const db = openCampaignDatabase(t);
  const fixture = seedFixture(db);
  const service = createCampaignCollaborationService(db);

  assert.deepEqual(
    service.list({ userId: 3 }).collaborations.map((row) => row.id).sort((a, b) => a - b),
    [7102]
  );
  assert.deepEqual(service.stats({ userId: 3 }).stats, {
    byStatus: [{ status: 'confirmed', count: 1 }],
    totalActive: 1,
    totalCompleted: 0,
    totalCost: 200,
    totalCostCurrency: 'USD',
    costByCurrency: [{ currency: 'USD', totalCost: 200 }]
  });

  db.prepare(`
    UPDATE organization_memberships
    SET role_code='org_admin'
    WHERE org_id=? AND user_id=3
  `).run(fixture.orgId);
  assert.deepEqual(
    service.list({ userId: 3 }).collaborations.map((row) => row.id).sort((a, b) => a - b),
    [7101, 7102]
  );
  assert.equal(service.stats({ userId: 3 }).stats.totalCost, 300);

  assert.deepEqual(
    service.list({ userId: 1 }).collaborations.map((row) => row.id).sort((a, b) => a - b),
    [7101, 7102, 7103]
  );
});

test('object-visible active, moved, and revoke-only collaborations require current custody access', (t) => {
  const db = openCampaignDatabase(t);
  const fixture = seedFixture(db);
  const restricted = seedRestrictedCampaign(db, fixture);
  const service = createCampaignCollaborationService(db);
  const insert = db.prepare(`
    INSERT INTO collaborations (
      id,influencer_id,user_id,status,cost_quoted,cost_actual,row_version,cost_actual_confirmed
    ) VALUES (?,?,2,'confirmed',?,?,1,0)
  `);
  insert.run(7201, fixture.influencerId, 11, 11);
  insert.run(7202, fixture.influencerId, 12, 12);
  insert.run(7203, fixture.influencerId, 13, 13);

  insertCampaignLink(db, {
    orgId: fixture.orgId,
    campaignId: restricted.campaignId,
    collaborationId: 7201,
    relationType: 'order',
    bundleId: sha256('collaboration-active-hidden')
  });
  const movedSource = insertCampaignLink(db, {
    orgId: fixture.orgId,
    collaborationId: 7202,
    relationType: 'order',
    bundleId: sha256('collaboration-moved-source')
  });
  revokeCampaignLink(db, movedSource, 2, '2026-07-02 00:00:00');
  insertCampaignLink(db, {
    orgId: fixture.orgId,
    campaignId: restricted.campaignId,
    collaborationId: 7202,
    relationType: 'order',
    bundleId: sha256('collaboration-moved-destination')
  });
  const revokeOnly = insertCampaignLink(db, {
    orgId: fixture.orgId,
    campaignId: restricted.campaignId,
    collaborationId: 7203,
    relationType: 'order',
    bundleId: sha256('collaboration-revoke-only')
  });
  revokeCampaignLink(db, revokeOnly, 3, '2026-07-03 00:00:00');

  assert.deepEqual(
    service.list({ userId: 2 }).collaborations.map((row) => row.id),
    [7101]
  );
  assert.deepEqual(service.stats({ userId: 2 }).stats, {
    byStatus: [{ status: 'confirmed', count: 1 }],
    totalActive: 1,
    totalCompleted: 0,
    totalCost: 100,
    totalCostCurrency: 'USD',
    costByCurrency: [{ currency: 'USD', totalCost: 100 }]
  });
  for (const collaborationId of [7201, 7202, 7203]) {
    assert.throws(
      () => service.get({ userId: 2, collaborationId }),
      (error) => error && error.code === 'RECORD_NOT_FOUND' && error.details === undefined
    );
    assert.throws(
      () => service.updateLegacy({
        userId: 2,
        collaborationId,
        body: { notes: 'Must remain concealed' }
      }),
      (error) => error && error.code === 'RECORD_NOT_FOUND' && error.details === undefined
    );
  }

  db.prepare(`
    INSERT INTO team_memberships (org_id,team_id,user_id,role_code,status)
    VALUES (?,?,2,'member','active')
  `).run(fixture.orgId, restricted.teamId);
  assert.deepEqual(
    service.list({ userId: 2 }).collaborations.map((row) => row.id).sort((left, right) => left - right),
    [7101, 7201, 7202, 7203]
  );
  assert.equal(service.stats({ userId: 2 }).stats.totalCost, 136);
  assert.throws(
    () => service.updateLegacy({
      userId: 2,
      collaborationId: 7202,
      body: { notes: 'Campaign context still required' }
    }),
    (error) => (
      error &&
      error.code === 'CAMPAIGN_CONTEXT_REQUIRED' &&
      error.details.campaign_id === restricted.campaignId
    )
  );
});

test('collaboration stats group costs by currency without adding mixed currencies', (t) => {
  const db = openCampaignDatabase(t);
  const fixture = seedFixture(db);
  const service = createCampaignCollaborationService(db);
  db.prepare(`
    INSERT INTO collaborations (
      id,influencer_id,user_id,status,proposal_notes,cost_quoted,cost_actual,row_version
    ) VALUES (7205,?,3,'confirmed',?,50,NULL,1)
  `).run(fixture.influencerId, JSON.stringify({
    schema: 'turingmarket.collaboration-order.v2',
    project_name: '',
    product_name: '',
    order_type: 'paid',
    order_reference: '',
    deliverable: '',
    creator_cost: 50,
    client_quote: 75,
    currency: 'EUR',
    margin_amount: 25,
    payment_terms: 'net_30'
  }));

  assert.deepEqual(service.stats({ userId: 3 }).stats, {
    byStatus: [{ status: 'confirmed', count: 2 }],
    totalActive: 2,
    totalCompleted: 0,
    totalCost: null,
    totalCostCurrency: null,
    costByCurrency: [
      { currency: 'EUR', totalCost: 50 },
      { currency: 'USD', totalCost: 200 }
    ]
  });
});

test('ambiguous active collaboration custody is concealed without campaign ID disclosure', (t) => {
  const db = openCampaignDatabase(t);
  const fixture = seedFixture(db);
  const restricted = seedRestrictedCampaign(db, fixture);
  const service = createCampaignCollaborationService(db);
  db.prepare(`
    INSERT INTO team_memberships (org_id,team_id,user_id,role_code,status)
    VALUES (?,?,2,'member','active')
  `).run(fixture.orgId, restricted.teamId);
  db.prepare(`
    INSERT INTO collaborations (
      id,influencer_id,user_id,status,cost_quoted,cost_actual,row_version,cost_actual_confirmed
    ) VALUES (7204,?,2,'confirmed',14,14,1,0)
  `).run(fixture.influencerId);
  insertCampaignLink(db, {
    orgId: fixture.orgId,
    collaborationId: 7204,
    relationType: 'order',
    bundleId: sha256('collaboration-ambiguous-source')
  });
  db.exec('DROP TRIGGER campaign_links_single_owner');
  insertCampaignLink(db, {
    orgId: fixture.orgId,
    campaignId: restricted.campaignId,
    collaborationId: 7204,
    relationType: 'order',
    bundleId: sha256('collaboration-ambiguous-destination')
  });

  assert.deepEqual(
    service.list({ userId: 2 }).collaborations.map((row) => row.id),
    [7101]
  );
  assert.equal(service.stats({ userId: 2 }).stats.totalCost, 100);
  assert.throws(
    () => service.get({ userId: 2, collaborationId: 7204 }),
    (error) => error && error.code === 'RECORD_NOT_FOUND' && error.details === undefined
  );
  assert.throws(
    () => service.updateLegacy({
      userId: 2,
      collaborationId: 7204,
      body: { notes: 'Never disclose either campaign' }
    }),
    (error) => error && error.code === 'RECORD_NOT_FOUND' && error.details === undefined
  );
});

test('collaboration detail and legacy update conceal inaccessible IDs and refuse classified fallback', (t) => {
  const db = openCampaignDatabase(t);
  seedFixture(db);
  const service = createCampaignCollaborationService(db);
  const before = db.prepare(`
    SELECT status,cost_actual,row_version
    FROM collaborations
    WHERE id=7101
  `).get();

  assert.throws(
    () => service.get({ userId: 3, collaborationId: 7101 }),
    (error) => error && error.code === 'RECORD_NOT_FOUND'
  );
  assert.throws(
    () => service.updateLegacy({
      userId: 3,
      collaborationId: 7101,
      body: { status: 'completed' }
    }),
    (error) => error && error.code === 'RECORD_NOT_FOUND'
  );
  assert.deepEqual(db.prepare(`
    SELECT status,cost_actual,row_version
    FROM collaborations
    WHERE id=7101
  `).get(), before);

  assert.throws(
    () => service.updateLegacy({
      userId: 2,
      collaborationId: 7101,
      body: { status: 'completed' }
    }),
    (error) => error && error.code === 'CAMPAIGN_CONTEXT_REQUIRED' && error.details.campaign_id === 7001
  );
  assert.deepEqual(db.prepare(`
    SELECT status,cost_actual,row_version
    FROM collaborations
    WHERE id=7101
  `).get(), before);
});

test('signed contract confirmation is idempotent, immutable, and unlocks v2 execution', (t) => {
  const db = openCampaignDatabase(t);
  seedFixture(db);
  setV2CollaborationResource(db, 7101);
  const service = createCampaignCollaborationService(db);
  const sent = service.updateLinked({
    userId: 2,
    collaborationId: 7101,
    requestId: 'contract-dispatch-request',
    idempotencyKey: 'contract-dispatch-0001',
    body: {
      campaign_id: 7001,
      expected_version: 2,
      reason: 'Contract sent for signature',
      status: 'contract_sent'
    }
  });
  assert.equal(sent.body.row_version, 3);
  const contractDocument = uploadContractDocument(service, 3);
  const input = contractConfirmationInput({
    body: Object.assign({}, contractConfirmationInput().body, {
      expected_version: 3,
      contract_document_id: contractDocument.id
    })
  });

  const confirmed = service.confirmContract(input);
  assert.equal(confirmed.status, 201);
  assert.equal(confirmed.body.success, true);
  assert.equal(confirmed.body.status, 'contracted');
  assert.equal(confirmed.body.row_version, 4);
  assert.deepEqual(confirmed.body.active_relations, ['order']);
  assert.equal(confirmed.body.contract_confirmation.contract_reference, 'SIGNED-7101');
  assert.equal(confirmed.body.contract_confirmation.counterparty_name, 'Creator Management LLC');
  assert.equal(confirmed.body.contract_confirmation.signed_at, '2026-09-07T10:00:00.000Z');
  assert.equal(confirmed.body.contract_confirmation.confirmation_note, 'Signed PDF verified in the approved shared drive.');
  assert.equal(confirmed.body.contract_confirmation.confirmed_by, 2);
  assert.equal(confirmed.body.contract_confirmation.document.id, contractDocument.id);
  assert.match(confirmed.body.contract_confirmation.confirmed_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);

  const replay = service.confirmContract(input);
  assert.deepEqual(replay, confirmed);
  const reloaded = service.list({
    userId: 2,
    campaignId: 7001,
    includeCampaignContext: true
  }).collaborations.find((row) => row.id === 7101);
  assert.deepEqual(reloaded.contract_confirmation, confirmed.body.contract_confirmation);
  assert.deepEqual(
    db.prepare('SELECT status,row_version FROM collaborations WHERE id=7101').get(),
    { status: 'contracted', row_version: 4 }
  );
  const evidenceRows = db.prepare(`
    SELECT content,metadata_json
    FROM knowledge_entries
    WHERE source_type='collaboration_contract_confirmation'
  `).all();
  assert.equal(evidenceRows.length, 1);
  assert.doesNotMatch(evidenceRows[0].content, /SIGNED-7101|Creator Management|Signed PDF/);
  assert.deepEqual(JSON.parse(evidenceRows[0].metadata_json), {
    schema_version: 2,
    collaboration_id: 7101,
    row_version: 4,
    contract_document_id: contractDocument.id,
    contract_document_sha256: contractDocument.file_sha256,
    contract_reference: 'SIGNED-7101',
    counterparty_name: 'Creator Management LLC',
    signed_at: '2026-09-07T10:00:00.000Z',
    confirmation_note: 'Signed PDF verified in the approved shared drive.',
    confirmed_by: 2,
    confirmed_at: confirmed.body.contract_confirmation.confirmed_at,
    retrieval_eligible: false
  });
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count
    FROM campaign_events
    WHERE event_type='link_attached' AND source='collaboration_link'
      AND json_extract(metadata_json,'$.record_type')='knowledge_entry'
  `).get().count, 2);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count
    FROM request_idempotency
    WHERE scope='collaboration.update.linked' AND state='completed'
      AND idempotency_key='contract-confirmation-0001'
  `).get().count, 1);

  const execution = service.updateLinked({
    userId: 2,
    collaborationId: 7101,
    requestId: 'contracted-execution-request',
    idempotencyKey: 'contracted-execution-0001',
    body: {
      campaign_id: 7001,
      expected_version: 4,
      reason: 'Signed contract verified before execution',
      status: 'live',
      campaign_relation: 'execution'
    }
  });
  assert.equal(execution.body.row_version, 5);
  assert.deepEqual(execution.body.active_relations, ['order', 'execution']);
});

test('v2 execution requires the signed contract checkpoint without affecting historical order contracts', (t) => {
  const db = openCampaignDatabase(t);
  seedFixture(db);
  setV2CollaborationResource(db, 7101);
  const service = createCampaignCollaborationService(db);
  const before = collaborationWriteState(db);

  assert.throws(
    () => service.updateLinked({
      userId: 2,
      collaborationId: 7101,
      requestId: 'unsigned-v2-execution',
      idempotencyKey: 'unsigned-v2-execution-0001',
      body: {
        campaign_id: 7001,
        expected_version: 2,
        reason: 'Attempt to skip contract confirmation',
        status: 'live',
        campaign_relation: 'execution'
      }
    }),
    (error) => error && error.code === 'CONTRACT_CONFIRMATION_REQUIRED'
  );
  assert.deepEqual(collaborationWriteState(db), before);

  db.prepare('UPDATE collaborations SET proposal_notes=? WHERE id=7101').run(JSON.stringify({
    schema: 'turingmarket.collaboration-order.v2',
    creator_cost: 'invalid'
  }));
  const noncanonicalBefore = collaborationWriteState(db);
  assert.throws(
    () => service.updateLinked({
      userId: 2,
      collaborationId: 7101,
      requestId: 'noncanonical-v2-execution',
      idempotencyKey: 'noncanonical-v2-execution-0001',
      body: {
        campaign_id: 7001,
        expected_version: 3,
        reason: 'Reserved v2 data must fail closed',
        status: 'live',
        campaign_relation: 'execution'
      }
    }),
    (error) => error && error.code === 'CONTRACT_CONFIRMATION_REQUIRED'
  );
  assert.deepEqual(collaborationWriteState(db), noncanonicalBefore);

  db.prepare("UPDATE collaborations SET proposal_notes=NULL WHERE id=7101").run();
  const legacy = service.updateLinked({
    userId: 2,
    collaborationId: 7101,
    requestId: 'legacy-execution-compatible',
    idempotencyKey: 'legacy-execution-compatible-0001',
    body: {
      campaign_id: 7001,
      expected_version: 4,
      reason: 'Historical order remains compatible',
      status: 'live',
      campaign_relation: 'execution'
    }
  });
  assert.equal(legacy.body.row_version, 5);
});

test('contract confirmation rejects invalid evidence, stale versions, inaccessible records, and second confirmations atomically', (t) => {
  const db = openCampaignDatabase(t);
  seedFixture(db);
  setV2CollaborationResource(db, 7101);
  const service = createCampaignCollaborationService(db);
  uploadContractDocument(service, 2);
  const baseline = collaborationWriteState(db);

  assert.throws(
    () => service.confirmContract(contractConfirmationInput({
      body: Object.assign({}, contractConfirmationInput().body, {
        contract_reference: '',
        signed_at: '2999-01-01T00:00:00.000Z'
      })
    })),
    (error) => error && error.code === 'INVALID_CONTRACT_CONFIRMATION'
  );
  assert.deepEqual(collaborationWriteState(db), baseline);

  for (const [index, signedAt] of [
    '2026-02-30T10:00:00.000Z',
    '2026-01-01T24:00:00.000Z'
  ].entries()) {
    assert.throws(
      () => service.confirmContract(contractConfirmationInput({
        idempotencyKey: `contract-confirmation-invalid-calendar-000${index}`,
        body: Object.assign({}, contractConfirmationInput().body, { signed_at: signedAt })
      })),
      (error) => error && error.code === 'INVALID_CONTRACT_CONFIRMATION' && error.details.field === 'signed_at'
    );
    assert.deepEqual(collaborationWriteState(db), baseline);
  }

  assert.throws(
    () => service.confirmContract(contractConfirmationInput({
      idempotencyKey: 'contract-confirmation-local-time-0001',
      body: Object.assign({}, contractConfirmationInput().body, {
        signed_at: '2026-09-07T10:00'
      })
    })),
    (error) => error && error.code === 'INVALID_CONTRACT_CONFIRMATION' && error.details.field === 'signed_at'
  );
  assert.deepEqual(collaborationWriteState(db), baseline);

  assert.throws(
    () => service.confirmContract(contractConfirmationInput({
      userId: 3,
      idempotencyKey: 'contract-confirmation-hidden-0001',
      body: { campaign_id: 7001 }
    })),
    (error) => error && error.code === 'RECORD_NOT_FOUND'
  );
  assert.deepEqual(collaborationWriteState(db), baseline);

  assert.throws(
    () => service.confirmContract(contractConfirmationInput({
      idempotencyKey: 'contract-confirmation-stale-0001',
      body: Object.assign({}, contractConfirmationInput().body, { expected_version: 3 })
    })),
    (error) => error && error.code === 'STALE_COLLABORATION_VERSION'
  );
  assert.deepEqual(collaborationWriteState(db), baseline);

  service.confirmContract(contractConfirmationInput());
  const afterConfirmation = collaborationWriteState(db);
  assert.throws(
    () => service.confirmContract(contractConfirmationInput({
      requestId: 'contract-confirmation-request-0002',
      idempotencyKey: 'contract-confirmation-0002',
      body: Object.assign({}, contractConfirmationInput().body, { expected_version: 3 })
    })),
    (error) => error && error.code === 'CONTRACT_ALREADY_CONFIRMED'
  );
  assert.deepEqual(collaborationWriteState(db), afterConfirmation);
});

test('contract confirmation rolls back status, evidence, links, events, archives, and ledger on evidence failure', (t) => {
  const db = openCampaignDatabase(t);
  seedFixture(db);
  setV2CollaborationResource(db, 7101);
  const service = createCampaignCollaborationService(db);
  uploadContractDocument(service, 2);
  const baseline = collaborationWriteState(db);
  db.exec(`
    CREATE TRIGGER fail_contract_confirmation_evidence
    BEFORE INSERT ON knowledge_entries
    WHEN NEW.source_type='collaboration_contract_confirmation'
    BEGIN
      SELECT RAISE(ABORT,'injected contract evidence failure');
    END
  `);

  assert.throws(
    () => service.confirmContract(contractConfirmationInput()),
    /injected contract evidence failure/
  );
  assert.deepEqual(collaborationWriteState(db), baseline);
});

test('contract confirmation rejects duplicate producer evidence instead of selecting an arbitrary record', (t) => {
  const db = openCampaignDatabase(t);
  const fixture = seedFixture(db);
  setV2CollaborationResource(db, 7101);
  const service = createCampaignCollaborationService(db);
  uploadContractDocument(service, 2);
  service.confirmContract(contractConfirmationInput());

  db.transaction(() => {
    const sourceId = '7101:999';
    const duplicate = knowledgeService.writeCampaignKnowledgeInTransaction(db, {
      organizationId: fixture.orgId,
      campaignId: 7001,
      createdBy: 2,
      entryType: 'collaboration_contract_confirmation',
      title: 'Duplicate signed contract checkpoint',
      summary: 'Duplicate evidence used to verify cardinality fencing.',
      content: JSON.stringify({ collaboration_id: 7101, checkpoint: 'signed_contract' }),
      tags: ['campaign', 'collaboration', 'contract'],
      sourceType: 'collaboration_contract_confirmation',
      sourceId,
      visibility: 'team',
      metadata: {
        schema_version: 1,
        collaboration_id: 7101,
        row_version: 999,
        contract_reference: 'DUPLICATE-7101',
        counterparty_name: 'Duplicate Studio',
        signed_at: '2026-09-07T11:00:00.000Z',
        confirmation_note: 'Duplicate evidence must not be selected.',
        confirmed_by: 2,
        confirmed_at: '2026-09-08T07:00:00.000Z',
        retrieval_eligible: false
      }
    });
    db.prepare(`
      INSERT INTO campaign_record_links (
        org_id,campaign_id,record_type,bundle_id,record_id,relation_type,created_by,metadata_json
      ) VALUES (?,7001,'knowledge_entry',?,?,'knowledge',2,?)
    `).run(
      fixture.orgId,
      sha256('duplicate-contract-confirmation-link'),
      String(duplicate.entry.id),
      JSON.stringify({
        producer_type: 'collaboration_contract_confirmation',
        producer_id: 7101,
        source_type: 'collaboration_contract_confirmation',
        source_id: sourceId
      })
    );
    knowledgeService.applyKnowledgeCapacityGaugePlanInTransaction(db, duplicate.capacityGaugePlan);
  }).immediate();

  assert.throws(
    () => service.list({ userId: 2, campaignId: 7001, includeCampaignContext: true }),
    (error) => error && error.code === 'CAMPAIGN_EVIDENCE_IN_USE'
  );
});

test('linked create and update reject unknown fields before reservation or mutation', (t) => {
  const db = openCampaignDatabase(t);
  const fixture = seedFixture(db);
  const service = createCampaignCollaborationService(db);
  const before = collaborationWriteState(db);
  const createExtras = [
    { unexpected_field: 'forbidden' },
    { confirm_publication: true }
  ];
  for (const [index, extra] of createExtras.entries()) {
    assert.throws(
      () => service.createLinked({
        userId: 2,
        requestId: `collaboration-create-unknown-${index}`,
        idempotencyKey: `collaboration-create-unknown-000${index}`,
        body: {
          campaign_id: 7001,
          influencer_id: fixture.influencerId,
          notes: 'Must not be created',
          ...extra
        }
      }),
      (error) => error && error.statusCode === 400 && error.code === 'INVALID_CAMPAIGN_INPUT'
    );
    assert.deepEqual(collaborationWriteState(db), before);
  }

  const updateExtras = [
    { unexpected_field: 'forbidden' },
    { confirm_publication: true }
  ];
  for (const [index, extra] of updateExtras.entries()) {
    assert.throws(
      () => service.updateLinked({
        userId: 2,
        collaborationId: 7101,
        requestId: `collaboration-update-unknown-${index}`,
        idempotencyKey: `collaboration-update-unknown-000${index}`,
        body: {
          campaign_id: 7001,
          expected_version: 1,
          reason: 'Must not update',
          status: 'live',
          ...extra
        }
      }),
      (error) => error && error.statusCode === 400 && error.code === 'INVALID_CAMPAIGN_INPUT'
    );
    assert.deepEqual(collaborationWriteState(db), before);
  }
});

test('linked collaboration creation is idempotent and commits its order evidence with an archive', (t) => {
  const db = openCampaignDatabase(t);
  seedFixture(db);
  const service = createCampaignCollaborationService(db);
  const influencerId = db.prepare('SELECT id FROM influencers WHERE kol_handle=?')
    .get('@collaboration-security').id;
  const input = {
    userId: 2,
    requestId: 'collaboration-create-test',
    idempotencyKey: 'collaboration-create-0001',
    body: {
      campaign_id: 7001,
      influencer_id: influencerId,
      notes: 'Launch order'
    }
  };

  const created = service.createLinked(input);
  assert.deepEqual(Object.keys(created.body), ['id', 'campaign_id', 'row_version', 'active_relations']);
  assert.equal(created.status, 201);
  assert.equal(created.body.campaign_id, 7001);
  assert.equal(created.body.row_version, 1);
  assert.deepEqual(created.body.active_relations, ['order']);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM campaign_record_links
    WHERE campaign_id=7001 AND record_type='collaboration' AND relation_type='order' AND revoked_at IS NULL
  `).get().count, 2);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM knowledge_entries
    WHERE source_type='campaign_collaboration'
  `).get().count, 1);
  const expectedContent = JSON.stringify({
    id: created.body.id,
    influencer_id: influencerId,
    status: 'confirmed',
    row_version: 1,
    campaign_relation: 'order',
    cost_actual: 0,
    cost_actual_confirmed: 0
  });
  const archived = db.prepare(`
    SELECT
      entry_type,title,summary,content,source_type,source_id,key_terms,tags_json,
      visibility,metadata_json,embedding_json,business_type,business_id,created_by,is_public
    FROM knowledge_entries
    WHERE source_type='campaign_collaboration' AND source_id=?
  `).get(`${created.body.id}:1`);
  assert.deepEqual(archived, {
    entry_type: 'campaign_collaboration',
    title: `Campaign collaboration #${created.body.id}`,
    summary: expectedContent,
    content: expectedContent,
    source_type: 'campaign_collaboration',
    source_id: `${created.body.id}:1`,
    key_terms: '["campaign","collaboration"]',
    tags_json: '["campaign","collaboration"]',
    visibility: 'team',
    metadata_json: '{}',
    embedding_json: null,
    business_type: 'campaign',
    business_id: '7001',
    created_by: 2,
    is_public: 1
  });
  assert.deepEqual(Object.keys(JSON.parse(archived.content)), [
    'id',
    'influencer_id',
    'status',
    'row_version',
    'campaign_relation',
    'cost_actual',
    'cost_actual_confirmed'
  ]);
  assert.equal(archived.content.includes('Launch order'), false);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM campaign_events WHERE campaign_id=7001
  `).get().count, 1);

  assert.deepEqual(service.createLinked(input), created);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM campaign_events WHERE campaign_id=7001
  `).get().count, 1);
});

test('linked collaboration creation stores the canonical resource order contract', (t) => {
  const db = openCampaignDatabase(t);
  const fixture = seedFixture(db);
  const service = createCampaignCollaborationService(db);

  const created = service.createLinked({
    userId: 2,
    requestId: 'collaboration-resource-contract',
    idempotencyKey: 'collaboration-resource-contract-0001',
    body: {
      campaign_id: 7001,
      influencer_id: fixture.influencerId,
      status: 'confirmed',
      resource: {
        schema: 'turingmarket.collaboration-order.v1',
        project_name: 'Autumn launch',
        product_name: 'Portable power station',
        order_type: 'retainer',
        order_reference: 'PO-LINKED-7001',
        deliverable: 'Four short videos per month',
        quoted_price: 4200
      },
      cost_quoted: 4200,
      notes: 'Retainer approved'
    }
  });

  assert.equal(created.status, 201);
  assert.deepEqual(JSON.parse(db.prepare('SELECT proposal_notes FROM collaborations WHERE id=?').get(created.body.id).proposal_notes), {
    schema: 'turingmarket.collaboration-order.v1',
    project_name: 'Autumn launch',
    product_name: 'Portable power station',
    order_type: 'retainer',
    order_reference: 'PO-LINKED-7001',
    deliverable: 'Four short videos per month',
    quoted_price: 4200
  });
  assert.equal(db.prepare('SELECT cost_quoted FROM collaborations WHERE id=?').get(created.body.id).cost_quoted, 4200);
  const archive = JSON.parse(db.prepare(`
    SELECT content FROM knowledge_entries
    WHERE source_type='campaign_collaboration' AND source_id=?
  `).get(`${created.body.id}:1`).content);
  assert.equal(archive.cost_quoted, 4200);
  assert.deepEqual(archive.resource, {
    schema: 'turingmarket.collaboration-order.v1',
    project_name: 'Autumn launch',
    product_name: 'Portable power station',
    order_type: 'retainer',
    order_reference: 'PO-LINKED-7001',
    deliverable: 'Four short videos per month',
    quoted_price: 4200
  });
});

test('linked collaboration resource rejects a conflicting price before a reservation is created', (t) => {
  const db = openCampaignDatabase(t);
  const fixture = seedFixture(db);
  const service = createCampaignCollaborationService(db);
  const before = collaborationWriteState(db);

  assert.throws(
    () => service.createLinked({
      userId: 2,
      requestId: 'collaboration-resource-mismatch',
      idempotencyKey: 'collaboration-resource-mismatch-0001',
      body: {
        campaign_id: 7001,
        influencer_id: fixture.influencerId,
        resource: { schema: 'turingmarket.collaboration-order.v1', quoted_price: 4200 },
        cost_quoted: 4000
      }
    }),
    (error) => error && error.statusCode === 400 && error.code === 'RESOURCE_PRICE_MISMATCH'
  );
  assert.deepEqual(collaborationWriteState(db), before);
});

test('canonical linked resource orders lock their quoted price after creation', (t) => {
  const db = openCampaignDatabase(t);
  const fixture = seedFixture(db);
  const service = createCampaignCollaborationService(db);
  const created = service.createLinked({
    userId: 2,
    requestId: 'collaboration-resource-lock-create',
    idempotencyKey: 'collaboration-resource-lock-create-0001',
    body: {
      campaign_id: 7001,
      influencer_id: fixture.influencerId,
      resource: {
        schema: 'turingmarket.collaboration-order.v1',
        quoted_price: 4200
      },
      cost_quoted: 4200
    }
  });
  const before = collaborationWriteState(db, created.body.id);

  assert.throws(
    () => service.updateLinked({
      userId: 2,
      collaborationId: created.body.id,
      requestId: 'collaboration-resource-lock-update',
      idempotencyKey: 'collaboration-resource-lock-update-0001',
      body: {
        campaign_id: 7001,
        expected_version: 1,
        reason: 'Attempt to alter confirmed quote',
        cost_quoted: 4300
      }
    }),
    (error) => error && error.statusCode === 409 && error.code === 'RESOURCE_QUOTE_LOCKED'
  );
  assert.deepEqual(collaborationWriteState(db, created.body.id), before);
});

test('linked resource and proposal notes conflict before an idempotency reservation is created', (t) => {
  const db = openCampaignDatabase(t);
  const fixture = seedFixture(db);
  const service = createCampaignCollaborationService(db);
  const before = collaborationWriteState(db);

  assert.throws(
    () => service.createLinked({
      userId: 2,
      requestId: 'collaboration-resource-proposal-conflict',
      idempotencyKey: 'collaboration-resource-proposal-conflict-0001',
      body: {
        campaign_id: 7001,
        influencer_id: fixture.influencerId,
        resource: { schema: 'turingmarket.collaboration-order.v1', quoted_price: 4200 },
        proposal_notes: 'Legacy proposal notes must not be overwritten.'
      }
    }),
    (error) => error && error.statusCode === 400 && error.code === 'RESOURCE_PROPOSAL_NOTES_CONFLICT'
  );
  assert.deepEqual(collaborationWriteState(db), before);
});

test('linked legacy resource keeps its historical proposal-note path', (t) => {
  const db = openCampaignDatabase(t);
  const fixture = seedFixture(db);
  const service = createCampaignCollaborationService(db);
  const created = service.createLinked({
    userId: 2,
    requestId: 'linked-legacy-schema-resource',
    idempotencyKey: 'linked-legacy-schema-resource-0001',
    body: {
      campaign_id: 7001,
      influencer_id: fixture.influencerId,
      resource: { schema: 'legacy.v0', price: 5100, owner: 'Derrick' },
      proposal_notes: 'Existing legacy proposal note'
    }
  });

  assert.equal(created.status, 201);
  assert.deepEqual(db.prepare('SELECT proposal_notes,cost_quoted FROM collaborations WHERE id=?').get(created.body.id), {
    proposal_notes: 'Existing legacy proposal note',
    cost_quoted: 5100
  });
  const archive = JSON.parse(db.prepare(`
    SELECT content FROM knowledge_entries
    WHERE source_type='campaign_collaboration' AND source_id=?
  `).get(`${created.body.id}:1`).content);
  assert.equal(Object.hasOwn(archive, 'resource'), false);
  assert.equal(Object.hasOwn(archive, 'cost_quoted'), false);
});

test('linked v1 resource retries are idempotent after whitespace normalization', (t) => {
  const db = openCampaignDatabase(t);
  const fixture = seedFixture(db);
  const service = createCampaignCollaborationService(db);
  const first = service.createLinked({
    userId: 2,
    requestId: 'collaboration-resource-whitespace-first',
    idempotencyKey: 'collaboration-resource-whitespace-0001',
    body: {
      campaign_id: 7001,
      influencer_id: fixture.influencerId,
      resource: {
        schema: 'turingmarket.collaboration-order.v1',
        project_name: 'Autumn launch',
        order_type: 'paid',
        order_reference: 'PO-WHITESPACE',
        deliverable: 'One short video',
        quoted_price: '1200'
      },
      cost_quoted: 1200
    }
  });
  const replay = service.createLinked({
    userId: 2,
    requestId: 'collaboration-resource-whitespace-replay',
    idempotencyKey: 'collaboration-resource-whitespace-0001',
    body: {
      campaign_id: 7001,
      influencer_id: fixture.influencerId,
      resource: {
        schema: 'turingmarket.collaboration-order.v1',
        project_name: '  Autumn launch  ',
        order_type: 'paid',
        order_reference: ' PO-WHITESPACE ',
        deliverable: ' One short video ',
        quoted_price: 1200
      },
      cost_quoted: '1200'
    }
  });

  assert.deepEqual(replay, first);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM collaborations').get().count, 4);
});

test('linked v2 orders store canonical commercial terms, project creator cost, and archive every term', (t) => {
  const db = openCampaignDatabase(t);
  const fixture = seedFixture(db);
  const service = createCampaignCollaborationService(db);
  const created = service.createLinked({
    userId: 2,
    requestId: 'collaboration-v2-commercial-terms',
    idempotencyKey: 'collaboration-v2-commercial-terms-0001',
    body: {
      campaign_id: 7001,
      influencer_id: fixture.influencerId,
      resource: {
        schema: 'turingmarket.collaboration-order.v2',
        project_name: ' Autumn launch ',
        product_name: ' Portable power station ',
        order_type: 'retainer',
        order_reference: ' PO-V2-7001 ',
        deliverable: ' Four short videos per month ',
        creator_cost: '1200',
        client_quote: '1800',
        currency: 'USD',
        payment_terms: 'net_30'
      },
      cost_quoted: 1200,
      notes: 'Commercial terms approved'
    }
  });

  const expectedResource = {
    schema: 'turingmarket.collaboration-order.v2',
    project_name: 'Autumn launch',
    product_name: 'Portable power station',
    order_type: 'retainer',
    order_reference: 'PO-V2-7001',
    deliverable: 'Four short videos per month',
    creator_cost: 1200,
    client_quote: 1800,
    currency: 'USD',
    margin_amount: 600,
    payment_terms: 'net_30'
  };
  assert.equal(created.status, 201);
  assert.deepEqual(JSON.parse(db.prepare('SELECT proposal_notes FROM collaborations WHERE id=?').get(created.body.id).proposal_notes), expectedResource);
  assert.equal(db.prepare('SELECT cost_quoted FROM collaborations WHERE id=?').get(created.body.id).cost_quoted, 1200);
  const archive = JSON.parse(db.prepare(`
    SELECT content FROM knowledge_entries
    WHERE source_type='campaign_collaboration' AND source_id=?
  `).get(`${created.body.id}:1`).content);
  assert.equal(archive.cost_quoted, 1200);
  assert.deepEqual(archive.resource, expectedResource);
});

test('linked v2 order rejects a conflicting top-level creator cost before idempotency reservation', (t) => {
  const db = openCampaignDatabase(t);
  const fixture = seedFixture(db);
  const service = createCampaignCollaborationService(db);
  const before = collaborationWriteState(db);

  assert.throws(
    () => service.createLinked({
      userId: 2,
      requestId: 'collaboration-v2-creator-cost-conflict',
      idempotencyKey: 'collaboration-v2-creator-cost-conflict-0001',
      body: {
        campaign_id: 7001,
        influencer_id: fixture.influencerId,
        resource: {
          schema: 'turingmarket.collaboration-order.v2',
          creator_cost: 1200,
          client_quote: 1800
        },
        cost_quoted: 1000
      }
    }),
    (error) => error && error.statusCode === 400 && error.code === 'RESOURCE_PRICE_MISMATCH'
  );
  assert.deepEqual(collaborationWriteState(db), before);
});

test('linked creation rejects reserved v2 proposal notes before any write or reservation', (t) => {
  const db = openCampaignDatabase(t);
  const fixture = seedFixture(db);
  const service = createCampaignCollaborationService(db);
  const before = collaborationWriteState(db);

  assert.throws(
    () => service.createLinked({
      userId: 2,
      requestId: 'collaboration-v2-proposal-notes-bypass',
      idempotencyKey: 'collaboration-v2-proposal-notes-bypass-0001',
      body: {
        campaign_id: 7001,
        influencer_id: fixture.influencerId,
        proposal_notes: JSON.stringify({
          schema: 'turingmarket.collaboration-order.v2',
          creator_cost: 1200,
          client_quote: 1800,
          currency: 'EUR'
        }),
        cost_quoted: 1
      }
    }),
    (error) => error && error.statusCode === 400 && error.code === 'RESOURCE_V2_REQUIRES_RESOURCE'
  );
  assert.deepEqual(collaborationWriteState(db), before);
});

test('linked v2 order retries are idempotent after commercial-term whitespace normalization', (t) => {
  const db = openCampaignDatabase(t);
  const fixture = seedFixture(db);
  const service = createCampaignCollaborationService(db);
  const first = service.createLinked({
    userId: 2,
    requestId: 'collaboration-v2-whitespace-first',
    idempotencyKey: 'collaboration-v2-whitespace-0001',
    body: {
      campaign_id: 7001,
      influencer_id: fixture.influencerId,
      resource: {
        schema: 'turingmarket.collaboration-order.v2',
        project_name: 'Autumn launch',
        order_reference: 'PO-V2-WHITESPACE',
        deliverable: 'One short video',
        creator_cost: '1200',
        client_quote: '1800',
        currency: 'USD',
        payment_terms: 'net_30'
      },
      cost_quoted: 1200
    }
  });
  const replay = service.createLinked({
    userId: 2,
    requestId: 'collaboration-v2-whitespace-replay',
    idempotencyKey: 'collaboration-v2-whitespace-0001',
    body: {
      campaign_id: 7001,
      influencer_id: fixture.influencerId,
      resource: {
        schema: ' turingmarket.collaboration-order.v2 ',
        project_name: '  Autumn launch  ',
        order_reference: ' PO-V2-WHITESPACE ',
        deliverable: ' One short video ',
        creator_cost: 1200,
        client_quote: 1800,
        currency: ' USD ',
        payment_terms: ' net_30 '
      },
      cost_quoted: '1200'
    }
  });

  assert.deepEqual(replay, first);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM collaborations').get().count, 4);
});

test('collaboration list exposes campaign workspace context and filters to the selected campaign', (t) => {
  const db = openCampaignDatabase(t);
  const fixture = seedFixture(db);
  const service = createCampaignCollaborationService(db);
  const restricted = seedRestrictedCampaign(db, fixture);

  const selected = service.list({ userId: 2, campaignId: 7001 });
  assert.equal(selected.collaborations.length, 1);
  const collaboration = selected.collaborations[0];
  assert.deepEqual({
    id: collaboration.id,
    influencer_id: collaboration.influencer_id,
    status: collaboration.status,
    row_version: collaboration.row_version,
    campaign_id: collaboration.campaign_id,
    campaign_name: collaboration.campaign_name,
    campaign_lifecycle_state: collaboration.campaign_lifecycle_state,
    campaign_operational_status: collaboration.campaign_operational_status,
    active_relations: collaboration.active_relations
  }, {
    id: 7101,
    influencer_id: fixture.influencerId,
    status: 'confirmed',
    row_version: 1,
    campaign_id: 7001,
    campaign_name: 'Collaboration authorization',
    campaign_lifecycle_state: 'lead',
    campaign_operational_status: 'active',
    active_relations: ['order']
  });

  const restrictedSelection = service.list({ userId: 2, campaignId: restricted.campaignId });
  assert.deepEqual(restrictedSelection, { collaborations: [] });
});

test('linked update fences stale versions and replays the final authorized transition', (t) => {
  const db = openCampaignDatabase(t);
  seedFixture(db);
  const service = createCampaignCollaborationService(db);
  const input = {
    userId: 2,
    collaborationId: 7101,
    requestId: 'collaboration-update-test',
    idempotencyKey: 'collaboration-update-0001',
    body: { campaign_id: 7001, expected_version: 1, reason: 'Launch approved', status: 'live' }
  };
  const result = service.updateLinked(input);
  assert.deepEqual(result, {
    status: 200,
    body: { success: true, campaign_id: 7001, row_version: 2, active_relations: ['order'] }
  });
  assert.deepEqual(service.updateLinked(input), result);
  assert.throws(() => service.updateLinked({
    ...input,
    idempotencyKey: 'collaboration-update-0002',
    body: { ...input.body, expected_version: 1, status: 'completed' }
  }), (error) => error && error.code === 'STALE_COLLABORATION_VERSION');
});

test('linked update adopts an authorized never-classified collaboration as the order root', (t) => {
  const db = openCampaignDatabase(t);
  const fixture = seedFixture(db);
  const service = createCampaignCollaborationService(db);
  db.prepare(`
    INSERT INTO collaborations (
      id,influencer_id,user_id,status,cost_quoted,cost_actual,row_version,cost_actual_confirmed
    ) VALUES (7110,?,2,'contract_sent',125,100,1,0)
  `).run(fixture.influencerId);
  const input = {
    userId: 2,
    collaborationId: 7110,
    requestId: 'collaboration-adoption-test',
    idempotencyKey: 'collaboration-adoption-0001',
    body: {
      campaign_id: 7001,
      expected_version: 1,
      reason: 'Adopt existing order',
      campaign_relation: 'order'
    }
  };

  const adopted = service.updateLinked(input);
  assert.deepEqual(adopted, {
    status: 200,
    body: {
      success: true,
      campaign_id: 7001,
      row_version: 2,
      active_relations: ['order']
    }
  });
  assert.deepEqual(service.updateLinked(input), adopted);
  const links = db.prepare(`
    SELECT relation_type,bundle_id,revoked_at
    FROM campaign_record_links
    WHERE record_type='collaboration' AND record_id='7110'
    ORDER BY id
  `).all();
  assert.equal(links.length, 1);
  assert.match(links[0].bundle_id, /^[0-9a-f]{64}$/);
  assert.deepEqual(links.map((row) => row.relation_type), ['order']);
  assert.equal(links[0].revoked_at, null);
  assert.deepEqual(
    db.prepare('SELECT status,row_version FROM collaborations WHERE id=7110').get(),
    { status: 'contract_sent', row_version: 2 }
  );
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count
    FROM campaign_events
    WHERE campaign_id=7001 AND event_type='link_attached'
  `).get().count, 1);
});

test('linked update rejects a caller-asserted contracted v2 row without checkpoint evidence', (t) => {
  const db = openCampaignDatabase(t);
  const fixture = seedFixture(db);
  const service = createCampaignCollaborationService(db);
  db.prepare(`
    INSERT INTO collaborations (
      id,influencer_id,user_id,status,cost_quoted,cost_actual,row_version,
      cost_actual_confirmed,proposal_notes
    ) VALUES (7110,?,2,'contracted',100,100,1,0,?)
  `).run(fixture.influencerId, JSON.stringify({
    schema: 'turingmarket.collaboration-order.v2',
    project_name: 'Caller asserted contract',
    product_name: 'Portable power station',
    order_type: 'paid',
    order_reference: 'UNVERIFIED-7110',
    deliverable: 'One dedicated video',
    creator_cost: 100,
    client_quote: 150,
    currency: 'USD',
    margin_amount: 50,
    payment_terms: 'net_30'
  }));
  const before = collaborationWriteState(db);

  assert.throws(
    () => service.updateLinked({
      userId: 2,
      collaborationId: 7110,
      requestId: 'collaboration-unverified-contract-adoption',
      idempotencyKey: 'collaboration-unverified-contract-adoption-0001',
      body: {
        campaign_id: 7001,
        expected_version: 1,
        reason: 'Attempt to adopt unverified signed order',
        status: 'live',
        campaign_relation: 'order'
      }
    }),
    (error) => error && error.code === 'INVALID_COLLABORATION_TRANSITION'
  );
  assert.deepEqual(collaborationWriteState(db), before);
});

test('new settlement alias requires exact request-local status, cost, and confirmation', (t) => {
  const db = openCampaignDatabase(t);
  seedFixture(db);
  const service = createCampaignCollaborationService(db);

  assert.equal(service.updateLinked({
    userId: 2,
    collaborationId: 7101,
    requestId: 'collaboration-execution-test',
    idempotencyKey: 'collaboration-execution-0001',
    body: {
      campaign_id: 7001,
      expected_version: 1,
      reason: 'Execution started',
      status: 'live',
      campaign_relation: 'execution'
    }
  }).body.row_version, 2);
  assert.equal(service.updateLinked({
    userId: 2,
    collaborationId: 7101,
    requestId: 'collaboration-publication-test',
    idempotencyKey: 'collaboration-publication-0001',
    body: {
      campaign_id: 7001,
      expected_version: 2,
      reason: 'Publication verified',
      status: 'completed',
      campaign_relation: 'publication'
    }
  }).body.row_version, 3);

  const beforeInvalidSettlement = collaborationWriteState(db);
  const invalidSettlementBodies = [
    {
      label: 'missing status',
      body: { cost_actual: 100, confirm_cost_actual: true }
    },
    {
      label: 'missing cost',
      body: { status: 'completed', confirm_cost_actual: true }
    },
    {
      label: 'missing confirmation',
      body: { status: 'completed', cost_actual: 100 }
    }
  ];
  for (const [index, invalid] of invalidSettlementBodies.entries()) {
    assert.throws(
      () => service.updateLinked({
        userId: 2,
        collaborationId: 7101,
        requestId: `collaboration-settlement-invalid-${index}`,
        idempotencyKey: `collaboration-settlement-invalid-000${index}`,
        body: {
          campaign_id: 7001,
          expected_version: 3,
          reason: `Reject settlement ${invalid.label}`,
          campaign_relation: 'settlement',
          ...invalid.body
        }
      }),
      (error) => error && error.code === 'INVALID_COLLABORATION_TRANSITION'
    );
    assert.deepEqual(collaborationWriteState(db), beforeInvalidSettlement);
  }
  assert.throws(
    () => service.updateLinked({
      userId: 2,
      collaborationId: 7101,
      requestId: 'collaboration-settlement-noncanonical',
      idempotencyKey: 'collaboration-settlement-invalid-0003',
      body: {
        campaign_id: 7001,
        expected_version: 3,
        reason: 'Reject noncanonical settlement cost',
        status: 'completed',
        campaign_relation: 'settlement',
        cost_actual: 100.5,
        confirm_cost_actual: true
      }
    }),
    (error) => error && error.code === 'INVALID_CAMPAIGN_INPUT'
  );
  assert.deepEqual(collaborationWriteState(db), beforeInvalidSettlement);

  const settled = service.updateLinked({
    userId: 2,
    collaborationId: 7101,
    requestId: 'collaboration-settlement-test',
    idempotencyKey: 'collaboration-settlement-0001',
    body: {
      campaign_id: 7001,
      expected_version: 3,
      reason: 'Settlement confirmed',
      status: 'completed',
      campaign_relation: 'settlement',
      cost_actual: 100,
      confirm_cost_actual: true
    }
  });
  assert.deepEqual(settled.body.active_relations, [
    'order',
    'execution',
    'publication',
    'settlement'
  ]);
  assert.equal(settled.body.row_version, 4);
  const aliases = db.prepare(`
    SELECT relation_type,bundle_id
    FROM campaign_record_links
    WHERE campaign_id=7001 AND record_type='collaboration'
      AND record_id='7101' AND revoked_at IS NULL
    ORDER BY id
  `).all();
  assert.deepEqual(aliases.map((row) => row.relation_type), [
    'order',
    'execution',
    'publication',
    'settlement'
  ]);
  assert.equal(new Set(aliases.map((row) => row.bundle_id)).size, 1);
  assert.equal(
    db.prepare('SELECT cost_actual_confirmed FROM collaborations WHERE id=7101').get()
      .cost_actual_confirmed,
    1
  );
});

test('pre-settled collaboration cost edit is accepted and clears confirmation', (t) => {
  const db = openCampaignDatabase(t);
  seedFixture(db);
  const service = createCampaignCollaborationService(db);
  establishSettlementAlias(service, 'collaboration-pre-settlement');
  const before = collaborationWriteState(db);
  const preSettlementEdit = service.updateLinked({
    userId: 2,
    collaborationId: 7101,
    requestId: 'collaboration-pre-settlement-cost-edit',
    idempotencyKey: 'collaboration-pre-settlement-cost-0001',
    body: {
      campaign_id: 7001,
      expected_version: 4,
      reason: 'Correct cost before settlement lifecycle',
      cost_actual: 125
    }
  });
  assert.equal(preSettlementEdit.status, 200);
  assert.equal(preSettlementEdit.body.row_version, 5);
  assert.deepEqual(db.prepare(`
    SELECT cost_actual,cost_actual_confirmed,row_version
    FROM collaborations WHERE id=7101
  `).get(), { cost_actual: 125, cost_actual_confirmed: 0, row_version: 5 });
  assert.equal(collaborationWriteState(db).links, before.links);
  assert.equal(collaborationWriteState(db).events, before.events);
  assert.equal(collaborationWriteState(db).archives, before.archives + 1);
  assert.equal(collaborationWriteState(db).reservations, before.reservations + 1);
});

for (const lifecycleState of ['settled', 'reviewed']) {
  test(`${lifecycleState} cost edit requires a replayable same-request reconfirmation`, (t) => {
    const db = openCampaignDatabase(t);
    seedFixture(db);
    const service = createCampaignCollaborationService(db);
    establishSettlementAlias(service, `collaboration-${lifecycleState}`);
    db.prepare('UPDATE campaigns SET lifecycle_state=? WHERE id=7001').run(lifecycleState);
    const before = collaborationWriteState(db);
    const missingConfirmationInput = {
      userId: 2,
      collaborationId: 7101,
      requestId: `collaboration-${lifecycleState}-reconfirm-required`,
      idempotencyKey: `collaboration-${lifecycleState}-reconfirm-0001`,
      body: {
        campaign_id: 7001,
        expected_version: 4,
        reason: 'Correct final cost',
        cost_actual: 130
      }
    };
    const confirmationRequired = service.updateLinked(missingConfirmationInput);
    assert.deepEqual(confirmationRequired, {
      status: 409,
      body: {
        error: 'Cost confirmation is required.',
        code: 'COLLABORATION_COST_CONFIRMATION_REQUIRED'
      }
    });
    assert.deepEqual(service.updateLinked(missingConfirmationInput), confirmationRequired);
    const afterRejection = collaborationWriteState(db);
    assert.deepEqual(afterRejection.collaboration, before.collaboration);
    assert.equal(afterRejection.links, before.links);
    assert.equal(afterRejection.archives, before.archives);
    assert.equal(afterRejection.events, before.events);
    assert.equal(afterRejection.reservations, before.reservations + 1);
    const retainedError = db.prepare(`
      SELECT state,status_code,response_json
      FROM request_idempotency
      WHERE idempotency_key=?
    `).get(missingConfirmationInput.idempotencyKey);
    assert.deepEqual({
      state: retainedError.state,
      status_code: retainedError.status_code,
      response: JSON.parse(retainedError.response_json)
    }, {
      state: 'completed',
      status_code: 409,
      response: confirmationRequired.body
    });

    const reconfirmed = service.updateLinked({
      ...missingConfirmationInput,
      idempotencyKey: `collaboration-${lifecycleState}-reconfirm-0002`,
      body: {
        ...missingConfirmationInput.body,
        status: 'completed',
        confirm_cost_actual: true
      }
    });
    assert.equal(reconfirmed.status, 200);
    assert.equal(reconfirmed.body.row_version, 5);
    assert.deepEqual(db.prepare(`
      SELECT cost_actual,cost_actual_confirmed,row_version
      FROM collaborations WHERE id=7101
    `).get(), { cost_actual: 130, cost_actual_confirmed: 1, row_version: 5 });
  });
}

test('collaboration cancellation requires hold and revokes its complete active alias bundle', (t) => {
  const db = openCampaignDatabase(t);
  seedFixture(db);
  const service = createCampaignCollaborationService(db);
  const activeCancellation = {
    userId: 2,
    collaborationId: 7101,
    requestId: 'collaboration-cancel-active',
    idempotencyKey: 'collaboration-cancel-active-0001',
    body: {
      campaign_id: 7001,
      expected_version: 1,
      reason: 'Partner withdrew',
      action: 'cancel'
    }
  };
  assert.throws(
    () => service.updateLinked(activeCancellation),
    (error) => error && error.code === 'INVALID_COLLABORATION_TRANSITION'
  );
  assert.deepEqual(
    db.prepare('SELECT status,row_version FROM collaborations WHERE id=7101').get(),
    { status: 'confirmed', row_version: 1 }
  );

  db.prepare("UPDATE campaigns SET operational_status='on_hold' WHERE id=7001").run();
  const input = {
    ...activeCancellation,
    requestId: 'collaboration-cancel-held',
    idempotencyKey: 'collaboration-cancel-held-0001'
  };
  const cancelled = service.updateLinked(input);
  assert.deepEqual(cancelled, {
    status: 200,
    body: {
      success: true,
      campaign_id: 7001,
      row_version: 2,
      active_relations: []
    }
  });
  assert.deepEqual(service.updateLinked(input), cancelled);
  assert.deepEqual(
    db.prepare('SELECT status,row_version FROM collaborations WHERE id=7101').get(),
    { status: 'cancelled', row_version: 2 }
  );
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM campaign_record_links
    WHERE campaign_id=7001 AND record_type='collaboration'
      AND record_id='7101' AND revoked_at IS NULL
  `).get().count, 0);
  assert.deepEqual(
    db.prepare('SELECT operational_status,row_version FROM campaigns WHERE id=7001').get(),
    { operational_status: 'on_hold', row_version: 1 }
  );
  const event = db.prepare(`
    SELECT event_type,reason,source,metadata_json
    FROM campaign_events WHERE campaign_id=7001
  `).get();
  assert.equal(event.event_type, 'link_revoked');
  assert.equal(event.reason, 'Partner withdrew');
  assert.equal(event.source, 'collaboration_link');
  assert.deepEqual(JSON.parse(event.metadata_json).relation_types, ['order']);
});

test('ordered-stage collaboration cancellation atomically cancels the campaign and linked nonterminal peers', (t) => {
  const db = openCampaignDatabase(t);
  const fixture = seedFixture(db);
  const service = createCampaignCollaborationService(db);
  const insert = db.prepare(`
    INSERT INTO collaborations (
      id,influencer_id,user_id,status,cost_quoted,cost_actual,row_version,cost_actual_confirmed
    ) VALUES (?,?,?,?,100,100,1,?)
  `);
  insert.run(7111, fixture.influencerId, 2, 'contracted', 0);
  insert.run(7112, fixture.influencerId, 2, 'confirmed', 0);
  insert.run(7113, fixture.influencerId, 2, 'completed', 1);
  const targetBundle = sha256('collaboration-cascade-target');
  insertCampaignLink(db, {
    orgId: fixture.orgId,
    collaborationId: 7111,
    relationType: 'order',
    bundleId: targetBundle
  });
  insertCampaignLink(db, {
    orgId: fixture.orgId,
    collaborationId: 7111,
    relationType: 'execution',
    bundleId: targetBundle
  });
  insertCampaignLink(db, {
    orgId: fixture.orgId,
    collaborationId: 7112,
    relationType: 'order',
    bundleId: sha256('collaboration-cascade-peer')
  });
  const completedBundle = sha256('collaboration-cascade-completed');
  for (const relationType of ['order', 'execution', 'publication', 'settlement']) {
    insertCampaignLink(db, {
      orgId: fixture.orgId,
      collaborationId: 7113,
      relationType,
      bundleId: completedBundle
    });
  }
  db.prepare(`
    UPDATE campaigns
    SET lifecycle_state='ordered',operational_status='on_hold'
    WHERE id=7001
  `).run();
  const input = {
    userId: 2,
    collaborationId: 7111,
    requestId: 'collaboration-cascade-cancel',
    idempotencyKey: 'collaboration-cascade-0001',
    body: {
      campaign_id: 7001,
      expected_version: 1,
      reason: 'Stop ordered campaign',
      action: 'cancel'
    }
  };

  const cancelled = service.updateLinked(input);
  assert.deepEqual(cancelled, {
    status: 200,
    body: {
      success: true,
      campaign_id: 7001,
      row_version: 2,
      active_relations: []
    }
  });
  assert.deepEqual(service.updateLinked(input), cancelled);
  assert.deepEqual(
    db.prepare('SELECT operational_status,row_version FROM campaigns WHERE id=7001').get(),
    { operational_status: 'cancelled', row_version: 2 }
  );
  assert.deepEqual(db.prepare(`
    SELECT id,status,row_version
    FROM collaborations
    WHERE id IN (7101,7111,7112,7113)
    ORDER BY id
  `).all(), [
    { id: 7101, status: 'cancelled', row_version: 2 },
    { id: 7111, status: 'cancelled', row_version: 2 },
    { id: 7112, status: 'cancelled', row_version: 2 },
    { id: 7113, status: 'completed', row_version: 1 }
  ]);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count
    FROM campaign_record_links
    WHERE campaign_id=7001 AND record_type='collaboration'
      AND record_id IN ('7101','7111','7112') AND revoked_at IS NULL
  `).get().count, 0);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count
    FROM campaign_record_links
    WHERE campaign_id=7001 AND record_type='collaboration'
      AND record_id='7113' AND revoked_at IS NULL
  `).get().count, 4);
  const event = db.prepare(`
    SELECT event_type,source,metadata_json
    FROM campaign_events WHERE campaign_id=7001
  `).get();
  assert.equal(event.event_type, 'operational_status_changed');
  assert.equal(event.source, 'collaboration_link');
  assert.deepEqual(JSON.parse(event.metadata_json), {
    previous_status: 'on_hold',
    next_status: 'cancelled',
    previous_version: 1,
    next_version: 2
  });
});

test('real BEGIN IMMEDIATE workers serialize collaboration version races to one durable winner', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-collaboration-race-'));
  const dbPath = path.join(tempRoot, 'campaign.db');
  const setup = new Database(dbPath);
  const workers = [];
  let verifier;
  try {
    setup.pragma('busy_timeout = 5000');
    assert.deepEqual(migrationService.runMigrations(setup, {
      rootDir: SERVER_ROOT,
      registeredMigrations: CAMPAIGN_MIGRATIONS
    }), { status: 'managed', currentVersion: 5 });
    setup.pragma('journal_mode = WAL');
    seedFixture(setup);
    setup.close();

    for (const [index, status] of ['contract_sent', 'live'].entries()) {
      workers.push(createCollaborationWorker({
        databaseModulePath: require.resolve('better-sqlite3'),
        servicePath: path.join(SERVER_ROOT, 'services', 'campaign_collaboration_service.js'),
        dbPath,
        input: {
          userId: 2,
          collaborationId: 7101,
          requestId: `collaboration-race-${index}`,
          idempotencyKey: `collaboration-race-000${index + 1}`,
          body: {
            campaign_id: 7001,
            expected_version: 1,
            reason: `Concurrent transition ${index}`,
            status
          }
        }
      }));
    }
    await Promise.all(workers.map(({ ready }) => ready));
    for (const { worker } of workers) worker.postMessage({ type: 'start' });
    const outcomes = await Promise.all(workers.map(({ result }) => result));
    assert.equal(outcomes.filter((outcome) => outcome.result).length, 1);
    assert.deepEqual(
      outcomes.filter((outcome) => outcome.error).map((outcome) => outcome.error.code),
      ['STALE_COLLABORATION_VERSION']
    );

    verifier = new Database(dbPath, { readonly: true, fileMustExist: true });
    const collaboration = verifier.prepare(`
      SELECT status,row_version FROM collaborations WHERE id=7101
    `).get();
    assert.equal(['contract_sent', 'live'].includes(collaboration.status), true);
    assert.equal(collaboration.row_version, 2);
    assert.equal(verifier.prepare(`
      SELECT COUNT(*) AS count FROM knowledge_entries
      WHERE source_type='campaign_collaboration'
    `).get().count, 1);
    assert.equal(verifier.prepare(`
      SELECT COUNT(*) AS count FROM request_idempotency WHERE state='completed'
    `).get().count, 1);
    assert.equal(verifier.prepare(`
      SELECT COUNT(*) AS count FROM request_idempotency WHERE state='processing'
    `).get().count, 0);
  } finally {
    await Promise.allSettled(workers.map(({ worker }) => worker.terminate()));
    if (verifier && verifier.open) verifier.close();
    if (setup.open) setup.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

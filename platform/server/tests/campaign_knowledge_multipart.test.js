'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const idempotencyService = require('../services/idempotency_service');
const knowledgeService = require('../services/knowledge_service');
const {
  CampaignLinkServiceError,
  createCampaignLinkService
} = require('../services/campaign_link_service');

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
  return crypto.createHash('sha256').update(value).digest('hex');
}

function contractFramedSha256(values) {
  const frames = values.map((value) => {
    const payload = Buffer.from(String(value), 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(payload.length);
    return Buffer.concat([length, payload]);
  });
  return sha256(Buffer.concat(frames));
}

function campaignSourceIdentityDigest(values) {
  return contractFramedSha256([
    'tm-knowledge-source-v1',
    values.organizationId,
    values.campaignId,
    values.sourceType,
    values.sourceId,
    values.entryType,
    ''
  ]);
}

function knowledgeContentDigest(values) {
  return contractFramedSha256([
    'tm-knowledge-content-v1',
    values.entryType,
    values.title,
    values.summary,
    values.content,
    values.tagsJson,
    values.visibility
  ]);
}

function openDatabase() {
  const db = new Database(':memory:');
  migrationService.runMigrations(db, {
    rootDir: SERVER_ROOT,
    registeredMigrations: MIGRATIONS
  });
  return db;
}

function createContext(db) {
  const identity = db.prepare(`
    SELECT organization.id AS orgId,user.id AS userId,membership.team_id AS teamId
    FROM organizations organization
    JOIN organization_memberships organization_membership
      ON organization_membership.org_id=organization.id
      AND organization_membership.status='active'
    JOIN users user
      ON user.id=organization_membership.user_id AND user.is_active=1
    JOIN team_memberships membership
      ON membership.org_id=organization.id AND membership.user_id=user.id
      AND membership.status='active'
    WHERE organization.code='turingmarket-default'
    ORDER BY CASE WHEN organization_membership.role_code='org_admin' THEN 0 ELSE 1 END,
      user.id,membership.team_id
    LIMIT 1
  `).get();
  assert.ok(identity);
  const context = {
    ...identity,
    customerId: 971001,
    opportunityId: 972001,
    campaignId: 973001,
    sessionToken: 'multipart-knowledge-session'
  };
  db.prepare(`
    INSERT INTO customers (
      id,brand_name,company_name,stage,source,created_by,assigned_to
    ) VALUES (@customerId,'Multipart fixture','Multipart Ltd','qualified','test',@userId,@userId)
  `).run(context);
  db.prepare(`
    INSERT INTO opportunities (
      id,customer_id,name,stage,value,win_probability,product_name,channel_type,created_by
    ) VALUES (
      @opportunityId,@customerId,'Multipart upload','proposal',1000,50,
      'Knowledge','influencer',@userId
    )
  `).run(context);
  db.prepare(`
    INSERT INTO campaigns (
      id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,
      lifecycle_state,operational_status,row_version
    ) VALUES (
      @campaignId,@orgId,'Multipart upload',@customerId,@opportunityId,
      @userId,@teamId,'lead','active',1
    )
  `).run(context);
  db.prepare(`
    INSERT INTO sessions (user_id,token,expires_at)
    VALUES (@userId,@sessionToken,datetime('now','+1 day'))
  `).run(context);
  return context;
}

function createAdmission(db, context, label) {
  const requestHash = sha256(`parser-admission:${label}`);
  const key = `parser-${sha256(`parser-key:${label}`)}`;
  let reservation;
  db.transaction(() => {
    reservation = idempotencyService.reserveProcessingInTransaction(db, {
      organizationId: context.orgId,
      actorUserId: context.userId,
      campaignId: null,
      secondaryCampaignId: null,
      resourceClaim: null,
      scope: 'parser.knowledge-upload.admission',
      key,
      requestHash,
      expectedEventCount: 0,
      operationTimeoutSeconds: 90
    });
  }).immediate();
  assert.equal(reservation.state, 'reserved');
  return Object.freeze({
    ...reservation,
    requestHash,
    key,
    route: 'parser.knowledge-upload',
    organizationId: context.orgId,
    userId: context.userId
  });
}

function freshAuthority(context, calls = []) {
  return ({ db, phase, userId, organizationId, campaignId }) => {
    calls.push(phase);
    const current = db.prepare(`
      SELECT user.id AS userId,membership.org_id AS organizationId,
        campaign.id AS campaignId
      FROM sessions session
      JOIN users user
        ON user.id=session.user_id AND user.is_active=1
      JOIN organization_memberships membership
        ON membership.user_id=user.id AND membership.status='active'
      JOIN campaigns campaign
        ON campaign.id=? AND campaign.org_id=membership.org_id
      WHERE session.token=? AND datetime(session.expires_at)>CURRENT_TIMESTAMP
        AND user.id=? AND membership.org_id=?
      LIMIT 1
    `).get(campaignId, context.sessionToken, userId, organizationId);
    if (!current) {
      throw new CampaignLinkServiceError(
        401,
        'AUTHORITY_REVOKED',
        'Current upload authority was revoked.'
      );
    }
    return current;
  };
}

function knowledgeBody(context, label, overrides = {}) {
  return {
    campaign_id: context.campaignId,
    entry_type: 'uploaded_document',
    title: `Multipart ${label}`,
    summary: `Multipart ${label} summary`,
    content: `Multipart ${label} content`,
    tags: ['multipart', 'upload'],
    source_type: 'knowledge_upload',
    source_id: `${label}.txt`,
    visibility: 'private',
    metadata: {
      originalname: `${label}.txt`,
      mimetype: 'text/plain',
      size: 24,
      kind: 'document',
      row_count: 0,
      parser: 'fixture',
      fallback: false,
      warning: null
    },
    ...overrides
  };
}

function createLifecycle(admission, options = {}) {
  let calls = 0;
  return {
    lifecycle: Object.freeze({
      completeAdmissionInTransaction(db) {
        calls += 1;
        if (options.error) throw options.error;
        return idempotencyService.completeAdmissionInTransaction(db, {
          ledgerId: admission.ledgerId,
          requestHash: admission.requestHash,
          leaseToken: admission.leaseToken
        });
      }
    }),
    calls: () => calls
  };
}

function createFinalizer(service, context, admission, label, overrides = {}) {
  return service.createMultipartKnowledgeFinalizer({
    campaignId: Object.hasOwn(overrides, 'campaignId')
      ? overrides.campaignId
      : context.campaignId,
    idempotencyKey: Object.hasOwn(overrides, 'idempotencyKey')
      ? overrides.idempotencyKey
      : `multipart-upload-${label}`,
    canonicalRequestHash: overrides.canonicalRequestHash || sha256(`multipart:${label}`),
    requestId: `multipart-request-${label}`,
    admission,
    authority: {
      userId: context.userId,
      organizationId: context.orgId,
      assertFresh: overrides.assertFresh || freshAuthority(context, overrides.calls)
    }
  });
}

function finalize(finalizer, context, admission, label, overrides = {}) {
  const completion = createLifecycle(admission, overrides.lifecycle || {});
  const result = finalizer({
    body: knowledgeBody(context, label, overrides.body),
    rows: Object.hasOwn(overrides, 'rows') ? overrides.rows : 0,
    lifecycle: completion.lifecycle
  });
  return { result, completion };
}

function businessState(db) {
  return {
    entries: db.prepare(`
      SELECT COUNT(*) AS count FROM knowledge_entries
      WHERE source_type='knowledge_upload'
    `).get().count,
    chunks: db.prepare(`
      SELECT COUNT(*) AS count
      FROM knowledge_chunks chunk
      JOIN knowledge_entries entry ON entry.id=chunk.entry_id
      WHERE entry.source_type='knowledge_upload'
    `).get().count,
    fts: db.prepare(`
      SELECT COUNT(*) AS count
      FROM knowledge_chunks_fts fts
      JOIN knowledge_entries entry ON entry.id=fts.entry_id
      WHERE entry.source_type='knowledge_upload'
    `).get().count,
    links: db.prepare(`
      SELECT COUNT(*) AS count FROM campaign_record_links
      WHERE record_type='knowledge_entry' AND relation_type='knowledge'
    `).get().count,
    events: db.prepare(`
      SELECT COUNT(*) AS count FROM campaign_events
      WHERE source='knowledge_link'
    `).get().count,
    linkedLedgers: db.prepare(`
      SELECT COUNT(*) AS count FROM request_idempotency
      WHERE scope='knowledge.upload.linked'
    `).get().count
  };
}

function admissionState(db, admission) {
  return db.prepare(`
    SELECT state,response_kind,status_code
    FROM request_idempotency WHERE id=?
  `).get(admission.ledgerId);
}

function gaugeUsage(db, scopeType, scopeId) {
  const usage = {
    entries: null,
    chunks: null,
    payloadBytes: null,
    references: null
  };
  const fields = {
    entries: 'entries',
    chunks: 'chunks',
    payload_bytes: 'payloadBytes',
    references: 'references'
  };
  for (const row of db.prepare(`
    SELECT metric,usage_value
    FROM knowledge_capacity_gauges
    WHERE scope_type=? AND scope_id=?
  `).all(scopeType, scopeId)) {
    usage[fields[row.metric]] = row.usage_value;
  }
  return usage;
}

test('demand and proposal links retain exact archives and business artifact metadata', () => {
  const db = openDatabase();
  try {
    const context = createContext(db);
    const service = createCampaignLinkService(db);
    const demand = service.createDemand({
      userId: context.userId,
      requestId: 'metadata-demand-request',
      idempotencyKey: 'metadata-demand-create',
      body: {
        campaign_id: context.campaignId,
        brand_name: 'Exact metadata demand',
        company_name: 'Exact Company',
        product_name: 'Exact Product',
        industry: 'Exact Industry',
        budget: '1234 USD',
        target_market: 'Exact Market',
        platform: 'Exact Platform',
        data_json: { z: { b: 2, a: 1 }, a: ['first', 'second'] }
      }
    });
    const proposalDocument = {
      a: ['first'],
      title: 'Exact metadata proposal',
      z: 2
    };
    const proposalDocumentJson = JSON.stringify(proposalDocument);
    const proposalDocumentDigest = sha256(Buffer.from(proposalDocumentJson, 'utf8'));
    const proposal = service.createProposal({
      userId: context.userId,
      requestId: 'metadata-proposal-request',
      idempotencyKey: 'metadata-proposal-create',
      body: {
        campaign_id: context.campaignId,
        demand_id: demand.body.id,
        template_id: 'metadata-template',
        content: '{"z":2,"title":"Exact metadata proposal","a":["first"]}'
      }
    });

    const expectedDemandContent = JSON.stringify({
      id: demand.body.id,
      brand_name: 'Exact metadata demand',
      company_name: 'Exact Company',
      product_name: 'Exact Product',
      industry: 'Exact Industry',
      budget: '1234 USD',
      target_market: 'Exact Market',
      platform: 'Exact Platform',
      status: 'draft',
      data: { a: ['first', 'second'], z: { a: 1, b: 2 } }
    });
    const expectedProposalContent = JSON.stringify({
      id: proposal.body.id,
      demand_id: demand.body.id,
      title: proposalDocument.title,
      content_sha256: proposalDocumentDigest,
      content: proposalDocument
    });
    const demandTitle = `Campaign demand #${demand.body.id}`;
    const proposalTitle = `Campaign proposal #${proposal.body.id}`;
    const demandTags = '["campaign","demand"]';
    const proposalTags = '["campaign","proposal"]';
    const demandArchive = db.prepare(`
      SELECT id,entry_type,source_type,source_id,title,summary,content,
        tags_json,visibility,metadata_json,created_by,
        source_identity_sha256,content_sha256
      FROM knowledge_entries
      WHERE source_type='campaign_demand' AND source_id=?
    `).get(String(demand.body.id));
    const proposalArchive = db.prepare(`
      SELECT id,entry_type,source_type,source_id,title,summary,content,
        tags_json,visibility,metadata_json,created_by,
        source_identity_sha256,content_sha256
      FROM knowledge_entries
      WHERE source_type='campaign_proposal' AND source_id=?
    `).get(String(proposal.body.id));

    assert.deepEqual({ ...demandArchive, id: undefined }, {
      id: undefined,
      entry_type: 'campaign_demand',
      source_type: 'campaign_demand',
      source_id: demand.body.id,
      title: demandTitle,
      summary: expectedDemandContent,
      content: expectedDemandContent,
      tags_json: demandTags,
      visibility: 'team',
      metadata_json: JSON.stringify({
        artifact_contract: 'tm-business-artifact-v1',
        artifact_state: 'ingested',
        artifact_type: 'requirement_sheet'
      }),
      created_by: context.userId,
      source_identity_sha256: campaignSourceIdentityDigest({
        organizationId: context.orgId,
        campaignId: context.campaignId,
        sourceType: 'campaign_demand',
        sourceId: demand.body.id,
        entryType: 'campaign_demand'
      }),
      content_sha256: knowledgeContentDigest({
        entryType: 'campaign_demand',
        title: demandTitle,
        summary: expectedDemandContent,
        content: expectedDemandContent,
        tagsJson: demandTags,
        visibility: 'team'
      })
    });
    assert.deepEqual({ ...proposalArchive, id: undefined }, {
      id: undefined,
      entry_type: 'campaign_proposal',
      source_type: 'campaign_proposal',
      source_id: proposal.body.id,
      title: proposalTitle,
      summary: expectedProposalContent,
      content: expectedProposalContent,
      tags_json: proposalTags,
      visibility: 'team',
      metadata_json: JSON.stringify({
        artifact_contract: 'tm-business-artifact-v1',
        artifact_state: 'confirmed',
        artifact_type: 'confirmed_proposal'
      }),
      created_by: context.userId,
      source_identity_sha256: campaignSourceIdentityDigest({
        organizationId: context.orgId,
        campaignId: context.campaignId,
        sourceType: 'campaign_proposal',
        sourceId: proposal.body.id,
        entryType: 'campaign_proposal'
      }),
      content_sha256: knowledgeContentDigest({
        entryType: 'campaign_proposal',
        title: proposalTitle,
        summary: expectedProposalContent,
        content: expectedProposalContent,
        tagsJson: proposalTags,
        visibility: 'team'
      })
    });
    assert.equal(proposal.body.content_sha256, proposalDocumentDigest);
    assert.deepEqual(db.prepare(`
      SELECT record_type,record_id,relation_type,metadata_json
      FROM campaign_record_links
      WHERE campaign_id=? AND revoked_at IS NULL
      ORDER BY id
    `).all(context.campaignId), [
      {
        record_type: 'demand',
        record_id: String(demand.body.id),
        relation_type: 'demand',
        metadata_json: '{}'
      },
      {
        record_type: 'knowledge_entry',
        record_id: String(demandArchive.id),
        relation_type: 'knowledge',
        metadata_json: '{}'
      },
      {
        record_type: 'proposal',
        record_id: String(proposal.body.id),
        relation_type: 'proposal',
        metadata_json: '{}'
      },
      {
        record_type: 'knowledge_entry',
        record_id: String(proposalArchive.id),
        relation_type: 'knowledge',
        metadata_json: '{}'
      }
    ]);

    const userUsage = knowledgeService.userKnowledgeUsage(db, context.userId);
    const campaignUsage = knowledgeService.campaignKnowledgeUsage(db, context.campaignId);
    const organizationUsage = knowledgeService.organizationKnowledgeUsage(
      db,
      context.orgId,
      context.orgId
    );
    for (const usage of [userUsage, campaignUsage, organizationUsage]) {
      assert.equal(usage.entries, 2);
      assert.equal(usage.chunks, 2);
      assert.equal(usage.references, 0);
      assert.ok(usage.payloadBytes > 0);
    }
    assert.deepEqual(gaugeUsage(db, 'user', context.userId), userUsage);
    assert.deepEqual(gaugeUsage(db, 'campaign', context.campaignId), campaignUsage);
    assert.deepEqual(gaugeUsage(db, 'organization', context.orgId), organizationUsage);
  } finally {
    db.close();
  }
});

test('multipart linked knowledge requires idempotency and excludes omitted campaign input', () => {
  const db = openDatabase();
  try {
    const context = createContext(db);
    const service = createCampaignLinkService(db);
    const admission = createAdmission(db, context, 'required');
    assert.throws(
      () => createFinalizer(service, context, admission, 'required', {
        idempotencyKey: null
      }),
      (error) => error.code === 'IDEMPOTENCY_REQUIRED'
    );
    assert.throws(
      () => createFinalizer(service, context, admission, 'required', {
        campaignId: null
      }),
      (error) => error.code === 'INVALID_CAMPAIGN_INPUT'
    );
    assert.deepEqual(businessState(db), {
      entries: 0,
      chunks: 0,
      fts: 0,
      links: 0,
      events: 0,
      linkedLedgers: 0
    });
  } finally {
    db.close();
  }
});

test('multipart linked knowledge preserves upload projection and replays without duplicate writes', () => {
  const db = openDatabase();
  try {
    const context = createContext(db);
    const service = createCampaignLinkService(db);
    const firstAdmission = createAdmission(db, context, 'success-first');
    const firstCalls = [];
    const firstFinalizer = createFinalizer(service, context, firstAdmission, 'success', {
      calls: firstCalls
    });
    const first = finalize(firstFinalizer, context, firstAdmission, 'success', { rows: 4 });

    assert.equal(first.result.status, 200);
    assert.deepEqual(Object.keys(first.result.body), ['entry', 'rows']);
    assert.equal(first.result.body.rows, 4);
    assert.ok(Number.isSafeInteger(first.result.body.entry.id));
    assert.equal(first.completion.calls(), 1);
    assert.deepEqual(firstCalls, ['preauthorize', 'final_transaction']);
    assert.deepEqual(admissionState(db, firstAdmission), {
      state: 'completed',
      response_kind: 'admission',
      status_code: 200
    });
    const afterFirst = businessState(db);
    assert.equal(afterFirst.entries, 1);
    assert.ok(afterFirst.chunks >= 1);
    assert.equal(afterFirst.links, 1);
    assert.equal(afterFirst.events, 1);
    assert.equal(afterFirst.linkedLedgers, 1);

    const replayAdmission = createAdmission(db, context, 'success-replay');
    const replayCalls = [];
    const replayFinalizer = createFinalizer(service, context, replayAdmission, 'success', {
      calls: replayCalls
    });
    const replay = finalize(replayFinalizer, context, replayAdmission, 'success', { rows: 4 });

    assert.deepEqual(replay.result, first.result);
    assert.deepEqual(businessState(db), afterFirst);
    assert.equal(replay.completion.calls(), 1);
    assert.deepEqual(replayCalls, ['preauthorize', 'final_transaction']);
    assert.deepEqual(admissionState(db, replayAdmission), {
      state: 'completed',
      response_kind: 'admission',
      status_code: 200
    });
  } finally {
    db.close();
  }
});

test('multipart canonical hash conflict never completes admission or duplicates knowledge', () => {
  const db = openDatabase();
  try {
    const context = createContext(db);
    const service = createCampaignLinkService(db);
    const firstAdmission = createAdmission(db, context, 'hash-first');
    finalize(
      createFinalizer(service, context, firstAdmission, 'hash-conflict'),
      context,
      firstAdmission,
      'hash-conflict'
    );
    const before = businessState(db);

    const conflictAdmission = createAdmission(db, context, 'hash-conflict');
    const conflictFinalizer = createFinalizer(
      service,
      context,
      conflictAdmission,
      'hash-conflict',
      { canonicalRequestHash: sha256('different multipart bytes') }
    );
    assert.throws(
      () => finalize(
        conflictFinalizer,
        context,
        conflictAdmission,
        'hash-conflict'
      ),
      (error) => error.code === 'IDEMPOTENCY_KEY_REUSED'
    );
    assert.deepEqual(businessState(db), before);
    assert.deepEqual(admissionState(db, conflictAdmission), {
      state: 'processing',
      response_kind: null,
      status_code: null
    });
  } finally {
    db.close();
  }
});

test('revoked session between preauthorization and finalization rolls back all writes', () => {
  const db = openDatabase();
  try {
    const context = createContext(db);
    const service = createCampaignLinkService(db);
    const admission = createAdmission(db, context, 'revoked');
    const calls = [];
    const finalizer = createFinalizer(service, context, admission, 'revoked', { calls });
    assert.deepEqual(calls, ['preauthorize']);

    db.prepare('DELETE FROM sessions WHERE token=?').run(context.sessionToken);
    assert.throws(
      () => finalize(finalizer, context, admission, 'revoked'),
      (error) => error.code === 'AUTHORITY_REVOKED'
    );
    assert.deepEqual(calls, ['preauthorize', 'final_transaction']);
    assert.deepEqual(businessState(db), {
      entries: 0,
      chunks: 0,
      fts: 0,
      links: 0,
      events: 0,
      linkedLedgers: 0
    });
    assert.deepEqual(admissionState(db, admission), {
      state: 'processing',
      response_kind: null,
      status_code: null
    });
  } finally {
    db.close();
  }
});

test('admission completion failure rolls back entry chunks link event gauge and linked ledger', () => {
  const db = openDatabase();
  try {
    const context = createContext(db);
    const service = createCampaignLinkService(db);
    const admission = createAdmission(db, context, 'admission-failure');
    const finalizer = createFinalizer(service, context, admission, 'admission-failure');
    const beforeGauges = db.prepare(`
      SELECT scope_type,scope_id,metric,usage_value,limit_value,threshold_percent
      FROM knowledge_capacity_gauges ORDER BY scope_type,scope_id,metric
    `).all();

    assert.throws(
      () => finalize(finalizer, context, admission, 'admission-failure', {
        lifecycle: { error: new Error('injected admission completion conflict') }
      }),
      /injected admission completion conflict/
    );
    assert.deepEqual(businessState(db), {
      entries: 0,
      chunks: 0,
      fts: 0,
      links: 0,
      events: 0,
      linkedLedgers: 0
    });
    assert.deepEqual(db.prepare(`
      SELECT scope_type,scope_id,metric,usage_value,limit_value,threshold_percent
      FROM knowledge_capacity_gauges ORDER BY scope_type,scope_id,metric
    `).all(), beforeGauges);
    assert.deepEqual(admissionState(db, admission), {
      state: 'processing',
      response_kind: null,
      status_code: null
    });
  } finally {
    db.close();
  }
});

test('knowledge capacity failure rolls back multipart business and admission completion', () => {
  const db = openDatabase();
  try {
    const context = createContext(db);
    db.transaction(() => {
      knowledgeService.refreshKnowledgeCapacityGaugesInTransaction(db, [
        { scopeType: 'user', scopeId: context.userId },
        { scopeType: 'campaign', scopeId: context.campaignId },
        { scopeType: 'organization', scopeId: context.orgId }
      ]);
    }).immediate();
    db.prepare(`
      UPDATE knowledge_capacity_gauges
      SET usage_value=limit_value,threshold_percent=100
      WHERE scope_type='user' AND scope_id=? AND metric='entries'
    `).run(context.userId);

    const service = createCampaignLinkService(db);
    const admission = createAdmission(db, context, 'capacity');
    const finalizer = createFinalizer(service, context, admission, 'capacity');
    const before = businessState(db);
    assert.throws(
      () => finalize(finalizer, context, admission, 'capacity'),
      (error) => error.code === 'KNOWLEDGE_STORAGE_CAPACITY_EXCEEDED'
    );
    assert.deepEqual(businessState(db), before);
    assert.deepEqual(admissionState(db, admission), {
      state: 'processing',
      response_kind: null,
      status_code: null
    });
  } finally {
    db.close();
  }
});

test('campaign archive source conflict rolls back the second multipart attempt', () => {
  const db = openDatabase();
  try {
    const context = createContext(db);
    const service = createCampaignLinkService(db);
    const firstAdmission = createAdmission(db, context, 'archive-first');
    finalize(
      createFinalizer(service, context, firstAdmission, 'archive-source'),
      context,
      firstAdmission,
      'archive-source'
    );
    const before = businessState(db);

    const conflictAdmission = createAdmission(db, context, 'archive-conflict');
    const conflictFinalizer = createFinalizer(
      service,
      context,
      conflictAdmission,
      'archive-conflict'
    );
    assert.throws(
      () => finalize(
        conflictFinalizer,
        context,
        conflictAdmission,
        'archive-source',
        { body: { content: 'Changed content for the same immutable upload source.' } }
      ),
      (error) => error.code === 'KNOWLEDGE_SOURCE_CONTENT_CONFLICT'
    );
    assert.deepEqual(businessState(db), before);
    assert.deepEqual(admissionState(db, conflictAdmission), {
      state: 'processing',
      response_kind: null,
      status_code: null
    });
  } finally {
    db.close();
  }
});

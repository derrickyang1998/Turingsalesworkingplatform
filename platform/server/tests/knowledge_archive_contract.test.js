const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const knowledge = require('../services/knowledge_service');
const idempotency = require('../services/idempotency_service');
const sqliteDigest = require('../services/sqlite_digest_service');
const { createCampaignService } = require('../services/campaign_service');
const { createCampaignLinkService } = require('../services/campaign_link_service');
const { resolveRecordCustody } = require('../services/campaign_access_service');

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
    customerId: 910701,
    opportunityId: 920701,
    campaignId: 930701
  };
  db.prepare(`
    INSERT INTO customers (
      id,brand_name,company_name,stage,source,created_by,assigned_to
    ) VALUES (@customerId,'Wave 2','Wave 2 Ltd','qualified','test',@userId,@userId)
  `).run(context);
  db.prepare(`
    INSERT INTO opportunities (
      id,customer_id,name,stage,value,win_probability,product_name,channel_type,created_by
    ) VALUES (
      @opportunityId,@customerId,'Wave 2 archive','proposal',1000,50,
      'Archive','influencer',@userId
    )
  `).run(context);
  db.prepare(`
    INSERT INTO campaigns (
      id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,
      lifecycle_state,operational_status,row_version
    ) VALUES (
      @campaignId,@orgId,'Wave 2 archive',@customerId,@opportunityId,
      @userId,@teamId,'lead','active',1
    )
  `).run(context);
  return context;
}

function writerOptions(context, sourceId, overrides = {}) {
  return {
    organizationId: context.orgId,
    campaignId: context.campaignId,
    createdBy: context.userId,
    sourceType: 'campaign_demand',
    sourceId,
    entryType: 'campaign_demand',
    title: 'Wave 2 archive',
    summary: 'Wave 2 archive summary',
    content: 'Wave 2 archive content',
    tags: ['campaign', 'demand'],
    visibility: 'team',
    metadata: { schema_version: 1 },
    ...overrides
  };
}

function linkKnowledge(db, context, entryId, label) {
  db.prepare(`
    INSERT INTO campaign_record_links (
      org_id,campaign_id,record_type,bundle_id,record_id,relation_type,
      created_by,metadata_json
    ) VALUES (
      @orgId,@campaignId,'knowledge_entry',@bundleId,@recordId,'knowledge',
      @userId,'{}'
    )
  `).run({
    ...context,
    bundleId: sha256(Buffer.from(`wave2:${label}:${entryId}`, 'utf8')),
    recordId: String(entryId)
  });
}

function settleCampaign(db, context) {
  const body = {
    expected_state: 'published',
    expected_version: 11,
    next_state: 'settled',
    reason: 'Wave 2 settled fixture'
  };
  const requestHash = sqliteDigest.requestHash({
    method: 'POST',
    path: `/api/campaigns/${context.campaignId}/transitions`,
    campaignId: context.campaignId,
    kind: 'json',
    payload: body
  });
  db.transaction(() => {
    const reservation = idempotency.reserveProcessingInTransaction(db, {
      organizationId: context.orgId,
      actorUserId: context.userId,
      campaignId: context.campaignId,
      secondaryCampaignId: null,
      resourceClaim: null,
      scope: 'campaign.transition',
      key: `wave2-settled-${context.campaignId}`,
      requestHash,
      expectedEventCount: 1,
      operationTimeoutSeconds: 60
    });
    db.prepare(`
      UPDATE campaigns
      SET lifecycle_state='settled',row_version=12
      WHERE id=?
    `).run(context.campaignId);
    db.prepare(`
      INSERT INTO campaign_events (
        org_id,campaign_id,event_type,previous_state,next_state,actor_user_id,
        reason,source,metadata_json,correlation_id,audit_fingerprint
      ) VALUES (
        ?,?,'lifecycle_transition','published','settled',?,
        'Wave 2 settled fixture','project_workspace',
        '{"previous_version":11,"next_version":12}',
        'wave2-settled-event',?
      )
    `).run(
      context.orgId,
      context.campaignId,
      context.userId,
      reservation.auditFingerprint
    );
    idempotency.completeJsonInTransaction(db, {
      ledgerId: reservation.ledgerId,
      requestHash,
      leaseToken: reservation.leaseToken,
      statusCode: 200,
      responseBody: { settled: true }
    });
  }).immediate();
}

function reviewInput(context, suffix) {
  return {
    campaignId: context.campaignId,
    userId: context.userId,
    idempotencyKey: `wave2-review-${suffix}`,
    requestId: `wave2-request-${suffix}`,
    body: {
      expected_version: 12,
      title: 'Wave 2 review',
      summary: 'Wave 2 review summary',
      content: 'Wave 2 review content',
      tags: ['creator', 'summer'],
      visibility: 'team',
      reason: 'Wave 2 review approved'
    }
  };
}

function refreshScopes(db, context) {
  db.transaction(() => {
    knowledge.refreshKnowledgeCapacityGaugesInTransaction(db, [
      { scopeType: 'user', scopeId: context.userId },
      { scopeType: 'campaign', scopeId: context.campaignId },
      { scopeType: 'organization', scopeId: context.orgId }
    ]);
  }).immediate();
}

function archiveState(db, context) {
  return {
    entries: db.prepare('SELECT COUNT(*) AS count FROM knowledge_entries').get().count,
    chunks: db.prepare('SELECT COUNT(*) AS count FROM knowledge_chunks').get().count,
    fts: db.prepare('SELECT COUNT(*) AS count FROM knowledge_chunks_fts').get().count,
    links: db.prepare('SELECT COUNT(*) AS count FROM campaign_record_links').get().count,
    events: db.prepare('SELECT COUNT(*) AS count FROM campaign_events').get().count,
    activityLogs: db.prepare('SELECT COUNT(*) AS count FROM activity_log').get().count,
    ledgers: db.prepare('SELECT COUNT(*) AS count FROM request_idempotency').get().count,
    rowVersion: db.prepare('SELECT row_version FROM campaigns WHERE id=?').get(context.campaignId).row_version,
    gauges: db.prepare(`
      SELECT scope_type,scope_id,metric,usage_value,limit_value,threshold_percent
      FROM knowledge_capacity_gauges
      ORDER BY scope_type,scope_id,metric
    `).all()
  };
}

test('business artifact contract deduplicates legacy artifacts and stamps reusable lineage', () => {
  const db = openDatabase();
  try {
    const context = createContext(db);
    const options = {
      artifactType: 'influencer_batch',
      artifactState: 'ingested',
      sourceId: 'wave2-influencer-batch',
      title: 'Wave 2 influencer batch',
      summary: 'One approved influencer batch',
      content: 'Influencer batch content',
      tags: ['campaign', 'influencer'],
      visibility: 'team',
      createdBy: context.userId,
      actorRole: 'user',
      businessType: 'influencer',
      businessId: 'wave2-influencer-batch',
      metadata: { imported: 10 }
    };

    const created = knowledge.ingestBusinessArtifact(db, options);
    const replay = knowledge.ingestBusinessArtifact(db, options);

    assert.equal(created.status, 'created');
    assert.equal(replay.status, 'exact_existing');
    assert.equal(replay.entry.id, created.entry.id);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM knowledge_entries
      WHERE source_type='influencer_import' AND source_id='wave2-influencer-batch'
    `).get().count, 1);
    assert.deepEqual(created.entry.metadata, {
      artifact_contract: 'tm-business-artifact-v1',
      artifact_state: 'ingested',
      artifact_type: 'influencer_batch',
      imported: 10
    });
    const immutableState = archiveState(db, context);
    for (const changed of [
      { content: 'Changed influencer batch content' },
      { metadata: { imported: 11 } },
      { businessId: 'wave2-influencer-batch-moved' }
    ]) {
      assert.throws(
        () => knowledge.ingestBusinessArtifact(db, { ...options, ...changed }),
        (error) => error && error.code === 'KNOWLEDGE_SOURCE_CONTENT_CONFLICT'
      );
    }
    assert.deepEqual(archiveState(db, context), immutableState);
  } finally {
    db.close();
  }
});

test('business artifact contract keeps campaign proposal identity immutable', () => {
  const db = openDatabase();
  try {
    const context = createContext(db);
    const options = {
      artifactType: 'confirmed_proposal',
      artifactState: 'confirmed',
      organizationId: context.orgId,
      campaignId: context.campaignId,
      sourceId: 'wave2-confirmed-proposal',
      title: 'Wave 2 confirmed proposal',
      summary: 'Approved proposal summary',
      content: 'Approved proposal content',
      tags: ['campaign', 'proposal'],
      visibility: 'team',
      createdBy: context.userId,
      metadata: { proposal_version: 1 }
    };
    let created;
    let replay;
    db.transaction(() => {
      created = knowledge.ingestBusinessArtifact(db, options);
      linkKnowledge(db, context, created.entry.id, 'business-artifact-proposal');
      replay = knowledge.ingestBusinessArtifact(db, options);
    }).immediate();

    assert.equal(created.status, 'created');
    assert.equal(replay.status, 'exact_existing');
    assert.equal(replay.entry.id, created.entry.id);
    assert.equal(created.entry.entry_type, 'campaign_proposal');
    assert.equal(created.entry.source_type, 'campaign_proposal');
    assert.equal(created.entry.metadata.artifact_type, 'confirmed_proposal');
    assert.throws(
      () => db.transaction(() => knowledge.ingestBusinessArtifact(db, {
        ...options,
        content: 'Changed proposal content under the same immutable source identity'
      })).immediate(),
      (error) => error && error.code === 'KNOWLEDGE_SOURCE_CONTENT_CONFLICT'
    );
    assert.throws(
      () => db.transaction(() => knowledge.ingestBusinessArtifact(db, {
        ...options,
        metadata: { proposal_version: 2 }
      })).immediate(),
      (error) => error && error.code === 'KNOWLEDGE_SOURCE_CONTENT_CONFLICT'
    );
  } finally {
    db.close();
  }
});

test('business artifact contract rejects invalid lifecycle state without mutation', () => {
  const db = openDatabase();
  try {
    const context = createContext(db);
    const before = archiveState(db, context);
    assert.throws(
      () => knowledge.ingestBusinessArtifact(db, {
        artifactType: 'ppt_output',
        artifactState: 'draft',
        sourceId: 'wave2-draft-ppt',
        title: 'Draft PPT',
        summary: 'Draft output must not become reusable knowledge',
        content: 'Draft PPT content',
        tags: ['ppt'],
        visibility: 'private',
        createdBy: context.userId,
        businessType: 'proposal',
        businessId: 'wave2-draft-ppt'
      }),
      (error) => error && error.code === 'INVALID_BUSINESS_KNOWLEDGE_ARTIFACT'
    );
    assert.throws(
      () => knowledge.ingestBusinessArtifact(db, {
        artifactType: 'influencer_batch',
        artifactState: 'ingested',
        title: 'Missing source identity',
        summary: 'A source identity is required for deterministic deduplication',
        content: 'Missing source identity content',
        tags: ['influencer'],
        visibility: 'team',
        createdBy: context.userId
      }),
      (error) => error && error.code === 'INVALID_BUSINESS_KNOWLEDGE_ARTIFACT'
    );
    assert.deepEqual(archiveState(db, context), before);
  } finally {
    db.close();
  }
});

test('tm-knowledge-chunk-v1 goldens and ordered campaign digests preserve legacy refresh', () => {
  const db = openDatabase();
  try {
    const context = createContext(db);
    assert.deepEqual(knowledge.makeChunks(''), ['']);
    assert.deepEqual(knowledge.makeChunks('a'.repeat(1201)), ['a'.repeat(1200), 'a']);
    assert.deepEqual(knowledge.makeChunks('\u{1f600}'.repeat(1200)), ['\u{1f600}'.repeat(1200)]);
    assert.deepEqual(
      knowledge.makeChunks(`${'a'.repeat(1199)}\n\nb`),
      ['a'.repeat(1199), 'b']
    );

    db.exec('BEGIN IMMEDIATE');
    const options = writerOptions(context, 'chunk-golden', {
      content: ' Alpha\r\n\r\nBeta \u{1f600} '
    });
    const created = knowledge.writeCampaignKnowledgeInTransaction(db, options);
    assert.equal(Buffer.from(created.chunks[0].content, 'utf8').toString('hex'), '416c7068610a0a4265746120f09f9880');
    assert.equal(created.chunks[0].content_sha256, '73a747f2a6e9c5e3e65eb8552d8100319eda2cecae356c8abb7496ecf2fa1b3b');
    linkKnowledge(db, context, created.entry.id, 'chunk-golden');
    db.exec('DROP TRIGGER campaign_knowledge_chunk_content_immutable');
    db.prepare(`
      UPDATE knowledge_chunks SET content_sha256=?
      WHERE entry_id=? AND chunk_index=0
    `).run('0'.repeat(64), created.entry.id);
    assert.throws(
      () => knowledge.writeCampaignKnowledgeInTransaction(db, options),
      (error) => error && error.code === 'KNOWLEDGE_SOURCE_CONTENT_CONFLICT'
    );
    db.exec('ROLLBACK');

    const legacy = knowledge.ingestKnowledge(db, {
      title: 'Legacy refresh',
      content: 'old legacy content',
      source_type: 'manual_upload',
      source_id: 'legacy-refresh.txt',
      visibility: 'shared',
      created_by: context.userId
    });
    const refreshed = knowledge.ingestKnowledge(db, {
      title: 'Legacy refresh',
      content: 'new legacy content',
      source_type: 'manual_upload',
      source_id: 'legacy-refresh.txt',
      visibility: 'shared',
      created_by: context.userId
    });
    assert.equal(refreshed.id, legacy.id);
    assert.equal(refreshed.visibility, 'shared');
    assert.deepEqual(
      db.prepare('SELECT content FROM knowledge_chunks WHERE entry_id=? ORDER BY chunk_index,id').all(legacy.id),
      [{ content: 'new legacy content' }]
    );
  } finally {
    if (db.inTransaction) db.exec('ROLLBACK');
    db.close();
  }
});

test('linked knowledge omission stores private visibility', () => {
  const db = openDatabase();
  try {
    const context = createContext(db);
    const options = writerOptions(context, 'omitted-visibility');
    delete options.visibility;
    let written;
    db.transaction(() => {
      written = knowledge.writeCampaignKnowledgeInTransaction(db, options);
      linkKnowledge(db, context, written.entry.id, 'omitted-visibility');
    }).immediate();
    assert.equal(written.entry.visibility, 'private');
    assert.equal(written.entry.is_public, 0);
  } finally {
    db.close();
  }
});

test('linked knowledge rejects public aliases and non-closed visibility without mutation', () => {
  const db = openDatabase();
  try {
    const context = createContext(db);
    const invalidInputs = [
      ['is-public-alias', { visibility: 'private', is_public: 1 }],
      ['is-public-zero', { visibility: 'private', is_public: 0 }],
      ['is-public-camel', { visibility: 'private', isPublic: false }],
      ['public-visibility', { visibility: 'public' }],
      ['shared-visibility', { visibility: 'shared' }],
      ['unknown-visibility', { visibility: 'organization' }]
    ];
    for (const [sourceId, overrides] of invalidInputs) {
      const before = archiveState(db, context);
      assert.throws(
        () => db.transaction(() => knowledge.writeCampaignKnowledgeInTransaction(
          db,
          writerOptions(context, sourceId, overrides)
        )).immediate(),
        (error) => error && error.code === 'INVALID_CAMPAIGN_INPUT'
      );
      assert.deepEqual(archiveState(db, context), before);
    }
  } finally {
    db.close();
  }
});

test('linked knowledge snapshots nested JSON without invoking hostile accessors', () => {
  const db = openDatabase();
  try {
    const context = createContext(db);
    const service = createCampaignLinkService(db);
    let getterCalls = 0;
    let proxyTrapCalls = 0;
    const accessorMetadata = {};
    Object.defineProperty(accessorMetadata, 'secret', {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error('hostile metadata getter');
      }
    });
    const proxyMetadata = new Proxy({}, {
      ownKeys() {
        proxyTrapCalls += 1;
        throw new Error('hostile metadata proxy');
      }
    });
    const baseBody = {
      campaign_id: context.campaignId,
      entry_type: 'campaign_note',
      title: 'Wave 2 input safety',
      summary: 'Nested JSON must be snapshotted before hashing.',
      content: 'Wave 2 input safety content',
      tags: ['campaign', 'safety'],
      source_type: 'task7_input_safety'
    };

    for (const [suffix, metadata] of [
      ['accessor', accessorMetadata],
      ['proxy', proxyMetadata]
    ]) {
      assert.throws(
        () => service.createKnowledge({
          userId: context.userId,
          idempotencyKey: `wave2-input-safety-${suffix}`,
          requestId: `wave2-input-safety-${suffix}`,
          body: {
            ...baseBody,
            source_id: suffix,
            metadata
          }
        }),
        (error) => (
          error &&
          error.code === 'INVALID_CAMPAIGN_INPUT' &&
          !error.message.includes('hostile')
        )
      );
    }

    assert.equal(getterCalls, 0);
    assert.equal(proxyTrapCalls, 0);
    assert.deepEqual(db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM knowledge_entries
          WHERE source_type='task7_input_safety') AS entries,
        (SELECT COUNT(*) FROM request_idempotency
          WHERE idempotency_key LIKE 'wave2-input-safety-%') AS ledgers
    `).get(), { entries: 0, ledgers: 0 });
  } finally {
    db.close();
  }
});

test('historically classified team knowledge is concealed without current campaign access', () => {
  const db = openDatabase();
  try {
    const context = createContext(db);
    const outsider = db.prepare(`
      SELECT membership.user_id
      FROM organization_memberships membership
      JOIN users user ON user.id=membership.user_id AND user.is_active=1
      WHERE membership.org_id=? AND membership.status='active'
        AND membership.role_code='member'
        AND NOT EXISTS (
          SELECT 1 FROM team_memberships campaign_team
          WHERE campaign_team.org_id=membership.org_id
            AND campaign_team.team_id=?
            AND campaign_team.user_id=membership.user_id
            AND campaign_team.status='active'
        )
      ORDER BY membership.user_id
      LIMIT 1
    `).get(context.orgId, context.teamId);
    assert.ok(outsider, 'fixture requires a same-organization user outside the campaign team');
    let written;
    db.transaction(() => {
      written = knowledge.writeCampaignKnowledgeInTransaction(
        db,
        writerOptions(context, 'strict-custody', { title: 'Strict custody needle' })
      );
      linkKnowledge(db, context, written.entry.id, 'strict-custody');
    }).immediate();
    db.prepare(`
      UPDATE campaign_record_links
      SET revoked_at=CURRENT_TIMESTAMP,revoked_by=@userId
      WHERE campaign_id=@campaignId
        AND record_type='knowledge_entry'
        AND record_id=@recordId
    `).run({ ...context, recordId: String(written.entry.id) });

    assert.deepEqual(
      knowledge.searchKnowledge(db, {
        q: 'Strict custody needle',
        user: { id: context.userId, role: 'user' }
      }).map((entry) => entry.id),
      [written.entry.id]
    );
    assert.deepEqual(
      knowledge.searchKnowledge(db, {
        q: 'Strict custody needle',
        user: { id: outsider.user_id, role: 'user' }
      }),
      []
    );
    assert.deepEqual(
      knowledge.listKnowledgeCategories(db, {
        user: { id: context.userId, role: 'user' }
      }),
      [{ entry_type: 'campaign_demand', count: 1 }]
    );
    assert.deepEqual(
      knowledge.listKnowledgeCategories(db, {
        user: { id: outsider.user_id, role: 'user' }
      }),
      []
    );
    assert.equal(
      knowledge.recordKnowledgeUsageTelemetry(
        db,
        [written.entry.id],
        { id: outsider.user_id, role: 'user' }
      ),
      0
    );
    assert.equal(
      db.prepare('SELECT usage_count FROM knowledge_entries WHERE id=?')
        .get(written.entry.id).usage_count,
      0
    );
    assert.equal(
      knowledge.markKnowledgeUsed(
        db,
        [written.entry.id],
        { id: context.userId, role: 'user' }
      ),
      0
    );
    assert.equal(
      knowledge.recordKnowledgeUsageTelemetry(
        db,
        [written.entry.id],
        { id: context.userId, role: 'user' }
      ),
      1
    );
  } finally {
    db.close();
  }
});

test('campaign-aware search projects linked legacy visibility without rewriting unlinked tokens', () => {
  const db = openDatabase();
  try {
    const context = createContext(db);
    const linked = knowledge.ingestKnowledge(db, {
      title: 'Legacy linked shared needle',
      content: 'Legacy linked shared content',
      source_type: 'manual_upload',
      source_id: 'legacy-linked-shared.md',
      visibility: 'shared',
      created_by: context.userId
    });
    const unlinked = knowledge.ingestKnowledge(db, {
      title: 'Legacy unlinked shared needle',
      content: 'Legacy unlinked shared content',
      source_type: 'manual_upload',
      source_id: 'legacy-unlinked-shared.md',
      visibility: 'shared',
      created_by: context.userId
    });
    db.transaction(() => {
      linkKnowledge(db, context, linked.id, 'legacy-linked-shared');
    }).immediate();
    db.prepare(`
      UPDATE campaign_record_links
      SET revoked_at=CURRENT_TIMESTAMP,revoked_by=@userId
      WHERE record_type='knowledge_entry' AND record_id=@recordId
    `).run({ ...context, recordId: String(linked.id) });

    const user = { id: context.userId, role: 'user' };
    assert.equal(
      knowledge.searchKnowledge(db, {
        q: 'Legacy linked shared needle',
        user
      })[0].visibility,
      'team'
    );
    assert.deepEqual(
      knowledge.searchKnowledge(db, {
        q: 'Legacy linked shared needle',
        visibility: 'team',
        user
      }).map((entry) => entry.id),
      [linked.id]
    );
    assert.deepEqual(
      knowledge.searchKnowledge(db, {
        q: 'Legacy linked shared needle',
        visibility: 'shared',
        user
      }).map((entry) => entry.id),
      [unlinked.id]
    );
    assert.equal(
      knowledge.searchKnowledge(db, {
        q: 'Legacy unlinked shared needle',
        visibility: 'shared',
        user
      })[0].visibility,
      'shared'
    );
    assert.equal(unlinked.visibility, 'shared');
  } finally {
    db.close();
  }
});

test('historical custody redacts versioned references while preserving unlinked reference rows', () => {
  const db = openDatabase();
  try {
    const context = createContext(db);
    const outsiderId = Number(db.prepare(`
      INSERT INTO users (
        username,password_hash,display_name,role,email,department,is_active
      ) VALUES (
        'wave2-reference-outsider','test-hash','Wave 2 Reference Outsider','user',
        'wave2-reference-outsider@example.invalid','Sales',1
      )
    `).run().lastInsertRowid);
    db.prepare(`
      INSERT INTO organization_memberships (org_id,user_id,role_code,status)
      VALUES (?,?,'member','active')
    `).run(context.orgId, outsiderId);

    let written;
    db.transaction(() => {
      written = knowledge.writeCampaignKnowledgeInTransaction(
        db,
        writerOptions(context, 'reference-redaction', {
          title: 'Historical reference needle',
          content: 'Historical reference body'
        })
      );
      linkKnowledge(db, context, written.entry.id, 'reference-redaction');
    }).immediate();
    const conversationId = Number(db.prepare(`
      INSERT INTO ai_conversations (user_id,title,visibility,source_module)
      VALUES (?,'Reference redaction','private','test')
    `).run(context.userId).lastInsertRowid);
    const messageId = Number(db.prepare(`
      INSERT INTO ai_messages (conversation_id,user_id,role,content,metadata_json)
      VALUES (?,?,'assistant','Reference response','{}')
    `).run(conversationId, context.userId).lastInsertRowid);
    const referenceId = Number(db.prepare(`
      INSERT INTO ai_references (
        message_id,reference_type,reference_id,title,url,snippet,provider,metadata_json,
        reference_schema_version,knowledge_entry_id,knowledge_chunk_id,campaign_id,
        source_identity_sha256,entry_content_sha256,chunk_content_sha256,reference_rank,
        selection_origin
      ) VALUES (
        @messageId,'knowledge',@referenceId,@title,'',@snippet,'','{}',
        1,@entryId,@chunkId,@campaignId,@sourceIdentitySha256,
        @entryContentSha256,@chunkContentSha256,1,'selected'
      )
    `).run({
      messageId,
      referenceId: String(written.entry.id),
      title: written.entry.title,
      snippet: 'Historical reference snippet',
      entryId: written.entry.id,
      chunkId: written.chunks[0].id,
      campaignId: context.campaignId,
      sourceIdentitySha256: written.entry.source_identity_sha256,
      entryContentSha256: written.entry.content_sha256,
      chunkContentSha256: written.chunks[0].content_sha256
    }).lastInsertRowid);
    const reference = db.prepare('SELECT * FROM ai_references WHERE id=?').get(referenceId);
    const unlinkedLegacyReference = Object.freeze({
      reference_schema_version: null,
      reference_type: 'web',
      reference_id: 'legacy-reference'
    });
    db.prepare(`
      UPDATE campaign_record_links
      SET revoked_at=CURRENT_TIMESTAMP,revoked_by=?
      WHERE campaign_id=? AND record_type='knowledge_entry' AND record_id=?
    `).run(context.userId, context.campaignId, String(written.entry.id));

    const ownerReferences = knowledge.redactKnowledgeReferences(
      db,
      [reference, unlinkedLegacyReference],
      { id: context.userId, role: 'user' }
    );
    assert.equal(ownerReferences[0].citation_label, 'KB-1');
    assert.equal(ownerReferences[0].entry_id, written.entry.id);
    assert.equal(ownerReferences[0].chunk_id, written.chunks[0].id);
    assert.equal(ownerReferences[0].visibility, 'team');
    assert.equal(ownerReferences[0].access_state, undefined);
    assert.equal(ownerReferences[1], unlinkedLegacyReference);

    assert.deepEqual(
      knowledge.redactKnowledgeReferences(
        db,
        [Object.freeze({
          ...reference,
          source_identity_sha256: '0'.repeat(64)
        })],
        { id: context.userId, role: 'user' }
      ),
      [{ citation_label: 'KB-1', access_state: 'missing' }]
    );

    assert.deepEqual(
      knowledge.redactKnowledgeReferences(
        db,
        [reference, unlinkedLegacyReference],
        { id: outsiderId, role: 'user' }
      ),
      [
        { citation_label: 'KB-1', access_state: 'restricted' },
        unlinkedLegacyReference
      ]
    );
  } finally {
    db.close();
  }
});

test('same-campaign team members can read team knowledge but not private knowledge', () => {
  const db = openDatabase();
  try {
    const context = createContext(db);
    const readerId = Number(db.prepare(`
      INSERT INTO users (
        username,password_hash,display_name,role,email,department,is_active
      ) VALUES (
        'wave2-team-custody-reader','test-hash','Wave 2 Custody Reader','user',
        'wave2-team-custody-reader@example.invalid','Sales',1
      )
    `).run().lastInsertRowid);
    db.prepare(`
      INSERT INTO organization_memberships (org_id,user_id,role_code,status)
      VALUES (?,?,'member','active')
    `).run(context.orgId, readerId);
    db.prepare(`
      INSERT INTO team_memberships (org_id,team_id,user_id,role_code,status)
      VALUES (?,?,?,'member','active')
    `).run(context.orgId, context.teamId, readerId);

    let teamEntry;
    let privateEntry;
    db.transaction(() => {
      teamEntry = knowledge.writeCampaignKnowledgeInTransaction(
        db,
        writerOptions(context, 'team-reader-visible', {
          title: 'wave2teamneedle998',
          content: 'wave2teamneedle998 content',
          visibility: 'team'
        })
      );
      privateEntry = knowledge.writeCampaignKnowledgeInTransaction(
        db,
        writerOptions(context, 'team-reader-private', {
          title: 'wave2privateneedle998',
          content: 'wave2privateneedle998 content',
          visibility: 'private'
        })
      );
      linkKnowledge(db, context, teamEntry.entry.id, 'team-reader-visible');
      linkKnowledge(db, context, privateEntry.entry.id, 'team-reader-private');
    }).immediate();

    const reader = { id: readerId, role: 'user' };
    assert.deepEqual(
      knowledge.searchKnowledge(db, {
        q: 'wave2teamneedle998',
        user: reader
      }).map((entry) => entry.id),
      [teamEntry.entry.id]
    );
    assert.deepEqual(
      knowledge.searchKnowledge(db, {
        q: 'wave2privateneedle998',
        user: reader
      }).map((entry) => entry.id),
      []
    );
    assert.deepEqual(
      knowledge.searchKnowledge(db, {
        q: 'wave2privateneedle998',
        user: { id: context.userId, role: 'user' }
      }).map((entry) => entry.id),
      [privateEntry.entry.id]
    );
  } finally {
    db.close();
  }
});

test('linked producer archive failures abort base rows links events ledgers and gauges', () => {
  const db = openDatabase();
  try {
    const context = createContext(db);
    const before = {
      ...archiveState(db, context),
      demands: db.prepare('SELECT COUNT(*) AS count FROM demands').get().count
    };
    db.exec(`
      CREATE TRIGGER test_fail_wave2_demand_archive
      BEFORE INSERT ON knowledge_entries
      WHEN NEW.source_type='campaign_demand'
      BEGIN SELECT RAISE(ABORT,'injected demand archive failure'); END
    `);

    assert.throws(() => createCampaignLinkService(db).createDemand({
      userId: context.userId,
      idempotencyKey: 'wave2-demand-archive-failure',
      requestId: 'wave2-demand-archive-failure-request',
      body: {
        campaign_id: context.campaignId,
        brand_name: 'Archive failure brand',
        product_name: 'Archive failure product'
      }
    }), /injected demand archive failure/);
    assert.deepEqual({
      ...archiveState(db, context),
      demands: db.prepare('SELECT COUNT(*) AS count FROM demands').get().count
    }, before);
  } finally {
    db.close();
  }
});

test('gauge refresh failure rolls back required archive links event campaign and ledger', () => {
  const db = openDatabase();
  try {
    const context = createContext(db);
    settleCampaign(db, context);
    refreshScopes(db, context);
    const before = archiveState(db, context);
    db.exec(`
      CREATE TRIGGER test_fail_wave2_gauge_refresh
      BEFORE UPDATE ON knowledge_capacity_gauges
      BEGIN
        SELECT RAISE(ABORT,'injected Wave 2 gauge refresh failure');
      END
    `);
    assert.throws(
      () => db.prepare(`
        UPDATE knowledge_capacity_gauges SET usage_value=usage_value
        WHERE scope_type='user' AND scope_id=? AND metric='entries'
      `).run(context.userId),
      /injected Wave 2 gauge refresh failure/
    );

    const service = createCampaignService(db);
    assert.throws(
      () => service.createCampaignReview(reviewInput(context, 'rollback')),
      /injected Wave 2 gauge refresh failure/
    );
    assert.deepEqual(archiveState(db, context), before);
  } finally {
    db.close();
  }
});

test('capacity authority fails closed on drift and reconciliation restores admission', () => {
  const db = openDatabase();
  try {
    const context = createContext(db);
    settleCampaign(db, context);
    refreshScopes(db, context);
    db.prepare(`
      UPDATE knowledge_capacity_gauges
      SET usage_value=limit_value,threshold_percent=100
      WHERE metric='entries' AND (
        (scope_type='user' AND scope_id=@userId) OR
        (scope_type='campaign' AND scope_id=@campaignId) OR
        (scope_type='organization' AND scope_id=@orgId)
      )
    `).run(context);

    const rejected = createCampaignService(db).createCampaignReview(
      reviewInput(context, 'authority-drift')
    );
    assert.equal(rejected.status, 507);
    assert.equal(rejected.body.code, 'KNOWLEDGE_STORAGE_CAPACITY_EXCEEDED');
    assert.equal(knowledge.userKnowledgeUsage(db, context.userId).entries, 0);
    db.transaction(() => {
      knowledge.reconcileKnowledgeCapacityGaugesInTransaction(db);
    }).immediate();

    const result = createCampaignService(db).createCampaignReview(
      reviewInput(context, 'authority-reconciled')
    );
    assert.equal(result.status, 201);
    const reviewMetadata = JSON.parse(db.prepare(`
      SELECT metadata_json FROM knowledge_entries
      WHERE id=?
    `).get(result.body.entry.id).metadata_json);
    assert.equal(reviewMetadata.artifact_contract, 'tm-business-artifact-v1');
    assert.equal(reviewMetadata.artifact_state, 'confirmed');
    assert.equal(reviewMetadata.artifact_type, 'project_review');
    assert.ok(Number.isSafeInteger(reviewMetadata.settled_event_id));
    assert.equal(knowledge.userKnowledgeUsage(db, context.userId).entries, 1);
    assert.equal(knowledge.campaignKnowledgeUsage(db, context.campaignId).entries, 1);
    assert.equal(
      knowledge.organizationKnowledgeUsage(db, context.orgId, context.orgId).entries,
      1
    );
    assert.deepEqual(
      db.prepare(`
        SELECT scope_type,usage_value,threshold_percent
        FROM knowledge_capacity_gauges
        WHERE metric='entries' AND (
          (scope_type='user' AND scope_id=@userId) OR
          (scope_type='campaign' AND scope_id=@campaignId) OR
          (scope_type='organization' AND scope_id=@orgId)
        )
        ORDER BY scope_type
      `).all(context),
      [
        { scope_type: 'campaign', usage_value: 1, threshold_percent: 0 },
        { scope_type: 'organization', usage_value: 1, threshold_percent: 0 },
        { scope_type: 'user', usage_value: 1, threshold_percent: 0 }
      ]
    );
  } finally {
    db.close();
  }
});

test('attaching existing knowledge refreshes campaign capacity monitoring atomically', () => {
  const db = openDatabase();
  try {
    const context = createContext(db);
    const entry = knowledge.ingestKnowledge(db, {
      title: 'Attach existing knowledge',
      content: 'Attach existing knowledge content',
      source_type: 'manual_upload',
      source_id: 'attach-existing-knowledge.md',
      visibility: 'team',
      created_by: context.userId
    });
    refreshScopes(db, context);
    assert.equal(
      db.prepare(`
        SELECT usage_value FROM knowledge_capacity_gauges
        WHERE scope_type='campaign' AND scope_id=? AND metric='entries'
      `).get(context.campaignId).usage_value,
      0
    );

    const result = createCampaignService(db).attachCampaignLink({
      campaignId: context.campaignId,
      userId: context.userId,
      idempotencyKey: 'wave2-attach-existing-knowledge',
      requestId: 'wave2-attach-existing-knowledge-request',
      body: {
        relation_type: 'knowledge',
        record_type: 'knowledge_entry',
        record_id: String(entry.id),
        metadata: {},
        reason: 'Attach existing knowledge fixture'
      }
    });
    assert.equal(result.status, 201);
    assert.equal(
      db.prepare(`
        SELECT usage_value FROM knowledge_capacity_gauges
        WHERE scope_type='campaign' AND scope_id=? AND metric='entries'
      `).get(context.campaignId).usage_value,
      1
    );
  } finally {
    db.close();
  }
});

test('existing knowledge attachment gauge failure rolls back link event and ledger', () => {
  const db = openDatabase();
  try {
    const context = createContext(db);
    const entry = knowledge.ingestKnowledge(db, {
      title: 'Attach rollback knowledge',
      content: 'Attach rollback knowledge content',
      source_type: 'manual_upload',
      source_id: 'attach-rollback-knowledge.md',
      visibility: 'team',
      created_by: context.userId
    });
    refreshScopes(db, context);
    const before = archiveState(db, context);
    db.exec(`
      CREATE TRIGGER test_fail_wave2_attach_gauge
      BEFORE UPDATE ON knowledge_capacity_gauges
      BEGIN SELECT RAISE(ABORT,'injected attach gauge failure'); END
    `);
    assert.throws(() => createCampaignService(db).attachCampaignLink({
      campaignId: context.campaignId,
      userId: context.userId,
      idempotencyKey: 'wave2-attach-gauge-rollback',
      requestId: 'wave2-attach-gauge-rollback-request',
      body: {
        relation_type: 'knowledge',
        record_type: 'knowledge_entry',
        record_id: String(entry.id),
        metadata: {},
        reason: 'Attach rollback fixture'
      }
    }), /injected attach gauge failure/);
    assert.deepEqual(archiveState(db, context), before);
  } finally {
    db.close();
  }
});

test('cross-campaign knowledge move gauge failure preserves source custody atomically', () => {
  const db = openDatabase();
  try {
    const context = createContext(db);
    const destinationCampaignId = context.campaignId + 1;
    db.prepare(`
      INSERT INTO campaigns (
        id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,
        lifecycle_state,operational_status,row_version
      ) VALUES (
        @destinationCampaignId,@orgId,'Wave 2 destination',@customerId,
        @opportunityId,@userId,@teamId,'lead','active',1
      )
    `).run({ ...context, destinationCampaignId });
    const entry = knowledge.ingestKnowledge(db, {
      title: 'Move rollback knowledge',
      content: 'Move rollback knowledge content',
      source_type: 'manual_upload',
      source_id: 'move-rollback-knowledge.md',
      visibility: 'team',
      created_by: context.userId
    });
    const service = createCampaignService(db);
    const attached = service.attachCampaignLink({
      campaignId: context.campaignId,
      userId: context.userId,
      idempotencyKey: 'wave2-move-source-attach',
      requestId: 'wave2-move-source-attach-request',
      body: {
        relation_type: 'knowledge',
        record_type: 'knowledge_entry',
        record_id: String(entry.id),
        metadata: {},
        reason: 'Attach move source fixture'
      }
    });
    assert.equal(attached.status, 201);
    const sourceLinkId = db.prepare(`
      SELECT id
      FROM campaign_record_links
      WHERE campaign_id=? AND record_type='knowledge_entry'
        AND record_id=? AND revoked_at IS NULL
      ORDER BY id DESC
      LIMIT 1
    `).get(context.campaignId, String(entry.id)).id;
    db.transaction(() => {
      knowledge.refreshKnowledgeCapacityGaugesInTransaction(db, [
        { scopeType: 'user', scopeId: context.userId },
        { scopeType: 'campaign', scopeId: context.campaignId },
        { scopeType: 'campaign', scopeId: destinationCampaignId },
        { scopeType: 'organization', scopeId: context.orgId }
      ]);
    }).immediate();
    const before = archiveState(db, context);
    db.exec(`
      CREATE TRIGGER test_fail_wave2_move_gauge
      BEFORE UPDATE ON knowledge_capacity_gauges
      BEGIN SELECT RAISE(ABORT,'injected move gauge failure'); END
    `);
    assert.throws(() => service.correctCampaignLink({
      campaignId: context.campaignId,
      userId: context.userId,
      idempotencyKey: 'wave2-move-gauge-rollback',
      requestId: 'wave2-move-gauge-rollback-request',
      body: {
        link_id: sourceLinkId,
        target_campaign_id: destinationCampaignId,
        reason: 'Move rollback fixture'
      }
    }), /injected move gauge failure/);
    assert.deepEqual(archiveState(db, context), before);
    assert.deepEqual(db.prepare(`
      SELECT campaign_id,revoked_at
      FROM campaign_record_links
      WHERE record_type='knowledge_entry' AND record_id=?
      ORDER BY id
    `).all(String(entry.id)), [
      { campaign_id: context.campaignId, revoked_at: null }
    ]);
  } finally {
    db.close();
  }
});

test('knowledge search and category plans use the set-wise current-custody projection', () => {
  const db = openDatabase();
  try {
    const context = createContext(db);
    const entry = knowledge.ingestKnowledge(db, {
      title: 'Indexed custody needle',
      content: 'Indexed custody plan content',
      source_type: 'manual_upload',
      source_id: 'indexed-custody-plan.md',
      visibility: 'team',
      created_by: context.userId
    });
    db.transaction(() => linkKnowledge(db, context, entry.id, 'indexed-plan')).immediate();

    const originalPrepare = db.prepare.bind(db);
    const captures = [];
    db.prepare = function(sql) {
      const statement = originalPrepare(sql);
      if (
        typeof sql !== 'string' ||
        !sql.includes('latest_link') &&
        !sql.includes('campaign_custody_entry_id') &&
        !sql.includes('GROUP BY entry.entry_type')
      ) {
        return statement;
      }
      return new Proxy(statement, {
        get(target, property) {
          if (property === 'all') {
            return function(...params) {
              captures.push({ sql, params });
              return target.all(...params);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
    };
    const user = { id: context.userId, role: 'user' };
    knowledge.searchKnowledge(db, { q: 'Indexed custody needle', user });
    knowledge.listKnowledgeCategories(db, { user });
    knowledge.searchKnowledge(db, {
      q: 'Indexed custody needle',
      user: { id: context.userId, role: 'admin' }
    });
    knowledge.listKnowledgeCategories(db, {
      user: { id: context.userId, role: 'admin' }
    });
    db.prepare = originalPrepare;

    assert.equal(captures.length, 4);
    assert.match(captures[0].sql, /knowledge_candidates AS MATERIALIZED/);
    assert.match(captures[0].sql, /LIMIT 500/);
    assert.doesNotMatch(captures[1].sql, /knowledge_candidates AS MATERIALIZED/);
    assert.match(captures[2].sql, /admin_candidates AS MATERIALIZED/);
    assert.doesNotMatch(captures[3].sql, /campaign_record_links/);
    for (const capture of captures.slice(0, 3)) {
      assert.match(capture.sql, /knowledge_current_custody campaign_scope/);
      assert.doesNotMatch(capture.sql, /campaign_record_links|active_link|historical_link/);
      const details = originalPrepare(`EXPLAIN QUERY PLAN ${capture.sql}`)
        .all(...capture.params)
        .map((row) => row.detail);
      assert.equal(
        details.some((detail) => /SEARCH campaign_scope USING PRIMARY KEY/i.test(detail)),
        true,
        details.join('\n')
      );
    }
  } finally {
    db.close();
  }
});

test('non-admin search bounds authorized IDs before loading full knowledge payloads', () => {
  const db = openDatabase();
  try {
    const context = createContext(db);
    const originalPrepare = db.prepare.bind(db);
    let searchSql = null;
    db.prepare = function(sql) {
      if (
        typeof sql === 'string' &&
        sql.includes('knowledge_candidates AS MATERIALIZED')
      ) {
        searchSql = sql;
      }
      return originalPrepare(sql);
    };
    try {
      knowledge.searchKnowledge(db, {
        user: { id: context.userId, role: 'user' }
      });
    } finally {
      db.prepare = originalPrepare;
    }

    assert.ok(searchSql);
    const sqlParts = searchSql.match(
      /^([\s\S]*knowledge_candidates AS MATERIALIZED\s*\([\s\S]*\))\s*(SELECT[\s\S]*)$/
    );
    assert.ok(sqlParts);
    const candidateCte = sqlParts[1];
    const payloadFetch = sqlParts[2];
    assert.match(
      candidateCte,
      /SELECT\s+entry\.id,\s*entry\.usage_count,\s*entry\.updated_at,/
    );
    assert.doesNotMatch(candidateCte, /entry\.\*|\bcontent\b|\bembedding_json\b/);
    assert.match(candidateCte, /WHERE[\s\S]*ORDER BY[\s\S]*LIMIT 500/);
    assert.match(payloadFetch, /SELECT\s+entry\.\*/);
    assert.match(
      payloadFetch,
      /FROM knowledge_candidates candidate\s+JOIN knowledge_entries entry\s+ON entry\.id=candidate\.id/
    );
  } finally {
    db.close();
  }
});

test('knowledge capacity admission uses bounded authoritative gauge reads', () => {
  const db = openDatabase();
  try {
    const context = createContext(db);
    const originalPrepare = db.prepare.bind(db);
    const admissionStatements = [];
    db.prepare = function(sql) {
      const statement = originalPrepare(sql);
      if (
        typeof sql === 'string' &&
        sql.includes('FROM knowledge_capacity_gauges') &&
        sql.includes('scope_type=? AND scope_id=?')
      ) {
        admissionStatements.push(sql);
      }
      return statement;
    };
    let written;
    db.transaction(() => {
      written = knowledge.writeCampaignKnowledgeInTransaction(
        db,
        writerOptions(context, 'bounded-capacity-plan')
      );
      linkKnowledge(db, context, written.entry.id, 'bounded-capacity-plan');
      knowledge.applyKnowledgeCapacityGaugePlanInTransaction(
        db,
        written.capacityGaugePlan
      );
    }).immediate();
    db.prepare = originalPrepare;

    assert.equal(admissionStatements.length, 2);
    for (const sql of admissionStatements) {
      assert.doesNotMatch(
        sql,
        /knowledge_entries|knowledge_chunks|ai_references|campaign_record_links/
      );
    }
    assert.equal(knowledge.userKnowledgeUsage(db, context.userId).entries, 1);
    assert.equal(knowledge.campaignKnowledgeUsage(db, context.campaignId).entries, 1);
    assert.equal(
      knowledge.organizationKnowledgeUsage(db, context.orgId, context.orgId).entries,
      1
    );
  } finally {
    db.close();
  }
});

test('knowledge custody preflight reads the authoritative entry footprint without scanning chunks', () => {
  const db = openDatabase();
  try {
    const context = createContext(db);
    let written;
    db.transaction(() => {
      written = knowledge.writeCampaignKnowledgeInTransaction(
        db,
        writerOptions(context, 'footprint-custody-preflight')
      );
      linkKnowledge(db, context, written.entry.id, 'footprint-custody-preflight');
      knowledge.applyKnowledgeCapacityGaugePlanInTransaction(
        db,
        written.capacityGaugePlan
      );
    }).immediate();

    const originalPrepare = db.prepare.bind(db);
    const captured = [];
    db.prepare = function(sql) {
      if (
        typeof sql === 'string' &&
        (/knowledge_entry_footprints/.test(sql) || /knowledge_chunks/.test(sql))
      ) {
        captured.push(sql);
      }
      return originalPrepare(sql);
    };
    db.transaction(() => {
      knowledge.preflightCampaignKnowledgeCustodyMoveInTransaction(db, {
        entryId: written.entry.id,
        destinationCampaignId: context.campaignId,
        organizationId: context.orgId
      });
    }).immediate();
    db.prepare = originalPrepare;

    assert.equal(captured.some((sql) => /FROM knowledge_entry_footprints/.test(sql)), true);
    assert.equal(captured.some((sql) => /knowledge_chunks/.test(sql)), false);
  } finally {
    db.close();
  }
});

test('knowledge usage marking updates all authorized entries with one set-wise statement', () => {
  const db = openDatabase();
  try {
    const context = createContext(db);
    const ids = [];
    const insert = db.prepare(`
      INSERT INTO knowledge_entries (
        id,entry_type,source_type,source_id,key_terms,content,created_by,is_public,
        title,summary,tags_json,visibility,metadata_json,embedding_json,
        source_identity_sha256,content_sha256
      ) VALUES (
        @id,'note','manual',@sourceId,'[]',@content,@createdBy,0,
        @title,'','[]','private','{}',NULL,@sourceHash,@contentHash
      )
    `);
    db.transaction(() => {
      for (let index = 0; index < 100; index += 1) {
        const id = 4000000 + index;
        ids.push(id);
        insert.run({
          id,
          sourceId: `usage-${index}`,
          content: `Usage ${index}`,
          createdBy: context.userId,
          title: `Usage ${index}`,
          sourceHash: sha256(`usage-source-${index}`),
          contentHash: sha256(`usage-content-${index}`)
        });
      }
    }).immediate();

    const originalPrepare = db.prepare.bind(db);
    let updateRuns = 0;
    db.prepare = function(sql) {
      const statement = originalPrepare(sql);
      if (typeof sql !== 'string' || !/^UPDATE knowledge_entries SET usage_count/.test(sql)) {
        return statement;
      }
      return {
        run(...params) {
          updateRuns += 1;
          return statement.run(...params);
        }
      };
    };
    assert.equal(
      knowledge.markKnowledgeUsed(db, ids, { id: context.userId, role: 'user' }),
      100
    );
    db.prepare = originalPrepare;
    assert.equal(updateRuns, 1);
  } finally {
    db.close();
  }
});

test('bounded knowledge search applies authorization before candidate limiting', () => {
  const db = openDatabase();
  try {
    const context = createContext(db);
    const otherUser = db.prepare(`
      SELECT id FROM users WHERE id<>? ORDER BY id LIMIT 1
    `).get(context.userId);
    assert.ok(otherUser);
    const insert = db.prepare(`
      INSERT INTO knowledge_entries (
        id,entry_type,source_type,source_id,key_terms,content,created_by,is_public,
        title,summary,tags_json,visibility,metadata_json,embedding_json,
        source_identity_sha256,content_sha256,usage_count
      ) VALUES (
        @id,'note','manual',@sourceId,'[]',@content,@createdBy,0,
        @title,'','[]','private','{}',NULL,@sourceHash,@contentHash,@usageCount
      )
    `);
    db.transaction(() => {
      for (let index = 0; index < 2000; index += 1) {
        const id = 2000000 + index;
        insert.run({
          id,
          sourceId: `hidden-${index}`,
          content: `Hidden ${index}`,
          createdBy: otherUser.id,
          title: `Hidden ${index}`,
          sourceHash: sha256(`hidden-source-${index}`),
          contentHash: sha256(`hidden-content-${index}`),
          usageCount: 100
        });
      }
      insert.run({
        id: 3000000,
        sourceId: 'authorized-tail',
        content: 'Authorized tail result',
        createdBy: context.userId,
        title: 'Authorized tail result',
        sourceHash: sha256('authorized-tail-source'),
        contentHash: sha256('authorized-tail-content'),
        usageCount: 0
      });
    }).immediate();

    const results = knowledge.searchKnowledge(db, {
      user: { id: context.userId, role: 'user' },
      limit: 20
    });
    assert.deepEqual(results.map((entry) => entry.id), [3000000]);
  } finally {
    db.close();
  }
});

test('linked knowledge use requires target management authority before ledger lookup', () => {
  const db = openDatabase();
  try {
    const context = createContext(db);
    const readerId = Number(db.prepare(`
      INSERT INTO users (
        username,password_hash,display_name,role,email,department,is_active
      ) VALUES (
        'wave2-team-reader','test-hash','Wave 2 Team Reader','user',
        'wave2-reader@example.invalid','Sales',1
      )
    `).run().lastInsertRowid);
    db.prepare(`
      INSERT INTO organization_memberships (org_id,user_id,role_code,status)
      VALUES (?,?,'member','active')
    `).run(context.orgId, readerId);
    db.prepare(`
      INSERT INTO team_memberships (org_id,team_id,user_id,role_code,status)
      VALUES (?,?,?,'member','active')
    `).run(context.orgId, context.teamId, readerId);
    const entry = knowledge.ingestKnowledge(db, {
      title: 'Team readable but owner managed',
      content: 'Team readable but owner managed content',
      source_type: 'manual_upload',
      source_id: 'team-readable-owner-managed.md',
      visibility: 'team',
      created_by: context.userId
    });
    db.transaction(() => linkKnowledge(db, context, entry.id, 'manage-use')).immediate();

    assert.throws(() => createCampaignLinkService(db).useKnowledge({
      userId: readerId,
      requestId: 'wave2-team-reader-use-request',
      idempotencyKey: 'wave2-team-reader-use-key',
      entryId: entry.id
    }), (error) => (
      error &&
      error.statusCode === 403 &&
      error.code === 'RECORD_FORBIDDEN'
    ));
    assert.equal(
      db.prepare('SELECT usage_count FROM knowledge_entries WHERE id=?')
        .get(entry.id).usage_count,
      0
    );
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count
      FROM request_idempotency
      WHERE idempotency_key='wave2-team-reader-use-key'
    `).get().count, 0);
  } finally {
    db.close();
  }
});

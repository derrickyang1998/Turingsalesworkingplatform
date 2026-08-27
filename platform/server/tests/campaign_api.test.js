const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { once } = require('node:events');
const Database = require('better-sqlite3');
const express = require('express');

const migrationService = require('../services/migration_service');
const knowledge = require('../services/knowledge_service');
const idempotency = require('../services/idempotency_service');
const sqliteDigest = require('../services/sqlite_digest_service');
const migrationVerifier = require('../scripts/verify_campaign_migration_gate');
const {
  createCampaignService
} = require('../services/campaign_service');
const { createCampaignLinkService } = require('../services/campaign_link_service');
const campaignContract = require('../contracts/campaign_contract');
const {
  createPhase4RequestPipeline
} = require('../middleware/phase4_request_pipeline');

const SERVER_ROOT = path.resolve(__dirname, '..');
const USER_ENTRY_LIMIT = 50000;
const CAMPAIGN_ENTRY_LIMIT = 100000;
const LINKED_CUSTODY_VOLUME = 2000;
const UNLINKED_MEMBER_VOLUME = 1000;
const VOLUME_RUNTIME_LIMIT_MS = 1000;
const CAMPAIGN_MIGRATION_DESCRIPTOR = Object.freeze({
  version: 2,
  name: '002_campaign_business_spine',
  sourcePath: 'migrations/002_campaign_business_spine.js',
  engineVersion: 1,
  dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
});
const WORKFLOW_MIGRATION_DESCRIPTOR = Object.freeze({
  version: 3,
  name: '003_campaign_workflow_dispatch_evidence',
  sourcePath: 'migrations/003_campaign_workflow_dispatch_evidence.js',
  engineVersion: 1,
  dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
});
const CAPACITY_MIGRATION_DESCRIPTOR = Object.freeze({
  version: 4,
  name: '004_knowledge_capacity_observability',
  sourcePath: 'migrations/004_knowledge_capacity_observability.js',
  engineVersion: 1,
  dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
});

function openV2Database(databaseOptions = {}) {
  const db = new Database(':memory:', databaseOptions);
  migrationService.runMigrations(db, {
    rootDir: SERVER_ROOT,
    registeredMigrations: [CAMPAIGN_MIGRATION_DESCRIPTOR]
  });
  return db;
}

function openV4Database(databaseOptions = {}) {
  const db = new Database(':memory:', databaseOptions);
  migrationService.runMigrations(db, {
    rootDir: SERVER_ROOT,
    registeredMigrations: [
      CAMPAIGN_MIGRATION_DESCRIPTOR,
      WORKFLOW_MIGRATION_DESCRIPTOR,
      CAPACITY_MIGRATION_DESCRIPTOR,
      Object.freeze({
        version: 5,
        name: '005_knowledge_custody_projection',
        sourcePath: 'migrations/005_knowledge_custody_projection.js',
        engineVersion: 1,
        dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
      })
    ]
  });
  return db;
}

function openV7Database(databaseOptions = {}) {
  const db = new Database(':memory:', databaseOptions);
  migrationService.runMigrations(db, {
    rootDir: SERVER_ROOT,
    registeredMigrations: migrationVerifier.REGISTERED_MIGRATIONS
  });
  return db;
}

function createCampaignContext(db) {
  const identity = db.prepare(`
    SELECT
      organization.id AS orgId,
      user.id AS userId,
      team_membership.team_id AS teamId
    FROM organizations organization
    JOIN organization_memberships organization_membership
      ON organization_membership.org_id=organization.id
      AND organization_membership.status='active'
    JOIN users user
      ON user.id=organization_membership.user_id
      AND user.is_active=1
    JOIN team_memberships team_membership
      ON team_membership.org_id=organization.id
      AND team_membership.user_id=user.id
      AND team_membership.status='active'
    WHERE organization.code='turingmarket-default'
    ORDER BY
      CASE WHEN organization_membership.role_code='org_admin' THEN 0 ELSE 1 END,
      user.id,team_membership.team_id
    LIMIT 1
  `).get();
  assert.ok(identity);

  const customerId = 910001;
  const opportunityId = 920001;
  const campaignId = 930001;
  db.prepare(`
    INSERT INTO customers (
      id,brand_name,company_name,stage,source,created_by,assigned_to
    ) VALUES (
      @customerId,'Writer Fixture','Writer Fixture Ltd','qualified','test',
      @userId,@userId
    )
  `).run({ customerId, userId: identity.userId });
  db.prepare(`
    INSERT INTO opportunities (
      id,customer_id,name,stage,value,win_probability,product_name,
      channel_type,created_by
    ) VALUES (
      @opportunityId,@customerId,'Campaign writer fixture','proposal',
      1000,50,'Writer','influencer',@userId
    )
  `).run({
    opportunityId,
    customerId,
    userId: identity.userId
  });
  db.prepare(`
    INSERT INTO campaigns (
      id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,
      lifecycle_state,operational_status,row_version
    ) VALUES (
      @campaignId,@orgId,'Campaign writer fixture',@customerId,@opportunityId,
      @userId,@teamId,'lead','active',1
    )
  `).run({
    campaignId,
    orgId: identity.orgId,
    customerId,
    opportunityId,
    userId: identity.userId,
    teamId: identity.teamId
  });
  return {
    ...identity,
    customerId,
    opportunityId,
    campaignId
  };
}

function writerOptions(context, sourceOffset, overrides = {}) {
  return {
    organizationId: context.orgId,
    campaignId: context.campaignId,
    createdBy: context.userId,
    sourceType: 'campaign_demand',
    sourceId: String(940000 + sourceOffset),
    entryType: 'campaign_demand',
    title: `Campaign demand ${sourceOffset}`,
    summary: `Campaign demand summary ${sourceOffset}`,
    content: `Campaign demand content ${sourceOffset}`,
    tags: ['campaign', 'demand'],
    visibility: 'team',
    metadata: { schema_version: 1 },
    ...overrides
  };
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function createSiblingCampaign(db, context, campaignId = context.campaignId + 1) {
  const result = db.prepare(`
    INSERT INTO campaigns (
      id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,
      lifecycle_state,operational_status,row_version,product_name,region,
      currency,budget_minor,start_date,end_date
    )
    SELECT
      @campaignId,org_id,@name,customer_id,opportunity_id,owner_user_id,team_id,
      lifecycle_state,operational_status,row_version,product_name,region,
      currency,budget_minor,start_date,end_date
    FROM campaigns
    WHERE id=@sourceCampaignId
  `).run({
    campaignId,
    name: `Campaign writer sibling ${campaignId}`,
    sourceCampaignId: context.campaignId
  });
  assert.equal(result.changes, 1);
  return { ...context, campaignId };
}

function settleCampaignFixture(db, context) {
  const body = {
    expected_state: 'published',
    expected_version: 11,
    next_state: 'settled',
    reason: 'Settled fixture'
  };
  const requestHash = sqliteDigest.requestHash({
    method: 'POST',
    path: `/api/campaigns/${context.campaignId}/transitions`,
    campaignId: context.campaignId,
    kind: 'json',
    payload: body
  });
  return db.transaction(() => {
    const reservation = idempotency.reserveProcessingInTransaction(db, {
      organizationId: context.orgId,
      actorUserId: context.userId,
      campaignId: context.campaignId,
      secondaryCampaignId: null,
      resourceClaim: null,
      scope: 'campaign.transition',
      key: `fixture-settled-${context.campaignId}`,
      requestHash,
      expectedEventCount: 1,
      operationTimeoutSeconds: 60
    });
    assert.equal(reservation.state, 'reserved');
    db.prepare(`
      UPDATE campaigns
      SET lifecycle_state='settled',row_version=12,updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(context.campaignId);
    const inserted = db.prepare(`
      INSERT INTO campaign_events (
        org_id,campaign_id,event_type,previous_state,next_state,actor_user_id,
        reason,source,metadata_json,correlation_id,audit_fingerprint
      ) VALUES (
        ?,?,'lifecycle_transition','published','settled',?,
        'Settled fixture','project_workspace',
        '{"previous_version":11,"next_version":12}',
        'fixture-settled-event',?
      )
    `).run(
      context.orgId,
      context.campaignId,
      context.userId,
      reservation.auditFingerprint
    );
    const eventId = Number(inserted.lastInsertRowid);
    idempotency.completeJsonInTransaction(db, {
      ledgerId: reservation.ledgerId,
      requestHash,
      leaseToken: reservation.leaseToken,
      statusCode: 200,
      responseBody: { fixture_event_id: eventId }
    });
    return eventId;
  }).immediate();
}

function linkKnowledgeEntry(db, context, entryId, label) {
  const result = db.prepare(`
    INSERT INTO campaign_record_links (
      org_id,campaign_id,record_type,bundle_id,record_id,relation_type,
      created_by,metadata_json
    ) VALUES (
      @orgId,@campaignId,'knowledge_entry',@bundleId,@recordId,'knowledge',
      @createdBy,'{}'
    )
  `).run({
    orgId: context.orgId,
    campaignId: context.campaignId,
    bundleId: sha256(
      `campaign-knowledge-custody:${label}:${context.campaignId}:${entryId}`
    ),
    recordId: String(entryId),
    createdBy: context.userId
  });
  return Number(result.lastInsertRowid);
}

function revokeKnowledgeLink(db, linkId, userId) {
  const result = db.prepare(`
    UPDATE campaign_record_links
    SET
      revoked_at='2099-01-02 00:00:00',
      revoked_by=?,
      revoke_reason='Campaign knowledge test custody history'
    WHERE id=?
  `).run(userId, linkId);
  assert.equal(result.changes, 1);
}

function assertCampaignKnowledgeConflict(callback) {
  assert.throws(callback, (error) => {
    assert.equal(error.name, 'CampaignKnowledgeConflictError');
    assert.equal(error.code, 'KNOWLEDGE_SOURCE_CONTENT_CONFLICT');
    assert.equal(error.statusCode, 409);
    return true;
  });
}

function validScalarText(value, label) {
  const text = String(value);
  for (const point of text) {
    const codePoint = point.codePointAt(0);
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      throw new Error(`${label} contains an isolated surrogate`);
    }
  }
  return text;
}

function canonicalText(value, label) {
  return validScalarText(value, label).replace(/\r\n?/g, '\n').normalize('NFC');
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function canonicalTags(tags) {
  return [...new Set(tags.map((tag) => canonicalText(tag, 'tag')))].sort(compareUtf8);
}

function frame32(bytes) {
  const payload = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  return Buffer.concat([length, payload]);
}

function framedDigest(values) {
  return sha256(Buffer.concat(values.map((value) => frame32(Buffer.from(value, 'utf8')))));
}

function campaignSourceDigest(options) {
  return framedDigest([
    'tm-knowledge-source-v1',
    String(options.organizationId),
    String(options.campaignId),
    canonicalText(options.sourceType, 'source type'),
    canonicalText(options.sourceId, 'source id'),
    canonicalText(options.entryType, 'entry type'),
    options.visibility === 'private' ? String(options.createdBy) : ''
  ]);
}

function campaignContentDigest(options) {
  return framedDigest([
    'tm-knowledge-content-v1',
    canonicalText(options.entryType, 'entry type'),
    canonicalText(options.title, 'title'),
    canonicalText(options.summary, 'summary'),
    canonicalText(options.content, 'content'),
    JSON.stringify(canonicalTags(options.tags)),
    options.visibility
  ]);
}

function sequenceValue(db, tableName) {
  const row = db.prepare(
    'SELECT seq FROM sqlite_sequence WHERE name=?'
  ).get(tableName);
  return row ? row.seq : null;
}

function setSequence(db, tableName, value) {
  const integerValue = BigInt(value);
  const result = db.prepare(
    'UPDATE sqlite_sequence SET seq=? WHERE name=?'
  ).run(integerValue, tableName);
  if (result.changes === 0) {
    db.prepare(
      'INSERT INTO sqlite_sequence (name,seq) VALUES (?,?)'
    ).run(tableName, integerValue);
  }
}

function knowledgeStateSummary(db) {
  return {
    entries: db.prepare(
      'SELECT COUNT(*) AS count FROM knowledge_entries'
    ).get().count,
    chunks: db.prepare(
      'SELECT COUNT(*) AS count FROM knowledge_chunks'
    ).get().count,
    fts: db.prepare(
      'SELECT COUNT(*) AS count FROM knowledge_chunks_fts'
    ).get().count,
    entrySequence: sequenceValue(db, 'knowledge_entries'),
    chunkSequence: sequenceValue(db, 'knowledge_chunks')
  };
}

function campaignSideEffects(db, campaignId) {
  return {
    links: db.prepare(
      'SELECT COUNT(*) AS count FROM campaign_record_links'
    ).get().count,
    events: db.prepare(
      'SELECT COUNT(*) AS count FROM campaign_events'
    ).get().count,
    ledgers: db.prepare(
      'SELECT COUNT(*) AS count FROM request_idempotency'
    ).get().count,
    dispatches: db.prepare(
      'SELECT COUNT(*) AS count FROM campaign_workflow_dispatches'
    ).get().count,
    rowVersion: db.prepare(
      'SELECT row_version FROM campaigns WHERE id=?'
    ).get(campaignId).row_version
  };
}

function sqliteTimestamp(db, modifier) {
  return db.prepare(
    "SELECT datetime(CURRENT_TIMESTAMP,?) AS value"
  ).get(modifier).value;
}

function deterministicDigest(label) {
  return crypto.createHash('sha256').update(label).digest('hex');
}

function campaignUpdateIdempotencyInput(context, key, body) {
  return {
    organizationId: context.orgId,
    actorUserId: context.userId,
    campaignId: context.campaignId,
    secondaryCampaignId: null,
    resourceClaim: null,
    scope: 'campaign.update',
    key,
    requestHash: sqliteDigest.requestHash({
      method: 'PATCH',
      path: `/api/campaigns/${context.campaignId}`,
      campaignId: context.campaignId,
      kind: 'json',
      payload: body
    }),
    expectedEventCount: 0
  };
}

function campaignCreateIdempotencyInput(context, key, body) {
  return {
    organizationId: context.orgId,
    actorUserId: context.userId,
    campaignId: context.campaignId,
    secondaryCampaignId: null,
    resourceClaim: null,
    scope: 'campaign.create',
    key,
    requestHash: sqliteDigest.requestHash({
      method: 'POST',
      path: '/api/campaigns',
      campaignId: null,
      kind: 'json',
      payload: body
    }),
    expectedEventCount: 1
  };
}

function insertStaleCampaignProcessingLedger(db, input, label, {
  createdModifier = '-2 minutes',
  leaseModifier = '-1 minute',
  deadlineModifier = '+5 minutes'
} = {}) {
  const reservationNonce = deterministicDigest(`nonce:${label}`);
  const leaseToken = deterministicDigest(`lease:${label}`);
  const auditFingerprint = sqliteDigest.auditFingerprint({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    scope: input.scope,
    key: input.key,
    requestHash: input.requestHash,
    reservationNonce
  });
  const result = db.prepare(`
    INSERT INTO request_idempotency (
      org_id,user_id,campaign_id,secondary_campaign_id,resource_claim,scope,
      idempotency_key,reservation_nonce,request_hash,audit_fingerprint,
      expected_event_count,state,lease_until,lease_token,created_at,updated_at,
      operation_deadline
    ) VALUES (
      @organizationId,@actorUserId,@campaignId,@secondaryCampaignId,@resourceClaim,
      @scope,@key,@reservationNonce,@requestHash,@auditFingerprint,
      @expectedEventCount,'processing',@leaseUntil,@leaseToken,@createdAt,@createdAt,
      @operationDeadline
    )
  `).run({
    ...input,
    reservationNonce,
    leaseToken,
    auditFingerprint,
    createdAt: sqliteTimestamp(db, createdModifier),
    leaseUntil: sqliteTimestamp(db, leaseModifier),
    operationDeadline: sqliteTimestamp(db, deadlineModifier)
  });
  return {
    ledgerId: Number(result.lastInsertRowid),
    reservationNonce,
    leaseToken,
    auditFingerprint
  };
}

function insertFailedCampaignLedger(db, input, label) {
  const reservationNonce = deterministicDigest(`nonce:${label}`);
  const auditFingerprint = sqliteDigest.auditFingerprint({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    scope: input.scope,
    key: input.key,
    requestHash: input.requestHash,
    reservationNonce
  });
  const result = db.prepare(`
    INSERT INTO request_idempotency (
      org_id,user_id,campaign_id,secondary_campaign_id,resource_claim,scope,
      idempotency_key,reservation_nonce,request_hash,audit_fingerprint,
      expected_event_count,state,created_at,updated_at,operation_deadline,expires_at
    ) VALUES (
      @organizationId,@actorUserId,@campaignId,@secondaryCampaignId,@resourceClaim,
      @scope,@key,@reservationNonce,@requestHash,@auditFingerprint,
      @expectedEventCount,'failed',@createdAt,@updatedAt,@operationDeadline,@expiresAt
    )
  `).run({
    ...input,
    reservationNonce,
    auditFingerprint,
    createdAt: sqliteTimestamp(db, '-10 minutes'),
    updatedAt: sqliteTimestamp(db, '-2 minutes'),
    operationDeadline: sqliteTimestamp(db, '+5 minutes'),
    expiresAt: sqliteTimestamp(db, '+1 day')
  });
  return {
    ledgerId: Number(result.lastInsertRowid),
    reservationNonce,
    auditFingerprint
  };
}

function insertExpiredCampaignJsonLedger(db, input, label, responseBody) {
  const reservationNonce = deterministicDigest(`nonce:${label}`);
  const auditFingerprint = sqliteDigest.auditFingerprint({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    scope: input.scope,
    key: input.key,
    requestHash: input.requestHash,
    reservationNonce
  });
  const result = db.prepare(`
    INSERT INTO request_idempotency (
      org_id,user_id,campaign_id,secondary_campaign_id,resource_claim,scope,
      idempotency_key,reservation_nonce,request_hash,audit_fingerprint,
      expected_event_count,state,status_code,response_kind,response_json,
      response_headers_json,created_at,updated_at,operation_deadline,expires_at
    ) VALUES (
      @organizationId,@actorUserId,@campaignId,@secondaryCampaignId,@resourceClaim,
      @scope,@key,@reservationNonce,@requestHash,@auditFingerprint,
      @expectedEventCount,'completed',200,'json',@responseJson,
      @responseHeadersJson,@createdAt,@updatedAt,@operationDeadline,@expiresAt
    )
  `).run({
    ...input,
    reservationNonce,
    auditFingerprint,
    responseJson: sqliteDigest.canonicalJsonBytes(responseBody).toString('utf8'),
    responseHeadersJson: '{"Content-Type":"application/json; charset=utf-8"}',
    createdAt: sqliteTimestamp(db, '-40 days'),
    updatedAt: sqliteTimestamp(db, '-31 days'),
    operationDeadline: sqliteTimestamp(db, '-39 days'),
    expiresAt: sqliteTimestamp(db, '-1 day')
  });
  return {
    ledgerId: Number(result.lastInsertRowid),
    reservationNonce,
    auditFingerprint
  };
}

function closeWithRollback(db) {
  if (db.inTransaction) db.exec('ROLLBACK');
  db.close();
}

function bulkFillUserEntries(db, createdBy, count) {
  if (count === 0) return;
  assert.ok(Number.isSafeInteger(count) && count > 0);
  const replacementGuard = db.prepare(`
    SELECT sql
    FROM sqlite_schema
    WHERE type='trigger' AND name='knowledge_entries_no_replace_insert'
  `).get();
  assert.ok(replacementGuard && replacementGuard.sql);
  db.exec('DROP TRIGGER knowledge_entries_no_replace_insert');
  try {
    db.prepare(`
      WITH RECURSIVE fixture_rows(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1
        FROM fixture_rows
        WHERE value < @count
      )
      INSERT INTO knowledge_entries (
        entry_type,source_type,source_id,key_terms,content,created_by,is_public,
        title,summary,tags_json,visibility,source_hash,business_type,business_id,
        metadata_json,embedding_json,source_identity_sha256,content_sha256
      )
      SELECT
        'note','capacity_fixture',NULL,'[]','',@createdBy,0,
        '','','[]','private',NULL,NULL,NULL,'{}',NULL,
        lower(printf('f%063x', 1000000 + value)),
        'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
      FROM fixture_rows
    `).run({ count, createdBy });
  } finally {
    db.exec(replacementGuard.sql);
  }
}

function withSuspendedTriggers(db, triggerNames, callback) {
  const placeholders = triggerNames.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT name,sql
    FROM sqlite_schema
    WHERE type='trigger' AND name IN (${placeholders})
    ORDER BY name
  `).all(...triggerNames);
  assert.deepEqual(
    rows.map((row) => row.name),
    [...triggerNames].sort()
  );
  rows.forEach((row) => {
    assert.match(row.name, /^[a-z0-9_]+$/);
    db.exec(`DROP TRIGGER "${row.name}"`);
  });
  try {
    return callback();
  } finally {
    rows.forEach((row) => db.exec(row.sql));
  }
}

function bulkFillCampaignCustodyEntries(db, context, campaignId, count) {
  if (count === 0) return;
  assert.ok(Number.isSafeInteger(count) && count > 0);
  const entryBase = db.prepare(
    'SELECT COALESCE(MAX(id),0) AS max_id FROM knowledge_entries'
  ).get().max_id;
  const params = {
    count,
    entryBase: BigInt(entryBase),
    orgId: context.orgId,
    campaignId,
    userId: context.userId
  };
  withSuspendedTriggers(db, [
    'campaign_links_bundle_identity_insert',
    'campaign_links_single_owner',
    'knowledge_entries_no_replace_insert'
  ], () => {
    const entries = db.prepare(`
      WITH RECURSIVE fixture_rows(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1
        FROM fixture_rows
        WHERE value < @count
      )
      INSERT INTO knowledge_entries (
        id,entry_type,source_type,source_id,key_terms,content,created_by,is_public,
        title,summary,tags_json,visibility,source_hash,business_type,business_id,
        metadata_json,embedding_json,source_identity_sha256,content_sha256
      )
      SELECT
        @entryBase + value,
        'campaign_capacity_fixture',
        'campaign_capacity_fixture',
        'campaign-capacity-' || (@entryBase + value),
        '[]',
        '',
        @userId,
        0,
        '',
        '',
        '[]',
        'private',
        NULL,
        'campaign',
        CAST(@campaignId AS TEXT),
        '{}',
        NULL,
        'a' || printf('%063x', @entryBase + value),
        'b' || printf('%063x', @entryBase + value)
      FROM fixture_rows
    `).run(params);
    assert.equal(entries.changes, count);
    const links = db.prepare(`
      WITH RECURSIVE fixture_rows(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1
        FROM fixture_rows
        WHERE value < @count
      )
      INSERT INTO campaign_record_links (
        org_id,campaign_id,record_type,bundle_id,record_id,relation_type,
        created_by,metadata_json
      )
      SELECT
        @orgId,
        @campaignId,
        'knowledge_entry',
        'c' || printf('%063x', @entryBase + value),
        CAST(@entryBase + value AS TEXT),
        'knowledge',
        @userId,
        '{}'
      FROM fixture_rows
    `).run(params);
    assert.equal(links.changes, count);
  });
}

function seedLinkedKnowledgeVolume(db, context, sibling, count) {
  assert.ok(Number.isSafeInteger(count) && count > 0);
  const entryBase = db.prepare(
    'SELECT COALESCE(MAX(id),0) AS max_id FROM knowledge_entries'
  ).get().max_id;
  const chunkBase = db.prepare(
    'SELECT COALESCE(MAX(id),0) AS max_id FROM knowledge_chunks'
  ).get().max_id;
  const linkBase = db.prepare(
    'SELECT COALESCE(MAX(id),0) AS max_id FROM campaign_record_links'
  ).get().max_id;
  const params = {
    count,
    entryBase: BigInt(entryBase),
    chunkBase: BigInt(chunkBase),
    linkBase: BigInt(linkBase),
    userId: context.userId,
    orgId: context.orgId,
    campaignId: context.campaignId,
    siblingCampaignId: sibling.campaignId
  };
  withSuspendedTriggers(db, [
    'campaign_knowledge_chunk_no_insert',
    'campaign_links_bundle_identity_insert',
    'campaign_links_single_owner',
    'knowledge_entries_no_replace_insert'
  ], () => {
    const entryInsert = db.prepare(`
      WITH RECURSIVE fixture_rows(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1
        FROM fixture_rows
        WHERE value < @count
      )
      INSERT INTO knowledge_entries (
        id,entry_type,source_type,source_id,key_terms,content,created_by,
        is_public,title,summary,tags_json,visibility,source_hash,business_type,
        business_id,metadata_json,embedding_json,source_identity_sha256,
        content_sha256
      )
      SELECT
        @entryBase + value,
        'campaign_volume_fixture',
        'campaign_volume_fixture',
        'capacity-volume-' || value,
        '["campaign","volume"]',
        'Campaign custody volume content ' || value,
        @userId,
        1,
        'Campaign custody volume ' || value,
        'Campaign custody volume summary ' || value,
        '["campaign","volume"]',
        'team',
        NULL,
        'campaign',
        CAST(@campaignId AS TEXT),
        '{}',
        NULL,
        '9' || printf('%063x', @entryBase + value),
        '8' || printf('%063x', @entryBase + value)
      FROM fixture_rows
    `).run(params);
    assert.equal(entryInsert.changes, count);

    const chunkInsert = db.prepare(`
      WITH RECURSIVE fixture_rows(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1
        FROM fixture_rows
        WHERE value < @count
      )
      INSERT INTO knowledge_chunks (
        id,entry_id,chunk_index,content,metadata_json,token_count,
        embedding_json,content_sha256
      )
      SELECT
        @chunkBase + value,
        @entryBase + value,
        0,
        'Campaign custody volume content ' || value,
        '{"title":"Campaign custody volume"}',
        1,
        NULL,
        '7' || printf('%063x', @chunkBase + value)
      FROM fixture_rows
    `).run(params);
    assert.equal(chunkInsert.changes, count);

    const historicalInsert = db.prepare(`
      WITH RECURSIVE fixture_rows(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1
        FROM fixture_rows
        WHERE value < @count
      )
      INSERT INTO campaign_record_links (
        id,org_id,campaign_id,record_type,bundle_id,record_id,relation_type,
        created_by,metadata_json,revoked_at,revoked_by,revoke_reason
      )
      SELECT
        @linkBase + (value * 2) - 1,
        @orgId,
        @siblingCampaignId,
        'knowledge_entry',
        '6' || printf('%063x', @linkBase + (value * 2) - 1),
        CAST(@entryBase + value AS TEXT),
        'knowledge',
        @userId,
        '{}',
        '2099-01-01 00:00:00',
        @userId,
        'Older historical custody fixture'
      FROM fixture_rows
    `).run(params);
    assert.equal(historicalInsert.changes, count);

    const winningInsert = db.prepare(`
      WITH RECURSIVE fixture_rows(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1
        FROM fixture_rows
        WHERE value < @count
      )
      INSERT INTO campaign_record_links (
        id,org_id,campaign_id,record_type,bundle_id,record_id,relation_type,
        created_by,metadata_json,revoked_at,revoked_by,revoke_reason
      )
      SELECT
        @linkBase + (value * 2),
        @orgId,
        @campaignId,
        'knowledge_entry',
        '5' || printf('%063x', @linkBase + (value * 2)),
        CAST(@entryBase + value AS TEXT),
        'knowledge',
        @userId,
        '{}',
        CASE WHEN value % 2 = 0 THEN '2099-01-02 00:00:00' ELSE NULL END,
        CASE WHEN value % 2 = 0 THEN @userId ELSE NULL END,
        CASE
          WHEN value % 2 = 0 THEN 'Newest historical custody fixture'
          ELSE NULL
        END
      FROM fixture_rows
    `).run(params);
    assert.equal(winningInsert.changes, count);
  });
  return {
    entryBase,
    entryCount: count,
    activeCount: Math.ceil(count / 2),
    historicalCount: Math.floor(count / 2)
  };
}

function seedUnlinkedOrganizationMemberVolume(db, context, count) {
  assert.ok(Number.isSafeInteger(count) && count > 0);
  const member = db.prepare(`
    SELECT user_id
    FROM organization_memberships
    WHERE org_id=? AND user_id<>? AND status='active'
    ORDER BY user_id DESC
    LIMIT 1
  `).get(context.orgId, context.userId);
  assert.ok(member);
  const revokedAt = '2099-01-03 00:00:00';
  assert.ok(
    db.prepare(`
      UPDATE team_memberships
      SET status='revoked',revoked_at=@revokedAt
      WHERE org_id=@orgId AND user_id=@userId AND status='active'
    `).run({
      orgId: context.orgId,
      userId: member.user_id,
      revokedAt
    }).changes > 0
  );
  assert.equal(
    db.prepare(`
      UPDATE organization_memberships
      SET status='revoked',revoked_at=@revokedAt
      WHERE org_id=@orgId AND user_id=@userId AND status='active'
    `).run({
      orgId: context.orgId,
      userId: member.user_id,
      revokedAt
    }).changes,
    1
  );

  const entryBase = db.prepare(
    'SELECT COALESCE(MAX(id),0) AS max_id FROM knowledge_entries'
  ).get().max_id;
  const chunkBase = db.prepare(
    'SELECT COALESCE(MAX(id),0) AS max_id FROM knowledge_chunks'
  ).get().max_id;
  const conversationBase = db.prepare(
    'SELECT COALESCE(MAX(id),0) AS max_id FROM ai_conversations'
  ).get().max_id;
  const messageBase = db.prepare(
    'SELECT COALESCE(MAX(id),0) AS max_id FROM ai_messages'
  ).get().max_id;
  const referenceBase = db.prepare(
    'SELECT COALESCE(MAX(id),0) AS max_id FROM ai_references'
  ).get().max_id;
  const params = {
    count,
    entryBase: BigInt(entryBase),
    chunkBase: BigInt(chunkBase),
    conversationBase: BigInt(conversationBase),
    messageBase: BigInt(messageBase),
    referenceBase: BigInt(referenceBase),
    userId: member.user_id
  };
  withSuspendedTriggers(db, [
    'ai_references_v1_shape_insert',
    'campaign_knowledge_chunk_no_insert',
    'knowledge_entries_no_replace_insert'
  ], () => {
    const entryInsert = db.prepare(`
      WITH RECURSIVE fixture_rows(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1
        FROM fixture_rows
        WHERE value < @count
      )
      INSERT INTO knowledge_entries (
        id,entry_type,source_type,source_id,key_terms,content,created_by,
        is_public,title,summary,tags_json,visibility,source_hash,business_type,
        business_id,metadata_json,embedding_json,source_identity_sha256,
        content_sha256
      )
      SELECT
        @entryBase + value,
        'organization_member_volume_fixture',
        'organization_member_volume_fixture',
        'unlinked-member-volume-' || value,
        '["organization","volume"]',
        'Unlinked member volume content ' || value,
        @userId,
        0,
        'Unlinked member volume ' || value,
        'Unlinked member volume summary ' || value,
        '["organization","volume"]',
        'private',
        NULL,
        NULL,
        NULL,
        '{}',
        NULL,
        '4' || printf('%063x', @entryBase + value),
        '3' || printf('%063x', @entryBase + value)
      FROM fixture_rows
    `).run(params);
    assert.equal(entryInsert.changes, count);

    const chunkInsert = db.prepare(`
      WITH RECURSIVE fixture_rows(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1
        FROM fixture_rows
        WHERE value < @count
      )
      INSERT INTO knowledge_chunks (
        id,entry_id,chunk_index,content,metadata_json,token_count,
        embedding_json,content_sha256
      )
      SELECT
        @chunkBase + value,
        @entryBase + value,
        0,
        'Unlinked member volume content ' || value,
        '{"title":"Unlinked member volume"}',
        1,
        NULL,
        '2' || printf('%063x', @chunkBase + value)
      FROM fixture_rows
    `).run(params);
    assert.equal(chunkInsert.changes, count);

    const conversationInsert = db.prepare(`
      WITH RECURSIVE fixture_rows(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1
        FROM fixture_rows
        WHERE value < @count
      )
      INSERT INTO ai_conversations (
        id,user_id,title,visibility,source_module
      )
      SELECT
        @conversationBase + value,
        @userId,
        'Unlinked member volume conversation ' || value,
        'private',
        'campaign_capacity_fixture'
      FROM fixture_rows
    `).run(params);
    assert.equal(conversationInsert.changes, count);

    const messageInsert = db.prepare(`
      WITH RECURSIVE fixture_rows(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1
        FROM fixture_rows
        WHERE value < @count
      )
      INSERT INTO ai_messages (
        id,conversation_id,user_id,role,content,metadata_json
      )
      SELECT
        @messageBase + value,
        @conversationBase + value,
        @userId,
        'assistant',
        'Unlinked member volume message ' || value,
        '{}'
      FROM fixture_rows
    `).run(params);
    assert.equal(messageInsert.changes, count);

    const referenceInsert = db.prepare(`
      WITH RECURSIVE fixture_rows(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1
        FROM fixture_rows
        WHERE value < @count
      )
      INSERT INTO ai_references (
        id,message_id,reference_type,reference_id,title,url,snippet,
        provider,metadata_json
      )
      SELECT
        @referenceBase + value,
        @messageBase + value,
        'organization_member_volume_fixture',
        'unlinked-member-reference-' || value,
        'Unlinked member reference ' || value,
        '',
        '',
        'fixture',
        '{}'
      FROM fixture_rows
    `).run(params);
    assert.equal(referenceInsert.changes, count);
  });
  return {
    entryCount: count,
    chunkCount: count,
    referenceCount: count,
    userId: member.user_id
  };
}

function capacityPlanDetails(db, sql) {
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((row) => row.detail);
}

const TASK5_CAMPAIGN_POLICIES = Object.freeze([
  'CAMPAIGN_OPTIONS',
  'CAMPAIGN_CREATE',
  'CAMPAIGN_LIST',
  'CAMPAIGN_DETAIL',
  'CAMPAIGN_UPDATE',
  'CAMPAIGN_TRANSITION',
  'CAMPAIGN_OPERATIONAL_ACTION',
  'CAMPAIGN_TRANSFER',
  'CAMPAIGN_LINK_ATTACH',
  'CAMPAIGN_LINK_CORRECT',
  'CAMPAIGN_LINK_CANDIDATES',
  'CAMPAIGN_WORKSPACE',
  'CAMPAIGN_KNOWLEDGE_LIST',
  'CAMPAIGN_KNOWLEDGE_DETAIL',
  'CAMPAIGN_REVIEW_CREATE'
]);

async function startCampaignApi(db, actorUserId) {
  const registerCampaignRoutes = require('../routes_campaigns');
  const registry = campaignContract.createRoutePolicyRegistry(
    TASK5_CAMPAIGN_POLICIES.map((name) => campaignContract.REQUEST_POLICIES[name])
  );
  const app = express();
  const pipeline = createPhase4RequestPipeline({
    registry,
    authenticate(request) {
      const user = db.prepare(`
        SELECT id,username,display_name,role,department,is_active
        FROM users
        WHERE id=? AND is_active=1
      `).get(actorUserId);
      if (!user) return null;
      request.user = user;
      return { user };
    },
    generateRequestId: () => 'task5-request-0001'
  });
  app.use(pipeline.middleware);
  registerCampaignRoutes(app, db);
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    async request(method, requestPath, options = {}) {
      const headers = {
        Authorization: 'Bearer task5-test-token',
        'X-Request-Id': options.requestId || 'task5-request-0001'
      };
      let body;
      if (Object.hasOwn(options, 'body')) {
        headers['Content-Type'] = 'application/json; charset=utf-8';
        body = JSON.stringify(options.body);
      }
      if (options.idempotencyKey) {
        headers['Idempotency-Key'] = options.idempotencyKey;
      }
      const response = await fetch(baseUrl + requestPath, {
        method,
        headers,
        body
      });
      return {
        status: response.status,
        requestId: response.headers.get('x-request-id'),
        body: await response.json()
      };
    },
    async close() {
      server.close();
      await once(server, 'close');
    }
  };
}

function instrumentReadDatabase(db) {
  const stats = { statements: 0, rows: 0 };
  const instrumented = new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql) => {
          stats.statements += 1;
          const statement = target.prepare(sql);
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              if (statementProperty === 'all') {
                return (...args) => {
                  const rows = statementTarget.all(...args);
                  stats.rows += rows.length;
                  return rows;
                };
              }
              if (statementProperty === 'get') {
                return (...args) => {
                  const row = statementTarget.get(...args);
                  if (row !== undefined) stats.rows += 1;
                  return row;
                };
              }
              const value = Reflect.get(statementTarget, statementProperty);
              return typeof value === 'function'
                ? value.bind(statementTarget)
                : value;
            }
          });
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  return { db: instrumented, stats };
}

test('campaign knowledge writer requires and preserves a caller-owned transaction', () => {
  const db = openV2Database();
  try {
    const context = createCampaignContext(db);
    const options = writerOptions(context, 1);
    const before = knowledgeStateSummary(db);

    assert.throws(
      () => knowledge.writeCampaignKnowledgeInTransaction(db, options),
      /existing transaction|required transaction|transaction required/i
    );
    assert.equal(db.inTransaction, false);
    assert.deepEqual(knowledgeStateSummary(db), before);

    db.exec('BEGIN IMMEDIATE');
    const result = knowledge.writeCampaignKnowledgeInTransaction(db, options);
    assert.equal(result.status, 'created');
    assert.equal(db.inTransaction, true);
    db.exec('ROLLBACK');

    assert.equal(db.inTransaction, false);
    assert.deepEqual(knowledgeStateSummary(db), before);
  } finally {
    closeWithRollback(db);
  }
});

test('campaign knowledge writer returns exact_existing only for identical entry and ordered chunk digests', () => {
  const db = openV2Database();
  try {
    const context = createCampaignContext(db);
    const options = writerOptions(context, 2, {
      visibility: 'private',
      title: 'Cafe\u0301 replay',
      content: 'Line one\r\nLine two'
    });
    db.exec('BEGIN IMMEDIATE');

    const created = knowledge.writeCampaignKnowledgeInTransaction(db, options);
    const custodyLinkId = linkKnowledgeEntry(
      db,
      context,
      created.entry.id,
      'exact-replay'
    );
    const afterCreated = knowledgeStateSummary(db);
    const replay = knowledge.writeCampaignKnowledgeInTransaction(db, {
      ...options,
      title: 'Caf\u00e9 replay',
      content: 'Line one\nLine two'
    });

    assert.equal(created.status, 'created');
    assert.equal(replay.status, 'exact_existing');
    assert.deepEqual(replay.entry, created.entry);
    assert.deepEqual(replay.chunks, created.chunks);
    assert.deepEqual(knowledgeStateSummary(db), afterCreated);
    assert.equal(created.entry.source_identity_sha256, campaignSourceDigest(options));
    assert.equal(created.entry.content_sha256, campaignContentDigest(options));
    assert.deepEqual(
      created.chunks.map((chunk) => chunk.content_sha256),
      created.chunks.map((chunk) => sha256(Buffer.from(chunk.content, 'utf8')))
    );

    revokeKnowledgeLink(db, custodyLinkId, context.userId);
    const historicalReplay = knowledge.writeCampaignKnowledgeInTransaction(
      db,
      options
    );
    assert.equal(historicalReplay.status, 'exact_existing');
    assert.deepEqual(historicalReplay.entry, created.entry);
    assert.deepEqual(historicalReplay.chunks, created.chunks);
  } finally {
    closeWithRollback(db);
  }
});

test('campaign knowledge writer rejects an exact unlinked source instead of reusing it', () => {
  const db = openV2Database();
  try {
    const context = createCampaignContext(db);
    const options = writerOptions(context, 21);
    db.exec('BEGIN IMMEDIATE');
    knowledge.writeCampaignKnowledgeInTransaction(db, options);
    const beforeReplay = knowledgeStateSummary(db);

    assertCampaignKnowledgeConflict(
      () => knowledge.writeCampaignKnowledgeInTransaction(db, options)
    );
    assert.deepEqual(knowledgeStateSummary(db), beforeReplay);
  } finally {
    closeWithRollback(db);
  }
});

test('campaign knowledge writer rejects exact evidence with different active or historical custody', () => {
  const db = openV2Database();
  try {
    const context = createCampaignContext(db);
    const sibling = createSiblingCampaign(db, context);
    const options = writerOptions(context, 22);
    db.exec('BEGIN IMMEDIATE');
    const created = knowledge.writeCampaignKnowledgeInTransaction(db, options);
    const differentCustodyLinkId = linkKnowledgeEntry(
      db,
      sibling,
      created.entry.id,
      'different-custody'
    );
    const beforeReplay = knowledgeStateSummary(db);

    assertCampaignKnowledgeConflict(
      () => knowledge.writeCampaignKnowledgeInTransaction(db, options)
    );
    revokeKnowledgeLink(db, differentCustodyLinkId, context.userId);
    assertCampaignKnowledgeConflict(
      () => knowledge.writeCampaignKnowledgeInTransaction(db, options)
    );
    assert.deepEqual(knowledgeStateSummary(db), beforeReplay);
  } finally {
    closeWithRollback(db);
  }
});

test('campaign knowledge writer throws a typed digest conflict without overwriting an immutable source', () => {
  const db = openV2Database();
  try {
    const context = createCampaignContext(db);
    const options = writerOptions(context, 3);
    db.exec('BEGIN IMMEDIATE');
    const created = knowledge.writeCampaignKnowledgeInTransaction(db, options);
    const beforeConflict = knowledgeStateSummary(db);

    assert.throws(
      () => knowledge.writeCampaignKnowledgeInTransaction(db, {
        ...options,
        content: 'Different content for the same immutable source'
      }),
      (error) => {
        assert.equal(error.name, 'CampaignKnowledgeConflictError');
        assert.equal(error.code, 'KNOWLEDGE_SOURCE_CONTENT_CONFLICT');
        assert.equal(error.statusCode, 409);
        return true;
      }
    );
    assert.deepEqual(knowledgeStateSummary(db), beforeConflict);
    assert.equal(
      db.prepare(
        'SELECT content FROM knowledge_entries WHERE id=?'
      ).get(created.entry.id).content,
      options.content
    );
  } finally {
    closeWithRollback(db);
  }
});

test('campaign knowledge writer canonicalizes Unicode and preserves scalar chunk boundaries with explicit IDs', () => {
  const db = openV2Database();
  try {
    const context = createCampaignContext(db);
    db.exec('BEGIN IMMEDIATE');
    setSequence(db, 'knowledge_entries', 1000);
    setSequence(db, 'knowledge_chunks', 2000);

    const canonicalOptions = writerOptions(context, 4, {
      title: 'Cafe\u0301 guide',
      summary: 'Summary\r\nline',
      content: ' Alpha\r\n\r\nBeta \ud83d\ude00 ',
      tags: ['z', 'e\u0301', '\u00e9', 'a']
    });
    const canonical = knowledge.writeCampaignKnowledgeInTransaction(
      db,
      canonicalOptions
    );
    assert.equal(canonical.entry.id, 1001);
    assert.equal(canonical.entry.title, 'Caf\u00e9 guide');
    assert.equal(canonical.entry.summary, 'Summary\nline');
    assert.equal(canonical.entry.content, ' Alpha\n\nBeta \ud83d\ude00 ');
    assert.deepEqual(canonical.entry.tags, ['a', 'z', '\u00e9']);
    assert.deepEqual(
      canonical.chunks.map((chunk) => ({
        id: chunk.id,
        index: chunk.chunk_index,
        content: chunk.content,
        digest: chunk.content_sha256
      })),
      [{
        id: 2001,
        index: 0,
        content: 'Alpha\n\nBeta \ud83d\ude00',
        digest: '73a747f2a6e9c5e3e65eb8552d8100319eda2cecae356c8abb7496ecf2fa1b3b'
      }]
    );

    const boundaryOptions = writerOptions(context, 5, {
      content: 'a'.repeat(1201)
    });
    const boundary = knowledge.writeCampaignKnowledgeInTransaction(
      db,
      boundaryOptions
    );
    assert.equal(boundary.entry.id, 1002);
    assert.deepEqual(
      boundary.chunks.map((chunk) => [
        chunk.id,
        chunk.chunk_index,
        Array.from(chunk.content).length,
        chunk.content_sha256
      ]),
      [
        [
          2002,
          0,
          1200,
          '4d21dde662555b99cb697061c3b5041108dedb8825a4bc5858737afbf640e492'
        ],
        [
          2003,
          1,
          1,
          'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb'
        ]
      ]
    );
    assert.deepEqual(
      db.prepare(`
        SELECT
          typeof(entry.id) AS entry_id_type,
          typeof(chunk.id) AS chunk_id_type,
          typeof(chunk.entry_id) AS chunk_entry_id_type,
          typeof(chunk.chunk_index) AS chunk_index_type
        FROM knowledge_entries entry
        JOIN knowledge_chunks chunk ON chunk.entry_id=entry.id
        WHERE entry.id IN (?,?)
        ORDER BY entry.id,chunk.chunk_index
      `).all(canonical.entry.id, boundary.entry.id),
      [
        {
          entry_id_type: 'integer',
          chunk_id_type: 'integer',
          chunk_entry_id_type: 'integer',
          chunk_index_type: 'integer'
        },
        {
          entry_id_type: 'integer',
          chunk_id_type: 'integer',
          chunk_entry_id_type: 'integer',
          chunk_index_type: 'integer'
        },
        {
          entry_id_type: 'integer',
          chunk_id_type: 'integer',
          chunk_entry_id_type: 'integer',
          chunk_index_type: 'integer'
        }
      ]
    );
    assert.deepEqual(
      db.prepare(`
        SELECT title,content,tags,entry_id,chunk_id
        FROM knowledge_chunks_fts
        WHERE entry_id=?
        ORDER BY CAST(chunk_id AS INTEGER),rowid
      `).all(canonical.entry.id),
      [{
        title: 'Caf\u00e9 guide',
        content: 'Alpha\n\nBeta \ud83d\ude00',
        tags: 'a z \u00e9',
        entry_id: canonical.entry.id,
        chunk_id: canonical.chunks[0].id
      }]
    );

    const beforeInvalid = knowledgeStateSummary(db);
    assert.throws(
      () => knowledge.writeCampaignKnowledgeInTransaction(
        db,
        writerOptions(context, 6, { content: '\ud800' })
      ),
      /surrogate|scalar|Unicode/i
    );
    assert.deepEqual(knowledgeStateSummary(db), beforeInvalid);
  } finally {
    closeWithRollback(db);
  }
});

test('campaign knowledge writer rejects affinity-changing numeric source literals and replays canonical decimal 7', () => {
  const db = openV2Database();
  try {
    const context = createCampaignContext(db);
    db.exec('BEGIN IMMEDIATE');
    const beforeInvalid = knowledgeStateSummary(db);
    const accepted = [];
    const unexpected = [];
    for (const [index, sourceId] of ['+7', '7.0', '1e3'].entries()) {
      try {
        knowledge.writeCampaignKnowledgeInTransaction(
          db,
          writerOptions(context, 30 + index, { sourceId })
        );
        accepted.push(sourceId);
      } catch (error) {
        if (
          !(error instanceof TypeError) ||
          !/canonical|numeric|affinity/i.test(error.message)
        ) {
          unexpected.push({ sourceId, name: error.name, message: error.message });
        }
      }
    }
    assert.deepEqual(unexpected, []);
    assert.deepEqual(accepted, []);
    assert.deepEqual(knowledgeStateSummary(db), beforeInvalid);

    const canonicalOptions = writerOptions(context, 34, { sourceId: '7' });
    const created = knowledge.writeCampaignKnowledgeInTransaction(
      db,
      canonicalOptions
    );
    linkKnowledgeEntry(db, context, created.entry.id, 'canonical-source-7');
    const replay = knowledge.writeCampaignKnowledgeInTransaction(db, {
      ...canonicalOptions,
      sourceId: 7
    });
    assert.equal(replay.status, 'exact_existing');
    assert.deepEqual(replay.entry, created.entry);
    assert.deepEqual(replay.chunks, created.chunks);
    assert.deepEqual(
      db.prepare(`
        SELECT typeof(source_id) AS storage_type,CAST(source_id AS TEXT) AS value
        FROM knowledge_entries
        WHERE id=?
      `).get(created.entry.id),
      { storage_type: 'integer', value: '7' }
    );
  } finally {
    closeWithRollback(db);
  }
});

test('campaign knowledge exact replay fails closed when its FTS projection is missing', () => {
  const db = openV2Database();
  try {
    const context = createCampaignContext(db);
    const options = writerOptions(context, 40);
    db.exec('BEGIN IMMEDIATE');
    const created = knowledge.writeCampaignKnowledgeInTransaction(db, options);
    linkKnowledgeEntry(db, context, created.entry.id, 'missing-fts');
    assert.equal(
      db.prepare(
        'DELETE FROM knowledge_chunks_fts WHERE entry_id=?'
      ).run(created.entry.id).changes,
      created.chunks.length
    );

    assertCampaignKnowledgeConflict(
      () => knowledge.writeCampaignKnowledgeInTransaction(db, options)
    );
  } finally {
    closeWithRollback(db);
  }
});

test('campaign knowledge exact replay fails closed when its FTS projection is tampered', () => {
  const db = openV2Database();
  try {
    const context = createCampaignContext(db);
    const options = writerOptions(context, 41);
    db.exec('BEGIN IMMEDIATE');
    const created = knowledge.writeCampaignKnowledgeInTransaction(db, options);
    linkKnowledgeEntry(db, context, created.entry.id, 'tampered-fts');
    assert.equal(
      db.prepare(`
        UPDATE knowledge_chunks_fts
        SET title='Tampered campaign knowledge title'
        WHERE entry_id=?
      `).run(created.entry.id).changes,
      created.chunks.length
    );

    assertCampaignKnowledgeConflict(
      () => knowledge.writeCampaignKnowledgeInTransaction(db, options)
    );
  } finally {
    closeWithRollback(db);
  }
});

test('campaign review writer rejects the same review source identity for a different private owner', () => {
  const db = openV2Database();
  try {
    const context = createCampaignContext(db);
    const otherMember = db.prepare(`
      SELECT user_id
      FROM organization_memberships
      WHERE org_id=? AND user_id<>?
      ORDER BY user_id
      LIMIT 1
    `).get(context.orgId, context.userId);
    assert.ok(otherMember);
    const options = writerOptions(context, 50, {
      sourceType: 'campaign_review',
      sourceId: `${context.campaignId}:950001`,
      entryType: 'campaign_review',
      title: 'Campaign review',
      summary: 'Campaign review summary',
      content: 'Campaign review content',
      tags: ['campaign', 'review'],
      visibility: 'private'
    });
    db.exec('BEGIN IMMEDIATE');
    knowledge.writeCampaignKnowledgeInTransaction(db, options);
    const beforeConflict = knowledgeStateSummary(db);

    assertCampaignKnowledgeConflict(
      () => knowledge.writeCampaignKnowledgeInTransaction(db, {
        ...options,
        createdBy: otherMember.user_id
      })
    );
    assert.deepEqual(knowledgeStateSummary(db), beforeConflict);
  } finally {
    closeWithRollback(db);
  }
});

test('campaign knowledge capacity preflight uses bounded authoritative gauges at volume', (t) => {
  const capacitySql = [];
  let captureCapacitySql = false;
  const db = openV4Database({
    verbose(sql) {
      if (
        captureCapacitySql &&
        sql.includes('SELECT scope_type,scope_id,metric,usage_value,limit_value') &&
        sql.includes('FROM knowledge_capacity_gauges')
      ) {
        capacitySql.push(sql);
      }
    }
  });
  try {
    const context = createCampaignContext(db);
    const sibling = createSiblingCampaign(db, context);
    db.exec('BEGIN IMMEDIATE');
    const fixture = seedLinkedKnowledgeVolume(
      db,
      context,
      sibling,
      LINKED_CUSTODY_VOLUME
    );
    const unlinkedFixture = seedUnlinkedOrganizationMemberVolume(
      db,
      context,
      UNLINKED_MEMBER_VOLUME
    );
    assert.deepEqual(
      db.prepare(`
        SELECT
          SUM(CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END) AS active_count,
          SUM(CASE WHEN revoked_at IS NOT NULL THEN 1 ELSE 0 END) AS revoked_count
        FROM campaign_record_links
        WHERE record_type='knowledge_entry'
      `).get(),
      {
        active_count: fixture.activeCount,
        revoked_count: fixture.entryCount + fixture.historicalCount
      }
    );
    assert.equal(
      db.prepare(`
        SELECT status
        FROM organization_memberships
        WHERE org_id=? AND user_id=?
      `).get(context.orgId, unlinkedFixture.userId).status,
      'revoked'
    );
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM knowledge_entries entry
        LEFT JOIN campaign_record_links link
          ON link.record_type='knowledge_entry'
          AND link.record_id=CAST(entry.id AS TEXT)
          AND link.relation_type<>'shortlist'
        WHERE entry.source_type='organization_member_volume_fixture'
          AND entry.created_by=?
          AND link.id IS NULL
      `).get(unlinkedFixture.userId).count,
      UNLINKED_MEMBER_VOLUME
    );
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM ai_references reference
        JOIN ai_messages message ON message.id=reference.message_id
        JOIN ai_conversations conversation
          ON conversation.id=message.conversation_id
        WHERE reference.campaign_id IS NULL
          AND conversation.user_id=?
      `).get(unlinkedFixture.userId).count,
      UNLINKED_MEMBER_VOLUME
    );

    captureCapacitySql = true;
    const startedAt = performance.now();
    const created = knowledge.writeCampaignKnowledgeInTransaction(
      db,
      writerOptions(context, 60)
    );
    const elapsedMs = performance.now() - startedAt;
    captureCapacitySql = false;

    assert.equal(created.status, 'created');
    assert.equal(db.inTransaction, true);
    assert.equal(capacitySql.length, 1);
    const authoritySql = capacitySql[0];
    assert.doesNotMatch(
      authoritySql,
      /knowledge_entries|knowledge_chunks|ai_references|campaign_record_links/
    );
    const planByScope = new Map(created.capacityGaugePlan.map((scope) => (
      [`${scope.scopeType}:${scope.scopeId}`, scope.usage]
    )));
    assert.equal(
      planByScope.get(`campaign:${context.campaignId}`).entries,
      LINKED_CUSTODY_VOLUME + 1
    );
    assert.equal(
      planByScope.get(`organization:${context.orgId}`).entries,
      LINKED_CUSTODY_VOLUME + UNLINKED_MEMBER_VOLUME + 1
    );
    assert.equal(
      planByScope.get(`organization:${context.orgId}`).references,
      UNLINKED_MEMBER_VOLUME
    );

    const plans = [{ scope: 'authority', details: capacityPlanDetails(db, authoritySql) }];
    t.diagnostic(
      `linked custody rows=${LINKED_CUSTODY_VOLUME}, ` +
      `active=${fixture.activeCount}, historical=${fixture.historicalCount}, ` +
      `unlinked member entries=${unlinkedFixture.entryCount}, ` +
      `unlinked member references=${unlinkedFixture.referenceCount}, ` +
      `writer_elapsed_ms=${elapsedMs.toFixed(3)}`
    );
    t.diagnostic(
      plans.map((plan) => (
        `${plan.scope} plan:\n  ${plan.details.join('\n  ')}`
      )).join('\n')
    );
    assert.ok(
      elapsedMs < Math.min(VOLUME_RUNTIME_LIMIT_MS, 500),
      'linked custody writer exceeded 500ms authority guard: ' +
        `${elapsedMs.toFixed(3)}ms`
    );
    assert.ok(
      plans[0].details.some(
        (detail) => /SEARCH knowledge_capacity_gauges USING PRIMARY KEY/i.test(detail)
      ),
      plans[0].details.join('\n')
    );
  } finally {
    captureCapacitySql = false;
    closeWithRollback(db);
  }
});

test('campaign knowledge writer admits the exact user entry limit and rejects limit plus one before mutation', () => {
  const db = openV4Database();
  try {
    const context = createCampaignContext(db);
    db.exec('BEGIN IMMEDIATE');
    const existing = db.prepare(
      'SELECT COUNT(*) AS count FROM knowledge_entries WHERE created_by=?'
    ).get(context.userId).count;
    assert.ok(existing < USER_ENTRY_LIMIT);
    bulkFillUserEntries(
      db,
      context.userId,
      USER_ENTRY_LIMIT - existing - 1
    );
    assert.equal(
      db.prepare(
        'SELECT COUNT(*) AS count FROM knowledge_entries WHERE created_by=?'
      ).get(context.userId).count,
      USER_ENTRY_LIMIT - 1
    );

    const atLimit = knowledge.writeCampaignKnowledgeInTransaction(
      db,
      writerOptions(context, 7)
    );
    assert.equal(atLimit.status, 'created');
    assert.equal(
      db.prepare(
        'SELECT COUNT(*) AS count FROM knowledge_entries WHERE created_by=?'
      ).get(context.userId).count,
      USER_ENTRY_LIMIT
    );
    const beforeOverflow = knowledgeStateSummary(db);

    assert.throws(
      () => knowledge.writeCampaignKnowledgeInTransaction(
        db,
        writerOptions(context, 8)
      ),
      (error) => {
        assert.equal(error.name, 'CampaignKnowledgeCapacityError');
        assert.equal(error.code, 'KNOWLEDGE_STORAGE_CAPACITY_EXCEEDED');
        assert.equal(error.statusCode, 507);
        assert.equal(error.details.scope, 'user');
        assert.equal(error.details.metric, 'entries');
        assert.equal(error.details.limit, USER_ENTRY_LIMIT);
        assert.equal(error.details.projected, USER_ENTRY_LIMIT + 1);
        return true;
      }
    );
    assert.deepEqual(knowledgeStateSummary(db), beforeOverflow);
  } finally {
    closeWithRollback(db);
  }
});

test('campaign knowledge insertion failure leaves rollback ownership with the caller', () => {
  const db = openV2Database();
  try {
    const context = createCampaignContext(db);
    db.exec(`
      CREATE TRIGGER test_fail_campaign_knowledge_chunk_insert
      BEFORE INSERT ON knowledge_chunks
      BEGIN
        SELECT RAISE(ABORT,'injected campaign knowledge chunk failure');
      END
    `);
    const before = knowledgeStateSummary(db);
    db.exec('BEGIN IMMEDIATE');

    assert.throws(
      () => knowledge.writeCampaignKnowledgeInTransaction(
        db,
        writerOptions(context, 9)
      ),
      /injected campaign knowledge chunk failure/
    );
    assert.equal(db.inTransaction, true);
    assert.equal(
      db.prepare(
        'SELECT COUNT(*) AS count FROM knowledge_entries'
      ).get().count,
      before.entries + 1,
      'the helper must not silently roll back the caller transaction'
    );

    db.exec('ROLLBACK');
    assert.equal(db.inTransaction, false);
    assert.deepEqual(knowledgeStateSummary(db), before);
  } finally {
    closeWithRollback(db);
  }
});

test('campaign knowledge writer creates no campaign links, events, versions, dispatches, or ledger rows', () => {
  const db = openV2Database();
  try {
    const context = createCampaignContext(db);
    const before = campaignSideEffects(db, context.campaignId);
    db.exec('BEGIN IMMEDIATE');

    const result = knowledge.writeCampaignKnowledgeInTransaction(
      db,
      writerOptions(context, 10)
    );
    assert.equal(result.status, 'created');
    assert.deepEqual(campaignSideEffects(db, context.campaignId), before);
    assert.equal(
      db.prepare(
        'SELECT COUNT(*) AS count FROM knowledge_entries WHERE id=?'
      ).get(result.entry.id).count,
      1
    );
    assert.equal(
      db.prepare(
        'SELECT COUNT(*) AS count FROM campaign_record_links WHERE record_type=? AND record_id=?'
      ).get('knowledge_entry', String(result.entry.id)).count,
      0
    );
    assert.equal(db.inTransaction, true);
  } finally {
    closeWithRollback(db);
  }
});

test('GET campaign opportunity options returns one bounded permission-filtered resource', async (t) => {
  const db = openV2Database();
  const context = createCampaignContext(db);
  const api = await startCampaignApi(db, context.userId);
  t.after(async () => {
    await api.close();
    db.close();
  });

  const response = await api.request(
    'GET',
    '/api/campaigns/options?mode=create&resource=opportunities&limit=25&offset=0'
  );

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.requestId, 'task5-request-0001');
  assert.deepEqual(response.body, {
    resource: 'opportunities',
    items: [{
      id: context.opportunityId,
      label: 'Writer Fixture / Campaign writer fixture',
      customer_id: context.customerId
    }],
    total: 1,
    limit: 25,
    offset: 0
  });
});

test('campaign opportunity options bound SQL work before pagination at volume', () => {
  const db = openV2Database();
  try {
    const context = createCampaignContext(db);
    const count = 1000;
    const customerBase = db.prepare(
      'SELECT COALESCE(MAX(id),0) AS value FROM customers'
    ).get().value;
    const opportunityBase = db.prepare(
      'SELECT COALESCE(MAX(id),0) AS value FROM opportunities'
    ).get().value;
    db.prepare(`
      WITH RECURSIVE fixture_rows(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1
        FROM fixture_rows
        WHERE value < @count
      )
      INSERT INTO customers (
        id,brand_name,company_name,stage,source,created_by,assigned_to,is_public
      )
      SELECT
        @customerBase + value,
        'Volume Brand ' || value,
        'Volume Company ' || value,
        'qualified',
        'campaign_option_volume',
        @userId,
        @userId,
        0
      FROM fixture_rows
    `).run({
      count,
      customerBase,
      userId: context.userId
    });
    db.prepare(`
      WITH RECURSIVE fixture_rows(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1
        FROM fixture_rows
        WHERE value < @count
      )
      INSERT INTO opportunities (
        id,customer_id,name,stage,value,win_probability,product_name,
        channel_type,created_by
      )
      SELECT
        @opportunityBase + value,
        @customerBase + value,
        CASE
          WHEN value=777 THEN 'Needle opportunity 777'
          ELSE 'Volume opportunity ' || value
        END,
        'proposal',
        1000,
        50,
        'Volume Product',
        'influencer',
        @userId
      FROM fixture_rows
    `).run({
      count,
      customerBase,
      opportunityBase,
      userId: context.userId
    });
    const measured = instrumentReadDatabase(db);
    const service = createCampaignService(measured.db);

    const result = service.getOptions({
      userId: context.userId,
      query: {
        mode: 'create',
        resource: 'opportunities',
        q: 'Needle opportunity 777',
        limit: '1',
        offset: '0'
      }
    });

    assert.equal(result.total, 1);
    assert.equal(result.items.length, 1);
    assert.equal(
      result.items[0].id,
      opportunityBase + 777
    );
    assert.ok(
      measured.stats.statements <= 10,
      `expected at most 10 statements, got ${measured.stats.statements}`
    );
    assert.ok(
      measured.stats.rows <= 25,
      `expected at most 25 materialized rows, got ${measured.stats.rows}`
    );
  } finally {
    db.close();
  }
});

test('GET campaign assignment options returns only legal bounded team-owner pairs', async (t) => {
  const db = openV2Database();
  const context = createCampaignContext(db);
  const expected = db.prepare(`
    SELECT team.id AS team_id,team.name AS team_label,user.id AS owner_id,
      user.display_name AS owner_label
    FROM teams team
    JOIN team_memberships membership
      ON membership.org_id=team.org_id
     AND membership.team_id=team.id
     AND membership.status='active'
    JOIN users user ON user.id=membership.user_id AND user.is_active=1
    WHERE team.org_id=? AND team.id=? AND user.id=?
  `).get(context.orgId, context.teamId, context.userId);
  assert.ok(expected);
  const api = await startCampaignApi(db, context.userId);
  t.after(async () => {
    await api.close();
    db.close();
  });

  const response = await api.request(
    'GET',
    '/api/campaigns/options?mode=create&resource=assignments&limit=50&offset=0'
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.resource, 'assignments');
  assert.equal(response.body.limit, 50);
  assert.equal(response.body.offset, 0);
  assert.equal(response.body.total, response.body.items.length);
  assert.ok(response.body.items.some((item) => (
    item.team.id === expected.team_id &&
    item.team.label === expected.team_label &&
    item.owner.id === expected.owner_id &&
    item.owner.label === expected.owner_label
  )));
  response.body.items.forEach((item) => {
    assert.deepEqual(Object.keys(item), ['team', 'owner']);
    assert.deepEqual(Object.keys(item.team), ['id', 'label']);
    assert.deepEqual(Object.keys(item.owner), ['id', 'label']);
  });
});

test('campaign assignment options filter count and page in SQL at volume', () => {
  const db = openV2Database();
  try {
    const context = createCampaignContext(db);
    const count = 50;
    const userBase = 960000;
    db.prepare(`
      WITH RECURSIVE fixture_rows(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1
        FROM fixture_rows
        WHERE value < @count
      )
      INSERT INTO users (
        id,username,password_hash,display_name,role,is_active
      )
      SELECT
        @userBase + value,
        'assignment-volume-' || value,
        'test-password-hash',
        CASE
          WHEN value=37 THEN 'Needle assignment owner 37'
          ELSE 'Volume assignment owner ' || value
        END,
        'user',
        1
      FROM fixture_rows
    `).run({ count, userBase });
    db.prepare(`
      INSERT INTO organization_memberships (
        org_id,user_id,role_code,status
      )
      SELECT @orgId,id,'member','active'
      FROM users
      WHERE id BETWEEN @firstUserId AND @lastUserId
    `).run({
      orgId: context.orgId,
      firstUserId: userBase + 1,
      lastUserId: userBase + count
    });
    db.prepare(`
      INSERT INTO team_memberships (
        org_id,team_id,user_id,role_code,status
      )
      SELECT @orgId,@teamId,id,'member','active'
      FROM users
      WHERE id BETWEEN @firstUserId AND @lastUserId
    `).run({
      orgId: context.orgId,
      teamId: context.teamId,
      firstUserId: userBase + 1,
      lastUserId: userBase + count
    });
    const measured = instrumentReadDatabase(db);
    const service = createCampaignService(measured.db);

    const result = service.getOptions({
      userId: context.userId,
      query: {
        mode: 'create',
        resource: 'assignments',
        q: 'Needle assignment owner 37',
        limit: '1',
        offset: '0'
      }
    });

    assert.equal(result.total, 1);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].owner.id, userBase + 37);
    assert.ok(
      measured.stats.statements <= 12,
      `expected at most 12 statements, got ${measured.stats.statements}`
    );
    assert.ok(
      measured.stats.rows <= 25,
      `expected at most 25 materialized rows, got ${measured.stats.rows}`
    );
  } finally {
    db.close();
  }
});

test('POST campaigns atomically creates lead event and terminal replay once', async (t) => {
  const db = openV2Database();
  const context = createCampaignContext(db);
  const api = await startCampaignApi(db, context.userId);
  t.after(async () => {
    await api.close();
    db.close();
  });
  const body = {
    name: 'Task 5 launch',
    opportunity_id: context.opportunityId,
    owner_user_id: context.userId,
    team_id: context.teamId,
    product_name: 'Widget',
    region: 'North America',
    currency: 'USD',
    budget_minor: 2500000,
    start_date: '2026-08-01',
    end_date: '2026-09-30'
  };
  const options = {
    body,
    idempotencyKey: 'campaign-create-task5-0001'
  };

  const created = await api.request('POST', '/api/campaigns', options);
  const replay = await api.request('POST', '/api/campaigns', options);

  assert.equal(created.status, 201);
  assert.deepEqual(replay, created);
  assert.equal(created.body.campaign.name, body.name);
  assert.equal(created.body.campaign.lifecycle_state, 'lead');
  assert.equal(created.body.campaign.operational_status, 'active');
  assert.equal(created.body.campaign.row_version, 1);
  assert.deepEqual(created.body.campaign.customer, {
    id: context.customerId,
    label: 'Writer Fixture'
  });
  assert.deepEqual(created.body.campaign.opportunity, {
    id: context.opportunityId,
    label: 'Campaign writer fixture'
  });
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM campaigns WHERE name=?').get(body.name).count,
    1
  );
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM campaign_events
      WHERE campaign_id=? AND event_type='campaign_created'
    `).get(created.body.campaign.id).count,
    1
  );
  assert.deepEqual(
    db.prepare(`
      SELECT state,status_code,response_kind,expected_event_count
      FROM request_idempotency
      WHERE scope='campaign.create' AND idempotency_key=?
    `).get(options.idempotencyKey),
    {
      state: 'completed',
      status_code: 201,
      response_kind: 'json',
      expected_event_count: 1
    }
  );
});

test('POST campaigns reauthorizes and reclaims a stale retained creation', async (t) => {
  const db = openV2Database();
  const context = createCampaignContext(db);
  const body = {
    name: 'Campaign writer fixture',
    opportunity_id: context.opportunityId,
    owner_user_id: context.userId,
    team_id: context.teamId
  };
  const idempotencyKey = 'campaign-create-stale-processing';
  const ledgerInput = campaignCreateIdempotencyInput(
    context,
    idempotencyKey,
    body
  );
  const stale = insertStaleCampaignProcessingLedger(
    db,
    ledgerInput,
    idempotencyKey
  );
  const api = await startCampaignApi(db, context.userId);
  t.after(async () => {
    await api.close();
    db.close();
  });

  const response = await api.request(
    'POST',
    '/api/campaigns',
    { body, idempotencyKey }
  );

  assert.equal(response.status, 201);
  assert.equal(response.body.campaign.id, context.campaignId);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM campaigns').get().count,
    1
  );
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM campaign_events
      WHERE campaign_id=? AND event_type='campaign_created'
        AND audit_fingerprint=?
    `).get(context.campaignId, stale.auditFingerprint).count,
    1
  );
  assert.deepEqual(
    db.prepare(`
      SELECT id,state,status_code,reservation_nonce,lease_token
      FROM request_idempotency
      WHERE scope='campaign.create' AND idempotency_key=?
    `).get(idempotencyKey),
    {
      id: stale.ledgerId,
      state: 'completed',
      status_code: 201,
      reservation_nonce: stale.reservationNonce,
      lease_token: null
    }
  );
});

test('GET campaigns filters before count and returns stable campaign projections', async (t) => {
  const db = openV2Database();
  const context = createCampaignContext(db);
  const api = await startCampaignApi(db, context.userId);
  t.after(async () => {
    await api.close();
    db.close();
  });

  const response = await api.request(
    'GET',
    '/api/campaigns?q=writer&state=lead&operational_status=active&limit=25&offset=0'
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.total, 1);
  assert.equal(response.body.limit, 25);
  assert.equal(response.body.offset, 0);
  assert.equal(response.body.items.length, 1);
  assert.equal(response.body.items[0].id, context.campaignId);
  assert.deepEqual(response.body.items[0].customer, {
    id: context.customerId,
    label: 'Writer Fixture'
  });
  assert.deepEqual(Object.keys(response.body), ['items', 'total', 'limit', 'offset']);
});

test('GET campaign detail returns bounded projection and conceals a missing campaign', async (t) => {
  const db = openV2Database();
  const context = createCampaignContext(db);
  const api = await startCampaignApi(db, context.userId);
  t.after(async () => {
    await api.close();
    db.close();
  });

  const found = await api.request('GET', `/api/campaigns/${context.campaignId}`);
  const missing = await api.request('GET', '/api/campaigns/9007199254740991');

  assert.equal(found.status, 200);
  assert.deepEqual(found.body, {
    campaign: {
      ...found.body.campaign,
      id: context.campaignId,
      name: 'Campaign writer fixture'
    }
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'CAMPAIGN_NOT_FOUND');
  assert.equal(missing.body.request_id, 'task5-request-0001');
});

test('PATCH campaign updates one version atomically and retains stale zero-event errors', async (t) => {
  const db = openV2Database();
  const context = createCampaignContext(db);
  const api = await startCampaignApi(db, context.userId);
  t.after(async () => {
    await api.close();
    db.close();
  });
  const body = {
    expected_version: 1,
    name: 'Campaign writer fixture updated',
    budget_minor: 123456
  };
  const successOptions = {
    body,
    idempotencyKey: 'campaign-update-task5-0001'
  };

  const updated = await api.request(
    'PATCH',
    `/api/campaigns/${context.campaignId}`,
    successOptions
  );
  const replay = await api.request(
    'PATCH',
    `/api/campaigns/${context.campaignId}`,
    successOptions
  );
  const staleOptions = {
    body: { expected_version: 1, region: 'Europe' },
    idempotencyKey: 'campaign-update-task5-stale'
  };
  const stale = await api.request(
    'PATCH',
    `/api/campaigns/${context.campaignId}`,
    staleOptions
  );
  const staleReplay = await api.request(
    'PATCH',
    `/api/campaigns/${context.campaignId}`,
    staleOptions
  );

  assert.equal(updated.status, 200);
  assert.deepEqual(replay, updated);
  assert.equal(updated.body.campaign.row_version, 2);
  assert.equal(updated.body.campaign.name, body.name);
  assert.equal(updated.body.campaign.budget_minor, body.budget_minor);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'STALE_CAMPAIGN_VERSION');
  assert.deepEqual(stale.body.details, { current_version: 2 });
  assert.deepEqual(staleReplay, stale);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM campaign_events WHERE campaign_id=?')
      .get(context.campaignId).count,
    0
  );
  assert.deepEqual(
    db.prepare(`
      SELECT idempotency_key,status_code,expected_event_count,state
      FROM request_idempotency
      WHERE scope='campaign.update'
      ORDER BY idempotency_key
    `).all(),
    [
      {
        idempotency_key: 'campaign-update-task5-0001',
        status_code: 200,
        expected_event_count: 0,
        state: 'completed'
      },
      {
        idempotency_key: 'campaign-update-task5-stale',
        status_code: 409,
        expected_event_count: 0,
        state: 'completed'
      }
    ]
  );
});

test('PATCH campaign validates the effective persisted date range before mutation', async (t) => {
  const db = openV2Database();
  const context = createCampaignContext(db);
  db.prepare(`
    UPDATE campaigns
    SET start_date='2026-08-10',end_date='2026-08-20'
    WHERE id=?
  `).run(context.campaignId);
  const api = await startCampaignApi(db, context.userId);
  t.after(async () => {
    await api.close();
    db.close();
  });

  const invalidEnd = await api.request(
    'PATCH',
    `/api/campaigns/${context.campaignId}`,
    {
      body: { expected_version: 1, end_date: '2026-08-01' },
      idempotencyKey: 'campaign-update-effective-end'
    }
  );
  const invalidStart = await api.request(
    'PATCH',
    `/api/campaigns/${context.campaignId}`,
    {
      body: { expected_version: 1, start_date: '2026-08-30' },
      idempotencyKey: 'campaign-update-effective-start'
    }
  );

  for (const response of [invalidEnd, invalidStart]) {
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'INVALID_CAMPAIGN_INPUT');
  }
  assert.deepEqual(
    db.prepare(`
      SELECT start_date,end_date,row_version
      FROM campaigns
      WHERE id=?
    `).get(context.campaignId),
    {
      start_date: '2026-08-10',
      end_date: '2026-08-20',
      row_version: 1
    }
  );

  const validPartial = await api.request(
    'PATCH',
    `/api/campaigns/${context.campaignId}`,
    {
      body: { expected_version: 1, start_date: '2026-08-15' },
      idempotencyKey: 'campaign-update-effective-valid'
    }
  );
  assert.equal(validPartial.status, 200);
  assert.equal(validPartial.body.campaign.start_date, '2026-08-15');
  assert.equal(validPartial.body.campaign.end_date, '2026-08-20');
});

test('PATCH campaign reclaims a stale processing reservation before mutation', async (t) => {
  const db = openV2Database();
  const context = createCampaignContext(db);
  const body = {
    expected_version: 1,
    region: 'Recovered region'
  };
  const idempotencyKey = 'campaign-update-stale-processing';
  const ledgerInput = campaignUpdateIdempotencyInput(
    context,
    idempotencyKey,
    body
  );
  const stale = insertStaleCampaignProcessingLedger(
    db,
    ledgerInput,
    idempotencyKey
  );
  const api = await startCampaignApi(db, context.userId);
  t.after(async () => {
    await api.close();
    db.close();
  });

  const response = await api.request(
    'PATCH',
    `/api/campaigns/${context.campaignId}`,
    { body, idempotencyKey }
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.campaign.region, body.region);
  assert.equal(response.body.campaign.row_version, 2);
  assert.deepEqual(
    db.prepare(`
      SELECT id,state,status_code,request_hash,reservation_nonce,lease_token
      FROM request_idempotency
      WHERE scope='campaign.update' AND idempotency_key=?
    `).get(idempotencyKey),
    {
      id: stale.ledgerId,
      state: 'completed',
      status_code: 200,
      request_hash: ledgerInput.requestHash,
      reservation_nonce: stale.reservationNonce,
      lease_token: null
    }
  );
});

test('PATCH campaign reclaims a retained failed reservation before mutation', async (t) => {
  const db = openV2Database();
  const context = createCampaignContext(db);
  const body = {
    expected_version: 1,
    product_name: 'Recovered product'
  };
  const idempotencyKey = 'campaign-update-failed-reclaim';
  const ledgerInput = campaignUpdateIdempotencyInput(
    context,
    idempotencyKey,
    body
  );
  const failed = insertFailedCampaignLedger(db, ledgerInput, idempotencyKey);
  const api = await startCampaignApi(db, context.userId);
  t.after(async () => {
    await api.close();
    db.close();
  });

  const response = await api.request(
    'PATCH',
    `/api/campaigns/${context.campaignId}`,
    { body, idempotencyKey }
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.campaign.product_name, body.product_name);
  assert.equal(response.body.campaign.row_version, 2);
  assert.deepEqual(
    db.prepare(`
      SELECT id,state,status_code,reservation_nonce,lease_token,
        datetime(expires_at)>CURRENT_TIMESTAMP AS retained
      FROM request_idempotency
      WHERE scope='campaign.update' AND idempotency_key=?
    `).get(idempotencyKey),
    {
      id: failed.ledgerId,
      state: 'completed',
      status_code: 200,
      reservation_nonce: failed.reservationNonce,
      lease_token: null,
      retained: 1
    }
  );
});

test('PATCH campaign terminalizes an expired work deadline without business mutation', async (t) => {
  const db = openV2Database();
  const context = createCampaignContext(db);
  const body = {
    expected_version: 1,
    region: 'Must not be written'
  };
  const idempotencyKey = 'campaign-update-deadline-expired';
  const ledgerInput = campaignUpdateIdempotencyInput(
    context,
    idempotencyKey,
    body
  );
  const expired = insertStaleCampaignProcessingLedger(
    db,
    ledgerInput,
    idempotencyKey,
    {
      createdModifier: '-10 minutes',
      leaseModifier: '-2 minutes',
      deadlineModifier: '-1 minute'
    }
  );
  const api = await startCampaignApi(db, context.userId);
  t.after(async () => {
    await api.close();
    db.close();
  });

  const response = await api.request(
    'PATCH',
    `/api/campaigns/${context.campaignId}`,
    { body, idempotencyKey }
  );

  assert.equal(response.status, 503);
  assert.deepEqual(response.body, {
    error: 'Idempotent operation deadline expired.',
    code: 'IDEMPOTENCY_EXPIRED',
    request_id: 'idempotency-recovery'
  });
  assert.deepEqual(
    db.prepare(`
      SELECT id,state,status_code,response_kind,lease_token
      FROM request_idempotency
      WHERE scope='campaign.update' AND idempotency_key=?
    `).get(idempotencyKey),
    {
      id: expired.ledgerId,
      state: 'completed',
      status_code: 503,
      response_kind: 'json',
      lease_token: null
    }
  );
  assert.deepEqual(
    db.prepare('SELECT row_version,region FROM campaigns WHERE id=?')
      .get(context.campaignId),
    { row_version: 1, region: null }
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM campaign_events').get().count,
    0
  );
});

test('PATCH campaign deletes expired JSON retention and executes the same hash anew', async (t) => {
  const db = openV2Database();
  const context = createCampaignContext(db);
  const body = {
    expected_version: 1,
    region: 'Retention replacement'
  };
  const idempotencyKey = 'campaign-update-json-retention';
  const ledgerInput = campaignUpdateIdempotencyInput(
    context,
    idempotencyKey,
    body
  );
  const expired = insertExpiredCampaignJsonLedger(
    db,
    ledgerInput,
    idempotencyKey,
    { stale_response: true }
  );
  const api = await startCampaignApi(db, context.userId);
  t.after(async () => {
    await api.close();
    db.close();
  });

  const response = await api.request(
    'PATCH',
    `/api/campaigns/${context.campaignId}`,
    { body, idempotencyKey }
  );
  const row = db.prepare(`
    SELECT id,state,status_code,request_hash,reservation_nonce
    FROM request_idempotency
    WHERE scope='campaign.update' AND idempotency_key=?
  `).get(idempotencyKey);

  assert.equal(response.status, 200);
  assert.equal(response.body.campaign.region, body.region);
  assert.equal(response.body.campaign.row_version, 2);
  assert.ok(Number.isSafeInteger(row.id) && row.id > 0);
  assert.equal(row.state, 'completed');
  assert.equal(row.status_code, 200);
  assert.equal(row.request_hash, ledgerInput.requestHash);
  assert.notEqual(row.reservation_nonce, expired.reservationNonce);
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) AS count FROM request_idempotency
      WHERE scope='campaign.update' AND idempotency_key=?
    `).get(idempotencyKey).count,
    1
  );
});

test('PATCH campaign permits changed-hash key reuse only after JSON retention expiry', async (t) => {
  const db = openV2Database();
  const context = createCampaignContext(db);
  const oldBody = {
    expected_version: 1,
    region: 'Expired request body'
  };
  const newBody = {
    expected_version: 1,
    region: 'Changed request body'
  };
  const idempotencyKey = 'campaign-update-changed-hash-expired';
  const oldInput = campaignUpdateIdempotencyInput(
    context,
    idempotencyKey,
    oldBody
  );
  const newInput = campaignUpdateIdempotencyInput(
    context,
    idempotencyKey,
    newBody
  );
  assert.notEqual(oldInput.requestHash, newInput.requestHash);
  const expired = insertExpiredCampaignJsonLedger(
    db,
    oldInput,
    idempotencyKey,
    { expired_request: true }
  );
  const api = await startCampaignApi(db, context.userId);
  t.after(async () => {
    await api.close();
    db.close();
  });

  const response = await api.request(
    'PATCH',
    `/api/campaigns/${context.campaignId}`,
    { body: newBody, idempotencyKey }
  );
  const row = db.prepare(`
    SELECT id,state,status_code,request_hash,reservation_nonce
    FROM request_idempotency
    WHERE scope='campaign.update' AND idempotency_key=?
  `).get(idempotencyKey);

  assert.equal(response.status, 200);
  assert.equal(response.body.campaign.region, newBody.region);
  assert.equal(response.body.campaign.row_version, 2);
  assert.ok(Number.isSafeInteger(row.id) && row.id > 0);
  assert.equal(row.state, 'completed');
  assert.equal(row.status_code, 200);
  assert.equal(row.request_hash, newInput.requestHash);
  assert.notEqual(row.reservation_nonce, expired.reservationNonce);
});

test('POST campaign transition writes one event and returns honest empty dispatches with guards', async (t) => {
  const db = openV2Database();
  const context = createCampaignContext(db);
  const api = await startCampaignApi(db, context.userId);
  t.after(async () => {
    await api.close();
    db.close();
  });
  const qualifiedBody = {
    expected_state: 'lead',
    expected_version: 1,
    next_state: 'qualified',
    reason: 'Lead qualified'
  };

  const qualified = await api.request(
    'POST',
    `/api/campaigns/${context.campaignId}/transitions`,
    {
      body: qualifiedBody,
      idempotencyKey: 'campaign-transition-task5-0001'
    }
  );
  const guarded = await api.request(
    'POST',
    `/api/campaigns/${context.campaignId}/transitions`,
    {
      body: {
        expected_state: 'qualified',
        expected_version: 2,
        next_state: 'demand_confirmed',
        reason: 'Demand expected'
      },
      idempotencyKey: 'campaign-transition-task5-guard'
    }
  );

  assert.equal(qualified.status, 200);
  assert.equal(qualified.body.campaign.lifecycle_state, 'qualified');
  assert.equal(qualified.body.campaign.row_version, 2);
  assert.deepEqual(qualified.body.dispatches, []);
  assert.equal(qualified.body.event.event_type, 'lifecycle_transition');
  assert.equal(qualified.body.event.previous_state, 'lead');
  assert.equal(qualified.body.event.next_state, 'qualified');
  assert.deepEqual(qualified.body.event.metadata, {
    previous_version: 1,
    next_version: 2
  });
  assert.equal(guarded.status, 409);
  assert.equal(guarded.body.code, 'CAMPAIGN_GUARD_NOT_MET');
  assert.deepEqual(guarded.body.details, { missing_relations: ['demand'] });
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM campaign_events WHERE campaign_id=?')
      .get(context.campaignId).count,
    1
  );
});

test('POST campaign operational hold and resume each commit one audited version', async (t) => {
  const db = openV2Database();
  const context = createCampaignContext(db);
  const api = await startCampaignApi(db, context.userId);
  t.after(async () => {
    await api.close();
    db.close();
  });

  const held = await api.request(
    'POST',
    `/api/campaigns/${context.campaignId}/operational-actions`,
    {
      body: {
        action: 'hold',
        expected_status: 'active',
        expected_version: 1,
        reason: 'Waiting for client'
      },
      idempotencyKey: 'campaign-operational-task5-hold'
    }
  );
  const resumed = await api.request(
    'POST',
    `/api/campaigns/${context.campaignId}/operational-actions`,
    {
      body: {
        action: 'resume',
        expected_status: 'on_hold',
        expected_version: 2,
        reason: 'Client replied'
      },
      idempotencyKey: 'campaign-operational-task5-resume'
    }
  );

  assert.equal(held.status, 200);
  assert.equal(held.body.campaign.operational_status, 'on_hold');
  assert.equal(held.body.campaign.row_version, 2);
  assert.deepEqual(held.body.event.metadata, {
    previous_status: 'active',
    next_status: 'on_hold',
    previous_version: 1,
    next_version: 2
  });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.campaign.operational_status, 'active');
  assert.equal(resumed.body.campaign.row_version, 3);
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) AS count FROM campaign_events
      WHERE campaign_id=? AND event_type='operational_status_changed'
    `).get(context.campaignId).count,
    2
  );
});

test('POST campaign cancel atomically revokes collaboration bundles and cancels nonterminal work', async (t) => {
  const db = openV2Database();
  const context = createCampaignContext(db);
  const influencer = db.prepare(`
    SELECT id FROM influencers WHERE is_active=1 ORDER BY id LIMIT 1
  `).get();
  assert.ok(influencer);
  const demandId = 940001;
  const collaborationStatuses = [
    'proposed',
    'contacted',
    'negotiating',
    'confirmed',
    'contract_sent',
    'live',
    'content_review'
  ];
  const collaborationIds = collaborationStatuses.map((_, index) => 950001 + index);
  db.prepare(`
    INSERT INTO demands (id,user_id,brand_name,status,data_json)
    VALUES (?,?,'Cancel fixture','confirmed','{}')
  `).run(demandId, context.userId);
  const insertCollaboration = db.prepare(`
    INSERT INTO collaborations (
      id,demand_id,influencer_id,user_id,status,row_version,cost_actual_confirmed
    ) VALUES (?, ?, ?, ?, ?, 1, 0)
  `);
  const insertLink = db.prepare(`
    INSERT INTO campaign_record_links (
      org_id,campaign_id,record_type,bundle_id,record_id,relation_type,
      created_by,metadata_json
    ) VALUES (?,?,'collaboration',?,?, 'order',?,'{}')
  `);
  collaborationStatuses.forEach((status, index) => {
    const collaborationId = collaborationIds[index];
    insertCollaboration.run(
      collaborationId,
      demandId,
      influencer.id,
      context.userId,
      status
    );
    insertLink.run(
      context.orgId,
      context.campaignId,
      sha256(`cancel-collaboration-bundle-${status}`),
      String(collaborationId),
      context.userId
    );
  });
  const api = await startCampaignApi(db, context.userId);
  t.after(async () => {
    await api.close();
    db.close();
  });

  const response = await api.request(
    'POST',
    `/api/campaigns/${context.campaignId}/operational-actions`,
    {
      body: {
        action: 'cancel',
        expected_status: 'active',
        expected_version: 1,
        reason: 'Campaign stopped'
      },
      idempotencyKey: 'campaign-operational-task5-cancel'
    }
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.campaign.operational_status, 'cancelled');
  assert.equal(response.body.campaign.row_version, 2);
  assert.deepEqual(
    db.prepare(`
      SELECT id,status,row_version
      FROM collaborations
      WHERE id BETWEEN ? AND ?
      ORDER BY id
    `).all(collaborationIds[0], collaborationIds.at(-1)),
    collaborationIds.map((id) => ({ id, status: 'cancelled', row_version: 2 }))
  );
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM campaign_record_links
      WHERE campaign_id=? AND record_type='collaboration'
        AND revoked_at IS NULL
    `).get(context.campaignId).count,
    0
  );
  assert.equal(response.body.event.event_type, 'operational_status_changed');
  assert.equal(response.body.event.metadata.next_status, 'cancelled');
});

test('POST campaign transfer reauthorizes a legal pair and appends one transfer event', async (t) => {
  const db = openV2Database();
  const context = createCampaignContext(db);
  const destination = db.prepare(`
    SELECT membership.team_id,membership.user_id
    FROM team_memberships membership
    JOIN organization_memberships organization_membership
      ON organization_membership.org_id=membership.org_id
     AND organization_membership.user_id=membership.user_id
     AND organization_membership.status='active'
    JOIN users user ON user.id=membership.user_id AND user.is_active=1
    WHERE membership.org_id=?
      AND membership.status='active'
      AND (membership.team_id<>? OR membership.user_id<>?)
    ORDER BY membership.team_id,membership.user_id
    LIMIT 1
  `).get(context.orgId, context.teamId, context.userId);
  assert.ok(destination);
  const api = await startCampaignApi(db, context.userId);
  t.after(async () => {
    await api.close();
    db.close();
  });

  const response = await api.request(
    'POST',
    `/api/campaigns/${context.campaignId}/transfers`,
    {
      body: {
        owner_user_id: destination.user_id,
        team_id: destination.team_id,
        expected_version: 1,
        reason: 'Move to delivery owner'
      },
      idempotencyKey: 'campaign-transfer-task5-0001'
    }
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.campaign.owner.id, destination.user_id);
  assert.equal(response.body.campaign.team.id, destination.team_id);
  assert.equal(response.body.campaign.row_version, 2);
  assert.equal(response.body.event.event_type, 'campaign_transferred');
  assert.deepEqual(response.body.event.metadata, {
    previous_owner_user_id: context.userId,
    next_owner_user_id: destination.user_id,
    previous_team_id: context.teamId,
    next_team_id: destination.team_id,
    previous_version: 1,
    next_version: 2
  });
});

test('POST campaign links attaches one visible target with one aggregate event', async (t) => {
  const db = openV2Database();
  const context = createCampaignContext(db);
  const demandId = 940101;
  db.prepare(`
    INSERT INTO demands (
      id,user_id,brand_name,product_name,status,data_json
    ) VALUES (?,?,'Attach Brand','Attach Product','confirmed','{}')
  `).run(demandId, context.userId);
  const api = await startCampaignApi(db, context.userId);
  t.after(async () => {
    await api.close();
    db.close();
  });

  const requestOptions = {
    body: {
      relation_type: 'demand',
      record_type: 'demand',
      record_id: String(demandId),
      reason: 'Attach approved demand'
    },
    idempotencyKey: 'campaign-link-attach-task5-0001'
  };
  const response = await api.request(
    'POST',
    `/api/campaigns/${context.campaignId}/links`,
    requestOptions
  );
  const replay = await api.request(
    'POST',
    `/api/campaigns/${context.campaignId}/links`,
    requestOptions
  );

  assert.equal(response.status, 201);
  assert.deepEqual(replay, response);
  assert.deepEqual(Object.keys(response.body), ['link', 'event']);
  assert.equal(response.body.link.relation_type, 'demand');
  assert.equal(response.body.link.record_type, 'demand');
  assert.equal(response.body.link.record_id, String(demandId));
  assert.equal(response.body.link.access_state, 'available');
  assert.equal(response.body.link.label, 'Attach Brand / Attach Product');
  assert.equal(
    response.body.link.route,
    `/m3?campaign=${context.campaignId}&step=demand&record=${demandId}`
  );
  assert.equal(response.body.event.event_type, 'link_attached');
  assert.deepEqual(response.body.event.metadata.relation_types, ['demand']);
  assert.deepEqual(response.body.event.metadata.link_ids, [response.body.link.link_id]);
});

test('POST link correction atomically moves one bundle with reciprocal events', async (t) => {
  const db = openV2Database();
  const context = createCampaignContext(db);
  const destination = createSiblingCampaign(db, context);
  const demandId = 940201;
  db.prepare(`
    INSERT INTO demands (id,user_id,brand_name,status,data_json)
    VALUES (?,?,'Move Brand','confirmed','{}')
  `).run(demandId, context.userId);
  const sourceBundleId = sha256('link-correction-source-bundle');
  const sourceLink = db.prepare(`
    INSERT INTO campaign_record_links (
      org_id,campaign_id,record_type,bundle_id,record_id,relation_type,
      created_by,metadata_json
    ) VALUES (?,?,'demand',?,?,'demand',?,'{}')
  `).run(
    context.orgId,
    context.campaignId,
    sourceBundleId,
    String(demandId),
    context.userId
  );
  const sourceLinkId = Number(sourceLink.lastInsertRowid);
  const api = await startCampaignApi(db, context.userId);
  t.after(async () => {
    await api.close();
    db.close();
  });

  const correctionOptions = {
    body: {
      link_id: sourceLinkId,
      target_campaign_id: destination.campaignId,
      reason: 'Move demand evidence'
    },
    idempotencyKey: 'campaign-link-correct-task5-0001'
  };
  const response = await api.request(
    'POST',
    `/api/campaigns/${context.campaignId}/link-corrections`,
    correctionOptions
  );
  const replay = await api.request(
    'POST',
    `/api/campaigns/${context.campaignId}/link-corrections`,
    correctionOptions
  );

  assert.equal(response.status, 200);
  assert.deepEqual(replay, response);
  assert.equal(response.body.revoked_links.length, 1);
  assert.equal(response.body.replacement_links.length, 1);
  assert.equal(response.body.source_event.event_type, 'link_moved');
  assert.equal(response.body.destination_event.event_type, 'link_moved');
  assert.deepEqual(
    response.body.source_event.metadata,
    response.body.destination_event.metadata
  );
  assert.equal(response.body.source_event.metadata.source_campaign_id, context.campaignId);
  assert.equal(
    response.body.source_event.metadata.destination_campaign_id,
    destination.campaignId
  );
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) AS count FROM campaign_record_links
      WHERE campaign_id=? AND record_id=? AND revoked_at IS NULL
    `).get(context.campaignId, String(demandId)).count,
    0
  );
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) AS count FROM campaign_record_links
      WHERE campaign_id=? AND record_id=? AND revoked_at IS NULL
    `).get(destination.campaignId, String(demandId)).count,
    1
  );
  assert.deepEqual(
    db.prepare(`
      SELECT campaign_id,secondary_campaign_id,expected_event_count,state
      FROM request_idempotency
      WHERE scope='campaign.link.correct' AND idempotency_key=?
    `).get('campaign-link-correct-task5-0001'),
    {
      campaign_id: context.campaignId,
      secondary_campaign_id: destination.campaignId,
      expected_event_count: 2,
      state: 'completed'
    }
  );
});

test('knowledge custody move enforces the destination campaign capacity at exact limit', async (t) => {
  const db = openV4Database();
  const source = createCampaignContext(db);
  const destination = createSiblingCampaign(db, source);
  let exactEntry;
  let overflowEntry;
  let exactSourceLinkId;
  let overflowSourceLinkId;
  db.transaction(() => {
    exactEntry = knowledge.writeCampaignKnowledgeInTransaction(
      db,
      writerOptions(source, 531, {
        title: 'Exact-limit move entry',
        visibility: 'team'
      })
    );
    overflowEntry = knowledge.writeCampaignKnowledgeInTransaction(
      db,
      writerOptions(source, 532, {
        title: 'Overflow move entry',
        visibility: 'team'
      })
    );
    exactSourceLinkId = linkKnowledgeEntry(
      db,
      source,
      exactEntry.entry.id,
      'knowledge-capacity-exact-source'
    );
    overflowSourceLinkId = linkKnowledgeEntry(
      db,
      source,
      overflowEntry.entry.id,
      'knowledge-capacity-overflow-source'
    );
    bulkFillCampaignCustodyEntries(
      db,
      source,
      destination.campaignId,
      CAMPAIGN_ENTRY_LIMIT - 1
    );
  }).immediate();
  const api = await startCampaignApi(db, source.userId);
  t.after(async () => {
    await api.close();
    db.close();
  });

  const exact = await api.request(
    'POST',
    `/api/campaigns/${source.campaignId}/link-corrections`,
    {
      body: {
        link_id: exactSourceLinkId,
        target_campaign_id: destination.campaignId,
        reason: 'Move at the exact destination limit'
      },
      idempotencyKey: 'campaign-knowledge-capacity-exact'
    }
  );
  assert.equal(exact.status, 200);
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM campaign_record_links
      WHERE campaign_id=? AND record_type='knowledge_entry'
        AND relation_type='knowledge' AND revoked_at IS NULL
    `).get(destination.campaignId).count,
    CAMPAIGN_ENTRY_LIMIT
  );

  const beforeOverflow = {
    links: db.prepare(`
      SELECT id,campaign_id,bundle_id,revoked_at,revoked_by,revoke_reason
      FROM campaign_record_links
      WHERE record_type='knowledge_entry' AND record_id=?
      ORDER BY id
    `).all(String(overflowEntry.entry.id)),
    events: db.prepare(
      'SELECT COUNT(*) AS count FROM campaign_events'
    ).get().count,
    ledgers: db.prepare(
      'SELECT COUNT(*) AS count FROM request_idempotency'
    ).get().count
  };
  const overflowKey = 'campaign-knowledge-capacity-overflow';
  const overflow = await api.request(
    'POST',
    `/api/campaigns/${source.campaignId}/link-corrections`,
    {
      body: {
        link_id: overflowSourceLinkId,
        target_campaign_id: destination.campaignId,
        reason: 'Reject the destination overflow'
      },
      idempotencyKey: overflowKey
    }
  );

  assert.equal(overflow.status, 507);
  assert.equal(overflow.body.code, 'KNOWLEDGE_STORAGE_CAPACITY_EXCEEDED');
  assert.deepEqual(overflow.body.details, {
    scope: 'campaign',
    metric: 'entries',
    limit: CAMPAIGN_ENTRY_LIMIT,
    projected: CAMPAIGN_ENTRY_LIMIT + 1
  });
  assert.deepEqual(
    db.prepare(`
      SELECT id,campaign_id,bundle_id,revoked_at,revoked_by,revoke_reason
      FROM campaign_record_links
      WHERE record_type='knowledge_entry' AND record_id=?
      ORDER BY id
    `).all(String(overflowEntry.entry.id)),
    beforeOverflow.links
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM campaign_events').get().count,
    beforeOverflow.events
  );
  assert.deepEqual(
    db.prepare(`
      SELECT state,status_code,expected_event_count,
        (
          SELECT COUNT(*)
          FROM campaign_events event
          WHERE event.audit_fingerprint=ledger.audit_fingerprint
        ) AS event_count
      FROM request_idempotency ledger
      WHERE scope='campaign.link.correct' AND idempotency_key=?
    `).get(overflowKey),
    {
      state: 'completed',
      status_code: 507,
      expected_event_count: 2,
      event_count: 0
    }
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM request_idempotency').get().count,
    beforeOverflow.ledgers + 1
  );
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM campaign_record_links
      WHERE campaign_id=? AND record_type='knowledge_entry' AND record_id=?
        AND revoked_at IS NULL
    `).get(destination.campaignId, String(overflowEntry.entry.id)).count,
    0
  );
});

test('GET campaign link candidates excludes historically classified targets before count', async (t) => {
  const db = openV2Database();
  const context = createCampaignContext(db);
  const sibling = createSiblingCampaign(db, context);
  const availableDemandId = 940301;
  const historicalDemandId = 940302;
  db.prepare(`
    INSERT INTO demands (id,user_id,brand_name,product_name,status,data_json)
    VALUES
      (?,?,?,'Available Product','confirmed','{}'),
      (?,?,?,'Historical Product','confirmed','{}')
  `).run(
    availableDemandId,
    context.userId,
    'Available Brand',
    historicalDemandId,
    context.userId,
    'Historical Brand'
  );
  db.prepare(`
    INSERT INTO campaign_record_links (
      org_id,campaign_id,record_type,bundle_id,record_id,relation_type,
      created_by,metadata_json
    ) VALUES (?,?,'demand',?,?,'demand',?,'{}')
  `).run(
    context.orgId,
    sibling.campaignId,
    sha256('link-candidate-history-bundle'),
    String(historicalDemandId),
    context.userId
  );
  db.prepare(`
    UPDATE campaign_record_links
    SET revoked_at=CURRENT_TIMESTAMP,revoked_by=?,revoke_reason='Corrected'
    WHERE campaign_id=? AND record_id=?
  `).run(context.userId, sibling.campaignId, String(historicalDemandId));
  const api = await startCampaignApi(db, context.userId);
  t.after(async () => {
    await api.close();
    db.close();
  });

  const response = await api.request(
    'GET',
    `/api/campaigns/${context.campaignId}/link-candidates?relation_type=demand&q=Product&limit=1&offset=0`
  );

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    items: [{
      record_type: 'demand',
      record_id: String(availableDemandId),
      label: 'Available Brand / Available Product'
    }],
    total: 1,
    limit: 1,
    offset: 0
  });
});

test('campaign link candidates bound authorization and pagination SQL work at volume', () => {
  const db = openV2Database();
  try {
    const context = createCampaignContext(db);
    const count = 1000;
    const demandBase = db.prepare(
      'SELECT COALESCE(MAX(id),0) AS value FROM demands'
    ).get().value;
    db.prepare(`
      WITH RECURSIVE fixture_rows(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1
        FROM fixture_rows
        WHERE value < @count
      )
      INSERT INTO demands (
        id,user_id,brand_name,product_name,status,data_json
      )
      SELECT
        @demandBase + value,
        @userId,
        'Candidate Volume Brand ' || value,
        CASE
          WHEN value=777 THEN 'Needle candidate product 777'
          ELSE 'Candidate Volume Product ' || value
        END,
        'confirmed',
        '{}'
      FROM fixture_rows
    `).run({
      count,
      demandBase,
      userId: context.userId
    });
    const measured = instrumentReadDatabase(db);
    const service = createCampaignService(measured.db);

    const result = service.listCampaignLinkCandidates({
      userId: context.userId,
      campaignId: context.campaignId,
      query: {
        relation_type: 'demand',
        q: 'Needle candidate product 777',
        limit: '1',
        offset: '0'
      }
    });

    assert.equal(result.total, 1);
    assert.deepEqual(result.items, [{
      record_type: 'demand',
      record_id: String(demandBase + 777),
      label: 'Candidate Volume Brand 777 / Needle candidate product 777'
    }]);
    assert.ok(
      measured.stats.statements <= 12,
      `expected at most 12 statements, got ${measured.stats.statements}`
    );
    assert.ok(
      measured.stats.rows <= 25,
      `expected at most 25 materialized rows, got ${measured.stats.rows}`
    );
  } finally {
    db.close();
  }
});

test('GET campaign workspace returns exact grouped links events and empty deferred dispatches', async (t) => {
  const db = openV2Database();
  const context = createCampaignContext(db);
  const demandId = 940401;
  const collaborationId = 950401;
  const influencerHandle = '@workspace-route-candidate-940401';
  const influencerId = Number(db.prepare(`
    INSERT INTO influencers (platform,kol_handle,is_active)
    VALUES ('YouTube',?,1)
  `).run(influencerHandle).lastInsertRowid);
  db.prepare(`
    INSERT INTO demands (id,user_id,brand_name,product_name,status,data_json)
    VALUES (?,?,'Workspace Brand','Workspace Product','confirmed','{}')
  `).run(demandId, context.userId);
  db.prepare(`
    INSERT INTO collaborations (
      id,demand_id,influencer_id,user_id,status,row_version,cost_actual_confirmed
    ) VALUES (?, ?, ?, ?, 'confirmed', 1, 0)
  `).run(collaborationId, demandId, influencerId, context.userId);
  const insertLink = db.prepare(`
    INSERT INTO campaign_record_links (
      org_id,campaign_id,record_type,bundle_id,record_id,relation_type,
      created_by,metadata_json
    ) VALUES (?,?,?,?,?,?,?,'{}')
  `);
  insertLink.run(
    context.orgId,
    context.campaignId,
    'influencer',
    sha256('workspace-shortlist-bundle'),
    String(influencerId),
    'shortlist',
    context.userId
  );
  insertLink.run(
    context.orgId,
    context.campaignId,
    'collaboration',
    sha256('workspace-order-bundle'),
    String(collaborationId),
    'order',
    context.userId
  );
  const api = await startCampaignApi(db, context.userId);
  t.after(async () => {
    await api.close();
    db.close();
  });
  const attached = await api.request(
    'POST',
    `/api/campaigns/${context.campaignId}/links`,
    {
      body: {
        relation_type: 'demand',
        record_type: 'demand',
        record_id: String(demandId),
        metadata: {},
        reason: 'Workspace evidence'
      },
      idempotencyKey: 'campaign-workspace-link-task5-0001'
    }
  );
  assert.equal(attached.status, 201);

  const candidates = await api.request(
    'GET',
    `/api/campaigns/${context.campaignId}/link-candidates` +
      `?relation_type=shortlist&q=${encodeURIComponent(influencerHandle)}`
  );
  assert.equal(candidates.status, 200, JSON.stringify(candidates.body));
  assert.deepEqual(candidates.body.items, [{
    record_type: 'influencer',
    record_id: String(influencerId),
    label: influencerHandle
  }]);

  const response = await api.request(
    'GET',
    `/api/campaigns/${context.campaignId}/workspace`
  );

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(Object.keys(response.body), [
    'campaign',
    'active_links',
    'link_history',
    'events',
    'workflow_dispatches',
    'pagination'
  ]);
  assert.deepEqual(Object.keys(response.body.active_links), [
    'demand',
    'proposal',
    'ppt',
    'shortlist',
    'order',
    'execution',
    'publication',
    'settlement',
    'workflow',
    'ai_run',
    'knowledge',
    'review'
  ]);
  assert.deepEqual(response.body.active_links.demand, [attached.body.link]);
  assert.equal(
    response.body.active_links.shortlist[0].route,
    `/m4?campaign=${context.campaignId}&tab=tab1&record=${influencerId}`
  );
  assert.equal(
    response.body.active_links.order[0].route,
    `/m4?campaign=${context.campaignId}&tab=tab2&record=${collaborationId}`
  );
  for (const relation of Object.keys(response.body.active_links).filter(
    (name) => !['demand', 'shortlist', 'order'].includes(name)
  )) {
    assert.deepEqual(response.body.active_links[relation], []);
  }
  assert.deepEqual(response.body.link_history, []);
  assert.deepEqual(response.body.events, [attached.body.event]);
  assert.deepEqual(response.body.workflow_dispatches, []);
  assert.deepEqual(response.body.pagination, {
    active_links: { total: 3, limit: 50, offset: 0 },
    link_history: { total: 0, limit: 50, offset: 0 },
    events: { total: 1, limit: 50, offset: 0 }
  });
});

test('campaign workspace bounds link and event materialization at volume', () => {
  const db = openV2Database();
  try {
    const context = createCampaignContext(db);
    const count = 250;
    const influencerBase = 960000;
    const linkBase = 970000;
    const eventBase = 980000;
    const requestBase = 990000;
    db.prepare(`
      WITH RECURSIVE fixture_rows(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1
        FROM fixture_rows
        WHERE value < @count
      )
      INSERT INTO influencers (id,platform,kol_handle,is_active)
      SELECT
        @influencerBase + value,
        'YouTube',
        '@workspace-volume-' || value,
        1
      FROM fixture_rows
    `).run({ count, influencerBase });
    db.prepare(`
      WITH RECURSIVE fixture_rows(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1
        FROM fixture_rows
        WHERE value < @count
      )
      INSERT INTO campaign_record_links (
        id,org_id,campaign_id,record_type,bundle_id,record_id,relation_type,
        created_by,metadata_json
      )
      SELECT
        @linkBase + value,
        @orgId,
        @campaignId,
        'influencer',
        printf('%064x', @linkBase + value),
        printf('%d', @influencerBase + value),
        'shortlist',
        @userId,
        '{}'
      FROM fixture_rows
    `).run({
      count,
      linkBase,
      influencerBase,
      orgId: context.orgId,
      campaignId: context.campaignId,
      userId: context.userId
    });
    db.prepare(`
      WITH RECURSIVE fixture_rows(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1
        FROM fixture_rows
        WHERE value < @count
      )
      INSERT INTO request_idempotency (
        id,org_id,user_id,campaign_id,scope,idempotency_key,
        reservation_nonce,request_hash,audit_fingerprint,
        expected_event_count,state,lease_until,lease_token,operation_deadline
      )
      SELECT
        @requestBase + value,
        @orgId,
        @userId,
        @campaignId,
        'campaign.transition',
        'workspace-volume-' || value,
        printf('%064x', @requestBase + 1000000 + value),
        printf('%064x', @requestBase + 2000000 + value),
        printf('%064x', @eventBase + value),
        1,
        'processing',
        datetime('now','+1 hour'),
        'workspace-volume-lease-' || value,
        datetime('now','+2 hours')
      FROM fixture_rows
    `).run({
      count,
      requestBase,
      eventBase,
      orgId: context.orgId,
      campaignId: context.campaignId,
      userId: context.userId
    });
    db.prepare(`
      WITH RECURSIVE fixture_rows(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1
        FROM fixture_rows
        WHERE value < @count
      )
      INSERT INTO campaign_events (
        id,org_id,campaign_id,event_type,previous_state,next_state,
        actor_user_id,reason,source,metadata_json,correlation_id,
        audit_fingerprint
      )
      SELECT
        @eventBase + value,
        @orgId,
        @campaignId,
        'lifecycle_transition',
        'lead',
        'qualified',
        @userId,
        'Workspace volume event ' || value,
        'project_workspace',
        json_object('previous_version', value, 'next_version', value + 1),
        'workspace-volume-' || value,
        printf('%064x', @eventBase + value)
      FROM fixture_rows
    `).run({
      count,
      eventBase,
      orgId: context.orgId,
      campaignId: context.campaignId,
      userId: context.userId
    });
    const measured = instrumentReadDatabase(db);
    const service = createCampaignService(measured.db);

    const result = service.getCampaignWorkspace({
      userId: context.userId,
      campaignId: context.campaignId,
      query: {
        active_limit: '7',
        active_offset: '5',
        history_limit: '3',
        history_offset: '0',
        event_limit: '9',
        event_offset: '10'
      }
    });

    assert.equal(result.active_links.shortlist.length, 7);
    assert.equal(result.events.length, 9);
    assert.deepEqual(result.pagination, {
      active_links: { total: count, limit: 7, offset: 5 },
      link_history: { total: 0, limit: 3, offset: 0 },
      events: { total: count, limit: 9, offset: 10 }
    });
    assert.ok(
      measured.stats.statements <= 30,
      `expected at most 30 statements, got ${measured.stats.statements}`
    );
    assert.ok(
      measured.stats.rows <= 180,
      `expected at most 180 materialized rows, got ${measured.stats.rows}`
    );
  } finally {
    db.close();
  }
});

test('GET campaign knowledge lists the authorized linked and truly unclassified union', async (t) => {
  const db = openV2Database();
  const context = createCampaignContext(db);
  let linked;
  let available;
  db.transaction(() => {
    linked = knowledge.writeCampaignKnowledgeInTransaction(
      db,
      writerOptions(context, 501, {
        title: 'Linked campaign insight',
        summary: 'Linked campaign summary',
        tags: ['campaign', 'linked'],
        visibility: 'team'
      })
    );
    available = knowledge.writeCampaignKnowledgeInTransaction(
      db,
      writerOptions(context, 502, {
        title: 'Available campaign insight',
        summary: 'Available campaign summary',
        tags: ['available', 'campaign'],
        visibility: 'team'
      })
    );
    linkKnowledgeEntry(
      db,
      context,
      linked.entry.id,
      'campaign-knowledge-list-linked'
    );
  }).immediate();
  const api = await startCampaignApi(db, context.userId);
  t.after(async () => {
    await api.close();
    db.close();
  });

  const response = await api.request(
    'GET',
    `/api/campaigns/${context.campaignId}/knowledge?q=campaign&linked=all&limit=10&offset=0`
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.total, 2);
  assert.equal(response.body.limit, 10);
  assert.equal(response.body.offset, 0);
  assert.deepEqual(
    response.body.items.map((item) => item.id).sort((a, b) => a - b),
    [linked.entry.id, available.entry.id].sort((a, b) => a - b)
  );
  const linkedItem = response.body.items.find(
    (item) => item.id === linked.entry.id
  );
  const availableItem = response.body.items.find(
    (item) => item.id === available.entry.id
  );
  assert.deepEqual(Object.keys(linkedItem), [
    'id',
    'title',
    'summary',
    'tags',
    'entry_type',
    'source_type',
    'visibility',
    'usage_count',
    'citation_count',
    'updated_at',
    'link_state'
  ]);
  assert.equal(linkedItem.link_state, 'linked');
  assert.equal(availableItem.link_state, 'available');
  assert.equal(linkedItem.citation_count, 0);
});

test('campaign knowledge list bounds authorization count and pagination SQL work at volume', () => {
  const db = openV2Database();
  try {
    const context = createCampaignContext(db);
    bulkFillUserEntries(db, context.userId, 1000);
    const measured = instrumentReadDatabase(db);
    const service = createCampaignService(measured.db);

    const result = service.listCampaignKnowledge({
      userId: context.userId,
      campaignId: context.campaignId,
      query: {
        linked: 'false',
        limit: '1',
        offset: '0'
      }
    });

    assert.equal(result.total, 1000);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].link_state, 'available');
    assert.ok(
      measured.stats.statements <= 12,
      `expected at most 12 statements, got ${measured.stats.statements}`
    );
    assert.ok(
      measured.stats.rows <= 25,
      `expected at most 25 materialized rows, got ${measured.stats.rows}`
    );
  } finally {
    db.close();
  }
});

test('GET campaign knowledge detail returns bounded source capabilities and conceals other custody', async (t) => {
  const db = openV2Database();
  const context = createCampaignContext(db);
  const sibling = createSiblingCampaign(db, context);
  let current;
  let other;
  db.transaction(() => {
    current = knowledge.writeCampaignKnowledgeInTransaction(
      db,
      writerOptions(context, 511, {
        sourceType: 'demand',
        title: 'Detailed campaign insight',
        summary: 'Detailed campaign summary',
        content: 'Detailed campaign content',
        tags: ['campaign', 'detail'],
        visibility: 'team'
      })
    );
    linkKnowledgeEntry(
      db,
      context,
      current.entry.id,
      'campaign-knowledge-detail-current'
    );
    other = knowledge.writeCampaignKnowledgeInTransaction(
      db,
      writerOptions(sibling, 512, {
        sourceType: 'demand',
        title: 'Other custody insight',
        visibility: 'team'
      })
    );
    linkKnowledgeEntry(
      db,
      sibling,
      other.entry.id,
      'campaign-knowledge-detail-other'
    );
  }).immediate();
  const api = await startCampaignApi(db, context.userId);
  t.after(async () => {
    await api.close();
    db.close();
  });

  const response = await api.request(
    'GET',
    `/api/campaigns/${context.campaignId}/knowledge/${current.entry.id}`
  );
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body), [
    'entry',
    'usage_count',
    'citation_count',
    'can_manage',
    'can_use_in_ai'
  ]);
  assert.deepEqual(response.body.entry.source, {
    kind: 'demand',
    label: 'Demand'
  });
  assert.equal(response.body.entry.content, 'Detailed campaign content');
  assert.equal(response.body.entry.link_state, 'linked');
  assert.equal(response.body.can_manage, true);
  assert.equal(response.body.can_use_in_ai, true);
  assert.equal(Object.hasOwn(response.body.entry, 'source_id'), false);

  const concealed = await api.request(
    'GET',
    `/api/campaigns/${context.campaignId}/knowledge/${other.entry.id}`
  );
  assert.equal(concealed.status, 404);
  assert.equal(concealed.body.code, 'KNOWLEDGE_ENTRY_NOT_FOUND');
});

test('campaign knowledge list and detail conceal rejected and expired governance states', () => {
  const db = openV7Database();
  try {
    const context = createCampaignContext(db);
    const admin = db.prepare(`
      SELECT id,role FROM users WHERE role='admin' AND is_active=1 ORDER BY id LIMIT 1
    `).get();
    assert.ok(admin);
    let active;
    let rejected;
    let expired;
    let unlinkedRejected;
    db.transaction(() => {
      active = knowledge.writeCampaignKnowledgeInTransaction(
        db,
        writerOptions(context, 541, { title: 'Active governance knowledge' })
      );
      rejected = knowledge.writeCampaignKnowledgeInTransaction(
        db,
        writerOptions(context, 542, { title: 'Rejected governance knowledge' })
      );
      expired = knowledge.writeCampaignKnowledgeInTransaction(
        db,
        writerOptions(context, 543, { title: 'Expired governance knowledge' })
      );
      unlinkedRejected = knowledge.writeCampaignKnowledgeInTransaction(
        db,
        writerOptions(context, 544, { title: 'Unlinked rejected governance knowledge' })
      );
      linkKnowledgeEntry(
        db,
        context,
        rejected.entry.id,
        'campaign-governance-rejected-use'
      );
    }).immediate();
    knowledge.governKnowledgeEntry(db, {
      user: admin,
      entryId: rejected.entry.id,
      action: 'reject',
      expectedVersion: 1,
      reason: 'Campaign governance rejection contract'
    });
    knowledge.governKnowledgeEntry(db, {
      user: admin,
      entryId: expired.entry.id,
      action: 'set_retention',
      expectedVersion: 1,
      retentionClass: 'scheduled',
      retainUntil: '2000-01-01 00:00:00',
      reason: 'Campaign governance expiration contract'
    });
    knowledge.governKnowledgeEntry(db, {
      user: admin,
      entryId: unlinkedRejected.entry.id,
      action: 'reject',
      expectedVersion: 1,
      reason: 'Campaign candidate governance rejection contract'
    });

    const service = createCampaignService(db);
    const candidates = service.listCampaignLinkCandidates({
      userId: context.userId,
      campaignId: context.campaignId,
      query: {
        relation_type: 'knowledge',
        q: 'governance knowledge',
        limit: '20',
        offset: '0'
      }
    });
    assert.deepEqual(candidates.items.map((item) => item.record_id), [String(active.entry.id)]);
    assert.equal(candidates.total, 1);
    const listed = service.listCampaignKnowledge({
      userId: context.userId,
      campaignId: context.campaignId,
      query: { linked: 'all', limit: '20', offset: '0' }
    });
    assert.deepEqual(listed.items.map((entry) => entry.id), [active.entry.id]);
    assert.equal(listed.total, 1);
    const detail = service.getCampaignKnowledgeDetail({
      userId: context.userId,
      campaignId: context.campaignId,
      entryId: active.entry.id,
      query: {}
    });
    assert.equal(detail.can_use_in_ai, true);
    for (const entryId of [rejected.entry.id, expired.entry.id]) {
      assert.throws(
        () => service.getCampaignKnowledgeDetail({
          userId: context.userId,
          campaignId: context.campaignId,
          entryId,
          query: {}
        }),
        (error) => error && error.statusCode === 404 && error.code === 'KNOWLEDGE_ENTRY_NOT_FOUND'
      );
    }
    assert.throws(
      () => createCampaignLinkService(db).useKnowledge({
        userId: context.userId,
        requestId: 'campaign-governance-rejected-use-request',
        idempotencyKey: 'campaign-governance-rejected-use-key',
        entryId: rejected.entry.id
      }),
      (error) => error && error.statusCode === 409 && error.code === 'KNOWLEDGE_GOVERNANCE_INACTIVE'
    );
    assert.equal(
      db.prepare('SELECT usage_count FROM knowledge_entries WHERE id=?')
        .get(rejected.entry.id).usage_count,
      0
    );
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM request_idempotency
      WHERE idempotency_key='campaign-governance-rejected-use-key'
    `).get().count, 0);
    assert.throws(
      () => service.attachCampaignLink({
        userId: context.userId,
        campaignId: context.campaignId,
        requestId: 'campaign-governance-rejected-attach-request',
        idempotencyKey: 'campaign-governance-rejected-attach-key',
        body: {
          relation_type: 'knowledge',
          record_type: 'knowledge_entry',
          record_id: String(unlinkedRejected.entry.id),
          reason: 'Rejected governance attach must fail'
        }
      }),
      (error) => error && error.statusCode === 409 && error.code === 'KNOWLEDGE_GOVERNANCE_INACTIVE'
    );
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM campaign_record_links
      WHERE record_type='knowledge_entry' AND record_id=?
    `).get(String(unlinkedRejected.entry.id)).count, 0);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM request_idempotency
      WHERE idempotency_key='campaign-governance-rejected-attach-key'
    `).get().count, 0);
  } finally {
    db.close();
  }
});

test('campaign knowledge reads follow moved and revoke-only custody without leaking to unauthorized callers', async (t) => {
  const db = openV2Database();
  const source = createCampaignContext(db);
  const destination = createSiblingCampaign(db, source);
  let moved;
  let revoked;
  db.transaction(() => {
    moved = knowledge.writeCampaignKnowledgeInTransaction(
      db,
      writerOptions(source, 521, {
        title: 'Moved custody knowledge',
        visibility: 'team'
      })
    );
    const movedSourceLink = linkKnowledgeEntry(
      db,
      source,
      moved.entry.id,
      'knowledge-moved-source'
    );
    revokeKnowledgeLink(db, movedSourceLink, source.userId);
    linkKnowledgeEntry(
      db,
      destination,
      moved.entry.id,
      'knowledge-moved-destination'
    );

    revoked = knowledge.writeCampaignKnowledgeInTransaction(
      db,
      writerOptions(source, 522, {
        title: 'Revoke-only custody knowledge',
        visibility: 'team'
      })
    );
    const revokedLink = linkKnowledgeEntry(
      db,
      source,
      revoked.entry.id,
      'knowledge-revoke-only-source'
    );
    revokeKnowledgeLink(db, revokedLink, source.userId);
  }).immediate();
  const unauthorized = db.prepare(`
    SELECT membership.user_id
    FROM organization_memberships membership
    JOIN users user ON user.id=membership.user_id AND user.is_active=1
    WHERE membership.org_id=?
      AND membership.status='active'
      AND membership.role_code='member'
      AND NOT EXISTS (
        SELECT 1
        FROM team_memberships campaign_team
        WHERE campaign_team.org_id=membership.org_id
          AND campaign_team.team_id=?
          AND campaign_team.user_id=membership.user_id
          AND campaign_team.status='active'
      )
      AND EXISTS (
        SELECT 1
        FROM team_memberships other_team
        WHERE other_team.org_id=membership.org_id
          AND other_team.user_id=membership.user_id
          AND other_team.status='active'
      )
    ORDER BY membership.user_id
    LIMIT 1
  `).get(source.orgId, source.teamId);
  assert.ok(unauthorized);
  const authorizedApi = await startCampaignApi(db, source.userId);
  const unauthorizedApi = await startCampaignApi(db, unauthorized.user_id);
  t.after(async () => {
    await unauthorizedApi.close();
    await authorizedApi.close();
    db.close();
  });

  const movedDestinationList = await authorizedApi.request(
    'GET',
    `/api/campaigns/${destination.campaignId}/knowledge?linked=true&limit=20&offset=0`
  );
  const movedDestinationDetail = await authorizedApi.request(
    'GET',
    `/api/campaigns/${destination.campaignId}/knowledge/${moved.entry.id}`
  );
  const movedSourceDetail = await authorizedApi.request(
    'GET',
    `/api/campaigns/${source.campaignId}/knowledge/${moved.entry.id}`
  );
  const revokedSourceList = await authorizedApi.request(
    'GET',
    `/api/campaigns/${source.campaignId}/knowledge?linked=true&limit=20&offset=0`
  );
  const revokedSourceDetail = await authorizedApi.request(
    'GET',
    `/api/campaigns/${source.campaignId}/knowledge/${revoked.entry.id}`
  );
  const revokedDestinationDetail = await authorizedApi.request(
    'GET',
    `/api/campaigns/${destination.campaignId}/knowledge/${revoked.entry.id}`
  );
  const unauthorizedList = await unauthorizedApi.request(
    'GET',
    `/api/campaigns/${source.campaignId}/knowledge?linked=all&limit=20&offset=0`
  );
  const unauthorizedDetail = await unauthorizedApi.request(
    'GET',
    `/api/campaigns/${destination.campaignId}/knowledge/${moved.entry.id}`
  );

  assert.equal(movedDestinationList.status, 200);
  assert.deepEqual(
    movedDestinationList.body.items.map((item) => item.id),
    [moved.entry.id]
  );
  assert.equal(movedDestinationList.body.items[0].link_state, 'linked');
  assert.equal(movedDestinationDetail.status, 200);
  assert.equal(movedDestinationDetail.body.entry.link_state, 'linked');
  assert.equal(movedSourceDetail.status, 404);
  assert.equal(movedSourceDetail.body.code, 'KNOWLEDGE_ENTRY_NOT_FOUND');
  assert.equal(revokedSourceList.status, 200);
  assert.ok(
    revokedSourceList.body.items.some((item) => (
      item.id === revoked.entry.id && item.link_state === 'linked'
    ))
  );
  assert.equal(revokedSourceDetail.status, 200);
  assert.equal(revokedSourceDetail.body.entry.link_state, 'linked');
  assert.equal(revokedDestinationDetail.status, 404);
  assert.equal(revokedDestinationDetail.body.code, 'KNOWLEDGE_ENTRY_NOT_FOUND');
  assert.equal(unauthorizedList.status, 403);
  assert.equal(unauthorizedList.body.code, 'CAMPAIGN_FORBIDDEN');
  assert.equal(unauthorizedDetail.status, 403);
  assert.equal(unauthorizedDetail.body.code, 'CAMPAIGN_FORBIDDEN');
});

test('POST settled campaign review atomically writes knowledge pair event version and replay', async (t) => {
  const db = openV2Database();
  const context = createCampaignContext(db);
  const settledEventId = settleCampaignFixture(db, context);
  const api = await startCampaignApi(db, context.userId);
  t.after(async () => {
    await api.close();
    db.close();
  });
  const options = {
    body: {
      expected_version: 12,
      title: 'Campaign review',
      summary: 'Review summary',
      content: 'Review content and recommendations',
      tags: ['creator', 'summer'],
      visibility: 'team',
      reason: 'Review approved'
    },
    idempotencyKey: 'campaign-review-task5-0001'
  };

  const created = await api.request(
    'POST',
    `/api/campaigns/${context.campaignId}/reviews`,
    options
  );
  const replay = await api.request(
    'POST',
    `/api/campaigns/${context.campaignId}/reviews`,
    options
  );

  assert.equal(created.status, 201);
  assert.deepEqual(replay, created);
  assert.equal(created.body.campaign.row_version, 13);
  assert.deepEqual(
    created.body.links.map((link) => link.relation_type),
    ['knowledge', 'review']
  );
  assert.equal(created.body.event.event_type, 'link_attached');
  assert.equal(created.body.event.source, 'campaign_review');
  assert.deepEqual(created.body.event.metadata.relation_types, [
    'knowledge',
    'review'
  ]);
  assert.deepEqual(
    db.prepare(`
      SELECT entry_type,source_type,source_id,business_type,business_id
      FROM knowledge_entries WHERE id=?
    `).get(created.body.entry.id),
    {
      entry_type: 'campaign_review',
      source_type: 'campaign_review',
      source_id: `${context.campaignId}:${settledEventId}`,
      business_type: 'campaign',
      business_id: String(context.campaignId)
    }
  );
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) AS count FROM campaign_record_links
      WHERE campaign_id=? AND record_id=? AND revoked_at IS NULL
        AND relation_type IN ('knowledge','review')
    `).get(context.campaignId, String(created.body.entry.id)).count,
    2
  );
  assert.deepEqual(
    db.prepare(`
      SELECT expected_event_count,state,status_code
      FROM request_idempotency
      WHERE scope='campaign.review.create' AND idempotency_key=?
    `).get(options.idempotencyKey),
    { expected_event_count: 1, state: 'completed', status_code: 201 }
  );
});

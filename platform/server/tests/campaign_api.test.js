const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const knowledge = require('../services/knowledge_service');

const SERVER_ROOT = path.resolve(__dirname, '..');
const USER_ENTRY_LIMIT = 50000;
const LINKED_CUSTODY_VOLUME = 2000;
const UNLINKED_MEMBER_VOLUME = 1000;
const LOOSE_VOLUME_RUNTIME_LIMIT_MS = 30000;
const CAMPAIGN_MIGRATION_DESCRIPTOR = Object.freeze({
  version: 2,
  name: '002_campaign_business_spine',
  sourcePath: 'migrations/002_campaign_business_spine.js',
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

test('campaign knowledge capacity preflight uses set-based custody and organization attribution at volume', (t) => {
  const capacitySql = [];
  let captureCapacitySql = false;
  const db = openV2Database({
    verbose(sql) {
      if (
        captureCapacitySql &&
        sql.includes('knowledge_custody') &&
        sql.includes('capacity_entries AS')
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
    assert.equal(capacitySql.length, 2);
    const campaignSql = capacitySql.find(
      (sql) => (
        sql.includes('JOIN knowledge_custody custody') &&
        !sql.includes('LEFT JOIN knowledge_custody custody')
      )
    );
    const organizationSql = capacitySql.find(
      (sql) => sql.includes('LEFT JOIN knowledge_custody custody')
    );
    assert.ok(campaignSql);
    assert.ok(organizationSql);
    const campaignUsage = db.prepare(campaignSql).get();
    assert.equal(campaignUsage.entries, LINKED_CUSTODY_VOLUME);
    assert.equal(campaignUsage.chunks, LINKED_CUSTODY_VOLUME);
    assert.equal(campaignUsage.references, 0);
    const organizationUsage = db.prepare(organizationSql).get();
    assert.equal(
      organizationUsage.entries,
      LINKED_CUSTODY_VOLUME + UNLINKED_MEMBER_VOLUME + 1
    );
    assert.equal(
      organizationUsage.chunks,
      LINKED_CUSTODY_VOLUME + UNLINKED_MEMBER_VOLUME + created.chunks.length
    );
    assert.equal(organizationUsage.references, UNLINKED_MEMBER_VOLUME);

    const plans = [
      { scope: 'campaign', details: capacityPlanDetails(db, campaignSql) },
      {
        scope: 'organization',
        details: capacityPlanDetails(db, organizationSql)
      }
    ];
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
      elapsedMs < LOOSE_VOLUME_RUNTIME_LIMIT_MS,
      `linked custody writer exceeded loose ${LOOSE_VOLUME_RUNTIME_LIMIT_MS}ms guard: ` +
        `${elapsedMs.toFixed(3)}ms`
    );
    const correlatedSubqueries = plans.flatMap((plan) => (
      plan.details
        .filter((detail) => /CORRELATED SCALAR SUBQUERY/i.test(detail))
        .map((detail) => `${plan.scope}: ${detail}`)
    ));
    assert.deepEqual(
      correlatedSubqueries,
      [],
      'campaign and organization capacity plans must have no correlated scalar subqueries'
    );
    const correlatedCustodyScans = plans.flatMap((plan) => (
      plan.details
        .filter((detail) => /\b(?:SCAN|SEARCH) (?:active|historical)\b/i.test(detail))
        .map((detail) => `${plan.scope}: ${detail}`)
    ));
    assert.deepEqual(
      correlatedCustodyScans,
      [],
      'capacity plans must not execute per-record active/historical custody scans'
    );
    plans.forEach((plan) => {
      assert.ok(
        plan.details.some(
          (detail) => /MATERIALIZE knowledge_custody_ranked/i.test(detail)
        ),
        `${plan.scope} capacity plan must materialize the window-ranked custody scan`
      );
    });
    const organizationPlan = plans.find((plan) => plan.scope === 'organization');
    assert.ok(
      organizationPlan.details.some(
        (detail) => /MATERIALIZE scope_members/i.test(detail)
      ),
      'organization capacity plan must materialize organization membership once'
    );
    assert.ok(
      organizationPlan.details.some(
        (detail) => /MATERIALIZE capacity_entries/i.test(detail)
      ),
      'organization capacity plan must materialize reusable entry attribution'
    );
  } finally {
    captureCapacitySql = false;
    closeWithRollback(db);
  }
});

test('campaign knowledge writer admits the exact user entry limit and rejects limit plus one before mutation', () => {
  const db = openV2Database();
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

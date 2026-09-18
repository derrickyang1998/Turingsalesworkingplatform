'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const sqliteDigest = require('../services/sqlite_digest_service');
const migrationGate = require('../scripts/verify_campaign_migration_gate');

const SERVER_ROOT = path.resolve(__dirname, '..');
const LEGACY_ENTRY_COLUMNS = Object.freeze([
  'id',
  'entry_type',
  'source_type',
  'source_id',
  'key_terms',
  'content',
  'created_by',
  'is_public',
  'usage_count',
  'created_at',
  'updated_at',
  'title',
  'summary',
  'tags_json',
  'visibility',
  'source_hash',
  'business_type',
  'business_id',
  'metadata_json',
  'embedding_json',
  'source_identity_sha256',
  'content_sha256'
]);
const LEGACY_CHUNK_COLUMNS = Object.freeze([
  'id',
  'entry_id',
  'chunk_index',
  'content',
  'metadata_json',
  'token_count',
  'embedding_json',
  'created_at',
  'content_sha256'
]);
const CAPACITY_TRIGGER_NAMES = Object.freeze([
  'trg_task7_current_custody_insert',
  'trg_task7_current_custody_delete',
  'trg_task7_knowledge_entry_insert',
  'trg_task7_knowledge_entry_payload_update',
  'trg_task7_knowledge_entry_delete',
  'trg_task7_knowledge_chunk_insert',
  'trg_task7_knowledge_chunk_delete',
  'trg_task7_knowledge_chunk_payload_update',
  'trg_task7_membership_insert',
  'trg_task7_membership_delete',
  'trg_task7_reference_insert',
  'trg_task7_reference_delete',
  'organization_knowledge_custody_capacity_insert'
]);

function sha256(value) {
  return crypto.createHash('sha256')
    .update(Buffer.isBuffer(value) ? value : String(value))
    .digest('hex');
}

function loadMigration() {
  try {
    return require('../migrations/024_knowledge_tenant_ownership');
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') {
      assert.fail('migration 024 has not been implemented');
    }
    throw error;
  }
}

function migrationsThroughV24(migration) {
  return [
    ...migrationGate.REGISTERED_MIGRATIONS.filter((registered) => registered.version <= 23),
    migration
  ];
}

function migrationOptions(migration) {
  return {
    rootDir: SERVER_ROOT,
    registeredMigrations: migrationsThroughV24(migration)
  };
}

function openV23(filename = ':memory:') {
  const db = new Database(filename);
  db.pragma('foreign_keys = ON');
  migrationService.runMigrations(db, {
    rootDir: SERVER_ROOT,
    registeredMigrations: migrationGate.REGISTERED_MIGRATIONS.filter(
      (registered) => registered.version <= 23
    )
  });
  return db;
}

function migrateToV24(db, migration) {
  return migrationService.runMigrations(db, migrationOptions(migration));
}

function seedTwoOrganizations(db) {
  db.prepare("INSERT INTO organizations (id,code,name) VALUES (2,'second-org','Second Org')").run();
  db.prepare(`
    INSERT INTO users (id,username,password_hash,display_name,role,is_active)
    VALUES (100,'tenant2-owner','fixture-hash','Tenant 2 Owner','user',1)
  `).run();
  db.prepare(`
    INSERT INTO users (id,username,password_hash,display_name,role,is_active)
    VALUES (101,'tenant2-creator','fixture-hash','Tenant 2 Creator','user',1)
  `).run();
  db.prepare(`
    INSERT INTO organization_memberships (org_id,user_id,role_code,status)
    VALUES (2,100,'org_admin','active'),(2,101,'member','active'),(2,1,'member','active')
  `).run();
  db.prepare(`
    INSERT INTO teams (id,org_id,code,name)
    VALUES (100,2,'tenant2-team','Tenant 2 Team')
  `).run();
  db.prepare(`
    INSERT INTO team_memberships (org_id,team_id,user_id,role_code,status)
    VALUES (2,100,100,'team_lead','active')
  `).run();

  db.prepare(`
    INSERT INTO customers (
      id,brand_name,created_by,assigned_to,is_public,org_id,team_id
    ) VALUES (1001,'Default Campaign Brand',1,1,0,1,6)
  `).run();
  db.prepare(`
    INSERT INTO opportunities (
      id,customer_id,name,created_by,org_id,team_id,owner_user_id
    ) VALUES (2001,1001,'Default Campaign Opportunity',1,1,6,1)
  `).run();
  db.prepare(`
    INSERT INTO campaigns (
      id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id
    ) VALUES (3001,1,'Default Campaign',1001,2001,1,6)
  `).run();

  db.prepare(`
    INSERT INTO customers (
      id,brand_name,created_by,assigned_to,is_public,org_id,team_id
    ) VALUES (1002,'Second Campaign Brand',100,100,0,2,100)
  `).run();
  db.prepare(`
    INSERT INTO opportunities (
      id,customer_id,name,created_by,org_id,team_id,owner_user_id
    ) VALUES (2002,1002,'Second Campaign Opportunity',100,2,100,100)
  `).run();
  db.prepare(`
    INSERT INTO campaigns (
      id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id
    ) VALUES (3002,2,'Second Campaign',1002,2002,100,100)
  `).run();
}

function insertLegacyKnowledge(db, options) {
  const row = {
    id: options.id,
    entryType: options.entryType || 'note',
    sourceType: options.sourceType || 'migration_fixture',
    sourceId: options.sourceId || `source-${options.id}`,
    keyTerms: options.keyTerms || '[]',
    content: options.content || `content-${options.id}`,
    createdBy: options.createdBy === undefined ? null : options.createdBy,
    isPublic: options.isPublic === undefined ? 0 : options.isPublic,
    usageCount: options.usageCount || 0,
    createdAt: options.createdAt || '2026-09-01 01:02:03',
    updatedAt: options.updatedAt || '2026-09-02 04:05:06',
    title: options.title || `Knowledge ${options.id}`,
    summary: options.summary || `Summary ${options.id}`,
    tagsJson: options.tagsJson || '["legacy","tenant"]',
    visibility: options.visibility || 'team',
    sourceHash: options.sourceHash || `legacy-source-hash-${options.id}`,
    businessType: options.businessType === undefined ? null : options.businessType,
    businessId: options.businessId === undefined ? null : options.businessId,
    metadataJson: options.metadataJson || '{"fixture":"v23"}',
    embeddingJson: options.embeddingJson === undefined ? '[0.25,0.75]' : options.embeddingJson,
    sourceIdentitySha256: options.sourceIdentitySha256 || sha256(`source-identity-${options.id}`),
    contentSha256: options.contentSha256 || sha256(`content-identity-${options.id}`)
  };
  db.prepare(`
    INSERT INTO knowledge_entries (
      id,entry_type,source_type,source_id,key_terms,content,created_by,is_public,
      usage_count,created_at,updated_at,title,summary,tags_json,visibility,
      source_hash,business_type,business_id,metadata_json,embedding_json,
      source_identity_sha256,content_sha256
    ) VALUES (
      @id,@entryType,@sourceType,@sourceId,@keyTerms,@content,@createdBy,@isPublic,
      @usageCount,@createdAt,@updatedAt,@title,@summary,@tagsJson,@visibility,
      @sourceHash,@businessType,@businessId,@metadataJson,@embeddingJson,
      @sourceIdentitySha256,@contentSha256
    )
  `).run(row);
  return row;
}

function insertOwnedKnowledge(db, options) {
  const values = {
    id: options.id,
    entryType: options.entryType || 'note',
    sourceType: options.sourceType || 'migration_fixture',
    sourceId: options.sourceId || `source-${options.id}`,
    keyTerms: options.keyTerms || '[]',
    content: options.content || `content-${options.id}`,
    createdBy: options.createdBy === undefined ? null : options.createdBy,
    isPublic: options.isPublic === undefined ? 0 : options.isPublic,
    usageCount: options.usageCount || 0,
    title: options.title || `Knowledge ${options.id}`,
    summary: options.summary || `Summary ${options.id}`,
    tagsJson: options.tagsJson || '[]',
    visibility: options.visibility || 'team',
    sourceHash: options.sourceHash === undefined ? null : options.sourceHash,
    businessType: options.businessType === undefined ? null : options.businessType,
    businessId: options.businessId === undefined ? null : options.businessId,
    metadataJson: options.metadataJson || '{}',
    embeddingJson: options.embeddingJson === undefined ? null : options.embeddingJson,
    sourceIdentitySha256: options.sourceIdentitySha256 || sha256(`owned-source-${options.id}`),
    contentSha256: options.contentSha256 || sha256(`owned-content-${options.id}`),
    orgId: options.orgId
  };
  db.prepare(`
    INSERT INTO knowledge_entries (
      id,entry_type,source_type,source_id,key_terms,content,created_by,is_public,
      usage_count,title,summary,tags_json,visibility,source_hash,business_type,
      business_id,metadata_json,embedding_json,source_identity_sha256,
      content_sha256,org_id
    ) VALUES (
      @id,@entryType,@sourceType,@sourceId,@keyTerms,@content,@createdBy,@isPublic,
      @usageCount,@title,@summary,@tagsJson,@visibility,@sourceHash,@businessType,
      @businessId,@metadataJson,@embeddingJson,@sourceIdentitySha256,
      @contentSha256,@orgId
    )
  `).run(values);
  return values;
}

function insertChunkAndFts(db, entryId, chunkId, content) {
  db.prepare(`
    INSERT INTO knowledge_chunks (
      id,entry_id,chunk_index,content,metadata_json,token_count,embedding_json,
      created_at,content_sha256
    ) VALUES (?, ?, 0, ?, '{"fixture":"chunk"}', 7, '[0.5]',
      '2026-09-03 07:08:09', ?)
  `).run(chunkId, entryId, content, sha256(content));
  sqliteDigest.rebuildKnowledgeChunksFts(db);
}

function insertCampaignLink(db, options) {
  db.prepare(`
    INSERT INTO campaign_record_links (
      id,org_id,campaign_id,record_type,bundle_id,record_id,relation_type,
      created_by,metadata_json
    ) VALUES (?, ?, ?, 'knowledge_entry', ?, ?, 'knowledge', ?, '{}')
  `).run(
    options.id,
    options.orgId,
    options.campaignId,
    sha256(`bundle-${options.id}`),
    String(options.entryId),
    options.createdBy
  );
}

function revokeCampaignLink(db, linkId, userId) {
  db.prepare(`
    UPDATE campaign_record_links
    SET revoked_at='2026-09-10 00:00:00',revoked_by=?,revoke_reason='migration fixture transfer'
    WHERE id=?
  `).run(userId, linkId);
}

function insertOrganizationMethodologyEntry(db, options) {
  insertLegacyKnowledge(db, {
    id: options.id,
    entryType: 'performance_review_methodology',
    sourceType: 'organization_performance_methodology',
    sourceId: `methodology-${options.id}`,
    content: `methodology-content-${options.id}`,
    createdBy: options.createdBy,
    isPublic: 1,
    visibility: 'team',
    businessType: 'organization',
    businessId: String(options.businessOrgId),
    metadataJson: '{"organization_methodology":{"contract_version":"organization-methodology-promotion-v2"}}'
  });
}

function insertKnowledgeReference(db, options) {
  db.prepare(`
    INSERT INTO ai_conversations (id,user_id,title)
    VALUES (?,?,'Knowledge tenant capacity fixture')
  `).run(options.id, options.userId);
  db.prepare(`
    INSERT INTO ai_messages (id,conversation_id,user_id,role,content)
    VALUES (?,?,?,'assistant','Knowledge tenant capacity answer')
  `).run(options.id, options.id, options.userId);
  const hashes = db.prepare(`
    SELECT
      entry.source_identity_sha256,
      entry.content_sha256 AS entry_content_sha256,
      chunk.content_sha256 AS chunk_content_sha256
    FROM knowledge_entries entry
    JOIN knowledge_chunks chunk ON chunk.entry_id=entry.id
    WHERE entry.id=? AND chunk.id=?
  `).get(options.entryId, options.chunkId);
  db.prepare(`
    INSERT INTO ai_references (
      id,message_id,reference_type,reference_id,reference_schema_version,
      knowledge_entry_id,knowledge_chunk_id,campaign_id,source_identity_sha256,
      entry_content_sha256,chunk_content_sha256,reference_rank,selection_origin
    ) VALUES (?,?,'knowledge',?,1,?,?,?,?,?,?,1,'selected')
  `).run(
    options.id,
    options.id,
    String(options.entryId),
    options.entryId,
    options.chunkId,
    options.campaignId,
    hashes.source_identity_sha256,
    hashes.entry_content_sha256,
    hashes.chunk_content_sha256
  );
}

function insertUnscopedReference(db, options) {
  db.prepare(`
    INSERT INTO ai_conversations (id,user_id,title)
    VALUES (?,?,'Unscoped capacity fixture')
  `).run(options.id, options.userId);
  db.prepare(`
    INSERT INTO ai_messages (id,conversation_id,user_id,role,content)
    VALUES (?,?,?,'assistant','Unscoped capacity answer')
  `).run(options.id, options.id, options.userId);
  db.prepare(`
    INSERT INTO ai_references (id,message_id,reference_type,reference_id)
    VALUES (?,?,'web',?)
  `).run(options.id, options.id, `web-${options.id}`);
}

function capacityUsage(db, orgId) {
  return Object.fromEntries(db.prepare(`
    SELECT metric,usage_value
    FROM knowledge_capacity_gauges
    WHERE scope_type='organization' AND scope_id=?
    ORDER BY metric
  `).all(orgId).map((row) => [row.metric, row.usage_value]));
}

function expectedOrganizationUsage(db, orgId) {
  return db.prepare(`
    SELECT
      (
        SELECT COUNT(*) FROM knowledge_entries entry WHERE entry.org_id=@orgId
      ) AS entries,
      (
        SELECT COALESCE(SUM(footprint.chunk_count),0)
        FROM knowledge_entries entry
        JOIN knowledge_entry_footprints footprint
          ON footprint.knowledge_entry_id=entry.id
        WHERE entry.org_id=@orgId
      ) AS chunks,
      (
        SELECT COALESCE(SUM(
          footprint.entry_payload_bytes + footprint.chunk_payload_bytes
        ),0)
        FROM knowledge_entries entry
        JOIN knowledge_entry_footprints footprint
          ON footprint.knowledge_entry_id=entry.id
        WHERE entry.org_id=@orgId
      ) AS payload_bytes,
      (
        SELECT COUNT(*)
        FROM ai_references reference
        LEFT JOIN campaigns campaign ON campaign.id=reference.campaign_id
        LEFT JOIN knowledge_entries referenced_entry
          ON referenced_entry.id=reference.knowledge_entry_id
        WHERE (reference.campaign_id IS NOT NULL AND campaign.org_id=@orgId)
          OR (reference.campaign_id IS NULL AND referenced_entry.org_id=@orgId)
      ) AS "references"
  `).get({ orgId });
}

function legacyProjection(db) {
  return {
    entries: db.prepare(`
      SELECT ${LEGACY_ENTRY_COLUMNS.join(',')}
      FROM knowledge_entries
      ORDER BY id
    `).all(),
    chunks: db.prepare(`
      SELECT ${LEGACY_CHUNK_COLUMNS.join(',')}
      FROM knowledge_chunks
      ORDER BY id
    `).all(),
    fts: db.prepare(`
      SELECT rowid,title,content,tags,entry_id,chunk_id
      FROM knowledge_chunks_fts
      ORDER BY rowid
    `).all()
  };
}

function v24State(db) {
  return {
    version: db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,
    ownership: db.prepare('SELECT id,org_id FROM knowledge_entries ORDER BY id').all(),
    legacy: legacyProjection(db),
    schema: db.prepare(`
      SELECT type,name,sql
      FROM sqlite_schema
      WHERE name IN (
        'idx_knowledge_source_hash','ux_knowledge_entries_org_id',
        'idx_knowledge_entries_org_search_order','knowledge_entries_no_replace_insert',
        'knowledge_entries_org_scope_insert','knowledge_entries_org_scope_update',
        'campaign_record_links_knowledge_org_insert',
        'campaign_record_links_knowledge_org_update',
        'organization_knowledge_custody_org_insert',
        'organization_knowledge_custody_org_update'
      )
      ORDER BY type,name
    `).all()
  };
}

test('migration 024 follows authoritative custody and business precedence while ignoring creator memberships', () => {
  const migration = loadMigration();
  assert.equal(migration.version, 24);
  assert.equal(migration.name, '024_knowledge_tenant_ownership');
  assert.equal(migration.sourcePath, 'migrations/024_knowledge_tenant_ownership.js');

  const db = openV23();
  try {
    seedTwoOrganizations(db);
    insertLegacyKnowledge(db, { id: 501, createdBy: null, title: 'Creatorless default' });
    insertChunkAndFts(db, 501, 601, 'byte-stable legacy chunk');
    insertLegacyKnowledge(db, { id: 502, createdBy: 101, title: 'Unique membership ignored' });
    insertLegacyKnowledge(db, { id: 503, createdBy: 1, title: 'Ambiguous membership ignored' });
    insertLegacyKnowledge(db, {
      id: 504,
      createdBy: null,
      title: 'Organization business authority',
      businessType: 'organization',
      businessId: '2'
    });
    insertLegacyKnowledge(db, { id: 505, createdBy: null, title: 'Current Campaign custody' });
    insertCampaignLink(db, {
      id: 701,
      orgId: 2,
      campaignId: 3002,
      entryId: 505,
      createdBy: 100
    });
    insertLegacyKnowledge(db, { id: 506, createdBy: null, title: 'Historical Campaign custody' });
    insertCampaignLink(db, {
      id: 702,
      orgId: 2,
      campaignId: 3002,
      entryId: 506,
      createdBy: 100
    });
    revokeCampaignLink(db, 702, 100);
    insertOrganizationMethodologyEntry(db, { id: 507, createdBy: 100, businessOrgId: 2 });
    db.prepare(`
      INSERT INTO organization_knowledge_custody (
        knowledge_entry_id,org_id,custody_type,created_by
      ) VALUES (507,2,'methodology',100)
    `).run();

    const before = legacyProjection(db);
    assert.deepEqual(migrateToV24(db, migration), { status: 'managed', currentVersion: 24 });

    assert.deepEqual(legacyProjection(db), before);
    assert.deepEqual(
      db.prepare('SELECT id,org_id FROM knowledge_entries ORDER BY id').all(),
      [
        { id: 501, org_id: 1 },
        { id: 502, org_id: 1 },
        { id: 503, org_id: 1 },
        { id: 504, org_id: 2 },
        { id: 505, org_id: 2 },
        { id: 506, org_id: 2 },
        { id: 507, org_id: 2 }
      ]
    );
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);

    const firstState = v24State(db);
    assert.deepEqual(migrateToV24(db, migration), { status: 'managed', currentVersion: 24 });
    assert.deepEqual(v24State(db), firstState);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version=24').get().count, 1);
  } finally {
    db.close();
  }
});

test('migration 024 rejects conflicting current and historical Campaign custody and rolls back exactly', () => {
  const migration = loadMigration();
  const db = openV23();
  try {
    seedTwoOrganizations(db);
    insertLegacyKnowledge(db, { id: 510, createdBy: null, title: 'Conflicting Campaign history' });
    insertCampaignLink(db, {
      id: 710,
      orgId: 1,
      campaignId: 3001,
      entryId: 510,
      createdBy: 1
    });
    revokeCampaignLink(db, 710, 1);
    insertCampaignLink(db, {
      id: 711,
      orgId: 2,
      campaignId: 3002,
      entryId: 510,
      createdBy: 100
    });
    const before = legacyProjection(db);

    assert.throws(
      () => migrateToV24(db, migration),
      /conflicting authoritative knowledge organization custody/i
    );
    assert.deepEqual(legacyProjection(db), before);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('knowledge_entries') WHERE name='org_id'").get().count,
      0
    );
    assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 23);
    assert.match(
      db.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND name='idx_knowledge_source_hash'").get().sql,
      /ON knowledge_entries\(source_hash\)/
    );
  } finally {
    db.close();
  }
});

test('migration 024 installs the FK, scoped indexes, immutable ownership, and org-aware no-replace behavior', () => {
  const migration = loadMigration();
  const db = openV23();
  try {
    seedTwoOrganizations(db);
    insertLegacyKnowledge(db, { id: 520, createdBy: null, sourceHash: 'shared-source-hash' });
    migrateToV24(db, migration);

    assert.deepEqual(
      db.prepare('PRAGMA foreign_key_list(knowledge_entries)').all()
        .filter((foreignKey) => foreignKey.from === 'org_id')
        .map((foreignKey) => ({
          table: foreignKey.table,
          from: foreignKey.from,
          to: foreignKey.to,
          onUpdate: foreignKey.on_update,
          onDelete: foreignKey.on_delete
        })),
      [{
        table: 'organizations',
        from: 'org_id',
        to: 'id',
        onUpdate: 'RESTRICT',
        onDelete: 'RESTRICT'
      }]
    );

    const indexes = new Map(db.prepare(`
      SELECT name,sql FROM sqlite_schema
      WHERE type='index' AND name IN (
        'idx_knowledge_source_hash','ux_knowledge_source_identity',
        'ux_knowledge_campaign_review_source','ux_knowledge_entries_org_id',
        'idx_knowledge_entries_org_search_order'
      )
    `).all().map((row) => [row.name, row.sql.replace(/\s+/g, ' ')]));
    assert.match(indexes.get('idx_knowledge_source_hash'), /UNIQUE INDEX .* ON knowledge_entries\(org_id,source_hash\)/i);
    assert.match(indexes.get('idx_knowledge_source_hash'), /WHERE source_hash IS NOT NULL AND source_hash != ''/i);
    assert.match(
      indexes.get('ux_knowledge_source_identity'),
      /UNIQUE INDEX .* ON knowledge_entries\(org_id,source_identity_sha256\)/i
    );
    assert.match(
      indexes.get('ux_knowledge_campaign_review_source'),
      /UNIQUE INDEX .* ON knowledge_entries\(org_id,source_type,CAST\(source_id AS TEXT\)\)/i
    );
    assert.match(indexes.get('ux_knowledge_entries_org_id'), /UNIQUE INDEX .*knowledge_entries\(org_id,id\)/i);
    assert.match(
      indexes.get('idx_knowledge_entries_org_search_order'),
      /knowledge_entries\(org_id,usage_count DESC,updated_at DESC,id DESC\)/i
    );

    const noReplace = db.prepare(`
      SELECT sql FROM sqlite_schema
      WHERE type='trigger' AND name='knowledge_entries_no_replace_insert'
    `).get().sql.replace(/\s+/g, ' ');
    assert.match(noReplace, /existing\.org_id=NEW\.org_id/i);

    const sharedSourceIdentity = db.prepare(`
      SELECT source_identity_sha256
      FROM knowledge_entries
      WHERE id=520
    `).get().source_identity_sha256;
    insertOwnedKnowledge(db, {
      id: 521,
      orgId: 2,
      sourceHash: 'shared-source-hash',
      sourceIdentitySha256: sharedSourceIdentity
    });
    assert.deepEqual(
      db.prepare("SELECT id,org_id,source_hash FROM knowledge_entries WHERE source_hash='shared-source-hash' ORDER BY org_id").all(),
      [
        { id: 520, org_id: 1, source_hash: 'shared-source-hash' },
        { id: 521, org_id: 2, source_hash: 'shared-source-hash' }
      ]
    );
    assert.throws(
      () => insertOwnedKnowledge(db, {
        id: 522,
        orgId: 1,
        sourceHash: 'shared-source-hash',
        sourceIdentitySha256: sharedSourceIdentity
      }),
      /knowledge entry cannot be replaced|UNIQUE constraint failed/i
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM knowledge_entries WHERE id=520').get().count, 1);

    const sharedReview = {
      entryType: 'campaign_review',
      sourceType: 'campaign_review',
      sourceId: '9001:1',
      sourceHash: 'shared-campaign-review-hash',
      sourceIdentitySha256: sha256('shared-campaign-review-identity'),
      businessType: 'campaign',
      businessId: '9001'
    };
    insertOwnedKnowledge(db, { id: 525, orgId: 1, ...sharedReview });
    assert.doesNotThrow(() => insertOwnedKnowledge(db, { id: 526, orgId: 2, ...sharedReview }));
    assert.throws(
      () => insertOwnedKnowledge(db, { id: 527, orgId: 2, ...sharedReview }),
      /knowledge entry cannot be replaced|UNIQUE constraint failed/i
    );

    assert.throws(
      () => db.prepare(`
        INSERT INTO knowledge_entries (
          id,entry_type,source_type,content,source_identity_sha256,content_sha256
        ) VALUES (523,'note','fixture','missing org',?,?)
      `).run(sha256('missing-org-source'), sha256('missing-org-content')),
      /knowledge organization ownership is required/i
    );
    assert.throws(
      () => insertOwnedKnowledge(db, { id: 524, orgId: 999 }),
      /knowledge organization ownership is required/i
    );
    assert.throws(
      () => db.prepare('UPDATE knowledge_entries SET org_id=2 WHERE id=520').run(),
      /knowledge organization ownership is immutable/i
    );
    assert.doesNotThrow(() => db.prepare('UPDATE knowledge_entries SET usage_count=usage_count+1 WHERE id=520').run());
    assert.equal(db.prepare('SELECT org_id FROM knowledge_entries WHERE id=520').get().org_id, 1);
  } finally {
    db.close();
  }
});

test('migration 024 rejects Campaign and organization custody links that disagree with entry ownership', () => {
  const migration = loadMigration();
  const db = openV23();
  try {
    seedTwoOrganizations(db);
    migrateToV24(db, migration);

    insertOwnedKnowledge(db, { id: 530, orgId: 1, sourceHash: null });
    assert.throws(
      () => insertCampaignLink(db, {
        id: 730,
        orgId: 2,
        campaignId: 3002,
        entryId: 530,
        createdBy: 100
      }),
      /campaign knowledge organization mismatch/i
    );
    assert.doesNotThrow(() => insertCampaignLink(db, {
      id: 731,
      orgId: 1,
      campaignId: 3001,
      entryId: 530,
      createdBy: 1
    }));
    assert.doesNotThrow(() => revokeCampaignLink(db, 731, 1));

    insertOwnedKnowledge(db, {
      id: 531,
      orgId: 1,
      entryType: 'performance_review_methodology',
      sourceType: 'organization_performance_methodology',
      createdBy: 100,
      isPublic: 1,
      visibility: 'team',
      businessType: 'organization',
      businessId: '2',
      metadataJson: '{"organization_methodology":{"contract_version":"organization-methodology-promotion-v2"}}'
    });
    assert.throws(
      () => db.prepare(`
        INSERT INTO organization_knowledge_custody (
          knowledge_entry_id,org_id,custody_type,created_by
        ) VALUES (531,2,'methodology',100)
      `).run(),
      /organization knowledge ownership mismatch/i
    );

    insertOwnedKnowledge(db, {
      id: 532,
      orgId: 2,
      entryType: 'performance_review_methodology',
      sourceType: 'organization_performance_methodology',
      createdBy: 100,
      isPublic: 1,
      visibility: 'team',
      businessType: 'organization',
      businessId: '2',
      metadataJson: '{"organization_methodology":{"contract_version":"organization-methodology-promotion-v2"}}'
    });
    assert.doesNotThrow(() => db.prepare(`
      INSERT INTO organization_knowledge_custody (
        knowledge_entry_id,org_id,custody_type,created_by
      ) VALUES (532,2,'methodology',100)
    `).run());
  } finally {
    db.close();
  }
});

test('migration 024 rebuilds and maintains organization capacity strictly from entry ownership', () => {
  const migration = loadMigration();
  const db = openV23();
  try {
    seedTwoOrganizations(db);
    insertLegacyKnowledge(db, { id: 560, createdBy: 101, sourceHash: null });
    insertChunkAndFts(db, 560, 660, 'Default organization capacity bytes');
    insertLegacyKnowledge(db, {
      id: 561,
      createdBy: 1,
      sourceHash: null,
      businessType: 'organization',
      businessId: '2'
    });
    insertChunkAndFts(db, 561, 661, 'Second organization capacity bytes');
    insertKnowledgeReference(db, {
      id: 760,
      userId: 1,
      entryId: 561,
      chunkId: 661,
      campaignId: 3002
    });
    insertUnscopedReference(db, { id: 759, userId: 1 });

    migrateToV24(db, migration);

    assert.deepEqual(capacityUsage(db, 1), expectedOrganizationUsage(db, 1));
    assert.deepEqual(capacityUsage(db, 2), expectedOrganizationUsage(db, 2));
    assert.equal(capacityUsage(db, 1).references, 0);
    assert.equal(capacityUsage(db, 2).references, 1);

    const capacityTriggers = db.prepare(`
      SELECT name,sql
      FROM sqlite_schema
      WHERE type='trigger' AND name IN (${CAPACITY_TRIGGER_NAMES.map(() => '?').join(',')})
      ORDER BY name
    `).all(...CAPACITY_TRIGGER_NAMES);
    assert.equal(capacityTriggers.length, CAPACITY_TRIGGER_NAMES.length);
    for (const trigger of capacityTriggers) {
      assert.doesNotMatch(
        trigger.sql,
        /(?:FROM|JOIN)\s+organization_memberships|membership\./i,
        trigger.name
      );
      assert.equal(migration.schemaManifest.triggers[trigger.name], trigger.sql);
    }

    db.prepare("INSERT INTO organizations (id,code,name) VALUES (3,'third-org','Third Org')").run();
    const thirdBeforeMembership = capacityUsage(db, 3);
    db.prepare(`
      INSERT INTO organization_memberships (org_id,user_id,role_code,status)
      VALUES (3,101,'member','active')
    `).run();
    assert.deepEqual(capacityUsage(db, 3), thirdBeforeMembership);

    insertOwnedKnowledge(db, { id: 562, orgId: 1, createdBy: 101, sourceHash: null });
    insertChunkAndFts(db, 562, 662, 'Runtime ownership capacity bytes');
    assert.deepEqual(capacityUsage(db, 1), expectedOrganizationUsage(db, 1));
    assert.deepEqual(capacityUsage(db, 2), expectedOrganizationUsage(db, 2));
    assert.deepEqual(capacityUsage(db, 3), expectedOrganizationUsage(db, 3));

    insertKnowledgeReference(db, {
      id: 761,
      userId: 101,
      entryId: 562,
      chunkId: 662,
      campaignId: 3001
    });
    assert.equal(capacityUsage(db, 1).references, 1);
    assert.equal(capacityUsage(db, 2).references, 1);
    assert.equal(capacityUsage(db, 3).references, 0);
    insertUnscopedReference(db, { id: 763, userId: 101 });
    assert.equal(capacityUsage(db, 1).references, 1);
    assert.equal(capacityUsage(db, 2).references, 1);
    assert.equal(capacityUsage(db, 3).references, 0);

    insertOwnedKnowledge(db, { id: 563, orgId: 2, createdBy: 1, sourceHash: null });
    const beforeCustody = {
      org1: capacityUsage(db, 1),
      org2: capacityUsage(db, 2)
    };
    insertCampaignLink(db, {
      id: 762,
      orgId: 2,
      campaignId: 3002,
      entryId: 563,
      createdBy: 100
    });
    assert.deepEqual(capacityUsage(db, 1), beforeCustody.org1);
    assert.deepEqual(capacityUsage(db, 2), beforeCustody.org2);
  } finally {
    db.close();
  }
});

test('migration 024 recognizes the sanitizer-compatible default fingerprint and fails without one unique default', () => {
  const migration = loadMigration();
  const sanitized = openV23();
  try {
    insertLegacyKnowledge(sanitized, { id: 540, createdBy: null });
    const immutableTrigger = sanitized.prepare(`
      SELECT sql FROM sqlite_schema
      WHERE type='trigger' AND name='organizations_code_immutable'
    `).get().sql;
    sanitized.exec('DROP TRIGGER organizations_code_immutable');
    sanitized.prepare(`
      UPDATE organizations SET code=?,name=? WHERE id=1
    `).run(
      'tm-inert-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'tmtext-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    );
    sanitized.exec(immutableTrigger);

    migrateToV24(sanitized, migration);
    assert.equal(sanitized.prepare('SELECT org_id FROM knowledge_entries WHERE id=540').get().org_id, 1);
  } finally {
    sanitized.close();
  }

  const unavailable = openV23();
  try {
    insertLegacyKnowledge(unavailable, { id: 541, createdBy: null });
    const immutableTrigger = unavailable.prepare(`
      SELECT sql FROM sqlite_schema
      WHERE type='trigger' AND name='organizations_code_immutable'
    `).get().sql;
    unavailable.exec('DROP TRIGGER organizations_code_immutable');
    unavailable.prepare("UPDATE organizations SET code='renamed-default' WHERE id=1").run();
    unavailable.exec(immutableTrigger);
    assert.throws(
      () => migrateToV24(unavailable, migration),
      /one unique default organization/i
    );
    assert.equal(
      unavailable.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('knowledge_entries') WHERE name='org_id'").get().count,
      0
    );
    assert.equal(unavailable.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 23);
  } finally {
    unavailable.close();
  }
});

test('migration 024 fails closed when a partial ownership migration already exists', () => {
  const migration = loadMigration();
  const db = openV23();
  try {
    db.exec(`
      ALTER TABLE knowledge_entries
      ADD COLUMN org_id INTEGER REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT
    `);
    assert.throws(
      () => migration.apply(db),
      /partial 024 knowledge ownership object exists/i
    );
    assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 23);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name='knowledge_entries_org_scope_insert'").get().count,
      0
    );
  } finally {
    db.close();
  }
});

test('a verified v23 backup migrates to an identical rerunnable v24 restored copy', async (t) => {
  const migration = loadMigration();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-v24-knowledge-restore-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'source-v23.db');
  const backupPath = path.join(root, 'immutable-v23-backup.db');
  const restorePath = path.join(root, 'restored-v24.db');

  const source = openV23(sourcePath);
  try {
    insertLegacyKnowledge(source, { id: 550, createdBy: null, summary: 'Backup summary bytes' });
    insertChunkAndFts(source, 550, 650, 'Backup chunk bytes');
    await source.backup(backupPath);
  } finally {
    source.close();
  }
  const backupDigest = sha256(fs.readFileSync(backupPath));
  fs.copyFileSync(backupPath, restorePath);

  const first = migrationService.openMigratedDatabase(restorePath, migrationOptions(migration));
  let expected;
  try {
    expected = v24State(first);
    assert.equal(expected.version, 24);
    assert.deepEqual(expected.ownership, [{ id: 550, org_id: 1 }]);
  } finally {
    first.close();
  }

  const second = migrationService.openMigratedDatabase(restorePath, migrationOptions(migration));
  try {
    assert.deepEqual(v24State(second), expected);
    assert.equal(second.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(second.pragma('foreign_key_check'), []);
  } finally {
    second.close();
  }
  assert.equal(sha256(fs.readFileSync(backupPath)), backupDigest);
  const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
  try {
    assert.equal(backup.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 23);
    assert.equal(
      backup.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('knowledge_entries') WHERE name='org_id'").get().count,
      0
    );
  } finally {
    backup.close();
  }
});

test('db.js registers migration 024 for normal database startup', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-v24-db-registration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const databasePath = path.join(root, 'registered.db');
  const result = spawnSync(process.execPath, ['-e', `
    const db = require('./db');
    const state = {
      version: db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,
      hasOrgId: db.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('knowledge_entries') WHERE name='org_id'").get().count
    };
    console.log(JSON.stringify(state));
    db.close();
  `], {
    cwd: SERVER_ROOT,
    env: { ...process.env, DB_PATH: databasePath },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.deepEqual(JSON.parse(output.at(-1)), { version: 24, hasOrgId: 1 });
});

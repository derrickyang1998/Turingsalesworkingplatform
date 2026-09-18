'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const sqliteDigest = require('../services/sqlite_digest_service');
const migrationGate = require('../scripts/verify_campaign_migration_gate');

const SERVER_ROOT = path.resolve(__dirname, '..');
const LEGACY_CONVERSATION_COLUMNS = Object.freeze([
  'id',
  'user_id',
  'title',
  'visibility',
  'source_module',
  'archived_summary_id',
  'created_at',
  'updated_at'
]);
const MESSAGE_COLUMNS = Object.freeze([
  'id',
  'conversation_id',
  'user_id',
  'role',
  'content',
  'model',
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
  'metadata_json',
  'created_at'
]);
const REFERENCE_COLUMNS = Object.freeze([
  'id',
  'message_id',
  'reference_type',
  'reference_id',
  'title',
  'url',
  'snippet',
  'provider',
  'metadata_json',
  'created_at',
  'reference_schema_version',
  'knowledge_entry_id',
  'knowledge_chunk_id',
  'campaign_id',
  'source_identity_sha256',
  'entry_content_sha256',
  'chunk_content_sha256',
  'reference_rank',
  'selection_origin'
]);

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function loadMigration() {
  try {
    return require('../migrations/025_ai_conversation_tenant_ownership');
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') {
      assert.fail('migration 025 has not been implemented');
    }
    throw error;
  }
}

function openV24() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrationService.runMigrations(db, {
    rootDir: SERVER_ROOT,
    registeredMigrations: migrationGate.REGISTERED_MIGRATIONS.filter(
      (migration) => migration.version <= 24
    )
  });
  return db;
}

function migrateToV25(db, migration) {
  return migrationService.runMigrations(db, {
    rootDir: SERVER_ROOT,
    registeredMigrations: [
      ...migrationGate.REGISTERED_MIGRATIONS.filter((registered) => registered.version <= 24),
      migration
    ]
  });
}

function seedTwoOrganizations(db) {
  const defaultTeamId = db.prepare(`
    SELECT team_id FROM team_memberships
    WHERE org_id=1 AND user_id=1 AND status='active'
    ORDER BY team_id LIMIT 1
  `).get().team_id;
  db.prepare("INSERT INTO organizations (id,code,name) VALUES (2,'conversation-org-2','Conversation Org 2')").run();
  db.prepare(`
    INSERT INTO users (id,username,password_hash,display_name,role,is_active)
    VALUES (100,'conversation-owner-2','fixture-hash','Conversation Owner 2','user',1)
  `).run();
  db.prepare(`
    INSERT INTO organization_memberships (org_id,user_id,role_code,status)
    VALUES (2,100,'org_admin','active')
  `).run();
  db.prepare(`
    INSERT INTO teams (id,org_id,code,name)
    VALUES (100,2,'conversation-team-2','Conversation Team 2')
  `).run();
  db.prepare(`
    INSERT INTO team_memberships (org_id,team_id,user_id,role_code,status)
    VALUES (2,100,100,'team_lead','active')
  `).run();

  db.prepare(`
    INSERT INTO customers (id,brand_name,created_by,assigned_to,is_public,org_id,team_id)
    VALUES (1001,'Conversation Default Brand',1,1,0,1,?)
  `).run(defaultTeamId);
  db.prepare(`
    INSERT INTO opportunities (id,customer_id,name,created_by,org_id,team_id,owner_user_id)
    VALUES (2001,1001,'Conversation Default Opportunity',1,1,?,1)
  `).run(defaultTeamId);
  db.prepare(`
    INSERT INTO campaigns (id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id)
    VALUES (3001,1,'Conversation Default Campaign',1001,2001,1,?)
  `).run(defaultTeamId);

  db.prepare(`
    INSERT INTO customers (id,brand_name,created_by,assigned_to,is_public,org_id,team_id)
    VALUES (1002,'Conversation Second Brand',100,100,0,2,100)
  `).run();
  db.prepare(`
    INSERT INTO opportunities (id,customer_id,name,created_by,org_id,team_id,owner_user_id)
    VALUES (2002,1002,'Conversation Second Opportunity',100,2,100,100)
  `).run();
  db.prepare(`
    INSERT INTO campaigns (id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id)
    VALUES (3002,2,'Conversation Second Campaign',1002,2002,100,100)
  `).run();
}

function insertKnowledge(db, options) {
  const sourceIdentity = sha256(`source-${options.id}`);
  const contentIdentity = sha256(`content-${options.id}`);
  db.prepare(`
    INSERT INTO knowledge_entries (
      id,entry_type,source_type,source_id,key_terms,content,created_by,is_public,
      title,summary,tags_json,visibility,source_hash,metadata_json,
      source_identity_sha256,content_sha256,org_id
    ) VALUES (?, 'note','conversation_migration',?,'[]',?,?,0,?,?,'[]','team',?,'{}',?,?,?)
  `).run(
    options.id,
    `conversation-source-${options.id}`,
    `conversation-content-${options.id}`,
    options.createdBy,
    `Conversation knowledge ${options.id}`,
    `Conversation summary ${options.id}`,
    `conversation-hash-${options.id}`,
    sourceIdentity,
    contentIdentity,
    options.orgId
  );
  return { sourceIdentity, contentIdentity };
}

function insertChunk(db, options) {
  const contentIdentity = sha256(`chunk-${options.id}`);
  db.prepare(`
    INSERT INTO knowledge_chunks (
      id,entry_id,chunk_index,content,metadata_json,token_count,content_sha256
    ) VALUES (?,?,0,?,'{}',3,?)
  `).run(options.id, options.entryId, `conversation-chunk-${options.id}`, contentIdentity);
  sqliteDigest.rebuildKnowledgeChunksFts(db);
  return contentIdentity;
}

function insertConversation(db, options) {
  db.prepare(`
    INSERT INTO ai_conversations (
      id,user_id,title,visibility,source_module,archived_summary_id,created_at,updated_at
    ) VALUES (?,?,?,'private','assistant',?,'2026-09-01 01:02:03','2026-09-02 04:05:06')
  `).run(options.id, options.userId, options.title || `Conversation ${options.id}`, options.archivedSummaryId || null);
}

function insertMessage(db, options) {
  db.prepare(`
    INSERT INTO ai_messages (
      id,conversation_id,user_id,role,content,model,prompt_tokens,
      completion_tokens,total_tokens,metadata_json,created_at
    ) VALUES (?,?,?,'assistant',?,'fixture-model',3,4,7,'{}','2026-09-02 04:05:07')
  `).run(options.id, options.conversationId, options.userId, `Answer ${options.id}`);
}

function insertConversationLink(db, options) {
  db.prepare(`
    INSERT INTO campaign_record_links (
      id,org_id,campaign_id,record_type,bundle_id,record_id,relation_type,
      created_by,metadata_json
    ) VALUES (?, ?, ?, 'ai_conversation', ?, ?, 'ai_run', ?, '{}')
  `).run(
    options.id,
    options.orgId,
    options.campaignId,
    sha256(`conversation-link-${options.id}`),
    String(options.conversationId),
    options.createdBy
  );
}

function insertStructuredReference(db, options) {
  db.prepare(`
    INSERT INTO ai_references (
      id,message_id,reference_type,reference_id,reference_schema_version,
      knowledge_entry_id,knowledge_chunk_id,campaign_id,source_identity_sha256,
      entry_content_sha256,chunk_content_sha256,reference_rank,selection_origin
    ) VALUES (?,?,'knowledge',?,1,?,?,?,?,?,?,1,'selected')
  `).run(
    options.id,
    options.messageId,
    String(options.entryId),
    options.entryId,
    options.chunkId,
    options.campaignId,
    options.sourceIdentity,
    options.entryContentIdentity,
    options.chunkContentIdentity
  );
}

function insertLegacyKnowledgeReference(db, options) {
  db.prepare(`
    INSERT INTO ai_references (
      id,message_id,reference_type,reference_id,title,snippet,metadata_json
    ) VALUES (?,?,'knowledge',?,?,?,'{}')
  `).run(
    options.id,
    options.messageId,
    String(options.entryId),
    options.title || `Legacy knowledge ${options.entryId}`,
    options.snippet || `Legacy snippet ${options.entryId}`
  );
}

function legacyProjection(db) {
  return {
    conversations: db.prepare(`
      SELECT ${LEGACY_CONVERSATION_COLUMNS.join(',')} FROM ai_conversations ORDER BY id
    `).all(),
    messages: db.prepare(`
      SELECT ${MESSAGE_COLUMNS.join(',')} FROM ai_messages ORDER BY id
    `).all(),
    references: db.prepare(`
      SELECT ${REFERENCE_COLUMNS.join(',')} FROM ai_references ORDER BY id
    `).all(),
    links: db.prepare(`
      SELECT id,org_id,campaign_id,record_type,bundle_id,record_id,relation_type,
        created_by,created_at,revoked_at,revoked_by,revoke_reason,metadata_json
      FROM campaign_record_links ORDER BY id
    `).all()
  };
}

test('migration 025 backfills immutable conversation ownership from authoritative evidence and preserves legacy rows', () => {
  const migration = loadMigration();
  assert.equal(migration.version, 25);
  assert.equal(migration.name, '025_ai_conversation_tenant_ownership');
  assert.equal(migration.sourcePath, 'migrations/025_ai_conversation_tenant_ownership.js');

  const db = openV24();
  try {
    seedTwoOrganizations(db);
    const knowledge = insertKnowledge(db, { id: 701, createdBy: 100, orgId: 2 });
    const chunkContentIdentity = insertChunk(db, { id: 801, entryId: 701 });

    insertConversation(db, { id: 502, userId: 100, title: 'Campaign link evidence' });
    insertConversationLink(db, {
      id: 901,
      orgId: 2,
      campaignId: 3002,
      conversationId: 502,
      createdBy: 100
    });
    insertConversation(db, {
      id: 503,
      userId: 100,
      title: 'Archived summary evidence',
      archivedSummaryId: 701
    });
    insertConversation(db, { id: 504, userId: 100, title: 'Reference evidence' });
    insertMessage(db, { id: 604, conversationId: 504, userId: 100 });
    insertStructuredReference(db, {
      id: 904,
      messageId: 604,
      entryId: 701,
      chunkId: 801,
      campaignId: 3002,
      sourceIdentity: knowledge.sourceIdentity,
      entryContentIdentity: knowledge.contentIdentity,
      chunkContentIdentity
    });
    insertConversation(db, { id: 505, userId: 100, title: 'Legacy reference evidence' });
    insertMessage(db, { id: 605, conversationId: 505, userId: 100 });
    insertLegacyKnowledgeReference(db, {
      id: 905,
      messageId: 605,
      entryId: 701
    });

    const before = legacyProjection(db);
    assert.deepEqual(migrateToV25(db, migration), { status: 'managed', currentVersion: 25 });
    assert.deepEqual(legacyProjection(db), before);
    assert.deepEqual(
      db.prepare('SELECT id,org_id FROM ai_conversations ORDER BY id').all(),
      [
        { id: 502, org_id: 2 },
        { id: 503, org_id: 2 },
        { id: 504, org_id: 2 },
        { id: 505, org_id: 2 }
      ]
    );
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);

    const schema = db.prepare(`
      SELECT type,name FROM sqlite_schema
      WHERE name IN (
        'ux_ai_conversations_org_id','idx_ai_conversations_org_owner_updated',
        'ai_conversations_org_scope_insert','ai_conversations_org_scope_update',
        'campaign_record_links_ai_conversation_org_insert',
        'campaign_record_links_ai_conversation_org_update',
        'ai_references_conversation_org_insert','ai_references_conversation_org_update',
        'ai_conversations_no_replace_insert','ai_messages_conversation_owner_insert',
        'ai_messages_conversation_owner_update','ai_messages_no_replace_insert'
      ) ORDER BY type,name
    `).all();
    assert.equal(schema.length, 12);

    const firstOwnership = db.prepare('SELECT id,org_id FROM ai_conversations ORDER BY id').all();
    assert.deepEqual(migrateToV25(db, migration), { status: 'managed', currentVersion: 25 });
    assert.deepEqual(db.prepare('SELECT id,org_id FROM ai_conversations ORDER BY id').all(), firstOwnership);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version=25').get().count, 1);
  } finally {
    db.close();
  }
});

test('migration 025 uses default ownership only when the database has one organization', () => {
  const migration = loadMigration();
  const db = openV24();
  try {
    insertConversation(db, { id: 501, userId: 1, title: 'Single organization fallback' });
    assert.deepEqual(migrateToV25(db, migration), { status: 'managed', currentVersion: 25 });
    assert.deepEqual(
      db.prepare('SELECT id,org_id FROM ai_conversations WHERE id=501').get(),
      { id: 501, org_id: 1 }
    );
  } finally {
    db.close();
  }
});

test('migration 025 rejects unresolved ownership when more than one organization exists', () => {
  const migration = loadMigration();
  const db = openV24();
  try {
    seedTwoOrganizations(db);
    insertConversation(db, { id: 501, userId: 1, title: 'Ambiguous organization history' });
    const before = legacyProjection(db);

    assert.throws(
      () => migrateToV25(db, migration),
      /unresolved AI conversation organization ownership/
    );
    assert.deepEqual(legacyProjection(db), before);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('ai_conversations') WHERE name='org_id'").get().count,
      0
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version=25').get().count, 0);
  } finally {
    db.close();
  }
});

test('migration 025 rejects conflicting authoritative ownership and rolls back exactly', () => {
  const migration = loadMigration();
  const db = openV24();
  try {
    seedTwoOrganizations(db);
    insertKnowledge(db, { id: 710, createdBy: 100, orgId: 2 });
    insertConversation(db, {
      id: 510,
      userId: 1,
      title: 'Conflicting ownership',
      archivedSummaryId: 710
    });
    insertConversationLink(db, {
      id: 910,
      orgId: 1,
      campaignId: 3001,
      conversationId: 510,
      createdBy: 1
    });
    const before = legacyProjection(db);

    assert.throws(
      () => migrateToV25(db, migration),
      /conflicting authoritative AI conversation organization ownership/
    );
    assert.deepEqual(legacyProjection(db), before);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('ai_conversations') WHERE name='org_id'").get().count,
      0
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version=25').get().count, 0);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db.close();
  }
});

test('schema v25 rejects missing, unknown, reassigned, and cross-organization conversation relationships', () => {
  const migration = loadMigration();
  const db = openV24();
  try {
    seedTwoOrganizations(db);
    insertKnowledge(db, { id: 720, createdBy: 100, orgId: 2 });
    assert.deepEqual(migrateToV25(db, migration), { status: 'managed', currentVersion: 25 });

    assert.throws(
      () => db.prepare("INSERT INTO ai_conversations (user_id,title) VALUES (1,'Missing owner')").run(),
      /AI conversation organization ownership/
    );
    assert.throws(
      () => db.prepare("INSERT INTO ai_conversations (user_id,title,org_id) VALUES (1,'Unknown owner',9999)").run()
    );

    const conversationId = Number(db.prepare(`
      INSERT INTO ai_conversations (user_id,title,org_id)
      VALUES (1,'Owned conversation',1)
    `).run().lastInsertRowid);
    assert.throws(
      () => db.prepare(`
        INSERT OR REPLACE INTO ai_conversations (id,user_id,title,org_id)
        VALUES (?,100,'Reassigned by replace',2)
      `).run(conversationId),
      /AI conversation cannot be replaced/
    );
    assert.deepEqual(
      db.prepare('SELECT user_id,title,org_id FROM ai_conversations WHERE id=?').get(conversationId),
      { user_id: 1, title: 'Owned conversation', org_id: 1 }
    );
    assert.throws(
      () => db.prepare('UPDATE ai_conversations SET org_id=2 WHERE id=?').run(conversationId),
      /AI conversation organization ownership/
    );
    assert.throws(
      () => db.prepare('UPDATE ai_conversations SET archived_summary_id=720 WHERE id=?').run(conversationId),
      /AI conversation archived summary ownership mismatch/
    );
    assert.throws(() => insertConversationLink(db, {
      id: 920,
      orgId: 2,
      campaignId: 3002,
      conversationId,
      createdBy: 100
    }), /AI conversation Campaign ownership mismatch/);

    const messageId = Number(db.prepare(`
      INSERT INTO ai_messages (conversation_id,user_id,role,content)
      VALUES (?,1,'assistant','Owned answer')
    `).run(conversationId).lastInsertRowid);
    assert.throws(
      () => db.prepare(`
        INSERT INTO ai_messages (conversation_id,user_id,role,content)
        VALUES (?,100,'assistant','Wrong owner')
      `).run(conversationId),
      /AI message conversation ownership mismatch/
    );
    const secondConversationId = Number(db.prepare(`
      INSERT INTO ai_conversations (user_id,title,org_id)
      VALUES (100,'Second organization conversation',2)
    `).run().lastInsertRowid);
    assert.throws(
      () => db.prepare('UPDATE ai_messages SET conversation_id=?,user_id=100 WHERE id=?')
        .run(secondConversationId, messageId),
      /AI message conversation ownership is immutable/
    );
    assert.throws(
      () => db.prepare(`
        INSERT OR REPLACE INTO ai_messages (id,conversation_id,user_id,role,content)
        VALUES (?,?,100,'assistant','Reparented by replace')
      `).run(messageId, secondConversationId),
      /AI message cannot be replaced/
    );
    assert.throws(
      () => db.prepare(`
        INSERT INTO ai_references (message_id,reference_type,reference_id,knowledge_entry_id)
        VALUES (?,'knowledge','720',720)
      `).run(messageId),
      /AI reference organization ownership mismatch/
    );
    assert.throws(
      () => insertLegacyKnowledgeReference(db, {
        id: 921,
        messageId,
        entryId: 720
      }),
      /AI reference organization ownership mismatch/
    );
    const webReferenceId = Number(db.prepare(`
      INSERT INTO ai_references (message_id,reference_type,reference_id)
      VALUES (?,'web','https://example.com/reference')
    `).run(messageId).lastInsertRowid);
    assert.throws(
      () => db.prepare(`
        UPDATE ai_references
        SET reference_type='knowledge',reference_id='720'
        WHERE id=?
      `).run(webReferenceId),
      /AI reference organization ownership mismatch/
    );
  } finally {
    db.close();
  }
});

test('schema v25 attributes unscoped AI reference capacity to immutable conversation ownership', () => {
  const migration = loadMigration();
  const db = openV24();
  try {
    seedTwoOrganizations(db);
    assert.deepEqual(migrateToV25(db, migration), { status: 'managed', currentVersion: 25 });
    const before = Object.fromEntries(db.prepare(`
      SELECT scope_id,usage_value FROM knowledge_capacity_gauges
      WHERE scope_type='organization' AND metric='references' AND scope_id IN (1,2)
      ORDER BY scope_id
    `).all().map((row) => [row.scope_id, row.usage_value]));
    const conversationId = Number(db.prepare(`
      INSERT INTO ai_conversations (user_id,title,org_id)
      VALUES (100,'Second organization capacity',2)
    `).run().lastInsertRowid);
    const messageId = Number(db.prepare(`
      INSERT INTO ai_messages (conversation_id,user_id,role,content)
      VALUES (?,100,'assistant','Second organization answer')
    `).run(conversationId).lastInsertRowid);
    const referenceId = Number(db.prepare(`
      INSERT INTO ai_references (message_id,reference_type,reference_id)
      VALUES (?,'web','https://example.com/tenant-two')
    `).run(messageId).lastInsertRowid);

    const afterInsert = Object.fromEntries(db.prepare(`
      SELECT scope_id,usage_value FROM knowledge_capacity_gauges
      WHERE scope_type='organization' AND metric='references' AND scope_id IN (1,2)
      ORDER BY scope_id
    `).all().map((row) => [row.scope_id, row.usage_value]));
    assert.equal(afterInsert[1], before[1]);
    assert.equal(afterInsert[2], before[2] + 1);

    db.prepare('DELETE FROM ai_references WHERE id=?').run(referenceId);
    const afterDelete = Object.fromEntries(db.prepare(`
      SELECT scope_id,usage_value FROM knowledge_capacity_gauges
      WHERE scope_type='organization' AND metric='references' AND scope_id IN (1,2)
      ORDER BY scope_id
    `).all().map((row) => [row.scope_id, row.usage_value]));
    assert.deepEqual(afterDelete, before);
  } finally {
    db.close();
  }
});

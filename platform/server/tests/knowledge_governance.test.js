'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const knowledge = require('../services/knowledge_service');
const rag = require('../services/rag_service');
const migration007 = require('../migrations/007_knowledge_governance');

const SERVER_ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_V6 = Object.freeze([
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
  }),
  Object.freeze({
    version: 6,
    name: '006_crm_sales_workspace',
    sourcePath: 'migrations/006_crm_sales_workspace.js',
    engineVersion: 1,
    dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
  })
]);
const MIGRATIONS_V7 = Object.freeze([
  ...MIGRATIONS_V6,
  Object.freeze({
    version: 7,
    name: '007_knowledge_governance',
    sourcePath: 'migrations/007_knowledge_governance.js',
    engineVersion: 1,
    dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
  })
]);

function runMigrations(db, migrations) {
  migrationService.runMigrations(db, {
    rootDir: SERVER_ROOT,
    registeredMigrations: migrations
  });
  return db;
}

function openDatabase(migrations = MIGRATIONS_V7) {
  return runMigrations(new Database(':memory:'), migrations);
}

function identities(db) {
  const admin = db.prepare("SELECT id,role FROM users WHERE role='admin' ORDER BY id LIMIT 1").get();
  const owner = db.prepare("SELECT id,role FROM users WHERE role<>'admin' ORDER BY id LIMIT 1").get();
  assert.ok(admin);
  assert.ok(owner);
  return { admin, owner };
}

function addKnowledge(db, owner, suffix, content = 'governance-contract') {
  return knowledge.ingestKnowledge(db, {
    title: `Governance ${suffix}`,
    content: `${content} ${suffix}`,
    entry_type: 'methodology',
    source_type: 'governance_contract',
    source_id: suffix,
    visibility: 'team',
    tags: ['governance-contract'],
    created_by: owner.id,
    actor_role: owner.role
  });
}

function governanceRow(db, entryId) {
  return db.prepare(`
    SELECT * FROM knowledge_entry_governance WHERE knowledge_entry_id=?
  `).get(entryId);
}

function govern(db, admin, entryId, action, expectedVersion, extra = {}) {
  return knowledge.governKnowledgeEntry(db, {
    user: admin,
    entryId,
    action,
    expectedVersion,
    reason: `${action} governance contract`,
    ...extra
  });
}

test('migration 007 backfills existing knowledge without changing content or FTS and reruns as a no-op', () => {
  const db = openDatabase(MIGRATIONS_V6);
  const { owner } = identities(db);
  const entry = addKnowledge(db, owner, 'legacy');
  const before = db.prepare(`
    SELECT entry.content,entry.content_sha256,chunk.content AS chunk_content,
      chunk.content_sha256 AS chunk_sha256,fts.content AS fts_content
    FROM knowledge_entries entry
    JOIN knowledge_chunks chunk ON chunk.entry_id=entry.id
    JOIN knowledge_chunks_fts fts
      ON CAST(fts.entry_id AS INTEGER)=entry.id
     AND CAST(fts.chunk_id AS INTEGER)=chunk.id
    WHERE entry.id=?
    ORDER BY chunk.chunk_index,chunk.id
    LIMIT 1
  `).get(entry.id);

  runMigrations(db, MIGRATIONS_V7);

  assert.deepEqual(db.prepare(`
    SELECT version,name FROM schema_migrations ORDER BY version DESC LIMIT 1
  `).get(), { version: 7, name: migration007.name });
  assert.deepEqual(governanceRow(db, entry.id), {
    knowledge_entry_id: entry.id,
    lineage_root_entry_id: entry.id,
    supersedes_entry_id: null,
    version_no: 1,
    is_current: 1,
    quality_state: 'candidate',
    retention_class: 'protected',
    retain_until: null,
    governance_version: 1,
    reviewed_by: null,
    reviewed_at: null,
    review_reason: null,
    created_at: governanceRow(db, entry.id).created_at,
    updated_at: governanceRow(db, entry.id).updated_at
  });
  const after = db.prepare(`
    SELECT entry.content,entry.content_sha256,chunk.content AS chunk_content,
      chunk.content_sha256 AS chunk_sha256,fts.content AS fts_content
    FROM knowledge_entries entry
    JOIN knowledge_chunks chunk ON chunk.entry_id=entry.id
    JOIN knowledge_chunks_fts fts
      ON CAST(fts.entry_id AS INTEGER)=entry.id
     AND CAST(fts.chunk_id AS INTEGER)=chunk.id
    WHERE entry.id=?
    ORDER BY chunk.chunk_index,chunk.id
    LIMIT 1
  `).get(entry.id);
  assert.deepEqual(after, before);

  const governanceBefore = JSON.stringify(governanceRow(db, entry.id));
  runMigrations(db, MIGRATIONS_V7);
  assert.equal(JSON.stringify(governanceRow(db, entry.id)), governanceBefore);
  db.close();
});

test('new knowledge is a protected candidate and only an administrator can apply reviewed transitions', () => {
  const db = openDatabase();
  const { admin, owner } = identities(db);
  const entry = addKnowledge(db, owner, 'review');
  assert.deepEqual(
    {
      quality: governanceRow(db, entry.id).quality_state,
      retention: governanceRow(db, entry.id).retention_class,
      current: governanceRow(db, entry.id).is_current,
      version: governanceRow(db, entry.id).governance_version
    },
    { quality: 'candidate', retention: 'protected', current: 1, version: 1 }
  );

  assert.throws(
    () => govern(db, owner, entry.id, 'confirm', 1),
    (error) => error && error.statusCode === 403 && error.code === 'KNOWLEDGE_GOVERNANCE_FORBIDDEN'
  );

  const confirmed = govern(db, admin, entry.id, 'confirm', 1);
  assert.equal(confirmed.governance.quality_state, 'confirmed');
  assert.equal(confirmed.governance.governance_version, 2);
  assert.throws(
    () => govern(db, admin, entry.id, 'reject', 1),
    (error) => error && error.statusCode === 409 && error.code === 'KNOWLEDGE_GOVERNANCE_STALE'
  );

  const rejected = govern(db, admin, entry.id, 'reject', 2);
  assert.equal(rejected.governance.quality_state, 'rejected');
  assert.throws(
    () => govern(db, admin, entry.id, 'confirm', 3),
    (error) => error && error.statusCode === 409 && error.code === 'KNOWLEDGE_GOVERNANCE_TRANSITION_INVALID'
  );
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM activity_log
    WHERE module='knowledge_governance' AND action='knowledge_governance_updated'
  `).get().count, 2);
  db.close();
});

test('confirmed knowledge ranks first while rejected, superseded, and expired versions stay out of new search and RAG', () => {
  const db = openDatabase();
  const { admin, owner } = identities(db);
  const candidate = addKnowledge(db, owner, 'candidate', 'governance-contract common');
  const activeCandidate = addKnowledge(db, owner, 'active-candidate', 'governance-contract common');
  const confirmed = addKnowledge(db, owner, 'confirmed', 'governance-contract common');
  const rejected = addKnowledge(db, owner, 'rejected', 'governance-contract common');
  const replacement = addKnowledge(db, owner, 'replacement', 'governance-contract common');
  const expiring = addKnowledge(db, owner, 'expiring', 'governance-contract common');

  govern(db, admin, confirmed.id, 'confirm', 1);
  govern(db, admin, rejected.id, 'reject', 1);
  govern(db, admin, replacement.id, 'confirm', 1);
  govern(db, admin, candidate.id, 'supersede', 1, {
    replacementEntryId: replacement.id
  });
  assert.throws(
    () => govern(db, admin, expiring.id, 'set_retention', 1, {
      retentionClass: 'scheduled',
      retainUntil: '2026-02-30 00:00:00'
    }),
    (error) => error && error.statusCode === 400 && error.code === 'INVALID_KNOWLEDGE_GOVERNANCE_INPUT'
  );
  govern(db, admin, expiring.id, 'set_retention', 1, {
    retentionClass: 'scheduled',
    retainUntil: '2000-01-01 00:00:00'
  });

  const visible = knowledge.searchKnowledge(db, {
    q: 'governance-contract common',
    user: owner,
    limit: 20
  });
  assert.deepEqual(
    visible.slice(0, 2).map((item) => item.id).sort((left, right) => left - right),
    [confirmed.id, replacement.id].sort((left, right) => left - right)
  );
  assert.equal(visible[2].id, activeCandidate.id);
  assert.ok(visible.every((item) => item.governance.is_retrievable === true));

  const all = knowledge.searchKnowledge(db, {
    q: 'governance-contract common',
    user: admin,
    include_inactive: true,
    limit: 20
  });
  assert.equal(all.length, 6);
  assert.equal(all.find((item) => item.id === rejected.id).governance.quality_state, 'rejected');
  assert.equal(all.find((item) => item.id === candidate.id).governance.is_current, false);
  assert.equal(all.find((item) => item.id === expiring.id).governance.is_retrievable, false);

  const context = rag.buildRagContext(db, {
    query: 'governance-contract common',
    user: owner,
    limit: 20
  });
  assert.deepEqual(
    context.references.slice(0, 2).map((reference) => reference.id).sort((left, right) => left - right),
    [confirmed.id, replacement.id].sort((left, right) => left - right)
  );
  assert.equal(context.references[2].id, activeCandidate.id);
  assert.equal(knowledge.isKnowledgeRetrievable(db, rejected.id), false);
  assert.equal(knowledge.isKnowledgeRetrievable(db, confirmed.id), true);
  db.close();
});

test('supersession creates one linear lineage and keeps an inactive version available to historical citation audit', () => {
  const db = openDatabase();
  const { admin, owner } = identities(db);
  const prior = addKnowledge(db, owner, 'prior', 'historical-citation-contract');
  const replacement = addKnowledge(db, owner, 'next', 'historical-citation-contract');
  govern(db, admin, prior.id, 'confirm', 1);
  govern(db, admin, replacement.id, 'confirm', 1);

  const entry = db.prepare(`
    SELECT id,title,entry_type,source_type,visibility,is_public,
      source_identity_sha256,content_sha256
    FROM knowledge_entries WHERE id=?
  `).get(prior.id);
  const chunk = db.prepare(`
    SELECT id,chunk_index,content,content_sha256
    FROM knowledge_chunks WHERE entry_id=? ORDER BY chunk_index,id LIMIT 1
  `).get(prior.id);
  const reference = {
    reference_schema_version: 1,
    reference_type: 'knowledge',
    knowledge_entry_id: prior.id,
    knowledge_chunk_id: chunk.id,
    reference_rank: 1,
    selection_origin: 'retrieved',
    snippet: chunk.content,
    source_identity_sha256: entry.source_identity_sha256,
    entry_content_sha256: entry.content_sha256,
    chunk_content_sha256: chunk.content_sha256
  };

  govern(db, admin, prior.id, 'supersede', 2, {
    replacementEntryId: replacement.id
  });

  const priorGovernance = governanceRow(db, prior.id);
  const replacementGovernance = governanceRow(db, replacement.id);
  assert.equal(priorGovernance.is_current, 0);
  assert.equal(replacementGovernance.is_current, 1);
  assert.equal(replacementGovernance.lineage_root_entry_id, prior.id);
  assert.equal(replacementGovernance.supersedes_entry_id, prior.id);
  assert.equal(replacementGovernance.version_no, 2);

  const historicalBefore = JSON.stringify(priorGovernance);
  const auditCountBefore = db.prepare(`
    SELECT COUNT(*) AS count FROM activity_log
    WHERE module='knowledge_governance' AND action='knowledge_governance_updated'
  `).get().count;
  for (const mutation of [
    () => govern(db, admin, prior.id, 'reject', priorGovernance.governance_version),
    () => govern(db, admin, prior.id, 'set_retention', priorGovernance.governance_version, {
      retentionClass: 'scheduled',
      retainUntil: '2040-01-01 00:00:00'
    })
  ]) {
    assert.throws(
      mutation,
      (error) => error && error.statusCode === 409 && error.code === 'KNOWLEDGE_GOVERNANCE_TRANSITION_INVALID'
    );
  }
  assert.equal(JSON.stringify(governanceRow(db, prior.id)), historicalBefore);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM activity_log
    WHERE module='knowledge_governance' AND action='knowledge_governance_updated'
  `).get().count, auditCountBefore);

  const redacted = knowledge.redactKnowledgeReferences(db, [reference], owner);
  assert.equal(redacted[0].entry_id, prior.id);
  assert.equal(redacted[0].citation_label, 'KB-1');
  assert.equal(redacted[0].access_state, undefined);
  db.close();
});

test('server and administrator client expose the bounded governance contract', () => {
  const serverSource = fs.readFileSync(path.join(SERVER_ROOT, 'server.js'), 'utf8');
  const appSource = fs.readFileSync(path.join(SERVER_ROOT, '..', 'app.js'), 'utf8');
  assert.match(
    serverSource,
    /app\.post\('\/api\/admin\/knowledge\/:id\/governance',\s*authMiddleware,\s*adminOnly/
  );
  assert.match(serverSource, /knowledgeService\.governKnowledgeEntry/);
  assert.match(appSource, /function loadKnowledgeBase\(/);
  assert.match(appSource, /function adminGovernKnowledge\(/);
  assert.match(appSource, /include_inactive=1/);
});

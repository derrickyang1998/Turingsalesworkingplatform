'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
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

function addKnowledge(
  db,
  owner,
  suffix,
  content = 'governance-contract',
  sourceType = 'governance_contract'
) {
  return knowledge.ingestKnowledge(db, {
    title: `Governance ${suffix}`,
    content: `${content} ${suffix}`,
    entry_type: 'methodology',
    source_type: sourceType,
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

function createCampaignKnowledgeFixture(db) {
  const identity = db.prepare(`
    SELECT organization.id AS orgId,user.id AS userId,user.role AS role,
      team_membership.team_id AS teamId
    FROM organizations organization
    JOIN organization_memberships organization_membership
      ON organization_membership.org_id=organization.id
     AND organization_membership.status='active'
    JOIN users user
      ON user.id=organization_membership.user_id AND user.is_active=1
    JOIN team_memberships team_membership
      ON team_membership.org_id=organization.id
     AND team_membership.user_id=user.id
     AND team_membership.status='active'
    WHERE organization.code='turingmarket-default' AND user.role<>'admin'
    ORDER BY user.id,team_membership.team_id
    LIMIT 1
  `).get();
  assert.ok(identity, 'fixture requires an active non-admin organization member');
  const fixture = {
    ...identity,
    customerId: 970401,
    opportunityId: 970402,
    campaignId: 970403
  };
  db.prepare(`
    INSERT INTO customers (
      id,brand_name,company_name,stage,source,created_by,assigned_to,is_public
    ) VALUES (
      @customerId,'Governance RAG contract','Governance RAG contract Ltd',
      'qualified','governance-rag-contract',@userId,@userId,0
    )
  `).run(fixture);
  db.prepare(`
    INSERT INTO opportunities (
      id,customer_id,name,stage,value,win_probability,product_name,channel_type,created_by
    ) VALUES (
      @opportunityId,@customerId,'Governance RAG opportunity','proposal',1000,50,
      'Governance RAG product','influencer',@userId
    )
  `).run(fixture);
  db.prepare(`
    INSERT INTO campaigns (
      id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,
      lifecycle_state,operational_status,row_version
    ) VALUES (
      @campaignId,@orgId,'Governance RAG campaign',@customerId,@opportunityId,
      @userId,@teamId,'lead','active',1
    )
  `).run(fixture);
  fixture.user = { id: fixture.userId, role: fixture.role };
  return fixture;
}

function writeCampaignMethodology(db, fixture, label) {
  let written;
  db.transaction(() => {
    written = knowledge.writeCampaignKnowledgeInTransaction(db, {
      organizationId: fixture.orgId,
      campaignId: fixture.campaignId,
      createdBy: fixture.userId,
      entryType: 'performance_review_methodology',
      sourceType: 'performance_review_methodology',
      sourceId: label,
      title: `Performance methodology ${label}`,
      summary: '',
      content: `confirmed-methodology-token ${label}`,
      tags: ['performance', 'methodology'],
      visibility: 'team',
      metadata: { schema_version: 1 }
    });
    db.prepare(`
      INSERT INTO campaign_record_links (
        org_id,campaign_id,record_type,bundle_id,record_id,relation_type,
        created_by,metadata_json
      ) VALUES (
        @orgId,@campaignId,'knowledge_entry',@bundleId,@recordId,'knowledge',
        @userId,'{}'
      )
    `).run({
      ...fixture,
      recordId: String(written.entry.id),
      bundleId: createHash('sha256')
        .update(`governance-rag:${label}:${written.entry.id}`)
        .digest('hex')
    });
    if (written.capacityGaugePlan) {
      knowledge.applyKnowledgeCapacityGaugePlanInTransaction(db, written.capacityGaugePlan);
    }
  }).immediate();
  return written.entry;
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

test('supported ephemeral knowledge cleanup removes the matching FTS projection', () => {
  const db = openDatabase();
  const { owner } = identities(db);
  const entry = addKnowledge(db, owner, 'fts-delete', 'governance-contract', 'deployment_smoke');
  const chunk = db.prepare('SELECT id FROM knowledge_chunks WHERE entry_id=?').get(entry.id);
  assert.ok(chunk);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM knowledge_chunks_fts
    WHERE CAST(chunk_id AS INTEGER)=?
  `).get(chunk.id).count, 1);

  const result = knowledge.purgeEphemeralKnowledgeEntries(db, {
    entryIds: [entry.id],
    sourceType: 'deployment_smoke',
    sourceIds: ['fts-delete']
  });

  assert.deepEqual(result, { entries: 1, chunks: 1, fts: 1 });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM knowledge_chunks WHERE id=?').get(chunk.id).count, 0);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM knowledge_chunks_fts
    WHERE CAST(chunk_id AS INTEGER)=?
  `).get(chunk.id).count, 0);
  db.close();
});

test('ephemeral cleanup rolls back every projection when a nested delete fails', () => {
  const db = openDatabase();
  const { owner } = identities(db);
  const entry = addKnowledge(db, owner, 'fts-rollback', 'governance-contract', 'deployment_smoke');
  const before = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM knowledge_entries WHERE id=?) AS entries,
      (SELECT COUNT(*) FROM knowledge_entry_governance WHERE knowledge_entry_id=?) AS governance,
      (SELECT COUNT(*) FROM knowledge_chunks WHERE entry_id=?) AS chunks,
      (SELECT COUNT(*) FROM knowledge_chunks_fts
        WHERE CAST(entry_id AS INTEGER)=?) AS fts
  `).get(entry.id, entry.id, entry.id, entry.id);
  db.exec(`
    CREATE TEMP TRIGGER reject_ephemeral_governance_delete
    BEFORE DELETE ON knowledge_entry_governance
    BEGIN
      SELECT RAISE(ABORT, 'injected governance delete failure');
    END
  `);

  db.transaction(function() {
    assert.throws(
      () => knowledge.purgeEphemeralKnowledgeEntries(db, {
        entryIds: [entry.id],
        sourceType: 'deployment_smoke',
        sourceIds: ['fts-rollback']
      }),
      /injected governance delete failure/
    );
  })();

  const after = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM knowledge_entries WHERE id=?) AS entries,
      (SELECT COUNT(*) FROM knowledge_entry_governance WHERE knowledge_entry_id=?) AS governance,
      (SELECT COUNT(*) FROM knowledge_chunks WHERE entry_id=?) AS chunks,
      (SELECT COUNT(*) FROM knowledge_chunks_fts
        WHERE CAST(entry_id AS INTEGER)=?) AS fts
  `).get(entry.id, entry.id, entry.id, entry.id);
  assert.deepEqual(after, before);
  db.prepare(
    "INSERT INTO knowledge_chunks_fts(knowledge_chunks_fts) VALUES('integrity-check')"
  ).run();
  db.close();
});

test('ephemeral cleanup rejects non-smoke knowledge and preserves its complete projection', () => {
  const db = openDatabase();
  const { admin, owner } = identities(db);
  const entry = addKnowledge(db, owner, 'fts-protected');
  govern(db, admin, entry.id, 'confirm', 1);
  const before = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM knowledge_entries WHERE id=?) AS entries,
      (SELECT COUNT(*) FROM knowledge_entry_governance WHERE knowledge_entry_id=?) AS governance,
      (SELECT COUNT(*) FROM knowledge_chunks WHERE entry_id=?) AS chunks,
      (SELECT COUNT(*) FROM knowledge_chunks_fts
        WHERE CAST(entry_id AS INTEGER)=?) AS fts
  `).get(entry.id, entry.id, entry.id, entry.id);

  assert.throws(
    () => knowledge.purgeEphemeralKnowledgeEntries(db, {
      entryIds: [entry.id],
      sourceType: 'governance_contract',
      sourceIds: ['fts-protected']
    }),
    /ephemeral knowledge sourceType is invalid/
  );
  const after = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM knowledge_entries WHERE id=?) AS entries,
      (SELECT COUNT(*) FROM knowledge_entry_governance WHERE knowledge_entry_id=?) AS governance,
      (SELECT COUNT(*) FROM knowledge_chunks WHERE entry_id=?) AS chunks,
      (SELECT COUNT(*) FROM knowledge_chunks_fts
        WHERE CAST(entry_id AS INTEGER)=?) AS fts
  `).get(entry.id, entry.id, entry.id, entry.id);
  assert.deepEqual(after, before);
  db.close();
});

test('deployment smoke cleanup removes a complete reviewed lineage without FTS residue', () => {
  const db = openDatabase();
  const { admin, owner } = identities(db);
  const original = addKnowledge(
    db,
    owner,
    'smoke-original',
    'deployment smoke lineage',
    'deployment_smoke'
  );
  const replacement = addKnowledge(
    db,
    owner,
    'smoke-replacement',
    'deployment smoke lineage',
    'deployment_smoke'
  );
  govern(db, admin, original.id, 'confirm', 1);
  govern(db, admin, replacement.id, 'confirm', 1);
  govern(db, admin, original.id, 'supersede', 2, {
    replacementEntryId: replacement.id
  });

  const result = knowledge.purgeEphemeralKnowledgeEntries(db, {
    entryIds: [original.id, replacement.id],
    sourceType: 'deployment_smoke',
    sourceIds: ['smoke-original', 'smoke-replacement']
  });
  assert.deepEqual(result, { entries: 2, chunks: 2, fts: 2 });
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM knowledge_chunks_fts
    WHERE CAST(entry_id AS INTEGER) IN (?,?)
  `).get(original.id, replacement.id).count, 0);
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

test('campaign RAG restricts performance methodology retrieval to confirmed knowledge', () => {
  const db = openDatabase();
  try {
    const { admin } = identities(db);
    const fixture = createCampaignKnowledgeFixture(db);
    const candidate = writeCampaignMethodology(db, fixture, 'candidate');
    const confirmed = writeCampaignMethodology(db, fixture, 'confirmed');
    govern(db, admin, confirmed.id, 'confirm', 1);

    const results = knowledge.searchCampaignKnowledgeChunks(db, {
      query: 'confirmed-methodology-token',
      user: fixture.user,
      campaignId: fixture.campaignId,
      entry_type: 'performance_review_methodology',
      source_type: 'performance_review_methodology',
      quality_state: 'confirmed',
      business_type: 'campaign',
      business_id: String(fixture.campaignId),
      limit: 10
    });

    assert.deepEqual(
      [...new Set(results.map((item) => item.record.entry.id))],
      [confirmed.id]
    );
    assert.equal(results[0].record.entry.governance.quality_state, 'confirmed');
    assert.notEqual(candidate.id, confirmed.id);
  } finally {
    db.close();
  }
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

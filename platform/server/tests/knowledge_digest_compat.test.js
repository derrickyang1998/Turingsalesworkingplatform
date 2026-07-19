const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const knowledge = require('../services/knowledge_service');
const {
  buildLegacyPopulatedFixture
} = require('./fixtures/legacy_populated_fixture');

const SERVER_ROOT = path.resolve(__dirname, '..');
const MAX_SAFE_ID = 9007199254740991;
const CAMPAIGN_MIGRATION_DESCRIPTOR = Object.freeze({
  version: 2,
  name: '002_campaign_business_spine',
  sourcePath: 'migrations/002_campaign_business_spine.js',
  engineVersion: 1,
  dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
});

function openV2Database() {
  const db = new Database(':memory:');
  migrationService.runMigrations(db, {
    rootDir: SERVER_ROOT,
    registeredMigrations: [CAMPAIGN_MIGRATION_DESCRIPTOR]
  });
  return db;
}

function adminId(db) {
  return db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get().id;
}

function activeUserIds(db) {
  return db.prepare(`
    SELECT id
    FROM users
    WHERE is_active=1
    ORDER BY id
    LIMIT 2
  `).all().map((row) => row.id);
}

function classifyKnowledgeForCampaign(db, entryId, ownerId) {
  const scope = db.prepare(`
    SELECT membership.org_id AS orgId,membership.team_id AS teamId
    FROM team_memberships membership
    WHERE membership.user_id=? AND membership.status='active'
    ORDER BY membership.org_id,membership.team_id
    LIMIT 1
  `).get(ownerId);
  assert.ok(scope);
  db.prepare(`
    INSERT INTO customers (
      id,brand_name,company_name,stage,source,created_by,assigned_to
    ) VALUES (9101,'Knowledge Custody','Knowledge Custody Ltd','qualified','test',?,?)
  `).run(ownerId, ownerId);
  db.prepare(`
    INSERT INTO opportunities (
      id,customer_id,name,stage,value,win_probability,product_name,channel_type,created_by
    ) VALUES (9201,9101,'Knowledge Custody','proposal',1000,50,'Knowledge','influencer',?)
  `).run(ownerId);
  db.prepare(`
    INSERT INTO campaigns (
      id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,
      lifecycle_state,operational_status,row_version
    ) VALUES (9301,?,'Knowledge Custody',9101,9201,?,?,'lead','active',1)
  `).run(scope.orgId, ownerId, scope.teamId);
  db.prepare(`
    INSERT INTO campaign_record_links (
      org_id,campaign_id,record_type,bundle_id,record_id,relation_type,
      created_by,metadata_json
    ) VALUES (?,9301,'knowledge_entry',?,?, 'knowledge',?,'{}')
  `).run(scope.orgId, sha256('knowledge-custody-bundle'), String(entryId), ownerId);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function validScalar(value, label) {
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
  return validScalar(value, label).replace(/\r\n?/g, '\n').normalize('NFC');
}

function frame32(bytes) {
  const payload = Buffer.from(bytes);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  return Buffer.concat([length, payload]);
}

function framedHash(payloads) {
  return sha256(Buffer.concat(payloads.map(frame32)));
}

function typedText(value) {
  return Buffer.concat([Buffer.from([2]), Buffer.from(validScalar(value, 'typed text'), 'utf8')]);
}

function typedInteger(value) {
  assert.ok(Number.isSafeInteger(value) && value > 0);
  return Buffer.concat([Buffer.from([1]), Buffer.from(String(value), 'utf8')]);
}

function typedNullableText(value) {
  return value === null ? Buffer.from([0]) : typedText(value);
}

function typedNullableInteger(value) {
  return value === null ? Buffer.from([0]) : typedInteger(value);
}

function sourceIdentityDigest(entry) {
  let sourceId;
  if (entry.source_id === null) sourceId = Buffer.from([0]);
  else if (typeof entry.source_id === 'number') sourceId = typedInteger(entry.source_id);
  else sourceId = typedText(entry.source_id);
  return framedHash([
    typedText('tm-knowledge-legacy-source-v1'),
    typedInteger(entry.id),
    typedNullableText(entry.entry_type),
    typedNullableText(entry.source_type),
    sourceId,
    typedNullableText(entry.source_hash),
    typedNullableText(entry.business_type),
    typedNullableText(entry.business_id),
    typedNullableInteger(entry.created_by)
  ]);
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function canonicalTags(values) {
  return [...new Set(values.map((value) => canonicalText(value, 'tag')))].sort(compareUtf8);
}

function contentDigest(entry) {
  const tagsJson = JSON.stringify(canonicalTags(entry.tags));
  return framedHash([
    'tm-knowledge-content-v1',
    entry.entry_type,
    canonicalText(entry.title, 'title'),
    canonicalText(entry.summary, 'summary'),
    canonicalText(entry.content, 'content'),
    tagsJson,
    entry.visibility
  ].map((value) => Buffer.from(value, 'utf8')));
}

function frozenSourceHash(input, ownerId) {
  const sourceType = input.source_type || '';
  const sourceId = input.source_id !== undefined && input.source_id !== null
    ? String(input.source_id)
    : '';
  const stableSource = sourceType && sourceId
    ? [
        sourceType,
        sourceId,
        input.business_type || '',
        input.business_id || '',
        ownerId === null ? '' : String(ownerId)
      ].join('|')
    : '';
  const payload = stableSource || [
    input.entry_type || input.type || 'note',
    input.title || '',
    input.content || '',
    ownerId === null ? '' : String(ownerId)
  ].join('|');
  return sha256(Buffer.from(payload, 'utf8'));
}

function readEntryGraph(db, entryId) {
  return {
    entry: db.prepare(`
      SELECT
        id,entry_type,title,summary,source_type,source_id,source_hash,
        business_type,business_id,content,created_by,is_public,tags_json,
        visibility,source_identity_sha256,content_sha256,
        typeof(id) AS id_type,typeof(source_id) AS source_id_type
      FROM knowledge_entries
      WHERE id=?
    `).get(entryId),
    chunks: db.prepare(`
      SELECT
        id,entry_id,chunk_index,content,content_sha256,
        typeof(id) AS id_type,typeof(entry_id) AS entry_id_type,
        typeof(chunk_index) AS chunk_index_type
      FROM knowledge_chunks
      WHERE entry_id=?
      ORDER BY chunk_index,id
    `).all(entryId),
    fts: db.prepare(`
      SELECT title,content,tags,entry_id,chunk_id
      FROM knowledge_chunks_fts
      WHERE entry_id=?
      ORDER BY CAST(chunk_id AS INTEGER),rowid
    `).all(entryId)
  };
}

function mutableState(db) {
  return {
    entries: db.prepare(`
      SELECT id,source_hash,source_identity_sha256,content_sha256
      FROM knowledge_entries
      ORDER BY id
    `).all(),
    chunks: db.prepare(`
      SELECT id,entry_id,chunk_index,content,content_sha256
      FROM knowledge_chunks
      ORDER BY id
    `).all(),
    fts: db.prepare(`
      SELECT title,content,tags,entry_id,chunk_id
      FROM knowledge_chunks_fts
      ORDER BY CAST(chunk_id AS INTEGER),rowid
    `).all(),
    sequence: db.prepare(`
      SELECT seq,typeof(seq) AS seq_type
      FROM sqlite_sequence
      WHERE name='knowledge_entries'
    `).get()
  };
}

test('digest-aware unlinked insert uses explicit ID and exact entry, chunk, and FTS projections', () => {
  const db = openV2Database();
  try {
    const creator = adminId(db);
    const input = {
      entry_type: 'uploaded_document',
      title: 'Cafe\u0301 guide',
      summary: 'Summary\r\nline',
      content: ' Alpha\r\n\r\nBeta \ud83d\ude00 ',
      source_type: 'knowledge_upload',
      source_id: 'brief.csv',
      visibility: 'private',
      tags: ['z', 'e\u0301', '\u00e9', 'a'],
      created_by: creator
    };
    const result = knowledge.ingestKnowledge(db, input);
    const graph = readEntryGraph(db, result.id);
    const expectedTags = ['a', 'z', '\u00e9'];
    const expectedSourceHash = frozenSourceHash(input, creator);

    assert.equal(graph.entry.id_type, 'integer');
    assert.equal(graph.entry.source_id_type, 'text');
    assert.equal(graph.entry.title, 'Caf\u00e9 guide');
    assert.equal(graph.entry.summary, 'Summary\nline');
    assert.equal(graph.entry.content, ' Alpha\n\nBeta \ud83d\ude00 ');
    assert.equal(graph.entry.tags_json, JSON.stringify(expectedTags));
    assert.equal(graph.entry.source_hash, expectedSourceHash);
    assert.equal(
      graph.entry.source_identity_sha256,
      sourceIdentityDigest(graph.entry)
    );
    assert.equal(
      graph.entry.content_sha256,
      contentDigest({
        ...graph.entry,
        tags: expectedTags
      })
    );
    assert.deepEqual(
      graph.chunks.map((row) => ({
        chunk_index: row.chunk_index,
        content: row.content,
        content_sha256: row.content_sha256,
        id_type: row.id_type,
        entry_id_type: row.entry_id_type,
        chunk_index_type: row.chunk_index_type
      })),
      [{
        chunk_index: 0,
        content: 'Alpha\n\nBeta \ud83d\ude00',
        content_sha256: '73a747f2a6e9c5e3e65eb8552d8100319eda2cecae356c8abb7496ecf2fa1b3b',
        id_type: 'integer',
        entry_id_type: 'integer',
        chunk_index_type: 'integer'
      }]
    );
    assert.deepEqual(graph.fts, [{
      title: 'Caf\u00e9 guide',
      content: 'Alpha\n\nBeta \ud83d\ude00',
      tags: 'a z \u00e9',
      entry_id: result.id,
      chunk_id: graph.chunks[0].id
    }]);
    assert.throws(
      () => db.prepare(
        "UPDATE knowledge_entries SET source_identity_sha256=? WHERE id=?"
      ).run('0'.repeat(64), result.id),
      /knowledge source identity is immutable/
    );
  } finally {
    db.close();
  }
});

test('raw CRLF and normalization forms select distinct unlinked rows before canonical persistence', () => {
  const db = openV2Database();
  try {
    const creator = adminId(db);
    const firstInput = {
      entry_type: 'note',
      title: 'Raw identity',
      content: 'Cafe\u0301\r\nLine',
      visibility: 'private',
      created_by: creator
    };
    const secondInput = {
      entry_type: 'note',
      title: 'Raw identity',
      content: 'Caf\u00e9\nLine',
      visibility: 'private',
      created_by: creator
    };
    const first = knowledge.ingestKnowledge(db, firstInput);
    const second = knowledge.ingestKnowledge(db, secondInput);
    const firstGraph = readEntryGraph(db, first.id);
    const secondGraph = readEntryGraph(db, second.id);

    assert.notEqual(first.id, second.id);
    assert.notEqual(firstGraph.entry.source_hash, secondGraph.entry.source_hash);
    assert.equal(firstGraph.entry.content, secondGraph.entry.content);
    assert.equal(firstGraph.entry.content_sha256, secondGraph.entry.content_sha256);
    assert.deepEqual(
      firstGraph.chunks.map((row) => [row.content, row.content_sha256]),
      secondGraph.chunks.map((row) => [row.content, row.content_sha256])
    );
  } finally {
    db.close();
  }
});

test('stable legacy source refresh preserves identity and atomically replaces digests, chunks, and FTS', () => {
  const db = openV2Database();
  try {
    const creator = adminId(db);
    const first = knowledge.ingestKnowledge(db, {
      entry_type: 'note',
      title: 'Stable source',
      content: 'oldterm content',
      source_type: 'manual_upload',
      source_id: 42,
      visibility: 'shared',
      tags: ['old'],
      created_by: creator
    });
    const before = readEntryGraph(db, first.id);
    const second = knowledge.ingestKnowledge(db, {
      entry_type: 'note',
      title: 'Stable source refreshed',
      content: 'newterm content',
      source_type: 'manual_upload',
      source_id: 42,
      visibility: 'shared',
      tags: ['new'],
      created_by: creator
    });
    const after = readEntryGraph(db, second.id);

    assert.equal(second.id, first.id);
    assert.equal(after.entry.source_id_type, 'integer');
    assert.equal(after.entry.visibility, 'shared');
    assert.equal(after.entry.is_public, 1);
    assert.equal(
      after.entry.source_identity_sha256,
      before.entry.source_identity_sha256
    );
    assert.notEqual(after.entry.content_sha256, before.entry.content_sha256);
    assert.deepEqual(after.chunks.map((row) => row.content), ['newterm content']);
    assert.deepEqual(after.fts.map((row) => row.content), ['newterm content']);
    assert.deepEqual(
      db.prepare(`
        SELECT chunk_id
        FROM knowledge_chunks_fts
        WHERE knowledge_chunks_fts MATCH 'oldterm'
      `).all(),
      []
    );
    assert.deepEqual(
      db.prepare(`
        SELECT chunk_id
        FROM knowledge_chunks_fts
        WHERE knowledge_chunks_fts MATCH 'newterm'
      `).all(),
      [{ chunk_id: after.chunks[0].id }]
    );
  } finally {
    db.close();
  }
});

test('trusted source hash refresh cannot mutate immutable source identity fields', () => {
  const db = openV2Database();
  try {
    const creator = adminId(db);
    const sourceHash = 'f'.repeat(64);
    const first = knowledge.ingestKnowledge(db, {
      entry_type: 'note',
      title: 'Trusted source',
      content: 'original content',
      source_type: 'manual_upload',
      source_id: 'alpha.txt',
      source_hash: sourceHash,
      allow_source_hash: true,
      business_type: 'customer',
      business_id: '1',
      visibility: 'private',
      created_by: creator
    });
    const before = mutableState(db);

    assert.throws(
      () => knowledge.ingestKnowledge(db, {
        entry_type: 'uploaded_document',
        title: 'Trusted source changed',
        content: 'must not replace identity',
        source_type: 'knowledge_upload',
        source_id: 'beta.txt',
        source_hash: sourceHash,
        allow_source_hash: true,
        business_type: 'proposal',
        business_id: '2',
        visibility: 'private',
        created_by: creator
      }),
      /source identity|identity.*mismatch|immutable/i
    );
    assert.deepEqual(mutableState(db), before);
    assert.equal(
      readEntryGraph(db, first.id).entry.source_identity_sha256,
      before.entries.find((entry) => entry.id === first.id).source_identity_sha256
    );
  } finally {
    db.close();
  }
});

test('admin refresh preserves the immutable owner of another users unlinked shared source', () => {
  const db = openV2Database();
  try {
    const administrator = adminId(db);
    const owner = activeUserIds(db).find((id) => id !== administrator);
    assert.ok(owner);
    const input = {
      entry_type: 'note',
      title: 'Delegated refresh',
      content: 'owner content',
      source_type: 'manual_upload',
      source_id: 'delegated.txt',
      visibility: 'team'
    };
    const first = knowledge.ingestKnowledge(db, {
      ...input,
      created_by: owner
    });
    const refreshed = knowledge.ingestKnowledge(db, {
      ...input,
      title: 'Delegated refresh by admin',
      content: 'administrator refreshed content',
      created_by: administrator,
      actor_role: 'admin'
    });
    const stored = readEntryGraph(db, refreshed.id).entry;

    assert.equal(refreshed.id, first.id);
    assert.equal(stored.created_by, owner);
    assert.equal(stored.title, 'Delegated refresh by admin');
    assert.equal(stored.content, 'administrator refreshed content');
    assert.equal(stored.source_identity_sha256, sourceIdentityDigest(stored));
  } finally {
    db.close();
  }
});

test('managed-v1 explicit null business_id text remains refresh-compatible after v2 upgrade', () => {
  const db = new Database(':memory:');
  try {
    buildLegacyPopulatedFixture(db);
    db.prepare(`
      UPDATE knowledge_entries
      SET business_id='null'
      WHERE id=9
    `).run();
    migrationService.runMigrations(db, {
      rootDir: SERVER_ROOT,
      registeredMigrations: [CAMPAIGN_MIGRATION_DESCRIPTOR]
    });

    const refreshed = knowledge.ingestKnowledge(db, {
      entry_type: 'note',
      title: 'Shared response refreshed',
      content: 'legacy explicit null business id refreshed',
      source_type: 'manual_note',
      source_id: 'shared-note.txt',
      source_hash: 'fixture-shared-source-hash',
      allow_source_hash: true,
      business_id: null,
      visibility: 'shared',
      created_by: 2
    });
    const stored = db.prepare(`
      SELECT
        id,business_id,typeof(business_id) AS business_id_type,
        content,source_identity_sha256
      FROM knowledge_entries
      WHERE id=?
    `).get(refreshed.id);

    assert.equal(refreshed.id, 9);
    assert.equal(stored.business_id, 'null');
    assert.equal(stored.business_id_type, 'text');
    assert.equal(stored.content, 'legacy explicit null business id refreshed');
    assert.equal(stored.source_identity_sha256, sourceIdentityDigest({
      ...readEntryGraph(db, refreshed.id).entry,
      business_id: 'null'
    }));
  } finally {
    db.close();
  }
});

test('migrated nullable and empty legacy identities refresh without rewriting source identity', () => {
  const db = new Database(':memory:');
  try {
    buildLegacyPopulatedFixture(db);
    db.prepare(`
      UPDATE knowledge_entries
      SET entry_type='',source_type=NULL,business_type=''
      WHERE id=7
    `).run();
    db.prepare(`
      UPDATE knowledge_entries
      SET entry_type=NULL,source_type='',business_type=NULL
      WHERE id=9
    `).run();
    migrationService.runMigrations(db, {
      rootDir: SERVER_ROOT,
      registeredMigrations: [CAMPAIGN_MIGRATION_DESCRIPTOR]
    });

    const admin = adminId(db);
    const emptyBefore = readEntryGraph(db, 7);
    const nullBefore = readEntryGraph(db, 9);
    const emptyRefresh = knowledge.ingestKnowledge(db, {
      entry_type: 'note',
      title: 'Empty legacy identity refreshed',
      content: 'empty legacy identity refreshed content',
      source_id: 42,
      source_hash: 'legacy|hash',
      allow_source_hash: true,
      business_id: '9',
      visibility: 'private',
      created_by: admin,
      actor_role: 'admin',
      tags: ['empty-refresh']
    });
    const nullRefresh = knowledge.ingestKnowledge(db, {
      entry_type: 'note',
      title: 'Null legacy identity refreshed',
      content: 'null legacy identity refreshed content',
      source_type: '',
      source_id: 'shared-note.txt',
      source_hash: 'fixture-shared-source-hash',
      allow_source_hash: true,
      business_type: '',
      visibility: 'shared',
      created_by: 2,
      tags: ['null-refresh']
    });
    const emptyAfter = readEntryGraph(db, emptyRefresh.id);
    const nullAfter = readEntryGraph(db, nullRefresh.id);

    assert.equal(emptyRefresh.id, 7);
    assert.equal(nullRefresh.id, 9);
    assert.deepEqual(
      {
        entry_type: emptyAfter.entry.entry_type,
        source_type: emptyAfter.entry.source_type,
        business_type: emptyAfter.entry.business_type
      },
      { entry_type: '', source_type: null, business_type: '' }
    );
    assert.deepEqual(
      {
        entry_type: nullAfter.entry.entry_type,
        source_type: nullAfter.entry.source_type,
        business_type: nullAfter.entry.business_type
      },
      { entry_type: null, source_type: '', business_type: null }
    );
    assert.equal(
      emptyAfter.entry.source_identity_sha256,
      emptyBefore.entry.source_identity_sha256
    );
    assert.equal(
      nullAfter.entry.source_identity_sha256,
      nullBefore.entry.source_identity_sha256
    );
    assert.equal(
      emptyAfter.entry.content_sha256,
      contentDigest({
        ...emptyAfter.entry,
        entry_type: '',
        tags: ['empty-refresh']
      })
    );
    assert.equal(
      nullAfter.entry.content_sha256,
      contentDigest({
        ...nullAfter.entry,
        entry_type: 'note',
        tags: ['null-refresh']
      })
    );
    assert.deepEqual(
      emptyAfter.chunks.map((row) => row.content),
      ['empty legacy identity refreshed content']
    );
    assert.deepEqual(
      nullAfter.fts.map((row) => row.content),
      ['null legacy identity refreshed content']
    );
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db.close();
  }
});

test('campaign-classified shared knowledge cannot re-enter legacy source reuse', () => {
  const db = openV2Database();
  try {
    const [ownerId, otherUserId] = activeUserIds(db);
    assert.ok(ownerId && otherUserId && ownerId !== otherUserId);
    const input = {
      entry_type: 'note',
      title: 'Classified source',
      content: 'campaign-only classified content',
      source_type: 'manual_upload',
      source_id: 'classified.txt',
      visibility: 'team'
    };
    const entry = knowledge.ingestKnowledge(db, { ...input, created_by: ownerId });
    classifyKnowledgeForCampaign(db, entry.id, ownerId);

    assert.throws(
      () => knowledge.ingestKnowledge(db, {
        ...input,
        title: 'Cross-user retry',
        content: 'must not return classified content',
        created_by: otherUserId
      }),
      /campaign-aware custody|campaign.*custody|classified/i
    );
    assert.equal(
      db.prepare('SELECT content FROM knowledge_entries WHERE id=?').get(entry.id).content,
      'campaign-only classified content'
    );
  } finally {
    db.close();
  }
});

test('ambiguous NUL-terminated numeric source id is rejected before digest-aware insert', () => {
  const db = openV2Database();
  try {
    const before = mutableState(db);
    assert.throws(
      () => knowledge.ingestKnowledge(db, {
        title: 'Ambiguous source id',
        content: 'must not persist',
        source_type: 'manual_upload',
        source_id: '1\u0000',
        created_by: adminId(db)
      }),
      /source_id|NUL|control|ambiguous/i
    );
    assert.deepEqual(mutableState(db), before);
  } finally {
    db.close();
  }
});

test('private source hash preserves the frozen raw owner representation', () => {
  const db = openV2Database();
  try {
    const creator = adminId(db);
    const rawCreator = String(creator).padStart(2, '0');
    assert.notEqual(rawCreator, String(creator));
    const input = {
      entry_type: 'note',
      title: 'Raw owner hash',
      content: 'owner representation canary',
      source_type: 'manual_upload',
      source_id: 'owner-canary.txt',
      visibility: 'private',
      created_by: rawCreator
    };
    const entry = knowledge.ingestKnowledge(db, input);
    const stored = readEntryGraph(db, entry.id).entry;

    assert.equal(stored.created_by, creator);
    assert.equal(stored.source_hash, frozenSourceHash(input, rawCreator));
    assert.notEqual(stored.source_hash, frozenSourceHash(input, creator));
  } finally {
    db.close();
  }
});

test('explicit invalid creator identities are rejected before any knowledge mutation', () => {
  const db = openV2Database();
  try {
    const before = mutableState(db);
    for (const createdBy of [0, '', false, true]) {
      assert.throws(
        () => knowledge.ingestKnowledge(db, {
          entry_type: 'note',
          title: 'Invalid creator identity',
          content: 'must not persist',
          source_type: 'manual_upload',
          source_id: `invalid-owner-${String(createdBy)}.txt`,
          visibility: 'private',
          created_by: createdBy
        }),
        /created_by|positive JavaScript-safe integer/i
      );
      assert.deepEqual(mutableState(db), before);
    }
  } finally {
    db.close();
  }
});

test('default title compaction preserves complete Unicode scalars at the boundary', () => {
  const db = openV2Database();
  try {
    const content = 'a'.repeat(78) + '\ud83d\ude00' + 'z';
    const entry = knowledge.ingestKnowledge(db, {
      content,
      created_by: adminId(db)
    });
    const stored = readEntryGraph(db, entry.id).entry;

    assert.equal(stored.title, content);
    assert.equal(Array.from(stored.title).length, 80);
    assert.equal(stored.content, content);
  } finally {
    db.close();
  }
});

test('chunking uses Unicode scalar limits and frozen empty and 1201-scalar vectors', () => {
  assert.deepEqual(knowledge.makeChunks(''), ['']);
  assert.deepEqual(knowledge.makeChunks('\ud83d\ude00'.repeat(1200)), ['\ud83d\ude00'.repeat(1200)]);
  assert.deepEqual(
    knowledge.makeChunks('a'.repeat(1201)),
    ['a'.repeat(1200), 'a']
  );
  assert.deepEqual(
    knowledge.makeChunks('a'.repeat(1201)).map((chunk) => sha256(Buffer.from(chunk, 'utf8'))),
    [
      '4d21dde662555b99cb697061c3b5041108dedb8825a4bc5858737afbf640e492',
      'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb'
    ]
  );
  assert.equal(
    sha256(Buffer.from(knowledge.makeChunks('')[0], 'utf8')),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  );
});

test('explicit allocator honors sequence and max bounds and fails closed at exhaustion', () => {
  const db = openV2Database();
  try {
    const creator = adminId(db);
    const first = knowledge.ingestKnowledge(db, {
      title: 'Allocator one',
      content: 'allocator one',
      created_by: creator
    });
    db.prepare(`
      UPDATE sqlite_sequence
      SET seq=40
      WHERE name='knowledge_entries'
    `).run();
    const sequenceAhead = knowledge.ingestKnowledge(db, {
      title: 'Allocator two',
      content: 'allocator two',
      created_by: creator
    });
    assert.equal(sequenceAhead.id, 41);

    db.prepare(`
      UPDATE sqlite_sequence
      SET seq=?
      WHERE name='knowledge_entries'
    `).run(first.id);
    const maxAhead = knowledge.ingestKnowledge(db, {
      title: 'Allocator three',
      content: 'allocator three',
      created_by: creator
    });
    assert.equal(maxAhead.id, 42);

    db.prepare(`
      UPDATE sqlite_sequence
      SET seq=?
      WHERE name='knowledge_entries'
    `).run(MAX_SAFE_ID);
    const before = mutableState(db);
    assert.throws(
      () => knowledge.ingestKnowledge(db, {
        title: 'Allocator exhausted',
        content: 'must not persist',
        created_by: creator
      }),
      /identifier capacity|previous_id|exhaust/i
    );
    assert.deepEqual(mutableState(db), before);
  } finally {
    db.close();
  }
});

test('injected chunk failure rolls back entry, chunks, FTS, and sqlite_sequence together', () => {
  const db = openV2Database();
  try {
    const creator = adminId(db);
    knowledge.ingestKnowledge(db, {
      title: 'Rollback baseline',
      content: 'baseline content',
      created_by: creator
    });
    db.exec(`
      CREATE TRIGGER test_fail_knowledge_chunk_insert
      BEFORE INSERT ON knowledge_chunks
      BEGIN
        SELECT RAISE(ABORT,'injected knowledge chunk failure');
      END
    `);
    const before = mutableState(db);

    assert.throws(
      () => knowledge.ingestKnowledge(db, {
        title: 'Rollback candidate',
        content: 'candidate content',
        created_by: creator
      }),
      /injected knowledge chunk failure/
    );
    assert.deepEqual(mutableState(db), before);
  } finally {
    db.close();
  }
});

test('invalid scalar input is rejected before any digest-aware write', () => {
  const db = openV2Database();
  try {
    const creator = adminId(db);
    const before = mutableState(db);
    assert.throws(
      () => knowledge.ingestKnowledge(db, {
        title: 'Invalid scalar',
        content: '\ud800',
        created_by: creator
      }),
      /surrogate|scalar|Unicode/i
    );
    assert.deepEqual(mutableState(db), before);
  } finally {
    db.close();
  }
});

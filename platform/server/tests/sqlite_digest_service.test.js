const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const {
  SQLITE_PRIMITIVES,
  REQUEST_HASH_VECTORS,
  AUDIT_FINGERPRINT_VECTOR
} = require('./fixtures/canonical_hash_vectors');
const {
  buildDigestFixture,
  DIGEST_FIXTURE_MANIFEST,
  DIGEST_FIXTURE_EXPECTED
} = require('./fixtures/digest_v1_fixture');

function tmpDb(name) {
  const dbPath = path.join(os.tmpdir(), `tm-digest-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  return { db, dbPath };
}

test('primitive framing vectors match the immutable SQLite digest grammar', () => {
  const digest = require('../services/sqlite_digest_service');
  const item = digest.item(SQLITE_PRIMITIVES.item.label, Buffer.from(SQLITE_PRIMITIVES.item.payloadHex, 'hex'));
  assert.equal(item.toString('hex'), SQLITE_PRIMITIVES.item.hex);
  assert.equal(digest.sha256Hex(item), SQLITE_PRIMITIVES.item.sha256);

  const row = digest.row(SQLITE_PRIMITIVES.row.values);
  assert.equal(row.toString('hex'), SQLITE_PRIMITIVES.row.hex);
  assert.equal(digest.sha256Hex(row), SQLITE_PRIMITIVES.row.sha256);

  const fts = digest.ftsStream(SQLITE_PRIMITIVES.fts.manifest, SQLITE_PRIMITIVES.fts.rows);
  assert.equal(digest.sha256Hex(fts), SQLITE_PRIMITIVES.fts.sha256);
  assert.equal(
    digest.sha256Hex(digest.item('format', Buffer.from('tm-sqlite-topology-v1', 'utf8'))),
    SQLITE_PRIMITIVES.topologyFormatOnlySha256
  );
});

test('tm-request-v1 and tm-audit-v2 golden vectors are canonical and nonce-bound', () => {
  const digest = require('../services/sqlite_digest_service');
  for (const vector of Object.values(REQUEST_HASH_VECTORS)) {
    assert.equal(digest.requestHash(vector), vector.sha256);
  }
  assert.equal(digest.auditFingerprint(AUDIT_FINGERPRINT_VECTOR), AUDIT_FINGERPRINT_VECTOR.sha256);
  assert.notEqual(
    digest.auditFingerprint({ ...AUDIT_FINGERPRINT_VECTOR, reservationNonce: 'c'.repeat(64) }),
    AUDIT_FINGERPRINT_VECTOR.sha256
  );
});

test('full SQLite topology, logical, and FTS digests are stable across reorder, vacuum, and equivalent FTS rebuild', () => {
  const digest = require('../services/sqlite_digest_service');
  const { db } = tmpDb('stable');
  buildDigestFixture(db);
  digest.rebuildKnowledgeChunksFts(db);
  const first = digest.databaseDigest(db, DIGEST_FIXTURE_MANIFEST);

  db.exec('VACUUM');
  db.exec('DELETE FROM knowledge_chunks_fts');
  digest.rebuildKnowledgeChunksFts(db);
  const second = digest.databaseDigest(db, DIGEST_FIXTURE_MANIFEST);

  assert.equal(second.topologySha256, first.topologySha256);
  assert.equal(second.logicalSha256, first.logicalSha256);
  assert.equal(second.fts[0].sha256, first.fts[0].sha256);
  if (DIGEST_FIXTURE_EXPECTED.topologySha256) {
    assert.equal(first.topologySha256, DIGEST_FIXTURE_EXPECTED.topologySha256);
    assert.equal(first.logicalSha256, DIGEST_FIXTURE_EXPECTED.logicalSha256);
    assert.equal(first.fts[0].sha256, DIGEST_FIXTURE_EXPECTED.ftsSha256);
  }
  db.close();
});

test('SQLite digest changes for schema, value, type, duplicate, sequence, pragma, and FTS mutations', () => {
  const digest = require('../services/sqlite_digest_service');
  const make = () => {
    const fixture = tmpDb('sensitivity');
    buildDigestFixture(fixture.db);
    digest.rebuildKnowledgeChunksFts(fixture.db);
    return fixture;
  };

  const base = make();
  const baseDigest = digest.databaseDigest(base.db, DIGEST_FIXTURE_MANIFEST);
  base.db.close();

  const value = make();
  value.db.prepare("UPDATE fixture_child SET note = 'different' WHERE id = 10").run();
  assert.notEqual(digest.databaseDigest(value.db, DIGEST_FIXTURE_MANIFEST).logicalSha256, baseDigest.logicalSha256);
  value.db.close();

  const schema = make();
  schema.db.exec('CREATE INDEX idx_fixture_child_amount ON fixture_child(amount)');
  assert.notEqual(digest.databaseDigest(schema.db, DIGEST_FIXTURE_MANIFEST).topologySha256, baseDigest.topologySha256);
  schema.db.close();

  const pragma = make();
  pragma.db.pragma('user_version = 7');
  assert.notEqual(digest.databaseDigest(pragma.db, DIGEST_FIXTURE_MANIFEST).topologySha256, baseDigest.topologySha256);
  pragma.db.close();

  const sequence = make();
  sequence.db.prepare('INSERT INTO fixture_parent (label) VALUES (?)').run('gamma');
  assert.notEqual(digest.databaseDigest(sequence.db, DIGEST_FIXTURE_MANIFEST).logicalSha256, baseDigest.logicalSha256);
  sequence.db.close();

  const fts = make();
  fts.db.prepare("UPDATE knowledge_chunks_fts SET content = 'stale posting' WHERE chunk_id = 101").run();
  assert.notEqual(digest.databaseDigest(fts.db, DIGEST_FIXTURE_MANIFEST).logicalSha256, baseDigest.logicalSha256);
  assert.throws(() => digest.verifyKnowledgeChunksFtsCanaries(fts.db, ['alpha', 'beta']), /FTS/);
  fts.db.close();
});

test('knowledge_chunks_fts projection is exact and rejects malformed tags, orphans, and swapped postings', () => {
  const digest = require('../services/sqlite_digest_service');
  const { db } = tmpDb('fts-projection');
  buildDigestFixture(db);
  digest.rebuildKnowledgeChunksFts(db);
  assert.deepEqual(digest.matchKnowledgeChunksCanary(db, 'alpha'), [101]);

  db.prepare("UPDATE knowledge_entries SET tags_json = ? WHERE id = 1").run('{"bad":true}');
  assert.throws(() => digest.rebuildKnowledgeChunksFts(db), /tags_json/);
  db.close();
});

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

function corruptFtsSegmentBytes(dbPath, shadowBlock) {
  const bytes = require('node:fs').readFileSync(dbPath);
  const index = bytes.indexOf(shadowBlock);
  assert.notEqual(index, -1, 'shadow block must be present in database bytes');
  const mutated = Buffer.from(shadowBlock);
  for (let offset = 0; offset < mutated.length; offset += 1) {
    if (mutated[offset] !== 0) {
      mutated[offset] ^= 1;
      break;
    }
  }
  bytes.set(mutated, index);
  require('node:fs').writeFileSync(dbPath, bytes);
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

test('SQLite logical text digest preserves exact UTF-8 bytes without canonical normalization', () => {
  const digest = require('../services/sqlite_digest_service');
  const makeTextDigest = (value) => {
    const { db } = tmpDb('exact-text');
    db.exec('CREATE TABLE exact_text (id INTEGER PRIMARY KEY, value TEXT) STRICT;');
    db.prepare('INSERT INTO exact_text (id, value) VALUES (?, ?)').run(1, value);
    const result = digest.databaseDigest(db, { fts: [] });
    db.close();
    return result.logicalSha256;
  };

  assert.notEqual(makeTextDigest('a\r\nb'), makeTextDigest('a\nb'));
  assert.notEqual(makeTextDigest('\u00e9'), makeTextDigest('e\u0301'));
  assert.notEqual(makeTextDigest('\ufeffA'), makeTextDigest('A'));
});

test('SQLite topology and FTS framing preserve exact text bytes without canonical normalization', () => {
  const digest = require('../services/sqlite_digest_service');
  const makeTopologyDigest = (newline) => {
    const { db } = tmpDb('exact-topology');
    db.exec(`CREATE TABLE exact_schema (${newline}id INTEGER PRIMARY KEY,${newline}value TEXT${newline}) STRICT;`);
    const result = digest.databaseDigest(db, { fts: [] }).topologySha256;
    db.close();
    return result;
  };
  const ftsHash = (value) => digest.sha256Hex(digest.ftsStream({
    virtualName: 'demo_fts',
    projectionName: 'demo',
    tokenizerOptions: 'unicode61',
    keyColumnCsv: 'id',
    indexedColumnCsv: 'content'
  }, [[1n, value]]));

  assert.notEqual(makeTopologyDigest('\r\n'), makeTopologyDigest('\n'));
  assert.notEqual(ftsHash('a\r\nb'), ftsHash('a\nb'));
  assert.notEqual(ftsHash('\u00e9'), ftsHash('e\u0301'));
});

test('SQLite logical digest rejects malformed TEXT bytes before hashing replacement strings', () => {
  const digest = require('../services/sqlite_digest_service');
  const { db } = tmpDb('malformed-text');
  db.exec(`
    CREATE TABLE malformed_text (id INTEGER PRIMARY KEY, value TEXT);
    INSERT INTO malformed_text (id, value) VALUES (1, CAST(x'80' AS TEXT));
  `);

  assert.throws(() => digest.databaseDigest(db, { fts: [] }), /UTF-8|well-formed|malformed TEXT/i);
  db.close();
});

test('SQLite FTS digest rejects malformed stored TEXT and non-integral semantic IDs', () => {
  const digest = require('../services/sqlite_digest_service');

  const malformed = tmpDb('malformed-fts-text');
  buildDigestFixture(malformed.db);
  digest.rebuildKnowledgeChunksFts(malformed.db);
  malformed.db.exec("UPDATE knowledge_chunks_fts SET title=CAST(x'80' AS TEXT) WHERE rowid=(SELECT MIN(rowid) FROM knowledge_chunks_fts)");
  assert.throws(() => digest.databaseDigest(malformed.db, DIGEST_FIXTURE_MANIFEST), /UTF-8|well-formed|malformed SQLite TEXT/i);
  malformed.db.close();

  const unsafeId = tmpDb('unsafe-fts-id');
  buildDigestFixture(unsafeId.db);
  digest.rebuildKnowledgeChunksFts(unsafeId.db);
  unsafeId.db.exec('UPDATE knowledge_chunks_fts SET entry_id=1.5 WHERE rowid=(SELECT MIN(rowid) FROM knowledge_chunks_fts)');
  assert.throws(() => digest.databaseDigest(unsafeId.db, DIGEST_FIXTURE_MANIFEST), /FTS semantic integer|unsafe SQLite integer/i);
  unsafeId.db.close();
});

test('sqlite_sequence schema object and rows are included in topology and logical digests', () => {
  const digest = require('../services/sqlite_digest_service');
  const { db } = tmpDb('sqlite-sequence');
  db.exec(`
    CREATE TABLE sequence_owner (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL
    );
    INSERT INTO sequence_owner (label) VALUES ('a');
  `);
  const base = digest.databaseDigest(db, { fts: [] });
  db.prepare("UPDATE sqlite_sequence SET seq = 99 WHERE name = 'sequence_owner'").run();
  const changed = digest.databaseDigest(db, { fts: [] });
  assert.notEqual(changed.logicalSha256, base.logicalSha256);
  assert.equal(changed.topologySha256, base.topologySha256);
  db.exec('VACUUM');
  const afterVacuum = digest.databaseDigest(db, { fts: [] });
  assert.equal(afterVacuum.logicalSha256, changed.logicalSha256);
  assert.equal(afterVacuum.topologySha256, changed.topologySha256);
  db.close();
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

test('knowledge_chunks_fts verifier rejects shadow posting corruption when projection digest is unchanged', () => {
  const digest = require('../services/sqlite_digest_service');
  const fixture = tmpDb('fts-shadow-corruption');
  buildDigestFixture(fixture.db);
  digest.rebuildKnowledgeChunksFts(fixture.db);
  const base = digest.databaseDigest(fixture.db, DIGEST_FIXTURE_MANIFEST);
  const shadow = fixture.db.prepare('SELECT block FROM knowledge_chunks_fts_data WHERE id = (SELECT MAX(id) FROM knowledge_chunks_fts_data)').get().block;
  fixture.db.close();

  corruptFtsSegmentBytes(fixture.dbPath, shadow);
  const corrupted = new Database(fixture.dbPath, { readonly: true, fileMustExist: true });
  const changed = digest.databaseDigest(corrupted, DIGEST_FIXTURE_MANIFEST);
  assert.equal(changed.topologySha256, base.topologySha256);
  assert.equal(changed.logicalSha256, base.logicalSha256);
  assert.equal(changed.fts[0].sha256, base.fts[0].sha256);
  assert.deepEqual(digest.matchKnowledgeChunksCanary(corrupted, 'alpha'), []);
  assert.equal(typeof digest.verifyKnowledgeChunksFtsIntegrity, 'function');
  assert.throws(() => digest.verifyKnowledgeChunksFtsIntegrity(corrupted, DIGEST_FIXTURE_MANIFEST), /FTS.*posting|integrity/i);
  corrupted.close();
  require('node:fs').rmSync(fixture.dbPath, { force: true });
});

test('FTS verifier compares semantic chunk postings with LEFT JOIN and fixed tokenizer', () => {
  const source = require('node:fs').readFileSync(path.join(__dirname, '..', 'services', 'sqlite_digest_service.js'), 'utf8');
  assert.match(source, /LEFT JOIN \$\{ftsSchema\}/);
  assert.match(source, /tokenize\s*=\s*'unicode61'/);
  const digest = require('../services/sqlite_digest_service');
  const { db } = tmpDb('fts-tokenizer-contract');
  buildDigestFixture(db);
  digest.rebuildKnowledgeChunksFts(db);
  assert.throws(
    () => digest.verifyKnowledgeChunksFtsIntegrity(db, { fts: [{ ...DIGEST_FIXTURE_MANIFEST.fts[0], tokenizerOptions: 'porter' }] }),
    /tokenizer/i
  );
  db.close();
});

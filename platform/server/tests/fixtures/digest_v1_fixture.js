function buildDigestFixture(db) {
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE fixture_parent (
      id INTEGER PRIMARY KEY,
      label TEXT NOT NULL
    );
    CREATE TABLE fixture_child (
      id INTEGER PRIMARY KEY,
      parent_id INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      note TEXT,
      payload BLOB,
      ratio REAL,
      FOREIGN KEY (parent_id) REFERENCES fixture_parent(id)
    );
    CREATE TABLE knowledge_entries (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      tags_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE knowledge_chunks (
      id INTEGER PRIMARY KEY,
      entry_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      FOREIGN KEY (entry_id) REFERENCES knowledge_entries(id)
    );
    CREATE VIRTUAL TABLE knowledge_chunks_fts USING fts5(
      title,
      content,
      tags,
      entry_id UNINDEXED,
      chunk_id UNINDEXED
    );
  `);
  db.prepare('INSERT INTO fixture_parent (id, label) VALUES (?, ?)').run(1, 'alpha');
  db.prepare('INSERT INTO fixture_parent (id, label) VALUES (?, ?)').run(2, 'beta');
  db.prepare('INSERT INTO fixture_child (id, parent_id, amount, note, payload, ratio) VALUES (?, ?, ?, ?, ?, ?)').run(
    10,
    1,
    42,
    'same',
    Buffer.from('00ff', 'hex'),
    -0
  );
  db.prepare('INSERT INTO fixture_child (id, parent_id, amount, note, payload, ratio) VALUES (?, ?, ?, ?, ?, ?)').run(
    11,
    2,
    7,
    null,
    Buffer.from('abcd', 'hex'),
    1.5
  );
  db.prepare('INSERT INTO knowledge_entries (id, title, tags_json) VALUES (?, ?, ?)').run(1, 'Launch Alpha', '["campaign","alpha","alpha"]');
  db.prepare('INSERT INTO knowledge_entries (id, title, tags_json) VALUES (?, ?, ?)').run(2, 'Launch Beta', '["beta"]');
  db.prepare('INSERT INTO knowledge_chunks (id, entry_id, chunk_index, content) VALUES (?, ?, ?, ?)').run(101, 1, 0, 'alpha canary');
  db.prepare('INSERT INTO knowledge_chunks (id, entry_id, chunk_index, content) VALUES (?, ?, ?, ?)').run(102, 2, 0, 'beta canary');
}

const DIGEST_FIXTURE_MANIFEST = {
  fts: [
    {
      virtualName: 'knowledge_chunks_fts',
      projectionName: 'knowledge_chunks_v1',
      tokenizerOptions: 'unicode61',
      keyColumnCsv: 'entry_id,chunk_id',
      indexedColumnCsv: 'title,content,tags'
    }
  ]
};

const DIGEST_FIXTURE_EXPECTED = {
  topologySha256: '510ffa6400c39b67dd500471b4ad1e1452ec96e7597a4f8189ef298dc9eb6c07',
  logicalSha256: '538c0cc87f535ba7a1e78175edd90891c92a6361ea3fccc6f9887e2d06055639',
  ftsSha256: '2420ff67d82f26017d11c88c3697ba21fb39c36fe2b610390e03473679a6231e'
};

module.exports = {
  buildDigestFixture,
  DIGEST_FIXTURE_MANIFEST,
  DIGEST_FIXTURE_EXPECTED
};

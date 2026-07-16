const crypto = require('crypto');

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function u16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value);
  return buffer;
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

function u64(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(value));
  return buffer;
}

function i64(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigInt64BE(BigInt(value));
  return buffer;
}

function utf8(value) {
  return Buffer.from(String(value).normalize('NFC').replace(/\r\n?/g, '\n'), 'utf8');
}

function item(label, payload) {
  const labelBytes = Buffer.from(label, 'utf8');
  const payloadBytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
  return Buffer.concat([u16(labelBytes.length), labelBytes, u64(payloadBytes.length), payloadBytes]);
}

function record(body) {
  return Buffer.concat([u64(body.length), body]);
}

function encodeNumber(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeDoubleBE(value);
  return buffer;
}

function valueBytes(value) {
  if (value === null || value === undefined) return Buffer.from('N');
  if (typeof value === 'bigint') return Buffer.concat([Buffer.from('I'), i64(value)]);
  if (typeof value === 'number') {
    if (Number.isInteger(value) && !Object.is(value, -0)) return Buffer.concat([Buffer.from('I'), i64(BigInt(value))]);
    if (!Number.isFinite(value)) throw new Error('non-finite SQLite REAL');
    return Buffer.concat([Buffer.from('R'), encodeNumber(value)]);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from('B'), u64(value.length), value]);
  const text = utf8(value);
  return Buffer.concat([Buffer.from('T'), u64(text.length), text]);
}

function row(values) {
  const body = Buffer.concat([u64(values.length), ...values.map(valueBytes)]);
  return record(body);
}

function list(records) {
  return Buffer.concat([u64(records.length), ...records.map((body) => record(body))]);
}

function sha256Item(label, payload) {
  return sha256Hex(item(label, payload));
}

function ftsStream(manifest, rows) {
  const manifestRow = row([
    manifest.virtualName,
    manifest.projectionName,
    manifest.tokenizerOptions,
    manifest.keyColumnCsv,
    manifest.indexedColumnCsv
  ]);
  const rowRecords = rows.map((values) => row(values).subarray(8)).sort(Buffer.compare);
  return Buffer.concat([
    item('format', Buffer.from('tm-fts-logical-v1', 'utf8')),
    item('manifest', manifestRow),
    item('rows', list(rowRecords))
  ]);
}

function frame32(bytes) {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return Buffer.concat([u32(data.length), data]);
}

function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite JSON number');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value.normalize('NFC').replace(/\r\n?/g, '\n'));
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value).sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
}

function canonicalPath(inputPath) {
  return inputPath
    .split('/')
    .map((segment) => encodeURIComponent(decodeURIComponent(segment)).replace(/[!'()*]/g, (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase()))
    .join('/');
}

function multipartPayload(parts) {
  const counts = {};
  const records = parts.map((part) => {
    const key = `${part.kind}:${part.fieldName}`;
    const occurrence = counts[key] || 0;
    counts[key] = occurrence + 1;
    if (part.kind === 'text') {
      return {
        fieldName: part.fieldName,
        orderKind: 0,
        occurrence,
        bytes: Buffer.concat([
          frame32(Buffer.from('text')),
          frame32(utf8(part.fieldName)),
          frame32(Buffer.from(String(occurrence), 'utf8')),
          frame32(utf8(part.value))
        ])
      };
    }
    const bytes = Buffer.isBuffer(part.bytes) ? part.bytes : Buffer.from(part.bytes || '');
    const basename = String(part.basename || '').replace(/^.*[\\/]/, '');
    return {
      fieldName: part.fieldName,
      orderKind: 1,
      occurrence,
      bytes: Buffer.concat([
        frame32(Buffer.from('file')),
        frame32(utf8(part.fieldName)),
        frame32(Buffer.from(String(occurrence), 'utf8')),
        frame32(utf8(basename)),
        frame32(utf8(String(part.mime || '').toLowerCase())),
        frame32(Buffer.from(String(bytes.length), 'utf8')),
        frame32(Buffer.from(sha256Hex(bytes), 'utf8'))
      ])
    };
  });
  records.sort((a, b) => {
    const field = Buffer.compare(Buffer.from(a.fieldName, 'utf8'), Buffer.from(b.fieldName, 'utf8'));
    if (field) return field;
    if (a.orderKind !== b.orderKind) return a.orderKind - b.orderKind;
    return a.occurrence - b.occurrence;
  });
  return Buffer.concat([u32(records.length), ...records.map((part) => part.bytes)]);
}

function requestHash(vector) {
  let payload;
  if (vector.kind === 'empty') payload = Buffer.alloc(0);
  else if (vector.kind === 'json') payload = Buffer.from(canonicalJson(vector.payload), 'utf8');
  else if (vector.kind === 'multipart') payload = multipartPayload(vector.payload.parts);
  else throw new Error(`unknown request payload kind ${vector.kind}`);
  const frames = [
    frame32(Buffer.from('tm-request-v1', 'utf8')),
    frame32(Buffer.from(String(vector.method).toUpperCase(), 'utf8')),
    frame32(Buffer.from(canonicalPath(vector.path), 'utf8')),
    frame32(Buffer.from(vector.campaignId === null || vector.campaignId === undefined ? '' : String(vector.campaignId), 'utf8')),
    frame32(Buffer.from(vector.kind, 'utf8')),
    frame32(payload)
  ];
  return sha256Hex(Buffer.concat(frames));
}

function auditFingerprint(input) {
  return sha256Hex(Buffer.concat([
    frame32(Buffer.from('tm-audit-v2', 'utf8')),
    frame32(Buffer.from(String(input.organizationId), 'utf8')),
    frame32(Buffer.from(String(input.actorUserId), 'utf8')),
    frame32(Buffer.from(input.scope, 'utf8')),
    frame32(Buffer.from(input.key, 'utf8')),
    frame32(Buffer.from(input.requestHash, 'utf8')),
    frame32(Buffer.from(input.reservationNonce, 'utf8'))
  ]));
}

function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

function ftsShadowNames(virtualName) {
  return new Set([`${virtualName}_data`, `${virtualName}_idx`, `${virtualName}_content`, `${virtualName}_docsize`, `${virtualName}_config`]);
}

function allShadowNames(manifest) {
  const names = new Set();
  for (const entry of manifest.fts || []) {
    for (const shadow of ftsShadowNames(entry.virtualName)) names.add(shadow);
  }
  return names;
}

function sqlRows(db, sql) {
  const statement = db.prepare(sql);
  if (typeof statement.safeIntegers === 'function') statement.safeIntegers(true);
  return statement.all();
}

function topologyStream(db, manifest) {
  const pragmas = [
    row(['application_id', BigInt(db.pragma('application_id', { simple: true }))]).subarray(8),
    row(['encoding', String(db.pragma('encoding', { simple: true })).toUpperCase()]).subarray(8),
    row(['page_size', BigInt(db.pragma('page_size', { simple: true }))]).subarray(8),
    row(['user_version', BigInt(db.pragma('user_version', { simple: true }))]).subarray(8)
  ];
  const shadowNames = allShadowNames(manifest);
  const objects = sqlRows(db, "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' OR name = 'sqlite_sequence' ORDER BY type,name,tbl_name")
    .filter((object) => !shadowNames.has(object.name))
    .map((object) => {
      const tableList = sqlRows(db, `PRAGMA table_list(${quoteIdent(object.name)})`).map((r) => row([r.schema, r.name, r.type, BigInt(r.ncol), BigInt(r.wr), BigInt(r.strict)]).subarray(8));
      const xinfo = /^(table|view)$/i.test(object.type) || object.type === 'virtual table'
        ? sqlRows(db, `PRAGMA table_xinfo(${quoteIdent(object.name)})`).map((r) => row([BigInt(r.cid), r.name, r.type, BigInt(r.notnull), r.dflt_value, BigInt(r.pk), BigInt(r.hidden)]).subarray(8))
        : [];
      const fk = object.type === 'table'
        ? sqlRows(db, `PRAGMA foreign_key_list(${quoteIdent(object.name)})`).map((r) => row([BigInt(r.id), BigInt(r.seq), r.table, r.from, r.to, r.on_update, r.on_delete, r.match]).subarray(8))
        : [];
      const indexes = object.type === 'table'
        ? sqlRows(db, `PRAGMA index_list(${quoteIdent(object.name)})`).map((idx) => {
          const idxRows = sqlRows(db, `PRAGMA index_xinfo(${quoteIdent(idx.name)})`)
            .sort((a, b) => Number(a.seqno) - Number(b.seqno) || String(a.name).localeCompare(String(b.name)))
            .map((r) => row([BigInt(r.seqno), BigInt(r.cid), r.name, BigInt(r.desc), r.coll, BigInt(r.key)]).subarray(8));
          return Buffer.concat([row([BigInt(idx.seq), idx.name, BigInt(idx.unique), idx.origin, BigInt(idx.partial)]).subarray(8), item('index_xinfo', list(idxRows))]);
        })
        : [];
      return Buffer.concat([
        item('object', row([object.type, object.name, object.tbl_name, object.sql])),
        item('table_list', list(tableList)),
        item('table_xinfo', list(xinfo)),
        item('foreign_key_list', list(fk)),
        item('index_list', list(indexes))
      ]);
    });
  return Buffer.concat([
    item('format', Buffer.from('tm-sqlite-topology-v1', 'utf8')),
    item('pragmas', list(pragmas)),
    item('objects', list(objects))
  ]);
}

function tableRowsStream(db, tableName) {
  const columns = sqlRows(db, `PRAGMA table_xinfo(${quoteIdent(tableName)})`).filter((column) => Number(column.hidden) === 0);
  const rows = sqlRows(db, `SELECT ${columns.map((column) => quoteIdent(column.name)).join(', ')} FROM ${quoteIdent(tableName)}`)
    .map((dataRow) => row(columns.map((column) => dataRow[column.name])).subarray(8))
    .sort(Buffer.compare);
  const cids = columns.map((column) => row([BigInt(column.cid)]).subarray(8));
  return Buffer.concat([
    item('table', row([tableName])),
    item('column_cids', list(cids)),
    item('rows', list(rows))
  ]);
}

function knowledgeRows(db) {
  const rows = sqlRows(db, `
    SELECT c.id AS chunk_id, c.entry_id AS entry_id, e.title AS title, c.content AS content, e.tags_json AS tags_json
    FROM knowledge_chunks c
    JOIN knowledge_entries e ON e.id = c.entry_id
    ORDER BY c.id
  `);
  const seen = new Set();
  return rows.map((r) => {
    if (seen.has(String(r.chunk_id))) throw new Error('duplicate chunk IDs in knowledge_chunks');
    seen.add(String(r.chunk_id));
    let parsed;
    try {
      parsed = JSON.parse(r.tags_json || '[]');
    } catch (error) {
      throw new Error(`malformed tags_json for knowledge entry ${r.entry_id}`);
    }
    if (!Array.isArray(parsed)) throw new Error(`malformed tags_json for knowledge entry ${r.entry_id}`);
    const tags = [...new Set(parsed.map((tag) => String(tag).normalize('NFC')))].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).join(' ');
    return {
      values: [BigInt(r.entry_id), BigInt(r.chunk_id), r.title, r.content, tags],
      insert: [r.title, r.content, tags, Number(r.entry_id), Number(r.chunk_id)]
    };
  });
}

function rebuildKnowledgeChunksFts(db) {
  const rows = knowledgeRows(db);
  const tx = db.transaction(() => {
    db.exec('DELETE FROM knowledge_chunks_fts');
    const insert = db.prepare('INSERT INTO knowledge_chunks_fts (title, content, tags, entry_id, chunk_id) VALUES (?, ?, ?, ?, ?)');
    for (const rowData of rows) insert.run(...rowData.insert);
    db.prepare("INSERT INTO knowledge_chunks_fts(knowledge_chunks_fts) VALUES('integrity-check')").run();
  });
  tx();
}

function semanticPostingRows(db, vocabSchema, vocabName, ftsSchema, ftsName) {
  return sqlRows(db, `
    SELECT v.term AS term,
           CAST(f.chunk_id AS TEXT) AS chunk_id,
           v.col AS col,
           CAST(v.offset AS TEXT) AS offset
    FROM ${vocabSchema}.${quoteIdent(vocabName)} v
    LEFT JOIN ${ftsSchema}.${quoteIdent(ftsName)} f ON f.rowid = v.doc
    ORDER BY v.term, CAST(f.chunk_id AS TEXT), v.col, CAST(v.offset AS INTEGER)
  `);
}

function verifyKnowledgeChunksFtsIntegrity(db, manifest, options) {
  const entries = (manifest && manifest.fts) || [];
  const checkMainIntegrity = Boolean(options && options.checkMainIntegrity);
  for (const entry of entries) {
    if (entry.virtualName !== 'knowledge_chunks_fts') throw new Error(`unknown FTS table ${entry.virtualName}`);
    if (entry.tokenizerOptions !== 'unicode61') throw new Error(`unsupported FTS tokenizer options: ${entry.tokenizerOptions}`);
    verifyKnowledgeChunksFtsCanaries(db, []);
    const expectedName = 'expected_knowledge_chunks_fts';
    const actualVocabName = 'actual_knowledge_chunks_fts_vocab';
    const expectedVocabName = 'expected_knowledge_chunks_fts_vocab';
    try {
      db.exec(`
        DROP TABLE IF EXISTS temp.${quoteIdent(actualVocabName)};
        DROP TABLE IF EXISTS temp.${quoteIdent(expectedVocabName)};
        DROP TABLE IF EXISTS temp.${quoteIdent(expectedName)};
        CREATE VIRTUAL TABLE temp.${quoteIdent(expectedName)} USING fts5(
          title,
          content,
          tags,
          entry_id UNINDEXED,
          chunk_id UNINDEXED,
          tokenize = 'unicode61'
        );
      `);
      const insert = db.prepare(`INSERT INTO temp.${quoteIdent(expectedName)} (title, content, tags, entry_id, chunk_id) VALUES (?, ?, ?, ?, ?)`);
      for (const rowData of knowledgeRows(db)) insert.run(...rowData.insert);
      db.prepare(`INSERT INTO temp.${quoteIdent(expectedName)}(${quoteIdent(expectedName)}) VALUES('integrity-check')`).run();
      db.exec(`
        CREATE VIRTUAL TABLE temp.${quoteIdent(actualVocabName)} USING fts5vocab(main, ${quoteIdent(entry.virtualName)}, 'instance');
        CREATE VIRTUAL TABLE temp.${quoteIdent(expectedVocabName)} USING fts5vocab(temp, ${quoteIdent(expectedName)}, 'instance');
      `);
      const actual = semanticPostingRows(db, 'temp', actualVocabName, 'main', entry.virtualName);
      const expected = semanticPostingRows(db, 'temp', expectedVocabName, 'temp', expectedName);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`FTS posting mismatch for ${entry.virtualName}`);
      }
      if (checkMainIntegrity) {
        db.prepare(`INSERT INTO ${quoteIdent(entry.virtualName)}(${quoteIdent(entry.virtualName)}) VALUES('integrity-check')`).run();
      }
    } finally {
      db.exec(`
        DROP TABLE IF EXISTS temp.${quoteIdent(actualVocabName)};
        DROP TABLE IF EXISTS temp.${quoteIdent(expectedVocabName)};
        DROP TABLE IF EXISTS temp.${quoteIdent(expectedName)};
      `);
    }
  }
}

function ftsDigest(db, manifestEntry) {
  if (manifestEntry.virtualName !== 'knowledge_chunks_fts') throw new Error(`unknown FTS table ${manifestEntry.virtualName}`);
  const rows = sqlRows(db, 'SELECT entry_id, chunk_id, title, content, tags FROM knowledge_chunks_fts ORDER BY chunk_id')
    .map((r) => [BigInt(r.entry_id), BigInt(r.chunk_id), r.title, r.content, r.tags]);
  const stream = ftsStream(manifestEntry, rows);
  return { virtualName: manifestEntry.virtualName, rowCount: rows.length, sha256: sha256Hex(stream), stream };
}

function logicalStream(db, manifest, topologySha256) {
  const shadowNames = allShadowNames(manifest);
  const ftsNames = new Set((manifest.fts || []).map((entry) => entry.virtualName));
  const tableNames = sqlRows(db, "SELECT name,type FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' OR name = 'sqlite_sequence' ORDER BY name")
    .filter((object) => object.type === 'table' && !shadowNames.has(object.name) && !ftsNames.has(object.name))
    .map((object) => object.name);
  const tableStreams = tableNames.map((name) => tableRowsStream(db, name));
  const fts = (manifest.fts || []).map((entry) => ftsDigest(db, entry));
  const ftsSummaries = fts
    .sort((a, b) => a.virtualName.localeCompare(b.virtualName))
    .map((entry) => row([entry.virtualName, BigInt(entry.rowCount), Buffer.from(entry.sha256, 'hex')]).subarray(8));
  return {
    stream: Buffer.concat([
      item('format', Buffer.from('tm-sqlite-logical-v1', 'utf8')),
      item('topology_sha256', Buffer.from(topologySha256, 'hex')),
      item('tables', list(tableStreams)),
      item('fts', list(ftsSummaries))
    ]),
    fts
  };
}

function databaseDigest(db, manifest) {
  const topology = topologyStream(db, manifest || {});
  const topologySha256 = sha256Hex(topology);
  const logical = logicalStream(db, manifest || {}, topologySha256);
  return {
    topologySha256,
    logicalSha256: sha256Hex(logical.stream),
    fts: logical.fts.map((entry) => ({ virtualName: entry.virtualName, rowCount: entry.rowCount, sha256: entry.sha256 }))
  };
}

function matchKnowledgeChunksCanary(db, term) {
  return db.prepare('SELECT chunk_id FROM knowledge_chunks_fts WHERE knowledge_chunks_fts MATCH ? ORDER BY chunk_id').all(term).map((row) => row.chunk_id);
}

function verifyKnowledgeChunksFtsCanaries(db, terms) {
  const projected = knowledgeRows(db).map((rowData) => rowData.values);
  const actual = sqlRows(db, 'SELECT entry_id, chunk_id, title, content, tags FROM knowledge_chunks_fts ORDER BY chunk_id')
    .map((r) => [BigInt(r.entry_id), BigInt(r.chunk_id), r.title, r.content, r.tags]);
  if (JSON.stringify(projected, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)) !== JSON.stringify(actual, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))) {
    throw new Error('FTS projection mismatch');
  }
  for (const term of terms) {
    const expected = db.prepare('SELECT id FROM knowledge_chunks WHERE content LIKE ? ORDER BY id').all(`%${term}%`).map((row) => row.id);
    const matched = matchKnowledgeChunksCanary(db, term);
    if (JSON.stringify(matched) !== JSON.stringify(expected)) throw new Error(`FTS canary mismatch for ${term}`);
  }
}

module.exports = {
  sha256Hex,
  item,
  row,
  list,
  ftsStream,
  canonicalJsonBytes: (value) => Buffer.from(canonicalJson(value), 'utf8'),
  requestHash,
  auditFingerprint,
  rebuildKnowledgeChunksFts,
  matchKnowledgeChunksCanary,
  verifyKnowledgeChunksFtsCanaries,
  verifyKnowledgeChunksFtsIntegrity,
  databaseDigest
};

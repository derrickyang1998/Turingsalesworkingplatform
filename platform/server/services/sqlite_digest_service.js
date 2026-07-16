const crypto = require('crypto');
const { TextDecoder } = require('util');

const SQLITE_TEXT_BYTES = Symbol('sqliteTextBytes');
const sqliteTextDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

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

function sqliteTextValue(bytes, context) {
  if (!Buffer.isBuffer(bytes)) throw new Error(`malformed SQLite TEXT at ${context}: expected raw bytes`);
  const raw = Buffer.from(bytes);
  let text;
  try {
    text = sqliteTextDecoder.decode(raw);
  } catch (_error) {
    throw new Error(`malformed SQLite TEXT at ${context}: value is not well-formed UTF-8`);
  }
  if (!Buffer.from(text, 'utf8').equals(raw)) {
    throw new Error(`malformed SQLite TEXT at ${context}: blob/text round trip mismatch`);
  }
  return Object.freeze({ [SQLITE_TEXT_BYTES]: raw, text });
}

function isSqliteTextValue(value) {
  return Boolean(value && typeof value === 'object' && Buffer.isBuffer(value[SQLITE_TEXT_BYTES]));
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
  if (isSqliteTextValue(value)) {
    const text = value[SQLITE_TEXT_BYTES];
    return Buffer.concat([Buffer.from('T'), u64(text.length), text]);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from('B'), u64(value.length), value]);
  const text = Buffer.from(String(value), 'utf8');
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

function sqlRows(db, sql, params = []) {
  const statement = db.prepare(sql);
  if (typeof statement.safeIntegers === 'function') statement.safeIntegers(true);
  return statement.all(...params);
}

function storedValue(storageType, value, context) {
  if (storageType === 'null') {
    if (value !== null) throw new Error(`SQLite storage mismatch at ${context}: expected NULL`);
    return null;
  }
  if (storageType === 'integer') {
    if (typeof value !== 'bigint') throw new Error(`SQLite storage mismatch at ${context}: expected INTEGER`);
    return value;
  }
  if (storageType === 'real') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`SQLite storage mismatch at ${context}: expected finite REAL`);
    return value;
  }
  if (storageType === 'text') return sqliteTextValue(value, context);
  if (storageType === 'blob') {
    if (!Buffer.isBuffer(value)) throw new Error(`SQLite storage mismatch at ${context}: expected BLOB`);
    return value;
  }
  throw new Error(`unknown SQLite storage class at ${context}: ${storageType}`);
}

function storedRows(db, columns, fromClause, params = []) {
  const projection = [];
  for (let index = 0; index < columns.length; index += 1) {
    const expression = columns[index].expression;
    const typeAlias = quoteIdent(`__tm_storage_type_${index}`);
    const valueAlias = quoteIdent(`__tm_storage_value_${index}`);
    projection.push(`typeof(${expression}) AS ${typeAlias}`);
    projection.push(`CASE WHEN typeof(${expression}) = 'text' THEN CAST(${expression} AS BLOB) ELSE ${expression} END AS ${valueAlias}`);
  }
  return sqlRows(db, `SELECT ${projection.join(', ')} ${fromClause}`, params).map((dataRow) => columns.map((column, index) => (
    storedValue(dataRow[`__tm_storage_type_${index}`], dataRow[`__tm_storage_value_${index}`], column.context)
  )));
}

function safePositiveId(value, context) {
  if (typeof value !== 'bigint' || value < 1n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`unsafe SQLite integer at ${context}`);
  }
  return value;
}

function safeNonnegativeInteger(value, context) {
  if (typeof value !== 'bigint' || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`unsafe SQLite integer at ${context}`);
  }
  return value;
}

function ftsSemanticId(value, context) {
  if (typeof value === 'bigint') return safePositiveId(value, context);
  if (typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0)) {
    return safePositiveId(BigInt(value), context);
  }
  if (!isSqliteTextValue(value) || !/^[1-9][0-9]*$/.test(value.text)) {
    throw new Error(`unsafe FTS semantic integer at ${context}`);
  }
  return safePositiveId(BigInt(value.text), context);
}

function requiredText(value, context) {
  if (!isSqliteTextValue(value)) throw new Error(`SQLite storage mismatch at ${context}: expected TEXT`);
  return value.text;
}

function requiredInteger(value, context) {
  if (typeof value !== 'bigint') throw new Error(`SQLite storage mismatch at ${context}: expected INTEGER`);
  return value;
}

function optionalText(value, context) {
  if (value === null) return null;
  requiredText(value, context);
  return value;
}

function singleStoredRow(db, columns, fromClause, params = []) {
  const rows = storedRows(db, columns, fromClause, params);
  if (rows.length !== 1) throw new Error(`unexpected SQLite metadata row count for ${fromClause}`);
  return rows[0];
}

function tableListMetadata(db, objectName) {
  return storedRows(db, [
    { expression: 'schema', context: `table_list(${objectName}).schema` },
    { expression: 'name', context: `table_list(${objectName}).name` },
    { expression: 'type', context: `table_list(${objectName}).type` },
    { expression: 'ncol', context: `table_list(${objectName}).ncol` },
    { expression: 'wr', context: `table_list(${objectName}).wr` },
    { expression: 'strict', context: `table_list(${objectName}).strict` }
  ], 'FROM pragma_table_list(?) ORDER BY CAST(schema AS BLOB), CAST(name AS BLOB), CAST(type AS BLOB)', [objectName])
    .map((values) => {
      requiredText(values[0], `table_list(${objectName}).schema`);
      requiredText(values[1], `table_list(${objectName}).name`);
      requiredText(values[2], `table_list(${objectName}).type`);
      requiredInteger(values[3], `table_list(${objectName}).ncol`);
      requiredInteger(values[4], `table_list(${objectName}).wr`);
      requiredInteger(values[5], `table_list(${objectName}).strict`);
      return values;
    });
}

function tableXinfoMetadata(db, objectName) {
  return storedRows(db, [
    { expression: 'cid', context: `table_xinfo(${objectName}).cid` },
    { expression: 'name', context: `table_xinfo(${objectName}).name` },
    { expression: 'type', context: `table_xinfo(${objectName}).type` },
    { expression: '"notnull"', context: `table_xinfo(${objectName}).notnull` },
    { expression: 'dflt_value', context: `table_xinfo(${objectName}).dflt_value` },
    { expression: 'pk', context: `table_xinfo(${objectName}).pk` },
    { expression: 'hidden', context: `table_xinfo(${objectName}).hidden` }
  ], 'FROM pragma_table_xinfo(?) ORDER BY cid, CAST(name AS BLOB)', [objectName])
    .map((values) => {
      requiredInteger(values[0], `table_xinfo(${objectName}).cid`);
      requiredText(values[1], `table_xinfo(${objectName}).name`);
      requiredText(values[2], `table_xinfo(${objectName}).type`);
      requiredInteger(values[3], `table_xinfo(${objectName}).notnull`);
      optionalText(values[4], `table_xinfo(${objectName}).dflt_value`);
      requiredInteger(values[5], `table_xinfo(${objectName}).pk`);
      requiredInteger(values[6], `table_xinfo(${objectName}).hidden`);
      return values;
    });
}

function foreignKeyMetadata(db, objectName) {
  return storedRows(db, [
    { expression: 'id', context: `foreign_key_list(${objectName}).id` },
    { expression: 'seq', context: `foreign_key_list(${objectName}).seq` },
    { expression: '"table"', context: `foreign_key_list(${objectName}).table` },
    { expression: '"from"', context: `foreign_key_list(${objectName}).from` },
    { expression: '"to"', context: `foreign_key_list(${objectName}).to` },
    { expression: 'on_update', context: `foreign_key_list(${objectName}).on_update` },
    { expression: 'on_delete', context: `foreign_key_list(${objectName}).on_delete` },
    { expression: '"match"', context: `foreign_key_list(${objectName}).match` }
  ], 'FROM pragma_foreign_key_list(?) ORDER BY id, seq', [objectName])
    .map((values) => {
      requiredInteger(values[0], `foreign_key_list(${objectName}).id`);
      requiredInteger(values[1], `foreign_key_list(${objectName}).seq`);
      requiredText(values[2], `foreign_key_list(${objectName}).table`);
      requiredText(values[3], `foreign_key_list(${objectName}).from`);
      optionalText(values[4], `foreign_key_list(${objectName}).to`);
      requiredText(values[5], `foreign_key_list(${objectName}).on_update`);
      requiredText(values[6], `foreign_key_list(${objectName}).on_delete`);
      requiredText(values[7], `foreign_key_list(${objectName}).match`);
      return values;
    });
}

function indexMetadata(db, objectName) {
  return storedRows(db, [
    { expression: 'seq', context: `index_list(${objectName}).seq` },
    { expression: 'name', context: `index_list(${objectName}).name` },
    { expression: '"unique"', context: `index_list(${objectName}).unique` },
    { expression: 'origin', context: `index_list(${objectName}).origin` },
    { expression: 'partial', context: `index_list(${objectName}).partial` }
  ], 'FROM pragma_index_list(?) ORDER BY seq, CAST(name AS BLOB)', [objectName])
    .map((values) => {
      requiredInteger(values[0], `index_list(${objectName}).seq`);
      const indexName = requiredText(values[1], `index_list(${objectName}).name`);
      requiredInteger(values[2], `index_list(${objectName}).unique`);
      requiredText(values[3], `index_list(${objectName}).origin`);
      requiredInteger(values[4], `index_list(${objectName}).partial`);
      const xinfo = storedRows(db, [
        { expression: 'seqno', context: `index_xinfo(${indexName}).seqno` },
        { expression: 'cid', context: `index_xinfo(${indexName}).cid` },
        { expression: 'name', context: `index_xinfo(${indexName}).name` },
        { expression: '"desc"', context: `index_xinfo(${indexName}).desc` },
        { expression: 'coll', context: `index_xinfo(${indexName}).coll` },
        { expression: '"key"', context: `index_xinfo(${indexName}).key` }
      ], 'FROM pragma_index_xinfo(?) ORDER BY seqno, cid, CAST(name AS BLOB)', [indexName])
        .map((indexValues) => {
          requiredInteger(indexValues[0], `index_xinfo(${indexName}).seqno`);
          requiredInteger(indexValues[1], `index_xinfo(${indexName}).cid`);
          optionalText(indexValues[2], `index_xinfo(${indexName}).name`);
          requiredInteger(indexValues[3], `index_xinfo(${indexName}).desc`);
          optionalText(indexValues[4], `index_xinfo(${indexName}).coll`);
          requiredInteger(indexValues[5], `index_xinfo(${indexName}).key`);
          return row(indexValues).subarray(8);
        });
      return Buffer.concat([row(values).subarray(8), item('index_xinfo', list(xinfo))]);
    });
}

function topologyStream(db, manifest) {
  const applicationId = singleStoredRow(db, [
    { expression: 'application_id', context: 'pragma.application_id' }
  ], 'FROM pragma_application_id')[0];
  const encoding = singleStoredRow(db, [
    { expression: 'encoding', context: 'pragma.encoding' }
  ], 'FROM pragma_encoding')[0];
  const pageSize = singleStoredRow(db, [
    { expression: 'page_size', context: 'pragma.page_size' }
  ], 'FROM pragma_page_size')[0];
  const userVersion = singleStoredRow(db, [
    { expression: 'user_version', context: 'pragma.user_version' }
  ], 'FROM pragma_user_version')[0];
  const pragmas = [
    row(['application_id', requiredInteger(applicationId, 'pragma.application_id')]).subarray(8),
    row(['encoding', requiredText(encoding, 'pragma.encoding').toUpperCase()]).subarray(8),
    row(['page_size', requiredInteger(pageSize, 'pragma.page_size')]).subarray(8),
    row(['user_version', requiredInteger(userVersion, 'pragma.user_version')]).subarray(8)
  ];
  const shadowNames = allShadowNames(manifest);
  const objects = storedRows(db, [
    { expression: 'type', context: 'sqlite_schema.type' },
    { expression: 'name', context: 'sqlite_schema.name' },
    { expression: 'tbl_name', context: 'sqlite_schema.tbl_name' },
    { expression: 'sql', context: 'sqlite_schema.sql' }
  ], "FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' OR name = 'sqlite_sequence' ORDER BY CAST(type AS BLOB), CAST(name AS BLOB), CAST(tbl_name AS BLOB)")
    .map((values) => {
      const type = requiredText(values[0], 'sqlite_schema.type');
      const name = requiredText(values[1], 'sqlite_schema.name');
      requiredText(values[2], 'sqlite_schema.tbl_name');
      optionalText(values[3], 'sqlite_schema.sql');
      return { values, type, name };
    })
    .filter((object) => !shadowNames.has(object.name))
    .map((object) => {
      const tableList = tableListMetadata(db, object.name).map((values) => row(values).subarray(8));
      const xinfo = /^(table|view)$/i.test(object.type) || object.type === 'virtual table'
        ? tableXinfoMetadata(db, object.name).map((values) => row(values).subarray(8))
        : [];
      const fk = object.type === 'table'
        ? foreignKeyMetadata(db, object.name).map((values) => row(values).subarray(8))
        : [];
      const indexes = object.type === 'table'
        ? indexMetadata(db, object.name)
        : [];
      return item('object', Buffer.concat([
        row(object.values),
        item('table_list', list(tableList)),
        item('table_xinfo', list(xinfo)),
        item('foreign_key_list', list(fk)),
        item('index_list', list(indexes))
      ]));
    });
  return Buffer.concat([
    item('format', Buffer.from('tm-sqlite-topology-v1', 'utf8')),
    item('pragmas', list(pragmas)),
    item('objects', list(objects))
  ]);
}

function tableRowsStream(db, tableNameValue) {
  const tableName = isSqliteTextValue(tableNameValue) ? requiredText(tableNameValue, 'sqlite_schema.name') : String(tableNameValue);
  const encodedTableName = isSqliteTextValue(tableNameValue) ? tableNameValue : tableName;
  const columns = tableXinfoMetadata(db, tableName)
    .filter((values) => values[6] === 0n)
    .map((values) => ({ cid: values[0], nameValue: values[1], name: requiredText(values[1], `table_xinfo(${tableName}).name`) }));
  const rows = storedRows(
    db,
    columns.map((column) => ({ expression: quoteIdent(column.name), context: `${tableName}.${column.name}` })),
    `FROM ${quoteIdent(tableName)}`
  )
    .map((values) => row(values).subarray(8))
    .sort(Buffer.compare);
  const cids = columns.map((column) => row([column.cid]).subarray(8));
  return item('table', Buffer.concat([
    row([encodedTableName]),
    item('column_cids', list(cids)),
    item('rows', list(rows))
  ]));
}

function knowledgeRows(db) {
  const rows = storedRows(db, [
    { expression: 'c.id', context: 'knowledge_chunks.id' },
    { expression: 'c.entry_id', context: 'knowledge_chunks.entry_id' },
    { expression: 'c.chunk_index', context: 'knowledge_chunks.chunk_index' },
    { expression: 'e.title', context: 'knowledge_entries.title' },
    { expression: 'c.content', context: 'knowledge_chunks.content' },
    { expression: 'e.tags_json', context: 'knowledge_entries.tags_json' }
  ], `
    FROM knowledge_chunks c
    JOIN knowledge_entries e ON e.id = c.entry_id
    ORDER BY c.id
  `);
  const seen = new Set();
  const seenLogicalSlots = new Set();
  return rows.map((values) => {
    const chunkId = safePositiveId(values[0], 'knowledge_chunks.id');
    const entryId = safePositiveId(values[1], 'knowledge_chunks.entry_id');
    const chunkIndex = safeNonnegativeInteger(values[2], 'knowledge_chunks.chunk_index');
    const title = requiredText(values[3], 'knowledge_entries.title');
    const content = requiredText(values[4], 'knowledge_chunks.content');
    const tagsJson = requiredText(values[5], 'knowledge_entries.tags_json');
    if (seen.has(String(chunkId))) throw new Error('duplicate chunk IDs in knowledge_chunks');
    seen.add(String(chunkId));
    const logicalSlot = `${entryId}:${chunkIndex}`;
    if (seenLogicalSlots.has(logicalSlot)) throw new Error('duplicate knowledge_chunks entry_id and chunk_index pair');
    seenLogicalSlots.add(logicalSlot);
    let parsed;
    try {
      parsed = JSON.parse(tagsJson);
    } catch (error) {
      throw new Error(`malformed tags_json for knowledge entry ${entryId}`);
    }
    if (!Array.isArray(parsed)) throw new Error(`malformed tags_json for knowledge entry ${entryId}`);
    if (parsed.some((tag) => typeof tag !== 'string')) throw new Error(`malformed tags_json for knowledge entry ${entryId}: every tag must be a string`);
    if (parsed.some((tag) => Buffer.from(tag, 'utf8').toString('utf8') !== tag)) {
      throw new Error(`malformed tags_json for knowledge entry ${entryId}: tag is not a valid Unicode scalar string`);
    }
    const tags = [...new Set(parsed)].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))).join(' ');
    return {
      values: [entryId, chunkId, title, content, tags],
      insert: [title, content, tags, Number(entryId), Number(chunkId)]
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
  const rows = storedRows(db, [
    { expression: 'entry_id', context: 'knowledge_chunks_fts.entry_id' },
    { expression: 'chunk_id', context: 'knowledge_chunks_fts.chunk_id' },
    { expression: 'title', context: 'knowledge_chunks_fts.title' },
    { expression: 'content', context: 'knowledge_chunks_fts.content' },
    { expression: 'tags', context: 'knowledge_chunks_fts.tags' }
  ], 'FROM knowledge_chunks_fts ORDER BY chunk_id')
    .map((values) => {
      const entryId = ftsSemanticId(values[0], 'knowledge_chunks_fts.entry_id');
      const chunkId = ftsSemanticId(values[1], 'knowledge_chunks_fts.chunk_id');
      requiredText(values[2], 'knowledge_chunks_fts.title');
      requiredText(values[3], 'knowledge_chunks_fts.content');
      requiredText(values[4], 'knowledge_chunks_fts.tags');
      return [entryId, chunkId, values[2], values[3], values[4]];
    });
  const stream = ftsStream(manifestEntry, rows);
  return { virtualName: manifestEntry.virtualName, rowCount: rows.length, sha256: sha256Hex(stream), stream };
}

function logicalStream(db, manifest, topologySha256) {
  const shadowNames = allShadowNames(manifest);
  const ftsNames = new Set((manifest.fts || []).map((entry) => entry.virtualName));
  const tableNames = storedRows(db, [
    { expression: 'name', context: 'sqlite_schema.name' },
    { expression: 'type', context: 'sqlite_schema.type' }
  ], "FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' OR name = 'sqlite_sequence' ORDER BY CAST(name AS BLOB)")
    .map((values) => ({
      nameValue: values[0],
      name: requiredText(values[0], 'sqlite_schema.name'),
      type: requiredText(values[1], 'sqlite_schema.type')
    }))
    .filter((object) => object.type === 'table' && !shadowNames.has(object.name) && !ftsNames.has(object.name));
  const tableStreams = tableNames.map((object) => tableRowsStream(db, object.nameValue));
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
  const actual = storedRows(db, [
    { expression: 'entry_id', context: 'knowledge_chunks_fts.entry_id' },
    { expression: 'chunk_id', context: 'knowledge_chunks_fts.chunk_id' },
    { expression: 'title', context: 'knowledge_chunks_fts.title' },
    { expression: 'content', context: 'knowledge_chunks_fts.content' },
    { expression: 'tags', context: 'knowledge_chunks_fts.tags' }
  ], 'FROM knowledge_chunks_fts ORDER BY chunk_id').map((values) => [
    ftsSemanticId(values[0], 'knowledge_chunks_fts.entry_id'),
    ftsSemanticId(values[1], 'knowledge_chunks_fts.chunk_id'),
    requiredText(values[2], 'knowledge_chunks_fts.title'),
    requiredText(values[3], 'knowledge_chunks_fts.content'),
    requiredText(values[4], 'knowledge_chunks_fts.tags')
  ]);
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
  databaseDigest,
  _testing: Object.freeze({ topologyStream, tableRowsStream })
};

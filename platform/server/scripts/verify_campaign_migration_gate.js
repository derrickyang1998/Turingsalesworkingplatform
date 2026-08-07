'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const sqliteDigest = require('../services/sqlite_digest_service');
const sanitizer = require('./sanitize_production_shape');

const REPORT_VERSION = 'tm-campaign-migration-gate-v1';
const PRESERVATION_REPORT_VERSION = 'tm-campaign-migration-preservation-v1';
const LEGACY_TOPOLOGY_FORMAT = 'tm-legacy-topology-subset-v1';
const REQUIRED_SOURCE_VERSION = 1;
const REQUIRED_TARGET_VERSION = 5;
const DEFAULT_FROZEN_MIGRATION_TIMESTAMP = '2040-01-02 03:04:05';
const EXCLUDED_PRESERVATION_TABLES = new Set(['schema_migrations', 'sqlite_sequence']);
const DETERMINISTIC_APPEND_TABLES = new Set(['activity_log']);

const REGISTERED_MIGRATIONS = Object.freeze([
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
  })
]);

function migrationOptions() {
  return {
    rootDir: path.resolve(__dirname, '..'),
    registeredMigrations: REGISTERED_MIGRATIONS
  };
}

function classificationOptions() {
  return {
    ...migrationOptions(),
    migrations: [...migrationService.defaultMigrations(), ...REGISTERED_MIGRATIONS]
  };
}

function quoteIdentifier(value) {
  if (typeof value !== 'string' || !value) throw new Error('invalid SQLite identifier');
  return `"${value.replace(/"/g, '""')}"`;
}

function frame(bytes) {
  const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(value.length));
  return Buffer.concat([length, value]);
}

function sha256Parts(parts) {
  const hash = crypto.createHash('sha256');
  for (const part of parts) hash.update(frame(part));
  return hash.digest('hex');
}

function encodedStorageValue(value, storageType) {
  if (storageType === 'null') return Buffer.from('N', 'ascii');
  if (storageType === 'integer') return Buffer.from(`I${String(value)}`, 'utf8');
  if (storageType === 'real') {
    const bytes = Buffer.alloc(9);
    bytes[0] = 0x52;
    bytes.writeDoubleBE(value, 1);
    return bytes;
  }
  if (storageType === 'text') return Buffer.concat([Buffer.from('T', 'ascii'), Buffer.from(value, 'utf8')]);
  if (storageType === 'blob' && Buffer.isBuffer(value)) return Buffer.concat([Buffer.from('B', 'ascii'), value]);
  throw new Error('legacy preservation encountered unsupported SQLite storage');
}

function stableMetadata(value) {
  return JSON.stringify(value, Object.keys(value).sort());
}

function safeFrameLength(buffer, offset, context) {
  if (!Buffer.isBuffer(buffer) || offset < 0 || offset + 8 > buffer.length) {
    throw new Error(`legacy preservation malformed ${context} frame`);
  }
  const value = buffer.readBigUInt64BE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`legacy preservation oversized ${context} frame`);
  return Number(value);
}

function parseItemAt(buffer, offset, context) {
  if (offset < 0 || offset + 2 > buffer.length) throw new Error(`legacy preservation malformed ${context} item`);
  const labelLength = buffer.readUInt16BE(offset);
  const labelStart = offset + 2;
  const labelEnd = labelStart + labelLength;
  if (labelEnd + 8 > buffer.length) throw new Error(`legacy preservation malformed ${context} item label`);
  const payloadLength = safeFrameLength(buffer, labelEnd, `${context} item payload`);
  const payloadStart = labelEnd + 8;
  const end = payloadStart + payloadLength;
  if (end > buffer.length) throw new Error(`legacy preservation truncated ${context} item payload`);
  return Object.freeze({
    label: buffer.subarray(labelStart, labelEnd).toString('utf8'),
    payload: buffer.subarray(payloadStart, end),
    bytes: buffer.subarray(offset, end),
    end
  });
}

function parseItems(buffer, context) {
  const items = [];
  let offset = 0;
  while (offset < buffer.length) {
    const item = parseItemAt(buffer, offset, context);
    items.push(item);
    offset = item.end;
  }
  if (offset !== buffer.length) throw new Error(`legacy preservation malformed ${context} item list`);
  return items;
}

function parseListRecords(buffer, context) {
  const count = safeFrameLength(buffer, 0, `${context} list count`);
  const records = [];
  let offset = 8;
  for (let index = 0; index < count; index += 1) {
    const length = safeFrameLength(buffer, offset, `${context} record`);
    const start = offset + 8;
    const end = start + length;
    if (end > buffer.length) throw new Error(`legacy preservation truncated ${context} record`);
    records.push(buffer.subarray(start, end));
    offset = end;
  }
  if (offset !== buffer.length) throw new Error(`legacy preservation malformed ${context} records`);
  return records;
}

function topologyShadowNames() {
  const names = new Set();
  for (const entry of sanitizer.FTS_MANIFEST.fts || []) {
    for (const suffix of ['data', 'idx', 'content', 'docsize', 'config']) {
      names.add(`${entry.virtualName}_${suffix}`);
    }
  }
  return names;
}

function topologyObjectKey(object) {
  return JSON.stringify([object.type, object.name, object.tblName]);
}

function topologyObjectInventory(db) {
  const shadowNames = topologyShadowNames();
  return db.prepare(`
    SELECT type,name,tbl_name AS tblName,sql
    FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' OR name='sqlite_sequence'
    ORDER BY CAST(type AS BLOB),CAST(name AS BLOB),CAST(tbl_name AS BLOB)
  `).all().filter((object) => !shadowNames.has(object.name));
}

function frozenTopologyProjection(db) {
  const stream = sqliteDigest._testing.topologyStream(db, sanitizer.FTS_MANIFEST);
  const items = parseItems(stream, 'tm-sqlite-topology-v1');
  const format = items.find((item) => item.label === 'format');
  const pragmas = items.find((item) => item.label === 'pragmas');
  const objects = items.find((item) => item.label === 'objects');
  if (
    items.length !== 3 ||
    !format || !format.payload.equals(Buffer.from('tm-sqlite-topology-v1', 'utf8')) ||
    !pragmas || !objects
  ) {
    throw new Error('legacy preservation malformed frozen topology stream');
  }
  const records = parseListRecords(objects.payload, 'topology objects');
  const inventory = topologyObjectInventory(db);
  if (records.length !== inventory.length) throw new Error('legacy preservation topology object framing drift');
  const objectMap = new Map();
  for (let index = 0; index < inventory.length; index += 1) {
    const object = Object.freeze({
      type: String(inventory[index].type),
      name: String(inventory[index].name),
      tblName: String(inventory[index].tblName),
      sql: inventory[index].sql === null ? null : String(inventory[index].sql),
      record: Buffer.from(records[index])
    });
    const key = topologyObjectKey(object);
    if (objectMap.has(key)) throw new Error('legacy preservation duplicate topology object identity');
    objectMap.set(key, object);
  }
  return Object.freeze({ pragmas: Buffer.from(pragmas.bytes), objects: objectMap });
}

function sqlQuotedSegmentEnd(sql, index, delimiter) {
  if (delimiter === '[') {
    for (let cursor = index + 1; cursor < sql.length; cursor += 1) {
      if (sql[cursor] !== ']') continue;
      if (sql[cursor + 1] === ']') {
        cursor += 1;
        continue;
      }
      return cursor + 1;
    }
    throw new Error('legacy preservation malformed table SQL bracket identifier');
  }
  for (let cursor = index + 1; cursor < sql.length; cursor += 1) {
    if (sql[cursor] !== delimiter) continue;
    if (sql[cursor + 1] === delimiter) {
      cursor += 1;
      continue;
    }
    return cursor + 1;
  }
  throw new Error('legacy preservation malformed table SQL quoted segment');
}

function tableSqlParts(sql, table) {
  if (typeof sql !== 'string' || !sql) throw new Error(`legacy preservation missing table SQL for ${table}`);
  let opening = -1;
  let closing = -1;
  let depth = 0;
  let definitionStart = -1;
  const definitions = [];
  for (let index = 0; index < sql.length;) {
    const character = sql[index];
    if (character === "'" || character === '"' || character === '`' || character === '[') {
      index = sqlQuotedSegmentEnd(sql, index, character);
      continue;
    }
    if (character === '-' && sql[index + 1] === '-') {
      const newline = sql.indexOf('\n', index + 2);
      index = newline === -1 ? sql.length : newline + 1;
      continue;
    }
    if (character === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2);
      if (end === -1) throw new Error(`legacy preservation malformed table SQL comment for ${table}`);
      index = end + 2;
      continue;
    }
    if (character === '(') {
      if (opening === -1) {
        opening = index;
        definitionStart = index + 1;
      }
      depth += 1;
      index += 1;
      continue;
    }
    if (character === ')') {
      if (opening === -1 || depth < 1) throw new Error(`legacy preservation malformed table SQL parentheses for ${table}`);
      depth -= 1;
      if (depth === 0) {
        definitions.push(sql.slice(definitionStart, index));
        closing = index;
        break;
      }
      index += 1;
      continue;
    }
    if (character === ',' && depth === 1) {
      definitions.push(sql.slice(definitionStart, index));
      definitionStart = index + 1;
    }
    index += 1;
  }
  if (opening < 0 || closing < 0 || definitions.some((definition) => definition.length === 0)) {
    throw new Error(`legacy preservation malformed CREATE TABLE SQL for ${table}`);
  }
  return Object.freeze({
    prefix: sql.slice(0, opening + 1),
    definitions: Object.freeze(definitions),
    suffix: sql.slice(closing)
  });
}

function assertTableSqlSubset(expectedSql, actualSql, table, addedColumnCount) {
  if (actualSql === expectedSql) return;
  const expected = tableSqlParts(expectedSql, table);
  const actual = tableSqlParts(actualSql, table);
  if (actual.prefix !== expected.prefix || actual.suffix !== expected.suffix) {
    throw new Error(`legacy preservation table schema SQL framing drift for ${table}`);
  }
  let cursor = 0;
  for (const definition of expected.definitions) {
    const found = actual.definitions.indexOf(definition, cursor);
    if (found < 0) throw new Error(`legacy preservation table schema SQL definition drift for ${table}`);
    cursor = found + 1;
  }
  const addedDefinitions = actual.definitions.length - expected.definitions.length;
  if (addedDefinitions < 0 || addedDefinitions !== addedColumnCount) {
    throw new Error(`legacy preservation table schema SQL additive-shape drift for ${table}`);
  }
}

function safeIntegerRows(db, sql, params = []) {
  const statement = db.prepare(sql);
  if (typeof statement.safeIntegers === 'function') statement.safeIntegers(true);
  return statement.all(...params);
}

function indexEntries(db, table) {
  return safeIntegerRows(db, `
    SELECT seq,name,"unique" AS isUnique,origin,partial
    FROM pragma_index_list(?)
    ORDER BY seq,CAST(name AS BLOB)
  `, [table]).map((index) => Object.freeze({
    seq: index.seq,
    name: String(index.name),
    isUnique: index.isUnique,
    origin: String(index.origin),
    partial: index.partial,
    xinfo: Object.freeze(safeIntegerRows(db, `
      SELECT seqno,cid,name,"desc" AS isDescending,coll,"key" AS isKey
      FROM pragma_index_xinfo(?)
      ORDER BY seqno,cid,CAST(name AS BLOB)
    `, [index.name]).map((row) => Object.freeze([
      row.seqno,
      row.cid,
      row.name === null ? null : String(row.name),
      row.isDescending,
      row.coll === null ? null : String(row.coll),
      row.isKey
    ])))
  }));
}

function indexSubsetSignature(entries) {
  const records = entries.map((entry, index) => Buffer.concat([
    sqliteDigest.row([BigInt(index), entry.name, entry.isUnique, entry.origin, entry.partial]).subarray(8),
    sqliteDigest.item(
      'index_xinfo',
      sqliteDigest.list(entry.xinfo.map((values) => sqliteDigest.row(values).subarray(8)))
    )
  ]));
  return sqliteDigest.item('index_list', sqliteDigest.list(records));
}

function tableTopologyMetadata(db, table) {
  const row = db.prepare(`
    SELECT schema,name,type,ncol,wr,strict
    FROM pragma_table_list(?)
    WHERE schema='main' AND name=?
  `).get(table, table);
  if (!row) throw new Error(`legacy preservation missing table metadata for ${table}`);
  return Object.freeze({
    schema: String(row.schema),
    name: String(row.name),
    type: String(row.type),
    columnCount: Number(row.ncol),
    withoutRowid: Number(row.wr),
    strict: Number(row.strict)
  });
}

function sequenceRows(db) {
  const present = db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name='sqlite_sequence'").get();
  if (!present) return new Map();
  sqliteDigest._testing.tableRowsStream(db, 'sqlite_sequence');
  const rows = safeIntegerRows(db, 'SELECT name,seq FROM sqlite_sequence ORDER BY CAST(name AS BLOB)');
  return new Map(rows.map((row) => [
    String(row.name),
    Object.freeze({
      seq: row.seq,
      signature: sqliteDigest.row([String(row.name), row.seq])
    })
  ]));
}

function exactTableRowCount(db, table) {
  return safeIntegerRows(db, `SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`)[0].count;
}

function captureLegacyTopologyShape(db, tables) {
  const frozen = frozenTopologyProjection(db);
  const tableMetadata = new Map();
  const appendTableRowCounts = new Map();
  for (const table of tables) {
    const metadata = tableTopologyMetadata(db, table);
    const indexes = indexEntries(db, table);
    tableMetadata.set(table, Object.freeze({
      ...metadata,
      indexNames: Object.freeze(indexes.map((entry) => entry.name)),
      indexSignature: indexSubsetSignature(indexes)
    }));
    if (DETERMINISTIC_APPEND_TABLES.has(table)) {
      appendTableRowCounts.set(table, exactTableRowCount(db, table));
    }
  }
  return Object.freeze({
    format: LEGACY_TOPOLOGY_FORMAT,
    pragmas: frozen.pragmas,
    objects: frozen.objects,
    tables: tableMetadata,
    sequences: sequenceRows(db),
    appendTableRowCounts
  });
}

function assertLegacyTopologyPreserved(db, snapshot) {
  if (!snapshot || snapshot.format !== LEGACY_TOPOLOGY_FORMAT) {
    throw new Error('invalid legacy preservation topology snapshot');
  }
  const current = frozenTopologyProjection(db);
  if (!current.pragmas.equals(snapshot.pragmas)) {
    throw new Error('legacy preservation fixed pragma topology drift');
  }
  for (const [key, expected] of snapshot.objects) {
    const actual = current.objects.get(key);
    if (!actual) throw new Error(`legacy preservation topology missing ${expected.type} ${expected.name}`);
    if (actual.record.equals(expected.record)) continue;
    const tableMetadata = snapshot.tables.get(expected.name);
    if (
      expected.type !== 'table' ||
      expected.name === 'sqlite_sequence' ||
      !tableMetadata ||
      tableMetadata.type !== 'table'
    ) {
      throw new Error(`legacy preservation ${expected.type} SQL or metadata drift for ${expected.name}`);
    }
    const actualTable = tableTopologyMetadata(db, expected.name);
    if (
      actualTable.schema !== tableMetadata.schema ||
      actualTable.name !== tableMetadata.name ||
      actualTable.type !== tableMetadata.type ||
      actualTable.withoutRowid !== tableMetadata.withoutRowid ||
      actualTable.strict !== tableMetadata.strict ||
      actualTable.columnCount < tableMetadata.columnCount
    ) {
      throw new Error(`legacy preservation table topology metadata drift for ${expected.name}`);
    }
    assertTableSqlSubset(
      expected.sql,
      actual.sql,
      expected.name,
      actualTable.columnCount - tableMetadata.columnCount
    );
    const expectedNames = new Set(tableMetadata.indexNames);
    const actualIndexes = indexEntries(db, expected.name).filter((entry) => expectedNames.has(entry.name));
    if (
      actualIndexes.length !== tableMetadata.indexNames.length ||
      !indexSubsetSignature(actualIndexes).equals(tableMetadata.indexSignature)
    ) {
      throw new Error(`legacy preservation index metadata drift for ${expected.name}`);
    }
  }
  const currentSequences = sequenceRows(db);
  for (const [name, expected] of snapshot.sequences) {
    const actual = currentSequences.get(name);
    let expectedSignature = expected.signature;
    if (DETERMINISTIC_APPEND_TABLES.has(name) && snapshot.appendTableRowCounts.has(name)) {
      const appendedRows = exactTableRowCount(db, name) - snapshot.appendTableRowCounts.get(name);
      if (appendedRows < 0n) {
        throw new Error(`legacy preservation deterministic append row count drift for ${name}`);
      }
      expectedSignature = sqliteDigest.row([name, expected.seq + appendedRows]);
    }
    if (!actual || !actual.signature.equals(expectedSignature)) {
      throw new Error(`legacy preservation sqlite_sequence allocator drift for ${name}`);
    }
  }
  return true;
}

function tableInventory(db) {
  const rows = db.pragma('table_list');
  const allowedTypes = new Set(['table', 'view', 'virtual', 'shadow']);
  for (const row of rows) {
    if (row.schema === 'main' && !allowedTypes.has(row.type)) {
      throw new Error(`legacy preservation schema inventory type drift for ${row.name}`);
    }
  }
  return rows
    .filter((row) => row.schema === 'main' && row.type === 'table')
    .map((row) => String(row.name))
    .filter((name) => !name.startsWith('sqlite_') && !EXCLUDED_PRESERVATION_TABLES.has(name))
    .sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')));
}

function normalizedColumn(column) {
  return Object.freeze({
    cid: Number(column.cid),
    name: String(column.name),
    type: String(column.type || ''),
    notnull: Number(column.notnull),
    defaultSql: column.dflt_value === null ? null : String(column.dflt_value),
    pk: Number(column.pk),
    hidden: Number(column.hidden)
  });
}

function normalizedForeignKey(row) {
  return Object.freeze({
    id: Number(row.id),
    seq: Number(row.seq),
    table: String(row.table),
    from: String(row.from),
    to: row.to === null ? null : String(row.to),
    onUpdate: String(row.on_update),
    onDelete: String(row.on_delete),
    match: String(row.match)
  });
}

function tableShape(db, table, projectedColumnNames, includedPrimaryKeyDigests) {
  const inventoryColumns = db.pragma(`table_xinfo(${quoteIdentifier(table)})`).map(normalizedColumn);
  if (!inventoryColumns.length || inventoryColumns.some((column) => column.hidden !== 0)) {
    throw new Error(`legacy preservation cannot snapshot non-stored columns for ${table}`);
  }
  const inventoryByName = new Map(inventoryColumns.map((column) => [column.name, column]));
  const columns = projectedColumnNames === undefined
    ? inventoryColumns
    : projectedColumnNames.map((name) => inventoryByName.get(name)).filter(Boolean);
  if (projectedColumnNames !== undefined && columns.length !== projectedColumnNames.length) {
    throw new Error(`legacy preservation column drift for ${table}`);
  }
  const primaryKey = columns.filter((column) => column.pk > 0).sort((left, right) => left.pk - right.pk);
  if (!primaryKey.length) throw new Error(`legacy preservation requires an explicit primary key for ${table}`);
  const foreignKeys = db.pragma(`foreign_key_list(${quoteIdentifier(table)})`)
    .map(normalizedForeignKey)
    .sort((left, right) => left.id - right.id || left.seq - right.seq);
  const select = columns.flatMap((column, index) => [
    `${quoteIdentifier(column.name)} AS ${quoteIdentifier(`value_${index}`)}`,
    `typeof(${quoteIdentifier(column.name)}) AS ${quoteIdentifier(`type_${index}`)}`
  ]).join(',');
  const rows = db.prepare(`SELECT ${select} FROM ${quoteIdentifier(table)}`).all();
  const rowDigests = new Map();
  const columnGroups = columns.map(() => new Map());
  const storageCounts = columns.map(() => ({ null: 0, integer: 0, real: 0, text: 0, blob: 0 }));
  for (const row of rows) {
    const cells = columns.map((_column, index) => encodedStorageValue(row[`value_${index}`], row[`type_${index}`]));
    const projectedIndex = new Map(columns.map((column, index) => [column.name, index]));
    const keyCells = primaryKey.map((column) => cells[projectedIndex.get(column.name)]);
    const keyDigest = sha256Parts([Buffer.from('tm-legacy-pk-v1'), ...keyCells]);
    if (includedPrimaryKeyDigests && !includedPrimaryKeyDigests.has(keyDigest)) continue;
    if (rowDigests.has(keyDigest)) throw new Error(`legacy preservation duplicate primary key digest for ${table}`);
    rowDigests.set(keyDigest, sha256Parts([Buffer.from('tm-legacy-row-v1'), ...cells]));
    for (let index = 0; index < cells.length; index += 1) {
      const storageType = row[`type_${index}`];
      if (!Object.hasOwn(storageCounts[index], storageType)) {
        throw new Error(`legacy preservation unsupported storage class for ${table}.${columns[index].name}`);
      }
      storageCounts[index][storageType] += 1;
      const valueDigest = sha256Parts([Buffer.from('tm-legacy-value-v1'), cells[index]]);
      const members = columnGroups[index].get(valueDigest) || [];
      members.push(keyDigest);
      columnGroups[index].set(valueDigest, members);
    }
  }
  const columnStatistics = columns.map((column, index) => {
    const partitions = [...columnGroups[index].values()]
      .map((members) => members.sort())
      .sort((left, right) => left.join(',').localeCompare(right.join(',')));
    return Object.freeze({
      name: column.name,
      nullCount: storageCounts[index].null,
      storageCounts: Object.freeze(storageCounts[index]),
      cardinality: columnGroups[index].size,
      equalityPartitionSha256: sha256Parts([Buffer.from(JSON.stringify(partitions), 'utf8')])
    });
  });
  return Object.freeze({
    name: table,
    columns: Object.freeze(columns),
    primaryKey: Object.freeze(primaryKey.map((column) => column.name)),
    foreignKeys: Object.freeze(foreignKeys),
    rowCount: rows.length,
    rowDigests,
    columnStatistics: Object.freeze(columnStatistics)
  });
}

function captureLegacyLogicalShape(db) {
  const tableNames = tableInventory(db);
  const tables = tableNames.map((table) => tableShape(db, table));
  return Object.freeze({
    format: 'tm-legacy-logical-shape-v1',
    tableCount: tables.length,
    rowCount: tables.reduce((sum, table) => sum + table.rowCount, 0),
    tables: Object.freeze(tables),
    topology: captureLegacyTopologyShape(db, tableNames)
  });
}

function assertSameJson(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(message);
}

function assertLegacyLogicalShapePreserved(db, snapshot) {
  if (!snapshot || snapshot.format !== 'tm-legacy-logical-shape-v1') throw new Error('invalid legacy preservation snapshot');
  assertLegacyTopologyPreserved(db, snapshot.topology);
  const currentNames = new Set(tableInventory(db));
  for (const expected of snapshot.tables) {
    if (!currentNames.has(expected.name)) throw new Error(`legacy preservation schema missing table ${expected.name}`);
    const allowsDeterministicAppend = DETERMINISTIC_APPEND_TABLES.has(expected.name);
    const actual = tableShape(
      db,
      expected.name,
      expected.columns.map((column) => column.name),
      allowsDeterministicAppend ? new Set(expected.rowDigests.keys()) : undefined
    );
    const currentByName = new Map(actual.columns.map((column) => [column.name, column]));
    for (const column of expected.columns) {
      const current = currentByName.get(column.name);
      if (!current || stableMetadata(current) !== stableMetadata(column)) {
        throw new Error(`legacy preservation column drift for ${expected.name}.${column.name}`);
      }
    }
    assertSameJson(actual.primaryKey, expected.primaryKey, `legacy preservation primary key drift for ${expected.name}`);
    for (const relationship of expected.foreignKeys) {
      if (!actual.foreignKeys.some((candidate) => stableMetadata(candidate) === stableMetadata(relationship))) {
        throw new Error(`legacy preservation relationship drift for ${expected.name}`);
      }
    }
    if (allowsDeterministicAppend ? actual.rowCount < expected.rowCount : actual.rowCount !== expected.rowCount) {
      throw new Error(`legacy preservation row count drift for ${expected.name}`);
    }
    if (actual.rowDigests.size !== expected.rowDigests.size) {
      throw new Error(`legacy preservation row identity drift for ${expected.name}`);
    }
    for (const [keyDigest, rowDigest] of expected.rowDigests) {
      if (actual.rowDigests.get(keyDigest) !== rowDigest) throw new Error(`legacy preservation row equality drift for ${expected.name}`);
    }
    assertSameJson(
      actual.columnStatistics,
      expected.columnStatistics,
      `legacy preservation NULL/storage/equality/cardinality drift for ${expected.name}`
    );
  }
  return true;
}

function assertDigestEqual(left, right, context) {
  if (left.topologySha256 !== right.topologySha256) throw new Error(`${context} topology digest mismatch`);
  if (left.logicalSha256 !== right.logicalSha256) throw new Error(`${context} logical digest mismatch`);
  if (JSON.stringify(left.fts) !== JSON.stringify(right.fts)) throw new Error(`${context} FTS digest mismatch`);
}

function publicDigest(digest) {
  return Object.freeze({
    topologySha256: digest.topologySha256,
    logicalSha256: digest.logicalSha256,
    fts: Object.freeze(digest.fts.map((entry) => Object.freeze({
      virtualName: entry.virtualName,
      rowCount: entry.rowCount,
      sha256: entry.sha256
    })))
  });
}

function sidecarPaths(databasePath) {
  return ['-journal', '-wal', '-shm'].map((suffix) => `${databasePath}${suffix}`);
}

function assertCleanDatabaseFile(databasePath, label) {
  const resolved = path.resolve(databasePath);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`${label} must be a regular single-link file`);
  const sidecar = sidecarPaths(resolved).find((candidate) => fs.existsSync(candidate));
  if (sidecar) throw new Error(`${label} has forbidden SQLite sidecar`);
  return resolved;
}

function fsyncFile(filePath) {
  const fd = fs.openSync(filePath, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function restoreCleanCopy(sourcePath, destinationPath) {
  const source = assertCleanDatabaseFile(sourcePath, 'clean sanitized backup');
  const destination = path.resolve(destinationPath);
  if (source === destination || fs.existsSync(destination)) throw new Error('clean restore destination must be new and separate');
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, 0o600);
  fsyncFile(destination);
  assertCleanDatabaseFile(destination, 'restored sanitized database');
  return destination;
}

function assertByteIdenticalDatabaseFiles(referencePath, candidatePath, context) {
  const reference = fs.openSync(referencePath, 'r');
  const candidate = fs.openSync(candidatePath, 'r');
  try {
    const referenceStat = fs.fstatSync(reference);
    const candidateStat = fs.fstatSync(candidate);
    if (referenceStat.size !== candidateStat.size) {
      throw new Error(`${context} is not byte-identical to the exact sanitized version 1 input`);
    }
    const referenceBuffer = Buffer.allocUnsafe(1024 * 1024);
    const candidateBuffer = Buffer.allocUnsafe(referenceBuffer.length);
    let position = 0;
    while (position < referenceStat.size) {
      const length = Math.min(referenceBuffer.length, referenceStat.size - position);
      const referenceRead = fs.readSync(reference, referenceBuffer, 0, length, position);
      const candidateRead = fs.readSync(candidate, candidateBuffer, 0, length, position);
      if (
        referenceRead !== length ||
        candidateRead !== length ||
        !referenceBuffer.subarray(0, length).equals(candidateBuffer.subarray(0, length))
      ) {
        throw new Error(`${context} is not byte-identical to the exact sanitized version 1 input`);
      }
      position += length;
    }
  } finally {
    fs.closeSync(candidate);
    fs.closeSync(reference);
  }
  return true;
}

function differingLogicalTables(leftPath, rightPath) {
  const left = new Database(leftPath, { readonly: true, fileMustExist: true });
  const right = new Database(rightPath, { readonly: true, fileMustExist: true });
  try {
    const namesFor = (db) => db.pragma('table_list')
      .filter((row) => row.schema === 'main' && row.type === 'table' && !String(row.name).startsWith('sqlite_'))
      .map((row) => String(row.name))
      .sort();
    const leftNames = namesFor(left);
    const rightNames = namesFor(right);
    if (JSON.stringify(leftNames) !== JSON.stringify(rightNames)) return ['schema_inventory'];
    return leftNames.filter((name) => {
      const leftStream = sqliteDigest._testing.tableRowsStream(left, name);
      const rightStream = sqliteDigest._testing.tableRowsStream(right, name);
      return !leftStream.equals(rightStream);
    });
  } finally {
    left.close();
    right.close();
  }
}

function verifyFtsCanaries(db, options = {}) {
  if (options.readonly !== true) {
    sqliteDigest.verifyKnowledgeChunksFtsIntegrity(db, sanitizer.FTS_MANIFEST, { checkMainIntegrity: true });
  }
  return sanitizer.verifyDeterministicFtsCanaries(db);
}

function databaseDigestReadonly(databasePath) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('pre-migration integrity_check failed');
    if (db.pragma('foreign_key_check').length) throw new Error('pre-migration foreign_key_check failed');
    verifyFtsCanaries(db, { readonly: true });
    return sqliteDigest.databaseDigest(db, sanitizer.FTS_MANIFEST);
  } finally {
    db.close();
  }
}

function normalizedFrozenMigrationTimestamp(value) {
  const timestamp = value === undefined ? DEFAULT_FROZEN_MIGRATION_TIMESTAMP : value;
  if (typeof timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(timestamp)) {
    throw new Error('frozenMigrationTimestamp must be an exact SQLite UTC timestamp');
  }
  const parsed = new Date(`${timestamp.replace(' ', 'T')}Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 19).replace('T', ' ') !== timestamp
  ) {
    throw new Error('frozenMigrationTimestamp must be a valid SQLite UTC timestamp');
  }
  return timestamp;
}

function installFrozenMigrationClock(db, value) {
  const timestamp = normalizedFrozenMigrationTimestamp(value);
  const options = { deterministic: true };
  db.function('current_timestamp', options, () => timestamp);
  db.function('current_date', options, () => timestamp.slice(0, 10));
  db.function('current_time', options, () => timestamp.slice(11));
  return timestamp;
}

function migrateAndVerify(databasePath, legacySnapshot, sourceVersion, options = {}) {
  if (sourceVersion !== REQUIRED_SOURCE_VERSION) {
    throw new Error(`pre-Phase-4 sanitized source version must be exactly ${REQUIRED_SOURCE_VERSION}`);
  }
  const db = new Database(databasePath);
  try {
    installFrozenMigrationClock(db, options.frozenMigrationTimestamp);
    migrationService.runMigrations(db, migrationOptions());
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('migration integrity_check failed');
    if (db.pragma('foreign_key_check').length) throw new Error('migration foreign_key_check failed');
    assertLegacyLogicalShapePreserved(db, legacySnapshot);
    verifyFtsCanaries(db);
    const first = sqliteDigest.databaseDigest(db, sanitizer.FTS_MANIFEST);
    migrationService.runMigrations(db, migrationOptions());
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('migration rerun integrity_check failed');
    if (db.pragma('foreign_key_check').length) throw new Error('migration rerun foreign_key_check failed');
    assertLegacyLogicalShapePreserved(db, legacySnapshot);
    verifyFtsCanaries(db);
    const rerun = sqliteDigest.databaseDigest(db, sanitizer.FTS_MANIFEST);
    assertDigestEqual(first, rerun, 'migration no-op rerun');
    const classification = migrationService.classifyDatabase(db, classificationOptions());
    if (classification.status !== 'managed' || classification.currentVersion !== REQUIRED_TARGET_VERSION) {
      throw new Error('migration target classification mismatch');
    }
    return first;
  } finally {
    db.close();
  }
}

function verifySanitizedMigrationCopy(options) {
  if (!options || typeof options.sanitizedPath !== 'string') throw new Error('sanitizedPath is required');
  if (REGISTERED_MIGRATIONS.at(-1).version !== REQUIRED_TARGET_VERSION) {
    throw new Error(`migration verifier target must be exactly version ${REQUIRED_TARGET_VERSION}`);
  }
  const frozenMigrationTimestamp = normalizedFrozenMigrationTimestamp(options.frozenMigrationTimestamp);
  const sanitizedPath = assertCleanDatabaseFile(options.sanitizedPath, 'sanitized migration source');
  const workRoot = path.resolve(options.workDir || os.tmpdir());
  fs.mkdirSync(workRoot, { recursive: true, mode: 0o700 });
  const runDirectory = fs.mkdtempSync(path.join(workRoot, 'tm-migration-preservation-'));
  fs.chmodSync(runDirectory, 0o700);
  try {
    const cleanBackupPath = restoreCleanCopy(sanitizedPath, path.join(runDirectory, 'pre-migration-clean.db'));
    assertByteIdenticalDatabaseFiles(sanitizedPath, cleanBackupPath, 'clean pre-migration backup');
    const preMigration = databaseDigestReadonly(cleanBackupPath);
    const sourceDb = new Database(cleanBackupPath, { readonly: true, fileMustExist: true });
    let legacySnapshot;
    let sourceClassification;
    try {
      sourceClassification = migrationService.classifyDatabase(sourceDb, classificationOptions());
      if (
        sourceClassification.status !== 'managed' ||
        sourceClassification.currentVersion !== REQUIRED_SOURCE_VERSION
      ) {
        const actualVersion = sourceClassification.currentVersion === null
          ? sourceClassification.status
          : sourceClassification.currentVersion;
        throw new Error(
          `pre-Phase-4 sanitized source version must be exactly ${REQUIRED_SOURCE_VERSION}; got ${actualVersion}`
        );
      }
      legacySnapshot = captureLegacyLogicalShape(sourceDb);
    } finally {
      sourceDb.close();
    }
    if (legacySnapshot.rowCount < 1) throw new Error('populated migration gate requires legacy rows');

    const sourceVersion = REQUIRED_SOURCE_VERSION;
    const firstPath = restoreCleanCopy(cleanBackupPath, path.join(runDirectory, 'migration-run-one.db'));
    assertByteIdenticalDatabaseFiles(cleanBackupPath, firstPath, 'first migration restored input');
    const first = migrateAndVerify(firstPath, legacySnapshot, sourceVersion, { frozenMigrationTimestamp });

    const restoredPath = restoreCleanCopy(cleanBackupPath, path.join(runDirectory, 'migration-run-two-restored.db'));
    assertByteIdenticalDatabaseFiles(cleanBackupPath, restoredPath, 'second migration restored input');
    const restoredPreMigration = databaseDigestReadonly(restoredPath);
    assertDigestEqual(preMigration, restoredPreMigration, 'clean pre-migration restore');
    const restoredDb = new Database(restoredPath, { readonly: true, fileMustExist: true });
    try { assertLegacyLogicalShapePreserved(restoredDb, legacySnapshot); } finally { restoredDb.close(); }
    const second = migrateAndVerify(restoredPath, legacySnapshot, sourceVersion, { frozenMigrationTimestamp });
    try {
      assertDigestEqual(first, second, 'independent restored migration runs');
    } catch (error) {
      const tables = differingLogicalTables(firstPath, restoredPath);
      throw new Error(`${error.message}; differing tables=${tables.join(',') || 'none'}`);
    }
    assertByteIdenticalDatabaseFiles(sanitizedPath, cleanBackupPath, 'sanitized source after independent migrations');

    return Object.freeze({
      format: PRESERVATION_REPORT_VERSION,
      runs: 2,
      sourceVersion,
      targetVersion: REQUIRED_TARGET_VERSION,
      legacyTableCount: legacySnapshot.tableCount,
      legacyRowCount: legacySnapshot.rowCount,
      preMigration: publicDigest(preMigration),
      postMigration: publicDigest(first),
      preMigrationRestoreVerified: true,
      legacyPreservationVerified: true
    });
  } finally {
    fs.rmSync(runDirectory, { recursive: true, force: true });
  }
}

function migrateTwice(databasePath) {
  return verifySanitizedMigrationCopy({ sanitizedPath: databasePath }).postMigration;
}

function verifyCampaignMigrationGate(options) {
  if (!options || typeof options.sourcePath !== 'string') throw new Error('sourcePath is required');
  const workRoot = path.resolve(options.workDir || os.tmpdir());
  fs.mkdirSync(workRoot, { recursive: true, mode: 0o700 });
  const runDirectory = fs.mkdtempSync(path.join(workRoot, 'tm-campaign-migration-gate-'));
  fs.chmodSync(runDirectory, 0o700);
  try {
    const databasePath = path.join(runDirectory, 'sanitized-source.db');
    const sanitization = sanitizer.sanitizeProductionShape({
      sourcePath: options.sourcePath,
      outputPath: databasePath,
      manifestPath: options.manifestPath
    });
    const migration = verifySanitizedMigrationCopy({
      sanitizedPath: databasePath,
      workDir: runDirectory,
      frozenMigrationTimestamp: options.frozenMigrationTimestamp
    });
    return Object.freeze({
      format: REPORT_VERSION,
      runs: migration.runs,
      sourceVersion: migration.sourceVersion,
      targetVersion: migration.targetVersion,
      legacyTableCount: migration.legacyTableCount,
      legacyRowCount: migration.legacyRowCount,
      legacyPreservationVerified: migration.legacyPreservationVerified,
      preMigrationRestoreVerified: migration.preMigrationRestoreVerified,
      tableCount: sanitization.tableCount,
      rowCount: sanitization.rowCount,
      classifiedValueCount: sanitization.classifiedValueCount,
      outputSha256: sanitization.outputSha256,
      ftsCanaryCount: sanitization.ftsCanaryCount,
      ftsCanarySha256: sanitization.ftsCanarySha256,
      preMigration: migration.preMigration,
      topologySha256: migration.postMigration.topologySha256,
      logicalSha256: migration.postMigration.logicalSha256,
      fts: migration.postMigration.fts.map((entry) => ({ virtualName: entry.virtualName, sha256: entry.sha256 }))
    });
  } finally {
    fs.rmSync(runDirectory, { recursive: true, force: true });
  }
}

function parseCli(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key || !key.startsWith('--') || value === undefined) throw new Error('expected --source and optional --manifest/--work-dir');
    if (key === '--source') options.sourcePath = value;
    else if (key === '--manifest') options.manifestPath = value;
    else if (key === '--work-dir') options.workDir = value;
    else throw new Error(`unknown argument ${key}`);
  }
  return options;
}

if (require.main === module) {
  try {
    const report = verifyCampaignMigrationGate(parseCli(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    process.stderr.write(`campaign migration gate failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  REGISTERED_MIGRATIONS,
  REPORT_VERSION,
  PRESERVATION_REPORT_VERSION,
  migrateTwice,
  verifyCampaignMigrationGate,
  verifySanitizedMigrationCopy,
  _testing: Object.freeze({
    assertByteIdenticalDatabaseFiles,
    assertLegacyLogicalShapePreserved,
    assertLegacyTopologyPreserved,
    captureLegacyLogicalShape,
    captureLegacyTopologyShape,
    installFrozenMigrationClock,
    restoreCleanCopy
  })
};

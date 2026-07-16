const SAFE_MAX = Number.MAX_SAFE_INTEGER;
const allowedBuiltinModules = Object.freeze([
  'crypto',
  'node:crypto'
]);

function assertSafePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > SAFE_MAX) {
    throw new Error(`${label} must be a positive JavaScript-safe integer`);
  }
}

function assertSafeNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > SAFE_MAX) {
    throw new Error(`${label} must be a non-negative JavaScript-safe integer`);
  }
}

function tableColumns(db, tableName) {
  return db.prepare(`PRAGMA table_info(${JSON.stringify(tableName)})`).all();
}

function hasColumn(db, tableName, columnName) {
  return tableColumns(db, tableName).some((column) => column.name === columnName);
}

function addColumnIfMissing(db, tableName, definition) {
  const columnName = definition.trim().split(/\s+/)[0].replace(/"/g, '');
  if (!hasColumn(db, tableName, columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`);
  }
}

function createIndex(db, sql) {
  db.exec(sql);
}

module.exports = {
  version: 1,
  allowedBuiltinModules,
  SAFE_MAX,
  assertSafePositiveInteger,
  assertSafeNonNegativeInteger,
  tableColumns,
  hasColumn,
  addColumnIfMissing,
  createIndex
};

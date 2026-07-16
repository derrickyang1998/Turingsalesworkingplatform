const Database = require('better-sqlite3');

module.exports = {
  version: 5,
  name: 'bare_import_probe',
  sourcePath: 'tests/fixtures/bare_import_probe_migration.js',
  engineVersion: 1,
  dependencies: [],
  apply(db) {
    if (!Database) throw new Error('bare import did not load');
    db.exec('CREATE TABLE bare_import_probe (id INTEGER PRIMARY KEY) STRICT;');
  }
};

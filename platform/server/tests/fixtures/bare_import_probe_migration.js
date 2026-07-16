const Database = require('better-sqlite3');

module.exports = {
  version: 2,
  name: 'bare_import_probe',
  sourcePath: 'tests/fixtures/bare_import_probe_migration.js',
  engineVersion: 1,
  dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js'],
  apply(db) {
    if (!Database) throw new Error('bare import did not load');
    db.exec('CREATE TABLE bare_import_probe (id INTEGER PRIMARY KEY) STRICT;');
  }
};

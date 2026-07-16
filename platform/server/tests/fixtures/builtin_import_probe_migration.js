const path = require('node:path');

module.exports = {
  version: 6,
  name: 'builtin_import_probe',
  sourcePath: 'tests/fixtures/builtin_import_probe_migration.js',
  engineVersion: 1,
  dependencies: [],
  schemaManifest: {
    columns: {
      builtin_import_probe: {
        id: { type: 'INTEGER', notnull: 0, defaultValue: null }
      }
    },
    indexes: {},
    triggers: {}
  },
  apply(db) {
    const tableName = path.basename('builtin_import_probe');
    db.exec(`CREATE TABLE ${tableName} (id INTEGER PRIMARY KEY) STRICT;`);
  }
};

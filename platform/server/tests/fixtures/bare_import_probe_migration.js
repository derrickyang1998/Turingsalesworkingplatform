const externalRequire = typeof globalThis.require === 'function'
  ? globalThis.require
  : typeof process.getBuiltinModule === 'function'
    ? process.getBuiltinModule('node:module').createRequire(__filename)
    : require('node:module').createRequire(__filename);
const Database = externalRequire('better-sqlite3');

module.exports = {
  version: 2,
  name: 'bare_import_probe',
  sourcePath: 'tests/fixtures/bare_import_probe_migration.js',
  engineVersion: 1,
  dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js'],
  schemaManifest: {
    columns: {
      bare_import_probe: {
        id: { type: 'INTEGER', notnull: 0, defaultValue: null }
      }
    },
    indexes: {},
    triggers: {}
  },
  apply(db) {
    if (!Database) throw new Error('ambient global require did not load');
    db.exec('CREATE TABLE bare_import_probe (id INTEGER PRIMARY KEY) STRICT;');
  }
};

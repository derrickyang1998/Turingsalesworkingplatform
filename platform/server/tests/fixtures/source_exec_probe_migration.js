module.exports = {
  version: 2,
  name: 'inline_apply_must_not_run',
  sourcePath: 'tests/fixtures/source_exec_probe_migration.js',
  engineVersion: 1,
  dependencies: [],
  schemaManifest: {
    columns: {
      source_apply_executed: {
        id: { type: 'INTEGER', notnull: 0, defaultValue: null }
      }
    },
    indexes: {},
    triggers: {}
  },
  apply(db) {
    db.exec('CREATE TABLE source_apply_executed (id INTEGER PRIMARY KEY) STRICT;');
  }
};

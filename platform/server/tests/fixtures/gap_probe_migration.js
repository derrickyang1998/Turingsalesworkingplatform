module.exports = {
  version: 3,
  name: 'gap_probe',
  sourcePath: 'tests/fixtures/gap_probe_migration.js',
  engineVersion: 1,
  dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js'],
  schemaManifest: {
    columns: {
      gap_probe: {
        id: { type: 'INTEGER', notnull: 0, defaultValue: null }
      }
    },
    indexes: {},
    triggers: {}
  },
  apply(db) {
    db.exec('CREATE TABLE gap_probe (id INTEGER PRIMARY KEY) STRICT;');
  }
};

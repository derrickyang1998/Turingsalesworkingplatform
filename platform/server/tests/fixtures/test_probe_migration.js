module.exports = {
  version: 2,
  name: 'test_probe',
  sourcePath: 'tests/fixtures/test_probe_migration.js',
  engineVersion: 1,
  dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js'],
  schemaManifest: {
    columns: {
      probe_table: {
        id: { type: 'INTEGER', notnull: 0, defaultValue: null }
      }
    },
    indexes: {},
    triggers: {}
  },
  apply(db) {
    db.exec('CREATE TABLE probe_table (id INTEGER PRIMARY KEY) STRICT;');
  }
};

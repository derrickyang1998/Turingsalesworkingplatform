module.exports = {
  version: 2,
  name: 'final_verification_probe',
  sourcePath: 'tests/fixtures/final_verification_probe_migration.js',
  engineVersion: 1,
  dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js'],
  schemaManifest: {
    columns: {
      final_verification_probe: {
        id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        required_value: { type: 'TEXT', notnull: 1, defaultValue: null }
      }
    },
    indexes: {},
    triggers: {}
  },
  apply(db) {
    db.exec('CREATE TABLE final_verification_probe (id INTEGER PRIMARY KEY) STRICT;');
  }
};

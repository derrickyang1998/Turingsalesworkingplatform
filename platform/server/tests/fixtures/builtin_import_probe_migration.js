const crypto = require('node:crypto');

module.exports = {
  version: 2,
  name: 'builtin_import_probe',
  sourcePath: 'tests/fixtures/builtin_import_probe_migration.js',
  engineVersion: 1,
  dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js'],
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
    const digest = crypto.createHash('sha256').update('builtin_import_probe').digest('hex');
    if (digest.length !== 64) throw new Error('sha256 facade returned an invalid digest');
    db.exec('CREATE TABLE builtin_import_probe (id INTEGER PRIMARY KEY) STRICT;');
  }
};

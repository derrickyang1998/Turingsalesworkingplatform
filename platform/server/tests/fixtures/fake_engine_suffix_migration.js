const fakeEngine = require('./fake/engines/v1');

module.exports = {
  version: 4,
  name: 'fake_engine_probe',
  sourcePath: 'tests/fixtures/fake_engine_suffix_migration.js',
  engineVersion: 1,
  dependencies: ['tests/fixtures/fake/engines/v1.js'],
  apply(db) {
    fakeEngine.apply(db);
  }
};

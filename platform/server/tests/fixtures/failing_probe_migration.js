module.exports = {
  version: 99,
  name: 'failing_probe',
  sourcePath: 'tests/fixtures/failing_probe_migration.js',
  engineVersion: 1,
  dependencies: [],
  apply() {
    throw new Error('injected migration failure');
  }
};

module.exports = {
  version: 2,
  name: 'failing_probe',
  sourcePath: 'tests/fixtures/failing_probe_migration.js',
  engineVersion: 1,
  dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js'],
  apply() {
    throw new Error('injected migration failure');
  }
};

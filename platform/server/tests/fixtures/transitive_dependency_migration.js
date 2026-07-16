const declared = require('./declared_dependency');

module.exports = {
  version: 3,
  name: 'transitive_dependency_probe',
  sourcePath: 'tests/fixtures/transitive_dependency_migration.js',
  engineVersion: 1,
  dependencies: ['tests/fixtures/declared_dependency.js'],
  apply(db) {
    declared.apply(db);
  }
};

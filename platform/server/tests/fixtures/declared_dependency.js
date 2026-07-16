const hidden = require('./undeclared_transitive_dependency');

module.exports = {
  apply(db) {
    hidden.apply(db);
  }
};

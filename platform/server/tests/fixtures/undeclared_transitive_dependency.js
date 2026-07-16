module.exports = {
  apply(db) {
    db.exec('CREATE TABLE undeclared_transitive_executed (id INTEGER PRIMARY KEY) STRICT;');
  }
};

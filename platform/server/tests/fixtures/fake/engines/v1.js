module.exports = {
  apply(db) {
    db.exec('CREATE TABLE fake_engine_executed (id INTEGER PRIMARY KEY) STRICT;');
  }
};

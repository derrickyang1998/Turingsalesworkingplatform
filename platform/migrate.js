var d = require('./db');
d.init().then(function(w) {
  var cols = ['status TEXT DEFAULT "active"', 'last_activity TEXT', 'claim_deadline TEXT', 'opportunity_value INTEGER DEFAULT 0', 'win_probability INTEGER DEFAULT 0', 'expected_close_date TEXT', 'priority TEXT DEFAULT "medium"'];
  cols.forEach(function(c) {
    try { w.exec('ALTER TABLE customers ADD COLUMN ' + c); } catch(e) {}
  });
  w.exec('CREATE TABLE IF NOT EXISTS customer_activities (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, user_id INTEGER, type TEXT, content TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
  console.log('Migration done');
  process.exit(0);
}).catch(function(e) { console.error(e); process.exit(1); });

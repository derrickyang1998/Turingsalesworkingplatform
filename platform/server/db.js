// Database setup
const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const db = new Database(path.join(__dirname, 'db', 'turingmarket.db'));
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    email TEXT,
    department TEXT,
    api_quota INTEGER DEFAULT 50000,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME,
    is_active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT UNIQUE NOT NULL,
    ip_address TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS demands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    brand_name TEXT,
    company_name TEXT,
    product_name TEXT,
    industry TEXT,
    budget TEXT,
    target_market TEXT,
    platform TEXT,
    status TEXT DEFAULT 'draft',
    data_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    demand_id INTEGER,
    template_id TEXT,
    content TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (demand_id) REFERENCES demands(id)
  );

  CREATE TABLE IF NOT EXISTS token_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    model TEXT NOT NULL,
    prompt_tokens INTEGER DEFAULT 0,
    completion_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    endpoint TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    module TEXT,
    details TEXT,
    ip_address TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS team_invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    created_by INTEGER NOT NULL,
    role TEXT DEFAULT 'user',
    max_uses INTEGER DEFAULT 1,
    uses INTEGER DEFAULT 0,
    expires_at DATETIME,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id)
  );
`);

// Seed default admin and team users
const salt = bcrypt.genSaltSync(10);
const defaultPassword = bcrypt.hashSync('turing2026', salt);

const existingAdmin = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
if (!existingAdmin) {
  const insertUser = db.prepare('INSERT INTO users (username, password_hash, display_name, role, email, department, api_quota) VALUES (?, ?, ?, ?, ?, ?, ?)');
  
  // Admin
  insertUser.run('admin', defaultPassword, '管理员', 'admin', 'admin@turingmarket.cn', '管理', 200000);
  
  // 10 team members
  const teamMembers = [
    ['zhangwei', '张伟', 'user', 'zhangwei@turingmarket.cn', '商务一部'],
    ['wangfang', '王芳', 'user', 'wangfang@turingmarket.cn', '商务一部'],
    ['liming', '李明', 'user', 'liming@turingmarket.cn', '商务二部'],
    ['zhaoli', '赵丽', 'user', 'zhaoli@turingmarket.cn', '商务二部'],
    ['chenyu', '陈宇', 'user', 'chenyu@turingmarket.cn', '商务三部'],
    ['liuxue', '刘雪', 'user', 'liuxue@turingmarket.cn', '运营部'],
    ['huanghe', '黄河', 'user', 'huanghe@turingmarket.cn', '运营部'],
    ['sunpeng', '孙鹏', 'user', 'sunpeng@turingmarket.cn', '红人组'],
    ['zhoujie', '周杰', 'user', 'zhoujie@turingmarket.cn', '红人组'],
    ['wulei', '吴磊', 'user', 'wulei@turingmarket.cn', '策略组'],
  ];
  
  teamMembers.forEach(([username, displayName, role, email, dept]) => {
    try { insertUser.run(username, defaultPassword, displayName, role, email, dept, 50000); } catch(e) {}
  });
  
  console.log('✅ Database seeded with admin + 10 team members');
}

module.exports = db;
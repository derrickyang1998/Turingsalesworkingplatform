const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3002;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'db', 'turingmarket.db');
const JWT_SECRET = process.env.JWT_SECRET || 'turingmarket-platform-jwt-secret-2026';
const TOKEN_EXPIRY = '24h';

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve static files from parent directory
app.use(express.static(path.join(__dirname, '..'), { etag: false, lastModified: false, setHeaders: function(res) { res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate'); res.set('Pragma', 'no-cache'); res.set('Expires', '0'); } }));

// File upload config
const upload = multer({ 
  dest: path.join(__dirname, '..', 'uploads'),
  limits: { fileSize: 50 * 1024 * 1024 }
});

// ===== AUTH MIDDLEWARE =====
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
  if (!token) return res.status(401).json({ error: 'No token provided' });
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const session = db.prepare(`SELECT * FROM sessions WHERE token = ? AND expires_at > datetime('now')`).get(token);
    if (!session) return res.status(401).json({ error: 'Session expired' });
    
    const user = db.prepare('SELECT id, username, display_name, role, department, api_quota FROM users WHERE id = ? AND is_active = 1').get(decoded.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });
    
    req.user = user;
    next();
  } catch(e) { return res.status(401).json({ error: 'Invalid token' }); }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// ===== AUTH ROUTES =====
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(username);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  
  const valid = bcrypt.compareSync(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
  
  // Create session
  const token = jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (user_id, token, ip_address, expires_at) VALUES (?, ?, ?, ?)').run(user.id, token, req.ip, expiresAt);
  db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
  
  // Log activity
  db.prepare('INSERT INTO activity_log (user_id, action, module, ip_address) VALUES (?, ?, ?, ?)').run(user.id, 'login', 'auth', req.ip);
  
  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      role: user.role,
      department: user.department,
      api_quota: user.api_quota
    }
  });
});

app.post('/api/auth/logout', authMiddleware, (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  db.prepare('INSERT INTO activity_log (user_id, action, module, ip_address) VALUES (?, ?, ?, ?)').run(req.user.id, 'logout', 'auth', req.ip);
  res.json({ success: true });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

// ===== DEMAND ROUTES =====
app.post('/api/demands', authMiddleware, (req, res) => {
  const { brand_name, company_name, product_name, industry, budget, target_market, platform, data_json } = req.body;
  const result = db.prepare('INSERT INTO demands (user_id, brand_name, company_name, product_name, industry, budget, target_market, platform, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    req.user.id, brand_name, company_name, product_name, industry, budget, target_market, platform, JSON.stringify(data_json)
  );
  db.prepare('INSERT INTO activity_log (user_id, action, module, details, ip_address) VALUES (?, ?, ?, ?, ?)').run(req.user.id, 'create_demand', 'demand', `Created demand for ${brand_name}`, req.ip);
  res.json({ id: result.lastInsertRowid });
});

app.get('/api/demands', authMiddleware, (req, res) => {
  const demands = req.user.role === 'admin' 
    ? db.prepare('SELECT d.*, u.display_name, u.department FROM demands d JOIN users u ON d.user_id = u.id ORDER BY d.created_at DESC LIMIT 200').all()
    : db.prepare('SELECT * FROM demands WHERE user_id = ? ORDER BY created_at DESC LIMIT 200').all(req.user.id);
  res.json({ demands });
});

// ===== PROPOSAL ROUTES =====
app.post('/api/proposals', authMiddleware, (req, res) => {
  const { demand_id, template_id, content } = req.body;
  const result = db.prepare('INSERT INTO proposals (user_id, demand_id, template_id, content) VALUES (?, ?, ?, ?)').run(req.user.id, demand_id, template_id, content);
  db.prepare('INSERT INTO activity_log (user_id, action, module, details, ip_address) VALUES (?, ?, ?, ?, ?)').run(req.user.id, 'generate_proposal', 'proposal', `Generated proposal with template ${template_id}`, req.ip);
  res.json({ id: result.lastInsertRowid });
});

app.get('/api/proposals', authMiddleware, (req, res) => {
  const proposals = req.user.role === 'admin'
    ? db.prepare('SELECT p.*, u.display_name FROM proposals p JOIN users u ON p.user_id = u.id ORDER BY p.created_at DESC LIMIT 200').all()
    : db.prepare('SELECT * FROM proposals WHERE user_id = ? ORDER BY created_at DESC LIMIT 200').all(req.user.id);
  res.json({ proposals });
});

// ===== TOKEN TRACKING =====
app.post('/api/token-usage', authMiddleware, (req, res) => {
  const { model, prompt_tokens, completion_tokens, total_tokens, endpoint } = req.body;
  db.prepare('INSERT INTO token_usage (user_id, model, prompt_tokens, completion_tokens, total_tokens, endpoint) VALUES (?, ?, ?, ?, ?, ?)').run(
    req.user.id, model, prompt_tokens, completion_tokens, total_tokens, endpoint
  );
  res.json({ success: true });
});

app.get('/api/token-usage', authMiddleware, (req, res) => {
  const usage = req.user.role === 'admin'
    ? db.prepare(`
        SELECT u.username, u.display_name, u.department, 
               COALESCE(SUM(tu.total_tokens), 0) as total_tokens,
               COALESCE(SUM(tu.prompt_tokens), 0) as prompt_tokens,
               COALESCE(SUM(tu.completion_tokens), 0) as completion_tokens,
               COUNT(tu.id) as request_count,
               MAX(tu.created_at) as last_used
        FROM users u LEFT JOIN token_usage tu ON u.id = tu.user_id
        GROUP BY u.id ORDER BY total_tokens DESC
      `).all()
    : db.prepare('SELECT * FROM token_usage WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(req.user.id);
  res.json({ usage });
});

// ===== ADMIN DASHBOARD =====
app.get('/api/admin/overview', authMiddleware, adminOnly, (req, res) => {
  const stats = {
    totalUsers: db.prepare('SELECT COUNT(*) as count FROM users WHERE is_active = 1').get().count,
    totalDemands: db.prepare('SELECT COUNT(*) as count FROM demands').get().count,
    totalProposals: db.prepare('SELECT COUNT(*) as count FROM proposals').get().count,
    totalTokens: db.prepare('SELECT COALESCE(SUM(total_tokens), 0) as total FROM token_usage').get().total,
    activeSessions: db.prepare(`SELECT COUNT(*) as count FROM sessions WHERE expires_at > datetime('now')`).get().count,
    todayLogins: db.prepare(`SELECT COUNT(DISTINCT user_id) as count FROM activity_log WHERE action = 'login' AND date(created_at) = date('now')`).get().count,
    demandsByStatus: db.prepare('SELECT status, COUNT(*) as count FROM demands GROUP BY status').all(),
    demandsByUser: db.prepare('SELECT u.display_name, u.department, COUNT(d.id) as count FROM users u LEFT JOIN demands d ON u.id = d.user_id GROUP BY u.id ORDER BY count DESC').all(),
    recentActivity: db.prepare('SELECT a.*, u.display_name FROM activity_log a JOIN users u ON a.user_id = u.id ORDER BY a.created_at DESC LIMIT 50').all(),
    tokenUsageTrend: db.prepare('SELECT date(created_at) as date, SUM(total_tokens) as tokens FROM token_usage GROUP BY date(created_at) ORDER BY date DESC LIMIT 30').all(),
  };
  res.json({ stats });
});

// ===== USER MANAGEMENT (Admin) =====
app.get('/api/admin/users', authMiddleware, adminOnly, (req, res) => {
  const users = db.prepare('SELECT id, username, display_name, role, department, email, api_quota, created_at, last_login, is_active FROM users ORDER BY department, id').all();
  res.json({ users });
});

app.post('/api/admin/users', authMiddleware, adminOnly, (req, res) => {
  const { username, display_name, role, department, email } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });
  const salt = bcrypt.genSaltSync(10);
  const hash = bcrypt.hashSync('turing2026', salt);
  try {
    const result = db.prepare('INSERT INTO users (username, password_hash, display_name, role, email, department) VALUES (?, ?, ?, ?, ?, ?)')
      .run(username, hash, display_name || username, role || 'user', email || '', department || '');
    res.json({ id: result.lastInsertRowid });
  } catch(e) {
    res.status(400).json({ error: 'Username may already exist' });
  }
});

app.put('/api/admin/users/:id', authMiddleware, adminOnly, (req, res) => {
  const { display_name, department, api_quota, is_active, role } = req.body;
  db.prepare('UPDATE users SET display_name = COALESCE(?, display_name), department = COALESCE(?, department), api_quota = COALESCE(?, api_quota), is_active = COALESCE(?, is_active), role = COALESCE(?, role) WHERE id = ?').run(display_name, department, api_quota, is_active, role, req.params.id);
  res.json({ success: true });
});

app.delete('/api/admin/users/:id', authMiddleware, adminOnly, (req, res) => {
  db.prepare("UPDATE users SET is_active = 0 WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

app.post('/api/admin/users/reset-password/:id', authMiddleware, adminOnly, (req, res) => {
  const salt = bcrypt.genSaltSync(10);
  const hash = bcrypt.hashSync('turing2026', salt);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.params.id);
  res.json({ success: true, message: 'Password reset to turing2026' });
});

// ===== INVITE SYSTEM =====
app.post('/api/admin/invites', authMiddleware, adminOnly, (req, res) => {
  const code = 'TM' + Math.random().toString(36).substring(2, 8).toUpperCase();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO team_invites (code, created_by, role, expires_at) VALUES (?, ?, ?, ?)').run(code, req.user.id, 'user', expiresAt);
  res.json({ code, expires_at: expiresAt });
});

// ===== PPT GENERATION =====
app.post('/api/proposal/generate-ppt', authMiddleware, (req, res) => {
  const path = require('path');
  const fs = require('fs');
  const cp = require('child_process');
  const tmpDir = path.join(__dirname, '..', 'tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const dataPath = path.join(tmpDir, 'ppt_data_' + Date.now() + '.json');
  const outPath = path.join(tmpDir, 'proposal_' + Date.now() + '.pptx');
  fs.writeFileSync(dataPath, JSON.stringify(req.body));
  try {
    cp.execSync('python3 "' + path.join(__dirname, 'generate_ppt.py') + '" "' + dataPath + '" "' + outPath + '"', { timeout: 30000, cwd: __dirname });
    fs.unlinkSync(dataPath);
    res.download(outPath, 'proposal.pptx', function() { try { fs.unlinkSync(outPath); } catch(e) {} });
  } catch (e) {
    try { fs.unlinkSync(dataPath); } catch(e2) {}
    res.status(500).json({ error: 'PPT generation failed: ' + e.message });
  }
});


// ===== INFLUENCER & COLLABORATION ROUTES =====
require('./routes')(app, db, authMiddleware);
require('./routes_customers')(app, db, authMiddleware);
require('./routes_brands')(app, db, authMiddleware);

// ===== WORKFLOW ENGINE ROUTES =====
require('./routes_workflow')(app, db, authMiddleware, adminOnly);


// ===== KNOWLEDGE BASE ROUTES =====
app.get('/api/knowledge', authMiddleware, (req, res) => {
  try {
    const { type, search } = req.query;
    let sql = 'SELECT * FROM knowledge_entries WHERE 1=1';
    let params = [];
    if (type) { sql += ' AND entry_type = ?'; params.push(type); }
    if (search) { sql += ' AND (key_terms LIKE ? OR content LIKE ?)'; params.push('%' + search + '%', '%' + search + '%'); }
    if (req.user.role !== 'admin') { sql += ' AND (created_by = ? OR is_public = 1)'; params.push(req.user.id); }
    sql += ' ORDER BY usage_count DESC, created_at DESC LIMIT 100';
    const entries = db.prepare(sql).all(...params);
    res.json({ entries });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/knowledge', authMiddleware, (req, res) => {
  try {
    const { entry_type, title, content, tags, source_type, source_id } = req.body;
    const result = db.prepare('INSERT INTO knowledge_entries (entry_type, source_type, source_id, key_terms, content, created_by, is_public) VALUES (?, ?, ?, ?, ?, ?, 1)')
      .run(entry_type || 'note', source_type || null, source_id || null, JSON.stringify(tags || []), content || '', req.user.id);
    res.json({ id: result.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/knowledge/:id/use', authMiddleware, (req, res) => {
  db.prepare('UPDATE knowledge_entries SET usage_count = usage_count + 1, updated_at = datetime('now') WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ===== SALES DASHBOARD =====
app.get('/api/dashboard/sales', authMiddleware, (req, res) => {
  try {
    const userFilter = req.user.role !== 'admin' ? ' WHERE assigned_to = ' + req.user.id : '';
    const stats = {
      totalCustomers: db.prepare('SELECT COUNT(*) as count FROM customers' + userFilter).get().count,
      activeDeals: db.prepare("SELECT COUNT(*) as count FROM customers WHERE stage IN ('lead','info_confirmed','advantage_shared','needs_confirmed','analysis','proposal','kol_matching','cooperation')" + userFilter).get().count,
      wonDeals: db.prepare("SELECT COUNT(*) as count FROM customers WHERE stage='won'" + userFilter).get().count,
      totalPipeline: db.prepare("SELECT COALESCE(SUM(COALESCE(opportunity_value,0)),0) as total FROM customers WHERE stage IN ('lead','info_confirmed','advantage_shared','needs_confirmed','analysis','proposal','kol_matching','cooperation')" + userFilter).get().total,
      stageDistribution: db.prepare('SELECT stage, COUNT(*) as count, COALESCE(SUM(COALESCE(opportunity_value,0)),0) as value FROM customers' + userFilter + ' GROUP BY stage').all(),
      monthlyTrend: db.prepare("SELECT strftime('%Y-%m', created_at) as month, COUNT(*) as count FROM customers" + userFilter + " GROUP BY month ORDER BY month DESC LIMIT 12").all(),
      topUsers: db.prepare('SELECT u.display_name, u.department, COUNT(c.id) as deals FROM users u LEFT JOIN customers c ON c.assigned_to = u.id AND c.stage='won' GROUP BY u.id ORDER BY deals DESC LIMIT 10').all()
    };
    res.json({ stats });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// ===== WORKFLOW ENGINE INIT =====
const workflowEngine = require('./workflow_engine');
workflowEngine.initEngine();

// ===== HEALTH CHECK =====
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ===== SPA FALLBACK =====
app.get('/{*path}', (req, res) => { res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate'); res.set('Pragma', 'no-cache'); res.set('Expires', '0');
  re
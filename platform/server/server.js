const express = require('express');
const cors = require('cors');
const path = require('path');
const runtimeConfig = require('./config/runtime_config');
runtimeConfig.loadPlatformEnvironment();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const crypto = require('crypto');
const db = require('./db');
const knowledgeService = require('./services/knowledge_service');
const aiService = require('./services/ai_service');
const fileIngestService = require('./services/file_ingest_service');
const obsidianIngestService = require('./services/obsidian_ingest_service');
const businessKnowledge = require('./services/business_knowledge_service');
const vaultExportService = require('./services/vault_export_service');
const crmAccess = require('./services/crm_access_service');
const latestUiCompat = require('./services/latest_ui_compat_service');
const influencerWorkflow = require('./services/influencer_workflow_service');
const publicAssets = require('./services/public_assets_service');
const credentialRotation = require('./services/credential_rotation_service');
const app = express();
app.set('trust proxy', 'loopback');
const PORT = process.env.PORT || 3002;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'db', 'turingmarket.db');
const DEFAULT_DEV_JWT_SECRET = 'turingmarket-platform-jwt-secret-2026';
if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || process.env.JWT_SECRET === DEFAULT_DEV_JWT_SECRET || /please-change/i.test(process.env.JWT_SECRET))) {
  throw new Error('JWT_SECRET must be configured to a strong private value in production');
}
const JWT_SECRET = process.env.JWT_SECRET || DEFAULT_DEV_JWT_SECRET;
const TOKEN_EXPIRY = '24h';
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const ALLOWED_UPLOAD_EXTS = new Set([
  '.txt', '.md', '.csv', '.json', '.xlsx', '.xlsm', '.xls',
  '.pdf', '.docx', '.pptx',
  '.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff'
]);
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve only the browser assets required by the platform UI.
publicAssets.registerPublicAssets(app, express, path.join(__dirname, '..'));

// File upload config
const upload = multer({
  dest: UPLOAD_DIR,
  limits: {
    fileSize: 15 * 1024 * 1024,
    files: 1,
    fields: 20,
    parts: 25,
    fieldSize: 256 * 1024
  },
  fileFilter: function(req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_UPLOAD_EXTS.has(ext)) {
      return cb(new Error('Unsupported file type. Supported: TXT, MD, CSV, JSON, XLSX/XLSM/XLS, PDF, DOCX, PPTX, images.'));
    }
    cb(null, true);
  }
});

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false
});

const uploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false
});

// ===== AUTH MIDDLEWARE =====
function bearerTokenFromAuthorization(authorization) {
  if (typeof authorization !== 'string') return null;
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  return match ? match[1] : null;
}

function authMiddleware(req, res, next) {
  const token = bearerTokenFromAuthorization(req.headers.authorization);
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

function boolParam(value, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return value === true || value === 'true' || value === '1' || value === 1;
}

function hashPassword(password) {
  const salt = bcrypt.genSaltSync(10);
  return bcrypt.hashSync(password, salt);
}

function resolveUserCreationPassword(body) {
  const hasSuppliedPassword = Object.prototype.hasOwnProperty.call(body || {}, 'password');
  const password = hasSuppliedPassword
    ? String(body.password || '')
    : credentialRotation.generateTemporaryPassword();
  const policyErrors = credentialRotation.passwordPolicyErrors(password);
  return {
    hasSuppliedPassword,
    password,
    policyErrors
  };
}

function redactSecretValue(value, secret) {
  if (value === undefined || value === null) return value;
  const secretText = String(secret || '');
  if (!secretText) return String(value);
  return String(value).split(secretText).join('[REDACTED]');
}

function normalizePptRequestPayload(body) {
  body = body || {};
  if (!body.outline) return body;
  const outline = body.outline || {};
  const demand = body.demand || {};
  const brand = body.brand || demand.brand || demand.brand_name || demand.company || demand.company_name || outline.title || 'Brand';
  const tagline = body.tagline || outline.subtitle || [demand.product || demand.product_name, demand.target_market || demand.market].filter(Boolean).join(' / ');
  const sections = Array.isArray(outline.sections) ? outline.sections : [];
  return {
    brand,
    tagline,
    title: outline.title || body.title || brand,
    sections: sections.map(function(section) {
      const items = Array.isArray(section.items) ? section.items
        : Array.isArray(section.points) ? section.points
          : String(section.points || section.note || '').split(/\n|;|；/).filter(Boolean);
      return {
        title: section.title || '',
        items: items.map(function(item) { return String(item); }).filter(Boolean)
      };
    }).filter(function(section) { return section.title || section.items.length; }),
    outline,
    demand
  };
}

function aiQuotaGuard(req, res, next) {
  const quota = Number(req.user.api_quota || 0);
  if (!quota || req.user.role === 'admin') return next();
  const used = db.prepare('SELECT COALESCE(SUM(total_tokens), 0) AS total FROM token_usage WHERE user_id = ?').get(req.user.id).total;
  if (used >= quota) return res.status(429).json({ error: 'AI quota exceeded' });
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
  const token = jwt.sign({ userId: user.id, role: user.role, jti: crypto.randomUUID() }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
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
  const token = bearerTokenFromAuthorization(req.headers.authorization);
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
  try {
    knowledgeService.ingestKnowledge(db, {
      title: '需求归档：' + (brand_name || product_name || result.lastInsertRowid),
      summary: [brand_name, product_name, industry, target_market, budget].filter(Boolean).join(' / '),
      content: JSON.stringify({ brand_name, company_name, product_name, industry, budget, target_market, platform, data_json }, null, 2),
      entry_type: 'demand',
      source_type: 'demand_record',
      source_id: result.lastInsertRowid,
      visibility: 'private',
      tags: ['demand', industry, target_market].filter(Boolean),
      business_type: 'demand',
      business_id: result.lastInsertRowid,
      created_by: req.user.id,
      actor_role: req.user.role
    });
  } catch(e) {}
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
  try {
    knowledgeService.ingestKnowledge(db, {
      title: '确认方案：' + (demand_id || result.lastInsertRowid),
      summary: String(content || '').slice(0, 240),
      content: content || '',
      entry_type: 'proposal_confirmed',
      source_type: 'proposal_record',
      source_id: result.lastInsertRowid,
      visibility: 'team',
      tags: ['proposal', 'confirmed', template_id].filter(Boolean),
      business_type: 'proposal',
      business_id: result.lastInsertRowid,
      created_by: req.user.id,
      metadata: { demand_id, template_id },
      actor_role: req.user.role
    });
  } catch(e) {}
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
  const passwordResult = resolveUserCreationPassword(req.body);
  if (passwordResult.policyErrors.length) {
    return res.status(400).json({ error: 'Password policy failed', details: passwordResult.policyErrors });
  }
  const temporaryPassword = passwordResult.password;
  const hash = hashPassword(temporaryPassword);
  try {
    const result = db.prepare('INSERT INTO users (username, password_hash, display_name, role, email, department) VALUES (?, ?, ?, ?, ?, ?)')
      .run(username, hash, display_name || username, role || 'user', email || '', department || '');
    res.json({
      id: result.lastInsertRowid,
      temporary_password: passwordResult.hasSuppliedPassword ? undefined : temporaryPassword,
      message: passwordResult.hasSuppliedPassword ? 'User created with provided password' : 'User created. Share the temporary password securely.'
    });
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
  const target = db.prepare('SELECT id, username FROM users WHERE id = ? AND is_active = 1').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const hasSuppliedPassword = Object.prototype.hasOwnProperty.call(req.body || {}, 'password');
  const temporaryPassword = hasSuppliedPassword
    ? String(req.body.password || '')
    : credentialRotation.generateTemporaryPassword();

  try {
    const resetTransaction = db.transaction(function() {
      const auditIp = redactSecretValue(req.ip, temporaryPassword);
      const result = credentialRotation.rotateUserPasswords(db, {
        actorUserId: req.user.id,
        rotations: [{ username: target.username, password: temporaryPassword }],
        invalidateAllSessions: false,
        ipAddress: auditIp,
        reason: 'admin reset'
      });

      db.prepare(`
        INSERT INTO activity_log (user_id, action, module, details, ip_address)
        VALUES (?, ?, ?, ?, ?)
      `).run(req.user.id, 'admin_reset_password', 'security', JSON.stringify({
        actorUserId: req.user.id,
        targetUserId: Number(target.id),
        targetUsername: redactSecretValue(target.username, temporaryPassword),
        sessionsRevoked: result.sessionsRevoked
      }), auditIp);

      return result;
    });
    const result = resetTransaction();

    res.json({
      success: true,
      sessions_revoked: result.sessionsRevoked,
      temporary_password: hasSuppliedPassword ? undefined : temporaryPassword,
      message: hasSuppliedPassword ? 'Password reset to provided value' : 'Password reset. Share the temporary password securely.'
    });
  } catch(e) {
    if (/Password policy failed/.test(e.message)) return res.status(400).json({ error: e.message });
    if (/Active user not found/.test(e.message)) return res.status(404).json({ error: 'User not found' });
    res.status(500).json({ error: e.message });
  }
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
  const pptPayload = normalizePptRequestPayload(req.body);
  fs.writeFileSync(dataPath, JSON.stringify(pptPayload));
  try {
    try {
      knowledgeService.ingestKnowledge(db, {
        title: 'PPT 生成请求：' + (pptPayload.brand || pptPayload.title || Date.now()),
        summary: String(req.body.summary || pptPayload.title || pptPayload.brand || '').slice(0, 240),
        content: JSON.stringify(pptPayload, null, 2),
        entry_type: 'proposal_ppt_request',
        source_type: 'ppt_generation',
        source_id: req.body.demand_id || pptPayload.brand || dataPath,
        visibility: 'private',
        tags: ['ppt', 'proposal', pptPayload.brand].filter(Boolean),
        business_type: 'proposal',
        business_id: req.body.demand_id || '',
        created_by: req.user.id,
        actor_role: req.user.role
      });
    } catch (archiveErr) {}
    const python = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
    cp.execFileSync(python, [path.join(__dirname, 'generate_ppt.py'), dataPath, outPath], { timeout: 30000, cwd: __dirname });
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
require('./routes_brands')(app, db, authMiddleware, aiLimiter, aiQuotaGuard);

// ===== WORKFLOW ENGINE ROUTES =====
require('./routes_workflow')(app, db, authMiddleware, adminOnly);


// ===== KNOWLEDGE BASE ROUTES =====
app.get('/api/knowledge', authMiddleware, (req, res) => {
  try {
    const entries = knowledgeService.searchKnowledge(db, {
      q: req.query.q || req.query.search || '',
      type: req.query.type,
      entry_type: req.query.entry_type,
      source_type: req.query.source_type,
      visibility: req.query.visibility,
      business_type: req.query.business_type,
      business_id: req.query.business_id,
      tags: req.query.tags,
      limit: req.query.limit || 100,
      user: req.user
    });
    res.json({ entries });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/knowledge', authMiddleware, (req, res) => {
  try {
    const entry = knowledgeService.ingestKnowledge(db, Object.assign({}, req.body, { created_by: req.user.id, actor_role: req.user.role }));
    res.json({ entry, id: entry.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/knowledge/search', authMiddleware, (req, res) => {
  try {
    const entries = knowledgeService.searchKnowledge(db, {
      q: req.query.q || req.query.search || '',
      entry_type: req.query.entry_type || req.query.type,
      source_type: req.query.source_type,
      visibility: req.query.visibility,
      business_type: req.query.business_type,
      business_id: req.query.business_id,
      tags: req.query.tags,
      limit: req.query.limit || 50,
      user: req.user
    });
    res.json({ entries, total: entries.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/knowledge/ingest', authMiddleware, (req, res) => {
  try {
    const entry = knowledgeService.ingestKnowledge(db, Object.assign({}, req.body, {
      created_by: req.user.id,
      actor_role: req.user.role
    }));
    db.prepare('INSERT INTO activity_log (user_id, action, module, details, ip_address) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.id, 'knowledge_ingest', 'knowledge', 'Ingested knowledge entry ' + entry.id, req.ip);
    res.json({ entry, id: entry.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/knowledge/upload', authMiddleware, uploadLimiter, function(req, res, next) {
  upload.single('file')(req, res, function(err) {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'File required' });
    let parsed;
    try {
      parsed = await fileIngestService.readUploadedFile(req.file);
    } catch (parseError) {
      const demandParsed = await latestUiCompat.parseDemandFile(req.file);
      parsed = {
        content: demandParsed.text,
        kind: 'document',
        rows: [],
        parser: demandParsed.parser,
        fallback: demandParsed.fallback,
        warning: demandParsed.warnings && demandParsed.warnings.length ? demandParsed.warnings.join(' | ') : parseError.message
      };
    }
    const entry = knowledgeService.ingestKnowledge(db, {
      title: req.body.title || req.file.originalname,
      summary: req.body.summary || '',
      content: parsed.content,
      entry_type: req.body.entry_type || (parsed.kind === 'table' ? 'uploaded_table' : 'uploaded_document'),
      source_type: req.body.source_type || 'knowledge_upload',
      source_id: req.body.source_id || req.file.originalname,
      visibility: req.body.visibility || 'private',
      tags: req.body.tags || [],
      business_type: req.body.business_type,
      business_id: req.body.business_id,
      created_by: req.user.id,
      actor_role: req.user.role,
      metadata: {
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size,
        kind: parsed.kind,
        row_count: parsed.rows ? parsed.rows.length : 0,
        parser: parsed.parser,
        fallback: parsed.fallback,
        warning: parsed.warning
      }
    });
    try { fs.unlinkSync(req.file.path); } catch (e2) {}
    res.json({ entry, rows: parsed.rows ? parsed.rows.length : 0 });
  } catch (e) {
    try { if (req.file && req.file.path) fs.unlinkSync(req.file.path); } catch (e2) {}
    res.status(e.code === 'XLSX_NOT_INSTALLED' ? 501 : 500).json({ error: e.message });
  }
});

app.post('/api/influencers/upload', authMiddleware, uploadLimiter, function(req, res, next) {
  upload.single('file')(req, res, function(err) {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'File required' });
    const parsed = await fileIngestService.readUploadedFile(req.file);
    if (!parsed.rows || !parsed.rows.length) return res.status(400).json({ error: 'No table rows found in uploaded file' });
    const result = influencerWorkflow.importInfluencerRows(db, parsed.rows, {
      batch_id: req.body.batch_id || req.file.originalname,
      user: req.user,
      data_source: 'upload'
    });
    try { fs.unlinkSync(req.file.path); } catch (e2) {}
    res.json(Object.assign({ parser: parsed.parser, warning: parsed.warning }, result));
  } catch (e) {
    try { if (req.file && req.file.path) fs.unlinkSync(req.file.path); } catch (e2) {}
    const status = e.code === 'UNSUPPORTED_FILE_TYPE' ? 415 : e.code === 'XLSX_NOT_INSTALLED' ? 501 : (e.statusCode || 500);
    res.status(status).json({ error: e.message });
  }
});

app.post('/api/admin/knowledge/import/obsidian', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await obsidianIngestService.syncObsidianFolder(db, {
      rootPath: req.body.root_path || req.body.rootPath || process.env.OBSIDIAN_KB_ROOT || 'D:\\主盘\\图灵集市',
      dryRun: boolParam(req.body.dry_run !== undefined ? req.body.dry_run : req.body.dryRun, true),
      visibility: req.body.visibility || 'team',
      user: req.user
    });
    db.prepare('INSERT INTO activity_log (user_id, action, module, details, ip_address) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.id, result.dryRun ? 'obsidian_dry_run' : 'obsidian_sync', 'knowledge', 'Obsidian sync eligible=' + result.eligible + ' imported=' + result.imported + ' skipped=' + result.skipped, req.ip);
    res.json(result);
  } catch (e) {
    res.status(/admin only/i.test(e.message) ? 403 : 500).json({ error: e.message });
  }
});

app.post('/api/admin/knowledge/vault/export', authMiddleware, adminOnly, (req, res) => {
  try {
    const result = vaultExportService.exportKnowledgeVault(db, {
      rootPath: req.body.root_path || req.body.rootPath || process.env.PLATFORM_KB_VAULT_ROOT || 'D:\\图灵商务在线平台',
      entry_type: req.body.entry_type,
      source_type: req.body.source_type,
      visibility: req.body.visibility,
      limit: req.body.limit || 5000,
      user: req.user
    });
    db.prepare('INSERT INTO activity_log (user_id, action, module, details, ip_address) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.id, 'knowledge_vault_export', 'knowledge', 'Exported ' + result.exported + ' knowledge entries to vault', req.ip);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/knowledge/similar', authMiddleware, (req, res) => {
  try {
    const entries = latestUiCompat.similarKnowledge(db, req.query || {}, req.user);
    res.json({ entries });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/knowledge/:id/use', authMiddleware, (req, res) => {
  knowledgeService.markKnowledgeUsed(db, [req.params.id]);
  res.json({ success: true });
});

// ===== AI CONVERSATION + RAG ROUTES =====
app.post('/api/ai/chat', authMiddleware, aiLimiter, aiQuotaGuard, async (req, res) => {
  try {
    const result = await aiService.handleChat(db, {
      user: req.user,
      message: req.body.message,
      conversation_id: req.body.conversation_id,
      allowWeb: boolParam(req.body.allow_web, false),
      source_module: req.body.source_module || 'assistant',
      business_type: req.body.business_type,
      business_id: req.body.business_id,
      summaryVisibility: req.body.summary_visibility || 'private',
      knowledgeLimit: req.body.knowledge_limit || 8,
      max_tokens: req.body.max_tokens
    });
    res.json(result);
  } catch (e) {
    const status = /forbidden|not found/i.test(e.message) ? 403 : 400;
    res.status(status).json({ error: e.message });
  }
});

app.get('/api/ai/conversations', authMiddleware, (req, res) => {
  try {
    const conversations = aiService.listConversations(db, {
      user: req.user,
      q: req.query.q || '',
      user_id: req.query.user_id,
      source_module: req.query.source_module,
      limit: req.query.limit || 100
    });
    res.json({ conversations });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/ai/conversations/:id', authMiddleware, (req, res) => {
  try {
    const conversation = aiService.getConversation(db, { id: req.params.id, user: req.user });
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    if (req.user.role === 'admin' && Number(conversation.user_id) !== Number(req.user.id)) {
      try {
        db.prepare('INSERT INTO activity_log (user_id, action, module, details, ip_address) VALUES (?, ?, ?, ?, ?)')
          .run(req.user.id, 'admin_view_ai_conversation', 'ai_audit', 'Viewed AI conversation ' + req.params.id + ' owned by user ' + conversation.user_id, req.ip);
      } catch (e2) {}
    }
    res.json({ conversation });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ai/proposal-draft', authMiddleware, aiLimiter, aiQuotaGuard, async (req, res) => {
  try {
    const demandText = req.body.demand_content || req.body.content || JSON.stringify(req.body.demand || {});
    const demandTitle = req.body.title || (req.body.demand && (req.body.demand.brand || req.body.demand.product)) || '需求方案草稿';
    const demandEntry = knowledgeService.ingestKnowledge(db, {
      title: '需求归档：' + demandTitle,
      summary: String(demandText).slice(0, 240),
      content: demandText,
      entry_type: 'demand',
      source_type: req.body.source_type || 'proposal_draft_request',
      source_id: req.body.demand_id || req.body.source_id || demandTitle,
      visibility: req.body.visibility || 'private',
      tags: req.body.tags || ['demand', 'proposal'],
      business_type: 'demand',
      business_id: req.body.demand_id || '',
      created_by: req.user.id,
      actor_role: req.user.role,
      metadata: { demand: req.body.demand || null }
    });
    const prompt = [
      '请基于以下客户需求和平台知识库，生成红人营销方案草稿。',
      '必须包含：执行摘要、市场/竞品判断、达人类型与平台建议、60-30-10预算建议、执行时间线、KPI、风险与下一步确认项。',
      '',
      demandText
    ].join('\n');
    const result = await aiService.handleChat(db, {
      user: req.user,
      message: prompt,
      allowWeb: boolParam(req.body.allow_web, false),
      source_module: 'proposal',
      knowledgeLimit: req.body.knowledge_limit || 10,
      summaryVisibility: req.body.summary_visibility || 'private'
    });
    res.json({ draft: result.answer, demand_entry: demandEntry, ai: result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== LATEST UI COMPATIBILITY ROUTES =====
app.post('/api/demand/parse-file', authMiddleware, uploadLimiter, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'File required' });
  try {
    const parsed = await latestUiCompat.parseDemandFile(req.file);
    const inferred = latestUiCompat.inferDemandAnalysis(parsed.text, parsed.warning || '', req.file.originalname);
    const archiveContent = parsed.fallback ? '' : parsed.text;
    const archiveSummary = parsed.fallback
      ? 'File parsed without readable business text; parser details kept in metadata and excluded from RAG content.'
      : String(parsed.text || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    try {
      knowledgeService.ingestKnowledge(db, {
        title: 'Demand upload: ' + (req.file.originalname || 'uploaded file'),
        summary: archiveSummary,
        content: archiveContent,
        entry_type: parsed.fallback ? 'demand_upload_parse_failure' : 'demand_upload',
        source_type: 'demand_parse_file',
        source_id: req.file.originalname || req.file.filename,
        visibility: 'private',
        tags: ['demand', 'upload', path.extname(req.file.originalname || '').replace('.', ''), parsed.fallback ? 'parse_failure' : 'parsed'].filter(Boolean),
        business_type: 'demand',
        business_id: '',
        created_by: req.user.id,
        actor_role: req.user.role,
        metadata: {
          parser: parsed.parser,
          fallback: parsed.fallback,
          parse_failure: !!parsed.fallback,
          parser_text: parsed.fallback ? parsed.text : '',
          needsOcr: parsed.needsOcr,
          ocrUsed: parsed.ocrUsed,
          fileName: req.file.originalname
        }
      });
    } catch (e2) {}
    res.json({
      fileName: req.file.originalname,
      extractedText: parsed.text,
      analysisHint: inferred,
      fallback: parsed.fallback,
      warning: parsed.warnings && parsed.warnings.length ? parsed.warnings.join(' | ') : undefined,
      parser: parsed.parser,
      needsOcr: parsed.needsOcr,
      ocrUsed: parsed.ocrUsed
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    latestUiCompat.safeUnlink(req.file.path);
  }
});

app.post('/api/ai/strategy', authMiddleware, aiLimiter, aiQuotaGuard, async (req, res) => {
  try {
    const result = await latestUiCompat.generateStrategy(db, req.user, req.body.prompt, req.body.input);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message, content: '', fallback: true, warning: e.message });
  }
});

app.post('/api/ai/demand-analysis', authMiddleware, aiLimiter, aiQuotaGuard, async (req, res) => {
  try {
    const result = await latestUiCompat.generateDemandAnalysis(req.body.prompt, req.body.input, req.body.fileName, { db, user: req.user });
    try {
      knowledgeService.ingestKnowledge(db, {
        title: 'Demand analysis: ' + (result.analysis.brand || result.analysis.product || req.body.fileName || 'untitled'),
        summary: JSON.stringify(result.analysis).slice(0, 240),
        content: JSON.stringify(result.analysis, null, 2),
        entry_type: 'demand_analysis',
        source_type: 'ai_demand_analysis',
        source_id: req.body.fileName || result.analysis.brand || Date.now(),
        visibility: 'private',
        tags: ['demand', 'analysis', result.analysis.industry || '', result.analysis.brand || ''],
        business_type: 'demand',
        business_id: result.analysis.brand || result.analysis.product || '',
        created_by: req.user.id,
        actor_role: req.user.role,
        metadata: { fallback: !!result.fallback }
      });
    } catch (e2) {}
    res.json(result);
  } catch (e) {
    res.json({
      analysis: latestUiCompat.inferDemandAnalysis(req.body.input || req.body.prompt || '', e.message, req.body.fileName),
      fallback: true,
      warning: e.message
    });
  }
});

app.post('/api/ai/ppt-outline', authMiddleware, aiLimiter, aiQuotaGuard, async (req, res) => {
  try {
    const result = await latestUiCompat.generatePptOutline(db, req.user, req.body || {});
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
      topUsers: db.prepare("SELECT u.display_name, u.department, COUNT(c.id) as deals FROM users u LEFT JOIN customers c ON c.assigned_to = u.id AND c.stage='won' GROUP BY u.id ORDER BY deals DESC LIMIT 10").all()
    };
    res.json({ stats });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== ENHANCED CUSTOMER STATS (for new frontend) =====
app.get('/api/customers/stats', authMiddleware, (req, res) => {
  try {
    const userFilter = req.user.role !== 'admin' ? ' WHERE assigned_to = ' + req.user.id : '';
    const total = db.prepare('SELECT COUNT(*) as count FROM customers' + userFilter).get().count;
    const publicPool = db.prepare("SELECT COUNT(*) as count FROM customers WHERE is_public = 1" + (req.user.role !== 'admin' ? '' : '')).get().count;
    const assigned = db.prepare('SELECT COUNT(*) as count FROM customers WHERE assigned_to IS NOT NULL AND assigned_to = ?').get(req.user.id).count;
    const won = db.prepare("SELECT COUNT(*) as count FROM customers WHERE stage='won'" + userFilter).get().count;
    const byStageRows = db.prepare('SELECT stage, COUNT(*) as count FROM customers' + userFilter + ' GROUP BY stage').all();
    const byStage = {}; byStageRows.forEach(function(r) { byStage[r.stage] = r.count; });
    const totalOppValue = db.prepare("SELECT COALESCE(SUM(COALESCE(opportunity_value,0)),0) as total FROM customers WHERE opportunity_value > 0" + userFilter).get().total;
    const weeklyNew = db.prepare("SELECT COUNT(*) as count FROM customers WHERE created_at >= datetime('now', '-7 days')" + userFilter).get().count;
    const winRateRows = db.prepare("SELECT COUNT(*) as total FROM customers WHERE stage IN ('won','lost')" + userFilter).get().total;
    const winRate = winRateRows > 0 ? Math.round((won / winRateRows) * 100) : 0;

    res.json({
      total, weeklyNew, publicPool, assigned, won,
      totalOppValue, winRate, avgCycle: '-',
      byStage: byStage
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== CUSTOMER ACTIVITY ROUTES =====
app.post('/api/customers/:id/activity', authMiddleware, (req, res) => {
  try {
    const { action, notes } = req.body;
    const customer = crmAccess.getCustomer(db, req.params.id);
    if (!customer) return crmAccess.notFound(res, 'Customer');
    if (!crmAccess.canManageCustomer(req.user, customer)) return crmAccess.forbidden(res);
    db.prepare('INSERT INTO customer_activity (customer_id, user_id, action, stage_from, stage_to, notes) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.params.id, req.user.id, action || 'note', customer.stage, customer.stage, notes || '');
    businessKnowledge.archiveCustomer(db, Object.assign({}, customer, {
      latest_activity: { action: action || 'note', notes: notes || '' }
    }), req.user);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== DASHBOARD STATS =====
app.get('/api/dashboard/stats', authMiddleware, (req, res) => {
  try {
    const userFilter = req.user.role !== 'admin' ? ' WHERE assigned_to = ' + req.user.id : '';
    const totalCustomers = db.prepare('SELECT COUNT(*) as count FROM customers' + userFilter).get().count;
    const totalOppValue = db.prepare("SELECT COALESCE(SUM(COALESCE(opportunity_value,0)),0) as total FROM customers" + userFilter).get().total;
    const wonDeals = db.prepare("SELECT COUNT(*) as count FROM customers WHERE stage='won'" + userFilter).get().count;
    const lostDeals = db.prepare("SELECT COUNT(*) as count FROM customers WHERE stage='lost'" + userFilter).get().count;
    const stageRows = db.prepare('SELECT stage, COUNT(*) as count FROM customers' + userFilter + ' GROUP BY stage').all();
    const recentActivity = req.user.role === 'admin'
      ? db.prepare('SELECT ca.*, u.display_name FROM customer_activity ca JOIN users u ON ca.user_id = u.id ORDER BY ca.created_at DESC LIMIT 20').all()
      : db.prepare(`
          SELECT ca.*, u.display_name
          FROM customer_activity ca
          JOIN users u ON ca.user_id = u.id
          JOIN customers c ON c.id = ca.customer_id
          WHERE ca.user_id = ? OR c.assigned_to = ? OR c.created_by = ?
          ORDER BY ca.created_at DESC
          LIMIT 20
        `).all(req.user.id, req.user.id, req.user.id);
    res.json({ totalCustomers, totalOppValue, wonDeals, lostDeals, stageRows, recentActivity });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== KNOWLEDGE CATEGORIES =====
app.get('/api/knowledge/categories', authMiddleware, (req, res) => {
  try {
    const categories = req.user.role === 'admin'
      ? db.prepare("SELECT entry_type, COUNT(*) as count FROM knowledge_entries GROUP BY entry_type").all()
      : db.prepare("SELECT entry_type, COUNT(*) as count FROM knowledge_entries WHERE created_by = ? OR visibility IN ('team','public','shared') OR is_public = 1 GROUP BY entry_type").all(req.user.id);
    res.json({ categories });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== AUTH REGISTER (admin) =====
app.post('/api/auth/register', authMiddleware, adminOnly, (req, res) => {
  const { username, display_name, role, department, email } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });
  const passwordResult = resolveUserCreationPassword(req.body);
  if (passwordResult.policyErrors.length) {
    return res.status(400).json({ error: 'Password policy failed', details: passwordResult.policyErrors });
  }
  const temporaryPassword = passwordResult.password;
  const hash = hashPassword(temporaryPassword);
  try {
    const result = db.prepare('INSERT INTO users (username, password_hash, display_name, role, email, department) VALUES (?, ?, ?, ?, ?, ?)')
      .run(username, hash, display_name || username, role || 'user', email || '', department || '');
    res.json({
      id: result.lastInsertRowid,
      temporary_password: passwordResult.hasSuppliedPassword ? undefined : temporaryPassword,
      message: passwordResult.hasSuppliedPassword ? 'User created with provided password' : 'User created. Share the temporary password securely.'
    });
  } catch(e) {
    res.status(400).json({ error: 'Username may already exist' });
  }
});

// ===== USERS LIST (for frontend) =====
app.get('/api/users', authMiddleware, (req, res) => {
  const users = db.prepare('SELECT id, username, display_name, role, department, email, api_quota, created_at, last_login, is_active FROM users ORDER BY department, id').all();
  res.json({ users });
});
// ===== WORKFLOW ENGINE INIT =====
const workflowEngine = require('./workflow_engine');
workflowEngine.initEngine();

// ===== HEALTH CHECK =====
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ===== SPA FALLBACK =====
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, '../index.html'), {
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate', 'Pragma': 'no-cache', 'Expires': '0' }
  });
});

app.listen(...runtimeConfig.serverListenArgs(PORT), () => {
  console.log(`🚀 TuringMarket server running on http://localhost:${PORT}`);
});

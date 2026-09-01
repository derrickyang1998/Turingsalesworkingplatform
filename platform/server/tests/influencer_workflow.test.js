const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const influencerWorkflow = require('../services/influencer_workflow_service');
const {
  createCampaignCollaborationService
} = require('../services/campaign_collaboration_service');
const task9HeaderContractPath = path.join(__dirname, 'fixtures', 'task-9-upload-header-contract.json');
const TEST_JWT_SECRET = 'kGoVXFMo4jD81r9d8FIGM6HbN7xQ9pM74x1un3PVF48';
const CHILD_ENV_ALLOWLIST = Object.freeze([
  'PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'windir',
  'TEMP', 'TMP', 'ComSpec', 'COMSPEC', 'PATHEXT', 'HOME', 'USERPROFILE',
  'PROCESSOR_ARCHITECTURE', 'SystemDrive'
]);

function isolatedChildEnvironment(overrides, sourceEnvironment = process.env) {
  const environment = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    if (Object.prototype.hasOwnProperty.call(sourceEnvironment, key)) {
      environment[key] = sourceEnvironment[key];
    }
  }
  return Object.assign(environment, overrides);
}

test('influencer server child environment excludes inherited secrets and application configuration', () => {
  const environment = isolatedChildEnvironment({}, {
    PATH: '/test/bin',
    NODE_OPTIONS: '--require inherited-hook.js',
    DEEPSEEK_API_KEY: 'inherited-deepseek-key',
    TAVILY_API_KEY: 'inherited-tavily-key',
    TM_ENV_FILE: '/untrusted.env',
    DB_PATH: '/production.db'
  });

  assert.deepEqual(environment, { PATH: '/test/bin' });
});

function parseTask9HeaderContract() {
  const contract = JSON.parse(fs.readFileSync(task9HeaderContractPath, 'utf8'));
  assert.equal(contract.version, 'task-9-upload-header-contract-1');
  assert.equal(contract.range, 'A1:T1');
  assert.equal(contract.headers.length, 20);
  return contract.headers;
}

function stripBom(value) {
  return String(value || '').replace(/^\uFEFF/, '');
}

function parseCsvLine(line) {
  const values = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      values.push(cell);
      cell = '';
    } else {
      cell += ch;
    }
  }
  values.push(cell);
  if (values.length) values[0] = stripBom(values[0]);
  return values;
}

function parseCsvRows(csv) {
  return stripBom(csv)
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(parseCsvLine);
}

function assertApprovedCsvHeaders(csv) {
  assert.deepEqual(parseCsvRows(csv)[0], influencerWorkflow.TEMPLATE_HEADERS);
}

function insertInfluencer(db, row) {
  const fields = Object.keys(row);
  const placeholders = fields.map(function() { return '?'; }).join(', ');
  const result = db.prepare(
    'INSERT INTO influencers (' + fields.join(', ') + ') VALUES (' + placeholders + ')'
  ).run(...fields.map(function(field) { return row[field]; }));
  return result.lastInsertRowid;
}

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve));
}

function tempDbPaths(dbPath) {
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
}

function processExists(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  let timer = null;
  const exited = await Promise.race([
    once(child, 'exit').then(function() { return true; }),
    new Promise((resolve) => {
      timer = setTimeout(function() { resolve(false); }, timeoutMs);
    })
  ]);
  if (timer) clearTimeout(timer);
  return exited || child.exitCode !== null || child.signalCode !== null;
}

async function terminateTempServer(child, output) {
  if (child.exitCode === null && child.signalCode === null) child.kill();
  let exited = await waitForChildExit(child, 5000);
  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill(process.platform === 'win32' ? undefined : 'SIGKILL');
    exited = await waitForChildExit(child, 5000);
  }
  assert.equal(
    exited || child.exitCode !== null || child.signalCode !== null,
    true,
    'Temp server failed to exit after termination: ' + output.join('\n')
  );
}

function cleanupTempDbFiles(dbPath) {
  for (const filePath of tempDbPaths(dbPath)) {
    fs.rmSync(filePath, { force: true });
  }
  for (const filePath of tempDbPaths(dbPath)) {
    assert.equal(fs.existsSync(filePath), false, `Expected temp cleanup to remove ${filePath}`);
  }
}

function cleanupTempUploadDir(uploadDir) {
  fs.rmSync(uploadDir, { recursive: true, force: true });
  assert.equal(fs.existsSync(uploadDir), false, `Expected temp cleanup to remove ${uploadDir}`);
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  return port;
}

async function waitForServer(baseUrl, child, output) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error('Temp server exited early: ' + output.join('\n'));
    }
    try {
      const response = await fetch(baseUrl + '/api/health');
      if (response.ok) return;
    } catch (e) {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('Timed out waiting for temp server: ' + output.join('\n'));
}

async function withTempServer(callback, options) {
  options = options || {};
  const dbPath = path.join(os.tmpdir(), `tm-influencer-upload-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  const uploadDir = path.join(os.tmpdir(), `tm-influencer-files-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(repoRoot, 'platform', 'server'),
    env: isolatedChildEnvironment({
      NODE_ENV: 'test',
      TM_DISABLE_DOTENV: '1',
      SERVER_HOST: '127.0.0.1',
      PORT: String(port),
      DB_PATH: dbPath,
      DEFAULT_ADMIN_USERNAME: 'admin',
      DEFAULT_ADMIN_PASSWORD: 'test-only-admin-password',
      JWT_SECRET: TEST_JWT_SECRET,
      UPLOAD_DIR: uploadDir,
      UPLOAD_SANDBOX_SPOOL_ROOT: uploadDir,
      TM_UPLOAD_SANDBOX_TEST_MODE: 'local-worker',
      FEISHU_WEBHOOK_URL: '',
      FEISHU_WEBHOOK: ''
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', function(chunk) { output.push(String(chunk)); });
  child.stderr.on('data', function(chunk) { output.push(String(chunk)); });

  try {
    await waitForServer(baseUrl, child, output);
    const login = await fetch(baseUrl + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'test-only-admin-password' })
    });
    const loginText = await login.text();
    assert.equal(login.status, 200, loginText);
    const auth = JSON.parse(loginText);
    await callback({ baseUrl, token: auth.token, dbPath, uploadDir, child });
  } finally {
    await terminateTempServer(child, output);
    if (typeof options.beforeCleanup === 'function') {
      options.beforeCleanup({ dbPath, child });
    }
    cleanupTempDbFiles(dbPath);
    cleanupTempUploadDir(uploadDir);
  }
}

function freshDb() {
  const dbPath = path.join(os.tmpdir(), `tm-influencer-workflow-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  process.env.DB_PATH = dbPath;
  process.env.DEFAULT_ADMIN_PASSWORD = 'test-only-admin-password';
  const dbModule = path.resolve(__dirname, '../db.js');
  delete require.cache[dbModule];
  return require(dbModule);
}

function mountRoutes(db, options) {
  const routes = {};
  const app = {};
  ['get', 'post', 'put', 'delete'].forEach(function(method) {
    app[method] = function(routePath) {
      routes[method.toUpperCase() + ' ' + routePath] = Array.prototype.slice.call(arguments, 1);
    };
  });
  const authMiddleware = function(req, res, next) { return next(); };
  const campaignCollaborationService = createCampaignCollaborationService(db);
  const routesModule = path.resolve(__dirname, '../routes.js');
  delete require.cache[routesModule];
  require(routesModule)(app, db, authMiddleware, Object.assign({ campaignCollaborationService }, options || {}));
  return routes;
}

function createFeishuOutboxCampaign(db, id, ownerId) {
  const identity = db.prepare(`
    SELECT membership.org_id,team.team_id
    FROM organization_memberships membership
    JOIN team_memberships team
      ON team.org_id=membership.org_id AND team.user_id=membership.user_id AND team.status='active'
    WHERE membership.user_id=? AND membership.status='active'
    ORDER BY team.team_id
    LIMIT 1
  `).get(ownerId);
  assert.ok(identity, 'missing owner identity for Feishu outbox test');
  const customerId = id + 1;
  const opportunityId = id + 2;
  db.prepare(`
    INSERT INTO customers (
      id,brand_name,company_name,stage,source,created_by,assigned_to
    ) VALUES (?,?,?,'qualified','test',?,?)
  `).run(customerId, 'Bitable Outbox Brand', 'Bitable Outbox Brand Ltd', ownerId, ownerId);
  db.prepare(`
    INSERT INTO opportunities (
      id,customer_id,name,stage,value,win_probability,product_name,channel_type,created_by
    ) VALUES (?,?,'Bitable Outbox Opportunity','proposal',1000,60,'Bitable Product','influencer',?)
  `).run(opportunityId, customerId, ownerId);
  db.prepare(`
    INSERT INTO campaigns (
      id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,
      lifecycle_state,operational_status,row_version
    ) VALUES (?,?,?,?,?,?,?,'lead','active',1)
  `).run(id, identity.org_id, 'Bitable Outbox Campaign', customerId, opportunityId, ownerId, identity.team_id);
  return id;
}

async function invoke(routes, key, opts) {
  opts = opts || {};
  const handlers = routes[key];
  assert.ok(handlers, 'route not found: ' + key);
  const req = {
    user: opts.user || { id: 2, role: 'user', username: 'tester' },
    params: opts.params || {},
    query: opts.query || {},
    body: opts.body || {},
    headers: opts.headers || {},
    get: function(name) {
      const target = String(name || '').toLowerCase();
      const key = Object.keys(this.headers).find(function(headerName) { return String(headerName).toLowerCase() === target; });
      return key ? this.headers[key] : undefined;
    },
    ip: '127.0.0.1'
  };
  let statusCode = 200;
  let payload;
  let body;
  const headers = {};
  const res = {
    status: function(code) { statusCode = code; return this; },
    json: function(value) { payload = value; return this; },
    send: function(value) { body = value; return this; },
    setHeader: function(name, value) { headers[name.toLowerCase()] = value; return this; }
  };
  let index = 0;
  async function next() {
    const handler = handlers[index++];
    if (!handler) return;
    const result = handler.length >= 3 ? handler(req, res, next) : handler(req, res);
    if (result && typeof result.then === 'function') await result;
  }
  await next();
  return { statusCode, payload, body, headers };
}

test('Task 9 approved upload headers match the UTF-8 service constant and contract file', () => {
  const contractHeaders = parseTask9HeaderContract();

  assert.equal(contractHeaders.length, 20);
  assert.deepEqual(contractHeaders, influencerWorkflow.TEMPLATE_HEADERS);
});

test('influencer import accepts the historical 19-column template aliases', async () => {
  const db = freshDb();
  const routes = mountRoutes(db);

  const result = await invoke(routes, 'POST /api/influencers/import', {
    body: {
      batch_id: 'legacy-template-batch',
      rows: [{
        'No.': '1',
        Date: '2026-07-03',
        Submitter: 'Derrick',
        Project: 'Bluetti Summer Launch',
        Product: 'Power Station',
        Duplicate: 'No',
        'KOL Handle': '@legacy_kol',
        Followers: '120000',
        Link: 'https://example.com/legacy',
        Platform: 'TikTok',
        Country: 'US',
        Tag: 'outdoor, power',
        AvgViews10: '45000',
        Cost: '1500',
        Deliverable: '1 short video + 1 story',
        TuringNote: 'Legacy export contract',
        Price: '2500',
        Email: 'creator@example.com',
        CPM: '33',
        CPV: '0.05'
      }]
    }
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.imported, 1);
  assert.ok(Number.isSafeInteger(result.payload.knowledge_entry_id));
  const batchKnowledge = db.prepare(`
    SELECT entry_type,source_type,source_id,metadata_json
    FROM knowledge_entries WHERE id=?
  `).get(result.payload.knowledge_entry_id);
  const batchMetadata = JSON.parse(batchKnowledge.metadata_json);
  assert.equal(batchKnowledge.entry_type, 'influencer_batch');
  assert.equal(batchKnowledge.source_type, 'influencer_import');
  assert.equal(batchKnowledge.source_id, 'legacy-template-batch');
  assert.equal(batchMetadata.artifact_contract, 'tm-business-artifact-v1');
  assert.equal(batchMetadata.artifact_state, 'ingested');
  assert.equal(batchMetadata.artifact_type, 'influencer_batch');
  const inf = db.prepare("SELECT * FROM influencers WHERE import_batch = ? AND kol_handle = ?").get('legacy-template-batch', '@legacy_kol');
  assert.ok(inf);
  assert.equal(inf.platform, 'TikTok');
  assert.equal(inf.profile_link, 'https://example.com/legacy');
  assert.equal(inf.followers, 120000);
  assert.equal(inf.avg_views_10, 45000);
  assert.equal(inf.region, 'US');
  assert.equal(inf.tags, 'outdoor, power');
  assert.equal(inf.project_name, 'Bluetti Summer Launch');
  assert.equal(inf.product_name, 'Power Station');
  assert.equal(inf.reporter, 'Derrick');
  assert.equal(inf.cost_usd, 1500);
  assert.equal(inf.quoted_price, 2500);
  assert.equal(inf.content_deliverable, '1 short video + 1 story');
  assert.equal(inf.contact_email, 'creator@example.com');
  assert.equal(inf.cpm, 33);
  assert.equal(inf.cpv, 0.05);
  const byId = await invoke(routes, 'GET /api/influencers', { query: { search: String(inf.id) } });
  assert.equal(byId.payload.influencers.some(function(row) { return row.id === inf.id; }), true);
  const byLink = await invoke(routes, 'GET /api/influencers', { query: { search: 'legacy' } });
  assert.equal(byLink.payload.influencers.some(function(row) { return row.id === inf.id; }), true);
  const byTag = await invoke(routes, 'GET /api/influencers', { query: { search: 'outdoor' } });
  assert.equal(byTag.payload.influencers.some(function(row) { return row.id === inf.id; }), true);

  db.close();
});

test('influencer import rolls back business rows when required knowledge archival fails', async () => {
  const db = freshDb();
  const routes = mountRoutes(db);
  const before = db.prepare('SELECT COUNT(*) AS count FROM influencers').get().count;
  db.exec(`
    CREATE TRIGGER test_fail_required_influencer_batch_archive
    BEFORE INSERT ON knowledge_entries
    WHEN NEW.source_type='influencer_import'
    BEGIN SELECT RAISE(ABORT,'injected required influencer archive failure'); END
  `);

  const result = await invoke(routes, 'POST /api/influencers/import', {
    body: {
      batch_id: 'required-archive-rollback',
      rows: [{ '网红频道名称': '@required_archive_rollback' }]
    }
  });
  assert.equal(result.statusCode, 500);
  assert.match(result.payload.error, /injected required influencer archive failure/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM influencers').get().count, before);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM knowledge_entries
    WHERE source_type='influencer_import' AND source_id='required-archive-rollback'
  `).get().count, 0);

  db.close();
});

test('influencer import replays one batch without duplicate rows and rejects changed evidence', async () => {
  const db = freshDb();
  const routes = mountRoutes(db);
  const request = {
    batch_id: 'idempotent-influencer-batch',
    rows: [{
      '网红频道名称': '@idempotent_creator',
      '网红频道链接': 'https://example.com/idempotent_creator',
      '网红粉丝量': '12000',
      '项目&客户': 'Idempotent Project'
    }]
  };

  const created = await invoke(routes, 'POST /api/influencers/import', { body: request });
  const replay = await invoke(routes, 'POST /api/influencers/import', { body: request });
  const changed = await invoke(routes, 'POST /api/influencers/import', {
    body: {
      ...request,
      rows: [{ ...request.rows[0], '网红粉丝量': '13000' }]
    }
  });

  assert.equal(created.statusCode, 200);
  assert.equal(created.payload.imported, 1);
  assert.equal(created.payload.replayed, false);
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.payload.imported, 0);
  assert.equal(replay.payload.replayed, true);
  assert.equal(replay.payload.knowledge_entry_id, created.payload.knowledge_entry_id);
  assert.equal(changed.statusCode, 409);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM influencers WHERE import_batch=?
  `).get(request.batch_id).count, 1);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM knowledge_entries
    WHERE source_type='influencer_import' AND source_id=?
  `).get(request.batch_id).count, 1);

  db.close();
});

test('influencer import normalizes legacy negative amount cells to nonnegative magnitudes', async () => {
  const db = freshDb();
  const routes = mountRoutes(db);

  const result = await invoke(routes, 'POST /api/influencers/import', {
    body: {
      batch_id: 'legacy-negative-amounts',
      rows: [{
        '网红频道名称': '@legacy_negative_amounts',
        '网红成本价格（折算美元）': '-3000',
        '对外商务报价（美元）': '-4500',
        'CPM（自动计算）': '-137.2',
        'CPV(自动计算)': '-0.14'
      }]
    }
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.imported, 1);
  const inf = db.prepare('SELECT cost_usd,quoted_price,cpm,cpv FROM influencers WHERE kol_handle = ?')
    .get('@legacy_negative_amounts');
  assert.deepEqual(inf, { cost_usd: 3000, quoted_price: 4500, cpm: 137.2, cpv: 0.14 });

  db.close();
});

test('influencer import accepts the custom upload header workbook contract', async () => {
  const db = freshDb();
  const routes = mountRoutes(db);

  const result = await invoke(routes, 'POST /api/influencers/import', {
    body: {
      batch_id: 'custom-header-batch',
      rows: [{
        '日期': '2026-07-03',
        '提报人': 'Derrick',
        '项目&客户': 'Bluetti / Summer Launch',
        '推广产品': 'Power Station',
        '是否重复': '否',
        '网红频道名称': '@custom_kol',
        '网红粉丝量': '88K',
        '网红频道链接': 'https://example.com/custom-kol',
        '社媒平台': 'Instagram',
        '国家': 'US',
        '网红类型': 'Outdoor Tech',
        '近10个视频均播': '22000',
        '网红成本价格（折算美元）': '900',
        '网红交付物（植入-完播等信息）': '1 reel + 1 story',
        'Turing备注': 'Custom header note',
        '对外商务报价（美元）': '1600',
        '网红联系方式': 'custom@example.com',
        'CPM（自动计算）': '41',
        'CPV(自动计算)': '0.04',
        '父记录': 'CRM-001'
      }]
    }
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.imported, 1);
  const inf = db.prepare("SELECT * FROM influencers WHERE import_batch = ? AND kol_handle = ?").get('custom-header-batch', '@custom_kol');
  assert.ok(inf);
  assert.equal(inf.project_name, 'Bluetti / Summer Launch');
  assert.equal(inf.influencer_type, 'Outdoor Tech');
  assert.equal(inf.category, 'Outdoor Tech');
  assert.equal(inf.cost_usd, 900);
  assert.equal(inf.content_deliverable, '1 reel + 1 story');
  assert.equal(inf.quoted_price, 1600);
  assert.equal(inf.contact_email, 'custom@example.com');
  assert.equal(inf.cpm, 41);
  assert.equal(inf.cpv, 0.04);
  assert.equal(inf.parent_record, 'CRM-001');

  const byParent = await invoke(routes, 'GET /api/influencers', { query: { search: 'CRM-001' } });
  assert.equal(byParent.payload.influencers.some(function(row) { return row.id === inf.id; }), true);

  db.close();
});

test('influencer template download uses the custom upload headers', async () => {
  const db = freshDb();
  const routes = mountRoutes(db);

  const result = await invoke(routes, 'GET /api/influencers/template');

  assert.equal(result.statusCode, 200);
  assert.match(result.headers['content-type'], /text\/csv/);
  assert.match(result.headers['content-disposition'], /influencer_import_template\.csv/);
  assertApprovedCsvHeaders(result.body);
  assert.match(result.body, /@sample_creator/);

  db.close();
});

test('real server exposes a credential-safe Feishu connection status to authenticated users', async () => {
  await withTempServer(async ({ baseUrl, token }) => {
    const response = await fetch(baseUrl + '/api/feishu/status', {
      headers: { Authorization: 'Bearer ' + token }
    });
    const text = await response.text();

    assert.equal(response.status, 200, text);
    const payload = JSON.parse(text);
    assert.deepEqual(payload, {
      configured: false,
      mode: 'unconfigured',
      sync_available: false,
      test_available: false,
      missing: ['FEISHU_WEBHOOK_URL_OR_BITABLE_CONFIG']
    });
    assert.doesNotMatch(text, /secret|https?:/i);
  });
});

test('influencer upload route imports a multipart CSV through the real server', async () => {
  await withTempServer(async ({ baseUrl, token, dbPath }) => {
    const Database = require('better-sqlite3');
    const csv = '\uFEFF' + influencerWorkflow.TEMPLATE_HEADERS.join(',') + '\n' + [
      '2026-07-13',
      'Fixture Upload',
      'Upload Route Launch',
      'Upload Product',
      'No',
      '@upload_route_kol',
      '66000',
      'https://example.com/upload-route',
      'TikTok',
      'US',
      'Upload Tech',
      '18000',
      '700',
      '1 upload video',
      'Uploaded through temp server',
      '1200',
      'upload-route@example.com',
      '38',
      '0.07',
      'UPLOAD-PARENT'
    ].join(',') + '\n';
    const form = new FormData();
    form.append('batch_id', 'upload-route-batch');
    form.append('file', new Blob([csv], { type: 'text/csv;charset=utf-8' }), 'task9-upload.csv');

    const response = await fetch(baseUrl + '/api/influencers/upload', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token },
      body: form
    });
    const responseText = await response.text();
    assert.equal(response.status, 200, responseText);
    const payload = JSON.parse(responseText);

    assert.equal(payload.imported, 1);
    assert.equal(payload.skipped, 0);

    const db = new Database(dbPath, { readonly: true });
    const inf = db.prepare("SELECT * FROM influencers WHERE import_batch = ? AND kol_handle = ?")
      .get('upload-route-batch', '@upload_route_kol');
    assert.ok(inf);
    assert.equal(inf.data_source, 'upload');
    assert.equal(inf.project_name, 'Upload Route Launch');
    assert.equal(inf.product_name, 'Upload Product');
    assert.equal(inf.profile_link, 'https://example.com/upload-route');
    assert.equal(inf.followers, 66000);
    assert.equal(inf.region, 'US');
    assert.equal(inf.influencer_type, 'Upload Tech');
    assert.equal(inf.content_deliverable, '1 upload video');
    assert.equal(inf.quoted_price, 1200);
    assert.equal(inf.contact_email, 'upload-route@example.com');
    assert.equal(inf.cpm, 38);
    assert.equal(inf.cpv, 0.07);
    assert.equal(inf.parent_record, 'UPLOAD-PARENT');
    db.close();
  });
});

test('same-name influencer uploads derive distinct immutable batches from revised file bytes', async () => {
  await withTempServer(async ({ baseUrl, token, dbPath }) => {
    const Database = require('better-sqlite3');
    async function upload(handle, followers) {
      const csv = [
        'KOL Handle,Platform,Followers,Link,Project',
        `${handle},TikTok,${followers},https://example.com/${handle.slice(1)},Same Name Upload`
      ].join('\n');
      const form = new FormData();
      form.append('batch_id', 'revised-influencers.csv');
      form.append('file', new Blob([csv], { type: 'text/csv;charset=utf-8' }), 'revised-influencers.csv');
      const response = await fetch(baseUrl + '/api/influencers/upload', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token },
        body: form
      });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      return JSON.parse(text);
    }

    const first = await upload('@same_name_v1', 1000);
    const revised = await upload('@same_name_v2', 2000);

    assert.notEqual(first.batch, 'revised-influencers.csv');
    assert.notEqual(revised.batch, 'revised-influencers.csv');
    assert.notEqual(first.batch, revised.batch);
    assert.equal(first.imported, 1);
    assert.equal(revised.imported, 1);

    const db = new Database(dbPath, { readonly: true });
    try {
      assert.equal(db.prepare(`
        SELECT COUNT(*) AS count FROM influencers
        WHERE kol_handle IN ('@same_name_v1','@same_name_v2')
      `).get().count, 2);
      assert.equal(db.prepare(`
        SELECT COUNT(DISTINCT import_batch) AS count FROM influencers
        WHERE kol_handle IN ('@same_name_v1','@same_name_v2')
      `).get().count, 2);
    } finally {
      db.close();
    }
  });
});

test('influencer upload removes temporary files when the table has no data rows', async () => {
  await withTempServer(async ({ baseUrl, token, uploadDir }) => {
    const form = new FormData();
    form.append('file', new Blob(['KOL Handle,Platform\n'], { type: 'text/csv;charset=utf-8' }), 'headers-only.csv');

    const response = await fetch(baseUrl + '/api/influencers/upload', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token },
      body: form
    });
    const responseText = await response.text();

    assert.equal(response.status, 400, responseText);
    assert.match(responseText, /No table rows found/i);
    assert.deepEqual(fs.readdirSync(uploadDir), []);
  });
});

test('temp upload server cleanup removes sqlite sidecars and exits child', async () => {
  let capturedDbPath = null;
  let capturedPid = null;
  await withTempServer(
    async ({ dbPath, child }) => {
      capturedDbPath = dbPath;
      capturedPid = child.pid;
    },
    {
      beforeCleanup: ({ dbPath }) => {
        fs.writeFileSync(`${dbPath}-wal`, 'pending wal cleanup');
        fs.writeFileSync(`${dbPath}-shm`, 'pending shm cleanup');
      }
    }
  );

  assert.ok(capturedDbPath, 'Temp DB path should be captured');
  for (const filePath of tempDbPaths(capturedDbPath)) {
    assert.equal(fs.existsSync(filePath), false, `Expected temp cleanup to remove ${filePath}`);
  }
  assert.equal(processExists(capturedPid), false, 'Temp server process should be fully exited after cleanup');
});

test('influencer list search covers ids, tags, links, contacts, resource fields, parent records, and numeric fields', async () => {
  const db = freshDb();
  const routes = mountRoutes(db);
  const id = insertInfluencer(db, {
    platform: 'YouTube',
    kol_handle: '@search_target',
    profile_link: 'https://example.com/search-link-777',
    followers: 777123,
    avg_views_10: 54321,
    avg_engagement: 4.8,
    category: 'Outdoor Search',
    region: 'US',
    content_style: 'needle style',
    cost_usd: 987,
    cpm: 12,
    cpv: 0.11,
    brand_collab_history: 'needle brand history',
    contact_email: 'needle-contact@example.com',
    data_source: 'test',
    project_name: 'Search Project',
    product_name: 'Search Product',
    tags: 'needle-tag,power',
    quoted_price: 3210,
    content_deliverable: 'needle deliverable',
    influencer_type: 'precision tester',
    parent_record: 'PARENT-777'
  });

  for (const term of [
    String(id),
    'needle-tag',
    'search-link-777',
    'needle-contact@example.com',
    'needle deliverable',
    'precision tester',
    'PARENT-777',
    '777123',
    '54321',
    '987',
    '3210',
    '0.11'
  ]) {
    const result = await invoke(routes, 'GET /api/influencers', { query: { search: term } });
    assert.equal(result.statusCode, 200);
    assert.equal(result.payload.influencers.some(function(row) { return row.id === id; }), true, `search must find ${term}`);
  }

  db.close();
});

test('influencer export uses approved headers and mirrors active list filtering for all, filtered, and selected rows', async () => {
  const db = freshDb();
  const routes = mountRoutes(db);
  const alphaId = insertInfluencer(db, {
    platform: 'YouTube',
    kol_handle: '@alpha_export',
    profile_link: 'https://example.com/alpha-link',
    followers: 300000,
    avg_views_10: 90000,
    category: 'Outdoor Tech',
    region: 'US',
    cost_usd: 1500,
    cpm: 33,
    cpv: 0.05,
    contact_email: 'alpha-export@example.com',
    data_source: 'test',
    project_name: 'Bluetti Summer Launch',
    product_name: 'Power Station Pro',
    tags: 'power,launch',
    quoted_price: 2500,
    content_deliverable: 'integrated review',
    influencer_type: 'Outdoor Tech',
    parent_record: 'CRM-ALPHA'
  });
  const betaId = insertInfluencer(db, {
    platform: 'Instagram',
    kol_handle: '@beta_export',
    profile_link: 'https://example.com/beta-link',
    followers: 120000,
    avg_views_10: 40000,
    category: 'Smart Home',
    region: 'DE',
    cost_usd: 900,
    cpm: 44,
    cpv: 0.09,
    contact_email: 'beta-export@example.com',
    data_source: 'test',
    project_name: 'Sensor Launch',
    product_name: 'Fixture Sensor',
    tags: 'smart-home',
    quoted_price: 1400,
    content_deliverable: 'two reels',
    influencer_type: 'Lifestyle',
    parent_record: 'CRM-BETA'
  });
  const inactiveId = insertInfluencer(db, {
    platform: 'TikTok',
    kol_handle: '@inactive_export',
    profile_link: 'https://example.com/inactive-link',
    followers: 999999,
    category: 'Inactive',
    region: 'US',
    contact_email: 'inactive@example.com',
    data_source: 'test',
    project_name: 'Inactive Project',
    product_name: 'Inactive Product',
    tags: 'inactive',
    parent_record: 'CRM-INACTIVE',
    is_active: 0
  });

  async function exportedHandles(body) {
    const result = await invoke(routes, 'POST /api/influencers/export', { body });
    assert.equal(result.statusCode, 200);
    assertApprovedCsvHeaders(result.body);
    return parseCsvRows(result.body).slice(1).map(function(row) { return row[5]; });
  }

  async function listedHandles(query) {
    const result = await invoke(routes, 'GET /api/influencers', { query });
    assert.equal(result.statusCode, 200);
    return result.payload.influencers.map(function(row) { return row.kol_handle; });
  }

  async function assertFilteredExportMatchesList(filters) {
    assert.deepEqual(
      await exportedHandles({ mode: 'filtered', filters }),
      await listedHandles(filters),
      'filtered export must mirror list route for ' + JSON.stringify(filters)
    );
  }

  const allHandles = await exportedHandles({ mode: 'all' });
  assert.equal(allHandles.includes('@alpha_export'), true);
  assert.equal(allHandles.includes('@beta_export'), true);
  assert.equal(allHandles.includes('@inactive_export'), false);
  await assertFilteredExportMatchesList({ platform: 'YouTube' });
  await assertFilteredExportMatchesList({ region: 'DE' });
  await assertFilteredExportMatchesList({ project_name: 'Bluetti' });
  await assertFilteredExportMatchesList({ product_name: 'Station' });
  await assertFilteredExportMatchesList({ tags: 'Outdoor' });
  await assertFilteredExportMatchesList({ search: 'alpha-link' });
  await assertFilteredExportMatchesList({ search: 'CRM-BETA' });
  await assertFilteredExportMatchesList({ search: 'beta-export@example.com' });
  await assertFilteredExportMatchesList({ search: '0.05' });
  await assertFilteredExportMatchesList({ min_followers: '200000' });
  await assertFilteredExportMatchesList({ max_followers: '130000' });
  assert.deepEqual(await exportedHandles({ mode: 'selected', ids: [betaId, inactiveId] }), ['@beta_export']);
  assert.deepEqual(await exportedHandles({ mode: 'selected', ids: [] }), []);
  assert.deepEqual(await exportedHandles({ mode: 'selected', ids: ['abc', null, 0, -7, '12.4'] }), []);
  assert.deepEqual(
    await exportedHandles({ mode: 'selected', ids: [String(betaId), 'not-a-number', inactiveId, 0, -4, `${alphaId}.5`] }),
    ['@beta_export']
  );
  assert.ok(alphaId);

  db.close();
});

test('selected influencer export never falls back to all active rows for empty or invalid ids', async () => {
  const db = freshDb();
  const routes = mountRoutes(db);
  const activeId = insertInfluencer(db, {
    platform: 'YouTube',
    kol_handle: '@selected_active_export',
    profile_link: 'https://example.com/selected-active',
    followers: 45000,
    category: 'Selected',
    region: 'US',
    contact_email: 'selected-active@example.com',
    data_source: 'test',
    project_name: 'Selected Project',
    product_name: 'Selected Product',
    tags: 'selected-active',
    parent_record: 'CRM-SELECTED'
  });
  const inactiveId = insertInfluencer(db, {
    platform: 'TikTok',
    kol_handle: '@selected_inactive_export',
    profile_link: 'https://example.com/selected-inactive',
    followers: 95000,
    category: 'Selected',
    region: 'US',
    contact_email: 'selected-inactive@example.com',
    data_source: 'test',
    project_name: 'Selected Inactive Project',
    product_name: 'Selected Inactive Product',
    tags: 'selected-inactive',
    parent_record: 'CRM-SELECTED-INACTIVE',
    is_active: 0
  });

  async function selectedHandles(ids) {
    const result = await invoke(routes, 'POST /api/influencers/export', {
      body: { mode: 'selected', ids }
    });
    assert.equal(result.statusCode, 200);
    assertApprovedCsvHeaders(result.body);
    return parseCsvRows(result.body).slice(1).map(function(row) { return row[5]; });
  }

  assert.deepEqual(await selectedHandles([]), []);
  assert.deepEqual(await selectedHandles(['abc', null, 0, -2, '12.8']), []);
  assert.deepEqual(await selectedHandles([String(activeId), 'bad-id', inactiveId, 0, -3]), ['@selected_active_export']);

  db.close();
});

test('feishu sync endpoint degrades to a downloadable payload when webhook is not configured', async () => {
  const previousWebhookUrl = process.env.FEISHU_WEBHOOK_URL;
  const previousWebhook = process.env.FEISHU_WEBHOOK;
  delete process.env.FEISHU_WEBHOOK_URL;
  delete process.env.FEISHU_WEBHOOK;
  const db = freshDb();
  const routes = mountRoutes(db);
  const id = db.prepare(`
    INSERT INTO influencers (platform, kol_handle, profile_link, followers, region, tags, data_source)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('YouTube', '@feishu_ready', 'https://example.com/f', 90000, 'US', 'tech', 'test').lastInsertRowid;

  const result = await invoke(routes, 'POST /api/influencers/feishu/sync', {
    body: { ids: [id] }
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.configured, false);
  assert.equal(result.payload.records, 1);
  assertApprovedCsvHeaders(result.payload.csv);
  assert.match(result.payload.csv, /@feishu_ready/);
  assert.match(result.payload.message, /FEISHU_WEBHOOK_URL/);

  if (previousWebhookUrl !== undefined) process.env.FEISHU_WEBHOOK_URL = previousWebhookUrl;
  if (previousWebhook !== undefined) process.env.FEISHU_WEBHOOK = previousWebhook;
  db.close();
});

test('feishu sync endpoint posts approved 20-header records when webhook is configured', async () => {
  const previousWebhookUrl = process.env.FEISHU_WEBHOOK_URL;
  const previousWebhook = process.env.FEISHU_WEBHOOK;
  const previousFetch = global.fetch;
  process.env.FEISHU_WEBHOOK_URL = 'https://feishu.example.invalid/webhook';
  delete process.env.FEISHU_WEBHOOK;
  const db = freshDb();
  const routes = mountRoutes(db);
  const id = insertInfluencer(db, {
    platform: 'YouTube',
    kol_handle: '@feishu_configured',
    profile_link: 'https://example.com/feishu-configured',
    followers: 123456,
    avg_views_10: 45678,
    category: 'Configured Type',
    region: 'US',
    cost_usd: 1600,
    cpm: 35,
    cpv: 0.08,
    contact_email: 'configured@example.com',
    data_source: 'test',
    project_name: 'Configured Project',
    product_name: 'Configured Product',
    tags: 'configured',
    quoted_price: 2600,
    content_deliverable: 'configured deliverable',
    influencer_type: 'Configured Type',
    parent_record: 'CRM-FEISHU'
  });
  const calls = [];
  global.fetch = async function(url, options) {
    calls.push({ url, options });
    return { ok: true, status: 200 };
  };

  try {
    const result = await invoke(routes, 'POST /api/influencers/feishu/sync', {
      body: { ids: [id] }
    });

    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.payload, { configured: true, synced: 1, records: 1 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://feishu.example.invalid/webhook');
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.event, 'turingmarket.influencers.sync');
    assert.equal(body.source, 'TuringMarket');
    assertApprovedCsvHeaders(body.csv);
    assert.deepEqual(Object.keys(body.records[0]), influencerWorkflow.TEMPLATE_HEADERS);
    assert.equal(body.records[0]['网红频道名称'], '@feishu_configured');
    assert.equal(body.records[0]['父记录'], 'CRM-FEISHU');
  } finally {
    global.fetch = previousFetch;
    if (previousWebhookUrl === undefined) delete process.env.FEISHU_WEBHOOK_URL;
    else process.env.FEISHU_WEBHOOK_URL = previousWebhookUrl;
    if (previousWebhook === undefined) delete process.env.FEISHU_WEBHOOK;
    else process.env.FEISHU_WEBHOOK = previousWebhook;
    db.close();
  }
});

test('feishu sync endpoint keeps configured Bitable mode on CSV fallback until the write contract is approved', async () => {
  const previous = {
    mode: process.env.FEISHU_SYNC_MODE,
    webhookUrl: process.env.FEISHU_WEBHOOK_URL,
    webhook: process.env.FEISHU_WEBHOOK,
    appId: process.env.FEISHU_APP_ID,
    appSecret: process.env.FEISHU_APP_SECRET,
    appToken: process.env.FEISHU_BITABLE_APP_TOKEN,
    tableId: process.env.FEISHU_BITABLE_TABLE_ID,
    fetch: global.fetch
  };
  process.env.FEISHU_SYNC_MODE = 'bitable';
  delete process.env.FEISHU_WEBHOOK_URL;
  delete process.env.FEISHU_WEBHOOK;
  process.env.FEISHU_APP_ID = 'cli_test_app';
  process.env.FEISHU_APP_SECRET = 'test-secret';
  process.env.FEISHU_BITABLE_APP_TOKEN = 'basc_test';
  process.env.FEISHU_BITABLE_TABLE_ID = 'tbl_test';
  const db = freshDb();
  const routes = mountRoutes(db);
  const id = insertInfluencer(db, {
    platform: 'TikTok',
    kol_handle: '@bitable_configured',
    profile_link: 'https://example.com/bitable-configured',
    followers: 88888,
    region: 'US',
    data_source: 'test'
  });
  const calls = [];
  global.fetch = async function(url, options) {
    calls.push({ url, options });
    throw new Error('Bitable write must not be called by the current sync endpoint');
  };

  try {
    const result = await invoke(routes, 'POST /api/influencers/feishu/sync', { body: { ids: [id] } });

    assert.equal(result.statusCode, 200);
    assert.equal(result.payload.configured, false);
    assert.equal(result.payload.records, 1);
    assert.match(result.payload.csv, /@bitable_configured/);
    assert.equal(result.payload.message, 'Feishu Bitable write is not enabled. CSV fallback is ready for manual upload.');
    assert.equal(calls.length, 0);
  } finally {
    global.fetch = previous.fetch;
    Object.entries({
      FEISHU_SYNC_MODE: previous.mode,
      FEISHU_WEBHOOK_URL: previous.webhookUrl,
      FEISHU_WEBHOOK: previous.webhook,
      FEISHU_APP_ID: previous.appId,
      FEISHU_APP_SECRET: previous.appSecret,
      FEISHU_BITABLE_APP_TOKEN: previous.appToken,
      FEISHU_BITABLE_TABLE_ID: previous.tableId
    }).forEach(function(entry) {
      if (entry[1] === undefined) delete process.env[entry[0]];
      else process.env[entry[0]] = entry[1];
    });
    db.close();
  }
});

test('feishu sync endpoint sends a server-built Bitable batch only with a UUID idempotency key', async () => {
  const previous = {
    mode: process.env.FEISHU_SYNC_MODE,
    webhookUrl: process.env.FEISHU_WEBHOOK_URL,
    webhook: process.env.FEISHU_WEBHOOK,
    appId: process.env.FEISHU_APP_ID,
    appSecret: process.env.FEISHU_APP_SECRET,
    appToken: process.env.FEISHU_BITABLE_APP_TOKEN,
    tableId: process.env.FEISHU_BITABLE_TABLE_ID,
    writeEnabled: process.env.FEISHU_BITABLE_WRITE_ENABLED,
    includeContactEmail: process.env.FEISHU_BITABLE_INCLUDE_CONTACT_EMAIL,
    fetch: global.fetch
  };
  process.env.FEISHU_SYNC_MODE = 'bitable';
  delete process.env.FEISHU_WEBHOOK_URL;
  delete process.env.FEISHU_WEBHOOK;
  process.env.FEISHU_APP_ID = 'cli_test_app';
  process.env.FEISHU_APP_SECRET = 'test-secret';
  process.env.FEISHU_BITABLE_APP_TOKEN = 'basc_test';
  process.env.FEISHU_BITABLE_TABLE_ID = 'tbl_test';
  process.env.FEISHU_BITABLE_WRITE_ENABLED = 'true';
  delete process.env.FEISHU_BITABLE_INCLUDE_CONTACT_EMAIL;
  const db = freshDb();
  const routes = mountRoutes(db);
  const originalPrepare = db.prepare;
  db.prepare = function(sql) {
    if (String(sql).indexOf('INSERT INTO activity_log') !== -1) throw new Error('activity log is temporarily unavailable');
    return originalPrepare.call(this, sql);
  };
  const id = insertInfluencer(db, {
    platform: 'TikTok',
    kol_handle: '@bitable_delivery',
    profile_link: 'https://example.com/bitable-delivery',
    followers: 88888,
    region: 'US',
    contact_email: 'private@example.com',
    data_source: 'test'
  });
  const calls = [];
  global.fetch = async function(url, options) {
    calls.push({ url, options });
    if (calls.length === 1) return { ok: true, status: 200, async json() { return { code: 0, tenant_access_token: 'tenant-test-token' }; } };
    if (calls.length === 2) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            code: 0,
            data: {
              items: influencerWorkflow.TEMPLATE_HEADERS
                .map(function(fieldName) { return { field_name: fieldName }; })
            }
          };
        }
      };
    }
    return { ok: true, status: 200, async json() { return { code: 0, data: { records: [{ record_id: 'rec_delivery_1' }] } }; } };
  };

  try {
    const result = await invoke(routes, 'POST /api/influencers/feishu/sync', {
      body: { ids: [id] },
      headers: { 'Idempotency-Key': '6b4dd91f-e911-4416-a201-4d5f80875c5c' }
    });

    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.payload, { configured: true, synced: 1, records: 1 });
    assert.equal(calls.length, 3);
    const body = JSON.parse(calls[2].options.body);
    assert.equal(body.client_token, '6b4dd91f-e911-4416-a201-4d5f80875c5c');
    assert.equal(body.records[0].fields['网红频道名称'], '@bitable_delivery');
    assert.equal(Object.hasOwn(body.records[0].fields, '网红联系方式'), false);
  } finally {
    global.fetch = previous.fetch;
    db.prepare = originalPrepare;
    Object.entries({
      FEISHU_SYNC_MODE: previous.mode,
      FEISHU_WEBHOOK_URL: previous.webhookUrl,
      FEISHU_WEBHOOK: previous.webhook,
      FEISHU_APP_ID: previous.appId,
      FEISHU_APP_SECRET: previous.appSecret,
      FEISHU_BITABLE_APP_TOKEN: previous.appToken,
      FEISHU_BITABLE_TABLE_ID: previous.tableId,
      FEISHU_BITABLE_WRITE_ENABLED: previous.writeEnabled,
      FEISHU_BITABLE_INCLUDE_CONTACT_EMAIL: previous.includeContactEmail
    }).forEach(function(entry) {
      if (entry[1] === undefined) delete process.env[entry[0]];
      else process.env[entry[0]] = entry[1];
    });
    db.close();
  }
});

test('campaign-scoped Bitable sync stores a durable receipt, returns it on replay, and lists it without a second provider call', async () => {
  const db = freshDb();
  const campaignId = createFeishuOutboxCampaign(db, 980101, 2);
  const influencerId = insertInfluencer(db, {
    platform: 'TikTok',
    kol_handle: '@outbox_delivery',
    profile_link: 'https://example.com/outbox-delivery',
    followers: 120000,
    project_name: 'Outbox Project',
    product_name: 'Outbox Product',
    data_source: 'test'
  });
  const calls = { prepare: 0, sync: [] };
  const feishuClient = {
    getStatus: function() {
      return { configured: true, mode: 'bitable', sync_available: true };
    },
    prepareBitableOutboxPayload: function(values) {
      calls.prepare += 1;
      return {
        records: values.records.map(function(record) {
          return {
            fields: {
              '网红频道名称': record['网红频道名称'],
              '网红频道链接': record['网红频道链接'],
              '项目&客户': record['项目&客户']
            }
          };
        })
      };
    },
    syncInfluencers: async function(values) {
      calls.sync.push(values);
      return {
        configured: true,
        mode: 'bitable',
        synced: values.records.length,
        records: values.records.length,
        remoteRecordIds: values.bitableRecords.map(function(record, index) {
          return 'rec_outbox_' + (index + 1) + '_' + record.fields['网红频道名称'];
        })
      };
    }
  };
  const routes = mountRoutes(db, { feishuClient });
  const request = {
    body: { ids: [influencerId], campaign_id: campaignId },
    headers: { 'Idempotency-Key': 'f47ac1cb-5d7a-4542-9282-26e3e273f5a0' }
  };

  const first = await invoke(routes, 'POST /api/influencers/feishu/sync', request);
  assert.equal(first.statusCode, 200);
  assert.equal(first.payload.configured, true);
  assert.equal(first.payload.synced, 1);
  assert.deepEqual(first.payload.delivery && {
    campaign_id: first.payload.delivery.campaign_id,
    status: first.payload.delivery.status,
    record_count: first.payload.delivery.record_count,
    remote_record_count: first.payload.delivery.remote_record_count,
    last_error_code: first.payload.delivery.last_error_code
  }, {
    campaign_id: campaignId,
    status: 'succeeded',
    record_count: 1,
    remote_record_count: 1,
    last_error_code: null
  });
  assert.equal(calls.sync.length, 1);
  assert.equal(calls.sync[0].includeReceipt, true);
  assert.equal(calls.sync[0].operationId, request.headers['Idempotency-Key']);
  assert.deepEqual(calls.sync[0].bitableRecords, [{
    fields: {
      '网红频道名称': '@outbox_delivery',
      '网红频道链接': 'https://example.com/outbox-delivery',
      '项目&客户': 'Outbox Project'
    }
  }]);

  const replay = await invoke(routes, 'POST /api/influencers/feishu/sync', request);
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(replay.payload, first.payload);
  assert.equal(calls.prepare, 2);
  assert.equal(calls.sync.length, 1);

  const deliveries = await invoke(routes, 'GET /api/campaigns/:id/feishu-deliveries', {
    params: { id: campaignId },
    query: { limit: '1' }
  });
  assert.equal(deliveries.statusCode, 200);
  assert.deepEqual(deliveries.payload.deliveries, [first.payload.delivery]);
  db.close();
});

test('campaign-scoped Bitable sync preserves an ambiguous provider result for owner reconciliation without a second provider call', async () => {
  const db = freshDb();
  const campaignId = createFeishuOutboxCampaign(db, 980201, 2);
  const influencerId = insertInfluencer(db, {
    platform: 'YouTube',
    kol_handle: '@outbox_failure',
    profile_link: 'https://example.com/outbox-failure',
    followers: 90000,
    data_source: 'test'
  });
  let providerCalls = 0;
  const routes = mountRoutes(db, {
    feishuClient: {
      getStatus: function() {
        return { configured: true, mode: 'bitable', sync_available: true };
      },
      prepareBitableOutboxPayload: function(values) {
        return {
          records: values.records.map(function(record) {
            return { fields: { '网红频道名称': record['网红频道名称'] } };
          })
        };
      },
      syncInfluencers: async function() {
        providerCalls += 1;
        throw new Error('provider unavailable');
      }
    }
  });
  const request = {
    body: { ids: [influencerId], campaign_id: campaignId },
    headers: { 'Idempotency-Key': 'e4d12f8f-bb3e-4a99-b12e-92605b9e9927' }
  };

  const ambiguous = await invoke(routes, 'POST /api/influencers/feishu/sync', request);
  assert.equal(ambiguous.statusCode, 202);
  assert.equal(ambiguous.payload.code, 'FEISHU_OUTBOX_RECONCILIATION_REQUIRED');
  assert.equal(ambiguous.payload.delivery.status, 'pending');
  assert.equal(providerCalls, 1);

  const repeated = await invoke(routes, 'POST /api/influencers/feishu/sync', request);
  assert.equal(repeated.statusCode, 409);
  assert.equal(repeated.payload.code, 'FEISHU_OUTBOX_RECONCILIATION_REQUIRED');
  assert.equal(repeated.payload.delivery.status, 'pending');
  assert.equal(providerCalls, 1);

  const reconciled = await invoke(routes, 'POST /api/campaigns/:id/feishu-deliveries/:deliveryId/reconcile', {
    params: { id: campaignId, deliveryId: ambiguous.payload.delivery.id },
    body: { remote_record_ids: ['rec_manual_reconciliation'] }
  });
  assert.equal(reconciled.statusCode, 200);
  assert.deepEqual(reconciled.payload.delivery && {
    id: reconciled.payload.delivery.id,
    campaign_id: reconciled.payload.delivery.campaign_id,
    status: reconciled.payload.delivery.status,
    record_count: reconciled.payload.delivery.record_count,
    remote_record_count: reconciled.payload.delivery.remote_record_count,
    last_error_code: reconciled.payload.delivery.last_error_code
  }, {
    id: ambiguous.payload.delivery.id,
    campaign_id: campaignId,
    status: 'succeeded',
    record_count: 1,
    remote_record_count: 1,
    last_error_code: null
  });

  const replayed = await invoke(routes, 'POST /api/influencers/feishu/sync', request);
  assert.equal(replayed.statusCode, 200);
  assert.equal(replayed.payload.delivery.status, 'succeeded');
  assert.equal(providerCalls, 1);
  db.close();
});

test('campaign-scoped Bitable retry sends one exact stored snapshot and replays without another provider write', async () => {
  const db = freshDb();
  const campaignId = createFeishuOutboxCampaign(db, 980301, 2);
  const influencerId = insertInfluencer(db, {
    platform: 'TikTok',
    kol_handle: '@outbox_retry',
    profile_link: 'https://example.com/outbox-retry',
    followers: 73000,
    project_name: 'Retry Project',
    product_name: 'Retry Product',
    data_source: 'test'
  });
  const syncCalls = [];
  const routes = mountRoutes(db, {
    feishuClient: {
      getStatus: function() {
        return { configured: true, mode: 'bitable', sync_available: true };
      },
      prepareBitableOutboxPayload: function(values) {
        return {
          records: values.records.map(function(record) {
            return {
              fields: {
                '网红频道名称': record['网红频道名称'],
                '网红频道链接': record['网红频道链接'],
                '项目&客户': record['项目&客户']
              }
            };
          })
        };
      },
      syncInfluencers: async function(values) {
        syncCalls.push(values);
        if (syncCalls.length === 1) {
          return {
            configured: false,
            mode: 'bitable',
            records: values.records.length,
            csv: values.csv,
            message: 'Feishu Bitable write is not available.'
          };
        }
        return {
          configured: true,
          mode: 'bitable',
          synced: values.records.length,
          records: values.records.length,
          remoteRecordIds: ['rec_retry_1']
        };
      }
    }
  });
  const initial = await invoke(routes, 'POST /api/influencers/feishu/sync', {
    body: { ids: [influencerId], campaign_id: campaignId },
    headers: { 'Idempotency-Key': '5f9f5a2c-aa47-4c91-996d-dd84a17aaf75' }
  });
  assert.equal(initial.statusCode, 200);
  assert.equal(initial.payload.configured, false);
  assert.equal(initial.payload.delivery.status, 'failed');
  assert.equal(initial.payload.delivery.last_error_code, 'FEISHU_BITABLE_WRITE_NOT_AVAILABLE');

  const retryRequest = {
    params: { id: campaignId, deliveryId: initial.payload.delivery.id },
    body: { reason: 'Bitable write was enabled after the original failure.' },
    headers: { 'Idempotency-Key': '32681ac4-e1aa-4fb4-bb7c-8119a38625f4' }
  };
  const retried = await invoke(routes, 'POST /api/campaigns/:id/feishu-deliveries/:deliveryId/retry', retryRequest);
  assert.equal(retried.statusCode, 200);
  assert.equal(retried.payload.delivery.status, 'succeeded');
  assert.equal(retried.payload.delivery.retry_of_delivery_id, initial.payload.delivery.id);
  assert.equal(syncCalls.length, 2);
  assert.equal(syncCalls[1].operationId, retryRequest.headers['Idempotency-Key']);
  assert.equal(syncCalls[1].includeReceipt, true);
  assert.deepEqual(syncCalls[1].records, syncCalls[1].bitableRecords);
  assert.deepEqual(syncCalls[1].bitableRecords, [{
    fields: {
      '网红频道名称': '@outbox_retry',
      '网红频道链接': 'https://example.com/outbox-retry',
      '项目&客户': 'Retry Project'
    }
  }]);

  const replay = await invoke(routes, 'POST /api/campaigns/:id/feishu-deliveries/:deliveryId/retry', retryRequest);
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(replay.payload.delivery, retried.payload.delivery);
  assert.equal(syncCalls.length, 2);
  db.close();
});

test('collaboration order creation stores the selected resource definition', async () => {
  const db = freshDb();
  const routes = mountRoutes(db);
  const influencerId = db.prepare(`
    INSERT INTO influencers (platform, kol_handle, profile_link, followers, project_name, product_name, content_deliverable, quoted_price, data_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('TikTok', '@order_creator', 'https://example.com/o', 100000, 'Existing Project', 'Existing Product', 'Short video', 2100, 'test').lastInsertRowid;

  const result = await invoke(routes, 'POST /api/collaborations', {
    body: {
      influencer_id: influencerId,
      status: 'confirmed',
      resource: {
        schema: 'turingmarket.collaboration-order.v1',
        project_name: 'New Product Launch',
        product_name: 'Battery Pack',
        order_type: 'affiliate',
        order_reference: 'PO-RESOURCE-3200',
        deliverable: '1 short video + 1 livestream mention',
        quoted_price: 3200,
        owner: 'Derrick'
      },
      timeline_start: '2026-07-10',
      timeline_end: '2026-07-30',
      notes: 'Priority partner'
    }
  });

  assert.equal(result.statusCode, 200);
  const collab = db.prepare('SELECT * FROM collaborations WHERE id = ?').get(result.payload.id);
  assert.equal(collab.influencer_id, influencerId);
  assert.equal(collab.status, 'confirmed');
  assert.equal(collab.cost_quoted, 3200);
  assert.equal(collab.timeline_start, '2026-07-10');
  assert.equal(collab.timeline_end, '2026-07-30');
  assert.deepEqual(JSON.parse(collab.proposal_notes), {
    schema: 'turingmarket.collaboration-order.v1',
    project_name: 'New Product Launch',
    product_name: 'Battery Pack',
    order_type: 'affiliate',
    order_reference: 'PO-RESOURCE-3200',
    deliverable: '1 short video + 1 livestream mention',
    quoted_price: 3200,
    extensions: { owner: 'Derrick' }
  });
  assert.match(collab.notes, /Priority partner/);

  const update = await invoke(routes, 'PUT /api/collaborations/:id', {
    params: { id: result.payload.id },
    body: { cost_quoted: 3500 }
  });
  assert.equal(update.statusCode, 409);
  assert.equal(update.payload.code, 'RESOURCE_QUOTE_LOCKED');
  assert.equal(db.prepare('SELECT cost_quoted FROM collaborations WHERE id=?').get(result.payload.id).cost_quoted, 3200);

  db.close();
});

test('collaboration resource rejects invalid types before inserting a record', async () => {
  const db = freshDb();
  const routes = mountRoutes(db);
  const influencerId = insertInfluencer(db, {
    platform: 'TikTok',
    kol_handle: '@invalid_resource',
    profile_link: 'https://example.com/invalid-resource'
  });
  const before = db.prepare('SELECT COUNT(*) AS count FROM collaborations').get().count;

  const result = await invoke(routes, 'POST /api/collaborations', {
    body: {
      influencer_id: influencerId,
      resource: { schema: 'turingmarket.collaboration-order.v1', order_type: 'barter' }
    }
  });

  assert.equal(result.statusCode, 400);
  assert.equal(result.payload.code, 'INVALID_RESOURCE_TYPE');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM collaborations').get().count, before);
  db.close();
});

test('legacy collaboration proposal notes remain unchanged without a resource payload', async () => {
  const db = freshDb();
  const routes = mountRoutes(db);
  const influencerId = insertInfluencer(db, {
    platform: 'YouTube',
    kol_handle: '@legacy_resource_notes',
    profile_link: 'https://example.com/legacy-resource-notes'
  });
  const result = await invoke(routes, 'POST /api/collaborations', {
    body: {
      influencer_id: influencerId,
      proposal_notes: 'Legacy free-form proposal note',
      cost_quoted: 990
    }
  });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(db.prepare('SELECT proposal_notes,cost_quoted FROM collaborations WHERE id=?').get(result.payload.id), {
    proposal_notes: 'Legacy free-form proposal note',
    cost_quoted: 990
  });
  db.close();
});

test('legacy scalar resource fields keep their note and timeline fallbacks', async () => {
  const db = freshDb();
  const routes = mountRoutes(db);
  const influencerId = insertInfluencer(db, {
    platform: 'TikTok',
    kol_handle: '@legacy_scalar_resource',
    profile_link: 'https://example.com/legacy-scalar-resource'
  });
  const result = await invoke(routes, 'POST /api/collaborations', {
    body: {
      influencer_id: influencerId,
      resource: {
        price: '1200',
        owner: 'Derrick',
        notes: 'Legacy resource note',
        timeline_start: '2026-09-01',
        timeline_end: '2026-09-10'
      }
    }
  });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(db.prepare('SELECT cost_quoted,notes,timeline_start,timeline_end FROM collaborations WHERE id=?').get(result.payload.id), {
    cost_quoted: 1200,
    notes: 'Legacy resource note',
    timeline_start: '2026-09-01',
    timeline_end: '2026-09-10'
  });
  assert.deepEqual(JSON.parse(db.prepare('SELECT proposal_notes FROM collaborations WHERE id=?').get(result.payload.id).proposal_notes), {
    price: '1200',
    owner: 'Derrick',
    notes: 'Legacy resource note',
    timeline_start: '2026-09-01',
    timeline_end: '2026-09-10'
  });

  const update = await invoke(routes, 'PUT /api/collaborations/:id', {
    params: { id: result.payload.id },
    body: { cost_quoted: 1300 }
  });
  assert.equal(update.statusCode, 200);
  assert.equal(db.prepare('SELECT cost_quoted FROM collaborations WHERE id=?').get(result.payload.id).cost_quoted, 1300);
  db.close();
});

test('resource and legacy proposal notes cannot be supplied together', async () => {
  const db = freshDb();
  const routes = mountRoutes(db);
  const influencerId = insertInfluencer(db, {
    platform: 'YouTube',
    kol_handle: '@resource_proposal_conflict',
    profile_link: 'https://example.com/resource-proposal-conflict'
  });
  const before = db.prepare('SELECT COUNT(*) AS count FROM collaborations').get().count;
  const result = await invoke(routes, 'POST /api/collaborations', {
    body: {
      influencer_id: influencerId,
      resource: { schema: 'turingmarket.collaboration-order.v1', quoted_price: 1200 },
      proposal_notes: 'This must not be silently replaced.'
    }
  });

  assert.equal(result.statusCode, 400);
  assert.equal(result.payload.code, 'RESOURCE_PROPOSAL_NOTES_CONFLICT');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM collaborations').get().count, before);
  db.close();
});

test('v1 resource rejects an empty legacy proposal-notes field', async () => {
  const db = freshDb();
  const routes = mountRoutes(db);
  const influencerId = insertInfluencer(db, {
    platform: 'YouTube',
    kol_handle: '@resource_empty_proposal_conflict',
    profile_link: 'https://example.com/resource-empty-proposal-conflict'
  });
  const before = db.prepare('SELECT COUNT(*) AS count FROM collaborations').get().count;
  const result = await invoke(routes, 'POST /api/collaborations', {
    body: {
      influencer_id: influencerId,
      resource: { schema: 'turingmarket.collaboration-order.v1', quoted_price: 1200 },
      proposal_notes: ''
    }
  });

  assert.equal(result.statusCode, 400);
  assert.equal(result.payload.code, 'RESOURCE_PROPOSAL_NOTES_CONFLICT');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM collaborations').get().count, before);
  db.close();
});

test('legacy resource plus proposal notes keeps the historical free-form proposal note', async () => {
  const db = freshDb();
  const routes = mountRoutes(db);
  const influencerId = insertInfluencer(db, {
    platform: 'TikTok',
    kol_handle: '@legacy_combined_resource',
    profile_link: 'https://example.com/legacy-combined-resource'
  });
  const result = await invoke(routes, 'POST /api/collaborations', {
    body: {
      influencer_id: influencerId,
      resource: { price: 1200, owner: 'Derrick' },
      proposal_notes: 'Existing legacy proposal note'
    }
  });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(db.prepare('SELECT proposal_notes,cost_quoted FROM collaborations WHERE id=?').get(result.payload.id), {
    proposal_notes: 'Existing legacy proposal note',
    cost_quoted: 1200
  });
  db.close();
});

test('legacy resources with their own schema keep the historical free-form proposal path', async () => {
  const db = freshDb();
  const routes = mountRoutes(db);
  const influencerId = insertInfluencer(db, {
    platform: 'TikTok',
    kol_handle: '@legacy_schema_resource',
    profile_link: 'https://example.com/legacy-schema-resource'
  });
  const result = await invoke(routes, 'POST /api/collaborations', {
    body: {
      influencer_id: influencerId,
      resource: { schema: 'legacy.v0', price: 1200, owner: 'Derrick' },
      proposal_notes: 'Existing legacy proposal note'
    }
  });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(db.prepare('SELECT proposal_notes,cost_quoted FROM collaborations WHERE id=?').get(result.payload.id), {
    proposal_notes: 'Existing legacy proposal note',
    cost_quoted: 1200
  });
  db.close();
});

test('GET /api/collaborations freezes the exact legacy public projection and envelope', async () => {
  const db = freshDb();
  const routes = mountRoutes(db);
  const influencerId = insertInfluencer(db, {
    platform: 'YouTube',
    kol_handle: '@legacy_projection',
    profile_link: 'https://example.com/legacy-projection',
    followers: 123456,
    category: 'Technology',
    region: 'US',
    data_source: 'test',
    project_name: 'Legacy Joined Project',
    product_name: 'Legacy Joined Product',
    content_deliverable: '1 dedicated video',
    quoted_price: 3000
  });
  const proposalNotes = JSON.stringify({
    project_name: 'Legacy Proposal Project',
    quoted_price: 2850
  });
  const roiData = JSON.stringify({ views: 12345 });
  const collaborationId = db.prepare(`
    INSERT INTO collaborations (
      demand_id, influencer_id, user_id, status, proposal_notes, cost_quoted, cost_actual,
      content_url, roi_data, timeline_start, timeline_end, notes, created_at, updated_at,
      row_version, cost_actual_confirmed
    )
    VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    influencerId,
    2,
    'completed',
    proposalNotes,
    2850,
    2500,
    'https://example.com/published-content',
    roiData,
    '2026-08-01',
    '2026-08-15',
    'Legacy collaboration notes',
    '2026-07-19 10:00:00',
    '2026-07-20 10:00:00',
    7,
    1
  ).lastInsertRowid;

  const stored = db.prepare(
    'SELECT row_version, cost_actual_confirmed FROM collaborations WHERE id = ?'
  ).get(collaborationId);
  assert.deepEqual(stored, { row_version: 7, cost_actual_confirmed: 1 });

  const result = await invoke(routes, 'GET /api/collaborations');

  assert.equal(result.statusCode, 200);
  assert.deepEqual(Object.keys(result.payload), ['collaborations']);
  assert.equal(result.payload.collaborations.length, 1);
  const collaboration = result.payload.collaborations[0];
  assert.deepEqual(Object.keys(collaboration), [
    'id',
    'demand_id',
    'influencer_id',
    'user_id',
    'status',
    'proposal_notes',
    'cost_quoted',
    'cost_actual',
    'content_url',
    'roi_data',
    'timeline_start',
    'timeline_end',
    'notes',
    'created_at',
    'updated_at',
    'kol_handle',
    'platform',
    'followers',
    'category',
    'region',
    'project_name',
    'product_name',
    'content_deliverable',
    'quoted_price'
  ]);
  assert.deepEqual(collaboration, {
    id: collaborationId,
    demand_id: null,
    influencer_id: influencerId,
    user_id: 2,
    status: 'completed',
    proposal_notes: proposalNotes,
    cost_quoted: 2850,
    cost_actual: 2500,
    content_url: 'https://example.com/published-content',
    roi_data: roiData,
    timeline_start: '2026-08-01',
    timeline_end: '2026-08-15',
    notes: 'Legacy collaboration notes',
    created_at: '2026-07-19 10:00:00',
    updated_at: '2026-07-20 10:00:00',
    kol_handle: '@legacy_projection',
    platform: 'YouTube',
    followers: 123456,
    category: 'Technology',
    region: 'US',
    project_name: 'Legacy Joined Project',
    product_name: 'Legacy Joined Product',
    content_deliverable: '1 dedicated video',
    quoted_price: 3000
  });
  assert.equal(Object.hasOwn(collaboration, 'row_version'), false);
  assert.equal(Object.hasOwn(collaboration, 'cost_actual_confirmed'), false);

  db.close();
});

test('global collaboration list and stats conceal another owner before materializing legacy rows', async () => {
  const db = freshDb();
  const routes = mountRoutes(db);
  const influencerId = insertInfluencer(db, {
    platform: 'TikTok',
    kol_handle: '@collaboration_idor',
    profile_link: 'https://example.com/collaboration-idor',
    followers: 1000,
    category: 'Technology',
    region: 'US',
    data_source: 'test'
  });
  db.prepare(`
    INSERT INTO collaborations (influencer_id,user_id,status,cost_quoted,cost_actual)
    VALUES (?,2,'confirmed',100,100),(?,3,'completed',200,200)
  `).run(influencerId, influencerId);

  const actor = { id: 3, role: 'user', username: 'teammate' };
  const list = await invoke(routes, 'GET /api/collaborations', { user: actor });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.payload.collaborations.map((row) => row.user_id), [3]);

  const stats = await invoke(routes, 'GET /api/collaborations/stats', { user: actor });
  assert.deepEqual(stats.payload.stats, {
    byStatus: [{ status: 'completed', count: 1 }],
    totalActive: 0,
    totalCompleted: 1,
    totalCost: 200
  });

  db.close();
});

test('global collaboration update conceals another owner and leaves the row unchanged', async () => {
  const db = freshDb();
  const routes = mountRoutes(db);
  const influencerId = insertInfluencer(db, {
    platform: 'TikTok',
    kol_handle: '@collaboration_update_idor',
    profile_link: 'https://example.com/collaboration-update-idor',
    followers: 1000,
    category: 'Technology',
    region: 'US',
    data_source: 'test'
  });
  const collaborationId = db.prepare(`
    INSERT INTO collaborations (influencer_id,user_id,status,cost_quoted)
    VALUES (?,2,'confirmed',100)
  `).run(influencerId).lastInsertRowid;
  const before = db.prepare('SELECT status,row_version FROM collaborations WHERE id=?')
    .get(collaborationId);

  const result = await invoke(routes, 'PUT /api/collaborations/:id', {
    user: { id: 3, role: 'user', username: 'teammate' },
    params: { id: collaborationId },
    body: { status: 'completed' }
  });
  assert.equal(result.statusCode, 404);
  assert.equal(result.payload.code, 'RECORD_NOT_FOUND');
  assert.deepEqual(
    db.prepare('SELECT status,row_version FROM collaborations WHERE id=?').get(collaborationId),
    before
  );
  db.close();
});

test('collaboration list exposes resource fields and status updates persist', async () => {
  const db = freshDb();
  const routes = mountRoutes(db);
  const influencerId = insertInfluencer(db, {
    platform: 'YouTube',
    kol_handle: '@collab_list',
    profile_link: 'https://example.com/collab-list',
    followers: 100000,
    category: 'Resource Type',
    region: 'US',
    data_source: 'test',
    project_name: 'List Project',
    product_name: 'List Product',
    content_deliverable: 'List deliverable',
    quoted_price: 1800
  });
  const create = await invoke(routes, 'POST /api/collaborations', {
    body: {
      influencer_id: influencerId,
      status: 'proposed',
      resource: {
        project_name: 'List Project Override',
        product_name: 'List Product Override',
        deliverable: 'List resource deliverable',
        quoted_price: 2800
      },
      timeline_start: '2026-07-20',
      timeline_end: '2026-07-28',
      notes: 'List resource note'
    }
  });
  assert.equal(create.statusCode, 200);

  const list = await invoke(routes, 'GET /api/collaborations');
  assert.equal(list.statusCode, 200);
  const collab = list.payload.collaborations.find(function(row) { return row.id === create.payload.id; });
  assert.ok(collab);
  assert.equal(collab.kol_handle, '@collab_list');
  assert.equal(collab.project_name, 'List Project');
  assert.equal(collab.product_name, 'List Product');
  assert.equal(collab.content_deliverable, 'List deliverable');
  assert.equal(collab.quoted_price, 1800);
  assert.match(collab.proposal_notes, /List Project Override/);

  const update = await invoke(routes, 'PUT /api/collaborations/:id', {
    params: { id: create.payload.id },
    body: { status: 'completed' }
  });
  assert.equal(update.statusCode, 200);
  assert.equal(update.payload.success, true);
  const updated = db.prepare('SELECT status FROM collaborations WHERE id = ?').get(create.payload.id);
  assert.equal(updated.status, 'completed');

  const completed = await invoke(routes, 'GET /api/collaborations', { query: { status: 'completed' } });
  assert.equal(completed.payload.collaborations.some(function(row) { return row.id === create.payload.id; }), true);

  db.close();
});

test('m4 frontend keeps import, feishu, and order-resource controls wired', () => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const indexHtml = fs.readFileSync(path.join(repoRoot, 'platform', 'index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(repoRoot, 'platform', 'app.js'), 'utf8');

  assert.match(indexHtml, /id="collabFilter"/);
  assert.match(indexHtml, /id="collabStatsBar"/);
  assert.match(indexHtml, /id="m4CampaignContext"/);
  assert.match(indexHtml, /id="m4CampaignContextStatus"/);
  assert.match(indexHtml, /id="filt_search"/);
  assert.match(indexHtml, /id="infFileModal" accept="\.csv,\.json,\.xlsx"/);
  assert.match(indexHtml, /id="feishuConnectionStatus"/);
  assert.match(indexHtml, /id="feishuDeliveryStatus"/);
  assert.match(indexHtml, /id="feishuStatusRefresh"/);
  assert.match(indexHtml, /id="feishuTestButton"/);
  assert.match(appJs, /m4-table thead th\{position:sticky/);
  assert.match(appJs, /m4-table input\[type="checkbox"\]\{width:16px!important;height:16px!important/);
  assert.match(appJs, /function handleDrop/);
  assert.match(appJs, /function openInfUploadModal/);
  assert.match(appJs, /function handleUploadModal/);
  assert.match(appJs, /\/influencers\/upload/);
  assert.match(appJs, /\/influencers\/template/);
  assert.match(appJs, /\/influencers\/feishu\/sync/);
  assert.match(appJs, /\/campaigns\/.*feishu-deliveries/);
  assert.match(appJs, /\/feishu\/status/);
  assert.match(appJs, /\/feishu\/test/);
  assert.match(appJs, /function loadFeishuStatus/);
  assert.match(appJs, /function loadFeishuOutbox/);
  assert.match(appJs, /function testFeishuConnection/);
  assert.match(appJs, /campaign_id: campaignId/);
  assert.match(appJs, /d\.message \|\| 'CSV fallback downloaded\.'/);
  assert.match(appJs, /CURRENT_USER && CURRENT_USER\.role === 'admin'/);
  assert.match(appJs, /function startCollab/);
  assert.match(appJs, /function submitCollabOrder/);
  assert.match(appJs, /function loadM4Campaigns/);
  assert.match(appJs, /function getM4CampaignId/);
  assert.match(appJs, /function runCampaignCollabAction/);
  assert.match(appJs, /campaign_relation/);
  assert.match(appJs, /\/campaigns\?limit=100/);
  assert.match(appJs, /var resource = \{/);
  assert.match(appJs, /body\.resource = resource/);
  assert.doesNotMatch(appJs, /body\.proposal_notes = JSON\.stringify\(resource\)/);
  assert.match(appJs, /var COLLAB_ORDER_TYPE_LABELS =/);
  assert.match(appJs, /<th>合作资源<\/th>/);
  assert.match(appJs, /<th>合同 \/ PO<\/th>/);
  assert.match(appJs, /resource\.order_reference \|\| '-'/);
  assert.match(appJs, /collab\.notes \|\| '-'/);
  assert.match(appJs, /id="orderQuotedPrice" type="number" min="0" step="1"/);

  const m4SingletonNames = [
    'downloadInfTemplate',
    'exportAll',
    'exportFiltered',
    'exportInf',
    'exportSelected',
    'getSelectedInfIds',
    'handleUpload',
    'importInfluencers',
    'initM4',
    'loadM4Campaigns',
    'changeM4CampaignContext',
    'loadCollaborations',
    'loadInfluencersFromAPI',
    'matchInfluencers',
    'pushToFeishu',
    'loadFeishuStatus',
    'testFeishuConnection',
    'renderCollabTable',
    'renderInfTable',
    'showInfPreview',
    'startCollab',
    'toggleAll',
    'updateCollabStatus',
    'runCampaignCollabAction',
    'closeCampaignSettlementModal',
    'submitCampaignSettlement'
  ];
  for (const name of m4SingletonNames) {
    const re = new RegExp('^(?:async\\s+)?function\\s+' + name + '\\s*\\(', 'gm');
    assert.equal((appJs.match(re) || []).length, 1, `${name} must have exactly one top-level app.js declaration`);
  }

  const inlineHandlerBlock = appJs.slice(appJs.indexOf('function exposeInlineHandlers'));
  for (const name of [
    'switchTab',
    'matchInfluencers',
    'smartMatch',
    'handleUpload',
    'handleDrop',
    'openInfUploadModal',
    'handleUploadModal',
    'downloadInfTemplate',
    'exportAll',
    'exportFiltered',
    'exportSelected',
    'toggleAll',
    'startCollab',
    'submitCollabOrder',
    'closeCollabOrderModal',
    'loadM4Campaigns',
    'changeM4CampaignContext',
    'loadCollaborations',
    'updateCollabStatus',
    'runCampaignCollabAction',
    'closeCampaignSettlementModal',
    'submitCampaignSettlement',
    'pushToFeishu'
  ]) {
    assert.match(inlineHandlerBlock, new RegExp("'" + name + "'"), `${name} must remain exported for inline handlers`);
  }
});

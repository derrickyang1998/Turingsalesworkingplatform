const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshDb() {
  const dbPath = path.join(os.tmpdir(), `tm-influencer-workflow-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  process.env.DB_PATH = dbPath;
  process.env.DEFAULT_ADMIN_PASSWORD = 'test-only-admin-password';
  const dbModule = path.resolve(__dirname, '../db.js');
  delete require.cache[dbModule];
  return require(dbModule);
}

function mountRoutes(db) {
  const routes = {};
  const app = {};
  ['get', 'post', 'put', 'delete'].forEach(function(method) {
    app[method] = function(routePath) {
      routes[method.toUpperCase() + ' ' + routePath] = Array.prototype.slice.call(arguments, 1);
    };
  });
  const authMiddleware = function(req, res, next) { next(); };
  const routesModule = path.resolve(__dirname, '../routes.js');
  delete require.cache[routesModule];
  require(routesModule)(app, db, authMiddleware);
  return routes;
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
  const byId = await invoke(routes, 'GET /api/influencers', { query: { search: String(inf.id) } });
  assert.equal(byId.payload.influencers.some(function(row) { return row.id === inf.id; }), true);
  const byLink = await invoke(routes, 'GET /api/influencers', { query: { search: 'legacy' } });
  assert.equal(byLink.payload.influencers.some(function(row) { return row.id === inf.id; }), true);
  const byTag = await invoke(routes, 'GET /api/influencers', { query: { search: 'outdoor' } });
  assert.equal(byTag.payload.influencers.some(function(row) { return row.id === inf.id; }), true);

  db.close();
});

test('influencer template download keeps the 19-column export contract', async () => {
  const db = freshDb();
  const routes = mountRoutes(db);

  const result = await invoke(routes, 'GET /api/influencers/template');

  assert.equal(result.statusCode, 200);
  assert.match(result.headers['content-type'], /text\/csv/);
  assert.match(result.headers['content-disposition'], /influencer_import_template\.csv/);
  assert.match(result.body, /No\.,Date,Submitter,Project,Product,Duplicate,KOL Handle,Followers,Link,Platform,Country,Tag,AvgViews10,Cost,Deliverable,TuringNote,Price,Email,CPM,CPV/);
  assert.match(result.body, /网红频道名称/);

  db.close();
});

test('feishu sync endpoint degrades to a downloadable payload when webhook is not configured', async () => {
  const previousWebhook = process.env.FEISHU_WEBHOOK_URL;
  delete process.env.FEISHU_WEBHOOK_URL;
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
  assert.match(result.payload.csv, /@feishu_ready/);
  assert.match(result.payload.message, /FEISHU_WEBHOOK_URL/);

  if (previousWebhook !== undefined) process.env.FEISHU_WEBHOOK_URL = previousWebhook;
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
        project_name: 'New Product Launch',
        product_name: 'Battery Pack',
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
  assert.match(collab.proposal_notes, /New Product Launch/);
  assert.match(collab.proposal_notes, /1 short video/);
  assert.match(collab.notes, /Priority partner/);

  db.close();
});

test('m4 frontend keeps import, feishu, and order-resource controls wired', () => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const indexHtml = fs.readFileSync(path.join(repoRoot, 'platform', 'index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(repoRoot, 'platform', 'app.js'), 'utf8');

  assert.match(indexHtml, /id="collabFilter"/);
  assert.match(indexHtml, /id="collabStatsBar"/);
  assert.match(indexHtml, /id="filt_search"/);
  assert.match(indexHtml, /id="infFileModal" accept="\.csv,\.json,\.xlsx"/);
  assert.match(appJs, /m4-table thead th\{position:sticky/);
  assert.match(appJs, /m4-table input\[type="checkbox"\]\{width:16px!important;height:16px!important/);
  assert.match(appJs, /function handleDrop/);
  assert.match(appJs, /function openInfUploadModal/);
  assert.match(appJs, /function handleUploadModal/);
  assert.match(appJs, /\/influencers\/upload/);
  assert.match(appJs, /\/influencers\/template/);
  assert.match(appJs, /\/influencers\/feishu\/sync/);
  assert.match(appJs, /function startCollab/);
  assert.match(appJs, /function submitCollabOrder/);
  assert.match(appJs, /var resource = \{/);
  assert.match(appJs, /resource:\s*resource/);
});

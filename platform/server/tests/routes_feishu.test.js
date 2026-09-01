const test = require('node:test');
const assert = require('node:assert/strict');

const { FeishuClientError } = require('../feishu_client');
const registerFeishuRoutes = require('../routes_feishu');

function mountRoutes(options) {
  const routes = {};
  const app = {
    get(path) { routes['GET ' + path] = Array.prototype.slice.call(arguments, 1); },
    post(path) { routes['POST ' + path] = Array.prototype.slice.call(arguments, 1); }
  };
  const dbEvents = [];
  const db = {
    prepare() {
      return {
        run() { dbEvents.push(Array.prototype.slice.call(arguments)); }
      };
    }
  };
  const authMiddleware = function(req, res, next) { next(); };
  const adminOnly = function(req, res, next) {
    if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    return next();
  };
  registerFeishuRoutes(app, Object.assign({ db, authMiddleware, adminOnly }, options || {}));
  return { routes, dbEvents };
}

async function invoke(routes, key, options) {
  options = options || {};
  const handlers = routes[key];
  assert.ok(handlers, 'route not found: ' + key);
  const req = {
    user: options.user || { id: 7, role: 'user' },
    ip: '127.0.0.1',
    body: options.body || {}
  };
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return this; }
  };
  let index = 0;
  async function next() {
    const handler = handlers[index++];
    if (!handler) return;
    const result = handler.length >= 3 ? handler(req, res, next) : handler(req, res);
    if (result && typeof result.then === 'function') await result;
  }
  await next();
  return { statusCode, payload };
}

test('Feishu status route returns only provider-safe connection state', async () => {
  const status = {
    configured: false,
    mode: 'bitable',
    sync_available: false,
    test_available: false,
    missing: ['FEISHU_BITABLE_TABLE_ID']
  };
  const { routes } = mountRoutes({
    feishuClient: {
      getStatus() { return status; },
      async testConnection() { throw new Error('not expected'); }
    }
  });

  const result = await invoke(routes, 'GET /api/feishu/status');
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.payload, status);
  assert.doesNotMatch(JSON.stringify(result.payload), /secret|https?:/i);
});

test('Feishu connection test route is administrator-only and audits a successful safe test', async () => {
  let testCalls = 0;
  const { routes, dbEvents } = mountRoutes({
    feishuClient: {
      getStatus() { return { configured: true, mode: 'webhook' }; },
      async testConnection() {
        testCalls += 1;
        return { configured: true, mode: 'webhook', ok: true };
      }
    }
  });

  const denied = await invoke(routes, 'POST /api/feishu/test');
  assert.equal(denied.statusCode, 403);
  assert.equal(testCalls, 0);

  const allowed = await invoke(routes, 'POST /api/feishu/test', { user: { id: 1, role: 'admin' } });
  assert.equal(allowed.statusCode, 200);
  assert.deepEqual(allowed.payload, { configured: true, mode: 'webhook', ok: true });
  assert.equal(testCalls, 1);
  assert.equal(dbEvents.length, 1);
  assert.match(String(dbEvents[0][1]), /feishu_connection_test/);
  assert.doesNotMatch(JSON.stringify(dbEvents), /secret|https?:/i);
});

test('Feishu connection test normalizes provider failures and records safe failure metadata', async () => {
  const { routes, dbEvents } = mountRoutes({
    feishuClient: {
      getStatus() { return { configured: true, mode: 'bitable' }; },
      async testConnection() {
        throw new FeishuClientError('FEISHU_PROVIDER_UNAVAILABLE', 'Feishu provider is temporarily unavailable.', 502);
      }
    }
  });

  const result = await invoke(routes, 'POST /api/feishu/test', { user: { id: 1, role: 'admin' } });
  assert.equal(result.statusCode, 502);
  assert.deepEqual(result.payload, {
    error: 'Feishu provider is temporarily unavailable.',
    code: 'FEISHU_PROVIDER_UNAVAILABLE'
  });
  assert.equal(dbEvents.length, 1);
  assert.match(String(dbEvents[0][1]), /feishu_connection_test_failed/);
  assert.doesNotMatch(JSON.stringify(result), /private|secret|https?:/i);
});

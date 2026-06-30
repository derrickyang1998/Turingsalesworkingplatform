const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appJs = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

function extractFunction(name) {
  let start = appJs.indexOf('async function ' + name + '(');
  if (start < 0) start = appJs.indexOf('function ' + name + '(');
  if (start < 0) return '';
  const brace = appJs.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < appJs.length; i++) {
    if (appJs[i] === '{') depth++;
    if (appJs[i] === '}') depth--;
    if (depth === 0) return appJs.slice(start, i + 1);
  }
  throw new Error('Could not extract function ' + name);
}

function makeContext(fetchImpl) {
  const elements = {};
  const store = { tm_token: 'expired-token', tm_user: '{"username":"demo"}' };
  const context = {
    API: 'http://example.test/api',
    AUTH_TOKEN: 'expired-token',
    CURRENT_USER: { username: 'demo' },
    authExpiredNotified: false,
    FormData: class FormData {},
    Headers,
    fetch: fetchImpl,
    localStorage: {
      store,
      getItem(key) { return this.store[key] || null; },
      setItem(key, value) { this.store[key] = String(value); },
      removeItem(key) { delete this.store[key]; }
    },
    document: {
      getElementById(id) {
        if (!elements[id]) elements[id] = { style: {}, textContent: '' };
        return elements[id];
      }
    }
  };
  context.toast = function(message, type) {
    context.lastToast = { message, type };
  };
  return context;
}

async function runInContext(context) {
  const source = [
    extractFunction('handleAuthExpired') || 'function handleAuthExpired() {}',
    extractFunction('apiFetch')
  ].join('\n');
  vm.createContext(context);
  vm.runInContext(source, context);
  return context;
}

(async function main() {
  let capturedOpts;
  let context = await runInContext(makeContext(async (url, opts) => {
    capturedOpts = opts;
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }));
  await context.apiFetch('/demand/parse-file', { method: 'POST', body: new context.FormData() });
  const headers = capturedOpts.headers;
  const hasJsonContentType = headers instanceof Headers
    ? headers.has('Content-Type')
    : Object.prototype.hasOwnProperty.call(headers || {}, 'Content-Type');
  assert.strictEqual(hasJsonContentType, false, 'FormData upload must not force JSON Content-Type');

  context = await runInContext(makeContext(async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: 'Invalid token' })
  })));
  await context.apiFetch('/ai/demand-analysis', { method: 'POST', body: JSON.stringify({ input: 'x' }) });
  assert.strictEqual(context.AUTH_TOKEN, '', '401 must clear the in-memory token');
  assert.strictEqual(context.localStorage.getItem('tm_token'), null, '401 must clear the persisted token');
  assert.strictEqual(context.document.getElementById('authOverlay').style.display, 'flex', '401 must show the login overlay');
  assert.strictEqual(context.lastToast.type, 'error', '401 must show an error toast');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const serverRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(serverRoot, '..', '..');
const bootstrapScript = path.join(serverRoot, 'scripts', 'bootstrap_production_browser_state.js');
const captureScript = path.join(serverRoot, 'scripts', 'capture_production_browser_baseline.js');
const evidenceLibrary = path.join(serverRoot, 'scripts', 'lib', 'production_browser_evidence.js');

test('production evidence helpers are tracked, environment-only, and contain no credential or host literal', () => {
  for (const filePath of [bootstrapScript, captureScript, evidenceLibrary]) {
    assert.equal(fs.existsSync(filePath), true, `missing ${path.basename(filePath)}`);
  }
  const source = [bootstrapScript, captureScript, evidenceLibrary]
    .map((filePath) => fs.readFileSync(filePath, 'utf8'))
    .join('\n');

  for (const name of [
    'TM_PRODUCTION_BASE_URL',
    'TM_PRIVATE_CREDENTIAL_MANIFEST',
    'TM_PRODUCTION_STORAGE_STATE',
    'TM_PRODUCTION_EVIDENCE_DIR'
  ]) {
    assert.match(source, new RegExp(name));
  }
  assert.match(source, /options\.environment \|\| process\.env/);
  assert.doesNotMatch(source, /tvly-[A-Za-z0-9_-]+|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY/i);
  assert.doesNotMatch(source, /https?:\/\/(?:\d{1,3}\.){3}\d{1,3}/i);
  assert.doesNotMatch(source, /process\.argv/);
});

test('credential parser accepts private JSON and Markdown forms without returning unrelated fields', () => {
  const { parseCredentialManifest } = require(evidenceLibrary);
  assert.deepEqual(
    parseCredentialManifest(JSON.stringify({
      actor_username: 'admin-fixture',
      rotations: [
        { username: 'member-fixture', password: 'member-password' },
        { username: 'admin-fixture', password: 'admin-password' }
      ]
    })),
    { username: 'admin-fixture', password: 'admin-password' }
  );
  assert.deepEqual(
    parseCredentialManifest('| Username | Password | Role |\n|---|---|---|\n| admin-fixture | admin-password | admin |'),
    { username: 'admin-fixture', password: 'admin-password' }
  );
  assert.throws(() => parseCredentialManifest('no credentials here'), /credential manifest/i);
});

test('production paths reject repository evidence, traversal, and symlink or junction ancestors', () => {
  const {
    validateCredentialManifestPath,
    validateEvidenceDirectory,
    validateStorageStatePath
  } = require(evidenceLibrary);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-production-evidence-'));
  const privateRoot = path.join(tempRoot, 'private');
  const outsideRoot = path.join(tempRoot, 'outside');
  const manifestPath = path.join(privateRoot, 'credentials.json');
  const storagePath = path.join(repoRoot, '.superpowers', 'sdd', 'production-test-state.json');
  fs.mkdirSync(privateRoot, { recursive: true });
  fs.mkdirSync(outsideRoot, { recursive: true });
  fs.writeFileSync(manifestPath, '{}');

  try {
    assert.equal(validateCredentialManifestPath(manifestPath, { repoRoot }), manifestPath);
    assert.equal(validateStorageStatePath(storagePath, { repoRoot }), storagePath);
    assert.equal(validateEvidenceDirectory(privateRoot, { repoRoot }), privateRoot);
    assert.throws(() => validateStorageStatePath(path.join(tempRoot, 'state.json'), { repoRoot }), /storage state/i);
    assert.throws(() => validateEvidenceDirectory(path.join(repoRoot, 'private-evidence'), { repoRoot }), /outside the repository/i);

    const linkPath = path.join(privateRoot, 'redirect');
    fs.symlinkSync(outsideRoot, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(
      () => validateEvidenceDirectory(path.join(linkPath, 'capture'), { repoRoot }),
      /symbolic link|junction|reparse/i
    );
    fs.unlinkSync(linkPath);
  } finally {
    fs.rmSync(storagePath, { force: true });
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('production URL and route evidence keep origins, credentials, and queries private', () => {
  const { routeEvidence, validateProductionBaseUrl } = require(evidenceLibrary);
  const base = validateProductionBaseUrl('https://production.invalid/');
  const templates = ['/api/customers', '/api/customers/:id/:contact'];
  assert.equal(base.href, 'https://production.invalid/');
  assert.deepEqual(
    routeEvidence('GET', 'https://production.invalid/api/customers?token=secret', 200, base.origin, templates),
    { method: 'GET', path: '/api/customers', status: 200 }
  );
  assert.deepEqual(
    routeEvidence('GET', 'https://production.invalid/api/customers/12345/contact%40example.com', 200, base.origin, templates),
    { method: 'GET', path: '/api/customers/:id/:id', status: 200 }
  );
  assert.deepEqual(
    routeEvidence('GET', 'https://production.invalid/api/customers/acme-corp', 200, base.origin, templates),
    { method: 'GET', path: '/api/:unmatched', status: 200 }
  );
  assert.throws(() => validateProductionBaseUrl('http://production.invalid/'), /HTTPS/i);
  assert.throws(() => validateProductionBaseUrl('https://user:secret@production.invalid/'), /credentials/i);
  assert.throws(() => validateProductionBaseUrl('https://production.invalid/?token=secret'), /query/i);
});

test('session cleanup removes storage state on both capture success and failure', async () => {
  const { withSessionCleanup, writePrivateJson } = require(evidenceLibrary);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-production-session-cleanup-'));
  const statePath = path.join(tempRoot, 'state.json');
  let destroyed = 0;

  try {
    writePrivateJson(statePath, { token: 'fixture-only' }, { allowedRoot: tempRoot });
    const value = await withSessionCleanup({
      statePath,
      capture: async () => 'captured',
      destroySession: async () => { destroyed += 1; return { verified: true }; }
    });
    assert.equal(value.captureResult, 'captured');
    assert.equal(value.cleanupResult.verified, true);
    assert.equal(destroyed, 1);
    assert.equal(fs.existsSync(statePath), false);

    writePrivateJson(statePath, { token: 'fixture-only' }, { allowedRoot: tempRoot });
    await assert.rejects(() => withSessionCleanup({
      statePath,
      capture: async () => { throw new Error('capture failed'); },
      destroySession: async () => { destroyed += 1; return { verified: true }; }
    }), /capture failed/);
    assert.equal(destroyed, 2);
    assert.equal(fs.existsSync(statePath), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('CLI failure summaries expose codes only, never secret-bearing messages', () => {
  const { EvidenceError, failureSummary } = require(evidenceLibrary);
  const error = new EvidenceError('INVALID_PRIVATE_INPUT', 'secret-value at C:\\private\\manifest');
  const summary = failureSummary('CAPTURE', error);
  assert.equal(summary, 'PRODUCTION_CAPTURE_FAILED=INVALID_PRIVATE_INPUT');
  assert.doesNotMatch(summary, /secret-value|C:\\|manifest/i);
});

test('bootstrap writes private state and destroys a rejected-role session without logging secrets', async () => {
  const { bootstrapProductionBrowserState } = require(bootstrapScript);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-production-bootstrap-'));
  const manifestPath = path.join(tempRoot, 'credentials.json');
  const statePath = path.join(repoRoot, '.superpowers', 'sdd', `production-bootstrap-${process.pid}.json`);
  const baseEnvironment = {
    TM_PRODUCTION_BASE_URL: 'https://production.invalid/',
    TM_PRIVATE_CREDENTIAL_MANIFEST: manifestPath,
    TM_PRODUCTION_STORAGE_STATE: statePath
  };
  fs.writeFileSync(manifestPath, JSON.stringify({ username: 'admin-fixture', password: 'fixture-password' }));

  try {
    const successFetch = async (url, init) => {
      assert.equal(new URL(url).pathname, '/api/auth/login');
      assert.equal(init.method, 'POST');
      return {
        ok: true,
        status: 200,
        json: async () => ({ token: 'fixture-token-secret', user: { id: 1, role: 'admin', username: 'admin-fixture' } })
      };
    };
    const result = await bootstrapProductionBrowserState({ environment: baseEnvironment, fetchImpl: successFetch });
    assert.deepEqual(result, { ready: true, role: 'admin' });
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(state.origins[0].localStorage.find((entry) => entry.name === 'tm_token').value, 'fixture-token-secret');
    if (process.platform !== 'win32') assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
    fs.rmSync(statePath, { force: true });

    const calls = [];
    const rejectedRoleFetch = async (url, init) => {
      const pathname = new URL(url).pathname;
      calls.push(`${init.method} ${pathname}`);
      if (pathname === '/api/auth/login') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ token: 'fixture-rejected-token', user: { id: 2, role: 'user', username: 'member-fixture' } })
        };
      }
      if (pathname === '/api/auth/logout') return { status: 200 };
      return { status: 401 };
    };
    await assert.rejects(
      () => bootstrapProductionBrowserState({ environment: baseEnvironment, fetchImpl: rejectedRoleFetch }),
      (error) => error.code === 'PRODUCTION_ROLE_MISMATCH'
    );
    assert.deepEqual(calls, ['POST /api/auth/login', 'POST /api/auth/logout', 'GET /api/auth/me']);
    assert.equal(fs.existsSync(statePath), false);
  } finally {
    fs.rmSync(statePath, { force: true });
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('production helper CLIs redact missing environment failures and capture uses the cleanup gate', () => {
  const environment = { ...process.env };
  for (const name of [
    'TM_PRODUCTION_BASE_URL',
    'TM_PRIVATE_CREDENTIAL_MANIFEST',
    'TM_PRODUCTION_STORAGE_STATE',
    'TM_PRODUCTION_EVIDENCE_DIR'
  ]) delete environment[name];

  const result = spawnSync(process.execPath, [bootstrapScript], { cwd: serverRoot, env: environment, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^PRODUCTION_BOOTSTRAP_FAILED=MISSING_PRIVATE_ENVIRONMENT\s*$/);
  assert.doesNotMatch(result.stdout + result.stderr, /Users\\|Documents\\|production\.invalid|fixture-password/i);

  const captureSource = fs.readFileSync(captureScript, 'utf8');
  assert.match(captureSource, /withSessionCleanup\s*\(/);
  assert.match(captureSource, /destroySession\s*\(/);
  assert.match(captureSource, /sanitizeProductionPage\s*\(/);
  assert.match(captureSource, /context\.route\(['"]\*\*\/\*['"]/);
  assert.doesNotMatch(captureSource, /console\.(?:log|error)\([^\n]*error\.message/);
  const closeIndex = captureSource.indexOf('await context.close()');
  const finalViolationIndex = captureSource.indexOf('if (violations.length)', closeIndex);
  const privateWriteIndex = captureSource.indexOf('writePrivateBuffer(', closeIndex);
  assert.ok(closeIndex >= 0 && finalViolationIndex > closeIndex, 'final violation check must happen after context close');
  assert.ok(privateWriteIndex > finalViolationIndex, 'private screenshot write must happen after the final violation check');
});

test('browser redaction removes visible account, contact, link, and storage values before screenshots', async () => {
  const { chromium } = require('playwright-deploy');
  const { sanitizeProductionPage } = require(captureScript);
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  try {
    const page = await browser.newPage();
    await page.route('https://production.invalid/**', async (route) => {
      if (new URL(route.request().url()).pathname === '/style.css') {
        await route.fulfill({ contentType: 'text/css', body: 'body { color: rgb(10, 20, 30); }' });
        return;
      }
      await route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><meta name="author" content="head-only@example.com"><link rel="stylesheet" href="/style.css"><main onclick="void(0)/*handler-only@example.com*/">admin-fixture contact@example.com +1 202 555 0188 <input type="file"><a href="https://private.invalid/account">profile</a><img src="https://private.invalid/avatar.png"></main>'
      });
    });
    await page.goto('https://production.invalid/');
    await page.evaluate(() => {
      localStorage.setItem('tm_token', 'fixture-token-secret');
      localStorage.setItem('tm_user', '{"username":"admin-fixture"}');
    });
    const result = await sanitizeProductionPage(page, ['fixture-token-secret', 'admin-fixture', 'contact@example.com']);
    assert.deepEqual(result, { leakedPrivateValues: 0, secretLike: false });
    const state = await page.evaluate(() => ({
      text: document.body.innerText,
      anchor: document.querySelector('a').getAttribute('href'),
      stylesheet: document.querySelector('link').getAttribute('href'),
      token: localStorage.getItem('tm_token')
    }));
    assert.doesNotMatch(state.text, /admin-fixture|contact@example\.com|555/);
    assert.equal(state.anchor, '#');
    assert.equal(state.stylesheet, '/style.css');
    assert.equal(state.token, null);
  } finally {
    await browser.close();
  }
});

test('capture deletes a readable but invalid storage state before rejecting it', async () => {
  const { captureProductionBrowserBaseline } = require(captureScript);
  const statePath = path.join(repoRoot, '.superpowers', 'sdd', `production-invalid-state-${process.pid}.json`);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, '{"cookies":[],"origins":[]}');
  try {
    await assert.rejects(
      () => captureProductionBrowserBaseline({
        environment: {
          TM_PRODUCTION_BASE_URL: 'https://production.invalid/',
          TM_PRODUCTION_STORAGE_STATE: statePath,
          TM_PRODUCTION_EVIDENCE_DIR: path.join(os.tmpdir(), `tm-evidence-invalid-${process.pid}`)
        }
      }),
      (error) => error.code === 'INVALID_STORAGE_STATE'
    );
    assert.equal(fs.existsSync(statePath), false);
  } finally {
    fs.rmSync(statePath, { force: true });
  }
});

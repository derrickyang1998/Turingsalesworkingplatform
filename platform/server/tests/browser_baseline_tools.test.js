const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const serverRoot = path.resolve(__dirname, '..');
const compareScript = path.join(serverRoot, 'scripts', 'compare_ui_baseline_runs.js');
const updateScript = path.join(serverRoot, 'scripts', 'update_ui_baseline.js');
const generateScript = path.join(serverRoot, 'scripts', 'generate_ui_baseline_manifest.js');
const browserSpec = path.join(serverRoot, 'tests', 'browser-baseline.spec.js');
const browserFixture = path.join(serverRoot, 'tests', 'helpers', 'browser_fixture.js');
const safeFixturePaths = path.join(serverRoot, 'tests', 'helpers', 'safe_fixture_paths.js');
const runtimeConfig = path.join(serverRoot, 'config', 'runtime_config.js');
const serverSourcePath = path.join(serverRoot, 'server.js');
const dbSourcePath = path.join(serverRoot, 'db.js');
const fixtureServerSourcePath = path.join(serverRoot, 'tests', 'fixtures', 'start_browser_fixture_server.js');
const sddRoot = path.resolve(serverRoot, '..', '..', '.superpowers', 'sdd');

test('browser baseline comparison self-test enforces bounded pixel diffs and safe roots', () => {
  const result = spawnSync(process.execPath, [compareScript, '--self-test'], {
    cwd: serverRoot,
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /compare_ui_baseline_runs self-test passed/);
  assert.doesNotMatch(result.stdout + result.stderr, /Users\\|TURINGMARKET_SERVER|TM_PRIVATE/);
});

test('browser baseline screenshots are viewport-bounded rather than full-page captures', () => {
  const source = fs.readFileSync(browserSpec, 'utf8');
  assert.match(source, /fullPage:\s*false/);
  assert.doesNotMatch(source, /fullPage:\s*true/);
  const compareSource = fs.readFileSync(compareScript, 'utf8');
  assert.match(compareSource, /validateComparisonDimensions/);
  assert.match(compareSource, /validateRunEnvironments/);
  assert.match(source, /environment\.os\)\.toBe\('Windows'\)/);
});

test('browser baseline loader separates the frozen pre-edit inventory from the current manifest', () => {
  const { loadBaselineManifest } = require(browserFixture);
  const manifest = loadBaselineManifest();

  assert.equal(manifest.preEdit.routeContracts.length, 106);
  assert.equal(manifest.preEdit.duplicateInventory.reviewedDuplicateCount, 39);
  assert.equal(manifest.routeContracts.length, 113);
  assert.equal(manifest.duplicateInventory.reviewedDuplicateCount, 1);
  assert.deepEqual(manifest.duplicateInventory.duplicates, ['esc']);
});

test('browser baseline generator preserves the frozen pre-edit inventory required by capture', () => {
  const { generateManifest } = require(generateScript);
  const manifest = generateManifest({
    repoRoot: path.resolve(serverRoot, '..', '..'),
    baselineVersion: 'v0.2.9'
  });

  assert.equal(manifest.preEdit.routeContracts.length, 106);
  assert.equal(manifest.preEdit.duplicateInventory.reviewedDuplicateCount, 39);
  assert.equal(manifest.routeContracts.length, 117);
  assert.deepEqual(manifest.duplicateInventory.duplicates, ['esc']);
});

test('known-gap refresh retires only the completed mobile shell gap', async () => {
  const outputRoot = path.join(sddRoot, `known-gap-refresh-${process.pid}-${Date.now()}`);
  const previousOutput = process.env.TM_BASELINE_OUTPUT_DIR;
  process.env.TM_BASELINE_OUTPUT_DIR = outputRoot;
  try {
    const { getBaselineRunContext, recordKnownBaselineGaps } = require(browserFixture);
    const context = getBaselineRunContext();
    fs.writeFileSync(context.metadataPath, `${JSON.stringify({
      schemaVersion: 1,
      baselineVersion: context.baselineVersion,
      environments: {},
      knownGaps: [
        { contract: 'mobile-shell-content', ownerPhase: 3 },
        { contract: 'future-independent-gap', ownerPhase: 9 }
      ]
    }, null, 2)}\n`, 'utf8');

    await recordKnownBaselineGaps(null, null, context);
    const metadata = JSON.parse(fs.readFileSync(context.metadataPath, 'utf8'));
    const contracts = metadata.knownGaps.map((gap) => gap.contract);
    assert.equal(contracts.includes('mobile-shell-content'), false);
    assert.equal(contracts.includes('future-independent-gap'), true);
    for (const expected of ['direct-path', 'refresh-restore', 'back-forward', 'heading-focus', 'admin-knowledge-loader']) {
      assert.equal(contracts.includes(expected), true, `${expected} must remain registered`);
    }
  } finally {
    if (previousOutput === undefined) delete process.env.TM_BASELINE_OUTPUT_DIR;
    else process.env.TM_BASELINE_OUTPUT_DIR = previousOutput;
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('browser baseline update orchestrator owns two clean runs and all viewport projects', () => {
  const result = spawnSync(process.execPath, [updateScript, '--self-test'], {
    cwd: serverRoot,
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /update_ui_baseline self-test passed/);
  const source = fs.readFileSync(updateScript, 'utf8');
  assert.match(source, /baseline-run-a/);
  assert.match(source, /baseline-run-b/);
  assert.match(source, /playwright\/package\.json/);
  assert.doesNotMatch(source, /require\.resolve\(['"]playwright\/cli['"]\)/);
  assert.equal((source.match(/--project=fixture-/g) || []).length, 3);
});

test('browser baseline runner removes fixture database and logs after Playwright exits', () => {
  const fixtureRunRoot = path.join(sddRoot, 'browser-fixture-server', `cleanup-test-${process.pid}`);
  fs.mkdirSync(fixtureRunRoot, { recursive: true });
  fs.writeFileSync(path.join(fixtureRunRoot, 'fixture.db'), 'test-only');

  try {
    const { cleanFixtureRunDirectory } = require(updateScript);
    cleanFixtureRunDirectory(fixtureRunRoot);
    assert.equal(fs.existsSync(fixtureRunRoot), false);
  } finally {
    fs.rmSync(fixtureRunRoot, { recursive: true, force: true });
  }
});

test('browser baseline path guard rejects a symlink or junction ancestor', () => {
  assert.equal(fs.existsSync(safeFixturePaths), true, 'safe fixture path module must exist');
  const { resolveSafeFixturePath } = require(safeFixturePaths);
  const safeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-safe-fixture-root-'));
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-safe-fixture-outside-'));
  const linkPath = path.join(safeRoot, 'redirect');

  try {
    fs.symlinkSync(outsideRoot, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(
      () => resolveSafeFixturePath(safeRoot, path.join(linkPath, 'fixture.db'), 'fixture DB'),
      /symbolic link|junction|reparse/i
    );
  } finally {
    if (fs.existsSync(linkPath)) fs.unlinkSync(linkPath);
    fs.rmSync(safeRoot, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test('fixture request classifier rejects external API origins', () => {
  const { classifyFixtureRequest } = require(browserFixture);
  const origin = 'http://127.0.0.1:43187';
  assert.equal(classifyFixtureRequest(`${origin}/api/customers`, origin), 'api');
  assert.equal(classifyFixtureRequest(`${origin}/app.js`, origin), 'static');
  assert.equal(classifyFixtureRequest('https://external.invalid/api/customers', origin), 'external');
});

test('baseline comparison rejects non-Windows or divergent runner metadata', () => {
  const { validateRunEnvironments } = require(compareScript);
  const manifest = { viewports: [{ name: 'fixture-1440', width: 1440, height: 900 }] };
  const environment = {
    os: 'Windows',
    browserName: 'chromium',
    browserRevision: '1223',
    locale: 'zh-CN',
    timezone: 'Asia/Shanghai',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
    viewport: { width: 1440, height: 900 },
    fonts: { 'Segoe UI': true, 'Microsoft YaHei': true }
  };
  const left = { environments: { 'fixture-1440': structuredClone(environment) } };
  const right = { environments: { 'fixture-1440': structuredClone(environment) } };

  assert.doesNotThrow(() => validateRunEnvironments(left, right, manifest));
  right.environments['fixture-1440'].os = 'linux';
  assert.throws(() => validateRunEnvironments(left, right, manifest), /must match the frozen runner contract/);
});

test('fixture runtime skips platform dotenv and binds only to loopback', () => {
  assert.equal(fs.existsSync(runtimeConfig), true, 'runtime config module must exist');
  const { loadPlatformEnvironment, serverListenArgs } = require(runtimeConfig);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-runtime-config-'));
  const envPath = path.join(tempRoot, '.env');
  const isolatedEnvironment = { NODE_ENV: 'test', TM_DISABLE_DOTENV: '1' };
  fs.writeFileSync(envPath, 'TM_BASELINE_CANARY=must-not-load\n');

  try {
    const result = loadPlatformEnvironment({ environment: isolatedEnvironment, envPath });
    assert.equal(result.skipped, true);
    assert.equal(isolatedEnvironment.TM_BASELINE_CANARY, undefined);
    assert.deepEqual(serverListenArgs(43187, { SERVER_HOST: '127.0.0.1' }), [43187, '127.0.0.1']);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  const fixtureSource = fs.readFileSync(fixtureServerSourcePath, 'utf8');
  assert.match(fixtureSource, /TM_DISABLE_DOTENV:\s*'1'/);
  assert.match(fixtureSource, /SERVER_HOST:\s*'127\.0\.0\.1'/);
  assert.match(fixtureSource, /TM_UPLOAD_SANDBOX_TEST_MODE:\s*'local-worker'/);
  assert.match(fixtureSource, /UPLOAD_SANDBOX_SPOOL_ROOT:\s*path\.join\(runRoot,\s*'upload-spool'\)/);
  assert.match(fs.readFileSync(serverSourcePath, 'utf8'), /loadPlatformEnvironment/);
  assert.match(fs.readFileSync(dbSourcePath, 'utf8'), /loadPlatformEnvironment/);
});

test('atomic baseline promotion rejects final junctions and does not follow hard links', () => {
  const { replaceFileAtomically } = require(compareScript);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-baseline-promotion-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-baseline-promotion-outside-'));
  const source = path.join(root, 'source.png');
  const target = path.join(root, 'target.png');
  const outsideFile = path.join(outside, 'outside.png');
  fs.writeFileSync(source, 'new-baseline');
  fs.writeFileSync(outsideFile, 'outside-original');

  try {
    fs.symlinkSync(outside, target, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => replaceFileAtomically(source, target, root), /symbolic link|junction|reparse/i);
    fs.unlinkSync(target);

    fs.linkSync(outsideFile, target);
    replaceFileAtomically(source, target, root);
    assert.equal(fs.readFileSync(target, 'utf8'), 'new-baseline');
    assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'outside-original');
  } finally {
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

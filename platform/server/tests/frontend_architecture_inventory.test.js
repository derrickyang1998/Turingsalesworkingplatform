const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const platformRoot = path.join(repoRoot, 'platform');
const serverRoot = path.join(platformRoot, 'server');
const generatorPath = path.join(serverRoot, 'scripts', 'generate_ui_baseline_manifest.js');
const fixturePath = path.join(__dirname, 'fixtures', 'frontend-active-definitions.json');

const reviewedDuplicateNames = Object.freeze([
  'addChatMsg',
  'adminCreateInvite',
  'adminResetPw',
  'clearChat',
  'closeCustModal',
  'downloadInfTemplate',
  'esc',
  'exportAll',
  'exportBrandCSV',
  'exportFiltered',
  'exportInf',
  'exportSelected',
  'filterBrands',
  'filterByTag',
  'filterByTreeTag',
  'generateHTMLPPT',
  'getSelectedInfIds',
  'handleUpload',
  'importInfluencers',
  'initM1',
  'initM4',
  'loadAdminDashboard',
  'loadCollaborations',
  'loadInfluencersFromAPI',
  'loadSocialForBrand',
  'matchInfluencers',
  'pushToFeishu',
  'renderBrands',
  'renderCollabTable',
  'renderIndustryTree',
  'renderInfTable',
  'renderSearchHistory',
  'showInfPreview',
  'startCollab',
  'switchPlatformTab',
  'toggleAll',
  'toggleBrandSocial',
  'trackTokenUsage',
  'updateCollabStatus'
]);

const expectedActiveDefinitions = Object.freeze({
  closeCustModal: { source: 'platform/app.js', line: 373, loadOrder: 1, occurrenceIndex: 2 },
  trackTokenUsage: { source: 'platform/app.js', line: 960, loadOrder: 1, occurrenceIndex: 2 },
  initM1: { source: 'platform/app.js', line: 2361, loadOrder: 1, occurrenceIndex: 2 },
  initM4: { source: 'platform/app.js', line: 3191, loadOrder: 1, occurrenceIndex: 3 },
  downloadInfTemplate: { source: 'platform/app.js', line: 3352, loadOrder: 1, occurrenceIndex: 3 },
  addChatMsg: { source: 'platform/app.js', line: 3584, loadOrder: 1, occurrenceIndex: 2 },
  loadAdminDashboard: { source: 'platform/app.js', line: 3604, loadOrder: 1, occurrenceIndex: 3 },
  generateHTMLPPT: { source: 'platform/ppt.js', line: 40, loadOrder: 2, occurrenceIndex: 2 },
  esc: { source: 'platform/ppt.js', line: 864, loadOrder: 2, occurrenceIndex: 2 }
});

const expectedRouteSources = Object.freeze([
  'platform/server/server.js',
  'platform/server/routes.js',
  'platform/server/routes_customers.js',
  'platform/server/routes_brands.js',
  'platform/server/routes_workflow.js',
  'platform/server/services/public_assets_service.js'
]);

const expectedRouteCountsBySource = Object.freeze({
  'platform/server/server.js': 44,
  'platform/server/routes.js': 11,
  'platform/server/routes_customers.js': 24,
  'platform/server/routes_brands.js': 4,
  'platform/server/routes_workflow.js': 20,
  'platform/server/services/public_assets_service.js': 4
});

const expectedBaseCommit = '9a591aa92e039f53a12ad7d5f098a26d0818bf08';
const expectedSecurityBaseRelease = 'v0.2.10-security-credential-rotation';

const expectedScreenshotJourneys = Object.freeze([
  { role: 'public', journey: 'public-login', pageId: 'login', substate: null },
  { role: 'admin', journey: 'admin-crm-board', pageId: 'm0', substate: null },
  { role: 'admin', journey: 'admin-crm-detail-pipeline', pageId: 'm0-detail', substate: { view: 'pipeline' } },
  { role: 'admin', journey: 'admin-crm-detail-seapool', pageId: 'm0-detail', substate: { view: 'seapool' } },
  { role: 'admin', journey: 'admin-crm-detail-opportunities', pageId: 'm0-detail', substate: { view: 'opportunities' } },
  { role: 'admin', journey: 'admin-brand', pageId: 'm1', substate: null },
  { role: 'admin', journey: 'admin-strategy', pageId: 'm2', substate: null },
  { role: 'admin', journey: 'admin-demand-ppt', pageId: 'm3', substate: { surface: 'ppt' } },
  { role: 'admin', journey: 'admin-m4-tab1', pageId: 'm4', substate: { tab: 'tab1' } },
  { role: 'admin', journey: 'admin-m4-tab2', pageId: 'm4', substate: { tab: 'tab2' } },
  { role: 'admin', journey: 'admin-m4-tab3', pageId: 'm4', substate: { tab: 'tab3' } },
  { role: 'admin', journey: 'admin-ai', pageId: 'm5', substate: null },
  { role: 'admin', journey: 'admin-workflow-designer', pageId: 'workflow-designer', substate: null },
  { role: 'admin', journey: 'admin-workflow-templates', pageId: 'workflow-templates', substate: null },
  { role: 'admin', journey: 'admin-workflow-instances', pageId: 'workflow-instances', substate: null },
  { role: 'admin', journey: 'admin-workflow-tasks', pageId: 'workflow-tasks', substate: null },
  { role: 'admin', journey: 'admin-admin-overview', pageId: 'admin', substate: { tab: 'overview' } },
  { role: 'admin', journey: 'admin-admin-users', pageId: 'admin', substate: { tab: 'users' } },
  { role: 'admin', journey: 'admin-admin-knowledge', pageId: 'admin', substate: { tab: 'knowledge' } },
  { role: 'admin', journey: 'admin-admin-ai-audit', pageId: 'admin', substate: { tab: 'ai-audit' } },
  { role: 'admin', journey: 'admin-admin-tokens', pageId: 'admin', substate: { tab: 'tokens' } },
  { role: 'user', journey: 'user-crm-board', pageId: 'm0', substate: null },
  { role: 'user', journey: 'user-crm-detail', pageId: 'm0-detail', substate: { view: 'pipeline' } },
  { role: 'user', journey: 'user-ai', pageId: 'm5', substate: null }
]);

function loadGenerator() {
  assert.equal(fs.existsSync(generatorPath), true, 'Task 2 must check in generate_ui_baseline_manifest.js');
  return require(generatorPath);
}

function readFixture() {
  assert.equal(fs.existsSync(fixturePath), true, 'Task 2 must check in frontend-active-definitions.json');
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
}

function scanCurrentScripts() {
  const { scanClassicScripts } = loadGenerator();
  return scanClassicScripts([
    { path: path.join(platformRoot, 'app.js'), loadOrder: 1 },
    { path: path.join(platformRoot, 'ppt.js'), loadOrder: 2 }
  ]);
}

function withTempClassicScript(source, callback) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-classic-script-'));
  const scriptPath = path.join(tempDir, 'synthetic.js');
  fs.writeFileSync(scriptPath, source, 'utf8');

  try {
    return callback({ tempDir, scriptPath });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function explicitActiveShape(definition) {
  return {
    name: definition.name,
    source: definition.source,
    kind: definition.kind,
    async: definition.async,
    line: definition.line,
    column: definition.column,
    loadOrder: definition.loadOrder,
    occurrenceIndex: definition.occurrenceIndex,
    globalIndex: definition.globalIndex
  };
}

test('Task 2 generator and reviewed duplicate fixture are checked in', () => {
  assert.deepEqual(
    {
      generator: fs.existsSync(generatorPath),
      fixture: fs.existsSync(fixturePath)
    },
    {
      generator: true,
      fixture: true
    }
  );
});

test('scanClassicScripts ignores nested local functions and named IIFEs while keeping top-level classic declarations', () => {
  const { scanClassicScripts } = loadGenerator();

  withTempClassicScript(`
function topPlain() {}

async function topAsync() {
  function topPlain() {}
  async function topAsync() {}
  function nestedOnly() {}
}

(function namedIife() {
  function iifeLocal() {}
})();

const expression = function expressionLocal() {};
`, ({ tempDir, scriptPath }) => {
    const inventory = scanClassicScripts([
      { path: scriptPath, loadOrder: 1 }
    ], { repoRoot: tempDir });

    assert.deepEqual(
      inventory.declarations.map((definition) => ({
        name: definition.name,
        async: definition.async,
        source: definition.source
      })),
      [
        { name: 'topPlain', async: false, source: 'synthetic.js' },
        { name: 'topAsync', async: true, source: 'synthetic.js' }
      ]
    );
    assert.deepEqual(inventory.duplicates, []);
    assert.deepEqual(Object.keys(inventory.activeDefinitions).sort(), ['topAsync', 'topPlain']);
  });
});

test('scanClassicScripts records the reviewed 39-name duplicate inventory and explicit active definitions', () => {
  const inventory = scanCurrentScripts();

  assert.deepEqual(inventory.duplicates.map((entry) => entry.name), reviewedDuplicateNames);
  assert.equal(inventory.duplicates.length, 39);

  for (const [name, expected] of Object.entries(expectedActiveDefinitions)) {
    const actual = inventory.activeDefinitions[name];
    assert.ok(actual, `${name} must have an active definition`);
    assert.equal(actual.source, expected.source, `${name} active source`);
    assert.equal(actual.line, expected.line, `${name} active line`);
    assert.equal(actual.loadOrder, expected.loadOrder, `${name} active load order`);
    assert.equal(actual.occurrenceIndex, expected.occurrenceIndex, `${name} active occurrence`);
    assert.equal(typeof actual.column, 'number', `${name} must record an explicit column`);
    assert.equal(typeof actual.globalIndex, 'number', `${name} must record an explicit global index`);
  }
});

test('frontend-active-definitions fixture mirrors the current duplicate inventory', () => {
  const fixture = readFixture();
  const inventory = scanCurrentScripts();
  const activeDuplicateDefinitions = {};

  for (const duplicate of inventory.duplicates) {
    activeDuplicateDefinitions[duplicate.name] = explicitActiveShape(duplicate.activeDefinition);
  }

  assert.equal(fixture.metadata.schemaVersion, 1);
  assert.equal(fixture.metadata.reviewedDuplicateCount, 39);
  assert.equal(fixture.metadata.activeDefinitionPolicy, 'last definition by app.js then ppt.js load order');
  assert.deepEqual(fixture.metadata.loadOrder, ['platform/app.js', 'platform/ppt.js']);
  assert.deepEqual(fixture.duplicates, reviewedDuplicateNames);
  assert.deepEqual(fixture.activeDefinitions, activeDuplicateDefinitions);
});

test('generateManifest includes hashes, build/cache markers, routes, fixture metadata, viewports, masks, and screenshot slots', () => {
  const { generateManifest } = loadGenerator();
  const manifest = generateManifest({
    repoRoot,
    baselineVersion: 'v0.2.9',
    duplicateFixturePath: fixturePath
  });
  const appJs = fs.readFileSync(path.join(platformRoot, 'app.js'), 'utf8');
  const buildInfoJs = fs.readFileSync(path.join(platformRoot, 'client', 'shared', 'build_info.js'), 'utf8');

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.baseline.version, 'v0.2.9');
  assert.equal(manifest.baseline.release, 'v0.3.0-baseline-consolidation');
  assert.equal(manifest.files.indexHtml.source, 'platform/index.html');
  assert.equal(manifest.files.appJs.source, 'platform/app.js');
  assert.equal(manifest.files.pptJs.source, 'platform/ppt.js');
  for (const file of Object.values(manifest.files)) {
    assert.match(file.sha256, /^[a-f0-9]{64}$/);
  }

  assert.match(appJs, /window\.tmAppBuild\s*=\s*["']20260630-auth-upload-fix["']/);
  assert.match(buildInfoJs, /app:\s*["']20260713-v030-baseline-consolidation["']/);
  assert.deepEqual(manifest.buildMarkers, {
    app: '20260713-v030-baseline-consolidation',
    ppt: '20260702-v916-kb-bridge-client-cn'
  });
  assert.deepEqual(manifest.scriptCacheKeys, {
    app: '20260713v030baselineconsolidation',
    ppt: '20260702v916kbbridge'
  });

  const routeContracts = new Set(manifest.routeContracts.map((route) => `${route.method} ${route.path} ${route.source}`));
  assert.ok(routeContracts.has('POST /api/auth/login platform/server/server.js'));
  assert.ok(routeContracts.has('GET /api/health platform/server/server.js'));
  assert.ok(routeContracts.has('GET /{*path} platform/server/server.js'));

  assert.equal(manifest.seedFixture.version, 'v0.2.9-ui-fixture-1');
  assert.equal(manifest.seedFixture.source, 'platform/server/tests/fixtures/browser-baseline-data.json');
  assert.ok(Object.hasOwn(manifest.seedFixture, 'exists'));
  assert.ok(manifest.seedFixture.sha256 === null || /^[a-f0-9]{64}$/.test(manifest.seedFixture.sha256));

  assert.deepEqual(manifest.viewports, [
    { name: 'fixture-1440', width: 1440, height: 900, deviceScaleFactor: 1 },
    { name: 'fixture-1920', width: 1920, height: 1080, deviceScaleFactor: 1 },
    { name: 'fixture-mobile', width: 390, height: 844, deviceScaleFactor: 1 }
  ]);
  assert.equal(manifest.mask.version, 'v0.2.9-mask-1');
  assert.ok(manifest.mask.selectors.length >= 1);
  assert.equal(manifest.screenshotSlots.length, expectedScreenshotJourneys.length * manifest.viewports.length);
  for (const slot of manifest.screenshotSlots) {
    assert.match(slot.path, /^docs\/baselines\/v0\.2\.9\/screenshots\//);
    assert.equal(typeof slot.exists, 'boolean');
    assert.ok(slot.sha256 === null || /^[a-f0-9]{64}$/.test(slot.sha256));
  }

  assert.equal(manifest.duplicateInventory.reviewedDuplicateCount, 39);
  assert.deepEqual(manifest.duplicateInventory.duplicates, reviewedDuplicateNames);

  const serialized = JSON.stringify(manifest);
  assert.doesNotMatch(serialized, /[A-Z]:\\\\/);
  assert.doesNotMatch(serialized, /Users\\\\29272|Documents\\\\/);
  assert.doesNotMatch(serialized, /TM_PRIVATE|PRIVATE_EVIDENCE|TURINGMARKET_SERVER/);
  assert.doesNotMatch(serialized, /BEGIN (RSA |OPENSSH )?PRIVATE KEY/);
});

test('generateManifest records the approved base commit and security base release', () => {
  const { generateManifest } = loadGenerator();
  const manifest = generateManifest({
    repoRoot,
    baselineVersion: 'v0.2.9',
    duplicateFixturePath: fixturePath
  });

  assert.equal(manifest.baseline.version, 'v0.2.9');
  assert.equal(manifest.baseline.release, 'v0.3.0-baseline-consolidation');
  assert.equal(manifest.baseline.baseCommit, expectedBaseCommit);
  assert.deepEqual(manifest.baseline.securityBase, {
    release: expectedSecurityBaseRelease,
    baseCommit: expectedBaseCommit
  });
});

test('generateManifest rejects unsafe baseline version path segments', () => {
  const { generateManifest } = loadGenerator();
  const unsafeVersions = [
    '..',
    '../escape',
    'v0.2.9/../../escape',
    'v0.2.9\\escape',
    '/absolute',
    ''
  ];

  for (const baselineVersion of unsafeVersions) {
    assert.throws(
      () => generateManifest({
        repoRoot,
        baselineVersion,
        duplicateFixturePath: fixturePath
      }),
      /Invalid baseline version/,
      `unsafe baseline version must be rejected: ${JSON.stringify(baselineVersion)}`
    );
  }
});

test('generateManifest records every registered route contract in deterministic source order', () => {
  const { generateManifest } = loadGenerator();
  const manifest = generateManifest({
    repoRoot,
    baselineVersion: 'v0.2.9',
    duplicateFixturePath: fixturePath
  });

  assert.equal(manifest.routeContracts.length, 107);
  assert.deepEqual([...new Set(manifest.routeContracts.map((route) => route.source))], expectedRouteSources);

  const routeCountsBySource = Object.fromEntries(
    expectedRouteSources.map((source) => [
      source,
      manifest.routeContracts.filter((route) => route.source === source).length
    ])
  );
  assert.deepEqual(routeCountsBySource, expectedRouteCountsBySource);

  for (const source of expectedRouteSources) {
    const sourceRoutes = manifest.routeContracts.filter((route) => route.source === source);
    const sortedLines = sourceRoutes.map((route) => route.line).slice().sort((a, b) => a - b);
    assert.deepEqual(sourceRoutes.map((route) => route.line), sortedLines, `${source} routes must preserve file order`);
  }

  const routeContracts = new Set(manifest.routeContracts.map((route) => `${route.method} ${route.path} ${route.source}`));
  assert.ok(routeContracts.has('POST /api/auth/login platform/server/server.js'));
  assert.ok(routeContracts.has('GET /api/health platform/server/server.js'));
  assert.ok(routeContracts.has('GET /{*path} platform/server/server.js'));
  assert.ok(routeContracts.has('GET /api/influencers platform/server/routes.js'));
  assert.ok(routeContracts.has('POST /api/influencers/export platform/server/routes.js'));
  assert.ok(routeContracts.has('GET /api/customers platform/server/routes_customers.js'));
  assert.ok(routeContracts.has('POST /api/customers/:id/claim platform/server/routes_customers.js'));
  assert.ok(routeContracts.has('POST /api/brands/enrich platform/server/routes_brands.js'));
  assert.ok(routeContracts.has('GET /api/brands/social-search platform/server/routes_brands.js'));
  assert.ok(routeContracts.has('GET /api/workflow/templates platform/server/routes_workflow.js'));
  assert.ok(routeContracts.has('POST /api/workflow/tasks/:id/complete platform/server/routes_workflow.js'));
  assert.ok(routeContracts.has('GET /index.html platform/server/services/public_assets_service.js'));
  assert.ok(routeContracts.has('GET /app.js platform/server/services/public_assets_service.js'));
  assert.ok(routeContracts.has('GET /client/shared/build_info.js platform/server/services/public_assets_service.js'));
});

test('generateManifest records the approved 72-slot screenshot journey matrix', () => {
  const { generateManifest } = loadGenerator();
  const manifest = generateManifest({
    repoRoot,
    baselineVersion: 'v0.2.9',
    duplicateFixturePath: fixturePath
  });

  assert.equal(expectedScreenshotJourneys.length, 24);
  assert.equal(manifest.screenshotSlots.length, expectedScreenshotJourneys.length * manifest.viewports.length);
  assert.equal(new Set(manifest.screenshotSlots.map((slot) => slot.path)).size, 72);

  const slotsByViewportAndJourney = new Map(
    manifest.screenshotSlots.map((slot) => [`${slot.viewport}/${slot.journey}`, slot])
  );

  for (const viewport of manifest.viewports) {
    const viewportSlots = manifest.screenshotSlots.filter((slot) => slot.viewport === viewport.name);
    assert.equal(viewportSlots.length, 24, `${viewport.name} must cover every approved journey`);

    for (const journey of expectedScreenshotJourneys) {
      const slot = slotsByViewportAndJourney.get(`${viewport.name}/${journey.journey}`);
      assert.ok(slot, `${viewport.name}/${journey.journey} slot missing`);
      assert.equal(slot.role, journey.role);
      assert.equal(slot.pageId, journey.pageId);
      assert.deepEqual(slot.substate, journey.substate);
      assert.equal(
        slot.path,
        `docs/baselines/v0.2.9/screenshots/${journey.role}/${viewport.name}/${journey.journey}.png`
      );
      assert.equal(typeof slot.exists, 'boolean');
      assert.ok(slot.sha256 === null || /^[a-f0-9]{64}$/.test(slot.sha256));
    }
  }

  assert.deepEqual(slotsByViewportAndJourney.get('fixture-1440/public-login').substate, null);
  assert.deepEqual(slotsByViewportAndJourney.get('fixture-1920/admin-crm-detail-seapool').substate, { view: 'seapool' });
  assert.deepEqual(slotsByViewportAndJourney.get('fixture-mobile/admin-m4-tab3').substate, { tab: 'tab3' });
  assert.deepEqual(slotsByViewportAndJourney.get('fixture-mobile/admin-admin-ai-audit').substate, { tab: 'ai-audit' });
});

test('CLI writes the sanitized baseline manifest', () => {
  loadGenerator();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-ui-manifest-'));
  const outputPath = path.join(tempDir, 'ui-ppt-manifest.json');

  try {
    const result = spawnSync(process.execPath, [
      generatorPath,
      '--baseline-version',
      'v0.2.9',
      '--output',
      outputPath
    ], {
      cwd: serverRoot,
      encoding: 'utf8'
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const manifest = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.equal(manifest.baseline.version, 'v0.2.9');
    assert.equal(manifest.files.indexHtml.source, 'platform/index.html');
    assert.deepEqual(manifest.scriptCacheKeys, {
      app: '20260713v030baselineconsolidation',
      ppt: '20260702v916kbbridge'
    });
    assert.doesNotMatch(JSON.stringify(manifest), /[A-Z]:\\\\|Users\\\\29272|TM_PRIVATE|TURINGMARKET_SERVER/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

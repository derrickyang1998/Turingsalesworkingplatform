'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const platformRoot = path.resolve(__dirname, '..', '..');
const serverRoot = path.join(platformRoot, 'server');
const deployPath = path.join(platformRoot, 'deploy_v8.ps1');
const trustedGatePath = path.join(serverRoot, 'scripts', 'trusted_production_source_gate.js');
const trustedManifestPath = path.join(serverRoot, 'scripts', 'trusted_production_source_manifest.json');
const dependencyRoot = fs.realpathSync(path.join(serverRoot, 'node_modules'));
const migrationService = require('../services/migration_service');

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function relativeRequireTargets(filePath) {
  const targets = [];
  for (const match of read(filePath).matchAll(/\brequire\(\s*(['"])(\.[^'"]+)\1\s*\)/g)) {
    const base = path.resolve(path.dirname(filePath), match[2]);
    const candidates = path.extname(base)
      ? [base]
      : [`${base}.js`, `${base}.json`, path.join(base, 'index.js')];
    const resolved = candidates.find((candidate) => fs.existsSync(candidate));
    if (resolved && fs.statSync(resolved).isFile()) {
      targets.push(path.relative(platformRoot, resolved).split(path.sep).join('/'));
    }
  }
  return [...new Set(targets)].sort();
}

function loadTrustedGate() {
  assert.equal(fs.existsSync(trustedGatePath), true, 'trusted production source gate must exist');
  return require(trustedGatePath);
}

function loadTrustedManifest() {
  assert.equal(fs.existsSync(trustedManifestPath), true, 'trusted production source manifest must exist');
  return JSON.parse(read(trustedManifestPath));
}

function copyContractCandidate(manifest, destination) {
  for (const entry of manifest.files) {
    const sourcePath = entry.sourcePath || entry.path;
    const source = path.join(platformRoot, ...sourcePath.split('/'));
    const target = path.join(destination, ...sourcePath.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
}

function writeCurrentContractManifest(root) {
  const manifest = loadTrustedManifest();
  for (const entry of manifest.files) {
    entry.sha256 = sha256(path.join(platformRoot, ...(entry.sourcePath || entry.path).split('/')));
  }
  const manifestPath = path.join(root, 'trusted-production-source-manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { manifest, manifestPath };
}

function verifierSha256(manifest) {
  return manifest.files.find((entry) => (
    entry.path === 'server/scripts/verify_campaign_migration_gate.js'
  )).sha256;
}

function createV1Fixture(t, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `tm-trusted-source-${name}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const databasePath = path.join(root, 'sanitized-v1.db');
  const database = migrationService.openMigratedDatabase(databasePath, { rootDir: serverRoot });
  database.prepare('UPDATE users SET display_name=? WHERE id=(SELECT MIN(id) FROM users)')
    .run('trusted-source-fixture');
  database.close();
  return { root, databasePath };
}

function addProductionOnlyUser(databasePath) {
  const database = migrationService.openMigratedDatabase(databasePath, { rootDir: serverRoot });
  try {
    database.prepare(`
      INSERT INTO users (
        username, password_hash, display_name, role, email, department,
        api_quota, created_at, last_login, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'real-production-only-user',
      '$2b$12$realProductionCredentialMaterialForProvenance',
      'Real production-only identity',
      'user',
      'real-production-only@example.com',
      'Production Operations',
      73001,
      '2026-07-30 09:10:11',
      null,
      1
    );
  } finally {
    database.close();
  }
}

function runPowerShellFunctionHarness(functionNames, body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-deploy-trust-powershell-'));
  const harnessPath = path.join(root, 'harness.ps1');
  const names = functionNames.map((name) => `'${name.replace(/'/g, "''")}'`).join(', ');
  const harness = `
param([Parameter(Mandatory = $true)][string]$DeployPath)
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($DeployPath, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw ($errors[0].Message) }
$wanted = @(${names})
$definitions = New-Object 'Collections.Generic.List[string]'
foreach ($name in $wanted) {
  $matches = @($ast.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
  }, $true))
  if ($matches.Count -ne 1) { throw "Expected one function named $name; found $($matches.Count)" }
  $definitions.Add($matches[0].Extent.Text)
}

Invoke-Expression ($definitions -join "\r\n")
${body}
`;
  fs.writeFileSync(harnessPath, harness, 'utf8');
  try {
    return spawnSync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      harnessPath,
      deployPath
    ], {
      cwd: platformRoot,
      encoding: 'utf8',
      timeout: 15_000
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('portable trusted-bundle invariants reject old-bundle ownership and mode tampering', () => {
  const gate = loadTrustedGate();
  assert.equal(
    typeof gate.assertTrustedBundlePosixMetadataSnapshot,
    'function',
    'the production gate must expose its portable POSIX metadata validator'
  );

  const validSnapshot = () => ({
    ancestors: [
      { path: '/', kind: 'directory', uid: 0, gid: 0, mode: 0o755, nlink: 1 },
      { path: '/usr/local/libexec/turingmarket/production-source-trust', kind: 'directory', uid: 0, gid: 0, mode: 0o755, nlink: 1 }
    ],
    directories: [
      { path: '', kind: 'directory', uid: 0, gid: 0, mode: 0o555, nlink: 1 },
      { path: 'server', kind: 'directory', uid: 0, gid: 0, mode: 0o555, nlink: 1 }
    ],
    files: [
      { path: 'server/package.json', kind: 'file', uid: 0, gid: 0, mode: 0o444, nlink: 1 }
    ]
  });

  assert.doesNotThrow(() => gate.assertTrustedBundlePosixMetadataSnapshot(validSnapshot()));

  const cases = [
    {
      name: 'old bundle root owner',
      mutate(snapshot) { snapshot.directories[0].uid = 991; },
      expected: /trusted bundle root.*uid\/gid 0:0/i
    },
    {
      name: 'old bundle directory mode',
      mutate(snapshot) { snapshot.directories[1].mode = 0o755; },
      expected: /trusted bundle directory.*mode 0555/i
    },
    {
      name: 'old bundle file owner',
      mutate(snapshot) { snapshot.files[0].uid = 991; },
      expected: /trusted bundle file.*uid\/gid 0:0/i
    },
    {
      name: 'trusted ancestor mode',
      mutate(snapshot) { snapshot.ancestors[1].mode = 0o777; },
      expected: /trusted bundle ancestor.*not writable/i
    }
  ];

  for (const scenario of cases) {
    const snapshot = validSnapshot();
    scenario.mutate(snapshot);
    assert.throws(
      () => gate.assertTrustedBundlePosixMetadataSnapshot(snapshot),
      scenario.expected,
      `${scenario.name} tampering must fail closed before trusted code executes`
    );
  }
});

test('trusted source identity requires uid 0, the expected gid, mode 0440, and nlink 1', (t) => {
  const gate = loadTrustedGate();
  assert.equal(typeof gate.assertExpectedSourceIdentityMetadata, 'function');
  assert.equal(typeof gate.captureImmutableDatabaseIdentity, 'function');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-source-metadata-capture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const capturedPath = path.join(root, 'source.db');
  fs.writeFileSync(capturedPath, 'captured source identity');
  const captured = gate.captureImmutableDatabaseIdentity(capturedPath, 'captured source fixture');
  const capturedMetadata = fs.statSync(capturedPath);
  assert.deepEqual({
    uid: captured.uid,
    gid: captured.gid,
    mode: captured.mode,
    nlink: captured.nlink
  }, {
    uid: String(capturedMetadata.uid),
    gid: String(capturedMetadata.gid),
    mode: (capturedMetadata.mode & 0o777).toString(8).padStart(4, '0'),
    nlink: String(capturedMetadata.nlink)
  });
  const exactIdentity = {
    path: '/run/turingmarket-production-source-trust/deployment-20260731-120000/source.db',
    dev: '41',
    ino: '73',
    size: '8192',
    mtimeNs: '101',
    ctimeNs: '102',
    uid: '0',
    gid: '991',
    mode: '0440',
    nlink: '1',
    sha256: 'a'.repeat(64)
  };

  assert.doesNotThrow(() => gate.assertExpectedSourceIdentityMetadata(
    exactIdentity,
    '991',
    'trusted immutable source copy'
  ));
  for (const [field, value] of [
    ['uid', '991'],
    ['gid', '992'],
    ['mode', '0640'],
    ['nlink', '2']
  ]) {
    assert.throws(
      () => gate.assertExpectedSourceIdentityMetadata(
        { ...exactIdentity, [field]: value },
        '991',
        'trusted immutable source copy'
      ),
      /uid=0.*gid=991.*mode=0440.*nlink=1/i,
      `${field} tampering must fail the exact source metadata admission contract`
    );
  }
});

test('trusted source checkpoints reject uid, gid, mode, and nlink changes after sanitizer and rehearsal', () => {
  const gate = loadTrustedGate();
  assert.equal(typeof gate.assertImmutableDatabaseIdentitySnapshot, 'function');
  const captured = {
    path: '/run/turingmarket-production-source-trust/deployment-20260731-120000/source.db',
    dev: '41',
    ino: '73',
    size: '8192',
    mtimeNs: '101',
    ctimeNs: '102',
    uid: '0',
    gid: '991',
    mode: '0440',
    nlink: '1',
    sha256: 'b'.repeat(64)
  };

  for (const checkpoint of [
    'trusted immutable source copy after sanitization',
    'trusted immutable source copy after migration rehearsal'
  ]) {
    for (const [field, value] of [
      ['uid', '991'],
      ['gid', '992'],
      ['mode', '0640'],
      ['nlink', '2']
    ]) {
      assert.throws(
        () => gate.assertImmutableDatabaseIdentitySnapshot(
          captured,
          { ...captured, [field]: value },
          checkpoint
        ),
        /SHA-256\/dev\/ino identity changed.*uid\/gid\/mode\/nlink/i,
        `${field} tampering must fail at ${checkpoint}`
      );
    }
  }
});

test('deployment source verdict rejects a same-name verifier supplied by the candidate', (t) => {
  const gate = loadTrustedGate();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-malicious-candidate-verifier-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { manifest, manifestPath } = writeCurrentContractManifest(root);
  const candidateRoot = path.join(root, 'candidate');
  const bundleRoot = path.join(root, 'trusted', 'bundle');
  copyContractCandidate(manifest, candidateRoot);
  gate.stageTrustedBundle({ candidateRoot, bundleRoot, manifestPath });
  const verifierPath = path.join(candidateRoot, 'server', 'scripts', 'verify_campaign_migration_gate.js');
  fs.writeFileSync(verifierPath, "module.exports={verifySanitizedMigrationCopy(){return {runs:2}}};\n", 'utf8');

  assert.throws(
    () => gate.stageTrustedBundle({ candidateRoot, bundleRoot, manifestPath }),
    /SHA-256 mismatch.*verify_campaign_migration_gate\.js/i,
    'an already-published trusted bundle must not bypass current candidate validation'
  );
});

test('trusted source manifest pins the sanitizer closure, policy, baseline, and exact v1-to-v6 bundle', () => {
  const manifest = loadTrustedManifest();
  const paths = new Set(manifest.files.map((entry) => entry.path));
  assert.equal(manifest.format, 'tm-trusted-production-source-manifest-v1');
  assert.deepEqual(manifest.migrationContract, {
    sourceVersion: 1,
    targetVersion: 6,
    runs: 2,
    deterministicAppendTables: ['activity_log']
  });
  for (const required of [
    'server/scripts/sanitization_manifest.json',
    'server/scripts/sanitize_production_shape.js',
    'server/scripts/verify_campaign_migration_gate.js',
    'server/services/campaign_access_service.js',
    'server/services/campaign_workflow_service.js',
    'server/services/crm_access_service.js',
    'server/services/crm_contract.js',
    'server/services/crm_customer_service.js',
    'server/services/crm_query_service.js',
    'server/services/crm_scope_service.js',
    'server/services/idempotency_service.js',
    'server/services/knowledge_service.js',
    'server/services/migration_service.js',
    'server/services/organization_access_service.js',
    'server/services/sqlite_digest_service.js',
    'server/migrations/baselines/legacy_v1.js',
    'server/migrations/engines/v1.js',
    'server/migrations/001_legacy_compat_columns.js',
    'server/migrations/002_campaign_business_spine.js',
    'server/migrations/003_campaign_workflow_dispatch_evidence.js',
    'server/migrations/004_knowledge_capacity_observability.js',
    'server/migrations/005_knowledge_custody_projection.js',
    'server/migrations/006_crm_sales_workspace.js',
    'server/migrations/vendor/bcryptjs_v3_0_3.js',
    'server/package.json',
    'server/package-lock.json'
  ]) {
    assert.equal(paths.has(required), true, `trusted bundle must pin ${required}`);
  }
  assert.deepEqual(manifest.entrypoints, {
    sanitizer: 'server/scripts/sanitize_production_shape.js',
    sanitizationManifest: 'server/scripts/sanitization_manifest.json',
    verifier: 'server/scripts/verify_campaign_migration_gate.js'
  });
  assert.equal(
    Object.hasOwn(manifest.files.find((entry) => entry.path === manifest.entrypoints.sanitizer), 'sourcePath'),
    false,
    'the trusted bundle must pin the real sanitizer bytes, not a candidate-selected compatibility shim'
  );
  for (const entry of manifest.files.filter((candidate) => candidate.path.endsWith('.js'))) {
    const absolute = path.join(platformRoot, ...entry.path.split('/'));
    for (const dependency of relativeRequireTargets(absolute)) {
      assert.equal(
        paths.has(dependency),
        true,
        `${entry.path} requires ${dependency}, which must be checksum-pinned in the trusted bundle`
      );
    }
  }
  for (const entry of manifest.files) {
    assert.match(entry.sha256, /^[0-9a-f]{64}$/, `${entry.path} must have a fixed SHA-256`);
    const sourcePath = entry.sourcePath || entry.path;
    assert.equal(sha256(path.join(platformRoot, ...sourcePath.split('/'))), entry.sha256, sourcePath);
  }
});

test('trusted gate fails closed when its deploy-pinned self checksum does not match', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-trusted-source-self-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = loadTrustedManifest();
  const result = spawnSync(process.execPath, [
    trustedGatePath,
    'stage',
    '--candidate-root', platformRoot,
    '--bundle-root', path.join(root, 'bundle'),
    '--manifest', trustedManifestPath,
    '--expected-self-sha256', '0'.repeat(64),
    '--expected-manifest-sha256', sha256(trustedManifestPath),
    '--expected-verifier-sha256', verifierSha256(manifest)
  ], { encoding: 'utf8', timeout: 30_000 });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /trusted production source gate SHA-256 mismatch/i);
  assert.equal(fs.existsSync(path.join(root, 'bundle')), false);
});

test('trusted bundle staging rejects a forged candidate verifier before publication', (t) => {
  const gate = loadTrustedGate();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-trusted-source-forged-candidate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { manifest, manifestPath } = writeCurrentContractManifest(root);
  const candidateRoot = path.join(root, 'candidate');
  const bundleRoot = path.join(root, 'trusted', 'bundle');
  copyContractCandidate(manifest, candidateRoot);
  const verifierPath = path.join(candidateRoot, 'server', 'scripts', 'verify_campaign_migration_gate.js');
  fs.writeFileSync(verifierPath, "module.exports={verifySanitizedMigrationCopy(){return {runs:2}}};\n", 'utf8');

  assert.throws(
    () => gate.stageTrustedBundle({ candidateRoot, bundleRoot, manifestPath }),
    /SHA-256 mismatch.*verify_campaign_migration_gate\.js/i
  );
  assert.equal(fs.existsSync(bundleRoot), false, 'a rejected candidate must not publish a trusted bundle');
});

test('trusted bundle staging rejects a candidate sanitizer that would substitute a minimal v1 database', (t) => {
  const gate = loadTrustedGate();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-forged-candidate-sanitizer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { manifest, manifestPath } = writeCurrentContractManifest(root);
  const candidateRoot = path.join(root, 'candidate');
  const bundleRoot = path.join(root, 'trusted', 'bundle');
  copyContractCandidate(manifest, candidateRoot);
  const sanitizerPath = path.join(candidateRoot, 'server', 'scripts', 'sanitize_production_shape.js');
  fs.writeFileSync(
    sanitizerPath,
    "require('node:fs').copyFileSync(process.argv[2], process.argv[3]);\n",
    'utf8'
  );

  assert.throws(
    () => gate.stageTrustedBundle({ candidateRoot, bundleRoot, manifestPath }),
    /SHA-256 mismatch.*sanitize_production_shape\.js/i
  );
  assert.equal(fs.existsSync(bundleRoot), false, 'a forged sanitizer must not publish executable trusted bytes');
});

test('trusted deployment-side verifier independently admits exact populated v1 through two preserved v1-to-v6 runs', (t) => {
  const gate = loadTrustedGate();
  const fixture = createV1Fixture(t, 'two-runs');
  const sanitizedPath = path.join(fixture.root, 'trusted-sanitized-v1.db');
  const { manifest, manifestPath } = writeCurrentContractManifest(fixture.root);
  const candidateRoot = path.join(fixture.root, 'candidate');
  const bundleRoot = path.join(fixture.root, 'trusted', 'bundle');
  copyContractCandidate(manifest, candidateRoot);
  gate.stageTrustedBundle({ candidateRoot, bundleRoot, manifestPath });
  const result = spawnSync(process.execPath, [
    trustedGatePath,
    'sanitize-and-verify',
    '--candidate-root', candidateRoot,
    '--bundle-root', bundleRoot,
    '--manifest', manifestPath,
    '--source', fixture.databasePath,
    '--expected-source-gid', '0',
    '--sanitized-source', sanitizedPath,
    '--work-dir', path.join(fixture.root, 'migration-work'),
    '--dependency-root', dependencyRoot,
    '--expected-self-sha256', sha256(trustedGatePath),
    '--expected-manifest-sha256', sha256(manifestPath),
    '--expected-verifier-sha256', verifierSha256(manifest)
  ], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_PATH: dependencyRoot
    },
    timeout: 120_000
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout.trim());
  assert.deepEqual({
    format: report.format,
    sourceVersion: report.sourceVersion,
    targetVersion: report.targetVersion,
    runs: report.runs,
    preMigrationRestoreVerified: report.preMigrationRestoreVerified,
    legacyPreservationVerified: report.legacyPreservationVerified
  }, {
    format: 'tm-trusted-production-source-verdict-v1',
    sourceVersion: 1,
    targetVersion: 6,
    runs: 2,
    preMigrationRestoreVerified: true,
    legacyPreservationVerified: true
  });
  assert.match(report.sourceSha256, /^[0-9a-f]{64}$/);
  assert.match(report.sanitizedSourceSha256, /^[0-9a-f]{64}$/);
  assert.notEqual(report.sourceSha256, report.sanitizedSourceSha256);
  assert.equal(report.trustedSanitizerSha256, manifest.files.find((entry) => (
    entry.path === manifest.entrypoints.sanitizer
  )).sha256);
  assert.match(report.preMigration.topologySha256, /^[0-9a-f]{64}$/);
  assert.match(report.postMigration.logicalSha256, /^[0-9a-f]{64}$/);
});

test('trusted verifier rejects a malicious sanitizer that substitutes an unrelated minimal v1 database', (t) => {
  const gate = loadTrustedGate();
  const source = createV1Fixture(t, 'real-source');
  const substituted = createV1Fixture(t, 'substituted-minimal');
  addProductionOnlyUser(source.databasePath);
  const { manifest, manifestPath } = writeCurrentContractManifest(source.root);
  const candidateRoot = path.join(source.root, 'candidate');
  const bundleRoot = path.join(source.root, 'trusted', 'bundle');
  copyContractCandidate(manifest, candidateRoot);
  gate.stageTrustedBundle({ candidateRoot, bundleRoot, manifestPath });

  const result = spawnSync(process.execPath, [
    trustedGatePath,
    'sanitize-and-verify',
    '--candidate-root', candidateRoot,
    '--bundle-root', bundleRoot,
    '--manifest', manifestPath,
    '--source', source.databasePath,
    '--expected-source-gid', '0',
    '--sanitized-source', substituted.databasePath,
    '--work-dir', path.join(source.root, 'malicious-substitution-work'),
    '--dependency-root', dependencyRoot,
    '--expected-self-sha256', sha256(trustedGatePath),
    '--expected-manifest-sha256', sha256(manifestPath),
    '--expected-verifier-sha256', verifierSha256(manifest)
  ], {
    cwd: source.root,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: dependencyRoot },
    timeout: 120_000
  });

  assert.notEqual(
    result.status,
    0,
    'an unrelated minimal v1 output must be rejected even when it independently migrates to v6'
  );
  assert.match(result.stderr, /trusted sanitizer output must not exist/i);
});

test('trusted gate rejects source path replacement even when source SHA-256 bytes are unchanged', (t) => {
  const gate = loadTrustedGate();
  const fixture = createV1Fixture(t, 'source-identity-replacement');
  const { manifest, manifestPath } = writeCurrentContractManifest(fixture.root);
  const candidateRoot = path.join(fixture.root, 'candidate');
  const bundleRoot = path.join(fixture.root, 'trusted', 'bundle');
  copyContractCandidate(manifest, candidateRoot);
  const sanitizerPath = path.join(candidateRoot, 'server', 'scripts', 'sanitize_production_shape.js');
  fs.writeFileSync(sanitizerPath, `
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
module.exports = {
  REPORT_VERSION: 'tm-sanitization-report-v1',
  sanitizeProductionShape(options) {
    const replacement = options.sourcePath + '.replacement';
    fs.copyFileSync(options.sourcePath, replacement);
    fs.unlinkSync(options.sourcePath);
    fs.renameSync(replacement, options.sourcePath);
    fs.copyFileSync(options.sourcePath, options.outputPath);
    const outputSha256 = crypto.createHash('sha256').update(fs.readFileSync(options.outputPath)).digest('hex');
    return { format: this.REPORT_VERSION, sourceVersion: 1, tableCount: 1, rowCount: 1, outputSha256 };
  }
};
`, 'utf8');
  manifest.files.find((entry) => entry.path === manifest.entrypoints.sanitizer).sha256 = sha256(sanitizerPath);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  gate.stageTrustedBundle({ candidateRoot, bundleRoot, manifestPath });
  const result = spawnSync(process.execPath, [
    trustedGatePath,
    'sanitize-and-verify',
    '--candidate-root', candidateRoot,
    '--bundle-root', bundleRoot,
    '--manifest', manifestPath,
    '--source', fixture.databasePath,
    '--expected-source-gid', '0',
    '--sanitized-source', path.join(fixture.root, 'identity-output.db'),
    '--work-dir', path.join(fixture.root, 'identity-work'),
    '--dependency-root', dependencyRoot,
    '--expected-self-sha256', sha256(trustedGatePath),
    '--expected-manifest-sha256', sha256(manifestPath),
    '--expected-verifier-sha256', verifierSha256(manifest)
  ], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: dependencyRoot },
    timeout: 30_000
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /source copy.*SHA-256\/dev\/ino identity changed/i);
});

test('trusted verifier fails closed if its staged migration bundle changes after admission', (t) => {
  const gate = loadTrustedGate();
  const fixture = createV1Fixture(t, 'bundle-drift');
  const { manifest, manifestPath } = writeCurrentContractManifest(fixture.root);
  const candidateRoot = path.join(fixture.root, 'candidate');
  const bundleRoot = path.join(fixture.root, 'trusted', 'bundle');
  copyContractCandidate(manifest, candidateRoot);
  gate.stageTrustedBundle({ candidateRoot, bundleRoot, manifestPath });
  const migrationPath = path.join(bundleRoot, 'server', 'migrations', '005_knowledge_custody_projection.js');
  fs.chmodSync(migrationPath, 0o600);
  fs.appendFileSync(migrationPath, '\n// forged after admission\n', 'utf8');

  const result = spawnSync(process.execPath, [
    trustedGatePath,
    'sanitize-and-verify',
    '--candidate-root', candidateRoot,
    '--bundle-root', bundleRoot,
    '--manifest', manifestPath,
    '--source', fixture.databasePath,
    '--expected-source-gid', '0',
    '--sanitized-source', path.join(fixture.root, 'bundle-drift-output.db'),
    '--work-dir', path.join(fixture.root, 'migration-work'),
    '--dependency-root', dependencyRoot,
    '--expected-self-sha256', sha256(trustedGatePath),
    '--expected-manifest-sha256', sha256(manifestPath),
    '--expected-verifier-sha256', verifierSha256(manifest)
  ], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: dependencyRoot },
    timeout: 30_000
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SHA-256 mismatch.*005_knowledge_custody_projection\.js/i);
});

test('deploy pins trusted sanitizer closure and never executes candidate sanitizer code for the verdict', () => {
  const deploy = read(deployPath);
  const manifest = loadTrustedManifest();
  const expectedConstant = (name) => {
    const match = deploy.match(new RegExp(`\\$${name}\\s*=\\s*"([0-9a-f]{64})"`));
    assert.ok(match, `$${name} must be a literal SHA-256`);
    return match[1];
  };
  assert.equal(expectedConstant('EXPECTED_TRUSTED_SOURCE_GATE_SHA256'), sha256(trustedGatePath));
  assert.equal(expectedConstant('EXPECTED_TRUSTED_SOURCE_MANIFEST_SHA256'), sha256(trustedManifestPath));
  const verifier = manifest.files.find((entry) => entry.path === 'server/scripts/verify_campaign_migration_gate.js');
  assert.ok(verifier);
  assert.equal(expectedConstant('EXPECTED_TRUSTED_MIGRATION_VERIFIER_SHA256'), verifier.sha256);

  const candidateMatch = deploy.match(/\$candidateGate\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(candidateMatch, 'candidate gate must exist');
  const candidateGate = candidateMatch[1];
  assert.doesNotMatch(candidateGate, /node "\$CandidateDir\/server\/scripts\/sanitize_production_shape\.js"/);
  assert.doesNotMatch(candidateGate, /SanitizerUnit="turingmarket-untrusted-sanitizer-/);
  assert.match(candidateGate, /--uid="\$GateUser" --gid="\$GateUser"/);
  assert.match(candidateGate, /TrustedSourceInputBase="\/run\/turingmarket-production-source-trust"/);
  assert.match(candidateGate, /TrustedSourceInputRoot="\$TrustedSourceInputBase\/deployment-__STAMP__"/);
  assert.doesNotMatch(candidateGate, /TrustedSourceInputRoot="\$RemoteRoot\//);
  assert.match(candidateGate, /install -d -o root -g "\$GateUser" -m 0710 "\$TrustedSourceInputBase"/);
  assert.match(candidateGate, /chmod 0510 "\$TrustedSourceInputRoot"/);
  assert.match(candidateGate, /install -o root -g "\$GateUser" -m 0440 "\$ProductionBackupDb" "\$TrustedSourceCopy"/);
  assert.match(candidateGate, /stat -c '%U:%G:%a:%h' "\$TrustedSourceCopy"\)" = "root:\$GateUser:440:1"/);
  assert.match(candidateGate, /runuser -u "\$GateUser" -- test ! -r "\$TrustedSourceInputRoot"/);
  assert.match(candidateGate, /runuser -u "\$GateUser" -- test -r "\$TrustedSourceCopy"/);
  assert.match(candidateGate, /TRUSTED_SOURCE_SHA256_BEFORE/);
  assert.match(candidateGate, /TRUSTED_SOURCE_DEV_INO_BEFORE/);
  assert.match(candidateGate, /TRUSTED_SOURCE_METADATA_BEFORE/);
  assert.match(candidateGate, /ExpectedTrustedSourceGid="\$\(id -g "\$GateUser"\)"/);
  assert.doesNotMatch(candidateGate, /--source "\$ProductionBackupDb"/);
  assert.doesNotMatch(candidateGate, /TM_SANITIZER_REPORT/);
  assert.doesNotMatch(candidateGate, /TM_REHEARSAL_VERIFIER="\$CandidateDir\/server\/scripts\/verify_campaign_migration_gate\.js"/);
  assert.match(candidateGate, /TrustedSourceGate="__TRUSTED_SOURCE_GATE__"/);
  assert.match(candidateGate, /sha256sum "\$TrustedSourceGate"/);
  assert.match(candidateGate, /"\$TrustedSourceGate" stage/);
  assert.match(candidateGate, /"\$TrustedSourceGate" prepare-runtime/);
  assert.match(candidateGate, /"\$TrustedSourceGate" sanitize-and-verify/);
  assert.match(candidateGate, /--source "\$TrustedSourceCopy"/);
  assert.match(candidateGate, /--expected-source-gid "\$ExpectedTrustedSourceGid"/);
  assert.match(candidateGate, /--sanitized-source "\$SchemaDb"/);
  assert.match(candidateGate, /TrustedDependencyRoot="\$TrustedSourceRuntime\/server\/node_modules"/);
  assert.doesNotMatch(candidateGate, /--dependency-root "\$CandidateDir/);
  assert.doesNotMatch(candidateGate, /require\('\.\/scripts\/(?:sanitize_production_shape|verify_campaign_migration_gate)'\)/);

  assert.match(deploy, /function Assert-TrustedProductionSourceArtifacts/);
  assert.match(deploy, /Assert-TrustedProductionSourceArtifacts[\s\S]*?Assert-ImmutableDeploymentActionPlan -DeploymentPlan \$DeploymentPlan/);
  assert.match(deploy, /\$DeploymentPlan\.GetByRemoteRelativePath\("platform\/\$relativePath"\)/);
  assert.match(deploy, /\$localPinnedRecord\.ExpectedSha256 -cne \$expectedSha256/);
  assert.match(deploy, /Install-RemoteTrustedProductionSourceGate[\s\S]*?GateBase64/);
  const normalDeployStart = deploy.indexOf('Write-Host "TuringMarket guarded deploy starting"');
  const trustedInstallCall = deploy.indexOf('    Install-RemoteTrustedProductionSourceGate', normalDeployStart);
  const staleSweepCall = deploy.indexOf('    Invoke-RemoteTrustedSourceInputSweep', normalDeployStart);
  const lockCall = deploy.indexOf('    Enter-RemoteDeploymentLock', normalDeployStart);
  assert.ok(
    lockCall >= 0 && staleSweepCall > lockCall && staleSweepCall < trustedInstallCall,
    'stale trusted source copies must be swept under the deployment lock before candidate-controlled work'
  );
  assert.ok(
    trustedInstallCall >= 0 && trustedInstallCall < deploy.indexOf('Invoke-RemoteBackup -BackupPath $backupDir'),
    'trusted gate must be installed and checked before backup or candidate validation'
  );

  const gateCall = deploy.match(/Invoke-RemoteBash -Script \$candidateGate[^\r\n]+/);
  assert.ok(gateCall, 'candidate gate invocation must exist');
  assert.match(gateCall[0], /-TimeoutSeconds \$CANDIDATE_GATE_TIMEOUT_SECONDS/);
  assert.ok(deploy.indexOf(gateCall[0]) < deploy.indexOf('$deploymentWriterToken = [Guid]::NewGuid()'));
  assert.ok(deploy.indexOf(gateCall[0]) < deploy.indexOf('RENAME_EXCHANGE = 2'));
  assert.ok(deploy.indexOf('pm2 restart ecosystem.config.js', deploy.indexOf(gateCall[0])) > deploy.indexOf(gateCall[0]));
});

test('Windows local preflight verifies every checksum-pinned trusted sanitizer input', {
  skip: process.platform !== 'win32'
}, () => {
  const result = runPowerShellFunctionHarness(
    [
      'Get-ExactDeploymentInventoryIdentity',
      'Convert-ToRemotePath',
      'Get-CanonicalLocalUploadFile',
      'Initialize-PinnedDeploymentTypes',
      'New-ImmutableDeploymentActionPlan',
      'Assert-ImmutableDeploymentActionPlan',
      'Assert-TrustedProductionSourceArtifacts'
    ],
    `
$LOCAL_DIR = Split-Path -Parent $DeployPath
$REPO_DIR = Split-Path -Parent $LOCAL_DIR
$TRUSTED_SOURCE_GATE_RELATIVE_PATH = 'server\\scripts\\trusted_production_source_gate.js'
$TRUSTED_SOURCE_MANIFEST_RELATIVE_PATH = 'server\\scripts\\trusted_production_source_manifest.json'
$EXPECTED_TRUSTED_SOURCE_GATE_SHA256 = '${sha256(trustedGatePath)}'
$EXPECTED_TRUSTED_SOURCE_MANIFEST_SHA256 = '${sha256(trustedManifestPath)}'
$EXPECTED_TRUSTED_MIGRATION_VERIFIER_SHA256 = '${verifierSha256(loadTrustedManifest())}'
$trustedManifest = Get-Content -Raw -LiteralPath (Join-Path $LOCAL_DIR $TRUSTED_SOURCE_MANIFEST_RELATIVE_PATH) | ConvertFrom-Json
$platformEntries = @(
  $TRUSTED_SOURCE_GATE_RELATIVE_PATH
  $TRUSTED_SOURCE_MANIFEST_RELATIVE_PATH
  @($trustedManifest.files | ForEach-Object { [string]$_.path })
)
$deploymentPlan = New-ImmutableDeploymentActionPlan -CheckoutRoot $REPO_DIR -PlatformRoot $LOCAL_DIR -PlatformEntries $platformEntries -RequiredPublicAssetEntries @() -RootRelativeEntries @() -CandidateOnlyEntries @()
Assert-TrustedProductionSourceArtifacts -DeploymentPlan $deploymentPlan
Write-Output 'TRUSTED_LOCAL_PREFLIGHT_OK'
`
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /TRUSTED_LOCAL_PREFLIGHT_OK/);
});

test('native outer invocation enforces a hard timeout and cannot continue after expiry', {
  skip: process.platform !== 'win32'
}, () => {
  const result = runPowerShellFunctionHarness(
    ['Assert-LastExitCode', 'Convert-ToNativeArgument', 'Invoke-NativeWithUtf8Input'],
    `
try {
  Invoke-NativeWithUtf8Input -FileName 'powershell.exe' -ArgumentList @(
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 20'
  ) -InputText 'ignored' -FailureMessage 'hard-timeout probe failed' -TimeoutSeconds 1
  Write-Output 'UNSAFE_CONTINUATION_AFTER_TIMEOUT'
  exit 91
}
catch {
  Write-Output $_.Exception.Message
  exit 17
}
`
  );

  assert.equal(result.status, 17, result.stderr || result.stdout);
  assert.match(result.stdout, /hard-timeout probe failed timed out after 1 second/i);
  assert.doesNotMatch(result.stdout, /UNSAFE_CONTINUATION_AFTER_TIMEOUT/);
});

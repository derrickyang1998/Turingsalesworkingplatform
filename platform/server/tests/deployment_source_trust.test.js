'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const Database = require('better-sqlite3');

const platformRoot = path.resolve(__dirname, '..', '..');
const serverRoot = path.join(platformRoot, 'server');
const deployPath = path.join(platformRoot, 'deploy_v8.ps1');
const trustedGatePath = path.join(serverRoot, 'scripts', 'trusted_production_source_gate.js');
const trustedManifestPath = path.join(serverRoot, 'scripts', 'trusted_production_source_manifest.json');
const trustedParserVerifierPath = path.join(
  serverRoot,
  'scripts',
  'trusted_parser_runtime_verifier.js'
);
const dependencyRoot = fs.realpathSync(path.join(serverRoot, 'node_modules'));
const legacy = require('../migrations/baselines/legacy_v1');
const migration001 = require('../migrations/001_legacy_compat_columns');
const migrationService = require('../services/migration_service');
const sqliteDigest = require('../services/sqlite_digest_service');
const migrationVerifier = require('../scripts/verify_campaign_migration_gate');

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

function createV6Fixture(t, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `tm-trusted-source-v6-${name}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const databasePath = path.join(root, 'managed-v6.db');
  const database = migrationService.openMigratedDatabase(databasePath, {
    rootDir: serverRoot,
    registeredMigrations: migrationVerifier.REGISTERED_MIGRATIONS.slice(0, -1)
  });
  database.prepare('UPDATE users SET display_name=? WHERE id=(SELECT MIN(id) FROM users)')
    .run('trusted-v6-source-fixture');
  database.close();
  return { root, databasePath };
}

function createV7Fixture(t, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `tm-trusted-source-v7-${name}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const databasePath = path.join(root, 'managed-v7.db');
  const database = migrationService.openMigratedDatabase(databasePath, {
    rootDir: serverRoot,
    registeredMigrations: migrationVerifier.REGISTERED_MIGRATIONS
  });
  database.close();
  return { root, databasePath };
}

function createLegacyV0Fixture(t, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `tm-trusted-source-v0-${name}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const databasePath = path.join(root, 'legacy-v0.db');
  const database = new Database(databasePath);
  database.pragma('foreign_keys = ON');
  legacy.apply(database);
  migration001.apply(database);
  database.prepare(`
    INSERT INTO users (id,username,password_hash,display_name,role)
    VALUES (1,'admin','hash','Admin','admin')
  `).run();
  database.prepare(`
    INSERT INTO influencers (id,platform,kol_handle,cost_usd,quoted_price,cpm,cpv)
    VALUES (128,'YouTube','@production-shape',-3000,-4500,-137.2,-0.14)
  `).run();
  database.prepare(`
    INSERT INTO customers (id,brand_name,stage,created_by,assigned_to)
    VALUES (8,'Production shape customer','new_lead',1,1)
  `).run();
  database.prepare(`
    INSERT INTO customer_activity (id,customer_id,user_id,action,stage_from,stage_to)
    VALUES (23,8,1,'stage_change','proposal','new_lead')
  `).run();
  const entryId = Number(database.prepare(`
    INSERT INTO knowledge_entries (
      entry_type,source_type,key_terms,content,created_by,is_public,title,tags_json,visibility
    ) VALUES ('note','legacy-adoption','legacy adoption','Private adoption content',1,0,'Private title','[]','private')
  `).run().lastInsertRowid);
  database.prepare(`
    INSERT INTO knowledge_chunks (entry_id,chunk_index,content,token_count)
    VALUES (?,0,'Private adoption chunk',4)
  `).run(entryId);
  sqliteDigest.rebuildKnowledgeChunksFts(database);
  database.exec('DELETE FROM knowledge_chunks_fts');
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

test('trusted source manifest pins the sanitizer closure and exact supported source-version bundle', () => {
  const manifest = loadTrustedManifest();
  const paths = new Set(manifest.files.map((entry) => entry.path));
  assert.equal(manifest.format, 'tm-trusted-production-source-manifest-v1');
  assert.deepEqual(manifest.migrationContract, {
    acceptedSourceVersions: [1, 6, 7],
    targetVersion: 7,
    runs: 2,
    deterministicAppendTables: ['activity_log']
  });
  for (const required of [
    'server/scripts/adopt_legacy_production_v1.js',
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
    'server/migrations/007_knowledge_governance.js',
    'server/migrations/vendor/bcryptjs_v3_0_3.js',
    'server/package.json',
    'server/package-lock.json'
  ]) {
    assert.equal(paths.has(required), true, `trusted bundle must pin ${required}`);
  }
  assert.deepEqual(manifest.entrypoints, {
    legacyProductionV1Adoption: 'server/scripts/adopt_legacy_production_v1.js',
    sanitizer: 'server/scripts/sanitize_production_shape.js',
    sanitizationManifest: 'server/scripts/sanitization_manifest.json',
    verifier: 'server/scripts/verify_campaign_migration_gate.js',
    migrationCleanupHelper: 'server/scripts/cleanup_stale_migration_gate.sh',
    migrationCleanupUnit: 'server/systemd/turingmarket-gate-cleanup.service',
    parserBuilder: 'server/scripts/build_upload_sandbox_runtime.sh',
    parserProvisioner: 'server/scripts/provision_upload_sandbox_runtime.sh',
    parserCapacityPlanner: 'server/scripts/check_cutover_capacity.py',
    publicGuard: 'server/scripts/public_release_guard.sh',
    parserSelfTest: 'server/scripts/upload_sandbox_self_test.js',
    parserVerifier: 'server/scripts/trusted_parser_runtime_verifier.js',
    parserManifest: 'server/systemd/turingmarket-parser.manifest.json',
    parserServiceUnit: 'server/systemd/turingmarket-parser@.service',
    parserSliceUnit: 'server/systemd/turingmarket-parser.slice'
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

test('trusted source manifest pins the complete parser control plane and deploy identities', () => {
  const manifest = loadTrustedManifest();
  const deploy = read(deployPath);
  const expectedEntrypoints = {
    legacyProductionV1Adoption: 'server/scripts/adopt_legacy_production_v1.js',
    sanitizer: 'server/scripts/sanitize_production_shape.js',
    sanitizationManifest: 'server/scripts/sanitization_manifest.json',
    verifier: 'server/scripts/verify_campaign_migration_gate.js',
    migrationCleanupHelper: 'server/scripts/cleanup_stale_migration_gate.sh',
    migrationCleanupUnit: 'server/systemd/turingmarket-gate-cleanup.service',
    parserBuilder: 'server/scripts/build_upload_sandbox_runtime.sh',
    parserProvisioner: 'server/scripts/provision_upload_sandbox_runtime.sh',
    parserCapacityPlanner: 'server/scripts/check_cutover_capacity.py',
    publicGuard: 'server/scripts/public_release_guard.sh',
    parserSelfTest: 'server/scripts/upload_sandbox_self_test.js',
    parserVerifier: 'server/scripts/trusted_parser_runtime_verifier.js',
    parserManifest: 'server/systemd/turingmarket-parser.manifest.json',
    parserServiceUnit: 'server/systemd/turingmarket-parser@.service',
    parserSliceUnit: 'server/systemd/turingmarket-parser.slice'
  };
  assert.deepEqual(manifest.entrypoints, expectedEntrypoints);

  const records = new Map(manifest.files.map((entry) => [entry.path, entry.sha256]));
  for (const relativePath of [
    ...Object.values(expectedEntrypoints),
    'server/parser-runtime/package.json',
    'server/parser-runtime/package-lock.json',
    'server/parser-runtime/requirements.lock',
    'server/parser-runtime/pip-cacert.crt',
    'server/parser-runtime/sitecustomize.py',
    'server/extract_document_text.py',
    'server/extract_xlsx_text.py',
    'server/ocr_document_text.py',
    'server/services/file_ingest_service.js',
    'server/services/upload_sandbox_service.js',
    'server/scripts/parse_upload_sandbox.sh'
  ]) {
    assert.equal(records.get(relativePath), sha256(path.join(platformRoot, ...relativePath.split('/'))));
  }

  const verifierSha = sha256(trustedParserVerifierPath);
  assert.match(deploy, new RegExp(`\\$EXPECTED_TRUSTED_PARSER_VERIFIER_SHA256\\s*=\\s*"${verifierSha}"`));
  const publicGuardSha = sha256(path.join(platformRoot, 'server', 'scripts', 'public_release_guard.sh'));
  assert.match(deploy, new RegExp(`\\$EXPECTED_TRUSTED_PUBLIC_GUARD_SHA256\\s*=\\s*"${publicGuardSha}"`));
  assert.match(deploy, new RegExp(`\\$EXPECTED_TRUSTED_SOURCE_MANIFEST_SHA256\\s*=\\s*"${sha256(trustedManifestPath)}"`));
});

test('trusted source manifest independently pins the migration cleanup control plane', () => {
  const manifest = loadTrustedManifest();
  const deploy = read(deployPath);
  const expected = {
    migrationCleanupHelper: 'server/scripts/cleanup_stale_migration_gate.sh',
    migrationCleanupUnit: 'server/systemd/turingmarket-gate-cleanup.service'
  };
  const records = new Map(manifest.files.map((entry) => [entry.path, entry.sha256]));

  for (const [entrypoint, relativePath] of Object.entries(expected)) {
    assert.equal(manifest.entrypoints[entrypoint], relativePath);
    const expectedSha256 = sha256(path.join(platformRoot, ...relativePath.split('/')));
    assert.equal(records.get(relativePath), expectedSha256);
    const constant = entrypoint === 'migrationCleanupHelper'
      ? 'EXPECTED_TRUSTED_MIGRATION_CLEANUP_HELPER_SHA256'
      : 'EXPECTED_TRUSTED_MIGRATION_CLEANUP_UNIT_SHA256';
    assert.match(deploy, new RegExp(`\\$${constant}\\s*=\\s*"${expectedSha256}"`));
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

test('trusted deployment gate adopts exact legacy v0 before sanitized v1-to-v7 verification', (t) => {
  const gate = loadTrustedGate();
  assert.match(
    read(trustedGatePath),
    /mutableSourcePath:\s*path\.join\(workDir, 'trusted-legacy-mutable-source\.db'\)/
  );
  const fixture = createLegacyV0Fixture(t, 'adopt-before-rehearsal');
  const sanitizedPath = path.join(fixture.root, 'trusted-sanitized-v1.db');
  const { manifest, manifestPath } = writeCurrentContractManifest(fixture.root);
  const candidateRoot = path.join(fixture.root, 'candidate');
  const bundleRoot = path.join(fixture.root, 'trusted', 'bundle');
  copyContractCandidate(manifest, candidateRoot);
  gate.stageTrustedBundle({ candidateRoot, bundleRoot, manifestPath });
  const sourceBefore = sha256(fixture.databasePath);
  fs.chmodSync(fixture.databasePath, 0o440);
  const workDir = path.join(fixture.root, 'migration-work');
  const result = spawnSync(process.execPath, [
    trustedGatePath,
    'sanitize-and-verify',
    '--candidate-root', candidateRoot,
    '--bundle-root', bundleRoot,
    '--manifest', manifestPath,
    '--source', fixture.databasePath,
    '--expected-source-gid', String(typeof process.getgid === 'function' ? process.getgid() : 0),
    '--sanitized-source', sanitizedPath,
    '--work-dir', workDir,
    '--dependency-root', dependencyRoot,
    '--expected-self-sha256', sha256(trustedGatePath),
    '--expected-manifest-sha256', sha256(manifestPath),
    '--expected-verifier-sha256', verifierSha256(manifest)
  ], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: dependencyRoot },
    timeout: 120_000
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout.trim());
  assert.deepEqual({
    format: report.format,
    sourceVersion: report.sourceVersion,
    targetVersion: report.targetVersion,
    runs: report.runs,
    adoption: report.databaseAdoption
  }, {
    format: 'tm-trusted-production-source-verdict-v1',
    sourceVersion: 1,
    targetVersion: 7,
    runs: 2,
    adoption: {
      format: 'tm-trusted-legacy-adoption-verdict-v1',
      applied: true,
      sourceVersion: 0,
      targetVersion: 1,
      sourceSha256: sourceBefore,
      outputSha256: report.databaseAdoption.outputSha256,
      baseTableCount: report.databaseAdoption.baseTableCount,
      baseRowCount: report.databaseAdoption.baseRowCount,
      repairs: {
        influencerRows: 1,
        customerRows: 1,
        activityRows: 1,
        ftsRebuilt: true
      }
    }
  });
  assert.match(report.databaseAdoption.outputSha256, /^[0-9a-f]{64}$/);
  assert.notEqual(report.databaseAdoption.outputSha256, sourceBefore);
  assert.equal(sha256(fixture.databasePath), sourceBefore);
  assert.equal(fs.existsSync(path.join(workDir, 'trusted-legacy-mutable-source.db')), false);
});

test('trusted live adoption normalizes a quiesced WAL legacy source through a private copy', (t) => {
  const fixture = createLegacyV0Fixture(t, 'live-wal-adoption');
  const database = new Database(fixture.databasePath, { fileMustExist: true });
  database.pragma('journal_mode = WAL');
  database.pragma('wal_checkpoint(TRUNCATE)');
  database.close();
  assert.equal(fs.readFileSync(fixture.databasePath)[18], 2, 'fixture must retain a WAL database header');
  for (const suffix of ['-wal', '-shm', '-journal']) {
    assert.equal(fs.existsSync(`${fixture.databasePath}${suffix}`), false, `fixture must not retain ${suffix}`);
  }

  const outputPath = path.join(fixture.root, 'adopted-v1.db');
  const privateStagePath = path.join(fixture.root, '.trusted-live-adoption.private');
  const mutableSourcePath = `${privateStagePath}.source`;
  const { manifest, manifestPath } = writeCurrentContractManifest(fixture.root);
  const candidateRoot = path.join(fixture.root, 'candidate');
  const bundleRoot = path.join(fixture.root, 'trusted', 'bundle');
  copyContractCandidate(manifest, candidateRoot);
  loadTrustedGate().stageTrustedBundle({ candidateRoot, bundleRoot, manifestPath });
  const sourceSha256 = sha256(fixture.databasePath);
  const result = spawnSync(process.execPath, [
    trustedGatePath,
    'adopt-if-legacy',
    '--candidate-root', candidateRoot,
    '--bundle-root', bundleRoot,
    '--manifest', manifestPath,
    '--source', fixture.databasePath,
    '--output', outputPath,
    '--private-stage', privateStagePath,
    '--expected-source-sha256', sourceSha256,
    '--expected-self-sha256', sha256(trustedGatePath),
    '--expected-manifest-sha256', sha256(manifestPath),
    '--expected-verifier-sha256', verifierSha256(manifest)
  ], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: dependencyRoot },
    timeout: 30_000
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.applied, true);
  assert.equal(report.sourceSha256, sourceSha256);
  assert.match(report.outputSha256, /^[0-9a-f]{64}$/);
  assert.equal(sha256(fixture.databasePath), sourceSha256, 'approved live source must stay byte-identical');
  assert.equal(fs.readFileSync(fixture.databasePath)[18], 2, 'approved live source must remain WAL-mode');
  assert.equal(fs.existsSync(outputPath), true);
  for (const artifact of [mutableSourcePath, privateStagePath]) {
    assert.equal(fs.existsSync(artifact), false, `${path.basename(artifact)} must be retired`);
    for (const suffix of ['-wal', '-shm', '-journal']) {
      assert.equal(fs.existsSync(`${artifact}${suffix}`), false, `${path.basename(artifact)}${suffix} must be retired`);
    }
  }
});

test('trusted live adoption recognizes exact managed v7 as a no-op', (t) => {
  const fixture = createV7Fixture(t, 'adoption-noop');
  const outputPath = path.join(fixture.root, 'must-not-exist.db');
  const { manifest, manifestPath } = writeCurrentContractManifest(fixture.root);
  const candidateRoot = path.join(fixture.root, 'candidate');
  const bundleRoot = path.join(fixture.root, 'trusted', 'bundle');
  copyContractCandidate(manifest, candidateRoot);
  loadTrustedGate().stageTrustedBundle({ candidateRoot, bundleRoot, manifestPath });
  const sourceSha256 = sha256(fixture.databasePath);
  const result = spawnSync(process.execPath, [
    trustedGatePath,
    'adopt-if-legacy',
    '--candidate-root', candidateRoot,
    '--bundle-root', bundleRoot,
    '--manifest', manifestPath,
    '--source', fixture.databasePath,
    '--output', outputPath,
    '--private-stage', path.join(fixture.root, '.trusted-live-adoption.private'),
    '--expected-source-sha256', sourceSha256,
    '--expected-self-sha256', sha256(trustedGatePath),
    '--expected-manifest-sha256', sha256(manifestPath),
    '--expected-verifier-sha256', verifierSha256(manifest)
  ], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: dependencyRoot },
    timeout: 30_000
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    format: 'tm-trusted-legacy-adoption-verdict-v1',
    applied: false,
    sourceVersion: 7,
    targetVersion: 7,
    sourceSha256,
    outputSha256: sourceSha256,
    baseTableCount: null,
    baseRowCount: null,
    repairs: null
  });
  assert.equal(fs.existsSync(outputPath), false);
});

test('trusted required sanitize-and-verify migrates exact managed v6 to v7 twice with preservation', (t) => {
  const fixture = createV6Fixture(t, 'required-v6-gate');
  const sanitizedPath = path.join(fixture.root, 'trusted-sanitized-v6.db');
  const workDir = path.join(fixture.root, 'migration-work');
  const { manifest, manifestPath } = writeCurrentContractManifest(fixture.root);
  const candidateRoot = path.join(fixture.root, 'candidate');
  const bundleRoot = path.join(fixture.root, 'trusted', 'bundle');
  copyContractCandidate(manifest, candidateRoot);
  loadTrustedGate().stageTrustedBundle({ candidateRoot, bundleRoot, manifestPath });
  const sourceSha256 = sha256(fixture.databasePath);
  fs.chmodSync(fixture.databasePath, 0o440);
  const result = spawnSync(process.execPath, [
    trustedGatePath,
    'sanitize-and-verify',
    '--candidate-root', candidateRoot,
    '--bundle-root', bundleRoot,
    '--manifest', manifestPath,
    '--source', fixture.databasePath,
    '--expected-source-gid', String(typeof process.getgid === 'function' ? process.getgid() : 0),
    '--sanitized-source', sanitizedPath,
    '--work-dir', workDir,
    '--dependency-root', dependencyRoot,
    '--expected-self-sha256', sha256(trustedGatePath),
    '--expected-manifest-sha256', sha256(manifestPath),
    '--expected-verifier-sha256', verifierSha256(manifest)
  ], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: dependencyRoot },
    timeout: 120_000
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout.trim());
  assert.deepEqual({
    verificationMode: report.verificationMode,
    sourceVersion: report.sourceVersion,
    targetVersion: report.targetVersion,
    runs: report.runs,
    preMigrationRestoreVerified: report.preMigrationRestoreVerified,
    legacyPreservationVerified: report.legacyPreservationVerified
  }, {
    verificationMode: 'v6-to-v7-migration',
    sourceVersion: 6,
    targetVersion: 7,
    runs: 2,
    preMigrationRestoreVerified: true,
    legacyPreservationVerified: true
  });
  assert.ok(report.legacyTableCount > 1);
  assert.ok(report.legacyRowCount > 1);
  assert.equal(sha256(fixture.databasePath), sourceSha256);
  assert.equal(fs.existsSync(sanitizedPath), true);
});

test('trusted managed v6 migration rejects pinned 007 code that mutates existing business data', (t) => {
  const fixture = createV6Fixture(t, 'required-v6-tamper');
  const sanitizedPath = path.join(fixture.root, 'trusted-sanitized-v6.db');
  const workDir = path.join(fixture.root, 'migration-work');
  const { manifest, manifestPath } = writeCurrentContractManifest(fixture.root);
  const candidateRoot = path.join(fixture.root, 'candidate');
  const bundleRoot = path.join(fixture.root, 'trusted', 'bundle');
  copyContractCandidate(manifest, candidateRoot);

  const migrationRelative = 'server/migrations/007_knowledge_governance.js';
  const candidateMigration = path.join(candidateRoot, ...migrationRelative.split('/'));
  fs.appendFileSync(candidateMigration, `
const tmOriginalApplyForV6PreservationRegression = module.exports.apply;
module.exports.apply = function tmMutatingV6Migration(db) {
  tmOriginalApplyForV6PreservationRegression(db);
  db.prepare('UPDATE users SET display_name=? WHERE id=(SELECT MIN(id) FROM users)')
    .run('tampered-by-007');
};
`, 'utf8');
  manifest.files.find((entry) => entry.path === migrationRelative).sha256 = sha256(candidateMigration);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  loadTrustedGate().stageTrustedBundle({ candidateRoot, bundleRoot, manifestPath });

  const sourceSha256 = sha256(fixture.databasePath);
  fs.chmodSync(fixture.databasePath, 0o440);
  const result = spawnSync(process.execPath, [
    trustedGatePath,
    'sanitize-and-verify',
    '--candidate-root', candidateRoot,
    '--bundle-root', bundleRoot,
    '--manifest', manifestPath,
    '--source', fixture.databasePath,
    '--expected-source-gid', String(typeof process.getgid === 'function' ? process.getgid() : 0),
    '--sanitized-source', sanitizedPath,
    '--work-dir', workDir,
    '--dependency-root', dependencyRoot,
    '--expected-self-sha256', sha256(trustedGatePath),
    '--expected-manifest-sha256', sha256(manifestPath),
    '--expected-verifier-sha256', verifierSha256(manifest)
  ], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: dependencyRoot },
    timeout: 120_000
  });

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /legacy preservation row equality drift for users/i);
  assert.equal(sha256(fixture.databasePath), sourceSha256);
});

test('trusted required sanitize-and-verify path admits exact managed v7 as a verified no-op', (t) => {
  const fixture = createV7Fixture(t, 'required-v7-gate');
  const sanitizedPath = path.join(fixture.root, 'trusted-sanitized-v7.db');
  const workDir = path.join(fixture.root, 'migration-work');
  const { manifest, manifestPath } = writeCurrentContractManifest(fixture.root);
  const candidateRoot = path.join(fixture.root, 'candidate');
  const bundleRoot = path.join(fixture.root, 'trusted', 'bundle');
  copyContractCandidate(manifest, candidateRoot);
  loadTrustedGate().stageTrustedBundle({ candidateRoot, bundleRoot, manifestPath });
  const sourceSha256 = sha256(fixture.databasePath);
  fs.chmodSync(fixture.databasePath, 0o440);
  const result = spawnSync(process.execPath, [
    trustedGatePath,
    'sanitize-and-verify',
    '--candidate-root', candidateRoot,
    '--bundle-root', bundleRoot,
    '--manifest', manifestPath,
    '--source', fixture.databasePath,
    '--expected-source-gid', String(typeof process.getgid === 'function' ? process.getgid() : 0),
    '--sanitized-source', sanitizedPath,
    '--work-dir', workDir,
    '--dependency-root', dependencyRoot,
    '--expected-self-sha256', sha256(trustedGatePath),
    '--expected-manifest-sha256', sha256(manifestPath),
    '--expected-verifier-sha256', verifierSha256(manifest)
  ], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: dependencyRoot },
    timeout: 120_000
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout.trim());
  assert.deepEqual({
    format: report.format,
    verificationMode: report.verificationMode,
    sourceVersion: report.sourceVersion,
    targetVersion: report.targetVersion,
    runs: report.runs,
    adoption: report.databaseAdoption
  }, {
    format: 'tm-trusted-production-source-verdict-v1',
    verificationMode: 'managed-v7-noop',
    sourceVersion: 7,
    targetVersion: 7,
    runs: 2,
    adoption: {
      format: 'tm-trusted-legacy-adoption-verdict-v1',
      applied: false,
      sourceVersion: 7,
      targetVersion: 7,
      sourceSha256,
      outputSha256: sourceSha256,
      baseTableCount: null,
      baseRowCount: null,
      repairs: null
    }
  });
  assert.match(report.preMigration.topologySha256, /^[0-9a-f]{64}$/);
  assert.equal(report.preMigration.topologySha256, report.postMigration.topologySha256);
  assert.equal(report.preMigration.logicalSha256, report.postMigration.logicalSha256);
  assert.equal(sha256(fixture.databasePath), sourceSha256);
  assert.equal(fs.existsSync(sanitizedPath), true);
});

test('managed v7 no-op verification rejects a pinned migration startup mutation', (t) => {
  const fixture = createV7Fixture(t, 'required-v7-startup-mutation');
  const sanitizedPath = path.join(fixture.root, 'trusted-sanitized-v7.db');
  const workDir = path.join(fixture.root, 'migration-work');
  const { manifest, manifestPath } = writeCurrentContractManifest(fixture.root);
  const candidateRoot = path.join(fixture.root, 'candidate');
  const bundleRoot = path.join(fixture.root, 'trusted', 'bundle');
  copyContractCandidate(manifest, candidateRoot);

  const migrationServiceRelative = 'server/services/migration_service.js';
  const candidateMigrationService = path.join(candidateRoot, ...migrationServiceRelative.split('/'));
  fs.appendFileSync(candidateMigrationService, `
const tmOriginalRunMigrationsForNoopRegression = module.exports.runMigrations;
module.exports.runMigrations = function tmMutatingManagedV7Startup(db, options) {
  const result = tmOriginalRunMigrationsForNoopRegression(db, options);
  db.exec('CREATE TABLE IF NOT EXISTS tm_managed_v7_startup_regression(id INTEGER PRIMARY KEY)');
  return result;
};
`, 'utf8');
  manifest.files.find((entry) => entry.path === migrationServiceRelative).sha256 = sha256(candidateMigrationService);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  loadTrustedGate().stageTrustedBundle({ candidateRoot, bundleRoot, manifestPath });

  fs.chmodSync(fixture.databasePath, 0o440);
  const result = spawnSync(process.execPath, [
    trustedGatePath,
    'sanitize-and-verify',
    '--candidate-root', candidateRoot,
    '--bundle-root', bundleRoot,
    '--manifest', manifestPath,
    '--source', fixture.databasePath,
    '--expected-source-gid', String(typeof process.getgid === 'function' ? process.getgid() : 0),
    '--sanitized-source', sanitizedPath,
    '--work-dir', workDir,
    '--dependency-root', dependencyRoot,
    '--expected-self-sha256', sha256(trustedGatePath),
    '--expected-manifest-sha256', sha256(manifestPath),
    '--expected-verifier-sha256', verifierSha256(manifest)
  ], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: dependencyRoot },
    timeout: 120_000
  });

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /managed target migration no-op changed/i);
  assert.deepEqual(
    fs.readdirSync(workDir).filter((entry) => entry.startsWith('tm-managed-target-noop-')),
    []
  );
});

test('cutover owns and cleans deterministic database adoption artifacts across retries', () => {
  const deploy = read(deployPath);
  const cutoverMatch = deploy.match(/\$cutoverGate\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(cutoverMatch, 'cutover gate must exist');
  const cutoverGate = cutoverMatch[1];

  assert.match(cutoverGate, /DatabaseAdoptionStage="\$DatabaseDir\/\.turingmarket\.db\.adopted"/);
  assert.match(cutoverGate, /DatabaseAdoptionPrivateStage="\$DatabaseDir\/\.turingmarket\.db\.adopted\.private"/);
  assert.doesNotMatch(cutoverGate, /DatabaseAdoptionStage=.*__RUN_ID__/);
  assert.match(cutoverGate, /--private-stage "\$DatabaseAdoptionPrivateStage"/);
  assert.match(cutoverGate, /cleanup_database_adoption_artifacts\(\)/);
  assert.match(
    cutoverGate,
    /python3 - "\$DatabaseDir" "\$DatabaseAdoptionPrivateStage" "\$DatabaseAdoptionStage"/
  );
  assert.match(cutoverGate, /os\.unlink\(candidate\)/);
  assert.match(cutoverGate, /cutover_exit_guard\(\)[\s\S]*cleanup_database_adoption_artifacts \|\| FailClosedStatus=1/);

  const helperStart = cutoverGate.indexOf('\ncleanup_database_adoption_artifacts() {');
  const helperEnd = cutoverGate.indexOf('\n}\n\ncutover_exit_guard()', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'cutover adoption cleanup helper must be bounded');
  const helper = cutoverGate.slice(helperStart, helperEnd);
  assert.match(helper, /mutable_stage = private_stage \+ '\.source'/);
  assert.match(helper, /for base in \(private_stage, mutable_stage, adopted_stage\):/);
  assert.equal(
    [...deploy.matchAll(/mutable_stage = private_stage \+ '\.source'/g)].length,
    2,
    'cutover and rollback cleanup must both own the derived mutable source'
  );
  const completePairValidation = helper.indexOf('database adoption hardlink pair is inconsistent');
  const firstUnlink = helper.indexOf('os.unlink(candidate)');
  assert.ok(
    completePairValidation >= 0 && firstUnlink > completePairValidation,
    'all adoption artifacts and hardlink relationships must validate before the first unlink'
  );

  const restoreCleanup = deploy.match(/cleanup_restore_stages\(\) \{([\s\S]*?)\n\}/);
  assert.ok(restoreCleanup, 'rollback cleanup helper must exist');
  assert.match(restoreCleanup[1], /cleanup_database_adoption_artifacts/);
  assert.doesNotMatch(restoreCleanup[1], /rm -f[\s\S]*DatabaseAdoption/);

  const writerLock = cutoverGate.indexOf('writer_acquired=1');
  const retryCleanup = cutoverGate.indexOf('\ncleanup_database_adoption_artifacts\n', writerLock);
  const adoptionCall = cutoverGate.indexOf('\nadopt_legacy_database_if_required\n');
  assert.ok(
    writerLock >= 0 && retryCleanup > writerLock && adoptionCall > retryCleanup,
    'stale deterministic adoption artifacts must be cleaned under the writer lock before adoption'
  );
});

test('trusted deployment-side verifier independently admits exact populated v1 through two preserved v1-to-v7 runs', (t) => {
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
    targetVersion: 7,
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
  assert.deepEqual(report.databaseAdoption, {
    format: 'tm-trusted-legacy-adoption-verdict-v1',
    applied: false,
    sourceVersion: 1,
    targetVersion: 1,
    sourceSha256: report.sourceSha256,
    outputSha256: report.sourceSha256,
    baseTableCount: null,
    baseRowCount: null,
    repairs: null
  });
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

  const cutoverMatch = deploy.match(/\$cutoverGate\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(cutoverMatch, 'cutover gate must exist');
  const cutoverGate = cutoverMatch[1];
  assert.match(cutoverGate, /TrustedSourceGate="__TRUSTED_SOURCE_GATE__"/);
  assert.match(cutoverGate, /TrustedSourceManifest="__TRUSTED_SOURCE_MANIFEST__"/);
  assert.match(cutoverGate, /TrustedSourceRuntime="__TRUSTED_SOURCE_RUNTIME__"/);
  assert.match(cutoverGate, /"\$TrustedSourceGate" adopt-if-legacy/);
  assert.match(cutoverGate, /--expected-source-sha256 "\$DatabaseSourceSha256"/);
  assert.match(cutoverGate, /TM_DATABASE_ADOPTION_JSON="\$DatabaseAdoptionJson"/);
  assert.match(cutoverGate, /'databaseAdoption': databaseAdoption/);
  const writerStopCall = cutoverGate.indexOf('\nstop_and_quiesce_writers\n');
  const snapshotCall = cutoverGate.indexOf('\ncreate_cutover_snapshot\n');
  const mutationPhaseCall = cutoverGate.indexOf('\nrecord_phase mutation-started\n');
  const adoptionCall = cutoverGate.indexOf('\nadopt_legacy_database_if_required\n');
  const restartCall = cutoverGate.indexOf('restart_pm2_from_ecosystem_exactly', adoptionCall);
  assert.ok(
    writerStopCall >= 0 && snapshotCall > writerStopCall && adoptionCall > snapshotCall && restartCall > adoptionCall,
    'live legacy adoption must run after writer quiescence and durable snapshot but before candidate restart'
  );
  assert.ok(
    mutationPhaseCall > snapshotCall && adoptionCall > mutationPhaseCall,
    'the lifecycle must enter rollback-required mutation state before replacing the live database'
  );

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
  assert.ok(deploy.indexOf('restart_pm2_from_ecosystem_exactly', deploy.indexOf(gateCall[0])) > deploy.indexOf(gateCall[0]));
});

test('live database adoption keeps the source digest distinct from the recovery snapshot digest', () => {
  const deploy = read(deployPath);
  const cutoverMatch = deploy.match(/\$cutoverGate\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(cutoverMatch, 'cutover gate must exist');
  const cutover = cutoverMatch[1];
  const snapshot = cutover.match(
    /create_cutover_snapshot\(\) \{([\s\S]*?)\n\}\n\nadopt_legacy_database_if_required\(\)/
  );
  const adoption = cutover.match(
    /adopt_legacy_database_if_required\(\) \{([\s\S]*?)\n\}\n\narchive_prior_current_marker\(\)/
  );
  assert.ok(snapshot, 'cutover snapshot helper must exist');
  assert.ok(adoption, 'live database adoption helper must exist');

  assert.match(snapshot[1], /DatabaseSourceShaBefore="\$\(sha256sum "\$DatabasePath"/);
  assert.match(snapshot[1], /test "\$DatabaseSourceShaBefore" = "\$DatabaseSourceShaAfter"/);
  assert.doesNotMatch(
    snapshot[1],
    /\blocal\b[^\r\n]*\bDatabaseSourceShaBefore\b/,
    'source digest must remain available to the later adoption helper'
  );
  assert.match(adoption[1], /DatabaseSourceSha256="\$DatabaseSourceShaBefore"/);
  assert.match(
    adoption[1],
    /DatabaseSnapshotSha256="\$\(awk 'NR == 1 \{print \$1\}' "\$CutoverSnapshot\/database\.sha256"\)"/
  );
  assert.match(
    adoption[1],
    /sha256sum "\$CutoverSnapshot\/database\/turingmarket\.db"[^\r\n]*= "\$DatabaseSnapshotSha256"/
  );
  assert.match(adoption[1], /sha256sum "\$DatabasePath"[^\r\n]*= "\$DatabaseSourceSha256"/);
  assert.doesNotMatch(
    adoption[1],
    /sha256sum "\$CutoverSnapshot\/database\/turingmarket\.db"[^\r\n]*= "\$DatabaseSourceSha256"/
  );
});

test('live database adoption accepts only the frozen repair report profiles', () => {
  const deploy = read(deployPath);
  const cutoverMatch = deploy.match(/\$cutoverGate\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(cutoverMatch, 'cutover gate must exist');
  const adoption = cutoverMatch[1].match(
    /adopt_legacy_database_if_required\(\) \{([\s\S]*?)\n\}\n\narchive_prior_current_marker\(\)/
  );
  assert.ok(adoption, 'live database adoption helper must exist');

  assert.match(adoption[1], /allowed_repairs = \(/);
  assert.match(adoption[1], /'influencerRows': 1/);
  assert.match(adoption[1], /'influencerRows': 5/);
  assert.match(adoption[1], /repairs not in allowed_repairs/);
  assert.doesNotMatch(adoption[1], /repairs != \{'influencerRows': 1/);
});

test('trusted runtime dependency scripts are cgroup-contained, egress-bounded, and drained before sealing', () => {
  const deploy = read(deployPath);
  const trustedGate = read(trustedGatePath);
  const candidateMatch = deploy.match(/\$candidateGate\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(candidateMatch, 'candidate gate must exist');
  const candidateGate = candidateMatch[1];

  assert.match(trustedGate, /function assertUnprivilegedBuildIdentity/);
  assert.match(trustedGate, /parseIdentity\(buildUid, 'build UID'\)/);
  assert.match(trustedGate, /parseIdentity\(buildGid, 'build GID'\)/);
  assert.match(trustedGate, /must be a non-root decimal identity/);
  assert.match(trustedGate, /\/usr\/bin\/systemd-run/);
  assert.match(trustedGate, /\/usr\/bin\/systemctl/);
  assert.match(trustedGate, /turingmarket-trusted-runtime-fetch-/);
  assert.match(trustedGate, /turingmarket-trusted-runtime-build-/);
  assert.match(trustedGate, /--uid=/);
  assert.match(trustedGate, /--gid=/);
  assert.match(trustedGate, /PrivatePIDs=yes/);
  assert.match(trustedGate, /KillMode=control-group/);
  assert.match(trustedGate, /NoNewPrivileges=yes/);
  assert.match(trustedGate, /CapabilityBoundingSet=/);
  assert.match(trustedGate, /ProtectSystem=strict/);
  assert.match(trustedGate, /ReadWritePaths=/);
  assert.match(trustedGate, /InaccessiblePaths=/);
  assert.match(trustedGate, /IPAddressDeny=/);
  assert.match(trustedGate, /169\.254\.0\.0\/16/);
  assert.match(trustedGate, /10\.0\.0\.0\/8/);
  assert.match(trustedGate, /172\.16\.0\.0\/12/);
  assert.match(trustedGate, /192\.168\.0\.0\/16/);
  assert.match(trustedGate, /fc00::\/7/);
  assert.match(trustedGate, /PrivateNetwork=yes/);
  assert.match(trustedGate, /RestrictAddressFamilies=AF_UNIX/);
  assert.match(trustedGate, /function drainRuntimeUnit/);
  assert.match(trustedGate, /cgroup\.procs/);
  assert.match(trustedGate, /readRuntimeUnitProperty\(unitName, 'MainPID'\)/);
  assert.match(trustedGate, /npm[\s\S]*?\['ci', '--omit=dev', '--ignore-scripts'\][\s\S]*?'fetch'/);
  assert.match(trustedGate, /npm[\s\S]*?\['rebuild', 'better-sqlite3'\][\s\S]*?'build'/);
  assert.match(trustedGate, /npm_config_registry:\s*'https:\/\/registry\.npmmirror\.com'/);
  assert.match(trustedGate, /npm_config_replace_registry_host:\s*'always'/);
  assert.match(trustedGate, /npm_config_nodedir:\s*'\/usr'/);
  assert.match(trustedGate, /pruneBetterSqliteBuildArtifacts/);
  assert.doesNotMatch(
    trustedGate,
    /spawnSync\(npm, [\s\S]*?\['rebuild', 'better-sqlite3'\]/,
    'package lifecycle scripts must never be spawned directly by the root controller'
  );
  const buildCall = trustedGate.indexOf("['rebuild', 'better-sqlite3']");
  const sealCall = trustedGate.indexOf('sealRuntimeTree(stageRoot', buildCall);
  assert.ok(buildCall >= 0 && sealCall > buildCall, 'runtime sealing must follow the drained offline build unit');

  assert.doesNotMatch(candidateGate, /command -v setpriv/);
  assert.match(candidateGate, /command -v systemd-run/);
  assert.match(candidateGate, /command -v systemctl/);
  assert.match(candidateGate, /TrustedRuntimeBuildUid="\$\(id -u "\$GateUser"\)"/);
  assert.match(candidateGate, /TrustedRuntimeBuildGid="\$\(id -g "\$GateUser"\)"/);
  assert.match(candidateGate, /--build-uid "\$TrustedRuntimeBuildUid"/);
  assert.match(candidateGate, /--build-gid "\$TrustedRuntimeBuildGid"/);
  assert.match(candidateGate, /npm_config_nodedir=\/usr/);
  assert.match(candidateGate, /TM_PRUNE_BETTER_SQLITE_BUILD/);
  const candidateBuildTail = candidateGate.slice(candidateGate.indexOf('npm rebuild better-sqlite3'));
  const drainIndex = candidateBuildTail.indexOf('drain_gate_unit "$DependencyBuildUnit"');
  const killIndex = candidateBuildTail.indexOf('kill_gate_processes "dependency build"');
  const pruneIndex = candidateBuildTail.indexOf('TM_PRUNE_BETTER_SQLITE_BUILD');
  const finalHardlinkIndex = candidateBuildTail.indexOf('DependencyHardlink=');
  assert.ok(drainIndex > 0, 'candidate dependency build unit must be drained after npm rebuild');
  assert.ok(killIndex > drainIndex, 'candidate gate processes must be cleared after the build unit drains');
  assert.ok(pruneIndex > killIndex, 'better-sqlite pruning must run only after build processes are gone');
  assert.ok(finalHardlinkIndex > pruneIndex, 'the global hardlink rejection must remain after pruning');
});

test('trusted runtime removes only verified better-sqlite build hardlink intermediates', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-better-sqlite-prune-'));
  const release = path.join(root, 'server', 'node_modules', 'better-sqlite3', 'build', 'Release');
  const objectRoot = path.join(release, 'obj.target');
  fs.mkdirSync(path.join(objectRoot, 'deps'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const pairs = [
    ['sqlite3.a', path.join('deps', 'sqlite3.a')],
    ['better_sqlite3.node', 'better_sqlite3.node'],
    ['test_extension.node', 'test_extension.node']
  ];
  for (const [runtimeName, objectName] of pairs) {
    const runtimePath = path.join(release, runtimeName);
    const objectPath = path.join(objectRoot, objectName);
    fs.writeFileSync(runtimePath, `fixture:${runtimeName}`);
    fs.linkSync(runtimePath, objectPath);
    assert.equal(fs.lstatSync(runtimePath).nlink, 2);
  }

  loadTrustedGate().pruneBetterSqliteBuildArtifacts(path.join(root, 'server'));

  assert.equal(fs.existsSync(objectRoot), false);
  assert.equal(fs.existsSync(path.join(release, 'sqlite3.a')), false);
  assert.equal(fs.existsSync(path.join(release, 'test_extension.node')), false);
  const runtimeBinary = path.join(release, 'better_sqlite3.node');
  assert.equal(fs.existsSync(runtimeBinary), true);
  assert.equal(fs.lstatSync(runtimeBinary).nlink, 1);
  assert.equal(fs.readFileSync(runtimeBinary, 'utf8'), 'fixture:better_sqlite3.node');
});

test('trusted runtime sealing is descriptor-bound and records a complete dependency tree digest', () => {
  const trustedGate = read(trustedGatePath);
  assert.match(trustedGate, /O_NOFOLLOW/);
  assert.match(trustedGate, /O_DIRECTORY/);
  assert.match(trustedGate, /fs\.fstatSync/);
  assert.match(trustedGate, /fs\.fchownSync/);
  assert.match(trustedGate, /fs\.fchmodSync/);
  assert.match(trustedGate, /metadata\.nlink !== 1/);
  assert.match(trustedGate, /fs\.readlinkSync/);
  assert.match(trustedGate, /dependencyTreeSha256/);
  assert.match(trustedGate, /hashRuntimeTree/);
  assert.match(trustedGate, /runtime dependency tree digest mismatch/);
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
$EXPECTED_TRUSTED_PARSER_VERIFIER_SHA256 = '${sha256(trustedParserVerifierPath)}'
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

test('native outer invocation propagates a nonzero exit code while capturing output', {
  skip: process.platform !== 'win32'
}, () => {
  const result = runPowerShellFunctionHarness(
    ['Assert-LastExitCode', 'Convert-ToNativeArgument', 'Invoke-NativeWithUtf8Input'],
    String.raw`
try {
  Invoke-NativeWithUtf8Input -FileName 'powershell.exe' -ArgumentList @(
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "Write-Output 'INNER_OUTPUT'; exit 19"
  ) -InputText 'ignored' -FailureMessage 'captured nonzero probe failed' -TimeoutSeconds 10 -CaptureOutput
  Write-Output 'UNSAFE_CONTINUATION_AFTER_NONZERO'
  exit 91
}
catch {
  Write-Output $_.Exception.Message
  exit 17
}
`
  );

  assert.equal(result.status, 17, result.stderr || result.stdout);
  assert.match(result.stdout, /captured nonzero probe failed/);
  assert.doesNotMatch(result.stdout, /UNSAFE_CONTINUATION_AFTER_NONZERO/);
});

test('native outer invocation accepts an intentionally disconnected empty stdin', {
  skip: process.platform !== 'win32'
}, () => {
  const result = runPowerShellFunctionHarness(
    ['Assert-LastExitCode', 'Convert-ToNativeArgument', 'Invoke-NativeWithUtf8Input'],
    String.raw`
Invoke-NativeWithUtf8Input -FileName 'powershell.exe' -ArgumentList @(
  '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'
) -InputText '' -FailureMessage 'empty-stdin probe failed' -TimeoutSeconds 10
Write-Output 'EMPTY_STDIN_OK'
`
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /EMPTY_STDIN_OK/);
});

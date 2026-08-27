'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MANIFEST_FORMAT = 'tm-trusted-production-source-manifest-v1';
const STAGE_FORMAT = 'tm-trusted-production-source-stage-v1';
const RUNTIME_FORMAT = 'tm-trusted-production-source-runtime-v1';
const VERDICT_FORMAT = 'tm-trusted-production-source-verdict-v1';
const ADOPTION_VERDICT_FORMAT = 'tm-trusted-legacy-adoption-verdict-v1';
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const RUNTIME_COMMAND_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_CHILD_OUTPUT_BYTES = 1024 * 1024;
const RUNTIME_UNIT_DRAIN_ATTEMPTS = 100;
const RUNTIME_UNIT_DRAIN_INTERVAL_MS = 100;
const RUNTIME_FETCH_UNIT_PREFIX = 'turingmarket-trusted-runtime-fetch-';
const RUNTIME_BUILD_UNIT_PREFIX = 'turingmarket-trusted-runtime-build-';
const PUBLIC_FETCH_DENY_CIDRS = Object.freeze([
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '::/128',
  '::1/128',
  '::ffff:0:0/96',
  '2001:db8::/32',
  'fc00::/7',
  'fe80::/10',
  'ff00::/8'
]);
const PUBLIC_FETCH_ALLOW_CIDRS = Object.freeze([
  '127.0.0.53/32',
  '127.0.0.54/32'
]);

const REQUIRED_BUNDLE_FILES = Object.freeze([
  'server/migrations/001_legacy_compat_columns.js',
  'server/migrations/002_campaign_business_spine.js',
  'server/migrations/003_campaign_workflow_dispatch_evidence.js',
  'server/migrations/004_knowledge_capacity_observability.js',
  'server/migrations/005_knowledge_custody_projection.js',
  'server/migrations/006_crm_sales_workspace.js',
  'server/migrations/007_knowledge_governance.js',
  'server/migrations/baselines/legacy_v1.js',
  'server/migrations/engines/v1.js',
  'server/migrations/vendor/bcryptjs_v3_0_3.js',
  'server/package-lock.json',
  'server/package.json',
  'server/parser-runtime/package-lock.json',
  'server/parser-runtime/package.json',
  'server/parser-runtime/requirements.lock',
  'server/parser-runtime/pip-cacert.crt',
  'server/parser-runtime/sitecustomize.py',
  'server/extract_document_text.py',
  'server/extract_xlsx_text.py',
  'server/ocr_document_text.py',
  'server/scripts/adopt_legacy_production_v1.js',
  'server/scripts/build_upload_sandbox_runtime.sh',
  'server/scripts/check_cutover_capacity.py',
  'server/scripts/cleanup_stale_migration_gate.sh',
  'server/scripts/parse_upload_sandbox.sh',
  'server/scripts/provision_upload_sandbox_runtime.sh',
  'server/scripts/public_release_guard.sh',
  'server/scripts/sanitization_manifest.json',
  'server/scripts/sanitize_production_shape.js',
  'server/scripts/trusted_parser_runtime_verifier.js',
  'server/scripts/upload_sandbox_self_test.js',
  'server/scripts/verify_campaign_migration_gate.js',
  'server/services/campaign_access_service.js',
  'server/services/campaign_workflow_service.js',
  'server/services/crm_access_service.js',
  'server/services/crm_contract.js',
  'server/services/crm_customer_service.js',
  'server/services/crm_query_service.js',
  'server/services/crm_scope_service.js',
  'server/services/idempotency_service.js',
  'server/services/file_ingest_service.js',
  'server/services/knowledge_service.js',
  'server/services/migration_service.js',
  'server/services/organization_access_service.js',
  'server/services/sqlite_digest_service.js',
  'server/services/upload_sandbox_service.js',
  'server/systemd/turingmarket-gate-cleanup.service',
  'server/systemd/turingmarket-parser.manifest.json',
  'server/systemd/turingmarket-parser.slice',
  'server/systemd/turingmarket-parser@.service'
]);

const EXPECTED_ENTRYPOINTS = Object.freeze({
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

const EXPECTED_MIGRATION_CONTRACT = Object.freeze({
  sourceVersion: 1,
  targetVersion: 7,
  runs: 2,
  deterministicAppendTables: Object.freeze(['activity_log'])
});

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sha256File(filePath) {
  return sha256Bytes(fs.readFileSync(filePath));
}

function normalizedAbsolute(filePath) {
  return path.resolve(filePath);
}

function pathKey(filePath) {
  const normalized = path.normalize(filePath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function pathsEqual(left, right) {
  return pathKey(left) === pathKey(right);
}

function isWithin(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function validateRelativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || path.posix.isAbsolute(value)) {
    throw new Error(`invalid trusted bundle path: ${value}`);
  }
  const normalized = value.normalize('NFC');
  const parts = normalized.split('/');
  if (
    normalized !== value ||
    path.posix.normalize(value) !== value ||
    parts.some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`invalid trusted bundle path: ${value}`);
  }
  return value;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
}

function assertExactKeys(value, expectedKeys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} keys are not exact`);
  }
}

function loadTrustedManifest(manifestPath) {
  const document = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assertPlainObject(document, 'trusted production source manifest');
  assertExactKeys(document, ['format', 'entrypoints', 'migrationContract', 'files'], 'trusted production source manifest');
  if (document.format !== MANIFEST_FORMAT) throw new Error('trusted production source manifest format mismatch');

  assertPlainObject(document.entrypoints, 'trusted production source entrypoints');
  assertExactKeys(document.entrypoints, Object.keys(EXPECTED_ENTRYPOINTS), 'trusted production source entrypoints');
  if (JSON.stringify(document.entrypoints) !== JSON.stringify(EXPECTED_ENTRYPOINTS)) {
    throw new Error('trusted production source entrypoints are not exact');
  }

  assertPlainObject(document.migrationContract, 'trusted migration contract');
  assertExactKeys(document.migrationContract, Object.keys(EXPECTED_MIGRATION_CONTRACT), 'trusted migration contract');
  if (JSON.stringify(document.migrationContract) !== JSON.stringify(EXPECTED_MIGRATION_CONTRACT)) {
    throw new Error('trusted v1-to-v7 migration contract is not exact');
  }

  if (!Array.isArray(document.files)) throw new Error('trusted production source files must be an array');
  const files = [];
  const seen = new Set();
  for (const entry of document.files) {
    assertPlainObject(entry, 'trusted production source file entry');
    const relativePath = validateRelativePath(entry.path);
    assertExactKeys(entry, ['path', 'sha256'], 'trusted production source file entry');
    const sourcePath = relativePath;
    if (seen.has(relativePath)) throw new Error(`duplicate trusted bundle path: ${relativePath}`);
    if (!SHA256_PATTERN.test(entry.sha256 || '')) throw new Error(`invalid trusted SHA-256 for ${relativePath}`);
    seen.add(relativePath);
    files.push(Object.freeze({ path: relativePath, sourcePath, sha256: entry.sha256 }));
  }
  const actualPaths = files.map((entry) => entry.path);
  if (JSON.stringify(actualPaths) !== JSON.stringify(REQUIRED_BUNDLE_FILES)) {
    throw new Error('trusted production source bundle inventory is not exact');
  }
  return Object.freeze({
    format: document.format,
    entrypoints: Object.freeze({ ...document.entrypoints }),
    migrationContract: Object.freeze({
      ...document.migrationContract,
      deterministicAppendTables: Object.freeze([...document.migrationContract.deterministicAppendTables])
    }),
    files: Object.freeze(files)
  });
}

function assertPinnedFile(filePath, expectedSha256, label) {
  if (!SHA256_PATTERN.test(expectedSha256 || '')) throw new Error(`${label} expected SHA-256 is invalid`);
  const metadata = fs.lstatSync(filePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`${label} must be a regular non-symlink file`);
  const actualSha256 = sha256File(filePath);
  if (actualSha256 !== expectedSha256) {
    throw new Error(`${label} SHA-256 mismatch: expected ${expectedSha256}, got ${actualSha256}`);
  }
  return actualSha256;
}

function assertDirectoryNoSymlink(directoryPath, label) {
  const metadata = fs.lstatSync(directoryPath);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
  const absolute = normalizedAbsolute(directoryPath);
  const real = fs.realpathSync.native(directoryPath);
  if (!pathsEqual(absolute, real)) throw new Error(`${label} path is not canonical`);
  return real;
}

function readPinnedCandidateFile(candidateRoot, entry) {
  const rootReal = assertDirectoryNoSymlink(candidateRoot, 'candidate root');
  const segments = entry.sourcePath.split('/');
  let current = rootReal;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const metadata = fs.lstatSync(current);
    if (metadata.isSymbolicLink()) throw new Error(`candidate bundle path contains a symlink: ${entry.sourcePath}`);
    if (index < segments.length - 1 && !metadata.isDirectory()) {
      throw new Error(`candidate bundle parent is not a directory: ${entry.sourcePath}`);
    }
    if (index === segments.length - 1 && (!metadata.isFile() || metadata.nlink !== 1)) {
      throw new Error(`candidate bundle input is not a single-link regular file: ${entry.sourcePath}`);
    }
  }
  if (!isWithin(rootReal, current) || !pathsEqual(fs.realpathSync.native(current), current)) {
    throw new Error(`candidate bundle input escaped its root: ${entry.sourcePath}`);
  }

  const descriptor = fs.openSync(current, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1) throw new Error(`unsafe candidate bundle input: ${entry.sourcePath}`);
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || after.size !== bytes.length) {
      throw new Error(`candidate bundle input changed while reading: ${entry.sourcePath}`);
    }
    const actualSha256 = sha256Bytes(bytes);
    if (actualSha256 !== entry.sha256) {
      throw new Error(`SHA-256 mismatch for ${entry.sourcePath}: expected ${entry.sha256}, got ${actualSha256}`);
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeExclusiveFile(filePath, bytes) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const descriptor = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o400);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(filePath, 0o444);
}

function syncDirectory(directoryPath) {
  if (process.platform === 'win32') return;
  const descriptor = fs.openSync(directoryPath, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function expectedBundleDirectories(manifest) {
  const directories = new Set(['']);
  for (const entry of manifest.files) {
    let current = path.posix.dirname(entry.path);
    while (current !== '.') {
      directories.add(current);
      current = path.posix.dirname(current);
    }
  }
  return directories;
}

function posixMetadataRecord(filePath, displayPath) {
  const metadata = fs.lstatSync(filePath);
  let kind = 'other';
  if (metadata.isSymbolicLink()) kind = 'symlink';
  else if (metadata.isDirectory()) kind = 'directory';
  else if (metadata.isFile()) kind = 'file';
  return Object.freeze({
    path: displayPath,
    kind,
    uid: metadata.uid,
    gid: metadata.gid,
    mode: metadata.mode & 0o777,
    nlink: metadata.nlink
  });
}

function ancestorDirectoryPaths(directoryPath) {
  const paths = [];
  let current = normalizedAbsolute(directoryPath);
  for (;;) {
    paths.unshift(current);
    const parent = path.dirname(current);
    if (pathsEqual(parent, current)) break;
    current = parent;
  }
  return paths;
}

function assertMetadataRecord(record, label) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error(`${label} metadata is missing`);
  }
  if (record.kind !== 'directory' && record.kind !== 'file') {
    throw new Error(`${label} must be a regular non-symlink ${label.includes('file') ? 'file' : 'directory'}`);
  }
  if (!Number.isInteger(record.uid) || !Number.isInteger(record.gid)) {
    throw new Error(`${label} uid/gid metadata is invalid`);
  }
  if (!Number.isInteger(record.mode) || record.mode < 0 || record.mode > 0o777) {
    throw new Error(`${label} mode metadata is invalid`);
  }
  if (!Number.isInteger(record.nlink) || record.nlink < 1) {
    throw new Error(`${label} link metadata is invalid`);
  }
}

function assertTrustedAncestorRecords(ancestors) {
  if (!Array.isArray(ancestors) || ancestors.length === 0) {
    throw new Error('trusted bundle ancestor metadata is missing');
  }
  for (const record of ancestors) {
    const label = `trusted bundle ancestor ${record && record.path ? record.path : '<unknown>'}`;
    assertMetadataRecord(record, label);
    if (record.kind !== 'directory') throw new Error(`${label} must be a real directory`);
    if (record.uid !== 0 || record.gid !== 0) {
      throw new Error(`${label} must have uid/gid 0:0`);
    }
    if ((record.mode & 0o022) !== 0) {
      throw new Error(`${label} must be root-controlled and not writable by GateUser`);
    }
  }
}

function assertTrustedBundlePosixMetadataSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('trusted bundle POSIX metadata snapshot is missing');
  }
  assertTrustedAncestorRecords(snapshot.ancestors);
  if (!Array.isArray(snapshot.directories) || snapshot.directories.length === 0) {
    throw new Error('trusted bundle directory metadata is missing');
  }
  if (!Array.isArray(snapshot.files) || snapshot.files.length === 0) {
    throw new Error('trusted bundle file metadata is missing');
  }

  for (const record of snapshot.directories) {
    const label = record && record.path === ''
      ? 'trusted bundle root'
      : `trusted bundle directory ${record && record.path ? record.path : '<unknown>'}`;
    assertMetadataRecord(record, label);
    if (record.kind !== 'directory') throw new Error(`${label} must be a real directory`);
    if (record.uid !== 0 || record.gid !== 0) throw new Error(`${label} must have uid/gid 0:0`);
    if (record.mode !== 0o555) throw new Error(`${label} must have exact mode 0555`);
  }

  for (const record of snapshot.files) {
    const label = `trusted bundle file ${record && record.path ? record.path : '<unknown>'}`;
    assertMetadataRecord(record, label);
    if (record.kind !== 'file') throw new Error(`${label} must be a regular non-symlink file`);
    if (record.uid !== 0 || record.gid !== 0) throw new Error(`${label} must have uid/gid 0:0`);
    if (record.mode !== 0o444) throw new Error(`${label} must have exact mode 0444`);
    if (record.nlink !== 1) throw new Error(`${label} must have nlink=1`);
  }
}

function captureTrustedBundlePosixMetadata(bundleRoot, manifest) {
  const parent = path.dirname(bundleRoot);
  return Object.freeze({
    ancestors: Object.freeze(ancestorDirectoryPaths(parent).map((entryPath) => (
      posixMetadataRecord(entryPath, entryPath)
    ))),
    directories: Object.freeze([...expectedBundleDirectories(manifest)].sort().map((relativePath) => {
      const directoryPath = relativePath
        ? path.join(bundleRoot, ...relativePath.split('/'))
        : bundleRoot;
      return posixMetadataRecord(directoryPath, relativePath);
    })),
    files: Object.freeze(manifest.files.map((entry) => (
      posixMetadataRecord(path.join(bundleRoot, ...entry.path.split('/')), entry.path)
    )))
  });
}

function assertTrustedBundleAncestorChain(directoryPath) {
  if (process.platform === 'win32') return;
  assertTrustedAncestorRecords(ancestorDirectoryPaths(directoryPath).map((entryPath) => (
    posixMetadataRecord(entryPath, entryPath)
  )));
}

function assertTrustedBundlePosixMetadata(bundleRoot, manifest) {
  if (process.platform === 'win32') return;
  assertTrustedBundlePosixMetadataSnapshot(captureTrustedBundlePosixMetadata(bundleRoot, manifest));
}

function walkBundle(root, current = root, files = [], directories = new Set([''])) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    const metadata = fs.lstatSync(absolute);
    if (metadata.isSymbolicLink()) throw new Error(`trusted bundle contains a symlink: ${relative}`);
    if (metadata.isDirectory()) {
      directories.add(relative);
      walkBundle(root, absolute, files, directories);
    } else if (metadata.isFile() && metadata.nlink === 1) {
      files.push(relative);
    } else {
      throw new Error(`trusted bundle contains an unsafe entry: ${relative}`);
    }
  }
  return { files: files.sort(), directories };
}

function assertBundleOutsideCandidate(candidateRoot, bundleRoot) {
  const candidateReal = assertDirectoryNoSymlink(candidateRoot, 'candidate root');
  const bundleAbsolute = normalizedAbsolute(bundleRoot);
  if (isWithin(candidateReal, bundleAbsolute)) {
    throw new Error('trusted bundle must be outside the candidate directory');
  }
}

function verifyTrustedBundle({ candidateRoot, bundleRoot, manifestPath }) {
  const manifest = loadTrustedManifest(manifestPath);
  assertBundleOutsideCandidate(candidateRoot, bundleRoot);
  const rootReal = assertDirectoryNoSymlink(bundleRoot, 'trusted bundle root');
  const inventory = walkBundle(rootReal);
  const actualFiles = inventory.files;
  const expectedFiles = manifest.files.map((entry) => entry.path).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error('trusted bundle file inventory changed');
  }
  const actualDirectories = [...inventory.directories].sort();
  const expectedDirectories = [...expectedBundleDirectories(manifest)].sort();
  if (JSON.stringify(actualDirectories) !== JSON.stringify(expectedDirectories)) {
    throw new Error('trusted bundle directory inventory changed');
  }
  assertTrustedBundlePosixMetadata(rootReal, manifest);
  for (const entry of manifest.files) {
    const filePath = path.join(rootReal, ...entry.path.split('/'));
    const actualSha256 = sha256File(filePath);
    if (actualSha256 !== entry.sha256) {
      throw new Error(`SHA-256 mismatch for ${entry.path}: expected ${entry.sha256}, got ${actualSha256}`);
    }
  }
  return Object.freeze({ bundleRoot: rootReal, manifest });
}

function stageTrustedBundle({ candidateRoot, bundleRoot, manifestPath }) {
  const manifest = loadTrustedManifest(manifestPath);
  assertBundleOutsideCandidate(candidateRoot, bundleRoot);
  const bundleAbsolute = normalizedAbsolute(bundleRoot);
  const parent = path.dirname(bundleAbsolute);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  assertDirectoryNoSymlink(parent, 'trusted bundle parent');
  assertTrustedBundleAncestorChain(parent);
  // Validate the current candidate on every invocation. An existing immutable
  // bundle must never turn staging into a bypass for newly forged candidate bytes.
  const candidateFiles = manifest.files.map((entry) => ({
    entry,
    bytes: readPinnedCandidateFile(candidateRoot, entry)
  }));
  if (fs.existsSync(bundleAbsolute)) {
    return verifyTrustedBundle({ candidateRoot, bundleRoot: bundleAbsolute, manifestPath });
  }

  const stageName = `.${path.basename(bundleAbsolute)}.next-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  const stageRoot = path.join(parent, stageName);
  fs.mkdirSync(stageRoot, { mode: 0o700 });
  try {
    for (const candidateFile of candidateFiles) {
      writeExclusiveFile(
        path.join(stageRoot, ...candidateFile.entry.path.split('/')),
        candidateFile.bytes
      );
    }
    const directories = [...expectedBundleDirectories(manifest)]
      .filter(Boolean)
      .sort((left, right) => right.split('/').length - left.split('/').length);
    for (const relative of directories) {
      fs.chmodSync(path.join(stageRoot, ...relative.split('/')), 0o555);
    }
    fs.chmodSync(stageRoot, 0o555);
    syncDirectory(stageRoot);
    fs.renameSync(stageRoot, bundleAbsolute);
    syncDirectory(parent);
  } catch (error) {
    fs.rmSync(stageRoot, { recursive: true, force: true });
    throw error;
  }
  return verifyTrustedBundle({ candidateRoot, bundleRoot: bundleAbsolute, manifestPath });
}

function assertPathOutsideCandidate(candidateRoot, targetPath, label) {
  const candidateReal = assertDirectoryNoSymlink(candidateRoot, 'candidate root');
  const targetReal = fs.realpathSync.native(targetPath);
  if (isWithin(candidateReal, targetReal)) throw new Error(`${label} must be outside the candidate directory`);
  return targetReal;
}

function assertDependencyRoot(dependencyRoot, bundleRoot, candidateRoot) {
  const rootReal = assertDirectoryNoSymlink(dependencyRoot, 'trusted dependency root');
  assertPathOutsideCandidate(candidateRoot, rootReal, 'trusted dependency root');
  if (process.platform !== 'win32') {
    const metadata = fs.statSync(rootReal);
    if (metadata.uid !== 0 || metadata.gid !== 0 || (metadata.mode & 0o022) !== 0) {
      throw new Error('trusted dependency root is not root-owned and immutable');
    }
  }
  const installedPackagePath = path.join(rootReal, 'better-sqlite3', 'package.json');
  const installedPackage = JSON.parse(fs.readFileSync(installedPackagePath, 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'server', 'package-lock.json'), 'utf8'));
  const lockedPackage = lock.packages && lock.packages['node_modules/better-sqlite3'];
  if (
    !lockedPackage || !/^sha512-[A-Za-z0-9+/]+=*$/.test(lockedPackage.integrity || '') ||
    installedPackage.name !== 'better-sqlite3' || installedPackage.version !== lockedPackage.version
  ) {
    throw new Error('better-sqlite3 runtime does not match the pinned package lock');
  }
  return rootReal;
}

function assertRuntimeTree(root) {
  const rootReal = assertDirectoryNoSymlink(root, 'trusted runtime root');
  function visit(current) {
    for (const name of fs.readdirSync(current).sort()) {
      const entryPath = path.join(current, name);
      const metadata = fs.lstatSync(entryPath);
      if (metadata.isSymbolicLink()) {
        if (metadata.nlink !== 1) throw new Error('trusted runtime contains a hard-linked symlink');
        const target = fs.readlinkSync(entryPath);
        if (path.isAbsolute(target) || !isWithin(rootReal, path.resolve(current, target))) {
          throw new Error('trusted runtime symlink escaped its root');
        }
        const resolved = fs.realpathSync.native(entryPath);
        if (!isWithin(rootReal, resolved)) throw new Error('trusted runtime symlink escaped its root');
        if (process.platform !== 'win32' && (metadata.uid !== 0 || metadata.gid !== 0)) {
          throw new Error('trusted runtime contains a non-root-owned symlink');
        }
        continue;
      }
      if (!metadata.isDirectory() && !metadata.isFile()) {
        throw new Error('trusted runtime contains an unsafe entry');
      }
      if (metadata.isFile() && metadata.nlink !== 1) {
        throw new Error('trusted runtime contains a hard-linked file');
      }
      if (process.platform !== 'win32' && (
        metadata.uid !== 0 || metadata.gid !== 0 || (metadata.mode & 0o022) !== 0
      )) {
        throw new Error('trusted runtime contains a writable or non-root-owned entry');
      }
      if (metadata.isDirectory()) visit(entryPath);
    }
  }
  const rootMetadata = fs.statSync(rootReal);
  if (process.platform !== 'win32' && (
    rootMetadata.uid !== 0 || rootMetadata.gid !== 0 || (rootMetadata.mode & 0o022) !== 0
  )) {
    throw new Error('trusted runtime root is writable or not root-owned');
  }
  visit(rootReal);
  return rootReal;
}

function hashRuntimeTree(root) {
  const rootReal = assertDirectoryNoSymlink(root, 'runtime digest root');
  const digest = crypto.createHash('sha256');
  function writeField(value) {
    const bytes = Buffer.from(String(value), 'utf8');
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    digest.update(length);
    digest.update(bytes);
  }
  function visit(current, relative) {
    const names = fs.readdirSync(current).sort();
    for (const name of names) {
      const entryPath = path.join(current, name);
      const entryRelative = relative ? `${relative}/${name}` : name;
      const metadata = fs.lstatSync(entryPath);
      if (metadata.isSymbolicLink()) {
        if (metadata.nlink !== 1) throw new Error('runtime digest found a hard-linked symlink');
        const target = fs.readlinkSync(entryPath);
        if (path.isAbsolute(target) || !isWithin(rootReal, path.resolve(current, target))) {
          throw new Error('runtime digest symlink escaped its root');
        }
        const resolved = fs.realpathSync.native(entryPath);
        if (!isWithin(rootReal, resolved)) throw new Error('runtime digest symlink escaped its root');
        writeField('L');
        writeField(entryRelative);
        writeField(target);
      } else if (metadata.isDirectory()) {
        writeField('D');
        writeField(entryRelative);
        visit(entryPath, entryRelative);
      } else if (metadata.isFile()) {
        if (metadata.nlink !== 1) throw new Error('runtime digest found a hard-linked file');
        writeField('F');
        writeField(entryRelative);
        writeField(metadata.size);
        writeField(sha256File(entryPath));
      } else {
        throw new Error('runtime digest found an unsafe entry');
      }
    }
  }
  visit(rootReal, '');
  return digest.digest('hex');
}

function pruneBetterSqliteBuildArtifacts(serverRoot) {
  const releaseRoot = assertDirectoryNoSymlink(
    path.join(serverRoot, 'node_modules', 'better-sqlite3', 'build', 'Release'),
    'better-sqlite3 release root'
  );
  const objectRoot = assertDirectoryNoSymlink(
    path.join(releaseRoot, 'obj.target'),
    'better-sqlite3 object root'
  );
  if (!isWithin(releaseRoot, objectRoot) || pathsEqual(releaseRoot, objectRoot)) {
    throw new Error('better-sqlite3 object root escaped its release root');
  }

  const pairs = [
    ['sqlite3.a', path.join('deps', 'sqlite3.a')],
    ['better_sqlite3.node', 'better_sqlite3.node'],
    ['test_extension.node', 'test_extension.node']
  ].map(([releaseName, objectName]) => ({
    releasePath: path.join(releaseRoot, releaseName),
    objectPath: path.join(objectRoot, objectName)
  }));
  const allowedHardlinks = new Set(pairs.map(({ objectPath }) => pathKey(objectPath)));

  for (const { releasePath, objectPath } of pairs) {
    const releaseMetadata = fs.lstatSync(releasePath);
    const objectMetadata = fs.lstatSync(objectPath);
    if (
      releaseMetadata.isSymbolicLink() || objectMetadata.isSymbolicLink() ||
      !releaseMetadata.isFile() || !objectMetadata.isFile() ||
      releaseMetadata.nlink !== 2 || objectMetadata.nlink !== 2 ||
      releaseMetadata.dev !== objectMetadata.dev || releaseMetadata.ino !== objectMetadata.ino
    ) {
      throw new Error('better-sqlite3 build artifact hardlink contract mismatch');
    }
    if (
      !pathsEqual(fs.realpathSync.native(releasePath), normalizedAbsolute(releasePath)) ||
      !pathsEqual(fs.realpathSync.native(objectPath), normalizedAbsolute(objectPath))
    ) {
      throw new Error('better-sqlite3 build artifact path is not canonical');
    }
  }

  function validateObjectTree(current) {
    for (const name of fs.readdirSync(current)) {
      const entryPath = path.join(current, name);
      const metadata = fs.lstatSync(entryPath);
      if (metadata.isSymbolicLink()) {
        throw new Error('better-sqlite3 object tree contains a symlink');
      }
      if (metadata.isDirectory()) {
        if (!pathsEqual(fs.realpathSync.native(entryPath), normalizedAbsolute(entryPath))) {
          throw new Error('better-sqlite3 object directory path is not canonical');
        }
        validateObjectTree(entryPath);
      } else if (metadata.isFile()) {
        if (metadata.nlink !== 1 && !(metadata.nlink === 2 && allowedHardlinks.has(pathKey(entryPath)))) {
          throw new Error('better-sqlite3 object tree contains an unexpected hard-linked file');
        }
      } else {
        throw new Error('better-sqlite3 object tree contains an unsafe entry');
      }
    }
  }
  validateObjectTree(objectRoot);

  fs.rmSync(objectRoot, { recursive: true, force: false });
  fs.unlinkSync(path.join(releaseRoot, 'sqlite3.a'));
  fs.unlinkSync(path.join(releaseRoot, 'test_extension.node'));
  const runtimeBinary = path.join(releaseRoot, 'better_sqlite3.node');
  const runtimeMetadata = fs.lstatSync(runtimeBinary);
  if (runtimeMetadata.isSymbolicLink() || !runtimeMetadata.isFile() || runtimeMetadata.nlink !== 1) {
    throw new Error('better-sqlite3 runtime binary did not converge to a single-link regular file');
  }
  syncDirectory(releaseRoot);
  return runtimeBinary;
}

function runtimeMarker(manifest, expectedManifestSha256, dependencyTreeSha256) {
  const packageLock = manifest.files.find((entry) => entry.path === 'server/package-lock.json');
  if (!packageLock) throw new Error('trusted package lock is missing');
  if (!SHA256_PATTERN.test(dependencyTreeSha256 || '')) {
    throw new Error('trusted runtime dependency tree digest is invalid');
  }
  return Object.freeze({
    format: RUNTIME_FORMAT,
    manifestSha256: expectedManifestSha256,
    packageLockSha256: packageLock.sha256,
    dependencyTreeSha256
  });
}

function assertTrustedRuntime(options) {
  const verified = verifyTrustedBundle(options);
  const runtimeRoot = assertPathOutsideCandidate(
    options.candidateRoot,
    assertRuntimeTree(options.runtimeRoot),
    'trusted runtime root'
  );
  if (isWithin(verified.bundleRoot, runtimeRoot) || isWithin(runtimeRoot, verified.bundleRoot)) {
    throw new Error('trusted runtime and trusted source bundle must be separate');
  }
  const markerPath = path.join(runtimeRoot, 'runtime-contract.json');
  const actualMarker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  const dependencyRoot = path.join(runtimeRoot, 'server', 'node_modules');
  const dependencyTreeSha256 = hashRuntimeTree(dependencyRoot);
  const expectedMarker = runtimeMarker(
    verified.manifest,
    options.expectedManifestSha256,
    dependencyTreeSha256
  );
  if (JSON.stringify(actualMarker) !== JSON.stringify(expectedMarker)) {
    throw new Error('trusted runtime dependency tree digest mismatch');
  }
  for (const relativePath of ['server/package.json', 'server/package-lock.json']) {
    const expected = verified.manifest.files.find((entry) => entry.path === relativePath);
    assertPinnedFile(path.join(runtimeRoot, ...relativePath.split('/')), expected.sha256, `trusted runtime ${relativePath}`);
  }
  assertDependencyRoot(dependencyRoot, verified.bundleRoot, options.candidateRoot);
  return Object.freeze({ runtimeRoot, dependencyRoot });
}

function assertUnprivilegedBuildIdentity(buildUid, buildGid) {
  const parseIdentity = (value, label) => {
    if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
      throw new Error(`${label} must be a non-root decimal identity`);
    }
    const parsed = Number.parseInt(value, 10);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error(`${label} must be a non-root decimal identity`);
    }
    return parsed;
  };
  return Object.freeze({
    uid: parseIdentity(buildUid, 'build UID'),
    gid: parseIdentity(buildGid, 'build GID')
  });
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function runSystemctl(args, allowFailure = false) {
  const result = spawnSync('/usr/bin/systemctl', args, {
    encoding: 'utf8',
    timeout: 30 * 1000,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_CHILD_OUTPUT_BYTES
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`systemctl failed for trusted runtime unit: ${(result.stderr || '').trim() || `exit ${result.status}`}`);
  }
  return result;
}

function readRuntimeUnitProperty(unitName, property) {
  const result = runSystemctl(
    ['show', `${unitName}.service`, `--property=${property}`, '--value'],
    true
  );
  return result.status === 0 ? (result.stdout || '').trim() : '';
}

function drainRuntimeUnit(unitName) {
  if (!/^turingmarket-trusted-runtime-(?:fetch|build)-[0-9]+-[0-9a-f]{16}$/.test(unitName)) {
    throw new Error('trusted runtime unit name is invalid');
  }
  const controlGroup = readRuntimeUnitProperty(unitName, 'ControlGroup');
  runSystemctl(['kill', '--kill-who=all', '--signal=KILL', `${unitName}.service`], true);
  runSystemctl(['stop', `${unitName}.service`], true);
  if (controlGroup) {
    if (!/^\/(?:[A-Za-z0-9_.:@-]+\/)*[A-Za-z0-9_.:@-]+$/.test(controlGroup)) {
      throw new Error('trusted runtime control group path is invalid');
    }
    const processesPath = path.join('/sys/fs/cgroup', controlGroup.slice(1), 'cgroup.procs');
    let drained = false;
    for (let attempt = 0; attempt < RUNTIME_UNIT_DRAIN_ATTEMPTS; attempt += 1) {
      try {
        drained = fs.readFileSync(processesPath, 'utf8').trim() === '';
      } catch (error) {
        if (error.code === 'ENOENT') drained = true;
        else throw error;
      }
      if (drained) break;
      sleepSync(RUNTIME_UNIT_DRAIN_INTERVAL_MS);
    }
    if (!drained) throw new Error('trusted runtime control group did not drain');
  }
  const mainPid = readRuntimeUnitProperty(unitName, 'MainPID');
  if (mainPid && mainPid !== '0') throw new Error('trusted runtime unit retained a main process');
  runSystemctl(['reset-failed', `${unitName}.service`], true);
}

function assertRuntimeUnitPath(value, label) {
  const absolute = normalizedAbsolute(value);
  if (/\s/.test(absolute) || absolute.includes('\0')) {
    throw new Error(`${label} cannot be represented in a transient unit property`);
  }
  return absolute;
}

function isolatedRuntimeProperties(options, phase) {
  const stageRoot = assertRuntimeUnitPath(options.stageRoot, 'trusted runtime stage root');
  const cacheRoot = assertRuntimeUnitPath(options.cacheRoot, 'trusted runtime cache root');
  const candidateRoot = assertRuntimeUnitPath(options.candidateRoot, 'candidate root');
  const properties = [
    `WorkingDirectory=${assertRuntimeUnitPath(options.cwd, 'trusted runtime working directory')}`,
    'PrivatePIDs=yes',
    'PrivateMounts=yes',
    'PrivateTmp=yes',
    'PrivateDevices=yes',
    'PrivateIPC=yes',
    'ProtectHome=yes',
    'ProtectSystem=strict',
    'ProtectProc=invisible',
    'ProtectHostname=yes',
    'ProtectKernelTunables=yes',
    'ProtectKernelModules=yes',
    'ProtectKernelLogs=yes',
    'ProtectControlGroups=yes',
    'ProtectClock=yes',
    'NoNewPrivileges=yes',
    'CapabilityBoundingSet=',
    'SystemCallArchitectures=native',
    'RestrictSUIDSGID=yes',
    'RestrictRealtime=yes',
    'RestrictNamespaces=yes',
    'LockPersonality=yes',
    'KillMode=control-group',
    'TimeoutStopSec=5s',
    'RuntimeMaxSec=19m',
    'TasksMax=512',
    'MemoryMax=3G',
    'LimitFSIZE=1073741824',
    'UMask=0077',
    `ReadWritePaths=${stageRoot} ${cacheRoot}`,
    `InaccessiblePaths=${candidateRoot} /root /etc/turingmarket /var/lib/turingmarket`
  ];
  if (phase === 'build') {
    properties.push('PrivateNetwork=yes', 'RestrictAddressFamilies=AF_UNIX');
  } else if (phase === 'fetch') {
    properties.push(
      'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6',
      `IPAddressDeny=${PUBLIC_FETCH_DENY_CIDRS.join(' ')}`,
      `IPAddressAllow=${PUBLIC_FETCH_ALLOW_CIDRS.join(' ')}`
    );
  } else {
    throw new Error('trusted runtime unit phase is invalid');
  }
  return properties;
}

function runIsolatedRuntimeCommand(command, args, options, buildIdentity, phase) {
  if (process.platform === 'win32') {
    const result = spawnSync(command, args, {
      cwd: options.cwd,
      encoding: 'utf8',
      env: options.env,
      timeout: RUNTIME_COMMAND_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: MAX_CHILD_OUTPUT_BYTES
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`trusted runtime preparation failed: ${(result.stderr || '').trim() || `exit ${result.status}`}`);
    }
    return;
  }
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
    throw new Error('trusted runtime preparation requires the root controller');
  }
  const unitPrefix = phase === 'fetch' ? RUNTIME_FETCH_UNIT_PREFIX : RUNTIME_BUILD_UNIT_PREFIX;
  const unitName = `${unitPrefix}${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  const environment = Object.entries(options.env).flatMap(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || String(value).includes('\0')) {
      throw new Error('trusted runtime environment is invalid');
    }
    return [`${key}=${value}`];
  });
  const commandArguments = [
    '--quiet',
    '--wait',
    '--pipe',
    `--unit=${unitName}`,
    `--uid=${buildIdentity.uid}`,
    `--gid=${buildIdentity.gid}`,
    '--service-type=exec',
    ...isolatedRuntimeProperties(options, phase).map((property) => `--property=${property}`),
    '--',
    '/usr/bin/env',
    '-i',
    ...environment,
    command,
    ...args
  ];
  let result;
  try {
    result = spawnSync('/usr/bin/systemd-run', commandArguments, {
      encoding: 'utf8',
      timeout: RUNTIME_COMMAND_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: MAX_CHILD_OUTPUT_BYTES
    });
  } finally {
    drainRuntimeUnit(unitName);
  }
  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') throw new Error('trusted runtime preparation exceeded its hard timeout');
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`trusted runtime preparation failed: ${(result.stderr || '').trim() || `exit ${result.status}`}`);
  }
}

function sameNodeIdentity(left, right) {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

function openVerifiedRuntimeNode(entryPath, metadata, flags, label) {
  const descriptor = fs.openSync(entryPath, flags | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(descriptor);
    if (!sameNodeIdentity(metadata, opened)) throw new Error(`${label} identity changed before sealing`);
    return { descriptor, opened };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function assertRuntimeNodeStillBound(entryPath, metadata, label) {
  const current = fs.lstatSync(entryPath);
  if (!sameNodeIdentity(metadata, current)) throw new Error(`${label} identity changed during sealing`);
  return current;
}

function sealRuntimeTree(root, expectedRootIdentity) {
  const rootMetadata = fs.lstatSync(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink() || !sameNodeIdentity(rootMetadata, expectedRootIdentity)) {
    throw new Error('trusted runtime stage root identity changed before sealing');
  }
  const rootNode = openVerifiedRuntimeNode(
    root,
    rootMetadata,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0),
    'trusted runtime root'
  );
  if (process.platform !== 'win32') fs.fchownSync(rootNode.descriptor, 0, 0);
  fs.fchmodSync(rootNode.descriptor, 0o700);
  assertRuntimeNodeStillBound(root, rootMetadata, 'trusted runtime root');

  function visit(current) {
    for (const name of fs.readdirSync(current).sort()) {
      const entryPath = path.join(current, name);
      const metadata = fs.lstatSync(entryPath);
      if (metadata.isSymbolicLink()) {
        if (metadata.nlink !== 1) throw new Error('trusted runtime preparation produced a hard-linked symlink');
        const target = fs.readlinkSync(entryPath);
        if (path.isAbsolute(target) || !isWithin(root, path.resolve(current, target))) {
          throw new Error('trusted runtime preparation produced an escaping symlink');
        }
        const resolved = fs.realpathSync.native(entryPath);
        if (!isWithin(root, resolved)) throw new Error('trusted runtime preparation produced an escaping symlink');
        if (process.platform !== 'win32') fs.lchownSync(entryPath, 0, 0);
        const sealedLink = assertRuntimeNodeStillBound(entryPath, metadata, 'trusted runtime symlink');
        if (process.platform !== 'win32' && (sealedLink.uid !== 0 || sealedLink.gid !== 0)) {
          throw new Error('trusted runtime symlink ownership was not sealed');
        }
      } else if (metadata.isDirectory()) {
        const node = openVerifiedRuntimeNode(
          entryPath,
          metadata,
          fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0),
          'trusted runtime directory'
        );
        try {
          if (process.platform !== 'win32') fs.fchownSync(node.descriptor, 0, 0);
          fs.fchmodSync(node.descriptor, 0o700);
          assertRuntimeNodeStillBound(entryPath, metadata, 'trusted runtime directory');
          visit(entryPath);
          fs.fchmodSync(node.descriptor, 0o555);
          fs.fsyncSync(node.descriptor);
          assertRuntimeNodeStillBound(entryPath, metadata, 'trusted runtime directory');
        } finally {
          fs.closeSync(node.descriptor);
        }
      } else if (metadata.isFile()) {
        if (metadata.nlink !== 1) throw new Error('trusted runtime preparation produced a hard-linked file');
        const node = openVerifiedRuntimeNode(entryPath, metadata, fs.constants.O_RDONLY, 'trusted runtime file');
        try {
          if (!node.opened.isFile() || node.opened.nlink !== 1) {
            throw new Error('trusted runtime file descriptor is unsafe');
          }
          if (process.platform !== 'win32') fs.fchownSync(node.descriptor, 0, 0);
          fs.fchmodSync(node.descriptor, 0o444);
          assertRuntimeNodeStillBound(entryPath, metadata, 'trusted runtime file');
        } finally {
          fs.closeSync(node.descriptor);
        }
      } else {
        throw new Error('trusted runtime preparation produced an unsafe entry');
      }
    }
  }

  try {
    visit(root);
    fs.fchmodSync(rootNode.descriptor, 0o555);
    fs.fsyncSync(rootNode.descriptor);
    assertRuntimeNodeStillBound(root, rootMetadata, 'trusted runtime root');
  } finally {
    fs.closeSync(rootNode.descriptor);
  }
}

function prepareTrustedRuntime(options) {
  assertPinnedRuntime(options);
  const buildIdentity = assertUnprivilegedBuildIdentity(options.buildUid, options.buildGid);
  const verified = verifyTrustedBundle(options);
  const runtimeAbsolute = normalizedAbsolute(options.runtimeRoot);
  assertBundleOutsideCandidate(options.candidateRoot, runtimeAbsolute);
  if (fs.existsSync(runtimeAbsolute)) return assertTrustedRuntime(options);

  const parent = path.dirname(runtimeAbsolute);
  const parentReal = assertDirectoryNoSymlink(parent, 'trusted runtime parent');
  assertPathOutsideCandidate(options.candidateRoot, parentReal, 'trusted runtime parent');
  if (process.platform !== 'win32') {
    const parentMetadata = fs.statSync(parentReal);
    if (parentMetadata.uid !== 0 || parentMetadata.gid !== 0 || (parentMetadata.mode & 0o022) !== 0) {
      throw new Error('trusted runtime parent is not root-owned and immutable');
    }
  }

  const stageRoot = path.join(parentReal, `.${path.basename(runtimeAbsolute)}.next-${process.pid}-${crypto.randomBytes(8).toString('hex')}`);
  const cacheRoot = path.join(parentReal, `.npm-cache-${process.pid}-${crypto.randomBytes(8).toString('hex')}`);
  fs.mkdirSync(path.join(stageRoot, 'server'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(cacheRoot, { mode: 0o700 });
  const stageRootIdentity = fs.lstatSync(stageRoot);
  if (process.platform !== 'win32') {
    fs.chownSync(stageRoot, buildIdentity.uid, buildIdentity.gid);
    fs.chownSync(path.join(stageRoot, 'server'), buildIdentity.uid, buildIdentity.gid);
    fs.chownSync(cacheRoot, buildIdentity.uid, buildIdentity.gid);
  }
  try {
    for (const relativePath of ['server/package.json', 'server/package-lock.json']) {
      const target = path.join(stageRoot, ...relativePath.split('/'));
      fs.copyFileSync(path.join(verified.bundleRoot, ...relativePath.split('/')), target);
      if (process.platform !== 'win32') fs.chownSync(target, buildIdentity.uid, buildIdentity.gid);
    }
    const environment = {
      PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      HOME: stageRoot,
      npm_config_cache: cacheRoot,
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_registry: 'https://registry.npmmirror.com',
      npm_config_replace_registry_host: 'always',
      npm_config_update_notifier: 'false',
      npm_config_progress: 'false'
    };
    const npm = process.platform === 'win32' ? 'npm.cmd' : '/usr/bin/npm';
    const serverRoot = path.join(stageRoot, 'server');
    runIsolatedRuntimeCommand(
      npm,
      ['ci', '--omit=dev', '--ignore-scripts'],
      {
        cwd: serverRoot,
        env: environment,
        stageRoot,
        cacheRoot,
        candidateRoot: options.candidateRoot
      },
      buildIdentity,
      'fetch'
    );
    runIsolatedRuntimeCommand(
      npm,
      ['rebuild', 'better-sqlite3'],
      {
        cwd: serverRoot,
        env: {
          ...environment,
          npm_config_offline: 'true',
          npm_config_nodedir: '/usr'
        },
        stageRoot,
        cacheRoot,
        candidateRoot: options.candidateRoot
      },
      buildIdentity,
      'build'
    );
    pruneBetterSqliteBuildArtifacts(serverRoot);
    const dependencyTreeSha256 = hashRuntimeTree(path.join(serverRoot, 'node_modules'));
    fs.writeFileSync(
      path.join(stageRoot, 'runtime-contract.json'),
      `${JSON.stringify(runtimeMarker(
        verified.manifest,
        options.expectedManifestSha256,
        dependencyTreeSha256
      ))}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o400 }
    );
    sealRuntimeTree(stageRoot, stageRootIdentity);
    if (hashRuntimeTree(path.join(serverRoot, 'node_modules')) !== dependencyTreeSha256) {
      throw new Error('trusted runtime dependency tree digest mismatch after sealing');
    }
    fs.renameSync(stageRoot, runtimeAbsolute);
    syncDirectory(parentReal);
  } catch (error) {
    fs.rmSync(stageRoot, { recursive: true, force: true });
    throw error;
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
  return assertTrustedRuntime(options);
}

function assertSafeDatabaseFile(filePath, label) {
  const absolute = normalizedAbsolute(filePath);
  const metadata = fs.lstatSync(absolute);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1 || metadata.size < 1) {
    throw new Error(`${label} must be a populated single-link regular file`);
  }
  if (!pathsEqual(fs.realpathSync.native(absolute), absolute)) throw new Error(`${label} path is not canonical`);
  return absolute;
}

function databaseSidecarPaths(databasePath) {
  return [`${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`];
}

function rejectDatabaseSidecars(databasePath, label) {
  for (const sidecarPath of databaseSidecarPaths(databasePath)) {
    if (fs.existsSync(sidecarPath)) throw new Error(`${label} has a live SQLite sidecar`);
  }
}

function fsyncDirectory(directoryPath) {
  if (process.platform === 'win32') return;
  const descriptor = fs.openSync(
    directoryPath,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0)
  );
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function identityFields(metadata) {
  const mode = typeof metadata.mode === 'bigint'
    ? Number(metadata.mode & 0o777n)
    : metadata.mode & 0o777;
  return Object.freeze({
    dev: String(metadata.dev),
    ino: String(metadata.ino),
    size: String(metadata.size),
    mtimeNs: String(metadata.mtimeNs),
    ctimeNs: String(metadata.ctimeNs),
    uid: String(metadata.uid),
    gid: String(metadata.gid),
    mode: mode.toString(8).padStart(4, '0'),
    nlink: String(metadata.nlink)
  });
}

function sameIdentityFields(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs &&
    left.uid === right.uid && left.gid === right.gid && left.mode === right.mode &&
    left.nlink === right.nlink;
}

function assertExpectedSourceIdentityMetadata(identity, expectedGid, label) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(String(expectedGid || ''))) {
    throw new Error(`${label} expected gid is invalid`);
  }
  if (
    identity.uid !== '0' || identity.gid !== String(expectedGid) ||
    identity.mode !== '0440' || identity.nlink !== '1'
  ) {
    throw new Error(`${label} must retain uid=0 gid=${expectedGid} mode=0440 nlink=1`);
  }
  return identity;
}

function assertImmutableDatabaseIdentitySnapshot(expected, actual, label) {
  if (!sameIdentityFields(expected, actual) || expected.sha256 !== actual.sha256) {
    throw new Error(`${label} SHA-256/dev/ino identity changed; uid/gid/mode/nlink must remain exact`);
  }
  return actual;
}

function captureStableDatabaseIdentity(filePath, label, { requireReadOnly = true } = {}) {
  const absolute = assertSafeDatabaseFile(filePath, label);
  rejectDatabaseSidecars(absolute, label);
  const descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const beforeMetadata = fs.fstatSync(descriptor, { bigint: true });
    if (!beforeMetadata.isFile() || beforeMetadata.nlink !== 1n) {
      throw new Error(`${label} descriptor is not a single-link regular file`);
    }
    const before = identityFields(beforeMetadata);
    const bytes = fs.readFileSync(descriptor);
    const afterMetadata = fs.fstatSync(descriptor, { bigint: true });
    const after = identityFields(afterMetadata);
    if (!sameIdentityFields(before, after) || after.size !== String(bytes.length)) {
      throw new Error(`${label} changed while hashing`);
    }
    const pathMetadata = fs.statSync(absolute, { bigint: true });
    const pathIdentity = identityFields(pathMetadata);
    if (!sameIdentityFields(after, pathIdentity)) throw new Error(`${label} path identity changed while hashing`);
    if (requireReadOnly && process.platform !== 'win32' && (pathMetadata.mode & 0o222n) !== 0n) {
      throw new Error(`${label} must be immutable before trusted verification`);
    }
    return Object.freeze({
      path: absolute,
      ...after,
      sha256: sha256Bytes(bytes)
    });
  } finally {
    fs.closeSync(descriptor);
  }
}

function captureImmutableDatabaseIdentity(filePath, label) {
  return captureStableDatabaseIdentity(filePath, label, { requireReadOnly: true });
}

function createMutableAdoptionSource(sourcePath, mutableSourcePath, sourceIdentity) {
  const targetPath = normalizedAbsolute(mutableSourcePath);
  const parent = assertDirectoryNoSymlink(path.dirname(targetPath), 'trusted mutable adoption source parent');
  if (pathsEqual(sourcePath, targetPath)) throw new Error('trusted mutable adoption source must differ from its immutable source');
  let created = false;
  try {
    fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
    created = true;
    fs.chmodSync(targetPath, 0o600);
    const descriptor = fs.openSync(
      targetPath,
      fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0)
    );
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fsyncDirectory(parent);
    const copiedIdentity = captureStableDatabaseIdentity(
      targetPath,
      'trusted mutable adoption source',
      { requireReadOnly: false }
    );
    if (copiedIdentity.sha256 !== sourceIdentity.sha256) {
      throw new Error('trusted mutable adoption source SHA-256 does not match its immutable source');
    }

    const Database = require('better-sqlite3');
    const database = new Database(targetPath, { fileMustExist: true });
    try {
      database.pragma('busy_timeout = 5000');
      let journalMode = String(database.pragma('journal_mode', { simple: true }) || '').toLowerCase();
      if (journalMode === 'wal') {
        const checkpoint = database.pragma('wal_checkpoint(TRUNCATE)');
        if (!Array.isArray(checkpoint) || checkpoint.some((entry) => Number(entry.busy) !== 0)) {
          throw new Error('trusted mutable adoption source WAL checkpoint remained busy');
        }
        journalMode = String(database.pragma('journal_mode = DELETE', { simple: true }) || '').toLowerCase();
      }
      if (journalMode !== 'delete') {
        throw new Error(`trusted mutable adoption source journal mode is unsupported: ${journalMode || 'unknown'}`);
      }
      if (database.pragma('quick_check', { simple: true }) !== 'ok') {
        throw new Error('trusted mutable adoption source quick_check failed after journal normalization');
      }
      if (database.pragma('foreign_key_check').length !== 0) {
        throw new Error('trusted mutable adoption source foreign_key_check failed after journal normalization');
      }
    } finally {
      database.close();
    }
    rejectDatabaseSidecars(targetPath, 'trusted normalized mutable adoption source');
    const normalizedDescriptor = fs.openSync(
      targetPath,
      fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0)
    );
    try {
      fs.fsyncSync(normalizedDescriptor);
    } finally {
      fs.closeSync(normalizedDescriptor);
    }
    fsyncDirectory(parent);
    return captureStableDatabaseIdentity(
      targetPath,
      'trusted normalized mutable adoption source',
      { requireReadOnly: false }
    );
  } catch (error) {
    if (created) {
      try {
        fs.unlinkSync(targetPath);
        fsyncDirectory(parent);
      } catch (cleanupError) {
        const failure = new Error(`trusted mutable adoption source cleanup failed: ${cleanupError.message}`);
        failure.cause = error;
        throw failure;
      }
    }
    throw error;
  }
}

function retireMutableAdoptionSource(identity) {
  rejectDatabaseSidecars(identity.path, 'trusted mutable adoption source');
  const current = captureStableDatabaseIdentity(
    identity.path,
    'trusted mutable adoption source before retirement',
    { requireReadOnly: false }
  );
  assertImmutableDatabaseIdentitySnapshot(identity, current, 'trusted mutable adoption source');
  const parent = path.dirname(identity.path);
  fs.unlinkSync(identity.path);
  fsyncDirectory(parent);
}

function assertDatabaseIdentity(expected, label) {
  const actual = captureImmutableDatabaseIdentity(expected.path, label);
  return assertImmutableDatabaseIdentitySnapshot(expected, actual, label);
}

function assertDigestReport(digest, label) {
  assertPlainObject(digest, `${label} digest`);
  if (!SHA256_PATTERN.test(digest.topologySha256 || '') || !SHA256_PATTERN.test(digest.logicalSha256 || '')) {
    throw new Error(`${label} digest hashes are invalid`);
  }
  if (!Array.isArray(digest.fts)) throw new Error(`${label} FTS digest is missing`);
  for (const entry of digest.fts) {
    if (
      !entry || typeof entry.virtualName !== 'string' || !entry.virtualName ||
      !Number.isSafeInteger(entry.rowCount) || entry.rowCount < 0 ||
      !SHA256_PATTERN.test(entry.sha256 || '')
    ) {
      throw new Error(`${label} FTS digest entry is invalid`);
    }
  }
}

function assertPinnedRuntime(options) {
  assertPinnedFile(__filename, options.expectedSelfSha256, 'trusted production source gate');
  assertPinnedFile(options.manifestPath, options.expectedManifestSha256, 'trusted production source manifest');
  const manifest = loadTrustedManifest(options.manifestPath);
  if (options.expectedVerifierSha256 !== undefined) {
    if (!SHA256_PATTERN.test(options.expectedVerifierSha256 || '')) {
      throw new Error('trusted migration verifier expected SHA-256 is invalid');
    }
    const verifier = manifest.files.find((entry) => entry.path === manifest.entrypoints.verifier);
    if (!verifier || verifier.sha256 !== options.expectedVerifierSha256) {
      throw new Error('trusted migration verifier SHA-256 does not match the pinned deploy contract');
    }
  }
  return manifest;
}

function trustedEntrypoint(manifest, key, label) {
  const relativePath = manifest.entrypoints[key];
  const entry = manifest.files.find((candidate) => candidate.path === relativePath);
  if (!entry) throw new Error(`${label} is missing from the trusted bundle manifest`);
  return entry;
}

function trustedBundleModule(manifest, verified, relativePath, label) {
  const entry = manifest.files.find((candidate) => candidate.path === relativePath);
  if (!entry) throw new Error(`${label} is missing from the trusted bundle manifest`);
  const modulePath = path.join(verified.bundleRoot, ...entry.path.split('/'));
  assertPinnedFile(modulePath, entry.sha256, label);
  delete require.cache[require.resolve(modulePath)];
  return { entry, modulePath, value: require(modulePath) };
}

function classifyTrustedDatabase(manifest, verified, sourcePath) {
  const migration = trustedBundleModule(
    manifest,
    verified,
    'server/services/migration_service.js',
    'trusted migration service'
  ).value;
  const verifier = trustedBundleModule(
    manifest,
    verified,
    manifest.entrypoints.verifier,
    'trusted migration verifier registry'
  ).value;
  if (!migration || typeof migration.classifyDatabase !== 'function'
      || typeof migration.defaultMigrations !== 'function'
      || !verifier || !Array.isArray(verifier.REGISTERED_MIGRATIONS)) {
    throw new Error('trusted migration service interface is invalid');
  }
  const migrations = [...migration.defaultMigrations(), ...verifier.REGISTERED_MIGRATIONS];
  if (
    migrations.length !== manifest.migrationContract.targetVersion ||
    migrations.some((entry, index) => !entry || entry.version !== index + 1)
  ) {
    throw new Error('trusted migration registry does not match the pinned target version');
  }
  const Database = require('better-sqlite3');
  const database = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    if (database.pragma('quick_check', { simple: true }) !== 'ok') {
      throw new Error('trusted source quick_check failed before classification');
    }
    if (database.pragma('foreign_key_check').length !== 0) {
      throw new Error('trusted source foreign_key_check failed before classification');
    }
    return migration.classifyDatabase(database, {
      rootDir: path.join(verified.bundleRoot, 'server'),
      migrations
    });
  } finally {
    database.close();
  }
}

function prepareTrustedLegacySource({
  manifest,
  verified,
  sourcePath,
  sourceIdentity,
  outputPath,
  mutableSourcePath = null,
  privateStagePath = null
}) {
  const mutableSourceIdentity = mutableSourcePath
    ? createMutableAdoptionSource(sourcePath, mutableSourcePath, sourceIdentity)
    : null;
  try {
    const adoptionSourcePath = mutableSourceIdentity ? mutableSourceIdentity.path : sourcePath;
    const adoptionSourceSha256 = mutableSourceIdentity ? mutableSourceIdentity.sha256 : sourceIdentity.sha256;
    const classification = classifyTrustedDatabase(manifest, verified, adoptionSourcePath);
    if (classification.status === 'managed' && [1, 6, 7].includes(classification.currentVersion)) {
      return Object.freeze({
        effectiveSourcePath: sourcePath,
        report: Object.freeze({
          format: ADOPTION_VERDICT_FORMAT,
          applied: false,
          sourceVersion: classification.currentVersion,
          targetVersion: classification.currentVersion,
          sourceSha256: sourceIdentity.sha256,
          outputSha256: sourceIdentity.sha256,
          baseTableCount: null,
          baseRowCount: null,
          repairs: null
        })
      });
    }
    if (classification.status !== 'legacy' || classification.currentVersion !== 0) {
      throw new Error(`trusted legacy adoption requires exact version 0 or managed version 1/6/7; got ${classification.status}:${classification.currentVersion}`);
    }
    if (fs.existsSync(outputPath) || databaseSidecarPaths(outputPath).some((candidate) => fs.existsSync(candidate))) {
      throw new Error('trusted legacy adoption output must not exist before execution');
    }
    const adoptionEntry = trustedEntrypoint(manifest, 'legacyProductionV1Adoption', 'trusted legacy adoption');
    const adoptionPath = path.join(verified.bundleRoot, ...adoptionEntry.path.split('/'));
    assertPinnedFile(adoptionPath, adoptionEntry.sha256, 'trusted legacy adoption');
    delete require.cache[require.resolve(adoptionPath)];
    const adoption = require(adoptionPath);
    if (!adoption || typeof adoption.adoptLegacyProductionV1 !== 'function') {
      throw new Error('trusted legacy adoption interface is invalid');
    }
    const result = adoption.adoptLegacyProductionV1({
      sourcePath: adoptionSourcePath,
      outputPath,
      privateStagePath,
      expectedSourceSha256: adoptionSourceSha256
    });
    if (
      result.format !== adoption.REPORT_VERSION || result.sourceVersion !== 0 || result.targetVersion !== 1 ||
      result.sourceSha256 !== adoptionSourceSha256 || !SHA256_PATTERN.test(result.outputSha256 || '') ||
      !Number.isSafeInteger(result.baseTableCount) || result.baseTableCount < 1 ||
      !Number.isSafeInteger(result.baseRowCount) || result.baseRowCount < 1 ||
      !result.repairs || result.repairs.ftsRebuilt !== true
    ) {
      throw new Error('trusted legacy adoption verdict is incomplete');
    }
    const outputIdentity = captureStableDatabaseIdentity(
      outputPath,
      'trusted adopted version 1 output',
      { requireReadOnly: false }
    );
    if (outputIdentity.sha256 !== result.outputSha256) {
      throw new Error('trusted legacy adoption output SHA-256 does not match its verdict');
    }
    return Object.freeze({
      effectiveSourcePath: outputPath,
      report: Object.freeze({
        format: ADOPTION_VERDICT_FORMAT,
        applied: true,
        sourceVersion: 0,
        targetVersion: 1,
        sourceSha256: sourceIdentity.sha256,
        outputSha256: result.outputSha256,
        baseTableCount: result.baseTableCount,
        baseRowCount: result.baseRowCount,
        repairs: result.repairs
      })
    });
  } finally {
    if (mutableSourceIdentity) retireMutableAdoptionSource(mutableSourceIdentity);
  }
}

function adoptIfLegacyTrustedSource(options) {
  const manifest = assertPinnedRuntime(options);
  const verified = verifyTrustedBundle(options);
  const sourcePath = assertSafeDatabaseFile(options.sourcePath, 'trusted live adoption source');
  assertPathOutsideCandidate(options.candidateRoot, sourcePath, 'trusted live adoption source');
  const outputPath = normalizedAbsolute(options.outputPath);
  const outputParent = assertDirectoryNoSymlink(path.dirname(outputPath), 'trusted live adoption output parent');
  assertPathOutsideCandidate(options.candidateRoot, outputParent, 'trusted live adoption output parent');
  if (pathsEqual(sourcePath, outputPath)) throw new Error('trusted live adoption source and output must differ');
  const privateStagePath = normalizedAbsolute(options.privateStagePath);
  if (!pathsEqual(path.dirname(privateStagePath), outputParent)) {
    throw new Error('trusted live adoption private stage must share the output parent');
  }
  const mutableSourcePath = `${privateStagePath}.source`;
  if ([sourcePath, outputPath, privateStagePath].some((candidate) => pathsEqual(candidate, mutableSourcePath))) {
    throw new Error('trusted live adoption mutable source path is not distinct');
  }
  if (!SHA256_PATTERN.test(options.expectedSourceSha256 || '')) {
    throw new Error('trusted live adoption expected source SHA-256 is invalid');
  }
  const sourceIdentity = captureStableDatabaseIdentity(
    sourcePath,
    'trusted live adoption source',
    { requireReadOnly: false }
  );
  if (sourceIdentity.sha256 !== options.expectedSourceSha256) {
    throw new Error('trusted live adoption source SHA-256 does not match the quiesced snapshot');
  }
  const prepared = prepareTrustedLegacySource({
    manifest,
    verified,
    sourcePath,
    sourceIdentity,
    outputPath,
    mutableSourcePath,
    privateStagePath
  });
  const sourceAfter = captureStableDatabaseIdentity(
    sourcePath,
    'trusted live adoption source after execution',
    { requireReadOnly: false }
  );
  assertImmutableDatabaseIdentitySnapshot(sourceIdentity, sourceAfter, 'trusted live adoption source');
  verifyTrustedBundle(options);
  return prepared.report;
}

function runTrustedMigrationVerification({ manifest, verified, sanitizedPath, workDir }) {
  const verifierEntry = trustedEntrypoint(manifest, 'verifier', 'trusted migration verifier');
  const verifierPath = path.join(verified.bundleRoot, ...verifierEntry.path.split('/'));
  assertPinnedFile(verifierPath, verifierEntry.sha256, 'trusted migration verifier');
  delete require.cache[require.resolve(verifierPath)];
  const verifier = require(verifierPath);
  if (!verifier || typeof verifier.verifySanitizedMigrationCopy !== 'function') {
    throw new Error('trusted migration verifier interface is invalid');
  }
  const report = verifier.verifySanitizedMigrationCopy({ sanitizedPath, workDir });
  if (
    report.format !== verifier.PRESERVATION_REPORT_VERSION ||
    report.sourceVersion !== EXPECTED_MIGRATION_CONTRACT.sourceVersion ||
    report.targetVersion !== EXPECTED_MIGRATION_CONTRACT.targetVersion ||
    report.runs !== EXPECTED_MIGRATION_CONTRACT.runs ||
    report.preMigrationRestoreVerified !== true ||
    report.legacyPreservationVerified !== true ||
    !Number.isSafeInteger(report.legacyTableCount) || report.legacyTableCount < 1 ||
    !Number.isSafeInteger(report.legacyRowCount) || report.legacyRowCount < 1
  ) {
    throw new Error('trusted v1-to-v7 migration preservation verdict is incomplete');
  }
  assertDigestReport(report.preMigration, 'pre-migration');
  assertDigestReport(report.postMigration, 'post-migration');
  return report;
}

function verifyTrustedManagedTargetNoop({ manifest, verified, sanitizedPath, workDir }) {
  const classification = classifyTrustedDatabase(manifest, verified, sanitizedPath);
  if (classification.status !== 'managed'
      || classification.currentVersion !== manifest.migrationContract.targetVersion) {
    throw new Error('trusted managed no-op source is not the exact pinned target version');
  }
  const sqliteDigest = trustedBundleModule(
    manifest,
    verified,
    'server/services/sqlite_digest_service.js',
    'trusted SQLite digest service'
  ).value;
  const migration = trustedBundleModule(
    manifest,
    verified,
    'server/services/migration_service.js',
    'trusted managed no-op migration service'
  ).value;
  const verifier = trustedBundleModule(
    manifest,
    verified,
    manifest.entrypoints.verifier,
    'trusted managed no-op migration registry'
  ).value;
  const adoptionEntry = trustedEntrypoint(manifest, 'legacyProductionV1Adoption', 'trusted legacy adoption');
  const adoption = trustedBundleModule(
    manifest,
    verified,
    adoptionEntry.path,
    'trusted legacy adoption FTS contract'
  ).value;
  if (!sqliteDigest || typeof sqliteDigest.databaseDigest !== 'function'
      || typeof sqliteDigest.verifyKnowledgeChunksFtsIntegrity !== 'function'
      || !adoption || !adoption.FTS_MANIFEST
      || !migration || typeof migration.runMigrations !== 'function'
      || typeof migration.defaultMigrations !== 'function'
      || typeof migration.classifyDatabase !== 'function'
      || !verifier || !Array.isArray(verifier.REGISTERED_MIGRATIONS)) {
    throw new Error('trusted managed no-op verification interface is invalid');
  }
  const migrations = [...migration.defaultMigrations(), ...verifier.REGISTERED_MIGRATIONS];
  if (
    migrations.length !== manifest.migrationContract.targetVersion ||
    migrations.some((entry, index) => !entry || entry.version !== index + 1)
  ) {
    throw new Error('trusted managed no-op migration registry is not exact');
  }
  const trustedWorkRoot = assertDirectoryNoSymlink(workDir, 'trusted managed no-op work directory');
  const runDirectory = fs.mkdtempSync(path.join(trustedWorkRoot, 'tm-managed-target-noop-'));
  fs.chmodSync(runDirectory, 0o700);
  const mutablePath = path.join(runDirectory, 'managed-target.db');
  const Database = require('better-sqlite3');
  let database = null;
  let preMigration;
  let postMigration;
  try {
    fs.copyFileSync(sanitizedPath, mutablePath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(mutablePath, 0o600);
    database = new Database(mutablePath, { fileMustExist: true });
    try {
      if (database.pragma('quick_check', { simple: true }) !== 'ok') {
        throw new Error('trusted managed no-op quick_check failed');
      }
      if (database.pragma('foreign_key_check').length !== 0) {
        throw new Error('trusted managed no-op foreign_key_check failed');
      }
      sqliteDigest.verifyKnowledgeChunksFtsIntegrity(
        database,
        adoption.FTS_MANIFEST,
        { checkMainIntegrity: false }
      );
      preMigration = sqliteDigest.databaseDigest(database, adoption.FTS_MANIFEST);
      try {
        for (let run = 0; run < EXPECTED_MIGRATION_CONTRACT.runs; run += 1) {
          migration.runMigrations(database, {
            rootDir: path.join(verified.bundleRoot, 'server'),
            registeredMigrations: verifier.REGISTERED_MIGRATIONS
          });
          const afterRun = migration.classifyDatabase(database, {
            rootDir: path.join(verified.bundleRoot, 'server'),
            migrations
          });
          if (afterRun.status !== 'managed'
              || afterRun.currentVersion !== manifest.migrationContract.targetVersion) {
            throw new Error('migration classification changed');
          }
        }
      } catch (error) {
        throw new Error(`managed target migration no-op changed database: ${error.message}`);
      }
      if (database.pragma('quick_check', { simple: true }) !== 'ok'
          || database.pragma('foreign_key_check').length !== 0) {
        throw new Error('managed target migration no-op changed database integrity');
      }
      sqliteDigest.verifyKnowledgeChunksFtsIntegrity(
        database,
        adoption.FTS_MANIFEST,
        { checkMainIntegrity: false }
      );
      postMigration = sqliteDigest.databaseDigest(database, adoption.FTS_MANIFEST);
    } finally {
      database.close();
      database = null;
    }
    if (JSON.stringify(preMigration) !== JSON.stringify(postMigration)) {
      throw new Error('managed target migration no-op changed database digest');
    }
    const freezeDigest = (digest) => Object.freeze({
      topologySha256: digest.topologySha256,
      logicalSha256: digest.logicalSha256,
      fts: Object.freeze(digest.fts.map((entry) => Object.freeze({ ...entry })))
    });
    return Object.freeze({
      verificationMode: 'managed-v7-noop',
      sourceVersion: manifest.migrationContract.targetVersion,
      targetVersion: manifest.migrationContract.targetVersion,
      runs: EXPECTED_MIGRATION_CONTRACT.runs,
      legacyTableCount: null,
      legacyRowCount: null,
      preMigrationRestoreVerified: false,
      legacyPreservationVerified: false,
      preMigration: freezeDigest(preMigration),
      postMigration: freezeDigest(postMigration)
    });
  } finally {
    if (database) database.close();
    fs.rmSync(runDirectory, { recursive: true, force: true });
  }
}

function sanitizeAndVerifyTrustedSource(options) {
  const manifest = assertPinnedRuntime(options);
  const verified = verifyTrustedBundle(options);
  assertDependencyRoot(options.dependencyRoot, verified.bundleRoot, options.candidateRoot);
  const sourcePath = assertSafeDatabaseFile(options.sourcePath, 'trusted immutable source copy');
  assertPathOutsideCandidate(options.candidateRoot, sourcePath, 'trusted immutable source copy');

  const sanitizedPath = normalizedAbsolute(options.sanitizedPath);
  if (fs.existsSync(sanitizedPath) || databaseSidecarPaths(sanitizedPath).some((candidate) => fs.existsSync(candidate))) {
    throw new Error('trusted sanitizer output must not exist before trusted sanitizer execution');
  }
  const outputParent = assertDirectoryNoSymlink(path.dirname(sanitizedPath), 'trusted sanitizer output parent');
  assertPathOutsideCandidate(options.candidateRoot, outputParent, 'trusted sanitizer output parent');
  if (pathsEqual(sourcePath, sanitizedPath)) throw new Error('trusted source and sanitizer output must differ');

  const workDir = normalizedAbsolute(options.workDir);
  if (!fs.existsSync(workDir)) {
    const workParent = assertDirectoryNoSymlink(path.dirname(workDir), 'trusted work parent');
    assertPathOutsideCandidate(options.candidateRoot, workParent, 'trusted work parent');
    fs.mkdirSync(workDir, { mode: 0o700 });
  }
  assertDirectoryNoSymlink(workDir, 'trusted work directory');
  assertPathOutsideCandidate(options.candidateRoot, workDir, 'trusted work directory');

  const sourceIdentity = captureImmutableDatabaseIdentity(sourcePath, 'trusted immutable source copy');
  if (process.platform !== 'win32') {
    assertExpectedSourceIdentityMetadata(
      sourceIdentity,
      options.expectedSourceGid,
      'trusted immutable source copy'
    );
  }
  const preparedSource = prepareTrustedLegacySource({
    manifest,
    verified,
    sourcePath,
    sourceIdentity,
    outputPath: path.join(workDir, 'trusted-adopted-v1.db'),
    mutableSourcePath: path.join(workDir, 'trusted-legacy-mutable-source.db')
  });
  if (preparedSource.report.applied) fs.chmodSync(preparedSource.effectiveSourcePath, 0o444);
  const effectiveSourceIdentity = preparedSource.report.applied
    ? captureImmutableDatabaseIdentity(preparedSource.effectiveSourcePath, 'trusted adopted version 1 source')
    : sourceIdentity;
  const sanitizerEntry = trustedEntrypoint(manifest, 'sanitizer', 'trusted sanitizer');
  const policyEntry = trustedEntrypoint(manifest, 'sanitizationManifest', 'trusted sanitization manifest');
  const sanitizerPath = path.join(verified.bundleRoot, ...sanitizerEntry.path.split('/'));
  const policyPath = path.join(verified.bundleRoot, ...policyEntry.path.split('/'));
  assertPinnedFile(sanitizerPath, sanitizerEntry.sha256, 'trusted sanitizer');
  assertPinnedFile(policyPath, policyEntry.sha256, 'trusted sanitization manifest');

  delete require.cache[require.resolve(sanitizerPath)];
  const sanitizer = require(sanitizerPath);
  if (!sanitizer || typeof sanitizer.sanitizeProductionShape !== 'function') {
    throw new Error('trusted sanitizer interface is invalid');
  }
  const sanitization = sanitizer.sanitizeProductionShape({
    sourcePath: preparedSource.effectiveSourcePath,
    outputPath: sanitizedPath,
    manifestPath: policyPath,
    journalPath: path.join(workDir, 'trusted-sanitizer.run.json')
  });
  const effectiveSourceVersion = preparedSource.report.targetVersion;
  if (
    sanitization.format !== sanitizer.REPORT_VERSION ||
    ![EXPECTED_MIGRATION_CONTRACT.sourceVersion, EXPECTED_MIGRATION_CONTRACT.targetVersion]
      .includes(effectiveSourceVersion) ||
    sanitization.sourceVersion !== effectiveSourceVersion ||
    !Number.isSafeInteger(sanitization.tableCount) || sanitization.tableCount < 1 ||
    !Number.isSafeInteger(sanitization.rowCount) || sanitization.rowCount < 1 ||
    !SHA256_PATTERN.test(sanitization.outputSha256 || '')
  ) {
    throw new Error('trusted sanitizer verdict is incomplete');
  }

  assertDatabaseIdentity(sourceIdentity, 'trusted immutable source copy after sanitization');
  assertDatabaseIdentity(effectiveSourceIdentity, 'trusted effective source after sanitization');
  fs.chmodSync(sanitizedPath, 0o444);
  const sanitizedIdentity = captureImmutableDatabaseIdentity(sanitizedPath, 'trusted sanitized output');
  if (sanitization.outputSha256 !== sanitizedIdentity.sha256) {
    throw new Error('trusted sanitizer output SHA-256 report does not match its immutable output');
  }
  const verifiedBeforeMigrationVerifier = verifyTrustedBundle(options);

  const report = effectiveSourceVersion === EXPECTED_MIGRATION_CONTRACT.sourceVersion
    ? Object.freeze({
      verificationMode: 'v1-to-v7-migration',
      ...runTrustedMigrationVerification({
        manifest,
        verified: verifiedBeforeMigrationVerifier,
        sanitizedPath,
        workDir
      }),
      preMigrationRestoreVerified: true,
      legacyPreservationVerified: true
    })
    : verifyTrustedManagedTargetNoop({
      manifest,
      verified: verifiedBeforeMigrationVerifier,
      sanitizedPath,
      workDir
    });
  assertDatabaseIdentity(sourceIdentity, 'trusted immutable source copy after migration rehearsal');
  assertDatabaseIdentity(effectiveSourceIdentity, 'trusted effective source after migration rehearsal');
  assertDatabaseIdentity(sanitizedIdentity, 'trusted sanitized output after migration rehearsal');
  verifyTrustedBundle(options);
  return Object.freeze({
    format: VERDICT_FORMAT,
    sourceSha256: sourceIdentity.sha256,
    sourceDevice: sourceIdentity.dev,
    sourceInode: sourceIdentity.ino,
    sanitizedSourceSha256: sanitizedIdentity.sha256,
    sanitizedSourceDevice: sanitizedIdentity.dev,
    sanitizedSourceInode: sanitizedIdentity.ino,
    trustedSanitizerSha256: sanitizerEntry.sha256,
    trustedSanitizationManifestSha256: policyEntry.sha256,
    databaseAdoption: preparedSource.report,
    verificationMode: report.verificationMode,
    sourceVersion: report.sourceVersion,
    targetVersion: report.targetVersion,
    runs: report.runs,
    legacyTableCount: report.legacyTableCount,
    legacyRowCount: report.legacyRowCount,
    preMigrationRestoreVerified: report.preMigrationRestoreVerified,
    legacyPreservationVerified: report.legacyPreservationVerified,
    preMigration: report.preMigration,
    postMigration: report.postMigration
  });
}

function parseCli(argv) {
  const command = argv[0];
  if (!['stage', 'prepare-runtime', 'sanitize-and-verify', 'adopt-if-legacy'].includes(command)) {
    throw new Error('trusted gate command is invalid');
  }
  const options = {};
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key || !key.startsWith('--') || value === undefined) throw new Error('trusted gate arguments must be --key value pairs');
    const normalized = key.slice(2).replace(/-([a-z])/g, (_match, character) => character.toUpperCase());
    if (Object.prototype.hasOwnProperty.call(options, normalized)) throw new Error(`duplicate trusted gate argument ${key}`);
    options[normalized] = value;
  }
  return { command, options };
}

function required(options, key) {
  if (typeof options[key] !== 'string' || !options[key]) throw new Error(`--${key.replace(/[A-Z]/g, (value) => `-${value.toLowerCase()}`)} is required`);
  return options[key];
}

function cliOptions(raw) {
  return {
    candidateRoot: required(raw, 'candidateRoot'),
    bundleRoot: required(raw, 'bundleRoot'),
    manifestPath: required(raw, 'manifest'),
    expectedSelfSha256: required(raw, 'expectedSelfSha256'),
    expectedManifestSha256: required(raw, 'expectedManifestSha256'),
    expectedVerifierSha256: required(raw, 'expectedVerifierSha256')
  };
}

function main(argv) {
  const parsed = parseCli(argv);
  const common = cliOptions(parsed.options);
  assertPinnedRuntime(common);
  let report;
  if (parsed.command === 'stage') {
    const staged = stageTrustedBundle(common);
    report = {
      format: STAGE_FORMAT,
      bundleRoot: staged.bundleRoot,
      manifestSha256: common.expectedManifestSha256,
      verifierSha256: common.expectedVerifierSha256
    };
  } else if (parsed.command === 'prepare-runtime') {
    const runtime = prepareTrustedRuntime({
      ...common,
      runtimeRoot: required(parsed.options, 'runtimeRoot'),
      buildUid: required(parsed.options, 'buildUid'),
      buildGid: required(parsed.options, 'buildGid')
    });
    report = {
      format: RUNTIME_FORMAT,
      runtimeRoot: runtime.runtimeRoot,
      dependencyRoot: runtime.dependencyRoot,
      manifestSha256: common.expectedManifestSha256
    };
  } else if (parsed.command === 'sanitize-and-verify') {
    report = sanitizeAndVerifyTrustedSource({
      ...common,
      dependencyRoot: required(parsed.options, 'dependencyRoot'),
      sourcePath: required(parsed.options, 'source'),
      expectedSourceGid: required(parsed.options, 'expectedSourceGid'),
      sanitizedPath: required(parsed.options, 'sanitizedSource'),
      workDir: required(parsed.options, 'workDir')
    });
  } else {
    report = adoptIfLegacyTrustedSource({
      ...common,
      sourcePath: required(parsed.options, 'source'),
      outputPath: required(parsed.options, 'output'),
      privateStagePath: required(parsed.options, 'privateStage'),
      expectedSourceSha256: required(parsed.options, 'expectedSourceSha256')
    });
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`trusted production source gate failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  ADOPTION_VERDICT_FORMAT,
  MANIFEST_FORMAT,
  RUNTIME_FORMAT,
  STAGE_FORMAT,
  VERDICT_FORMAT,
  assertPinnedFile,
  loadTrustedManifest,
  pruneBetterSqliteBuildArtifacts,
  prepareTrustedRuntime,
  stageTrustedBundle,
  adoptIfLegacyTrustedSource,
  sanitizeAndVerifyTrustedSource,
  captureImmutableDatabaseIdentity,
  assertExpectedSourceIdentityMetadata,
  assertImmutableDatabaseIdentitySnapshot,
  assertTrustedBundlePosixMetadataSnapshot,
  verifyTrustedBundle,
  runTrustedMigrationVerification
};

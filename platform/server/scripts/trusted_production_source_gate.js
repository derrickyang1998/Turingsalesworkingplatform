'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MANIFEST_FORMAT = 'tm-trusted-production-source-manifest-v1';
const STAGE_FORMAT = 'tm-trusted-production-source-stage-v1';
const RUNTIME_FORMAT = 'tm-trusted-production-source-runtime-v1';
const VERDICT_FORMAT = 'tm-trusted-production-source-verdict-v1';
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const RUNTIME_COMMAND_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_CHILD_OUTPUT_BYTES = 1024 * 1024;

const REQUIRED_BUNDLE_FILES = Object.freeze([
  'server/migrations/001_legacy_compat_columns.js',
  'server/migrations/002_campaign_business_spine.js',
  'server/migrations/003_campaign_workflow_dispatch_evidence.js',
  'server/migrations/004_knowledge_capacity_observability.js',
  'server/migrations/005_knowledge_custody_projection.js',
  'server/migrations/006_crm_sales_workspace.js',
  'server/migrations/baselines/legacy_v1.js',
  'server/migrations/engines/v1.js',
  'server/migrations/vendor/bcryptjs_v3_0_3.js',
  'server/package-lock.json',
  'server/package.json',
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
  'server/services/sqlite_digest_service.js'
]);

const EXPECTED_ENTRYPOINTS = Object.freeze({
  sanitizer: 'server/scripts/sanitize_production_shape.js',
  sanitizationManifest: 'server/scripts/sanitization_manifest.json',
  verifier: 'server/scripts/verify_campaign_migration_gate.js'
});

const EXPECTED_MIGRATION_CONTRACT = Object.freeze({
  sourceVersion: 1,
  targetVersion: 6,
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
    throw new Error('trusted v1-to-v6 migration contract is not exact');
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
    for (const name of fs.readdirSync(current)) {
      const entryPath = path.join(current, name);
      const metadata = fs.lstatSync(entryPath);
      if (metadata.isSymbolicLink()) {
        const resolved = fs.realpathSync.native(entryPath);
        if (!isWithin(rootReal, resolved)) throw new Error('trusted runtime symlink escaped its root');
        continue;
      }
      if (!metadata.isDirectory() && !metadata.isFile()) {
        throw new Error('trusted runtime contains an unsafe entry');
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

function runtimeMarker(manifest, expectedManifestSha256) {
  const packageLock = manifest.files.find((entry) => entry.path === 'server/package-lock.json');
  if (!packageLock) throw new Error('trusted package lock is missing');
  return Object.freeze({
    format: RUNTIME_FORMAT,
    manifestSha256: expectedManifestSha256,
    packageLockSha256: packageLock.sha256
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
  const expectedMarker = runtimeMarker(verified.manifest, options.expectedManifestSha256);
  if (JSON.stringify(actualMarker) !== JSON.stringify(expectedMarker)) {
    throw new Error('trusted runtime contract marker mismatch');
  }
  for (const relativePath of ['server/package.json', 'server/package-lock.json']) {
    const expected = verified.manifest.files.find((entry) => entry.path === relativePath);
    assertPinnedFile(path.join(runtimeRoot, ...relativePath.split('/')), expected.sha256, `trusted runtime ${relativePath}`);
  }
  const dependencyRoot = path.join(runtimeRoot, 'server', 'node_modules');
  assertDependencyRoot(dependencyRoot, verified.bundleRoot, options.candidateRoot);
  return Object.freeze({ runtimeRoot, dependencyRoot });
}

function runRuntimeCommand(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env,
    timeout: RUNTIME_COMMAND_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_CHILD_OUTPUT_BYTES
  });
  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') throw new Error('trusted runtime preparation exceeded its hard timeout');
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`trusted runtime preparation failed: ${(result.stderr || '').trim() || `exit ${result.status}`}`);
  }
}

function sealRuntimeTree(root) {
  function visit(current) {
    for (const name of fs.readdirSync(current)) {
      const entryPath = path.join(current, name);
      const metadata = fs.lstatSync(entryPath);
      if (metadata.isSymbolicLink()) continue;
      if (metadata.isDirectory()) {
        visit(entryPath);
        if (process.platform !== 'win32') fs.chownSync(entryPath, 0, 0);
        fs.chmodSync(entryPath, 0o555);
      } else if (metadata.isFile()) {
        if (process.platform !== 'win32') fs.chownSync(entryPath, 0, 0);
        fs.chmodSync(entryPath, 0o444);
      } else {
        throw new Error('trusted runtime preparation produced an unsafe entry');
      }
    }
  }
  visit(root);
  if (process.platform !== 'win32') fs.chownSync(root, 0, 0);
  fs.chmodSync(root, 0o555);
}

function prepareTrustedRuntime(options) {
  assertPinnedRuntime(options);
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
  try {
    for (const relativePath of ['server/package.json', 'server/package-lock.json']) {
      fs.copyFileSync(
        path.join(verified.bundleRoot, ...relativePath.split('/')),
        path.join(stageRoot, ...relativePath.split('/'))
      );
    }
    const environment = {
      PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      HOME: stageRoot,
      npm_config_cache: cacheRoot,
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_update_notifier: 'false'
    };
    const npm = process.platform === 'win32' ? 'npm.cmd' : '/usr/bin/npm';
    const serverRoot = path.join(stageRoot, 'server');
    runRuntimeCommand(npm, ['ci', '--omit=dev', '--ignore-scripts'], { cwd: serverRoot, env: environment });
    runRuntimeCommand(npm, ['rebuild', 'better-sqlite3'], { cwd: serverRoot, env: environment });
    fs.writeFileSync(
      path.join(stageRoot, 'runtime-contract.json'),
      `${JSON.stringify(runtimeMarker(verified.manifest, options.expectedManifestSha256))}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o400 }
    );
    sealRuntimeTree(stageRoot);
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

function captureImmutableDatabaseIdentity(filePath, label) {
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
    if (process.platform !== 'win32' && (pathMetadata.mode & 0o222n) !== 0n) {
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
    throw new Error('trusted v1-to-v6 migration preservation verdict is incomplete');
  }
  assertDigestReport(report.preMigration, 'pre-migration');
  assertDigestReport(report.postMigration, 'post-migration');
  return report;
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
    sourcePath,
    outputPath: sanitizedPath,
    manifestPath: policyPath,
    journalPath: path.join(workDir, 'trusted-sanitizer.run.json')
  });
  if (
    sanitization.format !== sanitizer.REPORT_VERSION ||
    sanitization.sourceVersion !== EXPECTED_MIGRATION_CONTRACT.sourceVersion ||
    !Number.isSafeInteger(sanitization.tableCount) || sanitization.tableCount < 1 ||
    !Number.isSafeInteger(sanitization.rowCount) || sanitization.rowCount < 1 ||
    !SHA256_PATTERN.test(sanitization.outputSha256 || '')
  ) {
    throw new Error('trusted sanitizer verdict is incomplete');
  }

  assertDatabaseIdentity(sourceIdentity, 'trusted immutable source copy after sanitization');
  fs.chmodSync(sanitizedPath, 0o444);
  const sanitizedIdentity = captureImmutableDatabaseIdentity(sanitizedPath, 'trusted sanitized output');
  if (sanitization.outputSha256 !== sanitizedIdentity.sha256) {
    throw new Error('trusted sanitizer output SHA-256 report does not match its immutable output');
  }
  const verifiedBeforeMigrationVerifier = verifyTrustedBundle(options);

  const report = runTrustedMigrationVerification({
    manifest,
    verified: verifiedBeforeMigrationVerifier,
    sanitizedPath,
    workDir
  });
  assertDatabaseIdentity(sourceIdentity, 'trusted immutable source copy after migration rehearsal');
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
    sourceVersion: report.sourceVersion,
    targetVersion: report.targetVersion,
    runs: report.runs,
    legacyTableCount: report.legacyTableCount,
    legacyRowCount: report.legacyRowCount,
    preMigrationRestoreVerified: true,
    legacyPreservationVerified: true,
    preMigration: report.preMigration,
    postMigration: report.postMigration
  });
}

function parseCli(argv) {
  const command = argv[0];
  if (!['stage', 'prepare-runtime', 'sanitize-and-verify'].includes(command)) {
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
      runtimeRoot: required(parsed.options, 'runtimeRoot')
    });
    report = {
      format: RUNTIME_FORMAT,
      runtimeRoot: runtime.runtimeRoot,
      dependencyRoot: runtime.dependencyRoot,
      manifestSha256: common.expectedManifestSha256
    };
  } else {
    report = sanitizeAndVerifyTrustedSource({
      ...common,
      dependencyRoot: required(parsed.options, 'dependencyRoot'),
      sourcePath: required(parsed.options, 'source'),
      expectedSourceGid: required(parsed.options, 'expectedSourceGid'),
      sanitizedPath: required(parsed.options, 'sanitizedSource'),
      workDir: required(parsed.options, 'workDir')
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
  MANIFEST_FORMAT,
  RUNTIME_FORMAT,
  STAGE_FORMAT,
  VERDICT_FORMAT,
  assertPinnedFile,
  loadTrustedManifest,
  prepareTrustedRuntime,
  stageTrustedBundle,
  sanitizeAndVerifyTrustedSource,
  captureImmutableDatabaseIdentity,
  assertExpectedSourceIdentityMetadata,
  assertImmutableDatabaseIdentitySnapshot,
  assertTrustedBundlePosixMetadataSnapshot,
  verifyTrustedBundle,
  runTrustedMigrationVerification
};

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CACHE_KEY = /^[0-9a-f]{64}$/;
const SHARD_NAME = /^[0-9a-f]{2}$/;
const ARTIFACT_FILE = /^([0-9a-f]{64})\.pptx$/;
const STAGE_FILE = /^\.([0-9a-f]{64})\.[0-9a-f]{32}\.stage$/;
const ATTEMPT_DIRECTORY = /^campaign-ppt-([0-9a-f]{64})-/;
const PPT_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;
const DEFAULT_MAX_SCAN_ENTRIES = 10_000;
const PRIVATE_DIRECTORY_MODE = 0o700;
const NO_FOLLOW = process.platform === 'win32' || typeof fs.constants.O_NOFOLLOW !== 'number'
  ? 0
  : fs.constants.O_NOFOLLOW;

class PptArtifactStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PptArtifactStoreError';
    this.code = code;
  }
}

function storeError(code, message) {
  return new PptArtifactStoreError(code, message);
}

function normalizeCacheKey(value) {
  if (typeof value !== 'string' || !CACHE_KEY.test(value)) {
    throw new TypeError('invalid PPT artifact cache key');
  }
  return value;
}

function normalizeSourcePath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new TypeError('PPT artifact source path must be absolute');
  }
  return path.resolve(value);
}

function validatePrivateDirectory(directoryPath) {
  const stat = fs.lstatSync(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw storeError(
      'PPT_ARTIFACT_STORAGE_FAILED',
      'PPT artifact storage must be a real directory.'
    );
  }
  if (process.platform !== 'win32') {
    const realPath = fs.realpathSync(directoryPath);
    if (realPath !== directoryPath) {
      throw storeError(
        'PPT_ARTIFACT_STORAGE_FAILED',
        'PPT artifact storage cannot use a symbolic-link path.'
      );
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw storeError(
        'PPT_ARTIFACT_STORAGE_FAILED',
        'PPT artifact storage must be owned by the running process user.'
      );
    }
    if ((stat.mode & 0o077) !== 0) {
      throw storeError(
        'PPT_ARTIFACT_STORAGE_FAILED',
        'PPT artifact storage must not be readable or writable by other users.'
      );
    }
  }
  return stat;
}

function ensureCacheDirectory(rootDir) {
  try {
    fs.mkdirSync(rootDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    if (process.platform !== 'win32') {
      fs.chmodSync(rootDir, PRIVATE_DIRECTORY_MODE);
    }
    validatePrivateDirectory(rootDir);
  } catch (error) {
    if (error instanceof PptArtifactStoreError) throw error;
    throw storeError(
      'PPT_ARTIFACT_STORAGE_FAILED',
      'PPT artifact storage could not be initialized.'
    );
  }
}

function shardDirectoryFor(rootDir, cacheKey) {
  const normalized = normalizeCacheKey(cacheKey);
  return path.join(rootDir, normalized.slice(0, 2));
}

function ensureShardDirectory(rootDir, cacheKey) {
  const shardDir = shardDirectoryFor(rootDir, cacheKey);
  const existed = fs.existsSync(shardDir);
  ensureCacheDirectory(shardDir);
  if (!existed) fsyncParentDirectory(rootDir);
  return shardDir;
}

function existingShardDirectory(rootDir, cacheKey) {
  const shardDir = shardDirectoryFor(rootDir, cacheKey);
  try {
    validatePrivateDirectory(shardDir);
    return shardDir;
  } catch (error) {
    if (isMissing(error)) return null;
    if (error instanceof PptArtifactStoreError) throw error;
    throw storeError(
      'PPT_ARTIFACT_STORAGE_FAILED',
      'PPT artifact shard could not be inspected.'
    );
  }
}

function artifactPathFor(rootDir, cacheKey) {
  const normalized = normalizeCacheKey(cacheKey);
  return path.join(shardDirectoryFor(rootDir, normalized), `${normalized}.pptx`);
}

function isMissing(error) {
  return Boolean(error) && error.code === 'ENOENT';
}

function fsyncParentDirectory(directoryPath) {
  if (process.platform === 'win32') return;
  let fd;
  try {
    fd = fs.openSync(directoryPath, fs.constants.O_RDONLY | NO_FOLLOW);
    fs.fsyncSync(fd);
  } catch {
    throw storeError(
      'PPT_ARTIFACT_STORAGE_FAILED',
      'PPT artifact directory metadata could not be synchronized.'
    );
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function fsyncFile(filePath) {
  if (process.platform === 'win32') return;
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | NO_FOLLOW);
    fs.fsyncSync(fd);
  } catch {
    throw storeError(
      'PPT_ARTIFACT_STORAGE_FAILED',
      'PPT artifact file metadata could not be synchronized.'
    );
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function removeEmptyDirectory(directoryPath, parentPath) {
  try {
    validatePrivateDirectory(directoryPath);
    fs.rmdirSync(directoryPath);
    fsyncParentDirectory(parentPath);
    return true;
  } catch (error) {
    if (isMissing(error) || ['ENOTEMPTY', 'EEXIST'].includes(error && error.code)) return false;
    if (error instanceof PptArtifactStoreError) throw error;
    throw storeError(
      'PPT_ARTIFACT_STORAGE_FAILED',
      'PPT artifact directory could not be removed safely.'
    );
  }
}

function normalizeCacheKeyList(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const unique = new Set();
  for (const key of value) unique.add(normalizeCacheKey(key));
  return [...unique];
}

function normalizeJanitorOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('PPT artifact janitor options are required');
  }
  const orphanMinAgeMs = options.orphanMinAgeMs === undefined
    ? DEFAULT_ORPHAN_MIN_AGE_MS
    : options.orphanMinAgeMs;
  const nowMs = options.nowMs === undefined ? Date.now() : options.nowMs;
  const maxScanEntries = options.maxScanEntries === undefined
    ? DEFAULT_MAX_SCAN_ENTRIES
    : options.maxScanEntries;
  if (!Number.isSafeInteger(orphanMinAgeMs) || orphanMinAgeMs < DEFAULT_ORPHAN_MIN_AGE_MS) {
    throw new TypeError('PPT artifact orphan minimum age is invalid');
  }
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError('PPT artifact janitor clock is invalid');
  }
  if (!Number.isSafeInteger(maxScanEntries) || maxScanEntries < 1 || maxScanEntries > 100_000) {
    throw new TypeError('PPT artifact janitor scan limit is invalid');
  }
  let attemptRootDir = null;
  if (options.attemptRootDir !== undefined) {
    if (typeof options.attemptRootDir !== 'string' || !path.isAbsolute(options.attemptRootDir)) {
      throw new TypeError('PPT artifact janitor attemptRootDir must be absolute');
    }
    attemptRootDir = path.resolve(options.attemptRootDir);
  }
  return Object.freeze({
    liveCacheKeys: normalizeCacheKeyList(options.liveCacheKeys, 'liveCacheKeys'),
    retainedCacheKeys: normalizeCacheKeyList(options.retainedCacheKeys, 'retainedCacheKeys'),
    expiringCacheKeys: normalizeCacheKeyList(options.expiringCacheKeys, 'expiringCacheKeys'),
    attemptRootDir,
    orphanMinAgeMs,
    nowMs,
    maxScanEntries
  });
}

function isOldEnough(stat, nowMs, minimumAgeMs) {
  return Number.isFinite(stat.mtimeMs) && nowMs - stat.mtimeMs >= minimumAgeMs;
}

function unlinkRegularFile(filePath, parentPath) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (isMissing(error)) return false;
    throw storeError('PPT_ARTIFACT_STORAGE_FAILED', 'PPT artifact could not be inspected for cleanup.');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw storeError(
      'PPT_ARTIFACT_INTEGRITY_FAILED',
      'PPT artifact cleanup accepts only regular single-link files.'
    );
  }
  try {
    fs.unlinkSync(filePath);
    fsyncParentDirectory(parentPath);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw storeError('PPT_ARTIFACT_STORAGE_FAILED', 'PPT artifact could not be deleted.');
  }
}

function removeTreeNoFollow(targetPath, parentPath, budget) {
  const resolved = path.resolve(targetPath);
  if (path.dirname(resolved) !== parentPath) {
    throw storeError('PPT_ARTIFACT_INTEGRITY_FAILED', 'PPT attempt cleanup escaped its root.');
  }
  const removeNode = (nodePath) => {
    budget.count += 1;
    if (budget.count > budget.limit) {
      throw storeError('PPT_ARTIFACT_STORAGE_FAILED', 'PPT attempt cleanup exceeded its bounded scan.');
    }
    const stat = fs.lstatSync(nodePath);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      for (const name of fs.readdirSync(nodePath).sort()) {
        const childPath = path.resolve(nodePath, name);
        if (path.dirname(childPath) !== nodePath) {
          throw storeError('PPT_ARTIFACT_INTEGRITY_FAILED', 'PPT attempt cleanup escaped its directory.');
        }
        removeNode(childPath);
      }
      fs.rmdirSync(nodePath);
      fsyncParentDirectory(path.dirname(nodePath));
      return;
    }
    fs.unlinkSync(nodePath);
    fsyncParentDirectory(path.dirname(nodePath));
  };
  try {
    removeNode(resolved);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    if (error instanceof PptArtifactStoreError) throw error;
    throw storeError('PPT_ARTIFACT_STORAGE_FAILED', 'PPT attempt directory could not be removed safely.');
  }
}

function validateFileDescriptor(fd, expectedBytes, maxBytes) {
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || stat.size < PPT_HEADER.length || stat.size > maxBytes) {
    throw storeError(
      'PPT_ARTIFACT_INVALID',
      'PPT artifact must be a bounded nonempty presentation file.'
    );
  }
  if (expectedBytes !== undefined && stat.size !== expectedBytes) {
    throw storeError(
      'PPT_ARTIFACT_INTEGRITY_FAILED',
      'PPT artifact size no longer matches retained evidence.'
    );
  }
  return stat;
}

function openReadOnlyNoFollow(filePath) {
  try {
    return fs.openSync(filePath, fs.constants.O_RDONLY | NO_FOLLOW);
  } catch (error) {
    if (NO_FOLLOW !== 0 && ['EINVAL', 'ENOSYS', 'ENOTSUP'].includes(error && error.code)) {
      return fs.openSync(filePath, fs.constants.O_RDONLY);
    }
    throw error;
  }
}

function assertDescriptorMatchesPath(fd, filePath, expectedStat) {
  let pathStat;
  try {
    pathStat = fs.lstatSync(filePath);
  } catch (error) {
    if (isMissing(error)) {
      throw storeError('PPT_ARTIFACT_NOT_FOUND', 'PPT artifact was not found.');
    }
    throw storeError('PPT_ARTIFACT_STORAGE_FAILED', 'PPT artifact could not be inspected.');
  }
  if (!pathStat.isFile() || pathStat.isSymbolicLink() ||
    pathStat.size !== expectedStat.size ||
    pathStat.dev !== expectedStat.dev ||
    pathStat.ino !== expectedStat.ino) {
    throw storeError(
      'PPT_ARTIFACT_INTEGRITY_FAILED',
      'PPT artifact changed while it was being verified.'
    );
  }
  const descriptorStat = fs.fstatSync(fd);
  if (
    descriptorStat.size !== expectedStat.size ||
    descriptorStat.dev !== expectedStat.dev ||
    descriptorStat.ino !== expectedStat.ino
  ) {
    throw storeError(
      'PPT_ARTIFACT_INTEGRITY_FAILED',
      'PPT artifact descriptor changed while it was being verified.'
    );
  }
}

function openVerifiedPptArtifact(filePath, { maxBytes, expectedBytes, expectedSha256 } = {}) {
  let fd;
  try {
    fd = openReadOnlyNoFollow(filePath);
    const stat = validateFileDescriptor(fd, expectedBytes, maxBytes);
    assertDescriptorMatchesPath(fd, filePath, stat);
    const header = Buffer.alloc(PPT_HEADER.length);
    if (fs.readSync(fd, header, 0, header.length, 0) !== PPT_HEADER.length || !header.equals(PPT_HEADER)) {
      throw storeError(
        'PPT_ARTIFACT_INVALID',
        'Generated artifact is not a valid PPTX container.'
      );
    }
    const digest = crypto.createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (offset < stat.size) {
      const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
      if (read <= 0) {
        throw storeError(
          'PPT_ARTIFACT_INTEGRITY_FAILED',
          'PPT artifact changed while it was being verified.'
        );
      }
      digest.update(buffer.subarray(0, read));
      offset += read;
    }
    const sha256 = digest.digest('hex');
    if (expectedSha256 !== undefined && sha256 !== expectedSha256) {
      throw storeError(
        'PPT_ARTIFACT_INTEGRITY_FAILED',
        'PPT artifact hash no longer matches retained evidence.'
      );
    }
    assertDescriptorMatchesPath(fd, filePath, stat);
    return Object.freeze({ fd, filePath, stat, bytes: stat.size, sha256 });
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    if (error instanceof PptArtifactStoreError) throw error;
    if (isMissing(error)) {
      throw storeError('PPT_ARTIFACT_NOT_FOUND', 'PPT artifact was not found.');
    }
    if (error && error.code === 'ELOOP') {
      throw storeError(
        'PPT_ARTIFACT_INTEGRITY_FAILED',
        'PPT artifact cannot be read through a symbolic link.'
      );
    }
    throw storeError('PPT_ARTIFACT_STORAGE_FAILED', 'PPT artifact could not be verified.');
  }
}

function verifyPptArtifact(filePath, options) {
  const artifact = openVerifiedPptArtifact(filePath, options);
  try {
    return Object.freeze({ bytes: artifact.bytes, sha256: artifact.sha256 });
  } finally {
    try { fs.closeSync(artifact.fd); } catch {}
  }
}

function copyVerifiedDescriptorToStage(artifact, stagePath) {
  let stageFd;
  try {
    stageFd = fs.openSync(
      stagePath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600
    );
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    while (position < artifact.bytes) {
      const read = fs.readSync(
        artifact.fd,
        buffer,
        0,
        Math.min(buffer.length, artifact.bytes - position),
        position
      );
      if (read <= 0) {
        throw storeError(
          'PPT_ARTIFACT_INTEGRITY_FAILED',
          'PPT artifact changed while it was being staged.'
        );
      }
      let written = 0;
      while (written < read) {
        const count = fs.writeSync(stageFd, buffer, written, read - written, position + written);
        if (count <= 0) {
          throw storeError(
            'PPT_ARTIFACT_STORAGE_FAILED',
            'PPT artifact could not be staged for publication.'
          );
        }
        written += count;
      }
      position += read;
    }
    assertDescriptorMatchesPath(artifact.fd, artifact.filePath, artifact.stat);
    fs.fsyncSync(stageFd);
  } catch (error) {
    if (error instanceof PptArtifactStoreError) throw error;
    throw storeError('PPT_ARTIFACT_STORAGE_FAILED', 'PPT artifact could not be staged for publication.');
  } finally {
    if (stageFd !== undefined) {
      try { fs.closeSync(stageFd); } catch {}
    }
  }
}

function createPptArtifactStore(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('PPT artifact store options are required');
  }
  if (typeof options.rootDir !== 'string' || !path.isAbsolute(options.rootDir)) {
    throw new TypeError('PPT artifact store rootDir must be absolute');
  }
  const rootDir = path.resolve(options.rootDir);
  const maxBytes = options.maxBytes === undefined ? DEFAULT_MAX_BYTES : options.maxBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < PPT_HEADER.length || maxBytes > DEFAULT_MAX_BYTES) {
    throw new TypeError('PPT artifact store maxBytes is invalid');
  }
  ensureCacheDirectory(rootDir);

  function publishFromFile(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new TypeError('PPT artifact publish input is invalid');
    }
    const cacheKey = normalizeCacheKey(input.cacheKey);
    ensureCacheDirectory(rootDir);
    const sourcePath = normalizeSourcePath(input.sourcePath);
    let shardDir;
    let targetPath;
    let stagePath;
    let staged = false;
    let source;
    try {
      try {
        source = openVerifiedPptArtifact(sourcePath, { maxBytes });
        shardDir = ensureShardDirectory(rootDir, cacheKey);
        targetPath = artifactPathFor(rootDir, cacheKey);
        stagePath = path.join(
          shardDir,
          `.${cacheKey}.${crypto.randomBytes(16).toString('hex')}.stage`
        );
        staged = true;
        copyVerifiedDescriptorToStage(source, stagePath);
      } catch (error) {
        if (error instanceof PptArtifactStoreError) throw error;
        throw storeError(
          'PPT_ARTIFACT_STORAGE_FAILED',
          'PPT artifact could not be staged for publication.'
        );
      } finally {
        if (source) {
          try { fs.closeSync(source.fd); } catch {}
          source = null;
        }
      }
      const artifact = verifyPptArtifact(stagePath, { maxBytes });
      try {
        fs.linkSync(stagePath, targetPath);
      } catch (error) {
        if (error && error.code === 'EEXIST') {
          throw storeError(
            'PPT_ARTIFACT_EXISTS',
            'PPT artifact publication already has a retained cache key.'
          );
        }
        throw storeError(
          'PPT_ARTIFACT_STORAGE_FAILED',
          'PPT artifact could not be atomically published.'
        );
      }
      fsyncFile(targetPath);
      fs.unlinkSync(stagePath);
      staged = false;
      fsyncParentDirectory(shardDir);
      fsyncParentDirectory(rootDir);
      return Object.freeze({ cacheKey, ...artifact });
    } finally {
      if (staged) {
        try {
          fs.unlinkSync(stagePath);
          fsyncParentDirectory(shardDir);
        } catch {}
      }
    }
  }

  function readVerified(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new TypeError('PPT artifact read input is invalid');
    }
    const cacheKey = normalizeCacheKey(input.cacheKey);
    ensureCacheDirectory(rootDir);
    if (!existingShardDirectory(rootDir, cacheKey)) {
      throw storeError('PPT_ARTIFACT_NOT_FOUND', 'PPT artifact was not found.');
    }
    if (typeof input.sha256 !== 'string' || !CACHE_KEY.test(input.sha256)) {
      throw new TypeError('PPT artifact hash is invalid');
    }
    if (!Number.isSafeInteger(input.bytes) || input.bytes < PPT_HEADER.length || input.bytes > maxBytes) {
      throw new TypeError('PPT artifact bytes are invalid');
    }
    const filePath = artifactPathFor(rootDir, cacheKey);
    const artifact = verifyPptArtifact(filePath, {
      maxBytes,
      expectedBytes: input.bytes,
      expectedSha256: input.sha256
    });
    return Object.freeze({ filePath, cacheKey, ...artifact });
  }

  function readExisting(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new TypeError('PPT artifact read input is invalid');
    }
    const cacheKey = normalizeCacheKey(input.cacheKey);
    ensureCacheDirectory(rootDir);
    if (!existingShardDirectory(rootDir, cacheKey)) {
      throw storeError('PPT_ARTIFACT_NOT_FOUND', 'PPT artifact was not found.');
    }
    const filePath = artifactPathFor(rootDir, cacheKey);
    const artifact = verifyPptArtifact(filePath, { maxBytes });
    return Object.freeze({ filePath, cacheKey, ...artifact });
  }

  function remove(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new TypeError('PPT artifact delete input is invalid');
    }
    ensureCacheDirectory(rootDir);
    const cacheKey = normalizeCacheKey(input.cacheKey);
    const shardDir = existingShardDirectory(rootDir, cacheKey);
    if (!shardDir) return false;
    const removed = unlinkRegularFile(artifactPathFor(rootDir, cacheKey), shardDir);
    removeEmptyDirectory(shardDir, rootDir);
    return removed;
  }

  function runJanitor(input) {
    const options = normalizeJanitorOptions(input);
    if (options.attemptRootDir === rootDir) {
      throw new TypeError('PPT attempt root must be separate from the artifact cache');
    }
    ensureCacheDirectory(rootDir);
    const live = new Set(options.liveCacheKeys);
    const retained = new Set(options.retainedCacheKeys);
    const expiring = [];
    for (const cacheKey of options.expiringCacheKeys) {
      if (live.has(cacheKey)) {
        expiring.push(Object.freeze({ cacheKey, state: 'protected' }));
        continue;
      }
      const removed = remove({ cacheKey });
      expiring.push(Object.freeze({ cacheKey, state: removed ? 'removed' : 'missing' }));
    }

    const protectedKeys = new Set([...live, ...retained]);
    for (const item of expiring) {
      if (item.state === 'protected') protectedKeys.add(item.cacheKey);
    }
    const orphanArtifactKeysRemoved = [];
    let orphanStagesRemoved = 0;
    let orphanAttemptsRemoved = 0;
    let scannedEntries = 0;
    let scanTruncated = false;
    const consumeBudget = () => {
      scannedEntries += 1;
      if (scannedEntries > options.maxScanEntries) {
        scanTruncated = true;
        return false;
      }
      return true;
    };

    outer: for (const shardName of fs.readdirSync(rootDir).sort()) {
      if (!consumeBudget()) break;
      const shardPath = path.join(rootDir, shardName);
      const shardStat = fs.lstatSync(shardPath);
      if (!SHARD_NAME.test(shardName) || !shardStat.isDirectory() || shardStat.isSymbolicLink()) {
        throw storeError(
          'PPT_ARTIFACT_INTEGRITY_FAILED',
          'PPT artifact cache contains an invalid shard entry.'
        );
      }
      validatePrivateDirectory(shardPath);
      for (const name of fs.readdirSync(shardPath).sort()) {
        if (!consumeBudget()) break outer;
        const filePath = path.join(shardPath, name);
        const stat = fs.lstatSync(filePath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
          throw storeError(
            'PPT_ARTIFACT_INTEGRITY_FAILED',
            'PPT artifact shard contains a non-regular entry.'
          );
        }
        const artifactMatch = ARTIFACT_FILE.exec(name);
        const stageMatch = STAGE_FILE.exec(name);
        const cacheKey = artifactMatch && artifactMatch[1] || stageMatch && stageMatch[1];
        if (!cacheKey || cacheKey.slice(0, 2) !== shardName) {
          throw storeError(
            'PPT_ARTIFACT_INTEGRITY_FAILED',
            'PPT artifact shard contains an invalid filename.'
          );
        }
        if (protectedKeys.has(cacheKey) || !isOldEnough(
          stat,
          options.nowMs,
          options.orphanMinAgeMs
        )) {
          continue;
        }
        if (artifactMatch) {
          if (remove({ cacheKey })) orphanArtifactKeysRemoved.push(cacheKey);
        } else if (unlinkRegularFile(filePath, shardPath)) {
          orphanStagesRemoved += 1;
        }
      }
      if (fs.existsSync(shardPath)) removeEmptyDirectory(shardPath, rootDir);
    }

    if (!scanTruncated && options.attemptRootDir) {
      ensureCacheDirectory(options.attemptRootDir);
      const attemptBudget = { count: 0, limit: options.maxScanEntries };
      for (const name of fs.readdirSync(options.attemptRootDir).sort()) {
        if (!consumeBudget()) break;
        const match = ATTEMPT_DIRECTORY.exec(name);
        if (!match) continue;
        const cacheKey = match[1];
        const attemptPath = path.join(options.attemptRootDir, name);
        const stat = fs.lstatSync(attemptPath);
        if (live.has(cacheKey) || !isOldEnough(
          stat,
          options.nowMs,
          options.orphanMinAgeMs
        )) {
          continue;
        }
        if (removeTreeNoFollow(attemptPath, options.attemptRootDir, attemptBudget)) {
          orphanAttemptsRemoved += 1;
        }
      }
    }

    return Object.freeze({
      expiring: Object.freeze(expiring),
      orphanArtifactKeysRemoved: Object.freeze(orphanArtifactKeysRemoved.sort()),
      orphanStagesRemoved,
      orphanAttemptsRemoved,
      scannedEntries,
      scanTruncated
    });
  }

  return Object.freeze({
    publishFromFile,
    readVerified,
    readExisting,
    remove,
    runJanitor
  });
}

module.exports = {
  PptArtifactStoreError,
  createPptArtifactStore
};

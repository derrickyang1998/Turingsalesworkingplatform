'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPptArtifactStore } = require('../services/ppt_artifact_store');

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function cacheKey(label) {
  return digest(`ppt-artifact:${label}`);
}

function fixturePptx(label) {
  return Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from(`turingmarket-pptx:${label}`, 'utf8')
  ]);
}

function tempStore(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-ppt-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    sourcePath: path.join(root, 'source.pptx'),
    store: createPptArtifactStore({ rootDir: path.join(root, 'cache') })
  };
}

function artifactPath(fixture, key) {
  return path.join(fixture.root, 'cache', key.slice(0, 2), `${key}.pptx`);
}

test('PPT artifact store atomically publishes and verifies replay evidence', (t) => {
  const fixture = tempStore(t);
  const content = fixturePptx('publish');
  const key = cacheKey('publish');
  fs.writeFileSync(fixture.sourcePath, content);

  const published = fixture.store.publishFromFile({
    cacheKey: key,
    sourcePath: fixture.sourcePath
  });
  assert.deepEqual(published, {
    cacheKey: key,
    bytes: content.length,
    sha256: digest(content)
  });
  const cacheDir = path.join(fixture.root, 'cache');
  assert.deepEqual(fs.readdirSync(cacheDir), [key.slice(0, 2)]);
  assert.deepEqual(fs.readdirSync(path.join(cacheDir, key.slice(0, 2))), [`${key}.pptx`]);
  const replay = fixture.store.readVerified({
    cacheKey: key,
    bytes: content.length,
    sha256: digest(content)
  });
  assert.equal(replay.cacheKey, key);
  assert.equal(replay.bytes, content.length);
  assert.equal(replay.sha256, digest(content));
  assert.deepEqual(fs.readFileSync(replay.filePath), content);
});

test('PPT artifact store rejects invalid containers and clears staged output', (t) => {
  const fixture = tempStore(t);
  fs.writeFileSync(fixture.sourcePath, Buffer.from('not a pptx', 'utf8'));
  assert.throws(
    () => fixture.store.publishFromFile({
      cacheKey: cacheKey('invalid'),
      sourcePath: fixture.sourcePath
    }),
    (error) => error.code === 'PPT_ARTIFACT_INVALID'
  );
  assert.deepEqual(fs.readdirSync(path.join(fixture.root, 'cache')), []);
});

test('PPT artifact store rejects symbolic-link storage and source paths', {
  skip: process.platform === 'win32'
}, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-ppt-store-links-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const realCache = path.join(root, 'real-cache');
  const cacheLink = path.join(root, 'cache-link');
  fs.mkdirSync(realCache, { mode: 0o700 });
  fs.symlinkSync(realCache, cacheLink, 'dir');
  assert.throws(
    () => createPptArtifactStore({ rootDir: cacheLink }),
    (error) => error.code === 'PPT_ARTIFACT_STORAGE_FAILED'
  );

  const fixture = tempStore(t);
  const targetPath = path.join(fixture.root, 'source-target.pptx');
  fs.writeFileSync(targetPath, fixturePptx('symbolic-source'));
  fs.symlinkSync(targetPath, fixture.sourcePath, 'file');
  assert.throws(
    () => fixture.store.publishFromFile({
      cacheKey: cacheKey('symbolic-source'),
      sourcePath: fixture.sourcePath
    }),
    (error) => error.code === 'PPT_ARTIFACT_INTEGRITY_FAILED'
  );
});

test('PPT artifact store repairs existing cache permissions for the process owner', {
  skip: process.platform === 'win32'
}, (t) => {
  const fixture = tempStore(t);
  const cacheDir = path.join(fixture.root, 'cache');
  fs.chmodSync(cacheDir, 0o755);
  createPptArtifactStore({ rootDir: cacheDir });
  assert.equal(fs.lstatSync(cacheDir).mode & 0o077, 0);
});

test('PPT artifact store rejects duplicate publication and tampered replay data', (t) => {
  const fixture = tempStore(t);
  const original = fixturePptx('original');
  const key = cacheKey('tamper');
  fs.writeFileSync(fixture.sourcePath, original);
  fixture.store.publishFromFile({ cacheKey: key, sourcePath: fixture.sourcePath });
  assert.throws(
    () => fixture.store.publishFromFile({ cacheKey: key, sourcePath: fixture.sourcePath }),
    (error) => error.code === 'PPT_ARTIFACT_EXISTS'
  );
  fs.writeFileSync(artifactPath(fixture, key), fixturePptx('tampered'));
  assert.throws(
    () => fixture.store.readVerified({
      cacheKey: key,
      bytes: original.length,
      sha256: digest(original)
    }),
    (error) => error.code === 'PPT_ARTIFACT_INTEGRITY_FAILED'
  );
});

test('PPT artifact store deletes only retained regular artifacts', (t) => {
  const fixture = tempStore(t);
  const content = fixturePptx('remove');
  const key = cacheKey('remove');
  fs.writeFileSync(fixture.sourcePath, content);
  fixture.store.publishFromFile({ cacheKey: key, sourcePath: fixture.sourcePath });
  assert.equal(fixture.store.remove({ cacheKey: key }), true);
  assert.equal(fixture.store.remove({ cacheKey: key }), false);
  assert.deepEqual(fs.readdirSync(path.join(fixture.root, 'cache')), []);
});

test('PPT artifact janitor protects live and retained keys while resuming expiring and stale orphan cleanup', (t) => {
  const fixture = tempStore(t);
  const nowMs = Date.now();
  const staleDate = new Date(nowMs - 2 * 60 * 60 * 1000);
  const liveKey = cacheKey('janitor-live');
  const retainedKey = cacheKey('janitor-retained');
  const expiringKey = cacheKey('janitor-expiring');
  const missingExpiringKey = cacheKey('janitor-expiring-missing');
  const orphanKey = cacheKey('janitor-orphan');

  for (const [key, label] of [
    [liveKey, 'live'],
    [retainedKey, 'retained'],
    [expiringKey, 'expiring'],
    [orphanKey, 'orphan']
  ]) {
    fs.writeFileSync(fixture.sourcePath, fixturePptx(label));
    fixture.store.publishFromFile({ cacheKey: key, sourcePath: fixture.sourcePath });
    fs.utimesSync(artifactPath(fixture, key), staleDate, staleDate);
  }

  const orphanStage = path.join(
    path.dirname(artifactPath(fixture, orphanKey)),
    `.${orphanKey}.${'a'.repeat(32)}.stage`
  );
  fs.writeFileSync(orphanStage, fixturePptx('orphan-stage'));
  fs.utimesSync(orphanStage, staleDate, staleDate);

  const attemptRoot = path.join(fixture.root, 'attempts');
  const liveAttempt = path.join(attemptRoot, `campaign-ppt-${liveKey}-live`);
  const orphanAttempt = path.join(attemptRoot, `campaign-ppt-${orphanKey}-orphan`);
  fs.mkdirSync(liveAttempt, { recursive: true });
  fs.mkdirSync(orphanAttempt, { recursive: true });
  fs.writeFileSync(path.join(liveAttempt, 'proposal.pptx'), fixturePptx('live-attempt'));
  fs.writeFileSync(path.join(orphanAttempt, 'proposal.pptx'), fixturePptx('orphan-attempt'));
  fs.utimesSync(liveAttempt, staleDate, staleDate);
  fs.utimesSync(orphanAttempt, staleDate, staleDate);

  const result = fixture.store.runJanitor({
    liveCacheKeys: [liveKey],
    retainedCacheKeys: [retainedKey],
    expiringCacheKeys: [expiringKey, missingExpiringKey],
    attemptRootDir: attemptRoot,
    orphanMinAgeMs: 60 * 60 * 1000,
    nowMs
  });

  assert.deepEqual(result.expiring, [
    { cacheKey: expiringKey, state: 'removed' },
    { cacheKey: missingExpiringKey, state: 'missing' }
  ]);
  assert.deepEqual(result.orphanArtifactKeysRemoved, [orphanKey]);
  assert.equal(result.orphanStagesRemoved, 1);
  assert.equal(result.orphanAttemptsRemoved, 1);
  assert.equal(fs.existsSync(artifactPath(fixture, liveKey)), true);
  assert.equal(fs.existsSync(artifactPath(fixture, retainedKey)), true);
  assert.equal(fs.existsSync(artifactPath(fixture, expiringKey)), false);
  assert.equal(fs.existsSync(artifactPath(fixture, orphanKey)), false);
  assert.equal(fs.existsSync(liveAttempt), true);
  assert.equal(fs.existsSync(orphanAttempt), false);
});

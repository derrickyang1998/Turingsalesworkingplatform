#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pixelmatch = require('pixelmatch');
const { PNG } = require('pngjs');
const { ensureSafeFixtureDirectory } = require('../tests/helpers/safe_fixture_paths');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const sddRoot = path.join(repoRoot, '.superpowers', 'sdd');
const MAX_DIFF_PIXEL_RATIO = 0.005;
const PIXELMATCH_THRESHOLD = 0.2;

function ensureSddRoot() {
  const superpowersRoot = ensureSafeFixtureDirectory(repoRoot, path.join(repoRoot, '.superpowers'), 'private test root');
  return ensureSafeFixtureDirectory(superpowersRoot, sddRoot, 'private test data root');
}

function toPosix(filePath) {
  return filePath.split(path.sep).join('/');
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function assertNotSymlink(filePath) {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to follow symlink: ${filePath}`);
  }
  return stat;
}

function assertInside(parent, child, label) {
  const relative = path.relative(parent, child);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes allowed root: ${child}`);
  }
}

function realDirectoryInside(parent, inputPath, label) {
  const resolved = path.resolve(inputPath);
  if (!fs.existsSync(resolved)) throw new Error(`Missing ${label}: ${resolved}`);
  const stat = assertNotSymlink(resolved);
  if (!stat.isDirectory()) throw new Error(`${label} must be a directory: ${resolved}`);
  const realParent = fs.realpathSync.native(parent);
  const realPath = fs.realpathSync.native(resolved);
  assertInside(realParent, realPath, label);
  return realPath;
}

function realFileInside(parent, inputPath, label) {
  const resolved = path.resolve(inputPath);
  if (!fs.existsSync(resolved)) throw new Error(`Missing ${label}: ${resolved}`);
  const stat = assertNotSymlink(resolved);
  if (!stat.isFile()) throw new Error(`${label} must be a file: ${resolved}`);
  const realParent = fs.realpathSync.native(parent);
  const realPath = fs.realpathSync.native(resolved);
  assertInside(realParent, realPath, label);
  return realPath;
}

function assertNoSymlinkAncestors(targetPath) {
  let current = path.resolve(targetPath);
  const stop = path.parse(current).root;
  const seen = [];
  while (current !== stop) {
    seen.push(current);
    current = path.dirname(current);
  }
  for (const candidate of seen.reverse()) {
    if (fs.existsSync(candidate)) assertNotSymlink(candidate);
  }
}

function lstatIfPresent(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function replaceFileAtomically(source, target, allowedRoot) {
  const resolvedRoot = path.resolve(allowedRoot);
  const resolvedTarget = path.resolve(target);
  assertInside(resolvedRoot, resolvedTarget, 'atomic replacement target');
  assertNoSymlinkAncestors(path.dirname(resolvedTarget));

  const targetStat = lstatIfPresent(resolvedTarget);
  if (targetStat && targetStat.isSymbolicLink()) {
    throw new Error(`Atomic replacement target contains a symbolic link, junction, or reparse point: ${resolvedTarget}`);
  }
  if (targetStat && !targetStat.isFile()) {
    throw new Error(`Atomic replacement target must be a regular file: ${resolvedTarget}`);
  }

  const tempPath = path.join(
    path.dirname(resolvedTarget),
    `.${path.basename(resolvedTarget)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  );
  assertInside(resolvedRoot, tempPath, 'atomic replacement temp file');
  try {
    fs.copyFileSync(source, tempPath, fs.constants.COPYFILE_EXCL);
    fs.renameSync(tempPath, resolvedTarget);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

function walkPngFiles(root, dir = root, files = []) {
  assertInside(root, dir, 'walk path');
  for (const entry of fs.readdirSync(dir)) {
    const absolute = path.join(dir, entry);
    const stat = assertNotSymlink(absolute);
    if (stat.isDirectory()) {
      walkPngFiles(root, absolute, files);
      continue;
    }
    if (!stat.isFile()) continue;
    if (path.extname(entry).toLowerCase() !== '.png') continue;
    const relative = toPosix(path.relative(root, absolute));
    if (relative.startsWith('../') || relative.includes('/../') || path.isAbsolute(relative)) {
      throw new Error(`Unsafe run file path: ${relative}`);
    }
    files.push({ relative, absolute, sha256: sha256File(absolute), bytes: stat.size });
  }
  files.sort((a, b) => a.relative.localeCompare(b.relative));
  return files;
}

function readRunMetadata(runRoot) {
  const metadataPath = path.join(runRoot, 'run-metadata.json');
  if (!fs.existsSync(metadataPath)) {
    throw new Error(`Missing run metadata: ${metadataPath}`);
  }
  const stat = assertNotSymlink(metadataPath);
  if (!stat.isFile()) throw new Error(`Run metadata must be a file: ${metadataPath}`);
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  return {
    schemaVersion: metadata.schemaVersion,
    baselineVersion: metadata.baselineVersion,
    fixtureVersion: metadata.fixtureVersion,
    maskVersion: metadata.maskVersion,
    runLabel: metadata.runLabel || path.basename(runRoot),
    frozenAt: metadata.frozenAt,
    environments: metadata.environments || {},
    knownGaps: metadata.knownGaps || [],
    expectedPngCount: metadata.expectedPngCount
  };
}

function expectedRunRelatives(manifest) {
  if (!Array.isArray(manifest.screenshotSlots) || manifest.screenshotSlots.length !== 72) {
    throw new Error('Manifest must include exactly 72 screenshot slots');
  }
  const expected = manifest.screenshotSlots.map((slot) => {
    for (const key of ['role', 'viewport', 'journey']) {
      if (!/^[A-Za-z0-9._-]+$/.test(String(slot[key] || ''))) {
        throw new Error(`Unsafe slot ${key}: ${JSON.stringify(slot[key])}`);
      }
    }
    return `${slot.role}/${slot.viewport}/${slot.journey}.png`;
  }).sort();
  if (new Set(expected).size !== expected.length) {
    throw new Error('Manifest screenshot slots are not unique');
  }
  return expected;
}

function assertSetEquals(actual, expected, label) {
  assert.deepEqual(actual, expected, `${label} file set must match the 72 manifest slots`);
}

function validateComparisonDimensions(comparisons, manifest) {
  const viewportByName = new Map(manifest.viewports.map((viewport) => [viewport.name, viewport]));
  for (const comparison of comparisons) {
    const [role, viewportName, filename] = comparison.relative.split('/');
    const journey = filename && filename.replace(/\.png$/i, '');
    const slot = manifest.screenshotSlots.find((candidate) => (
      candidate.role === role
      && candidate.viewport === viewportName
      && candidate.journey === journey
    ));
    if (!slot) throw new Error(`Comparison has no manifest slot: ${comparison.relative}`);
    const viewport = viewportByName.get(viewportName);
    if (!viewport) throw new Error(`Comparison has no viewport metadata: ${comparison.relative}`);
    if (comparison.width !== viewport.width || comparison.height !== viewport.height) {
      throw new Error(
        `Screenshot dimensions for ${comparison.relative} must be ${viewport.width}x${viewport.height}; `
        + `got ${comparison.width}x${comparison.height}`
      );
    }
  }
}

function validateRunEnvironments(leftMetadata, rightMetadata, manifest) {
  const expectedProjects = manifest.viewports.map((viewport) => viewport.name).sort();
  for (const [label, metadata] of [['left', leftMetadata], ['right', rightMetadata]]) {
    assert.deepEqual(Object.keys(metadata.environments).sort(), expectedProjects, `${label} run projects must match manifest viewports`);
    for (const viewport of manifest.viewports) {
      const environment = metadata.environments[viewport.name];
      const expected = {
        os: 'Windows',
        browserName: 'chromium',
        browserRevision: '1223',
        locale: 'zh-CN',
        timezone: 'Asia/Shanghai',
        colorScheme: 'light',
        reducedMotion: 'reduce',
        deviceScaleFactor: 1
      };
      for (const [key, value] of Object.entries(expected)) {
        assert.equal(environment[key], value, `${label} ${viewport.name} ${key} must match the frozen runner contract`);
      }
      assert.deepEqual(environment.viewport, { width: viewport.width, height: viewport.height }, `${label} ${viewport.name} viewport must match manifest`);
      assert.equal(environment.fonts && environment.fonts['Segoe UI'], true, `${label} ${viewport.name} requires Segoe UI`);
      assert.equal(environment.fonts && environment.fonts['Microsoft YaHei'], true, `${label} ${viewport.name} requires Microsoft YaHei`);
    }
  }
  assert.deepEqual(leftMetadata.environments, rightMetadata.environments, 'A/B run environments must be identical');
}

function comparePngBuffers(leftBuffer, rightBuffer, maxDiffPixelRatio = MAX_DIFF_PIXEL_RATIO) {
  const left = PNG.sync.read(leftBuffer);
  const right = PNG.sync.read(rightBuffer);
  if (left.width !== right.width || left.height !== right.height) {
    throw new Error(`Screenshot dimensions differ: ${left.width}x${left.height} !== ${right.width}x${right.height}`);
  }

  let rawDiffPixels = 0;
  let maxChannelDelta = 0;
  for (let index = 0; index < left.data.length; index += 4) {
    let pixelDiffers = false;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs(left.data[index + channel] - right.data[index + channel]);
      if (delta > 0) pixelDiffers = true;
      if (delta > maxChannelDelta) maxChannelDelta = delta;
    }
    if (pixelDiffers) rawDiffPixels += 1;
  }

  const totalPixels = left.width * left.height;
  const diffPixels = pixelmatch(left.data, right.data, null, left.width, left.height, {
    threshold: PIXELMATCH_THRESHOLD
  });
  const diffPixelRatio = totalPixels ? diffPixels / totalPixels : 0;
  if (diffPixelRatio > maxDiffPixelRatio) {
    throw new Error(
      `Screenshot pixel diff ratio ${diffPixelRatio} exceeds ${maxDiffPixelRatio} `
      + `(${diffPixels}/${totalPixels} perceptual pixels, ${rawDiffPixels} raw pixels, `
      + `max channel delta ${maxChannelDelta})`
    );
  }

  return {
    width: left.width,
    height: left.height,
    totalPixels,
    diffPixels,
    diffPixelRatio,
    rawDiffPixels,
    maxChannelDelta
  };
}

function compareScreenshots(leftFiles, rightFiles) {
  const rightByRelative = new Map(rightFiles.map((file) => [file.relative, file]));
  const comparisons = [];
  for (const left of leftFiles) {
    const right = rightByRelative.get(left.relative);
    if (!right) throw new Error(`Right run missing ${left.relative}`);
    let pixelComparison;
    try {
      pixelComparison = comparePngBuffers(fs.readFileSync(left.absolute), fs.readFileSync(right.absolute));
    } catch (error) {
      throw new Error(`Screenshot comparison failed for ${left.relative}: ${error.message}`);
    }
    comparisons.push({
      relative: left.relative,
      leftSha256: left.sha256,
      rightSha256: right.sha256,
      leftBytes: left.bytes,
      rightBytes: right.bytes,
      identical: left.sha256 === right.sha256,
      ...pixelComparison
    });
  }
  return comparisons;
}

function validateManifestPath(manifestPath) {
  const realPath = realFileInside(repoRoot, manifestPath, 'manifest');
  const relative = toPosix(path.relative(repoRoot, realPath));
  if (!/^docs\/baselines\/[A-Za-z0-9._-]+\/ui-ppt-manifest\.json$/.test(relative)) {
    throw new Error(`Manifest must be a baseline manifest under docs/baselines: ${relative}`);
  }
  return realPath;
}

function validateSlotTarget(slot, manifest) {
  const baselineVersion = manifest.baseline && manifest.baseline.version;
  const slotPath = String(slot.path || '');
  if (slotPath.includes('\\') || slotPath.includes('..') || path.isAbsolute(slotPath)) {
    throw new Error(`Unsafe screenshot slot path: ${slotPath}`);
  }
  const prefix = `docs/baselines/${baselineVersion}/screenshots/`;
  if (!slotPath.startsWith(prefix) || !slotPath.endsWith('.png')) {
    throw new Error(`Screenshot slot path must be under ${prefix}: ${slotPath}`);
  }
  return path.join(repoRoot, slotPath);
}

function promoteRightRun(rightRoot, manifest, comparisons) {
  const comparisonByRelative = new Map(comparisons.map((entry) => [entry.relative, entry]));
  const screenshotRoot = path.join(repoRoot, 'docs', 'baselines', manifest.baseline.version, 'screenshots');
  for (const slot of manifest.screenshotSlots) {
    const relative = `${slot.role}/${slot.viewport}/${slot.journey}.png`;
    const source = path.join(rightRoot, relative);
    assertInside(rightRoot, source, 'right screenshot');
    const target = validateSlotTarget(slot, manifest);
    assertInside(repoRoot, target, 'promoted screenshot');
    assertNoSymlinkAncestors(path.dirname(target));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    replaceFileAtomically(source, target, screenshotRoot);
    const comparison = comparisonByRelative.get(relative);
    slot.exists = true;
    slot.sha256 = comparison.rightSha256;
  }
}

function compareUiBaselineRuns(options) {
  ensureSddRoot();
  const leftRoot = realDirectoryInside(sddRoot, options.left, 'left run directory');
  const rightRoot = realDirectoryInside(sddRoot, options.right, 'right run directory');
  const manifestPath = validateManifestPath(options.manifest);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  const expected = expectedRunRelatives(manifest);
  const leftFiles = walkPngFiles(leftRoot);
  const rightFiles = walkPngFiles(rightRoot);
  assertSetEquals(leftFiles.map((file) => file.relative), expected, 'left run');
  assertSetEquals(rightFiles.map((file) => file.relative), expected, 'right run');

  const comparisons = compareScreenshots(leftFiles, rightFiles);
  validateComparisonDimensions(comparisons, manifest);
  const leftMetadata = readRunMetadata(leftRoot);
  const rightMetadata = readRunMetadata(rightRoot);
  if (leftMetadata.baselineVersion !== manifest.baseline.version || rightMetadata.baselineVersion !== manifest.baseline.version) {
    throw new Error('Run metadata baseline version must match manifest baseline version');
  }
  if (leftMetadata.expectedPngCount !== 72 || rightMetadata.expectedPngCount !== 72) {
    throw new Error('Run metadata must record the expected 72 PNG count');
  }
  validateRunEnvironments(leftMetadata, rightMetadata, manifest);

  promoteRightRun(rightRoot, manifest, comparisons);

  const maxObservedDiffRatio = Math.max(...comparisons.map((entry) => entry.diffPixelRatio));
  const totalDiffPixels = comparisons.reduce((sum, entry) => sum + entry.diffPixels, 0);
  const totalRawDiffPixels = comparisons.reduce((sum, entry) => sum + entry.rawDiffPixels, 0);

  manifest.browserBaseline = {
    schemaVersion: 1,
    identical: comparisons.every((entry) => entry.identical),
    withinThreshold: true,
    maxDiffPixelRatio: MAX_DIFF_PIXEL_RATIO,
    maxObservedDiffRatio,
    totalDiffPixels,
    totalRawDiffPixels,
    fileCount: comparisons.length,
    left: {
      label: leftMetadata.runLabel,
      environment: leftMetadata.environments
    },
    right: {
      label: rightMetadata.runLabel,
      environment: rightMetadata.environments
    },
    fixtureVersion: rightMetadata.fixtureVersion,
    maskVersion: rightMetadata.maskVersion,
    frozenAt: rightMetadata.frozenAt,
    knownGaps: rightMetadata.knownGaps,
    screenshots: comparisons.map((entry) => {
      const slot = manifest.screenshotSlots.find((candidate) => `${candidate.role}/${candidate.viewport}/${candidate.journey}.png` === entry.relative);
      return {
        path: slot.path,
        leftSha256: entry.leftSha256,
        rightSha256: entry.rightSha256,
        identical: entry.identical,
        diffPixels: entry.diffPixels,
        diffPixelRatio: entry.diffPixelRatio,
        rawDiffPixels: entry.rawDiffPixels,
        maxChannelDelta: entry.maxChannelDelta,
        width: entry.width,
        height: entry.height,
        bytes: entry.rightBytes
      };
    })
  };

  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest.browserBaseline;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--self-test') {
      args.selfTest = true;
      continue;
    }
    if (arg === '--left' || arg === '--right' || arg === '--manifest') {
      args[arg.slice(2)] = argv[i + 1];
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.selfTest && (!args.left || !args.right || !args.manifest)) {
    throw new Error('Usage: compare_ui_baseline_runs.js --left <run-a> --right <run-b> --manifest <ui-ppt-manifest.json>');
  }
  return args;
}

function runSelfTest() {
  ensureSddRoot();
  const root = fs.mkdtempSync(path.join(sddRoot, 'compare-self-test-'));
  const left = path.join(root, 'left');
  const right = path.join(root, 'right');
  fs.mkdirSync(path.join(left, 'admin', 'fixture-1440'), { recursive: true });
  fs.mkdirSync(path.join(right, 'admin', 'fixture-1440'), { recursive: true });
  const leftPng = new PNG({ width: 100, height: 100 });
  leftPng.data.fill(255);
  const rightPng = PNG.sync.read(PNG.sync.write(leftPng));
  rightPng.data[0] = 0;
  rightPng.data[1] = 0;
  rightPng.data[2] = 0;
  fs.writeFileSync(path.join(left, 'admin', 'fixture-1440', 'sample.png'), PNG.sync.write(leftPng));
  fs.writeFileSync(path.join(right, 'admin', 'fixture-1440', 'sample.png'), PNG.sync.write(rightPng));
  try {
    const leftFiles = walkPngFiles(left);
    const rightFiles = walkPngFiles(right);
    assert.deepEqual(leftFiles.map((file) => file.relative), ['admin/fixture-1440/sample.png']);
    const comparison = compareScreenshots(leftFiles, rightFiles)[0];
    assert.equal(comparison.identical, false);
    assert.equal(comparison.diffPixels, 1);
    assert.equal(comparison.rawDiffPixels, 1);
    assert.equal(comparison.diffPixelRatio, 0.0001);
    for (let index = 0; index < rightPng.data.length; index += 4) {
      rightPng.data[index] = 0;
      rightPng.data[index + 1] = 0;
      rightPng.data[index + 2] = 0;
      rightPng.data[index + 3] = 255;
    }
    fs.writeFileSync(path.join(right, 'admin', 'fixture-1440', 'sample.png'), PNG.sync.write(rightPng));
    assert.throws(() => compareScreenshots(leftFiles, walkPngFiles(right)), /exceeds 0\.005/);
    assert.throws(() => realDirectoryInside(sddRoot, repoRoot, 'outside'), /escapes allowed root/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.selfTest) {
      runSelfTest();
      console.log('compare_ui_baseline_runs self-test passed');
    } else {
      const result = compareUiBaselineRuns(args);
      console.log(JSON.stringify({
        identical: result.identical,
        withinThreshold: result.withinThreshold,
        maxObservedDiffRatio: result.maxObservedDiffRatio,
        totalDiffPixels: result.totalDiffPixels,
        totalRawDiffPixels: result.totalRawDiffPixels,
        fileCount: result.fileCount,
        left: result.left.label,
        right: result.right.label
      }, null, 2));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  comparePngBuffers,
  compareUiBaselineRuns,
  replaceFileAtomically,
  validateRunEnvironments,
  walkPngFiles
};

#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { comparePngBuffers } = require('./compare_ui_baseline_runs');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const rawRoot = path.join(repoRoot, '.superpowers', 'sdd', 'browser-baseline-current');
const evidenceRoot = path.join(repoRoot, 'docs', 'product', 'evidence', '2026-07-phase3-post');
const manifestPath = path.join(repoRoot, 'docs', 'baselines', 'v0.2.9', 'ui-ppt-manifest.json');
const provenancePath = path.join(evidenceRoot, 'raw-contact-sheet-manifest.json');
const viewportOrder = ['fixture-1440', 'fixture-1920', 'fixture-mobile'];

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function readGitBlob(sourceCommit, source) {
  if (!/^[A-Za-z0-9._/-]+$/.test(source) || source.includes('..')) {
    throw new Error(`Unsafe controlled source path: ${source}`);
  }
  const result = spawnSync('git', ['show', `${sourceCommit}:${source}`], {
    cwd: repoRoot,
    encoding: null,
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    throw new Error(`Unable to read controlled source from commit: ${source}`);
  }
  return result.stdout;
}

function assertRegularFile(filePath, label) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file: ${filePath}`);
  return stat;
}

function assertInside(parent, child, label) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`${label} escapes its allowed root`);
}

function writeJsonAtomically(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function parseArgs(argv) {
  const options = { sourceCommit: '', reviewStatus: 'pending' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--source-commit') options.sourceCommit = String(argv[++index] || '').trim();
    else if (argument === '--review-status') options.reviewStatus = String(argv[++index] || '').trim();
    else throw new Error(`Unexpected visual evidence generator argument: ${argument}`);
  }
  if (!/^[a-f0-9]{40}$/.test(options.sourceCommit) || !['pending', 'approved'].includes(options.reviewStatus)) {
    throw new Error('Usage: generate_phase3_visual_evidence_manifest.js --source-commit <40-hex-commit> [--review-status pending|approved]');
  }
  return options;
}

function generateVisualEvidence(sourceCommit, reviewStatus = 'pending') {
  assertInside(path.join(repoRoot, '.superpowers', 'sdd'), rawRoot, 'raw evidence root');
  assertInside(path.join(repoRoot, 'docs', 'product', 'evidence'), evidenceRoot, 'tracked evidence root');
  if (!fs.statSync(rawRoot).isDirectory()) throw new Error(`Missing raw evidence root: ${rawRoot}`);
  if (!fs.statSync(evidenceRoot).isDirectory()) throw new Error(`Missing tracked evidence root: ${evidenceRoot}`);

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(manifest.screenshotSlots) || manifest.screenshotSlots.length !== 72) {
    throw new Error('Controlled manifest must define exactly 72 screenshot slots');
  }
  const preEditSlots = new Map((manifest.preEdit && manifest.preEdit.screenshotSlots || []).map((slot) => [slot.path, slot]));
  if (preEditSlots.size !== 72) throw new Error('Frozen pre-edit manifest must define exactly 72 screenshot slots');

  const captures = [];
  const comparisons = [];
  for (const slot of manifest.screenshotSlots) {
    const relative = `${slot.role}/${slot.viewport}/${slot.journey}.png`;
    if (!/^[A-Za-z0-9._/-]+$/.test(relative) || relative.includes('..')) throw new Error(`Unsafe screenshot slot: ${relative}`);
    const rawPath = path.join(rawRoot, ...relative.split('/'));
    assertInside(rawRoot, rawPath, 'raw screenshot');
    const rawStat = assertRegularFile(rawPath, 'Raw screenshot');
    const rawBuffer = fs.readFileSync(rawPath);
    const frozenBuffer = readGitBlob(sourceCommit, slot.path);
    const frozenSlot = preEditSlots.get(slot.path);
    if (!frozenSlot || frozenSlot.sha256 !== sha256(frozenBuffer)) {
      throw new Error(`Source commit does not retain the frozen pre-edit screenshot: ${slot.path}`);
    }
    const pixel = comparePngBuffers(frozenBuffer, rawBuffer, 1);
    const capture = {
      path: relative,
      sha256: sha256(rawBuffer),
      bytes: rawStat.size,
      width: pixel.width,
      height: pixel.height
    };
    captures.push(capture);
    comparisons.push({
      path: slot.path,
      preEditSha256: sha256(frozenBuffer),
      postEditSha256: capture.sha256,
      identical: frozenBuffer.equals(rawBuffer),
      diffPixels: pixel.diffPixels,
      diffPixelRatio: pixel.diffPixelRatio,
      rawDiffPixels: pixel.rawDiffPixels,
      maxChannelDelta: pixel.maxChannelDelta,
      width: pixel.width,
      height: pixel.height,
      bytes: rawStat.size
    });
  }

  const captureByPath = new Map(captures.map((capture) => [capture.path, capture]));
  const contactSheets = [];
  for (const viewport of viewportOrder) {
    const viewportCaptures = captures
      .filter((capture) => capture.path.split('/')[1] === viewport)
      .sort((left, right) => left.path.localeCompare(right.path));
    if (viewportCaptures.length !== 24) throw new Error(`Expected 24 ${viewport} captures; got ${viewportCaptures.length}`);
    for (let groupIndex = 0; groupIndex < 3; groupIndex += 1) {
      const group = viewportCaptures.slice(groupIndex * 8, groupIndex * 8 + 8);
      const name = `${viewport}-${groupIndex + 1}.png`;
      const sheetPath = path.join(evidenceRoot, name);
      const sheetStat = assertRegularFile(sheetPath, 'Contact sheet');
      const sheetBuffer = fs.readFileSync(sheetPath);
      contactSheets.push({
        name,
        sha256: sha256(sheetBuffer),
        bytes: sheetStat.size,
        rawCaptures: group.map((capture) => capture.path)
      });
      group.forEach((capture, index) => {
        capture.contactSheet = name;
        capture.contactSheetIndex = index + 1;
      });
    }
  }

  if (captureByPath.size !== 72 || captures.some((capture) => !capture.contactSheet)) {
    throw new Error('Every raw capture must map to exactly one contact sheet');
  }

  const maxObservedDiffRatio = Math.max(...comparisons.map((entry) => entry.diffPixelRatio));
  manifest.postEditComparison = {
    schemaVersion: 1,
    sourceCommit,
    source: '.superpowers/sdd/browser-baseline-current',
    comparisonMode: 'reviewed-shared-shell-redesign',
    approvalRecord: 'docs/product/2026-07-phase3-visual-change-record.md',
    reviewStatus,
    maxDiffPixelRatio: null,
    maxObservedDiffRatio,
    withinThreshold: null,
    totalDiffPixels: comparisons.reduce((sum, entry) => sum + entry.diffPixels, 0),
    totalRawDiffPixels: comparisons.reduce((sum, entry) => sum + entry.rawDiffPixels, 0),
    fileCount: comparisons.length,
    screenshots: comparisons
  };

  for (const file of Object.values(manifest.files || {})) {
    const sourcePath = path.join(repoRoot, ...file.source.split('/'));
    assertRegularFile(sourcePath, 'Controlled source');
    const workspaceBuffer = fs.readFileSync(sourcePath);
    const commitBuffer = readGitBlob(sourceCommit, file.source);
    if (!workspaceBuffer.equals(commitBuffer)) {
      throw new Error(`Controlled source differs from source commit bytes: ${file.source}`);
    }
    file.sha256 = sha256(commitBuffer);
    file.bytes = commitBuffer.length;
    file.sourceCommit = sourceCommit;
    file.sourceCommitSha256 = file.sha256;
    file.sourceCommitBytes = file.bytes;
  }

  const provenance = {
    schemaVersion: 1,
    sourceCommit,
    source: manifest.postEditComparison.source,
    comparisonMode: manifest.postEditComparison.comparisonMode,
    approvalRecord: manifest.postEditComparison.approvalRecord,
    reviewStatus,
    rawCaptureCount: captures.length,
    contactSheetCount: contactSheets.length,
    rawCaptures: captures,
    contactSheets
  };
  writeJsonAtomically(manifestPath, manifest);
  writeJsonAtomically(provenancePath, provenance);
  return provenance;
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const provenance = generateVisualEvidence(options.sourceCommit, options.reviewStatus);
    console.log(JSON.stringify({
      sourceCommit: provenance.sourceCommit,
      reviewStatus: provenance.reviewStatus,
      rawCaptureCount: provenance.rawCaptureCount,
      contactSheetCount: provenance.contactSheetCount
    }, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { generateVisualEvidence, parseArgs, readGitBlob };

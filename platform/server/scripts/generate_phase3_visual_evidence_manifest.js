#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
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

function sourceCommitFromArgs(argv) {
  const index = argv.indexOf('--source-commit');
  const value = index === -1 ? '' : String(argv[index + 1] || '').trim();
  if (!/^[a-f0-9]{40}$/.test(value)) throw new Error('Usage: generate_phase3_visual_evidence_manifest.js --source-commit <40-hex-commit>');
  if (argv.length !== 2 || index !== 0) throw new Error('Unexpected visual evidence generator arguments');
  return value;
}

function generateVisualEvidence(sourceCommit) {
  assertInside(path.join(repoRoot, '.superpowers', 'sdd'), rawRoot, 'raw evidence root');
  assertInside(path.join(repoRoot, 'docs', 'product', 'evidence'), evidenceRoot, 'tracked evidence root');
  if (!fs.statSync(rawRoot).isDirectory()) throw new Error(`Missing raw evidence root: ${rawRoot}`);
  if (!fs.statSync(evidenceRoot).isDirectory()) throw new Error(`Missing tracked evidence root: ${evidenceRoot}`);

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(manifest.screenshotSlots) || manifest.screenshotSlots.length !== 72) {
    throw new Error('Controlled manifest must define exactly 72 screenshot slots');
  }

  const captures = [];
  const comparisons = [];
  for (const slot of manifest.screenshotSlots) {
    const relative = `${slot.role}/${slot.viewport}/${slot.journey}.png`;
    if (!/^[A-Za-z0-9._/-]+$/.test(relative) || relative.includes('..')) throw new Error(`Unsafe screenshot slot: ${relative}`);
    const rawPath = path.join(rawRoot, ...relative.split('/'));
    const frozenPath = path.join(repoRoot, ...slot.path.split('/'));
    assertInside(rawRoot, rawPath, 'raw screenshot');
    assertInside(repoRoot, frozenPath, 'frozen screenshot');
    const rawStat = assertRegularFile(rawPath, 'Raw screenshot');
    assertRegularFile(frozenPath, 'Frozen screenshot');
    const rawBuffer = fs.readFileSync(rawPath);
    const frozenBuffer = fs.readFileSync(frozenPath);
    const pixel = comparePngBuffers(frozenBuffer, rawBuffer);
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
    maxDiffPixelRatio: 0.005,
    maxObservedDiffRatio,
    withinThreshold: maxObservedDiffRatio <= 0.005,
    totalDiffPixels: comparisons.reduce((sum, entry) => sum + entry.diffPixels, 0),
    totalRawDiffPixels: comparisons.reduce((sum, entry) => sum + entry.rawDiffPixels, 0),
    fileCount: comparisons.length,
    screenshots: comparisons
  };

  for (const file of Object.values(manifest.files || {})) {
    const sourcePath = path.join(repoRoot, ...file.source.split('/'));
    const stat = assertRegularFile(sourcePath, 'Controlled source');
    file.sha256 = sha256(fs.readFileSync(sourcePath));
    file.bytes = stat.size;
  }

  const provenance = {
    schemaVersion: 1,
    sourceCommit,
    source: manifest.postEditComparison.source,
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
    const provenance = generateVisualEvidence(sourceCommitFromArgs(process.argv.slice(2)));
    console.log(JSON.stringify({
      sourceCommit: provenance.sourceCommit,
      rawCaptureCount: provenance.rawCaptureCount,
      contactSheetCount: provenance.contactSheetCount
    }, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { generateVisualEvidence, sourceCommitFromArgs };

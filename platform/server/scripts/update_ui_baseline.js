#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  ensureSafeFixtureDirectory,
  removeSafeFixtureDirectory,
  resolveSafeFixturePath
} = require('../tests/helpers/safe_fixture_paths');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const platformRoot = path.join(repoRoot, 'platform');
const serverRoot = path.join(platformRoot, 'server');
const sddRoot = path.join(repoRoot, '.superpowers', 'sdd');
const baselineRoot = path.join(repoRoot, 'docs', 'baselines', 'v0.2.9');
const manifestPath = path.join(baselineRoot, 'ui-ppt-manifest.json');
const browserFixtureRoot = path.join(sddRoot, 'browser-fixture-server');
const currentRun = path.join(sddRoot, 'browser-baseline-current');
const runA = path.join(sddRoot, 'baseline-run-a');
const runB = path.join(sddRoot, 'baseline-run-b');
const playwrightPackagePath = require.resolve('playwright/package.json');
const playwrightPackage = JSON.parse(fs.readFileSync(playwrightPackagePath, 'utf8'));
const playwrightBin = typeof playwrightPackage.bin === 'string'
  ? playwrightPackage.bin
  : playwrightPackage.bin && playwrightPackage.bin.playwright;
if (!playwrightBin) throw new Error('Playwright package does not declare a CLI binary');
const playwrightCli = path.resolve(path.dirname(playwrightPackagePath), playwrightBin);
if (!fs.existsSync(playwrightCli)) throw new Error(`Playwright CLI is missing: ${playwrightCli}`);

function assertInside(parent, child, label) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes allowed root`);
  }
}

function ensureSddRoot() {
  const superpowersRoot = ensureSafeFixtureDirectory(repoRoot, path.join(repoRoot, '.superpowers'), 'private test root');
  return ensureSafeFixtureDirectory(superpowersRoot, sddRoot, 'private test data root');
}

function cleanRunDirectory(runPath) {
  ensureSddRoot();
  if (path.resolve(runPath) === path.resolve(sddRoot)) {
    throw new Error('Refusing to clean the baseline run root');
  }
  removeSafeFixtureDirectory(sddRoot, runPath, 'baseline run directory');
}

function cleanFixtureRunDirectory(runPath) {
  ensureSddRoot();
  ensureSafeFixtureDirectory(sddRoot, browserFixtureRoot, 'browser fixture root');
  if (path.resolve(runPath) === path.resolve(browserFixtureRoot)) {
    throw new Error('Refusing to clean the browser fixture root');
  }
  removeSafeFixtureDirectory(browserFixtureRoot, runPath, 'browser fixture run directory');
}

function browserFixtureRunDirectory(env = process.env) {
  const port = Number(env.TM_BROWSER_FIXTURE_PORT || 43187);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid browser fixture port: ${env.TM_BROWSER_FIXTURE_PORT}`);
  }
  return path.join(browserFixtureRoot, String(port));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    stdio: 'inherit',
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${options.label || command} failed with exit code ${result.status}`);
  }
}

function playwrightArgs() {
  return [
    'test',
    'server/tests/browser-baseline.spec.js',
    '--config=server/tests/browser-baseline.config.js',
    '--project=fixture-1440',
    '--project=fixture-1920',
    '--project=fixture-mobile'
  ];
}

function captureRun(outputRoot, label) {
  try {
    run(process.execPath, [playwrightCli, ...playwrightArgs()], {
      cwd: platformRoot,
      env: { ...process.env, TM_BASELINE_OUTPUT_DIR: outputRoot },
      label
    });
  } finally {
    // Playwright force-kills webServer process trees on Windows, so cleanup must
    // happen outside the fixture server after the Playwright process exits.
    cleanFixtureRunDirectory(browserFixtureRunDirectory());
  }
}

function runSelfTest() {
  ensureSddRoot();
  assertInside(repoRoot, baselineRoot, 'baseline root');
  resolveSafeFixturePath(sddRoot, runA, 'run A');
  resolveSafeFixturePath(sddRoot, runB, 'run B');
  if (path.resolve(runA) === path.resolve(runB)) throw new Error('Baseline run directories must differ');
  if (playwrightArgs().filter((arg) => arg.startsWith('--project=')).length !== 3) {
    throw new Error('Baseline update must execute all three viewport projects');
  }
  try {
    assertInside(sddRoot, repoRoot, 'outside path');
    throw new Error('Missing outside-path rejection');
  } catch (error) {
    if (!/escapes allowed root/.test(error.message)) throw error;
  }
}

function main() {
  ensureSddRoot();
  ensureSafeFixtureDirectory(repoRoot, baselineRoot, 'baseline root');
  cleanRunDirectory(runA);
  cleanRunDirectory(runB);

  run(process.execPath, [
    path.join(serverRoot, 'scripts', 'generate_ui_baseline_manifest.js'),
    '--baseline-version',
    'v0.2.9',
    '--output',
    manifestPath
  ], { cwd: serverRoot, label: 'baseline manifest generation' });

  captureRun(runA, 'baseline run A');
  captureRun(runB, 'baseline run B');

  run(process.execPath, [
    path.join(serverRoot, 'scripts', 'compare_ui_baseline_runs.js'),
    '--left',
    runA,
    '--right',
    runB,
    '--manifest',
    manifestPath
  ], { cwd: serverRoot, label: 'baseline comparison' });
}

function captureOnce() {
  ensureSddRoot();
  cleanRunDirectory(currentRun);
  captureRun(currentRun, 'browser baseline run');
}

if (require.main === module) {
  try {
    if (process.argv.includes('--self-test')) {
      runSelfTest();
      console.log('update_ui_baseline self-test passed');
    } else if (process.argv.includes('--capture-once')) {
      captureOnce();
    } else {
      main();
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  browserFixtureRunDirectory,
  cleanFixtureRunDirectory,
  cleanRunDirectory,
  playwrightArgs,
  runSelfTest
};

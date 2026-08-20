#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  ensureSafeFixtureDirectory,
  removeSafeFixtureDirectory
} = require('../helpers/safe_fixture_paths');

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
const platformRoot = path.join(repoRoot, 'platform');
const serverRoot = path.join(platformRoot, 'server');
const port = Number(process.env.TM_BROWSER_FIXTURE_PORT || 43187);
const configuredFixtureRoot = process.env.TM_BROWSER_FIXTURE_ROOT;
const superpowersRoot = path.resolve(configuredFixtureRoot || path.join(repoRoot, '.superpowers'));
const superpowersParent = configuredFixtureRoot ? path.dirname(superpowersRoot) : repoRoot;
const sddRoot = path.join(superpowersRoot, 'sdd');
const browserFixtureRoot = path.join(sddRoot, 'browser-fixture-server');
const runRoot = path.join(browserFixtureRoot, String(port));
const dbPath = path.join(runRoot, 'fixture.db');
const stdoutPath = path.join(runRoot, 'server.stdout.log');
const stderrPath = path.join(runRoot, 'server.stderr.log');
const TEST_JWT_SECRET = 'r5mvdP9IQlk87XKX7U5crz6K-4EEe9heCdEnXEpm-zg';

function ensureFixtureRoots() {
  ensureSafeFixtureDirectory(superpowersParent, superpowersRoot, 'private test root');
  ensureSafeFixtureDirectory(superpowersRoot, sddRoot, 'private test data root');
  ensureSafeFixtureDirectory(sddRoot, browserFixtureRoot, 'browser fixture root');
}

function cleanRunRoot() {
  ensureFixtureRoots();
  removeSafeFixtureDirectory(browserFixtureRoot, runRoot, 'browser fixture run directory');
  ensureSafeFixtureDirectory(browserFixtureRoot, runRoot, 'browser fixture run directory');
}

function publicEnvironment() {
  const allowed = [
    'ComSpec',
    'HOME',
    'PATH',
    'Path',
    'PATHEXT',
    'PROCESSOR_ARCHITECTURE',
    'SystemDrive',
    'SystemRoot',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'WINDIR',
    'windir'
  ];
  const env = {};
  for (const key of allowed) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return {
    ...env,
    NODE_ENV: 'test',
    PORT: String(port),
    SERVER_HOST: '127.0.0.1',
    TM_DISABLE_DOTENV: '1',
    TM_UPLOAD_SANDBOX_TEST_MODE: 'local-worker',
    UPLOAD_SANDBOX_SPOOL_ROOT: path.join(runRoot, 'upload-spool'),
    DB_PATH: dbPath,
    TMP_DIR: path.join(runRoot, 'tmp'),
    PPT_CACHE_DIR: path.join(runRoot, 'ppt-cache'),
    JWT_SECRET: TEST_JWT_SECRET,
    OBISIDIAN_KB_ROOT: '',
    PLATFORM_KB_VAULT_ROOT: ''
  };
}

function waitForHealth(deadlineMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    function attempt() {
      const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          resolve();
          return;
        }
        retry();
      });
      req.on('error', retry);
      req.setTimeout(1_000, () => {
        req.destroy();
        retry();
      });
    }
    function retry() {
      if (Date.now() - started > deadlineMs) {
        reject(new Error(`Fixture server did not become healthy on port ${port}`));
        return;
      }
      setTimeout(attempt, 250);
    }
    attempt();
  });
}

function removeTempArtifacts() {
  try {
    ensureFixtureRoots();
    removeSafeFixtureDirectory(browserFixtureRoot, runRoot, 'browser fixture run directory');
  } catch (_error) {
    // Best-effort cleanup only; startup validation guards the path.
  }
}

cleanRunRoot();

const out = fs.openSync(stdoutPath, 'a');
const err = fs.openSync(stderrPath, 'a');
const child = spawn(process.execPath, ['server.js'], {
  cwd: serverRoot,
  env: publicEnvironment(),
  stdio: ['ignore', out, err],
  windowsHide: true
});

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (child.exitCode === null && !child.killed) {
    child.kill(signal === 'SIGINT' ? 'SIGINT' : 'SIGTERM');
  }
  setTimeout(() => {
    if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
  }, 2_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('exit', removeTempArtifacts);

child.on('exit', (code, signal) => {
  if (!shuttingDown && code !== 0) {
    process.stderr.write(`Fixture child server exited early with code=${code} signal=${signal || ''}\n`);
    process.exitCode = code || 1;
  }
  removeTempArtifacts();
  process.exit();
});

waitForHealth(60_000).then(() => {
  process.stdout.write(`Fixture server ready on http://127.0.0.1:${port}\n`);
}).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  shutdown('SIGTERM');
  process.exitCode = 1;
});

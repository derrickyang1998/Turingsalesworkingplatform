'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const Database = require('better-sqlite3');

const serverRoot = path.resolve(__dirname, '..');
const platformRoot = path.resolve(serverRoot, '..');
const verifierPath = path.join(serverRoot, 'scripts', 'verify_protected_credentials.js');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-protected-credentials-'));
  const databasePath = path.join(root, 'turingmarket.db');
  const overlayPath = path.join(root, 'security-overlay.json');
  const database = new Database(databasePath);
  database.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      is_active INTEGER NOT NULL,
      role TEXT NOT NULL,
      department TEXT,
      api_quota INTEGER NOT NULL
    )
  `);
  const users = [
    {
      id: 1,
      username: 'owner',
      password_hash: '$2b$12$baseline-owner-hash',
      is_active: 1,
      role: 'admin',
      department: 'management',
      api_quota: 1000
    },
    {
      id: 2,
      username: 'release-smoke',
      password_hash: '$2b$12$baseline-smoke-hash',
      is_active: 1,
      role: 'admin',
      department: 'engineering',
      api_quota: 100
    }
  ];
  const insert = database.prepare(`
    INSERT INTO users (id,username,password_hash,is_active,role,department,api_quota)
    VALUES (@id,@username,@password_hash,@is_active,@role,@department,@api_quota)
  `);
  for (const user of users) insert.run(user);
  database.close();
  fs.writeFileSync(overlayPath, JSON.stringify({ schemaVersion: 1, match: ['id', 'username'], users }));
  return { root, databasePath, overlayPath, users };
}

function verify({ databasePath, overlayPath }) {
  return spawnSync(process.execPath, [
    verifierPath,
    '--database', databasePath,
    '--overlay', overlayPath
  ], {
    cwd: serverRoot,
    encoding: 'utf8'
  });
}

test('protected credential verifier accepts an unchanged cutover security overlay', (t) => {
  const state = fixture();
  t.after(() => fs.rmSync(state.root, { recursive: true, force: true }));

  const result = verify(state);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'PROTECTED_CREDENTIALS_UNCHANGED 2');
  assert.equal(result.stderr, '');
});

test('protected credential verifier blocks a changed password hash without leaking either hash', (t) => {
  const state = fixture();
  t.after(() => fs.rmSync(state.root, { recursive: true, force: true }));
  const changedHash = '$2b$12$changed-secret-hash';
  const database = new Database(state.databasePath);
  database.prepare('UPDATE users SET password_hash = ? WHERE id = 1').run(changedHash);
  database.close();

  const result = verify(state);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PROTECTED_CREDENTIAL_CHANGED/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(state.users[0].password_hash.replace(/[$]/g, '\\$&')));
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(changedHash.replace(/[$]/g, '\\$&')));
});

test('protected credential verifier blocks identity-set drift', (t) => {
  const state = fixture();
  t.after(() => fs.rmSync(state.root, { recursive: true, force: true }));
  const database = new Database(state.databasePath);
  database.prepare('DELETE FROM users WHERE id = 2').run();
  database.close();

  const result = verify(state);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PROTECTED_CREDENTIAL_IDENTITY_DRIFT/);
});

test('production cutover checks protected credentials after acceptance mutations and after public activation', () => {
  const deploy = fs.readFileSync(path.join(platformRoot, 'deploy_v8.ps1'), 'utf8');
  const verifierCall = 'node server/scripts/verify_protected_credentials.js';
  const guardCall = '\nassert_protected_credentials_unchanged\n';
  const verifierDefinition = deploy.indexOf(verifierCall);
  const firstGuard = deploy.indexOf(guardCall);
  const acceptanceFacts = deploy.indexOf('\nrecord_acceptance_facts\n');
  const publicActivation = deploy.indexOf('\nactivate_public_candidate\n', acceptanceFacts);
  const finalGuard = deploy.indexOf(guardCall, firstGuard + guardCall.length);
  const finalFacts = deploy.indexOf('\nassert_final_acceptance_facts\n', publicActivation);

  assert.ok(verifierDefinition >= 0);
  assert.ok(firstGuard >= 0);
  assert.ok(firstGuard < acceptanceFacts);
  assert.ok(finalGuard > publicActivation);
  assert.ok(finalGuard < finalFacts);
  assert.match(deploy, /--overlay "\$CutoverSnapshot\/security-overlay\.json"/);
  assert.match(deploy, /test "\$ProtectedCredentialsOutput" = "PROTECTED_CREDENTIALS_UNCHANGED \$ProtectedCredentialCount"/);
  assert.match(deploy, /server\\scripts\\verify_protected_credentials\.js/);
  assert.match(deploy, /server\\tests\\protected_credentials_release_guard\.test\.js/);
});

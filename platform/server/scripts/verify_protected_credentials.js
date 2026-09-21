'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!['--database', '--overlay'].includes(name) || typeof value !== 'string') {
      throw new Error('PROTECTED_CREDENTIAL_ARGUMENT_ERROR');
    }
    options[name.slice(2)] = value;
  }
  if (!options.database || !options.overlay) {
    throw new Error('PROTECTED_CREDENTIAL_ARGUMENT_ERROR');
  }
  return options;
}

function assertRegularAbsoluteFile(filePath) {
  if (!path.isAbsolute(filePath)) throw new Error('PROTECTED_CREDENTIAL_PATH_ERROR');
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('PROTECTED_CREDENTIAL_PATH_ERROR');
}

function parseOverlay(overlayPath) {
  const stat = fs.statSync(overlayPath);
  if (stat.size <= 0 || stat.size > 16 * 1024 * 1024) {
    throw new Error('PROTECTED_CREDENTIAL_OVERLAY_INVALID');
  }
  let overlay;
  try {
    overlay = JSON.parse(fs.readFileSync(overlayPath, 'utf8'));
  } catch {
    throw new Error('PROTECTED_CREDENTIAL_OVERLAY_INVALID');
  }
  if (
    !overlay || overlay.schemaVersion !== 1 ||
    !Array.isArray(overlay.match) || overlay.match.length !== 2 ||
    overlay.match[0] !== 'id' || overlay.match[1] !== 'username' ||
    !Array.isArray(overlay.users)
  ) {
    throw new Error('PROTECTED_CREDENTIAL_OVERLAY_INVALID');
  }
  const seenIds = new Set();
  const seenUsernames = new Set();
  const users = overlay.users.map((user) => {
    if (
      !user || !Number.isSafeInteger(user.id) || user.id <= 0 ||
      typeof user.username !== 'string' || user.username.length === 0 ||
      typeof user.password_hash !== 'string' || user.password_hash.length === 0 ||
      seenIds.has(user.id) || seenUsernames.has(user.username)
    ) {
      throw new Error('PROTECTED_CREDENTIAL_OVERLAY_INVALID');
    }
    seenIds.add(user.id);
    seenUsernames.add(user.username);
    return {
      id: user.id,
      username: user.username,
      password_hash: user.password_hash
    };
  });
  return users.sort((left, right) => left.id - right.id);
}

function sameSecret(left, right) {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length === rightBytes.length && crypto.timingSafeEqual(leftBytes, rightBytes);
}

function verifyProtectedCredentials(databasePath, overlayPath) {
  assertRegularAbsoluteFile(databasePath);
  assertRegularAbsoluteFile(overlayPath);
  const expected = parseOverlay(overlayPath);
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  let actual;
  try {
    if (database.pragma('quick_check', { simple: true }) !== 'ok') {
      throw new Error('PROTECTED_CREDENTIAL_DATABASE_INVALID');
    }
    actual = database.prepare(`
      SELECT id,username,password_hash
      FROM users
      ORDER BY id
    `).all();
  } finally {
    database.close();
  }

  if (actual.length !== expected.length) {
    throw new Error('PROTECTED_CREDENTIAL_IDENTITY_DRIFT');
  }
  for (let index = 0; index < expected.length; index += 1) {
    const baseline = expected[index];
    const current = actual[index];
    if (current.id !== baseline.id || current.username !== baseline.username) {
      throw new Error('PROTECTED_CREDENTIAL_IDENTITY_DRIFT');
    }
    if (!sameSecret(current.password_hash, baseline.password_hash)) {
      throw new Error('PROTECTED_CREDENTIAL_CHANGED');
    }
  }
  return expected.length;
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const count = verifyProtectedCredentials(options.database, options.overlay);
    process.stdout.write(`PROTECTED_CREDENTIALS_UNCHANGED ${count}\n`);
  } catch (error) {
    const code = /^PROTECTED_CREDENTIAL_[A-Z_]+$/.test(error && error.message)
      ? error.message
      : 'PROTECTED_CREDENTIAL_VERIFICATION_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { verifyProtectedCredentials };

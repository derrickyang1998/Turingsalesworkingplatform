#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { rotateUserPasswords } = require('../services/credential_rotation_service');

function printSummary(rotatedUsers, sessionsRevoked) {
  process.stdout.write([
    'ROTATED_USERS=' + rotatedUsers,
    'SESSIONS_REVOKED=' + sessionsRevoked,
    'PASSWORD_VALUES_PRINTED=0'
  ].join('\n') + '\n');
}

function fail() {
  printSummary(0, 0);
  process.exitCode = 1;
}

function loadDatabase() {
  const originalLog = console.log;
  try {
    console.log = function() {};
    return require(path.join(__dirname, '..', 'db'));
  } finally {
    console.log = originalLog;
  }
}

function readPayload() {
  if (process.stdin.isTTY) {
    throw new Error('stdin JSON is required');
  }
  const input = fs.readFileSync(0, 'utf8');
  if (!input || !input.trim()) {
    throw new Error('stdin JSON is required');
  }
  return JSON.parse(input);
}

function resolveActor(db, actorUsername) {
  const username = String(actorUsername || '').trim();
  if (!username) {
    throw new Error('actor_username is required');
  }
  const actor = db.prepare(`
    SELECT id, username, role
    FROM users
    WHERE username = ? AND is_active = 1
  `).get(username);
  if (!actor || actor.role !== 'admin') {
    throw new Error('actor_username must identify an active administrator');
  }
  return actor;
}

function main() {
  let db;
  try {
    const payload = readPayload();
    db = loadDatabase();
    const actor = resolveActor(db, payload.actor_username);
    const result = rotateUserPasswords(db, {
      actorUserId: Number(actor.id),
      rotations: payload.rotations,
      invalidateAllSessions: Boolean(payload.invalidate_all_sessions),
      ipAddress: '127.0.0.1',
      reason: payload.reason || 'stdin credential rotation'
    });
    printSummary(result.rotatedUsers.length, result.sessionsRevoked);
  } catch (_error) {
    fail();
  } finally {
    if (db && typeof db.close === 'function' && db.open) {
      db.close();
    }
  }
}

main();

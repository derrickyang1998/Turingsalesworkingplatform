const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const bcrypt = require('bcryptjs');

const {
  passwordPolicyErrors,
  generateTemporaryPassword,
  rotateUserPasswords
} = require('../services/credential_rotation_service');

function freshDb() {
  const dbPath = path.join(os.tmpdir(), `tm-credential-rotation-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  process.env.DB_PATH = dbPath;
  process.env.DEFAULT_ADMIN_PASSWORD = 'test-only-admin-password';
  delete process.env.DEFAULT_ADMIN_USERNAME;
  const dbModule = path.resolve(__dirname, '../db.js');
  delete require.cache[dbModule];
  return require(dbModule);
}

function credentialAuditCount(db) {
  return db.prepare('SELECT COUNT(*) AS count FROM activity_log WHERE action = ?').get('credential_rotation').count;
}

function getUser(db, username) {
  return db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(username);
}

function insertSession(db, userId, token) {
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (user_id, token, ip_address, expires_at) VALUES (?, ?, ?, ?)').run(userId, token, '127.0.0.1', expiresAt);
}

function assertNoSecretLeak(value, secrets) {
  const text = JSON.stringify(value);
  secrets.forEach(function(secret) {
    assert.equal(text.includes(secret), false, 'secret leaked: ' + secret);
  });
  assert.doesNotMatch(text, /\$2[aby]\$/i);
  assert.doesNotMatch(text, /password/i);
}

test('password policy reports short passwords and missing required categories', () => {
  assert.deepEqual(passwordPolicyErrors('Aa1!Aa1!Aa1!'), []);
  assert.deepEqual(passwordPolicyErrors('Aa1!'), ['Password must be at least 12 characters long.']);
  assert.deepEqual(passwordPolicyErrors('lowercase1!x'), ['Password must include an uppercase letter.']);
  assert.deepEqual(passwordPolicyErrors('UPPERCASE1!X'), ['Password must include a lowercase letter.']);
  assert.deepEqual(passwordPolicyErrors('NoDigitsHere!'), ['Password must include a digit.']);
  assert.deepEqual(passwordPolicyErrors('NoSymbol1234'), ['Password must include a symbol.']);
});

test('temporary passwords are long and satisfy every required category', () => {
  for (let index = 0; index < 25; index += 1) {
    const password = generateTemporaryPassword();
    assert.equal(password.length >= 20, true);
    assert.deepEqual(passwordPolicyErrors(password), []);
  }
});

test('rotation rejects invalid passwords before mutating users, sessions, or audit logs', () => {
  const db = freshDb();
  const user = db.prepare('SELECT id, password_hash FROM users WHERE username = ?').get('zhangwei');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (user_id, token, ip_address, expires_at) VALUES (?, ?, ?, ?)').run(user.id, 'weak-session', '127.0.0.1', expiresAt);

  const before = {
    hash: user.password_hash,
    sessions: db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count,
    audits: credentialAuditCount(db)
  };

  assert.throws(function() {
    rotateUserPasswords(db, {
      actorUserId: 1,
      rotations: [{ username: 'zhangwei', password: 'TooShort1!' }],
      invalidateAllSessions: true,
      ipAddress: '127.0.0.1',
      reason: 'policy test'
    });
  }, /Password policy failed for zhangwei/);

  assert.equal(db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id).password_hash, before.hash);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, before.sessions);
  assert.equal(credentialAuditCount(db), before.audits);

  db.close();
});

test('multi-user rotation changes hashes, revokes affected sessions, and writes sanitized audit rows', () => {
  const db = freshDb();
  const actor = getUser(db, 'admin');
  const zhangwei = getUser(db, 'zhangwei');
  const wangfang = getUser(db, 'wangfang');
  const liming = getUser(db, 'liming');
  insertSession(db, zhangwei.id, 'zhangwei-session-1');
  insertSession(db, zhangwei.id, 'zhangwei-session-2');
  insertSession(db, wangfang.id, 'wangfang-session-1');
  insertSession(db, liming.id, 'liming-session-1');

  const rotations = [
    { username: 'zhangwei', password: 'RotatedZhang1!Secure' },
    { username: 'wangfang', password: 'RotatedWang2!Secure' }
  ];
  const result = rotateUserPasswords(db, {
    actorUserId: actor.id,
    rotations,
    invalidateAllSessions: false,
    ipAddress: '10.0.0.9',
    reason: 'incident response'
  });

  assert.deepEqual(result.rotatedUsers.map(function(user) { return user.username; }).sort(), ['wangfang', 'zhangwei']);
  assert.equal(result.sessionsRevoked, 3);
  assertNoSecretLeak(result, rotations.map(function(rotation) { return rotation.password; }));

  const zhangweiAfter = getUser(db, 'zhangwei');
  const wangfangAfter = getUser(db, 'wangfang');
  assert.notEqual(zhangweiAfter.password_hash, zhangwei.password_hash);
  assert.notEqual(wangfangAfter.password_hash, wangfang.password_hash);
  assert.equal(bcrypt.compareSync(rotations[0].password, zhangweiAfter.password_hash), true);
  assert.equal(bcrypt.compareSync(rotations[1].password, wangfangAfter.password_hash), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id IN (?, ?)').get(zhangwei.id, wangfang.id).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?').get(liming.id).count, 1);

  const audits = db.prepare('SELECT user_id, action, module, details, ip_address FROM activity_log WHERE action = ? ORDER BY id').all('credential_rotation');
  assert.equal(audits.length, 2);
  assert.deepEqual(audits.map(function(row) { return JSON.parse(row.details).targetUsername; }).sort(), ['wangfang', 'zhangwei']);
  audits.forEach(function(row) {
    const details = JSON.parse(row.details);
    assert.equal(row.user_id, actor.id);
    assert.equal(row.module, 'security');
    assert.equal(row.ip_address, '10.0.0.9');
    assert.equal(details.actorUserId, actor.id);
    assert.equal(details.reason, 'incident response');
    assert.equal(details.invalidateAllSessions, false);
    assert.equal(typeof details.targetUserId, 'number');
    assertNoSecretLeak(details, rotations.map(function(rotation) { return rotation.password; }));
  });

  db.close();
});

test('rotation can revoke all active sessions when requested', () => {
  const db = freshDb();
  const actor = getUser(db, 'admin');
  const zhangwei = getUser(db, 'zhangwei');
  const liming = getUser(db, 'liming');
  insertSession(db, zhangwei.id, 'zhangwei-global-rotation');
  insertSession(db, liming.id, 'liming-global-rotation');

  const result = rotateUserPasswords(db, {
    actorUserId: actor.id,
    rotations: [{ username: 'zhangwei', password: 'GlobalRotate1!Secure' }],
    invalidateAllSessions: true,
    ipAddress: '10.0.0.10',
    reason: 'global revocation'
  });

  assert.equal(result.sessionsRevoked, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
  const audit = db.prepare('SELECT details FROM activity_log WHERE action = ?').get('credential_rotation');
  assert.equal(JSON.parse(audit.details).invalidateAllSessions, true);

  db.close();
});

test('rotation rolls back password and session changes when audit logging fails', () => {
  const db = freshDb();
  const actor = getUser(db, 'admin');
  const zhangwei = getUser(db, 'zhangwei');
  const wangfang = getUser(db, 'wangfang');
  insertSession(db, zhangwei.id, 'atomic-zhangwei');
  insertSession(db, wangfang.id, 'atomic-wangfang');
  db.exec(`
    CREATE TRIGGER fail_credential_rotation_audit
    BEFORE INSERT ON activity_log
    WHEN NEW.action = 'credential_rotation'
    BEGIN
      SELECT RAISE(ABORT, 'audit offline');
    END;
  `);

  assert.throws(function() {
    rotateUserPasswords(db, {
      actorUserId: actor.id,
      rotations: [
        { username: 'zhangwei', password: 'AtomicZhang1!Secure' },
        { username: 'wangfang', password: 'AtomicWang2!Secure' }
      ],
      invalidateAllSessions: false,
      ipAddress: '10.0.0.11',
      reason: 'atomicity test'
    });
  }, /audit offline/);

  assert.equal(getUser(db, 'zhangwei').password_hash, zhangwei.password_hash);
  assert.equal(getUser(db, 'wangfang').password_hash, wangfang.password_hash);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 2);
  assert.equal(credentialAuditCount(db), 0);

  db.close();
});

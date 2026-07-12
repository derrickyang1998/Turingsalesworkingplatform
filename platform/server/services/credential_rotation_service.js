const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const UPPERCASE = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWERCASE = 'abcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%^&*()-_=+[]{};:,.?';
const ALL_PASSWORD_CHARS = UPPERCASE + LOWERCASE + DIGITS + SYMBOLS;

function passwordPolicyErrors(password) {
  const value = String(password === undefined || password === null ? '' : password);
  const errors = [];
  if (value.length < 12) errors.push('Password must be at least 12 characters long.');
  if (!/[A-Z]/.test(value)) errors.push('Password must include an uppercase letter.');
  if (!/[a-z]/.test(value)) errors.push('Password must include a lowercase letter.');
  if (!/[0-9]/.test(value)) errors.push('Password must include a digit.');
  if (!/[^A-Za-z0-9]/.test(value)) errors.push('Password must include a symbol.');
  return errors;
}

function randomCharacter(chars) {
  return chars[crypto.randomInt(chars.length)];
}

function shuffle(chars) {
  const output = chars.slice();
  for (let index = output.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(index + 1);
    const current = output[index];
    output[index] = output[swapIndex];
    output[swapIndex] = current;
  }
  return output;
}

function generateTemporaryPassword() {
  const chars = [
    randomCharacter(UPPERCASE),
    randomCharacter(LOWERCASE),
    randomCharacter(DIGITS),
    randomCharacter(SYMBOLS)
  ];
  while (chars.length < 24) {
    chars.push(randomCharacter(ALL_PASSWORD_CHARS));
  }
  return shuffle(chars).join('');
}

function validateRotations(rotations) {
  if (!Array.isArray(rotations) || rotations.length === 0) {
    throw new Error('At least one credential rotation is required.');
  }

  const seen = new Set();
  return rotations.map(function(rotation) {
    const username = String(rotation && rotation.username ? rotation.username : '').trim();
    const password = rotation && rotation.password;
    const errors = passwordPolicyErrors(rotation && rotation.password);
    if (!username) {
      throw new Error('Credential rotation username is required.');
    }
    if (seen.has(username)) {
      throw new Error('Duplicate credential rotation for ' + username + '.');
    }
    seen.add(username);
    if (errors.length) {
      throw new Error('Password policy failed for ' + username + ': ' + errors.join(' '));
    }
    return { username: username, password: password };
  });
}

function requireActorUserId(actorUserId) {
  const id = Number(actorUserId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('actorUserId is required for credential rotation.');
  }
  return id;
}

function redactPasswords(value, passwords) {
  let sanitized = String(value);
  passwords
    .slice()
    .sort(function(left, right) { return right.length - left.length; })
    .forEach(function(password) {
      sanitized = sanitized.split(password).join('[REDACTED]');
    });
  return sanitized;
}

function loadUsers(db, rotations) {
  const selectUser = db.prepare('SELECT id, username FROM users WHERE username = ? AND is_active = 1');
  return rotations.map(function(rotation) {
    const user = selectUser.get(rotation.username);
    if (!user) throw new Error('Active user not found for credential rotation: ' + rotation.username);
    return Object.assign({}, rotation, {
      userId: Number(user.id),
      username: user.username,
      hash: bcrypt.hashSync(rotation.password, bcrypt.genSaltSync(10))
    });
  });
}

function deleteAffectedSessions(db, userIds) {
  const placeholders = userIds.map(function() { return '?'; }).join(', ');
  return db.prepare('DELETE FROM sessions WHERE user_id IN (' + placeholders + ')').run(...userIds).changes;
}

function rotateUserPasswords(db, options) {
  options = options || {};
  const rotations = validateRotations(options.rotations);
  const actorUserId = requireActorUserId(options.actorUserId);
  const users = loadUsers(db, rotations);
  const userIds = users.map(function(user) { return user.userId; });
  const passwords = rotations.map(function(rotation) { return String(rotation.password); });
  const invalidateAllSessions = Boolean(options.invalidateAllSessions);
  const ipAddress = options.ipAddress ? redactPasswords(options.ipAddress, passwords) : null;
  const reason = options.reason ? redactPasswords(options.reason, passwords) : '';

  const transaction = db.transaction(function() {
    const updateUser = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');
    users.forEach(function(user) {
      updateUser.run(user.hash, user.userId);
    });

    const sessionsRevoked = invalidateAllSessions
      ? db.prepare('DELETE FROM sessions').run().changes
      : deleteAffectedSessions(db, userIds);

    const insertAudit = db.prepare(`
      INSERT INTO activity_log (user_id, action, module, details, ip_address)
      VALUES (?, ?, ?, ?, ?)
    `);
    users.forEach(function(user) {
      insertAudit.run(actorUserId, 'credential_rotation', 'security', JSON.stringify({
        actorUserId: actorUserId,
        targetUserId: user.userId,
        targetUsername: redactPasswords(user.username, passwords),
        reason: reason,
        invalidateAllSessions: invalidateAllSessions,
        sessionsRevoked: sessionsRevoked
      }), ipAddress);
    });

    return {
      rotatedUserIds: userIds.slice(),
      rotatedCount: userIds.length,
      sessionsRevoked: sessionsRevoked
    };
  });

  return transaction();
}

module.exports = {
  passwordPolicyErrors,
  generateTemporaryPassword,
  rotateUserPasswords
};

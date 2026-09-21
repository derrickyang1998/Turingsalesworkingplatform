'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const RELEASE_SMOKE_USERNAME = 'release-smoke';
const RELEASE_SMOKE_DISPLAY_NAME = 'Release Smoke';
const RELEASE_SMOKE_DEPARTMENT = 'platform_release';

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function normalizeOrganizationId(value) {
  const organizationId = Number(value);
  if (!Number.isSafeInteger(organizationId) || organizationId <= 0) {
    fail('RELEASE_SMOKE_ORGANIZATION_ID_INVALID');
  }
  return organizationId;
}

function defaultCreatePasswordHash() {
  const password = crypto.randomBytes(48).toString('base64url');
  return bcrypt.hashSync(password, bcrypt.genSaltSync(12));
}

function isExactExistingIdentity(db, user, organizationId) {
  if (
    user.role !== 'admin'
    || user.display_name !== RELEASE_SMOKE_DISPLAY_NAME
    || user.department !== RELEASE_SMOKE_DEPARTMENT
    || Number(user.api_quota) !== 0
    || Number(user.is_active) !== 1
    || typeof user.password_hash !== 'string'
    || user.password_hash.length === 0
  ) {
    return false;
  }

  const memberships = db.prepare(`
    SELECT org_id,role_code,status
    FROM organization_memberships
    WHERE user_id=?
    ORDER BY org_id
  `).all(user.id);
  if (
    memberships.length !== 1
    || Number(memberships[0].org_id) !== organizationId
    || memberships[0].role_code !== 'org_admin'
    || memberships[0].status !== 'active'
  ) {
    return false;
  }

  const policies = db.prepare(`
    SELECT org_id,access_mode
    FROM organization_member_policy
    WHERE user_id=?
    ORDER BY org_id
  `).all(user.id);
  return policies.length === 1
    && Number(policies[0].org_id) === organizationId
    && policies[0].access_mode === 'read_write';
}

function provisionReleaseSmokeIdentity(db, options = {}) {
  if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') {
    throw new TypeError('release smoke identity provisioner requires a SQLite database');
  }
  const organizationId = normalizeOrganizationId(options.organizationId);
  const organization = db.prepare('SELECT id FROM organizations WHERE id=?').get(organizationId);
  if (!organization) {
    fail('RELEASE_SMOKE_ORGANIZATION_NOT_FOUND');
  }

  const existing = db.prepare(`
    SELECT id,username,password_hash,display_name,role,department,api_quota,is_active
    FROM users
    WHERE username=?
  `).get(RELEASE_SMOKE_USERNAME);
  if (existing) {
    if (!isExactExistingIdentity(db, existing, organizationId)) {
      fail('RELEASE_SMOKE_IDENTITY_CONFLICT');
    }
    return { status: 'existing', username: RELEASE_SMOKE_USERNAME };
  }

  const createPasswordHash = typeof options.createPasswordHash === 'function'
    ? options.createPasswordHash
    : defaultCreatePasswordHash;
  const provision = db.transaction(() => {
    const concurrent = db.prepare('SELECT id FROM users WHERE username=?').get(RELEASE_SMOKE_USERNAME);
    if (concurrent) {
      fail('RELEASE_SMOKE_IDENTITY_CONFLICT');
    }

    const passwordHash = createPasswordHash();
    if (typeof passwordHash !== 'string' || passwordHash.length === 0) {
      fail('RELEASE_SMOKE_CREDENTIAL_GENERATION_FAILED');
    }
    const inserted = db.prepare(`
      INSERT INTO users (
        username,password_hash,display_name,role,email,department,api_quota,is_active
      ) VALUES (?,?,?,?,NULL,?,?,1)
    `).run(
      RELEASE_SMOKE_USERNAME,
      passwordHash,
      RELEASE_SMOKE_DISPLAY_NAME,
      'admin',
      RELEASE_SMOKE_DEPARTMENT,
      0
    );
    const userId = Number(inserted.lastInsertRowid);

    db.prepare(`
      INSERT INTO organization_memberships (org_id,user_id,role_code,status)
      VALUES (?,?,?,?)
    `).run(organizationId, userId, 'org_admin', 'active');
    db.prepare(`
      INSERT INTO organization_member_policy (org_id,user_id,access_mode)
      VALUES (?,?,?)
    `).run(organizationId, userId, 'read_write');
    db.prepare(`
      INSERT INTO activity_log (user_id,action,module,details,ip_address)
      VALUES (?,?,?,?,NULL)
    `).run(
      userId,
      'release_smoke_identity_provisioned',
      'security',
      JSON.stringify({ username: RELEASE_SMOKE_USERNAME, organizationId, purpose: 'release_acceptance' })
    );
  });
  provision.immediate();
  return { status: 'created', username: RELEASE_SMOKE_USERNAME };
}

function parseCliArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 4) {
    fail('RELEASE_SMOKE_ARGUMENTS_INVALID');
  }
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--database', '--organization-id'].includes(flag) || values.has(flag) || !value) {
      fail('RELEASE_SMOKE_ARGUMENTS_INVALID');
    }
    values.set(flag, value);
  }
  if (!values.has('--database') || !values.has('--organization-id')) {
    fail('RELEASE_SMOKE_ARGUMENTS_INVALID');
  }
  return {
    databasePath: values.get('--database'),
    organizationId: normalizeOrganizationId(values.get('--organization-id'))
  };
}

function assertRegularDatabasePath(databasePath) {
  if (typeof databasePath !== 'string' || !path.isAbsolute(databasePath)) {
    fail('RELEASE_SMOKE_DATABASE_PATH_INVALID');
  }
  const entry = fs.lstatSync(databasePath);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    fail('RELEASE_SMOKE_DATABASE_PATH_INVALID');
  }
  return databasePath;
}

function runCli(argv = process.argv.slice(2)) {
  const input = parseCliArguments(argv);
  const databasePath = assertRegularDatabasePath(input.databasePath);
  const db = new Database(databasePath, { fileMustExist: true });
  try {
    db.pragma('foreign_keys = ON');
    const result = provisionReleaseSmokeIdentity(db, input);
    process.stdout.write(`RELEASE_SMOKE_IDENTITY_READY ${result.status}\n`);
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try {
    runCli();
  } catch (error) {
    const code = error && typeof error.code === 'string'
      ? error.code
      : 'RELEASE_SMOKE_PROVISION_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  RELEASE_SMOKE_USERNAME,
  provisionReleaseSmokeIdentity,
  parseCliArguments,
  assertRegularDatabasePath,
  runCli
};

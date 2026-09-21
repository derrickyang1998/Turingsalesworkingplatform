'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');

const { createOrganizationBillingService } = require('../services/organization_billing_service');
const billingMigration = require('../migrations/031_organization_billing_statements');

const RELEASE_SMOKE_USERNAME = 'release-smoke';

function acceptanceError(message) {
  const error = new Error(message);
  error.name = 'OrganizationBillingAcceptanceError';
  return error;
}

function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function shiftMonth(key, amount) {
  const [year, month] = key.split('-').map(Number);
  return monthKey(new Date(Date.UTC(year, month - 1 + amount, 1)));
}

function clock(options) {
  const value = typeof options.now === 'function' ? options.now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw acceptanceError('Billing acceptance clock is invalid.');
  return date;
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!/^--(?:run-id|evidence|base-url)$/.test(key || '') || typeof value !== 'string') {
      throw acceptanceError('Usage: --run-id <32 hex> --evidence <absolute path> --base-url <loopback URL>');
    }
    values[key.slice(2)] = value;
  }
  if (!/^[0-9a-f]{32}$/.test(values['run-id'] || '')) throw acceptanceError('Deployment run id is invalid.');
  if (!path.isAbsolute(values.evidence || '')) throw acceptanceError('Acceptance evidence path must be absolute.');
  const baseUrl = new URL(values['base-url'] || '');
  if (baseUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(baseUrl.hostname)) {
    throw acceptanceError('Acceptance base URL must be loopback HTTP.');
  }
  return { runId: values['run-id'], evidencePath: values.evidence, baseUrl: baseUrl.origin };
}

function resolveAcceptanceActor(db) {
  const row = db.prepare(`
    SELECT user.id AS user_id,user.username,user.role,organization.id AS organization_id
    FROM users user
    JOIN organization_memberships membership
      ON membership.user_id=user.id AND membership.status='active'
    JOIN organizations organization ON organization.id=membership.org_id
    LEFT JOIN organization_authority authority ON authority.org_id=organization.id
    WHERE user.username=? AND user.role='admin' AND user.is_active=1
      AND (membership.role_code='org_admin' OR authority.owner_user_id=user.id)
    ORDER BY user.id,organization.id
    LIMIT 1
  `).get(RELEASE_SMOKE_USERNAME);
  if (!row) throw acceptanceError('No dedicated release smoke administrator can read organization billing.');
  return {
    userId: Number(row.user_id),
    organizationId: Number(row.organization_id),
    role: row.role,
    username: row.username
  };
}

function policySnapshot(projection) {
  return {
    billingEnabled: projection.policy.billing_enabled,
    baseFeeCents: projection.policy.base_fee_cents,
    includedTokens: projection.policy.included_tokens,
    overageCentsPerMillionTokens: projection.policy.overage_cents_per_million_tokens,
    currency: projection.policy.currency,
    totalTokens: projection.usage.total_tokens,
    totalCents: projection.charges.total_cents,
    status: projection.status
  };
}

function semanticMatch(left, right) {
  return JSON.stringify(policySnapshot(left)) === JSON.stringify(policySnapshot(right));
}

function latestPolicyVersion(db, organizationId) {
  const row = db.prepare(`
    SELECT MAX(policy_version) AS policy_version
    FROM organization_billing_policies WHERE org_id=?
  `).get(organizationId);
  const version = Number(row && row.policy_version);
  if (!Number.isSafeInteger(version) || version < 1) throw acceptanceError('Billing policy version is unavailable.');
  return version;
}

async function getJson(url, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Acceptance HTTP request timed out.')), 15000);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal
    });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw acceptanceError('Billing acceptance API did not return JSON.');
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function writeEvidence(evidencePath, payload) {
  const directory = path.dirname(evidencePath);
  const resolvedDirectory = fs.realpathSync(directory);
  if (resolvedDirectory !== directory) throw acceptanceError('Acceptance evidence directory is not canonical.');
  const descriptor = fs.openSync(evidencePath, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf8' });
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(evidencePath, 0o600);
}

function sourceBillingFingerprint(db) {
  return {
    policies: Number(db.prepare('SELECT COUNT(*) AS count FROM organization_billing_policies').get().count),
    statements: Number(db.prepare('SELECT COUNT(*) AS count FROM organization_billing_statements').get().count),
    audits: Number(db.prepare("SELECT COUNT(*) AS count FROM activity_log WHERE module='organization_billing'").get().count),
    policyHead: Number(db.prepare('SELECT COALESCE(MAX(id),0) AS value FROM organization_billing_policies').get().value),
    statementHead: Number(db.prepare('SELECT COALESCE(MAX(id),0) AS value FROM organization_billing_statements').get().value)
  };
}

async function isolatedCloseProof(sourceDb, input) {
  const before = sourceBillingFingerprint(sourceDb);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-billing-close-proof-'));
  const clonePath = path.join(directory, 'billing-proof.sqlite');
  fs.chmodSync(directory, 0o700);
  let clone = null;
  try {
    await sourceDb.backup(clonePath);
    fs.chmodSync(clonePath, 0o600);
    clone = new Database(clonePath);
    clone.pragma('foreign_keys = ON');
    const integrity = clone.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok' || clone.pragma('foreign_key_check').length !== 0) {
      throw acceptanceError('Isolated billing clone failed integrity checks.');
    }
    const databaseNow = clone.prepare('SELECT CURRENT_TIMESTAMP AS value').get().value;
    const cloneClock = () => new Date(`${databaseNow.replace(' ', 'T')}Z`);
    let period = clone.prepare("SELECT strftime('%Y-%m','now','start of month','-1 month') AS value").get().value;
    for (let attempts = 0; attempts < 240; attempts += 1) {
      const exists = clone.prepare(`
        SELECT 1 AS present FROM organization_billing_statements
        WHERE org_id=? AND period_key=?
      `).get(input.organizationId, period);
      if (!exists) break;
      period = shiftMonth(period, -1);
      if (attempts === 239) throw acceptanceError('No unused ended billing period is available in the isolated clone.');
    }

    clone.exec('DROP TRIGGER organization_billing_policy_insert_guard;');
    const policyVersion = latestPolicyVersion(clone, input.organizationId) + 1;
    clone.prepare(`
      INSERT INTO organization_billing_policies (
        org_id,policy_version,effective_month,billing_enabled,currency,base_fee_cents,
        included_tokens,overage_cents_per_million_tokens,changed_by,reason,source
      ) VALUES (?, ?, ?, 1, 'USD', 1, 0, 0, ?, ?, 'admin_update')
    `).run(
      input.organizationId,
      policyVersion,
      `${period}-01`,
      input.actorUserId,
      `deployment acceptance ${input.runId} isolated close policy`
    );
    clone.exec(billingMigration.schemaManifest.triggers.organization_billing_policy_insert_guard + ';');

    const closingService = createOrganizationBillingService(clone, { now: cloneClock });
    const closeInput = {
      actorUserId: input.actorUserId,
      organizationId: input.organizationId,
      period,
      expectedPolicyVersion: policyVersion,
      reason: `deployment acceptance ${input.runId} isolated close`,
      requestId: input.runId,
      ipAddress: '127.0.0.1'
    };
    const closed = closingService.closeOrganizationBillingStatement(closeInput);
    const replay = closingService.closeOrganizationBillingStatement(closeInput);
    if (
      closed.status !== 'closed' || closed.idempotent_replay !== false ||
      replay.idempotent_replay !== true ||
      replay.statement.statement_sha256 !== closed.statement.statement_sha256 ||
      !/^[a-f0-9]{64}$/.test(closed.statement.statement_sha256)
    ) {
      throw acceptanceError('Billing statement close or idempotent replay proof failed.');
    }
    let updateBlocked = false;
    let deleteBlocked = false;
    try {
      clone.prepare('UPDATE organization_billing_statements SET total_cents=0 WHERE id=?').run(closed.statement.id);
    } catch {
      updateBlocked = true;
    }
    try {
      clone.prepare('DELETE FROM organization_billing_statements WHERE id=?').run(closed.statement.id);
    } catch {
      deleteBlocked = true;
    }
    if (!updateBlocked || !deleteBlocked) throw acceptanceError('Billing statement immutability proof failed.');
    const afterIntegrity = clone.pragma('integrity_check', { simple: true });
    if (afterIntegrity !== 'ok' || clone.pragma('foreign_key_check').length !== 0) {
      throw acceptanceError('Isolated billing close damaged clone integrity.');
    }
    const sourceUnchanged = JSON.stringify(before) === JSON.stringify(sourceBillingFingerprint(sourceDb));
    if (!sourceUnchanged) throw acceptanceError('Isolated billing close changed the production source database.');
    return {
      isolatedClone: true,
      sourceUnchanged,
      period,
      formulaVersion: closed.statement.formula_version,
      totalCents: closed.statement.total_cents,
      statementSha256: closed.statement.statement_sha256,
      idempotentReplay: true,
      updateBlocked,
      deleteBlocked,
      integrityCheck: afterIntegrity
    };
  } finally {
    if (clone) clone.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function runAcceptance(options) {
  const db = options.db;
  const actor = options.actor;
  const runId = options.runId;
  const evidencePath = options.evidencePath;
  const baseUrl = options.baseUrl;
  const httpGet = options.httpGet || getJson;
  if (
    !db || !actor || actor.username !== RELEASE_SMOKE_USERNAME || actor.role !== 'admin' ||
    !/^[0-9a-f]{32}$/.test(runId || '') || fs.existsSync(evidencePath)
  ) {
    throw acceptanceError('Billing acceptance inputs are invalid.');
  }
  const currentDate = clock(options);
  const effectiveMonth = shiftMonth(monthKey(currentDate), 1);
  const service = createOrganizationBillingService(db, { now: () => currentDate });
  const original = service.projectOrganizationBilling({
    organizationId: actor.organizationId,
    month: effectiveMonth
  });
  let temporaryApplied = false;
  let restored = null;
  let sessionToken = null;
  let cleanupError = null;
  let resultError = null;
  let httpEvidence = null;
  let closeEvidence = null;

  try {
    const temporaryEnabled = !original.policy.billing_enabled;
    service.updateOrganizationBillingPolicy({
      actorUserId: actor.userId,
      organizationId: actor.organizationId,
      billingEnabled: temporaryEnabled,
      baseFeeCents: temporaryEnabled ? 0 : 0,
      includedTokens: 0,
      overageCentsPerMillionTokens: 0,
      effectiveMonth,
      expectedVersion: latestPolicyVersion(db, actor.organizationId),
      reason: `deployment acceptance ${runId} temporary policy`,
      requestId: runId,
      ipAddress: '127.0.0.1'
    });
    temporaryApplied = true;
    sessionToken = jwt.sign(
      { userId: actor.userId, role: actor.role, jti: crypto.randomUUID() },
      options.jwtSecret,
      { expiresIn: '5m' }
    );
    db.prepare(`
      INSERT INTO sessions (user_id,token,ip_address,expires_at)
      VALUES (?,?,?,?)
    `).run(actor.userId, sessionToken, '127.0.0.1', new Date(currentDate.getTime() + 300000).toISOString());

    const adminRead = await httpGet(
      `${baseUrl}/api/admin/organizations/${actor.organizationId}/billing?month=${effectiveMonth}`,
      sessionToken
    );
    if (
      adminRead.status !== 200 || !adminRead.body || !adminRead.body.billing ||
      Number(adminRead.body.billing.organization_id) !== actor.organizationId
    ) {
      throw acceptanceError('Billing HTTP read contract failed.');
    }
    const override = await httpGet(
      `${baseUrl}/api/organization-billing?month=${effectiveMonth}&organizationId=${actor.organizationId + 1}`,
      sessionToken
    );
    if (override.status !== 400 || !override.body || override.body.code !== 'ORGANIZATION_BILLING_INVALID') {
      throw acceptanceError('Billing tenant override denial contract failed.');
    }
    httpEvidence = { adminRead: true, tenantOverrideDenied: true };
  } catch (error) {
    resultError = error;
  } finally {
    if (sessionToken) {
      try {
        db.prepare('DELETE FROM sessions WHERE token=?').run(sessionToken);
      } catch (error) {
        cleanupError = cleanupError || error;
      }
    }
    if (temporaryApplied) {
      try {
        service.updateOrganizationBillingPolicy({
          actorUserId: actor.userId,
          organizationId: actor.organizationId,
          billingEnabled: original.policy.billing_enabled,
          baseFeeCents: original.policy.billing_enabled ? original.policy.base_fee_cents : 0,
          includedTokens: original.policy.billing_enabled ? original.policy.included_tokens : 0,
          overageCentsPerMillionTokens: original.policy.billing_enabled
            ? original.policy.overage_cents_per_million_tokens
            : 0,
          effectiveMonth,
          expectedVersion: latestPolicyVersion(db, actor.organizationId),
          reason: `deployment acceptance ${runId} restore exact policy`,
          requestId: runId,
          ipAddress: '127.0.0.1'
        });
        restored = service.projectOrganizationBilling({
          organizationId: actor.organizationId,
          month: effectiveMonth
        });
        if (!semanticMatch(original, restored)) throw acceptanceError('Billing policy semantic restoration failed.');
      } catch (error) {
        cleanupError = cleanupError || error;
      }
    }
  }
  if (cleanupError) throw cleanupError;
  if (resultError) throw resultError;

  closeEvidence = await isolatedCloseProof(db, {
    actorUserId: actor.userId,
    organizationId: actor.organizationId,
    runId
  });
  const evidence = {
    schemaVersion: 1,
    runId,
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    effectiveMonth,
    original: policySnapshot(original),
    http: httpEvidence,
    isolatedClose: closeEvidence,
    restored: { ...policySnapshot(restored), semanticMatch: semanticMatch(original, restored) },
    acceptedAt: currentDate.toISOString()
  };
  writeEvidence(evidencePath, evidence);
  return evidence;
}

async function main(argv) {
  const args = parseArguments(argv);
  const runtimeConfig = require('../config/runtime_config');
  runtimeConfig.loadPlatformEnvironment();
  const { jwtSecret } = runtimeConfig.validateNetworkRuntimeConfig();
  const db = require('../db');
  try {
    const actor = resolveAcceptanceActor(db);
    const evidence = await runAcceptance({ ...args, db, actor, jwtSecret });
    process.stdout.write(`ORGANIZATION_BILLING_ACCEPTANCE_OK ${evidence.runId}\n`);
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`ORGANIZATION_BILLING_ACCEPTANCE_FAILED ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  RELEASE_SMOKE_USERNAME,
  parseArguments,
  resolveAcceptanceActor,
  runAcceptance,
  isolatedCloseProof
};

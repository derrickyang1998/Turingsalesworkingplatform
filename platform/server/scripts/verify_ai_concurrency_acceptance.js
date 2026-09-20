'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');

const { createAIConcurrencyService } = require('../services/ai_concurrency_service');

const BUSINESS_TABLES = Object.freeze([
  'ai_conversations',
  'ai_messages',
  'ai_references',
  'token_usage',
  'knowledge_entries',
  'web_search_cache',
  'proposals',
  'request_idempotency'
]);

function acceptanceError(message) {
  const error = new Error(message);
  error.name = 'AIConcurrencyAcceptanceError';
  return error;
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
  if (!/^[0-9a-f]{32}$/.test(values['run-id'] || '')) {
    throw acceptanceError('Deployment run id is invalid.');
  }
  if (!path.isAbsolute(values.evidence || '')) {
    throw acceptanceError('Acceptance evidence path must be absolute.');
  }
  const baseUrl = new URL(values['base-url'] || '');
  if (baseUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(baseUrl.hostname)) {
    throw acceptanceError('Acceptance base URL must be loopback HTTP.');
  }
  return {
    runId: values['run-id'],
    evidencePath: values.evidence,
    baseUrl: baseUrl.origin
  };
}

function resolveAcceptanceActor(db) {
  const organizationAccess = require('../services/organization_access_service');
  const candidates = db.prepare(`
    SELECT id,username,role
    FROM users
    WHERE role='admin' AND is_active=1
    ORDER BY CASE WHEN username='derrick' THEN 0 ELSE 1 END,id
  `).all();
  for (const candidate of candidates) {
    const scope = organizationAccess.resolveOrganizationScope(db, {
      userId: candidate.id,
      repairMissing: false
    });
    if (scope && scope.ok && scope.authContext && scope.authContext.organization) {
      return {
        userId: Number(candidate.id),
        organizationId: Number(scope.authContext.organization.id),
        role: candidate.role
      };
    }
  }
  throw acceptanceError('No active platform administrator has a resolvable organization.');
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name=?").get(name));
}

function captureBusinessCounts(db) {
  const counts = {};
  for (const table of BUSINESS_TABLES) {
    if (tableExists(db, table)) {
      counts[table] = Number(db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count);
    }
  }
  return counts;
}

function assertSameCounts(before, after) {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw acceptanceError('Concurrency rejection changed provider, business, or Token state.');
  }
}

async function postJson(url, token, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Acceptance HTTP request timed out.')), 15000);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (_error) {
      throw acceptanceError('Acceptance API did not return JSON.');
    }
    return {
      status: response.status,
      retryAfter: response.headers.get('retry-after'),
      body: parsed
    };
  } finally {
    clearTimeout(timer);
  }
}

function writeEvidence(evidencePath, payload) {
  const directory = path.dirname(evidencePath);
  const resolvedDirectory = fs.realpathSync(directory);
  if (resolvedDirectory !== directory) {
    throw acceptanceError('Acceptance evidence directory is not canonical.');
  }
  const descriptor = fs.openSync(evidencePath, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf8' });
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(evidencePath, 0o600);
}

async function runAcceptance(options) {
  const db = options.db;
  const actor = options.actor;
  const runId = options.runId;
  const evidencePath = options.evidencePath;
  const baseUrl = options.baseUrl;
  const httpPost = options.httpPost || postJson;
  if (!db || !actor || !/^[0-9a-f]{32}$/.test(runId || '')) {
    throw acceptanceError('Acceptance inputs are invalid.');
  }
  if (fs.existsSync(evidencePath)) throw acceptanceError('Acceptance evidence already exists.');

  const service = createAIConcurrencyService(db);
  const original = service.projectOrganizationConcurrency({ organizationId: actor.organizationId });
  if (original.active !== 0) throw acceptanceError('Organization has active AI reservations before acceptance.');

  let current = original;
  let held = null;
  let sessionToken = null;
  let rejection = null;
  let controlled = null;
  let cleanupError = null;
  const rejectedBefore = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM ai_provider_reservation_events
    WHERE org_id=? AND event_type='rejected'
  `).get(actor.organizationId).count);

  try {
    if (current.limit !== 1) {
      current = service.updateOrganizationConcurrencyPolicy({
        actorUserId: actor.userId,
        organizationId: actor.organizationId,
        concurrencyLimit: 1,
        expectedVersion: current.policy_version,
        reason: `deployment acceptance ${runId} temporary limit`,
        requestId: runId,
        ipAddress: '127.0.0.1'
      });
    }

    held = service.acquire({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      operationKey: `deployment_acceptance:held:${runId}`
    });
    sessionToken = jwt.sign(
      { userId: actor.userId, role: actor.role, jti: crypto.randomUUID() },
      options.jwtSecret,
      { expiresIn: '5m' }
    );
    db.prepare(`
      INSERT INTO sessions (user_id,token,ip_address,expires_at)
      VALUES (?,?,?,?)
    `).run(actor.userId, sessionToken, '127.0.0.1', new Date(Date.now() + 300000).toISOString());

    const before = captureBusinessCounts(db);
    rejection = await httpPost(`${baseUrl}/api/ai/chat`, sessionToken, {
      message: `deployment concurrency rejection probe ${runId}`,
      allow_web: false,
      source_module: 'deployment_acceptance'
    });
    const retryAfter = Number(rejection.retryAfter);
    if (
      rejection.status !== 429 ||
      !rejection.body ||
      rejection.body.code !== 'AI_ORGANIZATION_CONCURRENCY_LIMIT_REACHED' ||
      !Number.isSafeInteger(retryAfter) || retryAfter < 1 || retryAfter > 135
    ) {
      throw acceptanceError('Acceptance API did not return the exact concurrency rejection contract.');
    }
    assertSameCounts(before, captureBusinessCounts(db));
    const rejectedAfter = Number(db.prepare(`
      SELECT COUNT(*) AS count FROM ai_provider_reservation_events
      WHERE org_id=? AND event_type='rejected'
    `).get(actor.organizationId).count);
    if (rejectedAfter !== rejectedBefore + 1) {
      throw acceptanceError('Concurrency rejection audit was not appended exactly once.');
    }

    service.release({ reservationId: held.reservation_id, fenceToken: held.fence_token });
    held = null;
    const controlledOperationKey = `deployment_acceptance:controlled:${runId}`;
    const controlledResult = await service.runWithPermit({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      operationKey: controlledOperationKey,
      provider: 'acceptance_control'
    }, async (permit) => {
      permit.assertActive();
      if (permit.signal.aborted) throw acceptanceError('Controlled reservation was unexpectedly aborted.');
      return { completed: true };
    });
    if (!controlledResult || controlledResult.completed !== true) {
      throw acceptanceError('Controlled reservation did not complete.');
    }
    const controlledReservations = db.prepare(`
      SELECT reservation_id,state,provider_completed_at,terminal_at
      FROM ai_provider_reservations
      WHERE org_id=? AND operation_key=?
      ORDER BY acquired_at,reservation_id
    `).all(actor.organizationId, controlledOperationKey);
    if (
      controlledReservations.length !== 1 ||
      controlledReservations[0].state !== 'released' ||
      !controlledReservations[0].provider_completed_at ||
      !controlledReservations[0].terminal_at
    ) {
      throw acceptanceError('Controlled reservation did not persist one completed release.');
    }
    const controlledEvents = db.prepare(`
      SELECT event_type
      FROM ai_provider_reservation_events
      WHERE reservation_id=?
      ORDER BY id
    `).all(controlledReservations[0].reservation_id).map((row) => row.event_type);
    const expectedEvents = ['acquired', 'dispatch_authorized', 'provider_completed', 'released'];
    if (JSON.stringify(controlledEvents) !== JSON.stringify(expectedEvents)) {
      throw acceptanceError('Controlled reservation event lifecycle is incomplete.');
    }
    controlled = {
      completed: true,
      state: controlledReservations[0].state,
      providerCompleted: true,
      terminal: true,
      events: controlledEvents
    };
  } finally {
    if (held) {
      try {
        service.release({ reservationId: held.reservation_id, fenceToken: held.fence_token });
      } catch (error) {
        cleanupError = cleanupError || error;
      }
    }
    if (sessionToken) {
      try {
        db.prepare('DELETE FROM sessions WHERE token=?').run(sessionToken);
      } catch (error) {
        cleanupError = cleanupError || error;
      }
    }
    try {
      current = service.projectOrganizationConcurrency({ organizationId: actor.organizationId });
      if (current.limit !== original.limit) {
        current = service.updateOrganizationConcurrencyPolicy({
          actorUserId: actor.userId,
          organizationId: actor.organizationId,
          concurrencyLimit: original.limit,
          expectedVersion: current.policy_version,
          reason: `deployment acceptance ${runId} restore exact limit`,
          requestId: runId,
          ipAddress: '127.0.0.1'
        });
      }
      const restored = service.projectOrganizationConcurrency({ organizationId: actor.organizationId });
      if (restored.limit !== original.limit || restored.active !== 0) {
        throw acceptanceError('AI concurrency policy or active reservations were not restored.');
      }
      current = restored;
    } catch (error) {
      cleanupError = cleanupError || error;
    }
    if (cleanupError) throw cleanupError;
  }

  const evidence = {
    schemaVersion: 1,
    runId,
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    original: {
      limit: original.limit,
      policyVersion: original.policy_version,
      active: original.active
    },
    rejection: {
      status: rejection.status,
      code: rejection.body.code,
      retryAfter: Number(rejection.retryAfter),
      businessWrites: 0,
      tokenWrites: 0
    },
    controlled,
    restored: {
      limit: current.limit,
      policyVersion: current.policy_version,
      active: current.active
    },
    acceptedAt: new Date().toISOString()
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
    const evidence = await runAcceptance({
      db,
      actor,
      jwtSecret,
      runId: args.runId,
      evidencePath: args.evidencePath,
      baseUrl: args.baseUrl
    });
    process.stdout.write(`AI_CONCURRENCY_ACCEPTANCE_OK ${evidence.runId}\n`);
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`AI_CONCURRENCY_ACCEPTANCE_FAILED ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  BUSINESS_TABLES,
  captureBusinessCounts,
  parseArguments,
  resolveAcceptanceActor,
  runAcceptance
};

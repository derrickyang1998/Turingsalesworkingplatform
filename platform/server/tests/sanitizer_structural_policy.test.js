'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const migrationGate = require('../scripts/verify_campaign_migration_gate');
const sanitizer = require('../scripts/sanitize_production_shape');
const manifestDocument = require('../scripts/sanitization_manifest.json');
const manifest = sanitizer._testing.manifestProfileForVersion(manifestDocument, 5);
const BASH = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
const HAS_BASH = process.platform !== 'win32' || fs.existsSync(BASH);

function openMigratedFixture(label, targetVersion = 5) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `tm-sanitizer-policy-${label}-`));
  const dbPath = path.join(root, 'source.db');
  const migrationOptions = { rootDir: path.resolve(__dirname, '..') };
  if (targetVersion === 5) migrationOptions.registeredMigrations = migrationGate.REGISTERED_MIGRATIONS;
  const db = migrationService.openMigratedDatabase(dbPath, migrationOptions);
  return { root, dbPath, db };
}

function closeFixture(fixture) {
  try { if (fixture.db && fixture.db.open) fixture.db.close(); } catch (_error) {}
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

function structuralTextColumns() {
  return manifest.objects.flatMap((object) => object.columns
    .filter((column) => column.classification === 'structural'
      && /TEXT|CHAR|CLOB|DATE|TIME/i.test(column.declaredType || ''))
    .map((column) => `${object.name}.${column.name}`));
}

test('every preserved structural text column has a closed exact-column validator that rejects its canary', () => {
  const fixture = openMigratedFixture('closed-text');
  try {
    assert.doesNotThrow(() => sanitizer.validateManifest(manifestDocument, fixture.db));
    const contexts = structuralTextColumns();
    assert.ok(contexts.length > 0, 'the migrated schema must exercise structural text validation');
    assert.deepEqual(
      Object.keys(sanitizer.STRUCTURAL_COLUMN_POLICY)
        .filter((context) => sanitizer.STRUCTURAL_COLUMN_POLICY[context].storage === 'text')
        .sort(),
      [...contexts].sort(),
      'manifest structural text and the frozen exact-column policy must be exhaustive in both directions'
    );

    for (const context of contexts) {
      const policy = sanitizer.STRUCTURAL_COLUMN_POLICY[context];
      assert.ok(Object.isFrozen(policy), `${context} policy must be frozen`);
      if (policy.kind === 'enum' || policy.kind === 'migration-ledger') {
        assert.ok(Array.isArray(policy.allowedValues) && policy.allowedValues.length > 0,
          `${context} must have a non-empty closed value set`);
        assert.ok(Object.isFrozen(policy.allowedValues), `${context} allowed values must be frozen`);
      } else {
        assert.ok(['timestamp', 'date', 'canonical-positive-decimal'].includes(policy.kind),
          `${context} must use an explicit closed structural format`);
      }
      assert.throws(
        () => sanitizer._testing.assertStructuralValueAllowed(
          context,
          `review-private-${context.replace(/[^a-z0-9]/gi, '-')}-canary`
        ),
        new RegExp(context.replace('.', '\\.').replaceAll('_', '[_]'), 'i'),
        `${context} must reject arbitrary source text`
      );
    }
  } finally {
    closeFixture(fixture);
  }
});

test('arbitrary model, source, industry, platform, market, region, module, and code cells are never structural', () => {
  const sensitiveContexts = [
    'ai_conversations.source_module',
    'ai_messages.model',
    'token_usage.model',
    'brands.market',
    'brands.top_platform',
    'brands.data_source',
    'campaign_events.source',
    'campaigns.region',
    'campaigns.currency',
    'customers.industry',
    'customers.source',
    'demands.industry',
    'demands.platform',
    'influencers.platform',
    'influencers.category',
    'influencers.region',
    'influencers.language',
    'influencers.data_source',
    'knowledge_entries.source_type',
    'leads.source',
    'leads.industry',
    'organizations.code',
    'teams.code',
    'workflow_instances.business_type',
    'workflow_templates.module',
    'workflow_templates.category'
  ];
  const classifications = new Map(manifest.objects.flatMap((object) => (
    object.columns.map((column) => [`${object.name}.${column.name}`, column.classification])
  )));
  for (const context of sensitiveContexts) {
    assert.notEqual(classifications.get(context), 'structural', `${context} must be transformed or rejected`);
    assert.equal(sanitizer.STRUCTURAL_COLUMN_POLICY[context], undefined, `${context} must not be allowlisted`);
  }
});

test('structural dates and timestamps require real calendar dates without Date.parse normalization', () => {
  assert.doesNotThrow(() => sanitizer._testing.assertStructuralValueAllowed(
    'campaigns.start_date', '2024-02-29', 'text'
  ));
  for (const invalid of ['2023-02-29', '2024-02-31', '2024-13-01', '2024-00-10']) {
    assert.throws(
      () => sanitizer._testing.assertStructuralValueAllowed('campaigns.start_date', invalid, 'text'),
      /canonical date/i,
      invalid
    );
  }
  assert.throws(
    () => sanitizer._testing.assertStructuralValueAllowed('campaigns.created_at', '2023-02-29 12:00:00', 'text'),
    /canonical timestamp/i
  );
});

test('reported ai_messages.model canary is transformed and absent from sanitized bytes', () => {
  const fixture = openMigratedFixture('model-leak', 1);
  const canary = 'review-private-model-canary-c1f0e2b7';
  try {
    const userId = fixture.db.prepare('SELECT MIN(id) AS id FROM users').get().id;
    const conversationId = Number(fixture.db.prepare(`
      INSERT INTO ai_conversations (user_id,title,visibility,source_module)
      VALUES (?,'Structural policy probe','private','assistant')
    `).run(userId).lastInsertRowid);
    const messageId = Number(fixture.db.prepare(`
      INSERT INTO ai_messages (conversation_id,user_id,role,content,model)
      VALUES (?,?,'assistant','Sensitive response',?)
    `).run(conversationId, userId, canary).lastInsertRowid);
    fixture.db.close();

    const outputPath = path.join(fixture.root, 'sanitized.db');
    sanitizer.sanitizeProductionShape({ sourcePath: fixture.dbPath, outputPath });
    const output = new Database(outputPath, { readonly: true, fileMustExist: true });
    try {
      assert.deepEqual(
        migrationService.classifyDatabase(output, {
          rootDir: path.resolve(__dirname, '..'),
          migrations: migrationService.defaultMigrations()
        }),
        { status: 'managed', currentVersion: 1 }
      );
      assert.deepEqual(output.prepare('SELECT version FROM schema_migrations ORDER BY version').all(), [{ version: 1 }]);
      assert.equal(
        output.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name='campaigns'").get(),
        undefined,
        'sanitization must not install migrations 2-5'
      );
      const observed = output.prepare('SELECT model FROM ai_messages WHERE id=?').get(messageId).model;
      assert.notEqual(observed, canary);
      assert.match(observed, /^tmtext-[0-9a-f]{32}$/);
    } finally {
      output.close();
    }
    assert.equal(fs.readFileSync(outputPath).includes(Buffer.from(canary, 'utf8')), false);
  } finally {
    closeFixture(fixture);
  }
});

class FakeWorker extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
  }

  close(code = null, signal = 'SIGKILL') {
    this.emit('close', code, signal);
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function coordinatorHarness(label, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `tm-sanitizer-worker-${label}-`));
  const sourceRoot = path.join(root, 'source-root');
  const outputRoot = path.join(root, 'output-root');
  const runRoot = path.join(root, 'run-root');
  const journalRoot = path.join(root, 'journal-root');
  for (const directory of [sourceRoot, outputRoot, runRoot, journalRoot]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const sourcePath = path.join(sourceRoot, 'source.db');
  const outputPath = path.join(outputRoot, 'sanitized.db');
  fs.writeFileSync(sourcePath, 'source-shape');

  const runId = options.runId || 'a'.repeat(32);
  const worker = new FakeWorker(options.pid || 43001);
  const termination = deferred();
  const state = {
    processGroups: new Set([worker.pid]),
    mounts: new Set([`mount:${runId}`]),
    users: new Set([`tm-gate-${runId.slice(0, 12)}`]),
    terminationSignals: [],
    termination
  };
  const controller = options.controller || new AbortController();
  const identity = Object.freeze({
    name: `tm-gate-${runId.slice(0, 12)}`,
    uid: 22001,
    gid: 22001
  });
  const processGroupIdentity = Object.freeze({
    pid: worker.pid,
    uid: 0,
    startTimeTicks: '31337',
    exe: '/usr/bin/unshare',
    pgid: worker.pid
  });
  const closeOnSignal = options.closeOnSignal || (() => {});

  const promise = sanitizer._testing.runProductionCoordinator({
    sourcePath,
    outputPath,
    sourceRoot,
    outputRoot,
    runRoot,
    journalRoot,
    runId,
    requireRoot: false,
    signal: controller.signal,
    workerDeadlineMs: options.workerDeadlineMs || 35,
    workerTerminationGraceMs: options.workerTerminationGraceMs || 20,
    workerKillObservationMs: options.workerKillObservationMs || 40,
    preparePrivilegedSource({ preparedPath }) {
      fs.copyFileSync(sourcePath, preparedPath);
      return { sourceIdentity: { device: 1, inode: 1, size: fs.statSync(sourcePath).size } };
    },
    async createEphemeralIdentity() { return identity; },
    async removeEphemeralIdentity(observed) {
      assert.deepEqual(observed, identity);
      state.users.delete(identity.name);
      return true;
    },
    workerAdapters: {
      buildLaunchPlan() { return Object.freeze({ command: 'fake-worker', args: Object.freeze([]) }); },
      spawnProcess(_command, _args, spawnOptions) {
        assert.equal(spawnOptions.detached, true, 'the run-bound launcher must own a process group');
        if (options.abortDuringSpawn) controller.abort(new Error('SIGTERM-race'));
        return worker;
      },
      inspectProcessGroupLeader(pid) {
        assert.equal(pid, worker.pid);
        if (options.identityInspectionError) throw options.identityInspectionError;
        return processGroupIdentity;
      },
      findRunBoundWorker(observedRunId, uid) {
        assert.equal(observedRunId, runId);
        assert.equal(uid, identity.uid);
        return { pid: worker.pid + 1, uid, startTimeTicks: '424242', exe: process.execPath };
      },
      terminateProcessGroup(request) {
        if (options.terminateProcessGroup) {
          return options.terminateProcessGroup({ request, worker, state, processGroupIdentity });
        }
        state.terminationSignals.push(request);
        assert.equal(request.runId, runId);
        assert.equal(request.processGroupId, worker.pid);
        termination.resolve(request);
        closeOnSignal({ request, worker, state });
      },
      isProcessGroupAlive(request) {
        if (options.isProcessGroupAlive) {
          return options.isProcessGroupAlive({ request, worker, state, processGroupIdentity });
        }
        assert.equal(request.runId, runId);
        assert.equal(request.processGroupId, worker.pid);
        return state.processGroups.has(worker.pid);
      }
    }
  });

  function assertNoResidue() {
    assert.deepEqual([...state.processGroups], [], 'worker process group residue');
    assert.deepEqual([...state.mounts], [], 'worker mount residue');
    assert.deepEqual([...state.users], [], 'ephemeral UID residue');
    assert.equal(fs.existsSync(path.join(journalRoot, `${runId}.run.json`)), false, 'journal residue');
    assert.equal(fs.existsSync(path.join(runRoot, runId)), false, 'run staging residue');
    assert.equal(fs.existsSync(outputPath), false, 'failed output must not publish');
    assert.deepEqual(
      fs.readdirSync(outputRoot).filter((name) => name.includes('.tm-stage-')),
      [],
      'publication staging residue'
    );
  }

  return {
    root,
    runId,
    worker,
    state,
    controller,
    processGroupIdentity,
    promise,
    assertNoResidue,
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); }
  };
}

test('isolated worker launch synchronously journals the exact detached group leader identity', async () => {
  const worker = new FakeWorker(42991);
  const events = [];
  let groupAlive = true;
  const groupIdentity = {
    pid: worker.pid,
    uid: 0,
    startTimeTicks: '9001',
    exe: '/usr/bin/unshare',
    pgid: worker.pid
  };
  const promise = sanitizer._testing.launchIsolatedWorker({
    runId: '9'.repeat(32),
    identity: { name: 'tm-gate-999999999999', uid: 22001, gid: 22001 },
    preparedSourcePath: '/run/test/source.db',
    stagedOutputPath: '/run/test-output/output.db',
    sandboxRoot: '/run/test-sandbox',
    deadlineMs: 1_000,
    terminationGraceMs: 20,
    killObservationMs: 20,
    journal: {
      advance(state) { events.push(`advance:${state}`); },
      recordProcessGroup(identity) { events.push(`group:${JSON.stringify(identity)}`); },
      recordWorker(identity) { events.push(`worker:${identity.pid}`); }
    },
    adapters: {
      buildLaunchPlan() { return { command: 'fake-worker', args: [] }; },
      spawnProcess() {
        events.push('spawn');
        return worker;
      },
      inspectProcessGroupLeader(pid) {
        events.push(`inspect:${pid}`);
        return groupIdentity;
      },
      findRunBoundWorker(_runId, uid) {
        return { pid: worker.pid + 1, uid, startTimeTicks: '9002', exe: process.execPath };
      },
      terminateProcessGroup() {},
      isProcessGroupAlive() { return groupAlive; }
    }
  });
  setTimeout(() => {
    worker.stdout.end('{"format":"synthetic-worker-report"}\n');
    groupAlive = false;
    worker.close(0, null);
  }, 35);
  const report = await promise;
  assert.deepEqual(report, { format: 'synthetic-worker-report' });
  assert.deepEqual(events.slice(0, 3), [
    'spawn',
    `inspect:${worker.pid}`,
    `group:${JSON.stringify(groupIdentity)}`
  ]);
});

test('process-group exit observed before child close settles through the normal post-exit path', async () => {
  const worker = new FakeWorker(42999);
  let groupAlive = true;
  const groupIdentity = {
    pid: worker.pid,
    uid: 0,
    startTimeTicks: '9011',
    exe: '/usr/bin/unshare',
    pgid: worker.pid
  };
  const launch = sanitizer._testing.launchIsolatedWorker({
    runId: '6'.repeat(32),
    identity: { name: 'tm-gate-666666666666', uid: 22001, gid: 22001 },
    preparedSourcePath: '/run/test/source.db',
    stagedOutputPath: '/run/test-output/output.db',
    sandboxRoot: '/run/test-sandbox',
    deadlineMs: 500,
    terminationGraceMs: 20,
    killObservationMs: 20,
    journal: {
      advance() {},
      recordProcessGroup() {},
      recordWorker() {}
    },
    adapters: {
      buildLaunchPlan() { return { command: 'fake-worker', args: [] }; },
      spawnProcess() { return worker; },
      inspectProcessGroupLeader() { return groupIdentity; },
      findRunBoundWorker(_runId, uid) {
        return { pid: worker.pid + 1, uid, startTimeTicks: '9012', exe: process.execPath };
      },
      terminateProcessGroup() {
        throw new Error('normal exit must not enter termination');
      },
      isProcessGroupAlive() { return groupAlive; }
    }
  });

  setTimeout(() => { groupAlive = false; }, 15);
  setTimeout(() => {
    worker.stdout.end('{"format":"group-first-success"}\n');
    worker.close(0, null);
  }, 55);

  const observed = await Promise.race([
    launch,
    new Promise((resolve) => setTimeout(() => resolve({ format: 'ordering-timeout' }), 180))
  ]);
  assert.deepEqual(observed, { format: 'group-first-success' });
});

test('coordinator PGID change after TERM observation is revalidated before SIGKILL', { skip: !HAS_BASH }, () => {
  const cleanupPath = path.join(__dirname, '..', 'scripts', 'cleanup_stale_migration_gate.sh');
  const source = fs.readFileSync(cleanupPath, 'utf8');
  const start = source.indexOf('process_matches() {');
  const end = source.indexOf('\nprocess_group_alive() {', start);
  assert.ok(start >= 0 && end > start, 'coordinator identity and cleanup functions must be extractable');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-coordinator-kill-race-'));
  const harness = path.join(root, 'coordinator-kill-race.sh');
  const events = path.join(root, 'signals.log');
  const procRoot = path.join(root, 'proc');
  const pid = 4242;
  const procDirectory = path.join(procRoot, String(pid));
  fs.mkdirSync(procDirectory, { recursive: true });
  fs.writeFileSync(path.join(procDirectory, 'status'), 'Name:\ttm-sanitizer\nUid:\t0\t0\t0\t0\n');
  const statFields = ['S', '1', '777', '777', '0', '-1'];
  while (statFields.length < 19) statFields.push('0');
  statFields.push('31337', '0', '0');
  fs.writeFileSync(path.join(procDirectory, 'stat'), `${pid} (tm sanitizer coordinator) ${statFields.join(' ')}\n`);
  fs.writeFileSync(path.join(procDirectory, 'cmdline'), Buffer.from([
    process.execPath,
    '--production',
    '--source', '/srv/source.db',
    '--output', '/srv/output.db',
    '--run-id', 'c'.repeat(32),
    ''
  ].join('\0')));
  const bashPath = (value) => process.platform === 'win32'
    ? value.replace(/^([A-Za-z]):/, (_match, drive) => `/${drive.toLowerCase()}`).replaceAll('\\', '/')
    : value;
  fs.writeFileSync(harness, `#!/usr/bin/env bash
set -u
TERM_WAIT_STEPS=1
KILL_WAIT_STEPS=1
WAIT_INTERVAL_SECONDS=0
PROC_ROOT="$1"
events="$2"
pid=4242
kill() {
  if [ "$1" = "-0" ]; then return 0; fi
  printf '%s\\n' "$*" >> "$events"
  return 0
}
sleep() {
  node - "$PROC_ROOT/$pid/stat" <<'NODE'
const fs = require('node:fs');
const target = process.argv[2];
const text = fs.readFileSync(target, 'utf8');
const end = text.lastIndexOf(') ');
const prefix = text.slice(0, end + 2);
const fields = text.slice(end + 2).trim().split(/\\s+/);
fields[2] = '778';
fs.writeFileSync(target, prefix + fields.join(' ') + '\\n');
NODE
}
fail() { printf 'migration gate cleanup failed: %s\\n' "$1" >&2; exit 1; }
${source.slice(start, end)}
terminate_recorded_process coordinator 4242 0 31337 '' ${'c'.repeat(32)} 777
`, { mode: 0o700 });
  try {
    const result = spawnSync(BASH, [bashPath(harness), bashPath(procRoot), bashPath(events)], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, 'PGID reuse must fail closed');
    assert.match(result.stderr, /changed before KILL/i);
    const signals = fs.existsSync(events) ? fs.readFileSync(events, 'utf8').trim().split(/\r?\n/) : [];
    assert.deepEqual(signals, ['-TERM 4242'], 'changed coordinator PGID must never receive SIGKILL');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('isolated worker spawn inherits the coordinator lifecycle fence as fixed fd 9', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'sanitize_production_shape.js'),
    'utf8'
  );
  const launchSource = source.slice(
    source.indexOf('function launchIsolatedWorker('),
    source.indexOf('function preparePrivilegedSource(')
  );
  assert.match(launchSource, /lifecycleFence\.fd/);
  assert.match(launchSource, /workerStdio\[DEFAULT_LIFECYCLE_FENCE_FD\]\s*=\s*lifecycleFence\.fd/);
  assert.match(launchSource, /stdio:\s*workerStdio/);
  assert.match(launchSource, /lifecycleFenceDevice:\s*lifecycleFence\.device/);
  assert.match(launchSource, /lifecycleFenceInode:\s*lifecycleFence\.inode/);
});

test('post-SIGKILL process-group observation has a hard deadline and fails cleanup-unsafe', async () => {
  const worker = new FakeWorker(42992);
  const groupIdentity = {
    pid: worker.pid,
    uid: 0,
    startTimeTicks: '9003',
    exe: '/usr/bin/unshare',
    pgid: worker.pid
  };
  const signals = [];
  let groupAlive = true;
  const launch = sanitizer._testing.launchIsolatedWorker({
    runId: '8'.repeat(32),
    identity: { name: 'tm-gate-888888888888', uid: 22001, gid: 22001 },
    preparedSourcePath: '/run/test/source.db',
    stagedOutputPath: '/run/test-output/output.db',
    sandboxRoot: '/run/test-sandbox',
    deadlineMs: 20,
    terminationGraceMs: 20,
    killObservationMs: 30,
    journal: {
      advance() {},
      recordProcessGroup() {},
      recordWorker() {}
    },
    adapters: {
      buildLaunchPlan() { return { command: 'fake-worker', args: [] }; },
      spawnProcess() { return worker; },
      inspectProcessGroupLeader() { return groupIdentity; },
      findRunBoundWorker(_runId, uid) {
        return { pid: worker.pid + 1, uid, startTimeTicks: '9004', exe: process.execPath };
      },
      terminateProcessGroup(request) { signals.push(request.signal); },
      isProcessGroupAlive() { return groupAlive; }
    }
  });
  const observed = await Promise.race([
    launch.then(
      (value) => ({ kind: 'resolved', value }),
      (error) => ({ kind: 'rejected', error })
    ),
    new Promise((resolve) => setTimeout(() => resolve({ kind: 'unbounded' }), 200))
  ]);
  groupAlive = false;
  worker.close(null, 'SIGKILL');
  await launch.catch(() => {});

  assert.equal(observed.kind, 'rejected', 'post-KILL observation must settle before the hard bound');
  assert.equal(observed.error.code, 'TM_SANITIZER_WORKER_TIMEOUT');
  assert.equal(observed.error.cleanupUnsafe, true);
  assert.match(observed.error.message, /SIGKILL|observation|cleanup/i);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('uncertain group-leader identity retains the journal and run resources for fail-closed cleanup', async () => {
  const harness = coordinatorHarness('identity-uncertain', {
    runId: '7'.repeat(32),
    identityInspectionError: new Error('injected /proc identity uncertainty'),
    workerDeadlineMs: 20,
    workerTerminationGraceMs: 20,
    workerKillObservationMs: 30
  });
  try {
    await assert.rejects(harness.promise, (error) => {
      assert.equal(error.code, 'TM_SANITIZER_WORKER_IDENTITY_UNCERTAIN');
      assert.equal(error.cleanupUnsafe, true);
      assert.match(error.message, /retained.*journal|identity.*uncertain/i);
      return true;
    });
    assert.equal(
      fs.existsSync(path.join(harness.root, 'journal-root', `${harness.runId}.run.json`)),
      true
    );
    assert.equal(fs.existsSync(path.join(harness.root, 'run-root', harness.runId)), true);
    assert.equal(harness.state.users.size, 1);
    assert.equal(harness.state.processGroups.has(harness.worker.pid), true);
  } finally {
    harness.cleanup();
  }
});

test('hung worker deadline escalates the exact run process group and coordinator leaves no residue', async () => {
  const harness = coordinatorHarness('timeout', {
    closeOnSignal({ request, worker, state }) {
      if (request.signal === 'SIGTERM') worker.close(null, 'SIGTERM');
      if (request.signal === 'SIGKILL') {
        state.processGroups.delete(worker.pid);
        state.mounts.clear();
      }
    }
  });
  try {
    await assert.rejects(harness.promise, (error) => {
      assert.equal(error.code, 'TM_SANITIZER_WORKER_TIMEOUT');
      assert.match(error.message, /deadline|timeout/i);
      return true;
    });
    assert.deepEqual(harness.state.terminationSignals.map((entry) => entry.signal), ['SIGTERM', 'SIGKILL']);
    assert.equal(harness.state.terminationSignals.some((entry) => entry.identityPreviouslyVerified === true), false);
    harness.assertNoResidue();
  } finally {
    harness.cleanup();
  }
});

test('TERM identity or PGID reuse fails closed before SIGKILL and retains recovery resources', async () => {
  let identityReused = false;
  const harness = coordinatorHarness('term-identity-reuse', {
    runId: '1'.repeat(32),
    workerDeadlineMs: 25,
    workerTerminationGraceMs: 25,
    workerKillObservationMs: 30,
    terminateProcessGroup({ request, state }) {
      if (request.identityPreviouslyVerified !== true && identityReused) {
        throw new Error('run-bound process group pgid changed');
      }
      state.terminationSignals.push(request);
      if (request.signal === 'SIGTERM') identityReused = true;
    },
    isProcessGroupAlive({ request, state, worker }) {
      if (request.identityPreviouslyVerified !== true && identityReused) {
        throw new Error('run-bound process group identity changed after TERM');
      }
      return state.processGroups.has(worker.pid);
    }
  });
  try {
    await assert.rejects(harness.promise, (error) => {
      assert.equal(error.cleanupUnsafe, true);
      assert.match(error.message, /identity|pgid|uncertain|retained/i);
      return true;
    });
    assert.deepEqual(
      harness.state.terminationSignals.map((entry) => entry.signal),
      ['SIGTERM'],
      'identity reuse after TERM must prevent SIGKILL'
    );
    assert.equal(fs.existsSync(path.join(harness.root, 'journal-root', `${harness.runId}.run.json`)), true);
    assert.equal(fs.existsSync(path.join(harness.root, 'run-root', harness.runId)), true);
  } finally {
    harness.cleanup();
  }
});

test('SIGKILL authorization and post-KILL observation each revalidate the complete leader identity', async (t) => {
  await t.test('identity changes immediately before SIGKILL', async () => {
    let killIdentityReused = false;
    const harness = coordinatorHarness('pre-kill-revalidation', {
      runId: '2'.repeat(32),
      workerDeadlineMs: 25,
      workerTerminationGraceMs: 25,
      workerKillObservationMs: 30,
      terminateProcessGroup({ request, state }) {
        if (request.signal === 'SIGTERM') {
          state.terminationSignals.push(request);
          return;
        }
        killIdentityReused = true;
        if (request.identityPreviouslyVerified !== true) throw new Error('leader identity changed before SIGKILL');
        state.terminationSignals.push(request);
      },
      isProcessGroupAlive({ state, worker }) {
        return state.processGroups.has(worker.pid);
      }
    });
    try {
      await assert.rejects(harness.promise, (error) => {
        assert.equal(error.cleanupUnsafe, true);
        assert.match(error.message, /SIGKILL|identity|retained/i);
        return true;
      });
      assert.equal(killIdentityReused, true);
      assert.deepEqual(harness.state.terminationSignals.map((entry) => entry.signal), ['SIGTERM']);
    } finally {
      harness.cleanup();
    }
  });

  await t.test('identity changes after SIGKILL before observation', async () => {
    let identityReusedAfterKill = false;
    const harness = coordinatorHarness('post-kill-revalidation', {
      runId: '3'.repeat(32),
      workerDeadlineMs: 25,
      workerTerminationGraceMs: 25,
      workerKillObservationMs: 30,
      terminateProcessGroup({ request, state }) {
        state.terminationSignals.push(request);
        if (request.signal === 'SIGKILL') identityReusedAfterKill = true;
      },
      isProcessGroupAlive({ request, state, worker }) {
        if (identityReusedAfterKill) {
          if (request.identityPreviouslyVerified === true) return false;
          throw new Error('leader identity changed during post-SIGKILL observation');
        }
        return state.processGroups.has(worker.pid);
      }
    });
    try {
      await assert.rejects(harness.promise, (error) => {
        assert.equal(error.cleanupUnsafe, true);
        assert.match(error.message, /post-SIGKILL|identity|retained/i);
        return true;
      });
      assert.deepEqual(harness.state.terminationSignals.map((entry) => entry.signal), ['SIGTERM', 'SIGKILL']);
    } finally {
      harness.cleanup();
    }
  });
});

test('SIGINT and SIGTERM AbortSignal equivalents terminate and clean the exact run', async (t) => {
  for (const signalName of ['SIGINT', 'SIGTERM']) {
    await t.test(signalName, async () => {
      const controller = new AbortController();
      const harness = coordinatorHarness(`abort-${signalName.toLowerCase()}`, {
        runId: signalName === 'SIGINT' ? 'b'.repeat(32) : 'c'.repeat(32),
        controller,
        workerDeadlineMs: 5_000,
        closeOnSignal({ request, worker, state }) {
          if (request.signal !== 'SIGTERM') return;
          state.processGroups.delete(worker.pid);
          state.mounts.clear();
          worker.close(null, 'SIGTERM');
        }
      });
      try {
        setImmediate(() => controller.abort(new Error(signalName)));
        await assert.rejects(harness.promise, (error) => {
          assert.equal(error.code, 'TM_SANITIZER_WORKER_ABORTED');
          assert.match(error.message, new RegExp(signalName));
          return true;
        });
        assert.deepEqual(harness.state.terminationSignals.map((entry) => entry.signal), ['SIGTERM']);
        harness.assertNoResidue();
      } finally {
        harness.cleanup();
      }
    });
  }
});

test('abort during worker launch cannot race listener registration', async () => {
  const harness = coordinatorHarness('abort-registration-race', {
    runId: 'f'.repeat(32),
    abortDuringSpawn: true,
    workerDeadlineMs: 5_000,
    closeOnSignal({ request, worker, state }) {
      if (request.signal !== 'SIGTERM') return;
      state.processGroups.delete(worker.pid);
      state.mounts.clear();
      worker.close(null, 'SIGTERM');
    }
  });
  try {
    await assert.rejects(harness.promise, (error) => error.code === 'TM_SANITIZER_WORKER_ABORTED');
    assert.deepEqual(harness.state.terminationSignals.map((entry) => entry.signal), ['SIGTERM']);
    harness.assertNoResidue();
  } finally {
    harness.cleanup();
  }
});

test('deadline rejection waits for a late worker exit before journaled cleanup', async () => {
  const harness = coordinatorHarness('late-exit', {
    runId: 'd'.repeat(32),
    closeOnSignal() {}
  });
  try {
    await harness.state.termination.promise;
    let settled = false;
    harness.promise.finally(() => { settled = true; }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(settled, false, 'coordinator must not clean while the process group can still own mounts');
    assert.equal(harness.state.users.size, 1, 'ephemeral identity remains until worker exit is observed');
    assert.equal(fs.existsSync(path.join(
      harness.root,
      'journal-root',
      `${harness.runId}.run.json`
    )), true, 'journal must remain as fail-closed evidence before exit');

    harness.state.processGroups.delete(harness.worker.pid);
    harness.state.mounts.clear();
    harness.worker.stdout.end('{"format":"late-success"}\n');
    harness.worker.close(0, null);
    await assert.rejects(harness.promise, (error) => error.code === 'TM_SANITIZER_WORKER_TIMEOUT');
    harness.assertNoResidue();

    harness.worker.close(0, null);
    assert.equal(harness.state.terminationSignals.length >= 1, true, 'late duplicate exit must not restart cleanup');
  } finally {
    harness.cleanup();
  }
});

test('Linux real process-group deadline proof is remote-only and separately gated', {
  skip: process.platform !== 'linux'
    || typeof process.getuid !== 'function'
    || process.getuid() !== 0
    || process.env.TM_RUN_LINUX_SANITIZER_DEADLINE_PROOF !== '1'
}, async () => {
  const runId = 'e'.repeat(32);
  const journalStates = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-native-deadline-proof-'));
  const descendantPidPath = path.join(root, 'descendant.pid');
  let childPid = null;
  let descendantPid = null;
  let proofComplete = false;
  const descendant = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
  const groupLeader = [
    "const fs = require('node:fs');",
    "const { spawn } = require('node:child_process');",
    `const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' });`,
    `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));`,
    "process.on('SIGTERM', () => {});",
    'setInterval(() => {}, 1000);'
  ].join(' ');
  try {
    await assert.rejects(sanitizer._testing.launchIsolatedWorker({
      runId,
      identity: { uid: 22001, gid: 22001, name: 'tm-gate-eeeeeeeeeeee' },
      preparedSourcePath: '/tmp/unused-source.db',
      stagedOutputPath: '/tmp/unused-output.db',
      sandboxRoot: '/tmp/unused-sandbox',
      deadlineMs: 100,
      terminationGraceMs: 100,
      journal: {
        advance(state) { journalStates.push(state); },
        recordProcessGroup(identity) { journalStates.push(`group:${identity.pgid}`); },
        recordWorker(identity) { journalStates.push(`worker:${identity.pid}`); }
      },
      adapters: {
        buildLaunchPlan() {
          return {
            command: process.execPath,
            args: ['-e', groupLeader]
          };
        },
        spawnProcess(command, args, options) {
          const child = spawn(command, args, options);
          childPid = child.pid;
          return child;
        },
        findRunBoundWorker() {
          return childPid ? { pid: childPid, uid: 22001, startTimeTicks: '1' } : null;
        }
      }
    }), (error) => {
      assert.equal(error.code, 'TM_SANITIZER_WORKER_TIMEOUT');
      assert.equal(
        Object.prototype.hasOwnProperty.call(error, 'cleanupUnsafe'),
        false,
        'successful process-group cleanup must not be reported as cleanup-unsafe'
      );
      return true;
    });
    assert.ok(journalStates.includes(`group:${childPid}`));
    assert.ok(journalStates.includes('worker-timeout-termination-requested'));
    assert.equal(fs.existsSync(descendantPidPath), true, 'deadline fixture must record its descendant PID');
    descendantPid = Number(fs.readFileSync(descendantPidPath, 'utf8'));
    assert.equal(Number.isSafeInteger(descendantPid) && descendantPid > 1, true);
    assert.throws(() => process.kill(childPid, 0), (error) => error.code === 'ESRCH');
    assert.throws(() => process.kill(descendantPid, 0), (error) => error.code === 'ESRCH');
    assert.throws(() => process.kill(-childPid, 0), (error) => error.code === 'ESRCH');
    proofComplete = true;
  } finally {
    if (!proofComplete && childPid) {
      try { process.kill(-childPid, 'SIGKILL'); } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

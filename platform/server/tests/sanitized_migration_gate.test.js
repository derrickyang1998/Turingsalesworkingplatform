const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const sqliteDigest = require('../services/sqlite_digest_service');
const knowledgeService = require('../services/knowledge_service');
const { createCampaignService } = require('../services/campaign_service');
const { buildCustomerIdentity } = require('../services/crm_contract');
const sanitizer = require('../scripts/sanitize_production_shape');
const migrationGate = require('../scripts/verify_campaign_migration_gate');
const manifest = require('../scripts/sanitization_manifest.json');
const v7Manifest = sanitizer._testing.manifestProfileForVersion(manifest, 7);
const {
  buildCampaignWorkflowSnapshot,
  checksumCampaignWorkflowSnapshot
} = require('../services/campaign_workflow_service');

const REGISTERED_MIGRATIONS = migrationGate.REGISTERED_MIGRATIONS;
const EXPECTED_STRUCTURAL_POLICY_SHA256 = '3375042639528a5bd849ae0aa5c5742a616d17bda8653086e9389cd12156d42d';
const BASH = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
const HAS_BASH = process.platform !== 'win32' || fs.existsSync(BASH);
const HAS_NATIVE_FLOCK = process.platform === 'linux'
  && spawnSync('flock', ['--version'], { stdio: 'ignore' }).status === 0;

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function gitBashPath(filePath) {
  const resolved = path.resolve(filePath);
  if (process.platform === 'win32') {
    const relativeToTemp = path.relative(path.resolve(os.tmpdir()), resolved);
    if (relativeToTemp === '' || (!relativeToTemp.startsWith('..') && !path.isAbsolute(relativeToTemp))) {
      const normalizedRelative = relativeToTemp.replaceAll('\\', '/');
      return normalizedRelative ? `/tmp/${normalizedRelative}` : '/tmp';
    }
  }
  const normalized = resolved.replaceAll('\\', '/');
  const match = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  return match ? `/${match[1].toLowerCase()}/${match[2]}` : normalized;
}

function bootstrapLibraryHarness(root, body) {
  const bootstrapPath = path.join(__dirname, '..', 'scripts', 'bootstrap_production_runtime.sh');
  const configuredPython = process.env.PYTHON3 || process.env.PYTHON_BIN;
  const values = {
    TM_REMOTE_ROOT: path.join(root, 'remote'),
    TM_LIVE_DIR: path.join(root, 'live'),
    TM_STATE_ROOT: path.join(root, 'state'),
    TM_GATE_ROOT: path.join(root, 'gate'),
    TM_ENV_DIR: path.join(root, 'etc'),
    TM_JOURNAL_ROOT: path.join(root, 'journal'),
    TM_SANITIZER_JOURNAL_ROOT: path.join(root, 'sanitizer-journals'),
    TM_SANITIZER_RUN_ROOT: path.join(root, 'sanitizer-runs')
  };
  return [
    'set -Eeuo pipefail',
    process.env.TM_DEBUG_SANITIZER_BASH === '1' ? 'set -x' : '',
    'PATH=/usr/bin:/bin:$PATH',
    'export PATH',
    process.platform === 'win32' && configuredPython
      ? `python3() { ${shellQuote(gitBashPath(configuredPython))} "$@"; }`
      : '',
    ...Object.entries(values).map(([name, value]) => `export ${name}=${shellQuote(gitBashPath(value))}`),
    'export TM_BOOTSTRAP_LIBRARY_ONLY=1',
    'export TM_TEST_GATE_MOUNTS=',
    `source ${shellQuote(gitBashPath(bootstrapPath))}`,
    body
  ].join('\n');
}

function waitForChildOutput(child, pattern, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for child output ${pattern}: ${output}`));
    }, timeoutMs);
    const onData = (chunk) => {
      output += chunk.toString('utf8');
      if (pattern.test(output)) {
        cleanup();
        resolve(output);
      }
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`child exited before ${pattern}: code=${code} signal=${signal} output=${output}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout?.removeListener('data', onData);
      child.removeListener('exit', onExit);
    };
    child.stdout?.on('data', onData);
    child.once('exit', onExit);
  });
}

function lifecycleFenceHolderProgram() {
  return `
    const sanitizer = require(${JSON.stringify(path.join(__dirname, '..', 'scripts', 'sanitize_production_shape.js'))});
    const lease = sanitizer._testing.acquireProductionLifecycleFence({
      fencePath: process.argv[1],
      requireRoot: false
    });
    process.stdout.write('LOCKED ' + process.pid + '\\n');
    process.on('SIGTERM', () => { lease.release(); process.exit(0); });
    setInterval(() => {}, 1000);
  `;
}

function lifecycleFenceAdopterProgram() {
  return `
    const sanitizer = require(${JSON.stringify(path.join(__dirname, '..', 'scripts', 'sanitize_production_shape.js'))});
    const lease = sanitizer._testing.adoptInheritedLifecycleFence({
      fd: 9,
      device: process.argv[1],
      inode: process.argv[2]
    });
    process.stdout.write('ADOPTED ' + process.pid + '\\n');
    process.on('SIGTERM', () => { lease.release(); process.exit(0); });
    setInterval(() => {}, 1000);
  `;
}

async function waitForPidToDisappear(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`process ${pid} remained alive after ${timeoutMs}ms`);
}

function createDanglingFileSymlinkOrSkip(t, linkPath) {
  const missingTarget = `${linkPath}.missing-target`;
  const types = process.platform === 'win32' ? ['file', 'junction'] : ['file'];
  let unavailable;
  for (const type of types) {
    try {
      fs.symlinkSync(missingTarget, linkPath, type);
      return true;
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOTSUP', 'EINVAL'].includes(error.code)) throw error;
      unavailable = error;
    }
  }
  t.skip(`dangling symlink proof unavailable: ${unavailable?.code || 'unsupported'}`);
  return false;
}

function runLifecycleFenceContender(fencePath) {
  return spawnSync(process.execPath, ['-e', `
    const sanitizer = require(${JSON.stringify(path.join(__dirname, '..', 'scripts', 'sanitize_production_shape.js'))});
    try {
      const lease = sanitizer._testing.acquireProductionLifecycleFence({
        fencePath: process.argv[1],
        requireRoot: false
      });
      lease.release();
      process.exit(0);
    } catch (error) {
      process.stderr.write(String(error.code || '') + ':' + error.message);
      process.exit(error.code === 'TM_SANITIZER_LIFECYCLE_FENCE_BUSY' ? 23 : 24);
    }
  `, fencePath], { encoding: 'utf8', timeout: 5_000 });
}

let cachedWslCapability;

function capabilityFailureDetail(result) {
  if (result.error?.code) return result.error.code;
  if (result.signal) return result.signal;
  const raw = String(result.stderr || result.stdout || result.status || '').replace(/\0/g, '');
  const known = raw.match(/E_(?:ACCESSDENIED|FAIL|INVALIDARG)|EACCES|ENOENT/i);
  if (known) return known[0].toUpperCase();
  const printable = raw.replace(/[^\x20-\x7e]+/g, ' ').trim().replace(/\s+/g, ' ');
  return printable.slice(0, 160) || 'unknown failure';
}

function wslLinuxTestCapability() {
  if (cachedWslCapability) return cachedWslCapability;
  if (process.env.TM_RUN_WSL_SANITIZER_TESTS !== '1') {
    cachedWslCapability = Object.freeze({
      available: false,
      reason: 'Linux proof not executed: set TM_RUN_WSL_SANITIZER_TESTS=1 to opt in to WSL'
    });
    return cachedWslCapability;
  }
  const checkoutRoot = path.resolve(__dirname, '..', '..', '..');
  const converted = spawnSync('wsl.exe', ['-e', 'wslpath', '-a', checkoutRoot], {
    encoding: 'utf8',
    timeout: 15_000
  });
  if (converted.error || converted.signal || converted.status !== 0) {
    cachedWslCapability = Object.freeze({
      available: false,
      reason: `Linux proof not executed: WSL capability unavailable (${capabilityFailureDetail(converted)})`
    });
    return cachedWslCapability;
  }
  const linuxRoot = converted.stdout.replace(/\0/g, '').trim();
  const prerequisites = spawnSync('wsl.exe', ['-e', 'bash', '-lc', [
    'command -v bash >/dev/null',
    'node_bin="$(command -v node || find "$HOME" -type f -path "*/bin/node" -perm -111 -print -quit)"',
    'test -n "$node_bin"'
  ].join('; ')], {
    encoding: 'utf8',
    timeout: 15_000
  });
  if (prerequisites.error || prerequisites.signal || prerequisites.status !== 0) {
    cachedWslCapability = Object.freeze({
      available: false,
      reason: `Linux proof not executed: WSL lacks required Linux tools (${capabilityFailureDetail(prerequisites)})`
    });
    return cachedWslCapability;
  }
  cachedWslCapability = Object.freeze({ available: true, linuxRoot });
  return cachedWslCapability;
}

function runLinuxTestThroughWsl(t, testName, timeout = 90_000) {
  const capability = wslLinuxTestCapability();
  if (!capability.available) {
    t.skip(capability.reason);
    return false;
  }
  const command = [
    'set -euo pipefail',
    'node_bin="$(command -v node || find "$HOME" -type f -path "*/bin/node" -perm -111 -print -quit)"',
    'test -n "$node_bin"',
    'export PATH="$(dirname -- "$node_bin"):$PATH"',
    `cd ${shellQuote(capability.linuxRoot)}`,
    `"$node_bin" --test --test-name-pattern=${shellQuote(testName)} platform/server/tests/sanitized_migration_gate.test.js`
  ].join('; ');
  const result = spawnSync('wsl.exe', ['-e', 'bash', '-lc', command], {
    encoding: 'utf8',
    timeout
  });
  const diagnostics = [
    result.error && result.error.stack,
    result.signal && `signal=${result.signal}`,
    result.stdout,
    result.stderr
  ].filter(Boolean).join('\n');
  assert.equal(result.error, undefined, diagnostics);
  assert.equal(result.signal, null, diagnostics);
  assert.equal(result.status, 0, diagnostics);
  assert.match(result.stdout, /# pass 1\b/);
  assert.match(result.stdout, /# fail 0\b/);
  return true;
}

function migratedFixture(name, targetVersion = 8) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `tm-sanitize-${name}-`));
  const dbPath = path.join(root, 'source.db');
  const migrationOptions = { rootDir: path.resolve(__dirname, '..') };
  if (targetVersion > 1) {
    migrationOptions.registeredMigrations = REGISTERED_MIGRATIONS.filter(
      (migration) => migration.version <= targetVersion
    );
  }
  const db = migrationService.openMigratedDatabase(dbPath, migrationOptions);
  return { root, dbPath, db };
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function populateSensitiveFixture(fixture, options = {}) {
  const displayProbe = `tm-probe-display-${crypto.randomBytes(18).toString('hex')}`;
  const emailProbe = `tm-probe-${crypto.randomBytes(18).toString('hex')}@invalid.example`;
  fixture.db.prepare('UPDATE users SET display_name=?,email=? WHERE id=(SELECT MIN(id) FROM users)').run(displayProbe, emailProbe);
  fixture.db.prepare(`
    INSERT INTO brands (name,name_cn,amazon_rating,youtube_followers,creative_angles,created_at)
    VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)
  `).run(`brand-${crypto.randomBytes(12).toString('hex')}`, 'synthetic-one', 1.0, 10, 'private angle one');
  fixture.db.prepare(`
    INSERT INTO brands (name,name_cn,amazon_rating,youtube_followers,creative_angles,created_at)
    VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)
  `).run(`brand-${crypto.randomBytes(12).toString('hex')}`, 'synthetic-two', 2.5, 20, 'private angle two');
  if (options.protectionTrigger !== false) {
    fixture.db.exec(`
      CREATE TRIGGER trg_sanitizer_append_only_probe
      BEFORE UPDATE OF display_name ON users
      BEGIN SELECT RAISE(ABORT,'append-only protection remains active'); END;
    `);
  }
  return { displayProbe, emailProbe };
}

function populateManagedV1GateFixture(fixture) {
  const probes = populateSensitiveFixture(fixture, { protectionTrigger: false });
  const userId = fixture.db.prepare('SELECT MIN(id) AS id FROM users').get().id;
  const insertCustomer = fixture.db.prepare(`
    INSERT INTO customers (brand_name,company_name,stage,source,created_by,assigned_to)
    VALUES (?,?,?,?,?,?)
  `);
  const negotiationCustomerId = Number(insertCustomer.run(
    'Legacy negotiation customer', 'Legacy negotiation company', 'negotiation',
    'managed-v1-stage-fixture', userId, userId
  ).lastInsertRowid);
  const maintenanceCustomerId = Number(insertCustomer.run(
    'Legacy maintenance customer', 'Legacy maintenance company', 'maintenance',
    'managed-v1-stage-fixture', userId, userId
  ).lastInsertRowid);
  fixture.db.prepare(`
    INSERT INTO customer_activity (customer_id,user_id,action,stage_from,stage_to,notes)
    VALUES (?,?, 'stage_change', 'negotiation', 'maintenance', 'Legacy stage transition')
  `).run(negotiationCustomerId, userId);
  const ftsProbe = `legacyfts${crypto.randomBytes(12).toString('hex')}`;
  const entryId = Number(fixture.db.prepare(`
    INSERT INTO knowledge_entries (
      entry_type,source_type,key_terms,content,created_by,is_public,title,tags_json,visibility
    ) VALUES ('note','managed-v1',?,?,?,0,'Managed v1 sanitizer fixture','[]','private')
  `).run(ftsProbe, `Private managed v1 content ${ftsProbe}`, userId).lastInsertRowid);
  const chunkId = Number(fixture.db.prepare(`
    INSERT INTO knowledge_chunks (entry_id,chunk_index,content,token_count)
    VALUES (?,0,?,7)
  `).run(entryId, `Private managed v1 chunk ${ftsProbe}`).lastInsertRowid);
  sqliteDigest.rebuildKnowledgeChunksFts(fixture.db);
  assert.deepEqual(sqliteDigest.matchKnowledgeChunksCanary(fixture.db, ftsProbe), [chunkId]);
  return {
    ...probes,
    ftsProbe,
    entryId,
    chunkId,
    negotiationCustomerId,
    maintenanceCustomerId
  };
}

test('sanitizer keeps migrated probability fields inside the production 0-100 domain', () => {
  const fixture = migratedFixture('probability-domain', 1);
  try {
    const userId = fixture.db.prepare('SELECT MIN(id) AS id FROM users').get().id;
    fixture.db.prepare(`
      INSERT INTO customers (brand_name,company_name,stage,source,created_by,assigned_to,win_probability)
      VALUES ('Probability 20','Probability 20 company','negotiation','probability-fixture',?,?,20)
    `).run(userId, userId);
    fixture.db.prepare(`
      INSERT INTO customers (brand_name,company_name,stage,source,created_by,assigned_to,win_probability)
      VALUES ('Probability 80','Probability 80 company','maintenance','probability-fixture',?,?,80)
    `).run(userId, userId);
    const insertGlobalInteger = fixture.db.prepare(`
      INSERT INTO brands (name,youtube_followers,created_at)
      VALUES (?,?,CURRENT_TIMESTAMP)
    `);
    fixture.db.transaction(() => {
      for (let value = 0; value <= 100; value += 1) {
        insertGlobalInteger.run(`Global integer ${value}`, value);
      }
    })();
    fixture.db.close();

    const outputPath = path.join(fixture.root, 'sanitized.db');
    sanitizer.sanitizeProductionShape({ sourcePath: fixture.dbPath, outputPath });
    const output = new Database(outputPath, { readonly: true, fileMustExist: true });
    try {
      const values = output.prepare(`
        SELECT win_probability FROM customers
        WHERE source LIKE 'tmtext-%' AND win_probability IS NOT NULL
        ORDER BY win_probability
      `).all().map((row) => row.win_probability);
      assert.equal(values.length >= 2, true);
      assert.equal(values.every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 100), true);
      assert.equal(new Set(values).size, values.length, 'distinct source probabilities retain distinct ranks');
      assert.ok(values.every((value) => ![20, 80].includes(value)));
    } finally {
      output.close();
    }
  } finally {
    closeAndRemove(fixture);
  }
});

test('sanitizer fails closed with a bounded error when the probability replacement domain is exhausted', () => {
  const fixture = migratedFixture('probability-domain-exhausted', 1);
  try {
    const userId = fixture.db.prepare('SELECT MIN(id) AS id FROM users').get().id;
    const insert = fixture.db.prepare(`
      INSERT INTO customers (
        brand_name,company_name,stage,source,created_by,assigned_to,win_probability
      ) VALUES (?,?,'negotiation','probability-exhaustion-fixture',?,?,?)
    `);
    fixture.db.transaction(() => {
      for (let value = 0; value <= 100; value += 1) {
        insert.run(`Probability ${value}`, `Probability company ${value}`, userId, userId, value);
      }
    })();
    fixture.db.close();

    const outputPath = path.join(fixture.root, 'sanitized.db');
    assert.throws(
      () => sanitizer.sanitizeProductionShape({ sourcePath: fixture.dbPath, outputPath }),
      /customers\.win_probability probability replacement domain is exhausted/i
    );
  } finally {
    closeAndRemove(fixture);
  }
});

test('managed v1 text-backed sensitive-number columns keep text storage and sanitize source values', () => {
  const fixture = migratedFixture('text-backed-sensitive-number', 1);
  try {
    const insert = fixture.db.prepare(`
      INSERT INTO brands (name,name_cn,estimated_annual_revenue,avg_engagement,created_at)
      VALUES (?,?,?,?,CURRENT_TIMESTAMP)
    `);
    const firstId = Number(insert.run(
      'Private numeric text brand one', 'Private numeric text one', '$50M-$100M', '3.8'
    ).lastInsertRowid);
    const secondId = Number(insert.run(
      'Private numeric text brand two', 'Private numeric text two', '500000000.0', '0.035'
    ).lastInsertRowid);
    fixture.db.close();

    const outputPath = path.join(fixture.root, 'sanitized.db');
    assert.doesNotThrow(
      () => sanitizer.sanitizeProductionShape({ sourcePath: fixture.dbPath, outputPath })
    );
    const output = new Database(outputPath, { readonly: true, fileMustExist: true });
    try {
      const rows = output.prepare(`
        SELECT id,
          typeof(estimated_annual_revenue) AS revenue_type,estimated_annual_revenue,
          typeof(avg_engagement) AS engagement_type,avg_engagement
        FROM brands WHERE id IN (?,?) ORDER BY id
      `).all(firstId, secondId);
      assert.equal(rows.length, 2);
      assert.ok(rows.every((row) => row.revenue_type === 'text'));
      assert.ok(rows.every((row) => row.engagement_type === 'text'));
      assert.equal(new Set(rows.map((row) => row.estimated_annual_revenue)).size, 2);
      assert.equal(new Set(rows.map((row) => row.avg_engagement)).size, 2);
      assert.ok(rows.every((row) => !['$50M-$100M', '500000000.0'].includes(row.estimated_annual_revenue)));
      assert.ok(rows.every((row) => !['3.8', '0.035'].includes(row.avg_engagement)));
    } finally {
      output.close();
    }
  } finally {
    closeAndRemove(fixture);
  }
});

test('derived AI total tokens may rebuild equality partitions while preserving the declared formula', () => {
  const fixture = migratedFixture('derived-ai-total-tokens', 1);
  try {
    const userId = fixture.db.prepare('SELECT MIN(id) AS id FROM users').get().id;
    const conversationId = Number(fixture.db.prepare(`
      INSERT INTO ai_conversations (user_id,title,visibility,source_module)
      VALUES (?,'Private token accounting','private','assistant')
    `).run(userId).lastInsertRowid);
    const insert = fixture.db.prepare(`
      INSERT INTO ai_messages (
        conversation_id,user_id,role,content,prompt_tokens,completion_tokens,total_tokens,metadata_json
      ) VALUES (?,?,'assistant',?,?,?,?, '{}')
    `);
    insert.run(conversationId, userId, 'Private response one', 1015, 326, 1341);
    insert.run(conversationId, userId, 'Private response two', 1027, 319, 1346);
    fixture.db.close();

    const outputPath = path.join(fixture.root, 'sanitized.db');
    assert.doesNotThrow(
      () => sanitizer.sanitizeProductionShape({ sourcePath: fixture.dbPath, outputPath })
    );
    const output = new Database(outputPath, { readonly: true, fileMustExist: true });
    try {
      const accounting = output.prepare(`
        SELECT COUNT(*) AS rows,
          SUM(CASE WHEN total_tokens=prompt_tokens+completion_tokens THEN 1 ELSE 0 END) AS valid_rows,
          SUM(CASE WHEN
            prompt_tokens BETWEEN 0 AND 9007199254740991
            AND completion_tokens BETWEEN 0 AND 9007199254740991
            AND total_tokens BETWEEN 0 AND 9007199254740991
          THEN 1 ELSE 0 END) AS safe_rows,
          COUNT(DISTINCT total_tokens) AS total_partitions
        FROM ai_messages WHERE conversation_id=?
      `).get(conversationId);
      assert.equal(accounting.rows, 2);
      assert.equal(accounting.valid_rows, 2);
      assert.equal(accounting.safe_rows, 2);
      assert.equal(accounting.total_partitions, 1);
    } finally {
      output.close();
    }
  } finally {
    closeAndRemove(fixture);
  }
});

function sha256Text(value) {
  return crypto.createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
}

function framedSha256(values) {
  const frames = values.map((value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, bytes]);
  });
  return crypto.createHash('sha256').update(Buffer.concat(frames)).digest('hex');
}

function populateCriticalReviewFixture(fixture, options = {}) {
  const identity = fixture.db.prepare(`
    SELECT membership.org_id AS orgId,membership.user_id AS userId,team.team_id AS teamId
    FROM organization_memberships membership
    JOIN team_memberships team
      ON team.org_id=membership.org_id AND team.user_id=membership.user_id
    WHERE membership.status='active' AND team.status='active'
    ORDER BY membership.user_id,team.team_id LIMIT 1
  `).get();
  assert.ok(identity, 'fixture requires an active organization/team member');

  const ids = {
    customerId: 881001,
    opportunityId: 881002,
    campaignId: 881003,
    templateId: 881004,
    instanceId: 881005,
    taskId: 881006,
    entryId: 881007,
    chunkId: 881008,
    linkId: 881009,
    conversationId: 881010,
    messageId: 881011,
    referenceId: 881012,
    brandId: 881013,
    eventId: 881014,
    dispatchId: 881015,
    collisionCustomerId: 881016,
    singletonCustomerId: 881017,
    nullIdentityCustomerId: 881018,
    contactId: 881019,
    crmTaskId: 881020,
    crmAuditId: 881021
  };
  const graph = {
    nodes: [
      { id: 'review-start', type: 'start', label: 'Private start', config: {} },
      { id: 'review-condition', type: 'condition', label: 'Private condition', config: {} },
      {
        id: 'review-task',
        type: 'task',
        label: 'Private task',
        config: {
          title: 'Private task title', description: 'Private task description',
          assignee_id: identity.userId, assignee_role: null, due_hours: 24
        }
      },
      { id: 'review-end', type: 'end', label: 'Private end', config: {} }
    ],
    edges: [
      { id: 'review-start-condition', from: 'review-start', to: 'review-condition', outcome: 'next', priority: 0, condition: null },
      {
        id: 'review-condition-task',
        from: 'review-condition',
        to: 'review-task',
        outcome: 'match',
        priority: 7,
        condition: {
          op: 'and',
          args: [
            { op: 'eq', left: { var: 'campaign.lifecycle_state' }, right: 'qualified' },
            { op: 'not', arg: { op: 'eq', left: { var: 'task.action' }, right: 'reject' } }
          ]
        }
      },
      { id: 'review-condition-end', from: 'review-condition', to: 'review-end', outcome: 'fallback', priority: 9, condition: null },
      { id: 'review-task-end', from: 'review-task', to: 'review-end', outcome: 'complete', priority: 0, condition: null }
    ]
  };
  const entryContent = 'private knowledge alpha canary';
  const chunkContent = 'private chunk beta canary';
  const sourceIdentity = sha256Text('private source identity');
  const sourceHash = sha256Text('legacy source hash');
  const entryDigest = sha256Text(entryContent);
  const chunkDigest = sha256Text(chunkContent);
  const bundleId = sha256Text('private campaign knowledge bundle');
  const blobValue = Buffer.from([0x00, 0x80, 0xff, 0x41, 0x00, 0x7f]);
  const customerIdentity = buildCustomerIdentity({
    brand_name: 'Private customer',
    company_name: 'Private customer company'
  }).key;
  const singletonIdentity = buildCustomerIdentity({
    brand_name: 'Private singleton',
    company_name: 'Private singleton company'
  }).key;

  fixture.db.transaction(() => {
    fixture.db.prepare(`
      INSERT INTO customers (
        id,brand_name,company_name,stage,source,created_by,assigned_to,is_public,
        org_id,team_id,normalized_identity_key,duplicate_enforced
      ) VALUES (?,?,?,'proposal','sanitizer-review',?,?,0,?,?,?,0)
    `).run(
      ids.customerId, 'Private customer', 'Private customer company',
      identity.userId, identity.userId, identity.orgId, identity.teamId, customerIdentity
    );
    fixture.db.prepare(`
      INSERT INTO customers (
        id,brand_name,company_name,stage,source,created_by,assigned_to,is_public,
        org_id,team_id,normalized_identity_key,duplicate_enforced
      ) VALUES (?,?,?,'proposal','sanitizer-review',?,?,0,?,?,?,0)
    `).run(
      ids.collisionCustomerId, 'Private customer', 'Private customer company',
      identity.userId, identity.userId, identity.orgId, identity.teamId, customerIdentity
    );
    fixture.db.prepare(`
      INSERT INTO customers (
        id,brand_name,company_name,stage,source,created_by,assigned_to,is_public,
        org_id,team_id,normalized_identity_key,duplicate_enforced
      ) VALUES (?,?,?,'proposal','sanitizer-review',?,?,0,?,?,?,1)
    `).run(
      ids.singletonCustomerId, 'Private singleton', 'Private singleton company',
      identity.userId, identity.userId, identity.orgId, identity.teamId, singletonIdentity
    );
    fixture.db.prepare(`
      INSERT INTO customers (
        id,brand_name,company_name,stage,source,created_by,assigned_to,is_public,
        org_id,team_id,normalized_identity_key,duplicate_enforced
      ) VALUES (?,?,?,'proposal','sanitizer-review',?,?,0,?,?,NULL,0)
    `).run(
      ids.nullIdentityCustomerId, 'Private null identity', 'Private null identity company',
      identity.userId, identity.userId, identity.orgId, identity.teamId
    );
    fixture.db.prepare(`
      INSERT INTO opportunities (
        id,customer_id,name,stage,value,win_probability,product_name,channel_type,created_by,
        org_id,team_id,owner_user_id
      ) VALUES (?,?,'Private opportunity','proposal',12345,67,'Private product','influencer',?,?,?,?)
    `).run(
      ids.opportunityId, ids.customerId, identity.userId,
      identity.orgId, identity.teamId, identity.userId
    );
    fixture.db.prepare(`
      INSERT INTO customer_contacts (
        id,org_id,customer_id,name,role,email,phone,is_preferred,created_by,
        created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,1,?,'2026-08-01 09:00:00','2026-08-01 09:00:00')
    `).run(
      ids.contactId, identity.orgId, ids.customerId, 'Private buyer', 'CMO',
      'private-buyer@example.invalid', '+1 555 0100', identity.userId
    );
    fixture.db.prepare(`
      INSERT INTO crm_tasks (
        id,org_id,team_id,customer_id,opportunity_id,owner_user_id,title,description,
        due_at,status,source,created_by,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,'Private follow-up','Private task details',
        '2026-08-15 09:00:00','open','manual',?,'2026-08-01 09:05:00','2026-08-01 09:05:00')
    `).run(
      ids.crmTaskId, identity.orgId, identity.teamId, ids.customerId,
      ids.opportunityId, identity.userId, identity.userId
    );
    fixture.db.prepare(`
      INSERT INTO crm_audit_events (
        id,org_id,customer_id,opportunity_id,task_id,contact_id,actor_user_id,
        event_type,request_id,correlation_id,occurred_at,metadata_json
      ) VALUES (?,?,?,?,?,?,?,'task_created','private-request','private-correlation',
        '2026-08-01 09:06:00','{"private_audit":"private value"}')
    `).run(
      ids.crmAuditId, identity.orgId, ids.customerId, ids.opportunityId,
      ids.crmTaskId, ids.contactId, identity.userId
    );
    fixture.db.prepare(`
      INSERT INTO campaigns (
        id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,
        lifecycle_state,operational_status,row_version,product_name,region,currency,budget_minor
      ) VALUES (?,?,?,?,?,?,?,'lead','active',1,'Private product','US','USD',987654)
    `).run(
      ids.campaignId, identity.orgId, 'Private campaign', ids.customerId,
      ids.opportunityId, identity.userId, identity.teamId
    );
    fixture.db.prepare(`
      INSERT INTO workflow_templates (
        id,name,description,module,category,nodes,edges,version,is_active,created_by,trigger_config_json
      ) VALUES (?,?,?,'campaign','approval',?,?,1,1,?,?)
    `).run(
      ids.templateId, 'Private workflow', 'Private workflow description',
      JSON.stringify(graph.nodes), JSON.stringify(graph.edges), identity.userId,
      JSON.stringify({ event_type: 'lifecycle_transition', previous_state: 'lead', next_state: 'qualified' })
    );
    fixture.db.prepare(`
      INSERT INTO workflow_instances (
        id,template_id,business_type,business_id,current_node_id,status,node_data,started_by
      ) VALUES (?,?,'sanitizer_fixture',?,'review-task','active',?,?)
    `).run(ids.instanceId, ids.templateId, ids.campaignId, JSON.stringify({ current_node_id: 'review-task' }), identity.userId);
    fixture.db.prepare(`
      INSERT INTO workflow_tasks (
        id,instance_id,node_id,node_type,title,description,assignee_id,status,assignment_version
      ) VALUES (?,?,'review-task','task','Private task','Private task description',?,'pending',1)
    `).run(ids.taskId, ids.instanceId, identity.userId);

    fixture.db.prepare(`
      INSERT INTO knowledge_entries (
        id,entry_type,source_type,source_id,key_terms,content,created_by,is_public,
        title,summary,tags_json,visibility,source_hash,business_type,business_id,
        metadata_json,embedding_json,source_identity_sha256,content_sha256
      ) VALUES (
        ?,'note','manual',?,'private key terms',?,?,0,
        'Private knowledge title','Private knowledge summary','["private-tag"]','team',?,
        'campaign',?,?,'[1.0,-0.0]',?,?
      )
    `).run(
      ids.entryId, ids.entryId, entryContent, identity.userId,
      sourceHash, String(ids.campaignId), JSON.stringify(options.knowledgeEntryMetadata || {
        private_key: 'private value', short: 'j7', numeric: 731927
      }), sourceIdentity, entryDigest
    );
    fixture.db.prepare(`
      INSERT INTO knowledge_chunks (
        id,entry_id,chunk_index,content,metadata_json,token_count,embedding_json,content_sha256
      ) VALUES (?,?,0,?,'{"private_chunk":"private value"}',77,'[2.0,-0.0]',?)
    `).run(ids.chunkId, ids.entryId, chunkContent, chunkDigest);
    fixture.db.prepare(`
      INSERT INTO campaign_record_links (
        id,org_id,campaign_id,record_type,bundle_id,record_id,relation_type,created_by,metadata_json
      ) VALUES (?,?,?,'knowledge_entry',?,?,'knowledge',?,'{"private_link":"private value"}')
    `).run(
      ids.linkId, identity.orgId, ids.campaignId, bundleId,
      String(ids.entryId), identity.userId
    );
    fixture.db.prepare(`
      INSERT INTO ai_conversations (id,user_id,title,archived_summary_id)
      VALUES (?,?,'Private AI conversation',?)
    `).run(ids.conversationId, identity.userId, ids.entryId);
    fixture.db.prepare(`
      INSERT INTO ai_messages (
        id,conversation_id,user_id,role,content,model,prompt_tokens,completion_tokens,total_tokens,metadata_json
      ) VALUES (?,? ,?,'assistant','Private AI answer','private-model',11,13,24,'{"private_prompt":"private value"}')
    `).run(ids.messageId, ids.conversationId, identity.userId);
    fixture.db.prepare(`
      INSERT INTO ai_references (
        id,message_id,reference_type,reference_id,title,url,snippet,provider,metadata_json,
        reference_schema_version,knowledge_entry_id,knowledge_chunk_id,campaign_id,
        source_identity_sha256,entry_content_sha256,chunk_content_sha256,reference_rank,selection_origin
      ) VALUES (
        ?,?,'knowledge',?,'Private reference','https://private.invalid/source','Private snippet',
        'private-provider','{"private_reference":"private value"}',1,?,?,?,?,?,?,1,'selected'
      )
    `).run(
      ids.referenceId, ids.messageId, String(ids.entryId), ids.entryId, ids.chunkId,
      ids.campaignId, sourceIdentity, entryDigest, chunkDigest
    );
    fixture.db.prepare(`
      INSERT INTO brands (
        id,name,name_cn,amazon_rating,youtube_followers,creative_angles,created_at
      ) VALUES (?,'Private blob brand','Private blob brand',CAST(-0.0 AS REAL),42,?,CURRENT_TIMESTAMP)
    `).run(ids.brandId, blobValue);
  }).immediate();

  const transition = createCampaignService(fixture.db).transitionCampaign({
    userId: identity.userId,
    campaignId: ids.campaignId,
    requestId: 'sanitizer-populated-workflow-transition',
    idempotencyKey: 'sanitizer-populated-workflow-transition',
    body: {
      expected_state: 'lead',
      expected_version: 1,
      next_state: 'qualified',
      reason: 'Create a populated sanitizer workflow dispatch fixture'
    }
  });
  assert.equal(transition.status, 200);
  ids.eventId = transition.body.event.id;
  ids.dispatchId = fixture.db.prepare(`
    SELECT id FROM campaign_workflow_dispatches
    WHERE campaign_id=? AND template_id=?
  `).get(ids.campaignId, ids.templateId).id;
  fixture.db.prepare('DELETE FROM request_idempotency WHERE campaign_id=?').run(ids.campaignId);

  sqliteDigest.rebuildKnowledgeChunksFts(fixture.db);
  return {
    ...ids, ...identity, graph, sourceIdentity, sourceHash, entryDigest, chunkDigest,
    bundleId, blobValue, customerIdentity, singletonIdentity
  };
}

function assertCriticalFixtureInvariants(db, fixture, options = {}) {
  const crmCustomers = db.prepare(`
    SELECT id,brand_name,company_name,normalized_identity_key,duplicate_enforced
    FROM customers WHERE id IN (?,?,?,?) ORDER BY id
  `).all(
    fixture.customerId, fixture.collisionCustomerId,
    fixture.singletonCustomerId, fixture.nullIdentityCustomerId
  );
  assert.equal(crmCustomers.length, 4, 'populated v6 CRM customer rows must survive');
  const [primaryCustomer, collisionCustomer, singletonCustomer, nullIdentityCustomer] = crmCustomers;
  assert.equal(primaryCustomer.normalized_identity_key, buildCustomerIdentity(primaryCustomer).key);
  assert.equal(collisionCustomer.normalized_identity_key, primaryCustomer.normalized_identity_key);
  assert.equal(primaryCustomer.duplicate_enforced, 0);
  assert.equal(collisionCustomer.duplicate_enforced, 0);
  assert.equal(singletonCustomer.normalized_identity_key, buildCustomerIdentity(singletonCustomer).key);
  assert.equal(singletonCustomer.duplicate_enforced, 1);
  assert.equal(nullIdentityCustomer.normalized_identity_key, null);
  assert.equal(nullIdentityCustomer.duplicate_enforced, 0);

  assert.deepEqual(
    db.prepare(`
      SELECT org_id,customer_id,is_preferred,created_by,archived_at
      FROM customer_contacts WHERE id=?
    `).get(fixture.contactId),
    {
      org_id: fixture.orgId,
      customer_id: fixture.customerId,
      is_preferred: 1,
      created_by: fixture.userId,
      archived_at: null
    }
  );
  assert.deepEqual(
    db.prepare(`
      SELECT org_id,team_id,customer_id,opportunity_id,owner_user_id,status,source,
        completed_at,completed_by,created_by
      FROM crm_tasks WHERE id=?
    `).get(fixture.crmTaskId),
    {
      org_id: fixture.orgId,
      team_id: fixture.teamId,
      customer_id: fixture.customerId,
      opportunity_id: fixture.opportunityId,
      owner_user_id: fixture.userId,
      status: 'open',
      source: 'manual',
      completed_at: null,
      completed_by: null,
      created_by: fixture.userId
    }
  );
  assert.deepEqual(
    db.prepare(`
      SELECT org_id,customer_id,opportunity_id,task_id,contact_id,actor_user_id,event_type
      FROM crm_audit_events WHERE id=?
    `).get(fixture.crmAuditId),
    {
      org_id: fixture.orgId,
      customer_id: fixture.customerId,
      opportunity_id: fixture.opportunityId,
      task_id: fixture.crmTaskId,
      contact_id: fixture.contactId,
      actor_user_id: fixture.userId,
      event_type: 'task_created'
    }
  );
  assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
  assert.deepEqual(db.pragma('foreign_key_check'), []);

  const link = db.prepare(`
    SELECT record_id,typeof(record_id) AS record_type,bundle_id
    FROM campaign_record_links WHERE id=?
  `).get(fixture.linkId);
  assert.match(link.record_id, /^[1-9][0-9]*$/, 'record_id must remain canonical digit-only text');
  assert.equal(link.record_id, String(fixture.entryId));
  assert.equal(link.record_type, 'text');

  const equality = db.prepare(`
    SELECT
      entry.source_identity_sha256 AS source_owner,
      reference.source_identity_sha256 AS source_snapshot,
      entry.content_sha256 AS entry_owner,
      reference.entry_content_sha256 AS entry_snapshot,
      chunk.content_sha256 AS chunk_owner,
      reference.chunk_content_sha256 AS chunk_snapshot,
      link.bundle_id AS link_bundle,custody.bundle_id AS custody_bundle
    FROM ai_references reference
    JOIN knowledge_entries entry ON entry.id=reference.knowledge_entry_id
    JOIN knowledge_chunks chunk ON chunk.id=reference.knowledge_chunk_id
    JOIN campaign_record_links link ON link.id=?
    JOIN knowledge_current_custody custody ON custody.link_id=link.id
    WHERE reference.id=?
  `).get(fixture.linkId, fixture.referenceId);
  assert.ok(equality, 'fixture requires linked v1 AI and custody projections');
  assert.equal(equality.source_snapshot, equality.source_owner);
  assert.equal(equality.entry_snapshot, equality.entry_owner);
  assert.equal(equality.chunk_snapshot, equality.chunk_owner);
  assert.equal(equality.custody_bundle, equality.link_bundle);

  const template = db.prepare('SELECT nodes,edges FROM workflow_templates WHERE id=?').get(fixture.templateId);
  const nodes = JSON.parse(template.nodes);
  const edges = JSON.parse(template.edges);
  const nodeIds = new Set(nodes.map((node) => node.id));
  assert.ok(edges.every((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to)), 'every edge endpoint must resolve');
  assert.ok(nodeIds.has(db.prepare('SELECT current_node_id FROM workflow_instances WHERE id=?').get(fixture.instanceId).current_node_id));
  assert.ok(nodeIds.has(db.prepare('SELECT node_id FROM workflow_tasks WHERE id=?').get(fixture.taskId).node_id));

  const dispatch = db.prepare(`
    SELECT template_snapshot_json,template_checksum
    FROM campaign_workflow_dispatches WHERE id=?
  `).get(fixture.dispatchId);
  const snapshot = JSON.parse(dispatch.template_snapshot_json);
  const snapshotNodeIds = new Set(snapshot.nodes.map((node) => node.id));
  assert.deepEqual(snapshotNodeIds, nodeIds, 'pinned snapshot and template must share node reference tokens');
  assert.ok(snapshot.edges.every((edge) => snapshotNodeIds.has(edge.from) && snapshotNodeIds.has(edge.to)));
  assert.equal(
    dispatch.template_snapshot_json,
    sqliteDigest.canonicalJsonBytes(snapshot).toString('utf8'),
    'sanitized immutable snapshot must remain canonical JSON'
  );
  assert.equal(dispatch.template_checksum, checksumCampaignWorkflowSnapshot(snapshot));
  const conditionEdge = snapshot.edges.find((edge) => edge.outcome === 'match');
  assert.equal(conditionEdge.priority, 7);
  assert.equal(conditionEdge.condition.op, 'and');
  assert.equal(conditionEdge.condition.args[0].left.var, 'campaign.lifecycle_state');

  const blob = db.prepare(`
    SELECT typeof(creative_angles) AS storage_type,creative_angles,
      typeof(amazon_rating) AS rating_type,amazon_rating
    FROM brands WHERE id=?
  `).get(fixture.brandId);
  assert.equal(blob.storage_type, 'blob');
  assert.ok(Buffer.isBuffer(blob.creative_angles));
  assert.equal(blob.rating_type, 'real');

  const footprint = db.prepare(`
    SELECT footprint.chunk_count,footprint.entry_payload_bytes,footprint.chunk_payload_bytes,
      length(CAST(COALESCE(entry.title,'') AS BLOB)) +
      length(CAST(COALESCE(entry.summary,'') AS BLOB)) +
      length(CAST(COALESCE(entry.content,'') AS BLOB)) +
      length(CAST(COALESCE(entry.key_terms,'') AS BLOB)) +
      length(CAST(COALESCE(entry.tags_json,'') AS BLOB)) +
      length(CAST(COALESCE(entry.metadata_json,'') AS BLOB)) +
      length(CAST(COALESCE(entry.embedding_json,'') AS BLOB)) AS expected_entry_bytes,
      (SELECT COUNT(*) FROM knowledge_chunks WHERE entry_id=entry.id) AS expected_chunks,
      (SELECT COALESCE(SUM(
        length(CAST(COALESCE(content,'') AS BLOB)) +
        length(CAST(COALESCE(metadata_json,'') AS BLOB)) +
        length(CAST(COALESCE(embedding_json,'') AS BLOB))
      ),0) FROM knowledge_chunks WHERE entry_id=entry.id) AS expected_chunk_bytes
    FROM knowledge_entries entry
    JOIN knowledge_entry_footprints footprint ON footprint.knowledge_entry_id=entry.id
    WHERE entry.id=?
  `).get(fixture.entryId);
  assert.equal(footprint.chunk_count, footprint.expected_chunks);
  assert.equal(footprint.entry_payload_bytes, footprint.expected_entry_bytes);
  assert.equal(footprint.chunk_payload_bytes, footprint.expected_chunk_bytes);

  if (options.expectRebuiltDerived !== true) {
    assert.equal(
      db.prepare('SELECT source_hash FROM knowledge_entries WHERE id=?').get(fixture.entryId).source_hash,
      fixture.sourceHash,
      'source fixture must retain the deliberately stale digest before sanitization'
    );
    return;
  }

  const owners = db.prepare(`
    SELECT
      entry.entry_type,entry.source_type,entry.source_id,entry.source_hash,
      entry.business_type,entry.business_id,entry.created_by,entry.visibility,
      entry.title,entry.summary,entry.content,entry.tags_json,
      entry.source_identity_sha256,entry.content_sha256,
      chunk.content AS chunk_content,chunk.content_sha256 AS chunk_sha256,
      chunk.token_count,
      message.prompt_tokens,message.completion_tokens,message.total_tokens
    FROM knowledge_entries entry
    JOIN knowledge_chunks chunk ON chunk.entry_id=entry.id
    JOIN ai_references reference ON reference.knowledge_entry_id=entry.id
      AND reference.knowledge_chunk_id=chunk.id
    JOIN ai_messages message ON message.id=reference.message_id
    WHERE entry.id=? AND chunk.id=? AND reference.id=?
  `).get(fixture.entryId, fixture.chunkId, fixture.referenceId);
  const ownerId = owners.visibility === 'private' ? String(owners.created_by) : '';
  const expectedSourceHashPayload = [
    owners.source_type || '', owners.source_id === null ? '' : String(owners.source_id),
    owners.business_type || '', owners.business_id || '', ownerId
  ].join('|');
  assert.equal(
    owners.source_hash,
    sha256Text(expectedSourceHashPayload),
    `legacy source hash must be rebuilt from sanitized owner fields: ${JSON.stringify(expectedSourceHashPayload)}`
  );
  assert.equal(
    owners.source_identity_sha256,
    framedSha256([
      'tm-knowledge-source-v1', String(fixture.orgId), String(fixture.campaignId),
      owners.source_type, String(owners.source_id), owners.entry_type, ownerId
    ]),
    'campaign source identity must be rebuilt from sanitized custody and owner fields'
  );
  assert.equal(
    owners.content_sha256,
    framedSha256([
      'tm-knowledge-content-v1', owners.entry_type, owners.title, owners.summary,
      owners.content, JSON.stringify(JSON.parse(owners.tags_json)), owners.visibility
    ]),
    'entry content digest must use the production framed digest'
  );
  assert.equal(owners.chunk_sha256, sha256Text(owners.chunk_content));
  assert.equal(owners.token_count, Math.ceil(Array.from(owners.chunk_content).length / 4));
  assert.equal(owners.total_tokens, owners.prompt_tokens + owners.completion_tokens);

  const gauges = Object.fromEntries(db.prepare(`
    SELECT metric,usage_value FROM knowledge_capacity_gauges
    WHERE scope_type='campaign' AND scope_id=? ORDER BY metric
  `).all(fixture.campaignId).map((row) => [row.metric, row.usage_value]));
  assert.deepEqual(gauges, {
    chunks: footprint.expected_chunks,
    entries: 1,
    payload_bytes: footprint.expected_entry_bytes + footprint.expected_chunk_bytes,
    references: 1
  });
}

function insertBinaryIdempotencyFixture(db, fixture) {
  const responseBytes = 29;
  const result = db.prepare(`
    INSERT INTO request_idempotency (
      org_id,user_id,campaign_id,resource_claim,scope,idempotency_key,reservation_nonce,
      request_hash,audit_fingerprint,expected_event_count,state,status_code,response_kind,
      response_headers_json,response_cache_key,response_sha256,response_bytes,
      response_content_type,response_filename,created_at,updated_at,operation_deadline,expires_at
    ) VALUES (
      @orgId,@userId,@campaignId,@resourceClaim,'proposal.ppt.generate.linked',@idempotencyKey,@reservationNonce,
      @requestHash,@auditFingerprint,1,'completed',200,'binary',@headers,@cacheKey,@responseSha,@responseBytes,
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',@filename,
      datetime('now','-2 minutes'),datetime('now','-2 minutes'),datetime('now','+10 minutes'),datetime('now','+1 day')
    )
  `).run({
    orgId: fixture.orgId,
    userId: fixture.userId,
    campaignId: fixture.campaignId,
    resourceClaim: 'a'.repeat(64),
    idempotencyKey: 'sanitizer-binary-fixture',
    reservationNonce: 'b'.repeat(64),
    requestHash: 'c'.repeat(64),
    auditFingerprint: 'd'.repeat(64),
    headers: JSON.stringify({ 'Content-Type': 'private/type', 'Content-Length': String(responseBytes) }),
    cacheKey: 'e'.repeat(64),
    responseSha: 'f'.repeat(64),
    responseBytes,
    filename: 'private-fixture.pptx'
  });
  return { id: Number(result.lastInsertRowid), responseBytes };
}

function closeAndRemove(fixture) {
  try { if (fixture.db && fixture.db.open) fixture.db.close(); } catch (_error) {}
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

function sqliteString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function compactSqliteClone(sourcePath, outputPath, mutate, options = {}) {
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    source.exec(`VACUUM INTO ${sqliteString(outputPath)}`);
  } finally {
    source.close();
  }
  const output = new Database(outputPath);
  try {
    output.pragma('journal_mode = DELETE');
    output.pragma('secure_delete = OFF');
    mutate(output);
    if (options.vacuum !== false) output.exec('VACUUM');
  } finally {
    output.close();
  }
  return outputPath;
}

test('manifest declares exact managed v1 as primary and keeps isolated v6 through v12 profiles', () => {
  const v1Fixture = migratedFixture('manifest-v1-primary', 1);
  const v6Fixture = migratedFixture('manifest-v6-isolated', 6);
  const v7Fixture = migratedFixture('manifest-v7-isolated', 7);
  const v8Fixture = migratedFixture('manifest-v8-isolated', 8);
  const v9Fixture = migratedFixture('manifest-v9-isolated', 9);
  const v10Fixture = migratedFixture('manifest-v10-isolated', 10);
  const v11Fixture = migratedFixture('manifest-v11-isolated', 11);
  const v12Fixture = migratedFixture('manifest-v12-isolated', 12);
  try {
    assert.equal(manifest.schemaVersion, 1);
    assert.deepEqual(manifest.exactProfiles.map((profile) => profile.schemaVersion), [6, 7, 8, 9, 10, 11, 12]);
    assert.equal(
      manifest.categories['sensitive-number'],
      'run-randomized bounded-domain bijection preserving null/equality/cardinality and SQLite storage type'
    );

    const v1Profile = sanitizer._testing.manifestProfileForVersion(manifest, 1);
    const v6Profile = sanitizer._testing.manifestProfileForVersion(manifest, 6);
    const v7Profile = sanitizer._testing.manifestProfileForVersion(manifest, 7);
    const v8Profile = sanitizer._testing.manifestProfileForVersion(manifest, 8);
    const v9Profile = sanitizer._testing.manifestProfileForVersion(manifest, 9);
    const v10Profile = sanitizer._testing.manifestProfileForVersion(manifest, 10);
    const v11Profile = sanitizer._testing.manifestProfileForVersion(manifest, 11);
    const v12Profile = sanitizer._testing.manifestProfileForVersion(manifest, 12);
    assert.equal(v1Profile.schemaVersion, 1);
    assert.equal(v6Profile.schemaVersion, 6);
    assert.equal(v7Profile.schemaVersion, 7);
    assert.equal(v8Profile.schemaVersion, 8);
    assert.equal(v9Profile.schemaVersion, 9);
    assert.equal(v10Profile.schemaVersion, 10);
    assert.equal(v11Profile.schemaVersion, 11);
    assert.equal(v12Profile.schemaVersion, 12);
    assert.equal(v1Profile.objects.length, sanitizer.actualInventory(v1Fixture.db).length);
    assert.equal(v6Profile.objects.length, sanitizer.actualInventory(v6Fixture.db).length);
    assert.equal(v7Profile.objects.length, sanitizer.actualInventory(v7Fixture.db).length);
    assert.equal(v8Profile.objects.length, sanitizer.actualInventory(v8Fixture.db).length);
    assert.equal(v9Profile.objects.length, sanitizer.actualInventory(v9Fixture.db).length);
    assert.equal(v10Profile.objects.length, sanitizer.actualInventory(v10Fixture.db).length);
    assert.equal(v11Profile.objects.length, sanitizer.actualInventory(v11Fixture.db).length);
    assert.equal(v12Profile.objects.length, sanitizer.actualInventory(v12Fixture.db).length);
    for (const profile of [v1Profile, v6Profile, v7Profile, v8Profile]) {
      assert.equal(profile.jsonPolicy.preserveLeafTypes, true);
      assert.equal(
        profile.jsonPolicy.booleanReplacement,
        'type-preserving-run-randomized-bijection'
      );
      assert.equal(profile.semanticPolicies.forbiddenValues.liveMatch, 'exact-substring');
      assert.equal(profile.semanticPolicies.forbiddenValues.minimumLength, 0);
      assert.equal(profile.semanticPolicies.forbiddenValues.tokenBoundary, false);
      assert.equal(
        profile.semanticPolicies.structuralColumns.validatorVersion,
        'tm-structural-policy-v3-bitable-outbox'
      );
      assert.equal(profile.semanticPolicies.structuralColumns.policySha256, EXPECTED_STRUCTURAL_POLICY_SHA256);
    }
    assert.equal(sanitizer.STRUCTURAL_POLICY_SHA256, EXPECTED_STRUCTURAL_POLICY_SHA256);
    assert.equal(v9Profile.semanticPolicies.structuralColumns.validatorVersion, 'tm-structural-policy-v4-bitable-retry-lineage');
    assert.equal(v10Profile.semanticPolicies.structuralColumns.validatorVersion, 'tm-structural-policy-v5-performance-manual');
    assert.equal(v11Profile.semanticPolicies.structuralColumns.validatorVersion, 'tm-structural-policy-v6-performance-feishu-connection');
    assert.equal(v12Profile.semanticPolicies.structuralColumns.validatorVersion, 'tm-structural-policy-v7-performance-ai-review-audit');
    assert.doesNotThrow(() => sanitizer.validateManifest(manifest, v1Fixture.db));
    assert.doesNotThrow(() => sanitizer.validateManifest(manifest, v6Fixture.db));
    assert.doesNotThrow(() => sanitizer.validateManifest(manifest, v7Fixture.db));
    assert.doesNotThrow(() => sanitizer.validateManifest(manifest, v8Fixture.db));
    assert.doesNotThrow(() => sanitizer.validateManifest(manifest, v9Fixture.db));
    assert.doesNotThrow(() => sanitizer.validateManifest(manifest, v10Fixture.db));
    assert.doesNotThrow(() => sanitizer.validateManifest(manifest, v11Fixture.db));
    assert.doesNotThrow(() => sanitizer.validateManifest(manifest, v12Fixture.db));
  } finally {
    closeAndRemove(v1Fixture);
    closeAndRemove(v6Fixture);
    closeAndRemove(v7Fixture);
    closeAndRemove(v8Fixture);
    closeAndRemove(v9Fixture);
    closeAndRemove(v10Fixture);
    closeAndRemove(v11Fixture);
    closeAndRemove(v12Fixture);
  }
});

test('exact sanitizer profiles reject primary, compatibility, version, and cross-profile drift', () => {
  const v1Fixture = migratedFixture('manifest-v1-profile-drift', 1);
  const v6Fixture = migratedFixture('manifest-v6-profile-drift', 6);
  try {
    const cases = [
      ['primary inventory', v1Fixture.db, (candidate) => {
        candidate.objects[0].columns[0].name = 'drifted_primary_column';
      }],
      ['compatibility inventory', v6Fixture.db, (candidate) => {
        candidate.exactProfiles[0].objects[0].columns[0].name = 'drifted_v6_column';
      }],
      ['primary version', v1Fixture.db, (candidate) => { candidate.schemaVersion = 2; }],
      ['compatibility version', v6Fixture.db, (candidate) => {
        candidate.exactProfiles[0].schemaVersion = 1;
      }],
      ['JSON boolean replacement policy', v1Fixture.db, (candidate) => {
        candidate.jsonPolicy.booleanReplacement = 'string-sentinel';
      }],
      ['cross-profile object', v1Fixture.db, (candidate) => {
        candidate.objects.push(structuredClone(
          candidate.exactProfiles[0].objects.find((object) => object.name === 'campaigns')
        ));
      }]
    ];
    for (const [label, db, mutate] of cases) {
      const candidate = structuredClone(manifest);
      mutate(candidate);
      assert.throws(
        () => sanitizer.validateManifest(candidate, db),
        /manifest|profile|version|unknown|column|object|inventory/i,
        label
      );
    }
  } finally {
    closeAndRemove(v1Fixture);
    closeAndRemove(v6Fixture);
  }
});

test('sanitizer rejects unknown, partial, and future managed source shapes without publishing output', () => {
  const cases = [
    ['unknown', 1, (db) => {
      db.exec('CREATE TABLE sanitizer_unknown_object (id INTEGER PRIMARY KEY)');
    }],
    ['partial', 1, (db) => {
      db.exec('DROP TABLE web_search_cache');
    }],
    ['future', 6, (db) => {
      db.prepare(`
        INSERT INTO schema_migrations (
          version,name,checksum,source_path,engine_version,applied_at
        ) VALUES (7,'007_future_fixture',?,'migrations/007_future_fixture.js',1,'2026-01-02 03:04:05')
      `).run('f'.repeat(64));
    }]
  ];
  for (const [label, version, mutate] of cases) {
    const fixture = migratedFixture(`reject-${label}-source`, version);
    try {
      mutate(fixture.db);
      fixture.db.close();
      const outputPath = path.join(fixture.root, 'must-not-publish.db');
      assert.throws(
        () => sanitizer.sanitizeProductionShape({ sourcePath: fixture.dbPath, outputPath }),
        /exact managed|partial_or_malformed|future|version|profile/i,
        label
      );
      assert.equal(fs.existsSync(outputPath), false, `${label} source must not publish output`);
    } finally {
      closeAndRemove(fixture);
    }
  }
});

test('manifest exhaustively classifies v7 base, virtual, shadow, storage, and closed JSON paths', () => {
  const fixture = migratedFixture('manifest', 7);
  const v7Manifest = sanitizer._testing.manifestProfileForVersion(manifest, 7);
  assert.doesNotThrow(() => sanitizer.validateManifest(manifest, fixture.db));
  assert.equal(v7Manifest.objects.length, sanitizer.actualInventory(fixture.db).length);
  assert.equal(v7Manifest.objects.filter((object) => object.type === 'virtual').length, 1);
  assert.equal(v7Manifest.objects.filter((object) => object.type === 'shadow').length, 5);
  assert.ok(v7Manifest.objects.flatMap((object) => object.columns).every((column) => column.classification));
  assert.ok(manifest.categories['secret-null']);
  assert.ok(manifest.categories['preserved-accounting']);

  const unknownColumn = structuredClone(manifest);
  unknownColumn.exactProfiles[1].objects[0].columns[0].name = 'unknown_column';
  assert.throws(() => sanitizer.validateManifest(unknownColumn, fixture.db), /unknown|changed column/i);

  const unknownObject = structuredClone(manifest);
  unknownObject.exactProfiles[1].objects[0].name = 'unknown_table';
  assert.throws(() => sanitizer.validateManifest(unknownObject, fixture.db), /unknown|reordered schema/i);

  const newJsonPath = structuredClone(manifest);
  const nodes = newJsonPath.exactProfiles[1].objects.find((object) => object.name === 'workflow_templates')
    .columns.find((column) => column.name === 'nodes');
  nodes.jsonPolicy.allowedPaths.push('/*/new_sensitive_field');
  assert.throws(() => sanitizer.validateManifest(newJsonPath, fixture.db), /unknown JSON path/i);
  closeAndRemove(fixture);
});

test('manifest rejects object and column classifications that drift from canonical inventory policy', () => {
  const fixture = migratedFixture('manifest-classification-drift', 7);
  try {
    for (const columnName of ['password_hash', 'email']) {
      const candidate = structuredClone(manifest);
      candidate.exactProfiles[1].objects.find((object) => object.name === 'users').columns
        .find((column) => column.name === columnName).classification = 'structural';
      assert.throws(
        () => sanitizer.validateManifest(candidate, fixture.db),
        new RegExp(`canonical inventory classification.*users\\.${columnName}`, 'i'),
        `${columnName} must retain its inventory-derived sensitive classification`
      );
    }

    const objectCandidate = structuredClone(manifest);
    objectCandidate.exactProfiles[1].objects.find((object) => object.name === 'users').classification = 'structural';
    assert.throws(
      () => sanitizer.validateManifest(objectCandidate, fixture.db),
      /canonical inventory classification.*users/i,
      'base-table object classification must remain inventory-derived'
    );
  } finally {
    closeAndRemove(fixture);
  }
});

test('manifest fails closed when semantic equality, reference, rebuild, storage, or frozen FTS policy changes', () => {
  const fixture = migratedFixture('manifest-semantics', 7);
  const mutations = [
    ['equality groups', (candidate) => { delete candidate.exactProfiles[1].equalityGroups; }],
    ['reference groups', (candidate) => { delete candidate.exactProfiles[1].referenceGroups; }],
    ['derived rebuilds', (candidate) => { delete candidate.exactProfiles[1].derivedRebuilds; }],
    ['preserved accounting classification', (candidate) => {
      candidate.exactProfiles[1].objects.find((object) => object.name === 'request_idempotency').columns
        .find((column) => column.name === 'response_bytes').classification = 'derived';
    }],
    ['storage policy', (candidate) => {
      candidate.exactProfiles[1].semanticPolicies ||= { storage: {} };
      candidate.exactProfiles[1].semanticPolicies.storage ||= {};
      candidate.exactProfiles[1].semanticPolicies.storage.preservePerCellStorageClass = false;
    }],
    ['equality member', (candidate) => {
      candidate.exactProfiles[1].equalityGroups ||= [{ members: ['missing'] }];
      candidate.exactProfiles[1].equalityGroups[0].members[0] = 'users.email';
    }],
    ['reference encoding', (candidate) => {
      candidate.exactProfiles[1].referenceGroups ||= [{ encoding: 'missing' }];
      candidate.exactProfiles[1].referenceGroups[0].encoding = 'free-text';
    }],
    ['frozen FTS', (candidate) => { candidate.fts[0].tokenizerOptions = 'porter'; }]
  ];
  for (const [label, mutate] of mutations) {
    const candidate = structuredClone(manifest);
    mutate(candidate);
    assert.throws(
      () => sanitizer.validateManifest(candidate, fixture.db),
      /semantic|equality|reference|rebuild|storage|FTS|manifest/i,
      label
    );
  }
  closeAndRemove(fixture);
});

test('storage framing distinguishes raw BLOB bytes and SQLite numeric storage classes', () => {
  const testing = sanitizer._testing;
  assert.notEqual(
    testing.stableToken('blob', 'probe', 'value', Buffer.from([0x80, 0x00, 0xff])),
    testing.stableToken('blob', 'probe', 'value', Buffer.from([0x81, 0x00, 0xff]))
  );
  assert.notEqual(testing.storageFrame(1, 'integer').toString('hex'), testing.storageFrame(1, 'real').toString('hex'));
  assert.notEqual(testing.storageFrame(-0, 'real').toString('hex'), testing.storageFrame(0, 'real').toString('hex'));
});

test('critical populated fixture preserves record IDs, immutable knowledge equality, workflow topology, BLOB storage, and derived footprints', () => {
  const fixture = migratedFixture('critical-review');
  const populated = populateCriticalReviewFixture(fixture);
  assertCriticalFixtureInvariants(fixture.db, populated);
  fixture.db.close();
  const outputPath = path.join(fixture.root, 'sanitized-critical.db');

  let report;
  assert.doesNotThrow(
    () => { report = sanitizer.sanitizeProductionShape({ sourcePath: fixture.dbPath, outputPath }); },
    'a valid populated campaign/knowledge fixture must sanitize without violating STRICT or immutable triggers'
  );
  assert.equal(report.outputSha256, sha256File(outputPath));
  assert.equal(report.ftsCanaryCount, 2);
  assert.match(report.ftsCanarySha256, /^[0-9a-f]{64}$/);

  const output = new Database(outputPath, { readonly: true });
  try {
    assertCriticalFixtureInvariants(output, populated, { expectRebuiltDerived: true });
  } finally {
    output.close();
    closeAndRemove(fixture);
  }
});

test('v12 sanitizer preserves the audit fingerprint link between AI review audits and idempotency records', () => {
  const fixture = migratedFixture('performance-ai-audit-fingerprint', 12);
  try {
    const populated = populateCriticalReviewFixture(fixture);
    const auditFingerprint = 'a'.repeat(64);
    const request = fixture.db.prepare(`
      INSERT INTO request_idempotency (
        org_id,user_id,campaign_id,resource_claim,scope,idempotency_key,reservation_nonce,
        request_hash,audit_fingerprint,expected_event_count,state,lease_until,lease_token,
        created_at,updated_at,operation_deadline,expires_at
      ) VALUES (
        ?,?,?,NULL,'ai.conversation.create.linked','sanitizer-ai-review-audit',?,
        ?,?,1,'processing',datetime('now','+10 minutes'),?,
        datetime('now','-1 minute'),datetime('now','-1 minute'),datetime('now','+1 hour'),NULL
      )
    `).run(
      populated.orgId,
      populated.userId,
      populated.campaignId,
      'b'.repeat(64),
      'c'.repeat(64),
      auditFingerprint,
      'sanitizer-ai-review-lease-token'
    );
    const tokenUsage = fixture.db.prepare(`
      INSERT INTO token_usage (user_id,model,prompt_tokens,completion_tokens,total_tokens,endpoint)
      VALUES (?,'sanitizer-private-model',11,7,18,'ai_chat_linked_rejected')
    `).run(populated.userId);
    fixture.db.prepare(`
      INSERT INTO performance_ai_review_audits (
        request_idempotency_id,token_usage_id,org_id,campaign_id,actor_user_id,
        audit_fingerprint,outcome,reason_code,stage
      ) VALUES (?,?,?,?,?,?,'withheld','ai_review_protocol_invalid','completion_validation')
    `).run(
      Number(request.lastInsertRowid),
      Number(tokenUsage.lastInsertRowid),
      populated.orgId,
      populated.campaignId,
      populated.userId,
      auditFingerprint
    );
    fixture.db.close();

    const outputPath = path.join(fixture.root, 'sanitized.db');
    sanitizer.sanitizeProductionShape({ sourcePath: fixture.dbPath, outputPath });
    const output = new Database(outputPath, { readonly: true, fileMustExist: true });
    try {
      const fingerprints = output.prepare(`
        SELECT request.audit_fingerprint AS request_fingerprint,
          audit.audit_fingerprint AS audit_fingerprint
        FROM performance_ai_review_audits audit
        JOIN request_idempotency request ON request.id=audit.request_idempotency_id
      `).get();
      assert.ok(fingerprints);
      assert.equal(fingerprints.audit_fingerprint, fingerprints.request_fingerprint);
      assert.notEqual(fingerprints.audit_fingerprint, auditFingerprint);
    } finally {
      output.close();
    }
  } finally {
    closeAndRemove(fixture);
  }
});

test('replacement domains stay globally disjoint across adversarial rows and typed JSON leaves', () => {
  const fixture = migratedFixture('global-replacement-domain');
  const populated = populateCriticalReviewFixture(fixture, {
    knowledgeEntryMetadata: { flag: true, numeric: 731927, label: 'reserved-domain-source' }
  });
  const secondCampaignId = 889101;
  const fixtureTriggers = fixture.db.prepare(
    "SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name IN ('campaigns','knowledge_entries','knowledge_chunks') ORDER BY name"
  ).all();
  for (const trigger of fixtureTriggers) fixture.db.exec(`DROP TRIGGER "${trigger.name.replace(/"/g, '""')}"`);
  fixture.db.prepare(`
    INSERT INTO campaigns (
      id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,lifecycle_state,operational_status,
      row_version,product_name,region,currency,budget_minor
    ) VALUES (?,?,'Currency collision row',?,?,?,?,'lead','active',1,'Private product','US','HFQ',123456)
  `).run(
    secondCampaignId, populated.orgId, populated.customerId, populated.opportunityId,
    populated.userId, populated.teamId
  );
  fixture.db.prepare('UPDATE knowledge_chunks SET metadata_json=? WHERE id=?')
    .run(JSON.stringify({ flag: true, numeric: -731927 }), populated.chunkId);
  for (const trigger of fixtureTriggers) fixture.db.exec(trigger.sql);
  fixture.db.transaction(() => knowledgeService.reconcileKnowledgeCapacityGaugesInTransaction(fixture.db))();
  sqliteDigest.rebuildKnowledgeChunksFts(fixture.db);
  fixture.db.close();

  const outputPath = path.join(fixture.root, 'sanitized.db');
  assert.doesNotThrow(
    () => sanitizer.sanitizeProductionShape({ sourcePath: fixture.dbPath, outputPath }),
    'finite cross-row collisions must be remapped into a reserved source-disjoint domain'
  );
  const output = new Database(outputPath, { readonly: true, fileMustExist: true });
  try {
    const sourceCurrencies = new Set(['USD', 'HFQ']);
    const currencies = output.prepare('SELECT currency FROM campaigns WHERE id IN (?,?) ORDER BY id')
      .all(populated.campaignId, secondCampaignId).map((row) => row.currency);
    assert.equal(currencies.length, 2);
    assert.ok(currencies.every((value) => /^[A-Z]{3}$/.test(value)));
    assert.ok(currencies.every((value) => !sourceCurrencies.has(value)));

    const typedSource = new Set(['integer:731927', 'integer:-731927']);
    const typedOutput = [
      JSON.parse(output.prepare('SELECT metadata_json FROM knowledge_entries WHERE id=?').get(populated.entryId).metadata_json),
      JSON.parse(output.prepare('SELECT metadata_json FROM knowledge_chunks WHERE id=?').get(populated.chunkId).metadata_json)
    ].flatMap((metadata) => Object.values(metadata).map((value) => {
        if (typeof value === 'boolean') return `boolean:${value}`;
        if (typeof value === 'number') return `${Number.isInteger(value) ? 'integer' : 'real'}:${value}`;
        return `text:${value}`;
      }));
    assert.equal(typedOutput.filter((value) => value.startsWith('boolean:')).length, 2);
    assert.equal(
      typedOutput.some((value) => value.startsWith('text:tmjson-b-')),
      false,
      'JSON booleans must never be rewritten as text sentinels'
    );
    assert.ok(typedOutput.every((value) => !typedSource.has(value)), `source/output overlap: ${typedOutput.join(',')}`);
  } finally {
    output.close();
    closeAndRemove(fixture);
  }
});

test('JSON boolean sanitization uses a run-randomized bijection and preserves cross-row partitions', () => {
  const fixture = migratedFixture('boolean-domain-bijection');
  try {
    const populated = populateCriticalReviewFixture(fixture);
    const secondMessageId = populated.messageId + 1000;
    fixture.db.prepare('UPDATE ai_messages SET metadata_json=? WHERE id=?')
      .run(JSON.stringify({ enabled: true, disabled: false }), populated.messageId);
    fixture.db.prepare(`
      INSERT INTO ai_messages (
        id,conversation_id,user_id,role,content,model,
        prompt_tokens,completion_tokens,total_tokens,metadata_json
      ) VALUES (?,? ,?,'assistant','Boolean partition','private-model',17,19,36,?)
    `).run(
      secondMessageId,
      populated.conversationId,
      populated.userId,
      JSON.stringify({ enabled: false, disabled: true })
    );
    const forbidden = sanitizer._testing.collectForbiddenValues(fixture.db, v7Manifest);
    assert.equal(
      forbidden.rawProbes.some((probe) => probe.kind === 'json-leaf' && probe.storageType === 'boolean'),
      false,
      'low-entropy JSON boolean literals must not be treated as identifying raw secrets'
    );
    fixture.db.close();
    const outputPath = path.join(fixture.root, 'sanitized.db');
    assert.doesNotThrow(
      () => sanitizer.sanitizeProductionShape({ sourcePath: fixture.dbPath, outputPath })
    );
    const output = new Database(outputPath, { readonly: true, fileMustExist: true });
    try {
      const storedRows = output.prepare(`
        SELECT id,metadata_json FROM ai_messages WHERE id IN (?,?) ORDER BY id
      `).all(populated.messageId, secondMessageId);
      assert.equal(storedRows.length, 2);
      assert.notEqual(storedRows[0].metadata_json, storedRows[1].metadata_json);
      const booleanPartitions = storedRows.map((row) => Object.values(JSON.parse(row.metadata_json))
        .filter((value) => typeof value === 'boolean').sort());
      assert.ok(booleanPartitions.every((values) => values.length === 2));
      assert.deepEqual(booleanPartitions.flat().sort(), [false, false, true, true]);
    } finally {
      output.close();
    }
  } finally {
    closeAndRemove(fixture);
  }
});

test('template checksum is rebuilt while response_bytes remains preserved non-replay accounting', () => {
  const fixture = migratedFixture('explicit-derived-evidence');
  const populated = populateCriticalReviewFixture(fixture);
  const binary = insertBinaryIdempotencyFixture(fixture.db, populated);
  const responseBytesColumn = v7Manifest.objects
    .find((object) => object.name === 'request_idempotency').columns
    .find((column) => column.name === 'response_bytes');
  assert.equal(responseBytesColumn.classification, 'preserved-accounting');
  assert.deepEqual(v7Manifest.semanticPolicies.preservedAccounting, ['request_idempotency.response_bytes']);
  assert.equal(v7Manifest.derivedRebuilds.includes('request_idempotency.response_bytes'), false);
  assert.equal(sanitizer._testing.captureRequestIdempotencyResponseEvidence, undefined);
  assert.equal(sanitizer._testing.rebuildRequestIdempotencyResponseEvidence, undefined);

  const dispatchTriggers = fixture.db.prepare(`
    SELECT name,sql FROM sqlite_schema
    WHERE type='trigger' AND tbl_name='campaign_workflow_dispatches' ORDER BY name
  `).all();
  for (const trigger of dispatchTriggers) fixture.db.exec(`DROP TRIGGER "${trigger.name.replace(/"/g, '""')}"`);
  fixture.db.prepare("UPDATE campaign_workflow_dispatches SET template_checksum=? WHERE id=?")
    .run('0'.repeat(64), populated.dispatchId);
  for (const trigger of dispatchTriggers) fixture.db.exec(trigger.sql);
  fixture.db.close();

  const outputPath = path.join(fixture.root, 'sanitized-derived.db');
  sanitizer.sanitizeProductionShape({ sourcePath: fixture.dbPath, outputPath });
  const output = new Database(outputPath, { readonly: true });
  try {
    const dispatch = output.prepare(`
      SELECT template_snapshot_json,template_checksum
      FROM campaign_workflow_dispatches WHERE id=?
    `).get(populated.dispatchId);
    const snapshot = JSON.parse(dispatch.template_snapshot_json);
    assert.equal(dispatch.template_snapshot_json, sqliteDigest.canonicalJsonBytes(snapshot).toString('utf8'));
    assert.equal(dispatch.template_checksum, checksumCampaignWorkflowSnapshot(snapshot));

    const response = output.prepare(`
      SELECT response_kind,response_json,response_headers_json,response_bytes,
        length(CAST(response_headers_json AS BLOB)) AS sqlite_header_bytes
      FROM request_idempotency WHERE id=?
    `).get(binary.id);
    assert.equal(response.response_kind, 'binary');
    assert.equal(response.response_json, null);
    assert.equal(
      response.response_bytes,
      binary.responseBytes,
      'external binary body is absent; response_bytes is preserved accounting, not replay coherence'
    );
    assert.equal(
      response.response_headers_json,
      sqliteDigest.canonicalJsonBytes(JSON.parse(response.response_headers_json)).toString('utf8')
    );
    assert.equal(response.sqlite_header_bytes, Buffer.byteLength(response.response_headers_json, 'utf8'));
  } finally {
    output.close();
    closeAndRemove(fixture);
  }
});

test('sanitizer uses readonly VACUUM INTO, omits triggers during writes, restores exact protections, and publishes only a final compact file', () => {
  const fixture = migratedFixture('shape');
  const probes = populateSensitiveFixture(fixture, { protectionTrigger: false });
  const triggerSql = fixture.db.prepare(
    "SELECT sql FROM sqlite_schema WHERE name='activity_log_append_only_update'"
  ).get().sql;
  const sourceTypes = fixture.db.prepare(`
    SELECT typeof(amazon_rating) AS real_type,typeof(youtube_followers) AS integer_type
    FROM brands ORDER BY id DESC LIMIT 1
  `).get();
  fixture.db.close();
  const beforeHash = sha256File(fixture.dbPath);
  const beforeStat = fs.statSync(fixture.dbPath);
  const outputPath = path.join(fixture.root, 'sanitized.db');
  const report = sanitizer.sanitizeProductionShape({ sourcePath: fixture.dbPath, outputPath });

  assert.equal(sha256File(fixture.dbPath), beforeHash, 'readonly source bytes must not change');
  assert.equal(fs.statSync(fixture.dbPath).mtimeMs, beforeStat.mtimeMs, 'readonly source mtime must not change');
  assert.equal(report.format, 'tm-sanitization-report-v1');
  assert.equal(report.outputSha256, sha256File(outputPath));
  assert.equal(report.ftsCanaryCount, 2);
  assert.match(report.ftsCanarySha256, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(report).includes(probes.displayProbe), false);
  assert.equal(JSON.stringify(report).includes(probes.emailProbe), false);
  const outputBytes = fs.readFileSync(outputPath);
  assert.equal(outputBytes.includes(Buffer.from(probes.displayProbe, 'utf8')), false);
  assert.equal(outputBytes.includes(Buffer.from(probes.emailProbe, 'utf8')), false);
  for (const suffix of ['-journal', '-wal', '-shm']) assert.equal(fs.existsSync(`${outputPath}${suffix}`), false);
  assert.deepEqual(
    fs.readdirSync(fixture.root).filter((name) => /root-prescrub|sanitized-stage|\.publish-/.test(name)),
    []
  );
  assert.equal(fs.existsSync(`${outputPath}.run.json`), false, 'successful local sanitization must unlink its journal');

  const output = new Database(outputPath);
  assert.equal(
    output.prepare("SELECT sql FROM sqlite_schema WHERE name='activity_log_append_only_update'").get().sql,
    triggerSql
  );
  assert.throws(
    () => output.prepare('UPDATE activity_log SET details=details WHERE id=(SELECT MIN(id) FROM activity_log)').run(),
    /activity_log is append-only/
  );
  const outputTypes = output.prepare(`
    SELECT typeof(amazon_rating) AS real_type,typeof(youtube_followers) AS integer_type
    FROM brands ORDER BY id DESC LIMIT 1
  `).get();
  assert.deepEqual(outputTypes, sourceTypes);
  assert.equal(output.pragma('quick_check', { simple: true }), 'ok');
  assert.equal(output.pragma('freelist_count', { simple: true }), 0);
  assert.equal(
    fs.statSync(outputPath).size,
    output.pragma('page_size', { simple: true }) * output.pragma('page_count', { simple: true })
  );
  assert.deepEqual(output.pragma('foreign_key_check'), []);
  sqliteDigest.verifyKnowledgeChunksFtsIntegrity(output, sanitizer.FTS_MANIFEST, { checkMainIntegrity: true });
  output.close();
  closeAndRemove(fixture);
});

test('local sanitizer removes unpublished staging, final output, and journal on caught failure', () => {
  const fixture = migratedFixture('local-failure-cleanup');
  fixture.db.close();
  const outputPath = path.join(fixture.root, 'must-not-publish.db');
  assert.throws(
    () => sanitizer.sanitizeProductionShape({
      sourcePath: fixture.dbPath,
      outputPath,
      failAfterPhase: 'compact-scan-complete'
    }),
    /injected sanitizer failure/i
  );
  assert.equal(fs.existsSync(outputPath), false);
  assert.equal(fs.existsSync(`${outputPath}.run.json`), false);
  assert.deepEqual(
    fs.readdirSync(fixture.root).filter((name) => /root-prescrub|sanitized-stage|\.publish-/.test(name)),
    []
  );
  closeAndRemove(fixture);
});

test('local sanitizer rechecks the source before rename and removes all artifacts on a source race', () => {
  const fixture = migratedFixture('local-source-race');
  fixture.db.close();
  const outputPath = path.join(fixture.root, 'must-not-publish.db');
  const journalPath = `${outputPath}.run.json`;
  const originalRenameSync = fs.renameSync;
  let sourceMutated = false;
  fs.renameSync = function interceptedRename(source, target) {
    if (!sourceMutated && path.resolve(target) === path.resolve(journalPath) && fs.existsSync(source)) {
      const payload = JSON.parse(fs.readFileSync(source, 'utf8'));
      if (payload.state === 'compact-scan-complete') {
        fs.appendFileSync(fixture.dbPath, Buffer.from('source-race', 'ascii'));
        sourceMutated = true;
      }
    }
    return originalRenameSync.apply(this, arguments);
  };
  try {
    assert.throws(
      () => sanitizer.sanitizeProductionShape({ sourcePath: fixture.dbPath, outputPath }),
      /source database changed/i
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }
  assert.equal(sourceMutated, true, 'fixture must change the source after the final scan checkpoint');
  assert.equal(fs.existsSync(outputPath), false, 'a failed source recheck must not leave a published output');
  assert.equal(fs.existsSync(journalPath), false, 'caught source races must not leave a stale journal');
  assert.deepEqual(
    fs.readdirSync(fixture.root).filter((name) => /root-prescrub|sanitized-stage|\.publish-/.test(name)),
    []
  );
  closeAndRemove(fixture);
});

test('local sanitizer preserves concurrently created output and staging paths it never owned', async (t) => {
  for (const kind of ['output', 'staging']) {
    await t.test(kind, () => {
      const fixture = migratedFixture(`local-concurrent-${kind}`);
      fixture.db.close();
      const outputPath = path.join(fixture.root, 'concurrent.db');
      const targetPath = kind === 'output'
        ? outputPath
        : `${outputPath}.root-prescrub-${process.pid}`;
      const marker = `concurrent-${kind}-owner`;
      const journalPath = `${outputPath}.run.json`;
      const originalRenameSync = fs.renameSync;
      const originalLinkSync = fs.linkSync;
      let concurrentCreated = false;
      const intercept = (original) => function interceptedJournalPublish(source, target) {
        const result = original.apply(this, arguments);
        if (!concurrentCreated && path.resolve(String(target)) === path.resolve(journalPath)) {
          concurrentCreated = true;
          fs.writeFileSync(targetPath, marker);
        }
        return result;
      };
      fs.renameSync = intercept(originalRenameSync);
      fs.linkSync = intercept(originalLinkSync);
      try {
        assert.throws(
          () => sanitizer.sanitizeProductionShape({ sourcePath: fixture.dbPath, outputPath }),
          /exist|output|staging|database/i
        );
      } finally {
        fs.renameSync = originalRenameSync;
        fs.linkSync = originalLinkSync;
      }
      assert.equal(concurrentCreated, true, 'fixture must create the concurrent path after initial path validation');
      assert.equal(fs.readFileSync(targetPath, 'utf8'), marker, 'failure cleanup must preserve a non-owned path');
      fs.unlinkSync(targetPath);
      closeAndRemove(fixture);
    });
  }
});

test('local no-replace publication preserves a concurrent final and fails closed on final inode replacement', async (t) => {
  await t.test('concurrent final before publication', () => {
    const fixture = migratedFixture('local-publication-race');
    fixture.db.close();
    const outputPath = path.join(fixture.root, 'concurrent-final.db');
    const marker = 'concurrent-final-owner';
    const originalRenameSync = fs.renameSync;
    const originalLinkSync = fs.linkSync;
    let publicationAttempted = false;
    const intercept = (original) => function interceptedPublication(source, target) {
      if (!publicationAttempted && path.resolve(String(target)) === path.resolve(outputPath)) {
        publicationAttempted = true;
        fs.writeFileSync(outputPath, marker);
      }
      return original.apply(this, arguments);
    };
    fs.renameSync = intercept(originalRenameSync);
    fs.linkSync = intercept(originalLinkSync);
    try {
      assert.throws(
        () => sanitizer.sanitizeProductionShape({ sourcePath: fixture.dbPath, outputPath }),
        /exist|publish|concurrent/i
      );
    } finally {
      fs.renameSync = originalRenameSync;
      fs.linkSync = originalLinkSync;
    }
    assert.equal(publicationAttempted, true);
    assert.equal(fs.readFileSync(outputPath, 'utf8'), marker, 'no-replace publication must preserve the concurrent final');
    fs.unlinkSync(outputPath);
    closeAndRemove(fixture);
  });

  await t.test('final inode replacement during failure cleanup', () => {
    const fixture = migratedFixture('local-final-replacement');
    fixture.db.close();
    const outputPath = path.join(fixture.root, 'replaced-final.db');
    const marker = 'replacement-owner-inode';
    const originalRenameSync = fs.renameSync;
    const originalLinkSync = fs.linkSync;
    let replacementInjected = false;
    const intercept = (original) => function interceptedPublication(source, target) {
      const result = original.apply(this, arguments);
      if (!replacementInjected && path.resolve(String(target)) === path.resolve(outputPath)) {
        replacementInjected = true;
        fs.unlinkSync(outputPath);
        fs.writeFileSync(outputPath, marker);
        throw new Error('injected final inode replacement');
      }
      return result;
    };
    fs.renameSync = intercept(originalRenameSync);
    fs.linkSync = intercept(originalLinkSync);
    let observed;
    try {
      assert.throws(
        () => sanitizer.sanitizeProductionShape({ sourcePath: fixture.dbPath, outputPath }),
        (error) => {
          observed = error;
          return /inode|identity|replacement|cleanup/i.test(error.message);
        }
      );
    } finally {
      fs.renameSync = originalRenameSync;
      fs.linkSync = originalLinkSync;
    }
    assert.equal(replacementInjected, true);
    assert.equal(observed?.cleanupUnsafe, true, 'an ownership mismatch must retain recovery evidence');
    assert.equal(fs.readFileSync(outputPath, 'utf8'), marker, 'cleanup must not unlink the replacement inode');
    assert.equal(fs.existsSync(`${outputPath}.run.json`), true, 'ownership uncertainty must retain the journal');
    fs.unlinkSync(outputPath);
    fs.unlinkSync(`${outputPath}.run.json`);
    closeAndRemove(fixture);
  });
});

test('local publication treats a dangling output replacement as present and retains recovery evidence', (t) => {
  const fixture = migratedFixture('local-dangling-output-replacement');
  fixture.db.close();
  const outputPath = path.join(fixture.root, 'dangling-output.db');
  const journalPath = `${outputPath}.run.json`;
  const probePath = path.join(fixture.root, 'dangling-capability-probe');
  if (!createDanglingFileSymlinkOrSkip(t, probePath)) {
    closeAndRemove(fixture);
    return;
  }
  fs.unlinkSync(probePath);

  const originalLinkSync = fs.linkSync;
  let replacementInjected = false;
  let observed;
  fs.linkSync = function replacePublishedOutputWithDanglingLink(source, target) {
    const result = originalLinkSync.apply(this, arguments);
    if (!replacementInjected && path.resolve(String(target)) === path.resolve(outputPath)) {
      replacementInjected = true;
      fs.unlinkSync(outputPath);
      fs.symlinkSync(`${outputPath}.missing-target`, outputPath, process.platform === 'win32' ? 'junction' : 'file');
    }
    return result;
  };
  try {
    assert.throws(
      () => sanitizer.sanitizeProductionShape({ sourcePath: fixture.dbPath, outputPath }),
      (error) => {
        observed = error;
        return /identity|symlink|regular|cleanup/i.test(error.message);
      }
    );
  } finally {
    fs.linkSync = originalLinkSync;
  }

  assert.equal(replacementInjected, true, 'fixture must replace the linked output before publication validation');
  assert.equal(observed?.cleanupUnsafe, true, 'dangling output replacement must make cleanup identity uncertain');
  assert.equal(fs.lstatSync(outputPath).isSymbolicLink(), true, 'cleanup must not unlink the dangling replacement');
  assert.equal(fs.lstatSync(journalPath).isFile(), true, 'identity uncertainty must retain the journal');
  const payload = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  assert.equal(fs.lstatSync(payload.paths.publish.path).isFile(), true, 'journal-bound publication evidence must remain');
  closeAndRemove(fixture);
});

test('local sanitizer rejects dangling staging and journal names as present', async (t) => {
  await t.test('staging name', (subtest) => {
    const fixture = migratedFixture('dangling-stage-preexistence');
    fixture.db.close();
    const outputPath = path.join(fixture.root, 'output.db');
    const stagingPath = `${outputPath}.root-prescrub-${process.pid}`;
    if (!createDanglingFileSymlinkOrSkip(subtest, stagingPath)) {
      closeAndRemove(fixture);
      return;
    }
    assert.throws(
      () => sanitizer.sanitizeProductionShape({ sourcePath: fixture.dbPath, outputPath }),
      /sanitizer staging path already exists/i
    );
    assert.equal(fs.lstatSync(stagingPath).isSymbolicLink(), true);
    assert.equal(fs.existsSync(`${outputPath}.run.json`), false);
    fs.unlinkSync(stagingPath);
    closeAndRemove(fixture);
  });

  await t.test('journal name', (subtest) => {
    const fixture = migratedFixture('dangling-journal-preexistence');
    fixture.db.close();
    const outputPath = path.join(fixture.root, 'output.db');
    const journalPath = `${outputPath}.run.json`;
    if (!createDanglingFileSymlinkOrSkip(subtest, journalPath)) {
      closeAndRemove(fixture);
      return;
    }
    assert.throws(
      () => sanitizer.sanitizeProductionShape({ sourcePath: fixture.dbPath, outputPath }),
      /sanitizer run journal already exists/i
    );
    assert.equal(fs.lstatSync(journalPath).isSymbolicLink(), true);
    fs.unlinkSync(journalPath);
    closeAndRemove(fixture);
  });
});

test('security-critical sanitizer and cleanup path checks use no-follow presence probes', () => {
  const sanitizerSource = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'sanitize_production_shape.js'), 'utf8');
  const cleanupSource = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'cleanup_stale_migration_gate.sh'), 'utf8');
  assert.doesNotMatch(sanitizerSource, /\bexistsSync\s*\(/, 'sanitizer must not follow targets to decide whether a path is absent');
  assert.doesNotMatch(cleanupSource, /\bexistsSync\s*\(/, 'cleanup embedded validators must not follow targets to decide absence');
  assert.match(sanitizerSource, /function lstatNoFollowIfPresent\s*\(/);
  assert.match(cleanupSource, /lstatNoFollowIfPresent/);
});

test('secret-null fails closed for non-null data and malformed or partial outputs are rejected', () => {
  const fixture = migratedFixture('secret-null', 7);
  fixture.db.close();
  const changed = structuredClone(manifest);
  const password = changed.exactProfiles[1].objects.find((object) => object.name === 'users').columns
    .find((column) => column.name === 'password_hash');
  password.classification = 'secret-null';
  assert.throws(
    () => sanitizer._testing.transformedValue(
      'secret-null', 'users', 'password_hash', 'non-null-secret', 'text',
      new Map(), v7Manifest.jsonPolicy, undefined, null
    ),
    /secret-null column contains data/i
  );
  assert.throws(
    () => sanitizer.sanitizeProductionShape({
      sourcePath: fixture.dbPath,
      outputPath: path.join(fixture.root, 'must-not-publish.db'),
      manifest: changed
    }),
    /canonical inventory classification mismatch/i
  );
  const existing = path.join(fixture.root, 'existing.db');
  fs.writeFileSync(existing, 'partial');
  assert.throws(
    () => sanitizer.sanitizeProductionShape({ sourcePath: fixture.dbPath, outputPath: existing }),
    /already exists/i
  );
  closeAndRemove(fixture);
});

test('campaign migration gate sanitizes populated managed v1 and verifies two exact restores through v12', () => {
  const fixture = migratedFixture('twice', 1);
  const populated = populateManagedV1GateFixture(fixture);
  const sourceClassification = migrationService.classifyDatabase(fixture.db, {
    rootDir: path.resolve(__dirname, '..'),
    migrations: migrationService.defaultMigrations()
  });
  assert.deepEqual(sourceClassification, { status: 'managed', currentVersion: 1 });
  assert.equal(fixture.db.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(fixture.db.pragma('foreign_key_check'), []);
  sqliteDigest.verifyKnowledgeChunksFtsIntegrity(fixture.db, sanitizer.FTS_MANIFEST, { checkMainIntegrity: true });
  fixture.db.close();
  const sourceSha256 = sha256File(fixture.dbPath);
  const report = migrationGate.verifyCampaignMigrationGate({ sourcePath: fixture.dbPath });
  assert.equal(report.format, 'tm-campaign-migration-gate-v1');
  assert.equal(report.runs, 2);
  assert.equal(report.sourceVersion, 1);
  assert.equal(report.targetVersion, 12);
  assert.equal(report.preMigrationRestoreVerified, true);
  assert.equal(report.legacyPreservationVerified, true);
  const sanitizedPath = path.join(fixture.root, 'stage-preservation-sanitized.db');
  sanitizer.sanitizeProductionShape({ sourcePath: fixture.dbPath, outputPath: sanitizedPath });
  const sanitized = new Database(sanitizedPath, { readonly: true, fileMustExist: true });
  try {
    assert.deepEqual(
      sanitized.prepare(`
        SELECT id,stage FROM customers
        WHERE id IN (?,?) ORDER BY id
      `).all(populated.negotiationCustomerId, populated.maintenanceCustomerId),
      [
        { id: populated.negotiationCustomerId, stage: 'negotiation' },
        { id: populated.maintenanceCustomerId, stage: 'maintenance' }
      ]
    );
    assert.deepEqual(
      sanitized.prepare(`
        SELECT stage_from,stage_to FROM customer_activity
        WHERE customer_id=? ORDER BY id DESC LIMIT 1
      `).get(populated.negotiationCustomerId),
      { stage_from: 'negotiation', stage_to: 'maintenance' }
    );
  } finally {
    sanitized.close();
  }
  assert.ok(report.legacyTableCount > 20);
  assert.ok(report.legacyRowCount > 0);
  assert.match(report.preMigration.topologySha256, /^[0-9a-f]{64}$/);
  assert.match(report.preMigration.logicalSha256, /^[0-9a-f]{64}$/);
  assert.match(report.outputSha256, /^[0-9a-f]{64}$/);
  assert.equal(report.ftsCanaryCount, 2);
  assert.match(report.ftsCanarySha256, /^[0-9a-f]{64}$/);
  assert.match(report.topologySha256, /^[0-9a-f]{64}$/);
  assert.match(report.logicalSha256, /^[0-9a-f]{64}$/);
  assert.equal(report.fts.length, 1);
  assert.match(report.fts[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(sha256File(fixture.dbPath), sourceSha256, 'the managed v1 source must remain byte-exact');
  const source = new Database(fixture.dbPath, { fileMustExist: true });
  try {
    assert.equal(source.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(source.pragma('foreign_key_check'), []);
    sqliteDigest.verifyKnowledgeChunksFtsIntegrity(source, sanitizer.FTS_MANIFEST, { checkMainIntegrity: true });
    assert.deepEqual(sqliteDigest.matchKnowledgeChunksCanary(source, populated.ftsProbe), [populated.chunkId]);
  } finally {
    source.close();
  }
  assert.equal(sha256File(fixture.dbPath), sourceSha256, 'post-gate integrity checks must not change managed v1 bytes');
  closeAndRemove(fixture);
});

test('campaign migration gate rejects an exact sanitized v6 no-op source at the verifier boundary', () => {
  const fixture = migratedFixture('reject-v6-noop', 6);
  populateSensitiveFixture(fixture, { protectionTrigger: false });
  fixture.db.close();
  const sourceSha256 = sha256File(fixture.dbPath);
  assert.throws(
    () => migrationGate.verifyCampaignMigrationGate({ sourcePath: fixture.dbPath }),
    /sanitized source version must be exactly 1; got 6/i
  );
  assert.equal(sha256File(fixture.dbPath), sourceSha256);
  closeAndRemove(fixture);
});

test('migration verifier rejects stale FTS postings and output sidecars', () => {
  const fixture = migratedFixture('fts-reject');
  fixture.db.close();
  const outputPath = path.join(fixture.root, 'sanitized.db');
  sanitizer.sanitizeProductionShape({ sourcePath: fixture.dbPath, outputPath });
  const output = new Database(outputPath);
  const triggers = output.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name").all();
  for (const trigger of triggers) output.exec(`DROP TRIGGER "${trigger.name.replace(/"/g, '""')}"`);
  output.prepare("INSERT INTO knowledge_entries (entry_type,source_type,key_terms,content,is_public,title,tags_json,visibility) VALUES ('note','manual','[]','tmtext-canary',0,'tmtext-title','[]','private')").run();
  const entryId = output.prepare('SELECT MAX(id) AS id FROM knowledge_entries').get().id;
  output.prepare("INSERT INTO knowledge_chunks (entry_id,chunk_index,content,token_count) VALUES (?,0,'tmtext-canary',1)").run(entryId);
  for (const trigger of triggers) output.exec(trigger.sql);
  sqliteDigest.rebuildKnowledgeChunksFts(output);
  output.prepare("UPDATE knowledge_chunks_fts SET content='stale-posting' WHERE chunk_id=(SELECT MAX(id) FROM knowledge_chunks)").run();
  output.close();
  assert.throws(() => migrationGate.migrateTwice(outputPath), /FTS|projection|canary/i);
  fs.writeFileSync(`${fixture.dbPath}-wal`, 'sidecar');
  assert.throws(
    () => sanitizer.sanitizeProductionShape({ sourcePath: fixture.dbPath, outputPath: path.join(fixture.root, 'sidecar.db') }),
    /sidecar/i
  );
  closeAndRemove(fixture);
});

test('stale gate cleanup is ASCII, bash-clean, journal-bounded, idempotent, and startup ordered', { skip: !HAS_BASH }, () => {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'cleanup_stale_migration_gate.sh');
  const unitPath = path.join(__dirname, '..', 'systemd', 'turingmarket-gate-cleanup.service');
  const source = fs.readFileSync(scriptPath);
  const sourceText = source.toString('ascii');
  assert.equal(source.some((byte) => byte > 0x7f), false);
  assert.equal(spawnSync(BASH, ['-n', scriptPath], { encoding: 'utf8' }).status, 0);
  assert.match(sourceText, /process_group_matches/);
  assert.match(sourceText, /kill -TERM -- "-\$pgid"/);
  assert.match(sourceText, /kill -KILL -- "-\$pgid"/);
  assert.match(sourceText, /KILL_WAIT_STEPS/);
  assert.match(sourceText, /process group remained alive after the KILL observation deadline/);
  assert.match(sourceText, /worker launch identity is uncertain; retaining journal/);
  assert.match(sourceText, /process_group_matches.*TERM|TERM.*process_group_matches/s);
  assert.match(sourceText, /process_group_matches.*KILL|KILL.*process_group_matches/s);
  const groupCleanupSource = sourceText.slice(
    sourceText.indexOf('terminate_recorded_process_group()'),
    sourceText.indexOf('assert_cleanup_path()')
  );
  assert.ok((groupCleanupSource.match(/process_group_matches/g) || []).length >= 5);
  assert.doesNotMatch(groupCleanupSource, /process_group_alive "\$pgid"/);
  assert.match(sourceText, /JOURNAL_TMP_RECOVERY_LIMIT/);
  assert.match(sourceText, /recover_journal_temp/);
  assert.match(sourceText, /\.run\.json\.tmp-/);
  const unit = fs.readFileSync(unitPath, 'utf8');
  assert.match(unit, /Before=turingmarket-gate\.service/);
  assert.match(unit, /ProtectHome=yes/);
  assert.doesNotMatch(unit, /\/root\/turingmarket/);
  assert.match(unit, /ExecStart=.*\/usr\/local\/libexec\/turingmarket\/cleanup_stale_migration_gate\.sh --all/);
  assert.match(unit, /ReadWritePaths=-\/run\/turingmarket-gate -\/var\/lib\/turingmarket\/migration-gate -\/var\/lib\/turingmarket\/gate -\/mnt\/turingmarket-gate/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-cleanup-'));
  fs.chmodSync(root, 0o700);
  const stale = path.join(root, 'stale-stage');
  fs.mkdirSync(stale, { mode: 0o700 });
  fs.writeFileSync(path.join(stale, 'artifact'), 'synthetic');
  const staleIdentity = fs.statSync(stale, { bigint: true });
  const journal = path.join(root, 'stale.run.json');
  fs.writeFileSync(journal, `${JSON.stringify({
    format: 'tm-sanitizer-run-journal-v1', runId: 'a'.repeat(32), pid: 99999999,
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    state: 'prescrub-staged', unit: { name: null, active: false },
    mount: { path: null, source: null, mounted: false }, ephemeralUser: { name: null },
    paths: {
      source: { path: path.join(root, 'source.db'), cleanup: false },
      output: { path: path.join(root, 'output.db'), cleanup: false },
      working: {
        path: stale,
        cleanup: true,
        identity: { device: staleIdentity.dev.toString(), inode: staleIdentity.ino.toString() }
      }
    }
  })}\n`, { mode: 0o600 });
  fs.chmodSync(journal, 0o600);
  const env = { ...process.env, TM_GATE_TEST_MODE: '1', TM_GATE_JOURNAL_ROOT: root, TM_GATE_ALLOWED_ROOTS: root };
  const first = spawnSync(BASH, [scriptPath, '--all'], { env, encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(journal), false);
  assert.equal(spawnSync(BASH, [scriptPath, '--all'], { env, encoding: 'utf8' }).status, 0);

  const recoveredRunId = 'c'.repeat(32);
  const recoveredStage = path.join(root, 'recovered-temp-stage');
  fs.mkdirSync(recoveredStage, { mode: 0o700 });
  fs.writeFileSync(path.join(recoveredStage, 'artifact'), 'synthetic');
  const recoveredStageIdentity = fs.statSync(recoveredStage, { bigint: true });
  const recoveredTemp = path.join(root, `${recoveredRunId}.run.json.tmp-99999999-deadbeefdeadbeef`);
  fs.writeFileSync(recoveredTemp, `${JSON.stringify({
    format: 'tm-sanitizer-run-journal-v3',
    runId: recoveredRunId,
    state: 'prescrub-staged',
    coordinator: {
      pid: 99999999,
      uid: typeof process.getuid === 'function' ? process.getuid() : 0,
      startTimeTicks: '1',
      exe: process.execPath,
      pgid: 99999999
    },
    worker: null,
    processGroup: null,
    unit: { name: null, active: false },
    mount: { path: null, source: null, mounted: false },
    ephemeralUser: { name: null, uid: null, gid: null },
    paths: {
      source: { path: path.join(root, 'source.db'), cleanup: false },
      output: { path: path.join(root, 'output.db'), cleanup: false },
      working: {
        path: recoveredStage,
        cleanup: true,
        identity: {
          device: recoveredStageIdentity.dev.toString(),
          inode: recoveredStageIdentity.ino.toString()
        }
      }
    }
  })}\n`, { mode: 0o600 });
  fs.chmodSync(recoveredTemp, 0o600);
  const staleTime = new Date(Date.now() - 5_000);
  fs.utimesSync(recoveredTemp, staleTime, staleTime);
  const recovered = spawnSync(BASH, [scriptPath, '--all'], {
    env: { ...env, TM_GATE_JOURNAL_TMP_STALE_SECONDS: '1' },
    encoding: 'utf8'
  });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(fs.existsSync(recoveredTemp), false);
  assert.equal(fs.existsSync(path.join(root, `${recoveredRunId}.run.json`)), false);
  assert.equal(fs.existsSync(recoveredStage), false);

  const identityRunId = 'd'.repeat(32);
  const identityStage = path.join(root, 'identity-bound-stage');
  fs.writeFileSync(identityStage, 'owned-before-replacement', { mode: 0o600 });
  const originalStageStat = fs.statSync(identityStage, { bigint: true });
  const identityJournal = path.join(root, `${identityRunId}.run.json`);
  fs.writeFileSync(identityJournal, `${JSON.stringify({
    format: 'tm-sanitizer-run-journal-v4',
    runId: identityRunId,
    state: 'prescrub-staged',
    coordinator: {
      pid: 99999999,
      uid: typeof process.getuid === 'function' ? process.getuid() : 0,
      startTimeTicks: '1',
      exe: process.execPath,
      pgid: 99999999
    },
    worker: null,
    processGroup: null,
    unit: { name: null, active: false },
    mount: { path: null, source: null, mounted: false },
    ephemeralUser: { name: null, uid: null, gid: null },
    paths: {
      source: { path: path.join(root, 'source.db'), cleanup: false },
      output: { path: path.join(root, 'output.db'), cleanup: false },
      publicationStage: {
        path: identityStage,
        cleanup: true,
        identity: { device: originalStageStat.dev.toString(), inode: originalStageStat.ino.toString() }
      }
    }
  })}\n`, { mode: 0o600 });
  fs.chmodSync(identityJournal, 0o600);
  const identityReplacement = path.join(root, 'identity-bound-replacement');
  fs.writeFileSync(identityReplacement, 'concurrent-replacement', { mode: 0o600 });
  fs.unlinkSync(identityStage);
  fs.renameSync(identityReplacement, identityStage);
  const identityMismatch = spawnSync(BASH, [scriptPath, '--journal', identityJournal], { env, encoding: 'utf8' });
  assert.notEqual(identityMismatch.status, 0, 'cleanup must fail closed when a bound cleanup inode is replaced');
  assert.equal(fs.readFileSync(identityStage, 'utf8'), 'concurrent-replacement');
  assert.equal(fs.existsSync(identityJournal), true, 'identity uncertainty must retain the journal');

  if (process.platform !== 'win32') {
    const reusedStage = path.join(root, 'reused-pid-stage');
    fs.mkdirSync(reusedStage, { mode: 0o700 });
    const reusedJournal = path.join(root, 'reused.run.json');
    fs.writeFileSync(reusedJournal, `${JSON.stringify({
      format: 'tm-sanitizer-run-journal-v1', runId: 'b'.repeat(32), pid: process.pid,
      uid: typeof process.getuid === 'function' ? process.getuid() : null,
      state: 'logical-sanitization-complete', unit: { name: null, active: false },
      mount: { path: null, source: null, mounted: false }, ephemeralUser: { name: null },
      paths: {
        source: { path: path.join(root, 'source.db'), cleanup: false },
        output: { path: path.join(root, 'output.db'), cleanup: false },
        working: { path: reusedStage, cleanup: true }
      }
    })}\n`, { mode: 0o600 });
    fs.chmodSync(reusedJournal, 0o600);
    const reused = spawnSync(BASH, [scriptPath, '--all'], { env, encoding: 'utf8' });
    assert.notEqual(reused.status, 0, 'legacy live PID identity is incomplete and must fail closed');
    assert.equal(fs.existsSync(reusedStage), true);
    assert.equal(fs.existsSync(reusedJournal), true);
    assert.doesNotThrow(() => process.kill(process.pid, 0), 'PID reuse must never signal the unrelated process');
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('bootstrap validates real sanitizer journals, resources, identities, processes, and mounts before lifecycle mutation', { skip: !HAS_BASH }, () => {
  const bootstrapPath = path.join(__dirname, '..', 'scripts', 'bootstrap_production_runtime.sh');
  const source = fs.readFileSync(bootstrapPath, 'utf8');
  assert.match(source, /SANITIZER_JOURNAL_ROOT=.*\/var\/lib\/turingmarket\/migration-gate/);
  assert.match(source, /SANITIZER_RUN_ROOT=.*\/run\/turingmarket-gate/);
  assert.match(source, /validate_sanitizer_gate_idle_state\(\)/);
  assert.match(source, /tm-gate-\[0-9a-f\]/);

  const mainStart = source.indexOf('bootstrap_production_main() {');
  const mainEnd = source.indexOf('\n}\n\nif [ "${TM_BOOTSTRAP_LIBRARY_ONLY', mainStart);
  assert.ok(mainStart >= 0 && mainEnd > mainStart, 'production main must be function-bounded');
  const main = source.slice(mainStart, mainEnd);
  assert.ok(
    main.indexOf('validate_sanitizer_gate_idle_state') < main.indexOf('bootstrap_recover_stale_control_state'),
    'real sanitizer state must be checked before bootstrap recovery'
  );
  for (const functionName of ['stop_current_release()', 'restart_current_release()', 'recover_interrupted_migration()']) {
    const start = source.indexOf(functionName);
    const end = source.indexOf('\n}', start);
    assert.match(source.slice(start, end), /validate_sanitizer_gate_idle_state/);
  }
  assert.match(source, /validate_sanitizer_gate_idle_state[\s\S]*set_migration_phase installing/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-bootstrap-sanitizer-state-'));
  const journalRoot = path.join(root, 'migration-gate');
  const runRoot = path.join(root, 'run-gate');
  fs.mkdirSync(journalRoot, { mode: 0o700 });
  fs.mkdirSync(runRoot, { mode: 0o711 });
  const bashPath = gitBashPath;
  const baseCommand = [
    'set -euo pipefail',
    'PATH=/usr/bin:/bin:$PATH',
    'export PATH',
    'export TM_BOOTSTRAP_LIBRARY_ONLY=1',
    `export TM_SANITIZER_JOURNAL_ROOT=${shellQuote(bashPath(journalRoot))}`,
    `export TM_SANITIZER_RUN_ROOT=${shellQuote(bashPath(runRoot))}`,
    `source ${shellQuote(bashPath(bootstrapPath))}`,
    'validate_sanitizer_gate_idle_state'
  ].join('; ');
  try {
    const clean = spawnSync(BASH, ['--noprofile', '--norc', '-c', baseCommand], { encoding: 'utf8' });
    assert.equal(clean.status, 0, clean.stderr);

    const activeJournal = path.join(journalRoot, `${'a'.repeat(32)}.run.json`);
    fs.writeFileSync(activeJournal, '{}', { mode: 0o600 });
    const journalBusy = spawnSync(BASH, ['--noprofile', '--norc', '-c', baseCommand], { encoding: 'utf8' });
    assert.notEqual(journalBusy.status, 0, 'real migration-gate journals must block bootstrap');
    fs.unlinkSync(activeJournal);

    for (const [name, value] of [
      ['TM_TEST_SANITIZER_USERS', 'tm-gate-aaaaaaaaaaaa:22001:22001'],
      ['TM_TEST_SANITIZER_PROCESSES', '42001:tm-gate-aaaaaaaaaaaa'],
      ['TM_TEST_SANITIZER_MOUNTS', `${bashPath(runRoot)}/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`]
    ]) {
      const busy = spawnSync(BASH, ['--noprofile', '--norc', '-c', `export ${name}=${shellQuote(value)}; ${baseCommand}`], { encoding: 'utf8' });
      assert.notEqual(busy.status, 0, `${name} must fail closed`);
    }

    fs.mkdirSync(path.join(runRoot, 'b'.repeat(32)), { mode: 0o700 });
    const resourceBusy = spawnSync(BASH, ['--noprofile', '--norc', '-c', baseCommand], { encoding: 'utf8' });
    assert.notEqual(resourceBusy.status, 0, 'real /run sanitizer resources must block bootstrap');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootstrap active migration journal is no-follow, fail-closed, and strict no-replace', {
  skip: !HAS_BASH
}, async (t) => {
  const ownerToken = '0123456789abcdef0123456789abcdef';
  const makeRoot = (label) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `tm-bootstrap-journal-${label}-`));
    fs.mkdirSync(path.join(root, 'journal'), { recursive: true });
    return root;
  };
  const run = (root, body) => spawnSync(BASH, ['--noprofile', '--norc', '-c', bootstrapLibraryHarness(root, body)], {
    encoding: 'utf8',
    timeout: 20_000
  });
  const removeDanglingRoot = (root) => {
    const active = path.join(root, 'journal', 'active');
    try { if (fs.lstatSync(active).isSymbolicLink()) fs.unlinkSync(active); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    fs.rmSync(root, { recursive: true, force: true });
  };

  await t.test('begin rejects and preserves a dangling active entry without staging residue', (subtest) => {
    const root = makeRoot('begin-dangling');
    const active = path.join(root, 'journal', 'active');
    if (!createDanglingFileSymlinkOrSkip(subtest, active)) {
      fs.rmSync(root, { recursive: true, force: true });
      return;
    }
    const actions = gitBashPath(path.join(root, 'actions'));
    try {
      const result = run(root, `
BOOTSTRAP_OWNER_TOKEN=${ownerToken}
BACKUP_DIR="$BACKUP_ROOT/v030-runtime-bootstrap-20260731-010101"
reserve_migration_journal_capacity() { JOURNAL_RESERVATION_MODE=general; }
sync_directory() { :; }
chmod() { :; }
stop_current_release() { printf 'stop\n' >> ${shellQuote(actions)}; }
set +e
begin_migration_journal
status=$?
set -e
exit "$status"
`);
      assert.notEqual(result.status, 0, result.stderr || result.stdout);
      assert.equal(fs.lstatSync(active).isSymbolicLink(), true);
      assert.deepEqual(fs.readdirSync(path.join(root, 'journal')), ['active'], 'begin must leave no staged journal');
      assert.equal(fs.existsSync(path.join(root, 'actions')), false, 'begin rejection must precede service mutation');
    } finally {
      removeDanglingRoot(root);
    }
  });

  await t.test('recovery rejects and preserves a dangling active entry', (subtest) => {
    const root = makeRoot('recover-dangling');
    const active = path.join(root, 'journal', 'active');
    if (!createDanglingFileSymlinkOrSkip(subtest, active)) {
      fs.rmSync(root, { recursive: true, force: true });
      return;
    }
    const actions = gitBashPath(path.join(root, 'actions'));
    try {
      const result = run(root, `
BOOTSTRAP_OWNER_TOKEN=${ownerToken}
validate_sanitizer_gate_idle_state() { :; }
restore_runtime_snapshot() { printf 'restore\n' >> ${shellQuote(actions)}; }
restart_current_release() { printf 'restart\n' >> ${shellQuote(actions)}; }
clear_migration_journal() { printf 'clear\n' >> ${shellQuote(actions)}; }
set +e
recover_interrupted_migration
status=$?
set -e
exit "$status"
`);
      assert.notEqual(result.status, 0, 'dangling active recovery must fail closed');
      assert.match(result.stderr, /journal|unsafe|directory|symlink/i);
      assert.equal(fs.lstatSync(active).isSymbolicLink(), true);
      assert.equal(fs.existsSync(path.join(root, 'actions')), false, 'recovery must not mutate runtime state');
    } finally {
      removeDanglingRoot(root);
    }
  });

  await t.test('abort attempts dangling-journal recovery and never restarts', (subtest) => {
    const root = makeRoot('abort-dangling');
    const active = path.join(root, 'journal', 'active');
    if (!createDanglingFileSymlinkOrSkip(subtest, active)) {
      fs.rmSync(root, { recursive: true, force: true });
      return;
    }
    const actions = gitBashPath(path.join(root, 'actions'));
    try {
      const result = run(root, `
BOOTSTRAP_OWNER_TOKEN=${ownerToken}
PROCESS_STOPPED=1
validate_sanitizer_gate_idle_state() { :; }
restart_current_release() { printf 'restart\n' >> ${shellQuote(actions)}; }
restore_runtime_snapshot() { printf 'restore\n' >> ${shellQuote(actions)}; }
bootstrap_abort 42
`);
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.match(result.stderr, /BOOTSTRAP_RECOVERY_FAILED/);
      assert.equal(fs.lstatSync(active).isSymbolicLink(), true);
      assert.equal(fs.existsSync(path.join(root, 'actions')), false, 'abort must not restart or migrate around uncertain journal state');
    } finally {
      removeDanglingRoot(root);
    }
  });

  await t.test('read, phase write, clear, and idle validation each reject a dangling active entry', (subtest) => {
    for (const [label, command] of [
      ['read', 'read_journal'],
      ['phase', 'JOURNAL_DIR_IDENTITY=1:1; set_migration_phase snapshotting'],
      ['clear', 'JOURNAL_DIR_IDENTITY=1:1; clear_migration_journal'],
      ['idle', 'TM_TEST_GATE_PROCESSES="" TM_TEST_GATE_MOUNTS="" validate_phase4_idle_state']
    ]) {
      const root = makeRoot(`${label}-dangling`);
      const active = path.join(root, 'journal', 'active');
      if (!createDanglingFileSymlinkOrSkip(subtest, active)) {
        fs.rmSync(root, { recursive: true, force: true });
        return;
      }
      try {
        const result = run(root, `
BOOTSTRAP_OWNER_TOKEN=${ownerToken}
validate_sanitizer_gate_idle_state() { :; }
set +e
${command}
status=$?
set -e
exit "$status"
`);
        assert.notEqual(result.status, 0, `${label} must reject a dangling active entry`);
        assert.equal(fs.lstatSync(active).isSymbolicLink(), true, `${label} must preserve the dangling entry`);
      } finally {
        removeDanglingRoot(root);
      }
    }
  });

  await t.test('a real identity-bound active journal remains readable and recoverable', () => {
    const root = makeRoot('real-directory');
    const remote = path.join(root, 'remote');
    const backup = path.join(remote, 'backups', 'v030-runtime-bootstrap-20260731-010101');
    const active = path.join(root, 'journal', 'active');
    fs.mkdirSync(backup, { recursive: true });
    fs.mkdirSync(active);
    for (const [name, value] of [
      ['schema-version', '1'],
      ['owner-token', ownerToken],
      ['backup-dir', gitBashPath(backup)],
      ['phase', 'stopping']
    ]) fs.writeFileSync(path.join(active, name), `${value}\n`);
    const actions = gitBashPath(path.join(root, 'actions'));
    try {
      const result = run(root, `
BOOTSTRAP_OWNER_TOKEN=${ownerToken}
bootstrap_trusted_stat() {
  if [ "\${1:-}" = -c ] && [ "\${2:-}" = %U:%G:%a ]; then printf '%s:700\n' "$(expected_bootstrap_owner)"; return 0; fi
  if [ "\${1:-}" = -c ] && [ "\${2:-}" = %U:%G:%a:%h ]; then printf '%s:600:1\n' "$(expected_bootstrap_owner)"; return 0; fi
  command stat "$@"
}
bootstrap_trusted_realpath() { if [ "\${1:-}" = -e ]; then printf '%s\n' "$2"; else command realpath "$@"; fi; }
chmod() { :; }
sync_directory() { :; }
validate_sanitizer_gate_idle_state() { :; }
external_layout_marker_state() { printf 'absent\n'; }
cleanup_stages() { printf 'cleanup\n' >> ${shellQuote(actions)}; }
install_loopback_firewall_for_recovery() { printf 'firewall\n' >> ${shellQuote(actions)}; }
restart_current_release() { printf 'restart\n' >> ${shellQuote(actions)}; }
bootstrap_journal_dirfd_helper() {
  local action="$1" entry="\${2:-active}" expected="\${3:-}" argument_one="\${4:-}" argument_two="\${5:-}"
  local entry_path="$JOURNAL_ROOT/$entry" actual owner phase backup
  actual="$(command stat -c '%d:%i' -- "$entry_path" 2>/dev/null || true)"
  case "$action" in
    discover)
      if [ -n "$actual" ]; then printf 'live\n%s\n%s\n' "$entry" "$actual"; else printf 'absent\n'; fi
      ;;
    bind|authorize)
      [ -n "$actual" ] && { [ -z "$expected" ] || [ "$actual" = "$expected" ]; } || return 1
      if [ "$action" = authorize ] && [ "$entry" != active ] && { [ -e "$JOURNAL_DIR" ] || [ -L "$JOURNAL_DIR" ]; }; then return 1; fi
      printf '%s\n' "$actual"
      ;;
    read)
      [ -n "$actual" ] && { [ -z "$expected" ] || [ "$actual" = "$expected" ]; } || return 1
      owner="$(command cat "$entry_path/owner-token")"
      phase="$(command cat "$entry_path/phase")"
      backup="$(command cat "$entry_path/backup-dir")"
      printf '%s\n0\n%s\n%s\n%s\n%s\nlive\n-\n-\n' \
        "$actual" "$owner" "$phase" "$backup" ${'a'.repeat(64)}
      ;;
    write-phase)
      [ -n "$actual" ] && [ "$actual" = "$expected" ] || return 1
      printf '%s\n' "$argument_one" > "$entry_path/.phase.stub"
      command mv -- "$entry_path/.phase.stub" "$entry_path/phase"
      printf '%s\n%s\n' "$actual" ${'b'.repeat(64)}
      ;;
    adopt)
      [ -n "$actual" ] && [ "$actual" = "$expected" ] || return 1
      if [ "$(command cat "$entry_path/owner-token")" != "$argument_one" ]; then return 1; fi
      printf '%s\n' "$argument_two" > "$entry_path/.owner.stub"
      command mv -- "$entry_path/.owner.stub" "$entry_path/owner-token"
      printf '%s\n%s\n' "$actual" ${'c'.repeat(64)}
      ;;
    claim)
      [ -n "$actual" ] && [ "$actual" = "$expected" ] || return 1
      printf '%s\n' "$actual"
      ;;
    publish-terminal)
      [ -n "$actual" ] && [ "$actual" = "$expected" ] || return 1
      : > "$entry_path/terminal-pending"
      printf '%s\n%s\n%s\n' "$actual" ${'d'.repeat(64)} 't1:${'e'.repeat(64)}'
      ;;
    *) return 90 ;;
  esac
}
read_journal
set_migration_phase snapshotting
recover_interrupted_migration
`);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(fs.existsSync(active), true, 'successful recovery must retain the identity-bound active evidence');
      assert.equal(fs.existsSync(path.join(active, 'terminal-pending')), true);
      assert.equal(fs.readFileSync(path.join(root, 'actions'), 'utf8'), 'cleanup\nfirewall\nrestart\n');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('concurrent active publication is no-replace and leaves no private staging directory', () => {
    const root = makeRoot('concurrent-publication');
    const active = path.join(root, 'journal', 'active');
    try {
      const result = run(root, `
BOOTSTRAP_OWNER_TOKEN=${ownerToken}
BACKUP_DIR="$BACKUP_ROOT/v030-runtime-bootstrap-20260731-010101"
reserve_migration_journal_capacity() { JOURNAL_RESERVATION_MODE=general; }
sync_directory() { :; }
chmod() { :; }
injected=0
bootstrap_journal_dirfd_helper() {
  if [ "$1" = begin ]; then
    printf 'foreign-owner\n' > "$JOURNAL_DIR"
    return 1
  fi
  return 90
}
mkdir() {
  local target="\${!#}"
  if [ "$target" = "$JOURNAL_DIR" ] && [ "$injected" = 0 ]; then printf 'foreign-owner\n' > "$JOURNAL_DIR"; injected=1; fi
  command mkdir "$@"
}
mv() {
  local target="\${!#}"
  if [ "$target" = "$JOURNAL_DIR" ] && [ "$injected" = 0 ]; then printf 'foreign-owner\n' > "$JOURNAL_DIR"; injected=1; fi
  command mv "$@"
}
set +e
begin_migration_journal
status=$?
set -e
exit "$status"
`);
      assert.notEqual(result.status, 0, 'concurrent active creation must win without replacement');
      assert.equal(fs.readFileSync(active, 'utf8'), 'foreign-owner\n');
      assert.deepEqual(fs.readdirSync(path.join(root, 'journal')), ['active'], 'failed publication must not leave a private stage');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('source contract requires no-follow helpers at every active-journal mutation boundary', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'bootstrap_production_runtime.sh'), 'utf8');
    assert.match(source, /path_entry_present_no_follow\(\)/);
    assert.match(source, /real_directory_no_follow\(\)/);
    const functionBody = (name) => {
      const start = source.indexOf(`${name}() {`);
      const end = source.indexOf('\n}', start);
      assert.ok(start >= 0 && end > start, `missing ${name}`);
      return source.slice(start, end);
    };
    assert.match(functionBody('begin_migration_journal'), /bootstrap_journal_dirfd_helper begin active/);
    assert.doesNotMatch(functionBody('begin_migration_journal'), /\bmv\b|>\s*"\$JOURNAL_DIR\//);
    assert.doesNotMatch(functionBody('clear_migration_journal'), /rm\s+-rf|"\$JOURNAL_DIR"/);
    for (const name of ['set_migration_phase', 'read_journal', 'adopt_migration_journal']) {
      assert.doesNotMatch(
        functionBody(name),
        /\$JOURNAL_DIR\/(?:schema-version|owner-token|backup-dir|phase)/,
        `${name} must not access a journal field by path`
      );
    }
    assert.match(source, /os\.O_DIRECTORY[\s\S]*os\.O_NOFOLLOW/);
    assert.match(source, /renameat2/);
    assert.match(source, /terminal-pending/);
    assert.match(source, /terminal-consumed/);
    assert.match(source, /expected-head CAS/);
    assert.doesNotMatch(functionBody('clear_migration_journal'), /\bretire\b|\bquarantine\b/);
    assert.doesNotMatch(source, /os\.rmdir\(retired_name, dir_fd=root_fd\)/);
    for (const name of [
      'set_migration_phase', 'clear_migration_journal', 'read_journal', 'adopt_migration_journal',
      'recover_interrupted_migration', 'commit_external_layout_and_retire_journal',
      'finalize_post_marker_bootstrap_journal', 'bootstrap_abort'
    ]) assert.match(
      functionBody(name),
      /bootstrap_journal_dirfd_helper|migration_journal|path_entry_present_no_follow|real_directory_no_follow/,
      name
    );
  });
});

test('bootstrap journal rejects post-bind replacement and ABA without side effects', {
  skip: !HAS_BASH
}, async (t) => {
  const ownerToken = '0123456789abcdef0123456789abcdef';
  const priorOwnerToken = 'fedcba9876543210fedcba9876543210';
  const makeRoot = (label) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `tm-bootstrap-journal-race-${label}-`));
    fs.mkdirSync(path.join(root, 'journal'), { recursive: true });
    return root;
  };
  const run = (root, body) => spawnSync(BASH, ['--noprofile', '--norc', '-c', bootstrapLibraryHarness(root, body)], {
    encoding: 'utf8',
    timeout: 20_000
  });
  const writeJournal = (root, {
    directory = path.join(root, 'journal', 'active'),
    owner = ownerToken,
    phase = 'stopping',
    stamp = '20260731-020202'
  } = {}) => {
    const backup = path.join(root, 'remote', 'backups', `v030-runtime-bootstrap-${stamp}`);
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const [name, value] of [
      ['schema-version', '1'],
      ['owner-token', owner],
      ['backup-dir', gitBashPath(backup)],
      ['phase', phase]
    ]) fs.writeFileSync(path.join(directory, name), `${value}\n`, { mode: 0o600 });
    return backup;
  };
  const compatibilityOverrides = `
bootstrap_trusted_stat() {
  if [ "\${1:-}" = -c ] && [ "\${2:-}" = %U:%G:%a ]; then printf '%s:700\n' "$(expected_bootstrap_owner)"; return 0; fi
  if [ "\${1:-}" = -c ] && [ "\${2:-}" = %U:%G:%a:%h ]; then printf '%s:600:1\n' "$(expected_bootstrap_owner)"; return 0; fi
  command stat "$@"
}
bootstrap_trusted_realpath() { if [ "\${1:-}" = -e ]; then printf '%s\n' "$2"; else command realpath "$@"; fi; }
sync() { :; }
sync_directory() { :; }
external_layout_marker_state() { printf 'absent\n'; }
`;
  const journalHelperStub = process.platform === 'linux' ? '' : `
bootstrap_journal_dirfd_helper() {
  local action="$1" entry="\${2:-active}" expected="\${3:-}"
  local argument_one="\${4:-}" argument_two="\${5:-}"
  local entry_path="$JOURNAL_ROOT/$entry" actual owner phase backup quarantine
  journal_stub_identity() { command stat -c '%d:%i' -- "$1"; }
  case "$action" in
    discover)
      if [ -d "$JOURNAL_DIR" ] && [ ! -L "$JOURNAL_DIR" ]; then
        printf 'live\nactive\n%s\n' "$(journal_stub_identity "$JOURNAL_DIR")"
      else
        printf 'absent\n'
      fi
      ;;
    bind|authorize)
      actual="$(journal_stub_identity "$entry_path")" || return 1
      [ -z "$expected" ] || [ "$actual" = "$expected" ] || return 1
      if [ "$action" = authorize ] && [ "$entry" != active ] && { [ -e "$JOURNAL_DIR" ] || [ -L "$JOURNAL_DIR" ]; }; then
        return 1
      fi
      printf '%s\n' "$actual"
      ;;
    read)
      actual="$(journal_stub_identity "$entry_path")" || return 1
      [ -z "$expected" ] || [ "$actual" = "$expected" ] || return 1
      if [ "\${TM_TEST_JOURNAL_STUB_FAULT:-}" = read-aba ]; then
        command mv -- "$JOURNAL_DIR" "$JOURNAL_ROOT/read-original"
        command mv -- "$JOURNAL_ROOT/read-alternate" "$JOURNAL_DIR"
        owner="$(command cat "$JOURNAL_ROOT/read-original/owner-token")"
        phase="$(command cat "$JOURNAL_ROOT/read-original/phase")"
        backup="$(command cat "$JOURNAL_ROOT/read-original/backup-dir")"
        command mv -- "$JOURNAL_DIR" "$JOURNAL_ROOT/read-alternate"
        command mv -- "$JOURNAL_ROOT/read-original" "$JOURNAL_DIR"
      else
        owner="$(command cat "$entry_path/owner-token")"
        phase="$(command cat "$entry_path/phase")"
        backup="$(command cat "$entry_path/backup-dir")"
      fi
      printf '%s\n0\n%s\n%s\n%s\n%s\nlive\n-\n-\n' \
        "$actual" "$owner" "$phase" "$backup" ${'a'.repeat(64)}
      ;;
    write-phase)
      if [ "\${TM_TEST_JOURNAL_STUB_FAULT:-}" = phase ]; then
        command mv -- "$JOURNAL_DIR" "$JOURNAL_ROOT/phase-original"
        command mkdir -m 0700 -- "$JOURNAL_DIR"
        printf 'replacement-phase-must-survive\n' > "$JOURNAL_DIR/phase"
        return 1
      fi
      return 91
      ;;
    adopt)
      if [ "\${TM_TEST_JOURNAL_STUB_FAULT:-}" = adopt ]; then
        command mv -- "$JOURNAL_DIR" "$JOURNAL_ROOT/adopt-original"
        command mkdir -m 0700 -- "$JOURNAL_DIR"
        printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' > "$JOURNAL_DIR/owner-token"
        return 1
      fi
      actual="$(journal_stub_identity "$entry_path")" || return 1
      [ "$actual" = "$expected" ] || return 1
      printf '%s\n%s\n' "$actual" ${'b'.repeat(64)}
      ;;
    claim)
      actual="$(journal_stub_identity "$entry_path")" || return 1
      [ "$actual" = "$expected" ] || return 1
      printf '%s\n' "$actual"
      ;;
    publish-terminal)
      if [ "\${TM_TEST_JOURNAL_STUB_FAULT:-}" = retire ]; then
        command mv -- "$JOURNAL_DIR" "$JOURNAL_ROOT/clear-original"
        command mkdir -m 0700 -- "$JOURNAL_DIR"
        printf 'replacement-must-survive\n' > "$JOURNAL_DIR/replacement"
        return 1
      fi
      return 92
      ;;
    *) return 93 ;;
  esac
}
`;

  await t.test('clear preserves a real directory substituted after identity binding', () => {
    const root = makeRoot('clear');
    const active = path.join(root, 'journal', 'active');
    writeJournal(root);
    fs.writeFileSync(path.join(active, 'original'), 'original\n', { mode: 0o600 });
    try {
      const result = run(root, `
${compatibilityOverrides}
${journalHelperStub}
TM_TEST_JOURNAL_STUB_FAULT=retire
export TM_BOOTSTRAP_TEST_JOURNAL_REPLACE_AT=retire-before-claim
bind_active_migration_journal_directory
rm() {
  local target="\${!#}"
  if [ "$target" = "$JOURNAL_DIR" ]; then
    command mv -- "$JOURNAL_DIR" "$JOURNAL_ROOT/clear-original"
    command mkdir -m 0700 -- "$JOURNAL_DIR"
    printf 'replacement-must-survive\n' > "$JOURNAL_DIR/replacement"
  fi
  command rm "$@"
}
set +e
clear_migration_journal
clear_status=$?
set -e
printf 'clear_status=%s\n' "$clear_status"
`);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /clear_status=[1-9][0-9]*/);
      assert.equal(fs.readFileSync(path.join(active, 'replacement'), 'utf8'), 'replacement-must-survive\n');
      const retainedOriginal = fs.readdirSync(path.join(root, 'journal')).find((name) => (
        name === 'clear-original' || name.startsWith('.active.test-original.')
      ));
      assert.ok(retainedOriginal, 'the originally bound directory must remain as recovery evidence');
      assert.equal(fs.readFileSync(path.join(root, 'journal', retainedOriginal, 'original'), 'utf8'), 'original\n');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('phase publication never overwrites a directory substituted after binding', () => {
    const root = makeRoot('phase');
    const active = path.join(root, 'journal', 'active');
    writeJournal(root);
    try {
      const result = run(root, `
${compatibilityOverrides}
${journalHelperStub}
TM_TEST_JOURNAL_STUB_FAULT=phase
export TM_BOOTSTRAP_TEST_JOURNAL_REPLACE_AT=phase-before-rename
bind_active_migration_journal_directory
mv() {
  local source="\${@: -2:1}" target="\${!#}"
  if [ "$target" = "$JOURNAL_DIR/phase" ]; then
    command mv -- "$JOURNAL_DIR" "$JOURNAL_ROOT/phase-original"
    command mkdir -m 0700 -- "$JOURNAL_DIR"
    printf 'replacement-phase-must-survive\n' > "$JOURNAL_DIR/phase"
    command mv -- "$JOURNAL_ROOT/phase-original/\${source##*/}" "$target"
    return
  fi
  command mv "$@"
}
set +e
set_migration_phase snapshotting
phase_status=$?
set -e
printf 'phase_status=%s\n' "$phase_status"
`);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /phase_status=[1-9][0-9]*/);
      assert.equal(fs.readFileSync(path.join(active, 'phase'), 'utf8'), 'replacement-phase-must-survive\n');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('owner adoption never overwrites a directory substituted after binding', () => {
    const root = makeRoot('adopt');
    const active = path.join(root, 'journal', 'active');
    writeJournal(root, { owner: priorOwnerToken });
    try {
      const result = run(root, `
${compatibilityOverrides}
${journalHelperStub}
TM_TEST_JOURNAL_STUB_FAULT=adopt
export TM_BOOTSTRAP_TEST_JOURNAL_REPLACE_AT=adopt-before-rename
BOOTSTRAP_OWNER_TOKEN=${ownerToken}
JOURNAL_OWNER_TOKEN=${priorOwnerToken}
bind_active_migration_journal_directory
mv() {
  local target="\${!#}"
  if [ "$target" = "$JOURNAL_DIR/owner-token" ]; then
    command mv -- "$JOURNAL_DIR" "$JOURNAL_ROOT/adopt-original"
    command mkdir -m 0700 -- "$JOURNAL_DIR"
    printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' > "$JOURNAL_DIR/owner-token"
  fi
  command mv "$@"
}
set +e
adopt_migration_journal
adopt_status=$?
set -e
printf 'adopt_status=%s\n' "$adopt_status"
`);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /adopt_status=[1-9][0-9]*/);
      assert.equal(
        fs.readFileSync(path.join(active, 'owner-token'), 'utf8'),
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('read cannot accept fields from an ABA replacement journal', () => {
    const root = makeRoot('read-aba');
    const active = path.join(root, 'journal', 'active');
    const alternate = path.join(root, 'journal', 'read-alternate');
    const originalBackup = writeJournal(root, { phase: 'stopping', stamp: '20260731-030303' });
    const alternateBackup = writeJournal(root, {
      directory: alternate,
      phase: 'prepared',
      stamp: '20260731-040404'
    });
    try {
      const result = run(root, `
${compatibilityOverrides}
${journalHelperStub}
TM_TEST_JOURNAL_STUB_FAULT=read-aba
export TM_BOOTSTRAP_TEST_JOURNAL_REPLACE_AT=read-aba
cat() {
  local target="$1" value
  if [ "$target" = "$JOURNAL_DIR/phase" ] && [ ! -e "$JOURNAL_ROOT/read-aba-active" ]; then
    command mv -- "$JOURNAL_DIR" "$JOURNAL_ROOT/read-original"
    command mv -- "$JOURNAL_ROOT/read-alternate" "$JOURNAL_DIR"
    : > "$JOURNAL_ROOT/read-aba-active"
    command cat -- "$JOURNAL_DIR/phase"
    return
  fi
  if [ "$target" = "$JOURNAL_DIR/backup-dir" ] && [ -e "$JOURNAL_ROOT/read-aba-active" ]; then
    value="$(command cat -- "$JOURNAL_DIR/backup-dir")"
    command mv -- "$JOURNAL_DIR" "$JOURNAL_ROOT/read-alternate"
    command mv -- "$JOURNAL_ROOT/read-original" "$JOURNAL_DIR"
    command rm -- "$JOURNAL_ROOT/read-aba-active"
    printf '%s\n' "$value"
    return
  fi
  command cat "$@"
}
set +e
read_journal
read_status=$?
set -e
printf 'read_status=%s phase=%s backup=%s\n' "$read_status" "\${JOURNAL_PHASE:-}" "\${JOURNAL_BACKUP_DIR:-}"
`);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const trustedOriginal = `read_status=0 phase=stopping backup=${gitBashPath(originalBackup)}`;
      assert.ok(
        result.stdout.includes(trustedOriginal) || !result.stdout.includes('read_status=0'),
        `read trusted ABA replacement fields: ${result.stdout}\n${result.stderr}`
      );
      assert.doesNotMatch(result.stdout, new RegExp(`phase=prepared backup=${gitBashPath(alternateBackup).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('recovery detects post-adopt replacement before every runtime side effect', () => {
    const root = makeRoot('recover');
    const active = path.join(root, 'journal', 'active');
    writeJournal(root, { phase: 'stopping', stamp: '20260731-050505' });
    const actions = gitBashPath(path.join(root, 'actions'));
    try {
      const result = run(root, `
${compatibilityOverrides}
${journalHelperStub}
TM_TEST_JOURNAL_STUB_FAULT=none
unset TM_BOOTSTRAP_TEST_JOURNAL_REPLACE_AT
BOOTSTRAP_OWNER_TOKEN=${ownerToken}
validate_sanitizer_gate_idle_state() { :; }
eval "$(declare -f adopt_migration_journal | sed '1s/adopt_migration_journal/original_adopt_migration_journal/')"
adopt_migration_journal() {
  original_adopt_migration_journal || return 1
  command mv -- "$JOURNAL_DIR" "$JOURNAL_ROOT/recover-original"
  command mkdir -m 0700 -- "$JOURNAL_DIR"
  printf 'replacement-must-survive\n' > "$JOURNAL_DIR/replacement"
}
record_action() { printf '%s\n' "$1" >> ${shellQuote(actions)}; }
cleanup_stages() { record_action cleanup; }
install_loopback_firewall_for_recovery() { record_action firewall; }
restart_current_release() { record_action restart; }
restore_runtime_snapshot() { record_action restore; }
stop_current_release() { record_action stop; }
set_migration_phase() { record_action migration; }
set +e
recover_interrupted_migration
recover_status=$?
set -e
printf 'recover_status=%s\n' "$recover_status"
`);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /recover_status=[1-9][0-9]*/);
      const observedActions = fs.existsSync(path.join(root, 'actions'))
        ? fs.readFileSync(path.join(root, 'actions'), 'utf8')
        : '';
      assert.equal(observedActions, '', `recovery side effects ran after journal replacement: ${observedActions}`);
      assert.equal(fs.readFileSync(path.join(active, 'replacement'), 'utf8'), 'replacement-must-survive\n');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

test('bootstrap rejects every test hook in production mode', {
  skip: !HAS_BASH
}, async (t) => {
  const hookNames = [
    'TM_TEST_SANITIZER_USERS',
    'TM_TEST_SANITIZER_PROCESSES',
    'TM_TEST_SANITIZER_MOUNTS',
    'TM_TEST_GATE_PROCESSES',
    'TM_TEST_GATE_MOUNTS',
    'TM_BOOTSTRAP_TEST_SIGKILL_AT',
    'TM_BOOTSTRAP_TEST_DELETE_IOERROR_AT',
    'TM_BOOTSTRAP_TEST_DELETE_SIGKILL_AT',
    'TM_BOOTSTRAP_TEST_RESTORE_IOERROR_AT',
    'TM_BOOTSTRAP_TEST_RESTORE_SIGKILL_AT',
    'TM_BOOTSTRAP_TEST_FORCE_XDEV_RELATIVE',
    'TM_BOOTSTRAP_TEST_JOURNAL_REPLACE_AT',
    'TM_BOOTSTRAP_TEST_JOURNAL_SIGKILL_AT',
    'TM_BOOTSTRAP_TEST_JOURNAL_IOERROR_AT',
    'TM_BOOTSTRAP_TEST_BOOT_ID',
    'TM_BOOTSTRAP_TEST_CONTROL_LOCK_RACE',
    'TM_BOOTSTRAP_TEST_MOUNT_ID_OFFSET',
    'TM_BOOTSTRAP_TEST_EXTERNAL_MARKER_SIGKILL_AT',
    'TM_BOOTSTRAP_TEST_EXTERNAL_MARKER_IOERROR_AT',
    'TM_BOOTSTRAP_TEST_EXTERNAL_MARKER_REPLACE_AT'
  ];

  await t.test('present hook variables cannot bypass production state inspection', () => {
    const accepted = [];
    for (const hookName of hookNames) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-bootstrap-production-hook-'));
      try {
        const result = spawnSync(BASH, ['--noprofile', '--norc', '-c', bootstrapLibraryHarness(root, `
export TM_BOOTSTRAP_LIBRARY_ONLY=0
export ${hookName}=''
getent() { :; }
ps() { :; }
findmnt() { :; }
set +e
validate_sanitizer_gate_idle_state
hook_status=$?
set -e
exit "$hook_status"
`)], { encoding: 'utf8', timeout: 20_000 });
        if (result.status === 0) accepted.push(hookName);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
    assert.deepEqual(accepted, [], `production accepted test hooks: ${accepted.join(', ')}`);
  });

  await t.test('source inventory has one production guard and closes validated field descriptors', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'scripts', 'bootstrap_production_runtime.sh'),
      'utf8'
    );
    const referencedHooks = [...new Set(source.match(/TM_(?:BOOTSTRAP_)?TEST_[A-Z0-9_]+/g) || [])].sort();
    assert.deepEqual(referencedHooks, [...hookNames].sort());
    assert.match(source, /bootstrap_reject_production_test_hooks\(\)/);
    for (const name of [
      'validate_sanitizer_gate_idle_state',
      'validate_phase4_idle_state',
      'validate_runtime_snapshot',
      'bootstrap_journal_dirfd_helper'
    ]) {
      const start = source.indexOf(`${name}() {`);
      const end = source.indexOf('\n}', start);
      assert.ok(start >= 0 && end > start, `missing ${name}`);
      assert.match(
        source.slice(start, end),
        /bootstrap_reject_production_test_hooks/,
        `${name} must reject production test hooks`
      );
    }
    const validatorStart = source.indexOf('def validate_named_record(');
    const validatorEnd = source.indexOf('\n\ndef publish_anchor(', validatorStart);
    assert.ok(validatorStart >= 0 && validatorEnd > validatorStart, 'record validator must be bounded');
    const validator = source.slice(validatorStart, validatorEnd);
    assert.match(validator, /descriptor = os\.open\(/);
    assert.match(
      validator,
      /descriptor = os\.open\([\s\S]*?finally:[\s\S]*?os\.close\(descriptor\)/,
      'record validation must close its own no-follow descriptor'
    );
    const fdCloseContract = /descriptor = os\.open\([\s\S]*?finally:[\s\S]*?os\.close\(descriptor\)/;
    assert.doesNotMatch(
      validator.replace(/os\.close\(descriptor\)/, '# close removed'),
      fdCloseContract,
      'removing the local close must make the bounded descriptor contract fail'
    );
    assert.doesNotMatch(source, /os\.rmdir\(retired_name, dir_fd=root_fd\)/);
  });

  await t.test('top-level and direct mutation sinks reject hooks before dispatch', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-bootstrap-hook-sinks-'));
    const actions = gitBashPath(path.join(root, 'actions'));
    try {
      const result = spawnSync(BASH, ['--noprofile', '--norc', '-c', bootstrapLibraryHarness(root, `
actions=${shellQuote(actions)}
record_action() { printf '%s\n' "$1" >> "$actions"; }
python3() { record_action python; return 0; }
require_root() { record_action root; }

export TM_BOOTSTRAP_LIBRARY_ONLY=0
export TM_BOOTSTRAP_TEST_DELETE_IOERROR_AT=before-retire
set +e
bootstrap_generation_delete_helper discover "$JOURNAL_ROOT" > /dev/null 2> "$actions.delete.err"
delete_status=$?
set -e
test "$delete_status" -ne 0
grep -Fq 'Bootstrap test hook is forbidden in production mode' "$actions.delete.err"
test ! -e "$actions"

unset TM_BOOTSTRAP_TEST_DELETE_IOERROR_AT
export TM_BOOTSTRAP_TEST_RESTORE_IOERROR_AT=before-remove
set +e
bootstrap_anchored_path_helper validate /tmp missing 0700 0 > /dev/null 2> "$actions.restore.err"
restore_status=$?
set -e
test "$restore_status" -ne 0
grep -Fq 'Bootstrap test hook is forbidden in production mode' "$actions.restore.err"
test ! -e "$actions"

unset TM_BOOTSTRAP_TEST_RESTORE_IOERROR_AT
export TM_BOOTSTRAP_TEST_SIGKILL_AT=marker-durable
set +e
bootstrap_test_sigkill marker-durable 2> "$actions.sigkill.err"
sigkill_status=$?
set -e
test "$sigkill_status" -ne 0
grep -Fq 'Bootstrap test hook is forbidden in production mode' "$actions.sigkill.err"
test ! -e "$actions"

set +e
bootstrap_production_main 2> "$actions.main.err"
main_status=$?
set -e
test "$main_status" -ne 0
grep -Fq 'Bootstrap test hook is forbidden in production mode' "$actions.main.err"
test ! -e "$actions"
`)], { encoding: 'utf8', timeout: 20_000 });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

test('bootstrap terminal handshake is explicit, repeatable, and side-effect free', {
  skip: !HAS_BASH
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-bootstrap-terminal-explicit-'));
  const statePath = path.join(root, 'terminal-state');
  const state = gitBashPath(statePath);
  const actions = path.join(root, 'actions');
  const terminalId = `t1:${'a'.repeat(64)}`;
  fs.writeFileSync(statePath, `terminal-pending ${terminalId}\n`);
  try {
    const result = spawnSync(BASH, ['--noprofile', '--norc', '-c', bootstrapLibraryHarness(root, `
BOOTSTRAP_OWNER_TOKEN=0123456789abcdef0123456789abcdef
discover_migration_journal() {
  read -r JOURNAL_TERMINAL_STATE JOURNAL_TERMINAL_ID < ${shellQuote(state)}
  JOURNAL_PRESENT=1
  JOURNAL_ENTRY_NAME=active
  JOURNAL_DIR_IDENTITY=j1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:41:42:43
  JOURNAL_HEAD_DIGEST=${'b'.repeat(64)}
}
read_journal() {
  discover_migration_journal
  JOURNAL_PHASE=prepared
  JOURNAL_BACKUP_DIR="$BACKUP_ROOT/v030-runtime-bootstrap-20260802-040102"
  JOURNAL_OWNER_TOKEN=0123456789abcdef0123456789abcdef
  JOURNAL_MARKER_PROOF=absent
}
external_layout_marker_state() { printf 'absent\n'; }
bootstrap_ack_terminal_generation() {
  test "$1" = '${terminalId}' || return 74
  printf 'terminal-consumed %s\n' "$1" > ${shellQuote(state)}
  JOURNAL_TERMINAL_STATE=terminal-consumed
}
record_action() { printf '%s\n' "$1" >> ${shellQuote(gitBashPath(actions))}; }
cleanup_stages() { record_action cleanup; }
install_loopback_firewall_for_recovery() { record_action firewall; }
restart_current_release() { record_action restart; }
restore_runtime_snapshot() { record_action restore; }

bootstrap_terminal_journal_gate
test "$BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME" = terminal-pending
bootstrap_terminal_journal_gate
test "$BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME" = terminal-pending
test "$(cat ${shellQuote(state)})" = 'terminal-pending ${terminalId}'

set +e
bootstrap_ack_terminal_command 't1:${'c'.repeat(64)}'
wrong_status=$?
set -e
test "$wrong_status" -ne 0
test "$(cat ${shellQuote(state)})" = 'terminal-pending ${terminalId}'

require_root() { :; }
require_exact_host() { :; }
reserve_migration_journal_capacity() { JOURNAL_RESERVATION_MODE=terminal-only; }
bootstrap_ack_terminal_command '${terminalId}'
bootstrap_ack_terminal_command '${terminalId}'
test "$(cat ${shellQuote(state)})" = 'terminal-consumed ${terminalId}'
bootstrap_terminal_journal_gate
test -z "$BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME"
test ! -e ${shellQuote(gitBashPath(actions))}
`)], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.readFileSync(statePath, 'utf8'), `terminal-consumed ${terminalId}\n`);
    assert.equal(fs.existsSync(actions), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootstrap journal v4 publication is write-ahead, identity-bound, and retention-based', async (t) => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'bootstrap_production_runtime.sh'),
    'utf8'
  );
  const helperStart = source.indexOf('bootstrap_journal_dirfd_helper() {');
  const helperEnd = source.indexOf('\nPY\n}', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'journal dirfd helper source must be bounded');
  const helper = source.slice(helperStart, helperEnd);

  await t.test('generation zero is durable before canonical active publication', () => {
    const beginStart = helper.indexOf("if action == 'begin':");
    const beginEnd = helper.indexOf('journal_fd, journal_status = open_entry(', beginStart);
    assert.ok(beginStart >= 0 && beginEnd > beginStart, 'begin helper body must be present');
    const begin = helper.slice(beginStart, beginEnd);
    const generation = begin.indexOf("'generation-00000000'");
    const directorySync = begin.indexOf("boundary('begin-private-dir-fsync')");
    const publication = begin.indexOf("rename_noreplace(root_fd, private_name, root_fd, 'active')");
    assert.ok(generation >= 0 && directorySync > generation && publication > directorySync);
    const sourceAuthorization = begin.lastIndexOf('assert_entry_matches(', publication);
    const targetAuthorization = begin.indexOf('assert_entry_matches(', publication);
    assert.ok(sourceAuthorization > directorySync && sourceAuthorization < publication);
    assert.ok(targetAuthorization > publication, 'published active must remain bound to the private dirfd');
    assert.match(helper, /rename_noreplace\(root_fd, 'active', root_fd, consumed_name\)[\s\S]*assert_entry_matches\([\s\S]*consumed_name/);
  });

  await t.test('authoritative markers publish only from fsynced anonymous descriptors', () => {
    const publisherStart = helper.indexOf('def publish_anonymous_record(');
    const publisherEnd = helper.indexOf('\n\ndef ', publisherStart + 1);
    assert.ok(publisherStart >= 0 && publisherEnd > publisherStart, 'marker publisher must be bounded');
    const publisher = helper.slice(publisherStart, publisherEnd);
    assert.match(publisher, /O_TMPFILE/);
    assert.match(publisher, /os\.fsync\(descriptor\)/);
    assert.match(publisher, /os\.fsync\(parent_fd\)/);
    assert.match(publisher, /link_anonymous\(/);
    assert.match(helper, /AT_EMPTY_PATH/);
    assert.ok(
      publisher.indexOf('os.fsync(descriptor)') < publisher.indexOf('link_anonymous('),
      'marker payload must be fsynced before no-replace publication'
    );
    for (const prefix of [
      'begin-generation', 'phase-generation', 'adopt-generation',
      'terminal-pending', 'terminal-consumed'
    ]) assert.ok(helper.includes(prefix), `${prefix} publication must be present`);
    for (const suffix of [
      'stage-opened', 'stage-partial', 'stage-file-fsync', 'published', 'publish-dir-fsync'
    ]) assert.ok(publisher.includes(suffix), `${suffix} must be injectable`);
  });

  await t.test('collective reads reject mutable-leaf replacement and ABA', () => {
    assert.doesNotMatch(helper, /os\.replace\(|os\.unlink\(/);
    assert.match(helper, /directory_snapshot/);
    assert.match(helper, /st_ctime_ns/);
    assert.match(helper, /names_after\s*=\s*set\(os\.listdir\(journal_fd\)\)/);
    assert.match(helper, /current_identity != expected_file_identity/);
  });

  await t.test('recovery traps precede stale recovery while capacity precedes new-bootstrap host mutation', () => {
    assert.match(source, /reserve_migration_journal_capacity\(\)/);
    const mainStart = source.indexOf('bootstrap_production_main() {');
    const mainEnd = source.indexOf('\n}\n\nif [ "${TM_BOOTSTRAP_LIBRARY_ONLY', mainStart);
    assert.ok(mainStart >= 0 && mainEnd > mainStart, 'production entrypoint must be function-bounded');
    const main = source.slice(mainStart, mainEnd);
    const recoveryArm = main.indexOf('bootstrap_arm_cleanup_recovery');
    const artifactRecovery = main.indexOf('bootstrap_recover_stale_artifacts_before_reservation');
    const reservation = main.indexOf('reserve_migration_journal_capacity');
    assert.ok(reservation >= 0, 'production entrypoint must retain a journal capacity reservation');
    assert.ok(recoveryArm >= 0 && recoveryArm < artifactRecovery, 'recovery traps must precede stale recovery');
    assert.ok(artifactRecovery < reservation, 'stale artifact recovery must precede capacity reservation');
    assert.ok(main.indexOf('bootstrap_run_new_migration') > reservation, 'new migration must follow capacity reservation');
  });

  await t.test('terminal journal outcomes are checked before committed or new-bootstrap mutation', () => {
    const mainStart = source.indexOf('bootstrap_production_main() {');
    const mainEnd = source.indexOf('\n}\n\nif [ "${TM_BOOTSTRAP_LIBRARY_ONLY', mainStart);
    assert.ok(mainStart >= 0 && mainEnd > mainStart, 'production entrypoint must be function-bounded');
    const main = source.slice(mainStart, mainEnd);
    assert.match(main, /finalize_post_marker_bootstrap_journal[\s\S]*bootstrap_return_after_terminal_journal_outcome/);
    assert.match(main, /recover_interrupted_migration[\s\S]*bootstrap_return_after_terminal_journal_outcome/);
  });
});

test('committed recovery publishes and validates the permanent marker before retiring the journal', {
  skip: !HAS_BASH
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-bootstrap-committed-order-'));
  const actions = gitBashPath(path.join(root, 'actions'));
  try {
    const result = spawnSync(BASH, ['--noprofile', '--norc', '-c', bootstrapLibraryHarness(root, `
actions=${shellQuote(actions)}
record_action() { printf '%s\n' "$1" >> "$actions"; }
validate_sanitizer_gate_idle_state() { :; }
discover_migration_journal() {
  JOURNAL_PRESENT=1
  JOURNAL_RETIRING=0
  JOURNAL_ENTRY_NAME=.active.retired.41.42
  JOURNAL_DIR_IDENTITY=41:42
}
read_journal() {
  JOURNAL_PHASE=committed
  JOURNAL_BACKUP_DIR="$BACKUP_ROOT/v030-runtime-bootstrap-20260802-010101"
  JOURNAL_OWNER_TOKEN=11111111111111111111111111111111
}
adopt_migration_journal() { :; }
claim_migration_journal() { :; }
validate_active_migration_journal_directory() { :; }
validate_exact_link() { :; }
validate_external_runtime() { :; }
database_quick_check() { :; }
commit_external_layout_marker() { record_action marker; }
validate_external_layout_marker() { record_action marker-validate; }
install_loopback_firewall_for_recovery() { record_action firewall; }
restart_current_release() { record_action restart; }
clear_migration_journal() { record_action clear; }

recover_interrupted_migration
test "$BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME" = committed-recovered
test "$(cat "$actions")" = "marker
marker-validate
clear"
`)], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('production entrypoint terminates two retiring reruns before prohibited mutation', {
  skip: !HAS_BASH
}, async (t) => {
  for (const markerPresent of [false, true]) {
    await t.test(markerPresent ? 'marker present' : 'marker absent', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-bootstrap-terminal-entrypoint-'));
      const prohibited = gitBashPath(path.join(root, 'prohibited'));
      const marker = path.join(root, 'remote', '.external-runtime-layout-v1');
      try {
        if (markerPresent) {
          fs.mkdirSync(path.dirname(marker), { recursive: true });
          fs.writeFileSync(marker, 'marker\n');
        }
        const result = spawnSync(BASH, ['--noprofile', '--norc', '-c', bootstrapLibraryHarness(root, `
record_prohibited() { printf '%s\n' "$1" >> ${shellQuote(prohibited)}; }
require_root() { :; }
require_exact_host() { :; }
bootstrap_prepare_control_plane() { :; }
reserve_migration_journal_capacity() { JOURNAL_RESERVATION_MODE=general; }
bootstrap_terminal_journal_gate() { BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME=retiring-gate; }
bootstrap_arm_cleanup_recovery() { :; }
validate_sanitizer_gate_idle_state() { :; }
bootstrap_recover_stale_control_state() { :; }
validate_phase4_idle_state() { record_prohibited phase4; }
bootstrap_acquire_shared_fences() { record_prohibited fences; }
run_committed_layout_validation() { record_prohibited committed; }
bootstrap_run_new_migration() { record_prohibited migration; }
finalize_post_marker_bootstrap_journal() {
  BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME=retiring-finalized
}
recover_interrupted_migration() {
  BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME=retiring-recovered
}

bootstrap_production_main
bootstrap_production_main
test ! -e ${shellQuote(prohibited)}
`)], { encoding: 'utf8', timeout: 20_000 });
        assert.equal(result.status, 0, result.stderr || result.stdout);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test('production capacity reservation fails before host mutation and permits slot 31', {
  skip: !HAS_BASH
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-bootstrap-capacity-preflight-'));
  const actions = gitBashPath(path.join(root, 'actions'));
  try {
    const result = spawnSync(BASH, ['--noprofile', '--norc', '-c', bootstrapLibraryHarness(root, `
actions=${shellQuote(actions)}
record_action() { printf '%s\n' "$1" >> "$actions"; }
require_root() { :; }
require_exact_host() { :; }
bootstrap_prepare_control_plane() { record_action control; return 79; }
bootstrap_arm_cleanup_recovery() { record_action arm; }
bootstrap_run_new_migration() { record_action mutation; }
external_layout_marker_state() { printf 'absent\n'; }
bootstrap_prepare_journal_run_identity() { BOOTSTRAP_OWNER_TOKEN=${'1'.repeat(32)}; }
begin_migration_journal() {
  record_action "gen0-$capacity"
  JOURNAL_PRESENT=1
  JOURNAL_TERMINAL_STATE=live
  JOURNAL_OWNER_TOKEN="$BOOTSTRAP_OWNER_TOKEN"
}
claim_migration_journal() { record_action claim; }

capacity=32
reserve_migration_journal_capacity() {
  record_action "reserve-$capacity"
  [ "$capacity" -lt 32 ] || return 1
  JOURNAL_RESERVATION_MODE=general
}
bootstrap_terminal_journal_gate() {
  BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME=
  JOURNAL_PRESENT=0
  JOURNAL_TERMINAL_STATE=
}
set +e
bootstrap_production_main
full_status=$?
set -e
test "$full_status" -ne 0
  test "$(cat "$actions")" = "arm
reserve-32"

: > "$actions"
capacity=31
set +e
bootstrap_production_main
available_status=$?
set -e
  test "$available_status" -eq 79
  test "$(cat "$actions")" = "arm
reserve-31
gen0-31
claim
control"
`)], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootstrap journal v4 three-state protocol closes fresh-process and publication races', {
  skip: !HAS_BASH
}, async (t) => {
  const bootstrapPath = path.join(__dirname, '..', 'scripts', 'bootstrap_production_runtime.sh');
  const source = fs.readFileSync(bootstrapPath, 'utf8');

  await t.test('terminal-pending repeats until an explicit matching acknowledgement', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-bootstrap-terminal-handshake-'));
    const state = gitBashPath(path.join(root, 'terminal-state'));
    const actions = gitBashPath(path.join(root, 'actions'));
    const terminalId = `t1:${'a'.repeat(64)}`;
    fs.writeFileSync(path.join(root, 'terminal-state'), `terminal-pending ${terminalId}\n`);
    try {
      const result = spawnSync(BASH, ['--noprofile', '--norc', '-c', bootstrapLibraryHarness(root, `
require_root() { :; }
require_exact_host() { :; }
reserve_migration_journal_capacity() { JOURNAL_RESERVATION_MODE=general; }
bootstrap_prepare_control_plane() { :; }
bootstrap_arm_cleanup_recovery() { :; }
validate_sanitizer_gate_idle_state() { :; }
bootstrap_recover_stale_control_state() { :; }
recover_interrupted_migration() { :; }
finalize_post_marker_bootstrap_journal() { :; }
validate_phase4_idle_state() { :; }
bootstrap_acquire_shared_fences() { :; }
external_layout_marker_state() { printf 'absent\n'; }
bootstrap_run_new_migration() {
  printf 'migration\n' >> ${shellQuote(actions)}
  JOURNAL_PRESENT=1
  JOURNAL_TERMINAL_STATE=terminal-pending
  JOURNAL_TERMINAL_ID='t1:${'c'.repeat(64)}'
  BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME=terminal-pending
}
validate_terminal_journal_marker_provenance() { :; }
discover_migration_journal() {
  read -r JOURNAL_TERMINAL_STATE JOURNAL_TERMINAL_ID < ${shellQuote(state)}
  JOURNAL_PRESENT=1
  JOURNAL_ENTRY_NAME=active
  JOURNAL_DIR_IDENTITY=j1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:31:41:51
  JOURNAL_HEAD_DIGEST=${'d'.repeat(64)}
}
bootstrap_ack_terminal_generation() {
  expected_id="$1"
  read -r current_state current_id < ${shellQuote(state)}
  test "$expected_id" = "$current_id" || return 74
  if [ "$current_state" = terminal-pending ]; then
    printf 'terminal-consumed %s\n' "$current_id" > ${shellQuote(state)}
    if [ "\${TM_TEST_ACK_CRASH_AFTER_APPEND:-0}" = 1 ]; then
      return 91
    fi
  fi
  test "$(cut -d' ' -f1 ${shellQuote(state)})" = terminal-consumed
}
bootstrap_prepare_journal_run_identity() { BOOTSTRAP_OWNER_TOKEN=${'1'.repeat(32)}; }
begin_migration_journal() {
  JOURNAL_PRESENT=1
  JOURNAL_TERMINAL_STATE=live
  JOURNAL_TERMINAL_ID=
  JOURNAL_OWNER_TOKEN="$BOOTSTRAP_OWNER_TOKEN"
}
claim_migration_journal() { :; }

bootstrap_production_main
test ! -e ${shellQuote(actions)}
bootstrap_production_main
test ! -e ${shellQuote(actions)}
test "$(cat ${shellQuote(state)})" = 'terminal-pending ${terminalId}'

set +e
bootstrap_ack_terminal_command 't1:${'b'.repeat(64)}'
wrong_status=$?
set -e
test "$wrong_status" -ne 0
test "$(cat ${shellQuote(state)})" = 'terminal-pending ${terminalId}'

TM_TEST_ACK_CRASH_AFTER_APPEND=1
export TM_TEST_ACK_CRASH_AFTER_APPEND
set +e
bootstrap_ack_terminal_command '${terminalId}'
crash_status=$?
set -e
test "$crash_status" -eq 91
unset TM_TEST_ACK_CRASH_AFTER_APPEND
test "$(cat ${shellQuote(state)})" = 'terminal-consumed ${terminalId}'

bootstrap_ack_terminal_command '${terminalId}'
test "$(cat ${shellQuote(state)})" = 'terminal-consumed ${terminalId}'
bootstrap_production_main
test "$(cat ${shellQuote(actions)})" = migration
`)], { encoding: 'utf8', timeout: 20_000 });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('terminal acknowledgement failure is fail-closed before mutation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-bootstrap-terminal-consume-failure-'));
    const actions = gitBashPath(path.join(root, 'actions'));
    try {
      const result = spawnSync(BASH, ['--noprofile', '--norc', '-c', bootstrapLibraryHarness(root, `
require_root() { :; }
require_exact_host() { :; }
reserve_migration_journal_capacity() { JOURNAL_RESERVATION_MODE=general; }
bootstrap_prepare_control_plane() { printf 'control\n' >> ${shellQuote(actions)}; }
discover_migration_journal() {
  JOURNAL_PRESENT=1
  JOURNAL_TERMINAL_STATE=terminal-pending
  JOURNAL_TERMINAL_ID='t1:${'c'.repeat(64)}'
  JOURNAL_ENTRY_NAME=active
  JOURNAL_DIR_IDENTITY=j1:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc:32:42:52
  JOURNAL_HEAD_DIGEST=${'e'.repeat(64)}
}
validate_terminal_journal_marker_provenance() { :; }
bootstrap_ack_terminal_generation() { return 75; }
set +e
bootstrap_ack_terminal_command 't1:${'c'.repeat(64)}'
status=$?
set -e
test "$status" -eq 75
test ! -e ${shellQuote(actions)}
`)], { encoding: 'utf8', timeout: 20_000 });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('legacy committed pending observation is immutable until explicit acknowledgement', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-bootstrap-legacy-pending-observe-'));
    const actions = gitBashPath(path.join(root, 'actions'));
    const terminalId = `t1:${'9'.repeat(64)}`;
    try {
      const result = spawnSync(BASH, ['--noprofile', '--norc', '-c', bootstrapLibraryHarness(root, `
marker_present=0
require_root() { :; }
require_exact_host() { :; }
reserve_migration_journal_capacity() { JOURNAL_RESERVATION_MODE=terminal-only; }
discover_migration_journal() {
  JOURNAL_PRESENT=1
  JOURNAL_ENTRY_NAME=active
  JOURNAL_DIR_IDENTITY=j2:${'a'.repeat(64)}:31:41:51
  JOURNAL_TERMINAL_STATE=terminal-pending
  JOURNAL_TERMINAL_ID='${terminalId}'
  JOURNAL_HEAD_DIGEST=${'b'.repeat(64)}
}
read_journal() {
  JOURNAL_PRESENT=1
  JOURNAL_LEGACY_TEST=1
  JOURNAL_PHASE=committed
  JOURNAL_TERMINAL_STATE=terminal-pending
  JOURNAL_TERMINAL_ID='${terminalId}'
  JOURNAL_HEAD_DIGEST=${'b'.repeat(64)}
  JOURNAL_MARKER_PROOF=absent
}
external_layout_marker_state() {
  if [ "$marker_present" = 1 ]; then printf 'valid\n'; else printf 'absent\n'; fi
}
validate_exact_link() { printf 'link\n' >> ${shellQuote(actions)}; }
validate_external_runtime() { printf 'runtime\n' >> ${shellQuote(actions)}; }
database_quick_check() { printf 'sqlite\n' >> ${shellQuote(actions)}; }
commit_external_layout_marker() {
  printf 'marker\n' >> ${shellQuote(actions)}
  marker_present=1
  EXTERNAL_LAYOUT_MARKER_PROOF='m2:${'d'.repeat(64)}:11:12:${'c'.repeat(64)}'
}
validate_external_layout_marker() {
  [ "$marker_present" = 1 ] || return 71
  printf 'marker-validate\n' >> ${shellQuote(actions)}
  EXTERNAL_LAYOUT_MARKER_PROOF='m2:${'d'.repeat(64)}:11:12:${'c'.repeat(64)}'
}
bootstrap_ack_terminal_generation() {
  [ "$JOURNAL_MARKER_PROOF" = 'm2:${'d'.repeat(64)}:11:12:${'c'.repeat(64)}' ] || return 72
  printf 'ack\n' >> ${shellQuote(actions)}
  JOURNAL_TERMINAL_STATE=terminal-consumed
}

first="$(bootstrap_terminal_journal_gate)"
second="$(bootstrap_terminal_journal_gate)"
test "$first" = 'BOOTSTRAP_TERMINAL_ID=${terminalId}'
test "$second" = "$first"
test ! -e ${shellQuote(actions)}
bootstrap_ack_terminal_command '${terminalId}'
test "$(cat ${shellQuote(actions)})" = "link
link
link
link
runtime
sqlite
marker
marker-validate
ack"
`)], { encoding: 'utf8', timeout: 20_000 });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('committed live journal binds marker proof before terminal publication', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-bootstrap-completed-committed-'));
    const actions = gitBashPath(path.join(root, 'actions'));
    try {
      const result = spawnSync(BASH, ['--noprofile', '--norc', '-c', bootstrapLibraryHarness(root, `
record_action() { printf '%s\n' "$1" >> ${shellQuote(actions)}; }
read_journal() {
  JOURNAL_PRESENT=1
  JOURNAL_TERMINAL_STATE=live
  JOURNAL_PHASE=committed
  JOURNAL_BACKUP_DIR="$BACKUP_ROOT/v030-runtime-bootstrap-20260802-030101"
  JOURNAL_OWNER_TOKEN=11111111111111111111111111111111
  JOURNAL_HEAD_DIGEST=${'f'.repeat(64)}
}
JOURNAL_ENTRY_NAME=active
JOURNAL_DIR_IDENTITY=j1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:31:41:51
JOURNAL_HEAD_DIGEST=${'f'.repeat(64)}
JOURNAL_TERMINAL_STATE=live
JOURNAL_PHASE=committed
commit_external_layout_marker() {
  record_action marker
  EXTERNAL_LAYOUT_MARKER_PROOF='m1:11:12:13:${'a'.repeat(64)}'
}
validate_external_layout_marker() {
  record_action marker-validate
  EXTERNAL_LAYOUT_MARKER_PROOF='m1:11:12:13:${'a'.repeat(64)}'
}
bootstrap_journal_dirfd_helper() {
  test "$1" = publish-terminal
  test "$4" = 'm1:11:12:13:${'a'.repeat(64)}'
  record_action terminal-pending
  printf '%s\n%s\n%s\n' "$JOURNAL_DIR_IDENTITY" ${'b'.repeat(64)} 't1:${'c'.repeat(64)}'
}
clear_migration_journal
test "$(cat ${shellQuote(actions)})" = "marker
marker-validate
terminal-pending
marker-validate"
test "$JOURNAL_TERMINAL_STATE" = terminal-pending
test "$JOURNAL_TERMINAL_ID" = 't1:${'c'.repeat(64)}'
test "$JOURNAL_MARKER_PROOF" = 'm1:11:12:13:${'a'.repeat(64)}'
`)], { encoding: 'utf8', timeout: 20_000 });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('completed precommit journal rejects any permanent marker before terminal publication', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-bootstrap-completed-precommit-'));
    const marker = path.join(root, 'remote', '.external-runtime-layout-v1');
    const actions = gitBashPath(path.join(root, 'actions'));
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, 'substituted-marker\n');
    try {
      const result = spawnSync(BASH, ['--noprofile', '--norc', '-c', bootstrapLibraryHarness(root, `
validate_sanitizer_gate_idle_state() { :; }
discover_migration_journal() {
  JOURNAL_PRESENT=1
  JOURNAL_RETIRING=0
  JOURNAL_COMPLETED=1
  JOURNAL_ENTRY_NAME=.active.retired.302.1
  JOURNAL_DIR_IDENTITY=j1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:32:42
}
read_journal() {
  JOURNAL_PHASE=prepared
  JOURNAL_BACKUP_DIR="$BACKUP_ROOT/v030-runtime-bootstrap-20260802-030102"
  JOURNAL_OWNER_TOKEN=11111111111111111111111111111111
}
clear_migration_journal() { printf 'terminal-pending\n' >> ${shellQuote(actions)}; }
set +e
recover_interrupted_migration
status=$?
set -e
test "$status" -ne 0
test ! -e ${shellQuote(actions)}
`)], { encoding: 'utf8', timeout: 20_000 });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(fs.readFileSync(marker, 'utf8'), 'substituted-marker\n');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('permanent marker publication is anonymous-fd bound and no-replace', () => {
    const start = source.indexOf('commit_external_layout_marker() {');
    const end = source.indexOf('\n}', start);
    assert.ok(start >= 0 && end > start, 'commit_external_layout_marker must be bounded');
    const commit = source.slice(start, end);
    assert.match(source, /bootstrap_external_layout_marker_helper\(\)/);
    assert.match(source, /O_TMPFILE/);
    assert.match(source, /AT_EMPTY_PATH/);
    assert.match(source, /linkat/);
    assert.doesNotMatch(commit, />\s*"\$temporary"|\bmv\b/);
  });

  await t.test('permanent marker replacement and stale-stage boundaries are behavior-injectable', () => {
    assert.match(source, /TM_BOOTSTRAP_TEST_EXTERNAL_MARKER_REPLACE_AT/);
    assert.match(source, /inject_external_marker_replacement/);
    assert.match(source, /external-marker-before-publish/);
    assert.match(source, /max_stale_stages\s*=\s*[1-9][0-9]*/);
    assert.doesNotMatch(source, /os\.unlink\([^\n]*external-runtime-layout-v1\.stage/);
  });

  await t.test('live journal uses immutable collective generations and private no-replace begin', () => {
    const helperStart = source.indexOf('bootstrap_journal_dirfd_helper() {');
    const helperEnd = source.indexOf('\nPY\n}', helperStart);
    assert.ok(helperStart >= 0 && helperEnd > helperStart, 'journal helper must be bounded');
    const helper = source.slice(helperStart, helperEnd);
    assert.match(helper, /journal-format-v4/);
    assert.match(helper, /generation_pattern/);
    assert.match(helper, /read_generation_snapshot/);
    assert.match(helper, /initializing_pattern/);
    assert.match(helper, /rename_noreplace\(root_fd, private_name, root_fd, 'active'\)/);
    assert.match(helper, /previousDigest/);
    assert.match(helper, /rootAnchor/);
    assert.match(helper, /runId/);
    assert.match(helper, /expected_head/);
    assert.doesNotMatch(helper, /os\.replace\(/);
    assert.doesNotMatch(helper, /os\.mkdir\(entry_name, 0o700, dir_fd=root_fd\)/);
  });

  await t.test('private initialization is bounded staging rather than a fourth logical state', () => {
    const helperStart = source.indexOf('bootstrap_journal_dirfd_helper() {');
    const helperEnd = source.indexOf('\nPY\n}', helperStart);
    const helper = source.slice(helperStart, helperEnd);
    assert.match(helper, /def classify_initializing_stage\(/);
    assert.match(helper, /classification = 'incomplete'/);
    assert.match(helper, /classification = 'complete'/);
    assert.match(helper, /max_journal_directories\s*=\s*32/);
    assert.doesNotMatch(helper, /'state':\s*'initializing'/);
  });

  await t.test('generation leaf substitution and mixed-generation ABA are behavior-injectable', () => {
    const helperStart = source.indexOf('bootstrap_journal_dirfd_helper() {');
    const helperEnd = source.indexOf('\nPY\n}', helperStart);
    const helper = source.slice(helperStart, helperEnd);
    assert.match(helper, /inject_generation_leaf_replacement/);
    assert.match(helper, /generation-leaf-before-publish/);
    assert.match(helper, /read-mixed-generation-aba/);
    assert.match(helper, /names_before[\s\S]*os\.listdir\(journal_fd\)[\s\S]*identities/);
  });

  await t.test('journal root and directory tokens carry the trusted traversal identity', () => {
    const helperStart = source.indexOf('bootstrap_journal_dirfd_helper() {');
    const helperEnd = source.indexOf('\nPY\n}', helperStart);
    const helper = source.slice(helperStart, helperEnd);
    const openRootStart = helper.indexOf('def open_root():');
    const openRootEnd = helper.indexOf('\n\ndef ', openRootStart + 1);
    const openRoot = helper.slice(openRootStart, openRootEnd);
    assert.match(source, /JOURNAL_ROOT_TOKEN=/);
    assert.match(source, /bind_migration_journal_root\(\)/);
    assert.match(source, /action == 'bind-root'/);
    assert.match(source, /parentAnchor/);
    assert.match(source, /rootDevice/);
    assert.match(source, /rootInode/);
    assert.match(source, /token = 'r2:' \+ hashlib\.sha256/);
    assert.match(source, /f'j2:\{bound_root_token\[3:\]\}/);
    assert.match(openRoot, /root-anchor-v2/);
    assert.match(openRoot, /root-mount-guard-v1/);
    assert.doesNotMatch(openRoot, /'bootId'\s*:/);
    assert.doesNotMatch(openRoot, /'rootMount'\s*:/);
    assert.match(source, /TM_BOOTSTRAP_TEST_BOOT_ID/);
    assert.match(source, /TM_BOOTSTRAP_TEST_MOUNT_ID_OFFSET/);
    assert.match(source, /marker_proof_pattern\s*=\s*re\.compile\(r'm2:/);
  });

  await t.test('ordinary terminal gate never consumes and CLI acknowledgement is explicit', () => {
    const gateStart = source.indexOf('bootstrap_terminal_journal_gate() {');
    const gateEnd = source.indexOf('\n}', gateStart);
    const gate = source.slice(gateStart, gateEnd);
    assert.doesNotMatch(gate, /consume-terminal|ack-terminal/);
    assert.match(source, /--ack-terminal/);
    assert.match(source, /bootstrap_ack_terminal_command\(\)/);
    assert.match(source, /terminal-pending/);
    assert.match(source, /terminal-consumed/);
    assert.doesNotMatch(source, /JOURNAL_(?:RETIRING|COMPLETED|ACKNOWLEDGED|INITIALIZING)=/);
  });

  await t.test('live journal identity is claimed before control-plane mutation', async (subtest) => {
    for (const existing of [false, true]) {
      await subtest.test(existing ? 'existing live generation' : 'new generation zero', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-bootstrap-precontrol-claim-'));
        const actions = gitBashPath(path.join(root, 'actions'));
        try {
          const result = spawnSync(BASH, ['--noprofile', '--norc', '-c', bootstrapLibraryHarness(root, `
record_action() { printf '%s\n' "$1" >> ${shellQuote(actions)}; }
require_root() { :; }
require_exact_host() { :; }
reserve_migration_journal_capacity() { JOURNAL_RESERVATION_MODE=general; }
bootstrap_terminal_journal_gate() {
  BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME=
  JOURNAL_PRESENT=${existing ? 1 : 0}
  JOURNAL_TERMINAL_STATE=${existing ? 'live' : ''}
  JOURNAL_ENTRY_NAME=active
  JOURNAL_DIR_IDENTITY=${existing ? `j2:${'a'.repeat(64)}:31:41:51` : ''}
  JOURNAL_HEAD_DIGEST=${existing ? 'b'.repeat(64) : ''}
}
external_layout_marker_state() { printf 'absent\n'; }
bootstrap_prepare_journal_run_identity() { BOOTSTRAP_OWNER_TOKEN=${'1'.repeat(32)}; }
begin_migration_journal() {
  record_action gen0
  JOURNAL_PRESENT=1
  JOURNAL_TERMINAL_STATE=live
  JOURNAL_ENTRY_NAME=active
  JOURNAL_DIR_IDENTITY=j2:${'a'.repeat(64)}:31:41:51
  JOURNAL_HEAD_DIGEST=${'b'.repeat(64)}
  JOURNAL_OWNER_TOKEN="$BOOTSTRAP_OWNER_TOKEN"
}
read_journal() {
  record_action read
  JOURNAL_PRESENT=1
  JOURNAL_TERMINAL_STATE=live
  JOURNAL_PHASE=stopping
  JOURNAL_BACKUP_DIR="$BACKUP_ROOT/v030-runtime-bootstrap-20260802-050101"
  JOURNAL_OWNER_TOKEN=${existing ? '2'.repeat(32) : '1'.repeat(32)}
  JOURNAL_HEAD_DIGEST=${'b'.repeat(64)}
}
adopt_migration_journal() { record_action adopt; JOURNAL_OWNER_TOKEN="$BOOTSTRAP_OWNER_TOKEN"; }
claim_migration_journal() { record_action claim; }
bootstrap_prepare_control_plane() { record_action control; return 81; }

set +e
bootstrap_production_main
status=$?
set -e
test "$status" -eq 81
${existing
  ? 'test "$(cat ' + shellQuote(actions) + ')" = "read\nadopt\nclaim\ncontrol"'
  : 'test "$(cat ' + shellQuote(actions) + ')" = "gen0\nclaim\ncontrol"'}
`)], { encoding: 'utf8', timeout: 20_000 });
          assert.equal(result.status, 0, result.stderr || result.stdout);
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      });
    }
  });

  await t.test('failed post-open capacity validation releases descriptor seven', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-bootstrap-capacity-fd-'));
    const journalRoot = path.join(root, 'journal');
    fs.mkdirSync(journalRoot, { mode: 0o700 });
    fs.writeFileSync(path.join(journalRoot, '.journal-protocol.lock'), 'journal-protocol-lock-v1\n');
    try {
      const result = spawnSync(BASH, ['--noprofile', '--norc', '-c', bootstrapLibraryHarness(root, `
JOURNAL_ROOT=${shellQuote(gitBashPath(journalRoot))}
JOURNAL_DIR="$JOURNAL_ROOT/active"
bootstrap_trusted_realpath() { if [ "\${1:-}" = -e ]; then printf '%s\n' "$2"; else command realpath "$@"; fi; }
bootstrap_trusted_stat() {
  if [ "\${1:-}" = -c ] && [ "\${2:-}" = %U:%G:%a ]; then
    printf '%s:700\n' "$(expected_bootstrap_owner)"
    return 0
  fi
  command stat "$@"
}
bootstrap_trusted_flock() { :; }
bootstrap_journal_dirfd_helper() {
  case "$1" in
    bind-root) printf 'r2:%s\n' ${shellQuote('a'.repeat(64))} ;;
    ensure-lock)
      printf '%s:51\n' "$(command stat -c '%d:%i' "$JOURNAL_ROOT/.journal-protocol.lock")"
      ;;
    verify-reservation)
      printf '%s:51\n' "$(command stat -c '%d:%i' "$JOURNAL_ROOT/.journal-protocol.lock")"
      ;;
    reserve-capacity) return 73 ;;
    *) return 90 ;;
  esac
}
set +e
reserve_migration_journal_capacity
status=$?
set -e
test "$status" -eq 1
if { : >&7; } 2>/dev/null; then
  printf '%s\n' 'descriptor 7 remained writable after reservation failure' >&2
  exit 92
fi
`)], { encoding: 'utf8', timeout: 20_000 });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('repeated capacity validation fails full and releases descriptor seven', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-bootstrap-capacity-repeat-'));
    const lockPath = gitBashPath(path.join(root, 'reservation.lock'));
    try {
      const result = spawnSync(BASH, ['--noprofile', '--norc', '-c', bootstrapLibraryHarness(root, `
exec 7>${shellQuote(lockPath)}
JOURNAL_CAPACITY_RESERVED=1
JOURNAL_ROOT_TOKEN='r2:${'a'.repeat(64)}'
bootstrap_trusted_flock() { :; }
bootstrap_journal_dirfd_helper() {
  [ "$1" = reserve-capacity ] || return 90
  printf 'full\n'
}
set +e
reserve_migration_journal_capacity
status=$?
set -e
test "$status" -ne 0
test "$JOURNAL_CAPACITY_RESERVED" = 0
if { : >&7; } 2>/dev/null; then
  printf '%s\n' 'descriptor 7 remained writable after repeated full result' >&2
  exit 92
fi
`)], { encoding: 'utf8', timeout: 20_000 });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('legacy terminal evidence requires a fixed explicit acknowledgement record', () => {
    const helperStart = source.indexOf('bootstrap_journal_dirfd_helper() {');
    const helperEnd = source.indexOf('\nPY\n}', helperStart);
    const helper = source.slice(helperStart, helperEnd);
    assert.match(helper, /legacy_explicit_ack_name\s*=\s*'terminal-explicit-ack-v1'/);
    assert.match(helper, /publish_anonymous_record\([\s\S]*legacy_explicit_ack_name/);
    assert.match(helper, /Migration journal legacy acknowledgement id is stale or invalid/);
    assert.match(helper, /'state': 'terminal-consumed'/);
  });

  await t.test('discovery never hides retained live or pending evidence behind canonical consumed state', () => {
    const helperStart = source.indexOf('bootstrap_journal_dirfd_helper() {');
    const helperEnd = source.indexOf('\nPY\n}', helperStart);
    const helper = source.slice(helperStart, helperEnd);
    const discoverStart = helper.indexOf('def discover_state(');
    const discoverEnd = helper.indexOf('\n\ndef ', discoverStart + 1);
    assert.ok(discoverStart >= 0 && discoverEnd > discoverStart);
    const discover = helper.slice(discoverStart, discoverEnd);
    assert.match(discover, /record\['state'\] in \('live', 'terminal-pending'\)/);
    assert.match(discover, /active canonical entry conflicts with retained unconsumed evidence/i);
  });

  await t.test('capacity reservation rejects before control-plane mutation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-bootstrap-capacity-reservation-'));
    const actions = gitBashPath(path.join(root, 'actions'));
    try {
      const result = spawnSync(BASH, ['--noprofile', '--norc', '-c', bootstrapLibraryHarness(root, `
require_root() { :; }
require_exact_host() { :; }
reserve_migration_journal_capacity() { return 73; }
preflight_migration_journal_capacity() { :; }
bootstrap_prepare_control_plane() { printf 'control\n' >> ${shellQuote(actions)}; }
bootstrap_arm_cleanup_recovery() { :; }
set +e
bootstrap_production_main
status=$?
set -e
test "$status" -eq 73
test ! -e ${shellQuote(actions)}
`)], { encoding: 'utf8', timeout: 20_000 });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('shell journal helper forwards expanded arguments to the native reducer', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-bootstrap-journal-forwarding-'));
    try {
      const result = spawnSync(BASH, ['--noprofile', '--norc', '-c', bootstrapLibraryHarness(root, `
JOURNAL_ROOT_TOKEN='r2:${'a'.repeat(64)}'
python3() {
  [ "$1" = - ] || return 81
  [ "$2" = read ] || return 82
  [ "$4" = active ] || return 83
  [ "$5" = 'j2:${'a'.repeat(64)}:31:41:51' ] || return 84
  [ "$8" = 1 ] || return 85
  [ "$9" = first ] || return 86
  [ "\${10}" = second ] || return 87
  [ "\${11}" = third ] || return 88
  [ "\${12}" = "$JOURNAL_ROOT_TOKEN" ] || return 89
  while IFS= read -r _line; do :; done
}
bootstrap_journal_dirfd_helper read active \
  'j2:${'a'.repeat(64)}:31:41:51' first second third
`)], { encoding: 'utf8', timeout: 20_000 });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('native journal helper mutations require the held reservation even in library mode', () => {
    const helperStart = source.indexOf('bootstrap_journal_dirfd_helper() {');
    const helperEnd = source.indexOf('\nPY\n}', helperStart);
    const helper = source.slice(helperStart, helperEnd);
    const requirementStart = helper.indexOf('def require_reservation(');
    const requirementEnd = helper.indexOf('\n\ndef ', requirementStart + 1);
    assert.ok(requirementStart >= 0 && requirementEnd > requirementStart);
    const requirement = helper.slice(requirementStart, requirementEnd);
    assert.match(requirement, /verify_reservation\(root_fd, root_status, root_mount_id\)/);
    assert.doesNotMatch(requirement, /library_only/);
  });

  await t.test('full capacity permits in-place live recovery but blocks new top-level mutation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-bootstrap-existing-live-capacity-'));
    const actions = gitBashPath(path.join(root, 'actions'));
    try {
      const result = spawnSync(BASH, ['--noprofile', '--norc', '-c', bootstrapLibraryHarness(root, `
record_action() { printf '%s\n' "$1" >> ${shellQuote(actions)}; }
require_root() { :; }
require_exact_host() { :; }
bootstrap_recover_stale_artifacts_before_reservation() { :; }
reserve_migration_journal_capacity() { JOURNAL_RESERVATION_MODE=existing-live; }
external_layout_marker_state() { printf 'absent\n'; }
bootstrap_terminal_journal_gate() {
  BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME=
  JOURNAL_PRESENT="$present"
  JOURNAL_TERMINAL_STATE="$state"
  JOURNAL_ENTRY_NAME=active
  JOURNAL_DIR_IDENTITY=j2:${'a'.repeat(64)}:31:41:51
  JOURNAL_HEAD_DIGEST=${'b'.repeat(64)}
}
bootstrap_prepare_journal_run_identity() { BOOTSTRAP_OWNER_TOKEN=${'1'.repeat(32)}; }
read_journal() {
  JOURNAL_OWNER_TOKEN=${'2'.repeat(32)}
  JOURNAL_PHASE=stopping
  JOURNAL_BACKUP_DIR="$BACKUP_ROOT/v030-runtime-bootstrap-20260802-050102"
  JOURNAL_HEAD_DIGEST=${'b'.repeat(64)}
}
adopt_migration_journal() { record_action adopt; JOURNAL_OWNER_TOKEN="$BOOTSTRAP_OWNER_TOKEN"; }
claim_migration_journal() { record_action claim; }
bootstrap_prepare_control_plane() { record_action control; }
bootstrap_arm_cleanup_recovery() { :; }
validate_sanitizer_gate_idle_state() { :; }
bootstrap_recover_stale_control_state() { :; }
recover_interrupted_migration() {
  record_action recover
  BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME=rollback-recovered
}
begin_migration_journal() { record_action gen0; return 92; }

present=1
state=live
set +e
bootstrap_production_main
live_status=$?
set -e
test "$live_status" -eq 0
test "$(cat ${shellQuote(actions)})" = "adopt
claim
control
recover"

: > ${shellQuote(actions)}
present=0
state=
set +e
bootstrap_production_main
absent_status=$?
set -e
test "$absent_status" -ne 0
test ! -s ${shellQuote(actions)}
`)], { encoding: 'utf8', timeout: 20_000 });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

test('Lane A: post-marker setup reaches repair and terminal progression through bootstrap_production_main', {
  skip: !HAS_BASH
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-bootstrap-post-marker-main-'));
  const actions = gitBashPath(path.join(root, 'actions'));
  try {
    const result = spawnSync(BASH, ['--noprofile', '--norc', '-c', bootstrapLibraryHarness(root, `
record_action() { printf '%s\n' "$1" >> ${shellQuote(actions)}; }
require_root() { :; }
require_exact_host() { :; }
bootstrap_recover_stale_artifacts_before_reservation() { record_action artifact-preflight; }
reserve_migration_journal_capacity() { record_action reserve; JOURNAL_RESERVATION_MODE=general; }
bootstrap_terminal_journal_gate() {
  record_action terminal-gate
  BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME=
  JOURNAL_PRESENT=0
  JOURNAL_TERMINAL_STATE=
}
external_layout_marker_state() { record_action marker-state; printf 'valid\n'; }
bootstrap_prepare_committed_validation_backup() { record_action backup-root; }
bootstrap_prepare_journal_run_identity() {
  record_action identity
  BOOTSTRAP_OWNER_TOKEN=11111111111111111111111111111111
}
begin_migration_journal() {
  test "$1" = committed
  record_action gen0-committed
  JOURNAL_PRESENT=1
  JOURNAL_TERMINAL_STATE=live
  JOURNAL_PHASE=committed
  JOURNAL_OWNER_TOKEN="$BOOTSTRAP_OWNER_TOKEN"
}
claim_live_journal_before_host_mutation() { record_action claim; }
bootstrap_prepare_control_plane() { record_action control; }
bootstrap_arm_cleanup_recovery() { record_action arm; }
validate_sanitizer_gate_idle_state() { record_action sanitizer-idle; }
bootstrap_recover_stale_control_state() { record_action stale-control; }
finalize_post_marker_bootstrap_journal() { record_action unexpected-finalize; return 91; }
validate_phase4_idle_state() {
  if [ "\${1:-}" != owned-committed ]; then
    record_action idle-self-reject
    return 66
  fi
  record_action idle-owned-committed
}
bootstrap_acquire_shared_fences() { record_action shared-fences; }
run_committed_layout_validation() { record_action setup-repair; }
clear_migration_journal() {
  record_action terminal-progress
  BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME=post-marker-repair-complete
}
bootstrap_run_new_migration() { record_action forbidden-new-migration; return 92; }

mkdir -p "$TM_REMOTE_ROOT"
bootstrap_production_main > "$TM_REMOTE_ROOT/main.out"
grep -Fq 'BOOTSTRAP_JOURNAL_TERMINAL_OUTCOME=post-marker-repair-complete' "$TM_REMOTE_ROOT/main.out"
grep -Fxq artifact-preflight ${shellQuote(actions)}
grep -Fxq backup-root ${shellQuote(actions)}
grep -Fxq gen0-committed ${shellQuote(actions)}
grep -Fxq idle-owned-committed ${shellQuote(actions)}
grep -Fxq setup-repair ${shellQuote(actions)}
grep -Fxq terminal-progress ${shellQuote(actions)}
if grep -Eq 'idle-self-reject|unexpected-finalize|forbidden-new-migration' ${shellQuote(actions)}; then exit 93; fi
test "$(sed -n '/artifact-preflight/=' ${shellQuote(actions)})" -lt "$(sed -n '/reserve/=' ${shellQuote(actions)})"
test "$(sed -n '/claim/=' ${shellQuote(actions)})" -lt "$(sed -n '/setup-repair/=' ${shellQuote(actions)})"
`)], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Lane A: conditional bootstrap failures remain terminal and recovery is armed before mutation', {
  skip: !HAS_BASH
}, async (t) => {
  await t.test('the real control-plane function rejects an invalid operation-fence link count under ||', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-bootstrap-fence-owner-failure-'));
    try {
      const result = spawnSync(BASH, ['--noprofile', '--norc', '-c', bootstrapLibraryHarness(root, `
SANITIZER_LIFECYCLE_FENCE="$TM_REMOTE_ROOT/sanitizer.lock"
OPERATION_FENCE="$TM_REMOTE_ROOT/.deploy-v030.operation.lock"
mkdir -p "$TM_REMOTE_ROOT"
: > "$OPERATION_FENCE"
: > "$SANITIZER_LIFECYCLE_FENCE"
chmod 0600 "$SANITIZER_LIFECYCLE_FENCE"
ln "$OPERATION_FENCE" "$OPERATION_FENCE.alias"
bootstrap_prepare_journal_run_identity() { :; }
bind_migration_journal_root() { :; }

owner_status=0
bootstrap_prepare_control_plane || owner_status=$?
test "$owner_status" -ne 0
`)], { encoding: 'utf8', timeout: 20_000 });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('the real migration function cannot overwrite a failed before snapshot with BOOTSTRAP_OK', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-bootstrap-snapshot-failure-'));
    const snapshots = gitBashPath(path.join(root, 'snapshots'));
    try {
      const result = spawnSync(BASH, ['--noprofile', '--norc', '-c', bootstrapLibraryHarness(root, `
require_root() { :; }
require_exact_host() { :; }
bootstrap_terminal_journal_preflight() {
  BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME=
  JOURNAL_PRESENT=0
  JOURNAL_TERMINAL_STATE=
}
bootstrap_recover_stale_artifacts_before_reservation() { :; }
reserve_migration_journal_capacity() { JOURNAL_RESERVATION_MODE=general; }
bootstrap_terminal_journal_gate() {
  BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME=
  JOURNAL_PRESENT=0
  JOURNAL_TERMINAL_STATE=
}
external_layout_marker_state() { printf '%s\n' absent; }
bootstrap_prepare_journal_run_identity() { BOOTSTRAP_OWNER_TOKEN=${'1'.repeat(32)}; }
begin_migration_journal() {
  JOURNAL_PRESENT=1
  JOURNAL_TERMINAL_STATE=live
  JOURNAL_OWNER_TOKEN="$BOOTSTRAP_OWNER_TOKEN"
}
claim_live_journal_before_host_mutation() { :; }
bootstrap_prepare_control_plane() { :; }
bootstrap_arm_cleanup_recovery() { :; }
validate_sanitizer_gate_idle_state() { :; }
bootstrap_recover_stale_control_state() { :; }
validate_phase4_idle_state() { :; }
bootstrap_acquire_shared_fences() { :; }
snapshot_host() {
  printf '%s\n' "$1" >> ${shellQuote(snapshots)}
  [ "$1" != before ] || return 73
}
apt-get() { :; }
getent() { :; }
validate_gate_identity() { :; }
install() { :; }
install_apparmor_profile() { :; }
validate_exact_link() { :; }
validate_external_runtime() { :; }
database_quick_check() { :; }
stop_current_release() { :; }
install_loopback_firewall() { :; }
restart_current_release() { :; }
commit_external_layout_marker() { :; }
set_migration_phase() { JOURNAL_PHASE="$1"; }
clear_migration_journal() {
  JOURNAL_PRESENT=1
  JOURNAL_TERMINAL_STATE=terminal-pending
  JOURNAL_TERMINAL_ID='t1:${'9'.repeat(64)}'
  BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME=terminal-pending
}
commit_external_layout_and_retire_journal() { clear_migration_journal quiet; }

status=0
output="$(bootstrap_production_main)" || status=$?
test "$status" -eq 73
if printf '%s\n' "$output" | grep -Fq BOOTSTRAP_OK; then exit 91; fi
test "$(cat ${shellQuote(snapshots)})" = before
`)], { encoding: 'utf8', timeout: 20_000 });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('the real main arms recovery before stale-artifact mutation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-bootstrap-early-recovery-traps-'));
    const actions = gitBashPath(path.join(root, 'actions'));
    try {
      const result = spawnSync(BASH, ['--noprofile', '--norc', '-c', bootstrapLibraryHarness(root, `
record_action() { printf '%s\n' "$1" >> ${shellQuote(actions)}; }
require_root() { :; }
require_exact_host() { :; }
bootstrap_terminal_journal_preflight() {
  BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME=
  JOURNAL_PRESENT=0
  JOURNAL_TERMINAL_STATE=
}
bootstrap_arm_cleanup_recovery() { record_action arm; }
bootstrap_recover_stale_artifacts_before_reservation() { record_action artifact-recovery; return 74; }
reserve_migration_journal_capacity() { record_action forbidden-reserve; return 75; }

status=0
bootstrap_production_main || status=$?
test "$status" -eq 74
test "$(cat ${shellQuote(actions)})" = "arm
artifact-recovery"
`)], { encoding: 'utf8', timeout: 20_000 });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

test('Lane A: database and AppArmor helpers reject every command failure under conditional invocation', {
  skip: !HAS_BASH
}, async (t) => {
  const databaseFixtures = [
    { helper: 'database_backup "$root/source.db" "$root/backup.db"', fault: 'cd' },
    { helper: 'database_backup "$root/source.db" "$root/backup.db"', fault: 'node' },
    { helper: 'database_quick_check "$root/source.db"', fault: 'cd' },
    { helper: 'database_quick_check "$root/source.db"', fault: 'node' }
  ];

  for (const fixture of databaseFixtures) {
    await t.test(`${fixture.helper.split(' ')[0]} rejects ${fixture.fault}`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-bootstrap-database-conditional-'));
      const actions = gitBashPath(path.join(root, 'actions'));
      try {
        const result = spawnSync(BASH, ['--noprofile', '--norc', '-c', bootstrapLibraryHarness(root, `
root="\${TM_REMOTE_ROOT%/remote}"
fault=${shellQuote(fixture.fault)}
[ "$fault" != node ] || mkdir -p "$LIVE_DIR/server"
record_action() { builtin printf '%s\n' "$1" >> ${shellQuote(actions)}; }
cd() {
  record_action cd
  [ "$fault" != cd ] || return 71
  builtin cd "$@"
}
node() {
  record_action node
  [ "$fault" != node ] || return 72
}

status=0
success_output=
if ${fixture.helper}; then
  success_output=BOOTSTRAP_OK
else
  status=$?
fi
test "$status" -ne 0
test -z "$success_output"
test "$(command cat ${shellQuote(actions)})" = ${shellQuote(
          fixture.fault === 'cd' ? 'cd' : 'cd\nnode'
        )}
`)], { encoding: 'utf8', timeout: 20_000 });
        assert.equal(result.status, 0, `${fixture.fault}: ${result.stderr || result.stdout}`);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }

  const appArmorFixtures = [
    { fault: 'cat', previous: false, expected: ['cat'] },
    { fault: 'chmod', previous: false, expected: ['cat', 'chmod'] },
    { fault: 'validate', previous: false, expected: ['cat', 'chmod', 'validate'] },
    { fault: 'backup', previous: true, expected: ['cat', 'chmod', 'validate', 'backup'] },
    { fault: 'install', previous: false, expected: ['cat', 'chmod', 'validate', 'install', 'cleanup'] },
    { fault: 'reload', previous: false, expected: ['cat', 'chmod', 'validate', 'install', 'reload', 'cleanup'] }
  ];

  for (const fixture of appArmorFixtures) {
    await t.test(`install_apparmor_profile rejects ${fixture.fault}`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-bootstrap-apparmor-conditional-'));
      const actions = gitBashPath(path.join(root, 'actions'));
      try {
        const result = spawnSync(BASH, ['--noprofile', '--norc', '-c', bootstrapLibraryHarness(root, `
root="\${TM_REMOTE_ROOT%/remote}"
BACKUP_DIR="$root/backup"
APPARMOR_PROFILE="$root/apparmor/profile"
mkdir -p "$BACKUP_DIR" "$(dirname "$APPARMOR_PROFILE")"
${fixture.previous ? 'builtin printf \'previous-profile\\n\' > "$APPARMOR_PROFILE"' : ':'}
fault=${shellQuote(fixture.fault)}
record_action() { builtin printf '%s\n' "$1" >> ${shellQuote(actions)}; }
cat() {
  record_action cat
  [ "$fault" != cat ] || return 73
  command cat "$@"
}
chmod() {
  record_action chmod
  [ "$fault" != chmod ] || return 74
  command chmod "$@"
}
apparmor_parser() {
  if [ "$1" = -Q ]; then
    record_action validate
    [ "$fault" != validate ] || return 75
  else
    record_action reload
    [ "$fault" != reload ] || return 76
  fi
}
cp() {
  record_action backup
  [ "$fault" != backup ] || return 77
  command cp "$@"
}
install() {
  record_action install
  [ "$fault" != install ] || return 78
  command cp -- "\${@: -2:1}" "\${!#}"
}
rm() {
  record_action cleanup
  command rm "$@"
}

status=0
success_output=
if install_apparmor_profile; then
  success_output=BOOTSTRAP_OK
else
  status=$?
fi
test "$status" -ne 0
test -z "$success_output"
test "$(command cat ${shellQuote(actions)})" = ${shellQuote(fixture.expected.join('\n'))}
`)], { encoding: 'utf8', timeout: 20_000 });
        assert.equal(result.status, 0, `${fixture.fault}: ${result.stderr || result.stdout}`);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test('Lane A: restart helper guards release identity and PM2 outcomes under conditional invocation', {
  skip: !HAS_BASH
}, async (t) => {
  const fixtures = [
    {
      name: 'cd failure',
      createLive: false,
      restartStatus: 0,
      startStatus: 0,
      pm2Shape: 'exact',
      listenerPid: 4312,
      expectedStatus: 1,
      expectJlist: false
    },
    {
      name: 'restart success requires the exact managed listener owner',
      createLive: true,
      restartStatus: 0,
      startStatus: 83,
      pm2Shape: 'exact',
      listenerPid: 4312,
      expectedStatus: 0,
      expectJlist: true
    },
    {
      name: 'start fallback success requires the exact managed listener owner',
      createLive: true,
      restartStatus: 83,
      startStatus: 0,
      pm2Shape: 'exact',
      listenerPid: 4312,
      expectedStatus: 0,
      expectJlist: true
    },
    {
      name: 'restart and start both exit 83 with stale healthy runtime',
      createLive: true,
      restartStatus: 83,
      startStatus: 83,
      pm2Shape: 'exact',
      listenerPid: 4312,
      expectedStatus: 1,
      expectJlist: false
    },
    {
      name: 'managed app is errored',
      createLive: true,
      restartStatus: 0,
      startStatus: 83,
      pm2Shape: 'errored',
      listenerPid: 4312,
      expectedStatus: 1,
      expectJlist: true
    },
    {
      name: 'duplicate managed app entries are ambiguous',
      createLive: true,
      restartStatus: 0,
      startStatus: 83,
      pm2Shape: 'duplicate',
      listenerPid: 4312,
      expectedStatus: 1,
      expectJlist: true
    },
    {
      name: 'managed app cwd is outside the live release',
      createLive: true,
      restartStatus: 0,
      startStatus: 83,
      pm2Shape: 'wrong-cwd',
      listenerPid: 4312,
      expectedStatus: 1,
      expectJlist: true
    },
    {
      name: 'managed app script is outside the expected release entrypoint',
      createLive: true,
      restartStatus: 0,
      startStatus: 83,
      pm2Shape: 'wrong-script',
      listenerPid: 4312,
      expectedStatus: 1,
      expectJlist: true
    },
    {
      name: 'managed app PID must be positive',
      createLive: true,
      restartStatus: 0,
      startStatus: 83,
      pm2Shape: 'zero-pid',
      listenerPid: 4312,
      expectedStatus: 1,
      expectJlist: true
    },
    {
      name: 'malformed PM2 JSON fails closed',
      createLive: true,
      restartStatus: 0,
      startStatus: 83,
      pm2Shape: 'malformed',
      listenerPid: 4312,
      expectedStatus: 1,
      expectJlist: true
    },
    {
      name: 'unrelated stale listener cannot satisfy managed health',
      createLive: true,
      restartStatus: 0,
      startStatus: 83,
      pm2Shape: 'exact',
      listenerPid: 9876,
      expectedStatus: 1,
      expectJlist: true
    }
  ];

  for (const fixture of fixtures) {
    await t.test(fixture.name, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-bootstrap-pm2-conditional-'));
      const actions = gitBashPath(path.join(root, 'actions'));
      const liveDir = gitBashPath(path.join(root, 'live'));
      const expectedScript = `${liveDir}/server/server.js`;
      const exactEntry = {
        name: 'turingmarket',
        pid: 4312,
        pm2_env: {
          status: 'online',
          pm_cwd: liveDir,
          pm_exec_path: expectedScript
        }
      };
      let pm2Snapshot;
      switch (fixture.pm2Shape) {
        case 'exact':
          pm2Snapshot = JSON.stringify([exactEntry]);
          break;
        case 'errored':
          pm2Snapshot = JSON.stringify([{ ...exactEntry, pm2_env: { ...exactEntry.pm2_env, status: 'errored' } }]);
          break;
        case 'duplicate':
          pm2Snapshot = JSON.stringify([exactEntry, { ...exactEntry, pid: 4313 }]);
          break;
        case 'wrong-cwd':
          pm2Snapshot = JSON.stringify([{ ...exactEntry, pm2_env: { ...exactEntry.pm2_env, pm_cwd: `${liveDir}-old` } }]);
          break;
        case 'wrong-script':
          pm2Snapshot = JSON.stringify([{ ...exactEntry, pm2_env: { ...exactEntry.pm2_env, pm_exec_path: `${liveDir}/server/old.js` } }]);
          break;
        case 'zero-pid':
          pm2Snapshot = JSON.stringify([{ ...exactEntry, pid: 0 }]);
          break;
        case 'malformed':
          pm2Snapshot = '{"not-json"';
          break;
        default:
          throw new Error(`unknown PM2 fixture shape: ${fixture.pm2Shape}`);
      }
      try {
        const result = spawnSync(BASH, ['--noprofile', '--norc', '-c', bootstrapLibraryHarness(root, `
${fixture.createLive ? 'mkdir -p "$LIVE_DIR/server"; builtin printf \'server-entrypoint\\n\' > "$LIVE_DIR/server/server.js"' : ':'}
restart_status=${fixture.restartStatus}
start_status=${fixture.startStatus}
pm2_json=${shellQuote(pm2Snapshot)}
listener_pid=${fixture.listenerPid}
record_action() { builtin printf '%s\n' "$1" >> ${shellQuote(actions)}; }
validate_sanitizer_gate_idle_state() { record_action sanitizer; }
validate_loopback_firewall() { record_action firewall; }
pm2() {
  [ "$PWD" = "$LIVE_DIR" ] || return 82
  case "$*" in
    'restart ecosystem.config.js --only turingmarket --update-env')
      record_action "pm2:$*"
      return "$restart_status"
      ;;
    'start ecosystem.config.js --only turingmarket --update-env')
      record_action "pm2:$*"
      return "$start_status"
      ;;
    'jlist')
      record_action 'pm2:jlist'
      builtin printf '%s\n' "$pm2_json"
      ;;
    'stop turingmarket')
      record_action 'pm2:stop turingmarket'
      ;;
    *) return 81 ;;
  esac
}
curl() { record_action health; return 0; }
ss() {
  record_action listener
  builtin printf 'LISTEN 0 511 127.0.0.1:3002 0.0.0.0:* users:(("node",pid=%s,fd=20))\n' "$listener_pid"
}
sleep() { return 0; }
seq() { builtin printf '1\n'; }

status=0
success_output=
if restart_current_release; then
  success_output=BOOTSTRAP_OK
else
  status=$?
fi
test "$status" -eq ${fixture.expectedStatus}
${fixture.expectedStatus === 0 ? 'test "$success_output" = BOOTSTRAP_OK' : 'test -z "$success_output"'}
action_log="$(command cat ${shellQuote(actions)} 2>/dev/null || true)"
${fixture.expectJlist ? 'grep -Fqx \'pm2:jlist\' <<< "$action_log"' : 'if grep -Fqx \'pm2:jlist\' <<< "$action_log"; then exit 91; fi'}
${fixture.expectedStatus === 0
    ? 'grep -Fqx listener <<< "$action_log"\ngrep -Fqx health <<< "$action_log"\nif grep -Fqx \'pm2:stop turingmarket\' <<< "$action_log"; then exit 92; fi'
    : fixture.expectJlist
      ? 'if grep -Fqx health <<< "$action_log"; then exit 93; fi\ngrep -Fqx \'pm2:stop turingmarket\' <<< "$action_log"'
      : 'if grep -Eq \'^(health|listener)$\' <<< "$action_log"; then exit 94; fi'}
`)], { encoding: 'utf8', timeout: 20_000 });
        assert.equal(result.status, 0, `${fixture.name}: ${result.stderr || result.stdout}`);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test('Lane A: full-capacity existing-live recovery advances in place but cannot start top-level work', {
  skip: !HAS_BASH
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-bootstrap-existing-live-main-'));
  const actions = gitBashPath(path.join(root, 'actions'));
  try {
    const result = spawnSync(BASH, ['--noprofile', '--norc', '-c', bootstrapLibraryHarness(root, `
record_action() { printf '%s\n' "$1" >> ${shellQuote(actions)}; }
require_root() { :; }
require_exact_host() { :; }
bootstrap_recover_stale_artifacts_before_reservation() { record_action artifact-preflight; }
reserve_migration_journal_capacity() { record_action reserve-existing-live; JOURNAL_RESERVATION_MODE=existing-live; }
bootstrap_terminal_journal_gate() {
  record_action terminal-gate
  BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME=
  JOURNAL_PRESENT="$present"
  JOURNAL_TERMINAL_STATE="$state"
  JOURNAL_OWNER_TOKEN=11111111111111111111111111111111
}
external_layout_marker_state() { printf 'absent\n'; }
bootstrap_prepare_journal_run_identity() { BOOTSTRAP_OWNER_TOKEN=11111111111111111111111111111111; }
begin_migration_journal() { record_action forbidden-gen0; return 91; }
claim_live_journal_before_host_mutation() { record_action claim-existing; }
bootstrap_prepare_control_plane() { record_action control; }
bootstrap_arm_cleanup_recovery() { record_action arm; }
validate_sanitizer_gate_idle_state() { record_action sanitizer-idle; }
bootstrap_recover_stale_control_state() { record_action stale-control; }
recover_interrupted_migration() {
  record_action recover-existing
  BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME=rollback-recovered
}
validate_phase4_idle_state() { record_action forbidden-phase4; return 92; }
bootstrap_acquire_shared_fences() { record_action forbidden-fences; return 93; }
bootstrap_run_new_migration() { record_action forbidden-new-migration; return 94; }

mkdir -p "$TM_REMOTE_ROOT"
present=1
state=live
bootstrap_production_main > "$TM_REMOTE_ROOT/live.out"
grep -Fq 'BOOTSTRAP_JOURNAL_TERMINAL_OUTCOME=rollback-recovered' "$TM_REMOTE_ROOT/live.out"
grep -Fxq claim-existing ${shellQuote(actions)}
grep -Fxq recover-existing ${shellQuote(actions)}
if grep -Eq 'forbidden-gen0|forbidden-phase4|forbidden-fences|forbidden-new-migration' ${shellQuote(actions)}; then exit 95; fi

: > ${shellQuote(actions)}
present=0
state=
set +e
bootstrap_production_main > "$TM_REMOTE_ROOT/absent.out" 2> "$TM_REMOTE_ROOT/absent.err"
absent_status=$?
set -e
test "$absent_status" -ne 0
if grep -Eq 'forbidden-gen0|forbidden-new-migration' ${shellQuote(actions)}; then exit 96; fi
`)], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Lane A: stale artifact repair is recovered before capacity reservation and unknown evidence fails closed', {
  skip: !HAS_BASH
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-bootstrap-artifact-preflight-'));
  const actions = gitBashPath(path.join(root, 'actions'));
  try {
    const recovered = spawnSync(BASH, ['--noprofile', '--norc', '-c', bootstrapLibraryHarness(root, `
record_action() { printf '%s\n' "$1" >> ${shellQuote(actions)}; }
artifact_state=stale
require_root() { :; }
require_exact_host() { :; }
bootstrap_recover_stale_artifacts_before_reservation() {
  record_action repair-recovery
  artifact_state=clean
}
reserve_migration_journal_capacity() {
  record_action reserve
  test "$artifact_state" = clean || return 73
  JOURNAL_RESERVATION_MODE=general
}
bootstrap_terminal_journal_gate() { JOURNAL_PRESENT=0; JOURNAL_TERMINAL_STATE=; BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME=; }
external_layout_marker_state() { printf 'absent\n'; }
bootstrap_prepare_journal_run_identity() { BOOTSTRAP_OWNER_TOKEN=11111111111111111111111111111111; }
begin_migration_journal() { JOURNAL_PRESENT=1; JOURNAL_TERMINAL_STATE=live; JOURNAL_OWNER_TOKEN="$BOOTSTRAP_OWNER_TOKEN"; }
claim_live_journal_before_host_mutation() { :; }
bootstrap_prepare_control_plane() { return 79; }
bootstrap_arm_cleanup_recovery() { :; }

set +e
bootstrap_production_main
status=$?
set -e
test "$status" -eq 79
test "$(cat ${shellQuote(actions)})" = "repair-recovery
reserve"
`)], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);

    fs.rmSync(path.join(root, 'actions'), { force: true });
    const unknown = spawnSync(BASH, ['--noprofile', '--norc', '-c', bootstrapLibraryHarness(root, `
record_action() { printf '%s\n' "$1" >> ${shellQuote(actions)}; }
require_root() { :; }
require_exact_host() { :; }
bootstrap_arm_cleanup_recovery() { :; }
bootstrap_recover_stale_artifacts_before_reservation() { record_action unknown-artifact; return 74; }
reserve_migration_journal_capacity() { record_action forbidden-reserve; return 99; }
set +e
bootstrap_production_main
status=$?
set -e
test "$status" -eq 74
test "$(cat ${shellQuote(actions)})" = unknown-artifact
`)], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(unknown.status, 0, unknown.stderr || unknown.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Lane A AppSec: failed findmnt blocks reservation, release mutation, metadata changes, and host actions', {
  skip: !HAS_BASH
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-bootstrap-findmnt-failure-'));
  const statusPath = path.join(root, 'status');
  const stdoutPath = path.join(root, 'bootstrap.out');
  const stderrPath = path.join(root, 'bootstrap.err');
  const findmntCallsPath = path.join(root, 'findmnt-calls');
  const hostActionsPath = path.join(root, 'host-actions');
  const metadataActionsPath = path.join(root, 'metadata-actions');
  const metadataBeforePath = path.join(root, 'metadata-before');
  const metadataAfterPath = path.join(root, 'metadata-after');
  const releaseDirectory = path.join(root, 'remote', 'current-release');
  const retiredReleaseDirectory = `${releaseDirectory}.released`;
  const reservationPath = path.join(root, 'journal', '.reservation-proof');
  const metadataTarget = path.join(root, 'remote', 'metadata-target');
  try {
    const result = spawnSync(BASH, ['--noprofile', '--norc', '-c', bootstrapLibraryHarness(root, `
unset TM_TEST_GATE_MOUNTS
export TM_TEST_GATE_PROCESSES=
release_dir="$TM_REMOTE_ROOT/current-release"
retired_release="$release_dir.released"
reservation="$TM_JOURNAL_ROOT/.reservation-proof"
metadata_target="$TM_REMOTE_ROOT/metadata-target"
mkdir -m 0700 -p "$release_dir" "$TM_JOURNAL_ROOT"
printf 'release-must-survive\n' > "$release_dir/sentinel"
printf 'metadata-must-survive\n' > "$metadata_target"
command chmod 0640 "$metadata_target"
command stat -c '%u:%g:%a' "$metadata_target" > ${shellQuote(gitBashPath(metadataBeforePath))}

findmnt() {
  printf 'called\n' >> ${shellQuote(gitBashPath(findmntCallsPath))}
  printf '%s\n' 'sensitive-findmnt-stdout-must-not-leak'
  printf '%s\n' 'sensitive-findmnt-stderr-must-not-leak' >&2
  return 73
}
record_host_action() { printf '%s\n' "$1" >> ${shellQuote(gitBashPath(hostActionsPath))}; }
chown() { printf 'chown:%s\n' "$*" >> ${shellQuote(gitBashPath(metadataActionsPath))}; }
chmod() {
  printf 'chmod:%s\n' "$*" >> ${shellQuote(gitBashPath(metadataActionsPath))}
  command chmod "$@"
}

require_root() { :; }
require_exact_host() { :; }
bootstrap_terminal_journal_preflight() {
  BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME=
  JOURNAL_PRESENT=0
}
bootstrap_arm_cleanup_recovery() { :; }
bootstrap_recover_stale_artifacts_before_reservation() {
  record_host_action stale-artifact-recovery
  mv "$release_dir" "$retired_release"
}
reserve_migration_journal_capacity() {
  printf 'reserved\n' > "$reservation"
  JOURNAL_RESERVATION_MODE=general
}
bootstrap_terminal_journal_gate() {
  JOURNAL_PRESENT=0
  JOURNAL_TERMINAL_STATE=
  BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME=
}
external_layout_marker_state() { printf 'absent\n'; }
bootstrap_prepare_journal_run_identity() { BOOTSTRAP_OWNER_TOKEN=11111111111111111111111111111111; }
begin_migration_journal() {
  JOURNAL_PRESENT=1
  JOURNAL_TERMINAL_STATE=live
  JOURNAL_OWNER_TOKEN="$BOOTSTRAP_OWNER_TOKEN"
}
claim_live_journal_before_host_mutation() { record_host_action claim-live-journal; }
bootstrap_prepare_control_plane() {
  chown root:root "$metadata_target"
  chmod 0000 "$metadata_target"
}
validate_sanitizer_gate_idle_state() { :; }
bootstrap_recover_stale_control_state() { record_host_action stale-control-recovery; }
bootstrap_acquire_shared_fences() { record_host_action acquire-fences; return 97; }

set +e
bootstrap_production_main > ${shellQuote(gitBashPath(stdoutPath))} 2> ${shellQuote(gitBashPath(stderrPath))}
bootstrap_status=$?
set -e
printf '%s\n' "$bootstrap_status" > ${shellQuote(gitBashPath(statusPath))}
command stat -c '%u:%g:%a' "$metadata_target" > ${shellQuote(gitBashPath(metadataAfterPath))}
`)], { encoding: 'utf8', timeout: 20_000 });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.readFileSync(statusPath, 'utf8'), '1\n');
    assert.equal(fs.readFileSync(stdoutPath, 'utf8'), '');
    assert.equal(
      fs.readFileSync(stderrPath, 'utf8'),
      'Candidate mount verification failed: findmnt returned nonzero\n'
    );
    assert.doesNotMatch(
      `${fs.readFileSync(stdoutPath, 'utf8')}\n${fs.readFileSync(stderrPath, 'utf8')}`,
      /sensitive-findmnt/
    );
    assert.equal(fs.readFileSync(findmntCallsPath, 'utf8'), 'called\n');
    assert.equal(fs.existsSync(reservationPath), false, 'failed mount inspection must precede reservation');
    assert.equal(fs.existsSync(releaseDirectory), true, 'current release directory must not be renamed');
    assert.equal(fs.existsSync(retiredReleaseDirectory), false, 'no retired release directory may be published');
    assert.equal(fs.existsSync(hostActionsPath), false, 'failed inspection must precede every host action');
    assert.equal(fs.existsSync(metadataActionsPath), false, 'failed inspection must precede chown/chmod');
    assert.equal(
      fs.readFileSync(metadataAfterPath, 'utf8'),
      fs.readFileSync(metadataBeforePath, 'utf8'),
      'ownership and mode must remain unchanged'
    );
    assert.equal(fs.readFileSync(metadataTarget, 'utf8'), 'metadata-must-survive\n');
    assert.equal(fs.readFileSync(path.join(releaseDirectory, 'sentinel'), 'utf8'), 'release-must-survive\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Lane A AppSec: ACK with missing findmnt cannot reserve or mutate the terminal journal', {
  skip: !HAS_BASH
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-bootstrap-ack-findmnt-missing-'));
  const terminalId = `t1:${'a'.repeat(64)}`;
  const actions = gitBashPath(path.join(root, 'ack-actions'));
  const stdoutPath = gitBashPath(path.join(root, 'ack.out'));
  const stderrPath = gitBashPath(path.join(root, 'ack.err'));
  try {
    const result = spawnSync(BASH, ['--noprofile', '--norc', '-c', bootstrapLibraryHarness(root, `
unset TM_TEST_GATE_MOUNTS
record_action() { printf '%s\n' "$1" >> ${shellQuote(actions)}; }
require_root() { :; }
require_exact_host() { :; }
bootstrap_prepare_control_plane() { record_action control-lock; }
reserve_migration_journal_capacity() { record_action reserve; JOURNAL_RESERVATION_MODE=terminal-only; }
discover_migration_journal() {
  record_action discover
  JOURNAL_PRESENT=1
  JOURNAL_ENTRY_NAME=active
  JOURNAL_DIR_IDENTITY=j2:${'b'.repeat(64)}:31:41:51
  JOURNAL_TERMINAL_STATE=terminal-pending
  JOURNAL_TERMINAL_ID='${terminalId}'
  JOURNAL_HEAD_DIGEST=${'c'.repeat(64)}
  JOURNAL_MARKER_PROOF=absent
}
validate_terminal_journal_marker_provenance() { record_action provenance; }
bootstrap_ack_terminal_generation() { record_action ack-mutation; JOURNAL_TERMINAL_STATE=terminal-consumed; }

mkdir -m 0700 -p "$TM_REMOTE_ROOT/empty-path"
original_path="$PATH"
PATH="$TM_REMOTE_ROOT/empty-path"
set +e
bootstrap_ack_terminal_command '${terminalId}' > ${shellQuote(stdoutPath)} 2> ${shellQuote(stderrPath)}
ack_status=$?
set -e
PATH="$original_path"
test "$ack_status" -ne 0
test ! -e ${shellQuote(actions)}
test ! -s ${shellQuote(stdoutPath)}
test "$(cat ${shellQuote(stderrPath)})" = 'Candidate mount verification failed: findmnt returned nonzero'
`)], { encoding: 'utf8', timeout: 20_000 });

    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Lane A AppSec: ACK with failing findmnt redacts output and cannot reserve or mutate', {
  skip: !HAS_BASH
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-bootstrap-ack-findmnt-failing-'));
  const terminalId = `t1:${'d'.repeat(64)}`;
  const actions = gitBashPath(path.join(root, 'ack-actions'));
  const findmntCalls = gitBashPath(path.join(root, 'findmnt-calls'));
  const stdoutPath = gitBashPath(path.join(root, 'ack.out'));
  const stderrPath = gitBashPath(path.join(root, 'ack.err'));
  try {
    const result = spawnSync(BASH, ['--noprofile', '--norc', '-c', bootstrapLibraryHarness(root, `
unset TM_TEST_GATE_MOUNTS
findmnt() {
  printf 'called\n' >> ${shellQuote(findmntCalls)}
  printf '%s\n' sensitive-findmnt-stdout-must-not-leak
  printf '%s\n' sensitive-findmnt-stderr-must-not-leak >&2
  return 73
}
record_action() { printf '%s\n' "$1" >> ${shellQuote(actions)}; }
require_root() { :; }
require_exact_host() { :; }
bootstrap_prepare_control_plane() { record_action control-lock; }
reserve_migration_journal_capacity() { record_action reserve; JOURNAL_RESERVATION_MODE=terminal-only; }
discover_migration_journal() {
  record_action discover
  JOURNAL_PRESENT=1
  JOURNAL_ENTRY_NAME=active
  JOURNAL_DIR_IDENTITY=j2:${'e'.repeat(64)}:31:41:51
  JOURNAL_TERMINAL_STATE=terminal-pending
  JOURNAL_TERMINAL_ID='${terminalId}'
  JOURNAL_HEAD_DIGEST=${'f'.repeat(64)}
  JOURNAL_MARKER_PROOF=absent
}
validate_terminal_journal_marker_provenance() { record_action provenance; }
bootstrap_ack_terminal_generation() { record_action ack-mutation; JOURNAL_TERMINAL_STATE=terminal-consumed; }

set +e
bootstrap_ack_terminal_command '${terminalId}' > ${shellQuote(stdoutPath)} 2> ${shellQuote(stderrPath)}
ack_status=$?
set -e
test "$ack_status" -ne 0
test ! -e ${shellQuote(actions)}
test ! -s ${shellQuote(stdoutPath)}
test "$(cat ${shellQuote(stderrPath)})" = 'Candidate mount verification failed: findmnt returned nonzero'
test "$(cat ${shellQuote(findmntCalls)})" = called
if grep -Fq sensitive-findmnt ${shellQuote(stdoutPath)} ${shellQuote(stderrPath)}; then exit 91; fi
`)], { encoding: 'utf8', timeout: 20_000 });

    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Lane A AppSec: mount introduced before the shared lock is rejected by the fenced recheck', {
  skip: !HAS_BASH
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-bootstrap-fenced-mount-race-'));
  const actions = gitBashPath(path.join(root, 'actions'));
  const calls = gitBashPath(path.join(root, 'findmnt-calls'));
  const firstInspection = gitBashPath(path.join(root, 'first-inspection'));
  const stdoutPath = gitBashPath(path.join(root, 'main.out'));
  const stderrPath = gitBashPath(path.join(root, 'main.err'));
  try {
    const result = spawnSync(BASH, ['--noprofile', '--norc', '-c', bootstrapLibraryHarness(root, `
unset TM_TEST_GATE_MOUNTS
findmnt() {
  if [ -e ${shellQuote(firstInspection)} ]; then
    printf 'under-lock\n' >> ${shellQuote(calls)}
    printf '%s\n' "$GATE_ROOT/releases/raced"
  else
    : > ${shellQuote(firstInspection)}
    printf 'initial\n' >> ${shellQuote(calls)}
  fi
}
record_action() { printf '%s\n' "$1" >> ${shellQuote(actions)}; }
require_root() { :; }
require_exact_host() { :; }
bootstrap_terminal_journal_preflight() {
  BOOTSTRAP_TERMINAL_JOURNAL_OUTCOME=
  JOURNAL_PRESENT=0
  JOURNAL_TERMINAL_STATE=
}
bootstrap_acquire_preprovisioned_control_locks() { record_action control-lock-held; }
bootstrap_arm_cleanup_recovery() { record_action forbidden-arm; }
bootstrap_recover_stale_artifacts_before_reservation() { record_action forbidden-stale-recovery; }
reserve_migration_journal_capacity() { record_action forbidden-reserve; return 88; }

set +e
bootstrap_production_main > ${shellQuote(stdoutPath)} 2> ${shellQuote(stderrPath)}
main_status=$?
set -e
test "$main_status" -eq 1
test "$(cat ${shellQuote(calls)})" = "initial
under-lock"
test "$(cat ${shellQuote(actions)})" = control-lock-held
test ! -s ${shellQuote(stdoutPath)}
test "$(cat ${shellQuote(stderrPath)})" = "Candidate gate mount is still active: $GATE_ROOT/releases/raced"
`)], { encoding: 'utf8', timeout: 20_000 });

    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Lane A AppSec: stale repair phases complete missing hardening and health before reservation', {
  skip: !HAS_BASH
}, () => {
  const fixtures = [
    {
      phase: 'repair-created',
      service: 'stopped',
      apparmor: 'absent',
      firewall: 'absent',
      health: 'down',
      expected: [
        'stop', 'phase:repair-stopped', 'apparmor', 'phase:repair-apparmor',
        'firewall', 'phase:repair-firewall', 'restart', 'phase:repair-restarted',
        'firewall-check', 'health', 'listener', 'phase:repair-validated', 'delete', 'reserve'
      ]
    },
    {
      phase: 'repair-stopped',
      service: 'stopped',
      apparmor: 'absent',
      firewall: 'absent',
      health: 'down',
      expected: [
        'apparmor', 'phase:repair-apparmor', 'firewall', 'phase:repair-firewall',
        'restart', 'phase:repair-restarted', 'firewall-check', 'health', 'listener',
        'phase:repair-validated', 'delete', 'reserve'
      ]
    },
    {
      phase: 'repair-apparmor',
      service: 'stopped',
      apparmor: 'ready',
      firewall: 'absent',
      health: 'down',
      expected: [
        'firewall', 'phase:repair-firewall', 'restart', 'phase:repair-restarted',
        'firewall-check', 'health', 'listener', 'phase:repair-validated', 'delete', 'reserve'
      ]
    },
    {
      phase: 'repair-firewall',
      service: 'stopped',
      apparmor: 'ready',
      firewall: 'ready',
      health: 'down',
      expected: [
        'restart', 'phase:repair-restarted', 'firewall-check', 'health', 'listener',
        'phase:repair-validated', 'delete', 'reserve'
      ]
    },
    {
      phase: 'repair-restarted',
      service: 'running',
      apparmor: 'ready',
      firewall: 'ready',
      health: 'ready',
      expected: ['firewall-check', 'health', 'listener', 'phase:repair-validated', 'delete', 'reserve']
    },
    {
      phase: 'repair-validated',
      service: 'running',
      apparmor: 'ready',
      firewall: 'ready',
      health: 'ready',
      expected: ['firewall-check', 'health', 'listener', 'delete', 'reserve']
    }
  ];

  for (const fixture of fixtures) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `tm-bootstrap-repair-${fixture.phase}-`));
    const actions = gitBashPath(path.join(root, 'actions'));
    try {
      const result = spawnSync(BASH, ['--noprofile', '--norc', '-c', bootstrapLibraryHarness(root, `
old_owner=11111111111111111111111111111111
new_owner=22222222222222222222222222222222
repair="$JOURNAL_ROOT/artifact-repair-$old_owner"
mkdir -m 0700 -p "$TM_REMOTE_ROOT" "$JOURNAL_ROOT"
mkdir -m 0700 -p "$repair/work"
printf '%s\n' "$old_owner" > "$repair/owner"
printf '%s\n' ${shellQuote(fixture.phase)} > "$repair/phase"
printf '%s\n' ${shellQuote(fixture.service)} > "$TM_REMOTE_ROOT/service-state"
printf '%s\n' ${shellQuote(fixture.apparmor)} > "$TM_REMOTE_ROOT/apparmor-state"
printf '%s\n' ${shellQuote(fixture.firewall)} > "$TM_REMOTE_ROOT/firewall-state"
printf '%s\n' ${shellQuote(fixture.health)} > "$TM_REMOTE_ROOT/health-state"
record_action() { printf '%s\n' "$1" >> ${shellQuote(actions)}; }

require_root() { :; }
require_exact_host() { :; }
bootstrap_arm_cleanup_recovery() { :; }
bootstrap_prepare_journal_run_identity() { BOOTSTRAP_OWNER_TOKEN="$new_owner"; }
bootstrap_prepare_control_plane() { :; }
bootstrap_ensure_process_identity() { :; }
validate_sanitizer_gate_idle_state() { :; }
bootstrap_resume_generation_deletions() { :; }
sync_directory() { :; }
bootstrap_test_sigkill() { :; }
bootstrap_validate_anchored_path() { test "$2" = "artifact-repair-$old_owner/work"; }
bootstrap_validate_generation() {
  test "$2" = artifact-repair
  test "$3" = "$old_owner"
  test -d "$1"
  BOOTSTRAP_VALIDATED_OWNER="$old_owner"
  BOOTSTRAP_VALIDATED_RUN_TOKEN=33333333333333333333333333333333
  BOOTSTRAP_VALIDATED_PHASE="$(cat "$1/phase")"
}
bootstrap_generation_owner_state() { printf 'stale\n'; }
bootstrap_set_generation_phase() {
  test "$BOOTSTRAP_OWNER_TOKEN" = "$old_owner"
  test "$1" = "$repair"
  printf '%s\n' "$3" > "$1/phase"
  record_action "phase:$3"
}
stop_current_release() {
  record_action stop
  printf 'stopped\n' > "$TM_REMOTE_ROOT/service-state"
  printf 'down\n' > "$TM_REMOTE_ROOT/health-state"
}
install_apparmor_profile() {
  test "$(cat "$TM_REMOTE_ROOT/service-state")" = stopped
  record_action apparmor
  printf 'ready\n' > "$TM_REMOTE_ROOT/apparmor-state"
}
install_loopback_firewall() {
  test "$(cat "$TM_REMOTE_ROOT/apparmor-state")" = ready
  record_action firewall
  printf 'ready\n' > "$TM_REMOTE_ROOT/firewall-state"
}
restart_current_release() {
  test "$(cat "$TM_REMOTE_ROOT/firewall-state")" = ready
  record_action restart
  printf 'running\n' > "$TM_REMOTE_ROOT/service-state"
  printf 'ready\n' > "$TM_REMOTE_ROOT/health-state"
}
validate_loopback_firewall() {
  record_action firewall-check
  test "$(cat "$TM_REMOTE_ROOT/firewall-state")" = ready
}
validate_current_release_health() {
  record_action health
  test "$(cat "$TM_REMOTE_ROOT/health-state")" = ready || return 1
  validate_loopback_listener
}
validate_loopback_listener() {
  record_action listener
  test "$(cat "$TM_REMOTE_ROOT/service-state")" = running
}
bootstrap_delete_artifact_generation() {
  record_action delete
  test "$(cat "$TM_REMOTE_ROOT/service-state")" = running
  test "$(cat "$TM_REMOTE_ROOT/apparmor-state")" = ready
  test "$(cat "$TM_REMOTE_ROOT/firewall-state")" = ready
  test "$(cat "$TM_REMOTE_ROOT/health-state")" = ready
  rm -rf -- "$1"
}
reserve_migration_journal_capacity() {
  record_action reserve
  test ! -e "$repair"
  test "$(cat "$TM_REMOTE_ROOT/service-state")" = running
  return 86
}

set +e
bootstrap_production_main
status=$?
set -e
if [ "$status" -ne 86 ] || [ "$(cat ${shellQuote(actions)} 2>/dev/null || true)" != ${shellQuote(fixture.expected.join('\n'))} ]; then
  printf 'status=%s phase=%s actions=%s\n' \
    "$status" "$(cat "$repair/phase" 2>/dev/null || printf missing)" \
    "$(tr '\n' ',' < ${shellQuote(actions)} 2>/dev/null || true)" >&2
  exit 1
fi
`)], { encoding: 'utf8', timeout: 20_000 });
      assert.equal(result.status, 0, `${fixture.phase}: ${result.stderr || result.stdout}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('Lane A AppSec: failed stale repair retains phase evidence before reservation', {
  skip: !HAS_BASH
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-bootstrap-repair-failure-'));
  const actions = gitBashPath(path.join(root, 'actions'));
  try {
    const result = spawnSync(BASH, ['--noprofile', '--norc', '-c', bootstrapLibraryHarness(root, `
old_owner=44444444444444444444444444444444
new_owner=55555555555555555555555555555555
repair="$JOURNAL_ROOT/artifact-repair-$old_owner"
mkdir -m 0700 -p "$TM_REMOTE_ROOT" "$JOURNAL_ROOT"
mkdir -m 0700 -p "$repair/work"
printf '%s\n' "$old_owner" > "$repair/owner"
printf 'repair-stopped\n' > "$repair/phase"
record_action() { printf '%s\n' "$1" >> ${shellQuote(actions)}; }
require_root() { :; }
require_exact_host() { :; }
bootstrap_arm_cleanup_recovery() { :; }
bootstrap_prepare_journal_run_identity() { BOOTSTRAP_OWNER_TOKEN="$new_owner"; }
bootstrap_prepare_control_plane() { :; }
bootstrap_ensure_process_identity() { :; }
validate_sanitizer_gate_idle_state() { :; }
bootstrap_resume_generation_deletions() { :; }
sync_directory() { :; }
bootstrap_test_sigkill() { :; }
bootstrap_validate_anchored_path() { :; }
bootstrap_validate_generation() {
  BOOTSTRAP_VALIDATED_OWNER="$old_owner"
  BOOTSTRAP_VALIDATED_RUN_TOKEN=66666666666666666666666666666666
  BOOTSTRAP_VALIDATED_PHASE="$(cat "$1/phase")"
}
bootstrap_generation_owner_state() { printf 'stale\n'; }
bootstrap_set_generation_phase() {
  printf '%s\n' "$3" > "$1/phase"
  record_action "phase:$3"
}
install_apparmor_profile() { record_action apparmor; }
install_loopback_firewall() { record_action firewall; return 75; }
bootstrap_delete_artifact_generation() { record_action forbidden-delete; return 97; }
reserve_migration_journal_capacity() { record_action forbidden-reserve; return 98; }

set +e
bootstrap_production_main
status=$?
set -e
if [ "$status" -ne 1 ] || [ ! -d "$repair" ] || \
   [ "$(cat "$repair/phase" 2>/dev/null || true)" != repair-apparmor ] || \
   [ "$(cat ${shellQuote(actions)} 2>/dev/null || true)" != "apparmor
phase:repair-apparmor
firewall" ]; then
  printf 'status=%s phase=%s actions=%s entries=%s\n' \
    "$status" "$(cat "$repair/phase" 2>/dev/null || printf missing)" \
    "$(tr '\n' ',' < ${shellQuote(actions)} 2>/dev/null || true)" \
    "$(find "$JOURNAL_ROOT" -mindepth 1 -maxdepth 1 -printf '%f,' 2>/dev/null || true)" >&2
  exit 1
fi
`)], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Lane A AppSec: hidden artifact builds block identity and reservation while preserving evidence', {
  skip: !HAS_BASH
}, () => {
  const fixtures = [
    { name: `.artifact-repair-build-${'7'.repeat(32)}`, extra: '' },
    { name: `.artifact-repair-build-${'8'.repeat(32)}`, extra: 'touch "$stage/unknown-member"' },
    { name: '.artifact-repair-build-unknown', extra: '' }
  ];
  for (const fixture of fixtures) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-bootstrap-hidden-repair-'));
    const actions = gitBashPath(path.join(root, 'actions'));
    try {
      const result = spawnSync(BASH, ['--noprofile', '--norc', '-c', bootstrapLibraryHarness(root, `
stage="$JOURNAL_ROOT/${fixture.name}"
mkdir -m 0700 -p "$TM_REMOTE_ROOT" "$JOURNAL_ROOT"
mkdir -m 0700 -p "$stage/work"
printf '%s\n' '{"schemaVersion":2,"operation":"bootstrap","kind":"artifact-repair","ownerToken":"77777777777777777777777777777777","runToken":"77777777777777777777777777777777","pid":99,"bootId":"11111111-1111-4111-8111-111111111111","startTimeTicks":"1","executable":"/bin/bash","recoveryGeneration":0}' > "$stage/run.json"
printf '%s\n' 77777777777777777777777777777777 > "$stage/owner"
printf '%s\n' repair-created > "$stage/phase"
chmod 0600 "$stage/run.json" "$stage/owner" "$stage/phase"
${fixture.extra}
require_root() { :; }
require_exact_host() { :; }
bootstrap_prepare_journal_run_identity() { printf 'forbidden-identity\n' >> ${shellQuote(actions)}; return 91; }
reserve_migration_journal_capacity() { printf 'forbidden-reserve\n' >> ${shellQuote(actions)}; return 82; }

set +e
bootstrap_production_main 2> "$TM_REMOTE_ROOT/hidden.err"
status=$?
set -e
test "$status" -ne 0
test "$status" -ne 82
test ! -e ${shellQuote(actions)}
test -d "$stage"
`)], { encoding: 'utf8', timeout: 20_000 });
      assert.equal(result.status, 0, `${fixture.name}: ${result.stderr || result.stdout}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('Lane A: legacy committed ACK rejects unproven layout and approves only fully proven runtime state', {
  skip: !HAS_BASH
}, () => {
  for (const layoutReady of [false, true]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `tm-bootstrap-legacy-ack-${layoutReady ? 'allow' : 'deny'}-`));
    const actions = gitBashPath(path.join(root, 'actions'));
    const exactTerminalId = `t1:${(layoutReady ? '7' : '6').repeat(64)}`;
    try {
      const result = spawnSync(BASH, ['--noprofile', '--norc', '-c', bootstrapLibraryHarness(root, `
record_action() { printf '%s\n' "$1" >> ${shellQuote(actions)}; }
layout_ready=${layoutReady ? 1 : 0}
marker_present=0
require_root() { :; }
require_exact_host() { :; }
reserve_migration_journal_capacity() { JOURNAL_RESERVATION_MODE=terminal-only; }
discover_migration_journal() {
  JOURNAL_PRESENT=1
  JOURNAL_ENTRY_NAME=active
  JOURNAL_DIR_IDENTITY=j2:${'a'.repeat(64)}:31:41:51
  JOURNAL_TERMINAL_STATE=terminal-pending
  JOURNAL_TERMINAL_ID='${exactTerminalId}'
  JOURNAL_HEAD_DIGEST=${'b'.repeat(64)}
}
read_journal() {
  JOURNAL_PRESENT=1
  JOURNAL_LEGACY_TEST=1
  JOURNAL_PHASE=committed
  JOURNAL_TERMINAL_STATE=terminal-pending
  JOURNAL_TERMINAL_ID='${exactTerminalId}'
  JOURNAL_HEAD_DIGEST=${'b'.repeat(64)}
  JOURNAL_MARKER_PROOF=absent
  JOURNAL_BACKUP_DIR="$BACKUP_ROOT/v030-runtime-bootstrap-20260802-120001"
}
external_layout_marker_state() { if [ "$marker_present" = 1 ]; then printf 'valid\n'; else printf 'absent\n'; fi; }
validate_exact_link() { record_action link; [ "$layout_ready" = 1 ]; }
validate_external_runtime() { record_action runtime; [ "$layout_ready" = 1 ]; }
database_quick_check() { record_action sqlite; [ "$layout_ready" = 1 ]; }
commit_external_layout_marker() {
  record_action marker-publish
  marker_present=1
  EXTERNAL_LAYOUT_MARKER_PROOF='m2:${'c'.repeat(64)}:11:12:${'d'.repeat(64)}'
}
validate_external_layout_marker() {
  [ "$marker_present" = 1 ] || return 71
  record_action marker-validate
  EXTERNAL_LAYOUT_MARKER_PROOF='m2:${'c'.repeat(64)}:11:12:${'d'.repeat(64)}'
}
bootstrap_ack_terminal_generation() { record_action ack; JOURNAL_TERMINAL_STATE=terminal-consumed; }

set +e
bootstrap_ack_terminal_command '${exactTerminalId}'
status=$?
set -e
if [ "$layout_ready" = 0 ]; then
  test "$status" -ne 0
  grep -Fxq link ${shellQuote(actions)}
  if grep -Eq 'marker-publish|marker-validate|ack' ${shellQuote(actions)}; then exit 91; fi
else
  test "$status" -eq 0
  test "$(grep -c '^link$' ${shellQuote(actions)})" -eq 4
  test "$(grep -c '^runtime$' ${shellQuote(actions)})" -eq 1
  test "$(grep -c '^sqlite$' ${shellQuote(actions)})" -eq 1
  grep -Fxq marker-publish ${shellQuote(actions)}
  grep -Fxq ack ${shellQuote(actions)}
  test "$(sed -n '/sqlite/=' ${shellQuote(actions)})" -lt "$(sed -n '/marker-publish/=' ${shellQuote(actions)})"
fi
`)], { encoding: 'utf8', timeout: 20_000 });
      assert.equal(result.status, 0, `${layoutReady ? 'approved' : 'rejected'}: ${result.stderr || result.stdout}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('Lane A AppSec: firewall cleanup delegates both trees to fixed no-follow deletion instead of recursive rm', {
  skip: !HAS_BASH
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-bootstrap-firewall-cleanup-'));
  const actions = gitBashPath(path.join(root, 'actions'));
  try {
    const result = spawnSync(BASH, ['--noprofile', '--norc', '-c', bootstrapLibraryHarness(root, `
record_action() { printf '%s\n' "$1" >> ${shellQuote(actions)}; }
rm() { record_action unsafe-rm; return 78; }
bootstrap_remove_anchored_fixed_tree() {
  record_action "safe-remove:$2"
  return 77
}

test_root="\${TM_REMOTE_ROOT%/remote}"
transaction="$test_root/backup/loopback-firewall-install"
mkdir -m 0700 -p "$transaction"
set +e
write_loopback_firewall_candidates "$transaction/candidate"
candidate_status=$?
set -e
test "$candidate_status" -eq 1

NFT_BIN="$test_root/nft"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$NFT_BIN"
chmod 0700 "$NFT_BIN"
systemctl() { :; }
ss() { :; }
BACKUP_DIR="$test_root/backup"
mkdir -m 0700 -p "$BACKUP_DIR"
set +e
install_loopback_firewall
transaction_status=$?
set -e
test "$transaction_status" -eq 1
test "$(cat ${shellQuote(actions)})" = "safe-remove:candidate
safe-remove:loopback-firewall-install"
`)], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const lockRace of [
  { label: 'descriptor 8', hook: 'unlink-operation', target: 'operation' },
  { label: 'descriptor 9', hook: 'unlink-sanitizer', target: 'sanitizer' },
  { label: 'descriptor 8 replacement', hook: 'replace-operation', target: 'replacement' },
  { label: 'descriptor 8 post-open replacement', hook: 'replace-operation-after-open', target: 'replacement' },
  { label: 'descriptor 9 post-open replacement', hook: 'replace-sanitizer-after-open', target: 'sanitizer-replacement' },
  { label: 'operation parent replacement', hook: 'replace-operation-parent', target: 'parent-replacement' }
]) {
  test(`Lane A AppSec: ${lockRace.label} lock opening is no-create and identity-bound`, {
    skip: !HAS_BASH
  }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `tm-bootstrap-lock-${lockRace.hook}-`));
    try {
      const result = spawnSync(BASH, ['--noprofile', '--norc', '-c', bootstrapLibraryHarness(root, `
test_root="\${TM_REMOTE_ROOT%/remote}"
mkdir -m 0700 -p "$TM_REMOTE_ROOT" "$test_root/run"
SANITIZER_LIFECYCLE_FENCE="$test_root/run/sanitizer.lock"
: > "$OPERATION_FENCE"
: > "$SANITIZER_LIFECYCLE_FENCE"
printf '%s\n' original-operation > "$OPERATION_FENCE"
printf '%s\n' original-sanitizer > "$SANITIZER_LIFECYCLE_FENCE"
chmod 0600 "$OPERATION_FENCE" "$SANITIZER_LIFECYCLE_FENCE"
stat() {
  case "$*" in
    *%U:%G:%a:%h*) printf '%s\n' root:root:600:1 ;;
    *%U:%G*) printf '%s\n' root:root ;;
    *%d:%i*) printf '%s\n' 1:1 ;;
    *) command stat "$@" ;;
  esac
}
realpath() { printf '%s\n' "\${!#}"; }
readlink() {
  case "\${!#}" in
    */fd/8) printf '%s\n' "$OPERATION_FENCE" ;;
    */fd/9) printf '%s\n' "$SANITIZER_LIFECYCLE_FENCE" ;;
    *) return 1 ;;
  esac
}
bootstrap_trusted_flock() { :; }
export TM_BOOTSTRAP_TEST_CONTROL_LOCK_RACE=${shellQuote(lockRace.hook)}

set +e
bootstrap_acquire_preprovisioned_control_locks
lock_status=$?
set -e
if [ "$lock_status" -eq 0 ]; then
  printf '%s\n' ${shellQuote(`${lockRace.label} unlink or substitution race was accepted`)} >&2
  exit 97
fi
case ${shellQuote(lockRace.target)} in
  operation) test ! -e "$OPERATION_FENCE" ;;
  sanitizer) test ! -e "$SANITIZER_LIFECYCLE_FENCE" ;;
  replacement)
    test "$(cat "$OPERATION_FENCE")" = foreign-operation-lock
    ;;
  sanitizer-replacement)
    test "$(cat "$SANITIZER_LIFECYCLE_FENCE")" = foreign-sanitizer-lock
    ;;
  parent-replacement)
    test "$(cat "$OPERATION_FENCE")" = original-operation
    test -d "$TM_REMOTE_ROOT.lock-parent-retired"
    ;;
esac
`)], { encoding: 'utf8', timeout: 20_000 });

      assert.equal(result.status, 0, `${lockRace.label}: ${result.stderr || result.stdout}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('Lane A AppSec: subshell lock acquisition binds descriptors to BASHPID', {
  skip: !HAS_BASH
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-bootstrap-lock-bashpid-'));
  try {
    const result = spawnSync(BASH, ['--noprofile', '--norc', '-c', bootstrapLibraryHarness(root, `
test_root="\${TM_REMOTE_ROOT%/remote}"
mkdir -m 0700 -p "$TM_REMOTE_ROOT" "$test_root/run"
SANITIZER_LIFECYCLE_FENCE="$test_root/run/sanitizer.lock"
: > "$OPERATION_FENCE"
: > "$SANITIZER_LIFECYCLE_FENCE"
chmod 0600 "$OPERATION_FENCE" "$SANITIZER_LIFECYCLE_FENCE"
bootstrap_trusted_flock() { :; }

(
  bootstrap_acquire_preprovisioned_control_locks
  test "$BOOTSTRAP_CONTROL_LOCKS_HELD" = 1
  assert_retained_lock_parent_fd 5 "$TM_REMOTE_ROOT" \
    'Deployment operation fence' "$BOOTSTRAP_OPERATION_LOCK_PARENT_IDENTITY"
)
`)], { encoding: 'utf8', timeout: 20_000 });

    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Lane A AppSec: control-lock parents must have trusted ownership and mode', {
  skip: process.platform !== 'linux'
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-bootstrap-lock-parent-'));
  try {
    const result = spawnSync(BASH, ['--noprofile', '--norc', '-c', bootstrapLibraryHarness(root, `
test_root="\${TM_REMOTE_ROOT%/remote}"
mkdir -m 0700 -p "$TM_REMOTE_ROOT" "$test_root/run"
SANITIZER_LIFECYCLE_FENCE="$test_root/run/sanitizer.lock"
: > "$OPERATION_FENCE"
: > "$SANITIZER_LIFECYCLE_FENCE"
chmod 0600 "$OPERATION_FENCE" "$SANITIZER_LIFECYCLE_FENCE"
chmod 0777 "$TM_REMOTE_ROOT"
shadow_log="$test_root/shadow-log"
stat() {
  case "$*" in
    *%U:%G:%a:%h*) printf '%s\n' root:root:600:1 ;;
    *%U:%G*) printf '%s\n' root:root ;;
    *%d:%i*) printf '%s\n' 1:1 ;;
    *) command stat "$@" ;;
  esac
}
realpath() { printf '%s\n' "\${!#}"; }
readlink() {
  case "\${!#}" in
    */fd/8) printf '%s\n' "$OPERATION_FENCE" ;;
    */fd/9) printf '%s\n' "$SANITIZER_LIFECYCLE_FENCE" ;;
    *) return 1 ;;
  esac
}
flock() { printf '%s\n' shadow-flock >> "$shadow_log"; }

set +e
bootstrap_acquire_preprovisioned_control_locks
lock_status=$?
set -e
if [ "$lock_status" -eq 0 ]; then
  printf '%s\n' 'world-writable control-lock parent was accepted' >&2
  exit 96
fi
test ! -e "$shadow_log"
`)], { encoding: 'utf8', timeout: 20_000 });

    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sanitizer and bootstrap retain verified lifecycle lock descriptors and reject marker bypass', () => {
  const sanitizerSource = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'sanitize_production_shape.js'),
    'utf8'
  );
  const bootstrapSource = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'bootstrap_production_runtime.sh'),
    'utf8'
  );
  const expectedFence = '/run/turingmarket-sanitizer-bootstrap.lock';
  assert.equal(sanitizer.DEFAULT_LIFECYCLE_FENCE_PATH, expectedFence);
  assert.equal(sanitizer.DEFAULT_LIFECYCLE_FENCE_FD, 9);
  assert.match(bootstrapSource, /SANITIZER_LIFECYCLE_FENCE=.*\/run\/turingmarket-sanitizer-bootstrap\.lock/);
  assert.doesNotMatch(sanitizerSource, /TM_SANITIZER_LIFECYCLE_FENCED|buildProductionLifecycleFenceLaunch/);
  assert.doesNotMatch(bootstrapSource, /TM_BOOTSTRAP_FENCED|flock\s+-n\s+-o/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-lifecycle-marker-bypass-'));
  const fencePath = path.join(root, 'shared.lock');
  try {
    assert.throws(() => sanitizer._testing.acquireProductionLifecycleFence({
      fencePath,
      requireRoot: false,
      env: { TM_SANITIZER_LIFECYCLE_FENCED: '1' },
      spawnSyncImpl() {
        return { status: 1, signal: null, error: undefined, stderr: 'contended' };
      }
    }), (error) => error.code === 'TM_SANITIZER_LIFECYCLE_FENCE_BUSY');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  const coordinator = sanitizerSource.slice(
    sanitizerSource.indexOf('async function runProductionCoordinator('),
    sanitizerSource.indexOf('function journalController(')
  );
  assert.match(coordinator, /acquireProductionLifecycleFence/);
  assert.match(coordinator, /lifecycleFence\.release\(\)/);

  const prepareStart = bootstrapSource.indexOf('bootstrap_prepare_control_plane() {');
  const prepareEnd = bootstrapSource.indexOf('\n}\n\nbootstrap_run_new_migration()', prepareStart);
  const mainStart = bootstrapSource.indexOf('bootstrap_production_main() {');
  const mainEnd = bootstrapSource.indexOf('\n}\n\nif [ "${TM_BOOTSTRAP_LIBRARY_ONLY', mainStart);
  assert.ok(prepareStart >= 0 && prepareEnd > prepareStart, 'control-plane preparation must be bounded');
  assert.ok(mainStart >= 0 && mainEnd > mainStart, 'production main must be bounded');
  const fencedMain = `${bootstrapSource.slice(prepareStart, prepareEnd)}\n${bootstrapSource.slice(mainStart, mainEnd)}`;
  assert.match(fencedMain, /exec 5<"\$operation_parent"/);
  assert.match(fencedMain, /exec 6<"\$sanitizer_parent"/);
  assert.match(fencedMain, /exec 8<"\/proc\/\$BASHPID\/fd\/5\/\$operation_name"/);
  assert.match(fencedMain, /exec 9<"\/proc\/\$BASHPID\/fd\/6\/\$sanitizer_name"/);
  assert.doesNotMatch(fencedMain, /exec [5-9]<>/);
  assert.match(fencedMain, /bootstrap_preprovisioned_lock_identity/);
  assert.match(fencedMain, /bootstrap_validate_trusted_lock_parent/);
  assert.match(fencedMain, /bootstrap_trusted_flock -n 8/);
  const sharedFlock = 'bootstrap_trusted_flock -n 9';
  assert.ok(fencedMain.indexOf(sharedFlock) >= 0, 'bootstrap must lock its retained sanitizer fence descriptor');
  assert.ok(
    fencedMain.indexOf(sharedFlock) < fencedMain.indexOf('validate_sanitizer_gate_idle_state'),
    'the shared fence must be held before sanitizer-state validation and lifecycle mutation'
  );

  const rollback = bootstrapSource.slice(
    bootstrapSource.indexOf('restore_runtime_snapshot()'),
    bootstrapSource.indexOf('recover_interrupted_migration()')
  );
  assert.doesNotMatch(rollback, /stop_current_release[^\n]*\|\|\s*true/);
  assert.match(rollback, /stop_current_release[^\n]*\|\|\s*return 1/);

  const restart = bootstrapSource.slice(
    bootstrapSource.indexOf('restart_current_release()'),
    bootstrapSource.indexOf('database_backup()')
  );
  assert.match(restart, /run_persistent_runtime_command pm2 restart/);
  assert.match(restart, /run_persistent_runtime_command pm2 start/);
  assert.match(bootstrapSource, /run_persistent_runtime_command\(\)[\s\S]*"\$@" 5>&- 6>&- 7>&- 8>&- 9>&-/);

  if (HAS_BASH) {
    const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-bootstrap-runtime-fd-probe-'));
    const probeFence = gitBashPath(path.join(probeRoot, 'probe.lock'));
    try {
      const result = spawnSync(BASH, ['--noprofile', '--norc', '-c', [
        'set -euo pipefail',
        'PATH=/usr/bin:/bin:$PATH',
        'export PATH',
        'export TM_BOOTSTRAP_LIBRARY_ONLY=1',
        `source ${shellQuote(gitBashPath(path.join(__dirname, '..', 'scripts', 'bootstrap_production_runtime.sh')))}`,
        `exec 5<>${shellQuote(`${probeFence}.5`)}`,
        `exec 6<>${shellQuote(`${probeFence}.6`)}`,
        `exec 7<>${shellQuote(`${probeFence}.7`)}`,
        `exec 8<>${shellQuote(`${probeFence}.8`)}`,
        `exec 9<>${shellQuote(`${probeFence}.9`)}`,
        `run_persistent_runtime_command ${shellQuote(gitBashPath(process.execPath))} -e ${shellQuote("const fs=require('node:fs');for(const fd of [5,6,7,8,9]){try{fs.fstatSync(fd);process.exit(90+fd)}catch(e){if(e.code!=='EBADF')process.exit(100+fd)}}")}`
      ].join('; ')], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    } finally {
      fs.rmSync(probeRoot, { recursive: true, force: true });
    }
  }
});

test('Linux lifecycle fence rejects a real competing mutator', {
  skip: !HAS_NATIVE_FLOCK,
  timeout: 15_000
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-real-lifecycle-contention-'));
  fs.chmodSync(root, 0o700);
  const fencePath = path.join(root, 'shared.lock');
  const holder = spawn(process.execPath, ['-e', lifecycleFenceHolderProgram(), fencePath], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    await waitForChildOutput(holder, /LOCKED \d+/);
    const contender = runLifecycleFenceContender(fencePath);
    assert.equal(contender.status, 23, contender.stderr);
    assert.match(contender.stderr, /TM_SANITIZER_LIFECYCLE_FENCE_BUSY/);
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGTERM');
    await new Promise((resolve) => holder.once('exit', resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Linux mutating child retains lifecycle fence after its wrapper is SIGKILLed', {
  skip: !HAS_NATIVE_FLOCK,
  timeout: 20_000
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-real-lifecycle-wrapper-kill-'));
  fs.chmodSync(root, 0o700);
  const fencePath = path.join(root, 'shared.lock');
  const wrapperProgram = `
    const { spawn } = require('node:child_process');
    const sanitizer = require(${JSON.stringify(path.join(__dirname, '..', 'scripts', 'sanitize_production_shape.js'))});
    const lease = sanitizer._testing.acquireProductionLifecycleFence({
      fencePath: process.argv[1],
      requireRoot: false
    });
    const childStdio = ['ignore', 'inherit', 'inherit'];
    while (childStdio.length <= 9) childStdio.push('ignore');
    childStdio[9] = lease.fd;
    const child = spawn(process.execPath, [
      '-e', ${JSON.stringify(lifecycleFenceAdopterProgram())}, lease.device, lease.inode
    ], { stdio: childStdio });
    process.stdout.write('WRAPPER_LOCKED ' + process.pid + ' MUTATOR ' + child.pid + '\\n');
    setInterval(() => {}, 1000);
  `;
  const wrapper = spawn(process.execPath, ['-e', wrapperProgram, fencePath], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let mutatorPid = null;
  let proofComplete = false;
  try {
    const output = await waitForChildOutput(wrapper, /(?=[\s\S]*WRAPPER_LOCKED \d+ MUTATOR \d+)(?=[\s\S]*ADOPTED \d+)/);
    mutatorPid = Number(output.match(/MUTATOR (\d+)/)[1]);
    const wrapperExit = new Promise((resolve) => wrapper.once('exit', resolve));
    process.kill(wrapper.pid, 'SIGKILL');
    await wrapperExit;

    const contender = runLifecycleFenceContender(fencePath);
    assert.equal(contender.status, 23, contender.stderr);
    assert.match(contender.stderr, /TM_SANITIZER_LIFECYCLE_FENCE_BUSY/);

    process.kill(mutatorPid, 'SIGTERM');
    await waitForPidToDisappear(mutatorPid);
    mutatorPid = null;
    const releasedContender = runLifecycleFenceContender(fencePath);
    assert.equal(releasedContender.status, 0, releasedContender.stderr);
    proofComplete = true;
  } finally {
    if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGKILL');
    if (!proofComplete && mutatorPid) {
      try { process.kill(mutatorPid, 'SIGTERM'); } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('forced termination journals before and after staging for reboot cleanup', { skip: !HAS_BASH }, () => {
  for (const phase of ['prescrub-copy-intent', 'prescrub-staged']) {
    const fixture = migratedFixture(`kill-${phase}`);
    fixture.db.close();
    const outputPath = path.join(fixture.root, 'killed.db');
    const child = spawnSync(process.execPath, ['-e', `
      const sanitizer=require(${JSON.stringify(path.join(__dirname, '..', 'scripts', 'sanitize_production_shape.js'))});
      sanitizer.sanitizeProductionShape({sourcePath:process.argv[1],outputPath:process.argv[2]});
    `, fixture.dbPath, outputPath], {
      env: { ...process.env, TM_SANITIZER_KILL_AFTER_PHASE: phase },
      encoding: 'utf8'
    });
    assert.notEqual(child.status, 0);
    const journal = `${outputPath}.run.json`;
    assert.equal(fs.existsSync(journal), true);
    const record = JSON.parse(fs.readFileSync(journal, 'utf8'));
    assert.equal(record.state, phase);
    const scriptPath = path.join(__dirname, '..', 'scripts', 'cleanup_stale_migration_gate.sh');
    const env = { ...process.env, TM_GATE_TEST_MODE: '1', TM_GATE_JOURNAL_ROOT: fixture.root, TM_GATE_ALLOWED_ROOTS: fixture.root };
    const cleanup = spawnSync(BASH, [scriptPath, '--all'], { env, encoding: 'utf8' });
    assert.equal(cleanup.status, 0, cleanup.stderr);
    assert.equal(fs.existsSync(journal), false);
    assert.equal(fs.existsSync(fixture.dbPath), true);
    closeAndRemove(fixture);
  }
});

test('production coordinator rejects non-root and non-Linux execution', () => {
  assert.throws(
    () => sanitizer.assertProductionCoordinatorEnvironment({ platform: 'linux', uid: 10001 }),
    /root/i,
    'production sanitization must never run from an unprivileged coordinator'
  );
  assert.throws(
    () => sanitizer.assertProductionCoordinatorEnvironment({ platform: 'win32', uid: 0 }),
    /Linux/i,
    'production isolation depends on Linux mount, PID, and network namespaces'
  );
});

test('production worker launch uses a minimal allowlisted mount view with no inherited live paths or network', () => {
  const runId = 'c'.repeat(32);
  const plan = sanitizer._testing.buildIsolatedWorkerLaunch({
    runId,
    uid: 22001,
    gid: 22001,
    nodePath: '/usr/bin/node',
    serverRoot: '/opt/turingmarket-candidate/platform/server',
    scriptPath: '/opt/turingmarket-candidate/platform/server/scripts/sanitize_production_shape.js',
    sourcePath: '/run/turingmarket-gate/run/source/source.db',
    outputPath: '/run/turingmarket-gate/run/output/output.db',
    sandboxRoot: '/run/turingmarket-gate/run/sandbox-root',
    lifecycleFenceDevice: '2049',
    lifecycleFenceInode: '918273'
  });

  assert.equal(plan.command, 'unshare');
  for (const flag of ['--mount', '--net', '--pid', '--fork']) {
    assert.ok(plan.args.includes(flag), `missing isolation flag ${flag}`);
  }
  assert.equal(plan.args.includes('--mount-proc'), false, 'the worker chroot must not receive procfs');
  assert.equal(plan.worker.uid, 22001);
  assert.equal(plan.worker.gid, 22001);
  assert.notEqual(plan.worker.uid, 0);
  assert.equal(plan.isolation.root, '/run/turingmarket-gate/run/sandbox-root');
  assert.equal(plan.isolation.rootFilesystem, 'tmpfs');
  assert.equal(plan.isolation.hostRootVisible, false);
  assert.equal(plan.isolation.procMounted, false);
  assert.equal(plan.isolation.network, 'new-namespace-loopback-down');
  assert.ok(plan.args.includes('--lifecycle-fence-fd'));
  assert.ok(plan.args.includes('9'));
  assert.ok(plan.args.includes('--lifecycle-fence-device'));
  assert.ok(plan.args.includes('2049'));
  assert.ok(plan.args.includes('--lifecycle-fence-inode'));
  assert.ok(plan.args.includes('918273'));
  assert.equal(plan.isolation.mounts.every((mount) => mount.recursive === false), true);
  assert.deepEqual(plan.isolation.workerPaths, {
    source: '/input/source.db',
    output: '/output/output.db',
    script: '/app/scripts/sanitize_production_shape.js',
    node: '/runtime/node'
  });
  assert.equal(plan.mounts.source.readOnly, true);
  assert.equal(plan.mounts.output.readOnly, false);
  assert.notEqual(plan.mounts.source.path, plan.mounts.output.path);
  const hostMounts = new Set(plan.isolation.mounts.map((mount) => mount.host));
  for (const allowed of [
    '/usr/bin/node',
    '/opt/turingmarket-candidate/platform/server',
    '/run/turingmarket-gate/run/source/source.db',
    '/run/turingmarket-gate/run/output',
    '/usr',
    '/lib',
    '/lib64',
    '/dev/null',
    '/dev/urandom'
  ]) {
    assert.ok(hostMounts.has(allowed), `missing allowlisted mount ${allowed}`);
  }
  for (const seededLivePath of ['/root/turingmarket', '/srv/turingmarket-live', '/var/lib/turingmarket', '/proc', '/']) {
    assert.equal(hostMounts.has(seededLivePath), false, `inherited live path must be inaccessible: ${seededLivePath}`);
  }
  assert.ok(plan.args.includes('env'));
  assert.ok(plan.args.includes('-i'), 'worker must receive an empty environment');
  assert.ok(plan.args.includes('--run-id'));
  assert.ok(plan.args.includes(runId), 'run identity must be present in launched argv');
  if (HAS_BASH) {
    const commandIndex = plan.args.indexOf('-c');
    const syntax = spawnSync(BASH, ['-n'], { input: plan.args[commandIndex + 1], encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
  }
});

test('Linux minimal worker cannot reach a seeded live mount and enforces read-only source plus isolated output', {
  skip: process.platform !== 'linux'
}, () => {
  assert.equal(typeof process.getuid, 'function');
  assert.equal(process.getuid(), 0, 'the production namespace proof must run as root on Linux');
  for (const command of ['unshare', 'mount', 'umount', 'chroot', 'setpriv', 'ip']) {
    const available = spawnSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' });
    assert.equal(available.status, 0, `missing required production isolation primitive ${command}`);
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-minimal-worker-proof-'));
  const sourceDirectory = path.join(root, 'source');
  const outputDirectory = path.join(root, 'output');
  const sandboxRoot = path.join(root, 'sandbox-root');
  const serverRoot = path.join(root, 'candidate-server');
  const scriptDirectory = path.join(serverRoot, 'scripts');
  const liveMount = path.join(root, 'seeded-live-mount');
  for (const directory of [sourceDirectory, outputDirectory, sandboxRoot, scriptDirectory, liveMount]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  fs.chmodSync(serverRoot, 0o755);
  fs.chmodSync(scriptDirectory, 0o755);
  const sourcePath = path.join(sourceDirectory, 'source.db');
  const outputPath = path.join(outputDirectory, 'output.db');
  const workerPath = path.join(scriptDirectory, 'sanitize_production_shape.js');
  fs.writeFileSync(sourcePath, 'synthetic-readonly-source', { mode: 0o400 });
  fs.chmodSync(sourcePath, 0o400);
  fs.chownSync(sourcePath, 22041, 22041);
  fs.chownSync(outputDirectory, 22041, 22041);
  fs.chmodSync(outputDirectory, 0o700);
  const lifecycleFence = sanitizer._testing.acquireProductionLifecycleFence({
    fencePath: path.join(root, 'lifecycle.lock'),
    requireRoot: false
  });
  const mounted = spawnSync('mount', ['-t', 'tmpfs', '-o', 'mode=0700', 'tm-seeded-live', liveMount], { encoding: 'utf8' });
  assert.equal(mounted.status, 0, mounted.stderr);
  try {
    const liveProbe = path.join(liveMount, 'must-not-be-visible');
    fs.writeFileSync(liveProbe, 'synthetic-live-value', { mode: 0o600 });
    fs.writeFileSync(workerPath, `'use strict';
const fs = require('node:fs');
const os = require('node:os');
const source = fs.readFileSync('/input/source.db', 'utf8');
let sourceReadonly = false;
try { fs.appendFileSync('/input/source.db', 'forbidden'); } catch (error) { sourceReadonly = ['EACCES','EPERM','EROFS'].includes(error.code); }
const interfaces = Object.keys(os.networkInterfaces()).filter((name) => name !== 'lo');
const proof = {
  source,
  sourceReadonly,
  livePathVisible: fs.existsSync(${JSON.stringify(liveProbe)}),
  hostPrivateVisible: fs.existsSync('/root') || fs.existsSync('/var/lib/turingmarket'),
  procVisible: fs.existsSync('/proc/self/mountinfo'),
  nonLoopbackInterfaces: interfaces
};
if (source !== 'synthetic-readonly-source' || !sourceReadonly || proof.livePathVisible || proof.hostPrivateVisible || proof.procVisible || interfaces.length) process.exit(91);
fs.writeFileSync('/output/probe.json', JSON.stringify(proof));
`, { mode: 0o644 });
    fs.chmodSync(workerPath, 0o644);

    const plan = sanitizer._testing.buildIsolatedWorkerLaunch({
      runId: 'a'.repeat(32),
      uid: 22041,
      gid: 22041,
      nodePath: process.execPath,
      serverRoot,
      scriptPath: workerPath,
      sourcePath,
      outputPath,
      sandboxRoot,
      lifecycleFenceDevice: lifecycleFence.device,
      lifecycleFenceInode: lifecycleFence.inode
    });
    const workerStdio = ['ignore', 'pipe', 'pipe'];
    while (workerStdio.length <= 9) workerStdio.push('ignore');
    workerStdio[9] = lifecycleFence.fd;
    const result = spawnSync(plan.command, plan.args, {
      encoding: 'utf8',
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' },
      stdio: workerStdio,
      timeout: 30_000
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const proof = JSON.parse(fs.readFileSync(path.join(outputDirectory, 'probe.json'), 'utf8'));
    assert.equal(proof.sourceReadonly, true);
    assert.equal(proof.livePathVisible, false);
    assert.equal(proof.hostPrivateVisible, false);
    assert.equal(proof.procVisible, false);
    assert.deepEqual(proof.nonLoopbackInterfaces, []);
    assert.equal(fs.readFileSync(sourcePath, 'utf8'), 'synthetic-readonly-source');
    assert.deepEqual(fs.readdirSync(sandboxRoot), [], 'namespace tmpfs and every bind mount must disappear after exit');
  } finally {
    lifecycleFence.release();
    const unmounted = spawnSync('umount', [liveMount], { encoding: 'utf8' });
    assert.equal(unmounted.status, 0, unmounted.stderr);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('privileged preparation checkpoints and compacts a secret-free readonly source', () => {
  const fixture = migratedFixture('privileged-prescrub');
  const shortSecret = 'x7';
  const longEncodedSecret = Buffer.from(
    `tm-prepared-secret-${crypto.randomBytes(24).toString('hex')}`,
    'utf8'
  ).toString('base64');
  const users = fixture.db.prepare('SELECT id FROM users ORDER BY id LIMIT 2').all();
  assert.equal(users.length, 2, 'fixture requires separate records for short and long secret probes');
  fixture.db.pragma('journal_mode = WAL');
  fixture.db.pragma('wal_autocheckpoint = 0');
  fixture.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(shortSecret, users[0].id);
  fixture.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(longEncodedSecret, users[1].id);
  const displayName = fixture.db.prepare('SELECT display_name FROM users WHERE id=?').get(users[0].id).display_name;
  const copiedTeamCode = fixture.db.prepare('SELECT code FROM teams ORDER BY id LIMIT 1').get().code;
  const shortSecretAuditDetails = `short-secret:${shortSecret}`;
  const shortSecretAudit = {
    id: Number(fixture.db.prepare(`
      INSERT INTO activity_log (user_id,action,module,details,ip_address)
      VALUES (?,'sanitizer_short_secret_copy','sanitizer_test',?,NULL)
    `).run(users[0].id, shortSecretAuditDetails).lastInsertRowid),
    details: shortSecretAuditDetails
  };
  assert.ok(
    fixture.db.prepare('SELECT 1 AS present FROM activity_log WHERE instr(details,?)>0 LIMIT 1').get(copiedTeamCode),
    'fixture must carry a secret-classified team code into a non-secret audit detail'
  );
  assert.ok(
    fixture.db.prepare('SELECT 1 AS present FROM activity_log WHERE instr(details,?)>0 LIMIT 1').get(shortSecret),
    'fixture must carry a short secret into a non-secret audit detail'
  );
  const sourceSecretProbes = sanitizer._testing.collectSecretOnlySourceProbes(fixture.db, v7Manifest);
  assert.ok(sourceSecretProbes.rawProbes.every((probe) => probe.category === 'secret-synthetic'));
  assert.ok(
    sourceSecretProbes.authorizedEntries.some((entry) => (
      entry.context === 'activity_log.details' && entry.value === shortSecretAudit.details
    )),
    'the negative case must replay the exact source-authorized audit value'
  );
  assert.ok(sourceSecretProbes.rawProbes.some((probe) => (
    probe.context === 'users.password_hash'
      && probe.encoding === 'utf8'
      && probe.bytes.equals(Buffer.from(shortSecret, 'utf8'))
  )));
  assert.ok(sourceSecretProbes.rawProbes.some((probe) => (
    probe.context === 'users.password_hash'
      && probe.encoding === 'utf8'
      && probe.bytes.equals(Buffer.from(longEncodedSecret, 'utf8'))
  )));
  const preparedPath = path.join(fixture.root, 'prepared', 'source.db');
  fs.mkdirSync(path.dirname(preparedPath), { mode: 0o700 });
  const preparationOwnership = new Map();
  const preparationJournalRecords = [];

  const prepared = sanitizer._testing.preparePrivilegedSource({
    sourcePath: fixture.dbPath,
    preparedPath,
    manifest,
    ownership: preparationOwnership,
    journal: {
      recordPathIdentity(name, target, identity) {
        preparationJournalRecords.push({ name, target, identity });
      }
    },
    requireRoot: false
  });

  assert.deepEqual(preparationJournalRecords.map((entry) => entry.name), ['preparedRaw', 'preparedSource']);
  assert.match(prepared.sourceIdentity.sha256, /^[0-9a-f]{64}$/);
  assert.equal(fs.existsSync(preparedPath), true);
  const preparedBytes = fs.readFileSync(preparedPath);
  assert.equal(preparedBytes.includes(Buffer.from(copiedTeamCode, 'utf8')), false, 'pre-scrub must remove secret copies outside their source column');
  for (const representation of [
    shortSecret,
    longEncodedSecret,
    Buffer.from(longEncodedSecret, 'utf8').toString('hex'),
    Buffer.from(longEncodedSecret, 'utf8').toString('base64')
  ]) {
    assert.equal(preparedBytes.includes(Buffer.from(representation, 'utf8')), false, 'prepared SQLite must not retain a secret representation');
    assert.equal(JSON.stringify(prepared).includes(representation), false, 'preparation result must not persist raw secret material');
  }
  assert.doesNotThrow(() => sanitizer._testing.assertNoForbiddenValues(preparedPath, sourceSecretProbes, v7Manifest));
  assert.doesNotThrow(() => sanitizer._testing.assertNoSecretCopies(preparedPath, sourceSecretProbes, v7Manifest));
  const copiedShortSecretPath = compactSqliteClone(
    preparedPath,
    path.join(fixture.root, 'prepared-short-secret-copy.db'),
    (db) => {
      const triggers = db.prepare(`
        SELECT name,sql FROM sqlite_schema
        WHERE type='trigger' AND tbl_name='activity_log'
        ORDER BY name
      `).all();
      for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name.replace(/"/g, '""')}"`);
      db.prepare('UPDATE activity_log SET details=? WHERE id=?').run(
        shortSecretAudit.details,
        shortSecretAudit.id
      );
      for (const trigger of triggers) db.exec(trigger.sql);
    }
  );
  assert.throws(
    () => sanitizer._testing.assertNoSecretCopies(copiedShortSecretPath, sourceSecretProbes, v7Manifest),
    (error) => {
      assert.match(error.message, /users\.password_hash/i);
      assert.match(error.message, /activity_log\.details/i);
      return true;
    },
    'pre-worker validation must reject a copied short secret even when its source audit cell was authorized'
  );
  for (const suffix of ['-journal', '-wal', '-shm']) assert.equal(fs.existsSync(`${preparedPath}${suffix}`), false);
  const scrubbed = new Database(preparedPath, { readonly: true });
  try {
    const preparedUsers = scrubbed.prepare(`
      SELECT id,display_name,password_hash FROM users
      WHERE id IN (?,?) ORDER BY id
    `).all(users[0].id, users[1].id);
    assert.equal(preparedUsers[0].display_name, displayName, 'root pre-scrub must change only secret-classified cells');
    assert.notEqual(preparedUsers[0].password_hash, shortSecret);
    assert.notEqual(preparedUsers[1].password_hash, longEncodedSecret);
    assert.match(preparedUsers[0].password_hash, /^tm-inert-secret-/);
    assert.match(preparedUsers[1].password_hash, /^tm-inert-secret-/);
  } finally {
    scrubbed.close();
    closeAndRemove(fixture);
  }
});

test('central run journal is exclusive, process-bound, fsynced, and unlinked on completion', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-central-journal-'));
  fs.chmodSync(root, 0o700);
  const runId = 'd'.repeat(32);
  const stage = path.join(root, 'stage');
  fs.mkdirSync(stage, { mode: 0o700 });
  const controller = sanitizer._testing.createRunJournal({
    journalRoot: root,
    runId,
    sourcePath: path.join(root, 'source.db'),
    outputPath: path.join(root, 'output.db'),
    cleanupPaths: { stage },
    requireRoot: false
  });

  assert.equal(controller.path, path.join(root, `${runId}.run.json`));
  const stat = fs.statSync(controller.path);
  if (process.platform !== 'win32') assert.equal(stat.mode & 0o777, 0o600);
  const initial = JSON.parse(fs.readFileSync(controller.path, 'utf8'));
  assert.equal(initial.format, 'tm-sanitizer-run-journal-v4');
  assert.equal(initial.runId, runId);
  assert.equal(initial.coordinator.pid, process.pid);
  assert.equal(initial.coordinator.exe, process.execPath);
  assert.ok(Object.hasOwn(initial.coordinator, 'startTimeTicks'));
  assert.ok(Object.hasOwn(initial.coordinator, 'pgid'));
  assert.throws(
    () => sanitizer._testing.createRunJournal({
      journalRoot: root,
      runId,
      sourcePath: path.join(root, 'source.db'),
      outputPath: path.join(root, 'output.db'),
      cleanupPaths: { stage },
      requireRoot: false
    }),
    /exists|journal/i
  );

  assert.equal(initial.processGroup, null);
  controller.advance('prescrub-staged');
  controller.recordProcessGroup({
    pid: 987653,
    uid: 0,
    startTimeTicks: '1233',
    exe: '/usr/bin/unshare',
    pgid: 987653
  });
  controller.recordWorker({ pid: 987654, uid: 22001, startTimeTicks: '1234', exe: '/usr/bin/node' });
  const advanced = JSON.parse(fs.readFileSync(controller.path, 'utf8'));
  assert.equal(advanced.state, 'worker-group-recorded');
  assert.deepEqual(advanced.processGroup, {
    pid: 987653,
    uid: 0,
    startTimeTicks: '1233',
    exe: '/usr/bin/unshare',
    pgid: 987653
  });
  assert.deepEqual(advanced.worker, { pid: 987654, uid: 22001, startTimeTicks: '1234', exe: '/usr/bin/node' });
  controller.complete();
  assert.equal(fs.existsSync(controller.path), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('journal rename failure removes only the identity-bound temporary file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-journal-rename-failure-'));
  fs.chmodSync(root, 0o700);
  const runId = 'e'.repeat(32);
  const stage = path.join(root, 'stage');
  fs.mkdirSync(stage, { mode: 0o700 });
  const controller = sanitizer._testing.createRunJournal({
    journalRoot: root,
    runId,
    sourcePath: path.join(root, 'source.db'),
    outputPath: path.join(root, 'output.db'),
    cleanupPaths: { stage },
    requireRoot: false
  });
  const originalRenameSync = fs.renameSync;
  fs.renameSync = function injectedJournalRenameFailure(source, target) {
    if (path.resolve(String(target)) === path.resolve(controller.path)) {
      throw new Error('injected journal rename failure');
    }
    return originalRenameSync.apply(this, arguments);
  };
  try {
    assert.throws(() => controller.advance('prescrub-staged'), /journal rename failure/i);
  } finally {
    fs.renameSync = originalRenameSync;
  }
  assert.deepEqual(
    fs.readdirSync(root).filter((name) => name.includes('.run.json.tmp-')),
    [],
    'failed journal updates must not leak their invocation-owned temporary file'
  );
  assert.equal(fs.existsSync(controller.path), true, 'the previously durable journal must remain intact');
  controller.unlink();
  fs.rmSync(root, { recursive: true, force: true });
});

test('VACUUM staging is identity-bound and journaled before partial production bytes can be written', () => {
  const sanitizerSource = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'sanitize_production_shape.js'), 'utf8');
  assert.equal((sanitizerSource.match(/VACUUM INTO/g) || []).length, 1, 'all VACUUM destinations must use one owned helper');
  const helperSource = sanitizerSource.slice(
    sanitizerSource.indexOf('function vacuumIntoOwnedStage('),
    sanitizerSource.indexOf('function preparePrivilegedSource(')
  );
  assert.ok(helperSource.indexOf('secureCreateEmptyFile') < helperSource.indexOf('recordPathIdentity'));
  assert.ok(helperSource.indexOf('recordPathIdentity') < helperSource.indexOf('db.exec(`VACUUM INTO'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-vacuum-stage-'));
  const runDirectory = path.join(root, 'exclusive-run');
  fs.mkdirSync(runDirectory, { mode: 0o700 });
  const stagePath = path.join(runDirectory, 'partial.db');
  const ownership = new Map();
  const events = [];
  const journal = {
    recordPathIdentity(name, target, identity) {
      events.push({ name, target, identity, exists: fs.existsSync(target) });
    }
  };
  try {
    const partialDb = {
      exec() {
        assert.equal(events.length, 1, 'journal binding must precede VACUUM execution');
        assert.equal(events[0].exists, true);
        fs.writeFileSync(stagePath, 'partial-production-derived-bytes');
        throw new Error('injected VACUUM partial-create failure');
      }
    };
    assert.throws(
      () => sanitizer._testing.vacuumIntoOwnedStage(partialDb, stagePath, {
        ownership, journal, journalName: 'working', label: 'partial VACUUM stage'
      }),
      /partial-create failure/
    );
    assert.equal(fs.existsSync(stagePath), false, 'identity-matching partial stage must be removed');

    events.length = 0;
    const replacementDb = {
      exec() {
        fs.unlinkSync(stagePath);
        fs.writeFileSync(stagePath, 'foreign-replacement');
        throw new Error('injected VACUUM replacement race');
      }
    };
    assert.throws(
      () => sanitizer._testing.vacuumIntoOwnedStage(replacementDb, stagePath, {
        ownership, journal, journalName: 'publish', label: 'replaced VACUUM stage'
      }),
      (error) => {
        assert.equal(error.cleanupUnsafe, true);
        assert.match(error.message, /identity|owned|journal/i);
        return true;
      }
    );
    assert.equal(fs.readFileSync(stagePath, 'utf8'), 'foreign-replacement');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ordinary coordinator failure removes unpublished output, staging, user, and journal', async () => {
  const fixture = migratedFixture('coordinator-failure');
  fixture.db.close();
  fs.chmodSync(fixture.root, 0o700);
  fs.chmodSync(fixture.dbPath, 0o600);
  const sourceBefore = sha256File(fixture.dbPath);
  const journalRoot = path.join(fixture.root, 'journals');
  const runRoot = path.join(fixture.root, 'runs');
  const outputPath = path.join(fixture.root, 'must-not-publish.db');
  let removedIdentity = null;
  let failedSandboxRoot = null;

  await assert.rejects(
    sanitizer._testing.runProductionCoordinator({
      sourcePath: fixture.dbPath,
      outputPath,
      manifest,
      journalRoot,
      runRoot,
      requireRoot: false,
      createEphemeralIdentity: () => ({ name: 'tm-gate-test', uid: 22002, gid: 22002 }),
      removeEphemeralIdentity: (identity) => { removedIdentity = identity; },
      launchWorker: async ({ stagedOutputPath, preparedSourcePath, sandboxRoot }) => {
        failedSandboxRoot = sandboxRoot;
        fs.mkdirSync(sandboxRoot, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(sandboxRoot, 'failure-probe'), 'synthetic', { mode: 0o600 });
        fs.copyFileSync(preparedSourcePath, stagedOutputPath);
        throw new Error('injected isolated worker failure');
      }
    }),
    /injected isolated worker failure/
  );

  assert.equal(sha256File(fixture.dbPath), sourceBefore);
  assert.equal(fs.existsSync(outputPath), false);
  assert.ok(failedSandboxRoot && failedSandboxRoot.startsWith(`${runRoot}${path.sep}`));
  assert.equal(fs.existsSync(failedSandboxRoot), false, 'failed minimal-root staging must be removed');
  assert.deepEqual(removedIdentity, { name: 'tm-gate-test', uid: 22002, gid: 22002 });
  assert.deepEqual(fs.existsSync(journalRoot) ? fs.readdirSync(journalRoot) : [], []);
  assert.deepEqual(fs.existsSync(runRoot) ? fs.readdirSync(runRoot) : [], []);
  closeAndRemove(fixture);
});

test('production coordinator rechecks source identity immediately before atomic publication', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-coordinator-source-race-'));
  const sourceRoot = path.join(root, 'source');
  const outputRoot = path.join(root, 'output');
  const journalRoot = path.join(root, 'journals');
  const runRoot = path.join(root, 'runs');
  fs.chmodSync(root, 0o700);
  fs.mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(sourceRoot, 0o700);
  fs.chmodSync(outputRoot, 0o700);
  const sourcePath = path.join(sourceRoot, 'source.db');
  const outputPath = path.join(outputRoot, 'must-not-publish.db');
  fs.writeFileSync(sourcePath, 'source-before-publication', { mode: 0o600 });
  fs.chmodSync(sourcePath, 0o600);
  const identity = { name: 'tm-gate-test', uid: 22002, gid: 22002 };
  const identify = (filePath) => {
    const stat = fs.statSync(filePath, { bigint: true });
    return {
      device: stat.dev.toString(),
      inode: stat.ino.toString(),
      size: stat.size.toString(),
      mtimeNs: stat.mtimeNs.toString(),
      sha256: sha256File(filePath)
    };
  };
  const originalCopyFileSync = fs.copyFileSync;
  let publicationStaged = false;
  fs.copyFileSync = function interceptedCopy(source, target) {
    const result = originalCopyFileSync.apply(this, arguments);
    if (!publicationStaged && String(target).includes('.tm-stage-')) {
      publicationStaged = true;
      fs.appendFileSync(sourcePath, 'source-race');
    }
    return result;
  };
  try {
    await assert.rejects(
      sanitizer._testing.runProductionCoordinator({
        sourcePath,
        outputPath,
        sourceRoot,
        outputRoot,
        journalRoot,
        runRoot,
        runId: '5'.repeat(32),
        requireRoot: false,
        createEphemeralIdentity: () => identity,
        removeEphemeralIdentity: () => true,
        preparePrivilegedSource: ({ preparedPath }) => {
          const sourceIdentity = identify(sourcePath);
          originalCopyFileSync(sourcePath, preparedPath);
          fs.chmodSync(preparedPath, 0o400);
          return { sourceIdentity, preparedPath, preparedIdentity: identify(preparedPath) };
        },
        launchWorker: async ({ preparedSourcePath, stagedOutputPath }) => {
          originalCopyFileSync(preparedSourcePath, stagedOutputPath);
          fs.chmodSync(stagedOutputPath, 0o600);
          return { marker: 'must-not-return' };
        }
      }),
      /source database changed/i
    );
  } finally {
    fs.copyFileSync = originalCopyFileSync;
  }
  assert.equal(publicationStaged, true);
  assert.equal(fs.existsSync(outputPath), false);
  assert.deepEqual(fs.existsSync(outputRoot) ? fs.readdirSync(outputRoot) : [], []);
  assert.deepEqual(fs.existsSync(journalRoot) ? fs.readdirSync(journalRoot) : [], []);
  assert.deepEqual(fs.existsSync(runRoot) ? fs.readdirSync(runRoot) : [], []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('production no-replace publication preserves concurrent output and publication staging paths', async (t) => {
  for (const kind of ['output', 'publication-stage']) {
    await t.test(kind, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `tm-production-concurrent-${kind}-`));
      const sourceRoot = path.join(root, 'source');
      const outputRoot = path.join(root, 'output');
      const journalRoot = path.join(root, 'journals');
      const runRoot = path.join(root, 'runs');
      fs.chmodSync(root, 0o700);
      fs.mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
      fs.mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
      fs.chmodSync(sourceRoot, 0o700);
      fs.chmodSync(outputRoot, 0o700);
      const sourcePath = path.join(sourceRoot, 'source.db');
      const outputPath = path.join(outputRoot, 'sanitized.db');
      const marker = `concurrent-${kind}-owner`;
      fs.writeFileSync(sourcePath, 'production-source', { mode: 0o600 });
      fs.chmodSync(sourcePath, 0o600);
      const identify = (filePath) => {
        const stat = fs.statSync(filePath, { bigint: true });
        return {
          device: stat.dev.toString(),
          inode: stat.ino.toString(),
          size: stat.size.toString(),
          mtimeNs: stat.mtimeNs.toString(),
          sha256: sha256File(filePath)
        };
      };
      const originalCopyFileSync = fs.copyFileSync;
      const originalRenameSync = fs.renameSync;
      const originalLinkSync = fs.linkSync;
      let concurrentPath = null;
      fs.copyFileSync = function interceptedCopy(source, target) {
        if (kind === 'publication-stage' && !concurrentPath && String(target).includes('.tm-stage-')) {
          concurrentPath = path.resolve(String(target));
          fs.writeFileSync(concurrentPath, marker);
        }
        return originalCopyFileSync.apply(this, arguments);
      };
      const interceptPublication = (original) => function interceptedPublish(source, target) {
        if (kind === 'output' && !concurrentPath && path.resolve(String(target)) === path.resolve(outputPath)) {
          concurrentPath = outputPath;
          fs.writeFileSync(outputPath, marker);
        }
        return original.apply(this, arguments);
      };
      fs.renameSync = interceptPublication(originalRenameSync);
      fs.linkSync = interceptPublication(originalLinkSync);
      try {
        await assert.rejects(
          sanitizer._testing.runProductionCoordinator({
            sourcePath,
            outputPath,
            sourceRoot,
            outputRoot,
            journalRoot,
            runRoot,
            runId: kind === 'output' ? '6'.repeat(32) : '7'.repeat(32),
            requireRoot: false,
            createEphemeralIdentity: () => ({ name: 'tm-gate-test', uid: 22002, gid: 22002 }),
            removeEphemeralIdentity: () => true,
            preparePrivilegedSource: ({ preparedPath }) => {
              const sourceIdentity = identify(sourcePath);
              originalCopyFileSync(sourcePath, preparedPath);
              fs.chmodSync(preparedPath, 0o400);
              return { sourceIdentity, preparedPath, preparedIdentity: identify(preparedPath) };
            },
            launchWorker: async ({ preparedSourcePath, stagedOutputPath }) => {
              originalCopyFileSync(preparedSourcePath, stagedOutputPath);
              fs.chmodSync(stagedOutputPath, 0o600);
              return { marker: 'must-not-publish' };
            }
          }),
          /exist|publish|concurrent|owned|identity/i
        );
      } finally {
        fs.copyFileSync = originalCopyFileSync;
        fs.renameSync = originalRenameSync;
        fs.linkSync = originalLinkSync;
      }
      assert.ok(concurrentPath, 'fixture must create the competing path at publication time');
      assert.equal(fs.readFileSync(concurrentPath, 'utf8'), marker, 'coordinator cleanup must preserve the competing inode');
      fs.rmSync(root, { recursive: true, force: true });
    });
  }
});

test('production coordinator validates live paths and publishes atomically across source filesystems', async (t) => {
  if (process.platform === 'win32') {
    runLinuxTestThroughWsl(t, '^production coordinator validates live paths and publishes atomically across source filesystems$');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-coordinator-publication-'));
  fs.chmodSync(root, 0o700);
  const sourcePath = path.join(root, 'source.db');
  fs.writeFileSync(sourcePath, 'prepared sanitizer fixture', { mode: 0o600 });
  fs.chmodSync(sourcePath, 0o600);
  const outputRoot = path.join(root, 'published');
  const journalRoot = path.join(root, 'journals');
  fs.mkdirSync(outputRoot, { mode: 0o700 });
  fs.chmodSync(outputRoot, 0o700);
  const runRoot = fs.mkdtempSync('/dev/shm/tm-gate-run-');
  fs.chmodSync(runRoot, 0o711);
  assert.notEqual(fs.statSync(runRoot).dev, fs.statSync(outputRoot).dev, 'fixture must exercise a cross-device publication');
  const identity = { name: 'tm-gate-test', uid: 22002, gid: 22002 };
  const testFileIdentity = (filePath) => {
    const stat = fs.statSync(filePath, { bigint: true });
    return {
      device: stat.dev.toString(), inode: stat.ino.toString(), size: stat.size.toString(),
      mtimeNs: stat.mtimeNs.toString(), sha256: sha256File(filePath)
    };
  };
  const common = {
    sourcePath,
    journalRoot,
    runRoot,
    requireRoot: false,
    createEphemeralIdentity: () => identity,
    removeEphemeralIdentity: () => true,
    preparePrivilegedSource: ({ sourcePath: liveSourcePath, preparedPath }) => {
      const sourceIdentity = testFileIdentity(liveSourcePath);
      fs.copyFileSync(liveSourcePath, preparedPath);
      fs.chmodSync(preparedPath, 0o400);
      return { sourceIdentity, preparedPath, preparedIdentity: testFileIdentity(preparedPath) };
    }
  };
  try {
    fs.chmodSync(root, 0o755);
    await assert.rejects(
      sanitizer._testing.runProductionCoordinator({
        ...common,
        runId: '6'.repeat(32),
        outputPath: path.join(outputRoot, 'unsafe.db'),
        launchWorker: async () => { throw new Error('worker must not launch for an unsafe source path'); }
      }),
      /secure path.*mode|mode mismatch/i,
      'the production coordinator itself must call validateSecurePath before staging'
    );
    fs.chmodSync(root, 0o700);

    let workerStage;
    let workerStageDevice;
    const outputPath = path.join(outputRoot, 'sanitized.db');
    const result = await sanitizer._testing.runProductionCoordinator({
      ...common,
      runId: '7'.repeat(32),
      outputPath,
      launchWorker: async ({ stagedOutputPath, preparedSourcePath }) => {
        workerStage = stagedOutputPath;
        fs.copyFileSync(preparedSourcePath, stagedOutputPath);
        fs.chmodSync(stagedOutputPath, 0o600);
        workerStageDevice = fs.statSync(stagedOutputPath).dev;
        return { marker: 'published' };
      }
    });
    assert.deepEqual(result, { marker: 'published' });
    assert.equal(fs.existsSync(outputPath), true);
    assert.equal(fs.statSync(outputPath).dev, fs.statSync(outputRoot).dev);
    assert.ok(workerStage.startsWith(`${runRoot}${path.sep}`));
    assert.equal(workerStageDevice, fs.statSync(runRoot).dev);
    assert.deepEqual(fs.readdirSync(outputRoot), ['sanitized.db'], 'same-filesystem publication staging must be removed');
    assert.deepEqual(fs.readdirSync(journalRoot), []);
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('production CLI separates coordinator and run-bound worker modes', () => {
  assert.deepEqual(
    sanitizer._testing.parseCli(['--production', '--source', '/srv/live.db', '--output', '/srv/sanitized.db']),
    { mode: 'production', sourcePath: '/srv/live.db', outputPath: '/srv/sanitized.db' }
  );
  assert.deepEqual(
    sanitizer._testing.parseCli([
      '--production', '--run-id', '4'.repeat(32), '--source', '/srv/live.db', '--output', '/srv/sanitized.db'
    ]),
    { mode: 'production', runId: '4'.repeat(32), sourcePath: '/srv/live.db', outputPath: '/srv/sanitized.db' }
  );
  assert.deepEqual(
    sanitizer._testing.parseCli([
      '--worker', '--run-id', 'e'.repeat(32), '--source', '/run/source.db', '--output', '/run/output.db',
      '--lifecycle-fence-fd', '9', '--lifecycle-fence-device', '2049', '--lifecycle-fence-inode', '918273'
    ]),
    {
      mode: 'worker',
      runId: 'e'.repeat(32),
      sourcePath: '/run/source.db',
      outputPath: '/run/output.db',
      lifecycleFenceFd: 9,
      lifecycleFenceDevice: '2049',
      lifecycleFenceInode: '918273'
    }
  );
  assert.throws(
    () => sanitizer._testing.parseCli(['--worker', '--source', '/run/source.db', '--output', '/run/output.db']),
    /run-id/i
  );
  assert.throws(
    () => sanitizer._testing.parseCli([
      '--worker', '--run-id', 'e'.repeat(32), '--source', '/run/source.db', '--output', '/run/output.db'
    ]),
    /lifecycle fence descriptor identity/i
  );
});

test('ephemeral production identity is created and removed with exact UID ownership checks', () => {
  const calls = [];
  const commandRunner = (command, args) => {
    calls.push([command, ...args]);
    if (command === 'useradd') return { status: 0, stdout: '', stderr: '' };
    if (command === 'getent') return { status: 0, stdout: 'tm-gate-eeeeeeeeeeee:x:22003:22003::/nonexistent:/usr/sbin/nologin\n', stderr: '' };
    if (command === 'userdel') return { status: 0, stdout: '', stderr: '' };
    throw new Error(`unexpected command ${command}`);
  };
  const identity = sanitizer._testing.createEphemeralIdentity({ runId: 'e'.repeat(32), commandRunner });
  assert.deepEqual(identity, { name: 'tm-gate-eeeeeeeeeeee', uid: 22003, gid: 22003 });
  assert.deepEqual(calls[0], [
    'useradd', '--system', '--no-create-home', '--home-dir', '/nonexistent',
    '--shell', '/usr/sbin/nologin', '--user-group', 'tm-gate-eeeeeeeeeeee'
  ]);
  assert.deepEqual(calls[1], ['getent', 'passwd', 'tm-gate-eeeeeeeeeeee']);
  sanitizer._testing.removeEphemeralIdentity(identity, { commandRunner });
  assert.deepEqual(calls[2], ['getent', 'passwd', 'tm-gate-eeeeeeeeeeee']);
  assert.deepEqual(calls[3], ['userdel', '--force', 'tm-gate-eeeeeeeeeeee']);
});

function linuxProcessIdentity(pid) {
  const statText = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const commandEnd = statText.lastIndexOf(') ');
  const fields = statText.slice(commandEnd + 2).trim().split(/\s+/);
  const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  return {
    pid,
    uid: Number(status.match(/^Uid:\s+(\d+)/m)[1]),
    startTimeTicks: fields[19],
    exe: fs.readlinkSync(`/proc/${pid}/exe`),
    pgid: Number(fields[2])
  };
}

function cleanupPathRecord(target) {
  const stat = fs.lstatSync(target, { bigint: true });
  return {
    path: target,
    cleanup: true,
    identity: { device: stat.dev.toString(), inode: stat.ino.toString() }
  };
}

function writeCleanupJournal(root, runId, processGroup, stage, coordinatorOverride, stateOverride) {
  const journal = path.join(root, `${runId}.run.json`);
  const coordinator = coordinatorOverride || (process.platform === 'linux'
    ? linuxProcessIdentity(process.pid)
    : { pid: process.pid, uid: 0, startTimeTicks: '1', exe: process.execPath, pgid: process.pid });
  fs.writeFileSync(journal, `${JSON.stringify({
    format: 'tm-sanitizer-run-journal-v3',
    runId,
    state: stateOverride || (processGroup ? 'worker-group-recorded' : 'prescrub-staged'),
    coordinator,
    processGroup,
    worker: null,
    unit: { name: null, active: false },
    mount: { path: null, source: null, mounted: false },
    ephemeralUser: { name: null, uid: null, gid: null },
    paths: {
      source: { path: path.join(root, 'source.db'), cleanup: false },
      output: { path: path.join(root, 'output.db'), cleanup: false },
      stage: cleanupPathRecord(stage)
    }
  })}\n`, { mode: 0o600 });
  fs.chmodSync(journal, 0o600);
  return journal;
}

function exactDeadCleanupIdentity(pid = 99999999) {
  return {
    pid,
    uid: 0,
    startTimeTicks: '1',
    exe: process.execPath,
    pgid: pid
  };
}

function writePublicationRecoveryJournal(root, options) {
  const {
    runId,
    outputPath,
    stagePath,
    stageRole = 'publicationStage',
    bound = true,
    publishedOutput = false,
    format = 'tm-sanitizer-run-journal-v4'
  } = options;
  const journal = path.join(root, `${runId}.run.json`);
  const paths = {
    source: { path: path.join(root, 'source.db'), cleanup: false },
    output: { path: outputPath, cleanup: false },
    [stageRole]: {
      path: stagePath,
      cleanup: true,
      identity: bound ? cleanupPathRecord(stagePath).identity : null
    }
  };
  if (publishedOutput) paths.publishedOutput = cleanupPathRecord(outputPath);
  const payload = format === 'tm-sanitizer-run-journal-v1'
    ? {
        format,
        runId,
        pid: 99999999,
        uid: 0,
        state: 'compact-scan-complete',
        unit: { name: null, active: false },
        mount: { path: null, source: null, mounted: false },
        ephemeralUser: { name: null },
        paths
      }
    : {
        format,
        runId,
        state: 'prescrub-staged',
        coordinator: exactDeadCleanupIdentity(),
        processGroup: null,
        worker: null,
        unit: { name: null, active: false },
        mount: { path: null, source: null, mounted: false },
        ephemeralUser: { name: null, uid: null, gid: null },
        paths
      };
  fs.writeFileSync(journal, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  fs.chmodSync(journal, 0o600);
  return journal;
}

function writePathRoleJournal(root, runId, paths) {
  const journal = path.join(root, `${runId}.run.json`);
  const payload = {
    format: 'tm-sanitizer-run-journal-v4',
    runId,
    state: 'prescrub-staged',
    coordinator: exactDeadCleanupIdentity(),
    processGroup: null,
    worker: null,
    unit: { name: null, active: false },
    mount: { path: null, source: null, mounted: false },
    ephemeralUser: { name: null, uid: null, gid: null },
    paths
  };
  fs.writeFileSync(journal, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  fs.chmodSync(journal, 0o600);
  return journal;
}

function runStaleCleanup(root, journalRoot = root) {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'cleanup_stale_migration_gate.sh');
  return spawnSync(BASH, [scriptPath, '--all'], {
    env: {
      ...process.env,
      TM_GATE_TEST_MODE: '1',
      TM_GATE_JOURNAL_ROOT: journalRoot,
      TM_GATE_ALLOWED_ROOTS: root
    },
    encoding: 'utf8'
  });
}

function assertExactTwoLinkPair(stagePath, outputPath) {
  const stage = fs.lstatSync(stagePath, { bigint: true });
  const output = fs.lstatSync(outputPath, { bigint: true });
  assert.equal(stage.isFile(), true);
  assert.equal(output.isFile(), true);
  assert.equal(stage.dev, output.dev);
  assert.equal(stage.ino, output.ino);
  assert.equal(stage.nlink, 2n);
  assert.equal(output.nlink, 2n);
}

test('v3 and v4 cleanup journals require a complete coordinator PGID identity', { skip: !HAS_BASH }, () => {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'cleanup_stale_migration_gate.sh');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-missing-coordinator-pgid-'));
  fs.chmodSync(root, 0o700);
  const runId = '6'.repeat(32);
  const stage = path.join(root, 'partial-stage');
  fs.writeFileSync(stage, 'production-derived', { mode: 0o600 });
  const journal = writeCleanupJournal(root, runId, null, stage, {
    pid: 99999999,
    uid: typeof process.getuid === 'function' ? process.getuid() : 0,
    startTimeTicks: '31337',
    exe: process.execPath
  });
  try {
    const result = spawnSync(BASH, [scriptPath, '--journal', journal], {
      env: {
        ...process.env,
        TM_GATE_TEST_MODE: '1',
        TM_GATE_JOURNAL_ROOT: root,
        TM_GATE_ALLOWED_ROOTS: root
      },
      encoding: 'utf8'
    });
    assert.notEqual(result.status, 0, 'missing coordinator PGID must fail closed');
    assert.match(result.stderr, /coordinator.*pgid|journal validation rejected/i);
    assert.equal(fs.existsSync(journal), true, 'invalid coordinator identity must retain the journal');
    assert.equal(fs.existsSync(stage), true, 'invalid coordinator identity must retain derived stages');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stale cleanup retains a newer temp journal when an older final already exists', { skip: !HAS_BASH }, () => {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'cleanup_stale_migration_gate.sh');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-journal-temp-conflict-'));
  fs.chmodSync(root, 0o700);
  const runId = '7'.repeat(32);
  const oldStage = path.join(root, 'old-stage');
  const extraVacuumStage = path.join(root, 'new-vacuum-stage');
  fs.mkdirSync(oldStage, { mode: 0o700 });
  fs.mkdirSync(extraVacuumStage, { mode: 0o700 });
  fs.writeFileSync(path.join(extraVacuumStage, 'partial.db'), 'partial production-derived bytes', { mode: 0o600 });
  const deadCoordinator = {
    pid: 99999999,
    uid: 0,
    startTimeTicks: '1',
    exe: process.execPath,
    pgid: 99999999
  };
  const finalJournal = writeCleanupJournal(root, runId, null, oldStage, deadCoordinator);
  const oldPayload = JSON.parse(fs.readFileSync(finalJournal, 'utf8'));
  oldPayload.updatedAt = '2026-07-31T00:00:00.000Z';
  fs.writeFileSync(finalJournal, `${JSON.stringify(oldPayload)}\n`, { mode: 0o600 });
  fs.chmodSync(finalJournal, 0o600);

  const newerPayload = structuredClone(oldPayload);
  newerPayload.updatedAt = '2026-07-31T00:00:01.000Z';
  newerPayload.state = 'prescrub-staged';
  newerPayload.paths.extraVacuumStage = cleanupPathRecord(extraVacuumStage);
  const temporary = `${finalJournal}.tmp-424242-${'a'.repeat(16)}`;
  fs.writeFileSync(temporary, `${JSON.stringify(newerPayload)}\n`, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  const stale = new Date(Date.now() - 5_000);
  fs.utimesSync(temporary, stale, stale);

  try {
    const cleanup = spawnSync(BASH, [scriptPath, '--all'], {
      env: {
        ...process.env,
        TM_GATE_TEST_MODE: '1',
        TM_GATE_JOURNAL_ROOT: root,
        TM_GATE_ALLOWED_ROOTS: root,
        TM_GATE_JOURNAL_TMP_STALE_SECONDS: '1'
      },
      encoding: 'utf8'
    });
    assert.notEqual(cleanup.status, 0, 'different-inode final/temp journals must fail closed');
    assert.match(cleanup.stderr, /different|conflict|retain|identity/i);
    assert.equal(fs.existsSync(finalJournal), true, 'older final journal must remain for operator reconciliation');
    assert.equal(fs.existsSync(temporary), true, 'newer temp journal must not be deleted');
    assert.equal(fs.existsSync(oldStage), true, 'cleanup must not reconcile only the older final state');
    assert.equal(fs.existsSync(extraVacuumStage), true, 'newer VACUUM stage must remain identity-bound to its temp journal');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stale cleanup immediately reconciles a fresh journal publication hardlink', { skip: !HAS_BASH }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-fresh-journal-hardlink-'));
  fs.chmodSync(root, 0o700);
  const runId = 'a'.repeat(32);
  const stage = path.join(root, 'fresh-partial-stage');
  fs.mkdirSync(stage, { mode: 0o700 });
  fs.writeFileSync(path.join(stage, 'partial.db'), 'fresh production-derived bytes', { mode: 0o600 });
  const finalJournal = writeCleanupJournal(root, runId, null, stage, exactDeadCleanupIdentity());
  const temporary = `${finalJournal}.tmp-424242-${'c'.repeat(16)}`;
  fs.renameSync(finalJournal, temporary);
  fs.linkSync(temporary, finalJournal);

  try {
    assertExactTwoLinkPair(temporary, finalJournal);
    const cleanup = runStaleCleanup(root);
    assert.equal(cleanup.status, 0, cleanup.stderr || cleanup.stdout);
    assert.equal(fs.existsSync(temporary), false);
    assert.equal(fs.existsSync(finalJournal), false);
    assert.equal(fs.existsSync(stage), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stale cleanup reconciles an interrupted same-inode journal hardlink pair', { skip: !HAS_BASH }, () => {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'cleanup_stale_migration_gate.sh');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-journal-hardlink-recovery-'));
  fs.chmodSync(root, 0o700);
  const runId = '8'.repeat(32);
  const stage = path.join(root, 'partial-vacuum-stage');
  fs.mkdirSync(stage, { mode: 0o700 });
  fs.writeFileSync(path.join(stage, 'partial.db'), 'partial production-derived bytes', { mode: 0o600 });
  const deadCoordinator = {
    pid: 99999999,
    uid: 0,
    startTimeTicks: '1',
    exe: process.execPath,
    pgid: 99999999
  };
  const finalJournal = writeCleanupJournal(root, runId, null, stage, deadCoordinator);
  const temporary = `${finalJournal}.tmp-424242-${'b'.repeat(16)}`;
  fs.renameSync(finalJournal, temporary);
  const stale = new Date(Date.now() - 5_000);
  fs.utimesSync(temporary, stale, stale);
  const env = {
    ...process.env,
    TM_GATE_TEST_MODE: '1',
    TM_GATE_JOURNAL_ROOT: root,
    TM_GATE_ALLOWED_ROOTS: root,
    TM_GATE_JOURNAL_TMP_STALE_SECONDS: '1'
  };

  try {
    const interrupted = spawnSync(BASH, [scriptPath, '--all'], {
      env: { ...env, TM_GATE_TEST_FAIL_AFTER_JOURNAL_LINK: '1' },
      encoding: 'utf8'
    });
    assert.notEqual(interrupted.status, 0, 'fault injection must stop immediately after canonical link creation');
    assert.equal(fs.existsSync(temporary), true);
    assert.equal(fs.existsSync(finalJournal), true);
    const temporaryIdentity = fs.lstatSync(temporary, { bigint: true });
    const finalIdentity = fs.lstatSync(finalJournal, { bigint: true });
    assert.equal(temporaryIdentity.dev, finalIdentity.dev);
    assert.equal(temporaryIdentity.ino, finalIdentity.ino);
    assert.equal(temporaryIdentity.nlink, 2n);
    assert.equal(finalIdentity.nlink, 2n);
    assert.equal(fs.existsSync(stage), true, 'interrupted recovery must retain the identity-bound VACUUM stage');

    const recovered = spawnSync(BASH, [scriptPath, '--all'], { env, encoding: 'utf8' });
    assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
    assert.equal(fs.existsSync(temporary), false);
    assert.equal(fs.existsSync(finalJournal), false);
    assert.equal(fs.existsSync(stage), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stale cleanup recovers a local publish crash before output journaling', { skip: !HAS_BASH }, () => {
  const fixture = migratedFixture('local-publish-crash');
  fixture.db.close();
  fs.chmodSync(fixture.root, 0o700);
  const outputPath = path.join(fixture.root, 'crashed-local.db');
  const journalPath = `${outputPath}.run.json`;
  const crashMarker = path.join(fixture.root, 'local-link-created');
  const sanitizerPath = path.join(__dirname, '..', 'scripts', 'sanitize_production_shape.js');
  const childProgram = `
    const fs = require('node:fs');
    const path = require('node:path');
    const sanitizer = require(${JSON.stringify(sanitizerPath)});
    const output = path.resolve(process.argv[2]);
    const marker = process.argv[3];
    const originalLinkSync = fs.linkSync;
    fs.linkSync = function crashAfterPublicationLink(source, target) {
      const result = originalLinkSync.apply(this, arguments);
      if (path.resolve(String(target)) === output) {
        fs.writeFileSync(marker, 'linked');
        process.kill(process.pid, 'SIGKILL');
      }
      return result;
    };
    sanitizer.sanitizeProductionShape({ sourcePath: process.argv[1], outputPath: process.argv[2] });
  `;
  try {
    const child = spawnSync(process.execPath, [
      '-e', childProgram, fixture.dbPath, outputPath, crashMarker
    ], { encoding: 'utf8', timeout: 180_000, windowsHide: true });
    assert.notEqual(child.status, 0, 'publication fault must terminate the local sanitizer child');
    assert.equal(fs.existsSync(crashMarker), true, child.stderr || child.stdout);
    assert.equal(fs.existsSync(journalPath), true);
    const payload = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    assert.equal(payload.paths.publishedOutput, undefined, 'crash must precede the onLinked journal callback');
    payload.pid = 99999999;
    payload.uid = null;
    fs.writeFileSync(journalPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    fs.chmodSync(journalPath, 0o600);
    const publishPath = payload.paths.publish.path;
    assertExactTwoLinkPair(publishPath, outputPath);

    const cleanup = runStaleCleanup(fixture.root);
    assert.equal(cleanup.status, 0, cleanup.stderr || cleanup.stdout);
    assert.equal(fs.existsSync(publishPath), false);
    assert.equal(fs.existsSync(outputPath), false);
    assert.equal(fs.existsSync(journalPath), false);
  } finally {
    closeAndRemove(fixture);
  }
});

test('stale cleanup recovers a production publicationStage crash before output journaling', { skip: !HAS_BASH }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-production-publish-crash-'));
  const sourceRoot = path.join(root, 'source');
  const outputRoot = path.join(root, 'output');
  const journalRoot = path.join(root, 'journals');
  const runRoot = path.join(root, 'runs');
  const runId = 'b'.repeat(32);
  const sourcePath = path.join(sourceRoot, 'source.db');
  const outputPath = path.join(outputRoot, 'sanitized.db');
  const crashMarker = path.join(root, 'production-link-created');
  const sanitizerPath = path.join(__dirname, '..', 'scripts', 'sanitize_production_shape.js');
  fs.chmodSync(root, 0o700);
  fs.mkdirSync(sourceRoot, { mode: 0o700 });
  fs.mkdirSync(outputRoot, { mode: 0o700 });
  fs.writeFileSync(sourcePath, 'production-source', { mode: 0o600 });
  fs.chmodSync(sourcePath, 0o600);
  const childProgram = `
    const crypto = require('node:crypto');
    const fs = require('node:fs');
    const path = require('node:path');
    const sanitizer = require(${JSON.stringify(sanitizerPath)});
    const [sourcePath, outputPath, sourceRoot, outputRoot, journalRoot, runRoot, runId, marker] = process.argv.slice(1);
    const identify = (filePath) => {
      const stat = fs.statSync(filePath, { bigint: true });
      return {
        device: stat.dev.toString(), inode: stat.ino.toString(), size: stat.size.toString(),
        mtimeNs: stat.mtimeNs.toString(),
        sha256: crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
      };
    };
    const originalCopyFileSync = fs.copyFileSync;
    const originalLinkSync = fs.linkSync;
    fs.linkSync = function crashAfterPublicationLink(source, target) {
      const result = originalLinkSync.apply(this, arguments);
      if (path.resolve(String(target)) === path.resolve(outputPath)) {
        fs.writeFileSync(marker, 'linked');
        process.kill(process.pid, 'SIGKILL');
      }
      return result;
    };
    sanitizer._testing.runProductionCoordinator({
      sourcePath, outputPath, sourceRoot, outputRoot, journalRoot, runRoot, runId,
      requireRoot: false,
      createEphemeralIdentity: () => ({ name: 'tm-gate-' + runId.slice(0, 12), uid: 22002, gid: 22002 }),
      removeEphemeralIdentity: () => true,
      preparePrivilegedSource: ({ preparedPath }) => {
        const sourceIdentity = identify(sourcePath);
        originalCopyFileSync(sourcePath, preparedPath);
        fs.chmodSync(preparedPath, 0o400);
        return { sourceIdentity, preparedPath, preparedIdentity: identify(preparedPath) };
      },
      launchWorker: async ({ preparedSourcePath, stagedOutputPath }) => {
        originalCopyFileSync(preparedSourcePath, stagedOutputPath);
        fs.chmodSync(stagedOutputPath, 0o600);
        return { marker: 'must-not-return' };
      }
    }).then(() => process.exit(91)).catch((error) => {
      fs.writeFileSync(marker + '.error', error.stack || error.message);
      process.exit(92);
    });
  `;
  try {
    const child = spawnSync(process.execPath, [
      '-e', childProgram, sourcePath, outputPath, sourceRoot, outputRoot,
      journalRoot, runRoot, runId, crashMarker
    ], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    assert.notEqual(child.status, 0, 'publication fault must terminate the production coordinator child');
    assert.equal(fs.existsSync(crashMarker), true, child.stderr || child.stdout);
    const journalPath = path.join(journalRoot, `${runId}.run.json`);
    assert.equal(fs.existsSync(journalPath), true);
    const payload = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    assert.equal(payload.paths.publishedOutput, undefined, 'crash must precede the onLinked journal callback');
    payload.coordinator = exactDeadCleanupIdentity();
    payload.processGroup = exactDeadCleanupIdentity(99999998);
    payload.worker = null;
    payload.ephemeralUser = { name: null, uid: null, gid: null };
    fs.writeFileSync(journalPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    fs.chmodSync(journalPath, 0o600);
    const publicationStage = payload.paths.publicationStage.path;
    assertExactTwoLinkPair(publicationStage, outputPath);

    const cleanup = runStaleCleanup(root, journalRoot);
    assert.equal(cleanup.status, 0, cleanup.stderr || cleanup.stdout);
    assert.equal(fs.existsSync(publicationStage), false);
    assert.equal(fs.existsSync(outputPath), false);
    assert.equal(fs.existsSync(journalPath), false);
    assert.equal(fs.existsSync(path.join(runRoot, runId)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stale cleanup recovers a publication pair when publishedOutput is already journaled', { skip: !HAS_BASH }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-published-output-recovery-'));
  fs.chmodSync(root, 0o700);
  const stagePath = path.join(root, 'publication-stage.db');
  const outputPath = path.join(root, 'output.db');
  fs.writeFileSync(stagePath, 'production-derived bytes', { mode: 0o600 });
  fs.chmodSync(stagePath, 0o600);
  fs.linkSync(stagePath, outputPath);
  const journal = writePublicationRecoveryJournal(root, {
    runId: 'c'.repeat(32), outputPath, stagePath, publishedOutput: true
  });
  try {
    assertExactTwoLinkPair(stagePath, outputPath);
    const cleanup = runStaleCleanup(root);
    assert.equal(cleanup.status, 0, cleanup.stderr || cleanup.stdout);
    assert.equal(fs.existsSync(stagePath), false);
    assert.equal(fs.existsSync(outputPath), false);
    assert.equal(fs.existsSync(journal), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stale cleanup rejects a dangling publication stage before deleting its journal', { skip: !HAS_BASH }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-dangling-publication-stage-'));
  fs.chmodSync(root, 0o700);
  const stagePath = path.join(root, 'publication-stage.db');
  const outputPath = path.join(root, 'output.db');
  fs.writeFileSync(stagePath, 'production-derived bytes', { mode: 0o600 });
  fs.chmodSync(stagePath, 0o600);
  fs.linkSync(stagePath, outputPath);
  const journal = writePublicationRecoveryJournal(root, {
    runId: 'e'.repeat(32), outputPath, stagePath
  });
  fs.unlinkSync(stagePath);
  if (!createDanglingFileSymlinkOrSkip(t, stagePath)) {
    fs.rmSync(root, { recursive: true, force: true });
    return;
  }

  try {
    const cleanup = runStaleCleanup(root);
    assert.notEqual(cleanup.status, 0, 'dangling publication stage replacement must fail closed');
    assert.match(cleanup.stderr, /symlink|identity|publication|journal validation|cleanup/i);
    assert.equal(fs.lstatSync(stagePath).isSymbolicLink(), true, 'cleanup must not unlink the dangling replacement');
    assert.equal(fs.lstatSync(outputPath).isFile(), true, 'the surviving output link must remain evidence');
    assert.equal(fs.lstatSync(outputPath, { bigint: true }).nlink, 1n);
    assert.equal(fs.lstatSync(journal).isFile(), true, 'unsafe publication evidence must retain the journal');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stale cleanup treats a generic dangling cleanup target as present and unsafe', { skip: !HAS_BASH }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-dangling-cleanup-target-'));
  fs.chmodSync(root, 0o700);
  const sourcePath = path.join(root, 'source.db');
  const outputPath = path.join(root, 'output.db');
  const stagePath = path.join(root, 'stage.db');
  fs.writeFileSync(sourcePath, 'source', { mode: 0o600 });
  fs.writeFileSync(outputPath, 'output', { mode: 0o600 });
  fs.writeFileSync(stagePath, 'production-derived bytes', { mode: 0o600 });
  const journal = writeCleanupJournal(root, 'f'.repeat(32), null, stagePath, exactDeadCleanupIdentity());
  fs.unlinkSync(stagePath);
  if (!createDanglingFileSymlinkOrSkip(t, stagePath)) {
    fs.rmSync(root, { recursive: true, force: true });
    return;
  }

  try {
    const cleanup = runStaleCleanup(root);
    assert.notEqual(cleanup.status, 0, 'dangling generic cleanup target must fail closed');
    assert.match(cleanup.stderr, /symlink|identity|journal validation|cleanup/i);
    assert.equal(fs.lstatSync(stagePath).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(sourcePath, 'utf8'), 'source');
    assert.equal(fs.readFileSync(outputPath, 'utf8'), 'output');
    assert.equal(fs.lstatSync(journal).isFile(), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stale cleanup requires exact Boolean roles and rejects source-output containment before mutation', {
  skip: !HAS_BASH
}, async (t) => {
  const cases = [
    'source-string-false',
    'output-string-false',
    'cleanup-string-true',
    'cleanup-equals-source',
    'cleanup-equals-output',
    'cleanup-ancestor-source',
    'published-output-ancestor',
    'cleanup-descendant-source',
    'cleanup-descendant-output',
    'source-contains-output'
  ];

  for (const kind of cases) {
    await t.test(kind, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `tm-cleanup-role-${kind}-`));
      fs.chmodSync(root, 0o700);
      const makeFile = (target, contents) => {
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        fs.writeFileSync(target, contents, { mode: 0o600 });
        fs.chmodSync(target, 0o600);
      };
      let sourcePath = path.join(root, 'source.db');
      let outputPath = path.join(root, 'output.db');
      let cleanupPath = path.join(root, 'stage.db');
      let cleanupRole = 'stage';
      let includeCleanup = true;

      if (kind === 'cleanup-ancestor-source') {
        cleanupPath = path.join(root, 'source-container');
        sourcePath = path.join(cleanupPath, 'source.db');
      } else if (kind === 'published-output-ancestor') {
        cleanupRole = 'publishedOutput';
        cleanupPath = path.join(root, 'output-container');
        outputPath = path.join(cleanupPath, 'output.db');
      } else if (kind === 'cleanup-descendant-source') {
        sourcePath = path.join(root, 'source-container');
        cleanupPath = path.join(sourcePath, 'derived-stage.db');
      } else if (kind === 'cleanup-descendant-output') {
        outputPath = path.join(root, 'output-container');
        cleanupPath = path.join(outputPath, 'derived-stage.db');
      } else if (kind === 'source-contains-output') {
        sourcePath = path.join(root, 'source-container');
        outputPath = path.join(sourcePath, 'output.db');
        includeCleanup = false;
      }

      if (kind === 'cleanup-descendant-source' || kind === 'source-contains-output') {
        fs.mkdirSync(sourcePath, { recursive: true, mode: 0o700 });
      } else {
        makeFile(sourcePath, 'live-source');
      }
      if (kind === 'cleanup-descendant-output') {
        fs.mkdirSync(outputPath, { recursive: true, mode: 0o700 });
      } else {
        makeFile(outputPath, 'live-output');
      }
      if (includeCleanup && cleanupPath !== sourcePath && cleanupPath !== outputPath) {
        if (kind === 'cleanup-ancestor-source' || kind === 'published-output-ancestor') {
          fs.chmodSync(cleanupPath, 0o700);
        } else {
          makeFile(cleanupPath, 'cleanup-evidence');
        }
      }

      const paths = {
        source: { path: sourcePath, cleanup: false },
        output: { path: outputPath, cleanup: false }
      };
      if (kind === 'source-string-false') {
        paths.source = { ...cleanupPathRecord(sourcePath), cleanup: 'false' };
      } else if (kind === 'output-string-false') {
        paths.output = { ...cleanupPathRecord(outputPath), cleanup: 'false' };
      }
      if (includeCleanup) {
        if (kind === 'cleanup-equals-source') cleanupPath = sourcePath;
        if (kind === 'cleanup-equals-output') cleanupPath = outputPath;
        paths[cleanupRole] = {
          ...cleanupPathRecord(cleanupPath),
          cleanup: kind === 'cleanup-string-true' ? 'true' : true
        };
      }
      const runId = crypto.createHash('md5').update(`role-${kind}`).digest('hex');
      const journal = writePathRoleJournal(root, runId, paths);

      try {
        const cleanup = runStaleCleanup(root);
        assert.notEqual(cleanup.status, 0, `${kind} must fail journal validation`);
        assert.match(cleanup.stderr, /boolean|cleanup|overlap|source|output|journal validation/i);
        assert.doesNotThrow(() => fs.lstatSync(sourcePath), `${kind} must preserve source`);
        assert.doesNotThrow(() => fs.lstatSync(outputPath), `${kind} must preserve output`);
        if (includeCleanup) assert.doesNotThrow(() => fs.lstatSync(cleanupPath), `${kind} must preserve cleanup evidence`);
        assert.equal(fs.lstatSync(journal).isFile(), true, `${kind} must retain its journal`);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test('stale cleanup rejects incomplete or unsafe publication hardlink pairs', { skip: !HAS_BASH }, () => {
  for (const kind of ['output-absent', 'different-inode', 'extra-link', 'wrong-role', 'unbound-stage']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `tm-unsafe-publication-${kind}-`));
    fs.chmodSync(root, 0o700);
    const stagePath = path.join(root, 'publication-stage.db');
    const outputPath = path.join(root, 'output.db');
    const extraPath = path.join(root, 'extra-link.db');
    fs.writeFileSync(stagePath, 'production-derived bytes', { mode: 0o600 });
    fs.chmodSync(stagePath, 0o600);
    if (kind === 'output-absent' || kind === 'different-inode') fs.linkSync(stagePath, extraPath);
    if (kind === 'different-inode') fs.writeFileSync(outputPath, 'different inode', { mode: 0o600 });
    if (!['output-absent', 'different-inode'].includes(kind)) fs.linkSync(stagePath, outputPath);
    if (kind === 'extra-link') fs.linkSync(stagePath, extraPath);
    const journal = writePublicationRecoveryJournal(root, {
      runId: crypto.createHash('md5').update(kind).digest('hex'),
      outputPath,
      stagePath,
      stageRole: kind === 'wrong-role' ? 'workerOutput' : 'publicationStage',
      bound: kind !== 'unbound-stage'
    });
    try {
      const cleanup = runStaleCleanup(root);
      assert.notEqual(cleanup.status, 0, `${kind} publication evidence must fail closed`);
      assert.match(cleanup.stderr, /hardlink|publication|identity|journal validation|cleanup/i);
      assert.equal(fs.existsSync(journal), true, `${kind} must retain its journal`);
      assert.equal(fs.existsSync(stagePath), true, `${kind} must retain its stage evidence`);
      if (kind !== 'output-absent') assert.equal(fs.existsSync(outputPath), true, `${kind} must retain its output evidence`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('POSIX stale cleanup rejects unsafe publication pair metadata', {
  skip: !HAS_BASH || process.platform === 'win32'
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-unsafe-publication-mode-'));
  fs.chmodSync(root, 0o700);
  const stagePath = path.join(root, 'publication-stage.db');
  const outputPath = path.join(root, 'output.db');
  fs.writeFileSync(stagePath, 'production-derived bytes', { mode: 0o600 });
  fs.linkSync(stagePath, outputPath);
  fs.chmodSync(stagePath, 0o644);
  const journal = writePublicationRecoveryJournal(root, {
    runId: 'd'.repeat(32), outputPath, stagePath
  });
  try {
    const cleanup = runStaleCleanup(root);
    assert.notEqual(cleanup.status, 0, 'unsafe publication metadata must fail closed');
    assert.match(cleanup.stderr, /mode|metadata|publication|cleanup/i);
    assert.equal(fs.existsSync(journal), true);
    assert.equal(fs.existsSync(stagePath), true);
    assert.equal(fs.existsSync(outputPath), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Linux stale cleanup kills only an exact run-bound process identity', async (t) => {
  if (process.platform === 'win32') {
    runLinuxTestThroughWsl(t, '^Linux stale cleanup kills only an exact run-bound process identity$');
    return;
  }
  const scriptPath = path.join(__dirname, '..', 'scripts', 'cleanup_stale_migration_gate.sh');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-live-cleanup-'));
  fs.chmodSync(root, 0o700);
  const env = { ...process.env, TM_GATE_TEST_MODE: '1', TM_GATE_JOURNAL_ROOT: root, TM_GATE_ALLOWED_ROOTS: root };

  const exactRunId = 'f'.repeat(32);
  const exactStage = path.join(root, 'exact-stage');
  fs.mkdirSync(exactStage, { mode: 0o700 });
  const descendantPidPath = path.join(root, 'exact-descendant.pid');
  const exactChild = spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    const { spawn } = require('node:child_process');
    const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    fs.writeFileSync(process.argv[1], String(descendant.pid));
    setInterval(() => {}, 1000);
  `, descendantPidPath, '--', '--worker', '--run-id', exactRunId], { stdio: 'ignore', detached: true });
  try {
    for (let attempt = 0; attempt < 50 && !fs.existsSync(descendantPidPath); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(fs.existsSync(descendantPidPath), true, 'fixture descendant must start in the detached process group');
    const descendantPid = Number(fs.readFileSync(descendantPidPath, 'utf8'));
    writeCleanupJournal(
      root,
      exactRunId,
      linuxProcessIdentity(exactChild.pid),
      exactStage,
      exactDeadCleanupIdentity()
    );
    const killed = spawnSync(BASH, [scriptPath, '--all'], { env, encoding: 'utf8' });
    assert.equal(killed.status, 0, killed.stderr);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.throws(() => process.kill(exactChild.pid, 0), /ESRCH|no such process/i);
    assert.throws(() => process.kill(descendantPid, 0), /ESRCH|no such process/i, 'cleanup must terminate descendants via -PGID');

    const coordinatorRunId = '8'.repeat(32);
    const coordinatorStage = path.join(root, 'coordinator-stage');
    fs.mkdirSync(coordinatorStage, { mode: 0o700 });
    const coordinatorChild = spawn(process.execPath, [
      '-e', 'setInterval(() => {}, 1000)', '--', '--production',
      '--source', path.join(root, 'source.db'), '--output', path.join(root, 'output.db')
    ], { stdio: 'ignore' });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      writeCleanupJournal(
        root,
        coordinatorRunId,
        null,
        coordinatorStage,
        linuxProcessIdentity(coordinatorChild.pid)
      );
      const coordinatorCleanup = spawnSync(BASH, [scriptPath, '--all'], { env, encoding: 'utf8' });
      assert.equal(coordinatorCleanup.status, 0, coordinatorCleanup.stderr);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.throws(
        () => process.kill(coordinatorChild.pid, 0),
        /ESRCH|no such process/i,
        'cleanup must recognize the real coordinator --production argv without inventing --run-id'
      );
    } finally {
      try { coordinatorChild.kill('SIGKILL'); } catch (_error) {}
    }

    const reusedRunId = '1'.repeat(32);
    const reusedStage = path.join(root, 'reused-stage-v2');
    fs.mkdirSync(reusedStage, { mode: 0o700 });
    const reusedChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '--worker', '--run-id', reusedRunId], {
      stdio: 'ignore', detached: true
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const reusedIdentity = linuxProcessIdentity(reusedChild.pid);
      reusedIdentity.startTimeTicks = String(BigInt(reusedIdentity.startTimeTicks) + 1n);
      writeCleanupJournal(root, reusedRunId, reusedIdentity, reusedStage, exactDeadCleanupIdentity());
      const reconciled = spawnSync(BASH, [scriptPath, '--all'], { env, encoding: 'utf8' });
      assert.notEqual(reconciled.status, 0, 'identity uncertainty must fail closed');
      assert.doesNotThrow(() => process.kill(reusedChild.pid, 0), 'PID reuse mismatch must not be signaled');
      assert.equal(fs.existsSync(path.join(root, `${reusedRunId}.run.json`)), true);
      assert.equal(fs.existsSync(reusedStage), true);
    } finally {
      reusedChild.kill('SIGKILL');
    }
  } finally {
    try { exactChild.kill('SIGKILL'); } catch (_error) {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stale cleanup reconciles centralized v3 journals and removes them', { skip: !HAS_BASH }, (t) => {
  if (process.platform === 'win32') {
    runLinuxTestThroughWsl(t, '^stale cleanup reconciles centralized v3 journals and removes them$');
    return;
  }
  const scriptPath = path.join(__dirname, '..', 'scripts', 'cleanup_stale_migration_gate.sh');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-v3-cleanup-'));
  fs.chmodSync(root, 0o700);
  const stage = path.join(root, 'stage');
  const nested = path.join(stage, 'child', 'grandchild');
  fs.mkdirSync(nested, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(nested, 'regular'), 'synthetic', { mode: 0o600 });
  const journal = writeCleanupJournal(root, '9'.repeat(32), null, stage, exactDeadCleanupIdentity());
  const env = { ...process.env, TM_GATE_TEST_MODE: '1', TM_GATE_JOURNAL_ROOT: root, TM_GATE_ALLOWED_ROOTS: root };
  const cleanup = spawnSync(BASH, [scriptPath, '--all'], { env, encoding: 'utf8' });
  assert.equal(cleanup.status, 0, cleanup.stderr);
  assert.equal(fs.existsSync(stage), false);
  assert.equal(fs.existsSync(journal), false);

  const uncertainStage = path.join(root, 'uncertain-stage');
  fs.mkdirSync(uncertainStage, { mode: 0o700 });
  const uncertainRunId = 'a'.repeat(32);
  const uncertainJournal = writeCleanupJournal(
    root,
    uncertainRunId,
    null,
    uncertainStage,
    exactDeadCleanupIdentity(),
    'worker-launch-intent'
  );
  const uncertain = spawnSync(BASH, [scriptPath, '--all'], { env, encoding: 'utf8' });
  assert.notEqual(uncertain.status, 0, 'a launch-intent journal without group identity must fail closed');
  assert.equal(fs.existsSync(uncertainStage), true);
  assert.equal(fs.existsSync(uncertainJournal), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('stale cleanup rejects special nodes and hardlinks without traversing the tree', (t) => {
  if (process.platform === 'win32') {
    runLinuxTestThroughWsl(t, '^stale cleanup rejects special nodes and hardlinks without traversing the tree$');
    return;
  }
  const scriptPath = path.join(__dirname, '..', 'scripts', 'cleanup_stale_migration_gate.sh');
  const nodeKinds = ['hardlink', 'fifo', 'symlink'];
  for (const [index, kind] of nodeKinds.entries()) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `tm-unsafe-cleanup-${kind}-`));
    fs.chmodSync(root, 0o700);
    const stage = path.join(root, 'stage');
    fs.mkdirSync(stage, { mode: 0o700 });
    const outside = path.join(root, 'outside');
    fs.writeFileSync(outside, 'must survive', { mode: 0o600 });
    if (kind === 'hardlink') fs.linkSync(outside, path.join(stage, 'linked'));
    if (kind === 'fifo') assert.equal(spawnSync('mkfifo', [path.join(stage, 'pipe')]).status, 0);
    if (kind === 'symlink') fs.symlinkSync(outside, path.join(stage, 'link'));
    writeCleanupJournal(
      root,
      String(index + 2).repeat(32),
      null,
      stage,
      exactDeadCleanupIdentity()
    );
    const env = { ...process.env, TM_GATE_TEST_MODE: '1', TM_GATE_JOURNAL_ROOT: root, TM_GATE_ALLOWED_ROOTS: root };
    const cleanup = spawnSync(BASH, [scriptPath, '--all'], { env, encoding: 'utf8' });
    assert.notEqual(cleanup.status, 0, `${kind} cleanup must fail closed`);
    const expectedFailure = kind === 'hardlink'
      ? /hardlinked file/i
      : kind === 'fifo' ? /special node/i : /symlink/i;
    assert.match(cleanup.stderr, expectedFailure, `${kind} fixture must reach tree-node validation`);
    assert.doesNotMatch(cleanup.stderr, /lacks an exact identity/i);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'must survive');
    assert.equal(fs.existsSync(stage), true);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('production path validation rejects unsafe components, modes, hardlinks, and mount substitution', (t) => {
  if (process.platform === 'win32') {
    runLinuxTestThroughWsl(t, '^production path validation rejects unsafe components, modes, hardlinks, and mount substitution$');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-secure-path-'));
  fs.chmodSync(root, 0o700);
  const nested = path.join(root, 'nested');
  fs.mkdirSync(nested, { mode: 0o700 });
  fs.chmodSync(nested, 0o700);
  const source = path.join(nested, 'source.db');
  fs.writeFileSync(source, 'sqlite-probe', { mode: 0o600 });
  fs.chmodSync(source, 0o600);
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : null;

  assert.doesNotThrow(() => sanitizer._testing.validateSecurePath(source, {
    root,
    expectedUid,
    directoryModes: [0o700],
    fileMode: 0o600,
    mustExist: true,
    rejectMounts: true
  }));

  const hardlink = path.join(nested, 'hardlink.db');
  fs.linkSync(source, hardlink);
  assert.throws(() => sanitizer._testing.validateSecurePath(source, {
    root, expectedUid, directoryModes: [0o700], fileMode: 0o600, mustExist: true, rejectMounts: true
  }), /link/i);
  fs.unlinkSync(hardlink);

  fs.chmodSync(nested, 0o755);
  assert.throws(() => sanitizer._testing.validateSecurePath(source, {
    root, expectedUid, directoryModes: [0o700], fileMode: 0o600, mustExist: true, rejectMounts: true
  }), /mode/i);
  fs.chmodSync(nested, 0o700);

  if (process.platform !== 'win32') {
    const real = path.join(root, 'real');
    const linked = path.join(root, 'linked');
    fs.mkdirSync(real, { mode: 0o700 });
    fs.symlinkSync(real, linked, 'dir');
    assert.throws(() => sanitizer._testing.validateSecurePath(path.join(linked, 'missing.db'), {
      root, expectedUid, directoryModes: [0o700], fileMode: 0o600, mustExist: false, rejectMounts: true
    }), /symbolic|symlink|component/i);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('cleanup systemd unit validates and retains only privileges required for unmount and user removal', { skip: !HAS_BASH }, () => {
  const unitPath = path.join(__dirname, '..', 'systemd', 'turingmarket-gate-cleanup.service');
  const unit = fs.readFileSync(unitPath, 'utf8');
  const directives = new Map();
  for (const rawLine of unit.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('[') || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator > 0) directives.set(line.slice(0, separator), line.slice(separator + 1));
  }
  assert.equal(directives.get('User'), 'root');
  assert.equal(directives.get('ProtectSystem'), 'strict');
  assert.equal(directives.get('PrivateMounts'), 'no', 'cleanup must unmount the host namespace');
  assert.equal(directives.get('PrivateDevices'), 'yes');
  assert.equal(directives.get('RestrictAddressFamilies'), 'AF_UNIX');
  const capabilities = new Set((directives.get('CapabilityBoundingSet') || '').split(/\s+/).filter(Boolean));
  for (const capability of ['CAP_CHOWN', 'CAP_DAC_OVERRIDE', 'CAP_FOWNER', 'CAP_KILL', 'CAP_SETGID', 'CAP_SETUID', 'CAP_SYS_ADMIN']) {
    assert.ok(capabilities.has(capability), `missing cleanup capability ${capability}`);
  }
  const writable = directives.get('ReadWritePaths') || '';
  for (const required of ['/var/lib/turingmarket/migration-gate', '/run/turingmarket-gate', '/etc/passwd', '/etc/shadow', '/etc/group', '/etc/gshadow']) {
    assert.ok(writable.includes(required), `cleanup cannot mutate ${required}`);
  }
  if (process.platform === 'linux' && spawnSync('systemd-analyze', ['--version'], { encoding: 'utf8' }).status === 0) {
    const verified = spawnSync('systemd-analyze', ['verify', unitPath], { encoding: 'utf8' });
    assert.equal(verified.status, 0, verified.stderr);
  }
});

test('forbidden collection covers short secrets, numerics, every JSON leaf, FTS terms, and frozen encodings', () => {
  const fixture = migratedFixture('forbidden-values');
  const populated = populateCriticalReviewFixture(fixture);
  const shortSecret = 'x7';
  fixture.db.prepare('UPDATE users SET password_hash=? WHERE id=(SELECT MIN(id) FROM users)').run(shortSecret);
  const forbidden = sanitizer._testing.collectForbiddenValues(fixture.db, v7Manifest);

  const requiredContexts = [
    ['cell', 'users.password_hash', (entry) => entry.value === shortSecret],
    ['cell', 'brands.youtube_followers', (entry) => entry.storageType === 'integer' && entry.value === 42],
    ['json-key', 'knowledge_entries.metadata_json#/private_key@key', (entry) => entry.value === 'private_key'],
    ['json-leaf', 'knowledge_entries.metadata_json#/short', (entry) => entry.value === 'j7'],
    ['json-leaf', 'knowledge_entries.metadata_json#/numeric', (entry) => entry.storageType === 'integer' && entry.value === 731927],
    ['fts-term', 'knowledge_chunks_fts#private', (entry) => entry.value === 'private']
  ];
  for (const [kind, context, predicate] of requiredContexts) {
    assert.ok(forbidden.logicalEntries.some((entry) => entry.kind === kind && entry.context === context && predicate(entry)), context);
  }
  assert.ok(forbidden.logicalEntries.some((entry) => (
    entry.kind === 'json-key'
      && entry.context === 'campaign_events.metadata_json#/previous_version@key'
      && entry.value === 'previous_version'
  )), 'dynamic JSON keys must remain forbidden even when their names are structural elsewhere');

  const expectedEncodings = {
    utf8: Buffer.from([0x78, 0x37]),
    utf16le: Buffer.from([0x78, 0x00, 0x37, 0x00]),
    utf16be: Buffer.from([0x00, 0x78, 0x00, 0x37]),
    hex: Buffer.from('7837', 'ascii'),
    base64: Buffer.from('eDc=', 'ascii'),
    'sha256-hex': Buffer.from(sha256Text(shortSecret), 'ascii')
  };
  for (const [encoding, bytes] of Object.entries(expectedEncodings)) {
    assert.ok(forbidden.rawProbes.some((probe) => (
      probe.context === 'users.password_hash' && probe.encoding === encoding && probe.bytes.equals(bytes)
    )), `missing ${encoding} short-secret probe`);
  }

  const leakyPath = path.join(fixture.root, 'leaky-copy.db');
  fixture.db.close();
  fs.copyFileSync(fixture.dbPath, leakyPath);
  assert.throws(
    () => sanitizer._testing.assertNoForbiddenValues(leakyPath, forbidden, v7Manifest),
    (error) => {
      assert.equal(error.name, 'SanitizerTypedSourceDomainIntersectionError');
      assert.equal(error.code, 'TM_SANITIZER_TYPED_SOURCE_DOMAIN_INTERSECTION');
      assert.equal(error.context, 'activity_log.action');
      assert.equal(
        error.message,
        'sanitized output has a forbidden complete typed source-domain intersection at activity_log.action'
      );
      return true;
    }
  );
  fs.rmSync(leakyPath, { force: true });
  closeAndRemove(fixture);
  assert.ok(populated.entryId);
});

test('forbidden collection authorizes JSON keys only through their closed path policy', () => {
  const fixture = migratedFixture('json-key-policy');
  try {
    const populated = populateCriticalReviewFixture(fixture, {
      knowledgeEntryMetadata: { previous_version: 7, source: 'private-dynamic-metadata-source' }
    });
    const forbidden = sanitizer._testing.collectForbiddenValues(fixture.db, v7Manifest);

    for (const [key, value] of [['previous_version', 7], ['source', 'private-dynamic-metadata-source']]) {
      const keyContext = `knowledge_entries.metadata_json#/${key}@key`;
      const leafContext = `knowledge_entries.metadata_json#/${key}`;
      assert.ok(
        forbidden.logicalEntries.some((entry) => entry.kind === 'json-key' && entry.context === keyContext && entry.value === key),
        `${key} dynamic metadata key must be forbidden`
      );
      assert.ok(
        forbidden.logicalEntries.some((entry) => entry.kind === 'json-leaf' && entry.context === leafContext && entry.value === value),
        `${key} dynamic metadata value must be forbidden`
      );
      assert.equal(
        forbidden.authorizedEntries.some((entry) => entry.kind === 'json-key' && entry.context === keyContext),
        false,
        `${key} must not be globally authorized by name`
      );
    }

    assert.ok(
      forbidden.authorizedEntries.some((entry) => (
        entry.kind === 'json-key'
          && entry.context === 'workflow_templates.trigger_config_json#/event_type@key'
          && entry.value === 'event_type'
      )),
      'closed workflow trigger key must remain authorized at its declared table, column, and path'
    );

    fixture.db.close();
    const cleanPath = path.join(fixture.root, 'json-key-clean.db');
    sanitizer.sanitizeProductionShape({ sourcePath: fixture.dbPath, outputPath: cleanPath });
    const leakPath = compactSqliteClone(cleanPath, path.join(fixture.root, 'json-key-live-leak.db'), (db) => {
      const triggers = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='knowledge_entries' ORDER BY name").all();
      for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name.replace(/"/g, '""')}"`);
      db.prepare('UPDATE knowledge_entries SET metadata_json=? WHERE id=?')
        .run('{"previous_version":"live-secret-key"}', populated.entryId);
      for (const trigger of triggers) db.exec(trigger.sql);
    });
    assert.throws(
      () => sanitizer._testing.assertNoForbiddenValues(leakPath, forbidden, v7Manifest),
      /knowledge_entries\.metadata_json.*previous_version|previous_version.*knowledge_entries\.metadata_json/i,
      'dynamic JSON keys must remain record-level forbidden even when physical schema text shares their name'
    );
  } finally {
    closeAndRemove(fixture);
  }
});

test('raw leak scanning rejects short raw, UTF, hex, and base64 probes without a length threshold', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-short-raw-probes-'));
  const probes = [
    ['utf8', Buffer.from([0x78, 0x37])],
    ['utf16le', Buffer.from([0x78, 0x00, 0x37, 0x00])],
    ['utf16be', Buffer.from([0x00, 0x78, 0x00, 0x37])],
    ['hex', Buffer.from('7837', 'ascii')],
    ['base64', Buffer.from('eDc=', 'ascii')]
  ];
  try {
    for (const [encoding, bytes] of probes) {
      const outputPath = path.join(root, `${encoding}.db`);
      fs.writeFileSync(outputPath, Buffer.concat([Buffer.from('prefix:'), bytes, Buffer.from(':suffix')]));
      assert.throws(
        () => sanitizer._testing.assertNoRawLeaks(outputPath, {
          rawProbes: [{ context: 'users.password_hash', encoding, bytes }]
        }),
        /classified source leak.*users\.password_hash/i,
        `${encoding} probe shorter than eight bytes must not be skipped`
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('replacement sentinels are confined to manifest-authorized cells and JSON positions', () => {
  assert.deepEqual(v7Manifest.semanticPolicies.replacementSentinels.allowedClassifications, {
    'tmtext-': ['synthetic-text'],
    'tmjson-': ['json-leaves'],
    'tmkey-': ['json-leaves'],
    'tm-node-': ['json-leaves', 'reference-synthetic'],
    'tm-edge-': ['json-leaves'],
    'tm-inert-secret-': ['secret-synthetic'],
    'tm-contact-': ['synthetic-contact']
  });
  const fixture = migratedFixture('sentinel-confinement');
  fixture.db.close();
  const outputPath = path.join(fixture.root, 'sanitized.db');
  sanitizer.sanitizeProductionShape({ sourcePath: fixture.dbPath, outputPath });
  const output = new Database(outputPath);
  try {
    assert.doesNotThrow(() => sanitizer._testing.assertReplacementSentinelsConfined(output, v7Manifest));
    output.prepare("UPDATE schema_migrations SET source_path='tmtext-illegal-structural-cell' WHERE version=(SELECT MIN(version) FROM schema_migrations)").run();
    assert.throws(
      () => sanitizer._testing.assertReplacementSentinelsConfined(output, v7Manifest),
      /sentinel.*schema_migrations\.source_path|classified/i
    );
    output.prepare("UPDATE schema_migrations SET source_path='migrations/fixture.js' WHERE version=(SELECT MIN(version) FROM schema_migrations)").run();
    const metadataColumn = v7Manifest.objects
      .find((object) => object.name === 'knowledge_entries').columns
      .find((column) => column.name === 'metadata_json');
    assert.throws(
      () => sanitizer._testing.assertJsonSentinels(
        { leak: 'tm-node-illegal-json-position' },
        'knowledge_entries.metadata_json',
        metadataColumn.classification,
        v7Manifest.semanticPolicies.replacementSentinels,
        metadataColumn.jsonPolicy
      ),
      /sentinel.*knowledge_entries\.metadata_json.*\/leak|authorized JSON position/i
    );
  } finally {
    output.close();
    closeAndRemove(fixture);
  }
});

test('sanitizer pipeline rejects replacement sentinels that escape classified positions', () => {
  const fixture = migratedFixture('pipeline-sentinel-confinement');
  fixture.db.prepare(
    "UPDATE users SET role='tmtext-illegal-structural-cell' WHERE id=(SELECT MIN(id) FROM users)"
  ).run();
  fixture.db.close();
  try {
    assert.throws(
      () => sanitizer.sanitizeProductionShape({
        sourcePath: fixture.dbPath,
        outputPath: path.join(fixture.root, 'must-not-publish.db')
      }),
      /structural policy rejected.*users\.role|replacement sentinel.*classified column/i
    );
  } finally {
    closeAndRemove(fixture);
  }
});

test('knowledge-entry reference semantics exclude web URL identifiers', () => {
  const fixture = migratedFixture('knowledge-reference-web-predicate');
  try {
    const populated = populateCriticalReviewFixture(fixture);
    const baseline = sanitizer._testing.captureSemanticShape(fixture.db, v7Manifest);
    fixture.db.prepare(`
      INSERT INTO ai_references (
        id,message_id,reference_type,reference_id,title,url,snippet,provider,metadata_json
      ) VALUES (?,?,'web',?,'Public source',?,'Public snippet','test-provider','{}')
    `).run(
      populated.referenceId + 1,
      populated.messageId,
      'https://example.invalid/source',
      'https://example.invalid/source'
    );

    const withWebReference = sanitizer._testing.captureSemanticShape(fixture.db, v7Manifest);
    assert.deepEqual(
      withWebReference.referenceGroups['campaign-knowledge-record-id'],
      baseline.referenceGroups['campaign-knowledge-record-id']
    );
  } finally {
    closeAndRemove(fixture);
  }
});

test('knowledge-entry reference semantics still reject non-canonical knowledge identifiers', () => {
  const fixture = migratedFixture('knowledge-reference-invalid-knowledge-id');
  try {
    const populated = populateCriticalReviewFixture(fixture);
    fixture.db.prepare('UPDATE ai_references SET reference_id=? WHERE id=?').run(
      'https://example.invalid/not-a-knowledge-id',
      populated.referenceId
    );

    assert.throws(
      () => sanitizer._testing.captureSemanticShape(fixture.db, v7Manifest),
      /non-canonical decimal semantic reference.*ai_references\.reference_id/i
    );
  } finally {
    closeAndRemove(fixture);
  }
});

test('sanitizer preserves legacy knowledge references while sanitizing web reference identifiers', () => {
  const fixture = migratedFixture('knowledge-reference-legacy-full-pipeline');
  try {
    const populated = populateCriticalReviewFixture(fixture);
    const webReferenceId = populated.referenceId + 1;
    const webUrl = 'https://example.invalid/public-source';
    const referenceTriggers = fixture.db.prepare(`
      SELECT name,sql FROM sqlite_schema
      WHERE type='trigger' AND tbl_name='ai_references' ORDER BY name
    `).all();
    for (const trigger of referenceTriggers) {
      fixture.db.exec(`DROP TRIGGER "${trigger.name.replace(/"/g, '""')}"`);
    }
    fixture.db.prepare(`
      UPDATE ai_references
      SET reference_schema_version=NULL,knowledge_entry_id=NULL,knowledge_chunk_id=NULL,campaign_id=NULL,
        source_identity_sha256=NULL,entry_content_sha256=NULL,chunk_content_sha256=NULL,
        reference_rank=NULL,selection_origin=NULL
      WHERE id=?
    `).run(populated.referenceId);
    for (const trigger of referenceTriggers) fixture.db.exec(trigger.sql);
    fixture.db.prepare(`
      INSERT INTO ai_references (
        id,message_id,reference_type,reference_id,title,url,snippet,provider,metadata_json
      ) VALUES (?,?,'web',?,'Public source',?,'Public snippet','test-provider','{}')
    `).run(webReferenceId, populated.messageId, webUrl, webUrl);
    fixture.db.close();

    const outputPath = path.join(fixture.root, 'sanitized-legacy-references.db');
    assert.doesNotThrow(
      () => sanitizer.sanitizeProductionShape({ sourcePath: fixture.dbPath, outputPath })
    );
    const output = new Database(outputPath, { readonly: true, fileMustExist: true });
    try {
      assert.deepEqual(
        output.prepare(`
          SELECT reference_type,reference_id,reference_schema_version,knowledge_entry_id
          FROM ai_references WHERE id=?
        `).get(populated.referenceId),
        {
          reference_type: 'knowledge',
          reference_id: String(populated.entryId),
          reference_schema_version: null,
          knowledge_entry_id: null
        }
      );
      const webReference = output.prepare(`
        SELECT reference_type,reference_id FROM ai_references WHERE id=?
      `).get(webReferenceId);
      assert.equal(webReference.reference_type, 'web');
      assert.notEqual(webReference.reference_id, webUrl);
      assert.match(webReference.reference_id, /^tmtext-[0-9a-f]{32}$/);
    } finally {
      output.close();
    }
  } finally {
    closeAndRemove(fixture);
  }
});

test('per-PK semantic shape preserves exact NULLs, storage classes, and equality partitions', () => {
  const fixture = migratedFixture('per-pk-shape');
  const rows = [
    [882101, 1.0, 101, 'partition-A'],
    [882102, 1.0, 101, 'partition-A'],
    [882103, 2.5, 202, 'partition-B'],
    [882104, 3.5, 303, 'partition-C'],
    [882105, 4.5, 404, Buffer.from([0x00, 0x81, 0xfe, 0x41])],
    [882106, null, null, null]
  ];
  const insert = fixture.db.prepare(`
    INSERT INTO brands (id,name,name_cn,amazon_rating,youtube_followers,creative_angles,created_at)
    VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)
  `);
  for (const [id, rating, followers, angle] of rows) {
    insert.run(id, `shape-${id}`, `shape-cn-${id}`, rating, followers, angle);
  }
  const before = sanitizer._testing.captureSemanticShape(fixture.db, v7Manifest);
  fixture.db.close();
  const outputPath = path.join(fixture.root, 'sanitized.db');
  sanitizer.sanitizeProductionShape({ sourcePath: fixture.dbPath, outputPath });
  const output = new Database(outputPath);
  try {
    const after = sanitizer._testing.captureSemanticShape(output, v7Manifest);
    assert.doesNotThrow(() => sanitizer._testing.assertSemanticShapePreserved(before, after));
    assert.equal(output.prepare('SELECT typeof(creative_angles) AS type FROM brands WHERE id=882105').get().type, 'blob');
    assert.equal(output.prepare('SELECT typeof(amazon_rating) AS type FROM brands WHERE id=882101').get().type, 'real');

    const textValue = output.prepare('SELECT creative_angles AS value FROM brands WHERE id=882104').get().value;
    output.prepare('UPDATE brands SET creative_angles=? WHERE id=882106').run(textValue);
    output.prepare('UPDATE brands SET creative_angles=NULL WHERE id=882104').run();
    assert.throws(
      () => sanitizer._testing.assertSemanticShapePreserved(after, sanitizer._testing.captureSemanticShape(output, v7Manifest)),
      /NULL.*brands\.creative_angles|row-level NULL/i
    );
    output.prepare('UPDATE brands SET creative_angles=? WHERE id=882104').run(textValue);
    output.prepare('UPDATE brands SET creative_angles=NULL WHERE id=882106').run();

    const blobValue = output.prepare('SELECT creative_angles AS value FROM brands WHERE id=882105').get().value;
    output.prepare('UPDATE brands SET creative_angles=? WHERE id=882105').run(textValue);
    output.prepare('UPDATE brands SET creative_angles=? WHERE id=882104').run(blobValue);
    assert.throws(
      () => sanitizer._testing.assertSemanticShapePreserved(after, sanitizer._testing.captureSemanticShape(output, v7Manifest)),
      /storage class.*brands\.creative_angles/i
    );
    output.prepare('UPDATE brands SET creative_angles=? WHERE id=882105').run(blobValue);
    output.prepare('UPDATE brands SET creative_angles=? WHERE id=882104').run(textValue);

    const first = output.prepare('SELECT creative_angles AS value FROM brands WHERE id=882102').get().value;
    const second = output.prepare('SELECT creative_angles AS value FROM brands WHERE id=882103').get().value;
    output.prepare('UPDATE brands SET creative_angles=? WHERE id=882102').run(second);
    output.prepare('UPDATE brands SET creative_angles=? WHERE id=882103').run(first);
    assert.throws(
      () => sanitizer._testing.assertSemanticShapePreserved(after, sanitizer._testing.captureSemanticShape(output, v7Manifest)),
      /equality partition.*brands\.creative_angles/i
    );
  } finally {
    output.close();
    closeAndRemove(fixture);
  }
});

test('record-level scan authorizes only declared structural contexts and rejects exact substrings in live containers', () => {
  const fixture = migratedFixture('record-contexts');
  const team = fixture.db.prepare('SELECT id,org_id FROM teams ORDER BY id LIMIT 1').get();
  assert.ok(team, 'fixture requires a team');
  const organizationCode = fixture.db.prepare('SELECT code FROM organizations WHERE id=?').get(team.org_id).code;
  const identityTriggers = fixture.db.prepare(`
    SELECT name,sql FROM sqlite_schema
    WHERE type='trigger' AND tbl_name IN ('teams','organizations') ORDER BY name
  `).all();
  for (const trigger of identityTriggers) fixture.db.exec(`DROP TRIGGER "${trigger.name.replace(/"/g, '""')}"`);
  fixture.db.prepare('UPDATE teams SET code=? WHERE id=?').run('code', team.id);
  for (const trigger of identityTriggers) fixture.db.exec(trigger.sql);
  fixture.db.prepare('UPDATE users SET password_hash=? WHERE id=(SELECT MIN(id) FROM users)').run(organizationCode);
  const targetBrandId = Number(fixture.db.prepare(`
    INSERT INTO brands (name,name_cn,creative_angles,created_at)
    VALUES ('record-context-target','record-context-target','source-safe',CURRENT_TIMESTAMP)
  `).run().lastInsertRowid);
  const forbidden = sanitizer._testing.collectForbiddenValues(fixture.db, v7Manifest);
  assert.ok(forbidden.rawProbes.some((probe) => (
    probe.context === 'teams.code'
      && probe.encoding === 'utf8'
      && probe.bytes.equals(Buffer.from('code'))
  )), 'schema text must not globally suppress a secret probe');
  fixture.db.close();

  const cleanPath = path.join(fixture.root, 'clean.db');
  sanitizer.sanitizeProductionShape({ sourcePath: fixture.dbPath, outputPath: cleanPath });
  assert.ok(fs.readFileSync(cleanPath).includes(Buffer.from('code')), 'fixture must contain the schema/structural collision');
  assert.doesNotThrow(() => sanitizer._testing.assertNoForbiddenValues(cleanPath, forbidden, v7Manifest));

  const leakPath = compactSqliteClone(cleanPath, path.join(fixture.root, 'context-leak.db'), (db) => {
    db.prepare('UPDATE brands SET creative_angles=? WHERE id=?').run('prefix:code:suffix', targetBrandId);
  });
  assert.throws(
    () => sanitizer._testing.assertNoForbiddenValues(leakPath, forbidden, v7Manifest),
    (error) => {
      assert.match(error.message, /teams\.code/i);
      assert.match(error.message, /brands\.creative_angles/i);
      return true;
    }
  );

  const containerPath = compactSqliteClone(cleanPath, path.join(fixture.root, 'container.db'), (db) => {
    db.prepare('UPDATE brands SET creative_angles=? WHERE id=?').run('prefixcodesuffix', targetBrandId);
  });
  assert.throws(
    () => sanitizer._testing.assertNoForbiddenValues(containerPath, forbidden, v7Manifest),
    (error) => {
      assert.match(error.message, /teams\.code/i);
      assert.match(error.message, /brands\.creative_angles/i);
      return true;
    },
    'a short secret embedded inside a longer live value must fail exact substring scanning'
  );

  const freeSpaceMarker = 'free-space:code:marker';
  const freeSpacePath = compactSqliteClone(cleanPath, path.join(fixture.root, 'free-space.db'), (db) => {
    const deletedId = Number(db.prepare(`
      INSERT INTO brands (name,name_cn,creative_angles,created_at)
      VALUES ('free-space-row','free-space-row',?,CURRENT_TIMESTAMP)
    `).run(freeSpaceMarker).lastInsertRowid);
    db.prepare('DELETE FROM brands WHERE id=?').run(deletedId);
  }, { vacuum: false });
  assert.ok(fs.readFileSync(freeSpacePath).includes(Buffer.from(freeSpaceMarker)), 'fixture must retain a non-live page coincidence');
  assert.throws(
    () => sanitizer._testing.assertNoForbiddenValues(freeSpacePath, forbidden, v7Manifest),
    /teams\.code|classified source leak/i,
    'physical scanning must reject a complete short secret in non-live page bytes'
  );
  closeAndRemove(fixture);
});

test('record-level scan rejects live UTF, hex, base64, aligned UTF-16, and short numeric representations', () => {
  const fixture = migratedFixture('record-encodings');
  fixture.db.prepare('UPDATE users SET password_hash=? WHERE id=(SELECT MIN(id) FROM users)').run('x7');
  const targetBrandId = Number(fixture.db.prepare(`
    INSERT INTO brands (name,name_cn,youtube_followers,creative_angles,created_at)
    VALUES ('record-encoding-target','record-encoding-target',731927,'source-safe',CURRENT_TIMESTAMP)
  `).run().lastInsertRowid);
  const forbidden = sanitizer._testing.collectForbiddenValues(fixture.db, v7Manifest);
  fixture.db.close();
  const cleanPath = path.join(fixture.root, 'clean.db');
  sanitizer.sanitizeProductionShape({ sourcePath: fixture.dbPath, outputPath: cleanPath });
  const utf16beValue = Buffer.from([0x00, 0x3a, 0x00, 0x78, 0x00, 0x37, 0x00, 0x3b]);
  const cases = [
    ['utf8', 'prefix:x7:suffix'],
    ['hex', 'prefix:7837:suffix'],
    ['base64', 'prefix:eDc=:suffix'],
    ['utf16le', Buffer.from(':x7;', 'utf16le')],
    ['utf16be', utf16beValue],
    ['numeric-delimited', 'count:731927;'],
    ['numeric-container', 'prefix731927suffix']
  ];
  try {
    for (const [encoding, value] of cases) {
      const candidatePath = compactSqliteClone(cleanPath, path.join(fixture.root, `${encoding}.db`), (db) => {
        db.prepare('UPDATE brands SET creative_angles=? WHERE id=?').run(value, targetBrandId);
      });
      assert.throws(
        () => sanitizer._testing.assertNoForbiddenValues(candidatePath, forbidden, v7Manifest),
        (error) => {
          assert.match(error.message, /forbidden|leak/i);
          assert.match(error.message, /brands\.creative_angles/i);
          return true;
        },
        `${encoding} live-field representation must fail`
      );
    }

    const crossNumericPath = compactSqliteClone(cleanPath, path.join(fixture.root, 'cross-numeric.db'), (db) => {
      db.prepare('UPDATE brands SET amazon_rating=? WHERE id=?').run(731927, targetBrandId);
    });
    assert.throws(
      () => sanitizer._testing.assertNoForbiddenValues(crossNumericPath, forbidden, v7Manifest),
      (error) => {
        assert.match(error.message, /brands\.youtube_followers/i);
        assert.match(error.message, /brands\.amazon_rating/i);
        return true;
      },
      'a complete numeric value must not be exempted when it moves to another numeric context'
    );

    const physicalShortPath = compactSqliteClone(cleanPath, path.join(fixture.root, 'physical-short.db'), (db) => {
      const deletedId = Number(db.prepare(`
        INSERT INTO brands (name,name_cn,creative_angles,created_at)
        VALUES ('physical-short-row','physical-short-row','prefixx7suffix',CURRENT_TIMESTAMP)
      `).run().lastInsertRowid);
      db.prepare('DELETE FROM brands WHERE id=?').run(deletedId);
    }, { vacuum: false });
    assert.ok(fs.readFileSync(physicalShortPath).includes(Buffer.from('prefixx7suffix')));
    assert.throws(
      () => sanitizer._testing.assertNoForbiddenValues(physicalShortPath, forbidden, v7Manifest),
      /users\.password_hash|classified source leak/i,
      'physical scanning must not exempt a complete short sensitive value'
    );
  } finally {
    closeAndRemove(fixture);
  }
});

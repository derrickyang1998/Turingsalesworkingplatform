const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const baseline = require('../migrations/baselines/legacy_v1');
const migration001 = require('../migrations/001_legacy_compat_columns');

const LEDGER_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL CHECK (
    length(checksum) = 64
    AND checksum = lower(checksum)
    AND checksum NOT GLOB '*[^0-9a-f]*'
  ),
  source_path TEXT NOT NULL,
  engine_version INTEGER NOT NULL CHECK (engine_version > 0),
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(strftime('%Y-%m-%d %H:%M:%S',applied_at) IS NOT NULL AND strftime('%Y-%m-%d %H:%M:%S',applied_at)=applied_at)
) STRICT`;

const BASELINE_TABLES = [
  'users',
  'brands',
  'sessions',
  'demands',
  'proposals',
  'token_usage',
  'activity_log',
  'team_invites',
  'customers',
  'customer_activity',
  'influencers',
  'collaborations',
  'workflow_templates',
  'workflow_instances',
  'workflow_tasks',
  'workflow_timers',
  'workflow_node_logs',
  'leads',
  'opportunities',
  'sales_targets',
  'activity_log_ext',
  'knowledge_entries',
  'knowledge_chunks',
  'knowledge_chunks_fts',
  'ai_conversations',
  'ai_messages',
  'ai_references',
  'web_search_cache'
];

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function u64(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('U64 value must be a non-negative safe integer');
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(value));
  return buffer;
}

function frame(bytes) {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return Buffer.concat([u64(data.length), data]);
}

function validateRepoPath(repoPath) {
  if (typeof repoPath !== 'string') throw new Error('checksum path must be a string');
  if (path.isAbsolute(repoPath) || repoPath.includes('\\')) throw new Error(`invalid checksum path: ${repoPath}`);
  const normalized = repoPath.normalize('NFC');
  const parts = normalized.split('/');
  if (normalized !== repoPath || parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`invalid checksum path: ${repoPath}`);
  }
  return normalized;
}

function computeMigrationChecksum(options) {
  const engineVersion = options.engineVersion;
  const files = options.files || [];
  if (!Number.isSafeInteger(engineVersion) || engineVersion < 1) throw new Error('engineVersion must be a positive safe integer');
  const chunks = [frame(Buffer.from('tm-migration-checksum-v1', 'utf8')), u64(engineVersion), u64(files.length)];
  for (const file of files) {
    const repoPath = validateRepoPath(file.path);
    const bytes = Buffer.isBuffer(file.bytes) ? file.bytes : Buffer.from(file.bytes || '');
    chunks.push(frame(Buffer.from(repoPath, 'utf8')));
    chunks.push(frame(bytes));
  }
  return sha256Hex(Buffer.concat(chunks));
}

function defaultMigrations() {
  return [migration001];
}

function migrationInputs(migration, rootDir) {
  const sourcePath = validateRepoPath(migration.sourcePath);
  const enginePath = `migrations/engines/v${migration.engineVersion}.js`;
  const baselinePath = 'migrations/baselines/legacy_v1.js';
  const paths = [sourcePath, enginePath, baselinePath, ...(migration.dependencies || [])];
  const seen = new Set();
  return paths.map((repoPath) => {
    const validPath = validateRepoPath(repoPath);
    if (seen.has(validPath)) throw new Error(`duplicate dependency path: ${validPath}`);
    seen.add(validPath);
    const absolute = path.join(rootDir, ...validPath.split('/'));
    return { path: validPath, bytes: fs.readFileSync(absolute) };
  });
}

function assertNoUndeclaredLocalImports(migration, rootDir) {
  if (migration.checksum) return;
  const absolute = path.join(rootDir, ...migration.sourcePath.split('/'));
  const source = fs.readFileSync(absolute, 'utf8');
  const allowed = new Set([
    `./engines/v${migration.engineVersion}`,
    './engines/v1',
    '../migrations/engines/v1',
    './baselines/legacy_v1'
  ]);
  const dependencySet = new Set((migration.dependencies || []).map((dependency) => './' + dependency.replace(/^migrations\//, '')));
  const pattern = /require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const request = match[1].replace(/\.js$/, '');
    if (!allowed.has(request) && !dependencySet.has(request) && !request.endsWith(`/engines/v${migration.engineVersion}`)) {
      throw new Error(`undeclared local import in ${migration.sourcePath}: ${request}`);
    }
  }
}

function computeRegisteredMigrationChecksum(migration, options) {
  if (migration.checksum) return migration.checksum;
  const rootDir = options && options.rootDir ? options.rootDir : path.resolve(__dirname, '..');
  assertNoUndeclaredLocalImports(migration, rootDir);
  return computeMigrationChecksum({
    engineVersion: migration.engineVersion,
    files: migrationInputs(migration, rootDir)
  });
}

function userObjects(db) {
  return db.prepare("SELECT name,type FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
}

function hasObject(db, name) {
  return db.prepare("SELECT 1 FROM sqlite_schema WHERE name = ?").get(name) != null;
}

function hasExactLedgerShape(db) {
  if (!hasObject(db, 'schema_migrations')) return false;
  const cols = db.prepare('PRAGMA table_info(schema_migrations)').all().map((column) => column.name);
  return ['version', 'name', 'checksum', 'source_path', 'engine_version', 'applied_at'].every((column) => cols.includes(column));
}

function ensureNoDuplicateRegistered(migrations) {
  const versions = new Set();
  const names = new Set();
  for (const migration of migrations) {
    if (versions.has(migration.version)) throw new Error(`duplicate migration version ${migration.version}`);
    if (names.has(migration.name)) throw new Error(`duplicate migration name ${migration.name}`);
    versions.add(migration.version);
    names.add(migration.name);
  }
}

function classifyDatabase(db, options) {
  const migrations = (options && options.migrations) || defaultMigrations();
  const maxVersion = Math.max(...migrations.map((migration) => migration.version));
  const objects = userObjects(db);
  const objectNames = objects.map((object) => object.name);
  const hasLedger = objectNames.includes('schema_migrations');
  if (!hasLedger && objectNames.length === 0) return { status: 'empty', currentVersion: 0 };
  if (!hasLedger) {
    const missing = BASELINE_TABLES.filter((table) => !objectNames.includes(table));
    return missing.length === 0 ? { status: 'legacy', currentVersion: 0 } : { status: 'partial_or_malformed', reason: `missing baseline objects: ${missing.join(',')}` };
  }
  if (!hasExactLedgerShape(db)) return { status: 'partial_or_malformed', reason: 'malformed schema_migrations ledger' };

  let rows;
  try {
    rows = db.prepare('SELECT version,name,checksum,source_path,engine_version FROM schema_migrations ORDER BY version').all();
  } catch (error) {
    return { status: 'partial_or_malformed', reason: error.message };
  }
  const seenVersions = new Set();
  const seenNames = new Set();
  for (const row of rows) {
    if (!Number.isSafeInteger(row.version) || row.version < 1 || !row.name || !/^[0-9a-f]{64}$/.test(row.checksum || '') || !row.source_path || !Number.isSafeInteger(row.engine_version) || row.engine_version < 1) {
      return { status: 'partial_or_malformed', reason: 'malformed ledger row' };
    }
    if (seenVersions.has(row.version) || seenNames.has(row.name)) return { status: 'partial_or_malformed', reason: 'duplicate ledger row' };
    seenVersions.add(row.version);
    seenNames.add(row.name);
    if (row.version > maxVersion) return { status: 'future', currentVersion: row.version };
  }
  for (let version = 1; version <= rows.length; version += 1) {
    if (rows[version - 1].version !== version) return { status: 'partial_or_malformed', reason: 'gapped ledger' };
  }
  for (const row of rows) {
    const migration = migrations.find((candidate) => candidate.version === row.version);
    if (!migration || migration.name !== row.name) return { status: 'partial_or_malformed', reason: 'unknown ledger migration' };
    const expected = computeRegisteredMigrationChecksum(migration, options || {});
    if (expected !== row.checksum || migration.sourcePath !== row.source_path || migration.engineVersion !== row.engine_version) {
      return { status: 'partial_or_malformed', reason: `checksum/schema mismatch for ${row.name}` };
    }
  }
  return { status: 'managed', currentVersion: rows.length ? rows[rows.length - 1].version : 0 };
}

function createLedger(db) {
  db.exec(LEDGER_SQL);
}

function preflight(db, classification) {
  db.pragma('foreign_keys = ON');
  const integrity = db.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') throw new Error(`integrity_check failed: ${integrity}`);
  const fkRows = db.pragma('foreign_key_check');
  if (fkRows.length) throw new Error(`foreign_key_check failed: ${JSON.stringify(fkRows.map((row) => ({ table: row.table, rowid: row.rowid, parent: row.parent })))}`);
  if (classification.status === 'legacy' || classification.status === 'managed') {
    const demandOrphans = db.prepare('SELECT COUNT(*) AS count FROM demands d LEFT JOIN users u ON u.id = d.user_id WHERE u.id IS NULL').get().count;
    if (demandOrphans) throw new Error(`orphan relationship demands.user_id -> users.id count=${demandOrphans}`);
    const opportunityOrphans = hasObject(db, 'opportunities')
      ? db.prepare('SELECT COUNT(*) AS count FROM opportunities o LEFT JOIN customers c ON c.id = o.customer_id WHERE c.id IS NULL').get().count
      : 0;
    if (opportunityOrphans) throw new Error(`orphan relationship opportunities.customer_id -> customers.id count=${opportunityOrphans}`);
  }
}

function insertLedgerRow(db, migration, checksum) {
  db.prepare('INSERT INTO schema_migrations (version,name,checksum,source_path,engine_version) VALUES (?, ?, ?, ?, ?)').run(
    migration.version,
    migration.name,
    checksum,
    migration.sourcePath,
    migration.engineVersion
  );
}

function normalizeMigrations(options) {
  const migrations = [...defaultMigrations(), ...((options && options.registeredMigrations) || [])].sort((a, b) => a.version - b.version);
  ensureNoDuplicateRegistered(migrations);
  return migrations;
}

function applySeedAdmissions(db, seedAdmissions) {
  const seeds = seedAdmissions || baseline.seedAdmissions;
  if (seeds && typeof seeds.admin === 'function') seeds.admin(db);
  if (seeds && typeof seeds.influencers === 'function') seeds.influencers(db);
}

function runMigrations(db, options) {
  const normalizedOptions = { ...(options || {}) };
  const migrations = normalizeMigrations(normalizedOptions);
  normalizedOptions.migrations = migrations;
  db.pragma('foreign_keys = ON');

  const classification = classifyDatabase(db, normalizedOptions);
  if (classification.status === 'partial_or_malformed' || classification.status === 'future') {
    throw new Error(`migration classification failed: ${classification.status}${classification.reason ? ` ${classification.reason}` : ''}`);
  }
  preflight(db, classification);

  const transaction = db.transaction(() => {
    const lockedClassification = classifyDatabase(db, normalizedOptions);
    if (lockedClassification.status !== classification.status || lockedClassification.currentVersion !== classification.currentVersion) {
      throw new Error('migration preflight identity changed before write');
    }
    if (classification.status === 'empty') baseline.apply(db);
    if (classification.status !== 'managed') createLedger(db);

    const startVersion = classification.currentVersion || 0;
    for (const migration of migrations) {
      if (migration.version <= startVersion) continue;
      if (migration.engineVersion !== 1) throw new Error(`unsupported migration engine version ${migration.engineVersion}`);
      migration.apply(db);
      const checksum = computeRegisteredMigrationChecksum(migration, normalizedOptions);
      insertLedgerRow(db, migration, checksum);
      if (classification.status !== 'managed' && migration.version === 1) {
        applySeedAdmissions(db, normalizedOptions.seedAdmissions);
      }
    }
    preflight(db, { status: 'managed' });
  });
  transaction.exclusive();
  return classifyDatabase(db, normalizedOptions);
}

module.exports = {
  LEDGER_SQL,
  BASELINE_TABLES,
  computeMigrationChecksum,
  computeRegisteredMigrationChecksum,
  defaultMigrations,
  classifyDatabase,
  createLedger,
  runMigrations
};

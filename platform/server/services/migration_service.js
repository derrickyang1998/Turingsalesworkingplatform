const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const baseline = require('../migrations/baselines/legacy_v1');
const migration001 = require('../migrations/001_legacy_compat_columns');
const sqliteDigest = require('./sqlite_digest_service');

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

const REQUIRED_COLUMNS = {
  users: ['id', 'username', 'password_hash', 'display_name', 'role', 'api_quota', 'is_active'],
  demands: ['id', 'user_id'],
  customers: ['id', 'created_by', 'assigned_to'],
  influencers: ['id'],
  collaborations: ['id', 'demand_id', 'influencer_id', 'user_id', 'cost_actual'],
  opportunities: ['id', 'customer_id'],
  workflow_templates: ['id', 'version', 'is_active'],
  workflow_instances: ['id', 'template_id', 'business_id'],
  workflow_tasks: ['id', 'instance_id'],
  workflow_timers: ['id', 'instance_id'],
  workflow_node_logs: ['id', 'instance_id'],
  knowledge_entries: ['id', 'source_id', 'created_by', 'usage_count'],
  knowledge_chunks: ['id', 'entry_id', 'chunk_index'],
  ai_conversations: ['id', 'user_id', 'archived_summary_id'],
  ai_messages: ['id', 'conversation_id', 'user_id'],
  ai_references: ['id', 'message_id']
};

const SAFE_INTEGER_COLUMNS = {
  users: ['id', 'api_quota', 'is_active'],
  brands: ['id', 'youtube_followers', 'instagram_followers', 'tiktok_followers', 'search_volume_monthly', 'monthly_posts', 'avg_views'],
  sessions: ['id', 'user_id'],
  demands: ['id', 'user_id'],
  proposals: ['id', 'user_id', 'demand_id'],
  token_usage: ['id', 'user_id', 'prompt_tokens', 'completion_tokens', 'total_tokens'],
  activity_log: ['id', 'user_id'],
  team_invites: ['id', 'created_by', 'max_uses', 'uses', 'is_active'],
  customers: ['id', 'created_by', 'assigned_to'],
  customer_activity: ['id', 'customer_id', 'user_id'],
  influencers: ['id', 'followers', 'avg_views_10', 'cost_usd', 'cost_range_min', 'cost_range_max', 'is_active'],
  collaborations: ['id', 'demand_id', 'influencer_id', 'user_id', 'cost_quoted', 'cost_actual', 'row_version', 'cost_actual_confirmed'],
  workflow_templates: ['id', 'version', 'is_active', 'created_by'],
  workflow_instances: ['id', 'template_id', 'business_id', 'started_by'],
  workflow_tasks: ['id', 'instance_id', 'assignee_id', 'completed_by'],
  workflow_timers: ['id', 'instance_id', 'fired'],
  workflow_node_logs: ['id', 'instance_id', 'user_id'],
  leads: ['id', 'lead_score', 'assigned_to', 'converted_customer_id'],
  opportunities: ['id', 'customer_id', 'win_probability', 'created_by'],
  sales_targets: ['id', 'user_id'],
  activity_log_ext: ['id', 'customer_id', 'user_id'],
  knowledge_entries: ['id', 'source_id', 'created_by', 'is_public', 'usage_count'],
  knowledge_chunks: ['id', 'entry_id', 'chunk_index', 'token_count'],
  ai_conversations: ['id', 'user_id', 'archived_summary_id'],
  ai_messages: ['id', 'conversation_id', 'user_id', 'prompt_tokens', 'completion_tokens', 'total_tokens'],
  ai_references: ['id', 'message_id'],
  web_search_cache: ['id']
};

const COMPAT_COLUMNS = {
  row_version: { type: 'INTEGER', notnull: true, defaultValue: '1' },
  cost_actual_confirmed: { type: 'INTEGER', notnull: true, defaultValue: '0' }
};

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

function columnsFor(db, tableName) {
  return db.prepare(`PRAGMA table_info(${JSON.stringify(tableName)})`).all();
}

function baselineShapeProblem(db) {
  for (const table of BASELINE_TABLES) {
    if (!hasObject(db, table)) return `missing baseline object ${table}`;
  }
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    const columns = new Set(columnsFor(db, table).map((column) => column.name));
    for (const column of required) {
      if (!columns.has(column)) return `missing baseline column ${table}.${column}`;
    }
  }
  return null;
}

function compatibilityColumnProblem(db) {
  if (!hasObject(db, 'collaborations')) return null;
  const columns = columnsFor(db, 'collaborations');
  for (const [name, expected] of Object.entries(COMPAT_COLUMNS)) {
    const column = columns.find((candidate) => candidate.name === name);
    if (!column) continue;
    if (String(column.type).toUpperCase() !== expected.type) return `incompatible compatibility column collaborations.${name}`;
    if (expected.notnull && column.notnull !== 1) return `incompatible nullable compatibility column collaborations.${name}`;
    if (String(column.dflt_value) !== expected.defaultValue) return `incompatible default compatibility column collaborations.${name}`;
  }
  return null;
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
    const shapeProblem = baselineShapeProblem(db) || compatibilityColumnProblem(db);
    return shapeProblem ? { status: 'partial_or_malformed', reason: shapeProblem } : { status: 'legacy', currentVersion: 0 };
  }
  if (!hasExactLedgerShape(db)) return { status: 'partial_or_malformed', reason: 'malformed schema_migrations ledger' };
  const shapeProblem = baselineShapeProblem(db) || compatibilityColumnProblem(db);
  if (shapeProblem) return { status: 'partial_or_malformed', reason: shapeProblem };

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

function validateSafeIntegers(db) {
  for (const [table, columns] of Object.entries(SAFE_INTEGER_COLUMNS)) {
    if (!hasObject(db, table)) continue;
    const existing = new Set(columnsFor(db, table).map((column) => column.name));
    for (const column of columns) {
      if (!existing.has(column)) continue;
      const bad = db.prepare(`
        SELECT COUNT(*) AS count
        FROM ${table}
        WHERE ${column} IS NOT NULL
          AND (typeof(${column}) != 'integer' OR ${column} < 0 OR ${column} > 9007199254740991)
      `).get().count;
      if (bad) throw new Error(`unsafe integer storage ${table}.${column} count=${bad}`);
    }
  }
  if (hasObject(db, 'sqlite_sequence')) {
    const badSequence = db.prepare("SELECT COUNT(*) AS count FROM sqlite_sequence WHERE typeof(seq) != 'integer' OR seq < 0 OR seq > 9007199254740991").get().count;
    if (badSequence) throw new Error(`unsafe sqlite_sequence.seq count=${badSequence}`);
  }
}

function digestManifest(db) {
  const knowledgeColumns = hasObject(db, 'knowledge_entries') ? new Set(columnsFor(db, 'knowledge_entries').map((column) => column.name)) : new Set();
  const chunkColumns = hasObject(db, 'knowledge_chunks') ? new Set(columnsFor(db, 'knowledge_chunks').map((column) => column.name)) : new Set();
  if (hasObject(db, 'knowledge_chunks_fts') && knowledgeColumns.has('title') && knowledgeColumns.has('tags_json') && chunkColumns.has('content')) {
    return {
      fts: [{
        virtualName: 'knowledge_chunks_fts',
        projectionName: 'knowledge_chunks_v1',
        tokenizerOptions: 'unicode61',
        keyColumnCsv: 'entry_id,chunk_id',
        indexedColumnCsv: 'title,content,tags'
      }]
    };
  }
  return { fts: [] };
}

function preflightDigest(db) {
  return sqliteDigest.databaseDigest(db, digestManifest(db));
}

function identityForDatabasePath(databasePath) {
  if (!databasePath || databasePath === ':memory:') return null;
  const stat = fs.statSync(databasePath);
  return {
    path: path.resolve(databasePath),
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs
  };
}

function sameIdentity(left, right) {
  if (!left || !right) return true;
  return left.path === right.path && left.dev === right.dev && left.ino === right.ino;
}

function preflight(db, classification) {
  db.pragma('foreign_keys = ON');
  const shapeProblem = classification.status !== 'empty' ? baselineShapeProblem(db) : null;
  if (shapeProblem) throw new Error(shapeProblem);
  const integrity = db.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') throw new Error(`integrity_check failed: ${integrity}`);
  const fkRows = db.pragma('foreign_key_check');
  if (fkRows.length) throw new Error(`foreign_key_check failed: ${JSON.stringify(fkRows.map((row) => ({ table: row.table, rowid: row.rowid, parent: row.parent })))}`);
  validateSafeIntegers(db);
  if (classification.status === 'legacy' || classification.status === 'managed') {
    const demandOrphans = db.prepare('SELECT COUNT(*) AS count FROM demands d LEFT JOIN users u ON u.id = d.user_id WHERE u.id IS NULL').get().count;
    if (demandOrphans) throw new Error(`orphan relationship demands.user_id -> users.id count=${demandOrphans}`);
    const opportunityOrphans = hasObject(db, 'opportunities')
      ? db.prepare('SELECT COUNT(*) AS count FROM opportunities o LEFT JOIN customers c ON c.id = o.customer_id WHERE c.id IS NULL').get().count
      : 0;
    if (opportunityOrphans) throw new Error(`orphan relationship opportunities.customer_id -> customers.id count=${opportunityOrphans}`);
  }
}

function collectReadOnlyPreflight(databasePath, options) {
  if (!databasePath || databasePath === ':memory:' || !fs.existsSync(databasePath)) return null;
  const identity = identityForDatabasePath(databasePath);
  const readonly = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    readonly.pragma('foreign_keys = ON');
    const classification = classifyDatabase(readonly, options);
    if (classification.status === 'partial_or_malformed' || classification.status === 'future') {
      throw new Error(`migration classification failed: ${classification.status}${classification.reason ? ` ${classification.reason}` : ''}`);
    }
    preflight(readonly, classification);
    return { identity, classification, digest: preflightDigest(readonly) };
  } finally {
    readonly.close();
  }
}

function assertPreflightStillMatches(db, expected, options) {
  if (!expected) return;
  const currentIdentity = identityForDatabasePath(expected.identity.path);
  if (!sameIdentity(expected.identity, currentIdentity)) throw new Error('preflight database identity changed before write');
  const classification = classifyDatabase(db, options);
  if (classification.status !== expected.classification.status || classification.currentVersion !== expected.classification.currentVersion) {
    throw new Error('preflight classification changed before write');
  }
  const currentDigest = preflightDigest(db);
  if (
    currentDigest.topologySha256 !== expected.digest.topologySha256 ||
    currentDigest.logicalSha256 !== expected.digest.logicalSha256 ||
    JSON.stringify(currentDigest.fts) !== JSON.stringify(expected.digest.fts)
  ) {
    throw new Error('preflight digest changed before write');
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

  const databasePath = db.name;
  const readonlyPreflight = collectReadOnlyPreflight(databasePath, normalizedOptions);
  if (readonlyPreflight && typeof normalizedOptions.afterReadOnlyPreflight === 'function') {
    normalizedOptions.afterReadOnlyPreflight(databasePath, readonlyPreflight);
  }

  const classification = readonlyPreflight ? readonlyPreflight.classification : classifyDatabase(db, normalizedOptions);
  if (classification.status === 'partial_or_malformed' || classification.status === 'future') {
    throw new Error(`migration classification failed: ${classification.status}${classification.reason ? ` ${classification.reason}` : ''}`);
  }
  if (!readonlyPreflight) preflight(db, classification);

  const transaction = db.transaction(() => {
    assertPreflightStillMatches(db, readonlyPreflight, normalizedOptions);
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

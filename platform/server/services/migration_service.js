const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const { builtinModules } = require('module');
const Database = require('better-sqlite3');

const sqliteDigest = require('./sqlite_digest_service');

const BUILTIN_MODULES = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`)
]);

const MIGRATION_001_DESCRIPTOR = Object.freeze({
  version: 1,
  name: '001_legacy_compat_columns',
  sourcePath: 'migrations/001_legacy_compat_columns.js',
  engineVersion: 1,
  dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
});

const LEDGER_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  name TEXT NOT NULL UNIQUE CHECK (length(trim(name)) BETWEEN 1 AND 120),
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

const INTEGER_RULES = {
  users: { id: 'positive', api_quota: 'nonnegative', is_active: 'boolean' },
  brands: { id: 'positive', youtube_followers: 'nonnegative', instagram_followers: 'nonnegative', tiktok_followers: 'nonnegative', search_volume_monthly: 'nonnegative', monthly_posts: 'nonnegative', avg_views: 'nonnegative' },
  sessions: { id: 'positive', user_id: 'positive' },
  demands: { id: 'positive', user_id: 'positive' },
  proposals: { id: 'positive', user_id: 'positive', demand_id: 'positive' },
  token_usage: { id: 'positive', user_id: 'positive', prompt_tokens: 'nonnegative', completion_tokens: 'nonnegative', total_tokens: 'nonnegative' },
  activity_log: { id: 'positive', user_id: 'positive' },
  team_invites: { id: 'positive', created_by: 'positive', max_uses: 'positive', uses: 'nonnegative', is_active: 'boolean' },
  customers: { id: 'positive', created_by: 'positive', assigned_to: 'positive', lead_score: 'nonnegative', win_probability: 'probability', is_public: 'boolean' },
  customer_activity: { id: 'positive', customer_id: 'positive', user_id: 'positive' },
  influencers: { id: 'positive', followers: 'nonnegative', avg_views_10: 'nonnegative', cost_usd: 'nonnegative', cost_range_min: 'nonnegative', cost_range_max: 'nonnegative', is_active: 'boolean', quoted_price: 'nonnegative', is_duplicate: 'boolean' },
  collaborations: { id: 'positive', demand_id: 'positive', influencer_id: 'positive', user_id: 'positive', cost_quoted: 'nonnegative', cost_actual: 'nonnegative', row_version: 'version', cost_actual_confirmed: 'boolean' },
  workflow_templates: { id: 'positive', version: 'version', is_active: 'boolean', created_by: 'positive' },
  workflow_instances: { id: 'positive', template_id: 'positive', business_id: 'positive', started_by: 'positive' },
  workflow_tasks: { id: 'positive', instance_id: 'positive', assignee_id: 'positive', completed_by: 'positive' },
  workflow_timers: { id: 'positive', instance_id: 'positive', fired: 'boolean' },
  workflow_node_logs: { id: 'positive', instance_id: 'positive', user_id: 'positive' },
  leads: { id: 'positive', lead_score: 'nonnegative', assigned_to: 'positive', converted_customer_id: 'positive' },
  opportunities: { id: 'positive', customer_id: 'positive', win_probability: 'probability', created_by: 'positive' },
  sales_targets: { id: 'positive', user_id: 'positive' },
  activity_log_ext: { id: 'positive', customer_id: 'positive', user_id: 'positive' },
  knowledge_entries: { id: 'positive', source_id: 'polymorphic_source_id', created_by: 'positive', is_public: 'boolean', usage_count: 'nonnegative' },
  knowledge_chunks: { id: 'positive', entry_id: 'positive', chunk_index: 'nonnegative', token_count: 'nonnegative' },
  ai_conversations: { id: 'positive', user_id: 'positive', archived_summary_id: 'positive' },
  ai_messages: { id: 'positive', conversation_id: 'positive', user_id: 'positive', prompt_tokens: 'nonnegative', completion_tokens: 'nonnegative', total_tokens: 'nonnegative' },
  ai_references: { id: 'positive', message_id: 'positive' },
  web_search_cache: { id: 'positive' }
};

const LEGACY_RELATIONSHIPS = [
  ['sessions', 'user_id', 'users', 'id', true],
  ['demands', 'user_id', 'users', 'id', true],
  ['proposals', 'user_id', 'users', 'id', true],
  ['proposals', 'demand_id', 'demands', 'id', false],
  ['token_usage', 'user_id', 'users', 'id', true],
  ['activity_log', 'user_id', 'users', 'id', true],
  ['team_invites', 'created_by', 'users', 'id', true],
  ['customers', 'created_by', 'users', 'id', true],
  ['customers', 'assigned_to', 'users', 'id', false],
  ['customer_activity', 'customer_id', 'customers', 'id', true],
  ['customer_activity', 'user_id', 'users', 'id', true],
  ['collaborations', 'demand_id', 'demands', 'id', false],
  ['collaborations', 'influencer_id', 'influencers', 'id', true],
  ['collaborations', 'user_id', 'users', 'id', true],
  ['workflow_templates', 'created_by', 'users', 'id', false],
  ['workflow_instances', 'template_id', 'workflow_templates', 'id', true],
  ['workflow_instances', 'started_by', 'users', 'id', false],
  ['workflow_tasks', 'instance_id', 'workflow_instances', 'id', true],
  ['workflow_tasks', 'assignee_id', 'users', 'id', false],
  ['workflow_tasks', 'completed_by', 'users', 'id', false],
  ['workflow_timers', 'instance_id', 'workflow_instances', 'id', true],
  ['workflow_node_logs', 'instance_id', 'workflow_instances', 'id', true],
  ['workflow_node_logs', 'user_id', 'users', 'id', false],
  ['opportunities', 'customer_id', 'customers', 'id', true],
  ['opportunities', 'created_by', 'users', 'id', false],
  ['leads', 'assigned_to', 'users', 'id', false],
  ['leads', 'converted_customer_id', 'customers', 'id', false],
  ['sales_targets', 'user_id', 'users', 'id', false],
  ['activity_log_ext', 'customer_id', 'customers', 'id', false],
  ['activity_log_ext', 'user_id', 'users', 'id', false],
  ['knowledge_entries', 'created_by', 'users', 'id', false],
  ['knowledge_chunks', 'entry_id', 'knowledge_entries', 'id', true],
  ['ai_conversations', 'user_id', 'users', 'id', true],
  ['ai_conversations', 'archived_summary_id', 'knowledge_entries', 'id', false],
  ['ai_messages', 'conversation_id', 'ai_conversations', 'id', true],
  ['ai_messages', 'user_id', 'users', 'id', true],
  ['ai_references', 'message_id', 'ai_messages', 'id', true]
];

const COMPAT_COLUMNS = {
  row_version: {
    type: 'INTEGER',
    notnull: true,
    defaultValue: '1',
    checkSql: "CHECK(typeof(row_version) = 'integer' AND row_version >= 1 AND row_version <= 9007199254740991)"
  },
  cost_actual_confirmed: {
    type: 'INTEGER',
    notnull: true,
    defaultValue: '0',
    checkSql: "CHECK(typeof(cost_actual_confirmed) = 'integer' AND cost_actual_confirmed IN (0,1))"
  }
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
  return [MIGRATION_001_DESCRIPTOR];
}

function migrationInputPaths(migration) {
  const sourcePath = validateRepoPath(migration.sourcePath);
  const enginePath = `migrations/engines/v${migration.engineVersion}.js`;
  const baselinePath = 'migrations/baselines/legacy_v1.js';
  return [sourcePath, enginePath, baselinePath, ...(migration.dependencies || [])];
}

function migrationInputs(migration, rootDir) {
  const paths = migrationInputPaths(migration);
  const seen = new Set();
  return paths.map((repoPath) => {
    const validPath = validateRepoPath(repoPath);
    if (seen.has(validPath)) throw new Error(`duplicate dependency path: ${validPath}`);
    seen.add(validPath);
    const absolute = path.join(rootDir, ...validPath.split('/'));
    return { path: validPath, bytes: fs.readFileSync(absolute) };
  });
}

function normalizeRelativeRequest(parentPath, request) {
  const parentDir = path.posix.dirname(parentPath);
  const requested = request.endsWith('.js') ? request : `${request}.js`;
  return validateRepoPath(path.posix.normalize(path.posix.join(parentDir, requested)));
}

function localImportRequests(source) {
  const pattern = /require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
  const requests = [];
  let match;
  while ((match = pattern.exec(source)) !== null) {
    requests.push(match[1]);
  }
  return requests;
}

function forbiddenAsyncToken(source) {
  const match = /\b(?:async|await)\b/.exec(source);
  return match ? match[0] : null;
}

function validatedMigrationBundle(migration, options) {
  const rootDir = options && options.rootDir ? options.rootDir : path.resolve(__dirname, '..');
  const inputs = migrationInputs(migration, rootDir);
  const files = new Map(inputs.map((input) => [input.path, input.bytes]));
  for (const input of inputs) {
    const source = input.bytes.toString('utf8');
    const asyncToken = forbiddenAsyncToken(source);
    if (asyncToken) {
      throw new Error(`asynchronous syntax is not allowed in migration bundle ${input.path}: ${asyncToken}`);
    }
    for (const request of localImportRequests(source)) {
      const resolved = normalizeRelativeRequest(input.path, request);
      if (!files.has(resolved)) {
        throw new Error(`undeclared local import in ${input.path}: ${request} -> ${resolved}`);
      }
    }
  }
  return { files: inputs, fileMap: files, rootDir };
}

function computeRegisteredMigrationChecksum(migration, options) {
  const bundle = validatedMigrationBundle(migration, options || {});
  return computeMigrationChecksum({
    engineVersion: migration.engineVersion,
    files: bundle.files
  });
}

function isolatedHostFunction(fn) {
  Object.setPrototypeOf(fn, null);
  return Object.freeze(fn);
}

function migrationExecutionContext() {
  const environment = Object.create(null);
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') environment[key] = value;
  }
  Object.freeze(environment);

  const sandboxProcess = Object.create(null);
  Object.defineProperty(sandboxProcess, 'env', {
    value: environment,
    enumerable: true
  });
  Object.freeze(sandboxProcess);

  const sandbox = Object.create(null);
  sandbox.process = sandboxProcess;
  sandbox.Promise = undefined;
  sandbox.queueMicrotask = undefined;
  sandbox.setInterval = undefined;
  sandbox.setTimeout = undefined;
  sandbox.setImmediate = undefined;
  const context = vm.createContext(sandbox, {
    name: 'turingmarket-migration-vm',
    codeGeneration: { strings: false, wasm: false }
  });
  const cloneValue = new vm.Script(`
    (function cloneMigrationValue(value) {
      if (value === null || typeof value !== 'object') return value;
      if (ArrayBuffer.isView(value)) {
        const output = new Uint8Array(value.length);
        for (let index = 0; index < value.length; index += 1) output[index] = value[index];
        return output;
      }
      if (Array.isArray(value)) {
        const output = [];
        for (let index = 0; index < value.length; index += 1) output.push(cloneMigrationValue(value[index]));
        return output;
      }
      const output = Object.create(null);
      for (const key of Object.keys(value)) output[key] = cloneMigrationValue(value[key]);
      return output;
    })
  `).runInContext(context);
  const createError = new vm.Script(`
    (function createMigrationError(name, message, code) {
      const error = new Error(message);
      if (typeof name === 'string' && name) error.name = name;
      if (typeof code === 'string' && code) error.code = code;
      return error;
    })
  `).runInContext(context);
  const contextError = (error, fallbackMessage) => {
    let name = 'Error';
    let message = fallbackMessage || 'migration host operation failed';
    let code;
    try {
      if (error && typeof error.name === 'string' && error.name) name = error.name;
      if (error && typeof error.message === 'string' && error.message) message = error.message;
      if (error && typeof error.code === 'string' && error.code) code = error.code;
    } catch (_error) {
      // Use the closed fallback fields when an exotic thrown value cannot be inspected safely.
    }
    return createError(name, message, code);
  };
  const rejectAsyncWork = isolatedHostFunction(() => {
    throw contextError(null, 'asynchronous migration work is not allowed');
  });
  sandbox.queueMicrotask = rejectAsyncWork;
  sandbox.setInterval = rejectAsyncWork;
  sandbox.setTimeout = rejectAsyncWork;
  sandbox.setImmediate = rejectAsyncWork;
  return { context, cloneValue, contextError };
}

function hostBoundary(runtime, operation) {
  try {
    return operation();
  } catch (error) {
    throw runtime.contextError(error);
  }
}

function migrationCryptoFacade(runtime) {
  const facade = Object.create(null);
  facade.randomInt = isolatedHostFunction((...args) => hostBoundary(runtime, () => {
    if (args.length === 1) return crypto.randomInt(args[0]);
    if (args.length === 2) return crypto.randomInt(args[0], args[1]);
    throw new TypeError('crypto.randomInt accepts one or two integer arguments in migrations');
  }));
  facade.randomBytes = isolatedHostFunction((...args) => hostBoundary(runtime, () => {
    if (args.length !== 1) throw new TypeError('crypto.randomBytes accepts one length argument in migrations');
    return runtime.cloneValue(crypto.randomBytes(args[0]));
  }));
  facade.createHash = isolatedHostFunction((...args) => hostBoundary(runtime, () => {
    if (args.length !== 1 || args[0] !== 'sha256') {
      throw new TypeError('migrations may create only sha256 hashes');
    }
    const hash = crypto.createHash('sha256');
    const hashFacade = Object.create(null);
    hashFacade.update = isolatedHostFunction((value, encoding) => hostBoundary(runtime, () => {
      if (typeof value !== 'string' || (encoding !== undefined && encoding !== 'utf8')) {
        throw new TypeError('migration sha256 input must be a UTF-8 string');
      }
      hash.update(value, 'utf8');
      return hashFacade;
    }));
    hashFacade.digest = isolatedHostFunction((encoding) => hostBoundary(runtime, () => {
      if (encoding !== 'hex') throw new TypeError('migration sha256 digest encoding must be hex');
      return hash.digest('hex');
    }));
    return Object.freeze(hashFacade);
  }));
  return Object.freeze(facade);
}

function migrationBuiltinFacades(runtime) {
  const cryptoFacade = migrationCryptoFacade(runtime);
  return new Map([
    ['crypto', cryptoFacade],
    ['node:crypto', cryptoFacade]
  ]);
}

function migrationDatabaseAccess(db, runtime) {
  let active = true;
  const assertActive = () => {
    if (!active) throw new Error('migration database access has expired');
  };
  const statementFacade = (statement) => {
    const facade = Object.create(null);
    facade.run = isolatedHostFunction((...args) => hostBoundary(runtime, () => {
      assertActive();
      return runtime.cloneValue(statement.run(...args));
    }));
    facade.get = isolatedHostFunction((...args) => hostBoundary(runtime, () => {
      assertActive();
      return runtime.cloneValue(statement.get(...args));
    }));
    facade.all = isolatedHostFunction((...args) => hostBoundary(runtime, () => {
      assertActive();
      return runtime.cloneValue(statement.all(...args));
    }));
    return Object.freeze(facade);
  };
  const facade = Object.create(null);
  facade.exec = isolatedHostFunction((sql) => hostBoundary(runtime, () => {
    assertActive();
    db.exec(sql);
  }));
  facade.prepare = isolatedHostFunction((sql) => hostBoundary(runtime, () => {
    assertActive();
    return statementFacade(db.prepare(sql));
  }));
  return {
    facade: Object.freeze(facade),
    revoke() {
      active = false;
    }
  };
}

function engineBuiltinPolicy(engine, expectedVersion) {
  if (!engine || engine.version !== expectedVersion) {
    throw new Error(`migration engine version mismatch: expected ${expectedVersion}`);
  }
  if (!Array.isArray(engine.allowedBuiltinModules)) {
    throw new Error(`migration engine v${expectedVersion} must declare allowedBuiltinModules`);
  }
  const allowed = new Set();
  for (const request of engine.allowedBuiltinModules) {
    if (typeof request !== 'string' || !BUILTIN_MODULES.has(request) || allowed.has(request)) {
      throw new Error(`migration engine v${expectedVersion} has invalid builtin policy`);
    }
    allowed.add(request);
  }
  return allowed;
}

function assertSynchronousMigrationResult(result, label) {
  if (
    result !== null &&
    (typeof result === 'object' || typeof result === 'function') &&
    typeof result.then === 'function'
  ) {
    throw new Error(`${label} returned an asynchronous thenable`);
  }
}

function executeMigrationFunction(loaded, operation, db, label) {
  const access = migrationDatabaseAccess(db, loaded.runtime);
  try {
    const result = operation(access.facade);
    assertSynchronousMigrationResult(result, label);
    return result;
  } finally {
    access.revoke();
  }
}

function loadRegisteredMigration(migration, options) {
  const bundle = validatedMigrationBundle(migration, options || {});
  const checksum = computeMigrationChecksum({ engineVersion: migration.engineVersion, files: bundle.files });
  const moduleCache = new Map();
  const runtime = migrationExecutionContext();
  const context = runtime.context;
  const builtinFacades = migrationBuiltinFacades(runtime);
  let allowedBuiltinModules = new Set();

  function loadModule(repoPath) {
    const normalized = validateRepoPath(repoPath);
    if (moduleCache.has(normalized)) return moduleCache.get(normalized).exports;
    const bytes = bundle.fileMap.get(normalized);
    if (!bytes) throw new Error(`migration implementation attempted undeclared local load: ${normalized}`);
    const module = Object.create(null);
    module.exports = Object.create(null);
    moduleCache.set(normalized, module);
    const dirname = path.posix.dirname(normalized);
    const filename = path.join(bundle.rootDir, ...normalized.split('/'));
    const localRequire = isolatedHostFunction((request) => hostBoundary(runtime, () => {
      if (typeof request !== 'string') throw new TypeError('migration require path must be a string');
      if (request.startsWith('./') || request.startsWith('../')) {
        return loadModule(normalizeRelativeRequest(normalized, request));
      }
      if (BUILTIN_MODULES.has(request)) {
        if (!allowedBuiltinModules.has(request) || !builtinFacades.has(request)) {
          throw new Error(`builtin import is not allowed by migration engine v${migration.engineVersion}: ${request}`);
        }
        return builtinFacades.get(request);
      }
      throw new Error(`undeclared bare import in migration bundle ${normalized}: ${request}`);
    }));
    const script = new vm.Script(`(function(exports, require, module, __filename, __dirname) {\n${bytes.toString('utf8')}\n})`, {
      filename
    });
    const compiled = script.runInContext(context);
    compiled(module.exports, localRequire, module, filename, dirname);
    return module.exports;
  }

  const engineImplementation = loadModule(`migrations/engines/v${migration.engineVersion}.js`);
  allowedBuiltinModules = engineBuiltinPolicy(engineImplementation, migration.engineVersion);
  const implementation = loadModule(validateRepoPath(migration.sourcePath));
  const baselineImplementation = loadModule('migrations/baselines/legacy_v1.js');
  const mismatches = [];
  for (const key of ['version', 'name', 'sourcePath', 'engineVersion']) {
    if (implementation[key] !== migration[key]) mismatches.push(key);
  }
  const expectedDeps = JSON.stringify(migration.dependencies || []);
  const actualDeps = JSON.stringify(implementation.dependencies || []);
  if (actualDeps !== expectedDeps) mismatches.push('dependencies');
  if (mismatches.length) throw new Error(`migration descriptor mismatch for ${migration.name}: ${mismatches.join(', ')}`);
  if (typeof implementation.apply !== 'function') throw new Error(`migration ${migration.name} does not export apply`);
  if (typeof baselineImplementation.apply !== 'function') throw new Error(`migration ${migration.name} baseline bundle does not export apply`);
  return { implementation, baseline: baselineImplementation, checksum, runtime };
}

function userObjects(db) {
  return db.prepare("SELECT name,type FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
}

function hasObject(db, name) {
  return db.prepare("SELECT 1 FROM sqlite_schema WHERE name = ?").get(name) != null;
}

function columnsFor(db, tableName) {
  return db.prepare(`PRAGMA table_info(${JSON.stringify(tableName)})`).all();
}

function quoteIdentifier(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
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
  const sql = normalizeSql(tableSql(db, 'collaborations'));
  for (const name of Object.keys(COMPAT_COLUMNS)) {
    const column = columns.find((candidate) => candidate.name === name);
    if (!column) continue;
    const badValues = db.prepare(`
      SELECT COUNT(*) AS count
      FROM collaborations
      WHERE ${quoteIdentifier(name)} IS NOT NULL
        AND (${invalidRuleSql(quoteIdentifier(name), integerRuleFor('collaborations', name))})
    `).get().count;
    if (badValues) return `unsafe compatibility column collaborations.${name} count=${badValues}`;
  }
  for (const [name, expected] of Object.entries(COMPAT_COLUMNS)) {
    const column = columns.find((candidate) => candidate.name === name);
    if (!column) continue;
    if (String(column.type).toUpperCase() !== expected.type) return `incompatible compatibility column collaborations.${name}`;
    if (expected.notnull && column.notnull !== 1) return `incompatible nullable compatibility column collaborations.${name}`;
    if (String(column.dflt_value) !== expected.defaultValue) return `incompatible default compatibility column collaborations.${name}`;
    if (expected.checkSql && !sql.includes(normalizeSql(expected.checkSql))) return `incompatible CHECK compatibility column collaborations.${name}`;
  }
  return null;
}

function normalizeSql(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim();
}

function tableSql(db, tableName) {
  const row = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(tableName);
  return row ? row.sql : '';
}

function schemaShadowNames() {
  return new Set([
    'knowledge_chunks_fts_data',
    'knowledge_chunks_fts_idx',
    'knowledge_chunks_fts_content',
    'knowledge_chunks_fts_docsize',
    'knowledge_chunks_fts_config'
  ]);
}

function schemaObjects(db) {
  const shadows = schemaShadowNames();
  return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name,tbl_name")
    .all()
    .filter((object) => !shadows.has(object.name));
}

function xinfoFor(db, object) {
  if (!/^(table|view)$/i.test(object.type) && object.type !== 'virtual table') return [];
  return db.prepare(`PRAGMA table_xinfo(${quoteIdentifier(object.name)})`).all().map((column) => ({
    name: column.name,
    type: column.type,
    notnull: column.notnull,
    dflt_value: column.dflt_value,
    pk: column.pk,
    hidden: column.hidden
  }));
}

function tableListFor(db, object) {
  if (!/^(table|view)$/i.test(object.type) && object.type !== 'virtual table') return [];
  return db.prepare(`PRAGMA table_list(${quoteIdentifier(object.name)})`).all()
    .filter((row) => row.schema === 'main' && row.name === object.name)
    .map((row) => ({
      schema: row.schema,
      name: row.name,
      type: row.type,
      ncol: row.ncol,
      wr: row.wr,
      strict: row.strict
    }))
    .sort((left, right) => left.schema.localeCompare(right.schema) || left.name.localeCompare(right.name));
}

function foreignKeysFor(db, object) {
  if (object.type !== 'table') return [];
  return db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(object.name)})`).all()
    .map((row) => ({
      id: row.id,
      seq: row.seq,
      table: row.table,
      from: row.from,
      to: row.to,
      on_update: row.on_update,
      on_delete: row.on_delete,
      match: row.match
    }))
    .sort((left, right) => left.id - right.id || left.seq - right.seq);
}

function indexesFor(db, object) {
  if (object.type !== 'table') return [];
  return db.prepare(`PRAGMA index_list(${quoteIdentifier(object.name)})`).all()
    .map((index) => ({
      name: index.name,
      unique: index.unique,
      origin: index.origin,
      partial: index.partial,
      xinfo: db.prepare(`PRAGMA index_xinfo(${quoteIdentifier(index.name)})`).all()
        .map((row) => ({
          seqno: row.seqno,
          cid: row.cid,
          name: row.name,
          desc: row.desc,
          coll: row.coll,
          key: row.key
        }))
        .sort((left, right) => left.seqno - right.seqno || left.cid - right.cid || String(left.name).localeCompare(String(right.name)))
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function schemaSnapshot(db) {
  const objects = new Map();
  const columns = new Map();
  const tableList = new Map();
  const foreignKeys = new Map();
  const indexes = new Map();
  for (const object of schemaObjects(db)) {
    objects.set(object.name, {
      type: object.type,
      name: object.name,
      tbl_name: object.tbl_name,
      sql: normalizeSql(object.sql)
    });
    columns.set(object.name, xinfoFor(db, object));
    tableList.set(object.name, tableListFor(db, object));
    foreignKeys.set(object.name, foreignKeysFor(db, object));
    indexes.set(object.name, indexesFor(db, object));
  }
  return { objects, columns, tableList, foreignKeys, indexes };
}

function expectedLedgerSnapshot() {
  const expected = new Database(':memory:');
  try {
    createLedger(expected);
    return schemaSnapshot(expected);
  } finally {
    expected.close();
  }
}

function ledgerShapeProblem(db) {
  if (!hasObject(db, 'schema_migrations')) return 'missing schema_migrations ledger';
  const expected = expectedLedgerSnapshot();
  const actual = schemaSnapshot(db);
  const expectedObject = expected.objects.get('schema_migrations');
  const actualObject = actual.objects.get('schema_migrations');
  if (!actualObject || JSON.stringify(actualObject) !== JSON.stringify(expectedObject)) return 'malformed schema_migrations ledger';
  if (JSON.stringify(actual.columns.get('schema_migrations')) !== JSON.stringify(expected.columns.get('schema_migrations'))) {
    return 'malformed schema_migrations ledger columns';
  }
  return null;
}

function optionalMigrationAllowances(migrations) {
  const objects = new Map();
  const columns = new Map();
  for (const migration of migrations || []) {
    const manifest = migration.schemaManifest || {};
    for (const [table, tableColumns] of Object.entries(manifest.columns || {})) {
      if (!columns.has(table)) columns.set(table, new Map());
      for (const [name, column] of Object.entries(tableColumns)) {
        columns.get(table).set(name, {
          name,
          type: column.type,
          notnull: column.notnull,
          dflt_value: column.defaultValue,
          pk: 0,
          hidden: 0
        });
      }
    }
    for (const [name, sql] of Object.entries(manifest.indexes || {})) {
      objects.set(name, { type: 'index', name, tbl_name: name.replace(/^idx_([^_]+).*$/, '$1'), sql: normalizeSql(sql) });
    }
    for (const [name, sql] of Object.entries(manifest.triggers || {})) {
      objects.set(name, { type: 'trigger', name, tbl_name: 'collaborations', sql: normalizeSql(sql) });
    }
  }
  return { objects, columns };
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactSchemaProblem(actual, expected, label) {
  for (const [name, expectedObject] of expected.objects.entries()) {
    if (!actual.objects.has(name)) return `missing ${label} object ${name}`;
    if (!jsonEqual(actual.objects.get(name), expectedObject)) return `incompatible ${label} object ${name}`;
  }
  for (const name of actual.objects.keys()) {
    if (!expected.objects.has(name)) return `unknown ${label} object ${name}`;
  }
  for (const [name, expectedColumns] of expected.columns.entries()) {
    if (!jsonEqual(actual.columns.get(name), expectedColumns)) return `incompatible ${label} columns ${name}`;
  }
  for (const [name, expectedTableList] of expected.tableList.entries()) {
    if (!jsonEqual(actual.tableList.get(name), expectedTableList)) return `incompatible ${label} table metadata ${name}`;
  }
  for (const [name, expectedForeignKeys] of expected.foreignKeys.entries()) {
    if (!jsonEqual(actual.foreignKeys.get(name), expectedForeignKeys)) return `incompatible ${label} foreign keys ${name}`;
  }
  for (const [name, expectedIndexes] of expected.indexes.entries()) {
    if (!jsonEqual(actual.indexes.get(name), expectedIndexes)) return `incompatible ${label} indexes ${name}`;
  }
  return null;
}

function columnsSortedByName(columns) {
  return [...(columns || [])].sort((left, right) => Buffer.compare(Buffer.from(left.name, 'utf8'), Buffer.from(right.name, 'utf8')));
}

function indexesWithoutNamedColumnCid(indexes) {
  return (indexes || []).map((index) => ({
    ...index,
    xinfo: index.xinfo.map((column) => ({
      ...column,
      cid: column.name === null ? column.cid : null
    }))
  }));
}

function compatibleManagedSchemaProblem(actual, expected, baselineSnapshot, appliedMigrations) {
  const allowances = optionalMigrationAllowances(appliedMigrations);
  const relaxedBaselineTables = new Set(
    [...allowances.columns.keys()].filter((name) => baselineSnapshot.objects.get(name)?.type === 'table')
  );

  for (const [name, expectedObject] of expected.objects.entries()) {
    const actualObject = actual.objects.get(name);
    if (!actualObject) return `missing managed schema object ${name}`;
    if (relaxedBaselineTables.has(name)) {
      if (
        actualObject.type !== expectedObject.type ||
        actualObject.name !== expectedObject.name ||
        actualObject.tbl_name !== expectedObject.tbl_name
      ) {
        return `incompatible managed schema object ${name}`;
      }
    } else if (!jsonEqual(actualObject, expectedObject)) {
      return `incompatible managed schema object ${name}`;
    }
  }
  for (const name of actual.objects.keys()) {
    if (!expected.objects.has(name)) return `unknown managed schema object ${name}`;
  }

  for (const [name, expectedColumns] of expected.columns.entries()) {
    const actualColumns = actual.columns.get(name);
    if (!actualColumns) return `missing managed schema columns ${name}`;
    if (relaxedBaselineTables.has(name)) {
      if (!jsonEqual(columnsSortedByName(actualColumns), columnsSortedByName(expectedColumns))) {
        return `incompatible managed schema columns ${name}`;
      }
    } else if (!jsonEqual(actualColumns, expectedColumns)) {
      return `incompatible managed schema columns ${name}`;
    }
  }
  for (const name of actual.columns.keys()) {
    if (!expected.columns.has(name)) return `unknown managed schema columns ${name}`;
  }

  for (const [name, expectedTableList] of expected.tableList.entries()) {
    if (!jsonEqual(actual.tableList.get(name), expectedTableList)) return `incompatible managed schema table metadata ${name}`;
  }
  for (const [name, expectedForeignKeys] of expected.foreignKeys.entries()) {
    if (!jsonEqual(actual.foreignKeys.get(name), expectedForeignKeys)) return `incompatible managed schema foreign keys ${name}`;
  }
  for (const [name, expectedIndexes] of expected.indexes.entries()) {
    const actualIndexes = actual.indexes.get(name);
    const indexesMatch = relaxedBaselineTables.has(name)
      ? jsonEqual(indexesWithoutNamedColumnCid(actualIndexes), indexesWithoutNamedColumnCid(expectedIndexes))
      : jsonEqual(actualIndexes, expectedIndexes);
    if (!indexesMatch) return `incompatible managed schema indexes ${name}`;
  }
  return null;
}

function baselineMetadataProblem(table, expected, actual, allowances) {
  const expectedTableList = expected.tableList.get(table) || [];
  const actualTableList = actual.tableList.get(table) || [];
  const allowedColumns = allowances.columns.get(table) || new Map();
  const expectedColumnNames = new Set((expected.columns.get(table) || []).map((column) => column.name));
  const actualAllowedExtras = (actual.columns.get(table) || [])
    .filter((column) => !expectedColumnNames.has(column.name) && allowedColumns.has(column.name)).length;
  if (expectedTableList.length !== actualTableList.length) return `incompatible baseline table metadata ${table}`;
  for (let index = 0; index < expectedTableList.length; index += 1) {
    const expectedRow = expectedTableList[index];
    const actualRow = actualTableList[index];
    const adjustedExpected = { ...expectedRow, ncol: expectedRow.ncol + actualAllowedExtras };
    if (!jsonEqual(actualRow, adjustedExpected)) return `incompatible baseline table metadata ${table}`;
  }
  if (!jsonEqual(actual.foreignKeys.get(table) || [], expected.foreignKeys.get(table) || [])) {
    return `incompatible baseline foreign keys ${table}`;
  }

  const actualIndexes = new Map((actual.indexes.get(table) || []).map((index) => [index.name, index]));
  for (const expectedIndex of expected.indexes.get(table) || []) {
    if (!jsonEqual(actualIndexes.get(expectedIndex.name), expectedIndex)) {
      return `incompatible baseline index metadata ${table}.${expectedIndex.name}`;
    }
    actualIndexes.delete(expectedIndex.name);
  }
  for (const [name] of actualIndexes.entries()) {
    if (!allowances.objects.has(name)) return `unknown baseline index metadata ${table}.${name}`;
  }
  return null;
}

function baselineSchemaProblem(db, baselineImplementation, allowedMigrations) {
  const expectedDb = new Database(':memory:');
  try {
    baselineImplementation.apply(expectedDb);
    const expected = schemaSnapshot(expectedDb);
    const actual = schemaSnapshot(db);
    const allowances = optionalMigrationAllowances(allowedMigrations);
    for (const [name, expectedObject] of expected.objects.entries()) {
      const actualObject = actual.objects.get(name);
      if (!actualObject) return `missing baseline object ${name}`;
      const allowedColumns = allowances.columns.get(name);
      if (expectedObject.type === 'table' && allowedColumns && allowedColumns.size) {
        if (actualObject.type !== expectedObject.type || actualObject.name !== expectedObject.name || actualObject.tbl_name !== expectedObject.tbl_name) {
          return `incompatible baseline object ${name}`;
        }
      } else if (JSON.stringify(actualObject) !== JSON.stringify(expectedObject)) {
        return `incompatible baseline object ${name}`;
      }
    }
    for (const [name, actualObject] of actual.objects.entries()) {
      if (name === 'schema_migrations') continue;
      if (expected.objects.has(name)) continue;
      const allowedObject = allowances.objects.get(name);
      if (!allowedObject) return `unknown baseline object ${name}`;
      if (actualObject.type !== allowedObject.type || normalizeSql(actualObject.sql) !== allowedObject.sql) return `incompatible migration object ${name}`;
    }
    for (const [table, expectedColumns] of expected.columns.entries()) {
      const actualColumns = actual.columns.get(table);
      if (!actualColumns) return `missing baseline columns ${table}`;
      const allowedColumns = allowances.columns.get(table) || new Map();
      const expectedByName = new Map(expectedColumns.map((column) => [column.name, column]));
      for (const expectedColumn of expectedColumns) {
        const actualColumn = actualColumns.find((column) => column.name === expectedColumn.name);
        if (!actualColumn) return `missing baseline column ${table}.${expectedColumn.name}`;
        if (JSON.stringify(actualColumn) !== JSON.stringify(expectedColumn)) return `incompatible baseline column ${table}.${expectedColumn.name}`;
      }
      for (const actualColumn of actualColumns) {
        if (expectedByName.has(actualColumn.name)) continue;
        const allowedColumn = allowedColumns.get(actualColumn.name);
        if (!allowedColumn) return `unknown baseline column ${table}.${actualColumn.name}`;
        if (JSON.stringify(actualColumn) !== JSON.stringify(allowedColumn)) return `incompatible migration column ${table}.${actualColumn.name}`;
      }
      const metadataProblem = baselineMetadataProblem(table, expected, actual, allowances);
      if (metadataProblem) return metadataProblem;
    }
    return null;
  } finally {
    expectedDb.close();
  }
}

function managedSchemaProblem(db, baselineImplementation, appliedMigrations) {
  const expectedDb = new Database(':memory:');
  try {
    baselineImplementation.apply(expectedDb);
    const baselineSnapshot = schemaSnapshot(expectedDb);
    createLedger(expectedDb);
    for (const migration of appliedMigrations) migration.apply(expectedDb);
    const actual = schemaSnapshot(db);
    const expected = schemaSnapshot(expectedDb);
    const exactProblem = exactSchemaProblem(actual, expected, 'managed schema');
    if (!exactProblem) return null;
    return compatibleManagedSchemaProblem(actual, expected, baselineSnapshot, appliedMigrations);
  } finally {
    expectedDb.close();
  }
}

function migrationManifestProblem(db, migrationName, manifest) {
  if (!manifest || typeof manifest !== 'object') return `missing schema manifest for ${migrationName}`;
  for (const [table, expectedColumns] of Object.entries(manifest.columns || {})) {
    const actualColumns = columnsFor(db, table);
    for (const [name, expected] of Object.entries(expectedColumns)) {
      const column = actualColumns.find((candidate) => candidate.name === name);
      if (!column) return `missing ${migrationName} column ${table}.${name}`;
      if (String(column.type).toUpperCase() !== expected.type) return `incompatible ${migrationName} column type ${table}.${name}`;
      if (column.notnull !== expected.notnull) return `incompatible ${migrationName} column notnull ${table}.${name}`;
      if (String(column.dflt_value) !== String(expected.defaultValue)) return `incompatible ${migrationName} column default ${table}.${name}`;
    }
  }
  for (const [name, expectedSql] of Object.entries(manifest.indexes || {})) {
    const row = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?").get(name);
    if (!row) return `missing ${migrationName} index ${name}`;
    if (normalizeSql(row.sql) !== normalizeSql(expectedSql)) return `incompatible ${migrationName} index ${name}`;
  }
  for (const [name, expectedSql] of Object.entries(manifest.triggers || {})) {
    const row = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?").get(name);
    if (!row) return `missing ${migrationName} trigger ${name}`;
    if (normalizeSql(row.sql) !== normalizeSql(expectedSql)) return `incompatible ${migrationName} trigger ${name}`;
  }
  for (const [table, checks] of Object.entries(manifest.tableChecks || {})) {
    const actualSql = normalizeSql(tableSql(db, table));
    for (const checkSql of checks) {
      if (!actualSql.includes(normalizeSql(checkSql))) return `incompatible ${migrationName} CHECK ${table}`;
    }
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
  const loadedByVersion = new Map();
  const loadedFor = (migration) => {
    if (!loadedByVersion.has(migration.version)) loadedByVersion.set(migration.version, loadRegisteredMigration(migration, options || {}));
    return loadedByVersion.get(migration.version);
  };
  const objects = userObjects(db);
  const objectNames = objects.map((object) => object.name);
  const hasLedger = objectNames.includes('schema_migrations');
  if (!hasLedger && objectNames.length === 0) return { status: 'empty', currentVersion: 0 };
  if (!hasLedger) {
    const legacyCompatibilityMigration = migrations.find((migration) => migration.version === 1);
    if (!legacyCompatibilityMigration) {
      return { status: 'partial_or_malformed', reason: 'missing migration version 1 for legacy classification' };
    }
    const loadedLegacyCompatibility = loadedFor(legacyCompatibilityMigration);
    const shapeProblem = baselineSchemaProblem(
      db,
      loadedLegacyCompatibility.baseline,
      [loadedLegacyCompatibility.implementation]
    ) || compatibilityColumnProblem(db);
    return shapeProblem ? { status: 'partial_or_malformed', reason: shapeProblem } : { status: 'legacy', currentVersion: 0 };
  }
  const ledgerProblem = ledgerShapeProblem(db);
  if (ledgerProblem) return { status: 'partial_or_malformed', reason: ledgerProblem };

  let rows;
  try {
    rows = db.prepare('SELECT version,name,checksum,source_path,engine_version FROM schema_migrations ORDER BY version').all();
  } catch (error) {
    return { status: 'partial_or_malformed', reason: error.message };
  }
  if (rows.length === 0) {
    return { status: 'partial_or_malformed', reason: 'empty migration ledger' };
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
    const loaded = loadedFor(migration);
    if (loaded.checksum !== row.checksum || migration.sourcePath !== row.source_path || migration.engineVersion !== row.engine_version) {
      return { status: 'partial_or_malformed', reason: `checksum/schema mismatch for ${row.name}` };
    }
    const manifestProblem = migrationManifestProblem(db, row.name, loaded.implementation.schemaManifest);
    if (manifestProblem) {
      return { status: 'partial_or_malformed', reason: manifestProblem };
    }
  }
  const appliedMigrations = rows.map((row) => loadedFor(migrations.find((candidate) => candidate.version === row.version)).implementation);
  const shapeProblem = managedSchemaProblem(db, loadedFor(migrations[0]).baseline, appliedMigrations) || compatibilityColumnProblem(db);
  if (shapeProblem) return { status: 'partial_or_malformed', reason: shapeProblem };
  return { status: 'managed', currentVersion: rows.length ? rows[rows.length - 1].version : 0 };
}

function createLedger(db) {
  db.exec(LEDGER_SQL);
}

function integerRuleFor(table, column) {
  return INTEGER_RULES[table] ? INTEGER_RULES[table][column] : undefined;
}

function invalidRuleSql(identifier, rule) {
  if (rule === 'positive' || rule === 'version') {
    return `typeof(${identifier}) != 'integer' OR ${identifier} < 1 OR ${identifier} > 9007199254740991`;
  }
  if (rule === 'nonnegative') {
    return `typeof(${identifier}) != 'integer' OR ${identifier} < 0 OR ${identifier} > 9007199254740991`;
  }
  if (rule === 'boolean') {
    return `typeof(${identifier}) != 'integer' OR ${identifier} NOT IN (0,1)`;
  }
  if (rule === 'probability') {
    return `typeof(${identifier}) != 'integer' OR ${identifier} < 0 OR ${identifier} > 100`;
  }
  if (rule === 'polymorphic_source_id') {
    return `(typeof(${identifier}) = 'integer' AND (${identifier} < 1 OR ${identifier} > 9007199254740991))
      OR (typeof(${identifier}) = 'text' AND length(CAST(${identifier} AS BLOB)) > 4096)
      OR typeof(${identifier}) NOT IN ('integer','text','null')`;
  }
  throw new Error(`unknown integer rule ${rule}`);
}

function validateSafeIntegers(db) {
  for (const [table, rules] of Object.entries(INTEGER_RULES)) {
    if (!hasObject(db, table)) continue;
    const existing = new Set(columnsFor(db, table).map((column) => column.name));
    for (const [column, rule] of Object.entries(rules)) {
      if (!existing.has(column)) continue;
      const tableSql = quoteIdentifier(table);
      const columnSql = quoteIdentifier(column);
      const bad = db.prepare(`
        SELECT COUNT(*) AS count
        FROM ${tableSql}
        WHERE ${columnSql} IS NOT NULL
          AND (${invalidRuleSql(columnSql, rule)})
      `).get().count;
      if (bad) throw new Error(`unsafe integer storage ${table}.${column} rule=${rule} count=${bad}`);
    }
  }
}

function autoincrementTables(db) {
  const rows = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  return new Map(rows
    .filter((row) => /\bINTEGER\s+PRIMARY\s+KEY\b/i.test(row.sql || '') && /\bAUTOINCREMENT\b/i.test(row.sql || ''))
    .map((row) => [row.name, row.sql]));
}

function validateSqliteSequence(db) {
  if (hasObject(db, 'sqlite_sequence')) {
    const duplicates = db.prepare('SELECT name, COUNT(*) AS count FROM sqlite_sequence GROUP BY name HAVING COUNT(*) > 1').all();
    if (duplicates.length) throw new Error(`sqlite_sequence duplicate rows ${duplicates.map((row) => row.name).join(',')}`);
    const autoincrements = autoincrementTables(db);
    const rows = db.prepare('SELECT name, seq, typeof(seq) AS seq_type FROM sqlite_sequence ORDER BY name').all();
    for (const row of rows) {
      if (!autoincrements.has(row.name)) throw new Error(`ghost sqlite_sequence row ${row.name}`);
      if (row.seq_type !== 'integer' || row.seq < 0 || row.seq > 9007199254740991) {
        throw new Error(`unsafe sqlite_sequence.seq ${row.name}`);
      }
      if (row.seq >= 9007199254740991) throw new Error(`sqlite_sequence next id exhausted ${row.name}`);
      const maxRow = db.prepare(`SELECT COALESCE(MAX(id), 0) AS max_id FROM ${quoteIdentifier(row.name)}`).get();
      if (row.seq < maxRow.max_id) throw new Error(`sqlite_sequence ${row.name} seq below max id`);
    }
  }
}

function validateLegacyRelationships(db) {
  for (const [childTable, childColumn, parentTable, parentColumn, required] of LEGACY_RELATIONSHIPS) {
    if (!hasObject(db, childTable) || !hasObject(db, parentTable)) continue;
    const childColumns = new Set(columnsFor(db, childTable).map((column) => column.name));
    const parentColumns = new Set(columnsFor(db, parentTable).map((column) => column.name));
    if (!childColumns.has(childColumn) || !parentColumns.has(parentColumn)) continue;
    if (required) {
      const missingRequired = db.prepare(`
        SELECT COUNT(*) AS count
        FROM ${quoteIdentifier(childTable)}
        WHERE ${quoteIdentifier(childColumn)} IS NULL
      `).get().count;
      if (missingRequired) {
        throw new Error(`null required relationship ${childTable}.${childColumn} -> ${parentTable}.${parentColumn} count=${missingRequired}`);
      }
    }
    const orphans = db.prepare(`
      SELECT COUNT(*) AS count
      FROM ${quoteIdentifier(childTable)} child
      LEFT JOIN ${quoteIdentifier(parentTable)} parent
        ON parent.${quoteIdentifier(parentColumn)} = child.${quoteIdentifier(childColumn)}
      WHERE child.${quoteIdentifier(childColumn)} IS NOT NULL
        AND parent.${quoteIdentifier(parentColumn)} IS NULL
    `).get().count;
    if (orphans) {
      throw new Error(`orphan relationship ${childTable}.${childColumn} -> ${parentTable}.${parentColumn} count=${orphans}`);
    }
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

function validateFtsIntegrity(db, options) {
  const manifest = digestManifest(db);
  if ((manifest.fts || []).length) {
    sqliteDigest.verifyKnowledgeChunksFtsIntegrity(db, manifest, {
      checkMainIntegrity: Boolean(options && options.checkMainFtsIntegrity)
    });
  }
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

function preflight(db, classification, options) {
  db.pragma('foreign_keys = ON');
  const shapeProblem = classification.status !== 'empty' ? baselineShapeProblem(db) : null;
  if (shapeProblem) throw new Error(shapeProblem);
  const integrity = db.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') throw new Error(`integrity_check failed: ${integrity}`);
  const fkRows = db.pragma('foreign_key_check');
  if (fkRows.length) throw new Error(`foreign_key_check failed: ${JSON.stringify(fkRows.map((row) => ({ table: row.table, rowid: row.rowid, parent: row.parent })))}`);
  validateSafeIntegers(db);
  validateSqliteSequence(db);
  if (classification.status === 'legacy' || classification.status === 'managed') {
    validateLegacyRelationships(db);
  }
  validateFtsIntegrity(db, options || {});
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
    preflight(readonly, classification, { checkMainFtsIntegrity: false });
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
  preflight(db, classification, { checkMainFtsIntegrity: true });
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
  for (let index = 0; index < migrations.length; index += 1) {
    const migration = migrations[index];
    const expectedVersion = index + 1;
    if (!Number.isSafeInteger(migration.version) || migration.version !== expectedVersion) {
      throw new Error(`registered migration versions must be contiguous; missing migration version ${expectedVersion}`);
    }
  }
  return migrations;
}

function applySeedAdmissions(db, loaded) {
  const baselineSeeds = loaded && loaded.baseline && loaded.baseline.seedAdmissions;
  if (!baselineSeeds || typeof baselineSeeds.admin !== 'function' || typeof baselineSeeds.influencers !== 'function') {
    throw new Error('checksum-bound baseline seed admissions are unavailable');
  }
  executeMigrationFunction(loaded, baselineSeeds.admin, db, 'admin seed admission');
  executeMigrationFunction(loaded, baselineSeeds.influencers, db, 'influencer seed admission');
}

function normalizedMigrationOptions(options) {
  const normalizedOptions = { ...(options || {}) };
  const migrations = normalizeMigrations(normalizedOptions);
  normalizedOptions.migrations = migrations;
  delete normalizedOptions.seedAdmissions;
  return normalizedOptions;
}

function runMigrationTransaction(db, normalizedOptions, readonlyPreflight) {
  const migrations = normalizedOptions.migrations;
  db.pragma('foreign_keys = ON');

  const classification = readonlyPreflight ? readonlyPreflight.classification : classifyDatabase(db, normalizedOptions);
  if (classification.status === 'partial_or_malformed' || classification.status === 'future') {
    throw new Error(`migration classification failed: ${classification.status}${classification.reason ? ` ${classification.reason}` : ''}`);
  }
  if (!readonlyPreflight) preflight(db, classification, { checkMainFtsIntegrity: false });

  const transaction = db.transaction(() => {
    const loadedMigrations = new Map();
    const loadedFor = (migration) => {
      if (!loadedMigrations.has(migration.version)) {
        loadedMigrations.set(migration.version, loadRegisteredMigration(migration, normalizedOptions));
      }
      return loadedMigrations.get(migration.version);
    };
    assertPreflightStillMatches(db, readonlyPreflight, normalizedOptions);
    const lockedClassification = classifyDatabase(db, normalizedOptions);
    if (lockedClassification.status !== classification.status || lockedClassification.currentVersion !== classification.currentVersion) {
      throw new Error('migration preflight identity changed before write');
    }
    if (classification.status === 'empty') {
      const loaded = loadedFor(migrations[0]);
      executeMigrationFunction(loaded, loaded.baseline.apply, db, 'legacy baseline apply');
    }
    if (classification.status !== 'managed') createLedger(db);

    const startVersion = classification.currentVersion || 0;
    for (const migration of migrations) {
      if (migration.version <= startVersion) continue;
      if (migration.engineVersion !== 1) throw new Error(`unsupported migration engine version ${migration.engineVersion}`);
      const loaded = loadedFor(migration);
      executeMigrationFunction(loaded, loaded.implementation.apply, db, `migration ${migration.name} apply`);
      const checksum = loaded.checksum;
      insertLedgerRow(db, migration, checksum);
      if (classification.status !== 'managed' && migration.version === 1) {
        applySeedAdmissions(db, loaded);
      }
    }
    preflight(db, { status: 'managed' }, { checkMainFtsIntegrity: true });
    const finalClassification = classifyDatabase(db, normalizedOptions);
    const expectedVersion = migrations[migrations.length - 1].version;
    if (finalClassification.status !== 'managed' || finalClassification.currentVersion !== expectedVersion) {
      throw new Error(
        `final migration classification failed: ${finalClassification.status}` +
        `${finalClassification.reason ? ` ${finalClassification.reason}` : ''}`
      );
    }
    return finalClassification;
  });
  return transaction.exclusive();
}

function runMigrations(db, options) {
  const normalizedOptions = normalizedMigrationOptions(options);
  const databasePath = db.name;
  const readonlyPreflight = collectReadOnlyPreflight(databasePath, normalizedOptions);
  if (readonlyPreflight && typeof normalizedOptions.afterReadOnlyPreflight === 'function') {
    normalizedOptions.afterReadOnlyPreflight(databasePath, readonlyPreflight);
  }
  return runMigrationTransaction(db, normalizedOptions, readonlyPreflight);
}

function openMigratedDatabase(databasePath, options) {
  if (typeof databasePath !== 'string' || !databasePath) throw new Error('database path is required');
  const normalizedOptions = normalizedMigrationOptions(options);
  const readonlyPreflight = collectReadOnlyPreflight(databasePath, normalizedOptions);
  if (readonlyPreflight && typeof normalizedOptions.afterReadOnlyPreflight === 'function') {
    normalizedOptions.afterReadOnlyPreflight(databasePath, readonlyPreflight);
  }

  let db;
  try {
    db = new Database(databasePath);
    runMigrationTransaction(db, normalizedOptions, readonlyPreflight);
    return db;
  } catch (error) {
    if (db) {
      try {
        db.close();
      } catch (_closeError) {
        // Preserve the migration failure; the connection is not returned to callers.
      }
    }
    throw error;
  }
}

module.exports = {
  LEDGER_SQL,
  BASELINE_TABLES,
  computeMigrationChecksum,
  computeRegisteredMigrationChecksum,
  defaultMigrations,
  integerRuleFor,
  classifyDatabase,
  createLedger,
  runMigrations,
  openMigratedDatabase
};

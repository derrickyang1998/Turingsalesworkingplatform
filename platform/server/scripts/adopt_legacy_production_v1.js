'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const migrationService = require('../services/migration_service');
const sqliteDigest = require('../services/sqlite_digest_service');

const REPORT_VERSION = 'tm-legacy-production-v1-adoption-v1';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SOURCE_SIDECAR_SUFFIXES = Object.freeze(['-wal', '-shm', '-journal']);
const FTS_MANIFEST = Object.freeze({
  fts: Object.freeze([Object.freeze({
    virtualName: 'knowledge_chunks_fts',
    projectionName: 'knowledge_chunks_v1',
    tokenizerOptions: 'unicode61',
    keyColumnCsv: 'entry_id,chunk_id',
    indexedColumnCsv: 'title,content,tags'
  })])
});
const ALLOWED_V1_CUSTOMER_STAGES = Object.freeze([
  'lead', 'qualified', 'info_confirmed', 'advantage_shared', 'needs_confirmed', 'analysis',
  'proposal', 'kol_matching', 'cooperation', 'negotiation', 'maintenance', 'paused', 'won', 'lost'
]);
const EXPECTED_REPAIR_PROFILE = Object.freeze({
  negativeInfluencers: Object.freeze([
    Object.freeze({ id: 128, cost_usd: -3000, quoted_price: -4500 })
  ]),
  invalidCustomers: Object.freeze([
    Object.freeze({ id: 8, stage: 'new_lead' })
  ]),
  invalidActivityFrom: Object.freeze([]),
  invalidActivityTo: Object.freeze([
    Object.freeze({ id: 23, customer_id: 8, stage_to: 'new_lead' })
  ])
});

function sqliteString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function fileSha256(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function fileDescriptorSha256(fd) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (true) {
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest('hex');
}

function comparableIdentity(stat) {
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    nlink: String(stat.nlink),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs)
  });
}

function comparableDirectoryIdentity(stat) {
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode)
  });
}

function assertSameIdentity(actual, expected, label) {
  if (JSON.stringify(comparableIdentity(actual)) !== JSON.stringify(expected)) {
    throw new Error(`${label} identity changed during adoption`);
  }
}

function assertNoSourceSidecars(sourcePath) {
  for (const suffix of SOURCE_SIDECAR_SUFFIXES) {
    if (fs.existsSync(`${sourcePath}${suffix}`)) {
      throw new Error(`legacy source has forbidden SQLite sidecar ${suffix}`);
    }
  }
}

function captureSourceIdentity(sourcePath) {
  const before = fs.lstatSync(sourcePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    throw new Error('legacy source must be a single-link regular non-symlink file');
  }
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const fd = fs.openSync(sourcePath, fs.constants.O_RDONLY | noFollow);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    assertSameIdentity(opened, comparableIdentity(before), 'legacy source');
    return Object.freeze({ fd, identity: comparableIdentity(opened) });
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function assertStableSource(sourcePath, capture, expectedSha256) {
  assertNoSourceSidecars(sourcePath);
  assertSameIdentity(fs.fstatSync(capture.fd, { bigint: true }), capture.identity, 'legacy source descriptor');
  assertSameIdentity(fs.lstatSync(sourcePath, { bigint: true }), capture.identity, 'legacy source path');
  const actualSha256 = fileDescriptorSha256(capture.fd);
  if (actualSha256 !== expectedSha256) throw new Error('legacy source content changed during adoption');
}

function assertRegularSingleLink(filePath, label) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`${label} must be a single-link regular non-symlink file`);
  }
}

function fsyncDirectory(directory) {
  if (process.platform === 'win32') return;
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const directoryFlag = fs.constants.O_DIRECTORY || 0;
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | noFollow | directoryFlag);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function publishNoReplace(stagePath, outputPath, hooks = {}) {
  const parent = path.dirname(outputPath);
  const parentBefore = fs.lstatSync(parent, { bigint: true });
  if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink()) {
    throw new Error('adopted output parent must remain a regular directory');
  }
  const parentIdentity = comparableDirectoryIdentity(parentBefore);
  const stageIdentity = fs.lstatSync(stagePath, { bigint: true });
  const expectedInode = Object.freeze({ dev: String(stageIdentity.dev), ino: String(stageIdentity.ino) });
  let outputLinked = false;
  try {
    fs.linkSync(stagePath, outputPath);
    outputLinked = true;
    if (typeof hooks.afterLink === 'function') hooks.afterLink({ stagePath, outputPath });
    const parentAfter = fs.lstatSync(parent, { bigint: true });
    if (!parentAfter.isDirectory() || parentAfter.isSymbolicLink()
        || JSON.stringify(comparableDirectoryIdentity(parentAfter)) !== JSON.stringify(parentIdentity)) {
      throw new Error('adopted output parent identity changed during publish');
    }
    fsyncDirectory(parent);
    fs.unlinkSync(stagePath);
    if (typeof hooks.afterStageUnlink === 'function') hooks.afterStageUnlink({ outputPath });
    fsyncDirectory(parent);
  } catch (error) {
    let rollbackError = null;
    if (outputLinked && fs.existsSync(outputPath)) {
      const outputStat = fs.lstatSync(outputPath, { bigint: true });
      const outputInode = { dev: String(outputStat.dev), ino: String(outputStat.ino) };
      if (!outputStat.isFile() || outputStat.isSymbolicLink()
          || JSON.stringify(outputInode) !== JSON.stringify(expectedInode)) {
        rollbackError = new Error('failed adoption output no longer matches the published stage inode');
      } else {
        try {
          fs.unlinkSync(outputPath);
          fsyncDirectory(parent);
        } catch (cleanupError) {
          rollbackError = cleanupError;
        }
      }
    }
    if (rollbackError) {
      const failure = new Error(`adopted output rollback could not be made durable: ${rollbackError.message}`);
      failure.cause = error;
      throw failure;
    }
    throw error;
  }
}

function cleanupPrivateStage(stagePath) {
  for (const candidate of [stagePath, ...SOURCE_SIDECAR_SUFFIXES.map((suffix) => `${stagePath}${suffix}`)]) {
    if (!fs.existsSync(candidate)) continue;
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    fs.rmSync(candidate, { force: true });
  }
}

function assertSourcePath(sourcePath) {
  const resolved = path.resolve(sourcePath);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error('legacy source must be a single-link regular non-symlink file');
  }
  assertNoSourceSidecars(resolved);
  return resolved;
}

function assertOutputPath(outputPath, sourcePath) {
  const resolved = path.resolve(outputPath);
  if (resolved === sourcePath) throw new Error('legacy source and adopted output must differ');
  if (fs.existsSync(resolved)) throw new Error('adopted output already exists');
  const parent = path.dirname(resolved);
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error('adopted output parent must be a regular directory');
  }
  return resolved;
}

function assertPrivateStagePath(privateStagePath, sourcePath, outputPath) {
  const resolved = typeof privateStagePath === 'string' && privateStagePath
    ? path.resolve(privateStagePath)
    : `${outputPath}.stage-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  if (resolved === sourcePath || resolved === outputPath) {
    throw new Error('legacy source, adopted output, and private stage must differ');
  }
  if (path.dirname(resolved) !== path.dirname(outputPath)) {
    throw new Error('private adoption stage must share the adopted output parent');
  }
  for (const candidate of [resolved, ...SOURCE_SIDECAR_SUFFIXES.map((suffix) => `${resolved}${suffix}`)]) {
    try {
      fs.lstatSync(candidate);
      throw new Error('private adoption stage already exists');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return resolved;
}

function baseTableRowCounts(db) {
  const result = {};
  const tables = db.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type='table'
      AND name NOT LIKE 'sqlite_%'
      AND name NOT LIKE 'knowledge_chunks_fts%'
      AND name<>'schema_migrations'
    ORDER BY name
  `).all();
  for (const row of tables) {
    const name = row.name;
    result[name] = db.prepare(`SELECT COUNT(*) AS count FROM "${name.replaceAll('"', '""')}"`).get().count;
  }
  return result;
}

function invalidStageRows(db, table, column, projection) {
  const placeholders = ALLOWED_V1_CUSTOMER_STAGES.map(() => '?').join(',');
  return db.prepare(`
    SELECT ${projection} FROM ${table}
    WHERE ${column} IS NOT NULL AND ${column} NOT IN (${placeholders})
    ORDER BY id
  `).all(...ALLOWED_V1_CUSTOMER_STAGES);
}

function assertExactRows(label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} does not match the frozen production repair profile`);
  }
}

function assertAndApplyRepairs(db) {
  const negativeInfluencers = db.prepare(`
    SELECT id,cost_usd,quoted_price FROM influencers
    WHERE cost_usd<0 OR quoted_price<0 ORDER BY id
  `).all();
  const invalidCustomers = invalidStageRows(db, 'customers', 'stage', 'id,stage');
  const invalidActivityFrom = invalidStageRows(
    db, 'customer_activity', 'stage_from', 'id,customer_id,stage_from'
  );
  const invalidActivityTo = invalidStageRows(
    db, 'customer_activity', 'stage_to', 'id,customer_id,stage_to'
  );

  assertExactRows('negative influencer rows', negativeInfluencers, EXPECTED_REPAIR_PROFILE.negativeInfluencers);
  assertExactRows('invalid customer stages', invalidCustomers, EXPECTED_REPAIR_PROFILE.invalidCustomers);
  assertExactRows('invalid activity stage_from values', invalidActivityFrom, EXPECTED_REPAIR_PROFILE.invalidActivityFrom);
  assertExactRows('invalid activity stage_to values', invalidActivityTo, EXPECTED_REPAIR_PROFILE.invalidActivityTo);

  db.transaction(() => {
    const influencer = db.prepare(`
      UPDATE influencers SET cost_usd=3000,quoted_price=4500
      WHERE id=128 AND cost_usd=-3000 AND quoted_price=-4500
    `).run();
    if (influencer.changes !== 1) throw new Error('frozen influencer repair lost its exact target');
    const customer = db.prepare(`
      UPDATE customers SET stage='lead' WHERE id=8 AND stage='new_lead'
    `).run();
    if (customer.changes !== 1) throw new Error('frozen customer repair lost its exact target');
    const activity = db.prepare(`
      UPDATE customer_activity SET stage_to='lead'
      WHERE id=23 AND customer_id=8 AND stage_to='new_lead'
    `).run();
    if (activity.changes !== 1) throw new Error('frozen activity repair lost its exact target');
  }).immediate();

  sqliteDigest.rebuildKnowledgeChunksFts(db);
  sqliteDigest.verifyKnowledgeChunksFtsIntegrity(db, FTS_MANIFEST, { checkMainIntegrity: true });
  return Object.freeze({
    influencerRows: negativeInfluencers.length,
    customerRows: invalidCustomers.length,
    activityRows: invalidActivityFrom.length + invalidActivityTo.length,
    ftsRebuilt: true
  });
}

function adoptLegacyProductionV1(options) {
  if (!options || typeof options.sourcePath !== 'string' || typeof options.outputPath !== 'string') {
    throw new Error('sourcePath and outputPath are required');
  }
  const expectedSourceSha256 = String(options.expectedSourceSha256 || '').toLowerCase();
  if (!SHA256_PATTERN.test(expectedSourceSha256)) {
    throw new Error('expectedSourceSha256 must be an exact lowercase SHA-256');
  }
  const sourcePath = assertSourcePath(options.sourcePath);
  const outputPath = assertOutputPath(options.outputPath, sourcePath);
  const stagePath = assertPrivateStagePath(options.privateStagePath, sourcePath, outputPath);
  const sourceCapture = captureSourceIdentity(sourcePath);
  const sourceSha256 = fileDescriptorSha256(sourceCapture.fd);
  if (sourceSha256 !== expectedSourceSha256) {
    fs.closeSync(sourceCapture.fd);
    throw new Error('legacy source SHA-256 does not match the approved immutable snapshot');
  }
  let sourceLockDb;
  let sourceDb;
  let outputDb;
  let published = false;
  try {
    sourceLockDb = new Database(sourcePath, { fileMustExist: true });
    sourceLockDb.pragma('busy_timeout = 5000');
    if (sourceLockDb.pragma('journal_mode', { simple: true }) !== 'delete') {
      throw new Error('legacy source must use DELETE journal mode before adoption');
    }
    sourceLockDb.exec('BEGIN IMMEDIATE');
    assertStableSource(sourcePath, sourceCapture, sourceSha256);

    sourceDb = new Database(sourcePath, { readonly: true, fileMustExist: true });
    if (sourceDb.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('legacy source quick_check failed');
    if (sourceDb.pragma('foreign_key_check').length) throw new Error('legacy source foreign_key_check failed');
    const classification = migrationService.classifyDatabase(sourceDb, {
      rootDir: path.resolve(__dirname, '..'),
      migrations: migrationService.defaultMigrations()
    });
    if (classification.status !== 'legacy' || classification.currentVersion !== 0) {
      throw new Error(`legacy source must be exact version 0; got ${classification.status}:${classification.currentVersion}`);
    }
    const beforeCounts = baseTableRowCounts(sourceDb);
    const previousUmask = process.umask(0o077);
    try {
      sourceDb.exec(`VACUUM INTO ${sqliteString(stagePath)}`);
    } finally {
      process.umask(previousUmask);
    }
    sourceDb.close();
    sourceDb = null;
    fs.chmodSync(stagePath, 0o600);
    assertRegularSingleLink(stagePath, 'adoption stage');

    outputDb = new Database(stagePath, { fileMustExist: true });
    outputDb.pragma('journal_mode = DELETE');
    outputDb.pragma('foreign_keys = ON');
    const repairs = assertAndApplyRepairs(outputDb);
    migrationService.runMigrations(outputDb, { rootDir: path.resolve(__dirname, '..') });
    const adoptedClassification = migrationService.classifyDatabase(outputDb, {
      rootDir: path.resolve(__dirname, '..'),
      migrations: migrationService.defaultMigrations()
    });
    if (adoptedClassification.status !== 'managed' || adoptedClassification.currentVersion !== 1) {
      throw new Error('adopted output is not exact managed version 1');
    }
    sqliteDigest.verifyKnowledgeChunksFtsIntegrity(outputDb, FTS_MANIFEST, { checkMainIntegrity: true });
    if (outputDb.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('adopted output quick_check failed');
    if (outputDb.pragma('foreign_key_check').length) throw new Error('adopted output foreign_key_check failed');
    const afterCounts = baseTableRowCounts(outputDb);
    if (JSON.stringify(afterCounts) !== JSON.stringify(beforeCounts)) {
      throw new Error('legacy adoption changed base-table row counts');
    }
    outputDb.pragma('wal_checkpoint(TRUNCATE)');
    outputDb.close();
    outputDb = null;

    for (const suffix of SOURCE_SIDECAR_SUFFIXES) {
      if (fs.existsSync(`${stagePath}${suffix}`)) throw new Error(`adoption stage retained SQLite sidecar ${suffix}`);
    }
    if (typeof options.beforePublish === 'function') options.beforePublish({ sourcePath, outputPath, stagePath });
    assertStableSource(sourcePath, sourceCapture, sourceSha256);
    const fd = fs.openSync(stagePath, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    publishNoReplace(stagePath, outputPath, {
      afterLink: options.afterPublishLink,
      afterStageUnlink: options.afterPublishStageUnlink
    });
    published = true;
    assertRegularSingleLink(outputPath, 'adopted output');
    return Object.freeze({
      format: REPORT_VERSION,
      sourceVersion: 0,
      targetVersion: 1,
      sourceSha256,
      outputSha256: fileSha256(outputPath),
      baseTableCount: Object.keys(beforeCounts).length,
      baseRowCount: Object.values(beforeCounts).reduce((total, count) => total + count, 0),
      repairs
    });
  } catch (error) {
    if (sourceDb) sourceDb.close();
    if (outputDb) outputDb.close();
    if (!published) cleanupPrivateStage(stagePath);
    throw error;
  } finally {
    if (sourceLockDb) {
      try { if (sourceLockDb.inTransaction) sourceLockDb.exec('ROLLBACK'); } finally { sourceLockDb.close(); }
    }
    fs.closeSync(sourceCapture.fd);
  }
}

function parseCli(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key || !key.startsWith('--') || value === undefined) {
      throw new Error('expected --source and --output');
    }
    if (key === '--source') options.sourcePath = value;
    else if (key === '--output') options.outputPath = value;
    else if (key === '--expected-source-sha256') options.expectedSourceSha256 = value;
    else throw new Error(`unknown argument ${key}`);
  }
  return options;
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(adoptLegacyProductionV1(parseCli(process.argv.slice(2))))}\n`);
  } catch (error) {
    process.stderr.write(`legacy production v1 adoption failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  ALLOWED_V1_CUSTOMER_STAGES,
  EXPECTED_REPAIR_PROFILE,
  FTS_MANIFEST,
  REPORT_VERSION,
  adoptLegacyProductionV1,
  _testing: Object.freeze({
    assertStableSource,
    captureSourceIdentity,
    publishNoReplace
  })
};

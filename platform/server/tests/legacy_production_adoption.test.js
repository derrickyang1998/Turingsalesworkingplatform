'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const adoption = require('../scripts/adopt_legacy_production_v1');
const legacy = require('../migrations/baselines/legacy_v1');
const migration001 = require('../migrations/001_legacy_compat_columns');
const migrationService = require('../services/migration_service');
const sqliteDigest = require('../services/sqlite_digest_service');

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function productionShapeFixture(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `tm-legacy-adoption-${name}-`));
  const sourcePath = path.join(root, 'source.db');
  const outputPath = path.join(root, 'adopted.db');
  const db = new Database(sourcePath);
  db.pragma('foreign_keys = ON');
  legacy.apply(db);
  migration001.apply(db);
  db.prepare(`
    INSERT INTO users (id,username,password_hash,display_name,role)
    VALUES (1,'admin','hash','Admin','admin')
  `).run();
  db.prepare(`
    INSERT INTO influencers (id,platform,kol_handle,cost_usd,quoted_price,cpm,cpv)
    VALUES (128,'YouTube','@production-shape',-3000,-4500,-137.2,-0.14)
  `).run();
  db.prepare(`
    INSERT INTO customers (id,brand_name,stage,created_by,assigned_to)
    VALUES (8,'Production shape customer','new_lead',1,1)
  `).run();
  db.prepare(`
    INSERT INTO customer_activity (id,customer_id,user_id,action,stage_from,stage_to)
    VALUES (23,8,1,'stage_change','proposal','new_lead')
  `).run();
  const entryId = Number(db.prepare(`
    INSERT INTO knowledge_entries (
      entry_type,source_type,key_terms,content,created_by,is_public,title,tags_json,visibility
    ) VALUES ('note','legacy-adoption','legacy adoption','Private adoption content',1,0,'Private title','[]','private')
  `).run().lastInsertRowid);
  db.prepare(`
    INSERT INTO knowledge_chunks (entry_id,chunk_index,content,token_count)
    VALUES (?,0,'Private adoption chunk',4)
  `).run(entryId);
  sqliteDigest.rebuildKnowledgeChunksFts(db);
  db.exec('DELETE FROM knowledge_chunks_fts');
  db.close();
  return { root, sourcePath, outputPath };
}

test('legacy production adoption repairs the frozen profile and publishes exact managed v1', (t) => {
  const fixture = productionShapeFixture('success');
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const sourceBefore = sha256(fixture.sourcePath);
  const report = adoption.adoptLegacyProductionV1({
    sourcePath: fixture.sourcePath,
    outputPath: fixture.outputPath,
    expectedSourceSha256: sourceBefore
  });
  assert.equal(report.format, adoption.REPORT_VERSION);
  assert.equal(report.sourceVersion, 0);
  assert.equal(report.targetVersion, 1);
  assert.equal(report.sourceSha256, sourceBefore);
  assert.equal(sha256(fixture.sourcePath), sourceBefore);
  assert.equal(report.outputSha256, sha256(fixture.outputPath));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(fixture.outputPath).mode & 0o777, 0o600);
  }
  assert.deepEqual(report.repairs, {
    influencerRows: 1,
    customerRows: 1,
    activityRows: 1,
    ftsRebuilt: true
  });

  const output = new Database(fixture.outputPath, { fileMustExist: true });
  try {
    assert.deepEqual(
      migrationService.classifyDatabase(output, {
        rootDir: path.resolve(__dirname, '..'),
        migrations: migrationService.defaultMigrations()
      }),
      { status: 'managed', currentVersion: 1 }
    );
    assert.deepEqual(
      output.prepare('SELECT id,cost_usd,quoted_price FROM influencers WHERE id=128').get(),
      { id: 128, cost_usd: 3000, quoted_price: 4500 }
    );
    assert.deepEqual(output.prepare('SELECT id,stage FROM customers WHERE id=8').get(), { id: 8, stage: 'lead' });
    assert.deepEqual(
      output.prepare('SELECT id,customer_id,stage_to FROM customer_activity WHERE id=23').get(),
      { id: 23, customer_id: 8, stage_to: 'lead' }
    );
    assert.doesNotThrow(() => sqliteDigest.verifyKnowledgeChunksFtsIntegrity(
      output, adoption.FTS_MANIFEST, { checkMainIntegrity: true }
    ));
  } finally {
    output.close();
  }
});

test('legacy production adoption accepts the exact post-upload negative amount profile', (t) => {
  const fixture = productionShapeFixture('post-upload-profile');
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const db = new Database(fixture.sourcePath);
  db.prepare(`
    INSERT INTO influencers (id,platform,kol_handle,cost_usd,quoted_price,cpm,cpv)
    VALUES
      (2702,'YouTube','@known-duplicate',-3000,-4500,-137.2,-0.14),
      (2734,'Instagram','@known-quote-a',0,-1500,-20.16,-0.02),
      (2760,'TikTok','@known-quote-b',0,-4000,-60.61,-0.06)
  `).run();
  db.prepare(`
    INSERT INTO influencers (id,platform,kol_handle,avg_views_10,cost_usd,quoted_price,cpm,cpv)
    VALUES (2740,'TikTok','@known-concatenated-quote',49000,0,8.00018000112e19,1.63268979614694e18,1.63268979614694e15)
  `).run();
  db.close();
  const sourceBefore = sha256(fixture.sourcePath);

  const report = adoption.adoptLegacyProductionV1({
    sourcePath: fixture.sourcePath,
    outputPath: fixture.outputPath,
    expectedSourceSha256: sourceBefore
  });

  assert.equal(sha256(fixture.sourcePath), sourceBefore);
  assert.equal(report.repairs.influencerRows, 5);
  const output = new Database(fixture.outputPath, { readonly: true, fileMustExist: true });
  try {
    assert.deepEqual(
      output.prepare(`
        SELECT id,cost_usd,quoted_price,cpm,cpv FROM influencers
        WHERE id IN (128,2702,2734,2760) ORDER BY id
      `).all(),
      [
        { id: 128, cost_usd: 3000, quoted_price: 4500, cpm: 137.2, cpv: 0.14 },
        { id: 2702, cost_usd: 3000, quoted_price: 4500, cpm: 137.2, cpv: 0.14 },
        { id: 2734, cost_usd: 0, quoted_price: 1500, cpm: 20.16, cpv: 0.02 },
        { id: 2760, cost_usd: 0, quoted_price: 4000, cpm: 60.61, cpv: 0.06 }
      ]
    );
    assert.deepEqual(
      output.prepare('SELECT id,quoted_price,cpm,cpv FROM influencers WHERE id=2740').get(),
      { id: 2740, quoted_price: 8000, cpm: 163.27, cpv: 0.16 }
    );
  } finally {
    output.close();
  }
});

test('legacy production adoption rejects unapproved unsafe amount storage', (t) => {
  const fixture = productionShapeFixture('unsafe-amount-drift');
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const db = new Database(fixture.sourcePath);
  db.prepare(`
    INSERT INTO influencers (id,platform,kol_handle,avg_views_10,cost_usd,quoted_price,cpm,cpv)
    VALUES (129,'TikTok','@unexpected-real-quote',1000,0,1.5,1.5,0.01)
  `).run();
  db.close();
  const sourceBefore = sha256(fixture.sourcePath);

  assert.throws(
    () => adoption.adoptLegacyProductionV1({
      sourcePath: fixture.sourcePath,
      outputPath: fixture.outputPath,
      expectedSourceSha256: sourceBefore
    }),
    /frozen production repair profile/i
  );
  assert.equal(fs.existsSync(fixture.outputPath), false);
  assert.equal(sha256(fixture.sourcePath), sourceBefore);
});

test('legacy production adoption rejects repair-profile drift without publishing output', (t) => {
  const fixture = productionShapeFixture('drift');
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const db = new Database(fixture.sourcePath);
  db.prepare(`
    INSERT INTO influencers (id,platform,kol_handle,cost_usd,quoted_price)
    VALUES (129,'YouTube','@unexpected-negative',-1,0)
  `).run();
  db.close();
  const sourceBefore = sha256(fixture.sourcePath);
  assert.throws(
    () => adoption.adoptLegacyProductionV1({
      sourcePath: fixture.sourcePath,
      outputPath: fixture.outputPath,
      expectedSourceSha256: sourceBefore
    }),
    /frozen production repair profile/i
  );
  assert.equal(fs.existsSync(fixture.outputPath), false);
  assert.equal(sha256(fixture.sourcePath), sourceBefore);
});

test('legacy production adoption fails closed when a source sidecar appears before publish', (t) => {
  const fixture = productionShapeFixture('sidecar-race');
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const sourceBefore = sha256(fixture.sourcePath);
  assert.throws(
    () => adoption.adoptLegacyProductionV1({
      sourcePath: fixture.sourcePath,
      outputPath: fixture.outputPath,
      expectedSourceSha256: sourceBefore,
      beforePublish: ({ sourcePath }) => fs.writeFileSync(`${sourcePath}-wal`, 'unexpected writer')
    }),
    /forbidden SQLite sidecar -wal/i
  );
  assert.equal(fs.existsSync(fixture.outputPath), false);
  assert.equal(sha256(fixture.sourcePath), sourceBefore);
});

test('legacy production adoption publishes with atomic no-clobber semantics', (t) => {
  const fixture = productionShapeFixture('no-clobber');
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const sourceBefore = sha256(fixture.sourcePath);
  assert.throws(
    () => adoption.adoptLegacyProductionV1({
      sourcePath: fixture.sourcePath,
      outputPath: fixture.outputPath,
      expectedSourceSha256: sourceBefore,
      beforePublish: ({ outputPath }) => fs.writeFileSync(outputPath, 'operator-owned target')
    }),
    (error) => error && error.code === 'EEXIST'
  );
  assert.equal(fs.readFileSync(fixture.outputPath, 'utf8'), 'operator-owned target');
  assert.equal(sha256(fixture.sourcePath), sourceBefore);
});

test('legacy production adoption uses and retires the caller-owned private stage', (t) => {
  const fixture = productionShapeFixture('caller-owned-stage');
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const sourceBefore = sha256(fixture.sourcePath);
  const privateStagePath = path.join(fixture.root, '.legacy-adoption.private');
  let observedStagePath = null;

  adoption.adoptLegacyProductionV1({
    sourcePath: fixture.sourcePath,
    outputPath: fixture.outputPath,
    privateStagePath,
    expectedSourceSha256: sourceBefore,
    beforePublish: ({ stagePath }) => { observedStagePath = stagePath; }
  });

  assert.equal(observedStagePath, privateStagePath);
  assert.equal(fs.existsSync(privateStagePath), false);
  assert.equal(fs.existsSync(fixture.outputPath), true);
  assert.equal(sha256(fixture.sourcePath), sourceBefore);
});

test('legacy production adoption removes its exact output when post-link validation fails', (t) => {
  const fixture = productionShapeFixture('post-link-failure');
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const sourceBefore = sha256(fixture.sourcePath);
  assert.throws(
    () => adoption.adoptLegacyProductionV1({
      sourcePath: fixture.sourcePath,
      outputPath: fixture.outputPath,
      expectedSourceSha256: sourceBefore,
      afterPublishLink: () => { throw new Error('injected post-link validation failure'); }
    }),
    /injected post-link validation failure/i
  );
  assert.equal(fs.existsSync(fixture.outputPath), false);
  assert.equal(sha256(fixture.sourcePath), sourceBefore);
});

test('legacy production adoption removes its exact output when post-unlink durability fails', (t) => {
  const fixture = productionShapeFixture('post-unlink-failure');
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const sourceBefore = sha256(fixture.sourcePath);
  assert.throws(
    () => adoption.adoptLegacyProductionV1({
      sourcePath: fixture.sourcePath,
      outputPath: fixture.outputPath,
      expectedSourceSha256: sourceBefore,
      afterPublishStageUnlink: () => { throw new Error('injected post-unlink durability failure'); }
    }),
    /injected post-unlink durability failure/i
  );
  assert.equal(fs.existsSync(fixture.outputPath), false);
  assert.equal(sha256(fixture.sourcePath), sourceBefore);
});

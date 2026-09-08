'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');

const legacy = require('../migrations/baselines/legacy_v1');
const migration001 = require('../migrations/001_legacy_compat_columns');
const migration015 = require('../migrations/015_influencer_saved_views');

function openDatabase(t) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  t.after(() => db.close());
  legacy.apply(db);
  migration001.apply(db);
  migration015.apply(db);
  return db;
}

test('migration 015 creates a strict user-owned saved-view contract', (t) => {
  const db = openDatabase(t);
  const table = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='influencer_saved_views'").get();
  assert.ok(table);
  assert.match(table.sql, /STRICT$/);
  assert.deepEqual(
    db.prepare("PRAGMA table_info('influencer_saved_views')").all().map((column) => column.name),
    [
      'id', 'user_id', 'name', 'filters_json', 'visible_columns_json',
      'column_order_json', 'row_version', 'created_at', 'updated_at'
    ]
  );
  assert.ok(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='index' AND name='ux_influencer_saved_views_user_name'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='influencer_saved_views_limit_insert'").get());
});

test('migration 015 enforces ownership, canonical JSON documents, and twenty views per account', (t) => {
  const db = openDatabase(t);
  db.prepare(`
    INSERT INTO users (id,username,password_hash,display_name,role,is_active)
    VALUES (2,'view-owner','fixture-hash','View Owner','user',1)
  `).run();
  db.prepare(`
    INSERT INTO users (id,username,password_hash,display_name,role,is_active)
    VALUES (3,'view-peer','fixture-hash','View Peer','user',1)
  `).run();
  const insert = db.prepare(`
    INSERT INTO influencer_saved_views (
      user_id,name,filters_json,visible_columns_json,column_order_json
    ) VALUES (?,?,?,?,?)
  `);
  const order = JSON.stringify([
    'id','kol_handle','platform','followers','project_name','product_name','region','type',
    'parent_record','profile_link','content_deliverable','cost_usd','quoted_price','cpm','cpv'
  ]);
  for (let index = 1; index <= 20; index += 1) {
    insert.run(2, `View ${index}`, '{}', order, order);
  }
  assert.throws(
    () => insert.run(2, 'View 21', '{}', order, order),
    /saved view limit exceeded/
  );
  assert.throws(
    () => insert.run(9999, 'No owner', '{}', order, order),
    /FOREIGN KEY constraint failed/
  );
  assert.throws(
    () => db.prepare(`
      INSERT INTO influencer_saved_views (
        user_id,name,filters_json,visible_columns_json,column_order_json
      ) VALUES (3,'Broken','[]','[]','[]')
    `).run(),
    /CHECK constraint failed/
  );
});

test('migration 015 manifest and production registries expose schema version 15', () => {
  assert.equal(migration015.version, 15);
  assert.equal(migration015.name, '015_influencer_saved_views');
  assert.equal(migration015.sourcePath, 'migrations/015_influencer_saved_views.js');
  assert.ok(migration015.schemaManifest.columns.influencer_saved_views);
  const platformRoot = path.resolve(__dirname, '..', '..');
  const dbSource = fs.readFileSync(path.join(platformRoot, 'server', 'db.js'), 'utf8');
  const verifierSource = fs.readFileSync(path.join(platformRoot, 'server', 'scripts', 'verify_campaign_migration_gate.js'), 'utf8');
  const sanitizerSource = fs.readFileSync(path.join(platformRoot, 'server', 'scripts', 'sanitize_production_shape.js'), 'utf8');
  const trustedSource = fs.readFileSync(path.join(platformRoot, 'server', 'scripts', 'trusted_production_source_gate.js'), 'utf8');
  const deploySource = fs.readFileSync(path.join(platformRoot, 'deploy_v8.ps1'), 'utf8');
  assert.match(dbSource, /version:\s*15,[\s\S]*name:\s*'015_influencer_saved_views'/);
  assert.match(verifierSource, /version:\s*15,[\s\S]*name:\s*'015_influencer_saved_views'/);
  assert.match(sanitizerSource, /version:\s*15,[\s\S]*name:\s*'015_influencer_saved_views'/);
  assert.match(trustedSource, /server\/migrations\/015_influencer_saved_views\.js/);
  assert.match(deploySource, /server\\migrations\\015_influencer_saved_views\.js/);
  assert.match(trustedSource, /targetVersion:\s*16/);
});

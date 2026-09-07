'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const legacy = require('../migrations/baselines/legacy_v1');
const migration001 = require('../migrations/001_legacy_compat_columns');
const migration015 = require('../migrations/015_influencer_saved_views');
const {
  INFLUENCER_VIEW_COLUMN_KEYS,
  createInfluencerSavedViewService
} = require('../services/influencer_saved_view_service');

function fixture(t) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  t.after(() => db.close());
  legacy.apply(db);
  migration001.apply(db);
  migration015.apply(db);
  const insertUser = db.prepare(`
    INSERT INTO users (id,username,password_hash,display_name,role,is_active)
    VALUES (?,?,?,?,?,1)
  `);
  insertUser.run(2, 'view-owner', 'fixture-hash', 'View Owner', 'user');
  insertUser.run(3, 'view-peer', 'fixture-hash', 'View Peer', 'user');
  return { db, service: createInfluencerSavedViewService(db) };
}

function payload(overrides) {
  return Object.assign({
    name: 'US launch shortlist',
    filters: {
      platform: 'TikTok',
      filter_followers: '120000',
      filter_quoted_price: '2500'
    },
    visible_columns: INFLUENCER_VIEW_COLUMN_KEYS.filter((key) => key !== 'parent_record'),
    column_order: INFLUENCER_VIEW_COLUMN_KEYS.slice()
  }, overrides || {});
}

test('saved views are server persisted, update by name, and isolated by owner', (t) => {
  const { db, service } = fixture(t);
  const created = service.save({ userId: 2, body: payload() });
  assert.equal(created.status, 201);
  assert.equal(created.view.row_version, 1);
  assert.deepEqual(service.list({ userId: 3 }), { views: [] });

  const updated = service.save({
    userId: 2,
    body: payload({ filters: { platform: 'Instagram', filter_cpm: '30.5' } })
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.view.id, created.view.id);
  assert.equal(updated.view.row_version, 2);
  assert.equal(service.list({ userId: 2 }).views[0].filters.platform, 'Instagram');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM influencer_saved_views WHERE user_id=2').get().count, 1);

  const legacy = service.save({
    userId: 2,
    body: payload({ name: 'Legacy cost view', filters: { filter_cost: '2500' } })
  });
  assert.equal(legacy.view.filters.filter_cost, '2500');
  assert.equal(legacy.view.filters.filter_quoted_price, undefined);

  assert.equal(service.remove({ userId: 3, viewId: created.view.id }), false);
  assert.equal(service.remove({ userId: 2, viewId: created.view.id }), true);
  assert.equal(service.remove({ userId: 2, viewId: legacy.view.id }), true);
  assert.deepEqual(service.list({ userId: 2 }), { views: [] });
});

test('saved-view validation rejects unknown filters, column drift, unsafe names, and over-limit creation', (t) => {
  const { service } = fixture(t);
  assert.throws(
    () => service.save({ userId: 2, body: payload({ filters: { unsupported: 'x' } }) }),
    (error) => error && error.code === 'INVALID_INFLUENCER_VIEW'
  );
  assert.throws(
    () => service.save({ userId: 2, body: payload({ column_order: ['id', 'id'] }) }),
    (error) => error && error.code === 'INVALID_INFLUENCER_VIEW'
  );
  assert.throws(
    () => service.save({ userId: 2, body: payload({ visible_columns: [] }) }),
    (error) => error && error.code === 'INVALID_INFLUENCER_VIEW'
  );
  assert.throws(
    () => service.save({ userId: 2, body: payload({ name: ' '.repeat(4) }) }),
    (error) => error && error.code === 'INVALID_INFLUENCER_VIEW'
  );

  for (let index = 1; index <= 20; index += 1) {
    service.save({ userId: 2, body: payload({ name: `View ${index}` }) });
  }
  assert.throws(
    () => service.save({ userId: 2, body: payload({ name: 'View 21' }) }),
    (error) => error && error.code === 'INFLUENCER_VIEW_LIMIT'
  );
});

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');

const POLICY_COLUMNS = [
  'id',
  'org_id',
  'policy_version',
  'effective_month',
  'billing_enabled',
  'currency',
  'base_fee_cents',
  'included_tokens',
  'overage_cents_per_million_tokens',
  'changed_by',
  'reason',
  'source',
  'created_at'
];

const STATEMENT_COLUMNS = [
  'id',
  'org_id',
  'period_key',
  'period_start',
  'period_end',
  'policy_version',
  'billing_enabled',
  'currency',
  'usage_tokens',
  'usage_record_count',
  'usage_max_id',
  'included_tokens',
  'billable_tokens',
  'base_fee_cents',
  'overage_cents_per_million_tokens',
  'overage_fee_cents',
  'total_cents',
  'formula_version',
  'statement_sha256',
  'closed_by',
  'reason',
  'created_at'
];

const EXPECTED_INDEXES = [
  'idx_organization_billing_policies_effective',
  'ux_organization_billing_policies_version',
  'ux_organization_billing_statements_period'
];

const EXPECTED_TRIGGERS = [
  'organization_billing_default_after_insert',
  'organization_billing_policy_insert_guard',
  'organization_billing_policy_no_delete',
  'organization_billing_policy_no_replace_insert',
  'organization_billing_policy_no_update',
  'organization_billing_statement_insert_guard',
  'organization_billing_statement_no_delete',
  'organization_billing_statement_no_replace_insert',
  'organization_billing_statement_no_update'
];

function loadMigration() {
  try {
    return require('../migrations/031_organization_billing_statements');
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') {
      assert.fail('migration 031 has not been implemented');
    }
    throw error;
  }
}

function baseDatabase() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL,
      role TEXT NOT NULL,
      is_active INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE organizations (
      id INTEGER PRIMARY KEY,
      code TEXT NOT NULL,
      name TEXT NOT NULL
    ) STRICT;
    CREATE TABLE token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO users VALUES
      (1,'platform-admin','admin',1),
      (2,'organization-user','user',1);
    INSERT INTO organizations VALUES
      (10,'alpha','Alpha'),
      (20,'beta','Beta');
    INSERT INTO token_usage (org_id,user_id,total_tokens,created_at)
    VALUES (10,2,123,'2026-09-01 00:00:00');
  `);
  return db;
}

function monthBoundaries(db) {
  return db.prepare(`
    SELECT
      strftime('%Y-%m','now','start of month','-1 month') AS previous_key,
      datetime('now','start of month','-1 month') AS previous_start,
      datetime('now','start of month') AS current_start,
      strftime('%Y-%m','now','start of month') AS current_key,
      datetime('now','start of month','+1 month') AS next_start,
      date('now','start of month') AS current_effective_month,
      date('now','start of month','+1 month') AS next_effective_month,
      strftime('%Y-%m','now','start of month','+1 month') AS next_key,
      datetime('now','start of month','-2 month') AS two_months_ago_start,
      CURRENT_TIMESTAMP AS now_timestamp
  `).get();
}

function statementValues(db, overrides = {}) {
  const months = monthBoundaries(db);
  return {
    org_id: 10,
    period_key: months.previous_key,
    period_start: months.previous_start,
    period_end: months.current_start,
    policy_version: 2,
    billing_enabled: 1,
    currency: 'USD',
    usage_tokens: 6000,
    usage_record_count: 1,
    usage_max_id: 1,
    included_tokens: 1000,
    billable_tokens: 5000,
    base_fee_cents: 2500,
    overage_cents_per_million_tokens: 100,
    overage_fee_cents: 1,
    total_cents: 2501,
    formula_version: 'tm-billing-v1',
    statement_sha256: 'a'.repeat(64),
    closed_by: 1,
    reason: 'Close completed UTC month',
    created_at: months.now_timestamp,
    ...overrides
  };
}

function enableStatementPeriod(db) {
  const months = monthBoundaries(db);
  db.exec('DROP TRIGGER organization_billing_policy_insert_guard;');
  db.prepare(`
    INSERT INTO organization_billing_policies (
      org_id,policy_version,effective_month,billing_enabled,currency,base_fee_cents,
      included_tokens,overage_cents_per_million_tokens,changed_by,reason,source
    ) VALUES (10,2,?,1,'USD',2500,1000,100,1,'Approved statement test pricing','admin_update')
  `).run(months.previous_start.slice(0, 10));
  db.exec(loadMigration().schemaManifest.triggers.organization_billing_policy_insert_guard + ';');
}

function insertStatement(db, overrides) {
  return db.prepare(`
    INSERT INTO organization_billing_statements (
      org_id,period_key,period_start,period_end,policy_version,billing_enabled,currency,
      usage_tokens,usage_record_count,usage_max_id,included_tokens,billable_tokens,base_fee_cents,
      overage_cents_per_million_tokens,overage_fee_cents,total_cents,formula_version,
      statement_sha256,closed_by,reason,created_at
    ) VALUES (
      @org_id,@period_key,@period_start,@period_end,@policy_version,@billing_enabled,@currency,
      @usage_tokens,@usage_record_count,@usage_max_id,@included_tokens,@billable_tokens,@base_fee_cents,
      @overage_cents_per_million_tokens,@overage_fee_cents,@total_cents,@formula_version,
      @statement_sha256,@closed_by,@reason,@created_at
    )
  `).run(statementValues(db, overrides));
}

function assertForeignKey(foreignKeys, expected) {
  assert.ok(
    foreignKeys.some((foreignKey) => Object.entries(expected).every(
      ([key, value]) => foreignKey[key] === value
    )),
    `missing foreign key ${JSON.stringify(expected)}`
  );
}

test('migration 031 creates the strict billing schema, manifest, indexes, and default policies', () => {
  const migration = loadMigration();
  assert.equal(migration.version, 31);
  assert.equal(migration.name, '031_organization_billing_statements');
  assert.equal(migration.sourcePath, 'migrations/031_organization_billing_statements.js');
  assert.deepEqual(Object.keys(migration.schemaManifest.columns.organization_billing_policies), POLICY_COLUMNS);
  assert.deepEqual(Object.keys(migration.schemaManifest.columns.organization_billing_statements), STATEMENT_COLUMNS);
  assert.deepEqual(Object.keys(migration.schemaManifest.indexes).sort(), EXPECTED_INDEXES);
  assert.deepEqual(Object.keys(migration.schemaManifest.triggers).sort(), EXPECTED_TRIGGERS);

  const db = baseDatabase();
  try {
    migration.apply(db);

    for (const table of ['organization_billing_policies', 'organization_billing_statements']) {
      const schema = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table);
      assert.ok(schema);
      assert.match(schema.sql, /\) STRICT$/);
    }
    assert.deepEqual(
      db.prepare("PRAGMA table_info('organization_billing_policies')").all().map((column) => column.name),
      POLICY_COLUMNS
    );
    assert.deepEqual(
      db.prepare("PRAGMA table_info('organization_billing_statements')").all().map((column) => column.name),
      STATEMENT_COLUMNS
    );
    assert.deepEqual(
      db.prepare(`
        SELECT name FROM sqlite_schema
        WHERE type='index' AND sql IS NOT NULL
          AND tbl_name IN ('organization_billing_policies','organization_billing_statements')
        ORDER BY name
      `).all().map((row) => row.name),
      EXPECTED_INDEXES
    );
    assert.deepEqual(
      db.prepare(`
        SELECT name FROM sqlite_schema
        WHERE type='trigger'
          AND tbl_name IN ('organizations','organization_billing_policies','organization_billing_statements')
        ORDER BY name
      `).all().map((row) => row.name),
      EXPECTED_TRIGGERS
    );

    const policyForeignKeys = db.prepare("PRAGMA foreign_key_list('organization_billing_policies')").all();
    assertForeignKey(policyForeignKeys, { table: 'organizations', from: 'org_id', to: 'id', on_update: 'RESTRICT', on_delete: 'RESTRICT' });
    assertForeignKey(policyForeignKeys, { table: 'users', from: 'changed_by', to: 'id', on_update: 'RESTRICT', on_delete: 'RESTRICT' });
    const statementForeignKeys = db.prepare("PRAGMA foreign_key_list('organization_billing_statements')").all();
    assertForeignKey(statementForeignKeys, { table: 'organizations', from: 'org_id', to: 'id', on_update: 'RESTRICT', on_delete: 'RESTRICT' });
    assertForeignKey(statementForeignKeys, { table: 'users', from: 'closed_by', to: 'id', on_update: 'RESTRICT', on_delete: 'RESTRICT' });
    assertForeignKey(statementForeignKeys, { table: 'organization_billing_policies', from: 'org_id', to: 'org_id', on_update: 'RESTRICT', on_delete: 'RESTRICT' });
    assertForeignKey(statementForeignKeys, { table: 'organization_billing_policies', from: 'policy_version', to: 'policy_version', on_update: 'RESTRICT', on_delete: 'RESTRICT' });

    assert.deepEqual(db.prepare(`
      SELECT org_id,policy_version,effective_month,billing_enabled,currency,
        base_fee_cents,included_tokens,overage_cents_per_million_tokens,changed_by,reason,source
      FROM organization_billing_policies ORDER BY org_id
    `).all(), [
      {
        org_id: 10, policy_version: 1, effective_month: '1970-01-01',
        billing_enabled: 0, currency: 'USD', base_fee_cents: 0, included_tokens: 0,
        overage_cents_per_million_tokens: 0, changed_by: null, reason: null,
        source: 'migration_backfill'
      },
      {
        org_id: 20, policy_version: 1, effective_month: '1970-01-01',
        billing_enabled: 0, currency: 'USD', base_fee_cents: 0, included_tokens: 0,
        overage_cents_per_million_tokens: 0, changed_by: null, reason: null,
        source: 'migration_backfill'
      }
    ]);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM token_usage').get().count, 1);

    db.prepare("INSERT INTO organizations VALUES (30,'gamma','Gamma')").run();
    assert.deepEqual(db.prepare(`
      SELECT policy_version,effective_month,billing_enabled,currency,base_fee_cents,
        included_tokens,overage_cents_per_million_tokens,changed_by,reason,source
      FROM organization_billing_policies WHERE org_id=30
    `).get(), {
      policy_version: 1,
      effective_month: '1970-01-01',
      billing_enabled: 0,
      currency: 'USD',
      base_fee_cents: 0,
      included_tokens: 0,
      overage_cents_per_million_tokens: 0,
      changed_by: null,
      reason: null,
      source: 'organization_default'
    });
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db.close();
  }
});

test('billing policies are append-only with continuous versions and source-specific effective months', () => {
  const db = baseDatabase();
  try {
    loadMigration().apply(db);
    const months = monthBoundaries(db);
    const insertPolicy = db.prepare(`
      INSERT INTO organization_billing_policies (
        org_id,policy_version,effective_month,billing_enabled,currency,base_fee_cents,
        included_tokens,overage_cents_per_million_tokens,changed_by,reason,source
      ) VALUES (10,@policy_version,@effective_month,@billing_enabled,'USD',@base_fee_cents,
        @included_tokens,@overage_rate,@changed_by,@reason,@source)
    `);
    const validAdminPolicy = {
      policy_version: 2,
      effective_month: months.next_effective_month,
      billing_enabled: 1,
      base_fee_cents: 2500,
      included_tokens: 1000000,
      overage_rate: 300,
      changed_by: 1,
      reason: 'Approved future pricing',
      source: 'admin_update'
    };

    assert.throws(() => insertPolicy.run({
      ...validAdminPolicy,
      policy_version: 3
    }), /billing policy is invalid/i);
    assert.throws(() => insertPolicy.run({
      ...validAdminPolicy,
      effective_month: months.current_effective_month
    }), /billing policy is invalid/i);
    assert.throws(() => insertPolicy.run({
      ...validAdminPolicy,
      changed_by: null
    }), /billing policy is invalid/i);
    assert.throws(() => insertPolicy.run({
      ...validAdminPolicy,
      reason: null
    }), /billing policy is invalid|NOT NULL constraint/i);
    assert.throws(() => insertPolicy.run({
      ...validAdminPolicy,
      source: 'migration_backfill',
      effective_month: '1970-01-01',
      billing_enabled: 0,
      base_fee_cents: 0,
      included_tokens: 0,
      overage_rate: 0,
      changed_by: null,
      reason: null
    }), /billing policy is invalid/i);
    assert.throws(() => insertPolicy.run({
      ...validAdminPolicy,
      source: 'organization_default',
      effective_month: '1970-01-01',
      billing_enabled: 0,
      base_fee_cents: 0,
      included_tokens: 0,
      overage_rate: 0,
      changed_by: null,
      reason: null
    }), /billing policy is invalid/i);

    insertPolicy.run(validAdminPolicy);
    assert.equal(
      db.prepare('SELECT MAX(policy_version) AS version FROM organization_billing_policies WHERE org_id=10').get().version,
      2
    );
    assert.throws(
      () => db.prepare('UPDATE organization_billing_policies SET base_fee_cents=0 WHERE org_id=10 AND policy_version=2').run(),
      /immutable/i
    );
    assert.throws(
      () => db.prepare('DELETE FROM organization_billing_policies WHERE org_id=10 AND policy_version=2').run(),
      /immutable/i
    );
    assert.throws(() => db.prepare(`
      INSERT OR REPLACE INTO organization_billing_policies (
        id,org_id,policy_version,effective_month,billing_enabled,currency,base_fee_cents,
        included_tokens,overage_cents_per_million_tokens,changed_by,reason,source,created_at
      ) SELECT id,org_id,policy_version,effective_month,billing_enabled,currency,0,
        included_tokens,overage_cents_per_million_tokens,changed_by,reason,source,created_at
        FROM organization_billing_policies WHERE org_id=10 AND policy_version=2
    `).run(), /immutable|billing policy is invalid/i);
    assert.equal(
      db.prepare('SELECT base_fee_cents FROM organization_billing_policies WHERE org_id=10 AND policy_version=2').get().base_fee_cents,
      2500
    );
  } finally {
    db.close();
  }
});

test('billing statements accept one ended UTC month and reject invalid constrained fields', () => {
  const validDb = baseDatabase();
  try {
    loadMigration().apply(validDb);
    enableStatementPeriod(validDb);
    insertStatement(validDb);
    assert.deepEqual(validDb.prepare(`
      SELECT org_id,period_key,period_start,period_end,policy_version,billing_enabled,currency,
      usage_tokens,usage_record_count,usage_max_id,included_tokens,billable_tokens,base_fee_cents,
        overage_cents_per_million_tokens,overage_fee_cents,total_cents,formula_version,
        statement_sha256,closed_by,reason
      FROM organization_billing_statements
    `).get(), {
      org_id: 10,
      period_key: monthBoundaries(validDb).previous_key,
      period_start: monthBoundaries(validDb).previous_start,
      period_end: monthBoundaries(validDb).current_start,
      policy_version: 2,
      billing_enabled: 1,
      currency: 'USD',
      usage_tokens: 6000,
      usage_record_count: 1,
      usage_max_id: 1,
      included_tokens: 1000,
      billable_tokens: 5000,
      base_fee_cents: 2500,
      overage_cents_per_million_tokens: 100,
      overage_fee_cents: 1,
      total_cents: 2501,
      formula_version: 'tm-billing-v1',
      statement_sha256: 'a'.repeat(64),
      closed_by: 1,
      reason: 'Close completed UTC month'
    });
  } finally {
    validDb.close();
  }

  const cases = [
    ['current UTC month', (db) => {
      const months = monthBoundaries(db);
      return {
        period_key: months.current_key,
        period_start: months.current_start,
        period_end: months.next_start,
        created_at: months.previous_start
      };
    }],
    ['future creation timestamp', (db) => ({ created_at: monthBoundaries(db).next_start })],
    ['mismatched period key', (db) => ({ period_key: monthBoundaries(db).current_key })],
    ['disabled billing', () => ({ billing_enabled: 0 })],
    ['non-USD currency', () => ({ currency: 'EUR' })],
    ['negative usage', () => ({ usage_tokens: -1 })],
    ['negative usage row count', () => ({ usage_record_count: -1 })],
    ['usage watermark without rows', () => ({ usage_record_count: 0, usage_max_id: 1 })],
    ['negative included tokens', () => ({ included_tokens: -1 })],
    ['incorrect billable tokens', () => ({ billable_tokens: 4999 })],
    ['negative base fee', () => ({ base_fee_cents: -1 })],
    ['negative overage rate', () => ({ overage_cents_per_million_tokens: -1 })],
    ['negative overage fee', () => ({ overage_fee_cents: -1 })],
    ['incorrect half-up overage fee', () => ({ overage_fee_cents: 2, total_cents: 2502 })],
    ['incorrect total', () => ({ total_cents: 2500 })],
    ['unknown formula', () => ({ formula_version: 'v2' })],
    ['invalid digest', () => ({ statement_sha256: 'A'.repeat(64) })],
    ['blank reason', () => ({ reason: '   ' })],
    ['invalid creation timestamp', () => ({ created_at: '2026-09-21T00:00:00Z' })],
    ['unknown closer', () => ({ closed_by: 999 })],
    ['unknown policy', () => ({ policy_version: 999 })]
  ];

  for (const [name, invalidValues] of cases) {
    const db = baseDatabase();
    try {
      loadMigration().apply(db);
      enableStatementPeriod(db);
      assert.throws(
        () => insertStatement(db, invalidValues(db)),
        undefined,
        name
      );
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM organization_billing_statements').get().count, 0, name);
    } finally {
      db.close();
    }
  }
});

test('billing statements are unique per organization and period and reject update, delete, and replace', () => {
  const db = baseDatabase();
  try {
    loadMigration().apply(db);
    enableStatementPeriod(db);
    insertStatement(db);
    const original = db.prepare('SELECT * FROM organization_billing_statements').get();

    assert.throws(() => insertStatement(db, {
      statement_sha256: 'b'.repeat(64),
      reason: 'Conflicting duplicate close'
    }), /immutable|UNIQUE constraint/i);
    assert.throws(
      () => db.prepare('UPDATE organization_billing_statements SET total_cents=0 WHERE id=?').run(original.id),
      /immutable/i
    );
    assert.throws(
      () => db.prepare('DELETE FROM organization_billing_statements WHERE id=?').run(original.id),
      /immutable/i
    );
    assert.throws(() => db.prepare(`
      INSERT OR REPLACE INTO organization_billing_statements (
        id,org_id,period_key,period_start,period_end,policy_version,billing_enabled,currency,
        usage_tokens,usage_record_count,usage_max_id,included_tokens,billable_tokens,base_fee_cents,
        overage_cents_per_million_tokens,overage_fee_cents,total_cents,formula_version,
        statement_sha256,closed_by,reason,created_at
      ) VALUES (
        @id,@org_id,@period_key,@period_start,@period_end,@policy_version,@billing_enabled,@currency,
        @usage_tokens,@usage_record_count,@usage_max_id,@included_tokens,@billable_tokens,@base_fee_cents,
        @overage_cents_per_million_tokens,@overage_fee_cents,@total_cents,@formula_version,
        @statement_sha256,@closed_by,@reason,@created_at
      )
    `).run({ ...original, total_cents: 0 }), /immutable/i);
    assert.deepEqual(db.prepare('SELECT * FROM organization_billing_statements').get(), original);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM organization_billing_statements').get().count, 1);
  } finally {
    db.close();
  }
});

'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const legacyBaseline = require('../migrations/baselines/legacy_v1');
const migrationService = require('../services/migration_service');

const SERVER_ROOT = path.resolve(__dirname, '..');

const REGISTERED_MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 2,
    name: '002_campaign_business_spine',
    sourcePath: 'migrations/002_campaign_business_spine.js',
    engineVersion: 1,
    dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
  }),
  Object.freeze({
    version: 3,
    name: '003_campaign_workflow_dispatch_evidence',
    sourcePath: 'migrations/003_campaign_workflow_dispatch_evidence.js',
    engineVersion: 1,
    dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
  }),
  Object.freeze({
    version: 4,
    name: '004_knowledge_capacity_observability',
    sourcePath: 'migrations/004_knowledge_capacity_observability.js',
    engineVersion: 1,
    dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
  }),
  Object.freeze({
    version: 5,
    name: '005_knowledge_custody_projection',
    sourcePath: 'migrations/005_knowledge_custody_projection.js',
    engineVersion: 1,
    dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
  }),
  Object.freeze({
    version: 6,
    name: '006_crm_sales_workspace',
    sourcePath: 'migrations/006_crm_sales_workspace.js',
    engineVersion: 1,
    dependencies: Object.freeze(['migrations/vendor/bcryptjs_v3_0_3.js'])
  })
]);

const CRM_INDEX_NAMES = Object.freeze([
  'idx_crm_audit_contact_time',
  'idx_crm_audit_correlation',
  'idx_crm_audit_customer_time',
  'idx_crm_audit_opportunity_time',
  'idx_crm_audit_org_time',
  'idx_crm_audit_request',
  'idx_crm_audit_task_time',
  'idx_crm_tasks_org_customer_status_due',
  'idx_crm_tasks_org_opportunity',
  'idx_crm_tasks_org_owner_status_due',
  'idx_crm_tasks_org_team_status_due',
  'idx_customer_contacts_org_customer',
  'idx_customers_crm_org_identity',
  'idx_customers_crm_org_next_action',
  'idx_customers_crm_org_owner_updated',
  'idx_customers_crm_org_stage_updated',
  'idx_customers_crm_org_team_updated',
  'idx_opportunities_crm_org_customer',
  'idx_opportunities_crm_org_owner_updated',
  'idx_opportunities_crm_org_team_stage_updated',
  'ux_customer_contacts_preferred_active',
  'ux_customers_crm_active_identity',
  'ux_customers_crm_org_id',
  'ux_opportunities_crm_org_customer_id'
]);

const EXPECTED_INDEX_KEYS = Object.freeze({
  idx_crm_audit_contact_time: [['org_id', 0], ['contact_id', 0], ['occurred_at', 1], ['id', 1]],
  idx_crm_audit_correlation: [['org_id', 0], ['correlation_id', 0]],
  idx_crm_audit_customer_time: [['org_id', 0], ['customer_id', 0], ['occurred_at', 1], ['id', 1]],
  idx_crm_audit_opportunity_time: [['org_id', 0], ['opportunity_id', 0], ['occurred_at', 1], ['id', 1]],
  idx_crm_audit_org_time: [['org_id', 0], ['occurred_at', 1], ['id', 1]],
  idx_crm_audit_request: [['org_id', 0], ['request_id', 0]],
  idx_crm_audit_task_time: [['org_id', 0], ['task_id', 0], ['occurred_at', 1], ['id', 1]],
  idx_crm_tasks_org_customer_status_due: [['org_id', 0], ['customer_id', 0], ['status', 0], ['due_at', 0], ['id', 0]],
  idx_crm_tasks_org_opportunity: [['org_id', 0], ['opportunity_id', 0], ['id', 0]],
  idx_crm_tasks_org_owner_status_due: [['org_id', 0], ['owner_user_id', 0], ['status', 0], ['due_at', 0], ['id', 0]],
  idx_crm_tasks_org_team_status_due: [['org_id', 0], ['team_id', 0], ['status', 0], ['due_at', 0], ['id', 0]],
  idx_customer_contacts_org_customer: [['org_id', 0], ['customer_id', 0], ['archived_at', 0], ['id', 0]],
  idx_customers_crm_org_identity: [['org_id', 0], ['normalized_identity_key', 0]],
  idx_customers_crm_org_next_action: [['org_id', 0], ['next_action_at', 0]],
  idx_customers_crm_org_owner_updated: [['org_id', 0], ['assigned_to', 0], ['updated_at', 1], ['id', 1]],
  idx_customers_crm_org_stage_updated: [['org_id', 0], ['stage', 0], ['updated_at', 1], ['id', 1]],
  idx_customers_crm_org_team_updated: [['org_id', 0], ['team_id', 0], ['updated_at', 1], ['id', 1]],
  idx_opportunities_crm_org_customer: [['org_id', 0], ['customer_id', 0]],
  idx_opportunities_crm_org_owner_updated: [['org_id', 0], ['owner_user_id', 0], ['updated_at', 1], ['id', 1]],
  idx_opportunities_crm_org_team_stage_updated: [['org_id', 0], ['team_id', 0], ['stage', 0], ['updated_at', 1], ['id', 1]],
  ux_customer_contacts_preferred_active: [['org_id', 0], ['customer_id', 0]],
  ux_customers_crm_active_identity: [['org_id', 0], ['normalized_identity_key', 0]],
  ux_customers_crm_org_id: [['org_id', 0], ['id', 0]],
  ux_opportunities_crm_org_customer_id: [['org_id', 0], ['customer_id', 0], ['id', 0]]
});

const CRM_TRIGGER_NAMES = Object.freeze([
  'crm_audit_events_append_only_delete',
  'crm_audit_events_append_only_update',
  'crm_tasks_identity_immutable',
  'crm_tasks_no_hard_delete',
  'customer_contacts_identity_immutable',
  'customer_contacts_no_hard_delete'
]);

const CRM_TABLE_NAMES = Object.freeze([
  'crm_audit_events',
  'crm_tasks',
  'customer_contacts'
]);

const EXPECTED_CUSTOMER_COLUMNS = Object.freeze([
  ['org_id', 'INTEGER', 0, null, 0],
  ['team_id', 'INTEGER', 0, null, 0],
  ['country', 'TEXT', 0, null, 0],
  ['next_action_at', 'TEXT', 0, null, 0],
  ['stalled_at', 'TEXT', 0, null, 0],
  ['normalized_identity_key', 'TEXT', 0, null, 0],
  ['duplicate_enforced', 'INTEGER', 1, '0', 0]
]);

const EXPECTED_OPPORTUNITY_COLUMNS = Object.freeze([
  ['org_id', 'INTEGER', 0, null, 0],
  ['team_id', 'INTEGER', 0, null, 0],
  ['owner_user_id', 'INTEGER', 0, null, 0],
  ['next_action_at', 'TEXT', 0, null, 0],
  ['loss_reason', 'TEXT', 0, null, 0],
  ['closed_at', 'TEXT', 0, null, 0],
  ['campaign_id', 'INTEGER', 0, null, 0]
]);

const EXPECTED_NEW_TABLE_COLUMNS = Object.freeze({
  customer_contacts: Object.freeze([
    ['id', 'INTEGER', 0, null, 1],
    ['org_id', 'INTEGER', 1, null, 0],
    ['customer_id', 'INTEGER', 1, null, 0],
    ['name', 'TEXT', 1, null, 0],
    ['role', 'TEXT', 0, null, 0],
    ['email', 'TEXT', 0, null, 0],
    ['phone', 'TEXT', 0, null, 0],
    ['is_preferred', 'INTEGER', 1, '0', 0],
    ['created_by', 'INTEGER', 1, null, 0],
    ['created_at', 'TEXT', 1, 'CURRENT_TIMESTAMP', 0],
    ['updated_at', 'TEXT', 1, 'CURRENT_TIMESTAMP', 0],
    ['archived_at', 'TEXT', 0, null, 0]
  ]),
  crm_tasks: Object.freeze([
    ['id', 'INTEGER', 0, null, 1],
    ['org_id', 'INTEGER', 1, null, 0],
    ['team_id', 'INTEGER', 0, null, 0],
    ['customer_id', 'INTEGER', 1, null, 0],
    ['opportunity_id', 'INTEGER', 0, null, 0],
    ['owner_user_id', 'INTEGER', 1, null, 0],
    ['title', 'TEXT', 1, null, 0],
    ['description', 'TEXT', 0, null, 0],
    ['due_at', 'TEXT', 1, null, 0],
    ['status', 'TEXT', 1, "'open'", 0],
    ['source', 'TEXT', 1, "'manual'", 0],
    ['completed_at', 'TEXT', 0, null, 0],
    ['completed_by', 'INTEGER', 0, null, 0],
    ['completion_note', 'TEXT', 0, null, 0],
    ['created_by', 'INTEGER', 1, null, 0],
    ['created_at', 'TEXT', 1, 'CURRENT_TIMESTAMP', 0],
    ['updated_at', 'TEXT', 1, 'CURRENT_TIMESTAMP', 0]
  ]),
  crm_audit_events: Object.freeze([
    ['id', 'INTEGER', 0, null, 1],
    ['org_id', 'INTEGER', 1, null, 0],
    ['customer_id', 'INTEGER', 0, null, 0],
    ['opportunity_id', 'INTEGER', 0, null, 0],
    ['task_id', 'INTEGER', 0, null, 0],
    ['contact_id', 'INTEGER', 0, null, 0],
    ['actor_user_id', 'INTEGER', 0, null, 0],
    ['event_type', 'TEXT', 1, null, 0],
    ['request_id', 'TEXT', 0, null, 0],
    ['correlation_id', 'TEXT', 0, null, 0],
    ['occurred_at', 'TEXT', 1, 'CURRENT_TIMESTAMP', 0],
    ['metadata_json', 'TEXT', 1, "'{}'", 0]
  ])
});

function migrationOptions() {
  return {
    rootDir: SERVER_ROOT,
    registeredMigrations: REGISTERED_MIGRATIONS
  };
}

function version5MigrationOptions() {
  return {
    rootDir: SERVER_ROOT,
    registeredMigrations: REGISTERED_MIGRATIONS.slice(0, 4)
  };
}

function temporaryDatabase(t, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `tm-crm-v6-${label}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'crm.db');
}

function columnShape(db, tableName, names) {
  const wanted = new Set(names);
  return db.pragma(`table_xinfo(${JSON.stringify(tableName)})`)
    .filter((column) => wanted.has(column.name))
    .map((column) => [
      column.name,
      String(column.type).toUpperCase(),
      column.notnull,
      column.dflt_value,
      column.pk
    ]);
}

function userSchemaObjectIdentities(db) {
  return db.prepare(`
    SELECT type,name
    FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY CAST(type AS BLOB),CAST(name AS BLOB)
  `).all().map((row) => `${row.type}:${row.name}`);
}

function indexContract(db, indexName) {
  const owner = db.prepare(`
    SELECT tbl_name FROM sqlite_schema WHERE type='index' AND name=?
  `).get(indexName);
  assert.ok(owner, `missing index ${indexName}`);
  const metadata = db.pragma(`index_list(${JSON.stringify(owner.tbl_name)})`)
    .find((index) => index.name === indexName);
  assert.ok(metadata, `missing index metadata ${indexName}`);
  return {
    keys: db.pragma(`index_xinfo(${JSON.stringify(indexName)})`)
      .filter((column) => column.key === 1 && column.name !== null)
      .map((column) => [column.name, column.desc]),
    partial: metadata.partial,
    unique: metadata.unique
  };
}

function assertExactCrmSchema(db) {
  for (const tableName of CRM_TABLE_NAMES) {
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type='table' AND name=?").get(tableName).count,
      1,
      `missing exact CRM table ${tableName}`
    );
  }
  for (const triggerName of CRM_TRIGGER_NAMES) {
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type='trigger' AND name=?").get(triggerName).count,
      1,
      `missing exact CRM trigger ${triggerName}`
    );
  }
  assert.deepEqual(
    columnShape(db, 'customers', EXPECTED_CUSTOMER_COLUMNS.map((column) => column[0])),
    EXPECTED_CUSTOMER_COLUMNS
  );
  assert.deepEqual(
    columnShape(db, 'opportunities', EXPECTED_OPPORTUNITY_COLUMNS.map((column) => column[0])),
    EXPECTED_OPPORTUNITY_COLUMNS
  );
  for (const [tableName, expectedColumns] of Object.entries(EXPECTED_NEW_TABLE_COLUMNS)) {
    assert.deepEqual(
      columnShape(db, tableName, expectedColumns.map((column) => column[0])),
      expectedColumns,
      `${tableName} columns must match the approved manifest`
    );
    const metadata = db.pragma(`table_list(${JSON.stringify(tableName)})`)
      .find((row) => row.schema === 'main' && row.name === tableName);
    assert.equal(metadata.strict, 1, `${tableName} must be STRICT`);
  }
  const uniqueIndexes = new Set([
    'ux_customer_contacts_preferred_active',
    'ux_customers_crm_active_identity',
    'ux_customers_crm_org_id',
    'ux_opportunities_crm_org_customer_id'
  ]);
  const partialIndexes = new Set([
    'idx_crm_audit_correlation',
    'idx_crm_audit_request',
    'ux_customer_contacts_preferred_active',
    'ux_customers_crm_active_identity'
  ]);
  for (const [indexName, expectedKeys] of Object.entries(EXPECTED_INDEX_KEYS)) {
    const actual = indexContract(db, indexName);
    assert.deepEqual(actual.keys, expectedKeys, `${indexName} key order must match the approved contract`);
    assert.equal(actual.unique, uniqueIndexes.has(indexName) ? 1 : 0, `${indexName} uniqueness must match`);
    assert.equal(actual.partial, partialIndexes.has(indexName) ? 1 : 0, `${indexName} partial flag must match`);
  }
  const identityIndexSql = db.prepare(
    "SELECT sql FROM sqlite_schema WHERE type='index' AND name='ux_customers_crm_active_identity'"
  ).get().sql.replace(/\s+/g, ' ').trim();
  assert.match(identityIndexSql, /WHERE duplicate_enforced=1 AND normalized_identity_key IS NOT NULL AND stage NOT IN \('paused','won','lost'\)$/);
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function captureLegacyProjection(db, frozenColumns) {
  const tableNames = [
    'campaign_record_links',
    'customer_activity',
    'customers',
    'opportunities'
  ];
  const columns = frozenColumns || Object.fromEntries(tableNames.map((tableName) => [
    tableName,
    db.pragma(`table_info(${JSON.stringify(tableName)})`).map((column) => column.name)
  ]));
  const rows = {};
  for (const tableName of tableNames) {
    const selection = columns[tableName].map(quoteIdentifier).join(',');
    const primaryKeys = db.pragma(`table_info(${JSON.stringify(tableName)})`)
      .filter((column) => column.pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map((column) => quoteIdentifier(column.name));
    const orderBy = primaryKeys.length ? ` ORDER BY ${primaryKeys.join(',')}` : '';
    rows[tableName] = db.prepare(
      `SELECT ${selection} FROM ${quoteIdentifier(tableName)}${orderBy}`
    ).all();
  }
  return { columns, rows };
}

function buildPopulatedVersion5Fixture(t, label) {
  const databasePath = temporaryDatabase(t, label);
  const legacy = new Database(databasePath);
  legacy.pragma('foreign_keys = ON');
  legacyBaseline.apply(legacy);
  const insertUser = legacy.prepare(`
    INSERT INTO users (
      id,username,password_hash,display_name,role,email,department,
      api_quota,created_at,is_active
    ) VALUES (?,?,?,?,?,?,?,?,?,?)
  `);
  insertUser.run(101, 'crm-admin', 'fixture-hash', 'CRM Admin', 'admin', 'admin@example.test', 'Sales', 50000, '2026-01-01 00:00:00', 1);
  insertUser.run(102, 'crm-inactive', 'fixture-hash', 'CRM Inactive', 'user', 'inactive@example.test', 'Dormant', 50000, '2026-01-01 00:00:00', 0);
  insertUser.run(103, 'crm-owner', 'fixture-hash', 'CRM Owner', 'user', 'owner@example.test', 'Operations', 50000, '2026-01-01 00:00:00', 1);

  const insertCustomer = legacy.prepare(`
    INSERT INTO customers (
      id,brand_name,company_name,contact_person,contact_info,industry,stage,
      source,budget_estimate,notes,created_by,assigned_to,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const customerRows = [
    [1001, 'Acme', null, 'Alice', 'opaque-1', 'Technology', 'lead', 'fixture', '1000', 'preserve-one', 101, 101, '2026-01-02 00:00:00', '2026-01-03 00:00:00'],
    [1002, 'Public Brand', 'Public Ltd', 'Bob', 'opaque-2', 'Retail', 'info_confirmed', 'fixture', '2000', 'preserve-two', 101, null, '2026-01-02 00:00:01', '2026-01-03 00:00:01'],
    [1003, 'Dormant Brand', 'Dormant Ltd', 'Carol', 'opaque-3', 'Services', 'needs_confirmed', 'fixture', '3000', 'preserve-three', 101, 102, '2026-01-02 00:00:02', '2026-01-03 00:00:02'],
    [1004, 'Unassigned Brand', '', 'Dan', 'opaque-4', 'Services', 'analysis', 'fixture', '4000', 'preserve-four', 101, null, '2026-01-02 00:00:03', '2026-01-03 00:00:03'],
    [1005, 'Assigned Public', 'Contradiction Ltd', 'Eve', 'opaque-5', 'Services', 'proposal', 'fixture', '5000', 'preserve-five', 101, 101, '2026-01-02 00:00:04', '2026-01-03 00:00:04'],
    [1006, 'A\u0000cME', '', 'Frank', 'opaque-6', 'Technology', 'proposal', 'fixture', '6000', 'preserve-six', 103, 103, '2026-01-02 00:00:05', '2026-01-03 00:00:05'],
    [1007, 'ACME, Inc.', '', 'Grace', 'opaque-7', 'Technology', 'cooperation', 'fixture', '7000', 'preserve-seven', 101, 101, '2026-01-02 00:00:06', '2026-01-03 00:00:06'],
    [1008, 'Straße', '', 'Heidi', 'opaque-8', 'Technology', null, 'fixture', '8000', 'preserve-eight', 101, 101, '2026-01-02 00:00:07', '2026-01-03 00:00:07'],
    [1009, 'Legacy Stage', '', 'Ivan', 'opaque-9', 'Technology', 'negotiation', 'fixture', '9000', 'preserve-nine', 101, 101, '2026-01-02 00:00:08', '2026-01-03 00:00:08'],
    [1010, 'Terminal Brand', '', 'Judy', 'opaque-10', 'Technology', 'won', 'fixture', '10000', 'preserve-ten', 101, 101, '2026-01-02 00:00:09', '2026-01-03 00:00:09']
  ];
  for (const row of customerRows) insertCustomer.run(...row);

  const insertOpportunity = legacy.prepare(`
    INSERT INTO opportunities (
      id,customer_id,name,stage,value,win_probability,product_name,
      channel_type,notes,created_by,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  insertOpportunity.run(2001, 1001, 'Private Opportunity', 'proposal', 1111.5, 70, 'Private Product', 'influencer', 'preserve-opportunity-one', 101, '2026-01-04 00:00:00', '2026-01-05 00:00:00');
  insertOpportunity.run(2002, 1002, 'Public Opportunity', 'discovery', 2222, 20, 'Public Product', 'influencer', 'preserve-opportunity-two', 101, '2026-01-04 00:00:01', '2026-01-05 00:00:01');
  insertOpportunity.run(2003, 1003, 'Quarantine Opportunity', 'qualification', 3333, 30, 'Dormant Product', 'influencer', 'preserve-opportunity-three', 101, '2026-01-04 00:00:02', '2026-01-05 00:00:02');
  insertOpportunity.run(2004, 1005, 'Contradictory Opportunity', 'negotiation', 4444, 40, 'Contradictory Product', 'influencer', 'preserve-opportunity-four', 101, '2026-01-04 00:00:03', '2026-01-05 00:00:03');
  legacy.prepare(`
    INSERT INTO customer_activity (
      id,customer_id,user_id,action,stage_from,stage_to,notes,created_at
    ) VALUES (3001,1001,101,'fixture_activity','lead','proposal','preserve-activity','2026-01-06 00:00:00')
  `).run();
  legacy.close();

  const version5 = migrationService.openMigratedDatabase(databasePath, version5MigrationOptions());
  const updateCustomerCompatibility = version5.prepare(`
    UPDATE customers
    SET opportunity_value=?,win_probability=?,tags=?,is_public=?,priority=?
    WHERE id=?
  `);
  const compatibilityRows = [
    [1000.25, 65, 'alpha,beta', 0, 'high', 1001],
    [2000, 50, 'public', 1, 'medium', 1002],
    [3000, 40, 'inactive', 0, 'low', 1003],
    [4000, 30, 'unassigned', 0, 'medium', 1004],
    [5000, 20, 'contradictory', 1, 'medium', 1005],
    [6000, 70, 'collision', 0, 'high', 1006],
    [7000, 80, 'singleton', 0, 'high', 1007],
    [8000, 55, 'null-stage', 0, 'medium', 1008],
    [9000, 45, 'legacy-stage', 0, 'medium', 1009],
    [10000, 100, 'terminal', 0, 'low', 1010]
  ];
  for (const row of compatibilityRows) updateCustomerCompatibility.run(...row);
  const defaultOrganization = version5.prepare(
    "SELECT id FROM organizations WHERE code='turingmarket-default'"
  ).get();
  const teamByUser = Object.fromEntries(version5.prepare(`
    SELECT user_id,team_id
    FROM team_memberships
    WHERE org_id=? AND status='active'
    ORDER BY user_id
  `).all(defaultOrganization.id).map((row) => [row.user_id, row.team_id]));
  version5.prepare(`
    INSERT INTO campaigns (
      id,org_id,name,customer_id,opportunity_id,owner_user_id,team_id,
      lifecycle_state,operational_status,row_version,created_at,updated_at
    ) VALUES (4001,?,'CRM v6 fixture',1001,2001,101,?,'lead','active',1,'2026-01-07 00:00:00','2026-01-07 00:00:00')
  `).run(defaultOrganization.id, teamByUser[101]);
  const influencer = version5.prepare('SELECT id FROM influencers ORDER BY id LIMIT 1').get();
  version5.prepare(`
    INSERT INTO campaign_record_links (
      id,org_id,campaign_id,record_type,bundle_id,record_id,relation_type,
      created_by,metadata_json,created_at
    ) VALUES (5001,?,4001,'influencer',?,?,'shortlist',101,?,'2026-01-08 00:00:00')
  `).run(
    defaultOrganization.id,
    crypto.createHash('sha256').update('crm-v6-fixture').digest('hex'),
    String(influencer.id),
    JSON.stringify({ fixture: 'crm-v6', preserve: true })
  );
  const before = captureLegacyProjection(version5);
  version5.close();
  return {
    before,
    databasePath,
    defaultOrganizationId: defaultOrganization.id,
    teamByUser
  };
}

function captureV6State(db) {
  return {
    schema: db.prepare(`
      SELECT type,name,tbl_name,sql
      FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY CAST(type AS BLOB),CAST(name AS BLOB),CAST(tbl_name AS BLOB)
    `).all(),
    ledger: db.prepare(`
      SELECT version,name,checksum,source_path,engine_version,applied_at
      FROM schema_migrations
      ORDER BY version
    `).all(),
    legacy: captureLegacyProjection(db),
    customers: db.prepare(`
      SELECT id,org_id,team_id,country,next_action_at,stalled_at,
        normalized_identity_key,duplicate_enforced
      FROM customers ORDER BY id
    `).all(),
    opportunities: db.prepare(`
      SELECT id,org_id,team_id,owner_user_id,next_action_at,loss_reason,
        closed_at,campaign_id
      FROM opportunities ORDER BY id
    `).all(),
    audit: db.prepare('SELECT * FROM crm_audit_events ORDER BY id').all()
  };
}

test('empty database applies contiguous CRM migration version 6 with the exact descriptor', (t) => {
  const databasePath = temporaryDatabase(t, 'empty-registration');
  const db = migrationService.openMigratedDatabase(databasePath, migrationOptions());
  try {
    const ledger = db.prepare(`
      SELECT version,name,checksum,source_path,engine_version
      FROM schema_migrations
      WHERE version=6
    `).get();
    assert.deepEqual(ledger, {
      version: 6,
      name: '006_crm_sales_workspace',
      checksum: migrationService.computeRegisteredMigrationChecksum(
        REGISTERED_MIGRATIONS[4],
        migrationOptions()
      ),
      source_path: 'migrations/006_crm_sales_workspace.js',
      engine_version: 1
    });
    assert.deepEqual(
      [...require('../migrations/006_crm_sales_workspace').dependencies],
      ['migrations/vendor/bcryptjs_v3_0_3.js']
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count,
      6,
      'the registry must remain contiguous from version 1 through version 6'
    );
  } finally {
    db.close();
  }
});

test('db.js runtime registry opens a temporary database at migration version 6', (t) => {
  const databasePath = temporaryDatabase(t, 'runtime-registration');
  const script = [
    "const db = require('./db');",
    "const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get();",
    'db.close();',
    'process.stdout.write(String(row.version));'
  ].join('\n');
  const child = spawnSync(process.execPath, ['-e', script], {
    cwd: SERVER_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      DB_PATH: databasePath,
      NODE_ENV: 'test'
    }
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, '6');
});

test('empty v6 migration installs the exact additive CRM schema manifest', (t) => {
  const version5Path = temporaryDatabase(t, 'schema-v5');
  const version6Path = temporaryDatabase(t, 'schema-v6');
  const version5 = migrationService.openMigratedDatabase(version5Path, version5MigrationOptions());
  const beforeObjects = userSchemaObjectIdentities(version5);
  version5.close();

  const version6 = migrationService.openMigratedDatabase(version6Path, migrationOptions());
  try {
    const afterObjects = userSchemaObjectIdentities(version6);
    const addedObjects = afterObjects.filter((identity) => !beforeObjects.includes(identity));
    const expectedObjects = [
      ...CRM_INDEX_NAMES.map((name) => `index:${name}`),
      ...CRM_TABLE_NAMES.map((name) => `table:${name}`),
      ...CRM_TRIGGER_NAMES.map((name) => `trigger:${name}`)
    ].sort();
    assert.deepEqual(addedObjects.sort(), expectedObjects);

    assertExactCrmSchema(version6);
  } finally {
    version6.close();
  }
});

test('populated v5 migration preserves legacy rows and deterministically backfills CRM custody identity and audit evidence', (t) => {
  const fixture = buildPopulatedVersion5Fixture(t, 'populated-backfill');
  const db = migrationService.openMigratedDatabase(fixture.databasePath, migrationOptions());
  try {
    const after = captureLegacyProjection(db, fixture.before.columns);
    assert.deepEqual(after.rows, fixture.before.rows, 'all legacy columns and rows must remain byte-for-byte equivalent');

    const customers = db.prepare(`
      SELECT id,org_id,team_id,assigned_to,is_public,stage,
        normalized_identity_key,duplicate_enforced
      FROM customers
      WHERE id BETWEEN 1001 AND 1010
      ORDER BY id
    `).all();
    assert.equal(customers.length, 10);
    assert.ok(customers.every((row) => row.org_id === fixture.defaultOrganizationId));
    assert.equal(customers.find((row) => row.id === 1001).team_id, fixture.teamByUser[101]);
    assert.equal(customers.find((row) => row.id === 1002).team_id, null);
    assert.equal(customers.find((row) => row.id === 1002).assigned_to, null);
    assert.equal(customers.find((row) => row.id === 1002).is_public, 1);
    assert.equal(customers.find((row) => row.id === 1003).team_id, null);
    assert.equal(customers.find((row) => row.id === 1003).assigned_to, 102);
    assert.equal(customers.find((row) => row.id === 1004).team_id, null);
    assert.equal(customers.find((row) => row.id === 1005).team_id, null);
    assert.equal(customers.find((row) => row.id === 1006).team_id, fixture.teamByUser[103]);

    const collisionOne = customers.find((row) => row.id === 1001);
    const collisionTwo = customers.find((row) => row.id === 1006);
    assert.equal(collisionOne.normalized_identity_key, '52c230ae7e41d3c495a97ade651c3efd17af8be3ee3b6b78de53818f7d218b43');
    assert.equal(collisionTwo.normalized_identity_key, collisionOne.normalized_identity_key);
    assert.equal(collisionOne.duplicate_enforced, 0);
    assert.equal(collisionTwo.duplicate_enforced, 0);
    const singleton = customers.find((row) => row.id === 1007);
    assert.equal(singleton.normalized_identity_key, 'a8c31d1436c72ee97325e2ccb7d765e391355cad34a1ed5d0a85fc318eb6acb0');
    assert.equal(singleton.duplicate_enforced, 1);
    const unclassified = customers.find((row) => row.id === 1008);
    assert.equal(unclassified.stage, null);
    assert.equal(unclassified.normalized_identity_key, '20b427c46337ad78752d668c9f3ef6c8f40aa49db5e9b46d380a94f811708331');
    assert.equal(unclassified.duplicate_enforced, 0);
    assert.equal(customers.find((row) => row.id === 1009).stage, 'negotiation');
    assert.equal(customers.find((row) => row.id === 1009).duplicate_enforced, 0);
    assert.equal(customers.find((row) => row.id === 1010).duplicate_enforced, 0);

    assert.deepEqual(db.prepare(`
      SELECT id,org_id,team_id,owner_user_id,campaign_id
      FROM opportunities
      WHERE id BETWEEN 2001 AND 2004
      ORDER BY id
    `).all(), [
      { id: 2001, org_id: fixture.defaultOrganizationId, team_id: fixture.teamByUser[101], owner_user_id: 101, campaign_id: null },
      { id: 2002, org_id: fixture.defaultOrganizationId, team_id: null, owner_user_id: null, campaign_id: null },
      { id: 2003, org_id: fixture.defaultOrganizationId, team_id: null, owner_user_id: null, campaign_id: null },
      { id: 2004, org_id: fixture.defaultOrganizationId, team_id: null, owner_user_id: null, campaign_id: null }
    ]);

    const audit = db.prepare(`
      SELECT customer_id,opportunity_id,event_type,actor_user_id,metadata_json
      FROM crm_audit_events
      ORDER BY id
    `).all();
    assert.equal(audit.length, 10);
    assert.equal(audit.filter((row) => row.event_type === 'crm_backfill_quarantined').length, 6);
    assert.equal(audit.filter((row) => row.event_type === 'crm_legacy_duplicate_collision').length, 2);
    assert.equal(audit.filter((row) => row.event_type === 'crm_legacy_stage_unclassified').length, 2);
    assert.ok(audit.every((row) => row.actor_user_id === null));
    assert.ok(audit.every((row) => !row.metadata_json.includes('Public Brand')));
    assert.ok(audit.every((row) => !row.metadata_json.includes('Dormant Brand')));
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db.close();
  }
});

test('managed second open and direct apply are deterministic no-ops on a complete exact v6 database', (t) => {
  const fixture = buildPopulatedVersion5Fixture(t, 'rerun-noop');
  const first = migrationService.openMigratedDatabase(fixture.databasePath, migrationOptions());
  const initialState = captureV6State(first);
  first.close();

  const second = migrationService.openMigratedDatabase(fixture.databasePath, migrationOptions());
  try {
    assert.deepEqual(captureV6State(second), initialState, 'managed second open must not mutate schema, ledger, data, or audit evidence');
    const crmMigration = require('../migrations/006_crm_sales_workspace');
    crmMigration.apply(second);
    assert.deepEqual(captureV6State(second), initialState, 'direct apply on exact complete v6 must be read-only');
  } finally {
    second.close();
  }
});

test('identity migration matches G1-G8 and keeps unclassified matching rows unenforced but discoverable', (t) => {
  const fixture = buildPopulatedVersion5Fixture(t, 'identity-goldens');
  const version5 = new Database(fixture.databasePath);
  version5.pragma('foreign_keys = ON');
  const insert = version5.prepare(`
    INSERT INTO customers (
      id,brand_name,company_name,stage,source,created_by,assigned_to,
      created_at,updated_at,is_public
    ) VALUES (?,?,?,?, 'identity-fixture',101,101,'2026-02-01 00:00:00','2026-02-01 00:00:00',0)
  `);
  insert.run(1102, 'ＡＣＭＥ', '  Turing\t LLC ', 'lead');
  insert.run(1103, 'acme', 'turing llc', 'lead');
  insert.run(1104, '图灵　市场', '图灵（上海）有限公司', 'lead');
  insert.run(1107, 'ACME Inc', '', 'lead');
  insert.run(1110, 'ACME, Inc.', '', 'maintenance');
  version5.close();

  const db = migrationService.openMigratedDatabase(fixture.databasePath, migrationOptions());
  try {
    const identities = new Map(db.prepare(`
      SELECT id,normalized_identity_key,duplicate_enforced,stage
      FROM customers
      WHERE id IN (1001,1006,1007,1008,1102,1103,1104,1107,1110)
      ORDER BY id
    `).all().map((row) => [row.id, row]));
    assert.equal(identities.get(1001).normalized_identity_key, '52c230ae7e41d3c495a97ade651c3efd17af8be3ee3b6b78de53818f7d218b43');
    assert.equal(identities.get(1006).normalized_identity_key, identities.get(1001).normalized_identity_key);
    assert.equal(identities.get(1102).normalized_identity_key, 'f75bfca8995cc6ccfb89a1d24762d91c6897506642313d6173ea0b46d3d1baa4');
    assert.equal(identities.get(1103).normalized_identity_key, identities.get(1102).normalized_identity_key);
    assert.equal(identities.get(1104).normalized_identity_key, '8a4df2209be26d0faabb531aaab977ef23e967f8f218f276ea6e57b2081cade5');
    assert.equal(identities.get(1007).normalized_identity_key, 'a8c31d1436c72ee97325e2ccb7d765e391355cad34a1ed5d0a85fc318eb6acb0');
    assert.equal(identities.get(1107).normalized_identity_key, 'fb3ef74c6bea3c59527c15da431b10f6bc638b6bfae5eeb99af9521a767db4bf');
    assert.notEqual(identities.get(1007).normalized_identity_key, identities.get(1107).normalized_identity_key);
    assert.equal(identities.get(1008).normalized_identity_key, '20b427c46337ad78752d668c9f3ef6c8f40aa49db5e9b46d380a94f811708331');

    assert.equal(identities.get(1007).duplicate_enforced, 1);
    assert.equal(identities.get(1110).normalized_identity_key, identities.get(1007).normalized_identity_key);
    assert.equal(identities.get(1110).stage, 'maintenance');
    assert.equal(identities.get(1110).duplicate_enforced, 0);
    assert.deepEqual(db.prepare(`
      SELECT id FROM customers
      WHERE normalized_identity_key=?
      ORDER BY id
    `).all(identities.get(1007).normalized_identity_key), [{ id: 1007 }, { id: 1110 }]);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count
      FROM crm_audit_events
      WHERE customer_id=1110 AND event_type='crm_legacy_stage_unclassified'
    `).get().count, 1);
  } finally {
    db.close();
  }
});

test('active identity index rejects a second enforced key while legacy collision rows remain intact', (t) => {
  const fixture = buildPopulatedVersion5Fixture(t, 'identity-unique-index');
  const db = migrationService.openMigratedDatabase(fixture.databasePath, migrationOptions());
  try {
    const identityKey = 'b'.repeat(64);
    const insert = db.prepare(`
      INSERT INTO customers (
        id,brand_name,company_name,stage,source,created_by,assigned_to,
        created_at,updated_at,is_public,org_id,team_id,
        normalized_identity_key,duplicate_enforced
      ) VALUES (?,?,?,?, 'v6-test',101,101,'2026-03-01 00:00:00','2026-03-01 00:00:00',0,?,?,?,1)
    `);
    insert.run(1201, 'Unique One', '', 'lead', fixture.defaultOrganizationId, fixture.teamByUser[101], identityKey);
    assert.throws(
      () => insert.run(1202, 'Unique Two', '', 'proposal', fixture.defaultOrganizationId, fixture.teamByUser[101], identityKey),
      /UNIQUE constraint failed: customers\.org_id, customers\.normalized_identity_key/
    );
    assert.deepEqual(db.prepare(`
      SELECT id,duplicate_enforced
      FROM customers
      WHERE normalized_identity_key='52c230ae7e41d3c495a97ade651c3efd17af8be3ee3b6b78de53818f7d218b43'
      ORDER BY id
    `).all(), [
      { id: 1001, duplicate_enforced: 0 },
      { id: 1006, duplicate_enforced: 0 }
    ]);
  } finally {
    db.close();
  }
});

test('CRM contacts tasks and audit tables enforce custody lifecycle and append-only constraints', (t) => {
  const fixture = buildPopulatedVersion5Fixture(t, 'new-table-constraints');
  const db = migrationService.openMigratedDatabase(fixture.databasePath, migrationOptions());
  try {
    const orgId = fixture.defaultOrganizationId;
    const teamId = fixture.teamByUser[101];
    const insertContact = db.prepare(`
      INSERT INTO customer_contacts (
        org_id,customer_id,name,is_preferred,created_by,created_at,updated_at
      ) VALUES (?,?,?,1,?,'2026-03-02 00:00:00','2026-03-02 00:00:00')
    `);
    const firstContactId = insertContact.run(orgId, 1001, 'Primary Contact', 101).lastInsertRowid;
    assert.throws(
      () => insertContact.run(orgId, 1001, 'Second Preferred', 101),
      /UNIQUE constraint failed: customer_contacts\.org_id, customer_contacts\.customer_id/
    );
    db.prepare(`
      UPDATE customer_contacts
      SET is_preferred=0,archived_at='2026-03-03 00:00:00',updated_at='2026-03-03 00:00:00'
      WHERE id=?
    `).run(firstContactId);
    const secondContactId = insertContact.run(orgId, 1001, 'Replacement Preferred', 101).lastInsertRowid;
    assert.ok(Number(secondContactId) > Number(firstContactId));
    assert.throws(
      () => db.prepare('UPDATE customer_contacts SET customer_id=1002 WHERE id=?').run(secondContactId),
      /crm contact identity is immutable/
    );
    assert.throws(
      () => db.prepare('DELETE FROM customer_contacts WHERE id=?').run(firstContactId),
      /crm contacts must be archived/
    );

    db.prepare(`
      INSERT INTO organizations (id,code,name,created_at)
      VALUES (2,'crm-fixture-other','CRM Fixture Other','2026-03-01 00:00:00')
    `).run();
    db.prepare(`
      INSERT INTO organization_memberships (
        org_id,user_id,role_code,status,created_at,revoked_at
      ) VALUES (2,101,'member','active','2026-03-01 00:00:00',NULL)
    `).run();
    assert.throws(
      () => insertContact.run(2, 1001, 'Cross Organization', 101),
      /FOREIGN KEY constraint failed/
    );

    const insertTask = db.prepare(`
      INSERT INTO crm_tasks (
        org_id,team_id,customer_id,opportunity_id,owner_user_id,title,due_at,
        status,source,completed_at,completed_by,created_by,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,'open','manual',NULL,NULL,?,'2026-03-02 00:00:00','2026-03-02 00:00:00')
    `);
    const taskId = insertTask.run(orgId, teamId, 1001, 2001, 101, 'Follow up', '2026-03-10 00:00:00', 101).lastInsertRowid;
    assert.throws(
      () => db.prepare(`
        INSERT INTO crm_tasks (
          org_id,team_id,customer_id,opportunity_id,owner_user_id,title,due_at,
          status,source,created_by,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,'2026-03-10 00:00:00','completed','manual',?,'2026-03-02 00:00:00','2026-03-02 00:00:00')
      `).run(orgId, teamId, 1001, 2001, 101, 'Invalid completion', 101),
      /CHECK constraint failed/
    );
    assert.throws(
      () => insertTask.run(orgId, teamId, 1002, 2001, 101, 'Wrong opportunity customer', '2026-03-10 00:00:00', 101),
      /FOREIGN KEY constraint failed/
    );
    db.prepare(`
      INSERT INTO teams (id,org_id,code,name,created_at)
      VALUES (9001,?,'crm-fixture-unowned','CRM Fixture Unowned','2026-03-01 00:00:00')
    `).run(orgId);
    assert.throws(
      () => insertTask.run(orgId, 9001, 1001, 2001, 101, 'Wrong team membership', '2026-03-10 00:00:00', 101),
      /FOREIGN KEY constraint failed/
    );
    assert.throws(
      () => db.prepare('UPDATE crm_tasks SET opportunity_id=2002 WHERE id=?').run(taskId),
      /crm task identity is immutable/
    );
    assert.throws(
      () => db.prepare('DELETE FROM crm_tasks WHERE id=?').run(taskId),
      /crm tasks must be cancelled/
    );
    db.prepare("UPDATE crm_tasks SET status='cancelled',updated_at='2026-03-03 00:00:00' WHERE id=?").run(taskId);

    const insertAudit = db.prepare(`
      INSERT INTO crm_audit_events (
        org_id,customer_id,actor_user_id,event_type,occurred_at,metadata_json
      ) VALUES (?,?,NULL,?,'2026-03-04 00:00:00',?)
    `);
    const auditId = insertAudit.run(orgId, 1001, 'crm_test_event', JSON.stringify({ reason_code: 'fixture' })).lastInsertRowid;
    assert.throws(
      () => insertAudit.run(orgId, 1001, 'crm_test_event', '[]'),
      /CHECK constraint failed/
    );
    assert.throws(
      () => insertAudit.run(orgId, 1001, 'crm_test_event', JSON.stringify({ value: 'x'.repeat(8200) })),
      /CHECK constraint failed/
    );
    assert.throws(
      () => db.prepare("UPDATE crm_audit_events SET metadata_json='{}' WHERE id=?").run(auditId),
      /crm audit events are append-only/
    );
    assert.throws(
      () => db.prepare('DELETE FROM crm_audit_events WHERE id=?').run(auditId),
      /crm audit events are append-only/
    );

    db.prepare(`
      INSERT INTO customers (
        id,brand_name,company_name,stage,source,created_by,assigned_to,
        created_at,updated_at,is_public,org_id,team_id,duplicate_enforced
      ) VALUES (1300,'Audit Parent','', 'lead','v6-test',101,101,
        '2026-03-01 00:00:00','2026-03-01 00:00:00',0,?,?,0)
    `).run(orgId, teamId);
    insertAudit.run(orgId, 1300, 'crm_test_event', JSON.stringify({ reason_code: 'parent_guard' }));
    assert.throws(
      () => db.prepare('DELETE FROM customers WHERE id=1300').run(),
      /FOREIGN KEY constraint failed/
    );
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db.close();
  }
});

test('direct apply rejects partial and incompatible owned shapes before writes', (t) => {
  const partialFixture = buildPopulatedVersion5Fixture(t, 'partial-shape');
  const partial = new Database(partialFixture.databasePath);
  partial.pragma('foreign_keys = ON');
  partial.exec(`
    ALTER TABLE customers ADD COLUMN
      org_id INTEGER REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT
  `);
  const partialBefore = {
    schema: partial.prepare(`
      SELECT type,name,tbl_name,sql
      FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY CAST(type AS BLOB),CAST(name AS BLOB),CAST(tbl_name AS BLOB)
    `).all(),
    ledger: partial.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),
    customers: partial.prepare('SELECT id,org_id FROM customers ORDER BY id').all()
  };
  const crmMigration = require('../migrations/006_crm_sales_workspace');
  assert.throws(() => crmMigration.apply(partial), /partial or incompatible v6 CRM shape/);
  assert.deepEqual({
    schema: partial.prepare(`
      SELECT type,name,tbl_name,sql
      FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY CAST(type AS BLOB),CAST(name AS BLOB),CAST(tbl_name AS BLOB)
    `).all(),
    ledger: partial.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),
    customers: partial.prepare('SELECT id,org_id FROM customers ORDER BY id').all()
  }, partialBefore);
  partial.close();

  const incompatibleFixture = buildPopulatedVersion5Fixture(t, 'incompatible-shape');
  const migrated = migrationService.openMigratedDatabase(incompatibleFixture.databasePath, migrationOptions());
  migrated.exec(`
    DROP INDEX idx_customers_crm_org_next_action;
    CREATE INDEX idx_customers_crm_org_next_action ON customers(org_id,stalled_at);
  `);
  const incompatibleBefore = captureV6State(migrated);
  assert.throws(() => crmMigration.apply(migrated), /partial or incompatible v6 CRM index SQL/);
  assert.deepEqual(captureV6State(migrated), incompatibleBefore);
  migrated.close();
  assert.throws(
    () => migrationService.openMigratedDatabase(incompatibleFixture.databasePath, migrationOptions()),
    /migration classification failed: partial_or_malformed.*idx_customers_crm_org_next_action/
  );
});

test('malformed legacy identity rolls the migration transaction back to exact managed v5', (t) => {
  const fixture = buildPopulatedVersion5Fixture(t, 'malformed-identity-rollback');
  const version5 = new Database(fixture.databasePath);
  version5.pragma('foreign_keys = ON');
  version5.prepare(`
    INSERT INTO customers (
      id,brand_name,company_name,stage,source,created_by,assigned_to,
      created_at,updated_at,is_public
    ) VALUES (1400,?, '', 'lead','rollback-fixture',101,101,
      '2026-04-01 00:00:00','2026-04-01 00:00:00',0)
  `).run(' \t\r\n\u0000 ');
  const before = captureLegacyProjection(version5);
  version5.close();

  assert.throws(
    () => migrationService.openMigratedDatabase(fixture.databasePath, migrationOptions()),
    /customers\.brand_name normalizes to empty text/
  );
  const restored = new Database(fixture.databasePath, { readonly: true, fileMustExist: true });
  try {
    assert.equal(restored.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 5);
    assert.equal(
      restored.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name='crm_audit_events'").get().count,
      0
    );
    assert.equal(
      restored.pragma('table_info("customers")').some((column) => column.name === 'org_id'),
      false
    );
    assert.deepEqual(captureLegacyProjection(restored).rows, before.rows);
  } finally {
    restored.close();
  }
});

test('verified v5 backup restores to a disposable copy and migrates to the same v6 state on rerun', async (t) => {
  const fixture = buildPopulatedVersion5Fixture(t, 'backup-restore-rehearsal');
  const backupPath = path.join(path.dirname(fixture.databasePath), 'immutable-v5-backup.db');
  const restorePath = path.join(path.dirname(fixture.databasePath), 'disposable-v6-restore.db');
  const source = new Database(fixture.databasePath, { fileMustExist: true });
  try {
    await source.backup(backupPath);
  } finally {
    source.close();
  }

  const backupBytes = fs.readFileSync(backupPath);
  const backupDigest = crypto.createHash('sha256').update(backupBytes).digest('hex');
  assert.ok(backupBytes.length > 0, 'verified backup must not be empty');
  fs.copyFileSync(backupPath, restorePath);

  const first = migrationService.openMigratedDatabase(restorePath, migrationOptions());
  let expectedV6State;
  try {
    assert.deepEqual(
      captureLegacyProjection(first, fixture.before.columns).rows,
      fixture.before.rows,
      'restored migration must preserve every pre-v6 business value and ID'
    );
    expectedV6State = captureV6State(first);
  } finally {
    first.close();
  }

  const second = migrationService.openMigratedDatabase(restorePath, migrationOptions());
  try {
    assert.deepEqual(captureV6State(second), expectedV6State);
    require('../migrations/006_crm_sales_workspace').apply(second);
    assert.deepEqual(captureV6State(second), expectedV6State);
    assert.deepEqual(second.pragma('foreign_key_check'), []);
  } finally {
    second.close();
  }

  assert.equal(
    crypto.createHash('sha256').update(fs.readFileSync(backupPath)).digest('hex'),
    backupDigest,
    'the immutable v5 backup must not be changed by restore or migration rehearsal'
  );
  const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
  try {
    assert.equal(backup.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 5);
    assert.deepEqual(captureLegacyProjection(backup).rows, fixture.before.rows);
    assert.deepEqual(backup.pragma('foreign_key_check'), []);
  } finally {
    backup.close();
  }
});

test('managed reopen rejects a tampered v6 ledger checksum before mutation', (t) => {
  const fixture = buildPopulatedVersion5Fixture(t, 'ledger-tamper');
  const migrated = migrationService.openMigratedDatabase(fixture.databasePath, migrationOptions());
  migrated.prepare('UPDATE schema_migrations SET checksum=? WHERE version=6').run('0'.repeat(64));
  const before = captureV6State(migrated);
  migrated.close();
  assert.throws(
    () => migrationService.openMigratedDatabase(fixture.databasePath, migrationOptions()),
    /migration classification failed: partial_or_malformed checksum\/schema mismatch for 006_crm_sales_workspace/
  );
  const after = new Database(fixture.databasePath, { readonly: true, fileMustExist: true });
  try {
    assert.deepEqual(captureV6State(after), before);
  } finally {
    after.close();
  }
});

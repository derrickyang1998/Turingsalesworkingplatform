'use strict';

const { createHash } = require('node:crypto');

const LEGACY_TOKEN_COLUMNS = Object.freeze([
  'id',
  'user_id',
  'model',
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
  'endpoint',
  'created_at'
]);

const INDEX_SQL = Object.freeze({
  ux_token_usage_org_id: `CREATE UNIQUE INDEX ux_token_usage_org_id
    ON token_usage(org_id,id)`,
  idx_token_usage_org_user_created: `CREATE INDEX idx_token_usage_org_user_created
    ON token_usage(org_id,user_id,created_at DESC,id DESC)`
});

const TRIGGER_SQL = Object.freeze({
  token_usage_scope_insert: `CREATE TRIGGER token_usage_scope_insert
BEFORE INSERT ON token_usage
WHEN NEW.org_id IS NULL
  OR typeof(NEW.org_id)<>'integer'
  OR NEW.org_id<1
  OR NEW.org_id>9007199254740991
  OR typeof(NEW.user_id)<>'integer'
  OR NEW.user_id<1
  OR NEW.user_id>9007199254740991
  OR typeof(NEW.model)<>'text'
  OR length(trim(NEW.model))<1
  OR length(NEW.model)>120
  OR typeof(NEW.prompt_tokens)<>'integer'
  OR NEW.prompt_tokens<0
  OR NEW.prompt_tokens>9007199254740991
  OR typeof(NEW.completion_tokens)<>'integer'
  OR NEW.completion_tokens<0
  OR NEW.completion_tokens>9007199254740991
  OR typeof(NEW.total_tokens)<>'integer'
  OR NEW.total_tokens<0
  OR NEW.total_tokens>9007199254740991
  OR (
    NEW.endpoint IS NOT NULL
    AND (
      typeof(NEW.endpoint)<>'text'
      OR length(NEW.endpoint)>120
    )
  )
  OR NOT EXISTS (SELECT 1 FROM organizations WHERE id=NEW.org_id)
  OR NOT EXISTS (
    SELECT 1 FROM organization_memberships
    WHERE org_id=NEW.org_id AND user_id=NEW.user_id AND status='active'
  )
BEGIN SELECT RAISE(ABORT,'token usage organization ownership is invalid'); END`,
  token_usage_no_update: `CREATE TRIGGER token_usage_no_update
BEFORE UPDATE ON token_usage
BEGIN SELECT RAISE(ABORT,'token usage ledger is append-only'); END`,
  token_usage_no_delete: `CREATE TRIGGER token_usage_no_delete
BEFORE DELETE ON token_usage
BEGIN SELECT RAISE(ABORT,'token usage ledger is append-only'); END`,
  performance_ai_review_audits_request_fingerprint_insert: `CREATE TRIGGER performance_ai_review_audits_request_fingerprint_insert
BEFORE INSERT ON performance_ai_review_audits
WHEN NOT EXISTS (
  SELECT 1
  FROM request_idempotency request
  JOIN token_usage usage ON usage.id=NEW.token_usage_id
  WHERE request.id=NEW.request_idempotency_id
    AND request.org_id=NEW.org_id
    AND request.user_id=NEW.actor_user_id
    AND request.campaign_id=NEW.campaign_id
    AND request.scope='ai.conversation.create.linked'
    AND request.expected_event_count=1
    AND request.audit_fingerprint=NEW.audit_fingerprint
    AND request.state='processing'
    AND request.lease_token IS NOT NULL
    AND datetime(request.lease_until)>CURRENT_TIMESTAMP
    AND datetime(request.operation_deadline)>CURRENT_TIMESTAMP
    AND usage.org_id=NEW.org_id
    AND usage.user_id=NEW.actor_user_id
    AND usage.endpoint='ai_chat_linked_rejected'
)
BEGIN SELECT RAISE(ABORT,'performance AI review audit is not reserved for token usage organization'); END`
});

function projectionDigest(db, domain, columns, query) {
  const rows = db.prepare(query).all();
  const hash = createHash('sha256');
  hash.update(`tm-token-usage-v26-${domain}-projection-v1\n`);
  for (const row of rows) {
    hash.update(JSON.stringify(columns.map((column) => {
      const value = row[column];
      if (value === null) return ['null', ''];
      if (typeof value === 'object') return ['blob', value.toString('base64')];
      if (typeof value === 'number') return [Number.isInteger(value) ? 'integer' : 'real', String(value)];
      return ['text', String(value)];
    })));
    hash.update('\n');
  }
  return { count: rows.length, sha256: hash.digest('hex') };
}

function legacyProjection(db) {
  return {
    tokenUsage: projectionDigest(
      db,
      'token-usage',
      LEGACY_TOKEN_COLUMNS,
      `SELECT ${LEGACY_TOKEN_COLUMNS.join(',')} FROM token_usage ORDER BY id`
    ),
    audits: projectionDigest(
      db,
      'performance-review-audits',
      ['id', 'request_idempotency_id', 'token_usage_id', 'org_id', 'campaign_id', 'actor_user_id',
        'audit_fingerprint', 'outcome', 'reason_code', 'stage', 'created_at'],
      `SELECT id,request_idempotency_id,token_usage_id,org_id,campaign_id,actor_user_id,
        audit_fingerprint,outcome,reason_code,stage,created_at
       FROM performance_ai_review_audits ORDER BY id`
    ),
    sequences: projectionDigest(
      db,
      'sqlite-sequence',
      ['name', 'seq'],
      `SELECT name,seq FROM sqlite_sequence
       WHERE name IN ('token_usage','performance_ai_review_audits') ORDER BY name`
    )
  };
}

function resolveDefaultOrganization(db) {
  const organizations = db.prepare(`
    SELECT id,code,name,created_at FROM organizations ORDER BY id
  `).all();
  if (organizations.length === 0) throw new Error('026 requires at least one organization');
  if (organizations.length === 1) return { id: organizations[0].id, onlyOrganization: true };
  return { id: null, onlyOrganization: false };
}

function authorityClaimsSql() {
  return `
    SELECT usage.id AS token_usage_id,audit.org_id
    FROM token_usage usage
    JOIN performance_ai_review_audits audit ON audit.token_usage_id=usage.id
  `;
}

function assertAuthorityIntegrity(db) {
  const invalid = db.prepare(`
    SELECT audit.id
    FROM performance_ai_review_audits audit
    LEFT JOIN token_usage usage ON usage.id=audit.token_usage_id
    LEFT JOIN organizations organization ON organization.id=audit.org_id
    WHERE usage.id IS NULL
      OR organization.id IS NULL
      OR usage.user_id<>audit.actor_user_id
    ORDER BY audit.id LIMIT 1
  `).get();
  if (invalid) throw new Error('026 token usage audit authority is invalid');

  const conflict = db.prepare(`
    WITH authority_claims(token_usage_id,org_id) AS (${authorityClaimsSql()})
    SELECT token_usage_id FROM authority_claims
    GROUP BY token_usage_id
    HAVING COUNT(DISTINCT org_id)>1
    ORDER BY token_usage_id LIMIT 1
  `).get();
  if (conflict) throw new Error('conflicting authoritative token usage organization ownership');
}

function assertNoUnresolvedOwnership(db, allowDefaultFallback) {
  if (allowDefaultFallback) return;
  const unresolved = db.prepare(`
    WITH authority_claims(token_usage_id,org_id) AS (${authorityClaimsSql()})
    SELECT usage.id
    FROM token_usage usage
    LEFT JOIN authority_claims authority ON authority.token_usage_id=usage.id
    GROUP BY usage.id
    HAVING COUNT(DISTINCT authority.org_id)=0
    ORDER BY usage.id LIMIT 1
  `).get();
  if (unresolved) throw new Error('unresolved token usage organization ownership');
}

function backfillOwnership(db, defaultOrganizationId) {
  db.prepare(`
    WITH authority_claims(token_usage_id,org_id) AS (${authorityClaimsSql()}),
    resolved AS MATERIALIZED (
      SELECT usage.id AS token_usage_id,
        COALESCE(MIN(authority.org_id),@defaultOrganizationId) AS org_id
      FROM token_usage usage
      LEFT JOIN authority_claims authority ON authority.token_usage_id=usage.id
      GROUP BY usage.id
    )
    UPDATE token_usage AS usage
    SET org_id=(SELECT resolved.org_id FROM resolved WHERE resolved.token_usage_id=usage.id)
    WHERE org_id IS NULL
  `).run({ defaultOrganizationId });
}

const migration = {
  version: 26,
  name: '026_token_usage_tenant_ownership',
  sourcePath: 'migrations/026_token_usage_tenant_ownership.js',
  engineVersion: 1,
  dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js'],
  schemaManifest: {
    columns: {
      token_usage: {
        org_id: { type: 'INTEGER', notnull: 0, defaultValue: null }
      }
    },
    indexes: INDEX_SQL,
    triggers: TRIGGER_SQL,
    tableChecks: {}
  },
  apply(db) {
    for (const name of [
      'organizations',
      'organization_memberships',
      'token_usage',
      'performance_ai_review_audits',
      'request_idempotency'
    ]) {
      if (!db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name=?").get(name)) {
        throw new Error(`026 requires ${name}`);
      }
    }
    if (!db.prepare(`
      SELECT 1 AS present FROM sqlite_schema
      WHERE type='trigger' AND name='performance_ai_review_audits_request_fingerprint_insert'
    `).get()) {
      throw new Error('026 requires performance AI review audit trigger');
    }

    const newObjectNames = [
      ...Object.keys(INDEX_SQL),
      'token_usage_scope_insert',
      'token_usage_no_update',
      'token_usage_no_delete'
    ];
    const placeholders = newObjectNames.map(() => '?').join(',');
    const existingObject = db.prepare(`
      SELECT name FROM sqlite_schema WHERE name IN (${placeholders}) ORDER BY name LIMIT 1
    `).get(...newObjectNames);
    const existingColumn = db.prepare(`
      SELECT 1 AS present FROM pragma_table_info('token_usage') WHERE name='org_id'
    `).get();
    if (existingColumn || existingObject) {
      throw new Error('partial 026 token usage ownership object exists');
    }

    const defaultOrganization = resolveDefaultOrganization(db);
    assertAuthorityIntegrity(db);
    assertNoUnresolvedOwnership(db, defaultOrganization.onlyOrganization);
    const before = legacyProjection(db);

    db.exec(`
      ALTER TABLE token_usage
      ADD COLUMN org_id INTEGER
        REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT;
    `);
    backfillOwnership(db, defaultOrganization.id);

    const invalidOwnership = db.prepare(`
      SELECT COUNT(*) AS count
      FROM token_usage usage
      LEFT JOIN organizations organization ON organization.id=usage.org_id
      WHERE usage.org_id IS NULL
        OR typeof(usage.org_id)<>'integer'
        OR usage.org_id<1
        OR usage.org_id>9007199254740991
        OR organization.id IS NULL
    `).get().count;
    if (invalidOwnership !== 0) {
      throw new Error('026 token usage organization ownership backfill is incomplete');
    }

    db.exec('DROP TRIGGER performance_ai_review_audits_request_fingerprint_insert;');
    db.exec([
      ...Object.values(INDEX_SQL),
      ...Object.values(TRIGGER_SQL)
    ].join(';\n') + ';');

    const after = legacyProjection(db);
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      throw new Error('026 changed the legacy token usage projection');
    }
  }
};

module.exports = migration;

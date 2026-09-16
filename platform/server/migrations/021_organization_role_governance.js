'use strict';

const TABLE_SQL = Object.freeze({
  organization_member_policy: `CREATE TABLE organization_member_policy (
  org_id INTEGER NOT NULL CHECK(org_id BETWEEN 1 AND 9007199254740991),
  user_id INTEGER NOT NULL CHECK(user_id BETWEEN 1 AND 9007199254740991),
  access_mode TEXT NOT NULL DEFAULT 'read_write' CHECK(access_mode IN ('read_write','read_only')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK(
    strftime('%Y-%m-%d %H:%M:%S',created_at) IS NOT NULL
    AND strftime('%Y-%m-%d %H:%M:%S',created_at)=created_at
  ),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK(
    strftime('%Y-%m-%d %H:%M:%S',updated_at) IS NOT NULL
    AND strftime('%Y-%m-%d %H:%M:%S',updated_at)=updated_at
  ),
  PRIMARY KEY(org_id,user_id),
  FOREIGN KEY(org_id,user_id) REFERENCES organization_memberships(org_id,user_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID`,
  organization_authority: `CREATE TABLE organization_authority (
  org_id INTEGER PRIMARY KEY CHECK(org_id BETWEEN 1 AND 9007199254740991),
  owner_user_id INTEGER NOT NULL CHECK(owner_user_id BETWEEN 1 AND 9007199254740991),
  created_by INTEGER NOT NULL CHECK(created_by BETWEEN 1 AND 9007199254740991),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK(
    strftime('%Y-%m-%d %H:%M:%S',created_at) IS NOT NULL
    AND strftime('%Y-%m-%d %H:%M:%S',created_at)=created_at
  ),
  FOREIGN KEY(org_id) REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(org_id,owner_user_id) REFERENCES organization_memberships(org_id,user_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(created_by) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID`
});

const INDEX_SQL = Object.freeze({
  idx_organization_member_policy_access: `CREATE INDEX idx_organization_member_policy_access
    ON organization_member_policy(org_id,access_mode,user_id)`,
  idx_organization_authority_owner: `CREATE INDEX idx_organization_authority_owner
    ON organization_authority(owner_user_id,org_id)`
});

const TRIGGER_SQL = Object.freeze({
  organization_membership_policy_insert: `CREATE TRIGGER organization_membership_policy_insert
AFTER INSERT ON organization_memberships
BEGIN
  INSERT INTO organization_member_policy (org_id,user_id,access_mode)
  VALUES (NEW.org_id,NEW.user_id,'read_write');
END`,
  organization_member_policy_owner_read_only_guard: `CREATE TRIGGER organization_member_policy_owner_read_only_guard
BEFORE UPDATE OF access_mode ON organization_member_policy
WHEN NEW.access_mode='read_only' AND EXISTS (
  SELECT 1 FROM organization_authority authority
  WHERE authority.org_id=NEW.org_id AND authority.owner_user_id=NEW.user_id
)
BEGIN SELECT RAISE(ABORT,'company owner cannot be read-only'); END`,
  organization_member_policy_owner_delete_guard: `CREATE TRIGGER organization_member_policy_owner_delete_guard
BEFORE DELETE ON organization_member_policy
WHEN EXISTS (
  SELECT 1 FROM organization_authority authority
  WHERE authority.org_id=OLD.org_id AND authority.owner_user_id=OLD.user_id
)
BEGIN SELECT RAISE(ABORT,'company owner policy is required'); END`,
  organization_member_policy_delete_guard: `CREATE TRIGGER organization_member_policy_delete_guard
BEFORE DELETE ON organization_member_policy
WHEN NOT EXISTS (
  SELECT 1 FROM organization_authority authority
  WHERE authority.org_id=OLD.org_id AND authority.owner_user_id=OLD.user_id
)
BEGIN SELECT RAISE(ABORT,'organization member policy is required'); END`,
  organization_authority_scope_insert: `CREATE TRIGGER organization_authority_scope_insert
BEFORE INSERT ON organization_authority
WHEN NOT EXISTS (
  SELECT 1
  FROM organization_memberships membership
  JOIN organization_member_policy policy
    ON policy.org_id=membership.org_id AND policy.user_id=membership.user_id
  JOIN users owner ON owner.id=membership.user_id
  JOIN users creator ON creator.id=NEW.created_by
  WHERE membership.org_id=NEW.org_id
    AND membership.user_id=NEW.owner_user_id
    AND membership.status='active'
    AND policy.access_mode='read_write'
    AND owner.is_active=1
    AND creator.is_active=1
    AND creator.role='admin'
)
BEGIN SELECT RAISE(ABORT,'company owner must be an active read-write organization member'); END`,
  organization_authority_no_replace_insert: `CREATE TRIGGER organization_authority_no_replace_insert
BEFORE INSERT ON organization_authority
WHEN EXISTS (
  SELECT 1 FROM organization_authority authority WHERE authority.org_id=NEW.org_id
)
BEGIN SELECT RAISE(ABORT,'company owner already initialized'); END`,
  organization_authority_no_update: `CREATE TRIGGER organization_authority_no_update
BEFORE UPDATE ON organization_authority
BEGIN SELECT RAISE(ABORT,'company owner is immutable'); END`,
  organization_authority_no_delete: `CREATE TRIGGER organization_authority_no_delete
BEFORE DELETE ON organization_authority
BEGIN SELECT RAISE(ABORT,'company owner is immutable'); END`,
  organization_membership_owner_status_guard: `CREATE TRIGGER organization_membership_owner_status_guard
BEFORE UPDATE OF status ON organization_memberships
WHEN NEW.status<>'active' AND EXISTS (
  SELECT 1 FROM organization_authority authority
  WHERE authority.org_id=OLD.org_id AND authority.owner_user_id=OLD.user_id
)
BEGIN SELECT RAISE(ABORT,'company owner membership must remain active'); END`,
  organization_membership_owner_delete_guard: `CREATE TRIGGER organization_membership_owner_delete_guard
BEFORE DELETE ON organization_memberships
WHEN EXISTS (
  SELECT 1 FROM organization_authority authority
  WHERE authority.org_id=OLD.org_id AND authority.owner_user_id=OLD.user_id
)
BEGIN SELECT RAISE(ABORT,'company owner membership must remain active'); END`,
  organization_owner_user_active_guard: `CREATE TRIGGER organization_owner_user_active_guard
BEFORE UPDATE OF is_active ON users
WHEN NEW.is_active<>1 AND EXISTS (
  SELECT 1 FROM organization_authority authority WHERE authority.owner_user_id=OLD.id
)
BEGIN SELECT RAISE(ABORT,'company owner user must remain active'); END`
});

const migration = {
  version: 21,
  name: '021_organization_role_governance',
  sourcePath: 'migrations/021_organization_role_governance.js',
  engineVersion: 1,
  dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js'],
  schemaManifest: {
    columns: {
      organization_member_policy: {
        org_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        user_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        access_mode: { type: 'TEXT', notnull: 1, defaultValue: "'read_write'" },
        created_at: { type: 'TEXT', notnull: 1, defaultValue: 'CURRENT_TIMESTAMP' },
        updated_at: { type: 'TEXT', notnull: 1, defaultValue: 'CURRENT_TIMESTAMP' }
      },
      organization_authority: {
        org_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        owner_user_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        created_by: { type: 'INTEGER', notnull: 1, defaultValue: null },
        created_at: { type: 'TEXT', notnull: 1, defaultValue: 'CURRENT_TIMESTAMP' }
      }
    },
    indexes: INDEX_SQL,
    triggers: TRIGGER_SQL,
    tableChecks: {
      organization_member_policy: [
        "CHECK(access_mode IN ('read_write','read_only'))"
      ],
      organization_authority: [
        'owner_user_id BETWEEN 1 AND 9007199254740991'
      ]
    }
  },
  apply(db) {
    for (const name of [
      'users',
      'organizations',
      'organization_memberships',
      'team_memberships',
      'sessions',
      'activity_log'
    ]) {
      if (!db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name=?").get(name)) {
        throw new Error(`021 requires ${name}`);
      }
    }
    const objectNames = [
      ...Object.keys(TABLE_SQL),
      ...Object.keys(INDEX_SQL),
      ...Object.keys(TRIGGER_SQL)
    ];
    const placeholders = objectNames.map(() => '?').join(',');
    const existing = db.prepare(`SELECT name FROM sqlite_schema WHERE name IN (${placeholders}) ORDER BY name`)
      .all(...objectNames);
    if (existing.length > 0) throw new Error(`partial 021 object exists: ${existing[0].name}`);

    db.exec([
      ...Object.values(TABLE_SQL),
      ...Object.values(INDEX_SQL),
      ...Object.values(TRIGGER_SQL)
    ].join(';\n') + ';');
    db.exec(`
      INSERT INTO organization_member_policy (org_id,user_id,access_mode)
      SELECT org_id,user_id,'read_write'
      FROM organization_memberships
      ORDER BY org_id,user_id;

      INSERT INTO organization_authority (org_id,owner_user_id,created_by)
      SELECT
        organization.id,
        MIN(membership.user_id),
        MIN(membership.user_id)
      FROM organizations organization
      JOIN organization_memberships membership
        ON membership.org_id=organization.id
       AND membership.status='active'
      JOIN users candidate
        ON candidate.id=membership.user_id
       AND candidate.role='admin'
       AND candidate.is_active=1
      GROUP BY organization.id
      HAVING COUNT(*)=1
      ORDER BY organization.id;

      INSERT INTO activity_log (user_id,action,module,details,ip_address)
      SELECT
        authority.created_by,
        'organization_owner_migration_initialized',
        'organization_governance',
        json_object(
          'schema_version',1,
          'organization_id',authority.org_id,
          'owner_user_id',authority.owner_user_id,
          'reason','unique_active_platform_admin_member'
        ),
        NULL
      FROM organization_authority authority
      ORDER BY authority.org_id;
    `);
  }
};

module.exports = migration;

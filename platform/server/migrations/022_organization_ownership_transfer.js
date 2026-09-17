'use strict';

const TABLE_SQL = `CREATE TABLE organization_authority_v22 (
  org_id INTEGER PRIMARY KEY CHECK(org_id BETWEEN 1 AND 9007199254740991),
  owner_user_id INTEGER NOT NULL CHECK(owner_user_id BETWEEN 1 AND 9007199254740991),
  created_by INTEGER NOT NULL CHECK(created_by BETWEEN 1 AND 9007199254740991),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK(
    strftime('%Y-%m-%d %H:%M:%S',created_at) IS NOT NULL
    AND strftime('%Y-%m-%d %H:%M:%S',created_at)=created_at
  ),
  updated_by INTEGER NOT NULL CHECK(updated_by BETWEEN 1 AND 9007199254740991),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK(
    strftime('%Y-%m-%d %H:%M:%S',updated_at) IS NOT NULL
    AND strftime('%Y-%m-%d %H:%M:%S',updated_at)=updated_at
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 9007199254740991),
  FOREIGN KEY(org_id) REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(org_id,owner_user_id) REFERENCES organization_memberships(org_id,user_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(created_by) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(updated_by) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID`;

const INDEX_SQL = Object.freeze({
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
WHEN NEW.version<>1
  OR NEW.updated_by<>NEW.created_by
  OR NEW.updated_at<>NEW.created_at
  OR NOT EXISTS (
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
  organization_authority_creation_immutable: `CREATE TRIGGER organization_authority_creation_immutable
BEFORE UPDATE ON organization_authority
WHEN NEW.org_id<>OLD.org_id
  OR NEW.created_by<>OLD.created_by
  OR NEW.created_at<>OLD.created_at
BEGIN SELECT RAISE(ABORT,'company owner creation lineage is immutable'); END`,
  organization_authority_no_update: `CREATE TRIGGER organization_authority_no_update
BEFORE UPDATE ON organization_authority
WHEN NEW.owner_user_id=OLD.owner_user_id
BEGIN SELECT RAISE(ABORT,'company owner must change'); END`,
  organization_authority_version_guard: `CREATE TRIGGER organization_authority_version_guard
BEFORE UPDATE ON organization_authority
WHEN NEW.version<>OLD.version+1
BEGIN SELECT RAISE(ABORT,'company owner version must increment exactly once'); END`,
  organization_authority_target_guard: `CREATE TRIGGER organization_authority_target_guard
BEFORE UPDATE ON organization_authority
WHEN NOT EXISTS (
  SELECT 1
  FROM organization_memberships membership
  JOIN organization_member_policy policy
    ON policy.org_id=membership.org_id AND policy.user_id=membership.user_id
  JOIN users owner ON owner.id=membership.user_id
  WHERE membership.org_id=NEW.org_id
    AND membership.user_id=NEW.owner_user_id
    AND membership.status='active'
    AND policy.access_mode='read_write'
    AND owner.is_active=1
)
BEGIN SELECT RAISE(ABORT,'company owner must be an active read-write organization member'); END`,
  organization_authority_actor_guard: `CREATE TRIGGER organization_authority_actor_guard
BEFORE UPDATE ON organization_authority
WHEN NOT EXISTS (
  SELECT 1
  FROM users actor
  WHERE actor.id=NEW.updated_by
    AND actor.is_active=1
    AND (actor.role='admin' OR actor.id=OLD.owner_user_id)
)
BEGIN SELECT RAISE(ABORT,'ownership transfer actor must be current owner or active platform administrator'); END`,
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

const REPLACED_OBJECTS = Object.freeze([
  'idx_organization_authority_owner',
  'organization_membership_policy_insert',
  'organization_member_policy_owner_read_only_guard',
  'organization_member_policy_owner_delete_guard',
  'organization_member_policy_delete_guard',
  'organization_authority_scope_insert',
  'organization_authority_no_replace_insert',
  'organization_authority_no_update',
  'organization_authority_no_delete',
  'organization_membership_owner_status_guard',
  'organization_membership_owner_delete_guard',
  'organization_owner_user_active_guard'
]);

const migration = {
  version: 22,
  name: '022_organization_ownership_transfer',
  sourcePath: 'migrations/022_organization_ownership_transfer.js',
  engineVersion: 1,
  dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js'],
  schemaManifest: {
    columns: {
      organization_authority: {
        org_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        owner_user_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        created_by: { type: 'INTEGER', notnull: 1, defaultValue: null },
        created_at: { type: 'TEXT', notnull: 1, defaultValue: 'CURRENT_TIMESTAMP' },
        updated_by: { type: 'INTEGER', notnull: 1, defaultValue: null },
        updated_at: { type: 'TEXT', notnull: 1, defaultValue: 'CURRENT_TIMESTAMP' },
        version: { type: 'INTEGER', notnull: 1, defaultValue: '1' }
      }
    },
    indexes: INDEX_SQL,
    triggers: TRIGGER_SQL,
    tableChecks: {
      organization_authority: [
        'owner_user_id BETWEEN 1 AND 9007199254740991',
        'updated_by BETWEEN 1 AND 9007199254740991',
        'version BETWEEN 1 AND 9007199254740991'
      ]
    }
  },
  apply(db) {
    for (const name of [
      'users',
      'organizations',
      'organization_memberships',
      'organization_member_policy',
      'organization_authority',
      'sessions',
      'activity_log'
    ]) {
      if (!db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name=?").get(name)) {
        throw new Error(`022 requires ${name}`);
      }
    }
    if (db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE name='organization_authority_v22'").get()) {
      throw new Error('partial 022 object exists: organization_authority_v22');
    }
    const columns = db.prepare('PRAGMA table_info(organization_authority)').all().map((column) => column.name);
    if (JSON.stringify(columns) !== JSON.stringify(['org_id', 'owner_user_id', 'created_by', 'created_at'])) {
      throw new Error('022 requires exact v21 organization_authority');
    }
    const placeholders = REPLACED_OBJECTS.map(() => '?').join(',');
    const existing = new Set(db.prepare(`
      SELECT name FROM sqlite_schema WHERE name IN (${placeholders})
    `).all(...REPLACED_OBJECTS).map((row) => row.name));
    for (const name of REPLACED_OBJECTS) {
      if (!existing.has(name)) throw new Error(`022 requires v21 object: ${name}`);
    }

    db.exec(REPLACED_OBJECTS.map((name) => (
      name.startsWith('idx_') ? `DROP INDEX ${name}` : `DROP TRIGGER ${name}`
    )).join(';\n') + ';');
    db.exec(`${TABLE_SQL};
      INSERT INTO organization_authority_v22 (
        org_id,owner_user_id,created_by,created_at,updated_by,updated_at,version
      )
      SELECT org_id,owner_user_id,created_by,created_at,created_by,created_at,1
      FROM organization_authority
      ORDER BY org_id;
      DROP TABLE organization_authority;
      ALTER TABLE organization_authority_v22 RENAME TO organization_authority;
    `);
    db.exec([
      ...Object.values(INDEX_SQL),
      ...Object.values(TRIGGER_SQL)
    ].join(';\n') + ';');
  }
};

module.exports = migration;

'use strict';

const TABLE_SQL = Object.freeze({
  organization_knowledge_custody: `CREATE TABLE organization_knowledge_custody (
  knowledge_entry_id INTEGER PRIMARY KEY
    CHECK(knowledge_entry_id BETWEEN 1 AND 9007199254740991),
  org_id INTEGER NOT NULL CHECK(org_id BETWEEN 1 AND 9007199254740991),
  custody_type TEXT NOT NULL CHECK(custody_type='methodology'),
  created_by INTEGER NOT NULL CHECK(created_by BETWEEN 1 AND 9007199254740991),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK(
    strftime('%Y-%m-%d %H:%M:%S',created_at) IS NOT NULL
    AND strftime('%Y-%m-%d %H:%M:%S',created_at)=created_at
  ),
  FOREIGN KEY(knowledge_entry_id) REFERENCES knowledge_entries(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(org_id) REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(org_id,created_by) REFERENCES organization_memberships(org_id,user_id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID`,
  organization_methodology_promotion_requests: `CREATE TABLE organization_methodology_promotion_requests (
  id INTEGER PRIMARY KEY CHECK(id BETWEEN 1 AND 9007199254740991),
  org_id INTEGER NOT NULL CHECK(org_id BETWEEN 1 AND 9007199254740991),
  source_campaign_id INTEGER NOT NULL CHECK(source_campaign_id BETWEEN 1 AND 9007199254740991),
  source_knowledge_entry_id INTEGER NOT NULL CHECK(source_knowledge_entry_id BETWEEN 1 AND 9007199254740991),
  requested_by INTEGER NOT NULL CHECK(requested_by BETWEEN 1 AND 9007199254740991),
  first_approved_by INTEGER NOT NULL CHECK(first_approved_by BETWEEN 1 AND 9007199254740991),
  expected_governance_version INTEGER NOT NULL CHECK(expected_governance_version BETWEEN 1 AND 9007199254740991),
  dedupe_sha256 TEXT NOT NULL CHECK(
    length(dedupe_sha256)=64 AND dedupe_sha256=lower(dedupe_sha256)
    AND dedupe_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  dimensions_json TEXT NOT NULL CHECK(
    json_valid(dimensions_json) AND json_type(dimensions_json)='object'
    AND length(CAST(dimensions_json AS BLOB)) BETWEEN 2 AND 8192
  ),
  supersedes_knowledge_entry_id INTEGER CHECK(
    supersedes_knowledge_entry_id IS NULL
    OR supersedes_knowledge_entry_id BETWEEN 1 AND 9007199254740991
  ),
  request_reason TEXT NOT NULL CHECK(length(trim(request_reason)) BETWEEN 1 AND 500),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK(
    strftime('%Y-%m-%d %H:%M:%S',created_at) IS NOT NULL
    AND strftime('%Y-%m-%d %H:%M:%S',created_at)=created_at
  ),
  CHECK(source_knowledge_entry_id<>COALESCE(supersedes_knowledge_entry_id,0)),
  FOREIGN KEY(org_id,source_campaign_id) REFERENCES campaigns(org_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(org_id,requested_by) REFERENCES organization_memberships(org_id,user_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(first_approved_by) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(source_knowledge_entry_id) REFERENCES knowledge_entries(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(supersedes_knowledge_entry_id) REFERENCES knowledge_entries(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT`,
  organization_methodology_promotion_decisions: `CREATE TABLE organization_methodology_promotion_decisions (
  id INTEGER PRIMARY KEY CHECK(id BETWEEN 1 AND 9007199254740991),
  request_id INTEGER NOT NULL CHECK(request_id BETWEEN 1 AND 9007199254740991),
  org_id INTEGER NOT NULL CHECK(org_id BETWEEN 1 AND 9007199254740991),
  decision TEXT NOT NULL CHECK(decision IN ('approved','rejected')),
  decided_by INTEGER NOT NULL CHECK(decided_by BETWEEN 1 AND 9007199254740991),
  decision_reason TEXT NOT NULL CHECK(length(trim(decision_reason)) BETWEEN 1 AND 500),
  target_knowledge_entry_id INTEGER CHECK(
    target_knowledge_entry_id IS NULL
    OR target_knowledge_entry_id BETWEEN 1 AND 9007199254740991
  ),
  supersedes_knowledge_entry_id INTEGER CHECK(
    supersedes_knowledge_entry_id IS NULL
    OR supersedes_knowledge_entry_id BETWEEN 1 AND 9007199254740991
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK(
    strftime('%Y-%m-%d %H:%M:%S',created_at) IS NOT NULL
    AND strftime('%Y-%m-%d %H:%M:%S',created_at)=created_at
  ),
  CHECK(
    (decision='approved' AND target_knowledge_entry_id IS NOT NULL)
    OR (decision='rejected' AND target_knowledge_entry_id IS NULL AND supersedes_knowledge_entry_id IS NULL)
  ),
  CHECK(target_knowledge_entry_id IS NULL OR target_knowledge_entry_id<>COALESCE(supersedes_knowledge_entry_id,0)),
  FOREIGN KEY(request_id) REFERENCES organization_methodology_promotion_requests(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(org_id) REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(org_id,decided_by) REFERENCES organization_memberships(org_id,user_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(target_knowledge_entry_id) REFERENCES knowledge_entries(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(supersedes_knowledge_entry_id) REFERENCES knowledge_entries(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT`
});

const INDEX_SQL = Object.freeze({
  idx_organization_knowledge_custody_org: `CREATE INDEX idx_organization_knowledge_custody_org
    ON organization_knowledge_custody(org_id,knowledge_entry_id)`,
  ux_organization_methodology_request_source: `CREATE UNIQUE INDEX ux_organization_methodology_request_source
    ON organization_methodology_promotion_requests(org_id,source_knowledge_entry_id)`,
  idx_organization_methodology_request_org: `CREATE INDEX idx_organization_methodology_request_org
    ON organization_methodology_promotion_requests(org_id,created_at DESC,id DESC)`,
  ux_organization_methodology_decision_request: `CREATE UNIQUE INDEX ux_organization_methodology_decision_request
    ON organization_methodology_promotion_decisions(request_id)`,
  idx_organization_methodology_decision_target: `CREATE INDEX idx_organization_methodology_decision_target
    ON organization_methodology_promotion_decisions(org_id,target_knowledge_entry_id,created_at DESC,id DESC)`
});

function capacityDelta(sign) {
  const prefix = sign < 0 ? '-' : '';
  return `CASE metric
    WHEN 'entries' THEN ${prefix}1
    WHEN 'chunks' THEN ${prefix}(SELECT chunk_count FROM knowledge_entry_footprints WHERE knowledge_entry_id=NEW.knowledge_entry_id)
    WHEN 'payload_bytes' THEN ${prefix}(
      SELECT entry_payload_bytes + chunk_payload_bytes
      FROM knowledge_entry_footprints
      WHERE knowledge_entry_id=NEW.knowledge_entry_id
    )
    ELSE 0
  END`;
}

function gaugeThreshold(delta) {
  return `CASE
    WHEN usage_value + (${delta}) >= limit_value THEN 100
    WHEN (usage_value + (${delta})) * 10 >= limit_value * 9 THEN 90
    WHEN (usage_value + (${delta})) * 5 >= limit_value * 4 THEN 80
    ELSE 0
  END`;
}

const removeUnlinkedDelta = capacityDelta(-1);
const addOrganizationDelta = capacityDelta(1);

const TRIGGER_SQL = Object.freeze({
  organization_knowledge_custody_no_update: `CREATE TRIGGER organization_knowledge_custody_no_update
BEFORE UPDATE ON organization_knowledge_custody
BEGIN SELECT RAISE(ABORT,'organization knowledge custody is immutable'); END`,
  organization_knowledge_custody_no_delete: `CREATE TRIGGER organization_knowledge_custody_no_delete
BEFORE DELETE ON organization_knowledge_custody
BEGIN SELECT RAISE(ABORT,'organization knowledge custody is append-only'); END`,
  organization_knowledge_custody_scope_insert: `CREATE TRIGGER organization_knowledge_custody_scope_insert
BEFORE INSERT ON organization_knowledge_custody
WHEN NOT EXISTS (
  SELECT 1
  FROM knowledge_entries entry
  JOIN organization_memberships membership
    ON membership.org_id=NEW.org_id
   AND membership.user_id=NEW.created_by
   AND membership.status='active'
  JOIN users actor ON actor.id=membership.user_id AND actor.is_active=1
  JOIN knowledge_entry_governance governance
    ON governance.knowledge_entry_id=entry.id
  WHERE entry.id=NEW.knowledge_entry_id
    AND entry.created_by=NEW.created_by
    AND entry.entry_type='performance_review_methodology'
    AND entry.source_type='organization_performance_methodology'
    AND entry.business_type='organization'
    AND entry.business_id=CAST(NEW.org_id AS TEXT)
    AND entry.visibility='team'
    AND entry.is_public=1
    AND json_valid(entry.metadata_json)
    AND json_extract(entry.metadata_json,'$.organization_methodology.contract_version')='organization-methodology-promotion-v2'
    AND governance.is_current=1
    AND governance.quality_state IN ('candidate','confirmed')
)
BEGIN SELECT RAISE(ABORT,'organization knowledge custody scope is invalid'); END`,
  organization_knowledge_custody_capacity_insert: `CREATE TRIGGER organization_knowledge_custody_capacity_insert
AFTER INSERT ON organization_knowledge_custody
BEGIN
  UPDATE knowledge_capacity_gauges
  SET usage_value=usage_value + (${removeUnlinkedDelta}),
      threshold_percent=${gaugeThreshold(removeUnlinkedDelta)},
      updated_at=CURRENT_TIMESTAMP
  WHERE scope_type='organization' AND metric IN ('entries','chunks','payload_bytes')
    AND scope_id IN (
      SELECT membership.org_id
      FROM organization_memberships membership
      WHERE membership.user_id=NEW.created_by
    );
  UPDATE knowledge_capacity_gauges
  SET usage_value=usage_value + (${addOrganizationDelta}),
      threshold_percent=${gaugeThreshold(addOrganizationDelta)},
      updated_at=CURRENT_TIMESTAMP
  WHERE scope_type='organization' AND scope_id=NEW.org_id
    AND metric IN ('entries','chunks','payload_bytes');
  UPDATE knowledge_unlinked_user_usage
  SET entries=entries-1,
      chunks=chunks-(SELECT chunk_count FROM knowledge_entry_footprints WHERE knowledge_entry_id=NEW.knowledge_entry_id),
      payload_bytes=payload_bytes-(
        SELECT entry_payload_bytes + chunk_payload_bytes
        FROM knowledge_entry_footprints
        WHERE knowledge_entry_id=NEW.knowledge_entry_id
      ),
      updated_at=CURRENT_TIMESTAMP
  WHERE user_id=NEW.created_by;
END`,
  organization_methodology_requests_no_update: `CREATE TRIGGER organization_methodology_requests_no_update
BEFORE UPDATE ON organization_methodology_promotion_requests
BEGIN SELECT RAISE(ABORT,'organization methodology requests are immutable'); END`,
  organization_methodology_requests_no_delete: `CREATE TRIGGER organization_methodology_requests_no_delete
BEFORE DELETE ON organization_methodology_promotion_requests
BEGIN SELECT RAISE(ABORT,'organization methodology requests are append-only'); END`,
  organization_methodology_requests_scope_insert: `CREATE TRIGGER organization_methodology_requests_scope_insert
BEFORE INSERT ON organization_methodology_promotion_requests
WHEN NOT EXISTS (
  SELECT 1
  FROM campaigns campaign
  JOIN knowledge_entries source ON source.id=NEW.source_knowledge_entry_id
  JOIN knowledge_current_custody source_custody
    ON source_custody.knowledge_entry_id=source.id
   AND source_custody.org_id=NEW.org_id
   AND source_custody.campaign_id=NEW.source_campaign_id
   AND source_custody.custody_state='active'
  JOIN knowledge_entry_governance governance
    ON governance.knowledge_entry_id=source.id
  JOIN organization_memberships requester_membership
    ON requester_membership.org_id=NEW.org_id
   AND requester_membership.user_id=NEW.requested_by
   AND requester_membership.status='active'
  JOIN users requester
    ON requester.id=requester_membership.user_id
   AND requester.is_active=1
  WHERE campaign.org_id=NEW.org_id AND campaign.id=NEW.source_campaign_id
    AND source.business_type='campaign'
    AND source.business_id=CAST(NEW.source_campaign_id AS TEXT)
    AND source.visibility='team' AND source.is_public=1
    AND source.source_type IN (
      'performance_ai_review_confirmation',
      'performance_content_analysis_confirmation'
    )
    AND json_valid(source.metadata_json)
    AND json_extract(source.metadata_json,'$.confirmation.contract_version') IN (
      'performance-ai-review-approval-v1',
      'performance-content-analysis-approval-v1'
    )
    AND CAST(json_extract(source.metadata_json,'$.confirmation.approved_by') AS INTEGER)=NEW.first_approved_by
    AND governance.reviewed_by=NEW.first_approved_by
    AND governance.is_current=1
    AND governance.quality_state='confirmed'
    AND governance.governance_version=NEW.expected_governance_version
    AND EXISTS (
      SELECT 1 FROM team_memberships active_team
      WHERE active_team.org_id=NEW.org_id
        AND active_team.user_id=NEW.requested_by
        AND active_team.status='active'
    )
    AND (
      NEW.requested_by=NEW.first_approved_by
      OR requester_membership.role_code='org_admin'
    )
    AND (
      requester_membership.role_code='org_admin'
      OR campaign.owner_user_id=NEW.requested_by
      OR EXISTS (
        SELECT 1 FROM team_memberships assigned_team
        WHERE assigned_team.org_id=campaign.org_id
          AND assigned_team.team_id=campaign.team_id
          AND assigned_team.user_id=NEW.requested_by
          AND assigned_team.status='active'
      )
    )
    AND (
      NEW.supersedes_knowledge_entry_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM organization_knowledge_custody prior_custody
        JOIN knowledge_entries prior ON prior.id=prior_custody.knowledge_entry_id
        JOIN knowledge_entry_governance prior_governance
          ON prior_governance.knowledge_entry_id=prior.id
        WHERE prior_custody.org_id=NEW.org_id
          AND prior.id=NEW.supersedes_knowledge_entry_id
          AND prior.source_type='organization_performance_methodology'
          AND prior_governance.is_current=1
          AND prior_governance.quality_state='confirmed'
      )
    )
)
BEGIN SELECT RAISE(ABORT,'organization methodology request scope is invalid'); END`,
  organization_methodology_decisions_no_update: `CREATE TRIGGER organization_methodology_decisions_no_update
BEFORE UPDATE ON organization_methodology_promotion_decisions
BEGIN SELECT RAISE(ABORT,'organization methodology decisions are immutable'); END`,
  organization_methodology_decisions_no_delete: `CREATE TRIGGER organization_methodology_decisions_no_delete
BEFORE DELETE ON organization_methodology_promotion_decisions
BEGIN SELECT RAISE(ABORT,'organization methodology decisions are append-only'); END`,
  organization_methodology_decisions_scope_insert: `CREATE TRIGGER organization_methodology_decisions_scope_insert
BEFORE INSERT ON organization_methodology_promotion_decisions
WHEN NOT EXISTS (
  SELECT 1
  FROM organization_methodology_promotion_requests request
  JOIN organization_memberships approver_membership
    ON approver_membership.org_id=request.org_id
   AND approver_membership.user_id=NEW.decided_by
   AND approver_membership.role_code='org_admin'
   AND approver_membership.status='active'
  JOIN users approver ON approver.id=approver_membership.user_id AND approver.is_active=1
  JOIN knowledge_entry_governance source_governance
    ON source_governance.knowledge_entry_id=request.source_knowledge_entry_id
  WHERE request.id=NEW.request_id
    AND request.org_id=NEW.org_id
    AND NEW.decided_by<>request.first_approved_by
    AND source_governance.is_current=1
    AND source_governance.quality_state='confirmed'
    AND source_governance.governance_version=request.expected_governance_version
    AND EXISTS (
      SELECT 1 FROM team_memberships active_team
      WHERE active_team.org_id=request.org_id
        AND active_team.user_id=NEW.decided_by
        AND active_team.status='active'
    )
    AND (
      NEW.decision='rejected'
      OR EXISTS (
        SELECT 1
        FROM organization_knowledge_custody target_custody
        JOIN knowledge_entries target ON target.id=target_custody.knowledge_entry_id
        JOIN knowledge_entry_governance target_governance
          ON target_governance.knowledge_entry_id=target.id
        WHERE target_custody.org_id=request.org_id
          AND target.id=NEW.target_knowledge_entry_id
          AND target.source_type='organization_performance_methodology'
          AND target.business_type='organization'
          AND target.business_id=CAST(request.org_id AS TEXT)
          AND target_governance.is_current=1
          AND target_governance.quality_state='confirmed'
          AND json_valid(target.metadata_json)
          AND json_extract(target.metadata_json,'$.organization_methodology.contract_version')='organization-methodology-promotion-v2'
          AND json_extract(target.metadata_json,'$.organization_methodology.dedupe_sha256')=request.dedupe_sha256
          AND NEW.supersedes_knowledge_entry_id IS request.supersedes_knowledge_entry_id
          AND (
            request.supersedes_knowledge_entry_id IS NULL
            OR (
              target_governance.supersedes_entry_id=request.supersedes_knowledge_entry_id
              AND EXISTS (
                SELECT 1 FROM organization_knowledge_custody prior_custody
                WHERE prior_custody.org_id=request.org_id
                  AND prior_custody.knowledge_entry_id=request.supersedes_knowledge_entry_id
              )
            )
          )
      )
    )
)
BEGIN SELECT RAISE(ABORT,'organization methodology decision scope is invalid'); END`
});

const migration = {
  version: 20,
  name: '020_organization_methodology_promotion',
  sourcePath: 'migrations/020_organization_methodology_promotion.js',
  engineVersion: 1,
  dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js'],
  schemaManifest: {
    columns: {
      organization_knowledge_custody: {
        knowledge_entry_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        org_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        custody_type: { type: 'TEXT', notnull: 1, defaultValue: null },
        created_by: { type: 'INTEGER', notnull: 1, defaultValue: null },
        created_at: { type: 'TEXT', notnull: 1, defaultValue: 'CURRENT_TIMESTAMP' }
      },
      organization_methodology_promotion_requests: {
        id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        org_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        source_campaign_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        source_knowledge_entry_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        requested_by: { type: 'INTEGER', notnull: 1, defaultValue: null },
        first_approved_by: { type: 'INTEGER', notnull: 1, defaultValue: null },
        expected_governance_version: { type: 'INTEGER', notnull: 1, defaultValue: null },
        dedupe_sha256: { type: 'TEXT', notnull: 1, defaultValue: null },
        dimensions_json: { type: 'TEXT', notnull: 1, defaultValue: null },
        supersedes_knowledge_entry_id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        request_reason: { type: 'TEXT', notnull: 1, defaultValue: null },
        created_at: { type: 'TEXT', notnull: 1, defaultValue: 'CURRENT_TIMESTAMP' }
      },
      organization_methodology_promotion_decisions: {
        id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        request_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        org_id: { type: 'INTEGER', notnull: 1, defaultValue: null },
        decision: { type: 'TEXT', notnull: 1, defaultValue: null },
        decided_by: { type: 'INTEGER', notnull: 1, defaultValue: null },
        decision_reason: { type: 'TEXT', notnull: 1, defaultValue: null },
        target_knowledge_entry_id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        supersedes_knowledge_entry_id: { type: 'INTEGER', notnull: 0, defaultValue: null },
        created_at: { type: 'TEXT', notnull: 1, defaultValue: 'CURRENT_TIMESTAMP' }
      }
    },
    indexes: INDEX_SQL,
    triggers: TRIGGER_SQL,
    tableChecks: {
      organization_knowledge_custody: [
        "CHECK(custody_type='methodology')"
      ],
      organization_methodology_promotion_requests: [
        'length(dedupe_sha256)=64',
        "json_type(dimensions_json)='object'",
        'length(trim(request_reason)) BETWEEN 1 AND 500'
      ],
      organization_methodology_promotion_decisions: [
        "CHECK(decision IN ('approved','rejected'))",
        'length(trim(decision_reason)) BETWEEN 1 AND 500',
        "decision='approved' AND target_knowledge_entry_id IS NOT NULL"
      ]
    }
  },
  apply(db) {
    for (const name of [
      'users',
      'organizations',
      'organization_memberships',
      'team_memberships',
      'campaigns',
      'knowledge_entries',
      'knowledge_chunks',
      'knowledge_entry_governance',
      'knowledge_entry_footprints',
      'knowledge_unlinked_user_usage',
      'knowledge_capacity_gauges',
      'knowledge_current_custody'
    ]) {
      if (!db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name=?").get(name)) {
        throw new Error(`020 requires ${name}`);
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
    if (existing.length > 0) throw new Error(`partial 020 object exists: ${existing[0].name}`);
    db.exec([
      ...Object.values(TABLE_SQL),
      ...Object.values(INDEX_SQL),
      ...Object.values(TRIGGER_SQL)
    ].join(';\n') + ';');
  }
};

module.exports = migration;

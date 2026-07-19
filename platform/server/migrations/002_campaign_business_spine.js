const engine = require('./engines/v1');
const { createHash } = require('node:crypto');

const SAFE_MAX = engine.SAFE_MAX;

const SQL_BLOCKS = [
  `
ALTER TABLE knowledge_entries ADD COLUMN source_identity_sha256 TEXT CHECK(
  source_identity_sha256 IS NULL OR (
    length(source_identity_sha256)=64 AND source_identity_sha256=lower(source_identity_sha256)
    AND source_identity_sha256 NOT GLOB '*[^0-9a-f]*'
  )
);
ALTER TABLE knowledge_entries ADD COLUMN content_sha256 TEXT CHECK(
  content_sha256 IS NULL OR (
    length(content_sha256)=64 AND content_sha256=lower(content_sha256)
    AND content_sha256 NOT GLOB '*[^0-9a-f]*'
  )
);
ALTER TABLE knowledge_chunks ADD COLUMN content_sha256 TEXT CHECK(
  content_sha256 IS NULL OR (
    length(content_sha256)=64 AND content_sha256=lower(content_sha256)
    AND content_sha256 NOT GLOB '*[^0-9a-f]*'
  )
);
ALTER TABLE ai_references ADD COLUMN reference_schema_version INTEGER CHECK(
  reference_schema_version IS NULL OR (
    typeof(reference_schema_version)='integer' AND reference_schema_version=1
  )
);
ALTER TABLE ai_references ADD COLUMN knowledge_entry_id INTEGER CHECK(
  knowledge_entry_id IS NULL OR (
    typeof(knowledge_entry_id)='integer' AND knowledge_entry_id BETWEEN 1 AND 9007199254740991
  )
);
ALTER TABLE ai_references ADD COLUMN knowledge_chunk_id INTEGER CHECK(
  knowledge_chunk_id IS NULL OR (
    typeof(knowledge_chunk_id)='integer' AND knowledge_chunk_id BETWEEN 1 AND 9007199254740991
  )
);
ALTER TABLE ai_references ADD COLUMN campaign_id INTEGER CHECK(
  campaign_id IS NULL OR (
    typeof(campaign_id)='integer' AND campaign_id BETWEEN 1 AND 9007199254740991
  )
);
ALTER TABLE ai_references ADD COLUMN source_identity_sha256 TEXT CHECK(
  source_identity_sha256 IS NULL OR (
    length(source_identity_sha256)=64 AND source_identity_sha256=lower(source_identity_sha256)
    AND source_identity_sha256 NOT GLOB '*[^0-9a-f]*'
  )
);
ALTER TABLE ai_references ADD COLUMN entry_content_sha256 TEXT CHECK(
  entry_content_sha256 IS NULL OR (
    length(entry_content_sha256)=64 AND entry_content_sha256=lower(entry_content_sha256)
    AND entry_content_sha256 NOT GLOB '*[^0-9a-f]*'
  )
);
ALTER TABLE ai_references ADD COLUMN chunk_content_sha256 TEXT CHECK(
  chunk_content_sha256 IS NULL OR (
    length(chunk_content_sha256)=64 AND chunk_content_sha256=lower(chunk_content_sha256)
    AND chunk_content_sha256 NOT GLOB '*[^0-9a-f]*'
  )
);
ALTER TABLE ai_references ADD COLUMN reference_rank INTEGER CHECK(
  reference_rank IS NULL OR (
    typeof(reference_rank)='integer' AND reference_rank BETWEEN 1 AND 9007199254740991
  )
);
ALTER TABLE ai_references ADD COLUMN selection_origin TEXT CHECK(
  selection_origin IS NULL OR selection_origin IN ('selected','retrieved')
);

CREATE UNIQUE INDEX ux_knowledge_source_identity
  ON knowledge_entries(source_identity_sha256)
  WHERE source_identity_sha256 IS NOT NULL;
CREATE UNIQUE INDEX ux_knowledge_campaign_review_source
  ON knowledge_entries(source_type,CAST(source_id AS TEXT))
  WHERE source_type='campaign_review';
CREATE UNIQUE INDEX ux_knowledge_chunk_entry_index
  ON knowledge_chunks(entry_id,chunk_index);
CREATE UNIQUE INDEX ux_ai_reference_v1_rank
  ON ai_references(message_id,reference_rank)
  WHERE reference_schema_version=1;
CREATE UNIQUE INDEX ux_ai_reference_v1_chunk
  ON ai_references(message_id,knowledge_chunk_id)
  WHERE reference_schema_version=1;

CREATE TRIGGER knowledge_entries_digest_required_insert
BEFORE INSERT ON knowledge_entries
WHEN NEW.source_identity_sha256 IS NULL OR NEW.content_sha256 IS NULL
BEGIN SELECT RAISE(ABORT,'knowledge entry digests are required'); END;

CREATE TRIGGER knowledge_chunks_digest_required_insert
BEFORE INSERT ON knowledge_chunks
WHEN NEW.content_sha256 IS NULL
BEGIN SELECT RAISE(ABORT,'knowledge chunk digest is required'); END;

CREATE TRIGGER knowledge_source_identity_immutable
BEFORE UPDATE OF source_identity_sha256 ON knowledge_entries
WHEN NEW.source_identity_sha256 IS NOT OLD.source_identity_sha256
BEGIN SELECT RAISE(ABORT,'knowledge source identity is immutable'); END;

CREATE TRIGGER knowledge_campaign_review_identity_insert
BEFORE INSERT ON knowledge_entries
WHEN NEW.entry_type='campaign_review' OR NEW.source_type='campaign_review'
BEGIN
  SELECT CASE WHEN NOT (
    NEW.entry_type='campaign_review' AND NEW.source_type='campaign_review'
    AND typeof(NEW.source_id)='text'
    AND NEW.business_type='campaign' AND typeof(NEW.business_id)='text'
    AND length(NEW.business_id) BETWEEN 1 AND 16
    AND NEW.business_id NOT GLOB '*[^0-9]*' AND NEW.business_id NOT LIKE '0%'
    AND CAST(CAST(NEW.business_id AS INTEGER) AS TEXT)=NEW.business_id
    AND CAST(NEW.business_id AS INTEGER) BETWEEN 1 AND 9007199254740991
    AND instr(NEW.source_id,':')=length(NEW.business_id)+1
    AND substr(NEW.source_id,1,instr(NEW.source_id,':')-1)=NEW.business_id
    AND length(substr(NEW.source_id,instr(NEW.source_id,':')+1)) BETWEEN 1 AND 16
    AND substr(NEW.source_id,instr(NEW.source_id,':')+1) NOT GLOB '*[^0-9]*'
    AND substr(NEW.source_id,instr(NEW.source_id,':')+1) NOT LIKE '0%'
    AND CAST(CAST(substr(NEW.source_id,instr(NEW.source_id,':')+1) AS INTEGER) AS TEXT)
      =substr(NEW.source_id,instr(NEW.source_id,':')+1)
    AND CAST(substr(NEW.source_id,instr(NEW.source_id,':')+1) AS INTEGER)
      BETWEEN 1 AND 9007199254740991
  ) THEN RAISE(ABORT,'invalid campaign review knowledge identity') END;
END;

CREATE TRIGGER knowledge_campaign_review_identity_immutable
BEFORE UPDATE OF entry_type,source_type,source_id,business_type,business_id
ON knowledge_entries
WHEN (OLD.entry_type='campaign_review' OR OLD.source_type='campaign_review'
   OR NEW.entry_type='campaign_review' OR NEW.source_type='campaign_review')
  AND NOT (
    NEW.entry_type IS OLD.entry_type AND NEW.source_type IS OLD.source_type
    AND NEW.source_id IS OLD.source_id AND NEW.business_type IS OLD.business_type
    AND NEW.business_id IS OLD.business_id
  )
BEGIN SELECT RAISE(ABORT,'campaign review knowledge identity is immutable'); END;

CREATE TRIGGER ai_references_v1_shape_insert
BEFORE INSERT ON ai_references
WHEN EXISTS (
  SELECT 1
  FROM ai_references existing
  WHERE (existing.reference_schema_version=1 OR NEW.reference_schema_version=1)
    AND (
      existing.id=NEW.id
      OR (
        existing.reference_schema_version=1 AND NEW.reference_schema_version=1
        AND existing.message_id=NEW.message_id
        AND existing.reference_rank=NEW.reference_rank
      )
      OR (
        existing.reference_schema_version=1 AND NEW.reference_schema_version=1
        AND existing.message_id=NEW.message_id
        AND existing.knowledge_chunk_id=NEW.knowledge_chunk_id
      )
    )
) OR (
  NEW.reference_schema_version IS NULL AND (
    NEW.knowledge_entry_id IS NOT NULL OR NEW.knowledge_chunk_id IS NOT NULL
    OR NEW.campaign_id IS NOT NULL OR NEW.source_identity_sha256 IS NOT NULL
    OR NEW.entry_content_sha256 IS NOT NULL OR NEW.chunk_content_sha256 IS NOT NULL
    OR NEW.reference_rank IS NOT NULL OR NEW.selection_origin IS NOT NULL
  )
) OR (
  NEW.reference_schema_version=1 AND (
    NEW.reference_type<>'knowledge' OR NEW.knowledge_entry_id IS NULL
    OR NEW.knowledge_chunk_id IS NULL OR NEW.campaign_id IS NULL
    OR NEW.source_identity_sha256 IS NULL OR NEW.entry_content_sha256 IS NULL
    OR NEW.chunk_content_sha256 IS NULL OR NEW.reference_rank IS NULL
    OR NEW.selection_origin IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM knowledge_chunks chunk
      JOIN knowledge_entries entry ON entry.id=chunk.entry_id
      WHERE chunk.id=NEW.knowledge_chunk_id AND entry.id=NEW.knowledge_entry_id
        AND entry.source_identity_sha256=NEW.source_identity_sha256
        AND entry.content_sha256=NEW.entry_content_sha256
        AND chunk.content_sha256=NEW.chunk_content_sha256
    )
  )
)
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM ai_references existing
    WHERE (existing.reference_schema_version=1 OR NEW.reference_schema_version=1)
      AND (
        existing.id=NEW.id
        OR (
          existing.reference_schema_version=1 AND NEW.reference_schema_version=1
          AND existing.message_id=NEW.message_id
          AND existing.reference_rank=NEW.reference_rank
        )
        OR (
          existing.reference_schema_version=1 AND NEW.reference_schema_version=1
          AND existing.message_id=NEW.message_id
          AND existing.knowledge_chunk_id=NEW.knowledge_chunk_id
        )
      )
  ) THEN RAISE(ABORT,'versioned knowledge reference cannot be replaced') END;
  SELECT RAISE(ABORT,'invalid versioned knowledge reference');
END;

CREATE TRIGGER ai_references_v1_snapshot_immutable
BEFORE UPDATE OF reference_schema_version,knowledge_entry_id,knowledge_chunk_id,campaign_id,
  source_identity_sha256,entry_content_sha256,chunk_content_sha256,reference_rank,selection_origin
ON ai_references
WHEN OLD.reference_schema_version=1 OR NEW.reference_schema_version=1
BEGIN SELECT RAISE(ABORT,'versioned knowledge reference is immutable'); END;
`,
  `
CREATE TABLE organizations (
  id INTEGER PRIMARY KEY CHECK(id BETWEEN 1 AND 9007199254740991),
  code TEXT NOT NULL UNIQUE CHECK(length(trim(code)) BETWEEN 1 AND 80),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 160),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(strftime('%Y-%m-%d %H:%M:%S',created_at) IS NOT NULL AND strftime('%Y-%m-%d %H:%M:%S',created_at)=created_at)
) STRICT;

CREATE TRIGGER organizations_code_immutable
BEFORE UPDATE OF code ON organizations
WHEN NEW.code IS NOT OLD.code
BEGIN
  SELECT RAISE(ABORT,'organization code is immutable');
END;

CREATE TRIGGER organizations_no_replace_insert
BEFORE INSERT ON organizations
WHEN EXISTS (
  SELECT 1
  FROM organizations existing
  WHERE existing.id=NEW.id OR existing.code=NEW.code
)
BEGIN SELECT RAISE(ABORT,'organization cannot be replaced'); END;

CREATE TRIGGER default_organization_delete_guard
BEFORE DELETE ON organizations
WHEN OLD.code='turingmarket-default'
BEGIN
  SELECT RAISE(ABORT,'default organization is required');
END;

CREATE TABLE organization_memberships (
  org_id INTEGER NOT NULL CHECK(org_id BETWEEN 1 AND 9007199254740991),
  user_id INTEGER NOT NULL CHECK(user_id BETWEEN 1 AND 9007199254740991),
  role_code TEXT NOT NULL CHECK(role_code IN ('org_admin','member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TEXT,
  PRIMARY KEY(org_id,user_id),
  CHECK((status='active' AND revoked_at IS NULL) OR (status='revoked' AND revoked_at IS NOT NULL)),
  CHECK(strftime('%Y-%m-%d %H:%M:%S',created_at) IS NOT NULL AND strftime('%Y-%m-%d %H:%M:%S',created_at)=created_at),
  CHECK(revoked_at IS NULL OR (strftime('%Y-%m-%d %H:%M:%S',revoked_at) IS NOT NULL AND strftime('%Y-%m-%d %H:%M:%S',revoked_at)=revoked_at)),
  FOREIGN KEY(org_id) REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(user_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TABLE teams (
  id INTEGER PRIMARY KEY CHECK(id BETWEEN 1 AND 9007199254740991),
  org_id INTEGER NOT NULL CHECK(org_id BETWEEN 1 AND 9007199254740991),
  code TEXT NOT NULL CHECK(length(trim(code)) BETWEEN 1 AND 80),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 160),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(strftime('%Y-%m-%d %H:%M:%S',created_at) IS NOT NULL AND strftime('%Y-%m-%d %H:%M:%S',created_at)=created_at),
  UNIQUE(org_id,id),
  UNIQUE(org_id,code),
  FOREIGN KEY(org_id) REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TABLE team_memberships (
  org_id INTEGER NOT NULL CHECK(org_id BETWEEN 1 AND 9007199254740991),
  team_id INTEGER NOT NULL CHECK(team_id BETWEEN 1 AND 9007199254740991),
  user_id INTEGER NOT NULL CHECK(user_id BETWEEN 1 AND 9007199254740991),
  role_code TEXT NOT NULL CHECK(role_code IN ('team_lead','member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TEXT,
  PRIMARY KEY(org_id,team_id,user_id),
  CHECK((status='active' AND revoked_at IS NULL) OR (status='revoked' AND revoked_at IS NOT NULL)),
  CHECK(strftime('%Y-%m-%d %H:%M:%S',created_at) IS NOT NULL AND strftime('%Y-%m-%d %H:%M:%S',created_at)=created_at),
  CHECK(revoked_at IS NULL OR (strftime('%Y-%m-%d %H:%M:%S',revoked_at) IS NOT NULL AND strftime('%Y-%m-%d %H:%M:%S',revoked_at)=revoked_at)),
  FOREIGN KEY(org_id,team_id) REFERENCES teams(org_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(org_id,user_id) REFERENCES organization_memberships(org_id,user_id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER activity_log_append_only_update
BEFORE UPDATE ON activity_log
BEGIN
  SELECT RAISE(ABORT,'activity_log is append-only');
END;

CREATE TRIGGER activity_log_append_only_delete
BEFORE DELETE ON activity_log
BEGIN
  SELECT RAISE(ABORT,'activity_log is append-only');
END;

CREATE TRIGGER activity_log_identity_shape
BEFORE INSERT ON activity_log
WHEN EXISTS (
  SELECT 1 FROM activity_log existing WHERE existing.id=NEW.id
) OR (NEW.module='identity' AND (
  NEW.action <> 'identity_state_changed'
  OR NEW.details IS NULL
  OR json_valid(NEW.details)=0
  OR json_type(NEW.details) <> 'object'
  OR length(CAST(NEW.details AS BLOB)) > 4096
  OR (SELECT count(*) FROM json_each(NEW.details)) <> 9
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.details)
    WHERE key NOT IN (
      'schema_version','actor_user_id','subject_user_id','organization_id','reason',
      'request_id','changed_fields','before','after'
    )
  )
  OR EXISTS (
    SELECT 1 FROM (
      SELECT 'schema_version' AS key UNION ALL SELECT 'actor_user_id'
      UNION ALL SELECT 'subject_user_id' UNION ALL SELECT 'organization_id'
      UNION ALL SELECT 'reason' UNION ALL SELECT 'request_id'
      UNION ALL SELECT 'changed_fields' UNION ALL SELECT 'before' UNION ALL SELECT 'after'
    ) required
    WHERE (SELECT count(*) FROM json_each(NEW.details) item WHERE item.key=required.key) <> 1
  )
  OR COALESCE(json_type(NEW.details,'$.schema_version'),'missing') <> 'integer'
  OR json_extract(NEW.details,'$.schema_version') <> 1
  OR COALESCE(json_type(NEW.details,'$.actor_user_id'),'missing') NOT IN ('integer','null')
  OR COALESCE(json_type(NEW.details,'$.subject_user_id'),'missing') <> 'integer'
  OR COALESCE(json_type(NEW.details,'$.organization_id'),'missing') <> 'integer'
  OR COALESCE(json_type(NEW.details,'$.reason'),'missing') <> 'text'
  OR COALESCE(json_type(NEW.details,'$.request_id'),'missing') NOT IN ('text','null')
  OR COALESCE(json_type(NEW.details,'$.changed_fields'),'missing') <> 'array'
  OR COALESCE(json_type(NEW.details,'$.before'),'missing') NOT IN ('object','null')
  OR COALESCE(json_type(NEW.details,'$.after'),'missing') NOT IN ('object','null')
))
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM activity_log existing WHERE existing.id=NEW.id
  ) THEN RAISE(ABORT,'activity_log is append-only') END;
  SELECT RAISE(ABORT,'invalid identity audit event');
END;
`,
  `
CREATE UNIQUE INDEX ux_opportunities_id_customer
  ON opportunities(id,customer_id);

CREATE TABLE campaigns (
  id INTEGER PRIMARY KEY CHECK(id BETWEEN 1 AND 9007199254740991),
  org_id INTEGER NOT NULL CHECK(org_id BETWEEN 1 AND 9007199254740991),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 160),
  customer_id INTEGER NOT NULL CHECK(customer_id BETWEEN 1 AND 9007199254740991),
  opportunity_id INTEGER NOT NULL CHECK(opportunity_id BETWEEN 1 AND 9007199254740991),
  owner_user_id INTEGER NOT NULL CHECK(owner_user_id BETWEEN 1 AND 9007199254740991),
  team_id INTEGER NOT NULL CHECK(team_id BETWEEN 1 AND 9007199254740991),
  lifecycle_state TEXT NOT NULL DEFAULT 'lead' CHECK(lifecycle_state IN (
    'lead','qualified','demand_confirmed','proposal_draft','proposal_confirmed',
    'influencer_shortlist','ordered','executing','published','settled','reviewed'
  )),
  operational_status TEXT NOT NULL DEFAULT 'active'
    CHECK(operational_status IN ('active','on_hold','cancelled')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK(
    typeof(row_version)='integer' AND row_version BETWEEN 1 AND 9007199254740991
  ),
  product_name TEXT CHECK(product_name IS NULL OR length(product_name) <= 160),
  region TEXT CHECK(region IS NULL OR length(region) <= 120),
  currency TEXT CHECK(currency IS NULL OR (
    length(currency)=3 AND currency=upper(currency)
    AND currency NOT GLOB '*[^A-Z]*'
  )),
  budget_minor INTEGER CHECK(
    budget_minor IS NULL OR budget_minor BETWEEN 0 AND 9007199254740991
  ),
  start_date TEXT CHECK(start_date IS NULL OR (
    date(start_date) IS NOT NULL AND date(start_date)=start_date
  )),
  end_date TEXT CHECK(end_date IS NULL OR (
    date(end_date) IS NOT NULL AND date(end_date)=end_date
  )),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(start_date IS NULL OR end_date IS NULL OR end_date >= start_date),
  CHECK(strftime('%Y-%m-%d %H:%M:%S',created_at) IS NOT NULL AND strftime('%Y-%m-%d %H:%M:%S',created_at)=created_at),
  CHECK(strftime('%Y-%m-%d %H:%M:%S',updated_at) IS NOT NULL AND strftime('%Y-%m-%d %H:%M:%S',updated_at)=updated_at),
  UNIQUE(org_id,id),
  FOREIGN KEY(org_id) REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(customer_id) REFERENCES customers(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(opportunity_id,customer_id) REFERENCES opportunities(id,customer_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(org_id,owner_user_id) REFERENCES organization_memberships(org_id,user_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(org_id,team_id,owner_user_id) REFERENCES team_memberships(org_id,team_id,user_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;
`,
  `
CREATE TABLE campaign_events (
  id INTEGER PRIMARY KEY CHECK(id BETWEEN 1 AND 9007199254740991),
  org_id INTEGER NOT NULL CHECK(org_id BETWEEN 1 AND 9007199254740991),
  campaign_id INTEGER NOT NULL CHECK(campaign_id BETWEEN 1 AND 9007199254740991),
  event_type TEXT NOT NULL CHECK(event_type IN (
    'campaign_created','lifecycle_transition','operational_status_changed',
    'campaign_transferred','link_attached','link_revoked','link_moved',
    'workflow_reconciliation'
  )),
  previous_state TEXT CHECK(previous_state IS NULL OR previous_state IN (
    'lead','qualified','demand_confirmed','proposal_draft','proposal_confirmed',
    'influencer_shortlist','ordered','executing','published','settled','reviewed'
  )),
  next_state TEXT CHECK(next_state IS NULL OR next_state IN (
    'lead','qualified','demand_confirmed','proposal_draft','proposal_confirmed',
    'influencer_shortlist','ordered','executing','published','settled','reviewed'
  )),
  actor_user_id INTEGER NOT NULL CHECK(actor_user_id BETWEEN 1 AND 9007199254740991),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
  source TEXT NOT NULL CHECK(length(trim(source)) BETWEEN 1 AND 120),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(
    json_valid(metadata_json)
    AND json_type(metadata_json)='object'
    AND length(CAST(metadata_json AS BLOB)) <= 4096
  ),
  correlation_id TEXT NOT NULL CHECK(
    length(CAST(correlation_id AS BLOB)) BETWEEN 8 AND 120
    AND length(correlation_id)=length(CAST(correlation_id AS BLOB))
    AND correlation_id NOT GLOB '*[^ -~]*'
  ),
  audit_fingerprint TEXT NOT NULL CHECK(
    length(audit_fingerprint)=64 AND audit_fingerprint=lower(audit_fingerprint)
    AND audit_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(strftime('%Y-%m-%d %H:%M:%S',created_at) IS NOT NULL AND strftime('%Y-%m-%d %H:%M:%S',created_at)=created_at),
  UNIQUE(org_id,campaign_id,id),
  UNIQUE(org_id,campaign_id,audit_fingerprint,event_type),
  FOREIGN KEY(org_id,campaign_id) REFERENCES campaigns(org_id,id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(org_id,actor_user_id) REFERENCES organization_memberships(org_id,user_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER campaign_events_no_update
BEFORE UPDATE ON campaign_events
BEGIN SELECT RAISE(ABORT,'campaign_events are append-only'); END;

CREATE TRIGGER campaign_events_no_delete
BEFORE DELETE ON campaign_events
BEGIN SELECT RAISE(ABORT,'campaign_events are append-only'); END;

CREATE TRIGGER campaign_events_exact_shape
BEFORE INSERT ON campaign_events
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM campaign_events existing
    WHERE existing.id=NEW.id
      OR (
        existing.org_id=NEW.org_id
        AND existing.campaign_id=NEW.campaign_id
        AND existing.audit_fingerprint=NEW.audit_fingerprint
        AND existing.event_type=NEW.event_type
      )
  ) THEN RAISE(ABORT,'campaign_events are append-only') END;

  SELECT CASE WHEN NOT (
    (NEW.event_type='campaign_created' AND NEW.source='campaign_api'
      AND NEW.reason='Campaign created' AND NEW.previous_state IS NULL AND NEW.next_state='lead')
    OR (NEW.event_type='lifecycle_transition' AND NEW.source='project_workspace'
      AND NEW.previous_state IS NOT NULL AND NEW.next_state IS NOT NULL)
    OR (NEW.event_type IN ('operational_status_changed','campaign_transferred','link_attached','link_revoked','link_moved','workflow_reconciliation')
      AND NEW.previous_state IS NULL AND NEW.next_state IS NULL
      AND (
        (NEW.event_type='operational_status_changed' AND NEW.source IN ('project_workspace','collaboration_link'))
        OR (NEW.event_type IN ('campaign_transferred','link_moved') AND NEW.source='project_workspace')
        OR (NEW.event_type='link_attached' AND NEW.source IN (
          'project_workspace','demand_link','proposal_link','ppt_link','ai_link','knowledge_link',
          'collaboration_link','campaign_review'
        ))
        OR (NEW.event_type='link_revoked' AND NEW.source IN ('project_workspace','collaboration_link'))
        OR (NEW.event_type='workflow_reconciliation' AND NEW.source='workflow_recovery')
      ))
  ) THEN RAISE(ABORT,'invalid campaign event source or state shape') END;

  SELECT CASE WHEN (
    (NEW.event_type='campaign_created' AND (
      (SELECT count(*) FROM json_each(NEW.metadata_json))<>5
      OR EXISTS (SELECT 1 FROM json_each(NEW.metadata_json) WHERE key NOT IN ('customer_id','opportunity_id','owner_user_id','team_id','row_version'))
    ))
    OR (NEW.event_type='lifecycle_transition' AND (
      (SELECT count(*) FROM json_each(NEW.metadata_json))<>2
      OR EXISTS (SELECT 1 FROM json_each(NEW.metadata_json) WHERE key NOT IN ('previous_version','next_version'))
    ))
    OR (NEW.event_type='operational_status_changed' AND (
      (SELECT count(*) FROM json_each(NEW.metadata_json))<>4
      OR EXISTS (SELECT 1 FROM json_each(NEW.metadata_json) WHERE key NOT IN ('previous_status','next_status','previous_version','next_version'))
      OR json_type(NEW.metadata_json,'$.previous_status')<>'text'
      OR json_type(NEW.metadata_json,'$.next_status')<>'text'
      OR json_extract(NEW.metadata_json,'$.previous_status') NOT IN ('active','on_hold','cancelled')
      OR json_extract(NEW.metadata_json,'$.next_status') NOT IN ('active','on_hold','cancelled')
    ))
    OR (NEW.event_type='campaign_transferred' AND (
      (SELECT count(*) FROM json_each(NEW.metadata_json))<>6
      OR EXISTS (SELECT 1 FROM json_each(NEW.metadata_json) WHERE key NOT IN (
        'previous_owner_user_id','next_owner_user_id','previous_team_id','next_team_id','previous_version','next_version'
      ))
    ))
    OR (NEW.event_type='link_attached' AND (
      (SELECT count(*) FROM json_each(NEW.metadata_json))<>5
      OR EXISTS (SELECT 1 FROM json_each(NEW.metadata_json) WHERE key NOT IN ('bundle_id','relation_types','record_type','record_id','link_ids'))
    ))
    OR (NEW.event_type='link_revoked' AND (
      (SELECT count(*) FROM json_each(NEW.metadata_json))<>5
      OR EXISTS (SELECT 1 FROM json_each(NEW.metadata_json) WHERE key NOT IN ('bundle_id','relation_types','record_type','record_id','revoked_link_ids'))
    ))
    OR (NEW.event_type='link_moved' AND (
      (SELECT count(*) FROM json_each(NEW.metadata_json))<>9
      OR EXISTS (SELECT 1 FROM json_each(NEW.metadata_json) WHERE key NOT IN (
        'source_bundle_id','destination_bundle_id','relation_types','record_type','record_id',
        'source_campaign_id','destination_campaign_id','revoked_link_ids','replacement_link_ids'
      ))
    ))
    OR (NEW.event_type='workflow_reconciliation' AND (
      (SELECT count(*) FROM json_each(NEW.metadata_json))<>4
      OR EXISTS (SELECT 1 FROM json_each(NEW.metadata_json) WHERE key NOT IN (
        'original_dispatch_id','replacement_dispatch_id','template_id','template_version'
      ))
    ))
    OR EXISTS (
      SELECT 1 FROM (
        SELECT 'campaign_created' event_type,'customer_id' key UNION ALL
        SELECT 'campaign_created','opportunity_id' UNION ALL SELECT 'campaign_created','owner_user_id' UNION ALL
        SELECT 'campaign_created','team_id' UNION ALL SELECT 'campaign_created','row_version' UNION ALL
        SELECT 'lifecycle_transition','previous_version' UNION ALL SELECT 'lifecycle_transition','next_version' UNION ALL
        SELECT 'operational_status_changed','previous_status' UNION ALL SELECT 'operational_status_changed','next_status' UNION ALL
        SELECT 'operational_status_changed','previous_version' UNION ALL SELECT 'operational_status_changed','next_version' UNION ALL
        SELECT 'campaign_transferred','previous_owner_user_id' UNION ALL SELECT 'campaign_transferred','next_owner_user_id' UNION ALL
        SELECT 'campaign_transferred','previous_team_id' UNION ALL SELECT 'campaign_transferred','next_team_id' UNION ALL
        SELECT 'campaign_transferred','previous_version' UNION ALL SELECT 'campaign_transferred','next_version' UNION ALL
        SELECT 'link_attached','bundle_id' UNION ALL SELECT 'link_attached','relation_types' UNION ALL
        SELECT 'link_attached','record_type' UNION ALL SELECT 'link_attached','record_id' UNION ALL SELECT 'link_attached','link_ids' UNION ALL
        SELECT 'link_revoked','bundle_id' UNION ALL SELECT 'link_revoked','relation_types' UNION ALL
        SELECT 'link_revoked','record_type' UNION ALL SELECT 'link_revoked','record_id' UNION ALL SELECT 'link_revoked','revoked_link_ids' UNION ALL
        SELECT 'link_moved','source_bundle_id' UNION ALL SELECT 'link_moved','destination_bundle_id' UNION ALL
        SELECT 'link_moved','relation_types' UNION ALL SELECT 'link_moved','record_type' UNION ALL SELECT 'link_moved','record_id' UNION ALL
        SELECT 'link_moved','source_campaign_id' UNION ALL SELECT 'link_moved','destination_campaign_id' UNION ALL
        SELECT 'link_moved','revoked_link_ids' UNION ALL SELECT 'link_moved','replacement_link_ids' UNION ALL
        SELECT 'workflow_reconciliation','original_dispatch_id' UNION ALL SELECT 'workflow_reconciliation','replacement_dispatch_id' UNION ALL
        SELECT 'workflow_reconciliation','template_id' UNION ALL SELECT 'workflow_reconciliation','template_version'
      ) required
      WHERE required.event_type=NEW.event_type
        AND (SELECT count(*) FROM json_each(NEW.metadata_json) item WHERE item.key=required.key)<>1
    )
  ) THEN RAISE(ABORT,'invalid campaign event metadata keys') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.metadata_json) item
    WHERE item.key IN (
      'customer_id','opportunity_id','owner_user_id','team_id','row_version','previous_version','next_version',
      'previous_owner_user_id','next_owner_user_id','previous_team_id','next_team_id','source_campaign_id',
      'destination_campaign_id','original_dispatch_id','replacement_dispatch_id','template_id','template_version'
    ) AND (item.type<>'integer' OR item.value NOT BETWEEN 1 AND 9007199254740991)
  ) THEN RAISE(ABORT,'invalid campaign event integer metadata') END;

  SELECT CASE WHEN NEW.event_type IN ('link_attached','link_revoked','link_moved') AND (
    json_type(NEW.metadata_json,'$.record_type')<>'text'
    OR json_extract(NEW.metadata_json,'$.record_type') NOT IN (
      'demand','proposal','influencer','collaboration','ai_conversation','workflow_instance','knowledge_entry'
    )
    OR json_type(NEW.metadata_json,'$.record_id')<>'text'
    OR length(json_extract(NEW.metadata_json,'$.record_id')) NOT BETWEEN 1 AND 16
    OR json_extract(NEW.metadata_json,'$.record_id') GLOB '*[^0-9]*'
    OR json_extract(NEW.metadata_json,'$.record_id') LIKE '0%'
    OR CAST(CAST(json_extract(NEW.metadata_json,'$.record_id') AS INTEGER) AS TEXT)<>json_extract(NEW.metadata_json,'$.record_id')
    OR CAST(json_extract(NEW.metadata_json,'$.record_id') AS INTEGER) NOT BETWEEN 1 AND 9007199254740991
    OR json_type(NEW.metadata_json,'$.relation_types')<>'array'
    OR json_array_length(NEW.metadata_json,'$.relation_types')<1
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.metadata_json,'$.relation_types') item
      WHERE item.type<>'text' OR item.value NOT IN (
        'demand','proposal','ppt','shortlist','order','execution','publication','settlement',
        'ai_run','workflow','knowledge','review'
      )
    )
    OR (SELECT count(*) FROM json_each(NEW.metadata_json,'$.relation_types'))<>
       (SELECT count(DISTINCT value) FROM json_each(NEW.metadata_json,'$.relation_types'))
    OR EXISTS (
      SELECT 1 FROM (
        SELECT value,LAG(value) OVER (ORDER BY CAST(key AS INTEGER)) previous_value
        FROM json_each(NEW.metadata_json,'$.relation_types')
      ) ordered_relations
      WHERE previous_value IS NOT NULL AND previous_value>=value
    )
    OR (
      NEW.event_type IN ('link_attached','link_revoked') AND (
        json_type(NEW.metadata_json,'$.bundle_id')<>'text'
        OR length(json_extract(NEW.metadata_json,'$.bundle_id'))<>64
        OR json_extract(NEW.metadata_json,'$.bundle_id')<>lower(json_extract(NEW.metadata_json,'$.bundle_id'))
        OR json_extract(NEW.metadata_json,'$.bundle_id') GLOB '*[^0-9a-f]*'
      )
    )
    OR (
      NEW.event_type='link_moved' AND (
        json_type(NEW.metadata_json,'$.source_bundle_id')<>'text'
        OR json_type(NEW.metadata_json,'$.destination_bundle_id')<>'text'
        OR length(json_extract(NEW.metadata_json,'$.source_bundle_id'))<>64
        OR length(json_extract(NEW.metadata_json,'$.destination_bundle_id'))<>64
        OR json_extract(NEW.metadata_json,'$.source_bundle_id')<>lower(json_extract(NEW.metadata_json,'$.source_bundle_id'))
        OR json_extract(NEW.metadata_json,'$.destination_bundle_id')<>lower(json_extract(NEW.metadata_json,'$.destination_bundle_id'))
        OR json_extract(NEW.metadata_json,'$.source_bundle_id') GLOB '*[^0-9a-f]*'
        OR json_extract(NEW.metadata_json,'$.destination_bundle_id') GLOB '*[^0-9a-f]*'
      )
    )
  ) THEN RAISE(ABORT,'invalid campaign event link metadata') END;

  SELECT CASE WHEN NEW.event_type IN ('link_attached','link_revoked','link_moved') AND EXISTS (
    SELECT 1 FROM json_each(
      NEW.metadata_json,
      CASE NEW.event_type
        WHEN 'link_attached' THEN '$.link_ids'
        WHEN 'link_revoked' THEN '$.revoked_link_ids'
        ELSE '$.revoked_link_ids'
      END
    ) item
    WHERE item.type<>'integer' OR item.value NOT BETWEEN 1 AND 9007199254740991
  ) THEN RAISE(ABORT,'invalid campaign event link id metadata') END;

  SELECT CASE WHEN NEW.event_type IN ('link_attached','link_revoked') AND (
    json_array_length(
      NEW.metadata_json,
      CASE NEW.event_type WHEN 'link_attached' THEN '$.link_ids' ELSE '$.revoked_link_ids' END
    )<1
    OR (SELECT count(*) FROM json_each(
      NEW.metadata_json,
      CASE NEW.event_type WHEN 'link_attached' THEN '$.link_ids' ELSE '$.revoked_link_ids' END
    ))<>(SELECT count(DISTINCT value) FROM json_each(
      NEW.metadata_json,
      CASE NEW.event_type WHEN 'link_attached' THEN '$.link_ids' ELSE '$.revoked_link_ids' END
    ))
    OR EXISTS (
      SELECT 1 FROM (
        SELECT value,LAG(value) OVER (ORDER BY CAST(key AS INTEGER)) previous_value
        FROM json_each(
          NEW.metadata_json,
          CASE NEW.event_type WHEN 'link_attached' THEN '$.link_ids' ELSE '$.revoked_link_ids' END
        )
      ) ordered_ids
      WHERE previous_value IS NOT NULL AND previous_value>=value
    )
  ) THEN RAISE(ABORT,'invalid campaign event link id set') END;

  SELECT CASE WHEN NEW.event_type='link_moved' AND (
    json_extract(NEW.metadata_json,'$.source_campaign_id')=json_extract(NEW.metadata_json,'$.destination_campaign_id')
    OR NEW.campaign_id NOT IN (
      json_extract(NEW.metadata_json,'$.source_campaign_id'),
      json_extract(NEW.metadata_json,'$.destination_campaign_id')
    )
    OR json_extract(NEW.metadata_json,'$.source_bundle_id')=json_extract(NEW.metadata_json,'$.destination_bundle_id')
    OR json_array_length(NEW.metadata_json,'$.revoked_link_ids')<1
    OR json_array_length(NEW.metadata_json,'$.replacement_link_ids')<1
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.metadata_json,'$.replacement_link_ids') item
      WHERE item.type<>'integer' OR item.value NOT BETWEEN 1 AND 9007199254740991
    )
    OR (SELECT count(*) FROM json_each(NEW.metadata_json,'$.revoked_link_ids'))<>
       (SELECT count(DISTINCT value) FROM json_each(NEW.metadata_json,'$.revoked_link_ids'))
    OR (SELECT count(*) FROM json_each(NEW.metadata_json,'$.replacement_link_ids'))<>
       (SELECT count(DISTINCT value) FROM json_each(NEW.metadata_json,'$.replacement_link_ids'))
    OR EXISTS (
      SELECT 1 FROM (
        SELECT value,LAG(value) OVER (ORDER BY CAST(key AS INTEGER)) previous_value
        FROM json_each(NEW.metadata_json,'$.revoked_link_ids')
      ) ordered_ids WHERE previous_value IS NOT NULL AND previous_value>=value
    )
    OR EXISTS (
      SELECT 1 FROM (
        SELECT value,LAG(value) OVER (ORDER BY CAST(key AS INTEGER)) previous_value
        FROM json_each(NEW.metadata_json,'$.replacement_link_ids')
      ) ordered_ids WHERE previous_value IS NOT NULL AND previous_value>=value
    )
  ) THEN RAISE(ABORT,'invalid campaign move metadata') END;
END;
`,
  `
CREATE TABLE campaign_record_links (
  id INTEGER PRIMARY KEY CHECK(id BETWEEN 1 AND 9007199254740991),
  org_id INTEGER NOT NULL CHECK(org_id BETWEEN 1 AND 9007199254740991),
  campaign_id INTEGER NOT NULL CHECK(campaign_id BETWEEN 1 AND 9007199254740991),
  record_type TEXT NOT NULL CHECK(record_type IN (
    'demand','proposal','influencer','collaboration','ai_conversation',
    'workflow_instance','knowledge_entry'
  )),
  bundle_id TEXT NOT NULL CHECK(
    length(bundle_id)=64 AND bundle_id=lower(bundle_id)
    AND bundle_id NOT GLOB '*[^0-9a-f]*'
  ),
  record_id TEXT NOT NULL CHECK(
    length(record_id) BETWEEN 1 AND 16
    AND record_id NOT GLOB '*[^0-9]*'
    AND record_id NOT LIKE '0%'
    AND CAST(record_id AS INTEGER) BETWEEN 1 AND 9007199254740991
    AND CAST(CAST(record_id AS INTEGER) AS TEXT)=record_id
  ),
  relation_type TEXT NOT NULL CHECK(relation_type IN (
    'demand','proposal','ppt','shortlist','order','execution','publication','settlement',
    'ai_run','workflow','knowledge','review'
  )),
  created_by INTEGER NOT NULL CHECK(created_by BETWEEN 1 AND 9007199254740991),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(
    json_valid(metadata_json)
    AND json_type(metadata_json)='object'
    AND length(CAST(metadata_json AS BLOB)) <= 4096
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TEXT,
  revoked_by INTEGER CHECK(revoked_by IS NULL OR revoked_by BETWEEN 1 AND 9007199254740991),
  revoke_reason TEXT,
  CHECK(
    (revoked_at IS NULL AND revoked_by IS NULL AND revoke_reason IS NULL)
    OR
    (revoked_at IS NOT NULL AND revoked_by IS NOT NULL
      AND length(trim(revoke_reason)) BETWEEN 1 AND 1000)
  ),
  CHECK(strftime('%Y-%m-%d %H:%M:%S',created_at) IS NOT NULL AND strftime('%Y-%m-%d %H:%M:%S',created_at)=created_at),
  CHECK(revoked_at IS NULL OR (strftime('%Y-%m-%d %H:%M:%S',revoked_at) IS NOT NULL AND strftime('%Y-%m-%d %H:%M:%S',revoked_at)=revoked_at)),
  CHECK(
    (relation_type='demand' AND record_type='demand')
    OR (relation_type IN ('proposal','ppt') AND record_type='proposal')
    OR (relation_type='shortlist' AND record_type='influencer')
    OR (relation_type IN ('order','execution','publication','settlement') AND record_type='collaboration')
    OR (relation_type='ai_run' AND record_type='ai_conversation')
    OR (relation_type='workflow' AND record_type='workflow_instance')
    OR (relation_type IN ('knowledge','review') AND record_type='knowledge_entry')
  ),
  FOREIGN KEY(org_id,campaign_id) REFERENCES campaigns(org_id,id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(org_id,created_by) REFERENCES organization_memberships(org_id,user_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(org_id,revoked_by) REFERENCES organization_memberships(org_id,user_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX ux_campaign_active_relation
  ON campaign_record_links(campaign_id,record_type,record_id,relation_type)
  WHERE revoked_at IS NULL;

CREATE TRIGGER campaign_links_single_owner
BEFORE INSERT ON campaign_record_links
WHEN NEW.revoked_at IS NULL AND NEW.relation_type <> 'shortlist'
  AND EXISTS (
    SELECT 1 FROM campaign_record_links existing
    WHERE existing.record_type=NEW.record_type
      AND existing.record_id=NEW.record_id
      AND existing.relation_type <> 'shortlist'
      AND existing.revoked_at IS NULL
      AND existing.campaign_id <> NEW.campaign_id
  )
BEGIN SELECT RAISE(ABORT,'active record already belongs to another campaign'); END;

CREATE TRIGGER campaign_links_bundle_identity_insert
BEFORE INSERT ON campaign_record_links
WHEN NEW.revoked_at IS NOT NULL
  OR EXISTS (
    SELECT 1 FROM campaign_record_links existing WHERE existing.id=NEW.id
  )
  OR (
    NEW.revoked_at IS NULL
    AND EXISTS (
      SELECT 1 FROM campaign_record_links existing
      WHERE existing.campaign_id=NEW.campaign_id
        AND existing.record_type=NEW.record_type
        AND existing.record_id=NEW.record_id
        AND existing.relation_type=NEW.relation_type
        AND existing.revoked_at IS NULL
    )
  )
  OR EXISTS (
    SELECT 1 FROM campaign_record_links existing
    WHERE existing.bundle_id=NEW.bundle_id
      AND NOT (
        existing.org_id=NEW.org_id AND existing.campaign_id=NEW.campaign_id
        AND existing.record_type=NEW.record_type AND existing.record_id=NEW.record_id
      )
  )
  OR (
    EXISTS (SELECT 1 FROM campaign_record_links existing WHERE existing.bundle_id=NEW.bundle_id)
    AND NOT EXISTS (
      SELECT 1 FROM campaign_record_links existing
      WHERE existing.bundle_id=NEW.bundle_id AND existing.revoked_at IS NULL
    )
  )
  OR (
    NEW.revoked_at IS NULL
    AND EXISTS (
      SELECT 1 FROM campaign_record_links existing
      WHERE existing.org_id=NEW.org_id AND existing.campaign_id=NEW.campaign_id
        AND existing.record_type=NEW.record_type AND existing.record_id=NEW.record_id
        AND existing.revoked_at IS NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM campaign_record_links existing
      WHERE existing.org_id=NEW.org_id AND existing.campaign_id=NEW.campaign_id
        AND existing.record_type=NEW.record_type AND existing.record_id=NEW.record_id
        AND existing.bundle_id=NEW.bundle_id AND existing.revoked_at IS NULL
    )
  )
  OR (
    NEW.record_type='collaboration' AND NEW.revoked_at IS NULL
    AND (
      NOT EXISTS (
        SELECT 1 FROM collaborations collaboration
        WHERE collaboration.id=CAST(NEW.record_id AS INTEGER)
      )
      OR EXISTS (
        SELECT 1 FROM collaborations collaboration
        WHERE collaboration.id=CAST(NEW.record_id AS INTEGER)
          AND collaboration.status='cancelled'
      )
      OR (
        NEW.relation_type='publication'
        AND (
          NOT EXISTS (
            SELECT 1 FROM collaborations collaboration
            WHERE collaboration.id=CAST(NEW.record_id AS INTEGER)
              AND collaboration.status='completed'
          )
          OR NOT EXISTS (
            SELECT 1 FROM campaign_record_links link
            WHERE link.org_id=NEW.org_id AND link.campaign_id=NEW.campaign_id
              AND link.record_type='collaboration' AND link.record_id=NEW.record_id
              AND link.relation_type='order' AND link.revoked_at IS NULL
          )
          OR NOT EXISTS (
            SELECT 1 FROM campaign_record_links link
            WHERE link.org_id=NEW.org_id AND link.campaign_id=NEW.campaign_id
              AND link.record_type='collaboration' AND link.record_id=NEW.record_id
              AND link.relation_type='execution' AND link.revoked_at IS NULL
          )
        )
      )
      OR (
        NEW.relation_type='settlement'
        AND (
          NOT EXISTS (
            SELECT 1 FROM collaborations collaboration
            WHERE collaboration.id=CAST(NEW.record_id AS INTEGER)
              AND collaboration.status='completed'
              AND typeof(collaboration.cost_actual_confirmed)='integer'
              AND collaboration.cost_actual_confirmed=1
          )
          OR NOT EXISTS (
            SELECT 1 FROM campaign_record_links link
            WHERE link.org_id=NEW.org_id AND link.campaign_id=NEW.campaign_id
              AND link.record_type='collaboration' AND link.record_id=NEW.record_id
              AND link.relation_type='publication' AND link.revoked_at IS NULL
          )
        )
      )
    )
  )
BEGIN SELECT RAISE(ABORT,'campaign link bundle identity is invalid'); END;

CREATE TRIGGER campaign_links_no_delete
BEFORE DELETE ON campaign_record_links
BEGIN SELECT RAISE(ABORT,'campaign links cannot be deleted'); END;

CREATE TRIGGER campaign_links_update_only_revoke
BEFORE UPDATE ON campaign_record_links
WHEN NOT (
  OLD.org_id=NEW.org_id AND OLD.campaign_id=NEW.campaign_id
  AND OLD.record_type=NEW.record_type AND OLD.bundle_id=NEW.bundle_id
  AND OLD.record_id=NEW.record_id
  AND OLD.relation_type=NEW.relation_type AND OLD.created_by=NEW.created_by
  AND OLD.metadata_json=NEW.metadata_json AND OLD.created_at=NEW.created_at
  AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
  AND NEW.revoked_by IS NOT NULL AND length(trim(NEW.revoke_reason)) BETWEEN 1 AND 1000
)
OR (
  OLD.record_type='collaboration'
  AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
  AND (
    (
      OLD.relation_type IN ('order','execution')
      AND EXISTS (
        SELECT 1 FROM campaign_record_links dependent
        WHERE dependent.org_id=OLD.org_id AND dependent.campaign_id=OLD.campaign_id
          AND dependent.record_type=OLD.record_type AND dependent.record_id=OLD.record_id
          AND dependent.relation_type='publication' AND dependent.revoked_at IS NULL
      )
    )
    OR (
      OLD.relation_type='publication'
      AND EXISTS (
        SELECT 1 FROM campaign_record_links dependent
        WHERE dependent.org_id=OLD.org_id AND dependent.campaign_id=OLD.campaign_id
          AND dependent.record_type=OLD.record_type AND dependent.record_id=OLD.record_id
          AND dependent.relation_type='settlement' AND dependent.revoked_at IS NULL
      )
    )
  )
)
BEGIN
  SELECT CASE WHEN NOT (
    OLD.org_id=NEW.org_id AND OLD.campaign_id=NEW.campaign_id
    AND OLD.record_type=NEW.record_type AND OLD.bundle_id=NEW.bundle_id
    AND OLD.record_id=NEW.record_id
    AND OLD.relation_type=NEW.relation_type AND OLD.created_by=NEW.created_by
    AND OLD.metadata_json=NEW.metadata_json AND OLD.created_at=NEW.created_at
    AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
    AND NEW.revoked_by IS NOT NULL AND length(trim(NEW.revoke_reason)) BETWEEN 1 AND 1000
  ) THEN RAISE(ABORT,'campaign links are immutable except revocation') END;
  SELECT CASE WHEN OLD.record_type='collaboration'
    AND OLD.relation_type IN ('order','execution')
    AND EXISTS (
      SELECT 1 FROM campaign_record_links dependent
      WHERE dependent.org_id=OLD.org_id AND dependent.campaign_id=OLD.campaign_id
        AND dependent.record_type=OLD.record_type AND dependent.record_id=OLD.record_id
        AND dependent.relation_type='publication' AND dependent.revoked_at IS NULL
    )
    THEN RAISE(ABORT,'active publication dependencies must be revoked downstream first') END;
  SELECT CASE WHEN OLD.record_type='collaboration'
    AND OLD.relation_type='publication'
    AND EXISTS (
      SELECT 1 FROM campaign_record_links dependent
      WHERE dependent.org_id=OLD.org_id AND dependent.campaign_id=OLD.campaign_id
        AND dependent.record_type=OLD.record_type AND dependent.record_id=OLD.record_id
        AND dependent.relation_type='settlement' AND dependent.revoked_at IS NULL
    )
    THEN RAISE(ABORT,'active settlement dependency must be revoked first') END;
END;

CREATE TRIGGER campaign_review_link_identity_insert
BEFORE INSERT ON campaign_record_links
WHEN (
  NEW.relation_type='review' AND NOT EXISTS (
    SELECT 1 FROM knowledge_entries entry
    WHERE entry.id=CAST(NEW.record_id AS INTEGER)
      AND entry.entry_type='campaign_review' AND entry.source_type='campaign_review'
      AND entry.business_type='campaign'
      AND entry.business_id=CAST(NEW.campaign_id AS TEXT)
      AND json_type(NEW.metadata_json,'$.settled_event_id')='integer'
      AND (SELECT count(*) FROM json_each(NEW.metadata_json))=1
      AND json_extract(NEW.metadata_json,'$.settled_event_id') BETWEEN 1 AND 9007199254740991
      AND entry.source_id=CAST(NEW.campaign_id AS TEXT)||':'||
        CAST(json_extract(NEW.metadata_json,'$.settled_event_id') AS TEXT)
  )
) OR (
  NEW.record_type='knowledge_entry' AND NEW.relation_type IN ('knowledge','review')
  AND EXISTS (
    SELECT 1 FROM knowledge_entries entry
    WHERE entry.id=CAST(NEW.record_id AS INTEGER)
      AND entry.source_type='campaign_review'
      AND (entry.business_type<>'campaign'
        OR entry.business_id<>CAST(NEW.campaign_id AS TEXT))
  )
)
BEGIN SELECT RAISE(ABORT,'campaign review evidence cannot move across campaigns'); END;

CREATE TRIGGER campaign_settled_collaboration_cost_guard
BEFORE UPDATE OF status,cost_actual,cost_actual_confirmed ON collaborations
WHEN (
  NEW.status='cancelled' AND EXISTS (
    SELECT 1 FROM campaign_record_links link
    WHERE link.record_type='collaboration'
      AND link.record_id=CAST(OLD.id AS TEXT)
      AND link.relation_type IN ('order','execution','publication','settlement')
      AND link.revoked_at IS NULL
  )
) OR (
  NEW.status IS NOT 'completed' AND EXISTS (
    SELECT 1 FROM campaign_record_links link
    WHERE link.record_type='collaboration'
      AND link.record_id=CAST(OLD.id AS TEXT)
      AND link.relation_type IN ('publication','settlement')
      AND link.revoked_at IS NULL
  )
) OR (
  NEW.cost_actual_confirmed<>1 AND EXISTS (
    SELECT 1 FROM campaign_record_links link
    WHERE link.record_type='collaboration'
      AND link.record_id=CAST(OLD.id AS TEXT)
      AND link.relation_type='settlement' AND link.revoked_at IS NULL
  )
)
BEGIN
  SELECT CASE WHEN NEW.status='cancelled' AND EXISTS (
    SELECT 1 FROM campaign_record_links link
    WHERE link.record_type='collaboration'
      AND link.record_id=CAST(OLD.id AS TEXT)
      AND link.relation_type IN ('order','execution','publication','settlement')
      AND link.revoked_at IS NULL
  ) THEN RAISE(ABORT,'cancelled collaboration cannot retain active campaign aliases') END;
  SELECT CASE WHEN NEW.status IS NOT 'completed' AND EXISTS (
    SELECT 1 FROM campaign_record_links link
    WHERE link.record_type='collaboration'
      AND link.record_id=CAST(OLD.id AS TEXT)
      AND link.relation_type IN ('publication','settlement')
      AND link.revoked_at IS NULL
  ) THEN RAISE(ABORT,'published or settled collaboration must remain completed') END;
  SELECT CASE WHEN NEW.cost_actual_confirmed<>1 AND EXISTS (
    SELECT 1 FROM campaign_record_links link
    WHERE link.record_type='collaboration'
      AND link.record_id=CAST(OLD.id AS TEXT)
      AND link.relation_type='settlement' AND link.revoked_at IS NULL
  ) THEN RAISE(ABORT,'settled campaign collaboration cost must remain confirmed') END;
END;

CREATE TRIGGER campaign_settled_collaboration_no_replace_insert
BEFORE INSERT ON collaborations
WHEN EXISTS (
  SELECT 1
  FROM collaborations existing
  JOIN campaign_record_links link
    ON link.record_type='collaboration'
    AND link.record_id=CAST(existing.id AS TEXT)
    AND link.relation_type IN ('order','execution','publication','settlement')
    AND link.revoked_at IS NULL
  WHERE existing.id=NEW.id
)
BEGIN SELECT RAISE(ABORT,'campaign collaboration cannot be replaced'); END;

CREATE TRIGGER campaign_knowledge_entry_content_immutable
BEFORE UPDATE OF entry_type,source_type,source_id,key_terms,content,is_public,title,summary,
  tags_json,visibility,source_hash,business_type,business_id,metadata_json,
  source_identity_sha256,content_sha256
ON knowledge_entries
WHEN EXISTS (
  SELECT 1 FROM campaign_record_links link
  WHERE link.record_type='knowledge_entry'
    AND link.record_id=CAST(OLD.id AS TEXT)
) AND NOT (
  NEW.entry_type IS OLD.entry_type AND NEW.source_type IS OLD.source_type
  AND NEW.source_id IS OLD.source_id AND NEW.key_terms IS OLD.key_terms
  AND NEW.content IS OLD.content AND NEW.is_public IS OLD.is_public
  AND NEW.title IS OLD.title AND NEW.summary IS OLD.summary
  AND NEW.tags_json IS OLD.tags_json AND NEW.visibility IS OLD.visibility
  AND NEW.source_hash IS OLD.source_hash AND NEW.business_type IS OLD.business_type
  AND NEW.business_id IS OLD.business_id AND NEW.metadata_json IS OLD.metadata_json
  AND NEW.source_identity_sha256 IS OLD.source_identity_sha256
  AND NEW.content_sha256 IS OLD.content_sha256
)
BEGIN SELECT RAISE(ABORT,'campaign knowledge content is immutable'); END;

CREATE TRIGGER knowledge_entries_no_replace_insert
BEFORE INSERT ON knowledge_entries
WHEN EXISTS (
  SELECT 1
  FROM knowledge_entries existing
  WHERE existing.id=NEW.id
    OR (
      NEW.source_hash IS NOT NULL AND NEW.source_hash<>''
      AND existing.source_hash=NEW.source_hash
    )
    OR (
      NEW.source_identity_sha256 IS NOT NULL
      AND existing.source_identity_sha256=NEW.source_identity_sha256
    )
    OR (
      NEW.source_type='campaign_review'
      AND existing.source_type='campaign_review'
      AND CAST(existing.source_id AS TEXT)=CAST(NEW.source_id AS TEXT)
    )
)
BEGIN SELECT RAISE(ABORT,'knowledge entry cannot be replaced'); END;

CREATE TRIGGER campaign_knowledge_entry_no_delete
BEFORE DELETE ON knowledge_entries
WHEN EXISTS (
  SELECT 1 FROM campaign_record_links link
  WHERE link.record_type='knowledge_entry' AND link.record_id=CAST(OLD.id AS TEXT)
)
BEGIN SELECT RAISE(ABORT,'campaign knowledge entry cannot be deleted'); END;

CREATE TRIGGER campaign_knowledge_chunk_no_insert
BEFORE INSERT ON knowledge_chunks
WHEN EXISTS (
  SELECT 1 FROM campaign_record_links link
  WHERE link.record_type='knowledge_entry' AND link.record_id=CAST(NEW.entry_id AS TEXT)
)
OR EXISTS (
  SELECT 1
  FROM knowledge_chunks existing
  WHERE existing.id=NEW.id
    OR (existing.entry_id=NEW.entry_id AND existing.chunk_index=NEW.chunk_index)
)
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM knowledge_chunks existing
    WHERE existing.id=NEW.id
      OR (existing.entry_id=NEW.entry_id AND existing.chunk_index=NEW.chunk_index)
  ) THEN RAISE(ABORT,'knowledge chunk cannot be replaced') END;
  SELECT RAISE(ABORT,'campaign knowledge chunk cannot be appended');
END;

CREATE TRIGGER campaign_knowledge_chunk_content_immutable
BEFORE UPDATE OF entry_id,chunk_index,content,metadata_json,token_count,created_at,content_sha256
ON knowledge_chunks
WHEN (
  EXISTS (
    SELECT 1 FROM campaign_record_links link
    WHERE link.record_type='knowledge_entry' AND link.record_id=CAST(OLD.entry_id AS TEXT)
  )
  OR EXISTS (
    SELECT 1 FROM campaign_record_links link
    WHERE link.record_type='knowledge_entry' AND link.record_id=CAST(NEW.entry_id AS TEXT)
  )
) AND NOT (
  NEW.entry_id IS OLD.entry_id AND NEW.chunk_index IS OLD.chunk_index
  AND NEW.content IS OLD.content AND NEW.metadata_json IS OLD.metadata_json
  AND NEW.token_count IS OLD.token_count AND NEW.created_at IS OLD.created_at
  AND NEW.content_sha256 IS OLD.content_sha256
)
BEGIN SELECT RAISE(ABORT,'campaign knowledge chunk is immutable'); END;

CREATE TRIGGER campaign_knowledge_chunk_no_delete
BEFORE DELETE ON knowledge_chunks
WHEN EXISTS (
  SELECT 1 FROM campaign_record_links link
  WHERE link.record_type='knowledge_entry' AND link.record_id=CAST(OLD.entry_id AS TEXT)
)
BEGIN SELECT RAISE(ABORT,'campaign knowledge chunk cannot be deleted'); END;
`,
  `
ALTER TABLE workflow_templates ADD COLUMN trigger_config_json TEXT
  CHECK(trigger_config_json IS NULL OR (
    typeof(trigger_config_json)='text' AND json_valid(trigger_config_json)
  ));

ALTER TABLE workflow_instances ADD COLUMN org_id INTEGER
  CHECK(org_id IS NULL OR typeof(org_id)='integer');
ALTER TABLE workflow_instances ADD COLUMN campaign_id INTEGER
  CHECK(campaign_id IS NULL OR typeof(campaign_id)='integer');
ALTER TABLE workflow_instances ADD COLUMN campaign_event_id INTEGER
  CHECK(campaign_event_id IS NULL OR typeof(campaign_event_id)='integer');
ALTER TABLE workflow_instances ADD COLUMN campaign_dispatch_id INTEGER
  CHECK(campaign_dispatch_id IS NULL OR typeof(campaign_dispatch_id)='integer');
ALTER TABLE workflow_instances ADD COLUMN initialization_status TEXT
  CHECK(initialization_status IS NULL OR initialization_status IN ('pending','ready','failed'));
ALTER TABLE workflow_instances ADD COLUMN initialization_error TEXT
  CHECK(initialization_error IS NULL OR length(initialization_error) <= 2000);
ALTER TABLE workflow_instances ADD COLUMN execution_error_code TEXT
  CHECK(execution_error_code IS NULL OR length(execution_error_code) <= 120);
ALTER TABLE workflow_instances ADD COLUMN execution_error TEXT
  CHECK(execution_error IS NULL OR length(execution_error) <= 2000);
ALTER TABLE workflow_instances ADD COLUMN execution_failed_at TEXT
  CHECK(execution_failed_at IS NULL OR (
    strftime('%Y-%m-%d %H:%M:%S',execution_failed_at) IS NOT NULL
    AND strftime('%Y-%m-%d %H:%M:%S',execution_failed_at)=execution_failed_at
  ));

ALTER TABLE workflow_tasks ADD COLUMN assignment_version INTEGER NOT NULL DEFAULT 1
  CHECK(typeof(assignment_version)='integer'
    AND assignment_version BETWEEN 1 AND 9007199254740991);

CREATE UNIQUE INDEX ux_workflow_instances_campaign_dispatch
  ON workflow_instances(campaign_dispatch_id)
  WHERE campaign_dispatch_id IS NOT NULL;

CREATE UNIQUE INDEX ux_workflow_instances_org_campaign_id
  ON workflow_instances(org_id,campaign_id,id);

CREATE TABLE campaign_workflow_dispatches (
  id INTEGER PRIMARY KEY CHECK(id BETWEEN 1 AND 9007199254740991),
  org_id INTEGER NOT NULL CHECK(org_id BETWEEN 1 AND 9007199254740991),
  campaign_id INTEGER NOT NULL CHECK(campaign_id BETWEEN 1 AND 9007199254740991),
  event_id INTEGER NOT NULL CHECK(event_id BETWEEN 1 AND 9007199254740991),
  trigger_event_id INTEGER NOT NULL CHECK(trigger_event_id BETWEEN 1 AND 9007199254740991),
  template_id INTEGER NOT NULL CHECK(template_id BETWEEN 1 AND 9007199254740991),
  template_version INTEGER NOT NULL CHECK(template_version BETWEEN 1 AND 9007199254740991),
  template_checksum TEXT NOT NULL CHECK(
    length(template_checksum)=64 AND template_checksum=lower(template_checksum)
    AND template_checksum NOT GLOB '*[^0-9a-f]*'
  ),
  template_snapshot_json TEXT NOT NULL CHECK(json_valid(template_snapshot_json)),
  execution_context_json TEXT NOT NULL CHECK(
    json_valid(execution_context_json) AND json_type(execution_context_json)='object'
    AND length(CAST(execution_context_json AS BLOB)) <= 2048
  ),
  workflow_instance_id INTEGER CHECK(workflow_instance_id IS NULL OR workflow_instance_id BETWEEN 1 AND 9007199254740991),
  reconciles_dispatch_id INTEGER CHECK(reconciles_dispatch_id IS NULL OR reconciles_dispatch_id BETWEEN 1 AND 9007199254740991),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (
    'pending','processing','completed','failed_validation',
    'failed_initialization','dead_letter','cancelled'
  )),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 5),
  lease_until TEXT,
  lease_token TEXT CHECK(lease_token IS NULL OR length(lease_token) BETWEEN 16 AND 120),
  next_attempt_at TEXT,
  last_error_code TEXT CHECK(last_error_code IS NULL OR length(last_error_code) <= 120),
  last_error TEXT CHECK(last_error IS NULL OR length(last_error) <= 2000),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(event_id,template_id),
  UNIQUE(reconciles_dispatch_id),
  CHECK(reconciles_dispatch_id IS NULL OR reconciles_dispatch_id<>id),
  CHECK(
    (reconciles_dispatch_id IS NULL AND trigger_event_id=event_id)
    OR (reconciles_dispatch_id IS NOT NULL AND trigger_event_id<>event_id)
  ),
  CHECK(
    (status='processing' AND lease_until IS NOT NULL AND lease_token IS NOT NULL)
    OR (status<>'processing' AND lease_until IS NULL AND lease_token IS NULL)
  ),
  CHECK(lease_until IS NULL OR (strftime('%Y-%m-%d %H:%M:%S',lease_until) IS NOT NULL AND strftime('%Y-%m-%d %H:%M:%S',lease_until)=lease_until)),
  CHECK(next_attempt_at IS NULL OR (strftime('%Y-%m-%d %H:%M:%S',next_attempt_at) IS NOT NULL AND strftime('%Y-%m-%d %H:%M:%S',next_attempt_at)=next_attempt_at)),
  CHECK(strftime('%Y-%m-%d %H:%M:%S',created_at) IS NOT NULL AND strftime('%Y-%m-%d %H:%M:%S',created_at)=created_at),
  CHECK(strftime('%Y-%m-%d %H:%M:%S',updated_at) IS NOT NULL AND strftime('%Y-%m-%d %H:%M:%S',updated_at)=updated_at),
  CHECK((status='completed') = (workflow_instance_id IS NOT NULL)),
  CHECK(
    (status IN ('failed_validation','failed_initialization','dead_letter','cancelled')
      AND last_error_code IS NOT NULL AND last_error IS NOT NULL)
    OR (status NOT IN ('failed_validation','failed_initialization','dead_letter','cancelled')
      AND last_error_code IS NULL AND last_error IS NULL)
  ),
  CHECK(
    (status='failed_initialization' AND next_attempt_at IS NOT NULL)
    OR (status<>'failed_initialization' AND next_attempt_at IS NULL)
  ),
  CHECK(
    (status='pending' AND attempt_count=0)
    OR (status IN ('processing','completed','failed_validation','failed_initialization')
      AND attempt_count BETWEEN 1 AND 5)
    OR (status='dead_letter' AND attempt_count=5)
    OR (status='cancelled' AND attempt_count BETWEEN 0 AND 5)
  ),
  FOREIGN KEY(org_id,campaign_id) REFERENCES campaigns(org_id,id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(org_id,campaign_id,event_id) REFERENCES campaign_events(org_id,campaign_id,id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(org_id,campaign_id,trigger_event_id) REFERENCES campaign_events(org_id,campaign_id,id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(template_id) REFERENCES workflow_templates(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(reconciles_dispatch_id) REFERENCES campaign_workflow_dispatches(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(org_id,campaign_id,workflow_instance_id)
    REFERENCES workflow_instances(org_id,campaign_id,id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER campaign_workflow_dispatches_reconciliation_lineage_insert
BEFORE INSERT ON campaign_workflow_dispatches
WHEN NEW.reconciles_dispatch_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM campaign_workflow_dispatches prior
    WHERE prior.id=NEW.reconciles_dispatch_id
      AND prior.org_id=NEW.org_id
      AND prior.campaign_id=NEW.campaign_id
      AND prior.trigger_event_id=NEW.trigger_event_id
      AND prior.execution_context_json=NEW.execution_context_json
      AND EXISTS (
        SELECT 1 FROM campaign_events audit_event
        WHERE audit_event.id=NEW.event_id
          AND audit_event.org_id=NEW.org_id
          AND audit_event.campaign_id=NEW.campaign_id
          AND audit_event.event_type='workflow_reconciliation'
          AND json_extract(audit_event.metadata_json,'$.original_dispatch_id')=prior.id
          AND json_extract(audit_event.metadata_json,'$.replacement_dispatch_id')=NEW.id
          AND json_extract(audit_event.metadata_json,'$.template_id')=NEW.template_id
          AND json_extract(audit_event.metadata_json,'$.template_version')=NEW.template_version
      )
      AND (
        prior.status='failed_validation'
        OR (
          prior.status='completed'
          AND EXISTS (
            SELECT 1 FROM workflow_instances failed_instance
            WHERE failed_instance.id=prior.workflow_instance_id
              AND failed_instance.org_id=prior.org_id
              AND failed_instance.campaign_id=prior.campaign_id
              AND failed_instance.status='failed_validation'
          )
        )
      )
  ) THEN RAISE(ABORT,'invalid campaign workflow reconciliation lineage') END;
END;

CREATE TRIGGER campaign_workflow_dispatches_initial_state_insert
BEFORE INSERT ON campaign_workflow_dispatches
WHEN EXISTS (
    SELECT 1 FROM campaign_workflow_dispatches existing
    WHERE existing.id=NEW.id
      OR (existing.event_id=NEW.event_id AND existing.template_id=NEW.template_id)
      OR (
        NEW.reconciles_dispatch_id IS NOT NULL
        AND existing.reconciles_dispatch_id=NEW.reconciles_dispatch_id
      )
  )
  OR NEW.status<>'pending' OR NEW.attempt_count<>0
  OR NEW.lease_until IS NOT NULL OR NEW.lease_token IS NOT NULL
  OR NEW.workflow_instance_id IS NOT NULL OR NEW.next_attempt_at IS NOT NULL
  OR NEW.last_error_code IS NOT NULL OR NEW.last_error IS NOT NULL
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM campaign_workflow_dispatches existing
    WHERE existing.id=NEW.id
      OR (existing.event_id=NEW.event_id AND existing.template_id=NEW.template_id)
      OR (
        NEW.reconciles_dispatch_id IS NOT NULL
        AND existing.reconciles_dispatch_id=NEW.reconciles_dispatch_id
      )
  ) THEN RAISE(ABORT,'campaign workflow dispatches cannot be replaced') END;
  SELECT RAISE(ABORT,'campaign workflow dispatch must start pending');
END;

CREATE TABLE request_idempotency (
  id INTEGER PRIMARY KEY CHECK(id BETWEEN 1 AND 9007199254740991),
  org_id INTEGER NOT NULL CHECK(org_id BETWEEN 1 AND 9007199254740991),
  user_id INTEGER NOT NULL CHECK(user_id BETWEEN 1 AND 9007199254740991),
  campaign_id INTEGER CHECK(campaign_id IS NULL OR campaign_id BETWEEN 1 AND 9007199254740991),
  secondary_campaign_id INTEGER CHECK(secondary_campaign_id IS NULL OR secondary_campaign_id BETWEEN 1 AND 9007199254740991),
  resource_claim TEXT CHECK(resource_claim IS NULL OR (
    length(resource_claim)=64 AND resource_claim=lower(resource_claim)
    AND resource_claim NOT GLOB '*[^0-9a-f]*'
  )),
  scope TEXT NOT NULL CHECK(length(trim(scope)) BETWEEN 1 AND 120),
  idempotency_key TEXT NOT NULL CHECK(
    length(idempotency_key) BETWEEN 8 AND 200
    AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  reservation_nonce TEXT NOT NULL CHECK(
    length(reservation_nonce)=64 AND reservation_nonce=lower(reservation_nonce)
    AND reservation_nonce NOT GLOB '*[^0-9a-f]*'
  ),
  request_hash TEXT NOT NULL CHECK(
    length(request_hash)=64 AND request_hash=lower(request_hash)
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  audit_fingerprint TEXT NOT NULL CHECK(
    length(audit_fingerprint)=64 AND audit_fingerprint=lower(audit_fingerprint)
    AND audit_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  expected_event_count INTEGER NOT NULL CHECK(
    typeof(expected_event_count)='integer' AND expected_event_count BETWEEN 0 AND 2
  ),
  state TEXT NOT NULL CHECK(state IN ('processing','completed','failed','expiring')),
  lease_until TEXT,
  lease_token TEXT CHECK(lease_token IS NULL OR length(lease_token) BETWEEN 16 AND 120),
  status_code INTEGER CHECK(status_code IS NULL OR status_code BETWEEN 100 AND 599),
  response_kind TEXT CHECK(response_kind IS NULL OR response_kind IN ('json','binary','admission')),
  response_json TEXT CHECK(response_json IS NULL OR (
    json_valid(response_json) AND length(CAST(response_json AS BLOB)) <= 1048576
  )),
  response_headers_json TEXT CHECK(
    response_headers_json IS NULL OR (
      json_valid(response_headers_json) AND json_type(response_headers_json)='object'
      AND length(CAST(response_headers_json AS BLOB)) <= 4096
    )
  ),
  response_cache_key TEXT CHECK(response_cache_key IS NULL OR (
    length(response_cache_key)=64 AND response_cache_key=lower(response_cache_key)
    AND response_cache_key NOT GLOB '*[^0-9a-f]*'
  )),
  response_sha256 TEXT CHECK(response_sha256 IS NULL OR (
    length(response_sha256)=64 AND response_sha256=lower(response_sha256)
    AND response_sha256 NOT GLOB '*[^0-9a-f]*'
  )),
  response_bytes INTEGER CHECK(response_bytes IS NULL OR (
    typeof(response_bytes)='integer' AND response_bytes BETWEEN 0 AND 67108864
  )),
  response_content_type TEXT CHECK(
    response_content_type IS NULL OR
    response_content_type='application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ),
  response_filename TEXT CHECK(response_filename IS NULL OR (
    length(trim(response_filename)) BETWEEN 1 AND 180
    AND length(CAST(response_filename AS BLOB)) <= 180
    AND instr(response_filename,'/')=0 AND instr(response_filename,char(92))=0
    AND instr(response_filename,char(0))=0 AND instr(response_filename,char(9))=0
    AND instr(response_filename,char(10))=0 AND instr(response_filename,char(13))=0
    AND response_filename NOT IN ('.','..')
  )),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  operation_deadline TEXT NOT NULL,
  expires_at TEXT,
  UNIQUE(org_id,user_id,scope,idempotency_key),
  UNIQUE(org_id,user_id,audit_fingerprint),
  CHECK(
    (state='processing' AND lease_until IS NOT NULL AND lease_token IS NOT NULL AND expires_at IS NULL
      AND status_code IS NULL AND response_kind IS NULL AND response_json IS NULL
      AND response_headers_json IS NULL AND response_cache_key IS NULL
      AND response_sha256 IS NULL AND response_bytes IS NULL
      AND response_content_type IS NULL AND response_filename IS NULL)
    OR (state='completed' AND lease_until IS NULL AND lease_token IS NULL AND expires_at IS NOT NULL
      AND (status_code BETWEEN 200 AND 299 OR status_code BETWEEN 400 AND 599)
      AND response_kind='json' AND response_json IS NOT NULL
      AND response_headers_json IS NOT NULL AND response_cache_key IS NULL
      AND response_sha256 IS NULL AND response_bytes IS NULL
      AND response_content_type IS NULL AND response_filename IS NULL)
    OR (state='completed' AND lease_until IS NULL AND lease_token IS NULL AND expires_at IS NOT NULL
      AND status_code=200 AND response_kind='binary' AND response_json IS NULL
      AND response_headers_json IS NOT NULL AND response_cache_key IS NOT NULL
      AND response_sha256 IS NOT NULL AND response_bytes IS NOT NULL
      AND response_content_type IS NOT NULL AND response_filename IS NOT NULL)
    OR (state='completed' AND lease_until IS NULL AND lease_token IS NULL AND expires_at IS NOT NULL
      AND status_code=200 AND response_kind='admission' AND response_json IS NULL
      AND response_headers_json IS NULL AND response_cache_key IS NULL
      AND response_sha256 IS NULL AND response_bytes IS NULL
      AND response_content_type IS NULL AND response_filename IS NULL)
    OR (state='failed' AND lease_until IS NULL AND lease_token IS NULL AND expires_at IS NOT NULL
      AND status_code IS NULL AND response_kind IS NULL AND response_json IS NULL
      AND response_headers_json IS NULL AND response_cache_key IS NULL
      AND response_sha256 IS NULL AND response_bytes IS NULL
      AND response_content_type IS NULL AND response_filename IS NULL)
    OR (state='expiring' AND lease_until IS NULL AND lease_token IS NULL AND expires_at IS NOT NULL
      AND status_code=200 AND response_kind='binary' AND response_json IS NULL
      AND response_headers_json IS NOT NULL AND response_cache_key IS NOT NULL
      AND response_sha256 IS NOT NULL AND response_bytes IS NOT NULL
      AND response_content_type IS NOT NULL AND response_filename IS NOT NULL)
  ),
  CHECK(lease_until IS NULL OR (strftime('%Y-%m-%d %H:%M:%S',lease_until) IS NOT NULL AND strftime('%Y-%m-%d %H:%M:%S',lease_until)=lease_until)),
  CHECK(strftime('%Y-%m-%d %H:%M:%S',created_at) IS NOT NULL AND strftime('%Y-%m-%d %H:%M:%S',created_at)=created_at),
  CHECK(strftime('%Y-%m-%d %H:%M:%S',updated_at) IS NOT NULL AND strftime('%Y-%m-%d %H:%M:%S',updated_at)=updated_at),
  CHECK(strftime('%Y-%m-%d %H:%M:%S',operation_deadline) IS NOT NULL AND strftime('%Y-%m-%d %H:%M:%S',operation_deadline)=operation_deadline AND julianday(operation_deadline) > julianday(created_at)),
  CHECK(expires_at IS NULL OR (
    strftime('%Y-%m-%d %H:%M:%S',expires_at) IS NOT NULL
    AND strftime('%Y-%m-%d %H:%M:%S',expires_at)=expires_at
    AND (
      (state IN ('completed','failed') AND julianday(expires_at)>julianday(updated_at))
      OR (state='expiring' AND julianday(expires_at)<=julianday(updated_at))
    )
  )),
  CHECK(
    (scope IN (
      'workflow.campaign-template.create','workflow.campaign-template.graph',
      'workflow.campaign-template.trigger','workflow.campaign-template.publish',
      'proposal.ppt.generate.unlinked.admission',
      'parser.knowledge-upload.admission','parser.influencer-upload.admission',
      'parser.demand-parse.admission'
    ) AND campaign_id IS NULL)
    OR
    (scope NOT IN (
      'workflow.campaign-template.create','workflow.campaign-template.graph',
      'workflow.campaign-template.trigger','workflow.campaign-template.publish',
      'proposal.ppt.generate.unlinked.admission',
      'parser.knowledge-upload.admission','parser.influencer-upload.admission',
      'parser.demand-parse.admission'
    ) AND campaign_id IS NOT NULL)
  ),
  CHECK(
    (scope='proposal.ppt.generate.linked' AND resource_claim IS NOT NULL)
    OR (scope<>'proposal.ppt.generate.linked' AND resource_claim IS NULL)
  ),
  CHECK(
    (scope='campaign.link.correct'
      AND (secondary_campaign_id IS NULL OR secondary_campaign_id<>campaign_id))
    OR (scope<>'campaign.link.correct' AND secondary_campaign_id IS NULL)
  ),
  CHECK(
    (scope='campaign.link.correct' AND secondary_campaign_id IS NOT NULL
      AND expected_event_count=2)
    OR (scope='campaign.link.correct' AND secondary_campaign_id IS NULL
      AND expected_event_count=1)
    OR (scope='collaboration.update.linked' AND secondary_campaign_id IS NULL
      AND expected_event_count IN (0,1))
    OR (scope IN (
        'campaign.create','campaign.transition','campaign.operational','campaign.transfer',
        'campaign.link.attach','campaign.review.create','campaign.workflow.reconcile',
        'demand.create.linked','proposal.create.linked','proposal.ppt.generate.linked',
        'collaboration.create.linked','knowledge.create.linked','knowledge.ingest.linked',
        'knowledge.upload.linked','ai.conversation.create.linked'
      ) AND secondary_campaign_id IS NULL AND expected_event_count=1)
    OR (scope NOT IN (
        'campaign.create','campaign.transition','campaign.operational','campaign.transfer',
        'campaign.link.attach','campaign.link.correct','campaign.review.create',
        'campaign.workflow.reconcile','demand.create.linked','proposal.create.linked',
        'proposal.ppt.generate.linked','collaboration.create.linked',
        'collaboration.update.linked','knowledge.create.linked','knowledge.ingest.linked',
        'knowledge.upload.linked','ai.conversation.create.linked'
      ) AND secondary_campaign_id IS NULL AND expected_event_count=0)
  ),
  FOREIGN KEY(org_id,user_id) REFERENCES organization_memberships(org_id,user_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(org_id,campaign_id) REFERENCES campaigns(org_id,id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY(org_id,secondary_campaign_id) REFERENCES campaigns(org_id,id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX ux_request_active_resource_claim
  ON request_idempotency(org_id,scope,resource_claim)
  WHERE resource_claim IS NOT NULL AND (
    state='processing' OR (state IN ('completed','expiring') AND response_kind='binary')
  );

CREATE TRIGGER request_idempotency_immutable_identity
BEFORE UPDATE OF org_id,user_id,campaign_id,secondary_campaign_id,resource_claim,scope,idempotency_key,
  reservation_nonce,request_hash,audit_fingerprint,expected_event_count,created_at,operation_deadline
ON request_idempotency
WHEN NOT (
  NEW.org_id IS OLD.org_id AND NEW.user_id IS OLD.user_id
  AND NEW.campaign_id IS OLD.campaign_id AND NEW.scope IS OLD.scope
  AND NEW.secondary_campaign_id IS OLD.secondary_campaign_id
  AND NEW.resource_claim IS OLD.resource_claim
  AND NEW.idempotency_key IS OLD.idempotency_key
  AND NEW.reservation_nonce IS OLD.reservation_nonce
  AND NEW.request_hash IS OLD.request_hash
  AND NEW.audit_fingerprint IS OLD.audit_fingerprint
  AND NEW.expected_event_count IS OLD.expected_event_count
  AND NEW.created_at IS OLD.created_at AND NEW.operation_deadline IS OLD.operation_deadline
)
BEGIN SELECT RAISE(ABORT,'request idempotency identity is immutable'); END;

CREATE TRIGGER request_idempotency_legal_transition
BEFORE UPDATE ON request_idempotency
WHEN NOT (
  (OLD.state='processing' AND NEW.state='processing'
    AND NEW.expires_at IS NULL
    AND datetime(OLD.operation_deadline)>CURRENT_TIMESTAMP
    AND (
      (NEW.lease_token=OLD.lease_token
        AND datetime(OLD.lease_until)>CURRENT_TIMESTAMP
        AND datetime(NEW.lease_until)>datetime(OLD.lease_until)
        AND datetime(NEW.lease_until)<=datetime(OLD.operation_deadline))
      OR (datetime(OLD.lease_until)<=CURRENT_TIMESTAMP
        AND NEW.lease_token<>OLD.lease_token
        AND datetime(NEW.lease_until)>CURRENT_TIMESTAMP
        AND datetime(NEW.lease_until)<=datetime(OLD.operation_deadline))
    ))
  OR (OLD.state='processing' AND NEW.state='completed'
    AND (
      (OLD.lease_token IS NOT NULL AND datetime(OLD.lease_until)>CURRENT_TIMESTAMP
        AND datetime(OLD.operation_deadline)>CURRENT_TIMESTAMP)
      OR (datetime(OLD.operation_deadline)<=CURRENT_TIMESTAMP
        AND NEW.response_kind='json' AND NEW.status_code=503)
    )
    AND NEW.expires_at=datetime(
      NEW.updated_at,
      CASE WHEN NEW.response_kind='admission' THEN '+1 day' ELSE '+30 days' END
    )
    AND (
      (NEW.status_code BETWEEN 400 AND 599 AND NEW.response_kind='json'
        AND (SELECT count(*) FROM campaign_events event
          WHERE event.org_id=OLD.org_id AND event.actor_user_id=OLD.user_id
            AND event.audit_fingerprint=OLD.audit_fingerprint)=0)
      OR (
        NEW.status_code BETWEEN 200 AND 299
        AND (SELECT count(*) FROM campaign_events event
          WHERE event.org_id=OLD.org_id AND event.actor_user_id=OLD.user_id
            AND event.audit_fingerprint=OLD.audit_fingerprint)=OLD.expected_event_count
        AND (
          (OLD.expected_event_count=2 AND OLD.scope='campaign.link.correct'
            AND OLD.secondary_campaign_id IS NOT NULL
            AND (SELECT count(*) FROM campaign_events event
              WHERE event.org_id=OLD.org_id AND event.actor_user_id=OLD.user_id
                AND event.audit_fingerprint=OLD.audit_fingerprint
                AND event.campaign_id=OLD.campaign_id AND event.event_type='link_moved')=1
            AND (SELECT count(*) FROM campaign_events event
              WHERE event.org_id=OLD.org_id AND event.actor_user_id=OLD.user_id
                AND event.audit_fingerprint=OLD.audit_fingerprint
                AND event.campaign_id=OLD.secondary_campaign_id AND event.event_type='link_moved')=1)
          OR (OLD.expected_event_count=1 AND OLD.secondary_campaign_id IS NULL
            AND (SELECT count(*) FROM campaign_events event
              WHERE event.org_id=OLD.org_id AND event.actor_user_id=OLD.user_id
                AND event.audit_fingerprint=OLD.audit_fingerprint
                AND event.campaign_id=OLD.campaign_id)=1)
          OR (OLD.expected_event_count=0 AND OLD.secondary_campaign_id IS NULL)
        )
      )
    ))
  OR (OLD.state='processing' AND NEW.state='failed'
    AND OLD.lease_token IS NOT NULL AND datetime(OLD.lease_until)>CURRENT_TIMESTAMP
    AND datetime(OLD.operation_deadline)>CURRENT_TIMESTAMP
    AND NEW.expires_at=datetime(NEW.updated_at,'+1 day'))
  OR (OLD.state='failed' AND NEW.state='processing'
    AND datetime(OLD.operation_deadline)>CURRENT_TIMESTAMP
    AND NEW.expires_at IS NULL AND NEW.lease_token IS NOT NULL
    AND datetime(NEW.lease_until)>CURRENT_TIMESTAMP
    AND datetime(NEW.lease_until)<=datetime(OLD.operation_deadline))
  OR (OLD.state='failed' AND NEW.state='completed'
    AND datetime(OLD.operation_deadline)<=CURRENT_TIMESTAMP
    AND NEW.status_code=503 AND NEW.response_kind='json'
    AND NEW.expires_at=datetime(NEW.updated_at,'+30 days')
    AND (SELECT count(*) FROM campaign_events event
      WHERE event.org_id=OLD.org_id AND event.actor_user_id=OLD.user_id
        AND event.audit_fingerprint=OLD.audit_fingerprint)=0)
  OR (OLD.state='completed' AND OLD.response_kind='binary' AND NEW.state='expiring'
    AND datetime(OLD.expires_at)<=CURRENT_TIMESTAMP
    AND NEW.expires_at IS OLD.expires_at
    AND NEW.status_code IS OLD.status_code AND NEW.response_kind IS OLD.response_kind
    AND NEW.response_json IS OLD.response_json
    AND NEW.response_headers_json IS OLD.response_headers_json
    AND NEW.response_cache_key IS OLD.response_cache_key
    AND NEW.response_sha256 IS OLD.response_sha256 AND NEW.response_bytes IS OLD.response_bytes
    AND NEW.response_content_type IS OLD.response_content_type
    AND NEW.response_filename IS OLD.response_filename)
)
BEGIN SELECT RAISE(ABORT,'invalid request idempotency transition'); END;

CREATE TRIGGER workflow_instances_campaign_context_insert
BEFORE INSERT ON workflow_instances
WHEN EXISTS (
  SELECT 1
  FROM workflow_instances existing
  WHERE (
      existing.id=NEW.id
      OR (
        NEW.campaign_dispatch_id IS NOT NULL
        AND existing.campaign_dispatch_id=NEW.campaign_dispatch_id
      )
    )
)
  OR NEW.org_id IS NOT NULL OR NEW.campaign_id IS NOT NULL
  OR NEW.campaign_event_id IS NOT NULL OR NEW.campaign_dispatch_id IS NOT NULL
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM workflow_instances existing
    WHERE (
        existing.id=NEW.id
        OR (
          NEW.campaign_dispatch_id IS NOT NULL
          AND existing.campaign_dispatch_id=NEW.campaign_dispatch_id
        )
      )
  ) THEN RAISE(ABORT,'campaign workflow instance cannot be replaced') END;
  SELECT CASE WHEN NEW.org_id IS NULL OR NEW.campaign_id IS NULL
    OR NEW.campaign_event_id IS NULL OR NEW.campaign_dispatch_id IS NULL
    THEN RAISE(ABORT,'campaign workflow context must be complete') END;
  SELECT CASE WHEN NEW.business_type<>'campaign' OR NEW.business_id<>NEW.campaign_id
    THEN RAISE(ABORT,'campaign workflow business projection must match campaign') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM campaign_workflow_dispatches dispatch
    JOIN campaign_events root_event
      ON root_event.org_id=dispatch.org_id
      AND root_event.campaign_id=dispatch.campaign_id
      AND root_event.id=dispatch.trigger_event_id
    WHERE dispatch.id=NEW.campaign_dispatch_id
      AND dispatch.org_id=NEW.org_id
      AND dispatch.campaign_id=NEW.campaign_id
      AND dispatch.trigger_event_id=NEW.campaign_event_id
      AND dispatch.template_id=NEW.template_id
      AND root_event.actor_user_id=NEW.started_by
  ) THEN RAISE(ABORT,'campaign workflow context does not match dispatch') END;
END;

CREATE TRIGGER workflow_instances_campaign_execution_state_insert
BEFORE INSERT ON workflow_instances
WHEN NEW.campaign_id IS NOT NULL AND (
  NEW.status IS NULL
  OR NEW.initialization_status IS NOT 'ready'
  OR NEW.initialization_error IS NOT NULL
  OR NOT (
    (NEW.status IN ('active','paused','completed','cancelled')
      AND NEW.execution_error_code IS NULL AND NEW.execution_error IS NULL
      AND NEW.execution_failed_at IS NULL)
    OR (NEW.status='failed_validation'
      AND NEW.execution_error_code IS NOT NULL AND NEW.execution_error IS NOT NULL
      AND NEW.execution_failed_at IS NOT NULL)
  )
)
BEGIN SELECT RAISE(ABORT,'invalid campaign workflow execution state'); END;

CREATE TRIGGER workflow_instances_campaign_execution_state_update
BEFORE UPDATE OF status,initialization_status,initialization_error,
  execution_error_code,execution_error,execution_failed_at
ON workflow_instances
WHEN NEW.campaign_id IS NOT NULL AND (
  NEW.status IS NULL
  OR NEW.initialization_status IS NOT 'ready'
  OR NEW.initialization_error IS NOT NULL
  OR NOT (
    (NEW.status IN ('active','paused','completed','cancelled')
      AND NEW.execution_error_code IS NULL AND NEW.execution_error IS NULL
      AND NEW.execution_failed_at IS NULL)
    OR (NEW.status='failed_validation'
      AND NEW.execution_error_code IS NOT NULL AND NEW.execution_error IS NOT NULL
      AND NEW.execution_failed_at IS NOT NULL)
  )
)
BEGIN SELECT RAISE(ABORT,'invalid campaign workflow execution state'); END;

CREATE TRIGGER campaign_workflow_task_assignment_update
BEFORE UPDATE OF assignee_id,assignee_role,assignment_version ON workflow_tasks
WHEN EXISTS (
  SELECT 1 FROM workflow_instances instance
  WHERE instance.id=OLD.instance_id AND instance.campaign_id IS NOT NULL
) AND NOT (
  OLD.status='pending' AND NEW.status='pending'
  AND typeof(NEW.assignment_version)='integer'
  AND NEW.assignment_version=OLD.assignment_version+1
  AND NEW.assignment_version BETWEEN 2 AND 9007199254740991
  AND (NEW.assignee_id IS NOT NULL OR NEW.assignee_role IS NOT NULL)
  AND (NEW.assignee_id IS NULL OR (
    typeof(NEW.assignee_id)='integer'
    AND NEW.assignee_id BETWEEN 1 AND 9007199254740991
  ))
  AND (NEW.assignee_role IS NULL OR NEW.assignee_role IN (
    'platform_admin','org_admin','team_lead','member'
  ))
  AND (NEW.assignee_id IS NOT OLD.assignee_id
    OR NEW.assignee_role IS NOT OLD.assignee_role)
)
BEGIN SELECT RAISE(ABORT,'invalid campaign workflow task reassignment'); END;

CREATE TRIGGER campaign_workflow_task_no_replace_insert
BEFORE INSERT ON workflow_tasks
WHEN EXISTS (
  SELECT 1
  FROM workflow_tasks existing
  WHERE existing.id=NEW.id
    AND (
      EXISTS (
        SELECT 1 FROM workflow_instances instance
        WHERE instance.id=existing.instance_id AND instance.campaign_id IS NOT NULL
      )
      OR EXISTS (
        SELECT 1 FROM workflow_instances instance
        WHERE instance.id=NEW.instance_id AND instance.campaign_id IS NOT NULL
      )
    )
)
BEGIN SELECT RAISE(ABORT,'campaign workflow task cannot be replaced'); END;

CREATE TRIGGER campaign_workflow_dispatches_completed_instance_insert
BEFORE INSERT ON campaign_workflow_dispatches
WHEN NEW.status='completed' AND NOT EXISTS (
  SELECT 1 FROM workflow_instances instance
  WHERE instance.id=NEW.workflow_instance_id
    AND instance.org_id=NEW.org_id
    AND instance.campaign_id=NEW.campaign_id
    AND instance.campaign_dispatch_id=NEW.id
    AND instance.campaign_event_id=NEW.trigger_event_id
    AND instance.template_id=NEW.template_id
    AND instance.business_type='campaign'
    AND instance.business_id=NEW.campaign_id
    AND instance.initialization_status='ready'
    AND instance.initialization_error IS NULL
)
BEGIN SELECT RAISE(ABORT,'completed dispatch instance lineage mismatch'); END;

CREATE TRIGGER campaign_workflow_dispatches_completed_instance_update
BEFORE UPDATE OF status,workflow_instance_id ON campaign_workflow_dispatches
WHEN NEW.status='completed' AND NOT EXISTS (
  SELECT 1 FROM workflow_instances instance
  WHERE instance.id=NEW.workflow_instance_id
    AND instance.org_id=NEW.org_id
    AND instance.campaign_id=NEW.campaign_id
    AND instance.campaign_dispatch_id=NEW.id
    AND instance.campaign_event_id=NEW.trigger_event_id
    AND instance.template_id=NEW.template_id
    AND instance.business_type='campaign'
    AND instance.business_id=NEW.campaign_id
    AND instance.initialization_status='ready'
    AND instance.initialization_error IS NULL
)
BEGIN SELECT RAISE(ABORT,'completed dispatch instance lineage mismatch'); END;

CREATE TRIGGER campaign_workflow_dispatches_immutable_evidence
BEFORE UPDATE OF org_id,campaign_id,event_id,trigger_event_id,template_id,template_version,
  template_checksum,template_snapshot_json,execution_context_json,reconciles_dispatch_id,created_at
ON campaign_workflow_dispatches
WHEN NOT (
  NEW.org_id IS OLD.org_id AND NEW.campaign_id IS OLD.campaign_id
  AND NEW.event_id IS OLD.event_id AND NEW.template_id IS OLD.template_id
  AND NEW.trigger_event_id IS OLD.trigger_event_id
    AND NEW.template_version IS OLD.template_version
    AND NEW.template_checksum IS OLD.template_checksum
    AND NEW.template_snapshot_json IS OLD.template_snapshot_json
    AND NEW.execution_context_json IS OLD.execution_context_json
    AND NEW.reconciles_dispatch_id IS OLD.reconciles_dispatch_id
  AND NEW.created_at IS OLD.created_at
)
BEGIN SELECT RAISE(ABORT,'campaign workflow evidence is immutable'); END;

CREATE TRIGGER campaign_workflow_dispatches_active_campaign_insert
BEFORE INSERT ON campaign_workflow_dispatches
WHEN NEW.status<>'cancelled' AND NOT EXISTS (
  SELECT 1 FROM campaigns campaign
  WHERE campaign.org_id=NEW.org_id AND campaign.id=NEW.campaign_id
    AND campaign.operational_status='active'
)
BEGIN SELECT RAISE(ABORT,'campaign workflow dispatch requires active campaign'); END;

CREATE TRIGGER campaign_workflow_dispatches_active_campaign_update
BEFORE UPDATE OF status,attempt_count,lease_until,lease_token,next_attempt_at,
  workflow_instance_id,last_error_code,last_error
ON campaign_workflow_dispatches
WHEN NEW.status<>'cancelled' AND NOT EXISTS (
  SELECT 1 FROM campaigns campaign
  WHERE campaign.org_id=NEW.org_id AND campaign.id=NEW.campaign_id
    AND campaign.operational_status='active'
)
BEGIN SELECT RAISE(ABORT,'campaign workflow dispatch requires active campaign'); END;

CREATE TRIGGER campaign_workflow_dispatches_legal_transition
BEFORE UPDATE ON campaign_workflow_dispatches
WHEN NOT (
  (OLD.status='pending' AND NEW.status='processing'
    AND OLD.attempt_count=0 AND NEW.attempt_count=1
    AND datetime(NEW.lease_until)>CURRENT_TIMESTAMP)
  OR (OLD.status='failed_initialization' AND NEW.status='processing'
    AND OLD.attempt_count BETWEEN 1 AND 4
    AND datetime(OLD.next_attempt_at) <= CURRENT_TIMESTAMP
    AND NEW.attempt_count=OLD.attempt_count+1
    AND datetime(NEW.lease_until)>CURRENT_TIMESTAMP)
  OR (OLD.status='processing' AND NEW.status='processing'
    AND NEW.attempt_count=OLD.attempt_count AND NEW.lease_token=OLD.lease_token
    AND datetime(OLD.lease_until) > CURRENT_TIMESTAMP
    AND datetime(NEW.lease_until) > datetime(OLD.lease_until))
  OR (OLD.status='processing' AND NEW.status='processing'
    AND datetime(OLD.lease_until) <= CURRENT_TIMESTAMP
    AND OLD.attempt_count BETWEEN 1 AND 4
    AND NEW.attempt_count=OLD.attempt_count+1
    AND NEW.lease_token<>OLD.lease_token
    AND datetime(NEW.lease_until)>CURRENT_TIMESTAMP)
  OR (OLD.status='processing' AND NEW.status IN ('completed','failed_validation')
    AND datetime(OLD.lease_until) > CURRENT_TIMESTAMP
    AND NEW.attempt_count=OLD.attempt_count)
  OR (OLD.status='processing' AND NEW.status='failed_initialization'
    AND OLD.attempt_count BETWEEN 1 AND 4
    AND datetime(OLD.lease_until) > CURRENT_TIMESTAMP
    AND NEW.attempt_count=OLD.attempt_count)
  OR (OLD.status='processing' AND NEW.status='dead_letter'
    AND datetime(OLD.lease_until) > CURRENT_TIMESTAMP
    AND OLD.attempt_count=5 AND NEW.attempt_count=5)
  OR (OLD.status='processing' AND NEW.status='dead_letter'
    AND datetime(OLD.lease_until) <= CURRENT_TIMESTAMP
    AND OLD.attempt_count=5 AND NEW.attempt_count=5)
  OR (OLD.status IN ('pending','processing','failed_initialization')
    AND NEW.status='cancelled'
    AND NEW.attempt_count=OLD.attempt_count)
  OR (OLD.status IN ('failed_initialization','dead_letter') AND NEW.status='pending'
    AND NEW.attempt_count=0)
)
BEGIN SELECT RAISE(ABORT,'invalid campaign workflow dispatch transition'); END;

CREATE TRIGGER request_idempotency_headers_insert
BEFORE INSERT ON request_idempotency
WHEN EXISTS (
  SELECT 1
  FROM request_idempotency existing
  WHERE existing.id=NEW.id
    OR (
      existing.org_id=NEW.org_id AND existing.user_id=NEW.user_id
      AND existing.scope=NEW.scope AND existing.idempotency_key=NEW.idempotency_key
    )
    OR (
      existing.org_id=NEW.org_id AND existing.user_id=NEW.user_id
      AND existing.audit_fingerprint=NEW.audit_fingerprint
    )
    OR (
      NEW.resource_claim IS NOT NULL
      AND (
        NEW.state='processing'
        OR (NEW.state IN ('completed','expiring') AND NEW.response_kind='binary')
      )
      AND existing.org_id=NEW.org_id AND existing.scope=NEW.scope
      AND existing.resource_claim=NEW.resource_claim
      AND (
        existing.state='processing'
        OR (
          existing.state IN ('completed','expiring')
          AND existing.response_kind='binary'
        )
      )
    )
)
OR (
  NEW.response_headers_json IS NOT NULL AND EXISTS (
    SELECT 1 FROM json_each(NEW.response_headers_json)
    WHERE key NOT IN ('Content-Type','Content-Disposition','Content-Length','ETag','Cache-Control')
      OR type<>'text'
      OR instr(value,char(127))>0
      OR EXISTS (
        WITH RECURSIVE controls(code) AS (
          SELECT 0 UNION ALL SELECT code+1 FROM controls WHERE code<31
        )
        SELECT 1 FROM controls WHERE instr(value,char(code))>0
      )
  )
)
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM request_idempotency existing
    WHERE existing.id=NEW.id
      OR (
        existing.org_id=NEW.org_id AND existing.user_id=NEW.user_id
        AND existing.scope=NEW.scope AND existing.idempotency_key=NEW.idempotency_key
      )
      OR (
        existing.org_id=NEW.org_id AND existing.user_id=NEW.user_id
        AND existing.audit_fingerprint=NEW.audit_fingerprint
      )
      OR (
        NEW.resource_claim IS NOT NULL
        AND (
          NEW.state='processing'
          OR (NEW.state IN ('completed','expiring') AND NEW.response_kind='binary')
        )
        AND existing.org_id=NEW.org_id AND existing.scope=NEW.scope
        AND existing.resource_claim=NEW.resource_claim
        AND (
          existing.state='processing'
          OR (
            existing.state IN ('completed','expiring')
            AND existing.response_kind='binary'
          )
        )
      )
  ) THEN RAISE(ABORT,'request idempotency reservation cannot be replaced') END;
  SELECT RAISE(ABORT,'invalid persisted replay header');
END;

CREATE TRIGGER request_idempotency_headers_update
BEFORE UPDATE OF response_headers_json ON request_idempotency
WHEN NEW.response_headers_json IS NOT NULL AND EXISTS (
  SELECT 1 FROM json_each(NEW.response_headers_json)
  WHERE key NOT IN ('Content-Type','Content-Disposition','Content-Length','ETag','Cache-Control')
    OR type<>'text'
    OR instr(value,char(127))>0
    OR EXISTS (
      WITH RECURSIVE controls(code) AS (
        SELECT 0 UNION ALL SELECT code+1 FROM controls WHERE code<31
      )
      SELECT 1 FROM controls WHERE instr(value,char(code))>0
    )
)
BEGIN SELECT RAISE(ABORT,'invalid persisted replay header'); END;

CREATE TRIGGER request_idempotency_filename_controls_insert
BEFORE INSERT ON request_idempotency
WHEN NEW.response_filename IS NOT NULL AND (
  instr(NEW.response_filename,char(127))>0
  OR EXISTS (
    WITH RECURSIVE controls(code) AS (
      SELECT 0 UNION ALL SELECT code+1 FROM controls WHERE code<31
    )
    SELECT 1 FROM controls WHERE instr(NEW.response_filename,char(code))>0
  )
)
BEGIN SELECT RAISE(ABORT,'invalid persisted replay filename'); END;

CREATE TRIGGER request_idempotency_filename_controls_update
BEFORE UPDATE OF response_filename ON request_idempotency
WHEN NEW.response_filename IS NOT NULL AND (
  instr(NEW.response_filename,char(127))>0
  OR EXISTS (
    WITH RECURSIVE controls(code) AS (
      SELECT 0 UNION ALL SELECT code+1 FROM controls WHERE code<31
    )
    SELECT 1 FROM controls WHERE instr(NEW.response_filename,char(code))>0
  )
)
BEGIN SELECT RAISE(ABORT,'invalid persisted replay filename'); END;

CREATE TRIGGER campaign_events_request_fingerprint_insert
BEFORE INSERT ON campaign_events
WHEN NOT EXISTS (
  SELECT 1 FROM request_idempotency request
  WHERE request.org_id=NEW.org_id
    AND request.user_id=NEW.actor_user_id
    AND request.audit_fingerprint=NEW.audit_fingerprint
    AND request.state='processing'
    AND request.lease_token IS NOT NULL
    AND datetime(request.lease_until) > CURRENT_TIMESTAMP
    AND datetime(request.operation_deadline) > CURRENT_TIMESTAMP
    AND (
      (
        NEW.event_type='link_moved'
        AND request.scope='campaign.link.correct'
        AND request.expected_event_count=2
        AND request.secondary_campaign_id IS NOT NULL
        AND request.campaign_id=json_extract(NEW.metadata_json,'$.source_campaign_id')
        AND request.secondary_campaign_id=json_extract(NEW.metadata_json,'$.destination_campaign_id')
        AND NEW.campaign_id IN (request.campaign_id,request.secondary_campaign_id)
        AND NEW.source='project_workspace'
        AND NOT EXISTS (
          SELECT 1 FROM campaign_events peer
          WHERE peer.org_id=NEW.org_id
            AND peer.audit_fingerprint=NEW.audit_fingerprint
            AND peer.event_type='link_moved'
            AND peer.metadata_json<>NEW.metadata_json
        )
      )
      OR (
        NEW.event_type<>'link_moved'
        AND request.expected_event_count=1
        AND request.campaign_id=NEW.campaign_id
        AND (
          (NEW.event_type='campaign_created' AND request.scope='campaign.create'
            AND NEW.source='campaign_api' AND NEW.reason='Campaign created')
          OR (NEW.event_type='lifecycle_transition' AND request.scope='campaign.transition'
            AND NEW.source='project_workspace')
          OR (NEW.event_type='operational_status_changed' AND (
            (request.scope='campaign.operational' AND NEW.source='project_workspace')
            OR (request.scope='collaboration.update.linked' AND NEW.source='collaboration_link')
          ))
          OR (NEW.event_type='campaign_transferred' AND request.scope='campaign.transfer'
            AND NEW.source='project_workspace')
          OR (NEW.event_type='link_attached' AND (
            (request.scope IN ('campaign.link.attach','campaign.link.correct') AND NEW.source='project_workspace')
            OR (request.scope='demand.create.linked' AND NEW.source='demand_link' AND NEW.reason='Linked demand')
            OR (request.scope='proposal.create.linked' AND NEW.source='proposal_link' AND NEW.reason='Linked proposal')
            OR (request.scope='proposal.ppt.generate.linked' AND NEW.source='ppt_link' AND NEW.reason='Linked ppt')
            OR (request.scope='ai.conversation.create.linked' AND NEW.source='ai_link' AND NEW.reason='Linked ai_run')
            OR (request.scope IN ('knowledge.create.linked','knowledge.ingest.linked','knowledge.upload.linked')
              AND NEW.source='knowledge_link' AND NEW.reason='Linked knowledge')
            OR (request.scope='collaboration.create.linked' AND NEW.source='collaboration_link' AND NEW.reason='Linked order')
            OR (request.scope='collaboration.update.linked' AND NEW.source='collaboration_link')
            OR (request.scope='campaign.review.create' AND NEW.source='campaign_review')
          ))
          OR (NEW.event_type='link_revoked' AND (
            (request.scope='campaign.link.correct' AND NEW.source='project_workspace')
            OR (request.scope='collaboration.update.linked' AND NEW.source='collaboration_link')
          ))
          OR (NEW.event_type='workflow_reconciliation' AND request.scope='campaign.workflow.reconcile'
            AND NEW.source='workflow_recovery')
        )
      )
    )
  )
BEGIN SELECT RAISE(ABORT,'campaign event request fingerprint is not reserved'); END;

CREATE TRIGGER workflow_instances_campaign_context_immutable
BEFORE UPDATE OF template_id,business_type,business_id,started_by,created_at,
  org_id,campaign_id,campaign_event_id,campaign_dispatch_id
ON workflow_instances
WHEN NOT (
  NEW.template_id IS OLD.template_id
  AND NEW.business_type IS OLD.business_type AND NEW.business_id IS OLD.business_id
  AND NEW.started_by IS OLD.started_by AND NEW.created_at IS OLD.created_at
  AND NEW.org_id IS OLD.org_id AND NEW.campaign_id IS OLD.campaign_id
  AND NEW.campaign_event_id IS OLD.campaign_event_id
  AND NEW.campaign_dispatch_id IS OLD.campaign_dispatch_id
)
BEGIN SELECT RAISE(ABORT,'campaign workflow context is immutable'); END;

CREATE TRIGGER campaign_workflow_dispatches_no_delete
BEFORE DELETE ON campaign_workflow_dispatches
BEGIN SELECT RAISE(ABORT,'campaign workflow dispatches cannot be deleted'); END;
`
];

function splitStatements(block) {
  return block
    .split(/(?=^(?:ALTER TABLE|CREATE TABLE|CREATE UNIQUE INDEX|CREATE TRIGGER)\b)/gm)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    .map((statement) => statement.endsWith(';') ? statement.slice(0, -1).trim() : statement);
}

const STATEMENTS = [];
for (const block of SQL_BLOCKS) {
  const statements = splitStatements(block);
  for (const statement of statements) STATEMENTS.push(statement);
}

function namedStatements(prefix, pattern) {
  const result = {};
  for (const statement of STATEMENTS) {
    if (!statement.startsWith(prefix)) continue;
    const match = pattern.exec(statement);
    if (!match) throw new Error('invalid schema statement');
    result[match[1]] = statement;
  }
  return result;
}

const TABLE_SQL = namedStatements('CREATE TABLE', /^CREATE TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
const INDEX_SQL = namedStatements('CREATE UNIQUE INDEX', /^CREATE UNIQUE INDEX\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
const TRIGGER_SQL = namedStatements('CREATE TRIGGER', /^CREATE TRIGGER\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
const ALTER_SQL = STATEMENTS.filter((statement) => statement.startsWith('ALTER TABLE'));

function splitTopLevelComma(text) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote !== null) {
      if (character === quote && text[index + 1] === quote) {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
    } else if (character === ',' && depth === 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

function columnMetadata(definition) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z]+)\b/.exec(definition);
  if (!match) return null;
  if (['CHECK', 'PRIMARY', 'UNIQUE', 'FOREIGN', 'CONSTRAINT'].includes(match[1].toUpperCase())) return null;
  const constraintIndex = definition.search(/\b(?:CHECK|REFERENCES|UNIQUE|PRIMARY)\b/i);
  const declaration = constraintIndex < 0 ? definition : definition.slice(0, constraintIndex);
  const defaultMatch = /\bDEFAULT\s+('(?:''|[^'])*'|"(?:\"\"|[^"])*"|[A-Za-z0-9_+-]+)/i.exec(declaration);
  return {
    name: match[1],
    metadata: {
      type: match[2].toUpperCase(),
      notnull: /\bNOT\s+NULL\b/i.test(declaration) ? 1 : 0,
      defaultValue: defaultMatch ? defaultMatch[1] : null
    }
  };
}

function collectChecks(sql) {
  const checks = [];
  for (let start = 0; start < sql.length; start += 1) {
    if (sql.slice(start, start + 5).toUpperCase() !== 'CHECK') continue;
    const previous = start === 0 ? '' : sql[start - 1];
    const next = sql[start + 5] || '';
    if (/[A-Za-z0-9_]/.test(previous) || /[A-Za-z0-9_]/.test(next)) continue;
    let open = start + 5;
    while (/\s/.test(sql[open] || '')) open += 1;
    if (sql[open] !== '(') continue;
    let depth = 0;
    let quote = null;
    for (let index = open; index < sql.length; index += 1) {
      const character = sql[index];
      if (quote !== null) {
        if (character === quote && sql[index + 1] === quote) {
          index += 1;
        } else if (character === quote) {
          quote = null;
        }
        continue;
      }
      if (character === "'" || character === '"') {
        quote = character;
      } else if (character === '(') {
        depth += 1;
      } else if (character === ')') {
        depth -= 1;
        if (depth === 0) {
          checks.push(sql.slice(start, index + 1));
          start = index;
          break;
        }
      }
    }
  }
  return checks;
}

function schemaManifest() {
  const columns = {};
  const tableChecks = {};
  for (const sql of ALTER_SQL) {
    const match = /^ALTER TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+ADD COLUMN\s+([\s\S]+)$/i.exec(sql);
    if (!match) throw new Error('invalid compatibility column statement');
    const column = columnMetadata(match[2]);
    if (!column) throw new Error('invalid compatibility column definition');
    if (!columns[match[1]]) columns[match[1]] = {};
    if (!tableChecks[match[1]]) tableChecks[match[1]] = [];
    columns[match[1]][column.name] = column.metadata;
    const checks = collectChecks(match[2]);
    for (const check of checks) tableChecks[match[1]].push(check);
  }
  return {
    columns,
    indexes: INDEX_SQL,
    triggers: TRIGGER_SQL,
    tableChecks
  };
}

const SCHEMA_MANIFEST = schemaManifest();

const EXPECTED_COUNTS = Object.freeze({
  tables: 9,
  compatibilityColumns: 23,
  indexes: 10,
  triggers: 51
});

const TABLE_ORDER = Object.freeze([
  'organizations',
  'organization_memberships',
  'teams',
  'team_memberships',
  'campaigns',
  'campaign_events',
  'campaign_record_links',
  'campaign_workflow_dispatches',
  'request_idempotency'
]);

const EARLY_INDEXES = Object.freeze([
  'ux_opportunities_id_customer',
  'ux_workflow_instances_campaign_dispatch',
  'ux_workflow_instances_org_campaign_id'
]);

const IDENTITY_TRIGGERS = Object.freeze([
  'organizations_code_immutable',
  'default_organization_delete_guard',
  'activity_log_append_only_update',
  'activity_log_append_only_delete',
  'activity_log_identity_shape'
]);

const INTEGER_RULES = Object.freeze({
  users: Object.freeze({ id: 'positive', api_quota: 'nonnegative', is_active: 'boolean' }),
  brands: Object.freeze({
    id: 'positive',
    youtube_followers: 'nonnegative',
    instagram_followers: 'nonnegative',
    tiktok_followers: 'nonnegative',
    search_volume_monthly: 'nonnegative',
    monthly_posts: 'nonnegative',
    avg_views: 'nonnegative'
  }),
  sessions: Object.freeze({ id: 'positive', user_id: 'positive' }),
  demands: Object.freeze({ id: 'positive', user_id: 'positive' }),
  proposals: Object.freeze({ id: 'positive', user_id: 'positive', demand_id: 'positive' }),
  token_usage: Object.freeze({
    id: 'positive',
    user_id: 'positive',
    prompt_tokens: 'nonnegative',
    completion_tokens: 'nonnegative',
    total_tokens: 'nonnegative'
  }),
  activity_log: Object.freeze({ id: 'positive', user_id: 'positive' }),
  team_invites: Object.freeze({
    id: 'positive',
    created_by: 'positive',
    max_uses: 'positive',
    uses: 'nonnegative',
    is_active: 'boolean'
  }),
  customers: Object.freeze({
    id: 'positive',
    created_by: 'positive',
    assigned_to: 'positive',
    lead_score: 'nonnegative',
    win_probability: 'probability',
    is_public: 'boolean'
  }),
  customer_activity: Object.freeze({ id: 'positive', customer_id: 'positive', user_id: 'positive' }),
  influencers: Object.freeze({
    id: 'positive',
    followers: 'nonnegative',
    avg_views_10: 'nonnegative',
    cost_usd: 'nonnegative',
    cost_range_min: 'nonnegative',
    cost_range_max: 'nonnegative',
    is_active: 'boolean',
    quoted_price: 'nonnegative',
    is_duplicate: 'boolean'
  }),
  collaborations: Object.freeze({
    id: 'positive',
    demand_id: 'positive',
    influencer_id: 'positive',
    user_id: 'positive',
    cost_quoted: 'nonnegative',
    cost_actual: 'nonnegative',
    row_version: 'positive',
    cost_actual_confirmed: 'boolean'
  }),
  workflow_templates: Object.freeze({
    id: 'positive',
    version: 'positive',
    is_active: 'boolean',
    created_by: 'positive'
  }),
  workflow_instances: Object.freeze({
    id: 'positive',
    template_id: 'positive',
    business_id: 'positive',
    started_by: 'positive'
  }),
  workflow_tasks: Object.freeze({
    id: 'positive',
    instance_id: 'positive',
    assignee_id: 'positive',
    completed_by: 'positive'
  }),
  workflow_timers: Object.freeze({ id: 'positive', instance_id: 'positive', fired: 'boolean' }),
  workflow_node_logs: Object.freeze({ id: 'positive', instance_id: 'positive', user_id: 'positive' }),
  leads: Object.freeze({
    id: 'positive',
    lead_score: 'nonnegative',
    assigned_to: 'positive',
    converted_customer_id: 'positive'
  }),
  opportunities: Object.freeze({
    id: 'positive',
    customer_id: 'positive',
    win_probability: 'probability',
    created_by: 'positive'
  }),
  sales_targets: Object.freeze({ id: 'positive', user_id: 'positive' }),
  activity_log_ext: Object.freeze({ id: 'positive', customer_id: 'positive', user_id: 'positive' }),
  knowledge_entries: Object.freeze({
    id: 'positive',
    created_by: 'positive',
    is_public: 'boolean',
    usage_count: 'nonnegative'
  }),
  knowledge_chunks: Object.freeze({
    id: 'positive',
    entry_id: 'positive',
    chunk_index: 'nonnegative',
    token_count: 'nonnegative'
  }),
  ai_conversations: Object.freeze({
    id: 'positive',
    user_id: 'positive',
    archived_summary_id: 'positive'
  }),
  ai_messages: Object.freeze({
    id: 'positive',
    conversation_id: 'positive',
    user_id: 'positive',
    prompt_tokens: 'nonnegative',
    completion_tokens: 'nonnegative',
    total_tokens: 'nonnegative'
  }),
  ai_references: Object.freeze({ id: 'positive', message_id: 'positive' }),
  web_search_cache: Object.freeze({ id: 'positive' })
});

const LEGACY_RELATIONSHIPS = Object.freeze([
  ['sessions', 'user_id', 'users', 'id', true],
  ['demands', 'user_id', 'users', 'id', true],
  ['proposals', 'user_id', 'users', 'id', true],
  ['proposals', 'demand_id', 'demands', 'id', false],
  ['token_usage', 'user_id', 'users', 'id', true],
  ['activity_log', 'user_id', 'users', 'id', true],
  ['team_invites', 'created_by', 'users', 'id', true],
  ['customers', 'created_by', 'users', 'id', true],
  ['customers', 'assigned_to', 'users', 'id', false],
  ['customer_activity', 'customer_id', 'customers', 'id', true],
  ['customer_activity', 'user_id', 'users', 'id', true],
  ['collaborations', 'demand_id', 'demands', 'id', false],
  ['collaborations', 'influencer_id', 'influencers', 'id', true],
  ['collaborations', 'user_id', 'users', 'id', true],
  ['workflow_templates', 'created_by', 'users', 'id', false],
  ['workflow_instances', 'template_id', 'workflow_templates', 'id', true],
  ['workflow_instances', 'started_by', 'users', 'id', false],
  ['workflow_tasks', 'instance_id', 'workflow_instances', 'id', true],
  ['workflow_tasks', 'assignee_id', 'users', 'id', false],
  ['workflow_tasks', 'completed_by', 'users', 'id', false],
  ['workflow_timers', 'instance_id', 'workflow_instances', 'id', true],
  ['workflow_node_logs', 'instance_id', 'workflow_instances', 'id', true],
  ['workflow_node_logs', 'user_id', 'users', 'id', false],
  ['opportunities', 'customer_id', 'customers', 'id', true],
  ['opportunities', 'created_by', 'users', 'id', false],
  ['leads', 'assigned_to', 'users', 'id', false],
  ['leads', 'converted_customer_id', 'customers', 'id', false],
  ['sales_targets', 'user_id', 'users', 'id', false],
  ['activity_log_ext', 'customer_id', 'customers', 'id', false],
  ['activity_log_ext', 'user_id', 'users', 'id', false],
  ['knowledge_entries', 'created_by', 'users', 'id', false],
  ['knowledge_chunks', 'entry_id', 'knowledge_entries', 'id', true],
  ['ai_conversations', 'user_id', 'users', 'id', true],
  ['ai_conversations', 'archived_summary_id', 'knowledge_entries', 'id', false],
  ['ai_messages', 'conversation_id', 'ai_conversations', 'id', true],
  ['ai_messages', 'user_id', 'users', 'id', true],
  ['ai_references', 'message_id', 'ai_messages', 'id', true]
]);

const SNAPSHOT_COLUMNS = Object.freeze([
  'reference_schema_version',
  'knowledge_entry_id',
  'knowledge_chunk_id',
  'campaign_id',
  'source_identity_sha256',
  'entry_content_sha256',
  'chunk_content_sha256',
  'reference_rank',
  'selection_origin'
]);

function quoteIdentifier(value) {
  return '"' + String(value).replace(/"/g, '""') + '"';
}

function assertSafePositive(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > SAFE_MAX) {
    throw new Error(label + ' is not a positive safe integer');
  }
}

function bytesFromHex(hex, label) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) {
    throw new Error(label + ' has invalid byte encoding');
  }
  const result = new Uint8Array(hex.length / 2);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(hex.slice(index * 2, (index * 2) + 2), 16);
  }
  return result;
}

function bytesHex(bytes) {
  let result = '';
  for (let index = 0; index < bytes.length; index += 1) {
    result += bytes[index].toString(16).padStart(2, '0');
  }
  return result;
}

function scalarUtf8(value, label) {
  if (typeof value !== 'string') throw new Error(label + ' must be text');
  const octets = [];
  for (let index = 0; index < value.length; index += 1) {
    let point = value.charCodeAt(index);
    if (point >= 0xd800 && point <= 0xdbff) {
      if (index + 1 >= value.length) throw new Error(label + ' has an isolated surrogate');
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) throw new Error(label + ' has an isolated surrogate');
      point = 0x10000 + ((point - 0xd800) * 0x400) + (low - 0xdc00);
      index += 1;
    } else if (point >= 0xdc00 && point <= 0xdfff) {
      throw new Error(label + ' has an isolated surrogate');
    }
    if (point <= 0x7f) {
      octets.push(point);
    } else if (point <= 0x7ff) {
      octets.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
    } else if (point <= 0xffff) {
      octets.push(
        0xe0 | (point >> 12),
        0x80 | ((point >> 6) & 0x3f),
        0x80 | (point & 0x3f)
      );
    } else {
      octets.push(
        0xf0 | (point >> 18),
        0x80 | ((point >> 12) & 0x3f),
        0x80 | ((point >> 6) & 0x3f),
        0x80 | (point & 0x3f)
      );
    }
  }
  return new Uint8Array(octets);
}

function strictUtf8Decode(bytes, label) {
  let result = '';
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index];
    let point;
    let width;
    if (first <= 0x7f) {
      point = first;
      width = 1;
    } else if (first >= 0xc2 && first <= 0xdf) {
      point = first & 0x1f;
      width = 2;
    } else if (first >= 0xe0 && first <= 0xef) {
      point = first & 0x0f;
      width = 3;
    } else if (first >= 0xf0 && first <= 0xf4) {
      point = first & 0x07;
      width = 4;
    } else {
      throw new Error(label + ' has malformed UTF-8');
    }
    if (index + width > bytes.length) throw new Error(label + ' has malformed UTF-8');
    for (let offset = 1; offset < width; offset += 1) {
      const next = bytes[index + offset];
      if (next < 0x80 || next > 0xbf) throw new Error(label + ' has malformed UTF-8');
      point = (point << 6) | (next & 0x3f);
    }
    if (
      (width === 3 && point < 0x800) ||
      (width === 4 && point < 0x10000) ||
      (point >= 0xd800 && point <= 0xdfff) ||
      point > 0x10ffff
    ) {
      throw new Error(label + ' has malformed UTF-8');
    }
    result += String.fromCodePoint(point);
    index += width;
  }
  return result;
}

function storedText(row, field, nullable, maxBytes) {
  const storageClass = row[field + '_type'];
  if (storageClass === 'null' && nullable) return null;
  if (storageClass !== 'text') throw new Error(field + ' has invalid storage class');
  const bytes = bytesFromHex(row[field + '_hex'], field);
  if (maxBytes !== null && maxBytes !== undefined && bytes.length > maxBytes) {
    throw new Error(field + ' exceeds its byte limit');
  }
  const decoded = strictUtf8Decode(bytes, field);
  if (decoded !== row[field]) throw new Error(field + ' text value does not match stored bytes');
  const encoded = scalarUtf8(row[field], field);
  if (bytesHex(encoded) !== bytesHex(bytes)) throw new Error(field + ' text bytes are not stable');
  return row[field];
}

function concatenate(parts) {
  let length = 0;
  for (const part of parts) length += part.length;
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function ku32(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error('frame length is out of range');
  }
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff
  ]);
}

function framedHash(payloads) {
  const digest = createHash('sha256');
  for (const payload of payloads) {
    digest.update(ku32(payload.length));
    digest.update(payload);
  }
  return digest.digest('hex');
}

function byteHash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function typedText(value, label) {
  return concatenate([new Uint8Array([2]), scalarUtf8(value, label)]);
}

function typedInteger(value, label) {
  assertSafePositive(value, label);
  return concatenate([new Uint8Array([1]), scalarUtf8(String(value), label)]);
}

function typedNullableText(value, label) {
  return value === null ? new Uint8Array([0]) : typedText(value, label);
}

function typedNullableInteger(value, label) {
  return value === null ? new Uint8Array([0]) : typedInteger(value, label);
}

function sourceIdentityDigest(value) {
  let sourceId;
  if (value.sourceIdType === 'null') {
    sourceId = new Uint8Array([0]);
  } else if (value.sourceIdType === 'integer') {
    sourceId = typedInteger(value.sourceId, 'source_id');
  } else if (value.sourceIdType === 'text') {
    sourceId = typedText(value.sourceId, 'source_id');
  } else {
    throw new Error('source_id has invalid storage class');
  }
  const payloads = [
    typedText('tm-knowledge-legacy-source-v1', 'source identity version'),
    typedInteger(value.id, 'knowledge entry id'),
    typedNullableText(value.entryType, 'entry_type'),
    typedNullableText(value.sourceType, 'source_type'),
    sourceId,
    typedNullableText(value.sourceHash, 'source_hash'),
    typedNullableText(value.businessType, 'business_type'),
    typedNullableText(value.businessId, 'business_id'),
    typedNullableInteger(value.createdBy, 'created_by')
  ];
  return {
    digest: framedHash(payloads),
    frameKey: payloads.map((payload) => bytesHex(payload)).join(':')
  };
}

function assertSourceGoldenVectors() {
  const integerVector = sourceIdentityDigest({
    id: 7,
    entryType: 'note',
    sourceType: null,
    sourceId: 42,
    sourceIdType: 'integer',
    sourceHash: 'legacy|hash',
    businessType: 'campaign',
    businessId: '9',
    createdBy: null
  });
  const textVector = sourceIdentityDigest({
    id: 8,
    entryType: 'uploaded_document',
    sourceType: 'knowledge_upload',
    sourceId: 'brief.csv',
    sourceIdType: 'text',
    sourceHash: null,
    businessType: null,
    businessId: null,
    createdBy: 3
  });
  if (integerVector.digest !== '5ef2ea4713049f94cfa5078d44b1859ce67b26f36531468ebc3c0350b8ab5b87') {
    throw new Error('integer source identity golden vector mismatch');
  }
  if (textVector.digest !== '8803bcd08efc90d2647c179b1ddde143a3ddfd98b6387e90514fa0082fae43f2') {
    throw new Error('text source identity golden vector mismatch');
  }
}

function compareUtf8(left, right) {
  const leftBytes = scalarUtf8(left, 'sort value');
  const rightBytes = scalarUtf8(right, 'sort value');
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index];
  }
  return leftBytes.length - rightBytes.length;
}

function normalizedDigestText(value, label) {
  scalarUtf8(value, label);
  const normalized = value.replace(/\r\n?/g, '\n').normalize('NFC');
  scalarUtf8(normalized, label);
  return normalized;
}

function parsedTags(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (_error) {
    throw new Error('tags_json is malformed');
  }
  if (!Array.isArray(parsed)) throw new Error('tags_json must be an array');
  for (const tag of parsed) {
    if (typeof tag !== 'string') throw new Error('tags_json contains a non-text value');
    scalarUtf8(tag, 'knowledge tag');
  }
  return parsed;
}

function uniqueSorted(values) {
  const result = [];
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  result.sort(compareUtf8);
  return result;
}

function normalizedVisibility(value, isPublic) {
  if (value === 'team' || value === 'public' || value === 'shared') return 'team';
  if (value === null && isPublic === 1) return 'team';
  return 'private';
}

function contentDigest(entry) {
  const normalizedTags = uniqueSorted(
    entry.tags.map((tag) => normalizedDigestText(tag, 'knowledge tag'))
  );
  const visibility = (
    entry.visibility === 'private' ||
    entry.visibility === 'team' ||
    entry.visibility === 'public' ||
    entry.visibility === 'shared'
  ) ? entry.visibility : normalizedVisibility(entry.visibility, entry.isPublic);
  const values = [
    'tm-knowledge-content-v1',
    entry.entryType,
    normalizedDigestText(entry.title, 'knowledge title'),
    normalizedDigestText(entry.summary, 'knowledge summary'),
    normalizedDigestText(entry.content, 'knowledge content'),
    JSON.stringify(normalizedTags),
    visibility
  ];
  const payloads = values.map((value, index) => scalarUtf8(value, 'content frame ' + index));
  return {
    digest: framedHash(payloads),
    frameKey: JSON.stringify(values)
  };
}

function tableInfo(db, tableName) {
  return db.prepare('PRAGMA table_info(' + JSON.stringify(tableName) + ')').all();
}

function compatibilityTargets() {
  const result = [];
  for (const sql of ALTER_SQL) {
    const match = /^ALTER TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+ADD COLUMN\s+([A-Za-z_][A-Za-z0-9_]*)\b/i.exec(sql);
    if (!match) throw new Error('invalid compatibility target');
    result.push({ table: match[1], column: match[2] });
  }
  return result;
}

function assertOwnedShapeConstants() {
  if (Object.keys(TABLE_SQL).length !== EXPECTED_COUNTS.tables) throw new Error('002 table count mismatch');
  if (ALTER_SQL.length !== EXPECTED_COUNTS.compatibilityColumns) {
    throw new Error('002 compatibility column count mismatch');
  }
  if (Object.keys(INDEX_SQL).length !== EXPECTED_COUNTS.indexes) throw new Error('002 index count mismatch');
  if (Object.keys(TRIGGER_SQL).length !== EXPECTED_COUNTS.triggers) throw new Error('002 trigger count mismatch');
}

function assertNoPartial002(db) {
  const names = [
    ...Object.keys(TABLE_SQL),
    ...Object.keys(INDEX_SQL),
    ...Object.keys(TRIGGER_SQL)
  ];
  for (const name of names) {
    const found = db.prepare('SELECT type FROM sqlite_schema WHERE name=?').get(name);
    if (found) throw new Error('partial 002 object exists: ' + name);
  }
  const byTable = {};
  for (const target of compatibilityTargets()) {
    if (!byTable[target.table]) {
      byTable[target.table] = new Set(tableInfo(db, target.table).map((column) => column.name));
    }
    if (byTable[target.table].has(target.column)) {
      throw new Error('partial 002 compatibility column exists: ' + target.table + '.' + target.column);
    }
  }
  const identityRows = db.prepare(
    "SELECT COUNT(*) AS count FROM activity_log WHERE module='identity' AND action='identity_state_changed'"
  ).get();
  if (identityRows.count !== 0) throw new Error('partial 002 identity backfill exists');
}

function integerBounds(rule) {
  if (rule === 'boolean') return [0, 1];
  if (rule === 'probability') return [0, 100];
  if (rule === 'nonnegative') return [0, SAFE_MAX];
  return [1, SAFE_MAX];
}

function assertLegacyIntegers(db) {
  for (const [table, columns] of Object.entries(INTEGER_RULES)) {
    for (const [column, rule] of Object.entries(columns)) {
      const bounds = integerBounds(rule);
      const identifier = quoteIdentifier(column);
      const sql = (
        'SELECT COUNT(*) AS count FROM ' + quoteIdentifier(table) +
        ' WHERE ' + identifier + ' IS NOT NULL AND (' +
        'typeof(' + identifier + ")<>'integer' OR " + identifier + '<? OR ' + identifier + '>?)'
      );
      const row = db.prepare(sql).get(bounds[0], bounds[1]);
      if (row.count !== 0) throw new Error('invalid integer storage: ' + table + '.' + column);
    }
  }
  const sourceFailure = db.prepare(`
    SELECT COUNT(*) AS count
    FROM knowledge_entries
    WHERE NOT (
      source_id IS NULL
      OR (
        typeof(source_id)='integer'
        AND source_id BETWEEN 1 AND 9007199254740991
      )
      OR typeof(source_id)='text'
    )
  `).get();
  if (sourceFailure.count !== 0) throw new Error('invalid knowledge_entries.source_id storage');

  const sequenceRows = db.prepare(`
    SELECT name,typeof(name) AS name_type,hex(CAST(name AS BLOB)) AS name_hex,
      seq,typeof(seq) AS seq_type
    FROM sqlite_sequence
    ORDER BY name
  `).all();
  const sequenceNames = new Set();
  for (const row of sequenceRows) {
    const name = storedText(row, 'name', false, null);
    if (sequenceNames.has(name)) throw new Error('duplicate sqlite_sequence row');
    sequenceNames.add(name);
    if (row.seq_type !== 'integer' || !Number.isSafeInteger(row.seq) || row.seq < 0 || row.seq > SAFE_MAX) {
      throw new Error('invalid sqlite_sequence value');
    }
  }
}

function assertNoLegacyOrphans(db) {
  for (const relationship of LEGACY_RELATIONSHIPS) {
    const childTable = relationship[0];
    const childColumn = relationship[1];
    const parentTable = relationship[2];
    const parentColumn = relationship[3];
    const required = relationship[4];
    const child = quoteIdentifier(childColumn);
    const sql = (
      'SELECT COUNT(*) AS count FROM ' + quoteIdentifier(childTable) + ' AS child ' +
      'LEFT JOIN ' + quoteIdentifier(parentTable) + ' AS parent ' +
      'ON parent.' + quoteIdentifier(parentColumn) + '=child.' + child + ' WHERE ' +
      (required ? 'child.' + child + ' IS NULL OR ' : '') +
      '(child.' + child + ' IS NOT NULL AND parent.' + quoteIdentifier(parentColumn) + ' IS NULL)'
    );
    const row = db.prepare(sql).get();
    if (row.count !== 0) {
      throw new Error('legacy orphan: ' + childTable + '.' + childColumn);
    }
  }
}

function departmentProjection(rawDepartment, hashRegistry) {
  if (rawDepartment === null) {
    return { code: 'legacy-unassigned', name: '未分组' };
  }
  const display = rawDepartment
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\p{White_Space}+/gu, ' ')
    .replace(/^ +| +$/g, '');
  if (display.length === 0) return { code: 'legacy-unassigned', name: '未分组' };
  const normalized = rawDepartment.normalize('NFC');
  const normalizedBytes = scalarUtf8(normalized, 'users.department');
  const hash = byteHash(normalizedBytes);
  const normalizedHex = bytesHex(normalizedBytes);
  if (hashRegistry.has(hash) && hashRegistry.get(hash) !== normalizedHex) {
    throw new Error('department digest collision');
  }
  hashRegistry.set(hash, normalizedHex);
  const points = [...display];
  const name = points.length <= 160
    ? display
    : points.slice(0, 136).join('') + '... [' + hash.slice(0, 16) + ']';
  return { code: 'legacy-dept-' + hash, name };
}

function collectUsers(db) {
  const rows = db.prepare(`
    SELECT
      id,
      role,typeof(role) AS role_type,hex(CAST(role AS BLOB)) AS role_hex,
      department,typeof(department) AS department_type,hex(CAST(department AS BLOB)) AS department_hex,
      created_at,typeof(created_at) AS created_at_type,hex(CAST(created_at AS BLOB)) AS created_at_hex,
      is_active,
      COALESCE(strftime('%Y-%m-%d %H:%M:%S',created_at),'1970-01-01 00:00:00') AS canonical_created_at
    FROM users
    ORDER BY id
  `).all();
  const hashRegistry = new Map();
  const users = [];
  for (const row of rows) {
    assertSafePositive(row.id, 'users.id');
    if (row.is_active !== 0 && row.is_active !== 1) {
      throw new Error('users.is_active must be an exact integer boolean');
    }
    const role = storedText(row, 'role', false, null);
    const department = storedText(row, 'department', true, null);
    if (row.created_at_type !== 'null') storedText(row, 'created_at', false, null);
    if (typeof row.canonical_created_at !== 'string') throw new Error('invalid user timestamp');
    const team = departmentProjection(department, hashRegistry);
    const administrator = role === 'admin';
    users.push({
      id: row.id,
      active: row.is_active,
      createdAt: row.canonical_created_at,
      team,
      platformRole: administrator ? 'platform_admin' : 'member',
      organizationRole: administrator ? 'org_admin' : 'member',
      teamRole: administrator ? 'team_lead' : 'member',
      status: row.is_active === 1 ? 'active' : 'revoked'
    });
  }
  const activityCapacity = db.prepare(`
    SELECT
      COALESCE((SELECT seq FROM sqlite_sequence WHERE name='activity_log'),0) AS sequence_value,
      COALESCE((SELECT MAX(id) FROM activity_log),0) AS maximum_id
  `).get();
  const floor = Math.max(activityCapacity.sequence_value, activityCapacity.maximum_id);
  if (!Number.isSafeInteger(floor) || floor < 0 || floor > SAFE_MAX - users.length) {
    throw new Error('activity_log identifier capacity exhausted');
  }
  return users;
}

function isCanonicalSafeIdText(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 16 || value[0] === '0') {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return false;
  }
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 1 && numeric <= SAFE_MAX &&
    String(numeric) === value;
}

function assertLegacyCampaignReviewIdentity(value) {
  if (value.entryType !== 'campaign_review' && value.sourceType !== 'campaign_review') return;
  const sourceParts = value.sourceIdType === 'text' ? value.sourceId.split(':') : [];
  if (
    value.entryType !== 'campaign_review' ||
    value.sourceType !== 'campaign_review' ||
    sourceParts.length !== 2 ||
    value.businessType !== 'campaign' ||
    !isCanonicalSafeIdText(value.businessId) ||
    sourceParts[0] !== value.businessId ||
    !isCanonicalSafeIdText(sourceParts[1])
  ) {
    throw new Error('invalid legacy campaign review identity');
  }
}

function collectKnowledge(db) {
  const rows = db.prepare(`
    SELECT
      id,
      entry_type,typeof(entry_type) AS entry_type_type,hex(CAST(entry_type AS BLOB)) AS entry_type_hex,
      source_type,typeof(source_type) AS source_type_type,hex(CAST(source_type AS BLOB)) AS source_type_hex,
      source_id,typeof(source_id) AS source_id_type,hex(CAST(source_id AS BLOB)) AS source_id_hex,
      source_hash,typeof(source_hash) AS source_hash_type,hex(CAST(source_hash AS BLOB)) AS source_hash_hex,
      business_type,typeof(business_type) AS business_type_type,hex(CAST(business_type AS BLOB)) AS business_type_hex,
      business_id,typeof(business_id) AS business_id_type,hex(CAST(business_id AS BLOB)) AS business_id_hex,
      created_by,
      is_public,
      title,typeof(title) AS title_type,hex(CAST(title AS BLOB)) AS title_hex,
      summary,typeof(summary) AS summary_type,hex(CAST(summary AS BLOB)) AS summary_hex,
      content,typeof(content) AS content_type,hex(CAST(content AS BLOB)) AS content_hex,
      tags_json,typeof(tags_json) AS tags_json_type,hex(CAST(tags_json AS BLOB)) AS tags_json_hex,
      visibility,typeof(visibility) AS visibility_type,hex(CAST(visibility AS BLOB)) AS visibility_hex
    FROM knowledge_entries
    ORDER BY id
  `).all();
  const entries = [];
  const byId = new Map();
  const sourceDigests = new Map();
  const contentDigests = new Map();
  const campaignReviewSources = new Set();
  for (const row of rows) {
    assertSafePositive(row.id, 'knowledge_entries.id');
    const entryType = storedText(row, 'entry_type', true, null);
    const sourceType = storedText(row, 'source_type', true, null);
    let sourceId = null;
    if (row.source_id_type === 'integer') {
      assertSafePositive(row.source_id, 'knowledge_entries.source_id');
      sourceId = row.source_id;
    } else if (row.source_id_type === 'text') {
      sourceId = storedText(row, 'source_id', false, 4096);
    } else if (row.source_id_type !== 'null') {
      throw new Error('knowledge_entries.source_id has invalid storage class');
    }
    const sourceHash = storedText(row, 'source_hash', true, null);
    const businessType = storedText(row, 'business_type', true, null);
    const businessId = storedText(row, 'business_id', true, null);
    assertLegacyCampaignReviewIdentity({
      entryType,
      sourceType,
      sourceId,
      sourceIdType: row.source_id_type,
      businessType,
      businessId
    });
    if (sourceType === 'campaign_review') {
      const reviewKey = String(sourceId);
      if (campaignReviewSources.has(reviewKey)) {
        throw new Error('duplicate campaign review source');
      }
      campaignReviewSources.add(reviewKey);
    }
    const title = storedText(row, 'title', false, null);
    const summary = storedText(row, 'summary', false, null);
    const content = storedText(row, 'content', false, null);
    const tagsJson = storedText(row, 'tags_json', false, null);
    const visibility = storedText(row, 'visibility', true, null);
    const knownVisibility = (
      visibility === 'private' ||
      visibility === 'team' ||
      visibility === 'public' ||
      visibility === 'shared'
    );
    if (!knownVisibility && row.is_public !== 0 && row.is_public !== 1) {
      throw new Error('knowledge visibility has no safe projection');
    }
    const tags = parsedTags(tagsJson);
    const source = sourceIdentityDigest({
      id: row.id,
      entryType,
      sourceType,
      sourceId,
      sourceIdType: row.source_id_type,
      sourceHash,
      businessType,
      businessId,
      createdBy: row.created_by
    });
    if (sourceDigests.has(source.digest) && sourceDigests.get(source.digest) !== source.frameKey) {
      throw new Error('knowledge source identity digest collision');
    }
    sourceDigests.set(source.digest, source.frameKey);
    const entry = {
      id: row.id,
      entryType: entryType === null ? 'note' : entryType,
      title,
      summary,
      content,
      tags,
      ftsTags: uniqueSorted(tags).join(' '),
      visibility,
      isPublic: row.is_public,
      sourceIdentitySha256: source.digest
    };
    const contentValue = contentDigest(entry);
    if (
      contentDigests.has(contentValue.digest) &&
      contentDigests.get(contentValue.digest) !== contentValue.frameKey
    ) {
      throw new Error('knowledge entry content digest collision');
    }
    contentDigests.set(contentValue.digest, contentValue.frameKey);
    entry.contentSha256 = contentValue.digest;
    entries.push(entry);
    byId.set(entry.id, entry);
  }

  const chunkRows = db.prepare(`
    SELECT
      id,entry_id,chunk_index,
      content,typeof(content) AS content_type,hex(CAST(content AS BLOB)) AS content_hex
    FROM knowledge_chunks
    ORDER BY id
  `).all();
  const chunks = [];
  const tupleKeys = new Set();
  const chunkDigests = new Map();
  const ftsRows = [];
  for (const row of chunkRows) {
    assertSafePositive(row.id, 'knowledge_chunks.id');
    assertSafePositive(row.entry_id, 'knowledge_chunks.entry_id');
    if (!Number.isSafeInteger(row.chunk_index) || row.chunk_index < 0 || row.chunk_index > SAFE_MAX) {
      throw new Error('knowledge_chunks.chunk_index is invalid');
    }
    const tupleKey = row.entry_id + ':' + row.chunk_index;
    if (tupleKeys.has(tupleKey)) throw new Error('duplicate knowledge chunk position');
    tupleKeys.add(tupleKey);
    const entry = byId.get(row.entry_id);
    if (!entry) throw new Error('orphan knowledge chunk');
    const content = storedText(row, 'content', false, null);
    const rawBytes = bytesFromHex(row.content_hex, 'knowledge_chunks.content');
    const digest = byteHash(rawBytes);
    const rawKey = row.content_hex.toLowerCase();
    if (chunkDigests.has(digest) && chunkDigests.get(digest) !== rawKey) {
      throw new Error('knowledge chunk content digest collision');
    }
    chunkDigests.set(digest, rawKey);
    chunks.push({ id: row.id, contentSha256: digest });
    ftsRows.push({
      title: entry.title,
      content,
      tags: entry.ftsTags,
      entryId: entry.id,
      chunkId: row.id
    });
  }
  return { entries, chunks, ftsRows };
}

function preflight(db) {
  assertOwnedShapeConstants();
  assertSourceGoldenVectors();
  assertNoPartial002(db);
  assertLegacyIntegers(db);
  assertNoLegacyOrphans(db);
  const users = collectUsers(db);
  const knowledge = collectKnowledge(db);
  return {
    users,
    entries: knowledge.entries,
    chunks: knowledge.chunks,
    ftsRows: knowledge.ftsRows
  };
}

function createOwnedSchema(db) {
  for (const sql of ALTER_SQL) db.exec(sql);
  db.exec(TABLE_SQL.organizations);
  db.exec(TABLE_SQL.organization_memberships);
  db.exec(TABLE_SQL.teams);
  db.exec(TABLE_SQL.team_memberships);
  db.exec(INDEX_SQL.ux_opportunities_id_customer);
  db.exec(TABLE_SQL.campaigns);
  db.exec(TABLE_SQL.campaign_events);
  db.exec(TABLE_SQL.campaign_record_links);
  db.exec(INDEX_SQL.ux_workflow_instances_campaign_dispatch);
  db.exec(INDEX_SQL.ux_workflow_instances_org_campaign_id);
  db.exec(TABLE_SQL.campaign_workflow_dispatches);
  db.exec(TABLE_SQL.request_idempotency);
}

function installIdentityTriggers(db) {
  for (const name of IDENTITY_TRIGGERS) db.exec(TRIGGER_SQL[name]);
}

function backfillIdentity(db, state) {
  db.prepare(
    'INSERT INTO organizations (code,name,created_at) VALUES (?,?,?)'
  ).run('turingmarket-default', 'TuringMarket', '1970-01-01 00:00:00');
  const organization = db.prepare(
    "SELECT id FROM organizations WHERE code='turingmarket-default'"
  ).get();
  if (!organization) throw new Error('default organization was not created');
  assertSafePositive(organization.id, 'organizations.id');

  const teamsByCode = new Map();
  for (const user of state.users) teamsByCode.set(user.team.code, user.team);
  const teams = [...teamsByCode.values()].sort((left, right) => compareUtf8(left.code, right.code));
  const insertTeam = db.prepare(
    'INSERT INTO teams (org_id,code,name,created_at) VALUES (?,?,?,?)'
  );
  const teamIds = new Map();
  for (const team of teams) {
    insertTeam.run(organization.id, team.code, team.name, '1970-01-01 00:00:00');
    const stored = db.prepare(
      'SELECT id FROM teams WHERE org_id=? AND code=?'
    ).get(organization.id, team.code);
    if (!stored) throw new Error('department team was not created');
    assertSafePositive(stored.id, 'teams.id');
    teamIds.set(team.code, stored.id);
  }

  const insertOrganizationMembership = db.prepare(`
    INSERT INTO organization_memberships (
      org_id,user_id,role_code,status,created_at,revoked_at
    ) VALUES (?,?,?,?,?,?)
  `);
  const insertTeamMembership = db.prepare(`
    INSERT INTO team_memberships (
      org_id,team_id,user_id,role_code,status,created_at,revoked_at
    ) VALUES (?,?,?,?,?,?,?)
  `);
  const insertEvent = db.prepare(`
    INSERT INTO activity_log (
      user_id,action,module,details,ip_address,created_at
    ) VALUES (?,?,?,?,?,?)
  `);
  for (const user of state.users) {
    const teamId = teamIds.get(user.team.code);
    assertSafePositive(teamId, 'teams.id');
    const revokedAt = user.status === 'revoked' ? user.createdAt : null;
    insertOrganizationMembership.run(
      organization.id,
      user.id,
      user.organizationRole,
      user.status,
      user.createdAt,
      revokedAt
    );
    insertTeamMembership.run(
      organization.id,
      teamId,
      user.id,
      user.teamRole,
      user.status,
      user.createdAt,
      revokedAt
    );
    const after = {
      user: {
        platform_role: user.platformRole,
        department_code: user.team.code,
        is_active: user.active
      },
      organization_membership: {
        role_code: user.organizationRole,
        status: user.status
      },
      team_memberships: [{
        team_id: teamId,
        role_code: user.teamRole,
        status: user.status
      }]
    };
    const details = {
      schema_version: 1,
      actor_user_id: null,
      subject_user_id: user.id,
      organization_id: organization.id,
      reason: 'migration_backfill',
      request_id: null,
      changed_fields: [
        'active',
        'department',
        'organization_membership',
        'role',
        'team_memberships'
      ],
      before: null,
      after
    };
    user.teamId = teamId;
    user.detailsJson = JSON.stringify(details);
    insertEvent.run(
      user.id,
      'identity_state_changed',
      'identity',
      user.detailsJson,
      null,
      user.createdAt
    );
  }
  state.organizationId = organization.id;
}

function backfillKnowledgeDigests(db, state) {
  const updateEntry = db.prepare(`
    UPDATE knowledge_entries
    SET source_identity_sha256=?,content_sha256=?
    WHERE id=?
  `);
  for (const entry of state.entries) {
    const result = updateEntry.run(entry.sourceIdentitySha256, entry.contentSha256, entry.id);
    if (result.changes !== 1) throw new Error('knowledge entry digest backfill count mismatch');
  }
  const updateChunk = db.prepare(
    'UPDATE knowledge_chunks SET content_sha256=? WHERE id=?'
  );
  for (const chunk of state.chunks) {
    const result = updateChunk.run(chunk.contentSha256, chunk.id);
    if (result.changes !== 1) throw new Error('knowledge chunk digest backfill count mismatch');
  }
}

function sameFtsRow(left, right) {
  return (
    left.title === right.title &&
    left.content === right.content &&
    left.tags === right.tags &&
    left.entry_id === right.entryId &&
    left.chunk_id === right.chunkId
  );
}

function verifyFtsProjection(db, expectedRows) {
  const actualRows = db.prepare(`
    SELECT title,content,tags,entry_id,chunk_id
    FROM knowledge_chunks_fts
    ORDER BY CAST(chunk_id AS INTEGER),rowid
  `).all();
  if (actualRows.length !== expectedRows.length) throw new Error('knowledge FTS row count mismatch');
  for (let index = 0; index < expectedRows.length; index += 1) {
    if (!sameFtsRow(actualRows[index], expectedRows[index])) {
      throw new Error('knowledge FTS projection mismatch');
    }
  }
  const canaries = ['orchidprivate', 'quartzpublic', 'zephyrshared', 'nebulateam'];
  for (const term of canaries) {
    const expectedIds = expectedRows
      .filter((row) => (
        row.title.includes(term) ||
        row.content.includes(term) ||
        row.tags.includes(term)
      ))
      .map((row) => row.chunkId);
    if (expectedIds.length === 0) continue;
    const actualIds = db.prepare(`
      SELECT chunk_id
      FROM knowledge_chunks_fts
      WHERE knowledge_chunks_fts MATCH ?
      ORDER BY CAST(chunk_id AS INTEGER)
    `).all(term).map((row) => row.chunk_id);
    if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
      throw new Error('knowledge FTS canary mismatch');
    }
  }
}

function rebuildFts(db, expectedRows) {
  db.prepare('DELETE FROM knowledge_chunks_fts').run();
  const insert = db.prepare(`
    INSERT INTO knowledge_chunks_fts (title,content,tags,entry_id,chunk_id)
    VALUES (?,?,?,?,?)
  `);
  for (const row of expectedRows) {
    insert.run(row.title, row.content, row.tags, row.entryId, row.chunkId);
  }
  db.prepare(
    "INSERT INTO knowledge_chunks_fts(knowledge_chunks_fts) VALUES('integrity-check')"
  ).run();
  verifyFtsProjection(db, expectedRows);
}

function installRemainingObjects(db) {
  for (const [name, sql] of Object.entries(INDEX_SQL)) {
    if (EARLY_INDEXES.includes(name)) continue;
    db.exec(sql);
  }
  for (const [name, sql] of Object.entries(TRIGGER_SQL)) {
    if (IDENTITY_TRIGGERS.includes(name)) continue;
    db.exec(sql);
  }
}

function verifyFinalState(db, state) {
  const listedTables = db.prepare('PRAGMA table_list').all();
  for (const tableName of TABLE_ORDER) {
    const row = listedTables.find((table) => table.schema === 'main' && table.name === tableName);
    if (!row || row.type !== 'table' || row.strict !== 1) {
      throw new Error('invalid final domain table: ' + tableName);
    }
  }
  for (const target of compatibilityTargets()) {
    const column = tableInfo(db, target.table).find((item) => item.name === target.column);
    if (!column) throw new Error('missing final compatibility column');
  }
  for (const name of Object.keys(INDEX_SQL)) {
    const row = db.prepare("SELECT type FROM sqlite_schema WHERE type='index' AND name=?").get(name);
    if (!row) throw new Error('missing final index: ' + name);
  }
  for (const name of Object.keys(TRIGGER_SQL)) {
    const row = db.prepare("SELECT type FROM sqlite_schema WHERE type='trigger' AND name=?").get(name);
    if (!row) throw new Error('missing final trigger: ' + name);
  }
  const digestEntryCount = db.prepare(
    'SELECT COUNT(*) AS count FROM knowledge_entries WHERE source_identity_sha256 IS NULL OR content_sha256 IS NULL'
  ).get();
  if (digestEntryCount.count !== 0) throw new Error('knowledge entry digest backfill is incomplete');
  const digestChunkCount = db.prepare(
    'SELECT COUNT(*) AS count FROM knowledge_chunks WHERE content_sha256 IS NULL'
  ).get();
  if (digestChunkCount.count !== 0) throw new Error('knowledge chunk digest backfill is incomplete');
  const readEntryDigest = db.prepare(
    'SELECT source_identity_sha256,content_sha256 FROM knowledge_entries WHERE id=?'
  );
  for (const entry of state.entries) {
    const row = readEntryDigest.get(entry.id);
    if (
      !row ||
      row.source_identity_sha256 !== entry.sourceIdentitySha256 ||
      row.content_sha256 !== entry.contentSha256
    ) {
      throw new Error('knowledge entry digest verification failed');
    }
  }
  const readChunkDigest = db.prepare(
    'SELECT content_sha256 FROM knowledge_chunks WHERE id=?'
  );
  for (const chunk of state.chunks) {
    const row = readChunkDigest.get(chunk.id);
    if (!row || row.content_sha256 !== chunk.contentSha256) {
      throw new Error('knowledge chunk digest verification failed');
    }
  }
  const snapshots = db.prepare(
    'SELECT COUNT(*) AS count FROM ai_references WHERE ' +
    SNAPSHOT_COLUMNS.map((column) => quoteIdentifier(column) + ' IS NOT NULL').join(' OR ')
  ).get();
  if (snapshots.count !== 0) throw new Error('legacy AI reference snapshot was modified');
  const templateContext = db.prepare(
    'SELECT COUNT(*) AS count FROM workflow_templates WHERE trigger_config_json IS NOT NULL'
  ).get();
  if (templateContext.count !== 0) throw new Error('legacy workflow template context was modified');
  const workflowContext = db.prepare(`
    SELECT COUNT(*) AS count
    FROM workflow_instances
    WHERE org_id IS NOT NULL
      OR campaign_id IS NOT NULL
      OR campaign_event_id IS NOT NULL
      OR campaign_dispatch_id IS NOT NULL
      OR initialization_status IS NOT NULL
      OR initialization_error IS NOT NULL
      OR execution_error_code IS NOT NULL
      OR execution_error IS NOT NULL
      OR execution_failed_at IS NOT NULL
  `).get();
  if (workflowContext.count !== 0) throw new Error('legacy workflow context was modified');
  const taskVersions = db.prepare(
    "SELECT COUNT(*) AS count FROM workflow_tasks WHERE typeof(assignment_version)<>'integer' OR assignment_version<>1"
  ).get();
  if (taskVersions.count !== 0) throw new Error('legacy workflow assignment version mismatch');
  const organizationCount = db.prepare(
    'SELECT COUNT(*) AS count FROM organization_memberships WHERE org_id=?'
  ).get(state.organizationId);
  const teamCount = db.prepare(
    'SELECT COUNT(*) AS count FROM team_memberships WHERE org_id=?'
  ).get(state.organizationId);
  const eventCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM activity_log
    WHERE module='identity' AND action='identity_state_changed'
  `).get();
  if (
    organizationCount.count !== state.users.length ||
    teamCount.count !== state.users.length ||
    eventCount.count !== state.users.length
  ) {
    throw new Error('identity backfill cardinality mismatch');
  }
  const readOrganizationMembership = db.prepare(`
    SELECT role_code,status,created_at,revoked_at
    FROM organization_memberships
    WHERE org_id=? AND user_id=?
  `);
  const readTeamMembership = db.prepare(`
    SELECT role_code,status,created_at,revoked_at
    FROM team_memberships
    WHERE org_id=? AND team_id=? AND user_id=?
  `);
  const readIdentityEvent = db.prepare(`
    SELECT details,ip_address,created_at
    FROM activity_log
    WHERE user_id=? AND module='identity' AND action='identity_state_changed'
  `);
  for (const user of state.users) {
    const expectedRevokedAt = user.status === 'revoked' ? user.createdAt : null;
    const organizationMembership = readOrganizationMembership.get(state.organizationId, user.id);
    const teamMembership = readTeamMembership.get(
      state.organizationId,
      user.teamId,
      user.id
    );
    const event = readIdentityEvent.get(user.id);
    if (
      !organizationMembership ||
      organizationMembership.role_code !== user.organizationRole ||
      organizationMembership.status !== user.status ||
      organizationMembership.created_at !== user.createdAt ||
      organizationMembership.revoked_at !== expectedRevokedAt ||
      !teamMembership ||
      teamMembership.role_code !== user.teamRole ||
      teamMembership.status !== user.status ||
      teamMembership.created_at !== user.createdAt ||
      teamMembership.revoked_at !== expectedRevokedAt ||
      !event ||
      event.details !== user.detailsJson ||
      event.ip_address !== null ||
      event.created_at !== user.createdAt
    ) {
      throw new Error('identity backfill projection mismatch');
    }
  }
  verifyFtsProjection(db, state.ftsRows);
}

function apply(db) {
  const state = preflight(db);
  createOwnedSchema(db);
  installIdentityTriggers(db);
  backfillIdentity(db, state);
  backfillKnowledgeDigests(db, state);
  rebuildFts(db, state.ftsRows);
  installRemainingObjects(db);
  verifyFinalState(db, state);
}

module.exports = {
  version: 2,
  name: '002_campaign_business_spine',
  sourcePath: 'migrations/002_campaign_business_spine.js',
  engineVersion: 1,
  dependencies: ['migrations/vendor/bcryptjs_v3_0_3.js'],
  schemaManifest: SCHEMA_MANIFEST,
  apply
};

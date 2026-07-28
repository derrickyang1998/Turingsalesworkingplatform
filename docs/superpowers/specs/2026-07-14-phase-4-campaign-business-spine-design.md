# Phase 4 Campaign Business Spine Design / 第 4 阶段活动业务主链设计

## Approval And Goal / 批准与目标

The user approved Scheme A and the bilingual V1 roadmap. Phase 4 delivers `v0.5.0-campaign-business-spine`: versioned migrations, organization/team membership, a canonical campaign, durable business-record links, backend authorization, append-only lifecycle events, durable workflow dispatch, and an operational project workspace.

用户已批准方案 A 与 V1 中英双语路线图。本阶段交付 `v0.5.0-campaign-business-spine`：版本化迁移、组织与团队成员关系、统一活动实体、持久业务关联、后端权限、仅追加生命周期事件、可靠工作流派发和可操作的项目工作台。

## Frozen Task 3 Schema Contract / Task 3 冻结数据库合同

The independently frozen `002` schema inventory is `platform/server/tests/fixtures/campaign_schema_contract.js`; it does not import the migration implementation. It is the release gate for all executable index and trigger SQL. The final contract contains 9 STRICT domain tables, 23 compatibility columns, 10 named indexes, 51 named triggers, and 17 composite foreign-key contracts. Earlier inline DDL in this design explains individual invariants, but the complete ordered inventory and the following fingerprints are normative whenever an excerpt is incomplete:

- index SQL SHA-256: `bdb5508e1a02c0cf88fd763e1d9b664e192660503d87dcd7afd39517cfedeb3c`
- trigger SQL SHA-256: `d7fffc8dbb15f7e77de0b65038fc100f4b15e2b0cc3bd89b3672f7427ce570f6`
- combined index/trigger SQL SHA-256: `5e8cd0a587b10899a676634e8c82aa841bf7e1e7201c5cb5aec863614ee38d00`
- complete managed 26-index/54-trigger SQL SHA-256: `14e3dfa8d56070983336e62660f328cf3e274d66f1839c2a6d89d90b3d4d952e`

The final 51-trigger inventory explicitly includes the four conflict-preservation guards added during independent review: `organizations_no_replace_insert`, `campaign_settled_collaboration_no_replace_insert`, `campaign_workflow_task_no_replace_insert`, and `knowledge_entries_no_replace_insert`. The frozen digest also covers every reviewed body expansion for idempotency, workflow, AI-reference, link, event, knowledge-entry, and knowledge-chunk conflict handling.

`002` 的独立冻结结构清单位于 `platform/server/tests/fixtures/campaign_schema_contract.js`，该文件不导入迁移实现。最终合同精确包含 9 张 STRICT 业务表、23 个兼容列、10 个命名索引、51 个命名触发器和 17 组复合外键。上面的三组 SHA-256 与完整有序名称清单共同构成发布门禁；设计正文中的局部 DDL 用于解释约束，若摘录不完整，以独立冻结清单和指纹为准。

## Scope Contract / 范围契约

Phase 4 is additive and owns only the business spine. It does not redesign CRM stages, AI prompt/retrieval meaning, provider selection, influencer ordering or settlement semantics, entitlements, or the frozen PPT renderer. It may add campaign custody, deterministic chunk/reference contracts, cancellation/deadline propagation, and atomic persistence around the existing AI providers without changing the unlinked v0.4 fallback behavior. Existing records keep their current behavior until a user explicitly links them to a campaign. Free text such as project, brand, or notes is never used to infer a campaign, customer, opportunity, team, or link.

第 4 阶段采用增量方式，只建设业务主链。未显式关联活动的历史记录继续按原规则工作；不得根据项目名、品牌名或备注推断业务关联。

## Component Boundaries / 组件边界

1. `migration_service.js` runs ordered, transactional, source-checksummed migrations before the server listens.
2. `organization_access_service.js` resolves stable organization, role, team, and membership scopes while preserving legacy `users.role` and `users.department` as compatibility fields.
3. `campaign_access_service.js` enforces organization concealment and campaign access at route and collection-query boundaries.
4. `campaign_service.js` owns non-workflow campaign validation, idempotent mutations, lifecycle guards, transfers, link corrections, events, and workspace aggregation.
5. `campaign_workflow_service.js` owns template predicates, durable dispatch claims, instance creation, retry, reconciliation, task reassignment, and workflow recovery.
6. `routes_campaigns.js` exposes the focused API and exact validators in `contracts/campaign_contract.js`; workflow retry/reconciliation/reassignment handlers mounted there delegate to `campaign_workflow_service.js`, never `campaign_service.js`.
7. The project workspace extends the current static application and Phase 3 design system. It is not a second CRM or a replacement editor.

## Migration Ledger And Ordering / 迁移账本与顺序

The runner owns this ledger DDL, but it does not create the ledger before classifying and preflighting the source database:

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  name TEXT NOT NULL UNIQUE CHECK (length(trim(name)) BETWEEN 1 AND 120),
  checksum TEXT NOT NULL CHECK (
    length(checksum) = 64
    AND checksum = lower(checksum)
    AND checksum NOT GLOB '*[^0-9a-f]*'
  ),
  source_path TEXT NOT NULL,
  engine_version INTEGER NOT NULL CHECK (engine_version > 0),
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(strftime('%Y-%m-%d %H:%M:%S',applied_at) IS NOT NULL AND strftime('%Y-%m-%d %H:%M:%S',applied_at)=applied_at)
) STRICT;
```

Migration ordering is fixed:

1. `migrations/baselines/legacy_v1.js` is an immutable runner dependency, not untracked bootstrap code. Its exact bytes and `engine_version` are framed into the checksums of `001` and `002`, so drift fails before mutation even though the legacy baseline has no separate ledger row.
2. Read-only classification has five exact outcomes before any mutation: `empty` has no application tables and no ledger; `legacy` has the complete immutable legacy object family and no ledger; `managed` has the exact ledger DDL plus a valid contiguous known prefix of applied migrations; `partial_or_malformed` has a ledger/object mixture, malformed/duplicate/gapped ledger, missing baseline object, or checksum/schema mismatch; and `future` has a valid ledger version above the executable maximum. Only `empty`, `legacy`, and `managed` may continue. `partial_or_malformed` and `future` fail before any write. A managed database is never compared to the pristine-legacy object set; it is validated against the immutable baseline plus each applied migration manifest in ledger order.
3. For `legacy` and `managed`, the runner first opens the database read-only and performs the classification-specific complete schema/object/orphan/integrity/checksum preflight. It records file identity plus the normalized schema/data preflight digest, reopens read-write, acquires `BEGIN EXCLUSIVE`, and repeats classification and digest validation before mutation. A managed database at version `001` applies only later registered migrations; a managed database at the current version performs a verified no-op. Close/reopen fixtures cover every known applied version.
4. For `empty`, one outer transaction executes the exact legacy baseline, creates the ledger, applies `001`, runs both frozen v0.4 seed admissions once, applies `002`, verifies the final schema/invariants, and commits once. A crash or error rolls back the baseline, seed rows, and ledger together; there is no partially initialized unledgered database.
5. For `legacy`, the same single outer transaction creates the ledger, applies `001_legacy_compat_columns.js`, runs both frozen v0.4 seed admissions once, applies `002_campaign_business_spine.js`, verifies the final schema/invariants, and commits once. The user predicate is exactly `SELECT id FROM users WHERE role='admin' LIMIT 1`: when a row exists, zero users are inserted; when none exists, only the configured administrator plus the exact ten v0.4 team fixtures are attempted with the existing environment/password and uniqueness behavior. It is never reinterpreted as “insert each missing username.” The influencer predicate remains independently exact `SELECT COUNT(*) AS count FROM influencers`: count zero inserts the exact fifteen immutable v0.4 portfolio rows in their existing order; any positive count inserts none and never fills missing handles. Empty/partial influencer and admin/no-admin fixtures lock both predicates, rollback, and rerun. `001` replaces swallowed `ALTER TABLE` blocks with explicit `PRAGMA table_info` checks. `002` creates exactly nine Phase 4 domain tables, backfills memberships, and adds the documented compatibility columns/indexes to existing workflow, knowledge, chunk, and reference tables.

The nine tables owned by `002` are `organizations`, `organization_memberships`, `teams`, `team_memberships`, `campaigns`, `campaign_record_links`, `campaign_events`, `campaign_workflow_dispatches`, and `request_idempotency`. `schema_migrations` is runner-owned and is not counted as a domain table.

`002` also owns an explicit compatibility manifest for existing knowledge and AI tables. It adds `knowledge_entries.source_identity_sha256`, `knowledge_entries.content_sha256`, `knowledge_chunks.content_sha256`, and the following immutable reference-snapshot columns to `ai_references`: `reference_schema_version`, `knowledge_entry_id`, `knowledge_chunk_id`, `campaign_id`, `source_identity_sha256`, `entry_content_sha256`, `chunk_content_sha256`, `reference_rank`, and `selection_origin`. Every new campaign-linked knowledge reference uses `reference_schema_version=1`, one row per chunk, positive JavaScript-safe IDs, lowercase 64-hex digests, a positive unique rank per assistant message, and `selection_origin IN ('selected','retrieved')`; legacy rows retain null version/snapshot fields and are never rewritten as current evidence. Partial presence, incompatible affinity, unsafe legacy IDs/versions, malformed digest columns, or a collision in the deterministic backfill fails preflight before mutation.

Knowledge migration validates but does not rewrite the stored legacy visibility token. Exact legacy `private|team|public|shared` remains byte-for-byte so truly unlinked v0.4 responses stay unchanged; an unknown/null value is accepted only when exact integer `is_public=0|1` can supply the internal access projection, otherwise migration fails. Every campaign-aware authorization/query/RAG/archive serializer derives `normalized_visibility = CASE WHEN visibility IN ('team','public','shared') OR (visibility IS NULL AND is_public=1) THEN 'team' ELSE 'private' END`; all new Phase 4 writes accept/store only `private|team`, while explicit truly-unlinked legacy serializers continue returning their original `visibility` value. On campaign-linked public knowledge create/ingest/upload, omitted `visibility` stores `private`; an explicit value must be exactly `private|team`; `public`, `shared`, every other token, and compatibility field `is_public` return zero-mutation `400 INVALID_CAMPAIGN_INPUT` rather than being normalized. Every legacy entry receives an immutable source identity under `tm-knowledge-legacy-source-v1`, framed from its safe entry ID plus its exact legacy source fields, so unrelated legacy rows cannot collide even when the old `source_hash` is duplicated. Entry and chunk content digests use the exact `tm-knowledge-content-v1` and chunk-byte rules below. A unique partial index covers non-null source identities; before it is created, the migration groups by identity, rejects any digest/content mismatch, and refuses to merge or delete rows. Reference-snapshot triggers reject updates to every version-1 snapshot field.

The legacy identity grammar is executable and independent of SQLite affinity. `KU32` is unsigned four-byte big-endian, `KFRAME(bytes)=KU32(byteLength(bytes)) || bytes`, `KNULL=0x00`, `KINT(n)=0x01 || UTF8(canonical safe decimal n)`, and `KTEXT(s)=0x02 || UTF8(exact SQLite TEXT s)`. Text is not normalized for this source-identity backfill; it must already be a valid Unicode scalar sequence, so malformed UTF-8/isolated-surrogate input fails preflight. The digest input is exactly nine frames in this order: `KFRAME(KTEXT("tm-knowledge-legacy-source-v1"))`, `KFRAME(KINT(id))`, `KFRAME(KTEXT|KNULL(entry_type))`, `KFRAME(KTEXT|KNULL(source_type))`, `KFRAME(KINT|KTEXT|KNULL(source_id))`, `KFRAME(KTEXT|KNULL(source_hash))`, `KFRAME(KTEXT|KNULL(business_type))`, `KFRAME(KTEXT|KNULL(business_id))`, and `KFRAME(KINT|KNULL(created_by))`. Legacy `source_id` deliberately accepts INTEGER or TEXT because existing upload/PPT/demand paths persist both numeric IDs and filenames/business labels; INTEGER values must be positive safe IDs, while TEXT values must be valid scalar strings of at most 4,096 UTF-8 bytes. Every other field requires the exact declared NULL/INTEGER/TEXT storage class before hashing. The integer-source golden row `id=7,entry_type="note",source_type=NULL,source_id=42,source_hash="legacy|hash",business_type="campaign",business_id="9",created_by=NULL` hashes to `5ef2ea4713049f94cfa5078d44b1859ce67b26f36531468ebc3c0350b8ab5b87`. The text-source golden row `id=8,entry_type="uploaded_document",source_type="knowledge_upload",source_id="brief.csv",source_hash=NULL,business_type=NULL,business_id=NULL,created_by=3` hashes to `8803bcd08efc90d2647c179b1ddde143a3ddfd98b6387e90514fa0082fae43f2`.

Before `002` writes any compatibility or domain row, preflight enumerates every legacy primary key, foreign-key value, row/template/version counter, workflow instance/task/log/template ID, knowledge entry/chunk/message/reference ID, and `sqlite_sequence.seq` that Phase 4 will read into JavaScript. Every non-null numeric identifier must have SQLite integer storage class and lie within `1..9007199254740991` (counters that legitimately allow zero use `0..9007199254740991`). `knowledge_entries.source_id` is the sole documented polymorphic legacy exception: NULL is accepted; INTEGER follows the same positive-safe bound; TEXT follows the valid-scalar/4,096-byte rule above; REAL/BLOB or any other storage class fails. The corresponding new DDL/insert-update triggers enforce the same bounds. Unsafe affinity conversions, invalid polymorphic text, overflow, or sequence-aware explicit-next-ID exhaustion abort before ledger creation or backfill; no lossy coercion is permitted.

Legacy chunk preflight also requires one row per `(entry_id,chunk_index)`. Any duplicate, negative/unsafe index, or orphan fails before mutation with only table/constraint/count diagnostics; migration never silently renumbers, merges, or drops a chunk. The compatibility DDL is exact; migration JavaScript computes and backfills the framed digests before creating the unique indexes/triggers:

```sql
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
WHEN (
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
BEGIN SELECT RAISE(ABORT,'invalid versioned knowledge reference'); END;

CREATE TRIGGER ai_references_v1_snapshot_immutable
BEFORE UPDATE OF reference_schema_version,knowledge_entry_id,knowledge_chunk_id,campaign_id,
  source_identity_sha256,entry_content_sha256,chunk_content_sha256,reference_rank,selection_origin
ON ai_references
WHEN OLD.reference_schema_version=1 OR NEW.reference_schema_version=1
BEGIN SELECT RAISE(ABORT,'versioned knowledge reference is immutable'); END;
```

After backfill, `SELECT count(*)` requires every entry/chunk digest non-null, every digest recomputes exactly, every version-1 reference joins the same entry/chunk hashes, both unique indexes are collision-free, and legacy references have all snapshot fields null. New entry/chunk creation always goes through the digest-aware knowledge service. Campaign-classified entries/chunks additionally become content-immutable through the campaign-link triggers created later in `002`; truly unlinked legacy entries may still be edited only when the transaction atomically recomputes their content/chunk digests and FTS rows without changing source identity.

Each migration declares its immutable `sourcePath`, exact `engineVersion`, and ordered dependency-file list. Migration files are self-contained except Node built-ins and the frozen API exported by `migrations/engines/v1.js`; the checksum inputs are exactly the migration source, `migrations/engines/v1.js`, `migrations/baselines/legacy_v1.js`, and declared dependency files. Mutable orchestration such as `migration_service.js`, `db.js`, or a later engine is deliberately excluded. Undeclared local imports fail validation. Applied checksum drift, unsupported engine version, duplicate/unknown ledger rows, or a ledger version newer than the executable's maximum version aborts startup. Adding a later migration may change orchestration and add a new immutable engine without invalidating prior rows; a regression fixture proves old checksums remain stable. Every migration row is inserted after its migration work but inside the one successful outer initialization/upgrade transaction. Empty and populated fixtures must converge to the same normalized legacy-plus-Phase-4 schema digest after `002`; value differences caused only by documented seed/backfill inputs are compared separately.

Migration checksums use exact binary grammar `tm-migration-checksum-v1`. `U64` is unsigned big-endian. `FRAME(bytes)=U64(byteLength(bytes)) || bytes`. SHA-256 receives `FRAME(UTF8("tm-migration-checksum-v1")) || U64(engineVersion) || U64(fileCount)` followed by, for each input in exact order, `FRAME(UTF8(path)) || FRAME(exactFileBytes)`. Order is migration source, selected immutable engine, immutable legacy baseline, then unique declared dependencies in declaration order. Paths are NFC UTF-8 repository-relative POSIX paths with `/`, preserve case, contain no empty/`.`/`..` segment or backslash, and are never filesystem-absolute; path comparison is exact bytes on Windows and Linux. `engineVersion` and `fileCount` must be safe positive integers before encoding. The synthetic vector engine `1` with exact files `migrations/001.js`=`one\n` and `migrations/engines/v1.js`=`engine\n` hashes to `2298da2cb6311ed6abf5afeb7463c31455a8a787cd5573cae558829540efc515`. Cross-platform tests must match this vector before reading an applied checksum.

## Exact Schema Contract / 精确结构契约

All ten new tables, including the migration ledger, use SQLite `STRICT` mode. Internal timestamps are UTC `TEXT` generated/normalized by SQLite in `YYYY-MM-DD HH:MM:SS` format; clients cannot supply lease/audit timestamps. Monetary minor units, IDs, counters, and versions are `INTEGER`; JSON and canonical polymorphic IDs are `TEXT`. Every new primary/foreign identifier and externally serialized counter/version is database-constrained to the field-appropriate subset of `1..9007199254740991`; zero is accepted only for explicitly nonnegative counts or money. Before ledger creation, pristine-legacy preflight rejects any referenced legacy primary/foreign ID outside that range, so a later FK cannot import an unsafe integer. Boundary fixtures cover `-1`, `0`, `9007199254740991`, and `9007199254740992` for each ID family. Deployment aborts if the runtime does not support `STRICT`. Existing legacy tables remain non-strict. `PRAGMA foreign_keys=ON` is executed immediately on every connection.

### Organizations And Memberships / 组织与成员

```sql
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
WHEN NEW.module='identity' AND (
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
)
BEGIN
  SELECT RAISE(ABORT,'invalid identity audit event');
END;
```

The immutable default organization code is `turingmarket-default`; code never assumes its numeric ID. Every legacy user joins it. Legacy `admin` maps to `org_admin`; every other or unknown role maps to `member`. Department mapping is total. Null, empty, whitespace-only, or control-only text maps to code `legacy-unassigned` and display name `未分组`. Every other value maps to code `legacy-dept-` plus all 64 lowercase hex characters of SHA-256 over the exact NFC-normalized UTF-8 bytes; the resulting 76-character code fits the 80-character constraint. The display name removes C0/DEL, trims and collapses Unicode whitespace to one ASCII space; at 160 code points or fewer it preserves that human-readable value, otherwise it uses the first 136 code points plus `... [` + the first 16 hash characters + `]`. Before mutation, unequal normalized department byte strings producing the same full hash fail closed. Raw department text remains only in the compatibility field. Admins are team leads; others are members. The backfill is deterministic and idempotent. Membership rows are stable current-state identity projections and are never deleted after campaign/event linkage; revocation sets `status='revoked'` plus canonical `revoked_at`, while reactivation updates that same row and clears `revoked_at`. Role/department/status transition history lives in sanitized `activity_log` events rather than pretending one projection row preserves validity intervals. Every authorization, assignment, options, and aggregate query requires active organization and team memberships, while historical actor labels resolve by user ID without regranting access.

Identity history uses one exact existing-table row: `action='identity_state_changed'`, `module='identity'`, and canonical `details` with keys in this order: `schema_version,actor_user_id,subject_user_id,organization_id,reason,request_id,changed_fields,before,after`. `reason` is one of `migration_backfill|user_create|admin_update|soft_deactivate|reactivate|login_membership_repair`; `changed_fields` is a unique UTF-8-sorted subset of `active,department,organization_membership,role,team_memberships`. `before` and `after` are null or the exact projection `{"user":{"platform_role":"platform_admin|member","department_code":"...","is_active":0|1},"organization_membership":{"role_code":"org_admin|member","status":"active|revoked"}|null,"team_memberships":[{"team_id":2,"role_code":"team_lead|member","status":"active|revoked"}]}` with team rows sorted by integer ID. No username, display label, raw department, password/hash, session/token, IP, request body, or provider data appears in `details`. `activity_log.user_id` is the authenticated actor for live writes; deterministic migration/system events use the subject as the legacy non-null carrier while `actor_user_id` remains null. `request_id` is the validated request ID for live writes and null for migration.

Migration `002` inserts exactly one `migration_backfill` event per pre-existing/seed user in ascending user ID after memberships are materialized, with `before=null`, the full `after` projection, all five changed fields, and deterministic `created_at=COALESCE(strftime('%Y-%m-%d %H:%M:%S',users.created_at),'1970-01-01 00:00:00')`; the schema ledger prevents duplication. Live identity writers compare canonical before/after, emit one aggregate event only when the projection changes, invalidate sessions, and commit user/membership/event changes together. The three database triggers make every legacy and Phase 4 activity row append-only and reject malformed identity events; the service additionally validates the closed nested projection and changed-field diff before insertion. Backfill, no-op, rollback, direct SQL update/delete, malformed JSON, promotion/demotion, department transfer, revoke/reactivate, and login-repair tests are mandatory.

### Campaigns / 活动

`campaigns` uses this canonical executable DDL (index names may vary, constraints may not):

```sql
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
```

Migration creates a unique index on `opportunities(id, customer_id)` for the composite FK. Campaign creation always derives `customer_id` from the selected opportunity, forces `lifecycle_state='lead'` and `operational_status='active'` server-side, and emits `campaign_created` with `previous_state=null`, `next_state='lead'`. Caller-supplied initial states are rejected. Adopting an in-flight legacy project at an arbitrary lifecycle state is explicitly outside Phase 4; users create at `lead`, attach existing records, and advance only when guards pass.

Campaign creation uses the same legal assignment read model as the UI: an org admin may select any active organization owner/team pair; a team lead may select members of a team they lead; an ordinary member may create only a self-owned campaign in a team they belong to. The selected opportunity/customer must pass the existing CRM **manage** rule, not public-pool read visibility. The service recomputes both rules inside the insert transaction rather than trusting an options response.

No campaign hard-delete API exists. Operational actions are audited: active campaigns may be put `on_hold`, on-hold campaigns may resume to `active`, and active/on-hold campaigns may be `cancelled`. Cancelled is terminal. The action matrix is closed. `active` permits authorized lifecycle and linked business writes. `on_hold` permits reads/audit, resume, terminal campaign cancellation, link correction/revocation, and cancellation of an already linked collaboration; it rejects every new linked base record, provider/file operation, collaboration advancement, workflow task action, workflow instance resume/control, reconciliation, retry, and new dispatch claim/finalization. A worker that lost the active predicate discards temporary output and cannot commit; its processing lease is recovered only after resume. `cancelled` permits reads/audit and owner/org-admin evidence correction only, never productive work. Campaign cancellation is one `BEGIN IMMEDIATE` transaction that writes the event; changes each distinct linked nonterminal collaboration in `confirmed|contract_sent|live|content_review` to `cancelled`, increments its bounded `row_version` exactly once, and revokes its complete active `order|execution|publication|settlement` bundle; changes every nonterminal pending/processing/failed-initialization dispatch to terminal `cancelled` with `CAMPAIGN_CANCELLED` evidence while clearing leases/retries; changes active/paused linked instances and every pending task to `cancelled`; completes the request ledger; and invalidates every stale worker token. Completed collaborations and terminal completed/failed/dead-letter workflow evidence remain immutable history. A collaboration already at maximum row version, a missing/mismatched bundle, or any cascade predicate failure aborts the entire campaign cancellation before the campaign, links, collaboration, workflow, event, or ledger can partially commit. Lifecycle transition and every productive linked mutation recheck `operational_status='active'` inside their final transaction.

Operational rejection is exact across every route. A productive request whose final transaction sees `on_hold` completes its idempotency row with `409 CAMPAIGN_ON_HOLD` and details `{ "operational_status":"on_hold" }`; a terminal campaign returns `409 CAMPAIGN_CANCELLED` with `{ "operational_status":"cancelled" }`. Reads and the explicitly allowed hold/cancel recovery actions are exempt. The same codes govern lifecycle transitions, linked creation/update, provider/file finalization, retry, reconciliation, task actions, and instance controls; no route substitutes stale or provider errors for this winner. For workflow task actions and instance controls the decision order after authorization is `cancelled`, then `on_hold`, then endpoint-specific stale state while the campaign is still active. A stale task action has exact safe details `{ "task_status":"pending|completed|rejected|cancelled", "instance_status":"active|paused|completed|cancelled|failed_validation", "campaign_operational_status":"active" }`; null is used only when the corresponding row is absent after an already-authorized lookup. The client keeps unsaved input, refreshes campaign status, and offers resume only to authorized users or a return-to-workspace action. Hold/cancel races are tested before reservation, during provider work, and after `BEGIN IMMEDIATE`; completed error replay requires current access and creates no event/link/base record.

### Events / 事件

```sql
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
```

Event emission is closed and deterministic:

| Event type | Source | Reason | Exact metadata keys |
| --- | --- | --- | --- |
| `campaign_created` | `campaign_api` | server literal `Campaign created` | `customer_id,opportunity_id,owner_user_id,team_id,row_version` |
| `lifecycle_transition` | `project_workspace` | caller `reason` | `previous_version,next_version` |
| `operational_status_changed` | `project_workspace` | caller `reason` | `previous_status,next_status,previous_version,next_version` |
| `operational_status_changed` from later-stage collaboration cancellation | `collaboration_link` | caller `reason` | `previous_status,next_status,previous_version,next_version` |
| `campaign_transferred` | `project_workspace` | caller `reason` | `previous_owner_user_id,next_owner_user_id,previous_team_id,next_team_id,previous_version,next_version` |
| `link_attached` generic attach or same-campaign correction reactivation | `project_workspace` | caller `reason` | `bundle_id,relation_types,record_type,record_id,link_ids` |
| `link_attached` automatic demand/proposal/PPT/AI/knowledge side effect | exact route constant `demand_link|proposal_link|ppt_link|ai_link|knowledge_link` | server literal `Linked ` plus comma-joined UTF-8-sorted `relation_types` | `bundle_id,relation_types,record_type,record_id,link_ids` |
| `link_attached` collaboration create | `collaboration_link` | server literal `Linked order` | `bundle_id,relation_types,record_type,record_id,link_ids` |
| `link_attached` collaboration adoption/action | `collaboration_link` | caller `reason` | `bundle_id,relation_types,record_type,record_id,link_ids` |
| `link_attached` campaign review | `campaign_review` | caller `reason` | `bundle_id,relation_types,record_type,record_id,link_ids` |
| `link_revoked` correction/revoke | `project_workspace` | caller `reason` | `bundle_id,relation_types,record_type,record_id,revoked_link_ids` |
| `link_revoked` early-stage collaboration cancellation | `collaboration_link` | caller `reason` | `bundle_id,relation_types,record_type,record_id,revoked_link_ids` |
| `link_moved` | `project_workspace` | caller `reason` | `source_bundle_id,destination_bundle_id,relation_types,record_type,record_id,source_campaign_id,destination_campaign_id,revoked_link_ids,replacement_link_ids` |
| `workflow_reconciliation` | `workflow_recovery` | caller `reason` | `original_dispatch_id,replacement_dispatch_id,template_id,template_version` |

Metadata objects accept exactly the listed keys in that order-independent set, use canonical safe IDs/versions, sort every ID/relation array, contain no labels/content/provider data, and remain within 4,096 canonical UTF-8 bytes. The database trigger rejects duplicate, missing, extra, wrongly typed, unsafe, duplicate-array, or unsorted values; the service uses the same closed serializer before reservation. Bundle IDs are immutable 64-character lowercase hex; `source_bundle_id` is the selected historical bundle and `destination_bundle_id` is the newly allocated replacement bundle, so they must differ. Reciprocal move events store byte-identical canonical metadata, and reconciliation metadata is database-bound to the original/replacement dispatch and selected template/version. `relation_types` is always an array, including one-link events, so serializers never change shape between singular and aggregate mutations. Server-literal reasons are not accepted from bodies; every matrix row marked caller `reason` requires 1-1,000 NFC/LF characters.

A route emits only the event rows listed above. `correlation_id` is diagnostic and non-unique. It is exact 8-120-byte printable ASCII: the byte-length bound, character/UTF-8-byte-length equality, and C0/DEL-excluding `GLOB` check are all required because the `GLOB` range alone does not reject every multibyte scalar. Replay/audit identity is the deletion-safe `audit_fingerprint`, computed by `tm-audit-v2` from the request reservation nonce as defined below. Immutable server-derived `expected_event_count` is explicitly the **successful outcome** cardinality: two only for a cross-campaign correction; one for every always-event scope, same-campaign/revoke-only correction, collaboration alias addition, or collaboration cancellation; zero for non-event scopes and a plain linked collaboration data edit. A live successful completion must match that count and its primary/secondary distribution exactly. A replayable terminal `4xx|5xx` completion must contain zero events, cannot carry binary/admission output, and stores the closed error response; a partial event transaction is impossible because events, business mutation, and completion share one write transaction. RED tests drop the response for one- and two-event successes and for zero-event hold/cancel/deadline errors, then prove exact replay. Failed, completed, expiring, deadline-expired, or lease-less rows cannot prove provenance. Permanent events deliberately have no delete-blocking FK to the retained request row.

### Typed Links / 类型化关联

`campaign_record_links` uses this canonical DDL. Deletion is forbidden; correction revokes the active row and optionally inserts a replacement in one transaction.

```sql
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
WHEN EXISTS (
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
BEGIN SELECT RAISE(ABORT,'campaign links are immutable except revocation'); END;

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
BEFORE UPDATE OF cost_actual,cost_actual_confirmed ON collaborations
WHEN NEW.cost_actual_confirmed<>1 AND EXISTS (
  SELECT 1 FROM campaign_record_links link
  JOIN campaigns campaign
    ON campaign.org_id=link.org_id AND campaign.id=link.campaign_id
  WHERE link.record_type='collaboration'
    AND link.record_id=CAST(OLD.id AS TEXT)
    AND link.relation_type='settlement' AND link.revoked_at IS NULL
    AND campaign.lifecycle_state IN ('settled','reviewed')
)
BEGIN SELECT RAISE(ABORT,'settled campaign collaboration cost must remain confirmed'); END;

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
BEGIN SELECT RAISE(ABORT,'campaign knowledge chunk cannot be appended'); END;

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
```

`record_id` must be a positive canonical base-10 JavaScript-safe integer string. The API rejects non-integers and values above `9007199254740991`; the database requires length 1-16, no non-digits, no leading zero, round-trip `CAST(CAST(record_id AS INTEGER) AS TEXT)=record_id`, and range `1..9007199254740991`.

Allowed mappings are exact:

| Relation | Record type | Existing table |
| --- | --- | --- |
| `demand` | `demand` | `demands` |
| `proposal` | `proposal` | `proposals` |
| `ppt` | `proposal` | persisted PPT source proposal |
| `shortlist` | `influencer` | `influencers` |
| `order` | `collaboration` | `collaborations` |
| `execution` | `collaboration` | `collaborations` |
| `publication` | `collaboration` | publication-confirmed collaboration |
| `settlement` | `collaboration` | `collaborations` |
| `ai_run` | `ai_conversation` | `ai_conversations` |
| `workflow` | `workflow_instance` | `workflow_instances` |
| `knowledge` | `knowledge_entry` | `knowledge_entries` |
| `review` | `knowledge_entry` | post-settlement review knowledge entry |

A public generic attach accepts only exact `metadata:{}`. Trusted services own four non-empty closed metadata shapes: `ppt` is `{ "proposal_content_sha256":"<lowercase sha256>", "request_ledger_id":123 }`; `publication` is `{ "confirmed_by":3, "confirmed_at":"YYYY-MM-DD HH:MM:SS" }`; `review` is `{ "settled_event_id":120 }`; and `workflow` is `{ "dispatch_id":44, "trigger_event_id":120 }`. Every other relation stores `{}`. IDs are positive safe integers, timestamps/hashes use the canonical rules, unknown/missing keys fail before insert, and metadata is never exposed by a restricted/missing serializer.

A partial unique index prevents duplicate active `(campaign_id,record_type,record_id,relation_type)` links. The first aggregate attach allocates one cryptographically random 32-byte lowercase-hex root `bundle_id`; a one-link attach is still one bundle. Every later trusted alias for the same aggregate reuses that exact active root bundle: proposal `ppt` inherits the active proposal bundle; collaboration `execution`, `publication`, and `settlement` inherit the active `order` bundle; review `knowledge` and `review` are created together in one bundle. A revoked bundle can never receive another alias. The bundle-identity trigger requires every row sharing a bundle to have one exact `(org_id,campaign_id,record_type,record_id)` and requires an existing bundle to retain an active member at insertion time. The service additionally revokes/corrects all active aliases in that bundle in one transaction; partial bundle revocation is never a supported write.

The identifier is immutable, never appears on `WorkspaceLink`/candidate/target serializers, and appears in `EventSummary.metadata` only after the event serializer reauthorizes the target and every referenced campaign. Correction or cancellation from any visible alias selects the same complete historical root bundle. Reactivation/move creates one new destination bundle and copies the complete active alias set; same-campaign reactivation emits one aggregate event with `destination_event=null`, while cross-campaign move emits reciprocal events. Each staged alias addition emits one `link_attached` for only the newly added sorted relation set but names the inherited root bundle. Database and service RED sequences create every alias in separate requests, then correct/cancel from each alias and prove one complete bundle is moved or revoked. SQLite's single-writer transaction semantics keep correction/move atomic while shortlist remains the shared-library exception.

`EventSummary.metadata` is a closed authorization-aware union. Non-link events and fully authorized link events expose only their documented exact metadata variant. A link event is fully authorized only when the target remains visible and the caller can read every campaign named or implied by that metadata; for a reciprocal move, loss of either source or destination access redacts both summaries. Otherwise the serializer returns metadata exactly `{ "access_state":"restricted" }` for an existing but inaccessible dependency or `{ "access_state":"missing" }` for an unresolved target. A redacted variant contains no link, record, bundle, source/destination campaign, dispatch, template, or replacement identifier. Redaction changes only response serialization; immutable stored evidence remains complete. Direct event, workspace, reconciliation, and replay serializers all call the same helper, and tests revoke target/source/destination access independently.

Polymorphic targets have no ordinary FK. The service validates target existence and original target permission inside the final write transaction. A link grants no target permission. Linked targets cannot be hard-deleted through supported routes; out-of-band missing targets remain as append-only trace entries with `access_state='missing'`, never cascade or auto-delete.

The public generic link endpoint cannot create `ppt`, `order`, `execution`, `publication`, `settlement`, `review`, or `workflow` relations. `ppt` is emitted only by successful campaign-aware generation from an already linked persisted proposal; `order` is emitted only by guarded linked collaboration creation/adoption; `execution`, `publication`, and `settlement` are emitted only by their guarded collaboration actions; `review` is emitted only by the post-settlement review endpoint together with its `knowledge` alias; `workflow` is emitted only by the durable dispatch initializer. Attaching an already existing collaboration is therefore performed only through the guarded collaboration-update path after its current status, cost, record permission, campaign permission, and row version are revalidated. This prevents callers from fabricating lifecycle evidence. These mappings remain in the table because trusted services persist them.

### Workflow Dispatch And Idempotency / 工作流派发与幂等

```sql
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

The checksum-pinned `002` table above remains unchanged. Additive migration `003_campaign_workflow_dispatch_evidence` appends `template_label TEXT NOT NULL DEFAULT 'Workflow template' CHECK(length(template_label) BETWEEN 1 AND 1000)`, backfills each existing dispatch from its referenced template with deterministic `Workflow template #<template_id>` fallback for an unsafe historical name, and adds `campaign_workflow_dispatches_template_label_immutable`. The migration temporarily removes and restores the exact v2 legal-transition trigger inside the same migration transaction so the evidence-only backfill cannot be mistaken for a runtime state transition. A partial column/trigger state is rejected, and reopening an applied v3 database is a no-op.

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
WHEN NEW.status<>'pending' OR NEW.attempt_count<>0
  OR NEW.lease_until IS NOT NULL OR NEW.lease_token IS NOT NULL
  OR NEW.workflow_instance_id IS NOT NULL OR NEW.next_attempt_at IS NOT NULL
  OR NEW.last_error_code IS NOT NULL OR NEW.last_error IS NOT NULL
BEGIN SELECT RAISE(ABORT,'campaign workflow dispatch must start pending'); END;

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
WHEN NEW.org_id IS NOT NULL OR NEW.campaign_id IS NOT NULL
  OR NEW.campaign_event_id IS NOT NULL OR NEW.campaign_dispatch_id IS NOT NULL
BEGIN
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
```

Media-type handling is an explicit compatibility boundary. The exact middleware order for every Phase 4 route and every shared integration route is: request-ID/correlation creation, Bearer authentication, route-scoped content-length/content-type gate and body parser, schema validation, resource/campaign authorization, then request-ledger lookup. Authentication therefore runs before JSON decoding, Multer, archive inspection, temporary-file creation, source-hash lookup, or provider work. Every global legacy body parser, including current `express.json` and `express.urlencoded` and any future `express.raw`/`express.text`, uses the same exact owned-path predicate and skips the complete Phase 4/shared-route matrix so none can parse first. Every response, including parser/auth errors, carries the same generated `X-Request-Id`.

Production Nginx preserves that boundary rather than pre-buffering an unauthenticated body to disk. The exact `/api/` proxy policy sets `proxy_request_buffering off`, `proxy_http_version 1.1`, clears the upstream `Connection` header, keeps the existing route/server response-buffering policy independent, and sets `client_body_timeout 10s`; route-specific `client_max_body_size` plus the application's streaming byte counter enforce the lower documented limit for fixed-length and chunked bodies. Any non-empty `Expect` header, including `100-continue`, receives `417` from Nginx using a header-only map before upstream selection, with no interim `100` and no body read. Ordinary fixed-length and chunked bodies are streamed to the private loopback upstream; HTTP/1.1 is mandatory so chunked input cannot fall back to request buffering. On missing/invalid Bearer auth, Express has attached no body/parser listener, returns `401` with `Connection: close`, and terminates the request stream; on parser admission rejection it does the same with the bounded `429|507`. A 60-second application wall timer bounds an authenticated upload body independently of Nginx's inter-read timeout. Nginx-config tests cover fixed-length, HTTP/1.1 chunked, slow-body, oversized, disconnect, and `Expect` cases and use inotify plus before/after inode inventories to prove hostile unauthenticated/admission-rejected requests create no Nginx `client_body_temp`, application upload, parser job, ledger-event, or provider artifact. The checked-in Nginx file and production effective config must match before listen/cutover.

Every new Phase 4 mutation and every existing mutation whose request supplies or derives a campaign requires `application/json` after authentication and before campaign/target lookup or ledger reservation; media type matching is ASCII case-insensitive and permits parameters such as `charset=utf-8`. Missing or different media type returns `415 UNSUPPORTED_MEDIA_TYPE` with zero side effect. Exact exceptions are: `POST /api/knowledge/upload`, `POST /api/influencers/upload`, and `POST /api/demand/parse-file` remain `multipart/form-data` with a valid boundary; campaign-classified `POST /api/knowledge/:id/use` requires an exact zero-byte body and accepts either no `Content-Type` or `application/json`; bodyless `DELETE /api/customers/:id` and `DELETE /api/opportunities/:id` accept no content type; and an existing mutation with no supplied/derived campaign preserves its frozen v0.4 media-type behavior unless it is one of the named shared upload-sandbox routes. A non-empty body on a bodyless exception is `400 INVALID_REQUEST_BODY`. Multipart authentication and byte limits are established before Multer or the isolated parser sees a byte. Response `Content-Type` rules are independent of this request gate.

The `request_hash` algorithm is versioned as `tm-request-v1`. `FRAME(bytes)` is a four-byte unsigned big-endian byte length followed by exact bytes. SHA-256 always receives exactly six outer frames: `FRAME(UTF8("tm-request-v1"))`, uppercase method, canonical path, canonical decimal campaign ID or empty string, payload kind, and payload bytes. Canonical path decodes each path segment then re-encodes it with RFC 3986 uppercase percent escapes and excludes query/fragment. Payload kind is exactly `json`, `multipart`, or `empty`. `empty` has a zero-byte payload. `json` payload is recursively canonical JSON with object keys sorted by UTF-8 bytes, NFC/LF strings, no insignificant whitespace, finite numbers only, and shortest round-trippable decimal form.

A `multipart` payload is `U32BE(partCount)` followed by sorted part records. Each record is only nested `FRAME` values. A text record is `FRAME("text") || FRAME(fieldName) || FRAME(canonicalOccurrenceIndex) || FRAME(value)`; a file record is `FRAME("file") || FRAME(fieldName) || FRAME(canonicalOccurrenceIndex) || FRAME(normalizedBasename) || FRAME(lowercaseMime) || FRAME(canonicalByteLength) || FRAME(lowercaseContentSha256)`. Field names/basenames/values are path-stripped where applicable, NFC/LF normalized, and reject C0/DEL. Occurrence index is zero-based wire order among parts of the same field and kind. Records sort by UTF-8 field name, then `text` before `file`, then numeric occurrence. File hashes cover exact bytes; raw paths and temporary names never enter the hash. Golden vectors are: JSON `POST /api/campaigns/42/transitions`, campaign `42`, payload `{"expected_state":"qualified","expected_version":2,"next_state":"demand_confirmed","reason":"Approved"}` -> `aea77f7479367197773322de619401340afed782ad5adc3d1a7c6645fa002d77`; empty `POST /api/knowledge/88/use`, campaign `42` -> `4a4a49d347a01447646859fe9dc12ea863260832f6418336a40e32f58dcfa9de`; multipart `POST /api/knowledge/upload`, campaign `42`, text `campaign_id=42`, and file field `file`, basename `brief.csv`, MIME `text/csv`, bytes `a,b\n` whose SHA is `5be08c9684a1d25efcee09318204824278b08bbfb4aef973ffefd0b9d7478313` -> `535cada37d03ecd97abf9536b5a92ea7829b7b5d978db57fe1225da98037858b`.

Idempotency scopes are immutable API constants, never caller input. The exact Phase 4 mapping is: `campaign.create`, `campaign.update`, `campaign.transition`, `campaign.operational`, `campaign.transfer`, `campaign.link.attach`, `campaign.link.correct`, `campaign.review.create`, `campaign.workflow.retry`, `campaign.workflow.reconcile`, `workflow.campaign-template.create`, `workflow.campaign-template.graph`, `workflow.campaign-template.trigger`, `workflow.campaign-template.publish`, `workflow.campaign-task.approve`, `workflow.campaign-task.reject`, `workflow.campaign-task.complete`, `workflow.campaign-task.reassign`, `workflow.campaign-instance.pause`, `workflow.campaign-instance.resume`, `workflow.campaign-instance.cancel`, `demand.create.linked`, `proposal.create.linked`, `proposal.ppt.generate.linked`, `proposal.ppt.generate.unlinked.admission`, `collaboration.create.linked`, `collaboration.update.linked`, `knowledge.create.linked`, `knowledge.ingest.linked`, `knowledge.upload.linked`, `knowledge.use.linked`, `ai.conversation.create.linked`, `ai.conversation.continue.linked`, `parser.knowledge-upload.admission`, `parser.influencer-upload.admission`, and `parser.demand-parse.admission`. Each mutating route maps to exactly one constant before ledger lookup. Every campaign-bound reservation stores the derived positive `campaign_id`. A cross-campaign correction stores source in `campaign_id` and destination in `secondary_campaign_id`; revoke/reactivate-in-source keeps secondary null. The four platform-admin template scopes, unlinked PPT admission scope, and three internal parser admission scopes are the only organization-accounted scopes with null campaign. Template final transactions repeat active platform-admin authorization and exact target/version checks; PPT/parser admissions repeat active user and organization authorization plus their route/resource predicates. All other scopes require a positive campaign. Template create, graph update, trigger update, publish, campaign-linked instance controls, campaign-linked task actions/reassignment, linked collaboration updates, campaign review, linked knowledge use, and linked AI continuation all require `Idempotency-Key`, include their documented expected state/version and canonical body in `tm-request-v1`, and replay their exact success response. Internal admission keys are server-generated and never enter public request/response bytes. An AI continuation or knowledge-use mutation derives its campaign from immutable campaign classification before ledger lookup.

`campaign.create` is the only synchronous insertion-order exception because its server-generated campaign ID does not exist when the key is first checked. Before any user-scoped ledger lookup, the route authenticates and authorizes the submitted organization, opportunity/customer manage predicate, owner, and team assignment inputs without relying on a campaign row. One `BEGIN IMMEDIATE` transaction then repeats those input predicates and looks up `(org,user,scope,key)`/hash. On a miss it allocates and inserts the campaign, inserts the `processing` ledger with that new positive `campaign_id`, inserts the creation event proven by that ledger, and completes the JSON ledger before commit. On a same-key retained row it first reads the stored `campaign_id`, then reauthorizes current access to that stored campaign and its target before returning replay, mismatch, in-progress, or expiry state; revoked access returns the current concealed `404`/`403` and cannot disclose the old body, hash decision, or stored campaign ID. The request hash uses the empty campaign-ID frame because no campaign ID was in the request. SQLite's write lock prevents a concurrent miss, and any failure rolls back campaign/ledger/event together. No provider/file work occurs in this special transaction. Every other campaign-bound scope reserves an already-derived campaign ID before business work.

The browser owns one random key per captured mutation intent, not per HTTP attempt. A central intent object contains the route-owned scope, canonical body/file fingerprint, key, creation time, and terminal flag; it is created before the first send and retained in memory plus `sessionStorage` without credentials or body content. Network failure, timeout, lost response, `IDEMPOTENCY_IN_PROGRESS`, and explicit retry reuse the same key and canonical payload. A terminal success or non-retryable error retires it; any canonical payload change creates a new intent/key. UI tests drop the first committed response for campaign creation and every linked creation/update path and prove the second send replays rather than duplicates.

Public request bodies never choose audit `source`. Each route maps to the exact server-owned source in the event matrix after authentication and before hashing; workflow task/instance activity uses `workflow_task_action|workflow_instance_control`. The constant is stored in the event/activity row but is not a client field, and unknown `source` input is rejected. `reason` follows the matrix: caller-authored only for the listed human decisions and otherwise an immutable server literal. Campaign create therefore has no reason field, while generic attach now requires one. The event serializer validates the event-type/source/reason/metadata combination before reservation and again in the final transaction, so cryptographically fingerprinted evidence cannot receive a forged system identity or ambiguous narrative.

Authentication plus current route/resource/campaign authorization always occurs before **every** request-ledger lookup, including a new reservation, processing response, same-key replay, hash mismatch, expired row, or failed-row reclaim. The final write transaction repeats authorization after acquiring `BEGIN IMMEDIATE`. A completed JSON row stores only a closed response shape whose target identifiers can be re-resolved; before returning its stored body the route reauthorizes the current user, active memberships, campaign operational/access boundary, and target record. Campaign transfer, link correction, demotion, deactivation, team revocation, or target permission loss therefore returns the route's current `403`/concealed `404` and never replays old JSON. Binary replay applies the same authorization rule before path resolution. Regression tests complete every scope, then revoke each relevant access dimension and retry the retained key.

`Idempotency-Key` is exact ASCII matching `[A-Za-z0-9._:-]{8,200}`; it is never trimmed, case-folded, or Unicode-normalized. Every new reservation also stores 32 cryptographically random bytes as 64 lowercase hex `reservation_nonce`. `tm-audit-v2` is independently frozen. SHA-256 receives seven four-byte big-endian length frames in this order: literal `tm-audit-v2`, canonical decimal organization ID, canonical decimal actor user ID, server-owned scope, exact key, 64-byte lowercase ASCII request hash, and 64-byte lowercase ASCII reservation nonce. No separators/JSON are added. Golden vector org `1`, user `3`, scope `campaign.transition`, key `phase4-golden-key`, request hash of 64 `a` characters, and nonce of 64 `b` characters produces `6b17b5d231db1cdda0f6ced85332497cd1d080683884380ac908031c192748e6`. Reuse after a retained row is legally removed creates a new nonce and therefore cannot collide with permanent event evidence.

A `processing` request-ledger row has a 120-second lease, renewed every 30 seconds during provider/file work, and a random 32-byte token. `operation_deadline` is immutable and `expires_at` is null while processing; they are separate concepts. An unexpired duplicate returns `409` plus `Retry-After=ceil(lease_until-now)`. An expired same-hash processing row or retained internal `failed` row may be conditionally reclaimed only while `now < operation_deadline`, with a new token/future lease capped by that deadline and the same reservation nonce. Different hash always conflicts while a row is retained. Every worker-owned renew, complete, fail, base/link commit, and artifact selection query matches ledger ID, request hash, `state='processing'`, exact current token, `lease_until > now`, and `operation_deadline > now`; a stale token changes nothing. JSON completion stores status plus a closed valid response of at most 1 MiB. A deterministic user-visible `4xx|5xx`, including the canonical deadline `503`, completes as JSON with zero events. `failed` is reserved for an internal retryable interruption before the immutable deadline and stores no response.

On each legal terminal transition the server sets retention separately: `failed` and completed `admission` expire exactly 24 hours after `updated_at`; completed JSON and binary expire exactly 30 days after `updated_at`. Expiry/reuse is total after current authorization and before business mutation. Retained `processing` uses only lease/deadline rules. Retained `completed/json` before expiry replays same hash and conflicts on different hash; at/after expiry it is conditionally deleted and the key may reserve a new nonce. Retained `failed` reclaims only same hash and only before `operation_deadline`; after that deadline the explicit database-legal `failed -> completed/json` branch atomically stores the canonical `503`, sets 30-day completed-JSON retention, and requires zero matching events, while a failed row already at retention expiry is deleted. Retained `completed/binary` before expiry replays; only at/after exact expiry may it change to `expiring`, preserving status, headers, cache key, hash, bytes, content type, filename, and expiry byte-for-byte. `expiring` always returns `410 IDEMPOTENCY_EXPIRED` until fsynced artifact cleanup deletes the row. Completed `admission` is internal/non-replayable and is deleted at expiry. Direct-SQL and startup-recovery tests cover both `processing -> completed/json 503` and `failed -> completed/json 503`, reject non-503/early/nonzero-event variants, reject early binary expiry, and reject mutation of every retained artifact field.

Replay headers are reconstructed, never trusted verbatim: `Content-Type` is the fixed PPTX MIME, `Content-Length` is canonical decimal `response_bytes`, `ETag` is the quoted lowercase SHA-256, and `Cache-Control` is exactly `private, max-age=0, no-store`. Logical filename normalization strips paths, normalizes NFC/LF, removes C0/DEL, trims, limits to 120 code points and 180 UTF-8 bytes without splitting a scalar, and appends/replaces the suffix to exact lowercase `.pptx`. Empty output becomes `proposal.pptx`. The ASCII fallback replaces each maximal run outside `[A-Za-z0-9._ -]` with `_`, collapses spaces, strips leading/trailing spaces/dots, re-adds `.pptx`, and falls back to `proposal.pptx`; it therefore contains no quote, backslash, semicolon, percent, or control. `Content-Disposition` is exact `attachment; filename="<fallback>"; filename*=UTF-8''<RFC5987>`, where RFC 5987 uses uppercase percent escapes for every UTF-8 byte outside ``A-Z a-z 0-9 ! # $ & + - . ^ _ ` | ~``. Golden logical filename `Bluetti 夏季方案.pptx` yields `attachment; filename="Bluetti _.pptx"; filename*=UTF-8''Bluetti%20%E5%A4%8F%E5%AD%A3%E6%96%B9%E6%A1%88.pptx`. C0 controls and DEL are rejected in service validation and database triggers for every persisted filename/header value; `Content-Length` must equal actual bytes, and ETag must equal the verified SHA-256. `X-Request-Id` is deliberately not persisted and is freshly generated/echoed on replay. Authorized binary replay resolves the cache path below the configured root without following symlinks, verifies byte count and SHA-256, then streams the stored status and reconstructed headers; any mismatch is a `500 REPLAY_ARTIFACT_INVALID`, is audit-logged without path/content, and never regenerates a second billable output under the completed key.

Lease renewal never permits unbounded work. Upload parsing has its 20-second/512-MiB sandbox deadline; an AI provider attempt has 120 seconds total; PPT render/validation/promotion has 180 seconds; other file/provider work has 60 seconds; and an unscoped response stream has a ten-minute wall-clock cap. `operation_deadline` is exactly `created_at + route limit`; every lease is future-dated and capped to it. Deadline, client abort, process shutdown, disconnect, or lease loss propagates one `AbortSignal` to every provider and kills any child cgroup, then removes attempt-owned files before the token-fenced terminal write. Startup atomically terminalizes processing/failed rows at or beyond their deadline to the closed safe JSON `503` with zero events before admitting work. Deadline/abort/restart tests prove no late provider result can write cache, messages, references, archives, usage, base rows, links, or artifacts.

Admission for a previously unseen non-PPT key is transactional and happens after authorization but before insertion. Across non-binary scopes, one user may have at most eight and one organization at most 64 live `processing` rows; accepted starts are capped at 200 per user/hour and 2,000 per organization/hour; retained rows are capped at 5,000 per user, 500 per user/scope, and 50,000 per organization. Completed JSON bytes are additionally capped at 32 MiB per user/scope, 128 MiB per user, and 1 GiB per organization, measured with `length(CAST(response_json AS BLOB))` in the same `BEGIN IMMEDIATE` completion transaction. Same-key lookup/replay is evaluated before every capacity check. Rate/concurrency returns `429 IDEMPOTENCY_RATE_LIMITED`; retained count/byte capacity returns `507 IDEMPOTENCY_STORAGE_CAPACITY_EXCEEDED`. Reservations, completion bytes, operation deadlines, and terminal retention serialize exactly.

Binary artifacts are fenced by lease generation. `base_cache_key` is lowercase `sha256(org_id + "\n" + user_id + "\n" + scope + "\n" + idempotency_key)`. Each worker derives its immutable `artifact_key=sha256("tm-artifact-v1\n" + base_cache_key + "\n" + sha256(lease_token))`, writes only to its own private temporary file, validates it, fsyncs the file, promotes with no-replace semantics to `<PPT_CACHE_DIR>/<first-two-hex>/<artifact-key>.pptx`, and fsyncs the destination file plus both affected parent directories before SQLite may record completion. `PPT_CACHE_DIR` is absolute/private `0700` outside the static tree and each regular file is `0600`; raw/token hashes are never logged. The final database transaction matches ledger ID, `state='processing'`, exact unexpired lease token, and request hash, then writes base record/link plus `response_cache_key=artifact_key` and completion metadata. A stale worker whose conditional write loses deletes only its own artifact path and fsyncs that parent; it can neither overwrite nor remove the winner. A crash before commit leaves only an unreferenced attempt artifact for cleanup, while a crash after commit leaves the durably published uniquely referenced winner.

Startup and hourly janitors derive and exclude every artifact key belonging to a live processing row before scanning unreferenced regular files, regardless of mtime. An orphan becomes eligible only after its ledger is absent/non-processing and it is older than one hour. For an expired completed-binary row, cleanup conditionally changes `completed -> expiring` only when `now >= expires_at` and preserves every response/artifact field; `expiring` returns `410`. It validates the no-follow path, unlinks if present, fsyncs the containing directory, then deletes the row transactionally. A crash or failed fsync leaves an honest resumable `expiring` row. Expired completed JSON/failed/admission rows follow their exact retention rules; active processing rows are never deleted. Campaign events and links never expire, and the deletion-safe audit fingerprint survives request cleanup.

PPT admission applies to campaign-linked replayable generation **and** the legacy unscoped ephemeral route, evaluated before rendering and again before promotion/streaming: at most two processing PPT jobs per user and eight per organization; at most 20 accepted starts per user/hour and 200 per organization/hour; output at most 64 MiB; retained completed/expiring campaign artifacts at most 50 files or 2 GiB per user and 500 files or 20 GiB per organization; and the target volume must retain at least the greater of 5 GiB or 10% free after the declared maximum output. The unscoped route reserves a server-generated, non-client-replay key with null campaign and scope `proposal.ppt.generate.unlinked.admission`. It renders to an attempt-owned ephemeral file, never writes a binary replay row, preserves the frozen streamed bytes/body, deletes/fsyncs the file on stream completion, and then token-conditionally stores `state='completed',status_code=200,response_kind='admission'` with every response/artifact field null and 24-hour expiry. Client disconnect/abort deletes/fsyncs then stores failed; process death leaves an expired processing admission plus an orphan that startup fails/cleans after the immutable deadline. Completed admission rows are never replayed and exist only for restart-safe hourly/count accounting before direct transactional deletion after 24 hours. Concurrency/rate/count limits return stable `429 PPT_GENERATION_RATE_LIMITED` with bounded retry metadata; byte/free-space limits return `507 PPT_STORAGE_CAPACITY_EXCEEDED`. Ledger aggregates are the durable source across restart. Scoped/unscoped flood, disconnect, disk pressure, long-worker cleanup race, promotion crash, expiry crash, and startup cleanup tests prove bounded storage without deleting a live winner.

Dispatch rows are durable evidence, not a mutable job scratchpad. Database checks and triggers freeze organization/campaign/event/template/snapshot fields, forbid deletion, require coherent lease/error/instance fields, and permit only the documented claim, heartbeat, expired-lease reclaim, terminal finalize, backoff failure, dead-letter, and audited manual-reset transitions. Service updates additionally match the current lease token/status/attempt count, so a stale worker cannot pass a legal-state trigger and overwrite a newer claim.

These workflow compatibility changes are migration-owned. Because SQLite cannot add a multi-column FK to the existing table without rebuilding it, insert triggers require campaign-backed instances to set legacy projection exactly `template_id=<dispatch template>`, `business_type='campaign'`, `business_id=<campaign_id>`, and `started_by=<root event actor>`, provide all four context IDs, and match the dispatch/root event. The immutability trigger freezes those legacy lineage fields, `created_at`, and all four context IDs for the life of the instance; only node/status/task execution fields may advance. Legacy rows keep campaign fields null and retain current behavior. The dispatch table's composite FK and reciprocal completion triggers close the relationship when `workflow_instance_id` is assigned. Post-completion attempts to change template, business identity, starter, or context abort at the database boundary.

## Lifecycle, Guards, And Concurrency / 生命周期、业务门槛与并发

The lifecycle is fixed:

`lead -> qualified -> demand_confirmed -> proposal_draft -> proposal_confirmed -> influencer_shortlist -> ordered -> executing -> published -> settled -> reviewed`

Every transition request includes `expected_state`, `expected_version`, `next_state`, `reason`, and an `Idempotency-Key`; audit `source` is selected by the server-owned route constant and is not accepted from the body. The service reserves the key, then performs a conditional update matching campaign ID, state, active status, and row version while incrementing the version. One concurrent writer wins; stale writers receive `409 STALE_CAMPAIGN_STATE` with current state/version. Same key and same request replays the exact stored status/body; same key with a different hash returns `409 IDEMPOTENCY_KEY_REUSED`.

Forward adjacency and these minimum relation guards are mandatory:

| Next state | Required active relation |
| --- | --- |
| `qualified` | none |
| `demand_confirmed` | `demand` |
| `proposal_draft` | `proposal` |
| `proposal_confirmed` | `proposal` |
| `influencer_shortlist` | `shortlist` |
| `ordered` | active `order` whose collaboration is not cancelled and is in an order-eligible status |
| `executing` | active `execution` whose collaboration is `live|content_review|completed` |
| `published` | trusted active `publication` whose collaboration is `completed` |
| `settled` | active `publication` plus active `settlement` whose collaboration is `completed` with `cost_actual_confirmed=1` |
| `reviewed` | trusted active `review` created after the campaign entered `settled` and paired to the same entry's active `knowledge` link |

The transition guard joins the current target row rather than trusting historical aliases alone and evaluates the cumulative guard set for every state at or before the requested next state. A later alias cannot replace a missing earlier prerequisite. A cancelled collaboration can never satisfy `ordered`, `executing`, `published`, or `settled`; cancellation revokes its complete `order/execution/publication/settlement` alias bundle in the same transaction. A `review` relation is accepted only when its trusted metadata contains the exact settled lifecycle event ID and that event predates the review link. Missing guards return `409 CAMPAIGN_GUARD_NOT_MET` with only the sorted missing relation codes. Backward, skipped, repeated, or unknown transitions return `409 INVALID_CAMPAIGN_TRANSITION` with no event or dispatch.

Post-settlement review is one focused mutation, `POST /api/campaigns/:id/reviews`, with scope `campaign.review.create`. Owner/team writer or org admin submits exact `expected_version,title,summary,content,tags,visibility,reason` under the API limits. The server derives the exact settled lifecycle event before ledger lookup. One `BEGIN IMMEDIATE` transaction reauthorizes an active campaign exactly at `settled`, matches row version, and resolves all historical `campaign_review,<campaign_id>:<settled_event_id>` entry/link evidence. No historical entry/pair creates one dedicated server-classified `campaign_review` knowledge entry, paired `knowledge` and trusted `review` links with exact settled-event metadata, one aggregate `link_attached` event from `campaign_review`, one campaign row-version increment, and the replay completion. An existing active complete pair returns zero-mutation `409 RECORD_ALREADY_LINKED`; an existing fully revoked complete pair returns zero-mutation `409 RECORD_REQUIRES_LINK_CORRECTION` so the authorized caller reactivates that exact bundle rather than creating a second review; partial, mismatched, or cross-campaign historical evidence fails closed as `409 CAMPAIGN_EVIDENCE_IN_USE`. The review-specific source index and service predicate enforce one entry for each historical `(campaign_id,settled_event_id)` across owner/visibility changes. Any failure rolls back entry, both links, event, campaign version, and replay together. This creates evidence only; the explicit adjacent transition to `reviewed` remains a separate human decision and guard check.

Owner/team transfer is a first-class mutation. An organization administrator may transfer to any legal active organization owner/team pair. A current campaign owner may transfer only to a destination team in which that current owner is also an active member, and the destination owner must be an active member of that destination team and organization. Options and the mutation transaction recompute this identical rule; a reason and optimistic `expected_version` are required. Every campaign metadata, lifecycle, operational-status, or transfer mutation conditionally matches and increments `row_version`, avoiding SQLite timestamp-resolution races; attempting to increment `9007199254740991` returns `409 ROW_VERSION_EXHAUSTED` with no mutation. Link correction is also first-class. A shortlist correction changes only that one reference. For every non-shortlist target, ownership is the exact immutable `bundle_id` selected by the supplied visible `link_id`; correction revokes every alias in that historical bundle and, when moving, recreates the same alias set under one newly allocated destination bundle so collaboration `order/execution/publication/settlement` and proposal `proposal/ppt` cannot split across campaigns. A review `knowledge/review` bundle is never eligible for cross-campaign correction because its immutable source identity and settled-event metadata belong to its origin campaign; such an attempt returns zero-mutation `409 CAMPAIGN_EVIDENCE_IN_USE`. Review evidence permits only revoke-without-replacement and same-campaign reactivation of the fully revoked exact pair. Every same-campaign correction may only reactivate a completely revoked historical bundle, creates a new bundle, and emits one `link_attached`; it cannot duplicate or partially reactivate an active bundle. Correction cannot revoke any relation required by the source campaign's current cumulative lifecycle guards and cannot attach evidence that fails the destination campaign's current cumulative guards; it returns `409 CAMPAIGN_EVIDENCE_IN_USE` before mutation. Other legal cross-campaign corrections store source and destination on the same request reservation, then source and destination each receive one `link_moved` carrying the identical source/destination campaign IDs, old/new bundle IDs, aliases, and reciprocal revoked/replacement IDs; request completion enforces exactly those two events. Workflow links are immutable trusted dispatch evidence and cannot use the public correction API. Both transfer and correction are idempotent and reauthorize campaigns/target inside the transaction; negative and concurrent correction/transition tests prove no committed campaign is left with missing required evidence.

`001_legacy_compat_columns.js` adds both `collaborations.row_version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(row_version)='integer' AND row_version BETWEEN 1 AND 9007199254740991)` and `collaborations.cost_actual_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(typeof(cost_actual_confirmed)='integer' AND cost_actual_confirmed IN (0,1))`, backfilling existing rows to `1` and `0`. JSON validators reject every non-integer original value before SQLite binding. Because this legacy table has INTEGER affinity, database tests accept lossless affinity conversions such as text `"2"` and REAL `3.0` that SQLite stores as INTEGER, while rejecting values that remain TEXT/REAL/BLOB after affinity, zero, negative, non-integral, or overflow values and invalid confirmation flags. The explicit truly-unlinked legacy serializer hides both compatibility fields and preserves the exact v0.4 list/detail/write response body. An unlinked legacy PUT first acquires `BEGIN IMMEDIATE`, proves no active or historical campaign classification exists, reads the current version under the write lock, conditionally updates and increments it without requiring the old client to send `expected_version`, and rejects maximum-version overflow as `409 ROW_VERSION_EXHAUSTED`.

Linked collaboration semantics are closed. Campaign-aware `POST /api/collaborations` accepts omitted status or exact `confirmed`, stores `confirmed`, creates only the initial `order` alias, and returns campaign-only row version `1`; any other create status is `409 INVALID_COLLABORATION_TRANSITION`. The collaboration candidate endpoint returns only accessible records with exact campaign-only fields `id,title,status,row_version,adoption_allowed` and never leaks hidden legacy fields. Adopting an existing unowned collaboration is allowed only to its owner, a platform administrator, or an organization administrator in that owner's organization; it requires campaign write, exact row version, a status in `confirmed|contract_sent|live|content_review|completed`, `campaign_relation='order'`, reason, and idempotency. The transaction repeats both object and campaign authorization, conditionally increments the version, creates the first `order` alias, and completes the ledger.

After linking, a same-status edit is allowed, and the only forward transitions are `confirmed -> contract_sent|live`, `contract_sent -> live`, `live -> content_review|completed`, and `content_review -> completed`; `completed` is terminal. The `order` alias requires the resulting collaboration to remain in that non-cancelled closed set. The `execution` alias may be added only when the resulting status is `live|content_review|completed`. Exact request discriminant `campaign_relation='publication'` may be supplied only for a completed collaboration with active order/execution and atomically adds trusted `publication` metadata `{ "confirmed_by":<actor_id>, "confirmed_at":"<transaction UTC>" }`; `action` is reserved exclusively for exact `action='cancel'` and `confirm_publication` is never accepted. The `settlement` alias may be added only with active publication, when the same request retains `status='completed'`, includes exact `confirm_cost_actual:true`, and supplies a present canonical safe non-negative `cost_actual`; that transaction sets `cost_actual_confirmed=1`. A later canonical `cost_actual` value change normally clears confirmation unless that same request explicitly reconfirms under the identical settlement predicate; an unchanged value is not a cost edit. Once an active settlement bundle's campaign is already `settled|reviewed`, a cost change without same-request reconfirmation is instead a zero-event completed `409 COLLABORATION_COST_CONFIRMATION_REQUIRED` and leaves collaboration fields, row version, archive, links, campaign state, and events byte-for-byte unchanged. The database guard independently prevents any supported or direct update from leaving such a campaign with `cost_actual_confirmed<>1`.

Every linked PUT requires campaign ID, integer `expected_version`, reason, and idempotency. One `BEGIN IMMEDIATE` transaction reauthorizes user, campaign, operational status, collaboration, immutable campaign classification, active aliases, and the current cumulative campaign guard before it conditionally updates the collaboration and increments `row_version`; inserts the one legal missing alias; completes the ledger; and returns the new version plus the complete ordered active relation set. A plain same-status data edit reserves `expected_event_count=0`; adding an alias reserves one `link_attached`; a settled/reviewed cost-reconfirmation rejection also completes with zero events. Same key/hash replays exactly after current authorization; changed hash conflicts; unexpired processing returns retry metadata; two different keys using one expected version yield one winner and one `409 STALE_COLLABORATION_VERSION`, including within the same second. Any PUT that omits campaign context first checks active and historical classification under the same write lock; a classified row returns `409 CAMPAIGN_CONTEXT_REQUIRED` with safe `{ "campaign_id":42 }` and cannot take the legacy path. Cancellation is the separate exact linked body with `action='cancel'`, allowed only while the campaign is `on_hold`; for any nonterminal linked collaboration it atomically stores `cancelled`, increments the version, and revokes the entire active `order/execution/publication/settlement` alias bundle. Before `ordered`, it leaves the campaign on hold and emits one aggregate `link_revoked`; at `ordered` or later it instead sets `operational_status='cancelled'`, writes one terminal operational-status event, runs the full campaign cancellation cascade including every other linked nonterminal collaboration, and prevents any further lifecycle transition. Both variants reserve exactly one event. Moving/correcting a non-cancelled bundle remains the only other alias-revocation path. Workspace buttons expose “关联下单”, “进入执行”, “确认发布”, “确认结算”, and “取消合作” only when these server predicates are met.

## Workflow Trigger And Recovery Contract / 工作流触发与恢复契约

Campaign-template authoring is platform-admin-only, meaning active legacy `users.role='admin'`; organization administrators cannot list private trigger configuration, create, edit, publish, or delete an organization-unscoped campaign template. Creating `module='campaign'` through the existing template POST requires platform admin plus `Idempotency-Key` and always creates inactive version-1 draft. Updating an existing campaign template requires platform admin, `Idempotency-Key`, exact `expected_version`, and must keep `module='campaign'`; changing it away returns `409 CAMPAIGN_TEMPLATE_MODULE_IMMUTABLE`. Updating a non-campaign template into campaign through PUT returns `409 CAMPAIGN_TEMPLATE_CREATE_REQUIRED`; platform admins create a new campaign template instead. Any campaign graph or trigger edit increments version exactly once and sets `is_active=0` in the same conditional transaction. Create, graph, trigger, and publish use their four frozen ledger scopes and replay exact success bodies; a reused key with different canonical body conflicts. Existing non-campaign template authoring/runtime remains unchanged.

The existing create/update/publish URLs are an auth-first dual-media boundary: their route parser accepts legacy JSON, URL-encoded, and bodyless-publish input, then classifies campaign semantics from `module='campaign'`, the stored template module, or the presence of `expected_version`, never from whether an idempotency key happens to be present. Campaign-classified requests require JSON and fail `415 UNSUPPORTED_MEDIA_TYPE` before schema/authorization/ledger work; only the non-campaign branch retains legacy media behavior. Campaign-template name, description, and category are scalar-safe, normalized to NFC/LF, trimmed before request hashing and persistence, capped at 1,000 scalars, and reject C0 controls other than LF plus DEL.

The campaign trigger must be exactly `{ "event_type":"lifecycle_transition", "previous_state":"...", "next_state":"..." }` with adjacent states. Publishing requires exact `expected_version` and only accepts `start`, `end`, `approval`, `task`, and `condition`; `parallel`, `timer`, `webhook`, `auto_action`, and `sub_process` are rejected until later phases provide durable branch joins and side effects. Designer-only `x`, `y`, `width`, and `height` remain in the mutable authoring document after finite/range validation but are deliberately excluded from the execution snapshot and checksum. No label, condition, assignee, or other execution value is taken from those layout fields.

The closed execution-node schema has exact keys `{id,type,label,config}`. IDs are unique NFC strings matching `[A-Za-z0-9._:-]{1,80}`; labels are NFC/LF strings of 1-160 characters; all node IDs and edge endpoints must resolve after normalization. `start`, `end`, and `condition` require exact empty config `{}`. `approval` and `task` require exact config `{title,description,assignee_id,assignee_role,due_hours}`: title is 1-160 characters, description is 0-1000, assignee ID is null or a canonical safe integer, role is null or one of `platform_admin|org_admin|team_lead|member`, due hours is null or integer `1..8760`, and at least one assignee field is non-null. When both assignee fields are set, both predicates must match. Publish validates this organization-independent syntax but cannot claim an actor exists for a future campaign. At each campaign task creation, the transaction evaluates the configured ID/role conjunction against active users, active organization/team membership, and current campaign write access; it creates a pending task only when that eligible set is nonempty. Unknown node/config keys or legacy `admin|user` campaign roles fail publish; the campaign editor maps those legacy defaults to an explicit current role before save.

For campaign execution, `due_hours` is a relative duration from the canonical SQLite `CURRENT_TIMESTAMP` captured once by the transaction that creates that specific task, not from the root event or template publish time. `due_at` is UTC `datetime(transaction_now, '+' || due_hours || ' hours')`; null remains null. Initialization/reconciliation/retry creates a new task with a new creation-time deadline, while an already persisted pending task never has its deadline recomputed. Campaign execution does not use the legacy `config.due_at` interpretation; regression tests cover delayed dispatch, reconciliation, retry, and UTC rollover.

The closed edge schema has exact keys `{id,from,to,outcome,priority,condition}`. Edge IDs use the node-ID grammar and are unique; priority is integer `0..1000000` and unique per source. `start` has exactly one `next` edge; `task` exactly one `complete`; `approval` exactly one `approve` and one `reject`; `condition` has one or more `match` edges plus exactly one final `fallback`; `end` has none. Non-`match` edges require `condition:null`. Match edges require a closed expression and evaluate in ascending priority; first true wins, otherwise the mandatory fallback wins. All nodes are reachable from the single start, every edge target exists, and every path reaches a task/approval/end boundary within 100 automatic nodes. Duplicate outcome, duplicate priority, missing fallback/action edge, multiple start nodes, unreachable nodes, pure-auto cycles, zero selections, or ambiguous selections fail publish. A mismatch found before initialization makes the processing dispatch `failed_validation`. A checksum/context/path mismatch found after initialization rolls back the task action and moves only the linked workflow instance to the separately defined terminal `failed_validation` execution state; a completed dispatch is never rewritten. The evaluator never guesses a path.

Condition expressions are closed JSON. Comparisons are exactly `{op,left,right}` with `op=eq|neq|gt|gte|lt|lte|in`; boolean expressions are `{op:"and"|"or",args:[...]}` with 2-10 expressions or `{op:"not",arg:{...}}`, maximum depth 8 and 100 total nodes. An operand is a scalar literal, an array of at most 20 same-type scalar literals for `in`, or exact `{var:"..."}`. Allowed variables are `campaign.id`, `campaign.lifecycle_state`, `campaign.operational_status`, `event.event_type`, `event.previous_state`, `event.next_state`, and `task.action`; every campaign/event variable reads the immutable dispatch execution context captured in the root transition transaction, never the mutable current campaign row. Initial automatic advancement supplies `task.action=null`, while continuation supplies only `approve|reject|complete`. Current operational status remains a separate authorization/commit guard and cannot alter branch selection. Numbers are safe integers, strings are NFC/LF and at most 160 characters, and comparison is type-strict. Unknown operators, variables, keys, non-finite numbers, mixed arrays, or coercion are invalid at publish and runtime; they never evaluate true.

A campaign template is applicable only when `is_active=1`, `module='campaign'`, and the published exact predicate matches the event. The immutable `tm-workflow-snapshot-v1` object has exact top-level keys `snapshot_version,template_id,template_version,module,trigger,nodes,edges`; snapshot version is integer `1`, module is `campaign`, nodes sort by UTF-8 `id`, edges sort by `(from,priority,outcome,to,id)`, and recursively canonical JSON uses the `tm-request-v1` normalization/key-order rules. `template_checksum` is SHA-256 of two four-byte big-endian length frames: literal `tm-workflow-snapshot-v1`, then exact canonical JSON bytes. This real approval/rejection/condition/task vector produces `4327b1af3ab96b895a2e93eebb0d4223d1fe79f39f6cf24edc25b8d2a3d22fd9`; the single line inside the block is the exact UTF-8 hash input, excluding fences and line terminator:

```json
{"edges":[{"condition":null,"from":"approve","id":"approve-ok","outcome":"approve","priority":0,"to":"condition"},{"condition":null,"from":"approve","id":"approve-reject","outcome":"reject","priority":1,"to":"end"},{"condition":{"left":{"var":"event.next_state"},"op":"eq","right":"demand_confirmed"},"from":"condition","id":"condition-match","outcome":"match","priority":0,"to":"task"},{"condition":null,"from":"condition","id":"condition-fallback","outcome":"fallback","priority":1,"to":"end"},{"condition":null,"from":"start","id":"start-next","outcome":"next","priority":0,"to":"approve"},{"condition":null,"from":"task","id":"task-complete","outcome":"complete","priority":0,"to":"end"}],"module":"campaign","nodes":[{"config":{"assignee_id":null,"assignee_role":"org_admin","description":"","due_hours":null,"title":"Approve campaign"},"id":"approve","label":"Approval","type":"approval"},{"config":{},"id":"condition","label":"Check state","type":"condition"},{"config":{},"id":"end","label":"End","type":"end"},{"config":{},"id":"start","label":"Start","type":"start"},{"config":{"assignee_id":null,"assignee_role":"member","description":"","due_hours":null,"title":"Execute campaign"},"id":"task","label":"Execute","type":"task"}],"snapshot_version":1,"template_id":9,"template_version":4,"trigger":{"event_type":"lifecycle_transition","next_state":"demand_confirmed","previous_state":"qualified"}}
```

At transition time the same transaction stores the template's current display label, canonical template snapshot/checksum, and exact `execution_context_json={"campaign":{"id":42,"lifecycle_state":"demand_confirmed","operational_status":"active"},"event":{"event_type":"lifecycle_transition","previous_state":"qualified","next_state":"demand_confirmed"}}` in the unique dispatch. The pinned label is immutable historical display evidence and is not reloaded from a later template rename. The campaign lifecycle value is the committed next state, and operational status must be active in that transaction. For an original dispatch, `event_id=trigger_event_id` and both identify that lifecycle event. A reconciliation dispatch copies the prior execution context byte-for-byte; database lineage checks require equality. Publish, dispatch creation, corruption checks, initialization, delayed retry, reconciliation, and continuation call the same versioned serializer/evaluator and reconstruct the context from the immutable root event to detect tampering. Every condition reads this context plus only the current task action, never a later reconciliation event or mutable campaign state. Delayed initialization and concurrent later lifecycle/hold changes therefore cannot choose a different graph edge. Later template edits cannot change pending work; editing an active campaign template increments version and returns it to inactive draft.

The campaign transaction atomically commits state, event, matching dispatch rows, and the completed transition-idempotency response. It does not claim workflow execution is atomic with the campaign write. The post-commit drain uses this exact state machine:

1. Before any claim, startup/periodic recovery conditionally changes an expired `processing` row at `attempt_count=5` to `dead_letter`, matching ID, status, attempt count, exact old lease token, expired lease, and joined campaign `operational_status='active'`; it clears lease fields and writes sanitized `WORKER_LEASE_EXPIRED_FINAL` / “Final workflow worker lease expired”. While on hold the expired row remains fenced and unchanged; after resume the next drain recovers it. Campaign cancellation uses the separate atomic cancelled transition. This branch never starts a sixth attempt.
2. Claim one due `pending`/`failed_initialization` row, or an expired `processing` row at attempts 1-4, only while the joined campaign is `operational_status='active'`, with one conditional update to `processing`, a 60-second lease, random lease token, and incremented attempt count. A long operation renews at 20 seconds. Heartbeat and every worker finalization match dispatch ID, `status='processing'`, exact current token, unchanged attempt, `lease_until > CURRENT_TIMESTAMP`, and campaign still active; heartbeat additionally extends from the exact old lease. An expired worker or a worker overtaken by hold/cancellation cannot renew, complete, fail, or overwrite a replacement and deletes only its temporary artifacts.
3. Validate the stored snapshot/checksum. Pre-initialization corruption becomes terminal dispatch `failed_validation` with sanitized code/message; the mutable current template is never substituted. It is never reset in place. After operators repair and publish a new template version, owner/org-admin may call the audited idempotent reconciliation route for either that failed dispatch or a completed dispatch whose linked instance is terminal `failed_validation`. After current authorization, the mutation applies same-key ledger replay/conflict first. On a miss, one `BEGIN IMMEDIATE` transaction repeats authorization and applies this exact winner order: cancelled campaign, on-hold campaign, existing replacement, legal failure shape, then matching repaired-template/version/checksum. It explicitly preallocates the replacement dispatch ID as `SELECT COALESCE(MAX(id),0)+1 FROM campaign_workflow_dispatches` under that write lock. The value must remain a positive JavaScript-safe integer and be absent; overflow or collision aborts before evidence. The transaction then appends the `workflow_reconciliation` event containing that preallocated ID, inserts the replacement dispatch with the same explicit ID, and creates the required `campaign_workflow_reconciliation,<reconciliation_event_id>` knowledge entry/chunks plus campaign `knowledge` link. That archive contains exact canonical `{original_dispatch_id,replacement_dispatch_id,template_id,template_version}` and does not fabricate a workflow instance/node log for a pre-initialization failure. Event, explicit-ID dispatch, archive/link, and ledger completion commit together, removing the circular event/dispatch identity dependency. The insertion trigger independently requires the parent to be in that exact eligible failure shape, the parent and replacement to share organization/campaign/root event, and the replacement event to be `workflow_reconciliation`. Chained reconciliation keeps the same root trigger event while each replacement points to the immediately failed dispatch. A same-key/same-hash retry replays the original success after current authorization even if a later replacement row exists; only a different-key concurrent or later loser reaches `409 DISPATCH_ALREADY_RECONCILED` with the existing replacement ID and no new event/archive. Every old dispatch/instance remains immutable evidence.
4. In one SQLite transaction insert the one workflow instance keyed by `campaign_dispatch_id`, synchronously advance at most 100 safe nodes to the first task/approval/end boundary, resolve a nonempty eligible actor set for every task boundary, create initial logs/tasks with `assignment_version=1` and the campaign deadline rule, create the workflow campaign link and any campaign-aware knowledge archive link, set instance initialization exactly `ready` with no initialization error, and set dispatch `completed` with `workflow_instance_id`. An empty actor set is a sanitized initialization validation failure, not an unreachable pending task. Database triggers reciprocally require instance organization/campaign/dispatch/root-event/template plus ready initialization to match the dispatch being completed; a same-campaign instance from another dispatch cannot satisfy the FK. Any error rolls back every instance/log/task/archive/link change.
5. After rollback, a separate conditional update records `failed_initialization`, sanitized error code/message, clears the lease, and sets backoff `5s,30s,2m,10m`. A caught failure on claimed attempt five uses the separate legal live-lease `processing -> dead_letter` branch, matches the exact current token and unexpired lease, keeps attempt five, clears lease/retry fields, and records the real sanitized code/message immediately. The expired-attempt-five recovery branch remains distinct and records `WORKER_LEASE_EXPIRED_FINAL`; neither can create a sixth claim.
6. Startup and the 30-second periodic drain recover expired leases and due retries only for joined active campaigns. An owner/org-admin manual retry of `failed_initialization` or `dead_letter` requires expected status, reason, idempotency, and active campaign in both precheck and final transaction; the server stores source `workflow_recovery`, records prior attempts in `activity_log`, and resets the counter. Reconciliation has the same active final predicate. Dispatch or post-initialization instance `failed_validation` is terminal and uses the separate reconciliation operation above. Tests cover attempts 1-5 expiring before hold, during hold, after resume, and racing cancellation.

`GET /api/campaigns/:id/workflow-reconciliation-options` returns one of five exact tagged variants and no optional union fields:

| `state` | Exact remaining keys | Rule |
| --- | --- | --- |
| `eligible` | `dispatch,required,templates` | Active campaign, reconcilable failure shape, no replacement, and at least one matching template. |
| `no_matching_template` | `dispatch,required,templates` | Same eligibility, but `templates` is exactly `[]`. |
| `campaign_not_active` | `dispatch,operational_status` | `operational_status` is exactly `on_hold|cancelled`; no template information is returned. |
| `dispatch_not_reconcilable` | `dispatch,dispatch_status,instance_status` | The parent is not either exact eligible failure shape; status fields are bounded enum/null values. |
| `already_reconciled` | `dispatch,replacement_dispatch_id` | The unique replacement already exists; no templates or failure details are returned. |

Every object begins with `state`. `required` is exactly `{ "failure_shape":"pre_initialization|post_initialization", "expected_dispatch_status":"failed_validation|completed", "expected_instance_status":null|"failed_validation" }`. Each template is exactly `{ "id":9,"label":"Campaign handoff repaired","version":6,"published_checksum":"<lowercase sha256>","trigger":{"event_type":"lifecycle_transition","previous_state":"qualified","next_state":"demand_confirmed"} }`, sorted by `(label,id)`. The options decision order is exact: authorize/conceal campaign and dispatch; return `campaign_not_active` for `cancelled`, then `on_hold`; return `already_reconciled` only while the campaign is active; otherwise validate the two legal failure shapes and return `dispatch_not_reconcilable` on mismatch; only then search matching templates and choose `eligible|no_matching_template`. The mutation uses the same order after same-key replay handling: cancelled, on-hold, existing replacement, failure shape, template. No lower-precedence branch computes or exposes replacement, template, or failure data that a higher-precedence branch conceals. The options result is guidance, never authority, and injected hold/cancel/replacement races prove the read and write contracts agree.

“Exactly once” means one dispatch, at most one initialized instance, one workflow link, and one initial task/log set per `(event,template)`. Every later campaign task action/advance resolves the immutable dispatch through `campaign_dispatch_id`, revalidates its checksum, and reads nodes/edges/trigger from `template_snapshot_json`; it never reloads mutable `workflow_templates.nodes/edges`. Assignment is the one explicitly mutable execution-control field: the task initially copies the snapshot assignment, then only the audited reassignment mutation below may update the task's effective `assignee_id|assignee_role` while the snapshot stays immutable. For a campaign-linked task, existing approve/reject/complete routes require `Idempotency-Key` and exact body `{ "expected_status":"pending", "expected_assignment_version":1, "comment":"..." }`; scope is selected by action, request hash includes the derived campaign ID, and unlinked legacy requests remain unchanged. `approve` and `reject` are accepted only when the pinned node type is `approval`; `complete` is accepted only for `task`; mismatch returns `409 WORKFLOW_TASK_ACTION_NOT_ALLOWED` without reserving or mutating anything. Campaign task authorization evaluates both current effective task assignment fields and has no mutation bypass: non-null `assignee_id` equals the actor; `platform_admin` matches an active user with legacy `users.role='admin'`; `org_admin` matches active organization role `org_admin`; `team_lead` matches an active `team_lead` membership in the campaign's current team; and `member` matches any active membership in that current team. These are independent predicates with no precedence, so one actor may satisfy several; transfer/revocation is evaluated at action time. When ID and role are both set, both pass. Both-null is rejected at campaign publish and by the assignment-update trigger. Platform-admin audit visibility does not bypass an action's effective assignment predicate.

Human task completion and continuation are one `BEGIN IMMEDIATE` transaction keyed by task ID, expected status, expected assignment version, action scope/fingerprint, workflow instance, campaign dispatch, and pinned checksum. After acquiring the write lock it re-fetches and conditionally requires active user, current campaign write access, `campaign.operational_status='active'`, current owner/team assignment, exact `assignment_version`, every non-null effective task assignee ID/role predicate, `task.status='pending'`, `instance.status='active'`, reciprocal dispatch lineage, and pinned checksum. It then updates the task, writes one action log and campaign-linked knowledge archive, follows the action-specific pinned edge against the root trigger event, advances through at most 100 safe nodes, creates next tasks/logs with `assignment_version=1`, nonempty eligible actor sets, transaction-time deadlines or terminal state, and stores exact response `{ "success":true, "task_id":7, "task_status":"completed|rejected", "workflow_instance_id":12, "instance_status":"active|completed", "current_node_id":"...|null", "created_task_ids":[8] }` with sorted IDs. An empty eligible set caused by deactivation, demotion, transfer, or membership revocation after the template was pinned is a runtime validation failure, never an unreachable next task. Same key/hash replays exactly; changed hash conflicts. After authorization, a cancellation winner returns `CAMPAIGN_CANCELLED`, a hold winner returns `CAMPAIGN_ON_HOLD`, and only an active campaign with a transfer/reassignment/demotion/deactivation/revocation/pause/other action winner returns `409 STALE_WORKFLOW_TASK_ACTION` with exact details `{task_status,instance_status,campaign_operational_status:"active"}` and no side effect.

`POST /api/campaigns/:id/workflow-tasks/:taskId/reassign` is the only campaign task assignment mutation. It is owner/org-admin-only, requires `Idempotency-Key`, scope `workflow.campaign-task.reassign`, and exact body `{ "expected_task_status":"pending", "expected_instance_status":"active", "expected_assignment_version":1, "assignee_id":8|null, "assignee_role":"platform_admin|org_admin|team_lead|member"|null, "reason":"..." }`; at least one assignee field is non-null. A non-null ID must currently be an active user with active organization membership and campaign write access; a role must currently resolve at least one such actor under the same role truth table; both fields require a nonempty intersection. Malformed IDs/roles fail `400 INVALID_CAMPAIGN_INPUT`; missing/concealed and visible-ineligible targets use `RECORD_NOT_FOUND|RECORD_FORBIDDEN` before reservation. After current authorization, same-key/hash replay precedes new-state evaluation. On a miss, one `BEGIN IMMEDIATE` transaction reauthorizes the caller and applies exact precedence `CAMPAIGN_CANCELLED`, `CAMPAIGN_ON_HOLD`, then stale task/instance/assignment/completion, target identity/membership eligibility, and finally exact current/requested assignment equality. A completion, prior reassignment, user deactivation, team transfer, membership revocation, or newly empty role set after reservation returns zero-mutation `409 STALE_WORKFLOW_TASK_ACTION`. An identical current/requested `(assignee_id,assignee_role)` completes the ledger with zero-event `400 INVALID_CAMPAIGN_INPUT`, no assignment/version/log/archive mutation, and never reaches the no-change database trigger; same-key retries replay that 400 after authorization. On success it conditionally updates only effective assignment fields and increments `assignment_version`, appends exact `task_reassigned` node/activity logs containing previous/new assignment and versions, creates the required `campaign_workflow_log,<workflow_node_log_id>` archive/link, and completes a zero-event replay in the same transaction. Maximum assignment version returns `409 ROW_VERSION_EXHAUSTED`. Success is exact `{ "success":true,"task_id":7,"task_status":"pending","workflow_instance_id":12,"instance_status":"active","assignment":{"assignee_id":8,"assignee_role":"member","assignment_version":2} }`. Reassign/action, reassign/reassign, completion, pause, cancellation, transfer, deactivation, and dropped-response races each produce one winner and no unreachable or partially archived pending task.

If checksum/context/path validation fails, or if a reached next task has no transaction-time eligible actor because identity/role/membership changed after the snapshot was pinned, that action transaction rolls back fully. The empty-set case fingerprints exact sanitized `execution_error_code='WORKFLOW_ASSIGNMENT_UNRESOLVABLE'` and message `No eligible actor for workflow task`. A second audited `BEGIN IMMEDIATE` transaction must still match the same request-ledger ID/hash, `state='processing'`, exact unexpired lease token, active user/current authorization, still-pending task, active campaign/instance, reciprocal completed dispatch, and observed failure fingerprint. On a full match it sets only the instance to `failed_validation`, cancels every pending task, writes a `failed_validation` node/activity log plus required `campaign_workflow_log,<workflow_node_log_id>` archive, leaves the completed dispatch unchanged, and atomically completes the ledger with exact `409 INVALID_CAMPAIGN_WORKFLOW_TEMPLATE` and the safe failure code. That completed-dispatch/failed-instance pair is immediately eligible for post-initialization reconciliation. A dropped response therefore replays exactly. If another authorized state winner changes task/instance/campaign between transactions, this transaction performs no terminal corruption side effect and token-conditionally applies the same precedence: `CAMPAIGN_CANCELLED`, then `CAMPAIGN_ON_HOLD`, then `409 STALE_WORKFLOW_TASK_ACTION` only while active with exact `{task_status,instance_status,campaign_operational_status}` details. If authorization was revoked, it token-conditionally moves the ledger to internal failed and returns the common current `403`/concealed `404`; if the lease token was lost, it changes nothing and returns `409 IDEMPOTENCY_IN_PROGRESS` with retry metadata. Injected pause, task action, hold, cancellation, transfer, deactivation/demotion/membership-revocation before next-task creation, lease-expiry, and dropped-response races cover every branch. Thus no completed task is left stalled and no corrupted instance remains falsely actionable. The template FK is lineage only. Campaign templates cannot reach the current nondurable parallel/webhook/timer paths. Existing non-campaign webhooks remain one best-effort asynchronous call with no restart replay, and existing timers retain their current fired-before-advance crash window; Phase 4 makes no stronger claim and locks both behaviors with golden regressions.

Campaign-linked instance pause/resume/cancel keeps the existing routes but requires `Idempotency-Key`, campaign write, and exact body `{ "expected_status":"active|paused", "reason":"..." }`; server source is `workflow_instance_control`. Pause requires active, resume paused, and cancel active or paused. Pause/resume require an active campaign; terminal instance cancellation is also performed by the atomic campaign-cancellation cascade. The action-specific scope is selected only after current authorization and before ledger lookup. One `BEGIN IMMEDIATE` transaction re-fetches and conditionally requires active user, current campaign write access/owner-team membership, campaign operational predicate, reciprocal dispatch lineage, and exact instance status before changing status, writing the node/activity log plus campaign-linked knowledge archive, and for cancel changing every pending task to `cancelled`; it then completes exact response `{ "success":true, "instance_id":12, "status":"paused|active|cancelled" }`. Transfer/demotion/deactivation/revocation/hold/task/control races serialize on those predicates, so exactly one wins. Same key/hash replays only after current authorization; changed hash conflicts; processing returns retry metadata. After authorization, campaign `cancelled` and `on_hold` win in that order; `409 STALE_WORKFLOW_INSTANCE_STATUS` is returned only while active and contains exact safe `{ "instance_status":"active|paused|completed|cancelled|failed_validation", "campaign_operational_status":"active" }`. Access failure has zero side effect. Unlinked pause/resume/cancel retains its current no-key, no-body, exact `{ "success":true }` behavior.

Legacy workflow API and knowledge-archive serializers explicitly select their pre-Phase-4 fields so nullable trigger/campaign columns do not appear in existing response bodies or archived legacy content. Campaign instances use a separate enriched serializer. Existing customer-stage behavior is also golden-locked: on a changed stage it selects every active `module='customer'` template, calls `startWorkflow(templateId,'customer',customerId,{stage,previous_stage,customer_id},actorId)`, swallows per-template and outer startup errors, returns the existing customer response, and retains the current deferred 100 ms start advancement. The safer campaign-dispatch path is opt-in and does not alter that path.

## Authorization Matrix / 权限矩阵

Campaign read/write is allowed to active organization administrators, the owner, and active members of the assigned team. Cross-organization lookup returns `404`; same-organization nonmembers receive `403`. `platform_admin` means legacy `users.role='admin'`; `org_admin` means an active organization membership role. A platform admin may audit all organizations, while an org admin who is not a platform admin is bounded to that organization. Every privileged AI conversation list/detail read writes a sanitized `activity_log` row in the same fail-closed request transaction before returning data; audit failure returns `500 AUDIT_PERSISTENCE_FAILED`, never unlogged data. Audit details contain actor ID, target conversation/user IDs, organization ID, request ID, and filter names only, never prompts, replies, query text, tokens, provider data, or source excerpts.

Concealment is deterministic and shared by every campaign-linked route. A missing campaign or one in another organization returns `404 CAMPAIGN_NOT_FOUND`. An existing same-organization campaign for which the caller lacks the required campaign access returns `403 CAMPAIGN_FORBIDDEN`. After campaign authorization, a missing target or a target that fails its object-visibility predicate returns concealed `404 RECORD_NOT_FOUND` (knowledge keeps its narrower `404 KNOWLEDGE_ENTRY_NOT_FOUND`). A visible target for which the caller lacks the requested manage/mutate predicate returns `403 RECORD_FORBIDDEN`. Collection endpoints remove concealed targets before counts, grouping, ranking, and pagination. Current authorization is evaluated before any idempotency-ledger lookup and repeated under the final write lock, so a stored success never reveals revoked access. On the generic link route, only an unknown field, noncanonical ID, or invalid `relation_type`/`record_type` pair is `400 INVALID_CAMPAIGN_LINK`; a syntactically valid missing or non-visible target follows the `404` rule and is never collapsed into `400`.

The target decision table is closed and applies to direct reads, candidate lists, generic attach, correction, automatic side effects, replay, and workspace serialization:

| Target | Visibility predicate after campaign access | Manage predicate | Missing/non-visible | Visible but not manageable |
| --- | --- | --- | --- | --- |
| demand | exact legacy demand owner/read predicate plus immutable campaign custody | legacy owner/manage plus campaign write | `404 RECORD_NOT_FOUND` | `403 RECORD_FORBIDDEN` |
| proposal/PPT source | exact legacy proposal owner/read predicate plus immutable campaign custody | legacy owner/manage plus campaign write | `404 RECORD_NOT_FOUND` | `403 RECORD_FORBIDDEN` |
| influencer shortlist | existing shared influencer-library visibility; a shortlist never narrows the library | campaign write for attach/correction | `404 RECORD_NOT_FOUND` | `403 RECORD_FORBIDDEN` |
| collaboration/order/execution/publication/settlement | owner, platform admin, or active same-organization org admin, plus immutable campaign custody | the same object predicate plus campaign write and collaboration row-version guard | `404 RECORD_NOT_FOUND` | `403 RECORD_FORBIDDEN` |
| AI conversation | owner, platform admin, or bounded org admin, plus immutable single-campaign custody | owner/bounded admin plus campaign write | `404 RECORD_NOT_FOUND` | `403 RECORD_FORBIDDEN` |
| workflow instance | campaign read through its immutable dispatch/business projection | campaign write plus endpoint-specific task/control rule | `404 RECORD_NOT_FOUND` | `403 RECORD_FORBIDDEN` |
| knowledge entry | legacy visibility/owner predicate plus immutable campaign custody | legacy owner/manage plus campaign write | `404 KNOWLEDGE_ENTRY_NOT_FOUND` | `403 RECORD_FORBIDDEN` |

Campaign authorization itself is sufficient to return the bounded `customer {id,label}` and `opportunity {id,label}` summaries embedded in `Campaign`; labels are sanitized current CRM display labels with deterministic fallbacks `Customer #<id>` and `Opportunity #<id>`. They are business-spine context, not a grant to CRM detail, edit, public-pool, contact, activity, or financial fields. Phase 4 emits no record-specific CRM route from campaign serializers, workspace labels, option rows, cards, tables, or detail summaries. The generic opportunity-list route `/m0-detail?view=opportunities` may appear only as the single command in the create dialog's `no_eligible_opportunity` empty state; it is never attached to a specific customer/opportunity label or row. Record-specific CRM detail navigation is owned by Phase 5 after its permission-preserving route contract lands. Creation/options still require the stronger CRM manage rule.

| Surface | Unlinked legacy record | Linked record |
| --- | --- | --- |
| Campaign list/detail/workspace | n/a | filter by campaign access; collection counts use the same filter |
| Demand/proposal/PPT list/detail/write | existing owner rule | existing rule AND campaign access; linked creation revalidates in transaction |
| Collaboration list/stats/update | exact legacy response shape, but Phase 4 closes object authorization to owner, platform admin, or an org admin in the owner's organization | linked candidate/adoption/update repeats that target predicate plus campaign write inside the final transaction; inaccessible rows are removed before counts |
| Workflow instance/list/stats/task/detail/action | endpoint-specific legacy baseline below | campaign instance/children use campaign access; task actions additionally keep assignee/admin checks; aggregates filter linked rows first |
| AI conversation/list/detail/messages | existing owner/admin rule | one conversation belongs to at most one campaign; all messages inherit it; continuation may omit campaign and derive it from the conversation, but an explicit different campaign fails |
| Admin AI audit | platform admin all organizations; org admin own organization; ordinary user own conversations | same boundary, campaign reference included, successful privileged audit persistence required before response |
| Knowledge list/search/detail/use/categories | existing visibility/owner rule | existing rule AND campaign access; search/count/category aggregation filters before ranking/grouping |
| Influencer library | existing shared-library rule | shortlist link does not narrow the influencer library; workspace still checks source visibility |

Campaign provenance is immutable after the first non-shortlist link. A target with any historical non-shortlist link is `campaign_classified` forever; revocation never makes it an ordinary unlinked record. An active bundle's campaign is current custody. After a move, the destination active bundle is current custody and the source retains history only. After revoke-without-replacement, the source campaign remains custody, selected by the greatest canonical `(revoked_at,id)` from the aggregate revoked bundle. Direct/list/search/use/dedup/RAG serializers therefore require legacy visibility plus read access to current custody even when the request omits `campaign_id`. A historically classified target is excluded from generic non-shortlist candidate results and cannot use generic attach; a direct attempt returns `409 RECORD_REQUIRES_LINK_CORRECTION`, and only an authorized correction from immutable workspace history can reactivate or move the complete bundle. Shortlist references remain the explicit shared-library exception. Tests cover active, moved, revoke-only, deleted-target, candidate filtering, and concurrent reclassification cases so declassification cannot widen access.

Knowledge access is provenance-aware even when a caller omits `campaign_id`. Every source-identity dedup lookup, create/update/ingest/upload transaction, list/detail/search/similar/category query, `markKnowledgeUsed`, RAG candidate query, reference serializer, and AI/proposal/PPT context builder resolves historical classification and current custody before reading content. Truly unlinked entries retain the legacy visibility/owner access rule and exact legacy response token; campaign-aware code uses only the derived `private|team` projection without rewriting storage. Campaign-classified entries require that rule plus current custody campaign read, and writes require campaign write in the final transaction. An inaccessible hash/ID match returns a concealed `404 KNOWLEDGE_ENTRY_NOT_FOUND`; it is never returned, updated, linked, counted, ranked, marked used, or included in AI context. No full-content team-visible unlinked copy is emitted, and campaign-aware dedup never updates an unlinked entry into carrying restricted campaign content.

Every high-value linked producer in the table below has a **required atomic archive**: the source mutation, knowledge entry/chunks, `knowledge` link, usage/reference deltas when applicable, event, and request-ledger completion commit together or all roll back. “Suppressed” is legal only for a same-key replay or when the producer proves no semantic state change (for example a plain collaboration edit whose canonical archive projection is byte-identical); storage pressure, hash conflict, authorization loss, parser/provider failure, or link failure is never suppression. Such failures return the stable producer error or `507 KNOWLEDGE_STORAGE_CAPACITY_EXCEEDED` and leave no producer mutation. Truly unlinked v0.4 best-effort business archives retain their existing behavior and are not reclassified as Phase 4 evidence.

For a campaign-classified entry, `POST /api/knowledge/:id/use` derives custody before ledger lookup, requires `Idempotency-Key`, uses scope `knowledge.use.linked` and an exact empty payload, and atomically increments once plus completes exact `{ "success":true }`; truly unlinked use keeps its current no-key behavior. Campaign-scoped RAG may use truly unlinked visible entries plus entries in that exact campaign's custody, never a different campaign. Cross-team/cross-organization tests cover every caller, required archive path, legal suppression, unscoped ingestion, revocation, correction, and conversation continuation.

Campaign-owned automatic knowledge uses server-only `tm-knowledge-source-v1`, not the legacy delimiter hash. Its lowercase SHA-256 input is seven four-byte big-endian frames: version, canonical org ID, canonical campaign ID, source type, source ID, entry type, and canonical owner ID or empty for team visibility. Every numeric component is canonical positive-safe decimal with no whitespace or leading zero. All entries set `business_type='campaign'` and canonical `business_id=<campaign_id>`. Immutable `content_sha256` uses `tm-knowledge-content-v1`: seven four-byte frames containing the version literal, entry type, NFC/LF title, NFC/LF summary, NFC/LF content, canonical JSON of unique UTF-8-sorted NFC tags, and visibility. Except for the explicitly frozen truly-unlinked legacy `source_hash` selection below, every new digest-aware write rejects isolated surrogates, converts CRLF and lone CR to LF, then NFC-normalizes title, summary, content, and tags before canonical persistence and content/source-identity hashing. Each chunk stores `content_sha256=sha256(exact UTF-8 chunk bytes)` and an immutable safe `chunk_index`. For these campaign-owned immutable-source entries, the first insert stores every exact digest; a same-source retry must match entry content plus the complete ordered chunk-digest list and reuses that entry, while a mismatch returns `409 KNOWLEDGE_SOURCE_CONTENT_CONFLICT` and never overwrites. A matching legacy, unlinked, or different-custody entry is never reused. Review remains dedicated one-per-settled-event evidence: exact source `(campaign_review,<campaign_id>:<settled_event_id>)` is unique independently of owner/visibility, the identity is immutable, and its link trigger accepts only the original campaign plus matching settled-event metadata. It never cross-deduplicates or moves across campaigns.

The truly never-classified v0.4 `ingestKnowledge` service path is a separate compatibility branch and exposes no new public discriminator. At function entry it preserves the original JavaScript input values and runs the current `hashInput` byte-for-byte before valid-scalar/LF/NFC conversion; this raw-input `source_hash` calculation is the sole canonicalization exception. CRLF versus LF or NFC versus NFD may therefore select distinct truly-unlinked rows when the frozen content-derived/stable-source hash inputs differ even though their later canonical stored content/digest is equal; that distinction is intentional v0.4 identity compatibility. When both legacy `source_type` and `source_id` are present, the current stable-source hash selects and refreshes that same owner/admin-authorized unlinked row even when content changes; without that pair, the current entry/title/content/owner hash makes changed raw content select a new row. An existing equal hash preserves its immutable `source_identity_sha256` and atomically updates canonical legacy fields, `content_sha256`, ordered chunks/digests, and FTS projection. The existing trusted internal `allow_source_hash=true` supplied-hash refresh remains legal only for a never-classified row after legacy owner/admin authorization; it is not a campaign retry and therefore does not return `KNOWLEDGE_SOURCE_CONTENT_CONFLICT`. Any active or historical campaign classification routes to immutable-source custody rules before lookup and can never enter this update branch.

When that raw legacy hash has no row, the service opens `BEGIN IMMEDIATE`, repeats source-hash lookup/authorization/capacity under the lock, and preallocates the entry ID before insertion with exact query `WITH bounds AS (SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='knowledge_entries'),0) AS seq, COALESCE((SELECT MAX(id) FROM knowledge_entries),0) AS max_id) SELECT CASE WHEN seq>max_id THEN seq ELSE max_id END AS previous_id FROM bounds`. `previous_id` must have integer storage and be in `0..9007199254740990`; the explicit new ID is `previous_id+1`, must be absent, and is never inferred from `lastInsertRowid`. Before `INSERT`, the service computes `source_identity_sha256` with the exact `tm-knowledge-legacy-source-v1` typed grammar from that explicit ID plus the final canonical stored entry/source/business/creator values and the already raw-derived `source_hash`, computes canonical entry/chunk digests, then inserts the entry with its explicit ID, chunks, and FTS rows in the same transaction. SQLite advances `sqlite_sequence` transactionally for that explicit AUTOINCREMENT ID; rollback restores the sequence and every entry/chunk/FTS effect. Concurrent creators serialize and the later writer repeats dedup before allocation. Existing-row refresh never reallocates or recomputes source identity. Sequence/max disagreement, exhaustion, collision, digest, chunk, FTS, quota, or injected failure rolls the whole branch back.

New and rebuilt entries use exact `tm-knowledge-chunk-v1`. Starting from the stored canonical content, apply ECMAScript `String.prototype.trim()`. Empty input yields exactly one chunk `""`. Otherwise split on runs of two or more LF characters, trim each paragraph with the same operation, and discard empty paragraphs. Iterate in order with an empty accumulator: append a paragraph using exactly two LF characters when the resulting accumulator is at most 1,200 Unicode scalar values; otherwise emit the non-empty accumulator, keep a paragraph of at most 1,200 scalars as the new accumulator, or emit an oversized paragraph in consecutive at-most-1,200-scalar slices without splitting a scalar. Emit the final non-empty accumulator; if none was emitted, return `['']`. Chunk indexes are contiguous safe integers from zero. The input `U+0020 Alpha CRLF CRLF Beta U+0020 U+1F600 U+0020` yields one chunk with UTF-8 hex `416c7068610a0a4265746120f09f9880` and SHA-256 `73a747f2a6e9c5e3e65eb8552d8100319eda2cecae356c8abb7496ecf2fa1b3b`; empty content yields `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. A 1,201-scalar U+0061 paragraph yields 1,200- and 1-scalar chunks with hashes `4d21dde662555b99cb697061c3b5041108dedb8825a4bc5858737afbf640e492` and `ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb`. Migration backfill never rechunks legacy rows: it hashes each existing chunk's exact stored UTF-8 bytes and preserves its ID/index/content; only a later authorized unlinked edit rebuilds it under v1 atomically with entry digest and FTS projection.

Automatic archive projection is closed. Unless a row says otherwise, `summary` is the first 1,000 Unicode scalars of `content` after whitespace collapse, and `content` is canonical JSON with exactly the listed fields in listed order; fixed tags are unique UTF-8 sorted and no filename/path/provider secret is included.

| Producer | Exact `(source_type,source_id)` | Entry type/title/content projection | Visibility/tags |
| --- | --- | --- | --- |
| linked demand persisted | `campaign_demand,<demand_id>` | `campaign_demand`, `Campaign demand #<id>`, `{id,brand_name,company_name,product_name,industry,budget,target_market,platform,status,data}` from the committed row; `data` is parsed/canonicalized `data_json` | `team`; `campaign,demand` |
| linked proposal version persisted | `campaign_proposal,<proposal_id>` | `campaign_proposal`, `Campaign proposal #<id>`, `{id,demand_id,title,content_sha256,content}` from the committed immutable version | `team`; `campaign,proposal` |
| linked PPT completed | `campaign_ppt,<proposal_id>:<proposal_content_sha256>` | `campaign_ppt`, `Campaign PPT #<proposal_id>`, `{proposal_id,proposal_content_sha256,artifact_sha256,response_bytes}` from the winning ledger; never binary/path | `team`; `campaign,ppt` |
| collaboration semantic milestone | `campaign_collaboration,<collaboration_id>:<new_row_version>` | `campaign_collaboration`, `Campaign collaboration #<id>`, `{id,influencer_id,status,row_version,campaign_relation,cost_actual,cost_actual_confirmed}` from the committed row/request classification | `team`; `campaign,collaboration` |
| linked AI assistant message | `campaign_ai_message,<assistant_message_id>` | `ai_chat_summary`, `AI conversation summary #<conversation_id>`, exact text `Question:\n<user message>\n\nAnswer:\n<assistant message>`; summary is first 1,000 answer scalars | `private`; `ai_chat,campaign,conversation` |
| workflow task/control/terminal/reassignment log | `campaign_workflow_log,<workflow_node_log_id>` | `campaign_workflow`, `Campaign workflow #<instance_id>`, `{dispatch_id,instance_id,node_id,action,status,error_code}` with nulls retained; `task_reassigned` uses the committed node log and keeps assignment details only in its bounded audited log | `team`; `campaign,workflow` |
| workflow reconciliation event | `campaign_workflow_reconciliation,<reconciliation_event_id>` | `campaign_workflow`, `Campaign workflow reconciliation #<replacement_dispatch_id>`, exact `{original_dispatch_id,replacement_dispatch_id,template_id,template_version}` from the committed reconciliation event/dispatch | `team`; `campaign,workflow,reconciliation` |
| post-settlement review | `campaign_review,<campaign_id>:<settled_event_id>` | `campaign_review`; caller title/summary/content and unique sorted tags under endpoint bounds | caller `private|team`; caller tags plus `campaign,review` |

The schema-migration and service constants use these exact field names; unsupported producer fields are omitted rather than serialized as open metadata. Proposal/PPT content digests bind the immutable proposal version. Collaboration archive is suppressed only for a canonical byte-identical no-semantic-change edit. Instance-backed workflow archives use only a real committed node-log ID; reconciliation uses its separate event-backed source even before any instance exists. Workflow archives are required only for the committed task action, reassignment, instance control, terminal transition, or reconciliation transaction named by the source ID, never timer polling/heartbeat noise.

Campaign AI accepts at most 20 unique positive-safe `knowledge_entry_ids`; input order is semantic priority and is included unchanged in `tm-request-v1`. Before provider work and again before final persistence, the server requires campaign read plus each entry's derived normalized visibility/current custody. For each chosen entry it selects at most two chunks ordered by `chunk_index ASC,chunk_id ASC`, preserving entry input order. It then considers at most eight campaign-scoped retrieval candidates after chunk-ID deduplication, ordered by numeric FTS rank ASC, entry `updated_at DESC`, entry ID ASC, chunk index ASC, and chunk ID ASC. Migration's unique `(entry_id,chunk_index)` invariant makes the ID tie-break defensive and executable on every managed database.

The 96-KiB limit is the exact byte length of `knowledge_context_text`, not the whole provider prompt. For each finally included chunk at contiguous one-based rank `r`, render valid-scalar text exactly `"[KB-" + decimal(r) + "]\n" + COALESCE(entry.title,"") + "\n" + chunk.content`; join records with exactly `"\n\n"` and measure its UTF-8 bytes with no trailing separator. Selected chunks are rendered first; if their count exceeds 48 or their rendered text exceeds exactly 98,304 bytes, return `413 KNOWLEDGE_SELECTION_TOO_LARGE` before provider work without dropping or truncating a selection. Otherwise iterate the already ordered retrieved candidates. If appending the next whole candidate would exceed 48 chunks, eight retrieved chunks, or 98,304 bytes, stop retrieval at that first candidate; never skip it to fit a later row and never truncate content. Reference ranks/citation labels are generated only from this final list and remain contiguous. Boundary vectors cover 98,304/98,305 bytes, ranks 9/10, embedded LF, multibyte scalars, selected overflow, first-retrieved stop, and duplicate chunk IDs.

Each selected/retrieved chunk becomes exactly one immutable `ai_references` version-1 row. The response contains exactly one `knowledge_references` item per chunk with keys `{citation_label,entry_id,chunk_id,chunk_index,title,entry_type,source,visibility,snippet,selected,rank,source_identity_sha256,entry_content_sha256,chunk_content_sha256}`. `citation_label` is `KB-<rank>`; `selected` is boolean; `source` is the safe projection below; rank is contiguous from one. Snapshot columns repeat the exact campaign/entry/chunk identities and digests without raw hidden content. Current reads reauthorize entry and campaign custody; loss of access returns only `{ "citation_label":"KB-1","access_state":"restricted|missing" }`. Usage increments once per distinct entry in a successful non-replay assistant response, and `citation_count` counts distinct assistant message IDs, never chunk rows. A dropped response replays the same conversation/message/reference/archive IDs and never increments usage twice.

Linked AI provider custody is mandatory and abortable. `llm_service.complete` and `web_search_service.search` accept the same `{signal,deadlineAt}`; every network fetch receives that signal and adapters must settle on abort. Web search is optional: missing key, timeout, or provider failure yields `web_search.used=false` and no durable web cache write before the final commit. DeepSeek completion is mandatory for linked new/continued conversations: missing key, timeout, abort, malformed response, or non-2xx completes the request ledger as zero-event `503 AI_PROVIDER_UNAVAILABLE` and writes no conversation, user message, assistant message, reference, token usage, archive, web cache, or link. Only after provider success does one token-fenced `BEGIN IMMEDIATE` transaction repeat authorization and active-campaign predicates, then persist/reuse the conversation parent, both messages, per-chunk references, optional web results/cache, usage, required archive/link/event, and exact response. Unlinked v0.4 chat keeps its existing degraded fallback. A late provider result after abort/deadline/lease loss cannot enter the final transaction.

Persistent knowledge growth is bounded after same-key replay/source dedup and before insertion. The complete matrix is: per user, 50,000 entries, 500,000 chunks, 5 GiB payload, and 2,000,000 references; per current campaign custody, 100,000 entries, 1,000,000 chunks, 10 GiB payload, and 4,000,000 references; per organization, 500,000 entries, 5,000,000 chunks, 50 GiB payload, and 20,000,000 references. GiB means exact binary bytes (`1 GiB=1,073,741,824`). `knowledge_payload_bytes` deliberately counts both entry content and its stored chunk copies: for each entry sum UTF-8 byte lengths via `length(CAST(COALESCE(column,'') AS BLOB))` over exact columns `title,summary,content,key_terms,tags_json,metadata_json,embedding_json`; for each chunk add the same expression over `content,metadata_json,embedding_json`. No source label, ID, digest, timestamp, numeric counter, FTS posting, or reference row is included in this byte measure; references have their own count limits.

Entry/chunk/payload user attribution is `knowledge_entries.created_by`; a null creator has no user bucket. Campaign attribution is immutable current/historical custody resolution. Organization attribution is the custody campaign's organization or, for a truly unclassified entry with a creator, that creator's stable organization-membership row regardless of later revocation. A truly unclassified entry with `created_by IS NULL` is charged deterministically to the one organization whose immutable code is `turingmarket-default`, with no user attribution; missing/duplicate default-organization resolution fails closed, and migration/capacity initialization charges all accepted creatorless legacy entries through this branch. Reference user attribution follows assistant message -> conversation owner; campaign attribution is exact non-null `ai_references.campaign_id`; organization attribution follows that campaign, or the conversation owner's stable organization-membership row for a truly unlinked legacy reference. A create/archive/reference/link/correction transaction recomputes every applicable projected count under `BEGIN IMMEDIATE`; moving custody checks destination campaign/organization capacity before revoking source links. Replays and exact dedup reuse consume zero incremental capacity. Any projected value strictly above one limit returns `507 KNOWLEDGE_STORAGE_CAPACITY_EXCEEDED` with no producer, entry, chunk, reference, usage, link, event, cache, or custody mutation. Boundary tests cover exact limit/limit+1 for every dimension and attribution path, including creatorless-default-organization/no-user attribution, multibyte JSON/embedding text, duplicate entry content stored again in chunks, destination moves, and linked/unlinked references. Monitoring records sanitized 80/90/100-percent gauges; cleanup never auto-deletes immutable campaign evidence or references.

Ordinary campaign knowledge reads are explicit APIs, not admin `/kb` reuse. `GET /api/campaigns/:id/knowledge` accepts only optional `q` (0-200 characters), `source_type`, `entry_type`, `visibility=private|team`, `tag`, `linked=all|true|false` (default `all`), `limit=1..100` (default 20), and `offset>=0`. Its authorized candidate union is exactly truly never-classified entries visible under the legacy rule plus entries whose current custody is this campaign; `linked=true` keeps only the latter and `linked=false` only the former. Authorization/custody/source/tag filters run before count, FTS rank, and pagination. Non-empty `q` sorts by FTS rank then `updated_at DESC,id DESC`; empty `q` sorts by `updated_at DESC,id DESC`. Success is exact `{ "items":[CampaignKnowledgeItem],"total":1,"limit":20,"offset":0 }`, where each item has only `id,title,summary,tags,entry_type,source_type,visibility,usage_count,citation_count,updated_at,link_state` and `link_state` is `linked|available`.

`GET /api/campaigns/:id/knowledge/:entryId` applies the identical authorized union and concealed `404 KNOWLEDGE_ENTRY_NOT_FOUND`. Success is exact `{ "entry":{ "id":88,"title":"...","summary":"...","content":"...","tags":[],"entry_type":"...","source_type":"...","visibility":"private|team","source":{ "kind":"upload|ai_chat|demand|proposal|ppt|collaboration|workflow|review|manual|other","label":"Uploaded knowledge" },"created_at":"...","updated_at":"...","link_state":"linked|available" },"usage_count":1,"citation_count":2,"can_manage":true,"can_use_in_ai":true }`. `source.label` is a server-owned 1-80-character category label; ordinary APIs and AI references never expose raw `source_id`, legacy filename, local path, URL, provider payload, cache key, or artifact identity. `can_manage` recomputes legacy manage plus campaign write; `can_use_in_ai` recomputes campaign read and entry visibility/custody. Unknown query fields fail `400 INVALID_CAMPAIGN_INPUT`; neither endpoint mutates usage or creates a link.

`WorkspaceLink` is an exact tagged union; serializers reject extra keys rather than producing partially redacted objects:

| Tag | Exact keys in order | Meaning |
| --- | --- | --- |
| `available` | `link_id,relation_type,record_type,record_id,access_state,label,route,created_at,revoked_at` | Target exists and the caller passes its current visibility predicate. `record_id` is a canonical decimal string; `revoked_at` is canonical timestamp or null. |
| `restricted` | `relation_type,access_state,restricted_count` | Aggregate placeholder for targets hidden by current object/custody access; `restricted_count` is a positive safe integer. It never contains link/record IDs, timestamps, label, route, metadata, owner, or campaign ID. |
| `missing` | `link_id,relation_type,access_state,created_at,revoked_at` | Immutable trace for a deleted/unresolvable target; it never contains `record_type`, `record_id`, label, route, metadata, owner, or content. |

`active_links[relation_type]` contains available rows followed by at most one restricted aggregate and never contains missing rows. `link_history` contains visible available revoked rows and missing traces sorted by `(created_at,link_id)`, then at most one restricted aggregate per relation sorted by relation type. Restricted and missing evidence is never silently omitted. Available knowledge routes target the normal-user campaign surface `/campaigns?campaign=<id>&panel=knowledge&entry=<record_id>`; `/kb` remains the existing administrator surface.

The only polymorphic business-target hard-delete HTTP routes affected by campaign evidence are `DELETE /api/customers/:id` and `DELETE /api/opportunities/:id` in `platform/server/routes_customers.js`; both gain campaign-FK/link conflict guards. Customer deletion is one transaction that first counts opportunities and campaign evidence before deleting anything. Any dependency returns stable `409 CUSTOMER_HAS_DEPENDENCIES` with exact safe details `{ "dependencies":[{"type":"opportunities|campaigns","count":1}] }`, sorted by type and omitting zero counts, and leaves customer activity/customer rows unchanged; otherwise activity plus customer deletion commits atomically. Opportunity deletion similarly checks campaign evidence before mutation and returns `409 OPPORTUNITY_HAS_DEPENDENCIES` with the same details shape. An unexpected FK conflict maps to the route-specific code with `{ "dependencies":[{"type":"unknown","count":null}] }`, never a generic cross-route fallback code, and still rolls back every mutation. The existing workflow-template hard-delete route remains governed by the workflow dependency contract and must retain `WORKFLOW_TEMPLATE_HAS_DEPENDENCIES` behavior; source-inventory tests enumerate it separately. Phase 4 does not invent delete routes for demand, proposal, collaboration, workflow instance, AI conversation, or knowledge entry. Database FKs/triggers still reject out-of-band deletion of referenced campaign evidence.

The implementation ownership matrix is exact; a changed route outside this table is a scope failure:

| Method and path | Owner file | Legacy when `campaign_id` omitted | Campaign-linked enforcement |
| --- | --- | --- | --- |
| all non-workflow `GET|POST|PATCH /api/campaigns...` routes in the Phase 4 API table, including campaign knowledge and review | `platform/server/routes_campaigns.js` plus `services/campaign_service.js` | new namespace; no legacy branch | exact validators, authorization, lifecycle/custody, review, and workspace contracts in this design/API |
| `GET /api/campaigns/:id/workflow-reconciliation-options`; `POST /api/campaigns/:id/workflow-dispatches/:dispatchId/retry`; `POST /api/campaigns/:id/workflow-dispatches/:dispatchId/reconcile`; `POST /api/campaigns/:id/workflow-tasks/:taskId/reassign` | `platform/server/routes_campaigns.js` plus `services/campaign_workflow_service.js` | new namespace; no legacy branch | route module owns HTTP validation/mounting; workflow service owns authorization transaction, retry/reconciliation/reassignment state, archive, and replay behavior |
| `POST /api/auth/login`, `GET /api/auth/me` | `platform/server/server.js` | preserve token and legacy `user` object | resolve/repair missing default membership and append exact `auth_context`; revoked membership denies session restoration |
| `POST /api/admin/users`, `POST /api/auth/register`, `PUT /api/admin/users/:id`, `DELETE /api/admin/users/:id` | `platform/server/server.js` | preserve legacy response/password policy and soft-delete semantics | create, promotion, demotion, activation, soft deactivation, and department transfer synchronize organization/team memberships transactionally; all target sessions are invalidated on privilege/team/active change |
| `GET /api/users` | `platform/server/server.js` | platform-admin only after Phase 4 | return only bounded admin fields; ordinary/org-only users receive `403`; campaign options never call this route |
| `POST /api/demands`, `GET /api/demands` | `platform/server/server.js` | exact current body/status/list rule | atomic `demand` link on create; filter linked rows before list |
| `POST /api/proposals`, `GET /api/proposals` | `platform/server/server.js` | exact current body/status/list rule | atomic `proposal` link plus campaign-linked automatic knowledge archive on create; filter linked rows before list |
| `POST /api/proposal/generate-ppt` | `platform/server/server.js` | frozen ephemeral PPT bridge | save-first linked proposal, trusted `ppt` relation, exact binary replay |
| `POST /api/collaborations`, `GET /api/collaborations`, `PUT /api/collaborations/:id`, `GET /api/collaborations/stats` | `platform/server/routes.js` | exact response fields through an explicit serializer hiding version/confirmation fields; owner/platform-admin/same-org-org-admin object authorization closes the legacy IDOR; internal version increments under lock only after proving no historical classification | guarded confirmed create/versioned adoption; closed status graph; execution/publication/explicit-cost settlement/cancel alias rules; access filter before list/stats; final target and campaign reauthorization |
| `POST /api/influencers/upload` | `platform/server/routes.js` | exact current upload result and shared-library semantics | route-scoped auth-before-multipart parser, shared isolated upload launcher, no campaign link inference |
| `POST /api/demand/parse-file` | `platform/server/server.js` | exact current parser response and no persistence | route-scoped auth-before-multipart parser, shared isolated upload launcher, no ledger or campaign mutation |
| `GET /api/knowledge`, `POST /api/knowledge`, `GET /api/knowledge/search`, `POST /api/knowledge/ingest`, `POST /api/knowledge/upload`, `GET /api/knowledge/similar`, `POST /api/knowledge/:id/use`, `GET /api/knowledge/categories` | `platform/server/server.js` | current visibility/owner rules only for never-classified entries | create/ingest/upload may link; every listed read/use/category count resolves historical custody and filters inaccessible campaigns before ranking/grouping |
| `POST /api/ai/chat`, `GET /api/ai/conversations`, `GET /api/ai/conversations/:id` | `platform/server/server.js` | current owner/admin rules | new conversation may link; continuation derives or validates one immutable campaign; list/detail/messages inherit access |
| campaign workflow template/instance/task/stats routes | `platform/server/routes_workflow.js` | endpoint-specific golden baseline below | exact linked delta below; campaign start is dispatch-only |
| `DELETE /api/customers/:id`, `DELETE /api/opportunities/:id` | `platform/server/routes_customers.js` | current unlinked delete | one zero-mutation dependency transaction; route-specific `CUSTOMER_HAS_DEPENDENCIES` or `OPPORTUNITY_HAS_DEPENDENCIES` for ordinary, campaign, and mapped FK conflicts |

There is no collaboration export route in the baseline. `POST /api/influencers/export` in `platform/server/routes.js` is the shared influencer-library export and remains unchanged; a shortlist link does not narrow it. The one-shot AI routes `/api/ai/proposal-draft`, `/api/ai/strategy`, `/api/ai/demand-analysis`, and `/api/ai/ppt-outline` remain unchanged and campaign-unaware in Phase 4.

All identity writers, including soft-delete `DELETE /api/admin/users/:id`, share one transaction. User creation inserts the user, active default-organization membership, and deterministic active team membership. Promotion to legacy `admin` sets organization role `org_admin` and every active deterministic team membership to `team_lead`; demotion sets organization role `member` and every active team membership to `member`, so no lead privilege survives. Department transfer revokes the prior team row with `revoked_at` and activates/inserts the deterministic destination row using the role-derived team role. Soft deactivation sets `is_active=0`, revokes every membership, and deletes all target sessions atomically; reactivation restores only deterministic default/team memberships authorized by current role/department and still deletes pre-change sessions. Every role, department, membership-status, or active-state change writes one sanitized before/after identity event to `activity_log` and deletes all sessions for that target user in the same transaction; the log is the interval-history source while membership tables remain current projections. Failed membership/log synchronization rolls back the legacy user change. Authentication never silently reactivates an explicitly revoked/deactivated membership; it repairs only a genuinely missing default backfill row for an active legacy user.

The workflow legacy baseline and intentional Phase 4 deltas are explicit:

| Endpoint | Unlinked baseline preserved | Campaign-linked behavior |
| --- | --- | --- |
| template list/detail | any authenticated user; old response field set | old response unchanged; trigger config uses separate admin endpoint |
| template create/update | any authenticated user retains exact non-campaign behavior | campaign create/edit/conversion attempt follows the admin/version/module contract; campaign edits become inactive draft |
| template publish/delete | admin | campaign publish requires expected version/idempotency and validates trigger/safe graph; referenced template delete returns zero-mutation `409 WORKFLOW_TEMPLATE_HAS_DEPENDENCIES` with a safe dispatch count |
| manual instance start | any authenticated user for non-campaign business types | public API rejects campaign templates/context; campaign instances only come from dispatch |
| instance by-business | any authenticated user, currently unfiltered | linked rows require campaign read and inaccessible linked rows are omitted |
| instance list | admin all; non-admin `started_by=self` | linked rows use campaign read instead of started-by, unlinked predicate remains |
| instance detail | admin or starter | linked instance uses campaign read |
| pause/resume/cancel | currently any authenticated user | linked instance requires campaign write, action-specific idempotency scope, expected status, and atomic status/log/archive/ledger commit; unlinked behavior is intentionally unchanged |
| task list | for every role, only `assignee_id=self OR assignee_id IS NULL`; admin has no list bypass | apply that predicate first, then require campaign read for linked rows |
| task detail/approve/reject/complete | admin bypass, otherwise self-assigned or unassigned | platform admin may audit; every other actor must satisfy each non-null pinned assignee ID/role plus campaign access; both-null is rejected at campaign publish; approve/reject only approval and complete only task |
| stats | currently global for any authenticated user | totals contain all legacy unlinked rows plus only campaign-linked rows the caller may read |
| timer check | admin | unchanged |

Legacy serializers use explicit column lists, never `SELECT *`. Template list keys remain `id,name,description,module,category,version,is_active,created_by,created_at,updated_at`; template detail adds parsed `nodes,edges` and no `trigger_config_json`. Instance list/by-business keys remain `id,template_id,business_type,business_id,current_node_id,status,node_data,started_by,completed_at,created_at,template_name`; detail `instance` has the same keys except `template_name`. Task base keys remain `id,instance_id,node_id,node_type,title,description,assignee_id,assignee_role,status,comment,due_at,completed_at,completed_by,created_at`; task list appends `business_type,business_id,template_id,template_name`, and task detail additionally appends `node_data`. Node-log keys remain `id,instance_id,node_id,action,user_id,details,created_at`. Existing dynamic node properties are preserved and only the current derived `is_current,status,lastAction,lastActionAt` keys are appended. These arrays remain exact for every unlinked legacy row. For a campaign-linked row only, the task-list task, task-detail `task`, and instance-detail `tasks[]` projections append positive-safe integer `assignment_version`; the campaign workspace trace reuses that projection. Mixed lists omit the key on unlinked rows. Reload and stale-refetch tests prove every linked action/reassignment client can obtain the current token without exposing it on legacy responses.

Knowledge archival uses separate explicit legacy payloads: template archive contains exactly the twelve pre-Phase-4 template table fields including stored-string `nodes/edges`; instance archive contains exactly the ten pre-Phase-4 instance fields plus the existing action wrapper; task archive contains exactly the fourteen task fields. Trigger config, organization/campaign IDs, dispatch IDs, initialization fields, lease data, and snapshots never leak into an unlinked legacy API response or legacy knowledge archive. Campaign-specific serializers/archives are separately named and may include only the public enriched fields documented here.

## API Contract / API 契约

Authentication remains the current `Authorization: Bearer <tm_token>` contract; Phase 4 does not introduce cookies. Every campaign response echoes or generates `X-Request-Id`. Error bodies are `{ "error": "human message", "code": "STABLE_CODE", "request_id": "...", "details": {} }`. Unknown JSON fields are rejected on mutation endpoints. Text is trimmed; field limits come from the schema. IDs must be canonical safe integers.

Public generic-link `metadata` is omitted or exact `{}`; labels and notes are derived from the authorized target and caller reason rather than duplicated into link metadata. Trusted internal relation metadata uses the relation-specific closed schemas above, maximum depth four, 20 keys, 64 characters per key, 500 characters per scalar string, no binary/non-finite values, and at most 4,096 canonical UTF-8 bytes; the table CHECK enforces object type and byte ceiling. Unknown, over-depth, control-bearing, or oversized metadata fails `400 INVALID_CAMPAIGN_LINK` before ledger reservation.

| Endpoint | Contract |
| --- | --- |
| `GET /api/campaigns/options` | `mode=create|transfer`, `resource=opportunities|assignments`, optional `campaign_id,q,limit,offset`; returns one bounded permission-filtered resource |
| `POST /api/campaigns` | Required `name`, `opportunity_id`, `owner_user_id`, `team_id`; optional metadata; `Idempotency-Key`; returns 201 campaign |
| `GET /api/campaigns` | `q,state,operational_status,owner_user_id,team_id,limit,offset`; limit 1-100, offset >=0; returns filtered `items,total,limit,offset` |
| `GET /api/campaigns/:id` | Campaign and permitted labels; 200/403/404 |
| `PATCH /api/campaigns/:id` | Metadata only plus `expected_version`; idempotent; 200/409 |
| `POST /api/campaigns/:id/transitions` | `expected_state,expected_version,next_state,reason`; server-owned source; idempotent; 200/409 |
| `POST /api/campaigns/:id/operational-actions` | action, expected status/version, reason; server-owned source; idempotent |
| `POST /api/campaigns/:id/transfers` | new owner/team, reason, expected version; server-owned source; idempotent |
| `POST /api/campaigns/:id/links` | relation, record type/id, required caller `reason`, optional exact `{}` metadata; idempotent; 201/409 |
| `POST /api/campaigns/:id/link-corrections` | link ID, optional target campaign, reason; idempotent; 200/409 |
| `GET /api/campaigns/:id/link-candidates` | relation, q, limit 1-50, offset; returns only targets already visible to caller |
| `GET /api/campaigns/:id/workspace` | Campaign, events, dispatch status, and grouped links with access states |
| `GET /api/campaigns/:id/knowledge` | Ordinary-user authorized union search with exact filters, ranking, counts, and `CampaignKnowledgeItem` projection |
| `GET /api/campaigns/:id/knowledge/:entryId` | Authorized union detail with content, usage/citation counts, and current manage/AI capability flags |
| `POST /api/campaigns/:id/reviews` | settled active campaign; expected version plus exact review payload; atomically creates knowledge/review evidence and event; 201/409 |
| `GET /api/campaigns/:id/workflow-reconciliation-options` | Owner/org-admin recovery read; required `dispatch_id`; returns only active published checksum-valid templates matching the immutable root trigger plus safe failed-instance evidence |
| `POST /api/campaigns/:id/workflow-dispatches/:dispatchId/retry` | Owner/org-admin only, failed dispatch only, audited and idempotent |
| `POST /api/campaigns/:id/workflow-dispatches/:dispatchId/reconcile` | Owner/org-admin only; terminal failed-validation evidence remains immutable; creates audited replacement event/dispatch against repaired published snapshot |
| `POST /api/campaigns/:id/workflow-tasks/:taskId/reassign` | Owner/org-admin only; pending active task; expected assignment version; audited zero-event reassignment/archive with exact replay |

Required stable errors are exactly `CAMPAIGN_NOT_FOUND`, `CAMPAIGN_FORBIDDEN`, `INVALID_CAMPAIGN_INPUT`, `INVALID_CAMPAIGN_TRANSITION`, `INVALID_OPERATIONAL_TRANSITION`, `CAMPAIGN_GUARD_NOT_MET`, `CAMPAIGN_ON_HOLD`, `CAMPAIGN_CANCELLED`, `CAMPAIGN_EVIDENCE_IN_USE`, `CAMPAIGN_CONTEXT_REQUIRED`, `STALE_CAMPAIGN_STATE`, `STALE_CAMPAIGN_VERSION`, `ROW_VERSION_EXHAUSTED`, `INVALID_CAMPAIGN_LINK`, `RECORD_NOT_FOUND`, `RECORD_FORBIDDEN`, `RECORD_ALREADY_LINKED`, `RECORD_REQUIRES_LINK_CORRECTION`, `UNSUPPORTED_MEDIA_TYPE`, `INVALID_REQUEST_BODY`, `IDEMPOTENCY_REQUIRED`, `IDEMPOTENCY_IN_PROGRESS`, `IDEMPOTENCY_KEY_REUSED`, `IDEMPOTENCY_EXPIRED`, `IDEMPOTENCY_RATE_LIMITED`, `IDEMPOTENCY_STORAGE_CAPACITY_EXCEEDED`, `AUDIT_PERSISTENCE_FAILED`, `CONVERSATION_CAMPAIGN_MISMATCH`, `STALE_COLLABORATION_VERSION`, `INVALID_COLLABORATION_TRANSITION`, `COLLABORATION_COST_CONFIRMATION_REQUIRED`, `KNOWLEDGE_ENTRY_NOT_FOUND`, `KNOWLEDGE_SELECTION_TOO_LARGE`, `KNOWLEDGE_SOURCE_CONTENT_CONFLICT`, `KNOWLEDGE_STORAGE_CAPACITY_EXCEEDED`, `WORKFLOW_TASK_ACTION_NOT_ALLOWED`, `STALE_WORKFLOW_TASK_ACTION`, `STALE_WORKFLOW_INSTANCE_STATUS`, `CAMPAIGN_TEMPLATE_REQUIRED`, `CAMPAIGN_TEMPLATE_MODULE_IMMUTABLE`, `CAMPAIGN_TEMPLATE_CREATE_REQUIRED`, `STALE_WORKFLOW_TEMPLATE_VERSION`, `INVALID_CAMPAIGN_WORKFLOW_TEMPLATE`, `WORKFLOW_TEMPLATE_NOT_FOUND`, `WORKFLOW_TEMPLATE_HAS_DEPENDENCIES`, `DISPATCH_NOT_RETRYABLE`, `DISPATCH_NOT_RECONCILABLE`, `DISPATCH_ALREADY_RECONCILED`, `PPT_GENERATION_IN_PROGRESS`, `PPT_GENERATION_RATE_LIMITED`, `PPT_STORAGE_CAPACITY_EXCEEDED`, `PPT_GENERATION_FAILED`, `REPLAY_ARTIFACT_INVALID`, `PROPOSAL_CONTENT_CHANGED`, `UPLOAD_LIMIT_EXCEEDED`, `UPLOAD_PARSE_TIMEOUT`, `UPLOAD_UNSUPPORTED_TYPE`, `UPLOAD_INVALID_CONTENT`, `AI_PROVIDER_UNAVAILABLE`, `CUSTOMER_HAS_DEPENDENCIES`, and `OPPORTUNITY_HAS_DEPENDENCIES`.

Existing writes accept optional `campaign_id` only for demand create, proposal create/version-save, persisted PPT proposal output, collaboration create/update-alias, knowledge create/ingest/upload, and AI chat conversations. Public manual workflow start remains legacy-only; campaign workflow links are internal dispatch output. If campaign ID is omitted, successful request/response behavior remains unchanged except the intentional global collaboration object-authorization repair, explicit legacy serializer, safe knowledge-upload sandbox, and PPT admission controls; no campaign fields appear. If present, `Idempotency-Key` is required and the exact route contract in `docs/api/campaign-business-spine.md` governs fields/status/body/errors.

For JSON requests the request hash covers method, canonical path/body, and campaign ID. For multipart requests it additionally covers every ordered canonical field plus each file's SHA-256, byte length, normalized MIME type, and normalized basename; raw filenames are not stored in the ledger. Different bytes under the same idempotency key conflict.

For async file/provider operations the server preauthorizes, reserves idempotency, works in a lease-owned private temporary path, and revalidates in the final transaction. Output-producing operations validate and no-replace promote only to their immutable attempt artifact path before the token-matched database commit; that transaction alone chooses/persists the winning artifact with the base record/link and completed replay metadata. Commit failure or lease loss deletes only the caller-owned artifact. A process death before commit can leave only an unreferenced attempt file, never a row/link; a startup janitor deletes it. A process death after commit is replayable from the retained winner. The cache is outside the static tree and is streamed only through the authenticated route after rechecking current campaign/record access; revocation returns `403` instead of replaying sensitive bytes. PPT output and idempotency metadata are retained together for 30 days. Non-output operations commit base row/link/replay atomically after provider work. External provider billing cannot be exactly-once, but durable records and replay artifacts cannot duplicate or cross lease ownership.

Every `POST /api/knowledge/upload`, linked or unlinked, keeps the existing 15 MiB compressed request ceiling and uses one closed parser contract before any business insert: extension plus magic-byte agreement; at most 100 MiB expanded bytes, 10,000 archive entries, 64 worksheets/slides, 100,000 rows, 1,000,000 cells, 500 PDF pages, and 10 MiB extracted UTF-8 text. Archive path traversal, symlinks, encrypted entries, polyglots, duplicate normalized names, malformed containers, and limit overflow fail with the exact stable upload codes. The same production launcher also wraps `/api/influencers/upload` and `/api/demand/parse-file` while preserving their frozen route-specific byte/row/response contracts. No public upload/parser route has an in-process or less-isolated fallback.

All three routes reserve a durable internal parser admission **after request-ID/auth/header validation and before reading a body**. The null-campaign scopes are exactly `parser.knowledge-upload.admission`, `parser.influencer-upload.admission`, and `parser.demand-parse.admission`; the key is server-random, expected event count is zero, and the internal request hash binds version/organization/user/method/canonical path/request ID without file data. One `BEGIN IMMEDIATE` transaction admits at most one processing parser request per user, three per organization, and four globally, plus at most 20 accepted starts per user/hour, 100 per organization/hour, and 200 globally/hour across all three scopes. It also requires the root-owned parser spool to have at most 512 MiB reserved/observed bytes and at least 2 GiB free after the new 128-MiB reservation. Same request never reserves twice. Limit rejection returns bounded `429 IDEMPOTENCY_RATE_LIMITED` or `507 IDEMPOTENCY_STORAGE_CAPACITY_EXCEEDED`, closes the unread request, and creates no upload/job file. The admission has a 90-second immutable total deadline covering the 60-second body wall limit, 20-second parser, and cleanup; success becomes 24-hour accounting-only `completed/admission`, while abort/failure becomes internal `failed`. Linked knowledge upload separately creates its content-bound campaign ledger only after the authenticated bounded body hash exists; both ledgers must be live before parser launch. Retained admissions make rate accounting restart-safe, and startup terminalizes expired rows before accepting uploads.

The Linux production launcher is exact. Deployment creates a locked no-login `turingmarket-parser` UID/GID with no supplementary groups and validates its passwd/group identity on every start. Each request gets a random root-owned `0700` job directory beneath `/var/lib/turingmarket-parser/jobs`; input is copied through an already-open regular `O_NOFOLLOW` descriptor into a root-owned `0440 root:turingmarket-parser` file, output is a separate parser-owned `0700` directory, and every path component is `lstat`-verified as a non-link on the same expected filesystem. A checksum-pinned parser executable/dependency manifest is mounted read-only. The checked-in sources of truth are `platform/server/systemd/turingmarket-parser@.service`, `platform/server/systemd/turingmarket-parser.slice`, and their release-manifest SHA-256 values. Every instance sets `Slice=turingmarket-parser.slice`, exact `User=turingmarket-parser`, `Group=turingmarket-parser`, `UMask=0077`, fixed `Environment=LANG=C.UTF-8 LC_ALL=C.UTF-8`, `NoNewPrivileges=yes`, `CapabilityBoundingSet=`, `AmbientCapabilities=`, `PrivateNetwork=yes`, `IPAddressDeny=any`, `RestrictAddressFamilies=AF_UNIX`, `PrivateDevices=yes`, `DevicePolicy=closed`, `PrivateTmp=yes`, `PrivateUsers=yes`, `ProtectSystem=strict`, `ProtectHome=yes`, `ProtectKernelTunables=yes`, `ProtectKernelModules=yes`, `ProtectControlGroups=yes`, `ProtectClock=yes`, `ProtectHostname=yes`, `ProtectProc=invisible`, `ProcSubset=pid`, `RestrictSUIDSGID=yes`, `LockPersonality=yes`, `SystemCallArchitectures=native`, `SystemCallFilter=@system-service`, `SystemCallFilter=~@mount @privileged @raw-io @reboot @swap @resources @obsolete @debug @clock`, `SystemCallErrorNumber=EPERM`, `TasksMax=32`, `LimitNOFILE=64`, `LimitFSIZE=134217728`, `MemoryMax=512M`, `CPUQuota=100%`, and `RuntimeMaxSec=20`. Each instance receives a private `TemporaryFileSystem=/scratch:rw,nosuid,nodev,noexec,size=128M`; all expansion/intermediate work stays there and is charged to the cgroup, while only the closed <=10-MiB result may reach the writable output bind. The aggregate slice sets `MemoryAccounting=yes`, `CPUAccounting=yes`, `TasksAccounting=yes`, `IOAccounting=yes`, `MemoryHigh=1536M`, `MemoryMax=2G`, `CPUQuota=400%`, and `TasksMax=128`; the four-job database gate, 512-MiB spool reservation, per-job scratch cap, and 2-GiB free-space floor are the aggregate storage envelope. Per-job drop-ins supply only descriptor-validated exact read-only input/runtime binds and one writable output bind; all other paths remain protected. The environment contains no application secret, token, database path, home, proxy, provider key, or network namespace interface. Production startup verifies both checked-in file hashes and every live unit/slice `systemctl show` property, identity, manifest, mount, syscall/network/write escape, and aggregate-pressure self-test; any mismatch aborts before the server listens. There is no production route-disabled degraded mode.

The parent enforces the same 20-second parser wall deadline independently, kills the entire cgroup on timeout/abort/shutdown/lease loss, waits for collection, and accepts only regular single-link output files opened with `O_NOFOLLOW` whose size/type/hash match the closed parser result manifest. It then copies validated bytes into application-owned storage; parser-owned paths are never served or parsed in process. Cleanup unlinks files without following links, fsyncs each directory, removes the job tree, and verifies absence before either parser/campaign request ledger can be completed/failed or reclaimed. Production startup fails before listen if the dedicated identity, kernel isolation features, unit/slice properties, manifest hashes, mount rules, admission/spool checks, or network/write/aggregate-pressure self-tests differ. Zip-bomb, malformed Office/PDF, per-user/org/global flood, retained-rate restart, spool/free-space pressure, fork/FD/memory/CPU/task/scratch pressure, syscall/network/host-file escape, symlink/hardlink substitution, timeout, process crash, unlinked bypass, abort, restart, and cleanup tests invoke this exact launcher.

### Frozen PPT Campaign Adapter / 冻结 PPT 活动适配层

`platform/ppt.js` remains byte-for-byte frozen at build `20260702-v916-kb-bridge-client-cn` and SHA-256 `f311a7b33ee28e64c8e19a14bae436101272dd17bf2f4f8c5d181d57dd0e291e`. Phase 4 adds `platform/client/features/campaign_ppt_bridge.js`, loaded after `ppt.js`, and narrow prepare/observe hooks in the central `apiFetch`; it does not edit renderer source or rendering internals. The adapter replaces only the public global `parsePPTContextFileOnServer` entrypoint after load with behavior-equivalent calls through central `apiFetch`, retaining the frozen fallback parser and response shape. This removes the frozen helper's direct Bearer fetch without changing `ppt.js` bytes. The adapter also wraps the public generate/editor-save/editor-preview/download commands and restores campaign-specific wrappers when disabled; no generic `window.fetch` interception is allowed.

The restrictive CSP is always on, including unscoped PPT use, so a separate external `client/core/csp_compat.js` runs after frozen `ppt.js`. It observes only `#proposalOutput` and `#tmPPTEditorOverlay`, converts each frozen allowlisted inline handler grammar to a `data-tm-action` plus delegated listener without `eval`/`Function`, removes the original `on*` attribute synchronously before user interaction, and rejects any unknown handler string. It also overrides only `previewPPT` and `previewEditedPPT` with behavior-equivalent popup rendering that strips the generated inline script/handlers and loads same-origin external `client/features/ppt_preview_runtime.js`; downloaded standalone HTML remains bytes/content-equivalent because its inert string is not executed inside the platform origin. Scoped and unscoped generate, editor add/move/duplicate/delete/save/close, popup keyboard/navigation, HTML download, clipboard, and PPTX download run under real Express/Nginx CSP with zero violations while the frozen hash remains exact.

When no campaign is active, campaign persistence hooks are no-ops and the exact v0.4 save/download behavior remains; the always-on CSP compatibility layer above is behavior-only and never changes request payloads or generated deck data. With an active campaign, the adapter wraps the global generate/download commands, allocates stable per-action idempotency keys in the scoped proposal draft, and augments the frozen proposal-save request with `campaign_id`. Successful linked save returns exactly `201 { "id": 17, "campaign_id": 42, "content_sha256": "<lowercase sha256>" }`; the adapter clones/observes the response without consuming it and records those three values. `content_sha256` is over `tm-request-v1` canonical JSON bytes of the parsed persisted proposal content. The existing unlinked response remains exact `200 { "id": 17 }`.

The frozen generator currently ignores the save response and catches save failure. The wrapper therefore resets save state before generation and inspects it afterward: a missing/non-2xx/invalid linked-save result leaves the generated preview editable but marks it “尚未归档”, disables campaign PPTX download, shows a persistent inline error, and exposes “重试保存方案” using the same content and idempotency key without rerunning AI. It must not show campaign-save success. Only a verified linked save enables download. Any editor save or preview that changes `lastPPTOutline` invalidates the captured proposal ID/hash immediately and disables campaign download. The next download first persists the exact latest outline through a new linked `POST /api/proposals` version using a stable save-version idempotency key, captures its returned ID/hash, then proceeds; save failure keeps the edited preview and does not call PPT generation.

Before calling the frozen download command, the adapter guarantees the current editor outline has a verified linked proposal version, then injects `campaign_id`, that latest `proposal_id`, its `proposal_content_sha256`, and a stable download idempotency key into `/api/proposal/generate-ppt`. The server loads the proposal, rechecks owner/admin plus active campaign `proposal` link, parses stored content, and requires the canonical SHA-256 of stored content, the submitted hash, and canonical SHA-256 of request `outline` to be identical before passing the unchanged normalized payload to the frozen renderer. A mismatch returns `409 PROPOSAL_CONTENT_CHANGED` without rendering, billing, output, or `ppt` link.

Linked PPT generation is single-flight per immutable proposal version across all idempotency keys. `resource_claim` is SHA-256 over five four-byte length frames containing exact UTF-8 `tm-ppt-proposal-claim-v1`, canonical organization ID, campaign ID, proposal ID, and the 64-byte lowercase proposal content digest. After current authorization and same-key replay/conflict handling, the reservation transaction checks an existing active `ppt` alias, then inserts a processing ledger carrying that claim. The partial unique claim index admits one renderer. A different key that finds the winning claim still processing returns `409 PPT_GENERATION_IN_PROGRESS` with `Retry-After` derived from its lease and no proposal/cache identity; a different key that finds a retained successful binary claim or active alias returns `409 RECORD_ALREADY_LINKED` with exact safe details `{ "relation_type":"ppt","record_type":"proposal","record_id":"17" }`. Failed/deadline/error JSON outcomes do not retain the active claim predicate, so a new authorized key may retry; same-key replay remains first. Final binary commit creates the inherited `ppt` alias and required PPT knowledge archive in the same transaction. Concurrency tests force two different keys through the precheck barrier and assert exactly one renderer/provider call, one artifact, one alias, one archive, and one billed result. Regeneration requires saving a new immutable proposal version first. This is the only campaign bridge; temporary filenames are never campaign identities.

## Project Workspace And Context Propagation / 项目工作台与上下文传递

The existing navigation adds `项目工作台` at canonical route `/campaigns`. A compact campaign context control appears on the workspace and on existing M3, M4, M5, workflow, and knowledge integration surfaces when a campaign is active. Context is explicit, user/organization scoped, and never silently rebound.

Both successful `POST /api/auth/login` and `GET /api/auth/me` preserve the existing `user` object and add the same server-owned sibling `auth_context`: `{ "organization": { "id": 1, "code": "turingmarket-default", "name": "TuringMarket", "role_code": "org_admin|member" }, "teams": [{ "id": 2, "code": "global-sales", "name": "Global sales", "role_code": "team_lead|member" }] }`. Login also preserves the existing top-level token. Authentication resolves/repairs only a missing default membership before responding; the client never submits `org_id`. Backward compatibility keeps `tm_user` as the legacy user JSON only and stores the sibling context separately as `tm_auth_context:v1` with exact `{ "user_id": 3, "auth_context": { ... } }`; a mismatched/malformed user ID fails restoration and triggers cleanup. No campaign surface initializes until both user ID and organization ID exist.

Because Phase 4 retains the existing browser-readable Bearer token for compatibility, stored-XSS removal is a release blocker. Every authenticated view replaces server/user-derived `innerHTML` interpolation with `textContent`, `createElement`, safe attribute setters, or a reviewed static-template helper that accepts no data-bearing HTML. Rich proposal/AI/knowledge text renders as text unless processed by an allowlist sanitizer with URL-protocol filtering and regression fixtures. All static and generated inline `on*` handlers and `javascript:` URLs are removed or translated by reviewed external delegated listeners, including the exact frozen-PPT compatibility path above, before enforcing exact CSP `default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; connect-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; form-action 'self'`. Express candidate and Nginx production responses emit the same header. Stored payload canaries in CRM, brand, influencer, workflow, AI, knowledge, and both scoped/unscoped PPT surfaces must remain inert through render/reload/export, every frozen PPT control must work, and CSP violation capture must be empty. Cookie migration remains a later intentional auth version, not a substitute for this Phase 4 gate.

Session storage keys are exact. Active context uses `tm_campaign_context:v1:<user_id>:<org_id>` with JSON `{ "campaign_id": 42, "updated_at": "ISO-8601" }`. Drafts use `tm_campaign_draft:v1:<user_id>:<org_id>:<surface>:<draft_uuid>`, where surface is one of `m3-demand`, `m3-proposal`, `m4-shortlist`, `m4-collaboration`, or `m5-chat`, and value is `{ "campaign_id": 42|null, "dirty": true, "updated_at": "ISO-8601", "payload": {} }`. Pending mutation intents use `tm_mutation_intent:v1:<user_id>:<org_id>:<intent_uuid>` and contain only route/scope, canonical request fingerprint, idempotency key, creation time, and terminal flag; they never contain body text, token, or file bytes. Brand search history moves from the unsafe global `tm_brand_search_history` key to `tm_brand_search_history:v1:<user_id>:<org_id>`; the legacy global key is deleted without migration because it has no trustworthy owner metadata. Draft/intent UUIDs are generated once when editing begins and retained through transport retries. Payload size is capped at 1 MiB; token, password, provider credential, and binary file bytes are forbidden.

The cross-tab authentication binding is exact `tm_auth_binding:v1={"generation":"<32 lowercase hex>","user_id":3,"organization_id":1,"token_sha256":"<64 lowercase hex>"}`. `generation` is 16 cryptographically random bytes created for each successful login/restore adoption, and `token_sha256` is SHA-256 of the exact UTF-8 Bearer token. A tab accepts an identity only after reading `tm_token`, `tm_user`, `tm_auth_context:v1`, and the binding twice with identical values, recomputing the token hash, and matching all three IDs to the server-owned `/auth/me` response. Login/user switch writes token, legacy user, and auth context first and the binding last; logout removes the binding first. Any malformed, partially written, or mismatched tuple suspends authenticated rendering and is cleared through the one cleanup path.

`clearAuthenticatedClientState(reason, previousUser, previousAuthContext, expectedGeneration)` is the one client cleanup path. Explicit logout, the central `apiFetch` `401` branch, failed `/auth/me`, and login as a different user call it before showing/initializing UI. It removes `tm_token`, `tm_user`, `tm_auth_context:v1`, `tm_auth_binding:v1`, `tm_ai_memory`, unsafe legacy `tm_brand_search_history`, the exact prior scoped brand-history/context keys, all prior-user/org draft and mutation-intent prefix keys, active campaign/draft/brand/AI/PPT/workflow memory, and every pending authenticated request controller. Persistent credential keys are removed only when the current binding is absent or still equals `expectedGeneration`; an old tab or delayed `401` can never erase a newer login. In-memory state and controllers for the old generation are always discarded.

All tabs subscribe to both the `storage` event for the four credential keys and `BroadcastChannel('tm-auth-v1')`. A login, restore, logout, user switch, or `401` broadcasts only `{type:'auth-changed',generation}` with no token or profile data. Any credential-key event immediately increments the tab-local monotonic generation, aborts every authenticated controller, freezes mutations, and then adopts only a fully validated stable tuple or shows login. Central `apiFetch` captures the tab-local generation plus the exact persistent binding tuple and discards/aborts any response unless both still match immediately before parsing side effects and again before DOM/storage mutation. `wfApi`, the adapter-owned PPT parser/bridge calls, uploads, AI, and every other authenticated helper delegate to this path; no direct helper handles `401` independently. Two-tab tests cover logout, delayed `401`, same-user relogin with a new token, user/org switch, partial storage writes, and an old response arriving after the new binding.

The complete Phase 4 query schema is deterministic:

| Path | Accepted known parameters | Valid combinations |
| --- | --- | --- |
| `/campaigns` | `campaign`, `panel`, `entry`, existing admin-only `preview` | `campaign` positive safe integer; `panel=overview|knowledge|workflow`, omitted panel means overview; positive safe `entry` is accepted only with `panel=knowledge` and must be available in that campaign |
| `/m3` | `campaign`, `step`, `record`, `preview` | with campaign: `step=demand|proposal`; optional positive safe `record` must match that target type; without campaign, existing unscoped M3 behavior |
| `/m4` | `campaign`, `tab`, `record`, `preview` | with campaign: `tab=tab1|tab2`; optional positive safe `record`; without campaign retain legacy `tab1|tab2|tab3` |
| `/m5` | `campaign`, `conversation`, `preview` | optional positive safe conversation must belong to the explicit campaign; without campaign retain unscoped AI |
| `/workflow-instances` | `campaign`, `instance`, `preview` | optional positive safe instance must be visible under explicit campaign; without campaign retain legacy instance list |
| `/kb` | `campaign`, `entry`, `preview` | admin-only existing alias; optional positive safe entry must be visible under explicit campaign |

Known parameters may occur once only. Canonical query order is `campaign`, route substate (`panel|step|tab`), target (`record|conversation|instance|entry`), then existing admin-only `preview`. Unknown parameters are removed with one `replaceState` only after every retained known parameter validates. An invalid/duplicate known parameter or invalid combination causes no fetch/storage mutation, preserves the entered URL, and renders an invalid-link state with a return-to-list command; it never silently falls back. `TMNavigation.parsePathState`, `pathForState`, `restore`, and simple-route handling all use this table so query state is not discarded or canonicalized away.

Context precedence and state transitions are normative:

| Situation | Required behavior |
| --- | --- |
| valid `campaign` URL parameter | URL wins; fetch access, bind only after `200`, then write the exact scoped context key |
| syntactically invalid parameter | no fetch or storage mutation; show invalid-link state and a return-to-list command |
| URL campaign returns `403`/`404` | active context is null; if it equals stored ID remove that key; render the defined 403/404 state without falling back silently |
| `/campaigns` with no parameter | validate and restore the scoped session value; if absent/invalid show campaign list with no selection |
| M3/M4/M5/workflow route with no parameter | preserve the legacy unscoped page; stored context is not auto-applied, preventing accidental linkage |
| context control selection | create a navigation intent; after dirty handling fetch the target before changing history; only after `200` push the canonical URL and store/bind it; on network/authorization failure retain the prior URL/context/form and show inline retry |
| clear context | after dirty handling push the canonical unscoped URL, remove the scoped value, and return the module to legacy mode |
| browser back/forward | `popstate` applies the target canonical URL without push/replace; each successful historical context becomes the scoped value |
| logout, `401`, failed restore, or user switch | call `clearAuthenticatedClientState` for the prior identity before showing login or the next user's UI |

Every history entry written by `TMNavigation` contains a monotonic `tmNavigationIndex`. A navigation intent captures current URL/state/index/context, target URL/state/index, trigger focus, and dirty form/draft ID before writing or binding. Link/select/clear intents show the Save/Discard/Cancel dialog before `pushState`. On dirty `popstate`, navigation immediately restores the current entry with one suppressed `history.go(currentIndex-targetIndex)` and then opens the same dialog. Save awaits the captured form's real persistence promise: on success it clears dirty/draft state and replays the original intent once; on failure it keeps the current URL/context/form, keeps the dialog open with an inline error, writes no history/storage, and focuses the error. Discard deletes only that draft, clears dirty state, and replays once. Cancel changes nothing and restores trigger focus. A replayed back/forward uses `history.go(targetIndex-currentIndex)`; other intents perform one push. No dialog branch silently rebinds a form, duplicates history, or loses a failed save.

The workspace provides “open existing creation surface” and “attach existing accessible target” commands for demand, proposal/PPT source, shortlist, collaboration aliases, AI conversation, and knowledge. Workflow is the explicit exception: lifecycle transitions auto-dispatch published templates. The filtered workflow panel shows pending/processing/backoff/dead-letter/pre-initialization-failed-validation/completed/post-initialization-failed-validation states, safe error text, root/reconciliation lineage, retry eligibility, and one owner/org-admin “修复并重新派发” dialog that loads only active published trigger-matching templates, captures expected template version plus reason, and handles stale/already-reconciled results without hiding old evidence. The admin workflow designer exposes campaign trigger edit, dirty/inactive state, exact validation reasons, publish confirmation/version, and published checksum; ordinary users cannot see those controls. Labels replace raw IDs. Owner/team transfer, link correction, operational status, lifecycle transition, workflow retry, and reconciliation require authorization and a reason.

The campaign `knowledge` panel is the complete ordinary-user knowledge surface; it does not redirect to the administrator-only `/kb` route. A campaign reader can search the union of truly unlinked entries visible under the legacy rule and entries in this campaign's custody, inspect available linked entry title/summary/tags/source and citation/use counts, open an entry through the `entry` query state, and see restricted/missing trace placeholders. A campaign writer who also passes the target knowledge manage rule can create, upload, ingest, attach, correct, and mark used through the same panel. “Use in AI” opens `/m5?campaign=<id>` with the selected entry IDs as in-memory context only after server reauthorization; raw content is never placed in URL/storage. Empty/loading/error/403/404/stale-upload states preserve filters and focus. Every command uses the existing Phase 3 controls, spacing, icons, and table patterns; Phase 4 adds no second visual system.

Campaign create/transfer dialogs load `GET /api/campaigns/options`; they never use the existing global users endpoint. An org admin sees all legal active organization assignment pairs; a team lead sees members of teams they lead; an ordinary member can create only self-owned campaigns in teams they belong to. Transfer options follow the current-owner/org-admin rules. Opportunity rows, labels, selected values, and campaign summaries never contain a CRM link. Only the `no_eligible_opportunity` empty state may show one generic “前往商机列表” command to `/m0-detail?view=opportunities`; `no_legal_assignment` shows “联系组织管理员配置团队成员”, not a link to a nonexistent team-admin screen. Browser tests prove the generic command is absent from every record-bearing state.

Two browser journeys are mandatory. The administrator creates a campaign template, edits the exact lifecycle trigger/closed graph, publishes it, observes the checksum, induces one safe failed-validation fixture, repairs/publishes a new version, reconciles it from the workspace, and follows original trigger event plus replacement lineage to completion. The normal user then creates a campaign at lead from permission-filtered options; creates/attaches demand; saves proposal first; generates byte-replayable PPT from that persisted linked proposal; attaches shortlist and guarded collaboration `order/execution/publication/settlement` aliases; creates a campaign AI conversation; searches, uploads/attaches, opens, uses, and cites knowledge entirely through the campaign panel; advances through every guarded state; records the post-settlement review plus paired `knowledge/review` evidence; observes the published template auto-dispatch; opens the filtered workflow trace; reopens `/campaigns?campaign=:id`; and verifies the full trace without direct DB/API intervention. Production acceptance runs both role-specific journeys rather than relying on a pre-published fixture alone.

### Testable Interface States / 可测试界面状态

- First run: no campaigns shows one primary “新建活动” command, not an empty table.
- No eligible opportunity: creation is disabled with `/m0-detail?view=opportunities`; no legal team/owner pair shows the organization-admin contact state; no guessed values.
- No search result: query is preserved with a clear-search command.
- Loading: fixed-height skeleton/status areas use `aria-busy`; controls do not shift.
- Network failure: inline error and retry retain current selection and form values.
- `403`: “你没有该活动权限” and return to campaign list.
- `404`: “活动不存在或不可见” and return to campaign list.
- Stale transition: refresh current state, preserve reason, and require explicit retry.
- Workflow repair: show immutable failed evidence, repaired-template selector, expected-version conflict, already-reconciled link, and replacement trace without duplicate action.
- Restricted link: show a redacted relation row/count with no sensitive metadata.
- Missing link: show “原记录不可用” in the historical trace.

The page uses Phase 3 tokens and components, full-width unframed sections, no nested cards, stable control dimensions, keyboard focus management, and responsive behavior at desktop, `390x844`, and `320px`. Tables scroll internally; sticky headers and controls do not overlap.

Static delivery is part of the same feature, not an implicit deploy assumption. `platform/server/services/public_assets_service.js` explicitly allows exactly `client/features/campaign_context.js`, `client/features/campaign_workspace.js`, `client/features/campaign_ppt_bridge.js`, `client/core/csp_compat.js`, and `client/features/ppt_preview_runtime.js`. `platform/index.html` preserves and tests the exact dependency order `client/shared/build_info.js`, `client/core/navigation.js`, `client/core/accessibility.js`, `client/core/shell.js`, `app.js`, frozen `ppt.js`, `client/core/csp_compat.js`, `client/features/campaign_context.js`, `client/features/campaign_workspace.js`, then `client/features/campaign_ppt_bridge.js`; all new Phase 4 assets use query `20260714v050campaignbusinessspine`, while popup previews load only the external preview runtime. `platform/nginx/turingmarket.conf` serves those exact allowlisted files with the existing static policy and routes `/campaigns` plus `/campaigns/` to the SPA entry without exposing arbitrary `/client` files. `platform/deploy_v8.ps1`, the release manifest, static boundary tests, and source-contract tests include all five scripts, new app/index hashes, SPA path, build `20260714-v050-campaign-business-spine`, and frozen PPT build/hash. Direct GET/HEAD for each asset and `/campaigns` must succeed in local candidate and production; unknown sibling assets remain `404`.

Phase 4 also owns the Phase 3 deferred workflow accessibility work. The legacy workflow designer gains keyboard connection authoring using the existing selected-node model: focus source node, invoke “连接节点”, move through valid destination nodes with arrow keys, confirm with Enter/Space, cancel with Escape, and expose source/destination/validation through accessible names and a polite live region. Mouse behavior remains unchanged. Release gates cover keyboard-only create/delete/repair of a connection, focus restoration, shared dialogs, `200%` and `400%` reflow, forced colors, reduced motion, automated accessibility-tree/axe checks, and an NVDA screen-reader pass on the supported Windows browser. Missing assistive-technology evidence blocks Phase 4 release rather than being recorded as passed.

## Production-Shaped Migration Gate / 类生产迁移门禁

Before staging, root creates and fsyncs a `0600` durable gate-run journal containing a random run ID, source/compact/output/temp/log paths, planned ephemeral UID, namespace/mount identifiers, child process IDs, and monotonic cleanup phase; it contains no values from the database. Startup and a root-owned boot cleanup unit first reconcile every stale journal by killing recorded/cgroup processes, unmounting recorded mounts, deleting all recorded paths, removing the UID, and proving absence before a new run. The production operator then uses root to create a SQLite Backup API copy in a root-owned `0700` staging directory and runs a small versioned pre-scrubber before any ownership transfer. The pre-scrubber replaces password hashes, session tokens, API/provider tokens, invite codes, and other credential-bearing columns with inert non-production replacement sentinels, expires sessions, verifies classified column/count coverage, and never logs values.

Logical replacement alone is insufficient. Root checkpoints/closes the scrub copy, switches the private scratch connection out of WAL, and materializes its scrubbed logical state into a new compact database using `VACUUM INTO`. It closes/fsyncs the compact file and parent, rejects any `-wal`, `-shm`, or `-journal` sidecar, deletes the pre-compact database plus sidecars, and raw-scans every remaining staged byte for the disjoint forbidden-source set: seeded source-leak probes, actual original credential encodings/hashes, and configured secret fingerprints, without printing matches. The generated replacement-sentinel set is never part of that forbidden scan; instead logical assertions require each sentinel only in its manifest-classified non-null credential column and require no source probe there. Only the newly compacted clean file is mounted read-only into a new ephemeral UID's private mount namespace; a separate writable output directory is owned by that UID. Sanitization and migration verification run with an empty allowlisted environment, no network namespace routes/interfaces, no production mounts, no live-path access, and no reusable account. The gate user can see remaining production-shaped business data only inside this isolated run, never live credentials or provider secrets.

An exhaustive versioned classification manifest lists every discovered table and column as one of: structural preserve, deterministic synthetic text, bucketized numeric, secret-null, inert secret-synthetic, recursive JSON, or derived-drop/rebuild. `secret-null` is legal only when preflight proves every source row in that column is already null and output preserves that all-null pattern. Any credential/token column containing a non-null value must use `inert secret-synthetic`; its replacement is non-production while preserving source nullness row by row, so null rows remain null and non-null rows receive sentinels. Synthetic password hashes and session tokens are generated inside the isolated run; sessions are also made expired. Unknown tables, columns, virtual-table shadows, JSON paths, classification values, or a nullness-class mismatch fail closed. Recursive JSON sanitizes all string leaves and classified numerics while preserving only approved structural keys/enums. FTS5 and other derived indexes are never copied: they are rebuilt from sanitized base rows, row-count/topology checked, and scanned independently.

The sanitizer preserves row counts, primary/foreign-key IDs, relationship topology, null patterns, approved equality partitions/cardinality for role/department/status, and row volume. It replaces user text, contacts, credential/session/token fields, URLs, prompts, proposals, knowledge, file metadata, and nested content; sensitive numerics are bucketized. Inside the isolated namespace a source-to-output leak comparator checks normalized source strings, hashes, known encodings, nested JSON leaves, FTS rows, and raw compact/output bytes without printing matches. Any overlap above approved enum/structural allowlists aborts and destroys the output. A root-owned success/failure/timeout/signal trap first kills every recorded process, unmounts recorded mounts, deletes source/compact/output/temp/log staging paths, removes the UID, verifies by path/UID/mount/process search that nothing remains, records cleanup completion, then atomically removes the journal. Because traps cannot handle `SIGKILL` or host loss, the durable startup/boot reconciler is authoritative. Forced `SIGKILL` before and after mount plus simulated reboot must leave a stale journal that the next boot/startup cleanup fully resolves before any new source is copied. Cleanup failure is a blocking incident and no artifact is copied to the repository.

Topology, ordinary data, and FTS use one complete binary grammar. `U16`, `U64`, and `I64` are unsigned/signed big-endian integers; lengths/counts are `U64`. `ITEM(label,payload)=U16(byteLength(label)) || UTF8(label) || U64(byteLength(payload)) || payload`. Labels are non-empty lowercase ASCII from the frozen implementation registry. `LIST(records)=U64(count) || record...`, where each `record=U64(byteLength(body)) || body`; `ROW(values...)=record(U64(valueCount) || value...)`. A SQLite value is exactly `N`; `I || I64`; `R || IEEE754-binary64-big-endian`; `T || U64(length) || exact-well-formed-UTF8`; or `B || U64(length) || exact-bytes`. Every SQLite integer is read as a signed 64-bit `BigInt`, not a JavaScript number. Real values preserve signed zero and reject non-finite values. Text must equal its blob/text round trip. Stored table rows use `ROW` values in ascending `table_xinfo.cid`; encoded row records sort lexicographically as bytes and duplicates remain repeated.

`tm-sqlite-topology-v1` hashes this exact concatenation:

```text
ITEM("format", UTF8("tm-sqlite-topology-v1"))
ITEM("pragmas", LIST([
  ROW(T("application_id"), I(value)), ROW(T("encoding"), T(uppercaseValue)),
  ROW(T("page_size"), I(value)), ROW(T("user_version"), I(value))
]))
ITEM("objects", LIST(OBJECT...))
```

Objects sort by UTF-8 `(type,name,tbl_name)` and each `OBJECT` is `ITEM("object", ROW(T(type),T(name),T(tbl_name),N|T(exactSql)) || ITEM("table_list",LIST(...)) || ITEM("table_xinfo",LIST(...)) || ITEM("foreign_key_list",LIST(...)) || ITEM("index_list",LIST(...)))`. Non-applicable lists are present with count zero. `table_list` rows encode exact `schema,name,type,ncol,wr,strict`; `table_xinfo` rows encode `cid,name,declared_type,notnull,default_sql,pk,hidden`; `foreign_key_list` rows encode `id,seq,table,from,to,on_update,on_delete,match`; each `index_list` row encodes `seq,name,unique,origin,partial` followed by its UTF-8-`(seqno,cid,name)`-sorted `index_xinfo` rows `seqno,cid,name,desc,coll,key`. `sqlite_schema.rootpage` and physical page/free-list state are deliberately excluded. Exact view/trigger/index SQL, virtual-table declarations, explicit `sqlite_sequence`, and the manifest-declared FTS shadow-name list are included; engine-generated shadow objects themselves are excluded. Unknown object/table/index/virtual/shadow metadata fails closed. The topology digest is SHA-256 of the complete stream.

`tm-sqlite-logical-v1` hashes `ITEM("format",UTF8("tm-sqlite-logical-v1")) || ITEM("topology_sha256",raw32) || ITEM("tables",LIST(TABLE...)) || ITEM("fts",LIST(FTS_SUMMARY...))`. Ordinary tables, including `sqlite_sequence`, sort by UTF-8 name. Each `TABLE` is `ITEM("table",ROW(T(tableName)) || ITEM("column_cids",LIST(ROW(I(cid))...)) || ITEM("rows",LIST(sortedEncodedRows)))`; the table's row count is the list count. This includes every non-hidden stored value and every duplicate without relying on rowid, query plan, collation, insertion, page, or VACUUM order. Any schema/type/value/duplicate/sequence/fixed-pragma change alters topology and/or full logical digest.

FTS policy is explicit. The manifest names each virtual FTS table, durable projection query, ordered semantic-key/stored/indexed columns, tokenizer/options, and every discovered shadow table; unknown virtual/shadow objects fail closed. Shadow schema/data is excluded from ordinary data and never copied. After deterministic rebuild, each table's `tm-fts-logical-v1` stream is `ITEM("format",UTF8("tm-fts-logical-v1")) || ITEM("manifest",ROW(T(virtualName),T(projectionName),T(tokenizerOptions),T(keyColumnCsv),T(indexedColumnCsv))) || ITEM("rows",LIST(sortedSemanticRows))`. A semantic row uses the common row grammar over semantic keys followed by every stored/indexed projection value and never includes allocator-owned FTS rowid.

`knowledge_chunks_fts` uses exact projection `knowledge_chunks c JOIN knowledge_entries e ON e.id=c.entry_id`, ordered by safe integer `c.id`: indexed `title=e.title`, `content=c.content`, and `tags=<parsed unique UTF-8-sorted e.tags_json values joined by one U+0020>`; unindexed stored columns are `entry_id=e.id` and `chunk_id=c.id`. Malformed tags, orphan chunks, duplicate chunk IDs, unsafe IDs, or row-count mismatch fails. Rebuild runs one transaction that deletes every FTS row, inserts this exact projection in `c.id` order, executes FTS5 `integrity-check`, compares the independent projection row-for-row to the virtual table, and commits only on equality. The sanitized populated gate deterministically places two unique tokenizer-safe canary terms into two existing sanitized chunks and proves exact `MATCH` row-ID sets before and after rebuild; a wrong title/content/tag join, stale posting, missing posting, or swapped entry/chunk ID fails. `FTS_SUMMARY` in the full digest is `ROW(T(virtualName),I(rowCount),B(rawFtsSha256))`, sorted by virtual name.

The framing implementation ships immutable primitive golden vectors before any database fixture is trusted: `ITEM("x",00ff)` is hex `000178000000000000000200ff` and SHA-256 `21c844be7352193e5feac7b34608234edfa4c09814657209c1fb1863d9b37a26`; the framed row `[N,I(42),R(-0),T("A"),B(00ff)]` is hex `000000000000003000000000000000054e49000000000000002a5280000000000000005400000000000000014142000000000000000200ff` and SHA-256 `3af5ba80537e12943b9437d1522acb3e76b6915f3c7011c1cf2f78deba7a58c9`; the complete FTS stream with manifest `demo_fts,demo,unicode61,id,content` and one semantic row `(I(7),T("hello"))` hashes to `7d03905606fb63de02a7b3f07928268710e45c9a79b41f588e51b0455cccfbfe`; and the topology format item alone hashes to `4a6620acacecfc9d9647e099a75d3b84560eb809a3f8c8abda02e506c2f7c57c`. A committed synthetic SQLite fixture additionally freezes complete topology/logical/FTS hashes and is generated independently by the test builder; any implementation whose primitive or full-fixture vector differs cannot run the populated gate.

Before any migration transaction, the gate runs a read-only legacy consistency preflight with `foreign_keys=ON`, `integrity_check`, `foreign_key_check`, and explicit orphan queries for every declared relationship, including `opportunities.customer_id -> customers.id`. Any orphan/invalid parent fails before ledger/schema mutation and emits only table/constraint/count identifiers; Phase 4 performs no speculative repair. The operator repairs the v0.4 source through an audited business action or approved one-off reconciliation, takes a new backup, and reruns the gate. The gate then records file checksum, topology digest, and this full logical digest; migrates once; verifies exact legacy IDs/counts/topology/null/cardinality and deterministic backfill; runs `integrity_check`/`foreign_key_check`; and records post-migration digests. A second migration must leave schema and every value equal. Golden sensitivity tests independently mutate null/integer/real/text/blob values, duplicate row count, schema SQL, column metadata, `sqlite_sequence`, each fixed pragma, and FTS content and require the appropriate digest to change; row reorder/VACUUM and identical FTS rebuild must not. Campaign/link/event/idempotency/workflow sentinels then run. Finally the pre-migration sanitized backup is restored into a clean file and must reproduce both original digests. Small synthetic fixtures remain unit tests but do not replace this gate.

## Deployment And Rollback / 部署与回滚

The active deployment owner is `platform/deploy_v8.ps1`; operator documentation is `platform/DEPLOY.md`. Phase 4 modifies those files and explicitly retires/deletes the unreferenced root `platform/migrate.js` so there is one migration entrypoint. It also retires the direct runtime/database restoration functions in `platform/server/scripts/bootstrap_production_runtime.sh` after the external-layout marker exists: bootstrap becomes setup-only, acquires the same lifecycle/global-writer locks, and delegates any Phase 4 recovery to the resumable `deploy_v8.ps1` rollback state machine. Deployment fails closed before mutation if a bootstrap journal, bootstrap lock owner/process, or unresolved bootstrap staging path exists. No alternate script may restore a Phase 4 database, environment, or runtime tree. Candidate code and the populated sanitized gate complete before cutover. The operational sequence is fixed:

1. Under the existing lifecycle and global-writer locks, install and verify the persistent host-firewall rule that rejects every non-loopback destination to port `3002`; candidate and rollback PM2 environments both set exact `SERVER_HOST=127.0.0.1`. Render `/etc/nginx/sites-available/turingmarket-maintenance` so every public `/api/*` request, regardless of method or authentication, returns `503` plus `Retry-After` except exact `/api/health`; static requests receive the maintenance shell and no candidate application data. Validate with `nginx -t`, switch the enabled symlink atomically, reload, then prove authenticated/unauthenticated GET/HEAD/OPTIONS and mutation probes are blocked while health remains `200` within `-MaintenanceTimeoutSeconds`. Before every candidate or rollback service start, `ss` must show no non-loopback listener for `3002`, a host non-loopback connection probe must be refused, and the firewall rule must match its release checksum. A prior accepted marker remains untouched while maintenance is established and backup is taken.
2. Stop `pm2` application `turingmarket`; prove both PM2 status is stopped/absent and no listener owns port `3002`. A maintenance helper opens the WAL database, runs `PRAGMA wal_checkpoint(TRUNCATE)`, proves no busy frames, executes/releases `BEGIN EXCLUSIVE`, creates the SQLite Backup API copy, closes every handle, and removes/rejects stale candidate `-journal`, `-wal`, and `-shm` sidecars with parent-directory fsync. While the same write quiescence remains, snapshot the private `PPT_CACHE_DIR` to a sibling backup tree. The database and cache receive SHA-256 manifests; every completed binary ledger row must have one matching size/hash file, every backed-up file must be referenced or explicitly classified as a janitor orphan, and both manifests share one backup ID. The exclusive-lock proof plus the all-API public gate is the quiescence evidence before any code/database/cache mutation. The backup root is exact `/root/turingmarket/release-backups/<backup-id>`: every component is root-owned, non-symlink, `0700`; manifests/database/code/Nginx files are regular single-link `0600`; cache directories are `0700` and cache files regular single-link `0600`. Creation uses already-open directory descriptors plus no-follow/exclusive primitives, refuses hard links, devices, sockets, FIFOs, ownership/mode drift, mount crossing, or any source/destination path outside declared roots, and fsyncs each file and parent before the manifest is accepted. After the accepted marker and its digest are included in that backup, an existing `/etc/nginx/turingmarket-release/accepted.json` is atomically renamed no-replace on the same filesystem to root-owned `/etc/nginx/turingmarket-release/history/<prior-release-id>.json`, both directories are fsynced, and phase `prior_marker_archived` is journaled; first install records an explicit null prior marker. No candidate mutation begins before this step. A pre-accept rollback preloads the restored normal marker-gated site and atomically renames that exact verified historical marker back to `accepted.json` as its final public-enable commit.
3. Atomically exchange the validated candidate, run the migration service before listen, and restart with exact `SERVER_HOST=127.0.0.1` on the private application port while every public API remains blocked. Post-start proof requires `ss` to show only `127.0.0.1:3002` (and no wildcard/host-interface listener), the host non-loopback refusal probe to remain closed, and direct loopback health to pass. A root-controlled, empty-environment, loopback-only verifier connects directly to `127.0.0.1:3002`, uses protected release-test credentials without logging them, and completes health, schema ledger, FK/integrity, session policy, the administrator template/publish/reconciliation journey, and the full normal-user authenticated write journey. Its dedicated internal `[RELEASE-SMOKE]` campaign/evidence is explicitly labelled and cancelled at the end; one final completed idempotent mutation status/body/deterministic-header projection and key are retained.
4. Still under public API maintenance, root launches the checked-in `platform/server/scripts/release_replay_gate.js` as a one-request helper. Its non-symlink parent directory is exact mode/owner `0710 root:www-data`; the Unix socket is `0660 root:www-data`, allowing only Nginx workers and root to connect; root-only header and claim files remain regular single-link `0600`. Nginx accepts only source `127.0.0.1`, the retained method/path, and the random probe header read from the root-only file, then proxies only that request to the helper; every other public API read/write remains `503`.

Before forwarding to Express, the helper verifies method/path/header again and performs an exact Node-implementable single-use CAS. Root stages `probe.pending` with its checksum and fsyncs file/parent. The helper exclusively creates `probe.claimed` in the same already-open no-follow directory using `fs.open` flags `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW` and mode `0600`; it writes the pending checksum plus nonce, fsyncs and closes the claim, unlinks `probe.pending`, then fsyncs the parent. Existence of `probe.claimed` is authoritative: a crash after exclusive creation fails closed, restart never recreates pending, and all concurrent losers receive no Express access. Rename-with-replacement or precheck-then-write is forbidden. The root verifier calls the production HTTPS origin with host/TLS routing through local Nginx. The replay comparator requires exact status, body bytes, and only deterministic headers `Content-Type`, `Cache-Control`, `ETag`, and `Content-Disposition` when present; it explicitly excludes fresh `X-Request-Id` and transport-generated `Date`, `Server`, `Connection`, `Transfer-Encoding`, and framing headers. The probe must create no event/link/write. Before public enable, root stops the helper, removes the Nginx replay include, socket, header file, and both marker names, fsyncs their parents, reloads the normal marker-gated site, and proves the bypass path is unusable. Crash/concurrency tests at every preclaim/postclaim/forward/response/removal point prove at-most-one preaccept replay and that Nginx can connect without reading root-only claim/header files.
5. After loopback journeys, blocked-public probes, public-origin replay, health/static checks, and bypass removal all pass, load the normal Nginx site while its return-only API gate still checks absence of `/etc/nginx/turingmarket-release/accepted.json` and returns `503`. The parent is a root-owned non-symlink `0755` directory; Nginx can stat but cannot write it. The sole irreversible commit is an atomic no-replace rename of a root-owned regular single-link `0644` candidate marker from that same directory to the exact path followed by parent-directory fsync. The marker contains the release/backup IDs and code/database/cache/Nginx manifest digests, no secret, and is the same file-existence predicate Nginx evaluates on every public API request; there is no second enable flag or symlink action. Thus the marker's appearance and public API enable boundary are one filesystem commit: before it, every API remains maintenance and automatic rollback is allowed; after it, requests may reach the candidate and automatic destructive rollback is permanently refused. A crash before rename rolls back; a crash after rename retains the accepted candidate. Post-accept monitoring failure switches/reloads the separate all-API maintenance site without deleting or replacing the accepted marker, preserves current code/database/PPT cache unchanged, retains both locks and incident evidence, and permits only repaired roll-forward. Destructive restoration after acceptance is never automatic, even when no write is observed; it requires the explicit manual `-ConfirmDataLoss` path and an operator reconciliation decision.

Pre-enable automatic rollback and explicitly confirmed manual rollback use one resumable state machine, never an ad hoc command. A root-only `0600` atomic JSON journal at `/root/turingmarket/.deploy-v030.lock/rollback-state.json` records schema version, backup IDs/checksums, candidate/live digests, prior/current accepted-marker state, and these monotonic phases: `maintenance_entered`, `process_stopped`, `prior_marker_archived`, `overlay_captured`, `code_tree_restored`, `nginx_candidate_staged`, `database_restored`, `ppt_cache_restored`, `overlay_applied`, `sessions_cleared`, `service_started`, `verified`, `overlay_destroyed`, `accepted_public_enabled`. Automatic entry is rejected whenever current `accepted.json` exists; a pre-accept candidate has an absent current marker plus a checksum-bound historical marker or explicit first-install null recorded by `prior_marker_archived`. `nginx_candidate_staged` verifies and loads the normal syntax/checksums but the marker-absence gate still leaves every API in maintenance; `accepted_public_enabled` is true only when the exact current or restored-prior marker exists with matching release/manifests and every earlier phase, including credential-overlay destruction, is durable. Marker existence is authoritative if a crash occurs before the journal can mirror that final phase. Service start exports `SERVER_HOST=127.0.0.1` and is impossible until all code/database/cache/overlay/session/firewall phases are durable. Every rerun validates backup/journal/manifests and resumes the first incomplete phase; an unreadable/mismatched journal fails closed with maintenance and locks retained. Interruption tests stop before and after every phase/marker fsync and must never expose an unverified API, bind port `3002` beyond loopback, or retain an unjournaled credential overlay.

Before destructive database restore, the stopped new database is read into a root-only `0600` atomic overlay file with exact JSON shape `{ "version": 1, "captured_at": "...", "source_database_sha256": "...", "source_logical_digest": "...", "users": [{ "id": 1, "username": "...", "password_hash": "...", "is_active": 1, "role": "admin", "department": "Global sales", "api_quota": 200000 }] }`. Users sort by integer ID; file contents and hashes are never logged. Preflight compares user count and every exact `(id,username)` pair with the target backup and aborts before restore on any addition, deletion, or mismatch. After backup checksum/full-digest verification, all database handles are closed; destination `-journal`, `-wal`, and `-shm` sidecars are removed and their parent is fsynced; the main file is atomically replaced and file plus parent directory are fsynced. A hot-journal fixture must not replay stale pages after open. The cache tree is restored atomically from the same backup ID and reconciled against completed ledger metadata before restart. One transaction reapplies only those six mutable security fields to exact ID+username matches, asserts affected/full counts, deletes every `sessions` row, and verifies zero remain. For a Phase-4 target, role/department/active fields are then deterministically reconciled to membership status in that same transaction; for the pre-Phase-4 rollback target, exact legacy department is the authorization source. The restored database must pass checksum provenance, logical-topology expectations, `integrity_check`, empty `foreign_key_check`, all-sidecar absence, and DB/cache reference parity. After old-code health and authenticated credential/revocation checks succeed, the overlay is overwritten where supported, unlinked, its parent directory fsynced, absence verified, and only then is `overlay_destroyed` journaled; maintenance remains enabled until that phase is durable.

Pre-enable automatic cutover recovery always performs the checksum-bound code, Nginx, database, and PPT-cache restore path above; code-only rollback onto a migrated writable database is forbidden. After the accepted marker, the deploy script refuses automatic rollback and leaves maintenance/locks intact. Manual syntax is `deploy_v8.ps1 -RollbackBackup <release-backup> -RestoreDatabase -ConfirmDataLoss [-MaintenanceTimeoutSeconds 60]`. `-RestoreDatabase` requires `-ConfirmDataLoss`; Phase 4 backup rollback rejects omission of database/cache restoration, and any combination with `-PreserveSessions` is rejected. A later manual rollback therefore explicitly accepts loss/reconciliation of post-backup business writes while still carrying forward exact matching-user security state and invalidating every session. There are no destructive down-migrations. Maintenance remains active and both locks remain incident markers on any uncertain recovery.

Release-backup retention is deterministic and may be lengthened but not shortened by configuration: retain every backup for at least 30 days and retain at least the newest ten accepted-release backups, whichever keeps more. Never automatically delete the backup named by the current accepted marker, any live rollback/incident journal, an unresolved deployment, or the last verified successful production release. A backup is eligible only after a fresh manifest/mode/owner/no-link validation and an atomic root-owned rename to `<backup-id>.deleting-<nonce>` under the same parent, followed by parent fsync; this makes it unreachable to new restore commands. Cleanup walks only already-open no-follow directory descriptors, refuses mount/owner/link drift, unlinks regular single-link files, fsyncs each directory bottom-up, removes the tree, fsyncs the parent, and appends only backup ID, manifest digests, eligibility reason, actor, and timestamp to the deployment audit log. Failure leaves the renamed tree and an incident record for resumable cleanup. The process never claims secure media erasure and never follows a path supplied from a manifest.

## Verification / 验证

1. Migration: exact empty/legacy/managed/malformed/future classification, two independent frozen seed admissions, JavaScript-safe legacy preflight, schema convergence, immutable checksums, visibility/digest/reference backfill, collision failure, FTS5 integrity plus MATCH canaries, rerun, FK/integrity, sanitizer, DB/PPT-cache restore, WAL safety, and session invalidation.
2. Authorization: active/revoked membership, identity transitions, platform/org/team boundaries, two-stage campaign-create and replay authorization, auth-before-parser for all owned JSON/multipart routes, filtered counts/search, campaign-aware knowledge visibility projection without stored legacy-token rewrites, safe source projection, fail-closed AI audit, single-campaign conversations, EventSummary cross-campaign redaction, CRM generic-empty-state-only navigation, shared influencer export, workflow children, and separate CRM/workflow-template delete guards.
3. Idempotency/concurrency: successful 0/1/2 versus error-zero event cardinality, immutable operation deadline versus terminal retention, exact replay after authorization, failed reclaim/deadline terminalization/binary expiry, quotas, bundle inheritance, move race, future workflow leases, and one dispatch/instance per event-template.
4. Lifecycle/workflow: forced lead creation, live collaboration-backed relation guards, hold/resume/campaign-cancel cascade, linked collaboration cancel/revocation, transfer/correction events, four idempotent template mutations, canonical snapshot golden vector, deterministic single-edge selection, unexpired-token fencing, atomic human continuation, reciprocal dispatch-instance lineage, failed-validation reconciliation/read-options contract, failed initialization/retry/startup drain, customer-stage auto-start regression.
5. Integration: exact optional writes, required producer archives, deterministic RAG capped at exactly 48 chunks and 98,304 UTF-8 bytes with per-chunk snapshots, distinct usage/citation accounting, linked mandatory-LLM/optional-web abort behavior, knowledge growth caps, proposal-version PPT single-flight, async cleanup, auth-generation fencing, complete normal-user chain, and frozen PPT bytes/hash.
6. Browser/visual/accessibility: delivered workspace/assets, context failure rollback, create/attach, deep links, all interface states, full keyboard workflow connection authoring, NVDA/accessibility tree, focus/dialog/reflow/forced-colors/reduced-motion, desktop/390/320, combined reference-versus-implementation comparison, runtime clean.
7. Release: full Node and browser suites, baseline/product-shell regression, static/deploy contracts, loopback-only bind plus persistent firewall refusal, pre-enable automatic rollback, post-enable fail-closed roll-forward boundary, remote candidate, authenticated production workspace, logout/revocation, zero leaked sessions.

## Non-Goals / 非目标

Phase 4 does not add configurable RBAC/tenant entitlements, rewrite CRM stages, redesign AI prompts/retrieval ranking meaning/provider selection, add a vector database, add dedicated PPT/shortlist/order/execution/publication/settlement/review ledgers, automate collaboration status into lifecycle state, implement payments, migrate frontend frameworks, or change frozen PPT renderer bytes. It may enforce deterministic chunk/reference custody, abort/deadline propagation, linked-provider failure semantics, and atomic archives required by this business spine.

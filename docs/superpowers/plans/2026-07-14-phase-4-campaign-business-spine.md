# Phase 4 Campaign Business Spine Implementation Plan / 第 4 阶段活动业务主链实施计划

> Execute in the approved role order: Codebase Onboarding Engineer -> Minimal Change Engineer -> Senior Developer -> Code Reviewer -> Git Workflow Master. Because this phase touches CRM, data, workflow, and the project UI, Backend Architect, Frontend Developer, Product Manager, Data Engineer, and Workflow Architect are required review gates.

**Goal / 目标:** Deliver, review, deploy, and verify `v0.5.0-campaign-business-spine` without regressing the current CRM, AI/knowledge, influencer, workflow, admin, or frozen PPT behavior.

**Design source / 设计依据:** `docs/superpowers/specs/2026-07-14-phase-4-campaign-business-spine-design.md`

**Branch / 分支:** `codex/v0.5.0-campaign-business-spine`

**Build identifiers / 构建标识:** server/app build `20260714-v050-campaign-business-spine`; static query `20260714v050campaignbusinessspine`.

## Non-Negotiable Delivery Rules / 不可变交付规则

1. Use test-first changes: add one focused failing contract, verify the expected failure, implement the smallest coherent slice, then rerun focused and full suites.
2. Keep all Phase 4 schema changes in versioned migrations. Never reintroduce swallowed `ALTER TABLE` errors.
3. Preserve omitted-`campaign_id` response behavior and the frozen PPT bridge/query/hash, except the approved global security controls: collaboration object authorization/internal versioning, immutable campaign-provenance knowledge access, shared upload sandbox, and scoped/unscoped PPT admission.
4. Enforce authorization in backend services and collection queries, not only in UI visibility.
5. Do not use direct production data in candidate tests. Use the populated, shape-preserving offline sanitized copy.
6. Do not start the old binary on a migrated writable database during rollback.
7. Every code checkpoint receives independent review before deployment; every production deployment receives authenticated online proof.
8. Version completion requires repository `CHANGELOG.md`, version record, Obsidian archive, Git commit/push, production backup, and online acceptance evidence.

## Task 1: Freeze Contracts And Review Gate / 锁定契约并完成审查

**Files**

- Modify: `docs/superpowers/specs/2026-07-14-phase-4-campaign-business-spine-design.md`
- Modify: `docs/superpowers/plans/2026-07-14-phase-4-campaign-business-spine.md`
- Create: `docs/api/campaign-business-spine.md`
- Modify: `CLAUDE_CODE_MIGRATION.md`

**Steps**

1. Record exact ledger DDL, nine-table ownership, FK/delete matrix, safe-integer IDs, polymorphic orphan policy, request/response schemas, deterministic concealment, collaboration status/cost confirmation, route authorization matrix, workflow initialization/reciprocal lineage/reconciliation read contract, UX states, populated sanitizer guarantees, loopback bind, and pre-enable-only automatic database restoration.
2. Run UTF-8, placeholder, secret/private-host, mojibake, and `git diff --check` checks.
3. Request independent reviews from Backend Architect, Data Engineer, Workflow Architect, AI Engineer, Product Manager, and Security Reviewer.
4. Resolve every P1/high finding. Do not write product code until all six return `APPROVE`.
5. Commit the approved design checkpoint.

**Acceptance / 验收:** Six independent `APPROVE` verdicts; no unresolved high/P1; no credential values in docs; only intended documentation changes committed.

## Task 2: Migration Runner RED-GREEN / 迁移执行器红绿测试

**Files**

- Create: `platform/server/services/migration_service.js`
- Create: `platform/server/migrations/engines/v1.js`
- Create: `platform/server/migrations/baselines/legacy_v1.js`
- Create: `platform/server/migrations/001_legacy_compat_columns.js`
- Create: `platform/server/services/sqlite_digest_service.js`
- Create: `platform/server/tests/migration_service.test.js`
- Create: `platform/server/tests/sqlite_digest_service.test.js`
- Create: `platform/server/tests/fixtures/digest_v1_fixture.js`
- Create: `platform/server/tests/fixtures/canonical_hash_vectors.js`
- Modify: `platform/server/db.js`
- Delete: `platform/migrate.js` after proving no runtime/deploy reference remains

**RED tests**

1. Pre-write classification is exact `empty|legacy|managed|partial_or_malformed|future`. Empty database executes baseline, ledger creation, `001`, both frozen seed admissions, and a test-only registered later-migration probe in one outer transaction; legacy/managed upgrades first complete classification-specific read-only identity/digest/orphan preflight, then revalidate under `BEGIN EXCLUSIVE`. Managed known prefixes resume or no-op without pristine-legacy comparison; malformed/partial/future fail before write. Task 2 does not import or anticipate product migration `002`.
2. Populated legacy database receives missing compatibility columns/indexes with no changed legacy IDs/values; `collaborations.row_version` deterministically backfills to integer `1`, `cost_actual_confirmed` to integer `0`, rejects invalid typed/safe-integer/version/flag values on the non-STRICT table, and every later legacy or linked update increments the internal version without exposing it in the legacy serializer.
3. Re-running produces no schema/data change.
4. Changed migration source, immutable `engines/v1.js`, immutable legacy baseline, or declared dependency bytes abort startup; later edits to mutable `migration_service.js`, `db.js`, or a new engine do not alter an already applied v1 checksum. Exact `tm-migration-checksum-v1` U64 framing matches `2298da2cb6311ed6abf5afeb7463c31455a8a787cd5573cae558829540efc515` on Windows and Linux.
5. Unknown future ledger version, malformed ledger row, injected migration failure, and duplicate version/name fail closed before listen.
6. No ledger/schema mutation occurs before populated read-only preflight; every ledger row is absent after rollback and present only inside the same committed outer migration transaction.
7. Every connection has `PRAGMA foreign_keys=1`; read-only legacy orphan/FK preflight and exhaustive JavaScript-safe PK/FK/version/sequence checks fail before mutation; `integrity_check` is `ok`; `foreign_key_check` is empty.
8. Shared immutable golden fixtures lock all framing primitives plus the design's exact `tm-request-v1` JSON/empty/multipart hashes and `tm-audit-v2` nonce-bound hash before later idempotency code may consume them.
9. The reusable SQLite topology/logical/FTS digest service passes primitive and independently built full-fixture vectors, uses the exact cross-table knowledge-chunk projection, changes for every declared schema/value/type/duplicate/sequence/pragma/FTS mutation, and remains stable across row reorder, VACUUM, and equivalent FTS rebuild. FTS5 integrity and deterministic MATCH canaries detect stale, missing, or swapped postings.
10. The admin seed predicate and independent influencer seed predicate are frozen separately: existing admin means no user/team fixture insertion; no admin attempts only the configured admin plus exact ten fixtures; zero influencers inserts exactly fifteen frozen rows in order; any positive influencer count inserts none. Empty/partial combinations, rollback, managed restart, and rerun preserve these outcomes.

**Implementation**

1. Bootstrap the exact `schema_migrations` DDL only inside the new-database or populated-upgrade outer transaction, never before populated read-only preflight.
2. Keep applied engine semantics in immutable `migrations/engines/v1.js`; hash exactly migration source, that engine, immutable `migrations/baselines/legacy_v1.js`, and ordered declared dependency bytes with the design's repository-path and U64 framing grammar; exclude mutable orchestration and reject undeclared local imports.
3. Apply the complete ordered baseline/ledger/migration/seed/verification sequence under one explicit outer transaction with engine version checks; nested migration functions never commit independently.
4. Replace swallowed compatibility alters with `PRAGMA table_info` and deterministic operations in `001`, including collaboration integer row-version and cost-confirmation columns/backfills.
5. Refactor `db.js` ordering to baseline -> `001` -> exact admin admission -> independent exact influencer admission -> registered later migrations, without changing current seed values/order or interpreting missing individual fixtures as permission to reseed.
6. Remove the obsolete standalone `platform/migrate.js`; the startup migration service becomes the only entrypoint and deployment/source-contract tests reject its reintroduction.
7. Land the versioned SQLite digest service and canonical migration/request/audit golden fixture once here; Tasks 3, 5, and 9 must reuse it byte-for-byte rather than cloning encoders.

**Verification command:** `node --test server/tests/migration_service.test.js server/tests/sqlite_digest_service.test.js` from `platform`.

**Checkpoint:** Task 2 must receive independent migration-runner review and a clean commit before Task 3 creates/registers `002`; Task 3 may consume only the approved runner API. If the runner contract changes during Task 3, return to Task 2 RED tests/review before continuing.

## Task 3: Phase 4 Schema And Backfill RED-GREEN / 主链结构与回填红绿测试

**Files**

- Create: `platform/server/migrations/002_campaign_business_spine.js`
- Create: `platform/server/tests/campaign_migration.test.js`
- Create: `platform/server/tests/fixtures/legacy_populated_fixture.js`
- Create: `platform/server/tests/knowledge_digest_compat.test.js`
- Modify: `platform/server/db.js`
- Modify: `platform/server/services/knowledge_service.js` only for digest-aware compatibility writes

**RED tests**

1. `002` owns exactly the nine documented domain tables and required triggers/indexes.
2. Every FK, `CHECK`, `NOT NULL`, partial unique index, and `ON DELETE/UPDATE` action matches the design.
3. Every new table is `STRICT` with `TEXT` timestamps and every stored ID/version/counter is JavaScript-safe. Database tests reject lossy REAL, non-integral, overflow, and blob values and assert `typeof(column)='integer'` after accepted writes; lossless SQLite affinity conversions such as `"2"` or `3.0` are not incorrectly expected to fail at the database boundary. Legacy workflow/knowledge/reference compatibility columns use `typeof` checks. HTTP canonical-ID validation is owned only by Task 5.
4. All users map to the default organization; its code is database-immutable and its row cannot be deleted. Roles never elevate; whitespace/overlength department mapping is total and deterministic with a human-readable sanitized display name plus a full 64-hex department hash code and display-only 16-hex suffix; a preflight hash collision fails closed. Membership tables are stable current projections; exactly one deterministic nine-key `identity_state_changed` backfill event exists per user, live changes emit one canonical before/after diff, duplicate/missing/wrong-type JSON keys are rejected by database triggers, and all activity rows reject update/delete.
5. Owner must belong to the selected team; opportunity and customer must match; invalid currency/budget/date/state/status are rejected.
6. Events cannot update/delete; the exact event source/reason/metadata matrix accepts only a matching processing ledger bound to the same campaign/scope/fingerprint with unexpired tokenized lease, nonce, and operation deadline. Successful outcomes require the frozen 0/1/2 cardinality; every replayable `4xx|5xx` requires zero events. Cross-campaign correction commits reciprocal byte-identical move metadata, reconciliation metadata binds exact parent/replacement/template/version, and permissive JSON casts cannot pass. Failed/completed/expiring/deadline-expired/lease-less/cross-campaign rows are rejected while later ledger deletion remains safe; correlation IDs reject under/overlength, C0, DEL, and every non-ASCII scalar at the database boundary, while headers/upload filenames reject every forbidden control byte; public/internal link metadata obey closed bounded JSON contracts.
7. `record_id` rejects `0`, `07`, `+7`, decimal, negative, overflow, and unsafe integers.
8. Backfill and migration rerun preserve exact legacy rows and produce an identical full logical digest.
9. Workflow instance compatibility columns are nullable for legacy rows, indexes prevent duplicate non-null dispatch IDs, and every legacy workflow task receives safe `assignment_version=1`; linked-task assignment updates require a pending task, a real field change, a one-step version increment, and a nonempty syntactically valid assignment.
10. Dispatch evidence fields, immutable root `trigger_event_id`, reconciliation lineage, and snapshots cannot change or delete; one failed/completed-corrupt dispatch has at most one replacement; reconciliation insertion independently requires the exact eligible parent failure shape, same organization/campaign/root event, exact event metadata/source/reason, and identical execution context. Completed dispatch and initialized instance reciprocally require matching lineage and ready initialization; every claim/reclaim/heartbeat/finalize requires an exact token plus future lease; legal transitions separately accept live attempt-five failure, expired attempt-five recovery, cancellation, and no sixth claim.
11. Campaign-linked workflow instances accept only `active|paused|completed|cancelled|failed_validation`; insert/update rejects NULL or incoherent initialization fields, ready requires no initialization error, failed-validation requires sanitized execution error code/message/time, and every other status forbids those execution fields.
12. A cancelled collaboration cannot retain active `order|execution|publication|settlement` aliases or satisfy lifecycle guards; publication requires completed order/execution, settlement requires active publication plus completed status and typed `cost_actual_confirmed=1`, and direct SQL cannot clear confirmation for a settled/reviewed campaign with an active settlement bundle. Review requires paired post-settlement knowledge/review evidence.
13. Request-ledger primary/secondary campaign, exact scope/key grammar, random reservation nonce, optional linked-PPT `resource_claim`, immutable operation deadline, request/audit hashes, successful outcome event count, and identity fields are immutable. Legal work-deadline versus terminal-retention transitions include direct-SQL `processing -> completed/json 503` and `failed -> completed/json 503` zero-event cases plus early/non-503/nonzero-event rejections; exact template/PPT/parser-admission null-campaign scopes, binary expiry field preservation, JSON/header/filename caps, admission-only unscoped PPT/parser rows, and active proposal-version single-flight index match the design.
14. Every aggregate link attach stores one immutable random root bundle. Proposal `ppt`, collaboration `execution|publication|settlement`, and review `knowledge|review` aliases added in later requests inherit that root; database triggers reject mixed aggregate/campaign identity and any review entry/link whose campaign or settled-event identity disagrees. Correction by any alias selects the complete bundle, reactivation allocates a new one, and review evidence cannot move across campaigns.
15. Knowledge compatibility preserves exact stored legacy `private|team|public|shared` tokens while campaign-aware code derives `private|team`, adds immutable source/content/chunk digests, a unique immutable `campaign_review,<campaign_id>:<settled_event_id>` source independent of owner/visibility, a unique `(entry_id,chunk_index)` invariant, and version-1 per-chunk AI reference snapshots with exact safe IDs/rank/origin. Legacy visibility/source preflight uses the exact typed `KU32` grammar and both INTEGER/TEXT `source_id` golden digests, preserves existing chunk ID/index/content without rechunking, and fails before mutation on malformed storage, duplicate chunk index, or collision; version-1 snapshots are immutable. A populated fixture carries filename-backed TEXT `source_id` and `public|shared` response canaries and upgrades successfully without changing those legacy response bytes. Once an entry is historically campaign-classified, direct SQL cannot append a chunk, move a chunk into/out of it, mutate a chunk, or delete a chunk; initial atomic archive ordering inserts entry/chunks before the knowledge link. FTS rebuild uses the exact chunk-entry title/content/tags projection, passes FTS5 integrity and deterministic MATCH canaries, and fails on any posting/projection mismatch.
16. With digest-required triggers enabled, existing truly unlinked `ingestKnowledge` create/refresh paths still pass under the current `hashInput` branch: the frozen hash runs on original input before LF/NFC canonical persistence, with CRLF/LF and NFC/NFD selection vectors; stable legacy source type+ID or trusted supplied hash refreshes the same owner/admin-authorized never-classified row and atomically rebuilds content/chunk digests/FTS, while content-derived changed raw hashes create a new row even when canonical content later matches. A new row uses the exact sequence/max `previous_id` query under `BEGIN IMMEDIATE`, validates `0..9007199254740990`, computes `tm-knowledge-legacy-source-v1` from the explicit next ID and final stored values before explicit-ID insert, and advances/rolls back `sqlite_sequence` atomically. Sequence disagreement/exhaustion, concurrent same-source creators, duplicate ID, and injected failure roll back entry/chunks/FTS/sequence. Campaign-owned immutable-source retries remain a separate conflict-on-mismatch path. Integer and filename TEXT `source_id` retain compatibility; accepted `created_by=NULL` legacy entries resolve to the immutable default organization with no user attribution.

**Implementation**

1. Implement the exact schema and FK matrix from the design.
2. Add unique parent indexes required by composite FKs.
3. Add deterministic organization/team/current-membership backfill with human-readable team labels, full department hashes/collision preflight, exact duplicate-safe identity event schema/backfill, append-only activity triggers, and frozen all-or-none seed admission.
4. Add default-organization identity guards plus append-only, mapping, bundle-identity, active-ownership, event-cardinality/provenance, and safe-correction triggers.
5. Add dispatch immutable-evidence, root-event FK, unique reconciliation-lineage plus parent/event eligibility trigger, reciprocal completed-dispatch/ready-instance lineage triggers, legal live-failure/expired fifth-attempt/campaign-cancel transitions, coherence, and no-delete enforcement.
6. Add nullable campaign context, trigger, initialization, and terminal execution-error fields plus linked-instance insert/update state triggers to existing workflow tables; add/backfill task `assignment_version` and the linked pending-task assignment-update guard.
7. Add database compatibility columns/backfills/indexes/triggers for knowledge/chunks/references, including non-mutating legacy visibility validation plus campaign projection, digest/collision/duplicate-index preflight, immutable reference snapshots, unique review source/campaign-event custody, classified-entry chunk insert/move/update/delete guards, settled/reviewed collaboration cost-confirmation preservation, and deterministic FTS rebuild/integrity. In the same checkpoint, make the existing `knowledge_service.js` create/refresh/rebuild path preserve raw-input legacy `hashInput`, canonicalize only after selection, preallocate a sequence-safe explicit entry ID under the write lock, compute source/content/chunk digests before digest-required insertion, and atomically persist entry/chunks/FTS/sequence while preserving never-classified refresh semantics. Migration records creatorless legacy knowledge under the immutable default-organization attribution branch. This is the only Task 3 service change; HTTP validators, campaign custody/quota/RAG semantics, routes, and client behavior remain later-task ownership.

**Verification:** focused migration tests plus `node --test server/tests`.

**Checkpoint:** review and commit the complete `002` schema/backfill plus its minimal digest-aware knowledge write compatibility separately before any authorization or campaign service code. The migration fixture and existing knowledge writes must pass empty, populated, failure-rollback, rerun, affinity, digest, FTS, and trigger-state tests through the approved Task 2 runner.

## Task 4: Organization And Campaign Access / 组织与活动权限

**Files**

- Create: `platform/server/services/organization_access_service.js`
- Create: `platform/server/services/campaign_access_service.js`
- Create: `platform/server/tests/organization_campaign_access.test.js`

**RED tests**

1. Direct service calls prove org admin, owner, and assigned-team member campaign access; missing/cross-org returns concealed `CAMPAIGN_NOT_FOUND`, same-org denied returns `CAMPAIGN_FORBIDDEN`, and read/write/recovery permissions are closed by operational status.
2. Organization resolution repairs only a genuinely missing default membership and never changes legacy role/department or explicitly revoked/deactivated membership. Assignment predicates cover org admin, team lead, ordinary self-owner, transfer, and CRM-manage requirements without trusting client options.
3. Identity projection helpers transactionally synchronize create/promotion/demotion/department transfer/deactivation/reactivation memberships, session invalidation, and canonical audit input while preserving least privilege and rollback.
4. Target access decisions distinguish malformed input, invisible/missing target, visible-but-unmanageable target, immutable campaign custody, revoke-only custody, moved custody, shared shortlist, and historically classified generic-attach rejection without route-specific branching.
5. Collection predicates are reusable before count/rank/page for campaign lists, workflow children, AI conversations/messages, knowledge/dedup/RAG/references/categories, collaboration stats, and unchanged shared influencer-library visibility.
6. Event/link/reference serializers receive explicit authorized target/source/destination states and produce only full, restricted, or missing tagged variants; restricted move summaries expose no campaign/record/link/bundle IDs.
7. A linked AI conversation derives exactly one immutable campaign; a different campaign is rejected. Campaign-aware knowledge visibility projection and safe `{kind,label}` source projection never rewrite or expose legacy raw visibility/source values.
8. Dependency-query helpers enumerate CRM polymorphic target evidence without claiming ownership of the separate workflow-template delete contract.

**Implementation**

1. Centralize `resolveOrganizationScope`, `getCampaignAccess`, and collection-filter SQL helpers.
2. Implement deterministic organization/campaign/target/custody decisions and parameterized collection predicates, but do not mount or modify any HTTP route in Task 4.
3. Keep shared influencer-library visibility unchanged; only campaign shortlist/link visibility uses campaign access.
4. Implement exact key-closed full/restricted/missing serializer inputs and bounded CRM/source projections without route/navigation output.
5. Expose narrow backend APIs consumed later by Task 5 routes, Task 6 workflow, and Task 7 integrations. Client auth binding/generation belongs only to Task 8.

**Verification:** focused direct-service/SQL access tests, existing backend security fixtures, then full Node suite. No HTTP or client file changes are allowed at this checkpoint.

## Task 5: Campaign API, Idempotency, And Lifecycle / 活动 API、幂等与生命周期

**Files**

- Create: `platform/server/contracts/campaign_contract.js`
- Create: `platform/server/middleware/phase4_request_pipeline.js`
- Create: `platform/server/services/idempotency_service.js`
- Create: `platform/server/services/campaign_service.js`
- Create: `platform/server/routes_campaigns.js`
- Create: `platform/server/tests/campaign_api.test.js`
- Create: `platform/server/tests/campaign_concurrency.test.js`
- Create: `platform/server/tests/phase4_request_pipeline.test.js`
- Create: `platform/server/tests/phase4_nginx_ingress.test.js`
- Modify: `platform/server/server.js`
- Modify: `platform/server/routes.js`
- Modify: `platform/server/routes_customers.js`
- Modify: `platform/nginx/turingmarket.conf` for authenticated unbuffered request ingress
- Modify: `docs/api/campaign-business-spine.md`

**RED tests**

1. Exact request validation, field limits, canonical IDs, status codes, stable errors, `X-Request-Id`, pagination/filtering, and the JSON/multipart/bodyless Content-Type compatibility matrix. Request ID and Bearer authentication run before every global `express.json|urlencoded|raw|text`, route JSON, Multer, and parser on every Phase 4 route plus knowledge/influencer/demand parser routes. Production Nginx uses unbuffered upstream HTTP/1.1, rejects non-empty `Expect` as header-only 417, and fixed/chunked/slow/oversized/disconnect probes prove unauthenticated or admission-rejected bodies create no Nginx/application/parser temp file and never reach provider/business/event work.
2. Create authorizes submitted organization/opportunity/owner/team before user-scoped ledger lookup, derives customer, forces `lead/active`, and under one write lock repeats input authorization before campaign -> processing ledger -> creation event -> completed ledger. A retained key reauthorizes the stored campaign before replay/conflict, and revoked access reveals neither old body/hash decision nor campaign ID.
3. Conditional transition permits one concurrent winner and returns current state to stale writers.
4. Lifecycle guards join current target state and are cumulative across every prior state: cancelled collaboration aliases never satisfy progress; execution requires live/content-review/completed; publication requires trusted completed order/execution; settlement requires publication, completed status, and explicit cost confirmation; reviewed requires paired post-settlement knowledge/review. A same-status cost edit on a settled/reviewed campaign must reconfirm in that request or complete zero-event `COLLABORATION_COST_CONFIRMATION_REQUIRED` with no row/version/archive/link/event mutation. Incomplete progress has no event/dispatch side effect.
5. Same idempotency key/body replays exact status/body only after current user/campaign/target authorization; changed body conflicts; processing returns retry metadata; the frozen scope registry covers collaboration update, linked AI continuation, linked knowledge use, campaign task reassignment, and linked workflow pause/resume/cancel as well as every earlier mutation. Browser mutation intents reuse one key after timeout/lost response/in-progress and rotate only after terminal response or canonical body change.
6. Reused Task 2 JSON/multipart/empty vectors lock exact six-frame `tm-request-v1`; exact operation scope constants, key grammar, reservation nonce, immutable successful-outcome `expected_event_count`, and reused golden vector lock `tm-audit-v2`. Caller `source` is rejected and the exact event source/reason/metadata union is stored. Success requires exact 0/1/2 events; replayable `4xx|5xx` requires zero. Work deadline is separate from terminal retention; failed reclaim, both processing/failed deadline-to-completed 503 transitions, startup recovery, binary expiry, immutable artifact fields, and safe reuse are exhaustive.
7. Hold/resume/cancel rules, terminal cancellation, and lifecycle-active requirement; productive final races/replay return exact `CAMPAIGN_ON_HOLD` or `CAMPAIGN_CANCELLED`. Campaign cancellation atomically cancels every distinct linked nonterminal collaboration with one bounded version increment and complete alias revocation plus nonterminal dispatches, linked instances, pending tasks, and leases; completed collaboration/workflow evidence remains. Any row-version exhaustion or cascade mismatch rolls back everything. On-hold permits only documented recovery/evidence/collaboration-cancel actions.
8. Owner/team transfer validates destination membership and appends an event.
9. Generic attach requires caller reason. Link attach/correction/move is atomic, audited, permission checked, bundle-ID exact, and race safe; public generic links reject trusted `ppt|order|execution|publication|settlement|review|workflow`, historically classified targets require correction, complete alias bundles never split, ordinary cross-campaign correction produces exactly two reciprocal events, same-campaign reactivation one event/new bundle, review bundles reject every cross-campaign move while allowing only revoke/same-campaign exact-pair reactivation, and cumulative evidence-in-use checks block unsafe revoke/move.
10. Candidate search returns only targets visible and adoptable to the caller, does not leak restricted labels, and exposes collaboration `row_version` only in the campaign-only adoption shape.
11. Workspace groups active/history links and emits only the exact available/restricted-aggregate/missing tagged shapes; bounded CRM labels remain visible without granting detail. Event summaries expose full link metadata only after target plus every source/destination campaign is authorized; otherwise exact restricted/missing metadata contains no identifier.
12. `POST /api/campaigns/:id/reviews` atomically creates one server-classified knowledge entry, paired `knowledge/review` links, aggregate event, row-version increment, and exact replay only for an active settled campaign with no historical entry/pair for that settled event. Active duplicate returns `RECORD_ALREADY_LINKED`, a fully revoked pair returns `RECORD_REQUIRES_LINK_CORRECTION`, and partial/mismatched/cross-campaign evidence fails closed; stale/hold/cancel/rollback races leave no partial evidence.
13. Every `EventSummary` uses the event-type/source-specific exact metadata object; lifecycle/version/status/bundle/link/reconciliation fields cannot be silently replaced by `{}` or extra keys. Workflow reconciliation options/mutation behavior is Task 6 ownership, not a Task 5 campaign-service test.

**Implementation**

1. Build strict validators with a single stable error formatter and exact route-scoped request-ID -> Bearer auth -> media/size parser -> schema -> resource auth -> ledger pipeline. Make every global body parser share one owned-route skip predicate; authenticate multipart and reserve parser capacity before attaching Multer/body listeners or isolated parsing.
2. Mount correlation/auth/parser ownership for all campaign routes plus exact existing `/api/knowledge/upload`, `/api/influencers/upload`, and `/api/demand/parse-file` owners without changing their successful legacy bodies. Configure/test Nginx request streaming, HTTP/1.1 chunk forwarding, `Expect` rejection, byte/time bounds, connection close, and no-temp evidence in the same checkpoint.
3. Implement the request ledger and replay behavior with complete route-to-scope binding, exact null-campaign template/admission scopes, two-stage campaign-create authorization, authorization-before-lookup and transaction reauthorization, success-versus-error event cardinality, nonce-bound `tm-audit-v2`, token plus unexpired lease/deadline, deadline/retention separation, binary expiry preservation, typed bounds, quotas, and legal transition/immutable-identity guards.
4. Implement campaign mutations as explicit `better-sqlite3` transactions with expected-state/status and integer `row_version` predicates; every successful campaign-row mutation increments the version and maximum safe version fails closed.
5. Mount routes before generic/static fallback and add API documentation examples.
6. Add bounded `GET /api/campaigns/options?mode=...&resource=...&q=...&limit=...&offset=...` responses so create/transfer dialogs receive only accessible opportunities or legal owner/team pairs; never reuse the global admin users list.
7. Own and mount the exact non-workflow campaign knowledge list/detail HTTP APIs, post-settlement review mutation, and event metadata redaction serializers. Backend access decisions come only from Task 4 services; workflow retry/reconciliation/reassignment handlers are mounted and delegated in Task 6.

**Verification:** focused API/concurrency tests, syntax checks, then full Node suite.

## Task 6: Durable Workflow Dispatch / 可靠工作流派发

**Files**

- Create: `platform/server/services/campaign_workflow_service.js`
- Create: `platform/server/tests/campaign_workflow_dispatch.test.js`
- Modify: `platform/server/workflow_engine.js`
- Modify: `platform/server/routes_workflow.js`
- Modify: `platform/server/routes_campaigns.js`
- Modify: `platform/server/server.js`

**RED tests**

1. Only active `module=campaign` templates with an exact previous/next predicate produce dispatches.
2. Campaign template create/edit/trigger/publish uses four exact idempotency scopes, is platform-admin-only exactly by active legacy `users.role='admin'`, expected-version safe, module-immutable, exact-response/error locked, referenced delete returns `WORKFLOW_TEMPLATE_HAS_DEPENDENCIES`, and publish enforces the closed node/config/edge/condition schemas, role codes, action outcomes, mandatory fallback, reachability, and automatic-step bound.
3. Dispatch pins the versioned canonical `tm-workflow-snapshot-v1`, exact root transition `execution_context_json`, business projection `business_type='campaign'/business_id=campaign_id`, and real approval/rejection/condition/task golden checksum; layout fields are excluded, all campaign/event conditions read only immutable root context, reconciliation copies it byte-for-byte, and later template/campaign edits cannot change pending paths.
4. One event/template produces one dispatch and at most one initialized workflow instance under retry/concurrency.
5. Campaign transition commits state/event/dispatch and its idempotency response in one transaction without claiming workflow execution is atomic.
6. One initialization transaction creates reciprocal dispatch-bound instance/log/task/link/archive evidence, resolves a nonempty eligible actor set, stores task `assignment_version=1`, computes each nullable `due_at` from that task-creation transaction time, advances at most 100 safe nodes, marks initialization ready with no error, and completes dispatch; empty assignment, injected failure, or mismatched lineage rolls everything back to a sanitized validation failure instead of leaving an unreachable task.
7. Conditional 60-second claims, 20-second renewal, exact-token plus unexpired-lease heartbeat/finalize, four defined backoffs, live fifth-attempt immediate dead letter, expired fifth-attempt startup recovery (`WORKER_LEASE_EXPIRED_FINAL`) only while campaign is active, hold fencing/resume recovery, manual retry, and caught-failure/worker-crash/cancel injections do not duplicate effects or permit a sixth claim.
8. Invalid stored snapshot/checksum before initialization marks dispatch `failed_validation`. The `routes_campaigns.js -> campaign_workflow_service.js` workflow endpoints own retry, five-variant reconciliation options, reconciliation mutation, and task reassignment. Options applies authorization -> cancelled -> on-hold -> existing replacement -> failure shape -> template precedence. Reconcile handles same-key replay first, then repeats that order under `BEGIN IMMEDIATE`, preallocates a safe replacement ID, inserts the exact metadata-bound event before the explicit-ID dispatch, atomically creates the event-backed reconciliation archive/link, and preserves business/root/context lineage; only different-key losers return already-reconciled. Retry status/attempt reset and all route validators/replays are tested here. Every initial claim/reclaim writes a future lease. Post-initialization corruption or a next-task actor set emptied by identity/role/membership drift rolls back the task action; the latter records exact `WORKFLOW_ASSIGNMENT_UNRESOLVABLE`. The guarded second transaction logs/archives failure, cancels pending tasks, completes exact 409, makes the completed-dispatch/failed-instance pair reconcilable, applies cancellation/hold-before-stale precedence, and leaves lost authority/lease untouched without mutating the completed dispatch.
9. Every later campaign-linked task action uses the frozen action scope, exact body including `expected_assignment_version`, node/action type guard, independent platform/org/team role truth table (`team_lead` requires exact active lead role; `member` accepts any active team membership) plus effective task ID conjunction, active-instance predicate, root-event conditions, exact replay response using `active|completed`, and cancellation -> hold -> active-only stale precedence with exact three-field details; one `BEGIN IMMEDIATE` transaction reauthorizes user/campaign/operational/team/effective assignment/version before task/log/linked knowledge archive/pinned advancement/nonempty-assignment next tasks or terminal state. Campaign-linked task list/detail/instance-trace projections append `assignment_version`; mixed and unlinked legacy rows retain exact old keys, and reload/stale-refetch tests prove the token is obtainable.
10. Owner/org-admin task reassignment uses scope `workflow.campaign-task.reassign`, exact pending/active/assignment-version body, a nonempty currently eligible ID/role intersection, and one transaction for assignment/version update, bounded node/activity audit, required archive/link, and zero-event replay. After replay and winner-precedence checks, an identical current/requested tuple completes replayable zero-event `400 INVALID_CAMPAIGN_INPUT` without version/log/archive change. Invalid ID, same-assignment, deactivation/team-transfer/membership-revocation/completion/pause/cancellation/reassign/action/dropped-response races prove cancellation -> hold -> stale/identity/no-op precedence and one winner.
11. Linked instance pause/resume/cancel uses three frozen scopes, exact expected-status body, campaign write, cancellation -> hold -> active-only stale precedence/details, and one `BEGIN IMMEDIATE` transaction that reauthorizes user/campaign/operational/team/lineage/status before status/log/linked archive/ledger commit; cancel also cancels pending tasks and task/control/transfer/hold race tests prove one winner; unlinked controls keep exact legacy behavior.
12. Exact unlinked legacy API/knowledge-archive key arrays, linked-only `assignment_version` projection, and separate task-list versus task-detail/action role predicates, non-campaign manual starts, customer-stage all-active-template selection/payload/error swallowing, deferred 100 ms advancement, webhook best-effort behavior, and timer crash window are golden-regression locked.

**Implementation**

1. Keep legacy serializers explicit so new nullable columns never leak into old `SELECT *` response shapes.
2. Add platform-admin-only expected-version/idempotent campaign create/edit/trigger/publish handling, one closed-schema execution snapshot/context serializer/checksum/evaluator, explicit approve/reject/complete outcomes, mandatory condition fallback, and strict exactly-one deterministic route selection; block parallel/webhook/timer/auto-action/sub-process until their later durable phases.
3. Split opt-in campaign initialization from the current default `startWorkflow` behavior and implement the exact claim/lease/backoff/dead-letter state machine.
4. Make all campaign initialization and atomic post-task continuation resolve/check the pinned dispatch snapshot.
5. Mount exact retry/reconciliation-options/reconcile/reassign validators in `routes_campaigns.js` and delegate every state decision/transaction to `campaign_workflow_service.js`. Add audited, idempotent owner/org-admin retry, precedence-ordered five-variant reconciliation-options read, safe replacement-ID preallocation/event-first explicit-ID insertion plus event-backed reconciliation archive, and unique pre/post-initialization failed-validation replacement lineage with expected statuses, same-key replay/different-key loser rules, reason, server-owned source, root trigger event, byte-identical execution context, exact workflow business projection, reciprocal dispatch-instance checks, atomic linked instance controls, task-creation-time `due_hours`, nonempty initial/continued assignment with identity-drift failure recovery, linked-only assignment-version projection, versioned effective assignment, and owner/org-admin reassignment with the shared assignee truth table and explicit no-op rejection.

**Verification:** focused workflow tests, existing workflow tests, then full Node suite.

## Task 7: Existing Record Integration And Async Safety / 现有记录接入与异步安全

**Files**

- Create: `platform/server/services/campaign_link_service.js`
- Create: `platform/server/tests/campaign_record_integration.test.js`
- Modify: demand/proposal/PPT, knowledge, and AI route owners in `platform/server/server.js`
- Modify: `platform/server/services/knowledge_service.js`
- Modify: `platform/server/services/rag_service.js`
- Modify: `platform/server/services/llm_service.js`
- Modify: `platform/server/services/web_search_service.js`
- Modify: `platform/server/services/ai_service.js`
- Modify: collaboration route owners in `platform/server/routes.js`
- Modify: workflow route owners in `platform/server/routes_workflow.js`
- Modify: existing customer/opportunity delete owners in `platform/server/routes_customers.js`
- Create: `platform/client/features/campaign_ppt_bridge.js`
- Create: `platform/server/services/upload_sandbox_service.js`
- Create: `platform/server/scripts/parse_upload_sandbox.sh`
- Create: `platform/server/systemd/turingmarket-parser@.service`
- Create: `platform/server/systemd/turingmarket-parser.slice`
- Create: `platform/server/systemd/turingmarket-parser.manifest.json`
- Create: `platform/server/tests/upload_sandbox.test.js`
- Create: `platform/server/tests/campaign_ai_rag.test.js`
- Create: `platform/server/tests/campaign_ppt_singleflight.test.js`
- Create: `platform/server/tests/knowledge_archive_contract.test.js`
- Modify: `platform/app.js` only for central API hooks and adapter unit integration; production asset loading waits for Task 8's CSP checkpoint
- Do not modify: `platform/ppt.js` (frozen build/hash contract)

**RED tests**

1. Omitted `campaign_id` returns the same status/body and creates no link for every changed endpoint, except the explicit global collaboration authorization/internal-version, immutable-provenance knowledge access, upload sandbox, and PPT admission controls.
2. Present or server-derived `campaign_id` requires idempotency and preauthorization, every replay reauthorizes before lookup, and every mutation revalidates inside the final transaction.
3. Every documented optional-link route locks exact JSON/multipart fields, linked status/body, complete immutable scope, errors, legacy omission behavior, and base-row/link atomicity; campaign workflow links and trusted collaboration/PPT evidence aliases cannot be fabricated by generic linking.
4. AI links the conversation parent, not a message; later messages derive/enforce one campaign before ledger lookup. Up to 20 ordered selected entries contribute chunks ordered by index/ID, then at most eight retrieved chunks use the full FTS/updated/entry/index/chunk-ID order. Exact `[KB-r]\n<title>\n<content>` records joined by two LF are independently capped at 48 total chunks, eight retrieved chunks, and 98,304 UTF-8 bytes: selected overflow errors, while retrieval stops at the first whole candidate that would exceed any cap without skip/truncation. Boundary vectors cover duplicate-index preflight, byte limit/limit+1, retrieved count 8/9, rank digit growth, multibyte/LF, and stop order. One version-1 reference row/response item is stored per finally included chunk with immutable digests/contiguous rank/origin; usage increments once per distinct entry and citations count distinct assistant messages. Current reads redact revoked chunks.
5. Linked DeepSeek is mandatory while web search is optional. Both adapters receive one abort signal/deadline and every fetch uses it. Missing/outage/timeout/abort/malformed LLM returns zero-event 503 with no conversation/message/reference/token/archive/cache/link write; provider success persists all domain rows atomically. Unlinked v0.4 degraded fallback is unchanged and late results cannot write.
6. M3 captures `{id,campaign_id,content_sha256}` and re-saves edited outlines. A proposal-version resource claim is reserved before rendering across all keys: two-key races make one renderer/provider call; processing loser returns `PPT_GENERATION_IN_PROGRESS`, successful loser returns `RECORD_ALREADY_LINKED`, and failed/error outcomes release the active claim predicate.
7. Multipart request hashing includes canonical fields plus every file SHA-256/length/MIME/basename, so changed bytes conflict under one key.
8. Output validates, fsyncs, no-replace promotes, and fsyncs parents before token-matched commit; stale workers cannot persist/delete the winner. Binary expiry preserves every artifact field; janitor excludes live leases and resumes missing-file cleanup. Scoped/unscoped PPT share admission and unscoped rows remain accounting-only.
9. Knowledge, influencer, and demand parser routes use the exact isolated launcher after Task 5 auth-first middleware and pre-body internal parser admission. Exact 1/user, 3/organization, 4/global concurrency; 20/100/200 hourly starts; 512-MiB spool reservation; 2-GiB free floor; per-job scratch/resource limits; and aggregate slice memory/CPU/task limits survive restart. Zip bombs, malformed content, authenticated flood, aggregate pressure, unit/slice/manifest/self-test drift, escape, timeout, abort, crash, revocation, restart, and final conflict leave no durable business/link/temp path; production drift aborts before listen rather than disabling routes.
10. Provider/file/parser failure, operation deadline/abort, revoked access, capacity, digest conflict, or final-link conflict leaves no producer/archive/reference/usage/cache row and removes attempt artifacts. Same-key retries never duplicate durable records.
11. Linked collaboration create/adoption/update keeps the exact closed status/version/cost/publication/settlement/cancel contract, complete inherited alias bundle, list/stats access, and unchanged shared influencer export. A settled/reviewed cost change without same-request reconfirmation is a replayable zero-event 409 with no row/version/archive mutation; reconfirm and stale/cancel/hold races preserve cumulative state.
12. Every knowledge path resolves historical custody. Exact demand/proposal/PPT/collaboration/AI/workflow/review producer projections use immutable source/content/chunk hashes. Instance-backed workflow task/control/terminal/reassignment archives use real node-log IDs; pre/post-initialization reconciliation uses its separate event-backed source/projection. Review source identity is one-per-settled-event and only same-campaign reactivation can reuse a revoked pair. `tm-knowledge-chunk-v1` golden cases cover NFC/LF normalization, empty content, paragraph packing, U+1F600 scalar boundaries, and a 1,201-scalar oversized paragraph; campaign-owned same-source retries compare the complete ordered chunk-digest list while truly unlinked refresh retains its legacy branch. Required linked archives commit atomically; suppression is legal only for replay or byte-identical no-semantic-change collaboration edits. Source projection is `{kind,label}`; campaign-aware reads project stored legacy `public|shared -> team` without changing truly unlinked legacy response tokens. Linked JSON and multipart write tests prove omitted visibility stores `private`, exact `private|team` is accepted, and `public|shared`, other tokens, or `is_public` return zero-mutation `400 INVALID_CAMPAIGN_INPUT` without normalization. Exact user/campaign/organization entry/chunk/payload/reference matrix, UTF-8 payload-column sum, creatorless-default-organization/no-user attribution, limit/limit+1, and destination-move tests return 507 before mutation; no inaccessible chunk reaches AI/proposal/PPT.
13. CRM target deletes return route-specific zero-mutation dependency errors; the existing workflow-template hard delete remains separately golden-locked.
14. Frozen generator/editor save failure cannot be swallowed in campaign mode; adapter retry preserves exact content/key and is not production-loaded until Task 8 security approval.

**Implementation**

1. Add shared optional-link helpers consuming Task 4 access and Task 5 request/ledger services, with final reauthorization, temporary ownership, transactional base/link/required-archive completion, exact quotas, and deadline-aware cleanup.
2. Keep provider calls outside DB transactions but pass the ledger abort signal/deadline through LLM and web adapters; persist no linked AI domain row before mandatory LLM success.
3. Preserve current no-key response behavior when `campaign_id` is absent while applying the four documented global security controls.
4. Implement and unit-test the campaign adapter as a post-`ppt.js` wrapper plus central `apiFetch` hooks; invalidate/re-persist edited outlines and reserve the exact proposal-version claim before renderer work; do not production-load it yet, change renderer bytes, use eval, or intercept generic `window.fetch`.
5. Implement the exact checked-in production parser admission registry, systemd unit/slice profiles, manifest, identity launcher, effective-property/aggregate-pressure self-test, spool accounting, and cleanup contract before every knowledge, influencer, or demand parser body/persistence path; fail production startup before listen on any drift.
6. Implement canonical valid-scalar NFC/LF persistence, exact `tm-knowledge-chunk-v1`, deterministic selected/retrieved chunk assembly capped at exactly 48 total chunks, eight retrieved chunks, and 98,304 UTF-8 bytes, per-chunk immutable references, safe source projection, campaign-aware visibility projection without legacy-token rewrites, strict linked-write `private|team` admission, exact producer archive projections, digest collision handling, distinct usage/citation accounting, and persistent capacity gauges.

**Verification:** focused integration/sandbox tests, frozen PPT hash/bridge unit checks, full Node suite. No new client asset is enabled in production HTML at this checkpoint.

## Task 8: Project Workspace And Campaign Context / 项目工作台与活动上下文

**Files**

- Modify: `platform/index.html`
- Modify: `platform/app.js`
- Modify: `platform/client/shared/build_info.js`
- Modify: `platform/client/core/navigation.js`
- Modify: `platform/client/styles/components.css`
- Modify: `platform/client/styles/layout.css`
- Create: `platform/client/core/csp_compat.js`
- Create: `platform/client/features/ppt_preview_runtime.js`
- Create: `platform/client/features/campaign_context.js`
- Create: `platform/client/features/campaign_workspace.js`
- Create: `platform/server/tests/campaign_workspace_contract.test.js`
- Create: `platform/server/tests/campaign-workspace.spec.js`
- Create: `platform/server/tests/campaign-workspace.config.js`
- Modify: `platform/server/services/public_assets_service.js`
- Modify: `platform/nginx/turingmarket.conf`
- Modify: `platform/deploy_v8.ps1` static manifest/build boundary
- Modify: `platform/server/tests/frontend_public_assets.test.js`
- Modify: `platform/server/tests/product_shell_contract.test.js`
- Modify: `platform/server/tests/frontend_architecture_inventory.test.js`
- Modify: `platform/server/tests/deployment_source_contract.test.js`

**Design grounding**

1. Use current Phase 3 desktop/mobile baseline screenshots and design tokens as the visual source.
2. Capture implementation at the same states/viewports and create side-by-side reference comparisons before approval.
3. Reuse current icons/components; do not introduce a new palette, typography, radius, card system, or framework.

**RED/browser tests**

1. Before any campaign markup is added or adapter is production-loaded, stored script/attribute/URL canaries across the existing CRM, brand, influencer, workflow, AI, knowledge, and scoped/unscoped PPT surfaces remain inert through reload/export; all data-bearing `innerHTML`/inline handlers are removed or translated by external listeners, popup preview uses external runtime, exact Express/Nginx CSP headers match, every frozen PPT control works, and CSP violation capture is empty.
2. URL campaign wins over user/org-scoped session storage; invalid/403/404 never silently fall back; `/campaigns` may restore scoped context while M3/M4/M5/workflow without a URL stays legacy-unscoped.
3. Every per-route known query, including campaign `entry` and module `record`, canonicalizes in the documented order; duplicate/invalid known values show invalid-link state, and unknown values are stripped once without dropping valid state.
4. Select fetches before push/bind and on network/authorization failure preserves the prior URL/context/form; clear/back/forward semantics update URL/history/storage exactly once. Two-tab login/logout, `401`, failed restore, same-user new-token login, partial storage write, and user/org switch validate the exact persistent auth binding, abort old generations, clear only prior-owned scoped state including `tm_ai_memory`/legacy brand history, and never let a delayed old tab erase/mutate the new identity.
5. Dirty forms stay bound to their captured original campaign. Save success replays once; Save failure keeps current URL/context and inline error; Discard removes only that draft; Cancel changes nothing and restores focus.
6. Create/transfer dialogs use permission-filtered opportunity and identical transactional owner/team rules. Record rows/labels/selections never link to CRM detail; only `no_eligible_opportunity` may show one generic `/m0-detail?view=opportunities` command, while no-assignment shows non-link contact-admin text.
7. Workspace supports campaign create/search/select, metadata, transition, hold/resume/cancel, transfer, create/attach/correct, guarded collaboration order/execution/publication/settlement/cancel, post-settlement review, workflow retry/trace, pending-task reassignment, and five-state reconciliation options. Exact restricted/missing variants never leak labels/IDs.
8. The ordinary-user campaign knowledge panel uses the exact campaign list/detail APIs to search/filter/open the authorized unlinked-plus-custody union, creates/uploads/ingests/attaches/corrects/uses permitted entries, and launches campaign AI with ordered selected entry IDs without routing to admin `/kb`; revoked/moved/restricted/missing states and filters remain stable.
9. A platform admin configures/validates/publishes the campaign trigger and repaired template, then reconciles pre/post-initialization failure through UI; an owner/org admin reassigns a now-ineligible pending task without editing the frozen template; a normal user saves proposal before campaign PPT, assembles demand/proposal/PPT/shortlist/order/execution/publication/settlement/review/AI/knowledge entirely through UI, triggers workflow, opens trace, and reopens workspace.
10. First-run, no result, no eligible assignment/opportunity, loading, network/retry, 403, 404, stale transition/task/assignment, hold/cancel, restricted, missing, upload-timeout, no-matching-template, and already-reconciled states match the design.
11. Dialog focus trap/restore, keyboard controls, labels, `aria-busy`, no overflow/overlap at desktop, `390x844`, and `320px`.
12. The legacy workflow designer supports keyboard-only source/destination connection authoring, cancellation, validation announcement, deletion/repair, and focus restoration; NVDA, accessibility-tree/axe, shared dialog, forced-colors, reduced-motion, and `200%/400%` reflow gates pass.
13. Dropped committed responses for campaign and linked writes preserve one intent/key through retry and create no duplicate; body change rotates the intent.
14. The five new Phase 4 client assets (`csp_compat.js`, `ppt_preview_runtime.js`, `campaign_context.js`, `campaign_workspace.js`, and Task 7 `campaign_ppt_bridge.js`) join the seven existing public client assets for an exact 12-path allowlist. Every path plus direct `/campaigns` passes Express/Nginx/deploy-manifest GET/HEAD tests; unknown siblings stay `404`. `build_info.js`, query/build identifiers, and frozen PPT hash are exact. Script order is build info -> navigation -> accessibility -> shell -> app -> frozen PPT -> CSP compatibility -> campaign context -> campaign workspace -> campaign PPT bridge.
15. Existing CRM/M4/AI/PPT/workflow/admin journeys remain operational and runtime-clean.

**Implementation**

1. Security sub-checkpoint first: inventory/remediate all existing data-bearing HTML sinks and inline handlers, add external delegated listeners, allowlisted frozen-control translator, external popup runtime, exact CSP headers, and static allowlists; run existing product/PPT journeys and obtain Security Reviewer approval before adding workspace markup or loading `campaign_ppt_bridge.js` in production HTML.
2. Extend `TMNavigation` query-state parsing rather than adding ad hoc history logic.
3. Add the exact cross-tab auth binding/generation helper, scoped session-context/mutation-intent/brand-history helpers, delete the legacy global key, and add dirty-form guards while retaining the Bearer contract.
4. Add a compact workspace page, exact ordinary-user campaign knowledge list/detail/filter/AI-selection panel, and shared campaign-context control using existing Phase 3 tokens/components only.
5. Add create/attach/correction/transfer/status/collaboration publication/settlement/cancel/review dialogs with stable dimensions and inline recovery; add platform-admin trigger edit/publish and owner/org-admin five-state reconciliation UI while normal-user workflow creation remains auto-dispatch only.
6. Add sticky but non-overlapping trace/table headers and internally scrolling regions only where necessary.
7. Do not expose raw IDs, secret values, provider details, restricted metadata, or inaccessible CRM routes.
8. Complete the Phase 3 deferred workflow keyboard-connection interaction with existing controls/components and no mouse regression; missing NVDA evidence blocks release.
9. Only after the security sub-checkpoint, production-load the approved assets in the exact frozen script order and update Express/Nginx/index/deploy manifests in one reviewed slice.

**Verification:** navigation contract, campaign browser suite, product-shell suite, baseline journeys, visual comparison at all three viewports.

## Task 9: Populated Sanitized Migration And Deploy Gate / 脱敏迁移与部署门禁

**Files**

- Create: `platform/server/scripts/sanitize_production_shape.js`
- Create: `platform/server/scripts/sanitization_manifest.json`
- Create: `platform/server/scripts/verify_campaign_migration_gate.js`
- Create: `platform/server/scripts/cleanup_stale_migration_gate.sh`
- Create: `platform/server/scripts/release_replay_gate.js`
- Create: `platform/server/systemd/turingmarket-gate-cleanup.service`
- Create: `platform/server/tests/sanitized_migration_gate.test.js`
- Create: `platform/server/tests/release_replay_gate.test.js`
- Modify: `platform/deploy_v8.ps1`
- Modify: `platform/DEPLOY.md`
- Modify: `platform/server/scripts/bootstrap_production_runtime.sh`

**RED tests**

1. Exhaustive manifest classifies every table/column/virtual shadow and unknown schema or JSON path fails closed. `secret-null` is accepted only for an all-null source column; any non-null credential/token column uses inert secret-synthetic while preserving nullness row by row.
2. Sanitizer preserves row counts, PK/FK IDs, topology, exact null patterns, approved equality partitions/cardinality, and volume while replacing text/contact/token/URL/prompt/proposal/knowledge/file/nested JSON data and bucketizing sensitive numerics.
3. FTS/derived tables are dropped and rebuilt from sanitized bases; source-to-output hashes/encodings/JSON leaves/FTS leak comparison finds no non-allowlisted source value.
4. Root pre-scrubs credential/session/provider secrets to a disjoint replacement-sentinel set, then checkpoints/closes and `VACUUM INTO` materializes a fresh compact database; no `-journal|-wal|-shm` sidecar remains, raw-byte scans reject only seeded source-leak probes/original encodings/fingerprints, and logical assertions require replacement sentinels only in classified columns before an ephemeral UID sees the read-only source.
5. A fsynced root-only run journal exists before staging; success/trap cleanup and startup/boot reconciliation remove recorded processes, mounts, paths, and UID. Forced `SIGKILL` before/after mount and reboot simulation prove stale-run cleanup before another source copy.
6. Populated copy migration passes twice with identical `tm-sqlite-topology-v1`, `tm-sqlite-logical-v1`, and per-table `tm-fts-logical-v1` digests by reusing Task 2 byte-for-byte. The knowledge FTS projection joins chunks to entries for exact title/content/normalized tags plus stored entry/chunk IDs, passes FTS5 integrity and deterministic two-canary MATCH row sets, and fails on stale/missing/swapped postings.
7. WAL/hot-journal-safe DB plus `PPT_CACHE_DIR` backup/restore into a clean target reproduces topology/full logical digests, binary ledger/file parity, fsync ordering, and no stale sidecars. Backup root/path components/modes/owners/no-link/same-root rules reject symlink/hardlink/device/socket/FIFO/mount substitution; only regular single-link `0600` files under root-owned `0700` directories are accepted.
8. Runtime bootstrap is setup-only after the external-layout marker, shares lifecycle/global-writer locks, cannot directly restore a Phase 4 database/runtime, and deploy refuses unresolved bootstrap journals/locks/processes/staging.
9. Guarded deployment refuses cutover if any migration, privacy, upload sandbox, PPT/CSP, static-boundary, contract, browser, alternate-recovery, loopback-bind, or persistent firewall gate fails.
10. Before any candidate/rollback start, PM2 exports exact `SERVER_HOST=127.0.0.1`, the host firewall rejects non-loopback destination port 3002, `ss` proves no wildcard/host-interface listener, and a host non-loopback connection probe is refused. After maintenance and backup include the prior marker, that marker is atomically archived same-filesystem and fsynced before candidate mutation. Automatic rollback is allowed only while exact current `accepted.json` is absent; the normal site is preloaded but its return-only API gate remains `503` until the new or restored-prior root-owned marker is atomically renamed/fsynced into place, the single public-enable/irreversible boundary.
11. Interrupted pre-enable rollback resumes each monotonic journal phase including `prior_marker_archived`, `nginx_candidate_staged`, `overlay_destroyed`, and `accepted_public_enabled`; marker existence/digests are authoritative if journal mirroring is interrupted. Mismatched backup/journal/overlay/firewall/marker checksums, user mapping, non-loopback bind, or premature API exposure fail closed. After current marker appearance, automatic rollback is refused; monitoring failure reloads maintenance without deleting the marker and preserves current code/data/cache for roll-forward.
12. Manual database restore requires `-RollbackBackup`, `-RestoreDatabase`, and `-ConfirmDataLoss`; restore with `-PreserveSessions`, code-only Phase 4 rollback, or premature maintenance removal is rejected.
13. Digest golden tests change for every SQLite type/schema/column/index/FK/sequence/pragma/FTS semantic-key mutation and remain stable across row reorder, VACUUM, allocator-rowid change, and identical FTS rebuild.
14. Backup retention keeps at least 30 days and newest ten accepted releases, never removes the current-marker/live-journal/unresolved/last-good backup, and uses validated atomic rename plus no-follow bottom-up fsynced deletion; injected cleanup failure remains resumable and auditable.
15. The checked-in replay helper plus Nginx gate accepts one exact loopback method/path/header. Parent/socket ownership is `0710 root:www-data` and `0660 root:www-data`; root-only header/claim files are `0600`. The helper exclusively creates `probe.claimed` using Node `O_CREAT|O_EXCL|O_NOFOLLOW`, writes/fsyncs it, unlinks pending, fsyncs the parent, and only then forwards once. Crash/restart/concurrency fail closed and cleanup leaves no bypass path.

**Implementation**

1. Create/fsync the root-only run journal, root-copy and pre-scrub all credential fields to disjoint replacement sentinels, compact with `VACUUM INTO`, close/fsync/reject all sidecars, raw-scan the forbidden-source set and logically verify required replacements, then run under an ephemeral UID with empty environment, read-only compact source, separate output, no network/private mounts, and trap plus boot/startup stale-run cleanup; never transfer output to the repository.
2. Reuse Task 2's exact frozen topology/logical/FTS implementation and primitive/full golden vectors; produce only file checksum, three digest classes, and aggregate counts, never source values.
3. Add the exact all-API Nginx maintenance/marker gate, persistent non-loopback port-3002 firewall rule, exact loopback PM2/rollback environments, and the checked-in one-request Unix-socket replay helper with Nginx-readable group modes plus exclusive-create/fsynced claim CAS. Include complete bypass removal proof, PM2/port stop, WAL checkpoint plus `BEGIN EXCLUSIVE`, and one no-link backup manifest covering SQLite plus private PPT artifacts.
4. Extend `platform/deploy_v8.ps1` with `-RestoreDatabase`, `-ConfirmDataLoss`, and bounded `-MaintenanceTimeoutSeconds`; reject session preservation for every database restore.
5. Implement the atomic `0600` rollback journal and version-1 security overlay including department, exact user-set preflight, checksum-verified resumable code/staged-Nginx/DB/cache restore, all-sidecar-safe replacement/fsync, transactional overlay/membership/session invalidation, artifact reconciliation, durable overlay destruction, prior-marker backup/archive/restore, and one root-owned no-replace/fsynced current marker whose existence both opens the preloaded Nginx API gate and permanently disables automatic destructive restore. Add the exact retention and resumable no-follow destruction policy. Post-accept failure re-enters maintenance and requires roll-forward unless an operator explicitly runs `-ConfirmDataLoss`.
6. Remove/delegate bootstrap's alternate restore path, share locks, and fail closed on any unresolved bootstrap or sanitizer gate journal/process.

**Verification:** synthetic privacy canaries locally, production-shaped gate remotely, deploy script parse/contracts, no candidate cutover yet.

## Task 10: Independent Review, Production Deployment, And Archive / 独立审查、生产部署与归档

**Review sequence**

1. Code Reviewer: correctness, regressions, security, concurrency, and test gaps.
2. Backend Architect: schema/API/authorization/rollback verdict.
3. Data Engineer: migration, sanitizer, topology, and restore verdict.
4. Workflow Architect: trigger/retry/recovery/customer-regression verdict.
5. AI Engineer: provider abort/deadline, RAG chunk/reference, archive/digest, quota, and replay verdict.
6. Security Reviewer: authentication context, authorization concealment, idempotency/cache, sanitizer, secret, and rollback verdict.
7. Frontend Developer plus Product Manager: normal-user journey, interaction states, responsive behavior, and scope verdict.
8. Git Workflow Master: diff/secret review, intentional commits, remote branch, changelog/version records.

Every reviewer must return `APPROVE`; resolve all findings and rerun affected tests before deployment.

**Predeploy evidence**

- Full Node suite passes from a fresh local database.
- Baseline browser suite and product-shell suite pass.
- Campaign workspace browser/visual suite passes at desktop/390/320; keyboard workflow connections, NVDA/accessibility tree, dialogs, forced colors, reduced motion, and reflow evidence pass.
- Frozen PPT query/build/hash and generation journey pass.
- Migration/baseline immutable-source checksum, exact topology/logical/FTS primitive and full golden vectors, populated sanitized two-run gate, disjoint forbidden-source/replacement-sentinel proof, orphan preflight and cleanup, no-link/mode-verified WAL-safe DB-plus-PPT-cache backup/restore, FK/integrity pass.
- Linked AI abort/deadline and optional-web/mandatory-LLM tests, deterministic selected/retrieved chunk references, visibility/source redaction, required producer archive rollback, knowledge capacity, and two-key PPT single-flight tests pass.
- Static boundary, deploy parse/contracts, syntax checks, secret scan, and `git diff --check` pass.

**Production deployment**

1. Create one named release backup with checksum manifests for code, Nginx, SQLite, and private PPT cache plus a tested restore journal; verify exact root-owned `0700` directories, regular single-link `0600` files, no mount/symlink/hardlink drift, and retention protection.
2. Validate the remote candidate in isolation.
3. Enter all-public-API maintenance, prove authenticated/unauthenticated reads and writes are `503` except health, install/verify the non-loopback port-3002 firewall rule, take the final SQLite Backup API backup, atomically cut over code, run migration before listen, and restart with exact `SERVER_HOST=127.0.0.1`; prove loopback-only `ss` state and refused host-interface access.
4. Through root-controlled loopback, run owner, team member, same-org outsider, and platform-admin acceptance: full campaign chain, all reconciliation variants, required knowledge archives, per-chunk AI references, optional-web/mandatory-LLM behavior, two-key PPT single-flight, immutable provenance after revoke/move, task/control/transfer/hold races, deterministic concealment, shared upload sandbox, and two-tab auth revocation; retain one completed authorized idempotent projection/key.
5. While all other public APIs remain `503`, use the checked-in one-request replay helper: the local-origin request must atomically claim/fsync its marker before one Express forward, concurrent/crash probes fail closed, and exact status/body/deterministic-header projection replays after current authorization with fresh request-ID excluded and no new write. Stop the helper and remove/fsync/prove absence of its Nginx include, socket, header, and claim files; prove the prior marker was backup-bound and archived, preload the normal marker-gated site, prove current-marker absence still returns `503`, then atomically rename/fsync the new exact `accepted.json`. Its appearance is the single public-enable/automatic-rollback boundary. Any pre-marker failure restores the verified prior marker only after full rollback verification; any post-marker failure reloads maintenance without deleting the current marker, preserves current code/database/cache, retains locks/evidence, and permits only roll-forward unless an operator explicitly confirms data loss.
6. Verify current CRM, M4 import/template/search/sticky-header, Feishu/order surfaces, AI/KB/admin audit, workflow, stored-XSS/CSP, every frozen PPT control in scoped/unscoped mode, and public online journeys still work.
7. Confirm no active test sessions, bypass, temporary artifacts, raw/sanitized staging data, parser/gate UID/process/mount, credential overlay, or credentials remain; retain only explicitly labelled cancelled release-smoke evidence.

**Version and archive**

- Update `CHANGELOG.md` with user-visible behavior, migration/rollback, tests, backup, deploy, and production proof.
- Create a bilingual version record under `docs/version-records/`.
- Sync the same record to `D:\主盘\图灵集市\图灵商务平台开发\01-版本归档`.
- Commit intentionally, push the branch/GitHub target, and verify remote commit equality.
- Update `TuringMarket-开发进度.html` to Phase 4 complete only after production acceptance.

**Done / 完成标准:** Phase 4 is not complete until implementation, all independent approvals, all test gates, production deployment, authenticated online verification, backup/restore evidence, changelog/version/Obsidian archive, and GitHub synchronization are all complete.

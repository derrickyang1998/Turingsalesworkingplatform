# Campaign Business Spine API v0.5 / 活动业务主链 API v0.5

This is the implementation contract for Phase 4. The schema and authorization source of truth is `docs/superpowers/specs/2026-07-14-phase-4-campaign-business-spine-design.md`.

## Frozen Database Contract / 冻结数据库合同

Task 3 freezes the executable `002` inventory independently in `platform/server/tests/fixtures/campaign_schema_contract.js`: 9 STRICT tables, 23 compatibility columns, 10 indexes, 51 triggers, and 17 composite foreign keys. The release gate compares deployed SQL to fixed SHA-256 values instead of importing `002`'s own manifest:

- indexes: `bdb5508e1a02c0cf88fd763e1d9b664e192660503d87dcd7afd39517cfedeb3c`
- triggers: `d7fffc8dbb15f7e77de0b65038fc100f4b15e2b0cc3bd89b3672f7427ce570f6`
- combined: `5e8cd0a587b10899a676634e8c82aa841bf7e1e7201c5cb5aec863614ee38d00`
- complete managed 26-index/54-trigger set: `14e3dfa8d56070983336e62660f328cf3e274d66f1839c2a6d89d90b3d4d952e`

The complete 51-trigger list includes `organizations_no_replace_insert`, `campaign_settled_collaboration_no_replace_insert`, `campaign_workflow_task_no_replace_insert`, and `knowledge_entries_no_replace_insert`. These guards preserve existing rows when a caller uses SQLite conflict-replacement syntax. / 完整的 51 个触发器清单包含上述四个防覆盖保护，确保冲突替换语法不会静默删除既有业务记录。

## Common Contract / 通用契约

- Authentication: the existing `Authorization: Bearer <tm_token>` header. The client continues to load `tm_token` from local storage and removes it on logout or `401`; Phase 4 does not migrate authentication to cookies. Release nevertheless requires removal of all data-bearing `innerHTML` and inline script handlers plus the exact restrictive CSP in the design, because a stored-XSS path would expose this token.
- Organization: Phase 4 resolves the authenticated user's `turingmarket-default` membership. The default code is database-immutable and its organization row cannot be deleted. Clients cannot submit or override `org_id`.
- Auth context: successful login and `/api/auth/me` preserve the existing `user` object and add `auth_context.organization {id,code,name,role_code}` plus `auth_context.teams[] {id,code,name,role_code}`. Login still includes the token. This server-owned context is the only source for user/org-scoped client keys. The browser binds `tm_token`, `tm_user`, and `tm_auth_context:v1` with exact `tm_auth_binding:v1 {generation,user_id,organization_id,token_sha256}`; every request captures that tuple plus a tab-local generation, and storage/BroadcastChannel changes abort all older-generation work before UI/storage mutation. An old tab or delayed `401` may clear persistent credentials only when its expected generation still owns the binding.
- Parsing order: every Phase 4 and shared integration path runs request-ID creation, Bearer authentication, route-scoped content-length/content-type parser, schema validation, resource/campaign authorization, then ledger lookup. Every global parser, including `express.json`, `express.urlencoded`, and future raw/text parsers, skips the complete exact owned-path matrix. Multipart authentication and parser admission run before Multer, temporary-file creation, archive inspection, or isolated parsing. Every auth/parser error echoes the generated `X-Request-Id`.
- Ingress body handling: production Nginx uses `proxy_request_buffering off` plus upstream HTTP/1.1 for `/api/`, rejects every non-empty `Expect` header as header-only `417`, and combines route-specific maximum bytes, 10-second inter-read timeout, and the application's 60-second upload-body wall timer. Fixed-length and chunked unauthenticated or admission-rejected bodies are closed before a body listener and create no Nginx/application/parser temporary file.
- Content type: every new Phase 4 mutation and every existing mutation that supplies or derives campaign context requires `application/json` (case-insensitive media type; parameters allowed) after authentication and before lookup/ledger reservation. Wrong/missing type is `415 UNSUPPORTED_MEDIA_TYPE`. Exact exceptions: `/api/knowledge/upload`, `/api/influencers/upload`, and `/api/demand/parse-file` require multipart with a valid boundary; campaign-classified `POST /api/knowledge/:id/use` requires zero bytes and accepts no type or JSON; bodyless customer/opportunity DELETE accepts no type. A non-empty body on a bodyless route is `400 INVALID_REQUEST_BODY`. Truly unlinked legacy writes retain their v0.4 media-type behavior unless named above.
- Correlation: clients may send `X-Request-Id` (8-120 printable ASCII characters); otherwise the server generates one. Every response echoes it.
- Idempotency: every campaign mutation and every existing write containing or deriving `campaign_id` requires `Idempotency-Key` matching exact ASCII `[A-Za-z0-9._:-]{8,200}` without trimming, normalization, or case folding. Campaign-template create, graph update, trigger update, and publish also require it and use server-owned organization-accounted scopes with `campaign_id=null`. Those four scopes, `proposal.ppt.generate.unlinked.admission`, and internal `parser.knowledge-upload.admission|parser.influencer-upload.admission|parser.demand-parse.admission` are the only null-campaign ledger rows; parser keys are server-random and never public. The browser creates one key per captured mutation intent and reuses it after timeout, lost response, or in-progress status; it rotates only after a terminal response or canonical payload change. Every new reservation stores a random 32-byte nonce plus immutable server-derived **successful outcome** event count: cross-campaign correction is 2; always-event mutations, same-campaign/revoke correction, collaboration alias addition, and collaboration cancellation are 1; non-event mutations and plain collaboration data edits are 0. A replayable terminal `4xx|5xx` always has zero events. Permanent events store the deletion-safe `tm-audit-v2` fingerprint defined in the design, validated only while the matching ledger is processing with an exact unexpired tokenized lease and operation deadline. Successful completion requires exact expected cardinality; error completion requires zero. Failed/completed/expiring/deadline-expired rows cannot authorize event insertion.
- Campaign-create ordering: before ledger lookup the route authorizes submitted organization, opportunity/customer manage access, owner, and team assignment without a campaign row. One `BEGIN IMMEDIATE` transaction repeats those predicates and checks `(org,user,scope,key)`/hash. A miss inserts campaign, campaign-bound processing ledger, creation event, and completed JSON ledger in that order. A retained row first yields its stored campaign only internally, then current campaign/target access is reauthorized before replay, mismatch, in-progress, or expiry; revoked access cannot expose the old body, hash decision, or campaign ID. Its request hash uses an empty campaign-ID frame. A duplicate key cannot insert a second campaign, and rollback removes all effects. Every other campaign-bound route reserves the already-derived ID before work.
- Request hashing: exact `tm-request-v1` SHA-256 input is six four-byte big-endian length frames: version literal, uppercase method, canonical RFC-3986 path, canonical decimal campaign ID or empty, payload kind, and payload bytes. JSON kind is `json` with the design's recursively canonical UTF-8 JSON. Empty kind is `empty` with zero bytes. Multipart kind is `multipart` with ordered framed canonical text fields and per-file field name, normalized basename, normalized MIME, byte length, and raw SHA-256; raw file bytes and raw filename are never stored. The design's JSON, empty-body, and multipart golden vectors are normative on Windows and Linux; changed bytes conflict under one key.
- IDs: positive canonical decimal JavaScript-safe integers only. Values such as `07`, `+7`, `7.0`, and values over `9007199254740991` are rejected.
- Pagination: `limit` defaults to 25 and is 1-100; `offset` defaults to 0 and is non-negative.
- Unknown mutation fields are rejected. Strings are trimmed. Empty required strings are invalid.
- Audit source: public bodies never accept `source`; the server maps each authenticated route/action to an immutable source constant before hashing. A submitted `source` is an unknown-field `400`.
- Concealment: missing/cross-organization campaign is `404 CAMPAIGN_NOT_FOUND`; an existing same-organization campaign without required access is `403 CAMPAIGN_FORBIDDEN`; after campaign authorization, a syntactically valid missing or non-visible target is concealed as `404 RECORD_NOT_FOUND` (knowledge uses `KNOWLEDGE_ENTRY_NOT_FOUND`), while a visible target lacking manage permission is `403 RECORD_FORBIDDEN`. Only malformed link fields/ID/relation mapping are `400 INVALID_CAMPAIGN_LINK`. Collections apply the same per-resource predicate before counts and pagination.
- Replay authorization: every ledger lookup occurs only after current user, organization, campaign, and target authorization; a final write transaction repeats those predicates. Revoked access never replays a previously stored body.
- Provenance: after the first historical non-shortlist link, a target remains campaign-classified even after revoke-only. Active destination custody wins after a move; otherwise the source campaign of the greatest `(revoked_at,id)` aggregate bundle remains custody. Direct/list/search/use/dedup/RAG access requires legacy target visibility plus custody campaign access even when `campaign_id` is omitted. Generic attach of a historically classified target returns `409 RECORD_REQUIRES_LINK_CORRECTION`; only authorized correction may reactivate/move the full bundle. Shortlist is the shared-library exception.
- Operational status: productive finalization against `on_hold` is exact `409 CAMPAIGN_ON_HOLD {operational_status:"on_hold"}`; terminal cancellation is `409 CAMPAIGN_CANCELLED {operational_status:"cancelled"}`. After authorization, workflow task/control decisions check `cancelled`, then `on_hold`, then endpoint-specific stale state only while active. Exact recovery/read exceptions and replay behavior follow the design.
- Non-PPT admission: at most 8 processing requests per user and 64 per organization; at most 200 starts per user/hour and 2,000 per organization/hour; retained ledgers are capped at 5,000 per user, 500 per `(user,scope)`, and 50,000 per organization. Completed JSON is additionally capped at 32 MiB per `(user,scope)`, 128 MiB per user, and 1 GiB per organization. Exceeding rate/concurrency returns `429 IDEMPOTENCY_RATE_LIMITED`; exceeding count/byte capacity returns `507 IDEMPOTENCY_STORAGE_CAPACITY_EXCEEDED`. Failed rows expire after 24 hours and completed JSON rows after 30 days.
- Idempotency expiry/reuse: immutable `operation_deadline` governs work/reclaim; mutable terminal `expires_at` governs retention. Same-hash processing/failed reclaim is legal only before the operation deadline. Both processing and retained internal-failed rows have explicit database-legal deadline transitions to zero-event completed JSON `503` with 30-day retention. Failed/admission retention is 24 hours; completed JSON/binary retention is 30 days. At retention expiry completed JSON and failed rows are conditionally deleted before a new reservation with a new nonce; only an expired completed binary may become `expiring`, preserving every artifact/status/header field byte-for-byte, and every hash then receives `410 IDEMPOTENCY_EXPIRED` until fsynced artifact cleanup deletes the row. Admission rows are deleted at expiry. A physically absent key is reusable and can never recreate an old event fingerprint because the nonce changes.
- Knowledge capacity: source dedup/replay runs before capacity. Exact user/campaign/organization caps are respectively `50,000/500,000/5 GiB/2,000,000`, `100,000/1,000,000/10 GiB/4,000,000`, and `500,000/5,000,000/50 GiB/20,000,000` for entries/chunks/payload/references. Payload is the design's exact UTF-8 BLOB-length sum over entry `title,summary,content,key_terms,tags_json,metadata_json,embedding_json` plus chunk `content,metadata_json,embedding_json`, deliberately counting stored entry content and chunks separately. A truly unclassified `created_by=NULL` legacy entry has no user bucket and is charged to the immutable `turingmarket-default` organization until campaign custody is established; every other attribution and destination-move rule follows the design. Exceeding any projected value returns `507 KNOWLEDGE_STORAGE_CAPACITY_EXCEEDED` with no producer, archive, reference, usage, link, or custody mutation.
- Deadlines: parser admission reserves before body with a 90-second total deadline; authenticated upload body is capped at 60 seconds and isolated parsing at 20 seconds/512 MiB. One AI provider attempt is 120 seconds; PPT render/validation/promotion is 180 seconds; every other file/provider operation is 60 seconds; an unscoped response stream is capped at ten minutes. Lease renewal cannot pass the immutable operation deadline; abort/deadline/shutdown kills the provider/cgroup and cleans attempt-owned files before terminal ledger handling.

Success envelopes are resource-specific and stable. Errors use:

```json
{
  "error": "活动状态已更新，请刷新后重试",
  "code": "STALE_CAMPAIGN_STATE",
  "request_id": "01J...",
  "details": {
    "current_state": "proposal_draft"
  }
}
```

Identity changes are transactional with authorization state. `POST /api/admin/users` and `POST /api/auth/register` keep their existing password-policy/response shapes but create active default organization/team memberships before commit. `PUT /api/admin/users/:id` synchronizes promotion, demotion, department transfer, and active/revoked memberships; promotion sets active team roles to `team_lead`, demotion resets every active team role to `member`. Soft-delete `DELETE /api/admin/users/:id` sets inactive, revokes all memberships, and deletes every target session in the same transaction. Every role/department/active mutation invalidates target sessions; failure rolls back the user row. Each changed projection appends one immutable `activity_log` row with `action='identity_state_changed'`, `module='identity'`, and the design's exact nine-key canonical before/after schema; no-op updates append none. Migration emits one deterministic backfill row per user, and every activity row is database append-only. `GET /api/users` becomes platform-admin only and returns its existing bounded field set; non-platform admins receive `403`. Successful login and `/api/auth/me` preserve the existing `user` object and append the exact `auth_context` shape above. Privileged AI list/detail reads must first persist sanitized audit evidence or return `500 AUDIT_PERSISTENCE_FAILED` without conversation data.

## Resource Shapes / 资源结构

### Campaign

```json
{
  "id": 42,
  "name": "Bluetti Summer Creator Launch",
  "customer": { "id": 8, "label": "Bluetti" },
  "opportunity": { "id": 19, "label": "Summer launch" },
  "owner": { "id": 3, "label": "Derrick" },
  "team": { "id": 2, "label": "Global sales" },
  "lifecycle_state": "lead",
  "operational_status": "active",
  "row_version": 1,
  "product_name": "AC200L",
  "region": "North America",
  "currency": "USD",
  "budget_minor": 2500000,
  "start_date": "2026-08-01",
  "end_date": "2026-09-30",
  "created_at": "2026-07-14 12:00:00",
  "updated_at": "2026-07-14 12:00:00"
}
```

For an authorized campaign reader, `customer` and `opportunity` always contain only bounded `{id,label}` business-spine summaries, even when current CRM detail access was later lost. Their sanitized deterministic fallbacks are `Customer #<id>` and `Opportunity #<id>`. These labels do not grant CRM detail/edit/contact/activity/financial access. Phase 4 returns no record-specific CRM route in any label, row, card, option, or summary. Only the create dialog's `no_eligible_opportunity` empty state may offer one generic command to `/m0-detail?view=opportunities`; record detail navigation is deferred to Phase 5. `row_version` is a safe integer `1..9007199254740991`; a mutation at the maximum returns `409 ROW_VERSION_EXHAUSTED` without side effect.

### Workspace Link

`WorkspaceLink` is an exact discriminated union. Extra keys are forbidden and key order is stable:

```json
{ "link_id":91, "relation_type":"proposal", "record_type":"proposal", "record_id":"17", "access_state":"available", "label":"Bluetti launch proposal v2", "route":"/m3?campaign=42&step=proposal&record=17", "created_at":"2026-07-14 12:10:00", "revoked_at":null }
```

```json
{ "relation_type":"proposal", "access_state":"restricted", "restricted_count":2 }
```

```json
{ "link_id":91, "relation_type":"proposal", "access_state":"missing", "created_at":"2026-07-14 12:10:00", "revoked_at":"2026-07-15 09:00:00" }
```

Available `record_id` is a canonical decimal string. Restricted aggregates never expose link/record/campaign IDs, timestamps, label, route, metadata, owner, or content. Missing traces never expose record type/ID, label, route, metadata, owner, or content. `active_links[relation]` contains available rows followed by at most one restricted aggregate and no missing row. History contains available revoked and missing traces sorted by `(created_at,link_id)`, then at most one restricted aggregate per relation. Available knowledge links route to `/campaigns?campaign=<id>&panel=knowledge&entry=<record_id>`, not the administrator-only `/kb` surface.

### Event Summary

```json
{
  "id": 120,
  "event_type": "lifecycle_transition",
  "previous_state": "qualified",
  "next_state": "demand_confirmed",
  "actor": { "id": 3, "label": "Derrick" },
  "reason": "Client approved the signed brief",
  "source": "project_workspace",
  "metadata": { "previous_version": 2, "next_version": 3 },
  "correlation_id": "01J...",
  "created_at": "2026-07-14 12:15:00"
}
```

`metadata` is never an open object. Its full exact event-type variants are: `campaign_created {customer_id,opportunity_id,owner_user_id,team_id,row_version}`; `lifecycle_transition {previous_version,next_version}`; `operational_status_changed {previous_status,next_status,previous_version,next_version}`; `campaign_transferred {previous_owner_user_id,next_owner_user_id,previous_team_id,next_team_id,previous_version,next_version}`; `link_attached {bundle_id,relation_types,record_type,record_id,link_ids}`; `link_revoked {bundle_id,relation_types,record_type,record_id,revoked_link_ids}`; `link_moved {source_bundle_id,destination_bundle_id,relation_types,record_type,record_id,source_campaign_id,destination_campaign_id,revoked_link_ids,replacement_link_ids}`; and `workflow_reconciliation {original_dispatch_id,replacement_dispatch_id,template_id,template_version}`. IDs and versions are positive safe integers except canonical decimal `record_id`; bundle IDs are lowercase SHA-shaped 64-hex identifiers; relation and ID arrays are sorted and unique. Unknown, missing, extra, or source-incompatible metadata keys are an internal serialization failure.

A link variant is emitted in full only when the target is currently visible and the caller can read every referenced/implied campaign. Otherwise metadata is exactly `{ "access_state":"restricted" }` or `{ "access_state":"missing" }`, with no link/record/bundle/campaign/dispatch/template/replacement identifier. Reciprocal move summaries redact together when either campaign is inaccessible. Stored evidence remains immutable; only response serialization is redacted.

### Workflow Dispatch Summary

```json
{
  "id": 71,
  "event_id": 120,
  "trigger_event_id": 120,
  "template": { "id": 9, "label": "Campaign handoff", "version": 4 },
  "status": "pending",
  "attempt_count": 0,
  "workflow_instance_id": null,
  "instance": null,
  "reconciles_dispatch_id": null,
  "next_attempt_at": null,
  "error": null,
  "created_at": "2026-07-14 12:15:00",
  "updated_at": "2026-07-14 12:15:00"
}
```

`instance`, when present, is exactly `{ "id": 12, "status": "active|paused|completed|cancelled|failed_validation", "initialization_status": "ready", "error": null }`; a terminal execution error uses the same sanitized error shape as the dispatch. `error`, when present, is exactly `{ "code": "SANITIZED_CODE", "message": "sanitized message" }`. Snapshot JSON, checksums, lease values/tokens, private cache keys, and raw provider errors are never returned.

## Campaign Endpoints / 活动接口

### `GET /api/campaigns/options`

Required queries are `mode=create|transfer` and `resource=opportunities|assignments`. Optional `q` is at most 160 characters; `limit` defaults to 25 and is 1-50; `offset` defaults to 0. `campaign_id` is required for transfer. `mode=transfer&resource=opportunities` is rejected with `400 INVALID_CAMPAIGN_INPUT`. The endpoint never returns a global user directory and returns one bounded resource per request.

Opportunity response:

```json
{
  "resource": "opportunities",
  "items": [{ "id": 19, "label": "Bluetti / Summer launch", "customer_id": 8 }],
  "total": 1,
  "limit": 25,
  "offset": 0
}
```

Assignment response uses the same envelope and each item is exactly `{ "team": { "id", "label" }, "owner": { "id", "label" } }`. For create, an org admin receives all active organization-member/team pairs; a team lead receives members of teams they lead; an ordinary member receives only self-owned pairs for teams they belong to. For transfer, an org admin receives all legal pairs; the current owner receives only destination teams in which that current owner is an active member and destination owners who are active members of that team. Same-org non-owner/non-admin receives `403`. Opportunity options require existing CRM manage permission; public-pool visibility alone is insufficient.

### `POST /api/campaigns`

Required body: `name`, `opportunity_id`, `owner_user_id`, `team_id`. Optional: `product_name`, `region`, `currency`, `budget_minor`, `start_date`, `end_date`. `customer_id`, lifecycle, operational status, org, timestamps, and IDs are server-owned.

Assignment authorization is recomputed in the insert transaction: org admin may use any legal pair; team lead may assign members of a team they lead; ordinary member may create only a self-owned campaign in a team they belong to. Opportunity/customer must pass existing CRM manage access.

Returns `201 { "campaign": Campaign }`. Validation `400`; inaccessible opportunity/owner/team `403` or concealed `404`; idempotency conflict/in-progress `409`.

### `GET /api/campaigns`

Queries: `q` (max 160), `state`, `operational_status`, `owner_user_id`, `team_id`, `limit`, `offset`. Results are permission-filtered before total calculation.

```json
{ "items": [], "total": 0, "limit": 25, "offset": 0 }
```

### `GET /api/campaigns/:id`

Returns `200 { "campaign": Campaign }`; same-org nonmember `403`; cross-org/not found `404`.

### `PATCH /api/campaigns/:id`

Allowed metadata only: `name`, `product_name`, `region`, `currency`, `budget_minor`, `start_date`, `end_date`, plus required integer `expected_version`. Returns `200 { "campaign": Campaign }`; stale version `409 STALE_CAMPAIGN_VERSION` with the current version.

### `POST /api/campaigns/:id/transitions`

```json
{
  "expected_state": "qualified",
  "expected_version": 4,
  "next_state": "demand_confirmed",
  "reason": "Client approved the signed brief"
}
```

Returns exactly `200 { "campaign": Campaign, "event": EventSummary, "dispatches": WorkflowDispatchSummary[] }`. Missing required relation `409 CAMPAIGN_GUARD_NOT_MET`; stale state `409 STALE_CAMPAIGN_STATE`; invalid adjacency `409 INVALID_CAMPAIGN_TRANSITION`.

Guards are cumulative for every state at or before the requested next state: `demand_confirmed:demand`, `proposal_draft/proposal_confirmed:proposal`, `influencer_shortlist:shortlist`, `ordered:order`, `executing:execution`, `published:publication`, `settled:publication+settlement`, and `reviewed:knowledge+review`. Collaboration-backed aliases must also satisfy current non-cancelled status/cost predicates. `publication` is trusted and completed; `settlement` requires completed plus explicitly confirmed cost; `review` must be created after the settled event and pair to the same entry's active knowledge link. Missing details expose only sorted relation codes. A correction cannot remove evidence required by the campaign's cumulative current-state guards.

### `POST /api/campaigns/:id/operational-actions`

Body: `action` (`hold|resume|cancel`), `expected_status`, `expected_version`, and `reason`. Cancel is one atomic cascade: every distinct linked collaboration still in `confirmed|contract_sent|live|content_review` becomes `cancelled`, increments row version once, and loses its complete active alias bundle; nonterminal workflow dispatches, active/paused instances, and pending tasks become cancelled with fenced workers. Completed collaboration and terminal workflow evidence remain immutable. Any maximum collaboration version or cascade mismatch rolls the entire request back. Returns exactly `200 { "campaign": Campaign, "event": EventSummary }`. Invalid status change `409 INVALID_OPERATIONAL_TRANSITION`.

### `POST /api/campaigns/:id/transfers`

Body: `owner_user_id`, `team_id`, `expected_version`, and `reason`. Org admin may use any legal active organization pair. Current owner may use only a destination team in which that current owner is active; destination owner must be active in that team. The transaction recomputes the same rule as options. Returns exactly `200 { "campaign": Campaign, "event": EventSummary }`.

### `POST /api/campaigns/:id/links`

```json
{
  "relation_type": "demand",
  "record_type": "demand",
  "record_id": "31",
  "metadata": {},
  "reason": "Attach the approved brief"
}
```

`reason` is required, 1-1000 NFC/LF characters, and is included in `tm-request-v1`. Public metadata is exact `{}` in Phase 4; trusted relation metadata is server-owned.

Returns exactly `201 { "link": WorkspaceLink, "event": EventSummary }`. Unknown fields, noncanonical IDs, or relation/record mapping failure are `400 INVALID_CAMPAIGN_LINK`; a syntactically valid missing/non-visible target is concealed `404 RECORD_NOT_FOUND` (knowledge uses `KNOWLEDGE_ENTRY_NOT_FOUND`); a visible non-manageable target is `403 RECORD_FORBIDDEN`; active ownership conflict is `409 RECORD_ALREADY_LINKED`; any target with historical non-shortlist classification is `409 RECORD_REQUIRES_LINK_CORRECTION`.

Public callers cannot create `ppt`, `order`, `execution`, `publication`, `settlement`, `review`, or `workflow` relations. Those are trusted outputs of successful campaign PPT generation, guarded collaboration create/update, post-settlement review, and durable lifecycle workflow dispatch respectively. Existing/historically classified collaboration attachment also goes through the guarded update/correction contract.

### `POST /api/campaigns/:id/link-corrections`

Body: `link_id`, optional `target_campaign_id` (omit to revoke only), and `reason`. Current campaign owner or org admin only; both campaigns and target are reauthorized in the transaction. The selected link resolves one exact immutable historical `bundle_id`; aliases from another bundle are never swept in. Shortlist changes one reference. A non-shortlist correction atomically revokes that complete bundle and optionally recreates the same aliases under one new bundle, so proposal `proposal/ppt` and collaboration `order/execution/publication/settlement` aliases never split across campaigns. Review `knowledge/review` evidence is origin-campaign-bound: any cross-campaign correction returns zero-mutation `409 CAMPAIGN_EVIDENCE_IN_USE`; only revoke-without-replacement and same-campaign reactivation of the fully revoked exact pair are legal. Revoke-only preserves immutable source-campaign custody; same-campaign reactivation allocates a new bundle and emits `source_event=link_attached,destination_event=null`. Other legal cross-campaign corrections bind source in the request ledger's primary campaign and destination in `secondary_campaign_id`, then commit exactly two reciprocal `link_moved` events carrying the same campaign/bundle IDs; any missing or third event aborts completion. A relation required by the source campaign's cumulative current-state guards or invalid for the destination's cumulative guards returns `409 CAMPAIGN_EVIDENCE_IN_USE` with zero mutation. Workflow links are trusted immutable dispatch evidence and are not publicly correctable. Returns exactly `200 { "revoked_links": WorkspaceLink[], "replacement_links": WorkspaceLink[], "source_event": EventSummary, "destination_event": EventSummary|null }`.

### `GET /api/campaigns/:id/link-candidates`

Queries: required `relation_type`; optional `q` max 160, `limit` 1-50, `offset`. Returns only targets already visible under their original rule and, for non-shortlist relations, with no historical campaign classification; revoke-only/history reactivation is performed from workspace history through correction, not generic candidates:

```json
{ "items": [{ "record_type": "demand", "record_id": "31", "label": "Bluetti brief" }], "total": 1, "limit": 25, "offset": 0 }
```

For `relation_type=order`, the response is campaign-only and exact: `{ "items": [{ "id": 73, "title": "Creator partnership", "status": "confirmed", "row_version": 4, "adoption_allowed": true }], "total": 1, "limit": 25, "offset": 0 }`. It includes only collaborations the caller may both see and adopt; `row_version` is never added to an unlinked legacy serializer.

### `GET /api/campaigns/:id/workspace`

Returns exactly `{ "campaign": Campaign, "active_links": { "demand": WorkspaceLink[], "proposal": WorkspaceLink[], "ppt": WorkspaceLink[], "shortlist": WorkspaceLink[], "order": WorkspaceLink[], "execution": WorkspaceLink[], "publication": WorkspaceLink[], "settlement": WorkspaceLink[], "workflow": WorkspaceLink[], "ai_run": WorkspaceLink[], "knowledge": WorkspaceLink[], "review": WorkspaceLink[] }, "link_history": WorkspaceLink[], "events": EventSummary[], "workflow_dispatches": WorkflowDispatchSummary[] }`. Restricted/missing rows use the tagged redaction contract above. The `knowledge` panel is available to ordinary campaign readers/writers and supports permission-filtered search, open, create/upload/ingest, attach/correct, use, and “use in AI”; it never requires the administrator-only `/kb` route.

### `GET /api/campaigns/:id/knowledge`

Ordinary campaign readers may query only optional `q` (0-200), `source_type`, `entry_type`, `visibility=private|team`, `tag`, `linked=all|true|false` (default `all`), `limit=1..100` (default 20), and `offset>=0`. Candidates are exactly truly never-classified entries visible under the legacy rule plus entries whose current custody is this campaign. `linked=true` keeps campaign custody and `false` keeps truly unlinked entries. Authorization and all filters run before total, FTS rank, and pagination. Non-empty search sorts by rank then `updated_at DESC,id DESC`; empty search sorts by `updated_at DESC,id DESC`. Success is exact `{ "items":[{ "id":88,"title":"...","summary":"...","tags":[],"entry_type":"...","source_type":"...","visibility":"private|team","usage_count":1,"citation_count":2,"updated_at":"...","link_state":"linked|available" }],"total":1,"limit":20,"offset":0 }`.

### `GET /api/campaigns/:id/knowledge/:entryId`

Applies the same authorized union and concealed `404 KNOWLEDGE_ENTRY_NOT_FOUND`. Success is exact `{ "entry":{ "id":88,"title":"...","summary":"...","content":"...","tags":[],"entry_type":"...","source_type":"...","visibility":"private|team","source":{ "kind":"upload|ai_chat|demand|proposal|ppt|collaboration|workflow|review|manual|other","label":"Uploaded knowledge" },"created_at":"...","updated_at":"...","link_state":"linked|available" },"usage_count":1,"citation_count":2,"can_manage":true,"can_use_in_ai":true }`. `source.label` is server-owned and bounded; ordinary endpoints never expose raw source IDs, filenames, paths, URLs, provider payloads, cache keys, or artifacts. Capability flags are recomputed from current legacy target rights plus campaign access. Unknown queries fail `400 INVALID_CAMPAIGN_INPUT`; reads never increment usage or attach an entry.

### `POST /api/campaigns/:id/reviews`

Owner/team writer or organization administrator only. It requires `Idempotency-Key`, scope `campaign.review.create`, active campaign exactly at `settled`, and body exactly `{ "expected_version": 12, "title": "Campaign review", "summary": "...", "content": "...", "tags": ["creator","summer"], "visibility": "private|team", "reason": "Review approved" }`. Title is 1-200, summary 1-1000, content 1-50000, reason 1-1000 NFC/LF characters; tags are a unique UTF-8-sorted array of at most 20 values of 1-80 characters. The server derives the settled event before ledger lookup. One `BEGIN IMMEDIATE` transaction reauthorizes, matches row version/state/status, and proves there is no historical entry/pair for that exact `(campaign_id,settled_event_id)` before creating one dedicated `entry_type='campaign_review'` knowledge entry with unique server-owned `campaign_review,<campaign_id>:<settled_event_id>` identity, paired `knowledge` and `review` links, one aggregate event, one campaign-version increment, and replay completion. It returns exactly `201 { "campaign": Campaign, "entry": { "id":88,"title":"Campaign review","summary":"...","tags":["creator","summer"],"visibility":"team" }, "links": [WorkspaceLink,WorkspaceLink], "event": EventSummary }`, with links sorted `knowledge,review`. An existing active pair is zero-mutation `409 RECORD_ALREADY_LINKED`; a fully revoked pair is zero-mutation `409 RECORD_REQUIRES_LINK_CORRECTION`; partial, mismatched, or cross-campaign evidence is `409 CAMPAIGN_EVIDENCE_IN_USE`. No knowledge/link/event/campaign change survives any failure.

### `GET /api/campaigns/:id/workflow-reconciliation-options`

This read plus campaign workflow retry, reconcile, and task-reassign mutations are mounted by `routes_campaigns.js` and delegated to `campaign_workflow_service.js`; `campaign_service.js` does not own their state decisions or transactions.

Query requires canonical `dispatch_id`. Owner or organization administrator only. It returns one exact `state`-tagged object with no optional union keys: `eligible {state,dispatch,required,templates}`; `no_matching_template {state,dispatch,required,templates:[]}`; `campaign_not_active {state,dispatch,operational_status}`; `dispatch_not_reconcilable {state,dispatch,dispatch_status,instance_status}`; or `already_reconciled {state,dispatch,replacement_dispatch_id}`. `required` is exactly `{ "failure_shape":"pre_initialization|post_initialization", "expected_dispatch_status":"failed_validation|completed", "expected_instance_status":null|"failed_validation" }`. Template items are exactly `{ "id":9,"label":"Campaign handoff repaired","version":6,"published_checksum":"<lowercase sha256>","trigger":{"event_type":"lifecycle_transition","previous_state":"qualified","next_state":"demand_confirmed"} }`, sorted by `(label,id)`, and include only active published checksum-valid exact-root-trigger matches. Decision precedence is exact: authorization/concealment, `campaign_not_active` for cancelled then on-hold, `already_reconciled` only while active, legal failure shape, then matching templates. Lower-precedence branches do not compute or expose their fields.

### `POST /api/campaigns/:id/workflow-dispatches/:dispatchId/retry`

Body requires `expected_status` and `reason` (1-1000). Owner or org admin only. `failed_initialization` and `dead_letter` are retryable against the immutable stored template snapshot; `failed_validation` is terminal and is not retryable. The server stores source `workflow_recovery`; the mutation writes actor/reason/prior attempts to `activity_log`, resets the automatic-attempt counter, and completes its idempotency response in the same transaction. Returns exactly `202 { "dispatch": WorkflowDispatchSummary }`; stale or completed dispatch `409 DISPATCH_NOT_RETRYABLE`.

### `POST /api/campaigns/:id/workflow-dispatches/:dispatchId/reconcile`

Owner or org admin only. A pre-initialization failure body is exactly `{ "expected_dispatch_status": "failed_validation", "expected_instance_status": null, "template_id": 9, "expected_template_version": 6, "reason": "Published repaired graph" }`; a post-initialization execution failure body is exactly `{ "expected_dispatch_status": "completed", "expected_instance_status": "failed_validation", "template_id": 9, "expected_template_version": 6, "reason": "Published repaired graph" }`. The selected campaign template must be active/published, checksum-valid, and its trigger must match the immutable root `trigger_event_id`. After current authorization, same-key ledger replay/conflict is first. On a miss, one `BEGIN IMMEDIATE` transaction repeats authorization and exact winner order: cancelled, on-hold, existing replacement, legal failure shape, then template/version/checksum; it preallocates a positive safe unused dispatch ID from `MAX(id)+1`, appends the event containing that ID, inserts the replacement with the same explicit ID, and creates required archive `campaign_workflow_reconciliation,<reconciliation_event_id>` with exact `{original_dispatch_id,replacement_dispatch_id,template_id,template_version}` plus chunks/knowledge link before completing the ledger. Event, dispatch, archive/link, and replay commit together; pre-initialization reconciliation never fabricates an instance-backed node log, and overflow/collision/archive failure aborts all evidence. The database repeats parent failure-shape, organization/campaign/root-event, reconciliation metadata, and event source/reason checks. Returns exactly `202 { "failed_dispatch": WorkflowDispatchSummary, "replacement_dispatch": WorkflowDispatchSummary, "event": EventSummary }`. Stale state `409 DISPATCH_NOT_RECONCILABLE`; template mismatch `409 INVALID_CAMPAIGN_WORKFLOW_TEMPLATE`; same key/hash replays the original success even after replacement exists, while only a different-key loser returns `409 DISPATCH_ALREADY_RECONCILED` with exact `{ "replacement_dispatch_id":72 }` and creates no event/archive.

## Workflow Template Trigger Administration / 工作流触发配置

Existing non-campaign template list/detail response fields remain unchanged. Campaign-template authoring is platform-admin-only, exactly an active legacy `users.role='admin'`; an organization administrator without that platform role cannot list private trigger configuration, create, edit, publish, or delete a campaign template. Creation through `POST /api/workflow/templates` when `module='campaign'` requires `Idempotency-Key`, uses scope `workflow.campaign-template.create`, and returns the existing exact `200 { "id": 9 }`, but always stores version 1 inactive. Same key/body replays the same ID; changed body conflicts. Existing campaign templates cannot change module; existing non-campaign templates cannot convert through PUT.

Campaign trigger configuration uses Bearer-authenticated platform-admin-only `GET|PUT /api/workflow/templates/:id/campaign-trigger`:

```json
{
  "template_id": 9,
  "version": 4,
  "is_active": false,
  "trigger": {
    "event_type": "lifecycle_transition",
    "previous_state": "qualified",
    "next_state": "demand_confirmed"
  }
}
```

GET returns that exact shape. PUT requires `Idempotency-Key`, scope `workflow.campaign-template.trigger`, and body `{ "expected_version": 4, "event_type": "lifecycle_transition", "previous_state": "qualified", "next_state": "demand_confirmed" }`; no other fields/wildcards are accepted. It conditionally increments version once, stores the trigger, sets inactive, and returns the same shape with version 5. Campaign graph updates through existing `PUT /api/workflow/templates/:id` likewise require admin, `Idempotency-Key`, scope `workflow.campaign-template.graph`, and exact `expected_version`, keep `module='campaign'`, increment once, set inactive, and return exact `200 { "success": true, "version": 5, "is_active": false }`. Both replay exact success for the same key/hash.

Campaign publish uses existing `POST /api/workflow/templates/:id/publish` with required `Idempotency-Key`, scope `workflow.campaign-template.publish`, and body `{ "expected_version": 5 }`. It conditionally validates the design's closed node/config/edge/condition schemas and action-specific branch invariants, rejects unsupported or ambiguous graphs, and returns exact `200 { "success": true, "version": 5, "is_active": true, "published_checksum": "<lowercase sha256>" }`. The checksum uses the versioned canonical `tm-workflow-snapshot-v1` serializer and real approval/condition golden vector in the design. Stale version returns `409 STALE_WORKFLOW_TEMPLATE_VERSION`; invalid graph/trigger returns `409 INVALID_CAMPAIGN_WORKFLOW_TEMPLATE` with safe reason codes and no mutation; module changes return `409 CAMPAIGN_TEMPLATE_MODULE_IMMUTABLE|CAMPAIGN_TEMPLATE_CREATE_REQUIRED`; non-campaign target returns `409 CAMPAIGN_TEMPLATE_REQUIRED`; missing is `404 WORKFLOW_TEMPLATE_NOT_FOUND`. Each dispatch stores the published canonical snapshot and checksum, and every later campaign task advance reads that pinned snapshot rather than mutable template rows.

Existing `DELETE /api/workflow/templates/:id` keeps its legacy success contract for an unreferenced template. Any template referenced by a campaign dispatch or workflow instance returns `409 WORKFLOW_TEMPLATE_HAS_DEPENDENCIES` with no delete or partial mutation.

### Campaign-linked workflow task actions

For `GET /api/workflow/tasks`, `GET /api/workflow/tasks/:id`, and the `tasks` array inside `GET /api/workflow/instances/:id`, every campaign-linked task projection appends exact positive-safe integer `assignment_version` to its existing task keys. Mixed lists omit that key on unlinked legacy rows, whose response shapes remain byte-for-byte unchanged. The campaign workflow trace consumes the same projection, so a reload always supplies the concurrency token required by action/reassignment bodies; after `STALE_WORKFLOW_TASK_ACTION`, the client refetches the task/trace before enabling another mutation.

Existing `POST /api/workflow/tasks/:id/approve`, `/reject`, and `/complete` remain unchanged for unlinked legacy instances: no idempotency requirement and exact legacy `200 { "success": true }`. For a campaign-linked instance, all three require `Idempotency-Key`; scopes are respectively `workflow.campaign-task.approve`, `workflow.campaign-task.reject`, and `workflow.campaign-task.complete`. Body is exactly `{ "expected_status": "pending", "expected_assignment_version": 1, "comment": "..." }`, where comment defaults to empty and is at most 2000 characters; campaign ID is server-derived and included in `tm-request-v1`. Approve/reject require a pinned `approval` node and complete requires `task`, otherwise `409 WORKFLOW_TASK_ACTION_NOT_ALLOWED`. Authorization requires campaign write and every non-null effective task assignee predicate. Role predicates are independent: active legacy admin for `platform_admin`; active organization role `org_admin` for `org_admin`; active campaign-team membership with exact role `team_lead` for `team_lead`; and any active campaign-team membership for `member`. Both ID and role pass when both exist. Audit visibility never bypasses mutation assignment, and campaign publish/assignment storage rejects both-null.

One `BEGIN IMMEDIATE` transaction re-fetches and conditionally matches active user, current organization/team membership, current campaign write access and `operational_status='active'`, exact task `assignment_version`, every effective assignee predicate, `task.status='pending'`, `instance.status='active'`, reciprocal dispatch/root-event lineage, and pinned checksum; updates task; writes the action log and campaign-linked knowledge archive; follows the exact `approve|reject|complete` outcome edge; advances the pinned snapshot; creates next tasks/logs with `assignment_version=1` and a nonempty eligible actor set or terminal state; and completes the request ledger. Success is exactly `200 { "success": true, "task_id": 7, "task_status": "completed", "workflow_instance_id": 12, "instance_status": "active", "current_node_id": "next-node", "created_task_ids": [8] }`, with IDs sorted; reject uses task status `rejected`, and a completed instance uses `instance_status:"completed"` plus `current_node_id:null`. Same key/hash replays only after current authorization; changed hash is `409 IDEMPOTENCY_KEY_REUSED`. After authorization, cancellation returns `409 CAMPAIGN_CANCELLED`, hold returns `409 CAMPAIGN_ON_HOLD`, and only an active campaign with a transfer/reassignment/demotion/deactivation/revocation/pause/other action winner returns `409 STALE_WORKFLOW_TASK_ACTION` with exact safe `details { "task_status", "instance_status", "campaign_operational_status":"active" }`; missing is concealed `404`; authorization is `403`. A missing/invalid pinned route or a next-task assignment whose eligible set became empty rolls back the entire action transaction. The latter records exact sanitized execution code `WORKFLOW_ASSIGNMENT_UNRESOLVABLE`; then the separate guarded failure transaction repeats the same precedence before moving only the still-active instance to terminal `failed_validation`, cancelling every pending task, writing its failure node/activity log plus required campaign workflow archive, and atomically completing exact `409 INVALID_CAMPAIGN_WORKFLOW_TEMPLATE`. The completed dispatch remains reconcilable evidence through the post-initialization failure shape.

### `POST /api/campaigns/:id/workflow-tasks/:taskId/reassign`

Owner or organization administrator only. Requires `Idempotency-Key`, scope `workflow.campaign-task.reassign`, and exact body `{ "expected_task_status":"pending", "expected_instance_status":"active", "expected_assignment_version":1, "assignee_id":8|null, "assignee_role":"platform_admin|org_admin|team_lead|member"|null, "reason":"..." }`; reason is 1-1000 NFC/LF characters and at least one assignee field is non-null. The target ID must be an active user with active organization membership and campaign write access; a role must currently resolve a nonempty eligible set; both fields require a nonempty intersection. Malformed input is `400 INVALID_CAMPAIGN_INPUT`; a missing/concealed target is `404 RECORD_NOT_FOUND`; a visible ineligible target is `403 RECORD_FORBIDDEN` before reservation.

After current authorization, same-key/hash terminal replay is handled before new-state evaluation. On a miss, one `BEGIN IMMEDIATE` transaction repeats caller and target authorization with precedence `CAMPAIGN_CANCELLED`, `CAMPAIGN_ON_HOLD`, stale task/instance/assignment/completion, then target identity/membership eligibility, then exact current/requested assignment equality. A completion, prior reassignment, deactivation, transfer, membership revocation, or newly empty role set after reservation completes zero-mutation `409 STALE_WORKFLOW_TASK_ACTION`. If both requested assignment fields are identical to the current tuple, the ledger completes zero-event `400 INVALID_CAMPAIGN_INPUT` with no task/version/log/archive mutation; the database no-change trigger is therefore never reached, and the same key replays that 400 after current authorization. Otherwise success updates only task `assignee_id|assignee_role`, increments the safe `assignment_version`, appends exact `task_reassigned` node/activity logs, creates the required instance-backed workflow archive/link, and completes a zero-event replay atomically. Maximum version is `409 ROW_VERSION_EXHAUSTED`. Returns exact `200 { "success":true,"task_id":7,"task_status":"pending","workflow_instance_id":12,"instance_status":"active","assignment":{"assignee_id":8,"assignee_role":"member","assignment_version":2} }`. Action/reassign, concurrent reassign, completion, pause, cancellation, transfer, and identity races leave one winner and no partial log/archive.

### Campaign-linked workflow instance controls

Existing `POST /api/workflow/instances/:id/pause`, `/resume`, and `/cancel` remain unchanged for unlinked instances: no key/body and exact legacy `200 { "success": true }`. Linked instances require campaign write and `Idempotency-Key`. Pause body is exactly `{ "expected_status": "active", "reason": "..." }`; resume is `{ "expected_status": "paused", "reason": "..." }`; cancel accepts either exact body with status `active` or `paused`. Scopes are `workflow.campaign-instance.pause`, `.resume`, and `.cancel`, with server source `workflow_instance_control`. One `BEGIN IMMEDIATE` transaction re-fetches active user, current organization/team membership, campaign write and operational predicate, exact reciprocal dispatch lineage, and instance status before changing status, writing node/activity log plus campaign-linked knowledge archive, and for cancel changing every pending task to `cancelled`; it then completes exact response `200 { "success": true, "instance_id": 12, "status": "paused|active|cancelled" }`. Task/control/transfer/revocation/hold races serialize on those predicates, so one wins. Same key/hash replays only after current authorization; changed hash conflicts; processing returns `IDEMPOTENCY_IN_PROGRESS`. After authorization the exact precedence is `CAMPAIGN_CANCELLED`, `CAMPAIGN_ON_HOLD`, then active-only `409 STALE_WORKFLOW_INSTANCE_STATUS` with details `{ "instance_status":"active|paused|completed|cancelled|failed_validation", "campaign_operational_status":"active" }`; access failure has zero side effect.

## Existing Optional-Link Writes / 现有可选关联写入

These routes accept optional `campaign_id`: demand create, proposal create, persisted proposal PPT generation, collaboration create/update, knowledge create/ingest/upload, and AI chat conversation. Public manual workflow start remains legacy-only; campaign workflow instances/links are created only by lifecycle dispatch. Omission preserves the pre-v0.5 contract exactly except the intentional global repairs: collaboration object authorization plus hidden internal row-version increment, immutable-provenance knowledge authorization, the shared upload sandbox, and scoped/unscoped PPT admission controls.

When present:

1. `campaign_id` is a canonical safe integer and `Idempotency-Key` is mandatory.
2. The server preauthorizes the campaign before provider/file work.
3. The final persistence transaction reauthorizes and atomically writes the base row plus active link.
4. AI links the conversation; every later message must use that campaign or omit campaign while continuing the same already-linked conversation. Continuation derives the campaign before ledger lookup and requires scope `ai.conversation.continue.linked` plus `Idempotency-Key`.
5. Campaign-aware PPT generation requires both `campaign_id` and `proposal_id`. The proposal must already be accessible and actively linked to that campaign as `proposal`; the server renders the existing normalized payload, links the same proposal as `ppt`, and never links a temporary filename.
6. Temporary output is removed on final authorization, persistence, or link failure.
7. Same-key completed retry replays status/body; same key with changed request returns `409`; processing returns `409 IDEMPOTENCY_IN_PROGRESS` and `Retry-After`.

The linked route contracts are exact:

| Route | Linked request delta | Linked success | Relation behavior |
| --- | --- | --- | --- |
| `POST /api/demands` | existing JSON fields plus `campaign_id`; no other new field | `201 { "id": 31, "campaign_id": 42, "link_id": 91 }` | creates one `demand` link |
| `POST /api/proposals` | existing `demand_id,template_id,content` plus `campaign_id`; editor re-save posts the exact latest outline as `content` | `201 { "id": 17, "campaign_id": 42, "content_sha256": "<sha256>" }` | creates one `proposal` link; each edited save is a new persisted proposal version |
| `POST /api/proposal/generate-ppt` | existing `outline,demand` plus required `campaign_id,proposal_id,proposal_content_sha256` | `200` binary PPTX with typed replay metadata | adds `ppt` alias for the same proposal record ID |
| `POST /api/collaborations` | existing JSON fields plus `campaign_id`; `status` omitted or exact `confirmed` | `201 { "id": 73, "campaign_id": 42, "row_version": 1, "active_relations": ["order"] }` | stores `confirmed` and creates only `order`; any other create status is `INVALID_COLLABORATION_TRANSITION` |
| `PUT /api/collaborations/:id` | existing update fields plus required `campaign_id,expected_version,reason`; optional one `campaign_relation=order|execution|publication|settlement`; settlement and any settled/reviewed-campaign cost change additionally require exact `confirm_cost_actual:true`; cancellation is the separate exact body `{campaign_id,expected_version,reason,action:"cancel"}` | `200 { "success": true, "campaign_id": 42, "row_version": 2, "active_relations": ["order","execution"] }` | adoption requires accessible owner/admin target and an eligible status; closed forward status graph; execution requires `live|content_review|completed`; publication requires completed plus active order/execution; settlement requires completed, active publication, canonical safe non-negative cost, and explicit confirmation; a settled/reviewed campaign cannot be left unconfirmed; cancellation only while campaign on hold and revokes the complete four-alias bundle |
| `POST /api/knowledge`, `POST /api/knowledge/ingest` | existing JSON fields plus `campaign_id`; omitted `visibility` stores `private`, explicit visibility is exactly `private|team`, and linked bodies reject `public|shared`, every other token, and `is_public` as `400 INVALID_CAMPAIGN_INPUT` | `201 { "entry": {}, "id": 88, "campaign_id": 42, "link_id": 99 }` | creates one `knowledge` link |
| `POST /api/knowledge/upload` | multipart part `file` plus existing text parts and canonical decimal text part `campaign_id`; no JSON body part; omitted visibility stores `private`, explicit visibility is exactly `private|team`, and linked multipart rejects `public|shared`, every other token, and `is_public` as `400 INVALID_CAMPAIGN_INPUT` | `201 { "entry": {}, "rows": 18, "campaign_id": 42, "link_id": 99 }` | creates one `knowledge` link after parse/ingest succeeds |
| `POST /api/knowledge/:id/use` for an already linked entry | no body; campaign is server-derived; scope `knowledge.use.linked` | exact `200 { "success": true }` | requires `Idempotency-Key`; increments usage once and completes replay atomically; unlinked route remains no-key |
| `POST /api/ai/chat` for a new conversation | existing JSON fields plus `campaign_id` and optional ordered `knowledge_entry_ids`; `conversation_id` absent | existing chat result keys plus exact siblings `campaign_id` and `link_id` | creates one `ai_run` link for the conversation parent |

Linked demand, proposal version, successful PPT, collaboration milestone, assistant message, workflow task/control/terminal/reassignment node log, event-backed workflow reconciliation, and post-settlement review use the design's closed source identities and archive projections. Instance-backed workflow records use `campaign_workflow_log,<workflow_node_log_id>`; reconciliation uses `campaign_workflow_reconciliation,<reconciliation_event_id>` and never fabricates a node log before initialization. Their archive/chunks/link and producer mutation are required in one transaction. Archive suppression is permitted only for replay or a proven byte-identical no-semantic-change collaboration edit; capacity, digest conflict, authorization, provider, parser, or link failure rolls the producer back. New campaign-linked knowledge writes store only `private|team` under the exact request rules above. Campaign-aware APIs/RAG project stored legacy `public|shared` as `team` without rewriting it; truly unlinked v0.4 success responses preserve their original visibility token. Ordinary campaign-aware responses use only bounded source `{kind,label}` without raw IDs, filenames, paths, URLs, provider data, cache keys, or artifacts.

Knowledge identity and chunking are versioned contracts. Migration derives each legacy source identity from exact typed `KU32` frames over version, row ID, entry/source type, source ID/hash, business type/ID, and creator; NULL, INTEGER, and TEXT have distinct tags, legacy `source_id` specifically accepts positive-safe INTEGER or valid-scalar bounded TEXT, malformed storage fails, duplicate legacy `(entry_id,chunk_index)` fails before mutation, and existing chunks are digest-backfilled without rechunking. New/rebuilt entries use canonical valid-scalar NFC/LF title/summary/content/tags and exact `tm-knowledge-chunk-v1`: trim, split on two-or-more LF, trim/discard empty paragraphs, pack with exactly two LF up to 1,200 Unicode scalars, and scalar-slice oversized paragraphs. Empty content is one empty chunk. Campaign-owned immutable-source retry must match the entry digest and complete ordered chunk-digest list or return `409 KNOWLEDGE_SOURCE_CONTENT_CONFLICT` without overwrite. Truly never-classified v0.4 `ingestKnowledge` instead computes its frozen legacy `hashInput` from the original pre-normalization input, then canonicalizes persistence/content digests; CRLF/LF or NFC/NFD may intentionally select distinct unlinked rows. An existing hash preserves source identity and atomically rebuilds digests/chunks/FTS. A new hash uses the design's sequence/max safe explicit-ID preallocation under `BEGIN IMMEDIATE`, computes `tm-knowledge-legacy-source-v1` before explicit insertion, and rolls back entry/chunks/FTS/sequence together; historical campaign classification can never enter that branch.

For `POST /api/ai/chat` continuation, an existing linked conversation derives its campaign when `campaign_id` is omitted; the same explicit ID is accepted; a different ID returns `409 CONVERSATION_CAMPAIGN_MISMATCH`. Linked new and continuation requests may include `knowledge_entry_ids` as at most 20 unique positive-safe integers. Their input order is semantic and remains in the request hash. Selected chunks order by entry input then `chunk_index,chunk_id`; at most eight retrieved candidates remain after chunk-ID dedup and order by FTS rank, entry updated-at descending, entry ID, chunk index, and chunk ID. The exact knowledge block renders each final rank as `[KB-r]\n<COALESCE(title,"")>\n<content>` joined by two LF and is independently capped at 48 total chunks, eight retrieved chunks, and 98,304 UTF-8 bytes. Selected overflow returns `413 KNOWLEDGE_SELECTION_TOO_LARGE`; otherwise retrieved candidates append whole in order and stop at the first total-count, retrieved-count, or byte overflow without skipping or truncating. Each persisted `reference_schema_version=1` row represents exactly one finally included chunk and stores immutable campaign/entry/chunk digest snapshots plus contiguous rank/origin; usage increments once per distinct entry and citation counts distinct assistant messages. Replay never reincrements either.

Linked continuation always requires `Idempotency-Key`, scope `ai.conversation.continue.linked`, and exact replay semantics even when campaign ID is omitted. DeepSeek is mandatory for linked chat and both LLM/web adapters receive the same abort signal/deadline. Web is optional and may report `used:false`; LLM key/outage/timeout/abort/malformed result returns zero-event `503 AI_PROVIDER_UNAVAILABLE`. No conversation/message/reference/token/archive/cache/link is written until provider success, when one token-fenced transaction repeats authorization and persists all of them atomically. Unlinked v0.4 fallback behavior is unchanged. JSON linked routes reject multipart, uploads reject missing/multiple file parts or non-text campaign fields, and every linked route rejects unknown fields/parts. Validation is `400`; malformed or hostile supported content is `400 UPLOAD_INVALID_CONTENT`; unsupported type or extension/magic mismatch is `415 UPLOAD_UNSUPPORTED_TYPE`; parser limits/timeouts use `413 UPLOAD_LIMIT_EXCEEDED` and `408 UPLOAD_PARSE_TIMEOUT`; inaccessible campaign/record uses the deterministic common concealment contract; active ownership/link conflict is `409`; PPT render/provider failure is `502 PPT_GENERATION_FAILED`. Every failure leaves no base row, link, archive, usage/reference delta, provider cache, or durable temporary artifact.

Linked collaboration status transitions are exactly: same-status data edit; `confirmed -> contract_sent|live`; `contract_sent -> live`; `live -> content_review|completed`; `content_review -> completed`; completed terminal. Adoption accepts current status `confirmed|contract_sent|live|content_review|completed`. A plain data edit emits no campaign event; an alias addition emits one aggregate `link_attached`. `campaign_relation='publication'` records trusted publication metadata only after completed order/execution; `action` is reserved exclusively for exact `action='cancel'`, so `action='confirm_publication'` is invalid. Settlement sets internal `cost_actual_confirmed=1` only after publication. A canonical `cost_actual` value change normally clears confirmation unless the same request explicitly reconfirms; unchanged value does not. If an active settlement bundle belongs to a campaign already at `settled|reviewed`, missing same-request reconfirmation instead completes zero-event `409 COLLABORATION_COST_CONFIRMATION_REQUIRED` with no collaboration/version/archive/link/event mutation, and the database forbids a resulting unconfirmed row. Cancellation revokes `order,execution,publication,settlement`; before `ordered` it emits one `link_revoked` and leaves the campaign on hold, while at `ordered` or later it emits one terminal operational event and also cancels the campaign, every other linked nonterminal collaboration, and nonterminal workflow evidence. Completed collaborations remain evidence. The unlinked legacy serializer never exposes `row_version` or `cost_actual_confirmed`; a truly unclassified PUT omitting campaign still increments internal version under `BEGIN IMMEDIATE`, while any active/historical classification returns `409 CAMPAIGN_CONTEXT_REQUIRED {campaign_id}` and never takes the legacy path. Maximum row-version increment returns `409 ROW_VERSION_EXHAUSTED`.

The linked new-conversation AI response top-level keys are exactly `conversation_id,message_id,answer,model,usage,knowledge_references,web_results,web_search,archived_summary_id,campaign_id,link_id`; nested `web_search` remains exactly `{ "used": true|false, "provider": "...", "reason": "..." }`. Each `knowledge_references` item is exactly `{citation_label,entry_id,chunk_id,chunk_index,title,entry_type,source,visibility,snippet,selected,rank,source_identity_sha256,entry_content_sha256,chunk_content_sha256}` and `source` is the bounded `{kind,label}` projection. A later read after access loss replaces it with exact `{citation_label,access_state:"restricted|missing"}`. Continuation returns `campaign_id` but no new `link_id`, because the parent link is not recreated.

For linked proposal creation, the exact response is `201 { "id": <proposal_id>, "campaign_id": <campaign_id>, "content_sha256": "<tm-request-v1 canonical JSON sha256>" }`; the unlinked legacy response remains exact `200 { "id": <proposal_id> }`. An editor mutation invalidates the captured ID/hash. The campaign bridge must save the exact latest outline again, receive a new ID/hash, and only then enable download; it never reuses an older persisted hash for changed content.

### Campaign-aware PPT save-first and replay

The M3 campaign adapter saves through `POST /api/proposals`, reads the linked response `id` and `content_sha256`, and repeats that save after any editor mutation before augmenting the frozen `POST /api/proposal/generate-ppt` body with the latest `proposal_id`, `proposal_content_sha256`, the same campaign ID, and the same captured-intent idempotency key across transport retries. The adapter replaces the frozen public file-parser entrypoint with a behavior-equivalent central `apiFetch` implementation and generation-fences all responses; it does not modify `ppt.js` or intercept generic `window.fetch`. The backend verifies proposal owner/admin access, active `proposal` link, and equality of submitted, stored, and outline hashes before rendering; mismatch returns `409 PROPOSAL_CONTENT_CHANGED`.

After same-key replay/conflict, the reservation transaction derives `resource_claim=sha256(FRAME("tm-ppt-proposal-claim-v1") || FRAME(org_id) || FRAME(campaign_id) || FRAME(proposal_id) || FRAME(proposal_content_sha256))`. Its unique active predicate admits one renderer across different keys. A different key sees `409 PPT_GENERATION_IN_PROGRESS` plus lease-derived `Retry-After` while processing, or `409 RECORD_ALREADY_LINKED` after retained binary/alias success; failed/deadline/error JSON releases the active claim predicate. The final transaction atomically persists the inherited `ppt` alias, required PPT knowledge archive, and binary ledger. Two-key races make exactly one renderer/provider call and billed artifact. Regeneration requires a newly persisted proposal version.

Each worker derives `base_cache_key=sha256(org_id + "\n" + user_id + "\n" + scope + "\n" + idempotency_key)` and an attempt-owned `artifact_key=sha256("tm-artifact-v1\n" + base_cache_key + "\n" + sha256(lease_token))`, renders privately, validates, fsyncs, no-replace promotes to `<PPT_CACHE_DIR>/<first-two-hex>/<artifact-key>.pptx`, and fsyncs file/directories before the token-matched transaction persists the winner. Replay reconstructs fixed safe headers, generates a fresh `X-Request-Id`, rechecks access, verifies path/root/no-symlink/size/hash, and streams without regeneration. Startup/hourly cleanup removes unreferenced attempt files older than one hour; unlink directory fsync precedes ledger deletion. The janitor never expires or removes an artifact derived from a live processing lease, regardless of mtime; resumable `expiring` tolerates an already missing file and fsyncs the directory before ledger deletion. At 30 days completed binary rows become resumable `expiring`; processing/failed rows at the immutable operation deadline become zero-event JSON `503`, while internal failed/admission retention is 24 hours. Admission applies to both campaign-scoped and frozen unscoped generation; unscoped requests receive an internal server-generated admission identity without changing request/response bytes. It enforces the design's per-user/org concurrency, hourly starts, retained count/bytes, 64 MiB output, and free-space floors, returning `429 PPT_GENERATION_RATE_LIMITED` or `507 PPT_STORAGE_CAPACITY_EXCEEDED`. The private cache is outside the static tree. Revoked access returns `403`; missing/corrupt replay evidence returns audited `500 REPLAY_ARTIFACT_INVALID`; render failure is `502 PPT_GENERATION_FAILED`. The existing no-campaign ephemeral download bytes and frozen `ppt.js` bytes remain unchanged.

Replay persists at most 4,096 UTF-8 bytes of the closed header projection and reconstructs only fixed PPTX `Content-Type`, canonical `Content-Length`, quoted lowercase-SHA `ETag`, exact `Cache-Control: private, max-age=0, no-store`, and normalized `Content-Disposition`. Logical filename strips paths/controls, NFC-normalizes, caps 120 code points/180 UTF-8 bytes, and ends exact `.pptx`; ASCII fallback and uppercase RFC 5987 encoding follow the design. Golden `Bluetti 夏季方案.pptx` yields `attachment; filename="Bluetti _.pptx"; filename*=UTF-8''Bluetti%20%E5%A4%8F%E5%AD%A3%E6%96%B9%E6%A1%88.pptx`. Unscoped PPT uses a server key with null campaign and scope `proposal.ppt.generate.unlinked.admission`, never stores binary replay, deletes/fsyncs ephemeral output after the capped stream, and only then stores terminal `completed/admission` with status 200 and every response/artifact field null; abort is failed and startup cleans expired attempts. Completed admission rows are accounting-only and never replay.

Every knowledge upload, linked or unlinked and whether `campaign_id` is present or omitted, accepts at most 15 MiB compressed input and enforces extension/magic agreement, 100 MiB expanded content, 10,000 entries, 64 worksheets/slides, 100,000 rows, 1,000,000 cells, 500 PDF pages, and 10 MiB extracted text. It rejects traversal, links, encryption, polyglots, malformed containers, and duplicate normalized names. `/api/knowledge/upload`, `/api/influencers/upload`, and `/api/demand/parse-file` first reserve an internal admission: concurrent maxima are 1/user, 3/organization, and 4/global; hourly starts are 20/user, 100/organization, and 200/global; parser spool is capped/reserved at 512 MiB with a 2-GiB post-reservation free floor. Admission rejection is `429 IDEMPOTENCY_RATE_LIMITED` or `507 IDEMPOTENCY_STORAGE_CAPACITY_EXCEEDED` before body read. All three then use the exact production launcher: locked no-login parser UID/GID, no supplementary groups/secrets/network, root-created no-follow input, separate writable output, checksum-pinned read-only runtime, private user/mount/tmp/device isolation, empty capabilities, no-new-privileges, reviewed syscall/AF_UNIX-only restrictions, per-job `TasksMax=32`, `LimitNOFILE=64`, `LimitFSIZE=128MiB`, `MemoryMax=512M`, `CPUQuota=100%`, 128-MiB private scratch, and independent/cgroup 20-second kill. The aggregate slice caps `TasksMax=128`, `MemoryHigh=1536M`, `MemoryMax=2G`, and `CPUQuota=400%`. There is no in-process fallback. Only regular single-link no-follow manifest-matching output is accepted; timeout/abort/crash/lease loss kills the whole cgroup and fsync-cleans the job tree before ledger handling. Any production identity/unit/slice/manifest/mount/self-test drift aborts startup before listen; routes are never merely disabled in a degraded production server. Stable content/parser failures are `413 UPLOAD_LIMIT_EXCEEDED`, `408 UPLOAD_PARSE_TIMEOUT`, `415 UPLOAD_UNSUPPORTED_TYPE`, or `400 UPLOAD_INVALID_CONTENT`, and every failure leaves no business/link row.

Workflow is the one exception to the workspace's generic “create or attach” pair. A normal user does not manually start a campaign workflow in Phase 4: matching published templates are auto-dispatched by lifecycle transitions. `/workflow-instances?campaign=:id` is a filtered trace/recovery surface, while trigger authoring remains platform-admin-only.

## Collection And Child Enforcement / 集合与子资源权限

- Collaboration list/stat queries remove inaccessible linked rows before aggregation. There is no collaboration export route; the shared influencer export is unchanged.
- Workflow instance list/stat and task/log child routes inherit linked campaign access.
- A linked AI conversation and all messages have one campaign boundary. Platform admin can audit all organizations; org admin is organization-bounded; every privileged list/detail read must persist a sanitized audit row before returning data, and audit failure returns `500 AUDIT_PERSISTENCE_FAILED`.
- Every knowledge dedup/create/update/ingest/upload/list/detail/search/similar/use/category/RAG/reference operation resolves immutable historical classification and current custody even when `campaign_id` is omitted. Classified entries require original visibility plus custody campaign access; inaccessible matches are concealed as `404 KNOWLEDGE_ENTRY_NOT_FOUND` and are never mutated, counted, ranked, referenced, or passed to AI.
- Only truly never-classified legacy records keep prior behavior; revoke-only never widens access.
- A link never grants target access.

`DELETE /api/customers/:id` checks opportunities and campaign evidence inside one transaction before deleting customer activity. Any dependency returns `409 CUSTOMER_HAS_DEPENDENCIES` with exact safe details `{ "dependencies":[{"type":"campaigns|opportunities","count":1}] }`, sorted by type with zero counts omitted, and zero mutation; otherwise activity and customer delete atomically. `DELETE /api/opportunities/:id` likewise checks campaign evidence and returns `409 OPPORTUNITY_HAS_DEPENDENCIES` with the same shape. Unexpected FK failures map to that route-specific code with `{ "dependencies":[{"type":"unknown","count":null}] }` and roll back fully; neither route uses a generic cross-route fallback code. These are the only polymorphic CRM target deletes changed by Phase 4; the existing workflow-template hard delete remains separately governed by `WORKFLOW_TEMPLATE_HAS_DEPENDENCIES`.

## Stable Error Codes / 稳定错误码

`CAMPAIGN_NOT_FOUND`, `CAMPAIGN_FORBIDDEN`, `INVALID_CAMPAIGN_INPUT`, `INVALID_CAMPAIGN_TRANSITION`, `INVALID_OPERATIONAL_TRANSITION`, `CAMPAIGN_GUARD_NOT_MET`, `CAMPAIGN_ON_HOLD`, `CAMPAIGN_CANCELLED`, `CAMPAIGN_EVIDENCE_IN_USE`, `CAMPAIGN_CONTEXT_REQUIRED`, `STALE_CAMPAIGN_STATE`, `STALE_CAMPAIGN_VERSION`, `ROW_VERSION_EXHAUSTED`, `INVALID_CAMPAIGN_LINK`, `RECORD_NOT_FOUND`, `RECORD_FORBIDDEN`, `RECORD_ALREADY_LINKED`, `RECORD_REQUIRES_LINK_CORRECTION`, `UNSUPPORTED_MEDIA_TYPE`, `INVALID_REQUEST_BODY`, `IDEMPOTENCY_REQUIRED`, `IDEMPOTENCY_IN_PROGRESS`, `IDEMPOTENCY_KEY_REUSED`, `IDEMPOTENCY_EXPIRED`, `IDEMPOTENCY_RATE_LIMITED`, `IDEMPOTENCY_STORAGE_CAPACITY_EXCEEDED`, `AUDIT_PERSISTENCE_FAILED`, `CONVERSATION_CAMPAIGN_MISMATCH`, `STALE_COLLABORATION_VERSION`, `INVALID_COLLABORATION_TRANSITION`, `COLLABORATION_COST_CONFIRMATION_REQUIRED`, `KNOWLEDGE_ENTRY_NOT_FOUND`, `KNOWLEDGE_SELECTION_TOO_LARGE`, `KNOWLEDGE_SOURCE_CONTENT_CONFLICT`, `KNOWLEDGE_STORAGE_CAPACITY_EXCEEDED`, `WORKFLOW_TASK_ACTION_NOT_ALLOWED`, `STALE_WORKFLOW_TASK_ACTION`, `STALE_WORKFLOW_INSTANCE_STATUS`, `CAMPAIGN_TEMPLATE_REQUIRED`, `CAMPAIGN_TEMPLATE_MODULE_IMMUTABLE`, `CAMPAIGN_TEMPLATE_CREATE_REQUIRED`, `STALE_WORKFLOW_TEMPLATE_VERSION`, `INVALID_CAMPAIGN_WORKFLOW_TEMPLATE`, `WORKFLOW_TEMPLATE_NOT_FOUND`, `WORKFLOW_TEMPLATE_HAS_DEPENDENCIES`, `DISPATCH_NOT_RETRYABLE`, `DISPATCH_NOT_RECONCILABLE`, `DISPATCH_ALREADY_RECONCILED`, `PPT_GENERATION_IN_PROGRESS`, `PPT_GENERATION_RATE_LIMITED`, `PPT_STORAGE_CAPACITY_EXCEEDED`, `PPT_GENERATION_FAILED`, `REPLAY_ARTIFACT_INVALID`, `PROPOSAL_CONTENT_CHANGED`, `UPLOAD_LIMIT_EXCEEDED`, `UPLOAD_PARSE_TIMEOUT`, `UPLOAD_UNSUPPORTED_TYPE`, `UPLOAD_INVALID_CONTENT`, `AI_PROVIDER_UNAVAILABLE`, `CUSTOMER_HAS_DEPENDENCIES`, `OPPORTUNITY_HAS_DEPENDENCIES`.

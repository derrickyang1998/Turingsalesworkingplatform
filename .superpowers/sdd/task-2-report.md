# Task 2 Report: Migration Runner RED-GREEN

## Status

Implemented Task 2 migration runner and digest service under the requested branch `codex/v0.5.0-campaign-business-spine`.

Focused Task 2 verification is GREEN. Full server suite is blocked by two existing Task 12 deployment-source contract failures outside the Task 2 ownership set.

## Changed Files

- Deleted `platform/migrate.js`
- Modified `platform/server/db.js`
- Created `platform/server/services/migration_service.js`
- Created `platform/server/services/sqlite_digest_service.js`
- Created `platform/server/migrations/engines/v1.js`
- Created `platform/server/migrations/baselines/legacy_v1.js`
- Created `platform/server/migrations/001_legacy_compat_columns.js`
- Created `platform/server/tests/migration_service.test.js`
- Created `platform/server/tests/sqlite_digest_service.test.js`
- Created `platform/server/tests/fixtures/canonical_hash_vectors.js`
- Created `platform/server/tests/fixtures/digest_v1_fixture.js`
- Overwritten `.superpowers/sdd/task-2-report.md`

## Commits

- Focused Task 2 implementation commit. The final response records the exact amended commit hash produced after this report was included.

## RED

Command from `platform`:

```powershell
node --test server/tests/migration_service.test.js server/tests/sqlite_digest_service.test.js
```

Result: exit `1`; tests `11`; pass `0`; fail `11`.

Expected failures: missing `migration_service`, missing `sqlite_digest_service`, missing immutable migration/baseline modules, and obsolete `platform/migrate.js` still present.

## GREEN

Command from `platform`:

```powershell
node --test server/tests/migration_service.test.js server/tests/sqlite_digest_service.test.js
```

Result: exit `0`; tests `11`; pass `11`; fail `0`; duration `1815.4878ms`.

## Full Suite

Command from `platform/server`:

```powershell
npm test
```

Result: exit `1`; tests `215`; pass `213`; fail `2`; duration `27677.8754ms`.

Failing tests:

- `tests/deployment_source_contract.test.js`: Task 12 local deploy preflight rejects current branch `codex/v0.5.0-campaign-business-spine` because `platform/deploy_v8.ps1` still expects `codex/v0.4.0-product-shell-and-design-system`.
- `tests/deployment_source_contract.test.js`: deploy inventory does not upload `server/tests/migration_service.test.js` before remote `npm test`.

These failures require deployment-source edits outside Task 2 ownership and were not changed.

## Decisions

- Kept product migration `002` out of Task 2. No `002` module was created or registered.
- Moved the legacy schema and frozen v0.4 seed admissions into immutable `migrations/baselines/legacy_v1.js`.
- Kept mutable orchestration in `migration_service.js` and excluded it from v1 migration checksum inputs.
- Used `tm-migration-checksum-v1` U64 framing for registered migration checksum validation and locked the synthetic vector `2298da2cb6311ed6abf5afeb7463c31455a8a787cd5573cae558829540efc515`.
- Preserved independent seed predicates: admin admission depends only on `SELECT id FROM users WHERE role='admin' LIMIT 1`; influencer admission depends only on `SELECT COUNT(*) AS count FROM influencers`.
- Replaced swallowed compatibility alters with explicit `PRAGMA table_info` checks in `001`.
- Added collaboration `row_version` and `cost_actual_confirmed` compatibility backfills plus validation/increment triggers on the legacy non-STRICT table.
- Implemented reusable SQLite topology/logical/FTS digest and request/audit hash vectors in Task 2 fixtures for later tasks to consume.

## Self-Review

- File ownership stayed within the Task 2 allowlist plus the required report.
- No UI, PPT, deployment, or product `002` files were edited.
- No secrets were introduced; seed password resolution still reads environment variables at runtime and does not store raw values.
- `platform/migrate.js` was removed, and runtime/deploy references were checked; remaining matches are spec/plan references and the Task 2 test assertion.
- `git diff --check` exited `0`; it reported only the existing Windows line-ending warning for `platform/server/db.js`.

## Concerns

- Full suite remains red because deployment Task 12 source contracts still reference the v0.4 branch and deployment inventory. Fixing those would require editing deployment files outside Task 2.
- The runner implements the Task 2 contract and test fixtures, but the production-shaped remote gate and Phase 4 deployment inventory still need a deployment-owner pass before release.

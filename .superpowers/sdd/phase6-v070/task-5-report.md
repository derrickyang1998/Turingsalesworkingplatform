# Task 5 Report

Status: implemented

## Scope

- Updated `platform/server/server.js` only in the demand parse route area.
- Updated focused route coverage in `platform/server/tests/phase4_server_integration.test.js`.
- No frontend, migration, PPT, deployment, credential, or unrelated code changes.

## Implementation

- `POST /api/demand/parse-file` now archives successful parses as private `requirement_sheet` knowledge entries with `source_type='demand_file_upload'` and `business_type='demand'`.
- The route preserves legacy response fields and adds `knowledge.archivedEntryId`.
- Metadata is limited to operational upload/parser facts: filename, MIME, size, raw file SHA-256, parser/fallback/OCR/warning state, `quality_state`, `retention_class`, and `citation_count`.
- Deduplication uses a versioned owner-scoped source hash derived from current user ID plus file SHA-256. The raw file digest is not used as global `source_hash`.
- `authority.readFresh(db)`, archive ingest, and admission completion now run in one immediate SQLite transaction. Archive failure prevents admission completion and leaves the admission failed.

## RED

- Command: `node --test --test-name-pattern "demand parsing archives|demand parsing reuses|demand parsing keeps|demand parsing rolls back" tests\phase4_server_integration.test.js`
- Initial setup result before dependency restore: failed before test execution with `Cannot find module 'better-sqlite3'`.
- Dependency restore: `npm ci` in `platform/server` completed successfully, added 139 packages, found 0 vulnerabilities.
- RED rerun result: 5 focused tests failed as expected. Four failed on missing `knowledge.archivedEntryId`; rollback failed because the route still returned 200 and completed admission despite the archive trigger.

## GREEN

- Command: `node --test --test-name-pattern "demand parsing archives|demand parsing reuses|demand parsing keeps|demand parsing rolls back" tests\phase4_server_integration.test.js`
- Result: pass. 5 tests passed, 0 failed.

## Syntax And Focused Review

- Command: `node --check platform\server\server.js`
- Result: pass, no output.
- Command: `node --check platform\server\tests\phase4_server_integration.test.js`
- Result: pass, no output.
- Command: `git diff --check -- platform\server\server.js platform\server\tests\phase4_server_integration.test.js`
- Result: pass, no output.
- Command: `git diff -- platform\server\server.js platform\server\tests\phase4_server_integration.test.js | Select-String -Pattern "password|secret|token|api[_-]?key|BEGIN|PRIVATE KEY" -CaseSensitive:$false`
- Result: only existing-style test fixture passwords/tokens and SQL `BEGIN` trigger text appeared; no production credential or API key was added.

## Self-Review

- Auth freshness: archive and admission completion happen after `authority.readFresh(db)` in the same immediate transaction.
- Tenant isolation: private owner ID is included in the versioned source hash, so identical bytes dedupe only within the same owner.
- Transactionality: ingest failure aborts before `completeAdmissionInTransaction`; focused rollback test verifies admission is not completed.
- Dedupe: repeat same owner plus same file bytes reuses one entry and leaves one chunk and one FTS row.
- Response compatibility: legacy fields are preserved; only `knowledge.archivedEntryId` is additive.

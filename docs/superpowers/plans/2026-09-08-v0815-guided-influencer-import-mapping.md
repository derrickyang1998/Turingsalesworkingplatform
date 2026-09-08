# v0.8.15 Guided Influencer Import Mapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a guided preview-map-confirm import flow that accepts the approved 20-column Chinese template and historical 19-column aliases, reports row-level errors, and imports every valid row without changing the latest M4 shell or frozen PPT.

**Architecture:** Reuse the existing authenticated `/api/influencers/upload` parser sandbox. A preview request parses the file and returns bounded headers, automatic field suggestions, sample values, validation counts, and row errors without writing business or knowledge rows; confirmation uploads the same file with a validated versioned mapping and performs the existing transactional import/knowledge archive. Legacy clients that omit `mode` keep the current direct-import behavior.

**Tech Stack:** Node.js 20, Express 5, SQLite via `better-sqlite3`, existing upload sandbox, plain browser JavaScript, existing TuringMarket CSS tokens/components, Node test runner.

**Spec:** `docs/superpowers/plans/2026-07-12-turingmarket-platform-roadmap.md` Phase 7 work item 329.

## Global Constraints

- Preserve the exact approved 20-column `TEMPLATE_HEADERS` and all historical 19-column aliases.
- Keep `POST /api/influencers/upload` as the only multipart route; do not create an unregistered parser path.
- Preview must not insert influencer or knowledge rows.
- Confirmation must import valid rows and return row-level errors for rejected rows in the same response.
- Mapping targets are allowlisted and unique; unknown sources, unknown targets, duplicate targets, oversized JSON, and missing required handle mapping fail closed.
- Limit on-screen preview disclosure to headers, field definitions, at most three sample values per header, at most ten normalized preview rows, and at most one hundred row errors plus an explicit total; provide a downloadable CSV containing every rejected row and its error details.
- Preserve legacy direct upload, current template download, upload cleanup, immutable batch replay, latest M4 layout, account-scoped views, and frozen `platform/ppt.js` bytes.
- Use the existing design system; no new route/page, palette, icon system, or card-within-card composition.
- This parser-policy change triggers focused upload-sandbox, influencer, public-asset, source-contract, replay, and guarded deployment checks.

---

### Task 1: Guided Preview, Mapping, Partial Import, And M4 Interaction

**Files:**
- Modify: `platform/server/tests/influencer_workflow.test.js`
- Modify: `platform/server/tests/upload_sandbox.test.js`
- Modify: `platform/server/services/influencer_workflow_service.js`
- Modify: `platform/server/services/upload_sandbox_service.js`
- Modify: `platform/server/server.js`
- Modify: `platform/server/systemd/turingmarket-parser.manifest.json`
- Modify: `platform/server/scripts/trusted_production_source_manifest.json`
- Modify: `platform/deploy_v8.ps1`
- Modify: `platform/app.js`
- Modify: `platform/index.html`
- Modify: `platform/client/styles/components.css`
- Test: `platform/server/tests/deployment_source_contract.test.js`
- Test: `platform/server/tests/parser_runtime_release.test.js`
- Test: `platform/server/tests/release_v060_contract.test.js`

**Interfaces:**
- Produces: `IMPORT_MAPPING_VERSION = 'influencer-guided-v1'`.
- Produces: `IMPORT_FIELD_DEFINITIONS`, an immutable ordered list of `{ key, label, type, required }` objects.
- Produces: `previewInfluencerImport(rows, options)` returning `{ mapping_version, fields, columns, row_count, blank_count, valid_count, error_count, warning_count, row_errors, row_errors_truncated, error_report_csv, sample }`.
- Extends: `importInfluencerRows(db, rows, opts)` with optional `opts.field_mapping` and `opts.row_number_offset` while preserving the legacy return envelope.
- Extends multipart body allowlist for `/api/influencers/upload` with `mode`, `mapping_version`, `field_mapping`, and `expected_file_sha256`.
- Preview request: multipart fields `mode=preview`, `mapping_version=influencer-guided-v1`, `file=<same source file>`.
- Confirmation request: multipart fields `mode=import`, `mapping_version=influencer-guided-v1`, `field_mapping=<JSON source-header to canonical-field object>`, `expected_file_sha256=<preview digest>`, `file=<same source file>`.
- Legacy request: no `mode`; imports exactly as before.

- [ ] **Step 1: Write failing service tests for mapping suggestions and row validation**

Add tests that prove the exact attachment headers in `C:\Users\29272\Desktop\商务平台开发\推广项目-网红合作数据表-上传表头.xlsx` plus historical aliases such as `标签`, `成本价`, `邮箱`, and lower-case `cpm`/`cpv` receive deterministic suggestions; unknown or unnamed columns suggest `ignore`. Assert blank rows are counted separately, one missing-handle row and one nonnumeric-followers row appear as row-level errors, and a valid row remains importable.

- [ ] **Step 2: Run the focused service tests and verify RED**

Run:

```powershell
node --test --test-name-pattern "guided influencer import|row-level influencer import" platform/server/tests/influencer_workflow.test.js
```

Expected: FAIL because the preview/mapping exports and row-error contract do not exist.

- [ ] **Step 3: Implement the service mapping contract**

Add strict mapping parsing, source/target allowlists, duplicate-target rejection, exact alias suggestion, bounded on-screen samples/errors, a complete CSV error report, and a shared row preparation path used by preview and import. Expose the approved 20 target fields plus `ignore`; map `日期` to the existing `created_at` field in guided mode after strict date normalization, with no schema change, while legacy direct import keeps its historical behavior. Treat non-empty malformed numeric or date cells as rejected-row errors; preserve existing normalization for valid numbers and historical aliases. Treat platform/link/contact format issues as warnings for compatibility. Use spreadsheet row numbers starting at 2 for multipart uploads and 1 for JSON rows.

- [ ] **Step 4: Run the focused service tests and verify GREEN**

Run the Step 2 command and confirm every selected test passes.

- [ ] **Step 5: Write failing real-route and upload-policy tests**

Add tests proving preview returns `200` without database or knowledge writes, a changed mapping invalidates earlier validation, final validation plus confirmation imports only valid rows, the response provides a downloadable complete error CSV while displaying at most 100 errors, duplicate/unknown mapping targets return controlled `400` errors, the new multipart fields are part of the canonical request identity, and legacy direct multipart upload still imports unchanged.

- [ ] **Step 6: Run the route and sandbox tests and verify RED**

Run:

```powershell
node --test --test-name-pattern "guided influencer upload|influencer multipart mapping" platform/server/tests/influencer_workflow.test.js platform/server/tests/upload_sandbox.test.js
```

Expected: FAIL because the upload policy and route do not yet accept preview/mapping fields.

- [ ] **Step 7: Implement preview and confirmation in the existing upload route**

Allow only the four versioned fields, parse `field_mapping` with a 16 KiB ceiling, call `previewInfluencerImport` for preview mode, and call `importInfluencerRows` with the validated mapping for confirmation. Return the parsed file SHA-256 from preview and reject confirmation unless `expected_file_sha256` exactly matches the current upload, preventing a different file from reusing an earlier validation. Derive mapped batch identity from file SHA-256 plus canonical mapping SHA-256; preserve the historical file-only batch identity when no mapping is supplied. Complete parser admission in the same transaction without creating business/knowledge rows for preview. Refresh the parser runtime artifact hash, trusted-source manifest hash, and deploy-pinned manifest identity required by the changed upload sandbox bytes.

- [ ] **Step 8: Run route and sandbox tests and verify GREEN**

Run the Step 6 command and confirm every selected test passes.

- [ ] **Step 9: Write failing frontend contract tests**

Extend the M4 static contract test to require the states `idle`, `parsing`, `mapping_dirty`, `validated_ready`, `importing`, `success`, `partial_success`, and `fatal_error`; mapping selectors for each source header; required-field/duplicate-target feedback; valid/error/warning/blank counts; bounded row-error table; complete error CSV download; cancel/reset; and explicit `校验数据` plus `确认导入` commands. Require status regions to use `aria-live`, labels to bind to controls, the existing `TMAccessibility.openDialog/closeDialog` focus contract, and one scroll container on narrow viewports.

- [ ] **Step 10: Run the frontend contract test and verify RED**

Run:

```powershell
node --test --test-name-pattern "m4 frontend keeps import" platform/server/tests/influencer_workflow.test.js
```

Expected: FAIL because the guided mapping controls are absent.

- [ ] **Step 11: Implement the guided M4 interaction**

Route both Tab 3 upload entry points into the same existing modal and retain the selected `File` object in memory only until confirm/cancel/logout. On selection or drop, request preview and render source header, source position, sample values, destination selector, required marker, and validation summary. Any mapping edit sets `mapping_dirty`, invalidates the prior server validation, and disables confirmation until `校验数据` re-uploads the file with the final mapping. Reject duplicate destinations inline; on confirmation re-upload the same file with the validated versioned mapping, then show imported/skipped counts and bounded row errors, enable complete error CSV download, refresh the influencer list, and clear the retained file only after success/cancel/logout. Remove `.xls` from frontend acceptance and state that old XLS must be saved as XLSX. Use `TMAccessibility.openDialog/closeDialog` for focus lock, Escape, and focus return. Keep template download and the compact Tab 3 status surface.

- [ ] **Step 12: Run the frontend contract test and verify GREEN**

Run the Step 10 command and confirm it passes.

- [ ] **Step 13: Run affected verification and independent reviews**

Run the complete `influencer_workflow.test.js` and `upload_sandbox.test.js`, JavaScript syntax checks, focused public-asset/source-contract/replay tests required by the changed parser policy, secret scan, frozen PPT hash check, and `platform/deploy_v8.ps1 -ValidateLocalOnly`. Obtain independent product/frontend and code/security review; fix and re-review every material finding.

- [ ] **Step 14: Commit, deploy, and verify production**

Commit only reviewed source/tests, push the feature commit, create a verified production backup through `platform/deploy_v8.ps1`, and deploy. Verify public health/static routes, anonymous `401`, authenticated template download, preview with zero database writes, confirmation partial success, row errors, import list visibility, cleanup of acceptance rows, schema `v15`, SQLite `quick_check`, PM2/Nginx state, and unchanged frozen PPT hash.

- [ ] **Step 15: Record and synchronize the release**

Update `CHANGELOG.md`, Phase 7 work item 329, a bilingual version record, repository archive copy, Obsidian archive, and `TuringMarket-开发进度.html`; commit and push documentation, then verify local/remote Git SHA and archive hashes match.

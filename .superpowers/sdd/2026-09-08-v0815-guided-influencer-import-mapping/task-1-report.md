# TuringMarket v0.8.15 Task 1 Implementer Report

Date: 2026-09-08

## Scope delivered

- Added a guided influencer import preview/confirm flow with an explicit mapping model, source positions, source samples, row validation, blank-row accounting, partial import, and complete rejected-row CSV output.
- Bound confirmation to the previewed file with `file_sha256` and `expected_file_sha256`; mismatched bytes fail closed.
- Added strict guided `日期` validation and mapped it to the existing `created_at` column. The legacy direct-import SQL and behavior remain unchanged.
- Invalidated a prior preview whenever mapping changes. Confirmation is enabled only after a new server preview validates the current mapping.
- Unified both influencer upload entry points on one modal, removed `.xls` from frontend acceptance, limited displayed row errors to 100, and used `TMAccessibility.openDialog` / `closeDialog`.
- Extended the upload sandbox allowlist and canonical request identity, then refreshed the parser manifest, trusted production source manifest, runtime parser pin, and deploy trusted-manifest pin.
- Preserved `platform/ppt.js` unchanged. No deployment or release-document update was performed.

## Changed files

- `platform/app.js`
- `platform/client/styles/components.css`
- `platform/deploy_v8.ps1`
- `platform/index.html`
- `platform/server/scripts/trusted_production_source_manifest.json`
- `platform/server/server.js`
- `platform/server/services/influencer_workflow_service.js`
- `platform/server/services/upload_sandbox_service.js`
- `platform/server/systemd/turingmarket-parser.manifest.json`
- `platform/server/tests/influencer_workflow.test.js`
- `platform/server/tests/upload_sandbox.test.js`
- `.superpowers/sdd/2026-09-08-v0815-guided-influencer-import-mapping/task-1-report.md`

## TDD evidence

### Service mapping and row validation

RED command:

```text
node --test --test-name-pattern "guided influencer import|row-level influencer import" platform/server/tests/influencer_workflow.test.js
```

Expected RED output:

```text
tests 2; pass 0; fail 2
TypeError: previewInfluencerImport is not a function
```

After the brief added the strict date requirement, the focused test was updated before implementation and run again:

```text
tests 2; pass 0; fail 2
Expected target field created_at but received source_date
Field mapping contains an unknown target field
```

GREEN output after implementation:

```text
tests 2; pass 2; fail 0; duration_ms 941.1877
```

### Guided route and upload sandbox contract

RED command:

```text
node --test --test-name-pattern "guided influencer upload|influencer multipart mapping" platform/server/tests/influencer_workflow.test.js platform/server/tests/upload_sandbox.test.js
```

Expected RED output:

```text
tests 3; pass 0; fail 3
400 Invalid multipart field (guided fields were not yet allowlisted)
Expected INVALID_FIELD_MAPPING but received UPLOAD_INVALID_CONTENT
UploadSandboxError: Invalid multipart field
```

GREEN output after route, allowlist, canonical identity, and hash-chain changes:

```text
tests 3; pass 3; fail 0; duration_ms 2667.24
```

### Frontend guided modal contract

RED command:

```text
node --test --test-name-pattern "m4 frontend keeps import" platform/server/tests/influencer_workflow.test.js
```

Expected RED output:

```text
tests 1; pass 0; fail 1
The influencer file input still accepted .xls and the guided modal contract was absent.
```

GREEN output after implementation:

```text
tests 1; pass 1; fail 0; duration_ms 87.9455
```

### Legacy regression discovered by affected suite

The first full affected-suite run found two legacy upload failures because `null` mapping was being passed to the legacy importer:

```text
tests 83; pass 78; fail 2; skipped 3
Field mapping must be an object
```

The route was corrected so mapping is passed only in guided mode. Focused GREEN:

```text
node --test --test-name-pattern "influencer upload route imports|same-name influencer uploads" platform/server/tests/influencer_workflow.test.js
tests 2; pass 2; fail 0; duration_ms 2568.3842
```

Final affected-suite GREEN:

```text
node --test platform/server/tests/influencer_workflow.test.js platform/server/tests/upload_sandbox.test.js
tests 83; pass 80; fail 0; skipped 3; duration_ms 67913.6836
```

## Final focused checks

```text
node --check platform/app.js
node --check platform/server/server.js
Both exited 0.
```

```text
node --test --test-name-pattern "guided influencer import|row-level influencer import|guided influencer upload" platform/server/tests/influencer_workflow.test.js
tests 4; pass 4; fail 0; duration_ms 3522.9518
```

```text
node --test --test-name-pattern "influencer multipart mapping fields enter the canonical request identity" platform/server/tests/upload_sandbox.test.js
tests 1; pass 1; fail 0; duration_ms 93.576
```

```text
node --test --test-name-pattern "m4 frontend keeps import" platform/server/tests/influencer_workflow.test.js
tests 1; pass 1; fail 0; duration_ms 87.5324
```

Additional syntax checks passed for both changed services and both changed test files. `git diff --check` passed.

The exact source workbook at `C:\Users\29272\Desktop\商务平台开发\推广项目-网红合作数据表-上传表头.xlsx` was inspected read-only. Sheet1 contains 20 headers matching the approved template order; initial empty worksheet rows are handled by the separate blank-row count.

## Trust and frozen-artifact verification

```text
upload_sandbox_service.js SHA-256
6da2f7d2f49c5d1ac1bf17ce392aa873136a42b94ccdbe81cb9eeba82824d0cd

turingmarket-parser.manifest.json SHA-256
d05316c54e456c85936773789908d332f09c8d668e7613022cb0a401809dc857

trusted_production_source_manifest.json SHA-256
ae65135950ce57dc3342b8fc978e4a7915927f29e27d73e6b1407ceb89324131

platform/ppt.js SHA-256 (unchanged)
f311a7b33ee28e64c8e19a14bae436101272dd17bf2f4f8c5d181d57dd0e291e
```

The upload-service hash is present in both parser/trusted manifests, the parser-manifest hash is pinned in both `server.js` and the trusted manifest, and the trusted-manifest hash is pinned in `deploy_v8.ps1`.

## Interrupted non-gating check

An initially combined `frontend_public_assets`, `deployment_source_contract`, and `parser_runtime_release` run was stopped at the user's direction because it exceeded the requested lightweight-check budget. Before termination it emitted a summary of 255 tests, 239 passed, 16 skipped, and 0 failed, but the process returned exit code 1 after interruption. This run is recorded as non-gating and is not used as completion evidence; the bounded focused checks above are the gating results.

## Self-review

- Preview and confirmation share the same normalization/validation path; confirmation additionally verifies the uploaded bytes against `expected_file_sha256` before any business-row write.
- Guided batch identity includes both file and canonical mapping hashes, preventing a mapping change from silently replaying a prior confirmation.
- Mapping targets are allowlisted, duplicate mapped targets are rejected, and required `kol_handle` mapping is enforced.
- Guided dates are calendar-validated and normalized into `created_at`; legacy imports continue to omit `created_at` from their insert and retain database-default behavior.
- The UI state transitions cover `idle`, `parsing`, `mapping_dirty`, `validated_ready`, `importing`, `success`, `partial_success`, and `fatal_error`. Mapping changes clear the validated digest/mapping and require server re-preview.
- UI error rendering is capped at 100 entries while the server response retains the complete rejected-row CSV.
- Both page entry points converge on the same accessible modal and the modal uses the platform accessibility dialog helpers.
- No edits were made to release documentation, and no production command was run.

## Unresolved risks

- The complete rejected-row CSV is returned in the JSON response, so pathological uploads can create a large response within the existing parser/upload size bounds.
- Native Linux/systemd-only parser checks remain skipped on this Windows host.
- The user explicitly prohibited spawning an independent reviewer, so this report contains implementer self-review only.
- Production deployment and live-browser production verification were intentionally not performed.

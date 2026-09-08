# TuringMarket v0.8.15 Error Report Security Fix

Date: 2026-09-08
Baseline: `1133eb3`

## Scope

- Emit exactly one CSV data record per rejected source row.
- Preserve every field, code, and message by storing ordered JSON arrays in the existing CSV columns.
- Serialize each rejected row source payload once.
- Enforce a 16 MiB hard limit using incremental UTF-8 byte counts.
- Throw a controlled `413` with code `INFLUENCER_IMPORT_ERROR_REPORT_TOO_LARGE` before any influencer or knowledge-base write.
- Preserve the existing 100-item UI error preview limit, historical imports, and partial-success imports.

## Root Cause

`buildErrorReportCsv` emitted one complete `source_row` copy for every field-level error. A rejected row with multiple validation errors therefore multiplied response size, and the builder had no output-size ceiling.

## RED

Command:

```text
node --test --test-name-pattern "guided influencer error report|guided influencer import rejects oversized" platform/server/tests/influencer_workflow.test.js
```

Result before the production change:

```text
tests 2; pass 0; fail 2
aggregation: expected one rejected-row record, received three
capacity: expected controlled exception, received none
```

Both failures reproduced the reviewed defect against the unchanged service implementation.

## GREEN

Focused command:

```text
node --test --test-name-pattern "guided influencer|row-level influencer import|influencer import accepts the historical" platform/server/tests/influencer_workflow.test.js
```

Result:

```text
tests 8; pass 8; fail 0
```

The capacity fixture uses multibyte UTF-8 input whose character count is below 16 MiB but encoded byte count exceeds the limit. It also verifies that influencer and knowledge-entry counts remain unchanged.

## Verification

```text
node --check platform/server/services/influencer_workflow_service.js
node --check platform/server/tests/influencer_workflow.test.js
git diff --check
```

All checks exited successfully.

## Changed Files

- `platform/server/services/influencer_workflow_service.js`
- `platform/server/tests/influencer_workflow.test.js`
- `.superpowers/sdd/2026-09-08-v0815-guided-influencer-import-mapping/task-1-error-report-fix.md`

No deployment, release documentation, parser manifest, frontend, PPT, or other module was changed.

# TuringMarket v0.8.15 Task 1 Minimal Fix Report

Date: 2026-09-08
Baseline: `93ea85d`

## Scope

- Tightened guided-import numeric validation to require a complete valid value.
- Rejected negative followers, average views, CPM, and CPV while preserving absolute-value compatibility for cost and quoted price.
- Added monotonic preview request invalidation bound to the retained `File` object and mapping fingerprint.
- Removed nested vertical scrolling from the guided-import mapping and error regions on narrow screens.
- Did not change parser runtime manifests, deployment files, routes, the page structure, CRM, AI, or PPT code.

## RED

Command:

```text
node --test --test-name-pattern "guided influencer import accepts complete numeric formats|m4 frontend keeps import" platform/server/tests/influencer_workflow.test.js
```

Result:

```text
tests 2; pass 0; fail 2
numeric validation: expected 1 valid row, received 10
frontend contract: narrow-screen single-scroll rules were absent
```

The failures reproduced the reviewed defects before production code was changed.

## GREEN

Focused command:

```text
node --test --test-name-pattern "guided influencer import|row-level influencer import|guided influencer upload|m4 frontend keeps import" platform/server/tests/influencer_workflow.test.js
```

Result:

```text
tests 6; pass 6; fail 0
```

Additional checks:

```text
node --check platform/app.js
node --check platform/server/services/influencer_workflow_service.js
node --check platform/server/tests/influencer_workflow.test.js
git diff --check
```

All checks exited successfully. `platform/ppt.js` remained unchanged with SHA-256 `f311a7b33ee28e64c8e19a14bae436101272dd17bf2f4f8c5d181d57dd0e291e`.

## Changed Files

- `platform/server/services/influencer_workflow_service.js`
- `platform/app.js`
- `platform/client/styles/components.css`
- `platform/server/tests/influencer_workflow.test.js`
- `.superpowers/sdd/2026-09-08-v0815-guided-influencer-import-mapping/task-1-fix-report.md`

## Excluded Work

Linux parser runtime-tree rebuilding and all manifest/deployment pin changes were deliberately excluded from this fix as requested. Other working-tree changes outside the five files above were not staged or modified by this task.

# v0.8.9 Customer Report PPT Delivery Plan / 客户复盘 PPT 交付计划

> **Implementation mode:** TDD, minimal surface area, independent code review,
> and production release after the feature is complete.
>
> **Scope approval:** This is the approved Phase 7B.3 continuation: generate
> a customer review PPT from an immutable customer-safe snapshot. It does not
> change the established campaign proposal PPT or the current UI shell.

## Scope / 范围

Deliver one user-visible capability: in the Performance Review page, an
authorized user can generate/download a customer-facing PPT for any sealed
customer report. The downloaded file is bound to that sealed report rather
than current live campaign data.

在效果复盘页面，为每个已封存客户复盘提供“客户版 PPT”下载。下载内容严格绑定该
封存版本，不因后续活动数据变化而变化。

## Implementation Steps / 实施步骤

1. **Write migration and contract tests first.**
   - Add failing tests for a strict, append-only
     `customer_report_ppt_artifacts` v14 schema.
   - Add failing service tests for owner/admin authorization, reader denial,
     sealed snapshot binding, repeat-download byte identity, bad snapshot
     rejection, and artifact recording failure cleanup.
   - Add route and frontend contract tests for the new binary endpoint and
     action button.

2. **Add the v14 persistence contract.**
   - Create `server/migrations/014_customer_report_ppt_artifact.js`.
   - Register it in `server/db.js` and all migration/deployment verification
     registries, trusted source manifest, and deployment copy list.
   - Keep the schema append-only and do not alter v13 snapshot records.

3. **Implement the isolated report delivery service.**
   - Add a narrowly scoped write-authorized snapshot accessor to
     `customer_report_snapshot_service.js`.
   - Add `server/services/customer_report_delivery_service.js`.
   - Use a separate `PptArtifactStore` root and a dedicated janitor.
   - Validate the pre-redacted `customer_safe_v1` report and its hash before
     rendering; never read current live performance data during delivery.
   - Add an activity log event that records artifact generation without
     storing sensitive report content.

4. **Render the PPT without touching proposal PPT generation.**
   - Add `server/generate_customer_report_ppt.py`.
   - Render the seven allowed report sections into a compact, customer-safe
     presentation using only data from the sealed report JSON.
   - Wire a dedicated synchronous renderer in `server/server.js`.

5. **Expose the binary endpoint and current-screen action.**
   - Add the request policy and POST route in `routes_performance.js`.
   - Return only verified retained files with attachment headers.
   - Add a compact action to the sealed customer report list in `app.js`.
   - Preserve current stale-response protection and UI layout.

6. **Verify, review, and release.**
   - Run the failing-to-passing focused tests, syntax, contract, secret, and
     generator checks.
   - Run an independent code review and address all blocking findings.
   - Because this includes schema and authorization changes, run the full
     candidate/replay migration release gate.
   - Create a remote backup, deploy, restart safely, run public health and
     anonymous authorization smoke checks, and verify schema integrity with a
     read-only database query.
   - Update CHANGELOG, version record, archive note, GitHub, and the visible
     development-progress board.

## Acceptance Criteria / 验收标准

- A sealed report can produce one downloadable customer PPT.
- A second request for the same sealed snapshot returns the same retained
  artifact identity.
- A later performance refresh or different report snapshot does not alter an
  earlier downloaded PPT.
- Campaign readers cannot generate/download the artifact; owners and
  organization administrators can.
- The PPT and endpoint do not expose commercial metrics, raw creator/video
  data, internal prompts, or external delivery details.
- Existing proposal PPT generation remains operational and unchanged.
- Production health, database integrity, and public authorization boundaries
  pass after deployment.

## Release Cadence / 发布节奏

After v0.8.9, each ordinary completed feature will be released immediately
with focused verification and an independent review. Full-platform candidate
gates remain reserved for migrations, authorization/security, shared runtime,
external write, or phase-closeout changes.


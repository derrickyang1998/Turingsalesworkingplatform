# TuringMarket v0.6.0 Release Gate Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each v0.6.0 feature slice independently verifiable, crash recoverable, and safe to deploy as soon as that feature is complete, without allowing candidate-controlled code to execute as production root before backup and validation.

**Architecture:** Extend the existing content-addressed trusted-production-source bundle so parser lifecycle controls and the parser contract are independently pinned. Candidate parser payload bytes remain the subject under test, but root-side build, identity measurement, installation, acceptance, recovery, and finalization use trusted controls and never import candidate modules. Keep public Nginx in maintenance through rollback until the restored application is healthy, and make every transaction/evidence publication boundary recoverable and hash-bound.

**Tech Stack:** PowerShell 7 deployment orchestration, Bash lifecycle scripts, Node.js 20 test runner and trusted verifier, Python 3 capacity planner, systemd 259, Nginx, PM2, SQLite.

## Global Constraints

- Production v0.4 remains unchanged until every gate applicable to the current feature slice passes. The complete non-browser and browser gates apply at phase closeout, a scheduled release window, or when a broad-risk trigger requires them; browser execution still requires explicit user authorization.
- Work only in `C:\Users\29272\Documents\在线商务平台\.worktrees\phase5-v060-release` on `codex/v0.6.0-crm-sales-workspace`.
- Do not run Playwright, Chromium, or any browser command without explicit user authorization.
- Do not expose or copy production secrets into candidate, build, gate, test, log, backup, or evidence paths.
- Candidate payload and dependency tooling must build in a disposable non-privileged systemd unit with no production mounts, credentials, or inherited environment. Candidate code must never execute as root; root may only independently verify, seal, and atomically install immutable output after backup and unprivileged candidate validation. Root acceptance must not trust candidate-declared evidence.
- All behavior changes require a failing regression first, followed by focused verification for the changed module. The complete non-browser suite runs at phase closeout or a scheduled release window instead of blocking every feature slice.
- Final release evidence must synchronize `CHANGELOG.md`, version records, Obsidian, GitHub, and the development progress dashboard.

## Incremental Online Release Cadence / 单功能增量上线节奏

Every independently usable feature follows this loop and is deployed without waiting for unrelated roadmap work:

1. Implement one bounded feature or bug fix with a failing regression first.
2. Run only the changed module's unit/API/contract tests, syntax or migration checks, and secret scanning.
3. Obtain one independent code-review approval; security-sensitive release controls still block on any HIGH or CRITICAL finding.
4. Create and verify a production backup and rollback point.
5. Deploy the feature slice, then run production health, login, and the feature's core-path smoke checks.
6. Update `CHANGELOG.md`, the version record, dashboard, Obsidian archive, and GitHub evidence for that slice.

The 71-file non-browser aggregate and complete cross-module/browser regression are reserved for phase closeout, a scheduled release window, or a change whose blast radius is genuinely cross-cutting. This lighter cadence does not waive backup, rollback, migration, secret, or production smoke gates.

---

### Task 1: Independently Pinned Parser Control Plane

**Files:**
- Create: `platform/server/scripts/trusted_parser_runtime_verifier.js`
- Modify: `platform/server/scripts/trusted_production_source_manifest.json`
- Modify: `platform/server/scripts/trusted_production_source_gate.js`
- Modify: `platform/server/scripts/build_upload_sandbox_runtime.sh`
- Modify: `platform/server/scripts/provision_upload_sandbox_runtime.sh`
- Modify: `platform/server/scripts/upload_sandbox_self_test.js`
- Modify: `platform/deploy_v8.ps1`
- Test: `platform/server/tests/deployment_source_trust.test.js`
- Test: `platform/server/tests/release_v060_contract.test.js`
- Test: `platform/server/tests/parser_runtime_release.test.js`
- Test: `platform/server/tests/upload_sandbox_self_test.test.js`
- Test: `platform/server/tests/deployment_runtime_hardening.test.js`

**Interfaces:**
- Consumes: existing trusted bundle `stage` and `prepare-runtime` commands, parser manifest schema 3, current parser runtime tree contract.
- Produces: a pinned `trusted_parser_runtime_verifier.js` CLI/module that measures runtime/source bytes and verifies canonical raw acceptance observations without requiring parser implementation modules.

- [x] **Step 1: Write failing trust-boundary tests**

Add assertions that the trusted manifest contains exact parser-control entrypoints and SHA-256 records, deploy constants match them, and parser preparation occurs only after backup and the unprivileged candidate gate. Add hostile-candidate tests proving a forged all-true self-test or replacement verifier cannot authorize release.

- [x] **Step 2: Verify the new tests fail for the expected trust-boundary gaps**

Run:

```powershell
node --test --test-concurrency=1 tests/deployment_source_trust.test.js tests/release_v060_contract.test.js tests/parser_runtime_release.test.js tests/upload_sandbox_self_test.test.js tests/deployment_runtime_hardening.test.js
```

Expected: failures identify pre-gate parser preparation, candidate verifier imports, missing trusted parser entrypoints, and forgeable evidence.

- [x] **Step 3: Add the independent parser verifier**

Implement strict commands for runtime tree measurement, source artifact verification, installed policy observation validation, and evidence binding. It must reject symlinks, non-regular entries, writable or non-root-owned installed artifacts, duplicate/unknown JSON keys, manifest/verifier hash drift, and candidate-declared booleans without matching raw observations. The verifier must also validate the stopped non-privileged build unit, inaccessible build parent, absence of production bind mounts, and absence of inherited credential variables before root sealing.

- [x] **Step 4: Extend the trusted-source contract**

Pin builder, provisioner, capacity planner, self-test controller, independent verifier, parser manifest, service unit, slice unit, and all parser payload inputs in the trusted source manifest. Extend the trusted gate's exact schema, entrypoint checks, and runtime sealing without weakening migration verification.

- [x] **Step 5: Reorder and rewire deployment**

Enforce this exact order: upload checksum verification -> production backup -> unprivileged candidate gate -> trusted parser preparation -> cutover. Source lifecycle controls and authoritative parser contract from the content-addressed trusted bundle, verify the candidate digest again before preparation, build candidate payload inside a disposable non-privileged systemd unit without production mounts/secrets, stop and collect that unit, independently verify and seal its inaccessible output as root, and remove every root-side import of candidate `upload_sandbox_service.js`.

- [x] **Step 6: Verify Task 1**

Run the five-test command from Step 2 plus Node syntax checks for every modified JavaScript file. Expected: zero failures, with Linux/root-only cases explicitly skipped on Windows.

### Task 2: Crash-Safe Parser Installation and Rollback Capacity

**Files:**
- Modify: `platform/server/scripts/provision_upload_sandbox_runtime.sh`
- Modify: `platform/server/scripts/check_cutover_capacity.py`
- Modify: `platform/deploy_v8.ps1`
- Test: `platform/server/tests/parser_runtime_release.test.js`
- Test: `platform/server/tests/cutover_capacity.test.js`
- Test: `platform/server/tests/deployment_source_contract.test.js`
- Test: `platform/server/tests/release_v060_contract.test.js`

**Interfaces:**
- Consumes: trusted provisioner/verifier from Task 1, immutable backup and cutover snapshot paths.
- Produces: recoverable parser transaction states and a fresh rollback capacity verdict before writer shutdown.

- [x] **Step 1: Write failing transaction and capacity tests**

Cover interruption before/after journal staging, fsync, rename, and directory fsync; a partial stage before journal publication; unsafe or mismatched `.transaction.new`; dependency-shrinking rollback byte/inode requirements; and manual rollback preflight order.

- [x] **Step 2: Verify RED**

Run:

```powershell
node --test --test-concurrency=1 tests/parser_runtime_release.test.js tests/cutover_capacity.test.js tests/deployment_source_contract.test.js tests/release_v060_contract.test.js
```

Expected: failures expose unrecoverable `.transaction.new`, pre-journal stage, reversed dependency delta, and missing manual rollback preflight.

- [x] **Step 3: Implement recoverable journal publication**

Promote a complete, exact, root-owned journal staging file when identities and state agree; safely remove only an exact root-owned partial stage when mutation provably never began; reject every ambiguous or unsafe state.

- [x] **Step 4: Correct and reuse capacity planning**

Reserve rollback dependency bytes and inodes as `max(live - candidate, 0)` on the actual restore target device. Add a fresh restore-mode capacity check after immutable rollback snapshot validation and before writer lock or PM2 stop.

- [x] **Step 5: Verify Task 2**

Run the four-test command from Step 2 and `python -m py_compile scripts/check_cutover_capacity.py`. Expected: zero failures and no generated bytecode left in the worktree.

### Task 3: Health-Gated Public Rollback and Durable Acceptance Evidence

**Files:**
- Modify: `platform/deploy_v8.ps1`
- Test: `platform/server/tests/deployment_source_contract.test.js`
- Test: `platform/server/tests/deployment_lifecycle_takeover.test.js`
- Test: `platform/server/tests/release_v060_contract.test.js`

**Interfaces:**
- Consumes: accepted evidence, replay evidence, acceptance facts, immutable backup, exact public Nginx verifier.
- Produces: recoverable phase transitions and a current accepted marker cryptographically bound to replay, parser, and acceptance evidence.

- [x] **Step 1: Write failing lifecycle tests**

Require restored loopback health before public Nginx restoration; require every recordable phase, including `release-replay-complete`, to be observable and recoverable; reject hard-link publication; and require strict replay file metadata plus SHA-256 validation in recovery and finalization.

- [x] **Step 2: Verify RED**

Run:

```powershell
node --test --test-concurrency=1 tests/deployment_source_contract.test.js tests/deployment_lifecycle_takeover.test.js tests/release_v060_contract.test.js
```

Expected: failures identify Nginx ordering, missing phase coverage, marker link-count crash window, and unbound replay evidence.

- [x] **Step 3: Implement health-gated rollback**

Keep verified maintenance active while restoring code/data/parser and restarting PM2. Verify loopback health first, then atomically restore the saved public Nginx link/config and run the exact public behavior gate.

- [x] **Step 4: Implement recoverable acceptance publication**

Include replay evidence SHA-256 in accepted and current markers, strictly hash the exact `replay-<runId>.json` file in recovery/finalization, use fsynced same-directory `os.replace` publication, and add all phases to observation/takeover rules with deterministic rollback or finalize behavior.

- [x] **Step 5: Verify Task 3**

Run the three-test command from Step 2 and PowerShell parse validation. Expected: zero failures.

### Task 4: Runtime Build, Evidence Pinning, and Incremental Release Verification

**Files:**
- Modify: `platform/server/systemd/turingmarket-parser.manifest.json`
- Modify: `platform/server/server.js`
- Modify: `platform/DEPLOY.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/version-records/2026-08-11-v0.6.0-crm-sales-workspace.md`
- Modify: `archive/versions/2026-08-11-v0.6.0-crm-sales-workspace.md`

**Interfaces:**
- Consumes: final trusted parser controls and runtime payload.
- Produces: one exact Linux runtime tree identity and matching server/documentation pins.

- [ ] **Step 1: Rebuild the parser runtime in isolated Linux**

Build from the final trusted bundle with no production mounts or secrets. Capture exact SHA-256, file count, directory count, byte count, verifier hash, trusted manifest hash, and functional OCR/XLSX/PPTX evidence.

- [ ] **Step 2: Pin final identities once**

Update parser manifest, server startup constant, deployment constants, runbook, changelog, and version records from the final evidence. Assert no stale identity or schema literal remains.

- [ ] **Step 3: Run focused verification for the current feature slice**

Run syntax checks, package audits when dependencies changed, and only the focused release suites that exercise the current slice. Expected: zero failures; only explicitly conditional Linux/root cases may skip. Run all `tests/*.test.js` except browser-launching files only at phase closeout or the scheduled release window.

- [ ] **Step 4: Obtain risk-proportionate independent approval**

Each feature slice requires one independent code-review `APPROVE` against the exact diff and focused evidence. A slice that changes deployment, authentication, authorization, secrets, migrations, or rollback controls also requires the matching DevOps or application-security reviewer. The full code-review, application-security, DevOps, and test-analysis set is required at phase closeout rather than for every unrelated feature.

### Task 5: Incremental Production Cutover and Version Synchronization

**Files:**
- Update: `C:\Users\29272\Documents\在线商务平台\TuringMarket-开发进度.html`
- Create/update: `D:\主盘\图灵集市\图灵商务平台开发\01-版本归档\2026-08-14-v0.6.0-crm-sales-workspace.md`

**Interfaces:**
- Consumes: clean, committed, pushed, independently approved candidate and explicit browser authorization.
- Produces: verified production v0.6.0, tested rollback path, GitHub/Obsidian/changelog/version synchronization.

- [ ] **Step 1: Commit and push the exact approved candidate**

Synchronize the clean candidate into the authoritative GitHub checkout, commit intentionally, push `codex/v0.6.0-crm-sales-workspace`, and record the immutable commit SHA.

- [ ] **Step 2: Back up and deploy**

Create and validate the production backup before mutation, run the guarded deployment from the authoritative checkout, and retain maintenance until all acceptance evidence is durable.

- [ ] **Step 3: Run production API and core-path smoke acceptance**

For each slice, verify production health, login, the changed feature's core path, and rollback readiness. Run the complete CRM, knowledge/RAG, PPT, influencer import/template/search/sticky table, Feishu workflow, and admin conversation audit matrix only at phase closeout; do not execute browser automation until browser authorization is explicit.

- [ ] **Step 4: Synchronize release records**

Update the dashboard, `CHANGELOG.md`, project version records, Obsidian archive, and GitHub with production URL, release SHA, backup identity, test counts, reviewer approvals, and rollback evidence.

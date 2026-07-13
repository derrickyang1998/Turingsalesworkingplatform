# Phase 3 Product Shell And Design System Implementation Plan / 第 3 阶段产品壳层与设计系统实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver `v0.4.0-product-shell-and-design-system` as a behavior-preserving responsive shell with an explicitly tested shared-accessibility baseline on the authoritative TuringMarket baseline. / 将 `v0.4.0-product-shell-and-design-system` 交付为不改变业务行为的响应式壳层，并建立经过明确测试的共享无障碍基线。

**Architecture:** Load three focused CSS layers after the legacy compatibility CSS, add one shell-state module and one shared-accessibility enhancer, and minimally strengthen the existing navigation owner and shared application status/focus hooks. Public and deployment boundaries remain exact allowlists. / 在旧兼容 CSS 后加载三层聚焦样式，新增一个壳层状态模块和一个共享无障碍增强模块，并最小化强化现有导航及共享应用状态/焦点钩子；公开与部署边界继续使用精确白名单。

**Tech Stack:** Vanilla JavaScript/CSS, Express 5, Nginx, Node test runner, Playwright 1.60/1.61, `@axe-core/playwright` 4.12.1, PowerShell deployment. / 原生 JavaScript/CSS、Express 5、Nginx、Node 测试、Playwright、axe、PowerShell 部署。

## Global Constraints / 全局约束

- Authoritative checkout: `C:\Users\29272\Documents\在线商务平台-github-sync`.
- Branch: `codex/v0.4.0-product-shell-and-design-system`.
- Preserve `ppt.js?v=20260702v916kbbridge`, build `20260702-v916-kb-bridge-client-cn`, and SHA-256 `f311a7b33ee28e64c8e19a14bae436101272dd17bf2f4f8c5d181d57dd0e291e`.
- Preserve separate `客户看板` and `客户明细` screens and all current CRM, brand intelligence, strategy, AI/PPT, influencer, workflow, admin, and knowledge behavior.
- New public assets are exact-path allowlisted; unknown, encoded, traversal, and server-private paths remain `404`.
- No secret, credential, API key, token, webhook, private payload, or production business data enters code, logs, screenshots, or release documents.
- Every production change follows RED -> GREEN -> full regression -> independent review -> backup -> guarded deploy -> online verification -> version archive -> GitHub push.

---

### Task 1: Audit And Design Contract / 审计与设计契约

**Files:**
- Create: `docs/product/2026-07-ux-audit.md`
- Create: `docs/product/turingmarket-design-system.md`
- Create: `docs/product/evidence/2026-07-phase3-pre/*.png`
- Create: `docs/superpowers/specs/2026-07-14-phase-3-product-shell-design.md`

**Interfaces:**
- Produces exact color, type, spacing, radius, shell, component, breakpoint, focus, motion, and acceptance rules consumed by Tasks 2-5.

- [ ] Run all 102 deterministic browser tests and capture/inspect all 72 current screenshots at `1440x900`, `1920x1080`, and `390x844`.
- [ ] Record prioritized findings and evidence limits; do not claim full accessibility compliance from screenshots.
- [ ] Document visual Directions A/B/C and record previously approved Direction A as the implementation direction.
- [ ] Define exact shared tokens and Phase 3 scope/deferred domain scope.
- [ ] Obtain product-manager and accessibility-reviewer approval of the document contract before production code begins.
- [ ] Run `git diff --check` and review all documents for placeholders, contradictions, and secrets.
- [ ] Commit with `docs: define v0.4.0 product shell`.

### Task 2: RED Public Asset And Shell Contracts / 公开资产与壳层契约红灯

**Files:**
- Create: `platform/server/tests/product_shell_contract.test.js`
- Create: `platform/server/tests/accessibility_shell.test.js`
- Modify: `platform/server/tests/frontend_public_assets.test.js`
- Modify: `platform/server/tests/public_static_security.test.js`
- Modify: `platform/server/tests/frontend_navigation_contract.test.js`
- Modify: `platform/server/tests/deployment_source_contract.test.js`
- Modify: `platform/server/tests/frontend_architecture_inventory.test.js`
- Modify: `platform/server/tests/ppt_bridge_browser_contract.test.js`
- Modify: `platform/server/scripts/generate_ui_baseline_manifest.js`

**Interfaces:**
- Requires exact assets `client/styles/tokens.css`, `client/styles/components.css`, `client/styles/layout.css`, `client/core/accessibility.js`, and `client/core/shell.js`.
- Requires app build `20260714-v040-product-shell-design-system` and query `20260714v040productshelldesignsystem`.

- [ ] Add tests requiring stylesheet order `tokens -> components -> layout`, then scripts `build_info -> navigation -> accessibility -> shell -> app -> ppt`.
- [ ] Add tests requiring semantic mobile shell markup, a skip link and `<main>`, labelled login controls with `name`/`autocomplete`/inline error, 16 px checkbox glyph and 24/44 px target tokens, `--tm-color-control-border:#8a94a3`, sticky headers, no gradients/blur/negative letter spacing in the new layers, exact focus/reduced-motion rules, semantic dialogs/live regions, and a frozen PPT marker/hash.
- [ ] Add a mobile authentication test requiring `#app` to remain computed hidden before login and after an expired session; reject `#app { display:block!important }` at the mobile breakpoint.
- [ ] Add tests requiring navigation canonical `<a href>` entries, plain-click SPA interception without intercepting modifier/middle clicks, active `aria-current="page"`, decorative icons hidden from assistive technology, idempotent group labels `客户经营`/`方案与执行`/`流程协作`/`系统管理`, and administrator-only visibility for the final group.
- [ ] Add shared-accessibility contracts for associated labels, APG keyboard tabs, Enter/Space upload activation, dialog focus/Escape/inert/return, title updates, toast/error live regions, M4 checkbox names/targets/indeterminate, and basic workflow palette/node keyboard alternatives.
- [ ] Add Express/Nginx/deploy tests requiring the five exact assets and rejecting near-miss, encoded, traversal, and unknown paths.
- [ ] Run `node --test tests/product_shell_contract.test.js tests/accessibility_shell.test.js tests/frontend_public_assets.test.js tests/public_static_security.test.js tests/frontend_navigation_contract.test.js tests/deployment_source_contract.test.js` from `platform/server`.
- [ ] Confirm RED failures are caused only by missing v0.4 assets/semantics/build contracts.
- [ ] Commit tests with `test: define v0.4.0 shell contracts` only after preserving the RED output in the task report.

### Task 3: GREEN Tokens, Components, Shell, And Navigation / 令牌、组件、壳层与导航绿灯

**Files:**
- Create: `platform/client/styles/tokens.css`
- Create: `platform/client/styles/components.css`
- Create: `platform/client/styles/layout.css`
- Create: `platform/client/core/accessibility.js`
- Create: `platform/client/core/shell.js`
- Modify: `platform/index.html`
- Modify: `platform/client/core/navigation.js`
- Modify: `platform/client/shared/build_info.js`
- Modify: `platform/app.js`

**Interfaces:**
- `window.TMShell = Object.freeze({ init, setNavigationOpen, isNavigationOpen })`.
- `window.TMAccessibility = Object.freeze({ init, refresh, openDialog, closeDialog })` owns idempotent shared semantics and focus behavior without owning domain data.
- `tm:navigation-applied` updates the mobile page title and closes the drawer.
- Navigation anchors retain existing `data-page`, `admin-only`, and `visible` hooks plus canonical `href` values.

- [ ] Add exact CSS links and shell script with cache query `20260714v040productshelldesignsystem`; leave PPT query unchanged.
- [ ] Add static mobile top bar, labelled open/close controls, sidebar/backdrop IDs, skip link, `<main id="mainContent" tabindex="-1">`, navigation label, labelled login `<form>` controls with `name`/`autocomplete`, inline error region, and semantic static dialog containers.
- [ ] Implement idempotent drawer init, open/close state, breakpoint reset, backdrop, Escape, focus trap/restoration, and active-page title update.
- [ ] Render navigation as grouped canonical anchors, remove stale group labels/`aria-current` on rebuild, preserve modifier/middle-click behavior, and set `aria-current` on the active route without changing route order or labels.
- [ ] Implement the idempotent shared enhancer for generated labels, APG tabs, upload keyboard activation, dialog semantics/focus/inert/Escape/return, decorative icons, live regions, and document titles.
- [ ] In `app.js`, minimally connect login inline errors/first-invalid/session-expiry focus, toast status/alert behavior, M4 checkbox labels/select-all indeterminate, and workflow palette/node keyboard alternatives; do not change business data or API flows.
- [ ] Implement Direction A tokens and behavior-preserving shared CSS; no domain API/data changes.
- [ ] Run the Task 2 focused command and require GREEN.
- [ ] Run `node --check client/core/navigation.js`, `node --check client/core/accessibility.js`, `node --check client/core/shell.js`, and `node --check app.js` from `platform`.
- [ ] Commit with `feat: add responsive product shell`.

### Task 4: Exact Delivery Boundary And Build Gate / 精确交付边界与构建门禁

**Files:**
- Modify: `platform/server/services/public_assets_service.js`
- Modify: `platform/nginx/turingmarket.conf`
- Modify: `platform/deploy_v8.ps1`
- Modify: `platform/server/tests/deployment-browser-smoke.spec.js`
- Modify: `platform/DEPLOY.md`
- Modify: `CLAUDE_CODE_MIGRATION.md`
- Modify: `docs/handoff/2026-06-30/OPERATIONS.md`

**Interfaces:**
- Express and Nginx serve only the seven registered client assets: the existing build/navigation assets plus accessibility, shell, and three CSS files.
- Deploy candidate syntax-checks `accessibility.js` and `shell.js`, verifies all asset statuses and CSS/accessibility markers, and requires branch `codex/v0.4.0-product-shell-and-design-system`.

- [ ] Add exact Express routes and private-path tests for every new asset.
- [ ] Add exact Nginx locations with raw-request URI guards; keep fallback `/client/` as `404`.
- [ ] Add new files to upload, backup, hash, candidate, smoke, and rollback manifests.
- [ ] Update branch/app build gates while retaining the exact PPT gate.
- [ ] Run Task 2 focused tests, `node --check` for public service/accessibility/shell/navigation/app, PowerShell parse, and `git diff --check`.
- [ ] Commit with `build: deliver v0.4.0 shell assets`.

### Task 5: Browser Interaction, Layout, And Regression Gate / 浏览器交互、布局与回归门禁

**Files:**
- Create: `platform/server/tests/product-shell.config.js`
- Create: `platform/server/tests/product-shell.spec.js`
- Create: `docs/product/evidence/2026-07-phase3-post/*.png`
- Create: `docs/product/2026-07-phase3-visual-change-record.md`
- Modify: `platform/server/tests/helpers/browser_fixture.js`
- Modify: `platform/package.json`
- Modify: `platform/package-lock.json`

**Interfaces:**
- Projects: `fixture-1440`, `fixture-1920`, `fixture-mobile`.
- Uses the deterministic browser fixture and existing admin/user role data.

- [ ] Pin `@axe-core/playwright` at `4.12.1` and write Playwright tests before layout fixes for desktop non-overlap; mobile main-content visibility; native anchor modifier behavior; drawer pointer/keyboard/Escape/focus restoration; APG tabs; keyboard upload; dialog focus trap/inert/Escape/return; login inline error and expiry focus; toast live status; checkbox names, 16 px glyphs, 24/44 px targets, and select-all indeterminate; workflow keyboard add/select; sticky headers; mobile table containment; reduced motion; document titles; and unchanged routes.
- [ ] Add automated axe checks for representative login, CRM, M4, AI, workflow, and admin surfaces; test `320x568`, `390x844`, `1440x900`, and `1920x1080`, plus `200%` and `400%` zoom/reflow and forced-colors mode.
- [ ] Remove the recorded `mobile-shell-content` known gap only after the browser contract proves the mobile task area is visible.
- [ ] Run tests and confirm RED on the pre-v0.4 shell behavior.
- [ ] Apply only the minimum Task 3/4 CSS or shell corrections needed for GREEN; append any fixes to the task report.
- [ ] Run `node node_modules/playwright/cli.js test -c server/tests/product-shell.config.js` from `platform` and require all three projects to pass.
- [ ] Run the 102-test deterministic browser suite and capture all 72 post-change screenshots.
- [ ] Inspect every post-change contact sheet, compare against the pre-audit run, and record approved shared-shell change regions plus any zero-tolerance domain regressions.
- [ ] Run NVDA or VoiceOver smoke checks when the execution environment supports them; otherwise record the unavailable manual check as residual risk and do not claim full screen-reader or WCAG conformance.
- [ ] Run full local `npm test` in `platform/server`, frozen PPT contracts, static security, and `git diff --check`.
- [ ] Commit with `test: verify v0.4.0 shell interactions`.

### Task 6: Review, Production Release, And Archive / 审查、生产发布与归档

**Files:**
- Modify: `CHANGELOG.md`
- Create: `docs/version-records/2026-07-14-v0.4.0-product-shell-and-design-system.md`
- Create: `archive/versions/2026-07-14-v0.4.0-product-shell-and-design-system.md`
- Create/update: `D:\主盘\图灵集市\图灵商务平台开发\01-版本归档\2026-07-14-v0.4.0-product-shell-and-design-system.md`
- Modify: `D:\主盘\图灵集市\图灵商务平台开发\01-版本归档\CHANGELOG.md`

**Interfaces:**
- Required verdicts: product manager, frontend developer, accessibility reviewer, minimal-change reviewer, code reviewer, and application-security reviewer all `APPROVE` with no open P0/P1/P2 release issue.

- [ ] Run independent reviews and fix/re-review every Critical/Important/P0/P1/P2 finding.
- [ ] Require the accessibility reviewer to approve the explicitly scoped shared-shell baseline and any documented screen-reader/workflow-canvas residual risk; no unavailable check may be reported as passed.
- [ ] Re-run focused, full Node, browser, PPT, public-boundary, PowerShell, UTF-8, and diff gates from a clean worktree.
- [ ] Create and verify a protected production backup, deploy through `deploy_v8.ps1`, and preserve rollback evidence without secrets.
- [ ] Verify remote full Node and deployment-browser suites, PM2, Nginx, database integrity, exact assets, private `404` boundary, build markers, and frozen PPT hash.
- [ ] Complete authenticated online checks at all three viewports, including mobile drawer, CRM board/detail, M4 search/table/import entry, AI shell, admin shell, logout/revocation, and final sessions `0`.
- [ ] Update bilingual changelog/version records and Obsidian archive with exact non-secret evidence.
- [ ] Commit, push `codex/v0.4.0-product-shell-and-design-system`, and verify local/remote Git SHA.

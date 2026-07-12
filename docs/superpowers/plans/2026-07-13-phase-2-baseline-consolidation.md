# Phase 2 Baseline Consolidation And Regression Guardrails Implementation Plan / 阶段 2 基线收敛与回归护栏实施计划

> **For agentic workers / 面向执行代理：** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` task-by-task. Every behavior change follows RED -> GREEN -> REFACTOR, receives a specification review and code-quality review, and is not deployed until the complete Phase 2 gate passes. / 必须使用 `superpowers:subagent-driven-development` 按任务执行；所有行为变更遵循 RED -> GREEN -> REFACTOR，每项任务都经过规格审查与代码质量审查，完整阶段门槛通过前不得部署。

**Goal / 目标：** Freeze the current production UI/PPT/API behavior, add deterministic browser and architecture contracts, remove duplicate last-definition-wins code in safe slices, add stable page/deep-link/history/focus state, make workflow event binding idempotent, establish an admin-only preview marker, align public assets/deployment/docs, and release `v0.3.0-baseline-consolidation` without changing approved UI or PPT behavior. / 冻结当前生产 UI/PPT/API 行为，新增确定性浏览器与架构契约，以安全小批次移除“最后定义覆盖”重复代码，增加稳定页面/深链接/历史/焦点状态，使工作流事件绑定具备幂等性，建立管理员预览标记，统一公开资源、部署和文档，并在不改变已批准 UI 与 PPT 行为的前提下发布 `v0.3.0-baseline-consolidation`。

**Design / 设计：** `docs/superpowers/specs/2026-07-13-phase-2-baseline-consolidation-design.md`

**Tech stack / 技术栈：** Node.js, Express 5, `better-sqlite3`, classic browser JavaScript, Node test runner, Playwright 1.60/Chromium, PowerShell, PM2, Nginx, Git/GitHub, Obsidian.

## Global Constraints / 全局约束

- Authoritative checkout / 权威代码库：`C:\Users\29272\Documents\在线商务平台-github-sync`.
- Branch / 分支：`codex/v0.3.0-baseline-consolidation`.
- Base / 基线：`9a591aa92e039f53a12ad7d5f098a26d0818bf08`.
- Preserve exactly / 必须原样保留：`ppt.js?v=20260702v916kbbridge` and `window.tmPPTBuild = "20260702-v916-kb-bridge-client-cn"`.
- Existing pre-edit test baseline / 改动前测试基线：run from `platform/server`, `npm test` = `66 pass / 0 fail`. The roadmap's older `36`-test count is a historical planning snapshot. Bare `npm test` from `platform` is invalid evidence until its placeholder script is replaced in Task 3. / 在 `platform/server` 执行 `npm test` 为 `66 pass / 0 fail`；路线图的 `36` 项是历史规划快照。在 Task 3 替换占位脚本前，不得把 `platform` 根目录的裸 `npm test` 作为证据。
- Do not expose the protected production host, credentials, tokens, provider keys, personal data, or private evidence paths in public artifacts. / 公开产物不得泄露受保护主机、凭据、令牌、供应商密钥、个人数据或私有证据内容。
- Stop on unowned changes in files owned by the current task; never revert unrelated user changes. / 若当前任务负责文件出现非本任务变更则停止核对；不得回退用户无关改动。
- No Phase 3 visual redesign or later roadmap feature is permitted in this release. / 本版本不得夹带阶段 3 视觉重构或后续路线图功能。

## Exact Command Contract / 精确命令契约

All commands use PowerShell 7-compatible syntax. `$Repo` is always the authoritative checkout; no command is run from the non-authoritative workspace. / 全部命令使用兼容 PowerShell 7 的语法；`$Repo` 始终指向权威代码库，不得从非权威目录运行。

```powershell
$Repo = 'C:\Users\29272\Documents\在线商务平台-github-sync'
Set-Location -LiteralPath $Repo
git status --short --branch
git rev-parse HEAD
git diff --check

# Full Node gate: working directory is platform/server.
Push-Location -LiteralPath "$Repo\platform\server"
npm test
Pop-Location

# Focused Node gate: replace <test-file> with the task-owned file.
Push-Location -LiteralPath "$Repo\platform\server"
node --test "tests/<test-file>.test.js"
Pop-Location

# Static syntax gate.
node --check "$Repo\platform\app.js"
node --check "$Repo\platform\ppt.js"
node --check "$Repo\platform\server\server.js"

# Browser prerequisite and fixture gate: working directory is platform.
Push-Location -LiteralPath "$Repo\platform"
npx playwright --version
npx playwright install chromium
npx playwright test server/tests/browser-baseline.spec.js --config=server/tests/browser-baseline.config.js --project=fixture-1440 --project=fixture-1920 --project=fixture-mobile
Pop-Location

# Manifest and deterministic screenshot comparison.
Push-Location -LiteralPath "$Repo\platform\server"
node scripts/generate_ui_baseline_manifest.js --baseline-version v0.2.9 --output "$Repo\docs\baselines\v0.2.9\ui-ppt-manifest.json"
node scripts/compare_ui_baseline_runs.js --left "$Repo\.superpowers\sdd\baseline-run-a" --right "$Repo\.superpowers\sdd\baseline-run-b" --manifest "$Repo\docs\baselines\v0.2.9\ui-ppt-manifest.json"
Pop-Location

# UTF-8 replacement-character and tracked secret/host literal scans.
Set-Location -LiteralPath $Repo
rg -n '\x{FFFD}' --glob '!platform/node_modules/**' --glob '!platform/server/node_modules/**' .
$secretPatterns = @((('tvly' + '-') + '[A-Za-z0-9_-]{12,}'), (('sk' + '-') + '[A-Za-z0-9_-]{12,}'), 'BEGIN (RSA |OPENSSH )?PRIVATE KEY')
$secretHits = Get-ChildItem -LiteralPath $Repo -Recurse -File | Where-Object { $_.FullName -notmatch '[\\/](node_modules|\.git)[\\/]' } | Select-String -Pattern $secretPatterns
if ($secretHits) { $secretHits | ForEach-Object { "$($_.Path):$($_.LineNumber):<secret-like-value>" }; throw 'Secret-like value found in workspace content.' }
if (-not $env:TURINGMARKET_SERVER) { throw 'TURINGMARKET_SERVER is required for the protected-host literal scan.' }
$hostHits = Get-ChildItem -LiteralPath $Repo -Recurse -File | Where-Object { $_.FullName -notmatch '[\\/](node_modules|\.git)[\\/]' } | Select-String -SimpleMatch $env:TURINGMARKET_SERVER
if ($hostHits) { $hostHits | ForEach-Object { "$($_.Path):$($_.LineNumber):<protected-host-literal>" }; throw 'Protected production host literal found in tracked workspace content.' }

# Guarded deploy preflight tests. Production deploy is not run until Task 13.
Push-Location -LiteralPath "$Repo\platform\server"
node --test tests/public_static_security.test.js tests/frontend_public_assets.test.js tests/deployment_source_contract.test.js
Pop-Location
```

For RED steps, the focused command must fail for the named missing behavior, not for syntax, missing dependencies, wrong working directory, or leaked private configuration. / RED 步骤必须因明确缺失行为而失败，不得因语法、依赖、目录或私有配置问题失败。

---

### Task 1: Commit The Approved Phase 2 Design And Plan / 固化阶段 2 设计与计划

**Files / 文件：**

- Create / 创建：`docs/superpowers/specs/2026-07-13-phase-2-baseline-consolidation-design.md`
- Create / 创建：`docs/superpowers/plans/2026-07-13-phase-2-baseline-consolidation.md`

- [ ] Verify the documents contain the authoritative checkout, base commit, release name, locked PPT markers, three viewports, `0.005` threshold, duplicate/event/navigation boundaries, preview channel, public-asset contract, rollback, production deployment, and version-sync requirements. / 校验文档包含权威代码库、基线提交、版本名、锁定 PPT 标记、三个视口、`0.005` 阈值、重复/事件/导航边界、预览通道、公开资源契约、回滚、生产部署和版本同步要求。
- [ ] Ask an independent planning reviewer to return `APPROVE` or concrete gaps; fix every important gap. / 安排独立计划审查并取得 `APPROVE` 或明确问题，修复全部重要问题。
- [ ] Run `git diff --check` and inspect the exact diff. / 运行差异检查并核对完整变更。
- [ ] Commit the design/plan checkpoint before runtime edits. / 在运行时代码改动前提交设计/计划检查点。

---

### Task 2: Baseline Manifest Generator And Duplicate Inventory RED Tests / 基线清单生成器与重复定义清单 RED 测试

**Files / 文件：**

- Create / 创建：`platform/server/scripts/generate_ui_baseline_manifest.js`
- Create / 创建：`platform/server/tests/frontend_architecture_inventory.test.js`
- Create / 创建：`platform/server/tests/fixtures/frontend-active-definitions.json`
- Modify / 修改：`platform/server/package.json`

**Interfaces / 接口：**

- `scanClassicScripts([{ path, loadOrder }]) -> { declarations, duplicates, activeDefinitions }`
- `collectRouteContracts(serverFiles) -> [{ method, path, source }]`
- `generateManifest(options) -> JSON`
- CLI: `node scripts/generate_ui_baseline_manifest.js --baseline-version v0.2.9 --output <path>`.

- [ ] **RED:** Add tests that parse `app.js` then `ppt.js`, require the reviewed 39-name duplicate map, and prove active definitions for `closeCustModal`, `trackTokenUsage`, `initM1`, `initM4`, `downloadInfTemplate`, `addChatMsg`, `loadAdminDashboard`, `generateHTMLPPT`, and `esc`. / 添加测试，按加载顺序解析脚本，要求已审查的 39 项重复清单，并证明关键函数当前生效位置。
- [ ] **RED:** Require SHA-256 values for `index.html`, `app.js`, `ppt.js`, app/PPT build markers, script cache keys, route contracts, seed fixture version, viewport metadata, mask version, and screenshot slots. / 要求清单包含文件哈希、构建标记、脚本缓存键、路由契约、夹具版本、视口、遮罩版本和截图槽位。
- [ ] Run `node --test tests/frontend_architecture_inventory.test.js`; expect failure because the generator/fixture does not exist. / 运行聚焦测试并确认因生成器/夹具不存在而失败。
- [ ] **GREEN:** Implement the smallest deterministic parser/generator using Node built-ins and a structured scanner; do not add runtime dependencies or execute browser code. / 使用 Node 内置能力和结构化扫描实现最小确定性生成器，不增加运行时依赖，也不执行浏览器代码。
- [ ] Generate and review `frontend-active-definitions.json`; require explicit review when the active map changes. / 生成并审查当前生效定义夹具；清单变化必须显式复审。
- [ ] Run the focused test and `node --check` for the generator. / 运行聚焦测试与语法检查。

---

### Task 3: Deterministic Playwright Fixture And Pre-Edit Screenshots / 确定性 Playwright 夹具与改动前截图

**Files / 文件：**

- Create / 创建：`platform/server/tests/browser-baseline.config.js`
- Create / 创建：`platform/server/tests/browser-baseline.spec.js`
- Create / 创建：`platform/server/tests/fixtures/browser-baseline-data.json`
- Create / 创建：`platform/server/tests/fixtures/start_browser_fixture_server.js`
- Create / 创建：`platform/server/tests/helpers/browser_fixture.js`
- Create / 创建：`platform/server/scripts/compare_ui_baseline_runs.js`
- Create / 创建：`docs/baselines/v0.2.9/ui-ppt-manifest.json`
- Create / 创建：`docs/baselines/v0.2.9/screenshots/`
- Modify / 修改：`.gitignore`
- Modify / 修改：`platform/package.json`

**Interfaces / 接口：**

- Playwright projects: `fixture-1440`, `fixture-1920`, `fixture-mobile`.
- API interception uses `browser-baseline-data.json` version `v0.2.9-ui-fixture-1`.
- Screenshot path: `docs/baselines/v0.2.9/screenshots/<role>/<viewport>/<journey>.png`.
- Ignore only generated private storage state, test results, reports, temp DB, and production evidence; committed baseline PNGs remain tracked. / 仅忽略私有 storage state、测试结果、报告、临时数据库和生产证据；基线 PNG 必须提交。
- Baseline runner contract / 基线运行环境：Playwright `1.60.0`, Chromium `1223`, Windows, `Segoe UI` and `Microsoft YaHei`, `zh-CN`, `Asia/Shanghai`, `deviceScaleFactor: 1`.

- [ ] **RED:** Add browser tests for unauthenticated login, admin and ordinary-user nav visibility, every canonical page, CRM detail views, M4 tabs, admin tabs/KB, direct paths, refresh, back/forward, current focus baseline, and locked PPT bridge. / 添加浏览器测试覆盖登录态、角色导航、全部标准页面、CRM 子视图、M4 标签、管理员标签/知识库、直达、刷新、前进后退、当前焦点基线和锁定 PPT 桥接。
- [ ] **RED:** Require three viewport screenshots with disabled motion and masks for timestamps, IDs, users, contacts, customer/admin/AI/KB/workflow data, links, and secret-like strings; expect failure because fixtures/screenshots do not exist. / 要求三个视口截图及动态/私密信息遮罩，并确认因夹具/截图不存在而失败。
- [ ] **GREEN:** Start the real Express static app with an isolated temp DB; inject fake fixture auth state and intercept API calls with deterministic data. No production credentials are used. / 使用隔离临时数据库启动真实 Express 静态应用，注入夹具鉴权状态并用确定性数据拦截 API；不得使用生产凭据。
- [ ] `webServer` owns the fixture lifecycle: create ignored temp DB/log -> start real Express on the reserved port -> wait for `/api/health` -> capture -> stop child -> remove temp DB/log. Tests wait for `document.fonts.ready` and fail when browser revision, OS, locale, timezone, or required fonts differ from the manifest. / `webServer` 管理夹具生命周期；测试等待字体就绪，并在环境元数据变化时失败。
- [ ] Clean only the two known ignored run directories, capture run A and run B using `TM_BASELINE_OUTPUT_DIR`, then run the comparison command from the Exact Command Contract. / 仅清理两个已知忽略运行目录，通过 `TM_BASELINE_OUTPUT_DIR` 分别采集 A/B，再运行精确命令契约中的比较命令。
- [ ] Record run labels, environment metadata, per-PNG SHA-256 values, and `identical=true` in `ui-ppt-manifest.json`; promote run B to the committed screenshot directory only after comparison passes. / 在清单记录运行标签、环境、逐 PNG 哈希与 `identical=true`；仅比较通过后将 B 提升为提交基线。
- [ ] Replace the root `platform/package.json` placeholder with explicit scripts `test:browser:baseline`, `test:browser:baseline:update`, and `test:browser:baseline:compare`; do not alias them to the server Node suite. / 将根目录占位测试替换为明确的浏览器脚本，不得冒充后端 Node 套件。

---

### Task 4: Private Production GET-Only Baseline Evidence / 私有生产只读基线证据

**Files / 文件：**

- Create tracked sanitized helper / 创建可审计脚本：`platform/server/scripts/bootstrap_production_browser_state.js`
- Create tracked sanitized helper / 创建可审计脚本：`platform/server/scripts/capture_production_browser_baseline.js`
- Create tests / 创建测试：`platform/server/tests/production_browser_evidence_tools.test.js`
- Create ignored private state / 创建忽略私有状态：`.superpowers/sdd/phase-2-production-storage-state.json`
- Create private evidence / 创建私有证据：`$env:TM_PRIVATE_EVIDENCE_ROOT\2026-07-13-v0.3.0-pre-edit-production-baseline.md`
- Create private screenshots under / 私有截图目录：`$env:TM_PRIVATE_EVIDENCE_ROOT\2026-07-13-v0.3.0-pre-edit-screenshots\`

- [ ] **RED:** Add tests proving helper source contains no host/credential, accepts only environment-variable paths/URLs, redacts logs, enforces private output roots, rejects symlinks/outside paths, and destroys storage state/session on success or failure. / 添加测试证明脚本无主机/凭据字面量，仅接受环境变量路径/URL，日志脱敏，限制私有输出根目录，拒绝符号链接/越界路径，并在成功或失败时销毁状态/会话。
- [ ] Secure bootstrap reads the private credential manifest path from `TM_PRIVATE_CREDENTIAL_MANIFEST`, reads content in process memory, authenticates without command-line secrets or output, writes ignored storage state with restrictive permissions, and records no token. / 安全引导从环境变量读取私有凭据清单路径，在进程内读取内容，命令行和输出均不含密钥，写入受限且忽略的 storage state，不记录令牌。
- [ ] Production capture aborts on any request method other than GET/HEAD, any unexpected 5xx, console/page error, role mismatch, missing marker, or unmasked private/dynamic data. / 生产采集遇到非 GET/HEAD、意外 5xx、控制台/页面错误、角色不符、标记缺失或未遮罩私密/动态数据时立即失败。
- [ ] Capture redacted page evidence at all three viewports; do not commit production screenshots. / 在三个视口采集脱敏证据，不提交生产截图。
- [ ] Destroy the authenticated production session and private storage state after capture; verify the token no longer works. / 采集后销毁生产会话与私有 storage state，并验证令牌失效。
- [ ] Record only sanitized route/status/hash evidence in the private evidence note. / 私有证据笔记仅记录脱敏路由、状态和哈希。
- [ ] Exact private capture commands set `TM_PRODUCTION_BASE_URL`, `TM_PRIVATE_CREDENTIAL_MANIFEST`, `TM_PRODUCTION_STORAGE_STATE`, and `TM_PRODUCTION_EVIDENCE_DIR` in the PowerShell process, then run the two tracked scripts from `platform/server`; values are never echoed. / 精确私有采集命令仅在 PowerShell 进程中设置四个环境变量，并从 `platform/server` 运行两个可审计脚本；不得回显值。

---

### Task 5: Public Build Metadata And Exact Client Asset Allowlist / 公开构建信息与精确客户端资源白名单

**Files / 文件：**

- Create / 创建：`platform/client/shared/build_info.js`
- Create / 创建：`platform/server/tests/frontend_public_assets.test.js`
- Modify / 修改：`platform/index.html`
- Modify / 修改：`platform/server/services/public_assets_service.js`
- Modify / 修改：`platform/nginx/turingmarket.conf`
- Modify / 修改：`platform/deploy_v8.ps1`
- Modify / 修改：`platform/server/tests/public_static_security.test.js`

**Interfaces / 接口：**

- `window.TMBuild = Object.freeze({ app: "20260713-v030-baseline-consolidation", ppt: "20260702-v916-kb-bridge-client-cn" })`.
- Compatibility marker: `window.tmAppBuild = window.TMBuild.app`.
- Public exact path: `/client/shared/build_info.js`; all other `/client/` paths remain `404` until explicitly listed.

- [ ] **RED:** Add tests requiring the build-info script before `app.js`, exact Express/Nginx allowlisting, unknown client file `404`, deploy directory/upload/check/backup handling, new app marker/query, and unchanged PPT marker/query. / 添加测试要求构建信息脚本加载顺序、精确白名单、未知客户端文件 404、部署处理、新 app 标记/查询参数及不变的 PPT 标记/查询参数。
- [ ] The same RED test must reject `/client/`, `/client/core/`, `/client/shared/`, `/client/unknown.js`, `/client/../server/server.js`, encoded traversal, double-encoded traversal, and mixed slash/backslash traversal before any allowlist implementation is added. / 同一 RED 测试必须在实现白名单前拒绝目录、未知文件、路径穿越、编码/双重编码与混合分隔符穿越。
- [ ] Run focused tests; expect missing asset/allowlist failures. / 运行聚焦测试并确认预期失败。
- [ ] **GREEN:** Implement the exact asset route and build metadata; update `index.html` app cache key only. / 实现精确资源路由与构建信息，仅更新首页 app 缓存键。
- [ ] Run focused tests, public-static security tests, and syntax checks. / 运行聚焦测试、公开静态安全测试和语法检查。

---

### Task 6: Stable Page State, Deep Links, History, Role Gate, Focus, And Preview Marker / 稳定页面状态、深链接、历史、角色、焦点与预览标记

**Files / 文件：**

- Create / 创建：`platform/client/core/navigation.js`
- Create / 创建：`platform/server/tests/frontend_navigation_contract.test.js`
- Modify / 修改：`platform/app.js`
- Modify / 修改：`platform/index.html`
- Modify / 修改：`platform/server/services/public_assets_service.js`
- Modify / 修改：`platform/nginx/turingmarket.conf`
- Modify / 修改：`platform/deploy_v8.ps1`
- Modify / 修改：`platform/server/tests/frontend_public_assets.test.js`
- Modify / 修改：`platform/server/tests/public_static_security.test.js`
- Modify / 修改：`platform/server/tests/browser-baseline.spec.js`

**Interfaces / 接口：**

- `TMNavigation.stateFromLocation(location)` returns `{ pageId, substate, preview }`.
- `TMNavigation.pathForState(state)` returns the canonical path/query.
- `TMNavigation.navigate(pageId, { substate, replace, fromPopState, user })`.
- `TMNavigation.restore(user)` and one `popstate` binding.
- `switchPage(id)` remains the compatibility command used by existing inline handlers.

- [ ] **RED:** Unit/contract tests require the canonical path table, CRM/M4/admin substates, non-admin admin/KB fallback, unknown-path fallback, one popstate listener, push vs replace rules, deterministic focus target, and admin-only `?preview=v030` marker. / 添加单元/契约测试覆盖路径表、子状态、角色回退、未知路径、单一监听器、历史写入规则、焦点和管理员预览标记。
- [ ] **RED:** Browser tests require direct navigation, refresh, back/forward, page/substate restoration, role visibility, and heading focus at desktop/mobile widths; confirm current code fails. / 浏览器测试要求直达、刷新、前进后退、页面/子状态恢复、角色可见性和标题焦点，并确认当前代码失败。
- [ ] **GREEN:** Add the smallest classic-script navigation module, move the page registry/nav rebuild into it, keep a thin `switchPage` wrapper, and call one restore path after successful login/session restoration. / 增加最小经典脚本导航模块，将页面注册表/导航重建迁入，保留 `switchPage` 薄包装，并在登录/会话恢复后调用单一恢复入口。
- [ ] Wire `switchCrmView`, M4 `switchTab`, and `switchAdminTab` to URL substate without changing their DOM behavior or labels. / 将 CRM、M4、管理员子状态接入 URL，不改变 DOM 行为或名称。
- [ ] Re-run focused tests and the full fixture browser suite; screenshot differences must be zero or limited to approved nonvisual focus metadata. / 重跑测试与浏览器套件；截图差异必须为零，或仅包含获批的非视觉焦点元数据。

---

### Task 7: Duplicate Inventory Lock And Low-Risk Consolidation / 锁定重复清单并收敛低风险重复代码

**Files / 文件：**

- Modify / 修改：`platform/server/tests/frontend_architecture_inventory.test.js`
- Modify / 修改：`platform/server/tests/fixtures/frontend-active-definitions.json`
- Modify / 修改：`platform/app.js`

- [ ] **RED:** Change the inventory expectation for `closeCustModal`, `trackTokenUsage`, `addChatMsg`, `clearChat`, `loadAdminDashboard`, `adminResetPw`, and `adminCreateInvite` to exactly one active `app.js` definition while preserving function-body behavior contracts. / 将低风险函数清单改为只允许一个生效定义，同时保留函数体行为契约。
- [ ] Run the focused test; expect duplicate-count failures. / 运行聚焦测试并确认重复数量失败。
- [ ] **GREEN:** Delete only non-active legacy definitions; keep active implementations unchanged except formatting required by the test harness. / 仅删除非生效旧定义，除测试工具所需格式外不修改当前实现。
- [ ] Run syntax, focused, CRM, AI, admin, and full Node tests plus fixture screenshots. / 运行语法、聚焦、CRM、AI、管理员、完整 Node 与夹具截图测试。
- [ ] Commit this slice independently. / 独立提交该批次。

---

### Task 8: Brand Workspace Duplicate Consolidation / 品牌智库重复定义收敛

**Files / 文件：**

- Modify / 修改：`platform/server/tests/frontend_architecture_inventory.test.js`
- Modify / 修改：`platform/server/tests/brand_workspace_ui.test.js`
- Modify / 修改：`platform/server/tests/browser-baseline.spec.js`
- Modify / 修改：`platform/app.js`

- [ ] **RED:** Require one definition for `initM1`, `renderIndustryTree`, `filterBrands`, `filterByTag`, `filterByTreeTag`, `renderSearchHistory`, `renderBrands`, `toggleBrandSocial`, `switchPlatformTab`, `loadSocialForBrand`, and `exportBrandCSV`. / 要求品牌函数各保留一个定义。
- [ ] Add behavior assertions for search/history, tree tag selection, brand selection/detail, social action, competitor relation, copy-to-demand, KB status, and CSV output. / 增加品牌搜索、历史、标签树、选择/详情、社媒、竞品关系、进入需求、知识状态和 CSV 行为断言。
- [ ] Run focused tests and confirm duplicate failures. / 运行聚焦测试并确认重复失败。
- [ ] **GREEN:** Delete only the older `2244-2355` legacy block, preserving active definitions and globals. / 仅删除旧品牌代码块，保留当前生效实现与全局接口。
- [ ] Run brand/API/full Node tests and all `/m1` browser screenshots at three viewports. / 运行品牌/API/完整 Node 测试与三个视口的 `/m1` 截图。
- [ ] Commit this slice independently. / 独立提交该批次。

---

### Task 9: Influencer/M4 Duplicate Consolidation / 网红 M4 重复定义收敛

**Files / 文件：**

- Modify / 修改：`platform/server/tests/frontend_architecture_inventory.test.js`
- Modify / 修改：`platform/server/tests/influencer_workflow.test.js`
- Modify / 修改：`platform/server/tests/browser-baseline.spec.js`
- Modify / 修改：`platform/app.js`

- [ ] **RED:** Require one active definition for all M4 duplicate names, including init/load/match/render/import/template/select/export/Feishu/order/collaboration functions. / 要求全部 M4 重复函数各保留一个当前生效定义。
- [ ] Expand behavior assertions for the historical 19-column aliases, approved 20-column upload headers, template download headers, field search/filter, sticky table header, compact checkboxes, pre/post-filter export, selected export, Feishu CSV fallback, resource definition, order creation, and status update. / 扩展 19 列兼容、20 列表头、模板、字段搜索、固定表头、小型勾选框、筛选前后导出、选中导出、飞书 CSV 降级、资源定义、下单和状态更新断言。
- [ ] Run focused tests and confirm duplicate failures. / 运行聚焦测试并确认重复失败。
- [ ] **GREEN:** Delete the old M4 blocks while preserving the final active implementation and all existing labels/controls. / 删除旧 M4 代码块，保留最终生效实现及现有名称/控件。
- [ ] Run M4 API/full Node tests and three-viewpoint browser flows for list, import preview, filters, order modal, collaboration list, and Feishu fallback. / 运行 M4 API/完整 Node 测试及三个视口的列表、导入预览、筛选、下单弹窗、合作列表、飞书降级流程。
- [ ] Commit this slice independently. / 独立提交该批次。

---

### Task 10: PPT Ownership Contract And Remaining Duplicate Policy / PPT 所有权契约与剩余重复策略

**Files / 文件：**

- Modify / 修改：`platform/server/tests/frontend_architecture_inventory.test.js`
- Create / 创建：`platform/server/tests/ppt_bridge_browser_contract.test.js`
- Modify / 修改：`platform/server/tests/browser-baseline.spec.js`
- Modify / 修改：`platform/app.js`
- Do not modify behavior / 不修改行为：`platform/ppt.js`

- [ ] **RED:** Add one real browser ownership contract proving `generateHTMLPPT` after both scripts is the `ppt.js` implementation and, in the same test, preserving context files/instructions, AI outline fallback, HTML/PPTX download paths, preview/editor/copy, `ppt.js?v=20260702v916kbbridge`, and `window.tmPPTBuild = "20260702-v916-kb-bridge-client-cn"`. / 添加同一个真实浏览器所有权契约，证明加载后由 `ppt.js` 接管，并在同一测试中锁定全部 PPT 流程、缓存键和构建标记。
- [ ] Require the legacy `app.js` `generateHTMLPPT` definition to be absent. / 要求 `app.js` 旧 PPT 定义不存在。
- [ ] Run focused tests and confirm the inventory fails before deletion. / 运行聚焦测试并确认删除前失败。
- [ ] **GREEN:** Delete only the legacy `app.js` implementation. Do not edit `ppt.js`. / 仅删除 `app.js` 旧实现，不修改 `ppt.js`。
- [ ] Compare `app.js` and `ppt.js` `esc` output over an approved corpus. If byte-identical for every case, replace with one reviewed shared implementation; otherwise keep the cross-script collision as an explicit manifest exception with a test prohibiting any additional duplicate. / 对比两个 `esc` 在批准语料上的输出；若全部字节一致则统一，否则作为明确兼容例外保留并禁止新增重复。
- [ ] Run PPT browser contract, three-viewpoint demand/PPT screenshots, full Node tests, and exact PPT marker/hash checks. / 运行 PPT 浏览器契约、三个视口需求/PPT 截图、完整 Node 测试和 PPT 标记/哈希检查。
- [ ] Commit this slice independently. / 独立提交该批次。

---

### Task 11: Idempotent Workflow Initialization And Event Binding / 工作流初始化与事件绑定幂等化

**Files / 文件：**

- Create / 创建：`platform/server/tests/frontend_event_binding_contract.test.js`
- Modify / 修改：`platform/server/tests/browser-baseline.spec.js`
- Modify / 修改：`platform/app.js`

**Interfaces / 接口：**

- `initWorkflowDesigner()` may be called repeatedly but binds each canvas/palette/document listener once.
- Node rendering does not bind new document `mousemove`/`mouseup` listeners.

- [ ] **RED:** Instrument `addEventListener` in a browser test, enter workflow designer repeatedly, render/move nodes repeatedly, and require stable listener counts and one handler effect per event. / 在浏览器测试中监控监听器，重复进入工作流页面并重绘/移动节点，要求监听器数量稳定且每个事件只执行一次。
- [ ] Add a source contract prohibiting document drag listeners inside `wfRenderNode`. / 增加源码契约，禁止在 `wfRenderNode` 内注册文档拖拽监听器。
- [ ] Run focused tests and confirm current repeated binding fails. / 运行聚焦测试并确认当前重复绑定失败。
- [ ] **GREEN:** Add one initialization guard and centralize the document drag lifecycle with current state variables; preserve keyboard shortcuts and visible behavior. / 增加一次性初始化保护，使用当前状态变量集中处理文档拖拽生命周期，保留快捷键和可见行为。
- [ ] Run workflow API/browser tests, full Node tests, and workflow screenshots at all viewports. / 运行工作流 API/浏览器/完整 Node 测试及全部视口截图。
- [ ] Commit this slice independently. / 独立提交该批次。

---

### Task 12: Documentation, Deploy Alignment, And Post-Edit Baseline Comparison / 文档、部署统一与改动后基线对比

**Files / 文件：**

- Modify / 修改：`platform/DEPLOY.md`
- Modify / 修改：`CLAUDE_CODE_MIGRATION.md`
- Modify / 修改：`docs/handoff/2026-06-30/OPERATIONS.md`
- Modify / 修改：`docs/handoff/2026-06-30/ARCHITECTURE.md` if present / 如存在则修改
- Modify / 修改：`platform/deploy_v8.ps1`
- Modify / 修改：`docs/baselines/v0.2.9/ui-ppt-manifest.json`
- Modify / 修改：`platform/server/tests/public_static_security.test.js`
- Create / 创建：`platform/server/tests/deployment_source_contract.test.js`

- [ ] **RED:** Add documentation/deploy contract tests requiring the authoritative checkout/branch, Express 5 + `better-sqlite3`, current PM2 entry, client exact allowlist, preview marker, new app build, unchanged PPT bridge, versioned backup label, route smoke, remote full tests, and fail-closed rollback. / 添加文档/部署契约测试，要求权威代码库/分支、当前运行时、PM2 入口、客户端白名单、预览标记、app 构建、PPT 桥接、版本化备份、路由冒烟、远端全量测试与失败关闭回滚。
- [ ] The deploy contract is blocking: backup path is `backups/v030-baseline-consolidation-<timestamp>`, every created `/client/...` file is uploaded/backed up/checked, `-RollbackBackup` accepts only that prefix, deploy failure invokes the same restore path, and rollback restores code plus Nginx before health verification. / 部署契约是阻断项：备份路径固定为 v030 前缀，全部客户端文件纳入上传/备份/检查，回滚参数仅接受该前缀，部署失败调用同一恢复路径，并在健康验证前恢复代码与 Nginx。
- [ ] Run `node --test tests/public_static_security.test.js tests/frontend_public_assets.test.js tests/deployment_source_contract.test.js` from `platform/server`; confirm stale `sql.js`, old branch, `v0210-security`, missing client assets, and missing rollback behavior fail. / 从后端目录运行精确测试并确认历史内容失败。
- [ ] **GREEN:** Update documents and guarded deploy code without host/secrets; add all created files and remote checks. / 更新文档与受保护部署脚本，不写入主机/密钥，并加入全部新文件和远端检查。
- [ ] Re-run deterministic screenshots against the post-edit build and compare to pre-edit baseline at `maxDiffPixelRatio <= 0.005`; require an explicit record for any expected region. / 重跑改动后截图并按阈值比较；任何预期区域差异必须显式记录。
- [ ] Regenerate the manifest with post-edit app build, route, asset, and screenshot comparison results while retaining pre-edit hashes. / 重新生成清单，记录改动后 app 构建、路由、资源和截图对比，同时保留改动前哈希。

---

### Task 13: Independent Review, Full Verification, Release Records, And Production Deployment / 独立审查、完整验证、版本记录与生产部署

**Files / 文件：**

- Modify / 修改：`CHANGELOG.md`
- Create / 创建：`docs/version-records/2026-07-13-v0.3.0-baseline-consolidation.md`
- Create / 创建：`archive/versions/2026-07-13-v0.3.0-baseline-consolidation.md`
- Create Obsidian archive / 创建 Obsidian 归档：`$env:TM_OBSIDIAN_VERSION_ARCHIVE\2026-07-13-v0.3.0-baseline-consolidation.md`
- Create private deployment evidence / 创建私有部署证据：`$env:TM_PRIVATE_EVIDENCE_ROOT\2026-07-13-v0.3.0-deployment-evidence.md`

- [ ] Run `node --check` on every changed JS file, focused tests, full `npm test`, fixture Playwright at all viewports, `git diff --check`, UTF-8 scan, secret scan, and production-host-literal scan. / 运行全部语法、聚焦、完整 Node、三视口 Playwright、差异、编码、密钥和生产主机字面量检查。
- [ ] Confirm no unapproved duplicate remains, workflow listener counts are stable, app marker is aligned, PPT marker/query/hash remain locked, public/private paths pass, and screenshot diff is within threshold. / 确认重复定义、监听器、app 标记、PPT 锁定、公开/私密路径和截图阈值全部通过。
- [ ] Obtain independent `minimal-change-engineer` and `code-reviewer` `APPROVE`; also obtain frontend/browser QA approval for navigation, role, focus, and screenshot evidence. Resolve every critical/important finding and re-review. / 取得最小改动、代码审查与前端/浏览器 QA 批准，修复全部关键/重要问题并复审。
- [ ] Create a timestamped, checksummed production backup of changed code, Nginx, and a consistent SQLite backup. Verify restore commands before deployment. / 创建含校验和的生产备份，包含变更代码、Nginx 与一致性 SQLite 备份，并在部署前验证恢复命令。
- [ ] Deploy only from the authoritative branch through the guarded script. Verify remote syntax, Nginx, PM2, `/api/health`, static private-path `404`, exact client allowlist, routes, app marker, unchanged PPT marker/query, and remote full tests. / 仅从权威分支通过受保护脚本发布，验证远端语法、Nginx、PM2、健康、私密路径、客户端白名单、路由、app 标记、不变 PPT 标记/查询和远端完整测试。
- [ ] Run authenticated production critical-journey smoke for CRM board/detail, brand, strategy, demand/PPT shell and bridge, influencer import/template/filter/export/order/Feishu fallback, AI/KB references, workflow/tasks, admin AI audit, direct/refresh/back-forward/focus, and admin/non-admin visibility. Mutating checks use controlled disposable fixtures and are cleaned up. / 运行生产关键旅程冒烟；会产生写入的检查必须使用受控一次性夹具并清理。
- [ ] Capture post-deploy private redacted screenshots and compare to the approved fixture/production evidence; destroy capture session/state afterwards. / 采集上线后私有脱敏截图并对比，之后销毁采集会话和状态。
- [ ] Update CHANGELOG, repository record, archive record, Obsidian, and private evidence with the same release facts and verification results. / 用一致的版本事实与验证结果更新变更日志、仓库记录、归档、Obsidian 和私有证据。
- [ ] Commit intentionally, push the branch to GitHub, verify remote SHA, and report production verification and all sync targets. / 有意图地提交并推送 GitHub，校验远端 SHA，反馈生产验证与全部同步目标。

## Phase 2 Definition Of Done / 阶段 2 完成定义

Phase 2 is complete only when the pre-edit baseline and manifest exist, deterministic screenshots pass at all three viewports, the reviewed duplicate surface has been consolidated without behavior regression, navigation/deep links/refresh/back-forward/focus/role visibility are deterministic, workflow listener binding is idempotent, exact client public allowlists and preview marker are deployed, PPT behavior and marker remain unchanged, local/remote/browser tests pass, independent reviewers return `APPROVE`, production is verified, and the release is synchronized to CHANGELOG, repository records, Obsidian, Git, and GitHub. / 只有在改动前基线与清单完整、三个视口确定性截图通过、已审查重复范围无行为回归地完成收敛、导航/深链接/刷新/前进后退/焦点/角色可见性确定、工作流监听器幂等、客户端精确白名单与预览标记已部署、PPT 行为和标记不变、本地/远端/浏览器测试通过、独立审查均为 `APPROVE`、生产验证完成且版本同步至 CHANGELOG、仓库记录、Obsidian、Git 和 GitHub 后，阶段 2 才算完成。

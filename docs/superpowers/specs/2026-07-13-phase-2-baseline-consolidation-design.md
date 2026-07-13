# Phase 2 Baseline Consolidation Design / 阶段 2 基线收敛设计说明

**Status / 状态：** Approved roadmap elaboration / 已批准路线图的实施细化
**Release / 版本：** `v0.3.0-baseline-consolidation`
**Authoritative checkout / 权威代码库：** `C:\Users\29272\Documents\在线商务平台-github-sync`
**Base commit / 基线提交：** `9a591aa92e039f53a12ad7d5f098a26d0818bf08`

## 1. Purpose / 目标

Phase 2 creates one authoritative, regression-protected frontend/backend baseline before the planned product redesign and later CRM, campaign, AI/knowledge, influencer, workflow, and governance releases. It is a behavior-preserving consolidation release, not a visual redesign or a new business-feature release. / 阶段 2 在后续产品视觉升级、CRM、项目主线、AI/知识库、网红、工作流和治理版本之前，建立唯一权威且具备回归保护的前后端基线。本阶段以保持现有行为为原则，不进行大范围视觉重构，也不引入新的业务功能。

The approved master roadmap remains the product decision. This document converts it into concrete technical boundaries after codebase onboarding, minimal-change review, frontend inventory, product regression review, and browser-QA review. / 已批准的总路线图仍是产品决策依据；本文在代码盘点、最小改动审查、前端清单、产品回归范围和浏览器 QA 审查完成后，将路线图细化为可执行技术边界。

## 2. Current Baseline / 当前基线

- Runtime / 运行架构：Express 5 + `better-sqlite3`, PM2, Nginx, static classic scripts.
- Frontend entry order / 前端加载顺序：`index.html` -> `app.js?v=20260630authupload` -> `ppt.js?v=20260702v916kbbridge`.
- Locked PPT marker / 锁定 PPT 标记：`window.tmPPTBuild = "20260702-v916-kb-bridge-client-cn"`.
- Current test gate / 当前测试门槛：from `platform/server`, `npm test` passes `66/66` before Phase 2 edits. The master roadmap's earlier `36`-test statement is a historical planning snapshot; it is not the Phase 2 pre-edit gate. The root `platform/package.json` still has a failing placeholder `test` script and is never used as evidence until Task 3 replaces it with explicit browser commands. / 在 `platform/server` 目录执行 `npm test`，阶段 2 改动前为 `66/66`。总路线图中的 `36` 项是历史规划快照，不是本阶段改动前门槛；根 `platform/package.json` 仍是失败占位脚本，Task 3 明确替换浏览器命令前不得作为验证证据。
- Current scale / 当前规模：`app.js` 3917 lines, `index.html` 1396 lines, `server.js` 975 lines.
- Duplicate inventory / 重复定义清单：39 duplicated global names across `app.js` and the later-loaded `ppt.js`; the active implementation is currently determined by last-definition-wins behavior.
- Navigation / 导航：DOM-only `switchPage(id)` with no URL, history, refresh, or back/forward state model.
- Event risk / 事件风险：workflow designer initialization can add canvas/document listeners repeatedly when the page is re-entered or nodes are re-rendered.
- Documentation drift / 文档漂移：`CLAUDE_CODE_MIGRATION.md` still describes historical `sql.js`; production code and `DEPLOY.md` use `better-sqlite3`.

## 3. Invariants / 不可变约束

1. Keep the current page labels and role visibility unchanged: `客户看板`, `客户明细`, `行业品牌智库`, `客户策略规划`, `需求接入 & 方案生成`, `网红匹配 & 执行管理`, `AI 助手`, `流程设计`, `流程模板`, `流程实例`, `我的待办`, `管理控制室`. / 保留现有页面名称和角色可见性。
2. Keep CRM board and customer detail as separate pages. / 客户看板与客户明细继续保持为两个独立页面。
3. Preserve AI draft -> human edit/confirm -> final generation. / 保留 AI 草稿 -> 人工编辑/确认 -> 最终生成。
4. Preserve influencer template compatibility, import, filter, export, Feishu fallback, collaboration order, and status update behavior. / 保留网红模板兼容、导入、筛选、导出、飞书降级、合作下单和状态更新行为。
5. Preserve administrator-wide AI conversation audit and ordinary-user isolation. / 保留管理员全量 AI 对话审计与普通用户隔离。
6. Do not change `ppt.js` behavior, its cache key, or its build marker. / 不修改 `ppt.js` 行为、缓存键或构建标记。
7. New browser assets are public only through explicit Express and Nginx allowlists and the guarded deploy manifest. / 新增浏览器资源必须同时进入 Express、Nginx 明确白名单和受保护部署清单。
8. Production evidence must not disclose credentials, tokens, personal data, provider keys, or the protected host. / 生产证据不得泄露凭据、令牌、个人数据、供应商密钥或受保护主机。

## 4. Baseline Evidence Model / 基线证据模型

### 4.1 Committed deterministic baseline / 可提交的确定性基线

The committed visual baseline is generated from a sanitized Playwright fixture, not from raw production data. It uses the real static application and Express public-asset behavior while intercepting API responses with versioned deterministic fixtures. / 可提交视觉基线由脱敏 Playwright 夹具生成，不直接使用原始生产数据。测试使用真实静态应用与 Express 公开资源行为，同时用版本化确定性夹具拦截 API 响应。

Required viewports / 必需视口：

- `1440x900`
- `1920x1080`
- `390x844`

Browser determinism / 浏览器确定性：Playwright `1.60.0`, bundled Chromium `1223`, Windows baseline runner, available `Segoe UI` and `Microsoft YaHei` fonts, `deviceScaleFactor: 1`, `zh-CN`, `Asia/Shanghai`, light color scheme, reduced motion, disabled animations/transitions/caret, fixed API fixture data, explicit readiness selectors, `document.fonts.ready`, and `maxDiffPixelRatio <= 0.005`. The test fails rather than silently changing fonts, browser revision, locale, timezone, or operating-system baseline metadata. / 测试不得在字体、浏览器修订版、区域、时区或操作系统基线变化时静默更新截图，而应失败。

Playwright `webServer` owns fixture start, health wait, and process stop. Because Playwright force-terminates process trees on Windows, the outer baseline runner performs a guarded `finally` cleanup of the ignored temp DB and server logs after each capture. Two clean captures are written to separate ignored run directories and compared with Playwright-compatible `pixelmatch` threshold `0.2`; only file-set-complete captures with perceptual `maxDiffPixelRatio <= 0.005` are promoted to the committed screenshot directory. Both SHA-256 values, raw and perceptual differing-pixel counts, maximum channel delta, run labels, environment metadata, and the comparison result are recorded in the manifest. Exact hash identity is recorded but is not required when the bounded difference is caused by Chromium edge rasterization. / Playwright `webServer` 负责夹具启动、健康等待与进程停止；由于 Playwright 在 Windows 强制结束进程树，外层基线启动器在每次采集退出后的 `finally` 中执行受保护的临时 DB 和日志清理。两次干净采集写入不同忽略目录，使用与 Playwright 一致的 `pixelmatch` 阈值 `0.2` 比较；只有文件集合完整且感知差异 `maxDiffPixelRatio <= 0.005` 的采集才进入提交目录。清单同时记录两份 SHA-256、原始/感知差异像素数量、最大通道差、运行标签、环境信息与比较结果；若差异来自 Chromium 边缘栅格化且处于阈值内，则不强制 SHA 完全相同。

Committed artifacts / 提交产物：

- `docs/baselines/v0.2.9/ui-ppt-manifest.json`
- `docs/baselines/v0.2.9/screenshots/<role>/<viewport>/<journey>.png`
- screenshot SHA-256 values, viewport metadata, mask version, fixture version, route matrix, current application hashes, and build markers in the manifest.

The directory remains named `v0.2.9` because that is the approved UI/PPT baseline label. The manifest also records `v0.2.10-security-credential-rotation` as the security base commit; Phase 1 changed security behavior without an approved UI/PPT change. / 目录继续使用已批准的 UI/PPT 基线标签 `v0.2.9`；清单同时记录 `v0.2.10-security-credential-rotation` 为安全基线，因为阶段 1 未进行获批的 UI/PPT 改动。

### 4.2 Private production evidence / 私有生产证据

Production capture is a separate, redacted, GET/HEAD-only browser pass after secure authentication state bootstrap. The sanitized bootstrap/capture implementation is tracked under `platform/server/scripts/`; only credentials, storage state, screenshots, and reports are ignored/private. The bootstrap reads the private credential manifest path from an environment variable and its content in process memory, never places secrets in command arguments or logs, writes ignored private storage state, and destroys the session/state after capture. / 生产采集是独立的脱敏浏览器流程；可审计的引导/采集代码提交在 `platform/server/scripts/`，仅凭据、storage state、截图和报告保持忽略/私有。引导脚本从环境变量读取私有凭据清单路径并在进程内读取内容，不将密钥放入命令参数或日志，写入被忽略的私有 storage state，并在采集后销毁会话与状态文件。

Production screenshots are stored only in the restricted private evidence area. The committed screenshots always come from the sanitized fixture. / 生产截图仅保存在受限私有证据区；仓库提交的截图始终来自脱敏夹具。

## 5. Frontend Consolidation Architecture / 前端收敛架构

### 5.1 Compatibility-first module boundary / 兼容优先的模块边界

Phase 2 keeps classic scripts and inline handler compatibility. It does not convert the whole application to a bundler or framework. / 阶段 2 继续使用经典脚本并兼容现有 inline handler，不将整个平台迁移到打包器或新框架。

Create incrementally / 分步创建：

- `platform/client/shared/build_info.js`: authoritative application build metadata; keeps `window.tmAppBuild` as the compatibility marker.
- `platform/client/core/navigation.js`: page registry, path mapping, history integration, role-aware route restoration, focus target, and preview flag.
- Later modules are created only when an active implementation is actually extracted with tests. / 仅当某个当前生效实现具备测试并被实际拆出时，才创建后续模块。

Compatibility contract / 兼容契约：

```text
window.TMBuild.app
window.TMNavigation.pageRegistry
window.TMNavigation.stateFromLocation(location)
window.TMNavigation.pathForState(state)
window.TMNavigation.navigate(pageId, options)
window.TMNavigation.restore(currentUser)
window.TMNavigation.updateSubstate(key, value, options)
window.switchPage(pageId)  // compatibility wrapper remains
```

`app.js` remains the owner of current business functions during Phase 2 unless a focused extraction is demonstrably smaller and safer. Duplicate legacy blocks are removed while the active implementation remains byte-for-byte or behaviorally equivalent. / 阶段 2 中，除非聚焦拆分明显更小且更安全，当前业务函数仍由 `app.js` 管理。删除重复旧代码时保留当前生效实现的字节级或行为级等价性。

### 5.2 Stable route state / 稳定路由状态

Canonical paths / 标准路径：

| Path | Page id | Label |
|---|---|---|
| `/`, `/m0` | `m0` | 客户看板 |
| `/m0-detail` | `m0-detail` | 客户明细 |
| `/m1` | `m1` | 行业品牌智库 |
| `/m2` | `m2` | 客户策略规划 |
| `/m3` | `m3` | 需求接入 & 方案生成 |
| `/m4` | `m4` | 网红匹配 & 执行管理 |
| `/m5` | `m5` | AI 助手 |
| `/workflow` | `workflow-designer` | 流程设计 |
| `/workflow-templates` | `workflow-templates` | 流程模板 |
| `/workflow-instances` | `workflow-instances` | 流程实例 |
| `/tasks` | `workflow-tasks` | 我的待办 |
| `/admin` | `admin` | 管理控制室 |
| `/kb` | `admin` + `tab=knowledge` | 管理员知识库入口 |

Supported substates / 支持子状态：

- `/m0-detail?view=pipeline|seapool|opportunities`
- `/m4?tab=tab1|tab2|tab3`
- `/admin?tab=overview|users|knowledge|ai-audit|tokens`

Unknown paths/states fall back to `/m0`; a non-admin requesting `/admin` or `/kb` is routed to `/m0` without rendering the admin page. User clicks push history; initialization and invalid-state normalization replace history; `popstate` restores without writing another history entry. / 未知路径或状态回退到 `/m0`；普通用户请求 `/admin` 或 `/kb` 时回到 `/m0`，不得渲染管理员页面。用户点击写入历史记录，初始化与无效状态规范化使用替换，`popstate` 恢复时不得再次写入历史。

After activation, focus moves to the page's first `h2` using temporary `tabindex=-1` and `preventScroll`, with no visual change. / 页面激活后将焦点移动到首个 `h2`，使用临时 `tabindex=-1` 与 `preventScroll`，不产生视觉变化。

### 5.3 Preview channel / 预览通道

`?preview=v030` is an inert, admin-only client preview marker. It is enabled only after `/api/auth/me` confirms the current user is an administrator and sets `document.documentElement.dataset.tmPreview = "v030"`. It changes no UI in Phase 2; Phase 3 may attach approved visual changes to this marker before public activation. / `?preview=v030` 是不改变界面的管理员客户端预览标记。只有 `/api/auth/me` 确认管理员身份后才设置 `document.documentElement.dataset.tmPreview = "v030"`；阶段 2 不通过该标记改变 UI，阶段 3 可在公开启用前挂载已批准视觉改动。

## 6. Duplicate Consolidation / 重复定义收敛

All 39 duplicated global names are recorded in an executable inventory test. Removal proceeds in small groups, always preserving the current last active implementation. / 39 个重复全局名称全部进入可执行清单测试；按小组删除旧定义，并始终保留当前最后生效实现。

Order / 顺序：

1. CRM/modal and utility: `closeCustModal`, `trackTokenUsage`.
2. Brand workspace legacy block: `initM1`, tree/filter/history/render/social/export functions.
3. Influencer/M4 legacy blocks: init/load/match/render/import/template/export/Feishu/order/collaboration functions.
4. AI and admin legacy blocks: chat helpers, dashboard, reset, invite.
5. Remove legacy `app.js` `generateHTMLPPT` only after a browser contract proves the later `ppt.js` bridge owns the active function.
6. Keep the intentional `esc` collision until PPT tests prove replacing it with one shared compatibility implementation has zero output difference; otherwise document it as an explicit cross-script compatibility exception for Phase 2. / 仅在 PPT 测试证明统一实现输出完全一致时处理 `esc`；否则将其记录为阶段 2 的跨脚本兼容例外。

The executable inventory fails if an unapproved duplicate appears or if an expected active implementation moves without a reviewed manifest update. / 若出现未批准的新重复定义，或当前生效实现未经审查发生移动，可执行清单必须失败。

## 7. Initialization And Event Binding / 初始化与事件绑定

Navigation initialization becomes one idempotent path after authentication: confirm user -> apply role visibility -> restore URL state -> initialize active page. Existing data preload remains but must not select a different page. / 导航初始化在鉴权后收敛为单一路径：确认用户 -> 应用角色可见性 -> 恢复 URL 状态 -> 初始化当前页面。现有数据预加载继续保留，但不得选择其他页面。

Workflow designer bindings receive one explicit guard and one document-level drag lifecycle. Re-entering the page or re-rendering nodes must not increase listener counts or execute handlers multiple times. / 工作流设计器增加明确的一次性绑定保护和单一文档级拖拽生命周期；重复进入页面或重绘节点不得增加监听器数量或重复执行处理器。

## 8. Public Assets And Deployment / 公开资源与部署

Only these Phase 2 browser files are newly public initially / 初始仅公开以下阶段 2 浏览器文件：

- `/client/shared/build_info.js`
- `/client/core/navigation.js`

Express registers exact file routes. Nginx adds exact locations for those files and denies every other `/client/` path. Contract tests deny `/client/`, directory paths, unknown JavaScript, traversal, encoded traversal, and mixed-separator traversal. `deploy_v8.ps1` creates the matching directories, uploads the same files, checks syntax, verifies hashes/build markers, and backs up any prior copies. / Express 注册精确文件路由；Nginx 为上述文件增加精确 location，并拒绝其他所有 `/client/` 路径。契约测试必须拒绝 `/client/`、目录路径、未知 JavaScript、路径穿越、编码穿越和混合分隔符穿越。部署脚本创建对应目录、上传同一文件、执行语法与哈希/构建标记校验，并备份已有版本。

The deployment source remains the authoritative `github-sync` checkout. The phase also corrects stale branch/runtime text in `platform/DEPLOY.md`, `CLAUDE_CODE_MIGRATION.md`, and handoff documentation without recording secrets. / 发布源继续固定为权威 `github-sync` 工作树；本阶段同步修正部署指南、迁移文档与交接文档中的旧分支和旧运行时描述，且不记录密钥。

## 9. Test And Release Gates / 测试与发布门槛

Required before production / 上线前必须完成：

- focused frontend architecture, duplicate inventory, navigation, event binding, public asset, and build-marker tests;
- full Node suite;
- fixture Playwright journeys at all three viewports;
- private redacted production GET/HEAD-only capture;
- `node --check`, `git diff --check`, UTF-8 and secret scans;
- screenshot diff `<= 0.005` or an explicitly approved visual-change record;
- independent `minimal-change-engineer` and `code-reviewer` approvals;
- guarded production backup, deploy, PM2/Nginx/health checks, remote full tests, authenticated critical-journey smoke, PPT marker verification, and post-deploy screenshot comparison;
- synchronized `CHANGELOG.md`, repository version record, Obsidian archive, Git commit, and GitHub push.

## 10. Explicit Non-Goals / 明确不做

- No broad visual redesign or design-token migration; that starts in Phase 3. / 不进行大范围视觉重构或设计令牌迁移，相关工作从阶段 3 开始。
- No organization/campaign schema, CRM stage redesign, AI-run redesign, vector database, real Feishu provider hardening, settlement cockpit, or entitlement system. / 不引入组织/项目结构、CRM 阶段重构、AI 运行模型重构、向量库、真实飞书供应商强化、结算驾驶舱或权益系统。
- No change to production secrets or user credentials unless required by separate security evidence. / 除非独立安全证据要求，否则不变更生产密钥或用户凭据。
- No refactor of historical `server_full.js`; record its nonproduction hardening follow-up separately. / 不重构历史 `server_full.js`，其非生产安全加固作为独立后续事项记录。

## 11. Rollback / 回滚

Every production deployment creates `backups/v030-baseline-consolidation-<timestamp>` with changed files (including all new `client/` assets), Nginx configuration, the SQLite database through a consistent backup operation, and checksums. `platform/deploy_v8.ps1 -RollbackBackup backups/v030-baseline-consolidation-<timestamp>` is the reviewed code/Nginx rollback command and validates the allowed prefix before restoring. A failed deploy automatically invokes the same restore path before returning failure. Roll back code/Nginx as one set if health, auth, route, browser, or remote test gates fail. Do not restore old security credentials or stale sessions. / 每次生产发布创建 `backups/v030-baseline-consolidation-<timestamp>`，包含变更文件（包括全部新增 `client/` 资源）、Nginx、一致性 SQLite 备份和校验和。经审查的回滚命令为 `platform/deploy_v8.ps1 -RollbackBackup backups/v030-baseline-consolidation-<timestamp>`，恢复前必须校验允许的前缀；部署失败自动调用同一路径后再返回失败。健康、鉴权、路由、浏览器或远端测试失败时，代码与 Nginx 成组回滚；不得恢复旧安全凭据或旧会话。

# Phase 3 Product Shell Design / 第 3 阶段产品壳层设计

## Approval / 批准

The user approved Scheme A and the bilingual V1 roadmap before implementation. For Phase 3, Scheme A is concretized as the Agency Operations Console described in `docs/product/2026-07-ux-audit.md` and `docs/product/turingmarket-design-system.md`. / 用户已在实施前批准方案 A 与中英双语 V1 路线图；第 3 阶段将方案 A 具体化为上述两份产品文档中的“代理机构运营工作台”。

## Goal / 目标

Replace the layered glass shell with a behavior-preserving, responsive operating shell and an explicitly tested shared-accessibility baseline while leaving domain workflows and the frozen PPT bridge unchanged. / 将叠加玻璃风格替换为不改变业务行为的响应式运营壳层，并建立经过明确测试的共享无障碍基线，同时保持业务流程和冻结 PPT bridge 不变。

## Architecture / 架构

1. Keep the legacy inline CSS as a compatibility layer for domain pages. Load three explicit public stylesheets afterward: `tokens.css`, `components.css`, and `layout.css`. / 保留旧内联 CSS 作为业务兼容层，在其后加载三份显式公开样式。
2. Add `client/core/shell.js` as the sole owner of mobile drawer state, focus trapping/restoration, active mobile title, Escape handling, and idempotent initialization. / 新增唯一移动壳层状态管理模块。
3. Add `client/core/accessibility.js` as an idempotent shared enhancer for generated label association, tab keyboard patterns, upload activation, dialog semantics/focus, live-region initialization, decorative icon treatment, and document-title updates. / 新增幂等共享无障碍增强模块，负责动态标签关联、标签页键盘模式、上传激活、弹窗语义与焦点、实时区域初始化、装饰图标及页面标题更新。
4. Keep `client/core/navigation.js` as the route/state owner, but render grouped canonical native anchors and maintain `aria-current`; labels, order, routes, and permissions remain unchanged. Plain clicks keep SPA behavior while modifier/middle clicks remain native. / 路由状态仍由导航模块管理，但改用带规范 URL 的分组原生链接和 `aria-current`；名称、顺序、路由和权限保持不变，普通点击保留 SPA 行为，组合键/中键保留原生行为。
5. Expand Express, Nginx, backup, candidate, and online smoke allowlists only for the five new exact assets. The registered client boundary remains seven assets in total. / Express、Nginx、备份、候选和线上冒烟仅新增五个精确资产，公开客户端边界总计保持七个资产。

## Behavior / 行为

- Desktop navigation remains persistently visible. Mobile navigation is closed by default and overlays rather than displaces content. / 桌面导航常驻；移动导航默认关闭并覆盖而非挤出内容。
- Authentication visibility remains authoritative: responsive CSS must not force `#app` visible when its inline/application state is hidden. / 鉴权可见性保持权威，响应式 CSS 不得在应用隐藏 `#app` 时强制显示。
- Existing `switchPage`, deep links, refresh, back/forward, role gates, CRM substates, M4 tabs, admin tabs, and preview marker remain unchanged. / 既有导航、子状态和角色门禁不变。
- Mobile navigation closes after a route is applied, on backdrop/close/Escape, and after desktop breakpoint transition. / 移动导航在路由、遮罩、关闭、Escape 和进入桌面断点时关闭。
- Shell controls are keyboard reachable and focus returns to the toggle after close. / 壳层控件可键盘操作，关闭后焦点回到触发器。
- Login has persistent labels, `name`/`autocomplete`, inline announced errors, first-invalid focus, and username focus after session expiry. / 登录具备持久标签、name/autocomplete、可播报行内错误、首个错误控件聚焦和会话过期后的用户名聚焦。
- Shared tabs, upload surfaces, dialogs, toasts, checkboxes, workflow palette items, and workflow nodes receive the scoped keyboard/name/status contracts in the design system. / 共享标签页、上传区、弹窗、Toast、复选框、流程组件和流程节点遵循设计系统规定的键盘、名称和状态契约。

## Failure And Edge Handling / 失败与边界

- `shell.js` exits safely when shell nodes are absent, initializes once, and does not depend on authenticated API data. / 缺少节点时安全退出，只初始化一次，不依赖鉴权 API 数据。
- CSS keeps internal table overflow and modal/drawer scrolling; long labels use `min-width:0`, wrapping, and truncation where appropriate. / 表格、弹窗和抽屉内部管理溢出，长标签使用最小宽度、换行或截断。
- The mobile shell must not use `display: block !important` on `#app`; logged-out and expired-session states remain visually isolated behind `#authOverlay`. / 移动壳层不得对 `#app` 使用强制 display；未登录和会话过期状态保持隔离。
- Reduced-motion users receive no shell/page transform animation. / 减少动画用户不接收壳层和页面位移动画。
- Dialogs and drawers remain operable at `320px` and `400%` zoom; the light panel border is never the sole control boundary. / 弹窗与抽屉在 `320px` 和 `400%` 缩放下仍可操作，浅色面板边框不得作为控件唯一边界。
- Full keyboard connection authoring in the legacy workflow canvas is explicitly deferred; Phase 3 provides only keyboard add/select alternatives and does not claim complete WCAG conformance for that canvas. / 旧流程画布的完整键盘连线创作明确延后；第 3 阶段仅提供键盘添加/选择替代，不宣称该画布已完整符合 WCAG。

## Test Strategy / 测试策略

- Node contracts first: exact assets, load order, tokens including `--tm-color-control-border:#8a94a3`, semantic markup, build markers, deploy manifests, and denial of encoded/unknown client paths. / 先写 Node 契约测试覆盖资产、顺序、令牌（含控件边界令牌）、语义、构建和部署边界。
- Browser tests second: desktop non-overlap, mobile drawer, native navigation modifier behavior, keyboard tabs/upload/workflow basics, dialog/Escape/focus restoration/inert, login error/expiry focus, live status, checkbox names/targets/indeterminate, no document overflow, sticky headers, reduced motion, axe, `320px`, and `200%`/`400%` zoom. / 再写浏览器测试覆盖桌面、移动、原生导航组合键、键盘标签页/上传/流程基础、弹窗与焦点、登录错误/过期焦点、实时状态、复选框名称/目标/半选、溢出、粘性表头、减少动画、axe、`320px` 与缩放。
- Visual evidence: capture all 72 deterministic journeys after implementation and compare against the pre-audit run with an explicit approved shared-shell change record. / 实施后重新采集 72 条旅程，并以明确批准的共享壳层变更记录对比。
- Production: guarded backup/deploy, remote Node/browser gates, three-viewport authenticated smoke, static boundary, logout/revocation, and session count zero. / 生产执行受保护备份部署、远端门禁、三视口鉴权冒烟、静态边界、退出吊销和会话清零。

## Non-Goals / 非目标

No schema/API change, CRM flow redesign, AI/RAG change, influencer workflow data change, Feishu change, full workflow-designer redesign, or PPT change belongs to this release. Shared keyboard and semantic corrections do belong to this release. / 本版本不改变数据库/API、CRM 流程、AI/RAG、网红业务数据、飞书、完整流程设计器构成或 PPT；共享键盘与语义修正属于本版本范围。

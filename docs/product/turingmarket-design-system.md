# TuringMarket Design System / 图灵商务设计系统

## Direction / 方向

Direction A, Agency Operations Console, is the approved V1 visual foundation. It is a quiet, dense operating surface for overseas influencer-agency sales, strategy, sourcing, execution, and administration. / 方向 A“代理机构运营工作台”是 V1 已批准视觉基础，服务海外红人营销代理机构的销售、策略、提报、执行和管理高频工作。

## Principles / 原则

1. Work before decoration / 工作优先于装饰：no gradient background, decorative orb, blur layer, or floating page section. / 不使用渐变背景、装饰圆形、模糊层或悬浮页面分区。
2. Scan before browse / 扫描优先于浏览：dense tables, stable columns, short labels, tabular numbers, and visible status. / 使用高密度表格、稳定列、短标签、等宽数字和可见状态。
3. One action hierarchy / 单一操作层级：blue for primary action, neutral for secondary, red only for destructive action. / 蓝色仅用于主操作，中性色用于次操作，红色仅用于破坏性操作。
4. Behavior remains stable / 行为稳定：shared styling never changes domain data contracts, route state, role gates, or AI/PPT confirmation flow. / 共享样式不改变业务数据契约、路由状态、角色门禁或 AI/PPT 确认流程。
5. Mobile reveals the task first / 移动端先显示任务：navigation is off-canvas and never displaces the active page. / 导航使用抽屉，不能挤出活动页。

## Token Contract / 令牌契约

### Color / 颜色

| Token | Value | Use / 用途 |
| --- | --- | --- |
| `--tm-color-canvas` | `#f5f7fa` | Application background / 应用背景 |
| `--tm-color-surface` | `#ffffff` | Work surface / 工作面 |
| `--tm-color-surface-subtle` | `#f8f9fb` | Secondary rows and toolbars / 次级行与工具栏 |
| `--tm-color-border` | `#d0d5dd` | Panel and row separation only / 仅用于面板与行分隔 |
| `--tm-color-border-strong` | `#c7cdd5` | Strong panel separation / 强面板分隔 |
| `--tm-color-control-border` | `#8a94a3` | Control boundary; 3.07:1 against white / 控件边界，与白色对比度 3.07:1 |
| `--tm-color-text` | `#101828` | Primary text / 主文本 |
| `--tm-color-text-muted` | `#667085` | Secondary text / 次文本 |
| `--tm-color-accent` | `#2563eb` | Primary action / 主操作 |
| `--tm-color-accent-hover` | `#1d4ed8` | Primary hover / 主操作悬停 |
| `--tm-color-success` | `#18794e` | Success / 成功 |
| `--tm-color-warning` | `#b54708` | Warning / 警告 |
| `--tm-color-danger` | `#b42318` | Destructive/error / 破坏与错误 |
| `--tm-color-focus` | `#2563eb` | Focus ring / 焦点环 |

### Type / 字体

- Family / 字体族: system UI, `PingFang SC`, `Microsoft YaHei`, sans-serif.
- Page title / 页面标题: 28 px, 700, line-height 1.25.
- Section title / 分区标题: 18 px, 700, line-height 1.35.
- Body / 正文: 14 px, 400, line-height 1.55.
- Dense UI / 高密度界面: 12-13 px, minimum 12 px.
- Letter spacing / 字距: `0` for all UI text. / 所有 UI 文本为 `0`。
- Numeric comparisons use `font-variant-numeric: tabular-nums`. / 数值比较使用等宽数字。

### Space, Radius, Elevation / 间距、圆角、层级

- Space / 间距: `4, 8, 12, 16, 20, 24, 32` px.
- Radius / 圆角: `4` compact, `6` control, `8` panel, `10` overlay; pills only for tags/status/segmented controls. / 仅标签、状态和分段控件使用胶囊。
- Shadow / 阴影: one restrained panel shadow, `0 1px 2px rgba(16,24,40,.06)`; drawers may use `0 12px 32px rgba(16,24,40,.18)`. / 面板只使用克制阴影，抽屉可使用较强层级阴影。

## Shell / 壳层

- Desktop `>= 901 px`: 224 px navigation rail, full viewport height, internal nav scrolling, 24 px main padding, and a maximum 1520 px work area. / 桌面使用 224 px 导航栏、全高、内部滚动、24 px 主区间距和最大 1520 px 工作区。
- Mobile `<= 900 px`: 56 px sticky top bar, sidebar closed by default, drawer width `min(320px, 86vw)`, backdrop, Escape close, focus trap, and focus restoration. / 移动使用 56 px 顶栏、默认关闭抽屉、遮罩、Escape、焦点限制和焦点恢复。
- Main content must have `min-width: 0`; viewport-level horizontal scrolling is forbidden. / 主内容必须 `min-width:0`，禁止整页横向滚动。
- The active page title appears in the mobile bar and updates on `tm:navigation-applied`. / 移动顶栏展示活动页标题，并随导航事件更新。

## Shared Components / 共享组件

### Navigation / 导航

- Native `<a href>` with a canonical route, 40 px row, visible hover/focus, and `aria-current="page"` on the active entry. Plain primary clicks may be intercepted for SPA navigation; modifier and middle clicks retain native browser behavior. Icons are decorative with `aria-hidden="true"`. / 使用带规范路由的原生 `<a href>`、40 px 行高、可见悬停/焦点和活动项 `aria-current`；普通主键点击可由 SPA 接管，组合键和中键保留浏览器原生行为；装饰图标使用 `aria-hidden="true"`。
- Preserve route order and labels while grouping the rail into `客户经营`, `方案与执行`, `流程协作`, and administrator-only `系统管理`. Group labels are non-interactive and the system label follows the existing administrator visibility hook. / 保持路由顺序和名称，同时分为“客户经营”“方案与执行”“流程协作”和仅管理员可见的“系统管理”；分组标题不可交互，系统分组沿用既有管理员可见性钩子。
- Role visibility remains controlled by existing `admin-only visible` hooks. / 角色可见性继续沿用既有钩子。

### Buttons / 按钮

- Default 36 px height, compact 32 px, radius 6 px. / 默认高 36 px，紧凑 32 px，圆角 6 px。
- Icon-only buttons require `aria-label` and `title`; destructive actions require confirmation. / 纯图标按钮必须有 `aria-label` 和 `title`，破坏性操作必须确认。

### Inputs / 输入

- Default 38 px height, visible programmatically associated label, radius 6 px, `--tm-color-control-border`, and a 2 px focus ring. The lighter panel border cannot be the sole visible control boundary. / 默认高 38 px、可见且程序化关联的 label、圆角 6 px、控件边界令牌和 2 px 焦点环；较浅面板边框不得作为控件唯一可见边界。
- Checkbox/radio glyph reset: width and height 16 px, no inherited full width, and `accent-color` uses the accent token. The interactive target is at least `24x24` on desktop and `44x44` on mobile. Every control has an associated label or `aria-label`; select-all synchronizes checked and `indeterminate` states. / 复选框/单选框图形固定 16 px且不继承全宽；桌面交互目标至少 `24x24`、移动至少 `44x44`；每个控件具备关联 label 或 `aria-label`，全选同步 checked 与 `indeterminate` 状态。

### Tabs And Upload / 标签页与上传

- Shared tab sets expose `tablist`/`tab`/`tabpanel`, one roving `tabindex="0"`, `aria-selected`, Arrow Left/Right or Up/Down navigation according to orientation, Home/End, and Enter/Space activation. / 共享标签页使用 `tablist`/`tab`/`tabpanel`、单一漫游 `tabindex="0"`、`aria-selected`，按方向支持方向键、Home/End 及 Enter/Space。
- File-upload surfaces are backed by a labelled file input and activate from keyboard with Enter/Space; drag-and-drop remains an enhancement rather than the only path. / 文件上传区由带标签的文件输入支撑并支持 Enter/Space，拖放只是增强路径而不是唯一入口。

### Tables / 表格

- 40 px target row, sticky header, solid surface background, 1 px row separators. / 目标行高 40 px、粘性表头、实色背景和 1 px 行分隔。
- Container owns horizontal overflow; mobile tables may be wider than the viewport but the document may not. / 横向滚动由表格容器承担，移动表格可宽于视口但文档不可横向滚动。
- Header text does not use negative spacing; numeric columns use tabular numbers. / 表头不使用负字距，数值列使用等宽数字。

### Modal And Drawer / 弹窗与抽屉

- Radius 8 px, `max-height: calc(100dvh - 32px)`, internal scrolling, `overscroll-behavior: contain`. / 圆角 8 px、限制动态视口高度、内部滚动并阻止滚动穿透。
- Mobile width `calc(100vw - 24px)` unless the surface is the navigation drawer. / 移动宽度为视口减 24 px，导航抽屉除外。
- Dialog markup carries `role="dialog"`, `aria-modal="true"`, and `aria-labelledby`; opening moves focus inside, traps focus, makes the background inert, supports Escape, and returns focus to the opener. / 弹窗具备 dialog 语义和标题关联；打开后焦点进入并限制在弹窗内、背景不可交互、支持 Escape，关闭后焦点返回触发器。
- Drawer/dialog layout must remain operable at a `320px` viewport and `400%` zoom without two-dimensional document scrolling. / 抽屉和弹窗在 `320px` 视口及 `400%` 缩放下仍可操作，且文档不产生双向滚动。

### Status / 状态

- `.tm-state-loading`: neutral live status with `aria-live="polite"`. / 中性实时加载状态。
- `.tm-state-empty`: quiet empty state with one next action. / 克制空状态和单一下一步操作。
- `.tm-state-error`: danger border/text plus a concrete recovery action. / 错误边框/文字及明确恢复操作。
- Toast container is non-live. Each toast message owns exactly one live role: `role="status"` for success/information or `role="alert"` for errors. Toasts remain manually closeable and the persistent queue is bounded to the newest three messages. / Toast 容器本身不是实时区域；每条消息单独使用一个实时角色，成功/信息使用 `status`，错误使用 `alert`；通知可手动关闭，持久队列最多保留最新三条。
- Login errors render inline, are connected with `aria-describedby`, and use an announced live region; invalid submission focuses the first invalid control and session expiry focuses username. / 登录错误行内显示，通过 `aria-describedby` 关联并由实时区域播报；无效提交聚焦首个错误控件，会话过期聚焦用户名。

### Workflow Keyboard Baseline / 流程键盘基线

- In Phase 3, workflow palette items activate with Enter/Space to add a node at the canvas center, and existing nodes are keyboard focusable/selectable. Full keyboard connection authoring and workflow-designer composition remain a Phase 4 domain deliverable. / 第 3 阶段中，流程组件支持 Enter/Space 在画布中心添加节点，现有节点可键盘聚焦/选择；完整键盘连线创作和流程设计器构成仍由第 4 阶段交付。

## Motion And Focus / 动画与焦点

- Transitions list exact properties; `transition: all` is prohibited in new shared CSS. / 新共享 CSS 禁止 `transition: all`。
- `prefers-reduced-motion: reduce` disables page, drawer, toast, and hover transforms. / 减少动画模式关闭页面、抽屉、Toast 和悬停位移。
- `:focus-visible` uses a 2 px accent outline plus 2 px offset; focus is never removed without replacement. / `:focus-visible` 使用 2 px 焦点环和 2 px 偏移，禁止无替代移除焦点。
- Route changes update `document.title`; keyboard navigation never removes heading focus styling. / 路由切换更新 `document.title`，键盘导航不得移除标题焦点样式。

## Rollout Rules / 推进规则

1. Phase 3 changes shell/shared selectors, shared accessibility behavior, and public asset delivery; domain data and API contracts remain unchanged. / 第 3 阶段只改壳层、共享选择器、共享无障碍行为和公开资源交付，不改变业务数据与 API 契约。
2. Domain composition changes require the owning Phase 5-8 contract and approved screenshot regions. / 业务构成变化需由阶段 5-8 的契约和获批截图区域管理。
3. Every domain release imports these tokens rather than introducing a third theme. / 后续业务版本必须复用令牌，不得新增第三套主题。
4. Existing PPT build and `ppt.js` hash remain frozen. / 现有 PPT build 与 `ppt.js` 哈希保持冻结。

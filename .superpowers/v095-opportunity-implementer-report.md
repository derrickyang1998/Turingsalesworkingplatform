# TuringMarket v0.9.5 CRM 商机角色权限实施报告

- 完成日期：2026-09-17
- 基线：`f7bd5813333b8d45015b9ea6957735f7edd21457`
- 实现提交：`75a007d7f30a93e7f6b9bf70d62da3d4aeddad2d`
- 范围：计划 Task 1-3
- schema：保持 `v21`，无迁移

## RED / GREEN 记录

以下命令均在 `platform/server` 目录执行，除非另有说明。

### Task 1：中央策略与认证投影

RED 1：

```powershell
node --test tests/module_action_permission_service.test.js
```

输出摘要：退出码 1；13 项中 11 通过、2 失败。失败均为预期：`crm.opportunity` 返回 `UNKNOWN_MODULE`，因此可写/只读/平台角色投影和组织作用域失效关闭断言未满足。

RED 2：

```powershell
node --test tests/phase4_server_integration.test.js
```

输出摘要：退出码 1；36 项中 31 通过、5 失败。两项预期失败为登录和 read-only 登录的精确 `module_permissions` 对象缺少 `crm.opportunity`；另有 3 项基线既有失败，见“关注点”。

GREEN：

```powershell
node --test tests/module_action_permission_service.test.js tests/phase4_server_integration.test.js
```

输出摘要：49 项中 46 通过、3 失败。新增权限服务 13/13 通过，登录和 read-only 商机投影断言均通过；余下 3 项为同一批基线既有失败。为隔离确认 Task 1 集成行为，另执行：

```powershell
node --test --test-name-pattern "login and auth me preserve|read-only access is live" tests/phase4_server_integration.test.js
```

输出摘要：退出码 0；2/2 通过。

### Task 2：路由守卫、范围审计与嵌入式商机保护

RED：

```powershell
node --test tests/crm_phase5_http.test.js
```

输出摘要：退出码 1；27 项中 23 通过、4 失败。预期失败分别证明：商机路由没有命名授权调用、拒绝发生在请求解析之后、组织范围商机读取没有审计、成员可扩大商机读取范围。

GREEN：

```powershell
node --test tests/crm_phase5_http.test.js tests/module_action_permission_service.test.js
```

输出摘要：退出码 0；40/40 通过。

### Task 3：现有 CRM UI 权限投影

RED：

```powershell
node --test tests/customer_workspace_ui.test.js
```

输出摘要：退出码 1；8 项中 6 通过、2 失败。预期失败证明保存按钮缺少商机动作属性、UI 未读取商机权限、商机表格行始终可编辑。

GREEN：

```powershell
node --test tests/customer_workspace_ui.test.js
```

输出摘要：退出码 0；8/8 通过。

## 最终验证

四个聚焦测试：

```powershell
node --test tests/customer_workspace_ui.test.js tests/crm_phase5_http.test.js tests/module_action_permission_service.test.js tests/phase4_server_integration.test.js
```

输出摘要：退出码 1；84 项中 81 通过、3 失败。全部 Task 1-3 新增及受影响断言通过；3 个失败在 Task 1 生产代码修改前的 RED 运行中已存在，且不属于本计划允许修改的模块。

语法检查：

```powershell
node --check app.js
node --check server/server.js
node --check server/routes_customers.js
node --check server/services/module_action_permission_service.js
```

输出摘要：四条命令退出码均为 0，无语法错误。

空白与补丁检查（仓库根目录）：

```powershell
git diff --check
```

输出摘要：退出码 0，无尾随空白或补丁格式错误。

## 改动文件

1. `platform/server/tests/module_action_permission_service.test.js`
2. `platform/server/tests/phase4_server_integration.test.js`
3. `platform/server/services/module_action_permission_service.js`
4. `platform/server/server.js`
5. `platform/server/tests/crm_phase5_http.test.js`
6. `platform/server/routes_customers.js`
7. `platform/server/tests/customer_workspace_ui.test.js`
8. `platform/index.html`
9. `platform/app.js`

报告文件：`.superpowers/v095-opportunity-implementer-report.md`。

未修改发布文档、部署脚本、数据库迁移、PPT 或其他业务模块。

## 自审

- 租户隔离：`crm.opportunity` 纳入组织作用域；缺失、非法组织 ID 均失效关闭；平台管理员身份本身不授予租户商机动作。
- 角色矩阵：company owner、administrator、manager、member 获得 `read/create/update`；read-only 仅有 `read`。
- 路由覆盖：商机 list/detail/create/update 均要求命名动作；客户详情按 `crm.customer.read` 后 `crm.opportunity.read` 的顺序授权，阻止嵌入式商机绕过。
- 范围与审计：商机读取复用客户的组织/团队范围规则；拒绝和组织级读取只记录 actor、organization、permission、结果、request ID、有界 target ID 与 scope，不记录查询内容；审计写入失败继续失效关闭。
- 只读写保护：服务端 create/update 拒绝 read-only；UI 隐藏创建/保存入口，前置阻止创建、保存和编辑，且无 update 时表格行没有编辑点击行为。
- UI 回归：保留当前页面结构、模态框、样式和硬删除不可用状态，只增加权限条件与动作属性。
- 范围检查：未触及 schema、迁移、部署、发布记录、PPT、联系人或任务功能。
- 结论：Task 1-3 diff 未发现 HIGH/CRITICAL 问题。

## 关注点

最终四文件联合门禁仍有 3 个基线既有失败，因此不能声明整个聚焦测试命令全绿：

1. `collaboration routes use the injected singleton and one request-id fallback for linked writes`：`influencer saved-view service requires a SQLite database`。
2. `influencer upload commits its legacy envelope and parser admission in one transaction`：实际返回额外 `file_sha256` 字段。
3. `production owns one collaboration singleton, one PPT route, and the janitor lifecycle`：观察到两个 `3600000` 定时器而测试期望一个。

这些失败在本次生产代码修改前的 Task 1 RED 运行中已出现。按唯一需求来源和文件范围限制，本实现未修复或掩盖它们，也未执行 Task 4 发布、部署或归档工作。

## Fix Round 1/5 审查 Findings（原文）

Finding A HIGH：真实生产中 Phase4 在命名权限前读取/解析请求体；只读用户 PUT/POST 商机的非法 JSON 会先 400，合法 JSON被全局只读 guard 403，二者都不会产生 crm.opportunity.create/update 的拒绝审计。把商机 create/update 的命名授权和拒绝审计放到任何 body parser / Phase4 body read 之前。推荐最小实现是在 server.js 于 express.json / phase4 middleware 之前挂载仅匹配 POST /api/opportunities 与 PUT /api/opportunities/:id 的早期守卫；复用实时 authenticateRequest、moduleActionPermissionService 和同一个有界 CRM 权限审计写入。允许用户继续二次路由授权。权限审计写失败必须在读 body 前 503 失效关闭。新增真实 HTTP 集成用例：read-only + malformed JSON 返回命名 403 且 activity_log 有 crm.opportunity.* denied；审计写失败在 body 解析前返回 503；可写角色 malformed JSON 仍为 400。用聚焦 test-name-pattern 运行新增真实集成测试，避免那 3 个无关基线失败。

Finding B MEDIUM：当前 crm_phase5_http 的“before parsing”只证明业务命令未解析，不能证明原始 HTTP body 顺序。保留其路由层意义但改名准确；真实顺序证据由上述 Express 集成测试承担。再增加客户详情第二道 crm.opportunity.read 被拒绝时不派发 getCustomerDetail 且审计正确的测试。

Finding C P1：app.js 商机列表把 o.brand_name 未经 esc() 拼入 innerHTML，存在存储型 XSS。测试先证明所有可控文本均转义，再修复。

Finding D P1：只读用户失去商机详情入口，可写用户依赖不可聚焦 tr onclick。商机列表为所有读用户提供真实 button 类型的“查看”操作，并仅为 update 用户提供独立“编辑”按钮；不得依赖整行 click。实现可访问的只读商机详情（可复用现有模态框，但查看态字段禁用、保存隐藏，创建/编辑时必须恢复），支持键盘和焦点，不改变页面布局。

Finding E P2：loadOpportunities 和 openCustomerDetail 未检查 response.ok，403 被误显示为暂无商机/客户不存在。复用 requireSuccessfulCustomerMutation 或等价有界处理，测试失败状态不会进入空态/不存在分支。

## Fix Round 1/5 RED / GREEN 证据

以下命令均在 `platform/server` 执行，除非另有说明。

### Finding A：真实 HTTP body 读取前的命名授权与拒绝审计

RED：

```powershell
node --test --test-name-pattern "opportunity named permission ingress" tests/phase4_server_integration.test.js
```

输出摘要：退出码 1；3 项中 1 通过、2 失败。只读用户 malformed JSON 的 POST 实际为 400、预期命名 403；强制审计写失败时实际为 400、预期 503。可写角色 malformed JSON 仍为 400，按预期通过。

GREEN：

```powershell
node --test --test-name-pattern "opportunity named permission ingress" tests/phase4_server_integration.test.js
```

输出摘要：退出码 0；3/3 通过。只读 POST/PUT 在 body parser 前返回命名 403 并写入 `crm.opportunity.create/update` denied 审计；审计持久化失败在 body 解析前返回 503；可写角色 malformed JSON 到达 Phase4 parser 并返回 400。

自审补强 RED（Express 默认接受尾随斜杠）：

```powershell
node --test --test-name-pattern "opportunity named permission ingress denies" tests/phase4_server_integration.test.js
```

输出摘要：退出码 1；0/1 通过。`POST /api/opportunities/` 实际 400、预期 403，证明原匹配未覆盖与 Express 路由等价的尾随斜杠路径。

自审补强 GREEN：

```powershell
node --test --test-name-pattern "opportunity named permission ingress denies" tests/phase4_server_integration.test.js
```

输出摘要：退出码 0；1/1 通过。POST 与 PUT 的有/无尾随斜杠路径均在 body parser 前命名拒绝并产生有界审计。

### Finding B：路由层语义与客户详情第二道授权

RED：

```powershell
node --test --test-name-pattern "denied embedded opportunity read" tests/crm_phase5_http.test.js
```

输出摘要：退出码 1；0/1 通过。第二道 `crm.opportunity.read` 拒绝虽然停止派发，但审计目标实际为 `opportunity`，预期为客户详情资源 `customer:41`。

GREEN：

```powershell
node --test --test-name-pattern "denied embedded opportunity read" tests/crm_phase5_http.test.js
```

输出摘要：退出码 0；1/1 通过。拒绝后未调用 `getCustomerDetail`，审计权限为 `crm.opportunity.read`，目标为 `customer:41`。原测试已改名为 `before business command parsing or service dispatch`，不再把路由层证据表述为原始 HTTP body 顺序证据。

### Finding C：商机列表存储型 XSS

RED：

```powershell
node --test --test-name-pattern "opportunity list escapes" tests/customer_workspace_ui.test.js
```

输出摘要：退出码 1；0/1 通过。列表缺少对品牌、阶段和预计成交日期等服务端文本的统一 `esc()` 边界。

GREEN：

```powershell
node --test --test-name-pattern "opportunity list escapes" tests/customer_workspace_ui.test.js
```

输出摘要：退出码 0；1/1 通过。名称、品牌、阶段、预计成交日期均在进入 `innerHTML` 前转义。

自审补强 RED（数值字段也视为不可信响应内容）：

```powershell
node --test --test-name-pattern "cannot inject markup" tests/customer_workspace_ui.test.js
```

输出摘要：退出码 1；0/1 通过。恶意金额和赢单概率字符串仍以原始 `<img>` 进入 `innerHTML`。

自审补强 GREEN：

```powershell
node --test --test-name-pattern "cannot inject markup" tests/customer_workspace_ui.test.js
```

输出摘要：退出码 0；1/1 通过。金额、赢单概率先规范为有限数值，所有服务端可控单元格均不能注入标记。

### Finding D：可聚焦查看/编辑操作与只读详情

RED：

```powershell
node --test --test-name-pattern "opportunity table exposes|opportunity modal supports" tests/customer_workspace_ui.test.js
```

输出摘要：退出码 1；0/2 通过。列表没有真实“查看”按钮，依赖不可聚焦行点击；`viewOpportunity` 和查看态模态逻辑不存在。

GREEN：

```powershell
node --test --test-name-pattern "opportunity table exposes|opportunity modal supports" tests/customer_workspace_ui.test.js
```

输出摘要：退出码 0；2/2 通过。所有读用户获得 `type="button"` 的查看操作，仅 update 用户获得独立编辑按钮；查看态禁用字段并隐藏保存，创建/编辑态恢复；打开和关闭复用 `TMAccessibility` 并保留焦点回退。

内联处理器契约 RED：

```powershell
node --test --test-name-pattern "opportunity row inline handlers" tests/customer_workspace_ui.test.js
```

输出摘要：退出码 1；0/1 通过。`exposeInlineHandlers` 缺少 `viewOpportunity`，同时确认既有 `editOpportunity` 也未显式导出。

内联处理器契约 GREEN：

```powershell
node --test --test-name-pattern "opportunity row inline handlers" tests/customer_workspace_ui.test.js
```

输出摘要：退出码 0；1/1 通过。`viewOpportunity` 与 `editOpportunity` 均纳入全局内联处理器导出名单。

### Finding E：失败响应不得进入空态/不存在分支

测试执行器首次运行：

```powershell
node --test --test-name-pattern "failed opportunity response|failed customer detail response" tests/customer_workspace_ui.test.js
```

输出摘要：退出码 1；2 项均因测试提取器丢失 `async` 前缀而产生 `await is only valid in async functions`，不计为缺陷 RED；修正测试执行器后重跑。

有效 RED：

```powershell
node --test --test-name-pattern "failed opportunity response|failed customer detail response" tests/customer_workspace_ui.test.js
```

输出摘要：退出码 1；0/2 通过。403 商机响应错误进入“暂无商机”，403 客户详情响应错误进入“客户不存在”。

GREEN：

```powershell
node --test --test-name-pattern "failed opportunity response|failed customer detail response" tests/customer_workspace_ui.test.js
```

输出摘要：退出码 0；2/2 通过。两处均通过 `requireSuccessfulCustomerMutation` 检查 `response.ok`，失败状态进入显式加载失败分支。

## Fix Round 1/5 最终验证

按控制器最终限定命令执行：

```powershell
node --test tests/customer_workspace_ui.test.js
```

输出摘要：退出码 0；14/14 通过，耗时约 102ms。

```powershell
node --test tests/crm_phase5_http.test.js
```

输出摘要：退出码 0；28/28 通过，耗时约 918ms。

```powershell
node --test --test-name-pattern "opportunity named permission ingress|login and auth me preserve|read-only access is live" tests/phase4_server_integration.test.js
```

输出摘要：退出码 0；5/5 通过，耗时约 10.1s。覆盖三个早期商机 mutation 真实 HTTP 用例，以及两个既有真实登录/只读聚焦用例。

当前改动 JavaScript 语法检查（在 `platform` 执行）：

```powershell
node --check app.js
node --check server/server.js
node --check server/routes_customers.js
node --check server/tests/crm_phase5_http.test.js
node --check server/tests/customer_workspace_ui.test.js
node --check server/tests/phase4_server_integration.test.js
```

输出摘要：六条命令退出码均为 0，无语法错误。

补丁检查（仓库根目录）：

```powershell
git diff --check
```

输出摘要：退出码 0，无尾随空白或补丁格式错误。

## Fix Round 1/5 改动文件

1. `platform/server/server.js`
2. `platform/server/routes_customers.js`
3. `platform/app.js`
4. `platform/server/tests/phase4_server_integration.test.js`
5. `platform/server/tests/crm_phase5_http.test.js`
6. `platform/server/tests/customer_workspace_ui.test.js`
7. `.superpowers/v095-opportunity-implementer-report.md`

未修改数据库迁移、schema、PPT、联系人、任务、发布文档或部署脚本。

## Fix Round 1/5 自审与风险

- 授权顺序：仅匹配商机 POST/PUT（含 Express 等价尾随斜杠）的早期守卫位于 `express.json` 与 Phase4 middleware 前；允许请求继续接受原路由二次授权。
- 实时权限：早期守卫复用 `authenticateRequest`、实时组织上下文和 `moduleActionPermissionService`，不信任客户端投影。
- 审计失效关闭：拒绝审计复用同一有界 CRM 审计写入器；写入失败在读取 body 前返回 503，不落入全局只读 guard。
- 嵌入式数据：客户详情第二道商机读取拒绝以客户资源为审计目标，且业务查询未派发。
- UI 安全：服务端文本转义，数值字段有限数值化；详情标题使用 `textContent`，不存在新 HTML 注入点。
- UI 可访问性：查看/编辑均为真实按钮；查看态禁用字段、隐藏保存；创建/编辑会恢复字段和保存状态；对话框打开/关闭维持焦点管理。
- 失败状态：403 等非成功响应不会再伪装为空列表或不存在记录。
- 范围控制：未扩大到 Phase4 pipeline、schema、迁移、联系人、任务、PPT 或部署模块。
- 残余风险：按最终指令未运行含 3 个已知无关基线失败的完整 `phase4_server_integration.test.js`，仅运行覆盖本轮真实 HTTP、登录和只读行为的 5 项聚焦模式；本轮限定门禁全部 GREEN。

修复实现提交：由包含本报告的 Git commit 记录（recorded by the enclosing Git commit）。

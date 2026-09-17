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

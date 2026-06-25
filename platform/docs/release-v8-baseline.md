# TuringMarket v8.0 产品开发基线

## 版本范围
- 日期：2026-06-25
- 范围：Phase 1-8，客户主链路、权限协作、AI 产物归档、工作流自动化、待办中心、管理驾驶舱、知识库复用、上线稳定性。
- 本地验证地址：`http://localhost:3002`
- 生产参考地址：`http://8.163.129.160/`

## 阶段基线
- Phase 1：客户详情可进入品牌智库、AI 策略、需求/方案、达人匹配，形成主业务链路。
- Phase 2：客户权限分层完成，支持我的客户、团队客户、全部客户、公海池。
- Phase 3：AI 策略和方案可保存到客户动态与知识库。
- Phase 4：客户阶段变化、AI 成果归档会自动生成工作流待办。
- Phase 5：商务待办中心可筛选、查看详情、打开客户、完成任务。
- Phase 6：管理控制室升级为经营驾驶舱，覆盖客户、商机、待办、AI、知识库、团队排行。
- Phase 7：知识库支持相似案例召回，策略和方案生成可复用历史案例。
- Phase 8：形成上线前 release gate、版本归档、部署检查和回滚说明。

## 自动化验收命令
在 `platform` 目录执行：

```bash
npm run test:release
```

单项脚本：

```bash
node tests/phase1_acceptance.js
node server/phase2_permissions_test.js
node server/phase3_artifacts_test.js
node server/phase4_workflow_automation_test.js
node tests/phase5_tasks_ui_acceptance.js
node tests/phase6_admin_dashboard_acceptance.js
node tests/phase7_knowledge_reuse_acceptance.js
node server/smoke_test.js
```

## 发布前环境要求
- Node.js 可执行文件可用。
- `platform/server` 依赖已安装。
- `platform` 已安装 Playwright 依赖。
- 本地服务运行在 `http://localhost:3002`。
- 默认管理员账号：`admin / turing2026`。

## 部署检查
- 备份生产代码目录。
- 备份生产数据库文件。
- 拉取或上传本版本代码。
- 安装依赖：`cd platform/server && npm install --production`。
- 重启服务：`pm2 restart turingmarket`。
- 检查 Nginx：`nginx -t && systemctl reload nginx`。
- 访问 `/api/health` 和首页。

## 回滚说明
- 如果首页白屏、登录失败、客户库不可用、核心接口 500，立即回滚。
- 回滚方式：恢复上一版代码和数据库备份，执行 `pm2 restart turingmarket`。
- 回滚后必须执行登录、客户库、客户详情、`/api/health` 四项冒烟。

## 已知风险
- 当前前端仍是单体 `app.js`，新增功能容易互相影响，所以上线前必须跑完整 release gate。
- 相似案例检索是轻量关键词打分，不是向量检索；可满足复用入口，后续可升级为 embedding。
- DeepSeek Key 仍在前端常量中暴露，生产环境应尽快迁移到后端代理。
- 生产部署文档仍包含历史 sql.js 描述，当前本地服务实际使用 `better-sqlite3`，部署前需确认目标服务器 Node/SQLite 原生依赖兼容性。

## 验收证据
- 以 `npm run test:release` 全部 PASS 作为 v8.0 本地准入证据。
- 以线上 `/api/health`、登录、客户库、待办中心、管理驾驶舱、知识库复用冒烟全部通过作为生产准入证据。

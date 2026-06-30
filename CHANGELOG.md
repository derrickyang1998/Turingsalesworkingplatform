# Changelog — TuringMarket 图灵商务在线工作平台

## v0.2.0-ai-knowledge-foundation (2026-06-30) — AI 对话与自成长知识库底座

### 🧠 知识底座
- 扩展 `knowledge_entries`，新增标题、摘要、标签、可见性、来源哈希、业务关联、元数据、更新时间兼容字段。
- 新增 `knowledge_chunks`、`knowledge_chunks_fts` 和 `web_search_cache`，v1 使用 SQLite FTS5 + 标签/来源/可见性过滤，预留 embedding 字段。
- 新增 `knowledge_service`，统一处理入库、source_hash 去重、切片、FTS 索引、权限检索与引用计数。

### 💬 AI 对话与 RAG
- 新增 `ai_conversations`、`ai_messages`、`ai_references`，保存用户消息、AI 回复、知识库引用、联网来源、token 用量和自动摘要归档。
- 新增 `rag_service`、`llm_service`、`web_search_service`、`ai_service`，后端调用 DeepSeek，Tavily 作为首个联网搜索 provider，key 缺失时降级。
- 新增 API：`/api/knowledge/ingest`、`/api/knowledge/upload`、`/api/knowledge/search`、`/api/ai/chat`、`/api/ai/conversations`、`/api/ai/conversations/:id`、`/api/ai/proposal-draft`。

### 🔐 权限与审计
- 普通用户仅能查看自己的 AI 对话；管理员可搜索、筛选、查看全平台 AI 对话、消息、引用和联网来源。
- 管理员查看他人 AI 会话会写入 `activity_log` 的 `admin_view_ai_conversation` 审计记录。
- 前端不再持有 DeepSeek/Tavily 密钥，AI 调用统一走后端服务层。

### 🔗 业务闭环
- M5 AI 助手改为调用 `/api/ai/chat`，回复展示知识库引用和联网来源。
- Admin 新增 AI 对话审计视图；Knowledge Base 增加搜索、来源筛选、可见性筛选、引用次数展示。
- M3 需求分析、方案草稿和 HTML/PPT 生成前后会归档需求与确认方案；方案草稿通过后端 RAG 生成。
- M4 网红导入后自动归档批次摘要、项目/产品、标签和样本行到团队知识库。

### ✅ 验证
- `node --check app.js`
- `node --check server/server.js`
- `node --check server/routes.js`
- `node --check server/services/*.js`
- `npm test`（6 项通过：知识去重/权限检索、私有来源 hash 隔离、共享来源防覆盖、RAG 引用、AI 会话权限、Tavily key 缺失降级）
- `npm audit --json` 返回 0 个漏洞
- 本地服务健康检查：`GET /api/health` 返回 `status=ok`
- API smoke：管理员登录、知识入库、AI 对话持久化、知识引用返回通过

---

## v0.1.0-handoff (2026-06-30) — 交接归档与版本治理基线

### 📚 归档
- 新增 `docs/handoff/2026-06-30/`：当前静态前端工作区的交接手册、服务器与密钥脱敏说明、团队版本迭代规范、安全规则。
- 新增 `docs/version-records/2026-06-30-v0.1.0-handoff-baseline.md`：本次可交接基线记录。
- 新增 `archive/static-frontend-2026-06-30/`：当前 `C:\Users\29272\Documents\在线商务平台` 静态前端快照。
- 新增 `.env.example`：公开环境变量模板，真实密钥继续保存在私有 Obsidian 或密钥管理器。

### 🔐 安全
- `.gitignore` 明确排除本地私有交接目录、SSH 私钥、真实 `.env`。
- GitHub 仅保存脱敏文档，不新增真实 API key、服务器密码或 SSH 私钥。

---

## v7.0 (2025-06-04) — 生产就绪版本

### 🎯 里程碑
- ✅ 全部7个模块可正常使用，页面切换不堆积
- ✅ 阿里云生产环境部署 (8.163.129.160)
- ✅ 一键安装脚本 (install.sh)
- ✅ GitHub 完整存档

### 🐛 修复
- **页面白屏问题（根因）:** index.html 缺少1个 `</div>` 导致 M2-M7 被嵌套在 M1 内部，M1隐藏时所有子页面不可见
- **页面堆积问题:** switchPage 未清除旧页面的 `display:block` 样式残留
- **CSS基线错误:** `.page{display:block}` → `.page{display:none}` (默认值修正)
- **JavaScript干扰:** 移除 app.js 第103行设置 `setAttribute('style','display:none')` 的IIFE
- **DOM修复脚本:** 页面加载后自动将 `page-*` div 移入 `<main>` 作为直接子元素
- **sql.js包装器:** `.run()` 方法不支持多参数传递的问题

### 🔧 技术改进
- switchPage 改用 `element.style.display` (而非 `setAttribute`) 精确控制显隐
- 服务端使用 sql.js (纯JS SQLite) 替代 better-sqlite3 (Ubuntu 26.04 不兼容)
- SSH管道分块上传机制 (避免命令行长度限制)
- Playwright 端到端测试集成

### 📦 部署
- Nginx 80端口代理 → Express 3002端口
- PM2 进程管理
- 10个商务团队账号 + 1个管理员账号

---

## v6.0 — 全平台7模块

- feat: 全部7个模块 HTML + JavaScript 骨架完成
- M0: 客户管道 (Customer Pipeline)
- M1: 行业品牌智库 (Brand Intelligence Hub)
- M2: 客户策略规划 (Strategy Planning)
- M3: 需求接入 & 方案生成 (Demand & Proposal)
- M4: 网红匹配 & 执行管理 (Influencer Matching)
- M5: AI 助手 (AI Assistant)
- Admin: 管理控制室 (Admin Dashboard)
- 下拉选择器导航 + 侧边栏导航双入口

---

## v5.5 — M2-M5 + Admin 清零重建

- refactor: 清空 M2-M5 + Admin 代码
- 以 M0/M1 的交互逻辑为基准完全重写
- 统一页面切换机制

---

## v5.4 — 模块互联 (SOP Pipeline)

- feat: 客户管道 ↔ 各模块双向链接
- 点击客户 → 跳转到对应分析模块
- 跨模块数据传输

---

## v5.3 — 客户管道 (SOP Backbone)

- feat: M0 客户管道完整功能
- 线索→意向→方案→谈判→成交→维护 全阶段跟踪
- 客户搜索、阶段筛选、状态管理
- loadCustomers / renderCustomerTable / saveCustomer

---

## v5.2 — 网红数据库 + 智能匹配

- feat: M4 网红数据库基础功能
- 网红导入、筛选、匹配
- 飞书表格集成
- initM4 / influencer table rendering

---

## v5.1 — Codex 接手开发

- chore: v5.1 基线快照
- 确立项目结构
- Express 5 后端 + 纯前端架构
- 多用户登录系统

---

## v1.0 — 初始概念

- M1: 行业品牌智库 — 标签树 + 品牌搜索 + 数据展示
- M2: 客户策略规划 — 品牌阶段×行业×预算策略模型
- 纯前端 HTML 双击运行

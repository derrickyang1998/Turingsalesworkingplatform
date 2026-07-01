# Changelog — TuringMarket 图灵商务在线工作平台

## v0.2.1-knowledge-vault-bridge (2026-06-30) — 全模块知识归档与平台 Vault

### 🔗 全模块知识归档
- 新增 `business_knowledge_service`，统一沉淀 CRM 线索、客户、商机、品牌画像、达人档案、合作记录、工作流模板/实例/任务动作。
- 后端写操作自动归档到知识库，主业务保存不再依赖前端本地 `archiveToKB`。
- M3 需求文件上传改为优先走 `/api/knowledge/upload`，上传即进入知识库；M4 网红文件解析后会调用 `/api/influencers/import` 并生成批次知识摘要。

### 📚 Obsidian 与平台 Vault
- 新增 `obsidian_ingest_service`，支持递归扫描 Obsidian Vault，跳过 `.obsidian/.git/99-private/private/secrets/密钥/密码` 等路径和疑似密钥内容。
- 新增管理员接口 `POST /api/admin/knowledge/import/obsidian`，支持 dry-run 和正式同步，默认导入路径 `D:\主盘\图灵集市`。
- 新增 `vault_export_service` 和管理员接口 `POST /api/admin/knowledge/vault/export`，将平台知识导出为 Obsidian 兼容 Markdown，默认路径 `D:\图灵商务在线平台`。
- 导入/导出路径限制在服务端配置白名单内，并限制文件数、目录深度、单文件大小和总读取字节数。
- Admin 知识库页新增 Obsidian 导入、平台 Vault 导出、业务来源/更新时间展示。

### 🤖 AI/RAG 稳定性
- RAG 系统提示改为稳定中文上下文标记，要求回答优先引用 `[KB-n]` / `[WEB-n]`。
- DeepSeek key 缺失、HTTP 失败或网络异常时，不再直接中断 AI 请求，会基于已命中的知识库上下文降级回复。
- Tavily 网络异常时优先使用 24 小时内缓存，无法联网时降级为仅知识库回答。
- `/api/ai/proposal-draft` 不再把检索范围锁死到当前 demand，避免漏掉方法论、历史方案和网红批次摘要。
- 线上回归修复中文长句 RAG 检索：知识检索会从中文问题中提取 2-6 字业务关键词，避免“请结合知识库，用三点概括...”这类完整句子无法命中知识条目。

### 🔐 安全加固
- 移除前端、部署文档、迁移文档和旧验证脚本中的静态默认密码；后台创建/重置用户改为返回一次性临时密码或使用管理员显式提供的密码。
- 种子账号不再复用同一默认密码；管理员使用私有 `DEFAULT_ADMIN_PASSWORD`，团队账号需通过后台重置或按用户私有环境变量配置。
- CRM 客户、线索、商机按 id 读写增加归属校验，普通用户不能读取、修改或归档他人客户/商机，不能通过 `is_public=0` 列表参数绕过过滤。
- 公海客户仅可查看，未领取前不能修改或删除其关联商机。
- 新建/分配客户默认退出公海；客户领取必须同时满足 `is_public=1` 且未分配，防止已分配客户被他人直接 claim。
- CRM 私有知识归档改为归属业务负责人，管理员代操作不会让已分配客户的知识只留在管理员私有空间。

### ✅ 验证
- `node --check app.js; node --check ppt.js; node --check server/server.js; node --check server/routes*.js; node --check server/services/*.js`
- `npm test`（17 项通过：原 AI/KB 用例 + 中文长句 RAG 引用 + Obsidian 安全导入 + 路径白名单拒绝 + 业务归档权限 + CRM 越权拒绝 + 私有客户列表防绕过 + 已分配客户防 claim + 公海商机写权限拒绝 + 种子密码不复用 + 默认密码扫描 + Markdown Vault 导出）
- API smoke：临时服务健康检查、管理员登录、Obsidian dry-run、平台 Vault export 通过。
- 真实本地同步：`D:\主盘\图灵集市` dry-run 命中 65 个可导入文件、跳过 9 个敏感/私密路径；已导入 65 条并导出 65 个 Markdown 到 `D:\图灵商务在线平台`。
- 线上部署回归：`8.163.129.160` PM2 服务在线，健康检查通过；已同步安全筛选后的 Obsidian 65 个文件并导入 65 条知识，Vault 导出 66 条，AI 对话返回 5 条 `knowledge_references` 且 `ai_references` 落库。

---

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

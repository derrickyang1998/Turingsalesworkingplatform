# Changelog — TuringMarket 图灵商务在线工作平台

## v0.2.10-security-credential-rotation (2026-07-12) - 凭据轮换与安全事件闭环

### 账号、会话与认证 / Accounts, Sessions, And Authentication
- 新增统一凭据轮换服务与 stdin-only 批量 CLI，11 个活动账号已在同一事务内完成密码轮换；旧管理员密码已在线验证失效，最终会话数为 0。
- 管理员重置、新建用户、注册和生产空库初始化统一执行强密码策略；失败信息不再泄露目标用户名或调用方密码。
- JWT 增加每会话随机 `jti`，生产签名密钥已轮换为 96 字符以上高熵值；移除 query-token 认证，仅接受规范 `Authorization: Bearer`。
- 生产 `.env` 已移除 `DEFAULT_ADMIN_PASSWORD`，历史 3 份明文 `.env.bak-*` 已清理。

### 受保护发布 / Guarded Release
- 部署主机改为本机环境变量注入，所有 SSH/SCP 强制 host-key 校验并检查原生命令退出码；首次升级会创建远端脚本目录，备份与部署验证均 fail-closed。
- 已创建 root-only SQLite 一致性备份、代码/Nginx 归档与 SHA-256 校验和，常规归档不包含 `.env`。
- DeepSeek 与 Tavily 根据访问日志证据分类为 `NO_ROTATION_REQUIRED` 并通过真实线上冒烟；飞书保持 `UNCONFIGURED` 和 CSV 兜底。

### 验证 / Verification
- 本地完整测试：66/66；生产完整测试：66/66；`npm audit --omit=dev`：0 vulnerabilities。
- 线上冒烟通过：管理员/团队账号登录、`/api/auth/me`、网红模板、DeepSeek、Tavily、管理员 AI 对话审计、PPT 标记、退出和会话清零。
- 7 个公开敏感路径均返回 `404`；13 个关键生产文件 SHA-256 与本地一致。
- 保留最新 PPT：`ppt.js?v=20260702v916kbbridge` 与 `20260702-v916-kb-bridge-client-cn` 未变化。
- 最终 `minimal-change-engineer`、`code-reviewer`、`application-security-engineer` 审查全部 `APPROVE`，发布闸门开放。

---

## v0.2.9-production-static-exposure-hotfix (2026-07-12) - 生产静态资源安全热修

### 暴露面收口
- 移除 Express 对整个 `platform/` 目录的静态开放，改为仅允许 `index.html`、`app.js`、`ppt.js`、`data/` 和已登记的 SPA 页面路径。
- `/server`、数据库/WAL、`uploads`、`tmp`、`backups`、部署脚本、dotfile 和未知顶层文件在进入 SPA fallback 前统一返回 `404`。
- 未注册 `/api` 路径不再返回前端首页，统一返回 JSON `404`。

### 双层防护与事件处置
- 新增版本化 Nginx 配置，在代理层重复拦截后端目录、数据库目录、dotfile 和部署文件。
- 部署脚本使用 candidate 配置执行 `nginx -t`，失败时恢复旧配置，验证通过后才 reload。
- 安全热修部署默认清空 `sessions` 表并校验剩余会话为 0；只有显式传入 `-PreserveSessions` 才会保留会话。

### 验证
- TDD 红灯确认真实 Express 服务对 `/server/server.js` 返回 `200`，修复后敏感路径、编码路径和目录穿越路径均返回 `404`。
- `node --test platform/server/tests/public_static_security.test.js`：4/4 通过。
- `npm test` in `platform/server`：36/36 通过。
- `node --check`、PowerShell 脚本解析和 `git diff --check` 通过。
- `minimal-change-engineer`、`code-reviewer`、`application-security-engineer` 复审均为 `APPROVE`。
- 生产部署：Nginx 配置校验通过，PM2 `turingmarket` online，清除 14 个旧会话并校验剩余 0。
- 公网回归：UI/PPT/data/health 保持 `200`；后端源码、SQLite/WAL、部署文件、dotfile、大小写/编码/目录穿越路径均为 `404`。
- 生产鉴权烟测：管理员登录、`/api/auth/me`、网红模板下载、退出登录均为 `200`，测试前后会话数均为 0。
- 服务器完整测试：36/36 通过；线上关键文件 SHA-256 与本地一致。
- 生产备份：`/root/turingmarket/platform/backups/backup-v029-20260712-152827`。

---

## v0.2.8-influencer-custom-upload-headers (2026-07-03) - M4 自定义网红上传表头

### 自定义上传表头
- 根据 `推广项目-网红合作数据表-上传表头.xlsx` 建立 M4 网红导入模板，下载模板改为 20 个中文表头：日期、提报人、项目&客户、推广产品、是否重复、网红频道名称、网红粉丝量、网红频道链接、社媒平台、国家、网红类型、近10个视频均播、网红成本价格（折算美元）、网红交付物（植入-完播等信息）、Turing备注、对外商务报价（美元）、网红联系方式、CPM（自动计算）、CPV(自动计算)、父记录。
- 保留历史 19 列英文模板别名兼容，旧 `No./Date/Submitter/Project/Product/.../CPV` 文件仍可导入。
- 新增 `influencer_type`、`cpv`、`parent_record` 字段入库，`网红类型` 同步映射到分类/标签，`父记录` 可用于关联 CRM 或飞书父级记录。

### 上传解析与搜索
- 修复 XLSX 上传解析器兼容问题：`read-excel-file` 返回 `{ sheet, data }` 工作表对象时不再报 `rawRows[0].map is not a function`。
- M4 统一搜索扩展到 `influencer_type`、`parent_record` 和 `cpv`，可直接搜索网红类型、父记录、链接、ID、标签和表格展示字段。
- M4 列表增加 Type、Parent 展示列，模板下载 API 失败时的前端兜底模板也改为同一套中文 20 列表头。
- 发布脚本补充上传 `file_ingest_service.js` 和新增测试，线上部署会同步校验 XLSX 解析服务。

### 验证
- `node --test platform/server/tests/file_ingest_service.test.js`
- `node --test platform/server/tests/influencer_workflow.test.js`
- `node --test platform/server/tests/*.test.js`：32/32 passing
- `node --check platform/app.js`
- `node --check platform/server/services/file_ingest_service.js`
- `node --check platform/server/services/influencer_workflow_service.js`
- 使用真实附件 `C:\Users\29272\Desktop\推广项目-网红合作数据表-上传表头.xlsx` 验证服务层读取不再抛错；附件本身只有表头，因此 rows=0 符合表头说明用途。

---

## v0.2.7-influencer-workflow-import-feishu-order (2026-07-03) - M4 网红导入、飞书同步与下单资源修复

### 网红导入与模板
- 新增 `/api/influencers/template`，下载恢复为历史 19 列合同模板：`No./Date/Submitter/Project/Product/Duplicate/KOL Handle/Followers/Link/Platform/Country/Tag/AvgViews10/Cost/Deliverable/TuringNote/Price/Email/CPM/CPV`。
- 新增 `influencer_workflow_service`，统一兼容历史英文模板和现有中文模板字段，支持旧模板中的 KOL Handle、Link、Tag、Deliverable、Price、CPM/CPV 等字段入库。
- 新增 `/api/influencers/upload`，CSV/JSON/XLSX 文件上传改为后端解析后入库；旧 XLS 明确提示另存为 XLSX/CSV。

### 飞书与下单合作资源
- 新增 `/api/influencers/feishu/sync`，前端只提交选中网红 ID；后端通过 `FEISHU_WEBHOOK_URL` 或 `FEISHU_WEBHOOK` 接入飞书工作流。
- 飞书未配置时不再静默失败，会返回并下载兼容历史 19 列模板的 CSV 兜底文件。
- M4 网红表格恢复“下单”动作，新增合作资源弹窗，可定义项目、推广产品、交付物、报价、执行时间和备注；Tab 2 合作资源表展示这些字段。

### M4 列表 UI
- 新增统一搜索框，覆盖网红 ID、账号、标签、链接，以及表格展示字段如平台、项目、产品、地区、交付物、报价、粉丝数、CPM。
- 网红列表表头改为 sticky，下滑列表时字段标题保持可见。
- 修复复选框继承全局 input 宽度导致图标过大的问题，仅在 M4 表格内固定为 16px。

### 验证
- `node --check platform/app.js`
- `node --check platform/server/routes.js`
- `node --check platform/server/server.js`
- `node --check platform/server/services/influencer_workflow_service.js`
- `node --test platform/server/tests/influencer_workflow.test.js`
- `node --test platform/server/tests/*.test.js`：30/30 passing
- Playwright 本地烟测：模板下载、历史 19 列 CSV 上传、ID/链接/标签搜索、sticky 表头、复选框尺寸、飞书未配置 CSV 降级、合作资源下单与 Tab 2 展示通过。

---

## v0.2.6-customer-board-detail-split (2026-07-03) — 客户库看板与明细拆分

### 客户库信息架构
- 将 M0 客户库拆成两个独立入口：`客户看板` 和 `客户明细`，避免经营漏斗、AI 洞察与客户列表/详情操作挤在同一个页面。
- `客户看板` 只保留客户经营中枢、统计卡片、阶段漏斗、今日重点客户和 AI 洞察，并提供进入客户明细的轻入口。
- `客户明细` 承接客户列表、公海池、阶段筛选、搜索、客户新增/编辑、客户详情面板和商机看板。
- 待办任务跳转客户记录时改为进入 `客户明细`，保证打开客户详情时上下文正确。

### 回归护栏
- 新增 `customer_workspace_ui.test.js`，锁定 `page-m0` 与 `page-m0-detail` 必须分离，并校验 PPT bridge 版本不变。
- 保留最新 PPT 生成支撑：未修改 `platform/ppt.js`，继续使用 `ppt.js?v=20260702v916kbbridge` 和 `window.tmPPTBuild = "20260702-v916-kb-bridge-client-cn"`。

### 验证
- `node --test platform/server/tests/customer_workspace_ui.test.js`
- `node --check platform/app.js`
- `node --check platform/ppt.js`
- `node --check platform/server/server.js`
- `node --check platform/server/routes_customers.js`
- `npm test` in `platform/server`: 25/25 passing
- Playwright 本地烟测：登录、客户看板默认可见、看板不包含明细搜索/表格、客户明细包含搜索/表格/公海池/商机看板、返回看板、PPT bridge build 不变。

---

## v0.2.4-kb-bridge-on-latest-ppt (2026-07-02) — 最新 PPT 界面与知识库底座合并修复

### 回退根因修复
- 确认 `C:\Users\29272\Documents\在线商务平台` 是旧 `master` 基线，不能作为当前平台发布源。
- 将线上最新 PPT 生成修复 `20260701-v915-client-cn` 回写到 `C:\Users\29272\Documents\在线商务平台-github-sync`，避免后续知识库开发再次覆盖最新 PPT/UI。
- 保留 `github-sync` 分支中的知识库/RAG、M5 AI 对话、Admin AI 对话审计、PPT outline 归档与后端兼容接口。

### 最新界面接入
- `platform/ppt.js` 合并客户端中文汇报版、补充材料清洗、材料洞察页、客户汇报版文案和内部解析状态过滤。
- 短 TXT/MD/CSV/JSON 补充材料即使少于 80 字，也会作为有效业务上下文进入 PPT；解析失败元数据仍会被过滤，不展示给客户。
- `platform/index.html` 更新 PPT 脚本缓存版本到 `20260702v916kbbridge`，强制浏览器加载合并后的最新 PPT + 知识库桥接文件。
- `/api/ai/ppt-outline` 生成前接入 `rag_service` 检索平台知识库，并把 `knowledge_references` 写入返回值、outline 内容和知识库归档 metadata。
- 需求文件解析失败时不再把 parser note 写入 RAG 正文；失败记录改为 `demand_upload_parse_failure` 并在 metadata 保留解析状态。

### 发布护栏
- `platform/deploy_v8.ps1` 改为只允许从 `在线商务平台-github-sync` 发布，上传清单加入 `ppt.js` 和 AI/知识库服务文件，并在发布后校验 PPT build、首页缓存版本和健康检查。
- `platform/DEPLOY.md` 更新为 `codex/ai-knowledge-foundation` 分支和当前线上目录结构，明确禁止旧目录发布。

### 验证
- `node --check platform/app.js`
- `node --check platform/ppt.js`
- `node --check platform/server/server.js`
- `node --test server/tests/ai_knowledge_foundation.test.js server/tests/obsidian_and_business_knowledge.test.js server/tests/security_and_crm_access.test.js`
- 生产部署后校验 `/api/health`、首页脚本版本、`window.tmPPTBuild`、Admin AI 对话入口、AI chat 与 PPT outline API。

---

## v0.2.3-latest-ui-knowledge-bridge (2026-07-01) — 最新 PPT/UI 基线恢复与知识库桥接

### 🧯 回退事故修复
- 根因：上一轮知识库底座部署使用 `在线商务平台-github-sync/platform` 的旧前端作为发布基线，覆盖了 2026-06-30 在 `海外品牌推广-红人营销-图灵/platform` 完成的最新 PPT/UI 文件。
- 恢复最新 `index.html`、`app.js`、`ppt.js` 基线，保留 v9.14 light deck、PPT 汇报补充材料、方案编辑器、HTML/PPTX 生成等最新界面能力。
- 新增后端兼容接口，确保最新界面不再依赖旧直连逻辑：`/api/demand/parse-file`、`/api/ai/strategy`、`/api/ai/demand-analysis`、`/api/ai/ppt-outline`、`/api/knowledge/similar`、`/api/brands/enrich`。

### 🤖 知识库与 AI 接入
- M5 AI 助手改为统一调用 `/api/ai/chat`，对话、回复、知识引用和联网来源进入后端会话表，管理员可审计。
- Admin 增加 AI 对话审计 tab，可查看全平台对话、消息、token、知识引用和联网来源。
- 品牌补全改为后端 DeepSeek/Tavily 路径，移除前端 DeepSeek key/URL，失败时返回保底结构以保持界面可用。
- 需求文件、知识库上传、PPT outline 生成接入统一解析与知识归档，支持 TXT/MD/CSV/JSON/XLSX/XLSM/XLS/PDF/DOCX/PPTX/图片降级解析。

### 🔐 安全与兼容
- 修复最新版前端带回的旧固定管理员密码文案；新增用户/重置密码继续使用后端一次性临时密码。
- AI 策略输出先转义再做有限 markdown 渲染，避免模型/知识库内容被作为 HTML 执行。
- `/api/brands/enrich` 接入 AI 限流和额度守卫；需求分析和 PPT outline 的 DeepSeek 调用写入 `token_usage`。
- PPTX 下载兼容最新 UI 的 `outline.sections[].points` payload，后端会转换为旧 Python 生成器需要的 `sections[].items`。
- CRM 客户列表和统计支持前端 `scope=my/team/all`，普通用户团队视图限定同部门，管理员可看全量。

### ✅ 验证
- `node --check platform/app.js; node --check platform/ppt.js; node --check platform/server/server.js; node --check platform/server/routes_brands.js; node --check platform/server/routes_customers.js; node --check platform/server/services/latest_ui_compat_service.js`
- `npm test`：18/18 通过。
- `git diff --check`：通过。
- 前端密钥扫描：`DS_KEY`、`DS_URL`、`api.deepseek.com`、`sk-*` 未出现在公开前端文件。
- 本地 API smoke：临时服务登录 `derrick`、AI 对话归档、Admin 对话列表、需求 TXT 解析、PPT outline、PPTX 生成、品牌补全通过；临时库写入 1 个 AI conversation、2 条 message、4 条知识记录、1 条 PPT 请求归档，PPTX 输出 38KB。

---

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
- 管理员种子账号支持 `DEFAULT_ADMIN_USERNAME`，并改为按 admin 角色判断是否已存在管理员，避免生产重启后重新补建旧 `admin` 账号。

### ✅ 验证
- `node --check app.js; node --check ppt.js; node --check server/server.js; node --check server/routes*.js; node --check server/services/*.js`
- `npm test`（18 项通过：原 AI/KB 用例 + 中文长句 RAG 引用 + Obsidian 安全导入 + 路径白名单拒绝 + 业务归档权限 + CRM 越权拒绝 + 私有客户列表防绕过 + 已分配客户防 claim + 公海商机写权限拒绝 + 种子密码不复用 + 管理员用户名可配置 + 默认密码扫描 + Markdown Vault 导出）
- API smoke：临时服务健康检查、管理员登录、Obsidian dry-run、平台 Vault export 通过。
- 真实本地同步：`D:\主盘\图灵集市` dry-run 命中 65 个可导入文件、跳过 9 个敏感/私密路径；已导入 65 条并导出 65 个 Markdown 到 `D:\图灵商务在线平台`。
- 线上部署回归：`<protected-production-host>` PM2 服务在线，健康检查通过；已同步安全筛选后的 Obsidian 65 个文件并导入 65 条知识，Vault 导出 66 条，AI 对话返回 5 条 `knowledge_references` 且 `ai_references` 落库。

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
- ✅ 阿里云生产环境部署 (<protected-production-host>)
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
# Changelog Update - v0.2.5-brand-intelligence-workspace (2026-07-02)

## v0.2.5-brand-intelligence-workspace (2026-07-02) - M1 品牌情报工作台重设计

### 品牌库 UI 重设计
- 将 M1 从旧版“标签树 + 单列品牌卡片”改为三栏品牌情报工作台：行业标签筛选、品牌结果列表、右侧品牌详情面板。
- 新增品牌统计条，显示品牌总量、行业标签数量、知识库沉淀状态和当前筛选结果。
- 右侧详情面板集中展示品牌规模、用户基础、搜索量、社媒粉丝、内容活跃度、互动率、内容机会、主推产品、社媒来源和竞品/关联品牌。
- 保留品牌数据 hover/title 解释，关键指标可查看口径说明。

### 功能闭环
- `AI Search` 继续走后端 `/api/brands/enrich`，补充后通过 `/api/brands` 保存，沿用后端品牌知识库归档路径。
- 品牌搜索历史、标签筛选、排序、CSV 导出、社媒搜索入口、竞品选择和“进入需求/方案”动作接入新版工作台。
- 品牌情报可直接带入 M3 需求/方案页，保持后续方案和 PPT 生成链路不变。

### 安全边界
- 未修改 `platform/ppt.js`、PPT 脚本版本、M3 方案生成、`latest_ui_compat_service` 或 RAG/PPT 后端桥接。
- 保留 `ppt.js?v=20260702v916kbbridge` 和 `window.tmPPTBuild = 20260702-v916-kb-bridge-client-cn`。

### 验证
- `node --test tests/brand_workspace_ui.test.js`
- `node --check platform/app.js`
- `node --check platform/ppt.js`
- `node --check platform/server/server.js`
- `node --check platform/server/routes_brands.js`
- `npm test` in `platform/server`: 21/21 passing
- Playwright smoke: login, open M1, search `EcoFlow`, verify workspace/detail/knowledge/opportunity/social sections and latest PPT bridge build.

---

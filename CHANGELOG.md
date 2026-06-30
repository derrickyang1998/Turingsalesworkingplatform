# Changelog — TuringMarket 图灵商务在线工作平台

## v9.0 (2026-06-26) — Apple-style UI 第一阶段

### v9.12 HTMLPPT / PPTX 结构化编辑器
- 在“需求接入 & 方案生成”Step 3 的 PPT 生成结果区新增 `编辑大纲/页面` 入口。
- 新增平台内编辑子界面：支持编辑方案标题、副标题、当前页标题、页面类型、备注和逐行页面要点。
- 支持新增页面、复制当前页、删除当前页、上移/下移页面顺序。
- 保存后会基于同一份 `lastPPTOutline` 重新生成 HTMLPPT，并继续作为 PPTX 下载的数据源，保证 HTML 和 PPTX 内容一致。
- 本地已通过浏览器自动化 smoke test：生成结果按钮存在、编辑器可打开、修改页面标题/要点后 HTMLPPT 同步更新。

### v9.11 企业介绍 PPT 案例扩充版
- 基于桌面原始 PDF `TuringMarket--图灵集市企业介绍.pdf` 生成新版 PPTX：`output/presentations/turingmarket-company-profile-cases/TuringMarket-图灵集市企业介绍-新增案例版.pptx`。
- 保留原 18 页公司简介视觉作为底稿，并在原“部分案例”章节后新增 3 页脱敏案例：美国运动瑜伽服、美国健身器械、美国智能家居空调。
- 新增案例按弱脱敏口径处理：隐藏品牌名、Logo、外部资料链接、红人身份和折扣码原文，保留行业、平台、地区、执行规模和核心结果数据。
- 已渲染 21 页预览并检查新增案例页排版，确认插入顺序为原第 1-7 页、新增案例 3 页、原后续页面。

### v9.10 线上 PDF/OCR 上传与 PPT 生成按钮修复
- 修复 Step 3 `PPT 汇报要求与补充材料` 上传扫描 PDF 时，PDF 文本解析器异常后直接降级为附件信息的问题。
- `server/extract_document_text.py` 在 PyMuPDF / pdfplumber / pypdf 均无法读取正文时返回 `needs_ocr=true`，不再让 `pypdf` 异常中断解析链路。
- `/api/demand/parse-file` 在文档解析器异常时，仍会对 PDF 和图片文件继续尝试本地 RapidOCR，成功后返回 `ocrUsed=true` 并把 OCR 正文并入 PPT 上下文。
- 线上已验证：文本型 PDF 上传显示已提取正文，扫描 PDF 上传显示已通过 OCR 解析，`生成 / 修改 PPT` 可正常调用 `/api/ai/ppt-outline` 并渲染下载入口。
- `index.html` 脚本版本号更新为 `20260629ocrfallback`，降低浏览器继续使用旧 JS 的概率。

### v9.9 PPT 生成前联网调研与策略落地链路
- `/api/ai/ppt-outline` 新增生成前联网调研：根据品牌、产品、行业、目标市场、平台和竞品自动构造搜索关键词。
- 搜索链路优先使用 `TAVILY_API_KEY` / `SERPER_API_KEY`，未配置时使用公开搜索兜底；搜索失败不阻断生成，会明确写入调研限制。
- PPT 大纲提示词升级为“需求匹配 + 市场信号 + 内容角度 + 红人组合 + 执行落地”的策略链路，避免只输出通用模板。
- HTMLPPT 增加 `联网调研与市场信号`、`调研来源与引用口径` 页面类型，并按行业选择稳定视觉系统。
- PPTX 生成同步读取 `research` 字段，自动补充调研页和来源页，保证 HTML 与 PPTX 内容依据一致。
- `/api/proposal/generate-ppt` 改为使用统一 `PYTHON_BIN`，线上会走已配置的 Python venv，避免 PPTX 生成依赖与 OCR 解析环境分裂。

### v9.8 OCR 服务接入预留
- 新增可选 `OCR_SERVICE_URL` 接入层：文本型 PDF / DOCX / PPTX / XLSX 仍优先走本地解析，扫描 PDF、图片 PDF 和图片文件在需要时转发到外部 OCR 服务。
- `server/extract_document_text.py` 改为输出结构化解析状态：`text`、`parser`、`needs_ocr`、`warnings`，并补充 PPTX 备注文本读取。
- `/api/demand/parse-file` 返回 `needsOcr`、`ocrUsed`、`parser`、`warning`，前端可区分“已 OCR 提取”“需要 OCR 服务”和“普通文本解析”。
- 修复 OCR 改造后 Excel 上传解析失败会打断需求上传的问题：Windows 本地默认使用 `py -3.12`，`.xlsx/.xlsm` 解析异常和旧版 `.xls` 均返回可继续的元数据兜底结果。
- 补齐 PDF 文本解析依赖声明并优化 PPT 补充材料逻辑：文本型 PDF 优先提取正文，未读取正文的扫描/图片 PDF 不再阻断 PPT 生成，仅作为附件清单保留并提示配置 OCR 或粘贴关键内容。
- 新增本地 RapidOCR 回退：扫描 PDF、图片 PDF 和图片文件在没有外部 `OCR_SERVICE_URL` 时也会自动渲染并识别正文，再进入需求解析和 PPT 补充材料上下文。
- 需求文件与 PPT 补充材料上传入口增加图片格式支持：JPG、PNG、WEBP、BMP、TIFF。
- 新增部署说明：`platform/docs/OCR_SERVICE_DEPLOYMENT.md`。

### v9.7 PPT 多轮补充要求与材料上传
- 在“需求接入 & 方案生成”Step 3 增加 `PPT 汇报要求与补充材料` 区域。
- 支持多轮输入 PPT 修改建议、追加页面要求、内容强化方向，生成/修改 PPT 时会作为高优先级上下文传入。
- 支持上传 PDF / Word / PPTX / Excel / 文本等补充材料，后端解析提取文本后并入 PPT 生成上下文。
- `/api/ai/ppt-outline` 新增 `deckContext` 和 `previousOutline` 输入：可基于上一版 PPT 大纲继续修改，而不是每次从零生成。
- 扩展 `/api/demand/parse-file` 文件解析能力：除 Excel 需求表外，新增 PDF、DOCX、PPTX 等补充材料解析。
- 参考 `frontend-slides` 的固定 1920×1080 舞台规则和 `beautiful-html-templates` 的完整视觉系统思路，重做 HTML PPT 输出：单文件零依赖、标准 16:9、整页缩放、键盘/触控翻页、进度条、打印友好。

### v9.6 需求表驱动的策略型 PPT + PPTX 输出
- 升级“需求接入 & 方案生成”的 PPT 产出逻辑：从泛化红人营销模板改为乙方向甲方汇报的策略提案结构。
- 新增 `/api/demand/parse-file`：上传 `.xlsx/.xlsm` 需求表后，后端解析 Excel 单元格文本，并把需求表原文带入 AI 分析和 PPT 生成。
- 升级 `/api/ai/ppt-outline` 提示词：要求结合客户产品信息、目标市场、平台、预算和方案草稿，输出具体可落地的甲方汇报大纲。
- PPT 结构升级为 12 页：需求理解、产品理解、目标用户与场景、策略主线、红人筛选标准、红人组合、平台打法、脚本方向、执行排期、KPI、风险保障、甲方确认事项。
- 新增 `下载 PPTX`：同一份策略大纲可生成可在 PowerPoint 中编辑修改的 `.pptx` 文件。
- 重写 `server/generate_ppt.py`：支持封面页、内容页、数据页、时间线页、下一步页等可编辑版式。

### v9.5 生成 HTML PPT 报错修复
- 修复“需求接入 & 方案生成”中点击 `生成 HTML PPT` 后提示 `Cannot read properties of undefined (reading '0')` 的问题。
- 根因：`ppt.js` 仍从浏览器直连 DeepSeek，并直接读取 `choices[0]`；当上游返回错误对象或 Key 失效时，前端抛出原始 JS 异常。
- 新增后端 `/api/ai/ppt-outline` 代理，统一使用服务器 `DEEPSEEK_API_KEY` 生成 PPT 大纲。
- 前端 PPT 生成改为调用后端代理，并增加基础模板兜底：AI 异常时仍可生成可下载、可预览的 HTML PPT。
- 重写 `ppt.js` 的输出提示和 Reveal HTML 生成逻辑，避免乱码文案和空数组访问。

### v9.4 需求文件上传后分析结果空白修复
- 修复上传 `.xlsx` 等需求文件后进入 Step 2 但 Brand / Product / Industry / Budget / Market / Platforms 全部为空的问题。
- 根因：前端把 Excel / Word / PDF / 图片等结构化或二进制文件直接 `readAsText()`，传给 AI 的内容不可用；同时后端在 AI 返回空字段 JSON 时没有合并降级解析。
- 前端新增上传文件名与文件元数据输入，结构化文件不再按纯文本读取乱码。
- 前后端新增字段合并逻辑：当 AI 返回空字段时，自动从文件名/需求文本推断品牌、产品、行业、渠道和基础需求，并保持字段可编辑。
- 已知边界：当前先基于文件名和元数据兜底，完整读取 Excel / PDF / Word 正文内容需要后续接入文档解析器。

### v9.3 需求接入 AI 分析无响应修复
- 修复“需求接入 & 方案生成”上传/填写需求后点击 `AI 分析需求` 显示 `Failed` 或无响应的问题。
- 根因：`analyzeDemandAI()` 仍使用前端旧 DeepSeek Key 直连上游，失败后只把状态改为 `Failed`。
- 新增后端 `/api/ai/demand-analysis` 代理，使用服务器 `DEEPSEEK_API_KEY` 进行结构化需求解析。
- 前端改为调用后端代理，成功后进入 Step 2，并填充 Brand / Product / Industry / Budget / Market / Platforms 等可编辑字段。
- 后端增加基础解析降级：AI 异常时仍返回可编辑字段，避免流程卡死。
- 验证截图：`output/playwright/prod-demand-ai-after-fix.png`。

### v9.2 AI 策略分析 401 修复
- 修复“AI 分析并生成策略”返回 `Analysis failed: API:401` 的问题。
- 根因：前端仍在使用旧的硬编码 DeepSeek Key 直连 DeepSeek，浏览器请求被上游拒绝。
- 改为后端 `/api/ai/strategy` 代理调用 DeepSeek，使用服务器环境变量 `DEEPSEEK_API_KEY`，避免 Key 暴露在浏览器。
- 后端增加降级策略草稿：AI Key 缺失或上游异常时，不再显示生硬 401，而是返回可编辑基础策略并提示管理员检查配置。
- 验证截图：`output/playwright/prod-ai-strategy-after-fix.png`。

### v9.1 CRM 筛选区排版优化
- 重新设计客户列表筛选区：客户范围切换、搜索框、阶段筛选、优先级筛选、主要操作按钮分层排布。
- 阶段标签独立为状态胶囊条，减少与下拉筛选和操作按钮的视觉冲突。
- 保留现有 `setCustomerScope`、`filterCustomers`、`loadCustomers`、`switchCrmView` 等交互逻辑。
- 验证截图：`output/playwright/local-filter-redesign-focus.png`。

### 范围
- 全局视觉框架升级为 Apple / Liquid Glass 方向：柔和渐变背景、半透明侧边栏、圆角卡片、蓝色主行动按钮、宽松信息间距。
- 登录页重设计：去掉默认后台感，改为居中玻璃卡片、产品价值说明和更清晰的入口按钮。
- 客户库 CRM 工作台重排：新增客户经营中枢、4 个核心指标、客户阶段漏斗、今日重点客户、AI 洞察模块。

### 保持不变
- 保留现有登录、客户筛选、公海池、商机看板、客户弹窗、客户表格和后端 API 调用逻辑。
- 本阶段未改待办中心和管理控制室，它们是下一阶段 UI 落地范围。

### 验证
- `node -c platform/app.js`
- `npm test` / Phase 8 release gate passed
- Playwright 本地截图：`output/playwright/local-apple-login.png`、`output/playwright/local-apple-crm.png`、`output/playwright/local-apple-crm-mobile.png`

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

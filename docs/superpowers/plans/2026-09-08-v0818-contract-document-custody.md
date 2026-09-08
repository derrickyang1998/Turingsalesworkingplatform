# v0.8.18 M4 Contract Document Custody / M4 合同文件托管

**Goal / 目标:** Add a production-ready signed-contract PDF upload, immutable custody, and authorized download flow to the existing M4 collaboration checkpoint without changing the current platform shell or frozen PPT implementation. / 在不改变当前平台界面骨架和冻结 PPT 实现的前提下，为现有 M4 签约节点增加可上线的合同 PDF 上传、不可变托管与授权下载闭环。

**Release cadence / 发布节奏:** Write focused failing tests first, run affected tests plus schema/security/recovery gates required by this migration, obtain one independent review, create a recoverable production backup, then deploy and verify online immediately. / 先编写聚焦的失败测试；运行受影响测试及本次迁移必须执行的 schema、安全、恢复门禁；完成一次独立审查和可恢复生产备份后立即上线并在线验收。

## Scope / 范围

- Store PDF bytes in a new append-only SQLite table so the existing database backup remains a complete recovery unit. / 将 PDF 字节存入新的 SQLite 只追加表，使现有数据库备份继续保持完整可恢复。
- Accept only canonical base64 PDF input, enforce an 8 MiB limit, verify PDF framing, reject active-content markers, and serve files only as non-sniffable private attachments. / 仅接受规范 base64 PDF，限制为 8 MiB，校验 PDF 文件边界并拒绝主动内容标记，下载时仅以禁止嗅探的私有附件形式返回。
- Keep uploaded contracts outside RAG content while creating generic, campaign-linked, retrieval-ineligible knowledge evidence. / 合同正文不进入 RAG，同时生成通用、活动关联且不可检索的知识证据。
- Require every new v2 signed-contract confirmation to bind one uploaded document; preserve existing schema-v1 confirmation evidence as read-only legacy data. / 所有新的 v2 签约确认必须绑定一份已上传文件；既有 schema-v1 确认证据按只读历史数据兼容。
- Add upload, list, and authorized download APIs plus a compact file picker and existing-document selector in the current M4 confirmation modal. / 增加上传、列表和授权下载 API，并在现有 M4 确认弹窗中加入紧凑文件选择与已上传文件复用控件。
- Show the bound contract and pending uploaded files in the existing collaboration evidence column; do not add a new page. / 在现有合作记录“阶段证据”列展示已绑定合同和待确认附件，不新增页面。

## API Contract / API 契约

`POST /api/collaborations/:id/contract-documents`

- JSON: `campaign_id`, `expected_version`, `filename`, `media_type`, `content_base64`.
- Required header: `Idempotency-Key`.
- Success: `201` with metadata only; no file bytes are returned.

`GET /api/collaborations/:id/contract-documents`

- Returns metadata visible to the authorized collaboration/campaign reader.

`GET /api/collaborations/:id/contract-documents/:documentId/download`

- Returns `application/pdf` with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, and `Cache-Control: private, no-store`.

`POST /api/collaborations/:id/contract-confirmations`

- Adds required `contract_document_id` and writes schema-v2 immutable confirmation metadata binding the document ID and SHA-256 digest.

## Security And Data Rules / 安全与数据规则

- Upload requires active campaign write access and a v2 collaboration in `confirmed` or `contract_sent`; list/download use campaign read access. / 上传要求活动可写权限，且 v2 合作状态为 `confirmed` 或 `contract_sent`；列表和下载使用活动读取权限。
- A collaboration can retain at most five unique PDFs; duplicate content is rejected by collaboration plus SHA-256 identity. / 每条合作记录最多保留五份唯一 PDF；以合作记录和 SHA-256 组合拒绝重复文件。
- Filenames are basename-only, control-character-free, `.pdf`, and bounded by characters and UTF-8 bytes. / 文件名仅允许安全基础文件名、不得含控制字符、扩展名必须为 `.pdf`，并限制字符数和 UTF-8 字节数。
- Document rows cannot be updated or deleted; confirmation evidence remains immutable. / 合同文件行禁止更新和删除，签约确认证据继续保持不可变。
- Sanitized migration copies replace sensitive BLOB bytes and rebuild the document SHA-256 relation before structural verification. / 脱敏迁移副本替换敏感 BLOB 字节，并在结构校验前重建文件 SHA-256 关系。

## TDD And Acceptance / 测试与验收

1. Add failing migration, service, route-policy, route, and M4 client tests. / 先增加迁移、服务、请求策略、路由和 M4 客户端失败测试。
2. Implement the smallest schema/service/API/UI changes needed to pass them. / 实施通过测试所需的最小 schema、服务、API 和 UI 改动。
3. Run focused tests, syntax checks, secret scan, frozen PPT hash check, migration exactness, sanitizer replay, and recovery checks. / 运行聚焦测试、语法检查、密钥扫描、冻结 PPT 哈希检查、迁移精确性、脱敏回放与恢复检查。
4. Obtain independent review and resolve blocking findings. / 完成独立审查并修复阻断问题。
5. Commit, back up production, deploy immediately, and verify health, login, M4 rendering, authorization, and non-mutating error paths online. / 提交、备份生产、立即上线，并在线验证健康、登录、M4 展示、权限和不产生业务数据的错误路径。
6. Sync `CHANGELOG.md`, version record, bilingual roadmap, progress dashboard, Obsidian archive, and GitHub. / 同步 `CHANGELOG.md`、版本记录、中英双语路线图、进度看板、Obsidian 归档和 GitHub。

## Deferred / 延后

Contract amendment versions, e-signature providers, inline PDF preview, OCR/extraction, active-content sanitization, payment ledger, settlement expansion, and review automation remain separate releases. / 合同修订版本、电子签平台、PDF 在线预览、OCR/抽取、主动内容净化、付款台账、结算扩展与复盘自动化继续拆分为后续版本。

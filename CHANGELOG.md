# Changelog - TuringMarket 图灵商务在线工作平台

## v0.7.4a-feishu-bitable-outbox (Production Deployed, 2026-09-02) - 飞书多维表格活动范围投递回执

### 交付与范围 / Delivery And Scope
- M4 已选网红的 Bitable 批量投递现在使用活动范围的持久化 Outbox：服务端保存精确批次快照、请求 UUID、执行者、活动、状态、远端记录回执和安全错误码。重放相同 UUID 不会再次向飞书发送请求，并只返回安全的计数与状态。
- 飞书或本地终态写入结果不完整时，投递保持 `pending`，不会自动重发或误报失败。活动 Owner 或组织管理员可使用受保护的手工对账接口，以已核实且唯一的远端记录 ID 完成回执；普通协作者无权对账。
- 终态回执在数据库层不可更新、删除或被 `INSERT OR REPLACE` 覆盖，即使 SQLite 关闭递归触发器也会拒绝替换。远端记录 ID 在服务层和数据库层均要求唯一，避免一个远端记录被误记为多条成功。
- 既有 CSV 兜底、Webhook 与最新 M4 界面保持兼容。M4 对待核对状态明确提示管理员核验，不宣称存在自动重试。v0.7.4a 不宣称“恰好一次”或盲目自动重发；自动化更新/重试与操作台继续作为后续独立切片。

### 定向验证、审查与上线 / Focused Verification, Review, And Release
- 受影响 Feishu/Outbox/导入流程 `31/31`、迁移和脱敏闭环 `3/3`、可信来源 `32/32`、部署/迁移/发布合同 `108/108`、真实 Express 重放 `8/8` 均通过；JavaScript 语法、`git diff --check`、敏感字面量扫描和 `deploy_v8.ps1 -ValidateLocalOnly` 通过。
- 独立复审先发现模糊响应对账、终态回执可变、重复远端 ID，以及 SQLite `INSERT OR REPLACE`/数据库唯一性边界问题；均以失败用例驱动修复并复审为 `APPROVE`。候选发布还安全拦截了一个遗留 v7 重放夹具断言，修复后由独立复审再次 `APPROVE`。
- 实现提交：`feedfba`；发布夹具修复：`5d4c683`。首个候选在任何生产写入前安全中止；最终受控备份为 `/root/turingmarket/backups/v060-crm-sales-workspace-20260902-021014`，顶层 `SHA256SUMS` 已校验，清单 SHA-256 为 `41473cddec70ea67e0fa96d3a7fc9daa931ac63e9c560b1f695b19fa15bd4395`。
- 最终切换通过受控迁移、隔离 Express 重放、发布网关、浏览器烟测、Nginx 与公共发布守卫。公网和回环 `/api/health` 均返回 `ok`，`/m4` 返回 `200`，PM2/Nginx online；数据库 `quick_check=ok`、外键异常 `0`、schema 版本 `8` 且 `feishu_bitable_outbox` 已存在。
- 本轮线上验收没有向真实飞书 Bitable 写入任何业务记录，因此不把外部投递成功作为已验证事实。

### 后续边界 / Next Boundaries
- v0.7.4b：为 Owner/组织管理员补齐可视化对账工作台，并在明确的活动和远端回执合同下设计更新、重试或补偿，不引入静默重发。
- 后续普通功能继续执行“受影响测试 + 一次独立审查 + 备份 + 立即上线 + 线上核心路径冒烟”；迁移、权限、共享运行时和外部写入保留高风险门禁。

---

## v0.7.3-feishu-bitable-batch-delivery (Production Deployed, 2026-09-01) - 飞书多维表格受控批量写入

### 交付与范围 / Delivery And Scope
- 既有“推送到飞书”入口现在可在 `FEISHU_BITABLE_WRITE_ENABLED=true` 时向飞书多维表格批量创建已选网红记录；开关默认关闭，未配置、配置不完整或开关关闭时保持既有 CSV 下载兜底，Webhook 行为不变。
- 每次写入都要求浏览器生成的裸 UUID `Idempotency-Key`，并传给飞书 `client_token`；重复点击合并为单请求，网络丢失响应时保留同一 UUID，服务器确认后才轮换。服务端始终重新读取活动网红并构造数据，不接受客户端记录内容。
- 写入前会获取 tenant token，验证远端 Bitable 必须具备批准的完整 20 列上传合同，再只发送允许字段。`网红联系方式` 列始终要求存在，但默认不发送联系人值；仅当 `FEISHU_BITABLE_INCLUDE_CONTACT_EMAIL=true` 时才显式发送。批次上限为 500 条，飞书逻辑成功码、返回数量和非空远端记录 ID 必须全部确认才报告成功。
- v0.7.3 是直接创建的可独立使用切片，不持久化远端 ID，也不包含 Outbox、自动重试、更新或对账；这些能力继续留给 v0.7.4，避免把未验证的“恰好一次”语义宣称为已完成。

### 定向验证、审查与上线 / Focused Verification, Review, And Release
- 受影响测试通过：Feishu provider `13/13`、客户端 UUID 重放 `1/1`、网红同步路由 `2/2`、飞书状态/管理员测试路由 `3/3`；JavaScript 语法、`git diff --check` 与 `deploy_v8.ps1 -ValidateLocalOnly` 通过。独立审查先发现逻辑成功码强制转换及 19 列远端预检两项阻断，补充 RED 用例修复后最终结论为 `APPROVE`，另验证 501 条边界拒绝。
- 实现提交：`06c7dd1`。受控生产备份：`/root/turingmarket/backups/v060-crm-sales-workspace-20260901-224913`，顶层 `SHA256SUMS` 已校验，清单 SHA-256 为 `acdae3dea97776e4ec2a0f3928db144a10267875051429b31f9a55f136c38ea0`。
- 发布候选通过可信来源、迁移演练、隔离 Express 重放、Nginx 合同、部署浏览器基线、解析器运行时和容量门禁后原子切换。公网与回环 `/api/health` 均为 `200` / `ok`、Parser ready，`/m4` 与 `/app.js` 均为 `200`，线上 `app.js` 已包含 Bitable UUID 逻辑，PM2/Nginx online。
- 生产服务器飞书配置当前为 `unconfigured`，因此线上验收只证明安全状态和 CSV 兜底路径，不执行真实飞书写入；启用前仍需在服务器端配置 Bitable 凭据、完整 20 列表头与写入开关。

### 后续边界 / Next Boundaries
- v0.7.4：活动范围的最小字段 Outbox、远端记录链接、已知 ID 更新、失败重放和管理员对账，继续按单功能闭环即发布。
- 解析器冷缓存下载是本轮唯一的长耗时环节；后续单独评估受控预热/复用，保持来源校验、隔离和回滚保护不变。

---

## v0.7.2-collaboration-resource-contract (Production Deployed, 2026-09-01) - M4 合作资源下单合同

### 交付与范围 / Delivery And Scope
- M4 合作下单现在使用版本化资源合同 `turingmarket.collaboration-order.v1`，将项目、产品、合作类型、资源/内容交付、对外报价及合同/PO 参考拆分为清晰字段，不再把资源定义混入备注。
- v1 仅接受 JavaScript 安全整数的非负金额；创建后规范报价锁定，避免资源合同价格与结算报价漂移。v1 资源与 `proposal_notes` 同时提交会明确拒绝，避免同一业务语义出现两个来源。
- 既有无 schema、`legacy.v0` 资源和历史备注/报价兼容保留；关联活动时，v1 合同资源、报价及业务上下文会一并归档，规范化重放保持幂等。M4 列表将资源交付、合同/PO 与备注分列展示。

### 定向验证、审查与上线 / Focused Verification, Review, And Release
- 受影响验证通过：资源合同 `7/7`、活动协作安全与幂等 `22/22`、网红工作流 `32/32`、M4 协作客户端 `5/5`、前端架构/浏览器基线工具 `28/28`。相关 JavaScript 语法、`git diff --check` 和 `deploy_v8.ps1 -ValidateLocalOnly` 均通过。
- 独立复审结论为 `APPROVE`。审查中发现的报价漂移、金额精度、遗留备注兼容、legacy schema 与空备注绕过均已补充负向测试并关闭。
- 首个候选在生产变更前因部署清单遗漏新服务文件安全中止；修复后第二个候选因冷解析器依赖缓存的 30 分钟上限安全中止。最终仅补齐服务文件清单并将受控解析器缓存上限调整为 60 分钟，生产切换成功。
- 实现与发布修复提交：`01c202e`、`0fe9990`、`002e75a`。受控生产备份为 `/root/turingmarket/backups/v060-crm-sales-workspace-20260901-210048`，顶层 `SHA256SUMS` 校验通过，清单 SHA-256 为 `a0b5e8b48470f15a157d0d7ff626d8d32db69a7dec5fae1c8487444c70f0f894`。
- 公网与回环 `/api/health` 均为 `200` / `ok`、Parser ready，`/m4` 返回 `200`，PM2/Nginx online，发布锁已清理，SQLite `quick_check=ok` 且外键异常为 `0`。为避免污染真实合作记录，本轮未以生产数据执行 M4 创建、更新或状态流转写入烟测。

### 后续边界 / Next Boundaries
- 解析器依赖缓存的安全复用或预热将作为独立可靠性切片评估，不在本版本以降低校验强度换取速度。
- 飞书多维表格的字段映射、远端记录 ID、Outbox、重试/对账和幂等写入，以及真实测试活动交易验收，继续按单功能切片完成后立即上线。

---

## v0.7.1-feishu-connection-foundation (Production Deployed, Bitable Writes Deferred, 2026-09-01) - 飞书连接基础

### 交付与范围 / Delivery And Scope
- M4 网红匹配与执行管理新增受保护的飞书连接状态：所有登录用户可查看不含凭据的配置状态；管理员可执行服务器端连接验证。界面会明确区分未配置、Webhook 已配置和飞书多维表格只读配置，并在同步后刷新状态。
- 既有已选网红 Webhook 推送和 20 列 CSV 兜底保持兼容。Webhook 仍是本切片唯一的线上写入传输；飞书多维表格当前只支持配置与只读访问验证，推送会返回 CSV 供手动导入。
- 未配置状态下，管理员测试接口以 `409 FEISHU_NOT_CONFIGURED` 安全降级，不会向外部发起请求。Webhook 测试只允许使用独立的 `FEISHU_WEBHOOK_TEST_URL`；多维表格验证只读取一页记录。

### 定向验证、审查与上线 / Focused Verification, Review, And Release
- 定向验证通过：Feishu provider `8/8`、状态/管理员测试路由 `3/3`、完整网红工作流 `25/25`、M4 活动协作客户端 `5/5`、协作权限/幂等 `5/5`、不启动浏览器的部署基线工具 `14/14`。相关 JavaScript 语法、`git diff --check` 与 `deploy_v8.ps1 -ValidateLocalOnly` 均通过。
- 独立代码审查结论为 `APPROVE`，未发现发布阻断项；补充了“HTTP 200 但飞书逻辑成功码缺失”必须失败的负向用例，避免把代理或畸形响应误报为连接成功。
- 实现提交为 `1beeb79`。受控发布已完成，备份为 `/root/turingmarket/backups/v060-crm-sales-workspace-20260901-184658`，顶层 `SHA256SUMS` 校验通过，清单 SHA-256 为 `fb52057ff6a9363009eb02ec5071b8de104a5fafa0ecbdd1d29c4d5139b471da`。
- 线上公网与回环 `/api/health` 均为 `200` / `ok`、Parser ready，PM2/Nginx online，发布锁已清理，数据库 `quick_check=ok` 且外键异常为 `0`。M4 页面为 `200`，公网 `app.js` 已含飞书状态加载逻辑。认证后的连接状态读取返回未配置安全态；管理员测试接口按预期返回 `409 FEISHU_NOT_CONFIGURED`，未触发外部飞书请求，临时烟测会话已清理。

### 刻意延后 / Intentionally Deferred
- 多维表格记录写入、字段最小化映射、远端记录 ID、Outbox、重试、对账和幂等写入将在后续独立切片实现；在这些合同完成前，不将客户或网红数据直接写入多维表格。

---

## v0.7.0-m4-campaign-collaboration (Production Deployed, M4 Transaction Acceptance Pending, 2026-09-01) - M4 活动协作工作台

### 交付与范围 / Delivery And Scope
- M4 网红匹配与执行管理现可选择当前用户可访问的活动；下单、执行、发布和结算会在同一活动上下文中读取、写入并展示，不选活动时仍保留原有独立合作记录路径。
- 合作列表支持按活动筛选并返回受控的活动上下文、行版本和当前关系投影；现有导入、飞书降级导出、合作资源下单、状态推进和结算流程保持兼容。
- 本次补充的浏览器部署夹具精确模拟 `GET /api/campaigns?limit=100&operational_status=active` 的正式响应合同，仅用于候选环境验证，不改变生产业务接口或最新 UI/PPT 客户端字节。

### 定向验证、审查与上线 / Focused Verification, Review, And Release
- M4 直接矩阵通过：客户端活动选择、下单、生命周期和可重放动作 `5/5`；活动协作创建/筛选/更新/取消的权限与幂等合同 `4/4`；既有导入、飞书和合作资源控制接线 `1/1`。部署夹具工具 `14/14`、发布合同 `37/37`、JSON 夹具解析、`git diff --check` 与 `deploy_v8.ps1 -ValidateLocalOnly` 也均通过。
- 独立代码审查确认活动夹具响应与正式 `GET /api/campaigns` 投影一致，筛选与分页语义正确，且改动严格限于部署测试资产；结论为 `APPROVE`。
- 受控候选完成隔离迁移演练、依赖构建、解析器检查、数据库迁移、Nginx 合同及部署浏览器冒烟 `2/2`。生产切换后公网和回环 `/api/health` 均返回 `200` / `status=ok`，Parser ready，PM2/Nginx online，发布锁已清理。可恢复备份为 `/root/turingmarket/backups/v060-crm-sales-workspace-20260901-172316`。
- M4 改动跨越公共 UI、路由、协作服务和归属权限，不按普通功能切片降级处理。当前线上证据证明发布完整性与 M4 路由可用；为避免向真实客户活动写入并撤销合成合作数据，线上 M4 业务写入/状态流转验收尚未执行，不能由通用部署浏览器冒烟 `2/2` 代替。

### 发布节奏 / Release Cadence
- 自本功能起，常规开发按“完成一个可独立使用功能 -> 受影响测试与必要语法/契约检查 -> 一次独立审查 -> 备份 -> 当轮上线 -> 线上核心路径冒烟”推进，不再等待无关的完整回归。M4 本次作为跨边界功能，保留了额外的活动协作安全/幂等矩阵。
- 数据库迁移、认证/权限、共享运行时、部署控制、安全和广泛跨模块变更仍按高风险门禁处理；已有受控生产发布守卫继续执行，不以牺牲回滚能力换取速度。

---

## v0.7.0-ai-knowledge-loop-task4e (Production Accepted, 2026-09-01) - 业务产物知识归档与发布守卫收敛

### 生产交付 / Production Delivery
- Phase 6 Task 4E 的 `tm-business-artifact-v1` 已随受控生产发布接受：需求表、网红导入批次、确认方案、PPT 成品、项目复盘、AI 自动摘要与人工精选可按统一业务产物合同沉淀、去重、关联并保留可复用血缘。最新 v0.6 产品界面与冻结 PPT 客户端字节未替换。
- 发布守卫改为在公网流量恢复后复用精确 Nginx 验证器。该验证器只对 Nginx 优雅重载期间的瞬时 `503` / 连接收敛状态做有界重试，随后仍逐项验证公网路由、拒绝边界、JavaScript MIME 和健康接口；任何非瞬时错误继续失败关闭。
- 首次热修候选在生产变更前被容量门禁阻止：可用空间 `6,814,842,880` bytes 低于候选依赖验证所需 `7,086,696,039` bytes。经进程、服务和配置引用复核后，仅删除两份未引用的历史解析器构建暂存目录（各 `327,147,156` bytes），未触碰业务数据、当前运行时或版本备份；重试容量门禁以 `7,400,501,248 / 7,086,696,039` bytes 通过。

### 验证、审查与上线 / Verification, Review, And Release
- 红绿测试覆盖发布守卫收敛契约；`release_v060_contract` 为 `35/35`，运行时与发布聚焦矩阵为 `93` 通过、`0` 失败、`3` 个仅 Linux 环境跳过，前端公共资产热修用例 `5/5` 通过，`-ValidateLocalOnly` 通过。独立审查先发现移除旧辅助函数后残留的前端测试契约，修正后最终结论 `APPROVE`。
- 生产受控发布完成候选隔离迁移、真实 Express 重放、安全边界、依赖构建、Parser 自检、数据库迁移、Nginx 静态边界及部署浏览器冒烟（`2/2`）验证；已创建可恢复备份 `/root/turingmarket/backups/v060-crm-sales-workspace-20260901-131109`。
- 公网验收通过：`/api/health` 返回 `ok` 且解析器清单为 `7d1c5bd2bb3b33d954513d107950c55e6d1468f2b1ecef9ae56d2349c861927d`；`/app.js` 返回 `200` 和 `text/javascript`；Nginx active、PM2 进程在线、发布锁与临时公网守卫均已清理。完整的人工交互浏览器验收仍作为后续阶段收口，不被本次部署冒烟替代。
- 功能级发布节奏自本版本起固定：普通功能完成后执行受影响测试、必要语法检查、独立审查、备份、上线和线上核心路径冒烟；仅数据库迁移、安全/systemd、广泛跨模块改动或阶段收口执行完整回归。
- 版本记录、仓库归档与 Obsidian 归档的 SHA-256 一致；GitHub 分支 `codex/v0.7.0-ai-knowledge-proposal-ppt-loop-production` 已同步至 `7714825`。

---

## v0.7.0-ai-knowledge-loop-task4e (Release Candidate, 2026-08-28) - 业务产物统一知识归档

### 统一业务产物合同 / Unified Business Artifact Contract
- 需求表、网红导入批次、确认方案、PPT 成品、项目复盘、AI 自动摘要和人工精选统一使用 `tm-business-artifact-v1`，并记录产物类型、生命周期、业务归属、内容身份和可复用血缘。
- 旧版业务产物精确重放会复用原知识条目；同一来源身份的内容、元数据或业务归属发生变化时返回确定性冲突，不再静默覆盖不可变知识。Campaign 方案和 PPT 路径继续保持原子业务写入、知识归档、关联和回滚。
- Legacy PPT 以规范输入哈希和实际成品哈希共同标识成品，因此同一输入产生不同有效字节时可分别归档；生成或归档失败会同时清理 JSON 与 PPT 临时文件。
- Task 4C 的旧版人工精选继续幂等复用，但只有 `promotion.trigger=manual` 的旧 `ai_message` / `campaign_ai_message` 会被识别，自动摘要不会被误判为人工精选。
- 网红上传在现有前端默认把文件名作为批次值时改由上传文件 SHA-256 派生不可变批次；同名新版文件可再次导入，显式自定义批次仍保留原冲突语义。行写入和批次知识归档保持同一事务。
- 严格 `local-worker` 测试适配器使用固定容量投影，避免开发机磁盘低于生产 2 GiB 安全线时阻断功能测试；生产模式仍使用真实文件系统容量门。已验收的 `app.js` 与冻结 `ppt.js` 字节未修改。

### 验证与发布状态 / Verification And Release State
- 受影响轻量回归 `27/27`、最终 PPT 精确用例 `1/1` 通过；部署信任硬门 `79` 通过、`0` 失败、`10` 项按 Windows 环境跳过。16 个变更 JavaScript 文件语法、`git diff --check`、聚焦敏感信息扫描、可信清单、真实本地发布预检及冻结前端哈希均通过。
- 独立审查关闭 PPT 非确定性成品身份、Task 4C 人工精选兼容、同名新版网红文件及一条测试断言问题后，最终结论为 `APPROVE`。本地批准实现提交为 `1e25379d126c43e3f38730b269531a2b903a650a`。
- 阶段 6 非浏览器收口矩阵覆盖 25 个文件、245 项测试并全部通过。首轮唯一失败是旧测试仍要求需求表/确认方案知识元数据为空；该断言已对齐 `tm-business-artifact-v1` 的 `requirement_sheet:ingested` 与 `confirmed_proposal:confirmed` 契约，干净复跑 `245/245`。本次仅修正测试契约，不改变运行时代码；独立跟进审查无任何级别发现，结论为 `APPROVE`。
- 本记录当前是发布候选，不是生产验收记录：权威工作区和 GitHub 远端仍为 `50867bc8fa662c0ccb518508fd8ceaf39fab6412`；当前执行沙箱无法写入权威目录或读取部署 SSH 私钥，因此尚未创建 Task 4E 远端备份、切换生产或执行线上冒烟。

---

## v0.7.0-ai-knowledge-loop-task4d4 (Production Slice, 2026-08-27) - 知识治理与发布恢复加固

### 迁移、清理与 Campaign 治理 / Migration, Cleanup, And Campaign Governance
- 可信迁移合同显式接受受管 schema `1/6/7`：v1/v6 执行固定双跑保持性验证至 v7，受管 v7 走 no-op；篡改 007 并改写既有业务数据会失败关闭。
- 新增唯一受支持的 `deployment_smoke` 知识清理服务，拒绝已有引用、Campaign 托管、不完整血缘及非验收来源；FTS、治理和知识投影在嵌套事务保存点内原子清理，中途故障完整回滚。
- Campaign 知识候选、直接关联、列表、详情与 AI 使用统一治理过滤；拒绝、过期、被替代或非当前知识不能再进入项目能力链或增加使用计数。
- bootstrap 安装并启用精确 `pm2-root.service`；发布与回滚从 ecosystem 重建精确 PM2 投影，并在保存 dump 前验证 unit、固定入口和 enabled 状态。受控分支及运行手册同步到 v0.7 单功能加速节奏，冻结 UI/PPT 未修改。

### 验证与生产发布 / Verification And Production Release
- 独立最终复审为 `APPROVE`，Critical/Important/Minor 均为 0。发布源合同 `57/57`、公网静态边界换用 D 盘临时夹具后 `9/9`、运行时加固 `58 通过 / 3 个仅 Linux 跳过`、清理回滚 `4/4`、可信 v6/v7 `5/5` 及 Campaign 最终负向用例 `1/1` 通过；真实 `-ValidateLocalOnly`、三类语法、diff、敏感信息、50 文件可信清单和冻结资产校验通过。
- 实现与 GitHub SHA 为 `f65fcf47d51fdd3487843211c5cc566ee3835823`；增量包 SHA-256 `47538fe9ff84e82fca3e71d688118992c7846640e184370d0a1f3dcea3cb0053`，清单 SHA-256 `bc6f6155293074fa292dd6adeeea1243cfb1251e03cd4da3db64946948582ddd`。
- 可验证备份为 `/root/turingmarket/backups/v070-slice4d4-governance-hardening-20260827-112449`，聚合 SHA-256 `6eaa544d52701b80aa91b0f4cf81a7b8d8ec03b19815a1a497b3d898be83c2b8`；容量要求 `188,096 KiB`，可用 `8,159,448 KiB`，发布阶段目录为 `/root/turingmarket/releases/v070-slice4d4-governance-hardening-20260827-112449`。
- 线上内外健康 `ok`、解析器 ready、PM2 PID `7177`、PM2 unit enabled/active、Nginx active；schema v7、知识/治理 `123/123`、chunks/FTS `857/857`、SQLite/外键/FTS 完整性均通过。
- 真实 HTTP 冒烟通过双角色登录、知识治理、Campaign 候选过滤和失效知识直接关联拒绝；无链接或幂等账本副作用。最终启用验收账号、会话和 `deployment_smoke` 知识均为 0，独立后验通过后远端 `/tmp` 上传件已清理。安装/公网 `app.js` 哈希保持 `ed304b9d...5c93`，冻结 `ppt.js` 哈希保持 `f311a7b3...e291e`。

---

## v0.7.0-ai-knowledge-loop-task4d3 (Production Slice, 2026-08-27) - 知识质量、版本血缘与保留治理

### 可治理知识生命周期 / Governed Knowledge Lifecycle
- 新增 schema v7 `knowledge_entry_governance` 侧表，为既有及新增知识统一提供 `candidate / confirmed / rejected` 质量状态、`protected / scheduled` 保留策略、版本号、当前版本、替代关系、血缘根和乐观治理版本；123 条生产知识完成无损回填。
- 管理员可在知识库中确认、拒绝、设置保留期限或用已确认知识替代旧版本；普通用户不能调用治理 API。每次治理变更写入只追加 `activity_log`，历史版本仍可供既有引用审计，但不能再次执行治理动作。
- RAG/FTS 检索现在排除已拒绝、非当前、已过期知识，并优先排序已确认知识；知识详情继续保留历史引用可读性、业务关联、可见性和引用计数。现有 v0.6 产品壳层与冻结 PPT renderer 均未替换。
- 生产 systemd 升级至 259 后，严格解析器策略读取兼容 deny-all 两个精确前缀的等价输出顺序；不完整、额外或畸形策略仍失败关闭，未放宽任何网络隔离要求。

### 验证与生产发布 / Verification And Production Release
- 实现提交为 `032fab7`，systemd 259 兼容提交为 `41352b2`。知识治理测试 `5/5`、解析器单元矩阵 `36/36`、运行时聚焦验证 `4/4`、可信来源/发布聚焦验证 `3/3` 通过；真实解析器设备自检 `21/21` 通过。独立审查关闭历史版本可变更问题后为 `APPROVE`，兼容修复独立复审同样为 `APPROVE`。
- 首次重启因 systemd 259 属性顺序漂移停止并自动恢复；兼容修复在不改变策略集合的前提下恢复生产。首轮 v7 线上烟测清理又暴露自引用外键删除顺序问题并自动回滚。后续主机重启暴露 root PM2 未配置 systemd 自启动，同时验收清理遗留 3 条孤立 FTS 投影（`860/857`）；修复先建立 `/root/turingmarket/backups/runtime-recovery-fts-20260827-173656`，备份清单 SHA-256 `8537b8946d5445a6f342c0ece4d2d24b49ce37a2d0d1b6b52410784a6bdacbe3`，再重建 FTS 至 `857/857`，并安装启用精确 `pm2-root.service`。
- 最终可验证备份为 `/root/turingmarket/backups/v070-slice4d3-knowledge-governance-20260827-062433`，聚合 SHA-256 为 `34e8a4fb1952a7d4424e96afd70b532339da50ac6572044a18cd44f8188be11c`；容量要求 `276,728 KiB`，发布前可用 `8,254,328 KiB`。发布阶段目录为 `/root/turingmarket/releases/v070-slice4d3-knowledge-governance-20260827-062433`。
- 线上 schema v7、迁移 007 校验和 `8914205f9c63209e83948b317354453f067038389eb1053a267c714f92a54dcd`、知识/治理记录 `123/123`、治理审计 5 条、SQLite `quick_check=ok`、外键异常 0；普通用户治理拒绝、确认/替代/保留及活动检索路径均通过。
- 恢复验收时 PM2 PID 为 `4867`，`pm2-root.service` unit SHA-256 为 `b81d5362a43a97f2ef8527dfb4d7be8b6123029a02e6714f08b69e80cad93f5e` 且 enabled/active，Nginx active，内外健康均为 `ok`；公网与安装 `app.js` SHA-256 同为 `ed304b9d21ab2fbee46f7449eb2b3af432b8bdb6a37e77434f8ae8ccc03a5c93`，解析器 manifest 与冻结 `ppt.js` 哈希保持不变。
- 本切片按批准的轻量单功能节奏发布，未运行浏览器自动化；完整非浏览器回归与浏览器验收保留到阶段 6 收口。下一切片统一确认方案、PPT 成品及其他确认产物的知识入库契约。

---

## v0.7.0-ai-knowledge-loop-task4d2 (Production Slice, 2026-08-26) - 版本化 AI 成本投影

### 版本化计价与审计 / Versioned Pricing And Audit
- DeepSeek 默认模型更新为 `deepseek-v4-flash`，并显式关闭 thinking 以保持既有非思考式产品行为；每次成功回复按完成时间、模型、缓存命中/未命中输入 Token 和输出 Token 固化不可变计价快照。
- 首期策略固定为 `deepseek-v4-usd-2026-08-13-v1`，使用整数 nano-USD 计算工作日 UTC 峰/谷时段的 V4 Flash 与 V4 Pro 费率，避免浮点漂移。历史消息没有合法快照时显示“投影成本不可用”，不会使用可变化的当前价格追溯重算。
- 成本快照执行严格闭合验证：Provider、模型、策略版本、时段、费率、Token 算式和总额必须一致；不完整、伪造、继承属性模型名和超出安全整数的汇总均失败关闭。列表使用与详情相同的服务端投影器，通过单一确定性 SQLite 函数聚合，避免列表/详情口径漂移和无界 Node.js 加载。
- 管理员 AI 审计列表显示“投影成本/部分投影成本/投影成本不可用”，详情逐次显示同源投影；普通用户会话隔离和管理员读取审计保持不变。无数据库迁移，现有产品壳层与冻结 PPT renderer 未替换。

### 验证与生产发布 / Verification And Production Release
- 实现提交为 `bb08c4f`；最终受影响矩阵 `113/113` 通过，JavaScript 语法、`git diff --check`、聚焦敏感信息/乱码扫描及冻结 PPT 哈希均通过。两位独立审查者提出的聚合溢出、SQLite 整数实数一致性、继承属性模型名、伪造快照和遗留 fallback 模型问题全部新增 RED 用例并关闭，最终复审为 `APPROVE`。
- 已验证发布备份为 `/root/turingmarket/backups/v070-slice4d2-ai-cost-projection-20260826-131957`，聚合 SHA-256 为 `ad4337a5a1c6bc17a5e82342ca3009ed17437e29b7ec11034d50e27bc8e039c2`；容量要求 45,096 KiB，发布前可用 8,610,016 KiB。SQLite Backup API 副本与源库均为 `quick_check=ok`、外键异常为 0，回滚脚本及逐文件校验和已复核。
- 生产仅替换 `app.js`、`ai_service.js`、`llm_service.js` 并新增 `ai_cost_service.js`；SHA-256 分别为 `8b5f2ec4a171fb149b8e8e354cd3fd9d9479ddd92ebe522c7ff1ab593f6fa92e`、`b0e524fb537f70aa5cdb69b6eb0c5ea9d8dec2904d7aa99eef06d9a2bcffd3cb`、`b6e9cdb9c258e4271995d2eba4d43cc6ee3b6f19fdabac791d54926d8452e9a6`、`101a87a0574f2bc037e5c75bfb84e581c5ef2190041cc8edb16218c179e83acc`。公网 `app.js` 与安装字节一致，PM2 PID 为 `1417880`。
- 线上真实 HTTP 验收通过三角色登录、DeepSeek V4 Flash 非降级回复、Token 与计价快照持久化、管理员列表/详情金额一致、所有者读取、普通用户跨所有者 `404` 和两条精确管理员读取审计。首轮验收的功能断言已完成，但清理脚本删除审计日志时被只追加保护拦截；修正为保留审计后整套复跑通过，临时对话、会话和启用验收身份均为 0。
- 解析器清单匹配、Nginx active、SQLite `quick_check=ok`、外键异常为 0；冻结 `ppt.js` SHA-256 保持 `f311a7b33ee28e64c8e19a14bae436101272dd17bf2f4f8c5d181d57dd0e291e`。本切片继续采用轻量单功能发布节奏，未运行浏览器自动化；下一切片为 Task 4D3 知识质量、版本替代与保留治理。

---

## v0.7.0-ai-knowledge-loop-task4d1 (Production Slice, 2026-08-26) - AI 运行状态与 Token 投影

### 统一运行审计 / Unified Run Audit
- AI 对话列表和详情现提供同一套 `run_summary`，逐条 assistant 消息提供有界 `run` 投影，统一显示成功、降级、失败、未知、未完成或混合状态，以及模型、Prompt/Completion/Total Token、延迟和知识/Web 引用数量。
- 历史成功对话后追加但未完成的用户问题会明确显示“未完成”；畸形或非对象运行元数据安全归为“未知”，延迟只接受 0 至 1 小时内的真实整数，Token 累计封顶于 JavaScript 安全整数。
- 管理员 AI 对话审计列表增加紧凑运行摘要，详情展示每次运行状态、Token 分项和延迟；所有后端文本继续转义，普通用户仍只能读取自己的会话，管理员读取继续写入审计。
- 列表侧改为 SQLite 按会话分组聚合，不再把最多 300 个会话的全部历史 assistant 消息载入 Node.js。无数据库迁移、无生成/RAG 行为变更，现有产品壳层与冻结 PPT renderer 保持不变。

### 验证与生产发布 / Verification And Production Release
- 实现提交为 `1d65b6d`；最终受影响矩阵 `94/94` 通过，独立复审在关闭引用计数一致性、尾部未完成提示、Token 累计、延迟类型和长历史查询五项发现后为 `APPROVE`。JavaScript 语法、`git diff --check`、新增行敏感信息扫描和冻结 PPT 哈希均通过。
- 已验证发布备份为 `/root/turingmarket/backups/v070-slice4d1-ai-run-projection-20260826-120239`，聚合 SHA-256 为 `86cad01ea86dc1e4c13d6374353e249bde9cb816fef57a5ecb99e26319b6b8ac`；容量要求 77,817 KiB，发布前可用 8,624,212 KiB，SQLite Backup API 副本 `quick_check=ok`、外键异常为 0。
- 生产仅替换 `app.js` 与 `ai_service.js`，SHA-256 分别为 `d4b66c5c6360f4059a31e8fff0b14a46eb76212fcf092ec5e43082de565be76d` 与 `bc645faeb2ca32cdda04435538c4eb97cfb8f6f730b67c355761d5933f0ed305`。首次切换因 Node 不接受 `.new` 临时扩展名做语法检查而在生产变更前停止；改用 `.js` 临时文件后上线成功，PM2 PID 为 `1415442`。
- 最终真实 HTTP 冒烟通过所有者与管理员运行投影、普通用户跨所有者 `404`、两条精确管理员读取审计和完整清理。前两次验收脚本分别暴露生产 JSON 完整性约束和历史审计脏 JSON 的脚本兼容问题，均未造成产品故障或残留；最终临时会话、对话和启用账号均为 0。
- 公网 `/`、`/m5`、`/admin`、`/api/health` 与 `/app.js` 均为 200，公网客户端哈希与发布字节一致；解析器 ready、Nginx active、SQLite `quick_check=ok`、外键异常为 0。冻结 `ppt.js` SHA-256 保持 `f311a7b33ee28e64c8e19a14bae436101272dd17bf2f4f8c5d181d57dd0e291e`。
- 本切片继续采用轻量单功能发布节奏，未运行浏览器自动化；完整回归保留到阶段 6 收口或广泛风险变更。下一切片为 Task 4D2 的版本化模型定价与成本投影。

---

## v0.7.0-ai-knowledge-loop-task4c (Production Slice, 2026-08-26) - AI 回复手动沉淀知识库

### 可控沉淀与知识归属 / Controlled Promotion And Knowledge Custody
- M5 已在持久化的 AI 回复下增加“沉淀到知识库”操作；自动晋升过的回复显示只读“已沉淀”。前端仅提交后端返回的会话/消息 ID，文本继续先转义再渲染，不引入原始 HTML。
- 会话所有者可把自己的 assistant 回复沉淀为私有或团队知识；平台管理员可在已有授权范围内代为整理，普通用户无法沉淀他人的回复。
- 同一消息重复请求只返回原知识条目，不产生重复知识；Campaign 关联回复继续保留原 Campaign 归属、知识关联和容量治理。
- 首次成功、幂等重放和拒绝请求均写入有界 `ai_knowledge` 审计，记录请求、会话、消息、知识、可见性、结果和安全错误码；审计失败会使知识写入整体回滚。

### 验证与生产发布 / Verification And Production Release
- 实现提交为 `d38a34c`；定向回归 `72/72` 通过，JavaScript 语法、`git diff --check`、新增行敏感信息扫描和冻结 PPT 哈希均通过，独立终审为 `APPROVE`。
- 已验证发布备份为 `/root/turingmarket/backups/v070-slice4c-manual-ai-promotion-20260826-190822`，聚合 SHA-256 为 `596c10f8d1ee11e140b45402c28889c6ed2d56856b33f9ea029951bece593a25`；SQLite Backup API 副本 `quick_check=ok`、外键异常为 0。
- 生产仅替换 `app.js`、`index.html`、`server.js` 与 `ai_service.js`；App build 和冻结 `ppt.js` 保持不变。发布后 PM2 PID 为 `1413180`，公网 `/`、`/m5`、`/admin`、`/api/health` 与客户端资源均为 200。
- 线上真实 HTTP 验收通过所有者首次沉淀、同消息幂等重放、普通用户越权 404、管理员代为沉淀和 4 条精确审计。首个验收脚本在功能与清理完成后因末尾验证查询错误返回非零；独立只读复核确认临时会话、对话和知识均为 0、验收身份已停用，最终 SQLite 与服务健康检查全部通过。
- 本切片继续采用轻量单功能发布节奏，未运行浏览器自动化；完整回归保留到阶段 6 收口或广泛风险变更。

---

## v0.7.0-ai-knowledge-loop-task4b2 (Production Slice, 2026-08-26) - 联网来源治理与高价值摘要晋升

### 受控联网与自成长知识 / Governed Web Sources And Self-Growing Knowledge
- Tavily 查询现统一规范化并限制长度；只接收绝对 HTTP/HTTPS 来源，去除凭据、锚点和常见追踪参数，按规范 URL 去重，并限制标题、摘要、评分和结果数量。Provider 原始 `response`、`answer` 与内部异常不再进入接口、引用或缓存。
- 联网搜索增加 8 秒默认超时、一次有界重试、连续失败熔断、稳定安全原因码和 24 小时受治理缓存降级；即使 AI 请求已带总截止信号，Tavily 仍使用独立子信号在超时时真正中止底层请求。
- 原始 AI 对话、消息和引用继续全量留存；只有内容充分且具备受治理知识/Web 证据的回复默认晋升为 `ai_chat_summary`。未确认草稿、低价值、无证据和降级回复只留在会话审计中，晋升决定与策略版本写入知识元数据。
- M5 引用区标记缓存联网来源，并在自动晋升时提示“已自动沉淀为可复用知识”；现有 v0.6 产品壳层、App build 与冻结 PPT renderer 均未替换。

### 验证与生产发布 / Verification And Production Release
- 实现提交为 `184e3dc`；最终受影响矩阵 80/80 通过，JavaScript 语法、`git diff --check`、聚焦敏感信息扫描和冻结 PPT 哈希均通过。独立复审先发现超时只结束等待但未中止底层请求，新增 RED 回归并修复后最终结论为 `APPROVE`。
- 已验证发布备份为 `/root/turingmarket/backups/v070-slice4b2-web-governance-summary-20260826-100544`，聚合 SHA-256 为 `004e4b95e45973d2bc3b2bdedc311873d256da0c54c521c11fa251e4c0c2ebbf`；容量要求 574,480 KiB，发布前可用 8,647,868 KiB。SQLite Backup API 快照通过 `quick_check` 与外键检查。
- 发布保护在两次临时验收脚本变量冲突时均自动恢复旧代码并确认健康，第三次使用同一验签候选成功发布。13 条历史搜索缓存已在已验证数据库备份后清空，避免旧格式原始 Provider 数据继续保留。
- 线上烟测通过登录、AI 对话持久化、管理员全局可见、普通用户跨会话 404、普通用户管理员目录 403、真实 Tavily 联网与 2 条受治理来源，以及生产结构副本上的高价值摘要晋升。可复用审计身份均停用，临时会话和测试对话为 0。
- 公网 `/`、`/m5`、`/admin`、`/api/health` 均返回 200；解析器 ready，PM2 PID 为 `1411078`，Nginx 配置与服务正常，SQLite `quick_check=ok`、外键异常为 0。冻结 `ppt.js` SHA-256 保持 `f311a7b33ee28e64c8e19a14bae436101272dd17bf2f4f8c5d181d57dd0e291e`。
- 本切片按加速节奏执行，未运行浏览器自动化；完整回归继续保留到阶段 6 收口或跨认证、权限、迁移、运行时和基础设施的高风险变更。

---

## v0.7.0-ai-knowledge-loop-task4b1 (Production Slice, 2026-08-26) - 管理员 AI 对话审计

### 全量筛选与来源审计 / Full Audit Filters And Sources
- 管理控制室的 AI 对话审计现支持按用户、模块、活跃日期、知识库/联网引用、归档状态和关键词组合筛选；关键词覆盖标题、用户、消息与引用标题、URL、摘要。
- 列表增加授权 Campaign、知识库/联网引用数量、归档状态和真实活跃时间；详情展示消息、知识引用与联网来源，仅把绝对 HTTP/HTTPS 来源渲染为安全外链。
- 活跃时间取会话更新时间与最近持久化消息时间的较新值，因此 Provider 失败后仅保存用户问题的会话也可被管理员按日期检索。
- 普通用户继续只能读取自己的对话；平台管理员读取列表或详情都会写入包含请求 ID、筛选名称和授权目标的 `ai_audit` 日志。无数据库迁移、无 AI 生成路径或冻结 PPT 修改。

### 验证与生产发布 / Verification And Production Release
- 实现提交为 `e6a80e4`、`6ad9040`、`3b3161e`、`ff42b4d`、`c2c7a19` 与 `90729b4`；聚焦矩阵 46/46 通过，最终权限顺序路由定向复验 2/2 通过，JavaScript 语法和冻结 PPT 哈希通过。多轮独立审查逐项整改后最终结论为 `APPROVE`，无剩余发现。
- 已验证发布备份为 `/root/turingmarket/backups/v070-slice4b1-ai-audit-20260826-152538`，聚合 SHA-256 为 `fb6254fd67a1dcbf0c703a5926b370f097b7a23fbaf60aa62a220ff337c47c4a`；四个运行文件经暂存语法/哈希校验和原子替换部署，冻结 `ppt.js` 保持不变。
- 线上烟测验证管理员可读取 31 条授权会话，完整组合筛选命中 3 条，联网来源筛选命中 2 条并在详情读取 5 条 Web 引用；普通用户自己的授权列表为 1 条，跨用户详情返回 404，管理员用户目录返回 403。
- 管理员列表与详情读取各精确写入一条审计事件；一次性验收会话清理后剩余 0。公网健康为 200、解析器 ready、PM2/Nginx 正常、SQLite `quick_check=ok` 且外键异常为 0。
- 本切片按加速节奏执行：受影响测试、一次最终独立审查、可验证备份、立即上线和线上核心功能冒烟；未运行浏览器自动化，完整回归保留到阶段收口或高风险变更。

---

## v0.7.0-ai-knowledge-loop-task4a (Production Slice, 2026-08-26) - M5 AI 对话可靠性

### 最新 AI 助手接入 / Latest AI Assistant Integration
- M5 AI 助手现在只把用户实际输入的问题提交给 `/api/ai/chat`，不再把本地历史记录或品牌数量拼入持久化消息；现有联网开关真正控制 `allow_web`，关联 Campaign 时继续携带当前 Campaign 与已选知识条目。
- 同一 Campaign 的网络结果不明确时复用稳定幂等键，每次传输尝试仍使用新的请求 ID；明确 HTTP 失败或成功完成后轮换新键。单飞控制阻止并发首条消息拆成多个会话。
- Campaign、登录态和会话代次共同隔离陈旧响应；切换 Campaign、重新登录、登录过期、注销或清空对话都会中止旧请求并清除重试状态。后端错误改为纯文本渲染，不再解释服务端返回的标记。
- 本切片没有替换页面布局、后端服务、数据库结构或冻结 PPT renderer；未关联旧版 AI 对话继续保持原 API 兼容行为。

### 验证与生产发布 / Verification And Production Release
- 实现提交为 `b96cf6d`；受影响的 AI/RAG、会话审计、Campaign、M3、PPT 与前端架构矩阵 140/140 通过，JavaScript 语法、`git diff --check`、聚焦敏感信息扫描和冻结 PPT 哈希均通过。独立审查结论为 `APPROVE`，无 Critical、Important 或 Minor 发现。
- 生产备份为 `/root/turingmarket/backups/v070-slice4a-m5-ai-client-20260826-061018`，聚合清单 SHA-256 为 `1fececb8069a73e42ceccef184a99962689853c0104707b1ed3127229fcdbd75`；仅发布 `platform/app.js`，生产 SHA-256 为 `44e67c0a034d68629a450cd1691e0005183b4689df6564ddf9ccaa80d2ad24a6`。
- 生产管理员历史密码哈希未随此前重置落库，已在独立 SQLite Backup API 快照 `/root/turingmarket/backups/v070-slice4a-admin-reset-20260826-062343` 后完成审计恢复；备份聚合 SHA-256 为 `4f651b0037aea4acd38cfccf420db8c2ac97c07f47c6f5fbc035377e49b9fb6c`。公开记录不保存账号标识或明文凭据。
- 线上验收通过管理员登录、`/api/auth/me`、Campaign 1 关联 AI 对话、8 条知识引用、自动知识摘要归档、两条 Campaign 关联、单条 `link_attached` 事件、完成态幂等账本、同键语义一致回放和注销；近期回环验收会话为 0。
- 公网健康为 200、解析器 ready、PM2/Nginx 正常、SQLite `quick_check=ok` 且无外键异常；公网与本机 Nginx 返回的 `app.js` 均与生产 SHA-256 一致，冻结 `ppt.js` 哈希保持 `f311a7b33ee28e64c8e19a14bae436101272dd17bf2f4f8c5d181d57dd0e291e`。

---

## v0.7.0-ai-knowledge-loop-task3c (Production Slice, 2026-08-26) - Campaign 方案与 PPTX 成品归档

### 确认方案、PPTX 与 Campaign / Confirmed Proposal, PPTX, And Campaign
- M3 最新 PPT 下载链路现将当前 Campaign、明确匹配该 Campaign 的需求记录和人工确认后的精确方案版本传入既有 `/api/proposal/generate-ppt`；后端返回的 PPTX 保持不可变，完成后再建立 Campaign 的 `ppt` 关联并归档成品知识。
- 同一业务输入使用稳定幂等键并保持单飞；重复下载返回完全相同的 PPTX 字节。切换 Campaign、用户、编辑内容或请求代次后，旧响应不能写入新的活动上下文；需求 ID 只有在携带同一 Campaign 的明确关联证据时才复用。
- 归档状态、失败原因和重试入口保留在当前编辑会话中；CSP 翻译后的按钮定位与下载控制保持兼容。未关联旧版 PPT 生成路径继续精确透传，冻结 `ppt.js` 未修改。

### 验证与生产发布 / Verification And Production Release
- 实现提交为 `3988c47` 与 `899be8a`；最终聚焦矩阵 75/75、JavaScript 语法、架构清单、`git diff --check`、聚焦敏感信息扫描及冻结 PPT 哈希通过。独立审查首轮发现 2 项 Important 与 1 项 Minor，全部整改后复审 `APPROVE`，无剩余发现。
- 生产备份为 `/root/turingmarket/backups/v070-slice3c-campaign-ppt-artifact-20260826-130804`，聚合清单 SHA-256 为 `bcffa0ae7958e66d75b645829ae0ef607128c6f267c89abe473ffcef9477001a`；仅发布 `platform/app.js`，数据库无迁移，后端服务与冻结 PPT 字节保持不变。
- 线上管理员链路通过 Campaign 需求关联、精确方案版本、PPTX 生成、重复请求重放和注销；成品为 29,460 字节，SHA-256 `800b35c07401cf098c343b5722d7f9c1f03bd1c099032a3f2edfc0b0f67ca026`，重放字节完全一致。
- 生产库验证 Campaign 的需求、方案、PPT 关联、成品知识归档、`link_attached` 事件和完成态二进制幂等账本均各 1 条；公网健康为 200、解析器 ready、PM2/Nginx 正常、SQLite `quick_check=ok`，公网 `app.js` 与部署 SHA-256 一致。

---

## v0.7.0-ai-knowledge-loop-task3b (Production Slice, 2026-08-26) - Campaign PPT 大纲 RAG

### PPT 大纲与活动上下文 / PPT Outline And Campaign Context
- M3 最新 PPT 入口在调用 `/api/ai/ppt-outline` 前注入当前 `campaign_id`、已验证的需求分析与方案会话/消息、授权知识 ID、请求 ID 和稳定幂等键；联网固定关闭，服务端检索上限固定为 8。
- Campaign PPT 大纲通过统一 AI/RAG 服务生成并保存完整会话、消息、知识引用和 `ai_run` 关联；未确认大纲不归档，旧版未关联 PPT 路径继续保持兼容。
- 冻结 `ppt.js` 未修改；重复生成保持单飞，切换 Campaign 会中止并隔离旧响应，相同业务输入重试复用同一幂等键，旧响应不能渲染或写入已切换的活动上下文。

### 验证与生产发布 / Verification And Production Release
- 实现提交为 `e6d0bcc` 与 `0507843`；最终聚焦回归 66/66、JavaScript 语法、架构清单、`git diff --check` 与聚焦敏感信息扫描通过。独立审查首轮发现 2 项 Important 与 1 项 Minor，整改后复审 `APPROVE`；剩余 Minor 为非阻断浏览器到 HTTP 延迟切换集成用例缺口，已用生产 HTTP/数据库验收覆盖。
- 生产备份为 `/root/turingmarket/backups/v070-slice3b-ppt-rag-20260826-104042`；仅发布五个运行文件，数据库无迁移，生产 App build 与冻结 PPT build/hash 均保持不变。
- 线上验收通过管理员登录、Campaign 读取、已审计需求/方案来源、PPT 大纲生成、相同幂等键重放与注销；生成 10 个大纲章节并持久化 22 条 Campaign 知识引用，未联网、未归档未确认摘要，SQLite `quick_check=ok`，公网静态字节与本地发布哈希一致。

---

## v0.7.0-ai-knowledge-loop-task3a (Production Slice, 2026-08-26) - Campaign 方案草稿 RAG

### 方案草稿与审计 / Proposal Draft And Audit
- M3 最新方案页现调用 `/api/ai/proposal-draft`，携带当前 `campaign_id`、需求分析会话/消息、模板、授权知识 ID、请求 ID 与幂等键；联网固定关闭，检索扩展固定为 8 个 Campaign 范围知识分块。
- AI 草稿继续进入可编辑区，只有人工确认后的正式方案才归档；AI 服务失败时保留既有本地基础方案，重复点击合并，切换 Campaign 后旧响应不能覆盖新上下文。
- 方案页不再为 Campaign 请求调用旧版非活动范围的相似案例接口；需求分析审计 ID 必须验证为同一 Campaign、同一会话的 assistant 消息后才能进入方案提示与审计记录。

### 验证与生产发布 / Verification And Production Release
- 实现提交为 `37cfcaf` 与 `4c44e6c`；最终聚焦回归 58/58、JavaScript 语法、架构清单、`git diff --check` 与聚焦敏感信息扫描通过。独立审查先发现 2 项 P1 和 1 项 P2，整改后复审 `APPROVE`。
- 生产备份为 `/root/turingmarket/backups/v070-slice3a-proposal-rag-20260826-033422`；生产 `app.js`、`index.html`、`server.js`、`ai_service.js` SHA-256 分别为 `7e62ef4ce0e963a3787f4795ff06dc109ca930f4137d1f2c43a4d4d49af9c09f`、`5199c28ce55639247de00b3106a31af3c6a413d6a5fada1d6aac9cd10b8698f4`、`2ddb53c8a74fc104a9102f8dc00b66a0e9b3de170ff85b2faf806b18ff00bf4d`、`56322c81758424b06efc2bd17120d0d88f80a485d354c57220ca9fba582de47c`；数据库无迁移，冻结 PPT 未修改。
- 线上验收通过管理员登录、Campaign 读取、关联需求分析、关联方案生成、同键重放与注销；方案会话保存 2 条消息、17 条授权知识分块引用、1 条 `ai_run` 关联、完成态 200 幂等记录，未联网、未归档未确认摘要，SQLite `quick_check=ok`。

---

## v0.7.0-ai-knowledge-loop-task2 (Production Slice, 2026-08-26) - M3 活动上下文与知识引用

### 最新界面接入 / Latest UI Integration
- M3 需求分析在不替换 v0.6 产品壳层和冻结 PPT 的前提下，向 `/api/ai/demand-analysis` 发送当前 `campaign_id`、固定 `allow_web=false`、请求 ID 和幂等键；重复点击合并为同一请求，切换 Campaign 后过期响应不会覆盖新上下文。
- 需求上下文保存 AI 会话、消息和知识引用 ID，并在最新界面显示经过转义的“知识依据与 AI 审计”区块；知识选择按 Campaign 隔离，未关联旧流程继续兼容。
- DeepSeek 偶发返回“说明文字 + 合法 JSON + 说明文字”时，需求分析适配层现提取并验证其中的 JSON 对象，不再把有效结果误报为 `AI_PROVIDER_UNAVAILABLE`；无效或数组结果仍不会通过校验。

### 验证与生产发布 / Verification And Production Release
- 前端与契约聚焦回归 29/29，最终服务适配回归 15/15，JavaScript 语法、`git diff --check` 和聚焦敏感信息扫描通过；两次独立审查均为 `APPROVE`，无 P0/P1/P2。
- 实现提交为 `6f99a69` 与 `3bc7952`。生产 `app.js` SHA-256 为 `79c5900f06d9b48f571247cb9da93817b1c44f76e95de22ce757b2801c40b4bd`，需求分析服务 SHA-256 为 `ce8c7ce9a66f9103d949245ff5367aee24726ecb567e77293c4b94ac32e1d86e`；数据库无迁移。
- 已验签备份为 `/root/turingmarket/backups/v070-slice2-m3-demand-client-20260826-015448` 与 `/root/turingmarket/backups/v070-slice2-m3-demand-json-20260826-021550`。首次服务重启因错误使用 20 秒健康窗口而自动回滚；精确识别并通过项目受信清理器回收被中断的解析器自检任务后，详细自检、旧版恢复、180 秒发布窗口与第二次发布全部通过。
- 线上验收通过管理员登录、Campaign 关联需求分析、8 条知识引用、禁用联网、未确认摘要不归档、幂等重放、2 条消息、1 条 `ai_run` 关联、注销后零近期测试会话、解析器 ready、PM2、Nginx 与 SQLite `quick_check`。

---

## v0.7.0-ai-knowledge-loop-task1 (Production Slice, 2026-08-26) - 需求分析 AI 审计链路

### 需求分析与知识检索 / Demand Analysis And Knowledge Retrieval
- `/api/ai/demand-analysis` 现通过统一 AI/RAG 服务生成结构化需求分析，固定最多检索 8 条当前用户可见知识；调用方传入的异常 `knowledge_limit` 不再绕过服务边界。
- 关联 Campaign 的请求会携带 `campaign_id`、`Idempotency-Key` 与请求 ID，保存完整用户消息、AI 回复、知识引用、token 使用、状态和延迟，并建立 `ai_run` 业务关联。
- 未确认的需求分析不自动写入知识库；只有原始对话与引用进入审计表，后续仍保持“AI 草稿 -> 人工确认 -> 正式方案/知识归档”的业务合同。

### 审计、降级与权限 / Audit, Degradation, And Access
- 未关联的一次性分析采用私有知识范围、共享超时/取消信号和单事务持久化；Provider 异常或超时返回受限降级结果，同时原子保存成对消息和安全状态，不留下半写会话。
- 普通用户只能读取自己的 AI 会话；管理员可以查询全部会话、消息和引用，并且列表与详情读取均写入 `ai_audit` 活动日志。
- 通用旧版 AI 兼容响应保持原形；本切片没有数据库迁移、没有前端静态包替换，生产 App build 继续为 `20260811-v060-crm-sales-workspace`，冻结 PPT build 与哈希不变。

### 验证与生产发布 / Verification And Production Release
- 聚焦回归 44/44、相关 JavaScript 语法与 `git diff --check` 通过；独立 Code Review 为 `APPROVE`，无 P0/P1。
- 生产备份 `/root/turingmarket/backups/v070-task1-demand-ai-20260825-165902` 已通过 SHA-256 清单；三个后端运行文件按固定旧/新哈希原子替换，PM2、公开健康、解析器 ready 与 SQLite `quick_check` 通过。
- 线上冒烟通过管理员及普通用户登录、关联需求分析、8 条知识引用、禁用联网、未确认摘要不入库、幂等重放、管理员会话列表/详情审计、普通用户跨会话 404、注销和会话关闭。
- 生产库原无 Campaign，验收通过正式幂等 API 创建一条明确标记的系统验收 Campaign；它仅承载本次审计证据，不混入客户业务记录。

---

## v0.6.0-crm-sales-workspace (Production, 2026-08-25) - CRM 销售工作台

### CRM 销售工作台 / CRM Sales Workspace
- 将客户看板与客户明细保持为两个独立界面，并把客户、联系人、商机、任务、跟进记录、阶段流转、领取/释放、公海、团队与个人作用域接入统一的组织权限模型。
- 增加组织安全的客户与商机详情读取、受治理的阶段/结案原因、无硬删除的生命周期、失败写入草稿保留、精确商机详情编辑，以及管理员组织级与普通用户团队级可见性。
- 跟进结果通过知识库归档；团队成员只能追加 `note`，正式 `strategy`/`proposal` 仍由业务负责人控制。连续跟进采用活动 ID 作为来源身份，保证知识条目和分块不可覆盖。
- 客户更新新增可选 `expected_notes` 原子前置条件；服务层将其绑定到同一条 SQLite `UPDATE`，陈旧写入返回受限的 `CRM_CUSTOMER_CONFLICT` 409。生产 CRM 写入冒烟与恢复均使用该条件，能够拒绝并发覆盖，并在响应超时后按实际读回状态恢复原备注。

### Schema 6 与发布底座 / Schema 6 And Release Foundation
- 新增迁移 `006_crm_sales_workspace`、CRM 查询/命令/作用域/合同服务，并将发布迁移链升级为精确的 `v1 -> v6` 两次恢复验证。
- trusted-source 清单扩展为 49 个 SHA-256 固定文件，覆盖一次性 legacy v0->v1 adoption、迁移 006、CRM 服务、当前受信任运行时、解析器固定 CA 与 `sitecustomize.py`、独立公网发布守护器及迁移清理 helper/unit；受信任门禁会先识别精确 legacy v0、在私有可写副本中演练接管，并在生产切换中以 no-clobber 方式发布精确 managed v1，随后执行 v1->v6 双轮验证。sanitization manifest 重建为主 v1 + 隔离 v6 精确配置。
- 发布分支、构建标识、缓存键、候选/备份路径和远端文件清单升级为 `codex/v0.6.0-crm-sales-workspace` / `v060-crm-sales-workspace`，冻结 PPT build、query 与 SHA-256 保持不变。

### 解析器运行时设备 / Parser Runtime Appliance
- 为知识库、网红和需求文件上传增加独立解析器设备。生产构建固定为 Linux `x86_64`、Node.js `v20.20.2` 与 Python `3.14.4`；与禁止 Python 字节码缓存的构建策略一致，密封运行时树固定为 3,476 个文件、435 个目录、640,592,018 字节，SHA-256 为 `20b5f5186ec26b726d07659566071c0ce6b367138497f772d57830734f5d4418`。
- 解析器 worker 现在复用已完成长度与 SHA-256 校验的输入字节，并以独占写入方式暂存到 `/scratch`；不再触发受 systemd 系统调用策略拒绝的 `copy_file_range` 快路径，且未放宽网络、挂载、系统调用或写路径隔离。
- 生产解析器验收进一步修复 OCR 夹具：BMP 文件头改为零初始化并仅将像素区填白，避免压缩字段误写为 `4294967295`；OCR 标记比较会折叠等价空白，因此 RapidOCR 返回 `OCR\n123` 时可正确匹配 `OCR 123`。头部合法性与换行匹配回归 `26/26`、相同 Linux RapidOCR 运行时实测通过。
- Node 依赖闭包精确锁定为 `read-excel-file@9.2.0`、`@xmldom/xmldom@0.9.11`、`fflate@0.8.3`、`unzipper-esm@0.13.3`、`graceful-fs@4.2.11` 与 `node-int64@0.4.0`；`package-lock.json` SHA-256 为 `e1d6e5ababef1fb6f0aa69363be328e4da42283c96e268378c2f83076722fc46`。
- Python 闭包精确锁定为 `certifi==2026.7.22`、`charset-normalizer==3.5.0`、`colorlog==6.12.0`、`flatbuffers==25.12.19`、`idna==3.18`、`numpy==2.5.2`、`omegaconf==2.4.0.dev13`、`onnxruntime==1.28.0`、`opencv-python==5.0.0.93`、`packaging==26.3`、`pillow==12.3.0`、`protobuf==7.35.1`、`pyclipper==1.4.0`、`PyMuPDF==1.27.2.3`、`pypdf==6.14.2`、`PyYAML==6.0.3`、`rapidocr==3.9.2`、`requests==2.34.2`、`shapely==2.1.2`、`six==1.17.0`、`tqdm==4.70.0`、`typing_extensions==4.16.0` 与 `urllib3==2.7.0`；逐包验签的 `requirements.lock` SHA-256 为 `22f72070ee7c62b428261b64435fbb0b24d87f0aaa7a4d0ac0d8e7a45bfb44df`。
- 构建、安装、快照和回滚只允许在 root 所有的生命周期目录内执行。解析任务以禁止登录的 `turingmarket-parser` 身份运行于 systemd 257+ 的 `RootDirectory` chroot，并启用私有网络、PID、IPC、用户和挂载命名空间、只读系统、空 capability 与资源上限。
- 非特权构建单元在密封并哈希运行时前，针对暂存依赖树初始化真实 RapidOCR 引擎；发布测试同时覆盖 RapidOCR 3 对象结果与旧 tuple 兼容路径，安装与验收门禁在 `RootDirectory` 内执行 XLSX、PPTX、OCR 推理及隔离边界在内的 21 项自检。

### 切换安全与可观测性 / Cutover Safety And Observability
- 迁移清理控制面的 enabled topology replay 现在可接管精确 `.restore.next` residue，并在任何控制面写入前验证 root-only 父链；install、backup、replay、start 与 convergence 均通过固定 `/usr/bin/systemctl show` 绑定 PID 1 的精确 fragment、无 alias 及精确 drop-in 集合，同时扫描全部 systemd 搜索根。
- 公网发布 watchdog 不再受旧 5 分钟 runtime cap 截断；armed 状态绑定 transient unit、controller start ticks 与操作专属 deadline：初始切换为 120 秒，接受态 finalization 与回滚/恢复为 7,200 秒。每次公网 link swap 及 disarm 前均重新验证精确 active/running transient identity。
- `/var/lib/turingmarket/ppt-cache` 现作为第五个外置状态目标，由 `PPT_CACHE_DIR` 直接引用，不是候选树软链接。备份记录其 `present`/`absent` 起源；首次安装只在停写后创建空的 `root:root 0700` 目录，预变更恢复仅在目录仍为空时删除它。
- 生产变更前按实际文件系统设备计算数据库、PPT 缓存、既有/待装解析器运行时与 `node_modules` 增量的备份、安装和回滚空间，并要求每个设备满足计算值加 `max(10%, 512 MiB)` 余量及最终 `CUTOVER_CAPACITY_OK`。
- 切换顺序固定为：全流量维护、首次解析器 admission/spool/unit/cgroup 排空、停止并静默 PM2 与 SQLite、再次排空解析器、准备 PPT 缓存、建立同一验签快照、交换代码、安装解析器、启动候选与执行验收。
- `/api/health` 现在返回 `parser.ready` 与 `parser.manifest_sha256`。候选必须同时满足 `status=ok`、解析器 ready 和 manifest SHA-256 `44db310046efe65bd68c110313b4887995c73e276e7d58f65fe037c09a973c5b`；安装后自检、接受事实与运行时树哈希写入 schema 4 验收标记，公开流量恢复前会重新绑定核验。

### 审查与状态 / Review And Status
- 2026-08-24 解析器暂存修复已完成 RED/GREEN：真实 XLSX 在强制 `fs.promises.copyFile` 返回 `EPERM` 时由失败转为通过；CSV/XLSX/PPTX、zip-bomb 与受信任 artifact 定向用例 `5/5`、Phase 4 服务集成 `32/32`、`-ValidateLocalOnly`、哈希闭环、diff 与聚焦 secret scan 均通过。独立 code-reviewer 结论为 `APPROVE`，无 Critical/High/Medium/Low 发现；五项宽范围旧合同失败已在未修改的 `e4ca1ce` 基线逐项复现，不归因于本次差异。
- 解析器暂存修复后的首次受控切换证明 XLSX、PPTX 隔离任务均成功，但 OCR BMP 功能验收因夹具头部与换行匹配问题失败；发布器自动恢复 v0.4，公网与 loopback 健康检查均为 `ok`。本轮只修正该验收夹具与比较逻辑，不改变解析服务、运行时依赖或 systemd 安全策略。
- OCR 修复后的下一次受控切换在安装前被运行时证据一致性门禁拒绝，并再次自动恢复健康的 v0.4。为定位具体漂移，provisioner 仅在显式诊断模式下输出 expected/observed/provided SHA-256、文件数、目录数与字节数的 canonical JSON；默认路径仍只返回受限错误，门禁判定与 systemd 策略不变。
- 随后的受控切换通过运行时身份、XLSX/PPTX/OCR 功能验收后，在首次到达的同级 PID 隔离证明处关闭发布并自动恢复健康 v0.4。自检现仅在显式诊断模式输出两个固定投影：namespace 内 peer/self/visible PID 与 host cgroup MainPID/change/procs；普通 CLI、验证条件和 systemd 隔离均保持不变。
- 下一次受控切换通过迁移演练、真实 Express 重放 `8/8`、发布守护 `21/21`、浏览器冒烟 `2/2` 与候选构建后，在 live legacy adoption 前置哈希处关闭并恢复健康 v0.4。根因是 SQLite 在线备份可产生与停写原库逻辑等价但字节不同的恢复文件；切换现分别绑定停写原库 SHA-256 与恢复快照 SHA-256，不再错误要求两者相等，两个文件仍分别执行完整性与不可变性验证。
- 随后的重发在生产变更前被迁移演练拒绝：13:05 的旧模板上传新增 3 条负数金额记录，使线上数据不再匹配旧的单行冻结修复样本；现网 v0.4 全程保持健康。旧库接管现在只接受已核验的“原 1 条”或“当前精确 4 条”两种金额修复形态，并在迁移副本中按原幅度转为非负值；新版网红导入同步将成本、商务报价、CPM 与 CPV 归一为非负值。新增行为用例 RED/GREEN 通过，可信发布源 `29/29` 与本地发布预检通过。
- 再次重发证明 4 条负数金额已通过严格白名单，随后迁移器识别出同批 `id=2740` 的旧解析器拼接报价被写成超大 REAL，因不满足安全整数存储而在生产变更前关闭。修复只核准这一条精确记录，将报价恢复为首档 `8000`，按 `49000` 均播量重算 CPM/CPV，并继续拒绝任何其他 REAL 报价形态；源库与验签备份不被修改。新增成功/漂移用例完成 RED/GREEN。
- 拼接报价修复后的受控发布已通过候选迁移、一次请求重放、公网守护和最小浏览器冒烟，并进入原子切换；旧库接管器正确报告当前冻结画像共修复 5 条网红记录，但发布包装器仍只接受历史 1 条画像，因而失败关闭并自动恢复健康 v0.4。包装器现仅接受受信任接管器允许的两份精确报告（1 条或 5 条），其他数量继续拒绝；发布源定向测试 `30/30`、PowerShell AST 与本地发布预检通过。
- 报告契约修复后的重发通过旧库接管，随后解析器安装发现 systemd 首次服务启动会在已密封运行时中补建 4 个挂载目录和 2 个零字节挂载目标，运行时证据因此失败关闭并自动恢复健康 v0.4。远端隔离探针精确确认 `/input`、`/output`、`/runtime`、`/scratch` 及两个目标文件的类型、权限和零字节状态；构建器现于密封前预建这些必需挂载点，运行时身份更新为 3,476 文件、435 目录、640,592,018 字节及 SHA-256 `20b5f5186ec26b726d07659566071c0ce6b367138497f772d57830734f5d4418`。首次重试在生产变更前证明暂存目录提前设为 `0555` 会阻止非特权 worker 创建两个占位文件；构建阶段现使用 `0755`，完成后仍收敛到探针确认的最终权限，不改变运行时安全边界。
- 挂载权限修复后的重发通过全部候选门禁、解析器候选构建、容量核验与 live legacy adoption，随后因仅第二个 worker 的 systemd `MainPID` 发生变化而在同级 PID 证明处关闭并自动回滚健康 v0.4。诊断证明两个 namespace 都仅可见 PID 1 且对端 `/proc` 操作被拒绝；根因是验收器把变化标记错配到当前 worker。独立安全复审进一步阻断了仅交换索引的方案，因为变化标记本身不能证明目标 PID 仍属于活跃对端。最终协议先等待首个 worker 的 cgroup/MainPID 连续稳定，再启动第二个 worker；两侧证明只接受当次 cgroup 验证的实时对端 PID，旧 PID、无关 PID及借用任一变化标记均失败；HIGH 修复后的独立复审为 `APPROVE`。
- 实时 PID 协议修复后的重发不再触发 PID 门禁，但安装在最终可信验收绑定处仅返回通用 verifier 失败并自动回滚；公网、loopback、PM2 与 Nginx 均恢复健康 v0.4。首轮有界诊断确认失败仍属于未细分的 `internal`，随后同样 `ROLLBACK_OK` 并完成四项线上健康复核。可信 verifier 现仅在显式安装诊断模式返回固定分类码，并把绑定 CLI 分为 manifest 读取、原始证据读取、构建证据读取、运行时测量、systemd 策略观察及最终绑定六个固定阶段；默认 CLI 继续只输出通用失败，不会回显错误文本、路径、参数或凭据，快照、验证和回滚调用仍显式关闭诊断。RED/GREEN 定向用例覆盖默认静默、全部 allowlist/`internal` 回退、六个阶段、唯一安装诊断调用及敏感参数不回显。
- 六阶段诊断的受控重发将失败精确收窄到 `installed-policy-observe`，发布器再次自动回滚并复核 v0.4 的 loopback、Nginx 和 PM2 健康。systemd 安装策略观测现进一步拆分为服务单元属性读取、系统调用策略、归一化、unit artifact、manager 复核，以及 slice 的属性读取、归一化、unit artifact 与 manager 复核共 9 个固定子阶段。仅显式安装诊断路径可见分类码，默认错误仍为通用文本，不携带原始错误、路径或凭据。
- 9 子阶段的受控重发进一步将失败定位到 `slice-properties-read`，并再次完成 `ROLLBACK_OK`。生产 systemd 日志确认 `CPUAccounting=` 在当前版本已移除且被忽略；现有解析服务与自检已兼容该证据形态，只有可信 verifier 的严格属性集校验未同步。verifier 现仅允许 `turingmarket-parser.slice` 缺少该已移除属性，并仅在期望值为 `yes` 时归一化；其他缺失、未知字段、资源上限或服务单元漂移仍失败关闭。真实生产形态用例已完成 RED/GREEN。
- 本轮发布包装器使用严格子进程环境白名单、语义化远端证据、可逆 CRM 写入冒烟及强制注销；任何由本轮生产变更引起的必选验收失败会自动使用本轮已验证备份回滚。成功、畸形响应、并发冲突、写入超时、注销失败、回滚后身份失败和自动回滚编排共 7 条动态场景通过，客户服务/HTTP 定向测试 3/3 通过，独立终审为 `APPROVE`。
- S6 已验收检查点的独立 Code Review 为 `APPROVE`，独立 QA 为 `GO`；该检查点最终审查矩阵 342/342、提交前扩展矩阵 373/373，6 个关键 JavaScript 文件语法通过。
- 完整历史 bundle `phase5-v060-90713b23f417-full-source.bundle` 已验签，SHA-256 为 `fd4b925d82056d1eb53a5c65cc67461bc3eadd9ba88f47020ed37343d5dae887`。
- v0.6 在 S6 后又补充了跨平台可信哈希、schema 6 已填充 CRM 脱敏回归、概率字段域约束、发布清单修复和上述解析器/切换加固，因此发布前另行完成了当前功能切片的定向复审；完整回归保留在阶段收口、计划发布窗口或跨模块高风险变更时执行。
- 本轮 AppSec 首轮 4 项及终审追加 2 项 HIGH 已完成 RED/GREEN 整改：`0444` 公网守护器只经固定 `/bin/bash --noprofile --norc` 调用；`ss`、状态 `fsync` 或嵌套条件调用失败均不能持久化 `closed`；候选依赖按目标文件系统块大小逐 inode 核算分配上界、拒绝 xattr/特殊文件/硬链接，并以完整 tmpfs 字节与 inode 上限作为最低容量基线；中断接管和候选清理仅卸载经过精确路径与 `tmpfs` 类型校验的残留挂载。历史 AppSec 聚焦证据为公网守护器 `9/9`、发布源合同 `40/40`、生命周期接管 `22/22`、可信源与 v0.6 合同 `47/47`，`-ValidateLocalOnly` 与 `git diff --check` 通过；该历史结果不替代当前保留证据。
- DevOps 第 5-10 轮进一步封闭公网守护接管：只允许 exact no-follow、root:root、`0600`、单链接、regular、空文件且无 xattr 的 transaction lock；可信 helper 增加 transaction-locked `read-record`；四类 transient unit 按生命周期阶段与 RunId 精确绑定并排空；lock-only 缺失状态只能按显式 `absent` 收敛；disarm 在 watchdog 退出后重新锁读 `verified`，维护配置、链接和父目录均执行持久化；inventory 使用不可变 `rootGid`/`wwwDataGid`，不受扫描顺序影响；`cutover-complete` 接受态恢复会在任何 PM2 变更前先通过可信 helper 关闭公网并启动 watchdog，直到公网与 PM2 精确事实收敛后才解除守卫。接受态 finalization 另设 7,200 秒有界 watchdog deadline，覆盖 PM2 命令、完整 180 秒解析器启动窗口及最终公网/事实验证，避免沿用 120 秒切换窗口造成合法慢启动误关断。
- 首次正式候选构建在生产切换前因离线 `better-sqlite3` 编译尝试下载 Node 头文件而拒绝；生产继续运行 v0.4。可信运行时与候选依赖的断网构建现固定使用服务器已安装的 `/usr/include/node`（`npm_config_nodedir=/usr`），不放宽构建网络边界。
- 第二次正式候选构建在生产切换前因 node-gyp 生成 3 组 `better-sqlite3` 硬链接而被完整性门禁拒绝；最新失败候选已清理，生产继续运行 v0.4。可信运行时与候选依赖现在只在验证精确 inode、链接数、路径和文件类型后删除 `obj.target`、`sqlite3.a` 与测试扩展，保留单链接 `better_sqlite3.node`；候选侧必须先排空构建 cgroup 和门禁进程再清理，最终全树硬链接拒绝保持不变。
- 候选远端命令返回后新增持久化阶段后置条件：只有生命周期日志精确提交为 `candidate-ready` 才能进入解析器准备与切换。相关部署状态机、可信源码及隔离运行时门禁 `119 total / 116 pass / 0 fail / 3 platform skips`，独立复审无剩余发现。
- 硬链接修复后的部署聚焦门禁为 `121 total / 118 pass / 0 fail / 3 platform skips`；候选清理脚本另通过语法与真实硬链接夹具验证。独立复审首轮发现并阻断“清理早于构建进程排空”的竞态，RED/GREEN 顺序回归与实现修复后复审为 `APPROVE`、无剩余发现。
- 第三次正式尝试在新备份和生产切换前识别出上一轮控制面恢复停留在 `topology-restored`，因此安全拒绝，线上 v0.4 继续健康。根因是 systemd/cleanup 正常读取会推进 `atime`，旧恢复器却把它当作最终不可变字段；恢复现在仍先写回捕获时间，但最终一致性只绑定 SHA-256、大小、uid/gid、权限、`mtime`、链接和 systemd 拓扑。发布源合同聚焦回归 `48/48`，独立复审为 `APPROVE`。
- 第四次正式尝试在候选 tmpfs 容量读取阶段因 GNU `df` 拒绝同时使用 `-i` 与 `--output` 而安全退出，生产和控制面均自动恢复。inode 总量/余量读取改为 `df --output=itotal/iavail`，数值与容量上限合同不变；定向回归 `1/1`、独立复审 `APPROVE`。
- 第五次正式尝试在候选依赖 transient unit 启动前因 root-only 发布目录阻止非特权门禁进入 `WorkingDirectory` 而安全退出，未进入生产切换。候选门禁现在只在 unit 生命周期内把 `ReleaseRoot` 与其专用 `tmp` 临时设为 `0711`，仍保持 `CandidateDir` 为 `0700`；退出、信号和失败清理会在父子路径身份复核后分别恢复 `0700`，异常父路径不会触及子路径，校验失败的目录也不会被删除。RED/GREEN 定向合同与 Git Bash 语法为 `2/2`，PowerShell AST 和 `git diff --check` 通过；独立复审两轮阻断并修复异常恢复路径后最终为 `APPROVE`、无剩余发现。
- 第六次正式尝试在数据库迁移演练阶段发现线上仍为无 `schema_migrations` 的 legacy v0，而 v0.6 发布链只固定了接管脚本、没有调用它，因此在生产写入、备份和公网切换前安全退出；失败候选已清理且控制面恢复。修复采用 RED/GREEN：旧实现的受信任接管合同 `1/6`，接线后 `6/6`；旧库原子发布、no-clobber 与失败清理 `6/6`。本条仍等待独立复审和重新部署，不把预演失败记为生产发布。
- 接管链终审先阻断两项 Important：异常中断可能遗留未追踪的完整数据库副本，以及 managed v6 未实际执行迁移入口。修复后，生产接管只使用两个固定、root-only、身份可验证的临时路径；切换、重试与回滚均在验证全部文件、sidecar 和硬链接关系后统一清理。managed v6 在私有副本上执行两轮固定迁移并比较 topology/logical/FTS 摘要，恶意启动期写入回归会被拒绝。受影响完整测试 `32/32`、发布源最新复验 `25/25`、本地发布预检、PowerShell AST、Node/JSON、哈希闭包、diff 与敏感信息扫描通过；最终独立复审为 `APPROVE`，无剩余 Critical/Important。
- 第七次正式尝试已通过真实生产快照的旧库接管与迁移演练，但离线候选单元在切换前因 `ip route`/`ip link` 依赖被 `RestrictAddressFamilies` 禁止的 `AF_NETLINK` 而退出；生产未变更且 v0.4 健康。离线命名空间检查改为读取 `/sys/class/net` 与 `/proc/net/route`，继续要求只有 `lo` 且无 IPv4 默认路由，不放宽任何 systemd 网络权限，也不会把 Linux 私有命名空间的 IPv6 拒绝路由误判为外联。RED/GREEN 定向回归、受影响测试 `51 passed / 0 failed / 3 platform skips`、同等远端 systemd 沙箱探针和本地部署预检通过；独立复审为 `APPROVE`、无剩余发现，当前等待重新部署。
- 第八次正式尝试已通过旧库接管、迁移演练和离线网络检查，但脱敏 `schema.db` 在封存为 `root:root 0444` 后仍由兼容检查 `require('./db')` 进入可写的启动迁移/FTS 完整性路径，因此以 `SQLITE_READONLY` 在切换前退出；生产未变更且控制面恢复。初版修复使用 `better-sqlite3` 的 `readonly + fileMustExist` 直接打开已完成演练的脱敏库，只执行 integrity、foreign-key 和精确 schema 6 校验，不改变迁移实现、文件权限或沙箱。RED/GREEN、受影响测试 `51 passed / 0 failed / 3 platform skips`、本地部署预检和 diff 检查通过；独立复审为 `APPROVE`、无剩余发现，随后由第九次尝试继续验证。
- 第九次正式尝试证明封存脱敏源按受信任合同仍是 managed v1，而非最终 v6；上述只读直检因此在精确版本断言处于切换前退出，生产仍未变更。最终修复保持 `root:root 0444` 源不变，在隔离的 gate-owned tmpfs 下建立 `0700` 临时目录和 `0600` 可写副本，继续通过真实 `require('./db')` 执行候选 v1->v6 启动迁移，再完成 integrity、foreign-key 与精确 v6 校验；`EXIT` trap 和成功路径都会删除临时副本。RED/GREEN、受影响测试 `51 passed / 0 failed / 3 platform skips`、本地部署预检和 diff 检查通过；独立复审为 `APPROVE`、无剩余阻断。
- 第十次正式尝试已通过真实旧库接管、v1->v6 迁移演练、离线网络和临时副本候选启动迁移，但随后旧 heredoc 使用未通过 `env -i` 传入的 `CandidateDir`，以 unbound variable 在切换前退出；生产仍未变更。两处路径引用统一改为已传入的 `CANDIDATE_DIR`，并新增精确变量集合回归：抽取整个非特权 heredoc 的全部 shell 变量，除已传入环境和脚本内声明变量外不允许任何引用。RED/GREEN、受影响测试 `51 passed / 0 failed / 3 platform skips`、本地部署预检通过；独立复审为 `APPROVE`、无剩余发现。
- 第十一次正式尝试通过旧库接管、两条 v1->v6 迁移路径和离线环境边界后，在真实 Express 一次请求重放验证启动时退出：验证脚本主动清空继承环境，却遗漏 `PPT_CACHE_DIR`，使服务尝试写入只读候选树。修复将 PPT 缓存与上传、临时文件、解析 spool 一并绑定到 proof 独立临时目录，并在服务停止后统一清理；RED/GREEN 合同及真实 Express 正反向重放测试 `6/6`、候选清单测试、本地部署预检和 `git diff --check` 通过，独立复审为 `APPROVE`。本次仍在生产切换前退出，线上 v0.4 未变更。
- 第十二次正式尝试已通过前述迁移、离线环境与 PPT 缓存修复，随后在同一真实 Express proof 中被上传解析沙箱的生产 readiness 拒绝：Linux 生产合同要求 spool 为 `root:root 0700`，但候选验证按设计由无特权 gate 用户运行。解析器服务文件及其生产 readiness 保持受信任 SHA-256 原样；仅当严格 local-worker 条件、专用 replay marker、用户 ID 与 Node IPC 同时成立时，proof 使用隔离 readiness 快照，普通测试适配器和生产继续执行原门禁。正反向 proof `7/7`、生产 readiness/旧 self-test/readiness 失败回归 `3/3`、无 IPC 拒绝、本地部署预检和密封服务哈希均通过，独立复审为 `APPROVE`。本次仍在切换前退出，线上 v0.4 未变更。
- 第十三次正式尝试已通过真实生产快照清洗迁移、v1->v6 兼容、一次请求重放及公网守护回归，随后因 `sanitized_migration_gate.test.js` 的 Linux root 控制面用例被非特权离线候选单元执行而在切换前退出；失败候选已清理、控制面已恢复，线上 v0.4 未变更。发布门禁随后从非特权通配测试集中精确排除该 root 专用套件，不修改套件本身，也不削弱前序对真实生产备份执行的受信任 `sanitize-and-verify` 迁移演练；RED/GREEN 部署合同、本地发布预检和 `git diff --check` 通过，独立复审为 `APPROVE`、无阻断项，随后由第十四次受控部署继续验证。
- 第十四次正式尝试在线上候选环境通过真实生产备份清洗迁移、schema v6、一次请求重放 `8/8` 与公网重放守护 `21/21` 后，证明旧的 `tests/*.test.js` 全量通配门禁仍混入 Linux root 故障注入、Windows 历史浏览器基线及依赖开发机目录的测试；同时，多个启动测试因通用候选环境未提供各自专用 PPT 缓存而产生级联环境失败。候选在生产切换前主动终止，清理和控制面恢复完成，线上 v0.4 未变更。发布门禁现按既定轻量节奏固定为源码/构建身份、真实迁移、schema、一次请求、重放守护、两条浏览器核心路由和 Nginx 校验；开发全量回归留在阶段收口或风险窗口执行，不再进入每次生产候选。RED/GREEN 合同、受影响测试 `52 passed / 0 failed / 3 platform skips`、本地预检和 diff 校验通过；独立复审为 `APPROVE`、无阻断项，等待重发。
- 第十五次正式尝试已通过真实生产备份迁移、schema v6、一次请求重放 `8/8` 与公网重放守护 `21/21`，随后部署内置浏览器冒烟因仍把可写夹具和报告放到只读候选发布根下的 `.superpowers` 而在切换前退出；候选清理和控制面恢复完成，线上 v0.4 未变更。浏览器冒烟现在通过 `TM_DEPLOYMENT_SMOKE_ROOT` 把 Playwright 报告、夹具数据库、上传 spool、PPT 缓存、临时文件与日志全部约束到唯一可写的 `$TEST_ROOT/browser-smoke`，候选源码继续只读。新增回归先复现旧路径、再验证新路径；受影响测试 `53 passed / 0 failed / 3 platform skips`、真实夹具子进程健康探针、路径投影、本地发布预检与 `git diff --check` 通过。独立审查首轮阻断遗漏的子进程 `TMP_DIR`/`PPT_CACHE_DIR`，整改后复审为 `APPROVE`、无剩余发现，立即重发。
- 第十六次正式尝试再次通过真实生产备份迁移、schema v6、一次请求重放 `8/8` 与公网重放守护 `21/21`，随后发现通用浏览器夹具会启动完整后端，而 Linux 非特权候选不能也不应伪装成生产解析器要求的 `root:root` spool；该候选仍在切换前退出并完成清理与控制面恢复，线上 v0.4 未变更。部署浏览器冒烟现改用专用只读静态服务，直接复用生产 `public_assets_service` 的公开资产白名单，只提供健康检查、SPA 壳层与静态边界，不启动数据库、PPT、上传解析器或任何业务写路径，也不放宽生产解析器 readiness。RED/GREEN 合同、真实 HTTP 壳层/资产/私有路径探针、受影响测试 `53 passed / 0 failed / 3 platform skips`、部署源定向 `2/2`、本地预检与 diff 校验通过；独立复审为 `APPROVE`、无剩余发现，立即重发。
- 当前功能切片父级定向证据：生命周期接管 `31/31`、发布源合同 `44/44`、公网守护关键并发/读取/超时用例 `4/4`，PowerShell AST、守护脚本 Bash 语法、可信哈希一致性、`git diff --check` 与聚焦敏感信息扫描均通过。2026-08-16 Windows 71 文件非浏览器汇总 `1875/1784/0/91` 及早期公网守护结果仅作为历史/阶段收口证据保留；生产匹配 Linux/root 验证在受控部署中执行。
- 开发节奏调整为“单功能实现 -> 定向测试 -> 独立审查 -> 备份 -> 上线 -> 线上健康/登录/核心路径冒烟”。完整非浏览器回归、Playwright 和多角色复审仅在阶段收口、计划发布窗口或改动跨越认证、权限、迁移、共享基础设施等高风险边界时执行；HIGH/CRITICAL、备份/回滚、迁移安全和生产冒烟继续作为硬阻断项。
- 2026-08-25 受控部署已完成生产切换，线上 App build 为 `20260811-v060-crm-sales-workspace`，PPT build 继续冻结为 `20260702-v916-kb-bridge-client-cn`。接受记录为 schema 4，Run ID `d4829334b008489aa05a5abe4076807f`，候选摘要 `2bef3f8883c4747d837438693f27787d162c3568ef2ce83b0e7a9467314b8c43`；迁移、解析器安装、自检、切换、恢复 finalizer 和保留清理均已收敛。
- 生产验收通过公网与回环健康、解析器 manifest、PM2、Nginx、锁释放、管理员登录、`/api/auth/me`、管理概览、CRM 客户与看板、网红搜索、知识检索、AI 对话审计、六个主界面、注销及令牌撤销。公开 `app.js` 的 SHA-256 与权威工作区一致。
- 管理员登录失败的根因是 2026-07-12 全员凭据轮换覆盖了此前指定值，而不是本次数据库或界面回退。已先建立一致性 SQLite 私有备份，再恢复既定管理员凭据、撤销旧会话并写入安全审计；数据库 `quick_check` 与重新登录均通过，公开记录不保存账号名或密码。
- 发布修复最终提交 `86d05fa` 已同步到 GitHub 分支 `codex/v0.6.0-crm-sales-workspace`。后续继续采用“单功能定向测试 + 一次独立审查 + 可验证备份 + 立即上线 + 线上核心路径冒烟”，完整回归保留在阶段收口或高风险边界。

---

## v0.5.0-campaign-business-spine (Unreleased, updated 2026-08-09) - 活动业务主链开发候选

### 数据、权限与活动主链 / Data, Access, And Campaign Spine
- 增加受校验和约束的增量迁移、SQLite 结构/逻辑/FTS 摘要、组织与团队身份投影、活动访问决策、知识托管和容量边界，为客户、商机、方案、网红、AI、知识与流程记录提供一致的活动归属基础。
- 活动 API 已覆盖创建、读取、更新、阶段流转、暂停/恢复/取消、转交、业务记录链接与纠正、工作台读取、知识读取和结案复盘；写操作使用统一幂等账本、事务内重新鉴权、版本与事件证据。
- 保留未关联 v0.4 记录的既有响应和可见性；活动关联记录改为完整组织、团队、活动、派发和实例链路授权，畸形或缺失链路失败关闭。

### 可靠工作流派发 / Durable Workflow Dispatch
- Task 6 完成固定执行快照、闭合图和条件语法、活动模板管理、迁移 003、生命周期派发、领取/租约/续期、初始化、四级退避、第五次死信、人工重试与每数据库单例调度器。
- 增加任务动作、实例控制、故障调和、替换实例、任务重分配、幂等重放与原子审计证据；对账 JSON ID 只接受安全正整数 number，不接受数字字符串。
- 实例列表、按业务读取、任务读取与统计使用集合化活动访问过滤；真正未关联的历史记录维持旧兼容语义，关联但缺失模板或互惠链路的记录不会进入读取或统计结果。
- Task 6 最终独立审查为 `SPEC APPROVE`、`QUALITY APPROVE`、`OVERALL APPROVE`，Critical、Important、Minor 均为 0。

### 生产 Bootstrap 恢复加固 / Production Bootstrap Recovery Hardening
- 生产外置运行时 bootstrap 首次执行时，真实 `ss` 进程标签包含空格，旧解析器把合法的单一 loopback socket 误判为额外字段并停止 PM2；v0.4 随即按版本化备份恢复，并在最近一次远端验收中保持单一 `127.0.0.1:3002` 监听、健康接口、SQLite、nftables 与 systemd 持久化均通过。
- 提交 `7b418fd` 以最小改动让最后一个 shell 变量吸收完整进程字段，同时继续严格校验精确 endpoint、唯一 listener、PM2 PID 绑定和尾随字段拒绝；真实生产形态 fixture 与双监听负例均已固化。
- 操作手册现在只接受互斥的 normal 或 committed-recovery 首跑成功契约，并在 ACK 前验证精确 terminal ID、journal provenance、PM2/监听、nftables、systemd、四个外置链接、SQLite 与永久 marker；pending 重跑显式拒绝全部 recovery 成功记录。
- 最终 runtime/source-contract/source-trust 门禁为 100/100，bootstrap 生命周期、边界和 sanitizer 重型门禁为 305 项零失败；独立 Code Review 与 AppSec 均为 `APPROVE`。本修复尚未触发 v0.5 生产切换。

### 验证与发布状态 / Verification And Release State
- 最终父级复验：读取 20/20、对账 15/15、工作流/请求管线/生产集成 106/106、相关 Phase 4 265/265、迁移框架 82/82、环境无关服务器矩阵 475/475。
- 完整服务器套件为 576 total、541 passed、34 failed、1 skipped；34 项保持精确的 `21 + 2 + 3 + 8` 既有浏览器沙箱、冻结清单、非权威工作树与并发环境门禁分类，没有新增或未分类失败。
- `node --check`、差异/空白/冲突/高置信密钥扫描、28 项物理基线、报告前缀、迁移 003 与冻结 PPT SHA-256 均通过；`platform/ppt.js` 继续保持 `f311a7b33ee28e64c8e19a14bae436101272dd17bf2f4f8c5d181d57dd0e291e`。
- 本条目是尚未发布的开发候选记录。生产继续运行 v0.4；阶段 4 后续 Task 7-10、生产备份、部署、远端验收与回滚验证完成前不会切换线上版本。

---

## v0.4.0-product-shell-and-design-system (2026-07-14) - 产品壳层与设计系统

### 产品壳层 / Product Shell
- 在不改写 CRM、品牌、需求/PPT、网红、AI、流程、待办、管理和知识库业务契约的前提下，引入共享设计令牌、组件样式、响应式布局、导航与无障碍辅助层。
- 桌面端保留高密度工作台；移动端改为顶部栏与可关闭抽屉，修复 `390x844` 下侧栏挤压主内容的问题，并覆盖 `320px`、`200%` 与 `400%` 等效回流。
- 保持客户看板与客户明细分离、M4 搜索/固定表头/导入入口、AI 引用、管理员 AI 对话审计和既有 PPT 生成链路；冻结 PPT build `20260702-v916-kb-bridge-client-cn`、query `20260702v916kbbridge` 与 SHA-256 `f311a7b33ee28e64c8e19a14bae436101272dd17bf2f4f8c5d181d57dd0e291e`。
- 统一弹窗语义、焦点限制与恢复、跳转焦点、键盘标签页、减少动画、强制色彩和控件命名，不改变后端 API、数据库结构或业务数据。

### 视觉与审查 / Visual Evidence And Review
- 完成 102/102 条确定性基线旅程、90/90 条产品壳层浏览器矩阵、72/72 张三个视口截图和 9 张前后联系表；独立复采 72 张截图的感知像素变化为 0。
- 有意设计改造的最大感知差异比率为 `0.14496597399441002`，九组联系表全部通过人工对照；零容忍业务区域无遗留回归。
- 产品、前端、无障碍、应用安全、最小改动与代码审查六个角色均为 `APPROVE`，最终无开放 P0/P1/P2 发布问题。

### 验证与生产发布 / Verification And Production Release
- 本地完整 Node 门禁为 204 total、204 passed、0 skipped、0 failed；Linux 远端门禁为 204 total、199 passed、5 platform-conditional skipped、0 failed；Linux 部署浏览器冒烟 2/2 通过，依赖审计为 0 vulnerabilities。
- 首次候选发布因部署浏览器版本与 AppArmor 路径契约不一致而在生产切换前安全拒绝；修复后增加 17/17 运行时加固回归，并通过低权限、断网、脱敏数据库和候选树复验。
- 生产备份 `v040-product-shell-design-system-20260714-215530` 校验和有效；PM2 online、Nginx 配置有效、SQLite `quick_check` 通过、四个外置运行时链接精确、公开/私有路由边界正确。
- 真实管理员通过 SSH loopback 完成登录、移动抽屉、CRM 看板/明细、M4 搜索/200 行表格/导入入口、AI 助手、管理员 AI 审计、注销和令牌吊销；三视口脱敏截图完成同屏复核，最终生产会话数为 0。
- 生产 App build 为 `20260714-v040-product-shell-design-system`；PPT 继续锁定 build `20260702-v916-kb-bridge-client-cn`、query `20260702v916kbbridge` 与 SHA-256 `f311a7b33ee28e64c8e19a14bae436101272dd17bf2f4f8c5d181d57dd0e291e`。

### 剩余风险 / Residual Risks
- 当前环境未执行 NVDA、VoiceOver 或浏览器原生缩放，不将其记录为通过，也不声明完整 WCAG 符合性。
- 旧流程设计器的完整键盘连线创作继续由 Phase 4 负责；本阶段覆盖共享壳层和键盘创建/选择节点。

---

## v0.3.0-baseline-consolidation (2026-07-13) - 最新界面基线整合与生产候选门禁

### 最新功能基线 / Latest Functional Baseline
- 以当前生产 UI、PPT bridge、CRM 客户看板/明细拆分、M4 自定义网红表头/导入/搜索/飞书/合作资源，以及 AI 对话与知识库底座作为唯一发布基线；冻结 `app.js`、`index.html`、`ppt.js` 和 72 张视觉基线，防止后续底层改造覆盖最新界面。
- 发布脚本锁定 App build `20260713-v030-baseline-consolidation`、PPT build `20260702-v916-kb-bridge-client-cn` 与 PPT SHA-256，并继续保护公开资源白名单和私有源码 `404` 边界。

### 外置运行时与非特权门禁 / External Runtime And Unprivileged Gate
- 新增一次性、可审计、失败自动恢复的 Ubuntu 26.04 运行时引导：创建禁止登录的 `turingmarket-gate`，安装经过 apt 模拟的浏览器依赖与窄化 AppArmor user-namespace 配置，并把环境文件、SQLite、上传和临时文件外置到 `/etc/turingmarket` 与 `/var/lib/turingmarket`。
- 引导迁移在停服前写入 root-only 持久 journal，停服后才通过 SQLite Backup API 与静态文件复制建立一致回滚快照；`ERR`、`INT`、`TERM`、`HUP` 或主机中断后重跑会先恢复或完成已提交迁移，数据库 `quick_check` 成功后才允许重启 PM2。
- 冻结浏览器基线继续精确使用 Playwright 1.60.0；生产证据与 Linux 部署冒烟通过 npm alias 独立使用原生支持 Ubuntu 26 的 Playwright 1.61.1，并强制 `chromiumSandbox: true`。
- 候选发布只写入 `/var/lib/turingmarket-gate/releases`；bootstrap 与 deploy 都校验 gate 账号的系统 UID、主组、补充组、锁定凭据、home 和 nologin shell，完整 Node、数据库结构指纹与用户/会话计数、浏览器和 Nginx 门禁均以该非特权账号运行。测试后由 root 复验上传清单、清理门禁进程、重建四个精确外置状态链接、去除写权限，并封存包含 `node_modules` 的完整候选树。
- writer 锁取得后、任何生产变更前再次核对候选树摘要；只有经过测试且摘要一致的目录可通过 `renameat2(RENAME_EXCHANGE)` 原子切换。当前 root PM2 保持不变，非 root PM2、私有命名空间和 canary 另列后续加固阶段。

### 验证与发布证据 / Verification And Release Evidence
- 冻结基线包含 72 张确定性截图、三个视口、管理员/普通用户角色、关键业务页面、构建标记、公开资源边界和 `index.html`/`app.js`/`ppt.js` SHA-256；迁移范围内重复定义与重复事件绑定已由契约测试锁定并分片收敛。
- 本地完整 Node 回归 163/163 通过；远端候选门禁 159 passed、4 skipped、0 failed，Linux 部署浏览器冒烟 2/2 通过，PPT bridge 文件和构建标记保持不变。
- 生产备份 `v030-baseline-consolidation-20260714-055603` 校验通过；PM2、Nginx、数据库 `quick_check`、公开/私有路由边界和关键文件哈希均通过部署后复验。
- 真实管理员会话通过 SSH loopback tunnel 完成 `1440x900`、`1920x1080`、`390x844` 三视口线上验收；认证 API 与核心业务读取均为 200，退出后令牌复验为 401，最终生产会话数为 0。
- HTML/PPTX 下载契约、Unicode 文件名降级和非特权 Nginx 候选门禁均经独立复审，最终无 P0/P1/P2 遗留问题；移动端侧栏占宽问题作为第 3 阶段明确 UX 输入，不在本阶段误记为已解决。

---

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
- 本地 API smoke：临时管理员登录、AI 对话归档、Admin 对话列表、需求 TXT 解析、PPT outline、PPTX 生成、品牌补全通过；临时库写入 1 个 AI conversation、2 条 message、4 条知识记录、1 条 PPT 请求归档，PPTX 输出 38KB。

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

# v0.8.9 Customer Report PPT Delivery Design / 客户复盘 PPT 交付设计

## Decision / 决策

Build an isolated, customer-safe PPT delivery path from a sealed
`customer_safe_v1` report snapshot. The PPT is a retained artifact that is
bound to one immutable snapshot. It does not regenerate from live campaign
data after it has been created.

在已封存的 `customer_safe_v1` 客户复盘快照之上，建立独立的客户版 PPT
交付链路。PPT 与一个不可变快照绑定，生成后不从实时活动数据重新生成。

## Product Contract / 产品约束

- A campaign owner or organization administrator with campaign write access
  can generate or download a customer PPT for a sealed report snapshot.
- A campaign reader can inspect the safe report snapshot but cannot create or
  download a delivery artifact.
- Each snapshot has at most one `customer-report-ppt-v1` artifact. Repeated
  requests return the same retained bytes.
- The artifact contains only the already-redacted report contract: project
  overview, data summary, eligible comparisons, key indicators, excellent
  cases, data limits, and next-cycle actions.
- No raw video link, creator contact, cost, commercial metric, internal AI
  prompt, Feishu credential, external recipient, or live external delivery is
  introduced in this release.
- Existing proposal PPT generation (`/api/proposal/generate-ppt`, `ppt.js`,
  and `campaign_ppt_service.js`) remains unchanged.

只有拥有活动写权限的活动负责人或组织管理员可以为已封存客户复盘生成和下载 PPT；
只读成员仍可查看复盘快照，但不能创建或下载交付成品。每个快照只保留一份
`customer-report-ppt-v1`，重复请求返回同一份已保留文件。此版本不包含对外发送、
收件人信息或任何商业敏感字段，也不改动既有方案 PPT 链路。

## Data Model / 数据模型

Migration 014 creates an append-only `customer_report_ppt_artifacts` table:

| Field | Meaning |
| --- | --- |
| `id` | Immutable artifact record ID |
| `org_id`, `campaign_id`, `snapshot_id` | Tenant and sealed snapshot boundary |
| `created_by`, `created_at` | Authorized generator and timestamp |
| `ppt_contract_version` | Fixed `customer-report-ppt-v1` contract |
| `snapshot_report_sha256` | Source snapshot report identity |
| `artifact_cache_key`, `artifact_sha256`, `artifact_bytes` | Verified retained PPT identity |

The table uses a composite campaign foreign key, a snapshot foreign key,
strict checks for hashes and positive byte size, a unique snapshot/contract
constraint, and no-update/no-delete triggers.

迁移 014 新增不可更新、不可删除的 PPT 成品表。它只保存活动、快照、生成者、
版本、来源报告哈希及文件校验信息，不保存未脱敏数据或收件人信息。

## Service Boundary / 服务边界

`customer_report_delivery_service.js` owns artifact creation and replay.

1. It asks the snapshot service for a write-authorized delivery context.
2. It rechecks the source report contract and source report hash before any
   file is generated.
3. It returns an existing verified artifact when one has already been sealed
   for the snapshot.
4. Otherwise it creates a temporary workspace, calls a dedicated customer
   report PPT renderer, publishes the file into a separate private artifact
   root, and records immutable metadata in one transaction.
5. If recording fails, it removes or leaves a verifiable orphan for the
   dedicated janitor; it never changes an existing artifact row.

The report PPT artifact root is separate from campaign proposal PPT artifacts,
so its janitor cannot remove proposal files.

`customer_report_delivery_service.js` 只接受客户复盘快照服务提供的写权限
上下文；每次生成前复核脱敏合同和报告哈希；存在成品时直接回放。客户报告与方案
PPT 使用不同的私有存储根目录，避免清理任务跨模块误删。

## API and UI / 接口与界面

`POST /api/campaigns/:id/performance/customer-report-snapshots/:snapshotId/ppt`

- Request body: empty JSON object only.
- Response: `application/vnd.openxmlformats-officedocument.presentationml.presentation`
  with an attachment filename and artifact SHA-256 header.
- Authorization and campaign/snapshot scope are enforced server side.

The existing `已封存版本` list receives one compact `客户版 PPT` action per
snapshot. It uses the existing button and download behavior, keeps the current
screen layout, prevents duplicate clicks while a request is running, and does
not add a new page.

## Delivery Standard / 发布标准

The user-selected cadence is feature-complete then production deployment:

- Ordinary isolated UI or business slices: affected tests, syntax/contract and
  secret checks, independent review, backup, production deployment, and
  online core smoke.
- This release is an exception because it adds a schema migration, permission
  enforcement, and retained binary artifacts. It requires the existing full
  candidate/replay migration gate before production deployment.


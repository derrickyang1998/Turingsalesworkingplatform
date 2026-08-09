# TuringMarket Production Deployment / 图灵商务平台生产部署

## Source Contract / 发布源契约

- Authoritative checkout / 唯一权威工作区：`C:\Users\29272\Documents\在线商务平台-github-sync`
- Release branch / 发布分支：`codex/v0.5.0-campaign-business-spine`
- Deployment entry / 部署入口：`platform/deploy_v8.ps1`
- Runtime / 运行时：Node.js 20, Express 5 + SQLite (better-sqlite3)
- PM2 contract / PM2 契约：`platform/ecosystem.config.js` starts `server/server.js` as `turingmarket`

Do not publish from an archived or static workspace. The guarded script rejects a different checkout, a different branch, or a dirty tracked worktree. / 不得从归档目录或旧静态工作区发布；脚本会拒绝非权威目录、错误分支或存在未提交改动的工作树。

The script is executable with the installed Windows PowerShell 5.1 and keeps its source ASCII-safe. Run `-ValidateLocalOnly` before any production connection to execute the same local source, build, inventory, and frozen-PPT checks without requiring SSH. / 脚本兼容当前安装的 Windows PowerShell 5.1，并保持源码 ASCII 安全；连接生产前先运行 `-ValidateLocalOnly`，可在不使用 SSH 的情况下执行同一套本地源码、构建、文件清单和冻结 PPT 校验。

## Frozen Client Contract / 冻结前端契约

The v0.5.0 guarded release keeps the approved v0.4.0 client build and frozen PPT bytes locked until the remaining Phase 4 static-boundary gates land. / v0.5.0 受控发布在剩余第 4 阶段静态边界门禁落地前，继续锁定已批准的 v0.4.0 前端构建与冻结 PPT 字节。

```text
App build: 20260714-v040-product-shell-design-system
App cache key: app.js?v=20260714v040productshelldesignsystem
PPT build: 20260702-v916-kb-bridge-client-cn
PPT cache key: ppt.js?v=20260702v916kbbridge
PPT SHA-256: f311a7b33ee28e64c8e19a14bae436101272dd17bf2f4f8c5d181d57dd0e291e
window.tmPPTBuild = "20260702-v916-kb-bridge-client-cn"
Admin inert preview marker: ?preview=v030
```

Only these modular browser assets are public / 仅以下模块化前端资源允许公开访问：

- `/client/shared/build_info.js`
- `/client/core/navigation.js`
- `/client/core/accessibility.js`
- `/client/core/shell.js`
- `/client/styles/tokens.css`
- `/client/styles/components.css`
- `/client/styles/layout.css`

Every other `/client/*` path and private source path such as `/server/server.js` must return `404` through both Express and Nginx. / 其他 `/client/*` 以及 `/server/server.js` 等私有源码路径必须在 Express 与 Nginx 两层均返回 `404`。

## Deploy / 部署

Production host and credentials remain external environment configuration. No host, password, token, provider key, cookie, or bearer value belongs in Git. / 生产主机与凭据由外部环境提供，禁止将主机、密码、令牌、供应商密钥、Cookie 或 Bearer 值写入 Git。

```powershell
$env:TURINGMARKET_SERVER = '<production-host>'
Set-Location 'C:\Users\29272\Documents\在线商务平台-github-sync'
.\platform\deploy_v8.ps1 -ValidateLocalOnly
.\platform\deploy_v8.ps1
```

Before the first deployment using the external runtime layout, run the audited bootstrap once. It installs only the simulated and reviewed Ubuntu 26.04 browser dependency set, creates the no-login `turingmarket-gate` account and AppArmor user-namespace profile, migrates mutable state, restarts the existing root-owned PM2 process, and proves health plus SQLite `quick_check`. / 首次使用外置运行时布局发布前，必须执行一次经审查的引导脚本。它只安装已模拟审查的 Ubuntu 26.04 浏览器依赖，创建禁止登录的门禁账号和 AppArmor user namespace 配置，迁移可变状态，重启现有 root PM2，并验证健康检查与 SQLite `quick_check`。

Before stopping PM2, the bootstrap durably records its phase at `/var/lib/turingmarket-bootstrap/active`. Only after writers stop does it capture the rollback database through the SQLite Backup API and copy uploads. `ERR`, `INT`, `TERM`, and `HUP` trigger recovery; a later rerun also recovers or finalizes a journal left by process or host interruption. A successful terminal state is published durably as pending acknowledgement: the journal is not cleared automatically and only an explicit ACK for its exact terminal ID may consume that generation. / 引导脚本在停止 PM2 前持久记录迁移阶段；停服后才通过 SQLite Backup API 和文件复制建立一致回滚快照。错误、终止信号或主机中断后重跑都会先执行恢复或完成已提交迁移。成功终态会持久发布为待确认状态；journal 不会自动清除，只有携带该代精确终态 ID 的显式 ACK 才能消费该代记录。

```powershell
scp -i "$env:USERPROFILE\.ssh\turingmarket_deploy" -o BatchMode=yes -o StrictHostKeyChecking=yes .\platform\server\scripts\bootstrap_production_runtime.sh "root@$env:TURINGMARKET_SERVER`:/root/turingmarket/bootstrap_production_runtime.sh"
```

This step uploads the audited script only; it does not execute it. Open one dedicated root Bash session on the host and run the following operator blocks in order in that same session. The first-run output is captured exactly once by the first Bash block below. / 此步骤只上传经审查的脚本，不执行脚本。随后在主机上打开一个专用 root Bash 会话，并在同一会话中按顺序运行以下操作员代码块。首次运行输出只由下方第一个 Bash 代码块捕获一次。

### Bootstrap Terminal Acknowledgement / 引导终态确认

A normal bootstrap success prints all three terminal contract records below. `BOOTSTRAP_TERMINAL_ID` is `t1:` followed by exactly 64 lowercase SHA-256 hexadecimal characters; the terminal outcome remains pending until an operator acknowledges that exact generation. / 普通 bootstrap 成功时会输出以下三条终态合同记录。`BOOTSTRAP_TERMINAL_ID` 的格式为 `t1:` 后跟 64 个小写 SHA-256 十六进制字符；在操作员确认该精确代次前，terminal outcome 始终保持 pending。

```text
BOOTSTRAP_OK
BOOTSTRAP_TERMINAL_ID=t1:<sha256>
BOOTSTRAP_JOURNAL_TERMINAL_OUTCOME=terminal-pending
```

The journal is not cleared automatically. A terminal-pending rerun returns the same terminal ID and terminal-pending outcome before the checked-in prohibited-mutation boundary. It does not emit BOOTSTRAP_OK and must not create a replacement generation. The checked-in boundary proves that the rerun returns before control-plane preparation, cleanup arming, shared fences, committed-layout repair, or a new migration; it does not claim that no pre-gate housekeeping occurs. / journal 不会自动清除。terminal-pending 重跑会在仓库测试覆盖的禁止 mutation 边界之前返回同一 terminal ID 与 terminal-pending outcome；pending 重跑不输出第二个 `BOOTSTRAP_OK`，也不得创建替代代次。该边界证明重跑会在控制面准备、cleanup arming、共享 fences、已提交布局修复或新迁移之前返回，但不声称门禁前完全没有 housekeeping。

#### Safe terminal ID extraction / 安全提取终态 ID

Run this once in the dedicated root Bash session. It keeps stdout only in shell memory and accepts exactly one of two closed success contracts: a normal `BOOTSTRAP_OK` plus terminal-pending outcome, or an interrupted-layout recovery `BOOTSTRAP_RECOVERY_COMMIT_OK` plus committed-recovered outcome. Both contracts require exactly one well-formed terminal ID. It never interprets output as shell code. Do not use `eval`, do not enable shell tracing, and do not write credentials to logs; credentials remain external and must never be pasted into this output. / 在专用 root Bash 会话中只运行一次。stdout 仅保存在 shell 内存中，并且只接受两种封闭成功契约之一：普通 `BOOTSTRAP_OK` 加 terminal-pending outcome，或中断布局恢复的 `BOOTSTRAP_RECOVERY_COMMIT_OK` 加 committed-recovered outcome；两种契约都必须恰好包含一个格式正确的 terminal ID。输出绝不会被解释为 shell 代码。禁止使用 `eval`、禁止开启 shell tracing，也不得把凭据写入日志；凭据必须保持外置，绝不能粘贴到该输出中。

```bash
set -euo pipefail
readonly BOOTSTRAP_SCRIPT=/root/turingmarket/bootstrap_production_runtime.sh

if BOOTSTRAP_OUTPUT="$(bash "$BOOTSTRAP_SCRIPT")"; then
  :
else
  BOOTSTRAP_STATUS=$?
  printf '%s\n' "$BOOTSTRAP_OUTPUT" >&2
  exit "$BOOTSTRAP_STATUS"
fi

BOOTSTRAP_OK_COUNT=0
BOOTSTRAP_RECOVERY_OK_COUNT=0
BOOTSTRAP_OUTCOME_COUNT=0
BOOTSTRAP_PENDING_OUTCOME_COUNT=0
BOOTSTRAP_RECOVERY_OUTCOME_COUNT=0
BOOTSTRAP_ID_COUNT=0
BOOTSTRAP_ID_RECORD=
while IFS= read -r BOOTSTRAP_RECORD; do
  case "$BOOTSTRAP_RECORD" in
    BOOTSTRAP_OK)
      BOOTSTRAP_OK_COUNT=$((BOOTSTRAP_OK_COUNT + 1))
      ;;
    BOOTSTRAP_OK*)
      printf '%s\n' 'Malformed BOOTSTRAP_OK record' >&2
      exit 1
      ;;
    BOOTSTRAP_RECOVERY_COMMIT_OK)
      BOOTSTRAP_RECOVERY_OK_COUNT=$((BOOTSTRAP_RECOVERY_OK_COUNT + 1))
      ;;
    BOOTSTRAP_RECOVERY_COMMIT_OK*)
      printf '%s\n' 'Malformed BOOTSTRAP_RECOVERY_COMMIT_OK record' >&2
      exit 1
      ;;
    BOOTSTRAP_JOURNAL_TERMINAL_OUTCOME=terminal-pending)
      BOOTSTRAP_OUTCOME_COUNT=$((BOOTSTRAP_OUTCOME_COUNT + 1))
      BOOTSTRAP_PENDING_OUTCOME_COUNT=$((BOOTSTRAP_PENDING_OUTCOME_COUNT + 1))
      ;;
    BOOTSTRAP_JOURNAL_TERMINAL_OUTCOME=committed-recovered)
      BOOTSTRAP_OUTCOME_COUNT=$((BOOTSTRAP_OUTCOME_COUNT + 1))
      BOOTSTRAP_RECOVERY_OUTCOME_COUNT=$((BOOTSTRAP_RECOVERY_OUTCOME_COUNT + 1))
      ;;
    BOOTSTRAP_JOURNAL_TERMINAL_OUTCOME*)
      printf '%s\n' 'Malformed bootstrap terminal outcome record' >&2
      exit 1
      ;;
    BOOTSTRAP_TERMINAL_ID*)
      BOOTSTRAP_ID_COUNT=$((BOOTSTRAP_ID_COUNT + 1))
      if ! [[ "$BOOTSTRAP_RECORD" =~ ^BOOTSTRAP_TERMINAL_ID=t1:[0-9a-f]{64}$ ]]; then
        printf '%s\n' 'Malformed bootstrap terminal ID record' >&2
        exit 1
      fi
      BOOTSTRAP_ID_RECORD="$BOOTSTRAP_RECORD"
      ;;
  esac
done <<<"$BOOTSTRAP_OUTPUT"

if [ "$BOOTSTRAP_OUTCOME_COUNT" -ne 1 ]; then
  printf '%s\n' 'Expected exactly one supported bootstrap terminal outcome record' >&2
  exit 1
fi
if [ "$BOOTSTRAP_ID_COUNT" -ne 1 ]; then
  printf '%s\n' 'Expected exactly one valid bootstrap terminal ID record' >&2
  exit 1
fi

BOOTSTRAP_PROTOCOL=
if [ "$BOOTSTRAP_OK_COUNT" -eq 1 ] && \
   [ "$BOOTSTRAP_RECOVERY_OK_COUNT" -eq 0 ] && \
   [ "$BOOTSTRAP_PENDING_OUTCOME_COUNT" -eq 1 ] && \
   [ "$BOOTSTRAP_RECOVERY_OUTCOME_COUNT" -eq 0 ]; then
  BOOTSTRAP_PROTOCOL=normal
elif [ "$BOOTSTRAP_OK_COUNT" -eq 0 ] && \
     [ "$BOOTSTRAP_RECOVERY_OK_COUNT" -eq 1 ] && \
     [ "$BOOTSTRAP_PENDING_OUTCOME_COUNT" -eq 0 ] && \
     [ "$BOOTSTRAP_RECOVERY_OUTCOME_COUNT" -eq 1 ]; then
  BOOTSTRAP_PROTOCOL=committed-recovery
else
  printf '%s\n' 'Bootstrap output mixed or omitted normal and recovery success records' >&2
  exit 1
fi

TERMINAL_ID="${BOOTSTRAP_ID_RECORD#BOOTSTRAP_TERMINAL_ID=}"
printf '%s\n' "$BOOTSTRAP_OUTPUT"
printf 'BOOTSTRAP_PROTOCOL=%s\n' "$BOOTSTRAP_PROTOCOL"
printf 'TERMINAL_ID=%s\n' "$TERMINAL_ID"
unset BOOTSTRAP_OUTPUT BOOTSTRAP_ID_RECORD
```

#### Evidence gate / 证据门禁

Verify runtime, exact links, SQLite, and marker evidence before ACK. The gate checks the PM2 PID and loopback health response, all four exact external-state links and their targets, external runtime ownership and shape, SQLite `quick_check`, and the permanent marker proof. / ACK 前必须校验 runtime、精确 links、SQLite 与 marker 证据。门禁会检查 PM2 PID 与回环健康响应、四个外置状态软链接及其精确目标、外置运行时的所有权与结构、SQLite `quick_check` 以及永久 marker 证明。

`validate_external_layout_marker` is the bounded, root-owned guard-file housekeeping exception. If the shell has not bound the external-layout root, it calls `bind_external_layout_root` and may create `/root/turingmarket/.external-runtime-root-mount-guard-v1.<boot-id>` with root:root ownership and mode `0600`. The file binds the trusted root token to the mount chain for the current Linux boot so mount drift fails closed. This housekeeping does not mutate business data or the runtime layout: it does not change SQLite, uploads, external-state links, or the permanent layout marker. It creates at most one guard file for the current boot when absent and otherwise validates the existing exact file in place. The evidence gate also acquires the transient journal protocol reservation for the captured terminal ID and explicitly releases it after all checks. / `validate_external_layout_marker` 是一个有界的 root 所有 guard-file housekeeping 例外。如果当前 shell 尚未绑定外置布局根，它会调用 `bind_external_layout_root`，并可能创建 root:root、模式为 `0600` 的 `/root/turingmarket/.external-runtime-root-mount-guard-v1.<boot-id>`。该文件把可信 root token 绑定到当前 Linux 启动的 mount chain，使挂载漂移失败关闭。此 housekeeping 不会修改业务数据或运行时布局：不会更改 SQLite、uploads、外置状态 links 或永久布局 marker。当前启动期间，文件不存在时最多创建一个；已存在时只原位校验精确文件。证据门禁还会为捕获的 terminal ID 获取临时 journal 协议预留，并在全部检查完成后显式释放。

Every command must succeed before ACK; any missing, conflicting, or ambiguous result is a stop condition. / 所有命令均成功后才可 ACK；任何缺失、冲突或歧义结果都必须立即停止。

```bash
set -euo pipefail
PM2_PID="$(pm2 pid turingmarket)"
[[ "$PM2_PID" =~ ^[1-9][0-9]*$ ]]
curl --fail --silent --show-error http://127.0.0.1:3002/api/health |
  node -e '
let body = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { body += chunk; });
process.stdin.on("end", () => {
  const health = JSON.parse(body);
  if (health.status !== "ok") process.exit(1);
  process.stdout.write("BOOTSTRAP_OPERATOR_RUNTIME_OK\n");
});
'

TERMINAL_ID="$TERMINAL_ID" TM_BOOTSTRAP_LIBRARY_ONLY=1 bash --noprofile --norc <<'BASH'
set -Eeuo pipefail
source /root/turingmarket/bootstrap_production_runtime.sh
: "${TERMINAL_ID:?Run the first-run capture block in this shell}"
reserve_migration_journal_capacity "$TERMINAL_ID"
discover_migration_journal "$TERMINAL_ID"
[ "$JOURNAL_PRESENT" = 1 ]
[ "$JOURNAL_TERMINAL_STATE" = terminal-pending ]
[ "$JOURNAL_TERMINAL_ID" = "$TERMINAL_ID" ]
validate_terminal_journal_marker_provenance
printf '%s\n' 'BOOTSTRAP_OPERATOR_JOURNAL_OK'
validate_loopback_firewall
validate_current_release_health
systemctl is-enabled --quiet "$FIREWALL_UNIT"
systemctl is-active --quiet "$FIREWALL_UNIT"
printf '%s\n' 'BOOTSTRAP_OPERATOR_ISOLATION_OK'
validate_exact_link /root/turingmarket/platform/.env /etc/turingmarket/turingmarket.env
validate_exact_link /root/turingmarket/platform/server/db /var/lib/turingmarket/db
validate_exact_link /root/turingmarket/platform/uploads /var/lib/turingmarket/uploads
validate_exact_link /root/turingmarket/platform/tmp /var/lib/turingmarket/tmp
validate_external_runtime
printf '%s\n' 'BOOTSTRAP_OPERATOR_LINKS_OK'
database_quick_check /var/lib/turingmarket/db/turingmarket.db
validate_external_layout_marker
printf '%s\n' 'BOOTSTRAP_OPERATOR_MARKER_OK'
release_migration_journal_capacity_reservation
BASH
```

The evidence gate must print `BOOTSTRAP_OPERATOR_RUNTIME_OK`, `BOOTSTRAP_OPERATOR_JOURNAL_OK`, `BOOTSTRAP_OPERATOR_ISOLATION_OK`, `BOOTSTRAP_OPERATOR_LINKS_OK`, `DB_QUICK_CHECK=ok`, and `BOOTSTRAP_OPERATOR_MARKER_OK`. Any failed or ambiguous check stops the flow before the pending rerun and ACK. / 证据门禁必须输出 `BOOTSTRAP_OPERATOR_RUNTIME_OK`、`BOOTSTRAP_OPERATOR_JOURNAL_OK`、`BOOTSTRAP_OPERATOR_ISOLATION_OK`、`BOOTSTRAP_OPERATOR_LINKS_OK`、`DB_QUICK_CHECK=ok` 与 `BOOTSTRAP_OPERATOR_MARKER_OK`。任何失败或歧义检查都会在 pending 重跑与 ACK 之前停止流程。

#### Pending rerun verification / pending 重跑核验

After the evidence gate succeeds, run the normal bootstrap once more. This terminal-pending rerun must return exactly one record for the same `TERMINAL_ID`, exactly one terminal-pending outcome, and no `BOOTSTRAP_OK`. The validator rejects missing, duplicate, malformed, or conflicting records before ACK. / 证据门禁成功后，再普通重跑一次 bootstrap。该 terminal-pending 重跑必须恰好返回一条同一 `TERMINAL_ID` 记录和一条 terminal-pending outcome，并且不得输出 `BOOTSTRAP_OK`。缺失、重复、畸形或冲突记录都会在 ACK 前失败关闭。

```bash
set -euo pipefail
: "${BOOTSTRAP_SCRIPT:?Run the first-run capture block in this shell}"
: "${TERMINAL_ID:?Run the first-run capture block in this shell}"

if RERUN_OUTPUT="$(bash "$BOOTSTRAP_SCRIPT")"; then
  :
else
  RERUN_STATUS=$?
  printf '%s\n' "$RERUN_OUTPUT" >&2
  exit "$RERUN_STATUS"
fi

RERUN_OK_COUNT=0
RERUN_OUTCOME_COUNT=0
RERUN_ID_COUNT=0
while IFS= read -r RERUN_RECORD; do
  case "$RERUN_RECORD" in
    BOOTSTRAP_OK*)
      RERUN_OK_COUNT=$((RERUN_OK_COUNT + 1))
      ;;
    BOOTSTRAP_RECOVERY_*)
      printf '%s\n' 'Pending rerun must not emit a bootstrap recovery record' >&2
      exit 1
      ;;
    BOOTSTRAP_JOURNAL_TERMINAL_OUTCOME*)
      RERUN_OUTCOME_COUNT=$((RERUN_OUTCOME_COUNT + 1))
      if [ "$RERUN_RECORD" != 'BOOTSTRAP_JOURNAL_TERMINAL_OUTCOME=terminal-pending' ]; then
        printf '%s\n' 'Malformed pending-rerun terminal outcome record' >&2
        exit 1
      fi
      ;;
    BOOTSTRAP_TERMINAL_ID*)
      RERUN_ID_COUNT=$((RERUN_ID_COUNT + 1))
      if [ "$RERUN_RECORD" != "BOOTSTRAP_TERMINAL_ID=$TERMINAL_ID" ]; then
        printf '%s\n' 'Pending rerun returned a different or malformed terminal ID' >&2
        exit 1
      fi
      ;;
  esac
done <<<"$RERUN_OUTPUT"

if [ "$RERUN_OK_COUNT" -ne 0 ]; then
  printf '%s\n' 'Pending rerun must not emit BOOTSTRAP_OK' >&2
  exit 1
fi
if [ "$RERUN_OUTCOME_COUNT" -ne 1 ]; then
  printf '%s\n' 'Expected exactly one pending-rerun terminal outcome record' >&2
  exit 1
fi
if [ "$RERUN_ID_COUNT" -ne 1 ]; then
  printf '%s\n' 'Expected exactly one matching pending-rerun terminal ID record' >&2
  exit 1
fi

printf '%s\n' "$RERUN_OUTPUT"
unset RERUN_OUTPUT
```

#### Explicit ACK / 显式 ACK

Only after the first-run validator, evidence gate, and pending-rerun validator all succeed may the operator acknowledge the exact captured terminal ID. / 只有首次运行校验、证据门禁和 pending 重跑校验全部成功后，操作员才可以确认所捕获的精确 terminal ID。

```bash
set -euo pipefail
: "${TERMINAL_ID:?Run the first-run capture block in this shell}"

ACK_OUTPUT="$(bash /root/turingmarket/bootstrap_production_runtime.sh --ack-terminal "$TERMINAL_ID")"
if [ "$ACK_OUTPUT" != "BOOTSTRAP_TERMINAL_ACKNOWLEDGED=$TERMINAL_ID" ]; then
  printf '%s\n' 'Bootstrap terminal ACK did not return the exact expected record' >&2
  exit 1
fi
printf '%s\n' "$ACK_OUTPUT"
unset ACK_OUTPUT
```

The expected acknowledgement is `BOOTSTRAP_TERMINAL_ACKNOWLEDGED=<id>`, where `<id>` exactly equals `TERMINAL_ID`. Repeating ACK with the same ID is idempotent; a wrong or stale ID fails closed. Never edit or delete journal files to bypass a rejected ACK. / 期望输出为 `BOOTSTRAP_TERMINAL_ACKNOWLEDGED=<id>`，其中 `<id>` 必须与 `TERMINAL_ID` 完全一致。同一 ID 重复 ACK 为幂等，错误或过期 ID 均失败关闭。ACK 被拒绝时绝不允许通过编辑或删除 journal 文件绕过校验。

#### Capacity and recovery rules / 容量与恢复规则

- Full capacity still allows the matching pending ACK in place through its terminal-only reservation; it does not need or allocate a new journal directory. / journal 满容量时，匹配的 pending ACK 仍原位允许，并使用 terminal-only 预留通道；它不需要也不会分配新的 journal 目录。
- `existing-live` recovery may recover only the validated live generation in place; it must not start a new generation. If that recovery cannot reach a proven terminal state, it fails closed and retains the live evidence. / `existing-live` 恢复只允许原位恢复已验证的 live generation；不得启动新代次。若无法到达可证明的终态，则失败关闭并保留 live 证据。
- Unknown, uncertain, or repair evidence must not delete the journal. Preserve the journal and host state, stop online mutation, and move to offline maintenance or rollback with an independently reviewed evidence set. / 遇到 unknown、uncertain 或 repair evidence 时不得删除 journal；必须保留 journal 与主机状态，停止在线 mutation，并携带经独立复核的证据转入离线维护或回滚。

The resulting mutable paths are `/etc/turingmarket/turingmarket.env`, `/var/lib/turingmarket/db`, `/var/lib/turingmarket/uploads`, and `/var/lib/turingmarket/tmp`; the active release contains only exact root-owned symlinks to them. Root-owned PM2 remains the production process manager in this phase. / 迁移后的可变路径固定为上述四处，活动版本中仅保留指向它们的精确 root 所有软链接；本阶段生产进程仍由 root PM2 管理。

`-ValidateLocalOnly` is a local-only mode and performs zero remote operations. It cannot be combined with rollback or destructive-restore controls. Supplying `-RollbackBackup` explicitly with an empty, blank, malformed, or unsupported value is rejected locally and never falls through to deployment. / `-ValidateLocalOnly` 是零远端操作的纯本地模式，禁止与回滚或破坏性恢复参数组合使用；显式传入空值、空白、格式错误或不受支持的回滚编号时会在本地拒绝，绝不会回落到正式部署。

Phase 4 always invalidates all existing sessions before PM2 starts. `-PreserveSessions` is retained only as a rejected compatibility parameter and cannot be used for deploy or restore. / 第 4 阶段始终在 PM2 启动前撤销全部现有会话；`-PreserveSessions` 仅作为会被拒绝的兼容参数保留，发布和恢复均不得使用。

The Windows PowerShell 5.1 transport writes UTF-8 without BOM and normalizes CRLF or CR input to LF before sending any script to remote Bash. The local preflight executes this exact CRLF-to-LF check. / Windows PowerShell 5.1 传输层会使用无 BOM UTF-8，并在发送远端 Bash 前将 CRLF 或 CR 统一为 LF；本地预检会执行同一项转换自测。

The script performs these gates in order / 脚本按以下顺序执行：

1. Verify checkout, branch, clean state, build markers, cache keys, and frozen PPT hash. / 校验工作区、分支、干净状态、构建标记、缓存键及冻结 PPT 哈希。
2. Acquire the fail-closed lifecycle lock at `/root/turingmarket/.deploy-v030.lock`; deployment and manual rollback share it for their complete remote lifecycle, while production mutation additionally requires the stable global writer mutex. / 获取失败关闭的远端生命周期锁；正式发布与手工回滚在完整远端生命周期内共用该锁，生产变更还必须另外取得稳定的全局 writer 互斥。
3. Create `/root/turingmarket/backups/v050-campaign-business-spine-<timestamp>` with present/absent manifests, both dependency trees, a consistent `better-sqlite3` database copy, the private root-owned `PPT_CACHE_DIR=/var/lib/turingmarket/ppt-cache` tree, Nginx configuration, and nested plus aggregate SHA-256 manifests. The backup path must not already exist. / 建立 v0.5.0 外置版本化备份，将数据库与私有 PPT 缓存作为同一验签单元；同名备份存在时立即失败。
4. Upload every runtime, browser, test, and evidence file only to `/var/lib/turingmarket-gate/releases/v050-campaign-business-spine-<timestamp>`; store the immutable upload manifest under the root-only lifecycle lock and verify it before and after candidate testing. The active `/root/turingmarket/platform` tree is not overwritten during validation. / 所有文件只上传到 v0.5.0 外置候选目录；不可变上传清单保存在仅 root 可读的生命周期锁内，并在候选测试前后各校验一次，验证期间不覆盖活动生产目录。
5. Rebuild a non-secret fixture from the checksummed production schema with synthetic users, security fields, organizations, memberships, teams, campaigns, knowledge, and AI rows, while copying only the non-secret migration ledger. Candidate migration code runs twice as the no-login `turingmarket-gate` UID inside a bounded systemd service with private network, PID, and mount namespaces, a read-only filesystem, explicit inaccessible production paths, and root-only stdout/stderr. After the whole cgroup is empty, trusted code from the active production runtime verifies preserved-table digests, exact user security fields, organization/team/campaign rows, migration idempotence, and unchanged production-backup and PPT-manifest hashes. The complete Node, browser, and Nginx checks then run under the existing unprivileged gate. / 从已验签生产结构重建不含真实数据的合成副本，覆盖用户安全字段、组织、成员、团队、项目、知识与 AI 数据，并且只复制非敏感迁移账本。候选迁移代码以禁止登录的门禁 UID 在受限 systemd 服务中执行两次，使用独立网络、PID 与挂载命名空间、只读文件系统、显式不可访问生产路径及仅 root 可读输出。确认整个 cgroup 清空后，再由活动生产运行时的可信代码核对保留表摘要、用户安全字段、组织/团队/项目记录、迁移幂等性，以及生产备份和 PPT 清单哈希不变；随后执行完整 Node、浏览器及 Nginx 门禁。
   Bootstrap and deploy independently validate the account's system UID, primary and supplementary groups, locked credentials, fixed home, and nologin shell before candidate code can run. / 引导和发布会分别核验门禁账号的系统 UID、主组、补充组、锁定凭据、固定 home 与 nologin shell，身份漂移时禁止运行候选代码。
6. Kill and verify the absence of all gate-user processes, recheck uploaded sources, recreate only the four exact external-state symlinks, remove ACL/write escalation, and seal the complete candidate tree including `node_modules`. After acquiring the writer lock, recheck the same digest immediately before stopping PM2 and atomically exchange the sealed candidate with Linux `renameat2(RENAME_EXCHANGE)`. / 门禁结束后清理并确认该用户无残留进程，复验上传源码，仅重建四个精确外置状态链接，移除 ACL 与多余写权限，并封存包含 `node_modules` 的完整候选树；取得 writer 锁后、停止 PM2 前再次核对同一摘要，再执行 Linux 原子目录交换。
7. After PM2 stops and the candidate tree is exchanged, delete and verify all sessions before the candidate service starts; then verify `/api/health`, core routes, the exact public allowlist, and private-path denial. / PM2 停止并交换候选树后，在候选服务启动前删除并核对全部会话，再验证健康、核心路由、精确公开白名单与私有路径拒绝。
8. A candidate-validation failure removes only the candidate and leaves active PM2 untouched. Confirmed post-mutation failure uses the same restore function to verify and restore code, both dependency trees, repository evidence, Nginx, SQLite, and the private PPT cache; it removes SQLite sidecars, clears sessions, and only then restarts. / 候选验证失败只清理候选目录且不停止活动 PM2；确认已变更后的失败使用同一恢复函数验签并恢复代码、依赖、证据、Nginx、SQLite 与私有 PPT 缓存，清理 SQLite sidecar 并撤销会话后才允许重启。

The current lifecycle moves from `locked` directly to writer-protected `mutation-intent`, `mutation-started`, and `cutover-complete`; `candidate-ready` is accepted only for recovery compatibility with an older interrupted run and is never written independently. Before any production mutation, the active cutover or recovery process must also own the stable global atomic writer mutex at `/root/turingmarket/.deploy-v030.writer` and recheck the lifecycle owner after acquiring it. This prevents SSH-disconnect overlap, delayed cutover entry into a replacement lock generation, and stale phase writes. A transport failure before mutation cleans only the candidate; confirmed `mutation-started` runs restore; `mutation-intent`, an unreadable phase, an active/stale writer mutex, or uncertain recovery retains the locks without another automatic production action. Treat retained locks as incident markers: confirm that no deployment, rollback, or remote cutover process is active, inspect production and backup state, and only then remove stale `.deploy-v030.lock` and `.deploy-v030.writer` paths. / 当前生命周期从 `locked` 直接进入受 writer 保护的 `mutation-intent`、`mutation-started` 和 `cutover-complete`；`candidate-ready` 仅用于兼容历史中断恢复，不再独立写入。任何生产变更前，切换或恢复进程还必须持有稳定的全局原子互斥 `/root/turingmarket/.deploy-v030.writer`，并在获取后重新校验生命周期 owner，从而阻止 SSH 中断并发、延迟进程跨锁代际写入和旧阶段覆盖。变更意图、阶段不可读、writer 活动或残留、恢复不确定时均停止自动生产操作并保留锁；必须确认没有活动发布、回滚或远端切换进程，并检查生产与备份状态后，才能清理残留的 lifecycle 与 writer 路径。

The remote full Node gate is equivalent to / 远端完整 Node 门禁等价于：

Production route smoke covers `/api/health`, `/m0`, `/m0-detail`, `/m4`, and `/admin` before the release is accepted.

```bash
cd server
NODE_ENV=test TM_DISABLE_DOTENV=1 DB_PATH=/var/lib/turingmarket-gate/releases/<release>/tmp/deploy-v050-gate-<timestamp>/test.db node --test --test-concurrency=1 tests/*.test.js
```

## Rollback / 回滚

Use only a backup created by this release / 只允许使用本版本生成的备份：

```powershell
.\platform\deploy_v8.ps1 -RollbackBackup backups/v050-campaign-business-spine-<timestamp> -RestoreDatabase -ConfirmDataLoss
```

`-RollbackBackup` requires both `-RestoreDatabase` and `-ConfirmDataLoss`; code-only Phase 4 rollback, omitted consent, and every use of `-PreserveSessions` are rejected before server lookup or lock acquisition. A valid request acquires lifecycle and writer ownership, verifies every manifest, stops PM2, restores code, dependencies, repository evidence, Nginx, SQLite, and `PPT_CACHE_DIR`, invalidates all sessions, then restarts `turingmarket` with `SERVER_HOST=127.0.0.1` and verifies `/api/health`. `-MaintenanceTimeoutSeconds` is bounded to 15-300 seconds and defaults to 60. / 手工回滚必须同时显式提供数据库恢复与数据丢失确认；禁止仅回滚代码、缺少确认或保留会话。合法请求完成整体验签恢复并撤销全部会话后才重启。

The destructive restore explicitly accepts loss of writes after the selected backup. The restored database and PPT cache are one backup unit, and restored sessions are always deleted before restart. / 破坏性恢复明确接受所选备份之后的业务写入丢失；数据库与 PPT 缓存必须作为同一备份单元恢复，且恢复出的会话始终在重启前删除。

## Remaining Phase 4 Gates / 第 4 阶段剩余门禁

This acceleration slice does not make production cutover acceptable by itself. Deployment remains blocked until the exhaustive sanitizer and stale-run cleanup, all-API maintenance plus accepted-marker boundary, persistent loopback firewall proof, checked-in one-request replay gate, resumable rollback/security-overlay journal, DB/cache ledger parity, retention policy, and authenticated browser/accessibility evidence are implemented and independently accepted. / 本次加速切片本身不代表可生产切换；完整脱敏与残留清理、全 API 维护及 accepted marker 边界、持久化回环防火墙、单次 replay 门禁、可恢复回滚与安全覆盖 journal、数据库/缓存账本一致性、保留策略及登录态浏览器/无障碍证据仍为阻塞项。

## Release Evidence / 发布证据

Record the backup path, commit SHA, uploaded checksum result, full test counts, route smoke result, PM2 state, Nginx validation, and production browser result. Keep real credentials only in protected server-side storage. / 记录备份路径、提交 SHA、上传校验、完整测试计数、路由冒烟、PM2、Nginx 与生产浏览器验收结果；真实凭据仅保存在受保护的服务端存储中。

Credential rotation payloads remain outside Git at `D:\主盘\图灵集市\图灵商务平台开发\99-private\rotation-payload-v0.2.10.private.json`. From `platform/server`, pass the protected UTF-8 payload through standard input only: / 凭据轮换载荷固定保存在 Git 之外，并且只通过标准输入执行：

```powershell
$payloadPath = 'D:\主盘\图灵集市\图灵商务平台开发\99-private\rotation-payload-v0.2.10.private.json'
Get-Content -Raw -Encoding UTF8 -LiteralPath $payloadPath | node scripts/rotate_user_credentials.js
```

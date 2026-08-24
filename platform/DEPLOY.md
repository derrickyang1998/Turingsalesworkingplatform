# TuringMarket Production Deployment / 图灵商务平台生产部署

## Source Contract / 发布源契约

- Authoritative checkout / 唯一权威工作区：`C:\Users\29272\Documents\在线商务平台-github-sync`
- Release branch / 发布分支：`codex/v0.6.0-crm-sales-workspace`
- Deployment entry / 部署入口：`platform/deploy_v8.ps1`
- Application runtime / 应用运行时：Node.js 20, Express 5 + SQLite (better-sqlite3)
- Parser appliance build runtime / 解析器设备构建运行时：Linux `x86_64`, Node.js `v20.20.2`, Python `3.14.4`, systemd 257+
- PM2 contract / PM2 契约：`platform/ecosystem.config.js` starts `server/server.js` as `turingmarket`

Do not publish from an archived or static workspace. The guarded script rejects a different checkout, a different branch, or a dirty tracked worktree. / 不得从归档目录或旧静态工作区发布；脚本会拒绝非权威目录、错误分支或存在未提交改动的工作树。

The script is executable with the installed Windows PowerShell 5.1 and keeps its source ASCII-safe. Run `-ValidateLocalOnly` before any production connection to execute the same local source, build, inventory, and frozen-PPT checks without requiring SSH. / 脚本兼容当前安装的 Windows PowerShell 5.1，并保持源码 ASCII 安全；连接生产前先运行 `-ValidateLocalOnly`，可在不使用 SSH 的情况下执行同一套本地源码、构建、文件清单和冻结 PPT 校验。

## Release Candidate Status / 发布候选状态

This runbook describes the current v0.6 release candidate controls. It does not record a production release. / 本手册描述当前 v0.6 发布候选的控制项，不代表已完成生产发布。

- Local post-remediation gates / 本地修复后门禁：Task 1 `182 total / 163 pass / 0 fail / 19 Linux skips`; Task 2 `135 / 119 / 0 / 16`; Task 3 `81 / 79 / 0 / 2`
- Historical phase-closeout evidence / 历史阶段收口证据：the 71-file Windows non-browser aggregate reports `1,875 total / 1,784 pass / 0 fail / 91 explicit skips`; earlier public-guard runs are retained as historical evidence only and do not describe the current feature slice. / 71 文件 Windows 非浏览器汇总及早期公网守护结果仅作为历史阶段收口证据保留，不代表当前功能切片。
- Public-guard state recovery / 公网守护状态恢复：`public-gate-guard` 与 `.next` 使用 exact operation-aware 事务；transaction lock 只允许 no-follow、root:root、`0600`、nlink 1、regular、空文件且无 xattr。可信 `read-record`、四类 transient unit 的 phase/RunId 绑定与精确排空、lock-only `absent` 收敛、watchdog 后置状态复核、目录 fsync 和固定 `rootGid`/`wwwDataGid` 消除接管竞态与扫描顺序依赖。接受态恢复在任何 PM2 变更前先通过可信 helper 进入受 watchdog 保护的维护态，并使用独立 7,200 秒有界 deadline 覆盖 PM2、完整 180 秒健康窗口及最终验证；公网与 PM2 精确事实收敛后才 disarm。
- Current focused slice / 当前定向切片：lifecycle takeover `31/31`, deployment source contract `44/44`, and selected public-guard concurrency/read/timeout tests `4/4`; PowerShell AST, Bash syntax, trusted hashes, diff check, and focused secret scan pass. Independent final review is recorded separately before deployment. / 生命周期接管 31/31、发布源合同 44/44、公网守护关键并发/读取/超时用例 4/4；PowerShell AST、Bash 语法、可信哈希、diff 与聚焦敏感信息检查通过，独立终审在部署前单独记录。
- Current-candidate Playwright / 当前候选 Playwright：pending; not recorded as passed / 待执行或待验收，不记为通过
- Production / 生产：verified v0.4 remains untouched; no v0.6 cutover or production mutation has started / 已验证的 v0.4 保持原样，尚未开始 v0.6 切换或生产变更

### Incremental Delivery Cadence / 单功能增量发布节奏

Each completed feature slice runs only the affected unit/API/contract tests, syntax or migration checks, a focused secret scan, and one independent review. After a verified backup, it is deployed immediately and must pass production health, login, and core-path smoke checks. Full non-browser regression, Playwright, and the complete reviewer matrix run at phase closeout, a scheduled release window, or whenever the change crosses authentication, authorization, migration, shared-infrastructure, or similarly broad risk boundaries. HIGH/CRITICAL findings, backup/rollback readiness, migration safety, and production smoke remain hard blockers. / 每个功能完成后仅执行受影响的单元/API/合同测试、语法或迁移检查、聚焦敏感信息扫描和一次独立审查；完成可校验备份后立即上线，并执行生产健康、登录和核心路径冒烟。完整非浏览器回归、Playwright 与完整审查矩阵改在阶段收口、计划发布窗口或认证、权限、迁移、共享基础设施等跨模块高风险变更时执行。HIGH/CRITICAL、备份/回滚、迁移安全和生产冒烟仍是硬阻断项。

## Frozen Client Contract / 冻结前端契约

The v0.6.0 guarded workflow prepares the CRM sales workspace on top of the approved product shell while keeping the frozen PPT bytes exact. Production remains on v0.4 until every local, independent, backup, deployment, and remote acceptance gate passes. / v0.6.0 受控流程在已批准产品壳层上准备 CRM 销售工作台，并保持冻结 PPT 字节完全不变；所有本地、独立审查、备份、部署和远端验收门禁通过前，生产继续运行 v0.4。

```text
App build: 20260811-v060-crm-sales-workspace
App cache key: app.js?v=20260811v060crmsalesworkspace
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
- `/client/core/csp_compat.js`
- `/client/core/shell.js`
- `/client/features/ppt_preview_runtime.js`
- `/client/styles/tokens.css`
- `/client/styles/components.css`
- `/client/styles/layout.css`

Every other `/client/*` path and private source path such as `/server/server.js` must return `404` through both Express and Nginx. / 其他 `/client/*` 以及 `/server/server.js` 等私有源码路径必须在 Express 与 Nginx 两层均返回 `404`。

## Parser Runtime Appliance / 解析器运行时设备

The current candidate builds the knowledge, influencer, and demand-file upload parser as an independent, sealed runtime. The appliance is not installed until guarded cutover, and its presence in this checkout is not production evidence. / 当前候选将知识库、网红和需求文件上传解析器构建为独立密封运行时；设备只会在受控切换中安装，其存在于当前工作区不构成生产证据。

### Exact Node Dependency Closure / 精确 Node 依赖闭包

The appliance uses `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`. `platform/server/parser-runtime/package-lock.json` has SHA-256 `e1d6e5ababef1fb6f0aa69363be328e4da42283c96e268378c2f83076722fc46` and defines this complete closure: / 设备使用上述 `npm ci` 参数；锁文件哈希如前，并定义以下完整闭包：

| Package / 包 | Exact version / 精确版本 |
|---|---:|
| `read-excel-file` | `9.2.0` |
| `@xmldom/xmldom` | `0.9.11` |
| `fflate` | `0.8.3` |
| `unzipper-esm` | `0.13.3` |
| `graceful-fs` | `4.2.11` |
| `node-int64` | `0.4.0` |

### Exact Python Dependency Closure / 精确 Python 依赖闭包

`platform/server/parser-runtime/requirements.lock` has SHA-256 `22f72070ee7c62b428261b64435fbb0b24d87f0aaa7a4d0ac0d8e7a45bfb44df`. Every entry carries its package SHA-256. Installation requires `--require-hashes --only-binary=:all: --no-compile --no-deps`. / 锁文件哈希如前，每个条目都包含包级 SHA-256；安装只接受上述严格参数。

| Package / 包 | Exact version / 精确版本 | Package / 包 | Exact version / 精确版本 |
|---|---:|---|---:|
| `certifi` | `2026.7.22` | `charset-normalizer` | `3.5.0` |
| `colorlog` | `6.12.0` | `flatbuffers` | `25.12.19` |
| `idna` | `3.18` | `numpy` | `2.5.2` |
| `omegaconf` | `2.4.0.dev13` | `onnxruntime` | `1.28.0` |
| `opencv-python` | `5.0.0.93` | `packaging` | `26.3` |
| `pillow` | `12.3.0` | `protobuf` | `7.35.1` |
| `pyclipper` | `1.4.0` | `PyMuPDF` | `1.27.2.3` |
| `pypdf` | `6.14.2` | `PyYAML` | `6.0.3` |
| `rapidocr` | `3.9.2` | `requests` | `2.34.2` |
| `shapely` | `2.1.2` | `six` | `1.17.0` |
| `tqdm` | `4.70.0` | `typing_extensions` | `4.16.0` |
| `urllib3` | `2.7.0` |  |  |

### Disposable Unprivileged Build And Root-Owned Lifecycle / 一次性非特权构建与 Root 生命周期

Dependency acquisition and build execution run only in disposable, unprivileged systemd units with bounded network access, no production mounts, no inherited credentials, and a drained cgroup before sealing. Required systemd bind/tmpfs targets stay `0755` only during placeholder creation; root's sealing pass restores the pinned final directory and file modes before hashing. Root owns inaccessible lifecycle paths and independently verifies, seals, snapshots, installs, accepts, and rolls back the resulting runtime; root never executes candidate dependency or build tooling. / 依赖获取与构建仅在一次性非特权 systemd 单元中执行，网络访问受限，不挂载生产路径、不继承凭据，并在密封前清空 cgroup。systemd 必需挂载目标仅在创建占位文件期间保持 `0755`，Root 密封阶段会在哈希前恢复固定最终权限。Root 只负责不可访问的生命周期路径，并独立完成验证、密封、快照、安装、验收与回滚；Root 不执行候选依赖或构建工具。

The sealed runtime is fixed at 3,476 files, 435 directories, 640,592,018 bytes, with SHA-256 `20b5f5186ec26b726d07659566071c0ce6b367138497f772d57830734f5d4418`. It contains no symlinks or Python bytecode caches and is installed at `/var/lib/turingmarket-parser/runtime-root`. / 密封运行时的文件、目录、字节数与哈希如前，不包含软链接或 Python 字节码缓存，并安装到上述路径。

Each job runs as the locked, no-login `turingmarket-parser` account in `turingmarket-parser@.service`. The unit uses `RootDirectory=/var/lib/turingmarket-parser/runtime-root`, private network/PID/IPC/user/mount namespaces, no capabilities, denied socket and selected syscall families, a read-only root, writable `/scratch` plus `/output/result.json` only, and per-job CPU, memory, task, file, and time limits. `turingmarket-parser.slice` applies aggregate limits. / 每个任务以锁定且禁止登录的解析器账号运行于模板 unit 中，并使用 chroot、私有命名空间、空 capability、socket 与系统调用限制、只读根目录、限定写路径及单任务和 slice 聚合资源上限。

The disposable unprivileged build unit initializes the real RapidOCR engine against the staged dependency tree before root independently seals and hashes it. Release tests run the raster-image `--self-test-image` contract for the RapidOCR 3 object result and the legacy tuple result. Provisioning and acceptance then run all 21 self-tests inside `RootDirectory`, including XLSX, PPTX, OCR inference, identity, mount, syscall, network, socket, PID, write-boundary, and resource-pressure checks. / 一次性非特权构建单元先针对暂存依赖树初始化真实 RapidOCR，再由 Root 独立密封并计算哈希；发布测试使用栅格图像覆盖 RapidOCR 3 对象结果与旧 tuple 结果，安装和验收随后在 `RootDirectory` 内执行包含 XLSX、PPTX、OCR 推理及隔离边界在内的 21 项自检。

## External State Targets / 外置状态目标

v0.6 has five application external-state targets. The first four remain exact root-owned symlinks in both the live and candidate trees. The fifth is a direct root-only directory referenced through `PPT_CACHE_DIR`; do not create a release-tree symlink for it. / v0.6 有五个应用外置状态目标；前四个仍是活动树和候选树中的精确 root 所有软链接，第五个由 `PPT_CACHE_DIR` 直接引用 root-only 目录，不得为其创建发布树软链接。

| Release path or setting / 发布路径或设置 | External target / 外置目标 | Required shape / 形态 |
|---|---|---|
| `.env` | `/etc/turingmarket/turingmarket.env` | Exact root-owned symlink / 精确 root 所有软链接 |
| `server/db` | `/var/lib/turingmarket/db` | Exact root-owned symlink / 精确 root 所有软链接 |
| `uploads` | `/var/lib/turingmarket/uploads` | Exact root-owned symlink / 精确 root 所有软链接 |
| `tmp` | `/var/lib/turingmarket/tmp` | Exact root-owned symlink / 精确 root 所有软链接 |
| `PPT_CACHE_DIR` | `/var/lib/turingmarket/ppt-cache` | Direct `root:root 0700` directory / 直接 `root:root 0700` 目录 |

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

Verify runtime, exact links, SQLite, and marker evidence before ACK. The gate checks the PM2 PID and loopback health response, all four exact bootstrap-managed external-state links and their targets, external runtime ownership and shape, SQLite `quick_check`, and the permanent marker proof. The fifth v0.6 state target, `/var/lib/turingmarket/ppt-cache`, is not a bootstrap link; the guarded v0.6 workflow validates its direct-directory state later. / ACK 前必须校验 runtime、精确 links、SQLite 与 marker 证据。门禁会检查 PM2 PID 与回环健康响应、四个由 bootstrap 管理的外置状态软链接及其精确目标、外置运行时的所有权与结构、SQLite `quick_check` 以及永久 marker 证明。第五个 v0.6 状态目标 `/var/lib/turingmarket/ppt-cache` 不是 bootstrap 软链接，由 v0.6 受控流程在后续验证其直接目录状态。

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

The expected acknowledgement is `BOOTSTRAP_TERMINAL_ACKNOWLEDGED=<id>`, where `<id>` exactly equals `TERMINAL_ID`. A successful ACK atomically archives `active` as `.terminal-consumed.<sha256>`, so `/var/lib/turingmarket-bootstrap/active` is absent before deployment while the immutable evidence remains discoverable by terminal ID. Repeating ACK with the same ID is idempotent; a wrong or stale ID fails closed. Never edit or delete journal files to bypass a rejected ACK. / 期望输出为 `BOOTSTRAP_TERMINAL_ACKNOWLEDGED=<id>`，其中 `<id>` 必须与 `TERMINAL_ID` 完全一致。ACK 成功后会把 `active` 原子归档为 `.terminal-consumed.<sha256>`，因此部署前 `/var/lib/turingmarket-bootstrap/active` 必须不存在，同时不可变证据仍可通过 terminal ID 查询。同一 ID 重复 ACK 为幂等，错误或过期 ID 均失败关闭。ACK 被拒绝时绝不允许通过编辑或删除 journal 文件绕过校验。

#### Capacity and recovery rules / 容量与恢复规则

- Full capacity still allows the matching pending ACK in place through its terminal-only reservation; it does not need or allocate a new journal directory. / journal 满容量时，匹配的 pending ACK 仍原位允许，并使用 terminal-only 预留通道；它不需要也不会分配新的 journal 目录。
- `existing-live` recovery may recover only the validated live generation in place; it must not start a new generation. If that recovery cannot reach a proven terminal state, it fails closed and retains the live evidence. / `existing-live` 恢复只允许原位恢复已验证的 live generation；不得启动新代次。若无法到达可证明的终态，则失败关闭并保留 live 证据。
- Unknown, uncertain, or repair evidence must not delete the journal. Preserve the journal and host state, stop online mutation, and move to offline maintenance or rollback with an independently reviewed evidence set. / 遇到 unknown、uncertain 或 repair evidence 时不得删除 journal；必须保留 journal 与主机状态，停止在线 mutation，并携带经独立复核的证据转入离线维护或回滚。

The resulting mutable paths managed by the bootstrap are `/etc/turingmarket/turingmarket.env`, `/var/lib/turingmarket/db`, `/var/lib/turingmarket/uploads`, and `/var/lib/turingmarket/tmp`; the active release contains only exact root-owned symlinks to them. v0.6 adds `/var/lib/turingmarket/ppt-cache` as the fifth application state target through a direct root-owned directory. Root-owned PM2 remains the production process manager in this phase. / bootstrap 管理的可变路径固定为前述四处，活动版本中仅保留指向它们的精确 root 所有软链接；v0.6 另以直接 root 所有目录增加 `/var/lib/turingmarket/ppt-cache` 作为第五个应用状态目标。本阶段生产进程仍由 root PM2 管理。

`-ValidateLocalOnly` is a local-only mode and performs zero remote operations. It cannot be combined with rollback or destructive-restore controls. Supplying `-RollbackBackup` explicitly with an empty, blank, malformed, or unsupported value is rejected locally and never falls through to deployment. / `-ValidateLocalOnly` 是零远端操作的纯本地模式，禁止与回滚或破坏性恢复参数组合使用；显式传入空值、空白、格式错误或不受支持的回滚编号时会在本地拒绝，绝不会回落到正式部署。

Phase 4 always invalidates all existing sessions before PM2 starts. `-PreserveSessions` is retained only as a rejected compatibility parameter and cannot be used for deploy or restore. / 第 4 阶段始终在 PM2 启动前撤销全部现有会话；`-PreserveSessions` 仅作为会被拒绝的兼容参数保留，发布和恢复均不得使用。

The Windows PowerShell 5.1 transport writes UTF-8 without BOM and normalizes CRLF or CR input to LF before sending any script to remote Bash. The local preflight executes this exact CRLF-to-LF check. / Windows PowerShell 5.1 传输层会使用无 BOM UTF-8，并在发送远端 Bash 前将 CRLF 或 CR 统一为 LF；本地预检会执行同一项转换自测。

Cleanup-control install, backup, replay, start, and convergence validate PID 1 through fixed `/usr/bin/systemctl show`: the effective fragment must be the exact `/etc` unit, aliases are forbidden, and `DropInPaths` must be empty except for the exact replay barrier while restoration is incomplete. All systemd search roots and every existing journal/barrier/helper/unit/link parent are checked before mutation. / 清理控制面的安装、备份、回放、启动与收敛均校验 PID 1 的实际 fragment、alias、drop-in、全部 systemd 搜索根及控制路径父链。

The public watchdog has no shorter runtime cap than its operation-specific deadline: 120 seconds for initial cutover, and 7,200 seconds for accepted finalization plus rollback/resume. Its durable armed state binds unit/controller/start/deadline identity, and every public symlink swap plus disarm requires the exact transient service to remain loaded, active, and running. / 公网 watchdog 使用操作专属 deadline：初始切换 120 秒，接受态 finalization 与回滚/恢复 7,200 秒；每次公网链接切换和解除守卫前都必须重新验证精确 transient identity 仍处于 active/running。

The script performs these gates in order / 脚本按以下顺序执行：

1. Verify the authoritative checkout, release branch, clean tracked state, build markers, cache keys, complete inventory, and frozen PPT hash. / 校验权威工作区、发布分支、干净 tracked 状态、构建标记、缓存键、完整清单及冻结 PPT 哈希。
2. Acquire the fail-closed lifecycle lock at `/root/turingmarket/.deploy-v030.lock`, install and verify trusted release helpers, and validate the existing external runtime plus loopback boundary. Production mutation later requires the stable global writer mutex as well. / 获取失败关闭的生命周期锁，安装并验签可信发布 helper，校验既有外置运行时与回环边界；后续生产变更还必须取得稳定的全局 writer 互斥。
3. Upload all runtime, browser, test, documentation, and evidence files only to `/var/lib/turingmarket-gate/releases/v060-crm-sales-workspace-<timestamp>`, then persist and verify the immutable upload manifest. Build the exact parser runtime in the root-only lifecycle appliance, initialize RapidOCR in the unprivileged build unit against the staged dependency tree, and bind the resulting tree identity to the release manifest. After installation, run the 21 self-tests inside `RootDirectory`, including XLSX, PPTX, and OCR inference. / 只向外置候选目录上传运行时、浏览器、测试、文档和证据文件，并持久化、验签不可变上传清单；随后在 root-only 生命周期设备中构建精确解析器运行时，由非特权构建单元针对暂存依赖树初始化 RapidOCR，并将运行时树身份绑定到发布清单。安装后在 `RootDirectory` 内执行包含 XLSX、PPTX 与 OCR 推理在内的 21 项自检。
4. Create `/root/turingmarket/backups/v060-crm-sales-workspace-<timestamp>` with present/absent manifests, both dependency trees, a consistent `better-sqlite3` database copy, the direct root-only `PPT_CACHE_DIR=/var/lib/turingmarket/ppt-cache` tree or its absent marker, Nginx configuration, accepted-marker state, and nested plus aggregate SHA-256 manifests. The backup path must not already exist. / 建立 v0.6 外置版本化备份，包含 present/absent 清单、两棵依赖树、一致数据库副本、直接 root-only PPT 缓存或 absent 标记、Nginx、验收标记状态及分层与聚合哈希；同名路径存在时失败关闭。
5. Rebuild a non-secret fixture from the checksummed production schema, run the candidate migration twice in the bounded `turingmarket-gate` systemd service, and verify preservation and idempotence from trusted active code. All dependency and test writes are confined to a verified tmpfs capped at 6,442,450,944 bytes and 262,144 inodes. Before copying dependency trees into the candidate, reject hard links, special files, and extended attributes; measure every inode with `lstat`, round its size up to the destination filesystem block size, cross-check the inode count, and use at least the full tmpfs byte/inode caps plus reserve as the destination capacity requirement. A failed copy removes only the two exact candidate dependency paths. Teardown, interrupted takeover, and candidate cleanup must drain the gate identity, reject unknown nested mounts, verify the one permitted mount is `tmpfs`, unmount it, and prove it is gone before quarantine or deletion. Run the complete Node, Playwright, and Nginx candidate gates under the unprivileged gate, remove all gate processes, recheck uploaded sources, recreate only the four symlink-based state targets, and seal the candidate tree. The direct PPT cache remains outside this tree. / 从验签生产结构重建非敏感 fixture，在受限门禁 service 中两次执行迁移，并由可信活动代码校验保持性与幂等；依赖和测试写入限制在 6,442,450,944 字节、262,144 inode 的 tmpfs 内；复制依赖前拒绝硬链接、特殊文件与扩展属性，逐 inode 通过 `lstat` 按目标文件系统块大小向上取整并交叉核对 inode 数，以完整 tmpfs 字节/inode 上限加余量作为目标容量最低要求；失败时只清理两个精确依赖路径。正常清理与中断接管都必须排空门禁身份、拒绝未知嵌套挂载、验证唯一允许挂载为 tmpfs，并在隔离或删除前完成卸载证明。随后执行完整 Node、Playwright 和 Nginx 候选门禁并封存候选树；直接 PPT 缓存始终位于候选树外。
6. Acquire the writer mutex, recheck lifecycle ownership and the sealed candidate digest, then run the exact per-device cutover capacity planner. The planner must emit `CUTOVER_CAPACITY_OK` before `mutation-intent`, maintenance, or any production mutation. / 获取 writer 互斥，复核生命周期 owner 与密封候选摘要，再执行按设备计算的精确切换容量规划；必须在 `mutation-intent`、维护或任何生产变更前输出 `CUTOVER_CAPACITY_OK`。
7. Record `mutation-intent`, enter all-traffic maintenance, drain parser admissions/spool/units/cgroup, stop and quiesce PM2 plus SQLite, and drain the parser a second time. Only then prepare the first-install PPT cache, create one verified database/PPT/parser cutover snapshot, stage Nginx, exchange the release tree, install the parser appliance, invalidate sessions, and start the candidate on loopback. / 记录变更意图并进入全流量维护，排空解析器 admission/spool/unit/cgroup，停止并静默 PM2 与 SQLite，再次排空解析器；之后才准备首次安装 PPT 缓存，建立数据库/PPT/解析器同一验签切换快照，stage Nginx、交换发布树、安装解析器、撤销会话并在回环启动候选。
8. Require parser-aware `/api/health`, loopback routes, the exact public allowlist, private-path denial, Nginx behavior, and one-request replay. Before any public symlink switch, the trusted `public_release_guard.sh` must persist `armed`, install the Nginx `ExecStartPre` barrier, and start an independent systemd watchdog bound to the controller identity and deadline. Persist root-only parser self-test and acceptance-facts evidence, bind their SHA-256 values and the installed runtime-tree SHA-256 into schema 3 acceptance evidence, recheck that binding, and only then write `verified`, stop the watchdog, remove the barrier, and restore public traffic. / 要求解析器感知健康、回环路由、精确公开白名单、私有路径拒绝、Nginx 行为与单请求重放；任何公开软链接切换前，可信 `public_release_guard.sh` 必须先持久化 `armed`、安装 Nginx `ExecStartPre` 启动屏障，并启动绑定控制器身份与截止时间的独立 systemd 守护器；持久化并绑定全部验收证据后，只有重新核验成功才允许写入 `verified`、停止守护器、移除屏障并恢复公开流量。
9. A candidate-validation or capacity failure removes only the candidate and leaves active PM2 untouched. A confirmed post-mutation failure restores the parser appliance before code and process state, then restores dependencies, repository evidence, Nginx, SQLite, and PPT cache origin and invalidates sessions through the coupled fail-closed restore path. Controller loss, HUP/TERM/KILL, or a failed public verification must make the independent guard restore the maintenance gate; if validation, reload, or the 503 probes fail, it stops and kills Nginx and proves that port 80 has no listener before persisting `closed`. / 候选验证或容量失败只清理候选目录，不触碰活动 PM2；确认生产变更后的失败会先恢复解析器设备，再恢复代码和进程状态，并通过耦合的失败关闭路径恢复依赖、仓库证据、Nginx、SQLite 与 PPT 缓存起源，同时撤销会话；控制器丢失、HUP/TERM/KILL 或公开验证失败时，独立守护器必须恢复维护门禁，若配置校验、reload 或 503 探测失败，则停止并强杀 Nginx，证明 80 端口无监听后才持久化 `closed`。

### Cutover Capacity And First-Install Cache / 切换容量与首次安装缓存

The capacity report groups targets by filesystem device. It accounts for the database and PPT cache in the cutover backup, the existing parser runtime snapshot, the staged parser installation, database and PPT rollback staging, and positive `node_modules` growth. Each device must have the calculated requirement plus `max(10%, 512 MiB)` available. The deployment prints the stable `tm-cutover-capacity-v1` JSON report followed by `CUTOVER_CAPACITY_OK`; retain both in release evidence. / 容量报告按文件系统设备汇总，并计入切换备份中的数据库与 PPT 缓存、既有解析器快照、待装解析器、数据库与 PPT 回滚 staging，以及正向 `node_modules` 增量。每个设备都必须具备计算需求加 `max(10%, 512 MiB)` 的可用空间。发布会输出稳定的容量 JSON 和成功标记，两者都必须进入发布证据。

The initial backup records exactly one of `ppt-cache.present` or `ppt-cache.absent`. If absent, cutover must still see no path after writers stop; it then creates an empty `root:root 0700` directory and syncs it before the cutover snapshot. Pre-mutation recovery removes this first-install directory only if it remains empty. Rollback restores an absent origin only when the verified restored cache is empty; otherwise it fails closed rather than deleting artifacts. / 初始备份只记录 `ppt-cache.present` 或 `ppt-cache.absent` 之一。若为 absent，停写后切换仍必须确认路径不存在，随后创建并同步空的 `root:root 0700` 目录再建立切换快照。预变更恢复仅在该首次安装目录仍为空时删除；回滚也只在已验签恢复缓存为空时恢复 absent 起源，否则失败关闭而不删除产物。

### Parser-Aware Health And Acceptance / 解析器感知健康与验收

The application does not finish startup until parser readiness and the production self-tests pass. `/api/health` must return `status: "ok"`, `parser.ready: true`, and `parser.manifest_sha256: "44db310046efe65bd68c110313b4887995c73e276e7d58f65fe037c09a973c5b"`. A `200` response without those exact parser fields is not healthy for v0.6. / 应用只有在解析器 readiness 与生产自检通过后才完成启动。健康接口必须返回上述精确状态与清单哈希；缺少这些解析器字段的 `200` 对 v0.6 不构成健康。

Acceptance writes root-only parser and acceptance-facts evidence, hashes both, and combines those digests with the installed runtime-tree digest in `accepted-<run-id>.json` and `current-accepted.json` schema 3 records. The finalizer and public-traffic activation re-inspect the installed root-owned tree and reject legacy or mismatched markers. / 验收以 root-only 形式写入解析器与验收事实证据，计算两者哈希，并与已安装运行时树哈希共同写入 schema 3 的代次验收记录和当前验收记录；finalizer 与公开流量激活会重新检查已安装 root-owned 树，并拒绝旧版或不匹配标记。

The current lifecycle moves from `locked` directly to writer-protected `mutation-intent`, `mutation-started`, and `cutover-complete`; `candidate-ready` is accepted only for recovery compatibility with an older interrupted run and is never written independently. Before any production mutation, the active cutover or recovery process must also own the stable global atomic writer mutex at `/root/turingmarket/.deploy-v030.writer` and recheck the lifecycle owner after acquiring it. This prevents SSH-disconnect overlap, delayed cutover entry into a replacement lock generation, and stale phase writes. A transport failure before mutation cleans only the candidate; confirmed `mutation-started` runs restore; `mutation-intent`, an unreadable phase, an active/stale writer mutex, or uncertain recovery retains the locks without another automatic production action. Treat retained locks as incident markers: confirm that no deployment, rollback, or remote cutover process is active, inspect production and backup state, and only then remove stale `.deploy-v030.lock` and `.deploy-v030.writer` paths. / 当前生命周期从 `locked` 直接进入受 writer 保护的 `mutation-intent`、`mutation-started` 和 `cutover-complete`；`candidate-ready` 仅用于兼容历史中断恢复，不再独立写入。任何生产变更前，切换或恢复进程还必须持有稳定的全局原子互斥 `/root/turingmarket/.deploy-v030.writer`，并在获取后重新校验生命周期 owner，从而阻止 SSH 中断并发、延迟进程跨锁代际写入和旧阶段覆盖。变更意图、阶段不可读、writer 活动或残留、恢复不确定时均停止自动生产操作并保留锁；必须确认没有活动发布、回滚或远端切换进程，并检查生产与备份状态后，才能清理残留的 lifecycle 与 writer 路径。

The remote full Node gate is equivalent to / 远端完整 Node 门禁等价于：

Production route smoke covers `/api/health`, `/m0`, `/m0-detail`, `/m4`, and `/admin` before the release is accepted. Local release-focused evidence does not replace this full remote gate or the pending Playwright gate. / 正式验收前，生产路由冒烟覆盖上述健康与页面路径；本地发布聚焦证据不替代该完整远端门禁或待完成的 Playwright 门禁。

```bash
cd server
NODE_ENV=test TM_DISABLE_DOTENV=1 DB_PATH=/var/lib/turingmarket-gate/releases/<release>/tmp/deploy-v060-gate-<timestamp>/test.db node --test --test-concurrency=1 tests/*.test.js
```

## Parser Diagnostics / 解析器诊断

Start with read-only health and unit inspection. The health check must validate the parser fields, not only HTTP 200. / 先执行只读健康与 unit 检查；健康检查必须校验解析器字段，不能只看 HTTP 200。

```bash
set -euo pipefail
curl --fail --silent --show-error http://127.0.0.1:3002/api/health |
  node -e '
let body = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { body += chunk; });
process.stdin.on("end", () => {
  const health = JSON.parse(body);
  const expected = "44db310046efe65bd68c110313b4887995c73e276e7d58f65fe037c09a973c5b";
  if (health.status !== "ok" || !health.parser || health.parser.ready !== true ||
      health.parser.manifest_sha256 !== expected) process.exit(1);
  process.stdout.write("PARSER_HEALTH_OK\n");
});
'
systemctl list-units --all 'turingmarket-parser@*.service'
systemctl show turingmarket-parser.slice \
  --property=LoadState,ActiveState,ControlGroup,MemoryCurrent,TasksCurrent
```

Check the installed appliance identity and spool without following links. Expected runtime identity is 3,476 files, 435 directories, 640,592,018 bytes, SHA-256 `20b5f5186ec26b726d07659566071c0ce6b367138497f772d57830734f5d4418`; the jobs directory must be empty outside active admissions. / 不跟随软链接检查已安装设备身份与 spool；预期运行时身份如前，非活动 admission 期间 jobs 目录必须为空。

```bash
set -euo pipefail
cd /root/turingmarket/platform/server
TM_RUNTIME_ROOT=/var/lib/turingmarket-parser/runtime-root \
  node - <<'NODE'
const service = require('./services/upload_sandbox_service');
service.inspectParserRuntimeTree(process.env.TM_RUNTIME_ROOT, { requireRootOwnership: true })
  .then(value => process.stdout.write(`${JSON.stringify(value)}\n`))
  .catch(() => { process.exitCode = 1; });
NODE
test -d /var/lib/turingmarket-parser/jobs
test ! -L /var/lib/turingmarket-parser/jobs
if find /var/lib/turingmarket-parser/jobs -mindepth 1 -print -quit | grep -q .; then
  printf '%s\n' 'Parser spool is not empty' >&2
  exit 1
fi
```

Run the complete self-test only as root in a controlled maintenance or diagnostic window. It creates disposable parser units and executes XLSX, PPTX, OCR inference, memory, CPU, task, scratch, and output-pressure probes. The normal command emits only the 21-key JSON result or a generic failure. Keep diagnostic output in root-only incident evidence and redact it before sharing. / 仅在受控维护或诊断窗口以 root 运行完整自检；它会创建一次性解析 unit 并执行 XLSX、PPTX、OCR 推理、内存、CPU、任务、scratch 与输出压力探针。普通命令只输出 21 项 JSON 或通用失败。诊断输出应保存在 root-only 事件证据中，对外分享前脱敏。

```bash
set -euo pipefail
cd /root/turingmarket/platform/server
export TM_UPLOAD_SANDBOX_MANIFEST_PATH="$PWD/systemd/turingmarket-parser.manifest.json"
export TM_UPLOAD_SANDBOX_SERVER_ROOT="$PWD"
/usr/local/libexec/turingmarket/upload_sandbox_self_test --json
```

If the normal command fails, rerun once in diagnostic mode without `set -x`. Do not run this verbose form after a success. / 普通命令失败时，在不开启 `set -x` 的前提下以诊断模式重跑一次；普通命令成功后不要运行该详细形式。

```bash
cd /root/turingmarket/platform/server
export TM_UPLOAD_SANDBOX_MANIFEST_PATH="$PWD/systemd/turingmarket-parser.manifest.json"
export TM_UPLOAD_SANDBOX_SERVER_ROOT="$PWD"
TM_UPLOAD_SANDBOX_DIAGNOSTIC=1 \
  /usr/local/libexec/turingmarket/upload_sandbox_self_test --diagnose
```

Interpret failures by stage / 按 stage 判断失败：

- `verify:*`: source, manifest, installed tree, systemd property, or identity drift / 源码、清单、安装树、systemd 属性或身份漂移
- `probe:*`: an isolation boundary or resource-pressure contract failed / 隔离边界或资源压力合同失败
- Health ready false with no diagnostic stage: startup self-tests or admission recovery did not complete; inspect the root-only PM2 output and retained deployment evidence before restarting / 健康 ready 为 false 且无 diagnostic stage 时，启动自检或 admission 恢复未完成；重启前检查 root-only PM2 输出与保留的发布证据
- Non-empty spool or running parser units during cutover: do not delete job state; keep maintenance active and investigate admissions, units, and cgroups / 切换时 spool 非空或仍有运行 unit 时不得删除任务状态；保持维护并调查 admission、unit 与 cgroup

## Rollback / 回滚

Use only a backup created by this release / 只允许使用本版本生成的备份：

```powershell
.\platform\deploy_v8.ps1 -RollbackBackup backups/v060-crm-sales-workspace-<timestamp> -RestoreDatabase -ConfirmDataLoss
```

`-RollbackBackup` requires both `-RestoreDatabase` and `-ConfirmDataLoss`; code-only Phase 4 rollback, omitted consent, and every use of `-PreserveSessions` are rejected before server lookup or lock acquisition. A valid request acquires lifecycle and writer ownership, verifies every manifest, stops PM2, restores the parser appliance before code and process state, restores both dependency trees, repository evidence, Nginx, SQLite, and `PPT_CACHE_DIR`, invalidates all sessions, then restarts `turingmarket` with `SERVER_HOST=127.0.0.1` and verifies parser-aware `/api/health`. Rollback public activation uses the same trusted watchdog, persistent start barrier, and stop-Nginx/no-port-80 fallback as initial cutover. `-MaintenanceTimeoutSeconds` is bounded to 15-300 seconds and defaults to 60; parser-aware PM2 startup uses a separate 180-second deadline so the 120-second production self-test can finish. / 手工回滚必须同时显式提供数据库恢复与数据丢失确认；禁止仅回滚代码、缺少确认或保留会话。合法请求会先于代码和进程恢复解析器设备，再恢复两棵依赖树、仓库证据、Nginx、SQLite 与 PPT 缓存，撤销全部会话后才重启，并校验解析器感知健康；回滚公开切换与首次切换使用同一可信守护器、持久启动屏障和“停止 Nginx 并证明 80 端口关闭”的兜底。维护超时默认 60 秒；解析器感知的 PM2 启动使用独立 180 秒期限，确保 120 秒生产自检能够完成。

The destructive restore explicitly accepts loss of writes after the selected backup. The database, PPT cache, and parser appliance form one cutover recovery unit, and restored sessions are always deleted before restart. If the original PPT cache was absent, rollback removes the restored cache directory only when the verified tree is empty. / 破坏性恢复明确接受所选备份之后的业务写入丢失；数据库、PPT 缓存与解析器设备构成同一切换恢复单元，恢复出的会话始终在重启前删除。若原始 PPT 缓存不存在，回滚仅在已验签恢复树为空时删除缓存目录。

## Remaining v0.6 Release Gates / v0.6 剩余发布门禁

The parser and cutover controls are implemented in the current candidate. Historical full-regression and review results are retained as phase-closeout evidence, not as proof for the latest bytes. Under the incremental cadence, this feature slice remains blocked only until its exact focused tests and independent review pass, the authoritative checkout and GitHub commit are synchronized, a verified backup and capacity record exist, and guarded deployment plus production health/login/core-path/rollback acceptance succeed. Browser and full-matrix gates run at phase closeout or when the risk boundary requires them. Production v0.4 remains untouched. / 当前候选已实现解析器与切换控制；历史完整回归和审查结果只作为阶段收口证据，不代表最新字节。按增量发布节奏，本功能切片只需完成最终定向测试与独立审查、权威工作区和 GitHub 同步、可校验备份与容量记录、受控部署及生产健康/登录/核心路径/回滚验收即可上线；浏览器和完整矩阵门禁在阶段收口或风险边界要求时执行。生产 v0.4 保持原样。

## Release Evidence / 发布证据

For every feature slice, record the commit and remote SHA, exact focused test counts, independent-review verdict, versioned backup path and aggregate SHA-256, capacity result, guarded deployment transitions, production health/login/core-path smoke, PM2 and Nginx state, access checks, rollback readiness, and final session count. Add full regression and Playwright evidence only when the phase-closeout or risk-trigger rule requires those gates. Do not mark the slice released until all gates applicable to that slice are present and reviewed. Keep real credentials only in protected server-side storage. / 每个功能切片记录提交与远端 SHA、精确定向测试计数、独立审查结论、版本化备份路径与聚合哈希、容量结果、受控部署状态转换、生产健康/登录/核心路径冒烟、PM2 与 Nginx 状态、权限检查、回滚就绪性和最终会话数。仅在阶段收口或风险触发规则要求时补充完整回归与 Playwright 证据；适用于该切片的门禁齐备并复核前不得标记上线，真实凭据只保存在受保护的服务端存储中。

Credential rotation payloads remain outside Git at `D:\主盘\图灵集市\图灵商务平台开发\99-private\rotation-payload-v0.2.10.private.json`. From `platform/server`, pass the protected UTF-8 payload through standard input only: / 凭据轮换载荷固定保存在 Git 之外，并且只通过标准输入执行：

```powershell
$payloadPath = 'D:\主盘\图灵集市\图灵商务平台开发\99-private\rotation-payload-v0.2.10.private.json'
Get-Content -Raw -Encoding UTF8 -LiteralPath $payloadPath | node scripts/rotate_user_credentials.js
```

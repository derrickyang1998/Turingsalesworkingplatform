# Changelog - TuringMarket 图灵商务在线工作平台

## v0.6.0-crm-sales-workspace (Release Candidate, 2026-08-11; updated 2026-08-20) - CRM 销售工作台

### CRM 销售工作台 / CRM Sales Workspace
- 将客户看板与客户明细保持为两个独立界面，并把客户、联系人、商机、任务、跟进记录、阶段流转、领取/释放、公海、团队与个人作用域接入统一的组织权限模型。
- 增加组织安全的客户与商机详情读取、受治理的阶段/结案原因、无硬删除的生命周期、失败写入草稿保留、精确商机详情编辑，以及管理员组织级与普通用户团队级可见性。
- 跟进结果通过知识库归档；团队成员只能追加 `note`，正式 `strategy`/`proposal` 仍由业务负责人控制。连续跟进采用活动 ID 作为来源身份，保证知识条目和分块不可覆盖。
- 客户更新新增可选 `expected_notes` 原子前置条件；服务层将其绑定到同一条 SQLite `UPDATE`，陈旧写入返回受限的 `CRM_CUSTOMER_CONFLICT` 409。生产 CRM 写入冒烟与恢复均使用该条件，能够拒绝并发覆盖，并在响应超时后按实际读回状态恢复原备注。

### Schema 6 与发布底座 / Schema 6 And Release Foundation
- 新增迁移 `006_crm_sales_workspace`、CRM 查询/命令/作用域/合同服务，并将发布迁移链升级为精确的 `v1 -> v6` 两次恢复验证。
- trusted-source 清单扩展为 47 个 SHA-256 固定文件，覆盖一次性 legacy v0->v1 adoption、迁移 006、CRM 服务、当前受信任运行时、独立公网发布守护器及迁移清理 helper/unit；受信任门禁会先识别精确 legacy v0、在私有可写副本中演练接管，并在生产切换中以 no-clobber 方式发布精确 managed v1，随后执行 v1->v6 双轮验证。sanitization manifest 重建为主 v1 + 隔离 v6 精确配置。
- 发布分支、构建标识、缓存键、候选/备份路径和远端文件清单升级为 `codex/v0.6.0-crm-sales-workspace` / `v060-crm-sales-workspace`，冻结 PPT build、query 与 SHA-256 保持不变。

### 解析器运行时设备 / Parser Runtime Appliance
- 为知识库、网红和需求文件上传增加独立解析器设备。生产构建固定为 Linux `x86_64`、Node.js `v20.20.2` 与 Python `3.14.4`；密封运行时树固定为 4,213 个文件、491 个目录、716,157,800 字节，SHA-256 为 `30fbfca170772f23071d6216eea8a83b86d27aad18c2b22b1a1e0e9ae773d7cd`。
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
- `/api/health` 现在返回 `parser.ready` 与 `parser.manifest_sha256`。候选必须同时满足 `status=ok`、解析器 ready 和 manifest SHA-256 `970b6111a433faae77bd07efbcdcdc608d6c923c563e708c70dd8b62006d6970`；安装后自检、接受事实与运行时树哈希写入 schema 3 验收标记，公开流量恢复前会重新绑定核验。

### 审查与状态 / Review And Status
- 本轮发布包装器使用严格子进程环境白名单、语义化远端证据、可逆 CRM 写入冒烟及强制注销；任何由本轮生产变更引起的必选验收失败会自动使用本轮已验证备份回滚。成功、畸形响应、并发冲突、写入超时、注销失败、回滚后身份失败和自动回滚编排共 7 条动态场景通过，客户服务/HTTP 定向测试 3/3 通过，独立终审为 `APPROVE`。
- S6 已验收检查点的独立 Code Review 为 `APPROVE`，独立 QA 为 `GO`；该检查点最终审查矩阵 342/342、提交前扩展矩阵 373/373，6 个关键 JavaScript 文件语法通过。
- 完整历史 bundle `phase5-v060-90713b23f417-full-source.bundle` 已验签，SHA-256 为 `fd4b925d82056d1eb53a5c65cc67461bc3eadd9ba88f47020ed37343d5dae887`。
- 当前 v0.6 发布候选在 S6 后又补充了跨平台可信哈希、schema 6 已填充 CRM 脱敏回归、概率字段域约束、发布清单修复和上述解析器/切换加固，因此 S6 结论不替代当前功能切片的定向复审；完整回归改在阶段收口、计划发布窗口或跨模块高风险变更时执行。
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
- 当前功能切片父级定向证据：生命周期接管 `31/31`、发布源合同 `44/44`、公网守护关键并发/读取/超时用例 `4/4`，PowerShell AST、守护脚本 Bash 语法、可信哈希一致性、`git diff --check` 与聚焦敏感信息扫描均通过。2026-08-16 Windows 71 文件非浏览器汇总 `1875/1784/0/91` 及早期公网守护结果仅作为历史/阶段收口证据保留；生产匹配 Linux/root 验证在受控部署中执行。
- 开发节奏调整为“单功能实现 -> 定向测试 -> 独立审查 -> 备份 -> 上线 -> 线上健康/登录/核心路径冒烟”。完整非浏览器回归、Playwright 和多角色复审仅在阶段收口、计划发布窗口或改动跨越认证、权限、迁移、共享基础设施等高风险边界时执行；HIGH/CRITICAL、备份/回滚、迁移安全和生产冒烟继续作为硬阻断项。
- 本条目仍是发布候选，不代表线上已切换。生产 v0.4 保持原样且未触碰；当前功能切片须完成最终定向证据、独立审查、干净权威工作区、GitHub 同步、可校验备份、容量门禁、受控部署和远端运行时/API/权限/回滚验收后才能标记发布。

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

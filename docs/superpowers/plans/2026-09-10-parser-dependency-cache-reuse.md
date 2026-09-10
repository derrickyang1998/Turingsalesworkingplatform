# Parser Build Cache and Runtime Refresh Implementation Plan / 解析器构建缓存与运行时刷新实施计划

> **For agentic workers / 面向执行代理：** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. / 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 按任务执行，并使用复选框跟踪进度。

**Goal / 目标：** Reuse root-owned, content-addressed, independently remeasured parser runtime and dependency caches when every trusted input matches, and deliberately refresh the parser runtime after the verified 2026-09-10 Python/glibc security update. / 当全部可信输入一致时复用 root 所有、内容寻址且重新测量的解析器运行时与依赖缓存，并针对已确认的 2026-09-10 Python/glibc 安全更新执行一次明确的解析器运行时刷新。

**Architecture / 架构：** Keep the existing disposable networked fetch unit, nonprivileged offline build unit, trusted verifier, root sealing, staged installation, cutover, and rollback contracts. Before any fetch, first try a complete parser-runtime build cache whose full build evidence and tree are revalidated; on a runtime miss, try the independently verified dependency cache and run the existing offline build. Both caches live below the already build-inaccessible `/var/lib/turingmarket-gate/parser-cache/v1`, quarantine mismatches atomically, and never replace production acceptance or self-tests. / 保留现有一次性联网拉取单元、非特权离线构建、可信校验器、root 密封、暂存安装、切换和回滚合同；拉取前先尝试完整解析器构建缓存并重新验证完整构建证据和树，未命中时再尝试独立校验的依赖缓存并运行原有离线构建；两层缓存均位于构建单元原本不可访问的受控目录下，异常条目原子隔离，且绝不替代生产验收与自检。

**Tech Stack / 技术栈：** PowerShell deployment orchestration, Bash/systemd transient units, Node.js trusted verifier, Python canonical JSON, Node test runner. / PowerShell 发布编排、Bash/systemd 临时单元、Node.js 可信校验器、Python 规范 JSON、Node 测试运行器。

**Spec / 规格：** `docs/superpowers/plans/2026-07-12-turingmarket-platform-roadmap.md`

## Global Constraints / 全局约束

- The authoritative checkout is `C:\Users\29272\Documents\在线商务平台-github-sync`; production delivery remains on `codex/v0.7.0-ai-knowledge-proposal-ppt-loop-production`. / 只使用权威代码库与当前生产交付分支。
- Preserve the frozen proposal PPT SHA-256 `f311a7b33ee28e64c8e19a14bae436101272dd17bf2f4f8c5d181d57dd0e291e`. / 保持冻结 PPT 哈希不变。
- Never expose or persist application, provider, SSH, session, or administrator secrets. / 不得暴露或持久化任何凭据。
- This is a shared deployment-runtime change, so focused parser/release tests, independent review, verified backup, guarded production deployment, and online acceptance are mandatory. / 该变更属于共享发布底层，必须完成定向测试、独立审查、可验证备份、受保护上线与线上验收。
- Both caches are optimizations only. Production startup, staged installation, cutover, rollback, and parser acceptance must not depend on cache availability after `runtime.stage` and `runtime.evidence.json` exist. / 两层缓存只用于提速；生成暂存运行时及构建证据后，启动、安装、切换、回滚和验收不得继续依赖缓存。
- A cache hit is authorized only by exact input equality plus a fresh full-tree measurement; name/path equality alone is never sufficient. / 缓存命中必须同时满足输入完全一致与完整树重新测量，禁止只按名称或路径复用。

---

### Task 1: Lock the cache trust contract in failing tests / 用失败测试锁定缓存信任合同

**Files:**
- Modify: `platform/server/tests/release_v060_contract.test.js`
- Modify: `platform/server/tests/parser_runtime_release.test.js`

**Interfaces:**
- Consumes: `Invoke-RemoteParserCandidatePreparation` from `platform/deploy_v8.ps1`.
- Produces: source-level contracts for runtime-cache reuse, dependency-cache reuse, strict evidence, quarantine/rebuild behavior, and unchanged parser build isolation.

- [x] **Step 1: Add the persistent-cache contract test**

Add one test that extracts `Invoke-RemoteParserCandidatePreparation` and requires all of these exact markers:

```js
assert.match(preparation, /\/var\/lib\/turingmarket-gate\/parser-cache\/v1/);
assert.match(preparation, /tm-parser-runtime-cache-input-v1/);
assert.match(preparation, /tm-parser-dependency-cache-input-v1/);
assert.match(preparation, /tm-parser-dependency-cache-evidence-v1/);
assert.match(preparation, /package_lock_sha256/);
assert.match(preparation, /requirements_lock_sha256/);
assert.match(preparation, /verifier_sha256/);
assert.match(preparation, /manifest_sha256/);
assert.match(preparation, /platform/);
assert.match(preparation, /measure-runtime/);
assert.match(preparation, /PARSER_DEPENDENCY_CACHE_REUSED/);
assert.match(preparation, /PARSER_DEPENDENCY_CACHE_BUILT/);
assert.match(preparation, /PARSER_RUNTIME_CACHE_REUSED/);
assert.match(preparation, /PARSER_RUNTIME_CACHE_BUILT/);
assert.match(preparation, /quarantine/);
```

Also assert that a valid runtime-cache hit creates the existing `runtime.stage`, copies the original complete build evidence, and skips both dependency acquisition and `build_upload_sandbox_runtime.sh`. On a runtime miss, assert that the persistent dependency object is passed read-only to the existing builder and that the networked fetch remains inside the transient `turingmarket-parser-cache-*` unit.

- [x] **Step 2: Add rejection-order assertions**

For each cache layer, require the source order `load evidence -> remeasure object -> compare strict evidence -> announce reuse`; require runtime-cache authorization before dependency-cache preparation; and require mismatch handling to quarantine before a fresh stage is created. Assert that evidence files are `root:root`, mode `0444`, link count `1`, and not symlinks; assert that cache object files are root-owned, single-link regular files on one device, and not group/world writable.

- [x] **Step 3: Run RED verification**

Run:

```powershell
node --test platform/server/tests/release_v060_contract.test.js platform/server/tests/parser_runtime_release.test.js
```

Expected: only the new cache assertions fail because the deployment still rebuilds both the dependency cache and parser runtime for every release.

---

### Task 2: Implement two-level verified reuse and the deliberate runtime refresh / 实现两层可信复用与明确的运行时刷新

**Files:**
- Modify: `platform/deploy_v8.ps1`
- Modify: `platform/server/systemd/turingmarket-parser.manifest.json`
- Modify: `platform/server/scripts/trusted_production_source_manifest.json`
- Modify: `platform/server/server.js`
- Modify: `platform/server/tests/parser_runtime_release.test.js`
- Modify: `platform/server/tests/phase4_server_integration.test.js`
- Modify: `platform/server/tests/release_v060_contract.test.js`
- Modify: `platform/DEPLOY.md`

**Interfaces:**
- Consumes: trusted parser source tree, `trusted_parser_runtime_verifier.js measure-runtime`, the existing cache-fetch systemd unit, and `build_upload_sandbox_runtime.sh --dependency-cache-root`.
- Produces: canonical runtime/dependency cache input JSON, immutable cache entries, and the unchanged staged runtime plus trusted build-evidence contract consumed by cutover.

- [x] **Step 1: Define the persistent cache paths and canonical input**

Inside `Invoke-RemoteParserCandidatePreparation`, use exactly:

```bash
ParserCacheRoot=/var/lib/turingmarket-gate/parser-cache/v1
ParserRuntimeCacheRoot="$ParserCacheRoot/runtime"
ParserDependencyCacheRoot="$ParserCacheRoot/dependencies"
```

Each layer has `entries`, `staging`, and `quarantine` children. Build `tm-parser-runtime-cache-input-v1` from the exact trusted parser manifest SHA-256, verifier SHA-256, trusted runtime-builder SHA-256, expected runtime identity, and canonical parser source-artifact digest. Build `tm-parser-dependency-cache-input-v1` from `package-lock.json`, `requirements.lock`, `pip-cacert.crt`, the trusted verifier, and exact platform facts: `uname -s`, `uname -m`, `dpkg --print-architecture`, Node version/ABI/binary SHA-256, Python version/cache tag/platform/binary SHA-256, npm version, pip version, and the resolved libc SHA-256. Do not include the complete parser manifest in the dependency key because parser code and systemd policy do not change downloaded package bytes. Hash each canonical ASCII JSON to obtain its 64-character key.

- [x] **Step 2: Validate and reuse a complete runtime entry first**

Create only fixed root-owned `0700` control directories below `/var/lib/turingmarket-gate/parser-cache/v1`. Reject symlinks, non-canonical paths, mount crossings, unsafe ancestors, and ambiguous staging/quarantine state. A runtime entry contains exactly `runtime-root`, `runtime.evidence.json`, and canonical `cache.evidence.json`; require exact sealed modes and ownership, remeasure the complete tree, validate the cache-key binding, and strictly validate the existing `tm-parser-runtime-build-evidence-v2` against the current trusted manifest, verifier, expected runtime tree, source-artifact digest, and complete build-boundary property digest. Only then copy the object with reflink support into the existing `ParserRuntimeStage`, copy the original evidence, remeasure both again, generate the existing checksum file, and print `PARSER_RUNTIME_CACHE_REUSED`. This path must not call the network fetch or runtime builder.

- [x] **Step 3: Validate or rebuild the dependency entry on runtime miss**

On a dependency-cache hit, require an exact sealed object directory and `root:root:444:1` evidence file, run the trusted verifier's full `measure-runtime --require-root-ownership true`, and compare strict canonical evidence with this schema:

```json
{
  "format": "tm-parser-dependency-cache-evidence-v1",
  "cache_key": "<64 lowercase hex>",
  "inputs": { "format": "tm-parser-dependency-cache-input-v1" },
  "tree": { "format": "tm-parser-runtime-tree-v1", "sha256": "<64 lowercase hex>", "files": 1, "directories": 1, "bytes": 1 },
  "policy": { "uid": 0, "gid": 0, "directory_mode": "0555", "file_mode": "0444", "file_nlink": 1, "same_device": true }
}
```

The real counts are measured values and all keys must be exact. For an invalid existing entry, atomically move the complete entry into that layer's quarantine directory; never recursively delete an ambiguous entry. Create a release-specific staging entry owned by `turingmarket-gate`, run the existing isolated network fetch unchanged, remove the completion marker, seal the object and staging root to `root:root`, remeasure with the trusted verifier, write canonical evidence, and publish the complete entry with one atomic rename plus parent-directory `fsync`. The exit trap removes only a validated release-specific staging entry. On a later run after process kill or host restart, prove the prior fetch unit is inactive and atomically quarantine any correctly named stale stage; reject unknown names, active units, or target ambiguity without deletion. Print `PARSER_DEPENDENCY_CACHE_REUSED` or `PARSER_DEPENDENCY_CACHE_BUILT` as applicable.

- [x] **Step 4: Preserve the offline builder and publish its verified runtime**

On a runtime miss, pass the verified dependency object through the existing `--dependency-cache-root` argument. Do not change the nonprivileged build unit, its no-network/no-credential properties, runtime evidence schema, parser installation, cutover, or rollback functions. After the builder succeeds and root sealing/remeasurement passes, copy `runtime.stage` plus its exact build evidence into a release-specific runtime-cache staging entry, revalidate the copied entry, atomically publish it, and print `PARSER_RUNTIME_CACHE_BUILT`.

- [x] **Step 5: Deliberately repin the security-patched runtime**

Use the already observed fresh production build identity:

```text
sha256=7c280e80546627a82f29010a160ad1aa720c2ca03b447b0328d610b90b82023c
files=3476
directories=435
bytes=640587874
```

Treat this as an explicit runtime-refresh decision backed by the measured Python/glibc package upgrade and fresh candidate identity, not as automatic acceptance of arbitrary host drift. Update the parser manifest, exact byte assertions, server startup pin, integration-test pin, and bilingual deployment documentation. Recompute the parser manifest SHA-256, write it into `trusted_production_source_manifest.json`, then recompute that manifest SHA-256 and update only the matching trusted-source constants. Use SHA-256 calculations over raw file bytes; do not hand-calculate either digest.

- [x] **Step 6: Run GREEN verification**

Run the two focused Node test files plus deployment hardening tests, syntax-check changed JavaScript and JSON, run `git diff --check`, scan the changed files for credential patterns, and verify the frozen PPT SHA-256 remains exact. The runtime-cache hit contract must prove fetch and build markers are unreachable after a valid hit.

---

### Task 3: Independent review, guarded deployment, and release synchronization / 独立审查、受保护上线与版本同步

**Files:**
- Modify: `CHANGELOG.md`
- Create: `docs/version-records/2026-09-10-v0.8.22-parser-dependency-cache-production.md`
- Create: `archive/versions/2026-09-10-v0.8.22-parser-dependency-cache-production.md`
- Modify: `C:\Users\29272\Documents\在线商务平台\TuringMarket-开发进度.html`
- Create: `D:\主盘\图灵集市\图灵商务平台开发\01-版本归档\2026-09-10-v0.8.22-parser-dependency-cache-production.md`
- Modify: `D:\主盘\图灵集市\图灵商务平台开发\01-版本归档\CHANGELOG.md`

**Interfaces:**
- Consumes: reviewed Task 2 commit and the existing guarded `platform/deploy_v8.ps1` workflow.
- Produces: verified two-level cache miss/build evidence, verified complete runtime-cache reuse on a second no-change candidate, production parser acceptance, rollback proof, and synchronized release records.

- [x] **Step 1: Obtain independent approval**

Give a fresh reviewer the complete diff from the pre-slice base. Block deployment on every Critical or Important finding, fix through the implementer, rerun affected tests, and obtain an explicit clean re-review.

- [x] **Step 2: Create and verify the rollback point**

Run the existing guarded backup path, verify its complete SHA-256 manifest, record the database digest without exposing data, and confirm the current runtime snapshot can be restored before production mutation.

- [x] **Step 3: Deploy the cache miss and patched runtime**

Run `platform/deploy_v8.ps1` from the authoritative clean branch. Require `PARSER_DEPENDENCY_CACHE_BUILT`, `PARSER_RUNTIME_CACHE_BUILT`, the deliberately refreshed runtime identity, parser-aware health, successful acceptance evidence, PM2 online, Nginx active, database integrity, and no unexpected migration.

- [x] **Step 4: Prove the persisted cache is eligible for the next feature release**

To follow the approved one-feature/one-deploy cadence, do not create a redundant second production cutover. After the first guarded deployment, recompute the runtime cache key from the exact live manifest, verifier, builder, source-artifact digest, and runtime projection; require the canonical cache binding and complete build evidence to match, freshly remeasure both the installed and cached trees, and require both staging directories to be empty. Record `PARSER_RUNTIME_CACHE_NEXT_RELEASE_ELIGIBLE`; the next actual feature deployment is the first operational `PARSER_RUNTIME_CACHE_REUSED` proof. / 为遵守已批准的“一功能一上线”节奏，不额外执行无业务价值的第二次生产切换；首次受保护发布后，使用线上精确清单、校验器、构建器、来源摘要和运行时投影重算缓存键，校验规范绑定与完整构建证据，重新测量已安装树和缓存树，并确认两层 staging 为空。记录 `PARSER_RUNTIME_CACHE_NEXT_RELEASE_ELIGIBLE`；下一项真实功能发布将给出首次运行态 `PARSER_RUNTIME_CACHE_REUSED` 证据。

- [x] **Step 5: Synchronize and publish records**

Write one bilingual release record with root cause, cache key/evidence facts, first-run build time, second-run reuse time, runtime identity, backup path, online health, and reviewer verdict. Copy identical record bytes to repository archive and Obsidian, update both changelogs and the progress dashboard, commit, push GitHub, and verify local `HEAD` equals the remote branch head.

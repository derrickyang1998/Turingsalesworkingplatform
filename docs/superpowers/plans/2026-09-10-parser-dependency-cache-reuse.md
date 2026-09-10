# Parser Dependency Cache Reuse Implementation Plan / 解析器依赖缓存复用实施计划

> **For agentic workers / 面向执行代理：** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. / 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 按任务执行，并使用复选框跟踪进度。

**Goal / 目标：** Reuse a root-owned, content-addressed, independently remeasured parser dependency cache when every trusted input and platform fact matches, while repinning the parser runtime produced after the 2026-09-10 Python/glibc security update. / 当全部可信输入与平台事实一致时复用 root 所有、内容寻址且重新测量的解析器依赖缓存，并重新钉住 2026-09-10 Python/glibc 安全更新后生成的解析器运行时。

**Architecture / 架构：** Keep the existing disposable networked fetch unit, nonprivileged offline build unit, trusted verifier, root sealing, cutover, and rollback contracts. Move only the dependency cache from the per-release appliance to `/var/cache/turingmarket-parser-dependencies/v1`, key it from exact lockfile/trust/platform facts, persist strict evidence outside the object tree, and remeasure the complete object before every reuse. A missing or mismatched cache is quarantined inside the controlled cache root and rebuilt before the existing parser build begins. / 保留现有一次性联网拉取单元、非特权离线构建、可信校验器、root 密封、切换和回滚合同；仅把依赖缓存移到持久目录，以锁文件、信任与平台事实生成键，并在每次复用前重新测量完整对象；缓存缺失或不匹配时先在受控目录隔离，再重建并进入原有解析器构建流程。

**Tech Stack / 技术栈：** PowerShell deployment orchestration, Bash/systemd transient units, Node.js trusted verifier, Python canonical JSON, Node test runner. / PowerShell 发布编排、Bash/systemd 临时单元、Node.js 可信校验器、Python 规范 JSON、Node 测试运行器。

**Spec / 规格：** `docs/superpowers/plans/2026-07-12-turingmarket-platform-roadmap.md`

## Global Constraints / 全局约束

- The authoritative checkout is `C:\Users\29272\Documents\在线商务平台-github-sync`; production delivery remains on `codex/v0.7.0-ai-knowledge-proposal-ppt-loop-production`. / 只使用权威代码库与当前生产交付分支。
- Preserve the frozen proposal PPT SHA-256 `f311a7b33ee28e64c8e19a14bae436101272dd17bf2f4f8c5d181d57dd0e291e`. / 保持冻结 PPT 哈希不变。
- Never expose or persist application, provider, SSH, session, or administrator secrets. / 不得暴露或持久化任何凭据。
- This is a shared deployment-runtime change, so focused parser/release tests, independent review, verified backup, guarded production deployment, and online acceptance are mandatory. / 该变更属于共享发布底层，必须完成定向测试、独立审查、可验证备份、受保护上线与线上验收。
- The dependency cache is an optimization only. Production startup, cutover, rollback, and parser acceptance must not depend on cache availability after the runtime is built. / 依赖缓存只用于提速；运行时建成后，启动、切换、回滚和验收不得依赖缓存继续存在。
- A cache hit is authorized only by exact input equality plus a fresh full-tree measurement; name/path equality alone is never sufficient. / 缓存命中必须同时满足输入完全一致与完整树重新测量，禁止只按名称或路径复用。

---

### Task 1: Lock the cache trust contract in failing tests / 用失败测试锁定缓存信任合同

**Files:**
- Modify: `platform/server/tests/release_v060_contract.test.js`
- Modify: `platform/server/tests/parser_runtime_release.test.js`

**Interfaces:**
- Consumes: `Invoke-RemoteParserCandidatePreparation` from `platform/deploy_v8.ps1`.
- Produces: source-level contracts for cache key inputs, strict cache evidence, quarantine/rebuild behavior, and unchanged parser build isolation.

- [ ] **Step 1: Add the persistent-cache contract test**

Add one test that extracts `Invoke-RemoteParserCandidatePreparation` and requires all of these exact markers:

```js
assert.match(preparation, /\/var\/cache\/turingmarket-parser-dependencies\/v1/);
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
assert.match(preparation, /quarantine/);
```

Also assert that the persistent cache object is passed read-only to the existing builder and that the existing networked fetch remains inside the transient `turingmarket-parser-cache-*` unit.

- [ ] **Step 2: Add rejection-order assertions**

Require the source order to be `load evidence -> remeasure object -> compare strict evidence -> announce reuse`, and require mismatch handling to quarantine before a fresh stage is created. Assert that the evidence file is `root:root`, mode `0444`, link count `1`, and not a symlink; assert that cache object files are root-owned and not group/world writable.

- [ ] **Step 3: Run RED verification**

Run:

```powershell
node --test platform/server/tests/release_v060_contract.test.js platform/server/tests/parser_runtime_release.test.js
```

Expected: only the new persistent-cache assertions fail because the deployment still uses `$ParserApplianceRoot/dependency-cache` and has no persistent evidence contract.

---

### Task 2: Implement verified cache reuse and repin the patched runtime / 实现可信缓存复用并重钉补丁后运行时

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
- Produces: one canonical cache input JSON, its SHA-256 key, one immutable object directory, one immutable evidence file, and the unchanged runtime-build evidence contract.

- [ ] **Step 1: Define the persistent cache paths and canonical input**

Inside `Invoke-RemoteParserCandidatePreparation`, use exactly:

```bash
ParserDependencyCacheRoot=/var/cache/turingmarket-parser-dependencies/v1
ParserDependencyCacheObjects="$ParserDependencyCacheRoot/objects"
ParserDependencyCacheEvidenceRoot="$ParserDependencyCacheRoot/evidence"
ParserDependencyCacheStagingRoot="$ParserDependencyCacheRoot/staging"
ParserDependencyCacheQuarantineRoot="$ParserDependencyCacheRoot/quarantine"
```

Build `tm-parser-dependency-cache-input-v1` canonical ASCII JSON from SHA-256 values of `package-lock.json`, `requirements.lock`, `pip-cacert.crt`, the trusted verifier, the trusted parser manifest, plus exact `uname -s`, `uname -m`, `dpkg --print-architecture`, Node version, Python version, Python cache tag, npm version, pip version, and the first `ldd --version` line. Hash the canonical JSON to obtain the 64-character cache key.

- [ ] **Step 2: Validate cache root and hit evidence**

Create only the fixed root-owned `0700` cache directories. Reject symlinks, non-canonical paths, unsafe ancestors, and group/world writable ancestors. On a candidate hit, require an exact `root:root:555` object directory and `root:root:444:1` evidence file, run the trusted verifier's full `measure-runtime --require-root-ownership true`, and compare strict canonical evidence with this schema:

```json
{
  "format": "tm-parser-dependency-cache-evidence-v1",
  "cache_key": "<64 lowercase hex>",
  "inputs": { "format": "tm-parser-dependency-cache-input-v1" },
  "tree": { "format": "tm-parser-runtime-tree-v1", "sha256": "<64 lowercase hex>", "files": 1, "directories": 1, "bytes": 1 }
}
```

The real counts are measured values; all four top-level keys and all input keys must be exact. Only then set `ParserDependencyCache` to the persistent object and print `PARSER_DEPENDENCY_CACHE_REUSED`.

- [ ] **Step 3: Rebuild a missing or mismatched cache**

For an invalid existing entry, atomically move the object and evidence into the fixed quarantine directory with the current release basename; do not recursively delete it. Create a release-specific staging directory owned by `turingmarket-gate`, run the existing isolated network fetch unchanged, remove the completion marker, seal directories to `0555` and files to `0444`, set ownership to `root:root`, remeasure with the trusted verifier, write canonical evidence through `.next` plus `sync`, and atomically publish both object and evidence. The exit trap must kill/collect the transient unit and remove only a validated release-specific staging path.

- [ ] **Step 4: Preserve the offline builder boundary**

Pass the verified persistent object through the existing `--dependency-cache-root` argument. Do not change the nonprivileged build unit, its no-network/no-credential properties, runtime evidence schema, parser installation, cutover, or rollback functions.

- [ ] **Step 5: Repin the security-patched runtime**

Use the already observed fresh production build identity:

```text
sha256=7c280e80546627a82f29010a160ad1aa720c2ca03b447b0328d610b90b82023c
files=3476
directories=435
bytes=640587874
```

Update the parser manifest, exact byte assertions, server startup pin, integration-test pin, and bilingual deployment documentation. Recompute the parser manifest SHA-256, write it into `trusted_production_source_manifest.json`, then recompute that manifest SHA-256 and update only the matching trusted-source constants. Use SHA-256 calculations over raw file bytes; do not hand-calculate either digest.

- [ ] **Step 6: Run GREEN verification**

Run the two focused Node test files, syntax-check changed JavaScript and JSON, run `git diff --check`, scan the changed files for credential patterns, and verify the frozen PPT SHA-256 remains exact.

---

### Task 3: Independent review, guarded deployment, and release synchronization / 独立审查、受保护上线与版本同步

**Files:**
- Modify: `CHANGELOG.md`
- Create: `docs/version-records/2026-09-10-v0.8.22-parser-dependency-cache-production.md`
- Create: `archive/versions/2026-09-10-v0.8.22-parser-dependency-cache-production.md`
- Modify: `C:\Users\29272\Documents\在线商务平台\TuringMarket-开发进度.html`
- Create: `D:\主盘\图灵集市\图灵商务平台开发\01-版本归档\2026-09-10-v0.8.22-parser-dependency-cache-production.md`
- Modify: `D:\主盘\图灵集市\图灵商务平台开发\CHANGELOG.md`

**Interfaces:**
- Consumes: reviewed Task 2 commit and the existing guarded `platform/deploy_v8.ps1` workflow.
- Produces: verified cache miss/build evidence, verified cache hit/reuse evidence on a second no-change candidate, production parser acceptance, rollback proof, and synchronized release records.

- [ ] **Step 1: Obtain independent approval**

Give a fresh reviewer the complete diff from the pre-slice base. Block deployment on every Critical or Important finding, fix through the implementer, rerun affected tests, and obtain an explicit clean re-review.

- [ ] **Step 2: Create and verify the rollback point**

Run the existing guarded backup path, verify its complete SHA-256 manifest, record the database digest without exposing data, and confirm the current runtime snapshot can be restored before production mutation.

- [ ] **Step 3: Deploy the cache miss and patched runtime**

Run `platform/deploy_v8.ps1` from the authoritative clean branch. Require `PARSER_DEPENDENCY_CACHE_BUILT`, the new runtime identity, parser-aware health, successful acceptance evidence, PM2 online, Nginx active, database integrity, and no unexpected migration.

- [ ] **Step 4: Prove the cache hit path without business mutation**

Run a second unchanged guarded candidate only through parser preparation and its pre-mutation gates, require `PARSER_DEPENDENCY_CACHE_REUSED`, capture elapsed time, then stop and clean the candidate before writer acquisition or production mutation. Confirm public health remains `200` throughout.

- [ ] **Step 5: Synchronize and publish records**

Write one bilingual release record with root cause, cache key/evidence facts, first-run build time, second-run reuse time, runtime identity, backup path, online health, and reviewer verdict. Copy identical record bytes to repository archive and Obsidian, update both changelogs and the progress dashboard, commit, push GitHub, and verify local `HEAD` equals the remote branch head.


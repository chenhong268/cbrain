# gate:consistency Release Guard (#279)

> 状态：设计已确认（宏哥 review v2：LanceDB hard + layer sqlite + 源码 CLI + projector #280），待 writing-plans 拆实现计划
> Issue: #279
> 日期: 2026-07-04

## Context

CBrain 有多个会 drift 的独立层：Markdown vault、SQLite pages/chunks、FTS、LanceDB、graph links、hierarchy frontmatter、Markdown relation projections。一次性的 repair 不够——release 流程需要一个**确定性门禁**，防止同样的物理不一致悄悄回潮。

**依赖现状**（Explore 摸清，关键比预期好）：

| 依赖 | 状态 |
|:---|:---|
| #274 fsck self-heal | **全部 LANDED**——sync skip 已检查 chunks+FTS（`sync.ts:161,471,747-757`）、stale FTS cleanup（`sqlite.ts:1144-1154`）、migrateRawToRecords 已更新 chunks_fts（`sqlite.ts:744-746,772`）、3 个 probe + guidance 修正全在 |
| #278 repair-plan Phase 1 | **LANDED**——command + 4 buckets + dry-run/execute/verify/limit + privacy 全在（`repair-plan.ts` + `fsck.ts:150-232`）。**前置修复**：`repair-plan.ts:79` 现有错 key `lance.coverage_gap` → 统一 `lance.vector_coverage_gap`（#279 gate 依赖 repair-plan 分类正确）|
| #280 Known Relations projector | **NOT IMPLEMENTED**（#280 真正的 open work；注意 #278 是 repair-plan，projector 是 #280）|
| #273 hierarchy compensation | LANDED（merged）|
| hierarchy split-brain check | LANDED 但在 **`health.ts:899-914`**，不在 fsck `FsckReport`——gate 消费 fsck 看不到 |
| `gate:consistency` script | **NOT IMPLEMENTED**（`package.json:28-34` 无；模板 `bin/check-v2-preflight.ts`）|

所以 #279 的核心工作不是修 #274（已落地），而是**把 fsck + repair-plan 接进一个 release 门禁** + 补 hierarchy split-brain 进 fsck + 修 repair-plan 错 key。唯一真 blocked：projection drift（等 #280 projector）。

## Goal

`bun run gate:consistency` 单命令跑 storage consistency invariants，suitable for pre-release validation + Agent 每日巡检。gate 输出**hard no-go（fail）vs warning（pass with warning）分层**，machine-readable JSON + human markdown，匿名 fixture。

## Design

### 1. 新 fsck probe：`hierarchy.frontmatter_graph_mismatch`（宏哥选）

- **位置**：`src/core/fsck/hierarchy-probe.ts`（新文件；mirror `sqlite-probe.ts` / `fts-probe.ts` 结构）。
- **finding `layer: "sqlite"`**——`FsckLayerSchema` 只 `vault|sqlite|fts|lance`，无 `graph`；加 layer 会破坏 stable JSON schema。文件名叫 hierarchy-probe 只是组织，finding 走 sqlite layer（它查的是 `links` 表 + `pages` frontmatter，本质 sqlite 层）。
- **逻辑**：复用 `health.ts:899-914` 的 SQL——遍历有 `reports_to` frontmatter 的 page，对每个查 `links` 表是否有匹配的 current/active `reports_to` 边（`trust_state IS NULL OR IN ('trusted','user_thought')`，#233 current-fact 语义）。frontmatter 有值但无 active 边 → mismatch finding。
- **severity**：`error`（hard no-go）。
- **check name**：`hierarchy.frontmatter_graph_mismatch`。
- **samples**：匿名（`anonymizeSlugs`，`report.ts:24-28` 现有 helper）。
- **suggestedCommand**：`cbrain hierarchy <slug>` 让人查/修（#273 compensation 已保证新写不产生 split-brain；历史残留需人工）。
- **注册**：`runFsck()`（`src/cli/commands/fsck.ts:31`——runAllProbes 的调用点；`src/core/fsck/index.ts` 不存在）。

### 2. gate 脚本：`bin/check-consistency-gate.ts` + `src/core/fsck/consistency-gate.ts`

- **输出 schema**：`{gate:"consistency", version, timestamp, passed, hard[], warnings[], lanceState, repairPlanStatus, next_action, duration_ms}`。**不 mirror v2-preflight 的 `results[]`/`stdout_tail`**——gate **import src 函数**（非 shell 子进程），没有 sub-process stdout 可截；`hard[]`/`warnings[]` 分类对 Agent 路由比 `stdout_tail` 更有用。只输出 stable JSON（单消费者 = Agent/daily-patrol；无 `--json`/markdown 分支，YAGNI）。**不输出 raw `fatalError`**（probe 内部错误含 SqliteError/IO path → 隐私；`next_action` 用固定字符串）。
- **逻辑分层**（testability）：判定逻辑抽到 `src/core/fsck/consistency-gate.ts` 纯 function（`evaluateConsistencyGate(report, hasChunks, repairPlanStatus?)`）。`bin/check-consistency-gate.ts` import src（`loadConfig` + `CBrainDB` + `runFsck` + `buildRepairPlan` + `evaluateConsistencyGate`）——**不 shell cbrain**，不依赖 PATH installed cbrain。test 直接调 function（fixture `FsckReport`）+ e2e spawn bin/（`tests/cli/gate-consistency.test.ts`，锁 schema/exit/隐私）。
- **hard/warning 分层**（gate 维护自己的分类，**独立于 fsck severity**——`page_without_chunks` 等 fsck 标 `warning` 但 gate 列 hard no-go）：
  - **hard no-go（gate fail，exit 1）**：`sqlite.page_without_chunks`、`fts.stale_rows`、`fts.coverage_gap`、`hierarchy.frontmatter_graph_mismatch`、`hierarchy.malformed_reports_to`（reports_to 非完整 slug，Hermes 反馈的真实断链）、`lance.vector_coverage_gap`（chunks 有但 LanceDB 缺向量）、`sqlite.orphan_*`（dangling FK）、`vault.file_exists_db_missing`、`vault.db_exists_file_missing`、`vault.frontmatter_slug_mismatch`。
  - **LanceDB `lanceState` 额外判定**（`probeLance()` table missing/corrupt 时只设 `lanceState` 不出 finding，gate 必须额外解释，否则 LanceDB 损坏会 pass）：`corrupt` → hard；`missing` 或 `unchecked`（lancePath 不存在）且 DB 有 chunks → hard（删 LanceDB dir 不能把 hard 转 silent-pass）；`missing`/`unchecked` 且空库 → warning。
  - **warning（gate pass）**：`sqlite.title_collision`（needs_review）、`sqlite.quarantine_context`（observe-only）、stub/orphan/discovery 质量 signal。
- **判定**：任一 hard finding count > 0 或 lanceState hard 或 fatalError → `passed:false`，exit 1。仅 warning → `passed:true`，exit 0。DB 不存在 → exit 2。
- **repair-plan verify** 作辅助信号（`repairPlanStatus` 字段，非 hard fail 源——`actionable`/`blocked` ≠ 物理损坏）。
- **probe 扫描无静默上限**：`probeHierarchy` 直接 SQL `SELECT ... WHERE file_path IS NOT NULL`（无 LIMIT）——release gate 不能静默漏扫 >N 页（samples 限 5，count 不限）。

### 3. `package.json` + v2-preflight 接入

- 加 `"gate:consistency": "bun run bin/check-consistency-gate.ts"`（`package.json:28-34` scripts 区，跟 `gate:offline`/`gate:rc` 同列）。
- **接入 `gate:v2-preflight`**：`bin/check-v2-preflight.ts:61-95` sub-gate list 加 `{id:"consistency", label:"Storage consistency", command:"bun run gate:consistency"}`。这样 `daily-patrol.sh:117-126` + release packet 自动跑 consistency gate。
- gate:consistency 需要 DB + vault（不像 gate:offline 纯静态）。daily-patrol 跑 real vault——fsck 全表扫描可能慢（生产 972 pages 等），但 daily-patrol 本就 async/warn（非 runtime-unhealthy），可接受。

### 4. sync skip regression 锁死（#274 已修行为）

- gate test 加一个 fixture：page 有匹配 `content_hash` 但 chunks 缺失 → 跑 sync → 断言 chunks/FTS 被重建（不 skip）。
- 这是验证 #274 fix（`hasCompletePageIndexes`）不被回潮，**不是新功能**。test 放 `tests/core/maintenance/sync.test.ts` 或新 `tests/core/fsck/consistency-gate.test.ts`。

## Non-goals

- **projection drift（`## Known Relations` vs graph）**：blocked on **#280 KnownRelationsProjector**（未实现；注意 #278 是 repair-plan，projector 是 #280）。本期 **skip**，spec/issue 标注"等 #280 后接"。不 fake stub fixture（fake check 通过 ≠ 真 projector 工作，价值低且误导）。
- 不 mutate production vault/indexes（gate read-only；`repair-plan --verify` 不 `--execute`）。
- 不 fail on quality noise（stub 多 / discovery 弱 / orphan 体积）——那是 #276 attention governance。
- 不依赖 wall-clock performance（用 deterministic operation counts + fixture invariants）。
- 不 require real user data（匿名 fixture only）。

## Acceptance Criteria（#279 + 宏哥 review v2）

1. 单命令（`bun run gate:consistency`）跑 storage consistency checks，suitable for pre-release。
2. 匿名 fixture + deterministic setup/teardown。
3. gate fail on：missing chunks、stale FTS rows、FTS coverage gaps、known dangling rows。
4. **gate fail on LanceDB**：`lance.vector_coverage_gap`、`lanceState==="corrupt"`、`lanceState==="missing" && DB 有 chunks`。`missing && 空库` 才 warning/pass。
5. sync skip regression：hash-match + incomplete indexes → 不 skip（#274 行为锁死）。
6. hierarchy split-brain：新 fsck probe `hierarchy.frontmatter_graph_mismatch`（`layer:"sqlite"`），gate 列 hard no-go。
7. ~~graph mutation → Known Relations projection verification~~ → **本期 skip**（blocked #280 KnownRelationsProjector）。
8. output 清晰分 hard no-go failures vs warnings。
9. documented in release/dev guidance（README 或 `docs/developer-reference.md` 加 gate:consistency 说明）。
10. 接入 `gate:v2-preflight`（daily-patrol / release 自动）。
11. **前置修复**：`repair-plan.ts:79` 错 key `lance.coverage_gap` → `lance.vector_coverage_gap`。
12. gate 子进程用源码 CLI（`bun run src/cli/index.ts ...`），不依赖 PATH installed cbrain。

## Test Plan

模板：现有 `tests/core/fsck/*.test.ts` + `tests/cli/repair-plan.test.ts`（real CBrainDB + fixture + anonymize）。

- **新 fsck probe**（`tests/core/fsck/hierarchy-probe.test.ts`）：seed page with `reports_to` frontmatter + 无 graph 边 → finding（`layer:"sqlite"`）；有 active 边 → no finding；superseded 边（非 current）→ still finding（current-fact 语义）；samples 匿名。
- **consistency-gate function**（`tests/core/fsck/consistency-gate.test.ts`，直接调 function，不 spawn 子进程）：
  - clean `FsckReport`（无 findings, lanceState=ok）→ `passed:true`，exit 0。
  - `page_without_chunks` finding → `passed:false`。
  - `stale_rows` / `coverage_gap` / `hierarchy.frontmatter_graph_mismatch` / `lance.vector_coverage_gap` finding → fail。
  - `lanceState:"corrupt"` 无 finding → fail（gate 解释 lanceState）。
  - `lanceState:"missing"` + 有 chunks → fail；`missing` + 无 chunks → pass/warning。
  - warning-only（`title_collision`）→ `passed:true`，warnings 列出。
  - privacy：gate output 不含真实 slug（匿名）。
- **bin/ wrapper**（`tests/cli/gate-consistency.test.ts` 或 shell）：spawn `bun run bin/check-consistency-gate.ts` with fixture DB env → 端到端 exit code + output shape。
- **sync skip regression**：hash-match + missing chunks → sync 重建（不 skip）。
- **repair-plan key 修复**：`lance.vector_coverage_gap` finding 经 repair-plan 分类为 `auto_repairable`（验证错 key 修复后 rule 匹配）。
- **v2-preflight 接入**：读 `check-v2-preflight.ts` sub-gate list 确认含 consistency。

## Files

- **Create** `src/core/fsck/hierarchy-probe.ts`（新 probe，finding `layer:"sqlite"`）+ 注册到 `runFsck()`（`src/cli/commands/fsck.ts:31`）。
- **Create** `src/core/fsck/consistency-gate.ts`（gate 判定 function，纯逻辑）。
- **Create** `bin/check-consistency-gate.ts`（shell wrapper，调 consistency-gate function）。
- **Modify** `package.json`（加 `gate:consistency`）。
- **Modify** `bin/check-v2-preflight.ts:61-95`（sub-gate list 加 consistency）。
- **Modify** `src/core/fsck/repair-plan.ts:79`（错 key `lance.coverage_gap` → `lance.vector_coverage_gap`，前置修复）。
- **Create** `tests/core/fsck/hierarchy-probe.test.ts` + `tests/core/fsck/consistency-gate.test.ts` + `tests/cli/gate-consistency.test.ts`。
- **Modify** `docs/developer-reference.md` 或 README（gate:consistency 文档）。
- **不改**：fsck 现有 probes、sync、sqlite、#273 hierarchy compensation、repair-plan buckets 结构（只修错 key）。

## Risks / 对抗审查关注

- **gate 分类 vs fsck severity 不一致**：fsck 标 `page_without_chunks` 为 `warning`，gate 列 hard no-go。要在 gate 文档/输出明确"gate 分类独立于 fsck severity"（fsck severity 是诊断级，gate 分类是 release 级）。对抗审查确认 hard/warning 列表完整 + 无遗漏 hard check。
- **LanceDB lanceState 不能只看 findings**：`probeLance()` table missing/corrupt 时可能只设 `lanceState` 不出 finding。gate 必须额外解释 `lanceState`（corrupt=hard, missing+chunks=hard, missing+空库=warning），否则 LanceDB 损坏会 pass。
- **gate 逻辑分层（testability）**：判定逻辑抽到 `src/core/fsck/consistency-gate.ts` 纯 function，`bin/` 只 shell + 调 function。test 调 function（fixture `FsckReport`），不 spawn 子进程。子进程命令用源码 CLI（不依赖 installed cbrain）。
- **v2-preflight 接入的副作用**：daily-patrol 跑 consistency gate 可能慢（fsck 全表）。要确认 daily-patrol 的 async/warn 语义不破（gate:consistency fail → patrol warn，不 runtime-unhealthy）。
- **hierarchy probe 性能**：遍历所有有 reports_to 的 page + 查 graph 边。生产规模下要 bounded（LIMIT sample，全 count 但只 sample 5）。
- **隐私**：gate output 匿名（fsck/repair-plan 已匿名，gate 聚合保持匿名）。
- **scope 蔓延**：不顺势改 fsck 现有 probes / sync / sqlite / repair-plan buckets 结构。但 `repair-plan.ts:79` 错 key 是 #279 前置修复（gate 依赖 repair-plan 分类正确）。

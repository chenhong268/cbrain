# Bounded Daily Patrol Entrypoint — Design

> 关联 issue: #223 `bug: daily patrol script can false-fail on full test timeout`
> 日期: 2026-06-23
> 状态: Draft（待 review）
> 基线: 从 `origin/main`（`d945440`）开，独立于未 push 的 #222

## Problem

daily patrol / maintenance scan 在 service healthy 时仍报 script timeout：patrol wrapper（Hermes 私有）跑 full `bun test` + 120s timeout。test suite 合理超 120s（regression 覆盖增长），patrol 把 "test timeout" 当 "CBrain unhealthy"——混 runtime health 与 unbounded full test suite。

## Root Cause

无 repo-owned bounded daily patrol 入口。Hermes cron 依赖私有 wrapper 跑 full `bun test` under 短 timeout。

## Design Decision

**`bin/daily-patrol.sh` bounded daily patrol（< 60s budget）+ full suite 分离。** daily 只判"现网可用 + 退化信号"，full test 留 nightly/release。single-writer + HTTP `/mcp` 拓扑下，cron 走 HTTP/MCP，**不 spawn stdio CLI 触 runtime**。

### 1. `bin/daily-patrol.sh`

bounded checks，分区输出，目标 < 60s：

- **runtime health**：`curl http://127.0.0.1:${CBRAIN_PORT:-3399}/health`（serve OK）
- **MCP health**：HTTP `/mcp` `initialize` → `tools/list`（复用 #212 `bin/cbrain-maintenance.sh` 的 initialize/session-id 模式；MCP 响应 = healthy）
- **perf**：`cbrain perf-diagnose --days 7 --min-latency-ms 0 --json`（代码明确 readonly SQLite 打开）
- **repo gate**：`bun run gate:v2-preflight`（**timeout bounded**——超时只标 `repo_gate: deferred/timeout`，**绝不判 runtime unhealthy**）
- **data quality**：只汇总 `/health` + `/mcp` status 返回的高层数字（tool 数、session 数等），**不跑完整 health/dream/scan**

分区输出：`runtime / mcp / perf / repo_gate / data_quality`。任一 section fail 报对应标签，但 **runtime fail ≠ repo gate fail**（gate timeout 是 deferred，不是 unhealthy）。

**显式不调用**（single-writer 拓扑 + 非纯只读）：
- `cbrain doctor`（开 CBrainDB + 调 embedding API，非纯只读；daily cron 不应 spawn CLI 触 runtime）
- `bun test` / `bun run check`（full suite，留 nightly/release）
- `cbrain dream`（写操作，走 maintenance wrapper 而非 patrol）
- `cbrain health` 全量重扫（除非确认 bounded 且不写）

通用 path：`CBRAIN_PORT` env 默认 3399，`CBRAIN_MCP_URL` 默认 `http://127.0.0.1:3399/mcp`，不硬编码绝对路径。

### 2. `docs/patrol.md`（新）

三层节奏：
- **daily**：`bin/daily-patrol.sh`（bounded，< 60s）
- **nightly/release**：`bun run check`（full test，realistic timeout，分离）
- **release**：install smoke（`bin/check-install-smoke.sh`）+ tag/release gates

明确：
- Hermes cron **不应**直接把 full `bun test` 塞进 120s timeout
- single-writer 拓扑下，cron 走 HTTP/MCP，**不 spawn stdio CBrain**（链回 #208/#212）
- 替代私有 ad-hoc patrol wrapper

### 3. README 短链接

维护区加 1-2 行入口链接 → `docs/patrol.md`（不展开）。

### 4. 测试

- `bash -n bin/daily-patrol.sh`（语法）
- `check-docs-consistency` 加 `checkDailyPatrolContract` grep：
  - `docs/patrol.md` 不推荐 daily 跑 `bun test` / `bun run check`
  - `bin/daily-patrol.sh` 不含 `bun test` / `bun run check` / `cbrain doctor`（反模式）
- `bun run check` 通过

## Boundaries

- **不 spawn stdio CLI 触 runtime**（single-writer 拓扑；走 HTTP/MCP）
- full `bun test`/`check` 不在 daily（分离 nightly/release）
- `repo_gate` timeout 是 deferred，不是 unhealthy
- 不硬编码用户绝对路径
- 无私有 paths/names/vault 在 report/logs/tests/examples

## Non-goals

- 不优化 full test suite
- 不改 #222 search budgeting
- 不改数据模型
- 不改私有 Hermes 脚本/config
- 不 release

## Acceptance Criteria（#223）

- [ ] daily patrol 不因 `bun test` > 120s 误报（service healthy 时）
- [ ] report 分区标注 runtime health vs repo gate（gate timeout = deferred，非 unhealthy）
- [ ] patrol 命令 bounded（< 60s 或显式 deferred full tests）
- [ ] docs 明确 daily / nightly / release 三层
- [ ] daily-patrol.sh 不调用 `cbrain doctor` / `bun test` / `bun run check`（grep 可证）
- [ ] 无私有 paths/examples
- [ ] `bun run check` 通过

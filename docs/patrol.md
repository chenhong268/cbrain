# Daily / Nightly / Release Patrol

> CBrain 运维巡检三层节奏。daily 只判现网可用 + 退化信号；full test 留 nightly/release。

## 三层分离

| 节奏 | 命令 | 用途 | 超时 |
|:---|:---|:---|:---|
| **daily** | `bin/daily-patrol.sh` | 现网可用 + 退化信号（bounded） | < 60s（每 section bounded） |
| **nightly / release** | `bun run check` | full test suite（tsc + biome + 全量 test） | realistic（min），**不塞 120s** |
| **release** | `bin/check-install-smoke.sh` + tag/release gates | 安装冒烟 + 发布门禁 | 按需 |

## Daily patrol（`bin/daily-patrol.sh`）

分区输出：`runtime / mcp / perf / repo_gate / data_quality`。

- **runtime**：`curl /health`（serve 运行）
- **mcp**：HTTP `/mcp` `initialize` → `tools/list`（复用 `bin/cbrain-maintenance.sh` 模式；MCP 响应 = healthy）
- **perf**：`cbrain perf-diagnose --days 7 --min-latency-ms 0 --json`（readonly SQLite）
- **repo_gate**：`bun run gate:v2-preflight`（timeout-bounded；**timeout/fail = deferred，非 runtime unhealthy**）。v2-preflight 含 `gate:consistency`（#279/#379）—— **repository fixture gate**，跑匿名 fixture DB 上的 fsck + repair-plan 硬/软分层（hard no-go: missing chunks / stale FTS / coverage gap / hierarchy split-brain / dangling FK / LanceDB corrupt/missing-with-chunks；warning: title collision / 空库 LanceDB missing）。该 gate **不读 cbrain.json / 不开操作者 vault 或 DB**，clean checkout 可跑；操作者真实 profile health 由独立 `bun run gate:profile-storage` 提供（fail-closed on missing/invalid config）。
- **data_quality**：汇总 `/health` + `tools/list` 高层数字（不跑 full health/dream/scan）。#441 起在同一 MCP session 调用 `status`，读取 `lastFullHealth` 只读标量快照（`availability / checkedAt / overallStatus / totalIssueCount / freshness`，36 小时新鲜度阈值，恰好 36 小时仍算 fresh），并**分行输出两个状态轴**：
  - **运行健康**：runtime/MCP 是否可用，唯一决定 exit code；
  - **最近完整知识体检**：最近一次完整 `health` 的结论。state 缺失、旧格式、损坏或超过 36 小时分别显示"未验证/已过期"，fail-closed，绝不输出"数据健康"类保证。

  知识体检 `fail` ≠ 服务或检索不可用；runtime `pass` 也不代表知识/数据健康。daily 不合成单一"健康"标签，不重跑 full health（single-writer，见 #208/#223），知识治理债务由 nightly full health 与 `next_actions` 承载。

exit 0 = runtime healthy（perf/repo_gate 可能 deferred）；exit 1 = runtime unhealthy（runtime/mcp fail）。知识体检结论不影响 exit code。

## 不放 daily 的命令（single-writer 拓扑，见 #208）

- `bun test` / `bun run check` —— full suite，留 nightly/release
- `cbrain doctor` —— 开 CBrainDB + 调 embedding API，非纯只读；cron 不应 spawn stdio CLI 触 runtime
- `cbrain dream` —— 写操作，走 `bin/cbrain-maintenance.sh`（maintenance）非 patrol
- `cbrain health` 全量重扫 —— 除非确认 bounded 且不写
- **Profile 约束（#251）**：共享 `/mcp` runtime 必须保持 `full` 或 `maintenance`（`CBRAIN_MCP_TOOL_PROFILE`）。设成 `agent` 会隐藏 `dream`/`health`，直接坏掉 patrol（`/mcp` health-check）和 `bin/cbrain-maintenance.sh`（`/mcp` 调 `dream`）。

## Hermes cron 指引

- **不要**直接把 full `bun test` 塞进 120s timeout——会因 test suite 合理超时而误报 "CBrain unhealthy"（#223 根因）
- single-writer + HTTP `/mcp` 拓扑下，cron **走 HTTP/MCP**，不 spawn stdio CBrain（避免触 single-writer gate / 并发写）
- daily cron 调 `bin/daily-patrol.sh`；maintenance cron 调 `bin/cbrain-maintenance.sh dream`（见 `docs/hermes-integration.md`）
- 复制 `bin/daily-patrol.sh` 到 Hermes scripts 目录时，需 `export CBRAIN_REPO_DIR=<cbrain-repo-root>`（否则脚本从非 repo 目录跑会找不到 perf-diagnose/gate）。`<cbrain-repo-root>` 是占位，不写真实路径

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
- **repo_gate**：`bun run gate:v2-preflight`（timeout-bounded；**timeout/fail = deferred，非 runtime unhealthy**）
- **data_quality**：汇总 `/health` + `tools/list` 高层数字（不跑 full health/dream/scan）

exit 0 = runtime healthy（perf/repo_gate 可能 deferred）；exit 1 = runtime unhealthy（runtime/mcp fail）。

## 不放 daily 的命令（single-writer 拓扑，见 #208）

- `bun test` / `bun run check` —— full suite，留 nightly/release
- `cbrain doctor` —— 开 CBrainDB + 调 embedding API，非纯只读；cron 不应 spawn stdio CLI 触 runtime
- `cbrain dream` —— 写操作，走 `bin/cbrain-maintenance.sh`（maintenance）非 patrol
- `cbrain health` 全量重扫 —— 除非确认 bounded 且不写

## Hermes cron 指引

- **不要**直接把 full `bun test` 塞进 120s timeout——会因 test suite 合理超时而误报 "CBrain unhealthy"（#223 根因）
- single-writer + HTTP `/mcp` 拓扑下，cron **走 HTTP/MCP**，不 spawn stdio CBrain（避免触 single-writer gate / 并发写）
- daily cron 调 `bin/daily-patrol.sh`；maintenance cron 调 `bin/cbrain-maintenance.sh dream`（见 `docs/hermes-integration.md`）

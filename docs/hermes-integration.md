# Hermes Integration

> CBrain 与 Hermes cron / Agent 的正确集成姿势。核心：**single-writer 拓扑**。

## Runtime Topology（#208 single-writer）

CBrain 是 single-writer 模型。正确拓扑：

- **唯一 writer**：一个 `cbrain serve --http`（launchd `ai.cbrain.serve`），持有 SQLite/LanceDB writer + watcher。
- **所有 client**：Hermes Agent / cron 作为 MCP client 连 `http://127.0.0.1:<port>/mcp`（Streamable HTTP），各自 session。
- **禁止**：为多 Agent / cron 各自 spawn `cbrain serve`（stdio）—— single-writer gate 会挡，且并发写损坏数据。

```
Hermes Agent A ─┐
Hermes Agent B ─┼─→ http://127.0.0.1:<port>/mcp ─→ [cbrain serve --http: 唯一 writer + watcher]
cron ──────────┘                                         ├─ SQLite/LanceDB
                                                         └─ /mcp（多 session，自动清理）
```

## Maintenance Cron（Hermes script-dir-safe）

Hermes policy 要求 cron 调的 script 在其 scripts 目录内。用 `bin/cbrain-maintenance.sh` wrapper：

1. 复制 wrapper 到 Hermes scripts 目录：
   ```bash
   cp <repo>/bin/cbrain-maintenance.sh <hermes-scripts-dir>/cbrain-maintenance.sh
   chmod +x <hermes-scripts-dir>/cbrain-maintenance.sh
   ```
2. crontab 调 wrapper（**不裸调 cbrain**）：
   ```cron
   # 每天凌晨 3 点夜间维护（dream: sync → enrich → cleanup → health → report）
   0 3 * * * CBRAIN_MCP_URL=http://127.0.0.1:<port>/mcp <hermes-scripts-dir>/cbrain-maintenance.sh dream >> <log-path> 2>&1
   ```

wrapper 走 HTTP `/mcp` 的 dream tool（通过 serve 的 single writer）。

### 为什么不能裸调 CLI

裸 `cbrain dream`（CLI）**不过 single-writer gate**（gate 只在 `cbrain serve` 检查）。HTTP serve 持有 writer 时，CLI `cbrain dream` 并发写 DB（backup/sync/enrich）损坏数据。**必须**走 wrapper → `/mcp` → serve 的 writer。

`cbrain watch` 命令已废弃移除（watcher 归 `serve`），不要再引用。 <!-- docs-consistency:ignore-command -->

## 排障

- **serve 未运行**：wrapper health check 失败 → 重启 `launchctl kickstart -k "gui/$(id -u)/ai.cbrain.serve"`，等 3 秒 `curl -s http://127.0.0.1:<port>/health` → `{"ok":true,...}`。
- **session 抓不到**：wrapper initialize 未返回 `mcp-session-id` → 查 serve stderr（`/mcp session init failed`）。
- **dream job 查询**：MCP client 调 `dream_status` tool。

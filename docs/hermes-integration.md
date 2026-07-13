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

## Daily Agent MCP config（HTTP + agent profile，#264）

日常 Hermes Agent session **必须**走 HTTP `/mcp` + `agent` profile，不要用 stdio（stdio 会为每个 Agent spawn serve，撞 single-writer gate）。工具层前门是 `cbrain_recall`——Agent 自然语言提问首选它，由 CBrain 内部分发；低层工具（`query` / `deep_recall` / `summarize` 等）只在 debug/fallback。生成配置：

```bash
cbrain mcp-config --http
```

```json
{
  "mcpServers": {
    "cbrain": {
      "url": "http://127.0.0.1:3399/mcp",
      "headers": { "X-CBrain-Tool-Profile": "agent" }
    }
  }
}
```

可加 `--port`/`--host`/`--profile` 覆盖（profile 默认 `agent`，可选 `maintenance`/`debug`/`full`）。

### 为什么——防 300s 毒化

观测到的故障模式：一次长时间写/维护调用（`sync`、大块 `ingest`）在 MCP client 端挂到 300s 超时，Hermes 把整个 `cbrain` server 标记成 disconnected，之后所有 `recall`/`status` 立刻报 `MCP server 'cbrain' is not connected`。一次慢调用毒化了整个记忆接口。

两层解药，都靠这条 HTTP 配置交付：

1. **`agent` profile**：日常 session 看不到 `sync`/`dream`/`health`/`job_*` 这些注定慢的维护工具（`agent` 暴露面见 [MCP 工具参考](mcp-tools.md#工具暴露面-profile251)）。慢工具只能从 `maintenance` profile（维护 wrapper）进。
2. **bounded client timeout**：在你的 Hermes MCP config 里给 `/mcp` 连接设一个远低于 300s 的请求超时——慢调用在 client 边界快速失败，而不是把整个 MCP client 挂死。单位取决于你的 MCP client（Hermes 用什么单位就填什么），建议量级：请求 ~120s / 连接 ~5s。示例片段：

   ```json
   {
     "mcpServers": {
       "cbrain": {
         "url": "http://127.0.0.1:3399/mcp",
         "headers": { "X-CBrain-Tool-Profile": "agent" },
         "timeout": 120,
         "connect_timeout": 5
       }
     }
   }
   ```

   > `timeout`/`connect_timeout` 的单位是 client 侧约定（Claude Code 等用秒），CBrain 服务端不读这俩字段——按你的 client schema 填，把请求卡在 300s 以下即可。生成的 config（`cbrain mcp-config --http`）**不含**这俩字段，避免单位猜错；需要就手动加。

### `ingest` 为什么留在 `agent`

`ingest` 是日常捕获的主入口，砍了 Agent 只能用 `put_page`（跳过 NER → 不铸实体 → 记忆质量降级）。它的同步 NER 延迟有上界：内容上限 500k、NER 有 per-call timeout + fail-open（见 `src/core/ingestion/ner.ts` 的 `NER_DEFAULT_TIMEOUT_MS`），病理性的大块 dump 由上面的 bounded client timeout 兜住（快速失败，不毒化）。大块内容捕获建议传 `nerMode: "defer"`，NER 转后台 job，调用立即返回，彻底避开同步 NER 的延迟。

## Structured output canary（#327 / #331）

结构化输出仍是显式 pilot，服务默认保持 `legacy`。需要在部署前验证 `query`、`deep_recall` 与 `cbrain_recall` 的 structured 合同时，运行隔离 canary：

```bash
bun bin/check-recall-output-boundary-canary.ts
```

canary 使用临时 vault / SQLite / Lance 路径和随机 loopback 端口，完成真实 HTTP `/mcp` initialize、tools/list 与三次 tools/call。默认响应不得出现 `raw` / `audit`；`query` 与 `deep_recall` 还会经过 MCP SDK 的 `outputSchema` 校验。运行结束后会关闭临时 server 并删除临时状态，不修改 Hermes 配置、不重启 `ai.cbrain.serve`，也不切换现网默认模式。

只有需要审计定位时才传 `include_raw=true`。在 structured 模式下，内部引用进入脱敏后的 `audit.raw`；凭据和绝对路径仍会被移除。不要把 structured output 当成完整提示注入隔离层，它的目标是减少默认 raw 暴露并稳定 Agent 消费合同。

## 排障

- **serve 未运行**：wrapper health check 失败 → 重启 `launchctl kickstart -k "gui/$(id -u)/ai.cbrain.serve"`，等 3 秒 `curl -s http://127.0.0.1:<port>/health` → `{"ok":true,...}`。
- **session 抓不到**：wrapper initialize 未返回 `mcp-session-id` → 查 serve stderr（`/mcp session init failed`）。
- **dream job 查询**：MCP client 调 `dream_status` tool。

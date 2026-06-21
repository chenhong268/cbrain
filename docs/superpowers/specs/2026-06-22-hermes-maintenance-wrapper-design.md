# Hermes Maintenance Wrapper — Design

> 关联 issue: #212 `bug: Hermes cron examples use obsolete CBrain commands or blocked script paths`
> 日期: 2026-06-22
> 状态: Draft（待 review）

## Problem

Hermes automation 在 CBrain 逻辑跑之前就失败，两类：

1. **script path 被 Hermes policy 阻止**：cron 指向 Hermes 配置的 scripts 目录外的脚本。
2. **裸调 CLI 制造并发 writer**：维护命令裸调 `cbrain dream`——但 `cbrain dream` **不过 single-writer gate**（gate 只在 `cbrain serve` 检查，`src/cli/commands/maintenance.ts:457` 的 dream action 直接 `loadConfig + createDeps` 无 gate）。HTTP serve 持有 writer 时，CLI `cbrain dream` 并发写 DB（backup VACUUM INTO / sync / enrich）损坏数据。

## Root Cause（审计结论）

#212 的 4 个 Required Fix 里 3 个已在之前工作解决：

| Fix | 现状 |
|:---|:---|
| #1 移除 `cbrain watch` 引用 | ✅ 命令已从 CLI 删除，docs/skills/README 已清空 |
| #3 runtime topology 文档 | ✅ `known-issues.md:11` + `ux-audit.md:94` 已明确 |
| #4 grep test 防 watch 复活 | ✅ `check-docs-consistency.ts` 的 `checkCommands` 抓任何 `cbrain <不存在的命令>`（watch 已不在 CLI） |

**唯一 gap（本 spec 范围）：Fix #2**——无 Hermes script-dir-safe 的 maintenance wrapper，且现有 cron 示例（`README.md:236` `# - Every day: cbrain dream`）裸调 CLI（并发写风险）。

## Design Decision

**提供 `bin/cbrain-maintenance.sh` wrapper + `docs/hermes-integration.md`。** wrapper 走 HTTP `/mcp` 的 dream tool（通过 serve 的 single writer），**不裸调 CLI `cbrain dream`**。

**核心验收：给 Hermes cron 一个不会制造第二 writer 的标准入口。**

## Boundaries（4 条，防扩散）

1. **wrapper 默认只支持 `dream`**
   - `compact` 不实现（未确认有 MCP tool 且不绕 single-writer）。
   - 预留参数结构 `$1` 选 task；未知/未支持 task **fail closed**：exit 非 0 + stderr `unsupported task: <name>`。

2. **MCP 初始化不硬编码脆弱字段**
   - `protocolVersion` 用实测值 `2025-11-25`（SDK `LATEST_PROTOCOL_VERSION`；server `SUPPORTED_PROTOCOL_VERSIONS` 含此 + `2025-06-18`/`2025-03-26`/`2024-11-05`/`2024-10-07`）。
   - `mcp-session-id` 从 initialize **response header** 取（curl `-D -` 抓头）；取不到 → exit 非 0 报错。
   - initialize 失败 / `notifications/initialized` 失败 / `tools/call` 失败 → 任一非 0 exit。

3. **文档新建 `docs/hermes-integration.md`**
   - README 只放短入口链接（避免 README 臃肿）。
   - 新文档写清：topology / cron wrapper pattern / 禁裸 CLI 理由 / 排障命令。
   - 示例必须**匿名、无用户真实路径**（用 `<repo>` / `<port>` 占位）。

4. **测试以静态 + bash smoke 为主**
   - `bash -n bin/cbrain-maintenance.sh`（语法）。
   - grep test：docs 不再推荐 `cbrain watch` / 裸 `bun run src/cli/index.ts (compact|dream)`（绕 wrapper 的反模式）。
   - **不**做真实 dream integration smoke（依赖 LLM/runtime 状态，太重）。

## Implementation

### `bin/cbrain-maintenance.sh`

通用 wrapper，走 HTTP /mcp（参数 `$1` 选 task，默认/仅 `dream`）：

1. **health check**：`curl -sf $BASE/health` → 失败 exit 1（stderr：serve 未运行）
2. **task 校验**：`$1` ∈ {`dream`, 空} → 继续；否则 exit 2 `unsupported task: $1`
3. **MCP initialize**：POST `/mcp`，`protocolVersion: 2025-11-25`，`Accept: application/json, text/event-stream` → 抓 response header `mcp-session-id`（`-D -`）；取不到 exit 1
4. **notifications/initialized**：带 `mcp-session-id` header → 失败 exit 1
5. **tools/call dream**：`arguments: {}`（dream `inputSchema: {}` 无必填，自带循环锁 `dream.lock`）→ 失败 exit 1；成功打印 job 响应
6. **通用 path**：`CBRAIN_MCP_URL` env 默认 `http://127.0.0.1:3399/mcp`，**不硬编码绝对路径**

### `docs/hermes-integration.md`（新文件）

- **拓扑**：一个 `cbrain serve --http` owns writer/watcher；cron/Agent 连 `/mcp`；**禁 spawn stdio serve**（链回 #208 single-writer gate）。
- **Hermes script-dir-safe pattern**：复制 `bin/cbrain-maintenance.sh` 到 Hermes scripts 目录，crontab 调 wrapper（不裸调 cbrain）。
- **为什么不能裸调 CLI**：`cbrain dream` 不过 gate，并发写损坏数据。
- **排障**：health check / session 抓不到 / dream job 查询（`dream_status`）。
- README 维护区（`line 193` 附近）加 1-2 行入口链接 → `docs/hermes-integration.md`。

### `check-docs-consistency.ts` 扩展

加 `checkLegacyCronPatterns`：grep docs（含新 hermes-integration.md）code 示例里的反模式：
- 裸 `bun run src/cli/index.ts (compact|dream)`（绕 wrapper）

`cbrain watch` 由现有 `checkCommands` 覆盖（watch 不在 CLI → fail），不重复。

## Out of Scope

- 不改 src 逻辑（核心问题已在之前工作解决）。
- 不实现 `compact` wrapper（未确认 MCP tool + single-writer 安全）。
- 不改 Hermes 私有配置 / 不硬编码用户绝对路径 / 不做 Hermes gateway 进程监控。
- 不做真实 dream integration smoke。

## Acceptance Criteria（#212）

- [x] No docs/skills 指导跑 `cbrain watch`（`checkCommands` 已覆盖 + grep test 加固）
- [x] Maintenance cron 用 Hermes-compatible wrapper path pattern（wrapper + docs/hermes-integration.md）
- [x] Runtime topology 明确简短（docs/hermes-integration.md）
- [x] `bun run check` 通过（含 `bash -n` + grep test）
- [x] **wrapper 不制造第二 writer**（走 HTTP /mcp，不裸调 CLI `cbrain dream`）

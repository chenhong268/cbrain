# MCP Per-Session Tool Profiles（HTTP `/mcp`）— 设计 spec

> 日期：2026-07-01
> 关联：#251 Phase 2（Phase 1 见 `docs/superpowers/plans/2026-07-01-mcp-tool-profiles.md`）
> 状态：待 review

## 1. 背景与动机

#251 Phase 1 落地了 tool profile 基础设施：`CBRAIN_MCP_TOOL_PROFILE=agent|maintenance|debug|full`
在进程启动时解析一次，threading 进 `ToolContext.toolProfile`，`attachMcpTools` 用 allowlist
gate 工具注册。`agent`=20、`maintenance`=22、`debug`=18、`full`=84。

**缺口**：profile 是进程级全局的。共享生产 `/mcp` 不能设成 `agent`，因为 maintenance cron
还要 `dream/health`。所以 Hermes 实际还跑在 `full`，#251 没产生任何用户体验收益。

**Phase 2 目标**：同一个 HTTP `/mcp` runtime 里，不同 client 各自拿到不同工具面，互不影响：
- Hermes 日常 Agent session → `agent`（≤20）
- maintenance cron / patrol → `maintenance`（含 `dream/health/job_*`）
- debug client → `debug`
- 不声明 profile 的 client → `full`（不破坏现有部署）

## 2. 关键架构事实（决定方案大小）

HTTP `/mcp` runtime **本来就是 per-session 的**。`src/http/server.ts:99-115`，每个新 session：

```ts
const mcpServer = new McpServer({ name: "cbrain", version });
attachMcpTools(mcpServer, ctx);   // ctx 全 runtime 共享
await mcpServer.connect(transport);
await transport.handleRequest(req);
```

每个 client 已经有自己的 `McpServer`、自己的工具注册。Phase 1 没实现 per-session profile 的
**唯一原因**是所有 session 共用同一个 `ctx.toolProfile`（启动时从 env 解析一次）。

→ **Phase 2 实质改动极小**：建 session 时按 request 解析 profile，派生
`sessionCtx = { ...ctx, toolProfile: resolved }` 喂给 `attachMcpTools`。`attachMcpTools` 本体不动，
stdio 不动，REST `/tools` 不动，tool handler 一个不碰。

## 3. 非目标（Out of Scope）

- 不改任何 tool handler（含 `status`）
- 不删/改名/合并工具
- 不动 REST `/tools`（保持 full inventory）
- 不做 profile 权限强制（见 §6.4，profile 不是 authz）
- stdio 不做 per-session（仍走 env；stdio 一进程一 client，无意义）
- 不引入 config-file（`cbrain.json`）profile（延后）

## 4. Profile 选择机制（已定）

优先级（第一个显式信号 wins，无效即 400）：

```
1. HTTP header  X-CBrain-Tool-Profile: <profile>
2. initialize  params._meta.cbrainToolProfile        ← 规范扩展点，正式路径
   initialize  params.metadata.cbrainToolProfile     ← 非规范，兼容手写 client
3. env CBRAIN_MCP_TOOL_PROFILE（server default，缺省 full）→ 作为 fallback
```

**为什么 header 优先**：header 是 Hermes 真能驱动的路径（MCP SDK 的
`StreamableHTTPClientTransport` 支持在 `requestInit` 注入自定义 header，HTTP 层注入，不依赖
SDK 内部 initialize 构造）。

**为什么 metadata 路径现实价值有限但仍保留**：实测 MCP SDK client 的 initialize
（`@modelcontextprotocol/sdk` `client/index.js:296-298`）只发 `protocolVersion`/`capabilities`/
`clientInfo`，**默认不发任何自定义字段**。要用 metadata，client 必须自己构造 initialize
params（绕过 SDK 默认）。所以 metadata 主要服务于手写/轻量 JSON-RPC client（如 curl 类），
而那种 client 用 header 同样简单。保留 metadata 是为了规范友好与未来兼容，**不指望 Hermes
走这条路**。

### 4.1 metadata 字段实测依据（实现前已确认）

- `params._meta`：MCP 规范的官方扩展点。SDK `types.d.ts` 里几乎所有 params schema 都是
  `_meta: z.ZodOptional<z.ZodObject<...>>`，注释明写 "Include this in the `_meta` field"。
  → **正式锁定路径**。
- `params.metadata`：**非** MCP 规范字段（`InitializeRequestParamsSchema` 只有 protocolVersion
  /capabilities/clientInfo）。但手写 client 常见约定。→ **兼容路径**。

实现时 metadata 信号读取顺序：`params._meta?.cbrainToolProfile ?? params.metadata?.cbrainToolProfile`。
`_meta` 优先（规范字段），`metadata` 兜底。两条都在测试里覆盖。

### 4.2 决策表（precedence + fail-fast）

| header X-CBrain-Tool-Profile | initialize _meta/metadata | 结果 | source |
|:--|:--|:--|:--|
| `agent`（合法） | （不读） | profile=`agent` | header |
| 缺 | `_meta.cbrainToolProfile=debug` | profile=`debug` | metadata |
| 缺 | 缺 | profile= `<env default，=full>` | default |
| `bogus`（非法） | 任意 | **400**（不创建 session） | — |
| 缺 | `bogus`（非法） | **400** | — |
| `agent`（合法） | `bogus`（非法） | profile=`agent`（header 命中即短路，不读 metadata） | header |

**短路规则**：header 一旦命中（合法），不再解析 metadata，因此 metadata 的非法值不会触发
400。只有"被实际读取的那一条信号"非法才 400。

## 5. 五条硬约束（实现红线）

1. **profile 只在新 session initialize 时解析一次，session profile 一旦建立即固定。**
   已有 `mcp-session-id` 的后续请求走 existing-session 分支（`server.ts:94`
   `session.transport.handleRequest(req)`），**不重新解析** header/metadata。否则同一 session
   工具面可变会让 client 行为不可预测。

2. **metadata 路径按 §4.1 实测结构实现**，不拍脑袋。
   - 正式：`params._meta.cbrainToolProfile`（规范 `_meta`）
   - 兼容：`params.metadata.cbrainToolProfile`
   - 测试**必须锁定** `params._meta.cbrainToolProfile` 这条正式路径（另加 `metadata` 兼容
     用例）。header 仍优先于两者。

3. **任何显式信号非法 → 400，不创建 session，不 fallback 到 full。**
   typo 不能变成"悄悄暴露全部工具"。400 body 形如
   `{"error":"Invalid X-CBrain-Tool-Profile=\"bogus\". Expected one of: agent, maintenance, debug, full."}`。

4. **profile 是 UX/tool-routing selector，不是 authz。**
   任何本地可信 client 理论上可请求 `full`。文档与实现都**不得**暗示它能做安全隔离。CBrain 是
   127.0.0.1 本地可信部署；profile 只为给 Hermes 减噪、给 maintenance 隔出工具面。

5. **maintenance wrapper 的所有 MCP request 都带 `X-CBrain-Tool-Profile: maintenance`。**
   `bin/cbrain-maintenance.sh` 里 initialize / `notifications/initialized` / `tools/call` 三处 curl
   全加该 header。服务端只在 initialize 那次使用它（约束 1），其余是便于日志排查与契约自描述。

## 6. 设计

### 6.1 纯函数核心（`src/mcp/tool-profiles.ts`，重构 + 新增）

抽一个非抛版三态解析，env 路径（throw）与 HTTP 路径（不抛）都建立在它之上：

```ts
export type ProfileParseResult =
  | { kind: "absent" }
  | { kind: "ok"; profile: ToolProfile }
  | { kind: "invalid"; raw: string };

export function parseToolProfile(raw: string | null | undefined): ProfileParseResult {
  const normalized = normalize(raw);              // 复用现有 helper：trim+lowercase，空→undefined
  if (normalized === undefined) return { kind: "absent" };
  if (VALID_PROFILES.has(normalized as ToolProfile)) return { kind: "ok", profile: normalized as ToolProfile };
  return { kind: "invalid", raw: normalized };
}
```

现有 `resolveToolProfile(env)`（启动用，throw）重构成：`parseToolProfile` → `absent` 返回
`"full"`、`invalid` throw、`ok` 返回 profile。**行为完全不变**，现有 `tool-profiles.test.ts`
全过。

### 6.2 HTTP 解析（新文件 `src/http/session-profile.ts`，~70 行）

```ts
export type SessionProfileResolution =
  | { profile: ToolProfile; source: "header" | "metadata" | "default" }
  | { error: string };

// 新 session 分支调用（async，因为要读 body）
export async function resolveSessionProfile(
  req: Request,
  fallback: ToolProfile,           // = ctx.toolProfile，server default
): Promise<SessionProfileResolution>
```

内部步骤：
1. `headerRaw = req.headers.get("x-cbrain-tool-profile")` → `parseToolProfile`
2. header 非法 → 立即 `error`（不读 metadata）
3. header 合法 → `ok, source=header`（短路，不读 metadata）
4. header absent → `await readInitMeta(req)` 解析 initialize body：
   - `req.clone().json()`，try-catch 容错（非 JSON / 非 initialize / body 已消费 → 视为 absent）
   - 取 `params._meta?.cbrainToolProfile ?? params.metadata?.cbrainToolProfile`
   - `parseToolProfile` 该字符串：非法 → `error`，合法 → `ok, source=metadata`，absent → 继续
5. 都 absent → `{ profile: fallback, source: "default" }`

**body 读取安全性**：`req.clone()` 在新 session 分支、`handleRequest` 消费前调用，WHATWG
tee 安全。metadata 解析对非 initialize body 容错（返回 absent），不影响 SDK 后续对非法请求
的拒绝。

### 6.3 `handleMcp` 新 session 分支接入（`src/http/server.ts`，~15 行）

```ts
// 新 session 分支
const resolved = await resolveSessionProfile(req, ctx.toolProfile);
if ("error" in resolved) {
  return new Response(JSON.stringify({ error: resolved.error }), { status: 400 });
}
const sessionCtx = { ...ctx, toolProfile: resolved.profile };   // immutable 派生
const mcpServer = new McpServer({ name: "cbrain", version });
attachMcpTools(mcpServer, sessionCtx);
await mcpServer.connect(transport);
await transport.handleRequest(req);
sessions.set(sessionId, { server: mcpServer, transport, lastSeen: Date.now(),
                          profile: resolved.profile, source: resolved.source });
console.error(`[mcp] session ${sessionId} profile=${resolved.profile} source=${resolved.source}`);
```

`McpSession` interface 加可选 `profile`/`source` 字段（可观测用，不参与调度）。

### 6.4 可观测性

- 建 session 时一条 `console.error` log：profile + source。
- `McpSession` 存 `profile`/`source`（未来 debug 端点可用；本 spec 不建端点）。
- 不改 `status` tool（边界）。

### 6.5 maintenance wrapper（`bin/cbrain-maintenance.sh`，3 处 +1 header）

initialize / `notifications/initialized` / `tools/call` 三处 curl 各加：
`-H 'X-CBrain-Tool-Profile: maintenance'`

## 7. 文件级改动清单

| 文件 | 改动 | 量 |
|:--|:--|:--|
| `src/mcp/tool-profiles.ts` | 新增 `ProfileParseResult`/`parseToolProfile`；`resolveToolProfile` 重构为薄封装 | ~25 行 |
| `src/http/session-profile.ts` | **新文件**：`resolveSessionProfile` + `readInitMeta` | ~70 行 |
| `src/http/server.ts` | `handleMcp` 新 session 分支接入 + `McpSession` 加字段 + log | ~15 行 |
| `bin/cbrain-maintenance.sh` | 三处 curl 加 header | 3 行 |
| `tests/mcp/tool-profiles.test.ts` | `parseToolProfile` 三态单测 | ~20 行 |
| `tests/http/session-profile.test.ts` | **新文件**：precedence + fail-fast + 双 metadata 路径 | ~80 行 |
| `tests/http/mcp-per-session.test.ts` | **新文件**：E2E，三 session 不同工具面 | ~120 行 |
| `tests/cli/cbrain-maintenance-wrapper.test.ts` | 现有 3 条 + 断言三处 header 存在 | ~15 行 |

**`attachMcpTools` 和所有 tool handler 一行不动。**

## 8. 边界合规（逐条对 #251 Phase 2 红线）

| 红线 | 合规 |
|:--|:--|
| 不改 tool handler | ✓ 只动 profile 解析 + session 装配 |
| 不删/改名/合并工具 | ✓ |
| 不改 REST `/tools` | ✓ REST 走 `createToolRegistry`，不经 `attachMcpTools`，不读 profile |
| 不破坏 `bin/cbrain-maintenance.sh` | ✓ 只加 header，语法/行为不变；default=full 仍含 dream |
| 不让共享 runtime 只选一个全局 profile | ✓ server default=full，每 session 独立解析，可各自升/降 |
| 可测试/可观测/fail-fast | ✓ 单测+E2E+log+400 |
| HTTP header 或 initialize metadata | ✓ 两者都支持，header 优先 |
| stdio 仍走 env | ✓ 完全不动 stdio 路径 |

## 9. 测试策略

### 9.1 单元

- `parseToolProfile`：absent / ok / invalid 三态；大小写、trim、`null`/`undefined`。
- `resolveToolProfile`（env）：回归现有 5 条用例不破。
- `resolveSessionProfile`：§4.2 决策表全行；`_meta` 与 `metadata` 两条路径都覆盖；
  非 JSON body / 非 initialize body / 缺 params → absent 不抛。

### 9.2 E2E（`tests/http/mcp-per-session.test.ts`，验收主力）

起真实 `createHttpServer(ctx)`（参考现有 HTTP 测试起服方式，随机端口），逐个 client 走
initialize → `notifications/initialized` → `tools/list`：

| client | initialize 携带 | 断言 tools/list |
|:--|:--|:--|
| A | header `agent` | count ≤ 20；排除 `query`/`get_chunks`/`dream`/`sync`/`health`/`job_submit` |
| B | header `maintenance` | 含 `dream`/`health`/`job_submit`/`sync`/`dream_status` |
| C | 无 header、无 metadata | count === 84 |
| D | header `bogus` | initialize 响应 400，无 session 创建 |
| E | `params._meta.cbrainToolProfile=debug` | 含 `query`/`get_chunks`/`get_provenance` |
| F | A 的 session 建立后，`tools/call` 不带 header | 仍按 `agent` 工作（profile 固定，约束 1） |

全量 `full` 计数用 `collectRegisteredToolNames()`（`tests/helpers/mcp-inventory.ts`）对齐，
不硬编码 84（避免工具增减后测试脆裂）——断言 "C 的工具数 === inventory 全量"。

### 9.3 maintenance wrapper

现有 3 条（`bash -n`、死端口 fail-fast、curl-only 不调 cbrain CLI）全过 + 新增：脚本源里
initialize / `notifications/initialized` / `tools/call` 三处均出现
`X-CBrain-Tool-Profile: maintenance`。

### 9.4 门禁

`bun run lint`（tsc + biome）+ `bun test`（重点
`tests/mcp/attach-tools.test.ts`、`tests/cli/cbrain-maintenance-wrapper.test.ts`、新两个 HTTP
测试）。能跑 `bun run check` 更好。

## 10. 验收标准（= #251 Phase 2 done）

- [ ] 同一 HTTP `/mcp` server：client A `agent` ≤20；client B `maintenance` 含 dream/health/job_*；
      client C 默认 = full 全量
- [ ] `agent` 看不到 `query`/`get_chunks`/`dream`/`sync`/`health`/`job_*`
- [ ] 五条硬约束逐条满足（尤其约束 1 session 固定、约束 3 非法 400）
- [ ] `tests/mcp/attach-tools.test.ts` + `tests/cli/cbrain-maintenance-wrapper.test.ts` 通过
- [ ] `full` 工具数仍 === inventory 全量
- [ ] `bun run lint` 过；`bun run check` 过
- [ ] stdio 路径行为不变（env profile）

## 11. 风险与回滚

| 风险 | 缓解 |
|:--|:--|
| metadata body 解析拖慢每个新 session | 只在 header absent 时才读 body；header 命中即短路 |
| `req.clone()` 在某些运行时不支持 | Bun 实现 WHATWG fetch，clone 支持；E2E 覆盖 |
| 误把 profile 当 authz | §5 约束 4 + 文档明示；profile 不参与任何鉴权 |
| maintenance wrapper 加 header 后语法错误 | `bash -n` 门禁 + wrapper 测试 |

**回滚**：revert 本次 commit 即可完全恢复 Phase 1 行为（全局 env profile）。改动是叠加式
的，无 schema 迁移、无数据变更。

## 12. 实现顺序（writing-plans 细化）

1. `parseToolProfile` 重构 + 单测（RED→GREEN，env 路径回归）
2. `resolveSessionProfile` + 单测（决策表全行）
3. `handleMcp` 接入 + `McpSession` 字段 + log
4. maintenance wrapper 加 header + 测试
5. E2E 三 session 测试
6. `bun run check` 全过
7. code-reviewer 过一遍

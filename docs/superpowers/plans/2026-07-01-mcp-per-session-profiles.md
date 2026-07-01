# MCP Per-Session Tool Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 同一个 HTTP `/mcp` runtime 里，不同 client 按 header/metadata 各拿不同 tool profile（agent/maintenance/debug/full），session 固定，非法值 400。

**Architecture:** HTTP `/mcp` 已是 per-session（每个新 session `new McpServer()` + `attachMcpTools(mcpServer, ctx)`）。Phase 1 全 session 共用一个 `ctx.toolProfile`。本 plan 在建 session 时按 request 解析 profile，派生 `sessionCtx = { ...ctx, toolProfile }` 喂 `attachMcpTools`。`attachMcpTools` 和所有 tool handler 一行不动。优先级：header `X-CBrain-Tool-Profile` > initialize `params._meta.cbrainToolProfile`（规范）/`params.metadata.cbrainToolProfile`（兼容）> env default(`full`)。第一个显式信号 wins，非法 → 400。

**Tech Stack:** TypeScript (strict, ESNext), Bun, `@modelcontextprotocol/sdk` v1.12 (`McpServer` + `WebStandardStreamableHTTPServerTransport`), `bun:test`, Zod。

**Spec:** `docs/superpowers/specs/2026-07-01-mcp-per-session-profiles-design.md`（commit `b4cbf12`）。**Issue:** #260。

---

## 文件结构

| 文件 | 责任 | 动作 |
|:--|:--|:--|
| `src/mcp/tool-profiles.ts` | profile 纯函数（env 解析 + 三态解析） | 改：加 `parseToolProfile`，重构 `resolveToolProfile` |
| `src/http/session-profile.ts` | HTTP per-session profile 解析（header + metadata + fallback） | **新建** |
| `src/http/server.ts` | `/mcp` runtime，handleMcp 装配 session | 改：新 session 分支接入 resolveSessionProfile + 派生 ctx + log；`McpSession` 加字段 |
| `bin/cbrain-maintenance.sh` | maintenance cron wrapper | 改：三处 curl 加 `X-CBrain-Tool-Profile: maintenance` |
| `tests/mcp/tool-profiles.test.ts` | profile 纯函数单测 | 改：加 `parseToolProfile` 用例 |
| `tests/http/session-profile.test.ts` | resolveSessionProfile 单测（决策表） | **新建** |
| `tests/http/mcp-per-session.test.ts` | E2E：三 session 三工具面 | **新建** |
| `tests/cli/cbrain-maintenance-wrapper.test.ts` | wrapper 测试 | 改：加三处 header 存在断言 |

**不碰：** `src/mcp/server.ts`（`attachMcpTools`）、`src/mcp/register.ts`、`src/mcp/tools/*`（所有 tool handler）、REST `/tools` 路径、stdio 入口。

---

## 宏哥的 8 个审查点 → 验证映射

| # | 审查点 | 验证位置 |
|:--|:--|:--|
| 1 | `resolveSessionProfile` 只在新 session 分支调用，后续请求不重解析 | Task 3 step：existing-session 分支（`server.ts:91-95`）一行不改；E2E client F |
| 2 | `req.clone().json()` 失败当 absent，不影响原始 request | Task 2 `readInitMetaProfile` try-catch + 单测；Task 3 clone 后原始 req 仍传 `handleRequest` |
| 3 | header 合法短路不读 metadata；header 非法 400 | Task 2 决策表单测全行 |
| 4 | invalid metadata 400，不 fallback full | Task 2 单测 metadata invalid → error |
| 5 | `sessionCtx` 只派生不 mutate ctx | Task 3 `{ ...ctx, toolProfile }`（spread，不改 ctx） |
| 6 | `attachMcpTools` 和 tool handlers 不动 | Task 3 只改 `server.ts`，`server.ts:106` 调用点换参；grep 确认 `src/mcp/server.ts` 零 diff |
| 7 | maintenance wrapper 三处 curl 都加 header | Task 4 改三处 + 测试断言三处 |
| 8 | E2E 证明同 runtime 三 session 工具面不同 | Task 5 `mcp-per-session.test.ts` |

---

## Task 1: `parseToolProfile` 纯函数（三态解析）

**Files:**
- Modify: `src/mcp/tool-profiles.ts:111-127`（normalize 之后、`resolveToolProfile` 重构）
- Test: `tests/mcp/tool-profiles.test.ts`（加 describe 块）

- [ ] **Step 1: 先确认现有测试绿（重构基线）**

Run: `bun test tests/mcp/tool-profiles.test.ts`
Expected: 全部 PASS（重构前基线）。

- [ ] **Step 2: 写 `parseToolProfile` 的失败测试**

在 `tests/mcp/tool-profiles.test.ts` 末尾追加（先在文件顶部 import 加 `parseToolProfile`）：

```ts
import {
  TOOL_PROFILES,
  TOOL_PROFILE_ALLOWLISTS,
  resolveToolProfile,
  parseToolProfile,
  isToolAllowedForProfile,
} from "../../src/mcp/tool-profiles";
```

末尾追加：

```ts
describe("parseToolProfile (three-state, #260)", () => {
  test("absent for undefined / null / empty / whitespace", () => {
    expect(parseToolProfile(undefined)).toEqual({ kind: "absent" });
    expect(parseToolProfile(null)).toEqual({ kind: "absent" });
    expect(parseToolProfile("")).toEqual({ kind: "absent" });
    expect(parseToolProfile("   ")).toEqual({ kind: "absent" });
  });
  test("ok for valid profiles, trimmed + lowercased", () => {
    for (const p of TOOL_PROFILES) {
      expect(parseToolProfile(p)).toEqual({ kind: "ok", profile: p });
    }
    expect(parseToolProfile("  AGENT ")).toEqual({ kind: "ok", profile: "agent" });
  });
  test("invalid for garbage, raw is the normalized value", () => {
    const r = parseToolProfile("Garbage");
    expect(r.kind).toBe("invalid");
    if (r.kind === "invalid") expect(r.raw).toBe("garbage");
  });
  test("invalid distinct from absent (fail-fast contract)", () => {
    expect(parseToolProfile(undefined).kind).toBe("absent");
    expect(parseToolProfile("nope").kind).toBe("invalid");
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `bun test tests/mcp/tool-profiles.test.ts`
Expected: FAIL — `parseToolProfile is not exported`（或 not a function）。

- [ ] **Step 4: 实现 `parseToolProfile`，重构 `resolveToolProfile`**

在 `src/mcp/tool-profiles.ts`，把 `resolveToolProfile`（行 116-127）替换为下面的 `parseToolProfile` + 薄封装 `resolveToolProfile`：

```ts
/** Three-state parse: absent (no signal) / ok (valid) / invalid (fail-fast).
 *  Shared by env resolution (throwing) and HTTP per-session resolution (non-throwing, #260). */
export type ProfileParseResult =
  | { kind: "absent" }
  | { kind: "ok"; profile: ToolProfile }
  | { kind: "invalid"; raw: string };

export function parseToolProfile(raw: string | null | undefined): ProfileParseResult {
  const normalized = normalize(raw ?? undefined);
  if (normalized === undefined) return { kind: "absent" };
  if (VALID_PROFILES.has(normalized as ToolProfile)) {
    return { kind: "ok", profile: normalized as ToolProfile };
  }
  return { kind: "invalid", raw: normalized };
}

/** Resolve profile from env. Undefined/empty → "full". Invalid → throw (fail fast). */
export function resolveToolProfile(env?: string): ToolProfile {
  const parsed = parseToolProfile(env);
  if (parsed.kind === "absent") return "full";
  if (parsed.kind === "invalid") {
    throw new Error(
      `Invalid CBRAIN_MCP_TOOL_PROFILE=${JSON.stringify(parsed.raw)}. ` +
        `Expected one of: ${TOOL_PROFILES.join(", ")}.`,
    );
  }
  return parsed.profile;
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `bun test tests/mcp/tool-profiles.test.ts`
Expected: 全部 PASS（新 `parseToolProfile` 用例 + 现有 `resolveToolProfile` 5 条回归全过）。

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tool-profiles.ts tests/mcp/tool-profiles.test.ts
git commit -m "refactor(mcp): extract parseToolProfile three-state parser (#260)"
```

---

## Task 2: `resolveSessionProfile`（HTTP per-session 解析）

**Files:**
- Create: `src/http/session-profile.ts`
- Test: `tests/http/session-profile.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `tests/http/session-profile.test.ts`：

```ts
import { describe, test, expect } from "bun:test";
import { resolveSessionProfile } from "../../src/http/session-profile";
import type { ToolProfile } from "../../src/mcp/tool-profiles";

const URL = "http://127.0.0.1/mcp";

function req(opts: { header?: string; body?: unknown }): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (opts.header !== undefined) headers["x-cbrain-tool-profile"] = opts.header;
  return new Request(URL, {
    method: "POST",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

function init(params: Record<string, unknown> = {}): unknown {
  return {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" }, ...params },
  };
}

const FB: ToolProfile = "full";

describe("resolveSessionProfile (#260)", () => {
  test("header valid → ok, source=header (short-circuits metadata)", async () => {
    const r = await resolveSessionProfile(req({ header: "agent", body: init({ _meta: { cbrainToolProfile: "debug" } }) }), FB);
    expect(r).toEqual({ profile: "agent", source: "header" });
  });
  test("header trims + lowercases", async () => {
    const r = await resolveSessionProfile(req({ header: "  Maintenance " }), FB);
    expect(r).toEqual({ profile: "maintenance", source: "header" });
  });
  test("header invalid → error (no session, no fallback)", async () => {
    const r = await resolveSessionProfile(req({ header: "bogus" }), FB);
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toMatch(/X-CBrain-Tool-Profile/);
  });
  test("metadata _meta valid (header absent) → ok, source=metadata", async () => {
    const r = await resolveSessionProfile(req({ body: init({ _meta: { cbrainToolProfile: "debug" } }) }), FB);
    expect(r).toEqual({ profile: "debug", source: "metadata" });
  });
  test("metadata.metadata path also accepted (compat, non-spec)", async () => {
    const r = await resolveSessionProfile(req({ body: init({ metadata: { cbrainToolProfile: "agent" } }) }), FB);
    expect(r).toEqual({ profile: "agent", source: "metadata" });
  });
  test("_meta takes precedence over metadata when both present", async () => {
    const r = await resolveSessionProfile(req({ body: init({ _meta: { cbrainToolProfile: "debug" }, metadata: { cbrainToolProfile: "agent" } }) }), FB);
    expect(r).toEqual({ profile: "debug", source: "metadata" });
  });
  test("metadata invalid → error (no fallback to full)", async () => {
    const r = await resolveSessionProfile(req({ body: init({ _meta: { cbrainToolProfile: "nope" } }) }), FB);
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toMatch(/cbrainToolProfile/);
  });
  test("both absent → fallback (default)", async () => {
    const r = await resolveSessionProfile(req({ body: init() }), FB);
    expect(r).toEqual({ profile: "full", source: "default" });
  });
  test("non-JSON body → metadata absent, falls back (does not throw)", async () => {
    const r = await resolveSessionProfile(new Request(URL, { method: "POST", headers: { "content-type": "text/plain" }, body: "not json" }), "agent");
    expect(r).toEqual({ profile: "agent", source: "default" });
  });
  test("non-initialize-shaped body (no params) → metadata absent, falls back", async () => {
    const r = await resolveSessionProfile(req({ body: { jsonrpc: "2.0", method: "tools/call", params: { name: "x" } } }), FB);
    expect(r).toEqual({ profile: "full", source: "default" });
  });
  test("fallback honors server default (e.g. env-set agent)", async () => {
    const r = await resolveSessionProfile(req({ body: init() }), "maintenance");
    expect(r).toEqual({ profile: "maintenance", source: "default" });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/http/session-profile.test.ts`
Expected: FAIL — `Cannot find module "../../src/http/session-profile"`。

- [ ] **Step 3: 实现 `src/http/session-profile.ts`**

```ts
/**
 * HTTP /mcp per-session tool profile resolution (#260, #251 Phase 2).
 *
 * Same runtime, different tool surfaces per client. Profile is resolved ONCE at
 * new-session initialize and fixed for the session's lifetime (existing-session
 * requests in http/server.ts never call this). Precedence: first explicit signal
 * wins; an explicit-but-invalid signal → 400 (never silently fall back to full,
 * so a typo cannot expose the whole surface).
 *
 *   1. header  X-CBrain-Tool-Profile            (curl / any client that can set headers)
 *   2. initialize params._meta.cbrainToolProfile  (MCP spec _meta — primary metadata path)
 *      initialize params.metadata.cbrainToolProfile (non-spec, hand-written client compat)
 *   3. fallback = server ctx.toolProfile          (env CBRAIN_MCP_TOOL_PROFILE, default "full")
 *
 * NOT an authz boundary — any local trusted client may request "full". Profile is a
 * UX/tool-routing selector only (see spec §6.4, hard-constraint #4).
 */
import { parseToolProfile, TOOL_PROFILES } from "../mcp/tool-profiles.js";
import type { ToolProfile } from "../mcp/tool-profiles.js";

export type SessionProfileResolution =
  | { profile: ToolProfile; source: "header" | "metadata" | "default" }
  | { error: string };

const HEADER_NAME = "x-cbrain-tool-profile";
const META_KEY = "cbrainToolProfile";
const VALID_LIST = TOOL_PROFILES.join(", ");

function invalidError(field: string, raw: string): string {
  return `Invalid ${field}=${JSON.stringify(raw)}. Expected one of: ${VALID_LIST}.`;
}

/**
 * Read the profile signal from the initialize request body.
 * Clones the request so the original body stays consumable by transport.handleRequest.
 * Returns undefined for: non-JSON, non-initialize shape, or missing field. Never throws.
 */
async function readInitMetaProfile(req: Request): Promise<string | undefined> {
  try {
    const body = (await req.clone().json()) as { params?: unknown };
    const params = body?.params;
    if (params && typeof params === "object") {
      const p = params as { _meta?: Record<string, unknown>; metadata?: Record<string, unknown> };
      const raw = p._meta?.[META_KEY] ?? p.metadata?.[META_KEY];
      if (typeof raw === "string") return raw;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function resolveSessionProfile(
  req: Request,
  fallback: ToolProfile,
): Promise<SessionProfileResolution> {
  const header = parseToolProfile(req.headers.get(HEADER_NAME));
  if (header.kind === "invalid") {
    return { error: invalidError("X-CBrain-Tool-Profile", header.raw) };
  }
  if (header.kind === "ok") {
    return { profile: header.profile, source: "header" };
  }

  // header absent → consult initialize metadata
  const meta = parseToolProfile(await readInitMetaProfile(req));
  if (meta.kind === "invalid") {
    return { error: invalidError(`initialize metadata ${META_KEY}`, meta.raw) };
  }
  if (meta.kind === "ok") {
    return { profile: meta.profile, source: "metadata" };
  }

  return { profile: fallback, source: "default" };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/http/session-profile.test.ts`
Expected: 全部 PASS（11 条）。

- [ ] **Step 5: Commit**

```bash
git add src/http/session-profile.ts tests/http/session-profile.test.ts
git commit -m "feat(http): resolveSessionProfile per-session profile parser (#260)"
```

---

## Task 3: `handleMcp` 接入 + `McpSession` 字段 + log

**Files:**
- Modify: `src/http/server.ts:1-9`（imports）、`:50-55`（McpSession）、`:97-124`（new-session 分支）

- [ ] **Step 1: 先确认现有 MCP 相关测试绿**

Run: `bun test tests/mcp/attach-tools.test.ts`
Expected: 全部 PASS。

- [ ] **Step 2: 改 imports + `McpSession`**

`src/http/server.ts` 顶部 imports（行 1-9 区域）加两行。改后 imports 段含：

```ts
import { z } from "zod";
import type { ToolContext } from "../mcp/context.js";
import { registerAllTools } from "../mcp/register.js";
import { attachMcpTools } from "../mcp/server.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { resolveSessionProfile } from "./session-profile.js";
import type { ToolProfile } from "../mcp/tool-profiles.js";
import { version } from "../version.js";
```

`McpSession`（行 50-55）加 profile/source：

```ts
/** One MCP-over-HTTP client session (issue #213): its own server + transport, sharing the single ctx. */
interface McpSession {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  lastSeen: number;
  /** #260: per-session resolved profile (observability; not used in dispatch). */
  profile: ToolProfile;
  source: "header" | "metadata" | "default";
}
```

- [ ] **Step 3: 改 new-session 分支接入 resolveSessionProfile**

`src/http/server.ts` 行 97-124 的 `if (!sessionId) { ... }` 块，在 `MAX_MCP_SESSIONS` 检查之后、建 transport 之前插入解析；建 session 时存 profile/source + log。改后该块为：

```ts
    // New session (initialize: no sessionId header yet)
    if (!sessionId) {
      if (sessions.size >= MAX_MCP_SESSIONS) {
        return new Response("too many concurrent MCP sessions", { status: 503 });
      }

      // #260: resolve this client's tool profile ONCE at session creation. Header
      // X-CBrain-Tool-Profile > initialize _meta/metadata > ctx default. An explicit
      // invalid signal → 400 (no session, no silent fallback to full). Existing-session
      // requests above never reach here, so a session's profile is fixed for its life.
      const resolved = await resolveSessionProfile(req, ctx.toolProfile);
      if ("error" in resolved) {
        return new Response(JSON.stringify({ error: resolved.error }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      // Derived ctx — never mutate the shared ctx. attachMcpTools reads ctx.toolProfile.
      const sessionCtx: ToolContext = { ...ctx, toolProfile: resolved.profile };

      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessionclosed: (sid) => { sessions.delete(sid); },
      });
      const mcpServer = new McpServer({ name: "cbrain", version });
      attachMcpTools(mcpServer, sessionCtx); // identical registration path, per-session profile
      try {
        await mcpServer.connect(transport);
        const response = await transport.handleRequest(req);
        if (transport.sessionId) {
          sessions.set(transport.sessionId, {
            server: mcpServer, transport, lastSeen: Date.now(),
            profile: resolved.profile, source: resolved.source,
          });
          console.error(
            `> /mcp session ${transport.sessionId} profile=${resolved.profile} source=${resolved.source}`,
          );
        } else {
          // initialize did not establish a session — don't leak the half-built server
          await mcpServer.close().catch(() => { /* best effort */ });
        }
        return response;
      } catch (e) {
        // initialize/connect failed — clean up, never retain a broken session
        await mcpServer.close().catch(() => { /* best effort */ });
        console.error("> /mcp session init failed:", e instanceof Error ? e.message : String(e));
        return new Response("MCP session init failed", { status: 500 });
      }
    }
```

**关键：existing-session 分支（原行 91-95）一字不改** —— 审查点 1。

- [ ] **Step 4: 确认 `attachMcpTools` 和 tool handlers 零改动**

Run: `git diff --stat src/mcp/server.ts src/mcp/register.ts src/mcp/tools/`
Expected: 空输出（这些文件零 diff）—— 审查点 6。

- [ ] **Step 5: 跑 attach-tools 回归**

Run: `bun test tests/mcp/attach-tools.test.ts tests/mcp/tool-profiles.test.ts`
Expected: 全部 PASS。

- [ ] **Step 6: tsc 类型检查**

Run: `bun run lint`
Expected: PASS（tsc + biome）。

- [ ] **Step 7: Commit**

```bash
git add src/http/server.ts
git commit -m "feat(http): per-session tool profile on /mcp new sessions (#260)"
```

---

## Task 4: maintenance wrapper 三处 header

**Files:**
- Modify: `bin/cbrain-maintenance.sh`（行 34-37 / 59-63 / 69-73 三处 curl）
- Modify: `tests/cli/cbrain-maintenance-wrapper.test.ts`（加 header 存在断言）

- [ ] **Step 1: 写失败测试**

在 `tests/cli/cbrain-maintenance-wrapper.test.ts` 的 describe 块末尾（行 76 的 `});` 之前）加：

```ts
  test("declares X-CBrain-Tool-Profile: maintenance on every MCP request (#260)", () => {
    const src = readFileSync(WRAPPER, "utf-8");
    // Three MCP curl calls: initialize, notifications/initialized, tools/call.
    // Each must carry the profile header so the per-session runtime assigns maintenance.
    const profileHeaders = src
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .filter((l) => l.includes("X-CBrain-Tool-Profile: maintenance"));
    // initialize + notifications/initialized + tools/call = 3
    expect(profileHeaders.length).toBe(3);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/cli/cbrain-maintenance-wrapper.test.ts`
Expected: FAIL — `expected 0 to be 3`。

- [ ] **Step 3: 给三处 curl 加 header**

`bin/cbrain-maintenance.sh`：

(a) initialize（行 34-37），在 `-H 'Accept: ...'` 行之后加一行 `-H 'X-CBrain-Tool-Profile: maintenance'`：

```bash
INIT_HEADERS="$(curl -s -o /dev/null -D - -X POST "$CBRAIN_MCP_URL" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'X-CBrain-Tool-Profile: maintenance' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"${PROTOCOL_VERSION}\",\"capabilities\":{},\"clientInfo\":{\"name\":\"cbrain-maintenance\",\"version\":\"1.0\"}}}" 2>&1)"
```

(b) notifications/initialized（行 59-63），在 `-H "mcp-session-id: ..."` 行之后加：

```bash
if ! curl -sf -o /dev/null -X POST "$CBRAIN_MCP_URL" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SESSION" \
  -H 'X-CBrain-Tool-Profile: maintenance' \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' 2>&1; then
```

(c) tools/call dream（行 69-73），在 `-H "mcp-session-id: ..."` 行之后加：

```bash
if ! curl -sf -X POST "$CBRAIN_MCP_URL" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SESSION" \
  -H 'X-CBrain-Tool-Profile: maintenance' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"dream","arguments":{}}}'; then
```

- [ ] **Step 4: 跑 wrapper 全套测试**

Run: `bun test tests/cli/cbrain-maintenance-wrapper.test.ts`
Expected: 全部 PASS（原 4 条 + 新 1 条）。

- [ ] **Step 5: Commit**

```bash
git add bin/cbrain-maintenance.sh tests/cli/cbrain-maintenance-wrapper.test.ts
git commit -m "feat(maint): declare maintenance profile on all MCP requests (#260)"
```

---

## Task 5: E2E — 三 session 三工具面

**Files:**
- Create: `tests/http/mcp-per-session.test.ts`

- [ ] **Step 1: 写 E2E 测试**

创建 `tests/http/mcp-per-session.test.ts`：

```ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildContext } from "../../src/mcp/context.js";
import type { CBrainDeps } from "../../src/mcp/server.js";
import { createHttpServer } from "../../src/http/server.js";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { DeterministicEmbeddingProvider } from "../../src/embedding/deterministic.js";
import { LanceDBManager } from "../../src/storage/lancedb.js";
import { collectRegisteredToolNames } from "../helpers/mcp-inventory";

const TEST_DIR = "/tmp/cbrain-test-per-session";
const PROTOCOL_VERSION = "2025-11-25";

function makeDeps(): CBrainDeps {
  const dbPath = join(TEST_DIR, "brain.sqlite");
  const vaultPath = join(TEST_DIR, "vault");
  const runtimePath = join(TEST_DIR, "runtime");
  return {
    db: new CBrainDB(dbPath),
    embedding: new DeterministicEmbeddingProvider(),
    lance: new LanceDBManager(),
    vaultPath,
    dbPath,
    runtimePath,
  };
}

describe("HTTP /mcp per-session tool profiles (#260)", () => {
  let httpServer: ReturnType<ReturnType<typeof createHttpServer>["start"]>;
  let endpoint: URL;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(join(TEST_DIR, "vault"), { recursive: true });
    mkdirSync(join(TEST_DIR, "runtime"), { recursive: true });
    const ctx = buildContext(makeDeps()); // default toolProfile = "full"
    httpServer = createHttpServer(ctx).start(0);
    endpoint = new URL(`http://127.0.0.1:${httpServer.port}/mcp`);
  });
  afterEach(() => {
    httpServer.stop(true);
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  async function listTools(profileHeader?: string): Promise<string[]> {
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: profileHeader ? { headers: { "X-CBrain-Tool-Profile": profileHeader } } : {},
    });
    const client = new Client({ name: "e2e", version: "0.0.0" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    await client.close();
    return tools.map((t) => t.name).sort();
  }

  test("client A (header agent) → bounded ≤20, excludes admin/low-level tools", async () => {
    const names = await listTools("agent");
    expect(names.length).toBeLessThanOrEqual(20);
    for (const t of ["query", "get_chunks", "dream", "sync", "health", "job_submit"]) {
      expect(names, `agent must exclude ${t}`).not.toContain(t);
    }
    for (const t of ["cbrain_recall", "deep_recall", "ingest", "status"]) {
      expect(names).toContain(t);
    }
  });

  test("client B (header maintenance) → dream/health/job_* reachable, no agent frontdoor", async () => {
    const names = await listTools("maintenance");
    for (const t of ["dream", "dream_status", "dream_reset", "health", "sync", "job_submit", "status"]) {
      expect(names, `maintenance must include ${t}`).toContain(t);
    }
    expect(names).not.toContain("cbrain_recall");
  });

  test("client C (no header, no metadata) → full inventory", async () => {
    const names = await listTools();
    const inventory = collectRegisteredToolNames();
    expect(names.length).toBe(inventory.length);
    expect(names).toEqual(inventory);
  });

  test("client D (header bogus) → initialize rejected, no session created", async () => {
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { "X-CBrain-Tool-Profile": "bogus" } },
    });
    const client = new Client({ name: "e2e-bad", version: "0.0.0" });
    await expect(client.connect(transport)).rejects.toThrow();
  });

  test("client E (initialize _meta.cbrainToolProfile=debug) → session established (metadata path)", async () => {
    // SDK client cannot inject params._meta, so hand-fire initialize like the maintenance wrapper.
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "meta-probe", version: "1.0" },
          _meta: { cbrainToolProfile: "debug" },
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeTruthy();
    // Tool-surface correctness for metadata→debug is covered jointly by
    // resolveSessionProfile unit tests (metadata→debug) and attach-tools.test.ts (debug→query/get_chunks).
  });

  test("client F (agent session) → dream not registered; calling it fails (profile fixed for session)", async () => {
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { "X-CBrain-Tool-Profile": "agent" } },
    });
    const client = new Client({ name: "e2e-fixed", version: "0.0.0" });
    await client.connect(transport);
    // dream is gated out of agent and the profile is fixed at initialize — a later
    // tools/call (which carries no profile header) still cannot reach it.
    await expect(client.callTool({ name: "dream", arguments: {} })).rejects.toThrow();
    await client.close();
  });

  test("three sessions on one runtime get three different surfaces (acceptance #8)", async () => {
    const [agent, maint, full] = await Promise.all([
      listTools("agent"),
      listTools("maintenance"),
      listTools(),
    ]);
    expect(agent).not.toEqual(maint);
    expect(agent).not.toEqual(full);
    expect(maint).not.toEqual(full);
    expect(full.length).toBeGreaterThan(agent.length);
    expect(full.length).toBeGreaterThan(maint.length);
  });
});
```

- [ ] **Step 2: 跑 E2E**

Run: `bun test tests/http/mcp-per-session.test.ts`
Expected: 全部 PASS（7 条）。若 `client.connect` 对 bogus header 不抛而是挂起，给该 transport 设超时或改断言为"listTools 抛错"——但 v1.12 收到 400 会 reject，预期直接通过。

- [ ] **Step 3: Commit**

```bash
git add tests/http/mcp-per-session.test.ts
git commit -m "test(http): E2E per-session tool profiles on /mcp (#260)"
```

---

## Task 6: 全量门禁 + code review

- [ ] **Step 1: 全量 lint**

Run: `bun run lint`
Expected: PASS（tsc --noEmit + biome lint）。

- [ ] **Step 2: 重点测试套件**

Run: `bun test tests/mcp/attach-tools.test.ts tests/cli/cbrain-maintenance-wrapper.test.ts tests/http/session-profile.test.ts tests/http/mcp-per-session.test.ts tests/mcp/tool-profiles.test.ts`
Expected: 全部 PASS。

- [ ] **Step 3: 全量 check**

Run: `bun run check`
Expected: PASS（lint + 全量 test）。注意 memory：fresh worktree 缺 node_modules 会冒 release gate fail——已在主 repo，node_modules 存在，不受影响。

- [ ] **Step 4: 审查点终检**

逐条核对 §"宏哥的 8 个审查点 → 验证映射"：
- 审查点 1：`git diff src/http/server.ts` 确认 existing-session 分支（`if (sessionId && sessions.has(sessionId))`）零改动。
- 审查点 6：`git diff --stat src/mcp/server.ts src/mcp/register.ts src/mcp/tools/` 空输出。

- [ ] **Step 5: code review**

dispatch code-reviewer agent over the branch diff。修完 CRITICAL/HIGH 再收尾。

- [ ] **Step 6: 收尾**

按 superpowers:finishing-a-development-branch 决定 merge / PR / cleanup。push 由 Hermes 负责（CLAUDE.md：commit 后不 push）。

---

## Self-Review（plan 作者自查）

**Spec 覆盖：**
- §4 机制（header>_meta>metadata>env）→ Task 2 + Task 3 ✓
- §4.2 决策表全行 → Task 2 单测 11 条覆盖每一行 ✓
- §5 五条硬约束 → 逐条映射到 Task（约束1→T3 existing 分支不改+E2E F；约束2→T2 readInitMetaProfile try-catch；约束3→T2 invalid error；约束4→session-profile.ts 文件头注释+spec 引用；约束5→T4 三处 header）✓
- §6.1 parseToolProfile → Task 1 ✓
- §6.2 resolveSessionProfile → Task 2 ✓
- §6.3 handleMcp 接入 + McpSession 字段 + log → Task 3 ✓
- §6.5 maintenance wrapper 三处 → Task 4 ✓
- §9.2 E2E 矩阵 A-F → Task 5 ✓
- §10 验收 → Task 5 + Task 6 ✓

**Placeholder 扫描：** 无 TBD/TODO；每个代码块完整；每个 Run 命令带 Expected。

**类型一致性：** `parseToolProfile(raw: string | null | undefined)` 在 Task 1 定义，Task 2 调用（header `string | null`、meta `string | undefined`）签名匹配；`SessionProfileResolution` 在 Task 2 定义、Task 3 消费（`"error" in resolved` + `resolved.profile/source`）匹配；`McpSession.profile/source` Task 3 定义、set 时赋值匹配。

**风险点（实现时注意）：**
- E2E `client.connect` 对 400 的行为：v1.12 预期 reject；若 SDK 改为重试/挂起，client D 断言调整为带超时的 rejects。
- `bun run check` 在 worktree：确保 worktree 有 node_modules（见 memory `worktree-fresh-node-modules-gate`）。

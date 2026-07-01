# MCP Tool Surface Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `agent / maintenance / debug / full` MCP tool-exposure profiles, filtered at the registration layer, so a bounded surface is available for daily Agents while `full` preserves today's behavior exactly.

**Architecture:** Resolve a `ToolProfile` once at startup from `CBRAIN_MCP_TOOL_PROFILE` (env > `full`; config support deferred), thread it `CBrainDeps → ToolContext`, and gate registrations inside the existing `attachMcpTools` monkey-patch — skipping disallowed tools for **both** `server.registerTool` and legacy `server.tool`. Because stdio (`createServer`) and HTTP `/mcp` per-session both route through `attachMcpTools`, one filter covers every MCP path. `full` short-circuits the gate so current behavior is byte-identical.

**Tech Stack:** Bun, TypeScript (strict), `@modelcontextprotocol/sdk` (`McpServer`), `bun:test`, Zod.

---

## Critical design findings (read before implementing)

Verified against `main` (post-#252) on 2026-07-01. Cite current line numbers before editing — they drift.

1. **Single registration chokepoint.** `attachMcpTools(server, ctx)` at `src/mcp/server.ts:66` monkey-patches `server.registerTool` with an error-sanitization wrapper, then calls `registerAllTools(server, ctx)` (`src/mcp/register.ts:35`), a flat list of 31 `registerXxxTools(server, ctx)` calls. Every tool file calls `server.registerTool(...)` or `server.tool(...)` directly on the passed `server`.

2. **Two coexisting APIs.** 81 tools use `server.registerTool(name, {description, inputSchema}, handler)`. **3 tools** in `src/mcp/tools/provenance.ts` (`get_provenance`, `set_trust_state`, `confirm_evidence`) use legacy `server.tool(name, description, schema, handler)`.

3. **Sanitization asymmetry (must preserve).** The current patch wraps `server.registerTool` only. The 3 `server.tool` provenance tools are **NOT** error-sanitized today. The new `server.tool` gate must be filter-only — **no try-catch** — or it silently changes provenance error behavior (forbidden by the issue).

4. **stdio + `/mcp` already share one path.** `createServer(deps)` (`src/mcp/server.ts:85`) calls `attachMcpTools`. HTTP `/mcp` per-session init (`src/http/server.ts:107`) calls `attachMcpTools` on a fresh `McpServer` sharing the runtime ctx — there's even a comment "identical to stdio registration — no second path". Filtering in `attachMcpTools` covers both.

5. **REST `/tools` bypasses `attachMcpTools`.** `createToolRegistry` (`src/http/server.ts:39`) calls `registerAllTools(collector, ctx)` on a mock collector directly. **Phase 1 leaves REST full-surface** (documented scope boundary). Default is `full` so this is invisible in production.

6. **Maintenance cron uses `/mcp`, NOT the CLI.** `bin/cbrain-maintenance.sh` calls `dream` via `curl POST /mcp tools/call`; `tests/cli/cbrain-maintenance-wrapper.test.ts` asserts it is curl-only. `docs/patrol.md` health-checks via `/mcp`. **Therefore the production `/mcp` runtime MUST stay `full` (or `maintenance`) or cron + patrol break.** This is why Phase 1 default is `full` and "Hermes opts into `agent`" is a Phase 2 concern, not an env flip on the shared runtime.

7. **Threading precedent.** `nerIngestMode` already flows `CBrainDeps` → `buildContext` → `ToolContext` (the #252 pattern). Phase 1 threads `toolProfile` the same way but resolves from **env only** (no config schema churn — config support is a later, properly-typed add).

8. **Docs gate spies `registerAllTools` with no profile.** `bin/check-docs-consistency.ts:getMcpTools()` (lines 79-96) returns all 84 tools. That is **correct** — docs document the `full` set. Do not change it; only *add* a profiles section to `docs/mcp-tools.md`.

---

## Phase 1 scope boundary (explicit)

**In scope:** profile type + allowlists + resolver; threading via ctx; gating in `attachMcpTools` covering `registerTool` + `server.tool`; tests; docs; consolidation audit. **Default `full` = zero production behavior change.**

> ⚠️ **Real-world effect of Phase 1 — read before writing any commit message or PR line.**
> Phase 1 ships the profile *infrastructure* + tests + the consolidation audit. It does **not** shrink the production Hermes tool count. The shared HTTP `/mcp` runtime stays on `full` (maintenance cron + patrol depend on `dream`/`health` over `/mcp`), so every client of that runtime — **including Hermes** — still sees all 84 tools. Giving Hermes the bounded `agent` surface is **Phase 2**: either per-session/per-client profile selection on `/mcp`, or a dedicated Agent runtime separate from the maintenance runtime. Do **not** claim "Hermes now sees ≤20 tools" anywhere — that is not what Phase 1 delivers. The win Phase 1 does deliver: the filtering machinery exists, is tested, and is safe to opt into per-runtime (e.g. a dev box, or a future dedicated Agent runtime).

**Out of scope (Phase 2 follow-ups, do NOT implement):**
- Per-session/per-request profile selection on `/mcp` (would let Hermes use `agent` while maintenance uses `full` on the same runtime).
- Config-file (`cbrain.json`) profile support — Phase 1 is **env + explicit programmatic option only**. Adding it later means a proper `mcp?: { toolProfile?: ToolProfile }` field on `CBrainConfig` with tests, not a defensive `as` cast.
- REST `/tools` profile filtering.
- Actually merging/renaming/rewriting any tool handler.
- CLI surface changes, LLM routing, schema changes.

---

## File Structure

**Create:**
- `src/mcp/tool-profiles.ts` — `ToolProfile` type, allowlists, `resolveToolProfile`, `isToolAllowedForProfile`. Pure, no `register.ts` import.
- `tests/helpers/mcp-inventory.ts` — `collectRegisteredToolNames()` test/docs helper (spy + noop ctx). Lives under `tests/` so production code cannot grow a dependency on it.
- `tests/mcp/tool-profiles.test.ts` — unit tests for the above + allowlist validity vs. real inventory.
- `tests/cli/tool-profile-threading.test.ts` — `buildContext`/`createDeps` threading + env resolution.
- `docs/mcp-tool-consolidation-audit.md` — the consolidation audit (scope-update deliverable #2).

**Modify:**
- `src/mcp/server.ts` — add `toolProfile` to `CBrainDeps`; rewrite `attachMcpTools` to gate both APIs.
- `src/mcp/context.ts` — add `toolProfile` to `ToolContext` + `buildContext` param; default `"full"`.
- `src/cli/context.ts` — resolve env in `createDeps`, populate `deps.toolProfile`.
- `tests/mcp/attach-tools.test.ts` — add profile-filtering tests (full/agent/maintenance/debug, provenance gating, stdio==/mcp, behavioral sanitization-asymmetry).
- `tests/release/check-docs-consistency.test.ts` — add a case that a profiles section in `docs/mcp-tools.md` is allowed (doesn't trip the gate).
- `docs/mcp-tools.md` — add "Tool surface profiles" section.
- `docs/patrol.md` — operational warning: production `/mcp` must stay `full`/`maintenance`.
- `README.md` (or `docs/install-onboarding.md`) — short profile-selection note.

> **Do NOT modify `src/mcp/register.ts`.** The inventory helper is a test concern, not a production capability (see Task 2).

---

## Task 1: `tool-profiles.ts` — type, allowlists, resolver, gate helper

**Files:**
- Create: `src/mcp/tool-profiles.ts`
- Test: `tests/mcp/tool-profiles.test.ts`

- [ ] **Step 1: Write the failing test (unit logic + allowlist shape)**

Create `tests/mcp/tool-profiles.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import {
  TOOL_PROFILES,
  TOOL_PROFILE_ALLOWLISTS,
  resolveToolProfile,
  isToolAllowedForProfile,
} from "../../src/mcp/tool-profiles";

describe("resolveToolProfile (env only)", () => {
  test("env value resolves", () => {
    expect(resolveToolProfile("agent")).toBe("agent");
    expect(resolveToolProfile("maintenance")).toBe("maintenance");
    expect(resolveToolProfile("debug")).toBe("debug");
    expect(resolveToolProfile("full")).toBe("full");
  });
  test("absent / empty / whitespace defaults to full", () => {
    expect(resolveToolProfile(undefined)).toBe("full");
    expect(resolveToolProfile("")).toBe("full");
    expect(resolveToolProfile("   ")).toBe("full");
  });
  test("trims + lowercases", () => {
    expect(resolveToolProfile("  AGENT ")).toBe("agent");
  });
  test("invalid fails fast with the env var name in the message", () => {
    expect(() => resolveToolProfile("garbage")).toThrow(/CBRAIN_MCP_TOOL_PROFILE/);
  });
  test("every member of TOOL_PROFILES resolves", () => {
    for (const p of TOOL_PROFILES) expect(resolveToolProfile(p)).toBe(p);
  });
});

describe("isToolAllowedForProfile", () => {
  test("full allows everything", () => {
    expect(isToolAllowedForProfile("anything", "full")).toBe(true);
    expect(isToolAllowedForProfile("query", "full")).toBe(true);
  });
  test("agent excludes low-level/admin tools", () => {
    for (const t of ["query", "get_chunks", "dream", "dream_status", "dream_reset", "sync", "health",
      "job_submit", "job_list", "job_status", "job_cancel", "job_retry", "relation_audit",
      "watcher_quarantine", "get_provenance", "set_trust_state", "confirm_evidence"]) {
      expect(isToolAllowedForProfile(t, "agent")).toBe(false);
    }
  });
  test("agent includes the documented user-facing surface", () => {
    for (const t of ["cbrain_recall", "deep_recall", "ingest", "get_page", "put_page",
      "merge_entities", "get_org_tree", "status"]) {
      expect(isToolAllowedForProfile(t, "agent")).toBe(true);
    }
  });
  test("maintenance includes dream + job_* + sync + health + relation_audit", () => {
    for (const t of ["dream", "dream_status", "dream_reset", "sync", "health", "relation_audit",
      "job_submit", "job_list", "job_status", "job_cancel", "job_retry", "status", "wakeup_diff"]) {
      expect(isToolAllowedForProfile(t, "maintenance")).toBe(true);
    }
  });
  test("debug includes query + get_chunks + list_pages + provenance", () => {
    for (const t of ["query", "get_chunks", "list_pages", "get_links", "get_tags",
      "get_versions", "get_ingest_log", "get_provenance", "set_trust_state", "confirm_evidence"]) {
      expect(isToolAllowedForProfile(t, "debug")).toBe(true);
    }
  });
});

describe("allowlist shape", () => {
  test("only agent/maintenance/debug have allowlists (not full)", () => {
    expect(TOOL_PROFILE_ALLOWLISTS.agent).toBeInstanceOf(Array);
    expect(TOOL_PROFILE_ALLOWLISTS.maintenance).toBeInstanceOf(Array);
    expect(TOOL_PROFILE_ALLOWLISTS.debug).toBeInstanceOf(Array);
    expect((TOOL_PROFILE_ALLOWLISTS as Record<string, unknown>).full).toBeUndefined();
  });
  test("agent allowlist is bounded <= 20", () => {
    expect(TOOL_PROFILE_ALLOWLISTS.agent.length).toBeLessThanOrEqual(20);
  });
  test("no duplicate names within an allowlist", () => {
    for (const p of ["agent", "maintenance", "debug"] as const) {
      const names = TOOL_PROFILE_ALLOWLISTS[p];
      expect(new Set(names).size).toBe(names.length);
    }
  });
  test("every allowlist entry is a non-empty trimmed string", () => {
    for (const p of ["agent", "maintenance", "debug"] as const) {
      for (const n of TOOL_PROFILE_ALLOWLISTS[p]) {
        expect(typeof n).toBe("string");
        expect(n.length).toBeGreaterThan(0);
        expect(n).toBe(n.trim());
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mcp/tool-profiles.test.ts`
Expected: FAIL — `Cannot find module '../../src/mcp/tool-profiles'`.

- [ ] **Step 3: Write `src/mcp/tool-profiles.ts`**

```ts
/**
 * MCP tool surface profiles (#251).
 *
 * A profile is an EXPOSURE-LAYER filter only. It never deletes, renames, merges,
 * or rewrites tool handlers. Filtering happens in attachMcpTools at registration
 * time (see src/mcp/server.ts). `full` is the no-op profile = current behavior.
 *
 * Resolution (Phase 1): env CBRAIN_MCP_TOOL_PROFILE > "full". Config-file support
 * is intentionally deferred — add it later as a typed CBrainConfig field, not a cast.
 * Invalid values fail fast so a misconfigured runtime does not silently ship a
 * partial tool surface (which would break e.g. the maintenance cron on /mcp).
 */

export type ToolProfile = "agent" | "maintenance" | "debug" | "full";

export const TOOL_PROFILES = ["agent", "maintenance", "debug", "full"] as const;

const VALID_PROFILES: ReadonlySet<ToolProfile> = new Set(TOOL_PROFILES);

/**
 * Bounded, user-facing surface for daily Agents (Hermes etc.).
 * Deliberately excludes low-level search (query, get_chunks), all admin/ops
 * tools (dream_*, sync, health, watcher_quarantine, relation_audit), all job_*
 * tools, and provenance tools.
 */
const AGENT_ALLOWLIST = [
  "cbrain_recall",
  "deep_recall",
  "recall_episode",
  "ingest",
  "ingest_dialogue",
  "get_page",
  "get_pages",
  "put_page",
  "append_page",
  "resolve_slugs",
  "get_org_tree",
  "graph_query",
  "get_timeline",
  "read_discoveries",
  "update_discovery_status",
  "find_similar_entities",
  "merge_entities",
  "get_profile",
  "update_profile",
  "status",
] as const;

/**
 * Operational/admin surface for cron + patrol. The maintenance wrapper calls
 * `dream` over HTTP /mcp, and patrol health-checks over /mcp, so this profile
 * MUST keep dream_*, sync, health, job_* reachable.
 */
const MAINTENANCE_ALLOWLIST = [
  "status",
  "health",
  "dream",
  "dream_status",
  "dream_reset",
  "sync",
  "remove_orphans",
  "watcher_quarantine",
  "generate_indexes",
  "enrich",
  "writeback",
  "relation_audit",
  "job_submit",
  "job_list",
  "job_status",
  "job_cancel",
  "job_retry",
  "read_knowledge_map",
  "wakeup_diff",
  "batch_delete_pages",
  "batch_add_links",
  "batch_merge_pages",
] as const;

/**
 * Low-level inspection surface for debugging. Raw search, chunk/page listing,
 * provenance, and add/remove helpers. Excludes the high-level recall frontdoor
 * and ingest write paths on purpose.
 */
const DEBUG_ALLOWLIST = [
  "query",
  "get_chunks",
  "list_pages",
  "get_page",
  "get_pages",
  "get_links",
  "get_tags",
  "get_versions",
  "get_ingest_log",
  "get_provenance",
  "set_trust_state",
  "confirm_evidence",
  "add_link",
  "remove_link",
  "add_tag",
  "remove_tag",
  "add_alias",
  "remove_alias",
] as const;

export const TOOL_PROFILE_ALLOWLISTS: Record<Exclude<ToolProfile, "full">, readonly string[]> = {
  agent: AGENT_ALLOWLIST,
  maintenance: MAINTENANCE_ALLOWLIST,
  debug: DEBUG_ALLOWLIST,
};

function normalize(raw: string | undefined): string | undefined {
  const v = raw?.trim().toLowerCase();
  return v === "" ? undefined : v;
}

/** Resolve profile from env. Undefined/empty → "full". Invalid → throw (fail fast). */
export function resolveToolProfile(env?: string): ToolProfile {
  const resolved = normalize(env);
  if (resolved === undefined) return "full";
  if (!VALID_PROFILES.has(resolved as ToolProfile)) {
    throw new Error(
      `Invalid CBRAIN_MCP_TOOL_PROFILE=${JSON.stringify(resolved)}. ` +
        `Expected one of: ${TOOL_PROFILES.join(", ")}.`,
    );
  }
  return resolved as ToolProfile;
}

/** `full` allows everything; otherwise the name must be in the profile allowlist. */
export function isToolAllowedForProfile(name: string, profile: ToolProfile): boolean {
  if (profile === "full") return true;
  return TOOL_PROFILE_ALLOWLISTS[profile].includes(name);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/mcp/tool-profiles.test.ts`
Expected: PASS (all tests green).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tool-profiles.ts tests/mcp/tool-profiles.test.ts
git commit -m "feat(mcp): tool surface profiles + resolver (#251)"
```

---

## Task 2: Inventory helper `collectRegisteredToolNames` (test helper) + allowlist-validity test

Guarantees every allowlisted name is a REAL tool (typo-proof). The helper lives in **`tests/helpers/`**, not `src/`, so production code can't depend on it. It spies `registerAllTools` with a noop ctx — same trick as `bin/check-docs-consistency.ts:getMcpTools` (lines 69-96), returning only names.

**Files:**
- Create: `tests/helpers/mcp-inventory.ts`
- Test: `tests/mcp/tool-profiles.test.ts` (append a describe block)

- [ ] **Step 1: Write the failing test (append to `tests/mcp/tool-profiles.test.ts`)**

```ts
import { collectRegisteredToolNames } from "../helpers/mcp-inventory";

describe("allowlist validity vs real inventory", () => {
  const all = collectRegisteredToolNames();
  test("inventory is non-empty and unique", () => {
    expect(all.length).toBeGreaterThan(40);
    expect(new Set(all).size).toBe(all.length);
  });
  test("every allowlisted name exists in the full inventory", () => {
    for (const p of ["agent", "maintenance", "debug"] as const) {
      for (const name of TOOL_PROFILE_ALLOWLISTS[p]) {
        expect(all, `profile ${p} references unknown tool ${name}`).toContain(name);
      }
    }
  });
  test("full inventory includes tools excluded from agent", () => {
    for (const t of ["query", "get_chunks", "dream", "sync", "health", "job_submit"]) {
      expect(all).toContain(t);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mcp/tool-profiles.test.ts`
Expected: FAIL — `Cannot find module '../helpers/mcp-inventory'`.

- [ ] **Step 3: Create `tests/helpers/mcp-inventory.ts`**

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../src/mcp/context";
import { registerAllTools } from "../../src/mcp/register";

/**
 * Recursive callable noop — any property access or invocation returns noop.
 * Mirrors makeNoopChain in bin/check-docs-consistency.ts so registerAllTools can
 * dereference ctx fields while registering without touching a real DB.
 */
function makeNoopChain(): unknown {
  const target = function noop() { return undefined; };
  return new Proxy(target, {
    get: () => makeNoopChain(),
    apply: () => undefined,
  });
}

/**
 * Test/docs inventory helper: spy-server + noop ctx, run the REAL registerAllTools,
 * return every tool name that would be registered under `full` (both registerTool
 * and legacy server.tool). Used by profile allowlist tests and the consolidation
 * audit test. NOT a production API — deliberately lives under tests/.
 */
export function collectRegisteredToolNames(): string[] {
  const names: string[] = [];
  const spy = {
    registerTool(name: string): unknown { names.push(name); return {}; },
    tool(name: string): unknown { names.push(name); return {}; },
  } as unknown as McpServer;
  const noopCtx = makeNoopChain() as ToolContext;
  registerAllTools(spy, noopCtx);
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}
```

> If `registerAllTools` dereferences a ctx field in a way the callable-proxy doesn't satisfy at registration time (it shouldn't — handlers are closed over, not invoked), copy `makeNoopChain` verbatim from `bin/check-docs-consistency.ts:69-75` which is proven to work.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/mcp/tool-profiles.test.ts`
Expected: PASS — including allowlist validity. If any allowlisted name is NOT in the inventory, fix the allowlist typo (do not weaken the test).

- [ ] **Step 5: Commit**

```bash
git add tests/helpers/mcp-inventory.ts tests/mcp/tool-profiles.test.ts
git commit -m "test(mcp): validate profile allowlists against real tool inventory (#251)"
```

---

## Task 3: Thread `toolProfile` through `CBrainDeps → ToolContext` (env + explicit option)

Follows the `nerIngestMode` precedent. Env-only resolution; the deps/ctx field is the explicit programmatic override (used by tests and any future caller).

**Files:**
- Modify: `src/mcp/server.ts` (`CBrainDeps` interface, ~line 13-26)
- Modify: `src/mcp/context.ts` (`ToolContext` interface ~line 28-54; `buildContext` param + body ~line 71-101)
- Modify: `src/cli/context.ts` (resolve env in `createDeps`, ~line 129-171)
- Test: `tests/cli/tool-profile-threading.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/cli/tool-profile-threading.test.ts`. Primary assertions at the `buildContext` boundary (pure, deterministic); one `createDeps` env-integration assertion:

```ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite";
import { LanceDBManager } from "../../src/storage/lancedb";
import { DeterministicEmbeddingProvider } from "../../src/embedding/provider";
import { buildContext } from "../../src/mcp/context";
import { createDeps } from "../../src/cli/context";

const ORIG = process.env.CBRAIN_MCP_TOOL_PROFILE;

function tempRoot() { return mkdtempSync(join(tmpdir(), "cbrain-profile-")); }

describe("buildContext threads toolProfile", () => {
  test("explicit profile is set on ctx", () => {
    const root = tempRoot();
    try {
      const db = new CBrainDB(join(root, "brain.sqlite"));
      const ctx = buildContext({
        db, embedding: new DeterministicEmbeddingProvider(), lance: new LanceDBManager(),
        vaultPath: join(root, "vault"), runtimePath: join(root, "runtime"),
        toolProfile: "agent",
      });
      expect(ctx.toolProfile).toBe("agent");
    } finally { rmSync(tempRoot.name, { recursive: true, force: true }); }
  });
  test("defaults to full when absent", () => {
    const root = tempRoot();
    try {
      const db = new CBrainDB(join(root, "brain.sqlite"));
      const ctx = buildContext({
        db, embedding: new DeterministicEmbeddingProvider(), lance: new LanceDBManager(),
        vaultPath: join(root, "vault"), runtimePath: join(root, "runtime"),
      });
      expect(ctx.toolProfile).toBe("full");
    } finally { /* cleanup */ }
  });
});

describe("createDeps resolves CBRAIN_MCP_TOOL_PROFILE", () => {
  beforeEach(() => { delete process.env.CBRAIN_MCP_TOOL_PROFILE; });
  afterEach(() => {
    if (ORIG === undefined) delete process.env.CBRAIN_MCP_TOOL_PROFILE;
    else process.env.CBRAIN_MCP_TOOL_PROFILE = ORIG;
  });
  test("env threads through to deps.toolProfile", () => {
    process.env.CBRAIN_MCP_TOOL_PROFILE = "maintenance";
    const root = tempRoot();
    try {
      // Use the real CBrainConfig shape; mirror an existing createDeps test fixture
      // in tests/cli/ if one exists (grep `createDeps(` in tests/cli/).
      const deps = createDeps({
        vaultPath: join(root, "vault"),
        dbPath: join(root, "brain.sqlite"),
        embedding: { provider: "deterministic", model: "test", apiKey: "k", baseURL: "u" },
      } as never, false);
      expect(deps.toolProfile).toBe("maintenance");
    } finally { /* cleanup */ }
  });
});
```

> The `buildContext` tests are the deterministic core — they must pass. The `createDeps` env test needs a real `CBrainConfig`; before writing it, `grep -n "createDeps(" tests/cli/` to find an existing fixture and copy its config shape exactly. If `createDeps` is too heavy to fixture cleanly, drop the createDeps test and rely on: (a) the `resolveToolProfile` unit test (Task 1) proving env parsing, (b) the `buildContext` test proving threading, (c) `bun run check` integration proving `createDeps` calls the resolver. The one-liner in `createDeps` is low-risk.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/tool-profile-threading.test.ts`
Expected: FAIL — `ctx.toolProfile` is `undefined` / `deps.toolProfile` does not exist.

- [ ] **Step 3: Add `toolProfile` to `CBrainDeps` (`src/mcp/server.ts`)**

In the `CBrainDeps` interface, after the `nerIngestMode?: IngestNerMode;` line:

```ts
  /** #251: resolved MCP tool surface profile (env > full), threaded into buildContext. */
  toolProfile?: ToolProfile;
```

Add the import at the top of `src/mcp/server.ts`:

```ts
import type { ToolProfile } from "./tool-profiles.js";
```

- [ ] **Step 4: Add `toolProfile` to `ToolContext` + `buildContext` (`src/mcp/context.ts`)**

In the `ToolContext` interface, add:

```ts
  toolProfile: ToolProfile;
```

In `buildContext(deps: {...})`, add `toolProfile?: ToolProfile;` to the inline param type, and in the returned object add:

```ts
    toolProfile: deps.toolProfile ?? "full",
```

Add the import:

```ts
import type { ToolProfile } from "./tool-profiles.js";
```

- [ ] **Step 5: Resolve env in `createDeps` (`src/cli/context.ts`)**

Near the `nerIngestMode` resolution (~line 169), add:

```ts
  const toolProfile = resolveToolProfile(process.env.CBRAIN_MCP_TOOL_PROFILE);
```

Include `toolProfile` in the returned deps object. Add the import:

```ts
import { resolveToolProfile } from "../mcp/tool-profiles.js";
```

> Env-only. Do NOT add a defensive `(config as ...).mcp?.toolProfile` read — config support is Phase 2 with a real typed field.

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test tests/cli/tool-profile-threading.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the full mcp/cli test suites to confirm no regressions**

Run: `bun test tests/mcp/ tests/cli/`
Expected: PASS — existing tests unaffected (`toolProfile` defaults to `"full"`, no behavioral change).

- [ ] **Step 8: Commit**

```bash
git add src/mcp/server.ts src/mcp/context.ts src/cli/context.ts tests/cli/tool-profile-threading.test.ts
git commit -m "feat(mcp): thread toolProfile CBrainDeps→ToolContext (#251)"
```

---

## Task 4: Gate registrations in `attachMcpTools` (both APIs, preserve sanitize asymmetry)

The core change. `full` short-circuits → byte-identical to today.

**Files:**
- Modify: `src/mcp/server.ts` (`attachMcpTools`, ~line 66-83)
- Test: `tests/mcp/attach-tools.test.ts` (append profile tests)

- [ ] **Step 1: Write the failing tests (append to `tests/mcp/attach-tools.test.ts`)**

Add imports at top:

```ts
import type { ToolProfile } from "../../src/mcp/tool-profiles";
import { collectRegisteredToolNames } from "../helpers/mcp-inventory";
import { buildContext } from "../../src/mcp/context";
```

Append (reuse the file's existing `makeDeps` + `listToolsViaClient` helpers; add a `callToolViaClient` helper for the behavioral test):

```ts
async function callToolViaClient(server: McpServer, name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "probe", version: "0.0.0" });
  await client.connect(clientSide);
  try {
    return await client.callTool({ name, arguments: args });
  } catch (e) {
    // SDK may surface a thrown handler error as a JSON-RPC error; return it for inspection.
    return e;
  }
}

async function listToolsWithProfile(profile: ToolProfile): Promise<string[]> {
  const deps = makeDeps();
  const server = createServer({ ...deps, toolProfile: profile });
  const names = await listToolsViaClient(server);
  return names.sort();
}

describe("attachMcpTools profile gating", () => {
  test("full exposes the complete inventory (no filtering)", async () => {
    const names = await listToolsWithProfile("full");
    const inventory = collectRegisteredToolNames();
    expect(names.length).toBe(inventory.length);
    expect(names).toEqual(inventory);
  });

  test("agent is bounded and excludes low-level/admin tools", async () => {
    const names = await listToolsWithProfile("agent");
    expect(names.length).toBeLessThanOrEqual(20);
    for (const t of ["query", "get_chunks", "dream", "sync", "health", "job_submit"]) {
      expect(names, `agent must exclude ${t}`).not.toContain(t);
    }
    for (const t of ["cbrain_recall", "deep_recall", "ingest", "status"]) {
      expect(names).toContain(t);
    }
  });

  test("maintenance keeps dream + health + job_* + sync reachable", async () => {
    const names = await listToolsWithProfile("maintenance");
    for (const t of ["dream", "dream_status", "dream_reset", "sync", "health", "relation_audit", "job_submit", "status"]) {
      expect(names).toContain(t);
    }
  });

  test("debug includes query + get_chunks + provenance", async () => {
    const names = await listToolsWithProfile("debug");
    for (const t of ["query", "get_chunks", "list_pages", "get_provenance", "set_trust_state", "confirm_evidence"]) {
      expect(names).toContain(t);
    }
  });

  test("legacy server.tool provenance tools are gated (agent excludes, debug includes)", async () => {
    const agent = await listToolsWithProfile("agent");
    const debug = await listToolsWithProfile("debug");
    for (const t of ["get_provenance", "set_trust_state", "confirm_evidence"]) {
      expect(agent).not.toContain(t);
      expect(debug).toContain(t);
    }
  });

  test("stdio and HTTP /mcp expose the same surface for the same profile", async () => {
    // createServer (stdio path) vs standalone attachMcpTools (the /mcp session path)
    const stdioNames = (await listToolsWithProfile("agent")).sort();
    const deps = makeDeps();
    const httpServer = new McpServer({ name: "cbrain", version: "0.0.0" });
    attachMcpTools(httpServer, { ...buildContext(deps), toolProfile: "agent" });
    const httpNames = (await listToolsViaClient(httpServer)).sort();
    expect(httpNames).toEqual(stdioNames);
  });
});
```

> `{ ...buildContext(deps), toolProfile: "agent" }` — `buildContext` returns a full `ToolContext`; spreading + overriding `toolProfile` simulates an explicit-option caller. If `buildContext` is not exported or the spread fights the type, instead build deps with `toolProfile` set and call `buildContext({ ...deps, toolProfile: "agent" })`. The assertion target is unchanged: both paths go through `attachMcpTools` with profile `agent` → identical exposed set.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/mcp/attach-tools.test.ts`
Expected: FAIL — `full` may pass but `agent` exposes all 84 (no gating yet); `get_provenance` appears in `agent`.

- [ ] **Step 3: Rewrite `attachMcpTools` to gate both APIs (`src/mcp/server.ts`)**

Replace the existing `attachMcpTools` body (lines ~66-83) with:

```ts
export function attachMcpTools(server: McpServer, ctx: ToolContext): void {
  const profile: ToolProfile = ctx.toolProfile ?? "full";
  const gate = profile === "full" ? null : new Set(TOOL_PROFILE_ALLOWLISTS[profile]);

  // registerTool: error-sanitize (unchanged) + profile gate (new).
  // Gating happens BEFORE the sanitized handler is registered; tools that pass
  // the gate keep byte-identical error-sanitization behavior.
  const origRegister = server.registerTool.bind(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).registerTool = (name: string, def: any, handler: (...a: any[]) => Promise<any>) => {
    if (gate && !gate.has(name)) return; // #251: profile-filtered, skip registration
    origRegister(name, def, async (...a: any[]) => {
      try {
        return await handler(...a);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: sanitizeError(msg) }) }],
          isError: true,
        };
      }
    });
  };

  // server.tool: profile gate ONLY. Deliberately NO try-catch — the 3 legacy
  // provenance tools are not error-sanitized today and the issue forbids changing
  // handler behavior. This patch is filter-only.
  const origTool = server.tool.bind(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).tool = (...args: any[]) => {
    const name = args[0];
    if (gate && typeof name === "string" && !gate.has(name)) return; // #251: filtered
    return origTool(...args);
  };

  registerAllTools(server, ctx);
}
```

Add imports at top of `src/mcp/server.ts`:

```ts
import type { ToolProfile } from "./tool-profiles.js";
import { TOOL_PROFILE_ALLOWLISTS } from "./tool-profiles.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/mcp/attach-tools.test.ts`
Expected: PASS — all profile gating tests green, including provenance gating and stdio==/mcp.

- [ ] **Step 5: Add the behavioral sanitization-asymmetry test (NOT a `toString` check)**

The concern: the new `server.tool` patch must NOT inject a try-catch (which would silently start sanitizing the 3 provenance tools). Assert this **behaviorally** — register one probe via each API with an identical throwing handler, invoke both, and compare the error text the client sees.

Append to `tests/mcp/attach-tools.test.ts`:

```ts
describe("error sanitization asymmetry (behavioral, preserved)", () => {
  test("registerTool handler errors are sanitized; legacy server.tool handler errors are NOT", async () => {
    const deps = makeDeps();
    const server = new McpServer({ name: "cbrain", version: "0.0.0" });
    attachMcpTools(server, { ...buildContext(deps), toolProfile: "full" });
    // A raw message the sanitizer would mangle: matches the SQLite + path rules in sanitizeError.
    const RAW = "SQLite: no such table: fixture_table at /tmp/sanitize-probe/fixture.sqlite3";

    // registerTool path — sanitized
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).registerTool(
      "zzz_register_probe",
      { description: "probe", inputSchema: {} },
      async () => { throw new Error(RAW); },
    );
    // legacy server.tool path — NOT sanitized (filter-only patch)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).tool(
      "zzz_legacy_probe",
      "probe",
      {},
      async () => { throw new Error(RAW); },
    );

    const regResult = await callToolViaClient(server, "zzz_register_probe");
    const legacyResult = await callToolViaClient(server, "zzz_legacy_probe");
    const regText = JSON.stringify(regResult);
    const legacyText = JSON.stringify(legacyResult);

    // Sanitized: the raw fixture path is gone and the db-error tail is replaced.
    expect(regText).not.toContain("/tmp/sanitize-probe/fixture.sqlite3");
    expect(regText).toContain("[db-error]");
    // NOT sanitized: the raw message survives intact (whatever envelope the SDK uses).
    expect(legacyText).toContain("no such table: fixture_table");
    expect(legacyText).toContain("/tmp/sanitize-probe/fixture.sqlite3");
  });
});
```

> This is the real invariant lock. If the `server.tool` patch accidentally wraps the handler, `legacyText` would contain `[db-error]` and NOT the raw path — and this test fails. If the SDK surfaces the thrown error in a way the assertion doesn't catch (e.g. it never reaches `callToolViaClient`'s return), adjust the envelope extraction, but keep the assertion: **registerTool output is sanitized, server.tool output is raw**. Do not weaken it to a source-string check.

- [ ] **Step 6: Run the full mcp suite**

Run: `bun test tests/mcp/`
Expected: PASS — including the pre-existing `server.test.ts` 87-tool list (profile defaults to `full`).

- [ ] **Step 7: Commit**

```bash
git add src/mcp/server.ts tests/mcp/attach-tools.test.ts
git commit -m "feat(mcp): gate tool registration by profile in attachMcpTools (#251)"
```

---

## Task 5: Docs — profiles section, patrol warning, onboarding note

**Files:**
- Modify: `docs/mcp-tools.md` (add section; do NOT touch the auto-gen `mcp-tools` block — it must keep listing all tools)
- Modify: `docs/patrol.md` (operational warning)
- Modify: `README.md` or `docs/install-onboarding.md` (short note)

- [ ] **Step 1: Add "Tool surface profiles" section to `docs/mcp-tools.md`**

Insert AFTER the auto-generated tool index section (so the auto-gen block stays intact and `check-docs-consistency` regenerates only that block). Anonymous/synthetic examples only:

```markdown
## Tool surface profiles

CBrain exposes the same tools to every client by default (`full`). You can select a
smaller surface **per runtime** with `CBRAIN_MCP_TOOL_PROFILE`:

| Profile | Intended client | Surface |
|:--------|:----------------|:--------|
| `full` (default) | local dev, backward compat, the shared `/mcp` runtime | all tools |
| `agent` | daily user-facing Agents | ~20 user-facing tools; excludes `query`, `get_chunks`, `dream*`, `sync`, `health`, `job_*`, provenance |
| `maintenance` | cron / patrol / admin over `/mcp` | `dream*`, `sync`, `health`, `job_*`, `relation_audit`, `wakeup_diff`, … |
| `debug` | low-level inspection | `query`, `get_chunks`, `list_pages`, provenance, add/remove helpers, … |

Selection: `CBRAIN_MCP_TOOL_PROFILE=agent|maintenance|debug|full` (env > `full`; no config-file
support yet). Unknown values fail fast at startup.

> **Phase 1 boundary:** profiles are infrastructure + tests only. The production `/mcp` runtime
> stays on `full` because `bin/cbrain-maintenance.sh` calls `dream` over `/mcp` and patrol
> health-checks over `/mcp`. **Do not set the shared runtime to `agent`** — it hides `dream`/`health`
> and breaks cron + patrol. Giving a daily Agent the `agent` surface on the same runtime requires
> future per-session profile support (or a dedicated Agent runtime).
```

- [ ] **Step 2: Add the operational warning to `docs/patrol.md`**

Near the line that says cron goes over HTTP/MCP, add:

```markdown
- **Profile constraint:** the shared `/mcp` runtime must stay on `full` or `maintenance`
  (`CBRAIN_MCP_TOOL_PROFILE`). `agent` hides `dream`/`health` and will break this patrol
  and `bin/cbrain-maintenance.sh`.
```

- [ ] **Step 3: Add a short note to `README.md` (or `docs/install-onboarding.md`)**

```markdown
### MCP tool profiles

Set `CBRAIN_MCP_TOOL_PROFILE=agent|maintenance|debug|full` to choose the MCP tool surface
(default `full`; env only). See `docs/mcp-tools.md#tool-surface-profiles`. Keep the shared
`/mcp` runtime on `full`/`maintenance` — the maintenance cron depends on it.
```

- [ ] **Step 4: Run docs consistency gate**

Run: `bun run check:docs`
Expected: PASS — the gate validates tool *names* against the full inventory; the new section only references real tool names and adds a non-auto-gen section, so it must stay green. If it fails, the section likely landed inside the auto-gen block — move it outside.

- [ ] **Step 5: Commit**

```bash
git add docs/mcp-tools.md docs/patrol.md README.md
git commit -m "docs(mcp): document tool surface profiles + patrol warning (#251)"
```

---

## Task 6: Consolidation audit doc + test

Scope-update deliverable #2: a deterministic, tested grouping of merge candidates. No code changes to handlers.

**Files:**
- Create: `docs/mcp-tool-consolidation-audit.md`
- Test: `tests/release/tool-consolidation-audit.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/release/tool-consolidation-audit.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { collectRegisteredToolNames } from "../helpers/mcp-inventory";

const AUDIT = join(process.cwd(), "docs", "mcp-tool-consolidation-audit.md");

describe("tool consolidation audit", () => {
  test("doc exists", () => {
    expect(() => readFileSync(AUDIT, "utf-8")).not.toThrow();
  });

  test("has required sections", () => {
    const src = readFileSync(AUDIT, "utf-8");
    for (const heading of [
      "# MCP Tool Consolidation Audit",
      "## Summary",
      "## Merge candidates",
      "## Keep separate",
      "## Recommended sequencing",
    ]) {
      expect(src, `missing heading ${heading}`).toContain(heading);
    }
  });

  test("every tool name referenced exists in the real inventory", () => {
    const src = readFileSync(AUDIT, "utf-8");
    const inventory = new Set(collectRegisteredToolNames());
    // Match backtick-quoted snake_case tokens that look like tool names (contain "_").
    const refs = [...src.matchAll(/`([a-z][a-z0-9_]+)`/g)].map((m) => m[1]);
    const unknown = refs.filter((r) => r.includes("_") && !inventory.has(r));
    expect(unknown, `audit references unknown tools: ${unknown.join(", ")}`).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/release/tool-consolidation-audit.test.ts`
Expected: FAIL — `docs/mcp-tool-consolidation-audit.md` does not exist.

- [ ] **Step 3: Write `docs/mcp-tool-consolidation-audit.md`**

Anonymous, deterministic. Each candidate states proposed unified tool, compatibility concern, risk, and timing relative to Hermes skill updates.

````markdown
# MCP Tool Consolidation Audit

> Generated for #251. This is an audit INPUT for follow-up issues — **no tools are merged in #251.**
> Profiles (`agent`/`maintenance`/`debug`/`full`) already reduce cognitive load at the exposure layer;
> consolidation is a separate, opt-in step that must coordinate with Hermes skill updates.

## Summary

84 tools today: 81 via `registerTool`, 3 legacy `server.tool` (provenance). Many cluster into
domain groups whose members differ only by an action verb. A unified tool with an `action` param
would shrink the surface, but each merge is a breaking change for any caller that references the
old names (notably Hermes skills).

## Merge candidates

For each: **proposed** unified tool · **compat concern** · **risk** · **timing** (before/after Hermes skill updates).

| Group | Members | Proposed unified | Compat concern | Risk | Timing |
|:------|:--------|:-----------------|:---------------|:-----|:-------|
| Tag ops | `get_tags`, `add_tag`, `remove_tag` | `tag` (`action: list\|add\|remove`) | Hermes skills call by exact name | Low | After |
| Alias ops | `add_alias`, `remove_alias` | `alias` (`action: add\|remove`) | Same | Low | After |
| Link ops | `add_link`, `remove_link`, `get_links` | `link` (`action: list\|add\|remove`) | Same | Low | After |
| Hierarchy | `set_hierarchy`, `get_hierarchy`, `remove_hierarchy` | `hierarchy` (`action`) | `get_org_tree` stays separate (different shape) | Med | After |
| Job ops | `job_submit`, `job_list`, `job_status`, `job_cancel`, `job_retry` | `job` (`action`) | Maintenance cron calls `dream`, not `job_*` directly — safe-ish | Med | After |
| Dream | `dream`, `dream_status`, `dream_reset` | `dream` (`action: run\|status\|reset`) | **`bin/cbrain-maintenance.sh` calls `dream`** — keep run as default action | Med | After (with wrapper coord) |
| Batch | `batch_delete_pages`, `batch_add_links`, `batch_merge_pages` | `batch` (`action`) | Lower traffic | Low | After |
| Profile | `get_profile`, `update_profile`, `remove_profile`, `reload_profile` | `profile` (`action`) | Hermes uses `get_profile`/`update_profile` | Med | After |
| Insights | `list_insights`, `get_insight`, `archive_insight`, `dismiss_insight`, `query_insights`, `promote_discovery` | `insight` (`action`) | Many call sites | Med | After |

## Keep separate

These must NOT merge — different layers, semantics, or shapes:

- `merge_pages` (record/source layer) vs `merge_entities` (derived layer) — the `canMerge` layer rule forbids cross-layer merges.
- `query` vs `cbrain_recall` vs `deep_recall` — intentionally tiered recall (raw / frontdoor / deep). Merging defeats the routing goal of #251.
- `ingest` vs `ingest_dialogue` — different input shapes and pipelines.
- `get_page` / `get_pages` / `list_pages` — single vs plural vs raw-listing are distinct access patterns.
- Provenance trio (`get_provenance`, `set_trust_state`, `confirm_evidence`) — legacy `server.tool` API; consolidate only after migrating them to `registerTool` (which also gains them error sanitization — call that out as a behavior change).

## Recommended sequencing

1. Ship profiles (#251) — done first, lets us observe Agent routing with a bounded surface before any merge.
2. Migrate the 3 provenance tools from `server.tool` to `registerTool` (gains sanitization — document it).
3. Merge low-risk groups (tag/alias/link/batch) behind the existing names as deprecated aliases first.
4. Update Hermes skills to the unified names.
5. Remove deprecated aliases.

````

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/release/tool-consolidation-audit.test.ts`
Expected: PASS. If the "unknown tools" assertion trips on a non-tool snake_case token (e.g. a config key), reword that token in the doc — do not weaken the inventory check for real tool names.

- [ ] **Step 5: Commit**

```bash
git add docs/mcp-tool-consolidation-audit.md tests/release/tool-consolidation-audit.test.ts
git commit -m "docs(mcp): tool consolidation audit (#251)"
```

---

## Task 7: Verification gate

- [ ] **Step 1: Lint**

Run: `bun run lint`
Expected: PASS (tsc strict + biome). The `(server as any)` casts mirror the existing pattern in `attachMcpTools`; keep the `eslint-disable` comments already present.

- [ ] **Step 2: Targeted MCP + docs tests (issue verification minimum)**

Run:
```bash
bun test tests/mcp/attach-tools.test.ts tests/mcp/server.test.ts tests/mcp/tool-profiles.test.ts
bun test tests/cli/tool-profile-threading.test.ts
bun test tests/release/check-docs-consistency.test.ts tests/release/tool-consolidation-audit.test.ts
bun run check:docs
```
Expected: all PASS.

- [ ] **Step 3: Maintenance-wrapper test still green**

Run: `bun test tests/cli/cbrain-maintenance-wrapper.test.ts`
Expected: PASS — wrapper unchanged; default `full` keeps `dream` reachable.

- [ ] **Step 4: Full check**

Run: `bun run check`
Expected: PASS. If impractical (time), report exactly which focused gates ran and why full check was deferred.

- [ ] **Step 5: Final spec-coverage self-review**

Walk #251 acceptance criteria 1–12 + scope-update additions against the tasks above; confirm each is covered. Confirm no public test/doc fixture contains real private names, paths, orgs, products, or vault content (anonymous only). Confirm no commit message or PR line claims Hermes' tool count dropped — Phase 1 does not deliver that.

---

## Acceptance criteria → task mapping

| #251 criterion | Covered by |
|:--|:--|
| 1. `full` = current tool set | Task 4 (full exposes complete inventory) |
| 2. `agent` ≤ 20, documented | Task 1 + Task 4 + Task 5 |
| 3. `maintenance` ops tools | Task 1 + Task 4 |
| 4. `debug` low-level tools | Task 1 + Task 4 |
| 5. unknown profile fails fast | Task 1 (resolver) + Task 3 |
| 6. existing registration tests pass | Task 7 (server.test.ts green) |
| 7. both `registerTool` + legacy `server.tool` filtered; provenance regression target | Task 4 |
| 8. `full` includes agent-excluded tools | Task 2 + Task 4 |
| 9. `agent` excludes `query`, `get_chunks`, `dream`, `sync`, `health`, `job_*` | Task 1 + Task 4 |
| 10. docs consistency / inventory accurate | Task 5 + Task 7 (`check:docs` green, `getMcpTools` unchanged) |
| 11. maintenance wrapper / patrol still reach ops tools | default `full` + Task 5 warning + Task 7 |
| 12. anonymous fixtures only | enforced across all test/doc steps |
| scope-add: consolidation audit | Task 6 |

---

## Notes for the executor

- **Verify line numbers before editing** — they drift; the explore snapshot is from 2026-07-01 post-#252.
- **Do not touch** `sanitizeError`, the `registerTool` try-catch body, `registerAllTools`'s 31 calls, `bin/check-docs-consistency.ts:getMcpTools`, `src/mcp/register.ts`, or any tool handler.
- **The `server.tool` patch is filter-only.** Adding a try-catch there is the easiest mistake to make and the most forbidden — Task 4 Step 5 locks it behaviorally.
- **REST `/tools` stays full-surface in Phase 1** (documented boundary). Don't filter `createToolRegistry`.
- **Env-only.** No `config as ...` casts. Config-file support is Phase 2 with a real typed `CBrainConfig` field.
- All commits end with the `(#251)` trailer; do not push or close the issue (release-owner job).

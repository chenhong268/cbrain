# Default Smart Recall Latency / Degraded Split — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop labeling slow-but-complete recall as `degraded`, and stop default smart recall from calling LLM `expandQuery` for simple lookups — cutting the 67.7% degraded rate.

**Architecture:** Three independent levers. (1) `search-diagnostics.ts` splits latency-only into a `latency_warning` (not degraded) and quality-gates `parser_fallback`. (2) `search.ts` gates `expandQuery` behind `isComplexQuery || FTS<3`, reusing the FTS probe (no double-query), and adds a budget guard mirroring #222. (3) `perf-diagnose.ts` reports `latency_warning_rate` + `by_latency_warning_reason` separately from degraded.

**Tech Stack:** Bun, TypeScript (strict), `bun:test`. Pure diagnostic functions + `HybridSearch`.

**Spec:** `docs/superpowers/specs/2026-06-29-recall-latency-degraded-design.md`

**Execution:** M-level worktree, inline TDD. Touches search core — one context, RED→GREEN per task, `bun run lint` + relevant tests each.

**Hard constraints (from 宏哥):** no ranking change, no DB schema change, no #230 threshold change, no #222 decompose-guard change. `expandQuery` gate = `isComplexQuery(query) || FTS results < 3`. FTS probe MUST be reused. latency-only → warning, not degraded. parser_fallback quality-gated. perf-diagnose splits rates. No push, no close.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/core/search-diagnostics.ts` | Modify | `computeSearchDegraded` drops latency-only; new `WARNING_REASON_CODES` + `computeLatencyWarning`; `DEGRADED_REASON_CODES` drops `latency_budget_exceeded` + `fts_parser_fallback`. |
| `src/core/search.ts` | Modify | `searchCore` smart path runs a bounded FTS probe + gates `expandQuery`; `searchWithExpansion` accepts `initialFts` (no double-query); `expandQuery` gets timeout + call-count guard. |
| `src/mcp/tools/recall.ts` | Modify | `diagnosticMeta` carries `latency_warning`; passes reason codes to `computeSearchDegraded`. |
| `src/mcp/tools/search.ts` | Modify | Same `latency_warning` plumbing as recall.ts. |
| `src/release/perf-diagnose.ts` | Modify | `summary.latency_warning_rate`; `by_latency_warning_reason`; `by_degraded_reason` excludes `latency_budget_exceeded`. |
| `tests/core/search-diagnostics.test.ts` | Modify | Update latency tests to new semantics; add warning + parser_fallback tests. |
| `tests/core/search-latency-gate.test.ts` | Create | expandQuery gate + FTS reuse + budget guard. |
| `tests/release/perf-diagnose-latency-split.test.ts` | Create | degraded_rate vs latency_warning_rate independence. |

**Reuse (do NOT reimplement):** `isComplexQuery` (search.ts:95), `#222` guards `MAX_DEFAULT_LLM_CALLS`/`MAX_DEFAULT_DECOMPOSE_MS` (search.ts:319-320), `ftsSearch`, `LOW_SCORE_THRESHOLD` (search-diagnostics.ts:68).

---

## Task 1: latency-only split in search-diagnostics

**Files:**
- Modify: `src/core/search-diagnostics.ts:149-193`
- Test: `tests/core/search-diagnostics.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/core/search-diagnostics.test.ts`:

```ts
import { computeLatencyWarning, WARNING_REASON_CODES } from "../../src/core/search-diagnostics.js";

describe("latency-only split (#250)", () => {
  test("latency-only slow → NOT degraded (quality is fine)", () => {
    // good results, no retrieval reason, just slow
    expect(computeSearchDegraded(5000, {}, [])).toBe(false);
  });

  test("latency-only slow → latency_warning true", () => {
    expect(computeLatencyWarning(5000, [])).toBe(true);
  });

  test("latency-only fast → no latency_warning", () => {
    expect(computeLatencyWarning(500, [])).toBe(false);
  });

  test("latency_budget_exceeded code alone → NOT degraded (moved to warning)", () => {
    expect(computeSearchDegraded(50, {}, ["latency_budget_exceeded"])).toBe(false);
  });

  test("fts_parser_fallback code alone + would-be-good → NOT degraded", () => {
    // parser fallback is a warning unless empty/low also apply
    expect(computeSearchDegraded(50, {}, ["fts_parser_fallback"])).toBe(false);
  });

  test("latency slow + real retrieval degraded → degraded AND warning", () => {
    expect(computeSearchDegraded(5000, {}, ["vector_timeout"])).toBe(true);
    expect(computeLatencyWarning(5000, ["vector_timeout"])).toBe(true);
  });

  test("WARNING_REASON_CODES contains latency_budget_exceeded + fts_parser_fallback", () => {
    expect(WARNING_REASON_CODES.has("latency_budget_exceeded")).toBe(true);
    expect(WARNING_REASON_CODES.has("fts_parser_fallback")).toBe(true);
    expect(WARNING_REASON_CODES.has("vector_timeout")).toBe(false);
  });

  test("parser_fallback + good results → NOT degraded (warning only)", () => {
    // fts_parser_fallback is warning-only; real degradation comes from a
    // simultaneous fts_empty / low_score code, NOT from parser_fallback itself.
    expect(computeSearchDegraded(100, { fts_fallback: true }, ["fts_parser_fallback"])).toBe(false);
  });

  test("parser_fallback + empty results → degraded via fts_empty (not via parser_fallback)", () => {
    expect(computeSearchDegraded(100, { fts_fallback: true }, ["fts_parser_fallback", "fts_empty"])).toBe(true);
  });
});
```

Also **update** the two existing tests that encode the old semantics (they WILL fail after the impl change — that's the point):

Replace:
```ts
  test("latency > 2000ms → degraded", () => {
    expect(computeSearchDegraded(2500, {}, [])).toBe(true);
  });
```
with:
```ts
  test("latency > 2000ms alone → NOT degraded (#250: latency-only is a warning)", () => {
    expect(computeSearchDegraded(2500, {}, [])).toBe(false);
  });
```

Replace:
```ts
  test("latency_budget_exceeded code + low latency → degraded", () => {
    expect(computeSearchDegraded(50, {}, ["latency_budget_exceeded"])).toBe(true);
  });
```
with:
```ts
  test("latency_budget_exceeded code + low latency → NOT degraded (#250)", () => {
    expect(computeSearchDegraded(50, {}, ["latency_budget_exceeded"])).toBe(false);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/core/search-diagnostics.test.ts`
Expected: FAIL — `computeLatencyWarning` not exported; latency-only still degraded.

- [ ] **Step 3: Write minimal implementation**

Edit `src/core/search-diagnostics.ts`:

(a) Add `WARNING_REASON_CODES` and `computeLatencyWarning` after `DEGRADED_REASON_CODES` (line 181) and **remove `latency_budget_exceeded` + `fts_parser_fallback` from `DEGRADED_REASON_CODES`**:

```ts
const DEGRADED_REASON_CODES: ReadonlySet<DegradedReasonCode> = new Set([
  "vector_timeout",
  "vector_error",
  "fts_empty",
  "low_score",
  "budget_exhausted",
  "fallback_used",
  "reasoning_parse_failed",
]);

/**
 * #250 — Warning-only reason codes: observable but do NOT force status=degraded.
 * - latency_budget_exceeded: slow but complete.
 * - fts_parser_fallback: query syntax downgraded to LIKE; degraded only if
 *   results are also empty/low (those codes stay in DEGRADED_REASON_CODES).
 */
export const WARNING_REASON_CODES: ReadonlySet<DegradedReasonCode> = new Set([
  "latency_budget_exceeded",
  "fts_parser_fallback",
]);

/** #250 — latency_warning: slow (over threshold) regardless of degradation. */
export function computeLatencyWarning(
  latencyMs: number,
  _reasonCodes: DegradedReasonCode[],
  latencyThreshold = 2000,
): boolean {
  return latencyMs > latencyThreshold;
}
```

(b) Rewrite `computeSearchDegraded` to drop the latency-only branch:

```ts
export function computeSearchDegraded(
  latencyMs: number,
  trace: { degraded_reason?: string },
  reasonCodes: DegradedReasonCode[],
  _latencyThreshold = 2000,
): boolean {
  // #250: latency alone is NOT degraded (it's a latency_warning). Only real
  // retrieval degradation forces status=degraded.
  if (trace.degraded_reason) return true;
  if (reasonCodes.some(code => DEGRADED_REASON_CODES.has(code))) return true;
  return false;
}
```

(`classifyDegradedReasons` is unchanged — it still emits `latency_budget_exceeded` + `fts_parser_fallback` for observability; they just no longer force degraded.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/core/search-diagnostics.test.ts`
Expected: PASS (existing latency tests now reflect new semantics; new warning tests pass).

- [ ] **Step 5: Commit**

```bash
git add src/core/search-diagnostics.ts tests/core/search-diagnostics.test.ts
git commit -m "fix(search): latency-only and parser_fallback no longer force degraded (#250)"
```

---

## Task 2: surface latency_warning in recall + search MCP

**Files:**
- Modify: `src/mcp/tools/recall.ts` (diagnosticMeta, ~line 205-213) and `src/mcp/tools/search.ts` (same pattern)
- Test: `tests/mcp/recall-km-context.test.ts` is unrelated; use a new focused test file `tests/mcp/recall-latency-warning.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/mcp/recall-latency-warning.test.ts`:

```ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { createServer, type CBrainDeps } from "../../src/mcp/server.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";

function createMockEmbedding(): EmbeddingProvider {
  return {
    dimensions: 128,
    embed: async (text: string) => ({ embedding: new Array(128).fill(0).map((_, i) => (text.charCodeAt(i % text.length) ?? 0) / 65536), tokenCount: text.length }),
    embedBatch: async (texts: string[]) => texts.map((t) => ({ embedding: new Array(128).fill(0).map((_, i) => (t.charCodeAt(i % t.length) ?? 0) / 65536), tokenCount: t.length })),
  };
}
function createMockLanceDB() {
  return { connect: async () => {}, addChunks: async () => {}, search: async () => [], fullTextSearch: async () => [], deleteByPageSlug: async () => {}, deleteRawChunksByPageSlug: async () => {}, close: async () => {}, createFTSIndex: async () => {} };
}
function getTools(server: unknown) {
  return (server as { _registeredTools: Record<string, { handler: (input: unknown) => Promise<unknown> }> })._registeredTools;
}

describe("deep_recall latency_warning (#250)", () => {
  const testDir = "/tmp/cbrain-test-recall-latency";
  const dbPath = join(testDir, "t.sqlite");
  const vaultPath = join(testDir, "vault");
  let db: CBrainDB;
  let deps: CBrainDeps;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(dbPath);
    deps = { db, embedding: createMockEmbedding(), lance: createMockLanceDB() as never, vaultPath, runtimePath: join(dirname(dbPath), "runtime") };
  });
  afterEach(() => { db.close(); if (existsSync(testDir)) rmSync(testDir, { recursive: true }); });

  function seedAlphaPage() {
    db.rawDb.prepare("INSERT INTO pages (slug, type, title, file_path, content_hash, tier, mention_count) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("entity/alpha", "entity/person", "实体Alpha", "entity-alpha.md", "h1", 1, 5);
    db.rawDb.prepare("INSERT INTO chunks (page_slug, chunk_index, content) VALUES (?, ?, ?)").run("entity/alpha", 0, "实体Alpha 的标记内容");
    db.rawDb.prepare("INSERT INTO chunks_fts (page_slug, content) VALUES (?, ?)").run("entity/alpha", "实体Alpha 的标记内容");
  }

  test("exact title match, FAST → not degraded, latency_warning absent (score=1, no FTS-score dependency)", async () => {
    seedAlphaPage();
    const server = createServer(deps);
    // query == page title → exact-match fast path, score 1.0 (deterministic,
    // independent of FTS scoring).
    const r = await getTools(server).deep_recall.handler({ query: "实体Alpha", include_raw: true }) as { content: Array<{ text: string }> };
    const payload = JSON.parse(r.content[0].text);
    expect(payload.summary?.status).not.toBe("degraded");
    expect(payload.raw?.search_meta?.latency_warning).toBeUndefined();
  });

  test("high-score vector hit, SLOW (injected latency) → latency_warning true, not degraded", async () => {
    seedAlphaPage();
    // Slow vector path returns a delayed HIGH-score hit (low _distance 0.05).
    // The "good result" assertion relies on the vector hit score, NOT FTS — so
    // this test does not depend on FTS scoring at all. (2100ms < VECTOR_TIMEOUT_MS
    // 5000, so the vector call completes normally — not a timeout.)
    const slowLance = { ...createMockLanceDB(), search: async () => {
      await new Promise((r) => setTimeout(r, 2100));
      return [{ pageSlug: "entity/alpha", chunkIndex: 0, content: "实体Alpha 的标记内容", _distance: 0.05 }];
    }};
    const slowDeps = { ...deps, lance: slowLance as never };
    const server = createServer(slowDeps);
    // Non-exact query so the exact-title fast path does NOT short-circuit — the
    // slow vector path actually runs and drives the latency_warning.
    const r = await getTools(server).deep_recall.handler({ query: "标记内容", include_raw: true }) as { content: Array<{ text: string }> };
    const payload = JSON.parse(r.content[0].text);
    expect(payload.summary?.status).not.toBe("degraded"); // high-score vector hit
    expect(payload.raw?.search_meta?.latency_warning).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mcp/recall-latency-warning.test.ts`
Expected: FAIL — `latency_warning` not present in `search_meta`.

- [ ] **Step 3: Write minimal implementation**

In `src/mcp/tools/recall.ts`, import `computeLatencyWarning` and add it to `diagnosticMeta` (around line 205-213). The `diagnosticMeta` object currently builds `reason_codes` etc; add:

```ts
import { classifyDegradedReasons, computeSearchDegraded, computeLatencyWarning } from "../../core/search-diagnostics.js";
```

Then in the `diagnosticMeta` const:

```ts
    const diagnosticMeta = {
      strategy: usedStrategy,
      latency_ms: searchLatencyMs,
      degraded: isSearchDegraded || undefined,
      latency_warning: computeLatencyWarning(searchLatencyMs, reasonCodes) || undefined,
      candidate_count: candidateCount,
      ...(candidateHasMore ? { truncated: true, has_more: true } : {}),
      ...(reasonCodes.length > 0 ? { reason_codes: reasonCodes } : {}),
      ...(gateResult.filteredCount > 0 ? { quality_gate: { filtered: gateResult.filteredCount, reason_codes: gateResult.reasonCodes } } : {}),
    };
```

(`computeSearchDegraded` is already called as `isSearchDegraded` above; its new no-latency-only semantics flow through automatically.)

Apply the **same** `latency_warning` addition to `src/mcp/tools/search.ts`'s diagnosticMeta (mirror the pattern — find its `degraded:` line and add `latency_warning:` next to it using `computeLatencyWarning`).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/mcp/recall-latency-warning.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/recall.ts src/mcp/tools/search.ts tests/mcp/recall-latency-warning.test.ts
git commit -m "feat(recall): surface latency_warning in raw search_meta (#250)"
```

---

## Task 3: expandQuery gate + FTS probe reuse

**Files:**
- Modify: `src/core/search.ts` (`searchCore` ~line 477, `searchWithExpansion` ~521, `searchSingleQuery` ~480)
- Test: `tests/core/search-latency-gate.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/core/search-latency-gate.test.ts`:

```ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { HybridSearch } from "../../src/core/search.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";

function mockEmbed(): EmbeddingProvider {
  return {
    dimensions: 128,
    embed: async (t: string) => ({ embedding: new Array(128).fill(0).map((_, i) => (t.charCodeAt(i % t.length) ?? 0) / 65536), tokenCount: t.length }),
    embedBatch: async (ts: string[]) => ts.map((t) => ({ embedding: new Array(128).fill(0).map((_, i) => (t.charCodeAt(i % t.length) ?? 0) / 65536), tokenCount: t.length })),
  };
}

describe("expandQuery gate (#250)", () => {
  const dir = "/tmp/cbrain-test-latency-gate";
  const dbPath = join(dir, "t.sqlite");
  let db: CBrainDB;

  beforeEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true });
    db = new CBrainDB(dbPath);
  });
  afterEach(() => { db.close(); if (existsSync(dir)) rmSync(dir, { recursive: true }); });

  // content is parameterized so a test can seed FTS hits that MATCH its query
  // tokens — otherwise the FTS probe returns 0 and the test never exercises the
  // "FTS sufficient" branch.
  function seedFtsHits(n: number, content = "唯一标记内容片段") {
    for (let i = 0; i < n; i++) {
      const slug = `entity/fts-${i}`;
      db.rawDb.prepare("INSERT INTO pages (slug, type, title, file_path, content_hash, tier, mention_count) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(slug, "entity/person", `实体${i}`, `${slug}.md`, "h1", 1, 3);
      db.rawDb.prepare("INSERT INTO chunks (page_slug, chunk_index, content) VALUES (?, ?, ?)").run(slug, 0, content);
      db.rawDb.prepare("INSERT INTO chunks_fts (page_slug, content) VALUES (?, ?)").run(slug, content);
    }
  }

  test("simple query + FTS>=3 → expandQuery NOT called", async () => {
    seedFtsHits(3);
    const llm = { name: "mock", chat: async () => { throw new Error("should not be called"); }, expandQuery: async () => { throw new Error("expandQuery should not be called"); } };
    const search = new HybridSearch(db, mockEmbed(), { connect: async () => {}, addChunks: async () => {}, search: async () => [], fullTextSearch: async () => [], deleteByPageSlug: async () => {}, deleteRawChunksByPageSlug: async () => {}, close: async () => {}, createFTSIndex: async () => {} } as never, { llm: llm as never });
    const results = await search.search("唯一标记");
    expect(results.length).toBeGreaterThan(0);
    // expandQuery must not have thrown → it was skipped
  });

  test("simple query + FTS empty → expandQuery IS called", async () => {
    let expandCalled = false;
    const llm = { name: "mock", chat: async () => "{}", expandQuery: async () => { expandCalled = true; return ["唯一标记"]; } };
    const search = new HybridSearch(db, mockEmbed(), { connect: async () => {}, addChunks: async () => {}, search: async () => [], fullTextSearch: async () => [], deleteByPageSlug: async () => {}, deleteRawChunksByPageSlug: async () => {}, close: async () => {}, createFTSIndex: async () => {} } as never, { llm: llm as never });
    await search.search("查无此物的标记zzz");
    expect(expandCalled).toBe(true);
  });

  test("complex query → expandQuery IS called even with FTS>=3", async () => {
    // Seed FTS hits whose content MATCHES the complex query tokens, so the FTS
    // probe genuinely returns >=3 and this exercises the complex-branch of the
    // gate (isComplex wins over ftsSufficient).
    seedFtsHits(3, "主题A 主题B 共同标记内容");
    let expandCalled = false;
    const llm = { name: "mock", chat: async () => "{}", expandQuery: async () => { expandCalled = true; return ["主题A", "主题B"]; } };
    const search = new HybridSearch(db, mockEmbed(), { connect: async () => {}, addChunks: async () => {}, search: async () => [], fullTextSearch: async () => [], deleteByPageSlug: async () => {}, deleteRawChunksByPageSlug: async () => {}, close: async () => {}, createFTSIndex: async () => {} } as never, { llm: llm as never });
    // complex + _skipDecompose: isolate the expandQuery gate. Without
    // _skipDecompose, a complex query enters the decompose branch first and we'd
    // be testing decompose, not the expand gate.
    await search.search("主题A 和 主题B", { _skipDecompose: true });
    expect(expandCalled).toBe(true);
  });

  test("FTS empty + explicit multiQuery:false → expandQuery NOT called (caller opt-out beats gate)", async () => {
    let expandCalled = false;
    const llm = { name: "mock", chat: async () => "{}", expandQuery: async () => { expandCalled = true; return ["主题A"]; } };
    const search = new HybridSearch(db, mockEmbed(), { connect: async () => {}, addChunks: async () => {}, search: async () => [], fullTextSearch: async () => [], deleteByPageSlug: async () => {}, deleteRawChunksByPageSlug: async () => {}, close: async () => {}, createFTSIndex: async () => {} } as never, { llm: llm as never });
    // FTS empty (no seed) AND multiQuery:false → must NOT expand, even though FTS
    // is insufficient. Caller opt-out beats the isComplexQuery||FTS<3 gate.
    await search.search("查无此物zzz", { multiQuery: false });
    expect(expandCalled).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/core/search-latency-gate.test.ts`
Expected: FAIL — first test throws (expandQuery IS called today because `multiQueryEnabled` defaults true).

- [ ] **Step 3: Write minimal implementation**

In `src/core/search.ts`:

(a) Add an FTS-sufficiency constant near the #222 guards (line 320):

```ts
/** #250 — FTS probe is "sufficient" at this many results → skip expandQuery LLM. */
const FTS_SUFFICIENT_RESULTS = 3;
```

(b) Change the final `searchCore` return (line 477) to run a bounded FTS probe, decide the gate, and pass `initialFts` so it's reused:

```ts
    // #250 — bounded FTS probe to gate expandQuery. Timed + fail-open (mirrors
    // searchSingleQuery's FTS path: timedCall records fts_ms, catch returns [] on
    // failure) so trace/error semantics stay consistent. Reused as initialFts so
    // searchSingleQuery does NOT re-run FTS (no double-query, no double fts_ms).
    const ftsProbe = await this.timedCall(
      () => Promise.resolve(this.ftsSearch(query, limit, trace)),
      trace,
      "fts_ms",
    ).catch(() => [] as SearchResult[]);
    const ftsSufficient = ftsProbe.length >= FTS_SUFFICIENT_RESULTS;
    const knownSlugsForGate = options?._hints?.knownSlugs ?? [];
    const isComplex = options?._hints?.isComplex ?? isComplexQuery(query, knownSlugsForGate);
    // #250 — preserve explicit multiQuery:false (decompose fallback at search.ts:473
    // passes multiQuery:false to forbid LLM escalation). Caller opt-out is honored
    // even when the query is complex or FTS is insufficient.
    const multiQueryAllowed = options?.multiQuery ?? this.multiQueryEnabled;
    const shouldExpand = multiQueryAllowed && !!this.llm && (isComplex || !ftsSufficient);
    if (trace && this.llm && !shouldExpand && ftsSufficient) {
      trace.expand_skipped = "fts_sufficient";
    }
    return this.searchWithExpansion(query, limit, shouldExpand, trace, ftsProbe);
```

(Note: `options?._hints?.knownSlugs` / `isComplex` are already computed earlier in the decompose path (lines 402-414); if `_hints` is absent, fall back to a fresh `isComplexQuery` call. This reuses the existing gate function — no new complexity classifier.)

(c) Extend `searchWithExpansion` + `searchSingleQuery` signatures to accept and reuse `initialFts`:

```ts
  private async searchWithExpansion(
    query: string,
    limit: number,
    expand: boolean,
    trace?: SearchTrace,
    initialFts?: SearchResult[],
  ): Promise<SearchResult[]> {
    const t0 = Date.now();
    const useMultiQuery = expand && !!this.llm;
    const queries = useMultiQuery
      ? await this.timedCall(() => this.expandQuery(query), trace, "expand_ms")
      : [query];

    if (trace && useMultiQuery) {
      trace.query_variants = queries;
      trace.llm_calls = (trace.llm_calls ?? 0) + 1;
    }

    const queryResults = await Promise.all(
      queries.map((q, i) => this.searchSingleQuery(q, limit, trace, i === 0 ? initialFts : undefined))
    );
    const allLists = queryResults.flat();

    const allSlugs = new Set<string>();
    for (const list of allLists) for (const item of list) allSlugs.add(item.slug);
    const activityWeights = allSlugs.size > 0 ? this.db.getActivityWeights([...allSlugs]) : undefined;
    const hotnessWeights = allSlugs.size > 0 ? this.db.getHotnessWeights([...allSlugs]) : undefined;

    const totalMs = Date.now() - t0;
    this.logger?.info("search", `expansion: ${queries.length} queries, expand=${trace?.expand_ms ?? 0}ms, total=${totalMs}ms, slugs=${allSlugs.size}`);

    return mergeRankedResults(allLists, this.rrfK, limit, activityWeights, hotnessWeights);
  }
```

And `searchSingleQuery` — accept `initialFts` and use it instead of re-running FTS when provided:

```ts
  private async searchSingleQuery(q: string, limit: number, trace?: SearchTrace, initialFts?: SearchResult[]): Promise<SearchResult[][]> {
    const resolved = this.db.resolveSlugs([q])[0];
    const vectorPromise = this.boundedVectorSearch(q, limit);

    const [vecOrNull, fts, graph, temporal] = await Promise.all([
      this.timedCall(() => vectorPromise, trace, "vector_ms").catch((e) => {
        this.logger?.warn("search", "vectorSearch 失败", { error: e instanceof Error ? e.stack ?? e.message : String(e) });
        if (trace && !trace.degraded_reason) trace.degraded_reason = "vector_error";
        return null as SearchResult[] | null;
      }),
      initialFts !== undefined
        ? Promise.resolve(initialFts)
        : this.timedCall(() => Promise.resolve(this.ftsSearch(q, limit, trace)), trace, "fts_ms").catch((e) => {
            this.logger?.warn("search", "ftsSearch 失败", { error: e instanceof Error ? e.stack ?? e.message : String(e) });
            return [] as SearchResult[];
          }),
      resolved?.slug
        ? this.timedCall(() => this.graphSearch(resolved.slug!, limit), trace, "graph_ms").catch((e) => {
            this.logger?.warn("search", "graphSearch 失败", { error: e instanceof Error ? e.stack ?? e.message : String(e) });
            return [] as SearchResult[];
          })
        : Promise.resolve([] as SearchResult[]),
      this.timedCall(() => Promise.resolve(this.temporalSearch(q, limit)), trace, "temporal_ms").catch((e) => {
        this.logger?.warn("search", "temporalSearch 失败", { error: e instanceof Error ? e.stack ?? e.message : String(e) });
        return [] as SearchResult[];
      }),
    ]);

    const vec = vecOrNull ?? [];
    if (vecOrNull === null && trace && !trace.degraded_reason) {
      trace.degraded_reason = "vector_timeout";
    }

    const lists: SearchResult[][] = [];
    if (vec.length > 0) lists.push(vec);
    if (fts.length > 0) lists.push(fts);
    if (graph.length > 0) lists.push(graph);
    if (temporal.length > 0) lists.push(temporal);
    return lists;
  }
```

(d) Add `expand_skipped?: string` to the `SearchTrace` interface (in `search.ts`, where `SearchTrace` is defined — find the interface and add the field).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/core/search-latency-gate.test.ts`
Expected: PASS — simple+FTS>=3 skips expandQuery; simple+empty calls it; complex calls it.

- [ ] **Step 5: Commit**

```bash
git add src/core/search.ts tests/core/search-latency-gate.test.ts
git commit -m "feat(search): gate expandQuery behind isComplexQuery||FTS<3, reuse FTS probe (#250)"
```

---

## Task 4: expandQuery budget guard (timeout + call-count)

**Files:**
- Modify: `src/core/search.ts` (`searchWithExpansion` expand path)
- Test: `tests/core/search-latency-gate.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append:

```ts
  test("expandQuery over call-count budget → skipped, FTS preserved, expand_skipped=budget_exhausted", async () => {
    // Seed FTS hits matching the complex query tokens so the FTS probe returns
    // >=3. This verifies: when expand is skipped by the budget, the initialFts
    // probe result is REUSED (not lost) — results.length > 0.
    seedFtsHits(3, "主题A 主题B 共同标记内容");
    let expandCalls = 0;
    const llm = { name: "mock", chat: async () => "{}", expandQuery: async () => { expandCalls++; return ["x"]; } };
    const search = new HybridSearch(db, mockEmbed(), { connect: async () => {}, addChunks: async () => {}, search: async () => [], fullTextSearch: async () => {}, deleteByPageSlug: async () => {}, deleteRawChunksByPageSlug: async () => {}, close: async () => {}, createFTSIndex: async () => {} } as never, { llm: llm as never });
    const trace: Record<string, unknown> = { llm_calls: 3 }; // #222 MAX_DEFAULT_LLM_CALLS budget exhausted
    // _skipDecompose ISOLATES the expand path: without it, the complex query
    // ("主题A 和 主题B") enters the decompose branch and the existing decompose
    // budget guard returns [] BEFORE reaching searchWithExpansion/expandQuery.
    const results = await search.search("主题A 和 主题B", { _skipDecompose: true, _trace: trace as never });
    expect(results.length).toBeGreaterThan(0); // FTS results preserved
    expect(expandCalls).toBe(0); // expand skipped due to budget
    expect(trace.expand_skipped).toBe("budget_exhausted");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/core/search-latency-gate.test.ts -t "call-count budget"`
Expected: FAIL — expandQuery is called regardless of budget today.

- [ ] **Step 3: Write minimal implementation**

In `searchWithExpansion`, guard the expand call with the #222 budget (reuse `MAX_DEFAULT_LLM_CALLS`) + a timeout race (reuse `MAX_DEFAULT_DECOMPOSE_MS`). Update the `useMultiQuery` block:

```ts
    const budgetExhausted = (trace?.llm_calls ?? 0) >= MAX_DEFAULT_LLM_CALLS;
    const useMultiQuery = expand && !!this.llm && !budgetExhausted;

    let queries: string[];
    if (useMultiQuery) {
      // #250 — race expandQuery against a wall-clock budget (mirrors #222 decompose
      // guard). LLMProvider has no AbortSignal: on timeout we discard the result,
      // do NOT write anything, and fall back to the original query. expandQuery is
      // pure-read, so discarding is safe.
      let expandTimer: ReturnType<typeof setTimeout> | undefined;
      const expandTimeout = new Promise<never>((_, reject) => {
        expandTimer = setTimeout(() => reject(new Error("expand_timeout")), MAX_DEFAULT_DECOMPOSE_MS);
      });
      try {
        queries = await Promise.race([
          this.timedCall(() => this.expandQuery(query), trace, "expand_ms"),
          expandTimeout,
        ]);
      } catch (e) {
        this.logger?.warn("search", "expandQuery 超时/失败，回退原查询（不写 DB，丢弃结果）", { error: e instanceof Error ? e.message : String(e) });
        queries = [query];
      } finally {
        if (expandTimer) clearTimeout(expandTimer);
      }
      if (trace) {
        trace.query_variants = queries;
        trace.llm_calls = (trace.llm_calls ?? 0) + 1;
      }
    } else {
      queries = [query];
      if (trace && budgetExhausted && expand && this.llm) {
        trace.expand_skipped = "budget_exhausted";
      }
    }
```

(Declaration above is the exact correct form: `let expandTimer` assigned inside the promise constructor, cleared in `finally` — mirrors search.ts:426-446 decompose pattern verbatim. No fix-up needed.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/core/search-latency-gate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/search.ts tests/core/search-latency-gate.test.ts
git commit -m "feat(search): expandQuery budget guard (timeout + call-count, non-cancellable) (#250)"
```

---

## Task 5: perf-diagnose split rates

**Files:**
- Modify: `src/release/perf-diagnose.ts` (summary ~240, by_degraded_reason ~267, return ~282)
- Test: `tests/release/perf-diagnose-latency-split.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/release/perf-diagnose-latency-split.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { diagnose } from "../../src/release/perf-diagnose.js";
import type { DiagnosticSnapshot } from "../../src/release/perf-diagnose.js";

// Anonymous fixture: a slow-but-complete session (latency warning only) vs a
// genuinely degraded session (vector_timeout).
const snapshot: DiagnosticSnapshot = {
  sessions: [
    { id: 1, started_at: "", mode: "smart-hybrid", intent: null, status: "success", latency_ms: 5000, total_steps: 1, llm_calls: 0, reason_codes: ["latency_budget_exceeded"] } as never,
    { id: 2, started_at: "", mode: "smart-hybrid", intent: null, status: "degraded", latency_ms: 600, total_steps: 1, llm_calls: 0, reason_codes: ["vector_timeout"] } as never,
  ],
  steps: [],
  queryLogs: [],
  searchLogs: [],
  tables: [],
  warnings: [],
};

describe("perf-diagnose latency split (#250)", () => {
  const report = diagnose(snapshot, { days: 7, minLatencyMs: 0, limit: 50 });

  test("degraded_rate counts only the vector_timeout session", () => {
    expect(report.summary.degraded_rate).toBe(0.5);
  });

  test("latency_warning_rate is reported separately", () => {
    expect(report.summary.latency_warning_rate).toBe(0.5);
  });

  test("by_degraded_reason excludes latency_budget_exceeded", () => {
    const reasons = report.by_degraded_reason.map(r => r.reason);
    expect(reasons).toContain("vector_timeout");
    expect(reasons).not.toContain("latency_budget_exceeded");
  });

  test("by_latency_warning_reason contains latency_budget_exceeded", () => {
    const reasons = (report as { by_latency_warning_reason?: { reason: string }[] }).by_latency_warning_reason?.map(r => r.reason) ?? [];
    expect(reasons).toContain("latency_budget_exceeded");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/release/perf-diagnose-latency-split.test.ts`
Expected: FAIL — `latency_warning_rate` / `by_latency_warning_reason` don't exist.

- [ ] **Step 3: Write minimal implementation**

In `src/release/perf-diagnose.ts`:

(a) Import `WARNING_REASON_CODES` and add `latency_warning_rate` to `summary` (around line 240-249):

```ts
import { ALL_DEGRADED_REASON_CODES, WARNING_REASON_CODES, type DegradedReasonCode } from "../core/search-diagnostics.js";
```

```ts
  const slowLats = slowAll.map((s) => s.latency_ms).sort((a, b) => a - b);
  // #250 — latency_warning_rate: dual source for robustness.
  // (a) reason_codes carries a warning code (latency_budget_exceeded is written
  //     by classifyDegradedReasons whenever latency>2000; recall.ts/search.ts
  //     persist reason_codes into summary_json, so slow sessions ARE tagged).
  // (b) fallback: latency_ms > threshold AND status !== degraded — catches any
  //     slow-but-ok session even if the code wasn't persisted (defensive).
  // #250 — latency_warning sessions: UNION by session id (not Math.max of counts,
  // which mis-counts when the two sources cover different sessions).
  const latencyWarningIds = new Set<number>();
  for (const s of sessions) {
    const codeWarn = s.reason_codes.some((c) => WARNING_REASON_CODES.has(c as DegradedReasonCode));
    const latencyWarn = s.latency_ms != null && s.latency_ms > 2000 && s.status !== "degraded";
    if (codeWarn || latencyWarn) latencyWarningIds.add(s.id);
  }
  const latencyWarningCount = latencyWarningIds.size;
  const summary: PerfDiagnoseReport["summary"] = {
    session_count: sessions.length,
    slow_count: slowAll.length,
    degraded_rate: sessions.length ? sessions.filter((s) => s.status === "degraded").length / sessions.length : 0,
    latency_warning_rate: sessions.length ? latencyWarningCount / sessions.length : 0,
    latency: slowLats.length
      ? { p50: percentile(slowLats, 50), p95: percentile(slowLats, 95), max: slowLats[slowLats.length - 1] }
      : null,
    avg_total_steps: slowAll.length ? slowAll.reduce((a, s) => a + s.total_steps, 0) / slowAll.length : 0,
    avg_llm_calls: slowAll.length ? slowAll.reduce((a, s) => a + s.llm_calls, 0) / slowAll.length : 0,
  };
```

(b) Split the reason aggregation (line 267-280) into degraded-only vs warning-only:

```ts
  // #250 — split: retrieval-degraded reasons vs latency/parser warnings.
  const degradedReasonLat = new Map<string, number[]>();
  const warningReasonLat = new Map<string, number[]>();
  for (const s of sessions) {
    for (const code of s.reason_codes) {
      const target = WARNING_REASON_CODES.has(code as DegradedReasonCode) ? warningReasonLat : degradedReasonLat;
      const arr = target.get(code) ?? [];
      arr.push(s.latency_ms);
      target.set(code, arr);
    }
    // #250 — synthesize latency_budget_exceeded for slow-but-ok sessions whose
    // reason_codes didn't capture it, so by_latency_warning_reason never undercounts.
    if (s.latency_ms != null && s.latency_ms > 2000 && s.status !== "degraded" && !s.reason_codes.includes("latency_budget_exceeded")) {
      const arr = warningReasonLat.get("latency_budget_exceeded") ?? [];
      arr.push(s.latency_ms);
      warningReasonLat.set("latency_budget_exceeded", arr);
    }
  }
  const agg = (map: Map<string, number[]>): ReasonAggregate[] => [...map.entries()]
    .map(([reason, lats]) => {
      const sorted = [...lats].sort((a, b) => a - b);
      return { reason, count: lats.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), max: sorted[sorted.length - 1] };
    })
    .sort((a, b) => b.count - a.count);
  const by_degraded_reason: ReasonAggregate[] = agg(degradedReasonLat);
  const by_latency_warning_reason: ReasonAggregate[] = agg(warningReasonLat);
```

(c) Add `latency_warning_rate` to the `PerfDiagnoseReport["summary"]` type and `by_latency_warning_reason` to the return object + report type (find the `PerfDiagnoseReport` interface and add `by_latency_warning_reason?: ReasonAggregate[]`). In the return (line 282-300):

```ts
    by_degraded_reason,
    by_latency_warning_reason,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/release/perf-diagnose-latency-split.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/release/perf-diagnose.ts tests/release/perf-diagnose-latency-split.test.ts
git commit -m "feat(perf-diagnose): split degraded_rate from latency_warning_rate (#250)"
```

---

## Task 6: regression guard + lint

**Files:** none (verification)

- [ ] **Step 1: Run the must-not-regress suite**

```bash
bun test tests/core/search.escalation-budget.test.ts tests/core/search-diagnostics.test.ts tests/core/search-latency-gate.test.ts tests/mcp/recall-quality.test.ts tests/mcp/recall-latency-warning.test.ts tests/release/perf-diagnose-latency-split.test.ts tests/release/frontdoor-dialogue-gate.test.ts tests/release/first-recall-gate.test.ts
```
Expected: ALL PASS. The #222 escalation-budget tests must stay green (we only ADDED an expand guard, didn't touch decompose). Any failure is a contract regression — fix before proceeding.

- [ ] **Step 2: Run lint**

Run: `bun run lint`
Expected: PASS (tsc + biome). Fix any unused-var / type errors introduced (e.g. `_latencyThreshold` underscore prefix, `_reasonCodes`).

- [ ] **Step 3: Run full check**

Run: `bun run check`
Expected: PASS (lint + full test suite).

- [ ] **Step 4: Commit if any fixups**

```bash
git add -A && git commit -m "test(search): #250 latency/degraded split regression guard green"
```
(Skip if nothing changed.)

---

## Self-Review

**1. Spec coverage:**
- expandQuery gate `isComplexQuery || FTS<3` → Task 3 ✓
- FTS probe reuse (no double-query) → Task 3 (`initialFts` plumbed through `searchWithExpansion`→`searchSingleQuery`) ✓
- latency-only → warning, not degraded → Task 1 (`computeSearchDegraded` drops latency branch) + Task 2 (`latency_warning` surfaced) ✓
- parser_fallback quality-gated → Task 1 (moved to `WARNING_REASON_CODES`; empty/low still degrade via fts_empty/low_score) ✓
- expandQuery budget guard (timeout + call-count, non-cancellable) → Task 4 ✓
- perf-diagnose split → Task 5 ✓
- #230 / #222 / no-DB-schema / no-ranking preserved → guards untouched; only ADDED expand guard; no schema change ✓

**2. Placeholder scan:** Task 4 Step 3 flags the `expandTimer` declaration ordering (mirror decompose pattern exactly) — that's a concrete reference to search.ts:426-446, not a placeholder. Task 2's "same pattern" for search.ts is explicitly described (find `degraded:` line, add `latency_warning:`). No TBD/TODO.

**3. Type consistency:**
- `computeLatencyWarning(latencyMs, reasonCodes, threshold?)` — same signature used Task 1 (def) + Task 2 (recall.ts/search.ts call). ✓
- `searchWithExpansion(query, limit, expand, trace, initialFts?)` — Task 3 changes signature from `(query, limit, multiQuery?, trace?)` to `(query, limit, expand, trace?, initialFts?)`. **Caller at search.ts:473** (decompose fallback `return this.searchWithExpansion(query, limit, false, trace)`) and **search.ts:477** (old final return) both rewritten in Task 3 Step 3b. Verify no other caller exists: `grep searchWithExpansion src/` — only searchCore internal.
- `WARNING_REASON_CODES` exported Task 1, imported Task 5. ✓
- `expand_skipped` added to `SearchTrace` Task 3d, set Task 3/4. ✓

**4. Known follow-up (not blocking):** `formatHuman` (perf-diagnose.ts:308+) doesn't yet print `latency_warning_rate` — Task 5 adds the field to the report; a human-readable line can be added but isn't required by acceptance (JSON report + tests suffice). Flag for awareness.

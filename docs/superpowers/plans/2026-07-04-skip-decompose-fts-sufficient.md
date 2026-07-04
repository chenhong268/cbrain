# Skip Decompose When FTS-Sufficient (#272) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 默认 smart 搜索，原 query 的 FTS 探针 ≥3 命中时跳过 LLM `decomposeQuery`，降 latency / 降级率，不降 recall。

**Architecture:** hoist #250 的 `ftsProbe` 到 decompose branch 前；`complex && ftsSufficient` 时写 `trace.decompose_skipped="fts_sufficient"` 并 **fall through**（不 return）到 #250 gate，复用同一个 probe（无第二次 `ftsSearch`）。`knownSlugs` **不纳入** sufficiency（多实体对比查询仍可 decompose）。保留 `_skipDecompose` / `multiStep` / `multiQuery:false` precedence 与 #222/#268 budget guards。

**Tech Stack:** TypeScript (strict), Bun, bun:test, CBrainDB (bun:sqlite)。

**Spec:** `docs/superpowers/specs/2026-07-04-skip-decompose-fts-sufficient-design.md`

---

## File Structure

- **Modify** `src/core/retrieval/search.ts`：
  - `SearchTrace` 加 `decompose_skipped?: string`（紧挨 `expand_skipped`，`search.ts:47`）
  - `searchCore`（`search.ts:379-505`）：hoist `ftsProbe`/`ftsSufficient` 到 decompose branch 前；`if (complex)` 加 skip 分支；删 #250 gate 里 `488-493` 的重复 probe。
- **Modify** `tests/core/search-latency-gate.test.ts`：hoist `makeLance`/`seedFtsHits` 到 module scope（DRY，两个 describe 共用）+ 加 `spyDecompose` helper + 新 `describe("decompose gate (#272)")`。
- **不改**：`search-trace.ts`、`tools/search.ts`、`search-diagnostics.ts`、`sqlite.ts`、ontology、#250 常量 `FTS_SUFFICIENT_RESULTS`。

---

## Task 1: RED — decompose-skip 测试 + helper hoist

**Files:**
- Modify: `tests/core/search-latency-gate.test.ts`

- [ ] **Step 1: hoist `makeLance` + `seedFtsHits` 到 module scope，加 `spyDecompose`**

把 `search-latency-gate.test.ts:33-48`（当前在 `describe("expandQuery gate (#250)")` 内的 `makeLance` + `seedFtsHits`）移到 module scope（`spyExpand` 之后，即第 20 行后），让 #272 新 describe 也能复用。在 `spyExpand` 后追加 `spyDecompose`：

```typescript
// HybridSearch.decomposeQuery is public — spy directly.
function spyDecompose(s: HybridSearch, impl: (q: string, g: unknown) => Promise<string[]>) {
  return spyOn(s, "decomposeQuery").mockImplementation(impl);
}

function makeLance() {
  return { connect: async () => {}, addChunks: async () => {}, search: async () => [], fullTextSearch: async () => [], deleteByPageSlug: async () => {}, deleteRawChunksByPageSlug: async () => {}, close: async () => {}, createFTSIndex: async () => {} } as never;
}

// content is parameterized so a test can seed FTS hits that MATCH its query
// tokens — otherwise the FTS probe returns 0 and the test never exercises the
// "FTS sufficient" branch.
function seedFtsHits(db: CBrainDB, n: number, content = "唯一标记内容片段") {
  for (let i = 0; i < n; i++) {
    const slug = `entity/fts-${i}`;
    db.rawDb.prepare("INSERT INTO pages (slug, type, title, file_path, content_hash, tier, mention_count) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(slug, "entity/person", `实体${i}`, `${slug}.md`, "h1", 1, 3);
    db.rawDb.prepare("INSERT INTO chunks (page_slug, chunk_index, content) VALUES (?, ?, ?)").run(slug, 0, content);
    db.rawDb.prepare("INSERT INTO chunks_fts (page_slug, content) VALUES (?, ?)").run(slug, content);
  }
}
```

> 注意 `seedFtsHits` 现在收 `db` 参数（hoist 到 module scope 后不再闭包捕获 `db`）。把 #250 describe 内原来的 `seedFtsHits(n, content)` 调用全改成 `seedFtsHits(db, n, content)`，并删掉 #250 describe 内的 local `makeLance` + `seedFtsHits` 定义。

- [ ] **Step 2: 跑 #250 测试确认 hoist 没破**

Run: `bun test tests/core/search-latency-gate.test.ts`
Expected: 5 pass / 0 fail（与 hoist 前一致，证明 helper 移动是纯重构）。

- [ ] **Step 3: 加新 describe + 6 个 RED 测试**

在文件末尾（`describe("expandQuery gate (#250)")` 之后）追加：

```typescript
describe("decompose gate (#272)", () => {
  const dir = "/tmp/cbrain-test-decompose-gate";
  const dbPath = join(dir, "t.sqlite");
  let db: CBrainDB;

  beforeEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true });
    db = new CBrainDB(dbPath);
  });
  afterEach(() => { db.close(); if (existsSync(dir)) rmSync(dir, { recursive: true }); });

  test("complex + FTS>=3 → decomposeQuery NOT called + decompose_skipped + non-empty", async () => {
    seedFtsHits(db, 3, "主题A 主题B 共同标记内容");
    const llm = { name: "mock", chat: async () => { throw new Error("chat should not be called"); } };
    const search = new HybridSearch(db, mockEmbed(), makeLance(), { llm: llm as never });
    const decomposeSpy = spyDecompose(search, async () => { throw new Error("decomposeQuery should not be called"); });
    const trace: Record<string, unknown> = {};
    const results = await search.search("主题A 和 主题B", { _trace: trace as never });
    expect(results.length).toBeGreaterThan(0);
    expect(decomposeSpy).toHaveBeenCalledTimes(0);
    expect(trace.decompose_skipped).toBe("fts_sufficient");
    decomposeSpy.mockRestore();
  });

  test("complex + FTS<3 → decomposeQuery IS called", async () => {
    // 不 seed FTS → probe 返回 < 3 → insufficient → 走 decompose
    const llm = { name: "mock", chat: async () => JSON.stringify({ sub_queries: [{ sub_query: "主题A", intent: "x" }, { sub_query: "主题B", intent: "y" }] }) };
    const search = new HybridSearch(db, mockEmbed(), makeLance(), { llm: llm as never });
    const decomposeSpy = spyDecompose(search, async () => ["主题A", "主题B"]);
    await search.search("主题A 和 主题B");
    expect(decomposeSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    decomposeSpy.mockRestore();
  });

  test("对抗: 多实体 (knownSlugs>=2) + FTS<3 → 仍 decompose (knownSlugs 不误 skip)", async () => {
    // seed 2 个实体 page（让 resolveSlugs 找到 >=2 slug → isComplexQuery true），
    // 但不 seed chunks_fts → FTS probe < 3 → 必须仍 decompose。
    for (const slug of ["entity/a", "entity/b"]) {
      db.rawDb.prepare("INSERT INTO pages (slug, type, title, file_path, content_hash, tier, mention_count) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(slug, "entity/person", slug === "entity/a" ? "实体A" : "实体B", `${slug}.md`, "h1", 1, 3);
      db.rawDb.prepare("INSERT INTO aliases (slug, alias) VALUES (?, ?)").run(slug, slug === "entity/a" ? "实体A" : "实体B");
    }
    const llm = { name: "mock", chat: async () => JSON.stringify({ sub_queries: [{ sub_query: "实体A", intent: "x" }, { sub_query: "实体B", intent: "y" }] }) };
    const search = new HybridSearch(db, mockEmbed(), makeLance(), { llm: llm as never });
    const decomposeSpy = spyDecompose(search, async () => ["实体A", "实体B"]);
    await search.search("实体A 和 实体B 的关系");
    expect(decomposeSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    decomposeSpy.mockRestore();
  });

  test("fail-open: FTS probe 抛错 → complex 仍允许 decompose", async () => {
    // seed 3 FTS hits 让"正常情况"会 sufficient，但让 ftsSearch 抛错 → probe=[] → insufficient → decompose
    seedFtsHits(db, 3, "主题A 主题B 共同标记内容");
    const llm = { name: "mock", chat: async () => JSON.stringify({ sub_queries: [{ sub_query: "主题A", intent: "x" }, { sub_query: "主题B", intent: "y" }] }) };
    const search = new HybridSearch(db, mockEmbed(), makeLance(), { llm: llm as never });
    const ftsSpy = spyOn(search as unknown as { ftsSearch: (q: string, l: number, t?: unknown) => unknown[] }, "ftsSearch").mockImplementation(() => { throw new Error("fts boom"); });
    const decomposeSpy = spyDecompose(search, async () => ["主题A", "主题B"]);
    await search.search("主题A 和 主题B");
    expect(decomposeSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    ftsSpy.mockRestore();
    decomposeSpy.mockRestore();
  });

  test("precedence: _skipDecompose:true + FTS>=3 → decomposeQuery NOT called", async () => {
    seedFtsHits(db, 3, "主题A 主题B 共同标记内容");
    const llm = { name: "mock", chat: async () => { throw new Error("chat should not be called"); } };
    const search = new HybridSearch(db, mockEmbed(), makeLance(), { llm: llm as never });
    const decomposeSpy = spyDecompose(search, async () => { throw new Error("decomposeQuery should not be called"); });
    await search.search("主题A 和 主题B", { _skipDecompose: true });
    expect(decomposeSpy).toHaveBeenCalledTimes(0);
    decomposeSpy.mockRestore();
  });

  test("无双查: skip 路径对原 query 的 ftsSearch 调用 = 1", async () => {
    seedFtsHits(db, 3, "主题A 主题B 共同标记内容");
    const llm = { name: "mock", chat: async () => "{}" };
    const search = new HybridSearch(db, mockEmbed(), makeLance(), { llm: llm as never });
    const ftsSpy = spyOn(search as unknown as { ftsSearch: (q: string, l: number, t?: unknown) => unknown[] }, "ftsSearch");
    await search.search("主题A 和 主题B");
    const originalQueryCalls = ftsSpy.mock.calls.filter((c) => c[0] === "主题A 和 主题B").length;
    expect(originalQueryCalls).toBe(1); // hoisted probe 复用，#250 gate 不重跑原 query
    ftsSpy.mockRestore();
  });
});
```

- [ ] **Step 4: 跑 RED，确认 skip cases fail**

Run: `bun test tests/core/search-latency-gate.test.ts`
Expected: 新增 6 个 case 里，至少这 3 个 FAIL（RED）：
- `complex + FTS>=3 → decomposeQuery NOT called` — 当前 `decomposeQuery` 会被调（spy 抛错 → 测试 throw 或 `decompose_skipped` undefined）。
- `fail-open: FTS probe 抛错 → complex 仍允许 decompose` — 取决于当前是否 hoist（当前 ftsProbe 在 #250 gate 内，decompose branch 不跑 ftsProbe，所以 ftsSpy 拦不到 decompose 前的 probe；行为可能 pass 也可能 fail，记录实际）。
- `无双查: skip 路径 ftsSearch=1` — 当前 complex query 进 decompose branch 不跑 ftsProbe → 原查询 ftsSearch=0 ≠ 1，FAIL。

其余（`complex + FTS<3 → decompose`、`多实体对抗`、`_skipDecompose precedence`）当前应 PASS（回归保护，验证新 gate 不破现有"FTS 不足仍 decompose"语义）。

> RED 状态：skip 关键 case fail（功能缺失），回归 case pass。这就是 TDD 想要的——看着关键测试因"没 skip"而 fail。

---

## Task 2: GREEN — hoist ftsProbe + skip gate + trace field

**Files:**
- Modify: `src/core/retrieval/search.ts:47`（SearchTrace）
- Modify: `src/core/retrieval/search.ts:379-505`（searchCore）

- [ ] **Step 1: SearchTrace 加 `decompose_skipped`**

在 `search.ts:47`（`expand_skipped?: string;` 后）加一行：

```typescript
  expand_skipped?: string;
  decompose_skipped?: string;
```

- [ ] **Step 2: searchCore — hoist ftsProbe，加 skip 分支，删 #250 gate 重复 probe**

把 `search.ts:407-504`（从 `// Decomposition path for complex queries` 到 `return this.searchWithExpansion(query, limit, shouldExpand, trace, ftsProbe);`）替换为下面的版本。三处变化：(a) ftsProbe/ftsSufficient hoist 到 decompose branch 前；(b) `if (complex)` 内加 `if (ftsSufficient) { trace; } else { 原逻辑 }`；(c) #250 gate 删 `488-493` 的重复 probe（复用 hoisted）。

```typescript
    // #272 — hoist the bounded FTS probe above the decompose branch so the same
    // probe can gate decompose AND feed the #250 expand path below (no second
    // ftsSearch on the original query). Timed + fail-open (catch → []), mirroring
    // searchSingleQuery's FTS path so trace/error semantics stay consistent.
    const ftsProbe = await this.timedCall(
      () => Promise.resolve(this.ftsSearch(query, limit, trace)),
      trace,
      "fts_ms",
    ).catch(() => [] as SearchResult[]);
    const ftsSufficient = ftsProbe.length >= FTS_SUFFICIENT_RESULTS;

    // Decomposition path for complex queries
    if (this.llm && !options?._skipDecompose) {
      const hints = options?._hints;
      let knownSlugs: string[];
      let complex: boolean;

      if (hints) {
        knownSlugs = hints.knownSlugs;
        complex = hints.isComplex;
      } else {
        const candidates = query.split(/[\s,，、；;和与跟以及]+/).filter((w) => w.length >= 2);
        const resolved = this.db.resolveSlugs(candidates);
        knownSlugs = resolved.filter((r) => r.slug !== null).map((r) => r.slug!);
        complex = isComplexQuery(query, knownSlugs, candidates);
      }

      if (complex) {
        // #272 — FTS-sufficient complex query: skip the LLM decompose, fall
        // through to the bounded hybrid + expand path (reusing ftsProbe).
        // knownSlugs is deliberately NOT part of sufficiency: a 2+-entity
        // comparison still needs decompose when FTS alone hasn't surfaced enough.
        if (ftsSufficient) {
          if (trace) trace.decompose_skipped = "fts_sufficient";
        } else {
          // Budget guard: skip decompose if LLM budget already exhausted (#222)
          if ((trace?.llm_calls ?? 0) >= MAX_DEFAULT_LLM_CALLS) {
            if (trace && !trace.degraded_reason) trace.degraded_reason = "decompose_budget_exceeded";
            return [] as SearchResult[]; // degraded: 零额外 LLM
          }
          // Decompose with a REAL wall-clock budget: Promise.race against timeout.
          const decomposeStart = Date.now();
          let decomposeTimer: ReturnType<typeof setTimeout> | undefined;
          const decomposeTimeout = new Promise<never>((_, reject) => {
            decomposeTimer = setTimeout(() => reject(new Error("decompose_timeout")), MAX_DEFAULT_DECOMPOSE_MS);
          });
          let subQueries: string[];
          try {
            const graphContext = await this.graphPrefetch(query);
            subQueries = (await Promise.race([
              this.decomposeQuery(query, graphContext),
              decomposeTimeout,
            ])).slice(0, MAX_DEFAULT_SUBQUERIES);
          } catch (e) {
            if (trace) {
              trace.decompose_ms = Date.now() - decomposeStart;
              if (!trace.degraded_reason) trace.degraded_reason = "decompose_budget_exceeded";
            }
            this.logger?.warn("search", "decomposition 超时/失败，回退原查询（零额外 LLM）", { error: e instanceof Error ? e.message : String(e) });
            return this.searchWithExpansion(query, limit, false, trace);
          } finally {
            if (decomposeTimer) clearTimeout(decomposeTimer);
          }
          if (trace) {
            trace.decompose_ms = Date.now() - decomposeStart;
            trace.llm_calls = (trace.llm_calls ?? 0) + 1;
          }

          this.logger?.info("search", `decomposition: "${query}" → ${subQueries.length} sub-queries (capped at ${MAX_DEFAULT_SUBQUERIES})`);
          if (subQueries.length >= 2) {
            const subResults = await Promise.all(
              subQueries.map((sq) =>
                this.search(sq, { ...(options ?? {}), _skipDecompose: true, multiQuery: false, _skipDetailEnrich: true, _trace: trace }).catch(() => [] as SearchResult[])
              )
            );

            const allSubLists = subResults.filter((r) => r.length > 0);
            if (allSubLists.length > 0) {
              const allSlugs = new Set<string>();
              for (const list of allSubLists) for (const item of list) allSlugs.add(item.slug);
              const activityWeights = allSlugs.size > 0 ? this.db.getActivityWeights([...allSlugs]) : undefined;
              const hotnessWeights = allSlugs.size > 0 ? this.db.getHotnessWeights([...allSlugs]) : undefined;
              return mergeRankedResults(allSubLists, this.rrfK, limit, activityWeights, hotnessWeights);
            }
          }
          // decompose 成功但弱结构/空结果 → 原查询 bounded fallback。
          return this.searchWithExpansion(query, limit, false, trace);
        }
      }
    }

    // #250 — bounded FTS probe gate. ftsProbe is hoisted above (reused here, NOT
    // re-run) so there is no second ftsSearch on the original query.
    const knownSlugsForGate = options?._hints?.knownSlugs ?? [];
    const isComplex = options?._hints?.isComplex ?? isComplexQuery(query, knownSlugsForGate);
    const multiQueryAllowed = options?.multiQuery ?? this.multiQueryEnabled;
    const shouldExpand = multiQueryAllowed && !!this.llm && (isComplex || !ftsSufficient);
    if (trace && this.llm && !shouldExpand && ftsSufficient) {
      trace.expand_skipped = "fts_sufficient";
    }
    return this.searchWithExpansion(query, limit, shouldExpand, trace, ftsProbe);
```

> 关键不变量：
> - `decomposeQuery` 调用点仍在 `if (complex && !ftsSufficient)` 的 else 内，budget guards / timeout / weak-fallback 全部原样保留。
> - `searchWithExpansion(query, limit, false, trace)`（无 initialFts）用于 decompose 失败/弱结果 fallback——此处**故意不传** ftsProbe（decompose 已消费 budget，fallback 用原查询单查；与现状一致）。
> - 末尾 #250 gate 的 `searchWithExpansion(..., ftsProbe)` 复用 hoisted probe（skip 路径 + 非 complex 路径都走这里）。

- [ ] **Step 3: 跑 GREEN**

Run: `bun test tests/core/search-latency-gate.test.ts`
Expected: 全部 pass（#250 的 5 个 + #272 的 6 个 = 11 pass / 0 fail）。

- [ ] **Step 4: 跑全量 check 确认无回归**

Run: `bun run check`
Expected: 全量 pass（含 `search.escalation-budget.test.ts` #222、`search.decompose.test.ts` 等），0 fail。

---

## Task 3: Commit

**Files:**
- `src/core/retrieval/search.ts`, `tests/core/search-latency-gate.test.ts`

- [ ] **Step 1: stage + commit**

```bash
git add src/core/retrieval/search.ts tests/core/search-latency-gate.test.ts
git commit -m "fix(recall): skip decompose when FTS-sufficient (#272)

Hoist the #250 ftsProbe above the decompose branch in searchCore so the
same probe gates decompose AND feeds the expand path (no second ftsSearch
on the original query). When a complex query's FTS probe is sufficient
(>=3 hits), skip the LLM decomposeQuery entirely, record
trace.decompose_skipped=\"fts_sufficient\", and fall through to the bounded
hybrid + expand path. knownSlugs is deliberately excluded from sufficiency
(a 2+-entity comparison still decomposes when FTS is thin). Budget guards
(#222/#268), _skipDecompose / multiStep / multiQuery:false precedence
unchanged.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

- [ ] **Step 2: 确认 commit**

Run: `git log --oneline -1`
Expected: 新 commit 在 worktree branch HEAD。

---

## Self-Review (执行前已做)

**Spec coverage:**
- Acceptance #1 (complex+FTS≥3 → skip + trace + 非空) → Task 1 test 1 ✓
- Acceptance #2 (complex+FTS<3 → decompose) → Task 1 test 2 ✓
- Acceptance #3 (多实体对抗) → Task 1 test 3 ✓
- Acceptance #4 (decompose timeout fail-closed) → 现有 `search.escalation-budget.test.ts:214-242` 覆盖，Task 2 保留原逻辑 ✓
- Acceptance #5 (无双查) → Task 1 test 6 ✓
- 宏哥加的 fail-open（FTS 抛错→仍 decompose）→ Task 1 test 4 ✓
- 现有测试不破 → Task 2 Step 4 `bun run check` ✓

**Placeholder scan:** 无 TBD/TODO，所有 step 含完整代码。

**Type consistency:** `decompose_skipped?: string`（SearchTrace）与测试 `trace.decompose_skipped` 一致；`spyDecompose` 签名匹配 `decomposeQuery(query, graphContext): Promise<string[]>`；`seedFtsHits(db, n, content)` 调用点参数一致。

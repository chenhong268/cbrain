# Graph-Aware Query Decomposition — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add automatic query decomposition to HybridSearch — complex queries are split into 2-5 sub-queries using graph context, each searched independently, then merged via RRF.

**Architecture:** Extend `HybridSearch.search()` with a complexity check that routes complex queries through `graphPrefetch()` → `decomposeQuery()` → parallel sub-query retrieval → RRF merge. Simple queries continue through the existing `expandQuery()` path.

**Tech Stack:** TypeScript, Bun, SQLite (bun:sqlite), LLMProvider (Zhipu/DeepSeek), GraphManager

**Spec:** `docs/superpowers/specs/2026-05-25-agentic-search-decomposition-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/core/search.ts` | Modify | Add `GraphContext` interface, `isComplexQuery()`, `graphPrefetch()`, `decomposeQuery()`, modify `search()` |
| `tests/core/search.decompose.test.ts` | Create | All tests for decomposition feature |

No other files are modified. `recall.ts`, `search.ts` (MCP tool), `graph.ts`, `sqlite.ts` are untouched.

---

### Task 1: Add `GraphContext` interface and `isComplexQuery()` function

**Files:**
- Modify: `src/core/search.ts` (add after `HybridSearchConfig` interface, ~line 22)
- Create: `tests/core/search.decompose.test.ts`

- [ ] **Step 1: Write failing tests for `isComplexQuery`**

```typescript
// tests/core/search.decompose.test.ts
import { describe, test, expect } from "bun:test";
import { isComplexQuery } from "../../src/core/search.js";

describe("isComplexQuery", () => {
  test("simple single entity is not complex", () => {
    expect(isComplexQuery("张三", ["entity/zhangsan"])).toBe(false);
  });

  test("two known entities is complex", () => {
    expect(
      isComplexQuery("张三和李四", ["entity/zhangsan", "entity/lisi"])
    ).toBe(true);
  });

  test("conjunction '与' makes it complex", () => {
    expect(isComplexQuery("张三与李四", [])).toBe(true);
  });

  test("conjunction '和' makes it complex", () => {
    expect(isComplexQuery("OpenAI和Anthropic", [])).toBe(true);
  });

  test("conjunction '以及' makes it complex", () => {
    expect(isComplexQuery("机器学习以及深度学习", [])).toBe(true);
  });

  test("conjunction '跟' makes it complex", () => {
    expect(isComplexQuery("张三跟李四", [])).toBe(true);
  });

  test("single question word is not complex", () => {
    expect(isComplexQuery("什么是机器学习", [])).toBe(false);
  });

  test("multiple question words is complex", () => {
    expect(isComplexQuery("什么是机器学习，怎么入门", [])).toBe(true);
  });

  test("short query without connectors is not complex", () => {
    expect(isComplexQuery("机器学习", [])).toBe(false);
  });

  test("empty string is not complex", () => {
    expect(isComplexQuery("", [])).toBe(false);
  });

  test("only one known slug is not complex even with '的'", () => {
    expect(isComplexQuery("张三的公司", ["entity/zhangsan"])).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/core/search.decompose.test.ts`
Expected: FAIL — `isComplexQuery` is not exported from `search.ts`

- [ ] **Step 3: Add `GraphContext` interface and implement `isComplexQuery`**

Add to `src/core/search.ts` after the `HybridSearchConfig` interface (line 22):

```typescript
export interface GraphContext {
  entities: Array<{
    slug: string;
    title: string;
    type: string;
    neighbors: Array<{ slug: string; title: string; relation: string }>;
  }>;
  chains: string[];
}

const COMPLEXITY_CONJUNCTIONS = ["和", "与", "跟", "以及"];
const QUESTION_WORDS = ["什么", "哪些", "怎么", "如何"];
const MAX_GRAPH_CONTEXT_CHARS = 2000;

export function isComplexQuery(
  query: string,
  knownSlugs: string[]
): boolean {
  if (!query.trim()) return false;

  // 2+ known entities → complex
  if (knownSlugs.length >= 2) return true;

  // Conjunction words → complex
  for (const conj of COMPLEXITY_CONJUNCTIONS) {
    if (query.includes(conj)) return true;
  }

  // Multiple question words → complex
  let questionCount = 0;
  for (const qw of QUESTION_WORDS) {
    if (query.includes(qw)) questionCount++;
  }
  if (questionCount >= 2) return true;

  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/core/search.decompose.test.ts`
Expected: PASS

- [ ] **Step 5: Run full lint + test**

Run: `bun run lint && bun test`
Expected: PASS (no regressions)

- [ ] **Step 6: Commit**

```bash
git add src/core/search.ts tests/core/search.decompose.test.ts
git commit -m "feat(search): add GraphContext interface and isComplexQuery()"
```

---

### Task 2: Implement `graphPrefetch()`

**Files:**
- Modify: `src/core/search.ts` (add `graphPrefetch` method to `HybridSearch`)
- Modify: `tests/core/search.decompose.test.ts`

- [ ] **Step 1: Write failing tests for `graphPrefetch`**

Add to `tests/core/search.decompose.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { HybridSearch } from "../../src/core/search.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";

// ... (isComplexQuery tests from Task 1 remain above)

function createMockEmbeddingProvider(): EmbeddingProvider {
  const fakeVec = (text: string) => {
    const vec = new Array(128).fill(0);
    for (let i = 0; i < text.length; i++) {
      vec[i % 128] += text.charCodeAt(i) / 65536;
    }
    return vec;
  };
  return {
    dimensions: 128,
    embed: async (text: string) => ({
      embedding: fakeVec(text),
      tokenCount: text.length,
    }),
    embedBatch: async (texts: string[]) =>
      texts.map((t) => ({ embedding: fakeVec(t), tokenCount: t.length })),
  };
}

function createMockLance() {
  return {
    connect: async () => {},
    addChunks: async () => {},
    search: async () => [],
    fullTextSearch: async () => [],
    deleteByPageSlug: async () => {},
    deleteRawChunksByPageSlug: async () => {},
    close: async () => {},
    createFTSIndex: async () => {},
  };
}

function insertPage(
  db: CBrainDB,
  slug: string,
  title: string,
  type: string,
  mentionCount = 0
) {
  db.prepare(
    "INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(slug, type, title, `${slug}.md`, `h-${slug}`, mentionCount);
}

function insertLink(
  db: CBrainDB,
  from: string,
  to: string,
  relation = "提及"
) {
  db.prepare(
    "INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)"
  ).run(from, to, relation);
}

describe("HybridSearch.graphPrefetch", () => {
  const testDir = "/tmp/cbrain-test-decompose-prefetch";
  const dbPath = join(testDir, "test.sqlite");
  let db: CBrainDB;
  let search: HybridSearch;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(dbPath);
    search = new HybridSearch(db, createMockEmbeddingProvider(), createMockLance() as any, { rrf_k: 60 });
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("returns empty context when no entities found", async () => {
    const ctx = await search.graphPrefetch("完全不存在的东西");
    expect(ctx.entities).toEqual([]);
    expect(ctx.chains).toEqual([]);
  });

  test("returns entity with neighbors when entity exists", async () => {
    insertPage(db, "entity/zhangsan", "张三", "entity/person", 5);
    insertPage(db, "entity/abc-project", "ABC项目", "entity/product", 3);
    insertLink(db, "entity/zhangsan", "entity/abc-project", "co-founded");

    const ctx = await search.graphPrefetch("张三");
    expect(ctx.entities.length).toBeGreaterThanOrEqual(1);
    const zhangsan = ctx.entities.find((e) => e.slug === "entity/zhangsan");
    expect(zhangsan).toBeDefined();
    expect(zhangsan!.title).toBe("张三");
    expect(zhangsan!.neighbors.length).toBeGreaterThanOrEqual(1);
    expect(zhangsan!.neighbors.some((n) => n.title === "ABC项目")).toBe(true);
  });

  test("returns empty context on partial match", async () => {
    insertPage(db, "entity/zhangsan", "张三", "entity/person");
    // Query mentions "张三" and "李四" but 李四 doesn't exist
    const ctx = await search.graphPrefetch("张三和李四");
    const zhangsan = ctx.entities.find((e) => e.slug === "entity/zhangsan");
    expect(zhangsan).toBeDefined();
    // 李四 is not in entities because it doesn't exist in DB
    const lisi = ctx.entities.find((e) => e.title === "李四");
    expect(lisi).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/core/search.decompose.test.ts`
Expected: FAIL — `graphPrefetch` is not a method on `HybridSearch`

- [ ] **Step 3: Implement `graphPrefetch` on `HybridSearch`**

Add to `src/core/search.ts` inside `HybridSearch` class, after the `expandQuery` method (~line 200):

```typescript
  async graphPrefetch(query: string): Promise<GraphContext> {
    const context: GraphContext = { entities: [], chains: [] };

    // Extract candidate words: split by spaces, commas, Chinese commas, conjunctions
    const candidates = query
      .split(/[\s,，、；;和与跟以及]+/)
      .filter((w) => w.length >= 2);
    if (candidates.length === 0) return context;

    try {
      const resolved = this.db.resolveSlugs(candidates);
      const known = resolved.filter((r) => r.slug !== null);

      for (const r of known) {
        const neighbors = this.db.getOutgoingSlugs(r.slug!);
        const incoming = this.db.getIncomingSlugs(r.slug!);
        const allNeighborSlugs = [...new Set([...neighbors, ...incoming])];

        const neighborData: Array<{
          slug: string;
          title: string;
          relation: string;
        }> = [];
        for (const nSlug of allNeighborSlugs.slice(0, 5)) {
          const title = this.db.getPageTitle(nSlug);
          if (title) {
            neighborData.push({ slug: nSlug, title, relation: "提及" });
          }
        }

        context.entities.push({
          slug: r.slug!,
          title: r.title ?? r.slug!,
          type: this.db.getPageTitle(r.slug!) ? "entity" : "unknown",
          neighbors: neighborData,
        });
      }

      // Build simple chain descriptions
      for (const entity of context.entities) {
        for (const neighbor of entity.neighbors.slice(0, 3)) {
          context.chains.push(
            `${entity.title} --${neighbor.relation}--> ${neighbor.title}`
          );
        }
      }

      // Truncate to max chars
      const chainsStr = context.chains.join("\n");
      if (chainsStr.length > MAX_GRAPH_CONTEXT_CHARS) {
        let total = 0;
        const trimmed: string[] = [];
        for (const chain of context.chains) {
          if (total + chain.length > MAX_GRAPH_CONTEXT_CHARS) break;
          trimmed.push(chain);
          total += chain.length;
        }
        context.chains = trimmed;
      }
    } catch (e) {
      // graphPrefetch failure → empty context, don't block decomposition
      console.error("[search] graphPrefetch 失败:", e);
    }

    return context;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/core/search.decompose.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/search.ts tests/core/search.decompose.test.ts
git commit -m "feat(search): add graphPrefetch() for graph-aware context extraction"
```

---

### Task 3: Implement `decomposeQuery()`

**Files:**
- Modify: `src/core/search.ts` (add `decomposeQuery` method to `HybridSearch`)
- Modify: `tests/core/search.decompose.test.ts`

- [ ] **Step 1: Write failing tests for `decomposeQuery`**

Add to `tests/core/search.decompose.test.ts`:

```typescript
import type { LLMProvider } from "../../src/llm/provider.js";

function createMockLLM(responses: string[]): LLMProvider {
  let callIndex = 0;
  return {
    name: "mock",
    chat: async () =>
      responses[callIndex++] ??
      '{"sub_queries":[{"sub_query":"fallback","intent":"fallback"}]}',
  };
}

describe("HybridSearch.decomposeQuery", () => {
  const testDir = "/tmp/cbrain-test-decompose-query";
  const dbPath = join(testDir, "test.sqlite");
  let db: CBrainDB;
  let search: HybridSearch;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(dbPath);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("returns sub-queries from LLM", async () => {
    const llm = createMockLLM([
      JSON.stringify({
        sub_queries: [
          { sub_query: "张三的背景", intent: "个人背景" },
          { sub_query: "ABC项目详情", intent: "项目信息" },
        ],
      }),
    ]);
    search = new HybridSearch(db, createMockEmbeddingProvider(), createMockLance() as any, {
      rrf_k: 60,
      llm,
    });

    const result = await search.decomposeQuery(
      "张三和ABC项目",
      { entities: [], chains: [] }
    );
    expect(result).toEqual(["张三的背景", "ABC项目详情"]);
  });

  test("fallbacks to original query on LLM failure", async () => {
    const llm = createMockLLM(["not valid json"]);
    search = new HybridSearch(db, createMockEmbeddingProvider(), createMockLance() as any, {
      rrf_k: 60,
      llm,
    });

    const result = await search.decomposeQuery(
      "张三和李四",
      { entities: [], chains: [] }
    );
    expect(result).toEqual(["张三和李四"]);
  });

  test("fallbacks to original query when no LLM", async () => {
    search = new HybridSearch(db, createMockEmbeddingProvider(), createMockLance() as any, {
      rrf_k: 60,
    });

    const result = await search.decomposeQuery(
      "张三和李四",
      { entities: [], chains: [] }
    );
    expect(result).toEqual(["张三和李四"]);
  });

  test("truncates to 5 sub-queries max", async () => {
    const llm = createMockLLM([
      JSON.stringify({
        sub_queries: Array.from({ length: 8 }, (_, i) => ({
          sub_query: `子查询${i + 1}`,
          intent: `意图${i + 1}`,
        })),
      }),
    ]);
    search = new HybridSearch(db, createMockEmbeddingProvider(), createMockLance() as any, {
      rrf_k: 60,
      llm,
    });

    const result = await search.decomposeQuery(
      "复杂查询",
      { entities: [], chains: [] }
    );
    expect(result.length).toBeLessThanOrEqual(5);
  });

  test("includes graph context in LLM prompt", async () => {
    const calls: Array<{ role: string; content: string }[]> = [];
    const llm: LLMProvider = {
      name: "mock",
      chat: async (messages) => {
        calls.push(messages);
        return JSON.stringify({
          sub_queries: [{ sub_query: "张三", intent: "背景" }],
        });
      },
    };
    search = new HybridSearch(db, createMockEmbeddingProvider(), createMockLance() as any, {
      rrf_k: 60,
      llm,
    });

    await search.decomposeQuery("张三和ABC项目", {
      entities: [
        {
          slug: "entity/zhangsan",
          title: "张三",
          type: "entity/person",
          neighbors: [{ slug: "entity/abc", title: "ABC项目", relation: "co-founded" }],
        },
      ],
      chains: ["张三 --co-founded--> ABC项目"],
    });

    expect(calls.length).toBe(1);
    const systemMsg = calls[0].find((m) => m.role === "system")!;
    expect(systemMsg.content).toContain("张三");
    expect(systemMsg.content).toContain("ABC项目");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/core/search.decompose.test.ts`
Expected: FAIL — `decomposeQuery` is not a method on `HybridSearch`

- [ ] **Step 3: Implement `decomposeQuery` on `HybridSearch`**

Add to `src/core/search.ts` inside `HybridSearch` class, after `graphPrefetch`:

```typescript
  private static DECOMPOSE_TIMEOUT_MS = 10_000;
  private static MAX_SUB_QUERIES = 5;

  async decomposeQuery(
    query: string,
    graphContext: GraphContext
  ): Promise<string[]> {
    if (!this.llm) return [query];

    const contextParts: string[] = [];
    if (graphContext.entities.length > 0) {
      contextParts.push("已知实体:");
      for (const e of graphContext.entities) {
        const neighborStr =
          e.neighbors.length > 0
            ? e.neighbors.map((n) => `${n.title}(${n.relation})`).join(", ")
            : "无邻居";
        contextParts.push(`- ${e.title} (${e.type}) → 邻居: ${neighborStr}`);
      }
    }
    if (graphContext.chains.length > 0) {
      contextParts.push("关系链:");
      for (const chain of graphContext.chains) {
        contextParts.push(`- ${chain}`);
      }
    }
    const contextStr =
      contextParts.length > 0 ? contextParts.join("\n") : "无图谱信息";

    try {
      const resp = await this.llm.chat([
        {
          role: "system",
          content:
            "你是查询分解器。把复杂查询拆成2-5个独立的子查询。\n\n" +
            "规则:\n" +
            "- 每个子查询必须能独立检索，不依赖其他子查询的结果\n" +
            "- 利用图谱中的已知关系指导拆分方向\n" +
            "- 如果两个实体有直接关系，可以合并为一个子查询\n" +
            '- 输出JSON: {"sub_queries":[{"sub_query":"...","intent":"..."}]}\n\n' +
            `图谱上下文:\n${contextStr}`,
        },
        { role: "user", content: `查询: ${query}` },
      ]);

      const parsed = JSON.parse(resp) as {
        sub_queries: Array<{ sub_query: string; intent: string }>;
      };
      if (
        !Array.isArray(parsed.sub_queries) ||
        parsed.sub_queries.length === 0
      )
        return [query];

      return parsed.sub_queries
        .slice(0, HybridSearch.MAX_SUB_QUERIES)
        .map((sq) => sq.sub_query)
        .filter((q) => typeof q === "string" && q.trim());
    } catch (e) {
      console.error("[search] decomposeQuery 失败:", e);
      return [query];
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/core/search.decompose.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/search.ts tests/core/search.decompose.test.ts
git commit -m "feat(search): add decomposeQuery() with graph-aware LLM decomposition"
```

---

### Task 4: Wire decomposition into `search()` flow

**Files:**
- Modify: `src/core/search.ts` (modify `search()` method)
- Modify: `tests/core/search.decompose.test.ts`

- [ ] **Step 1: Write failing integration tests**

Add to `tests/core/search.decompose.test.ts`:

```typescript
describe("HybridSearch.search() decomposition integration", () => {
  const testDir = "/tmp/cbrain-test-decompose-integration";
  const dbPath = join(testDir, "test.sqlite");
  let db: CBrainDB;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(dbPath);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("simple query does not trigger decomposition", async () => {
    // Mock LLM that tracks calls
    const llmCalls: string[] = [];
    const llm: LLMProvider = {
      name: "mock",
      chat: async (messages) => {
        const userMsg = messages.find((m) => m.role === "user");
        llmCalls.push(userMsg?.content ?? "");
        // Return expansion format (array of strings) for expandQuery
        return JSON.stringify(["机器学习入门", "machine learning"]);
      },
    };
    const search = new HybridSearch(
      db,
      createMockEmbeddingProvider(),
      createMockLance() as any,
      { rrf_k: 60, llm }
    );

    await search.search("机器学习");
    // Should call expandQuery (returns variants), not decomposeQuery
    expect(llmCalls.length).toBe(1);
  });

  test("complex query triggers decomposition path", async () => {
    insertPage(db, "entity/zhangsan", "张三", "entity/person", 5);
    insertPage(db, "entity/lisi", "李四", "entity/person", 3);

    const llmCalls: Array<{ role: string; content: string }[]> = [];
    let callIndex = 0;
    const responses = [
      // graphPrefetch doesn't use LLM, so first call is decomposeQuery
      JSON.stringify({
        sub_queries: [
          { sub_query: "张三", intent: "背景" },
          { sub_query: "李四", intent: "背景" },
        ],
      }),
    ];
    const llm: LLMProvider = {
      name: "mock",
      chat: async (messages) => {
        llmCalls.push(messages);
        return responses[callIndex++] ?? "[]";
      },
    };
    const search = new HybridSearch(
      db,
      createMockEmbeddingProvider(),
      createMockLance() as any,
      { rrf_k: 60, llm }
    );

    const results = await search.search("张三和李四的合作");
    // Should have called decomposeQuery (system prompt contains "查询分解器")
    const hasDecompose = llmCalls.some((msgs) =>
      msgs.some((m) => m.content.includes("查询分解器"))
    );
    expect(hasDecompose).toBe(true);
    // Results should be an array (may be empty since no chunks exist)
    expect(Array.isArray(results)).toBe(true);
  });

  test("decomposition fallbacks to expandQuery on LLM failure", async () => {
    insertPage(db, "entity/zhangsan", "张三", "entity/person", 5);
    insertPage(db, "entity/lisi", "李四", "entity/person", 3);

    let callIndex = 0;
    const responses = [
      "invalid json from decompose", // decomposeQuery fails
      JSON.stringify(["张三李四合作", "合作记录"]), // expandQuery fallback
    ];
    const llm: LLMProvider = {
      name: "mock",
      chat: async () => responses[callIndex++] ?? "[]",
    };
    const search = new HybridSearch(
      db,
      createMockEmbeddingProvider(),
      createMockLance() as any,
      { rrf_k: 60, llm }
    );

    // Should not throw
    const results = await search.search("张三和李四");
    expect(Array.isArray(results)).toBe(true);
  });

  test("_skipDecompose prevents recursion", async () => {
    insertPage(db, "entity/zhangsan", "张三", "entity/person", 5);
    insertPage(db, "entity/lisi", "李四", "entity/person", 3);

    let callCount = 0;
    const llm: LLMProvider = {
      name: "mock",
      chat: async () => {
        callCount++;
        return JSON.stringify({
          sub_queries: [{ sub_query: "张三", intent: "bg" }],
        });
      },
    };
    const search = new HybridSearch(
      db,
      createMockEmbeddingProvider(),
      createMockLance() as any,
      { rrf_k: 60, llm }
    );

    await search.search("张三和李四", { _skipDecompose: true } as any);
    // Should NOT call LLM for decomposition (skipDecompose = true)
    // expandQuery may still be called
    expect(callCount).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/core/search.decompose.test.ts`
Expected: FAIL — complex query does not trigger decomposition, `_skipDecompose` not recognized

- [ ] **Step 3: Modify `SearchOptions` and `search()` method**

Update `SearchOptions` interface in `src/core/search.ts`:

```typescript
export interface SearchOptions {
  limit?: number;
  strategy?: "vector" | "fts" | "graph" | "all";
  multiQuery?: boolean;
  /** @internal Skip decomposition for sub-queries (prevents recursion) */
  _skipDecompose?: boolean;
}
```

Replace the `search()` method body (lines 106-168) with:

```typescript
  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    if (!query.trim()) return [];

    const limit = options?.limit ?? 10;
    const strategy = options?.strategy ?? "all";

    if (strategy === "vector") {
      return this.vectorSearch(query, limit);
    }
    if (strategy === "fts") {
      return this.ftsSearch(query, limit);
    }
    if (strategy === "graph") {
      return this.graphSearch(query, limit);
    }

    // Exact title match fast path
    const exact = this.db.getPageByTitle(query.trim());
    if (exact) {
      return [{ slug: exact.slug, score: 1.0, snippet: exact.title, source: "exact" as const }];
    }

    // Decomposition path (complex queries, skip for sub-queries)
    const canDecompose = !!this.llm && !options?._skipDecompose;
    if (canDecompose) {
      const candidates = query.split(/[\s,，、；;和与跟以及]+/).filter(w => w.length >= 2);
      const resolved = this.db.resolveSlugs(candidates);
      const knownSlugs = resolved.filter(r => r.slug !== null).map(r => r.slug!);

      if (isComplexQuery(query, knownSlugs)) {
        try {
          const graphContext = await this.graphPrefetch(query);
          const subQueries = await this.decomposeQuery(query, graphContext);

          if (subQueries.length > 1) {
            const subResults = await Promise.all(
              subQueries.map((sq) =>
                this.search(sq, { limit, strategy: "all", _skipDecompose: true }).catch(() => [] as SearchResult[])
              )
            );

            const allLists = subResults.filter((r) => r.length > 0);
            if (allLists.length === 0) {
              // All sub-queries failed, fallback to original query
              return this.searchWithExpansion(query, limit);
            }

            const allSlugs = new Set<string>();
            for (const list of allLists) for (const item of list) allSlugs.add(item.slug);
            const activityWeights = allSlugs.size > 0 ? this.db.getActivityWeights([...allSlugs]) : undefined;
            const hotnessWeights = allSlugs.size > 0 ? this.db.getHotnessWeights([...allSlugs]) : undefined;

            return mergeRankedResults(allLists, this.rrfK, limit, activityWeights, hotnessWeights);
          }
        } catch (e) {
          console.error("[search] decomposition 路径失败，fallback 到 expandQuery:", e);
          // Fall through to expandQuery path
        }
      }
    }

    return this.searchWithExpansion(query, limit);
  }

  private async searchWithExpansion(query: string, limit: number): Promise<SearchResult[]> {
    const useMultiQuery = this.multiQueryEnabled && !!this.llm;
    const queries = useMultiQuery ? await this.expandQuery(query) : [query];

    const allLists: SearchResult[][] = [];

    for (const q of queries) {
      const resolved = this.db.resolveSlugs([q])[0];
      const graphPromise = resolved?.slug
        ? this.graphSearch(resolved.slug, limit).catch((e) => {
            console.error("[search] graphSearch 失败:", e);
            return [] as SearchResult[];
          })
        : Promise.resolve([] as SearchResult[]);

      const [vec, fts, graph, temporal] = await Promise.all([
        this.vectorSearch(q, limit).catch((e) => {
          console.error("[search] vectorSearch 失败:", e);
          return [] as SearchResult[];
        }),
        Promise.resolve(this.ftsSearch(q, limit)).catch((e) => {
          console.error("[search] ftsSearch 失败:", e);
          return [] as SearchResult[];
        }),
        graphPromise,
        Promise.resolve(this.temporalSearch(q, limit)),
      ]);
      if (vec.length > 0) allLists.push(vec);
      if (fts.length > 0) allLists.push(fts);
      if (graph.length > 0) allLists.push(graph);
      if (temporal.length > 0) allLists.push(temporal);
    }

    const allSlugs = new Set<string>();
    for (const list of allLists) for (const item of list) allSlugs.add(item.slug);
    const activityWeights = allSlugs.size > 0 ? this.db.getActivityWeights([...allSlugs]) : undefined;
    const hotnessWeights = allSlugs.size > 0 ? this.db.getHotnessWeights([...allSlugs]) : undefined;

    return mergeRankedResults(allLists, this.rrfK, limit, activityWeights, hotnessWeights);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/core/search.decompose.test.ts`
Expected: PASS

- [ ] **Step 5: Run full lint + test suite**

Run: `bun run lint && bun test`
Expected: PASS — all existing tests still pass

- [ ] **Step 6: Commit**

```bash
git add src/core/search.ts tests/core/search.decompose.test.ts
git commit -m "feat(search): wire decomposition into search() with recursion guard"
```

---

### Task 5: Existing search test compatibility verification

**Files:**
- No changes, verification only

- [ ] **Step 1: Run the full test suite**

Run: `bun run lint && bun test`
Expected: All tests pass — existing `tests/core/search.test.ts` unaffected

- [ ] **Step 2: Verify test count**

Run: `bun test 2>&1 | tail -5`
Expected: Test count unchanged or increased (new tests added)

- [ ] **Step 3: Final commit if any adjustments needed**

If any test broke, fix inline and commit:

```bash
git add -u
git commit -m "fix(search): adjust decomposition integration for test compatibility"
```

---

## Self-Review Checklist

- [x] **Spec coverage:** Each spec section (complexity detection, graph prefetch, LLM decomposition, sub-query retrieval, merge, error handling, recursion guard) maps to a task
- [x] **Placeholder scan:** No TBD, TODO, or vague steps — every step has complete code
- [x] **Type consistency:** `GraphContext`, `isComplexQuery`, `decomposeQuery`, `graphPrefetch` signatures are consistent across all tasks. `SearchOptions._skipDecompose` is added before use in Task 4

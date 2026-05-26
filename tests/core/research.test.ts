import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HybridSearch, type SearchResult, type GraphContext } from "../../src/core/search.js";
import { ResearchManager } from "../../src/core/research.js";
import { CBrainDB } from "../../src/storage/sqlite.js";
import type { LLMProvider } from "../../src/llm/provider.js";

function createMockLLM(responses: string[]): LLMProvider & { calls: string[][] } {
  let callIndex = 0;
  const calls: string[][] = [];
  return {
    name: "mock",
    calls,
    chat: async (messages) => {
      calls.push(messages.map((m: { content: string }) => m.content));
      return responses[callIndex++] ?? '{"sufficient": true, "reason": "default"}';
    },
  };
}

function insertPage(
  db: CBrainDB,
  slug: string,
  title: string,
  type: string,
  mentionCount = 0,
) {
  db.prepare(
    "INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(slug, type, title, `${slug}.md`, `h-${slug}`, mentionCount);
}

function insertLink(
  db: CBrainDB,
  fromSlug: string,
  toSlug: string,
  relation = "related",
) {
  db.prepare(
    "INSERT INTO links (from_slug, to_slug, relation, weight) VALUES (?, ?, ?, ?)",
  ).run(fromSlug, toSlug, relation, 1.0);
}

function makeResult(slug: string, score: number, snippet = ""): SearchResult {
  return { slug, score, snippet: snippet || `Content of ${slug}`, source: "hybrid" };
}

describe("ResearchManager", () => {
  const testDir = "/tmp/cbrain-test-research";
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

  function createMockSearch(responses: Map<string, SearchResult[]>): HybridSearch {
    return {
      search: async (query: string, _options?: unknown) => responses.get(query) ?? [],
    } as unknown as HybridSearch;
  }

  // ─── Pure function tests ─────────────────────────────────────────

  test("mergeResults deduplicates by slug, higher score wins", () => {
    const mockSearch = createMockSearch(new Map());
    const researcher = new ResearchManager(mockSearch, db);

    const existing: SearchResult[] = [
      makeResult("a", 0.5, "old"),
      makeResult("b", 0.3, "keep"),
    ];
    const incoming: SearchResult[] = [
      makeResult("a", 0.8, "new"),
      makeResult("c", 0.4, "add"),
    ];

    const merged = researcher.mergeResults(existing, incoming);
    expect(merged.length).toBe(3);
    const aResult = merged.find((r) => r.slug === "a")!;
    expect(aResult.score).toBe(0.8);
    expect(aResult.snippet).toBe("new");
  });

  test("mergeResults preserves all unique slugs", () => {
    const mockSearch = createMockSearch(new Map());
    const researcher = new ResearchManager(mockSearch, db);

    const existing: SearchResult[] = [makeResult("a", 0.5)];
    const incoming: SearchResult[] = [
      makeResult("b", 0.3),
      makeResult("c", 0.4),
    ];

    const merged = researcher.mergeResults(existing, incoming);
    expect(merged.map((r) => r.slug).sort()).toEqual(["a", "b", "c"]);
  });

  test("expandGraphContext adds neighbors", () => {
    insertPage(db, "entity/a", "A", "entity/person");
    insertPage(db, "entity/b", "B", "entity/person");
    insertLink(db, "entity/a", "entity/b", "influences");

    const mockSearch = createMockSearch(new Map());
    const researcher = new ResearchManager(mockSearch, db);

    const result = researcher.expandGraphContext(
      { entities: [], chains: [] },
      ["entity/a"],
    );

    expect(result.entities.length).toBe(1);
    expect(result.entities[0].title).toBe("A");
    expect(result.entities[0].neighbors.length).toBe(1);
    expect(result.entities[0].neighbors[0].title).toBe("B");
    expect(result.chains.length).toBe(1);
  });

  test("expandGraphContext does not duplicate existing entities", () => {
    insertPage(db, "entity/a", "A", "entity/person");
    insertPage(db, "entity/b", "B", "entity/person");

    const mockSearch = createMockSearch(new Map());
    const researcher = new ResearchManager(mockSearch, db);

    const ctx: GraphContext = {
      entities: [{ slug: "entity/a", title: "A", type: "entity/person", neighbors: [] }],
      chains: ["A → "],
    };
    const result = researcher.expandGraphContext(ctx, ["entity/a"]);

    expect(result.entities.length).toBe(1);
  });

  test("expandGraphContext with empty slugs returns unchanged", () => {
    const mockSearch = createMockSearch(new Map());
    const researcher = new ResearchManager(mockSearch, db);

    const ctx: GraphContext = { entities: [], chains: [] };
    const result = researcher.expandGraphContext(ctx, []);

    expect(result.entities.length).toBe(0);
  });

  test("expandGraphContext with no DB match skips unknown slugs", () => {
    const mockSearch = createMockSearch(new Map());
    const researcher = new ResearchManager(mockSearch, db);

    const ctx: GraphContext = { entities: [], chains: [] };
    const result = researcher.expandGraphContext(ctx, ["nonexistent/slug"]);

    expect(result.entities.length).toBe(0);
  });

  // ─── ReAct loop tests ────────────────────────────────────────────

  test("sufficient initial results → no follow-up", async () => {
    const searchResponses = new Map<string, SearchResult[]>([
      ["塔勒布和芒格", [makeResult("entity/塔勒布", 0.9), makeResult("entity/芒格", 0.8)]],
    ]);

    const llm = createMockLLM([
      '{"reasoning":"找到两个核心实体","sufficient":true,"follow_up_queries":[]}',
      '{"order": [1, 2]}',
    ]);

    const researcher = new ResearchManager(
      createMockSearch(searchResponses), db, llm,
    );
    const results = await researcher.research("塔勒布和芒格");

    expect(results.length).toBe(2);
    expect(llm.calls.length).toBe(2);
    expect(llm.calls[0].some((c) => c.includes("搜索推理引擎"))).toBe(true);
    expect(llm.calls[1].some((c) => c.includes("排序器"))).toBe(true);
  });

  test("insufficient results → generates follow-up queries", async () => {
    const searchResponses = new Map<string, SearchResult[]>([
      ["塔勒布和芒格的投资哲学", [makeResult("entity/塔勒布", 0.9), makeResult("entity/芒格", 0.8)]],
      ["反脆弱和多元思维模型的交集", [makeResult("concept/行为经济学", 0.7)]],
      ["够了", []],
    ]);

    const llm = createMockLLM([
      '{"reasoning":"需要找关联","sufficient":false,"follow_up_queries":[{"query":"反脆弱和多元思维模型的交集","intent":"寻找关联"}]}',
      '{"reasoning":"够了","sufficient":true,"follow_up_queries":[]}',
      '{"order": [1, 2, 3]}',
    ]);

    const researcher = new ResearchManager(
      createMockSearch(searchResponses), db, llm,
    );
    const results = await researcher.research("塔勒布和芒格的投资哲学");

    expect(results.length).toBe(3);
    // reasoning (not sufficient) + reasoning (sufficient) + rerank = 3 calls
    expect(llm.calls.length).toBe(3);
  });

  test("stops at maxIterations", async () => {
    const searchResponses = new Map<string, SearchResult[]>([
      ["test", [makeResult("entity/a", 0.5)]],
      ["搜索X", [makeResult("entity/b", 0.4)]],
      ["搜索Y", [makeResult("entity/c", 0.3)]],
      ["搜索Z", [makeResult("entity/d", 0.2)]],
    ]);

    const llm = createMockLLM([
      '{"reasoning":"不够","sufficient":false,"follow_up_queries":[{"query":"搜索X","intent":"test"}]}',
      '{"reasoning":"不够","sufficient":false,"follow_up_queries":[{"query":"搜索Y","intent":"test"}]}',
      '{"reasoning":"不够","sufficient":false,"follow_up_queries":[{"query":"搜索Z","intent":"test"}]}',
      '{"order": [1]}',
    ]);

    const researcher = new ResearchManager(
      createMockSearch(searchResponses), db, llm,
      { maxIterations: 2 },
    );
    const results = await researcher.research("test");

    expect(Array.isArray(results)).toBe(true);
    // 2 reasoning + 1 rerank = 3 calls (3rd reasoning never called)
    expect(llm.calls.length).toBe(3);
  });

  test("stops when LLM says sufficient", async () => {
    const searchResponses = new Map<string, SearchResult[]>([
      ["A", [makeResult("entity/a", 0.9), makeResult("entity/b", 0.8)]],
    ]);

    const llm = createMockLLM([
      '{"reasoning":"够了","sufficient":true,"follow_up_queries":[]}',
      '{"order": [1, 2]}',
    ]);

    const researcher = new ResearchManager(
      createMockSearch(searchResponses), db, llm,
      { maxIterations: 5 },
    );
    const results = await researcher.research("A");

    expect(llm.calls.length).toBe(2);
    expect(results.length).toBe(2);
  });

  test("stops when no follow-up queries generated", async () => {
    const searchResponses = new Map<string, SearchResult[]>([
      ["A", [makeResult("entity/a", 0.9), makeResult("entity/b", 0.8)]],
    ]);

    const llm = createMockLLM([
      '{"reasoning":"没什么可搜了","sufficient":false,"follow_up_queries":[]}',
      '{"order": [1, 2]}',
    ]);

    const researcher = new ResearchManager(
      createMockSearch(searchResponses), db, llm,
    );
    const results = await researcher.research("A");

    expect(llm.calls.length).toBe(2);
    expect(results.length).toBe(2);
  });

  test("no LLM → degrades to searchCore via search.search()", async () => {
    const searchResponses = new Map<string, SearchResult[]>([
      ["A", [makeResult("entity/a", 0.9)]],
    ]);

    const researcher = new ResearchManager(
      createMockSearch(searchResponses), db,
    );
    const results = await researcher.research("A", { multiStep: false });

    expect(results.length).toBe(1);
    expect(results[0].slug).toBe("entity/a");
  });

  test("empty results → returns empty", async () => {
    const searchResponses = new Map<string, SearchResult[]>([
      ["完全不存在的东西", []],
    ]);

    const llm = createMockLLM([]);
    const researcher = new ResearchManager(
      createMockSearch(searchResponses), db, llm,
    );
    const results = await researcher.research("完全不存在的东西");

    expect(results).toEqual([]);
    expect(llm.calls.length).toBe(0);
  });

  test("follow-up queries deduplicated against issued queries", async () => {
    const searchResponses = new Map<string, SearchResult[]>([
      ["A", [makeResult("entity/a", 0.9), makeResult("entity/b", 0.8)]],
    ]);

    const llm = createMockLLM([
      '{"reasoning":"试试原query","sufficient":false,"follow_up_queries":[{"query":"A","intent":"already searched"}]}',
      '{"order": [1, 2]}',
    ]);

    const researcher = new ResearchManager(
      createMockSearch(searchResponses), db, llm,
    );
    const results = await researcher.research("A");

    // "A" was the original query → filtered out → no follow-up → break
    expect(llm.calls.length).toBe(2); // reasoning + rerank
    expect(results.length).toBe(2);
  });

  test("malformed LLM response → safe degradation", async () => {
    const searchResponses = new Map<string, SearchResult[]>([
      ["A", [makeResult("entity/a", 0.9)]],
    ]);

    const llm = createMockLLM([
      "this is not json at all",
      '{"order": [1]}',
    ]);

    const researcher = new ResearchManager(
      createMockSearch(searchResponses), db, llm,
    );
    const results = await researcher.research("A");

    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(1);
  });

  test("discovered entities accumulate across iterations", async () => {
    insertPage(db, "entity/a", "A", "entity/person");
    insertPage(db, "entity/b", "B", "entity/person");
    insertLink(db, "entity/a", "entity/b", "related");

    const searchResponses = new Map<string, SearchResult[]>([
      ["A", [makeResult("entity/a", 0.9)]],
      ["B related to A", [makeResult("entity/b", 0.8)]],
    ]);

    const llm = createMockLLM([
      '{"reasoning":"需要找B","sufficient":false,"follow_up_queries":[{"query":"B related to A","intent":"找关联"}]}',
      '{"reasoning":"够了","sufficient":true,"follow_up_queries":[]}',
      '{"order": [1, 2]}',
    ]);

    const researcher = new ResearchManager(
      createMockSearch(searchResponses), db, llm,
    );
    const results = await researcher.research("A");

    expect(results.length).toBe(2);
    expect(results.map((r) => r.slug).sort()).toEqual(["entity/a", "entity/b"]);
  });

  test("final results are reranked by LLM", async () => {
    const searchResponses = new Map<string, SearchResult[]>([
      ["Alpha Beta", [makeResult("entity/a", 0.9, "Alpha"), makeResult("entity/b", 0.8, "Beta")]],
    ]);

    const llm = createMockLLM([
      '{"reasoning":"够了","sufficient":true,"follow_up_queries":[]}',
      '{"order": [2, 1]}',
    ]);

    const researcher = new ResearchManager(
      createMockSearch(searchResponses), db, llm,
    );
    const results = await researcher.research("Alpha Beta");

    // Rerank swapped order
    expect(results[0].slug).toBe("entity/b");
    expect(results[1].slug).toBe("entity/a");
  });

  test("graph with no neighbors does not crash", async () => {
    insertPage(db, "entity/orphan", "孤立实体", "entity/person");

    const searchResponses = new Map<string, SearchResult[]>([
      ["孤立实体", [makeResult("entity/orphan", 0.9)]],
    ]);

    const llm = createMockLLM([
      '{"reasoning":"够了","sufficient":true,"follow_up_queries":[]}',
      '{"order": [1]}',
    ]);

    const researcher = new ResearchManager(
      createMockSearch(searchResponses), db, llm,
    );
    const results = await researcher.research("孤立实体");

    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(1);
  });

  test("multiple follow-up queries in one iteration", async () => {
    const searchResponses = new Map<string, SearchResult[]>([
      ["complex query", [makeResult("entity/a", 0.9)]],
      ["follow1", [makeResult("entity/b", 0.8)]],
      ["follow2", [makeResult("entity/c", 0.7)]],
    ]);

    const llm = createMockLLM([
      '{"reasoning":"需要两个方向","sufficient":false,"follow_up_queries":[{"query":"follow1","intent":"方向1"},{"query":"follow2","intent":"方向2"}]}',
      '{"reasoning":"够了","sufficient":true,"follow_up_queries":[]}',
      '{"order": [1, 2, 3]}',
    ]);

    const researcher = new ResearchManager(
      createMockSearch(searchResponses), db, llm,
    );
    const results = await researcher.research("complex query");

    expect(results.length).toBe(3);
    expect(results.map((r) => r.slug).sort()).toEqual(["entity/a", "entity/b", "entity/c"]);
  });

  test("maxFollowUpQueries limits follow-up count", async () => {
    const searchResponses = new Map<string, SearchResult[]>([
      ["test", [makeResult("entity/a", 0.9)]],
      ["f1", [makeResult("entity/b", 0.8)]],
    ]);

    const llm = createMockLLM([
      '{"reasoning":"很多方向","sufficient":false,"follow_up_queries":[{"query":"f1","intent":"1"},{"query":"f2","intent":"2"},{"query":"f3","intent":"3"},{"query":"f4","intent":"4"}]}',
      '{"reasoning":"够了","sufficient":true,"follow_up_queries":[]}',
      '{"order": [1]}',
    ]);

    const researcher = new ResearchManager(
      createMockSearch(searchResponses), db, llm,
      { maxFollowUpQueries: 1 },
    );
    const results = await researcher.research("test");

    // Only 1 follow-up query allowed, so only "f1" is searched
    expect(results.length).toBe(2); // a + b
  });

  test("respect limit on final results", async () => {
    const searchResponses = new Map<string, SearchResult[]>([
      ["test", [
        makeResult("a", 0.9), makeResult("b", 0.8), makeResult("c", 0.7),
        makeResult("d", 0.6), makeResult("e", 0.5),
      ]],
    ]);

    const llm = createMockLLM([
      '{"reasoning":"够了","sufficient":true,"follow_up_queries":[]}',
      '{"order": [1, 2, 3, 4, 5]}',
    ]);

    const researcher = new ResearchManager(
      createMockSearch(searchResponses), db, llm,
    );
    const results = await researcher.research("test", { limit: 3 });

    expect(results.length).toBe(3);
  });

  test("duplicate follow-up across iterations is skipped", async () => {
    const searchResponses = new Map<string, SearchResult[]>([
      ["主题A", [makeResult("entity/a", 0.9)]],
      ["方向B", [makeResult("entity/b", 0.8)]],
    ]);

    const llm = createMockLLM([
      // Round 1: insufficient → suggest "方向B"
      '{"reasoning":"不够","sufficient":false,"follow_up_queries":[{"query":"方向B","intent":"扩展"}]}',
      // Round 2: LLM returns "方向B" again (duplicate), plus new "方向C"
      '{"reasoning":"再试试","sufficient":false,"follow_up_queries":[{"query":"方向B","intent":"重复"},{"query":"方向C","intent":"新方向"}]}',
      // Round 3: sufficient (or newQueries empty since "方向C" not in mock → empty results → still loops once more then stops)
      '{"reasoning":"够了","sufficient":true,"follow_up_queries":[]}',
      '{"order": [1, 2]}',
    ]);

    const researcher = new ResearchManager(
      createMockSearch(searchResponses), db, llm,
    );
    const results = await researcher.research("主题A");

    // "方向B" should only be searched once (round 1). Round 2's duplicate is filtered.
    expect(results.length).toBe(2);
    expect(llm.calls.length).toBe(4); // 3 reasoning + 1 rerank
  });

  // ─── Trace propagation tests ─────────────────────────────────────

  test("trace captures rerank_ms from research", async () => {
    const searchResponses = new Map<string, SearchResult[]>([
      ["X", [makeResult("entity/a", 0.9), makeResult("entity/b", 0.8)]],
    ]);
    const llm = createMockLLM([
      '{"reasoning":"够了","sufficient":true,"follow_up_queries":[]}',
      '{"order": [1, 2]}',
    ]);

    const researcher = new ResearchManager(createMockSearch(searchResponses), db, llm);
    const trace: import("../../src/core/search.js").SearchTrace = {};
    await researcher.research("X", { _trace: trace });

    expect(typeof trace.rerank_ms).toBe("number");
    expect(trace.rerank_ms!).toBeGreaterThanOrEqual(0);
  });

  test("trace captures follow_up_queries across iterations", async () => {
    const searchResponses = new Map<string, SearchResult[]>([
      ["root", [makeResult("entity/a", 0.9)]],
      ["branch1", [makeResult("entity/b", 0.8)]],
      ["branch2", [makeResult("entity/c", 0.7)]],
    ]);
    const llm = createMockLLM([
      '{"reasoning":"不够","sufficient":false,"follow_up_queries":[{"query":"branch1","intent":"方向1"},{"query":"branch2","intent":"方向2"}]}',
      '{"reasoning":"够了","sufficient":true,"follow_up_queries":[]}',
      '{"order": [1, 2, 3]}',
    ]);

    const researcher = new ResearchManager(createMockSearch(searchResponses), db, llm);
    const trace: import("../../src/core/search.js").SearchTrace = {};
    await researcher.research("root", { _trace: trace });

    expect(trace.follow_up_queries).toBeDefined();
    expect(trace.follow_up_queries!).toEqual(["branch1", "branch2"]);
  });

  test("trace sets degraded_reason on malformed LLM response", async () => {
    const searchResponses = new Map<string, SearchResult[]>([
      ["bad", [makeResult("entity/a", 0.9)]],
    ]);
    const llm = createMockLLM([
      "not json",
      '{"order": [1]}',
    ]);

    const researcher = new ResearchManager(createMockSearch(searchResponses), db, llm);
    const trace: import("../../src/core/search.js").SearchTrace = {};
    await researcher.research("bad", { _trace: trace });

    expect(trace.degraded_reason).toBe("reasoning_parse_failed");
  });

  test("llmCallCount tracks reasoning + rerank calls", async () => {
    const searchResponses = new Map<string, SearchResult[]>([
      ["count", [makeResult("entity/a", 0.9)]],
      ["more", [makeResult("entity/b", 0.8)]],
    ]);
    const llm = createMockLLM([
      '{"reasoning":"不够","sufficient":false,"follow_up_queries":[{"query":"more","intent":"test"}]}',
      '{"reasoning":"够了","sufficient":true,"follow_up_queries":[]}',
      '{"order": [1, 2]}',
    ]);

    const researcher = new ResearchManager(createMockSearch(searchResponses), db, llm);
    await researcher.research("count");

    // 2 reasoning + 1 rerank = 3 LLM calls
    expect(researcher.getLLMCallCount()).toBe(3);
  });

  test("trace captures rerank_ms and follow_up_queries together", async () => {
    const searchResponses = new Map<string, SearchResult[]>([
      ["combo", [makeResult("entity/a", 0.9)]],
      ["extra", [makeResult("entity/b", 0.8)]],
    ]);
    const llm = createMockLLM([
      '{"reasoning":"不够","sufficient":false,"follow_up_queries":[{"query":"extra","intent":"more"}]}',
      '{"reasoning":"够了","sufficient":true,"follow_up_queries":[]}',
      '{"order": [1, 2]}',
    ]);

    const researcher = new ResearchManager(createMockSearch(searchResponses), db, llm);
    const trace: import("../../src/core/search.js").SearchTrace = {};
    await researcher.research("combo", { _trace: trace });

    expect(typeof trace.rerank_ms).toBe("number");
    expect(trace.follow_up_queries).toEqual(["extra"]);
  });

  // ─── Normalized dedup tests (#64) ──────────────────────────────────

  test("follow-up dedup normalizes whitespace", async () => {
    const searchResponses = new Map<string, SearchResult[]>([
      ["方向A", [makeResult("entity/a", 0.9), makeResult("entity/b", 0.8)]],
    ]);
    const llm = createMockLLM([
      '{"reasoning":"不够","sufficient":false,"follow_up_queries":[{"query":"方向A ","intent":"重复(尾空格)"}]}',
      '{"order": [1, 2]}',
    ]);

    const researcher = new ResearchManager(createMockSearch(searchResponses), db, llm);
    const results = await researcher.research("方向A");

    // "方向A " (with trailing space) should be deduped against original "方向A"
    expect(llm.calls.length).toBe(2); // reasoning + rerank, no second iteration
    expect(results.length).toBe(2);
  });

  test("follow-up dedup normalizes punctuation", async () => {
    const searchResponses = new Map<string, SearchResult[]>([
      ["主题X", [makeResult("entity/a", 0.9), makeResult("entity/b", 0.8)]],
    ]);
    const llm = createMockLLM([
      '{"reasoning":"不够","sufficient":false,"follow_up_queries":[{"query":"主题X。","intent":"重复(句号)"}]}',
      '{"order": [1, 2]}',
    ]);

    const researcher = new ResearchManager(createMockSearch(searchResponses), db, llm);
    const results = await researcher.research("主题X");

    expect(llm.calls.length).toBe(2);
    expect(results.length).toBe(2);
  });

  test("follow-up dedup normalizes case", async () => {
    const searchResponses = new Map<string, SearchResult[]>([
      ["React hooks", [makeResult("concept/react-hooks", 0.9), makeResult("entity/a", 0.8)]],
    ]);
    const llm = createMockLLM([
      '{"reasoning":"不够","sufficient":false,"follow_up_queries":[{"query":"react HOOKS","intent":"重复(大小写)"}]}',
      '{"order": [1, 2]}',
    ]);

    const researcher = new ResearchManager(createMockSearch(searchResponses), db, llm);
    const results = await researcher.research("React hooks");

    expect(llm.calls.length).toBe(2);
    expect(results.length).toBe(2);
  });

  test("follow-up with genuinely different query passes through", async () => {
    const searchResponses = new Map<string, SearchResult[]>([
      ["主题Y", [makeResult("entity/a", 0.9)]],
      ["方向Z", [makeResult("entity/b", 0.8)]],
    ]);
    const llm = createMockLLM([
      '{"reasoning":"不够","sufficient":false,"follow_up_queries":[{"query":"方向Z","intent":"新方向"}]}',
      '{"reasoning":"够了","sufficient":true,"follow_up_queries":[]}',
      '{"order": [1, 2]}',
    ]);

    const researcher = new ResearchManager(createMockSearch(searchResponses), db, llm);
    const results = await researcher.research("主题Y");

    expect(results.length).toBe(2);
    expect(llm.calls.length).toBe(3); // reasoning + reasoning + rerank
  });

  test("all follow-up queries are recorded in issuedQueries", async () => {
    const searchedQueries: string[] = [];
    const searchResponses = new Map<string, SearchResult[]>([
      ["主题B", [makeResult("entity/a", 0.9)]],
      ["方向X", [makeResult("entity/b", 0.8)]],
      ["方向Y", [makeResult("entity/c", 0.7)]],
    ]);
    const mockSearch: HybridSearch = {
      search: async (query: string, _options?: unknown) => {
        searchedQueries.push(query);
        return searchResponses.get(query) ?? [];
      },
    } as unknown as HybridSearch;

    const llm = createMockLLM([
      '{"reasoning":"两个方向","sufficient":false,"follow_up_queries":[{"query":"方向X","intent":"扩展X"},{"query":"方向Y","intent":"扩展Y"}]}',
      '{"reasoning":"够了","sufficient":true,"follow_up_queries":[]}',
      '{"order": [1, 2, 3]}',
    ]);

    const researcher = new ResearchManager(mockSearch, db, llm);
    await researcher.research("主题B");

    // Original + 2 follow-ups = 3 searches
    expect(searchedQueries).toEqual(["主题B", "方向X", "方向Y"]);
  });

  // ─── Same-round dedup tests (#64) ───────────────────────────────────

  test("same-round duplicate follow-up is deduplicated", async () => {
    const searchResponses = new Map<string, SearchResult[]>([
      ["root", [makeResult("entity/a", 0.9)]],
      ["方向X", [makeResult("entity/b", 0.8)]],
    ]);
    const llm = createMockLLM([
      // LLM returns same query twice in one response
      '{"reasoning":"不够","sufficient":false,"follow_up_queries":[{"query":"方向X","intent":"方向1"},{"query":"方向X","intent":"方向2(重复)"}]}',
      '{"reasoning":"够了","sufficient":true,"follow_up_queries":[]}',
      '{"order": [1, 2]}',
    ]);

    const researcher = new ResearchManager(createMockSearch(searchResponses), db, llm);
    const results = await researcher.research("root");

    // "方向X" should only be searched once despite appearing twice in one LLM response
    expect(results.length).toBe(2);
    expect(llm.calls.length).toBe(3); // reasoning + reasoning + rerank
  });

  test("slice preserves valid queries after filtering duplicates (#64)", async () => {
    const searchResponses = new Map<string, SearchResult[]>([
      ["root", [makeResult("entity/a", 0.9)]],
      ["fresh1", [makeResult("entity/b", 0.8)]],
    ]);
    const llm = createMockLLM([
      // Mix of: historical dupe, same-round dupe, fresh queries
      // maxFollowUpQueries = 2
      // After same-round dedup: [root(deduped), root(deduped), fresh1, fresh2] → [fresh1, fresh2]
      // After history filter: [root removed] → [fresh1, fresh2]
      // Slice(0,2): [fresh1, fresh2]
      '{"reasoning":"不够","sufficient":false,"follow_up_queries":[{"query":"root","intent":"重复原查询"},{"query":"root","intent":"再次重复"},{"query":"fresh1","intent":"新方向1"},{"query":"fresh2","intent":"新方向2"}]}',
      '{"reasoning":"够了","sufficient":true,"follow_up_queries":[]}',
      '{"order": [1, 2]}',
    ]);

    const researcher = new ResearchManager(
      createMockSearch(searchResponses), db, llm,
      { maxFollowUpQueries: 2 },
    );
    const results = await researcher.research("root");

    // fresh1 was searched, fresh2 was searched (not lost to premature slice)
    expect(results.length).toBe(2);
    expect(llm.calls.length).toBe(3);
  });

  // ─── Follow-up trace propagation tests (#62) ─────────────────────────

  test("follow-up searches receive _trace and can write timing data", async () => {
    const searchResponses = new Map<string, SearchResult[]>([
      ["traceRoot", [makeResult("entity/a", 0.9)]],
      ["traceFollow", [makeResult("entity/b", 0.8)]],
    ]);

    // Custom mock that writes to _trace when called
    const mockSearch: HybridSearch = {
      search: async (query: string, options?: unknown) => {
        const opts = options as import("../../src/core/search.js").SearchOptions | undefined;
        if (opts?._trace && query === "traceFollow") {
          // Simulate search writing vector_ms to trace
          opts._trace.vector_ms = (opts._trace.vector_ms ?? 0) + 42;
        }
        return searchResponses.get(query) ?? [];
      },
    } as unknown as HybridSearch;

    const llm = createMockLLM([
      '{"reasoning":"不够","sufficient":false,"follow_up_queries":[{"query":"traceFollow","intent":"扩展"}]}',
      '{"reasoning":"够了","sufficient":true,"follow_up_queries":[]}',
      '{"order": [1, 2]}',
    ]);

    const researcher = new ResearchManager(mockSearch, db, llm);
    const trace: import("../../src/core/search.js").SearchTrace = {};
    await researcher.research("traceRoot", { _trace: trace });

    // Follow-up search wrote vector_ms through the propagated _trace
    expect(trace.vector_ms).toBe(42);
  });
});

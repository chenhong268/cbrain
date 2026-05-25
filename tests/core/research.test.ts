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

  test("stagnant detection: breaks when no new slugs discovered", async () => {
    const searchResponses = new Map<string, SearchResult[]>([
      ["test", [makeResult("entity/a", 0.9)]],
      ["follow1", [makeResult("entity/a", 0.8)]], // same slug, no growth
    ]);

    const llm = createMockLLM([
      '{"reasoning":"需要更多","sufficient":false,"follow_up_queries":[{"query":"follow1","intent":"test"}]}',
      '{"reasoning":"还是不够","sufficient":false,"follow_up_queries":[{"query":"follow2","intent":"test"}]}',
      '{"order": [1]}',
    ]);

    const researcher = new ResearchManager(
      createMockSearch(searchResponses), db, llm,
      { maxIterations: 3 },
    );
    const results = await researcher.research("test");

    // Iteration 1: follow1 returns same slug "entity/a" → no growth → stagnant break
    // Only 1 reasoning call; rerank skipped because only 1 result
    expect(llm.calls.length).toBe(1);
    expect(results.length).toBe(1);
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
});

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";
import type { LLMProvider } from "../../src/llm/provider.js";
import {
  HybridSearch,
  mergeRankedResults,
  type SearchOptions,
  type SearchResult,
} from "../../src/core/retrieval/search.js";
import {
  attachRetrievalSupport,
  getRetrievalSupport,
} from "../../src/core/retrieval/retrieval-support.js";
import { filterContentCandidates } from "../../src/core/retrieval/content-relevance.js";

interface LanceCall {
  readonly queryVector: number[];
  readonly limit: number;
  readonly options?: { includeVector?: boolean };
}

interface LanceRow {
  pageSlug: string;
  chunkIndex: number;
  content: string;
  _distance?: number;
  vector?: ArrayLike<number>;
}

function insertPage(db: CBrainDB, slug: string, title: string): void {
  db.rawDb.prepare(
    "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)",
  ).run(slug, "note", title, `${slug}.md`, `hash-${slug}`);
}

function embeddingProvider(
  onEmbed?: (text: string) => number[],
): EmbeddingProvider {
  return {
    dimensions: 2,
    embed: async (text) => ({
      embedding: onEmbed?.(text) ?? [1, 0],
      tokenCount: text.length,
    }),
    embedBatch: async (texts) => texts.map((text) => ({
      embedding: onEmbed?.(text) ?? [1, 0],
      tokenCount: text.length,
    })),
  };
}

function lanceStub(
  calls: LanceCall[],
  rows: LanceRow[] | ((vector: number[]) => LanceRow[]),
): object {
  return {
    search: async (
      queryVector: number[] | Float32Array,
      limit: number,
      options?: { includeVector?: boolean },
    ) => {
      const vector = Array.from(queryVector);
      calls.push({ queryVector: vector, limit, options });
      const selected = typeof rows === "function" ? rows(vector) : rows;
      return selected.map((row) => {
        if (options?.includeVector) return { ...row };
        const { vector: _vector, ...withoutVector } = row;
        return withoutVector;
      });
    },
  };
}

function captureOptions(overrides: SearchOptions = {}): SearchOptions {
  return {
    _captureSupport: true,
    _skipDetailEnrich: true,
    ...overrides,
  };
}

describe("HybridSearch retrieval support", () => {
  const testDir = "/tmp/cbrain-test-search-support";
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

  test("non-capturing searches reuse one frozen context through expansion", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../src/core/retrieval/search.ts"),
      "utf8",
    );

    expect(source).toContain(
      "const NO_SUPPORT_CONTEXT: SearchSupportContext = Object.freeze({",
    );
    expect(source).toContain(
      "if (options?._captureSupport !== true) return NO_SUPPORT_CONTEXT;",
    );
    expect(source).toContain(
      "i === 0 || !support.capture\n          ? support",
    );
    expect(source).toContain(
      "vectorOverride: undefined,",
    );
    expect(source).toContain(
      "const bySlug = new Map<string, { content: string; score: number }>();",
    );
    expect(source).toContain(
      "const supportBySlug = includeVector\n      ? new Map<string, RetrievalChannelEvidence>()\n      : undefined;",
    );
  });

  test("default vector search neither requests stored vectors nor attaches support", async () => {
    const calls: LanceCall[] = [];
    const search = new HybridSearch(
      db,
      embeddingProvider(),
      lanceStub(calls, [{
        pageSlug: "note/a",
        chunkIndex: 0,
        content: "匿名内容",
        _distance: 0.1,
        vector: [1, 0],
      }]) as never,
      { multiQuery: false },
    );

    const [result] = await search.search("匿名查询", {
      strategy: "vector",
      _skipDetailEnrich: true,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.options?.includeVector).not.toBe(true);
    expect(getRetrievalSupport(result!)).toBe(getRetrievalSupport({} as SearchResult));
    expect(Reflect.ownKeys(result!)).toEqual(["slug", "score", "snippet", "source"]);
  });

  test("opted-in exact search attaches original exact support", async () => {
    insertPage(db, "note/exact", "主题甲乙");
    const search = new HybridSearch(
      db,
      embeddingProvider(),
      lanceStub([], []) as never,
      { multiQuery: false },
    );

    const [result] = await search.search("主题甲乙", captureOptions());

    expect(result?.source).toBe("exact");
    expect(getRetrievalSupport(result!)).toEqual({
      exact: { original: { rankScore: 1, rootLexicalCoverage: 1 } },
    });
  });

  test("a derived exact fast path stays derived and is measured against the root query", async () => {
    insertPage(db, "note/child", "子主题");
    const search = new HybridSearch(
      db,
      embeddingProvider(),
      lanceStub([], []) as never,
      { multiQuery: false },
    );

    const [result] = await search.search("子主题", captureOptions({
      _supportRootQuery: "完全不同的根问题",
      _supportOrigin: "derived",
    }));

    expect(result?.source).toBe("exact");
    expect(getRetrievalSupport(result!).exact?.original).toBeUndefined();
    expect(getRetrievalSupport(result!).exact?.derived).toEqual({
      rankScore: 1,
      rootLexicalCoverage: 0,
    });
  });

  test("opted-in FTS computes support from full content before the 200-char snippet", async () => {
    const query = "主题甲乙丙丁戊";
    const lateContent = `${"填".repeat(240)} ${query}`;
    spyOn(db, "ftsSearch").mockReturnValue([{
      page_slug: "note/late",
      content: lateContent,
      rank: -8,
    }]);
    const search = new HybridSearch(
      db,
      embeddingProvider(),
      lanceStub([], []) as never,
      { multiQuery: false },
    );

    const [result] = await search.search(query, captureOptions({ strategy: "fts" }));

    expect(result?.snippet).toHaveLength(200);
    expect(result?.snippet).not.toContain(query);
    expect(getRetrievalSupport(result!).fts?.original).toEqual({
      rankScore: 8,
      rootLexicalCoverage: 1,
    });
  });

  test("temporal uses root lexical coverage and graph remains rank-only", async () => {
    const query = "主题甲乙丙丁戊";
    spyOn(db, "searchTimeline").mockReturnValue([{
      page_slug: "note/timeline",
      event_date: "2026-01-01",
      summary: `更新 ${query}`,
      source: "synthetic",
    }]);
    const temporalSearch = new HybridSearch(
      db,
      embeddingProvider(),
      lanceStub([], []) as never,
      { multiQuery: false },
    );

    const [temporal] = await temporalSearch.search(query, captureOptions({ multiQuery: false }));
    expect(getRetrievalSupport(temporal!).temporal?.original).toEqual({
      rankScore: 0.5,
      rootLexicalCoverage: 1,
    });

    insertPage(db, "entity/a", "实体A");
    insertPage(db, "entity/b", "实体B");
    db.rawDb.prepare(
      "INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)",
    ).run("entity/a", "entity/b", "related_to");
    const graphSearch = new HybridSearch(
      db,
      embeddingProvider(),
      lanceStub([], []) as never,
      { multiQuery: false },
    );

    const [graph] = await graphSearch.search("entity/a", captureOptions({ strategy: "graph" }));
    expect(getRetrievalSupport(graph!).graph?.original).toEqual({ rankScore: 1 });
  });

  test("original vector selects stored vector once, stores cosine, and drops raw vector", async () => {
    const calls: LanceCall[] = [];
    const search = new HybridSearch(
      db,
      embeddingProvider(),
      lanceStub(calls, [{
        pageSlug: "note/vector",
        chunkIndex: 0,
        content: "无词面重叠",
        _distance: 0.25,
        vector: Float32Array.from([2, 0]),
      }]) as never,
      { multiQuery: false },
    );

    const [result] = await search.search("抽象查询", captureOptions({ strategy: "vector" }));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.options).toEqual({ includeVector: true });
    expect(getRetrievalSupport(result!).vector?.original).toEqual({
      rankScore: 0.75,
      vectorCosineSimilarity: 1,
    });
    expect("vector" in (result as object)).toBe(false);
    expect(JSON.stringify(result)).not.toContain("vectorCosineSimilarity");
  });

  test("vector support keeps the strongest valid raw row while legacy display keeps summary", async () => {
    const calls: LanceCall[] = [];
    const unitVector = (cosine: number): number[] => [
      cosine,
      Math.sqrt(1 - cosine * cosine),
    ];
    const search = new HybridSearch(
      db,
      embeddingProvider(),
      lanceStub(calls, [
        {
          pageSlug: "note/mixed",
          chunkIndex: 0,
          content: "畸形高排名 raw",
          _distance: 0.05,
          vector: [Number.NaN, 0],
        },
        {
          pageSlug: "note/mixed",
          chunkIndex: 1,
          content: "首个强 raw",
          _distance: 0.3,
          vector: unitVector(0.85),
        },
        {
          pageSlug: "note/mixed",
          chunkIndex: 2,
          content: "同 cosine 更高 native rank raw",
          _distance: 0.25,
          vector: unitVector(0.85),
        },
        {
          pageSlug: "note/mixed",
          chunkIndex: -1,
          content: "弱 summary",
          _distance: 0.42,
          vector: unitVector(0.79),
        },
      ]) as never,
      { multiQuery: false },
    );

    const [result] = await search.search("抽象查询", captureOptions({ strategy: "vector" }));

    expect(result).toEqual({
      slug: "note/mixed",
      score: 0.5800000000000001,
      snippet: "弱 summary",
      source: "vector",
    });
    const evidence = getRetrievalSupport(result!).vector?.original;
    expect(evidence?.vectorCosineSimilarity).toBeCloseTo(0.85, 12);
    expect(evidence?.rankScore).toBe(0.75);
  });

  test("malformed candidate vectors retain rank-only original support", async () => {
    const calls: LanceCall[] = [];
    const rows: LanceRow[] = [
      { pageSlug: "note/missing", chunkIndex: 0, content: "a", _distance: 0.1 },
      { pageSlug: "note/zero", chunkIndex: 0, content: "b", _distance: 0.2, vector: [0, 0] },
      { pageSlug: "note/shape", chunkIndex: 0, content: "c", _distance: 0.3, vector: [1] },
      { pageSlug: "note/nonfinite", chunkIndex: 0, content: "d", _distance: 0.4, vector: [1, Number.NaN] },
    ];
    const search = new HybridSearch(
      db,
      embeddingProvider(),
      lanceStub(calls, rows) as never,
      { multiQuery: false },
    );

    const results = await search.search("抽象查询", captureOptions({ strategy: "vector", limit: 4 }));

    expect(results).toHaveLength(4);
    for (const result of results) {
      expect(getRetrievalSupport(result).vector?.original?.rankScore).toBeFinite();
      expect(getRetrievalSupport(result).vector?.original).not.toHaveProperty("vectorCosineSimilarity");
    }
  });

  test("derived vector omits candidate vectors and records derived rank only", async () => {
    const calls: LanceCall[] = [];
    const search = new HybridSearch(
      db,
      embeddingProvider(),
      lanceStub(calls, [{
        pageSlug: "note/derived",
        chunkIndex: 0,
        content: "派生内容",
        _distance: 0.2,
        vector: [1, 0],
      }]) as never,
      { multiQuery: false },
    );

    const [result] = await search.search("派生查询", captureOptions({
      strategy: "vector",
      _supportRootQuery: "根查询",
      _supportOrigin: "derived",
    }));

    expect(calls[0]?.options?.includeVector).not.toBe(true);
    expect(getRetrievalSupport(result!).vector).toEqual({
      derived: { rankScore: 0.8 },
    });
  });

  test("hoisted FTS is reused once and keeps caller origin", async () => {
    const query = "主题甲乙丙丁戊";
    const ftsSpy = spyOn(db, "ftsSearch").mockReturnValue([{
      page_slug: "note/fts",
      content: query,
      rank: -4,
    }]);
    const search = new HybridSearch(
      db,
      embeddingProvider(),
      lanceStub([], []) as never,
      { multiQuery: false },
    );

    const [result] = await search.search(query, captureOptions({ multiQuery: false }));

    expect(ftsSpy).toHaveBeenCalledTimes(1);
    expect(getRetrievalSupport(result!).fts?.original?.rootLexicalCoverage).toBe(1);
  });

  test("default expansion variants neither request stored vectors nor attach support", async () => {
    const calls: LanceCall[] = [];
    const vectorByQuery = new Map<string, number[]>([
      ["根查询", [1, 0]],
      ["派生一", [0, 1]],
      ["派生二", [-1, 0]],
    ]);
    const llm: LLMProvider = {
      name: "synthetic",
      chat: async () => '["派生一","派生二"]',
    };
    const search = new HybridSearch(
      db,
      embeddingProvider((text) => vectorByQuery.get(text) ?? [0, 0]),
      lanceStub(calls, (vector) => [{
        pageSlug: vector[0] === 1 ? "note/root" : vector[1] === 1 ? "note/one" : "note/two",
        chunkIndex: 0,
        content: "合成内容",
        _distance: 0.1,
        vector,
      }]) as never,
      { multiQuery: true, llm },
    );

    const results = await search.search("根查询", { _skipDetailEnrich: true });

    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.options?.includeVector !== true)).toBe(true);
    for (const result of results) {
      expect(getRetrievalSupport(result)).toBe(getRetrievalSupport({} as SearchResult));
    }
  });

  test("expansion index zero keeps caller origin while generated variants are derived", async () => {
    const calls: LanceCall[] = [];
    const vectorByQuery = new Map<string, number[]>([
      ["根查询", [1, 0]],
      ["派生一", [0, 1]],
      ["派生二", [-1, 0]],
    ]);
    const llm: LLMProvider = {
      name: "synthetic",
      chat: async () => '["派生一","派生二"]',
    };
    const search = new HybridSearch(
      db,
      embeddingProvider((text) => vectorByQuery.get(text) ?? [0, 0]),
      lanceStub(calls, (vector) => [{
        pageSlug: vector[0] === 1 ? "note/root" : vector[1] === 1 ? "note/one" : "note/two",
        chunkIndex: 0,
        content: "合成内容",
        _distance: 0.1,
        vector,
      }]) as never,
      { multiQuery: true, llm },
    );

    const results = await search.search("根查询", captureOptions());
    const root = results.find((result) => result.slug === "note/root");
    const one = results.find((result) => result.slug === "note/one");
    const two = results.find((result) => result.slug === "note/two");

    expect(calls.map((call) => call.options?.includeVector === true)).toEqual([true, false, false]);
    expect(getRetrievalSupport(root!).vector?.original?.vectorCosineSimilarity).toBe(1);
    expect(getRetrievalSupport(one!).vector).toEqual({ derived: { rankScore: 0.9 } });
    expect(getRetrievalSupport(two!).vector).toEqual({ derived: { rankScore: 0.9 } });
  });

  test("a derived expansion never promotes its first variant to original", async () => {
    const calls: LanceCall[] = [];
    const llm: LLMProvider = {
      name: "synthetic",
      chat: async () => '["派生二"]',
    };
    const search = new HybridSearch(
      db,
      embeddingProvider((text) => text === "派生一" ? [1, 0] : [0, 1]),
      lanceStub(calls, (vector) => [{
        pageSlug: vector[0] === 1 ? "note/one" : "note/two",
        chunkIndex: 0,
        content: "合成内容",
        _distance: 0.1,
        vector,
      }]) as never,
      { multiQuery: true, llm },
    );

    const results = await search.search("派生一", captureOptions({
      _supportRootQuery: "根查询",
      _supportOrigin: "derived",
    }));

    expect(calls.every((call) => call.options?.includeVector !== true)).toBe(true);
    for (const result of results) {
      expect(getRetrievalSupport(result).vector?.original).toBeUndefined();
      expect(getRetrievalSupport(result).vector?.derived?.rankScore).toBe(0.9);
    }
  });

  test("captured decomposition keeps every derived child just like default", async () => {
    const root = "主题甲和主题乙如何比较";
    const llm: LLMProvider = {
      name: "synthetic",
      chat: async () => JSON.stringify({
        sub_queries: [
          { sub_query: "子查询甲", intent: "synthetic" },
          { sub_query: "子查询乙", intent: "synthetic" },
        ],
      }),
    };
    spyOn(db, "ftsSearch").mockImplementation((query) => query === root ? [] : [{
      page_slug: query === "子查询甲" ? "note/a" : "note/b",
      chunk_index: 0,
      content: root,
      rank: -6,
    }]);
    const search = new HybridSearch(
      db,
      embeddingProvider(),
      lanceStub([], []) as never,
      { multiQuery: false, llm },
    );

    const defaultResults = await search.search(root, { _skipDetailEnrich: true });
    expect(defaultResults.map((result) => result.slug).sort()).toEqual(["note/a", "note/b"]);
    for (const result of defaultResults) {
      expect(getRetrievalSupport(result)).toBe(getRetrievalSupport({} as SearchResult));
    }

    const results = await search.search(root, captureOptions());

    expect(results.map((result) => result.slug).sort()).toEqual(["note/a", "note/b"]);
    for (const result of results) {
      const support = getRetrievalSupport(result);
      expect(support.fts?.original).toBeUndefined();
      expect(support.fts?.derived?.rootLexicalCoverage).toBe(1);
    }
  });

  test("captured decomposition uses the original query in one child vector slot", async () => {
    const root = "主题甲和主题乙如何比较";
    const vectors = new Map<string, number[]>([
      [root, [1, 0]],
      ["子查询甲", [0, 1]],
      ["子查询乙", [-1, 0]],
    ]);
    const calls: LanceCall[] = [];
    const llm: LLMProvider = {
      name: "synthetic",
      chat: async () => JSON.stringify({
        sub_queries: [
          { sub_query: "子查询甲", intent: "synthetic" },
          { sub_query: "子查询乙", intent: "synthetic" },
        ],
      }),
    };
    spyOn(db, "ftsSearch").mockReturnValue([]);
    const search = new HybridSearch(
      db,
      embeddingProvider((text) => vectors.get(text) ?? [0, 0]),
      lanceStub(calls, (vector) => [{
        pageSlug: vector[0] === 1 ? "note/root" : "note/derived",
        chunkIndex: 0,
        content: "与根查询没有词面重叠的匿名内容",
        _distance: 0.1,
        vector,
      }]) as never,
      { multiQuery: false, llm },
    );

    const results = await search.search(root, captureOptions());
    const accepted = filterContentCandidates(root, results);
    const rootResult = results.find((result) => result.slug === "note/root");

    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.options?.includeVector === true)).toEqual([true, false]);
    expect(getRetrievalSupport(rootResult!).vector?.original?.vectorCosineSimilarity).toBe(1);
    expect(accepted.map((result) => result.slug)).toEqual(["note/root"]);
  });

  test("captured decomposition fails open when only the original vector slot fails", async () => {
    const root = "主题甲和主题乙如何比较";
    const vectors = new Map<string, number[]>([
      [root, [1, 0]],
      ["子查询甲", [0, 1]],
      ["子查询乙", [-1, 0]],
    ]);
    const calls: LanceCall[] = [];
    const llm: LLMProvider = {
      name: "synthetic",
      chat: async () => JSON.stringify({
        sub_queries: [
          { sub_query: "子查询甲", intent: "synthetic" },
          { sub_query: "子查询乙", intent: "synthetic" },
        ],
      }),
    };
    spyOn(db, "ftsSearch").mockImplementation((query) => query === root ? [] : [{
      page_slug: "note/derived",
      chunk_index: 0,
      content: root,
      rank: -6,
    }]);
    spyOn(db, "getActivityWeights").mockImplementation((slugs) => {
      if (slugs.includes("note/root")) throw new Error("root-weight-sentinel");
      return new Map();
    });
    const search = new HybridSearch(
      db,
      embeddingProvider((text) => vectors.get(text) ?? [0, 0]),
      lanceStub(calls, (vector) => vector[0] === 1 ? [{
        pageSlug: "note/root",
        chunkIndex: 0,
        content: "匿名根向量内容",
        _distance: 0.1,
        vector,
      }] : []) as never,
      { multiQuery: false, llm },
    );

    const results = await search.search(root, captureOptions());

    expect(calls).toHaveLength(2);
    expect(results.map((result) => result.slug)).toEqual(["note/derived"]);
    expect(filterContentCandidates(root, results).map((result) => result.slug)).toEqual([
      "note/derived",
    ]);
  });

  test("an exact first child stays zero-vector while the next ordinary child lends its existing slot", async () => {
    const root = "主题甲和主题乙如何比较";
    insertPage(db, "note/exact-child", "子查询甲");
    const vectors = new Map<string, number[]>([
      [root, [1, 0]],
      ["子查询乙", [0, 1]],
    ]);
    const calls: LanceCall[] = [];
    const llm: LLMProvider = {
      name: "synthetic",
      chat: async () => JSON.stringify({
        sub_queries: [
          { sub_query: "子查询甲", intent: "synthetic" },
          { sub_query: "子查询乙", intent: "synthetic" },
        ],
      }),
    };
    spyOn(db, "ftsSearch").mockImplementation((query) => query === "子查询乙" ? [{
      page_slug: "note/derived-child",
      chunk_index: 0,
      content: root,
      rank: -6,
    }] : []);
    const search = new HybridSearch(
      db,
      embeddingProvider((text) => vectors.get(text) ?? [0, 0]),
      lanceStub(calls, (vector) => vector[0] === 1 ? [{
        pageSlug: "note/root-vector",
        chunkIndex: 0,
        content: "匿名根向量内容",
        _distance: 0.1,
        vector,
      }] : []) as never,
      { multiQuery: false, llm },
    );

    const results = await search.search(root, captureOptions());

    expect(calls).toHaveLength(1);
    expect(calls.map((call) => call.options?.includeVector === true)).toEqual([true]);
    expect(results.map((result) => result.slug).sort()).toEqual([
      "note/derived-child",
      "note/exact-child",
      "note/root-vector",
    ]);
    expect(getRetrievalSupport(
      results.find((result) => result.slug === "note/exact-child")!,
    ).exact?.derived).toBeDefined();
    expect(getRetrievalSupport(
      results.find((result) => result.slug === "note/root-vector")!,
    ).vector?.original?.vectorCosineSimilarity).toBe(1);
  });

  test("all-exact decomposition children add no embedding or Lance call", async () => {
    const root = "主题甲和主题乙如何比较";
    insertPage(db, "note/exact-a", "子查询甲");
    insertPage(db, "note/exact-b", "子查询乙");
    let embeddingCalls = 0;
    const calls: LanceCall[] = [];
    const llm: LLMProvider = {
      name: "synthetic",
      chat: async () => JSON.stringify({
        sub_queries: [
          { sub_query: "子查询甲", intent: "synthetic" },
          { sub_query: "子查询乙", intent: "synthetic" },
        ],
      }),
    };
    const search = new HybridSearch(
      db,
      embeddingProvider(() => {
        embeddingCalls += 1;
        return [1, 0];
      }),
      lanceStub(calls, () => []) as never,
      { multiQuery: false, llm },
    );

    const results = await search.search(root, captureOptions());

    expect(embeddingCalls).toBe(0);
    expect(calls).toHaveLength(0);
    expect(results.map((result) => result.slug).sort()).toEqual([
      "note/exact-a",
      "note/exact-b",
    ]);
  });
});

describe("mergeRankedResults support propagation", () => {
  test("default fusion ignores attached support while explicit capture propagates it", () => {
    const supported = attachRetrievalSupport(
      { slug: "note/a", score: 0.7, snippet: "vector", source: "vector" },
      { vector: { original: { rankScore: 0.7, vectorCosineSimilarity: 0.9 } } },
    );

    const [defaultResult] = mergeRankedResults([[supported]], 60, 10);
    const [capturedResult] = mergeRankedResults(
      [[supported]],
      60,
      10,
      undefined,
      undefined,
      true,
    );

    expect(defaultResult).toEqual({
      slug: "note/a",
      score: 1 / 61,
      snippet: "vector",
      source: "hybrid",
    });
    expect(getRetrievalSupport(defaultResult!)).toBe(getRetrievalSupport({} as SearchResult));
    expect(getRetrievalSupport(capturedResult!)).toEqual({
      vector: { original: { rankScore: 0.7, vectorCosineSimilarity: 0.9 } },
    });
  });

  test("flattens all channels, separates origins, and keeps channel-native strongest evidence", () => {
    const vectorOriginal = attachRetrievalSupport(
      { slug: "note/a", score: 0.7, snippet: "vector", source: "vector" },
      {
        exact: {
          original: { rankScore: 1, rootLexicalCoverage: 1 },
          derived: { rankScore: 0.8, rootLexicalCoverage: 0.7 },
        },
        vector: {
          original: { rankScore: 0.7, vectorCosineSimilarity: 0.85 },
          derived: { rankScore: 0.4 },
        },
        graph: {
          original: { rankScore: 0.5 },
          derived: { rankScore: 0.8 },
        },
      },
    );
    const vectorStronger = attachRetrievalSupport(
      { slug: "note/a", score: 0.6, snippet: "derived", source: "vector" },
      {
        exact: {
          original: { rankScore: 2, rootLexicalCoverage: 0.8 },
          derived: { rankScore: 0.2, rootLexicalCoverage: 0.9 },
        },
        vector: {
          original: { rankScore: 0.6, vectorCosineSimilarity: 0.9 },
          derived: { rankScore: 0.95 },
        },
        graph: {
          original: { rankScore: 0.9 },
          derived: { rankScore: 0.3 },
        },
      },
    );
    const lexical = attachRetrievalSupport(
      { slug: "note/a", score: 8, snippet: "fts", source: "fts" },
      {
        fts: {
          original: { rankScore: 9, rootLexicalCoverage: 0.7 },
          derived: { rankScore: 7, rootLexicalCoverage: 0.6 },
        },
        temporal: {
          original: { rankScore: 9, rootLexicalCoverage: 0.6 },
          derived: { rankScore: 7, rootLexicalCoverage: 0.5 },
        },
      },
    );
    const lexicalStronger = attachRetrievalSupport(
      { slug: "note/a", score: 0.2, snippet: "lexical", source: "temporal" },
      {
        fts: {
          original: { rankScore: 0.2, rootLexicalCoverage: 0.9 },
          derived: { rankScore: 0.4, rootLexicalCoverage: 0.8 },
        },
        temporal: {
          original: { rankScore: 0.1, rootLexicalCoverage: 0.9 },
          derived: { rankScore: 0.2, rootLexicalCoverage: 0.8 },
        },
      },
    );
    const nested = mergeRankedResults(
      [[vectorOriginal], [lexical]],
      60,
      10,
      undefined,
      undefined,
      true,
    );
    const [result] = mergeRankedResults(
      [nested, [vectorStronger], [lexicalStronger]],
      60,
      10,
      undefined,
      undefined,
      true,
    );

    expect(getRetrievalSupport(result!)).toEqual({
      exact: {
        original: { rankScore: 1, rootLexicalCoverage: 1 },
        derived: { rankScore: 0.2, rootLexicalCoverage: 0.9 },
      },
      vector: {
        original: { rankScore: 0.6, vectorCosineSimilarity: 0.9 },
        derived: { rankScore: 0.95 },
      },
      fts: {
        original: { rankScore: 0.2, rootLexicalCoverage: 0.9 },
        derived: { rankScore: 0.4, rootLexicalCoverage: 0.8 },
      },
      graph: {
        original: { rankScore: 0.9 },
        derived: { rankScore: 0.8 },
      },
      temporal: {
        original: { rankScore: 0.1, rootLexicalCoverage: 0.9 },
        derived: { rankScore: 0.2, rootLexicalCoverage: 0.8 },
      },
    });
    const support = getRetrievalSupport(result!);
    expect(Object.isFrozen(support)).toBe(true);
    expect(Object.isFrozen(support.vector)).toBe(true);
    expect(Object.isFrozen(support.vector?.original)).toBe(true);
  });

  test("opaque hybrid remains unsupported and fusion scoring snapshots stay unchanged", () => {
    const opaque: SearchResult = {
      slug: "note/a",
      score: 99,
      snippet: "opaque",
      source: "hybrid",
    };
    const other: SearchResult = {
      slug: "note/b",
      score: 0.5,
      snippet: "other",
      source: "fts",
    };

    const results = mergeRankedResults(
      [[opaque, other]],
      60,
      2,
      new Map([["note/a", 1]]),
      new Map([["note/a", 0.5]]),
      true,
    );

    expect(results).toEqual([
      {
        slug: "note/a",
        score: 1 / 61 + 0.15 + 0.06,
        snippet: "opaque",
        source: "hybrid",
      },
      {
        slug: "note/b",
        score: 1 / 62,
        snippet: "other",
        source: "hybrid",
      },
    ]);
    expect(getRetrievalSupport(results[0]!)).toBe(getRetrievalSupport(opaque));
  });
});

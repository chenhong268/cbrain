import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HybridSearch, type SearchResult } from "../../src/core/search.js";
import { CBrainDB } from "../../src/storage/sqlite.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";
import type { LLMProvider } from "../../src/llm/provider.js";

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
    embed: async (text: string) => ({ embedding: fakeVec(text), tokenCount: text.length }),
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

function createMockLLM(responses: string[]): LLMProvider {
  let callIndex = 0;
  return {
    name: "mock",
    chat: async () => responses[callIndex++] ?? '{"sufficient": true, "reason": "default"}',
  };
}

function insertPage(db: CBrainDB, slug: string, title: string, type: string, mentionCount = 0) {
  db.rawDb
    .prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(slug, type, title, `${slug}.md`, `h-${slug}`, mentionCount);
}

describe("HybridSearch escalation budget (#222)", () => {
  const testDir = "/tmp/cbrain-test-escalation-budget";
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

  test("complex + LLM + default does NOT invoke searchMultiStep (multiStep gate)", async () => {
    insertPage(db, "entity/a", "Entity A", "entity/person");
    insertPage(db, "entity/b", "Entity B", "entity/person");
    const hs = new HybridSearch(db, createMockEmbeddingProvider(), createMockLance() as any, {
      rrf_k: 60,
      llm: createMockLLM(["[]"]),
    });
    // mockImplementation 避免 searchMultiStep 实际跑 ResearchManager；只观察是否被调用
    const spy = spyOn(hs as any, "searchMultiStep").mockImplementation(async () => [] as any);
    await hs.search("Entity A 和 Entity B", {
      _hints: { isComplex: true, knownSlugs: [] },
    });
    expect(spy).not.toHaveBeenCalled();
  });

  test("complex + multiStep=true DOES invoke searchMultiStep", async () => {
    insertPage(db, "entity/a", "Entity A", "entity/person");
    const hs = new HybridSearch(db, createMockEmbeddingProvider(), createMockLance() as any, {
      rrf_k: 60,
      llm: createMockLLM(["[]"]),
    });
    const spy = spyOn(hs as any, "searchMultiStep").mockImplementation(async () => [] as any);
    await hs.search("Entity A 和 Entity B", {
      multiStep: true,
      _hints: { isComplex: true, knownSlugs: [] },
    });
    expect(spy).toHaveBeenCalled();
  });

  test("decomposition caps subqueries to MAX_DEFAULT_SUBQUERIES (3)", async () => {
    insertPage(db, "entity/a", "Entity A", "entity/person");
    const hs = new HybridSearch(db, createMockEmbeddingProvider(), createMockLance() as any, {
      rrf_k: 60,
      llm: createMockLLM(["[]"]),
    });
    // mock decomposeQuery 返回 6 个 sub-query（超过 budget），mock expandQuery 避免 LLM
    spyOn(hs as any, "decomposeQuery").mockImplementation(async () => ["sq1", "sq2", "sq3", "sq4", "sq5", "sq6"]);
    spyOn(hs as any, "expandQuery").mockImplementation(async () => [] as string[]);
    const searchSpy = spyOn(hs as any, "search");
    await hs.search("Entity A 和 Entity B 和 Entity C", {
      _hints: { isComplex: true, knownSlugs: [] },
    });
    const subQueryCalls = (searchSpy.mock.calls as unknown as unknown[][]).filter((args) => (args[1] as { _skipDecompose?: boolean })?._skipDecompose);
    expect(subQueryCalls.length).toBeLessThanOrEqual(3);
  });

  test("sub-query search passes multiQuery:false (no second expand)", async () => {
    insertPage(db, "entity/a", "Entity A", "entity/person");
    const hs = new HybridSearch(db, createMockEmbeddingProvider(), createMockLance() as any, {
      rrf_k: 60,
      llm: createMockLLM(["[]"]),
    });
    spyOn(hs as any, "decomposeQuery").mockImplementation(async () => ["sq1", "sq2"]);
    spyOn(hs as any, "expandQuery").mockImplementation(async () => [] as string[]);
    const searchSpy = spyOn(hs as any, "search");
    await hs.search("Entity A 和 Entity B", {
      _hints: { isComplex: true, knownSlugs: [] },
    });
    const subQueryCalls = (searchSpy.mock.calls as unknown as unknown[][]).filter((args) => (args[1] as { _skipDecompose?: boolean })?._skipDecompose);
    expect(subQueryCalls.length).toBeGreaterThan(0);
    for (const args of subQueryCalls) {
      expect((args[1] as { multiQuery?: boolean } | undefined)?.multiQuery).toBe(false);
    }
  });

  test("budget exceeded returns deterministic results + degraded trace, no throw", async () => {
    insertPage(db, "entity/a", "Entity A", "entity/person");
    const hs = new HybridSearch(db, createMockEmbeddingProvider(), createMockLance() as any, {
      rrf_k: 60,
      llm: createMockLLM([JSON.stringify(["sq1", "sq2"])]),
    });
    // LLM budget 预先耗尽（trace.llm_calls >= MAX_DEFAULT_LLM_CALLS=3）→ budget guard 走 degraded
    const trace: { llm_calls?: number; degraded_reason?: string } = { llm_calls: 3 };
    const result = await hs.search("Entity A 和 Entity B", {
      _hints: { isComplex: true, knownSlugs: [] },
      _trace: trace as any,
    });
    expect(Array.isArray(result)).toBe(true); // 不抛，返回确定性结果
    expect(trace.degraded_reason).toBe("decompose_budget_exceeded");
  });

  test("degraded fallback triggers zero additional LLM/embedding calls", async () => {
    insertPage(db, "entity/a", "Entity A", "entity/person");
    const embedProvider = createMockEmbeddingProvider();
    const embedSpy = spyOn(embedProvider, "embed");
    const hs = new HybridSearch(db, embedProvider, createMockLance() as any, {
      rrf_k: 60,
      llm: createMockLLM([JSON.stringify(["sq1", "sq2"])]),
    });
    const expandSpy = spyOn(hs as any, "expandQuery");
    // LLM budget 预先耗尽 → budget guard 命中 → degraded 返回 []
    const trace: { llm_calls?: number; degraded_reason?: string } = { llm_calls: 3 };
    await hs.search("Entity A 和 Entity B", {
      _hints: { isComplex: true, knownSlugs: [] },
      _trace: trace as any,
    });
    expect(trace.degraded_reason).toBe("decompose_budget_exceeded");
    expect(embedSpy).not.toHaveBeenCalled(); // degraded 不触发 embedding（vector）
    expect(expandSpy).not.toHaveBeenCalled(); // degraded 不触发 expandQuery
  });

  test("complex default decompose (success path) does not fallback to expandQuery", async () => {
    insertPage(db, "entity/a", "Entity A", "entity/person");
    const hs = new HybridSearch(db, createMockEmbeddingProvider(), createMockLance() as any, {
      rrf_k: 60,
      llm: createMockLLM(["[]"]),
    });
    spyOn(hs as any, "decomposeQuery").mockImplementation(async () => ["sq1", "sq2"]);
    const expandSpy = spyOn(hs as any, "expandQuery");
    await hs.search("Entity A 和 Entity B", {
      _hints: { isComplex: true, knownSlugs: [] },
    });
    // decompose 后（无论 sub-results 是否空）不再 fallback 到默认 expansion
    expect(expandSpy).not.toHaveBeenCalled();
  });

  test("decompose failure/timeout → degraded [], no expansion", async () => {
    insertPage(db, "entity/a", "Entity A", "entity/person");
    const hs = new HybridSearch(db, createMockEmbeddingProvider(), createMockLance() as any, {
      rrf_k: 60,
      llm: createMockLLM(["[]"]),
    });
    // mock decomposeQuery throw（模拟 Promise.race timeout/failure）
    spyOn(hs as any, "decomposeQuery").mockImplementation(async () => {
      throw new Error("decompose_timeout");
    });
    const expandSpy = spyOn(hs as any, "expandQuery");
    const trace: { decompose_ms?: number; degraded_reason?: string } = {};
    const result = await hs.search("Entity A 和 Entity B", {
      _hints: { isComplex: true, knownSlugs: [] },
      _trace: trace as any,
    });
    expect(Array.isArray(result)).toBe(true);
    expect(trace.degraded_reason).toBe("decompose_budget_exceeded");
    expect(expandSpy).not.toHaveBeenCalled(); // 超时/失败不 fallback expansion
  });

  test("complex decompose weak/empty sub-results → bounded fallback (recall preserved, multiQuery:false, no expandQuery)", async () => {
    insertPage(db, "entity/a", "Entity A", "entity/person");
    const hs = new HybridSearch(db, createMockEmbeddingProvider(), createMockLance() as any, {
      rrf_k: 60,
      llm: createMockLLM(["[]"]),
    });
    spyOn(hs as any, "decomposeQuery").mockImplementation(async () => ["sq1", "sq2"]);
    const expandSpy = spyOn(hs as any, "expandQuery");
    // sub-query（sq1/sq2）返回空 → 触发弱/空 fallback；顶层 query 返回结果（召回不丢失）
    const fallbackSpy = spyOn(hs as any, "searchWithExpansion").mockImplementation(async (q: string) => {
      if (q.includes("Entity")) {
        return [{ slug: "entity/a", score: 0.5, snippet: "fallback", source: "fts" as const }];
      }
      return [] as SearchResult[];
    });
    const result = await hs.search("Entity A 和 Entity B", {
      _hints: { isComplex: true, knownSlugs: [] },
    });
    expect(result.length).toBeGreaterThan(0); // 召回不丢失（顶层 fallback 非空）
    expect(expandSpy).not.toHaveBeenCalled(); // multiQuery:false → 不 expandQuery
    // 所有 searchWithExpansion 调用 multiQuery=false（第 3 参数）—— bounded
    expect(fallbackSpy.mock.calls.every((c) => c[2] === false)).toBe(true);
  });
});

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { HybridSearch } from "../../src/core/retrieval/search.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";

function mockEmbed(): EmbeddingProvider {
  return {
    dimensions: 128,
    embed: async (t: string) => ({ embedding: new Array(128).fill(0).map((_, i) => (t.charCodeAt(i % t.length) ?? 0) / 65536), tokenCount: t.length }),
    embedBatch: async (ts: string[]) => ts.map((t) => ({ embedding: new Array(128).fill(0).map((_, i) => (t.charCodeAt(i % t.length) ?? 0) / 65536), tokenCount: t.length })),
  };
}

// HybridSearch.expandQuery is private and internally calls llm.chat — so we spy
// on the method itself (not llm.expandQuery, which HybridSearch never calls).
function spyExpand(s: HybridSearch, impl: () => Promise<string[]>) {
  return spyOn(s as unknown as { expandQuery: (q: string) => Promise<string[]> }, "expandQuery").mockImplementation(impl);
}

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

describe("expandQuery gate (#250)", () => {
  const dir = "/tmp/cbrain-test-latency-gate";
  const dbPath = join(dir, "t.sqlite");
  let db: CBrainDB;

  beforeEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true });
    db = new CBrainDB(dbPath);
  });
  afterEach(() => { db.close(); if (existsSync(dir)) rmSync(dir, { recursive: true }); });

  test("simple query + FTS>=3 → expandQuery NOT called", async () => {
    seedFtsHits(db, 3);
    const llm = { name: "mock", chat: async () => { throw new Error("chat should not be called"); } };
    const search = new HybridSearch(db, mockEmbed(), makeLance(), { llm: llm as never });
    const expandSpy = spyExpand(search, async () => { throw new Error("expandQuery should not be called"); });
    const results = await search.search("唯一标记");
    expect(results.length).toBeGreaterThan(0);
    expect(expandSpy).toHaveBeenCalledTimes(0);
    expandSpy.mockRestore();
  });

  test("simple query + FTS empty → expandQuery IS called", async () => {
    const llm = { name: "mock", chat: async () => "{}" };
    const search = new HybridSearch(db, mockEmbed(), makeLance(), { llm: llm as never });
    const expandSpy = spyExpand(search, async () => ["唯一标记"]);
    await search.search("查无此物的标记zzz");
    expect(expandSpy).toHaveBeenCalledTimes(1);
    expandSpy.mockRestore();
  });

  test("complex query → expandQuery IS called even with FTS>=3", async () => {
    // Seed FTS hits whose content MATCHES the complex query tokens, so the FTS
    // probe genuinely returns >=3 and this exercises the complex-branch of the
    // gate (isComplex wins over ftsSufficient).
    seedFtsHits(db, 3, "主题A 主题B 共同标记内容");
    const llm = { name: "mock", chat: async () => "{}" };
    const search = new HybridSearch(db, mockEmbed(), makeLance(), { llm: llm as never });
    // complex + _skipDecompose: isolate the expandQuery gate. Without
    // _skipDecompose, a complex query enters the decompose branch first and we'd
    // be testing decompose, not the expand gate.
    const expandSpy = spyExpand(search, async () => ["主题A", "主题B"]);
    await search.search("主题A 和 主题B", { _skipDecompose: true });
    expect(expandSpy).toHaveBeenCalledTimes(1);
    expandSpy.mockRestore();
  });

  test("FTS empty + explicit multiQuery:false → expandQuery NOT called (caller opt-out beats gate)", async () => {
    const llm = { name: "mock", chat: async () => "{}" };
    const search = new HybridSearch(db, mockEmbed(), makeLance(), { llm: llm as never });
    // FTS empty (no seed) AND multiQuery:false → must NOT expand, even though FTS
    // is insufficient. Caller opt-out beats the isComplexQuery||FTS<3 gate.
    const expandSpy = spyExpand(search, async () => ["主题A"]);
    await search.search("查无此物zzz", { multiQuery: false });
    expect(expandSpy).toHaveBeenCalledTimes(0);
    expandSpy.mockRestore();
  });

  test("expandQuery over call-count budget → skipped, FTS preserved, expand_skipped=budget_exhausted", async () => {
    // Seed FTS hits matching the complex query tokens so the FTS probe returns
    // >=3. This verifies: when expand is skipped by the budget, the initialFts
    // probe result is REUSED (not lost) — results.length > 0.
    seedFtsHits(db, 3, "主题A 主题B 共同标记内容");
    const llm = { name: "mock", chat: async () => "{}" };
    const search = new HybridSearch(db, mockEmbed(), makeLance(), { llm: llm as never });
    const trace: Record<string, unknown> = { llm_calls: 3 }; // #222 MAX_DEFAULT_LLM_CALLS budget exhausted
    // _skipDecompose isolates the expand path (else complex query hits the
    // decompose budget guard first, returning [] before searchWithExpansion).
    const expandSpy = spyExpand(search, async () => ["x"]);
    const results = await search.search("主题A 和 主题B", { _skipDecompose: true, _trace: trace as never });
    expect(results.length).toBeGreaterThan(0); // FTS results preserved (initialFts reused)
    expect(expandSpy).toHaveBeenCalledTimes(0); // expand skipped due to budget
    expect(trace.expand_skipped).toBe("budget_exhausted");
    expandSpy.mockRestore();
  });
});

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
    // 用 _hints 直接注入 knownSlugs>=2，模拟多实体查询；不 seed chunks_fts → probe < 3。
    const llm = { name: "mock", chat: async () => JSON.stringify({ sub_queries: [{ sub_query: "实体A", intent: "x" }, { sub_query: "实体B", intent: "y" }] }) };
    const search = new HybridSearch(db, mockEmbed(), makeLance(), { llm: llm as never });
    const decomposeSpy = spyDecompose(search, async () => ["实体A", "实体B"]);
    await search.search("实体A 和 实体B 的关系", { _hints: { knownSlugs: ["entity/a", "entity/b"], isComplex: true } });
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

  test("decompose failure/timeout fallback 复用 hoisted ftsProbe (原 query ftsSearch = 1)", async () => {
    // FTS<3 (不 seed) → 进 decompose；decompose throw → catch fallback。
    // fallback 必须复用 hoisted ftsProbe，不能对原 query 再跑一次 ftsSearch。
    const llm = { name: "mock", chat: async () => { throw new Error("decompose boom"); } };
    const search = new HybridSearch(db, mockEmbed(), makeLance(), { llm: llm as never });
    const ftsSpy = spyOn(search as unknown as { ftsSearch: (q: string, l: number, t?: unknown) => unknown[] }, "ftsSearch");
    const decomposeSpy = spyDecompose(search, async () => { throw new Error("decompose fail"); });
    await search.search("主题A 和 主题B");
    const originalCalls = ftsSpy.mock.calls.filter((c) => c[0] === "主题A 和 主题B").length;
    expect(originalCalls).toBe(1);
    ftsSpy.mockRestore();
    decomposeSpy.mockRestore();
  });

  test("decompose weak/empty fallback 复用 hoisted ftsProbe (原 query ftsSearch = 1)", async () => {
    // FTS<3 (不 seed) → 进 decompose；decompose 返回 2 sub-queries 但都无匹配 → weak fallback。
    // fallback 必须复用 hoisted ftsProbe，不能对原 query 再跑一次 ftsSearch。
    const llm = { name: "mock", chat: async () => JSON.stringify({ sub_queries: [{ sub_query: "子查询甲", intent: "x" }, { sub_query: "子查询乙", intent: "y" }] }) };
    const search = new HybridSearch(db, mockEmbed(), makeLance(), { llm: llm as never });
    const ftsSpy = spyOn(search as unknown as { ftsSearch: (q: string, l: number, t?: unknown) => unknown[] }, "ftsSearch");
    const decomposeSpy = spyDecompose(search, async () => ["子查询甲", "子查询乙"]);
    await search.search("主题A 和 主题B");
    const originalCalls = ftsSpy.mock.calls.filter((c) => c[0] === "主题A 和 主题B").length;
    expect(originalCalls).toBe(1);
    ftsSpy.mockRestore();
    decomposeSpy.mockRestore();
  });
});

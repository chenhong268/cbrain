import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
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

// HybridSearch.expandQuery is private and internally calls llm.chat — so we spy
// on the method itself (not llm.expandQuery, which HybridSearch never calls).
function spyExpand(s: HybridSearch, impl: () => Promise<string[]>) {
  return spyOn(s as unknown as { expandQuery: (q: string) => Promise<string[]> }, "expandQuery").mockImplementation(impl);
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

  function makeLance() {
    return { connect: async () => {}, addChunks: async () => {}, search: async () => [], fullTextSearch: async () => [], deleteByPageSlug: async () => {}, deleteRawChunksByPageSlug: async () => {}, close: async () => {}, createFTSIndex: async () => {} } as never;
  }

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
    seedFtsHits(3, "主题A 主题B 共同标记内容");
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
});

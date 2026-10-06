import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { HybridSearch, type SearchTrace } from "../../src/core/retrieval/search.js";
import { InsightManager } from "../../src/core/maintenance/insight.js";
import { ContentPipeline } from "../../src/core/ingestion/pipeline.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";
import type { LanceDBManager } from "../../src/storage/lancedb.js";

// #544 D3: what the layers ABOVE the provider do when encoding fails. These
// tests freeze the externally observable outcome (degrade / reject / tolerate)
// rather than the mechanism, and they disclose pre-existing tolerances that are
// NOT a complete index write. Anonymous fixtures only.

const SLUG = "records/topic-d";
const VEC = [0.1];

interface LanceCounters {
  addChunks: number;
  addInsightVector: number;
}

function createMockLance(counters: LanceCounters): LanceDBManager {
  return {
    connect: async () => {},
    warmup: async () => ({ elapsedMs: 0, tables: [] }),
    search: async () => [],
    addChunks: async () => {
      counters.addChunks++;
    },
    deleteByPageSlug: async () => {},
    deleteRawChunksByPageSlug: async () => {},
    deleteL1VectorByPageSlug: async () => {},
    getIndexedPageSlugs: async () => [],
    getOrCreateTable: async () => ({}) as never,
    searchInsights: async () => [],
    addInsightVector: async () => {
      counters.addInsightVector++;
    },
  } as unknown as LanceDBManager;
}

const throwingEmbedding: EmbeddingProvider = {
  dimensions: 1,
  embed: async () => {
    throw new Error("API unreachable");
  },
  embedBatch: async () => {
    throw new Error("API unreachable");
  },
};

describe("embedding failure contracts above the provider (#544)", () => {
  const testDir = "/tmp/cbrain-test-embedding-degradation";
  const dbPath = join(testDir, "test.sqlite");
  let db: CBrainDB;
  let counters: LanceCounters;
  let lance: LanceDBManager;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(dbPath);
    counters = { addChunks: 0, addInsightVector: 0 };
    lance = createMockLance(counters);

    // One page with FTS content, so a degraded retrieval still answers.
    db.rawDb.prepare(
      `INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash, mention_count, tier)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(SLUG, "record/note", "主题D", "topic-d.md", "hash1", 1, 1);
    db.rawDb.prepare(
      `INSERT OR IGNORE INTO chunks_fts (rowid, page_slug, content) VALUES (?, ?, ?)`,
    ).run(1, SLUG, "匿名页面正文占位符。");
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("retrieval degrades to vector_error instead of failing the query", async () => {
    const search = new HybridSearch(db, throwingEmbedding, lance, { rrf_k: 60 });
    const trace: SearchTrace = {};

    const results = await search.search("匿名查询占位符", { strategy: "all", _trace: trace });

    expect(trace.degraded_reason).toBe("vector_error");
    // Fail-open on purpose: the keyword path still answers.
    expect(results.length).toBeGreaterThan(0);
  });

  test("a caller abort propagates instead of degrading to vector_error", async () => {
    const controller = new AbortController();
    const abortingEmbedding: EmbeddingProvider = {
      dimensions: 1,
      embed: async () => {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      },
      embedBatch: async () => {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      },
    };
    const search = new HybridSearch(db, abortingEmbedding, lance, { rrf_k: 60 });
    const trace: SearchTrace = {};

    await expect(
      search.search("匿名查询占位符", {
        strategy: "all",
        _trace: trace,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    // Cancellation is not a degradation: it must not be recorded as such.
    expect(trace.degraded_reason).not.toBe("vector_error");
  });

  test("a chunk encoding failure rejects before any index write", async () => {
    const pipeline = new ContentPipeline(db, throwingEmbedding, lance, { chunkSize: 512 });

    await expect(pipeline.embed("匿名页面正文占位符。")).rejects.toThrow(/API unreachable/);

    // The write step (writeIndexes → lance.addChunks) is only reachable with
    // embed results, so a failed encode writes nothing and deletes nothing.
    expect(counters.addChunks).toBe(0);
    expect(db.getChunksByPage(SLUG, { summaryLevel: 0 })).toHaveLength(0);
  });

  test("a chunk encoding failure leaves an already-indexed page untouched", async () => {
    db.insertChunk(SLUG, 0, "匿名旧分块占位符。");
    const before = db.getChunksByPage(SLUG, { summaryLevel: 0 }).length;
    const pipeline = new ContentPipeline(db, throwingEmbedding, lance, { chunkSize: 512 });

    await expect(pipeline.embed("匿名页面正文占位符。")).rejects.toThrow(/API unreachable/);

    expect(before).toBe(1);
    expect(db.getChunksByPage(SLUG, { summaryLevel: 0 })).toHaveLength(1);
    expect(counters.addChunks).toBe(0);
  });

  test("insight query keeps its legacy fail-open behaviour (empty result)", async () => {
    const insights = new InsightManager(db, throwingEmbedding, lance);

    await expect(insights.queryInsights("匿名查询占位符")).resolves.toEqual([]);
  });

  test("insight creation keeps the row when encoding fails — without a vector", async () => {
    const insights = new InsightManager(db, throwingEmbedding, lance);

    const row = await insights.createInsight({
      type: "synthesis",
      content: "匿名洞察正文占位符",
      sourceType: "manual",
    });

    // Disclosed: the row is written and returned, but it is not vector
    // searchable. This is the pre-existing tolerance, NOT a complete index
    // write, and #544 does not change it.
    expect(row.id).toBeGreaterThan(0);
    expect(db.getInsight(row.id)).not.toBeNull();
    expect(counters.addInsightVector).toBe(0);
  });

  test("a successful encode still writes exactly one insight vector", async () => {
    // Control for the test above: the counter does move on the happy path, so
    // the zero there is the failure, not a broken harness.
    const okEmbedding: EmbeddingProvider = {
      dimensions: VEC.length,
      embed: async () => ({ embedding: VEC, tokenCount: 1 }),
      embedBatch: async (texts) => texts.map(() => ({ embedding: VEC, tokenCount: 1 })),
    };
    const insights = new InsightManager(db, okEmbedding, lance);

    await insights.createInsight({
      type: "synthesis",
      content: "匿名洞察正文占位符",
      sourceType: "manual",
    });

    expect(counters.addInsightVector).toBe(1);
  });
});

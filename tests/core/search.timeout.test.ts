import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { HybridSearch, type SearchTrace } from "../../src/core/search.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";
import type { LanceDBManager } from "../../src/storage/lancedb.js";

describe("search vector timeout", () => {
  const testDir = "/tmp/cbrain-test-search-timeout";
  const dbPath = join(testDir, "test.sqlite");
  let db: CBrainDB;
  let originalTimeout: number;

  /** LanceDB mock that returns empty results (no connection needed) */
  function createMockLance(): LanceDBManager {
    return {
      connect: async () => {},
      warmup: async () => ({ elapsedMs: 0, tables: [] }),
      search: async () => [],
      addChunks: async () => {},
      deleteByPageSlug: async () => {},
      deleteRawChunksByPageSlug: async () => {},
      getIndexedPageSlugs: async () => [],
      getOrCreateTable: async () => ({} as never),
      searchInsights: async () => [],
    } as unknown as LanceDBManager;
  }

  const VEC = [0.1];

  const fastEmbedding: EmbeddingProvider = {
    embed: async () => ({ embedding: VEC, tokenCount: 1 }),
    embedBatch: async (texts) => texts.map(() => ({ embedding: VEC, tokenCount: 1 })),
    dimensions: 1,
  };

  /** Embedding that takes `delayMs` before returning */
  function createSlowEmbedding(delayMs: number): EmbeddingProvider {
    return {
      embed: async () => {
        await new Promise((r) => setTimeout(r, delayMs));
        return { embedding: VEC, tokenCount: 1 };
      },
      embedBatch: async (texts) => {
        await new Promise((r) => setTimeout(r, delayMs));
        return texts.map(() => ({ embedding: VEC, tokenCount: 1 }));
      },
      dimensions: 1,
    };
  }

  const errorEmbedding: EmbeddingProvider = {
    embed: async () => { throw new Error("API unreachable"); },
    embedBatch: async () => { throw new Error("API unreachable"); },
    dimensions: 1,
  };

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(dbPath);

    // Seed a page with FTS content
    db.rawDb.prepare(
      `INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash, mention_count, tier)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("brain/entities/person/shi-ti-a", "entity/person", "实体A", "shi-ti-a.md", "hash1", 1, 3);
    db.rawDb.prepare(
      `INSERT OR IGNORE INTO chunks_fts (rowid, page_slug, content) VALUES (?, ?, ?)`,
    ).run(1, "brain/entities/person/shi-ti-a", "实体A是产品经理，负责AI产品线");

    // Use short timeout for fast, stable tests
    originalTimeout = HybridSearch.VECTOR_TIMEOUT_MS;
    HybridSearch.VECTOR_TIMEOUT_MS = 50; // 50ms
  });

  afterEach(() => {
    // Restore original timeout
    HybridSearch.VECTOR_TIMEOUT_MS = originalTimeout;
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("vector completes normally — no degradation", async () => {
    const search = new HybridSearch(db, fastEmbedding, createMockLance());
    const trace: SearchTrace = {};

    const results = await search.search("产品经理", { strategy: "all", _trace: trace });

    expect(results.length).toBeGreaterThan(0);
    expect(trace.degraded_reason).toBeUndefined();
  });

  test("vector times out in all/hybrid — returns FTS results with degraded metadata", async () => {
    // Slow embedding (200ms) exceeds test timeout (50ms)
    const search = new HybridSearch(db, createSlowEmbedding(200), createMockLance());
    const trace: SearchTrace = {};

    const results = await search.search("产品经理", { strategy: "all", _trace: trace });

    expect(results.length).toBeGreaterThan(0);
    expect(trace.degraded_reason).toBe("vector_timeout");
  });

  test("vector throws non-timeout error — degraded with error reason", async () => {
    const search = new HybridSearch(db, errorEmbedding, createMockLance());
    const trace: SearchTrace = {};

    const results = await search.search("产品经理", { strategy: "all", _trace: trace });

    expect(results.length).toBeGreaterThan(0);
    expect(trace.degraded_reason).toBe("vector_error");
  });

  test("strategy=vector with slow embedding times out and sets degraded_reason", async () => {
    const search = new HybridSearch(db, createSlowEmbedding(200), createMockLance());
    const trace: SearchTrace = {};

    const results = await search.search("产品经理", { strategy: "vector", _trace: trace });

    // Vector-only returns empty on timeout (no FTS fallback for this strategy)
    expect(results).toEqual([]);
    expect(trace.degraded_reason).toBe("vector_timeout");
  });
});

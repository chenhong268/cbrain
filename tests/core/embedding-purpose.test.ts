import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { HybridSearch } from "../../src/core/retrieval/search.js";
import { InsightManager } from "../../src/core/maintenance/insight.js";
import { ContentPipeline } from "../../src/core/ingestion/pipeline.js";
import type { EmbeddingProvider, EmbeddingRequestOptions } from "../../src/embedding/provider.js";

// #544 acceptance: the two QUERY consumers must pass purpose:"query" and the
// write consumers must not. This test freezes that externally observable
// contract, not the internal shape of any provider.

interface RecordedEmbed {
  text: string;
  purpose: EmbeddingRequestOptions["purpose"];
  batch: boolean;
}

function createRecordingEmbeddingProvider(recorded: RecordedEmbed[]): EmbeddingProvider {
  const vec = (text: string) => {
    const v = new Array(128).fill(0);
    for (let i = 0; i < text.length; i++) v[i % 128] += text.charCodeAt(i) / 65536;
    return v;
  };
  return {
    dimensions: 128,
    embed: async (text: string, options?: EmbeddingRequestOptions) => {
      recorded.push({ text, purpose: options?.purpose, batch: false });
      return { embedding: vec(text), tokenCount: text.length };
    },
    embedBatch: async (texts: string[], options?: EmbeddingRequestOptions) => {
      for (const text of texts) {
        recorded.push({ text, purpose: options?.purpose, batch: true });
      }
      return texts.map((t) => ({ embedding: vec(t), tokenCount: t.length }));
    },
  };
}

function createMockLanceDB() {
  return {
    connect: async () => {},
    addChunks: async () => {},
    search: async () => [],
    fullTextSearch: async () => [],
    deleteByPageSlug: async () => {},
    deleteRawChunksByPageSlug: async () => {},
    close: async () => {},
    createFTSIndex: async () => {},
    addInsightVector: async () => {},
    searchInsights: async () => [],
  };
}

describe("embedding purpose at the call sites (#544)", () => {
  const testDir = "/tmp/cbrain-test-embedding-purpose";
  const dbPath = join(testDir, "test.sqlite");
  let db: CBrainDB;
  let recorded: RecordedEmbed[];

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(dbPath);
    recorded = [];
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("HybridSearch vector retrieval encodes the query with purpose:query", async () => {
    const search = new HybridSearch(
      db,
      createRecordingEmbeddingProvider(recorded),
      createMockLanceDB() as never,
      { rrf_k: 60 },
    );

    await search.search("匿名查询占位符", { strategy: "vector" });

    expect(recorded).toHaveLength(1);
    expect(recorded[0].text).toBe("匿名查询占位符");
    expect(recorded[0].purpose).toBe("query");
  });

  test("InsightManager.queryInsights encodes the query with purpose:query", async () => {
    const insights = new InsightManager(
      db,
      createRecordingEmbeddingProvider(recorded),
      createMockLanceDB() as never,
    );

    await insights.queryInsights("匿名查询占位符");

    expect(recorded).toHaveLength(1);
    expect(recorded[0].purpose).toBe("query");
  });

  test("InsightManager.createInsight encodes the insight body as a document", async () => {
    const insights = new InsightManager(
      db,
      createRecordingEmbeddingProvider(recorded),
      createMockLanceDB() as never,
    );

    await insights.createInsight({
      type: "synthesis",
      content: "匿名洞察正文占位符",
      sourceType: "manual",
    });

    expect(recorded).toHaveLength(1);
    expect(recorded[0].text).toBe("匿名洞察正文占位符");
    // Document default: no query instruction prefix is applied downstream.
    expect(recorded[0].purpose).toBeUndefined();
  });

  test("ContentPipeline.embed encodes chunk bodies as documents", async () => {
    const pipeline = new ContentPipeline(
      db,
      createRecordingEmbeddingProvider(recorded),
      createMockLanceDB() as never,
      { chunkSize: 512 },
    );

    await pipeline.embed("匿名页面正文占位符。");

    expect(recorded.length).toBeGreaterThan(0);
    for (const call of recorded) {
      expect(call.batch).toBe(true);
      // The chunk write path must never claim query semantics; the provider
      // only applies the instruction prefix when purpose is exactly "query".
      expect(call.purpose).toBeUndefined();
    }
  });
});

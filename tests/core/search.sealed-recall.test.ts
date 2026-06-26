import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HybridSearch, type SearchResult } from "../../src/core/search.js";
import { CBrainDB } from "../../src/storage/sqlite.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";

function createMockEmbeddingProvider(): EmbeddingProvider {
  const fakeVec = (text: string) => {
    const vec = new Array(128).fill(0);
    for (let i = 0; i < text.length; i++) vec[i % 128] += text.charCodeAt(i) / 65536;
    return vec;
  };
  return {
    dimensions: 128,
    embed: async (text: string) => ({ embedding: fakeVec(text), tokenCount: text.length }),
    embedBatch: async (texts: string[]) =>
      texts.map((t) => ({ embedding: fakeVec(t), tokenCount: t.length })),
  };
}

// Mirrors real LanceDB: vectorSearch keeps chunkIndex === -1 summary content.
function createMockLance(sealedSlug: string, sealedSummary: string) {
  return {
    connect: async () => {},
    addChunks: async () => {},
    search: async () => [
      { pageSlug: sealedSlug, chunkIndex: -1, content: sealedSummary, _distance: 0.05 },
    ],
    fullTextSearch: async () => [],
    deleteByPageSlug: async () => {},
    deleteRawChunksByPageSlug: async () => {},
    close: async () => {},
    createFTSIndex: async () => {},
  };
}

function insertPage(db: CBrainDB, slug: string) {
  db.rawDb.prepare(
    "INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(slug, "entity/project", slug, `${slug}.md`, `h-${slug}`, 0);
}

function seedSealed(db: CBrainDB, slug: string, rawChunk: string, summary: string) {
  insertPage(db, slug);
  db.insertChunkWithLevel(slug, 0, rawChunk, 0, null);
  db.ftsInsert(slug, rawChunk);
  db.insertChunkWithLevel(slug, -1, summary, 1, `hash-${slug}`);
  db.ftsInsert(slug, summary);
}

describe("HybridSearch sealed detail enrichment (#169)", () => {
  const testDir = "/tmp/cbrain-test-sealed-recall";
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

  test("sealed page: detail token in raw chunk surfaces via result.detail", async () => {
    const DETAIL = "ALPHA-123";
    seedSealed(
      db,
      "p/sealed-a",
      `项目预算审批单编号 ${DETAIL}，金额一百二十万元。`,
      "该项目记录了预算审批流程的整体概览与结论，不含具体单据编号。"
    );
    const search = new HybridSearch(
      db,
      createMockEmbeddingProvider(),
      createMockLance("p/sealed-a", "该项目记录了预算审批流程的整体概览与结论") as any,
      { rrf_k: 60 }
    );
    const results: SearchResult[] = await search.search(DETAIL, { limit: 5 });
    const hit = results.find((r) => r.slug === "p/sealed-a");
    expect(hit).toBeTruthy();
    expect(hit!.detail).toBeDefined();
    expect(hit!.detail!.level).toBe("raw_chunk");
    expect(hit!.detail!.snippet).toContain(DETAIL);
  });

  test("natural-language query (NOT a raw-chunk substring) still recovers detail", async () => {
    const DETAIL = "ALPHA-123";
    seedSealed(
      db,
      "p/sealed-nl",
      `审批编号 ${DETAIL}，金额一百二十万元。`,
      "项目审批概要，省略具体编号与金额。"
    );
    const search = new HybridSearch(
      db,
      createMockEmbeddingProvider(),
      createMockLance("p/sealed-nl", "项目审批概要，省略具体编号与金额。") as any,
      { rrf_k: 60 }
    );
    // The full sentence is NOT a substring of the raw chunk, but the query
    // carries the 审批编号 keyword (CJK 3-gram) which LIKE-matches the chunk.
    const results = await search.search("这个项目的审批编号是多少", { limit: 5 });
    const hit = results.find((r) => r.slug === "p/sealed-nl");
    expect(hit).toBeTruthy();
    expect(hit!.detail).toBeDefined();
    expect(hit!.detail!.snippet).toContain(DETAIL);
  });

  test("query with no usable detail terms does not set detail (no scan)", async () => {
    seedSealed(db, "p/sealed-empty", "原始内容含一些字", "概要不含细节");
    const search = new HybridSearch(
      db,
      createMockEmbeddingProvider(),
      createMockLance("p/sealed-empty", "概要不含细节") as any,
      { rrf_k: 60 }
    );
    // Pure punctuation / single chars → no terms → enrichment skipped.
    const results = await search.search("？ ！", { limit: 5 });
    const hit = results.find((r) => r.slug === "p/sealed-empty");
    if (hit) expect(hit.detail).toBeUndefined();
  });

  test("unsealed page: fast path skips enrichment (no detail set)", async () => {
    const DETAIL = "BETA-456";
    insertPage(db, "p/raw-b");
    db.insertChunkWithLevel("p/raw-b", 0, `原始记录编号 ${DETAIL}`, 0, null);
    db.ftsInsert("p/raw-b", `原始记录编号 ${DETAIL}`);
    const search = new HybridSearch(
      db,
      createMockEmbeddingProvider(),
      { search: async () => [] } as any,
      { rrf_k: 60 }
    );
    const results = await search.search(DETAIL, { limit: 5 });
    const hit = results.find((r) => r.slug === "p/raw-b");
    expect(hit).toBeTruthy();
    expect(hit!.detail).toBeUndefined();
  });

  test("mixed sealed/unsealed: ranking preserved, only sealed gets detail", async () => {
    const DETAIL = "GAMMA-789";
    seedSealed(db, "p/sealed-c", `附加说明编号 ${DETAIL} 存于此处。`, "整体结论概要，用于召回。");
    insertPage(db, "p/raw-d");
    db.insertChunkWithLevel("p/raw-d", 0, `另一处出现编号 ${DETAIL}`, 0, null);
    db.ftsInsert("p/raw-d", `另一处出现编号 ${DETAIL}`);
    const search = new HybridSearch(
      db,
      createMockEmbeddingProvider(),
      createMockLance("p/sealed-c", "整体结论概要，用于召回。") as any,
      { rrf_k: 60 }
    );
    const results = await search.search(DETAIL, { limit: 5 });
    const slugs = results.map((r) => r.slug);
    expect(slugs).toContain("p/sealed-c");
    expect(slugs).toContain("p/raw-d");
    expect(results.find((r) => r.slug === "p/sealed-c")!.detail?.level).toBe("raw_chunk");
    expect(results.find((r) => r.slug === "p/raw-d")!.detail).toBeUndefined();
  });
});

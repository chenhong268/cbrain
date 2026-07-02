import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HybridSearch } from "../../src/core/retrieval/search.js";
import { CBrainDB } from "../../src/storage/sqlite.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";

function embProvider(): EmbeddingProvider {
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

describe("deep_recall sealed detail display (#169)", () => {
  const testDir = "/tmp/cbrain-test-sealed-display";
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

  test("display snippet surfaces raw-chunk detail and contains no internal level marker", async () => {
    const DETAIL = "EPSILON-321";
    db.rawDb.prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("p/sealed-f", "entity/project", "Sealed F", "p/sealed-f.md", "h", 0);
    const rawChunk = `合同编号 ${DETAIL} 签订于第一季度。`;
    const summary = "合同概要，省略具体编号。";
    db.insertChunkWithLevel("p/sealed-f", 0, rawChunk, 0, null);
    db.ftsInsert("p/sealed-f", rawChunk);
    db.insertChunkWithLevel("p/sealed-f", -1, summary, 1, "hash-f");
    db.ftsInsert("p/sealed-f", summary);

    const search = new HybridSearch(
      db,
      embProvider(),
      {
        connect: async () => {},
        addChunks: async () => {},
        search: async () => [
          { pageSlug: "p/sealed-f", chunkIndex: -1, content: summary, _distance: 0.05 },
        ],
        fullTextSearch: async () => [],
        deleteByPageSlug: async () => {},
        deleteRawChunksByPageSlug: async () => {},
        close: async () => {},
        createFTSIndex: async () => {},
      } as any,
      { rrf_k: 60 }
    );

    const results = await search.search(DETAIL, { limit: 5 });
    const hit = results.find((r) => r.slug === "p/sealed-f")!;

    // Mirrors recall.ts:295 display selection.
    const displayed = hit.detail?.snippet ?? hit.snippet;
    expect(displayed).toContain(DETAIL);

    // The user-facing payload must not leak the internal level marker.
    const serialized = JSON.stringify(displayed);
    expect(serialized).not.toContain("raw_chunk");
    expect(serialized).not.toContain('"level"');
  });
});

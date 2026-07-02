import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import type { LLMProvider } from "../../src/llm/provider.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";
import { LanceDBManager } from "../../src/storage/lancedb.js";
import { SealManager } from "../../src/core/maintenance/seal.js";

function makeLLM(response: string): LLMProvider {
  return {
    name: "test-llm",
    chat: mock(async () => response),
  };
}

function makeEmbedding(dimensions = 4): EmbeddingProvider {
  return {
    dimensions,
    embed: mock(async () => ({
      embedding: new Array(dimensions).fill(0.1),
      tokenCount: 10,
    })),
    embedBatch: mock(async (texts: string[]) =>
      texts.map(() => ({ embedding: new Array(dimensions).fill(0.1), tokenCount: 10 }))
    ),
  };
}

describe("SealManager", () => {
  const testDir = "/tmp/cbrain-test-seal";
  const dbPath = join(testDir, "test.sqlite");
  const lancePath = join(testDir, "lancedb");
  let db: CBrainDB;
  let lance: LanceDBManager;

  beforeEach(async () => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(dbPath);
    lance = new LanceDBManager();
    await lance.connect(lancePath);
  });

  afterEach(async () => {
    await lance.close();
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  function insertPage(slug: string, title: string) {
    db.rawDb.prepare(
      `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'record', ?, ?, 'h1')`
    ).run(slug, title, `${slug}.md`);
  }

  function insertRawChunks(slug: string, contents: string[]) {
    for (let i = 0; i < contents.length; i++) {
      db.insertChunk(slug, i, contents[i]);
    }
  }

  describe("sealPage", () => {
    test("generates L1 summary and stores it", async () => {
      insertPage("test-page", "Test");
      insertRawChunks("test-page", ["chunk one content", "chunk two content"]);

      const llm = makeLLM(JSON.stringify({ summary: "This is the summary", key_topics: ["topic1"] }));
      const embedding = makeEmbedding();
      const seal = new SealManager(db, llm, embedding, lance);

      const result = await seal.sealPage("test-page");
      expect(result.sealed).toBe(true);
      expect(result.reason).toBe("sealed");

      const l1 = db.getL1Summary("test-page");
      expect(l1).not.toBeNull();
      expect(l1!.content).toBe("This is the summary");

      const rawChunks = db.getChunksByPage("test-page", { summaryLevel: 0 });
      expect(rawChunks.length).toBe(2);
    });

    test("skips when no raw chunks", async () => {
      insertPage("empty-page", "Empty");
      const seal = new SealManager(db, makeLLM("{}"), makeEmbedding(), lance);
      const result = await seal.sealPage("empty-page");
      expect(result.sealed).toBe(false);
      expect(result.reason).toBe("no raw chunks");
    });

    test("skips when content unchanged", async () => {
      insertPage("cached-page", "Cached");
      insertRawChunks("cached-page", ["content A"]);

      const llm = makeLLM(JSON.stringify({ summary: "Summary 1", key_topics: [] }));
      const seal = new SealManager(db, llm, makeEmbedding(), lance);

      await seal.sealPage("cached-page");

      const result = await seal.sealPage("cached-page");
      expect(result.sealed).toBe(false);
      expect(result.reason).toBe("unchanged");
    });

    test("re-seals when raw chunks change", async () => {
      insertPage("change-page", "Change");
      insertRawChunks("change-page", ["original content"]);

      const llm = makeLLM(JSON.stringify({ summary: "Summary v1", key_topics: [] }));
      const seal = new SealManager(db, llm, makeEmbedding(), lance);
      await seal.sealPage("change-page");

      db.deleteChunksByPage("change-page");
      insertRawChunks("change-page", ["modified content"]);

      const llm2 = makeLLM(JSON.stringify({ summary: "Summary v2", key_topics: [] }));
      const seal2 = new SealManager(db, llm2, makeEmbedding(), lance);
      const result = await seal2.sealPage("change-page");
      expect(result.sealed).toBe(true);

      const l1 = db.getL1Summary("change-page");
      expect(l1!.content).toBe("Summary v2");
    });

    test("handles LLM failure gracefully", async () => {
      insertPage("fail-page", "Fail");
      insertRawChunks("fail-page", ["some content"]);

      const llm: LLMProvider = { name: "fail", chat: mock(async () => { throw new Error("API error"); }) };
      const seal = new SealManager(db, llm, makeEmbedding(), lance);

      let threw = false;
      try { await seal.sealPage("fail-page"); } catch { threw = true; }
      expect(threw).toBe(true);
    }, 20000);
  });

  describe("sealAll", () => {
    test("processes all pages needing seal", async () => {
      insertPage("page-a", "A");
      insertPage("page-b", "B");
      insertRawChunks("page-a", ["content a"]);
      insertRawChunks("page-b", ["content b"]);

      const llm = makeLLM(JSON.stringify({ summary: "Summary", key_topics: [] }));
      const seal = new SealManager(db, llm, makeEmbedding(), lance);
      const result = await seal.sealAll();

      expect(result.sealed).toBe(2);
      expect(result.errors).toBe(0);
    });
  });

  describe("writeIndexes preserves L1", () => {
    test("L1 survives pipeline writeIndexes", async () => {
      insertPage("sync-page", "Sync");
      insertRawChunks("sync-page", ["original"]);

      const llm = makeLLM(JSON.stringify({ summary: "L1 Summary", key_topics: [] }));
      const seal = new SealManager(db, llm, makeEmbedding(), lance);
      await seal.sealPage("sync-page");

      db.deleteChunksByPage("sync-page");
      await lance.deleteRawChunksByPageSlug("sync-page");
      db.ftsDeleteByPage("sync-page");

      const newChunks = [{ index: 0, content: "updated content" }];
      const embedResults = [{ embedding: [0.1, 0.1, 0.1, 0.1], tokenCount: 5 }];
      await lance.addChunks(newChunks.map((c, i) => ({
        pageSlug: "sync-page",
        chunkIndex: c.index,
        content: c.content,
        vector: new Float32Array(embedResults[i].embedding),
      })));
      for (const chunk of newChunks) {
        db.insertChunk("sync-page", chunk.index, chunk.content);
      }
      db.ftsInsert("sync-page", newChunks[0].content);
      const l1 = db.getL1Summary("sync-page");
      if (l1) db.ftsInsert("sync-page", l1.content);

      const l1After = db.getL1Summary("sync-page");
      expect(l1After).not.toBeNull();
      expect(l1After!.content).toBe("L1 Summary");
    });
  });
});

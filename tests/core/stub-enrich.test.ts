import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { existsSync, rmSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CBrainDB } from "../../src/storage/sqlite.js";
import type { LLMProvider } from "../../src/llm/provider.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";
import { LanceDBManager } from "../../src/storage/lancedb.js";
import { PageManager } from "../../src/core/page.js";
import { ContentPipeline } from "../../src/core/pipeline.js";
import { StubEnrichManager } from "../../src/core/stub-enrich.js";

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

describe("StubEnrichManager", () => {
  let testDir: string;
  let dbPath: string;
  let lancePath: string;
  let vaultPath: string;
  let db: CBrainDB;
  let lance: LanceDBManager;
  let pages: PageManager;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "cbrain-test-stub-enrich-"));
    dbPath = join(testDir, "test.sqlite");
    lancePath = join(testDir, "lancedb");
    vaultPath = join(testDir, "vault");
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(dbPath);
    lance = new LanceDBManager();
    await lance.connect(lancePath);
    pages = new PageManager(db, vaultPath);
  });

  afterEach(async () => {
    await lance.close();
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  function makeManager(llmResponse: string): StubEnrichManager {
    const llm = makeLLM(llmResponse);
    const embedding = makeEmbedding();
    const pipeline = new ContentPipeline(db, embedding, lance, { pages });
    return new StubEnrichManager(db, llm, embedding, lance, pages, pipeline);
  }

  describe("enrichStub", () => {
    test("enriches a thin stub with incoming link context", async () => {
      // Create a stub entity via PageManager (creates vault file + DB row)
      const stub = pages.create({
        title: "目标实体",
        type: "entity/person",
        body: "> Auto-extracted from [[some-source]]",
        tags: ["auto-extracted"],
      });
      // Bump mention_count to simulate multiple references
      db.incrementMentionCount(stub.slug);
      db.incrementMentionCount(stub.slug);
      db.incrementMentionCount(stub.slug);

      // Create a source page that mentions the entity
      const source = pages.create({
        title: "源文档",
        type: "record",
        body: "目标实体是一位资深工程师，擅长系统架构设计",
      });
      // Insert chunk for source
      db.insertChunk(source.slug, 0, "目标实体是一位资深工程师，擅长系统架构设计");
      // Link source → stub with context
      db.insertLink(source.slug, stub.slug, "提及", "目标实体是一位资深工程师", 0.5, "weak", "ner", 0.5, false, undefined);

      const mgr = makeManager(JSON.stringify({
        summary: "目标实体是一位资深系统架构工程师",
        facts: ["擅长系统架构设计（来源：[[" + source.slug + "]]）"],
      }));

      const result = await mgr.enrichStub(stub.slug);
      expect(result.enriched).toBe(true);
      expect(result.reason).toBe("enriched");

      // Verify page body was updated
      const updated = pages.getBySlug(stub.slug);
      expect(updated).not.toBeNull();
      expect(updated!.body).toContain("目标实体是一位资深系统架构工程师");
      expect(updated!.frontmatter.enriched_at).toBeDefined();
    });

    test("skips already enriched page", async () => {
      const stub = pages.create({
        title: "已富化实体",
        type: "entity/person",
        body: "> Auto-extracted from [[source]]",
      });
      // Mark as already enriched
      pages.update(stub.slug, { extra: { enriched_at: "2025-01-01T00:00:00.000Z" } });

      const mgr = makeManager("{}");
      const result = await mgr.enrichStub(stub.slug);
      expect(result.enriched).toBe(false);
      expect(result.reason).toBe("already_enriched");
    });

    test("skips page with no context", async () => {
      const stub = pages.create({
        title: "空实体",
        type: "entity/person",
        body: "> Auto-extracted from [[source]]",
      });
      // No incoming links, no source chunks — nothing to generate from

      const mgr = makeManager("{}");
      const result = await mgr.enrichStub(stub.slug);
      expect(result.enriched).toBe(false);
      expect(result.reason).toBe("no_context");
    });

    test("handles LLM returning invalid JSON gracefully", async () => {
      const stub = pages.create({
        title: "LLM异常实体",
        type: "entity/person",
        body: "> Auto-extracted from [[source]]",
      });

      const source = pages.create({ title: "来源", type: "record", body: "来源内容" });
      db.insertLink(source.slug, stub.slug, "提及", "一些上下文信息", 0.5, "weak", "ner", 0.5, false, undefined);

      const mgr = makeManager("not valid json at all");
      const result = await mgr.enrichStub(stub.slug);
      expect(result.enriched).toBe(false);
      expect(result.reason).toBe("llm_failed");
    });

    test("returns not found for missing page", async () => {
      const mgr = makeManager("{}");
      const result = await mgr.enrichStub("entity/nonexistent");
      expect(result.enriched).toBe(false);
      expect(result.reason).toBe("page not found");
    });
  });

  describe("enrichAll", () => {
    test("processes all popular thin pages", async () => {
      // Create two thin stubs — need mention_count >= 3 and chunk_count <= 1
      const stubA = pages.create({
        title: "Stub A",
        type: "entity/person",
        body: "> Auto-extracted from [[src]]",
      });
      db.incrementMentionCount(stubA.slug);
      db.incrementMentionCount(stubA.slug);
      db.incrementMentionCount(stubA.slug);

      const stubB = pages.create({
        title: "Stub B",
        type: "entity/company",
        body: "> Auto-extracted from [[src]]",
      });
      db.incrementMentionCount(stubB.slug);
      db.incrementMentionCount(stubB.slug);
      db.incrementMentionCount(stubB.slug);

      // Add context for both via a source page
      const source = pages.create({ title: "Source", type: "record", body: "source content" });
      db.insertLink(source.slug, stubA.slug, "提及", "Stub A 的描述", 0.5, "weak", "ner", 0.5, false, undefined);
      db.insertLink(source.slug, stubB.slug, "提及", "Stub B 的描述", 0.5, "weak", "ner", 0.5, false, undefined);

      const mgr = makeManager(JSON.stringify({
        summary: "摘要内容",
        facts: ["事实1"],
      }));

      const result = await mgr.enrichAll(3);
      expect(result.enriched).toBe(2);
      expect(result.errors).toBe(0);
    });

    test("returns zeros when no candidates", async () => {
      // Empty DB — no pages at all
      const mgr = makeManager("{}");
      const result = await mgr.enrichAll();
      expect(result.enriched).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.errors).toBe(0);
    });
  });
});

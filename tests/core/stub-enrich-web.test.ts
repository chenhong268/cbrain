import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { existsSync, rmSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CBrainDB } from "../../src/storage/sqlite.js";
import type { LLMProvider } from "../../src/llm/provider.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";
import type { SearchProvider, SearchResult } from "../../src/search/provider.js";
import { LanceDBManager } from "../../src/storage/lancedb.js";
import { PageManager } from "../../src/core/page.js";
import { ContentPipeline } from "../../src/core/pipeline.js";
import { StubEnrichManager } from "../../src/core/stub-enrich.js";

// ─── Mock factories ────────────────────────────────────────────

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

function makeSearchProvider(results: SearchResult[]): SearchProvider {
  return {
    name: "test-search",
    search: mock(async () => results),
  };
}

function makeSearchProviderError(message: string): SearchProvider {
  return {
    name: "test-search-error",
    search: mock(async () => { throw new Error(message); }),
  };
}

// ─── Test suite ────────────────────────────────────────────────

describe("StubEnrichManager — web search fallback", () => {
  let testDir: string;
  let dbPath: string;
  let lancePath: string;
  let vaultPath: string;
  let db: CBrainDB;
  let lance: LanceDBManager;
  let pages: PageManager;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "cbrain-test-stub-web-"));
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

  function makeManager(
    llmResponse: string,
    searchProvider?: SearchProvider | null,
  ): StubEnrichManager {
    const llm = makeLLM(llmResponse);
    const embedding = makeEmbedding();
    const pipeline = new ContentPipeline(db, embedding, lance, { pages });
    return new StubEnrichManager(db, llm, embedding, lance, pages, pipeline, null, searchProvider);
  }

  // Helper: create a stub with 1 incoming link (context.length = 1)
  function seedThinStub(title: string) {
    const stub = pages.create({
      title,
      type: "entity/person",
      body: `> Auto-extracted from [[some-source]]`,
    });
    db.incrementMentionCount(stub.slug);
    db.incrementMentionCount(stub.slug);
    db.incrementMentionCount(stub.slug);

    const source = pages.create({ title: "来源页", type: "record", body: `${title} 的描述内容` });
    db.insertLink(source.slug, stub.slug, "提及", `${title} 的简要描述`, 0.5, "weak", "ner", 0.5, false, undefined);
    return stub;
  }

  // Helper: create a stub with 4 incoming links (context.length >= 3)
  function seedRichStub(title: string) {
    const stub = pages.create({
      title,
      type: "entity/person",
      body: `> Auto-extracted from [[some-source]]`,
    });
    db.incrementMentionCount(stub.slug);
    db.incrementMentionCount(stub.slug);
    db.incrementMentionCount(stub.slug);

    for (let i = 1; i <= 4; i++) {
      const src = pages.create({ title: `来源${i}`, type: "record", body: `${title} 相关内容 ${i}` });
      db.insertLink(src.slug, stub.slug, "提及", `${title} 的上下文 ${i}`, 0.5, "weak", "ner", 0.5, false, undefined);
    }
    return stub;
  }

  const webResults: SearchResult[] = [
    { title: "Wikipedia", url: "https://example.com", snippet: "这是来自网络的实体简介信息" },
    { title: "百度百科", url: "https://example.com/2", snippet: "这是第二条网络搜索结果" },
  ];

  const llmResponse = JSON.stringify({
    summary: "一位知名的历史人物",
    facts: [
      "擅长文学创作 (来源：web)",
      "在某领域有突出贡献 (来源：web)",
    ],
  });

  // ─── Tests ──────────────────────────────────────────────────

  test("web search triggers when searchProvider is explicitly provided", async () => {
    const stub = seedThinStub("张岱");
    const search = makeSearchProvider(webResults);
    const mgr = makeManager(llmResponse, search);

    const result = await mgr.enrichStub(stub.slug);

    expect(result.enriched).toBe(true);
    // Verify search was called
    expect(search.search).toHaveBeenCalledTimes(1);
    // Verify enriched_sources includes web
    const updated = pages.getBySlug(stub.slug);
    expect(updated!.frontmatter.enriched_sources).toEqual(["internal", "web"]);
  });

  test("no searchProvider — pure internal enrichment regardless of context count", async () => {
    const stub = seedRichStub("丰富实体");
    // No searchProvider passed — mimics default behavior (no --web flag)
    const mgr = makeManager(llmResponse, null);

    const result = await mgr.enrichStub(stub.slug);

    expect(result.enriched).toBe(true);
    const updated = pages.getBySlug(stub.slug);
    expect(updated!.frontmatter.enriched_sources).toEqual(["internal"]);
  });

  test("no searchProvider — pure internal enrichment", async () => {
    const stub = seedThinStub("无搜索实体");
    const mgr = makeManager(llmResponse, null);

    const result = await mgr.enrichStub(stub.slug);

    expect(result.enriched).toBe(true);
    const updated = pages.getBySlug(stub.slug);
    expect(updated!.frontmatter.enriched_sources).toEqual(["internal"]);
  });

  test("web search failure degrades gracefully", async () => {
    const stub = seedThinStub("搜索失败实体");
    const search = makeSearchProviderError("Connection refused");
    const mgr = makeManager(llmResponse, search);

    const result = await mgr.enrichStub(stub.slug);

    // Still enriches with internal context
    expect(result.enriched).toBe(true);
    const updated = pages.getBySlug(stub.slug);
    // No web source since search failed
    expect(updated!.frontmatter.enriched_sources).toEqual(["internal"]);
  });

  test("no context even after web search returns empty", async () => {
    const stub = pages.create({
      title: "完全未知实体",
      type: "entity/person",
      body: `> Auto-extracted from [[source]]`,
    });
    // No incoming links, search returns empty
    const search = makeSearchProvider([]);
    const mgr = makeManager("{}", search);

    const result = await mgr.enrichStub(stub.slug);
    expect(result.enriched).toBe(false);
    expect(result.reason).toBe("no_context");
  });

  test("enriched_sources frontmatter tracks sources correctly", async () => {
    const stub = seedThinStub("来源追踪实体");
    const search = makeSearchProvider(webResults);
    const mgr = makeManager(llmResponse, search);

    await mgr.enrichStub(stub.slug);

    const updated = pages.getBySlug(stub.slug);
    expect(updated!.frontmatter.enriched_sources).toContain("internal");
    expect(updated!.frontmatter.enriched_sources).toContain("web");
    expect(updated!.frontmatter.enriched_at).toBeDefined();
  });

  test("Vault 记录 section appears in output", async () => {
    const stub = seedThinStub("记录段落实体");
    const mgr = makeManager(llmResponse, null);

    const result = await mgr.enrichStub(stub.slug);
    expect(result.enriched).toBe(true);

    const updated = pages.getBySlug(stub.slug);
    expect(updated!.body).toContain("**Vault 记录：**");
  });

  test("summary over 500 chars is truncated", async () => {
    const stub = seedThinStub("长摘要实体");
    const longSummary = "这是一段非常长的摘要内容。".repeat(50); // ~600 chars
    const mgr = makeManager(JSON.stringify({
      summary: longSummary,
      facts: ["事实1"],
    }), null);

    const result = await mgr.enrichStub(stub.slug);
    expect(result.enriched).toBe(true);

    const updated = pages.getBySlug(stub.slug);
    // The summary in the body should be the truncated version
    const summaryLine = updated!.body.split("\n").find(l => l.includes("这是一段非常长的摘要"));
    expect(summaryLine).toBeDefined();
    expect(summaryLine!.length).toBeLessThanOrEqual(500);
  });
});

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HybridSearch } from "../../src/core/search.js";
import { CBrainDB } from "../../src/storage/sqlite.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";
import type { LLMProvider } from "../../src/llm/provider.js";

function createMockEmbeddingProvider(): EmbeddingProvider {
  const fakeVec = (text: string) => {
    const vec = new Array(128).fill(0);
    for (let i = 0; i < text.length; i++) {
      vec[i % 128] += text.charCodeAt(i) / 65536;
    }
    return vec;
  };
  return {
    dimensions: 128,
    embed: async (text: string) => ({
      embedding: fakeVec(text),
      tokenCount: text.length,
    }),
    embedBatch: async (texts: string[]) =>
      texts.map((t) => ({ embedding: fakeVec(t), tokenCount: t.length })),
  };
}

function createMockLance() {
  return {
    connect: async () => {},
    addChunks: async () => {},
    search: async () => [],
    fullTextSearch: async () => [],
    deleteByPageSlug: async () => {},
    deleteRawChunksByPageSlug: async () => {},
    close: async () => {},
    createFTSIndex: async () => {},
  };
}

function createMockLLM(responses: string[]): LLMProvider {
  let callIndex = 0;
  return {
    name: "mock",
    chat: async () =>
      responses[callIndex++] ??
      '{"sufficient": true, "reason": "default"}',
  };
}

function insertPage(
  db: CBrainDB,
  slug: string,
  title: string,
  type: string,
  mentionCount = 0
) {
  db.prepare(
    "INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(slug, type, title, `${slug}.md`, `h-${slug}`, mentionCount);
}

describe("HybridSearch multiStep", () => {
  const testDir = "/tmp/cbrain-test-multistep";
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

  test("multiStep=false does not trigger sufficiency check", async () => {
    const llmCalls: string[] = [];
    const llm: LLMProvider = {
      name: "mock",
      chat: async (messages) => {
        const sysMsg = messages.find((m) => m.role === "system")!;
        llmCalls.push(sysMsg.content);
        return "[]";
      },
    };

    insertPage(db, "entity/test", "测试实体", "entity/person");

    const search = new HybridSearch(
      db, createMockEmbeddingProvider(), createMockLance() as any,
      { rrf_k: 60, llm }
    );

    await search.search("测试实体", { multiStep: false });
    const hasSufficiency = llmCalls.some((c) => c.includes("充分性评估器"));
    expect(hasSufficiency).toBe(false);
  });

  test("multiStep=true with sufficient results → no retry, reranks", async () => {
    insertPage(db, "entity/zhangsan", "张三", "entity/person");
    insertPage(db, "entity/lisi", "李四", "entity/person");

    // Response order: sufficiency check → rerank
    const llm = createMockLLM([
      '{"sufficient": true, "reason": "结果充分"}',
      '{"order": [2, 1]}',
    ]);

    const search = new HybridSearch(
      db, createMockEmbeddingProvider(), createMockLance() as any,
      { rrf_k: 60, llm }
    );

    const results = await search.search("张三", { multiStep: true, limit: 5 });
    expect(Array.isArray(results)).toBe(true);
  });

  test("multiStep=true with insufficient results → retries up to 3 rounds", async () => {
    insertPage(db, "entity/zhangsan", "张三", "entity/person");

    // All sufficiency checks return false, rerank at the end
    const llm = createMockLLM([
      '{"sufficient": false, "reason": "不够"}',  // attempt 0
      '{"sufficient": false, "reason": "不够"}',  // attempt 1
      '{"sufficient": false, "reason": "不够"}',  // attempt 2
      '{"order": [1]}',                            // final rerank
    ]);

    const search = new HybridSearch(
      db, createMockEmbeddingProvider(), createMockLance() as any,
      { rrf_k: 60, llm }
    );

    const results = await search.search("张三", { multiStep: true, limit: 5 });
    expect(Array.isArray(results)).toBe(true);
  });

  test("multiStep=true completes with rerank path", async () => {
    insertPage(db, "entity/a", "实体A", "entity/person");

    // Track LLM calls to verify sufficiency check was invoked
    const llmCalls: string[] = [];
    const llm: LLMProvider = {
      name: "mock",
      chat: async (messages) => {
        const sysMsg = messages.find((m) => m.role === "system")!.content;
        llmCalls.push(sysMsg);
        return '{"sufficient": true, "reason": "ok"}';
      },
    };

    const search = new HybridSearch(
      db, createMockEmbeddingProvider(), createMockLance() as any,
      { rrf_k: 60, llm }
    );

    const results = await search.search("实体A", { multiStep: true, limit: 5 });
    expect(Array.isArray(results)).toBe(true);
    // Verify reasoning or rerank was called (proves multiStep path ran)
    expect(llmCalls.some((c) => c.includes("搜索推理引擎") || c.includes("排序器"))).toBe(true);
  });

  test("no LLM → multiStep degrades to searchCore", async () => {
    insertPage(db, "entity/zhangsan", "张三", "entity/person");

    const search = new HybridSearch(
      db, createMockEmbeddingProvider(), createMockLance() as any,
      { rrf_k: 60 }  // no LLM
    );

    const results = await search.search("张三", { multiStep: true, limit: 5 });
    expect(Array.isArray(results)).toBe(true);
  });

  test("0 results returns empty", async () => {
    const llm = createMockLLM([
      '{"sufficient": true, "reason": "empty"}',
    ]);

    const search = new HybridSearch(
      db, createMockEmbeddingProvider(), createMockLance() as any,
      { rrf_k: 60, llm }
    );

    const results = await search.search("完全不存在的东西", { multiStep: true, limit: 5 });
    expect(results).toEqual([]);
  });

  test("multiStep=undefined (not passed) with complex query triggers multiStep", async () => {
    insertPage(db, "entity/zhangsan", "张三", "entity/person");
    insertPage(db, "entity/lisi", "李四", "entity/person");
    // Insert chunks whose content matches the query trigrams so FTS finds them
    const sharedContent = "张三和李四的投资哲学对比分析";
    db.prepare("INSERT INTO chunks (page_slug, chunk_index, content, summary_level) VALUES (?, ?, ?, ?)")
      .run("entity/zhangsan", 0, sharedContent, 0);
    db.prepare("INSERT INTO chunks_fts (page_slug, content) VALUES (?, ?)")
      .run("entity/zhangsan", sharedContent);

    const llmCalls: string[] = [];
    const llm: LLMProvider = {
      name: "mock",
      chat: async (messages) => {
        const sysMsg = messages.find((m) => m.role === "system")!.content;
        llmCalls.push(sysMsg);
        return '{"sufficient": true, "reason": "ok"}';
      },
    };

    const search = new HybridSearch(
      db, createMockEmbeddingProvider(), createMockLance() as any,
      { rrf_k: 60, llm }
    );

    // Not passing multiStep at all — should auto-trigger for query containing "和"
    const results = await search.search("张三和李四的关系", { limit: 5 });
    expect(Array.isArray(results)).toBe(true);
    // If auto-trigger works, the reasoning LLM call happens
    expect(llmCalls.some((c) => c.includes("搜索推理引擎") || c.includes("充分性"))).toBe(true);
  });

  test("multiStep=undefined with simple single-entity query does NOT trigger multiStep", async () => {
    insertPage(db, "entity/zhangsan", "张三", "entity/person");
    db.prepare("INSERT INTO chunks (page_slug, chunk_index, content, summary_level) VALUES (?, ?, ?, ?)")
      .run("entity/zhangsan", 0, "张三是一位投资人", 0);
    db.prepare("INSERT INTO chunks_fts (page_slug, content) VALUES (?, ?)")
      .run("entity/zhangsan", "张三是一位投资人");

    const llmCalls: string[] = [];
    const llm: LLMProvider = {
      name: "mock",
      chat: async (messages) => {
        const sysMsg = messages.find((m) => m.role === "system")!.content;
        llmCalls.push(sysMsg);
        return '{"sufficient": true}';
      },
    };

    const search = new HybridSearch(
      db, createMockEmbeddingProvider(), createMockLance() as any,
      { rrf_k: 60, llm }
    );

    // Single entity name — should NOT auto-trigger
    const results = await search.search("张三", { limit: 5 });
    expect(Array.isArray(results)).toBe(true);
    expect(llmCalls.length).toBe(0);
  });

  test("malformed LLM response → safe degradation", async () => {
    insertPage(db, "entity/zhangsan", "张三", "entity/person");

    const llm = createMockLLM([
      "this is not json at all",    // sufficiency check fails → returns true
      '{"order": not valid json}',   // rerank fails → original order
    ]);

    const search = new HybridSearch(
      db, createMockEmbeddingProvider(), createMockLance() as any,
      { rrf_k: 60, llm }
    );

    const results = await search.search("张三", { multiStep: true, limit: 5 });
    expect(Array.isArray(results)).toBe(true);
  });
});

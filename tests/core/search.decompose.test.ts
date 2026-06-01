import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isComplexQuery, HybridSearch } from "../../src/core/search.js";
import { CBrainDB } from "../../src/storage/sqlite.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";

describe("isComplexQuery", () => {
  test("simple single entity is not complex", () => {
    expect(isComplexQuery("张三", ["entity/zhangsan"])).toBe(false);
  });

  test("two known entities is complex", () => {
    expect(
      isComplexQuery("张三和李四", ["entity/zhangsan", "entity/lisi"])
    ).toBe(true);
  });

  test("conjunction '与' makes it complex", () => {
    expect(isComplexQuery("张三与李四", [])).toBe(true);
  });

  test("conjunction '和' makes it complex", () => {
    expect(isComplexQuery("OpenAI和Anthropic", [])).toBe(true);
  });

  test("conjunction '以及' makes it complex", () => {
    expect(isComplexQuery("机器学习以及深度学习", [])).toBe(true);
  });

  test("conjunction '跟' makes it complex", () => {
    expect(isComplexQuery("张三跟李四", [])).toBe(true);
  });

  test("single question word is not complex", () => {
    expect(isComplexQuery("什么是机器学习", [])).toBe(false);
  });

  test("multiple question words is complex", () => {
    expect(isComplexQuery("什么是机器学习，怎么入门", [])).toBe(true);
  });

  test("short query without connectors is not complex", () => {
    expect(isComplexQuery("机器学习", [])).toBe(false);
  });

  test("empty string is not complex", () => {
    expect(isComplexQuery("", [])).toBe(false);
  });

  test("only one known slug is not complex even with '的'", () => {
    expect(isComplexQuery("张三的公司", ["entity/zhangsan"])).toBe(false);
  });

  test("3+ space-separated tokens without conjunctions is complex", () => {
    expect(isComplexQuery("OpenAI Anthropic 区别", [])).toBe(true);
  });

  test("2 tokens without conjunctions is not complex", () => {
    expect(isComplexQuery("OpenAI Anthropic", [])).toBe(false);
  });

  test("agent-rewritten query with 4 tokens is complex", () => {
    expect(isComplexQuery("OpenAI Anthropic 区别 对比", [])).toBe(true);
  });

  test("explicit candidates parameter works", () => {
    expect(isComplexQuery("short", [], ["a", "b", "c"])).toBe(true);
    expect(isComplexQuery("short", [], ["a", "b"])).toBe(false);
  });
});

// --- graphPrefetch helpers ---

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

function insertPage(
  db: CBrainDB,
  slug: string,
  title: string,
  type: string,
  mentionCount = 0
) {
  db.rawDb.prepare(
    "INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(slug, type, title, `${slug}.md`, `h-${slug}`, mentionCount);
}

function insertLink(
  db: CBrainDB,
  from: string,
  to: string,
  relation = "提及"
) {
  db.rawDb.prepare(
    "INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)"
  ).run(from, to, relation);
}

describe("HybridSearch.graphPrefetch", () => {
  const testDir = "/tmp/cbrain-test-decompose-prefetch";
  const dbPath = join(testDir, "test.sqlite");
  let db: CBrainDB;
  let search: HybridSearch;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(dbPath);
    search = new HybridSearch(
      db,
      createMockEmbeddingProvider(),
      createMockLance() as any,
      { rrf_k: 60 }
    );
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("returns empty context when no entities found", async () => {
    const ctx = await search.graphPrefetch("完全不存在的东西");
    expect(ctx.entities).toEqual([]);
    expect(ctx.chains).toEqual([]);
  });

  test("returns entity with neighbors when entity exists", async () => {
    insertPage(db, "entity/zhangsan", "张三", "entity/person", 5);
    insertPage(db, "entity/abc-project", "ABC项目", "entity/product", 3);
    insertLink(db, "entity/zhangsan", "entity/abc-project", "co-founded");

    const ctx = await search.graphPrefetch("张三");
    expect(ctx.entities.length).toBeGreaterThanOrEqual(1);
    const zhangsan = ctx.entities.find((e) => e.slug === "entity/zhangsan");
    expect(zhangsan).toBeDefined();
    expect(zhangsan!.title).toBe("张三");
    expect(zhangsan!.neighbors.length).toBeGreaterThanOrEqual(1);
    expect(zhangsan!.neighbors.some((n) => n.title === "ABC项目")).toBe(true);
    expect(zhangsan!.neighbors.some((n) => n.title === "ABC项目" && n.relation === "co-founded")).toBe(true);
    expect(ctx.chains.length).toBeGreaterThanOrEqual(1);
    expect(ctx.chains.some((c) => c.includes("co-founded"))).toBe(true);
  });

  test("returns partial context when only some candidates match", async () => {
    insertPage(db, "entity/zhangsan", "张三", "entity/person");
    const ctx = await search.graphPrefetch("张三和李四");
    const zhangsan = ctx.entities.find((e) => e.slug === "entity/zhangsan");
    expect(zhangsan).toBeDefined();
    const lisi = ctx.entities.find((e) => e.title === "李四");
    expect(lisi).toBeUndefined();
  });
});

import type { LLMProvider } from "../../src/llm/provider.js";

function createMockLLM(responses: string[]): LLMProvider {
  let callIndex = 0;
  return {
    name: "mock",
    chat: async () =>
      responses[callIndex++] ??
      '{"sub_queries":[{"sub_query":"fallback","intent":"fallback"}]}',
  };
}

describe("HybridSearch.decomposeQuery", () => {
  const testDir = "/tmp/cbrain-test-decompose-query";
  const dbPath = join(testDir, "test.sqlite");
  let db: CBrainDB;
  let search: HybridSearch;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(dbPath);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("returns sub-queries from LLM", async () => {
    const llm = createMockLLM([
      JSON.stringify({
        sub_queries: [
          { sub_query: "张三的背景", intent: "个人背景" },
          { sub_query: "ABC项目详情", intent: "项目信息" },
        ],
      }),
    ]);
    search = new HybridSearch(db, createMockEmbeddingProvider(), createMockLance() as any, {
      rrf_k: 60,
      llm,
    });

    const result = await search.decomposeQuery(
      "张三和ABC项目",
      { entities: [], chains: [] }
    );
    expect(result).toEqual(["张三的背景", "ABC项目详情"]);
  });

  test("fallbacks to original query on LLM failure", async () => {
    const llm = createMockLLM(["not valid json"]);
    search = new HybridSearch(db, createMockEmbeddingProvider(), createMockLance() as any, {
      rrf_k: 60,
      llm,
    });

    const result = await search.decomposeQuery(
      "张三和李四",
      { entities: [], chains: [] }
    );
    expect(result).toEqual(["张三和李四"]);
  });

  test("fallbacks to original query when no LLM", async () => {
    search = new HybridSearch(db, createMockEmbeddingProvider(), createMockLance() as any, {
      rrf_k: 60,
    });

    const result = await search.decomposeQuery(
      "张三和李四",
      { entities: [], chains: [] }
    );
    expect(result).toEqual(["张三和李四"]);
  });

  test("truncates to 5 sub-queries max", async () => {
    const llm = createMockLLM([
      JSON.stringify({
        sub_queries: Array.from({ length: 8 }, (_, i) => ({
          sub_query: `子查询${i + 1}`,
          intent: `意图${i + 1}`,
        })),
      }),
    ]);
    search = new HybridSearch(db, createMockEmbeddingProvider(), createMockLance() as any, {
      rrf_k: 60,
      llm,
    });

    const result = await search.decomposeQuery(
      "复杂查询",
      { entities: [], chains: [] }
    );
    expect(result.length).toBeLessThanOrEqual(5);
  });

  test("includes graph context in LLM prompt", async () => {
    const calls: Array<{ role: string; content: string }[]> = [];
    const llm: LLMProvider = {
      name: "mock",
      chat: async (messages) => {
        calls.push(messages);
        return JSON.stringify({
          sub_queries: [{ sub_query: "张三", intent: "背景" }],
        });
      },
    };
    search = new HybridSearch(db, createMockEmbeddingProvider(), createMockLance() as any, {
      rrf_k: 60,
      llm,
    });

    await search.decomposeQuery("张三和ABC项目", {
      entities: [
        {
          slug: "entity/zhangsan",
          title: "张三",
          type: "entity/person",
          neighbors: [{ slug: "entity/abc", title: "ABC项目", relation: "co-founded" }],
        },
      ],
      chains: ["张三 --co-founded--> ABC项目"],
    });

    expect(calls.length).toBe(1);
    const systemMsg = calls[0].find((m) => m.role === "system")!;
    expect(systemMsg.content).toContain("张三");
    expect(systemMsg.content).toContain("ABC项目");
  });

  test("filters empty and non-string sub-queries", async () => {
    const llm = createMockLLM([
      JSON.stringify({
        sub_queries: [
          { sub_query: "有效查询", intent: "ok" },
          { sub_query: "", intent: "empty" },
          { sub_query: 42 as any, intent: "not string" },
          { sub_query: "  ", intent: "whitespace" },
        ],
      }),
    ]);
    search = new HybridSearch(db, createMockEmbeddingProvider(), createMockLance() as any, {
      rrf_k: 60,
      llm,
    });

    const result = await search.decomposeQuery(
      "测试",
      { entities: [], chains: [] }
    );
    expect(result).toEqual(["有效查询"]);
  });

  test("fallbacks on empty sub_queries array", async () => {
    const llm = createMockLLM([
      JSON.stringify({ sub_queries: [] }),
    ]);
    search = new HybridSearch(db, createMockEmbeddingProvider(), createMockLance() as any, {
      rrf_k: 60,
      llm,
    });

    const result = await search.decomposeQuery(
      "测试",
      { entities: [], chains: [] }
    );
    expect(result).toEqual(["测试"]);
  });
});

describe("HybridSearch.search() decomposition integration", () => {
  const testDir = "/tmp/cbrain-test-decompose-integration";
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

  test("simple query does not trigger decomposition", async () => {
    const llmCalls: string[] = [];
    const llm: LLMProvider = {
      name: "mock",
      chat: async (messages) => {
        const userMsg = messages.find((m) => m.role === "user");
        llmCalls.push(userMsg?.content ?? "");
        return JSON.stringify(["机器学习入门", "machine learning"]);
      },
    };
    const search = new HybridSearch(
      db,
      createMockEmbeddingProvider(),
      createMockLance() as any,
      { rrf_k: 60, llm }
    );

    await search.search("机器学习");
    expect(llmCalls.length).toBe(1);
  });

  test("complex query triggers decomposition path", async () => {
    insertPage(db, "entity/zhangsan", "张三", "entity/person", 5);
    insertPage(db, "entity/lisi", "李四", "entity/person", 3);

    const llmCalls: Array<{ role: string; content: string }[]> = [];
    let callIndex = 0;
    const responses = [
      JSON.stringify({
        sub_queries: [
          { sub_query: "张三", intent: "背景" },
          { sub_query: "李四", intent: "背景" },
        ],
      }),
    ];
    const llm: LLMProvider = {
      name: "mock",
      chat: async (messages) => {
        llmCalls.push(messages);
        return responses[callIndex++] ?? "[]";
      },
    };
    const search = new HybridSearch(
      db,
      createMockEmbeddingProvider(),
      createMockLance() as any,
      { rrf_k: 60, llm }
    );

    const results = await search.search("张三和李四的合作");
    const hasDecompose = llmCalls.some((msgs) =>
      msgs.some((m) => m.content.includes("查询分解器"))
    );
    expect(hasDecompose).toBe(true);
    expect(Array.isArray(results)).toBe(true);
  });

  test("decomposition fallbacks to expandQuery on LLM failure", async () => {
    insertPage(db, "entity/zhangsan", "张三", "entity/person", 5);
    insertPage(db, "entity/lisi", "李四", "entity/person", 3);

    let callIndex = 0;
    const responses = [
      "invalid json from decompose",
      JSON.stringify(["张三李四合作", "合作记录"]),
    ];
    const llm: LLMProvider = {
      name: "mock",
      chat: async () => responses[callIndex++] ?? "[]",
    };
    const search = new HybridSearch(
      db,
      createMockEmbeddingProvider(),
      createMockLance() as any,
      { rrf_k: 60, llm }
    );

    const results = await search.search("张三和李四");
    expect(Array.isArray(results)).toBe(true);
  });

  test("_skipDecompose prevents recursion", async () => {
    insertPage(db, "entity/zhangsan", "张三", "entity/person", 5);
    insertPage(db, "entity/lisi", "李四", "entity/person", 3);

    let callCount = 0;
    const llm: LLMProvider = {
      name: "mock",
      chat: async () => {
        callCount++;
        return JSON.stringify({
          sub_queries: [{ sub_query: "张三", intent: "bg" }],
        });
      },
    };
    const search = new HybridSearch(
      db,
      createMockEmbeddingProvider(),
      createMockLance() as any,
      { rrf_k: 60, llm }
    );

    await search.search("张三和李四", { _skipDecompose: true } as any);
    expect(callCount).toBeLessThanOrEqual(1);
  });
});

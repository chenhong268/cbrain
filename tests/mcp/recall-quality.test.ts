import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { createServer, type CBrainDeps } from "../../src/mcp/server.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";

function createMockEmbedding(): EmbeddingProvider {
  return {
    dimensions: 128,
    embed: async (text: string) => ({
      embedding: new Array(128).fill(0).map((_, i) => (text.charCodeAt(i % text.length) ?? 0) / 65536),
      tokenCount: text.length,
    }),
    embedBatch: async (texts: string[]) =>
      texts.map((t) => ({
        embedding: new Array(128).fill(0).map((_, i) => (t.charCodeAt(i % t.length) ?? 0) / 65536),
        tokenCount: t.length,
      })),
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
  };
}

function getTools(server: unknown) {
  return (server as { _registeredTools: Record<string, { handler: (input: unknown) => Promise<unknown> }> })._registeredTools;
}

describe("deep_recall quality gate (#230)", () => {
  const testDir = "/tmp/cbrain-test-recall-quality";
  const dbPath = join(testDir, "t.sqlite");
  const vaultPath = join(testDir, "vault");
  let db: CBrainDB;
  let deps: CBrainDeps;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(dbPath);
    deps = {
      db,
      embedding: createMockEmbedding(),
      lance: createMockLanceDB() as never,
      vaultPath,
      runtimePath: join(dirname(dbPath), "runtime"),
    };
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("FTS-only rich RECORD page is not filtered (#230)", async () => {
    // record pages back "之前讨论过/当时怎么设计" recall — a single-source FTS hit
    // (rrf rank-1 ≈ 0.016 > 0.01) must survive the gate; record demotion only
    // lowers rank, does not filter.
    const slug = "records/fts-record";
    db.rawDb.prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash, tier, mention_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(slug, "record", "讨论记录", "records-fts-record.md", "h1", 3, 0);
    db.rawDb.prepare("INSERT INTO chunks (page_slug, chunk_index, content) VALUES (?, ?, ?)")
      .run(slug, 0, "当时设计方案的核心讨论与关键决策记录内容");
    db.rawDb.prepare("INSERT INTO chunks_fts (page_slug, content) VALUES (?, ?)")
      .run(slug, "当时设计方案的核心讨论与关键决策记录内容");

    const server = createServer(deps);
    const result = await getTools(server).deep_recall.handler({ query: "当时设计方案" }) as { content: Array<{ text: string }> };
    const payload = JSON.parse(result.content[0].text);

    expect(payload.display).not.toContain("暂时没找到");
  });

  test("FTS-only rich page is not filtered when vector unavailable (#230)", async () => {
    // vector is mocked to return nothing; a genuine FTS hit must survive the gate
    // as fallback evidence (rrf rank-1 ≈ 0.016 > RECALL_MIN_SCORE 0.01).
    const slug = "entity/fts-rich";
    db.rawDb.prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash, tier, mention_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(slug, "entity/person", "富实体", "entity-fts-rich.md", "h1", 1, 5);
    db.rawDb.prepare("INSERT INTO chunks (page_slug, chunk_index, content) VALUES (?, ?, ?)")
      .run(slug, 0, "独特的fts关键词内容片段");
    db.rawDb.prepare("INSERT INTO chunks_fts (page_slug, content) VALUES (?, ?)")
      .run(slug, "独特的fts关键词内容片段");

    const server = createServer(deps);
    const result = await getTools(server).deep_recall.handler({ query: "独特的fts关键词" }) as { content: Array<{ text: string }> };
    const payload = JSON.parse(result.content[0].text);

    // FTS fallback evidence preserved — not filtered to empty
    expect(payload.display).not.toContain("暂时没找到");
  });

  test("absent topic returns no entity cards with honest empty display", async () => {
    const server = createServer(deps);
    const result = await getTools(server).deep_recall.handler({ query: "完全不存在的主题zyxwvu" }) as { content: Array<{ text: string }> };
    const payload = JSON.parse(result.content[0].text);

    expect(payload.entities ?? []).toHaveLength(0);
    expect(payload.display).toContain("暂时没找到");
    // display must not leak internal diagnostics
    expect(payload.display).not.toMatch(/score|slug|tier|reason_code|low_relevance|threshold/i);
  });

  test("exact-match recall does not call LLM (fast path)", async () => {
    // Short exact-title query stays on the fast exact path — no decomposition LLM.
    db.rawDb.prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash, tier, mention_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("entity/fast-exact", "entity/person", "快速桩", "entity-fast-exact.md", "h1", 3, 0);
    let llmCalls = 0;
    const depsWithLlm = {
      ...deps,
      llm: { name: "mock", chat: async () => { llmCalls++; return "{}"; } },
    } as unknown as CBrainDeps;
    const server = createServer(depsWithLlm);
    await getTools(server).deep_recall.handler({ query: "快速桩" });
    expect(llmCalls).toBe(0);
  });

  test("exact-match lookup still returns a result even when bare (bypass gate)", async () => {
    // Seed a bare tier-3 entity stub that is an exact title match.
    db.rawDb.prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash, tier, mention_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("entity/exact-stub", "entity/person", "精确桩", "entity-exact-stub.md", "h1", 3, 0);

    const server = createServer(deps);
    const result = await getTools(server).deep_recall.handler({ query: "精确桩" }) as { content: Array<{ text: string }> };
    const payload = JSON.parse(result.content[0].text);

    // Exact match bypasses the gate — the bare stub is still returned.
    const slugs = (payload.entities ?? []).map((e: { slug?: string }) => e.slug);
    expect(slugs).toContain("entity/exact-stub");
  });

  test("gate-filtered noise does not enter query log (#230 regression)", async () => {
    // Seed a bare tier-3 stub whose weak fts hit will be demoted + filtered.
    const slug = "entity/bare-noise";
    db.rawDb.prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash, tier, mention_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(slug, "entity/person", "噪声桩", "entity-bare-noise.md", "h1", 3, 0);
    db.rawDb.prepare("INSERT INTO chunks (page_slug, chunk_index, content) VALUES (?, ?, ?)")
      .run(slug, 0, "测试关键词正文内容");
    db.rawDb.prepare("INSERT INTO chunks_fts (page_slug, content) VALUES (?, ?)")
      .run(slug, "测试关键词正文内容");

    // Spy on logQuery — recall must log only gate-filtered slugs.
    const logQueryCalls: Array<{ tool: string; slugs: string[] }> = [];
    db.logQuery = ((tool: string, _q: string, slugs: string[]) => {
      logQueryCalls.push({ tool, slugs });
    }) as never;

    const server = createServer(deps);
    await getTools(server).deep_recall.handler({ query: "测试关键词" });

    const recallLog = logQueryCalls.find(c => c.tool === "recall");
    expect(recallLog).toBeDefined();
    expect(recallLog!.slugs).not.toContain(slug);
  });

  test("query low-score vector hit does not enter query log/learning (#230)", async () => {
    const slug = "entity/low-vec";
    db.rawDb.prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash, tier, mention_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(slug, "entity/person", "低分桩", "entity-low-vec.md", "h1", 3, 0);
    db.rawDb.prepare("INSERT INTO chunks (page_slug, chunk_index, content) VALUES (?, ?, ?)")
      .run(slug, 0, "低分向量测试内容片段");

    // Force a near-zero vector hit so the query gate filters it out.
    // Shape must match HybridSearch.vectorSearch: pageSlug/chunkIndex/content/_distance.
    const lowVecLance = {
      ...createMockLanceDB(),
      search: async () => [{ pageSlug: slug, chunkIndex: 0, content: "低分向量测试内容片段", _distance: 0.998 }],
    };
    const depsWithLance = { ...deps, lance: lowVecLance as never };

    const logQueryCalls: Array<{ tool: string; slugs: string[] }> = [];
    db.logQuery = ((tool: string, _q: string, slugs: string[]) => {
      logQueryCalls.push({ tool, slugs });
    }) as never;

    const server = createServer(depsWithLance);
    const result = await getTools(server).query.handler({ query: "低分向量测试", strategy: "vector" }) as { content: Array<{ text: string }> };
    const payload = JSON.parse(result.content[0].text);

    // Gate must have actually filtered the low-score hit (not an empty search
    // from a malformed mock). Real vectorSearch shape returns the slug with a
    // near-zero score; the gate filters it and records quality_gate.filtered.
    expect(payload.raw?.search_meta?.quality_gate?.filtered).toBeGreaterThan(0);

    const queryLog = logQueryCalls.find(c => c.tool === "query");
    expect(queryLog).toBeDefined();
    expect(queryLog!.slugs).not.toContain(slug);
  });
});

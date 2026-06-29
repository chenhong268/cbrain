import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { createServer, type CBrainDeps } from "../../src/mcp/server.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";

function createMockEmbedding(): EmbeddingProvider {
  return {
    dimensions: 128,
    embed: async (text: string) => ({ embedding: new Array(128).fill(0).map((_, i) => (text.charCodeAt(i % text.length) ?? 0) / 65536), tokenCount: text.length }),
    embedBatch: async (texts: string[]) => texts.map((t) => ({ embedding: new Array(128).fill(0).map((_, i) => (t.charCodeAt(i % t.length) ?? 0) / 65536), tokenCount: t.length })),
  };
}
function createMockLanceDB() {
  return { connect: async () => {}, addChunks: async () => {}, search: async () => [], fullTextSearch: async () => [], deleteByPageSlug: async () => {}, deleteRawChunksByPageSlug: async () => {}, close: async () => {}, createFTSIndex: async () => {} };
}
function getTools(server: unknown) {
  return (server as { _registeredTools: Record<string, { handler: (input: unknown) => Promise<unknown> }> })._registeredTools;
}

describe("deep_recall latency_warning (#250)", () => {
  const testDir = "/tmp/cbrain-test-recall-latency";
  const dbPath = join(testDir, "t.sqlite");
  const vaultPath = join(testDir, "vault");
  let db: CBrainDB;
  let deps: CBrainDeps;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(dbPath);
    deps = { db, embedding: createMockEmbedding(), lance: createMockLanceDB() as never, vaultPath, runtimePath: join(dirname(dbPath), "runtime") };
  });
  afterEach(() => { db.close(); if (existsSync(testDir)) rmSync(testDir, { recursive: true }); });

  function seedAlphaPage() {
    db.rawDb.prepare("INSERT INTO pages (slug, type, title, file_path, content_hash, tier, mention_count) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("entity/alpha", "entity/person", "实体Alpha", "entity-alpha.md", "h1", 1, 5);
    db.rawDb.prepare("INSERT INTO chunks (page_slug, chunk_index, content) VALUES (?, ?, ?)").run("entity/alpha", 0, "实体Alpha 的标记内容");
    db.rawDb.prepare("INSERT INTO chunks_fts (page_slug, content) VALUES (?, ?)").run("entity/alpha", "实体Alpha 的标记内容");
  }

  test("exact title match, FAST → not degraded, latency_warning absent (score=1, no FTS-score dependency)", async () => {
    seedAlphaPage();
    const server = createServer(deps);
    // query == page title → exact-match fast path, score 1.0 (deterministic,
    // independent of FTS scoring).
    const r = await getTools(server).deep_recall.handler({ query: "实体Alpha", include_raw: true }) as { content: Array<{ text: string }> };
    const payload = JSON.parse(r.content[0].text);
    expect(payload.summary?.status).not.toBe("degraded");
    expect(payload.raw?.search_meta?.latency_warning).toBeUndefined();
  });

  test("alias-resolved + slow vector → latency_warning true, not degraded (slow-but-complete)", async () => {
    seedAlphaPage();
    // Seed an alias so the query resolves to entity/alpha via resolveSlugs
    // (exactSlug, promoted to score 1.0 by recall.ts) — WITHOUT being the page
    // title, so searchCore's title-exact fast path does NOT short-circuit and the
    // hybrid search (incl. the slow vector path) actually runs. This verifies
    // "slow but complete / high-confidence" is NOT degraded: even though raw
    // vector RRF is low, exactSlug lifts the result to score 1.0.
    db.rawDb.prepare("INSERT INTO aliases (page_slug, alias) VALUES (?, ?)").run("entity/alpha", "标记别名");
    // Slow vector path returns a delayed hit (low _distance). 2100ms <
    // VECTOR_TIMEOUT_MS 5000, so it completes normally — not a timeout.
    const slowLance = { ...createMockLanceDB(), search: async () => {
      await new Promise((r) => setTimeout(r, 2100));
      return [{ pageSlug: "entity/alpha", chunkIndex: 0, content: "实体Alpha 的标记内容", _distance: 0.05 }];
    }};
    const slowDeps = { ...deps, lance: slowLance as never };
    const server = createServer(slowDeps);
    const r = await getTools(server).deep_recall.handler({ query: "标记别名", include_raw: true }) as { content: Array<{ text: string }> };
    const payload = JSON.parse(r.content[0].text);
    expect(payload.summary?.status).not.toBe("degraded"); // exactSlug promoted to 1.0
    expect(payload.raw?.search_meta?.latency_warning).toBe(true);
    expect(payload.raw?.search_meta?.reason_codes ?? []).not.toContain("low_score");
    expect(payload.raw?.search_meta?.latency_ms ?? 0).toBeGreaterThanOrEqual(2000);
  });

  test("exactSlug at search index 0 → boosted to score 1.0, no low_score (#250 regression)", async () => {
    // Before the fix, an alias hit whose slug sat at searchResults[0] kept its
    // raw (low) RRF score → low_score → degraded. Now existingIdx>=0 boosts to 1.0.
    db.rawDb.prepare("INSERT INTO pages (slug, type, title, file_path, content_hash, tier, mention_count) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("entity/alpha", "entity/person", "实体Alpha", "entity-alpha.md", "h1", 1, 5);
    db.rawDb.prepare("INSERT INTO aliases (page_slug, alias) VALUES (?, ?)").run("entity/alpha", "标记别名");
    // vector returns entity/alpha at rank 0 with a WEAK score (high _distance).
    const lowVecLance = { ...createMockLanceDB(), search: async () => [{ pageSlug: "entity/alpha", chunkIndex: 0, content: "x", _distance: 0.9 }] };
    const lowDeps = { ...deps, lance: lowVecLance as never };
    const server = createServer(lowDeps);
    const r = await getTools(server).deep_recall.handler({ query: "标记别名", include_raw: true }) as { content: Array<{ text: string }> };
    const payload = JSON.parse(r.content[0].text);
    expect(payload.entities[0]?.slug).toBe("entity/alpha");
    expect(payload.entities[0]?.relevance).toBe(1.0); // boosted by exactSlug
    expect(payload.raw?.search_meta?.reason_codes ?? []).not.toContain("low_score");
    expect(payload.summary?.status).not.toBe("degraded");
  });
});

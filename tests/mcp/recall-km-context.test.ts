import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { createServer, type CBrainDeps } from "../../src/mcp/server.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";
import { kmContextApi } from "../../src/core/recall/km-context.js";

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

describe("deep_recall knowledge_map_context (#245)", () => {
  const testDir = "/tmp/cbrain-test-recall-km";
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

  // Seed a mature triad (3 nodes + triangle links, density 1.0 → isCommunityMature
  // true). CRITICAL for test validity: ONLY node A carries the query token; B and C
  // share no token with the query. So a query for `token` returns A as the SOLE
  // primary hit, and KM must surface B/C as same-domain supplemental — proving
  // #245's value rather than an FTS artifact that already returned all three.
  function seedMatureTriad(prefix: string): { slugs: string[]; query: string } {
    const slugs = [`${prefix}/a`, `${prefix}/b`, `${prefix}/c`];
    const token = `${prefix.replace(/\//g, "-")}-alpha`; // FTS-safe unique token (no slash)
    const chunks = [
      `${token} domain anchor`, // A: the only node the query token matches
      `domain sibling beta`,    // B: no token shared with the query
      `domain sibling gamma`,   // C: no token shared with the query
    ];
    for (let i = 0; i < 3; i++) {
      db.rawDb.prepare("INSERT INTO pages (slug, type, title, file_path, content_hash, tier, mention_count) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(slugs[i], "entity/person", slugs[i], `${slugs[i]}.md`, "h1", 2, 3);
      db.rawDb.prepare("INSERT INTO chunks (page_slug, chunk_index, content) VALUES (?, ?, ?)").run(slugs[i], 0, chunks[i]);
      db.rawDb.prepare("INSERT INTO chunks_fts (page_slug, content) VALUES (?, ?)").run(slugs[i], chunks[i]);
    }
    // Fully-connected triangle (3 edges). Columns verified vs sqlite.ts: links
    // gains source_type/confidence/trust_state via migration; KM effective weight
    // = weight * confidence * reliabilityFor(source_type) at knowledge-map.ts:205
    // (manual→1.0). activeFilter (sqlite.ts:1865) admits non-rejected trust_state.
    const pairs = [[0,1],[0,2],[1,2]];
    for (const [i,j] of pairs) {
      db.rawDb.prepare("INSERT INTO links (from_slug, to_slug, relation, weight, confidence, source_type, trust_state) VALUES (?, ?, 'mentions', 1.0, 0.9, 'manual', 'trusted')")
        .run(slugs[i], slugs[j]);
    }
    return { slugs, query: token };
  }

  test("off (default): analyzeKnowledgeMap is never called", async () => {
    const { query } = seedMatureTriad("entity/triad");
    const spy = spyOn(kmContextApi, "computeForRecall");
    const server = createServer(deps);
    await getTools(server).deep_recall.handler({ query });
    expect(spy).toHaveBeenCalledTimes(0);
    spy.mockRestore();
  });

  test("off (default): response has no knowledge_map_context trace", async () => {
    const { query } = seedMatureTriad("entity/triad2");
    const server = createServer(deps);
    const r = await getTools(server).deep_recall.handler({ query, include_raw: true }) as { content: Array<{ text: string }> };
    const payload = JSON.parse(r.content[0].text);
    expect(payload.raw?.knowledge_map_context).toBeUndefined();
    expect(payload.related_context).toBeUndefined();
  });
});

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
    // Human-readable titles (NOT the slug path) — kmRelatedLine surfaces titles
    // to the Agent, so the fixture must mirror real pages where title ≠ slug.
    const titles = ["Entity Alpha", "Entity Beta", "Entity Gamma"];
    for (let i = 0; i < 3; i++) {
      db.rawDb.prepare("INSERT INTO pages (slug, type, title, file_path, content_hash, tier, mention_count) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(slugs[i], "entity/person", titles[i], `${slugs[i]}.md`, "h1", 2, 3);
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

  test("on + include_raw: raw.knowledge_map_context carries matched domains + supplemental", async () => {
    const { slugs, query } = seedMatureTriad("entity/triad3");
    const server = createServer(deps);
    // Query token is on A only → primary = [A]; KM MUST surface B and C as
    // same-domain supplemental. This is #245's core value, not an FTS artifact.
    // strategy: "fts" isolates the primary result to FTS-only hits (A), so the
    // graph channel doesn't pull B/C (A's triangle neighbors) into primary and
    // de-duplicate KM supplemental to empty. KM logic is strategy-independent;
    // this just controls what lands in primarySlugs for a deterministic assertion.
    const r = await getTools(server).deep_recall.handler({ query, strategy: "fts", knowledge_map_context: "on", include_raw: true }) as { content: Array<{ text: string }> };
    const payload = JSON.parse(r.content[0].text);
    const km = payload.raw?.knowledge_map_context;
    expect(km).toBeDefined();
    expect(km.reason).toBe("same_domain_context");
    // Strong: the two non-primary triad members MUST be exactly the supplemental
    // (order-independent — weightedDegree is symmetric across the triangle).
    expect(km.supplemental_slugs).toEqual(expect.arrayContaining([slugs[1], slugs[2]]));
    expect(km.supplemental_slugs.length).toBe(2);
    expect(km.excluded_isolates_count).toBe(0); // no isolates seeded in this triad
  });

  test("on: main result order is unchanged by KM context", async () => {
    const { query } = seedMatureTriad("entity/triad4");
    const server = createServer(deps);
    const without = await getTools(server).deep_recall.handler({ query, include_raw: true }) as { content: Array<{ text: string }> };
    const withKm = await getTools(server).deep_recall.handler({ query, knowledge_map_context: "on", include_raw: true }) as { content: Array<{ text: string }> };
    const orderWithout = JSON.parse(without.content[0].text).entities.map((e: { slug: string }) => e.slug);
    const orderWith = JSON.parse(withKm.content[0].text).entities.map((e: { slug: string }) => e.slug);
    expect(orderWith).toEqual(orderWithout);
  });

  test("on (compact): related_context is natural-language titles, no slug/community_id/weight", async () => {
    const { query } = seedMatureTriad("entity/triad5");
    const server = createServer(deps);
    const r = await getTools(server).deep_recall.handler({ query, strategy: "fts", knowledge_map_context: "on" }) as { content: Array<{ text: string }> };
    const payload = JSON.parse(r.content[0].text);
    // compact default (no include_raw) — no raw audit at all
    expect(payload.raw).toBeUndefined();
    // Strong: mature triad seeded, query hit A → B/C supplemental must exist.
    expect(typeof payload.related_context).toBe("string");
    const rc = payload.related_context as string;
    expect(rc).toMatch(/同知识域还涉及/);
    // privacy: no internal identifiers leak into the Agent-facing field
    expect(rc).not.toMatch(/community-\d|entity\/|slug|weight/i);
  });

  test("on: display mentions same-domain titles and leaks no internals", async () => {
    const { query } = seedMatureTriad("entity/triad6");
    const server = createServer(deps);
    const r = await getTools(server).deep_recall.handler({ query, strategy: "fts", knowledge_map_context: "on" }) as { content: Array<{ text: string }> };
    const payload = JSON.parse(r.content[0].text);
    // Strong: supplemental exists, so the display line MUST be present.
    expect(payload.display).toContain("同知识域还涉及");
    // FORBIDDEN_VISIBLE_TERMS guard (KM internals only; confidence is a pre-existing evidence field).
    // summary is a ToolSummary object (not a string), validated structurally elsewhere.
    expect(payload.display).not.toMatch(/community-\d|source_type|modularity|weightedDegree/i);
  });

  test("on: exact-match order is unchanged (exact match still first)", async () => {
    db.rawDb.prepare("INSERT INTO pages (slug, type, title, file_path, content_hash, tier, mention_count) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("entity/exact-km", "entity/person", "精确域桩", "entity-exact-km.md", "h1", 2, 5);
    const server = createServer(deps);
    const r = await getTools(server).deep_recall.handler({ query: "精确域桩", knowledge_map_context: "on", include_raw: true }) as { content: Array<{ text: string }> };
    const payload = JSON.parse(r.content[0].text);
    const firstSlug = payload.entities[0]?.slug;
    expect(firstSlug).toBe("entity/exact-km");
  });

  test("on: grounded mode is unaffected (no related_context, no display line)", async () => {
    const { query } = seedMatureTriad("entity/triad7");
    const server = createServer(deps);
    const r = await getTools(server).deep_recall.handler({ query, strategy: "fts", knowledge_map_context: "on", grounded: true }) as { content: Array<{ text: string }> };
    const payload = JSON.parse(r.content[0].text);
    expect(payload.related_context).toBeUndefined();
    expect(payload.grounded_answer).toBeDefined();
  });
});

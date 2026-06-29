import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { createServer, type CBrainDeps } from "../../src/mcp/server.js";
import { produceKnowledgeMapDiscoveries } from "../../src/core/knowledge-map-discovery.js";
import type { KnowledgeMapAnalysis, KnowledgeMapNode } from "../../src/core/knowledge-map-types.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";

// ─── Harness (mirrors knowledge-map-envelope.test.ts) ───────────────────────

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
function getTools(server: unknown): Record<string, { handler: (input: unknown) => Promise<unknown> }> {
  return (server as { _registeredTools: Record<string, { handler: (input: unknown) => Promise<unknown> }> })._registeredTools;
}

async function callTool(deps: CBrainDeps, name: string, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const server = createServer(deps);
  const result = (await getTools(server)[name].handler(input)) as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0].text);
}

// ─── Anonymous fixtures ─────────────────────────────────────────────────────

function isolate(slug: string, title: string, mentionCount: number): KnowledgeMapNode {
  return { slug, title, type: "entity/person", mentionCount, weightedDegree: 0, degree: 0 };
}

function analysisWith(opts: { isolates?: KnowledgeMapNode[] }): KnowledgeMapAnalysis {
  return {
    resolution: "default",
    nodes: [],
    health: { nodeCount: 0, edgeCount: 0, isolatedNodes: [], degreeOneNodes: [], connectedComponentCount: 0, largestConnectedComponentSize: 0 },
    communities: [],
    bridgeCandidates: [],
    highMentionIsolates: opts.isolates ?? [],
    weaklyConnectedNodes: [],
  };
}

function seedPage(db: CBrainDB, slug: string, title: string): void {
  db.rawDb
    .prepare("INSERT INTO pages (slug, type, title, file_path, content_hash, tier, mention_count) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(slug, "entity/person", title, `${slug}.md`, "h", 1, 1);
}

const RAW_BANNED = [
  "score", "entity/a", "community_id", "weighted_degree", "density",
  "source_type", "debug", "节点", "桥接", "候选",
];

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("MCP discovery Knowledge Map surface (#244)", () => {
  const testDir = "/tmp/cbrain-test-disco-km";
  const dbPath = join(testDir, "test.sqlite");
  const vaultPath = join(testDir, "vault");
  const runtimePath = join(testDir, "runtime");
  let db: CBrainDB;
  let deps: CBrainDeps;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    mkdirSync(vaultPath, { recursive: true });
    mkdirSync(runtimePath, { recursive: true });
    db = new CBrainDB(dbPath);
    deps = { db, embedding: createMockEmbedding(), lance: createMockLanceDB() as never, vaultPath, runtimePath };
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  test("read_discoveries returns knowledge_map_cards surface", async () => {
    seedPage(db, "entity/a", "实体A");
    produceKnowledgeMapDiscoveries(db, analysisWith({ isolates: [isolate("entity/a", "实体A", 12)] }));
    const data = await callTool(deps, "read_discoveries", {});
    expect(Array.isArray(data.knowledge_map_cards)).toBe(true);
    expect((data.knowledge_map_cards as unknown[]).length).toBe(1);
    expect((data.knowledge_map_cards as Array<{ title: string }>)[0].title).toContain("实体A");
    expect(String(data.display)).toContain("知识结构观察");
  });

  test("read_discoveries normal cards are unaffected by KM surface", async () => {
    seedPage(db, "entity/a", "实体A");
    produceKnowledgeMapDiscoveries(db, analysisWith({ isolates: [isolate("entity/a", "实体A", 12)] }));
    const data = await callTool(deps, "read_discoveries", {});
    const cards = (data.cards ?? []) as Array<{ title: string }>;
    // KM titles never leak into the normal cards array
    expect(cards.every((c) => !c.title.startsWith("孤立记忆") && !c.title.startsWith("跨领域连接"))).toBe(true);
  });

  test("run_discovery surfaces KM candidates without running the analyzer", async () => {
    seedPage(db, "entity/a", "实体A");
    // Seed a KM discovery directly (as Dream would). The graph has no edges, so
    // if run_discovery ran analyzeKnowledgeMap itself it would produce 0 KM rows.
    produceKnowledgeMapDiscoveries(db, analysisWith({ isolates: [isolate("entity/a", "实体A", 12)] }));
    const data = await callTool(deps, "run_discovery", {});
    expect((data.knowledge_map_cards as unknown[]).length).toBe(1);
  });

  test("display and knowledge_map_cards never leak raw terms", async () => {
    seedPage(db, "entity/a", "实体A");
    produceKnowledgeMapDiscoveries(db, analysisWith({ isolates: [isolate("entity/a", "实体A", 12)] }));
    const data = await callTool(deps, "read_discoveries", {});
    const blob = JSON.stringify(data.display) + JSON.stringify(data.knowledge_map_cards);
    for (const b of RAW_BANNED) {
      expect(blob, `${b} leaked`).not.toContain(b);
    }
  });
});

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { createServer, type CBrainDeps } from "../../src/mcp/server.js";
import { buildKnowledgeMapReport } from "../../src/core/knowledge-map/report.js";
import type {
  BridgeCandidate,
  CommunitySummary,
  KnowledgeMapAnalysis,
  KnowledgeMapNode,
} from "../../src/core/knowledge-map/index.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";

// ─── Harness ───────────────────────────────────────────────────────────────

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

function node(slug: string, title: string, overrides: Partial<KnowledgeMapNode> = {}): KnowledgeMapNode {
  return { slug, title, type: "entity/person", mentionCount: 0, weightedDegree: 1, degree: 1, ...overrides };
}

/** Anonymous analysis: one mature + one sparse domain, a bridge, a high-mention isolate, a weak node. */
function makeAnalysis(): KnowledgeMapAnalysis {
  const mature: CommunitySummary = {
    id: "community-1",
    size: 12,
    internalEdgeCount: 20,
    density: 0.6,
    totalInternalWeight: 28.5,
    topCoreNodes: [
      node("entity/a", "实体A", { weightedDegree: 5, degree: 3, communityId: "community-1" }),
      node("entity/b", "实体B", { weightedDegree: 4, degree: 3, communityId: "community-1" }),
      node("entity/c", "实体C", { weightedDegree: 4, degree: 3, communityId: "community-1" }),
    ],
    typeDistribution: { "entity/person": 8, "concept/topic": 4 },
  };
  const sparse: CommunitySummary = {
    id: "community-2",
    size: 3,
    internalEdgeCount: 1,
    density: 0.2,
    totalInternalWeight: 1.5,
    topCoreNodes: [
      node("concept/d", "概念D", { type: "concept/topic", communityId: "community-2" }),
      node("concept/e", "概念E", { type: "concept/topic", communityId: "community-2" }),
    ],
    typeDistribution: { "concept/topic": 2, "entity/person": 1 },
  };
  const bridge: BridgeCandidate = {
    slug: "entity/c",
    title: "实体C",
    type: "entity/person",
    neighborCommunityIds: ["community-1", "community-2"],
  };
  const isolate = node("entity/x", "实体X", { mentionCount: 10, degree: 0, weightedDegree: 0 });
  const weak = node("entity/y", "实体Y", { mentionCount: 2, degree: 1, weightedDegree: 1, communityId: "community-1" });
  return {
    resolution: "default",
    nodes: [isolate, weak],
    health: {
      nodeCount: 17,
      edgeCount: 21,
      isolatedNodes: [isolate],
      degreeOneNodes: [weak],
      connectedComponentCount: 2,
      largestConnectedComponentSize: 7,
    },
    communities: [mature, sparse],
    bridgeCandidates: [bridge],
    highMentionIsolates: [isolate],
    weaklyConnectedNodes: [weak],
  };
}

/** Generate a real #241 report and write it under <outputsDir>/knowledge-map/. */
function writeReport(outputsDir: string, date: string, opts: { debug?: boolean } = {}): void {
  const markdown = buildKnowledgeMapReport(makeAnalysis(), { includeDebug: opts.debug === true }).markdown;
  const dir = join(outputsDir, "knowledge-map");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `knowledge-map-${date}.md`), markdown, "utf-8");
}

async function callTool(deps: CBrainDeps, input: { include_raw?: boolean }): Promise<Record<string, unknown>> {
  const server = createServer(deps);
  const result = (await getTools(server).read_knowledge_map.handler(input)) as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0].text);
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("read_knowledge_map MCP tool (#243)", () => {
  const testDir = "/tmp/cbrain-test-km-envelope";
  const dbPath = join(testDir, "test.sqlite");
  const vaultPath = join(testDir, "vault");
  const runtimePath = join(testDir, "runtime");
  let db: CBrainDB;
  let deps: CBrainDeps;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(runtimePath, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(dbPath);
    deps = { db, embedding: createMockEmbedding(), lance: createMockLanceDB() as never, vaultPath, runtimePath };
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("default returns display/summary/result_summary and no raw key", async () => {
    writeReport(runtimePath, "2026-06-28");
    const data = await callTool(deps, {});
    expect(typeof data.display).toBe("string");
    expect(data.summary).toBeDefined();
    expect((data.summary as { count: number }).count).toBe(1);
    expect(typeof data.result_summary).toBe("string");
    expect(data.raw).toBeUndefined();
  });

  test("reads the newest report by filename date when several exist", async () => {
    writeReport(runtimePath, "2026-06-01");
    writeReport(runtimePath, "2026-06-28");
    const data = await callTool(deps, {});
    expect(data.display).toContain("2026-06-28");
    expect(data.display).not.toContain("（2026-06-01）");
  });

  test("default display includes overview + domains + maturity + bridges + gaps + actions", async () => {
    writeReport(runtimePath, "2026-06-28");
    const data = await callTool(deps, {});
    for (const section of ["主要领域", "子域与边缘小簇", "成熟", "桥接", "孤立", "建议"]) {
      expect(data.display, `${section} missing`).toContain(section);
    }
  });

  test("default output excludes internal terms and strips the debug appendix", async () => {
    // Generate WITH a debug appendix (carries slugs/weightedDegree JSON) to prove stripping.
    writeReport(runtimePath, "2026-06-28", { debug: true });
    const data = await callTool(deps, {});
    const display = String(data.display);
    const message = String((data.summary as { message: string }).message);
    const resultSummary = String(data.result_summary);
    for (const banned of [
      "entity/", "concept/", "source_type", "weightedDegree", "modularity",
      "centrality", "score", "调试附录", "报告已写入", "/tmp", "/Users", "runtime/knowledge-map",
    ]) {
      expect(display, `${banned} leaked into display`).not.toContain(banned);
      expect(message, `${banned} leaked into summary.message`).not.toContain(banned);
      expect(resultSummary, `${banned} leaked into result_summary`).not.toContain(banned);
    }
    // Human titles ARE shown.
    expect(display).toContain("实体A");
  });

  test("include_raw=true returns bounded raw markdown with no absolute path", async () => {
    writeReport(runtimePath, "2026-06-28");
    const data = await callTool(deps, { include_raw: true });
    const raw = data.raw as { report_date: string; filename: string; markdown: string };
    expect(raw.report_date).toBe("2026-06-28");
    expect(raw.filename).toBe("knowledge-map-2026-06-28.md");
    expect(typeof raw.markdown).toBe("string");
    expect(raw.markdown.length).toBeGreaterThan(0);
    // No absolute filesystem path leaks even in raw.
    expect(raw.markdown).not.toContain("/tmp");
    expect(raw.markdown).not.toContain("/Users");
  });

  test("missing report returns a graceful empty envelope with actionable next steps", async () => {
    const data = await callTool(deps, {});
    expect((data.summary as { status: string }).status).toBe("empty");
    expect((data.summary as { next_steps?: string[] }).next_steps?.length).toBeGreaterThan(0);
    expect(String(data.display)).toContain("knowledge-map");
  });

  test("registration: read_knowledge_map is in the server tool list", () => {
    const server = createServer(deps);
    expect(Object.keys(getTools(server))).toContain("read_knowledge_map");
  });
});

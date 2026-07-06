import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { createServer, type CBrainDeps } from "../../src/mcp/server.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";

// Synthetic sentinels only (entity/aN). No real names or paths.

function createMockEmbedding(): EmbeddingProvider {
  return {
    dimensions: 128,
    embed: async (text: string) => ({
      embedding: new Array(128).fill(0).map((_, i) => (text.charCodeAt(i % Math.max(text.length, 1)) ?? 0) / 65536),
      tokenCount: text.length,
    }),
    embedBatch: async (texts: string[]) =>
      texts.map((t) => ({
        embedding: new Array(128).fill(0).map((_, i) => (t.charCodeAt(i % Math.max(t.length, 1)) ?? 0) / 65536),
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

interface ToolResponse { content: Array<{ type: string; text: string }> }

describe("next_actions MCP (#309)", () => {
  const dir = "/tmp/cbrain-test-next-actions";
  const dbPath = join(dir, "test.sqlite");
  const vaultPath = join(dir, "vault");
  let db: CBrainDB;
  let deps: CBrainDeps;

  beforeEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(dbPath);
    deps = {
      db,
      embedding: createMockEmbedding(),
      lance: createMockLanceDB() as any,
      vaultPath,
      runtimePath: join(dirname(dbPath), "runtime"),
    };
  });

  afterEach(() => {
    db.close();
    if (existsSync(dir)) rmSync(dir, { recursive: true });
  });

  test("returns at most 3 items from a discovery-heavy queue; no slug/score leakage", async () => {
    for (let i = 0; i < 6; i++) {
      db.upsertDiscovery("similar_entity", [`entity/a${i}`, `entity/b${i}`], 0.9, undefined, undefined, "high", false, { reason_code: "name_exact" });
    }
    const server = createServer(deps);
    const res = await getTools(server).next_actions.handler({ sources: ["discovery"] }) as ToolResponse;
    const payload = JSON.parse(res.content[0].text);
    expect(payload.items.length).toBeLessThanOrEqual(3);
    expect(payload.display).not.toContain("entity/");
    expect(payload.display).not.toMatch(/\bscore\b/i);
    expect(payload.display).not.toContain("similar_entity");
    expect(payload.summary.shownCount).toBeLessThanOrEqual(3);
  });

  test("never writes DB or filesystem (default sources incl health, no checkAll)", async () => {
    db.upsertDiscovery("similar_entity", ["entity/a", "entity/b"], 0.9, undefined, undefined, "high", false, {});
    const beforePending = db.getUnseenDiscoveries(50).length;
    const server = createServer(deps);
    await getTools(server).next_actions.handler({}); // default sources incl health
    expect(db.getUnseenDiscoveries(50).length).toBe(beforePending);
    expect(db.getDiscoveriesByType("action_review_discovery", 50)).toHaveLength(0);
    expect(db.getDiscoveriesByType("action_health_review", 50)).toHaveLength(0);
    expect(db.getDiscoveriesByType("action_repair_preview", 50)).toHaveLength(0);
    // next_actions must NOT run HealthChecker.checkAll — that would mkdirSync(outputsDir/health).
    const healthDir = join(deps.runtimePath, "health");
    expect(existsSync(healthDir)).toBe(false);
  });

  test("dismissed discovery never surfaces", async () => {
    const { id } = db.upsertDiscovery("similar_entity", ["entity/a", "entity/b"], 0.9, undefined, undefined, "high", false, {});
    db.updateDiscoveryStatus(id, "dismissed");
    const server = createServer(deps);
    const res = await getTools(server).next_actions.handler({ sources: ["discovery"] }) as ToolResponse;
    const payload = JSON.parse(res.content[0].text);
    expect(payload.items).toHaveLength(0);
    expect(payload.display).toContain("无需");
  });

  test("include_raw exposes raw audit object", async () => {
    const server = createServer(deps);
    const res = await getTools(server).next_actions.handler({ sources: ["discovery"], include_raw: true }) as ToolResponse;
    const payload = JSON.parse(res.content[0].text);
    expect(payload.raw).toBeTruthy();
    expect(payload.raw.observeOnlyItems).toBeInstanceOf(Array);
    expect(payload.raw.allItemsRanked).toBeInstanceOf(Array);
  });

  test("health-only stream reads persisted health candidate rows (no checkAll FS write)", async () => {
    db.upsertDiscovery(
      "action_health_review",
      ["health:结构一致性:needs_review:entity/a"],
      0.6,
      undefined,
      undefined,
      "high",
      false,
      {
        display_title: "有一项健康问题需要人工确认",
        display_reason: "这项信号可能影响知识质量。",
        suggested_action: "人工确认后再决定。",
        source: "health",
        repair_group: "needs_review",
        dimension: "结构一致性",
        evidence: [{ source: "health", ref: "health:结构一致性:needs_review:entity/a", kind: "needs_review" }],
      },
    );
    const server = createServer(deps);
    const res = await getTools(server).next_actions.handler({ sources: ["health"] }) as ToolResponse;
    const payload = JSON.parse(res.content[0].text);
    expect(payload.items.length).toBeGreaterThanOrEqual(1);
    expect(payload.items[0].source).toBe("health");
    expect(payload.items[0].severity).toBe("needs_review");
    expect(payload.display).not.toContain("entity/");
    expect(payload.display).not.toMatch(/\bscore\b/i);
    // health path must not run checkAll either
    expect(existsSync(join(deps.runtimePath, "health"))).toBe(false);
  });

  test("hostile persisted display metadata never leaks into display or items[] (#309 review)", async () => {
    // Simulate a corrupted/migrated persisted row carrying hostile display text.
    const hostile = "entity/private-a score=0.99 /Users/example/private SELECT * FROM pages";
    db.upsertDiscovery(
      "action_health_review",
      ["health:结构一致性:needs_review:entity/private-a"],
      0.6,
      undefined,
      undefined,
      "high",
      false,
      {
        display_title: hostile,
        display_reason: hostile,
        suggested_action: hostile,
        source: "health",
        repair_group: "needs_review",
        dimension: "结构一致性",
        evidence: [{ source: "health", ref: "health:结构一致性:needs_review:entity/private-a", kind: "needs_review" }],
      },
    );
    const server = createServer(deps);
    const res = await getTools(server).next_actions.handler({ sources: ["health"] }) as ToolResponse;
    const payload = JSON.parse(res.content[0].text);
    // display must not leak any hostile marker
    expect(payload.display).not.toContain("entity/");
    expect(payload.display).not.toContain("/Users/");
    expect(payload.display).not.toMatch(/\bscore\b/i);
    expect(payload.display).not.toMatch(/SELECT\s+\*\s+FROM/i);
    // structured items[] must fall back to safe copy, not echo hostile text
    for (const it of payload.items) {
      for (const f of [it.title, it.reason, it.suggestion]) {
        expect(f).not.toContain("entity/");
        expect(f).not.toContain("/Users/");
        expect(f).not.toMatch(/\bscore\b/i);
        expect(f).not.toMatch(/SELECT\s+\*\s+FROM/i);
      }
    }
  });

  test("default sources merges health + discovery and stays within cap", async () => {
    for (let i = 0; i < 4; i++) {
      db.upsertDiscovery("similar_entity", [`entity/a${i}`, `entity/b${i}`], 0.9, undefined, undefined, "high", false, {});
    }
    const server = createServer(deps);
    const res = await getTools(server).next_actions.handler({}) as ToolResponse;
    const payload = JSON.parse(res.content[0].text);
    expect(payload.items.length).toBeLessThanOrEqual(3);
    expect(payload.display).not.toContain("entity/");
  });
});

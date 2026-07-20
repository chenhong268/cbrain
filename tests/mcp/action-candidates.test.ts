import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { createServer, type CBrainDeps } from "../../src/mcp/server.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";
import { resolveTrustedVaultBoundary } from "../../src/core/maintenance/misplaced-vault-artifacts.js";

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

describe("MCP action candidates (#267)", () => {
  const testDir = "/tmp/cbrain-test-action-candidates-mcp";
  const dbPath = join(testDir, "test.sqlite");
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

  test("run_action_candidates persists candidate from high discovery", async () => {
    db.upsertDiscovery("similar_entity", ["entity/a", "entity/b"], 0.9, undefined, undefined, "high", false, {
      reason_code: "name_exact",
    });

    const server = createServer(deps);
    const result = await getTools(server).run_action_candidates.handler({ sources: ["discovery"] });
    const payload = JSON.parse((result as { content: { text: string }[] }).content[0].text);

    expect(payload.summary.count).toBe(1);
    expect(payload.candidates).toHaveLength(1);
    expect(payload.display).toContain("可能重复");
    expect(payload.display).not.toContain("entity/");
    expect(payload.display).not.toContain("score");
    expect(db.getDiscoveriesByType("action_review_discovery", 10)).toHaveLength(1);
  });

  test("run_action_candidates defaults to discovery when sources omitted", async () => {
    db.upsertDiscovery("similar_entity", ["entity/a", "entity/b"], 0.9, undefined, undefined, "high", false, {
      reason_code: "name_exact",
    });

    const server = createServer(deps);
    // Note: sources intentionally NOT passed — handler must apply its own default.
    const result = await getTools(server).run_action_candidates.handler({});
    const payload = JSON.parse((result as { content: { text: string }[] }).content[0].text);

    expect(payload.summary.count).toBe(1);
    expect(db.getDiscoveriesByType("action_review_discovery", 10)).toHaveLength(1);
  });

  test("health source receives the explicit trusted boundary from CBrainDeps", async () => {
    mkdirSync(join(testDir, ".obsidian"), { recursive: true });
    writeFileSync(join(testDir, "anonymous-empty.md"), "");
    const vaultBoundary = resolveTrustedVaultBoundary({ configRoot: testDir, vaultPath });
    expect(vaultBoundary).toBeDefined();
    deps.vaultBoundary = vaultBoundary;

    const server = createServer(deps);
    const result = await getTools(server).run_action_candidates.handler({ sources: ["health"], limit: 50 });
    const payload = JSON.parse((result as { content: { text: string }[] }).content[0].text);

    expect(payload.candidates).toContainEqual(expect.objectContaining({
      type: "action_health_review",
      entities: ["health:文件系统卫生:needs_review:filesystem_hygiene.zero_byte_markdown"],
    }));
  });

  test("read_action_candidates returns pending only", async () => {
    const { id } = db.upsertDiscovery("action_review_discovery", ["discovery:a"], 0.9, undefined, undefined, "high", false, {
      display_title: "有一条发现值得复核",
      display_reason: "同类信号已经多次出现，建议确认是否需要采取行动。",
      suggested_action: "打开对应发现，确认是否需要处理。",
      source_type: "gap",
      source_occurrence_count: 3,
      evidence: [{ source: "discovery", ref: "discovery:a", kind: "gap" }],
    });
    db.updateDiscoveryActions(id, [{ type: "review", target: "discovery:a", reason: "复核这条发现。" }]);

    const server = createServer(deps);
    const first = await getTools(server).read_action_candidates.handler({});
    const firstPayload = JSON.parse((first as { content: { text: string }[] }).content[0].text);
    expect(firstPayload.candidates).toHaveLength(1);
    expect(firstPayload.display).toContain("待补全");
    expect(firstPayload.display).not.toContain("打开对应发现");
    expect(firstPayload.candidates[0].occurrenceCount).toBe(3);

    await getTools(server).update_action_candidate_status.handler({ ids: [id], status: "dismissed" });
    const second = await getTools(server).read_action_candidates.handler({});
    expect(JSON.parse((second as { content: { text: string }[] }).content[0].text).candidates).toHaveLength(0);
  });

  test("read_action_candidates reconstructs hostile legacy discovery copy safely", async () => {
    const hostile = "entity/private-a /synthetic/private Bearer synthetic-credential-sentinel";
    db.upsertDiscovery(
      "action_review_discovery",
      ["discovery:synthetic-bridge"],
      0.9,
      undefined,
      undefined,
      "high",
      false,
      {
        source: "discovery",
        source_type: "bridge",
        source_occurrence_count: 1,
        display_title: hostile,
        display_reason: hostile,
        suggested_action: hostile,
      },
    );

    const server = createServer(deps);
    const result = await getTools(server).read_action_candidates.handler({});
    const payload = JSON.parse((result as { content: { text: string }[] }).content[0].text);
    expect(payload.candidates).toHaveLength(1);
    expect(payload.display).toContain("潜在关联");
    expect(payload.display).not.toContain(hostile);
    expect(JSON.stringify(payload.candidates)).not.toContain(hostile);
  });

  test("read_action_candidates keeps historical row-occurrence ordering", async () => {
    const frequentRow = {
      source: "discovery",
      source_type: "bridge",
      source_occurrence_count: 1,
    };
    for (let i = 0; i < 10; i++) {
      db.upsertDiscovery(
        "action_review_discovery",
        ["discovery:frequent-action-row"],
        0.9,
        undefined,
        undefined,
        "high",
        false,
        frequentRow,
      );
    }
    db.upsertDiscovery(
      "action_review_discovery",
      ["discovery:recurrent-source"],
      0.9,
      undefined,
      undefined,
      "high",
      false,
      {
        source: "discovery",
        source_type: "gap",
        source_occurrence_count: 3,
      },
    );

    const server = createServer(deps);
    const result = await getTools(server).read_action_candidates.handler({ limit: 1 });
    const payload = JSON.parse((result as { content: { text: string }[] }).content[0].text);
    expect(payload.candidates).toHaveLength(1);
    expect(payload.candidates[0].displayTitle).toContain("潜在关联");
    expect(payload.candidates[0].occurrenceCount).toBe(1);
  });

  test("default read_discoveries excludes action candidates", async () => {
    db.upsertDiscovery("action_review_discovery", ["discovery:a"], 0.9, undefined, undefined, "high", false, {
      display_title: "有一条发现值得复核",
      display_reason: "同类信号已经多次出现，建议确认是否需要采取行动。",
      suggested_action: "打开对应发现，确认是否需要处理。",
    });

    const server = createServer(deps);
    const result = await getTools(server).read_discoveries.handler({});
    const payload = JSON.parse((result as { content: { text: string }[] }).content[0].text);
    expect(payload.cards).toHaveLength(0);
  });

  test("update_action_candidate_status skips non-action discovery ids", async () => {
    // A plain (non-action) discovery:
    const { id } = db.upsertDiscovery("gap", ["entity/a"], 0.8, undefined, undefined, "high", false, {
      mention_count: 5, link_count: 0,
    });

    const server = createServer(deps);
    const result = await getTools(server).update_action_candidate_status.handler({ ids: [id], status: "dismissed" });
    const payload = JSON.parse((result as { content: { text: string }[] }).content[0].text);

    // Tool reports 0 actually updated (the gap id was skipped).
    expect(payload.updated).toBe(0);
    // The plain discovery is NOT mutated — still pending.
    const full = db.getDiscoveryById(id)!;
    expect(full.status).toBe("pending");
  });
});

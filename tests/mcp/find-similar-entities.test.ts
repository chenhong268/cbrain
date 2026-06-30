import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { registerDiscoveryTools } from "../../src/mcp/tools/discoveries.js";
import type { ToolContext } from "../../src/mcp/context.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Minimal McpServer stub — captures registerTool(name, _def, handler)
 * calls into a Map, matching the real (server as any).registerTool signature.
 */
function makeServer(): {
  server: McpServer;
  tools: Map<string, (args: any) => Promise<any>>;
} {
  const tools = new Map<string, (args: any) => Promise<any>>();
  const server = {
    registerTool(
      name: string,
      _def: any,
      handler: (args: any) => Promise<any>,
    ) {
      tools.set(name, handler);
    },
  } as unknown as McpServer;
  return { server, tools };
}

/**
 * Raw SQL seed — mirrors the pattern from discoveries.test.ts.
 * IMPORTANT: titles must be unique due to idx_pages_title_uniq.
 */
function seedPage(
  db: CBrainDB,
  slug: string,
  title: string,
  type = "entity/company",
  mentionCount = 0,
): void {
  db.rawDb.prepare(
    "INSERT INTO pages (slug, type, title, file_path, content_hash, tier, mention_count, hotness_score, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, 0, datetime('now'), datetime('now'))",
  ).run(slug, type, title, `${slug}.md`, null, mentionCount);
}

describe("MCP find_similar_entities (#246)", () => {
  const testDir = "/tmp/cbrain-test-find-similar";
  const dbPath = join(testDir, "test.sqlite");
  let db: CBrainDB;
  let ctx: ToolContext;
  let tools: Map<string, (args: any) => Promise<any>>;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(dbPath);
    ctx = { db } as unknown as ToolContext;
    const s = makeServer();
    registerDiscoveryTools(s.server, ctx);
    tools = s.tools;
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("tool is registered", () => {
    expect(tools.has("find_similar_entities")).toBe(true);
  });

  test("persists by default and returns candidates with slugs in raw", async () => {
    // Two pages with titles that are edit-distance-close but NOT identical
    // (title must be unique). The detector will catch the edit_distance match.
    seedPage(db, "entity/a", "实体A公司", "entity/company", 3);
    seedPage(db, "entity/b", "实体A工司", "entity/company", 1);

    const res = await tools.get("find_similar_entities")!({ limit: 20 });
    const payload = JSON.parse(res.content[0].text);
    expect(payload.candidates.length).toBeGreaterThanOrEqual(1);
    const c = payload.candidates[0];
    expect(c.slug_a).toBe("entity/a");
    expect(c.slug_b).toBe("entity/b");
    // Display must NOT leak internal fields
    expect(payload.display).toContain("可能重复");
    expect(payload.display).not.toContain("name_score");
    expect(payload.display).not.toContain("entity/a");
    expect(payload.display).not.toContain("entity/b");

    // Default = persist — discovery row should exist
    const rows = db.getDiscoveriesByType("similar_entity", 10);
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  test("dryRun writes nothing to discoveries", async () => {
    seedPage(db, "entity/a", "实体A公司");
    seedPage(db, "entity/b", "实体A工司");

    await tools.get("find_similar_entities")!({ dryRun: true });
    expect(db.getDiscoveriesByType("similar_entity", 10)).toHaveLength(0);
  });

  test("display hides slugs; candidates payload includes recommended_target", async () => {
    seedPage(db, "entity/a", "实体A公司", "entity/company", 5);
    seedPage(db, "entity/b", "实体A工司", "entity/company", 1);

    const res = await tools.get("find_similar_entities")!({});
    const payload = JSON.parse(res.content[0].text);

    // Display uses titles only — no slug leakage
    expect(payload.display).not.toContain("entity/a");
    expect(payload.display).not.toContain("entity/b");

    // Structured payload has slugs AND recommended_target
    const c = payload.candidates[0];
    expect(c.slug_a).toBe("entity/a");
    expect(c.slug_b).toBe("entity/b");
    // entity/a has higher mention_count → it is the recommended merge target
    expect(c.recommended_target).toBe("entity/a");
  });

  test("scope=entity filters to entity/ namespace", async () => {
    seedPage(db, "entity/a", "实体A公司", "entity/company", 3);
    seedPage(db, "entity/b", "实体A工司", "entity/company", 1);
    seedPage(db, "concept/a", "实体A概念甲", "concept/concept", 2);
    seedPage(db, "concept/b", "实体A概念乙", "concept/concept", 1);

    const res = await tools.get("find_similar_entities")!({ scope: "entity" });
    const payload = JSON.parse(res.content[0].text);
    for (const c of payload.candidates) {
      expect(c.slug_a).toMatch(/^entity\//);
    }
  });

  test("no similar entities returns clean empty message", async () => {
    seedPage(db, "entity/a", "太平洋保险");
    seedPage(db, "entity/b", "珠穆朗玛峰");

    const res = await tools.get("find_similar_entities")!({});
    const payload = JSON.parse(res.content[0].text);
    expect(payload.candidates).toHaveLength(0);
    expect(payload.display).toContain("暂无");
  });
});

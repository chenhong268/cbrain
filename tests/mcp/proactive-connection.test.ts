import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { registerDiscoveryTools } from "../../src/mcp/tools/discoveries.js";
import type { ToolContext } from "../../src/mcp/context.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Minimal McpServer stub — captures registerTool(name, _def, handler). */
function makeServer(): { server: McpServer; tools: Map<string, (args: any) => Promise<any>> } {
  const tools = new Map<string, (args: any) => Promise<any>>();
  const server = {
    registerTool(name: string, _def: any, handler: (args: any) => Promise<any>) {
      tools.set(name, handler);
    },
  } as unknown as McpServer;
  return { server, tools };
}

function seedPage(
  db: CBrainDB,
  slug: string,
  title: string,
  type = "entity/person",
  mentionCount = 0,
): void {
  db.rawDb
    .prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash, tier, mention_count, hotness_score, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, 0, datetime('now'), datetime('now'))",
    )
    .run(slug, type, title, `${slug}.md`, null, mentionCount);
}

function seedLink(db: CBrainDB, from: string, to: string): void {
  db.rawDb
    .prepare("INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, 'mentions')")
    .run(from, to);
}

function seedQueryLog(db: CBrainDB, sessionId: string, slugs: string[]): void {
  db.rawDb
    .prepare(
      "INSERT INTO query_log (tool, query, result_slugs, result_count, session_id) VALUES ('recall', 'q', ?, ?, ?)",
    )
    .run(JSON.stringify(slugs), slugs.length, sessionId);
}

function seedQualifyingPair(db: CBrainDB): void {
  seedPage(db, "entity-alpha", "Alpha");
  seedPage(db, "entity-beta", "Beta");
  for (const s of ["project-gamma", "concept-delta"]) {
    seedPage(db, s, s, "entity/project");
    seedLink(db, "entity-alpha", s);
    seedLink(db, "entity-beta", s);
  }
  seedQueryLog(db, "s1", ["entity-alpha", "entity-beta"]);
  seedQueryLog(db, "s2", ["entity-alpha", "entity-beta"]);
}

const testDir = "/tmp/cbrain-test-proactive-mcp";
const dbPath = join(testDir, "test.sqlite");

let db: CBrainDB;
let tools: Map<string, (args: any) => Promise<any>>;

beforeEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  mkdirSync(testDir, { recursive: true });
  db = new CBrainDB(dbPath);
  const ctx = { db } as unknown as ToolContext;
  const s = makeServer();
  registerDiscoveryTools(s.server, ctx);
  tools = s.tools;
});

afterEach(() => {
  db.close();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const res = await tools.get(name)!(args);
  return JSON.parse(res.content[0].text);
}

describe("run_discovery proactive_connection (#310)", () => {
  test("explicit types writes candidates and surfaces them", async () => {
    seedQualifyingPair(db);
    const payload = await call("run_discovery", { types: ["proactive_connection"] });
    expect(db.getDiscoveriesByType("proactive_connection", 10).length).toBe(1);
    expect(payload.cards.length).toBe(1);
    expect(payload.cards[0].title).toContain("可能的连接");
    const blob = JSON.stringify(payload);
    expect(blob).not.toContain("entity-alpha");
    expect(blob).not.toContain("entity-beta");
  });

  test("default run (no types) does NOT surface proactive_connection", async () => {
    seedQualifyingPair(db);
    await call("run_discovery", { types: ["proactive_connection"] }); // seed a pending row
    const payload = await call("run_discovery", {}); // default run
    const blob = JSON.stringify(payload);
    expect(blob).not.toContain("可能的连接");
    expect(blob).not.toContain("proactive_connection");
  });
});

describe("read_discoveries proactive_connection (#310)", () => {
  test("explicit typeFilter returns proactive cards, KM surface suppressed", async () => {
    seedQualifyingPair(db);
    await call("run_discovery", { types: ["proactive_connection"] });
    const payload = await call("read_discoveries", { typeFilter: "proactive_connection" });
    expect(payload.cards.length).toBe(1);
    expect(payload.cards[0].title).toContain("可能的连接");
    expect(payload.knowledge_map_cards ?? []).toEqual([]);
    const blob = JSON.stringify(payload);
    expect(blob).not.toContain("entity-alpha");
  });

  test("default read (no typeFilter) does NOT surface proactive_connection", async () => {
    seedQualifyingPair(db);
    await call("run_discovery", { types: ["proactive_connection"] });
    const payload = await call("read_discoveries", {});
    const blob = JSON.stringify(payload);
    expect(blob).not.toContain("可能的连接");
    expect(blob).not.toContain("proactive_connection");
  });
});

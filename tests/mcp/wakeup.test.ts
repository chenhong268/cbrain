import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { createServer, type CBrainDeps } from "../../src/mcp/server.js";

function createMockEmbedding() {
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
  return (server as any)._registeredTools as Record<string, any>;
}

async function callTool(server: unknown, name: string, args: Record<string, unknown> = {}) {
  const tools = getTools(server);
  const tool = tools[name];
  if (!tool) throw new Error(`Tool ${name} not found`);
  const result = await tool.handler(args);
  return result;
}

const BANNED_IN_DISPLAY = [
  "/tmp", "runtime/", ".json", ".md", "reportPath",
  "entities/", "concepts/", "records/", "insights/", "brain/",
];

describe("MCP wakeup_diff tool", () => {
  const testDir = "/tmp/cbrain-test-mcp-wakeup";
  const dbPath = join(testDir, "test.sqlite");
  const vaultPath = join(testDir, "vault");
  const runtimePath = join(testDir, "runtime");
  let db: CBrainDB;
  let deps: CBrainDeps;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(dbPath);
    deps = {
      db,
      embedding: createMockEmbedding() as any,
      lance: createMockLanceDB() as any,
      vaultPath,
      runtimePath,
    };
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("baseline returns envelope with display/summary/raw", async () => {
    db.rawDb.prepare(
      "INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
    ).run("entities/a", "entity/person", "Alice", "entities_a.md", "h1");

    const server = createServer(deps);
    const result = await callTool(server, "wakeup_diff");

    expect(result.content).toHaveLength(1);
    const data = JSON.parse(result.content[0].text);
    // Envelope shape
    expect(data.display).toBeDefined();
    expect(data.summary).toBeDefined();
    expect(data.raw).toBeDefined();
    // Display content
    expect(data.display).toContain("对照起点");
    expect(data.display).toContain("1 个记忆页");
    // Summary
    expect(data.summary.status).toBe("ok");
    expect(data.summary.count).toBe(0);
    // Raw preserves full result
    expect(data.raw.baselineCreated).toBe(true);
    expect(data.raw.stats).toBeDefined();
    // No banned terms in display
    for (const term of BANNED_IN_DISPLAY) {
      expect(data.display).not.toContain(term);
    }
  });

  test("second run shows changes in envelope", async () => {
    db.rawDb.prepare(
      "INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
    ).run("entities/a", "entity/person", "Alice", "entities_a.md", "h1");

    const server = createServer(deps);
    await callTool(server, "wakeup_diff");

    db.rawDb.prepare(
      "INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
    ).run("entities/b", "entity/person", "Bob", "entities_b.md", "h2");
    db.rawDb.prepare("UPDATE pages SET content_hash = ? WHERE slug = ?").run("h1-new", "entities/a");

    const result = await callTool(server, "wakeup_diff");
    const data = JSON.parse(result.content[0].text);
    // Display shows changes
    expect(data.display).toContain("内容更新");
    expect(data.display).toContain("Alice");
    // Summary has change count
    expect(data.summary.count).toBeGreaterThan(0);
    expect(data.summary.truncated).toBe(false);
    // Raw preserves full structure
    expect(data.raw.changes).toBeDefined();
    expect(data.raw.newItems).toBeDefined();
    // No banned terms in display
    for (const term of BANNED_IN_DISPLAY) {
      expect(data.display).not.toContain(term);
    }
  });

  test("no changes returns envelope with empty summary", async () => {
    db.rawDb.prepare(
      "INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
    ).run("entities/a", "entity/person", "Alice", "entities_a.md", "h1");

    const server = createServer(deps);
    await callTool(server, "wakeup_diff");
    const result = await callTool(server, "wakeup_diff");

    const data = JSON.parse(result.content[0].text);
    expect(data.display).toContain("无认知变化");
    expect(data.summary.count).toBe(0);
    expect(data.summary.message).toContain("无认知变化");
    // Raw still has full structure
    expect(data.raw.stats).toBeDefined();
  });
});

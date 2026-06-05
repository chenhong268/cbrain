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

  test("returns single display text, no raw JSON", async () => {
    db.rawDb.prepare(
      "INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
    ).run("entities/a", "entity/person", "Alice", "entities_a.md", "h1");

    const server = createServer(deps);
    const result = await callTool(server, "wakeup_diff");

    // Exactly one content block
    expect(result.content).toHaveLength(1);
    const text = result.content[0].text;
    // Human-readable display text, not JSON
    expect(text).toContain("已建立基线");
    expect(text).toContain("1 个记忆页");
    // Must not be parseable as JSON (no raw dump)
    expect(() => JSON.parse(text)).toThrow();
    // Channel-safe: no local paths in display
    expect(text).not.toMatch(/\/tmp|runtime|\.json|\.md|reportPath/);
  });

  test("second run display mentions changes without raw JSON", async () => {
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
    expect(result.content).toHaveLength(1);
    const text = result.content[0].text;
    expect(text).toContain("内容更新");
    expect(text).toContain("Alice");
    expect(() => JSON.parse(text)).toThrow();
    expect(text).not.toMatch(/\/tmp|runtime|\.json|\.md|reportPath/);
  });

  test("no changes display says no changes", async () => {
    db.rawDb.prepare(
      "INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
    ).run("entities/a", "entity/person", "Alice", "entities_a.md", "h1");

    const server = createServer(deps);
    await callTool(server, "wakeup_diff");
    const result = await callTool(server, "wakeup_diff");

    expect(result.content).toHaveLength(1);
    const text = result.content[0].text;
    expect(text).toContain("无认知变化");
    expect(() => JSON.parse(text)).toThrow();
    expect(text).not.toMatch(/\/tmp|runtime|\.json|\.md|reportPath/);
  });
});

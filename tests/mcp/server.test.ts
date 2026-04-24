import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { createServer, type CBrainDeps } from "../../src/mcp/server.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";

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
    close: async () => {},
    createFTSIndex: async () => {},
  };
}

function getTools(server: any) {
  return (server as any)._registeredTools as Record<string, any>;
}

describe("MCP Server", () => {
  const testDir = "/tmp/cbrain-test-mcp";
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
      lance: createMockLanceDB() as any,
      vaultPath,
    };
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  describe("createServer", () => {
    test("returns an McpServer instance", () => {
      const server = createServer(deps);
      expect(server).toBeDefined();
      expect(typeof server.connect).toBe("function");
    });

    test("registers all 8 tools", () => {
      const server = createServer(deps);
      const tools = getTools(server);
      const names = Object.keys(tools);
      expect(names.sort()).toEqual([
        "enrich", "get_page", "graph_query", "ingest",
        "list_pages", "query", "status", "sync",
      ]);
    });
  });

  describe("status tool", () => {
    test("returns empty brain stats", async () => {
      const server = createServer(deps);
      const result = await getTools(server).status.handler({});
      const data = JSON.parse(result.content[0].text);
      expect(data.totalPages).toBe(0);
      expect(data.totalLinks).toBe(0);
      expect(data.totalChunks).toBe(0);
    });

    test("returns counts after inserting data", async () => {
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/test", "Test", "test.md", "h1");
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/a", "A", "a.md", "ha");
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/b", "B", "b.md", "hb");
      db.prepare(
        "INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)"
      ).run("entities/a", "entities/b", "mentions");

      const server = createServer(deps);
      const result = await getTools(server).status.handler({});
      const data = JSON.parse(result.content[0].text);
      expect(data.totalPages).toBe(3);
      expect(data.totalLinks).toBe(1);
    });
  });

  describe("get_page tool", () => {
    test("returns page by slug", async () => {
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/zhangsan", "张三", "zhangsan.md", "h1");

      const server = createServer(deps);
      const result = await getTools(server).get_page.handler({ slug: "entities/zhangsan" });
      const data = JSON.parse(result.content[0].text);
      expect(data.slug).toBe("entities/zhangsan");
      expect(data.title).toBe("张三");
      expect(data.type).toBe("entity");
    });

    test("returns error for missing page", async () => {
      const server = createServer(deps);
      const result = await getTools(server).get_page.handler({ slug: "entities/ghost" });
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe("Page not found");
    });
  });

  describe("list_pages tool", () => {
    test("returns empty list", async () => {
      const server = createServer(deps);
      const result = await getTools(server).list_pages.handler({});
      const data = JSON.parse(result.content[0].text);
      expect(data).toEqual([]);
    });

    test("filters by type", async () => {
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/a", "A", "a.md", "h1");
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'concept', ?, ?, ?)`
      ).run("concepts/b", "B", "b.md", "h2");

      const server = createServer(deps);
      const result = await getTools(server).list_pages.handler({ type: "entity" });
      const data = JSON.parse(result.content[0].text);
      expect(data.length).toBe(1);
      expect(data[0].slug).toBe("entities/a");
    });

    test("respects limit and offset", async () => {
      for (let i = 0; i < 5; i++) {
        db.prepare(
          `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
        ).run(`entities/e${i}`, `E${i}`, `e${i}.md`, `h${i}`);
      }

      const server = createServer(deps);
      const result = await getTools(server).list_pages.handler({ limit: 2, offset: 0 });
      const data = JSON.parse(result.content[0].text);
      expect(data.length).toBe(2);
    });
  });

  describe("enrich tool", () => {
    test("enriches single entity", async () => {
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count, tier)
         VALUES (?, 'entity', ?, ?, ?, ?, ?)`
      ).run("entities/a", "A", "a.md", "h1", 5, 3);

      const server = createServer(deps);
      const result = await getTools(server).enrich.handler({ slug: "entities/a" });
      const data = JSON.parse(result.content[0].text);
      expect(data[0].upgraded).toBe(true);
      expect(data[0].newTier).toBe(2);
    });

    test("enriches all entities", async () => {
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count, tier)
         VALUES (?, 'entity', ?, ?, ?, ?, ?)`
      ).run("entities/a", "A", "a.md", "h1", 2, 3);
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count, tier)
         VALUES (?, 'entity', ?, ?, ?, ?, ?)`
      ).run("entities/b", "B", "b.md", "h2", 10, 3);

      const server = createServer(deps);
      const result = await getTools(server).enrich.handler({});
      const data = JSON.parse(result.content[0].text);
      expect(data.length).toBe(2);
    });
  });

  describe("graph_query tool", () => {
    test("traverse from seed", async () => {
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/a", "A", "a.md", "h1");
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/b", "B", "b.md", "h2");
      db.prepare(
        "INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)"
      ).run("entities/a", "entities/b", "mentions");

      const server = createServer(deps);
      const result = await getTools(server).graph_query.handler({ slug: "entities/a" });
      const data = JSON.parse(result.content[0].text);
      expect(data.length).toBe(1);
      expect(data[0].slug).toBe("entities/b");
    });

    test("backlinks mode", async () => {
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/a", "A", "a.md", "h1");
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)`
      ).run("entities/b", "B", "b.md", "h2");
      db.prepare(
        "INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)"
      ).run("entities/b", "entities/a", "mentions");

      const server = createServer(deps);
      const result = await getTools(server).graph_query.handler({ slug: "entities/a", mode: "backlinks" });
      const data = JSON.parse(result.content[0].text);
      expect(data.length).toBe(1);
      expect(data[0].from_slug).toBe("entities/b");
    });

    test("related mode", async () => {
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count) VALUES (?, 'entity', ?, ?, ?, ?)`
      ).run("entities/a", "A", "a.md", "h1", 0);
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count) VALUES (?, 'entity', ?, ?, ?, ?)`
      ).run("entities/b", "B", "b.md", "h2", 5);
      db.prepare(
        "INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)"
      ).run("entities/a", "entities/b", "mentions");

      const server = createServer(deps);
      const result = await getTools(server).graph_query.handler({ slug: "entities/a", mode: "related" });
      const data = JSON.parse(result.content[0].text);
      expect(data.length).toBe(1);
      expect(data[0].slug).toBe("entities/b");
    });
  });

  describe("ingest tool", () => {
    test("ingests text content", async () => {
      const server = createServer(deps);
      const result = await getTools(server).ingest.handler({
        content: "Hello world",
        type: "text",
        title: "Test Page",
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.slug).toBeDefined();
      expect(data.created).toBe(true);
    });
  });

  describe("query tool", () => {
    test("returns results from search", async () => {
      const server = createServer(deps);
      const result = await getTools(server).query.handler({ query: "test" });
      const data = JSON.parse(result.content[0].text);
      expect(Array.isArray(data)).toBe(true);
    });
  });
});

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { createServer, type CBrainDeps } from "../../src/mcp/server.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";
import type { LanceDBManager } from "../../src/storage/lancedb.js";

// Anonymous fixtures only (privacy: no real names in tests).

const stubEmbedding: EmbeddingProvider = {
  embed: async () => ({ embedding: [], tokenCount: 0 }),
  embedBatch: async () => [],
  dimensions: 0,
};

// Structurally-compatible stand-in for the LanceDBManager surface the server touches.
const stubLance = {
  connect: async () => {},
  addChunks: async () => {},
  search: async () => [],
  fullTextSearch: async () => {},
  deleteByPageSlug: async () => {},
  deleteRawChunksByPageSlug: async () => {},
  close: async () => {},
  createFTSIndex: async () => {},
} as unknown as LanceDBManager;

// Mirror of the SDK server's private tool registry (tests only).
interface TestToolRegistry {
  _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }>;
}

function getTools(server: McpServer) {
  const testServer = server as unknown as TestToolRegistry;
  return testServer._registeredTools;
}

interface ToolResponse {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

function seedPage(db: CBrainDB, slug: string, title: string, type: string, vaultPath: string) {
  const filePath = `${slug.replace(/\//g, "_")}.md`;
  const absolutePath = join(vaultPath, filePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `---\ntitle: ${title}\ntype: ${type}\nslug: ${slug}\n---\nbody`);
  db.rawDb
    .prepare("INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)")
    .run(slug, type, title, filePath, `hash-${slug}`);
}

// bun:sqlite returns untyped rows; the query selects one INTEGER column.
function mentionCount(db: CBrainDB, slug: string): number {
  const row = db.rawDb.prepare("SELECT mention_count FROM pages WHERE slug = ?").get(slug) as { mention_count: number } | undefined;
  return row?.mention_count ?? 0;
}

// bun:sqlite returns untyped rows; the query selects one INTEGER count column.
function linkCount(db: CBrainDB, fromSlug: string, toSlug: string, relation?: string): number {
  const sql = relation
    ? "SELECT COUNT(*) AS c FROM links WHERE from_slug = ? AND to_slug = ? AND relation = ?"
    : "SELECT COUNT(*) AS c FROM links WHERE from_slug = ? AND to_slug = ?";
  const args = relation ? [fromSlug, toSlug, relation] : [fromSlug, toSlug];
  const row = db.rawDb.prepare(sql).get(...args) as { c: number };
  return row.c;
}

describe("MCP semantic relation domain/range (#471)", () => {

  let testDir: string;
  let db: CBrainDB;
  let deps: CBrainDeps;

  const PERSON = "brain/entities/person/entity-a";
  const COMPANY = "brain/entities/company/org-c";

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "cbrain-mcp-relation-domain-"));
    const dbPath = join(testDir, "test.sqlite");
    const vaultPath = join(testDir, "vault");
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(dbPath);
    deps = {
      db,
      embedding: stubEmbedding,
      lance: stubLance,
      vaultPath,
      runtimePath: join(dirname(dbPath), "runtime"),
    };
    seedPage(db, PERSON, "实体A", "entity/person", vaultPath);
    seedPage(db, COMPANY, "组织C", "entity/company", vaultPath);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  describe("add_link", () => {
    test("rejects range-incompatible relation with isError and no write", async () => {
      const server = createServer(deps);
      const result = (await getTools(server).add_link.handler({
        from: COMPANY,
        to: PERSON,
        relation: "works_at",
      })) as ToolResponse;

      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text).error).toBeTruthy();
      expect(linkCount(db, COMPANY, PERSON)).toBe(0);
      expect(mentionCount(db, PERSON)).toBe(0);
    });

    test("valid relation with alias still succeeds", async () => {
      const server = createServer(deps);
      const result = (await getTools(server).add_link.handler({
        from: PERSON,
        to: COMPANY,
        relation: "works_at",
      })) as ToolResponse;

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text).success).toBe(true);
      expect(linkCount(db, PERSON, COMPANY, "任职")).toBe(1);
    });

    test("unconstrained relation still links arbitrary pages", async () => {
      const server = createServer(deps);
      const result = (await getTools(server).add_link.handler({
        from: COMPANY,
        to: PERSON,
        relation: "mentions",
      })) as ToolResponse;

      expect(result.isError).toBeUndefined();
      expect(linkCount(db, COMPANY, PERSON, "提及")).toBe(1);
    });
  });

  describe("batch_add_links", () => {
    test("mixed batch: invalid links fail without writes or mention bumps, valid ones succeed", async () => {
      const server = createServer(deps);
      const result = (await getTools(server).batch_add_links.handler({
        links: [
          { from: PERSON, to: COMPANY, relation: "works_at" },
          { from: COMPANY, to: PERSON, relation: "works_at" },
        ],
      })) as ToolResponse;
      const data = JSON.parse(result.content[0].text);

      expect(data.succeeded).toBe(1);
      expect(data.failed).toBe(1);
      expect(data.results[0].success).toBe(true);
      expect(data.results[1].success).toBe(false);
      expect(data.results[1].error).toBeTruthy();

      expect(linkCount(db, PERSON, COMPANY, "任职")).toBe(1);
      expect(linkCount(db, COMPANY, PERSON)).toBe(0);
      // invalid attempt must not increment the target's mention counter
      expect(mentionCount(db, PERSON)).toBe(0);
    });
  });
});

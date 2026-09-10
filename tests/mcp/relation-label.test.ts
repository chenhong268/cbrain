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

// bun:sqlite returns untyped rows; whole-row shape for byte-level comparison.
interface LinkRow {
  from_slug: string;
  to_slug: string;
  relation: string;
  context: string | null;
  source_type: string | null;
  trust_state: string | null;
}

// bun:sqlite returns untyped rows; the query selects one INTEGER column.
function mentionCount(db: CBrainDB, slug: string): number {
  const row = db.rawDb.prepare("SELECT mention_count FROM pages WHERE slug = ?").get(slug) as { mention_count: number } | undefined;
  return row?.mention_count ?? 0;
}

// bun:sqlite returns untyped rows; links rows for whole-row comparison.
function linkRows(db: CBrainDB, from: string, to: string, relation: string): LinkRow[] {
  return db.rawDb
    .prepare("SELECT from_slug, to_slug, relation, context, source_type, trust_state FROM links WHERE from_slug = ? AND to_slug = ? AND relation = ?")
    .all(from, to, relation) as LinkRow[];
}

describe("MCP semantic relation label preservation (#472)", () => {
  let workDir: string;
  let db: CBrainDB;
  let deps: CBrainDeps;

  const PERSON = "brain/entities/person/entity-a";
  const PERSON_B = "brain/entities/person/entity-b";
  const COMPANY = "brain/entities/company/org-c";
  let vaultPath: string;
  let dbPath: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "cbrain-mcp-relation-label-"));
    dbPath = join(workDir, "test.sqlite");
    vaultPath = join(workDir, "vault");
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
    seedPage(db, PERSON_B, "实体B", "entity/person", vaultPath);
    seedPage(db, COMPANY, "组织C", "entity/company", vaultPath);
  });

  afterEach(() => {
    db.close();
    if (existsSync(workDir)) rmSync(workDir, { recursive: true });
  });

  describe("add_link", () => {
    test("fresh alias keeps label prefix; mention increments once on success", async () => {
      const server = createServer(deps);
      const result = (await getTools(server).add_link.handler({
        from: PERSON,
        to: COMPANY,
        relation: "曾任",
        context: "旧的匿名上下文",
      })) as ToolResponse;

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text).success).toBe(true);
      const rows = linkRows(db, PERSON, COMPANY, "任职");
      expect(rows).toHaveLength(1);
      expect(rows[0].context).toBe('[input_label:"曾任"]旧的匿名上下文');
      expect(mentionCount(db, COMPANY)).toBe(1);
    });

    test("alias conflict returns isError; row untouched; no mention bump", async () => {
      db.rawDb
        .prepare("INSERT INTO links (from_slug, to_slug, relation, context, trust_state) VALUES (?, ?, '任职', '旧的', 'trusted')")
        .run(PERSON, COMPANY);
      const before = linkRows(db, PERSON, COMPANY, "任职");

      const server = createServer(deps);
      const result = (await getTools(server).add_link.handler({
        from: PERSON,
        to: COMPANY,
        relation: "现任总经理",
        context: "新的匿名上下文",
      })) as ToolResponse;

      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text).error).toBeTruthy();
      expect(linkRows(db, PERSON, COMPANY, "任职")).toEqual(before);
      expect(mentionCount(db, COMPANY)).toBe(0);
    });
  });

  describe("batch_add_links", () => {
    test("mixed batch: new alias succeeds, conflicting alias fails without mutation", async () => {
      db.rawDb
        .prepare("INSERT INTO links (from_slug, to_slug, relation, context, trust_state) VALUES (?, ?, '任职', '旧的', 'trusted')")
        .run(PERSON, COMPANY);
      const before = linkRows(db, PERSON, COMPANY, "任职");
      const server = createServer(deps);
      const result = (await getTools(server).batch_add_links.handler({
        links: [
          { from: PERSON, to: PERSON_B, relation: "认识", context: "合法兄弟" },
          { from: PERSON, to: COMPANY, relation: "现任总经理", context: "新的" },
        ],
      })) as ToolResponse;
      const data = JSON.parse(result.content[0].text);

      expect(data.succeeded).toBe(1);
      expect(data.failed).toBe(1);
      expect(data.results[1].error).toBeTruthy();
      expect(linkRows(db, PERSON, COMPANY, "任职")).toEqual(before);
      expect(mentionCount(db, PERSON_B)).toBe(1); // only the valid sibling incremented
      expect(mentionCount(db, COMPANY)).toBe(0);
    });
  });
});

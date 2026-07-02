import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
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
  const text = result.content[0].text;
  return { data: JSON.parse(text), isError: result.isError ?? false };
}

// ── Test fixtures ──
const CEO = "entities/ceo";
const VP_ENG = "entities/vp-eng";
const EM1 = "entities/em1";
const DEV_A = "entities/dev-a";

function seedPage(db: CBrainDB, vaultPath: string, slug: string, title: string, type: string): void {
  db.upsertPage({ slug, type, title, filePath: `${slug}.md`, contentHash: `h-${slug}` });
  const dir = join(vaultPath, ...slug.split("/").slice(0, -1));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(vaultPath, `${slug}.md`),
    `---\ntitle: "${title}"\ntype: ${type}\nslug: ${slug}\n---\n`,
  );
}

function seedLink(db: CBrainDB, from: string, to: string): void {
  // #233: deterministic reports_to edges are trusted (upsertActiveReportsTo);
  // insertLink would write 'candidate', which current-fact reads exclude.
  db.upsertActiveReportsTo(from, to, "agent", 0.95);
}

function buildTree(db: CBrainDB, vaultPath: string): void {
  seedPage(db, vaultPath, CEO, "CEO", "entity/person");
  seedPage(db, vaultPath, VP_ENG, "VP-Engineering", "entity/person");
  seedPage(db, vaultPath, EM1, "EM-1", "entity/person");
  seedPage(db, vaultPath, DEV_A, "Dev-A", "entity/person");

  seedLink(db, VP_ENG, CEO);
  seedLink(db, EM1, VP_ENG);
  seedLink(db, DEV_A, EM1);
}

describe("get_org_tree MCP tool", () => {
  const testDir = "/tmp/cbrain-test-mcp-hierarchy";
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
      embedding: createMockEmbedding() as any,
      lance: createMockLanceDB() as any,
      vaultPath,
      runtimePath: join(dirname(dbPath), "runtime"),
    };
    buildTree(db, vaultPath);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("tool is registered", () => {
    const server = createServer(deps);
    const tools = getTools(server);
    expect("get_org_tree" in tools).toBe(true);
  });

  test("slug mode: existing entity returns tree", async () => {
    const server = createServer(deps);
    const { data, isError } = await callTool(server, "get_org_tree", { slug: VP_ENG });
    expect(isError).toBe(false);
    expect(data.seed.slug).toBe(VP_ENG);
    expect(data.seed.title).toBe("VP-Engineering");
    // Upward: CEO
    expect(data.upward).toHaveLength(1);
    expect(data.upward[0].slug).toBe(CEO);
    // Downward: EM-1, Dev-A
    expect(data.downward).toHaveLength(2);
    const downSlugs = data.downward.map((n: any) => n.slug).sort();
    expect(downSlugs).toEqual([DEV_A, EM1].sort());
  });

  test("slug mode: non-existent slug returns error", async () => {
    const server = createServer(deps);
    const { data, isError } = await callTool(server, "get_org_tree", { slug: "entities/ghost" });
    expect(isError).toBe(true);
    expect(data.error).toContain("不存在");
  });

  test("query mode: exact title match resolves and returns tree", async () => {
    const server = createServer(deps);
    const { data, isError } = await callTool(server, "get_org_tree", { query: "CEO" });
    expect(isError).toBe(false);
    expect(data.seed.slug).toBe(CEO);
    expect(data.seed.title).toBe("CEO");
    expect(data.downward.length).toBeGreaterThan(0);
  });

  test("query mode: no match returns error", async () => {
    const server = createServer(deps);
    const { data, isError } = await callTool(server, "get_org_tree", { query: "NonexistentPerson" });
    expect(isError).toBe(true);
    expect(data.error).toContain("未找到");
  });

  test("query mode: multiple candidates returns disambiguation", async () => {
    // Add another entity with "VP" in the name to create ambiguity
    seedPage(db, vaultPath, "entities/vp-other", "VP-Other", "entity/person");

    // "VP" is not an exact title/alias match, so it goes to fuzzy LIKE search
    // which should find both "VP-Engineering" and "VP-Other"
    const server = createServer(deps);
    const { data, isError } = await callTool(server, "get_org_tree", { query: "VP" });

    // MUST return candidates for disambiguation, never silently pick first
    expect(isError).toBe(false);
    expect(data.candidates).toBeDefined();
    expect(data.candidates.length).toBeGreaterThanOrEqual(2);
    expect(data.message).toContain("多个");

    // Must NOT have a tree result
    expect(data.seed).toBeUndefined();
  });

  test("direction=up returns only upward chain", async () => {
    const server = createServer(deps);
    const { data } = await callTool(server, "get_org_tree", { slug: DEV_A, direction: "up" });
    expect(data.upward.length).toBeGreaterThan(0);
    expect(data.downward).toHaveLength(0);
  });

  test("direction=down returns only downward tree", async () => {
    const server = createServer(deps);
    const { data } = await callTool(server, "get_org_tree", { slug: CEO, direction: "down" });
    expect(data.upward).toHaveLength(0);
    expect(data.downward.length).toBeGreaterThan(0);
  });

  test("neither slug nor query returns validation error", async () => {
    const server = createServer(deps);
    const { data, isError } = await callTool(server, "get_org_tree", {});
    expect(isError).toBe(true);
    expect(data.error).toContain("slug");
  });

  test("both slug and query returns validation error", async () => {
    const server = createServer(deps);
    const { data, isError } = await callTool(server, "get_org_tree", { slug: CEO, query: "CEO" });
    expect(isError).toBe(true);
    expect(data.error).toContain("只能提供一个");
  });

  test("depth parameter limits traversal", async () => {
    const server = createServer(deps);
    const { data } = await callTool(server, "get_org_tree", { slug: CEO, direction: "down", depth: 1 });
    // CEO at depth=1 should only return VP-Eng (EM-1 is depth 2)
    expect(data.downward).toHaveLength(1);
    expect(data.downward[0].slug).toBe(VP_ENG);
  });
});

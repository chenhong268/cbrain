import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { createServer, type CBrainDeps } from "../../src/mcp/server.js";

// ── Mocks ─────────────────────────────────────────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────────────

function seedPageWithVault(
  db: CBrainDB,
  slug: string,
  title: string,
  type: string,
  vaultPath: string,
  body: string,
) {
  const filePath = `${slug.replace(/\//g, "_")}.md`;
  const dir = join(vaultPath, filePath.substring(0, filePath.lastIndexOf("/")));
  if (dir !== vaultPath) mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(vaultPath, filePath),
    `---\ntitle: "${title}"\ntype: ${type}\nslug: ${slug}\n---\n${body}`,
  );
  db.rawDb
    .prepare(
      `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(slug, type, title, filePath, "h1");
}

function insertLink(db: CBrainDB, from: string, to: string, relation: string) {
  db.rawDb
    .prepare("INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)")
    .run(from, to, relation);
}

function insertTag(db: CBrainDB, slug: string, tag: string) {
  db.rawDb
    .prepare("INSERT INTO tags (page_slug, tag) VALUES (?, ?)")
    .run(slug, tag);
}


// ── Lifecycle ─────────────────────────────────────────────────────────

const testDir = "/tmp/cbrain-test-merge-wf-mcp";
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
    runtimePath: join(dirname(dbPath), "runtime"),
  };
});

afterEach(() => {
  db.close();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

// ── Tests ─────────────────────────────────────────────────────────────

describe("merge_entities tool", () => {
  test("dry_run returns plan without mutation", async () => {
    seedPageWithVault(db, "entities/shiti-a", "实体A", "entity/person", vaultPath, "实体A的内容");
    seedPageWithVault(db, "entities/shiti-b", "实体B", "entity/person", vaultPath, "实体B的内容");
    insertLink(db, "entities/shiti-a", "entities/shiti-b", "合作");
    insertTag(db, "entities/shiti-a", "人物");

    const server = createServer(deps);
    const pagesBefore = (
      db.rawDb.prepare("SELECT COUNT(*) as c FROM pages").get() as { c: number }
    ).c;

    const result = await getTools(server).merge_entities.handler({
      source: "entities/shiti-a",
      target: "entities/shiti-b",
      dry_run: true,
    });

    const data = JSON.parse(result.content[0].text);

    // No mutation happened
    const pagesAfter = (
      db.rawDb.prepare("SELECT COUNT(*) as c FROM pages").get() as { c: number }
    ).c;
    expect(pagesAfter).toBe(pagesBefore);

    // Plan is correct
    expect(data.mode).toBe("dry_run");
    expect(data.plan).toBeDefined();
    expect(data.plan.source.title).toBe("实体A");
    expect(data.plan.target.title).toBe("实体B");
    expect(data.plan.impact.outgoing_links).toBe(1);
    expect(data.plan.allowed).toBe(true);
  });

  test("execute performs merge and returns verification summary", async () => {
    seedPageWithVault(db, "entities/shiti-a", "实体A", "entity/person", vaultPath, "实体A的内容");
    seedPageWithVault(db, "entities/shiti-b", "实体B", "entity/person", vaultPath, "实体B的内容");
    seedPageWithVault(db, "concepts/zhuti-c", "主题C", "concept/concept", vaultPath, "主题内容");
    insertLink(db, "entities/shiti-a", "concepts/zhuti-c", "关注");
    insertLink(db, "concepts/zhuti-c", "entities/shiti-a", "提及");
    insertTag(db, "entities/shiti-a", "人物");
    insertTag(db, "entities/shiti-b", "科技");

    const server = createServer(deps);
    const result = await getTools(server).merge_entities.handler({
      source: "entities/shiti-a",
      target: "entities/shiti-b",
      dry_run: false,
    });

    const data = JSON.parse(result.content[0].text);

    expect(data.success).toBe(true);
    expect(data.verification).toBeDefined();
    expect(data.verification.source_page_removed).toBe(true);
    expect(data.verification.source_links_clean).toBe(true);
    expect(data.verification.source_file_removed).toBe(true);
    expect(data.verification.all_passed).toBe(true);

    // Source gone from DB
    expect(
      db.rawDb.prepare("SELECT slug FROM pages WHERE slug = ?").get("entities/shiti-a"),
    ).toBeNull();

    // Target still exists
    expect(
      db.rawDb.prepare("SELECT slug FROM pages WHERE slug = ?").get("entities/shiti-b"),
    ).toBeDefined();

    // Source title became alias on target
    const aliases = db.listAliases("entities/shiti-b");
    expect(aliases).toContain("实体A");
  });

  test("blocked merge returns error for cross-layer types", async () => {
    seedPageWithVault(db, "records/record-1", "记录1", "record", vaultPath, "记录内容");
    seedPageWithVault(db, "entities/shiti-b", "实体B", "entity/person", vaultPath, "内容");

    const server = createServer(deps);
    const result = await getTools(server).merge_entities.handler({
      source: "records/record-1",
      target: "entities/shiti-b",
      dry_run: false,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(false);
    expect(data.error).toBeDefined();
  });

  test("blocked merge returns error for non-affine types in dry_run", async () => {
    seedPageWithVault(db, "entities/shiti-a", "实体A", "entity/person", vaultPath, "内容");
    seedPageWithVault(db, "entities/yaopin-f", "药品F", "entity/drug", vaultPath, "药品内容");

    const server = createServer(deps);
    const result = await getTools(server).merge_entities.handler({
      source: "entities/shiti-a",
      target: "entities/yaopin-f",
      dry_run: true,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.mode).toBe("dry_run");
    expect(data.plan).toBeDefined();
    expect(data.plan.allowed).toBe(false);
    expect(data.plan.conflicts.length).toBeGreaterThan(0);
  });

  test("core verifyMerge detects residual source page row after MCP execute", async () => {
    seedPageWithVault(db, "entities/shiti-a", "实体A", "entity/person", vaultPath, "实体A的内容");
    seedPageWithVault(db, "entities/shiti-b", "实体B", "entity/person", vaultPath, "实体B的内容");
    insertLink(db, "entities/shiti-a", "entities/shiti-b", "合作");

    const server = createServer(deps);

    // First merge succeeds — verification should pass
    const result = await getTools(server).merge_entities.handler({
      source: "entities/shiti-a",
      target: "entities/shiti-b",
      dry_run: false,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);
    expect(data.verification.source_page_removed).toBe(true);
    expect(data.verification.all_passed).toBe(true);

    // Artificially create a residual — re-insert source page
    db.rawDb.exec("PRAGMA foreign_keys = OFF");
    db.rawDb
      .prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity/person', ?, 'ghost.md', 'h0')`,
      )
      .run("entities/shiti-a", "实体A-幽灵");
    db.rawDb.exec("PRAGMA foreign_keys = ON");

    // Use MergeWorkflow directly to verify residual detection
    const { MergeWorkflow: MW } = await import("../../src/core/safety/merge-workflow.js");
    const { PageManager: PM } = await import("../../src/core/page.js");
    const pm = new PM(db, vaultPath);
    const wf = new MW(db, pm, vaultPath);

    const sourceVaultPath = join(vaultPath, "entities_shiti-a.md");
    const v = wf.verifyMerge("entities/shiti-a", "entities/shiti-b", sourceVaultPath);
    expect(v.source_page_removed).toBe(false);
    expect(v.all_passed).toBe(false);
    expect(v.failures.length).toBeGreaterThan(0);
  });

  test("dry_run plan does not contain absolute paths or _source_vault_path", async () => {
    seedPageWithVault(db, "entities/shiti-a", "实体A", "entity/person", vaultPath, "实体A的内容");
    seedPageWithVault(db, "entities/shiti-b", "实体B", "entity/person", vaultPath, "实体B的内容");

    const server = createServer(deps);
    const result = await getTools(server).merge_entities.handler({
      source: "entities/shiti-a",
      target: "entities/shiti-b",
      dry_run: true,
    });

    const responseText = result.content[0].text;
    expect(responseText).not.toContain("/tmp/");
    expect(responseText).not.toContain("/Users/");
    expect(responseText).not.toContain("_source_vault_path");

    const data = JSON.parse(responseText);
    expect(data.plan.target_type_retained).toBe(true);
  });

  test("source title becomes alias on target after merge", async () => {
    seedPageWithVault(db, "entities/shiti-a", "实体A", "entity/person", vaultPath, "实体A的内容");
    seedPageWithVault(db, "entities/shiti-b", "实体B", "entity/person", vaultPath, "实体B的内容");

    const server = createServer(deps);
    const result = await getTools(server).merge_entities.handler({
      source: "entities/shiti-a",
      target: "entities/shiti-b",
      dry_run: false,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);

    // Verify alias was created
    const aliases = db.listAliases("entities/shiti-b");
    expect(aliases).toContain("实体A");
  });

  test("source aliases migrate to target after execute", async () => {
    seedPageWithVault(db, "entities/shiti-a", "实体A", "entity/person", vaultPath, "实体A的内容");
    seedPageWithVault(db, "entities/shiti-b", "实体B", "entity/person", vaultPath, "实体B的内容");

    // Add aliases on source
    db.rawDb
      .prepare("INSERT INTO aliases (page_slug, alias) VALUES (?, ?)")
      .run("entities/shiti-a", "别名A");
    db.rawDb
      .prepare("INSERT INTO aliases (page_slug, alias) VALUES (?, ?)")
      .run("entities/shiti-a", "A总");

    const server = createServer(deps);
    const result = await getTools(server).merge_entities.handler({
      source: "entities/shiti-a",
      target: "entities/shiti-b",
      dry_run: false,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);

    // Target should have source title + migrated aliases
    const aliases = db.listAliases("entities/shiti-b");
    expect(aliases).toContain("实体A");
    expect(aliases).toContain("别名A");
    expect(aliases).toContain("A总");
  });

  test("force merge executes despite warnings", async () => {
    seedPageWithVault(db, "entities/gongsi-d", "公司D", "entity/company", vaultPath, "公司内容");
    seedPageWithVault(db, "entities/jigou-e", "机构E", "entity/organization", vaultPath, "机构内容");

    const server = createServer(deps);
    const result = await getTools(server).merge_entities.handler({
      source: "entities/gongsi-d",
      target: "entities/jigou-e",
      dry_run: false,
      strategy: "force",
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);
    // Target type should be retained as entity/organization
    expect(data.type).toBe("entity/organization");
  });

  test("returns error when source not found", async () => {
    seedPageWithVault(db, "entities/shiti-b", "实体B", "entity/person", vaultPath, "内容");

    const server = createServer(deps);
    const result = await getTools(server).merge_entities.handler({
      source: "entities/nonexistent",
      target: "entities/shiti-b",
      dry_run: false,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(false);
    expect(data.error).toBeDefined();
  });
});

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
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
    deleteRawChunksByPageSlug: async () => {},
    deleteL1VectorByPageSlug: async () => {},
    close: async () => {},
    createFTSIndex: async () => {},
  };
}

function getTools(server: any) {
  return (server as any)._registeredTools as Record<string, any>;
}

describe("MCP ingest type classification", () => {
  const testDir = "/tmp/cbrain-test-mcp-ingest";
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

  test("omitted type with legal markdown frontmatter routes as markdown", async () => {
    const server = createServer(deps);
    const tools = getTools(server);
    const handler = tools["ingest"].handler;

    const md = [
      "---",
      "title: 自动分类测试",
      "type: record",
      "tags:",
      "  - 自动标签",
      "---",
      "",
      "这是正文内容。",
    ].join("\n");

    const result = await handler({
      content: md,
      // No type, no title — classifier should detect markdown
      pageType: "record",
      skipNer: true,
    });

    const parsed = JSON.parse(result.content[0].text);
    const raw = parsed.raw;

    expect(raw.slug).toBe("records/自动分类测试");
    expect(raw.created).toBe(true);

    // Display title should be actual page title from frontmatter, not slug basename
    expect(parsed.summary.title).toBe("自动分类测试");

    // Verify vault file exists with correct frontmatter
    const filePath = join(vaultPath, "records/自动分类测试.md");
    expect(existsSync(filePath)).toBe(true);
    const fileContent = readFileSync(filePath, "utf-8");
    expect(fileContent).toContain("title: 自动分类测试");
    expect(fileContent).toContain("tags:");
    expect(fileContent).toContain("自动标签");
    expect(fileContent).toContain("这是正文内容");

    // NO untitled-* files created
    const files = readdirSync(join(vaultPath, "records"));
    expect(files.some(f => f.startsWith("untitled-"))).toBe(false);
  });

  test("omitted type with plain text routes as text", async () => {
    const server = createServer(deps);
    const tools = getTools(server);
    const handler = tools["ingest"].handler;

    const result = await handler({
      content: "这是一段纯文本笔记内容",
      // No type
      title: "纯文本测试",
      pageType: "record",
      skipNer: true,
    });

    const parsed = JSON.parse(result.content[0].text);
    const raw = parsed.raw;
    expect(raw.created).toBe(true);
    expect(raw.slug).toContain("纯文本测试");

    // No untitled-* files
    const recordsDir = join(vaultPath, "records");
    if (existsSync(recordsDir)) {
      const files = readdirSync(recordsDir);
      expect(files.some(f => f.startsWith("untitled-"))).toBe(false);
    }
  });

  test("explicit type=text with markdown content respects caller", async () => {
    const server = createServer(deps);
    const tools = getTools(server);
    const handler = tools["ingest"].handler;

    const md = [
      "---",
      "title: 被强制当文本",
      "---",
      "内容。",
    ].join("\n");

    const result = await handler({
      content: md,
      type: "text",  // Explicit text override
      pageType: "record",
      skipNer: true,
    });

    const parsed = JSON.parse(result.content[0].text);
    const raw = parsed.raw;
    expect(raw.created).toBe(true);

    // Body should contain raw markdown (frontmatter included as text)
    const page = db.getPage(raw.slug);
    expect(page).not.toBeNull();
    // Read the vault file to verify frontmatter is stored as-is
    const vaultFile = readFileSync(join(vaultPath, page!.file_path), "utf-8");
    expect(vaultFile).toContain("---");

    // No untitled-* files
    const recordsDir = join(vaultPath, "records");
    if (existsSync(recordsDir)) {
      const files = readdirSync(recordsDir);
      expect(files.some(f => f.startsWith("untitled-"))).toBe(false);
    }
  });

  test("no title and no semantic content returns error with no side effects", async () => {
    const server = createServer(deps);
    const tools = getTools(server);
    const handler = tools["ingest"].handler;

    const result = await handler({
      content: "!!! ??? --- ...",
      // No type, no title
      pageType: "record",
      skipNer: true,
    });

    // MCP server wraps errors into { error: ... } responses
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("VALIDATION_ERROR");

    // No pages in DB
    const count = db.rawDb.prepare("SELECT COUNT(*) as c FROM pages").get() as { c: number };
    expect(count.c).toBe(0);

    // No vault files
    const recordsDir = join(vaultPath, "records");
    if (existsSync(recordsDir)) {
      expect(readdirSync(recordsDir).length).toBe(0);
    }
  });

  test("markdown without title or semantic body returns error with no untitled file", async () => {
    const server = createServer(deps);
    const tools = getTools(server);
    const handler = tools["ingest"].handler;

    const result = await handler({
      content: "---\ntype: record\ntags:\n  - test\n---\n\n!!!",
      pageType: "record",
      skipNer: true,
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("VALIDATION_ERROR");
    expect(db.rawDb.prepare("SELECT COUNT(*) as c FROM pages").get()).toEqual({ c: 0 });

    const recordsDir = join(vaultPath, "records");
    if (existsSync(recordsDir)) {
      expect(readdirSync(recordsDir).some(file => file.startsWith("untitled-"))).toBe(false);
    }
  });
});

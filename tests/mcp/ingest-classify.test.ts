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

  test("markdown ingest with existing frontmatter slug is a no-op duplicate (#191)", async () => {
    const server = createServer(deps);
    const handler = getTools(server)["ingest"].handler;
    const md = "---\ntitle: 实体A\ntype: entity/person\nslug: brain/entities/person/shiti-a\n---\n\n实体A 简介";

    const first = await handler({ content: md, skipNer: true });
    expect(JSON.parse(first.content[0].text).raw.created).toBe(true);

    const pagesBefore = (db.rawDb.prepare("SELECT COUNT(*) c FROM pages").get() as { c: number }).c;
    const chunksBefore = (db.rawDb.prepare("SELECT COUNT(*) c FROM chunks").get() as { c: number }).c;
    const linksBefore = (db.rawDb.prepare("SELECT COUNT(*) c FROM links").get() as { c: number }).c;

    const second = await handler({ content: md, skipNer: true });
    const s = JSON.parse(second.content[0].text).raw;
    expect(s.outcome).toBe("duplicate");
    expect(s.created).toBe(false);
    expect(s.slug).toBe("brain/entities/person/shiti-a");

    expect((db.rawDb.prepare("SELECT COUNT(*) c FROM pages").get() as { c: number }).c).toBe(pagesBefore);
    expect((db.rawDb.prepare("SELECT COUNT(*) c FROM chunks").get() as { c: number }).c).toBe(chunksBefore);
    expect((db.rawDb.prepare("SELECT COUNT(*) c FROM links").get() as { c: number }).c).toBe(linksBefore);
  });

  test("@file reference (absolute path) is rejected, no page created (#205)", async () => {
    const server = createServer(deps);
    const handler = getTools(server)["ingest"].handler;

    const result = await handler({
      content: "@/tmp/example.md",
      pageType: "record",
      skipNer: true,
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("VALIDATION_ERROR");
    expect(parsed.error).toContain("@file references");
    // Rejection happens before ingest — no page created
    const count = db.rawDb.prepare("SELECT COUNT(*) as c FROM pages").get() as { c: number };
    expect(count.c).toBe(0);
  });

  test("standalone @vault path in prose is rejected, no page created (#205)", async () => {
    const server = createServer(deps);
    const handler = getTools(server)["ingest"].handler;

    const result = await handler({
      content: "见 @vault/records/example.md",
      pageType: "record",
      skipNer: true,
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("@file references");
    const count = db.rawDb.prepare("SELECT COUNT(*) as c FROM pages").get() as { c: number };
    expect(count.c).toBe(0);
  });

  test("email and @username are NOT rejected (#205)", async () => {
    const server = createServer(deps);
    const handler = getTools(server)["ingest"].handler;

    const result = await handler({
      // .net (not .com) so the C8 privacy gate's email scanner [a-z]+@[a-z]+\.(com|cn|org)
      // doesn't flag this fixture; @ is mid-token so FILE_REFERENCE_RE never matches.
      content: "联系 test@example.net 或 @username",
      title: "占位联系记录",
      pageType: "record",
      skipNer: true,
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBeUndefined();
    expect(parsed.raw.created).toBe(true);
  });

  test("@file rejection error does not leak local paths (#205)", async () => {
    const server = createServer(deps);
    const handler = getTools(server)["ingest"].handler;

    const result = await handler({
      content: "@/Users/private-user/secret-vault/notes.md",
      pageType: "record",
      skipNer: true,
    });

    const text = result.content[0].text;
    expect(text).toContain("@file references");
    // Must NOT echo the injected private path back to the caller
    expect(text).not.toContain("/Users/");
    expect(text).not.toContain("private-user");
    expect(text).not.toContain("secret-vault");
  });
});

describe("MCP ingest nerMode option (#252)", () => {
  const testDir = "/tmp/cbrain-test-mcp-ingest-nm";
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

  test("ingest accepts optional nerMode='off' and completes successfully", async () => {
    const server = createServer(deps);
    const handler = getTools(server)["ingest"].handler;

    const result = await handler({
      content: "nerMode 关闭测试内容",
      title: "占位NER模式测试",
      pageType: "record",
      skipNer: true,
      nerMode: "off",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBeUndefined();
    expect(parsed.raw.created).toBe(true);
  });

  test("nerMode omitted works fine (config default applies)", async () => {
    const server = createServer(deps);
    const handler = getTools(server)["ingest"].handler;

    const result = await handler({
      content: "默认模式测试内容",
      title: "占位默认模式",
      pageType: "record",
      skipNer: true,
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBeUndefined();
    expect(parsed.raw.created).toBe(true);
  });
});

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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

function seedPersonFixture(db: CBrainDB, vaultPath: string) {
  const slug = "brain/entities/person/entity-a";
  const file = join(vaultPath, `${slug}.md`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    "---\ntitle: 实体A\ntype: entity/person\nslug: brain/entities/person/entity-a\n---\n\n已有简介",
    "utf-8",
  );
  db.rawDb.prepare(
    "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)",
  ).run(slug, "entity/person", "实体A", `${slug}.md`, "existing-hash");
  return { slug, file };
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
      "这是正文内容，包含足够的事实细节用于验证自动分类和完整性门禁。".repeat(2),
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

  test("markdown classified as record appends to an existing person instead of creating a record (#149)", async () => {
    const person = seedPersonFixture(db, vaultPath);

    const server = createServer(deps);
    const handler = getTools(server)["ingest"].handler;
    const personUpdate = "实体A 已负责主题B，并向组织C汇报；这段匿名资料包含足够的背景信息用于验证人物页面追加路由。".repeat(2);
    const markdown = [
      "---",
      "title: 实体A",
      "type: record",
      "---",
      "",
      personUpdate,
    ].join("\n");

    const result = await handler({
      content: markdown,
      type: "markdown",
      title: "实体A",
      pageType: "record",
      skipNer: true,
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toBeUndefined();
    expect(parsed.raw.slug).toBe(person.slug);
    expect(parsed.raw.outcome).toBe("updated");
    expect(parsed.display).toContain("已更新");
    expect(parsed.summary).toMatchObject({ status: "recorded", title: "实体A" });
    expect(db.getPageByTitle("实体A")?.type).toBe("entity/person");
    expect(db.rawDb.prepare("SELECT COUNT(*) AS c FROM pages WHERE type = 'record'").get()).toEqual({ c: 0 });
    expect(readFileSync(person.file, "utf-8")).toContain(personUpdate);
  });

  test("repeated person markdown is skipped unless allowDuplicate explicitly permits another append (#149)", async () => {
    const person = seedPersonFixture(db, vaultPath);
    const server = createServer(deps);
    const handler = getTools(server)["ingest"].handler;
    const personUpdate = "实体A 新增了主题B的职责说明；这段匿名资料包含足够信息用于验证重复写入门控。".repeat(2);
    const request = {
      content: `---\ntitle: 实体A\ntype: record\n---\n\n${personUpdate}`,
      type: "markdown",
      title: "实体A",
      pageType: "record",
      skipNer: true,
    };

    const first = JSON.parse((await handler(request)).content[0].text);
    expect(first.raw.outcome).toBe("updated");
    const chunksAfterFirst = (db.rawDb.prepare("SELECT COUNT(*) AS c FROM chunks WHERE page_slug = ?").get(person.slug) as { c: number }).c;

    const repeated = JSON.parse((await handler(request)).content[0].text);
    expect(repeated.raw.outcome).toBe("duplicate");
    expect(repeated.summary).toMatchObject({ status: "skipped", title: "实体A" });
    expect(repeated.display).toContain("未重复存入");
    expect(readFileSync(person.file, "utf-8").split(personUpdate).length - 1).toBe(1);
    expect((db.rawDb.prepare("SELECT COUNT(*) AS c FROM chunks WHERE page_slug = ?").get(person.slug) as { c: number }).c).toBe(chunksAfterFirst);

    const forced = JSON.parse((await handler({ ...request, allowDuplicate: true })).content[0].text);
    expect(forced.raw.outcome).toBe("updated");
    expect(readFileSync(person.file, "utf-8").split(personUpdate).length - 1).toBe(2);
  });

  test("markdown source with a distinct title remains a record when it only mentions an existing person (#149)", async () => {
    const person = seedPersonFixture(db, vaultPath);

    const server = createServer(deps);
    const handler = getTools(server)["ingest"].handler;
    const sourceBody = "这是一份关于实体A的访谈记录，包含主题B、组织C与后续安排等独立来源信息。".repeat(2);
    const result = await handler({
      content: `---\ntitle: 实体A访谈记录\ntype: record\n---\n\n${sourceBody}`,
      type: "markdown",
      title: "实体A访谈记录",
      pageType: "record",
      skipNer: true,
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toBeUndefined();
    expect(parsed.raw.slug).toBe("records/实体a访谈记录");
    expect(db.getPage(parsed.raw.slug)?.type).toBe("record");
    expect(readFileSync(person.file, "utf-8")).not.toContain(sourceBody);
  });

  test("omitted type with plain text routes as text", async () => {
    const server = createServer(deps);
    const tools = getTools(server);
    const handler = tools["ingest"].handler;

    const result = await handler({
      content: "这是一段足够完整的纯文本研究笔记内容，包含事实细节并用于验证自动分类路径。".repeat(2),
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
      "这是一段足够完整的正文内容，用于验证显式 text 类型仍保留原始 markdown。".repeat(2),
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

  test("record placeholder content is rejected before persistence (#376)", async () => {
    const server = createServer(deps);
    const result = await getTools(server)["ingest"].handler({
      content: "https://example.invalid/source\n待补充",
      title: "占位记录",
      pageType: "record",
      skipNer: true,
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toMatch(/VALIDATION_ERROR.*record/i);
    expect(db.rawDb.prepare("SELECT COUNT(*) as c FROM pages").get()).toEqual({ c: 0 });
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
      content: "联系 test@example.net 或 @username；这是一条包含足够上下文的完整联系记录，用于验证地址不会被误判为文件引用。",
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
      content: "nerMode 关闭测试内容，包含足够的上下文以验证关闭模式仍能完成正常记录写入。".repeat(2),
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
      content: "默认模式测试内容，包含足够的上下文以验证默认配置下的记录写入路径。".repeat(2),
      title: "占位默认模式",
      pageType: "record",
      skipNer: true,
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBeUndefined();
    expect(parsed.raw.created).toBe(true);
  });
});

describe("MCP ingest personal tag (#236)", () => {
  const testDir = "/tmp/cbrain-test-mcp-personal";
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

  test("MCP ingest of clear personal content writes personal tag", async () => {
    const server = createServer(deps);
    const tools = getTools(server);
    const handler = tools["ingest"].handler;

    const result = await handler({
      content: "我的偏好 是 偏好X；这是一条包含完整上下文的个人记录，用于验证 personal 标签写入。".repeat(2),
      type: "text",
      title: "偏好X 笔记",
      skipNer: true,
    });
    const parsed = JSON.parse(result.content[0].text);
    const slug = parsed.raw.slug;

    const tags = db.rawDb.prepare("SELECT tag FROM tags WHERE page_slug = ?").all(slug) as any[];
    expect(tags.map(t => t.tag)).toContain("personal");
  });

  test("MCP ingest of business content does NOT write personal tag", async () => {
    const server = createServer(deps);
    const tools = getTools(server);
    const handler = tools["ingest"].handler;

    const result = await handler({
      content: "项目Y 的 架构 设计；这是一条包含完整上下文的业务记录，用于验证不会错误写入 personal 标签。".repeat(2),
      type: "text",
      title: "项目Y 设计",
      skipNer: true,
    });
    const parsed = JSON.parse(result.content[0].text);
    const slug = parsed.raw.slug;

    const tags = db.rawDb.prepare("SELECT tag FROM tags WHERE page_slug = ?").all(slug) as any[];
    expect(tags.map(t => t.tag)).not.toContain("personal");
  });
});

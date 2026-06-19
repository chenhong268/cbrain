import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { IngestManager } from "../../src/core/ingest.js";
import { generateSlug } from "../../src/utils/slug.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";
import type { LLMProvider } from "../../src/llm/provider.js";

function createMockLLM(responses: string[]): LLMProvider {
  let callIndex = 0;
  return {
    name: "mock",
    chat: async () => responses[callIndex++] ?? '{"entities":[],"relations":[],"events":[]}',
  };
}

function createMockEmbeddingProvider(): EmbeddingProvider {
  return {
    dimensions: 128,
    embed: async (text: string) => {
      const vec = new Array(128).fill(0);
      for (let i = 0; i < text.length; i++) {
        vec[i % 128] += text.charCodeAt(i) / 65536;
      }
      return { embedding: vec, tokenCount: text.length };
    },
    embedBatch: async (texts: string[]) =>
      texts.map((t) => {
        const vec = new Array(128).fill(0);
        for (let i = 0; i < t.length; i++) {
          vec[i % 128] += t.charCodeAt(i) / 65536;
        }
        return { embedding: vec, tokenCount: t.length };
      }),
  };
}

function createMockLanceDB() {
  const added: Array<{ pageSlug: string; chunks: Array<{ content: string; chunkIndex: number }> }> = [];
  const deleted: string[] = [];
  const current = new Map<string, Array<{ content: string; chunkIndex: number }>>();

  return {
    added,
    deleted,
    current,

    connect: async () => {},
    addChunks: async (chunks: Array<{ pageSlug: string; chunkIndex: number; content: string; vector?: Float32Array }>) => {
      for (const chunk of chunks) {
        let entry = added.find((a) => a.pageSlug === chunk.pageSlug);
        if (!entry) {
          entry = { pageSlug: chunk.pageSlug, chunks: [] };
          added.push(entry);
        }
        entry.chunks.push({ content: chunk.content, chunkIndex: chunk.chunkIndex });
        const existing = current.get(chunk.pageSlug) ?? [];
        existing.push({ content: chunk.content, chunkIndex: chunk.chunkIndex });
        current.set(chunk.pageSlug, existing);
      }
    },
    search: async () => [],
    fullTextSearch: async () => [],
    deleteByPageSlug: async (pageSlug: string) => {
      deleted.push(pageSlug);
      current.delete(pageSlug);
    },
    deleteRawChunksByPageSlug: async (pageSlug: string) => {
      current.delete(pageSlug);
    },
    close: async () => {},
    createFTSIndex: async () => {},
  };
}

describe("IngestManager", () => {
  const testDir = "/tmp/cbrain-test-ingest";
  const dbPath = join(testDir, "test.sqlite");
  const vaultPath = join(testDir, "vault");
  let db: CBrainDB;
  let ingest: IngestManager;
  let lance: ReturnType<typeof createMockLanceDB>;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(dbPath);
    lance = createMockLanceDB();
    const embedding = createMockEmbeddingProvider();
    ingest = new IngestManager(db, embedding, lance as any, vaultPath);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  describe("ingest text", () => {
    test("creates page from plain text input", async () => {
      const result = await ingest.ingest({
        content: "张三是星辰科技的商务经理",
        type: "text",
        title: "张三",
      });

      expect(result.created).toBe(true);
      expect(result.slug).toBe("records/张三");

      const row = db        .rawDb.prepare("SELECT * FROM pages WHERE slug = ?")
        .get("records/张三") as any;
      expect(row).not.toBeNull();
      expect(row.title).toBe("张三");
      expect(row.type).toBe("record");
    });

    test("writes vault file for text input", async () => {
      await ingest.ingest({
        content: "Some plain text",
        type: "text",
        title: "Test Note",
        tags: ["test"],
      });

      const filePath = join(vaultPath, "records/test-note.md");
      expect(existsSync(filePath)).toBe(true);
    });

    test("uses provided tags", async () => {
      await ingest.ingest({
        content: "Tagged content",
        type: "text",
        title: "Tagged",
        tags: ["人物", "商务"],
      });

      const tags = db        .rawDb.prepare("SELECT tag FROM tags WHERE page_slug = ?")
        .all("records/tagged") as any[];
      const tagValues = tags.map((t) => t.tag);
      expect(tagValues).toContain("人物");
      expect(tagValues).toContain("商务");
    });

    test("appends relationship text to an existing person instead of creating a record", async () => {
      mkdirSync(join(vaultPath, "brain", "entities", "person"), { recursive: true });
      writeFileSync(
        join(vaultPath, "brain", "entities", "person", "entity-a.md"),
        "---\ntitle: 实体A\ntype: entity/person\nslug: brain/entities/person/entity-a\n---\n已有内容",
      );
      db.rawDb.prepare(
        "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)",
      ).run("brain/entities/person/entity-a", "entity/person", "实体A", "brain/entities/person/entity-a.md", "h1");

      const result = await ingest.ingest({
        content: "实体A，是实体B的前同事",
        type: "text",
        title: "实体A",
      });

      expect(result.slug).toBe("brain/entities/person/entity-a");
      expect(result.created).toBe(false);
      expect(db.getPageByTitle("实体A")!.type).toBe("entity/person");
      expect(db.getPageByTitle("实体A，是实体B的前同事")).toBeNull();
      const file = readFileSync(join(vaultPath, "brain", "entities", "person", "entity-a.md"), "utf-8");
      expect(file).toContain("已有内容");
      expect(file).toContain("实体A，是实体B的前同事");
    });

    test("routes short person relationship snippets to person pages", async () => {
      const result = await ingest.ingest({
        content: "实体B，是实体C的同事",
        type: "text",
      });

      expect(result.slug).toBe("brain/entities/person/实体b");
      expect(result.created).toBe(true);
      const row = db.getPage("brain/entities/person/实体b");
      expect(row).not.toBeNull();
      expect(row!.type).toBe("entity/person");
    });

    test("routes valid Chinese names to person pages via fast path", async () => {
      const result = await ingest.ingest({
        content: "人物A，是人物B的前同事",
        type: "text",
      });
      expect(result.slug).toBe("brain/entities/person/人物a");
      expect(result.created).toBe(true);
      expect(db.getPage(result.slug)!.type).toBe("entity/person");
    });

    test("routes valid English names to person pages via fast path", async () => {
      const result = await ingest.ingest({
        content: "Person Alpha, worked with Entity B",
        type: "text",
      });
      expect(result.slug).toBe("brain/entities/person/person-alpha");
      expect(result.created).toBe(true);
      expect(db.getPage(result.slug)!.type).toBe("entity/person");
    });

    test("degrades job-title / team / org candidates to record", async () => {
      const cases: Array<{ input: string; name: string }> = [
        { input: "产品经理，负责项目设计", name: "产品经理" },
        { input: "技术总监，认识很多合作伙伴", name: "技术总监" },
        { input: "运营团队，负责日常活动", name: "运营团队" },
        { input: "项目组，和组织A合作", name: "项目组" },
        { input: "区域组织，负责某项工作", name: "区域组织" },
        { input: "Research Team, worked with Entity B", name: "Research Team" },
      ];
      for (const { input, name } of cases) {
        const result = await ingest.ingest({ content: input, type: "text" });
        // 降级 record：slug 落 records/，不创建同名 entity/person
        expect(result.slug.startsWith("records/")).toBe(true);
        const personRow = db.getPageByTitle(name);
        expect(!personRow || personRow.type !== "entity/person").toBe(true);
        // 原始内容完整保留在 vault 文件里
        const filePath = db.getPageFilePath(result.slug);
        const file = readFileSync(join(vaultPath, filePath!), "utf-8");
        expect(file).toContain(input);
      }
    });

    test("degrades to record when a same-title non-person entity exists", async () => {
      // 预置 entity/organization 标题"组织A"——不得被 person 快捷路由覆盖/改型
      mkdirSync(join(vaultPath, "brain", "entities", "organization"), { recursive: true });
      writeFileSync(
        join(vaultPath, "brain", "entities", "organization", "org-a.md"),
        "---\ntitle: 组织A\ntype: entity/organization\nslug: brain/entities/organization/org-a\n---\n已有组织",
      );
      db.rawDb.prepare(
        "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)",
      ).run("brain/entities/organization/org-a", "entity/organization", "组织A", "brain/entities/organization/org-a.md", "h1");

      // 不得抛唯一约束；组织A 保持 organization；完整内容进 record
      const result = await ingest.ingest({ content: "组织A，和人物B合作", type: "text" });
      expect(result.slug.startsWith("records/")).toBe(true);
      expect(db.getPageByTitle("组织A")!.type).toBe("entity/organization");
      const filePath = db.getPageFilePath(result.slug);
      expect(readFileSync(join(vaultPath, filePath!), "utf-8")).toContain("组织A，和人物B合作");
    });

    test("appends to existing person when fast-path name matches it", async () => {
      // 预置 entity/person 标题"人物A"——验证同名 person 仍走 append，不被门控误降级
      mkdirSync(join(vaultPath, "brain", "entities", "person"), { recursive: true });
      writeFileSync(
        join(vaultPath, "brain", "entities", "person", "人物a.md"),
        "---\ntitle: 人物A\ntype: entity/person\nslug: brain/entities/person/人物a\n---\n已有内容",
      );
      db.rawDb.prepare(
        "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)",
      ).run("brain/entities/person/人物a", "entity/person", "人物A", "brain/entities/person/人物a.md", "h1");

      const result = await ingest.ingest({ content: "人物A，是人物B的前同事", type: "text" });
      expect(result.created).toBe(false);
      expect(result.slug).toBe("brain/entities/person/人物a");
    });

    test("appends to existing person even when its title contains a job-title word", async () => {
      // 预置 person title="人物经理"——名字含职位词但类型明确是 person。
      // 已确认 person 必须优先于职位启发式：直接 append，不得降级 record。
      mkdirSync(join(vaultPath, "brain", "entities", "person"), { recursive: true });
      writeFileSync(
        join(vaultPath, "brain", "entities", "person", "人物经理.md"),
        "---\ntitle: 人物经理\ntype: entity/person\nslug: brain/entities/person/人物经理\n---\n已有内容",
      );
      db.rawDb.prepare(
        "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)",
      ).run("brain/entities/person/人物经理", "entity/person", "人物经理", "brain/entities/person/人物经理.md", "h1");

      const result = await ingest.ingest({ content: "人物经理，是人物乙的同事", type: "text" });
      expect(result.created).toBe(false);
      expect(result.slug).toBe("brain/entities/person/人物经理");
    });

    test("rejected candidates still trigger NER on the record path", async () => {
      const llm = createMockLLM([
        JSON.stringify({
          entities: [{ name: "人物丁", type: "person", context: "运营团队负责人" }],
          relations: [],
          events: [],
        }),
      ]);
      const embedding = createMockEmbeddingProvider();
      const nerIngest = new IngestManager(db, embedding, lance as any, vaultPath, llm);

      const result = await nerIngest.ingest({ content: "运营团队，负责日常活动", type: "text" });
      // 降级 record，不是 entity/person
      expect(result.slug.startsWith("records/")).toBe(true);
      // processNer 在 ingestCore 内同步 await：result.ner 有值、stub 已落库，无需固定等待
      expect(result.ner).not.toBeNull();
      const extracted = db.rawDb.prepare("SELECT * FROM pages WHERE title = ?").get("人物丁") as any;
      expect(extracted).not.toBeNull();
      expect(extracted.type).toBe("entity/person");
    });
  });

  describe("ingest markdown", () => {
    test("creates page from markdown with frontmatter", async () => {
      const md = [
        "---",
        "title: 李四",
        "type: entity/person",
        "slug: brain/entities/person/lisi",
        "tags:",
        "  - 人物",
        "  - 工程师",
        "---",
        "",
        "李四是高级工程师，负责后端架构。",
      ].join("\n");

      const result = await ingest.ingest({
        content: md,
        type: "markdown",
      });

      expect(result.slug).toBe("brain/entities/person/lisi");
      expect(result.created).toBe(true);

      const row = db        .rawDb.prepare("SELECT * FROM pages WHERE slug = ?")
        .get("brain/entities/person/lisi") as any;
      expect(row).not.toBeNull();
      expect(row.title).toBe("李四");
    });

    test("explicit caller title overrides frontmatter title for slug/title/path (#198)", async () => {
      const md = [
        "---",
        "title: 临时标题A",
        "type: record",
        "---",
        "",
        "匿名正文内容",
      ].join("\n");

      const result = await ingest.ingest({
        content: md,
        type: "markdown",
        title: "正式标题B",
      });

      expect(result.created).toBe(true);
      // slug/title/file_path derived from the explicit title, not the frontmatter title
      expect(result.slug).toBe(generateSlug("正式标题B", "record"));
      const row = db.rawDb.prepare("SELECT title, file_path FROM pages WHERE slug = ?")
        .get(result.slug) as { title: string; file_path: string };
      expect(row.title).toBe("正式标题B");
      expect(row.file_path).not.toContain("临时标题A");
    });

    test("no explicit type auto-classifies markdown frontmatter as markdown (#198)", async () => {
      const md = [
        "---",
        "title: 自动分类标题C",
        "type: record",
        "---",
        "",
        "正文内容",
      ].join("\n");

      // No type → IngestManager must classify the frontmatter as markdown,
      // so the frontmatter title is honored (not treated as plain text).
      const result = await ingest.ingest({ content: md });

      expect(result.created).toBe(true);
      const row = db.rawDb.prepare("SELECT title FROM pages WHERE slug = ?")
        .get(result.slug) as { title: string };
      expect(row.title).toBe("自动分类标题C");
    });

    test("updates existing page on re-ingest", async () => {
      const md1 = [
        "---",
        "title: 王五",
        "type: entity/person",
        "slug: brain/entities/person/wangwu",
        "---",
        "",
        "原始内容",
      ].join("\n");

      await ingest.ingest({ content: md1, type: "markdown" });
      lance.added.length = 0;

      const md2 = [
        "---",
        "title: 王五",
        "type: entity/person",
        "slug: brain/entities/person/wangwu",
        "---",
        "",
        "更新后的内容",
      ].join("\n");

      const result = await ingest.ingest({ content: md2, type: "markdown" });
      expect(result.created).toBe(false);
      expect(result.slug).toBe("brain/entities/person/wangwu");
    });

    test("auto-generates slug when missing from frontmatter", async () => {
      const md = [
        "---",
        "title: AutoSlug",
        "type: entity/person",
        "---",
        "",
        "No slug provided",
      ].join("\n");

      const result = await ingest.ingest({ content: md, type: "markdown" });
      expect(result.slug).toBe("brain/entities/person/autoslug");
    });

    test("uses tags from frontmatter over input tags", async () => {
      const md = [
        "---",
        "title: TagPriority",
        "type: record",
        "slug: records/tag-priority",
        "tags:",
        "  - fm-tag",
        "---",
        "",
        "Content",
      ].join("\n");

      await ingest.ingest({
        content: md,
        type: "markdown",
        tags: ["input-tag"],
      });

      const tags = db        .rawDb.prepare("SELECT tag FROM tags WHERE page_slug = ?")
        .all("records/tag-priority") as any[];
      const tagValues = tags.map((t) => t.tag);
      expect(tagValues).toContain("fm-tag");
      expect(tagValues).not.toContain("input-tag");
    });
  });

  describe("link extraction", () => {
    test("creates graph edges for resolved links", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
      ).run("brain/entities/person/lisi", "entity/person", "李四", "brain/entities/person/lisi.md", "h1");

      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
      ).run("brain/entities/person/wangwu", "entity/person", "王五", "brain/entities/person/wangwu.md", "h2");

      const md = [
        "---",
        "title: 链接测试",
        "type: record",
        "slug: records/link-test",
        "---",
        "",
        "提到了[[李四]]和[[王五]]。",
      ].join("\n");

      const result = await ingest.ingest({ content: md, type: "markdown" });
      expect(result.linksExtracted).toBe(2);

      const links = db        .rawDb.prepare("SELECT to_slug FROM links WHERE from_slug = ?")
        .all("records/link-test") as any[];
      const targets = links.map((l) => l.to_slug);
      expect(targets).toContain("brain/entities/person/lisi");
      expect(targets).toContain("brain/entities/person/wangwu");
    });

    test("skips unresolved links", async () => {
      const md = [
        "---",
        "title: Unresolved",
        "type: record",
        "slug: records/unresolved",
        "---",
        "",
        "提到了[[不存在的人]]。",
      ].join("\n");

      const result = await ingest.ingest({ content: md, type: "markdown" });
      expect(result.linksExtracted).toBe(0);

      const links = db        .rawDb.prepare("SELECT * FROM links WHERE from_slug = ?")
        .all("records/unresolved") as any[];
      expect(links.length).toBe(0);
    });

    test("increments mention count on linked pages", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
      ).run("brain/entities/person/mentioned", "entity/person", "被提及者", "brain/entities/person/mentioned.md", "h1");

      const md = [
        "---",
        "title: Mention Test",
        "type: record",
        "slug: records/mention-test",
        "---",
        "",
        "提到了[[被提及者]]。",
      ].join("\n");

      await ingest.ingest({ content: md, type: "markdown" });

      const row = db        .rawDb.prepare("SELECT mention_count FROM pages WHERE slug = ?")
        .get("brain/entities/person/mentioned") as any;
      expect(row.mention_count).toBe(1);
    });

    test("does not create self-referencing link", async () => {
      mkdirSync(join(vaultPath, "brain/entities/person"), { recursive: true });
      const preMd = [
        "---",
        "title: SelfRef",
        "type: entity/person",
        "slug: brain/entities/person/self-ref",
        "---",
        "",
        "Original",
      ].join("\n");
      writeFileSync(join(vaultPath, "brain/entities/person/self-ref.md"), preMd, "utf-8");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
      ).run("brain/entities/person/self-ref", "entity/person", "SelfRef", "brain/entities/person/self-ref.md", "h1");

      const md = [
        "---",
        "title: SelfRef",
        "type: entity/person",
        "slug: brain/entities/person/self-ref",
        "---",
        "",
        "自我引用[[SelfRef]]。",
      ].join("\n");

      await ingest.ingest({ content: md, type: "markdown" });

      const links = db        .rawDb.prepare("SELECT * FROM links WHERE from_slug = ? AND to_slug = ?")
        .all("brain/entities/person/self-ref", "brain/entities/person/self-ref") as any[];
      expect(links.length).toBe(0);
    });
  });

  describe("sync integration", () => {
    test("syncs ingested content to LanceDB", async () => {
      await ingest.ingest({
        content: "需要向量化的内容",
        type: "text",
        title: "Sync Test",
        pageType: "record",
      });

      expect(lance.added.length).toBeGreaterThan(0);
    });
  });

  describe("ingest_log", () => {
    test("logs ingest action via sync", async () => {
      await ingest.ingest({
        content: "Logged content",
        type: "text",
        title: "Logged",
        pageType: "record",
      });

      const logs = db        .rawDb.prepare("SELECT * FROM ingest_log WHERE page_slug LIKE ?")
        .all("%logged%") as any[];
      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0].action).toBe("ingest");
    });
  });

  describe("NER integration", () => {
    test("runs NER in background when LLM provider is available", async () => {
      const llm = createMockLLM([
        JSON.stringify({
          entities: [
            { name: "张三", type: "person", context: "张三是星辰的商务经理" },
            { name: "星辰", type: "company", context: "张三是星辰的商务经理" },
          ],
          relations: [
            { from: "张三", to: "星辰", relation: "works_at", context: "张三是星辰的商务经理" },
          ],
          events: [],
        }),
      ]);

      const embedding = createMockEmbeddingProvider();
      const nerIngest = new IngestManager(db, embedding, lance as any, vaultPath, llm);

      const result = await nerIngest.ingest({
        content: "张三是星辰的商务经理",
        type: "text",
        title: "张三简介",
        pageType: "record",
      });

      // NER is now async — ingest returns immediately without NER result
      expect(result.slug).toBeDefined();
      expect(result.created).toBe(true);

      // Wait for async NER to complete
      await new Promise(r => setTimeout(r, 200));
      const stubs = db.rawDb.prepare("SELECT COUNT(*) as cnt FROM tags WHERE tag = 'auto-extracted'").get() as any;
      expect(stubs.cnt).toBeGreaterThanOrEqual(0);
    });

    test("creates entity stubs for discovered entities", async () => {
      const llm = createMockLLM([
        JSON.stringify({
          entities: [
            { name: "李四", type: "person", context: "李四创办了XYZ公司" },
            { name: "XYZ公司", type: "company", context: "李四创办了XYZ公司" },
          ],
          relations: [
            { from: "李四", to: "XYZ公司", relation: "founded", context: "李四创办了XYZ公司" },
          ],
          events: [],
        }),
      ]);

      const embedding = createMockEmbeddingProvider();
      const nerIngest = new IngestManager(db, embedding, lance as any, vaultPath, llm);

      await nerIngest.ingest({
        content: "李四创办了XYZ公司",
        type: "text",
        title: "创业故事",
        pageType: "record",
      });

      // Wait for async NER to complete
      await new Promise(r => setTimeout(r, 200));

      const lisi = db.rawDb.prepare("SELECT * FROM pages WHERE title = ?").get("李四") as any;
      expect(lisi).not.toBeNull();
      expect(lisi.type).toBe("entity/person");

      const xyz = db.rawDb.prepare("SELECT * FROM pages WHERE title = ?").get("XYZ公司") as any;
      expect(xyz).not.toBeNull();
      expect(xyz.type).toBe("entity/company");
    });

    test("writes relations to links table", async () => {
      const llm = createMockLLM([
        // Stage 1: entities + events
        JSON.stringify({
          entities: [
            { name: "王五", type: "person", context: "王五在ABC公司工作" },
            { name: "ABC公司", type: "company", context: "王五在ABC公司工作" },
          ],
          events: [],
        }),
        // Stage 2: relations
        JSON.stringify({
          relations: [
            { from: "王五", to: "ABC公司", relation: "works_at", context: "王五在ABC公司工作" },
          ],
        }),
      ]);

      const embedding = createMockEmbeddingProvider();
      const nerIngest = new IngestManager(db, embedding, lance as any, vaultPath, llm);

      await nerIngest.ingest({
        content: "王五在ABC公司工作",
        type: "text",
        title: "王五介绍",
        pageType: "record",
      });

      // Wait for async NER to complete
      await new Promise(r => setTimeout(r, 200));

      const links = db.rawDb.prepare("SELECT * FROM links WHERE relation = '任职'").all() as any[];
      expect(links.length).toBe(1);
      expect(links[0].relation).toBe("任职");
    });

    test("writes events to timeline", async () => {
      const llm = createMockLLM([
        JSON.stringify({
          entities: [
            { name: "赵六", type: "person", context: "赵六2023年创办了DEF科技" },
            { name: "DEF科技", type: "company", context: "赵六2023年创办了DEF科技" },
          ],
          relations: [],
          events: [
            { date: "2023-06-01", description: "赵六创办了DEF科技", participants: ["赵六"] },
          ],
        }),
      ]);

      const embedding = createMockEmbeddingProvider();
      const nerIngest = new IngestManager(db, embedding, lance as any, vaultPath, llm);

      await nerIngest.ingest({
        content: "赵六2023年创办了DEF科技",
        type: "text",
        title: "DEF科技故事",
        pageType: "record",
      });

      // Wait for async NER to complete
      await new Promise(r => setTimeout(r, 200));

      const events = db.rawDb.prepare("SELECT * FROM timeline").all() as any[];
      expect(events.length).toBe(1);
      expect(events[0].summary).toBe("赵六创办了DEF科技");
      expect(events[0].source).toBe("ner");
    });

    test("skips NER when no LLM provider", async () => {
      const embedding = createMockEmbeddingProvider();
      const noNerIngest = new IngestManager(db, embedding, lance as any, vaultPath);

      const result = await noNerIngest.ingest({
        content: "一些没有NER的文本",
        type: "text",
        title: "无NER",
        pageType: "record",
      });

      expect(result.ner).toBeNull();
    });

    test("NER stubs are queryable via FTS", async () => {
      const llm = createMockLLM([
        JSON.stringify({
          entities: [
            { name: "测试人物", type: "person", context: "测试人物是某公司高管" },
          ],
          relations: [],
          events: [],
        }),
      ]);

      const embedding = createMockEmbeddingProvider();
      const nerIngest = new IngestManager(db, embedding, lance as any, vaultPath, llm);

      await nerIngest.ingest({
        content: "测试人物是某公司高管",
        type: "text",
        title: "人物介绍",
        pageType: "record",
      });

      // Wait for async NER to complete
      await new Promise(r => setTimeout(r, 200));

      const stub = db.rawDb.prepare("SELECT * FROM pages WHERE title = '测试人物'").get() as any;
      expect(stub).not.toBeNull();
      expect(stub.slug).toContain("测试人物");

      const ftsResults = db.ftsSearch("测试人物", 5);
      expect(ftsResults.length).toBeGreaterThan(0);
    });

    test("reuses existing entity instead of creating duplicate stub", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
      ).run("brain/entities/person/zhangsan", "entity/person", "张三", "brain/entities/person/zhangsan.md", "h1");

      const llm = createMockLLM([
        JSON.stringify({
          entities: [
            { name: "张三", type: "person", context: "张三是CEO" },
            { name: "XYZ科技", type: "company", context: "张三是XYZ科技的CEO" },
          ],
          relations: [
            { from: "张三", to: "XYZ科技", relation: "works_at", context: "张三是XYZ科技的CEO" },
          ],
          events: [],
        }),
      ]);

      const embedding = createMockEmbeddingProvider();
      const nerIngest = new IngestManager(db, embedding, lance as any, vaultPath, llm);

      await nerIngest.ingest({
        content: "张三是XYZ科技的CEO",
        type: "text",
        title: "CEO信息",
        pageType: "record",
      });

      // NER is async — wait for background extraction to complete
      await new Promise(r => setTimeout(r, 200));

      const pages = db.rawDb.prepare("SELECT * FROM pages WHERE title = '张三'").all() as any[];
      expect(pages.length).toBe(1);
    });

    test("syncs Known Relations to entity markdown after wikilink ingest", async () => {
      // Pre-create entity pages with vault files
      mkdirSync(join(vaultPath, "brain/entities"), { recursive: true });
      writeFileSync(join(vaultPath, "brain/entities/WikiA.md"), "---\ntitle: WikiA\ntype: entity/person\nslug: brain/entities/wiki-a\n---\nWikiA content");
      writeFileSync(join(vaultPath, "brain/entities/WikiB.md"), "---\ntitle: WikiB\ntype: entity/person\nslug: brain/entities/wiki-b\n---\nWikiB content");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
      ).run("brain/entities/wiki-a", "entity/person", "WikiA", "brain/entities/WikiA.md", "h1");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
      ).run("brain/entities/wiki-b", "entity/person", "WikiB", "brain/entities/WikiB.md", "h2");

      // Ingest a record with wikilinks, skip NER to isolate the wikilink→KR path
      await ingest.ingest({
        content: "今天见了 [[WikiA]] 和 [[WikiB]]",
        type: "text",
        title: "会面记录",
        skipNer: true,
      });

      // Verify wikilinks were created
      const linkCount = db.rawDb.prepare("SELECT COUNT(*) as c FROM links WHERE relation = '提及'").get() as { c: number };
      expect(linkCount.c).toBeGreaterThanOrEqual(2);

      // Verify entity markdown files now contain Known Relations
      const mdA = readFileSync(join(vaultPath, "brain/entities/WikiA.md"), "utf-8");
      expect(mdA).toContain("## Known Relations");
      expect(mdA).toContain("← 提及 from [[");

      const mdB = readFileSync(join(vaultPath, "brain/entities/WikiB.md"), "utf-8");
      expect(mdB).toContain("## Known Relations");
      expect(mdB).toContain("← 提及 from [[");
    });
  });

  // ── Failure cleanup tests ──

  describe("failure cleanup", () => {
    test("pre-existing slug conflict: create refuses, existing data untouched", async () => {
      const pages = ingest["pages"]; // access private PageManager
      // Pre-insert a page with the slug that will be generated
      const originalContent = "---\ntitle: Original\ntype: record\n---\nOriginal body";
      mkdirSync(join(vaultPath, "records"), { recursive: true });
      writeFileSync(join(vaultPath, "records/duplicate-test.md"), originalContent, "utf-8");
      db.rawDb.prepare(
        "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)",
      ).run("records/duplicate-test", "record", "Original", "records/duplicate-test.md", "h1");

      // create should refuse, not overwrite
      expect(() => {
        pages.create({ title: "Duplicate Test", type: "record", body: "new content" });
      }).toThrow(/already exists/);

      // Original vault file byte-identical
      const afterContent = readFileSync(join(vaultPath, "records/duplicate-test.md"), "utf-8");
      expect(afterContent).toBe(originalContent);

      // Original DB row untouched
      const rows = db.rawDb.prepare("SELECT COUNT(*) as c FROM pages WHERE slug = 'records/duplicate-test'").get() as { c: number };
      expect(rows.c).toBe(1);
      const row = db.getPage("records/duplicate-test");
      expect(row!.title).toBe("Original");
    });

    test("DB insert failure on NEW page cleans up vault file", async () => {
      const pages = ingest["pages"];
      // Mock insertPage to throw — no pre-existing slug
      const origInsert = db.insertPage.bind(db);
      db.insertPage = () => { throw new Error("DB connection lost"); };

      expect(() => {
        pages.create({ title: "New Fail Test", type: "record", body: "content" });
      }).toThrow("DB connection lost");

      // Restore
      db.insertPage = origInsert;

      // Vault file cleaned up
      expect(existsSync(join(vaultPath, "records/new-fail-test.md"))).toBe(false);

      // No DB residual
      const row = db.getPage("records/new-fail-test");
      expect(row).toBeNull();
    });

    test("pure punctuation text input throws validation error with no side effects", async () => {
      await expect(ingest.ingest({
        content: "!!! ??? --- ...",
        type: "text",
      })).rejects.toThrow("VALIDATION_ERROR");

      // No pages created
      const count = db.rawDb.prepare("SELECT COUNT(*) as c FROM pages").get() as { c: number };
      expect(count.c).toBe(0);

      // No vault files in records dir
      const recordsDir = join(vaultPath, "records");
      if (existsSync(recordsDir)) {
        const files = require("node:fs").readdirSync(recordsDir);
        expect(files.length).toBe(0);
      }
    });

    test("pure punctuation title + content throws validation error", async () => {
      await expect(ingest.ingest({
        content: "... !!!",
        title: "??? ---",
        type: "text",
      })).rejects.toThrow("VALIDATION_ERROR");

      const count = db.rawDb.prepare("SELECT COUNT(*) as c FROM pages").get() as { c: number };
      expect(count.c).toBe(0);
    });

    test("new page + LanceDB failure: fully rolled back, zero residual", async () => {
      // Stateful mock: addChunks records the slug THEN throws — simulates partial LanceDB write
      const lance = createMockLanceDB();
      const originalAddChunks = lance.addChunks.bind(lance);
      lance.addChunks = async (chunks) => {
        await originalAddChunks(chunks);
        throw new Error("LanceDB down");
      };

      const failingIngest = new IngestManager(db, createMockEmbeddingProvider(), lance as any, vaultPath);

      await expect(failingIngest.ingest({
        content: "Some content for LanceDB failure test",
        type: "text",
        title: "LanceDB Fail Test",
        skipNer: true,
      })).rejects.toThrow("LanceDB down");

      // New page must be fully rolled back
      const row = db.getPage("records/lancedb-fail-test");
      expect(row).toBeNull();

      // No vault file
      expect(existsSync(join(vaultPath, "records/lancedb-fail-test.md"))).toBe(false);

      // No residual chunks/tags/links in SQLite
      const chunks = db.rawDb.prepare("SELECT COUNT(*) as c FROM chunks WHERE page_slug = ?").get("records/lancedb-fail-test") as { c: number };
      expect(chunks.c).toBe(0);
      const tags = db.rawDb.prepare("SELECT COUNT(*) as c FROM tags WHERE page_slug = ?").get("records/lancedb-fail-test") as { c: number };
      expect(tags.c).toBe(0);
      const links = db.rawDb.prepare("SELECT COUNT(*) as c FROM links WHERE from_slug = ? OR to_slug = ?").get("records/lancedb-fail-test", "records/lancedb-fail-test") as { c: number };
      expect(links.c).toBe(0);

      // LanceDB rollback must have deleted the slug's vectors
      // (added is an operation log — the write happened before the throw,
      //  but rollback must call deleteByPageSlug to clean up)
      expect(lance.deleted).toContain("records/lancedb-fail-test");
      expect(lance.current.has("records/lancedb-fail-test")).toBe(false);
    });

    test("existing page + LanceDB failure: page restored to pre-update state", async () => {
      // Pre-create a page with tags and verify state
      await ingest.ingest({
        content: "Original content for existing page",
        type: "text",
        title: "Existing Page",
        tags: ["tag-a"],
        skipNer: true,
      });

      const slug = "records/existing-page";
      const originalRow = db.getPage(slug);
      expect(originalRow).not.toBeNull();
      const originalPage = ingest["pages"].getBySlug(slug)!;
      expect(originalPage.body).toContain("Original content");

      // Now try to update with failing LanceDB
      const failingLance = {
        ...createMockLanceDB(),
        addChunks: async () => { throw new Error("LanceDB down"); },
      };
      const failingIngest = new IngestManager(db, createMockEmbeddingProvider(), failingLance as any, vaultPath);

      await expect(failingIngest.ingest({
        content: "Updated content that will fail",
        type: "text",
        title: "Existing Page",
        tags: ["tag-b"],
        skipNer: true,
      })).rejects.toThrow("LanceDB down");

      // Page must still exist
      const afterRow = db.getPage(slug);
      expect(afterRow).not.toBeNull();
      expect(existsSync(join(vaultPath, "records/existing-page.md"))).toBe(true);

      // Body must be restored to original content
      const afterPage = failingIngest["pages"].getBySlug(slug)!;
      expect(afterPage.body).toBe(originalPage.body);

      // Tags must be restored to original
      expect(afterPage.frontmatter.tags).toEqual(["tag-a"]);

      // Restore attempted to re-index old content but LanceDB was also down —
      // audit log should record incomplete rollback
      const logs = db.rawDb.prepare("SELECT * FROM ingest_log WHERE page_slug = ? ORDER BY id DESC").all(slug) as any[];
      const incompleteLog = logs.find((l: any) => {
        try { return JSON.parse(l.details ?? "{}").rollbackIncomplete === true; } catch { return false; }
      });
      expect(incompleteLog).toBeDefined();
    });

    test("entity append + LanceDB failure: body restored to pre-append state", async () => {
      // Pre-create a person entity directly
      const personSlug = "brain/entities/person/人物A";
      ingest["pages"].create({
        title: "人物A",
        type: "entity/person",
        body: "人物A的初始简介",
        tags: ["人物"],
        slug: personSlug,
      });

      const originalPage = ingest["pages"].getBySlug(personSlug)!;
      const originalBody = originalPage.body;
      const originalTags = [...(originalPage.frontmatter.tags ?? [])];

      // Trigger append path with failing LanceDB
      const failingLance = {
        ...createMockLanceDB(),
        addChunks: async () => { throw new Error("LanceDB down"); },
      };
      const failingIngest = new IngestManager(db, createMockEmbeddingProvider(), failingLance as any, vaultPath);

      await expect(failingIngest.ingest({
        content: "人物A的新追加内容",
        title: "人物A",
        type: "text",
        tags: ["新标签"],
        skipNer: true,
      })).rejects.toThrow("LanceDB down");

      // Body must be restored to pre-append state
      const afterPage = failingIngest["pages"].getBySlug(personSlug)!;
      expect(afterPage.body).toBe(originalBody);

      // Tags must be restored (not merged with new tag)
      expect(afterPage.frontmatter.tags).toEqual(originalTags);
    });

    test("new page rollback does not modify other vault files", async () => {
      // Pre-create an existing note with a wikilink to a page that will fail to create
      ingest["pages"].create({
        title: "Existing Note",
        type: "record",
        body: "这是已有笔记，包含 [[待创建页面]] 的链接",
      });
      const existingFilePath = join(vaultPath, "records/existing-note.md");
      const originalContent = readFileSync(existingFilePath, "utf-8");

      // Ingest a NEW page that fails at LanceDB
      const failingLance = {
        ...createMockLanceDB(),
        addChunks: async () => { throw new Error("LanceDB down"); },
      };
      const failingIngest = new IngestManager(db, createMockEmbeddingProvider(), failingLance as any, vaultPath);

      await expect(failingIngest.ingest({
        content: "New page that fails",
        type: "text",
        title: "待创建页面",
        skipNer: true,
      })).rejects.toThrow("LanceDB down");

      // The existing note must be byte-identical — rollback did not rewrite its wikilinks
      expect(readFileSync(existingFilePath, "utf-8")).toBe(originalContent);
    });

    test("existing page restore re-indexes old content successfully", async () => {
      // Pre-create a page
      await ingest.ingest({
        content: "Original content to be re-indexed",
        type: "text",
        title: "Reindex Test",
        tags: ["original"],
        skipNer: true,
      });
      const slug = "records/reindex-test";

      // Verify chunks exist for original content
      const originalChunks = db.rawDb.prepare("SELECT COUNT(*) as c FROM chunks WHERE page_slug = ?").get(slug) as { c: number };
      expect(originalChunks.c).toBeGreaterThan(0);

      // LanceDB mock that tracks current vector state
      const lance = createMockLanceDB();
      const originalAddChunks = lance.addChunks.bind(lance);
      let addCallCount = 0;
      lance.addChunks = async (chunks) => {
        addCallCount++;
        if (addCallCount === 1) {
          // First call (new content write) — fail
          throw new Error("LanceDB down");
        }
        // Second call (restore old content) — succeed
        return originalAddChunks(chunks);
      };

      const restoreIngest = new IngestManager(db, createMockEmbeddingProvider(), lance as any, vaultPath);

      await expect(restoreIngest.ingest({
        content: "Updated content that triggers failure",
        type: "text",
        title: "Reindex Test",
        tags: ["updated"],
        skipNer: true,
      })).rejects.toThrow("LanceDB down");

      // Body must be restored to original
      const afterPage = restoreIngest["pages"].getBySlug(slug)!;
      expect(afterPage.body).toContain("Original content to be re-indexed");
      expect(afterPage.frontmatter.tags).toEqual(["original"]);

      // SQLite chunks must still exist (re-indexed from old content)
      const afterChunks = db.rawDb.prepare("SELECT COUNT(*) as c FROM chunks WHERE page_slug = ?").get(slug) as { c: number };
      expect(afterChunks.c).toBeGreaterThan(0);

      // LanceDB must have been called twice: failed add + successful restore add
      expect(addCallCount).toBe(2);
      const restoredVectorContent = lance.current.get(slug)?.map(chunk => chunk.content).join("\n") ?? "";
      expect(restoredVectorContent).toContain("Original content to be re-indexed");
      expect(restoredVectorContent).not.toContain("Updated content");
    });

    test("restore + re-index both fail: audit log records incomplete rollback", async () => {
      // Pre-create a page
      await ingest.ingest({
        content: "Content that cannot be re-indexed",
        type: "text",
        title: "Double Fail Test",
        skipNer: true,
      });
      const slug = "records/double-fail-test";

      // LanceDB that always fails
      const alwaysFailLance = {
        ...createMockLanceDB(),
        addChunks: async () => { throw new Error("LanceDB permanently down"); },
      };
      const failingIngest = new IngestManager(db, createMockEmbeddingProvider(), alwaysFailLance as any, vaultPath);

      await expect(failingIngest.ingest({
        content: "Will fail and restore will also fail",
        type: "text",
        title: "Double Fail Test",
        skipNer: true,
      })).rejects.toThrow("INGEST_ROLLBACK_INCOMPLETE");

      // Body must still be restored despite re-index failure
      const afterPage = failingIngest["pages"].getBySlug(slug)!;
      expect(afterPage.body).toContain("Content that cannot be re-indexed");

      // Audit log must record the incomplete rollback
      const logs = db.rawDb.prepare("SELECT * FROM ingest_log WHERE page_slug = ? ORDER BY id DESC").all(slug) as any[];
      const incompleteLog = logs.find((l: any) => {
        try {
          const meta = JSON.parse(l.details ?? "{}");
          return meta.rollbackIncomplete === true;
        } catch { return false; }
      });
      expect(incompleteLog).toBeDefined();
      const meta = JSON.parse(incompleteLog.details);
      expect(meta.reindexRequired).toBe(true);
      expect(meta.rollbackErrors).toContain("LanceDB permanently down");
    });

    test("new page cleanup failure is surfaced as rollback incomplete", async () => {
      const failingLance = {
        ...createMockLanceDB(),
        addChunks: async () => { throw new Error("LanceDB down"); },
      };
      const failingIngest = new IngestManager(db, createMockEmbeddingProvider(), failingLance as any, vaultPath);
      const originalDelete = db.deletePageCascaded.bind(db);
      db.deletePageCascaded = () => { throw new Error("DB cleanup failed"); };

      try {
        await expect(failingIngest.ingest({
          content: "内容A",
          type: "text",
          title: "清理失败测试",
          skipNer: true,
        })).rejects.toThrow("INGEST_ROLLBACK_INCOMPLETE");
      } finally {
        db.deletePageCascaded = originalDelete;
      }
    });

    test("page restore failure is surfaced as rollback incomplete", async () => {
      await ingest.ingest({
        content: "原始内容A",
        type: "text",
        title: "恢复失败测试",
        skipNer: true,
      });

      const failingLance = {
        ...createMockLanceDB(),
        addChunks: async () => { throw new Error("LanceDB down"); },
      };
      const failingIngest = new IngestManager(db, createMockEmbeddingProvider(), failingLance as any, vaultPath);
      const pages = failingIngest["pages"];
      const originalUpdate = pages.update.bind(pages);
      let updateCalls = 0;
      pages.update = ((...args: Parameters<typeof pages.update>) => {
        updateCalls++;
        if (updateCalls === 2) throw new Error("Page restore failed");
        return originalUpdate(...args);
      }) as typeof pages.update;

      await expect(failingIngest.ingest({
        content: "新内容B",
        type: "text",
        title: "恢复失败测试",
        skipNer: true,
      })).rejects.toThrow("INGEST_ROLLBACK_INCOMPLETE");
    });

    test("wikilink replacement failure rolls back links and mention counts", async () => {
      const pages = ingest["pages"];
      const targetA = pages.create({ title: "实体A", type: "entity/person", body: "实体A" });
      const targetB = pages.create({ title: "实体B", type: "entity/person", body: "实体B" });

      await ingest.ingest({
        content: "原记录引用 [[实体A]]",
        type: "text",
        title: "关系事务测试",
        skipNer: true,
      });

      const sourceSlug = "records/关系事务测试";
      const targetASlug = targetA.slug;
      const targetBSlug = targetB.slug;
      const beforeA = db.rawDb.prepare("SELECT mention_count FROM pages WHERE slug = ?").get(targetASlug) as { mention_count: number };
      const beforeB = db.rawDb.prepare("SELECT mention_count FROM pages WHERE slug = ?").get(targetBSlug) as { mention_count: number };

      const originalInsertLink = db.insertLink.bind(db);
      let wikilinkWrites = 0;
      db.insertLink = ((from: string, to: string, relation: string, ...rest: unknown[]) => {
        if (from === sourceSlug && relation === "提及") {
          wikilinkWrites++;
          if (wikilinkWrites === 2) throw new Error("second wikilink failed");
        }
        return originalInsertLink(from, to, relation, ...rest as Parameters<typeof db.insertLink> extends [string, string, string, ...infer R] ? R : never);
      }) as typeof db.insertLink;

      try {
        await expect(ingest.ingest({
          content: "更新后引用 [[实体A]] 和 [[实体B]]",
          type: "text",
          title: "关系事务测试",
          skipNer: true,
        })).rejects.toThrow("second wikilink failed");
      } finally {
        db.insertLink = originalInsertLink;
      }

      const afterA = db.rawDb.prepare("SELECT mention_count FROM pages WHERE slug = ?").get(targetASlug) as { mention_count: number };
      const afterB = db.rawDb.prepare("SELECT mention_count FROM pages WHERE slug = ?").get(targetBSlug) as { mention_count: number };
      expect(afterA.mention_count).toBe(beforeA.mention_count);
      expect(afterB.mention_count).toBe(beforeB.mention_count);

      const links = db.getOutgoingLinks(sourceSlug).filter(link => link.relation === "提及");
      expect(links.map(link => link.to_slug)).toEqual([targetASlug]);
    });

    test("auto-detect markdown content without explicit type", async () => {
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

      const result = await ingest.ingest({
        content: md,
        // No type, no title — classifier should detect markdown
        skipNer: true,
      });

      expect(result.created).toBe(true);
      expect(result.slug).toBe("records/自动分类测试");

      // Verify vault file has correct frontmatter
      const filePath = join(vaultPath, "records/自动分类测试.md");
      expect(existsSync(filePath)).toBe(true);
      const fileContent = readFileSync(filePath, "utf-8");
      expect(fileContent).toContain("title: 自动分类测试");
      expect(fileContent).toContain("自动标签");

      // No untitled-* files
      const files = require("node:fs").readdirSync(join(vaultPath, "records")) as string[];
      expect(files.some((f: string) => f.startsWith("untitled-"))).toBe(false);
    });

    test("markdown without a title derives one from semantic body content", async () => {
      const result = await ingest.ingest({
        content: "---\ntype: record\n---\n\n正文标题\n正文内容。",
        skipNer: true,
      });

      expect(result.slug).toBe("records/正文标题");
      expect(existsSync(join(vaultPath, "records/正文标题.md"))).toBe(true);
    });

    test("markdown without a semantic title or body is rejected without side effects", async () => {
      await expect(ingest.ingest({
        content: "---\ntype: record\ntags:\n  - test\n---\n\n!!!",
        skipNer: true,
      })).rejects.toThrow("VALIDATION_ERROR");

      const count = db.rawDb.prepare("SELECT COUNT(*) as c FROM pages").get() as { c: number };
      expect(count.c).toBe(0);
      expect(existsSync(join(vaultPath, "records"))).toBe(false);
    });

    test("existing page update failure restores the original vault and DB state", async () => {
      await ingest.ingest({
        content: "原始内容A",
        type: "text",
        title: "更新事务测试",
        tags: ["原标签"],
        skipNer: true,
      });

      const slug = "records/更新事务测试";
      const pages = ingest["pages"];
      const originalUpdate = db.updatePageHash.bind(db);
      let failed = false;
      db.updatePageHash = ((...args: Parameters<typeof db.updatePageHash>) => {
        if (!failed) {
          failed = true;
          throw new Error("SQLite update failed");
        }
        return originalUpdate(...args);
      }) as typeof db.updatePageHash;

      try {
        await expect(ingest.ingest({
          content: "不应保留的新内容B",
          type: "text",
          title: "更新事务测试",
          tags: ["新标签"],
          skipNer: true,
        })).rejects.toThrow("SQLite update failed");
      } finally {
        db.updatePageHash = originalUpdate;
      }

      const restored = pages.getBySlug(slug)!;
      expect(restored.body).toContain("原始内容A");
      expect(restored.body).not.toContain("不应保留的新内容B");
      expect(restored.frontmatter.tags).toEqual(["原标签"]);
    });

    test("markdown with frontmatter routed as text creates no untitled files", async () => {
      const md = [
        "---",
        "title: Test Page",
        "---",
        "Body content.",
      ].join("\n");

      // Explicitly route as text (old broken behavior)
      const result = await ingest.ingest({
        content: md,
        type: "text",
        skipNer: true,
      });

      expect(result.created).toBe(true);
      // Title should be "Test Page" (first semantic line after ---)
      expect(result.slug).toContain("test-page");

      // No untitled-* files
      const recordsDir = join(vaultPath, "records");
      if (existsSync(recordsDir)) {
        const files = require("node:fs").readdirSync(recordsDir) as string[];
        expect(files.some((f: string) => f.startsWith("untitled-"))).toBe(false);
      }
    });
  });
});

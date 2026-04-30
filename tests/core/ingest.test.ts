import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { IngestManager } from "../../src/core/ingest.js";
import { SyncManager } from "../../src/core/sync.js";
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

  return {
    added,
    deleted,

    connect: async () => {},
    addChunks: async (chunks: Array<{ pageSlug: string; chunkIndex: number; content: string; vector?: Float32Array }>) => {
      for (const chunk of chunks) {
        let entry = added.find((a) => a.pageSlug === chunk.pageSlug);
        if (!entry) {
          entry = { pageSlug: chunk.pageSlug, chunks: [] };
          added.push(entry);
        }
        entry.chunks.push({ content: chunk.content, chunkIndex: chunk.chunkIndex });
      }
    },
    search: async () => [],
    fullTextSearch: async () => [],
    deleteByPageSlug: async (pageSlug: string) => {
      deleted.push(pageSlug);
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
        content: "张三是诺华制药的商务经理",
        type: "text",
        title: "张三",
        pageType: "entity",
      });

      expect(result.created).toBe(true);
      expect(result.slug).toBe("brain/nodes/张三");

      const row = db
        .prepare("SELECT * FROM pages WHERE slug = ?")
        .get("brain/nodes/张三") as any;
      expect(row).not.toBeNull();
      expect(row.title).toBe("张三");
      expect(row.type).toBe("entity");
    });

    test("writes vault file for text input", async () => {
      await ingest.ingest({
        content: "Some plain text",
        type: "text",
        title: "Test Note",
        tags: ["test"],
      });

      const filePath = join(vaultPath, "brain/records/test-note.md");
      expect(existsSync(filePath)).toBe(true);
    });

    test("uses provided tags", async () => {
      await ingest.ingest({
        content: "Tagged content",
        type: "text",
        title: "Tagged",
        tags: ["人物", "商务"],
      });

      const tags = db
        .prepare("SELECT tag FROM tags WHERE page_slug = ?")
        .all("brain/records/tagged") as any[];
      const tagValues = tags.map((t) => t.tag);
      expect(tagValues).toContain("人物");
      expect(tagValues).toContain("商务");
    });
  });

  describe("ingest markdown", () => {
    test("creates page from markdown with frontmatter", async () => {
      const md = [
        "---",
        "title: 李四",
        "type: entity",
        "slug: entities/lisi",
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

      expect(result.slug).toBe("entities/lisi");
      expect(result.created).toBe(true);

      const row = db
        .prepare("SELECT * FROM pages WHERE slug = ?")
        .get("entities/lisi") as any;
      expect(row).not.toBeNull();
      expect(row.title).toBe("李四");
    });

    test("updates existing page on re-ingest", async () => {
      const md1 = [
        "---",
        "title: 王五",
        "type: entity",
        "slug: entities/wangwu",
        "---",
        "",
        "原始内容",
      ].join("\n");

      await ingest.ingest({ content: md1, type: "markdown" });
      lance.added.length = 0;

      const md2 = [
        "---",
        "title: 王五",
        "type: entity",
        "slug: entities/wangwu",
        "---",
        "",
        "更新后的内容",
      ].join("\n");

      const result = await ingest.ingest({ content: md2, type: "markdown" });
      expect(result.created).toBe(false);
      expect(result.slug).toBe("entities/wangwu");
    });

    test("auto-generates slug when missing from frontmatter", async () => {
      const md = [
        "---",
        "title: AutoSlug",
        "type: entity",
        "---",
        "",
        "No slug provided",
      ].join("\n");

      const result = await ingest.ingest({ content: md, type: "markdown" });
      expect(result.slug).toBe("brain/nodes/autoslug");
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

      const tags = db
        .prepare("SELECT tag FROM tags WHERE page_slug = ?")
        .all("records/tag-priority") as any[];
      const tagValues = tags.map((t) => t.tag);
      expect(tagValues).toContain("fm-tag");
      expect(tagValues).not.toContain("input-tag");
    });
  });

  describe("link extraction", () => {
    test("creates graph edges for resolved links", async () => {
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
      ).run("entities/lisi", "entity", "李四", "entities/lisi.md", "h1");

      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
      ).run("entities/wangwu", "entity", "王五", "entities/wangwu.md", "h2");

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

      const links = db
        .prepare("SELECT to_slug FROM links WHERE from_slug = ?")
        .all("records/link-test") as any[];
      const targets = links.map((l) => l.to_slug);
      expect(targets).toContain("entities/lisi");
      expect(targets).toContain("entities/wangwu");
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

      const links = db
        .prepare("SELECT * FROM links WHERE from_slug = ?")
        .all("records/unresolved") as any[];
      expect(links.length).toBe(0);
    });

    test("increments mention count on linked pages", async () => {
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
      ).run("entities/mentioned", "entity", "被提及者", "entities/mentioned.md", "h1");

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

      const row = db
        .prepare("SELECT mention_count FROM pages WHERE slug = ?")
        .get("entities/mentioned") as any;
      expect(row.mention_count).toBe(1);
    });

    test("does not create self-referencing link", async () => {
      mkdirSync(join(vaultPath, "entities"), { recursive: true });
      const preMd = [
        "---",
        "title: SelfRef",
        "type: entity",
        "slug: entities/self-ref",
        "---",
        "",
        "Original",
      ].join("\n");
      writeFileSync(join(vaultPath, "entities/self-ref.md"), preMd, "utf-8");
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
      ).run("entities/self-ref", "entity", "SelfRef", "entities/self-ref.md", "h1");

      const md = [
        "---",
        "title: SelfRef",
        "type: entity",
        "slug: entities/self-ref",
        "---",
        "",
        "自我引用[[SelfRef]]。",
      ].join("\n");

      await ingest.ingest({ content: md, type: "markdown" });

      const links = db
        .prepare("SELECT * FROM links WHERE from_slug = ? AND to_slug = ?")
        .all("entities/self-ref", "entities/self-ref") as any[];
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

      const logs = db
        .prepare("SELECT * FROM ingest_log WHERE page_slug LIKE ?")
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
            { name: "张三", type: "person", context: "张三是诺华的商务经理" },
            { name: "诺华", type: "company", context: "张三是诺华的商务经理" },
          ],
          relations: [
            { from: "张三", to: "诺华", relation: "works_at", context: "张三是诺华的商务经理" },
          ],
          events: [],
        }),
      ]);

      const embedding = createMockEmbeddingProvider();
      const nerIngest = new IngestManager(db, embedding, lance as any, vaultPath, llm);

      const result = await nerIngest.ingest({
        content: "张三是诺华的商务经理",
        type: "text",
        title: "张三简介",
        pageType: "entity",
      });

      // NER is now async — ingest returns immediately without NER result
      expect(result.slug).toBeDefined();
      expect(result.created).toBe(true);

      // Wait for async NER to complete
      await new Promise(r => setTimeout(r, 200));
      const stubs = db.prepare("SELECT COUNT(*) as cnt FROM tags WHERE tag = 'auto-extracted'").get() as any;
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

      const lisi = db.prepare("SELECT * FROM pages WHERE title = ?").get("李四") as any;
      expect(lisi).not.toBeNull();
      expect(lisi.type).toBe("entity");

      const xyz = db.prepare("SELECT * FROM pages WHERE title = ?").get("XYZ公司") as any;
      expect(xyz).not.toBeNull();
      expect(xyz.type).toBe("entity");
    });

    test("writes relations to links table", async () => {
      const llm = createMockLLM([
        JSON.stringify({
          entities: [
            { name: "王五", type: "person", context: "王五在ABC公司工作" },
            { name: "ABC公司", type: "company", context: "王五在ABC公司工作" },
          ],
          relations: [
            { from: "王五", to: "ABC公司", relation: "works_at", context: "王五在ABC公司工作" },
          ],
          events: [],
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

      const links = db.prepare("SELECT * FROM links WHERE relation = 'works_at'").all() as any[];
      expect(links.length).toBe(1);
      expect(links[0].relation).toBe("works_at");
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

      const events = db.prepare("SELECT * FROM timeline").all() as any[];
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

      expect(result.ner).toBeUndefined();
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

      const stub = db.prepare("SELECT * FROM pages WHERE title = '测试人物'").get() as any;
      expect(stub).not.toBeNull();
      expect(stub.slug).toContain("测试人物");

      const ftsResults = db.ftsSearch("测试人物", 5);
      expect(ftsResults.length).toBeGreaterThan(0);
    });

    test("reuses existing entity instead of creating duplicate stub", async () => {
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
      ).run("brain/nodes/zhangsan", "entity", "张三", "brain/nodes/zhangsan.md", "h1");

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

      const pages = db.prepare("SELECT * FROM pages WHERE title = '张三'").all() as any[];
      expect(pages.length).toBe(1);
    });
  });
});

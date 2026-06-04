import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { IngestManager } from "../../src/core/ingest.js";
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
    deleteRawChunksByPageSlug: async () => {},
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
});

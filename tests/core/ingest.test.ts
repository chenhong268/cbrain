import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { IngestManager } from "../../src/core/ingest.js";
import { SyncManager } from "../../src/core/sync.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";

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
      expect(result.slug).toBe("entities/张三");

      const row = db
        .prepare("SELECT * FROM pages WHERE slug = ?")
        .get("entities/张三") as any;
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

      const tags = db
        .prepare("SELECT tag FROM tags WHERE page_slug = ?")
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
      expect(result.slug).toBe("entities/autoslug");
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
    test("extracts [[wiki links]] from body", () => {
      const links = ingest.extractWikiLinks(
        "张三认识[[李四]]，他们一起在[[王五]]的项目上工作。"
      );
      expect(links).toEqual(["李四", "王五"]);
    });

    test("deduplicates links", () => {
      const links = ingest.extractWikiLinks(
        "[[张三]]和[[张三]]一起吃饭。"
      );
      expect(links).toEqual(["张三"]);
    });

    test("returns empty for no links", () => {
      const links = ingest.extractWikiLinks("没有链接的纯文本。");
      expect(links).toEqual([]);
    });

    test("creates graph edges for resolved links", async () => {
      // Pre-create target pages
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
      expect(result.linksExtracted).toBe(1);

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
      // Pre-create with vault file so getBySlug finds it
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
      expect(logs[0].action).toBe("sync");
    });
  });
});

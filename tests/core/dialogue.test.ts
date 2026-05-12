import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { DialogueIngest } from "../../src/core/dialogue.js";
import type { LLMProvider } from "../../src/llm/provider.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";

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
  return {
    connect: async () => {},
    addChunks: async () => {},
    search: async () => [],
    fullTextSearch: async () => [],
    deleteByPageSlug: async () => {},
    close: async () => {},
    createFTSIndex: async () => {},
  };
}

describe("DialogueIngest", () => {
  const testDir = "/tmp/cbrain-test-dialogue";
  const dbPath = join(testDir, "test.sqlite");
  const vaultPath = join(testDir, "vault");
  let db: CBrainDB;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(dbPath);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  describe("extraction", () => {
    test("extracts new entities from dialogue", async () => {
      const llm = createMockLLM([
        JSON.stringify({
          entities: [
            { name: "陈博士", type: "person", relevance: "high", context: "陈博士下周来上海" },
            { name: "XYZ研究所", type: "company", relevance: "high", context: "陈博士在XYZ研究所工作" },
          ],
          relations: [
            { from: "陈博士", to: "XYZ研究所", relation: "works_at", context: "陈博士在XYZ研究所工作" },
          ],
          events: [],
        }),
      ]);

      const embedding = createMockEmbeddingProvider();
      const lance = createMockLanceDB();
      const dialogue = new DialogueIngest(db, embedding, lance as any, vaultPath, llm);

      const result = await dialogue.ingest("用户：陈博士下周来上海，他在XYZ研究所工作。");

      expect(result.newEntities).toBe(2);
      expect(result.newRelations).toBe(1);
      expect(result.skipped).toBe(0);

      // Verify entities created
      const chen = db.prepare("SELECT * FROM pages WHERE title = '陈博士'").get() as any;
      expect(chen).not.toBeNull();
      expect(chen.type).toBe("entity");

      const xyz = db.prepare("SELECT * FROM pages WHERE title = 'XYZ研究所'").get() as any;
      expect(xyz).not.toBeNull();
      expect(xyz.type).toBe("entity");
    });

    test("skips entities that already exist", async () => {
      // Pre-create an entity
      db.prepare(
        "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
      ).run("brain/entities/张三", "entity", "张三", "brain/entities/张三.md", "h1");

      const llm = createMockLLM([
        JSON.stringify({
          entities: [
            { name: "张三", type: "person", relevance: "high", context: "张三说他下周来" },
            { name: "李四", type: "person", relevance: "high", context: "李四也在" },
          ],
          relations: [],
          events: [],
        }),
      ]);

      const embedding = createMockEmbeddingProvider();
      const lance = createMockLanceDB();
      const dialogue = new DialogueIngest(db, embedding, lance as any, vaultPath, llm);

      const result = await dialogue.ingest("用户：张三说他下周来，李四也在。");

      // 张三已存在，只新建李四
      expect(result.newEntities).toBe(1);
      expect(result.skipped).toBe(1); // 张三被跳过

      // 张三 mention_count 应该增加
      const zhang = db.prepare("SELECT mention_count FROM pages WHERE slug = 'brain/entities/张三'").get() as any;
      expect(zhang.mention_count).toBe(1);
    });

    test("extracts events with dates", async () => {
      const llm = createMockLLM([
        JSON.stringify({
          entities: [
            { name: "王五", type: "person", relevance: "high", context: "王五5月15号要去北京" },
          ],
          relations: [],
          events: [
            { date: "2026-05-15", description: "王五去北京出差", participants: ["王五"] },
          ],
        }),
      ]);

      const embedding = createMockEmbeddingProvider();
      const lance = createMockLanceDB();
      const dialogue = new DialogueIngest(db, embedding, lance as any, vaultPath, llm);

      const result = await dialogue.ingest("用户：王五5月15号要去北京出差。");

      expect(result.newEvents).toBe(1);

      const events = db.prepare("SELECT * FROM timeline WHERE source = 'dialogue'").all() as any[];
      expect(events.length).toBe(1);
      expect(events[0].summary).toBe("王五去北京出差");
    });

    test("skips events without dates", async () => {
      const llm = createMockLLM([
        JSON.stringify({
          entities: [
            { name: "赵六", type: "person", relevance: "high", context: "赵六最近在学习AI" },
          ],
          relations: [],
          events: [
            { date: null, description: "赵六在学习AI", participants: ["赵六"] },
          ],
        }),
      ]);

      const embedding = createMockEmbeddingProvider();
      const lance = createMockLanceDB();
      const dialogue = new DialogueIngest(db, embedding, lance as any, vaultPath, llm);

      const result = await dialogue.ingest("用户：赵六最近在学习AI。");

      expect(result.newEvents).toBe(0);
    });

    test("returns empty result for pure chit-chat", async () => {
      const llm = createMockLLM([
        JSON.stringify({ entities: [], relations: [], events: [] }),
      ]);

      const embedding = createMockEmbeddingProvider();
      const lance = createMockLanceDB();
      const dialogue = new DialogueIngest(db, embedding, lance as any, vaultPath, llm);

      const result = await dialogue.ingest("用户：好的\n助手：没问题");

      expect(result.newEntities).toBe(0);
      expect(result.newRelations).toBe(0);
      expect(result.newEvents).toBe(0);
    });

    test("returns empty result when no LLM provider", async () => {
      const embedding = createMockEmbeddingProvider();
      const lance = createMockLanceDB();
      const dialogue = new DialogueIngest(db, embedding, lance as any, vaultPath);

      const result = await dialogue.ingest("用户：张三是CEO");

      expect(result.newEntities).toBe(0);
      expect(result.newRelations).toBe(0);
      expect(result.newEvents).toBe(0);
    });
  });

  describe("incremental filtering", () => {
    test("skips relations that already exist in DB", async () => {
      // Pre-create two entities with a relation
      db.prepare(
        "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
      ).run("brain/entities/甲公司", "entity", "甲公司", "brain/entities/甲公司.md", "h1");
      db.prepare(
        "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
      ).run("brain/entities/张三", "entity", "张三", "brain/entities/张三.md", "h1");
      db.prepare(
        "INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)"
      ).run("brain/entities/张三", "brain/entities/甲公司", "任职");

      const llm = createMockLLM([
        JSON.stringify({
          entities: [
            { name: "张三", type: "person", relevance: "high", context: "张三在甲公司工作" },
            { name: "甲公司", type: "company", relevance: "high", context: "张三在甲公司工作" },
          ],
          relations: [
            { from: "张三", to: "甲公司", relation: "works_at", context: "张三在甲公司工作" },
          ],
          events: [],
        }),
      ]);

      const embedding = createMockEmbeddingProvider();
      const lance = createMockLanceDB();
      const dialogue = new DialogueIngest(db, embedding, lance as any, vaultPath, llm);

      const result = await dialogue.ingest("用户：张三在甲公司工作。");

      // Both entities already exist, relation already exists
      expect(result.newEntities).toBe(0);
      expect(result.newRelations).toBe(0);
      expect(result.skipped).toBe(2);
    });

    test("creates new relation between existing entities", async () => {
      // Pre-create two entities without relation
      db.prepare(
        "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
      ).run("brain/entities/李四", "entity", "李四", "brain/entities/李四.md", "h1");
      db.prepare(
        "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
      ).run("brain/entities/乙公司", "entity", "乙公司", "brain/entities/乙公司.md", "h1");

      const llm = createMockLLM([
        JSON.stringify({
          entities: [
            { name: "李四", type: "person", relevance: "high", context: "李四跳槽到乙公司" },
            { name: "乙公司", type: "company", relevance: "high", context: "李四跳槽到乙公司" },
          ],
          relations: [
            { from: "李四", to: "乙公司", relation: "works_at", context: "李四跳槽到乙公司" },
          ],
          events: [],
        }),
      ]);

      const embedding = createMockEmbeddingProvider();
      const lance = createMockLanceDB();
      const dialogue = new DialogueIngest(db, embedding, lance as any, vaultPath, llm);

      const result = await dialogue.ingest("用户：李四跳槽到乙公司了。");

      expect(result.newEntities).toBe(0);
      expect(result.newRelations).toBe(1);

      const links = db.prepare("SELECT * FROM links WHERE relation = '任职'").all() as any[];
      expect(links.length).toBe(1);
    });
  });

  describe("writes ingest_log", () => {
    test("logs dialogue ingest with summary", async () => {
      const llm = createMockLLM([
        JSON.stringify({
          entities: [{ name: "新人物", type: "person", relevance: "high", context: "新人物出现了" }],
          relations: [],
          events: [],
        }),
      ]);

      const embedding = createMockEmbeddingProvider();
      const lance = createMockLanceDB();
      const dialogue = new DialogueIngest(db, embedding, lance as any, vaultPath, llm);

      await dialogue.ingest("用户：新人物出现了");

      const logs = db.prepare("SELECT * FROM ingest_log WHERE action = 'dialogue'").all() as any[];
      expect(logs.length).toBe(1);
      const details = JSON.parse(logs[0].details);
      expect(details.newEntities).toBe(1);
    });
  });
});

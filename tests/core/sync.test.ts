import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
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
    deleteRawChunksByPageSlug: async () => {},
    close: async () => {},
    createFTSIndex: async () => {},
  };
}

function writeMdFile(
  vaultPath: string,
  filePath: string,
  frontmatter: Record<string, unknown>,
  body: string
) {
  const matter = [
    "---",
    ...Object.entries(frontmatter).map(([k, v]) => {
      if (Array.isArray(v)) return `${k}:\n${v.map((i) => `  - ${i}`).join("\n")}`;
      return `${k}: ${v}`;
    }),
    "---",
    "",
    body,
  ].join("\n");

  const fullPath = join(vaultPath, filePath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, matter, "utf-8");
}

describe("SyncManager", () => {
  const testDir = "/tmp/cbrain-test-sync";
  const dbPath = join(testDir, "test.sqlite");
  const vaultPath = join(testDir, "vault");
  let db: CBrainDB;
  let sync: SyncManager;
  let lance: ReturnType<typeof createMockLanceDB>;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(dbPath);
    lance = createMockLanceDB();
    const embedding = createMockEmbeddingProvider();
    sync = new SyncManager(db, embedding, lance as any, { chunkSize: 500 });
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  describe("syncAll", () => {
    test("syncs markdown files from vault to SQLite", async () => {
      writeMdFile(
        vaultPath,
        "entities/zhangsan.md",
        { title: "张三", type: "entity/person", slug: "entities/zhangsan", tags: ["人物"] },
        "张三是星辰科技的商务经理。\n\n他负责东区业务。"
      );

      const report = await sync.syncAll(vaultPath);

      expect(report.synced).toBe(1);
      expect(report.skipped).toBe(0);
      expect(report.errors).toBe(0);

      const row = db
        .prepare("SELECT * FROM pages WHERE slug = ?")
        .get("entities/zhangsan") as any;
      expect(row).not.toBeNull();
      expect(row.title).toBe("张三");
      expect(row.type).toBe("entity/person");
    });

    test("syncs multiple files", async () => {
      writeMdFile(vaultPath, "entities/a.md", { title: "A", type: "entity/person", slug: "entities/a" }, "Content A");
      writeMdFile(vaultPath, "concepts/b.md", { title: "B", type: "concept/concept", slug: "concepts/b" }, "Content B");
      writeMdFile(vaultPath, "events/c.md", { title: "C", type: "record", slug: "events/c" }, "Content C");

      const report = await sync.syncAll(vaultPath);
      expect(report.synced).toBe(3);
    });

    test("skips unchanged files on second sync", async () => {
      writeMdFile(vaultPath, "entities/unchanged.md", { title: "Unchanged", type: "entity/person", slug: "entities/unchanged" }, "Same content");

      await sync.syncAll(vaultPath);
      lance.added.length = 0;

      const report = await sync.syncAll(vaultPath);
      expect(report.skipped).toBe(1);
      expect(report.synced).toBe(0);
      expect(lance.added.length).toBe(0);
    });

    test("re-syncs when file content changes", async () => {
      writeMdFile(vaultPath, "entities/changed.md", { title: "Changed", type: "entity/person", slug: "entities/changed" }, "Original");
      await sync.syncAll(vaultPath);

      writeMdFile(vaultPath, "entities/changed.md", { title: "Changed", type: "entity/person", slug: "entities/changed" }, "Updated content");

      lance.added.length = 0;
      const report = await sync.syncAll(vaultPath);
      expect(report.synced).toBe(1);
      expect(lance.added.length).toBeGreaterThan(0);
    });

    test("chunks content and adds to LanceDB", async () => {
      const longBody = Array.from({ length: 10 }, (_, i) => `Paragraph ${i + 1}: `.repeat(20)).join("\n\n");
      writeMdFile(vaultPath, "entities/chunky.md", { title: "Chunky", type: "entity/person", slug: "entities/chunky" }, longBody);

      await sync.syncAll(vaultPath);

      expect(lance.added.length).toBeGreaterThan(0);
      const entry = lance.added.find((u) => u.pageSlug === "entities/chunky");
      expect(entry).toBeDefined();
      expect(entry!.chunks.length).toBeGreaterThan(1);
    });

    test("records sync in ingest_log", async () => {
      writeMdFile(vaultPath, "entities/logged.md", { title: "Logged", type: "entity/person", slug: "entities/logged" }, "Content");

      await sync.syncAll(vaultPath);

      const logs = db.prepare("SELECT * FROM ingest_log WHERE page_slug = ?").all("entities/logged") as any[];
      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0].action).toBe("sync");
    });

    test("skips non-markdown files", async () => {
      mkdirSync(join(vaultPath, "entities"), { recursive: true });
      writeFileSync(join(vaultPath, "entities/image.png"), "fake image", "utf-8");
      writeFileSync(join(vaultPath, "entities/data.json"), "{}", "utf-8");

      const report = await sync.syncAll(vaultPath);
      expect(report.synced).toBe(0);
      expect(report.errors).toBe(0);
    });

    test("handles malformed frontmatter gracefully", async () => {
      mkdirSync(join(vaultPath, "entities"), { recursive: true });
      writeFileSync(join(vaultPath, "entities/bad.md"), "no frontmatter at all, just raw text", "utf-8");

      const report = await sync.syncAll(vaultPath);
      // gray-matter parses plain text without error (empty frontmatter), so it syncs successfully
      expect(report.synced).toBe(1);
      expect(report.errors).toBe(0);
    });

    test("handles empty vault directory", async () => {
      const report = await sync.syncAll(vaultPath);
      expect(report.synced).toBe(0);
      expect(report.skipped).toBe(0);
      expect(report.errors).toBe(0);
    });
  });

  describe("syncPage", () => {
    test("syncs a single page by slug", async () => {
      writeMdFile(vaultPath, "brain/entities/person/single.md", { title: "Single", type: "entity/person", slug: "brain/entities/person/single" }, "Single page content");

      const result = await sync.syncPage("brain/entities/person/single", vaultPath);
      expect(result.success).toBe(true);

      const row = db.prepare("SELECT * FROM pages WHERE slug = ?").get("brain/entities/person/single") as any;
      expect(row).not.toBeNull();
      expect(row.title).toBe("Single");
    });

    test("returns failure for non-existent page", async () => {
      const result = await sync.syncPage("entities/ghost", vaultPath);
      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });

    test("skips if content unchanged", async () => {
      writeMdFile(vaultPath, "brain/entities/person/cached.md", { title: "Cached", type: "entity/person", slug: "brain/entities/person/cached" }, "Stable content");

      await sync.syncPage("brain/entities/person/cached", vaultPath);
      lance.added.length = 0;

      const result = await sync.syncPage("brain/entities/person/cached", vaultPath);
      expect(result.success).toBe(true);
      expect(result.skipped).toBe(true);
      expect(lance.added.length).toBe(0);
    });
  });

  describe("reports_to reconciliation", () => {
    test("syncPage creates graph link from frontmatter reports_to", async () => {
      // Target page must exist (FK constraint)
      writeMdFile(vaultPath, "brain/entities/person/boss.md", { title: "老板", type: "entity/person", slug: "brain/entities/person/boss" }, "老板内容");
      writeMdFile(vaultPath, "brain/entities/person/emp.md", { title: "员工", type: "entity/person", slug: "brain/entities/person/emp", reports_to: "brain/entities/person/boss" }, "员工内容");

      await sync.syncPage("brain/entities/person/boss", vaultPath);
      await sync.syncPage("brain/entities/person/emp", vaultPath);

      const links = db.getOutgoingLinks("brain/entities/person/emp").filter(l => l.relation === "reports_to");
      expect(links.length).toBe(1);
      expect(links[0].to_slug).toBe("brain/entities/person/boss");
    });

    test("syncPage skips if graph link already exists", async () => {
      writeMdFile(vaultPath, "brain/entities/person/boss2.md", { title: "老板2", type: "entity/person", slug: "brain/entities/person/boss2" }, "老板内容2");
      writeMdFile(vaultPath, "brain/entities/person/emp2.md", { title: "员工2", type: "entity/person", slug: "brain/entities/person/emp2", reports_to: "brain/entities/person/boss2" }, "员工内容2");

      await sync.syncPage("brain/entities/person/boss2", vaultPath);
      await sync.syncPage("brain/entities/person/emp2", vaultPath);

      // Sync again — should not duplicate
      await sync.syncPage("brain/entities/person/emp2", vaultPath);

      const links = db.getOutgoingLinks("brain/entities/person/emp2").filter(l => l.relation === "reports_to");
      expect(links.length).toBe(1);
    });

    test("syncAll reconciles reports_to from frontmatter", async () => {
      writeMdFile(vaultPath, "brain/entities/person/manager.md", { title: "经理", type: "entity/person", slug: "brain/entities/person/manager" }, "经理内容");
      writeMdFile(vaultPath, "brain/entities/person/sub.md", { title: "下属", type: "entity/person", slug: "brain/entities/person/sub", reports_to: "brain/entities/person/manager" }, "下属内容");

      const report = await sync.syncAll(vaultPath);
      expect(report.synced).toBe(2);

      const links = db.getOutgoingLinks("brain/entities/person/sub").filter(l => l.relation === "reports_to");
      expect(links.length).toBe(1);
      expect(links[0].to_slug).toBe("brain/entities/person/manager");
    });
  });

  describe("removeOrphans", () => {
    test("removes pages in SQLite but not in vault", async () => {
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
      ).run("entities/orphan", "entity/person", "Orphan", "entities/orphan.md", "hash1");
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
      ).run("entities/real", "entity/person", "Real", "entities/real.md", "hash2");

      writeMdFile(vaultPath, "entities/real.md", { title: "Real", type: "entity/person", slug: "entities/real" }, "Real content");

      const removed = await sync.removeOrphans(vaultPath);

      expect(removed).toContain("entities/orphan");
      expect(removed).not.toContain("entities/real");

      expect(db.prepare("SELECT * FROM pages WHERE slug = ?").get("entities/orphan")).toBeNull();
      expect(db.prepare("SELECT * FROM pages WHERE slug = ?").get("entities/real")).not.toBeNull();

      expect(lance.deleted).toContain("entities/orphan");
    });

    test("returns empty when no orphans", async () => {
      writeMdFile(vaultPath, "entities/only-real.md", { title: "OnlyReal", type: "entity/person", slug: "entities/only-real" }, "Content");

      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
      ).run("entities/only-real", "entity/person", "OnlyReal", "entities/only-real.md", "hash1");

      const removed = await sync.removeOrphans(vaultPath);
      expect(removed).toEqual([]);
    });

    test("removes multiple orphans", async () => {
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
      ).run("entities/orphan1", "entity/person", "O1", "o1.md", "h1");
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
      ).run("entities/orphan2", "entity/person", "O2", "o2.md", "h2");

      const removed = await sync.removeOrphans(vaultPath);
      expect(removed.length).toBe(2);
    });
  });
});

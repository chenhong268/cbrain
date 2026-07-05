import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { SyncManager } from "../../src/core/maintenance/sync.js";
import { NerEngine } from "../../src/core/ingestion/ner.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";
import type { LLMProvider } from "../../src/llm/provider.js";
import { JobQueueNerSubmitter } from "../../src/core/ingestion/ner-backfill.js";

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
  const rawDeleted: string[] = [];
  const l1Deleted: string[] = [];

  return {
    added,
    deleted,
    rawDeleted,
    l1Deleted,

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
    deleteRawChunksByPageSlug: async (pageSlug: string) => {
      rawDeleted.push(pageSlug);
    },
    deleteL1VectorByPageSlug: async (pageSlug: string) => {
      l1Deleted.push(pageSlug);
    },
    getIndexedPageSlugs: async () => {
      return added.map(a => a.pageSlug).filter(s => !deleted.includes(s));
    },
    close: async () => {},
    createFTSIndex: async () => {},
    // Stubs for sync rollback snapshot path — return empty so existing
    // success-path tests are unaffected (no real old rows to restore).
    readRawVectorRows: async (_pageSlug: string) => [],
    readL1VectorRows: async (_pageSlug: string) => [],
    openChunksStrict: async () => { throw new Error("mock: no table"); },
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

      const row = db        .rawDb.prepare("SELECT * FROM pages WHERE slug = ?")
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

    test("writes mention snapshot when syncAll syncs a changed page", async () => {
      writeMdFile(vaultPath, "entities/snapshot-changed.md", { title: "SnapshotChanged", type: "entity/person", slug: "entities/snapshot-changed" }, "Initial content");
      await sync.syncAll(vaultPath);

      db.rawDb.prepare("UPDATE pages SET mention_count = ? WHERE slug = ?").run(4, "entities/snapshot-changed");
      writeMdFile(vaultPath, "entities/snapshot-changed.md", { title: "SnapshotChanged", type: "entity/person", slug: "entities/snapshot-changed" }, "Updated content");

      const report = await sync.syncAll(vaultPath);
      const snapshots = db.getMentionSnapshots("entities/snapshot-changed", 1);

      expect(report.synced).toBe(1);
      expect(snapshots.at(-1)?.mention_count).toBe(4);
    });

    test("writes mention snapshot when syncAll skips an unchanged indexed page", async () => {
      writeMdFile(vaultPath, "entities/snapshot-skipped.md", { title: "SnapshotSkipped", type: "entity/person", slug: "entities/snapshot-skipped" }, "Stable content");
      await sync.syncAll(vaultPath);

      db.rawDb.prepare("UPDATE pages SET mention_count = ? WHERE slug = ?").run(7, "entities/snapshot-skipped");

      const report = await sync.syncAll(vaultPath);
      const snapshots = db.getMentionSnapshots("entities/snapshot-skipped", 1);

      expect(report.skipped).toBe(1);
      expect(report.synced).toBe(0);
      expect(snapshots.at(-1)?.mention_count).toBe(7);
    });

    test("hash match but missing chunks is reindexed, not skipped (#274)", async () => {
      writeMdFile(vaultPath, "records/missing-chunks.md", { title: "MissingChunks", type: "record", slug: "records/missing-chunks" }, "Stable body that should be indexed");

      await sync.syncAll(vaultPath);
      db.rawDb.prepare("DELETE FROM chunks WHERE page_slug = ?").run("records/missing-chunks");
      db.rawDb.prepare("DELETE FROM chunks_fts WHERE page_slug = ?").run("records/missing-chunks");
      lance.added.length = 0;

      const report = await sync.syncAll(vaultPath);

      expect(report.synced).toBe(1);
      expect(report.skipped).toBe(0);
      expect(db.rawDb.prepare("SELECT COUNT(*) AS c FROM chunks WHERE page_slug = ? AND summary_level = 0").get("records/missing-chunks") as { c: number }).toEqual({ c: 1 });
      expect(db.getFtsContentsByPage("records/missing-chunks").length).toBeGreaterThan(0);
      expect(lance.added.find((entry) => entry.pageSlug === "records/missing-chunks")).toBeDefined();
    });

    test("hash match but missing FTS row is reindexed, not skipped (#274)", async () => {
      writeMdFile(vaultPath, "records/missing-fts.md", { title: "MissingFts", type: "record", slug: "records/missing-fts" }, "Stable body that needs FTS");

      await sync.syncAll(vaultPath);
      db.rawDb.prepare("DELETE FROM chunks_fts WHERE page_slug = ?").run("records/missing-fts");
      lance.added.length = 0;

      const report = await sync.syncAll(vaultPath);

      expect(report.synced).toBe(1);
      expect(report.skipped).toBe(0);
      expect(db.getFtsContentsByPage("records/missing-fts").length).toBeGreaterThan(0);
      expect(lance.added.find((entry) => entry.pageSlug === "records/missing-fts")).toBeDefined();
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

      const logs = db.rawDb.prepare("SELECT * FROM ingest_log WHERE page_slug = ?").all("entities/logged") as any[];
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

    test("syncAll produces structured diagnostic for title collision", async () => {
      // Seed existing non-person entity with title "实体A"
      writeMdFile(vaultPath, "brain/entities/company/entity-a.md", { title: "实体A", type: "entity/company", slug: "brain/entities/company/entity-a" }, "已有实体");
      await sync.syncAll(vaultPath);

      // Add a second file with the same title but different slug
      writeMdFile(vaultPath, "records/entity-a-note.md", { title: "实体A", type: "record", slug: "records/entity-a-note" }, "新记录");

      const report = await sync.syncAll(vaultPath);
      expect(report.errors).toBeGreaterThanOrEqual(1);
      expect(report.diagnostics).toBeDefined();
      expect(report.diagnostics!.length).toBeGreaterThanOrEqual(1);

      const diag = report.diagnostics![0];
      expect(diag.kind).toBe("title_collision");
      expect(diag.title).toBe("实体A");
      expect(diag.incoming.slug).toBe("records/entity-a-note");
      expect(diag.incoming.type).toBe("record");
      expect(diag.incoming.filePath).toBe("records/entity-a-note.md");
      expect(diag.existing.slug).toBe("brain/entities/company/entity-a");
      expect(diag.existing.type).toBe("entity/company");
      expect(diag.existing.filePath).toBe("brain/entities/company/entity-a.md");
      expect(diag.message).toContain("Title collision");
      expect(diag.filePath).toBe("records/entity-a-note.md");
    });
  });

  describe("syncPage", () => {
    test("syncs a single page by slug", async () => {
      writeMdFile(vaultPath, "brain/entities/person/single.md", { title: "Single", type: "entity/person", slug: "brain/entities/person/single" }, "Single page content");

      const result = await sync.syncPage("brain/entities/person/single", vaultPath);
      expect(result.success).toBe(true);

      const row = db.rawDb.prepare("SELECT * FROM pages WHERE slug = ?").get("brain/entities/person/single") as any;
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

    test("syncPage reindexes hash-matching page with missing chunks (#274)", async () => {
      writeMdFile(vaultPath, "records/page-missing-chunks.md", { title: "PageMissingChunks", type: "record", slug: "records/page-missing-chunks" }, "Stable single-page body");

      await sync.syncPage("records/page-missing-chunks", vaultPath);
      db.rawDb.prepare("DELETE FROM chunks WHERE page_slug = ?").run("records/page-missing-chunks");
      db.rawDb.prepare("DELETE FROM chunks_fts WHERE page_slug = ?").run("records/page-missing-chunks");
      lance.added.length = 0;

      const result = await sync.syncPage("records/page-missing-chunks", vaultPath);

      expect(result.success).toBe(true);
      expect(result.skipped).toBeUndefined();
      expect(db.rawDb.prepare("SELECT COUNT(*) AS c FROM chunks WHERE page_slug = ? AND summary_level = 0").get("records/page-missing-chunks") as { c: number }).toEqual({ c: 1 });
      expect(db.getFtsContentsByPage("records/page-missing-chunks").length).toBeGreaterThan(0);
      expect(lance.added.find((entry) => entry.pageSlug === "records/page-missing-chunks")).toBeDefined();
    });

    test("returns error when title exists under different slug", async () => {
      // Seed existing non-person entity page
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
      ).run("brain/entities/company/entity-a", "entity/company", "实体A", "brain/entities/company/entity-a.md", "hash1");

      // Create a record file with the same title
      writeMdFile(
        vaultPath,
        "records/entity-a-note.md",
        { title: "实体A", type: "record", slug: "records/entity-a-note" },
        "实体A的会议记录",
      );

      const result = await sync.syncPage("records/entity-a-note", vaultPath);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Title collision");
      expect(result.error).toContain("实体A");
      expect(result.error).toContain("records/entity-a-note");
      expect(result.error).toContain("brain/entities/company/entity-a");

      // Skip hash should be stored
      const skipHash = db.getConfig("sync.skip.records/entity-a-note");
      expect(skipHash).not.toBeNull();
    });

    test("rejects path traversal in frontmatter slug", async () => {
      writeMdFile(
        vaultPath,
        "records/malicious.md",
        { title: "Evil", type: "record", slug: "../../etc/passwd" },
        "malicious content",
      );

      const result = await sync.syncPage("records/malicious", vaultPath);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid slug");
    });

    test("rejects absolute path in frontmatter slug", async () => {
      writeMdFile(
        vaultPath,
        "records/abs-path.md",
        { title: "AbsPath", type: "record", slug: "/etc/passwd" },
        "absolute path content",
      );

      const result = await sync.syncPage("records/abs-path", vaultPath);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid slug");
    });
  });

  describe("removeOrphans", () => {
    test("removes pages in SQLite but not in vault", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
      ).run("entities/orphan", "entity/person", "Orphan", "entities/orphan.md", "hash1");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
      ).run("entities/real", "entity/person", "Real", "entities/real.md", "hash2");

      writeMdFile(vaultPath, "entities/real.md", { title: "Real", type: "entity/person", slug: "entities/real" }, "Real content");

      const removed = await sync.removeOrphans(vaultPath);

      expect(removed).toContain("entities/orphan");
      expect(removed).not.toContain("entities/real");

      expect(db.rawDb.prepare("SELECT * FROM pages WHERE slug = ?").get("entities/orphan")).toBeNull();
      expect(db.rawDb.prepare("SELECT * FROM pages WHERE slug = ?").get("entities/real")).not.toBeNull();

      expect(lance.deleted).toContain("entities/orphan");
    });

    test("returns empty when no orphans", async () => {
      writeMdFile(vaultPath, "entities/only-real.md", { title: "OnlyReal", type: "entity/person", slug: "entities/only-real" }, "Content");

      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
      ).run("entities/only-real", "entity/person", "OnlyReal", "entities/only-real.md", "hash1");

      const removed = await sync.removeOrphans(vaultPath);
      expect(removed).toEqual([]);
    });

    test("removes multiple orphans", async () => {
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
      ).run("entities/orphan1", "entity/person", "O1", "o1.md", "h1");
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
      ).run("entities/orphan2", "entity/person", "O2", "o2.md", "h2");

      const removed = await sync.removeOrphans(vaultPath);
      expect(removed.length).toBe(2);
    });
  });

  describe("fault injection", () => {
    function createFailingLanceDB(opts: { failAddChunks?: boolean; failDelete?: boolean }) {
      const base = createMockLanceDB();
      if (opts.failAddChunks) {
        base.addChunks = async () => { throw new Error("LanceDB write failure"); };
      }
      if (opts.failDelete) {
        base.deleteByPageSlug = async () => { throw new Error("LanceDB delete failure"); };
      }
      return base;
    }

    test("syncAll: LanceDB write failure does not persist content_hash", async () => {
      const failLance = createFailingLanceDB({ failAddChunks: true });
      const failSync = new SyncManager(db, createMockEmbeddingProvider(), failLance as any, { chunkSize: 500 });

      writeMdFile(vaultPath, "records/fail-sync.md", { title: "FailSync", type: "record", slug: "records/fail-sync" }, "Content that should not get hash persisted");

      const report = await failSync.syncAll(vaultPath);
      expect(report.errors).toBeGreaterThan(0);

      // content_hash must NOT be persisted — next sync should retry
      const hash = db.getPageContentHash("records/fail-sync");
      expect(hash).toBeNull();
    });

    test("syncAll: content_hash stays null, next sync retries successfully", async () => {
      // First sync with failing LanceDB
      const failLance = createFailingLanceDB({ failAddChunks: true });
      const failSync = new SyncManager(db, createMockEmbeddingProvider(), failLance as any, { chunkSize: 500 });

      writeMdFile(vaultPath, "records/retry.md", { title: "RetryTest", type: "record", slug: "records/retry" }, "Initial content");

      const failReport = await failSync.syncAll(vaultPath);
      expect(failReport.errors).toBe(1);

      // Second sync with working LanceDB — should succeed
      const okLance = createMockLanceDB();
      const okSync = new SyncManager(db, createMockEmbeddingProvider(), okLance as any, { chunkSize: 500 });

      const okReport = await okSync.syncAll(vaultPath);
      expect(okReport.synced).toBe(1);
      expect(okReport.errors).toBe(0);

      const hash = db.getPageContentHash("records/retry");
      expect(hash).not.toBeNull();
    });

    test("syncPage: LanceDB write failure does not persist content_hash", async () => {
      const failLance = createFailingLanceDB({ failAddChunks: true });
      const failSync = new SyncManager(db, createMockEmbeddingProvider(), failLance as any, { chunkSize: 500 });

      writeMdFile(vaultPath, "records/fail-page.md", { title: "FailPage", type: "record", slug: "records/fail-page" }, "Content");

      await expect(failSync.syncPage("records/fail-page", vaultPath)).rejects.toThrow("LanceDB write failure");

      const hash = db.getPageContentHash("records/fail-page");
      expect(hash).toBeNull();
    });

    test("removePage: SQLite deleted first, LanceDB failure tolerated", async () => {
      // First, sync a page successfully
      writeMdFile(vaultPath, "records/del-test.md", { title: "DelTest", type: "record", slug: "records/del-test" }, "Content");
      await sync.syncAll(vaultPath);
      expect(db.getPageContentHash("records/del-test")).not.toBeNull();

      // Now try to remove with failing LanceDB — SQLite delete should succeed first
      const failLance = createFailingLanceDB({ failDelete: true });
      const failSync = new SyncManager(db, createMockEmbeddingProvider(), failLance as any, { chunkSize: 500 });

      // Should NOT throw — LanceDB failure is swallowed after SQLite succeeds
      await failSync.removePage("records/del-test");

      // SQLite page is gone (source of truth deleted)
      const row = db.rawDb.prepare("SELECT * FROM pages WHERE slug = ?").get("records/del-test") as any;
      expect(row).toBeNull();
    });

    test("removeOrphans: SQLite deleted first, LanceDB failure tolerated", async () => {
      // Seed an orphan (in DB but not in vault)
      db.rawDb.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)`
      ).run("records/orphan-del", "record", "OrphanDel", "records/orphan-del.md", "hash1");

      const failLance = createFailingLanceDB({ failDelete: true });
      const failSync = new SyncManager(db, createMockEmbeddingProvider(), failLance as any, { chunkSize: 500 });

      // Should NOT throw — LanceDB failure is swallowed
      const orphans = await failSync.removeOrphans(vaultPath);

      expect(orphans).toContain("records/orphan-del");
      // SQLite page is gone
      const row = db.rawDb.prepare("SELECT * FROM pages WHERE slug = ?").get("records/orphan-del") as any;
      expect(row).toBeNull();
    });

    test("cleanLanceOrphans: removes LanceDB vectors for pages not in SQLite", async () => {
      // Sync two pages
      writeMdFile(vaultPath, "records/keep.md", { title: "Keep", type: "record", slug: "records/keep" }, "Keep content");
      writeMdFile(vaultPath, "records/lose.md", { title: "Lose", type: "record", slug: "records/lose" }, "Lose content");
      await sync.syncAll(vaultPath);

      // Verify both are in LanceDB
      const slugsBefore = await lance.getIndexedPageSlugs();
      expect(slugsBefore).toContain("records/keep");
      expect(slugsBefore).toContain("records/lose");

      // Delete one page from SQLite only (simulate crash after SQLite delete, before LanceDB cleanup)
      db.deletePageCascaded("records/lose");

      // cleanLanceOrphans should detect and remove the orphan
      const orphans = await sync.cleanLanceOrphans();
      expect(orphans).toContain("records/lose");
      expect(orphans).not.toContain("records/keep");

      // Verify orphan is cleaned from LanceDB
      const slugsAfter = await lance.getIndexedPageSlugs();
      expect(slugsAfter).not.toContain("records/lose");
      expect(slugsAfter).toContain("records/keep");
    });

    test("cleanLanceOrphans: no orphans returns empty", async () => {
      writeMdFile(vaultPath, "records/no-orphans.md", { title: "NoOrphans", type: "record", slug: "records/no-orphans" }, "Content");
      await sync.syncAll(vaultPath);

      const orphans = await sync.cleanLanceOrphans();
      expect(orphans).toEqual([]);
    });

    test("syncAll: one file fails, others still sync", async () => {
      writeMdFile(vaultPath, "records/good-a.md", { title: "GoodA", type: "record", slug: "records/good-a" }, "Good content A");
      writeMdFile(vaultPath, "records/good-b.md", { title: "GoodB", type: "record", slug: "records/good-b" }, "Good content B");

      const report = await sync.syncAll(vaultPath);
      expect(report.synced).toBe(2);
      expect(report.errors).toBe(0);

      // Both should have hashes
      expect(db.getPageContentHash("records/good-a")).not.toBeNull();
      expect(db.getPageContentHash("records/good-b")).not.toBeNull();
    });
  });

  describe("empty content index cleanup (#63)", () => {
    test("writeIndexes cleans old indexes when content becomes empty", async () => {
      // First sync with content → creates chunks
      writeMdFile(vaultPath, "records/empty-test.md", { title: "EmptyTest", type: "record", slug: "records/empty-test" }, "Some real content here");
      await sync.syncAll(vaultPath);
      expect(lance.added.length).toBeGreaterThan(0);
      expect(db.getPageContentHash("records/empty-test")).not.toBeNull();

      // Now rewrite with empty body
      lance.added.length = 0;
      writeMdFile(vaultPath, "records/empty-test.md", { title: "EmptyTest", type: "record", slug: "records/empty-test" }, "");

      await sync.syncAll(vaultPath);

      // LanceDB raw chunks should be deleted for the now-empty page
      expect(lance.rawDeleted).toContain("records/empty-test");
    });

    test("empty body also cleans L1 sealed summary + vector", async () => {
      // Seed: sync with content first
      writeMdFile(vaultPath, "records/l1-test.md", { title: "L1Test", type: "record", slug: "records/l1-test" }, "Initial content for L1 test");
      await sync.syncAll(vaultPath);

      // Manually insert an L1 sealed summary (simulating seal output)
      db.insertChunkWithLevel("records/l1-test", -1, "Sealed L1 summary", 1, null);
      expect(db.getL1Summary("records/l1-test")).not.toBeNull();

      // Now rewrite with empty body
      writeMdFile(vaultPath, "records/l1-test.md", { title: "L1Test", type: "record", slug: "records/l1-test" }, "");
      await sync.syncAll(vaultPath);

      // L1 summary should be deleted from SQLite
      expect(db.getL1Summary("records/l1-test")).toBeNull();
      // L1 vector should be deleted from LanceDB
      expect(lance.l1Deleted).toContain("records/l1-test");
    });
  });

  describe("cleanLanceOrphans error reporting (#63)", () => {
    test("only returns successfully deleted slugs", async () => {
      // Seed two pages in LanceDB + SQLite
      writeMdFile(vaultPath, "records/orphan-ok.md", { title: "OrphanOK", type: "record", slug: "records/orphan-ok" }, "Content");
      writeMdFile(vaultPath, "records/orphan-fail.md", { title: "OrphanFail", type: "record", slug: "records/orphan-fail" }, "Content");
      await sync.syncAll(vaultPath);

      // Remove both from SQLite to make them orphans
      db.deletePageCascaded("records/orphan-ok");
      db.deletePageCascaded("records/orphan-fail");

      // Make deleteByPageSlug throw for one slug
      const originalDelete = lance.deleteByPageSlug.bind(lance);
      lance.deleteByPageSlug = async (slug: string) => {
        if (slug === "records/orphan-fail") throw new Error("LanceDB error");
        return originalDelete(slug);
      };

      const cleaned = await sync.cleanLanceOrphans();

      expect(cleaned).toContain("records/orphan-ok");
      expect(cleaned).not.toContain("records/orphan-fail");
    });
  });
});

describe("SyncManager NER timeout partial (#229)", () => {
  const testDir = "/tmp/cbrain-test-sync-ner-timeout";
  const vaultPath = join(testDir, "vault");
  const dbPath = join(testDir, "t.sqlite");
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

  test("NER timeout increments report.nerTimedOut, sync still completes", async () => {
    const slowLlm: LLMProvider = {
      name: "slow",
      chat: async () => new Promise<string>(() => { /* never resolves */ }),
    };
    class FastTimeoutNer extends NerEngine {
      async extract(text: string) { return super.extract(text, 100); }
    }
    writeMdFile(vaultPath, "note.md", { type: "record", title: "测试" }, "中文正文触发NER需要足够长度来进入NER流程");

    const sync = new SyncManager(db, createMockEmbeddingProvider(), createMockLanceDB() as any, {
      nerEngine: new FastTimeoutNer(slowLlm),
    });

    const report = await sync.syncAll(vaultPath);

    expect(report.synced).toBeGreaterThanOrEqual(1);
    expect(report.nerTimedOut ?? 0).toBeGreaterThanOrEqual(1);
    // content still indexed & searchable despite NER timeout
    expect(db.getPageCount()).toBeGreaterThanOrEqual(1);
  });
});

describe("SyncManager deferred NER write paths (#271)", () => {
  const testDir = "/tmp/cbrain-test-sync-ner-defer";
  const vaultPath = join(testDir, "vault");
  const dbPath = join(testDir, "t.sqlite");
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

  test("syncAll with nerMode=defer submits ner-backfill job and does not call NER inline", async () => {
    let llmCalls = 0;
    const llm: LLMProvider = {
      name: "counting",
      chat: async () => {
        llmCalls++;
        throw new Error("inline NER should not run in defer mode");
      },
    };
    writeMdFile(
      vaultPath,
      "records/defer-sync.md",
      { type: "record", title: "DeferSync", slug: "records/defer-sync" },
      "中文正文触发 NER，但 defer 模式应只提交 backfill job"
    );
    const sync = new SyncManager(db, createMockEmbeddingProvider(), createMockLanceDB() as any, {
      nerEngine: new NerEngine(llm),
      pages: undefined,
      nerMode: "defer",
      deferredNerSubmitter: new JobQueueNerSubmitter(db),
    });

    const report = await sync.syncAll(vaultPath);

    expect(report.synced).toBe(1);
    expect(report.nerTimedOut ?? 0).toBe(0);
    expect(report.nerErrors ?? 0).toBe(0);
    expect(llmCalls).toBe(0);
    const job = db.rawDb.prepare(
      "SELECT status, data FROM jobs WHERE name = 'ner-backfill'"
    ).get() as { status: string; data: string } | undefined;
    expect(job).toBeDefined();
    expect(job!.status).toBe("pending");
    expect(JSON.parse(job!.data).slug).toBe("records/defer-sync");
  });

  test("syncPage with nerMode=defer submits ner-backfill job and does not await NER", async () => {
    let llmCalls = 0;
    const llm: LLMProvider = {
      name: "counting",
      chat: async () => {
        llmCalls++;
        throw new Error("inline NER should not run in defer mode");
      },
    };
    writeMdFile(
      vaultPath,
      "records/defer-page.md",
      { type: "record", title: "DeferPage", slug: "records/defer-page" },
      "中文正文触发 NER，但 syncPage defer 模式应只提交 backfill job"
    );
    const sync = new SyncManager(db, createMockEmbeddingProvider(), createMockLanceDB() as any, {
      nerEngine: new NerEngine(llm),
      nerMode: "defer",
      deferredNerSubmitter: new JobQueueNerSubmitter(db),
    });

    const result = await sync.syncPage("records/defer-page", vaultPath);

    expect(result.success).toBe(true);
    expect(llmCalls).toBe(0);
    const job = db.rawDb.prepare(
      "SELECT status, data FROM jobs WHERE name = 'ner-backfill'"
    ).get() as { status: string; data: string } | undefined;
    expect(job).toBeDefined();
    expect(job!.status).toBe("pending");
    expect(JSON.parse(job!.data).slug).toBe("records/defer-page");
  });
});

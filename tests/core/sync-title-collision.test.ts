import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { PageManager } from "../../src/core/page.js";
import { SyncManager } from "../../src/core/maintenance/sync.js";
import type { LanceDBManager } from "../../src/storage/lancedb.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";

describe("sync title collision", () => {
  const testDir = "/tmp/cbrain-test-title-collision";
  const vaultPath = join(testDir, "vault");
  const dbPath = join(testDir, "test.sqlite");
  let db: CBrainDB;
  let syncMgr: SyncManager;

  const stubEmbedding: EmbeddingProvider = {
    embed: async () => ({ embedding: [0.1], tokenCount: 1 }),
    embedBatch: async (texts) => texts.map(() => ({ embedding: [0.1], tokenCount: 1 })),
    dimensions: 1,
  };

  /** Mock LanceDB — no real connection needed */
  function createMockLance(): LanceDBManager {
    return {
      connect: async () => {},
      warmup: async () => ({ elapsedMs: 0, tables: [] }),
      search: async () => [],
      addChunks: async () => {},
      deleteByPageSlug: async () => {},
      deleteRawChunksByPageSlug: async () => {},
      deleteL1VectorByPageSlug: async () => {},
      // Rollback-safety snapshot/restore hooks (#185); mock holds no vectors.
      readRawVectorRows: async () => [],
      readL1VectorRows: async () => [],
      getIndexedPageSlugs: async () => [],
      getOrCreateTable: async () => ({} as never),
      searchInsights: async () => [],
    } as unknown as LanceDBManager;
  }

  function makeSyncMgr(): SyncManager {
    const lance = createMockLance();
    const pages = new PageManager(db, vaultPath);
    return new SyncManager(db, stubEmbedding, lance, { pages });
  }

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    mkdirSync(join(vaultPath, "records"), { recursive: true });
    db = new CBrainDB(dbPath);
    syncMgr = makeSyncMgr();
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("syncAll: title collision reported once, not replayed on second sync", async () => {
    db.rawDb.prepare(
      `INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash, mention_count, tier)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("brain/entities/company/zhu-ti-a", "entity/company", "主题A", "brain/entities/company/zhu-ti-a.md", "hash-old", 0, 3);

    writeFileSync(
      join(vaultPath, "records", "zhu-ti-a.md"),
      `---\ntitle: "主题A"\ntype: record\nslug: records/zhu-ti-a\n---\nAnother page`,
    );

    // First sync: should report collision
    const report1 = await syncMgr.syncAll(vaultPath);
    const collisionDiag = report1.diagnostics?.filter(d => d.kind === "title_collision") ?? [];
    expect(collisionDiag.length).toBe(1);
    expect(collisionDiag[0].title).toBe("主题A");
    expect(report1.errors).toBe(1);

    // Second sync: should NOT report collision again (skip hash match)
    const report2 = await syncMgr.syncAll(vaultPath);
    const collisionDiag2 = report2.diagnostics?.filter(d => d.kind === "title_collision") ?? [];
    expect(collisionDiag2.length).toBe(0);
    expect(report2.errors).toBe(0);
  });

  test("syncAll: content hash stored in config on collision", async () => {
    db.rawDb.prepare(
      `INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash, mention_count, tier)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("brain/entities/company/zhu-ti-b", "entity/company", "主题B", "brain/entities/company/zhu-ti-b.md", "hash-old", 0, 3);

    writeFileSync(
      join(vaultPath, "records", "zhu-ti-b.md"),
      `---\ntitle: "主题B"\ntype: record\nslug: records/zhu-ti-b\n---\nContent`,
    );

    await syncMgr.syncAll(vaultPath);

    const skipHash = db.getConfig("sync.skip.records/zhu-ti-b");
    expect(skipHash).not.toBeNull();
  });

  // ─── Gap fix #1: syncPage collision handling ────────────────────

  test("syncPage: collision stores skip hash and returns error", async () => {
    db.rawDb.prepare(
      `INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash, mention_count, tier)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("brain/entities/company/zhu-ti-c", "entity/company", "主题C", "brain/entities/company/zhu-ti-c.md", "hash-old", 0, 3);

    writeFileSync(
      join(vaultPath, "records", "zhu-ti-c.md"),
      `---\ntitle: "主题C"\ntype: record\nslug: records/zhu-ti-c\n---\nPage content C`,
    );

    const result = await syncMgr.syncPage("records/zhu-ti-c", vaultPath);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Title collision");

    // Skip hash should be stored
    const skipHash = db.getConfig("sync.skip.records/zhu-ti-c");
    expect(skipHash).not.toBeNull();
  });

  test("syncPage: skip hash with collision still present returns skipped", async () => {
    db.rawDb.prepare(
      `INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash, mention_count, tier)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("brain/entities/company/zhu-ti-d", "entity/company", "主题D", "brain/entities/company/zhu-ti-d.md", "hash-old", 0, 3);

    const content = `---\ntitle: "主题D"\ntype: record\nslug: records/zhu-ti-d\n---\nPage content D`;
    writeFileSync(join(vaultPath, "records", "zhu-ti-d.md"), content);

    // First sync to store skip hash
    await syncMgr.syncPage("records/zhu-ti-d", vaultPath);

    // Second sync should skip via skip hash
    const result = await syncMgr.syncPage("records/zhu-ti-d", vaultPath);
    expect(result.skipped).toBe(true);
  });

  // ─── Gap fix #2: collision resolution auto-recovery ─────────────

  test("syncPage: collision resolved → skip hash cleared, file syncs normally", async () => {
    db.rawDb.prepare(
      `INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash, mention_count, tier)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("brain/entities/company/zhu-ti-e", "entity/company", "主题E", "brain/entities/company/zhu-ti-e.md", "hash-old", 0, 3);

    const content = `---\ntitle: "主题E"\ntype: record\nslug: records/zhu-ti-e\n---\nPage content E`;
    writeFileSync(join(vaultPath, "records", "zhu-ti-e.md"), content);

    // First sync → collision → skip hash stored
    await syncMgr.syncPage("records/zhu-ti-e", vaultPath);
    expect(db.getConfig("sync.skip.records/zhu-ti-e")).not.toBeNull();

    // Resolve collision by deleting the conflicting entity
    db.rawDb.prepare("DELETE FROM pages WHERE slug = ?").run("brain/entities/company/zhu-ti-e");

    // Second sync → collision gone → should clear skip hash and sync
    const result = await syncMgr.syncPage("records/zhu-ti-e", vaultPath);
    expect(result.success).toBe(true);
    expect(result.skipped).toBeUndefined();

    // Skip hash should be cleared
    expect(db.getConfig("sync.skip.records/zhu-ti-e")).toBeNull();
    // Page should now be in DB
    expect(db.getPageContentHash("records/zhu-ti-e")).not.toBeNull();
  });

  test("syncAll: collision resolved → skip hash cleared, file syncs normally", async () => {
    db.rawDb.prepare(
      `INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash, mention_count, tier)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("brain/entities/company/zhu-ti-f", "entity/company", "主题F", "brain/entities/company/zhu-ti-f.md", "hash-old", 0, 3);

    writeFileSync(
      join(vaultPath, "records", "zhu-ti-f.md"),
      `---\ntitle: "主题F"\ntype: record\nslug: records/zhu-ti-f\n---\nPage content F`,
    );

    // First syncAll → collision → skip hash
    const report1 = await syncMgr.syncAll(vaultPath);
    expect(report1.errors).toBe(1);
    expect(db.getConfig("sync.skip.records/zhu-ti-f")).not.toBeNull();

    // Resolve collision
    db.rawDb.prepare("DELETE FROM pages WHERE slug = ?").run("brain/entities/company/zhu-ti-f");

    // Second syncAll → should sync the file (not skip it)
    const report2 = await syncMgr.syncAll(vaultPath);
    expect(report2.errors).toBe(0);
    expect(report2.synced).toBeGreaterThanOrEqual(1);

    // Skip hash cleared, page now in DB
    expect(db.getConfig("sync.skip.records/zhu-ti-f")).toBeNull();
    expect(db.getPageContentHash("records/zhu-ti-f")).not.toBeNull();
  });

  // ─── Gap fix #3: skip hash cleanup on deletion ──────────────────

  test("removePage cleans up skip hash", async () => {
    const slug = "records/test-remove";
    db.setConfig(`sync.skip.${slug}`, "some-hash-value");

    // Seed a page so removePage has something to delete
    db.rawDb.prepare(
      `INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash, mention_count, tier)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(slug, "record", "TestRemove", "records/test-remove.md", "h", 0, 3);

    await syncMgr.removePage(slug);

    expect(db.getConfig(`sync.skip.${slug}`)).toBeNull();
  });

  test("removeOrphans cleans up skip hashes for orphaned pages", async () => {
    const slug = "records/orphan-page";
    db.setConfig(`sync.skip.${slug}`, "orphan-hash");

    // Seed a page that points to a non-existent vault file
    db.rawDb.prepare(
      `INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash, mention_count, tier)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(slug, "record", "OrphanPage", "records/orphan-page.md", "h", 0, 3);

    // No vault file created → removeOrphans should pick it up
    const orphans = await syncMgr.removeOrphans(vaultPath);
    expect(orphans).toContain(slug);
    expect(db.getConfig(`sync.skip.${slug}`)).toBeNull();
  });

  test("syncAll: record/person title collision promotes the person page", async () => {
    db.rawDb.prepare(
      `INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash, mention_count, tier)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("records/entity-a", "record", "实体A", "records/entity-a.md", "hash-old", 0, 3);

    writeFileSync(
      join(vaultPath, "records", "entity-a.md"),
      `---\ntitle: "实体A"\ntype: record\nslug: records/entity-a\n---\n旧记录`,
    );
    mkdirSync(join(vaultPath, "brain", "entities", "person"), { recursive: true });
    writeFileSync(
      join(vaultPath, "brain", "entities", "person", "entity-a.md"),
      `---\ntitle: "实体A"\ntype: entity/person\nslug: brain/entities/person/entity-a\n---\n人物页`,
    );

    const report = await syncMgr.syncAll(vaultPath);

    expect(report.errors).toBe(0);
    const promoted = db.getPage("brain/entities/person/entity-a");
    expect(promoted).not.toBeNull();
    expect(promoted!.type).toBe("entity/person");
    expect(db.getPage("records/entity-a")).toBeNull();
    expect(existsSync(join(vaultPath, "records", "entity-a.md"))).toBe(false);
  });
});

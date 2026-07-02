import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { IngestManager } from "../../src/core/ingestion/ingest.js";
import { normalizeAndHashBody } from "../../src/core/shared.js";
import { PageManager } from "../../src/core/page.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";

function createMockEmbeddingProvider() {
  let embedCallCount = 0;
  const provider = {
    dimensions: 128,
    embed: async (text: string) => {
      embedCallCount++;
      const vec = new Array(128).fill(0);
      for (let i = 0; i < text.length; i++) {
        vec[i % 128] += text.charCodeAt(i) / 65536;
      }
      return { embedding: vec, tokenCount: text.length };
    },
    embedBatch: async (texts: string[]) =>
      texts.map((t) => {
        embedCallCount++;
        const vec = new Array(128).fill(0);
        for (let i = 0; i < t.length; i++) {
          vec[i % 128] += t.charCodeAt(i) / 65536;
        }
        return { embedding: vec, tokenCount: t.length };
      }),
    get callCount() { return embedCallCount; },
    resetCallCount() { embedCallCount = 0; },
  };
  return provider;
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
    // Rollback-safety hooks read by SyncManager's snapshot/restore (#185).
    // Mock Lance holds no real vectors, so snapshots are empty — exercises
    // the snapshot/restore path without weakening production fail-closed logic.
    readRawVectorRows: async () => [],
    readL1VectorRows: async () => [],
    close: async () => {},
    createFTSIndex: async () => {},
  };
}

describe("Ingest dedup", () => {
  const testDir = "/tmp/cbrain-test-ingest-dedup";
  const dbPath = join(testDir, "test.sqlite");
  const vaultPath = join(testDir, "vault");
  let db: CBrainDB;
  let ingest: IngestManager;
  let embedding: ReturnType<typeof createMockEmbeddingProvider>;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(dbPath);
    embedding = createMockEmbeddingProvider();
    const lance = createMockLanceDB();
    ingest = new IngestManager(db, embedding, lance as any, vaultPath);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  const BODY = "这是一段测试内容，用于验证去重功能。内容完全相同但标题不同。";

  // ─── Core dedup logic ───────────────────────────────────────

  test("cross-slug: same body different title returns duplicate", async () => {
    const first = await ingest.ingest({ content: BODY, title: "去重测试A", type: "text" });
    expect(first.outcome).toBe("created");

    const second = await ingest.ingest({ content: BODY, title: "去重测试B", type: "text" });
    expect(second.outcome).toBe("duplicate");
    expect(second.duplicateOf).toBeDefined();
    expect(second.duplicateOf!.slug).toBe(first.slug);
    expect(second.duplicateOf!.title).toBe("去重测试A");
    expect(second.linksExtracted).toBe(0);
  });

  test("cross-slug: duplicate is not written to DB", async () => {
    await ingest.ingest({ content: BODY, title: "去重测试A", type: "text" });
    await ingest.ingest({ content: BODY, title: "去重测试B", type: "text" });

    const pages = db.listPages({ type: "record" });
    expect(pages).toHaveLength(1);
  });

  test("same-slug same-body: re-ingest returns duplicate no-op", async () => {
    const first = await ingest.ingest({ content: BODY, title: "同标题测试", type: "text" });
    expect(first.outcome).toBe("created");

    embedding.resetCallCount();
    const second = await ingest.ingest({ content: BODY, title: "同标题测试", type: "text" });
    expect(second.outcome).toBe("duplicate");
    expect(second.duplicateOf!.slug).toBe(first.slug);
    expect(embedding.callCount).toBe(0);
  });

  test("same-slug different body: updates normally and refreshes hash", async () => {
    const first = await ingest.ingest({ content: BODY, title: "更新测试", type: "text" });
    expect(first.outcome).toBe("created");

    const newBody = "这是完全不同的内容，应该正常更新。";
    const second = await ingest.ingest({ content: newBody, title: "更新测试", type: "text" });
    expect(second.outcome).toBe("updated");
    expect(second.duplicateOf).toBeUndefined();

    const newHash = normalizeAndHashBody(newBody);
    expect(db.getPageIngestHash(second.slug)).toBe(newHash);
  });

  test("allowDuplicate=true bypasses dedup and creates second page", async () => {
    const first = await ingest.ingest({ content: BODY, title: "允许重复A", type: "text" });
    expect(first.outcome).toBe("created");

    const second = await ingest.ingest({
      content: BODY,
      title: "允许重复B",
      type: "text",
      allowDuplicate: true,
    });
    expect(second.outcome).toBe("created");
    expect(second.duplicateOf).toBeUndefined();
    expect(second.slug).not.toBe(first.slug);

    const pages = db.listPages({ type: "record" });
    expect(pages).toHaveLength(2);
  });

  test("allowDuplicate=true writes override audit log post-commit", async () => {
    const first = await ingest.ingest({ content: BODY, title: "审计测试A", type: "text" });
    await ingest.ingest({ content: BODY, title: "审计测试B", type: "text", allowDuplicate: true });

    const logs = (db as any).prepare(
      "SELECT details FROM ingest_log WHERE action = 'ingest'"
    ).all() as Array<{ details: string }>;
    const overrideLog = logs.find(l => {
      try { return JSON.parse(l.details).duplicateOverride === true; } catch { return false; }
    });
    expect(overrideLog).toBeDefined();
    const details = JSON.parse(overrideLog!.details);
    expect(details.matchedHash).toBeDefined();
    expect(details.matchedSlug).toBe(first.slug);
  });

  test("entity person bypasses dedup (entity append path)", async () => {
    const first = await ingest.ingest({
      content: "张三：是我们的同事，负责技术。",
      type: "text",
    });
    expect(first.outcome).toBe("created");

    const result = await ingest.ingest({
      content: "张三：是我们的同事，最近升职了。",
      type: "text",
    });
    expect(result.outcome).toBe("updated");
    expect(result.slug).toBe(first.slug);
  });

  test("different body does not deduplicate", async () => {
    await ingest.ingest({ content: "第一段内容", title: "内容A", type: "text" });
    const second = await ingest.ingest({ content: "完全不同的第二段内容", title: "内容B", type: "text" });
    expect(second.outcome).toBe("created");
    expect(second.duplicateOf).toBeUndefined();
  });

  test("markdown: different frontmatter same body returns duplicate", async () => {
    const md1 = "---\ntitle: MD测试A\ntags: [tag1]\n---\n\n" + BODY;
    const md2 = "---\ntitle: MD测试B\ntags: [tag2, tag3]\n---\n\n" + BODY;

    const first = await ingest.ingest({ content: md1, type: "markdown" });
    expect(first.outcome).toBe("created");

    const second = await ingest.ingest({ content: md2, type: "markdown" });
    expect(second.outcome).toBe("duplicate");
    expect(second.duplicateOf!.title).toBe("MD测试A");
  });

  test("insight type dedup works", async () => {
    const first = await ingest.ingest({ content: BODY, title: "洞察A", pageType: "insight", type: "text" });
    expect(first.outcome).toBe("created");

    const second = await ingest.ingest({ content: BODY, title: "洞察B", pageType: "insight", type: "text" });
    expect(second.outcome).toBe("duplicate");
  });

  test("cross-type dedup: same body as record then insight", async () => {
    const first = await ingest.ingest({ content: BODY, title: "记录版", type: "text" });
    expect(first.outcome).toBe("created");

    const second = await ingest.ingest({ content: BODY, title: "洞察版", pageType: "insight", type: "text" });
    expect(second.outcome).toBe("duplicate");
  });

  // ─── Normalization ──────────────────────────────────────────

  test("CRLF/LF normalization produces same hash", () => {
    const crlfBody = "line one\r\nline two\r\nline three";
    const lfBody = "line one\nline two\nline three";
    expect(normalizeAndHashBody(crlfBody)).toBe(normalizeAndHashBody(lfBody));
  });

  test("standalone CR normalized to LF", () => {
    const crBody = "line one\rline two\rline three";
    const lfBody = "line one\nline two\nline three";
    expect(normalizeAndHashBody(crBody)).toBe(normalizeAndHashBody(lfBody));
  });

  test("surrounding whitespace trimmed in hash", () => {
    const padded = "  \n  content here  \n  ";
    const trimmed = "content here";
    expect(normalizeAndHashBody(padded)).toBe(normalizeAndHashBody(trimmed));
  });

  // ─── Failure safety ─────────────────────────────────────────

  test("hash is NOT stored on ingest failure (embed throws)", async () => {
    const failEmbedding: EmbeddingProvider = {
      dimensions: 128,
      embed: async () => { throw new Error("Embedding failed!"); },
      embedBatch: async () => { throw new Error("Embedding failed!"); },
    };
    const failLance = createMockLanceDB();
    const failIngest = new IngestManager(db, failEmbedding, failLance as any, vaultPath);

    try {
      await failIngest.ingest({ content: "失败测试内容", title: "失败测试", type: "text" });
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("Embedding failed");
    }

    const slug = "records/shi-bai-ce-shi";
    expect(db.getPageIngestHash(slug)).toBeNull();
  });

  // ─── P1: Stale hash invalidation via PageManager ────────────

  test("PageManager.update with body change clears ingest hash", async () => {
    const first = await ingest.ingest({ content: BODY, title: "失效测试", type: "text" });
    expect(first.outcome).toBe("created");

    const slug = first.slug;
    expect(db.getPageIngestHash(slug)).not.toBeNull();

    const pages = new PageManager(db, vaultPath);
    pages.update(slug, { body: "完全不同的新内容" });

    expect(db.getPageIngestHash(slug)).toBeNull();
  });

  test("PageManager.update with tags-only does NOT clear ingest hash", async () => {
    const first = await ingest.ingest({ content: BODY, title: "标签测试", type: "text" });
    const slug = first.slug;
    const originalHash = db.getPageIngestHash(slug);
    expect(originalHash).not.toBeNull();

    const pages = new PageManager(db, vaultPath);
    pages.update(slug, { tags: ["new-tag"] });

    expect(db.getPageIngestHash(slug)).toBe(originalHash);
  });

  test("stale hash: PageManager.update to B, re-ingest A → created", async () => {
    const first = await ingest.ingest({ content: BODY, title: "失效链路测试", type: "text" });
    expect(first.outcome).toBe("created");

    const pages = new PageManager(db, vaultPath);
    pages.update(first.slug, { body: "完全不同的新内容B" });
    expect(db.getPageIngestHash(first.slug)).toBeNull();

    const third = await ingest.ingest({ content: BODY, title: "新标题A", type: "text" });
    expect(third.outcome).toBe("created");
    expect(third.duplicateOf).toBeUndefined();
  });

  // ─── P1: Sync stale hash — fault injection ──────────────────

  test("sync preserves ingest hash on index failure (cleared only after success)", async () => {
    const { SyncManager } = await import("../../src/core/maintenance/sync.js");
    const { writeFileSync } = await import("node:fs");
    const { hashContent } = await import("../../src/core/shared.js");
    const { stringifyFrontmatter } = await import("../../src/utils/frontmatter.js");

    // Step 1: Ingest body A — establishes ingest hash
    const first = await ingest.ingest({ content: BODY, title: "Sync失效测试", type: "text" });
    expect(db.getPageIngestHash(first.slug)).not.toBeNull();
    const slug = first.slug;

    // Step 2: Directly modify the vault file to new content B
    // This simulates external vault edit (e.g. Obsidian user editing the file).
    // Content hash in DB is now stale (still matches old file).
    const page = db.getPage(slug)!;
    const newBody = "全新的vault内容B，完全不同于原始内容A";
    const filePath = join(vaultPath, page.file_path);
    const newContent = stringifyFrontmatter(
      { title: "Sync失效测试", type: "record", slug, tags: [], tier: 3, created_at: page.created_at, updated_at: new Date().toISOString() },
      newBody,
    );
    writeFileSync(filePath, newContent, "utf-8");

    // Manually set a fake ingest hash to prove sync clears it
    db.updateIngestHash(slug, "fakeoldhash123456");

    // Step 3: Create a SyncManager with a failing embedder to simulate index failure
    const failEmbedding: EmbeddingProvider = {
      dimensions: 128,
      embed: async () => { throw new Error("Index write failed!"); },
      embedBatch: async () => { throw new Error("Index write failed!"); },
    };
    const failLance = createMockLanceDB();
    const syncMgr = new SyncManager(db, failEmbedding, failLance as any, {
      pages: new PageManager(db, vaultPath),
    });

    // syncPage should detect content change, then fail on embed — leaving ingest
    // hash untouched (rollback safety: index failure must not invalidate dedup hash)
    try {
      await syncMgr.syncPage(slug, vaultPath);
      expect.unreachable("syncPage should have thrown on embed failure");
    } catch (e) {
      expect((e as Error).message).toContain("Index write failed");
    }

    // Ingest hash preserved (compensation restores pre-sync state)
    expect(db.getPageIngestHash(slug)).toBe("fakeoldhash123456");

    // Content hash should NOT be updated (retains old value for retry)
    const contentHash = db.getPageContentHash(slug);
    expect(contentHash).not.toBeNull();
    expect(contentHash).not.toBe(hashContent(newContent));

    // Step 4: Ingest original body A under new title — must succeed, not duplicate
    const reingest = await ingest.ingest({ content: BODY, title: "Sync后新摄取", type: "text" });
    expect(reingest.outcome).toBe("created");
    expect(reingest.duplicateOf).toBeUndefined();
  });

  test("syncPage: frontmatter-only change preserves ingest hash", async () => {
    const { SyncManager } = await import("../../src/core/maintenance/sync.js");
    const { writeFileSync: writeFile } = await import("node:fs");
    const { stringifyFrontmatter } = await import("../../src/utils/frontmatter.js");

    // Step 1: Ingest body A
    const first = await ingest.ingest({ content: BODY, title: "FM同步测试", type: "text" });
    const slug = first.slug;
    const originalHash = db.getPageIngestHash(slug);
    expect(originalHash).not.toBeNull();

    // Step 2: Modify only frontmatter (tags) in vault file, keep body identical
    const page = db.getPage(slug)!;
    const filePath = join(vaultPath, page.file_path);
    const newContent = stringifyFrontmatter(
      { title: "FM同步测试", type: "record", slug, tags: ["new-tag-1", "new-tag-2"], tier: 3, created_at: page.created_at, updated_at: new Date().toISOString() },
      BODY,  // Same body
    );
    writeFile(filePath, newContent, "utf-8");

    // Step 3: syncPage with working embedder — should succeed
    const syncMgr = new SyncManager(db, embedding, createMockLanceDB() as any, {
      pages: new PageManager(db, vaultPath),
    });
    const result = await syncMgr.syncPage(slug, vaultPath);
    expect(result.success).toBe(true);
    expect(result.skipped).not.toBe(true); // Did sync (content hash changed)

    // Step 4: Ingest hash should be PRESERVED (body didn't change)
    expect(db.getPageIngestHash(slug)).toBe(originalHash);

    // Step 5: Ingest same body → should be duplicate
    const dup = await ingest.ingest({ content: BODY, title: "FM后去重测试", type: "text" });
    expect(dup.outcome).toBe("duplicate");
  });

  // ─── P1: Override audit post-commit ─────────────────────────

  test("override audit NOT written when embed fails", async () => {
    await ingest.ingest({ content: BODY, title: "审计失败A", type: "text" });

    const failEmbedding: EmbeddingProvider = {
      dimensions: 128,
      embed: async () => { throw new Error("Embedding failed!"); },
      embedBatch: async () => { throw new Error("Embedding failed!"); },
    };
    const failLance = createMockLanceDB();
    const failIngest = new IngestManager(db, failEmbedding, failLance as any, vaultPath);

    try {
      await failIngest.ingest({ content: BODY, title: "审计失败B", type: "text", allowDuplicate: true });
      expect.unreachable("Should have thrown");
    } catch {
      // Expected
    }

    const logs = (db as any).prepare(
      "SELECT details FROM ingest_log WHERE action = 'ingest'"
    ).all() as Array<{ details: string }>;
    const overrideLog = logs.find(l => {
      try { return JSON.parse(l.details).duplicateOverride === true; } catch { return false; }
    });
    expect(overrideLog).toBeUndefined();
  });

  // ─── P2: Rollback restores original ingest hash ─────────────

  test("rollback on existing page restores original ingest hash", async () => {
    const first = await ingest.ingest({ content: BODY, title: "回滚测试", type: "text" });
    const slug = first.slug;
    const originalHash = db.getPageIngestHash(slug);
    expect(originalHash).not.toBeNull();

    const failEmbedding: EmbeddingProvider = {
      dimensions: 128,
      embed: async () => { throw new Error("Embedding failed after update!"); },
      embedBatch: async () => { throw new Error("Embedding failed after update!"); },
    };
    const failLance = createMockLanceDB();
    const failIngest = new IngestManager(db, failEmbedding, failLance as any, vaultPath);

    try {
      await failIngest.ingest({ content: "全新的不同内容用于回滚", title: "回滚测试", type: "text" });
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("Embedding failed");
    }

    expect(db.getPageIngestHash(slug)).toBe(originalHash);
  });

  // ─── P2: No side effects on duplicate branch ────────────────

  test("duplicate branch has zero side effects", async () => {
    await ingest.ingest({ content: BODY, title: "无副作用A", type: "text" });

    const pagesBefore = db.listPages({ type: "record" });
    const logCountBefore = (db as any).prepare("SELECT COUNT(*) as c FROM ingest_log").get() as { c: number };

    embedding.resetCallCount();
    const second = await ingest.ingest({ content: BODY, title: "无副作用B", type: "text" });
    expect(second.outcome).toBe("duplicate");

    // No embed call
    expect(embedding.callCount).toBe(0);

    // No new pages
    const pagesAfter = db.listPages({ type: "record" });
    expect(pagesAfter).toHaveLength(pagesBefore.length);

    // No new ingest_log entries
    const logCountAfter = (db as any).prepare("SELECT COUNT(*) as c FROM ingest_log").get() as { c: number };
    expect(logCountAfter.c).toBe(logCountBefore.c);

    // No vault file created for the duplicate slug
    const dupSlug = second.slug;
    expect(existsSync(join(vaultPath, `${dupSlug}.md`))).toBe(false);
  });

  // ─── P2: Real legacy migration ──────────────────────────────

  test("real legacy migration: old DB without column migrates correctly", () => {
    const migrateDir = "/tmp/cbrain-test-legacy-migrate";
    const migrateDbPath = join(migrateDir, "legacy.sqlite");
    if (existsSync(migrateDir)) rmSync(migrateDir, { recursive: true });
    mkdirSync(migrateDir, { recursive: true });

    // Step 1: Build a legacy DB with a pages table that has the CHECK constraint
    // but does NOT have ingest_content_hash. Simulates a DB at v6 schema.
    const rawDb = new Database(migrateDbPath);
    rawDb.exec("PRAGMA journal_mode = WAL");
    // Create minimal tables needed by CBrainDB's IF NOT EXISTS statements
    rawDb.exec(`
      CREATE TABLE pages (
        slug TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('entity', 'concept', 'record', 'insight')),
        title TEXT NOT NULL,
        file_path TEXT NOT NULL,
        content_hash TEXT,
        tier INTEGER DEFAULT 3 CHECK(tier BETWEEN 1 AND 3),
        mention_count INTEGER DEFAULT 0,
        expires_at TEXT,
        confidence_decay REAL DEFAULT 1.0,
        hotness_score REAL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    rawDb.exec("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT)");
    // Mark earlier migrations as done so they don't try to re-run
    rawDb.exec("INSERT INTO config (key, value) VALUES ('migration_v5_raw_to_records', '1')");
    rawDb.exec("INSERT INTO config (key, value) VALUES ('migration_v6_ontology_types', '1')");
    // Insert a legacy page
    rawDb.exec("INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES ('records/legacy-page', 'record', 'Legacy Page', 'records/legacy-page.md', 'abc123')");
    rawDb.close();

    // Step 2: Open with CBrainDB — should run v7 migration only
    const migratedDb = new CBrainDB(migrateDbPath);

    // Column should now exist
    const cols = (migratedDb as any).prepare("PRAGMA table_info(pages)").all() as Array<{ name: string }>;
    const colNames = cols.map(c => c.name);
    expect(colNames).toContain("ingest_content_hash");

    // Legacy page should still exist with null hash
    const page = migratedDb.getPage("records/legacy-page");
    expect(page).not.toBeNull();
    expect(page!.title).toBe("Legacy Page");
    expect(migratedDb.getPageIngestHash("records/legacy-page")).toBeNull();

    // Partial index should exist
    const indexes = (migratedDb as any).prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_pages_ingest_hash'").all() as Array<{ name: string }>;
    expect(indexes).toHaveLength(1);

    migratedDb.close();

    // Step 3: Reopen — migration should be idempotent (v7 flag set)
    const reopened = new CBrainDB(migrateDbPath);
    const pageAfter = reopened.getPage("records/legacy-page");
    expect(pageAfter).not.toBeNull();
    expect(pageAfter!.title).toBe("Legacy Page");
    reopened.close();

    rmSync(migrateDir, { recursive: true });
  });
});

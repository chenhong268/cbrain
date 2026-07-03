import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { rebuildLanceIndex, type FsOps } from "../../src/storage/lance-rebuild.js";
import { LanceDBManager } from "../../src/storage/lancedb.js";

/**
 * Real deterministic fake embedding provider matching 2048 dimensions.
 */
function fakeEmbeddingProvider() {
  return {
    dimensions: 2048 as const,
    embed: async (text: string) => {
      const vec = new Array(2048).fill(0);
      for (let i = 0; i < text.length; i++) vec[i % 2048] += text.charCodeAt(i) / 65536;
      return { embedding: vec, tokenCount: text.length };
    },
    embedBatch: async (texts: string[]) =>
      texts.map((t) => {
        const vec = new Array(2048).fill(0);
        for (let i = 0; i < t.length; i++) vec[i % 2048] += t.charCodeAt(i) / 65536;
        return { embedding: vec, tokenCount: t.length };
      }),
  };
}

const TEST_DIR = "/tmp/cbrain-test-lance-rebuild";

describe("Atomic LanceDB rebuild", () => {
  const dbPath = join(TEST_DIR, "test.sqlite");
  const lancePath = join(TEST_DIR, "lance");
  const vaultPath = join(TEST_DIR, "vault");
  let db: CBrainDB;
  const embedding = fakeEmbeddingProvider();

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(dbPath);
  });

  afterEach(() => {
    db.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  // ── Fresh build (no live) ──

  test("builds fresh index when no live directory exists", async () => {
    db.rawDb.prepare(
      "INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)",
    ).run("entities/a", "A", "entities/a.md", "hash-a");
    db.rawDb.prepare(
      "INSERT OR IGNORE INTO chunks (page_slug, chunk_index, content, summary_level) VALUES (?, 0, ?, 0)",
    ).run("entities/a", "content for a");

    const result = await rebuildLanceIndex(lancePath, db, embedding);

    expect(result.chunksRebuilt).toBe(1);
    expect(result.errors).toBe(0);
    expect(result.backupPath).toBeNull();
    expect(existsSync(lancePath)).toBe(true);

    const lance = new LanceDBManager();
    await lance.connect(lancePath);
    const results = await lance.search(new Float32Array(2048), 5);
    expect(results.length).toBeGreaterThan(0);
    await lance.close();
  });

  // ── Chunks + insights rebuild with verification ──

  test("rebuilds both chunks and insights, insights searchable by id", async () => {
    db.rawDb.prepare(
      "INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)",
    ).run("entities/x", "X", "entities/x.md", "hash-x");
    db.rawDb.prepare(
      "INSERT OR IGNORE INTO chunks (page_slug, chunk_index, content, summary_level) VALUES (?, 0, ?, 0)",
    ).run("entities/x", "chunk content");

    const insightInfo = db.rawDb.prepare(
      "INSERT INTO insights (content, type, source_type, status) VALUES (?, 'synthesis', 'reflect', 'active') RETURNING id",
    ).get("Test insight content for rebuild") as Record<string, number>;
    const insightId = insightInfo.id;

    const result = await rebuildLanceIndex(lancePath, db, embedding);

    expect(result.chunksRebuilt).toBe(1);
    expect(result.insightsRebuilt).toBe(1);
    expect(result.errors).toBe(0);

    // Verify insights are searchable by id
    const lance = new LanceDBManager();
    await lance.connect(lancePath);
    const insightResults = await lance.searchInsights(new Float32Array(2048), 5);
    expect(insightResults.length).toBeGreaterThan(0);
    expect(insightResults[0].content).toContain("Test insight");
    expect(insightResults[0].id).toBe(insightId);
    await lance.close();
  });

  // ── Corrupted live → backup created ──

  test("replaces corrupted live index and keeps backup", async () => {
    mkdirSync(lancePath, { recursive: true });
    writeFileSync(join(lancePath, "chunks.lance"), "corrupted garbage");

    db.rawDb.prepare(
      "INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)",
    ).run("entities/b", "B", "entities/b.md", "hash-b");
    db.rawDb.prepare(
      "INSERT OR IGNORE INTO chunks (page_slug, chunk_index, content, summary_level) VALUES (?, 0, ?, 0)",
    ).run("entities/b", "content for b");

    const result = await rebuildLanceIndex(lancePath, db, embedding);

    expect(result.chunksRebuilt).toBe(1);
    expect(result.backupPath).toBeTruthy();
    expect(existsSync(result.backupPath!)).toBe(true);
    expect(existsSync(lancePath)).toBe(true);

    // New live index readable
    const lance = new LanceDBManager();
    await lance.connect(lancePath);
    const results = await lance.search(new Float32Array(2048), 5);
    expect(results.length).toBeGreaterThan(0);
    await lance.close();

    // Backup contains old data
    expect(existsSync(join(result.backupPath!, "chunks.lance"))).toBe(true);
  });

  test("never connects to corrupt live LanceDB — staging-only rebuild", async () => {
    // Verify rebuildLanceIndex does NOT try to open the live directory as LanceDB.
    // It should only create staging, build, and swap at filesystem level.
    mkdirSync(lancePath, { recursive: true });
    // Put completely broken lance data — any attempt to connect would throw
    writeFileSync(join(lancePath, "chunks.lance"), "NOT A VALID LANCE DB AT ALL");
    writeFileSync(join(lancePath, "insights.lance"), "GARBAGE");

    db.rawDb.prepare(
      "INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)",
    ).run("entities/corrupt-test", "CorruptTest", "entities/corrupt-test.md", "hash-ct");
    db.rawDb.prepare(
      "INSERT OR IGNORE INTO chunks (page_slug, chunk_index, content, summary_level) VALUES (?, 0, ?, 0)",
    ).run("entities/corrupt-test", "content for corrupt-test");

    // This must succeed — rebuildLanceIndex never opens the live path as LanceDB
    const result = await rebuildLanceIndex(lancePath, db, embedding);
    expect(result.chunksRebuilt).toBe(1);
    expect(result.errors).toBe(0);
    expect(result.backupPath).toBeTruthy();

    // New live should be valid
    const verifyLance = new LanceDBManager();
    await verifyLance.connect(lancePath);
    const results = await verifyLance.search(new Float32Array(2048), 5);
    expect(results.length).toBeGreaterThan(0);
    await verifyLance.close();
  });

  // ── SQLite state preservation ──

  test("preserves SQLite content_hash, links, timeline, and vault files", async () => {
    mkdirSync(lancePath, { recursive: true });
    const liveLance = new LanceDBManager();
    await liveLance.connect(lancePath);
    await liveLance.addChunks([{ pageSlug: "entities/c", chunkIndex: 0, content: "old content", vector: new Float32Array(2048) }]);
    await liveLance.close();

    // Seed full SQLite state
    db.rawDb.prepare(
      "INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)",
    ).run("entities/c", "C", "entities/c.md", "original-hash");
    db.rawDb.prepare(
      "INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)",
    ).run("entities/other", "Other", "entities/other.md", "hash-other");
    db.rawDb.prepare(
      "INSERT OR IGNORE INTO chunks (page_slug, chunk_index, content, summary_level) VALUES (?, 0, ?, 0)",
    ).run("entities/c", "content for c");
    db.rawDb.prepare(
      "INSERT OR IGNORE INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)",
    ).run("entities/c", "entities/other", "提及");
    db.rawDb.prepare(
      "INSERT OR IGNORE INTO timeline (page_slug, event_date, summary, source) VALUES (?, ?, ?, ?)",
    ).run("entities/c", "2024-01-01", "Started working", "manual");

    // Create a vault file
    mkdirSync(join(vaultPath, "entities"), { recursive: true });
    writeFileSync(join(vaultPath, "entities", "c.md"), "---\ntitle: C\ntype: entity\n---\nContent", "utf-8");

    await rebuildLanceIndex(lancePath, db, embedding);

    // Verify SQLite unchanged
    const afterHash = db.rawDb.prepare("SELECT content_hash FROM pages WHERE slug = ?").get("entities/c") as any;
    expect(afterHash.content_hash).toBe("original-hash");

    const afterLinks = db.rawDb.prepare("SELECT COUNT(*) as cnt FROM links WHERE from_slug = ?").get("entities/c") as any;
    expect(afterLinks.cnt).toBe(1);

    const afterTimeline = db.rawDb.prepare("SELECT COUNT(*) as cnt FROM timeline WHERE page_slug = ?").get("entities/c") as any;
    expect(afterTimeline.cnt).toBe(1);

    // Verify vault file unchanged (rebuild doesn't touch vault files)
    const vaultContent = require("node:fs").readFileSync(join(vaultPath, "entities", "c.md"), "utf-8");
    expect(vaultContent).toContain("title: C");
    expect(vaultContent).toContain("Content");
  });

  // ── Embedding failure protects live ──

  test("embedding failure throws and leaves live index untouched", async () => {
    mkdirSync(lancePath, { recursive: true });
    const liveLance = new LanceDBManager();
    await liveLance.connect(lancePath);
    await liveLance.addChunks([{ pageSlug: "entities/d", chunkIndex: 0, content: "live data", vector: new Float32Array(2048) }]);
    await liveLance.close();

    db.rawDb.prepare(
      "INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)",
    ).run("entities/d", "D", "entities/d.md", "hash-d");
    db.rawDb.prepare(
      "INSERT OR IGNORE INTO chunks (page_slug, chunk_index, content, summary_level) VALUES (?, 0, ?, 0)",
    ).run("entities/d", "content for d");

    const failingEmbedding = {
      dimensions: 2048,
      embed: async () => { throw new Error("embedding service down"); },
      embedBatch: async () => { throw new Error("embedding service down"); },
    };

    await expect(rebuildLanceIndex(lancePath, db, failingEmbedding as any)).rejects.toThrow();

    // Live index must still be readable
    const verifyLance = new LanceDBManager();
    await verifyLance.connect(lancePath);
    const results = await verifyLance.search(new Float32Array(2048), 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].pageSlug).toBe("entities/d");
    await verifyLance.close();
  });

  // ── Rollback test: swap failure restores backup ──

  test("swap failure rolls back from backup", async () => {
    // Create a healthy live index
    mkdirSync(lancePath, { recursive: true });
    const liveLance = new LanceDBManager();
    await liveLance.connect(lancePath);
    await liveLance.addChunks([{ pageSlug: "entities/rollback", chunkIndex: 0, content: "live rollback data", vector: new Float32Array(2048) }]);
    await liveLance.close();

    db.rawDb.prepare(
      "INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)",
    ).run("entities/rollback", "Rollback", "entities/rollback.md", "hash-rb");
    db.rawDb.prepare(
      "INSERT OR IGNORE INTO chunks (page_slug, chunk_index, content, summary_level) VALUES (?, 0, ?, 0)",
    ).run("entities/rollback", "content for rollback");

    // Inject FsOps: first rename (live→backup) succeeds, second rename (staging→live) fails
    let renameCallCount = 0;
    const injectedFs: FsOps = {
      existsSync,
      mkdirSync,
      renameSync(from: string, to: string) {
        renameCallCount++;
        // staging → live (2nd rename) always fails
        if (renameCallCount === 2) {
          throw new Error("EIO: cannot rename staging to live");
        }
        renameSync(from, to);
      },
      rmSync,
    };

    await expect(rebuildLanceIndex(lancePath, db, embedding, injectedFs)).rejects.toThrow("SWAP_FAILED_ROLLED_BACK");

    // Live index should still be the original (rollback restored it)
    const verifyLance = new LanceDBManager();
    await verifyLance.connect(lancePath);
    const results = await verifyLance.search(new Float32Array(2048), 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].pageSlug).toBe("entities/rollback");
    expect(results[0].content).toBe("live rollback data");
    await verifyLance.close();

    // No staging directory left
    const entries = readdirSync(join(lancePath, ".."));
    const stagingDirs = entries.filter(e => e.includes(".rebuild-"));
    expect(stagingDirs.length).toBe(0);
  });

  test("swap failure AND rollback failure: error contains real paths, live missing, backup preserved", async () => {
    // Create a healthy live index
    mkdirSync(lancePath, { recursive: true });
    const liveLance = new LanceDBManager();
    await liveLance.connect(lancePath);
    await liveLance.addChunks([{ pageSlug: "entities/dbl-fail", chunkIndex: 0, content: "original data", vector: new Float32Array(2048) }]);
    await liveLance.close();

    db.rawDb.prepare(
      "INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)",
    ).run("entities/dbl-fail", "DblFail", "entities/dbl-fail.md", "hash-df");
    db.rawDb.prepare(
      "INSERT OR IGNORE INTO chunks (page_slug, chunk_index, content, summary_level) VALUES (?, 0, ?, 0)",
    ).run("entities/dbl-fail", "content for dbl-fail");

    // Inject FsOps: 2nd rename (staging→live) fails, 3rd rename (backup→live) also fails
    let renameCallCount = 0;
    const injectedFs: FsOps = {
      existsSync,
      mkdirSync,
      renameSync(from: string, to: string) {
        renameCallCount++;
        if (renameCallCount === 2) throw new Error("EIO: staging→live failed");
        if (renameCallCount === 3) throw new Error("EIO: backup→live rollback failed");
        renameSync(from, to);
      },
      rmSync,
    };

    // Single call — capture error for assertions
    let caught: Error | null = null;
    try {
      await rebuildLanceIndex(lancePath, db, embedding, injectedFs);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("SWAP_FAILED_AND_ROLLBACK_FAILED");

    // Error must contain real paths for manual recovery
    expect(caught!.message).toContain(`live=${lancePath}`);
    expect(caught!.message).toContain("backup=");
    expect(caught!.message).toContain("staging=");
    expect(caught!.message).toContain("Recovery: mv ");

    // Extract backup path from error message for further assertions
    const backupMatch = caught!.message.match(/backup=([^\n]+)/);
    expect(backupMatch).not.toBeNull();
    const backupPath = backupMatch![1];

    // Live path should NOT exist (live→backup succeeded, rollback failed)
    expect(existsSync(lancePath)).toBe(false);

    // Backup should exist and contain the old live data
    expect(existsSync(backupPath)).toBe(true);
    const backupLance = new LanceDBManager();
    await backupLance.connect(backupPath);
    const backupResults = await backupLance.search(new Float32Array(2048), 5);
    expect(backupResults.length).toBeGreaterThan(0);
    expect(backupResults[0].pageSlug).toBe("entities/dbl-fail");
    expect(backupResults[0].content).toBe("original data");
    await backupLance.close();

    // Staging should be cleaned up by finally
    const parentEntries = readdirSync(join(lancePath, ".."));
    const stagingDirs = parentEntries.filter(e => e.includes(".rebuild-"));
    expect(stagingDirs.length).toBe(0);
  });

  // ── Empty SQLite no-op ──

  test("empty SQLite with existing live does no-op", async () => {
    // Create a healthy live index
    mkdirSync(lancePath, { recursive: true });
    const liveLance = new LanceDBManager();
    await liveLance.connect(lancePath);
    await liveLance.addChunks([{ pageSlug: "entities/existing", chunkIndex: 0, content: "existing data", vector: new Float32Array(2048) }]);
    await liveLance.close();

    // No chunks or insights in SQLite
    const result = await rebuildLanceIndex(lancePath, db, embedding);

    expect(result.chunksRebuilt).toBe(0);
    expect(result.insightsRebuilt).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.backupPath).toBeNull();

    // Live index untouched
    const verifyLance = new LanceDBManager();
    await verifyLance.connect(lancePath);
    const results = await verifyLance.search(new Float32Array(2048), 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].pageSlug).toBe("entities/existing");
    await verifyLance.close();
  });

  test("empty SQLite without live creates empty dir", async () => {
    const result = await rebuildLanceIndex(lancePath, db, embedding);

    expect(result.chunksRebuilt).toBe(0);
    expect(result.errors).toBe(0);
    expect(existsSync(lancePath)).toBe(true);
  });

  // ── Staging cleanup ──

  test("no staging directory left after successful rebuild", async () => {
    db.rawDb.prepare(
      "INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)",
    ).run("entities/f", "F", "entities/f.md", "hash-f");
    db.rawDb.prepare(
      "INSERT OR IGNORE INTO chunks (page_slug, chunk_index, content, summary_level) VALUES (?, 0, ?, 0)",
    ).run("entities/f", "content for f");

    await rebuildLanceIndex(lancePath, db, embedding);

    const entries = readdirSync(TEST_DIR);
    const stagingDirs = entries.filter(e => e.includes(".rebuild-"));
    expect(stagingDirs.length).toBe(0);
  });

  test("no staging directory left after failed rebuild", async () => {
    db.rawDb.prepare(
      "INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)",
    ).run("entities/g", "G", "entities/g.md", "hash-g");
    db.rawDb.prepare(
      "INSERT OR IGNORE INTO chunks (page_slug, chunk_index, content, summary_level) VALUES (?, 0, ?, 0)",
    ).run("entities/g", "content for g");

    const failingEmbedding = {
      dimensions: 2048,
      embed: async () => { throw new Error("fail"); },
      embedBatch: async () => { throw new Error("fail"); },
    };

    try {
      await rebuildLanceIndex(lancePath, db, failingEmbedding as any);
    } catch { /* expected */ }

    const entries = readdirSync(TEST_DIR);
    const stagingDirs = entries.filter(e => e.includes(".rebuild-"));
    expect(stagingDirs.length).toBe(0);
  });

  // ── Backup name collision resistance ──

  test("backup name includes millisecond timestamp for uniqueness", async () => {
    mkdirSync(lancePath, { recursive: true });
    const liveLance = new LanceDBManager();
    await liveLance.connect(lancePath);
    await liveLance.addChunks([{ pageSlug: "entities/h", chunkIndex: 0, content: "h", vector: new Float32Array(2048) }]);
    await liveLance.close();

    db.rawDb.prepare(
      "INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)",
    ).run("entities/h", "H", "entities/h.md", "hash-h");
    db.rawDb.prepare(
      "INSERT OR IGNORE INTO chunks (page_slug, chunk_index, content, summary_level) VALUES (?, 0, ?, 0)",
    ).run("entities/h", "content for h");

    const result = await rebuildLanceIndex(lancePath, db, embedding);
    expect(result.backupPath).toBeTruthy();
    // Backup name should contain timestamp + UUID fragment
    expect(result.backupPath!).toMatch(/backup-\d+-[0-9a-f]{4}$/);
  });

  // ── #269: L1 summary chunks must be rebuilt, not silently dropped ──

  test("#269 rebuilds L1 summary chunks (chunkIndex = -1) alongside L0 raw chunks", async () => {
    // A sealed page owns BOTH an L0 raw chunk and an L1 summary chunk in SQLite.
    // The atomic rebuild must embed BOTH. Previously the SELECT filtered to
    // summary_level=0, so the staging index had zero L1 rows and the directory
    // swap silently destroyed every existing L1 summary vector — while the fsck
    // probe (which counts any row as coverage) reported the page as covered.
    db.rawDb.prepare(
      "INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)",
    ).run("entities/sealed-269", "Sealed269", "entities/sealed-269.md", "hash-sealed-269");
    db.rawDb.prepare(
      "INSERT OR IGNORE INTO chunks (page_slug, chunk_index, content, summary_level) VALUES (?, 0, ?, 0)",
    ).run("entities/sealed-269", "raw detail body ALPHA");
    db.rawDb.prepare(
      "INSERT OR IGNORE INTO chunks (page_slug, chunk_index, content, summary_level) VALUES (?, -1, ?, 1)",
    ).run("entities/sealed-269", "sealed page summary BETA");

    const result = await rebuildLanceIndex(lancePath, db, embedding);
    expect(result.errors).toBe(0);

    // Inspect the live chunks table directly — both chunkIndex tiers must exist.
    const lancedb = await import("@lancedb/lancedb");
    const conn = await lancedb.connect(lancePath);
    const table = await conn.openTable("chunks");
    const rows = await table.query()
      .select(["pageSlug", "chunkIndex", "content"])
      .toArray() as Array<{ pageSlug: string; chunkIndex: number; content: string }>;
    conn.close();

    const l0 = rows.filter((r) => r.chunkIndex >= 0);
    const l1 = rows.filter((r) => r.chunkIndex === -1);
    expect(l0).toHaveLength(1);
    expect(l0[0].content).toBe("raw detail body ALPHA");
    expect(l1).toHaveLength(1);
    expect(l1[0].content).toBe("sealed page summary BETA");
    expect(l1[0].pageSlug).toBe("entities/sealed-269");
  });
});

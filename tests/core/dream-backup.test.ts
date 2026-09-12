import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { runDream } from "../../src/core/maintenance/dream.js";
import { CleanupError, SyncManager } from "../../src/core/maintenance/sync.js";
import type { EnrichManager } from "../../src/core/maintenance/enrich.js";
import type { HealthChecker } from "../../src/core/maintenance/health.js";
import type { Logger } from "../../src/core/logger.js";
import type { LanceDBManager } from "../../src/storage/lancedb.js";

function makeMockSync(): SyncManager {
  return {
    syncAll: async () => ({ synced: 0, skipped: 0, errors: 0 }),
    removeOrphans: async () => [],
    cleanStaleStubs: async () => [],
    cleanLanceOrphans: async () => [],
  } as unknown as SyncManager;
}

function makeMockEnrich(): EnrichManager {
  return { enrichAll: () => [] } as unknown as EnrichManager;
}

function makeMockHealth(): HealthChecker {
  return {
    checkAll: async () => ({
      timestamp: new Date().toISOString(),
      overallStatus: "pass",
      dimensions: [],
      reportPaths: {},
    }),
  } as unknown as HealthChecker;
}

describe("dream backup retention", () => {
  let testDir: string;
  let db: CBrainDB;
  let outputsDir: string;
  let logger: Logger;
  let dbPath: string;
  let vaultPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "cbrain-dream-backup-"));
    dbPath = join(testDir, "brain.sqlite");
    vaultPath = join(testDir, "vault");
    outputsDir = join(testDir, "runtime");
    mkdirSync(vaultPath, { recursive: true });
    mkdirSync(outputsDir, { recursive: true });
    db = new CBrainDB(dbPath);
    logger = {
      info: () => {},
      warn: () => {},
      error: () => {},
    } as unknown as Logger;
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("real stub cleanup waits for deletion and preserves partial count on refusal", async () => {
    let complete!: (value: boolean) => void;
    let started!: () => void;
    const startedDeletion = new Promise<void>(resolve => { started = resolve; });
    const pending = new Promise<boolean>(resolve => { complete = resolve; });
    const pages = {
      getBySlug: (slug: string) => ({ body: slug === "page/source" ? "unrelated text" : "Auto-extracted from [[page/source]]" }),
      delete: async (slug: string) => { started(); return slug === "page/a" ? pending : false; },
    };
    db.getAutoExtractedPages = () => [{ slug: "page/a", title: "实体A" }, { slug: "page/b", title: "实体B" }] as ReturnType<CBrainDB["getAutoExtractedPages"]>;
    const sync = new SyncManager(db, {} as never, {} as never, { pages: pages as never });
    let settled = false;
    const cleanup = sync.cleanStaleStubs(vaultPath);
    void cleanup.then(() => { settled = true; }, () => { settled = true; });
    await startedDeletion;
    expect(settled).toBe(false);
    complete(true);
    await expect(cleanup).rejects.toMatchObject({ name: "CleanupError", completedCount: 1 });
  });

  test("partial cleanup retains completed counts in the Dream report", async () => {
    const sync = makeMockSync();
    sync.cleanLanceOrphans = async () => { throw new CleanupError(1); };
    const report = await runDream(vaultPath, db, sync, makeMockEnrich(), makeMockHealth(), outputsDir, logger);
    expect(report.stages.cleanup.lanceOrphans).toBe(1);
    expect(report.stages.cleanup.errors).toEqual(["cleanup_cleanLanceOrphans_failed"]);
  });

  test.each(["removeOrphans", "cleanStaleStubs", "cleanLanceOrphans"] as const)("reports %s failure in every result surface", async operation => {
    const sync = makeMockSync();
    let lanceCalled = false;
    sync.cleanLanceOrphans = async () => { lanceCalled = true; return ["page/实体A"]; };
    sync[operation] = async () => { throw new Error("private-cleanup-detail"); };
    let progress: unknown;
    const report = await runDream(vaultPath, db, sync, makeMockEnrich(), makeMockHealth(), outputsDir, logger,
      undefined, undefined, undefined, undefined, (stage, detail) => { if (stage === "cleanup") progress = detail; });
    const code = `cleanup_${operation}_failed`;
    expect(report.stages.cleanup.errors).toEqual([code]);
    expect(progress).toEqual(report.stages.cleanup);
    expect(report.brief).toContain(code);
    const saved = readFileSync(join(outputsDir, "dream", `dream-${report.timestamp.slice(0, 10)}.md`), "utf8");
    expect(saved).toContain(code);
    expect(JSON.stringify(report)).not.toContain("private-cleanup-detail");
    expect(saved).not.toContain("private-cleanup-detail");
    expect(db.getConfig("dream.lock")).toBeNull();
    if (operation !== "cleanLanceOrphans") {
      expect(lanceCalled).toBe(false);
      expect(report.stages.cleanup.skipped).toEqual(["cleanLanceOrphans"]);
    }
  });

  test("successful empty cleanup has no failure diagnostics", async () => {
    const report = await runDream(vaultPath, db, makeMockSync(), makeMockEnrich(), makeMockHealth(), outputsDir, logger);
    expect(report.stages.cleanup).toEqual({ orphans: 0, staleStubs: 0, lanceOrphans: 0, errors: [], skipped: [] });
  });

  test("cancellation after sync preserves completed work and releases the Dream lock", async () => {
    let cancelled = false;
    let enriched = false;
    const sync = makeMockSync();
    sync.syncAll = async () => {
      db.setConfig("probe.synced", "yes");
      return { synced: 1, skipped: 0, errors: 0 };
    };
    const enrich = makeMockEnrich();
    enrich.enrichAll = () => { enriched = true; return []; };
    await expect(runDream(
      vaultPath, db, sync, enrich, makeMockHealth(), outputsDir, logger,
      undefined, undefined, undefined, undefined,
      stage => { if (stage === "sync") cancelled = true; },
      undefined, undefined, undefined,
      () => { if (cancelled) throw new DOMException("Job cancelled", "AbortError"); },
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(db.getConfig("probe.synced")).toBe("yes");
    expect(enriched).toBe(false);
    expect(db.getConfig("dream.lock")).toBeNull();
  });

  test.each(["page_cleanup", "health", "search_quality"])("cancellation at %s starts no later side effect", async boundary => {
    let cancelled = false;
    const sync = makeMockSync();
    const health = makeMockHealth();
    if (boundary === "page_cleanup") {
      sync.removeOrphans = async () => { cancelled = true; return []; };
      sync.cleanLanceOrphans = async () => { db.setConfig("probe.late", "yes"); return []; };
    }
    if (boundary === "health") {
      const check = health.checkAll.bind(health);
      health.checkAll = async () => { const result = await check(); cancelled = true; return result; };
      db.cleanMentionSnapshots = () => { db.setConfig("probe.late", "yes"); return 0; };
    }
    await expect(runDream(
      vaultPath, db, sync, makeMockEnrich(), health, outputsDir, logger,
      undefined, undefined, undefined, undefined,
      stage => { if (boundary === "search_quality" && stage === boundary) cancelled = true; },
      undefined, undefined, undefined,
      () => { if (cancelled) throw new DOMException("Job cancelled", "AbortError"); },
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(db.getConfig("probe.late")).toBeNull();
    expect(existsSync(join(outputsDir, "indexes"))).toBe(false);
    expect(db.getConfig("dream.lock")).toBeNull();
  });

  test("sync parse failures survive dream report and progress projection (#491)", async () => {
    const sync = makeMockSync();
    sync.syncAll = async () => ({ synced: 1, skipped: 0, errors: 0, nerParseErrors: 1 });
    let progress: unknown;
    const report = await runDream(
      vaultPath, db, sync, makeMockEnrich(), makeMockHealth(), outputsDir, logger,
      undefined, undefined, undefined, undefined,
      (stage, detail) => { if (stage === "sync") progress = detail; },
    );
    expect(report.stages.sync.nerParseErrors).toBe(1);
    expect(progress).toMatchObject({ nerParseErrors: 1 });
    expect(report.brief).toContain("1 次解析失败");
    expect(readFileSync(join(outputsDir, "dream", `dream-${report.timestamp.slice(0, 10)}.md`), "utf8")).toContain("1 NER 解析失败");
  });

  test.each([-1024, 1024])("compact delta %d reaches stage, progress, log, brief and Markdown", async (delta) => {
    const compact = {
      tables: ["chunks"], fragmentsRemoved: 0, fragmentsAdded: 0,
      bytesRemoved: 1024, filesRemoved: 0,
      diskBytesBefore: 4096, diskBytesAfter: 4096 + delta, diskBytesDelta: delta,
    };
    const messages: string[] = [];
    const warnings: string[] = [];
    const testLogger = {
      info: (_scope: string, msg: string) => messages.push(msg),
      warn: (_scope: string, msg: string) => warnings.push(msg),
    } as unknown as Logger;
    let progress: unknown;
    const report = await runDream(
      vaultPath, db, makeMockSync(), makeMockEnrich(), makeMockHealth(), outputsDir, testLogger,
      undefined, undefined, undefined,
      { compact: async () => compact } as unknown as LanceDBManager,
      (stage, detail) => { if (stage === "compact") progress = detail; },
    );
    expect(report.stages.compact).toEqual(compact);
    expect(progress).toEqual(compact);
    expect(report.brief).toContain(`变化 ${delta} bytes`);
    expect((delta > 0 ? warnings : messages).join("\n")).toContain(`delta ${delta} bytes`);
    const markdown = readFileSync(join(outputsDir, "dream", `dream-${report.timestamp.slice(0, 10)}.md`), "utf8");
    expect(markdown).toContain(`delta ${delta}`);
  });

  test("creates SQLite-only backup via VACUUM INTO with DB-compatible filename", async () => {
    const report = await runDream(
      vaultPath, db, makeMockSync(), makeMockEnrich(),
      makeMockHealth(), outputsDir, logger,
      undefined, dbPath,
    );
    expect(report.stages.backup.path).not.toBeNull();

    const backupDir = join(outputsDir, "backups");
    expect(existsSync(backupDir)).toBe(true);
    const files = readdirSync(backupDir).filter(f => f.endsWith(".zip"));
    expect(files.length).toBe(1);

    const listing = execSync(`zipinfo -1 ${join(backupDir, files[0])}`, { encoding: "utf-8" });
    expect(listing).not.toContain("lancedb");
    // Zip contains brain.sqlite (renamed from snapshot) so restore can install directly
    expect(listing.trim()).toBe("brain.sqlite");

    // No temp files left on disk
    const tempFiles = readdirSync(backupDir).filter(f => f.startsWith(".snapshot-") || f.startsWith("brain.sqlite"));
    expect(tempFiles.length).toBe(0);
  });

  test("WAL backup includes uncheckpointed writes", async () => {
    // Insert data that lives in the WAL (no explicit checkpoint)
    db.rawDb.prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)"
    ).run("test/wal-entity", "WAL Entity", "test/wal-entity.md", "hash-wal");

    const report = await runDream(
      vaultPath, db, makeMockSync(), makeMockEnrich(),
      makeMockHealth(), outputsDir, logger,
      undefined, dbPath,
    );
    expect(report.stages.backup.path).not.toBeNull();

    // Restore backup to a new DB and verify the row exists
    const backupDir = join(outputsDir, "backups");
    const zipFile = readdirSync(backupDir).find(f => f.endsWith(".zip"))!;
    const restoreDir = join(testDir, "restore");
    mkdirSync(restoreDir, { recursive: true });
    execSync(`unzip -o ${join(backupDir, zipFile)} -d ${restoreDir}`, { encoding: "utf-8" });

    // Zip contains brain.sqlite
    expect(existsSync(join(restoreDir, "brain.sqlite"))).toBe(true);

    const restoredDb = new CBrainDB(join(restoreDir, "brain.sqlite"));
    const row = restoredDb.rawDb.prepare("SELECT slug, title FROM pages WHERE slug = ?").get("test/wal-entity");
    expect(row).toBeDefined();
    expect((row as any).title).toBe("WAL Entity");
    restoredDb.close();
  });

  test("cleans up stale .snapshot-*.sqlite before creating new backup", async () => {
    const backupDir = join(outputsDir, "backups");
    mkdirSync(backupDir, { recursive: true });

    // Simulate stale snapshots from a previously interrupted backup
    writeFileSync(join(backupDir, ".snapshot-2026-01-01-00-00.sqlite"), "stale");
    writeFileSync(join(backupDir, ".snapshot-2026-01-02-12-30-45.sqlite"), "stale2");

    const staleBefore = readdirSync(backupDir).filter(f => f.startsWith(".snapshot-"));
    expect(staleBefore.length).toBe(2);

    await runDream(
      vaultPath, db, makeMockSync(), makeMockEnrich(),
      makeMockHealth(), outputsDir, logger,
      undefined, dbPath,
    );

    // Stale snapshots should be gone
    const staleAfter = readdirSync(backupDir).filter(f => f.startsWith(".snapshot-"));
    expect(staleAfter.length).toBe(0);

    // New backup zip exists
    const zips = readdirSync(backupDir).filter(f => f.endsWith(".zip"));
    expect(zips.length).toBe(1);
  });

  test("cleans up orphaned renamed DB file from interrupted backup", async () => {
    const backupDir = join(outputsDir, "backups");
    mkdirSync(backupDir, { recursive: true });

    // Simulate crash after rename: .snapshot was renamed to brain.sqlite but zip/delete never ran
    writeFileSync(join(backupDir, "brain.sqlite"), "orphaned-db-content");

    const orphansBefore = readdirSync(backupDir).filter(f => f === "brain.sqlite");
    expect(orphansBefore.length).toBe(1);

    await runDream(
      vaultPath, db, makeMockSync(), makeMockEnrich(),
      makeMockHealth(), outputsDir, logger,
      undefined, dbPath,
    );

    // Orphaned brain.sqlite should be cleaned up
    const orphansAfter = readdirSync(backupDir).filter(f => f === "brain.sqlite");
    expect(orphansAfter.length).toBe(0);

    // New backup zip exists (not the orphan)
    const zips = readdirSync(backupDir).filter(f => f.endsWith(".zip"));
    expect(zips.length).toBe(1);
  });

  test("enforces count limit and removes oldest", async () => {
    const backupDir = join(outputsDir, "backups");
    mkdirSync(backupDir, { recursive: true });

    for (let i = 0; i < 10; i++) {
      const ts = `2026-01-${String(i + 1).padStart(2, "0")}-00-00`;
      writeFileSync(join(backupDir, `auto-${ts}.zip`), "x".repeat(100));
    }

    await runDream(
      vaultPath, db, makeMockSync(), makeMockEnrich(),
      makeMockHealth(), outputsDir, logger,
      undefined, dbPath,
    );

    const remaining = readdirSync(backupDir).filter(f => f.endsWith(".zip")).sort();
    expect(remaining.length).toBe(7);
    expect(remaining[0]).not.toBe("auto-2026-01-01-00-00.zip");
  });

  test("enforces byte budget and removes oldest", async () => {
    const backupDir = join(outputsDir, "backups");
    mkdirSync(backupDir, { recursive: true });

    for (let i = 0; i < 6; i++) {
      const ts = `2026-01-${String(i + 1).padStart(2, "0")}-00-00`;
      writeFileSync(join(backupDir, `auto-${ts}.zip`), "x".repeat(120 * 1024 * 1024));
    }

    await runDream(
      vaultPath, db, makeMockSync(), makeMockEnrich(),
      makeMockHealth(), outputsDir, logger,
      undefined, dbPath,
    );

    const remaining = readdirSync(backupDir).filter(f => f.endsWith(".zip")).sort();
    let totalBytes = 0;
    for (const f of remaining) totalBytes += statSync(join(backupDir, f)).size;
    expect(totalBytes).toBeLessThanOrEqual(500 * 1024 * 1024 + 1024 * 1024);
    expect(remaining.length).toBeLessThan(6);
  });

  test("keeps latest backup even when single file exceeds byte budget", async () => {
    const backupDir = join(outputsDir, "backups");
    mkdirSync(backupDir, { recursive: true });

    // Single 600MB backup exceeds 500MB budget
    writeFileSync(join(backupDir, "auto-2026-01-01-00-00.zip"), "x".repeat(600 * 1024 * 1024));

    const warnMessages: string[] = [];
    const warnLogger: Logger = {
      info: () => {},
      warn: (_mod: string, msg: string) => { warnMessages.push(msg); },
      error: () => {},
    } as unknown as Logger;

    await runDream(
      vaultPath, db, makeMockSync(), makeMockEnrich(),
      makeMockHealth(), outputsDir, warnLogger,
      undefined, dbPath,
    );

    // The old oversized backup should be removed (oldest-first), new small one kept
    const remaining = readdirSync(backupDir).filter(f => f.endsWith(".zip")).sort();
    // The 600MB one should have been cleaned by count/byte logic
    expect(remaining).not.toContain("auto-2026-01-01-00-00.zip");
    expect(remaining.length).toBeGreaterThanOrEqual(1);
  });

  test("concurrent connection write captured in VACUUM INTO snapshot", async () => {
    // Connection B: open a second connection and commit new data via a separate process
    // This simulates a writer committing data that lives in the WAL but hasn't been checkpointed
    const { Database: BunDatabase } = require("bun:sqlite") as typeof import("bun:sqlite");
    const conn2 = new BunDatabase(dbPath);
    conn2.exec("PRAGMA journal_mode = WAL");
    conn2.prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)"
    ).run("test/concurrent-entity", "Concurrent Entity", "test/concurrent-entity.md", "hash-concurrent");
    // Don't checkpoint — data is in the WAL
    conn2.close();

    // Verify data is visible through the main connection (WAL read semantics)
    const beforeRow = db.rawDb.prepare("SELECT slug FROM pages WHERE slug = ?").get("test/concurrent-entity");
    expect(beforeRow).toBeDefined();

    // Run dream backup (uses VACUUM INTO — must capture conn2's committed write from WAL)
    const report = await runDream(
      vaultPath, db, makeMockSync(), makeMockEnrich(),
      makeMockHealth(), outputsDir, logger,
      undefined, dbPath,
    );
    expect(report.stages.backup.path).not.toBeNull();

    // Restore and verify
    const backupDir = join(outputsDir, "backups");
    const zipFile = readdirSync(backupDir).find(f => f.endsWith(".zip"))!;
    const restoreDir = join(testDir, "restore");
    mkdirSync(restoreDir, { recursive: true });
    execSync(`unzip -o ${join(backupDir, zipFile)} -d ${restoreDir}`, { encoding: "utf-8" });

    expect(existsSync(join(restoreDir, "brain.sqlite"))).toBe(true);

    const restoredDb = new CBrainDB(join(restoreDir, "brain.sqlite"));
    const row = restoredDb.rawDb.prepare("SELECT slug, title FROM pages WHERE slug = ?").get("test/concurrent-entity");
    expect(row).toBeDefined();
    expect((row as any).title).toBe("Concurrent Entity");
    restoredDb.close();
  });

  test("end-to-end: backup → modify → restore recovers backup state", async () => {
    // Insert data before backup
    db.rawDb.prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)"
    ).run("test/keep-me", "Keep Me", "test/keep-me.md", "hash-keep");

    // Run dream to create backup
    const report = await runDream(
      vaultPath, db, makeMockSync(), makeMockEnrich(),
      makeMockHealth(), outputsDir, logger,
      undefined, dbPath,
    );
    expect(report.stages.backup.path).not.toBeNull();

    // Modify the database after backup
    db.rawDb.prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)"
    ).run("test/after-backup", "After Backup", "test/after-backup.md", "hash-after");

    // Verify both rows exist in the live DB
    expect(db.rawDb.prepare("SELECT COUNT(*) as c FROM pages").get() as any).toEqual({ c: 2 });

    // Close DB and clean up WAL/SHM so restore overwrites cleanly
    db.close();
    try { rmSync(dbPath + "-wal"); } catch { /* no WAL */ }
    try { rmSync(dbPath + "-shm"); } catch { /* no SHM */ }

    // Restore from backup (simulate what `cbrain restore` does)
    const backupDir = join(outputsDir, "backups");
    const zipFile = readdirSync(backupDir).find(f => f.endsWith(".zip"))!;
    execSync(`unzip -o ${join(backupDir, zipFile)}`, { cwd: testDir, encoding: "utf-8" });

    // Reopen restored database
    db = new CBrainDB(dbPath);

    // Pre-backup data should be present
    const kept = db.rawDb.prepare("SELECT title FROM pages WHERE slug = ?").get("test/keep-me") as any;
    expect(kept.title).toBe("Keep Me");

    // Post-backup data should be gone (restored to backup state)
    const afterRow = db.rawDb.prepare("SELECT * FROM pages WHERE slug = ?").get("test/after-backup");
    expect(afterRow).toBeNull();
  });
});

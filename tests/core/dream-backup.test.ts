import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { runDream } from "../../src/core/dream.js";
import type { SyncManager } from "../../src/core/sync.js";
import type { EnrichManager } from "../../src/core/enrich.js";
import type { HealthChecker } from "../../src/core/health.js";
import type { Logger } from "../../src/core/logger.js";

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

  test("creates SQLite-only backup via VACUUM INTO snapshot", async () => {
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
    // Snapshot files are named .snapshot-*.sqlite, not brain.sqlite
    expect(listing).toMatch(/\.snapshot-.*\.sqlite/);

    // No temp snapshot should be left on disk
    const tempFiles = readdirSync(backupDir).filter(f => f.startsWith(".snapshot-") && f.endsWith(".sqlite"));
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

    // Snapshot file is named .snapshot-*.sqlite
    const snapshotFiles = readdirSync(restoreDir).filter(f => f.endsWith(".sqlite"));
    expect(snapshotFiles.length).toBe(1);

    const restoredDb = new CBrainDB(join(restoreDir, snapshotFiles[0]));
    const row = restoredDb.rawDb.prepare("SELECT slug, title FROM pages WHERE slug = ?").get("test/wal-entity");
    expect(row).toBeDefined();
    expect((row as any).title).toBe("WAL Entity");
    restoredDb.close();
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

    const snapshotFiles = readdirSync(restoreDir).filter(f => f.endsWith(".sqlite"));
    expect(snapshotFiles.length).toBe(1);

    const restoredDb = new CBrainDB(join(restoreDir, snapshotFiles[0]));
    const row = restoredDb.rawDb.prepare("SELECT slug, title FROM pages WHERE slug = ?").get("test/concurrent-entity");
    expect(row).toBeDefined();
    expect((row as any).title).toBe("Concurrent Entity");
    restoredDb.close();
  });
});

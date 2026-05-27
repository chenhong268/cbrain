import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

function makeMockHealth(_outputsDir: string): HealthChecker {
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

  test("creates SQLite-only backup (no LanceDB)", async () => {
    const report = await runDream(
      vaultPath, db, makeMockSync(), makeMockEnrich(),
      makeMockHealth(outputsDir), outputsDir, logger,
      undefined, dbPath,
    );
    expect(report.stages.backup.path).not.toBeNull();

    const backupDir = join(outputsDir, "backups");
    expect(existsSync(backupDir)).toBe(true);
    const files = readdirSync(backupDir).filter(f => f.endsWith(".zip"));
    expect(files.length).toBe(1);

    // Verify zip does NOT contain lancedb
    const { execSync } = require("node:child_process");
    const listing = execSync(`zipinfo -1 ${join(backupDir, files[0])}`, { encoding: "utf-8" });
    expect(listing).not.toContain("lancedb");
    expect(listing).toContain("brain.sqlite");
  });

  test("enforces count limit and removes oldest", async () => {
    const backupDir = join(outputsDir, "backups");
    mkdirSync(backupDir, { recursive: true });

    // Create 10 existing backup files
    for (let i = 0; i < 10; i++) {
      const ts = `2026-01-${String(i + 1).padStart(2, "0")}-00-00`;
      writeFileSync(join(backupDir, `auto-${ts}.zip`), "x".repeat(100));
    }

    await runDream(
      vaultPath, db, makeMockSync(), makeMockEnrich(),
      makeMockHealth(outputsDir), outputsDir, logger,
      undefined, dbPath,
    );

    const remaining = readdirSync(backupDir).filter(f => f.endsWith(".zip")).sort();
    expect(remaining.length).toBe(7);
    // Oldest should be removed
    expect(remaining[0]).not.toBe("auto-2026-01-01-00-00.zip");
  });

  test("enforces byte budget and removes oldest", async () => {
    const backupDir = join(outputsDir, "backups");
    mkdirSync(backupDir, { recursive: true });

    // Create backups that together exceed 500MB budget
    for (let i = 0; i < 6; i++) {
      const ts = `2026-01-${String(i + 1).padStart(2, "0")}-00-00`;
      // 120MB each = 720MB total > 500MB budget
      writeFileSync(join(backupDir, `auto-${ts}.zip`), "x".repeat(120 * 1024 * 1024));
    }

    await runDream(
      vaultPath, db, makeMockSync(), makeMockEnrich(),
      makeMockHealth(outputsDir), outputsDir, logger,
      undefined, dbPath,
    );

    const remaining = readdirSync(backupDir).filter(f => f.endsWith(".zip")).sort();
    let totalBytes = 0;
    for (const f of remaining) totalBytes += statSync(join(backupDir, f)).size;
    // Should be under 500MB budget (+ the new small backup)
    expect(totalBytes).toBeLessThanOrEqual(500 * 1024 * 1024 + 1024 * 1024);
    expect(remaining.length).toBeLessThan(6);
  });
});

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { installDatabase, rollbackDatabase } from "../../src/cli/commands/backup.js";

const BIN = `bun run ${join(import.meta.dir, "..", "..", "src", "cli", "index.ts")}`;

describe("cbrain restore", () => {
  let testDir: string;
  let brainDir: string;
  let dbPath: string;
  let vaultPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "cbrain-restore-test-"));
    brainDir = join(testDir, "brain");
    dbPath = join(brainDir, "brain.sqlite");
    vaultPath = join(brainDir, "vault");

    // Initialize cbrain
    execSync(`${BIN} init --dir ${brainDir}`, { encoding: "utf-8" });
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  function createBackupZip(db: CBrainDB): string {
    const backupDir = join(testDir, "backups");
    mkdirSync(backupDir, { recursive: true });
    const snapshotPath = join(backupDir, "brain.sqlite");
    db.rawDb.exec(`VACUUM INTO '${snapshotPath.replace(/'/g, "''")}'`);

    const zipPath = join(backupDir, "test-backup.zip");
    execSync(`zip -rq ${zipPath} brain.sqlite`, { cwd: backupDir, encoding: "utf-8" });
    rmSync(snapshotPath);
    return zipPath;
  }

  function createFullBackupZip(db: CBrainDB): string {
    const backupDir = join(testDir, "backups");
    mkdirSync(backupDir, { recursive: true });
    const snapshotPath = join(backupDir, "brain.sqlite");
    db.rawDb.exec(`VACUUM INTO '${snapshotPath.replace(/'/g, "''")}'`);

    // Create vault directory with content
    const vaultCopyDir = join(backupDir, "vault");
    mkdirSync(vaultCopyDir, { recursive: true });
    writeFileSync(join(vaultCopyDir, "test-note.md"), "# Test Note\nContent here");
    mkdirSync(join(vaultCopyDir, "entities"), { recursive: true });
    writeFileSync(join(vaultCopyDir, "entities", "my-entity.md"), "# My Entity");

    const zipPath = join(backupDir, "full-backup.zip");
    execSync(`zip -rq ${zipPath} brain.sqlite vault/.`, { cwd: backupDir, encoding: "utf-8" });
    rmSync(snapshotPath);
    rmSync(vaultCopyDir, { recursive: true });
    return zipPath;
  }

  function createCorruptBackupZip(): string {
    const backupDir = join(testDir, "backups");
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(backupDir, "brain.sqlite"), "this is not a database");
    const zipPath = join(backupDir, "corrupt-backup.zip");
    execSync(`zip -rq ${zipPath} brain.sqlite`, { cwd: backupDir, encoding: "utf-8" });
    return zipPath;
  }

  function insertPage(db: CBrainDB, slug: string, title: string) {
    db.rawDb.prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)"
    ).run(slug, title, `${slug}.md`, `hash-${slug}`);
  }

  test("full cycle: dream backup → modify → restore → verify backup state", async () => {
    const db = new CBrainDB(dbPath);
    insertPage(db, "test/pre-backup", "Pre Backup");
    db.close();

    const db2 = new CBrainDB(dbPath);
    const zipPath = createBackupZip(db2);
    db2.close();

    const db3 = new CBrainDB(dbPath);
    insertPage(db3, "test/post-backup", "Post Backup");
    db3.close();

    const db4 = new CBrainDB(dbPath);
    expect((db4.rawDb.prepare("SELECT COUNT(*) as c FROM pages").get() as any).c).toBe(2);
    db4.close();

    const output = execSync(`${BIN} restore ${zipPath} --force`, {
      cwd: brainDir,
      encoding: "utf-8",
    });
    expect(output).toContain("已恢复");

    const db5 = new CBrainDB(dbPath);
    const preRow = db5.rawDb.prepare("SELECT title FROM pages WHERE slug = ?").get("test/pre-backup") as any;
    expect(preRow.title).toBe("Pre Backup");
    const postRow = db5.rawDb.prepare("SELECT * FROM pages WHERE slug = ?").get("test/post-backup");
    expect(postRow).toBeNull();
    db5.close();
  });

  test("refuses to restore when database has an active write transaction", async () => {
    const db = new CBrainDB(dbPath);
    insertPage(db, "test/locked", "Locked");
    const zipPath = createBackupZip(db);

    db.rawDb.exec("BEGIN IMMEDIATE");
    insertPage(db, "test/txn-active", "Active Transaction");

    let restoreError: string | null = null;
    try {
      execSync(`${BIN} restore ${zipPath} --force`, {
        cwd: brainDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e: any) {
      restoreError = e.stderr?.toString() ?? e.message;
    }

    db.rawDb.exec("ROLLBACK");
    db.close();

    expect(restoreError).not.toBeNull();
    expect(restoreError!).toContain("占用");
  });

  test("refuses to restore when PID file indicates active serve process", async () => {
    const db = new CBrainDB(dbPath);
    insertPage(db, "test/pid-test", "PID Test");
    const zipPath = createBackupZip(db);
    db.close();

    // Write a fake PID file with our own PID (which is definitely alive)
    writeFileSync(join(brainDir, "cbrain-http.pid"), String(process.pid));

    let restoreError: string | null = null;
    try {
      execSync(`${BIN} restore ${zipPath} --force`, {
        cwd: brainDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e: any) {
      restoreError = e.stderr?.toString() ?? e.message;
    }

    // Clean up PID file
    try { rmSync(join(brainDir, "cbrain-http.pid")); } catch { /* ok */ }

    expect(restoreError).not.toBeNull();
    expect(restoreError!).toContain("活跃");
  });

  test("refuses to restore when watcher lock indicates active watcher", async () => {
    const db = new CBrainDB(dbPath);
    insertPage(db, "test/watcher-test", "Watcher Test");
    const zipPath = createBackupZip(db);
    db.close();

    // Write a fake watcher lock with our own PID
    writeFileSync(join(brainDir, ".watcher.lock"), JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      transport: "http",
    }));

    let restoreError: string | null = null;
    try {
      execSync(`${BIN} restore ${zipPath} --force`, {
        cwd: brainDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e: any) {
      restoreError = e.stderr?.toString() ?? e.message;
    }

    // Clean up lock file
    try { rmSync(join(brainDir, ".watcher.lock")); } catch { /* ok */ }

    expect(restoreError).not.toBeNull();
    expect(restoreError!).toContain("活跃");
  });

  test("restores correctly when dbPath is separated from vaultPath", async () => {
    const customDir = join(testDir, "custom-layout");
    const customDbDir = join(customDir, "data");
    const customVaultDir = join(customDir, "vault");
    const customRuntimeDir = join(customDir, "runtime");
    const customDbPath = join(customDbDir, "brain.sqlite");

    mkdirSync(customDbDir, { recursive: true });
    mkdirSync(customVaultDir, { recursive: true });
    mkdirSync(customRuntimeDir, { recursive: true });

    const config = {
      vaultPath: customVaultDir,
      dbPath: customDbPath,
      lancePath: join(customDir, "lancedb"),
      embedding: { provider: "zhipu" },
    };
    writeFileSync(join(customDir, "cbrain.json"), JSON.stringify(config, null, 2));

    const db = new CBrainDB(customDbPath);
    insertPage(db, "test/separated", "Separated Path");
    const zipPath = createBackupZip(db);
    db.close();

    const db2 = new CBrainDB(customDbPath);
    insertPage(db2, "test/after-sep", "After Sep");
    db2.close();

    const output = execSync(`${BIN} restore ${zipPath} --force`, {
      cwd: customDir,
      encoding: "utf-8",
    });
    expect(output).toContain(customDbPath);

    const db3 = new CBrainDB(customDbPath);
    const sepRow = db3.rawDb.prepare("SELECT title FROM pages WHERE slug = ?").get("test/separated") as any;
    expect(sepRow.title).toBe("Separated Path");
    const afterRow = db3.rawDb.prepare("SELECT * FROM pages WHERE slug = ?").get("test/after-sep");
    expect(afterRow).toBeNull();
    db3.close();
  });

  test("cleans up WAL and SHM files during restore", async () => {
    const db = new CBrainDB(dbPath);
    insertPage(db, "test/wal-cleanup", "WAL Cleanup");
    const zipPath = createBackupZip(db);
    db.close();

    const db2 = new CBrainDB(dbPath);
    insertPage(db2, "test/wal-extra", "WAL Extra");
    db2.close();

    expect(existsSync(dbPath + "-wal") || existsSync(dbPath + "-shm")).toBe(true);

    execSync(`${BIN} restore ${zipPath} --force`, {
      cwd: brainDir,
      encoding: "utf-8",
    });

    expect(existsSync(dbPath + "-wal")).toBe(false);
    expect(existsSync(dbPath + "-shm")).toBe(false);

    const db3 = new CBrainDB(dbPath);
    const row = db3.rawDb.prepare("SELECT title FROM pages WHERE slug = ?").get("test/wal-cleanup") as any;
    expect(row.title).toBe("WAL Cleanup");
    db3.close();
  });

  test("full backup restores both vault and database", async () => {
    const db = new CBrainDB(dbPath);
    insertPage(db, "test/full-backup", "Full Backup");
    const zipPath = createFullBackupZip(db);
    db.close();

    // Modify vault after backup
    writeFileSync(join(vaultPath, "added-after-backup.md"), "Should be gone after restore");
    expect(existsSync(join(vaultPath, "added-after-backup.md"))).toBe(true);

    // Add DB row after backup
    const db2 = new CBrainDB(dbPath);
    insertPage(db2, "test/after-full", "After Full");
    db2.close();

    const output = execSync(`${BIN} restore ${zipPath} --force`, {
      cwd: brainDir,
      encoding: "utf-8",
    });
    expect(output).toContain("数据库已恢复");
    expect(output).toContain("Vault 已恢复");

    // Vault should have backup content but not the post-backup file
    expect(existsSync(join(vaultPath, "test-note.md"))).toBe(true);
    expect(existsSync(join(vaultPath, "entities", "my-entity.md"))).toBe(true);
    expect(existsSync(join(vaultPath, "added-after-backup.md"))).toBe(false);

    // DB should have pre-backup data only
    const db3 = new CBrainDB(dbPath);
    const fullRow = db3.rawDb.prepare("SELECT title FROM pages WHERE slug = ?").get("test/full-backup") as any;
    expect(fullRow.title).toBe("Full Backup");
    const afterRow = db3.rawDb.prepare("SELECT * FROM pages WHERE slug = ?").get("test/after-full");
    expect(afterRow).toBeNull();
    db3.close();
  });

  test("corrupt backup does not destroy existing database", async () => {
    const db = new CBrainDB(dbPath);
    insertPage(db, "test/precious", "Precious Data");
    db.close();

    const corruptZip = createCorruptBackupZip();

    let restoreError: string | null = null;
    try {
      execSync(`${BIN} restore ${corruptZip} --force`, {
        cwd: brainDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e: any) {
      restoreError = e.stderr?.toString() ?? e.message;
    }

    // Should have refused
    expect(restoreError).not.toBeNull();
    expect(restoreError!).toContain("无效");

    // Original data must survive
    const db2 = new CBrainDB(dbPath);
    const row = db2.rawDb.prepare("SELECT title FROM pages WHERE slug = ?").get("test/precious") as any;
    expect(row.title).toBe("Precious Data");
    db2.close();
  });

  test("stale PID file (dead process) allows restore", async () => {
    const db = new CBrainDB(dbPath);
    insertPage(db, "test/stale-pid", "Stale PID");
    const zipPath = createBackupZip(db);
    db.close();

    // Write PID file with a PID that definitely doesn't exist
    const deadPid = 99999999;
    writeFileSync(join(brainDir, "cbrain-stdio.pid"), String(deadPid));

    // Should succeed — dead PID is not a blocker
    const output = execSync(`${BIN} restore ${zipPath} --force`, {
      cwd: brainDir,
      encoding: "utf-8",
    });
    expect(output).toContain("已恢复");

    const db2 = new CBrainDB(dbPath);
    const row = db2.rawDb.prepare("SELECT title FROM pages WHERE slug = ?").get("test/stale-pid") as any;
    expect(row.title).toBe("Stale PID");
    db2.close();
  });

  // ── P0: residual .pre-restore refuses restore and preserves files ────

  test("residual vault.pre-restore refuses restore and preserves files", async () => {
    const db = new CBrainDB(dbPath);
    insertPage(db, "test/pre-restore", "Pre Restore Data");
    writeFileSync(join(vaultPath, "original.md"), "# Original");
    const zipPath = createFullBackupZip(db);
    db.close();

    // Simulate residual from a previous failed restore
    const preRestoreDir = `${vaultPath}.pre-restore`;
    mkdirSync(preRestoreDir, { recursive: true });
    writeFileSync(join(preRestoreDir, "precious.md"), "# Precious Old Data");

    let restoreError: string | null = null;
    try {
      execSync(`${BIN} restore ${zipPath} --force`, {
        cwd: brainDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e: any) {
      restoreError = e.stderr?.toString() ?? e.message;
    }

    // Should refuse — residual files detected
    expect(restoreError).not.toBeNull();
    expect(restoreError!).toContain("残留");

    // Precious file must still exist (not auto-deleted)
    expect(existsSync(join(preRestoreDir, "precious.md"))).toBe(true);

    // DB must be untouched
    const db2 = new CBrainDB(dbPath);
    const row = db2.rawDb.prepare("SELECT title FROM pages WHERE slug = ?").get("test/pre-restore") as any;
    expect(row.title).toBe("Pre Restore Data");
    db2.close();
  });

  // ── P0: residual .rollback also refuses restore ──────────────────────

  test("residual .rollback refuses restore and preserves files", async () => {
    const db = new CBrainDB(dbPath);
    insertPage(db, "test/rollback-residual", "Rollback Residual");
    const zipPath = createBackupZip(db);
    db.close();

    // Simulate residual rollback snapshot
    const rollbackPath = `${dbPath}.rollback`;
    writeFileSync(rollbackPath, "fake rollback data");

    let restoreError: string | null = null;
    try {
      execSync(`${BIN} restore ${zipPath} --force`, {
        cwd: brainDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e: any) {
      restoreError = e.stderr?.toString() ?? e.message;
    }

    expect(restoreError).not.toBeNull();
    expect(restoreError!).toContain("残留");
    expect(existsSync(rollbackPath)).toBe(true);
  });

  // ── P1: installDatabase + rollbackDatabase preserves WAL-committed data

  test("installDatabase + rollbackDatabase preserves WAL-committed data", async () => {
    const unitDir = mkdtempSync(join(tmpdir(), "cbrain-p1-unit-"));
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");

    // 1. Create target DB, insert row A (in main file)
    const targetDbPath = join(unitDir, "target.sqlite");
    const rawDb = new Database(targetDbPath);
    rawDb.exec("CREATE TABLE pages (slug TEXT PRIMARY KEY, title TEXT)");
    rawDb.prepare("INSERT INTO pages VALUES (?, ?)").run("test/row-a", "Row A");
    rawDb.close();

    // 2. Reopen in WAL mode, insert row B (goes to WAL)
    const rawDb2 = new Database(targetDbPath);
    rawDb2.exec("PRAGMA journal_mode = WAL");
    rawDb2.prepare("INSERT INTO pages VALUES (?, ?)").run("test/row-b", "Row B In WAL");
    rawDb2.close();

    // 3. Create replacement DB (non-WAL) with row C
    const replacementPath = join(unitDir, "replacement.sqlite");
    const rawRep = new Database(replacementPath);
    rawRep.exec("CREATE TABLE pages (slug TEXT PRIMARY KEY, title TEXT)");
    rawRep.prepare("INSERT INTO pages VALUES (?, ?)").run("test/row-c", "Row C Replacement");
    rawRep.close();

    // 4. installDatabase with keepRollback=true → VACUUM INTO rollback
    const rollbackPath = `${targetDbPath}.rollback`;
    const ok = installDatabase(replacementPath, targetDbPath, true);
    expect(ok).toBe(true);
    expect(existsSync(rollbackPath)).toBe(true);

    // 5. Target now has only row C
    const rawDb3 = new Database(targetDbPath, { readonly: true });
    const rowC = rawDb3.prepare("SELECT title FROM pages WHERE slug = ?").get("test/row-c") as any;
    expect(rowC.title).toBe("Row C Replacement");
    const rowA = rawDb3.prepare("SELECT * FROM pages WHERE slug = ?").get("test/row-a");
    expect(rowA).toBeNull();
    rawDb3.close();

    // 6. Rollback (simulates vault failure after DB install)
    rollbackDatabase(targetDbPath, rollbackPath);
    expect(existsSync(rollbackPath)).toBe(false);

    // 7. Target must have rows A AND B (including WAL-committed B), not C
    const rawDb4 = new Database(targetDbPath, { readonly: true });
    const restoredA = rawDb4.prepare("SELECT title FROM pages WHERE slug = ?").get("test/row-a") as any;
    expect(restoredA.title).toBe("Row A");
    const restoredB = rawDb4.prepare("SELECT title FROM pages WHERE slug = ?").get("test/row-b") as any;
    expect(restoredB.title).toBe("Row B In WAL");
    const goneC = rawDb4.prepare("SELECT * FROM pages WHERE slug = ?").get("test/row-c");
    expect(goneC).toBeNull();
    rawDb4.close();

    rmSync(unitDir, { recursive: true });
  });

  // ── P1: DB-only installDatabase (keepRollback=false) still works ─────

  test("installDatabase without keepRollback uses rename strategy", async () => {
    const unitDir = mkdtempSync(join(tmpdir(), "cbrain-p1-rename-"));
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");

    const targetDbPath = join(unitDir, "target.sqlite");
    const rawDb = new Database(targetDbPath);
    rawDb.exec("CREATE TABLE pages (slug TEXT PRIMARY KEY, title TEXT)");
    rawDb.prepare("INSERT INTO pages VALUES (?, ?)").run("test/original", "Original Data");
    rawDb.close();

    const replacementPath = join(unitDir, "replacement.sqlite");
    const rawRep = new Database(replacementPath);
    rawRep.exec("CREATE TABLE pages (slug TEXT PRIMARY KEY, title TEXT)");
    rawRep.prepare("INSERT INTO pages VALUES (?, ?)").run("test/new-data", "New Data");
    rawRep.close();

    const ok = installDatabase(replacementPath, targetDbPath, false);
    expect(ok).toBe(true);

    const rawDb2 = new Database(targetDbPath, { readonly: true });
    const newRow = rawDb2.prepare("SELECT title FROM pages WHERE slug = ?").get("test/new-data") as any;
    expect(newRow.title).toBe("New Data");
    rawDb2.close();

    // Rollback file should be cleaned up
    expect(existsSync(`${targetDbPath}.rollback`)).toBe(false);

    rmSync(unitDir, { recursive: true });
  });

  // ── P1: installDatabase rolls back on corrupt replacement ────────────

  test("installDatabase rolls back when replacement is corrupt", async () => {
    const unitDir = mkdtempSync(join(tmpdir(), "cbrain-p1-corrupt-"));
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");

    const targetDbPath = join(unitDir, "target.sqlite");
    const rawDb = new Database(targetDbPath);
    rawDb.exec("CREATE TABLE pages (slug TEXT PRIMARY KEY, title TEXT)");
    rawDb.prepare("INSERT INTO pages VALUES (?, ?)").run("test/precious", "Precious");
    rawDb.close();

    // Create a corrupt "replacement"
    const corruptPath = join(unitDir, "corrupt.sqlite");
    writeFileSync(corruptPath, "not a database at all");

    const ok = installDatabase(corruptPath, targetDbPath, false);
    expect(ok).toBe(false);

    // Original data must survive
    const rawDb2 = new Database(targetDbPath, { readonly: true });
    const row = rawDb2.prepare("SELECT title FROM pages WHERE slug = ?").get("test/precious") as any;
    expect(row.title).toBe("Precious");
    rawDb2.close();

    rmSync(unitDir, { recursive: true });
  });

  // ── P1: staging temp protects targetPath on corrupt replacement ──────

  test("installDatabase never writes corrupt data to targetPath", async () => {
    const unitDir = mkdtempSync(join(tmpdir(), "cbrain-p1-staging-"));
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");

    const targetDbPath = join(unitDir, "target.sqlite");
    const rawDb = new Database(targetDbPath);
    rawDb.exec("CREATE TABLE pages (slug TEXT PRIMARY KEY, title TEXT)");
    rawDb.prepare("INSERT INTO pages VALUES (?, ?)").run("test/safe", "Safe Data");
    rawDb.close();

    // Get file size of valid target for comparison
    const { statSync } = await import("node:fs");
    const originalSize = statSync(targetDbPath).size;

    const corruptPath = join(unitDir, "corrupt.sqlite");
    writeFileSync(corruptPath, "not a database at all");

    installDatabase(corruptPath, targetDbPath, false);

    // targetPath must be byte-identical to original — never touched by corrupt copy
    const afterSize = statSync(targetDbPath).size;
    expect(afterSize).toBe(originalSize);

    const rawDb2 = new Database(targetDbPath, { readonly: true });
    const row = rawDb2.prepare("SELECT title FROM pages WHERE slug = ?").get("test/safe") as any;
    expect(row.title).toBe("Safe Data");
    rawDb2.close();

    // No .restoring temp left behind
    expect(existsSync(`${targetDbPath}.restoring`)).toBe(false);

    rmSync(unitDir, { recursive: true });
  });

  // ── P1: separated paths backup → restore E2E ───────────────────────

  test("separated paths: cbrain backup → restore round-trip", async () => {
    const customDir = join(testDir, "sep-roundtrip");
    const customDbDir = join(customDir, "data");
    const customVaultDir = join(customDir, "my-vault");
    const customRuntimeDir = join(customDir, "runtime");
    const customDbPath = join(customDbDir, "brain.sqlite");
    const outputDir = join(testDir, "backup-output");

    mkdirSync(customDbDir, { recursive: true });
    mkdirSync(customVaultDir, { recursive: true });
    mkdirSync(customRuntimeDir, { recursive: true });
    mkdirSync(outputDir, { recursive: true });

    const config = {
      vaultPath: customVaultDir,
      dbPath: customDbPath,
      lancePath: join(customDir, "lancedb"),
      embedding: { provider: "zhipu" },
    };
    writeFileSync(join(customDir, "cbrain.json"), JSON.stringify(config, null, 2));

    // Seed DB and vault
    const db = new CBrainDB(customDbPath);
    insertPage(db, "test/sep-backup", "Sep Backup");
    db.close();
    writeFileSync(join(customVaultDir, "note.md"), "# My Note");
    mkdirSync(join(customVaultDir, "entities"), { recursive: true });
    writeFileSync(join(customVaultDir, "entities", "foo.md"), "# Foo");

    // Backup
    const backupOutput = execSync(`${BIN} backup -o ${outputDir}`, {
      cwd: customDir,
      encoding: "utf-8",
    });
    expect(backupOutput).toContain("备份完成");

    // Find the zip file
    const zipFiles = execSync(`ls ${outputDir}/*.zip`, { encoding: "utf-8" }).trim().split("\n");
    expect(zipFiles.length).toBeGreaterThan(0);
    const backupZip = zipFiles[0];

    // Modify DB and vault after backup
    const db2 = new CBrainDB(customDbPath);
    insertPage(db2, "test/after-sep-backup", "After Sep Backup");
    db2.close();
    writeFileSync(join(customVaultDir, "added-later.md"), "should disappear");

    // Restore
    const restoreOutput = execSync(`${BIN} restore ${backupZip} --force`, {
      cwd: customDir,
      encoding: "utf-8",
    });
    expect(restoreOutput).toContain("数据库已恢复");
    expect(restoreOutput).toContain("Vault 已恢复");

    // Verify DB state
    const db3 = new CBrainDB(customDbPath);
    const backupRow = db3.rawDb.prepare("SELECT title FROM pages WHERE slug = ?").get("test/sep-backup") as any;
    expect(backupRow.title).toBe("Sep Backup");
    const afterRow = db3.rawDb.prepare("SELECT * FROM pages WHERE slug = ?").get("test/after-sep-backup");
    expect(afterRow).toBeNull();
    db3.close();

    // Verify vault state
    expect(existsSync(join(customVaultDir, "note.md"))).toBe(true);
    expect(existsSync(join(customVaultDir, "entities", "foo.md"))).toBe(true);
    expect(existsSync(join(customVaultDir, "added-later.md"))).toBe(false);
  });

  // ── P1: WAL-committed data survives backup → restore ────────────────

  test("backup captures WAL-committed data", async () => {
    const db = new CBrainDB(dbPath);
    insertPage(db, "test/wal-pre", "WAL Pre");
    db.close();

    // Open with a separate connection, write data, close (stays in WAL)
    const db2 = new CBrainDB(dbPath);
    insertPage(db2, "test/wal-committed", "WAL Committed");
    db2.close();

    // Backup should capture WAL data via VACUUM INTO
    const outputDir = join(testDir, "wal-backup-output");
    mkdirSync(outputDir, { recursive: true });

    // Seed vault so we get a full backup
    writeFileSync(join(vaultPath, "wal-test.md"), "# WAL Test");

    const backupOutput = execSync(`${BIN} backup -o ${outputDir}`, {
      cwd: brainDir,
      encoding: "utf-8",
    });
    expect(backupOutput).toContain("备份完成");

    const zipFiles = execSync(`ls ${outputDir}/*.zip`, { encoding: "utf-8" }).trim().split("\n");
    const backupZip = zipFiles[0];

    // Add more data after backup
    const db3 = new CBrainDB(dbPath);
    insertPage(db3, "test/wal-after", "WAL After");
    db3.close();

    // Restore
    execSync(`${BIN} restore ${backupZip} --force`, {
      cwd: brainDir,
      encoding: "utf-8",
    });

    // WAL-committed data should be present, post-backup data should not
    const db4 = new CBrainDB(dbPath);
    const committedRow = db4.rawDb.prepare("SELECT title FROM pages WHERE slug = ?").get("test/wal-committed") as any;
    expect(committedRow.title).toBe("WAL Committed");
    const afterRow = db4.rawDb.prepare("SELECT * FROM pages WHERE slug = ?").get("test/wal-after");
    expect(afterRow).toBeNull();
    db4.close();
  });
});

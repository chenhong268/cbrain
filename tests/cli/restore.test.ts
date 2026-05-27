import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { CBrainDB } from "../../src/storage/sqlite.js";

const BIN = `bun run ${join(import.meta.dir, "..", "..", "src", "cli", "index.ts")}`;

describe("cbrain restore", () => {
  let testDir: string;
  let brainDir: string;
  let dbPath: string;
  let vaultPath: string;
  let runtimePath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "cbrain-restore-test-"));
    brainDir = join(testDir, "brain");
    dbPath = join(brainDir, "brain.sqlite");
    vaultPath = join(brainDir, "vault");
    runtimePath = join(brainDir, "runtime");

    // Initialize cbrain
    execSync(`${BIN} init --dir ${brainDir}`, { encoding: "utf-8" });
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  function createBackupZip(db: CBrainDB): string {
    // Use VACUUM INTO to create a consistent snapshot, then zip it
    const backupDir = join(testDir, "backups");
    mkdirSync(backupDir, { recursive: true });
    const snapshotPath = join(backupDir, "brain.sqlite");
    db.rawDb.exec(`VACUUM INTO '${snapshotPath.replace(/'/g, "''")}'`);

    const zipPath = join(backupDir, "test-backup.zip");
    execSync(`zip -rq ${zipPath} brain.sqlite`, { cwd: backupDir, encoding: "utf-8" });
    rmSync(snapshotPath);
    return zipPath;
  }

  function insertPage(db: CBrainDB, slug: string, title: string) {
    db.rawDb.prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)"
    ).run(slug, title, `${slug}.md`, `hash-${slug}`);
  }

  test("full cycle: dream backup → modify → restore → verify backup state", async () => {
    // Write config to point to our test brain
    const configPath = join(brainDir, "cbrain.json");

    // Insert pre-backup data
    const db = new CBrainDB(dbPath);
    insertPage(db, "test/pre-backup", "Pre Backup");
    db.close();

    // Create a backup zip (simulates dream auto-backup)
    const db2 = new CBrainDB(dbPath);
    const zipPath = createBackupZip(db2);
    db2.close();

    // Insert post-backup data
    const db3 = new CBrainDB(dbPath);
    insertPage(db3, "test/post-backup", "Post Backup");
    db3.close();

    // Verify both rows exist
    const db4 = new CBrainDB(dbPath);
    expect((db4.rawDb.prepare("SELECT COUNT(*) as c FROM pages").get() as any).c).toBe(2);
    db4.close();

    // Restore from backup
    const output = execSync(`${BIN} restore ${zipPath} --force`, {
      cwd: brainDir,
      encoding: "utf-8",
    });
    expect(output).toContain("已恢复");

    // Reopen and verify only pre-backup data exists
    const db5 = new CBrainDB(dbPath);
    const preRow = db5.rawDb.prepare("SELECT title FROM pages WHERE slug = ?").get("test/pre-backup") as any;
    expect(preRow.title).toBe("Pre Backup");
    const postRow = db5.rawDb.prepare("SELECT * FROM pages WHERE slug = ?").get("test/post-backup");
    expect(postRow).toBeNull();
    db5.close();
  });

  test("refuses to restore when database has an active write transaction", async () => {
    // Open a connection and start a write transaction to simulate a running cbrain serve
    const db = new CBrainDB(dbPath);
    insertPage(db, "test/locked", "Locked");
    const zipPath = createBackupZip(db);

    // Start an active write transaction — this blocks BEGIN IMMEDIATE from another connection
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

    // Should have refused
    expect(restoreError).not.toBeNull();
    expect(restoreError!).toContain("占用");
  });

  test("restores correctly when dbPath is separated from vaultPath", async () => {
    // Create a custom layout where dbPath is NOT in vaultPath's parent
    const customDir = join(testDir, "custom-layout");
    const customDbDir = join(customDir, "data");
    const customVaultDir = join(customDir, "vault");
    const customRuntimeDir = join(customDir, "runtime");
    const customDbPath = join(customDbDir, "brain.sqlite");

    mkdirSync(customDbDir, { recursive: true });
    mkdirSync(customVaultDir, { recursive: true });
    mkdirSync(customRuntimeDir, { recursive: true });

    // Write config with separated paths
    const config = {
      vaultPath: customVaultDir,
      dbPath: customDbPath,
      lancePath: join(customDir, "lancedb"),
      embedding: { provider: "zhipu" },
    };
    writeFileSync(join(customDir, "cbrain.json"), JSON.stringify(config, null, 2));

    // Create DB and insert data
    const db = new CBrainDB(customDbPath);
    insertPage(db, "test/separated", "Separated Path");
    const zipPath = createBackupZip(db);
    db.close();

    // Modify after backup
    const db2 = new CBrainDB(customDbPath);
    insertPage(db2, "test/after-sep", "After Sep");
    db2.close();

    // Restore
    const output = execSync(`${BIN} restore ${zipPath} --force`, {
      cwd: customDir,
      encoding: "utf-8",
    });
    expect(output).toContain(customDbPath);

    // Verify restore went to the correct dbPath
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

    // Close and verify WAL exists
    db.close();

    // Insert more data to create WAL activity, then close without checkpoint
    const db2 = new CBrainDB(dbPath);
    insertPage(db2, "test/wal-extra", "WAL Extra");
    db2.close();

    // There should be a WAL file
    expect(existsSync(dbPath + "-wal") || existsSync(dbPath + "-shm")).toBe(true);

    // Restore should clean these up
    execSync(`${BIN} restore ${zipPath} --force`, {
      cwd: brainDir,
      encoding: "utf-8",
    });

    // WAL/SHM should be gone
    expect(existsSync(dbPath + "-wal")).toBe(false);
    expect(existsSync(dbPath + "-shm")).toBe(false);

    // DB should be clean and restorable
    const db3 = new CBrainDB(dbPath);
    const row = db3.rawDb.prepare("SELECT title FROM pages WHERE slug = ?").get("test/wal-cleanup") as any;
    expect(row.title).toBe("WAL Cleanup");
    db3.close();
  });
});

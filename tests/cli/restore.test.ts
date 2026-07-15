import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { Command } from "commander";
import { CBrainDB } from "../../src/storage/sqlite.js";
import {
  RESTORE_CLEANUP_INCOMPLETE_MESSAGE,
  exactPathEntryExists,
  finalizeRestoreArtifacts,
  installDatabase,
  installDatabaseWithResult,
  register as registerBackupCommands,
  rollbackDatabase,
} from "../../src/cli/commands/backup.js";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli", "index.ts");
const BIN = `bun run ${CLI_PATH}`;

describe("restore cleanup finalization", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cbrain-restore-cleanup-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("exact entry detection treats a broken symlink as present", () => {
    const broken = join(root, "vault.pre-restore");
    symlinkSync(join(root, "missing-target"), broken);

    expect(existsSync(broken)).toBe(false);
    expect(exactPathEntryExists(broken)).toBe(true);
    expect(exactPathEntryExists(join(root, "absent"))).toBe(false);
  });

  test("exact entry detection fails closed on non-ENOENT lstat errors", () => {
    const tooLong = join(root, "x".repeat(1024));
    expect(() => lstatSync(tooLong)).toThrow();
    expect(exactPathEntryExists(tooLong)).toBe(true);
  });

  test("the finalizer removes a broken symlink instead of treating it as absent", () => {
    const broken = join(root, "vault.pre-restore");
    symlinkSync(join(root, "missing-target"), broken);

    const result = finalizeRestoreArtifacts(
      [{ path: broken, recursive: true, removable: true }],
      { wait: () => {} },
    );

    expect(result).toEqual({ status: "clean", attempts: 1, remainingCount: 0 });
    expect(() => lstatSync(broken)).toThrow();
  });

  test("already-absent artifacts require no removal round or wait", () => {
    const removals: string[] = [];
    const waits: number[] = [];
    const result = finalizeRestoreArtifacts(
      [{ path: join(root, "absent"), recursive: true, removable: true }],
      {
        remove: (path) => removals.push(path),
        wait: (ms) => waits.push(ms),
      },
    );

    expect(result).toEqual({ status: "clean", attempts: 0, remainingCount: 0 });
    expect(removals).toEqual([]);
    expect(waits).toEqual([]);
  });

  test("an unowned artifact is verify-only and is never removed", () => {
    const rogue = join(root, "vault.pre-restore");
    mkdirSync(rogue);
    writeFileSync(join(rogue, "unmanaged.md"), "preserve");
    let removals = 0;

    const result = finalizeRestoreArtifacts(
      [{ path: rogue, recursive: true, removable: false }],
      {
        remove: () => { removals += 1; },
        wait: () => {},
      },
    );

    expect(result).toEqual({ status: "incomplete", attempts: 3, remainingCount: 1 });
    expect(removals).toBe(0);
    expect(readFileSync(join(rogue, "unmanaged.md"), "utf-8")).toBe("preserve");
  });

  test("transient removal failure retries once then stops", () => {
    const residual = join(root, "vault.pre-restore");
    mkdirSync(residual);
    const waits: number[] = [];
    let removals = 0;

    const result = finalizeRestoreArtifacts(
      [{ path: residual, recursive: true, removable: true }],
      {
        remove: (path, options) => {
          removals += 1;
          if (removals === 1) throw new Error(`private failure ${path}`);
          rmSync(path, options);
        },
        wait: (ms) => waits.push(ms),
      },
    );

    expect(result).toEqual({ status: "clean", attempts: 2, remainingCount: 0 });
    expect(removals).toBe(2);
    expect(waits).toEqual([50, 150]);
  });

  test("persistent failure is bounded and returns no raw filesystem detail", () => {
    const residual = join(root, "Mobile Documents", "File Provider Root", "vault.pre-restore");
    mkdirSync(residual, { recursive: true });
    writeFileSync(join(residual, "private-note.md"), "private vault content");
    const waits: number[] = [];
    let removals = 0;

    const result = finalizeRestoreArtifacts(
      [{ path: residual, recursive: true, removable: true }],
      {
        remove: () => {
          removals += 1;
          throw new Error(`permission denied: ${residual}/private-note.md`);
        },
        wait: (ms) => waits.push(ms),
      },
    );

    expect(result).toEqual({ status: "incomplete", attempts: 3, remainingCount: 1 });
    expect(removals).toBe(3);
    expect(waits).toEqual([50, 150, 300]);
    expect(JSON.stringify(result)).not.toContain(root);
    expect(JSON.stringify(result)).not.toContain("private-note");
    expect(existsSync(join(residual, "private-note.md"))).toBe(true);
  });

  test("multiple persistent artifacts share three global cleanup rounds", () => {
    const first = join(root, "vault.pre-restore");
    const second = join(root, "brain.sqlite.rollback");
    mkdirSync(first);
    writeFileSync(second, "rollback");
    const waits: number[] = [];
    let removals = 0;

    const result = finalizeRestoreArtifacts(
      [
        { path: first, recursive: true, removable: true },
        { path: second, recursive: false, removable: true },
      ],
      {
        remove: () => {
          removals += 1;
          throw new Error("blocked");
        },
        wait: (ms) => waits.push(ms),
      },
    );

    expect(result).toEqual({ status: "incomplete", attempts: 3, remainingCount: 2 });
    expect(removals).toBe(6);
    expect(waits).toEqual([50, 150, 300]);
  });

  test("an artifact materializing during stabilization is added to the postcondition", () => {
    const owned = join(root, "brain.sqlite.rollback");
    const late = join(root, "vault.pre-restore");
    writeFileSync(owned, "owned rollback");
    let waits = 0;

    const result = finalizeRestoreArtifacts(
      [
        { path: owned, recursive: false, removable: true },
        { path: late, recursive: true, removable: false },
      ],
      {
        remove: (path, options) => rmSync(path, options),
        wait: () => {
          waits += 1;
          if (waits === 1) {
            mkdirSync(late);
            writeFileSync(join(late, "late-unmanaged.md"), "preserve");
          }
        },
      },
    );

    expect(result).toEqual({ status: "incomplete", attempts: 3, remainingCount: 1 });
    expect(waits).toBe(3);
    expect(existsSync(join(late, "late-unmanaged.md"))).toBe(true);
  });

  test("a failed stabilization wait cannot produce a clean result", () => {
    const residual = join(root, "vault.pre-restore");
    mkdirSync(residual);
    let waits = 0;

    const result = finalizeRestoreArtifacts(
      [{ path: residual, recursive: true, removable: true }],
      {
        remove: (path, options) => rmSync(path, options),
        wait: () => {
          waits += 1;
          throw new Error("clock unavailable");
        },
      },
    );

    expect(result).toEqual({ status: "incomplete", attempts: 3, remainingCount: 0 });
    expect(waits).toBe(3);
  });

  test("partial recursive deletion never touches the active restored vault", () => {
    const active = join(root, "vault");
    const residual = join(root, "vault.pre-restore");
    mkdirSync(active);
    mkdirSync(residual);
    writeFileSync(join(active, "restored.md"), "restored");
    writeFileSync(join(residual, "removed-before-error.md"), "old");
    writeFileSync(join(residual, "remaining-after-error.md"), "old");
    let removals = 0;

    const result = finalizeRestoreArtifacts(
      [{ path: residual, recursive: true, removable: true }],
      {
        remove: () => {
          removals += 1;
          if (removals === 1) rmSync(join(residual, "removed-before-error.md"));
          throw new Error("simulated partial recursive delete");
        },
        wait: () => {},
      },
    );

    expect(result.status).toBe("incomplete");
    expect(removals).toBe(3);
    expect(existsSync(join(active, "restored.md"))).toBe(true);
    expect(existsSync(join(residual, "remaining-after-error.md"))).toBe(true);
  });

  for (const suffix of [".rollback", "-wal", "-shm"]) {
    test(`persistent ${suffix} removal failure makes finalization incomplete`, () => {
      const artifact = join(root, `brain.sqlite${suffix}`);
      writeFileSync(artifact, "managed artifact");
      const result = finalizeRestoreArtifacts(
        [{ path: artifact, recursive: false, removable: true }],
        { remove: () => { throw new Error("blocked"); }, wait: () => {} },
      );

      expect(result.status).toBe("incomplete");
      expect(result.attempts).toBe(3);
      expect(exactPathEntryExists(artifact)).toBe(true);
    });
  }
});

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
    expect(exactPathEntryExists(`${vaultPath}.pre-restore`)).toBe(false);
    expect(exactPathEntryExists(`${dbPath}.rollback`)).toBe(false);
    expect(exactPathEntryExists(`${dbPath}-wal`)).toBe(false);
    expect(exactPathEntryExists(`${dbPath}-shm`)).toBe(false);

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

  test("broken-symlink pre-restore residual fails closed before the primary swap", () => {
    const db = new CBrainDB(dbPath);
    insertPage(db, "test/broken-link", "Broken Link Guard");
    const zipPath = createFullBackupZip(db);
    db.close();

    const residual = `${vaultPath}.pre-restore`;
    symlinkSync(join(testDir, "missing-old-vault"), residual);
    expect(existsSync(residual)).toBe(false);
    expect(() => lstatSync(residual)).not.toThrow();

    const run = spawnSync("bun", ["run", CLI_PATH, "restore", zipPath, "--force"], {
      cwd: brainDir,
      encoding: "utf-8",
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("残留");
    expect(() => lstatSync(residual)).not.toThrow();
  });

  test("cleanup-incomplete keeps the restored DB and vault active and returns through finally", async () => {
    const db = new CBrainDB(dbPath);
    insertPage(db, "test/restored-db-marker", "Restored DB Marker");
    const zipPath = createFullBackupZip(db);
    db.close();

    const changedDb = new CBrainDB(dbPath);
    insertPage(changedDb, "test/old-db-marker", "Old DB Marker");
    changedDb.close();
    writeFileSync(join(vaultPath, "old-vault-marker.md"), "old vault content");

    const extractionDir = join(testDir, "injected restore extraction");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    const previousExitCode = process.exitCode;
    const previousConfig = process.env.CBRAIN_CONFIG;
    let finalizedArtifacts: Array<{
      path: string;
      recursive: boolean;
      removable: boolean;
    }> = [];

    try {
      process.env.CBRAIN_CONFIG = join(brainDir, "cbrain.json");
      process.exitCode = undefined;
      console.log = (...args: unknown[]) => stdout.push(args.join(" "));
      console.error = (...args: unknown[]) => stderr.push(args.join(" "));

      const program = new Command().name("cbrain");
      registerBackupCommands(program, {
        createRestoreTempDir: () => {
          mkdirSync(extractionDir);
          return extractionDir;
        },
        finalizeRestoreArtifacts: (artifacts) => {
          finalizedArtifacts = artifacts.map(({ path, recursive, removable }) => ({
            path,
            recursive,
            removable,
          }));
          return finalizeRestoreArtifacts(artifacts, {
            remove: (path, options) => {
              if (path.endsWith(".pre-restore")) {
                throw new Error(`private failure: ${path}; token=synthetic-secret`);
              }
              rmSync(path, options);
            },
            wait: () => {},
          });
        },
      });

      await program.parseAsync(["bun", "cbrain", "restore", zipPath, "--force"]);

      expect(Number(process.exitCode)).toBe(1);
      expect(stderr).toEqual([RESTORE_CLEANUP_INCOMPLETE_MESSAGE]);
      const transcript = [...stdout, ...stderr].join("\n");
      expect(transcript).not.toContain(testDir);
      expect(transcript).not.toContain("old-vault-marker");
      expect(transcript).not.toContain("old vault content");
      expect(transcript).not.toContain("synthetic-secret");
      expect(transcript).not.toContain("Error:");
      expect(stdout.join("\n")).not.toContain("数据库已恢复");
      expect(stdout.join("\n")).not.toContain("Vault 已恢复");
      expect(stdout.join("\n")).not.toContain("cbrain sync");
      expect(finalizedArtifacts).toEqual([
        { path: `${vaultPath}.pre-restore`, recursive: true, removable: true },
        { path: `${dbPath}.rollback`, recursive: false, removable: true },
        { path: `${dbPath}-wal`, recursive: false, removable: true },
        { path: `${dbPath}-shm`, recursive: false, removable: true },
      ]);
      expect(exactPathEntryExists(extractionDir)).toBe(false);

      const restoredDb = new CBrainDB(dbPath);
      expect(restoredDb.rawDb.prepare("SELECT title FROM pages WHERE slug = ?").get("test/restored-db-marker")).not.toBeNull();
      expect(restoredDb.rawDb.prepare("SELECT title FROM pages WHERE slug = ?").get("test/old-db-marker")).toBeNull();
      restoredDb.close();

      expect(existsSync(join(vaultPath, "test-note.md"))).toBe(true);
      expect(existsSync(join(vaultPath, "old-vault-marker.md"))).toBe(false);
      expect(existsSync(join(`${vaultPath}.pre-restore`, "old-vault-marker.md"))).toBe(true);
      expect(exactPathEntryExists(`${dbPath}.rollback`)).toBe(false);
    } finally {
      console.log = originalLog;
      console.error = originalError;
      process.exitCode = previousExitCode ?? 0;
      if (previousConfig === undefined) delete process.env.CBRAIN_CONFIG;
      else process.env.CBRAIN_CONFIG = previousConfig;
    }
  });

  test("a pre-restore tree appearing after preflight is verify-only when this run had no active vault", async () => {
    const db = new CBrainDB(dbPath);
    insertPage(db, "test/no-old-vault", "No Old Vault");
    const zipPath = createFullBackupZip(db);
    db.close();
    rmSync(vaultPath, { recursive: true });

    const rogueResidual = `${vaultPath}.pre-restore`;
    const extractionDir = join(testDir, "race restore extraction");
    const stderr: string[] = [];
    const stdout: string[] = [];
    const originalError = console.error;
    const originalLog = console.log;
    const previousExitCode = process.exitCode;
    const previousConfig = process.env.CBRAIN_CONFIG;
    try {
      process.env.CBRAIN_CONFIG = join(brainDir, "cbrain.json");
      process.exitCode = undefined;
      console.error = (...args: unknown[]) => stderr.push(args.join(" "));
      console.log = (...args: unknown[]) => stdout.push(args.join(" "));
      const program = new Command().name("cbrain");
      registerBackupCommands(program, {
        createRestoreTempDir: () => {
          mkdirSync(rogueResidual);
          writeFileSync(join(rogueResidual, "unmanaged.md"), "must survive");
          mkdirSync(extractionDir);
          return extractionDir;
        },
        finalizeRestoreArtifacts: (artifacts) =>
          finalizeRestoreArtifacts(artifacts, { wait: () => {} }),
      });

      await program.parseAsync(["bun", "cbrain", "restore", zipPath, "--force"]);

      expect(Number(process.exitCode)).toBe(1);
      expect(stderr).toEqual([RESTORE_CLEANUP_INCOMPLETE_MESSAGE]);
      expect(stdout.join("\n")).not.toContain("Vault 已恢复");
      expect(existsSync(join(rogueResidual, "unmanaged.md"))).toBe(true);
      expect(existsSync(join(vaultPath, "test-note.md"))).toBe(true);
    } finally {
      console.error = originalError;
      console.log = originalLog;
      process.exitCode = previousExitCode ?? 0;
      if (previousConfig === undefined) delete process.env.CBRAIN_CONFIG;
      else process.env.CBRAIN_CONFIG = previousConfig;
    }
  });

  test("a rollback file appearing after preflight is verify-only when this run had no original DB", async () => {
    const sourceDb = new CBrainDB(dbPath);
    insertPage(sourceDb, "test/no-old-db", "No Old DB");
    const zipPath = createBackupZip(sourceDb);
    sourceDb.close();
    rmSync(dbPath);
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });

    const rogueRollback = `${dbPath}.rollback`;
    const extractionDir = join(testDir, "rollback race extraction");
    const stderr: string[] = [];
    const stdout: string[] = [];
    const originalError = console.error;
    const originalLog = console.log;
    const previousExitCode = process.exitCode;
    const previousConfig = process.env.CBRAIN_CONFIG;
    try {
      process.env.CBRAIN_CONFIG = join(brainDir, "cbrain.json");
      process.exitCode = undefined;
      console.error = (...args: unknown[]) => stderr.push(args.join(" "));
      console.log = (...args: unknown[]) => stdout.push(args.join(" "));
      const program = new Command().name("cbrain");
      registerBackupCommands(program, {
        createRestoreTempDir: () => {
          writeFileSync(rogueRollback, "unmanaged rollback sentinel");
          mkdirSync(extractionDir);
          return extractionDir;
        },
        finalizeRestoreArtifacts: (artifacts) =>
          finalizeRestoreArtifacts(artifacts, { wait: () => {} }),
      });

      await program.parseAsync(["bun", "cbrain", "restore", zipPath, "--force"]);

      expect(Number(process.exitCode)).toBe(1);
      expect(stderr).toEqual([RESTORE_CLEANUP_INCOMPLETE_MESSAGE]);
      expect(stdout.join("\n")).not.toContain("数据库已恢复");
      expect(stdout.join("\n")).not.toContain("cbrain sync");
      expect(existsSync(rogueRollback)).toBe(true);
      const restoredDb = new CBrainDB(dbPath);
      expect(restoredDb.rawDb.prepare("SELECT title FROM pages WHERE slug = ?").get("test/no-old-db")).not.toBeNull();
      restoredDb.close();
    } finally {
      console.error = originalError;
      console.log = originalLog;
      process.exitCode = previousExitCode ?? 0;
      if (previousConfig === undefined) delete process.env.CBRAIN_CONFIG;
      else process.env.CBRAIN_CONFIG = previousConfig;
    }
  });

  test("an existing DB is not swapped when a late unowned rollback blocks exclusive claim", async () => {
    const db = new CBrainDB(dbPath);
    insertPage(db, "test/backup-db", "Backup DB");
    const zipPath = createBackupZip(db);
    db.close();
    const currentDb = new CBrainDB(dbPath);
    insertPage(currentDb, "test/current-db", "Current DB Must Survive");
    currentDb.close();

    const rogueRollback = `${dbPath}.rollback`;
    const extractionDir = join(testDir, "exclusive claim extraction");
    const stderr: string[] = [];
    const stdout: string[] = [];
    const originalError = console.error;
    const originalLog = console.log;
    const previousExitCode = process.exitCode;
    const previousConfig = process.env.CBRAIN_CONFIG;
    try {
      process.env.CBRAIN_CONFIG = join(brainDir, "cbrain.json");
      process.exitCode = undefined;
      console.error = (...args: unknown[]) => stderr.push(args.join(" "));
      console.log = (...args: unknown[]) => stdout.push(args.join(" "));
      const program = new Command().name("cbrain");
      registerBackupCommands(program, {
        createRestoreTempDir: () => {
          writeFileSync(rogueRollback, "late unmanaged rollback sentinel");
          mkdirSync(extractionDir);
          return extractionDir;
        },
      });

      await program.parseAsync(["bun", "cbrain", "restore", zipPath, "--force"]);

      expect(Number(process.exitCode)).toBe(1);
      expect(stderr).toEqual(["❌ 数据库安装失败，原数据库未受影响。"]);
      expect(stdout.join("\n")).not.toContain("数据库已恢复");
      expect(stdout.join("\n")).not.toContain("cbrain sync");
      expect(readFileSync(rogueRollback, "utf-8")).toBe("late unmanaged rollback sentinel");
      expect(exactPathEntryExists(extractionDir)).toBe(false);
      const preservedDb = new CBrainDB(dbPath);
      expect(preservedDb.rawDb.prepare("SELECT title FROM pages WHERE slug = ?").get("test/current-db")).not.toBeNull();
      preservedDb.close();
    } finally {
      console.error = originalError;
      console.log = originalLog;
      process.exitCode = previousExitCode ?? 0;
      if (previousConfig === undefined) delete process.env.CBRAIN_CONFIG;
      else process.env.CBRAIN_CONFIG = previousConfig;
    }
  });

  test("DB-only restore finalizes the exact rollback, WAL, and SHM set", async () => {
    const db = new CBrainDB(dbPath);
    insertPage(db, "test/db-only-finalizer", "DB-only Finalizer");
    const zipPath = createBackupZip(db);
    db.close();

    const previousConfig = process.env.CBRAIN_CONFIG;
    const previousExitCode = process.exitCode;
    const originalLog = console.log;
    let finalizedArtifacts: Array<{
      path: string;
      recursive: boolean;
      removable: boolean;
    }> = [];
    try {
      process.env.CBRAIN_CONFIG = join(brainDir, "cbrain.json");
      process.exitCode = undefined;
      console.log = () => {};
      const program = new Command().name("cbrain");
      registerBackupCommands(program, {
        finalizeRestoreArtifacts: (artifacts) => {
          finalizedArtifacts = artifacts.map(({ path, recursive, removable }) => ({
            path,
            recursive,
            removable,
          }));
          return finalizeRestoreArtifacts(artifacts, { wait: () => {} });
        },
      });

      await program.parseAsync(["bun", "cbrain", "restore", zipPath, "--force"]);

      expect(finalizedArtifacts).toEqual([
        { path: `${dbPath}.rollback`, recursive: false, removable: true },
        { path: `${dbPath}-wal`, recursive: false, removable: true },
        { path: `${dbPath}-shm`, recursive: false, removable: true },
      ]);
    } finally {
      console.log = originalLog;
      process.exitCode = previousExitCode ?? 0;
      if (previousConfig === undefined) delete process.env.CBRAIN_CONFIG;
      else process.env.CBRAIN_CONFIG = previousConfig;
    }
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

  test("installDatabase without keepRollback uses an exclusive rollback claim", async () => {
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

  test("installDatabase never adopts an unowned rollback when target was absent", () => {
    const unitDir = mkdtempSync(join(tmpdir(), "cbrain-unowned-rollback-"));
    const targetDbPath = join(unitDir, "target.sqlite");
    const rollbackPath = `${targetDbPath}.rollback`;
    const corruptPath = join(unitDir, "corrupt.sqlite");
    writeFileSync(rollbackPath, "unmanaged rollback sentinel");
    writeFileSync(corruptPath, "not a database");

    const ok = installDatabase(corruptPath, targetDbPath, false);

    expect(ok).toBe(false);
    expect(existsSync(targetDbPath)).toBe(false);
    expect(readFileSync(rollbackPath, "utf-8")).toBe("unmanaged rollback sentinel");
    rmSync(unitDir, { recursive: true });
  });

  test("installDatabase never overwrites a late unowned rollback when target exists", () => {
    const unitDir = mkdtempSync(join(tmpdir(), "cbrain-exclusive-rollback-"));
    const targetDbPath = join(unitDir, "target.sqlite");
    const replacementPath = join(unitDir, "replacement.sqlite");
    const rollbackPath = `${targetDbPath}.rollback`;
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const target = new Database(targetDbPath);
    target.exec("CREATE TABLE pages (slug TEXT PRIMARY KEY, title TEXT)");
    target.prepare("INSERT INTO pages VALUES (?, ?)").run("old", "Old DB");
    target.close();
    const replacement = new Database(replacementPath);
    replacement.exec("CREATE TABLE pages (slug TEXT PRIMARY KEY, title TEXT)");
    replacement.prepare("INSERT INTO pages VALUES (?, ?)").run("new", "New DB");
    replacement.close();
    writeFileSync(rollbackPath, "late unmanaged rollback");

    const ok = installDatabase(replacementPath, targetDbPath, false);

    expect(ok).toBe(false);
    expect(readFileSync(rollbackPath, "utf-8")).toBe("late unmanaged rollback");
    const active = new Database(targetDbPath, { readonly: true });
    expect(active.prepare("SELECT title FROM pages WHERE slug = 'old'").get()).not.toBeNull();
    expect(active.prepare("SELECT title FROM pages WHERE slug = 'new'").get()).toBeNull();
    active.close();
    rmSync(unitDir, { recursive: true });
  });

  test("a pre-swap rename failure never unlinks or renames the active target", () => {
    const unitDir = mkdtempSync(join(tmpdir(), "cbrain-pre-swap-failure-"));
    const targetDbPath = join(unitDir, "target.sqlite");
    const replacementPath = join(unitDir, "replacement.sqlite");
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const target = new Database(targetDbPath);
    target.exec("CREATE TABLE pages (slug TEXT PRIMARY KEY, title TEXT)");
    target.prepare("INSERT INTO pages VALUES (?, ?)").run("old", "Old DB");
    target.close();
    const replacement = new Database(replacementPath);
    replacement.exec("CREATE TABLE pages (slug TEXT PRIMARY KEY, title TEXT)");
    replacement.prepare("INSERT INTO pages VALUES (?, ?)").run("new", "New DB");
    replacement.close();
    const unlinked: string[] = [];
    const renamed: Array<[string, string]> = [];

    const result = installDatabaseWithResult(
      replacementPath,
      targetDbPath,
      false,
      {
        rename: (source, targetPath) => {
          renamed.push([source, targetPath]);
          if (source.endsWith(".restoring")) throw new Error("injected swap failure");
          renameSync(source, targetPath);
        },
        unlink: (path) => {
          unlinked.push(path);
          unlinkSync(path);
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(unlinked).not.toContain(targetDbPath);
    expect(renamed.some(([source, targetPath]) =>
      source === `${targetDbPath}.rollback` && targetPath === targetDbPath
    )).toBe(false);
    const active = new Database(targetDbPath, { readonly: true });
    expect(active.prepare("SELECT title FROM pages WHERE slug = 'old'").get()).not.toBeNull();
    expect(active.prepare("SELECT title FROM pages WHERE slug = 'new'").get()).toBeNull();
    active.close();
    expect(exactPathEntryExists(`${targetDbPath}.rollback`)).toBe(false);
    expect(exactPathEntryExists(`${targetDbPath}.restoring`)).toBe(false);
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

  test("File Provider-style paths with spaces work through an argument-array subprocess", () => {
    const fileProviderRoot = join(testDir, "Mobile Documents", "File Provider Root");
    const spacedDbPath = join(fileProviderRoot, "Data Files", "brain.sqlite");
    const spacedVaultPath = join(fileProviderRoot, "Knowledge Vault");
    const spacedZipDir = join(fileProviderRoot, "Backup Files");
    const spacedZipPath = join(spacedZipDir, "full backup.zip");
    mkdirSync(join(fileProviderRoot, "Data Files"), { recursive: true });
    mkdirSync(spacedVaultPath, { recursive: true });
    mkdirSync(spacedZipDir, { recursive: true });
    writeFileSync(join(fileProviderRoot, "cbrain.json"), JSON.stringify({
      vaultPath: spacedVaultPath,
      dbPath: spacedDbPath,
      lancePath: join(fileProviderRoot, "Vector Index"),
      embedding: { provider: "deterministic" },
    }));

    const db = new CBrainDB(spacedDbPath);
    insertPage(db, "test/spaced-restored", "Spaced Restored");
    const sourceZip = createFullBackupZip(db);
    db.close();
    copyFileSync(sourceZip, spacedZipPath);
    writeFileSync(join(spacedVaultPath, "old marker.md"), "old");

    const run = spawnSync("bun", ["run", CLI_PATH, "restore", spacedZipPath, "--force"], {
      cwd: fileProviderRoot,
      encoding: "utf-8",
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("Vault 已恢复");
    expect(existsSync(join(spacedVaultPath, "test-note.md"))).toBe(true);
    expect(exactPathEntryExists(`${spacedVaultPath}.pre-restore`)).toBe(false);
    expect(exactPathEntryExists(`${spacedDbPath}.rollback`)).toBe(false);
    expect(exactPathEntryExists(`${spacedDbPath}-wal`)).toBe(false);
    expect(exactPathEntryExists(`${spacedDbPath}-shm`)).toBe(false);
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

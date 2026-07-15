import type { Command } from "commander";
import {
  existsSync,
  mkdirSync,
  rmSync,
  readdirSync,
  copyFileSync,
  unlinkSync,
  renameSync,
  readFileSync,
  symlinkSync,
  statSync,
  lstatSync,
  linkSync,
} from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadConfig } from "../context.js";

export const RESTORE_CLEANUP_INCOMPLETE_CODE = "RESTORE_CLEANUP_INCOMPLETE";
export const RESTORE_CLEANUP_INCOMPLETE_MESSAGE =
  `${RESTORE_CLEANUP_INCOMPLETE_CODE}: 主恢复已完成，但清理后状态未通过验证。` +
  "请保持 CBrain 服务停止，按恢复文档检查残留；仅在确认无需保留后手动清理，再重试。";

const RESTORE_CLEANUP_RETRY_DELAYS_MS = [50, 150, 300] as const;

export interface RestoreArtifact {
  readonly path: string;
  readonly recursive: boolean;
  /** Only artifacts created or adopted by this restore may be removed. */
  readonly removable: boolean;
}

export interface RestoreCleanupResult {
  readonly status: "clean" | "incomplete";
  readonly attempts: number;
  readonly remainingCount: number;
}

interface RestoreCleanupDeps {
  readonly entryExists: (path: string) => boolean;
  readonly remove: (
    path: string,
    options: { recursive?: boolean; force?: boolean },
  ) => void;
  readonly wait: (milliseconds: number) => void;
}

export interface BackupCommandDeps {
  readonly createRestoreTempDir?: () => string;
  readonly finalizeRestoreArtifacts?: (
    artifacts: readonly RestoreArtifact[],
  ) => RestoreCleanupResult;
}

/**
 * `existsSync` follows symlinks, so it cannot prove that an exact directory
 * entry is absent. Only lstat ENOENT is a clean postcondition; every other
 * result (including permission errors) fails closed as "present".
 */
export function exactPathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

function waitSync(milliseconds: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(signal, 0, 0, milliseconds);
}

/**
 * Remove only explicitly managed restore artifacts. Cleanup is three global
 * rounds (not three rounds per artifact), keeping the total wait bounded at
 * 500 ms. Raw filesystem failures are deliberately collapsed into status.
 */
export function finalizeRestoreArtifacts(
  artifacts: readonly RestoreArtifact[],
  overrides: Partial<RestoreCleanupDeps> = {},
): RestoreCleanupResult {
  const deps: RestoreCleanupDeps = {
    entryExists: overrides.entryExists ?? exactPathEntryExists,
    remove: overrides.remove ?? ((path, options) => rmSync(path, options)),
    wait: overrides.wait ?? waitSync,
  };
  const uniqueArtifacts = [
    ...new Map(artifacts.map((artifact) => [artifact.path, artifact])).values(),
  ];
  const isPresent = (artifact: RestoreArtifact): boolean => {
    try {
      return deps.entryExists(artifact.path);
    } catch {
      return true;
    }
  };
  let remaining = uniqueArtifacts.filter(isPresent);
  if (remaining.length === 0) {
    return { status: "clean", attempts: 0, remainingCount: 0 };
  }

  for (let round = 0; round < RESTORE_CLEANUP_RETRY_DELAYS_MS.length; round += 1) {
    for (const artifact of remaining) {
      if (!artifact.removable) continue;
      try {
        deps.remove(artifact.path, {
          recursive: artifact.recursive,
          force: false,
        });
      } catch {
        // Verify exact entry state below; never expose a raw filesystem error.
      }
    }
    let waitSucceeded = true;
    try {
      deps.wait(RESTORE_CLEANUP_RETRY_DELAYS_MS[round]);
    } catch {
      // Absence without the required stabilization wait is not verified clean.
      waitSucceeded = false;
    }
    // Re-scan the complete applicable set. File Provider may materialize an
    // entry that was absent in the previous round while another item settles.
    remaining = uniqueArtifacts.filter(isPresent);
    if (remaining.length === 0 && waitSucceeded) {
      return { status: "clean", attempts: round + 1, remainingCount: 0 };
    }
  }

  return {
    status: "incomplete",
    attempts: RESTORE_CLEANUP_RETRY_DELAYS_MS.length,
    remainingCount: remaining.length,
  };
}

export function register(program: Command, commandDeps: BackupCommandDeps = {}): void {
  const createRestoreTempDir = commandDeps.createRestoreTempDir
    ?? (() => mkdtempSync(join(tmpdir(), "cbrain-restore-")));
  const finalizeArtifacts = commandDeps.finalizeRestoreArtifacts
    ?? ((artifacts: readonly RestoreArtifact[]) => finalizeRestoreArtifacts(artifacts));

  program
    .command("backup")
    .description("Create a backup of vault + DB (zip archive)")
    .option("-o, --output <dir>", "Output directory", ".")
    .action(async (opts) => {
      const config = loadConfig();
      const outputDir = resolve(opts.output);
      if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
      const zipPath = join(outputDir, `cbrain-backup-${ts}.zip`);

      const dbPath = resolve(config.dbPath);
      const vaultPath = resolve(config.vaultPath);
      const dbBasename = basename(dbPath);

      const stagingDir = mkdtempSync(join(tmpdir(), "cbrain-backup-"));
      try {
        console.log("正在备份...");

        const snapshotPath = join(stagingDir, dbBasename);
        const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
        const db = new Database(dbPath, { readonly: true });
        db.exec(
          `VACUUM INTO '${snapshotPath.replace(/'/g, "''")}'`,
        );
        db.close();

        symlinkSync(vaultPath, join(stagingDir, "vault"));

        const zipArgs = ["-rq", zipPath, dbBasename, "vault/."];
        if (existsSync(config.lancePath)) {
          symlinkSync(resolve(config.lancePath), join(stagingDir, "lancedb"));
          zipArgs.push("lancedb/.");
        }

        execFileSync("zip", zipArgs, {
          cwd: stagingDir,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });

        const sizeMB = (statSync(zipPath).size / 1024 / 1024).toFixed(1);
        console.log(`✅ 备份完成：${zipPath}（${sizeMB}MB）`);
      } catch (e) {
        console.error(`备份失败：${(e as Error).message}`);
        process.exit(1);
      } finally {
        try {
          rmSync(stagingDir, { recursive: true });
        } catch {
          /* cleanup */
        }
      }
    });

  program
    .command("restore")
    .description("Restore from a backup zip file")
    .argument("<path>", "Backup zip file path")
    .option("-f, --force", "Skip confirmation prompt")
    .action(async (pathArg, opts) => {
      const config = loadConfig();
      const zipPath = resolve(pathArg);
      if (!existsSync(zipPath)) {
        console.error(`备份文件不存在：${zipPath}`);
        process.exit(1);
      }
      if (!zipPath.endsWith(".zip")) {
        console.error("只支持 .zip 文件");
        process.exit(1);
      }
      if (!opts.force) {
        console.error(
          `⚠️  将用 ${zipPath} 覆盖当前数据库和 vault。使用 --force 确认执行。`,
        );
        process.exit(1);
      }

      const dbPath = resolve(config.dbPath);
      const vaultPath = resolve(config.vaultPath);
      const profileDir = dirname(dbPath);
      const dbBasename = basename(dbPath);

      // ── Step 1: Detect active CBrain services ──────────────────────
      const activeServices = detectActiveServices(profileDir);
      if (activeServices.length > 0) {
        console.error(
          `❌ 检测到活跃 CBrain 服务：${activeServices.join("、")}`,
        );
        console.error("请先停止所有 cbrain 进程再执行恢复。");
        process.exit(1);
      }

      // ── Step 2: Secondary SQLite lock check ────────────────────────
      if (isDatabaseLocked(dbPath)) {
        console.error(
          `❌ 数据库 ${dbPath} 正被占用（可能有外部进程正在访问）。`,
        );
        console.error("请先停止所有相关进程再执行恢复。");
        process.exit(1);
      }

      // ── Step 3: Pre-check residual state from previous failed restore
      const rollbackPath = `${dbPath}.rollback`;
      const vaultBackup = `${vaultPath}.pre-restore`;
      const residualPaths: string[] = [];
      if (exactPathEntryExists(rollbackPath)) residualPaths.push(rollbackPath);
      if (exactPathEntryExists(vaultBackup)) residualPaths.push(vaultBackup);
      if (residualPaths.length > 0) {
        console.error("❌ 发现上一轮恢复的残留文件，可能包含需要保留的数据：");
        for (const p of residualPaths) console.error(`  ${p}`);
        console.error("请检查这些文件，确认无需保留后手动删除，再重新执行恢复。");
        process.exit(1);
      }

      // ── Step 4: Extract to temp directory ──────────────────────────
      const tmpDir = createRestoreTempDir();
      try {
        console.log("正在恢复...");
        execFileSync("unzip", ["-o", zipPath, "-d", tmpDir], {
          encoding: "utf-8",
        });

        // ── Step 5: Locate and validate database file ────────────────
        const extractedDbPath = findFile(tmpDir, dbBasename);
        if (!extractedDbPath) {
          console.error(`❌ 备份中未找到 ${dbBasename}。可恢复文件：`);
          for (const f of listFiles(tmpDir)) console.error(`  ${f}`);
          process.exit(1);
        }

        if (!validateDatabase(extractedDbPath)) {
          console.error("❌ 备份中的数据库文件无效或已损坏，中止恢复。");
          process.exit(1);
        }

        // ── Step 6: Atomic DB+vault restore ──────────────────────────
        const extractedVault = findDirectory(tmpDir, "vault");
        const hasVault = extractedVault !== null;
        const databaseInstall = installDatabaseWithResult(
          extractedDbPath,
          dbPath,
          hasVault,
        );

        if (!databaseInstall.ok) {
          console.error("❌ 数据库安装失败，原数据库未受影响。");
          process.exitCode = 1;
          return;
        }

        // Restore vault (DB rollback snapshot kept until vault succeeds)
        if (hasVault) {
          let vaultRestored = false;
          let vaultBackupOwnedByThisRestore = false;
          if (exactPathEntryExists(vaultPath)) {
            try {
              renameSync(vaultPath, vaultBackup);
              vaultBackupOwnedByThisRestore = true;
            } catch {
              rollbackInstalledDatabase(
                dbPath,
                rollbackPath,
                databaseInstall.rollbackOwned,
              );
              console.error("❌ 无法备份当前 vault，已回滚数据库。");
              process.exit(1);
            }
            try {
              renameSync(extractedVault, vaultPath);
              vaultRestored = true;
            } catch {
              // Vault restore failed — rollback both
              try {
                rmSync(vaultPath, { recursive: true });
              } catch {
                /* nothing */
              }
              try {
                renameSync(vaultBackup, vaultPath);
              } catch {
                /* best effort */
              }
              rollbackInstalledDatabase(
                dbPath,
                rollbackPath,
                databaseInstall.rollbackOwned,
              );
              console.error("❌ Vault 恢复失败，已回滚数据库和 vault。");
              process.exit(1);
            }
          } else {
            try {
              mkdirSync(dirname(vaultPath), { recursive: true });
              renameSync(extractedVault, vaultPath);
              vaultRestored = true;
            } catch {
              rollbackInstalledDatabase(
                dbPath,
                rollbackPath,
                databaseInstall.rollbackOwned,
              );
              console.error("❌ Vault 恢复失败，已回滚数据库。");
              process.exit(1);
            }
          }

          if (vaultRestored) {
            // Both DB and vault succeeded. Cleanup failure is not a rollback
            // condition, but it must fail closed before reporting success.
            const cleanup = finalizeArtifacts([
              {
                path: vaultBackup,
                recursive: true,
                removable: vaultBackupOwnedByThisRestore,
              },
              {
                path: rollbackPath,
                recursive: false,
                removable: databaseInstall.rollbackOwned,
              },
              { path: `${dbPath}-wal`, recursive: false, removable: true },
              { path: `${dbPath}-shm`, recursive: false, removable: true },
            ]);
            if (cleanup.status === "incomplete") {
              console.error(RESTORE_CLEANUP_INCOMPLETE_MESSAGE);
              process.exitCode = 1;
              return;
            }
            console.log(`✅ 数据库已恢复到 ${dbPath}`);
            console.log(`✅ Vault 已恢复到 ${vaultPath}`);
          }
        } else {
          // DB-only installDatabase already attempts cleanup; verify the exact
          // managed entries before success and retry any transient failures.
          const cleanup = finalizeArtifacts([
            {
              path: rollbackPath,
              recursive: false,
              removable: databaseInstall.rollbackOwned,
            },
            { path: `${dbPath}-wal`, recursive: false, removable: true },
            { path: `${dbPath}-shm`, recursive: false, removable: true },
          ]);
          if (cleanup.status === "incomplete") {
            console.error(RESTORE_CLEANUP_INCOMPLETE_MESSAGE);
            process.exitCode = 1;
            return;
          }
          console.log(`✅ 数据库已恢复到 ${dbPath}`);
        }

        console.log("运行 cbrain sync 以重建索引。");
      } catch (e) {
        console.error(`恢复失败：${(e as Error).message}`);
        process.exit(1);
      } finally {
        try {
          rmSync(tmpDir, { recursive: true });
        } catch {
          /* cleanup */
        }
      }
    });
}

// ── Service detection ────────────────────────────────────────────────

const PID_FILES = ["cbrain-http.pid", "cbrain-stdio.pid"];
const WATCHER_LOCK = ".watcher.lock";

interface PidInfo {
  file: string;
  pid: number;
  transport: string;
}

function detectActiveServices(profileDir: string): string[] {
  const active: string[] = [];

  for (const pidFile of PID_FILES) {
    const info = readPidFile(join(profileDir, pidFile));
    if (info && isProcessAlive(info.pid)) {
      active.push(`${info.transport} serve (pid ${info.pid})`);
    }
  }

  const watcherInfo = readWatcherLock(join(profileDir, WATCHER_LOCK));
  if (watcherInfo && isProcessAlive(watcherInfo.pid)) {
    const alreadyListed = active.some((a) => a.includes(`pid ${watcherInfo.pid}`));
    if (!alreadyListed) {
      active.push(`watcher (pid ${watcherInfo.pid})`);
    }
  }

  return active;
}

function readPidFile(path: string): PidInfo | null {
  try {
    const raw = readFileSync(path, "utf-8").trim();
    const pid = parseInt(raw, 10);
    if (!pid) return null;
    const name = basename(path);
    const transport = name.includes("http") ? "http" : "stdio";
    return { file: path, pid, transport };
  } catch {
    return null;
  }
}

interface WatcherInfo {
  pid: number;
  transport: string;
}

function readWatcherLock(path: string): WatcherInfo | null {
  try {
    const raw = readFileSync(path, "utf-8").trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { pid?: number; transport?: string };
    if (typeof parsed.pid !== "number") return null;
    return { pid: parsed.pid, transport: parsed.transport ?? "unknown" };
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── SQLite lock detection (secondary) ────────────────────────────────

function isDatabaseLocked(dbPath: string): boolean {
  if (!existsSync(dbPath)) return false;

  try {
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const testConn = new Database(dbPath);
    testConn.exec("PRAGMA busy_timeout = 0");
    try {
      testConn.exec("BEGIN IMMEDIATE");
      testConn.exec("ROLLBACK");
    } catch (e) {
      testConn.close();
      const msg = String(e).toLowerCase();
      return msg.includes("busy") || msg.includes("locked");
    }
    testConn.close();
    return false;
  } catch (e) {
    const msg = String(e).toLowerCase();
    return msg.includes("busy") || msg.includes("locked");
  }
}

// ── Database validation ──────────────────────────────────────────────

function validateDatabase(dbPath: string): boolean {
  try {
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const conn = new Database(dbPath, { readonly: true });
    const tables = conn
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='pages'",
      )
      .get();
    conn.close();
    return tables !== null && tables !== undefined;
  } catch {
    return false;
  }
}

// ── Atomic database installation ─────────────────────────────────────

export interface DatabaseInstallResult {
  readonly ok: boolean;
  readonly rollbackOwned: boolean;
}

interface DatabaseInstallDeps {
  readonly copy: (source: string, target: string) => void;
  readonly link: (existing: string, target: string) => void;
  readonly rename: (source: string, target: string) => void;
  readonly unlink: (path: string) => void;
}

export function installDatabaseWithResult(
  sourcePath: string,
  targetPath: string,
  keepRollback = false,
  overrides: Partial<DatabaseInstallDeps> = {},
): DatabaseInstallResult {
  const targetDir = dirname(targetPath);
  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
  const deps: DatabaseInstallDeps = {
    copy: overrides.copy ?? copyFileSync,
    link: overrides.link ?? linkSync,
    rename: overrides.rename ?? renameSync,
    unlink: overrides.unlink ?? unlinkSync,
  };

  const rollbackPath = `${targetPath}.rollback`;
  const stagingPath = `${targetPath}.restoring`;
  let rollbackOwned = false;

  try {
    if (keepRollback && existsSync(targetPath)) {
      const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
      const db = new Database(targetPath);
      db.exec(`VACUUM INTO '${rollbackPath.replace(/'/g, "''")}'`);
      rollbackOwned = true;
      db.close();
    } else if (existsSync(targetPath)) {
      // Claim the rollback name exclusively. POSIX rename would overwrite a
      // late unowned file that appeared after preflight; link fails EEXIST.
      deps.link(targetPath, rollbackPath);
      rollbackOwned = true;
    }

    // Copy to staging temp, validate, then atomic rename
    deps.copy(sourcePath, stagingPath);

    if (!validateDatabase(stagingPath)) {
      // The primary swap has not happened. Never touch targetPath here.
      cleanupFailedDatabaseInstall(stagingPath, rollbackPath, rollbackOwned, deps);
      return { ok: false, rollbackOwned: false };
    }

    // Atomic swap: rename is atomic on the same filesystem
    deps.rename(stagingPath, targetPath);

    // WAL/SHM are stale (belong to previous DB)
    cleanWalShm(targetPath);

    return { ok: true, rollbackOwned };
  } catch {
    // All throwing operations happen before the atomic primary swap. The old
    // target is still active; only this run's staging/rollback may be cleaned.
    cleanupFailedDatabaseInstall(stagingPath, rollbackPath, rollbackOwned, deps);
    return { ok: false, rollbackOwned: false };
  }
}

function cleanupFailedDatabaseInstall(
  stagingPath: string,
  rollbackPath: string,
  rollbackOwned: boolean,
  deps: DatabaseInstallDeps,
): void {
  try { deps.unlink(stagingPath); } catch {}
  if (rollbackOwned) {
    try { deps.unlink(rollbackPath); } catch {}
  }
}

function installDatabase(
  sourcePath: string,
  targetPath: string,
  keepRollback = false,
): boolean {
  const result = installDatabaseWithResult(sourcePath, targetPath, keepRollback);
  if (result.ok && !keepRollback && result.rollbackOwned) {
    try { unlinkSync(`${targetPath}.rollback`); } catch {}
  }
  return result.ok;
}

function rollbackDatabase(targetPath: string, rollbackPath: string): void {
  if (!existsSync(rollbackPath)) return;
  try { copyFileSync(rollbackPath, targetPath); } catch {}
  try { unlinkSync(rollbackPath); } catch {}
  cleanWalShm(targetPath);
}

function rollbackInstalledDatabase(
  targetPath: string,
  rollbackPath: string,
  rollbackOwned: boolean,
): void {
  if (rollbackOwned) {
    rollbackDatabase(targetPath, rollbackPath);
    return;
  }
  try { unlinkSync(targetPath); } catch {}
  cleanWalShm(targetPath);
}

function cleanWalShm(dbPath: string): void {
  for (const ext of ["-wal", "-shm"]) {
    try { unlinkSync(dbPath + ext); } catch {}
  }
}

// ── File discovery helpers ───────────────────────────────────────────

function findFile(root: string, name: string): string | null {
  const direct = join(root, name);
  if (existsSync(direct)) return direct;

  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const candidate = join(root, entry.name, name);
        if (existsSync(candidate)) return candidate;
      }
    }
  } catch {
    /* not a directory */
  }
  return null;
}

function findDirectory(root: string, name: string): string | null {
  const direct = join(root, name);
  if (existsSync(direct)) {
    try {
      const stat = readdirSync(direct);
      if (stat.length > 0) return direct;
    } catch {
      /* not a directory */
    }
  }

  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const candidate = join(root, entry.name, name);
        if (existsSync(candidate)) {
          try {
            const stat = readdirSync(candidate);
            if (stat.length > 0) return candidate;
          } catch {
            /* not a directory */
          }
        }
      }
    }
  } catch {
    /* skip */
  }
  return null;
}

function listFiles(root: string): string[] {
  const results: string[] = [];
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        try {
          for (const child of readdirSync(join(root, entry.name))) {
            results.push(`${entry.name}/${child}`);
          }
        } catch {
          /* skip */
        }
      } else {
        results.push(entry.name);
      }
    }
  } catch {
    /* skip */
  }
  return results;
}

// ── Exported for testing ─────────────────────────────────────────────

export { detectActiveServices, validateDatabase, installDatabase, rollbackDatabase };

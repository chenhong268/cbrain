import type { Command } from "commander";
import { existsSync, mkdirSync, rmSync, readdirSync, copyFileSync, unlinkSync } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadConfig } from "../context.js";

export function register(program: Command) {
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
      const cwd = resolve(config.vaultPath, "..");
      const args = ["-r", zipPath, basename(config.dbPath), "vault/."];
      if (existsSync(config.lancePath)) args.push("lancedb/.");
      console.log(`正在备份...`);
      try {
        execFileSync("zip", args, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
        const { statSync } = await import("node:fs");
        const sizeMB = (statSync(zipPath).size / 1024 / 1024).toFixed(1);
        console.log(`✅ 备份完成：${zipPath}（${sizeMB}MB）`);
      } catch (e) { console.error(`备份失败：${(e as Error).message}`); process.exit(1); }
    });

  program
    .command("restore")
    .description("Restore from a backup zip file")
    .argument("<path>", "Backup zip file path")
    .option("-f, --force", "Skip confirmation prompt")
    .action(async (path, opts) => {
      const config = loadConfig();
      const zipPath = resolve(path);
      if (!existsSync(zipPath)) { console.error(`备份文件不存在：${zipPath}`); process.exit(1); }
      if (!resolve(zipPath).endsWith(".zip")) { console.error("只支持 .zip 文件"); process.exit(1); }
      if (!opts.force) {
        console.error(`⚠️  将用 ${zipPath} 覆盖当前数据库。使用 --force 确认执行。`);
        process.exit(1);
      }

      const dbPath = resolve(config.dbPath);
      const dbBasename = basename(dbPath);
      const dbDir = dirname(dbPath);

      // Check if DB is currently locked by another process
      if (isDatabaseLocked(dbPath)) {
        console.error(`❌ 数据库 ${dbPath} 正被占用（可能有 cbrain serve 或其他进程正在运行）。`);
        console.error("请先停止所有 cbrain 进程再执行恢复。");
        process.exit(1);
      }

      // Extract to temp directory first
      const tmpDir = mkdtempSync(join(tmpdir(), "cbrain-restore-"));
      try {
        console.log(`正在恢复...`);
        execFileSync("unzip", ["-o", zipPath, "-d", tmpDir], { encoding: "utf-8" });

        // Locate the database file in the extracted content
        // It could be at the root or inside a subdirectory
        const extractedDbPath = findFile(tmpDir, dbBasename);
        if (!extractedDbPath) {
          console.error(`❌ 备份中未找到 ${dbBasename}。可恢复文件：`);
          listFiles(tmpDir).forEach(f => console.error(`  ${f}`));
          process.exit(1);
        }

        // Ensure target directory exists
        if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

        // Remove old WAL/SHM files — stale sidecar files cause "disk I/O error"
        for (const ext of ["-wal", "-shm"]) {
          try { unlinkSync(dbPath + ext); } catch { /* not present */ }
        }

        // Remove old DB if present, then install the restored one
        try { unlinkSync(dbPath); } catch { /* not present */ }
        copyFileSync(extractedDbPath, dbPath);

        console.log(`✅ 数据库已恢复到 ${dbPath}`);
        console.log("运行 cbrain sync 以重建索引。");
      } catch (e) {
        console.error(`恢复失败：${(e as Error).message}`);
        process.exit(1);
      } finally {
        try { rmSync(tmpDir, { recursive: true }); } catch { /* cleanup */ }
      }
    });
}

/** Test if the database file is currently locked by another process. */
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

/** Find a file by name inside a directory tree (depth 2 max). */
function findFile(root: string, name: string): string | null {
  const direct = join(root, name);
  if (existsSync(direct)) return direct;

  // Check one level deep (backup might have been created from a parent directory)
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const candidate = join(root, entry.name, name);
        if (existsSync(candidate)) return candidate;
      }
    }
  } catch { /* not a directory */ }
  return null;
}

/** List all files in a directory tree (depth 2 max). */
function listFiles(root: string): string[] {
  const results: string[] = [];
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        try {
          for (const child of readdirSync(join(root, entry.name))) {
            results.push(`${entry.name}/${child}`);
          }
        } catch { /* skip */ }
      } else {
        results.push(entry.name);
      }
    }
  } catch { /* skip */ }
  return results;
}

import type { Command } from "commander";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { execFileSync } from "node:child_process";
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
      const resolved = resolve(zipPath);
      if (!resolved.endsWith(".zip")) { console.error("只支持 .zip 文件"); process.exit(1); }
      if (!opts.force) { console.error(`⚠️  将用 ${zipPath} 覆盖当前 vault 和数据库。使用 --force 确认执行。`); process.exit(1); }
      console.log(`正在恢复...`);
      try {
        const cwd = resolve(config.vaultPath, "..");
        execFileSync("unzip", ["-o", zipPath], { cwd, encoding: "utf-8" });
        console.log("✅ 恢复完成。运行 cbrain sync 以重建索引。");
      } catch { console.error("恢复失败。请确认系统已安装 unzip 命令。"); process.exit(1); }
    });
}

import type { Command } from "commander";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
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
      const files: string[] = [config.dbPath, config.vaultPath + "/."];
      if (existsSync(config.lancePath)) files.push(config.lancePath + "/.");
      console.log(`正在备份...`);
      try {
        execSync(`cd "${resolve(config.vaultPath, "..")}" && zip -r "${zipPath}" ${files.map(f => `"${f}"`).join(" ")} 2>/dev/null`, { encoding: "utf-8" });
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
      if (!opts.force) { console.log(`⚠️  将用 ${zipPath} 覆盖当前 vault 和数据库。\n   当前数据将被替换。确认？(y/N)`); process.exit(0); }
      console.log(`正在恢复...`);
      try {
        execSync(`cd "${resolve(config.vaultPath, "..")}" && unzip -o "${zipPath}"`, { encoding: "utf-8" });
        console.log("✅ 恢复完成。运行 cbrain sync 以重建索引。");
      } catch { console.error("恢复失败。请确认系统已安装 unzip 命令。"); process.exit(1); }
    });
}

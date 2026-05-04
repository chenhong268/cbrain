import type { Command } from "commander";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CBrainDB } from "../../storage/sqlite.js";
import { loadConfig, type CBrainConfig } from "../context.js";

const CONFIG_FILE = "cbrain.json";

export function register(program: Command) {
  program
    .command("init")
    .description("Initialize a new brain (creates config + vault dirs)")
    .option("-d, --dir <path>", "Brain directory", process.cwd())
    .action((opts) => {
      const dir = resolve(opts.dir);
      const vaultPath = join(dir, "vault");
      const dbPath = join(dir, "brain.sqlite");
      const lancePath = join(dir, "lancedb");
      const configPath = join(dir, CONFIG_FILE);
      if (existsSync(configPath)) { console.error(`Error: ${configPath} already exists.`); process.exit(1); }
      mkdirSync(join(vaultPath, "raw"), { recursive: true });
      for (const sub of ["entities", "concepts", "records"]) mkdirSync(join(vaultPath, "brain", sub), { recursive: true });
      mkdirSync(join(vaultPath, "outputs"), { recursive: true });
      const config: CBrainConfig = { vaultPath, dbPath, lancePath, embedding: { provider: "zhipu" } };
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
      new CBrainDB(dbPath);
      console.log(`\n  大脑已创建！\n`);
      console.log(`  目录：${dir}`);
      console.log(`\n  下一步：`);
      console.log(`    1. 录入内容   cbrain ingest --type text --title "标题" "内容"`);
      console.log(`    2. 开始搜索   cbrain query "关键词"`);
      console.log(`    3. 连接 Agent  cbrain serve`);
      console.log(`    4. 查看状态   cbrain status`);
      console.log();
    });

  program
    .command("status")
    .description("Show brain statistics at a glance")
    .action(async () => {
      const config = loadConfig();
      const db = new CBrainDB(config.dbPath);
      const totalPages = db.getPageCount();
      const totalLinks = db.getLinkCount();
      const totalChunks = db.getChunkCount();
      const byType = db.getPageTypeCounts();
      const typeName: Record<string, string> = { entity: "实体", concept: "概念", record: "记录", insight: "洞察" };
      console.log(`  总页数： ${totalPages}`);
      console.log(`  关系数： ${totalLinks}`);
      console.log(`  检索块： ${totalChunks}`);
      console.log(`\n  按类型：`);
      for (const t of byType) console.log(`    ${typeName[t.type] ?? t.type}: ${t.cnt}`);
      if (totalPages > 0) console.log(`\n  DB:    ${config.dbPath}`);
      db.close();
    });

  program
    .command("config")
    .description("View or update brain configuration")
    .option("--set <key=value>", "Set a config value (e.g. --set ner.enabled=false)")
    .action(async (opts) => {
      const config = loadConfig();
      const db = new CBrainDB(config.dbPath);
      if (opts.set) {
        const [key, value] = opts.set.split("=");
        if (!key || value === undefined) { console.error("Use --set key=value format. Example: --set ner.enabled=false"); process.exit(1); }
        let parsed: any = value;
        try { parsed = JSON.parse(value); } catch {}
        db.setConfig(key, String(parsed));
        console.log(`Set ${key} = ${parsed}`);
      } else {
        const rows = db.getAllConfig();
        if (rows.length === 0) { console.log("No config values set."); } else {
          for (const r of rows) console.log(`  ${r.key}: ${r.value}`);
        }
      }
      db.close();
    });
}

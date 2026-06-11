import type { Command } from "commander";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { CBrainDB } from "../../storage/sqlite.js";
import { loadConfig, type CBrainConfig } from "../context.js";
import { validateInitPaths } from "../validate-paths.js";
import type { InitResult, NextAction, ReadinessState } from "../init-types.js";

const CONFIG_FILE = "cbrain.json";

// ── Pure init logic (testable, no CLI coupling) ──

export function performInit(dir: string, force: boolean): InitResult {
  const dirResolved = resolve(dir);
  const vaultPath = join(dirResolved, "vault");
  const dbPath = join(dirResolved, "brain.sqlite");
  const lancePath = join(dirResolved, "lancedb");
  const runtimePath = join(dirResolved, "runtime");
  const configPath = join(dirResolved, CONFIG_FILE);

  // ── Pre-flight validation (before ANY writes) ──

  // 1. Check existing config
  if (existsSync(configPath) && !force) {
    return {
      status: "error",
      configPath,
      created: false,
      readinessState: "no_config",
      nextAction: { id: "run_init", command: `cbrain init --dir "${dirResolved}" --force`, message: "Use --force to overwrite existing config" },
      errorMessage: `${configPath} already exists. Use --force to overwrite.`,
    };
  }

  // 2. Path safety validation
  const validation = validateInitPaths(vaultPath, runtimePath);
  if (!validation.valid) {
    // No writes have happened — no cleanup needed
    return {
      status: "error",
      configPath,
      created: false,
      readinessState: "no_config",
      nextAction: { id: "fix_paths", command: `cbrain init --dir <safe-path>`, message: validation.errors[0] },
      errorMessage: validation.errors.join("; "),
    };
  }

  // ── All validation passed — perform writes ──

  // If force-overwriting, remove existing config only (preserve user data in DB/vault)
  if (existsSync(configPath) && force) {
    rmSync(configPath);
  }

  // Create directories
  mkdirSync(join(vaultPath, "records"), { recursive: true });
  for (const sub of ["entities", "concepts", "insights"]) {
    mkdirSync(join(vaultPath, "brain", sub), { recursive: true });
  }
  mkdirSync(runtimePath, { recursive: true });

  // Write config — includes runtimePath explicitly
  const config: CBrainConfig = {
    vaultPath,
    dbPath,
    lancePath,
    runtimePath,
    embedding: { provider: "zhipu" },
    // Deliberately NO apiKey — env var guidance only
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  // Init SQLite DB
  const db = new CBrainDB(dbPath);
  db.close();

  // Derive readiness state from actual credential presence
  const hasCreds = !!(process.env.ZHIPU_API_KEY || config.embedding?.apiKey);
  const readinessState: ReadinessState = hasCreds ? "missing_index" : "missing_creds";
  const nextAction: NextAction = hasCreds
    ? { id: "sync_index", command: "cbrain sync", message: "运行 cbrain sync 索引你的 vault" }
    : { id: "set_credentials", command: "export ZHIPU_API_KEY=your-key", message: "Set ZHIPU_API_KEY environment variable" };

  return {
    status: "ok",
    configPath,
    created: true,
    readinessState,
    nextAction,
  };
}

// ── Human formatter ──

export function formatInitHuman(result: InitResult): string {
  if (result.status === "error") {
    return `Error: ${result.errorMessage}`;
  }

  return [
    "",
    "  Brain created!",
    "",
    `  Config:  ${result.configPath}`,
    "",
    "  Next:",
    `    1. ${result.nextAction.message}`,
    `       ${result.nextAction.command}`,
    "    2. cbrain sync            Index your vault",
    "    3. cbrain mcp-config      Get Agent connection config",
    "    4. cbrain serve            Start MCP server",
    "",
  ].join("\n");
}

// ── Register ──

export function register(program: Command) {
  program
    .command("init")
    .description("Initialize a new brain (creates config + vault dirs)")
    .option("-d, --dir <path>", "Brain directory", process.cwd())
    .option("--json", "Output machine-readable JSON")
    .option("--force", "Overwrite existing config")
    .action((opts) => {
      const result = performInit(opts.dir, opts.force ?? false);

      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      } else {
        if (result.status === "error") {
          process.stderr.write(formatInitHuman(result) + "\n");
        } else {
          process.stdout.write(formatInitHuman(result));
        }
      }

      if (result.status === "error") process.exit(1);
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

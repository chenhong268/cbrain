#!/usr/bin/env bun
import { Command } from "commander";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CBrainDB } from "../storage/sqlite.js";
import { LanceDBManager } from "../storage/lancedb.js";
import { ZhipuEmbeddingProvider } from "../embedding/zhipu.js";
import { createServer, type CBrainDeps } from "../mcp/server.js";

const CONFIG_FILE = "cbrain.json";

interface CBrainConfig {
  vaultPath: string;
  dbPath: string;
  lancePath: string;
  embedding: {
    provider: string;
    apiKey?: string;
    baseUrl?: string;
  };
}

function findConfig(startDir?: string): CBrainConfig | null {
  const dir = startDir ?? process.cwd();
  const configPath = join(dir, CONFIG_FILE);
  if (existsSync(configPath)) {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  }
  const parent = resolve(dir, "..");
  if (parent === dir) return null;
  return findConfig(parent);
}

function loadConfig(): CBrainConfig {
  const config = findConfig();
  if (!config) {
    console.error("Error: No cbrain.json found. Run `cbrain init` first.");
    process.exit(1);
  }
  return config;
}

function createDeps(config: CBrainConfig, requireEmbedding = true): CBrainDeps {
  const db = new CBrainDB(config.dbPath);
  const apiKey = config.embedding.apiKey ?? process.env.ZHIPU_API_KEY;
  if (!apiKey && requireEmbedding) {
    console.error("Error: ZHIPU_API_KEY not set (env or cbrain.json).");
    process.exit(1);
  }
  const embedding = apiKey
    ? new ZhipuEmbeddingProvider(apiKey, config.embedding.baseUrl)
    : (undefined as unknown as ZhipuEmbeddingProvider);
  const lance = new LanceDBManager();
  return { db, embedding, lance, vaultPath: config.vaultPath };
}

const program = new Command()
  .name("cbrain")
  .description("Your Agent's Memory, Compounding. Agent 的记忆，复利生长。")
  .version("0.1.0");

// ─── init ────────────────────────────────────────────────────
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

    if (existsSync(configPath)) {
      console.error(`Error: ${configPath} already exists.`);
      process.exit(1);
    }

    mkdirSync(join(vaultPath, "entities"), { recursive: true });
    mkdirSync(join(vaultPath, "concepts"), { recursive: true });
    mkdirSync(join(vaultPath, "events"), { recursive: true });
    mkdirSync(join(vaultPath, "records"), { recursive: true });
    mkdirSync(join(vaultPath, "sources"), { recursive: true });

    const config: CBrainConfig = {
      vaultPath,
      dbPath,
      lancePath,
      embedding: { provider: "zhipu" },
    };

    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    new CBrainDB(dbPath); // runs migrations
    console.log(`Brain initialized at ${dir}`);
    console.log(`  vault:  ${vaultPath}`);
    console.log(`  db:     ${dbPath}`);
    console.log(`  lance:  ${lancePath}`);
  });

// ─── doctor ──────────────────────────────────────────────────
program
  .command("doctor")
  .description("Health check: DB, vault, embedding")
  .action(async () => {
    const config = loadConfig();
    let ok = true;

    // DB
    try {
      const db = new CBrainDB(config.dbPath);
      const cnt = (db.prepare("SELECT COUNT(*) as c FROM pages").get() as any).c;
      db.close();
      console.log(`  DB:      ${config.dbPath} (${cnt} pages)`);
    } catch (e) {
      console.error(`  DB:      FAIL — ${(e as Error).message}`);
      ok = false;
    }

    // Vault
    if (existsSync(config.vaultPath)) {
      console.log(`  Vault:   ${config.vaultPath} ✓`);
    } else {
      console.error(`  Vault:   ${config.vaultPath} NOT FOUND`);
      ok = false;
    }

    // Embedding
    const apiKey = config.embedding.apiKey ?? process.env.ZHIPU_API_KEY;
    if (apiKey) {
      try {
        const emb = new ZhipuEmbeddingProvider(apiKey, config.embedding.baseUrl);
        const result = await emb.embed("test");
        console.log(`  Embed:   zhipu embedding-3 (${result.embedding.length}d) ✓`);
      } catch (e) {
        console.error(`  Embed:   FAIL — ${(e as Error).message}`);
        ok = false;
      }
    } else {
      console.error("  Embed:   ZHIPU_API_KEY not configured");
      ok = false;
    }

    console.log(ok ? "\n  All checks passed ✓" : "\n  Some checks failed ✗");
    process.exit(ok ? 0 : 1);
  });

// ─── ingest ──────────────────────────────────────────────────
program
  .command("ingest")
  .description("Ingest content (text or markdown)")
  .option("-t, --type <type>", "Content type: text or markdown", "text")
  .option("--title <title>", "Title (for text type)")
  .option("--tags <tags>", "Comma-separated tags")
  .option("--page-type <type>", "Page type: entity|concept|event|record|source")
  .argument("<content>", "Content to ingest (use @file to read from file)")
  .action(async (content, opts) => {
    const config = loadConfig();
    const deps = createDeps(config);
    await deps.lance.connect(config.lancePath);

    const { IngestManager } = await import("../core/ingest.js");
    const ingest = new IngestManager(deps.db, deps.embedding, deps.lance, config.vaultPath);

    // Support @file syntax
    let input = content;
    if (input.startsWith("@")) {
      const filePath = input.slice(1);
      if (!existsSync(filePath)) {
        console.error(`Error: File not found: ${filePath}`);
        process.exit(1);
      }
      input = readFileSync(filePath, "utf-8");
    }

    const tags = opts.tags ? opts.tags.split(",").map((t: string) => t.trim()) : undefined;
    const result = await ingest.ingest({
      content: input,
      type: opts.type ?? "text",
      title: opts.title,
      tags,
      pageType: opts.pageType,
    });

    console.log(JSON.stringify(result, null, 2));
    deps.db.close();
  });

// ─── query ───────────────────────────────────────────────────
program
  .command("query")
  .description("Search the brain")
  .option("-s, --strategy <strategy>", "Search strategy: vector|fts|graph|all", "all")
  .option("-l, --limit <number>", "Max results", "10")
  .argument("<query>", "Search query")
  .action(async (query, opts) => {
    const config = loadConfig();
    const needsEmbedding = opts.strategy === "vector" || opts.strategy === "all";
    const deps = createDeps(config, needsEmbedding);
    if (needsEmbedding) {
      await deps.lance.connect(config.lancePath);
    }

    const { HybridSearch } = await import("../core/search.js");
    const search = new HybridSearch(deps.db, deps.embedding, deps.lance);
    const results = await search.search(query, {
      strategy: opts.strategy,
      limit: parseInt(opts.limit, 10),
    });

    console.log(JSON.stringify(results, null, 2));
    deps.db.close();
  });

// ─── sync ────────────────────────────────────────────────────
program
  .command("sync")
  .description("Sync vault files to indexes")
  .option("--slug <slug>", "Sync a single page")
  .action(async (opts) => {
    const config = loadConfig();
    const deps = createDeps(config);
    await deps.lance.connect(config.lancePath);

    const { SyncManager } = await import("../core/sync.js");
    const sync = new SyncManager(deps.db, deps.embedding, deps.lance);

    if (opts.slug) {
      const result = await sync.syncPage(opts.slug, config.vaultPath);
      console.log(JSON.stringify(result, null, 2));
    } else {
      const report = await sync.syncAll(config.vaultPath);
      console.log(JSON.stringify(report, null, 2));
    }
    deps.db.close();
  });

// ─── serve ───────────────────────────────────────────────────
program
  .command("serve")
  .description("Start MCP server (stdio transport)")
  .action(async () => {
    const config = loadConfig();
    const deps = createDeps(config);
    await deps.lance.connect(config.lancePath);
    await createServer(deps).connect(
      new (await import("@modelcontextprotocol/sdk/server/stdio.js")).StdioServerTransport()
    );
  });

// ─── graph-query ─────────────────────────────────────────────
program
  .command("graph-query")
  .description("Query the knowledge graph")
  .option("-m, --mode <mode>", "Query mode: traverse|backlinks|related", "traverse")
  .option("-d, --depth <number>", "Max traversal depth", "2")
  .option("-l, --limit <number>", "Max results", "20")
  .argument("<slug>", "Seed entity slug")
  .action(async (slug, opts) => {
    const config = loadConfig();
    const db = new CBrainDB(config.dbPath);
    const { GraphManager } = await import("../core/graph.js");
    const graph = new GraphManager(db);

    let result;
    switch (opts.mode) {
      case "backlinks":
        result = graph.getBacklinks(slug);
        break;
      case "related":
        result = graph.getRelatedEntities(slug, parseInt(opts.limit, 10));
        break;
      default:
        result = graph.traverse(slug, {
          maxDepth: parseInt(opts.depth, 10),
          limit: parseInt(opts.limit, 10),
        });
    }

    console.log(JSON.stringify(result, null, 2));
    db.close();
  });

// ─── enrich ──────────────────────────────────────────────────
program
  .command("enrich")
  .description("Run entity enrichment")
  .option("--slug <slug>", "Specific entity slug (omit for all)")
  .action(async (opts) => {
    const config = loadConfig();
    const db = new CBrainDB(config.dbPath);
    const { EnrichManager } = await import("../core/enrich.js");
    const enrich = new EnrichManager(db);

    const result = opts.slug ? [enrich.enrichEntity(opts.slug)] : enrich.enrichAll();
    console.log(JSON.stringify(result, null, 2));
    db.close();
  });

program.parse();

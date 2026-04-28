#!/usr/bin/env bun
import { Command } from "commander";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve, basename, extname } from "node:path";
import { CBrainDB } from "../storage/sqlite.js";
import { LanceDBManager } from "../storage/lancedb.js";
import { ZhipuEmbeddingProvider } from "../embedding/zhipu.js";
import { ZhipuLLMProvider } from "../llm/zhipu.js";
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
  ner?: {
    enabled?: boolean;
    llm_provider?: string;
    llm_model?: string;
    llm_api_key?: string;
    llm_base_url?: string;
  };
}

function findConfig(startDir?: string): CBrainConfig | null {
  const dir = startDir ?? process.env.CBRAIN_DIR ?? process.cwd();
  const configPath = join(dir, CONFIG_FILE);
  if (existsSync(configPath)) {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  }
  if (process.env.CBRAIN_DIR) return null;
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

  const nerEnabled = config.ner?.enabled !== false;
  const nerApiKey = config.ner?.llm_api_key ?? apiKey ?? process.env.ZHIPU_API_KEY;
  const llm = (nerEnabled && nerApiKey)
    ? new ZhipuLLMProvider(nerApiKey, config.ner?.llm_base_url, config.ner?.llm_model)
    : undefined;

  return { db, embedding, lance, vaultPath: config.vaultPath, llm };
}

const program = new Command()
  .name("cbrain")
  .description("Your Agent's Memory, Compounding. Agent 的记忆，复利生长。")
  .version("0.3.0");

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

    mkdirSync(join(vaultPath, "raw"), { recursive: true });
    for (const sub of ["entities", "concepts", "events", "records", "sources"]) {
      mkdirSync(join(vaultPath, "brain", sub), { recursive: true });
    }
    mkdirSync(join(dir, "outputs"), { recursive: true });

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

    // NER/LLM
    const nerEnabled = config.ner?.enabled !== false;
    if (nerEnabled) {
      const nerApiKey = config.ner?.llm_api_key ?? apiKey ?? process.env.ZHIPU_API_KEY;
      if (nerApiKey) {
        try {
          const llm = new ZhipuLLMProvider(nerApiKey, config.ner?.llm_base_url, config.ner?.llm_model);
          const model = config.ner?.llm_model ?? "glm-4-flash";
          console.log(`  NER:     ${model} ✓`);
        } catch (e) {
          console.error(`  NER:     FAIL — ${(e as Error).message}`);
          ok = false;
        }
      } else {
        console.log(`  NER:     disabled (no API key)`);
      }
    } else {
      console.log(`  NER:     disabled`);
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
    const ingest = new IngestManager(deps.db, deps.embedding, deps.lance, config.vaultPath, deps.llm);

    // Support @file syntax
    let input = content;
    let fileTitle: string | undefined;
    if (input.startsWith("@")) {
      const filePath = input.slice(1);
      if (!existsSync(filePath)) {
        console.error(`Error: File not found: ${filePath}`);
        process.exit(1);
      }
      input = readFileSync(filePath, "utf-8");
      fileTitle = basename(filePath, extname(filePath));
    }

    const tags = opts.tags ? opts.tags.split(",").map((t: string) => t.trim()) : undefined;
    const result = await ingest.ingest({
      content: input,
      type: opts.type ?? "text",
      title: opts.title ?? fileTitle,
      tags,
      pageType: opts.pageType,
    });

    // Human-readable output
    console.log(result.created ? `✓ Created: ${result.slug}` : `✓ Updated: ${result.slug}`);
    console.log(`  Links:   ${result.linksExtracted} wiki links extracted`);
    if (result.ner) {
      const ner = result.ner;
      console.log(`  NER:`);
      console.log(`    Entities:  ${ner.entities} extracted${ner.stubsCreated.length > 0 ? ` (${ner.stubsCreated.length} new stubs)` : ""}`);
      if (ner.details.entities.length > 0) {
        for (const e of ner.details.entities) {
          console.log(`      - ${e.name} (${e.type})`);
        }
      }
      if (ner.relations > 0) {
        console.log(`    Relations: ${ner.relations}`);
        for (const r of ner.details.relations) {
          console.log(`      - ${r.from} —[${r.relation}]→ ${r.to}`);
        }
      }
      if (ner.events > 0) {
        console.log(`    Events:    ${ner.events}`);
        for (const ev of ner.details.events) {
          console.log(`      - ${ev.date ?? "no date"}: ${ev.description}`);
        }
      }
    }
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
    const { NerEngine } = await import("../core/ner.js");
    const { PageManager } = await import("../core/page.js");
    const pages = new PageManager(deps.db, config.vaultPath);
    const nerEngine = deps.llm ? new NerEngine(deps.llm) : undefined;
    const sync = new SyncManager(deps.db, deps.embedding, deps.lance, {
      nerEngine,
      pages,
    });

    if (opts.slug) {
      const result = await sync.syncPage(opts.slug, config.vaultPath);
      console.log(JSON.stringify(result, null, 2));
    } else {
      const report = await sync.syncAll(config.vaultPath);
      console.log(`Synced:  ${report.synced}`);
      console.log(`Skipped: ${report.skipped} (unchanged)`);
      const orphans = await sync.removeOrphans(config.vaultPath);
      if (orphans.length > 0) console.log(`Orphans: ${orphans.length} removed`);
      const stale = await sync.cleanStaleStubs(config.vaultPath);
      if (stale.length > 0) console.log(`Stale stubs: ${stale.length} removed`);
      if (report.errors > 0) {
        console.log(`Errors:  ${report.errors}`);
        for (const detail of report.errorDetails ?? []) {
          console.log(`  - ${detail}`);
        }
      }
      if (report.nerEntities) {
        console.log(`NER:     ${report.nerEntities} entities, ${report.nerRelations} relations, ${report.nerEvents} events extracted`);
      }
    }
    deps.db.close();
  });

// ─── watch ───────────────────────────────────────────────────
program
  .command("watch")
  .description("Watch vault for changes and auto-sync (daemon)")
  .action(async () => {
    const config = loadConfig();
    const db = new CBrainDB(config.dbPath);
    const apiKey = config.embedding.apiKey ?? process.env.ZHIPU_API_KEY;
    if (!apiKey) {
      console.error("Error: ZHIPU_API_KEY not set.");
      process.exit(1);
    }
    const embedding = new (await import("../embedding/zhipu.js")).ZhipuEmbeddingProvider(apiKey, config.embedding.baseUrl);
    const lance = new LanceDBManager();
    await lance.connect(config.lancePath);
    const { SyncManager } = await import("../core/sync.js");
    const sync = new SyncManager(db, embedding, lance);
    const { FileWatcher } = await import("../core/watcher.js");
    const watcher = new FileWatcher(sync, config.vaultPath);
    watcher.start();
    console.log(`Watching ${config.vaultPath}`);
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
  .description("Run entity enrichment (tier promotion + content generation)")
  .option("--slug <slug>", "Specific entity slug (omit for all)")
  .option("--content", "Generate LLM summaries for stubs", false)
  .action(async (opts) => {
    const config = loadConfig();
    const db = new CBrainDB(config.dbPath);

    const apiKey = config.embedding.apiKey ?? process.env.ZHIPU_API_KEY;
    const nerApiKey = config.ner?.llm_api_key ?? apiKey;
    const llm = nerApiKey
      ? new ZhipuLLMProvider(nerApiKey, config.ner?.llm_base_url, config.ner?.llm_model)
      : undefined;

    const { EnrichManager } = await import("../core/enrich.js");
    const enrich = new EnrichManager(db, undefined, llm, config.vaultPath);

    if (opts.content) {
      const result = opts.slug
        ? [await enrich.enrichWithContent(opts.slug)]
        : await enrich.enrichAllWithContent();
      const enriched = result.filter((r) => r.enriched);
      console.log(`Enriched ${enriched.length}/${result.length} stubs with content`);
      for (const r of enriched) {
        console.log(`  ✓ ${r.slug}`);
      }
    } else {
      const result = opts.slug ? [enrich.enrichEntity(opts.slug)] : enrich.enrichAll();
      console.log(JSON.stringify(result, null, 2));
    }
    db.close();
  });

// ─── health ──────────────────────────────────────────────────
program
  .command("health")
  .description("Run 10-dimension health check and write report")
  .action(async () => {
    const config = loadConfig();
    const db = new CBrainDB(config.dbPath);
    const outputsDir = join(resolve(config.vaultPath, ".."), "outputs");
    const { HealthChecker } = await import("../core/health.js");
    const { Logger } = await import("../core/logger.js");
    const logger = new Logger(outputsDir);
    const checker = new HealthChecker(db, outputsDir, logger);
    const report = await checker.checkAll();

    const icon = (s: string) => s === "pass" ? "✅" : s === "warn" ? "⚠️" : "❌";
    console.log(`\n  Health Check — ${report.timestamp.slice(0, 10)}`);
    console.log(`  Overall: ${icon(report.overallStatus)} ${report.overallStatus.toUpperCase()}\n`);
    for (const dim of report.dimensions) {
      console.log(`  ${icon(dim.status)} ${dim.name} — ${dim.issues.length} issue(s)`);
    }
    console.log(`\n  Report: ${join(outputsDir, "health", `health-${report.timestamp.slice(0, 10)}.md`)}`);
    db.close();
  });

// ─── index ───────────────────────────────────────────────────
program
  .command("index")
  .description("Generate Obsidian index files (All-Entities, All-Concepts, All-Sources, Dashboard)")
  .action(() => {
    const config = loadConfig();
    const db = new CBrainDB(config.dbPath);
    const outputsDir = join(resolve(config.vaultPath, ".."), "outputs");
    const { IndexGenerator } = require("../core/indexes.js");
    const gen = new IndexGenerator(db, outputsDir);
    const files = gen.generateAll();
    console.log(`  Generated ${files.length} index files:`);
    for (const f of files) console.log(`    - ${f}`);
    db.close();
  });

// ─── check-resolvable ─────────────────────────────────────────
program
  .command("check-resolvable")
  .description("Validate skills/RESOLVER.md for coverage, overlap, orphan detection")
  .action(async () => {
    const { existsSync: exists } = await import("node:fs");
    const { resolve: res, dirname } = await import("node:path");
    const { ResolverChecker } = await import("../core/resolver.js");

    // Find RESOLVER.md: check cwd first, then walk up
    let resolverPath = res(process.cwd(), "skills", "RESOLVER.md");
    let skillsDir = res(process.cwd(), "skills");
    if (!exists(resolverPath)) {
      // Try project root alongside package.json
      let dir = process.cwd();
      for (let i = 0; i < 5; i++) {
        if (exists(res(dir, "package.json"))) {
          resolverPath = res(dir, "skills", "RESOLVER.md");
          skillsDir = res(dir, "skills");
          break;
        }
        const parent = res(dir, "..");
        if (parent === dir) break;
        dir = parent;
      }
    }

    if (!exists(resolverPath)) {
      console.error("Error: skills/RESOLVER.md not found. Create one in your brain's skills/ directory.");
      process.exit(1);
    }

    const checker = new ResolverChecker(resolverPath);
    const report = checker.check();

    console.log("\n  Skills Resolver Check\n");
    console.log(`  Rules:        ${report.rules}`);
    console.log(`  Categories:   ${report.coverage.length}`);
    console.log(`  Skills ref'd: ${report.skillsReferenced.length} (on disk: ${report.skillsOnDisk.length})`);

    if (report.orphans.length > 0) {
      console.log(`\n  Orphan skills (not routed):`);
      for (const o of report.orphans) console.log(`    ❌ skills/${o}`);
    }

    if (report.missingFiles.length > 0) {
      console.log(`\n  Missing files (routed but not on disk):`);
      for (const m of report.missingFiles) console.log(`    ❌ skills/${m}`);
    }

    if (report.overlaps.length > 0) {
      console.log(`\n  Overlapping patterns:`);
      for (const o of report.overlaps) {
        console.log(`    ⚠️  "${o.pattern}" → ${o.skills.join(", ")}`);
      }
    }

    console.log(`\n  Categories:`);
    for (const c of report.coverage) {
      console.log(`    ${c.rules} rules → ${c.category}`);
    }

    if (report.valid) {
      console.log(`\n  ✅ All checks passed — ${report.skillsReferenced.length} skills routed, no overlaps, no orphans`);
    } else {
      console.log(`\n  ❌ ${report.issues.length} issue(s) found`);
      for (const issue of report.issues) {
        console.log(`    - ${issue}`);
      }
    }

    process.exit(report.valid ? 0 : 1);
  });

// ─── show ────────────────────────────────────────────────────
program
  .command("show")
  .description("Display a page's full content")
  .argument("<slug>", "Page slug to show")
  .action(async (slug) => {
    const config = loadConfig();
    const db = new CBrainDB(config.dbPath);
    const pages = new (await import("../core/page.js")).PageManager(db, config.vaultPath);
    const page = pages.getBySlug(slug);
    if (!page) {
      console.error(`Page not found: ${slug}`);
      process.exit(1);
    }
    console.log(`slug:       ${page.slug}`);
    console.log(`type:       ${page.type}`);
    console.log(`title:      ${page.title}`);
    console.log(`tier:       ${page.tier}`);
    console.log(`mentions:   ${page.mention_count}`);
    console.log(`updated:    ${page.updated_at}`);
    console.log(`---`);
    console.log(page.body);
    db.close();
  });

// ─── list ────────────────────────────────────────────────────
program
  .command("list")
  .description("List all pages in the brain")
  .option("-t, --type <type>", "Filter by type: entity|concept|event|record|source")
  .option("-l, --limit <number>", "Max results", "50")
  .action(async (opts) => {
    const config = loadConfig();
    const db = new CBrainDB(config.dbPath);
    const pages = new (await import("../core/page.js")).PageManager(db, config.vaultPath);
    const results = pages.list({ type: opts.type, limit: parseInt(opts.limit, 10) });
    if (results.length === 0) {
      console.log("No pages found.");
    } else {
      for (const p of results) {
        console.log(`[${p.type}] ${p.slug} — ${p.title} (tier ${p.tier})`);
      }
      console.log(`\n${results.length} pages total`);
    }
    db.close();
  });

// ─── delete ──────────────────────────────────────────────────
program
  .command("delete")
  .description("Delete a page from the brain")
  .argument("<slug>", "Page slug to delete")
  .action(async (slug) => {
    const config = loadConfig();
    const db = new CBrainDB(config.dbPath);
    const pages = new (await import("../core/page.js")).PageManager(db, config.vaultPath);
    if (pages.delete(slug)) {
      console.log(`Deleted: ${slug}`);
    } else {
      console.error(`Page not found: ${slug}`);
      process.exit(1);
    }
    db.close();
  });

// ─── status ──────────────────────────────────────────────────
program
  .command("status")
  .description("Show brain statistics at a glance")
  .action(async () => {
    const config = loadConfig();
    const db = new CBrainDB(config.dbPath);
    const totalPages = (db.prepare("SELECT COUNT(*) as cnt FROM pages").get() as any).cnt;
    const totalLinks = (db.prepare("SELECT COUNT(*) as cnt FROM links").get() as any).cnt;
    const totalChunks = (db.prepare("SELECT COUNT(*) as cnt FROM chunks").get() as any).cnt;
    const errors = db.prepare(
      "SELECT COUNT(*) as cnt FROM pages WHERE title LIKE '⚠%'"
    ).get() as any;
    const byType = db.prepare(
      "SELECT type, COUNT(*) as cnt FROM pages GROUP BY type ORDER BY cnt DESC"
    ).all() as any[];
    const typeName: Record<string, string> = {
      entity: "实体", concept: "概念", event: "事件", record: "记录", source: "来源",
    };

    console.log(`  总页数： ${totalPages}`);
    console.log(`  关系数： ${totalLinks}`);
    console.log(`  检索块： ${totalChunks}`);
    if (errors.cnt > 0) console.log(`  异常页： ${errors.cnt}`);
    console.log(`\n  按类型：`);
    for (const t of byType) {
      console.log(`    ${typeName[t.type] ?? t.type}: ${t.cnt}`);
    }
    if (totalPages > 0) {
      console.log(`\n  DB:    ${config.dbPath}`);
    }
    db.close();
  });

// ─── versions ────────────────────────────────────────────────
program
  .command("versions")
  .description("Show version history of a page")
  .argument("<slug>", "Page slug")
  .action(async (slug) => {
    const config = loadConfig();
    const db = new CBrainDB(config.dbPath);
    const pages = new (await import("../core/page.js")).PageManager(db, config.vaultPath);
    const vm = new (await import("../core/version.js")).VersionManager(db, pages, config.vaultPath);
    const versions = vm.getVersions(slug);
    if (versions.length === 0) {
      console.log("No versions found.");
    } else {
      console.log(`Version history for ${slug}:\n`);
      for (const v of versions) {
        console.log(`  v${v.version} — ${v.created_at}`);
      }
      console.log(`\n  Tip: use "cbrain show ${slug}" to see current content`);
      console.log(`       use "cbrain revert ${slug} <version>" to roll back`);
    }
    db.close();
  });

// ─── revert ──────────────────────────────────────────────────
program
  .command("revert")
  .description("Revert a page to a previous version")
  .argument("<slug>", "Page slug")
  .argument("<version>", "Version number to revert to")
  .action(async (slug, version) => {
    const config = loadConfig();
    const db = new CBrainDB(config.dbPath);
    const pages = new (await import("../core/page.js")).PageManager(db, config.vaultPath);
    const vm = new (await import("../core/version.js")).VersionManager(db, pages, config.vaultPath);
    const vn = parseInt(version, 10);
    if (isNaN(vn)) {
      console.error("Version must be a number.");
      process.exit(1);
    }
    if (vm.revertToVersion(slug, vn)) {
      console.log(`Reverted ${slug} to version ${vn}`);
    } else {
      console.error(`Revert failed. Check that ${slug} and version ${vn} exist.`);
      process.exit(1);
    }
    db.close();
  });

// ─── config ──────────────────────────────────────────────────
program
  .command("config")
  .description("View or update brain configuration")
  .option("--set <key=value>", "Set a config value (e.g. --set ner.enabled=false)")
  .action(async (opts) => {
    const config = loadConfig();
    const db = new CBrainDB(config.dbPath);

    if (opts.set) {
      const [key, value] = opts.set.split("=");
      if (!key || value === undefined) {
        console.error("Use --set key=value format. Example: --set ner.enabled=false");
        process.exit(1);
      }
      // Parse value: try JSON, fall back to string
      let parsed: any = value;
      try { parsed = JSON.parse(value); } catch {}
      db.prepare(
        "INSERT OR REPLACE INTO config (key, value) VALUES ($key, $value)"
      ).run({ $key: key, $value: String(parsed) });
      console.log(`Set ${key} = ${parsed}`);
    } else {
      const rows = db.prepare("SELECT key, value FROM config ORDER BY key").all() as any[];
      if (rows.length === 0) {
        console.log("No config values set.");
      } else {
        for (const r of rows) {
          console.log(`  ${r.key}: ${r.value}`);
        }
      }
    }
    db.close();
  });

// ─── dream ───────────────────────────────────────────────────
program
  .command("dream")
  .description("Nightly full pipeline: sync → enrich → cleanup → health → report")
  .action(async () => {
    const config = loadConfig();
    const deps = createDeps(config);
    await deps.lance.connect(config.lancePath);
    const { runDream } = await import("../core/dream.js");
    const { SyncManager } = await import("../core/sync.js");
    const { EnrichManager } = await import("../core/enrich.js");
    const { HealthChecker } = await import("../core/health.js");
    const { Logger } = await import("../core/logger.js");
    const { PageManager } = await import("../core/page.js");
    const { NerEngine } = await import("../core/ner.js");
    const outputsDir = join(resolve(config.vaultPath, ".."), "outputs");
    const logger = new Logger(outputsDir);
    const pages = new PageManager(deps.db, config.vaultPath, logger);
    const nerEngine = deps.llm ? new NerEngine(deps.llm) : undefined;
    const syncMgr = new SyncManager(deps.db, deps.embedding, deps.lance, { nerEngine, pages, logger });
    const enrichMgr = new EnrichManager(deps.db, undefined, deps.llm, config.vaultPath);
    const health = new HealthChecker(deps.db, outputsDir, logger);
    const report = await runDream(config.vaultPath, deps.db, syncMgr, enrichMgr, health, outputsDir, logger);
    const icon = report.locked ? "🌙" : "⚠️";
    console.log(`${icon} Dream — ${report.timestamp.slice(0, 10)}`);
    console.log(`  Sync:    ${report.stages.sync.synced} 更新, ${report.stages.sync.skipped} 跳过`);
    console.log(`  Enrich:  ${report.stages.enrich.total} 实体, ${report.stages.enrich.upgraded} 升级`);
    console.log(`  Cleanup: ${report.stages.cleanup.orphans} 孤立, ${report.stages.cleanup.staleStubs} 过期 stub`);
    console.log(`  Health:  ${report.stages.health.overallStatus}`);
    console.log(`  ⏱ ${(report.duration_ms / 1000).toFixed(1)}s`);
    if (!report.locked) console.log(`  ⚠️ 上次 dream 仍在执行中，本次跳过`);
    deps.db.close();
    process.exit(report.locked ? 0 : 1);
  });

// ─── maintain ────────────────────────────────────────────────
program
  .command("maintain")
  .description("Run full maintenance: sync → enrich → health → report")
  .action(async () => {
    const config = loadConfig();
    const deps = createDeps(config);
    await deps.lance.connect(config.lancePath);
    const { runMaintenance } = await import("../core/maintain.js");
    const { SyncManager } = await import("../core/sync.js");
    const { EnrichManager } = await import("../core/enrich.js");
    const { HealthChecker } = await import("../core/health.js");
    const { Logger } = await import("../core/logger.js");
    const { PageManager } = await import("../core/page.js");
    const { NerEngine } = await import("../core/ner.js");
    const outputsDir = join(resolve(config.vaultPath, ".."), "outputs");
    const logger = new Logger(outputsDir);
    const pages = new PageManager(deps.db, config.vaultPath, logger);
    const nerEngine = deps.llm ? new NerEngine(deps.llm) : undefined;
    const syncMgr = new SyncManager(deps.db, deps.embedding, deps.lance, { nerEngine, pages, logger });
    const enrichMgr = new EnrichManager(deps.db, undefined, deps.llm, config.vaultPath);
    const health = new HealthChecker(deps.db, outputsDir, logger);
    const report = await runMaintenance(config.vaultPath, syncMgr, enrichMgr, health);
    const lines = [
      `同步: ${report.sync.synced} 更新, ${report.sync.skipped} 跳过`,
      report.sync.nerEntities ? `NER: ${report.sync.nerEntities} 实体, ${report.sync.nerRelations} 关系` : "",
      `实体: ${report.enrich.total} 总计, ${report.enrich.upgraded} 升级`,
      `健康: ${report.health.overallStatus} (${report.health.dimensions.length} 维度)`,
    ];
    console.log(lines.filter(Boolean).join("\n"));
    deps.db.close();
  });

// ─── tags ────────────────────────────────────────────────────
program
  .command("tags")
  .description("Manage tags on a page")
  .argument("<slug>", "Page slug")
  .argument("[action]", "Action: add <tag> | remove <tag> (omit to list)")
  .argument("[value]", "Tag value for add/remove")
  .action(async (slug, action, value) => {
    const config = loadConfig();
    const db = new CBrainDB(config.dbPath);

    if (!action) {
      const tags = db.getTags(slug);
      if (tags.length === 0) {
        console.log(`No tags on ${slug}`);
      } else {
        console.log(`Tags on ${slug}:`);
        for (const t of tags) console.log(`  ${t}`);
      }
    } else if (action === "add" && value) {
      if (db.addTag(slug, value)) {
        console.log(`Added tag "${value}" to ${slug}`);
      } else {
        console.error(`Failed to add tag. Check that ${slug} exists.`);
        process.exit(1);
      }
    } else if (action === "remove" && value) {
      if (db.removeTag(slug, value)) {
        console.log(`Removed tag "${value}" from ${slug}`);
      } else {
        console.error(`Failed to remove tag.`);
        process.exit(1);
      }
    } else {
      console.error("Usage: cbrain tags <slug> [add|remove <tag>]");
      process.exit(1);
    }
    db.close();
  });

// ─── timeline ────────────────────────────────────────────────
program
  .command("timeline")
  .description("View or add timeline events on a page")
  .argument("<slug>", "Page slug")
  .argument("[action]", "Action: add (omit to list)")
  .option("--date <date>", "Event date (e.g. 2024-03-01)")
  .option("--source <source>", "Source reference")
  .option("--summary <summary>", "Event summary (required for add)")
  .action(async (slug, action, opts) => {
    const config = loadConfig();
    const db = new CBrainDB(config.dbPath);

    if (action === "add") {
      if (!opts.summary) {
        console.error("--summary is required for add. Example: --summary \"张三加入ABC科技\"");
        process.exit(1);
      }
      const id = db.addTimelineEntry(slug, opts.summary, opts.date, opts.source);
      console.log(`Added timeline event #${id} to ${slug}`);
    } else {
      const events = db.getTimeline(slug);
      if (events.length === 0) {
        console.log(`No timeline events on ${slug}`);
      } else {
        console.log(`Timeline for ${slug}:\n`);
        for (const ev of events) {
          const date = ev.event_date ? ev.event_date.padEnd(12) : "            ";
          const src = ev.source ? ` (${ev.source})` : "";
          console.log(`  ${date}${ev.summary}${src}`);
        }
      }
    }
    db.close();
  });

// ─── routing-eval ─────────────────────────────────────────────
program
  .command("routing-eval")
  .description("Test skill routing accuracy against fixtures (routing-eval.jsonl)")
  .action(async () => {
    const { existsSync: exists } = await import("node:fs");
    const { resolve: res } = await import("node:path");
    const { runEval } = await import("../core/routing-eval.js");

    let resolverPath = res(process.cwd(), "skills", "RESOLVER.md");
    if (!exists(resolverPath)) {
      let dir = process.cwd();
      for (let i = 0; i < 5; i++) {
        if (exists(res(dir, "package.json"))) {
          resolverPath = res(dir, "skills", "RESOLVER.md");
          break;
        }
        const parent = res(dir, "..");
        if (parent === dir) break;
        dir = parent;
      }
    }

    if (!exists(resolverPath)) {
      console.error("Error: skills/RESOLVER.md not found.");
      process.exit(1);
    }

    const report = runEval(resolverPath);

    if (report.total === 0) {
      console.log("No routing-eval fixtures found. Create skills/<name>.routing-eval.jsonl files to add tests.");
      process.exit(0);
    }

    console.log(`\n  Routing Eval — ${report.total} fixtures\n`);
    for (const r of report.results) {
      const icon = r.pass ? "✅" : "❌";
      const amb = r.ambiguous ? " ⚠️ 歧义" : "";
      console.log(`  ${icon} "${r.intent}"`);
      console.log(`     期望: ${r.expected}  →  匹配: ${r.matched ?? "(无)"}${amb}`);
      if (r.ambiguous_with && !r.pass) {
        console.log(`     歧义备选: ${r.ambiguous_with.join(", ")}`);
      }
    }

    console.log(`\n  ${report.pass}/${report.total} passed`);
    if (report.fail > 0) {
      console.log(`  ${report.fail} failed — check RESOLVER.md routing rules`);
      process.exit(1);
    }
  });

program.parse();

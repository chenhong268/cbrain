import type { Command } from "commander";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { CBrainDB } from "../../storage/sqlite.js";
import { LanceDBManager } from "../../storage/lancedb.js";
import { ZhipuEmbeddingProvider } from "../../embedding/zhipu.js";
import { ZhipuLLMProvider } from "../../llm/zhipu.js";
import { loadConfig, createDeps } from "../context.js";

export function register(program: Command) {
  program
    .command("sync")
    .description("Sync vault files to indexes")
    .option("--slug <slug>", "Sync a single page")
    .action(async (opts) => {
      const config = loadConfig();
      const deps = createDeps(config);
      await deps.lance.connect(config.lancePath);
      const { SyncManager } = await import("../../core/sync.js");
      const { NerEngine } = await import("../../core/ner.js");
      const { PageManager } = await import("../../core/page.js");
      const pages = new PageManager(deps.db, config.vaultPath);
      const nerEngine = deps.llm ? new NerEngine(deps.llm) : undefined;
      const sync = new SyncManager(deps.db, deps.embedding, deps.lance, { nerEngine, pages });
      if (opts.slug) {
        console.log(JSON.stringify(await sync.syncPage(opts.slug, config.vaultPath), null, 2));
      } else {
        const report = await sync.syncAll(config.vaultPath);
        console.log(`Synced:  ${report.synced}`);
        console.log(`Skipped: ${report.skipped} (unchanged)`);
        const orphans = await sync.removeOrphans(config.vaultPath);
        if (orphans.length > 0) console.log(`Orphans: ${orphans.length} removed`);
        const stale = await sync.cleanStaleStubs(config.vaultPath);
        if (stale.length > 0) console.log(`Stale stubs: ${stale.length} removed`);
        if (report.errors > 0) { console.log(`Errors:  ${report.errors}`); for (const d of report.errorDetails ?? []) console.log(`  - ${d}`); }
        if (report.nerEntities) console.log(`NER:     ${report.nerEntities} entities, ${report.nerRelations} relations, ${report.nerEvents} events extracted`);
      }
      deps.db.close();
    });

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
      const llm = nerApiKey ? new ZhipuLLMProvider(nerApiKey, config.ner?.llm_base_url, config.ner?.llm_model) : undefined;
      const { EnrichManager } = await import("../../core/enrich.js");
      const enrich = new EnrichManager(db, undefined, llm, config.vaultPath);
      if (opts.content) {
        const result = opts.slug ? [await enrich.enrichWithContent(opts.slug)] : await enrich.enrichAllWithContent();
        const enriched = result.filter((r: any) => r.enriched);
        console.log(`Enriched ${enriched.length}/${result.length} stubs with content`);
        for (const r of enriched) console.log(`  ✓ ${r.slug}`);
      } else {
        const result = opts.slug ? [enrich.enrichEntity(opts.slug)] : enrich.enrichAll();
        console.log(JSON.stringify(result, null, 2));
      }
      db.close();
    });

  program
    .command("health")
    .description("Run 10-dimension health check and write report")
    .action(async () => {
      const config = loadConfig();
      const db = new CBrainDB(config.dbPath);
      const outputsDir = join(resolve(config.vaultPath, ".."), "outputs");
      const { HealthChecker } = await import("../../core/health.js");
      const { Logger } = await import("../../core/logger.js");
      const logger = new Logger(outputsDir);
      const checker = new HealthChecker(db, outputsDir, logger);
      const report = await checker.checkAll();
      const icon = (s: string) => s === "pass" ? "✅" : s === "warn" ? "⚠️" : "❌";
      const whatItMeans: Record<string, string> = {
        "系统错误": "系统运行有没有报错", "语义去重": "有没有重复的页面", "疑似重复": "标题相似、可能是同一个东西",
        "一致性": "数据和文件是否一致", "完整性": "自动生成的页面内容是否充实", "孤岛检测": "有没有没人引用的孤立页面",
        "新增建议": "缺少哪些核心页面", "关注度分析": "哪些高频提及的实体内容太少", "数据就绪度": "数据是否已就绪可用", "原材料质量": "raw 目录的文件是否规范",
      };
      console.log(`\n  大脑体检 — ${report.timestamp.slice(0, 10)}\n`);
      for (const dim of report.dimensions) {
        const meaning = whatItMeans[dim.name] ?? "";
        if (dim.status === "pass") console.log(`  ${icon(dim.status)} ${dim.name}：正常`);
        else console.log(`  ${icon(dim.status)} ${dim.name}（${meaning}）：${dim.issues.length} 个问题`);
      }
      console.log(`\n  详细报告：outputs/health/health-${report.timestamp.slice(0, 10)}.md`);
      db.close();
    });

  program
    .command("doctor")
    .description("Health check: DB, vault, embedding")
    .action(async () => {
      const config = loadConfig();
      let ok = true;
      try {
        const db = new CBrainDB(config.dbPath);
        const cnt = (db.prepare("SELECT COUNT(*) as c FROM pages").get() as any).c;
        db.close();
        console.log(`  DB:      ${config.dbPath} (${cnt} pages)`);
      } catch (e) { console.error(`  DB:      FAIL — ${(e as Error).message}`); ok = false; }
      if (existsSync(config.vaultPath)) { console.log(`  Vault:   ${config.vaultPath} ✓`); }
      else { console.error(`  Vault:   ${config.vaultPath} NOT FOUND`); ok = false; }
      const apiKey = config.embedding.apiKey ?? process.env.ZHIPU_API_KEY;
      if (apiKey) {
        try {
          const emb = new ZhipuEmbeddingProvider(apiKey, config.embedding.baseUrl);
          const result = await emb.embed("test");
          console.log(`  Embed:   zhipu embedding-3 (${result.embedding.length}d) ✓`);
        } catch (e) { console.error(`  Embed:   FAIL — ${(e as Error).message}`); ok = false; }
      } else { console.error("  Embed:   ZHIPU_API_KEY not configured"); ok = false; }
      const nerEnabled = config.ner?.enabled !== false;
      if (nerEnabled) {
        const nerApiKey = config.ner?.llm_api_key ?? apiKey ?? process.env.ZHIPU_API_KEY;
        if (nerApiKey) {
          try {
            const llm = new ZhipuLLMProvider(nerApiKey, config.ner?.llm_base_url, config.ner?.llm_model);
            console.log(`  NER:     ${config.ner?.llm_model ?? "glm-4-flash"} ✓`);
          } catch (e) { console.error(`  NER:     FAIL — ${(e as Error).message}`); ok = false; }
        } else { console.log(`  NER:     disabled (no API key)`); }
      } else { console.log(`  NER:     disabled`); }
      console.log(ok ? "\n  All checks passed ✓" : "\n  Some checks failed ✗");
      process.exit(ok ? 0 : 1);
    });

  program
    .command("dream")
    .description("Nightly full pipeline: sync → enrich → cleanup → health → report")
    .action(async () => {
      const config = loadConfig();
      const deps = createDeps(config);
      await deps.lance.connect(config.lancePath);
      const { runDream } = await import("../../core/dream.js");
      const { SyncManager } = await import("../../core/sync.js");
      const { EnrichManager } = await import("../../core/enrich.js");
      const { HealthChecker } = await import("../../core/health.js");
      const { Logger } = await import("../../core/logger.js");
      const { PageManager } = await import("../../core/page.js");
      const { NerEngine } = await import("../../core/ner.js");
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
      if (report.stages.backup.path) console.log(`  Backup:  ${report.stages.backup.size_mb}MB`);
      console.log(`  Sync:    ${report.stages.sync.synced} 更新, ${report.stages.sync.skipped} 跳过`);
      console.log(`  Enrich:  ${report.stages.enrich.total} 实体, ${report.stages.enrich.upgraded} 升级`);
      console.log(`  Cleanup: ${report.stages.cleanup.orphans} 孤立, ${report.stages.cleanup.staleStubs} 过期 stub`);
      console.log(`  Health:  ${report.stages.health.overallStatus}`);
      console.log(`  ⏱ ${(report.duration_ms / 1000).toFixed(1)}s`);
      if (!report.locked) console.log(`  ⚠️ 上次 dream 仍在执行中，本次跳过`);
      deps.db.close();
      process.exit(report.locked ? 0 : 1);
    });

  program
    .command("index")
    .description("Generate Obsidian index files")
    .action(() => {
      const config = loadConfig();
      const db = new CBrainDB(config.dbPath);
      const outputsDir = join(resolve(config.vaultPath, ".."), "outputs");
      const { IndexGenerator } = require("../../core/indexes.js");
      const gen = new IndexGenerator(db, outputsDir);
      const files = gen.generateAll();
      console.log(`  Generated ${files.length} index files:`);
      for (const f of files) console.log(`    - ${f}`);
      db.close();
    });
}

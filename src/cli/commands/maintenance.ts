import type { Command } from "commander";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { CBrainDB } from "../../storage/sqlite.js";
import type { EmbeddingProvider } from "../../embedding/provider.js";
import { LanceDBManager } from "../../storage/lancedb.js";
import { checkLanceIntegrity } from "../../core/lance-integrity.js";
import { ZhipuEmbeddingProvider } from "../../embedding/zhipu.js";
import { ZhipuLLMProvider } from "../../llm/zhipu.js";
import { DeepSeekLLMProvider } from "../../llm/deepseek.js";
import { loadConfig, createDeps, resolveRuntimePath } from "../context.js";

/**
 * Reindex-vectors recovery handler — extracted for testability.
 *
 * Invariants:
 *   - DB is always closed (via finally), even on error
 *   - Never calls process.exit() — returns exit code instead
 *   - Never connects to live LanceDB
 */
export async function handleReindexVectors(
  lancePath: string,
  db: CBrainDB,
  embedding: EmbeddingProvider,
  log: (msg: string) => void = console.log,
  logError: (msg: string) => void = console.error,
): Promise<number> {
  const { rebuildLanceIndex } = await import("../../core/lance-rebuild.js");
  let exitCode = 0;
  try {
    const report = await rebuildLanceIndex(lancePath, db, embedding);
    log(`Rebuilt:  ${report.chunksRebuilt} pages chunks, ${report.insightsRebuilt} insights`);
    if (report.backupPath) {
      log(`Backup:   ${report.backupPath}`);
    }
    if (report.errors > 0) {
      log(`Errors:   ${report.errors}`);
      for (const d of report.errorDetails) log(`  - ${d}`);
    }
    exitCode = report.errors > 0 ? 1 : 0;
  } catch (e) {
    logError(`Reindex failed: ${(e as Error).message}`);
    exitCode = 1;
  } finally {
    db.close();
  }
  return exitCode;
}

export function register(program: Command) {
  program
    .command("sync")
    .description("Sync vault files to indexes")
    .option("--slug <slug>", "Sync a single page")
    .option("--reindex-vectors", "Rebuild LanceDB vectors from SQLite chunks and insights (safe recovery)")
    .action(async (opts) => {
      const config = loadConfig();
      const deps = createDeps(config);

      // --reindex-vectors: atomic staging rebuild, does NOT connect to live LanceDB
      if (opts.reindexVectors) {
        console.log("Reindexing vectors (atomic staging rebuild)...");
        const exitCode = await handleReindexVectors(config.lancePath, deps.db, deps.embedding);
        process.exitCode = exitCode;
        return;
      }

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
        const lanceOrphans = await sync.cleanLanceOrphans();
        if (lanceOrphans.length > 0) console.log(`LanceDB orphans: ${lanceOrphans.length} cleaned`);
        if (report.errors > 0) { console.log(`Errors:  ${report.errors}`); for (const d of report.errorDetails ?? []) console.log(`  - ${d}`); }
        if (report.nerEntities) {
          const parts = [`NER:     ${report.nerEntities} entities, ${report.nerRelations} relations, ${report.nerEvents} events extracted`];
          if (report.nerLowRelevanceSkipped) parts.push(`${report.nerLowRelevanceSkipped} low-relevance skipped`);
          console.log(parts.join(", "));
        }
      }
      deps.db.close();
    });

  program
    .command("enrich")
    .description("Run entity enrichment (tier promotion)")
    .option("--slug <slug>", "Specific entity slug (omit for all)")
    .action(async (opts) => {
      const config = loadConfig();
      const db = new CBrainDB(config.dbPath);
      const apiKey = config.embedding.apiKey ?? process.env.ZHIPU_API_KEY;
      const nerApiKey = config.ner?.llm_api_key ?? apiKey;
      const llm = nerApiKey ? new ZhipuLLMProvider(nerApiKey, config.ner?.llm_base_url, config.ner?.llm_model) : undefined;
      const { EnrichManager } = await import("../../core/enrich.js");
      const { PageManager } = await import("../../core/page.js");
      const pages = new PageManager(db, config.vaultPath);
      const enrich = new EnrichManager(db, undefined, llm, config.vaultPath, pages);
      const result = opts.slug ? [enrich.enrichEntity(opts.slug)] : enrich.enrichAll();
      console.log(JSON.stringify(result, null, 2));
      db.close();
    });

  program
    .command("health")
    .description("Run 14-dimension health check and write report")
    .option("--full", "Print full Markdown report to stdout")
    .option("--json", "Output detail JSON to stdout")
    .option("--dimension <name>", "Only check specified dimension")
    .action(async (opts) => {
      const config = loadConfig();
      const db = new CBrainDB(config.dbPath);
      const outputsDir = resolveRuntimePath(config);
      const { HealthChecker } = await import("../../core/health.js");
      const { Logger } = await import("../../core/logger.js");
      const logger = new Logger(outputsDir);
      const checker = new HealthChecker(db, outputsDir, logger, config.vaultPath);
      const report = await checker.checkAll();

      if (opts.json) {
        const { readFileSync } = await import("node:fs");
        if (report.reportPaths?.detail) {
          process.stdout.write(readFileSync(report.reportPaths.detail, "utf-8"));
        } else {
          process.stdout.write(JSON.stringify(report, null, 2));
        }
        db.close();
        return;
      }

      if (opts.full) {
        console.log(checker.writeFullReport(report));
        db.close();
        return;
      }

      const icon = (s: string) => s === "pass" ? "✅" : s === "warn" ? "⚠️" : "❌";
      const delta = report.delta;
      const prevDate = delta?.previousTimestamp ? delta.previousTimestamp.slice(5, 10) : null;
      const header = prevDate
        ? `${report.timestamp.slice(0, 10)}（vs 上次 ${prevDate}）`
        : report.timestamp.slice(0, 10);

      console.log(`\n  大脑体检 — ${header}\n`);

      for (const dim of report.dimensions) {
        const dd = delta?.dimensions.find(d => d.name === dim.name);
        if (dim.status === "pass") {
          console.log(`  ${icon(dim.status)} ${dim.name}：正常`);
          continue;
        }

        const count = dim.issues.length;
        let change = "";
        if (dd && dd.previousCount !== undefined) {
          const diff = dd.currentCount - dd.previousCount;
          const arrow = diff > 0 ? `↑${diff}` : diff < 0 ? `↓${Math.abs(diff)}` : "→";
          change = `（${arrow}`;
          if (dd.chronicSlugs.length > 0) change += `，慢性${dd.chronicSlugs.length}个`;
          if (dd.newIssues.length > 0) change += `，新增${dd.newIssues.length}个`;
          change += `）`;
        }
        console.log(`  ${icon(dim.status)} ${dim.name}：${count} 个问题${change}`);
      }

      if (delta && delta.previousTimestamp) {
        const parts: string[] = [];
        if (delta.totalNew > 0) parts.push(`🆕 新增 ${delta.totalNew} 个`);
        if (delta.totalResolved > 0) parts.push(`✅ 消失 ${delta.totalResolved} 个`);
        if (delta.totalChronic > 0) parts.push(`🔁 慢性 ${delta.totalChronic} 个`);
        if (parts.length > 0) console.log(`\n  ${parts.join(" | ")}`);
      }

      if (report.reportPaths) {
        console.log(`\n  摘要报告：${report.reportPaths.summary}`);
        console.log(`  行动清单：${report.reportPaths.actions}`);
      }

      db.close();
    });

  program
    .command("doctor")
    .description("基础设施就绪检查")
    .option("--first-run", "2.0 首次运行就绪检查（配置、路径、DB、索引、服务、MCP）")
    .option("--json", "JSON 输出（配合 --first-run）")
    .action(async (opts: { firstRun?: boolean; json?: boolean }) => {
      if (opts.firstRun) {
        const { runFirstRunDoctor, formatHuman, formatJson } = await import("../../core/first-run.js");
        const report = await runFirstRunDoctor();
        console.log(opts.json ? formatJson(report) : formatHuman(report));
        process.exit(report.overallStatus === "fail" ? 1 : 0);
        return;
      }
      const config = loadConfig();
      let ok = true;
      try {
        const db = new CBrainDB(config.dbPath);
        const cnt = db.getPageCount();
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
            const _llm = new ZhipuLLMProvider(nerApiKey, config.ner?.llm_base_url, config.ner?.llm_model);
            console.log(`  NER:     ${config.ner?.llm_model ?? "glm-4-flash"} ✓`);
          } catch (e) { console.error(`  NER:     FAIL — ${(e as Error).message}`); ok = false; }
        } else { console.log(`  NER:     disabled (no API key)`); }
      } else { console.log(`  NER:     disabled`); }
      // LanceDB integrity check
      let db2: CBrainDB | null = null;
      try {
        db2 = new CBrainDB(config.dbPath);
        const lanceReport = await checkLanceIntegrity(config.lancePath, db2);
        for (const c of lanceReport.checks) {
          const icon = c.status === "pass" ? "✓" : c.status === "warn" ? "⚠" : "✗";
          if (c.status !== "pass" || c.id === "lance:path" && c.message.includes("新安装")) {
            console.log(`  Lance:   ${icon} ${c.message.split("\n")[0]}`);
            if (c.action) {
              for (const line of c.action.split("\n")) {
                console.log(`           ${line}`);
              }
            }
            if (c.status === "fail") ok = false;
          } else {
            console.log(`  Lance:   ✓ ${c.message.split("\n")[0]}`);
          }
        }
      } catch (e) {
        console.error(`  Lance:   ✗ check failed — ${(e as Error).message}`);
        ok = false;
      } finally {
        if (db2) { try { db2.close(); } catch { /* ignore */ } }
      }
      console.log(ok ? "\n  All checks passed ✓" : "\n  Some checks failed ✗");
      process.exit(ok ? 0 : 1);
    });

  program
    .command("compact")
    .description("Compact LanceDB files and reclaim disk space")
    .action(async () => {
      const config = loadConfig();
      const lance = new LanceDBManager();
      const beforeBytes = await import("node:fs").then(m => {
        const { statSync } = m;
        try {
          const { readdirSync } = require("node:fs");
          let total = 0;
          function walkDir(dir: string) {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
              const p = require("node:path").join(dir, entry.name);
              if (entry.isDirectory()) walkDir(p);
              else total += statSync(p).size;
            }
          }
          walkDir(config.lancePath);
          return total;
        } catch { return 0; }
      });

      await lance.connect(config.lancePath);
      console.log("Compacting...");
      const result = await lance.compact();
      await lance.close();

      const afterBytes = await import("node:fs").then(m => {
        const { statSync, readdirSync } = m;
        try {
          let total = 0;
          function walkDir(dir: string) {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
              const p = require("node:path").join(dir, entry.name);
              if (entry.isDirectory()) walkDir(p);
              else total += statSync(p).size;
            }
          }
          walkDir(config.lancePath);
          return total;
        } catch { return 0; }
      });

      const beforeMB = (beforeBytes / 1024 / 1024).toFixed(1);
      const afterMB = (afterBytes / 1024 / 1024).toFixed(1);
      const savedMB = ((beforeBytes - afterBytes) / 1024 / 1024).toFixed(1);

      console.log(`  Tables:     ${result.tables.join(", ")}`);
      console.log(`  Fragments:  ${result.fragmentsRemoved} removed, ${result.fragmentsAdded} created`);
      console.log(`  Disk:       ${beforeMB}MB → ${afterMB}MB (saved ${savedMB}MB)`);

      // Restart running serve processes to pick up new LanceDB files
      const { execSync } = await import("node:child_process");
      try {
        const pids = execSync("pgrep -f 'cbrain.*serve'", { encoding: "utf-8" }).trim().split("\n").filter(Boolean);
        if (pids.length > 0) {
          execSync(`kill ${pids.join(" ")}`);
          console.log(`  Restart:    killed ${pids.length} stale serve process(es) (launchd will restart)`);
        }
      } catch {
        // No serve processes running, nothing to restart
      }
    });

  program
    .command("dream")
    .description("Nightly full pipeline: sync → enrich → cleanup → health → insight archive")
    .action(async () => {
      const config = loadConfig();
      const deps = createDeps(config);
      await deps.lance.connect(config.lancePath);
      const { runDream } = await import("../../core/dream.js");
      const { SyncManager } = await import("../../core/sync.js");
      const { EnrichManager } = await import("../../core/enrich.js");
      const { InsightManager } = await import("../../core/insight.js");
      const { HealthChecker } = await import("../../core/health.js");
      const { Logger } = await import("../../core/logger.js");
      const { PageManager } = await import("../../core/page.js");
      const { NerEngine } = await import("../../core/ner.js");
      const outputsDir = resolveRuntimePath(config);
      const logger = new Logger(outputsDir);
      const pages = new PageManager(deps.db, config.vaultPath, logger);
      const nerEngine = deps.llm ? new NerEngine(deps.llm, logger) : undefined;
      const syncMgr = new SyncManager(deps.db, deps.embedding, deps.lance, { nerEngine, pages, logger });
      const enrichMgr = new EnrichManager(deps.db, undefined, deps.llm, config.vaultPath, pages);
      const insightMgr = new InsightManager(deps.db, deps.embedding, deps.lance, logger);
      const health = new HealthChecker(deps.db, outputsDir, logger, config.vaultPath);
      const report = await runDream(config.vaultPath, deps.db, syncMgr, enrichMgr, health, outputsDir, logger, insightMgr, config.dbPath,
        deps.llm && deps.embedding ? { llm: deps.llm, embedding: deps.embedding, lance: deps.lance } : undefined,
        deps.lance, undefined, pages);
      if (report.locked) {
        console.log(`⚠️ Dream — ${report.timestamp.slice(0, 10)} 已跳过`);
        console.log(`  上次 dream 仍在执行中（30 分钟锁未释放），本次跳过`);
        deps.db.close();
        process.exit(1);
      }
      console.log(`🌙 Dream — ${report.timestamp.slice(0, 10)}`);
      if (report.stages.backup.path) console.log(`  Backup:  ${report.stages.backup.size_mb}MB`);
      console.log(`  Sync:    ${report.stages.sync.synced} 更新, ${report.stages.sync.skipped} 跳过`);
      console.log(`  Enrich:  ${report.stages.enrich.total} 实体, ${report.stages.enrich.upgraded} 升级`);
      console.log(`  Seal:    ${report.stages.seal.sealed} 页压缩, ${report.stages.seal.skipped} 跳过`);
      console.log(`  Stub:    ${report.stages.stub_enrich.enriched} 页富化, ${report.stages.stub_enrich.skipped} 跳过`);
      console.log(`  Cleanup: ${report.stages.cleanup.orphans} 孤立, ${report.stages.cleanup.staleStubs} 过期 stub, ${report.stages.cleanup.lanceOrphans} 向量孤儿`);
      console.log(`  Health:  ${report.stages.health.overallStatus}`);
      console.log(`  Insight: ${report.stages.insight_archive.archived} 条过期归档`);
      if (report.stages.wake_up_diff.baselineCreated) {
        console.log(`  Wake-up:  基线已建立`);
      } else if (report.stages.wake_up_diff.changes > 0 || report.stages.wake_up_diff.newItems > 0) {
        console.log(`  Wake-up:  ${report.stages.wake_up_diff.changes} 项变化, ${report.stages.wake_up_diff.newItems} 个新增`);
      }
      console.log(`  ⏱ ${(report.duration_ms / 1000).toFixed(1)}s`);
      deps.db.close();
      process.exit(0);
    });

  program
    .command("reflect")
    .description("Run reflect stage: synthesize entities, infer relations, generate insights")
    .action(async () => {
      const config = loadConfig();
      const deps = createDeps(config);
      await deps.lance.connect(config.lancePath);
      const { ReflectManager } = await import("../../core/reflect.js");
      const { InsightManager } = await import("../../core/insight.js");
      const { Logger } = await import("../../core/logger.js");
      const { PageManager } = await import("../../core/page.js");
      const outputsDir = resolveRuntimePath(config);
      const logger = new Logger(outputsDir);
      const pages = new PageManager(deps.db, config.vaultPath, logger);

      const reflectLlm = config.reflect?.llm_api_key
        ? new DeepSeekLLMProvider(config.reflect.llm_api_key, config.reflect.llm_base_url, config.reflect.llm_model)
        : deps.llm;

      if (!reflectLlm) {
        console.log("  ⚠️ 未配置 reflect LLM，需要 API key");
        deps.db.close();
        process.exit(1);
      }

      const { ContentPipeline } = await import("../../core/pipeline.js");
      const reflectPipeline = new ContentPipeline(deps.db, deps.embedding, deps.lance);
      const insightMgr = new InsightManager(deps.db, deps.embedding, deps.lance, logger);
      const mgr = new ReflectManager(deps.db, pages, reflectLlm, reflectPipeline, deps.embedding, insightMgr, logger);
      console.log("🧠 Reflecting...");
      const report = await mgr.reflectAll();

      console.log(`  Entity Synthesis:  ${report.entitiesSynthesized} 实体综合`);
      console.log(`  Relation Inference: ${report.relationsInferred} 关系推理`);
      console.log(`  Insight Generation: ${report.insightsGenerated} 洞察生成`);

      if (report.details.syntheses.length > 0) {
        console.log("\n  综合摘要：");
        for (const s of report.details.syntheses) {
          console.log(`    ${s.slug}: ${s.summary.slice(0, 60)}...`);
        }
      }
      if (report.details.relations.length > 0) {
        console.log("\n  推理关系：");
        for (const r of report.details.relations) {
          console.log(`    ${r.from} → ${r.to} [${r.relation}]`);
        }
      }
      if (report.details.insights.length > 0) {
        console.log("\n  洞察：");
        for (const i of report.details.insights) {
          console.log(`    ${i.content.slice(0, 60)}...`);
        }
      }

      deps.db.close();
      process.exit(0);
    });

  program
    .command("stub-enrich [slug]")
    .description("Enrich thin stub pages with LLM-generated summaries (single slug or all candidates)")
    .option("-t, --threshold <n>", "Minimum mention count to qualify as thin stub", "3")
    .action(async (slug?: string, opts?: { threshold?: string }) => {
      const config = loadConfig();
      const deps = createDeps(config);
      await deps.lance.connect(config.lancePath);

      if (!deps.llm) {
        console.log("  ⚠️ 未配置 LLM，需要 API key");
        deps.db.close();
        process.exit(1);
      }

      const { StubEnrichManager } = await import("../../core/stub-enrich.js");
      const { Logger } = await import("../../core/logger.js");
      const { PageManager } = await import("../../core/page.js");
      const { ContentPipeline } = await import("../../core/pipeline.js");
      const outputsDir = resolveRuntimePath(config);
      const logger = new Logger(outputsDir);
      const pages = new PageManager(deps.db, config.vaultPath, logger);
      const pipeline = new ContentPipeline(deps.db, deps.embedding, deps.lance, { pages });
      const mgr = new StubEnrichManager(deps.db, deps.llm, deps.embedding, deps.lance, pages, pipeline, logger);

      if (slug) {
        console.log(`🔍 Enriching stub: ${slug}`);
        const result = await mgr.enrichStub(slug);
        if (result.enriched) {
          console.log(`  ✅ 已富化`);
          const page = pages.getBySlug(slug);
          if (page) {
            console.log(`  ${page.body.split("\n").slice(0, 5).join("\n  ")}`);
          }
        } else {
          console.log(`  ⏭️ 跳过: ${result.reason}`);
        }
      } else {
        const threshold = parseInt(opts?.threshold ?? "3", 10);
        console.log(`🔍 Enriching all thin stubs (mention >= ${threshold})...`);
        const result = await mgr.enrichAll(threshold);
        console.log(`  ✅ ${result.enriched} 页富化, ${result.skipped} 跳过, ${result.errors} 错误`);
      }

      deps.db.close();
      process.exit(0);
    });

  program
    .command("discover")
    .description("Run discovery pipeline to detect structural anomalies in knowledge graph")
    .action(async () => {
      const config = loadConfig();
      const deps = createDeps(config);
      await deps.lance.connect(config.lancePath);
      const { ReflectManager } = await import("../../core/reflect.js");
      const { InsightManager } = await import("../../core/insight.js");
      const { Logger } = await import("../../core/logger.js");
      const { PageManager } = await import("../../core/page.js");
      const outputsDir = resolveRuntimePath(config);
      const logger = new Logger(outputsDir);
      const pages = new PageManager(deps.db, config.vaultPath, logger);

      const reflectLlm = config.reflect?.llm_api_key
        ? new DeepSeekLLMProvider(config.reflect.llm_api_key, config.reflect.llm_base_url, config.reflect.llm_model)
        : deps.llm;

      const { ContentPipeline } = await import("../../core/pipeline.js");
      const reflectPipeline = new ContentPipeline(deps.db, deps.embedding, deps.lance);
      const insightMgr = new InsightManager(deps.db, deps.embedding, deps.lance, logger);
      const reflect = new ReflectManager(deps.db, pages, reflectLlm, reflectPipeline, deps.embedding, insightMgr, logger);
      console.log("🔍 Running discovery (structural)...");
      const reflectReport = await reflect.runDiscovery();

      const { DiscoveryManager } = await import("../../core/discovery.js");
      const discoveryMgr = new DiscoveryManager(deps.db, reflectLlm, logger);
      console.log("🔍 Running discovery (trend/gap/contradiction)...");
      const discoveryReport = await discoveryMgr.runDiscovery();

      const mergedByType = { ...reflectReport.byType, ...discoveryReport.byType };
      const mergedByActionable = {
        high: (reflectReport.byActionable.high ?? 0) + (discoveryReport.byActionable.high ?? 0),
        medium: (reflectReport.byActionable.medium ?? 0) + (discoveryReport.byActionable.medium ?? 0),
        low: (reflectReport.byActionable.low ?? 0) + (discoveryReport.byActionable.low ?? 0),
      };
      const total = reflectReport.total + discoveryReport.total;

      const typeParts = Object.entries(mergedByType).map(([k, v]) => `${k}: ${v}`).join(", ");
      const actionParts = Object.entries(mergedByActionable).map(([k, v]) => `${k}: ${v}`).join(", ");

      console.log(`  发现总数: ${total}`);
      console.log(`  类型分布: ${typeParts}`);
      console.log(`  重要程度: ${actionParts}`);
      console.log(`  可自动应用: ${reflectReport.autoApplicable ?? 0}`);

      deps.db.close();
      process.exit(0);
    });

  program
    .command("index")
    .description("Generate Obsidian index files")
    .action(() => {
      const config = loadConfig();
      const db = new CBrainDB(config.dbPath);
      const outputsDir = resolveRuntimePath(config);
      const { IndexGenerator } = require("../../core/indexes.js");
      const gen = new IndexGenerator(db, outputsDir);
      const files = gen.generateAll();
      console.log(`  Generated ${files.length} index files:`);
      for (const f of files) console.log(`    - ${f}`);
      db.close();
    });

  program
    .command("diagnose-insight")
    .description("Diagnose insight candidate pool and scoring (no LLM calls)")
    .action(async () => {
      const config = loadConfig();
      const deps = createDeps(config);
      await deps.lance.connect(config.lancePath);
      const { PageManager } = await import("../../core/page.js");
      const { Logger } = await import("../../core/logger.js");
      const outputsDir = resolveRuntimePath(config);
      const logger = new Logger(outputsDir);
      const pages = new PageManager(deps.db, config.vaultPath, logger);
      const { ReflectManager } = await import("../../core/reflect.js");
      const mgr = new ReflectManager(deps.db, pages, undefined, undefined, deps.embedding, undefined, logger);
      const report = await mgr.diagnoseCandidates();

      console.log("\n=== 候选池诊断 ===\n");
      console.log(`候选池大小: ${report.poolSize}`);
      console.log(`  间接对: ${report.bySource.indirect}`);
      console.log(`  跨社区: ${report.bySource.crossCommunity}`);
      console.log(`  随机远距: ${report.bySource.randomDistant}\n`);

      if (report.topCandidates.length > 0) {
        console.log("Top-10 候选:");
        console.log("排名  分数    距离    Jaccard 类型                    实体 A              实体 B");
        console.log("------ ------- ------- ------- ---------------------- ------------------- -------------------");
        for (const c of report.topCandidates) {
          const distStr = c.dist === -1 ? "∞" : `${c.dist}跳`;
          console.log(`${String(c.rank).padEnd(6)} ${String(c.score).padEnd(7)} ${distStr.padEnd(7)} ${String(c.sourceJaccard).padEnd(7)} ${c.typeMix.padEnd(22)} ${c.entityA.slice(0, 18).padEnd(19)} ${c.entityB.slice(0, 18)}`);
        }
        console.log();
      }

      console.log("分数分布:");
      for (const b of report.scoreDistribution) {
        const bar = "█".repeat(Math.round(b.count / Math.max(1, report.poolSize) * 40));
        console.log(`  ${b.bucket}: ${String(b.count).padEnd(4)} ${bar}`);
      }

      const avgDist = report.topCandidates.reduce((s, c) => s + (c.dist > 0 ? c.dist : 0), 0) / Math.max(1, report.topCandidates.filter(c => c.dist > 0).length);
      console.log(`\nTop-10 平均距离: ${avgDist.toFixed(1)} 跳`);
      const highScore = report.topCandidates.filter(c => c.score >= 0.8).length;
      console.log(`0.8+ 高分候选: ${highScore} 个`);
      console.log(`\n通过标准:`);
      console.log(`  候选池 ≥ 50: ${report.poolSize >= 50 ? "✅" : "❌"}`);
      console.log(`  Top-10 平均距离 ≥ 3: ${avgDist >= 3 ? "✅" : "❌"}`);
      console.log(`  0.8+ 至少 1 对: ${highScore > 0 ? "✅" : "❌"}`);

      deps.db.close();
    });

  program
    .command("dossier")
    .description("Generate or update a structured dossier for an entity")
    .argument("<slug>", "Entity slug (e.g. entity/zhang-san)")
    .option("--force", "Force regeneration even if cached")
    .option("--list", "List all entities with dossiers")
    .action(async (slug, opts) => {
      const config = loadConfig();
      const deps = createDeps(config);
      await deps.lance.connect(config.lancePath);

      if (opts.list) {
        const { PageManager: PM } = await import("../../core/page.js");
        const { Logger: L } = await import("../../core/logger.js");
        const pagesList = new PM(deps.db, config.vaultPath, new L(resolveRuntimePath(config)));
        const allPages = deps.db.listPages({ limit: 10000 });
        const withDossier: Array<{ slug: string; title: string; ts: string }> = [];
        for (const p of allPages) {
          const full = pagesList.getBySlug(p.slug);
          const ts = (full?.frontmatter as Record<string, unknown> | undefined)?.dossier_updated as string | undefined;
          if (ts) withDossier.push({ slug: p.slug, title: p.title, ts });
        }
        if (withDossier.length === 0) {
          console.log("  No entities with dossiers found.");
        } else {
          console.log(`  ${withDossier.length} entities with dossiers:\n`);
          for (const p of withDossier) {
            const age = ((Date.now() - new Date(p.ts).getTime()) / 86_400_000).toFixed(1);
            console.log(`    ${p.slug.padEnd(35)} ${p.title.padEnd(20)} ${age}d ago`);
          }
        }
        deps.db.close();
        return;
      }

      if (!deps.llm) {
        console.error("  ⚠️ 未配置 LLM，无法生成档案");
        deps.db.close();
        process.exit(1);
      }

      const { generateDossier, isDossierFresh } = await import("../../core/dossier.js");
      const { PageManager } = await import("../../core/page.js");
      const { GraphManager } = await import("../../core/graph.js");
      const { Logger } = await import("../../core/logger.js");
      const { ContentPipeline } = await import("../../core/pipeline.js");
      const outputsDir = resolveRuntimePath(config);
      const logger = new Logger(outputsDir);
      const pages = new PageManager(deps.db, config.vaultPath, logger);
      const pipeline = new ContentPipeline(deps.db, deps.embedding, deps.lance);
      const graph = new GraphManager(deps.db);

      if (!opts.force) {
        const page = pages.getBySlug(slug);
        if (page) {
          const freshness = isDossierFresh(page.frontmatter);
          if (freshness.fresh) {
            const age = ((Date.now() - new Date(freshness.updatedAt!).getTime()) / 86_400_000).toFixed(1);
            console.log(`  ✓ ${page.title} 的档案已是最新（${age} 天前生成）`);
            console.log(`    使用 --force 强制重新生成`);
            deps.db.close();
            return;
          }
        }
      }

      console.log(`  Generating dossier for ${slug}...`);
      const result = await generateDossier(slug, {
        db: deps.db,
        pages,
        graph,
        llm: deps.llm,
        pipeline,
        logger,
      });

      console.log(`  ✓ ${result.title}`);
      console.log(`    Generated: ${result.generated_at}`);
      console.log(`\n${result.dossier}`);
      deps.db.close();
    });

  program
    .command("hierarchy")
    .description("Manage entity hierarchy (reports_to)")
    .argument("[slug]", "Entity slug (e.g. entity/zhang-san)")
    .option("--reports-to <managerSlug>", "Set direct manager")
    .option("--remove", "Remove hierarchy relationship")
    .option("--list", "List all entities with hierarchy")
    .action(async (slug, opts) => {
      const config = loadConfig();
      const deps = createDeps(config);
      const { PageManager } = await import("../../core/page.js");
      const { GraphManager } = await import("../../core/graph.js");
      const pages = new PageManager(deps.db, config.vaultPath);
      const graph = new GraphManager(deps.db);

      if (opts.list) {
        const allPages = deps.db.listPages({ limit: 10000 });
        const withHierarchy: Array<{ slug: string; title: string; reports_to: string; reports_to_title: string }> = [];
        for (const p of allPages) {
          const full = pages.getBySlug(p.slug);
          const rt = (full?.frontmatter as Record<string, unknown> | undefined)?.reports_to as string | undefined;
          if (rt) {
            const manager = pages.getBySlug(rt);
            withHierarchy.push({ slug: p.slug, title: p.title, reports_to: rt, reports_to_title: manager?.title ?? rt });
          }
        }
        if (withHierarchy.length === 0) {
          console.log("  No entities with hierarchy set.");
        } else {
          console.log(`  ${withHierarchy.length} entities with hierarchy:\n`);
          for (const e of withHierarchy) {
            console.log(`    ${e.slug.padEnd(40)} ${e.title.padEnd(15)} → ${e.reports_to_title}`);
          }
        }
        deps.db.close();
        return;
      }

      if (!slug) {
        console.error("  ⚠️ 需要指定 slug，或使用 --list");
        deps.db.close();
        process.exit(1);
      }

      if (opts.remove) {
        const { removeHierarchy } = await import("../../core/hierarchy.js");
        const removed = removeHierarchy(slug, { pages, graph });
        if (!removed) {
          console.log(`  ${slug} 未设置 reports_to`);
        } else {
          const manager = pages.getBySlug(removed);
          console.log(`  ✓ 已移除 ${slug} 的上级关系 (${manager?.title ?? removed})`);
          pages.syncAffectedSlugs([slug, removed]);
        }
        deps.db.close();
        return;
      }

      if (opts.reportsTo) {
        const { setHierarchy } = await import("../../core/hierarchy.js");
        const page = pages.getBySlug(slug);
        const oldReportsTo = (page?.frontmatter as Record<string, unknown>)?.reports_to as string | undefined;
        setHierarchy(slug, opts.reportsTo, { pages, graph });
        const manager = pages.getBySlug(opts.reportsTo);
        console.log(`  ✓ ${slug} 的直线领导设为 ${manager?.title ?? opts.reportsTo}`);
        const affected = [slug, opts.reportsTo];
        if (oldReportsTo && oldReportsTo !== opts.reportsTo) affected.push(oldReportsTo);
        pages.syncAffectedSlugs(affected);
        deps.db.close();
        return;
      }

      // Show hierarchy context
      const { getHierarchyContext } = await import("../../core/hierarchy.js");
      const ctx = getHierarchyContext(slug, { pages, graph });
      const entity = pages.getBySlug(slug);
      console.log(`  ${entity?.title ?? slug} 的组织层级\n`);
      if (ctx.reports_to) {
        console.log(`  直属上级: ${ctx.reports_to_title ?? ctx.reports_to}`);
      } else {
        console.log(`  直属上级: (未设置)`);
      }
      if (ctx.subordinates.length > 0) {
        console.log(`  直属下级: ${ctx.subordinates.map(s => s.title).join(", ")}`);
      }
      if (ctx.peers.length > 0) {
        console.log(`  同级:     ${ctx.peers.map(s => s.title).join(", ")}`);
      }
      deps.db.close();
    });

  program
    .command("backfill")
    .description("Backfill structured facts for existing entities (dry-run by default)")
    .option("--apply", "Actually write to frontmatter (default is dry-run)")
    .option("--limit <n>", "Max entities to scan", "50")
    .option("--slug <slug>", "Target a single entity by slug")
    .option("--fields <list>", "Comma-separated field names to backfill")
    .action(async (opts) => {
      const config = loadConfig();
      const deps = createDeps(config);
      if (!deps.llm) {
        console.error("No LLM configured — backfill requires an LLM provider");
        process.exit(1);
      }

      const { structuredFactsBackfill } = await import("../../core/structured-facts-backfill.js");
      const report = await structuredFactsBackfill(deps.db, config.vaultPath, deps.llm, {
        apply: opts.apply === true,
        limit: parseInt(opts.limit, 10) || 50,
        slug: opts.slug,
        onlyFields: opts.fields ? opts.fields.split(",").map((f: string) => f.trim()) : undefined,
      });

      console.log(`Scanned:    ${report.scanned}`);
      console.log(`Would apply: ${report.wouldApply}`);
      console.log(`Conflicts:  ${report.conflicts}`);
      console.log(`Skipped:    ${report.skipped}`);

      if (report.examples.length > 0) {
        console.log("\nExamples:");
        for (const ex of report.examples.slice(0, 10)) {
          const cur = ex.current ? ` (current: ${ex.current})` : " (empty)";
          console.log(`  ${ex.slug}.${ex.field} = ${ex.proposed}${cur}`);
          console.log(`    evidence: ${ex.evidence}`);
        }
      }

      deps.db.close();
    });

  program
    .command("relocate")
    .description("Fix misplaced pages in records/ by scanning file frontmatter and moving to correct directories")
    .option("--dry-run", "Show what would change without modifying anything")
    .option("--type <type>", "Only process pages with this frontmatter type")
    .action(async (opts) => {
      const config = loadConfig();
      const db = new CBrainDB(config.dbPath);
      const { join } = await import("node:path");
      const { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, readdirSync } = await import("node:fs");
      const { parseFrontmatter, stringifyFrontmatter } = await import("../../utils/frontmatter.js");
      const { getOntology } = await import("../../ontology/loader.js");
      const ontology = getOntology();
      const concreteTypes = new Set(ontology.getConcreteEntityTypes());

      const recordsDir = join(config.vaultPath, "records");
      if (!existsSync(recordsDir)) { console.log("No records/ directory found."); return; }

      const INVALID_TYPE_FIX: Record<string, string> = {
        "entity/concept": "concept/concept",
        "entity/technology": "concept/technology",
        "entity/theory": "record",
        "entity/framework": "record",
        "concept/theory": "record",
        "event": "record",
      };

      type MisplacedFile = { name: string; path: string; frontmatterType: string; targetType: string; action: "move" | "fix-frontmatter" | "delete" | "skip" };
      const files: MisplacedFile[] = [];

      for (const f of readdirSync(recordsDir).filter(f => f.endsWith(".md"))) {
        const content = readFileSync(join(recordsDir, f), "utf-8");
        const { frontmatter } = parseFrontmatter(content);
        const fmType = (frontmatter as Record<string, unknown>).type as string;
        if (!fmType || fmType === "record") continue;
        if (opts.type && fmType !== opts.type) continue;

        let targetType = fmType;
        let action: MisplacedFile["action"] = "move";

        if (concreteTypes.has(fmType)) {
          const vaultDir = ontology.getVaultDir(fmType);
          const targetPath = join(config.vaultPath, vaultDir, f);
          if (existsSync(targetPath)) {
            action = "delete";
          } else {
            action = "move";
          }
        } else {
          const fix = INVALID_TYPE_FIX[fmType];
          targetType = fix ?? "record";
          if (targetType === "record") {
            action = "fix-frontmatter";
          } else if (concreteTypes.has(targetType)) {
            const vaultDir = ontology.getVaultDir(targetType);
            const targetPath = join(config.vaultPath, vaultDir, f);
            action = existsSync(targetPath) ? "delete" : "move";
          } else {
            action = "fix-frontmatter";
          }
        }

        files.push({ name: f.replace(/\.md$/, ""), path: join(recordsDir, f), frontmatterType: fmType, targetType, action });
      }

      if (files.length === 0) {
        console.log("No misplaced pages found in records/.");
        return;
      }

      let moved = 0, fixed = 0, deleted = 0, errors = 0;
      const byAction: Record<string, string[]> = {};

      for (const file of files) {
        const label = file.action === "move"
          ? `${file.frontmatterType} → move to ${ontology.getVaultDir(file.targetType)}/`
          : file.action === "delete"
          ? `${file.frontmatterType} → remove duplicate (exists in ${ontology.getVaultDir(file.frontmatterType)}/)`
          : `${file.frontmatterType} → fix frontmatter to record`;
        // biome-ignore lint/suspicious/noAssignInExpressions: intentional map grouping
        (byAction[label] ??= []).push(file.name);

        if (opts.dryRun) {
          if (file.action === "move") moved++;
          else if (file.action === "fix-frontmatter") fixed++;
          else if (file.action === "delete") deleted++;
          continue;
        }

        try {
          const content = readFileSync(file.path, "utf-8");
          const { frontmatter, body } = parseFrontmatter(content);

          if (file.action === "move") {
            const vaultDir = ontology.getVaultDir(file.targetType);
            const destDir = join(config.vaultPath, vaultDir);
            mkdirSync(destDir, { recursive: true });
            const newSlug = `${vaultDir}/${file.name}`;
            const newFilePath = `${vaultDir}/${file.name}.md`;
            const fm = { ...frontmatter, type: file.targetType, slug: newSlug, updated_at: new Date().toISOString() };
            writeFileSync(join(destDir, `${file.name}.md`), stringifyFrontmatter(fm, body), "utf-8");
            unlinkSync(file.path);
            const oldSlug = (frontmatter as Record<string, unknown>).slug as string ?? `records/${file.name}`;
            if (oldSlug !== newSlug) {
              db.movePage(oldSlug, newSlug, file.targetType, newFilePath);
            } else {
              db.updateType(newSlug, file.targetType);
            }
            moved++;
          } else if (file.action === "delete") {
            unlinkSync(file.path);
            const oldSlug = (frontmatter as Record<string, unknown>).slug as string ?? `records/${file.name}`;
            db.deletePageCascaded(oldSlug);
            deleted++;
          } else {
            const fm = { ...frontmatter, type: "record", updated_at: new Date().toISOString() };
            writeFileSync(file.path, stringifyFrontmatter(fm, body), "utf-8");
            const oldSlug = (frontmatter as Record<string, unknown>).slug as string ?? `records/${file.name}`;
            db.updateType(oldSlug, "record");
            fixed++;
          }
        } catch (err) {
          console.error(`  ERROR: ${file.name}: ${err}`);
          errors++;
        }
      }

      console.log(`\nMisplaced pages in records/: ${files.length}`);
      console.log(`  Moved to correct dir:      ${moved}`);
      console.log(`  Fixed frontmatter to record: ${fixed}`);
      console.log(`  Removed duplicates:         ${deleted}`);
      if (errors) console.log(`  Errors:                     ${errors}`);

      for (const [action, names] of Object.entries(byAction)) {
        console.log(`\n  ${action} (${names.length}):`);
        for (const n of names.slice(0, 10)) console.log(`    - ${n}`);
        if (names.length > 10) console.log(`    ... and ${names.length - 10} more`);
      }

      if (opts.dryRun) console.log("\n  (DRY RUN)");
      db.close();
    });

  // ─── dedup-types: cross-type entity dedup ──────────────────────
  program
    .command("dedup-types")
    .description("Find and merge same-name entities that exist under different types")
    .option("--dry-run", "Show plan without executing merges (default)")
    .option("--execute", "Actually merge duplicates")
    .option("--all", "Merge all cross-type pairs, not just affinity groups")
    .action(async (opts) => {
      const config = loadConfig();
      const deps = createDeps(config, false);
      const db = deps.db;
      const { getOntology } = await import("../../ontology/loader.js");
      const ontology = getOntology();
      const affinityOnly = !opts.all;

      // Find all cross-type exact-name duplicates
      const pairs = db.findCrossTypeDuplicates() as Array<{
        title: string;
        slug_a: string;
        type_a: string;
        slug_b: string;
        type_b: string;
      }>;

      if (pairs.length === 0) {
        console.log("No cross-type duplicates found.");
        db.close();
        return;
      }

      console.log(`Found ${pairs.length} cross-type duplicate pairs.\n`);

      // Group by normalized title → all slugs/types with that name
      const byTitle = new Map<string, Array<{ slug: string; type: string }>>();
      for (const p of pairs) {
        const norm = normalize(p.title);
        let group = byTitle.get(norm);
        if (!group) {
          group = [];
          byTitle.set(norm, group);
        }
        // Add both sides (dedup by slug)
        if (!group.some(g => g.slug === p.slug_a)) group.push({ slug: p.slug_a, type: p.type_a });
        if (!group.some(g => g.slug === p.slug_b)) group.push({ slug: p.slug_b, type: p.type_b });
      }

      // For each group, determine winner via type priority
      interface MergePlan {
        title: string;
        target: { slug: string; type: string };
        sources: Array<{ slug: string; type: string }>;
        reason: string;
      }

      const plans: MergePlan[] = [];
      const skipped: Array<{ title: string; reason: string }> = [];

      for (const [_norm, group] of byTitle) {
        if (group.length < 2) continue;

        // Check if any pair in group has affinity
        const hasAffinity = affinityOnly
          ? group.some((a, i) => group.some((b, j) => i !== j && ontology.areTypesAffine(a.type, b.type)))
          : true;

        if (affinityOnly && !hasAffinity) {
          skipped.push({ title: group[0].slug, reason: "no affinity" });
          continue;
        }

        // Find winner: prefer highest type priority within affinity groups,
        // break ties with mention_count (cross-affinity-group comparison)
        let winner = group[0];
        const winnerMentions = () => db.getPageTierAndMentions(winner.slug)?.mention_count ?? 0;
        for (let i = 1; i < group.length; i++) {
          if (ontology.areTypesAffine(winner.type, group[i].type)) {
            // Same affinity group → use type priority
            const preferred = ontology.resolveTypePriority(winner.type, group[i].type);
            if (preferred === group[i].type) {
              winner = group[i];
            }
          } else {
            // Cross affinity group → compare mention counts
            const curMentions = db.getPageTierAndMentions(group[i].slug)?.mention_count ?? 0;
            if (curMentions > winnerMentions()) {
              winner = group[i];
            }
          }
        }

        const sources = group.filter(g => g.slug !== winner.slug);

        // Check all are affine to winner
        const allAffine = sources.every(s => ontology.areTypesAffine(s.type, winner.type));
        if (!allAffine && affinityOnly) {
          skipped.push({ title: winner.slug, reason: "not all affine" });
          continue;
        }

        plans.push({
          title: db.getPageTitle(winner.slug) ?? winner.slug,
          target: winner,
          sources,
          reason: allAffine
            ? `${winner.type} (highest priority in affinity group)`
            : `${winner.type} (most mentions: ${winnerMentions()})`,
        });
      }

      // Print plans
      console.log(`Merge plans: ${plans.length}`);
      if (skipped.length > 0) {
        console.log(`Skipped: ${skipped.length} (no affinity or mixed types)\n`);
      }

      // Group by category for clearer output
      const byCategory = new Map<string, MergePlan[]>();
      for (const plan of plans) {
        const types = [plan.target.type, ...plan.sources.map(s => s.type)].sort().join(" ↔ ");
        const cat = byCategory.get(types) ?? [];
        cat.push(plan);
        byCategory.set(types, cat);
      }

      for (const [category, categoryPlans] of byCategory) {
        console.log(`\n  ${category} (${categoryPlans.length}):`);
        for (const plan of categoryPlans) {
          console.log(`    "${plan.title}" → keep ${plan.target.type}`);
          for (const src of plan.sources) {
            console.log(`      ← merge ${src.type} (${src.slug})`);
          }
        }
      }

      if (!opts.execute) {
        console.log("\n(DRY RUN — use --execute to merge)");
        db.close();
        return;
      }

      // Execute merges
      const { PageManager } = await import("../../core/page.js");
      const pages = new PageManager(db, config.vaultPath);

      let merged = 0, failed = 0;
      for (const plan of plans) {
        for (const src of plan.sources) {
          try {
            const result = await pages.merge(src.slug, plan.target.slug);
            if (result) {
              merged++;
              console.log(`  ✓ "${plan.title}": ${src.type} → ${plan.target.type}`);
            } else {
              failed++;
              console.error(`  ✗ Merge rejected: "${plan.title}" ${src.slug} → ${plan.target.slug}`);
            }
          } catch (err) {
            failed++;
            console.error(`  ✗ Merge error: "${plan.title}" ${src.slug}: ${err}`);
          }
        }
      }

      console.log(`\nDone: ${merged} merged, ${failed} failed.`);
      db.close();
    });

  // ─── clean-shells: remove empty shell entities ─────────────────
  program
    .command("clean-shells")
    .description("Remove entity/concept pages with 0 mentions, 0 links, and 0 aliases")
    .option("--dry-run", "Show what would be deleted (default)")
    .option("--execute", "Actually delete empty shells")
    .option("--type <type>", "Only clean a specific type (e.g. entity/person)")
    .option("--force", "Skip vault content check (delete even if vault has tags/body)")
    .action(async (opts) => {
      const config = loadConfig();
      const db = new CBrainDB(config.dbPath);
      const vaultPath = config.vaultPath;
      const { parseFrontmatter } = await import("../../utils/frontmatter.js");

      const shells = db.findEmptyShells();
      let filtered = opts.type ? shells.filter((s) => s.type === opts.type) : shells;

      if (filtered.length === 0) {
        console.log("No empty shell entities found.");
        db.close();
        return;
      }

      // Vault-aware guard: check vault file content before treating as shell
      const trueShells: typeof filtered = [];
      const syncGaps: typeof filtered = [];
      if (!opts.force) {
        for (const shell of filtered) {
          const absPath = resolve(vaultPath, shell.file_path);
          if (!existsSync(absPath)) { trueShells.push(shell); continue; }
          try {
            const { readFileSync } = await import("node:fs");
            const content = readFileSync(absPath, "utf-8");
            const { frontmatter, body } = parseFrontmatter(content);
            const hasTags = frontmatter.tags && Array.isArray(frontmatter.tags) && frontmatter.tags.length > 0;
            const hasBody = body.trim().length > 0 && !/^>\s*Auto-extracted from\s/.test(body.trim());
            if (hasTags || hasBody) {
              syncGaps.push(shell);
            } else {
              trueShells.push(shell);
            }
          } catch {
            trueShells.push(shell);
          }
        }

        if (syncGaps.length > 0) {
          console.log(`\n${syncGaps.length} entities have vault content (tags/body) but DB is empty — sync gap, not shell:`);
          for (const s of syncGaps.slice(0, 10)) {
            console.log(`    ${s.title} (${s.type}) → run 'cbrain sync --slug ${s.slug}' to fix`);
          }
          if (syncGaps.length > 10) console.log(`    ... and ${syncGaps.length - 10} more`);
          console.log();
        }

        filtered = trueShells;
      }

      if (filtered.length === 0) {
        console.log("No true empty shells remaining (all were sync gaps).");
        db.close();
        return;
      }

      // Group by type for summary
      const byType = new Map<string, number>();
      for (const s of filtered) {
        byType.set(s.type, (byType.get(s.type) ?? 0) + 1);
      }

      console.log(`\nTrue empty shell entities: ${filtered.length}\n`);
      for (const [type, count] of byType) {
        console.log(`  ${type}: ${count}`);
      }

      if (opts.dryRun || !opts.execute) {
        console.log("\n  Sample:");
        const sample = filtered.slice(0, 10);
        for (const s of sample) {
          console.log(`    ${s.title} (${s.type})`);
        }
        if (filtered.length > 10) console.log(`    ... and ${filtered.length - 10} more`);
        console.log("\n  (DRY RUN — use --execute to delete)");
        db.close();
        return;
      }

      let deleted = 0;
      let failed = 0;
      for (const shell of filtered) {
        try {
          // Delete vault file
          const absPath = resolve(vaultPath, shell.file_path);
          if (!absPath.startsWith(resolve(vaultPath))) {
            throw new Error(`Path traversal: ${shell.file_path}`);
          }
          if (existsSync(absPath)) unlinkSync(absPath);

          // Cascade delete from DB (chunks, links, tags, timeline, aliases)
          db.deletePageCascaded(shell.slug);
          deleted++;
        } catch (err) {
          failed++;
          console.error(`  ✗ Failed: ${shell.slug}: ${err}`);
        }
      }

      console.log(`\nDone: ${deleted} deleted, ${failed} failed.`);
      db.close();
    });

  // ─── clean-timeline: fix dirty timeline entries ────────────────
  program
    .command("clean-timeline")
    .description("Fix timeline entries with NULL, partial, or malformed dates; deduplicate")
    .option("--dry-run", "Show what would be fixed (default)")
    .option("--execute", "Actually fix timeline entries")
    .action(async (opts) => {
      const config = loadConfig();
      const db = new CBrainDB(config.dbPath);

      const all = db.getAllTimelineRaw();

      const toDelete = new Set<number>();
      const toNormalize = new Map<number, string>(); // id → new date
      let nullDates = 0;
      let unparseable = 0;
      let normalizedCount = 0;

      const isoDateRe = /^\d{4}-\d{2}-\d{2}$/;
      const yearOnlyRe = /^\d{4}$/;
      const monthOnlyRe = /^(\d{4})-(\d{2})$/;
      const chineseYearRe = /^(\d{4})年$/;
      const bceYearRe = /^公元前(\d+)/;

      for (const row of all) {
        if (row.event_date === null) {
          toDelete.add(row.id);
          nullDates++;
          continue;
        }

        // Already valid ISO date
        if (isoDateRe.test(row.event_date)) continue;

        // Year only → YYYY-01-01
        if (yearOnlyRe.test(row.event_date)) {
          toNormalize.set(row.id, `${row.event_date}-01-01`);
          normalizedCount++;
          continue;
        }

        // Month only → YYYY-MM-01
        const monthMatch = monthOnlyRe.exec(row.event_date);
        if (monthMatch) {
          toNormalize.set(row.id, `${row.event_date}-01`);
          normalizedCount++;
          continue;
        }

        // Chinese year → YYYY-01-01
        const cnMatch = chineseYearRe.exec(row.event_date);
        if (cnMatch) {
          toNormalize.set(row.id, `${cnMatch[1]}-01-01`);
          normalizedCount++;
          continue;
        }

        // BCE year → -YYYY-01-01 (zero-padded to 4 digits)
        const bceMatch = bceYearRe.exec(row.event_date);
        if (bceMatch) {
          const year = bceMatch[1].padStart(4, "0");
          toNormalize.set(row.id, `-${year}-01-01`);
          normalizedCount++;
          continue;
        }

        // Everything else: unparseable
        toDelete.add(row.id);
        unparseable++;
      }

      // Dedup: find duplicate (page_slug, event_date, summary) keeping min id
      const dupIds = db.getDuplicateTimelineIds();
      let dupCount = 0;
      for (const id of dupIds) {
        if (!toDelete.has(id)) {
          toDelete.add(id);
          dupCount++;
        }
      }

      console.log(`\nTimeline cleanup report:`);
      console.log(`  Total entries:    ${all.length}`);
      console.log(`  NULL dates:       ${nullDates}`);
      console.log(`  Unparseable:      ${unparseable}`);
      console.log(`  Normalizable:     ${normalizedCount}`);
      console.log(`  Duplicates:       ${dupCount}`);

      if (opts.dryRun || !opts.execute) {
        console.log("\n  (DRY RUN — use --execute to apply)");
        db.close();
        return;
      }

      // Apply deletes
      if (toDelete.size > 0) db.deleteTimelineByIds([...toDelete]);

      // Apply normalizations
      for (const [id, newDate] of toNormalize) {
        db.updateTimelineDate(id, newDate);
      }

      console.log(`\nDone: ${toDelete.size} deleted, ${normalizedCount} normalized.`);
      db.close();
    });

  // ─── dedup: entity deduplication via LLM ─────────────────────
  program
    .command("dedup")
    .description("Find and merge duplicate entities using LLM")
    .option("--type <type>", "Only scan a specific entity type (e.g. entity/company)")
    .option("--dry-run", "Show plan without executing merges")
    .option("--execute", "Actually merge duplicates (default is dry-run)")
    .option("--exclude <titles>", "Comma-separated target titles to skip")
    .action(async (opts) => {
      const config = loadConfig();
      const deps = createDeps(config);
      const db = deps.db;
      const llm = deps.llm;

      if (!llm) {
        console.error("Error: LLM not configured. Set ner.llm_api_key in cbrain.json.");
        db.close();
        return;
      }

      const dryRun = !opts.execute;

      // Phase 1: Collect entities by type
      const typeFilter = opts.type ?? undefined;
      const rows = db.getAllEntitiesInfo(typeFilter);

      const byType = new Map<string, Array<{ slug: string; title: string; mention_count: number }>>();
      for (const row of rows) {
        const group = byType.get(row.type) ?? [];
        group.push(row);
        byType.set(row.type, group);
      }

      console.log(`Scanning ${rows.length} entities across ${byType.size} types...`);

      // Phase 2: Find candidate pairs via substring overlap
      interface CandidatePair {
        a: { slug: string; title: string; mention_count: number };
        b: { slug: string; title: string; mention_count: number };
        overlap: string;
      }

      const candidates: CandidatePair[] = [];

      for (const [_type, entities] of byType) {
        // Skip types with too few entities
        if (entities.length < 2) continue;

        for (let i = 0; i < entities.length; i++) {
          for (let j = i + 1; j < entities.length; j++) {
            const a = entities[i];
            const b = entities[j];
            const normA = normalize(a.title);
            const normB = normalize(b.title);

            // Check substring containment (at least 2 chars shared, difference >= 2)
            if (normA.length > 1 && normB.length > 1) {
              if (normA.includes(normB) || normB.includes(normA)) {
                const minLen = Math.min(normA.length, normB.length);
                const maxLen = Math.max(normA.length, normB.length);
                if (maxLen - minLen >= 2) {
                  candidates.push({
                    a: { slug: a.slug, title: a.title, mention_count: a.mention_count },
                    b: { slug: b.slug, title: b.title, mention_count: b.mention_count },
                    overlap: normA.length < normB.length ? normA : normB,
                  });
                }
              }
            }

            // Also check shared core: at least 3 consecutive matching chars
            if (!candidates.some(c => (c.a.slug === a.slug && c.b.slug === b.slug) || (c.a.slug === b.slug && c.b.slug === a.slug))) {
              const shared = longestCommonSubstring(normA, normB);
              if (shared.length >= 3 && shared.length < normA.length && shared.length < normB.length) {
                candidates.push({
                  a: { slug: a.slug, title: a.title, mention_count: a.mention_count },
                  b: { slug: b.slug, title: b.title, mention_count: b.mention_count },
                  overlap: shared,
                });
              }
            }
          }
        }
      }

      if (candidates.length === 0) {
        console.log("No duplicate candidates found.");
        db.close();
        return;
      }

      console.log(`Found ${candidates.length} candidate pairs to evaluate.`);

      // Phase 3: LLM classification in batches
      const BATCH_SIZE = 30;
      const verdicts: Array<{
        a: CandidatePair["a"];
        b: CandidatePair["b"];
        verdict: string;
        reason: string;
      }> = [];

      for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
        const batch = candidates.slice(i, i + BATCH_SIZE);
        const pairLines = batch.map((p, idx) =>
          `${idx + 1}. "${p.a.title}" (mentions: ${p.a.mention_count}) vs "${p.b.title}" (mentions: ${p.b.mention_count})`
        ).join("\n");

        const prompt = `You are an entity deduplication assistant for a Chinese knowledge graph.
Given pairs of entity names that share overlapping characters, classify each pair:

- "same": Both names refer to the SAME real-world entity (abbreviation, full name vs short name, alias)
- "related": They are related but DIFFERENT entities (parent company vs subsidiary, brand vs product line)
- "different": Completely different entities that happen to share characters

Rules:
- 国控南通 = 国药控股南通 = 国药控股南通有限公司 → same (same company, abbreviation)
- 康缘 ≠ 江苏康缘药业 (if one is brand shorthand and the other is a specific subsidiary) → evaluate carefully
- 南京医药 ≠ 南京医药南通健桥有限公司 → related (parent vs subsidiary)
- When uncertain, classify as "different"

## Pairs
${pairLines}

## Output
Return JSON only, no markdown:
{"results": [{"index": 1, "verdict": "same|related|different", "reason": "brief explanation"}]}`;

        try {
          const raw = await llm.chat([
            { role: "system", content: "Return valid JSON only. No markdown wrapping." },
            { role: "user", content: prompt },
          ]);
          const cleaned = raw.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "");
          const parsed = JSON.parse(cleaned) as {
            results: Array<{ index: number; verdict: string; reason: string }>;
          };

          if (parsed.results && Array.isArray(parsed.results)) {
            for (const r of parsed.results) {
              const pair = batch[r.index - 1];
              if (pair && ["same", "related", "different"].includes(r.verdict)) {
                verdicts.push({ a: pair.a, b: pair.b, verdict: r.verdict, reason: r.reason });
              }
            }
          }
        } catch (err) {
          console.error(`  LLM batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${err}`);
        }
      }

      // Phase 4: Group "same" pairs into merge clusters
      const samePairs = verdicts.filter(v => v.verdict === "same");
      const relatedPairs = verdicts.filter(v => v.verdict === "related");
      const differentPairs = verdicts.filter(v => v.verdict === "different");

      // Build merge groups using union-find
      const slugToGroup = new Map<string, Set<string>>();
      for (const pair of samePairs) {
        const existingA = slugToGroup.get(pair.a.slug);
        const existingB = slugToGroup.get(pair.b.slug);

        if (existingA && existingB) {
          // Merge groups
          if (existingA !== existingB) {
            for (const s of existingB) {
              existingA.add(s);
              slugToGroup.set(s, existingA);
            }
          }
        } else if (existingA) {
          existingA.add(pair.b.slug);
          slugToGroup.set(pair.b.slug, existingA);
        } else if (existingB) {
          existingB.add(pair.a.slug);
          slugToGroup.set(pair.a.slug, existingB);
        } else {
          const group = new Set([pair.a.slug, pair.b.slug]);
          slugToGroup.set(pair.a.slug, group);
          slugToGroup.set(pair.b.slug, group);
        }
      }

      // Deduplicate groups
      const seenGroups = new Set<Set<string>>();
      const mergeGroups: Array<{ slugs: string[]; survivors: Array<{ slug: string; title: string; mention_count: number }> }> = [];

      for (const group of new Set(slugToGroup.values())) {
        if (seenGroups.has(group)) continue;
        seenGroups.add(group);

        const slugs = [...group];
        const survivors = slugs
          .map(slug => {
            const title = db.getPageTitle(slug) ?? slug.split("/").pop()!;
            const info = db.getPageTierAndMentions(slug);
            return { slug, title, mention_count: info?.mention_count ?? 0 };
          })
          .sort((a, b) => b.mention_count - a.mention_count);

        if (survivors.length >= 2) {
          mergeGroups.push({ slugs, survivors });
        }
      }

      // Report
      console.log(`\nResults: ${verdicts.length} pairs classified`);
      console.log(`  Same (merge candidates):    ${samePairs.length}`);
      console.log(`  Related (parent/subsidiary): ${relatedPairs.length}`);
      console.log(`  Different:                   ${differentPairs.length}`);
      console.log(`  Merge groups:                ${mergeGroups.length}`);

      if (relatedPairs.length > 0) {
        console.log("\nRelated (NOT merged — parent/subsidiary):");
        for (const p of relatedPairs.slice(0, 20)) {
          console.log(`  "${p.a.title}" ↔ "${p.b.title}" — ${p.reason}`);
        }
        if (relatedPairs.length > 20) console.log(`  ... and ${relatedPairs.length - 20} more`);
      }

      if (mergeGroups.length === 0) {
        console.log("\nNo merge groups found.");
        db.close();
        return;
      }

      // For each group, determine the target (highest mentions) and sources
      interface MergePlan {
        target: { slug: string; title: string; mention_count: number };
        sources: Array<{ slug: string; title: string; mention_count: number }>;
      }

      const plans: MergePlan[] = [];
      for (const group of mergeGroups) {
        const target = group.survivors[0]; // highest mentions
        const seen = new Set<string>();
        const sources = group.survivors.slice(1).filter(s => {
          if (seen.has(s.slug)) return false;
          seen.add(s.slug);
          return true;
        });
        plans.push({ target, sources });
      }

      // Apply exclusions
      const excludeTitles = new Set((opts.exclude ?? "").split(",").map((s: string) => s.trim()).filter(Boolean));
      if (excludeTitles.size > 0) {
        const before = plans.length;
        for (let i = plans.length - 1; i >= 0; i--) {
          if (excludeTitles.has(plans[i].target.title)) {
            console.log(`  Skipping excluded: "${plans[i].target.title}"`);
            plans.splice(i, 1);
          }
        }
        console.log(`  Excluded ${before - plans.length} groups.`);
      }

      console.log("\nMerge plan:");
      for (const plan of plans) {
        console.log(`  Target: "${plan.target.title}" (${plan.target.mention_count} mentions)`);
        for (const src of plan.sources) {
          console.log(`    ← merge "${src.title}" (${src.mention_count} mentions)`);
        }
      }

      if (dryRun) {
        console.log("\n(DRY RUN — use --execute to merge)");
        db.close();
        return;
      }

      // Phase 5: Execute merges
      const { PageManager } = await import("../../core/page.js");
      const pages = new PageManager(db, config.vaultPath);

      let merged = 0, failed = 0;
      for (const plan of plans) {
        for (const src of plan.sources) {
          try {
            const result = await pages.merge(src.slug, plan.target.slug);
            if (result) {
              merged++;
              console.log(`  ✓ Merged "${src.title}" → "${plan.target.title}"`);
            } else {
              failed++;
              console.error(`  ✗ Merge failed: "${src.title}" → "${plan.target.title}"`);
            }
          } catch (err) {
            failed++;
            console.error(`  ✗ Merge error: "${src.title}" → "${plan.target.title}": ${err}`);
          }
        }
      }

      console.log(`\nDone: ${merged} merged, ${failed} failed.`);
      db.close();
    });

  // ─── batch-delete: delete entities by slug list ────────────────
  program
    .command("batch-delete")
    .description("Delete entities from a file of slugs (one per line)")
    .argument("<file>", "File with one slug per line")
    .option("--dry-run", "Show what would be deleted (default)")
    .option("--execute", "Actually delete")
    .action(async (file: string, opts) => {
      const config = loadConfig();
      const db = new CBrainDB(config.dbPath);
      const vaultPath = config.vaultPath;
      const { readFileSync } = await import("node:fs");

      const slugs = readFileSync(file, "utf-8")
        .split("\n")
        .map((l: string) => l.trim())
        .filter((l: string) => l && !l.startsWith("#"));

      if (slugs.length === 0) {
        console.log("No slugs in file.");
        db.close();
        return;
      }

      console.log(`\nSlugs to delete: ${slugs.length}\n`);

      if (opts.dryRun || !opts.execute) {
        for (const slug of slugs) {
          const page = db.getPage(slug);
          if (page) {
            console.log(`  ${page.title} (${page.type}) → ${page.file_path}`);
          } else {
            console.log(`  ${slug} — NOT FOUND in DB`);
          }
        }
        console.log("\n  (DRY RUN — use --execute to delete)");
        db.close();
        return;
      }

      let deleted = 0;
      let notFound = 0;
      for (const slug of slugs) {
        const page = db.getPage(slug);
        if (!page) { notFound++; continue; }
        try {
          const absPath = resolve(vaultPath, page.file_path);
          if (absPath.startsWith(resolve(vaultPath)) && existsSync(absPath)) {
            unlinkSync(absPath);
          }
          db.deletePageCascaded(slug);
          deleted++;
        } catch (err) {
          console.error(`  ✗ Failed: ${slug}: ${err}`);
        }
      }

      console.log(`\nDone: ${deleted} deleted, ${notFound} not found.`);
      db.close();
    });

  // ─── migrate-runtime: move vault/outputs to profileDir/runtime ─
  program
    .command("migrate-runtime")
    .description("Migrate vault/outputs to runtime directory (uses resolveRuntimePath)")
    .option("--dry-run", "Show migration plan without moving files (default)")
    .option("--execute", "Actually move files")
    .action((opts) => {
      const config = loadConfig();
      const { cpSync, rmSync, existsSync: exists, readdirSync, statSync, mkdirSync } = require("node:fs");
      const { join: pathJoin } = require("node:path");

      const sourceDir = pathJoin(config.vaultPath, "outputs");
      const targetDir = resolveRuntimePath(config);

      if (!exists(sourceDir)) {
        console.log("  vault/outputs 不存在，无需迁移。");
        return;
      }

      const countFiles = (dir: string): number => {
        let count = 0;
        try {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) count += countFiles(pathJoin(dir, entry.name));
            else count++;
          }
        } catch { /* empty */ }
        return count;
      };

      const sourceSize = ((): number => {
        let total = 0;
        try {
          const walk = (dir: string) => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
              if (entry.isDirectory()) walk(pathJoin(dir, entry.name));
              else total += statSync(pathJoin(dir, entry.name)).size;
            }
          };
          walk(sourceDir);
        } catch { /* empty */ }
        return total;
      })();

      const fileCount = countFiles(sourceDir);

      console.log(`\n  Runtime 迁移计划:\n`);
      console.log(`  源目录:   ${sourceDir}`);
      console.log(`  目标目录: ${targetDir}`);
      console.log(`  文件数:   ${fileCount}`);
      console.log(`  总大小:   ${(sourceSize / 1024 / 1024).toFixed(1)}MB`);

      const targetFiles = exists(targetDir) ? countFiles(targetDir) : 0;
      if (targetFiles > 0) {
        console.log(`\n  ⚠  目标目录已有 ${targetFiles} 个文件。`);
        console.log(`  建议在迁移前停止运行中的服务（server/dream），以避免并发写入问题。`);
      }

      // Legacy data merges into a timestamped subdirectory — never replaces the authoritative runtime
      const legacyStamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
      const legacyDir = pathJoin(targetDir, `legacy-outputs-${legacyStamp}`);

      if (targetFiles > 0) {
        if (opts.execute) {
          console.log(`  Legacy 数据将迁移到 ${legacyDir}（不覆盖当前 runtime 文件）`);
        } else {
          console.log(`  Legacy 数据将迁移到 ${legacyDir}（不覆盖当前 runtime 文件）`);
        }
      }

      if (!opts.execute) {
        console.log(`\n  (DRY RUN — 使用 --execute 执行迁移)`);
        return;
      }

      if (targetFiles > 0) {
        try {
          mkdirSync(legacyDir, { recursive: true });
          // Copy legacy source contents into the legacy subdirectory
          const entries = readdirSync(sourceDir, { withFileTypes: true });
          for (const entry of entries) {
            const src = pathJoin(sourceDir, entry.name);
            const dest = pathJoin(legacyDir, entry.name);
            cpSync(src, dest, { recursive: true });
          }
        } catch (err) {
          console.error(`\n  ✗ 复制 legacy 数据失败: ${err instanceof Error ? err.message : err}`);
          process.exit(1);
        }
      } else {
        // Target is empty — copy directly into runtime root
        try {
          mkdirSync(targetDir, { recursive: true });
          cpSync(sourceDir, targetDir, { recursive: true });
        } catch (err) {
          console.error(`\n  ✗ 复制失败: ${err instanceof Error ? err.message : err}`);
          console.error(`  目标目录可能不完整，请手动检查: ${targetDir}`);
          process.exit(1);
        }
      }

      rmSync(sourceDir, { recursive: true });
      const destination = targetFiles > 0 ? legacyDir : targetDir;
      console.log(`\n  ✓ 已迁移到 ${destination}（源目录已删除）`);
    });

  program
    .command("wakeup-diff")
    .description("Generate wake-up diff: cognitive changes since last snapshot")
    .action(async () => {
      const config = loadConfig();
      const deps = createDeps(config);
      const outputsDir = resolveRuntimePath(config);
      const { WakeupDiff } = await import("../../core/wakeup.js");
      const diff = new WakeupDiff(deps.db, outputsDir);
      const result = await diff.run();

      if (result.baselineCreated) {
        console.log(`📊 Wake-up Diff — ${result.date}`);
        console.log(`  Baseline established: ${result.stats.totalPages} pages`);
      } else {
        const totalChanges = result.changes.contentUpdated.length + result.changes.tierChanged.length +
          result.changes.linkCountChanged.length + result.changes.confidenceDecayed.length + result.changes.removed.length;
        console.log(`📊 Wake-up Diff — ${result.date}`);
        console.log(`  Changes: ${totalChanges} items`);
        console.log(`  New: ${result.newItems.length} items`);
        if (result.reportPath) console.log(`  Report: ${result.reportPath}`);
      }
      deps.db.close();
      process.exit(0);
    });
}

// ─── Dedup helpers ──────────────────────────────────────────────

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s\-_.]+/g, "")
    .replace(/[（(].+?[）)]/g, "")
    .replace(/有限公司$/g, "")
    .replace(/股份有限公司$/g, "")
    .replace(/集团$/g, "")
    .replace(/公司$/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .trim();
}

function longestCommonSubstring(a: string, b: string): string {
  if (a.length === 0 || b.length === 0) return "";
  let longest = "";
  const matrix: number[][] = Array.from({ length: a.length }, () => Array(b.length).fill(0));

  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      if (a[i] === b[j]) {
        matrix[i][j] = (i > 0 && j > 0 ? matrix[i - 1][j - 1] : 0) + 1;
        if (matrix[i][j] > longest.length) {
          longest = a.substring(i - matrix[i][j] + 1, i + 1);
        }
      }
    }
  }

  return longest;
}

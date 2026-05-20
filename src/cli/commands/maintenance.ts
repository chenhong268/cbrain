import type { Command } from "commander";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { CBrainDB } from "../../storage/sqlite.js";
import { LanceDBManager } from "../../storage/lancedb.js";
import { ZhipuEmbeddingProvider } from "../../embedding/zhipu.js";
import { ZhipuLLMProvider } from "../../llm/zhipu.js";
import { DeepSeekLLMProvider } from "../../llm/deepseek.js";
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
      const enrich = new EnrichManager(db, undefined, llm, config.vaultPath);
      const result = opts.slug ? [enrich.enrichEntity(opts.slug)] : enrich.enrichAll();
      console.log(JSON.stringify(result, null, 2));
      db.close();
    });

  program
    .command("health")
    .description("Run 10-dimension health check and write report")
    .option("--full", "Print full Markdown report to stdout")
    .option("--json", "Output detail JSON to stdout")
    .option("--dimension <name>", "Only check specified dimension")
    .action(async (opts) => {
      const config = loadConfig();
      const db = new CBrainDB(config.dbPath);
      const outputsDir = join(config.vaultPath, "outputs");
      const { HealthChecker } = await import("../../core/health.js");
      const { Logger } = await import("../../core/logger.js");
      const logger = new Logger(outputsDir);
      const checker = new HealthChecker(db, outputsDir, logger);
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
    .description("Health check: DB, vault, embedding")
    .action(async () => {
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
            const llm = new ZhipuLLMProvider(nerApiKey, config.ner?.llm_base_url, config.ner?.llm_model);
            console.log(`  NER:     ${config.ner?.llm_model ?? "glm-4-flash"} ✓`);
          } catch (e) { console.error(`  NER:     FAIL — ${(e as Error).message}`); ok = false; }
        } else { console.log(`  NER:     disabled (no API key)`); }
      } else { console.log(`  NER:     disabled`); }
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
      const outputsDir = join(config.vaultPath, "outputs");
      const logger = new Logger(outputsDir);
      const pages = new PageManager(deps.db, config.vaultPath, logger);
      const nerEngine = deps.llm ? new NerEngine(deps.llm) : undefined;
      const syncMgr = new SyncManager(deps.db, deps.embedding, deps.lance, { nerEngine, pages, logger });
      const enrichMgr = new EnrichManager(deps.db, undefined, deps.llm, config.vaultPath);
      const insightMgr = new InsightManager(deps.db, deps.embedding, deps.lance);
      const health = new HealthChecker(deps.db, outputsDir, logger);
      const report = await runDream(config.vaultPath, deps.db, syncMgr, enrichMgr, health, outputsDir, logger, insightMgr, config.dbPath);
      const icon = report.locked ? "🌙" : "⚠️";
      console.log(`${icon} Dream — ${report.timestamp.slice(0, 10)}`);
      if (report.stages.backup.path) console.log(`  Backup:  ${report.stages.backup.size_mb}MB`);
      console.log(`  Sync:    ${report.stages.sync.synced} 更新, ${report.stages.sync.skipped} 跳过`);
      console.log(`  Enrich:  ${report.stages.enrich.total} 实体, ${report.stages.enrich.upgraded} 升级`);
      console.log(`  Cleanup: ${report.stages.cleanup.orphans} 孤立, ${report.stages.cleanup.staleStubs} 过期 stub`);
      console.log(`  Health:  ${report.stages.health.overallStatus}`);
      console.log(`  Insight: ${report.stages.insight_archive.archived} 条过期归档`);
      console.log(`  ⏱ ${(report.duration_ms / 1000).toFixed(1)}s`);
      if (!report.locked) console.log(`  ⚠️ 上次 dream 仍在执行中，本次跳过`);
      deps.db.close();
      process.exit(report.locked ? 0 : 1);
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
      const outputsDir = join(config.vaultPath, "outputs");
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
      const insightMgr = new InsightManager(deps.db, deps.embedding, deps.lance);
      const mgr = new ReflectManager(deps.db, pages, reflectLlm, reflectPipeline, deps.embedding, insightMgr);
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
      const outputsDir = join(config.vaultPath, "outputs");
      const logger = new Logger(outputsDir);
      const pages = new PageManager(deps.db, config.vaultPath, logger);

      const reflectLlm = config.reflect?.llm_api_key
        ? new DeepSeekLLMProvider(config.reflect.llm_api_key, config.reflect.llm_base_url, config.reflect.llm_model)
        : deps.llm;

      const { ContentPipeline } = await import("../../core/pipeline.js");
      const reflectPipeline = new ContentPipeline(deps.db, deps.embedding, deps.lance);
      const insightMgr = new InsightManager(deps.db, deps.embedding, deps.lance);
      const mgr = new ReflectManager(deps.db, pages, reflectLlm, reflectPipeline, deps.embedding, insightMgr);
      console.log("🔍 Running discovery...");
      const report = await mgr.runDiscovery();

      const typeParts = Object.entries(report.byType).map(([k, v]) => `${k}: ${v}`).join(", ");
      const actionParts = Object.entries(report.byActionable).map(([k, v]) => `${k}: ${v}`).join(", ");

      console.log(`  发现总数: ${report.total}`);
      console.log(`  类型分布: ${typeParts}`);
      console.log(`  重要程度: ${actionParts}`);
      console.log(`  可自动应用: ${report.autoApplicable}`);

      deps.db.close();
      process.exit(0);
    });

  program
    .command("index")
    .description("Generate Obsidian index files")
    .action(() => {
      const config = loadConfig();
      const db = new CBrainDB(config.dbPath);
      const outputsDir = join(config.vaultPath, "outputs");
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
      const outputsDir = join(config.vaultPath, "outputs");
      const logger = new Logger(outputsDir);
      const pages = new PageManager(deps.db, config.vaultPath, logger);
      const { ReflectManager } = await import("../../core/reflect.js");
      const mgr = new ReflectManager(deps.db, pages, undefined, undefined, deps.embedding);
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
        const pagesList = new PM(deps.db, config.vaultPath, new L(join(config.vaultPath, "outputs")));
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
      const outputsDir = join(config.vaultPath, "outputs");
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
        }
        deps.db.close();
        return;
      }

      if (opts.reportsTo) {
        const { setHierarchy } = await import("../../core/hierarchy.js");
        setHierarchy(slug, opts.reportsTo, { pages, graph });
        const manager = pages.getBySlug(opts.reportsTo);
        console.log(`  ✓ ${slug} 的直线领导设为 ${manager?.title ?? opts.reportsTo}`);
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
}

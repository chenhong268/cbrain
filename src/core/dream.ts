import { existsSync, mkdirSync, unlinkSync, readdirSync } from "node:fs";
import { appendFile, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CBrainDB } from "../storage/sqlite.js";
import type { SyncManager } from "./sync.js";
import type { EnrichManager } from "./enrich.js";
import type { HealthChecker } from "./health.js";
import type { Logger } from "./logger.js";
import type { InsightManager } from "./insight.js";
import { LearnManager } from "./learn.js";
import { IndexGenerator } from "./indexes.js";
import type { LLMProvider } from "../llm/provider.js";
import type { EmbeddingProvider } from "../embedding/provider.js";
import type { LanceDBManager } from "../storage/lancedb.js";
import { SealManager } from "./seal.js";

export interface DreamReport {
  timestamp: string;
  brief: string;
  stages: {
    backup: { path: string | null; size_mb: string };
    sync: { synced: number; skipped: number; errors: number };
    enrich: { total: number; upgraded: number };
    learn: { updated: number; topActive: string[] };
    seal: { sealed: number; skipped: number; errors: number };
    cleanup: { orphans: number; staleStubs: number };
    health: { overallStatus: string; dimensions: number; issues: number };
    insight_archive: { archived: number };
    indexes: { files: number };
  };
  duration_ms: number;
  locked: boolean;
}

const LOCK_KEY = "dream.lock";
const LOCK_TTL_MS = 30 * 60 * 1000; // 30 min — if dream crashes, lock auto-expires
const MAX_BACKUPS = 7;
const execFileAsync = promisify(execFile);

function acquireLock(db: CBrainDB): boolean {
  const lockValue = db.getConfig(LOCK_KEY);

  if (lockValue) {
    const lockedAt = parseInt(lockValue, 10);
    if (Date.now() - lockedAt < LOCK_TTL_MS) return false;
  }

  db.setConfig(LOCK_KEY, String(Date.now()));
  return true;
}

function releaseLock(db: CBrainDB): void {
  db.deleteConfig(LOCK_KEY);
}

export async function runDream(
  vaultPath: string,
  db: CBrainDB,
  syncMgr: SyncManager,
  enrichMgr: EnrichManager,
  healthChecker: HealthChecker,
  outputsDir: string,
  logger: Logger,
  insightMgr?: InsightManager,
  dbPath?: string,
  sealDeps?: { llm: LLMProvider; embedding: EmbeddingProvider; lance: LanceDBManager },
): Promise<DreamReport> {
  if (!acquireLock(db)) {
    logger.warn("dream", "上次 dream 仍在执行中（或锁未释放），跳过");
    return {
      timestamp: new Date().toISOString(),
      stages: {
        backup: { path: null, size_mb: "0" },
        sync: { synced: 0, skipped: 0, errors: 0 },
        enrich: { total: 0, upgraded: 0 },
        learn: { updated: 0, topActive: [] },
        seal: { sealed: 0, skipped: 0, errors: 0 },
        cleanup: { orphans: 0, staleStubs: 0 },
        health: { overallStatus: "skipped", dimensions: 0, issues: 0 },
        insight_archive: { archived: 0 },
        indexes: { files: 0 },
      },
      duration_ms: 0,
      locked: true,
      brief: "上次 dream 尚未完成（30 分钟锁未释放），已跳过。如需强制执行，请先 dream_reset。",
    };
  }

  const started = Date.now();
  logger.info("dream", "夜间维护开始");

  // Stage 0: Pre-backup
  logger.info("dream", "Stage 0/6: backup");
  let backupPath: string | null = null;
  let backupSize = "0";
  try {
    const backupDir = join(outputsDir, "backups");
    if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    backupPath = join(backupDir, `auto-${ts}.zip`);
    const resolvedDbPath = dbPath ?? join(vaultPath, "..", "brain.sqlite");
    const dbDir = join(resolvedDbPath, "..");
    const lancePath = join(dbDir, "lancedb");
    const zipArgs = ["-rq", backupPath, basename(resolvedDbPath)];
    if (existsSync(lancePath)) zipArgs.push("lancedb/.");
    await execFileAsync("zip", zipArgs, { cwd: dbDir, encoding: "utf-8" });
    const info = await stat(backupPath);
    backupSize = (info.size / 1024 / 1024).toFixed(1);
    logger.info("dream", `备份完成：${backupPath} (${backupSize}MB)`);

    // Keep last 7 backups
    const backups = readdirSync(backupDir).filter(f => f.startsWith("auto-") && f.endsWith(".zip")).sort();
    while (backups.length > MAX_BACKUPS) {
      unlinkSync(join(backupDir, backups.shift()!));
    }
  } catch (e) {
    logger.warn("dream", `备份失败，继续执行：${(e as Error).message}`);
  }

  // Stage 1: Sync
  logger.info("dream", "Stage 1/5: sync");
  const syncReport = await syncMgr.syncAll(vaultPath);

  // Stage 2: Enrich
  logger.info("dream", "Stage 2/7: enrich");
  const enrichResults = enrichMgr.enrichAll();
  const upgraded = enrichResults.filter((r) => r.upgraded).length;

  // Stage 2.5: Learn
  logger.info("dream", "Stage 3/7: learn");
  let learnReport = { updated: 0, topActive: [] as string[] };
  try {
    const learnMgr = new LearnManager(db);
    learnReport = learnMgr.recomputeAll();
    if (learnReport.updated > 0) logger.info("dream", `学习更新 ${learnReport.updated} 个实体权重，活跃: ${learnReport.topActive.join(", ")}`);
  } catch (e) {
    logger.warn("dream", `学习计算失败: ${(e as Error).message}`);
  }

  // Stage 3.5: Seal
  logger.info("dream", "Stage 3.5/8: seal");
  let sealReport = { sealed: 0, skipped: 0, errors: 0 };
  if (sealDeps) {
    try {
      const sealMgr = new SealManager(db, sealDeps.llm, sealDeps.embedding, sealDeps.lance, logger);
      sealReport = await sealMgr.sealAll();
      if (sealReport.sealed > 0) logger.info("dream", `Seal 完成: ${sealReport.sealed} 页压缩`);
    } catch (e) {
      logger.warn("dream", `Seal 失败: ${(e as Error).message}`);
    }
  }

  // Stage 4-6: Cleanup + Health + Insight archive (independent, run in parallel)
  logger.info("dream", "Stage 4-6/7: cleanup + health + insight archive (parallel)");
  const [orphans, staleStubs, healthReport, archived] = await Promise.all([
    syncMgr.removeOrphans(vaultPath).catch(e => { logger.warn("dream", `Cleanup orphans 失败: ${(e as Error).message}`); return []; }),
    syncMgr.cleanStaleStubs(vaultPath).catch(e => { logger.warn("dream", `Cleanup stale stubs 失败: ${(e as Error).message}`); return []; }),
    healthChecker.checkAll(),
    (async () => {
      if (!insightMgr) return 0;
      try {
        const n = insightMgr.archiveExpired();
        if (n > 0) logger.info("dream", `归档 ${n} 条过期 insight`);
        return n;
      } catch (e) { logger.warn("dream", `Insight 归档失败: ${(e as Error).message}`); return 0; }
    })(),
    (async () => {
      try {
        const removed = db.cleanMentionSnapshots(30);
        if (removed > 0) logger.info("dream", `清理 ${removed} 条过期 mention snapshots`);
      } catch (e) { logger.warn("dream", `Snapshot 清理失败: ${(e as Error).message}`); }
    })(),
  ]);

  // Stage 7: Index generation
  logger.info("dream", "Stage 7/7: indexes");
  let indexFiles = 0;
  try {
    const generator = new IndexGenerator(db, outputsDir);
    const generated = generator.generateAll();
    indexFiles = generated.length;
    if (indexFiles > 0) logger.info("dream", `生成 ${indexFiles} 个索引文件`);
  } catch (e) {
    logger.warn("dream", `索引生成失败: ${(e as Error).message}`);
  }

  // Report
  logger.info("dream", "building report");
  const report: DreamReport = {
    timestamp: new Date().toISOString(),
    stages: {
      backup: { path: backupPath, size_mb: backupSize },
      sync: { synced: syncReport.synced, skipped: syncReport.skipped, errors: syncReport.errors },
      enrich: { total: enrichResults.length, upgraded },
      learn: learnReport,
      seal: sealReport,
      cleanup: { orphans: orphans.length, staleStubs: staleStubs.length },
      health: {
        overallStatus: healthReport.overallStatus,
        dimensions: healthReport.dimensions.length,
        issues: healthReport.dimensions.reduce((s, d) => s + d.issues.length, 0),
      },
      insight_archive: { archived },
      indexes: { files: indexFiles },
    },
    duration_ms: Date.now() - started,
    locked: false,
    brief: "",
  };
  report.brief = buildBrief(report, db);

  // Write report
  const dreamDir = join(outputsDir, "dream");
  if (!existsSync(dreamDir)) mkdirSync(dreamDir, { recursive: true });
  const dateStr = new Date().toISOString().slice(0, 10);
  const reportPath = join(dreamDir, `dream-${dateStr}.md`);
  const lines = [
    `# Dream Report — ${dateStr}`,
    ``,
    `| Stage | Result |`,
    `|-------|--------|`,
    `| Sync | ${report.stages.sync.synced} 更新, ${report.stages.sync.skipped} 跳过, ${report.stages.sync.errors} 错误 |`,
    `| Enrich | ${report.stages.enrich.total} 实体, ${report.stages.enrich.upgraded} 升级 |`,
    `| Learn | ${report.stages.learn.updated} 实体权重更新, 活跃: ${report.stages.learn.topActive.slice(0, 3).join(", ")} |`,
    `| Seal | ${report.stages.seal.sealed} 页压缩, ${report.stages.seal.skipped} 跳过 |`,
    `| Cleanup | ${report.stages.cleanup.orphans} 孤立, ${report.stages.cleanup.staleStubs} 过期 stub |`,
    `| Health | ${report.stages.health.overallStatus} (${report.stages.health.dimensions} 维度, ${report.stages.health.issues} 问题) |`,
    `| Insight Archive | ${report.stages.insight_archive.archived} 条过期归档 |`,
    `| Indexes | ${report.stages.indexes.files} 个索引更新 |`,
    ``,
    `⏱ ${(report.duration_ms / 1000).toFixed(1)}s`,
  ];
  try {
    await appendFile(reportPath, lines.join("\n") + "\n", "utf-8");
  } catch (e) {
    logger.warn("dream", "报告文件写入失败", { path: reportPath, error: String(e) });
  }
  logger.info("dream", `报告 → ${reportPath}`);

  releaseLock(db);
  logger.info("dream", `夜间维护完成 (${(report.duration_ms / 1000).toFixed(1)}s)`);
  return report;
}

function buildBrief(report: DreamReport, db: CBrainDB): string {
  const date = report.timestamp.slice(0, 10);
  const lines = [`CBrain 日报 ${date}`, ""];

  const fresh = db.countNewPagesSince(24);
  if (fresh.entities > 0 || fresh.concepts > 0) {
    const parts: string[] = [];
    if (fresh.entities > 0) parts.push(`${fresh.entities} 个实体`);
    if (fresh.concepts > 0) parts.push(`${fresh.concepts} 个概念`);
    lines.push(`新增 ${parts.join("，")}`);
  }

  const top5 = db.getTopMentionedEntities(5);
  if (top5.length > 0) {
    lines.push(`本周活跃: ${top5.map(e => `${e.title}(${e.mention_count})`).join(", ")}`);
  }

  if (report.stages.sync.synced > 0) {
    lines.push(`${report.stages.sync.synced} 个页面更新`);
  }
  if (report.stages.enrich.upgraded > 0) {
    lines.push(`${report.stages.enrich.upgraded} 个实体升级`);
  }
  if (report.stages.learn.updated > 0) {
    lines.push(`学习: ${report.stages.learn.updated} 个权重更新，最活跃: ${report.stages.learn.topActive.slice(0, 3).join(", ")}`);
  }
  if (report.stages.seal.sealed > 0) {
    lines.push(`Seal: ${report.stages.seal.sealed} 页摘要压缩`);
  }
  if (report.stages.insight_archive.archived > 0) {
    lines.push(`${report.stages.insight_archive.archived} 条洞察归档`);
  }
  if (report.stages.indexes.files > 0) {
    lines.push(`${report.stages.indexes.files} 个索引更新`);
  }

  const icon = report.stages.health.overallStatus === "pass" ? "✅" : "⚠️";
  lines.push(`健康: ${icon} ${report.stages.health.issues} 个问题`);

  lines.push("", `⏱ ${(report.duration_ms / 1000).toFixed(1)}s`);
  return lines.join("\n");
}

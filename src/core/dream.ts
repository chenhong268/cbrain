import { existsSync, mkdirSync, appendFileSync, unlinkSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { CBrainDB } from "../storage/sqlite.js";
import type { SyncManager } from "./sync.js";
import type { EnrichManager } from "./enrich.js";
import type { HealthChecker } from "./health.js";
import type { Logger } from "./logger.js";
import type { InsightManager } from "./insight.js";

export interface DreamReport {
  timestamp: string;
  brief: string;
  stages: {
    backup: { path: string | null; size_mb: string };
    sync: { synced: number; skipped: number; errors: number };
    enrich: { total: number; upgraded: number };
    cleanup: { orphans: number; staleStubs: number };
    health: { overallStatus: string; dimensions: number; issues: number };
    insight_archive: { archived: number };
  };
  duration_ms: number;
  locked: boolean;
}

const LOCK_KEY = "dream.lock";
const LOCK_TTL_MS = 30 * 60 * 1000; // 30 min — if dream crashes, lock auto-expires
const MAX_BACKUPS = 7;

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
  insightMgr?: InsightManager
): Promise<DreamReport> {
  if (!acquireLock(db)) {
    logger.warn("dream", "上次 dream 仍在执行中（或锁未释放），跳过");
    return {
      timestamp: new Date().toISOString(),
      stages: {
        backup: { path: null, size_mb: "0" },
        sync: { synced: 0, skipped: 0, errors: 0 },
        enrich: { total: 0, upgraded: 0 },
        cleanup: { orphans: 0, staleStubs: 0 },
        health: { overallStatus: "skipped", dimensions: 0, issues: 0 },
        insight_archive: { archived: 0 },
      },
      duration_ms: 0,
      locked: false,
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
    const dbPath = (db as any).filename ?? join(vaultPath, "..", "brain.sqlite");
    const dbDir = join(vaultPath, "..");
    const lancePath = join(dbDir, "lancedb");
    const zipArgs = ["-rq", backupPath, basename(dbPath), "vault/."];
    if (existsSync(lancePath)) zipArgs.push("lancedb/.");
    execFileSync("zip", zipArgs, { cwd: dbDir, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    const { statSync } = await import("node:fs");
    backupSize = (statSync(backupPath).size / 1024 / 1024).toFixed(1);
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
  logger.info("dream", "Stage 2/5: enrich");
  const enrichResults = enrichMgr.enrichAll();
  const upgraded = enrichResults.filter((r) => r.upgraded).length;

  // Stage 3: Cleanup (orphans + stale stubs)
  logger.info("dream", "Stage 3/5: cleanup");
  const orphans = await syncMgr.removeOrphans(vaultPath);
  const staleStubs = await syncMgr.cleanStaleStubs(vaultPath);

  // Stage 4: Health
  logger.info("dream", "Stage 4/5: health");
  const healthReport = await healthChecker.checkAll();

  // Stage 5: Insight expiry
  logger.info("dream", "Stage 5/5: insight archive");
  let archived = 0;
  if (insightMgr) {
    try {
      archived = insightMgr.archiveExpired();
      if (archived > 0) logger.info("dream", `归档 ${archived} 条过期 insight`);
    } catch (e) {
      logger.warn("dream", `Insight 归档失败: ${(e as Error).message}`);
    }
  }

  // Report
  logger.info("dream", "building report");
  const report: DreamReport = {
    timestamp: new Date().toISOString(),
    stages: {
      backup: { path: backupPath, size_mb: backupSize },
      sync: { synced: syncReport.synced, skipped: syncReport.skipped, errors: syncReport.errors },
      enrich: { total: enrichResults.length, upgraded },
      cleanup: { orphans: orphans.length, staleStubs: staleStubs.length },
      health: {
        overallStatus: healthReport.overallStatus,
        dimensions: healthReport.dimensions.length,
        issues: healthReport.dimensions.reduce((s, d) => s + d.issues.length, 0),
      },
      insight_archive: { archived },
    },
    duration_ms: Date.now() - started,
    locked: true,
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
    `| Cleanup | ${report.stages.cleanup.orphans} 孤立, ${report.stages.cleanup.staleStubs} 过期 stub |`,
    `| Health | ${report.stages.health.overallStatus} (${report.stages.health.dimensions} 维度, ${report.stages.health.issues} 问题) |`,
    `| Insight Archive | ${report.stages.insight_archive.archived} 条过期归档 |`,
    ``,
    `⏱ ${(report.duration_ms / 1000).toFixed(1)}s`,
  ];
  try {
    appendFileSync(reportPath, lines.join("\n") + "\n", "utf-8");
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
  if (report.stages.insight_archive.archived > 0) {
    lines.push(`${report.stages.insight_archive.archived} 条洞察归档`);
  }

  const icon = report.stages.health.overallStatus === "pass" ? "✅" : "⚠️";
  lines.push(`健康: ${icon} ${report.stages.health.issues} 个问题`);

  lines.push("", `⏱ ${(report.duration_ms / 1000).toFixed(1)}s`);
  return lines.join("\n");
}

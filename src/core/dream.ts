import { existsSync, mkdirSync, appendFileSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { CBrainDB } from "../storage/sqlite.js";
import type { SyncManager } from "./sync.js";
import type { EnrichManager } from "./enrich.js";
import type { HealthChecker } from "./health.js";
import type { Logger } from "./logger.js";

export interface DreamReport {
  timestamp: string;
  stages: {
    backup: { path: string | null; size_mb: string };
    sync: { synced: number; skipped: number; errors: number };
    enrich: { total: number; upgraded: number };
    cleanup: { orphans: number; staleStubs: number };
    health: { overallStatus: string; dimensions: number; issues: number };
  };
  duration_ms: number;
  locked: boolean;
}

const LOCK_KEY = "dream.lock";
const LOCK_TTL_MS = 30 * 60 * 1000; // 30 min — if dream crashes, lock auto-expires

function acquireLock(db: CBrainDB): boolean {
  const row = db
    .prepare("SELECT value FROM config WHERE key = ?")
    .get(LOCK_KEY) as { value: string } | undefined;

  if (row) {
    const lockedAt = parseInt(row.value, 10);
    if (Date.now() - lockedAt < LOCK_TTL_MS) return false;
  }

  db.prepare(
    "INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)"
  ).run(LOCK_KEY, String(Date.now()));
  return true;
}

function releaseLock(db: CBrainDB): void {
  db.prepare("DELETE FROM config WHERE key = ?").run(LOCK_KEY);
}

export async function runDream(
  vaultPath: string,
  db: CBrainDB,
  syncMgr: SyncManager,
  enrichMgr: EnrichManager,
  healthChecker: HealthChecker,
  outputsDir: string,
  logger: Logger
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
      },
      duration_ms: 0,
      locked: false,
    };
  }

  const started = Date.now();
  logger.info("dream", "夜间维护开始");

  // Stage 0: Pre-backup
  logger.info("dream", "Stage 0/5: backup");
  let backupPath: string | null = null;
  let backupSize = "0";
  try {
    const backupDir = join(outputsDir, "backups");
    if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    backupPath = join(backupDir, `auto-${ts}.zip`);
    const dbPath = (db as any).filename ?? join(vaultPath, "..", "brain.sqlite");
    const lancePath = join(vaultPath, "..", "lancedb");
    execSync(`cd "${join(vaultPath, "..")}" && zip -rq "${backupPath}" brain.sqlite vault/. ${existsSync(lancePath) ? "lancedb/." : ""}`, { encoding: "utf-8" });
    const { statSync } = await import("node:fs");
    backupSize = (statSync(backupPath).size / 1024 / 1024).toFixed(1);
    logger.info("dream", `备份完成：${backupPath} (${backupSize}MB)`);

    // Keep last 7 backups
    const backups = readdirSync(backupDir).filter(f => f.startsWith("auto-") && f.endsWith(".zip")).sort();
    while (backups.length > 7) {
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

  // Stage 5: Report
  logger.info("dream", "Stage 5/5: report");
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
    },
    duration_ms: Date.now() - started,
    locked: true,
  };

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
    ``,
    `⏱ ${(report.duration_ms / 1000).toFixed(1)}s`,
  ];
  try {
    appendFileSync(reportPath, lines.join("\n") + "\n", "utf-8");
  } catch {
    // log dir might not exist
  }
  logger.info("dream", `报告 → ${reportPath}`);

  releaseLock(db);
  logger.info("dream", `夜间维护完成 (${(report.duration_ms / 1000).toFixed(1)}s)`);
  return report;
}

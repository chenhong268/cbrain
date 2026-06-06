/**
 * Read-only LanceDB integrity probe.
 * Shared by `cbrain doctor` (plain) and `cbrain doctor --first-run`.
 *
 * Checks: path exists → connect → tableNames → openTable/read →
 *         SQLite coverage comparison → orphan detection → directory size.
 * Never creates directories, tables, or calls warmup().
 * Always closes connections in finally.
 */
import { existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import type { CBrainDB } from "../storage/sqlite.js";

// ── Types ───────────────────────────────────────────────────

export type LanceCheckStatus = "pass" | "warn" | "fail";

export interface LanceCheckResult {
  readonly id: string;
  readonly status: LanceCheckStatus;
  readonly message: string;
  readonly action?: string;
}

export interface LanceIntegrityReport {
  readonly checks: ReadonlyArray<LanceCheckResult>;
  readonly overallStatus: LanceCheckStatus;
}

// ── Directory size helper ───────────────────────────────────

function getDirSizeBytes(dir: string): number {
  let total = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        total += getDirSizeBytes(p);
      } else if (entry.isFile()) {
        try { total += statSync(p).size; } catch { /* skip */ }
      }
    }
  } catch { /* not accessible */ }
  return total;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── SQLite helpers ──────────────────────────────────────────

function getSqliteChunkPageSlugs(db: CBrainDB): string[] {
  const rows = db.rawDb.query(
    "SELECT DISTINCT page_slug FROM chunks WHERE summary_level = 0",
  ).all() as Array<Record<string, string>>;
  return rows.map(r => r.page_slug);
}

// ── Recovery action builder ─────────────────────────────────

/** Full rebuild action for corrupted/missing LanceDB */
function rebuildAction(): string {
  return [
    "修复步骤：",
    "  1. 停止 cbrain serve",
    "  2. 运行 cbrain sync --reindex-vectors",
    "",
    "--reindex-vectors 会在 staging 目录重建 chunks + insights，",
    "验证后原子替换，旧索引自动保留为 backup。",
    "源数据在 SQLite 和 vault 中，数据不丢。",
  ].join("\n");
}

/** Partial rebuild action for coverage gaps / orphans */
function reindexAction(): string {
  return "运行 cbrain sync --reindex-vectors 重建缺失向量（原子替换，安全）";
}

/** Orphan-only action: dream stage 4.5 cleanup */
function orphanAction(): string {
  return "运行 cbrain dream 清理孤儿向量（Stage 4.5）";
}

// ── Main probe ──────────────────────────────────────────────

/**
 * Run a read-only integrity check on the LanceDB at lancePath,
 * comparing against the SQLite DB for coverage.
 *
 * @param lancePath  Configured LanceDB data directory
 * @param db         Open CBrainDB instance (caller owns lifecycle)
 * @param opts       Optional thresholds; dbPath is used in recovery hints
 */
export async function checkLanceIntegrity(
  lancePath: string,
  db: CBrainDB,
  opts?: { coverageWarnThreshold?: number; sizeWarnBytes?: number },
): Promise<LanceIntegrityReport> {
  const coverageThreshold = opts?.coverageWarnThreshold ?? 0.10; // 10%
  const sizeWarnBytes = opts?.sizeWarnBytes ?? 500 * 1024 * 1024; // 500 MB

  const checks: LanceCheckResult[] = [];
  let connection: lancedb.Connection | null = null;

  try {
    // ── 1. Path exists ──
    if (!existsSync(lancePath)) {
      // Check if SQLite has chunks — determines severity
      const sqliteSlugs = getSqliteChunkPageSlugs(db);
      if (sqliteSlugs.length > 0) {
        checks.push({
          id: "lance:path",
          status: "fail",
          message: `LanceDB 路径不存在: ${lancePath}（SQLite 有 ${sqliteSlugs.length} 个页面的 chunks）`,
          action: rebuildAction(),
        });
      } else {
        // New install — no chunks anywhere
        checks.push({
          id: "lance:path",
          status: "pass",
          message: "LanceDB 路径不存在（新安装），运行 cbrain sync 创建",
        });
      }
      // Cannot proceed without path
      return finalize(checks);
    }

    checks.push({
      id: "lance:path",
      status: "pass",
      message: `LanceDB 路径存在: ${lancePath}`,
    });

    // ── 2. Connect + tableNames ──
    let tableNames: string[] = [];
    try {
      connection = await lancedb.connect(lancePath);
      tableNames = await connection.tableNames();
    } catch (e) {
      const sqliteSlugs = getSqliteChunkPageSlugs(db);
      const hasSqliteData = sqliteSlugs.length > 0;
      checks.push({
        id: "lance:connect",
        status: hasSqliteData ? "fail" : "warn",
        message: `LanceDB 连接失败: ${e instanceof Error ? e.message : String(e)}`,
        action: hasSqliteData
          ? rebuildAction()
          : "运行 cbrain sync 初始化 LanceDB",
      });
      return finalize(checks);
    }

    checks.push({
      id: "lance:connect",
      status: "pass",
      message: `LanceDB 连接成功（${tableNames.length} 个表${tableNames.length > 0 ? `: ${tableNames.join(", ")}` : ""}）`,
    });

    // ── 3. SQLite has raw chunks → chunks table must exist ──
    const sqliteSlugs = getSqliteChunkPageSlugs(db);
    const hasChunksTable = tableNames.includes("chunks");

    if (sqliteSlugs.length > 0 && !hasChunksTable) {
      checks.push({
        id: "lance:chunks_table",
        status: "fail",
        message: `SQLite 有 ${sqliteSlugs.length} 个页面的 chunks，但 LanceDB 缺少 chunks 表`,
        action: rebuildAction(),
      });
      return finalize(checks);
    }

    if (sqliteSlugs.length === 0 && !hasChunksTable) {
      // New install, no data anywhere
      checks.push({
        id: "lance:chunks_table",
        status: "pass",
        message: "无索引数据（新安装），运行 cbrain sync 创建",
      });
      return finalize(checks);
    }

    // ── 4. openTable + read test ──
    let lanceSlugs: string[] = [];
    try {
      const chunksTable = await connection.openTable("chunks");
      // Read distinct pageSlugs via query
      const rows = await chunksTable.query()
        .select(["pageSlug"])
        .where("chunkIndex >= 0")
        .toArray();
      lanceSlugs = [...new Set(rows.map((r: Record<string, unknown>) => r.pageSlug as string))];
    } catch (e) {
      checks.push({
        id: "lance:read",
        status: "fail",
        message: `LanceDB chunks 表读取失败: ${e instanceof Error ? e.message : String(e)}`,
        action: rebuildAction(),
      });
      return finalize(checks);
    }

    checks.push({
      id: "lance:read",
      status: "pass",
      message: `LanceDB chunks 表可读（${lanceSlugs.length} 个页面的向量）`,
    });

    // ── 5. Coverage comparison ──
    const sqliteSet = new Set(sqliteSlugs);
    const lanceSet = new Set(lanceSlugs);

    // Missing in LanceDB
    const missing = sqliteSlugs.filter(s => !lanceSet.has(s));
    const missingRate = sqliteSlugs.length > 0 ? missing.length / sqliteSlugs.length : 0;

    if (missing.length > 0) {
      const isHigh = missingRate > coverageThreshold;
      checks.push({
        id: "lance:coverage",
        status: isHigh ? "warn" : "pass",
        message: `${missing.length}/${sqliteSlugs.length} 个页面缺少向量索引（${(missingRate * 100).toFixed(1)}%）`,
        action: isHigh ? reindexAction() : undefined,
      });
    } else {
      checks.push({
        id: "lance:coverage",
        status: "pass",
        message: `向量索引覆盖率 100%（${sqliteSlugs.length} 个页面）`,
      });
    }

    // ── 6. Orphan detection ──
    const orphans = lanceSlugs.filter(s => !sqliteSet.has(s));
    if (orphans.length > 0) {
      checks.push({
        id: "lance:orphans",
        status: "warn",
        message: `${orphans.length} 个 LanceDB 向量在 SQLite 中无对应页面`,
        action: orphanAction(),
      });
    }

    // ── 7. Directory size ──
    const dirBytes = getDirSizeBytes(lancePath);
    if (dirBytes > sizeWarnBytes) {
      checks.push({
        id: "lance:size",
        status: "warn",
        message: `LanceDB 目录 ${formatBytes(dirBytes)}（超过 500 MB）`,
        action: "运行 cbrain compact 回收空间",
      });
    }
  } finally {
    // Always close
    if (connection) {
      try { connection.close(); } catch { /* ignore */ }
    }
  }

  return finalize(checks);
}

function finalize(checks: LanceCheckResult[]): LanceIntegrityReport {
  const hasFail = checks.some(c => c.status === "fail");
  const hasWarn = checks.some(c => c.status === "warn");
  const overallStatus: LanceCheckStatus = hasFail ? "fail" : hasWarn ? "warn" : "pass";
  return { checks, overallStatus };
}

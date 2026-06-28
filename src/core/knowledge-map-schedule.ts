import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import type { CBrainDB } from "../storage/sqlite.js";
import type { Logger } from "./logger.js";
import { analyzeKnowledgeMap } from "./knowledge-map.js";
import { buildKnowledgeMapReport, isCommunityMature } from "./knowledge-map-report.js";
import { sanitizeForLog } from "./sync-index-safety.js";

/**
 * #242 — Knowledge Map Dream stage: generate the user-facing report at most
 * once per configured interval, failure-isolated. All settings + last-run
 * timestamp live in the DB config table (same storage the Dream lock uses).
 */

// Config keys (DB config table). Defaults make the stage work out of the box.
export const KM_ENABLED_KEY = "knowledge_map.enabled";
export const KM_INTERVAL_KEY = "knowledge_map.interval_days";
export const KM_LAST_RUN_KEY = "knowledge_map.last_run_at";

const DEFAULT_INTERVAL_DAYS = 7;
const MS_PER_DAY = 86_400_000;
const WARNING_MAX = 120;

export interface KnowledgeMapStageResult {
  status: "generated" | "skipped" | "failed";
  enabled: boolean;
  domains: number;
  mature: number;
  growing: number;
  highMentionIsolates: number;
  reportPath: string | null;
  warning?: string;
  lastRunAt: string | null;
}

/** Safe default used when Dream is locked (or the stage never runs). */
export function defaultKnowledgeMapStageResult(): KnowledgeMapStageResult {
  return {
    status: "skipped",
    enabled: true,
    domains: 0,
    mature: 0,
    growing: 0,
    highMentionIsolates: 0,
    reportPath: null,
    lastRunAt: null,
  };
}

/** enabled unless explicitly "false"/"0". */
function readEnabled(db: CBrainDB): boolean {
  const v = db.getConfig(KM_ENABLED_KEY);
  if (v === null || v === undefined || v === "") return true;
  return v !== "false" && v !== "0";
}

/** interval in days; falls back to 7 when missing/invalid. */
function readIntervalDays(db: CBrainDB): number {
  const v = db.getConfig(KM_INTERVAL_KEY);
  if (v === null || v === undefined || v === "") return DEFAULT_INTERVAL_DAYS;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_INTERVAL_DAYS;
}

interface ScheduleDecision {
  run: boolean;
  enabled: boolean;
  lastRunAt: string | null;
}

/**
 * Decide whether the stage should run now. Exposed for testability.
 * - disabled → run=false
 * - no last_run_at → run=true (first run)
 * - last_run_at within interval → run=false
 * - force → run=true regardless of interval (still respects enabled)
 */
export function shouldRunKnowledgeMap(db: CBrainDB, opts: { force?: boolean; now?: number } = {}): ScheduleDecision {
  const enabled = readEnabled(db);
  const lastRunAt = db.getConfig(KM_LAST_RUN_KEY) ?? null;
  if (!enabled) return { run: false, enabled, lastRunAt };
  if (opts.force) return { run: true, enabled, lastRunAt };
  if (lastRunAt === null) return { run: true, enabled, lastRunAt };
  const last = Date.parse(lastRunAt);
  const now = opts.now ?? Date.now();
  if (Number.isNaN(last)) return { run: true, enabled, lastRunAt };
  const elapsedDays = (now - last) / MS_PER_DAY;
  return { run: elapsedDays >= readIntervalDays(db), enabled, lastRunAt };
}

/**
 * Run the Knowledge Map stage. NEVER throws — on any failure returns
 * status="failed" with a sanitized warning and leaves last_run_at untouched,
 * so Dream continues. Writes only under outputsDir/knowledge-map/, never vault.
 */
export async function runKnowledgeMapStage(
  db: CBrainDB,
  outputsDir: string,
  logger: Logger,
  opts: { force?: boolean; now?: number } = {},
): Promise<KnowledgeMapStageResult> {
  const { run, enabled, lastRunAt } = shouldRunKnowledgeMap(db, opts);
  const skipped: KnowledgeMapStageResult = {
    status: "skipped",
    enabled,
    domains: 0,
    mature: 0,
    growing: 0,
    highMentionIsolates: 0,
    reportPath: null,
    lastRunAt,
  };
  if (!enabled || !run) return skipped;

  try {
    const now = opts.now ?? Date.now();
    const analysis = analyzeKnowledgeMap(db);
    const mature = analysis.communities.filter(isCommunityMature).length;
    const report = buildKnowledgeMapReport(analysis);

    const dir = join(outputsDir, "knowledge-map");
    mkdirSync(dir, { recursive: true });
    const date = new Date(now).toISOString().slice(0, 10);
    const reportPath = join(dir, `knowledge-map-${date}.md`);
    writeFileSync(reportPath, report.markdown, "utf-8");

    const stamp = new Date(now).toISOString();
    db.setConfig(KM_LAST_RUN_KEY, stamp);
    logger.info("dream", `Knowledge Map 报告 → ${reportPath}`);

    return {
      status: "generated",
      enabled,
      domains: analysis.communities.length,
      mature,
      growing: analysis.communities.length - mature,
      highMentionIsolates: analysis.highMentionIsolates.length,
      reportPath,
      lastRunAt: stamp,
    };
  } catch (e) {
    const warning = sanitizeWarning(e);
    logger.warn("dream", `Knowledge Map 阶段失败（已隔离，不影响 Dream）: ${warning}`);
    return {
      status: "failed",
      enabled,
      domains: 0,
      mature: 0,
      growing: 0,
      highMentionIsolates: 0,
      reportPath: null,
      warning,
      lastRunAt,
    };
  }
}

/**
 * Sanitize an error into a warning safe for dream_status progress. Reuses the
 * shared log sanitizer (redacts absolute filesystem paths + credential-like
 * tokens), then additionally redacts home-relative references (~/…). Keeps the
 * error kind/action useful, e.g. `ENOTDIR: not a directory, mkdir '<path>'`.
 */
function sanitizeWarning(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const redacted = sanitizeForLog(msg).replace(/~\/[^\s'"<>]*/g, "<path>");
  const first = redacted.split(/\n/)[0] ?? redacted;
  return first.length > WARNING_MAX ? `${first.slice(0, WARNING_MAX - 1)}…` : first;
}

/**
 * Compact user-facing brief line for a generated stage result.
 * Returns null when the stage did not generate (so buildBrief omits the line).
 */
export function knowledgeMapBriefLine(stage: KnowledgeMapStageResult): string | null {
  if (stage.status !== "generated") return null;
  return `Knowledge Map: ${stage.domains} 个主要领域，${stage.growing} 个成长中，${stage.mature} 个成熟，${stage.highMentionIsolates} 个高提及孤岛`;
}

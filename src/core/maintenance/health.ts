import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CBrainDB } from "../../storage/sqlite.js";
import type { MetricsSnapshot } from "../audit.js";
import type { Logger } from "../logger.js";
import { isCurrentFactLink, isValidRelation } from "../shared.js";
import { extractWikiLinks, stripKnownRelationsSection, isValidEntityName } from "../ingestion/extract.js";
import { parseFrontmatter } from "../../utils/frontmatter.js";
import { findEntitySlug } from "../shared.js";

// ─── Contradiction classification ─────────────────────────────

export type ContextVerdict = "conflict" | "complementary" | "insufficient";

const STOP_WORDS = new Set([
  "的", "了", "在", "是", "和", "与", "也", "都", "被", "从", "到", "对", "为", "以",
  "及", "等", "或", "但", "而", "这", "那", "他", "她", "它", "我", "你", "很", "就",
  "才", "会", "能", "要", "可以", "一个", "一", "个", "些", "着", "过", "把", "让",
  "上", "下", "中", "里", "外", "前", "后",
]);

const NEGATION_MARKERS = new Set([
  "不", "没", "无", "非", "未", "别", "勿", "莫", "没有", "不是", "并非", "从未", "不再",
]);

// Mutually exclusive state pairs: side-A vs side-B
const MUTEX_STATES: Array<[Set<string>, Set<string>]> = [
  [new Set(["职", "任职", "在职"]), new Set(["离职", "离", "卸任"])],
  [new Set(["负责"]), new Set(["不再负责", "卸任"])],
  [new Set(["进行", "进行中"]), new Set(["结束", "已结束", "终止"])],
  [new Set(["有效"]), new Set(["失效", "无效"])],
  [new Set(["属于"]), new Set(["不属于"])],
];

const MIN_CONTENT_WORDS = 3;
const LOW_OVERLAP = 0.2;

function tokenizeContent(text: string): string[] {
  return [...text].filter(ch => !/[\s，。、；：！？\n]/.test(ch) && !STOP_WORDS.has(ch));
}

type MutexState = "positive" | "negative" | "none";

function classifyMutexState(text: string, positive: Set<string>, negative: Set<string>): MutexState {
  if ([...negative].some(term => text.includes(term))) return "negative";
  if ([...positive].some(term => text.includes(term))) return "positive";
  return "none";
}

function hasMutexConflict(charsA: string[], charsB: string[]): boolean {
  const textA = charsA.join("");
  const textB = charsB.join("");
  for (const [positive, negative] of MUTEX_STATES) {
    const stateA = classifyMutexState(textA, positive, negative);
    const stateB = classifyMutexState(textB, positive, negative);
    if (stateA !== "none" && stateB !== "none" && stateA !== stateB) return true;
  }
  return false;
}

export function classifyContextPair(ctxA: string, ctxB: string): ContextVerdict {
  const wordsA = tokenizeContent(ctxA);
  const wordsB = tokenizeContent(ctxB);

  if (wordsA.length < MIN_CONTENT_WORDS || wordsB.length < MIN_CONTENT_WORDS) {
    return "insufficient";
  }

  const setA = new Set(wordsA);
  const setB = new Set(wordsB);
  const intersection = [...setA].filter(w => setB.has(w));
  const overlap = intersection.length / Math.min(setA.size, setB.size);

  if (overlap < LOW_OVERLAP) return "complementary";

  const hasNegA = wordsA.some(w => NEGATION_MARKERS.has(w));
  const hasNegB = wordsB.some(w => NEGATION_MARKERS.has(w));

  if (hasNegA !== hasNegB && intersection.length > 0) return "conflict";

  if (hasMutexConflict(wordsA, wordsB) && intersection.length > 0) return "conflict";

  return "complementary";
}

// ─── Types ────────────────────────────────────────────────────

export interface HealthDimension {
  name: string;
  status: "pass" | "warn" | "fail";
  issues: HealthIssue[];
}

export interface HealthIssue {
  severity: "low" | "medium" | "high";
  slug: string;
  title: string;
  description: string;
  suggestion?: string;
}

export interface HealthReport {
  timestamp: string;
  overallStatus: "pass" | "warn" | "fail";
  dimensions: HealthDimension[];
  metrics: MetricsSnapshot;
  delta?: HealthDelta;
  reportPaths?: ReportPaths;
}

export interface ReportPaths {
  summary: string;
  actions: string;
  detail: string;
}

// ─── Delta Types ──────────────────────────────────────────────

interface HealthState {
  timestamp: string;
  slugRunCounts: Record<string, number>;
  dimensions: Array<{
    name: string;
    status: "pass" | "warn" | "fail";
    issueSlugs: string[];
    issueCount: number;
  }>;
}

export interface DimensionDelta {
  name: string;
  newIssues: HealthIssue[];
  resolvedSlugs: string[];
  chronicSlugs: string[];
  unchangedCount: number;
  previousCount: number;
  currentCount: number;
}

export interface HealthDelta {
  previousTimestamp: string;
  dimensions: DimensionDelta[];
  totalNew: number;
  totalResolved: number;
  totalChronic: number;
}

// ─── HealthChecker ────────────────────────────────────────────

const CHRONIC_THRESHOLD = 3;
const RETENTION_DAYS = 7;
const SYSTEM_ERROR_FAIL_WINDOW_MS = 24 * 60 * 60 * 1000;

function isWithinSystemErrorFailWindow(timestamp: string, now = Date.now()): boolean {
  const parsed = Date.parse(timestamp.endsWith("Z") ? timestamp : `${timestamp}Z`);
  if (Number.isNaN(parsed)) return true;
  return now - parsed <= SYSTEM_ERROR_FAIL_WINDOW_MS;
}

export class HealthChecker {
  private db: CBrainDB;
  private outputsDir: string;
  private logger: Logger | null;
  private vaultPath?: string;

  constructor(db: CBrainDB, outputsDir: string, logger?: Logger, vaultPath?: string) {
    this.db = db;
    this.outputsDir = outputsDir;
    this.logger = logger ?? null;
    this.vaultPath = vaultPath;
  }

  async checkAll(): Promise<HealthReport> {
    const timestamp = new Date().toISOString();

    const metrics = this.collectMetrics();
    const dimensions = [
      this.checkErrors(),
      this.checkSemanticDedup(),
      this.checkSlugCollisions(),
      this.checkTitleCollisionQuarantine(),
      this.checkConsistency(),
      this.checkStructuralConsistency(),
      this.checkCompleteness(),
      this.checkIslands(),
      this.checkNewSuggestions(),
      this.checkAttention(),
      this.checkDataReadiness(),
      this.checkSourceQuality(),
      this.checkStaleContent(),
      this.checkContradictions(),
      this.checkSearchQuality(),
      this.checkBulkPending(),
      this.checkNerQuality(),
      this.checkVerifierQuality(),
    ];

    const highCount = dimensions.reduce((n, d) => n + d.issues.filter(i => i.severity === "high").length, 0);
    const overallStatus = highCount > 5
      ? "fail"
      : dimensions.some(d => d.status === "warn") || highCount > 0
        ? "warn"
        : "pass";

    const report: HealthReport = {
      timestamp,
      overallStatus,
      dimensions,
      metrics,
    };

    // Delta computation
    const prevState = this.loadState();
    const delta = this.computeDeltas(dimensions, prevState);
    report.delta = delta;

    // Save new state
    this.saveState(dimensions, prevState, timestamp);

    // Write three-layer output
    const reportPaths = this.writeReports(report);
    report.reportPaths = reportPaths;

    this.cleanupOldReports();

    return report;
  }

  // ─── State Persistence ────────────────────────────────────

  private statePath(): string {
    return join(this.outputsDir, "health", "state.json");
  }

  private loadState(): HealthState | null {
    const path = this.statePath();
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as HealthState;
    } catch {
      return null;
    }
  }

  private saveState(dimensions: HealthDimension[], prevState: HealthState | null, timestamp: string): void {
    const prevCounts = prevState?.slugRunCounts ?? {};
    const currentCounts: Record<string, number> = {};

    for (const dim of dimensions) {
      for (const issue of dim.issues) {
        currentCounts[issue.slug] = (prevCounts[issue.slug] ?? 0) + 1;
      }
    }

    const state: HealthState = {
      timestamp,
      slugRunCounts: currentCounts,
      dimensions: dimensions.map(d => ({
        name: d.name,
        status: d.status,
        issueSlugs: d.issues.map(i => i.slug),
        issueCount: d.issues.length,
      })),
    };

    mkdirSync(join(this.outputsDir, "health"), { recursive: true });
    writeFileSync(this.statePath(), JSON.stringify(state, null, 2), "utf-8");
  }

  // ─── Delta Computation ────────────────────────────────────

  private computeDeltas(dimensions: HealthDimension[], prevState: HealthState | null): HealthDelta {
    if (!prevState) {
      return {
        previousTimestamp: "",
        dimensions: dimensions.map(d => ({
          name: d.name,
          newIssues: d.issues,
          resolvedSlugs: [],
          chronicSlugs: [],
          unchangedCount: 0,
          previousCount: 0,
          currentCount: d.issues.length,
        })),
        totalNew: dimensions.reduce((s, d) => s + d.issues.length, 0),
        totalResolved: 0,
        totalChronic: 0,
      };
    }

    const prevDimMap = new Map(prevState.dimensions.map(d => [d.name, d]));
    const dimDeltas: DimensionDelta[] = [];

    for (const dim of dimensions) {
      const prevDim = prevDimMap.get(dim.name);
      const prevSlugSet = new Set(prevDim?.issueSlugs ?? []);
      const curSlugSet = new Set(dim.issues.map(i => i.slug));

      const newIssues = dim.issues.filter(i => !prevSlugSet.has(i.slug));
      const resolvedSlugs = [...prevSlugSet].filter(s => !curSlugSet.has(s));
      const chronicSlugs = dim.issues
        .filter(i => (prevState.slugRunCounts?.[i.slug] ?? 0) >= CHRONIC_THRESHOLD)
        .map(i => i.slug);
      const unchangedCount = dim.issues.filter(i => prevSlugSet.has(i.slug)).length;

      dimDeltas.push({
        name: dim.name,
        newIssues,
        resolvedSlugs,
        chronicSlugs,
        unchangedCount,
        previousCount: prevDim?.issueCount ?? 0,
        currentCount: dim.issues.length,
      });
    }

    return {
      previousTimestamp: prevState.timestamp,
      dimensions: dimDeltas,
      totalNew: dimDeltas.reduce((s, d) => s + d.newIssues.length, 0),
      totalResolved: dimDeltas.reduce((s, d) => s + d.resolvedSlugs.length, 0),
      totalChronic: dimDeltas.reduce((s, d) => s + d.chronicSlugs.length, 0),
    };
  }

  // ─── Three-Layer Report Writing ───────────────────────────

  private writeReports(report: HealthReport): ReportPaths {
    const healthDir = join(this.outputsDir, "health");
    mkdirSync(healthDir, { recursive: true });

    const date = report.timestamp.slice(0, 10);
    const summaryPath = join(healthDir, `summary-${date}.md`);
    const actionsPath = join(healthDir, `actions-${date}.md`);
    const detailPath = join(healthDir, `detail-${date}.json`);

    this.writeSummary(report, summaryPath);
    this.writeActions(report, actionsPath);
    this.writeDetail(report, detailPath);

    return { summary: summaryPath, actions: actionsPath, detail: detailPath };
  }

  private writeSummary(report: HealthReport, filePath: string): void {
    const date = report.timestamp.slice(0, 10);
    const icon = (s: string) => s === "pass" ? "✅" : s === "warn" ? "⚠️" : "❌";
    const delta = report.delta;

    let md = `# 健康检查 — ${date}\n\n`;
    md += `**总体状态**: ${icon(report.overallStatus)} ${report.overallStatus === "pass" ? "通过" : report.overallStatus === "warn" ? "警告" : "失败"}\n\n`;

    // Metrics overview
    md += `## 指标总览\n\n`;
    md += `| 指标 | 数值 |\n|------|------|\n`;
    md += `| 总页面 | ${report.metrics.totalPages} |\n`;
    md += `| 实体 / 概念 | ${report.metrics.entities} / ${report.metrics.concepts} |\n`;
    md += `| 链接 | ${report.metrics.totalLinks} |\n`;
    md += `| 孤岛 / 空壳 | ${report.metrics.orphans} / ${report.metrics.bareStubs} |\n\n`;

    // Delta section
    if (delta && delta.previousTimestamp) {
      const prevDate = delta.previousTimestamp.slice(0, 10);
      md += `## 变化（vs ${prevDate}）\n\n`;

      const changes: string[] = [];
      if (delta.totalNew > 0) changes.push(`🆕 新增 ${delta.totalNew} 个问题`);
      if (delta.totalResolved > 0) changes.push(`✅ 消失 ${delta.totalResolved} 个`);
      if (delta.totalChronic > 0) changes.push(`🔁 慢性 ${delta.totalChronic} 个`);

      for (const dd of delta.dimensions) {
        if (dd.currentCount === dd.previousCount || dd.currentCount === 0) continue;
        const diff = dd.currentCount - dd.previousCount;
        const arrow = diff > 0 ? `↑${diff}` : diff < 0 ? `↓${Math.abs(diff)}` : "→";
        if (diff !== 0) {
          changes.push(`${dd.name} ${dd.previousCount}→${dd.currentCount}（${arrow}）`);
        }
      }

      if (changes.length > 0) {
        md += changes.map(c => `- ${c}`).join("\n") + "\n\n";
      } else {
        md += "无变化。\n\n";
      }
    } else {
      md += `## 变化\n\n首次健康检查，无历史对比数据。\n\n`;
    }

    // Per-dimension overview table
    md += `## 各维度一览\n\n`;
    md += `| 维度 | 状态 | 问题数 | 变化 |\n|------|------|--------|------|\n`;
    for (const dim of report.dimensions) {
      const dd = delta?.dimensions.find(d => d.name === dim.name);
      let change = "";
      if (dd) {
        if (dd.previousCount === 0 && dd.currentCount === 0) change = "—";
        else if (dd.previousCount === 0) change = `+${dd.currentCount}`;
        else {
          const diff = dd.currentCount - dd.previousCount;
          change = diff > 0 ? `↑${diff}` : diff < 0 ? `↓${Math.abs(diff)}` : "→";
        }
      }
      md += `| ${dim.name} | ${icon(dim.status)} | ${dim.issues.length} | ${change} |\n`;
    }

    writeFileSync(filePath, md, "utf-8");
  }

  private writeActions(report: HealthReport, filePath: string): void {
    const date = report.timestamp.slice(0, 10);
    const delta = report.delta;

    let md = `# 行动清单 — ${date}\n\n`;

    if (!delta || delta.totalNew === 0) {
      md += "无新增问题，知识库状态稳定。\n";
      writeFileSync(filePath, md, "utf-8");
      return;
    }

    const allNew = delta.dimensions.flatMap(d =>
      d.newIssues.map(i => ({ ...i, dimension: d.name }))
    );

    // Sort by severity: high > medium > low
    const severityOrder = { high: 0, medium: 1, low: 2 };
    allNew.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

    // Severity folding
    const high = allNew.filter(i => i.severity === "high");
    const medium = allNew.filter(i => i.severity === "medium");
    const low = allNew.filter(i => i.severity === "low");

    if (high.length > 0) {
      md += `## 🔴 高优先级\n\n`;
      for (const issue of high) {
        md += `- **${issue.dimension}**: [[${issue.slug}]] ${issue.description}\n`;
      }
      md += "\n";
    }

    if (medium.length > 0) {
      md += `## 🟡 中优先级\n\n`;
      const shown = medium.slice(0, 10);
      for (const issue of shown) {
        md += `- **${issue.dimension}**: [[${issue.slug}]] ${issue.description}\n`;
      }
      if (medium.length > 10) {
        md += `- …还有 ${medium.length - 10} 个\n`;
      }
      md += "\n";
    }

    if (low.length > 0) {
      md += `## 🟢 低优先级\n\n`;
      md += `${low.length} 个低优先级问题（用 \`cbrain health --full\` 查看详情）\n\n`;
    }

    writeFileSync(filePath, md, "utf-8");
  }

  private writeDetail(report: HealthReport, filePath: string): void {
    // Strip delta from detail to avoid circular history
    const { delta: _, ...reportData } = report;
    writeFileSync(filePath, JSON.stringify(reportData, null, 2), "utf-8");
  }

  // ─── Full Markdown Report (for --full) ────────────────────

  writeFullReport(report: HealthReport): string {
    const statusIcon = (s: string) =>
      s === "pass" ? "✅" : s === "warn" ? "⚠️" : "❌";

    let md = `# 健康检查（完整） — ${report.timestamp.slice(0, 10)}\n\n`;
    md += `**总体状态**: ${statusIcon(report.overallStatus)}\n\n`;

    md += `## 指标总览\n\n`;
    md += `| 指标 | 数值 |\n|------|------|\n`;
    md += `| 总页面数 | ${report.metrics.totalPages} |\n`;
    md += `| 实体 | ${report.metrics.entities} |\n`;
    md += `| 概念 | ${report.metrics.concepts} |\n`;
    md += `| 事件 / 记录 | ${report.metrics.events} / ${report.metrics.records} |\n`;
    md += `| 总链接数 | ${report.metrics.totalLinks} |\n`;
    md += `| 平均提及次数 | ${report.metrics.avgMentionsPerPage.toFixed(1)} |\n`;
    md += `| 孤岛页面 | ${report.metrics.orphans} |\n`;
    md += `| 空壳 stub | ${report.metrics.bareStubs} |\n`;
    md += `| 概念/来源比 | ${report.metrics.conceptsPerSource.toFixed(2)} |\n\n`;

    for (const dim of report.dimensions) {
      md += `## ${dim.name} ${statusIcon(dim.status)}\n\n`;
      if (dim.issues.length === 0) {
        md += `未发现问题。\n\n`;
        continue;
      }
      md += `| 严重程度 | 页面 | 问题 | 建议 |\n|----------|------|------|------|\n`;
      for (const issue of dim.issues) {
        const pageRef = issue.slug === "-" ? "-" : `[[${issue.slug}]]`;
        md += `| ${issue.severity} | ${pageRef} | ${issue.description} | ${issue.suggestion ?? "-"} |\n`;
      }
      md += `\n`;
    }

    return md;
  }

  // ─── Rolling Cleanup ──────────────────────────────────────

  private cleanupOldReports(): void {
    const healthDir = join(this.outputsDir, "health");
    if (!existsSync(healthDir)) return;

    const now = Date.now();
    const maxAge = RETENTION_DAYS * 24 * 60 * 60 * 1000;

    const files = readdirSync(healthDir);
    for (const file of files) {
      if (file === "state.json") continue;

      const filePath = join(healthDir, file);
      try {
        const stat = statSync(filePath);
        if (now - stat.mtimeMs > maxAge) {
          rmSync(filePath, { force: true });
        }
      } catch {
        // Skip files we can't stat
      }
    }
  }

  // ─── Dimension Checks (unchanged logic) ───────────────────

  private checkErrors(): HealthDimension {
    const issues: HealthIssue[] = [];
    if (!this.logger) {
      return { name: "系统错误", status: "pass", issues: [] };
    }

    const recentErrors = this.logger.getRecentErrors(7);
    const activeErrors = recentErrors.filter(e => isWithinSystemErrorFailWindow(e.timestamp));
    if (recentErrors.length > 0) {
      const isActive = activeErrors.length > 0;
      const errorsForModules = isActive ? activeErrors : recentErrors;
      issues.push({
        severity: isActive ? "high" : "medium",
        slug: "-",
        title: isActive ? `${activeErrors.length} 个当前系统错误` : `${recentErrors.length} 个历史系统错误`,
        description: isActive
          ? `最近 24 小时发现 ${activeErrors.length} 个错误，最近 7 天共 ${recentErrors.length} 个，涉及模块：${[...new Set(errorsForModules.map(e => e.module))].join("、")}`
          : `最近 7 天发现 ${recentErrors.length} 个历史错误，最近 24 小时无新增，涉及模块：${[...new Set(errorsForModules.map(e => e.module))].join("、")}`,
        suggestion: "检查 runtime/logs/ 系统日志查看详情",
      });
    }

    return {
      name: "系统错误",
      status: activeErrors.length > 0 ? "fail" : recentErrors.length > 0 ? "warn" : "pass",
      issues,
    };
  }

  private checkSemanticDedup(): HealthDimension {
    const issues: HealthIssue[] = [];

    const rows = this.db.getEntityConceptPages();

    const seen = new Map<string, { slug: string; title: string }>();
    for (const row of rows) {
      const normalized = row.title.toLowerCase().trim();
      const existing = seen.get(normalized);
      if (existing) {
        issues.push({
          severity: "high",
          slug: row.slug,
          title: row.title,
          description: `Duplicate of [[${existing.title}]] (${existing.slug})`,
          suggestion: `Merge into [[${existing.slug}]] or delete duplicate`,
        });
      } else {
        seen.set(normalized, { slug: row.slug, title: row.title });
      }
    }

    const strippedMap = new Map<string, { slug: string; title: string }>();
    for (const row of rows) {
      const stripped = row.title.replace(/[\s\-_·.]/g, "").toLowerCase();
      const existing = strippedMap.get(stripped);
      if (existing && existing.slug !== row.slug) {
        const alreadyFlagged = issues.some(i => i.slug === row.slug);
        if (!alreadyFlagged) {
          issues.push({
            severity: "medium",
            slug: row.slug,
            title: row.title,
            description: `Near-duplicate of [[${existing.title}]] (${existing.slug})`,
            suggestion: `Review and merge if same entity`,
          });
        }
      } else {
        strippedMap.set(stripped, { slug: row.slug, title: row.title });
      }
    }

    return {
      name: "语义去重",
      status: issues.some(i => i.severity === "high") ? "fail" : issues.length > 0 ? "warn" : "pass",
      issues,
    };
  }

  private checkSlugCollisions(): HealthDimension {
    const issues: HealthIssue[] = [];

    const entities = this.db.getEntities();

    const groups = new Map<string, Array<{ slug: string; title: string }>>();
    for (const row of entities) {
      const base = row.slug.replace(/-\d+$/, "");
      const list = groups.get(base) || [];
      list.push(row);
      groups.set(base, list);
    }

    for (const [, items] of groups) {
      if (items.length <= 1) continue;
      for (const item of items) {
        const others = items.filter(i => i.slug !== item.slug).map(i => `[[${i.slug}]]`).join(", ");
        issues.push({
          severity: "high",
          slug: item.slug,
          title: item.title,
          description: `Potential duplicate — same base slug as ${others}`,
          suggestion: `Use merge_pages to merge duplicates into the canonical page, or verify they are different entities`,
        });
      }
    }

    return {
      name: "疑似重复",
      status: issues.length > 0 ? "warn" : "pass",
      issues,
    };
  }

  private checkTitleCollisionQuarantine(): HealthDimension {
    const issues: HealthIssue[] = [];

    const raw = this.db.getConfig("watcher.quarantine");
    if (!raw) return { name: "标题冲突隔离", status: "pass", issues: [] };

    try {
      const parsed = JSON.parse(raw) as Record<string, {
        failCount: number;
        lastError: string;
        quarantinedAt: string;
        titleCollisionJson?: { title: string; incoming: { slug: string; type: string; filePath: string }; existing: { slug: string; type: string; filePath: string } };
      }>;

      for (const [slug, entry] of Object.entries(parsed)) {
        if (!entry.titleCollisionJson || !entry.quarantinedAt) continue;
        const tc = entry.titleCollisionJson;
        issues.push({
          severity: "high",
          slug,
          title: tc.title,
          description: `标题 "${tc.title}" 冲突：${tc.incoming.slug} (${tc.incoming.type}, ${tc.incoming.filePath}) vs ${tc.existing.slug} (${tc.existing.type}, ${tc.existing.filePath})`,
          suggestion: `重命名 ${tc.incoming.filePath} 的 title，或用 merge_pages 合并到 ${tc.existing.slug}`,
        });
      }
    } catch {
      // corrupt config — not actionable here
    }

    return {
      name: "标题冲突隔离",
      status: issues.length > 0 ? "fail" : "pass",
      issues,
    };
  }

  private checkBulkPending(): HealthDimension {
    const issues: HealthIssue[] = [];

    const raw = this.db.getConfig("watcher.bulk_pending");
    if (!raw) return { name: "批量变更保护", status: "pass", issues: [] };

    try {
      const state = JSON.parse(raw) as { paused: boolean; pendingFiles: unknown[]; threshold: number; pausedAt: string };
      if (!state.paused) return { name: "批量变更保护", status: "pass", issues: [] };

      issues.push({
        severity: "medium",
        slug: "",
        title: "批量变更暂停",
        description: `watcher 因检测到 ${state.pendingFiles?.length ?? 0} 个文件变更（阈值 ${state.threshold}）已暂停同步，暂停于 ${state.pausedAt}`,
        suggestion: "使用 watcher_quarantine 工具的 bulk_resume action 恢复处理，或检查是否有意外的大量文件写入",
      });
    } catch { /* corrupt config */ }

    return {
      name: "批量变更保护",
      status: issues.length > 0 ? "warn" : "pass",
      issues,
    };
  }

  private checkConsistency(): HealthDimension {
    const issues: HealthIssue[] = [];

    const links = this.db.getAllLinks();

    const nonStandardRels = new Set<string>();
    for (const link of links) {
      if (!isValidRelation(link.relation)) {
        nonStandardRels.add(link.relation);
      }
    }

    if (nonStandardRels.size > 0) {
      issues.push({
        severity: "medium",
        slug: "-",
        title: "Non-standard relation types",
        description: `Found ${nonStandardRels.size} non-standard relation types: ${[...nonStandardRels].slice(0, 10).join(", ")}`,
        suggestion: "Run relation_audit(mode='fix', dry_run=true) to preview migration",
      });
    }

    const pagesMissingType = this.db.getPagesWithEmptyType();

    for (const p of pagesMissingType) {
      issues.push({
        severity: "high",
        slug: p.slug,
        title: p.title,
        description: "Missing type in frontmatter",
        suggestion: "Add type field to frontmatter",
      });
    }

    return {
      name: "一致性",
      status: issues.some(i => i.severity === "high") ? "fail" : issues.length > 0 ? "warn" : "pass",
      issues,
    };
  }

  private checkStructuralConsistency(): HealthDimension {
    const issues: HealthIssue[] = [];

    if (this.vaultPath) {
      this.checkLinksVsMarkdown(issues);
      this.checkWikilinksVsLinks(issues);
      this.checkReportsToConsistency(issues);
    }

    return {
      name: "结构一致性",
      status: issues.some(i => i.severity === "high") ? "fail" : issues.length > 0 ? "warn" : "pass",
      issues,
    };
  }

  private checkLinksVsMarkdown(issues: HealthIssue[]): void {
    const allLinks = this.db.getAllLinks();
    const pagesWithLinks = new Map<string, { outgoing: Map<string, string[]>; incoming: Map<string, string[]> }>();

    for (const link of allLinks.filter(isCurrentFactLink)) {
      if (!pagesWithLinks.has(link.from_slug)) {
        pagesWithLinks.set(link.from_slug, { outgoing: new Map(), incoming: new Map() });
      }
      if (!pagesWithLinks.has(link.to_slug)) {
        pagesWithLinks.set(link.to_slug, { outgoing: new Map(), incoming: new Map() });
      }

      const from = pagesWithLinks.get(link.from_slug)!;
      const targets = from.outgoing.get(link.to_slug) ?? [];
      targets.push(link.relation);
      from.outgoing.set(link.to_slug, targets);

      const to = pagesWithLinks.get(link.to_slug)!;
      const sources = to.incoming.get(link.from_slug) ?? [];
      sources.push(link.relation);
      to.incoming.set(link.from_slug, sources);
    }

    for (const [slug, { outgoing, incoming }] of pagesWithLinks) {
      const page = this.db.getPage(slug);
      if (!page?.file_path) continue;
      const filePath = join(this.vaultPath!, page.file_path);
      if (!existsSync(filePath)) continue;

      const body = readFileSync(filePath, "utf-8");
      const krMatch = body.match(/## Known Relations\n([\s\S]*?)$/);
      const krSection = krMatch?.[1] ?? "";

      let missingOutgoing = 0;
      for (const [to, rels] of outgoing) {
        for (const rel of rels) {
          const pattern = `- ${rel} → [[${to}]]`;
          if (!krSection.includes(pattern)) {
            missingOutgoing++;
          }
        }
      }
      if (missingOutgoing > 0) {
        issues.push({
          severity: "medium",
          slug,
          title: page.title ?? slug,
          description: `有 ${missingOutgoing} 条出边未写入 Known Relations 区块`,
          suggestion: `运行 syncLinksToMarkdown("${slug}") 修复`,
        });
      }

      let missingIncoming = 0;
      for (const [from, rels] of incoming) {
        for (const rel of rels) {
          const pattern = `- ← ${rel} from [[${from}]]`;
          if (!krSection.includes(pattern)) {
            missingIncoming++;
          }
        }
      }
      if (missingIncoming > 0) {
        issues.push({
          severity: "medium",
          slug,
          title: page.title ?? slug,
          description: `有 ${missingIncoming} 条入边未写入 Known Relations 区块`,
          suggestion: `运行 syncLinksToMarkdown("${slug}") 修复`,
        });
      }
    }
  }

  private checkWikilinksVsLinks(issues: HealthIssue[]): void {
    const pages = this.db.listPages({ limit: 10000, offset: 0 });
    for (const row of pages) {
      if (!row.file_path) continue;
      const filePath = join(this.vaultPath!, row.file_path);
      if (!existsSync(filePath)) continue;

      const body = readFileSync(filePath, "utf-8");
      const stripped = stripKnownRelationsSection(body);
      const wikilinks = extractWikiLinks(stripped);

      const outgoingSlugs = new Set(this.db.getOutgoingSlugs(row.slug));
      const missingTargets: string[] = [];

      for (const link of wikilinks) {
        // Same resolution logic as processWikilinks
        let lookupName = link.target;
        if (link.target.includes("/")) {
          lookupName = link.target.split("/").pop()!;
        }
        const targetName = link.display ?? lookupName;
        if (!isValidEntityName(targetName)) continue;

        const resolvedSlug = findEntitySlug(this.db, lookupName);
        if (!resolvedSlug) continue; // Unresolvable — not a graph inconsistency
        if (resolvedSlug === row.slug) continue; // Self-reference

        if (!outgoingSlugs.has(resolvedSlug)) {
          missingTargets.push(link.target);
        }
      }

      if (missingTargets.length > 0) {
        issues.push({
          severity: "low",
          slug: row.slug,
          title: row.title ?? row.slug,
          description: `正文提及 ${missingTargets.map(t => `[[${t}]]`).join("、")} 但 links 表无边`,
          suggestion: "运行 processWikilinks 或 put_page 重新索引",
        });
      }
    }
  }

  private checkReportsToConsistency(issues: HealthIssue[]): void {
    const pages = this.db.listPages({ limit: 10000, offset: 0 });

    for (const page of pages) {
      if (!page.file_path) continue;
      const filePath = join(this.vaultPath!, page.file_path);
      if (!existsSync(filePath)) continue;

      let fm: Record<string, unknown>;
      try {
        const raw = readFileSync(filePath, "utf-8");
        const parsed = parseFrontmatter(raw);
        fm = parsed.frontmatter as Record<string, unknown>;
      } catch {
        continue;
      }

      const reportsTo = fm.reports_to;
      if (typeof reportsTo !== "string" || !reportsTo) continue;

      if (!reportsTo.includes("/")) {
        issues.push({
          severity: "high",
          slug: page.slug,
          title: page.title,
          description: `reports_to 值 "${reportsTo}" 不是完整 slug（应为 entity/xxx 格式）`,
          suggestion: `更新 reports_to 为完整 slug，如 "entity/${reportsTo}"`,
        });
        continue;
      }

      // Phase 1 #233 (HIGH 2): only a current (authoritative) edge satisfies
      // consistency — superseded/rejected/candidate edges are evidence, not a
      // live graph edge for the frontmatter's current reports_to.
      const hasEdge = this.db.rawDb.prepare(
        "SELECT 1 FROM links WHERE from_slug = ? AND to_slug = ? AND relation = 'reports_to' AND (trust_state IS NULL OR trust_state IN ('trusted','user_thought')) LIMIT 1"
      ).get(page.slug, reportsTo);

      if (!hasEdge) {
        issues.push({
          severity: "high",
          slug: page.slug,
          title: page.title,
          description: `reports_to=${reportsTo} 缺少对应图边`,
          suggestion: `运行 setHierarchy("${page.slug}", "${reportsTo}") 建立图边`,
        });
      }
    }
  }

  private checkCompleteness(): HealthDimension {
    const issues: HealthIssue[] = [];

    const bareStubs = this.db.getBareStubs();

    for (const stub of bareStubs) {
      issues.push({
        severity: "low",
        slug: stub.slug,
        title: stub.title,
        description: `Bare ${stub.type} stub with minimal content`,
        suggestion: "Enrich with more context or merge into related page",
      });
    }

    return {
      name: "完整性",
      status: bareStubs.length > 20 ? "fail" : bareStubs.length > 0 ? "warn" : "pass",
      issues,
    };
  }

  private checkIslands(): HealthDimension {
    const issues: HealthIssue[] = [];

    const islands = this.db.getIslandPages();

    for (const island of islands) {
      issues.push({
        severity: "medium",
        slug: island.slug,
        title: island.title,
        description: `Disconnected ${island.type} — no links in or out`,
        suggestion: "Add links to related pages or verify relevance",
      });
    }

    return {
      name: "孤岛检测",
      status: islands.length > 10 ? "warn" : "pass",
      issues,
    };
  }

  private checkNewSuggestions(): HealthDimension {
    const issues: HealthIssue[] = [];

    const sourceCount = this.db.getPageCountByType("record");
    const conceptCount = this.db.getPageCountByTypePrefix("concept/");

    const ratio = sourceCount > 0 ? conceptCount / sourceCount : 0;

    if (ratio > 5) {
      issues.push({
        severity: "high",
        slug: "-",
        title: "Concept inflation",
        description: `${conceptCount} concepts from ${sourceCount} sources (ratio: ${ratio.toFixed(1)}:1). Threshold is ~3:1.`,
        suggestion: "Review and prune low-value concepts. Focus on named frameworks and methodologies.",
      });
    } else if (ratio > 3) {
      issues.push({
        severity: "medium",
        slug: "-",
        title: "High concept ratio",
        description: `${conceptCount} concepts from ${sourceCount} sources (ratio: ${ratio.toFixed(1)}:1).`,
        suggestion: "Consider reviewing concepts for relevance.",
      });
    }

    return {
      name: "新增建议",
      status: issues.some(i => i.severity === "high") ? "warn" : "pass",
      issues,
    };
  }

  private checkAttention(): HealthDimension {
    const issues: HealthIssue[] = [];

    const stale = this.db.getStaleHighValuePages(30);

    for (const page of stale) {
      issues.push({
        severity: "low",
        slug: page.slug,
        title: page.title,
        description: `Tier ${page.type} page not updated since ${page.updated_at}`,
        suggestion: "Review and update if needed",
      });
    }

    const popularThin = this.db.getPopularThinPages(3);

    for (const page of popularThin) {
      const chunkCount = this.db.getChunkCountByPage(page.slug);

      if (chunkCount <= 1) {
        issues.push({
          severity: "medium",
          slug: page.slug,
          title: page.title,
          description: `Highly mentioned (${page.mention_count}x) but thin content (${chunkCount} chunk)`,
          suggestion: "Enrich this popular page with more content",
        });
      }
    }

    return {
      name: "关注度分析",
      status: issues.some(i => i.severity === "high") ? "warn" : issues.length > 5 ? "warn" : "pass",
      issues,
    };
  }

  private checkDataReadiness(): HealthDimension {
    const issues: HealthIssue[] = [];

    const totalPages = this.db.getPageCount();
    if (totalPages < 10) {
      issues.push({
        severity: "high",
        slug: "-",
        title: "Insufficient data",
        description: `Only ${totalPages} pages indexed. Need at least 10 for meaningful knowledge retrieval.`,
        suggestion: "Ingest more content before expecting quality results. Use `cbrain ingest` or `cbrain sync`.",
      });
    }

    const entityCount = this.db.getPageCountByTypePrefix("entity/");
    if (entityCount < 3 && totalPages >= 10) {
      issues.push({
        severity: "medium",
        slug: "-",
        title: "Few entities",
        description: `Only ${entityCount} entities from ${totalPages} pages. NER may not be extracting enough.`,
        suggestion: "Check NER configuration and run `cbrain sync` with NER enabled.",
      });
    }

    const linkCount = this.db.getLinkCount();
    if (linkCount < 5 && totalPages >= 10) {
      issues.push({
        severity: "medium",
        slug: "-",
        title: "Sparse graph",
        description: `Only ${linkCount} links between ${totalPages} pages. Knowledge graph is under-connected.`,
        suggestion: "Run `cbrain enrich` to extract more relations, or ingest richer source material.",
      });
    }

    return {
      name: "数据就绪度",
      status: issues.some(i => i.severity === "high") ? "fail" : issues.length > 0 ? "warn" : "pass",
      issues,
    };
  }

  private checkSourceQuality(): HealthDimension {
    const issues: HealthIssue[] = [];

    const thinPages = this.db.getPagesWithoutChunks();

    for (const page of thinPages) {
      issues.push({
        severity: "medium",
        slug: page.slug,
        title: page.title,
        description: `${page.type} page has no indexed content chunks`,
        suggestion: "Re-sync this page or check source file",
      });
    }

    const missingTitle = this.db.getPagesWithMissingTitle();

    for (const page of missingTitle) {
      issues.push({
        severity: "low",
        slug: page.slug,
        title: page.title,
        description: "Page has no meaningful title (falls back to slug)",
        suggestion: "Add a descriptive title in frontmatter",
      });
    }

    return {
      name: "原材料质量",
      status: thinPages.length > 10 ? "warn" : "pass",
      issues,
    };
  }

  private checkStaleContent(): HealthDimension {
    const issues: HealthIssue[] = [];
    const now = new Date().toISOString();

    // Expired pages
    const expired = this.db.getExpiredPages(now);
    for (const page of expired) {
      issues.push({
        severity: "high",
        slug: page.slug,
        title: page.title,
        description: `内容已过期 (expires_at: ${page.expires_at})`,
        suggestion: "确认此信息是否仍有效，或更新 expires_at",
      });
    }

    // Low confidence decay pages
    const decayed = this.db.getLowConfidenceDecayPages(0.3);
    for (const page of decayed) {
      if (expired.some(e => e.slug === page.slug)) continue;
      issues.push({
        severity: "medium",
        slug: page.slug,
        title: page.title,
        description: `置信度衰减至 ${page.confidence_decay}，可能已过时`,
        suggestion: "确认此信息是否仍准确",
      });
    }

    return {
      name: "时效性",
      status: issues.length > 5 ? "warn" : issues.length > 0 ? "warn" : "pass",
      issues,
    };
  }

  private checkContradictions(): HealthDimension {
    const issues: HealthIssue[] = [];

    const entities = this.db.getEntityConceptPages();
    for (const entity of entities) {
      const incoming = this.db.getIncomingLinks(entity.slug);
      const recordSources = incoming.filter(l => l.from_slug.startsWith("records/") && l.context);
      if (recordSources.length < 2) continue;

      const contexts = recordSources.map(l => l.context!);
      const pairs: Array<{ i: number; j: number; verdict: ContextVerdict }> = [];

      for (let i = 0; i < contexts.length; i++) {
        for (let j = i + 1; j < contexts.length; j++) {
          pairs.push({ i, j, verdict: classifyContextPair(contexts[i], contexts[j]) });
        }
      }

      for (const pair of pairs) {
        if (pair.verdict !== "conflict") continue;
        issues.push({
          severity: "medium",
          slug: entity.slug,
          title: entity.title,
          description: `来自不同来源的信息存在矛盾：${recordSources[pair.i].from_slug} vs ${recordSources[pair.j].from_slug}`,
          suggestion: "人工核实两个来源的信息是否一致",
        });
      }
    }

    return {
      name: "矛盾检测",
      status: issues.length > 0 ? "warn" : "pass",
      issues,
    };
  }

  // ─── Metrics ───────────────────────────────────────────────

  private collectMetrics(): MetricsSnapshot {
    const totalPages = this.db.getPageCount();
    const entities = this.db.getPageCountByTypePrefix("entity/");
    const concepts = this.db.getPageCountByTypePrefix("concept/");
    const events = 0; // deprecated: event type no longer used
    const records = this.db.getPageCountByType("record");
    const totalLinks = this.db.getLinkCount();
    const avgMentions = this.db.getAvgMentionCount();

    const orphans = this.db.getIslandPages().length;
    const bareStubs = this.db.getBareStubs().length;

    const conceptsPerSource = records > 0 ? concepts / records : 0;

    return {
      timestamp: new Date().toISOString(),
      totalPages,
      entities,
      concepts,
      events,
      records,
      totalLinks,
      avgMentionsPerPage: avgMentions,
      orphans,
      bareStubs,
      conceptsPerSource,
      indexSizeKB: 0,
    };
  }

  // ─── Dimension 15: Search Quality ─────────────────────────

  private checkSearchQuality(): HealthDimension {
    const stats = this.db.getSearchQualityStats(7);
    const issues: HealthIssue[] = [];

    if (stats.totalSearches === 0) {
      return { name: "搜索质量", status: "pass", issues: [] };
    }

    // Degraded rate > 20%
    if (stats.degradedRate > 0.2) {
      issues.push({
        severity: "medium",
        slug: "-",
        title: `${(stats.degradedRate * 100).toFixed(0)}% 搜索降级率`,
        description: `最近 ${stats.periodDays} 天 ${stats.totalSearches} 次搜索中 ${stats.degradedCount} 次降级`,
        suggestion: "检查 embedding 服务延迟和 FTS 索引覆盖率",
      });
    }

    // Latency warning is separate from retrieval degradation (#250). Slow but
    // successful searches are an observability signal, not a recall-quality
    // failure.
    if (stats.latencyWarningRate > 0.2) {
      issues.push({
        severity: "low",
        slug: "-",
        title: `${(stats.latencyWarningRate * 100).toFixed(0)}% 搜索慢查询提示`,
        description: `最近 ${stats.periodDays} 天 ${stats.totalSearches} 次搜索中 ${stats.latencyWarningCount} 次超过延迟预算但不一定降级`,
        suggestion: "检查 search trace 中 LLM、rerank、vector 阶段耗时",
      });
    }

    // Hierarchy routing mismatches
    if (stats.hierarchyMismatchCount > 0) {
      issues.push({
        severity: "low",
        slug: "-",
        title: `${stats.hierarchyMismatchCount} 次组织架构路由偏差`,
        description: "组织层级查询走了语义搜索而非 get_org_tree",
        suggestion: "检查 RESOLVER.md 层级关键词覆盖，补充缺失关键词",
      });
    }

    // Empty result rate > 30% (with 10+ searches)
    if (stats.totalSearches >= 10 && stats.emptyResultCount / stats.totalSearches > 0.3) {
      issues.push({
        severity: "high",
        slug: "-",
        title: `${(stats.emptyResultCount / stats.totalSearches * 100).toFixed(0)}% 搜索无结果`,
        description: `最近 ${stats.periodDays} 天 ${stats.emptyResultCount}/${stats.totalSearches} 次搜索无结果`,
        suggestion: "检查 FTS 索引、embedding 模型、vault 内容量",
      });
    }

    // Top reason codes as informational
    for (const top of stats.topReasonCodes.slice(0, 3)) {
      issues.push({
        severity: "low",
        slug: "-",
        title: `频繁降级原因: ${top.code}`,
        description: `出现 ${top.count} 次`,
      });
    }
    for (const top of stats.topLatencyWarningCodes.slice(0, 3)) {
      issues.push({
        severity: "low",
        slug: "-",
        title: `频繁慢查询原因: ${top.code}`,
        description: `出现 ${top.count} 次`,
      });
    }

    const status = issues.some(i => i.severity === "high") ? "fail"
      : issues.some(i => i.severity === "medium") ? "warn" : "pass";

    return { name: "搜索质量", status, issues };
  }

  // ─── Dimension: NER Quality (observe-only, #167 Phase 1) ────

  private checkNerQuality(): HealthDimension {
    const stats = this.db.getNerQualityStats(7);
    const issues: HealthIssue[] = [];

    if (stats.runs === 0) {
      return { name: "NER 质量", status: "pass", issues: [] };
    }

    const kept = stats.extractedEntities + stats.extractedConcepts;

    if (stats.filteredRate > 0.6) {
      issues.push({
        severity: "medium",
        slug: "-",
        title: `${(stats.filteredRate * 100).toFixed(0)}% 抽取结果被过滤`,
        description: `最近 ${stats.periodDays} 天 ${stats.runs} 次 NER：保留 ${kept} 个、过滤 ${stats.filteredTotal} 个`,
        suggestion: "观察 NER 是否抽到过多噪声词（observe-only，未自动调整）",
      });
    }

    if (stats.duplicateRate > 0.4) {
      issues.push({
        severity: "medium",
        slug: "-",
        title: `${(stats.duplicateRate * 100).toFixed(0)}% 候选触发类型门控冲突`,
        description: `${stats.duplicateCandidate} 个候选因类型不匹配被标为 duplicate_candidate`,
        suggestion: "检查实体类型一致性（observe-only，未自动调整）",
      });
    }

    if (stats.stubRate > 0.5) {
      issues.push({
        severity: "low",
        slug: "-",
        title: `${(stats.stubRate * 100).toFixed(0)}% 候选新建为 stub`,
        description: `${stats.stubCreated} 个候选未匹配已有实体，直接新建 stub`,
      });
    }

    for (const top of stats.topFilterReasons.slice(0, 3)) {
      issues.push({
        severity: "low",
        slug: "-",
        title: `主要过滤原因: ${top.reason}`,
        description: `出现 ${top.count} 次`,
      });
    }

    const status = issues.some((i) => i.severity === "medium") ? "warn" : "pass";
    return { name: "NER 质量", status, issues };
  }

  // ─── Dimension: Shadow Verifier Quality (observe-only, #265) ──

  private checkVerifierQuality(): HealthDimension {
    const c = this.db.getRecentVerifierCounts(24);
    const nerErr = c.ner.error;
    const nerWarn = c.ner.warning;
    const discErr = c.discovery.error;
    const discWarn = c.discovery.warning;
    const issues: HealthIssue[] = [];

    const topReasons = (prefix: string): string => {
      const entries = Object.entries(c.byCode)
        .filter(([code]) => code.startsWith(prefix))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([code, n]) => `${code}×${n}`);
      return entries.length > 0 ? entries.join(", ") : "无";
    };

    if (nerErr > 0 || nerWarn > 0) {
      issues.push({
        severity: nerErr > 0 ? "high" : "medium",
        slug: "verifier:ner",
        title: `影子校验：最近 24h NER 抽取存在 ${nerErr} 处 error / ${nerWarn} 处 warning 生成质量风险`,
        description: `主要 reason: ${topReasons("ner_")}。详见 ingest_log（source_type=verifier）。`,
        suggestion: "观察 NER 抽取质量趋势（observe-only，未自动调整，不影响已写入记忆）",
      });
    }
    if (discErr > 0 || discWarn > 0) {
      issues.push({
        severity: "medium",
        slug: "verifier:discovery",
        title: `影子校验：最近 24h Discovery 存在 ${discErr} 处 error / ${discWarn} 处 warning 生成质量风险`,
        description: `主要 reason: ${topReasons("discovery_")}。详见 ingest_log（source_type=verifier）。`,
        suggestion: "观察 Discovery 候选质量趋势（observe-only，未自动调整，不影响已写入发现）",
      });
    }

    const hasError = nerErr > 0;
    const hasWarning = nerWarn > 0 || discErr > 0 || discWarn > 0;
    const status: "pass" | "warn" | "fail" = hasError ? "fail" : hasWarning ? "warn" : "pass";
    return { name: "生成质量影子校验", status, issues };
  }
}

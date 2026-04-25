import { mkdirSync, appendFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

export interface AuditEntry {
  timestamp: string;
  operation: string;
  pageSlug?: string;
  details?: Record<string, unknown>;
  status: "success" | "error" | "warning";
  durationMs?: number;
}

export interface MetricsSnapshot {
  timestamp: string;
  totalPages: number;
  entities: number;
  concepts: number;
  events: number;
  records: number;
  sources: number;
  totalLinks: number;
  avgMentionsPerPage: number;
  orphans: number;
  bareStubs: number;
  conceptsPerSource: number;
  indexSizeKB: number;
}

export class AuditLogger {
  private logDir: string;
  private metricsDir: string;

  constructor(outputsDir: string) {
    this.logDir = join(outputsDir, "logs");
    this.metricsDir = join(outputsDir, "metrics");
    mkdirSync(this.logDir, { recursive: true });
    mkdirSync(this.metricsDir, { recursive: true });
  }

  /**
   * Append an operation entry to the log file.
   * One file per day: log-YYYY-MM-DD.md
   */
  log(entry: AuditEntry): void {
    const date = entry.timestamp.slice(0, 10);
    const logFile = join(this.logDir, `操作日志-${date}.md`);

    const header = `# 操作日志 — ${date}\n\n| 时间 | 操作 | 页面 | 状态 | 耗时 | 详情 |\n|------|------|------|------|------|------|\n`;
    if (!existsSync(logFile)) {
      writeFileSync(logFile, header, "utf-8");
    }

    const time = entry.timestamp.slice(11, 19);
    const slug = entry.pageSlug ?? "-";
    const dur = entry.durationMs ? `${entry.durationMs}ms` : "-";
    const details = entry.details
      ? Object.entries(entry.details)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")
      : "-";

    const row = `| ${time} | ${entry.operation} | ${slug} | ${entry.status} | ${dur} | ${details} |\n`;
    appendFileSync(logFile, row, "utf-8");
  }

  /**
   * Write a metrics snapshot.
   * One file per day, append mode: metrics-YYYY-MM-DD.md
   */
  writeMetrics(snapshot: MetricsSnapshot): void {
    const date = snapshot.timestamp.slice(0, 10);
    const metricsFile = join(this.metricsDir, `指标快照-${date}.md`);

    const header = `# 指标快照 — ${date}\n\n| 时间 | 总页面 | 实体 | 概念 | 事件 | 记录 | 来源 | 链接 | 平均提及 | 孤岛 | 空壳 | 概念/来源比 | 索引(KB) |\n|------|--------|------|------|------|------|------|------|----------|------|------|------------|----------|\n`;
    if (!existsSync(metricsFile)) {
      writeFileSync(metricsFile, header, "utf-8");
    }

    const time = snapshot.timestamp.slice(11, 19);
    const row = `| ${time} | ${snapshot.totalPages} | ${snapshot.entities} | ${snapshot.concepts} | ${snapshot.events} | ${snapshot.records} | ${snapshot.sources} | ${snapshot.totalLinks} | ${snapshot.avgMentionsPerPage.toFixed(1)} | ${snapshot.orphans} | ${snapshot.bareStubs} | ${snapshot.conceptsPerSource.toFixed(2)} | ${snapshot.indexSizeKB} |\n`;
    appendFileSync(metricsFile, row, "utf-8");
  }

  /**
   * Helper: create an AuditEntry from the current moment.
   */
  static entry(
    operation: string,
    status: AuditEntry["status"],
    opts?: { pageSlug?: string; details?: Record<string, unknown>; durationMs?: number }
  ): AuditEntry {
    return {
      timestamp: new Date().toISOString(),
      operation,
      status,
      ...opts,
    };
  }
}

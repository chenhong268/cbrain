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

// No-op — audit logging disabled. Logs were write-only noise.
// When debugging, use Logger (warn/error only, persisted to system log).
export class AuditLogger {
  constructor(_outputsDir?: string) {}

  log(_entry: AuditEntry): void {}
  writeMetrics(_snapshot: MetricsSnapshot): void {}

  static entry(
    operation: string,
    status: AuditEntry["status"],
    opts?: { pageSlug?: string; details?: Record<string, unknown>; durationMs?: number }
  ): AuditEntry {
    return { timestamp: new Date().toISOString(), operation, status, ...opts };
  }
}

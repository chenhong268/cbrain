/**
 * Trace-based slow-journey diagnostics (#189) — diagnosis, not optimization.
 *
 * Reads existing telemetry (search_trace_sessions/steps, query_log, search_log),
 * aggregates latency/budget by SAFE dimensions only, and reports which journey
 * category is slow and which internal step kind dominates — without ever exposing
 * raw query text, slugs, paths, input_json, output_summary, SQL, or credentials.
 *
 * The aggregation (diagnose) + formatters are pure and unit-testable. The read
 * function takes a bun:sqlite handle (opened READ-ONLY by the CLI) and selects
 * only safe columns. Missing optional tables degrade to a sanitized warning.
 */
import type { Database } from "bun:sqlite";
import { ALL_DEGRADED_REASON_CODES, WARNING_REASON_CODES, type DegradedReasonCode } from "../core/search-diagnostics.js";

// ── Safe row shapes (only the columns we are allowed to read/report) ──

export interface SessionRow {
  readonly id: number;
  readonly started_at: string;
  readonly mode: string;
  readonly intent: string | null;
  readonly status: string;
  readonly latency_ms: number;
  readonly total_steps: number;
  readonly llm_calls: number;
  /** Categorical degraded-reason codes extracted from summary_json (sanitized; raw summary never retained). */
  readonly reason_codes: string[];
}

export interface StepRow {
  readonly session_id: number;
  readonly kind: string;
  readonly latency_ms: number;
}

export interface QueryLogRow {
  readonly tool: string;
  readonly latency_ms: number;
  readonly created_at: string;
}

export interface SearchLogRow {
  readonly strategy: string;
  readonly latency_ms: number;
  readonly degraded: number;
  readonly created_at: string;
}

export interface DiagnosticSnapshot {
  readonly sessions: SessionRow[];
  readonly steps: StepRow[];
  readonly queryLogs: QueryLogRow[];
  readonly searchLogs: SearchLogRow[];
  readonly tables: { sessions: boolean; steps: boolean; queryLog: boolean; searchLog: boolean };
  readonly warnings: string[];
}

// ── Report types ──

export interface DiagnoseOptions {
  readonly minLatencyMs: number;
  readonly limit: number;
}

export interface WindowOpts {
  readonly days: number;
  readonly min_latency_ms: number;
  readonly limit: number;
}

export interface DimAggregate {
  readonly dimension: string;
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly degraded_rate: number;
}

export interface ReasonAggregate {
  readonly reason: string;
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

export interface SlowSession {
  readonly id: number;
  readonly started_at: string;
  readonly mode: string;
  readonly intent: string | null;
  readonly status: string;
  readonly latency_ms: number;
  readonly total_steps: number;
  readonly llm_calls: number;
  readonly slowest_step_kind: string | null;
}

export interface StepKindStat {
  readonly kind: string;
  readonly count: number;
  readonly avg_latency_ms: number;
}

export interface PerfDiagnoseReport {
  readonly generated_at: string;
  readonly window: WindowOpts;
  readonly tables: DiagnosticSnapshot["tables"];
  readonly warnings: string[];
  readonly summary: {
    readonly session_count: number;
    readonly slow_count: number;
    readonly degraded_rate: number;
    readonly latency_warning_rate: number;
    readonly latency: { readonly p50: number; readonly p95: number; readonly max: number } | null;
    readonly avg_total_steps: number;
    readonly avg_llm_calls: number;
  };
  readonly by_mode: DimAggregate[];
  readonly by_intent: DimAggregate[];
  readonly by_status: DimAggregate[];
  readonly by_degraded_reason: ReasonAggregate[];
  readonly by_latency_warning_reason: ReasonAggregate[];
  readonly slowest_step_kinds: StepKindStat[];
  readonly slow_sessions: SlowSession[];
  readonly by_tool?: DimAggregate[];
  readonly by_strategy?: DimAggregate[];
}

// ── Pure helpers ──

/** Nearest-rank percentile over an ASC-sorted sample. Empty -> 0. */
export function percentile(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  const rank = Math.ceil((p / 100) * n);
  const idx = Math.min(Math.max(rank - 1, 0), n - 1);
  return sortedAsc[idx];
}

/** Centralized dimension sanitizer: redact path-like values, cap length. */
export function sanitizeDim(value: string | null): string {
  if (value == null) return "<null>";
  const cleaned = value.replace(/\/[^\s"']+/g, "<path>");
  return cleaned.length > 64 ? cleaned.slice(0, 64) : cleaned;
}

/**
 * Extract ONLY categorical degraded-reason codes from a session's summary_json.
 * The raw summary is parsed and discarded. A value is kept ONLY if it is a known
 * CBrain reason code (ALL_DEGRADED_REASON_CODES) — arbitrary/unknown strings
 * (secrets, private judgments, paths) are dropped entirely, never "sanitized"
 * into the report (#189).
 */
export function extractReasonCodes(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const codes = new Set<string>();
    const keep = (c: unknown): void => {
      if (typeof c === "string" && ALL_DEGRADED_REASON_CODES.has(c as DegradedReasonCode)) codes.add(c);
    };
    const rc = obj["reason_codes"];
    if (Array.isArray(rc)) for (const c of rc) keep(c);
    keep(obj["degraded_reason"]);
    return [...codes];
  } catch {
    return [];
  }
}

function aggregateBy<T>(
  rows: ReadonlyArray<T>,
  keyFn: (r: T) => string,
  latencyFn: (r: T) => number,
  degradedFn: (r: T) => boolean,
): DimAggregate[] {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const key = sanitizeDim(keyFn(r));
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  const out: DimAggregate[] = [];
  for (const [dimension, rs] of groups) {
    const lats = rs.map(latencyFn).sort((a, b) => a - b);
    const degraded = rs.filter(degradedFn).length;
    out.push({
      dimension,
      count: rs.length,
      p50: percentile(lats, 50),
      p95: percentile(lats, 95),
      max: lats.length ? lats[lats.length - 1] : 0,
      degraded_rate: rs.length ? degraded / rs.length : 0,
    });
  }
  return out.sort((a, b) => b.count - a.count);
}

/** Raw kind of the highest-latency step in a session (or null). */
function slowestKindRaw(steps?: ReadonlyArray<StepRow>): string | null {
  if (!steps || steps.length === 0) return null;
  let best = steps[0];
  for (const s of steps) if ((s.latency_ms ?? 0) > (best.latency_ms ?? 0)) best = s;
  return best.kind;
}

/** Pure aggregation. No I/O, no Date. */
export function diagnose(snapshot: DiagnosticSnapshot, opts: DiagnoseOptions): PerfDiagnoseReport {
  const sessions = snapshot.sessions;

  const slowAll = sessions.filter((s) => s.latency_ms >= opts.minLatencyMs);
  const slowSorted = [...slowAll].sort((a, b) => b.latency_ms - a.latency_ms);
  const slowCapped = slowSorted.slice(0, opts.limit);

  const stepsBySession = new Map<number, StepRow[]>();
  for (const st of snapshot.steps) {
    const list = stepsBySession.get(st.session_id) ?? [];
    list.push(st);
    stepsBySession.set(st.session_id, list);
  }

  const slowSessions: SlowSession[] = slowCapped.map((s) => ({
    id: s.id,
    started_at: s.started_at,
    mode: sanitizeDim(s.mode),
    intent: s.intent ? sanitizeDim(s.intent) : null,
    status: sanitizeDim(s.status),
    latency_ms: s.latency_ms,
    total_steps: s.total_steps,
    llm_calls: s.llm_calls,
    slowest_step_kind: (() => {
      const k = slowestKindRaw(stepsBySession.get(s.id));
      return k ? sanitizeDim(k) : null;
    })(),
  }));

  const slowLats = slowAll.map((s) => s.latency_ms).sort((a, b) => a - b);
  // #250 — latency_warning sessions: UNION by session id (not Math.max of counts,
  // which mis-counts when the two sources cover different sessions). Dual source:
  // (a) reason_codes carries a warning code; (b) latency_ms > 2000 AND not degraded.
  const latencyWarningIds = new Set<number>();
  for (const s of sessions) {
    const codeWarn = s.reason_codes.some((c) => WARNING_REASON_CODES.has(c as DegradedReasonCode));
    const latencyWarn = s.latency_ms != null && s.latency_ms > 2000 && s.status !== "degraded";
    if (codeWarn || latencyWarn) latencyWarningIds.add(s.id);
  }
  const summary: PerfDiagnoseReport["summary"] = {
    session_count: sessions.length,
    slow_count: slowAll.length,
    degraded_rate: sessions.length ? sessions.filter((s) => s.status === "degraded").length / sessions.length : 0,
    latency_warning_rate: sessions.length ? latencyWarningIds.size / sessions.length : 0,
    latency: slowLats.length
      ? { p50: percentile(slowLats, 50), p95: percentile(slowLats, 95), max: slowLats[slowLats.length - 1] }
      : null,
    avg_total_steps: slowAll.length ? slowAll.reduce((a, s) => a + s.total_steps, 0) / slowAll.length : 0,
    avg_llm_calls: slowAll.length ? slowAll.reduce((a, s) => a + s.llm_calls, 0) / slowAll.length : 0,
  };

  // Slowest-step-kind ranking across ALL slow sessions.
  const kindStats = new Map<string, { count: number; sum: number }>();
  for (const s of slowAll) {
    const rawKind = slowestKindRaw(stepsBySession.get(s.id));
    if (!rawKind) continue;
    const step = stepsBySession.get(s.id)?.find((st) => st.kind === rawKind);
    const cur = kindStats.get(rawKind) ?? { count: 0, sum: 0 };
    cur.count += 1;
    cur.sum += step?.latency_ms ?? 0;
    kindStats.set(rawKind, cur);
  }
  const slowest_step_kinds: StepKindStat[] = [...kindStats.entries()]
    .map(([kind, v]) => ({ kind: sanitizeDim(kind), count: v.count, avg_latency_ms: v.count ? v.sum / v.count : 0 }))
    .sort((a, b) => b.count - a.count);

  // #250 — split: retrieval-degraded reasons vs latency/parser warnings. Synthesize
  // latency_budget_exceeded for slow-but-ok sessions missing the code so
  // by_latency_warning_reason never undercounts.
  const degradedReasonLat = new Map<string, number[]>();
  const warningReasonLat = new Map<string, number[]>();
  for (const s of sessions) {
    for (const code of s.reason_codes) {
      const target = WARNING_REASON_CODES.has(code as DegradedReasonCode) ? warningReasonLat : degradedReasonLat;
      const arr = target.get(code) ?? [];
      arr.push(s.latency_ms);
      target.set(code, arr);
    }
    if (s.latency_ms != null && s.latency_ms > 2000 && s.status !== "degraded" && !s.reason_codes.includes("latency_budget_exceeded")) {
      const arr = warningReasonLat.get("latency_budget_exceeded") ?? [];
      arr.push(s.latency_ms);
      warningReasonLat.set("latency_budget_exceeded", arr);
    }
  }
  const aggReason = (map: Map<string, number[]>): ReasonAggregate[] => [...map.entries()]
    .map(([reason, lats]) => {
      const sorted = [...lats].sort((a, b) => a - b);
      return { reason, count: lats.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), max: sorted[sorted.length - 1] };
    })
    .sort((a, b) => b.count - a.count);
  const by_degraded_reason: ReasonAggregate[] = aggReason(degradedReasonLat);
  const by_latency_warning_reason: ReasonAggregate[] = aggReason(warningReasonLat);

  return {
    generated_at: "",
    window: { days: 0, min_latency_ms: opts.minLatencyMs, limit: opts.limit },
    tables: snapshot.tables,
    warnings: snapshot.warnings,
    summary,
    by_mode: aggregateBy(sessions, (s) => s.mode, (s) => s.latency_ms, (s) => s.status === "degraded"),
    by_intent: aggregateBy(sessions, (s) => s.intent ?? "<null>", (s) => s.latency_ms, (s) => s.status === "degraded"),
    by_status: aggregateBy(sessions, (s) => s.status, (s) => s.latency_ms, () => false),
    by_degraded_reason,
    by_latency_warning_reason,
    slowest_step_kinds,
    slow_sessions: slowSessions,
    by_tool: snapshot.queryLogs.length
      ? aggregateBy(snapshot.queryLogs, (q) => q.tool, (q) => q.latency_ms, () => false)
      : undefined,
    by_strategy: snapshot.searchLogs.length
      ? aggregateBy(snapshot.searchLogs, (q) => q.strategy, (q) => q.latency_ms, (q) => q.degraded === 1)
      : undefined,
  };
}

export function formatJson(report: PerfDiagnoseReport, window: WindowOpts): string {
  const full = { ...report, generated_at: new Date().toISOString(), window };
  return JSON.stringify(full, null, 2);
}

export function formatHuman(report: PerfDiagnoseReport, window?: WindowOpts): string {
  const w = window ?? report.window;
  const L: string[] = [];
  L.push("╔══ CBrain perf-diagnose ══╗");
  L.push(`  sessions:  ${report.summary.session_count} total, ${report.summary.slow_count} slow (>= ${w.min_latency_ms}ms)`);
  L.push(`  degraded:  ${(report.summary.degraded_rate * 100).toFixed(1)}%`);
  if (report.summary.latency) {
    const la = report.summary.latency;
    L.push(`  latency:   p50 ${la.p50}ms / p95 ${la.p95}ms / max ${la.max}ms`);
  } else {
    L.push("  latency:   (no slow sessions in window)");
  }
  L.push(`  avg steps: ${report.summary.avg_total_steps.toFixed(1)} / avg llm calls: ${report.summary.avg_llm_calls.toFixed(1)}`);

  if (report.by_mode.length) {
    L.push("  by mode:");
    for (const a of report.by_mode.slice(0, 8)) {
      L.push(`    ${a.dimension}: ${a.count}x (p50 ${a.p50}ms, p95 ${a.p95}ms, max ${a.max}ms, degraded ${(a.degraded_rate * 100).toFixed(0)}%)`);
    }
  }
  if (report.by_degraded_reason.length) {
    L.push("  degraded reasons:");
    for (const r of report.by_degraded_reason.slice(0, 8)) {
      L.push(`    ${r.reason}: ${r.count}x (p50 ${r.p50}ms, p95 ${r.p95}ms, max ${r.max}ms)`);
    }
  }
  if (report.slowest_step_kinds.length) {
    L.push("  slowest step kinds:");
    for (const k of report.slowest_step_kinds.slice(0, 8)) {
      L.push(`    ${k.kind}: ${k.count}x, avg ${Math.round(k.avg_latency_ms)}ms`);
    }
  }
  if (report.slow_sessions.length) {
    L.push(`  slow sessions (top ${report.slow_sessions.length}):`);
    for (const s of report.slow_sessions) {
      L.push(`    #${s.id} ${s.mode}/${s.intent ?? "-"} ${s.status} ${s.latency_ms}ms steps=${s.total_steps} llm=${s.llm_calls} slowest=${s.slowest_step_kind ?? "-"}`);
    }
  }
  for (const w of report.warnings) L.push(`  ⚠ ${w}`);
  L.push("╚══════════════════════════╝");
  return L.join("\n");
}

// ── Read-only telemetry snapshot ──

export interface ReadOpts {
  readonly cutoffIso: string;
  readonly minLatencyMs: number;
  readonly limit: number;
}

function readTable<T>(
  label: string,
  flag: "sessions" | "steps" | "queryLog" | "searchLog",
  tables: { sessions: boolean; steps: boolean; queryLog: boolean; searchLog: boolean },
  warnings: string[],
  run: () => T[],
): T[] {
  try {
    return run();
  } catch {
    tables[flag] = false;
    warnings.push(`telemetry '${label}' unavailable`);
    return [];
  }
}

/**
 * Read a privacy-safe telemetry snapshot. Selects ONLY safe columns (never query
 * text, summary_json, input_json, output_summary, result_slugs, error, details_json).
 * A missing optional table is downgraded to a sanitized warning, not a crash.
 */
export function readDiagnosticSnapshot(db: Database, opts: ReadOpts): DiagnosticSnapshot {
  const tables = { sessions: true, steps: true, queryLog: true, searchLog: true };
  const warnings: string[] = [];

  const sessions = readTable("search_trace_sessions", "sessions", tables, warnings, () => {
    const rows = db.prepare(
      "SELECT id, started_at, mode, intent, status, latency_ms, total_steps, llm_calls, summary_json " +
      "FROM search_trace_sessions WHERE latency_ms IS NOT NULL AND datetime(started_at) >= datetime($cutoff) ORDER BY id",
    ).all({ $cutoff: opts.cutoffIso }) as Array<Omit<SessionRow, "reason_codes"> & { summary_json: string | null }>;
    // Drop summary_json entirely; keep only sanitized categorical reason codes.
    return rows.map(({ summary_json, ...rest }) => ({ ...rest, reason_codes: extractReasonCodes(summary_json) }));
  });

  // Steps only for slow sessions in the window (bounds the IN clause to what we report on).
  const slowIds = sessions.filter((s) => s.latency_ms >= opts.minLatencyMs).map((s) => s.id);
  const steps: StepRow[] = slowIds.length
    ? readTable("search_trace_steps", "steps", tables, warnings, () => {
        const placeholders = slowIds.map((_, i) => `$i${i}`).join(",");
        const params: Record<string, number> = {};
        slowIds.forEach((id, i) => { params[`$i${i}`] = id; });
        return db.prepare(
          `SELECT session_id, kind, latency_ms FROM search_trace_steps WHERE session_id IN (${placeholders})`,
        ).all(params) as StepRow[];
      })
    : [];

  const queryLogs = readTable("query_log", "queryLog", tables, warnings, () =>
    db.prepare("SELECT tool, latency_ms, created_at FROM query_log WHERE datetime(created_at) >= datetime($cutoff)").all({ $cutoff: opts.cutoffIso }) as QueryLogRow[],
  );

  const searchLogs = readTable("search_log", "searchLog", tables, warnings, () =>
    db.prepare("SELECT strategy, latency_ms, degraded, created_at FROM search_log WHERE datetime(created_at) >= datetime($cutoff)").all({ $cutoff: opts.cutoffIso }) as SearchLogRow[],
  );

  return { sessions, steps, queryLogs, searchLogs, tables, warnings };
}

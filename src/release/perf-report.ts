/**
 * v2.0 performance acceptance report — pure aggregation over RC journey results.
 *
 * This module is observability/reporting only (issue #188). It does NOT tune
 * search/NER/Lance/SQLite. It reuses the anonymous RC journey results and derives
 * a machine-readable + human-readable performance summary: per-journey query-budget
 * utilization, the slowest journey, the highest-utilization journey, and sanitized
 * warnings when a journey approaches its hard budget or the hang ceiling.
 *
 * Pure: takes already-measured journey inputs + a fixed timestamp/version. No I/O,
 * no Date, no env — fully deterministic and unit-testable.
 */

export type PerfVerdict = "go" | "no-go";

/** A single journey's measured inputs (structurally compatible with the RC gate's JourneyResult). */
export interface PerfJourneyInput {
  readonly id: string;
  readonly duration_ms: number;
  readonly query_count: number;
  readonly query_budget: number;
  readonly display_chars: number;
  readonly passed: boolean;
  readonly timed_out: boolean;
}

/** A journey in the perf report, with derived utilization. */
export interface PerfJourney extends PerfJourneyInput {
  /** query_count / query_budget, in [0, ∞). 0 when budget is 0. */
  readonly query_budget_utilization: number;
}

export interface PerfReport {
  readonly gate: "v2-perf";
  readonly version: string;
  readonly timestamp: string;
  readonly verdict: PerfVerdict;
  readonly journeys: ReadonlyArray<PerfJourney>;
  readonly slowest_journey: { readonly id: string; readonly duration_ms: number } | null;
  readonly highest_query_utilization_journey: { readonly id: string; readonly utilization: number } | null;
  readonly total_duration_ms: number;
  /** Sanitized strings (journey id + counts only — never paths, content, or credentials). */
  readonly warnings: ReadonlyArray<string>;
  readonly thresholds: {
    readonly warn_budget_pct: number;
    readonly warn_hang_pct: number;
    readonly hang_ceiling_ms: number;
  };
  readonly cleanup: { readonly verified: boolean; readonly path: string };
  readonly duration_ms: number;
}

/** Warn when a journey uses >= 80% of its query budget. */
export const WARN_BUDGET_PCT = 0.8;
/** Warn when a journey duration reaches >= 80% of the hang ceiling. */
export const WARN_HANG_PCT = 0.8;

export interface BuildPerfInput {
  readonly journeys: ReadonlyArray<PerfJourneyInput>;
  readonly cleanupVerified: boolean;
  readonly hangCeilingMs: number;
  readonly version: string;
  readonly timestamp: string;
  readonly gateDurationMs: number;
}

function pct(fraction: number): number {
  return Math.round(fraction * 100);
}

/**
 * Build the performance report. Verdict uses the existing HARD rules: any journey
 * that failed (incl. over query budget) or timed out, or a cleanup failure, is no-go.
 * High utilization / near-hang are WARNINGS only — they do not fail the gate, they
 * tell the release manager where to look first.
 */
export function buildPerfReport(input: BuildPerfInput): PerfReport {
  const journeys: PerfJourney[] = input.journeys.map((j) => ({
    id: j.id,
    duration_ms: j.duration_ms,
    query_count: j.query_count,
    query_budget: j.query_budget,
    display_chars: j.display_chars,
    passed: j.passed,
    timed_out: j.timed_out,
    query_budget_utilization: j.query_budget > 0 ? j.query_count / j.query_budget : 0,
  }));

  const slowest = journeys.length > 0
    ? journeys.reduce((a, b) => (b.duration_ms > a.duration_ms ? b : a))
    : null;

  const hottest = journeys.length > 0
    ? journeys.reduce((a, b) => (b.query_budget_utilization > a.query_budget_utilization ? b : a))
    : null;

  const totalDurationMs = journeys.reduce((sum, j) => sum + j.duration_ms, 0);

  const warnings: string[] = [];
  const hangWarnMs = input.hangCeilingMs * WARN_HANG_PCT;
  for (const j of journeys) {
    if (j.query_budget > 0 && j.query_budget_utilization >= WARN_BUDGET_PCT) {
      warnings.push(
        `journey '${j.id}' at ${pct(j.query_budget_utilization)}% query budget (${j.query_count}/${j.query_budget})`,
      );
    }
    if (j.duration_ms >= hangWarnMs) {
      warnings.push(
        `journey '${j.id}' near hang ceiling (${j.duration_ms}/${input.hangCeilingMs}ms)`,
      );
    }
  }

  // Hard no-go rules (same as gate:rc): any journey not passed / timed out, or cleanup failed.
  const allPassed = journeys.every((j) => j.passed && !j.timed_out);
  const verdict: PerfVerdict = allPassed && input.cleanupVerified ? "go" : "no-go";

  return {
    gate: "v2-perf",
    version: input.version,
    timestamp: input.timestamp,
    verdict,
    journeys,
    slowest_journey: slowest ? { id: slowest.id, duration_ms: slowest.duration_ms } : null,
    highest_query_utilization_journey: hottest
      ? { id: hottest.id, utilization: hottest.query_budget_utilization }
      : null,
    total_duration_ms: totalDurationMs,
    warnings,
    thresholds: {
      warn_budget_pct: WARN_BUDGET_PCT,
      warn_hang_pct: WARN_HANG_PCT,
      hang_ceiling_ms: input.hangCeilingMs,
    },
    cleanup: {
      verified: input.cleanupVerified,
      path: input.cleanupVerified ? "<cleaned>" : "<retained>",
    },
    duration_ms: input.gateDurationMs,
  };
}

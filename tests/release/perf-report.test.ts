import { describe, test, expect } from "bun:test";
import {
  buildPerfReport,
  WARN_BUDGET_PCT,
  WARN_HANG_PCT,
  type PerfJourneyInput,
} from "../../src/release/perf-report.js";

function j(over: Partial<PerfJourneyInput>): PerfJourneyInput {
  return {
    id: "journey-a",
    duration_ms: 5,
    query_count: 4,
    query_budget: 10,
    display_chars: 100,
    passed: true,
    timed_out: false,
    ...over,
  };
}

const baseInput = (journeys: PerfJourneyInput[]) => ({
  journeys,
  cleanupVerified: true,
  hangCeilingMs: 5000,
  version: "test-1.0.0",
  timestamp: "2026-06-18T00:00:00.000Z",
  gateDurationMs: 42,
});

describe("buildPerfReport (#188)", () => {
  test("emits a stable v2-perf schema with per-journey utilization", () => {
    const report = buildPerfReport(baseInput([
      j({ id: "journey-a", query_count: 4, query_budget: 10 }),
    ]));

    expect(report.gate).toBe("v2-perf");
    expect(report.version).toBe("test-1.0.0");
    expect(report.timestamp).toBe("2026-06-18T00:00:00.000Z");
    expect(report.verdict).toBe("go");
    expect(report.journeys).toHaveLength(1);
    expect(report.journeys[0].query_budget_utilization).toBeCloseTo(0.4, 5);
    // required top-level keys present
    for (const key of [
      "slowest_journey", "highest_query_utilization_journey", "total_duration_ms",
      "warnings", "thresholds", "cleanup", "duration_ms",
    ] as const) {
      expect(report).toHaveProperty(key);
    }
    expect(report.thresholds.warn_budget_pct).toBe(WARN_BUDGET_PCT);
    expect(report.thresholds.warn_hang_pct).toBe(WARN_HANG_PCT);
    expect(report.cleanup.verified).toBe(true);
  });

  test("slowest_journey is the max-duration journey", () => {
    const report = buildPerfReport(baseInput([
      j({ id: "fast", duration_ms: 3 }),
      j({ id: "slow", duration_ms: 20 }),
      j({ id: "mid", duration_ms: 7 }),
    ]));
    expect(report.slowest_journey).toEqual({ id: "slow", duration_ms: 20 });
    expect(report.total_duration_ms).toBe(30);
  });

  test("highest_query_utilization_journey is the max-utilization journey", () => {
    const report = buildPerfReport(baseInput([
      j({ id: "low", query_count: 1, query_budget: 10 }),
      j({ id: "hot", query_count: 9, query_budget: 10 }),
      j({ id: "mid", query_count: 5, query_budget: 10 }),
    ]));
    expect(report.highest_query_utilization_journey).toEqual({ id: "hot", utilization: 0.9 });
  });

  test("warns on near-budget and near-hang-ceiling, sanitized (id + numbers only)", () => {
    const report = buildPerfReport(baseInput([
      j({ id: "near-budget", query_count: 9, query_budget: 10, duration_ms: 5 }),    // 90% budget
      j({ id: "near-hang", query_count: 1, query_budget: 10, duration_ms: 4500 }),   // 90% of 5000ms ceiling
      j({ id: "clean", query_count: 2, query_budget: 10, duration_ms: 5 }),
    ]));

    const text = report.warnings.join(" | ");
    expect(report.warnings.length).toBe(2);
    expect(text).toContain("near-budget");
    expect(text).toContain("90%");
    expect(text).toContain("near-hang");
    // sanitized: no paths, file extensions, credentials, or private tokens
    expect(text).not.toMatch(/\/tmp|\.md|secret|sk-|[A-Z]:\\/i);
  });

  test("verdict is no-go when any journey is over budget (passed=false)", () => {
    const report = buildPerfReport(baseInput([
      j({ id: "ok", passed: true }),
      j({ id: "over", query_count: 20, query_budget: 10, passed: false }),
    ]));
    expect(report.verdict).toBe("no-go");
  });

  test("verdict is no-go when cleanup failed, even if all journeys passed", () => {
    const report = buildPerfReport({
      ...baseInput([j({ id: "ok" })]),
      cleanupVerified: false,
    });
    expect(report.verdict).toBe("no-go");
    expect(report.cleanup.verified).toBe(false);
  });

  test("verdict is no-go when a journey timed out", () => {
    const report = buildPerfReport(baseInput([
      j({ id: "hung", timed_out: true, passed: false }),
    ]));
    expect(report.verdict).toBe("no-go");
  });

  test("zero-budget journey reports 0 utilization without divide-by-zero", () => {
    const report = buildPerfReport(baseInput([
      j({ id: "zero", query_count: 0, query_budget: 0 }),
    ]));
    expect(report.journeys[0].query_budget_utilization).toBe(0);
  });
});

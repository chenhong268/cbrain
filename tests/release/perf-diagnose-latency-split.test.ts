import { describe, test, expect } from "bun:test";
import { diagnose } from "../../src/release/perf-diagnose.js";
import type { DiagnosticSnapshot } from "../../src/release/perf-diagnose.js";

// Anonymous fixture: a slow-but-complete session (latency warning only) vs a
// genuinely degraded session (vector_timeout).
const snapshot: DiagnosticSnapshot = {
  sessions: [
    { id: 1, started_at: "", mode: "smart-hybrid", intent: null, status: "success", latency_ms: 5000, total_steps: 1, llm_calls: 0, reason_codes: ["latency_budget_exceeded"] } as never,
    { id: 2, started_at: "", mode: "smart-hybrid", intent: null, status: "degraded", latency_ms: 600, total_steps: 1, llm_calls: 0, reason_codes: ["vector_timeout"] } as never,
  ],
  steps: [],
  queryLogs: [],
  searchLogs: [],
  tables: [],
  warnings: [],
};

describe("perf-diagnose latency split (#250)", () => {
  const report = diagnose(snapshot, { days: 7, minLatencyMs: 0, limit: 50 });

  test("degraded_rate counts only the vector_timeout session", () => {
    expect(report.summary.degraded_rate).toBe(0.5);
  });

  test("latency_warning_rate is reported separately", () => {
    expect(report.summary.latency_warning_rate).toBe(0.5);
  });

  test("by_degraded_reason excludes latency_budget_exceeded", () => {
    const reasons = report.by_degraded_reason.map(r => r.reason);
    expect(reasons).toContain("vector_timeout");
    expect(reasons).not.toContain("latency_budget_exceeded");
  });

  test("by_latency_warning_reason contains latency_budget_exceeded", () => {
    const reasons = (report as { by_latency_warning_reason?: { reason: string }[] }).by_latency_warning_reason?.map(r => r.reason) ?? [];
    expect(reasons).toContain("latency_budget_exceeded");
  });
});

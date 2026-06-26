import { describe, test, expect } from "bun:test";
import {
  percentile,
  diagnose,
  formatJson,
  formatHuman,
  sanitizeDim,
  extractReasonCodes,
  type SessionRow,
  type DiagnosticSnapshot,
} from "../../src/release/perf-diagnose.js";

function session(over: Partial<SessionRow>): SessionRow {
  return {
    id: 1,
    started_at: "2026-06-18T00:00:00.000Z",
    mode: "deep_recall",
    intent: "topic",
    status: "success",
    latency_ms: 500,
    total_steps: 4,
    llm_calls: 1,
    reason_codes: [],
    ...over,
  };
}

function snap(over: Partial<DiagnosticSnapshot>): DiagnosticSnapshot {
  return {
    sessions: [],
    steps: [],
    queryLogs: [],
    searchLogs: [],
    tables: { sessions: true, steps: true, queryLog: true, searchLog: true },
    warnings: [],
    ...over,
  };
}

const opts = { minLatencyMs: 1000, limit: 20 };

describe("percentile (#189)", () => {
  test("nearest-rank p50/p95 over odd and even counts", () => {
    expect(percentile([10, 20, 30, 40, 50], 50)).toBe(30);
    expect(percentile([10, 20, 30, 40, 50], 95)).toBe(50);
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([100], 95)).toBe(100);
  });
  test("empty input returns 0", () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([], 95)).toBe(0);
  });
});

describe("sanitizeDim (#189)", () => {
  test("redacts path-like values, keeps short categorical tokens", () => {
    expect(sanitizeDim("deep_recall")).toBe("deep_recall");
    expect(sanitizeDim("topic")).toBe("topic");
    expect(sanitizeDim("/Users/mac/vault/secret.md")).toBe("<path>");
    expect(sanitizeDim("normal")).toBe("normal");
  });
  test("truncates overlong values", () => {
    const long = "x".repeat(200);
    expect(sanitizeDim(long).length).toBeLessThanOrEqual(64);
  });
});

describe("extractReasonCodes allowlist (#189 review)", () => {
  test("keeps ONLY known reason codes; drops arbitrary/unknown strings entirely", () => {
    const raw = JSON.stringify({
      reason_codes: [
        "vector_timeout",
        "latency_budget_exceeded",
        "sk-DEADBEEF-PRIVATE",
        "用户私密判断",
        "/Users/private/vault/file.md",
        "low_score",
      ],
      degraded_reason: "reasoning_parse_failed",
      secret_blob: "RAW-PRIVATE-CONTENT",
    });
    const codes = extractReasonCodes(raw);
    expect(codes.sort()).toEqual(["latency_budget_exceeded", "low_score", "reasoning_parse_failed", "vector_timeout"]);
    expect(codes).not.toContain("sk-DEADBEEF-PRIVATE");
    expect(codes).not.toContain("用户私密判断");
    expect(codes.some((c) => c.includes("/Users"))).toBe(false);
  });

  test("non-canonical degraded_reason strings are dropped", () => {
    expect(extractReasonCodes(JSON.stringify({ degraded_reason: "搜索超时" }))).toEqual([]);
  });

  test("null / malformed JSON -> []", () => {
    expect(extractReasonCodes(null)).toEqual([]);
    expect(extractReasonCodes("not json")).toEqual([]);
  });
});

describe("diagnose (#189)", () => {
  test("empty snapshot -> zero-count report", () => {
    const r = diagnose(snap({}), opts);
    expect(r.summary.session_count).toBe(0);
    expect(r.summary.slow_count).toBe(0);
    expect(r.summary.latency).toBeNull();
    expect(r.slow_sessions).toEqual([]);
    expect(r.by_mode).toEqual([]);
  });

  test("slow sessions are sorted by latency desc and capped at limit", () => {
    const r = diagnose(
      snap({
        sessions: [
          session({ id: 1, latency_ms: 1500 }),
          session({ id: 2, latency_ms: 5000 }),
          session({ id: 3, latency_ms: 200 }),
          session({ id: 4, latency_ms: 3000 }),
        ],
      }),
      { minLatencyMs: 1000, limit: 2 },
    );
    // only latency>=1000, sorted desc, capped at 2
    expect(r.slow_sessions.map((s) => s.id)).toEqual([2, 4]);
    expect(r.summary.slow_count).toBe(3); // 3 sessions >= 1000ms (1,2,4)
  });

  test("aggregates compute count/p50/p95/max + degraded_rate by mode", () => {
    const r = diagnose(
      snap({
        sessions: [
          session({ id: 1, mode: "deep_recall", latency_ms: 100, status: "success" }),
          session({ id: 2, mode: "deep_recall", latency_ms: 200, status: "degraded" }),
          session({ id: 3, mode: "deep_recall", latency_ms: 300, status: "success" }),
          session({ id: 4, mode: "deep_recall", latency_ms: 400, status: "success" }),
          session({ id: 5, mode: "graph_query", latency_ms: 50, status: "success" }),
        ],
      }),
      opts,
    );
    const dr = r.by_mode.find((a) => a.dimension === "deep_recall")!;
    expect(dr.count).toBe(4);
    expect(dr.p50).toBe(200); // nearest-rank p50 of [100,200,300,400]
    expect(dr.p95).toBe(400);
    expect(dr.max).toBe(400);
    expect(dr.degraded_rate).toBeCloseTo(0.25, 5); // 1 of 4 degraded
  });

  test("slowest step kind is derived per slow session from steps", () => {
    const r = diagnose(
      snap({
        sessions: [session({ id: 7, latency_ms: 2000, total_steps: 3 })],
        steps: [
          { session_id: 7, kind: "vector_search", latency_ms: 100 },
          { session_id: 7, kind: "llm_synthesize", latency_ms: 1500 },
          { session_id: 7, kind: "fts_search", latency_ms: 300 },
        ],
      }),
      opts,
    );
    expect(r.slow_sessions).toHaveLength(1);
    expect(r.slow_sessions[0].slowest_step_kind).toBe("llm_synthesize");
  });

  test("slowest_step_kinds ranks dominating step kinds across slow sessions", () => {
    const r = diagnose(
      snap({
        sessions: [
          session({ id: 1, latency_ms: 2000 }),
          session({ id: 2, latency_ms: 2000 }),
        ],
        steps: [
          { session_id: 1, kind: "llm_synthesize", latency_ms: 1500 },
          { session_id: 1, kind: "vector_search", latency_ms: 100 },
          { session_id: 2, kind: "llm_synthesize", latency_ms: 1400 },
          { session_id: 2, kind: "vector_search", latency_ms: 200 },
        ],
      }),
      opts,
    );
    const llm = r.slowest_step_kinds.find((k) => k.kind === "llm_synthesize")!;
    expect(llm.count).toBe(2);
    expect(llm.avg_latency_ms).toBeCloseTo(1450, 0);
  });

  test("summary averages steps + llm calls and computes p50/p95/max over slow sessions", () => {
    const r = diagnose(
      snap({
        sessions: [
          session({ id: 1, latency_ms: 1000, total_steps: 4, llm_calls: 1 }),
          session({ id: 2, latency_ms: 2000, total_steps: 6, llm_calls: 2 }),
          session({ id: 3, latency_ms: 3000, total_steps: 8, llm_calls: 3 }),
        ],
      }),
      { minLatencyMs: 1000, limit: 20 },
    );
    expect(r.summary.slow_count).toBe(3);
    expect(r.summary.latency).toEqual({ p50: 2000, p95: 3000, max: 3000 });
    expect(r.summary.avg_total_steps).toBeCloseTo(6, 5);
    expect(r.summary.avg_llm_calls).toBeCloseTo(2, 5);
  });

  test("warnings pass through to the report", () => {
    const r = diagnose(snap({ warnings: ["table 'query_log' missing"] }), opts);
    expect(r.warnings).toEqual(["table 'query_log' missing"]);
  });

  test("by_degraded_reason aggregates categorical reason codes across sessions", () => {
    const r = diagnose(
      snap({
        sessions: [
          session({ id: 1, latency_ms: 2000, status: "degraded", reason_codes: ["vector_timeout"] }),
          session({ id: 2, latency_ms: 2500, status: "degraded", reason_codes: ["vector_timeout", "empty_result"] }),
          session({ id: 3, latency_ms: 3000, status: "degraded", reason_codes: ["empty_result"] }),
          session({ id: 4, latency_ms: 500, status: "success", reason_codes: [] }),
        ],
      }),
      opts,
    );
    const vt = r.by_degraded_reason.find((x) => x.reason === "vector_timeout")!;
    expect(vt.count).toBe(2);
    expect(vt.max).toBe(2500);
    const er = r.by_degraded_reason.find((x) => x.reason === "empty_result")!;
    expect(er.count).toBe(2);
    expect(er.max).toBe(3000);
  });
});

describe("formatters (#189)", () => {
  const report = diagnose(
    snap({
      sessions: [
        session({ id: 1, mode: "deep_recall", latency_ms: 2000, status: "degraded" }),
      ],
      steps: [{ session_id: 1, kind: "llm_synthesize", latency_ms: 1800 }],
    }),
    opts,
  );

  test("formatJson is parseable with stable top-level keys", () => {
    const obj = JSON.parse(formatJson(report, { days: 7, min_latency_ms: 1000, limit: 20 }));
    for (const key of [
      "generated_at", "window", "tables", "warnings", "summary",
      "by_mode", "by_intent", "by_status", "by_degraded_reason", "slowest_step_kinds", "slow_sessions",
    ]) {
      expect(obj).toHaveProperty(key);
    }
    expect(obj.window).toEqual({ days: 7, min_latency_ms: 1000, limit: 20 });
  });

  test("formatHuman is non-empty and sanitized (no paths/query text/sql)", () => {
    const text = formatHuman(report);
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("deep_recall");
    expect(text).toContain("degraded");
    // never echo raw query text, paths, sql, or private tokens
    expect(text).not.toMatch(/\/Users|\.md\b|SELECT |input_json|output_summary|secret|sk-[a-f0-9]/i);
  });
});

/**
 * Search Diagnostics Tests — #134
 *
 * Unit tests for the pure classifier function classifyDegradedReasons().
 * All test fixtures use anonymous placeholders.
 */
import { describe, test, expect } from "bun:test";
import {
  classifyDegradedReasons,
  computeSearchDegraded,
  computeLatencyWarning,
  HIERARCHY_KEYWORDS,
  WARNING_REASON_CODES,
} from "../../src/core/retrieval/search-diagnostics.js";

const NO_TRACE = {};

describe("classifyDegradedReasons", () => {
  // ─── Vector degradation ──────────────────────────────────

  test("vector_timeout + empty results → both codes", () => {
    const codes = classifyDegradedReasons(
      [],
      { degraded_reason: "vector_timeout" },
      "test query",
    );
    expect(codes).toContain("vector_timeout");
    expect(codes).toContain("fts_empty");
    expect(codes.length).toBe(2);
  });

  test("vector_error → single code", () => {
    const codes = classifyDegradedReasons(
      [{ score: 0.5 }],
      { degraded_reason: "vector_error" },
      "test query",
    );
    expect(codes).toEqual(["vector_error"]);
  });

  // ─── Empty / low results ─────────────────────────────────

  test("empty results → fts_empty", () => {
    const codes = classifyDegradedReasons([], NO_TRACE, "test query");
    expect(codes).toEqual(["fts_empty"]);
  });

  test("low score (0.05) → low_score", () => {
    const codes = classifyDegradedReasons(
      [{ score: 0.05 }],
      NO_TRACE,
      "test query",
    );
    expect(codes).toEqual(["low_score"]);
  });

  test("good results (0.8) → no codes", () => {
    const codes = classifyDegradedReasons(
      [{ score: 0.8 }, { score: 0.6 }],
      NO_TRACE,
      "test query",
    );
    expect(codes).toEqual([]);
  });

  // ─── Hierarchy mismatch ──────────────────────────────────

  test("hierarchy keywords + empty → routing_mismatch + fts_empty", () => {
    const codes = classifyDegradedReasons(
      [],
      NO_TRACE,
      "实体A的下属有哪些",
    );
    expect(codes).toContain("routing_mismatch_hierarchy");
    expect(codes).toContain("fts_empty");
  });

  test("hierarchy keywords + weak results → routing_mismatch + low_score", () => {
    const codes = classifyDegradedReasons(
      [{ score: 0.1 }],
      NO_TRACE,
      "实体B的下属",
    );
    expect(codes).toContain("routing_mismatch_hierarchy");
    expect(codes).toContain("low_score");
  });

  test("hierarchy keywords + OK results → no routing_mismatch", () => {
    const codes = classifyDegradedReasons(
      [{ score: 0.6 }],
      NO_TRACE,
      "组织架构",
    );
    expect(codes).toEqual([]);
  });

  test("non-hierarchy query + empty → only fts_empty, no routing_mismatch", () => {
    const codes = classifyDegradedReasons(
      [],
      NO_TRACE,
      "某个技术方案",
    );
    expect(codes).toEqual(["fts_empty"]);
  });

  // ─── Rerank ──────────────────────────────────────────────

  test("rerank ran but score still low → rerank_insufficient", () => {
    const codes = classifyDegradedReasons(
      [{ score: 0.2 }],
      { rerank_ms: 100 },
      "test query",
    );
    expect(codes).toContain("rerank_insufficient");
  });

  // ─── Fallback ────────────────────────────────────────────

  test("vector degraded + query variants → fallback_used", () => {
    const codes = classifyDegradedReasons(
      [{ score: 0.3 }],
      { degraded_reason: "vector_timeout", query_variants: ["a", "b", "c"] },
      "test query",
    );
    expect(codes).toContain("vector_timeout");
    expect(codes).toContain("fallback_used");
  });

  // ─── Budget exhausted ────────────────────────────────────

  test("research ran but still degraded → budget_exhausted", () => {
    const codes = classifyDegradedReasons(
      [],
      { degraded_reason: "vector_timeout", research_ms: 5000, follow_up_queries: ["q1", "q2"] },
      "test query",
    );
    expect(codes).toContain("vector_timeout");
    expect(codes).toContain("budget_exhausted");
  });

  // ─── Reasoning parse failed ──────────────────────────────

  test("reasoning_parse_failed → single code", () => {
    const codes = classifyDegradedReasons(
      [{ score: 0.4 }],
      { degraded_reason: "reasoning_parse_failed" },
      "test query",
    );
    expect(codes).toEqual(["reasoning_parse_failed"]);
  });

  test("decompose_budget_exceeded → budget_exhausted", () => {
    const codes = classifyDegradedReasons(
      [{ score: 0.8 }],
      { degraded_reason: "decompose_budget_exceeded" },
      "test query",
    );
    expect(codes).toEqual(["budget_exhausted"]);
  });

  test("slow response → latency_budget_exceeded", () => {
    const codes = classifyDegradedReasons(
      [{ score: 0.8 }],
      NO_TRACE,
      "test query",
      undefined,
      2500,
    );
    expect(codes).toEqual(["latency_budget_exceeded"]);
  });

  test("fast response does not emit latency_budget_exceeded", () => {
    const codes = classifyDegradedReasons(
      [{ score: 0.8 }],
      NO_TRACE,
      "test query",
      undefined,
      2000,
    );
    expect(codes).toEqual([]);
  });

  // ─── HIERARCHY_KEYWORDS coverage ─────────────────────────

  test("all HIERARCHY_KEYWORDS trigger detection on empty results", () => {
    for (const kw of HIERARCHY_KEYWORDS) {
      const codes = classifyDegradedReasons([], NO_TRACE, `包含${kw}的查询`);
      expect(codes).toContain("routing_mismatch_hierarchy");
    }
  });
});

describe("computeSearchDegraded", () => {
  test("latency > 2000ms alone → NOT degraded (#250: latency-only is a warning)", () => {
    expect(computeSearchDegraded(2500, {}, [])).toBe(false);
  });

  test("latency ≤ 2000ms + no trace + no codes → not degraded", () => {
    expect(computeSearchDegraded(500, {}, [])).toBe(false);
  });

  test("trace.degraded_reason → degraded even with low latency", () => {
    expect(computeSearchDegraded(100, { degraded_reason: "vector_timeout" }, [])).toBe(true);
  });

  test("reason code fts_empty → degraded even with low latency and no trace", () => {
    expect(computeSearchDegraded(100, {}, ["fts_empty"])).toBe(true);
  });

  test("reason code rerank_insufficient alone → NOT degraded (informational)", () => {
    expect(computeSearchDegraded(100, {}, ["rerank_insufficient"])).toBe(false);
  });

  test("reason code routing_mismatch_hierarchy alone → NOT degraded (informational)", () => {
    expect(computeSearchDegraded(100, {}, ["routing_mismatch_hierarchy"])).toBe(false);
  });

  test("vector_timeout code + low latency → degraded", () => {
    expect(computeSearchDegraded(50, {}, ["vector_timeout"])).toBe(true);
  });

  test("latency_budget_exceeded code + low latency → NOT degraded (#250)", () => {
    expect(computeSearchDegraded(50, {}, ["latency_budget_exceeded"])).toBe(false);
  });
});

describe("latency-only split (#250)", () => {
  test("latency-only slow → NOT degraded (quality is fine)", () => {
    expect(computeSearchDegraded(5000, {}, [])).toBe(false);
  });

  test("latency-only slow → latency_warning true", () => {
    expect(computeLatencyWarning(5000, [])).toBe(true);
  });

  test("latency-only fast → no latency_warning", () => {
    expect(computeLatencyWarning(500, [])).toBe(false);
  });

  test("latency_budget_exceeded code alone → NOT degraded (moved to warning)", () => {
    expect(computeSearchDegraded(50, {}, ["latency_budget_exceeded"])).toBe(false);
  });

  test("fts_parser_fallback code alone + would-be-good → NOT degraded", () => {
    expect(computeSearchDegraded(50, {}, ["fts_parser_fallback"])).toBe(false);
  });

  test("latency slow + real retrieval degraded → degraded AND warning", () => {
    expect(computeSearchDegraded(5000, {}, ["vector_timeout"])).toBe(true);
    expect(computeLatencyWarning(5000, ["vector_timeout"])).toBe(true);
  });

  test("WARNING_REASON_CODES contains latency_budget_exceeded + fts_parser_fallback", () => {
    expect(WARNING_REASON_CODES.has("latency_budget_exceeded")).toBe(true);
    expect(WARNING_REASON_CODES.has("fts_parser_fallback")).toBe(true);
    expect(WARNING_REASON_CODES.has("vector_timeout")).toBe(false);
  });

  test("parser_fallback + good results → NOT degraded (warning only)", () => {
    // fts_parser_fallback is warning-only; real degradation comes from a
    // simultaneous fts_empty / low_score code, NOT from parser_fallback itself.
    // (computeSearchDegraded only consumes reasonCodes, not fts_fallback — pass {}
    // for the trace to satisfy its { degraded_reason?: string } type.)
    expect(computeSearchDegraded(100, {}, ["fts_parser_fallback"])).toBe(false);
  });

  test("parser_fallback + empty results → degraded via fts_empty (not via parser_fallback)", () => {
    expect(computeSearchDegraded(100, {}, ["fts_parser_fallback", "fts_empty"])).toBe(true);
  });
});

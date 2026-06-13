/**
 * Search Degradation Diagnostics — #134
 *
 * Pure diagnostic functions that classify degraded search states into
 * structured reason codes. No side effects, no DB dependencies.
 * Called post-search by recall.ts and search.ts.
 */

// ─── Types ──────────────────────────────────────────────────

export type DegradedReasonCode =
  | "fts_empty"
  | "fts_parser_fallback"
  | "vector_timeout"
  | "vector_error"
  | "low_score"
  | "rerank_insufficient"
  | "routing_mismatch_hierarchy"
  | "fallback_used"
  | "budget_exhausted"
  | "reasoning_parse_failed";

export interface SearchDiagnosticInput {
  results: Array<{ score: number }>;
  trace: {
    degraded_reason?: string;
    fts_fallback?: boolean;
    rerank_ms?: number;
    follow_up_queries?: string[];
    research_ms?: number;
    query_variants?: string[];
  };
  query: string;
  requestedLimit?: number;
}

// ─── Constants ─────────────────────────────────────────────

export const HIERARCHY_KEYWORDS = [
  "下属", "汇报线", "汇报关系", "报告链", "组织架构", "组织结构",
  "组织树", "直属", "管谁", "向谁汇报", "上级", "老板",
];

export const DIAGNOSTIC_DEFAULTS = {
  /** Top result score below this → low_score */
  LOW_SCORE_THRESHOLD: 0.15,
  /** Top result score below this for hierarchy queries → routing_mismatch_hierarchy */
  LOW_SCORE_HIERARCHY: 0.2,
  /** Top result score below this when rerank ran → rerank_insufficient */
  RERANK_LOW_SCORE: 0.3,
};

// ─── Classifier ────────────────────────────────────────────

/**
 * Classify degraded search state into structured reason codes.
 *
 * Priority: trace-level first (vector/reasoning), then result-level (empty/low),
 * then contextual (hierarchy mismatch, fallback, budget).
 *
 * Multiple codes can apply simultaneously (e.g., vector_timeout + fts_empty).
 */
export function classifyDegradedReasons(
  results: Array<{ score: number }>,
  trace: {
    degraded_reason?: string;
    fts_fallback?: boolean;
    rerank_ms?: number;
    follow_up_queries?: string[];
    research_ms?: number;
    query_variants?: string[];
  },
  query: string,
  _requestedLimit?: number,
): DegradedReasonCode[] {
  const codes: DegradedReasonCode[] = [];
  const hasVectorDegradation = !!trace.degraded_reason;

  // 1. Map trace.degraded_reason → structured code
  if (trace.degraded_reason === "vector_timeout") {
    codes.push("vector_timeout");
  } else if (trace.degraded_reason === "vector_error") {
    codes.push("vector_error");
  } else if (trace.degraded_reason === "reasoning_parse_failed") {
    codes.push("reasoning_parse_failed");
  }

  // 1b. FTS parser fallback — MATCH expression failed, degraded to LIKE
  if (trace.fts_fallback) {
    codes.push("fts_parser_fallback");
  }

  // 2. Empty results
  if (results.length === 0) {
    codes.push("fts_empty");
  }

  // 3. Low score
  const topScore = results.length > 0 ? results[0].score : 0;
  if (results.length > 0 && topScore < DIAGNOSTIC_DEFAULTS.LOW_SCORE_THRESHOLD) {
    codes.push("low_score");
  }

  // 4. Rerank insufficient (rerank ran but results still weak)
  if (trace.rerank_ms != null && trace.rerank_ms > 0 && results.length > 0 && topScore < DIAGNOSTIC_DEFAULTS.RERANK_LOW_SCORE) {
    codes.push("rerank_insufficient");
  }

  // 5. Hierarchy routing mismatch
  if (hasHierarchyKeywords(query) && (results.length === 0 || (results.length > 0 && topScore < DIAGNOSTIC_DEFAULTS.LOW_SCORE_HIERARCHY))) {
    codes.push("routing_mismatch_hierarchy");
  }

  // 6. Fallback used (vector degraded + decompose tried alternatives)
  if (hasVectorDegradation && (trace.query_variants?.length ?? 0) > 1) {
    codes.push("fallback_used");
  }

  // 7. Budget exhausted (research loop ran but still degraded)
  if (hasVectorDegradation && trace.research_ms != null && trace.research_ms > 0 && (trace.follow_up_queries?.length ?? 0) > 0) {
    codes.push("budget_exhausted");
  }

  return codes;
}

// ─── Shared degraded computation ─────────────────────────

/**
 * Unified "is this search degraded?" check.
 * Used by search.ts, recall.ts, logSearch(), and trace sessions
 * so they all use the same definition.
 *
 * Degraded if ANY of:
 *   - latency > threshold (default 2000ms)
 *   - trace has a degraded_reason (vector timeout/error/etc.)
 *   - reason codes contain real degradation (not just informational)
 */
const DEGRADED_REASON_CODES: ReadonlySet<DegradedReasonCode> = new Set([
  "vector_timeout",
  "vector_error",
  "fts_empty",
  "fts_parser_fallback",
  "low_score",
  "budget_exhausted",
  "fallback_used",
  "reasoning_parse_failed",
]);

export function computeSearchDegraded(
  latencyMs: number,
  trace: { degraded_reason?: string },
  reasonCodes: DegradedReasonCode[],
  latencyThreshold = 2000,
): boolean {
  if (latencyMs > latencyThreshold) return true;
  if (trace.degraded_reason) return true;
  if (reasonCodes.some(code => DEGRADED_REASON_CODES.has(code))) return true;
  return false;
}

// ─── Helpers ────────────────────────────────────────────────

function hasHierarchyKeywords(query: string): boolean {
  const lower = query.toLowerCase();
  return HIERARCHY_KEYWORDS.some(kw => lower.includes(kw));
}

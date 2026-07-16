import type { SearchResult } from "./search.js";
import {
  CONTENT_LEXICAL_MIN_COVERAGE,
  CONTENT_VECTOR_EPSILON,
  CONTENT_VECTOR_MIN_COSINE,
  getRetrievalSupport,
  type RetrievalChannelEvidence,
} from "./retrieval-support.js";

export interface ContentCandidateDecision {
  readonly accepted: boolean;
  readonly reason:
    | "exact"
    | "strong_vector"
    | "strong_lexical"
    | "insufficient_support";
}

/**
 * Fail-closed content-recall admission rule.
 *
 * Fused rank is deliberately ignored: it is an ordering signal, not evidence
 * that a result answers the caller's root query. Decisions stay internal and
 * are never attached to the SearchResult or emitted by MCP formatters.
 */
export function assessContentCandidate(
  _query: string,
  result: SearchResult,
): ContentCandidateDecision {
  const support = getRetrievalSupport(result);

  if (hasFiniteRank(support.exact?.original)) return { accepted: true, reason: "exact" };

  const cosine = support.vector?.original?.vectorCosineSimilarity;
  if (
    typeof cosine === "number"
    && Number.isFinite(cosine)
    && cosine >= CONTENT_VECTOR_MIN_COSINE - CONTENT_VECTOR_EPSILON
  ) {
    return { accepted: true, reason: "strong_vector" };
  }

  if (
    hasStrongRootLexicalCoverage(support.fts?.original)
    || hasStrongRootLexicalCoverage(support.fts?.derived)
    || hasStrongRootLexicalCoverage(support.temporal?.original)
    || hasStrongRootLexicalCoverage(support.temporal?.derived)
  ) {
    return { accepted: true, reason: "strong_lexical" };
  }

  // A generated child may find an exact title unrelated to the caller's root
  // question. Admit it only when the captured root-query lexical scalar is
  // independently strong; never promote derived vector or graph rank alone.
  if (hasStrongRootLexicalCoverage(support.exact?.derived)) {
    return { accepted: true, reason: "strong_lexical" };
  }

  return { accepted: false, reason: "insufficient_support" };
}

export function filterContentCandidates(
  query: string,
  results: readonly SearchResult[],
): SearchResult[] {
  return results.filter((result) => assessContentCandidate(query, result).accepted);
}

function hasFiniteRank(evidence: RetrievalChannelEvidence | undefined): boolean {
  return evidence !== undefined && Number.isFinite(evidence.rankScore);
}

function hasStrongRootLexicalCoverage(evidence: RetrievalChannelEvidence | undefined): boolean {
  const coverage = evidence?.rootLexicalCoverage;
  return typeof coverage === "number"
    && Number.isFinite(coverage)
    && coverage >= CONTENT_LEXICAL_MIN_COVERAGE;
}

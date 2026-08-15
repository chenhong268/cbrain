import type { SearchResult } from "./search.js";
import {
  CONTENT_LEXICAL_MIN_COVERAGE,
  CONTENT_VECTOR_EPSILON,
  CONTENT_VECTOR_MIN_COSINE,
  getRetrievalSupport,
  type RetrievalChannelEvidence,
} from "./retrieval-support.js";

const FTS_FALLBACK_MIN_COVERAGE = 0.4;
const FTS_FALLBACK_DOMINANCE_RATIO = 2;
const FTS_FALLBACK_MIN_SHARE_OF_TOP_SCORE = 0.6;
const FTS_CJK_ANCHOR_MIN_UNITS = 4;

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

/**
 * Bounded rescue for content recall after its normal fail-closed admission
 * returns nothing. Natural-language questions often contain more context than
 * the matching memory, so a high-confidence FTS lead may not reach the normal
 * 0.6 lexical threshold. Never return more than the single dominant FTS hit.
 */
export function filterContentFtsFallbackCandidates(
  query: string,
  candidates: readonly SearchResult[],
): SearchResult[] {
  const admitted = filterContentCandidates(query, candidates);
  if (admitted.length > 0) return admitted;

  const ftsCandidates = candidates.filter((candidate) => (
    candidate.source === "fts" && Number.isFinite(candidate.score) && candidate.score > 0
  ));
  const candidateCountBySlug = new Map<string, number>();
  const strongestBySlug = new Map<string, SearchResult>();
  const supportedBySlug = new Map<string, SearchResult>();
  for (const candidate of ftsCandidates) {
    candidateCountBySlug.set(candidate.slug, (candidateCountBySlug.get(candidate.slug) ?? 0) + 1);
    const strongest = strongestBySlug.get(candidate.slug);
    if (!strongest || candidate.score > strongest.score) strongestBySlug.set(candidate.slug, candidate);
    if ((getRetrievalSupport(candidate).fts?.original?.rootLexicalCoverage ?? 0) < FTS_FALLBACK_MIN_COVERAGE) continue;
    const existing = supportedBySlug.get(candidate.slug);
    if (!existing || candidate.score > existing.score) supportedBySlug.set(candidate.slug, candidate);
  }
  const descendingScore = (left: SearchResult, right: SearchResult) => right.score - left.score;
  const [top, runnerUp] = [...supportedBySlug.values()].sort(descendingScore);
  const strongestScore = Math.max(0, ...candidates.map((candidate) => (
    Number.isFinite(candidate.score) ? candidate.score : 0
  )));
  if (
    top
    && top.score >= strongestScore * FTS_FALLBACK_MIN_SHARE_OF_TOP_SCORE
    && (!runnerUp || top.score >= runnerUp.score * FTS_FALLBACK_DOMINANCE_RATIO)
  ) return [top];

  const [anchoredTop, anchoredRunnerUp] = [...strongestBySlug.values()].sort(descendingScore);
  if (
    anchoredTop
    && (candidateCountBySlug.get(anchoredTop.slug) ?? 0) >= 2
    && hasLeadingCjkAnchor(query, anchoredTop.snippet)
    && anchoredTop.score >= strongestScore * FTS_FALLBACK_MIN_SHARE_OF_TOP_SCORE
    && (!anchoredRunnerUp || anchoredTop.score >= anchoredRunnerUp.score * FTS_FALLBACK_DOMINANCE_RATIO)
  ) return [anchoredTop];
  return [];
}

function hasLeadingCjkAnchor(query: string, evidence: string): boolean {
  const cjkPrefix = query.trim().match(/^\p{Script=Han}{4,}/u)?.[0];
  if (!cjkPrefix) return false;
  const anchor = Array.from(cjkPrefix).slice(0, FTS_CJK_ANCHOR_MIN_UNITS).join("");
  return compactLexicalUnits(evidence).join("").includes(anchor);
}

function compactLexicalUnits(value: string): string[] {
  try {
    return Array.from(value.normalize("NFKC").toLowerCase()).filter((unit) => /[\p{L}\p{N}]/u.test(unit));
  } catch {
    return [];
  }
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

import type { SearchResult } from "./search.js";
import {
  CONTENT_LEXICAL_MIN_COVERAGE,
  CONTENT_VECTOR_EPSILON,
  CONTENT_VECTOR_MIN_COSINE,
  findKeywordCauseEvidence,
  getRetrievalSupport,
  isClosedKeywordCauseQuery,
  type RetrievalChannelEvidence,
} from "./retrieval-support.js";

// #537 — the closed cause-grammar predicate and its evidence extractor keep
// exactly one rule source in retrieval-support. The structural import fence
// allows two importers of that module, so tool layers read these two pure
// string helpers through this admission module instead.
export { findKeywordCauseEvidence, isClosedKeywordCauseQuery };

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
    | "cause_evidence"
    | "insufficient_support";
}

export interface ContentCandidateAdmissionOptions {
  /** Exact pages certified by the closed-grammar identity resolver. */
  readonly deterministicIdentitySlugs?: ReadonlySet<string>;
  /**
   * Verified original cause-evidence sentence per candidate slug for a closed
   * keyword cause request. Every channel (exact, vector, lexical, FTS anchor)
   * locates a candidate; only a verified sentence answers the request.
   */
  readonly causeEvidenceBySlug?: ReadonlyMap<string, string>;
}

/**
 * Fail-closed content-recall admission rule.
 *
 * Fused rank is deliberately ignored: it is an ordering signal, not evidence
 * that a result answers the caller's root query. Decisions stay internal and
 * are never attached to the SearchResult or emitted by MCP formatters.
 */
export function assessContentCandidate(
  query: string,
  result: SearchResult,
  options?: ContentCandidateAdmissionOptions,
): ContentCandidateDecision {
  // #537 — a closed keyword cause request is answered only by original body
  // evidence verified for this candidate. No channel may bypass that rule.
  const causeEvidence = options?.causeEvidenceBySlug;
  if (causeEvidence && isClosedKeywordCauseQuery(query)) {
    return causeEvidence.has(result.slug)
      ? { accepted: true, reason: "cause_evidence" }
      : { accepted: false, reason: "insufficient_support" };
  }

  if (
    result.source === "exact"
    && options?.deterministicIdentitySlugs?.has(result.slug)
  ) {
    return { accepted: true, reason: "exact" };
  }

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
  options?: ContentCandidateAdmissionOptions,
): SearchResult[] {
  return results.filter((result) => assessContentCandidate(query, result, options).accepted);
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
  options?: ContentCandidateAdmissionOptions,
): SearchResult[] {
  const admitted = filterContentCandidates(query, candidates, options);
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
  ) return keepCertifiedCauseEvidence(query, [top], options);

  const [anchoredTop, anchoredRunnerUp] = [...strongestBySlug.values()].sort(descendingScore);
  if (
    anchoredTop
    && (candidateCountBySlug.get(anchoredTop.slug) ?? 0) >= 2
    && hasLeadingCjkAnchor(query, anchoredTop.snippet)
    && anchoredTop.score >= strongestScore * FTS_FALLBACK_MIN_SHARE_OF_TOP_SCORE
    && (!anchoredRunnerUp || anchoredTop.score >= anchoredRunnerUp.score * FTS_FALLBACK_DOMINANCE_RATIO)
  ) return keepCertifiedCauseEvidence(query, [anchoredTop], options);
  return [];
}

/**
 * #537 — the FTS rescue branch (0.4 coverage and CJK anchor alike) picks its own
 * candidate after the shared admission rule already ran, so a closed keyword
 * cause request still needs a verified sentence for that candidate.
 */
function keepCertifiedCauseEvidence(
  query: string,
  results: SearchResult[],
  options?: ContentCandidateAdmissionOptions,
): SearchResult[] {
  const causeEvidence = options?.causeEvidenceBySlug;
  if (!causeEvidence || !isClosedKeywordCauseQuery(query)) return results;
  return results.filter((result) => causeEvidence.has(result.slug));
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

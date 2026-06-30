import {
  normalizeForComparison, isSignificantSubstring, boundedLevenshtein,
  tokenizeForBlocking, titleCanonicalScore,
} from "./name-similarity.js";

export type SimilarMatchKind =
  | "alias_shadow_page" | "shared_alias"
  | "name_exact" | "name_normalized" | "name_substring" | "edit_distance";

export interface DetectorPage {
  slug: string;
  title: string;
  type: string;
}

export interface PageQuality {
  isStub: boolean;
  bodyChars: number;
  chunkCount: number;
  mentionCount: number;
  aliasCount: number;
  tagCount: number;
}

export interface DetectorInput {
  /** entity/% + concept/% only (caller pre-filters). */
  pages: DetectorPage[];
  /** aliases TABLE only, normalized, NEVER includes own title. Used for match_kind only. */
  registeredAliasesBySlug: Map<string, Set<string>>;
  /** slug → undirected link count. */
  linkDegree: Map<string, number>;
  /** per-page quality signals, precomputed by the orchestrator. */
  qualityBySlug: Map<string, PageQuality>;
  /** ontology affinity predicate; same-type is always allowed. */
  areTypesAffine: (a: string, b: string) => boolean;
}

export interface DetectorOptions {
  maxPairsEvaluated?: number;
  maxCandidates?: number;
  maxBucketSize?: number;
}

export interface SimilarEntityCandidate {
  slugA: string;
  slugB: string;
  matchKind: SimilarMatchKind;
  nameScore: number;
  editDistance?: number;
  typeGate: "same_type" | "affine_type";
  actionable: "high" | "medium" | "low";
  recommendedTarget?: string;
  ambiguousTarget?: boolean;
  reasonCode: string;
  sharedAlias?: string[];
}

export interface DetectorReport {
  candidates: SimilarEntityCandidate[];
  truncated: boolean;
  pairsEvaluated: number;
}

const DEFAULTS = {
  maxPairsEvaluated: 5000,
  maxCandidates: 100,
  maxBucketSize: 50,
};

const ACTIONABLE_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

export function detectSimilarEntities(
  detectorInput: DetectorInput,
  options: DetectorOptions = {},
): DetectorReport {
  const opts = { ...DEFAULTS, ...options };
  const pageBySlug = new Map<string, DetectorPage>();
  for (const p of detectorInput.pages) pageBySlug.set(p.slug, p);

  // Inverted index: blocking key → slugs. Keys come from titles AND registered aliases.
  const index = new Map<string, string[]>();
  const indexSlug = (slug: string, text: string) => {
    for (const key of tokenizeForBlocking(text)) {
      const arr = index.get(key);
      if (arr) arr.push(slug); else index.set(key, [slug]);
    }
  };
  for (const p of detectorInput.pages) {
    indexSlug(p.slug, p.title);
    const aliases = detectorInput.registeredAliasesBySlug.get(p.slug);
    if (aliases) for (const al of aliases) indexSlug(p.slug, al);
  }

  // Generate unique candidate pairs from discriminative buckets.
  const seenPairs = new Set<string>();
  const pairList: Array<[string, string]> = [];
  for (const [, slugs] of index) {
    if (slugs.length < 2 || slugs.length > opts.maxBucketSize) continue;
    for (let i = 0; i < slugs.length; i++) {
      for (let j = i + 1; j < slugs.length; j++) {
        const [a, b] = slugs[i] < slugs[j] ? [slugs[i], slugs[j]] : [slugs[j], slugs[i]];
        const k = a + " " + b;
        if (seenPairs.has(k)) continue;
        seenPairs.add(k);
        pairList.push([a, b]);
      }
    }
  }

  let pairsEvaluated = 0;
  let truncated = false;
  const candidates: SimilarEntityCandidate[] = [];
  for (const [a, b] of pairList) {
    if (pairsEvaluated >= opts.maxPairsEvaluated) { truncated = true; break; }
    pairsEvaluated++;
    const cand = evaluatePair(a, b, detectorInput, pageBySlug);
    if (cand) candidates.push(cand);
  }

  // Rank BEFORE truncation: actionable → nameScore → same_type before affine → slug pair.
  candidates.sort((x, y) => {
    const ao = ACTIONABLE_ORDER[x.actionable] - ACTIONABLE_ORDER[y.actionable];
    if (ao !== 0) return ao;
    if (y.nameScore !== x.nameScore) return y.nameScore - x.nameScore;
    const tg = (x.typeGate === "same_type" ? 0 : 1) - (y.typeGate === "same_type" ? 0 : 1);
    if (tg !== 0) return tg;
    return (x.slugA + x.slugB).localeCompare(y.slugA + y.slugB);
  });
  if (candidates.length > opts.maxCandidates) truncated = true;
  return { candidates: candidates.slice(0, opts.maxCandidates), truncated, pairsEvaluated };
}

function computeActionable(kind: SimilarMatchKind, typeGate: "same_type" | "affine_type"): "high" | "medium" | "low" {
  const same = typeGate === "same_type";
  switch (kind) {
    case "alias_shadow_page": return "high";
    case "shared_alias": return same ? "high" : "medium";
    case "name_exact":
    case "name_normalized":
    case "name_substring": return same ? "high" : "medium";
    case "edit_distance": return "medium";
  }
}

function reasonFor(kind: SimilarMatchKind, typeGate: "same_type" | "affine_type"): string {
  const t = typeGate === "same_type" ? "same_type" : "affine_type";
  return `${kind}:${t}`;
}

function evaluatePair(
  slugA: string,
  slugB: string,
  input: DetectorInput,
  pageBySlug: Map<string, DetectorPage>,
): SimilarEntityCandidate | null {
  const pa = pageBySlug.get(slugA);
  const pb = pageBySlug.get(slugB);
  if (!pa || !pb || pa.slug === pb.slug) return null;

  const sameType = pa.type === pb.type;
  const affine = input.areTypesAffine(pa.type, pb.type);
  if (!sameType && !affine) return null;
  const typeGate: "same_type" | "affine_type" = sameType ? "same_type" : "affine_type";

  const aliasesA = input.registeredAliasesBySlug.get(slugA) ?? new Set<string>();
  const aliasesB = input.registeredAliasesBySlug.get(slugB) ?? new Set<string>();
  const normA = normalizeForComparison(pa.title);
  const normB = normalizeForComparison(pb.title);

  // Priority 1: alias_shadow_page (registered aliases ONLY — no own title).
  const aTitleAliasedToB = normA.length > 0 && aliasesB.has(normA);
  const bTitleAliasedToA = normB.length > 0 && aliasesA.has(normB);
  if (aTitleAliasedToB || bTitleAliasedToA) {
    const direction = aTitleAliasedToB && bTitleAliasedToA ? "both" : aTitleAliasedToB ? "aToB" : "bToA";
    return buildCandidate(slugA, slugB, "alias_shadow_page", 1.0, typeGate, input, { aliasDirection: direction });
  }

  // Priority 2: shared_alias
  const shared = [...aliasesA].filter((x) => aliasesB.has(x));
  if (shared.length > 0) {
    return buildCandidate(slugA, slugB, "shared_alias", 0.85, typeGate, input, { sharedAlias: shared });
  }

  // Priority 3: name_exact (case-insensitive raw equality)
  if (pa.title.toLowerCase() === pb.title.toLowerCase()) {
    return buildCandidate(slugA, slugB, "name_exact", 1.0, typeGate, input);
  }

  // Priority 4: name_normalized
  if (normA.length > 0 && normA === normB) {
    return buildCandidate(slugA, slugB, "name_normalized", 0.95, typeGate, input);
  }

  // Priority 5: name_substring
  const [shorterN, longerN] = normA.length <= normB.length ? [normA, normB] : [normB, normA];
  if (shorterN.length >= 2 && longerN.includes(shorterN) && isSignificantSubstring(shorterN, longerN)) {
    const ratio = shorterN.length / longerN.length;
    return buildCandidate(slugA, slugB, "name_substring", 0.6 + ratio * 0.3, typeGate, input);
  }

  // Priority 6: edit_distance (bounded)
  const dist = boundedLevenshtein(normA, normB, 2);
  if (dist !== null && normA.length > 0) {
    const score = Math.max(1 - dist / Math.max(normA.length, normB.length), 0.5);
    return buildCandidate(slugA, slugB, "edit_distance", score, typeGate, input, { editDistance: dist });
  }

  return null;
}

interface CandidateExtra {
  aliasDirection?: "aToB" | "bToA" | "both";
  sharedAlias?: string[];
  editDistance?: number;
}

function buildCandidate(
  slugA: string,
  slugB: string,
  kind: SimilarMatchKind,
  nameScore: number,
  typeGate: "same_type" | "affine_type",
  input: DetectorInput,
  extra: CandidateExtra = {},
): SimilarEntityCandidate {
  const recommended = computeRecommendedTarget(slugA, slugB, kind, input, extra.aliasDirection);
  const cand: SimilarEntityCandidate = {
    slugA, slugB, matchKind: kind, nameScore, typeGate,
    actionable: computeActionable(kind, typeGate),
    reasonCode: reasonFor(kind, typeGate),
  };
  if (extra.editDistance !== undefined) cand.editDistance = extra.editDistance;
  if (extra.sharedAlias) cand.sharedAlias = extra.sharedAlias;
  if (recommended.target) cand.recommendedTarget = recommended.target;
  if (recommended.ambiguous) cand.ambiguousTarget = true;
  return cand;
}

/**
 * Canonical merge-sink selection (#246 §8). alias_shadow with a single direction
 * always points at the alias holder. Otherwise compare on discriminators 1-5;
 * tie on all five → ambiguous (slug lexicographic is NOT used to force a choice).
 */
function computeRecommendedTarget(
  slugA: string,
  slugB: string,
  kind: SimilarMatchKind,
  input: DetectorInput,
  aliasDirection?: "aToB" | "bToA" | "both",
): { target?: string; ambiguous?: boolean } {
  if (kind === "alias_shadow_page") {
    if (aliasDirection === "aToB") return { target: slugB };
    if (aliasDirection === "bToA") return { target: slugA };
    // "both" → fall through to canonical scoring
  }

  const pick = (whenA: boolean): { target?: string; ambiguous?: boolean } =>
    whenA ? { target: slugA } : { target: slugB };

  const qa = input.qualityBySlug.get(slugA);
  const qb = input.qualityBySlug.get(slugB);
  const pageBySlug = new Map<string, DetectorPage>();
  for (const p of input.pages) pageBySlug.set(p.slug, p);

  // 1. non-stub beats stub
  const stubA = qa?.isStub ?? true;
  const stubB = qb?.isStub ?? true;
  if (stubA !== stubB) return pick(!stubA);

  // 2. completeness: bodyChars, then chunkCount
  const bodyA = qa?.bodyChars ?? 0;
  const bodyB = qb?.bodyChars ?? 0;
  if (bodyA !== bodyB) return pick(bodyA > bodyB);
  const chunksA = qa?.chunkCount ?? 0;
  const chunksB = qb?.chunkCount ?? 0;
  if (chunksA !== chunksB) return pick(chunksA > chunksB);

  // 3. link_degree
  const degA = input.linkDegree.get(slugA) ?? 0;
  const degB = input.linkDegree.get(slugB) ?? 0;
  if (degA !== degB) return pick(degA > degB);

  // 4. mention_count
  const menA = qa?.mentionCount ?? 0;
  const menB = qb?.mentionCount ?? 0;
  if (menA !== menB) return pick(menA > menB);

  // 5. title canonicalness
  const ta = pageBySlug.get(slugA);
  const tb = pageBySlug.get(slugB);
  if (ta && tb) {
    const ca = titleCanonicalScore(ta.title, ta.slug);
    const cb = titleCanonicalScore(tb.title, tb.slug);
    if (ca !== cb) return pick(ca > cb);
  }

  // tie on 1-5 → ambiguous; refuse to recommend
  return { ambiguous: true };
}

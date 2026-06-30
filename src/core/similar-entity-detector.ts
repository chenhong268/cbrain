import {
  normalizeForComparison, tokenizeForBlocking,
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

/**
 * Evaluate one candidate pair through the strategy priority chain.
 * Returns null if no strategy fires or the type gate drops the pair.
 * (Task 2 implements name_exact + the structure; Tasks 3-4 extend it.)
 */
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

  const normA = normalizeForComparison(pa.title);
  const normB = normalizeForComparison(pb.title);

  // Strategy: name_exact (case-insensitive raw equality)
  if (pa.title.toLowerCase() === pb.title.toLowerCase()) {
    return {
      slugA, slugB, matchKind: "name_exact", nameScore: 1.0, typeGate,
      actionable: computeActionable("name_exact", typeGate), reasonCode: reasonFor("name_exact", typeGate),
    };
  }

  // (name_normalized / name_substring / edit_distance / alias strategies added in Tasks 3-4)
  void normA; void normB;
  return null;
}

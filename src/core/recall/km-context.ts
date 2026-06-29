import { isCommunityMature } from "../knowledge-map-report.js";
import type { CommunitySummary, KnowledgeMapAnalysis, KnowledgeMapNode } from "../knowledge-map-types.js";

export interface KmSupplementalNode {
  slug: string;
  title: string;
  type: string;
  communityId: string;
  weightedDegree: number;
}

export type KmContextReason = "same_domain_context" | "no_mature_domain" | "km_unavailable";

export interface KmContextResult {
  matchedDomains: CommunitySummary[];
  supplemental: KmSupplementalNode[];
  excludedIsolatesCount: number;
  reason: KmContextReason;
}

export interface KmContextOptions {
  maxPerDomain?: number;
  totalCap?: number;
}

const DEFAULT_MAX_PER_DOMAIN = 3;
const DEFAULT_TOTAL_CAP = 5;

/**
 * #245 — Pure selection of same-mature-domain supplemental nodes for recall.
 * Community membership is NAVIGATION CONTEXT, never evidence or ranking. Reuses
 * isCommunityMature (single source of maturity thresholds). Does not mutate.
 */
export function buildKnowledgeMapContext(
  analysis: KnowledgeMapAnalysis,
  primarySlugs: string[],
  options?: KmContextOptions,
): KmContextResult {
  const maxPerDomain = options?.maxPerDomain ?? DEFAULT_MAX_PER_DOMAIN;
  const totalCap = options?.totalCap ?? DEFAULT_TOTAL_CAP;
  const primarySet = new Set(primarySlugs);

  const nodeBySlug = new Map<string, KnowledgeMapNode>();
  for (const n of analysis.nodes) nodeBySlug.set(n.slug, n);

  // Communities that at least one primary result belongs to AND are mature.
  const matchedIds = new Set<string>();
  for (const slug of primarySlugs) {
    const cid = nodeBySlug.get(slug)?.communityId;
    if (cid) matchedIds.add(cid);
  }
  const matchedDomains = analysis.communities.filter(
    (c) => matchedIds.has(c.id) && isCommunityMature(c),
  );

  if (matchedDomains.length === 0) {
    return { matchedDomains: [], supplemental: [], excludedIsolatesCount: 0, reason: "no_mature_domain" };
  }

  // Isolates = degree-0 (health.isolatedNodes) ∪ high-mention isolates. Excluded
  // from supplemental AND counted. The count is WHOLE-GRAPH (isolates carry no
  // communityId by definition), not per matched-domain — matches spec "孤立节点
  // 排除并计数".
  const isolateSlugs = new Set<string>();
  for (const n of analysis.health.isolatedNodes) isolateSlugs.add(n.slug);
  for (const n of analysis.highMentionIsolates) isolateSlugs.add(n.slug);
  const excludedIsolatesCount = [...isolateSlugs].filter((s) => !primarySet.has(s)).length;

  const pooled: KmSupplementalNode[] = [];
  for (const c of matchedDomains) {
    const candidates = analysis.nodes
      .filter(
        (n) =>
          n.communityId === c.id &&
          !primarySet.has(n.slug) &&
          !isolateSlugs.has(n.slug),
      )
      .sort((a, b) => b.weightedDegree - a.weightedDegree)
      .slice(0, maxPerDomain);
    for (const n of candidates) {
      pooled.push({ slug: n.slug, title: n.title, type: n.type, communityId: c.id, weightedDegree: n.weightedDegree });
    }
  }

  const supplemental = pooled.sort((a, b) => b.weightedDegree - a.weightedDegree).slice(0, totalCap);
  return { matchedDomains, supplemental, excludedIsolatesCount, reason: "same_domain_context" };
}

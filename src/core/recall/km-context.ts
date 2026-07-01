import { analyzeKnowledgeMap } from "../knowledge-map/index.js";
import { isCommunityMature } from "../knowledge-map/report.js";
import type { CBrainDB } from "../../storage/sqlite.js";
import type { CommunitySummary, KnowledgeMapAnalysis, KnowledgeMapNode } from "../knowledge-map/types.js";

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

/**
 * #245 — Spyable entry point for recall. recall.ts calls ONLY computeForRecall.
 * Tests spyOn(kmContextApi, "analyze"|"computeForRecall") to prove the off path
 * never analyzes. Arrow functions + explicit `kmContextApi.analyze(db)` (no `this`)
 * so spies stay stable regardless of call-site binding.
 */
export const kmContextApi = {
  analyze: (db: CBrainDB): KnowledgeMapAnalysis => analyzeKnowledgeMap(db),
  computeForRecall: (
    db: CBrainDB,
    primarySlugs: string[],
    options?: KmContextOptions,
  ): KmContextResult => {
    try {
      const analysis = kmContextApi.analyze(db);
      if (analysis.nodes.length === 0) {
        return { matchedDomains: [], supplemental: [], excludedIsolatesCount: 0, reason: "no_mature_domain" };
      }
      return buildKnowledgeMapContext(analysis, primarySlugs, options);
    } catch {
      return { matchedDomains: [], supplemental: [], excludedIsolatesCount: 0, reason: "km_unavailable" };
    }
  },
};

// Budget caps for the Agent-facing same-domain line (#245 Codex review): titles
// can be arbitrarily long, so cap per-title and total to keep compact <12k.
const KM_RELATED_TITLE_CAP = 80;
const KM_RELATED_LINE_CAP = 600;

/**
 * #245 — Format same-domain titles into a budget-safe natural-language line.
 * Returns undefined when there are no titles (caller omits the field). Pure.
 */
export function formatKmRelatedLine(titles: string[]): string | undefined {
  if (titles.length === 0) return undefined;
  const capped = titles.map((t) => t.slice(0, KM_RELATED_TITLE_CAP));
  const base = `同知识域还涉及：${capped.join("、")}`;
  return base.length > KM_RELATED_LINE_CAP ? `${base.slice(0, KM_RELATED_LINE_CAP - 1)}…` : base;
}

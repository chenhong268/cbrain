import type { CBrainDB } from "../storage/sqlite.js";
import type { KnowledgeMapAnalysis } from "./knowledge-map-types.js";

/**
 * #244 — Feed Knowledge Map isolation/bridge signals into Discovery as an
 * INDEPENDENT surface. Does NOT participate in existing discovery ranking.
 *
 * Writes top-N isolation/bridge candidates into the existing `discoveries`
 * table under dedicated open-string types. Reuses upsertDiscovery → dedup_key
 * + #172 lifecycle (dismissed/resolved rows are not resurrected on recurrence).
 *
 * Pure with respect to ranking: the producer is called from the Dream KM stage
 * (which already computed the analysis), never from MCP tool handlers, and it
 * never runs analyzeKnowledgeMap itself.
 */

export type KnowledgeMapDiscoveryType = "knowledge_map_isolation" | "knowledge_map_bridge";

export interface KnowledgeMapDiscoveryOptions {
  /** Max isolation candidates to write. Default 3. */
  isolationLimit?: number;
  /** Max bridge candidates to write. Default 3. */
  bridgeLimit?: number;
  /** Optional dream_run stamp for audit. */
  dreamRun?: string;
}

export interface KnowledgeMapDiscoveryResult {
  /** Isolation candidates considered (after limit). */
  isolation: number;
  /** Bridge candidates considered (after limit). */
  bridge: number;
  total: number;
  /** Newly inserted rows (excludes recurrence updates). */
  inserted: number;
}

const DEFAULT_ISOLATION_LIMIT = 3;
const DEFAULT_BRIDGE_LIMIT = 3;

/** Deterministic (0.01, 1] clamp; never 0 so rows stay sortable above true-zero. */
function clamp01(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0.01;
  return Math.min(n, 1);
}

export function produceKnowledgeMapDiscoveries(
  db: CBrainDB,
  analysis: KnowledgeMapAnalysis,
  opts: KnowledgeMapDiscoveryOptions = {},
): KnowledgeMapDiscoveryResult {
  const isolationLimit = opts.isolationLimit ?? DEFAULT_ISOLATION_LIMIT;
  const bridgeLimit = opts.bridgeLimit ?? DEFAULT_BRIDGE_LIMIT;
  const dreamRun = opts.dreamRun;

  let inserted = 0;

  // highMentionIsolates is already ordered mentionCount desc, slug asc.
  for (const node of analysis.highMentionIsolates.slice(0, isolationLimit)) {
    const score = clamp01(node.mentionCount / 10);
    const res = db.upsertDiscovery(
      "knowledge_map_isolation",
      [node.slug],
      score,
      undefined,
      dreamRun,
      "medium",
      false,
      { source: "knowledge_map", mention_count: node.mentionCount },
    );
    if (res.inserted) inserted++;
  }

  // bridgeCandidates is already ordered by slug.
  for (const cand of analysis.bridgeCandidates.slice(0, bridgeLimit)) {
    const score = clamp01(cand.neighborCommunityIds.length / 5);
    const res = db.upsertDiscovery(
      "knowledge_map_bridge",
      [cand.slug],
      score,
      undefined,
      dreamRun,
      "medium",
      false,
      { source: "knowledge_map", community_count: cand.neighborCommunityIds.length },
    );
    if (res.inserted) inserted++;
  }

  const isolation = Math.min(analysis.highMentionIsolates.length, isolationLimit);
  const bridge = Math.min(analysis.bridgeCandidates.length, bridgeLimit);
  return { isolation, bridge, total: isolation + bridge, inserted };
}

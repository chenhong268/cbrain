/**
 * #240 — Knowledge Map analyzer types.
 *
 * Phase 1 is a read-only analysis layer: it computes graph health, community
 * structure, bridge candidates, and weak-node signals from the existing
 * entity/concept graph. This file defines the data contract only — there is no
 * display formatter in this issue, so core data carries raw slugs; downstream
 * display work (#239) is responsible for not leaking slugs/source_type/weights
 * to users.
 *
 * The analyzer is pure: given a CBrainDB (read APIs only) and options, it
 * returns a deterministic KnowledgeMapAnalysis and writes nothing.
 */

export type KnowledgeMapResolution = "coarse" | "default" | "fine";

export interface KnowledgeMapOptions {
  /** Community-resolution preset. Phase 1 is a light iteration-budget knob.
   * Default: "default". A real modularity/resolution implementation is deferred. */
  resolution?: KnowledgeMapResolution;
  /** Page type prefixes included in the graph scope.
   * Default: ["entity/", "concept/"]. */
  typePrefixes?: string[];
}

/** A node in the analysis graph — an in-scope entity/concept page. */
export interface KnowledgeMapNode {
  slug: string;
  title: string;
  type: string;
  mentionCount: number;
  /** Sum of effective weights over all incident undirected edges. */
  weightedDegree: number;
  /** Number of distinct neighbors. */
  degree: number;
  /** Community id, or undefined for isolates that belong to no community. */
  communityId?: string;
}

/** Undirected weighted edge between two in-scope nodes. */
export interface KnowledgeMapEdge {
  /** Alphabetically smaller endpoint slug. */
  readonly a: string;
  /** Alphabetically larger endpoint slug. */
  readonly b: string;
  /** Aggregated effective weight: sum over parallel directed links of
   *  (stored weight * confidence * source-reliability multiplier). */
  weight: number;
  /** Number of directed links aggregated into this undirected edge. */
  linkCount: number;
}

export interface CommunitySummary {
  /** Stable label, e.g. "community-1", assigned by deterministic ordering. */
  readonly id: string;
  /** Number of nodes in the community. */
  size: number;
  /** Undirected edges with both endpoints inside the community. */
  internalEdgeCount: number;
  /** 2 * internalEdgeCount / (size * (size - 1)); 0 when size < 2. */
  density: number;
  /** Sum of effective weights over internal edges. */
  totalInternalWeight: number;
  /** Top nodes by weighted degree, descending. Phase 1 cap: 5. */
  topCoreNodes: KnowledgeMapNode[];
  /** Node count per page type within the community. */
  typeDistribution: Record<string, number>;
}

/** A node whose neighbors span more than one community. */
export interface BridgeCandidate {
  slug: string;
  title: string;
  type: string;
  /** Community ids this node directly connects to (distinct, sorted). */
  neighborCommunityIds: string[];
}

export interface KnowledgeMapHealth {
  nodeCount: number;
  edgeCount: number;
  /** Degree-0 nodes, by mentionCount desc then slug. */
  isolatedNodes: KnowledgeMapNode[];
  /** Degree-1 nodes, by mentionCount desc then slug. */
  degreeOneNodes: KnowledgeMapNode[];
  connectedComponentCount: number;
  largestConnectedComponentSize: number;
}

export interface KnowledgeMapAnalysis {
  readonly resolution: KnowledgeMapResolution;
  /** Every in-scope node with its metrics + community id (core data; no display
   *  formatter is built in this issue). Ordered by slug. */
  nodes: KnowledgeMapNode[];
  health: KnowledgeMapHealth;
  /** Communities, ordered by id (community-1, community-2, ...). */
  communities: CommunitySummary[];
  /** Nodes whose neighbors span >1 community. */
  bridgeCandidates: BridgeCandidate[];
  /** Isolated nodes whose mentionCount exceeds the graph mean. */
  highMentionIsolates: KnowledgeMapNode[];
  /** Degree-one nodes ordered by mentionCount desc, then slug. */
  weaklyConnectedNodes: KnowledgeMapNode[];
}

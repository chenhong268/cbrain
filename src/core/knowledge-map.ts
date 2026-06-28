import type { CBrainDB } from "../storage/sqlite.js";
import type {
  KnowledgeMapAnalysis,
  KnowledgeMapHealth,
  KnowledgeMapNode,
  KnowledgeMapOptions,
  KnowledgeMapResolution,
} from "./knowledge-map-types.js";

export * from "./knowledge-map-types.js";

// ─── Deterministic source reliability ───────────────────────────────────
// Multiplier applied on top of stored weight * confidence. Higher = more
// trustworthy provenance. Unmapped source_type falls back to conservative.
const SOURCE_RELIABILITY: Readonly<Record<string, number>> = {
  manual: 1.0,
  wikilink: 1.0,
  dialogue: 0.7,
  agent: 0.7,
  writeback: 0.5,
  unknown: 0.5,
  ner: 0.3,
  auto: 0.3,
  "auto-extracted": 0.3,
};
const DEFAULT_RELIABILITY = 0.5;

function reliabilityFor(sourceType: string): number {
  return SOURCE_RELIABILITY[sourceType] ?? DEFAULT_RELIABILITY;
}

const DEFAULT_TYPE_PREFIXES = ["entity/", "concept/"];

/** Phase 1 resolution is a light iteration-budget knob for label propagation:
 *  more iterations let labels propagate further. A real modularity implementation
 *  is deferred. */
const RESOLUTION_ITERATIONS: Readonly<Record<KnowledgeMapResolution, number>> = {
  coarse: 6,
  default: 10,
  fine: 14,
};

const TOP_CORE_NODES_CAP = 5;

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Analyze the entity/concept knowledge graph and return a deterministic,
 * read-only Knowledge Map summary: graph health, communities, bridge candidates,
 * and weak-node signals. Reads only (listPages, batchGetLinksForSlugs); writes
 * nothing to the DB or vault.
 *
 * Edge model: links are treated as undirected. Effective weight of a directed
 * link = stored `weight * confidence * source-reliability`. Multiple directed
 * links between the same pair are aggregated by SUMMING their effective weights
 * (evidence accumulates). Active links only — rejected/superseded edges are
 * filtered by batchGetLinksForSlugs' default and never influence the map.
 */
export function analyzeKnowledgeMap(db: CBrainDB, options?: KnowledgeMapOptions): KnowledgeMapAnalysis {
  const resolution: KnowledgeMapResolution = options?.resolution ?? "default";
  const prefixes = options?.typePrefixes ?? DEFAULT_TYPE_PREFIXES;

  // 1. Load in-scope nodes (entity/ and concept/ by default).
  const rawNodes = loadNodes(db, prefixes);
  const inScope = new Set(rawNodes.keys());

  // 2. Build the undirected weighted graph from active links, keeping only edges
  //    whose BOTH endpoints are in scope. Process each directed link once via
  //    `outgoing`; an edge with one endpoint out of scope is dropped.
  const { edgeMap, adjacency } = buildGraph(db, inScope);

  // 3. Connected components (deterministic BFS over sorted slugs).
  const components = connectedComponents(adjacency, [...inScope]);
  const largestConnectedComponentSize = components.reduce((m, c) => Math.max(m, c.length), 0);

  // 4. Community detection via deterministic label propagation over non-isolates.
  //    Isolates (degree 0) take no part and belong to no community. Computed before
  //    building node records so each node is constructed once, immutably.
  const nonIsolates = [...inScope].filter((s) => (adjacency.get(s)?.size ?? 0) > 0).sort();
  const labelOf = labelPropagation(adjacency, nonIsolates, RESOLUTION_ITERATIONS[resolution]);

  // Assign stable community ids by sorting distinct labels (slug order).
  const distinctLabels = [...new Set(labelOf.values())].sort();
  const labelToCommunityId = new Map<string, string>();
  distinctLabels.forEach((label, i) => {
    labelToCommunityId.set(label, `community-${i + 1}`);
  });

  // 5. Build node records in a single immutable pass: metrics from adjacency,
  //    community id from the label result.
  const nodeMap = new Map<string, KnowledgeMapNode>();
  let mentionSum = 0;
  for (const n of rawNodes.values()) {
    const nbrs = adjacency.get(n.slug);
    let weightedDegree = 0;
    let degree = 0;
    if (nbrs) {
      degree = nbrs.size;
      for (const w of nbrs.values()) weightedDegree += w;
    }
    const label = labelOf.get(n.slug);
    nodeMap.set(n.slug, {
      slug: n.slug,
      title: n.title,
      type: n.type,
      mentionCount: n.mentionCount,
      weightedDegree,
      degree,
      communityId: label === undefined ? undefined : labelToCommunityId.get(label),
    });
    mentionSum += n.mentionCount;
  }
  const meanMention = rawNodes.size > 0 ? mentionSum / rawNodes.size : 0;

  // 6. Per-community summaries.
  const communities = buildCommunities(nodeMap, edgeMap);

  // 7. Bridge candidates: neighbors span more than one community.
  const bridgeCandidates = buildBridgeCandidates(nodeMap, adjacency);

  // 8. Health metrics + weak-node signals.
  const allNodes = [...nodeMap.values()];
  const byMentionThenSlug = (a: KnowledgeMapNode, b: KnowledgeMapNode): number =>
    b.mentionCount - a.mentionCount || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);

  const isolatedNodes = allNodes.filter((n) => n.degree === 0).sort(byMentionThenSlug);
  const degreeOneNodes = allNodes.filter((n) => n.degree === 1).sort(byMentionThenSlug);
  const highMentionIsolates = isolatedNodes
    .filter((n) => n.mentionCount > meanMention)
    .sort(byMentionThenSlug);

  const health: KnowledgeMapHealth = {
    nodeCount: allNodes.length,
    edgeCount: edgeMap.size,
    isolatedNodes,
    degreeOneNodes,
    connectedComponentCount: components.length,
    largestConnectedComponentSize,
  };

  return {
    resolution,
    nodes: allNodes.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0)),
    health,
    communities,
    bridgeCandidates,
    highMentionIsolates,
    weaklyConnectedNodes: degreeOneNodes,
  };
}

// ─── Internals ───────────────────────────────────────────────────────────

interface RawNode {
  slug: string;
  title: string;
  type: string;
  mentionCount: number;
}

function loadNodes(db: CBrainDB, prefixes: string[]): Map<string, RawNode> {
  const out = new Map<string, RawNode>();
  for (const prefix of prefixes) {
    const rows = db.listPages({ typePrefix: prefix });
    for (const r of rows) {
      if (out.has(r.slug)) continue; // de-dup across prefixes
      out.set(r.slug, {
        slug: r.slug,
        title: r.title,
        type: r.type,
        mentionCount: r.mention_count,
      });
    }
  }
  return out;
}

interface AggregatedEdge {
  a: string;
  b: string;
  weight: number;
  linkCount: number;
}

function buildGraph(
  db: CBrainDB,
  inScope: Set<string>,
): {
  edgeMap: Map<string, AggregatedEdge>;
  adjacency: Map<string, Map<string, number>>;
} {
  if (inScope.size === 0) {
    return { edgeMap: new Map(), adjacency: new Map() };
  }
  const linksBySlug = db.batchGetLinksForSlugs([...inScope]);
  const edgeMap = new Map<string, AggregatedEdge>();
  for (const slug of inScope) {
    const entry = linksBySlug.get(slug);
    if (!entry) continue;
    // Process each directed link once via outgoing.
    for (const l of entry.outgoing) {
      const other = l.to_slug;
      if (!inScope.has(other)) continue; // both endpoints must be in scope
      if (l.from_slug === l.to_slug) continue; // ignore self-loops
      const eff = l.weight * l.confidence * reliabilityFor(l.source_type);
      const [a, b] = l.from_slug < l.to_slug ? [l.from_slug, l.to_slug] : [l.to_slug, l.from_slug];
      const key = `${a}|${b}`;
      const existing = edgeMap.get(key);
      edgeMap.set(
        key,
        existing
          ? { ...existing, weight: existing.weight + eff, linkCount: existing.linkCount + 1 }
          : { a, b, weight: eff, linkCount: 1 },
      );
    }
  }

  // Bidirectional adjacency from the aggregated undirected edges.
  const adjacency = new Map<string, Map<string, number>>();
  for (const { a, b, weight } of edgeMap.values()) {
    let na = adjacency.get(a);
    if (!na) { na = new Map(); adjacency.set(a, na); }
    na.set(b, weight);
    let nb = adjacency.get(b);
    if (!nb) { nb = new Map(); adjacency.set(b, nb); }
    nb.set(a, weight);
  }
  return { edgeMap, adjacency };
}

/** Deterministic connected components via BFS over slug-sorted starts. */
function connectedComponents(
  adjacency: Map<string, Map<string, number>>,
  slugs: string[],
): string[][] {
  const visited = new Set<string>();
  const comps: string[][] = [];
  for (const start of [...slugs].sort()) {
    if (visited.has(start)) continue;
    const comp: string[] = [];
    const queue: string[] = [start];
    visited.add(start);
    while (queue.length > 0) {
      const s = queue.shift()!;
      comp.push(s);
      const nbrs = adjacency.get(s);
      if (nbrs) {
        for (const nb of nbrs.keys()) {
          if (!visited.has(nb)) {
            visited.add(nb);
            queue.push(nb);
          }
        }
      }
    }
    comps.push(comp.sort());
  }
  return comps;
}

/**
 * Deterministic async label propagation. Each node adopts the weighted-dominant
 * label among its neighbors; ties break toward the alphabetically-smallest label.
 * Nodes are updated in slug order, so output is stable across runs. Components
 * are disconnected, so each connected component converges independently (the
 * largest component gets real subdivision; a small component collapses to one
 * community).
 */
function labelPropagation(
  adjacency: Map<string, Map<string, number>>,
  nonIsolates: string[],
  maxIter: number,
): Map<string, string> {
  const label = new Map<string, string>();
  for (const s of nonIsolates) label.set(s, s);

  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    for (const s of nonIsolates) {
      const nbrs = adjacency.get(s);
      if (!nbrs || nbrs.size === 0) continue;
      const tally = new Map<string, number>();
      for (const [nb, w] of nbrs) {
        const l = label.get(nb);
        if (l === undefined) continue;
        tally.set(l, (tally.get(l) ?? 0) + w);
      }
      if (tally.size === 0) continue;
      // Pick the heaviest label; ties break to the alphabetically-smallest label
      // so the chosen label is independent of Map iteration order — the result is
      // deterministic regardless of how neighbors were inserted.
      let best = "";
      let bestWeight = -1;
      for (const [l, w] of tally) {
        if (w > bestWeight || (w === bestWeight && (best === "" || l < best))) {
          best = l;
          bestWeight = w;
        }
      }
      if (best !== "" && best !== label.get(s)) {
        label.set(s, best);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return label;
}

function buildCommunities(
  nodeMap: Map<string, KnowledgeMapNode>,
  edgeMap: Map<string, AggregatedEdge>,
): KnowledgeMapAnalysis["communities"] {
  // Group nodes by community id.
  const groups = new Map<string, KnowledgeMapNode[]>();
  for (const n of nodeMap.values()) {
    if (n.communityId === undefined) continue; // isolates
    const arr = groups.get(n.communityId);
    if (arr) arr.push(n);
    else groups.set(n.communityId, [n]);
  }

  const communities = [];
  for (const [id, members] of groups) {
    const memberSet = new Set(members.map((m) => m.slug));
    let internalEdgeCount = 0;
    let totalInternalWeight = 0;
    for (const e of edgeMap.values()) {
      if (memberSet.has(e.a) && memberSet.has(e.b)) {
        internalEdgeCount += 1;
        totalInternalWeight += e.weight;
      }
    }
    const size = members.length;
    const density = size < 2 ? 0 : (2 * internalEdgeCount) / (size * (size - 1));
    const typeDistribution: Record<string, number> = {};
    for (const m of members) {
      typeDistribution[m.type] = (typeDistribution[m.type] ?? 0) + 1;
    }
    const topCoreNodes = [...members]
      .sort((a, b) => b.weightedDegree - a.weightedDegree || (a.slug < b.slug ? -1 : 1))
      .slice(0, TOP_CORE_NODES_CAP);
    communities.push({
      id,
      size,
      internalEdgeCount,
      density,
      totalInternalWeight,
      topCoreNodes,
      typeDistribution,
    });
  }
  // Deterministic order: by id (community-1, community-2, ...).
  return communities.sort((x, y) => (x.id < y.id ? -1 : 1));
}

function buildBridgeCandidates(
  nodeMap: Map<string, KnowledgeMapNode>,
  adjacency: Map<string, Map<string, number>>,
): KnowledgeMapAnalysis["bridgeCandidates"] {
  const candidates: KnowledgeMapAnalysis["bridgeCandidates"] = [];
  for (const n of nodeMap.values()) {
    if (n.degree === 0 || n.communityId === undefined) continue;
    const nbrs = adjacency.get(n.slug);
    if (!nbrs) continue;
    const neighborCommunities = new Set<string>();
    for (const nb of nbrs.keys()) {
      const nbNode = nodeMap.get(nb);
      if (nbNode?.communityId !== undefined) neighborCommunities.add(nbNode.communityId);
    }
    if (neighborCommunities.size > 1) {
      candidates.push({
        slug: n.slug,
        title: n.title,
        type: n.type,
        neighborCommunityIds: [...neighborCommunities].sort(),
      });
    }
  }
  return candidates.sort((a, b) => (a.slug < b.slug ? -1 : 1));
}

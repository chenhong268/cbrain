# Deterministic Graph Shortest Path Design

**Issue:** #326
**Parent:** #247
**Status:** Approved for implementation

## Problem

CBrain's connection workflow says pairwise relationship questions should prefer the shortest evidence path. The current `graph_query` API only expands from one seed with `traverse`, so an Agent must run multiple traversals and infer a path itself. That is slower, consumes more context, and can confuse nearby nodes with an ordered relationship chain.

## Goal

Add a bounded, deterministic, read-only shortest-path mode to the existing graph layer and `graph_query` tool. Given two resolvable entities, CBrain returns the ordered nodes and stored edges connecting them, or an explicit no-path result.

## Product Contract

- Pairwise relation questions can request one ordered A-to-B path directly.
- The default answer is natural language built from titles and relation names.
- Stored edge evidence remains available in `raw` for audit, but internal fields never appear in `display`.
- No path is reported as no path. Nearby nodes are not substituted.
- Existing `traverse`, `backlinks`, and `related` behavior remains unchanged.

## Architecture

### Core API

Add these types and method to `src/core/graph/graph.ts`:

```ts
export interface GraphPathNode {
  slug: string;
  title: string;
  type: string;
}

export interface GraphPath {
  nodes: GraphPathNode[];
  edges: Link[];
  depth: number;
}

export interface ShortestPathOptions {
  maxDepth?: number;
}

findShortestPath(fromSlug: string, toSlug: string, options?: ShortestPathOptions): GraphPath | null
```

The method uses bounded breadth-first search because Phase 1 optimizes hop count, not edge weight. SQLite remains the source of truth.

### Search Rules

- Default `maxDepth` is 4.
- Core callers are normalized with `Math.trunc` and clamped to the inclusive range 1 through 6. The shared MCP `depth` schema remains `z.number().optional()` so old modes keep their existing contract; only the `shortest_path` handler branch rejects non-integers and values outside 1 through 6.
- The search is bidirectional in edge orientation: either incoming or outgoing stored links may connect adjacent path nodes.
- Only links accepted by `isCurrentFactLink` participate.
- Candidate `reports_to` links are therefore excluded exactly as in normal traversal. Other candidate relation types retain existing graph-read semantics, but the formatter must label each such edge as a human-readable “待确认关系” rather than presenting it as confirmed fact.
- Each BFS depth calls `batchGetLinksForSlugs(frontier)` once.
- Each BFS depth batch-hydrates discovered neighbor slugs before marking them visited, so dangling links cannot mask a complete path and no per-node page lookup is introduced.
- A slug is visited once. The first discovered route is the shortest route.
- Neighbor expansion is sorted by neighbor slug, then relation, then edge id. This makes equal-length path selection independent of incidental SQLite row order.
- Parent state stores both predecessor slug and the exact link used. Reconstruction returns ordered nodes and ordered edges.
- A missing endpoint page returns `null`; `fromSlug === toSlug` returns a zero-edge path containing the existing page.

The deterministic sort is local to shortest-path search. It does not alter `traverse` ordering.

### MCP Contract

Extend the existing `graph_query` schema:

```ts
mode: "traverse" | "backlinks" | "related" | "shortest_path"
target?: string
```

The existing `depth` field becomes optional without a schema default. The handler applies mode-specific defaults: 2 for existing modes and 4 for `shortest_path`. This preserves old behavior while allowing the new mode's larger bounded search. Validation of integer range 1 through 6 occurs only inside the shortest-path branch; existing modes retain their current permissive numeric contract.

For `mode="shortest_path"`, `target` is required. Both `slug` and `target` use the existing entity resolver. Failure modes are explicit:

- unresolved source
- unresolved target
- no path within the depth budget

No new MCP tool is registered, so tool profiles and tool counts do not change.

### Response Envelope

Add a dedicated formatter in `src/mcp/tools/format-result.ts` or a focused sibling if the existing file boundary requires it.

The envelope follows the existing three-layer contract:

```ts
{
  display: string,
  summary: {
    status: "ok" | "empty" | "error",
    count: number,
    truncated: boolean,
    message: string,
    reason?: "path_found" | "no_path" | "unresolved_source" | "unresolved_target" | "missing_target" | "invalid_depth",
    fromTitle?: string,
    toTitle?: string,
    hops: number,
    maxDepth: number,
  },
  raw?: {
    path: GraphPath,
  },
}
```

This extends the existing `ToolSummary` shape rather than creating a new status vocabulary. `display` may contain human titles, natural relation labels, and the phrase “待确认关系” only when an included edge has `trust_state="candidate"`; trusted, user-thought, and legacy null states are not mislabeled as candidate. For every hop the formatter compares `edges[i].from_slug/to_slug` with `nodes[i]/nodes[i + 1]`: stored-forward traversal renders `A —relation→ B`; stored-reverse traversal renders `A ←relation— B`. It must never reverse a stored fact merely to make all arrows point from query source to target. Raw preserves the original edge orientation. `display` must not contain raw trust-state values, slugs, scores, `source_type`, confidence, debug labels, database ids, or local paths. The existing `graph_query` convention keeps audit detail in `raw`; no separate `include_raw` switch is introduced in this slice.

### Agent Routing

Update `skills/connect.md` and `skills/agent-facing.routing-eval.jsonl` so pairwise connection analysis requests `graph_query(mode="shortest_path", target=...)` first. Preserve a separate anonymous negative case proving that single-entity neighborhood questions still use `traverse`. Existing dual traversal is allowed only when shortest-path returns `summary.status="empty"` with `reason="no_path"` and the workflow needs shared-neighbor analysis. Any found path, including a multi-hop path, stops that fallback.

## Data and Mutation Boundaries

- Read-only graph operation.
- No page, link, confidence, mention count, discovery, or query-learning mutation is caused by shortest-path reconstruction.
- Shortest-path reads do not call `logQuery`, `learn.bumpOnQuery`, or `boostLinkConfidence`. Query-log rows feed delayed activity and link-weight learning, so logging a path would violate the read-only boundary; finding a path is not user confirmation of its truth.
- No schema migration, cache, snapshot, inferred link, or automatic repair.

## Error Handling

- Invalid or unresolved inputs return a structured error envelope instead of throwing from the MCP handler.
- Invalid shortest-path depth returns `status="error"`, `reason="invalid_depth"`, `hops=0`, and the requested numeric value in `maxDepth`; it never enters the graph core.
- Storage errors may propagate through the standard MCP error boundary; the algorithm does not silently convert database failure into “no path.”
- A path search reaching the depth limit returns `summary.status="empty"`, `reason="no_path"`, and the applied `maxDepth` budget.

## Tests

All fixtures use anonymous placeholders such as `entity/a`, `entity/b`, and `实体A`.

### Core tests

1. direct path returns two nodes and one exact edge;
2. two-hop path is ordered source to target;
3. shorter route wins over an available longer route;
4. cycles terminate without duplicate nodes;
5. no path and missing page return `null`;
6. same source and target returns a zero-hop path;
7. max depth is enforced, core values are truncated/clamped, and MCP rejects zero, negative, fractional, and greater-than-six depths;
8. candidate `reports_to` is excluded;
9. equal-hop alternatives use the documented deterministic tie-break;
10. query spy proves one batched link read per visited depth and no per-node link/title hydration.

### MCP and contract tests

1. both endpoints resolve from titles or slugs;
2. missing target is a structured invalid-input response;
3. found and no-path envelopes are stable;
4. `display` contains an ordered natural path and no internal fields;
5. `raw.path` preserves ordered link evidence;
6. shortest-path mode calls neither `learn.bumpOnQuery` nor `boostLinkConfidence`;
7. unresolved source and unresolved target each return the correct structured reason;
8. MCP mode defaults remain 2 for existing traversal and become 4 for shortest path;
9. ordinary candidate relations are visibly marked “待确认关系” while trusted, user-thought, and legacy-null relations are not; candidate `reports_to` is absent;
10. a stored incoming direct edge and a mixed-direction two-hop path render arrows without reversing relation semantics;
11. existing graph modes retain their permissive depth contract and remain byte-compatible under their current tests;
12. `skills/agent-facing.routing-eval.jsonl` requests shortest-path mode for pairwise relation questions and retains a single-entity traversal negative case.

## Adversarial Review Gate

Before merge, independently attack:

1. candidate or superseded fact leakage;
2. cycle and maximum-depth bypass;
3. nondeterministic equal-length alternatives;
4. N+1 database query regression;
5. display leakage of slug, score, source type, trust state, ids, or paths;
6. accidental write-side effects such as confidence boosting;
7. regressions to existing graph, hierarchy, search, and tool-profile contracts.

Every confirmed CRITICAL, HIGH, or MEDIUM finding must be fixed and re-tested before acceptance.

## Non-goals

- Weighted or Dijkstra path search.
- In-memory graph snapshots or cache invalidation.
- Personalized PageRank or centrality changes.
- Knowledge Map changes.
- Default recall ranking changes.
- New MCP tools or profile changes.
- LLM planning or classification.
- Automatic graph writes or trust upgrades.

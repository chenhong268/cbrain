import type { PageManager } from "../page.js";
import type { GraphManager } from "./graph.js";

export interface HierarchyDeps {
  pages: PageManager;
  graph: GraphManager;
}

export interface HierarchyContext {
  reports_to: string | null;
  reports_to_title: string | null;
  subordinates: Array<{ slug: string; title: string }>;
  peers: Array<{ slug: string; title: string }>;
}

// ── Org Tree types ──────────────────────────────────────────

export interface OrgTreeNode {
  slug: string;
  title: string;
  type: string;
  depth: number;
  parent_slug: string | null;
}

export interface OrgTreeResult {
  seed: { slug: string; title: string; type: string };
  upward: OrgTreeNode[];
  downward: OrgTreeNode[];
  warnings: string[];
}

export type OrgTreeDirection = "up" | "down" | "both";

export interface GetOrgTreeOptions {
  direction?: OrgTreeDirection;
  depth?: number;
  limit?: number;
}


// Hard bounds — callers cannot exceed these regardless of input
const MAX_DEPTH = 5;
const MAX_LIMIT = 100;

/**
 * Set the direct manager (reports_to) for an entity.
 * Writes to frontmatter + graph link (dual write).
 */
export function setHierarchy(
  slug: string,
  reportsToSlug: string,
  deps: HierarchyDeps,
): void {
  const { pages, graph } = deps;

  if (slug === reportsToSlug) {
    throw new Error("不能将自己设为上级");
  }

  const page = pages.getBySlug(slug);
  if (!page) throw new Error(`实体不存在: ${slug}`);

  const manager = pages.getBySlug(reportsToSlug);
  if (!manager) throw new Error(`上级实体不存在: ${reportsToSlug}`);

  // Write frontmatter
  pages.update(slug, { extra: { reports_to: reportsToSlug } });

  // Phase 1 #233: atomically supersede stale active reports_to edges (preserve
  // evidence) + upsert the new target as trusted+active, in one transaction.
  // Deterministic hierarchy set is authoritative. Provenance source_page_slug
  // = the subordinate (slug), so the edge stays traceable.
  graph.setActiveReportsTo(slug, reportsToSlug, "agent", 0.95, { source_page_slug: slug });
}

/**
 * Remove the reports_to hierarchy for an entity.
 * Returns the old reports_to slug, or null if none was set.
 */
export function removeHierarchy(
  slug: string,
  deps: HierarchyDeps,
): string | null {
  const { pages, graph } = deps;

  const page = pages.getBySlug(slug);
  if (!page) throw new Error(`实体不存在: ${slug}`);

  const oldReportsTo = (page.frontmatter.reports_to as string) ?? null;
  if (!oldReportsTo) return null;

  // Phase 1 #233: supersede the active reports_to edge (preserve evidence)
  // instead of hard-deleting it. "No current manager" is modelled as the
  // prior edge becoming stale, not erased.
  graph.supersedeReportsTo(slug);

  // Clear frontmatter reports_to (PageManager treats undefined as deletion).
  pages.update(slug, {
    body: page.body ?? "",
    extra: { reports_to: undefined },
  });

  return oldReportsTo;
}

/**
 * Get full hierarchy context for an entity: manager, subordinates, peers.
 */
export function getHierarchyContext(
  slug: string,
  deps: HierarchyDeps,
): HierarchyContext {
  const { pages, graph } = deps;

  const page = pages.getBySlug(slug);
  if (!page) {
    return { reports_to: null, reports_to_title: null, subordinates: [], peers: [] };
  }

  // Direct manager
  const reportsToSlug = (page.frontmatter.reports_to as string) ?? null;
  let reportsToTitle: string | null = null;
  if (reportsToSlug) {
    const managerPage = pages.getBySlug(reportsToSlug);
    reportsToTitle = managerPage?.title ?? null;
  }

  // Subordinates: current incoming reports_to edges (#233 HIGH 1 — candidate/
  // rejected/superseded edges are evidence, not current subordinates).
  const subordinates = graph.getCurrentReportsToLinks(slug, "incoming")
    .map(l => {
      const p = pages.getBySlug(l.from_slug);
      return { slug: l.from_slug, title: p?.title ?? l.from_slug };
    });

  // Peers: others who currently report to the same manager
  let peers: Array<{ slug: string; title: string }> = [];
  if (reportsToSlug) {
    peers = graph.getCurrentReportsToLinks(reportsToSlug, "incoming")
      .filter(l => l.from_slug !== slug)
      .map(l => {
        const p = pages.getBySlug(l.from_slug);
        return { slug: l.from_slug, title: p?.title ?? l.from_slug };
      });
  }

  return { reports_to: reportsToSlug, reports_to_title: reportsToTitle, subordinates, peers };
}

// ── Org Tree traversal ──────────────────────────────────────

/**
 * Build a full organizational tree from a seed entity by traversing
 * `reports_to` edges. Returns upward chain (managers), downward tree
 * (subordinates), or both.
 *
 * Uses a custom BFS that tracks parent_slug naturally during frontier
 * expansion — avoids the extra O(n) link lookups needed if we reused
 * GraphManager.traverse() (which doesn't return parent info).
 */
export function getOrgTree(
  seedSlug: string,
  deps: HierarchyDeps,
  options?: GetOrgTreeOptions,
): OrgTreeResult | null {
  const { pages, graph } = deps;
  const direction = options?.direction ?? "both";
  const rawDepth = options?.depth ?? 3;
  const rawLimit = options?.limit ?? 50;

  // Clamp to hard bounds — prevents runaway traversal
  const maxDepth = Math.min(Math.max(rawDepth, 1), MAX_DEPTH);
  const limit = Math.min(Math.max(rawLimit, 1), MAX_LIMIT);

  const seedPage = pages.getBySlug(seedSlug);
  if (!seedPage) return null;

  const seed = { slug: seedSlug, title: seedPage.title, type: seedPage.type };
  const warnings: string[] = [];

  // Warn if caller exceeded hard bounds
  if (rawDepth > MAX_DEPTH) warnings.push(`depth ${rawDepth} 超出上限，已截断为 ${MAX_DEPTH}`);
  if (rawLimit > MAX_LIMIT) warnings.push(`limit ${rawLimit} 超出上限，已截断为 ${MAX_LIMIT}`);

  const upward = (direction === "up" || direction === "both")
    ? traverseReportsTo(seedSlug, graph, pages, "up", maxDepth, limit, warnings)
    : [];

  const downward = (direction === "down" || direction === "both")
    ? traverseReportsTo(seedSlug, graph, pages, "down", maxDepth, limit, warnings)
    : [];

  return { seed, upward, downward, warnings };
}

/**
 * BFS over reports_to edges in one direction.
 *
 * - "up": follows outgoing reports_to links (subordinate → manager).
 *   For each slug in the frontier, find the to_slug of outgoing reports_to links.
 * - "down": follows incoming reports_to links (manager → subordinate).
 *   For each slug in the frontier, find the from_slug of incoming reports_to links.
 */
function traverseReportsTo(
  seedSlug: string,
  graph: GraphManager,
  pages: PageManager,
  dir: "up" | "down",
  maxDepth: number,
  limit: number,
  warnings: string[],
): OrgTreeNode[] {
  const visited = new Set<string>([seedSlug]);
  const results: OrgTreeNode[] = [];
  let frontier: Array<{ slug: string; parent: string | null }> = [{ slug: seedSlug, parent: null }];
  let totalFound = 0;
  let cycleWarned = false;

  for (let depth = 1; depth <= maxDepth; depth++) {
    const nextFrontier: Array<{ slug: string; parent: string | null }> = [];

    for (const { slug: currentSlug } of frontier) {
      // Find neighbors along reports_to edges in the desired direction
      const links = getReportsToLinks(graph, currentSlug, dir);

      for (const neighborSlug of links) {
        if (visited.has(neighborSlug)) {
          // Cycle detected — warn once, then skip
          if (!cycleWarned) {
            warnings.push(`检测到循环引用: ${neighborSlug}`);
            cycleWarned = true;
          }
          continue;
        }

        visited.add(neighborSlug);
        const neighborPage = pages.getBySlug(neighborSlug);
        // Include all entities that have hierarchy edges, even stubs
        const title = neighborPage?.title ?? neighborSlug;
        const type = neighborPage?.type ?? "unknown";

        const node: OrgTreeNode = {
          slug: neighborSlug,
          title,
          type,
          depth,
          parent_slug: currentSlug,
        };
        results.push(node);
        nextFrontier.push({ slug: neighborSlug, parent: currentSlug });
        totalFound++;

        if (totalFound >= limit) {
          warnings.push(`结果被截断（达到 limit=${limit}）`);
          return results;
        }
      }
    }

    if (nextFrontier.length === 0) break;
    frontier = nextFrontier;
  }

  return results;
}

/**
 * Extract neighbor slugs along reports_to edges in a given direction.
 *
 * - "up": outgoing reports_to links → the to_slug is the manager.
 *   Link direction: (current) --reports_to--> (manager)
 * - "down": incoming reports_to links → the from_slug is the subordinate.
 *   Link direction: (subordinate) --reports_to--> (current)
 */
function getReportsToLinks(
  graph: GraphManager,
  slug: string,
  dir: "up" | "down",
): string[] {
  // Phase 1 #233 (HIGH 1): current-fact reads only. candidate/rejected/
  // superseded edges are evidence, not current managers/subordinates. They
  // stay visible via includeInactive=true / debug / raw / evidence paths.
  const direction = dir === "up" ? "outgoing" : "incoming";
  const links = graph.getCurrentReportsToLinks(slug, direction);

  const neighbors = new Set<string>();
  for (const link of links) {
    if (dir === "up") {
      // outgoing: from_slug = current, to_slug = manager
      neighbors.add(link.to_slug);
    } else {
      // incoming: to_slug = current, from_slug = subordinate
      neighbors.add(link.from_slug);
    }
  }
  return Array.from(neighbors);
}

import { CBrainDB } from "../../storage/sqlite.js";

export interface Link {
  id: number;
  from_slug: string;
  to_slug: string;
  relation: string;
  weight: number;
  strength: string;
  context?: string;
  source_type?: string;
  confidence?: number;
  trust_state?: string;
  source_page_slug?: string;
  evidence?: string;
}

export interface GraphNode {
  slug: string;
  title: string;
  type: string;
  depth: number;
}

export interface TraverseOptions {
  direction?: "outgoing" | "incoming" | "both";
  relation?: string;
  minWeight?: number;
  maxDepth?: number;
  limit?: number;
}

/**
 * #233 HIGH 1: candidate reports_to is evidence, not a confirmed default
 * graph-read edge. Excluded from getLinks / getBacklinks / traverse /
 * getRelatedEntities. rejected/superseded are already excluded by the storage
 * active filter (these reads default to includeInactive=false). Ordinary
 * non-reports_to candidate links are unaffected (candidate is a legitimate
 * pending edge for every other relation).
 */
function isDefaultGraphReadLink(l: { relation?: string; trust_state?: string }): boolean {
  return !(l.relation === "reports_to" && l.trust_state === "candidate");
}

export class GraphManager {
  private db: CBrainDB;

  constructor(db: CBrainDB) {
    this.db = db;
  }

  addLink(from: string, to: string, relation: string = "mentions", context?: string, weight?: number, strength?: string, sourceType?: string, confidence?: number): void {
    this.db.insertLink(from, to, relation, context ?? null, weight, strength, sourceType, confidence);
  }

  removeLink(from: string, to: string, relation: string = "mentions"): boolean {
    return this.db.deleteLink(from, to, relation);
  }

  /** Phase 1 #233: supersede active reports_to edges, preserving evidence. */
  supersedeReportsTo(from: string, exceptToSlug?: string): number {
    return this.db.supersedeReportsTo(from, exceptToSlug);
  }

  /** Phase 1 #233 (HIGH 1): current (authoritative) reports_to edges — excludes candidate. */
  getCurrentReportsToLinks(slug: string, direction: "outgoing" | "incoming"): Link[] {
    return this.db.getCurrentReportsToLinks(slug, direction) as Link[];
  }

  /**
   * Phase 1 #233: atomically make `to` the sole active reports_to of `from`.
   * Supersede + upsert run in one transaction so callers never observe zero
   * active reports_to (or two active managers) mid-write. Forwards provenance
   * so hierarchy-set edges stay traceable (source_page_slug = the subordinate).
   */
  setActiveReportsTo(
    from: string,
    to: string,
    sourceType = "agent",
    confidence = 0.95,
    provenance?: { source_page_slug?: string; evidence?: string },
  ): void {
    this.db.transaction(() => {
      this.db.supersedeReportsTo(from, to);
      this.db.upsertActiveReportsTo(from, to, sourceType, confidence, provenance);
    });
  }

  getLinks(slug: string, direction: "outgoing" | "incoming" | "both" = "both"): Link[] {
    const results: Link[] = [];

    if (direction === "outgoing" || direction === "both") {
      results.push(...this.db.getOutgoingLinks(slug) as Link[]);
    }

    if (direction === "incoming" || direction === "both") {
      results.push(...this.db.getIncomingLinks(slug) as Link[]);
    }

    return results.filter(isDefaultGraphReadLink);
  }

  getBacklinks(slug: string): Link[] {
    return this.getLinks(slug, "incoming");
  }

  traverse(seedSlug: string, options?: TraverseOptions): GraphNode[] {
    const direction = options?.direction ?? "both";
    const relation = options?.relation;
    const minWeight = options?.minWeight;
    const maxDepth = options?.maxDepth ?? 2;
    const limit = options?.limit ?? 50;

    const visited = new Set<string>();
    visited.add(seedSlug);

    let frontier = [seedSlug];
    const results: GraphNode[] = [];

    for (let depth = 1; depth <= maxDepth; depth++) {
      const nextFrontier: string[] = [];

      // One unified path covers all three filter modes (minWeight / relation /
      // none). batchGetLinksForSlugs returns LinkRow with relation + trust_state,
      // so isDefaultGraphReadLink can exclude candidate reports_to (#233 HIGH 1).
      const batchLinks = this.db.batchGetLinksForSlugs(frontier);
      for (const slug of frontier) {
        const links = batchLinks.get(slug);
        if (!links) continue;
        const all = [
          ...(direction === "outgoing" || direction === "both" ? links.outgoing : []),
          ...(direction === "incoming" || direction === "both" ? links.incoming : []),
        ];
        for (const l of all) {
          if (!isDefaultGraphReadLink(l)) continue;
          if (relation && l.relation !== relation) continue;
          if (minWeight !== undefined && (l.effective_weight ?? l.weight * l.confidence) < minWeight) continue;
          const neighbor = l.from_slug === slug ? l.to_slug : l.from_slug;
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            nextFrontier.push(neighbor);
          }
        }
      }

      const titles = this.db.getPageTitlesAndTypes(nextFrontier);
      for (const neighbor of nextFrontier) {
        const page = titles.get(neighbor);
        if (page) {
          results.push({ slug: neighbor, title: page.title, type: page.type, depth });
          if (results.length >= limit) return results;
        }
      }

      if (nextFrontier.length === 0) break;
      frontier = nextFrontier;
    }

    return results;
  }

  getRelatedEntities(slug: string, limit: number = 10): GraphNode[] {
    // #233: getLinks already excludes candidate reports_to from default reads.
    const neighbors = this.getLinks(slug, "both")
      .map((l) => (l.from_slug === slug ? l.to_slug : l.from_slug))
      .filter((n) => n !== slug);
    const sorted = this.sortSlugsByMentionCount(neighbors);

    const batch = this.db.getPageTitlesAndTypes(sorted);
    const results: GraphNode[] = [];
    for (const neighbor of sorted) {
      const page = batch.get(neighbor);
      if (page) {
        results.push({ slug: neighbor, title: page.title, type: page.type, depth: 1 });
        if (results.length >= limit) break;
      }
    }

    return results;
  }

  private sortSlugsByMentionCount(slugs: string[]): string[] {
    if (slugs.length === 0) return [];

    const rows = this.db.getPagesBySlugsOrdered(slugs);

    const ordered = new Set(rows.map((r) => r.slug));
    return [...ordered, ...slugs.filter((s) => !ordered.has(s))];
  }
}

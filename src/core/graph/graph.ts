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

    return results;
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

      // Batch-fetch links for entire frontier
      if (minWeight !== undefined) {
        const batchLinks = this.db.batchGetLinksForSlugs(frontier);
        const neighborSlugs = new Set<string>();
        for (const slug of frontier) {
          const links = batchLinks.get(slug);
          if (!links) continue;
          const all = [
            ...(direction === "outgoing" || direction === "both" ? links.outgoing : []),
            ...(direction === "incoming" || direction === "both" ? links.incoming : []),
          ];
          for (const l of all) {
            if ((!relation || l.relation === relation) && (l.effective_weight ?? l.weight * l.confidence) >= minWeight) {
              const neighbor = l.from_slug === slug ? l.to_slug : l.from_slug;
              if (!visited.has(neighbor)) {
                visited.add(neighbor);
                nextFrontier.push(neighbor);
                neighborSlugs.add(neighbor);
              }
            }
          }
        }
        // Batch-fetch titles for all new neighbors
        const titles = this.db.getPageTitlesAndTypes([...neighborSlugs]);
        for (const neighbor of nextFrontier) {
          const page = titles.get(neighbor);
          if (page) {
            results.push({ slug: neighbor, title: page.title, type: page.type, depth });
            if (results.length >= limit) return results;
          }
        }
      } else if (relation !== undefined) {
        // relation filter needs getLinkedSlugs per slug (no batch for filtered)
        for (const slug of frontier) {
          const slugs = this.getNeighbors(slug, direction, relation);
          for (const neighbor of slugs) {
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
      } else {
        // No relation filter — use lightweight batch neighbor fetch
        const batchNeighbors = this.db.getLinksForSlugs(frontier);
        const neighborSlugs: string[] = [];
        for (const slug of frontier) {
          const entry = batchNeighbors.get(slug);
          if (!entry) continue;
          const candidates = [
            ...(direction === "outgoing" || direction === "both" ? entry.outgoing : []),
            ...(direction === "incoming" || direction === "both" ? entry.incoming : []),
          ];
          for (const neighbor of candidates) {
            if (!visited.has(neighbor)) {
              visited.add(neighbor);
              nextFrontier.push(neighbor);
              neighborSlugs.push(neighbor);
            }
          }
        }
        const titles = this.db.getPageTitlesAndTypes(neighborSlugs);
        for (const neighbor of nextFrontier) {
          const page = titles.get(neighbor);
          if (page) {
            results.push({ slug: neighbor, title: page.title, type: page.type, depth });
            if (results.length >= limit) return results;
          }
        }
      }

      frontier = nextFrontier;
    }

    return results;
  }

  getRelatedEntities(slug: string, limit: number = 10): GraphNode[] {
    const neighbors = this.getNeighbors(slug, "both");
    const sorted = this.sortSlugsByMentionCount(neighbors.filter(n => n !== slug));

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

  private getNeighbors(slug: string, direction: string, relation?: string): string[] {
    const neighbors = new Set<string>();

    if (direction === "outgoing" || direction === "both") {
      for (const s of this.db.getLinkedSlugs(slug, "from", relation)) {
        neighbors.add(s);
      }
    }

    if (direction === "incoming" || direction === "both") {
      for (const s of this.db.getLinkedSlugs(slug, "to", relation)) {
        neighbors.add(s);
      }
    }

    return Array.from(neighbors);
  }

  private sortSlugsByMentionCount(slugs: string[]): string[] {
    if (slugs.length === 0) return [];

    const rows = this.db.getPagesBySlugsOrdered(slugs);

    const ordered = new Set(rows.map((r) => r.slug));
    return [...ordered, ...slugs.filter((s) => !ordered.has(s))];
  }
}

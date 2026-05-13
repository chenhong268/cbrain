import { CBrainDB } from "../storage/sqlite.js";

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

      for (const slug of frontier) {
        let slugs: string[];
        if (minWeight !== undefined) {
          const links = [
            ...(direction === "outgoing" || direction === "both" ? this.db.getOutgoingLinks(slug) : []),
            ...(direction === "incoming" || direction === "both" ? this.db.getIncomingLinks(slug) : []),
          ];
          slugs = [...new Set(
            links
              .filter(l => (!relation || l.relation === relation) && l.weight >= minWeight)
              .map(l => l.from_slug === slug ? l.to_slug : l.from_slug)
          )];
        } else {
          slugs = this.getNeighbors(slug, direction, relation);
        }

        for (const neighbor of slugs) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            nextFrontier.push(neighbor);

            const page = this.db.getPageTitleAndType(neighbor);

            if (page) {
              results.push({
                slug: neighbor,
                title: page.title,
                type: page.type,
                depth,
              });

              if (results.length >= limit) {
                return results;
              }
            }
          }
        }
      }

      frontier = nextFrontier;
    }

    return results;
  }

  getRelatedEntities(slug: string, limit: number = 10): GraphNode[] {
    // Depth-1 neighbors, sorted by mention count
    const neighbors = this.getNeighbors(slug, "both");
    const visited = new Set<string>([slug]);
    const results: GraphNode[] = [];

    const sorted = this.sortSlugsByMentionCount(neighbors.filter((n) => !visited.has(n)));
    for (const neighbor of sorted) {
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);

      const page = this.db.getPageTitleAndType(neighbor);

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

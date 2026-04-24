import { CBrainDB } from "../storage/sqlite.js";

export interface Link {
  id: number;
  from_slug: string;
  to_slug: string;
  relation: string;
  context?: string;
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
  maxDepth?: number;
  limit?: number;
}

export class GraphManager {
  private db: CBrainDB;

  constructor(db: CBrainDB) {
    this.db = db;
  }

  addLink(from: string, to: string, relation: string = "mentions", context?: string): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO links (from_slug, to_slug, relation, context) VALUES ($from, $to, $rel, $ctx)`
    ).run({ $from: from, $to: to, $rel: relation, $ctx: context ?? null });
  }

  removeLink(from: string, to: string, relation: string = "mentions"): boolean {
    const result = this.db.prepare(
      `DELETE FROM links WHERE from_slug = $from AND to_slug = $to AND relation = $rel`
    ).run({ $from: from, $to: to, $rel: relation });
    return result.changes > 0;
  }

  getLinks(slug: string, direction: "outgoing" | "incoming" | "both" = "both"): Link[] {
    const results: Link[] = [];

    if (direction === "outgoing" || direction === "both") {
      const out = this.db.prepare(
        "SELECT * FROM links WHERE from_slug = $slug"
      ).all({ $slug: slug }) as Link[];
      results.push(...out);
    }

    if (direction === "incoming" || direction === "both") {
      const inc = this.db.prepare(
        "SELECT * FROM links WHERE to_slug = $slug"
      ).all({ $slug: slug }) as Link[];
      results.push(...inc);
    }

    return results;
  }

  getBacklinks(slug: string): Link[] {
    return this.getLinks(slug, "incoming");
  }

  traverse(seedSlug: string, options?: TraverseOptions): GraphNode[] {
    const direction = options?.direction ?? "both";
    const relation = options?.relation;
    const maxDepth = options?.maxDepth ?? 2;
    const limit = options?.limit ?? 50;

    const visited = new Set<string>();
    visited.add(seedSlug);

    let frontier = [seedSlug];
    const results: GraphNode[] = [];

    for (let depth = 1; depth <= maxDepth; depth++) {
      const nextFrontier: string[] = [];

      for (const slug of frontier) {
        const neighbors = this.getNeighbors(slug, direction, relation);

        for (const neighbor of neighbors) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            nextFrontier.push(neighbor);

            const page = this.db
              .prepare("SELECT title, type FROM pages WHERE slug = $slug")
              .get({ $slug: neighbor }) as { title: string; type: string } | null;

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

      const page = this.db
        .prepare("SELECT title, type FROM pages WHERE slug = $slug")
        .get({ $slug: neighbor }) as { title: string; type: string } | null;

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
      let sql = "SELECT to_slug FROM links WHERE from_slug = $slug";
      const params: any = { $slug: slug };
      if (relation) {
        sql += " AND relation = $rel";
        params.$rel = relation;
      }
      for (const row of this.db.prepare(sql).all(params) as Array<{ to_slug: string }>) {
        neighbors.add(row.to_slug);
      }
    }

    if (direction === "incoming" || direction === "both") {
      let sql = "SELECT from_slug FROM links WHERE to_slug = $slug";
      const params: any = { $slug: slug };
      if (relation) {
        sql += " AND relation = $rel";
        params.$rel = relation;
      }
      for (const row of this.db.prepare(sql).all(params) as Array<{ from_slug: string }>) {
        neighbors.add(row.from_slug);
      }
    }

    return Array.from(neighbors);
  }

  private sortSlugsByMentionCount(slugs: string[]): string[] {
    if (slugs.length === 0) return [];

    const placeholders = slugs.map(() => "?").join(",");
    const rows = this.db.prepare(
      `SELECT slug FROM pages WHERE slug IN (${placeholders}) ORDER BY mention_count DESC`
    ).all(...slugs) as Array<{ slug: string }>;

    const ordered = new Set(rows.map((r) => r.slug));
    return [...ordered, ...slugs.filter((s) => !ordered.has(s))];
  }
}

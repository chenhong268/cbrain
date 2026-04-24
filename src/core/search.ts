import { CBrainDB } from "../storage/sqlite.js";
import type { EmbeddingProvider } from "../embedding/provider.js";
import { LanceDBManager as LanceDBStorage } from "../storage/lancedb.js";

export interface SearchResult {
  slug: string;
  score: number;
  snippet: string;
  source: "vector" | "fts" | "graph" | "hybrid";
}

export interface SearchOptions {
  limit?: number;
  strategy?: "vector" | "fts" | "graph" | "all";
}

export interface HybridSearchConfig {
  rrf_k?: number;
}

export function rrfScore(ranks: number[], k: number): number {
  if (ranks.length === 0) return 0;
  return ranks.reduce((sum, rank) => sum + 1 / (k + rank), 0);
}

export function mergeRankedResults(
  lists: SearchResult[][],
  k: number,
  limit: number
): SearchResult[] {
  if (lists.length === 0) return [];

  const slugData = new Map<
    string,
    { ranks: number[]; bestSnippet: string; bestScore: number }
  >();

  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank];
      const existing = slugData.get(item.slug);
      if (existing) {
        existing.ranks.push(rank + 1);
        if (item.score > existing.bestScore) {
          existing.bestScore = item.score;
          existing.bestSnippet = item.snippet;
        }
      } else {
        slugData.set(item.slug, {
          ranks: [rank + 1],
          bestSnippet: item.snippet,
          bestScore: item.score,
        });
      }
    }
  }

  const results: SearchResult[] = [];
  for (const [slug, data] of slugData) {
    results.push({
      slug,
      score: rrfScore(data.ranks, k),
      snippet: data.bestSnippet,
      source: "hybrid",
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

export class HybridSearch {
  private db: CBrainDB;
  private embedding: EmbeddingProvider;
  private lance: LanceDBStorage;
  private rrfK: number;

  constructor(
    db: CBrainDB,
    embedding: EmbeddingProvider,
    lance: LanceDBStorage,
    config?: HybridSearchConfig
  ) {
    this.db = db;
    this.embedding = embedding;
    this.lance = lance;
    this.rrfK = config?.rrf_k ?? 60;
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    if (!query.trim()) return [];

    const limit = options?.limit ?? 10;
    const strategy = options?.strategy ?? "all";

    if (strategy === "vector") {
      return this.vectorSearch(query, limit);
    }
    if (strategy === "fts") {
      return this.ftsSearch(query, limit);
    }
    if (strategy === "graph") {
      return this.graphSearch(query, limit);
    }

    const [vectorResults, ftsResults, graphResults] = await Promise.all([
      this.vectorSearch(query, limit).catch(() => [] as SearchResult[]),
      Promise.resolve(this.ftsSearch(query, limit)),
      this.graphSearch(query, limit).catch(() => [] as SearchResult[]),
    ]);

    const lists: SearchResult[][] = [];
    if (vectorResults.length > 0) lists.push(vectorResults);
    if (ftsResults.length > 0) lists.push(ftsResults);
    if (graphResults.length > 0) lists.push(graphResults);

    return mergeRankedResults(lists, this.rrfK, limit);
  }

  private async vectorSearch(query: string, limit: number): Promise<SearchResult[]> {
    const { embedding } = await this.embedding.embed(query);
    const results = await this.lance.search(embedding, limit);
    return results.map((r) => ({
      slug: r.pageSlug,
      score: r._distance != null ? 1 - r._distance : 0,
      snippet: r.content.slice(0, 200),
      source: "vector" as const,
    }));
  }

  private ftsSearch(query: string, limit: number): SearchResult[] {
    const results = this.db.ftsSearch(query, limit);
    return results.map((r) => ({
      slug: r.page_slug,
      score: 1 / (1 - r.rank),
      snippet: r.content.slice(0, 200),
      source: "fts" as const,
    }));
  }

  async graphSearch(seedSlug: string, limit: number): Promise<SearchResult[]> {
    const visited = new Set<string>();
    visited.add(seedSlug);

    let frontier = [seedSlug];
    const results: SearchResult[] = [];

    for (let depth = 0; depth < 2; depth++) {
      const nextFrontier: string[] = [];

      for (const slug of frontier) {
        const outLinks = this.db
          .prepare("SELECT to_slug FROM links WHERE from_slug = $slug")
          .all({ $slug: slug }) as Array<{ to_slug: string }>;

        const inLinks = this.db
          .prepare("SELECT from_slug FROM links WHERE to_slug = $slug")
          .all({ $slug: slug }) as Array<{ from_slug: string }>;

        const neighbors = [
          ...outLinks.map((l) => l.to_slug),
          ...inLinks.map((l) => l.from_slug),
        ];

        for (const neighbor of neighbors) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            nextFrontier.push(neighbor);

            const page = this.db
              .prepare("SELECT title FROM pages WHERE slug = $slug")
              .get({ $slug: neighbor }) as { title: string } | null;

            results.push({
              slug: neighbor,
              score: 1 / (depth + 1),
              snippet: page?.title ?? neighbor,
              source: "graph",
            });

            if (results.length >= limit) {
              return results;
            }
          }
        }
      }

      frontier = nextFrontier;
    }

    return results;
  }
}

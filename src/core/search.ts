import { CBrainDB } from "../storage/sqlite.js";
import type { EmbeddingProvider } from "../embedding/provider.js";
import type { LLMProvider } from "../llm/provider.js";
import { LanceDBManager as LanceDBStorage } from "../storage/lancedb.js";

export interface SearchResult {
  slug: string;
  score: number;
  snippet: string;
  source: "vector" | "fts" | "graph" | "hybrid" | "temporal" | "exact";
}

export interface SearchOptions {
  limit?: number;
  strategy?: "vector" | "fts" | "graph" | "all";
  multiQuery?: boolean;
}

export interface HybridSearchConfig {
  rrf_k?: number;
  multiQuery?: boolean;
}

export function rrfScore(ranks: number[], k: number): number {
  if (ranks.length === 0) return 0;
  return ranks.reduce((sum, rank) => sum + 1 / (k + rank), 0);
}

const W_ACTIVITY = 0.15;
const W_HOTNESS = 0.12;

export function mergeRankedResults(
  lists: SearchResult[][],
  k: number,
  limit: number,
  activityWeights?: Map<string, number>,
  hotnessWeights?: Map<string, number>
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
    const activityBonus = activityWeights ? W_ACTIVITY * (activityWeights.get(slug) ?? 0) : 0;
    const hotnessBonus = hotnessWeights ? W_HOTNESS * (hotnessWeights.get(slug) ?? 0) : 0;
    results.push({
      slug,
      score: rrfScore(data.ranks, k) + activityBonus + hotnessBonus,
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
  private llm?: LLMProvider;
  private multiQueryEnabled: boolean;
  private queryCache = new Map<string, { queries: string[]; expires: number }>();
  private static QUERY_CACHE_TTL = 300_000; // 5 minutes

  constructor(
    db: CBrainDB,
    embedding: EmbeddingProvider,
    lance: LanceDBStorage,
    config?: HybridSearchConfig & { llm?: LLMProvider }
  ) {
    this.db = db;
    this.embedding = embedding;
    this.lance = lance;
    this.rrfK = config?.rrf_k ?? 60;
    this.llm = config?.llm;
    this.multiQueryEnabled = config?.multiQuery ?? true;
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

    // Exact title match fast path
    const exact = this.db.getPageByTitle(query.trim());
    if (exact) {
      return [{ slug: exact.slug, score: 1.0, snippet: exact.title, source: "exact" as const }];
    }

    const useMultiQuery = (options?.multiQuery ?? this.multiQueryEnabled) && !!this.llm;
    const queries = useMultiQuery ? await this.expandQuery(query) : [query];

    const allLists: SearchResult[][] = [];

    for (const q of queries) {
      // Resolve query to slug for graph traversal
      const resolved = this.db.resolveSlugs([q])[0];
      const graphPromise = resolved?.slug
        ? this.graphSearch(resolved.slug, limit).catch((e) => {
            console.error("[search] graphSearch 失败:", e);
            return [] as SearchResult[];
          })
        : Promise.resolve([] as SearchResult[]);

      const [vec, fts, graph, temporal] = await Promise.all([
        this.vectorSearch(q, limit).catch((e) => {
          console.error("[search] vectorSearch 失败:", e);
          return [] as SearchResult[];
        }),
        Promise.resolve(this.ftsSearch(q, limit)).catch((e) => {
          console.error("[search] ftsSearch 失败:", e);
          return [] as SearchResult[];
        }),
        graphPromise,
        Promise.resolve(this.temporalSearch(q, limit)),
      ]);
      if (vec.length > 0) allLists.push(vec);
      if (fts.length > 0) allLists.push(fts);
      if (graph.length > 0) allLists.push(graph);
      if (temporal.length > 0) allLists.push(temporal);
    }

    // Fetch activity weights for all candidate slugs
    const allSlugs = new Set<string>();
    for (const list of allLists) for (const item of list) allSlugs.add(item.slug);
    const activityWeights = allSlugs.size > 0 ? this.db.getActivityWeights([...allSlugs]) : undefined;
    const hotnessWeights = allSlugs.size > 0 ? this.db.getHotnessWeights([...allSlugs]) : undefined;

    return mergeRankedResults(allLists, this.rrfK, limit, activityWeights, hotnessWeights);
  }

  private async expandQuery(query: string): Promise<string[]> {
    if (!this.llm) return [query];

    const cached = this.queryCache.get(query);
    if (cached && Date.now() < cached.expires) return cached.queries;

    try {
      const resp = await this.llm.chat([
        {
          role: "system",
          content:
            "你是一个搜索查询扩展助手。给定一个查询，生成2-3个语义相近但角度不同的查询变体，" +
            "帮助提高搜索召回率。只返回JSON数组，不要其他内容。示例：[\"变体1\",\"变体2\",\"变体3\"]",
        },
        { role: "user", content: query },
      ]);

      const variants = JSON.parse(resp) as string[];
      if (!Array.isArray(variants) || variants.length === 0) return [query];
      const queries = [query, ...variants.filter((v) => typeof v === "string" && v.trim())];
      this.queryCache.set(query, { queries, expires: Date.now() + HybridSearch.QUERY_CACHE_TTL });
      if (this.queryCache.size > 100) {
        const oldest = this.queryCache.keys().next().value;
        if (oldest !== undefined) this.queryCache.delete(oldest);
      }
      return queries;
    } catch (e) {
      console.error("[search] 查询扩展失败:", e);
      return [query];
    }
  }

  private async vectorSearch(query: string, limit: number): Promise<SearchResult[]> {
    const { embedding } = await this.embedding.embed(query);
    const results = await this.lance.search(embedding, limit * 3);

    const bySlug = new Map<string, { content: string; score: number }>();
    for (const r of results) {
      const existing = bySlug.get(r.pageSlug);
      if (!existing || r.chunkIndex === -1) {
        bySlug.set(r.pageSlug, {
          content: r.content,
          score: r._distance != null ? 1 - r._distance : 0,
        });
      }
    }

    return [...bySlug.entries()].slice(0, limit).map(([slug, v]) => ({
      slug,
      score: v.score,
      snippet: v.content.slice(0, 200),
      source: "vector" as const,
    }));
  }

  private ftsSearch(query: string, limit: number): SearchResult[] {
    const results = this.db.ftsSearch(query, limit);
    return results.map((r) => ({
      slug: r.page_slug,
      score: 1 / (1 - Math.min(r.rank, 0.999)),
      snippet: r.content.slice(0, 200),
      source: "fts" as const,
    }));
  }

  private temporalSearch(query: string, limit: number): SearchResult[] {
    const results = this.db.searchTimeline(query, undefined, limit);
    return results.map((r) => ({
      slug: r.page_slug,
      score: 0.5,
      snippet: `${r.event_date ?? "?"}: ${r.summary}${r.source ? ` [${r.source}]` : ""}`,
      source: "temporal" as const,
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
        const outSlugs = this.db.getOutgoingSlugs(slug);
        const inSlugs = this.db.getIncomingSlugs(slug);

        const neighbors = [...outSlugs, ...inSlugs];

        for (const neighbor of neighbors) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            nextFrontier.push(neighbor);

            const pageTitle = this.db.getPageTitle(neighbor);

            results.push({
              slug: neighbor,
              score: 1 / (depth + 1),
              snippet: pageTitle ?? neighbor,
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

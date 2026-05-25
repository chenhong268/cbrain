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
  /** @internal Skip decomposition for sub-queries (prevents recursion) */
  _skipDecompose?: boolean;
  /** Enable sufficiency check + retry loop + LLM reranking for deeper search */
  multiStep?: boolean;
}

export interface HybridSearchConfig {
  rrf_k?: number;
  multiQuery?: boolean;
}

export interface GraphContext {
  entities: Array<{
    slug: string;
    title: string;
    type: string;
    neighbors: Array<{ slug: string; title: string; relation: string }>;
  }>;
  chains: string[];
}

const COMPLEXITY_CONJUNCTIONS = ["和", "与", "跟", "以及"];
const QUESTION_WORDS = ["什么", "哪些", "怎么", "如何"];
const MIN_TOKENS_FOR_COMPLEXITY = 3;
const MAX_GRAPH_CONTEXT_CHARS = 2000;
const MAX_NEIGHBORS_PER_ENTITY = 5;
const MAX_CHAINS_PER_ENTITY = 3;

export function isComplexQuery(
  query: string,
  knownSlugs: string[],
  candidates?: string[]
): boolean {
  if (!query.trim()) return false;

  // 2+ known entities → complex
  if (knownSlugs.length >= 2) return true;

  // Conjunction words → complex
  for (const conj of COMPLEXITY_CONJUNCTIONS) {
    if (query.includes(conj)) return true;
  }

  // Multiple question words → complex
  let questionCount = 0;
  for (const qw of QUESTION_WORDS) {
    if (query.includes(qw)) questionCount++;
  }
  if (questionCount >= 2) return true;

  // Agent-rewritten queries: space-separated tokens >= 3 → complex
  const tokens = candidates ?? query.split(/[\s,，、；;]+/).filter((w) => w.length >= 2);
  if (tokens.length >= MIN_TOKENS_FOR_COMPLEXITY) return true;

  return false;
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

    // Auto-enable multiStep for complex queries when LLM is available
    const shouldMultiStep = options?.multiStep === true ||
      (options?.multiStep === undefined && this.llm && this.isMultiStepCandidate(query));

    if (shouldMultiStep && this.llm) {
      return this.searchMultiStep(query, options ?? {});
    }
    return this.searchCore(query, options);
  }

  private isMultiStepCandidate(query: string): boolean {
    const candidates = query.split(/[\s,，、；;和与跟以及]+/).filter((w) => w.length >= 2);
    const resolved = this.db.resolveSlugs(candidates);
    const knownSlugs = resolved.filter((r) => r.slug !== null).map((r) => r.slug!);
    return isComplexQuery(query, knownSlugs, candidates);
  }

  private async searchCore(query: string, options?: SearchOptions): Promise<SearchResult[]> {
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

    // Decomposition path for complex queries
    if (this.llm && !options?._skipDecompose) {
      const candidates = query.split(/[\s,，、；;和与跟以及]+/).filter((w) => w.length >= 2);
      const resolved = this.db.resolveSlugs(candidates);
      const knownSlugs = resolved.filter((r) => r.slug !== null).map((r) => r.slug!);

      if (isComplexQuery(query, knownSlugs, candidates)) {
        try {
          const graphContext = await this.graphPrefetch(query);
          const subQueries = await this.decomposeQuery(query, graphContext);

          console.error(`[search] decomposition: "${query}" → ${subQueries.length} sub-queries: ${subQueries.join(" | ")}`);
          if (subQueries.length >= 2) {
            const subResults = await Promise.all(
              subQueries.map((sq) =>
                this.search(sq, { ...(options ?? {}), _skipDecompose: true }).catch(() => [] as SearchResult[])
              )
            );

            const allSubLists = subResults.filter((r) => r.length > 0);
            if (allSubLists.length > 0) {
              const allSlugs = new Set<string>();
              for (const list of allSubLists) for (const item of list) allSlugs.add(item.slug);
              const activityWeights = allSlugs.size > 0 ? this.db.getActivityWeights([...allSlugs]) : undefined;
              const hotnessWeights = allSlugs.size > 0 ? this.db.getHotnessWeights([...allSlugs]) : undefined;
              return mergeRankedResults(allSubLists, this.rrfK, limit, activityWeights, hotnessWeights);
            }
          }
        } catch (e) {
          console.error("[search] decomposition 路径失败，fallback 到 expandQuery:", e);
        }
      }
    }

    return this.searchWithExpansion(query, limit, options?.multiQuery);
  }

  private async searchWithExpansion(query: string, limit: number, multiQuery?: boolean): Promise<SearchResult[]> {
    const useMultiQuery = (multiQuery ?? this.multiQueryEnabled) && !!this.llm;
    const queries = useMultiQuery ? await this.expandQuery(query) : [query];

    const allLists: SearchResult[][] = [];

    for (const q of queries) {
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

    const allSlugs = new Set<string>();
    for (const list of allLists) for (const item of list) allSlugs.add(item.slug);
    const activityWeights = allSlugs.size > 0 ? this.db.getActivityWeights([...allSlugs]) : undefined;
    const hotnessWeights = allSlugs.size > 0 ? this.db.getHotnessWeights([...allSlugs]) : undefined;

    return mergeRankedResults(allLists, this.rrfK, limit, activityWeights, hotnessWeights);
  }

  // ─── multiStep: sufficiency check + retry + rerank ─────────────

  private static readonly SUFFICIENCY_MAX_RETRIES = 2;

  private async searchMultiStep(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const limit = options.limit ?? 10;
    let bestResults: SearchResult[] = [];
    let lastCount = -1;

    for (let attempt = 0; attempt <= HybridSearch.SUFFICIENCY_MAX_RETRIES; attempt++) {
      const attemptOptions: SearchOptions = { ...options };
      if (attempt === 1) {
        attemptOptions.multiQuery = true;
        delete attemptOptions.strategy;
      } else if (attempt === 2) {
        attemptOptions.multiQuery = true;
        attemptOptions._skipDecompose = true;
        delete attemptOptions.strategy;
      }

      const results = await this.searchCore(query, attemptOptions);
      if (results.length > bestResults.length) bestResults = results;

      // Empty results — no point retrying, vault simply doesn't have it
      if (results.length === 0) break;

      // No improvement over last attempt — stop spinning
      if (results.length === lastCount) break;
      lastCount = results.length;

      const sufficient = await this.checkSufficiency(query, results);
      if (sufficient) { bestResults = results; break; }

      console.error(`[search] multiStep attempt ${attempt + 1} insufficient, retrying...`);
    }

    if (this.llm && bestResults.length > 1) {
      bestResults = await this.rerankResults(query, bestResults);
    }

    return bestResults.slice(0, limit);
  }

  private async checkSufficiency(query: string, results: SearchResult[]): Promise<boolean> {
    if (!this.llm || results.length === 0) return results.length > 0;

    const summaries = results.slice(0, 10).map(
      (r, i) => `${i + 1}. [${r.slug}] ${r.snippet.slice(0, 100)}`
    ).join("\n");

    try {
      const resp = await this.llm.chat([
        {
          role: "system",
          content:
            "你是搜索结果充分性评估器。判断搜索结果是否足以回答用户的查询。\n" +
            "只考虑信息覆盖度和相关性，忽略结果数量本身。\n" +
            '输出JSON: {"sufficient": true/false, "reason": "简短说明"}',
        },
        { role: "user", content: `查询: ${query}\n\n搜索结果:\n${summaries}` },
      ]);

      const parsed = JSON.parse(resp) as { sufficient: boolean; reason: string };
      console.error(`[search] sufficiency: ${parsed.sufficient} — ${parsed.reason}`);
      return parsed.sufficient === true;
    } catch {
      console.error("[search] sufficiency check failed, assuming sufficient");
      return true;
    }
  }

  private async rerankResults(query: string, results: SearchResult[]): Promise<SearchResult[]> {
    if (!this.llm || results.length <= 1) return results;

    const info = results.map(
      (r, i) => `${i + 1}. slug="${r.slug}" snippet="${r.snippet.slice(0, 80)}"`
    ).join("\n");

    try {
      const resp = await this.llm.chat([
        {
          role: "system",
          content:
            "你是搜索结果排序器。根据与查询的相关性，对搜索结果重新排序。\n" +
            "最相关的排最前。只返回排序后的编号数组。\n" +
            '输出JSON: {"order": [3, 1, 2, ...]}，编号从1开始，对应输入顺序。',
        },
        { role: "user", content: `查询: ${query}\n\n结果:\n${info}` },
      ]);

      const parsed = JSON.parse(resp) as { order: number[] };
      if (!Array.isArray(parsed.order) || parsed.order.length === 0) return results;

      const reordered: SearchResult[] = [];
      const seen = new Set<number>();
      for (const idx of parsed.order) {
        if (idx >= 1 && idx <= results.length && !seen.has(idx)) {
          seen.add(idx);
          reordered.push(results[idx - 1]);
        }
      }
      for (let i = 0; i < results.length; i++) {
        if (!seen.has(i + 1)) reordered.push(results[i]);
      }
      return reordered;
    } catch {
      console.error("[search] reranking failed, returning original order");
      return results;
    }
  }

  async graphPrefetch(query: string): Promise<GraphContext> {
    const context: GraphContext = { entities: [], chains: [] };

    const candidates = query
      .split(/[\s,，、；;和与跟以及]+/)
      .filter((w) => w.length >= 2);
    if (candidates.length === 0) return context;

    try {
      const resolved = this.db.resolveSlugs(candidates);
      const known = resolved.filter((r) => r.slug !== null);

      for (const r of known) {
        const outgoing = this.db.getOutgoingLinks(r.slug!);
        const incoming = this.db.getIncomingLinks(r.slug!);

        // Map to { slug, relation }, dedup by slug (keep first occurrence)
        const seen = new Set<string>();
        const neighborEntries: Array<{ slug: string; relation: string }> = [];
        for (const link of outgoing) {
          if (!seen.has(link.to_slug)) {
            seen.add(link.to_slug);
            neighborEntries.push({ slug: link.to_slug, relation: link.relation });
          }
        }
        for (const link of incoming) {
          if (!seen.has(link.from_slug)) {
            seen.add(link.from_slug);
            neighborEntries.push({ slug: link.from_slug, relation: link.relation });
          }
        }

        const neighborData: Array<{
          slug: string;
          title: string;
          relation: string;
        }> = [];
        for (const entry of neighborEntries.slice(0, MAX_NEIGHBORS_PER_ENTITY)) {
          const info = this.db.getPageTitleAndType(entry.slug);
          if (info) {
            neighborData.push({ slug: entry.slug, title: info.title, relation: entry.relation });
          }
        }

        const pageType = this.db.getPageTitleAndType(r.slug!);
        context.entities.push({
          slug: r.slug!,
          title: r.title ?? r.slug!,
          type: pageType?.type ?? "unknown",
          neighbors: neighborData,
        });
      }

      for (const entity of context.entities) {
        for (const neighbor of entity.neighbors.slice(0, MAX_CHAINS_PER_ENTITY)) {
          context.chains.push(
            `${entity.title} --${neighbor.relation}--> ${neighbor.title}`
          );
        }
      }

      const chainsStr = context.chains.join("\n");
      if (chainsStr.length > MAX_GRAPH_CONTEXT_CHARS) {
        let total = 0;
        const trimmed: string[] = [];
        for (const chain of context.chains) {
          if (total + chain.length > MAX_GRAPH_CONTEXT_CHARS) break;
          trimmed.push(chain);
          total += chain.length;
        }
        context.chains = trimmed;
      }
    } catch (e) {
      console.error("[search] graphPrefetch 失败:", e);
    }

    return context;
  }

  private static MAX_SUB_QUERIES = 5;

  async decomposeQuery(
    query: string,
    graphContext: GraphContext
  ): Promise<string[]> {
    if (!this.llm) return [query];

    const contextParts: string[] = [];
    if (graphContext.entities.length > 0) {
      contextParts.push("已知实体:");
      for (const e of graphContext.entities) {
        const neighborStr =
          e.neighbors.length > 0
            ? e.neighbors.map((n) => `${n.title}(${n.relation})`).join(", ")
            : "无邻居";
        contextParts.push(`- ${e.title} (${e.type}) → 邻居: ${neighborStr}`);
      }
    }
    if (graphContext.chains.length > 0) {
      contextParts.push("关系链:");
      for (const chain of graphContext.chains) {
        contextParts.push(`- ${chain}`);
      }
    }
    const contextStr =
      contextParts.length > 0 ? contextParts.join("\n") : "无图谱信息";

    try {
      const resp = await this.llm.chat([
        {
          role: "system",
          content:
            "你是查询分解器。把复杂查询拆成2-5个独立的子查询。必须至少拆成2个。\n\n" +
            "规则:\n" +
            "- 每个子查询必须能独立检索，不依赖其他子查询的结果\n" +
            "- 利用图谱中的已知关系指导拆分方向\n" +
            "- 按实体/概念/维度拆分，不要把所有实体塞进一个子查询\n" +
            "- 每个子查询聚焦一个实体或一个比较维度\n" +
            '- 输出JSON: {"sub_queries":[{"sub_query":"...","intent":"..."}]}\n\n' +
            `图谱上下文:\n${contextStr}`,
        },
        { role: "user", content: `查询: ${query}` },
      ]);

      const parsed = JSON.parse(resp) as {
        sub_queries: Array<{ sub_query: string; intent: string }>;
      };
      if (
        !Array.isArray(parsed.sub_queries) ||
        parsed.sub_queries.length === 0
      )
        return [query];

      return parsed.sub_queries
        .slice(0, HybridSearch.MAX_SUB_QUERIES)
        .map((sq) => sq.sub_query)
        .filter((q) => typeof q === "string" && q.trim());
    } catch (e) {
      console.error("[search] decomposeQuery 失败:", e);
      return [query];
    }
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
      score: Math.abs(r.rank),
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

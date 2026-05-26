import { CBrainDB } from "../storage/sqlite.js";
import type { EmbeddingProvider } from "../embedding/provider.js";
import type { LLMProvider } from "../llm/provider.js";
import { LanceDBManager as LanceDBStorage } from "../storage/lancedb.js";
import { ResearchManager } from "./research.js";

export interface SearchResult {
  slug: string;
  score: number;
  snippet: string;
  source: "vector" | "fts" | "graph" | "hybrid" | "temporal" | "exact";
}

export interface SearchHints {
  knownSlugs: string[];
  isComplex: boolean;
}

export interface SearchTrace {
  expand_ms?: number;
  vector_ms?: number;
  fts_ms?: number;
  graph_ms?: number;
  temporal_ms?: number;
  decompose_ms?: number;
  rerank_ms?: number;
  llm_calls?: number;
  degraded_reason?: string;
  follow_up_queries?: string[];
  query_variants?: string[];
}

export interface SearchOptions {
  limit?: number;
  strategy?: "vector" | "fts" | "graph" | "all";
  multiQuery?: boolean;
  /** @internal Skip decomposition for sub-queries (prevents recursion) */
  _skipDecompose?: boolean;
  /** Enable sufficiency check + retry loop + LLM reranking for deeper search */
  multiStep?: boolean;
  /** @internal Pre-computed hints to avoid redundant resolveSlugs/isComplexQuery calls */
  _hints?: SearchHints;
  /** @internal Trace accumulator for per-stage timing diagnostics */
  _trace?: SearchTrace;
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
  private embeddingCache = new Map<string, { embedding: number[]; expires: number }>();
  private static QUERY_CACHE_TTL = 300_000; // 5 minutes
  private static EMBEDDING_CACHE_TTL = 300_000;
  private static CACHE_MAX_SIZE = 100;

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
    const trace = options?._trace;

    if (strategy === "vector") {
      return this.timedCall(() => this.vectorSearch(query, limit), trace, "vector_ms");
    }
    if (strategy === "fts") {
      return this.timedCall(() => Promise.resolve(this.ftsSearch(query, limit)), trace, "fts_ms");
    }
    if (strategy === "graph") {
      return this.timedCall(() => this.graphSearch(query, limit), trace, "graph_ms");
    }

    // Exact title match fast path
    const exact = this.db.getPageByTitle(query.trim());
    if (exact) {
      return [{ slug: exact.slug, score: 1.0, snippet: exact.title, source: "exact" as const }];
    }

    // Decomposition path for complex queries
    if (this.llm && !options?._skipDecompose) {
      const hints = options?._hints;
      let knownSlugs: string[];
      let complex: boolean;

      if (hints) {
        knownSlugs = hints.knownSlugs;
        complex = hints.isComplex;
      } else {
        const candidates = query.split(/[\s,，、；;和与跟以及]+/).filter((w) => w.length >= 2);
        const resolved = this.db.resolveSlugs(candidates);
        knownSlugs = resolved.filter((r) => r.slug !== null).map((r) => r.slug!);
        complex = isComplexQuery(query, knownSlugs, candidates);
      }

      if (complex) {
        try {
          const graphContext = await this.graphPrefetch(query);
          const subQueries = await this.timedCall(
            () => this.decomposeQuery(query, graphContext), trace, "decompose_ms",
          );
          if (trace) trace.llm_calls = (trace.llm_calls ?? 0) + 1;

          console.error(`[search] decomposition: "${query}" → ${subQueries.length} sub-queries: ${subQueries.join(" | ")}`);
          if (subQueries.length >= 2) {
            const subResults = await Promise.all(
              subQueries.map((sq) =>
                this.search(sq, { ...(options ?? {}), _skipDecompose: true, _trace: trace }).catch(() => [] as SearchResult[])
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

    return this.searchWithExpansion(query, limit, options?.multiQuery, trace);
  }

  private async searchSingleQuery(q: string, limit: number, trace?: SearchTrace): Promise<SearchResult[][]> {
    const resolved = this.db.resolveSlugs([q])[0];

    const [vec, fts, graph, temporal] = await Promise.all([
      this.timedCall(() => this.vectorSearch(q, limit), trace, "vector_ms").catch((e) => {
        console.error("[search] vectorSearch 失败:", e);
        return [] as SearchResult[];
      }),
      this.timedCall(() => Promise.resolve(this.ftsSearch(q, limit)), trace, "fts_ms").catch((e) => {
        console.error("[search] ftsSearch 失败:", e);
        return [] as SearchResult[];
      }),
      resolved?.slug
        ? this.timedCall(() => this.graphSearch(resolved.slug!, limit), trace, "graph_ms").catch((e) => {
            console.error("[search] graphSearch 失败:", e);
            return [] as SearchResult[];
          })
        : Promise.resolve([] as SearchResult[]),
      this.timedCall(() => Promise.resolve(this.temporalSearch(q, limit)), trace, "temporal_ms").catch((e) => {
        console.error("[search] temporalSearch 失败:", e);
        return [] as SearchResult[];
      }),
    ]);

    const lists: SearchResult[][] = [];
    if (vec.length > 0) lists.push(vec);
    if (fts.length > 0) lists.push(fts);
    if (graph.length > 0) lists.push(graph);
    if (temporal.length > 0) lists.push(temporal);
    return lists;
  }

  private async searchWithExpansion(query: string, limit: number, multiQuery?: boolean, trace?: SearchTrace): Promise<SearchResult[]> {
    const t0 = Date.now();
    const useMultiQuery = (multiQuery ?? this.multiQueryEnabled) && !!this.llm;
    const queries = useMultiQuery
      ? await this.timedCall(() => this.expandQuery(query), trace, "expand_ms")
      : [query];

    if (trace && useMultiQuery) {
      trace.query_variants = queries;
      trace.llm_calls = (trace.llm_calls ?? 0) + 1;
    }

    const queryResults = await Promise.all(
      queries.map((q) => this.searchSingleQuery(q, limit, trace))
    );
    const allLists = queryResults.flat();

    const allSlugs = new Set<string>();
    for (const list of allLists) for (const item of list) allSlugs.add(item.slug);
    const activityWeights = allSlugs.size > 0 ? this.db.getActivityWeights([...allSlugs]) : undefined;
    const hotnessWeights = allSlugs.size > 0 ? this.db.getHotnessWeights([...allSlugs]) : undefined;

    const totalMs = Date.now() - t0;
    console.error(`[search] expansion: ${queries.length} queries, expand=${trace?.expand_ms ?? 0}ms, total=${totalMs}ms, slugs=${allSlugs.size}`);

    return mergeRankedResults(allLists, this.rrfK, limit, activityWeights, hotnessWeights);
  }

  private async timedCall<T>(
    fn: () => Promise<T>,
    trace: SearchTrace | undefined,
    key: "vector_ms" | "fts_ms" | "graph_ms" | "temporal_ms" | "expand_ms" | "decompose_ms",
  ): Promise<T> {
    if (!trace) return fn();
    const start = Date.now();
    try {
      return await fn();
    } finally {
      trace[key] = (trace[key] ?? 0) + (Date.now() - start);
    }
  }

  // ─── multiStep: delegates to ResearchManager (ReAct loop) ───────

  private async searchMultiStep(query: string, options: SearchOptions): Promise<SearchResult[]> {
    if (!this.llm) return this.searchCore(query, options);
    const trace = options._trace;
    const start = Date.now();
    const researcher = new ResearchManager(this, this.db, this.llm);
    const results = await researcher.research(query, options);
    if (trace) {
      trace.expand_ms = (trace.expand_ms ?? 0) + (Date.now() - start);
      trace.llm_calls = (trace.llm_calls ?? 0) + researcher.getLLMCallCount();
    }
    return results;
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
    const cached = this.embeddingCache.get(query);
    let embedding: number[];
    if (cached && Date.now() < cached.expires) {
      embedding = cached.embedding;
    } else {
      const result = await this.embedding.embed(query);
      embedding = result.embedding;
      this.embeddingCache.set(query, { embedding, expires: Date.now() + HybridSearch.EMBEDDING_CACHE_TTL });
      if (this.embeddingCache.size > HybridSearch.CACHE_MAX_SIZE) {
        const oldest = this.embeddingCache.keys().next().value;
        if (oldest !== undefined) this.embeddingCache.delete(oldest);
      }
    }
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

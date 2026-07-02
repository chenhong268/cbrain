import type { CBrainDB } from "../../storage/sqlite.js";
import type { LLMProvider } from "../../llm/provider.js";
import type { HybridSearch, SearchResult, SearchOptions, GraphContext } from "./search.js";
import { isCurrentFactLink } from "../shared.js";

const MAX_NEIGHBORS_PER_ENTITY = 5;

function normalizeQuery(q: string): string {
  return q.toLowerCase().replace(/[\s。，、；：！？,.:;!?]+/g, "");
}

interface ResearchSession {
  readonly originalQuery: string;
  readonly iteration: number;
  readonly maxIterations: number;
  readonly discoveredSlugs: ReadonlySet<string>;
  readonly issuedQueries: ReadonlySet<string>;
  readonly allResults: readonly SearchResult[];
  readonly graphContext: GraphContext;
}

interface ResearchReasoning {
  reasoning: string;
  sufficient: boolean;
  follow_up_queries: Array<{ query: string; intent: string }>;
}

export interface ResearchConfig {
  maxIterations?: number;
  maxFollowUpQueries?: number;
}

export class ResearchManager {
  private readonly maxIterations: number;
  private readonly maxFollowUpQueries: number;
  private llmCallCount = 0;

  constructor(
    private readonly search: HybridSearch,
    private readonly db: CBrainDB,
    private readonly llm?: LLMProvider,
    config?: ResearchConfig,
    private readonly logger?: import("../logger.js").Logger,
  ) {
    this.maxIterations = config?.maxIterations ?? 3;
    this.maxFollowUpQueries = config?.maxFollowUpQueries ?? 3;
  }

  getLLMCallCount(): number {
    return this.llmCallCount;
  }

  async research(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const limit = options?.limit ?? 10;
    const trace = options?._trace;

    if (!this.llm) return this.search.search(query, { ...options, multiStep: false, _skipDetailEnrich: true });

    let session = this.createSession(query);

    const initialResults = await this.search.search(query, {
      ...options,
      multiStep: false,
      _skipDetailEnrich: true,
    });
    if (initialResults.length === 0) return [];

    session = this.updateSession(session, initialResults, 0);

    for (let i = 0; i < this.maxIterations; i++) {
      const reasoning = await this.reasonAboutResults(session);
      if (!reasoning || reasoning.sufficient) {
        if (trace && !reasoning) {
          trace.degraded_reason = "reasoning_parse_failed";
        }
        break;
      }

      // Same-round dedup: normalize + deduplicate within this LLM response first
      const seenThisRound = new Set<string>();
      const uniqueQueries = (reasoning.follow_up_queries ?? []).filter(q => {
        const n = normalizeQuery(q.query);
        if (seenThisRound.has(n)) return false;
        seenThisRound.add(n);
        return true;
      });

      // Filter history, then slice — valid queries after dupes are preserved
      const issuedNormalized = new Set([...session.issuedQueries].map(normalizeQuery));
      const newQueries = uniqueQueries
        .map(q => q.query)
        .filter(q => !issuedNormalized.has(normalizeQuery(q)))
        .slice(0, this.maxFollowUpQueries);
      if (newQueries.length === 0) break;

      if (trace) {
        trace.follow_up_queries = [...(trace.follow_up_queries ?? []), ...newQueries];
      }

      let newResults: SearchResult[] = [];
      const allSubResults = await Promise.all(
        newQueries.map(fq =>
          this.search.search(fq, {
            limit: 10,
            multiStep: false,
            _skipDecompose: true,
            _skipDetailEnrich: true,
            _trace: trace,
          }).catch((e) => {
            this.logger?.error("research", "sub-query failed", { error: e instanceof Error ? e.message : String(e) });
            return [] as SearchResult[];
          })
        )
      );
      for (const subResults of allSubResults) {
        newResults = this.mergeResults(newResults, subResults);
      }

      session = this.updateSession(session, newResults, i + 1, newQueries);
    }

    const rerankStart = Date.now();
    const reranked = await this.rerankResults(query, session.allResults);
    if (trace) {
      trace.rerank_ms = Date.now() - rerankStart;
    }
    return reranked.slice(0, limit);
  }

  private createSession(query: string): ResearchSession {
    return {
      originalQuery: query,
      iteration: 0,
      maxIterations: this.maxIterations,
      discoveredSlugs: new Set(),
      issuedQueries: new Set([query]),
      allResults: [],
      graphContext: { entities: [], chains: [] },
    };
  }

  private updateSession(
    session: ResearchSession,
    newResults: readonly SearchResult[],
    iteration: number,
    newQueries: readonly string[] = [],
  ): ResearchSession {
    const merged = this.mergeResults(session.allResults, newResults);
    const newSlugs = merged
      .map(r => r.slug)
      .filter(s => !session.discoveredSlugs.has(s));
    const expandedGraph = this.expandGraphContext(session.graphContext, newSlugs);
    const allSlugs = new Set([...session.discoveredSlugs, ...newSlugs]);
    const allQueries = new Set([...session.issuedQueries, ...newQueries]);

    return {
      originalQuery: session.originalQuery,
      iteration,
      maxIterations: session.maxIterations,
      discoveredSlugs: allSlugs,
      issuedQueries: allQueries,
      allResults: merged,
      graphContext: expandedGraph,
    };
  }

  mergeResults(
    existing: readonly SearchResult[] | SearchResult[],
    incoming: readonly SearchResult[] | SearchResult[],
  ): SearchResult[] {
    const map = new Map<string, SearchResult>();
    for (const r of existing) map.set(r.slug, r);
    for (const r of incoming) {
      const prev = map.get(r.slug);
      if (!prev || r.score > prev.score) map.set(r.slug, r);
    }
    return [...map.values()].sort((a, b) => b.score - a.score);
  }

  expandGraphContext(
    current: GraphContext,
    newSlugs: string[],
  ): GraphContext {
    if (newSlugs.length === 0) return current;

    const existingSlugs = new Set(current.entities.map(e => e.slug));
    const slugsToAdd = newSlugs.filter(s => !existingSlugs.has(s));
    if (slugsToAdd.length === 0) return current;

    const titlesAndTypes = this.db.getPageTitlesAndTypes(slugsToAdd);
    const linksMap = this.db.batchGetLinksForSlugs(slugsToAdd);

    const newEntities: GraphContext["entities"] = [];
    for (const slug of slugsToAdd) {
      const info = titlesAndTypes.get(slug);
      if (!info) continue;

      const links = linksMap.get(slug);
      const neighbors: GraphContext["entities"][number]["neighbors"] = [];
      if (links) {
        const outgoing = links.outgoing.filter(isCurrentFactLink);
        const incoming = links.incoming.filter(isCurrentFactLink);
        const allNeighborSlugs = [
          ...outgoing.map(l => l.to_slug),
          ...incoming.map(l => l.from_slug),
        ];
        const uniqueNeighbors = [...new Set(allNeighborSlugs)].slice(0, MAX_NEIGHBORS_PER_ENTITY);
        const neighborTitles = this.db.getPageTitlesAndTypes(uniqueNeighbors);
        for (const ns of uniqueNeighbors) {
          const nInfo = neighborTitles.get(ns);
          if (nInfo) {
            const relation = outgoing.find(l => l.to_slug === ns)?.relation
              ?? incoming.find(l => l.from_slug === ns)?.relation
              ?? "related";
            neighbors.push({ slug: ns, title: nInfo.title, relation });
          }
        }
      }

      newEntities.push({
        slug,
        title: info.title,
        type: info.type,
        neighbors,
      });
    }

    const newChains = newEntities.map(e =>
      `${e.title} → ${e.neighbors.map(n => n.title).join(" → ")}`
    );

    return {
      entities: [...current.entities, ...newEntities],
      chains: [...current.chains, ...newChains],
    };
  }

  private async reasonAboutResults(
    session: ResearchSession,
  ): Promise<ResearchReasoning | null> {
    if (!this.llm) return null;

    const resultsSummary = session.allResults.slice(0, 10).map(
      (r, i) => `${i + 1}. [${r.slug}] ${r.snippet.slice(0, 100)}`,
    ).join("\n");

    const graphSummary = session.graphContext.entities.slice(0, 10).map(
      e => `${e.title}(${e.type}): 邻居=[${e.neighbors.map(n => n.title).join(", ")}]`,
    ).join("\n");

    const issuedList = [...session.issuedQueries].join("、");

    try {
      this.llmCallCount++;
      const resp = await this.llm.chat([
        {
          role: "system",
          content:
            "你是知识图谱搜索推理引擎。分析当前搜索结果和图谱邻居，判断信息是否充分回答原始查询。\n\n" +
            "规则：\n" +
            "- 确信已充分回答原始查询时才 sufficient=true\n" +
            "- follow_up_queries 最多3个，不能与已搜过的查询重复\n" +
            "- 利用图谱邻居中的新实体指导搜索方向（如发现两个实体有共同邻居，搜它们的交集）\n" +
            "- 每个查询聚焦一个未探索的方向（交集、缺失维度、间接关联）\n" +
            '- 不要搜索已发现的实体本身，而是搜索它们之间的关联\n\n' +
            '输出JSON: {"reasoning":"分析说明","sufficient":true/false,"follow_up_queries":[{"query":"搜索查询","intent":"意图"}]}',
        },
        {
          role: "user",
          content:
            `原始查询: ${session.originalQuery}\n` +
            `已搜索: ${issuedList}\n` +
            `第 ${session.iteration}/${session.maxIterations} 轮\n\n` +
            `搜索结果:\n${resultsSummary}\n\n` +
            `图谱邻居:\n${graphSummary || "（暂无）"}\n\n` +
            `已发现实体: ${[...session.discoveredSlugs].join("、")}`,
        },
      ]);

      const parsed = JSON.parse(resp) as ResearchReasoning;
      if (typeof parsed.sufficient !== "boolean") return null;

      return {
        reasoning: parsed.reasoning ?? "",
        sufficient: parsed.sufficient,
        follow_up_queries: parsed.follow_up_queries ?? [],
      };
    } catch {
      this.logger?.error("research", "reasoning failed, assuming sufficient");
      return null;
    }
  }

  private async rerankResults(
    query: string,
    results: readonly SearchResult[],
  ): Promise<SearchResult[]> {
    if (!this.llm || results.length <= 1) return [...results];

    const info = results.map(
      (r, i) => `${i + 1}. slug="${r.slug}" snippet="${r.snippet.slice(0, 80)}"`,
    ).join("\n");

    try {
      this.llmCallCount++;
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
      if (!Array.isArray(parsed.order) || parsed.order.length === 0) return [...results];

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
      this.logger?.error("research", "reranking failed, returning original order");
      return [...results];
    }
  }
}

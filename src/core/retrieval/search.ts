import { CBrainDB } from "../../storage/sqlite.js";
import type { EmbeddingProvider } from "../../embedding/provider.js";
import type { LLMProvider } from "../../llm/provider.js";
import { LanceDBManager as LanceDBStorage } from "../../storage/lancedb.js";
import { ResearchManager } from "./research.js";
import { isCurrentFactLink } from "../shared.js";
import { GraphManager } from "../graph/graph.js";
import type { Logger } from "../logger.js";
import {
  attachRetrievalSupport,
  computeCosineSimilarity,
  computeRootLexicalCoverage,
  getRetrievalSupport,
  type RetrievalChannelEvidence,
  type RetrievalQueryOrigin,
  type RetrievalSupport,
  type RetrievalSupportChannel,
} from "./retrieval-support.js";

export interface SealedDetailHit {
  /** Raw-chunk fragment recovered from a sealed page. User-visible. */
  snippet: string;
  /** Internal-only marker. Never emitted to Hermes-facing display. */
  level: "raw_chunk";
}

export interface SearchResult {
  slug: string;
  score: number;
  snippet: string;
  source: "vector" | "fts" | "graph" | "hybrid" | "temporal" | "exact";
  /**
   * Detail-level evidence recovered from a sealed page's raw chunks.
   * `snippet` is surfaced to users; `level` is internal-only (never displayed).
   * Undefined for unsealed pages or when no raw chunk matches.
   */
  detail?: SealedDetailHit;
}

export interface SearchHints {
  knownSlugs: string[];
  isComplex: boolean;
}

export interface SearchTrace {
  expand_ms?: number;
  research_ms?: number;
  vector_ms?: number;
  fts_ms?: number;
  fts_fallback?: boolean;
  graph_ms?: number;
  temporal_ms?: number;
  decompose_ms?: number;
  rerank_ms?: number;
  llm_calls?: number;
  degraded_reason?: string;
  expand_skipped?: string;
  decompose_skipped?: string;
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
  /** @internal Skip sealed detail enrichment (set for recursive sub-queries). */
  _skipDetailEnrich?: boolean;
  /** @internal Capture bounded channel-native support for content recall. */
  _captureSupport?: boolean;
  /** @internal Root query used for query-relative lexical support. */
  _supportRootQuery?: string;
  /** @internal Whether this search text is the caller query or a generated child. */
  _supportOrigin?: RetrievalQueryOrigin;
  /** @internal Shared one-shot override claimed only by a leg that already performs vector search. */
  _supportVectorOverride?: {
    readonly query: string;
    readonly origin: RetrievalQueryOrigin;
    claimed: boolean;
  };
}

export interface HybridSearchConfig {
  rrf_k?: number;
  multiQuery?: boolean;
  logger?: Logger;
  /**
   * #248 — GraphManager used by graphSearch's batched traversal. When omitted,
   * HybridSearch constructs a stateless `new GraphManager(this.db)` so existing
   * call sites (CLI, tests) keep working without changes.
   */
  graph?: GraphManager;
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

interface SearchSupportContext {
  readonly capture: boolean;
  readonly rootQuery: string;
  readonly origin: RetrievalQueryOrigin;
  readonly vectorOverride?: {
    readonly query: string;
    readonly origin: RetrievalQueryOrigin;
    claimed: boolean;
  };
}

const NO_SUPPORT_CONTEXT: SearchSupportContext = Object.freeze({
  capture: false,
  rootQuery: "",
  origin: "original",
});

function resolveSupportContext(query: string, options?: SearchOptions): SearchSupportContext {
  if (options?._captureSupport !== true) return NO_SUPPORT_CONTEXT;
  return {
    capture: true,
    rootQuery: options?._supportRootQuery ?? query,
    origin: options?._supportOrigin ?? "original",
    ...(options?._supportVectorOverride === undefined
      ? {}
      : { vectorOverride: options._supportVectorOverride }),
  };
}

function resolveVectorSlot(
  query: string,
  context: SearchSupportContext,
): { readonly query: string; readonly support: SearchSupportContext } {
  const override = context.vectorOverride;
  if (!context.capture || override === undefined || override.claimed) {
    return { query, support: context };
  }
  override.claimed = true;
  return {
    query: override.query,
    support: {
      capture: true,
      rootQuery: context.rootQuery,
      origin: override.origin,
    },
  };
}

function attachDirectSupport(
  result: SearchResult,
  channel: RetrievalSupportChannel,
  context: SearchSupportContext,
  optional?: Partial<RetrievalChannelEvidence>,
): SearchResult {
  if (!context.capture) return result;
  const {
    rankScore = result.score,
    vectorCosineSimilarity,
    rootLexicalCoverage,
  } = optional ?? {};
  const evidence: RetrievalChannelEvidence = {
    rankScore,
    ...(vectorCosineSimilarity === undefined ? {} : { vectorCosineSimilarity }),
    ...(rootLexicalCoverage === undefined ? {} : { rootLexicalCoverage }),
  };
  return attachRetrievalSupport(result, {
    [channel]: { [context.origin]: evidence },
  });
}

function selectStrongerEvidence(
  channel: RetrievalSupportChannel,
  current: RetrievalChannelEvidence | undefined,
  candidate: RetrievalChannelEvidence,
): RetrievalChannelEvidence {
  if (!current) return candidate;

  const primary = (evidence: RetrievalChannelEvidence): number => {
    if (channel === "vector") return evidence.vectorCosineSimilarity ?? Number.NEGATIVE_INFINITY;
    if (channel === "exact" || channel === "fts" || channel === "temporal") {
      return evidence.rootLexicalCoverage ?? Number.NEGATIVE_INFINITY;
    }
    return evidence.rankScore;
  };
  const currentPrimary = primary(current);
  const candidatePrimary = primary(candidate);
  if (candidatePrimary > currentPrimary) return candidate;
  if (candidatePrimary < currentPrimary) return current;
  return candidate.rankScore > current.rankScore ? candidate : current;
}

function collectStrongestSupport(
  target: Record<string, Record<string, RetrievalChannelEvidence>>,
  source: RetrievalSupport,
): void {
  const channels: readonly RetrievalSupportChannel[] = ["exact", "vector", "fts", "graph", "temporal"];
  const origins: readonly RetrievalQueryOrigin[] = ["original", "derived"];
  for (const channel of channels) {
    const channelSupport = source[channel];
    if (!channelSupport) continue;
    let targetChannel = target[channel];
    if (!targetChannel) {
      targetChannel = Object.create(null);
      target[channel] = targetChannel;
    }
    for (const origin of origins) {
      const candidate = channelSupport[origin];
      if (!candidate) continue;
      targetChannel[origin] = selectStrongerEvidence(channel, targetChannel[origin], candidate);
    }
  }
}

/** Max detail terms extracted from a query — keeps the OR-LIKE bounded (#169). */
export const MAX_DETAIL_TERMS = 12;

/**
 * Extract detail-bearing terms from a query for sealed-page raw-chunk lookup.
 * Deterministic regex only — no LLM, no tokenizer dep. Primary signal: IDs,
 * dates, numbers+units, latin tokens (exact, high-signal). Secondary: CJK
 * 3-grams (so a natural-language query that is NOT a raw-chunk substring can
 * still match a raw-chunk fragment via LIKE). Returns unique terms, length-desc
 * (longest/most-specific first), capped at MAX_DETAIL_TERMS. Empty array when
 * nothing usable — caller must skip enrichment rather than scan.
 */
export function extractDetailTerms(query: string): string[] {
  const terms = new Set<string>();

  // IDs / latin+digit compounds: ALPHA-123, RFC-7231, QXR9876
  for (const m of query.matchAll(/[A-Za-z]+[A-Za-z0-9]*[-/][A-Za-z0-9]+/g)) terms.add(m[0]);
  for (const m of query.matchAll(/[A-Za-z]+\d+/g)) terms.add(m[0]);
  // Dates: 2026-06-26, 2026/6/6
  for (const m of query.matchAll(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/g)) terms.add(m[0]);
  // Numbers with optional unit: 120万, 3.5亿, 50%, 12万元, 30岁
  for (const m of query.matchAll(/\d+(?:\.\d+)?(?:万元|亿元|万|亿|%|元|岁|年|度|次|个|人|k|m)?/g)) {
    if (m[0].length >= 2) terms.add(m[0]);
  }
  // Pure multi-digit numbers: 12345
  for (const m of query.matchAll(/\d{2,}/g)) terms.add(m[0]);
  // Latin identifiers: API, HTTP
  for (const m of query.matchAll(/[A-Za-z]{2,}/g)) terms.add(m[0]);

  // CJK runs: 2-char runs kept whole; longer runs → sliding 3-grams so LIKE can
  // match a raw-chunk fragment even when the full sentence is not a substring.
  for (const run of query.matchAll(/[一-鿿]+/g)) {
    const seg = run[0];
    if (seg.length === 2) {
      terms.add(seg);
    } else {
      for (let i = 0; i <= seg.length - 3; i++) terms.add(seg.slice(i, i + 3));
    }
  }

  return [...terms]
    .filter((t) => t.trim().length >= 2)
    .sort((a, b) => b.length - a.length)
    .slice(0, MAX_DETAIL_TERMS);
}

const W_ACTIVITY = 0.15;
const W_HOTNESS = 0.12;

/** Sealed-page detail enrichment bounds — keep the post-fusion probe cheap and fanout-bounded (#169). */
const MAX_SEALED_DETAIL_PAGES = 5;
const MAX_RAW_CHUNK_HITS_PER_PAGE = 3;
const DETAIL_SNIPPET_CHARS = 200;

function mergeRankedResultsLegacy(
  lists: SearchResult[][],
  k: number,
  limit: number,
  activityWeights?: Map<string, number>,
  hotnessWeights?: Map<string, number>,
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

export function mergeRankedResults(
  lists: SearchResult[][],
  k: number,
  limit: number,
  activityWeights?: Map<string, number>,
  hotnessWeights?: Map<string, number>,
  captureSupport = false,
): SearchResult[] {
  const results = mergeRankedResultsLegacy(
    lists,
    k,
    limit,
    activityWeights,
    hotnessWeights,
  );
  if (!captureSupport || results.length === 0) return results;

  const outputSlugs = new Set(results.map((result) => result.slug));
  const supportBySlug = new Map<
    string,
    Record<string, Record<string, RetrievalChannelEvidence>>
  >();
  for (const list of lists) {
    for (const item of list) {
      if (!outputSlugs.has(item.slug)) continue;
      const existing = supportBySlug.get(item.slug);
      const support: Record<string, Record<string, RetrievalChannelEvidence>> =
        existing ?? Object.create(null);
      if (!existing) {
        supportBySlug.set(item.slug, support);
      }
      collectStrongestSupport(support, getRetrievalSupport(item));
    }
  }

  for (const result of results) {
    const support = supportBySlug.get(result.slug);
    if (support && Reflect.ownKeys(support).length > 0) {
      attachRetrievalSupport(result, support as RetrievalSupport);
    }
  }
  return results;
}

// ─── Recall quality gate (#230) ──────────────────────────────

/** Conservative minimum fused score for normal recall output. Kept BELOW the
 *  rrf rank-1 score (≈1/(k+1) ≈ 0.016 at k=60) so a genuine single-source FTS
 *  hit — the fallback evidence when vector is degraded/unavailable — is NOT
 *  filtered out. A bare-stub penalty (BARE_STUB_PENALTY=0.5) pushes a rank-1
 *  bare stub to ≈0.008, which IS filtered. exact matches bypass. Deterministic
 *  default, not tuned on private data. */
export const RECALL_MIN_SCORE = 0.01;

/** Score multiplier applied to bare tier-3 stubs in normal recall so richer
 *  evidence outranks them. Exact matches are never penalized. */
export const BARE_STUB_PENALTY = 0.5;

/** Minimal page-like shape consumed by the bare-stub detector. recall already
 *  fetches these fields during enrichment, so the gate needs no extra queries. */
export interface PageLike {
  tier?: number;
  type?: string;
  mention_count?: number;
}

/** Deterministic bare-stub detector: a tier-3 entity/concept with ≤1 link and
 *  ≤1 mention. Mirrors the getBareStubs SQL signal but operates on a page-like
 *  object so recall can apply it per-result without a full table scan. */
export function isBareStubCandidate(page: PageLike, linkCount?: number): boolean {
  if (page.tier !== 3) return false;
  const type = page.type ?? "";
  if (!type.startsWith("entity/") && !type.startsWith("concept/")) return false;
  const links = linkCount ?? 0;
  const mentions = page.mention_count ?? 0;
  return links <= 1 && mentions <= 1;
}

export interface QualityGateOptions {
  pagesBySlug: Map<string, PageLike>;
  linkCounts?: Map<string, number>;
  threshold?: number;
  /** Slugs promoted as exact matches (slug/title/alias). Bypass penalty + filter. */
  exactSlugs?: Set<string>;
}

export interface QualityGateResult {
  results: SearchResult[];
  filteredCount: number;
  reasonCodes: string[];
}

/** Apply the recall quality gate: (1) demote bare tier-3 stubs via a score
 *  penalty, (2) re-sort, (3) filter results below the minimum-relevance
 *  threshold. Exact matches (source === "exact" or in exactSlugs) bypass both
 *  the penalty and the filter. Deterministic — no LLM, no private tuning.
 *  NOTE: like the existing RECORD_SCORE_FACTOR demotion, this mutates `score`
 *  in place; callers pass their local candidate list, not shared state. */
export function applyRecallQualityGate(
  results: SearchResult[],
  opts: QualityGateOptions,
): QualityGateResult {
  const threshold = opts.threshold ?? RECALL_MIN_SCORE;
  const exactSlugs = opts.exactSlugs ?? new Set<string>();
  const isExact = (r: SearchResult): boolean => r.source === "exact" || exactSlugs.has(r.slug);

  for (const r of results) {
    if (isExact(r)) continue;
    const page = opts.pagesBySlug.get(r.slug);
    if (page && isBareStubCandidate(page, opts.linkCounts?.get(r.slug))) {
      r.score *= BARE_STUB_PENALTY;
    }
  }
  results.sort((a, b) => b.score - a.score);

  const reasonCodes: string[] = [];
  const kept: SearchResult[] = [];
  for (const r of results) {
    if (isExact(r) || r.score >= threshold) {
      kept.push(r);
    } else {
      reasonCodes.push("low_relevance_filtered");
    }
  }
  return { results: kept, filteredCount: results.length - kept.length, reasonCodes };
}

/** Default decomposition budget — keeps default recall cheap (0-1 LLM calls).
 *  Explicit multiStep=true / agentic_research bypass these (走 ResearchManager). */
const MAX_DEFAULT_SUBQUERIES = 3;
const MAX_DEFAULT_LLM_CALLS = 3;
const MAX_DEFAULT_DECOMPOSE_MS = 8000;
const MAX_MULTISTEP_ITERATIONS = 1;
const MAX_MULTISTEP_FOLLOWUPS = 2;
const MAX_MULTISTEP_RERANK_MS = 3000;
/** #250 — FTS probe is "sufficient" at this many results → skip expandQuery LLM. */
const FTS_SUFFICIENT_RESULTS = 3;

export class HybridSearch {
  private db: CBrainDB;
  private embedding: EmbeddingProvider;
  private lance: LanceDBStorage;
  private rrfK: number;
  private llm?: LLMProvider;
  private logger?: Logger;
  private multiQueryEnabled: boolean;
  private graph: GraphManager;
  private queryCache = new Map<string, { queries: string[]; expires: number }>();
  private embeddingCache = new Map<string, { embedding: number[]; expires: number }>();
  private static QUERY_CACHE_TTL = 300_000; // 5 minutes
  private static EMBEDDING_CACHE_TTL = 300_000;
  private static CACHE_MAX_SIZE = 100;
  static VECTOR_TIMEOUT_MS = 5_000; // 5s budget for vector search (embedding API + LanceDB)

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
    this.logger = config?.logger;
    this.multiQueryEnabled = config?.multiQuery ?? true;
    // #248 — reuse a shared GraphManager when provided (ToolContext path),
    // otherwise construct a stateless one over the same db so call sites that
    // don't pass config.graph still get batched traversal.
    this.graph = config?.graph ?? new GraphManager(db);
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    if (!query.trim()) return [];

    const shouldMultiStep = options?.multiStep === true;

    const results = shouldMultiStep && this.llm
      ? await this.searchMultiStep(query, options ?? {})
      : await this.searchCore(query, options);

    // Post-fusion sealed detail recovery (#169). Skipped for recursive
    // sub-queries so enrichment happens exactly once at the outer exit.
    if (options?._skipDetailEnrich) return results;
    return this.enrichSealedDetail(query, results);
  }

  private async searchCore(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    if (!query.trim()) return [];

    const limit = options?.limit ?? 10;
    const strategy = options?.strategy ?? "all";
    const trace = options?._trace;
    const support = resolveSupportContext(query, options);

    if (strategy === "vector") {
      const vecResult = await this.timedCall(() => this.boundedVectorSearch(query, limit, support), trace, "vector_ms").catch(() => null);
      if (vecResult === null) {
        if (trace) trace.degraded_reason = trace.degraded_reason ?? "vector_timeout";
        return [];
      }
      return vecResult;
    }
    if (strategy === "fts") {
      return this.timedCall(() => Promise.resolve(this.ftsSearch(query, limit, trace, support)), trace, "fts_ms");
    }
    if (strategy === "graph") {
      return this.timedCall(() => this.graphSearchWithSupport(query, limit, support), trace, "graph_ms");
    }

    // Exact title match fast path
    const exact = this.db.getPageByTitle(query.trim());
    if (exact) {
      const result: SearchResult = {
        slug: exact.slug,
        score: 1.0,
        snippet: exact.title,
        source: "exact",
      };
      const exactResult = attachDirectSupport(result, "exact", support, support.capture ? {
        rootLexicalCoverage: computeRootLexicalCoverage(support.rootQuery, exact.title),
      } : undefined);
      return [exactResult];
    }

    // #272 — hoist the bounded FTS probe above the decompose branch so the same
    // probe can gate decompose AND feed the #250 expand path below (no second
    // ftsSearch on the original query). Timed + fail-open (catch → []), mirroring
    // searchSingleQuery's FTS path so trace/error semantics stay consistent.
    const ftsProbe = await this.timedCall(
      () => Promise.resolve(this.ftsSearch(query, limit, trace, support)),
      trace,
      "fts_ms",
    ).catch(() => [] as SearchResult[]);
    const ftsSufficient = ftsProbe.length >= FTS_SUFFICIENT_RESULTS;

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
        // #272 — FTS-sufficient complex query: skip the LLM decompose, fall
        // through to the bounded hybrid + expand path (reusing ftsProbe).
        // knownSlugs is deliberately NOT part of sufficiency: a 2+-entity
        // comparison still needs decompose when FTS alone hasn't surfaced enough.
        if (ftsSufficient) {
          if (trace) trace.decompose_skipped = "fts_sufficient";
        } else {
          // Budget guard: skip decompose if LLM budget already exhausted (#222)
          if ((trace?.llm_calls ?? 0) >= MAX_DEFAULT_LLM_CALLS) {
            const fallback = await this.searchWithExpansion(query, limit, false, trace, ftsProbe, support);
            if (trace) {
              trace.decompose_skipped = "budget_exhausted_fallback";
              if (fallback.length === 0 && !trace.degraded_reason) {
                trace.degraded_reason = "decompose_budget_exceeded";
              }
            }
            return fallback; // 零额外 LLM，但保留已有本地证据
          }
          // Decompose with a REAL wall-clock budget: Promise.race against timeout.
          // timedCall only records elapsed — it does NOT cap latency, so a 70s LLM
          // decompose would still block (#222 review). Race forces degraded return.
          const decomposeStart = Date.now();
          let decomposeTimer: ReturnType<typeof setTimeout> | undefined;
          const decomposeTimeout = new Promise<never>((_, reject) => {
            decomposeTimer = setTimeout(() => reject(new Error("decompose_timeout")), MAX_DEFAULT_DECOMPOSE_MS);
          });
          let subQueries: string[];
          try {
            const graphContext = await this.graphPrefetch(query);
            subQueries = (await Promise.race([
              this.decomposeQuery(query, graphContext),
              decomposeTimeout,
            ])).slice(0, MAX_DEFAULT_SUBQUERIES);
          } catch (e) {
            if (trace) {
              trace.decompose_ms = Date.now() - decomposeStart;
            }
            this.logger?.warn("search", "decomposition 超时/失败，回退原查询（零额外 LLM）", { error: e instanceof Error ? e.message : String(e) });
            const fallback = await this.searchWithExpansion(query, limit, false, trace, ftsProbe, support);
            if (trace) {
              trace.decompose_skipped = "decompose_failed_fallback";
              if (fallback.length === 0 && !trace.degraded_reason) {
                trace.degraded_reason = "decompose_budget_exceeded";
              }
            }
            return fallback;
          } finally {
            // 成功 decompose 后清理 pending timeout timer，避免 8s 定时器残留
            if (decomposeTimer) clearTimeout(decomposeTimer);
          }
          if (trace) {
            trace.decompose_ms = Date.now() - decomposeStart;
            trace.llm_calls = (trace.llm_calls ?? 0) + 1;
          }

          this.logger?.info("search", `decomposition: "${query}" → ${subQueries.length} sub-queries (capped at ${MAX_DEFAULT_SUBQUERIES})`);
          if (subQueries.length >= 2) {
            const vectorOverride = support.capture
              ? { query, origin: "original" as const, claimed: false }
              : undefined;
            // Preserve every decomposition child. In capture mode only, the
            // first child that already reaches vector search claims a shared
            // one-shot root-query override. Exact children stay on their legacy
            // zero-vector fast path, so no embedding/Lance call is added.
            const subResults = await Promise.all(
              subQueries.map((sq) =>
                this.search(sq, {
                  ...(options ?? {}),
                  _skipDecompose: true,
                  multiQuery: false,
                  _skipDetailEnrich: true,
                  _trace: trace,
                  _captureSupport: support.capture,
                  _supportRootQuery: support.rootQuery,
                  _supportOrigin: "derived",
                  ...(vectorOverride === undefined
                    ? {}
                    : { _supportVectorOverride: vectorOverride }),
                }).catch(() => [] as SearchResult[])
              )
            );

            const allSubLists = subResults.filter((r) => r.length > 0);
            if (allSubLists.length > 0) {
              const allSlugs = new Set<string>();
              for (const list of allSubLists) for (const item of list) allSlugs.add(item.slug);
              const activityWeights = allSlugs.size > 0 ? this.db.getActivityWeights([...allSlugs]) : undefined;
              const hotnessWeights = allSlugs.size > 0 ? this.db.getHotnessWeights([...allSlugs]) : undefined;
              return mergeRankedResults(
                allSubLists,
                this.rrfK,
                limit,
                activityWeights,
                hotnessWeights,
                support.capture,
              );
            }
          }
          // decompose 成功但弱结构/空结果 → 原查询 bounded fallback（召回不丢失）。
          // multiQuery:false → 不 expandQuery（chat LLM escalation），不 ResearchManager；
          // 仅 searchSingleQuery（vector/fts/graph），bounded。复用 hoisted ftsProbe 避免二次 ftsSearch。
          return this.searchWithExpansion(query, limit, false, trace, ftsProbe, support);
        }
      }
    }

    // #250 — bounded FTS probe gate. ftsProbe is hoisted above (reused here, NOT
    // re-run) so there is no second ftsSearch on the original query.
    // #250 — preserve explicit multiQuery:false (decompose fallback at search.ts:473
    // passes multiQuery:false to forbid LLM escalation). Caller opt-out is honored
    // even when FTS is insufficient. FTS>=3 is sufficient local evidence, so it
    // skips expandQuery even for complex wording; FTS<3 can still expand.
    const multiQueryAllowed = options?.multiQuery ?? this.multiQueryEnabled;
    const shouldExpand = multiQueryAllowed && !!this.llm && !ftsSufficient;
    if (trace && this.llm && !shouldExpand && ftsSufficient) {
      trace.expand_skipped = "fts_sufficient";
    }
    return this.searchWithExpansion(query, limit, shouldExpand, trace, ftsProbe, support);
  }

  private async searchSingleQuery(
    q: string,
    limit: number,
    trace: SearchTrace | undefined,
    initialFts: SearchResult[] | undefined,
    support: SearchSupportContext,
  ): Promise<SearchResult[][]> {
    const resolved = this.db.resolveSlugs([q])[0];

    // Race vector search against timeout — embedding API call is unbounded network I/O
    const vectorSlot = resolveVectorSlot(q, support);
    const vectorPromise = this.boundedVectorSearch(
      vectorSlot.query,
      limit,
      vectorSlot.support,
    );

    const [vecOrNull, fts, graph, temporal] = await Promise.all([
      this.timedCall(() => vectorPromise, trace, "vector_ms").catch((e) => {
        this.logger?.warn("search", "vectorSearch 失败", { error: e instanceof Error ? e.stack ?? e.message : String(e) });
        if (trace && !trace.degraded_reason) trace.degraded_reason = "vector_error";
        return null as SearchResult[] | null;
      }),
      initialFts !== undefined
        ? Promise.resolve(initialFts)
        : this.timedCall(() => Promise.resolve(this.ftsSearch(q, limit, trace, support)), trace, "fts_ms").catch((e) => {
            this.logger?.warn("search", "ftsSearch 失败", { error: e instanceof Error ? e.stack ?? e.message : String(e) });
            return [] as SearchResult[];
          }),
      resolved?.slug
        ? this.timedCall(() => this.graphSearchWithSupport(resolved.slug!, limit, support), trace, "graph_ms").catch((e) => {
            this.logger?.warn("search", "graphSearch 失败", { error: e instanceof Error ? e.stack ?? e.message : String(e) });
            return [] as SearchResult[];
          })
        : Promise.resolve([] as SearchResult[]),
      this.timedCall(() => Promise.resolve(this.temporalSearch(q, limit, support)), trace, "temporal_ms").catch((e) => {
        this.logger?.warn("search", "temporalSearch 失败", { error: e instanceof Error ? e.stack ?? e.message : String(e) });
        return [] as SearchResult[];
      }),
    ]);

    const vec = vecOrNull ?? [];
    if (vecOrNull === null && trace && !trace.degraded_reason) {
      trace.degraded_reason = "vector_timeout";
    }

    const lists: SearchResult[][] = [];
    if (vec.length > 0) lists.push(vec);
    if (fts.length > 0) lists.push(fts);
    if (graph.length > 0) lists.push(graph);
    if (temporal.length > 0) lists.push(temporal);
    return lists;
  }

  private async searchWithExpansion(
    query: string,
    limit: number,
    expand: boolean,
    trace?: SearchTrace,
    initialFts?: SearchResult[],
    support: SearchSupportContext = resolveSupportContext(query),
  ): Promise<SearchResult[]> {
    const t0 = Date.now();
    const budgetExhausted = (trace?.llm_calls ?? 0) >= MAX_DEFAULT_LLM_CALLS;
    const useMultiQuery = expand && !!this.llm && !budgetExhausted;

    let queries: string[];
    if (useMultiQuery) {
      // #250 — race expandQuery against a wall-clock budget (mirrors #222 decompose
      // guard). LLMProvider has no AbortSignal: on timeout we discard the result,
      // do NOT write anything, and fall back to the original query. expandQuery is
      // pure-read, so discarding is safe.
      let expandTimer: ReturnType<typeof setTimeout> | undefined;
      const expandTimeout = new Promise<never>((_, reject) => {
        expandTimer = setTimeout(() => reject(new Error("expand_timeout")), MAX_DEFAULT_DECOMPOSE_MS);
      });
      try {
        queries = await Promise.race([
          this.timedCall(() => this.expandQuery(query), trace, "expand_ms"),
          expandTimeout,
        ]);
      } catch (e) {
        this.logger?.warn("search", "expandQuery 超时/失败，回退原查询（不写 DB，丢弃结果）", { error: e instanceof Error ? e.message : String(e) });
        queries = [query];
      } finally {
        if (expandTimer) clearTimeout(expandTimer);
      }
      if (trace) {
        trace.query_variants = queries;
        trace.llm_calls = (trace.llm_calls ?? 0) + 1;
      }
    } else {
      queries = [query];
      if (trace && budgetExhausted && expand && this.llm) {
        trace.expand_skipped = "budget_exhausted";
      }
    }

    const queryResults = await Promise.all(
      queries.map((q, i) => this.searchSingleQuery(
        q,
        limit,
        trace,
        i === 0 ? initialFts : undefined,
        i === 0 || !support.capture
          ? support
          : {
              ...support,
              origin: "derived",
              vectorOverride: undefined,
            },
      ))
    );
    const allLists = queryResults.flat();

    const allSlugs = new Set<string>();
    for (const list of allLists) for (const item of list) allSlugs.add(item.slug);
    const activityWeights = allSlugs.size > 0 ? this.db.getActivityWeights([...allSlugs]) : undefined;
    const hotnessWeights = allSlugs.size > 0 ? this.db.getHotnessWeights([...allSlugs]) : undefined;

    const totalMs = Date.now() - t0;
    this.logger?.info("search", `expansion: ${queries.length} queries, expand=${trace?.expand_ms ?? 0}ms, total=${totalMs}ms, slugs=${allSlugs.size}`);

    return mergeRankedResults(
      allLists,
      this.rrfK,
      limit,
      activityWeights,
      hotnessWeights,
      support.capture,
    );
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
    const researcher = new ResearchManager(this, this.db, this.llm, {
      maxIterations: MAX_MULTISTEP_ITERATIONS,
      maxFollowUpQueries: MAX_MULTISTEP_FOLLOWUPS,
      maxRerankMs: MAX_MULTISTEP_RERANK_MS,
    }, this.logger);
    const results = await researcher.research(query, options);
    if (trace) {
      trace.research_ms = Date.now() - start;
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
      const knownSlugs = known.map((r) => r.slug!);
      const linksBySlug = this.db.batchGetLinksForSlugs(knownSlugs);
      const neighborEntriesBySlug = new Map<string, Array<{ slug: string; relation: string }>>();
      const slugsToHydrate = new Set<string>(knownSlugs);

      for (const r of known) {
        const slug = r.slug!;
        // #233: exclude candidate reports_to from search context (current-fact
        // semantic — candidate reports_to is evidence, not a confirmed relation
        // to feed LLM chains). Non-reports_to candidate neighbors are kept.
        const rawLinks = linksBySlug.get(slug) ?? { outgoing: [], incoming: [] };
        const outgoing = rawLinks.outgoing.filter(isCurrentFactLink);
        const incoming = rawLinks.incoming.filter(isCurrentFactLink);

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

        const cappedEntries = neighborEntries.slice(0, MAX_NEIGHBORS_PER_ENTITY);
        neighborEntriesBySlug.set(slug, cappedEntries);
        for (const entry of cappedEntries) slugsToHydrate.add(entry.slug);
      }

      const titlesAndTypes = this.db.getPageTitlesAndTypes([...slugsToHydrate]);

      for (const r of known) {
        const slug = r.slug!;
        const neighborData: Array<{ slug: string; title: string; relation: string }> = [];
        for (const entry of neighborEntriesBySlug.get(slug) ?? []) {
          const info = titlesAndTypes.get(entry.slug);
          if (info) neighborData.push({ slug: entry.slug, title: info.title, relation: entry.relation });
        }

        const pageType = titlesAndTypes.get(slug);
        context.entities.push({
          slug,
          title: r.title ?? slug,
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
      this.logger?.warn("search", "graphPrefetch 失败", { error: e instanceof Error ? e.stack ?? e.message : String(e) });
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
      this.logger?.warn("search", "decomposeQuery 失败", { error: e instanceof Error ? e.stack ?? e.message : String(e) });
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
      this.logger?.warn("search", "查询扩展失败", { error: e instanceof Error ? e.stack ?? e.message : String(e) });
      return [query];
    }
  }

  /**
   * Post-fusion enrichment (#169): for already-recalled sealed pages, recover
   * detail-level evidence from raw chunks via a bounded per-page OR-LIKE over
   * query-derived terms. Does NOT change ranking, does NOT replace the summary
   * result, does NOT run for unsealed pages or queries with no usable terms.
   * No LLM, no global scan. Idempotent: skips results that already carry detail.
   */
  private enrichSealedDetail(query: string, results: SearchResult[]): SearchResult[] {
    const terms = extractDetailTerms(query);
    if (terms.length === 0 || results.length === 0) return results;

    const sealedSlugs: string[] = [];
    for (const r of results) {
      if (!r.detail && this.db.isSealedPage(r.slug)) sealedSlugs.push(r.slug);
    }
    if (sealedSlugs.length === 0) return results;

    // Bound fanout: only already-recalled sealed pages, capped.
    const pagesToProbe = sealedSlugs.slice(0, MAX_SEALED_DETAIL_PAGES);
    const detailBySlug = new Map<string, SealedDetailHit>();
    for (const slug of pagesToProbe) {
      const snippet = this.pickStrongestRawHit(slug, terms);
      if (snippet === null) continue;
      detailBySlug.set(slug, {
        snippet: snippet.slice(0, DETAIL_SNIPPET_CHARS),
        level: "raw_chunk",
      });
    }
    if (detailBySlug.size === 0) return results;

    return results.map((r) => {
      const d = detailBySlug.get(r.slug);
      return d ? { ...r, detail: d } : r;
    });
  }

  /**
   * Pick the raw chunk matching the highest-signal query term. Signal order:
   * non-CJK tokens (ID/date/number/amount/latin) outrank pure-CJK 3-grams;
   * within a class, terms are length-desc (more specific first); chunk_index is
   * the final tie-breaker. Prevents a generic-context chunk (matching only a
   * low-signal CJK n-gram at a lower chunk_index) from hiding the chunk that
   * actually carries the ID/number/date (#169 review).
   */
  private pickStrongestRawHit(slug: string, terms: string[]): string | null {
    if (terms.length === 0) return null;
    // Rank terms by signal class: non-CJK (ID/date/number/amount/latin) before
    // pure-CJK n-grams; within a class, preserve length-desc specificity from
    // extractDetailTerms. getRawChunkHitsForPage turns this order into SQL
    // match_rank so the strongest-signal chunk survives LIMIT (#169 review).
    const isCjk = (t: string) => /^[一-鿿]+$/.test(t);
    const ranked = [
      ...terms.filter((t) => !isCjk(t)),
      ...terms.filter((t) => isCjk(t)),
    ];
    const hits = this.db.getRawChunkHitsForPage(slug, ranked, MAX_RAW_CHUNK_HITS_PER_PAGE);
    return hits.length === 0 ? null : hits[0].content;
  }

  private async vectorSearch(
    query: string,
    limit: number,
    support: SearchSupportContext,
  ): Promise<SearchResult[]> {
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
    const includeVector = support.capture && support.origin === "original";
    const results = includeVector
      ? await this.lance.search(embedding, limit * 3, { includeVector: true })
      : await this.lance.search(embedding, limit * 3);

    const bySlug = new Map<string, { content: string; score: number }>();
    const supportBySlug = includeVector
      ? new Map<string, RetrievalChannelEvidence>()
      : undefined;
    for (const r of results) {
      const rankScore = r._distance != null ? 1 - r._distance : 0;
      const existing = bySlug.get(r.pageSlug);
      if (!existing || r.chunkIndex === -1) {
        bySlug.set(r.pageSlug, {
          content: r.content,
          score: rankScore,
        });
      }

      if (!supportBySlug || !r.vector || !Number.isFinite(rankScore)) continue;
      const vectorCosineSimilarity = computeCosineSimilarity(embedding, r.vector);
      if (vectorCosineSimilarity === undefined) continue;
      const candidate: RetrievalChannelEvidence = {
        rankScore,
        vectorCosineSimilarity,
      };
      supportBySlug.set(
        r.pageSlug,
        selectStrongerEvidence("vector", supportBySlug.get(r.pageSlug), candidate),
      );
    }

    return [...bySlug.entries()].slice(0, limit).map(([slug, v]) => {
      const result: SearchResult = {
        slug,
        score: v.score,
        snippet: v.content.slice(0, 200),
        source: "vector",
      };
      return attachDirectSupport(result, "vector", support, supportBySlug?.get(slug));
    });
  }

  /** vectorSearch with timeout budget. Returns null on timeout, rejects on error. */
  private boundedVectorSearch(
    query: string,
    limit: number,
    support: SearchSupportContext,
  ): Promise<SearchResult[] | null> {
    return new Promise<SearchResult[] | null>((resolve, reject) => {
      const timer = setTimeout(() => resolve(null), HybridSearch.VECTOR_TIMEOUT_MS);
      this.vectorSearch(query, limit, support)
        .then((r) => { clearTimeout(timer); resolve(r); })
        .catch((e) => { clearTimeout(timer); reject(e); });
    });
  }

  private ftsSearch(
    query: string,
    limit: number,
    trace?: SearchTrace,
    support: SearchSupportContext = resolveSupportContext(query),
  ): SearchResult[] {
    const meta: { fts_fallback?: boolean } = {};
    const results = this.db.ftsSearch(query, limit, meta);
    if (meta.fts_fallback && trace) trace.fts_fallback = true;
    return results.map((r) => {
      const result: SearchResult = {
        slug: r.page_slug,
        score: Math.abs(r.rank),
        snippet: r.content.slice(0, 200),
        source: "fts",
      };
      return attachDirectSupport(result, "fts", support, support.capture ? {
        rootLexicalCoverage: computeRootLexicalCoverage(support.rootQuery, r.content),
      } : undefined);
    });
  }

  private temporalSearch(
    query: string,
    limit: number,
    support: SearchSupportContext,
  ): SearchResult[] {
    const results = this.db.searchTimeline(query, undefined, limit);
    return results.map((r) => {
      const result: SearchResult = {
        slug: r.page_slug,
        score: 0.5,
        snippet: `${r.event_date ?? "?"}: ${r.summary}${r.source ? ` [${r.source}]` : ""}`,
        source: "temporal",
      };
      return attachDirectSupport(result, "temporal", support, support.capture ? {
        rootLexicalCoverage: computeRootLexicalCoverage(support.rootQuery, result.snippet),
      } : undefined);
    });
  }

  async graphSearch(seedSlug: string, limit: number): Promise<SearchResult[]> {
    return this.graphSearchWithSupport(seedSlug, limit, resolveSupportContext(seedSlug));
  }

  private async graphSearchWithSupport(
    seedSlug: string,
    limit: number,
    support: SearchSupportContext,
  ): Promise<SearchResult[]> {
    // #248 — delegate to GraphManager.traverse's batched no-filter BFS instead
    // of per-node getOutgoingSlugs/getIncomingSlugs/getPageTitle lookups. Same
    // two-hop, bidirectional, visited-on-first-encounter BFS semantics; score
    // maps 1/node.depth (depth 1 -> 1.0, depth 2 -> 0.5), matching the old
    // 1/(depth+1). Behavior change: traverse only returns nodes with a page
    // row, so dangling link targets are excluded from recall candidates
    // (defensive — the links FK makes such targets schema-impossible under
    // PRAGMA foreign_keys = ON, so this is unobservable on valid data).
    return this.graph.traverse(seedSlug, { direction: "both", maxDepth: 2, limit }).map((node) => {
      const result: SearchResult = {
        slug: node.slug,
        score: 1 / node.depth,
        snippet: node.title,
        source: "graph",
      };
      return attachDirectSupport(result, "graph", support);
    });
  }
}

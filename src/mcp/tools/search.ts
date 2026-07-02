import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { generateProactiveHints } from "../../core/retrieval/proactive.js";
import { isComplexQuery, applyRecallQualityGate, type SearchTrace } from "../../core/retrieval/search.js";
import { traceToSteps } from "../../core/retrieval/search-trace.js";
import { trimHint, applyProactiveBudget } from "./trim.js";
import { classifyDegradedReasons, computeSearchDegraded, computeLatencyWarning } from "../../core/retrieval/search-diagnostics.js";
import { formatQueryEnvelope } from "./format-result.js";

export function registerSearchTools(server: McpServer, ctx: ToolContext): void {
  // ─── query ───────────────────────────────────────────────
  server.registerTool("query", {
    description:
      "底层关键词搜索，返回原始文本片段（slug + snippet）。仅限以下场景：" +
      "调试（确认某个关键词是否被索引、出现在哪些页面）、" +
      "定位（已知精确关键词，需要找到对应的 slug）、" +
      "deep_recall 降级链（deep_recall 未命中后缩减关键词重试）。" +
      "❌ 不要用于自然语言问题。事实回忆 → deep_recall，全貌 → summarize，找人 → recall_episode，组织架构 → get_org_tree。" +
      "proactive_hints 默认不展示给用户。只有 hint 直接改变当前判断时，写成一句自然的话，不使用标题或列表。",
    inputSchema: {
      query: z.string().max(1000).describe("Search query"),
      limit: z.number().optional().default(10).describe("Max results"),
      strategy: z.enum(["smart", "fts", "vector", "all"]).optional().default("smart")
        .describe("smart=FTS first, fallback to hybrid if empty (fastest); fts=FTS only; vector=embedding search; all=full hybrid (slowest)"),
      session_id: z.string().max(200).optional().describe("Current conversation session ID for co-occurrence tracking"),
      multiStep: z.boolean().optional().default(false)
        .describe("多轮深度搜索：自动判断结果充分性、换策略重试、LLM重排序。开启条件：查询模糊/跨领域、首次结果不满意、需要全面覆盖时。精确查单个关键词不需要开。"),
    },
  }, async ({ query, limit, strategy, session_id, multiStep }) => {
    const actualStrategy = strategy ?? "smart";
    const cap = limit ?? 10;
    const start = Date.now();
    let results: Awaited<ReturnType<typeof ctx.search.search>>;
    let usedStrategy: string = actualStrategy;
    let exactSlug: string | null = null;
    const trace: SearchTrace = {};

    // Start trace session BEFORE search to capture real latency
    let traceSessionId: number | undefined;
    try { traceSessionId = ctx.db.startSearchTraceSession({ query, mode: actualStrategy }); } catch { /* non-critical */ }

    if (actualStrategy === "smart") {
      // Exact slug/title match fast path
      const resolved = ctx.db.resolveSlugs([query])[0];
      exactSlug = resolved?.slug ?? null;

      // Detect complex queries before FTS — routes to decomposition in ctx.search.search().
      // This check is needed here (not just inside HybridSearch) because the smart strategy
      // can short-circuit on FTS results, bypassing HybridSearch.search() entirely.
      const candidates = query.split(/[\s,，、；;和与跟以及]+/).filter((w) => w.length >= 2);
      const ftsStart = Date.now();
      const ftsMeta: { fts_fallback?: boolean } = {};
      const ftsSlugs = (() => { try { return ctx.db.ftsSearch(query, cap, ftsMeta); } catch { return []; } })();
      if (ftsMeta.fts_fallback) trace.fts_fallback = true;
      const ftsElapsed = Date.now() - ftsStart;
      const knownSlugs = ctx.db.resolveSlugs(candidates).filter((r) => r.slug !== null).map((r) => r.slug!);
      const complex = isComplexQuery(query, knownSlugs, candidates);

      if (complex) {
        results = await ctx.search.search(query, { strategy: "all", limit: cap, multiStep, _hints: { knownSlugs, isComplex: complex }, _trace: trace });
        usedStrategy = "smart-decompose";
      } else if (ftsSlugs.length >= Math.min(cap, 3)) {
        results = ftsSlugs.map(r => ({ slug: r.page_slug, score: Math.abs(r.rank), snippet: r.content.slice(0, 200), source: "fts" as const }));
        trace.fts_ms = ftsElapsed;
        usedStrategy = "smart-fts";
      } else {
        results = await ctx.search.search(query, { strategy: "all", limit: cap, multiStep, _hints: { knownSlugs, isComplex: complex }, _trace: trace });
        usedStrategy = ftsSlugs.length > 0 ? "smart-hybrid-boost" : "smart-hybrid";
      }

      // Promote exact match to top
      if (exactSlug) {
        const existingIdx = results.findIndex(r => r.slug === exactSlug);
        if (existingIdx > 0) {
          const [match] = results.splice(existingIdx, 1);
          results.unshift({ ...match, score: 1.0 });
        } else if (existingIdx === -1) {
          results.unshift({ slug: exactSlug, score: 1.0, snippet: resolved.title ?? query, source: "exact" as const });
        }
      }
    } else if (actualStrategy === "fts") {
      results = await ctx.search.search(query, { strategy: "fts", limit: cap, _trace: trace });
    } else if (actualStrategy === "vector") {
      results = await ctx.search.search(query, { strategy: "vector", limit: cap, _trace: trace });
    } else {
      results = await ctx.search.search(query, { strategy: "all", limit: cap, multiStep, _trace: trace });
    }

    const latencyMs = Date.now() - start;

    // Diagnose degraded search state
    const reasonCodes = classifyDegradedReasons(results, trace, query, cap, latencyMs);

    try {
      const sourceCounts: Record<string, number> = {};
      for (const r of results) { sourceCounts[r.source ?? "unknown"] = (sourceCounts[r.source ?? "unknown"] ?? 0) + 1; }
      const isDegraded = computeSearchDegraded(latencyMs, trace, reasonCodes);
      ctx.db.logSearch(query, usedStrategy, latencyMs, results.length, isDegraded, {
        strategy_path: usedStrategy, ...trace, result_sources: sourceCounts, requested_limit: cap, multistep: !!multiStep,
        reason_codes: reasonCodes,
      });
    } catch { /* non-critical */ }

    // Finish trace session AFTER search with measured latency
    try {
      if (traceSessionId != null) {
        const steps = traceToSteps(traceSessionId, trace);
        for (const step of steps) ctx.db.addSearchTraceStep(step);
        ctx.db.finishSearchTraceSession(traceSessionId, {
          latencyMs,
          status: computeSearchDegraded(latencyMs, trace, reasonCodes) ? "degraded" : "success",
          llmCalls: trace.llm_calls,
          totalSteps: steps.length,
          summaryJson: { ...trace, reason_codes: reasonCodes },
        });
      }
    } catch { /* trace write failure must not break search */ }

    // #230 low-relevance gate BEFORE learning/logging — filtered noise must not
    // enter query log, activity weights, or proactive hints. query uses a near-
    // zero threshold + fts/exact/decompose bypass so debug keyword lookups stay.
    const ftsScenario = usedStrategy.includes("fts") || usedStrategy.includes("boost");
    const queryExactSlugs = new Set<string>();
    if (exactSlug) queryExactSlugs.add(exactSlug);
    for (const r of results) {
      if (r.source === "fts" || r.source === "exact" || ftsScenario) queryExactSlugs.add(r.slug);
    }
    const queryGate = applyRecallQualityGate(results, {
      pagesBySlug: new Map(),
      exactSlugs: queryExactSlugs,
      threshold: 0.005,
    });
    results = queryGate.results;
    const queryQualityMeta = queryGate.filteredCount > 0
      ? { quality_gate: { filtered: queryGate.filteredCount, reason_codes: queryGate.reasonCodes } }
      : {};

    // Learning loop: log query + bump activity weights (gate-filtered only)
    const resultSlugs = results.map((r: { slug: string }) => r.slug);
    try { ctx.db.logQuery("query", query, resultSlugs, latencyMs, session_id); } catch { /* non-critical */ }
    for (let i = 0; i < results.length; i++) {
      try { ctx.learn.bumpOnQuery(results[i].slug, i, "query"); } catch { /* non-critical */ }
    }

    // Proactive hints
    const hints = await generateProactiveHints(ctx, {
      resultSlugs,
      maxHints: 2,
    });

    const isSearchDegraded = computeSearchDegraded(latencyMs, trace, reasonCodes);
    const isVectorDegraded = !!trace.degraded_reason;

    const payload = {
      results,
      proactive_hints: (() => {
        const budgeted = applyProactiveBudget(hints.map(trimHint), { grounded: false, toolType: "search" });
        return budgeted.length > 0 ? budgeted : undefined;
      })(),
      // Top-level degraded: any degradation triggers formatter degraded path
      ...(isSearchDegraded ? {
        degraded: true,
        // vector_skipped: only for actual vector failures (controls display message)
        ...(isVectorDegraded ? { vector_skipped: trace.degraded_reason === "vector_timeout" ? "timeout" as const : "error" as const } : {}),
        latency_ms: latencyMs,
      } : {}),
      // Diagnostic meta — only in raw envelope, NOT spread to top level
      search_meta: {
        strategy: usedStrategy,
        latency_ms: latencyMs,
        degraded: isSearchDegraded || undefined,
        latency_warning: computeLatencyWarning(latencyMs, reasonCodes) || undefined,
        ...(reasonCodes.length > 0 ? { reason_codes: reasonCodes } : {}),
        ...queryQualityMeta,
      },
    };
    const { display, summary, raw } = formatQueryEnvelope(payload);
    // Strip search_meta from top-level spread — diagnostics only in raw
    const { search_meta: _meta, ...legacyPayload } = payload;
    return {
      content: [{ type: "text", text: JSON.stringify({ display, summary, raw, ...legacyPayload }, null, 2) }],
    };
  });

  // ─── get_chunks ──────────────────────────────────────────────
  server.registerTool("get_chunks", {
    description: "Get indexed text chunks for a page.",
    inputSchema: {
      slug: z.string().max(500).describe("Page slug"),
    },
  }, async ({ slug }) => {
    const chunks = ctx.db.getChunksByPage(slug);
    return {
      content: [{ type: "text", text: JSON.stringify(chunks, null, 2) }],
    };
  });
}

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { generateProactiveHints } from "../../core/proactive.js";
import { isComplexQuery, type SearchTrace } from "../../core/search.js";
import { traceToSteps } from "../../core/search-trace.js";
import { trimHint } from "./trim.js";

export function registerSearchTools(server: McpServer, ctx: ToolContext): void {
  // ─── query ───────────────────────────────────────────────
  server.registerTool("query", {
    description:
      "原始搜索，只返回匹配的文本片段，不附带关系、时间线等额外信息。" +
      "仅用于快速定位某个关键词出现的位置。大多数查询应该用 deep_recall 代替。" +
      "⚠️ 返回中的 proactive_hints 是系统主动发现的你可能不知道的重要信息。你必须把每一条 hint 原样展示给用户，用 '💡 主动提示：' 开头，逐条列出。不要省略任何一条。",
    inputSchema: {
      query: z.string().max(1000).describe("Search query"),
      limit: z.number().optional().default(10).describe("Max results"),
      strategy: z.enum(["smart", "fts", "vector", "all"]).optional().default("smart")
        .describe("smart=FTS first, fallback to hybrid if empty (fastest); fts=FTS only; vector=embedding search; all=full hybrid (slowest)"),
      session_id: z.string().optional().describe("Current conversation session ID for co-occurrence tracking"),
      multiStep: z.boolean().optional().default(false)
        .describe("多轮深度搜索：自动判断结果充分性、换策略重试、LLM重排序。开启条件：查询模糊/跨领域、首次结果不满意、需要全面覆盖时。精确查单个关键词不需要开。"),
    },
  }, async ({ query, limit, strategy, session_id, multiStep }) => {
    const actualStrategy = strategy ?? "smart";
    const cap = limit ?? 10;
    const start = Date.now();
    let results: Awaited<ReturnType<typeof ctx.search.search>>;
    let usedStrategy: string = actualStrategy;
    const trace: SearchTrace = {};

    // Start trace session BEFORE search to capture real latency
    let traceSessionId: number | undefined;
    try { traceSessionId = ctx.db.startSearchTraceSession({ query, mode: actualStrategy }); } catch { /* non-critical */ }

    if (actualStrategy === "smart") {
      // Exact slug/title match fast path
      const resolved = ctx.db.resolveSlugs([query])[0];
      const exactSlug = resolved?.slug ?? null;

      // Detect complex queries before FTS — routes to decomposition in ctx.search.search().
      // This check is needed here (not just inside HybridSearch) because the smart strategy
      // can short-circuit on FTS results, bypassing HybridSearch.search() entirely.
      const candidates = query.split(/[\s,，、；;和与跟以及]+/).filter((w) => w.length >= 2);
      const ftsStart = Date.now();
      const ftsSlugs = (() => { try { return ctx.db.ftsSearch(query, cap); } catch { return []; } })();
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
    try {
      const sourceCounts: Record<string, number> = {};
      for (const r of results) { sourceCounts[r.source ?? "unknown"] = (sourceCounts[r.source ?? "unknown"] ?? 0) + 1; }
      ctx.db.logSearch(query, usedStrategy, latencyMs, results.length, latencyMs > 2000, {
        strategy_path: usedStrategy, ...trace, result_sources: sourceCounts, requested_limit: cap, multistep: !!multiStep,
      });
    } catch { /* non-critical */ }

    // Finish trace session AFTER search with measured latency
    try {
      if (traceSessionId != null) {
        const steps = traceToSteps(traceSessionId, trace);
        for (const step of steps) ctx.db.addSearchTraceStep(step);
        ctx.db.finishSearchTraceSession(traceSessionId, {
          latencyMs,
          status: latencyMs > 2000 ? "degraded" : (trace.degraded_reason ? "degraded" : "success"),
          llmCalls: trace.llm_calls,
          totalSteps: steps.length,
          summaryJson: { ...trace },
        });
      }
    } catch { /* trace write failure must not break search */ }

    // Learning loop: log query + bump activity weights
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

    return {
      content: [{ type: "text", text: JSON.stringify({
        results,
        proactive_hints: hints.length > 0 ? hints.map(trimHint) : undefined,
        ...(trace.degraded_reason ? {
          degraded: true,
          vector_skipped: trace.degraded_reason === "vector_timeout" ? "timeout" : "error",
          latency_ms: latencyMs,
        } : {}),
      }, null, 2) }],
    };
  });

  // ─── get_chunks ──────────────────────────────────────────────
  server.registerTool("get_chunks", {
    description: "Get indexed text chunks for a page.",
    inputSchema: {
      slug: z.string().describe("Page slug"),
    },
  }, async ({ slug }) => {
    const chunks = ctx.db.getChunksByPage(slug);
    return {
      content: [{ type: "text", text: JSON.stringify(chunks, null, 2) }],
    };
  });
}

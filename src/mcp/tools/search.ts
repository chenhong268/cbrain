import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";

export function registerSearchTools(server: McpServer, ctx: ToolContext): void {
  // ─── query ───────────────────────────────────────────────
  server.registerTool("query", {
    description: "Search the knowledge brain with hybrid search (vector + FTS + graph, automatically fused).",
    inputSchema: {
      query: z.string().describe("Search query"),
      limit: z.number().optional().default(10).describe("Max results"),
      strategy: z.enum(["smart", "fts", "vector", "all"]).optional().default("smart")
        .describe("smart=FTS first, fallback to hybrid if empty (fastest); fts=FTS only; vector=embedding search; all=full hybrid (slowest)"),
    },
  }, async ({ query, limit, strategy }) => {
    const start = Date.now();
    let results: Awaited<ReturnType<typeof ctx.search.search>>;
    let usedStrategy: string = strategy;

    if (strategy === "smart") {
      // Exact slug/title match fast path
      const resolved = ctx.db.resolveSlugs([query])[0];
      const exactSlug = resolved?.slug ?? null;

      const ftsRaw = ctx.db.ftsSearch(query, limit);
      if (ftsRaw.length > 0) {
        results = ftsRaw.map(r => ({ slug: r.page_slug, score: 1 / (1 + r.rank), snippet: r.content.slice(0, 200), source: "fts" as const }));
        usedStrategy = "smart-fts";
      } else {
        results = await ctx.search.search(query, { strategy: "all", limit });
        usedStrategy = "smart-hybrid";
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
    } else if (strategy === "fts") {
      results = await ctx.search.search(query, { strategy: "fts", limit });
    } else if (strategy === "vector") {
      results = await ctx.search.search(query, { strategy: "vector", limit });
    } else {
      results = await ctx.search.search(query, { strategy: "all", limit });
    }

    const latencyMs = Date.now() - start;
    try { ctx.db.logSearch(query, usedStrategy, latencyMs, results.length, latencyMs > 2000); } catch { /* non-critical */ }
    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
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

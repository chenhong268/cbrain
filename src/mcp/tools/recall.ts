import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { truncate, safeFrontmatter, trimLink, trimTimeline, stubEntity } from "./trim.js";

const TOP_N = 3;

export function registerRecallTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool("deep_recall", {
    description:
      "Deep entity recall — searches the knowledge graph and returns a rich, pre-merged context bundle " +
      "(page content, links, timeline, tags, related entities) for each matched entity. " +
      "Use this instead of calling query + get_page + graph_query + get_links + get_timeline separately.",
    inputSchema: {
      query: z.string().describe("Search query"),
      limit: z.number().optional().default(5).describe("Max entities to recall (capped at 10)"),
      strategy: z.enum(["smart", "fts", "vector", "all"]).optional().default("smart")
        .describe("smart=FTS first, fallback to hybrid if empty (fastest); fts=FTS only; vector=embedding search; all=full hybrid (slowest)"),
    },
  }, async ({ query, limit, strategy }) => {
    const cap = Math.min(limit ?? 5, 10);

    const searchStart = Date.now();
    let searchResults: Awaited<ReturnType<typeof ctx.search.search>>;
    let usedStrategy: string = strategy;

    if (strategy === "smart") {
      // Exact slug/title match fast path
      const resolved = ctx.db.resolveSlugs([query])[0];
      const exactSlug = resolved?.slug ?? null;

      const ftsRaw = ctx.db.ftsSearch(query, cap);
      if (ftsRaw.length > 0) {
        searchResults = ftsRaw.map(r => ({ slug: r.page_slug, score: 1 / (1 + r.rank), snippet: r.content.slice(0, 200), source: "fts" as const }));
        usedStrategy = "smart-fts";
      } else {
        searchResults = await ctx.search.search(query, { limit: cap });
        usedStrategy = "smart-hybrid";
      }

      // Promote exact match to top
      if (exactSlug) {
        const existingIdx = searchResults.findIndex(r => r.slug === exactSlug);
        if (existingIdx > 0) {
          const [match] = searchResults.splice(existingIdx, 1);
          searchResults.unshift({ ...match, score: 1.0 });
        } else if (existingIdx === -1) {
          searchResults.unshift({ slug: exactSlug, score: 1.0, snippet: resolved.title ?? query, source: "exact" as const });
        }
      }
    } else if (strategy === "fts") {
      searchResults = await ctx.search.search(query, { strategy: "fts", limit: cap });
    } else if (strategy === "vector") {
      searchResults = await ctx.search.search(query, { strategy: "vector", limit: cap });
    } else {
      searchResults = await ctx.search.search(query, { limit: cap });
    }

    const searchLatencyMs = Date.now() - searchStart;

    try { ctx.db.logSearch(query, usedStrategy, searchLatencyMs, searchResults.length, searchLatencyMs > 2000); } catch { /* non-critical */ }

    if (searchResults.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ query, entities: [], summary: "未找到相关实体" }, null, 2),
        }],
      };
    }

    // ── Batch enrichment for top-N entities ──────────────────────
    // Pre-fetch pages for all results (stubs need them too)
    const pagesBySlug = new Map<string, ReturnType<typeof ctx.pages.getBySlug>>();
    for (const sr of searchResults) {
      const p = ctx.pages.getBySlug(sr.slug);
      if (p) pagesBySlug.set(sr.slug, p);
    }

    // Batch enrichment: collect all slugs for top-N, then batch-fetch links/timeline/tags
    const topSlugs = searchResults.slice(0, TOP_N).map(r => r.slug);

    const linksBySlug = new Map<string, { outgoing: Record<string, unknown>[]; incoming: Record<string, unknown>[] }>();
    const timelineBySlug = new Map<string, Record<string, unknown>[]>();
    const tagsBySlug = new Map<string, string[]>();
    const relatedBySlug = new Map<string, { slug: string; title: string; type: string }[]>();

    for (const slug of topSlugs) {
      try {
        const raw = ctx.graph.getLinks(slug, "both");
        const outgoing = raw.filter(l => l.from_slug === slug).map(trimLink).filter(Boolean) as Record<string, unknown>[];
        const incoming = raw.filter(l => l.to_slug === slug).map(trimLink).filter(Boolean) as Record<string, unknown>[];
        linksBySlug.set(slug, { outgoing, incoming });
      } catch { linksBySlug.set(slug, { outgoing: [], incoming: [] }); }

      try {
        const rawTimeline = ctx.db.getTimeline(slug) as Array<{ summary: string; event_date: string | null; source: string | null; created_at: string; id: number }>;
        timelineBySlug.set(slug, trimTimeline(rawTimeline, 3));
      } catch { timelineBySlug.set(slug, []); }

      try {
        const page = pagesBySlug.get(slug);
        const dbTags = ctx.db.getTags(slug);
        const fmTags = (page as { frontmatter?: { tags?: string[] } } | undefined)?.frontmatter?.tags ?? [];
        tagsBySlug.set(slug, [...new Set([...dbTags, ...fmTags])]);
      } catch { tagsBySlug.set(slug, []); }

      try { relatedBySlug.set(slug, ctx.graph.getRelatedEntities(slug, 5)); } catch { relatedBySlug.set(slug, []); }
    }

    // Build entity objects
    const entities = searchResults.map((sr, idx) => {
      const slug = sr.slug;

      if (idx >= TOP_N) {
        return stubEntity(sr, pagesBySlug.get(slug) ?? null);
      }

      const page = pagesBySlug.get(slug);
      const links = linksBySlug.get(slug) ?? { outgoing: [], incoming: [] };
      const timeline = timelineBySlug.get(slug) ?? [];
      const tags = tagsBySlug.get(slug) ?? [];
      const related = relatedBySlug.get(slug) ?? [];
      const tier = page?.frontmatter?.tier ?? page?.tier;
      const quality = tier != null
        ? (tier >= 3 ? "high" : tier === 2 ? "ok" : "low")
        : "unknown";

      return {
        slug,
        title: page?.title ?? slug,
        type: page?.frontmatter?.type ?? page?.type ?? "unknown",
        relevance: sr.score,
        quality,
        tier,
        snippet: sr.snippet,
        body: truncate(page?.body, 500),
        frontmatter: safeFrontmatter(page?.frontmatter ?? null),
        links,
        timeline,
        tags,
        related,
      };
    });

    const totalLinks = entities.reduce(
      (n, e) => n + ((e as { links: { outgoing: unknown[]; incoming: unknown[] } }).links?.outgoing?.length ?? 0) +
        ((e as { links: { outgoing: unknown[]; incoming: unknown[] } }).links?.incoming?.length ?? 0),
      0,
    );
    const totalTimeline = entities.reduce((n, e) => n + ((e as { timeline: unknown[] }).timeline?.length ?? 0), 0);
    const lowQuality = entities.filter((e) => (e as { quality?: string }).quality === "low").length;
    const stubCount = entities.filter(e => (e as { _stub?: boolean })._stub).length;

    // Cross-references — single batch query across all top-N entities
    const allRelatedSlugs = new Set<string>();
    for (const slug of topSlugs) {
      const links = linksBySlug.get(slug);
      const related = relatedBySlug.get(slug);
      if (links) {
        for (const l of links.outgoing) allRelatedSlugs.add(l.to_slug as string);
        for (const l of links.incoming) allRelatedSlugs.add(l.from_slug as string);
      }
      if (related) for (const r of related) allRelatedSlugs.add(r.slug);
    }
    const allRecent = allRelatedSlugs.size > 0 ? ctx.db.getRecentUpdatesBySlugs([...allRelatedSlugs], 7) : [];
    const crossRefs: { subject: string; related: string; type: string; updated_at: string }[] = [];
    for (const slug of topSlugs) {
      const entityTitle = (pagesBySlug.get(slug) as { title?: string } | undefined)?.title ?? slug;
      const links = linksBySlug.get(slug);
      const related = relatedBySlug.get(slug);
      const entityRelatedSlugs = new Set<string>();
      if (links) {
        for (const l of links.outgoing) entityRelatedSlugs.add(l.to_slug as string);
        for (const l of links.incoming) entityRelatedSlugs.add(l.from_slug as string);
      }
      if (related) for (const r of related) entityRelatedSlugs.add(r.slug);
      for (const r of allRecent) {
        if (entityRelatedSlugs.has(r.slug)) {
          crossRefs.push({ subject: entityTitle, related: r.title, type: r.type, updated_at: r.updated_at });
        }
      }
    }
    const seen = new Set<string>();
    const uniqueRefs = crossRefs.filter(r => {
      const key = `${r.subject}↔${r.related}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 10);

    // Related insights — single batch call
    const relatedInsights = ctx.insights.getInsightsForEntities(topSlugs, 5).map(i => ({
      id: i.id, type: i.type,
      content: i.content.length > 150 ? i.content.slice(0, 150) + "..." : i.content,
      confidence: i.confidence,
    }));

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(
          {
            query,
            search_meta: { strategy: usedStrategy, latency_ms: searchLatencyMs, degraded: searchLatencyMs > 2000 },
            entities,
            insights: relatedInsights.length > 0 ? relatedInsights : undefined,
            cross_refs: uniqueRefs.length > 0 ? uniqueRefs : undefined,
            summary: `找到 ${entities.length} 个实体（${stubCount} 个摘要，${lowQuality} 个低质量），${totalLinks} 个链接，${totalTimeline} 个时间线事件` +
              (relatedInsights.length > 0 ? `，${relatedInsights.length} 条相关洞察` : "") +
              (uniqueRefs.length > 0 ? `，${uniqueRefs.length} 个关联更新` : ""),
          },
          null,
          2,
        ),
      }],
    };
  });
}

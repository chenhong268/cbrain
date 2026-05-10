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
    },
  }, async ({ query, limit }) => {
    const cap = Math.min(limit ?? 5, 10);

    const searchStart = Date.now();
    const searchResults = await ctx.search.search(query, { limit: cap });
    const searchLatencyMs = Date.now() - searchStart;

    try { ctx.db.logSearch(query, "hybrid", searchLatencyMs, searchResults.length, searchLatencyMs > 2000); } catch { /* non-critical */ }

    if (searchResults.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ query, entities: [], summary: "未找到相关实体" }, null, 2),
        }],
      };
    }

    const entities = searchResults.map((sr, idx) => {
      const slug = sr.slug;

      // Stubs for entities beyond TOP_N
      if (idx >= TOP_N) {
        const p = ctx.pages.getBySlug(slug);
        return stubEntity(sr, p);
      }

      // Top N entities get trimmed detail
      let links = { outgoing: [] as Record<string, unknown>[], incoming: [] as Record<string, unknown>[] };
      let timeline: Record<string, unknown>[] = [];
      let tags: string[] = [];
      let related: { slug: string; title: string; type: string }[] = [];
      let tier: number | undefined;
      let quality: string;

      const page = ctx.pages.getBySlug(slug);

      // Links — trimmed
      try {
        const raw = ctx.graph.getLinks(slug, "both");
        const outgoing = raw.filter(l => l.from_slug === slug).map(trimLink).filter(Boolean) as Record<string, unknown>[];
        const incoming = raw.filter(l => l.to_slug === slug).map(trimLink).filter(Boolean) as Record<string, unknown>[];
        links = { outgoing, incoming };
      } catch { /* keep empty */ }

      // Timeline — trimmed
      try {
        const rawTimeline = ctx.db.getTimeline(slug) as Array<{ summary: string; event_date: string | null; source: string | null; created_at: string; id: number }>;
        timeline = trimTimeline(rawTimeline, 3);
      } catch { /* keep empty */ }

      // Tags
      try {
        const dbTags = ctx.db.getTags(slug);
        const fmTags = page?.frontmatter?.tags ?? [];
        tags = [...new Set([...dbTags, ...fmTags])];
      } catch { /* keep empty */ }

      // Related entities
      try { related = ctx.graph.getRelatedEntities(slug, 5); } catch { /* keep empty */ }

      // Quality
      tier = page?.frontmatter?.tier ?? page?.tier;
      quality = tier != null
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
      (n, e) => n + ((e.links as { outgoing: unknown[]; incoming: unknown[] })?.outgoing?.length ?? 0) +
        ((e.links as { outgoing: unknown[]; incoming: unknown[] })?.incoming?.length ?? 0),
      0,
    );
    const totalTimeline = entities.reduce((n, e) => n + ((e.timeline as unknown[])?.length ?? 0), 0);
    const lowQuality = entities.filter((e) => (e as { quality?: string }).quality === "low").length;
    const stubCount = entities.filter(e => (e as { _stub?: boolean })._stub).length;

    // Cross-references — recent activity among linked entities
    const crossRefs: { subject: string; related: string; type: string; updated_at: string }[] = [];
    for (const entity of entities.slice(0, TOP_N)) {
      const eLinks = (entity as { links?: { outgoing: Record<string, unknown>[]; incoming: Record<string, unknown>[] } }).links;
      const eRelated = (entity as { related?: { slug: string }[] }).related;
      if (!eLinks && !eRelated) continue;

      const relatedSlugs = new Set([
        ...(eLinks?.outgoing ?? []).map((l: Record<string, unknown>) => l.to_slug as string),
        ...(eLinks?.incoming ?? []).map((l: Record<string, unknown>) => l.from_slug as string),
        ...(eRelated ?? []).map((r: { slug: string }) => r.slug),
      ]);
      const recent = ctx.db.getRecentUpdatesBySlugs([...relatedSlugs], 7);
      for (const r of recent) {
        crossRefs.push({ subject: (entity as { title: string }).title, related: r.title, type: r.type, updated_at: r.updated_at });
      }
    }
    const seen = new Set<string>();
    const uniqueRefs = crossRefs.filter(r => {
      const key = `${r.subject}↔${r.related}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 10);

    // Related insights
    const allSlugs = entities.slice(0, TOP_N).map(e => (e as { slug: string }).slug);
    const relatedInsights = ctx.insights.getInsightsForEntities(allSlugs, 5).map(i => ({
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
            search_meta: { strategy: "hybrid", latency_ms: searchLatencyMs, degraded: searchLatencyMs > 2000 },
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

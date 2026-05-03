import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import type { PageFrontmatter } from "../../utils/frontmatter.js";

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

    const searchResults = await ctx.search.search(query, { strategy: "all", limit: cap });

    if (searchResults.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ query, entities: [], summary: "未找到相关实体" }, null, 2),
        }],
      };
    }

    const entities = searchResults.map((sr) => {
      const slug = sr.slug;

      let page: Record<string, unknown> | null = null;
      let frontmatter: PageFrontmatter | null = null;
      let links = { outgoing: [] as Record<string, unknown>[], incoming: [] as Record<string, unknown>[] };
      let timeline: Record<string, unknown>[] = [];
      let tags: string[] = [];
      let related: { slug: string; title: string; type: string }[] = [];

      try {
        const p = ctx.pages.getBySlug(slug);
        if (p) {
          page = p as unknown as Record<string, unknown>;
          frontmatter = (p as unknown as { frontmatter: PageFrontmatter }).frontmatter ?? null;
        }
      } catch { /* keep null */ }

      try {
        const raw = ctx.graph.getLinks(slug, "both") as { from_slug: string; to_slug: string; relation: string; context?: string }[];
        links = {
          outgoing: raw.filter((l) => l.from_slug === slug) as Record<string, unknown>[],
          incoming: raw.filter((l) => l.to_slug === slug) as Record<string, unknown>[],
        };
      } catch { /* keep empty */ }

      try { timeline = ctx.db.getTimeline(slug) as Record<string, unknown>[]; } catch { /* keep empty */ }
      try {
        const dbTags = ctx.db.getTags(slug);
        const fmTags = frontmatter?.tags ?? [];
        tags = [...new Set([...dbTags, ...fmTags])];
      } catch { /* keep empty */ }
      try { related = ctx.graph.getRelatedEntities(slug, 5); } catch { /* keep empty */ }

      const tier = frontmatter?.tier ?? (page as { tier?: number } | null)?.tier;
      const quality = tier != null
        ? (tier >= 3 ? "high" : tier === 2 ? "ok" : "low")
        : "unknown";

      return {
        slug,
        title: frontmatter?.title ?? (page as { title?: string } | null)?.title ?? slug,
        type: frontmatter?.type ?? (page as { type?: string } | null)?.type ?? "unknown",
        relevance: sr.score,
        quality,
        tier,
        snippet: sr.snippet,
        page,
        links,
        timeline,
        tags,
        related,
      };
    });

    const totalLinks = entities.reduce(
      (n, e) => n + e.links.outgoing.length + e.links.incoming.length,
      0,
    );
    const totalTimeline = entities.reduce((n, e) => n + e.timeline.length, 0);
    const lowQuality = entities.filter((e) => e.quality === "low").length;

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(
          {
            query,
            entities,
            summary: `找到 ${entities.length} 个实体（${lowQuality} 个低质量），${totalLinks} 个链接，${totalTimeline} 个时间线事件`,
          },
          null,
          2,
        ),
      }],
    };
  });
}

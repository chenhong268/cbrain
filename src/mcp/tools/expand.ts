import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";

export function registerExpandTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool("expand_entity", {
    description:
      "Expand a single entity to full detail — complete body, all links, full timeline, " +
      "tags, related entities, and insights. Use this after deep_recall or summarize " +
      "when a stub entity looks relevant and you need the full picture.",
    inputSchema: {
      slug: z.string().describe("Entity slug to expand"),
      includeBody: z.boolean().optional().default(true).describe("Include full page body"),
      includeLinks: z.boolean().optional().default(true).describe("Include all links with full context"),
      includeTimeline: z.boolean().optional().default(true).describe("Include all timeline events"),
    },
  }, async ({ slug, includeBody, includeLinks, includeTimeline }) => {
    const page = ctx.pages.getBySlug(slug);
    if (!page) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: `Entity not found: ${slug}` }) }],
        isError: true,
      };
    }

    // Links — full, no weight filter, no context truncation
    let links: Record<string, unknown> = {};
    if (includeLinks) {
      const raw = ctx.graph.getLinks(slug, "both");
      links = {
        outgoing: raw.filter(l => l.from_slug === slug),
        incoming: raw.filter(l => l.to_slug === slug),
      };
    }

    // Timeline — all events, no truncation
    let timeline: Record<string, unknown>[] = [];
    if (includeTimeline) {
      timeline = ctx.db.getTimeline(slug) as Record<string, unknown>[];
    }

    // Tags
    const fmTags = (page.frontmatter.tags as string[]) ?? [];
    let dbTags: string[] = [];
    try { dbTags = ctx.db.getTags(slug); } catch { /* ignore */ }
    const tags = [...new Set([...fmTags, ...dbTags])];

    // Related entities
    let related: { slug: string; title: string; type: string }[] = [];
    try { related = ctx.graph.getRelatedEntities(slug, 10); } catch { /* ignore */ }

    // Insights
    const insights = ctx.insights.getInsightsForEntities([slug], 5).map(i => ({
      id: i.id,
      type: i.type,
      content: i.content.length > 300 ? i.content.slice(0, 300) + "..." : i.content,
      confidence: i.confidence,
    }));

    // Auto-feedback: user expanded this entity = strong positive signal
    ctx.learn.bumpOnExpand(slug);

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          slug: page.slug,
          title: page.title,
          type: page.type,
          tier: page.tier,
          body: includeBody ? page.body : undefined,
          frontmatter: page.frontmatter,
          links: includeLinks ? links : undefined,
          timeline: includeTimeline ? timeline : undefined,
          tags,
          related: related.length > 0 ? related : undefined,
          insights: insights.length > 0 ? insights : undefined,
          meta: {
            mention_count: page.mention_count,
            expires_at: page.expires_at,
            confidence_decay: page.confidence_decay,
            created_at: page.created_at,
            updated_at: page.updated_at,
          },
        }, null, 2),
      }],
    };
  });
}

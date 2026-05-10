import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { truncate, safeFrontmatter, trimLink, trimTimeline, stubEntity } from "./trim.js";

const TOP_N = 3;

export function registerSummarizeTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool("summarize", {
    description:
      "Get a rich, structured overview of a topic from the knowledge graph. " +
      "Searches for related entities, traverses their graph neighborhood, and returns a context bundle " +
      "(page content, links, timeline, tags, neighbors, cross-references). " +
      "Use this when you need to quickly understand a domain or topic area.",
    inputSchema: {
      topic: z.string().describe("Topic or keyword to summarize"),
      limit: z.number().optional().default(5).describe("Max entities to include (capped at 10)"),
      depth: z.number().optional().default(1).describe("Graph traversal depth (0=no traversal, 1=direct neighbors, 2=two-hop)"),
      minWeight: z.number().optional().default(0).describe("Minimum link weight for traversal (0.5 = only strong relations)"),
    },
  }, async ({ topic, limit, depth, minWeight }) => {
    const cap = Math.min(limit ?? 5, 10);
    const traverseDepth = Math.min(depth ?? 1, 2);
    const minW = minWeight ?? 0;

    // Step 1: Search
    const searchStart = Date.now();
    const searchResults = await ctx.search.search(topic, { limit: cap * 2 });
    const searchLatencyMs = Date.now() - searchStart;

    try { ctx.db.logSearch(topic, "hybrid", searchLatencyMs, searchResults.length, searchLatencyMs > 2000); } catch { /* non-critical */ }

    if (searchResults.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ topic, entities: [], stats: { totalEntities: 0 }, summary: "未找到相关内容" }, null, 2),
        }],
      };
    }

    // Step 2: For each matching entity, gather context (trimmed or stub)
    const allSlugs = new Set<string>();
    const entities: Record<string, unknown>[] = [];

    for (let i = 0; i < searchResults.slice(0, cap).length; i++) {
      const sr = searchResults[i];
      const slug = sr.slug;
      allSlugs.add(slug);

      const page = ctx.pages.getBySlug(slug);
      if (!page) continue;

      // Stubs for entities beyond TOP_N
      if (i >= TOP_N) {
        entities.push(stubEntity(sr, page));
        allSlugs.add(slug);
        continue;
      }

      // Links — trimmed
      const rawLinks = ctx.graph.getLinks(slug, "both");
      const links = {
        outgoing: rawLinks.filter(l => l.from_slug === slug).map(trimLink).filter(Boolean),
        incoming: rawLinks.filter(l => l.to_slug === slug).map(trimLink).filter(Boolean),
      };

      // Timeline — trimmed
      const rawTimeline = ctx.db.getTimeline(slug) as Array<{ summary: string; event_date: string | null; source: string | null; created_at: string; id: number }>;
      const timeline = trimTimeline(rawTimeline, 3);

      // Tags
      const fmTags = (page.frontmatter.tags as string[]) ?? [];
      let dbTags: string[] = [];
      try { dbTags = ctx.db.getTags(slug); } catch { /* ignore */ }
      const tags = [...new Set([...fmTags, ...dbTags])];

      entities.push({
        slug,
        title: page.title,
        type: page.type,
        tier: page.tier,
        relevance: sr.score,
        snippet: sr.snippet,
        body: truncate(page.body, 500),
        frontmatter: safeFrontmatter(page.frontmatter),
        links,
        timeline,
        tags,
        expires_at: page.expires_at,
        confidence_decay: page.confidence_decay,
        created_at: page.created_at,
        updated_at: page.updated_at,
      });

      // Collect neighbor slugs
      for (const l of rawLinks) {
        allSlugs.add(l.from_slug === slug ? l.to_slug : l.from_slug);
      }
    }

    // Step 3: Graph traversal
    const neighbors: Record<string, unknown>[] = [];
    if (traverseDepth > 0) {
      const seenNeighbors = new Set(allSlugs);
      for (const entity of entities.slice(0, TOP_N)) {
        const nodes = ctx.graph.traverse(entity.slug as string, {
          maxDepth: traverseDepth,
          limit: 10,
          minWeight: minW > 0 ? minW : undefined,
        });
        for (const node of nodes) {
          if (seenNeighbors.has(node.slug)) continue;
          seenNeighbors.add(node.slug);
          allSlugs.add(node.slug);
          neighbors.push({
            slug: node.slug,
            title: node.title,
            type: node.type,
            depth: node.depth,
            connectedTo: entity.slug,
          });
        }
      }
    }

    // Step 4: Cross-references
    const recent = ctx.db.getRecentUpdatesBySlugs([...allSlugs], 7);
    const crossRefs = recent.filter(r => !entities.some(e => e.slug === r.slug)).map(r => ({
      slug: r.slug, title: r.title, type: r.type, updated_at: r.updated_at,
    }));

    // Stats
    const totalLinks = entities.reduce((n, e) => {
      const l = e.links as { outgoing: unknown[]; incoming: unknown[] };
      return n + (l?.outgoing?.length ?? 0) + (l?.incoming?.length ?? 0);
    }, 0);
    const totalEvents = entities.reduce((n, e) => n + ((e.timeline as unknown[])?.length ?? 0), 0);
    const avgTier = entities.length > 0
      ? Math.round(entities.reduce((s, e) => s + (e.tier as number), 0) / entities.length * 10) / 10
      : 0;
    const stubCount = entities.filter(e => (e as { _stub?: boolean })._stub).length;

    // Related insights
    const entitySlugs = entities.slice(0, TOP_N).map(e => e.slug as string);
    const relatedInsights = ctx.insights.getInsightsForEntities(entitySlugs, 5).map(i => ({
      id: i.id, type: i.type,
      content: i.content.length > 150 ? i.content.slice(0, 150) + "..." : i.content,
      confidence: i.confidence,
    }));

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          topic,
          search_meta: { strategy: "hybrid", latency_ms: searchLatencyMs, degraded: searchLatencyMs > 2000 },
          entities,
          insights: relatedInsights.length > 0 ? relatedInsights : undefined,
          neighbors: neighbors.length > 0 ? neighbors : undefined,
          crossRefs: crossRefs.length > 0 ? crossRefs : undefined,
          stats: { totalEntities: entities.length, detailEntities: entities.length - stubCount, stubEntities: stubCount, totalLinks, totalEvents, avgTier, totalNeighbors: neighbors.length, totalInsights: relatedInsights.length },
        }, null, 2),
      }],
    };
  });
}

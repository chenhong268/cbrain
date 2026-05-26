import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { findEntitySlug, normalizeRelation } from "../../core/shared.js";

export function registerGraphTools(server: McpServer, ctx: ToolContext): void {
  // ─── graph_query ─────────────────────────────────────────
  server.registerTool("graph_query", {
    description: "Query the knowledge graph. Traverse from a seed entity or get backlinks. Accepts a slug or entity name (auto-resolved). Links include source_type (wikilink=human, manual=agent, ner=LLM-extracted, dialogue=conversation, writeback=auto) and confidence (0-1, higher=more reliable).",
    inputSchema: {
      slug: z.string().describe("Seed entity slug or name (auto-resolved if not an exact slug)"),
      mode: z.enum(["traverse", "backlinks", "related"]).optional().default("traverse").describe("Query mode"),
      depth: z.number().optional().default(2).describe("Max traversal depth"),
      limit: z.number().optional().default(20).describe("Max results"),
      minWeight: z.number().optional().describe("Minimum link weight (0-1). Higher = stronger links only."),
      source_type: z.string().optional().describe("Filter links by source type: wikilink, manual, ner, dialogue, writeback, unknown"),
      session_id: z.string().optional().describe("Current conversation session ID for co-occurrence tracking"),
    },
  }, async ({ slug, mode, depth, limit, minWeight, source_type, session_id }) => {
    const graphStart = Date.now();
    let resolvedSlug = slug;
    if (!ctx.pages.getBySlug(slug)) {
      const found = findEntitySlug(ctx.db, slug);
      if (found) resolvedSlug = found;
    }

    let result;
    switch (mode) {
      case "backlinks":
        result = ctx.graph.getBacklinks(resolvedSlug);
        if (source_type) result = result.filter(l => l.source_type === source_type);
        break;
      case "related":
        result = ctx.graph.getRelatedEntities(resolvedSlug, limit);
        break;
      default:
        result = ctx.graph.traverse(resolvedSlug, { maxDepth: depth, limit, minWeight });
    }

    // Learning loop: extract slugs from result, log + bump
    const graphSlugs: string[] = [];
    if (Array.isArray(result)) {
      for (const item of result) {
        if ("slug" in item) graphSlugs.push((item as { slug: string }).slug);
        else if ("from_slug" in item && "to_slug" in item) {
          const link = item as { from_slug: string; to_slug: string };
          if (link.from_slug !== resolvedSlug) graphSlugs.push(link.from_slug);
          if (link.to_slug !== resolvedSlug) graphSlugs.push(link.to_slug);
        }
      }
    }
    const graphLatency = Date.now() - graphStart;
    try { ctx.db.logQuery("graph", resolvedSlug, graphSlugs, graphLatency, session_id); } catch { /* non-critical */ }
    for (let i = 0; i < graphSlugs.length; i++) {
      try { ctx.learn.bumpOnQuery(graphSlugs[i], i, "graph"); } catch { /* non-critical */ }
    }
    if (mode !== "backlinks" && graphSlugs.length > 0) {
      for (const s of graphSlugs) {
        try { ctx.db.boostLinkConfidence(resolvedSlug, s, "mentions", 0.02); } catch { /* non-critical */ }
      }
    }

    return {
      content: [{ type: "text", text: JSON.stringify({ resolvedSlug, result }, null, 2) }],
    };
  });

  // ─── get_links ───────────────────────────────────────────────
  server.registerTool("get_links", {
    description: "Get links for a page. Returns outgoing, incoming, or both directions. Links include source_type (wikilink=human, manual=agent, ner=LLM-extracted, dialogue=conversation, writeback=auto) and confidence (0-1, higher=more reliable).",
    inputSchema: {
      slug: z.string().describe("Page slug"),
      direction: z.enum(["outgoing", "incoming", "both"]).optional().default("both").describe("Link direction"),
    },
  }, async ({ slug, direction }) => {
    const links = ctx.graph.getLinks(slug, direction);
    return {
      content: [{ type: "text", text: JSON.stringify(links, null, 2) }],
    };
  });

  // ─── add_link ────────────────────────────────────────────────
  server.registerTool("add_link", {
    description: "Create a link between two pages. Links created via this tool are marked as source_type=manual with confidence=0.9.",
    inputSchema: {
      from: z.string().describe("Source page slug"),
      to: z.string().describe("Target page slug"),
      relation: z.string().default("提及").describe("Relation type (e.g. '提及', 'works_at')"),
      context: z.string().optional().describe("Optional context for the relation"),
      weight: z.number().optional().describe("Link weight 0-1. Auto-assigned if omitted."),
      strength: z.enum(["strong", "medium", "weak"]).optional().describe("Link strength. Auto-assigned if omitted."),
    },
  }, async ({ from, to, relation, context, weight, strength }) => {
    if (!ctx.pages.getBySlug(from)) return { content: [{ type: "text", text: JSON.stringify({ error: `Source page not found: ${from}` }) }], isError: true };
    if (!ctx.pages.getBySlug(to)) return { content: [{ type: "text", text: JSON.stringify({ error: `Target page not found: ${to}` }) }], isError: true };
    if (from === to) return { content: [{ type: "text", text: JSON.stringify({ error: "Cannot create self-referencing link" }) }], isError: true };

    ctx.db.insertLink(from, to, normalizeRelation(relation), context ?? null, weight, strength, "manual", 0.9);
    ctx.pages.incrementMention(to);
    ctx.pages.syncLinksToMarkdown(from);
    ctx.pages.syncLinksToMarkdown(to);

    return {
      content: [{ type: "text", text: JSON.stringify({ success: true, from, to, relation }) }],
    };
  });

  // ─── remove_link ─────────────────────────────────────────────
  server.registerTool("remove_link", {
    description: "Remove a link between two pages.",
    inputSchema: {
      from: z.string().describe("Source page slug"),
      to: z.string().describe("Target page slug"),
      relation: z.string().optional().describe("Relation type (omit to remove all relations between the two)"),
    },
  }, async ({ from, to, relation }) => {
    const ok = ctx.graph.removeLink(from, to, relation);
    if (ok) {
      ctx.pages.syncLinksToMarkdown(from);
      ctx.pages.syncLinksToMarkdown(to);
    }
    return {
      content: [{ type: "text", text: JSON.stringify({ success: ok, from, to, relation }) }],
    };
  });
}

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { findEntitySlug, normalizeRelation } from "../../core/shared.js";
import { formatGraphEnvelope, formatGraphPathEnvelope, formatLinksEnvelope } from "./format-result.js";

type LinkDirection = "outgoing" | "incoming" | "both";
type LinkAction = "list" | "add" | "remove";

function linkJson(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

export function registerGraphTools(server: McpServer, ctx: ToolContext): void {
  const listLinks = (slug: string, direction: LinkDirection = "both") => {
    const links = ctx.graph.getLinks(slug, direction);
    const linkSlugs = links.map(l => l.from_slug === slug ? l.to_slug : l.from_slug);
    const titleMap = ctx.db.getPageTitlesAndTypes(linkSlugs);
    const titleResolver = (s: string) => titleMap.get(s)?.title || null;
    const envelope = formatLinksEnvelope(links, slug, titleResolver);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }],
    };
  };

  const addLink = (
    from: string,
    to: string,
    relation = "提及",
    context?: string,
    weight?: number,
    strength?: "strong" | "medium" | "weak",
  ) => {
    if (!ctx.pages.getBySlug(from)) return { ...linkJson({ error: `Source page not found: ${from}` }), isError: true };
    if (!ctx.pages.getBySlug(to)) return { ...linkJson({ error: `Target page not found: ${to}` }), isError: true };
    if (from === to) return { ...linkJson({ error: "Cannot create self-referencing link" }), isError: true };

    ctx.db.insertLink(from, to, normalizeRelation(relation), context ?? null, weight, strength, "agent", 0.9);
    ctx.pages.incrementMention(to);
    const addWarnings = ctx.pages.syncAffectedSlugs([from, to]);

    return linkJson({ success: true, from, to, relation, ...(addWarnings.length > 0 ? { sync_warnings: addWarnings } : {}) });
  };

  const removeLink = (from: string, to: string, relation?: string) => {
    const ok = ctx.graph.removeLink(from, to, relation);
    let removeWarnings: Array<{ slug: string; error: string }> = [];
    if (ok) {
      removeWarnings = ctx.pages.syncAffectedSlugs([from, to]);
    }
    return linkJson({ success: ok, from, to, relation, ...(removeWarnings.length > 0 ? { sync_warnings: removeWarnings } : {}) });
  };

  const runLinkAction = (
    action: LinkAction,
    input: {
      slug?: string;
      direction?: LinkDirection;
      from?: string;
      to?: string;
      relation?: string;
      context?: string;
      weight?: number;
      strength?: "strong" | "medium" | "weak";
    },
  ) => {
    if (action === "list") {
      if (!input.slug) return { ...linkJson({ error: "slug is required for link action=list" }), isError: true };
      return listLinks(input.slug, input.direction);
    }
    if (!input.from) return { ...linkJson({ error: `from is required for link action=${action}` }), isError: true };
    if (!input.to) return { ...linkJson({ error: `to is required for link action=${action}` }), isError: true };
    if (action === "add") {
      return addLink(input.from, input.to, input.relation ?? "提及", input.context, input.weight, input.strength);
    }
    return removeLink(input.from, input.to, input.relation);
  };

  // ─── graph_query ─────────────────────────────────────────
  server.registerTool("graph_query", {
    description: "Query the knowledge graph. Traverse from a seed entity or get backlinks. Accepts a slug or entity name (auto-resolved). Links include source_type (wikilink=human, manual=human explicit input, agent=agent inference, ner=LLM-extracted, dialogue=conversation, writeback=auto) and confidence (0-1, higher=more reliable).",
    inputSchema: {
      slug: z.string().max(500).describe("Seed entity slug or name (auto-resolved if not an exact slug)"),
      mode: z.enum(["traverse", "backlinks", "related", "shortest_path"]).optional().default("traverse").describe("Query mode"),
      target: z.string().max(500).optional().describe("Target entity slug or name, required for shortest_path"),
      depth: z.number().optional().describe("Max traversal depth; defaults to 2, or 4 for shortest_path"),
      limit: z.number().optional().default(20).describe("Max results"),
      minWeight: z.number().optional().describe("Minimum link weight (0-1). Higher = stronger links only."),
      source_type: z.string().max(100).optional().describe("Filter links by source type: wikilink, manual, ner, dialogue, writeback, unknown"),
      session_id: z.string().max(200).optional().describe("Current conversation session ID for co-occurrence tracking"),
    },
  }, async ({ slug, mode, target, depth, limit, minWeight, source_type, session_id }) => {
    const graphStart = Date.now();

    if (mode === "shortest_path") {
      const maxDepth = depth ?? 4;
      if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 6) {
        return linkJson(formatGraphPathEnvelope({ maxDepth, reason: "invalid_depth", path: null }));
      }
      if (!target) {
        return linkJson(formatGraphPathEnvelope({ maxDepth, reason: "missing_target", path: null }));
      }

      const resolveEndpoint = (input: string): string | null => {
        if (ctx.db.getPage(input)) return input;
        return findEntitySlug(ctx.db, input);
      };
      const fromSlug = resolveEndpoint(slug);
      if (!fromSlug) {
        return linkJson(formatGraphPathEnvelope({ maxDepth, reason: "unresolved_source", path: null }));
      }
      const toSlug = resolveEndpoint(target);
      if (!toSlug) {
        return linkJson(formatGraphPathEnvelope({ maxDepth, reason: "unresolved_target", path: null }));
      }

      const titles = ctx.db.getPageTitlesAndTypes([fromSlug, toSlug]);
      const fromTitle = titles.get(fromSlug)?.title;
      const toTitle = titles.get(toSlug)?.title;
      const path = ctx.graph.findShortestPath(fromSlug, toSlug, { maxDepth });
      try {
        ctx.db.logQuery("graph", fromSlug, path?.nodes.map((node) => node.slug) ?? [], Date.now() - graphStart, session_id);
      } catch { /* non-critical telemetry */ }
      return linkJson(formatGraphPathEnvelope({
        fromTitle,
        toTitle,
        maxDepth,
        reason: path ? "path_found" : "no_path",
        path,
      }));
    }

    let resolvedSlug = slug;
    if (!ctx.pages.getBySlug(slug)) {
      const found = findEntitySlug(ctx.db, slug);
      if (found) resolvedSlug = found;
    }

    let result: ReturnType<typeof ctx.graph.getBacklinks> | ReturnType<typeof ctx.graph.traverse>;
    switch (mode) {
      case "backlinks":
        result = ctx.graph.getBacklinks(resolvedSlug);
        if (source_type) result = result.filter(l => l.source_type === source_type);
        break;
      case "related":
        result = ctx.graph.getRelatedEntities(resolvedSlug, limit);
        break;
      default:
        result = ctx.graph.traverse(resolvedSlug, { maxDepth: depth ?? 2, limit, minWeight });
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

    // Build title map from DB (not PageManager/vault) for reliable resolution
    const allSlugs = [...new Set([resolvedSlug, ...graphSlugs])];
    const titleMap = ctx.db.getPageTitlesAndTypes(allSlugs);
    const titleResolver = (s: string) => titleMap.get(s)?.title || null;
    const envelope = formatGraphEnvelope({ resolvedSlug, result }, titleResolver);
    return {
      content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
    };
  });

  // ─── link ─────────────────────────────────────────────────
  server.registerTool("link", {
    description: "Unified link operations. Use action=list/add/remove. Compatibility aliases get_links/add_link/remove_link remain available.",
    inputSchema: {
      action: z.enum(["list", "add", "remove"]).describe("Link action to run"),
      slug: z.string().max(500).optional().describe("Page slug for action=list"),
      direction: z.enum(["outgoing", "incoming", "both"]).optional().default("both").describe("Link direction for action=list"),
      from: z.string().max(500).optional().describe("Source page slug for action=add/remove"),
      to: z.string().max(500).optional().describe("Target page slug for action=add/remove"),
      relation: z.string().max(100).optional().describe("Relation type. Defaults to 提及 for action=add; omit for action=remove to remove all relations between the two."),
      context: z.string().max(10_000).optional().describe("Optional context for action=add"),
      weight: z.number().optional().describe("Link weight 0-1 for action=add. Auto-assigned if omitted."),
      strength: z.enum(["strong", "medium", "weak"]).optional().describe("Link strength for action=add. Auto-assigned if omitted."),
    },
  }, async ({ action, slug, direction, from, to, relation, context, weight, strength }) => {
    return runLinkAction(action, { slug, direction, from, to, relation, context, weight, strength });
  });

  // ─── get_links ───────────────────────────────────────────────
  server.registerTool("get_links", {
    description: "Get links for a page. Returns outgoing, incoming, or both directions. Links include source_type (wikilink=human, manual=human explicit input, agent=agent inference, ner=LLM-extracted, dialogue=conversation, writeback=auto) and confidence (0-1, higher=more reliable).",
    inputSchema: {
      slug: z.string().max(500).describe("Page slug"),
      direction: z.enum(["outgoing", "incoming", "both"]).optional().default("both").describe("Link direction"),
    },
  }, async ({ slug, direction }) => {
    return listLinks(slug, direction);
  });

  // ─── add_link ────────────────────────────────────────────────
  server.registerTool("add_link", {
    description: "Create a link between two pages. Links created via this tool are marked as source_type=agent (agent_inference) with confidence=0.9. To mark a link as user-confirmed, use confirm_evidence after creation.",
    inputSchema: {
      from: z.string().max(500).describe("Source page slug"),
      to: z.string().max(500).describe("Target page slug"),
      relation: z.string().max(100).default("提及").describe("Relation type (e.g. '提及', 'works_at')"),
      context: z.string().max(10_000).optional().describe("Optional context for the relation"),
      weight: z.number().optional().describe("Link weight 0-1. Auto-assigned if omitted."),
      strength: z.enum(["strong", "medium", "weak"]).optional().describe("Link strength. Auto-assigned if omitted."),
    },
  }, async ({ from, to, relation, context, weight, strength }) => {
    return addLink(from, to, relation, context, weight, strength);
  });

  // ─── remove_link ─────────────────────────────────────────────
  server.registerTool("remove_link", {
    description: "Remove a link between two pages.",
    inputSchema: {
      from: z.string().max(500).describe("Source page slug"),
      to: z.string().max(500).describe("Target page slug"),
      relation: z.string().max(100).optional().describe("Relation type (omit to remove all relations between the two)"),
    },
  }, async ({ from, to, relation }) => {
    return removeLink(from, to, relation);
  });
}

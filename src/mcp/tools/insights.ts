import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";

const InsightTypeSchema = z.enum(["synthesis", "pattern", "anomaly", "bridge"]);
const InsightStatusSchema = z.enum(["active", "archived", "dismissed"]);
const InsightSourceTypeSchema = z.enum(["reflect", "discovery", "manual"]);

type InsightType = z.infer<typeof InsightTypeSchema>;
type InsightStatus = z.infer<typeof InsightStatusSchema>;
type InsightSourceType = z.infer<typeof InsightSourceTypeSchema>;

function textJson(data: unknown, pretty = false) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify(data, null, pretty ? 2 : undefined),
    }],
  };
}

function missingField(action: string, field: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: `insight action=${action} requires ${field}` }) }],
    isError: true,
  };
}

function handleListInsights(ctx: ToolContext, args: { type?: InsightType; status?: InsightStatus; sourceType?: InsightSourceType; limit?: number; offset?: number }) {
  const rows = ctx.insights.listInsights({
    type: args.type,
    status: args.status,
    sourceType: args.sourceType,
    limit: args.limit ?? 10,
    offset: args.offset ?? 0,
  });

  const insights = rows.map(r => ({
    id: r.id,
    type: r.type,
    content: r.content.length > 200 ? r.content.slice(0, 200) + "..." : r.content,
    confidence: r.confidence,
    source_entities: r.source_entities ? JSON.parse(r.source_entities) : [],
    source_type: r.source_type,
    created_at: r.created_at,
  }));

  return textJson({ insights, total: insights.length }, true);
}

function handleGetInsight(ctx: ToolContext, id: number) {
  const row = ctx.insights.getInsight(id);
  if (!row) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ error: `Insight #${id} not found` }) }],
      isError: true,
    };
  }

  const sourceEntities: string[] = row.source_entities ? JSON.parse(row.source_entities) : [];
  const entitySummaries = sourceEntities.slice(0, 10).map(slug => {
    const page = ctx.db.getPage(slug);
    return page ? { slug, title: page.title, type: page.type } : { slug, title: "(deleted)", type: "unknown" };
  });

  return textJson({
    id: row.id,
    type: row.type,
    content: row.content,
    confidence: row.confidence,
    source_entities: entitySummaries,
    source_type: row.source_type,
    status: row.status,
    created_at: row.created_at,
    expires_at: row.expires_at,
    seen: row.seen,
  }, true);
}

function handleArchiveInsight(ctx: ToolContext, id: number) {
  const ok = ctx.insights.archiveInsight(id);
  return textJson({ success: ok, id, action: "archived" });
}

function handleDismissInsight(ctx: ToolContext, id: number) {
  const ok = ctx.insights.dismissInsight(id);
  return textJson({ success: ok, id, action: "dismissed" });
}

async function handleQueryInsights(ctx: ToolContext, args: { query: string; limit?: number }) {
  const rows = await ctx.insights.queryInsights(args.query, args.limit ?? 5);

  const insights = rows.map(r => ({
    id: r.id,
    type: r.type,
    content: r.content.length > 200 ? r.content.slice(0, 200) + "..." : r.content,
    confidence: r.confidence,
    source_type: r.source_type,
    created_at: r.created_at,
  }));

  return textJson({ insights, query: args.query, total: insights.length }, true);
}

async function handlePromoteDiscovery(ctx: ToolContext, args: { discoveryId: number; content?: string; type?: InsightType; confidence?: number }) {
  const discovery = ctx.db.getDiscoveryById(args.discoveryId);
  if (!discovery) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ error: `Discovery #${args.discoveryId} not found` }) }],
      isError: true,
    };
  }

  const entities: string[] = JSON.parse(discovery.entities);
  const defaultContent = discovery.suggestion
    ?? `结构发现：${entities.join(" 与 ")} 之间存在${discovery.type === "bridge" ? "桥接" : discovery.type === "community_crossing" ? "跨社区" : "结构洞"}关系（图距离 ${discovery.detail ? (JSON.parse(discovery.detail) as { distance?: number }).distance ?? "?" : "?"}）。`;
  const insightContent = args.content ?? defaultContent;

  const row = await ctx.insights.createInsight({
    content: insightContent,
    type: args.type ?? "bridge",
    confidence: args.confidence ?? discovery.score,
    sourceEntities: entities,
    sourceType: "discovery",
  });

  ctx.db.markDiscoverySeen(args.discoveryId);

  return textJson({
    success: true,
    insight: { id: row.id, content: row.content, type: row.type, confidence: row.confidence },
    promoted_from: args.discoveryId,
    actionable: discovery.actionable,
    had_suggestion: !!discovery.suggestion,
  }, true);
}

export function registerInsightTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool("insight", {
    description:
      "Unified insight lifecycle tool. Use action=list|get|archive|dismiss|query|promote_discovery. " +
      "Compatibility aliases list_insights/get_insight/archive_insight/dismiss_insight/query_insights/promote_discovery remain available.",
    inputSchema: {
      action: z.enum(["list", "get", "archive", "dismiss", "query", "promote_discovery"]).describe("Insight action"),
      id: z.number().optional().describe("Insight ID for get/archive/dismiss"),
      discoveryId: z.number().optional().describe("Discovery ID for promote_discovery"),
      query: z.string().max(1000).optional().describe("Search query for action=query"),
      content: z.string().max(10_000).optional().describe("Override content for promote_discovery"),
      type: InsightTypeSchema.optional().describe("Insight type filter or promoted insight type"),
      status: InsightStatusSchema.optional().describe("List status filter"),
      sourceType: InsightSourceTypeSchema.optional().describe("List source type filter"),
      confidence: z.number().optional().describe("Confidence score for promote_discovery"),
      limit: z.number().optional().describe("List/query limit"),
      offset: z.number().optional().describe("List offset"),
    },
  }, async (args) => {
    switch (args.action) {
      case "list":
        return handleListInsights(ctx, args);
      case "get":
        if (args.id === undefined) return missingField(args.action, "id");
        return handleGetInsight(ctx, args.id!);
      case "archive":
        if (args.id === undefined) return missingField(args.action, "id");
        return handleArchiveInsight(ctx, args.id!);
      case "dismiss":
        if (args.id === undefined) return missingField(args.action, "id");
        return handleDismissInsight(ctx, args.id!);
      case "query":
        if (args.query === undefined) return missingField(args.action, "query");
        return handleQueryInsights(ctx, { query: args.query!, limit: args.limit });
      case "promote_discovery":
        if (args.discoveryId === undefined) return missingField(args.action, "discoveryId");
        return handlePromoteDiscovery(ctx, {
          discoveryId: args.discoveryId!,
          content: args.content,
          type: args.type,
          confidence: args.confidence,
        });
    }
  });

  server.registerTool("list_insights", {
    description:
      "List structured insights generated by reflect or promoted from discoveries. " +
      "Insights are first-class knowledge objects with type, confidence, source entities, and lifecycle (active/archived/dismissed). " +
      "Returns active insights by default, content truncated to 200 chars.",
    inputSchema: {
      type: InsightTypeSchema.optional().describe("Filter by insight type"),
      status: InsightStatusSchema.optional().default("active").describe("Filter by status"),
      sourceType: InsightSourceTypeSchema.optional().describe("Filter by source"),
      limit: z.number().optional().default(10).describe("Max results"),
      offset: z.number().optional().default(0).describe("Pagination offset"),
    },
  }, async ({ type, status, sourceType, limit, offset }) => {
    return handleListInsights(ctx, { type, status, sourceType, limit, offset });
  });

  server.registerTool("get_insight", {
    description: "Get full insight details by ID, including content and linked source entities.",
    inputSchema: {
      id: z.number().describe("Insight ID"),
    },
  }, async ({ id }) => {
    return handleGetInsight(ctx, id);
  });

  server.registerTool("archive_insight", {
    description: "Archive an insight. Archived insights are soft-deleted from active results.",
    inputSchema: {
      id: z.number().describe("Insight ID to archive"),
    },
  }, async ({ id }) => {
    return handleArchiveInsight(ctx, id);
  });

  server.registerTool("dismiss_insight", {
    description: "Dismiss an insight as not useful. Dismissed insights won't appear in active results.",
    inputSchema: {
      id: z.number().describe("Insight ID to dismiss"),
    },
  }, async ({ id }) => {
    return handleDismissInsight(ctx, id);
  });

  server.registerTool("query_insights", {
    description:
      "Semantic search over insights. Finds insights whose content is semantically similar to the query. " +
      "Only returns active insights. Use this when the user asks about patterns, trends, or connections in their knowledge.",
    inputSchema: {
      query: z.string().max(1000).describe("Search query — natural language description of what to find"),
      limit: z.number().optional().default(5).describe("Max results"),
    },
  }, async ({ query, limit }) => {
    return handleQueryInsights(ctx, { query, limit });
  });

  server.registerTool("promote_discovery", {
    description:
      "将结构发现升级为结构化洞察。Agent 或用户审核发现后确认值得保留时使用。" +
      "如果发现有 LLM 生成的建议，会自动用做洞察内容。",
    inputSchema: {
      discoveryId: z.number().describe("ID of the discovery to promote"),
      content: z.string().max(10_000).optional().describe("Override content — if omitted, uses suggestion or auto-generated"),
      type: InsightTypeSchema.optional().default("bridge").describe("Insight type"),
      confidence: z.number().optional().describe("Confidence score (0-1). Default from discovery score."),
    },
  }, async ({ discoveryId, content, type, confidence }) => {
    return handlePromoteDiscovery(ctx, { discoveryId, content, type, confidence });
  });
}

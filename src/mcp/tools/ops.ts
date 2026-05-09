import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { HealthChecker } from "../../core/health.js";
import { IndexGenerator } from "../../core/indexes.js";

export function registerOpsTools(server: McpServer, ctx: ToolContext): void {
  // ─── health ────────────────────────────────────────────
  server.registerTool("health", {
    description: "Run a 10-dimension health check (errors, dedup, slug collisions, consistency, completeness, islands, suggestions, attention, data readiness, source quality). Returns issues and writes a report file.",
    inputSchema: {},
  }, async () => {
    const checker = new HealthChecker(ctx.db, ctx.outputsDir, ctx.logger);
    const report = await checker.checkAll();
    return {
      content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
    };
  });

  // ─── enrich ──────────────────────────────────────────────
  server.registerTool("enrich", {
    description: "Run entity enrichment. Upgrades entity tiers based on mention counts.",
    inputSchema: {
      slug: z.string().optional().describe("Specific entity slug (omit for all)"),
    },
  }, async ({ slug }) => {
    const result = slug
      ? [ctx.enrich.enrichEntity(slug)]
      : ctx.enrich.enrichAll();
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  });

  // ─── writeback ────────────────────────────────────────────
  server.registerTool("writeback", {
    description: "Write insights back to the knowledge base. Actions: 'append' (add content to existing page), 'create_concept' (create new concept page), 'create_link' (add relation between two pages). All operations are logged.",
    inputSchema: {
      action: z.enum(["append", "create_concept", "create_link"]).describe("Writeback action"),
      targetSlug: z.string().optional().describe("Target page slug (for append)"),
      content: z.string().describe("Content to write"),
      conceptTitle: z.string().optional().describe("Title for new concept (for create_concept)"),
      fromSlug: z.string().optional().describe("Source page slug (for create_link)"),
      toSlug: z.string().optional().describe("Target page slug (for create_link)"),
      relation: z.string().optional().describe("Relation type (for create_link, e.g. 'works_at')"),
      source: z.string().optional().describe("Origin of this insight (e.g. 'query:xyz')"),
    },
  }, async (params) => {
    const result = await ctx.writeback.execute(params);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  });

  // ─── generate_indexes ───────────────────────────────────
  server.registerTool("generate_indexes", {
    description: "Generate Obsidian-readable index files: All-Entities, All-Concepts, All-Sources, Dashboard.",
    inputSchema: {},
  }, async () => {
    const gen = new IndexGenerator(ctx.db, ctx.outputsDir);
    const files = gen.generateAll();
    return {
      content: [{ type: "text", text: JSON.stringify({ generated: files.length, files }, null, 2) }],
    };
  });

  // ─── status ──────────────────────────────────────────────
  server.registerTool("status", {
    description: "Get brain status: page counts, sync info, etc.",
    inputSchema: {},
  }, async () => {
    const totalPages = ctx.db.getPageCount();
    const byType = ctx.db.getPageTypeCounts();
    const totalLinks = ctx.db.getLinkCount();
    const totalChunks = ctx.db.getChunkCount();
    const recentNerErrors = ctx.db.getRecentNerErrorCount();

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ totalPages, byType, totalLinks, totalChunks, recentNerErrors, vaultPath: ctx.vaultPath }, null, 2),
      }],
    };
  });

  // ─── get_ingest_log ──────────────────────────────────────────
  server.registerTool("get_ingest_log", {
    description: "Get recent ingest log entries.",
    inputSchema: {
      limit: z.number().optional().default(50).describe("Max entries to return"),
    },
  }, async ({ limit }) => {
    const log = ctx.db.getIngestLog(limit);
    return {
      content: [{ type: "text", text: JSON.stringify(log, null, 2) }],
    };
  });

  // ─── dream ──────────────────────────────────────────────────
  server.registerTool("dream", {
    description: "Run full nightly pipeline: sync → enrich → cleanup → health → insight archive. Reflect and discovery run independently. Use for scheduled daily maintenance. Has cycle lock to prevent overlapping runs.",
    inputSchema: {},
  }, async () => {
    const { runDream } = await import("../../core/dream.js");
    const report = await runDream(ctx.vaultPath, ctx.db, ctx.sync, ctx.enrich, new HealthChecker(ctx.db, ctx.outputsDir, ctx.logger), ctx.outputsDir, ctx.logger);
    return {
      content: [{ type: "text", text: JSON.stringify({
        success: report.locked,
        brief: report.brief,
        locked: report.locked,
        stages: report.stages,
        timestamp: report.timestamp,
        duration_ms: report.duration_ms,
      }, null, 2) }],
    };
  });

  // ─── dream_reset ────────────────────────────────────────────
  server.registerTool("dream_reset", {
    description: "Clear the dream cycle lock. Use when a previous dream didn't finish and you need to force a new one.",
    inputSchema: {},
  }, async () => {
    ctx.db.deleteConfig("dream.lock");
    return {
      content: [{ type: "text", text: JSON.stringify({ success: true, message: "Dream lock cleared. Ready to run again." }) }],
    };
  });
}

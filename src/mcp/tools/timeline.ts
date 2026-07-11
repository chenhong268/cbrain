import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { indexPage } from "../context.js";
import { mapSourceType } from "../../core/provenance.js";
import { formatTimelineEnvelope } from "./format-result.js";
import { buildToolResult, type BuiltToolResult } from "./result-builder.js";
import { TITLE_MAX, SUMMARY_MAX } from "../validation.js";

type TimelineAction = "get" | "add";

const TIMELINE_OUTPUT_SCHEMA = {
  schema_version: z.literal(1),
  summary: z.object({
    status: z.enum(["ok", "empty", "degraded", "error"]),
    count: z.number(),
    truncated: z.boolean(),
    message: z.string().max(SUMMARY_MAX),
  }),
  data: z.object({
    title: z.string().max(TITLE_MAX),
    events: z.array(z.object({
      date: z.string().max(50).optional(),
      summary: z.string().max(SUMMARY_MAX),
      source: z.string().max(500).optional(),
    })),
  }),
  audit: z.object({ raw: z.unknown() }).optional(),
};

async function getTimeline(
  ctx: ToolContext,
  slug: string,
  includeRaw: boolean,
): Promise<BuiltToolResult> {
  const entries = ctx.db.getTimeline(slug);
  const page = ctx.pages.getBySlug(slug);
  const body = page?.body ?? "";

  // Build a unified events list — structured entries + body date lines
  const events: Array<{ id?: number; date?: string; summary: string; source?: string; source_category?: string; trust_state?: string; source_page_slug?: string; evidence?: string }> = [];
  for (const e of entries) {
    events.push({
      id: e.id,
      date: e.event_date ?? undefined,
      summary: e.summary,
      source: e.source ?? "unknown",
      source_category: mapSourceType(e.source ?? undefined),
      trust_state: e.trust_state ?? "candidate",
      source_page_slug: e.source_page_slug,
      evidence: e.evidence,
    });
  }

  const datePattern = /\b\d{4}[.\-/年]\d{1,2}/;
  for (const line of body.split("\n")) {
    if (datePattern.test(line)) {
      const cleaned = line.replace(/^\|?\s*|\s*\|?$/g, "").trim();
      if (!entries.some(e => cleaned.includes(e.summary.slice(0, 10)))) {
        events.push({ summary: cleaned, source: "body", source_category: "agent_inference", trust_state: "candidate", source_page_slug: slug, evidence: cleaned.slice(0, 100) });
      }
    }
  }

  // Resolve title from page manager, fallback to DB, never expose raw slug
  const resolvedTitle = page?.title ?? ctx.db.getPageTitle(slug) ?? "";
  const envelope = formatTimelineEnvelope({
    slug,
    title: resolvedTitle,
    events,
  });
  return buildToolResult({
    mode: ctx.outputMode,
    display: envelope.display,
    displayStructured: envelope.displayStructured,
    summary: envelope.summary,
    summaryStructured: envelope.summaryStructured,
    data: envelope.data,
    raw: envelope.raw,
    includeRaw,
    legacyIndent: 2,
  });
}

async function addTimelineEntry(
  ctx: ToolContext,
  slug: string,
  summary: string,
  eventDate?: string,
  source?: string,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const id = ctx.db.addTimelineEntry(slug, summary, eventDate, source);

  // Append timeline content to page body for searchability
  {
    const page = ctx.pages.getBySlug(slug);
    if (page) {
      const dateStr = eventDate ?? new Date().toISOString().slice(0, 10);
      const srcNote = source ? ` [来源: ${source}]` : "";
      const entry = `\n- **${dateStr}**: ${summary}${srcNote}`;

      ctx.versions.createVersion(slug);
      ctx.pages.update(slug, { body: page.body + entry });
      await indexPage(ctx.pipeline, slug, page.body + entry, ctx.logger);
    }
  }

  return {
    content: [{ type: "text", text: JSON.stringify({ success: true, id, slug }) }],
  };
}

async function runTimelineAction(
  ctx: ToolContext,
  action: TimelineAction,
  slug: string,
  summary: string | undefined,
  eventDate: string | undefined,
  source: string | undefined,
  includeRaw: boolean,
): Promise<{ content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean }> {
  if (action === "get") return getTimeline(ctx, slug, includeRaw);
  if (!summary) {
    return { content: [{ type: "text", text: JSON.stringify({ error: "summary is required for action: add" }) }], isError: true };
  }
  return addTimelineEntry(ctx, slug, summary, eventDate, source);
}

export function registerTimelineTools(server: McpServer, ctx: ToolContext): void {
  // ─── timeline (unified action tool) ──────────────────────────
  server.registerTool("timeline", {
    description: "Unified timeline operations. Use action=get/add. Compatibility aliases get_timeline/add_timeline_entry remain available.",
    inputSchema: {
      action: z.enum(["get", "add"]).describe("Timeline operation"),
      slug: z.string().max(500).describe("Page slug"),
      summary: z.string().max(2000).optional().describe("Timeline event summary for action=add"),
      eventDate: z.string().max(50).optional().describe("Event date for action=add (ISO format)"),
      source: z.string().max(500).optional().describe("Source for action=add"),
      include_raw: z.boolean().optional().describe("action=get 时若为 true，返回脱敏后的审计数据。默认 false。"),
    },
    // No outputSchema in Phase 1: action=add returns {success,id,slug}/error and would not
    // satisfy a read-only schema. (Codex HIGH 3.2)
  }, async ({ action, slug, summary, eventDate, source, include_raw }) => runTimelineAction(ctx, action, slug, summary, eventDate, source, include_raw ?? false));

  // ─── get_timeline ────────────────────────────────────────────
  server.registerTool("get_timeline", {
    description: "Get timeline entries for a page.",
    inputSchema: {
      slug: z.string().max(500).describe("Page slug"),
      include_raw: z.boolean().optional().describe("若为 true，返回脱敏后的审计数据（audit.raw，凭据与绝对路径已剥离）。默认 false。"),
    },
    // #327 Fix: outputSchema registered ONLY in structured mode (see graph.ts note).
    // Legacy mode returns {display,summary,raw} text with no structuredContent; an
    // unconditional outputSchema breaks every legacy call with -32602 on real transport.
    ...(ctx.outputMode === "structured" ? { outputSchema: TIMELINE_OUTPUT_SCHEMA } : {}),
  }, async ({ slug, include_raw }) => getTimeline(ctx, slug, include_raw ?? false));

  // ─── add_timeline_entry ──────────────────────────────────────
  server.registerTool("add_timeline_entry", {
    description: "Add a timeline entry to a page.",
    inputSchema: {
      slug: z.string().max(500).describe("Page slug"),
      summary: z.string().max(2000).describe("Timeline event summary"),
      eventDate: z.string().max(50).optional().describe("Event date (ISO format)"),
      source: z.string().max(500).optional().describe("Source of this event"),
    },
  }, async ({ slug, summary, eventDate, source }) => addTimelineEntry(ctx, slug, summary, eventDate, source));
}

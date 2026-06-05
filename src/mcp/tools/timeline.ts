import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { indexPage } from "../context.js";
import { mapSourceType } from "../../core/provenance.js";
import { formatTimelineEnvelope } from "./format-result.js";

export function registerTimelineTools(server: McpServer, ctx: ToolContext): void {
  // ─── get_timeline ────────────────────────────────────────────
  server.registerTool("get_timeline", {
    description: "Get timeline entries for a page.",
    inputSchema: {
      slug: z.string().max(500).describe("Page slug"),
    },
  }, async ({ slug }) => {
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
    return {
      content: [{
        type: "text",
        text: JSON.stringify(envelope, null, 2),
      }],
    };
  });

  // ─── add_timeline_entry ──────────────────────────────────────
  server.registerTool("add_timeline_entry", {
    description: "Add a timeline entry to a page.",
    inputSchema: {
      slug: z.string().max(500).describe("Page slug"),
      summary: z.string().max(2000).describe("Timeline event summary"),
      eventDate: z.string().max(50).optional().describe("Event date (ISO format)"),
      source: z.string().max(500).optional().describe("Source of this event"),
    },
  }, async ({ slug, summary, eventDate, source }) => {
    const id = ctx.db.addTimelineEntry(slug, summary, eventDate, source);

    // Append to page body for brain/ pages so timeline content is searchable
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
  });
}

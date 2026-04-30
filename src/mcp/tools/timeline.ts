import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { indexPage } from "../context.js";

export function registerTimelineTools(server: McpServer, ctx: ToolContext): void {
  // ─── get_timeline ────────────────────────────────────────────
  server.registerTool("get_timeline", {
    description: "Get timeline entries for a page.",
    inputSchema: {
      slug: z.string().describe("Page slug"),
    },
  }, async ({ slug }) => {
    const entries = ctx.db.getTimeline(slug);
    const page = ctx.pages.getBySlug(slug);
    const body = page?.body ?? "";

    // Build a unified events list — structured entries + body date lines
    const events: Array<{ date?: string; summary: string; source: string }> = [];
    for (const e of entries) {
      events.push({ date: e.event_date ?? undefined, summary: e.summary, source: e.source ?? "unknown" });
    }

    const datePattern = /\b\d{4}[.\-/年]\d{1,2}/;
    for (const line of body.split("\n")) {
      if (datePattern.test(line)) {
        const cleaned = line.replace(/^\|?\s*|\s*\|?$/g, "").trim();
        if (!entries.some(e => cleaned.includes(e.summary.slice(0, 10)))) {
          events.push({ summary: cleaned, source: "body" });
        }
      }
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          slug,
          title: page?.title ?? slug,
          events,
        }, null, 2),
      }],
    };
  });

  // ─── add_timeline_entry ──────────────────────────────────────
  server.registerTool("add_timeline_entry", {
    description: "Add a timeline entry to a page.",
    inputSchema: {
      slug: z.string().describe("Page slug"),
      summary: z.string().describe("Timeline event summary"),
      eventDate: z.string().optional().describe("Event date (ISO format)"),
      source: z.string().optional().describe("Source of this event"),
    },
  }, async ({ slug, summary, eventDate, source }) => {
    const id = ctx.db.addTimelineEntry(slug, summary, eventDate, source);

    // Append to page body for brain/ pages so timeline content is searchable
    if (!slug.startsWith("raw/")) {
      const page = ctx.pages.getBySlug(slug);
      if (page) {
        const dateStr = eventDate ?? new Date().toISOString().slice(0, 10);
        const srcNote = source ? ` [来源: ${source}]` : "";
        const entry = `\n- **${dateStr}**: ${summary}${srcNote}`;

        ctx.versions.createVersion(slug);
        ctx.pages.update(slug, { body: page.body + entry });
        await indexPage(ctx.pipeline, slug, page.body + entry);
      }
    }

    return {
      content: [{ type: "text", text: JSON.stringify({ success: true, id, slug }) }],
    };
  });
}

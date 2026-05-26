import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";

export function registerFeedbackTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool("record_feedback", {
    description:
      "Record feedback on recall/search results. After using recall or search, report which results were useful or not. " +
      "This helps CBrain learn from usage patterns — relevant results get boosted, irrelevant ones decay over time.",
    inputSchema: {
      query: z.string().describe("The original query that produced these results"),
      relevant_slugs: z.array(z.string()).optional().describe("Slugs that were useful/relevant"),
      irrelevant_slugs: z.array(z.string()).optional().describe("Slugs that were not useful"),
      expanded_slugs: z.array(z.string()).optional().describe("Slugs that led to useful exploration (divergent discovery)"),
      note: z.string().optional().describe("Optional context about the feedback"),
    },
  }, async ({ query, relevant_slugs, irrelevant_slugs, expanded_slugs, note }) => {
    let recorded = 0;

    for (const slug of relevant_slugs ?? []) {
      ctx.db.insertFeedback(null, slug, "relevant", note);
      ctx.db.bumpActivityWeight(slug, 0.1);
      recorded++;
    }

    for (const slug of irrelevant_slugs ?? []) {
      ctx.db.insertFeedback(null, slug, "irrelevant", note);
      recorded++;
    }

    for (const slug of expanded_slugs ?? []) {
      ctx.db.insertFeedback(null, slug, "expanded", note);
      ctx.db.bumpActivityWeight(slug, 0.05);
      recorded++;
    }

    const validatedSlugs = [...(relevant_slugs ?? []), ...(expanded_slugs ?? [])];
    if (validatedSlugs.length > 0) {
      try { ctx.db.validateLinksForSlugs(validatedSlugs); } catch { /* non-critical */ }
    }

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ query, recorded, note }),
      }],
    };
  });
}

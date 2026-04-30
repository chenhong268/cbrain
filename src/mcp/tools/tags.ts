import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";

export function registerTagTools(server: McpServer, ctx: ToolContext): void {
  // ─── get_tags ────────────────────────────────────────────────
  server.registerTool("get_tags", {
    description: "Get all tags for a page.",
    inputSchema: {
      slug: z.string().describe("Page slug"),
    },
  }, async ({ slug }) => {
    const tags = ctx.db.getTags(slug);
    return {
      content: [{ type: "text", text: JSON.stringify({ slug, tags }, null, 2) }],
    };
  });

  // ─── add_tag ─────────────────────────────────────────────────
  server.registerTool("add_tag", {
    description: "Add a tag to a page.",
    inputSchema: {
      slug: z.string().describe("Page slug"),
      tag: z.string().describe("Tag to add"),
    },
  }, async ({ slug, tag }) => {
    const ok = ctx.db.addTag(slug, tag);
    return {
      content: [{ type: "text", text: JSON.stringify({ success: ok, slug, tag }) }],
    };
  });

  // ─── remove_tag ──────────────────────────────────────────────
  server.registerTool("remove_tag", {
    description: "Remove a tag from a page.",
    inputSchema: {
      slug: z.string().describe("Page slug"),
      tag: z.string().describe("Tag to remove"),
    },
  }, async ({ slug, tag }) => {
    const ok = ctx.db.removeTag(slug, tag);
    return {
      content: [{ type: "text", text: JSON.stringify({ success: ok, slug, tag }) }],
    };
  });
}

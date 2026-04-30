import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";

export function registerSyncTools(server: McpServer, ctx: ToolContext): void {
  // ─── sync ────────────────────────────────────────────────
  server.registerTool("sync", {
    description: "Sync vault files to SQLite + LanceDB indexes.",
    inputSchema: {
      slug: z.string().optional().describe("Sync a single page by slug (omit for full sync)"),
    },
  }, async ({ slug }) => {
    if (slug) {
      const result = await ctx.sync.syncPage(slug, ctx.vaultPath);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
    const report = await ctx.sync.syncAll(ctx.vaultPath);
    const orphans = await ctx.sync.removeOrphans(ctx.vaultPath);
    return {
      content: [{ type: "text", text: JSON.stringify({ ...report, orphansRemoved: orphans.length, orphanSlugs: orphans }, null, 2) }],
    };
  });

  // ─── remove_orphans ──────────────────────────────────────
  server.registerTool("remove_orphans", {
    description: "Remove database entries that have no corresponding vault file. Run this after manually deleting files from the vault.",
    inputSchema: {},
  }, async () => {
    const orphans = await ctx.sync.removeOrphans(ctx.vaultPath);
    return {
      content: [{ type: "text", text: JSON.stringify({ removed: orphans.length, slugs: orphans }, null, 2) }],
    };
  });
}

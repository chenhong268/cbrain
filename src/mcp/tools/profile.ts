import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";

export function registerProfileTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool("get_profile", {
    description:
      "Query personalized profile entries — preferences, constraints, habits, and context " +
      "specific to the user. Filter by scope, category, type, tags, or ids. " +
      "Use this to understand user preferences before taking action.",
    inputSchema: {
      scope: z.enum(["open", "scoped", "private"]).optional().describe("Privacy scope filter"),
      category: z.enum(["communication", "work", "health", "finance", "interests", "general"]).optional().describe("Category filter"),
      type: z.enum(["preference", "constraint", "context", "habit"]).optional().describe("Entry type filter"),
      tags: z.array(z.string()).optional().describe("Tag filter (entries matching any tag)"),
      ids: z.array(z.string()).optional().describe("Specific entry IDs to retrieve"),
    },
  }, async ({ scope, category, type, tags, ids }) => {
    const filter = { scope, category, type, tags, ids };
    const entries = ctx.profile.getEntries(filter);
    const stats = ctx.profile.getStats();
    const modules = ctx.profile.getModules();

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          entries,
          meta: {
            total: stats.total,
            filtered: entries.length,
            ...(scope && { scope }),
            ...(category && { category }),
            ...(type && { type }),
            loaded_modules: modules.filter((m: { enabled: boolean }) => m.enabled).map((m: { name: string }) => m.name),
          },
        }, null, 2),
      }],
    };
  });

  server.registerTool("update_profile", {
    description:
      "Create or update profile entries. Use this when the user explicitly states a preference, " +
      "constraint, or habit, or when you observe one through repeated interaction. " +
      "Automatically sets updated_at timestamp.",
    inputSchema: {
      entries: z.array(z.object({
        id: z.string().describe("Unique entry identifier (kebab-case)"),
        type: z.enum(["preference", "constraint", "context", "habit"]).describe("Entry type"),
        category: z.enum(["communication", "work", "health", "finance", "interests", "general"]).describe("Category"),
        scope: z.enum(["open", "scoped", "private"]).describe("Privacy scope"),
        agents: z.array(z.string()).optional().describe("Visible agents (for scoped entries)"),
        content: z.string().describe("The profile content"),
        priority: z.enum(["high", "normal"]).optional().describe("Priority (mainly for constraints)"),
        source: z.enum(["explicit", "observed", "inferred"]).default("observed").describe("How this was learned"),
        tags: z.array(z.string()).optional().describe("Tags for categorization"),
      })).describe("Entries to create or update"),
    },
  }, async ({ entries }) => {
    const updated = ctx.profile.updateEntries(entries);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          updated: updated.map(e => e.id),
          count: updated.length,
        }, null, 2),
      }],
    };
  });

  server.registerTool("remove_profile", {
    description:
      "Remove profile entries by ID. Use when the user explicitly asks to remove a preference " +
      "or when an entry is confirmed outdated.",
    inputSchema: {
      ids: z.array(z.string()).describe("Entry IDs to remove"),
    },
  }, async ({ ids }) => {
    const removed = ctx.profile.removeEntries(ids);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          removed,
          count: removed.length,
        }, null, 2),
      }],
    };
  });

  server.registerTool("reload_profile", {
    description:
      "Reload profile data from YAML files. Use after profile files are manually edited " +
      "to pick up changes without restarting the server.",
    inputSchema: {},
  }, async () => {
    ctx.profile.reload();
    const stats = ctx.profile.getStats();
    const modules = ctx.profile.getModules();
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          reloaded: true,
          total_entries: stats.total,
          modules: modules.map(m => ({ name: m.name, enabled: m.enabled, entries: m.count })),
        }, null, 2),
      }],
    };
  });
}

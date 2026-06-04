import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { setHierarchy, removeHierarchy, getHierarchyContext } from "../../core/hierarchy.js";

export function registerHierarchyTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool("set_hierarchy", {
    description:
      "Set the direct manager (reports_to) for an entity. " +
      "This establishes an explicit organizational hierarchy relationship. " +
      "The relationship is stored in both page frontmatter and the knowledge graph.",
    inputSchema: {
      slug: z.string().max(500).describe("Entity slug (e.g. entity/zhang-san)"),
      reports_to: z.string().max(500).describe("Slug of the direct manager"),
    },
  }, async ({ slug, reports_to }) => {
    // Collect old manager before mutation for KR sync
    const page = ctx.pages.getBySlug(slug);
    const oldReportsTo = (page?.frontmatter as Record<string, unknown>)?.reports_to as string | undefined;

    setHierarchy(slug, reports_to, { pages: ctx.pages, graph: ctx.graph });

    // Sync Known Relations for affected slugs
    const affected = [slug, reports_to];
    if (oldReportsTo && oldReportsTo !== reports_to) affected.push(oldReportsTo);
    const setWarnings = ctx.pages.syncAffectedSlugs(affected);

    const manager = ctx.pages.getBySlug(reports_to);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          success: true,
          slug,
          reports_to,
          manager_title: manager?.title ?? null,
          ...(setWarnings.length > 0 ? { sync_warnings: setWarnings } : {}),
        }, null, 2),
      }],
    };
  });

  server.registerTool("get_hierarchy", {
    description:
      "Get the full hierarchy context for an entity: direct manager, subordinates, and peers.",
    inputSchema: {
      slug: z.string().max(500).describe("Entity slug"),
    },
  }, async ({ slug }) => {
    const hierarchy = getHierarchyContext(slug, { pages: ctx.pages, graph: ctx.graph });
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ slug, ...hierarchy }, null, 2),
      }],
    };
  });

  server.registerTool("remove_hierarchy", {
    description:
      "Remove the reports_to hierarchy for an entity. " +
      "Clears the frontmatter field and removes the graph link.",
    inputSchema: {
      slug: z.string().max(500).describe("Entity slug"),
    },
  }, async ({ slug }) => {
    const removed = removeHierarchy(slug, { pages: ctx.pages, graph: ctx.graph });
    if (!removed) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ error: `${slug} 未设置 reports_to` }),
        }],
        isError: true,
      };
    }
    // Sync Known Relations for slug and old manager
    const removeWarnings = ctx.pages.syncAffectedSlugs([slug, removed]);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ success: true, slug, removed, ...(removeWarnings.length > 0 ? { sync_warnings: removeWarnings } : {}) }, null, 2),
      }],
    };
  });
}

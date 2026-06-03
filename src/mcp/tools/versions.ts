import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";

export function registerVersionTools(server: McpServer, ctx: ToolContext): void {
  // ─── get_versions ────────────────────────────────────────────
  server.registerTool("get_versions", {
    description: "Get version history for a page.",
    inputSchema: {
      slug: z.string().max(500).describe("Page slug"),
    },
  }, async ({ slug }) => {
    const versionList = ctx.versions.getVersions(slug);
    return {
      content: [{ type: "text", text: JSON.stringify(versionList, null, 2) }],
    };
  });

  // ─── revert_version ──────────────────────────────────────────
  server.registerTool("revert_version", {
    description: "Revert a page to a specific version. Creates a version snapshot before reverting.",
    inputSchema: {
      slug: z.string().max(500).describe("Page slug"),
      version: z.number().describe("Version number to revert to"),
    },
  }, async ({ slug, version }) => {
    const ok = ctx.versions.revertToVersion(slug, version);
    return {
      content: [{ type: "text", text: JSON.stringify({ success: ok, slug, revertedTo: ok ? version : null }) }],
    };
  });
}

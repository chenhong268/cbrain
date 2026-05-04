import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";

export function registerDiscoveryTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool("read_discoveries", {
    description:
      "Read graph-based structural discoveries (bridge nodes, community crossings, structural holes). " +
      "These are NOT human-written insights — they are algorithm-detected structural anomalies in the knowledge graph. " +
      "Returns unseen discoveries by default. Use mark_discovery_seen to mark as read.",
    inputSchema: {
      limit: z.number().optional().default(10).describe("Max discoveries to return"),
      includeSeen: z.boolean().optional().default(false).describe("Include already-seen discoveries"),
    },
  }, async ({ limit, includeSeen }) => {
    const rows = ctx.db.getUnseenDiscoveries(limit ?? 10);

    const discoveries = rows.map(r => ({
      id: r.id,
      type: r.type,
      entities: JSON.parse(r.entities),
      score: r.score,
      detail: r.detail ? JSON.parse(r.detail) : null,
      detected_at: r.detected_at,
      dream_run: r.dream_run,
    }));

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          discoveries,
          summary: `${discoveries.length} 个未读发现。用户判断是否构成 insight。确认后让 Agent 写成笔记存到 brain/insights/。`,
        }, null, 2),
      }],
    };
  });

  server.registerTool("mark_discovery_seen", {
    description: "Mark discoveries as read so they won't appear in future read_discoveries calls.",
    inputSchema: {
      ids: z.array(z.number()).describe("Discovery IDs to mark as seen"),
    },
  }, async ({ ids }) => {
    for (const id of ids) {
      ctx.db.markDiscoverySeen(id);
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ marked: ids.length }) }],
    };
  });
}

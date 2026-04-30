import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";

export function registerConfigTools(server: McpServer, ctx: ToolContext): void {
  // ─── get_config ──────────────────────────────────────────────
  server.registerTool("get_config", {
    description: "Get a configuration value.",
    inputSchema: {
      key: z.string().describe("Config key"),
    },
  }, async ({ key }) => {
    const value = ctx.db.getConfig(key);
    return {
      content: [{ type: "text", text: JSON.stringify({ key, value }) }],
    };
  });

  // ─── set_config ──────────────────────────────────────────────
  server.registerTool("set_config", {
    description: "Set a configuration value.",
    inputSchema: {
      key: z.string().describe("Config key"),
      value: z.string().describe("Config value"),
    },
  }, async ({ key, value }) => {
    ctx.db.setConfig(key, value);
    return {
      content: [{ type: "text", text: JSON.stringify({ success: true, key }) }],
    };
  });
}

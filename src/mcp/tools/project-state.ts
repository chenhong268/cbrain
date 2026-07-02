import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { readProjectState, renderProjectStateEnvelope } from "../../core/project-state.js";

export function registerProjectStateTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "read_project_state",
    {
      description:
        "读取 compact 项目状态 artifact，用于 Agent session continuity。只读，不写 vault/SQLite/LanceDB，不做 prompt 注入。",
      inputSchema: {
        include_raw: z.boolean().optional().describe("true=返回 raw.state；默认 false 只返回 compact display/summary"),
        max_chars: z.number().int().min(200).max(4000).optional().describe("display 最大字符数，默认 2000"),
      },
    },
    async ({ include_raw, max_chars }: { include_raw?: boolean; max_chars?: number }) => {
      const state = readProjectState(ctx.outputsDir);
      const envelope = renderProjectStateEnvelope(state, {
        includeRaw: include_raw === true,
        maxChars: max_chars,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }],
      };
    },
  );
}

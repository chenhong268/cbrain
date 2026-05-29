import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { EpisodicRecaller } from "../../core/episodic-recall.js";

export function registerEpisodeTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "recall_episode",
    {
      description:
        "被动情境找人：根据时间、主题、关系、场景等线索，召回可能匹配的人物。适用于用户不记得人名、但记得某些情境信息的场景。",
      inputSchema: {
        query: z.string().describe("用户的自然语言问题，例如'去年团建见过谁'"),
        time_hint: z
          .string()
          .optional()
          .describe("时间线索，如'2024年'、'去年'、'上个月'"),
        topic_hint: z
          .string()
          .optional()
          .describe("主题线索，如'前端开发'、'项目管理'"),
        context_hint: z
          .string()
          .optional()
          .describe("场景线索，如'团建'、'聚餐'、'技术分享'"),
        connection_hint: z
          .string()
          .optional()
          .describe("关系线索，如'人物A的同事'、'组织E的人'"),
        limit: z
          .number()
          .optional()
          .default(5)
          .describe("最多返回候选人数"),
      },
    },
    async ({ query, time_hint, topic_hint, context_hint, connection_hint, limit }) => {
      const recaller = new EpisodicRecaller(ctx.db);
      const result = recaller.recall({
        query,
        time_hint,
        topic_hint,
        context_hint,
        connection_hint,
        limit,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );
}

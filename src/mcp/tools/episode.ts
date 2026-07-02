import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { EpisodicRecaller } from "../../core/retrieval/episodic-recall.js";
import { formatEpisodeEnvelope } from "./format-result.js";

export function registerEpisodeTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "recall_episode",
    {
      description:
        "被动情境找人：根据时间、主题、关系、场景、事件等线索，召回可能匹配的人物。适用于用户不记得人名、但记得某些情境信息的场景。" +
        "触发信号：'见过谁'、'认识谁'、'那个人是谁'、'叫什么来着'、'去年团建见过谁'、'在XX认识的那个'。" +
        "与 query/deep_recall 的区别：用户不记得人名，靠情境线索（时间/地点/事件/主题/关系）找人，返回候选人列表而非全文。",
      inputSchema: {
        query: z.string().max(1000).describe("用户的自然语言问题，例如'去年团建见过谁'"),
        time_hint: z
          .string()
          .max(500)
          .optional()
          .describe("时间线索，如'2024年'、'去年'、'上个月'"),
        topic_hint: z
          .string()
          .max(500)
          .optional()
          .describe("主题线索，如'前端开发'、'项目管理'"),
        context_hint: z
          .string()
          .max(500)
          .optional()
          .describe("场景线索，如'团建'、'聚餐'、'技术分享'"),
        connection_hint: z
          .string()
          .max(500)
          .optional()
          .describe("关系线索，如'人物A的同事'、'组织E的人'"),
        event_hint: z
          .string()
          .max(500)
          .optional()
          .describe("事件线索，如'项目上线'、'团队聚餐'"),
        relation_hint: z
          .string()
          .max(500)
          .optional()
          .describe("关系线索（与connection_hint同义），如'人物A的同事'"),
        limit: z
          .number()
          .optional()
          .default(5)
          .describe("最多返回候选人数"),
      },
    },
    async ({ query, time_hint, topic_hint, context_hint, connection_hint, event_hint, relation_hint, limit }) => {
      const recaller = new EpisodicRecaller(ctx.db);
      const result = recaller.recall({
        query,
        time_hint,
        topic_hint,
        context_hint,
        connection_hint,
        event_hint,
        relation_hint,
        limit,
      });

      // Build envelope — preserve original summary string as result_summary
      const { display, summary, raw } = formatEpisodeEnvelope(result);
      const { summary: legacySummary, ...restPayload } = result;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ display, summary, raw, result_summary: legacySummary, ...restPayload }, null, 2),
          },
        ],
      };
    },
  );
}

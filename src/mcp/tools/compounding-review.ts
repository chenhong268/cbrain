import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { ReviewGenerator } from "../../core/compounding-review.js";

export function registerCompoundingReviewTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool("get_compounding_reviews", {
    description:
      "生成复利洞察：只有通过全部5个门槛（证据充分性、持久性、新颖性、行动价值、信任风险）的候选才会出现在结果中。" +
      "没通过门槛的候选会被过滤，返回 silence_reason 说明原因。",
    inputSchema: {
      includeDeferred: z.boolean().optional().default(false).describe("是否包含推迟的候选"),
      limit: z.number().int().min(1).max(50).optional().default(20).describe("最多扫描的候选数量（1-50）"),
    },
  }, async ({ includeDeferred, limit }) => {
    const generator = new ReviewGenerator(ctx.compoundingReview);
    const result = generator.generate({ includeDeferred, limit });

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(result, null, 2),
      }],
    };
  });

  server.registerTool("act_on_review_candidate", {
    description:
      "对复利洞察候选执行操作：接受（确认洞察）、拒绝（丢弃）、推迟（稍后提醒）、禁用（永久静默）。" +
      "每次操作会记录审计日志。",
    inputSchema: {
      id: z.number().describe("候选 ID"),
      action: z.enum(["accept", "reject", "defer", "disable"]).describe("操作类型"),
      note: z.string().optional().describe("可选备注"),
    },
  }, async ({ id, action, note }) => {
    const ok = ctx.compoundingReview.transitionStatus(id, action, note);

    if (!ok) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ error: "候选不存在或状态未变更", id, action }),
        }],
        isError: true,
      };
    }

    const candidate = ctx.compoundingReview.getCandidate(id);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          id,
          action,
          new_status: candidate?.status,
          note,
        }),
      }],
    };
  });
}

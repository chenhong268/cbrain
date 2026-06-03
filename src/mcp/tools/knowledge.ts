import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { addKnowledge } from "../../core/knowledge-write.js";

export function registerKnowledgeTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool("add_knowledge", {
    description:
      "添加事实或关系到知识图谱。自动解析实体名称，不存在时创建 stub entity（非 record）。" +
      "支持结构化字段、关系、汇报关系和文本备注。不会创建新的 record 页面。" +
      "支持 dry_run 模式预览将要写入的内容。" +
      "示例：subject='人物A', relations=[{target:'组织D', relation:'任职'}], hierarchy={reports_to:'人物C'}",
    inputSchema: {
      subject: z.string().min(1).max(500).describe("主体实体名称或 slug"),
      subject_type: z.string().max(200).optional().describe("主体类型（创建 stub 时用，如 person/company，默认 person）"),
      facts: z.array(z.object({
        field: z.string().max(200).describe("frontmatter 字段名（如 current_title, birthday）"),
        value: z.string().max(10_000).describe("字段值"),
      })).optional().describe("结构化属性"),
      relations: z.array(z.object({
        target: z.string().max(500).describe("目标实体名称或 slug"),
        target_type: z.string().max(200).optional().describe("目标类型"),
        relation: z.string().max(100).describe("关系类型（如 任职, 认识, 合作）"),
      })).optional().describe("图谱关系"),
      hierarchy: z.object({
        reports_to: z.string().max(500).describe("上级实体名称或 slug"),
        reports_to_type: z.string().max(200).optional(),
      }).optional().describe("汇报关系"),
      note: z.string().max(10_000).optional().describe("文本备注（追加到主体 body）"),
      evidence: z.string().max(10_000).optional().describe("来源证据文本"),
      source_type: z.enum(["dialogue", "agent"]).optional().describe("来源类型（默认 agent，创建 candidate 关系；确认可信事实请使用 confirm_evidence）"),
      mode: z.enum(["apply", "dry_run"]).optional().describe("执行模式（默认 apply）"),
    },
  }, async (params) => {
    const result = await addKnowledge(params, {
      db: ctx.db,
      pages: ctx.pages,
      pipeline: ctx.pipeline,
      graph: ctx.graph,
    });

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(result, null, 2),
      }],
    };
  });
}

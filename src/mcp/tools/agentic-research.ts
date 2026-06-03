import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import {
  AgenticResearchPipeline,
  type PipelineInput,
  type PipelineResult,
} from "../../core/agentic/pipeline.js";
import type { SearchPlanIntent } from "../../core/agentic/plan.js";

const INTENT_VALUES: [string, ...string[]] = [
  "entity_lookup",
  "relationship",
  "timeline",
  "comparison",
  "review",
  "gap_analysis",
];

const DETAIL_BUDGET: Record<string, Partial<PipelineInput["budgetOverride"]>> = {
  brief: { max_ms: 3000, max_searches: 3, max_llm_calls: 1 },
  normal: {},
  full: { max_ms: 15000, max_searches: 12, max_llm_calls: 5 },
};

function mapReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) return Object.fromEntries(value);
  return value;
}

function serializeResult(result: PipelineResult): string {
  return JSON.stringify(result, mapReplacer, 2);
}

export function registerAgenticResearchTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "agentic_research",
    {
      description:
        "[EXPERIMENTAL/INTERNAL] 多步 agentic 研究：规划→执行→评估→(一次补充)→结果。" +
        "适用于复杂查询需要多步推理、交叉验证的场景。简单查询仍用 query/deep_recall。" +
        "返回结构化研究结果：状态(ok/partial/degraded/insufficient)、证据板、来源、置信度。",
      inputSchema: {
        query: z.string().max(1000).describe("研究问题"),
        detail: z
          .enum(["brief", "normal", "full"])
          .optional()
          .default("normal")
          .describe("研究深度：brief=快速, normal=标准, full=深度"),
        known_slugs: z
          .array(z.string().max(500))
          .optional()
          .describe("已知实体 slug 列表，帮助规划器定向搜索"),
        intent_hint: z
          .enum(INTENT_VALUES)
          .optional()
          .describe("意图提示，覆盖自动分类"),
      },
    },
    async ({ query, detail = "normal", known_slugs, intent_hint }) => {
      const pipeline = new AgenticResearchPipeline({
        db: ctx.db,
        search: ctx.search,
        graph: ctx.graph,
        pages: ctx.pages,
        llm: ctx.llm,
      });

      const result = await pipeline.run({
        query,
        knownSlugs: known_slugs,
        intentHint: intent_hint as SearchPlanIntent | undefined,
        budgetOverride: DETAIL_BUDGET[detail],
      });

      return {
        content: [
          {
            type: "text" as const,
            text: serializeResult(result),
          },
        ],
      };
    },
  );
}

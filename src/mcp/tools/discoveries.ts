import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { ReflectManager } from "../../core/reflect.js";

const TYPE_LABELS: Record<string, string> = {
  bridge: "桥接",
  community_crossing: "跨社区",
  structural_hole: "结构洞",
};

const ACTIONABLE_LABELS: Record<string, string> = {
  high: "重要",
  medium: "中等",
  low: "低",
};

function buildDiscoveryText(
  r: {
    id: number; type: string; entities: string; score: number;
    detail: string | null; detected_at: string;
    actionable: string; suggestion: string | null;
    proposed_actions: string | null; auto_applicable: number;
  },
  ctx: ToolContext,
): { display: string; data: Record<string, unknown> } {
  const entitySlugs: string[] = JSON.parse(r.entities);
  const detail = r.detail ? JSON.parse(r.detail) as Record<string, unknown> : {};
  const entitySummaries = entitySlugs.map(slug => {
    const page = ctx.db.getPage(slug);
    return page ? `${page.title}（${slug}）` : slug;
  }).join(" 与 ");

  const typeLabel = TYPE_LABELS[r.type] ?? r.type;
  const actionLabel = ACTIONABLE_LABELS[r.actionable] ?? r.actionable;
  const star = r.actionable === "high" ? " ⭐" : r.actionable === "medium" ? " ◆" : "";

  const lines = [
    `🔍 发现 #${r.id} [${typeLabel}]${star} ${actionLabel}`,
    `📊 ${entitySummaries}（score: ${r.score}，距离: ${(detail as { distance?: number }).distance ?? "?"}跳）`,
  ];

  if (r.suggestion) lines.push(`💡 ${r.suggestion}`);

  const actions = r.proposed_actions ? JSON.parse(r.proposed_actions) as Array<{ type: string; target: string; reason: string }> : [];
  for (const a of actions) {
    lines.push(`🎯 建议: ${a.type}(${a.target}) — ${a.reason}`);
  }

  lines.push(`📅 ${r.detected_at.slice(0, 10)}`);

  const data: Record<string, unknown> = {
    id: r.id,
    type: r.type,
    type_label: typeLabel,
    entities: entitySlugs.map(slug => {
      const page = ctx.db.getPage(slug);
      return page ? { slug, title: page.title, type: page.type } : { slug, title: "(deleted)", type: "unknown" };
    }),
    score: r.score,
    detail,
    actionable: r.actionable,
    actionable_label: actionLabel,
    suggestion: r.suggestion,
    proposed_actions: actions,
    auto_applicable: r.auto_applicable === 1,
    detected_at: r.detected_at,
  };

  return { display: lines.join("\n"), data };
}

export function registerDiscoveryTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool("read_discoveries", {
    description:
      "读取知识图谱的结构发现（桥接、跨社区、结构洞）。" +
      "返回未读发现，按重要程度分级（high/medium/low）。" +
      "high 级发现带有 LLM 生成的中文建议和可操作项。" +
      "用 mark_discovery_seen 标记已读，用 promote_discovery 升级为 insight。",
    inputSchema: {
      limit: z.number().optional().default(10).describe("Max discoveries to return"),
      actionableFilter: z.enum(["high", "medium", "low"]).optional().describe("Filter by actionable level"),
    },
  }, async ({ limit, actionableFilter }) => {
    const rows = actionableFilter
      ? ctx.db.getDiscoveriesByActionable(actionableFilter, limit ?? 10)
      : ctx.db.getUnseenDiscoveries(limit ?? 10);

    const results = rows.map(r => buildDiscoveryText(r, ctx));

    const displays = results.map(r => r.display).join("\n\n---\n\n");
    const summary = `共 ${results.length} 个发现` +
      (actionableFilter ? `（${ACTIONABLE_LABELS[actionableFilter] ?? actionableFilter}级）` : "") +
      `。high 级发现可 promote_discovery 升级为 insight。`;

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ display: displays, discoveries: results.map(r => r.data), summary }, null, 2),
      }],
    };
  });

  server.registerTool("run_discovery", {
    description:
      "运行发现管线，检测知识图谱中的结构异常（桥接、跨社区、结构洞）。" +
      "返回检测报告：总数、按类型统计、按重要程度统计。建议每 3 天运行一次。",
  }, async () => {
    const reflect = new ReflectManager(ctx.db, ctx.pages, ctx.llm, ctx.pipeline, ctx.embedding, ctx.insights);
    const report = await reflect.runDiscovery();

    const typeLabels = Object.entries(report.byType)
      .map(([k, v]) => `${TYPE_LABELS[k] ?? k}: ${v}`)
      .join("，");
    const actionLabels = Object.entries(report.byActionable)
      .map(([k, v]) => `${ACTIONABLE_LABELS[k] ?? k}: ${v}`)
      .join("，");

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          summary: `检测完成：${report.total} 个发现（${typeLabels}），重要程度：${actionLabels}，可自动应用：${report.autoApplicable}`,
          report,
        }, null, 2),
      }],
    };
  });

  server.registerTool("mark_discovery_seen", {
    description: "标记发现为已读。标记后不再出现在 read_discoveries 中。",
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

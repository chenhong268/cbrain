import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { DiscoveryManager } from "../../core/discovery.js";
import type { DiscoveryType } from "../../core/discovery.js";

const TYPE_LABELS: Record<string, string> = {
  bridge: "桥接",
  community_crossing: "跨社区",
  structural_hole: "结构洞",
  trend: "趋势",
  gap: "缺口",
  contradiction: "矛盾",
};

const ACTIONABLE_LABELS: Record<string, string> = {
  high: "重要",
  medium: "中等",
  low: "低",
};

const STATUS_LABELS: Record<string, string> = {
  pending: "待处理",
  resolved: "已解决",
  dismissed: "已忽略",
};

function buildDiscoveryText(
  r: {
    id: number; type: string; entities: string; score: number;
    detail: string | null; detected_at: string;
    actionable: string; suggestion: string | null;
    proposed_actions: string | null; auto_applicable: number;
    metadata?: string | null;
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
    `📊 ${entitySummaries}（score: ${r.score}）`,
  ];

  if (r.metadata) {
    try {
      const m = JSON.parse(r.metadata) as Record<string, unknown>;
      if (m.direction) lines.push(`📈 趋势: ${m.direction}`);
      if (m.distance) lines.push(`🔗 距离: ${m.distance}跳`);
      if (m.explanation) lines.push(`⚡ ${m.explanation}`);
    } catch { /* skip */ }
  }

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
      "读取知识图谱的结构发现（桥接、跨社区、结构洞、趋势、缺口、矛盾）。" +
      "返回未读发现，按重要程度分级（high/medium/low）。" +
      "high 级发现带有 LLM 生成的中文建议和可操作项。" +
      "用 update_discovery_status 标记处理状态，用 promote_discovery 升级为 insight。",
    inputSchema: {
      limit: z.number().optional().default(10).describe("Max discoveries to return"),
      actionableFilter: z.enum(["high", "medium", "low"]).optional().describe("Filter by actionable level"),
      typeFilter: z.enum(["bridge", "trend", "gap", "contradiction"]).optional().describe("Filter by discovery type"),
    },
  }, async ({ limit, actionableFilter, typeFilter }) => {
    const effectiveLimit = limit ?? 10;
    let rows: ReturnType<typeof ctx.db.getDiscoveriesByType>;

    if (typeFilter) {
      rows = ctx.db.getDiscoveriesByType(typeFilter, effectiveLimit);
    } else {
      // Type-diverse round-robin: prevent high-score bridges from crowding out gaps
      const activeTypes = ["bridge", "trend", "gap", "contradiction"] as const;
      const typeBuckets = new Map<string, ReturnType<typeof ctx.db.getDiscoveriesByType>>();

      for (const t of activeTypes) {
        const typeRows = ctx.db.getDiscoveriesByType(t, effectiveLimit);
        if (actionableFilter) {
          typeBuckets.set(t, typeRows.filter(r => r.actionable === actionableFilter));
        } else {
          typeBuckets.set(t, typeRows);
        }
      }

      const nonEmpty = [...typeBuckets.entries()].filter(([, v]) => v.length > 0);
      const merged: ReturnType<typeof ctx.db.getDiscoveriesByType> = [];
      let roundIdx = 0;
      while (merged.length < effectiveLimit && nonEmpty.some(([, v]) => v.length > 0)) {
        const bucket = nonEmpty[roundIdx % nonEmpty.length];
        if (bucket[1].length > 0) {
          merged.push(bucket[1].shift()!);
        }
        roundIdx++;
      }
      rows = merged;
    }

    const results = rows.map(r => buildDiscoveryText(r, ctx));

    const displays = results.map(r => r.display).join("\n\n---\n\n");
    const summary = `共 ${results.length} 个发现` +
      (typeFilter ? `（${TYPE_LABELS[typeFilter] ?? typeFilter}类）` : "") +
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
      "运行发现管线，检测知识图谱中的结构异常（桥接、趋势、缺口、矛盾）。" +
      "返回检测报告：总数、按类型统计、按重要程度统计。" +
      "可指定检测类型或默认全部。建议每天运行一次。",
    inputSchema: {
      types: z.array(z.enum(["bridge", "trend", "gap", "contradiction"])).optional()
        .describe("Detection types to run. Default: all."),
    },
  }, async ({ types }) => {
    // Run only DiscoveryManager (pure graph math, no LLM, completes in seconds).
    // ReflectManager is slower (BFS + LLM suggestions) and overlaps with bridge detection.
    // Contradiction detection is LLM-heavy — skip unless explicitly requested.
    const requested = types as DiscoveryType[] | undefined;
    const fastTypes: DiscoveryType[] = requested
      ? requested.filter(t => t !== "contradiction")
      : ["bridge", "trend", "gap"];
    const runContradiction = requested?.includes("contradiction") ?? false;

    const discoveryMgr = new DiscoveryManager(ctx.db, ctx.llm);
    const report = await discoveryMgr.runDiscovery(runContradiction ? undefined : fastTypes);

    const typeLabels = Object.entries(report.byType)
      .map(([k, v]) => `${TYPE_LABELS[k] ?? k}: ${v}`)
      .join("，");
    const actionLabels = Object.entries(report.byActionable)
      .map(([k, v]) => `${ACTIONABLE_LABELS[k] ?? k}: ${v}`)
      .join("，");

    const enrich = report.enrichment;
    const enrichLabel = enrich.skipped
      ? `enrichment 跳过（${enrich.reason}）`
      : `enrichment: 尝试 ${enrich.attempted} 个，成功 ${enrich.saved} 个，失败 ${enrich.errors} 个`;

    const skipped: string[] = [];
    if (!runContradiction) skipped.push("contradiction（用 CLI 或指定 types 运行）");
    skipped.push("reflect（社区/结构洞检测，用 CLI 运行）");

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          summary: `检测完成：${report.total} 个发现（${typeLabels}），重要程度：${actionLabels}。${enrichLabel}`,
          report,
          skipped,
        }, null, 2),
      }],
    };
  });

  server.registerTool("update_discovery_status", {
    description: "更新发现的处理状态。支持标记已读(seen)、已解决(resolved)、已忽略(dismissed)。",
    inputSchema: {
      ids: z.array(z.number()).describe("Discovery IDs to update"),
      status: z.enum(["seen", "resolved", "dismissed"]).describe("New status"),
    },
  }, async ({ ids, status }) => {
    for (const id of ids) {
      ctx.db.updateDiscoveryStatus(id, status);
      if (status === "seen") ctx.db.markDiscoverySeen(id);
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ updated: ids.length, status, status_label: STATUS_LABELS[status] }) }],
    };
  });

  server.registerTool("mark_discovery_seen", {
    description: "标记发现为已读。建议使用 update_discovery_status 替代。",
    inputSchema: {
      ids: z.array(z.number()).describe("Discovery IDs to mark as seen"),
    },
  }, async ({ ids }) => {
    for (const id of ids) {
      ctx.db.markDiscoverySeen(id);
      ctx.db.updateDiscoveryStatus(id, "seen");
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ marked: ids.length }) }],
    };
  });
}

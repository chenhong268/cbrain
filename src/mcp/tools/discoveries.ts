import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { DiscoveryManager } from "../../core/discovery.js";
import type { DiscoveryType } from "../../core/discovery.js";
import { formatDiscoveryDigest } from "../../core/discovery-digest.js";

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

export function registerDiscoveryTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool("read_discoveries", {
    description:
      "读取知识图谱的结构发现摘要（最多 3 条）。" +
      "返回用户可见的发现卡片，包含为什么重要、依据、建议动作。" +
      "如需处理发现，用 update_discovery_status 标记已读、已解决或忽略。",
    inputSchema: {
      limit: z.number().optional().default(3).describe("Max discoveries to return"),
      actionableFilter: z.enum(["high", "medium", "low"]).optional().describe("Filter by actionable level"),
      typeFilter: z.enum(["bridge", "trend", "gap", "contradiction"]).optional().describe("Filter by discovery type"),
      debug: z.boolean().optional().default(false).describe("Include internal debug info"),
    },
  }, async ({ limit, actionableFilter, typeFilter, debug }) => {
    const displayLimit = limit ?? 3;
    const fetchLimit = Math.max(displayLimit * 3, 10);
    let rows: ReturnType<typeof ctx.db.getDiscoveriesByType>;

    if (typeFilter) {
      rows = ctx.db.getDiscoveriesByType(typeFilter, fetchLimit);
    } else {
      // Type-diverse round-robin: prevent high-score bridges from crowding out gaps
      const activeTypes = ["bridge", "trend", "gap", "contradiction"] as const;
      const typeBuckets = new Map<string, ReturnType<typeof ctx.db.getDiscoveriesByType>>();

      for (const t of activeTypes) {
        const typeRows = ctx.db.getDiscoveriesByType(t, fetchLimit);
        if (actionableFilter) {
          typeBuckets.set(t, typeRows.filter(r => r.actionable === actionableFilter));
        } else {
          typeBuckets.set(t, typeRows);
        }
      }

      const nonEmpty = [...typeBuckets.entries()].filter(([, v]) => v.length > 0);
      const merged: ReturnType<typeof ctx.db.getDiscoveriesByType> = [];
      let roundIdx = 0;
      while (merged.length < fetchLimit && nonEmpty.some(([, v]) => v.length > 0)) {
        const bucket = nonEmpty[roundIdx % nonEmpty.length];
        if (bucket[1].length > 0) {
          merged.push(bucket[1].shift()!);
        }
        roundIdx++;
      }
      rows = merged;
    }

    const entityLookup = (slug: string) => ctx.db.getPage(slug);
    const digest = formatDiscoveryDigest(rows, entityLookup, displayLimit);

    const summary = digest.cards.length > 0
      ? `今天有 ${digest.cards.length} 条值得关注的发现。`
      : "今天暂无新的发现。";

    const payload: Record<string, unknown> = {
      display: digest.display,
      cards: digest.cards,
      summary,
    };
    if (debug) {
      payload._debug = digest._debug;
    }

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      }],
    };
  });

  server.registerTool("run_discovery", {
    description:
      "运行发现管线，检查知识图谱中的变化和机会。完成后返回用户可见的发现摘要（最多 3 条）。" +
      "可用 read_discoveries 查看历史发现，用 update_discovery_status 标记处理状态。" +
      "建议每天运行一次。",
    inputSchema: {
      types: z.array(z.enum(["bridge", "trend", "gap", "contradiction"])).optional()
        .describe("Detection types to run. Default: bridge, trend, gap."),
      debug: z.boolean().optional().default(false).describe("Include raw detection report"),
    },
  }, async ({ types, debug }) => {
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

    // User-facing path: format new discoveries through the digest pipeline
    const newRows = ctx.db.getUnseenDiscoveries(30);
    const entityLookup = (slug: string) => ctx.db.getPage(slug);
    const digest = formatDiscoveryDigest(newRows, entityLookup, 3);

    const summary = digest.cards.length > 0
      ? `今天有 ${digest.cards.length} 条值得关注的发现。`
      : "今天暂无值得打扰你的新发现。";

    const payload: Record<string, unknown> = {
      display: digest.display,
      cards: digest.cards,
      summary,
    };

    if (debug) {
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
      payload._debug = {
        report: {
          total: report.total,
          byType: report.byType,
          byActionable: report.byActionable,
          enrichment: report.enrichment,
        },
        type_summary: typeLabels,
        actionable_summary: actionLabels,
        enrichment_summary: enrichLabel,
        skipped,
      };
    }

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
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

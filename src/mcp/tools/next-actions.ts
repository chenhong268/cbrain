import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import {
  ACTION_CANDIDATE_TYPES,
  buildActionCandidatesFromDiscoveries,
  persistedCandidateRowToDraft,
  type ActionCandidateDraft,
} from "../../core/maintenance/action-candidates.js";
import { buildAttentionQueue, type AttentionQueueSummary, type NextAction } from "../../core/maintenance/attention-queue.js";
import { sanitizeDisplay } from "./format-result.js";

const ATTENTION_GROUP_WORD: Record<NextAction["severity"], string> = {
  blocked: "阻塞项",
  auto_repairable: "可安全修复项",
  needs_review: "需人工确认项",
  observe_only: "观察项",
};

function renderDisplay(items: NextAction[], summary: AttentionQueueSummary): string {
  if (items.length === 0) {
    return sanitizeDisplay("✅ 暂无需现在处理的事项。");
  }
  const lines: string[] = ["优先处理："];
  for (const it of items) {
    const tag = ATTENTION_GROUP_WORD[it.severity];
    const suffix = it.evidenceCount > 1 ? `（共 ${it.evidenceCount} 项同类）` : "";
    lines.push(`- ${tag}：${it.title}${suffix}`);
    lines.push(`  ${it.reason}`);
    lines.push(`  建议：${it.suggestion}`);
  }
  const tail: string[] = [];
  if (summary.hiddenObserveOnly > 0) {
    tail.push(`另有 ${summary.hiddenObserveOnly} 条观察项，默认不打扰。`);
  }
  if (summary.suppressedBeyondTop3 > 0) {
    tail.push(`还有 ${summary.suppressedBeyondTop3} 项次要问题未显示，可用 include_raw 查看。`);
  }
  if (tail.length > 0) lines.push(tail.join(" "));
  return sanitizeDisplay(lines.join("\n"));
}

const DEFAULT_SOURCES = ["health", "discovery"] as const;

/** action_* candidate types that carry health-derived severity (vs discovery-derived). */
const HEALTH_CANDIDATE_TYPES: ReadonlySet<string> = new Set(["action_health_review", "action_repair_preview"]);

/**
 * Read-only unified next-action queue (#309). Consumes ALREADY-PERSISTED action
 * candidate rows (created by run_action_candidates) plus plain discovery signals.
 * Strictly read-only: queries discoveries via CBrainDB SELECT methods only.
 *
 * NEVER runs HealthChecker.checkAll — that persists filesystem state/reports and
 * would violate the "no durable writes" invariant. Health signals reach this
 * surface only after run_action_candidates has classified them via planRepairs and
 * persisted action_health_review / action_repair_preview rows. NEVER persists
 * candidates, NEVER flips discovery seen/status, NEVER calls put_page/sync/repair.
 */
export function registerNextActionsTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool("next_actions", {
    description: "只读。返回当前最该处理的 top 1-3 项（跨健康/发现信号）。不修复、不删除、不合并、不提升候选。健康信号来自 run_action_candidates 已分类的候选，不重跑健康检查。",
    inputSchema: {
      sources: z
        .array(z.enum(["health", "discovery"]))
        .optional()
        .describe('默认 ["health","discovery"]；可只看单源'),
      include_raw: z
        .boolean()
        .optional()
        .describe("true=附带观察项与全量排序的审计明细；默认 false"),
    },
  }, async ({ sources, include_raw }) => {
    // MCP SDK does not re-apply zod .default(); re-resolve defensively (#271 pattern).
    const srcs = sources ?? [...DEFAULT_SOURCES];
    const includeRaw = include_raw === true;

    const healthDrafts: ActionCandidateDraft[] = [];
    const discoveryDrafts: ActionCandidateDraft[] = [];

    // Persisted action candidate rows (read-only SELECTs). Severity derives from the
    // candidate type (action_repair_preview -> auto_repairable, action_health_review ->
    // needs_review), preserving the planRepairs classification from run_action_candidates.
    for (const t of ACTION_CANDIDATE_TYPES) {
      const isHealth = HEALTH_CANDIDATE_TYPES.has(t);
      if (isHealth && !srcs.includes("health")) continue;
      if (!isHealth && !srcs.includes("discovery")) continue;
      for (const r of ctx.db.getDiscoveriesByType(t, 50)) {
        const full = ctx.db.getDiscoveryById(r.id);
        if (!full) continue;
        const draft = persistedCandidateRowToDraft(full);
        if (!draft) continue;
        // getDiscoveriesByType + getDiscoveryById are pure SELECTs (seen=0 AND status='pending').
        (isHealth ? healthDrafts : discoveryDrafts).push(draft);
      }
    }

    // Plain (non-action) discovery signals — buildActionCandidatesFromDiscoveries
    // skips action_* types, so these never overlap with the loop above.
    if (srcs.includes("discovery")) {
      const rows = ctx.db.getUnseenDiscoveries(50).map((row) => {
        const full = ctx.db.getDiscoveryById(row.id);
        return {
          ...row,
          occurrence_count: full?.occurrence_count,
          dedup_key: full?.dedup_key,
        };
      });
      discoveryDrafts.push(...buildActionCandidatesFromDiscoveries(rows));
    }

    const queue = buildAttentionQueue(healthDrafts, discoveryDrafts, { includeRaw });
    const display = renderDisplay(queue.items, queue.summary);

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          display,
          summary: queue.summary,
          items: queue.items.map((i) => ({
            severity: i.severity,
            source: i.source,
            title: i.title,
            reason: i.reason,
            suggestion: i.suggestion,
            evidence_count: i.evidenceCount,
          })),
          raw: queue.raw,
          result_summary: `${queue.summary.shownCount} 项待处理（默认上限 3）`,
        }, null, 2),
      }],
    };
  });
}

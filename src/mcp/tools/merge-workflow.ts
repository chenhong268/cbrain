import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { MergeWorkflow } from "../../core/merge-workflow.js";
import { getLayer } from "../../core/shared.js";

/**
 * Strip internal fields (_source_vault_path) from plan before exposing to Agent.
 */
function sanitizePlan(plan: Record<string, unknown>): Record<string, unknown> {
  const { _source_vault_path, ...public_ } = plan;
  return public_;
}

export function registerMergeWorkflowTools(server: McpServer, ctx: ToolContext): void {
  const wf = new MergeWorkflow(ctx.db, ctx.pages, ctx.vaultPath);

  // ─── merge_entities ──────────────────────────────────────────
  server.registerTool("merge_entities", {
    description: "实体合并专用安全入口。支持 dry_run（返回合并规划，零写入）和 execute（安全执行合并 + 自动验证残留）。仅限 derived 层（entity/concept/insight），拒绝 record 层。返回合并规划（影响分析、冲突检测、wikilink 重写预估）和执行后的验证摘要。",
    inputSchema: {
      source: z.string().max(500).describe("源实体 slug（合并后将被删除）"),
      target: z.string().max(500).describe("目标实体 slug（保留）"),
      dry_run: z.boolean().default(true).describe("true=只返回规划不写入，false=执行合并并验证"),
      strategy: z.enum(["safe", "force"]).optional().default("safe").describe("safe=有冲突就拦，force=警告但继续（硬阻断仍拦）"),
    },
  }, async ({ source, target, dry_run, strategy }) => {
    const plan = wf.planMerge(source, target);

    if (!plan) {
      return {
        content: [{ type: "text", text: JSON.stringify({
          success: false,
          error: "合并规划失败：请确认 source 和 target 均存在且不同",
        }) }],
        isError: true,
      };
    }

    // Reject record layer explicitly
    if (getLayer(plan.source.type) === "source" || getLayer(plan.target.type) === "source") {
      return {
        content: [{ type: "text", text: JSON.stringify({
          success: false,
          error: `merge_entities 仅限 derived 层（entity/concept/insight）。source 是 ${plan.source.type}（${getLayer(plan.source.type)} 层），target 是 ${plan.target.type}（${getLayer(plan.target.type)} 层）。请使用 merge_pages 工具合并记录。`,
        }) }],
        isError: true,
      };
    }

    // Dry run mode: return plan only (strip internal fields)
    if (dry_run) {
      return {
        content: [{ type: "text", text: JSON.stringify({
          mode: "dry_run",
          plan: sanitizePlan(plan as unknown as Record<string, unknown>),
        }, null, 2) }],
      };
    }

    // Execute mode: check conflicts
    const effectiveStrategy = strategy ?? "safe";
    const hardConflicts = plan.conflicts;

    if (hardConflicts.length > 0) {
      // Hard conflicts block even force strategy
      return {
        content: [{ type: "text", text: JSON.stringify({
          success: false,
          error: `合并被阻断：${hardConflicts.join("；")}`,
          plan: sanitizePlan(plan as unknown as Record<string, unknown>),
        }) }],
        isError: true,
      };
    }

    if (plan.warnings.length > 0 && effectiveStrategy === "safe") {
      // Warnings block in safe mode
      return {
        content: [{ type: "text", text: JSON.stringify({
          success: false,
          error: `合并因警告被拦截（使用 strategy=force 可跳过）：${plan.warnings.join("；")}`,
          plan: sanitizePlan(plan as unknown as Record<string, unknown>),
        }) }],
        isError: true,
      };
    }

    // Execute the merge via existing PageManager.merge()
    const merged = await ctx.pages.merge(source, target);
    if (!merged) {
      return {
        content: [{ type: "text", text: JSON.stringify({
          success: false,
          error: "合并执行失败 — PageManager.merge 返回 null",
        }) }],
        isError: true,
      };
    }

    // Migrate source aliases to target AFTER merge succeeds.
    // plan saved aliases_on_source before any mutation, so even though
    // source aliases are cascade-deleted by merge, we still have the list.
    wf.migrateAliases(plan);

    // Sync Known Relations for target and all graph neighbors
    const neighbors = ctx.db.getLinkNeighborSlugs(target);
    const syncWarnings = ctx.pages.syncAffectedSlugs([target, ...neighbors]);

    // Run post-merge verification — pass source vault path from plan
    // (source DB row is already deleted, can't read file_path from DB)
    const verification = wf.verifyMerge(source, target, plan._source_vault_path);

    const success = verification.all_passed;

    return {
      content: [{ type: "text", text: JSON.stringify({
        success,
        merged: merged.slug,
        title: merged.title,
        type: merged.type,
        verification,
        ...(!success ? { status: "verification_failed" } : {}),
        ...(plan.warnings.length > 0 ? { warnings: plan.warnings } : {}),
        ...(syncWarnings.length > 0 ? { sync_warnings: syncWarnings } : {}),
      }, null, 2) }],
      ...(!success ? { isError: true } : {}),
    };
  });
}

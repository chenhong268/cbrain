import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { WakeupDiff } from "../../core/wakeup.js";

export function registerWakeupTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool("wakeup_diff", {
    description: "生成认知变化摘要（Wake-up Diff）。对比上次快照，产出新增记忆项、内容更新、tier 变化、关系变化、置信度衰减等差异。首次运行建立基线。可由 dream 自动触发或手动运行。",
    inputSchema: {},
  }, async () => {
    const diff = new WakeupDiff(ctx.db, ctx.outputsDir, ctx.logger);
    const result = await diff.run();
    return {
      content: [{ type: "text" as const, text: buildDisplayText(result) }],
    };
  });
}

function buildDisplayText(result: Awaited<ReturnType<WakeupDiff["run"]>>): string {
  const lines: string[] = [`📋 CBrain Wake-up Diff · ${result.date}`, ""];

  if (result.baselineCreated) {
    lines.push("已建立基线快照，暂无变化摘要。");
    lines.push(`当前状态：${result.stats.totalPages} 个记忆页，${result.stats.totalLinks} 条关系。`);
    return lines.join("\n");
  }

  const totalChanges = result.changes.contentUpdated.length +
    result.changes.tierChanged.length +
    result.changes.linkCountChanged.length +
    result.changes.confidenceDecayed.length +
    result.changes.removed.length;

  if (totalChanges === 0 && result.newItems.length === 0) {
    lines.push("无认知变化。");
    return lines.join("\n");
  }

  lines.push(`变化摘要：${totalChanges} 项变化，${result.newItems.length} 个新增`);

  if (result.changes.tierChanged.length > 0) {
    lines.push("");
    lines.push("🏷️ Tier 变化：");
    for (const t of result.changes.tierChanged.slice(0, 5)) {
      const dir = t.newTier < t.oldTier ? "↑ 升级" : "↓ 降级";
      lines.push(`  - ${t.title}：${t.oldTier} → ${t.newTier}（${dir}）`);
    }
  }

  if (result.changes.contentUpdated.length > 0) {
    lines.push("");
    lines.push("📝 内容更新：");
    for (const c of result.changes.contentUpdated.slice(0, 5)) {
      lines.push(`  - ${c.title}`);
    }
  }

  if (result.newItems.length > 0) {
    lines.push("");
    lines.push("🆕 新增记忆项：");
    for (const n of result.newItems.slice(0, 5)) {
      lines.push(`  - ${n.title}（${n.type}）`);
    }
  }

  if (result.changes.linkCountChanged.length > 0) {
    lines.push("");
    lines.push("🔗 关系变化：");
    for (const l of result.changes.linkCountChanged.slice(0, 5)) {
      const sign = l.diff > 0 ? "+" : "";
      lines.push(`  - ${l.title}：${sign}${l.diff}`);
    }
  }

  if (result.changes.removed.length > 0) {
    lines.push("");
    lines.push("🗑️ 已移除：");
    for (const r of result.changes.removed.slice(0, 5)) {
      lines.push(`  - ${r.title}`);
    }
  }

  if (result.truncated) {
    lines.push("", `⋯ ${result.truncationReason}`);
  }

  return lines.join("\n");
}

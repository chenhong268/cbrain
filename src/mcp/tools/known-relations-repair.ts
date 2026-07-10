import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  KNOWN_RELATIONS_REPAIR_MAX_LIMIT,
  repairKnownRelations,
} from "../../core/maintenance/known-relations-repair.js";
import type { ToolContext } from "../context.js";

export function registerKnownRelationsRepairTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool("repair_known_relations", {
    description: "Maintenance-only bounded repair for Markdown Known Relations projection drift. Defaults to dry-run; execute requires an explicit limit.",
    inputSchema: {
      execute: z.boolean().optional().default(false).describe("false=dry-run (default); true=write bounded repairs"),
      limit: z.number().int().min(1).max(KNOWN_RELATIONS_REPAIR_MAX_LIMIT).optional()
        .describe("Batch limit. Required when execute=true; maximum 100."),
    },
  }, async ({ execute, limit }) => {
    const shouldExecute = execute === true;
    if (shouldExecute && limit === undefined) {
      return {
        content: [{ type: "text", text: JSON.stringify({
          display: "未执行：写入模式必须明确指定批次上限。",
          summary: { status: "invalid", reason: "LIMIT_REQUIRED" },
          raw: null,
        }) }],
        isError: true,
      };
    }

    const result = repairKnownRelations({
      db: ctx.db,
      pages: ctx.pages,
      vaultPath: ctx.vaultPath,
      execute: shouldExecute,
      limit: limit ?? 25,
    });
    const display = shouldExecute
      ? `Known Relations 小批量修复完成：已修复 ${result.repaired} 项，失败 ${result.failed} 项，仍有 ${result.remaining} 项待处理。`
      : `Known Relations 只读预检：发现 ${result.candidates} 项漂移，本批最多处理 ${result.selected} 项，之后预计剩余 ${result.remaining} 项。`;
    return {
      content: [{ type: "text", text: JSON.stringify({
        display,
        summary: {
          status: result.failed > 0 ? "partial" : "ok",
          dryRun: result.dryRun,
          scanned: result.scanned,
          candidates: result.candidates,
          selected: result.selected,
          repaired: result.repaired,
          skipped: result.skipped,
          failed: result.failed,
          remaining: result.remaining,
        },
        raw: null,
      }) }],
    };
  });
}

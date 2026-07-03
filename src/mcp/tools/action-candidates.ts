import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import {
  ACTION_CANDIDATE_TYPES,
  ActionCandidateManager,
  buildActionCandidatesFromDiscoveries,
  buildActionCandidatesFromHealthPlan,
  isActionCandidateType,
  type ActionCandidateType,
  type PersistedActionCandidate,
} from "../../core/maintenance/action-candidates.js";
import { HealthChecker } from "../../core/maintenance/health.js";
import { planRepairs, type PageSignals } from "../../core/maintenance/health-debt.js";

const STATUS_LABELS: Record<string, string> = {
  seen: "已读",
  resolved: "已解决",
  dismissed: "已忽略",
};

function parseJsonSafe<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

type DiscoveryFullRow = NonNullable<ReturnType<ToolContext["db"]["getDiscoveryById"]>>;

function candidateFromRow(row: DiscoveryFullRow): PersistedActionCandidate | null {
  if (!isActionCandidateType(row.type)) return null;
  const meta = parseJsonSafe<Record<string, unknown>>(row.metadata, {});
  return {
    id: row.id,
    type: row.type as ActionCandidateType,
    entities: parseJsonSafe<string[]>(row.entities, []),
    actionable: row.actionable as "high" | "medium" | "low",
    displayTitle: String(meta.display_title ?? "有一项候选行动需要确认"),
    displayReason: String(meta.display_reason ?? "这项信号需要人工复核后再处理。"),
    suggestedAction: String(meta.suggested_action ?? "确认后再决定处理或忽略。"),
    evidence: Array.isArray(meta.evidence) ? meta.evidence as PersistedActionCandidate["evidence"] : [],
    proposedActions: parseJsonSafe<PersistedActionCandidate["proposedActions"]>(row.proposed_actions, []),
    occurrenceCount: row.occurrence_count,
    inserted: false,
  };
}

function rowsToCandidates(ctx: ToolContext, limit: number, type?: ActionCandidateType): PersistedActionCandidate[] {
  const types = type ? [type] : ACTION_CANDIDATE_TYPES;
  const out: PersistedActionCandidate[] = [];
  for (const t of types) {
    const rows = ctx.db.getDiscoveriesByType(t, Math.max(limit, 20));
    for (const row of rows) {
      const full = ctx.db.getDiscoveryById(row.id);
      if (!full) continue;
      const candidate = candidateFromRow(full);
      if (candidate) out.push(candidate);
    }
  }
  out.sort((a, b) => {
    const order: Record<string, number> = { high: 0, medium: 1, low: 2 };
    const ao = order[a.actionable] ?? 9;
    const bo = order[b.actionable] ?? 9;
    if (ao !== bo) return ao - bo;
    return b.occurrenceCount - a.occurrenceCount;
  });
  return out.slice(0, limit);
}

interface RenderedCandidates {
  display: string;
  summary: { status: "ok"; count: number; message: string };
}

function renderCandidates(candidates: PersistedActionCandidate[]): RenderedCandidates {
  const display = candidates.length === 0
    ? "暂无待处理的行动候选。"
    : candidates.map((c) => `### ${c.displayTitle}\n${c.displayReason}\n**建议**：${c.suggestedAction}`).join("\n\n---\n\n");
  const message = candidates.length === 0
    ? "暂无待处理的行动候选。"
    : `有 ${candidates.length} 项行动候选等待确认。`;
  return { display, summary: { status: "ok", count: candidates.length, message } };
}

export function registerActionCandidateTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool("run_action_candidates", {
    description: "从 Discovery/Health 信号生成内部行动候选。不发送通知、不创建 issue、不执行修复。",
    inputSchema: {
      sources: z.array(z.enum(["discovery", "health"])).optional().default(["discovery"]).describe("Candidate sources to inspect"),
      limit: z.number().optional().default(10).describe("Max candidates to return"),
    },
  }, async ({ sources, limit }) => {
    const cap = limit ?? 10;
    const srcs = sources ?? ["discovery"];
    const drafts = [];
    if (srcs.includes("discovery")) {
      const rows = ctx.db.getUnseenDiscoveries(Math.max(cap * 3, 20)).map((row) => {
        const full = ctx.db.getDiscoveryById(row.id);
        return {
          ...row,
          proposed_actions: row.proposed_actions,
          auto_applicable: row.auto_applicable,
          occurrence_count: full?.occurrence_count,
          dedup_key: full?.dedup_key,
        };
      });
      drafts.push(...buildActionCandidatesFromDiscoveries(rows));
    }
    if (srcs.includes("health")) {
      const checker = new HealthChecker(ctx.db, ctx.outputsDir, ctx.logger, ctx.vaultPath);
      const report = await checker.checkAll();
      const signalLookup = (slug: string): PageSignals | undefined => {
        if (!slug || slug === "-") return undefined;
        try {
          const tm = ctx.db.getPageTierAndMentions(slug);
          const incoming = ctx.db.getIncomingLinks(slug);
          return { mentionCount: tm?.mention_count, incomingLinkCount: incoming.length };
        } catch {
          return undefined;
        }
      };
      drafts.push(...buildActionCandidatesFromHealthPlan(planRepairs(report, signalLookup)));
    }

    const manager = new ActionCandidateManager(ctx.db);
    const persistedReport = manager.persistDrafts(drafts.slice(0, cap));
    const rendered = renderCandidates(persistedReport.candidates);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(
          { ...rendered, candidates: persistedReport.candidates, raw: persistedReport, result_summary: rendered.summary.message },
          null,
          2,
        ),
      }],
    };
  });

  server.registerTool("read_action_candidates", {
    description: "读取待处理的内部行动候选。不会执行任何动作。",
    inputSchema: {
      limit: z.number().optional().default(10).describe("Max candidates to return"),
      typeFilter: z.enum(ACTION_CANDIDATE_TYPES).optional().describe("Restrict candidate type"),
    },
  }, async ({ limit, typeFilter }) => {
    const candidates = rowsToCandidates(ctx, limit ?? 10, typeFilter);
    const rendered = renderCandidates(candidates);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ ...rendered, candidates, result_summary: rendered.summary.message }, null, 2),
      }],
    };
  });

  server.registerTool("update_action_candidate_status", {
    description: "更新行动候选状态。支持 resolved/dismissed/seen，不会执行候选动作。",
    inputSchema: {
      ids: z.array(z.number()).describe("Action candidate discovery IDs"),
      status: z.enum(["seen", "resolved", "dismissed"]).describe("New status"),
    },
  }, async ({ ids, status }) => {
    for (const id of ids) {
      const row = ctx.db.getDiscoveryById(id);
      if (!row || !isActionCandidateType(row.type)) continue;
      ctx.db.updateDiscoveryStatus(id, status);
      if (status === "seen") ctx.db.markDiscoverySeen(id);
    }
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ updated: ids.length, status, status_label: STATUS_LABELS[status] }),
      }],
    };
  });
}

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import {
  ACTION_CANDIDATE_TYPES,
  ActionCandidateManager,
  buildActionCandidatesFromDiscoveries,
  buildActionCandidatesFromHealthPlan,
  isActionCandidateType,
  persistedCandidateRowToDraft,
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

type DiscoveryFullRow = NonNullable<ReturnType<ToolContext["db"]["getDiscoveryById"]>>;

interface RankedCandidate {
  candidate: PersistedActionCandidate;
  /** Compatibility-only ordering key; never exposed in the public candidate. */
  sortOccurrenceCount: number;
}

function candidateFromRow(row: DiscoveryFullRow): RankedCandidate | null {
  const draft = persistedCandidateRowToDraft(row);
  if (!draft) return null;
  const occurrenceCount = typeof draft.metadata.occurrence_count === "number"
    ? draft.metadata.occurrence_count
    : row.occurrence_count;
  return {
    candidate: {
      id: row.id,
      type: draft.type,
      entities: draft.entities,
      actionable: draft.actionable,
      displayTitle: draft.displayTitle,
      displayReason: draft.displayReason,
      suggestedAction: draft.suggestedAction,
      evidence: draft.evidence,
      proposedActions: draft.proposedActions,
      occurrenceCount,
      inserted: false,
    },
    sortOccurrenceCount: row.occurrence_count,
  };
}

function rowsToCandidates(ctx: ToolContext, limit: number, type?: ActionCandidateType): PersistedActionCandidate[] {
  const types = type ? [type] : ACTION_CANDIDATE_TYPES;
  const out: RankedCandidate[] = [];
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
    const ao = order[a.candidate.actionable] ?? 9;
    const bo = order[b.candidate.actionable] ?? 9;
    if (ao !== bo) return ao - bo;
    return b.sortOccurrenceCount - a.sortOccurrenceCount;
  });
  return out.slice(0, limit).map((entry) => entry.candidate);
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
      const checker = new HealthChecker(ctx.db, ctx.outputsDir, ctx.logger, ctx.vaultPath, ctx.vaultBoundary);
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

    const manager = new ActionCandidateManager(ctx.db, ctx.logger);
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
    let updated = 0;
    for (const id of ids) {
      const row = ctx.db.getDiscoveryById(id);
      if (!row || !isActionCandidateType(row.type)) continue;
      ctx.db.updateDiscoveryStatus(id, status);
      if (status === "seen") ctx.db.markDiscoverySeen(id);
      updated++;
    }
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ updated, status, status_label: STATUS_LABELS[status] }),
      }],
    };
  });
}

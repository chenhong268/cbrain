import type { CBrainDB } from "../../storage/sqlite.js";
import type { Logger } from "../logger.js";
import type { RepairAction, RepairPlan } from "./health-debt.js";
import { runDiscoveryShadowVerifierFailOpen } from "../quality/shadow-verifier.js";
import { assertSafeActionDisplay } from "../safety/display-safety.js";

export const ACTION_CANDIDATE_TYPES = [
  "action_review_discovery",
  "action_health_review",
  "action_repair_preview",
] as const;

export type ActionCandidateType = typeof ACTION_CANDIDATE_TYPES[number];
export type ActionCandidateKind = "review_discovery" | "health_review" | "repair_preview";
export type ActionCandidateActionType = "review" | "dry_run" | "notify_draft";

export interface ActionEvidenceRef {
  source: "discovery" | "health";
  ref: string;
  kind: string;
}

export interface ProposedAction {
  type: ActionCandidateActionType;
  target: string;
  reason: string;
}

export interface ActionCandidateDraft {
  type: ActionCandidateType;
  entities: string[];
  score: number;
  actionable: "high" | "medium" | "low";
  displayTitle: string;
  displayReason: string;
  suggestedAction: string;
  evidence: ActionEvidenceRef[];
  proposedActions: ProposedAction[];
  metadata: Record<string, unknown>;
}

export interface PersistedActionCandidate {
  id: number;
  type: ActionCandidateType;
  entities: string[];
  actionable: "high" | "medium" | "low";
  displayTitle: string;
  displayReason: string;
  suggestedAction: string;
  evidence: ActionEvidenceRef[];
  proposedActions: ProposedAction[];
  occurrenceCount: number;
  inserted: boolean;
}

export interface ActionCandidateReport {
  total: number;
  inserted: number;
  updated: number;
  byType: Record<ActionCandidateType, number>;
  candidates: PersistedActionCandidate[];
}

export interface DiscoveryCandidateSource {
  id: number;
  type: string;
  entities: string;
  score: number;
  actionable: string;
  proposed_actions?: string | null;
  auto_applicable?: number;
  metadata?: string | null;
  occurrence_count?: number;
  dedup_key?: string | null;
}

export function isActionCandidateType(type: string): type is ActionCandidateType {
  return (ACTION_CANDIDATE_TYPES as readonly string[]).includes(type);
}

const HIGH_VALUE_DISCOVERY_TYPES = new Set([
  "similar_entity",
  "knowledge_map_isolation",
  "knowledge_map_bridge",
  "contradiction",
]);

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function stableDiscoveryRef(row: DiscoveryCandidateSource): string {
  return `discovery:${row.dedup_key ?? row.id}`;
}

function safeActionable(value: string): "high" | "medium" | "low" {
  if (value === "high" || value === "medium" || value === "low") return value;
  return "low";
}

function reviewDiscoveryDraft(row: DiscoveryCandidateSource): ActionCandidateDraft {
  const ref = stableDiscoveryRef(row);
  const occurrenceCount = row.occurrence_count ?? 1;
  const metadata = parseJsonObject(row.metadata);
  const displayTitle = "有一条发现值得复核";
  const displayReason =
    occurrenceCount >= 3
      ? "同类信号已经多次出现，建议确认是否需要采取行动。"
      : "这条发现的重要程度较高，建议先人工确认。";
  const suggestedAction = "打开对应发现，确认是否需要记录、合并、补链或忽略。";

  assertSafeActionDisplay(displayTitle);
  assertSafeActionDisplay(displayReason);
  assertSafeActionDisplay(suggestedAction);

  return {
    type: "action_review_discovery",
    entities: [ref],
    score: Math.max(0.1, Math.min(1, row.score)),
    actionable: safeActionable(row.actionable),
    displayTitle,
    displayReason,
    suggestedAction,
    evidence: [{ source: "discovery", ref, kind: row.type }],
    proposedActions: [{
      type: "review",
      target: ref,
      reason: "复核这条发现是否需要后续处理。",
    }],
    metadata: {
      source: "discovery",
      source_type: row.type,
      source_ref: ref,
      occurrence_count: occurrenceCount,
      evidence: [{ source: "discovery", ref, kind: row.type }],
      source_metadata: metadata,
    },
  };
}

export function buildActionCandidatesFromDiscoveries(rows: DiscoveryCandidateSource[]): ActionCandidateDraft[] {
  const drafts: ActionCandidateDraft[] = [];
  for (const row of rows) {
    if (isActionCandidateType(row.type)) continue;
    if (row.auto_applicable === 1) continue;
    const occurrenceCount = row.occurrence_count ?? 1;
    const hasProposedActions = typeof row.proposed_actions === "string" && row.proposed_actions.trim().length > 0;
    const shouldPromote =
      row.actionable === "high" ||
      occurrenceCount >= 3 ||
      hasProposedActions ||
      HIGH_VALUE_DISCOVERY_TYPES.has(row.type);
    if (!shouldPromote) continue;
    drafts.push(reviewDiscoveryDraft(row));
  }
  return drafts;
}

function healthStableRef(action: RepairAction): string {
  const scope = action.slug && action.slug !== "-" ? action.slug : "global";
  return `health:${action.dimension}:${action.kind ?? action.group}:${scope}`;
}

function actionableFromSeverity(severity: RepairAction["severity"]): "high" | "medium" | "low" {
  if (severity === "high") return "high";
  if (severity === "medium") return "medium";
  return "low";
}

function buildHealthDisplay(action: RepairAction): { title: string; reason: string; suggestion: string } {
  if (action.group === "blocked") {
    return {
      title: "有一项健康检查被前置条件阻塞",
      reason: "系统需要先处理运行条件或日志问题，再重新评估这项健康信号。",
      suggestion: "先查看健康报告中的阻塞原因，再决定是否继续处理。",
    };
  }
  if (action.group === "auto_repairable") {
    return {
      title: "有一项修复建议可以先预览",
      reason: "这项问题有确定性的修复方向，但仍应先 dry-run 查看影响范围。",
      suggestion: "先运行预览，不要直接执行修复。",
    };
  }
  return {
    title: "有一项健康问题需要人工确认",
    reason: "这项信号可能影响知识质量，但不适合自动处理。",
    suggestion: "人工确认后再决定修复、忽略或继续观察。",
  };
}

function healthDraft(action: RepairAction, source: string): ActionCandidateDraft | null {
  if (action.group === "observe_only") return null;
  const ref = healthStableRef(action);
  const display = buildHealthDisplay(action);
  assertSafeActionDisplay(display.title);
  assertSafeActionDisplay(display.reason);
  assertSafeActionDisplay(display.suggestion);

  const type: ActionCandidateType =
    action.group === "auto_repairable" ? "action_repair_preview" : "action_health_review";
  const proposedType: ActionCandidateActionType =
    action.group === "auto_repairable" ? "dry_run" : "review";
  const proposedReason =
    action.group === "auto_repairable"
      ? "预览这项修复，不自动执行。"
      : "复核这项健康信号是否需要后续处理。";

  return {
    type,
    entities: [ref],
    score: action.severity === "high" ? 0.9 : action.severity === "medium" ? 0.6 : 0.3,
    actionable: actionableFromSeverity(action.severity),
    displayTitle: display.title,
    displayReason: display.reason,
    suggestedAction: display.suggestion,
    evidence: [{ source: "health", ref, kind: action.kind ?? action.group }],
    proposedActions: [{ type: proposedType, target: ref, reason: proposedReason }],
    metadata: {
      source: "health",
      source_report: source,
      source_ref: ref,
      dimension: action.dimension,
      repair_group: action.group,
      repair_kind: action.kind ?? null,
      severity: action.severity,
      evidence: [{ source: "health", ref, kind: action.kind ?? action.group }],
      action_text: action.action,
      rollback_note: action.rollbackNote ?? null,
    },
  };
}

export function buildActionCandidatesFromHealthPlan(plan: RepairPlan): ActionCandidateDraft[] {
  const drafts: ActionCandidateDraft[] = [];
  for (const action of plan.actions) {
    const draft = healthDraft(action, plan.source);
    if (draft) drafts.push(draft);
  }
  return drafts;
}

function parseActions(raw: string | null | undefined): ProposedAction[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as ProposedAction[] : [];
  } catch {
    return [];
  }
}

function persistedFromRow(
  row: NonNullable<ReturnType<CBrainDB["getDiscoveryById"]>>,
  draft: ActionCandidateDraft,
  inserted: boolean,
): PersistedActionCandidate {
  return {
    id: row.id,
    type: draft.type,
    entities: JSON.parse(row.entities) as string[],
    actionable: draft.actionable,
    displayTitle: draft.displayTitle,
    displayReason: draft.displayReason,
    suggestedAction: draft.suggestedAction,
    evidence: draft.evidence,
    proposedActions: parseActions(row.proposed_actions),
    occurrenceCount: row.occurrence_count,
    inserted,
  };
}

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

/**
 * Read-side counterpart of the draft builders: reconstruct an in-memory draft from a
 * persisted action-candidate discovery row (created by `ActionCandidateManager.persistDrafts`
 * via `run_action_candidates`). Used by READ-ONLY consumers (e.g. next_actions) that must
 * NOT re-run HealthChecker.checkAll (which persists FS state) or re-persist candidates.
 * Pure: reads only the row argument, writes nothing.
 *
 * Severity is derived from the candidate type — action_repair_preview -> auto_repairable,
 * action_health_review -> needs_review — preserving the planRepairs classification that
 * ran when the row was created. No parallel taxonomy.
 */
export function persistedCandidateRowToDraft(
  row: NonNullable<ReturnType<CBrainDB["getDiscoveryById"]>>,
): ActionCandidateDraft | null {
  if (!isActionCandidateType(row.type)) return null;
  const meta = parseJsonObject(row.metadata);
  const source: "health" | "discovery" = row.type === "action_review_discovery" ? "discovery" : "health";
  const evidence: ActionEvidenceRef[] = Array.isArray(meta.evidence) ? meta.evidence as ActionEvidenceRef[] : [];
  return {
    type: row.type,
    entities: parseJsonArray(row.entities),
    score: row.score,
    actionable: safeActionable(row.actionable),
    displayTitle: String(meta.display_title ?? "有一项候选需要确认"),
    displayReason: String(meta.display_reason ?? "这项信号需要人工复核后再处理。"),
    suggestedAction: String(meta.suggested_action ?? "确认后再决定处理或忽略。"),
    evidence,
    proposedActions: parseActions(row.proposed_actions),
    metadata: {
      source,
      repair_group: row.type === "action_repair_preview" ? "auto_repairable" : "needs_review",
      source_type: source === "discovery" ? String(meta.source_type ?? row.type) : undefined,
      dimension: source === "health" ? String(meta.dimension ?? "dim") : undefined,
      repair_kind: source === "health" ? ((meta.repair_kind as string | null | undefined) ?? null) : undefined,
    },
  };
}

export class ActionCandidateManager {
  constructor(
    private readonly db: CBrainDB,
    private readonly logger?: Logger | null,
  ) {}

  persistDrafts(drafts: ActionCandidateDraft[]): ActionCandidateReport {
    const byType: Record<ActionCandidateType, number> = {
      action_review_discovery: 0,
      action_health_review: 0,
      action_repair_preview: 0,
    };
    const candidates: PersistedActionCandidate[] = [];
    let insertedCount = 0;
    let updatedCount = 0;

    for (const draft of drafts) {
      assertSafeActionDisplay(draft.displayTitle);
      assertSafeActionDisplay(draft.displayReason);
      assertSafeActionDisplay(draft.suggestedAction);
      // #265: shadow-verify BEFORE the upsert. Fail-open absolute — the runner
      // catches all internally; the upsert path is independent of verifier
      // success. page_slug stays null (discovery rows never carry slug/dedup_key).
      runDiscoveryShadowVerifierFailOpen({
        db: this.db,
        logger: this.logger,
        input: {
          type: draft.type,
          actionable: draft.actionable,
          score: draft.score,
          autoApplicable: false,
          hasEvidence: draft.evidence.length > 0,
          hasProposedActions: draft.proposedActions.length > 0,
          displayTexts: [draft.displayTitle, draft.displayReason, draft.suggestedAction],
        },
      });
      const result = this.db.upsertDiscovery(
        draft.type,
        draft.entities,
        draft.score,
        undefined,
        undefined,
        draft.actionable,
        false,
        {
          ...draft.metadata,
          display_title: draft.displayTitle,
          display_reason: draft.displayReason,
          suggested_action: draft.suggestedAction,
          evidence: draft.evidence,
        },
      );
      this.db.updateDiscoveryActions(result.id, draft.proposedActions);
      const row = this.db.getDiscoveryById(result.id);
      if (!row) continue;
      if (result.inserted) insertedCount++;
      else updatedCount++;
      byType[draft.type]++;
      candidates.push(persistedFromRow(row, draft, result.inserted));
    }

    return {
      total: candidates.length,
      inserted: insertedCount,
      updated: updatedCount,
      byType,
      candidates,
    };
  }
}

export type { RepairAction };

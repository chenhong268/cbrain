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
  detected_at?: string;
  last_detected_at?: string | null;
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

/**
 * #310 — Discovery types that are intentionally review-only and must NEVER be
 * auto-promoted into the action-candidate / next_actions queue, regardless of
 * actionable level, occurrence_count, or proposed_actions. Phase 0 proactive
 * memory candidates stay quiet unless the user explicitly reads them via
 * read_discoveries({ typeFilter: "proactive_connection" }).
 */
const QUIET_DISCOVERY_TYPES = new Set(["proactive_connection"]);

const SUPPORTED_ACTION_DISCOVERY_TYPES: ReadonlySet<string> = new Set([
  "bridge",
  "trend",
  "gap",
  "contradiction",
  "knowledge_map_isolation",
  "knowledge_map_bridge",
  "similar_entity",
  "community_crossing",
  "structural_hole",
]);

interface DiscoveryActionDisplay {
  title: string;
  reason: string;
  suggestion: string;
}

function buildDiscoveryActionDisplay(type: string, recurring: boolean): DiscoveryActionDisplay | null {
  if (!SUPPORTED_ACTION_DISCOVERY_TYPES.has(type)) return null;
  const reason = recurring
    ? "同类信号已经多次出现，值得优先核对。"
    : "这项信号的重要程度较高，但仍需人工核对。";
  let display: DiscoveryActionDisplay;
  switch (type) {
    case "bridge":
      display = {
        title: "有一组潜在关联待筛选",
        reason,
        suggestion: "可先查看最多 3 条当前高优先级关联线索并核对依据；展示后请你确认补链或忽略，确认前不修改。",
      };
      break;
    case "trend":
      display = {
        title: "有一组关注变化待核对",
        reason,
        suggestion: "可先查看最多 3 条当前高优先级变化并核对近期记录；展示后请你确认更新或忽略，确认前不修改。",
      };
      break;
    case "gap":
      display = {
        title: "有一组记忆内容待补全",
        reason,
        suggestion: "可先查看最多 3 条当前高优先级待补全项并核对已有内容；展示后请你确认先补充哪一项，确认前不修改。",
      };
      break;
    case "contradiction":
      display = {
        title: "有一组信息冲突待核对",
        reason,
        suggestion: "可先查看最多 3 条当前高优先级冲突并核对来源；展示后请你确认保留哪个有证据的版本，确认前不修改。",
      };
      break;
    case "knowledge_map_isolation":
      display = {
        title: "有一组孤立记忆待确认",
        reason,
        suggestion: "可先查看最多 3 条当前高优先级孤立记忆并核对依据；展示后请你确认补充关联或保持不变，确认前不修改。",
      };
      break;
    case "knowledge_map_bridge":
      display = {
        title: "有一组跨领域连接待复核",
        reason,
        suggestion: "可先查看最多 3 条当前高优先级跨领域连接并核对依据；展示后请你确认保留或加强，确认前不修改。",
      };
      break;
    case "similar_entity":
      display = {
        title: "有一组可能重复项待核对",
        reason,
        suggestion: "可先查看最多 3 条当前高优先级重复候选并做只读比较；展示后请你确认合并或分别保留，确认前不修改。",
      };
      break;
    case "community_crossing":
      display = {
        title: "有一组跨主题线索待核对",
        reason,
        suggestion: "请先核对这组跨主题线索的证据；展示后请你确认记录或忽略，确认前不修改。",
      };
      break;
    case "structural_hole":
      display = {
        title: "有一组知识缺口线索待核对",
        reason,
        suggestion: "请先核对这组知识缺口线索的证据；展示后请你确认补充或忽略，确认前不修改。",
      };
      break;
    default:
      return null;
  }
  assertSafeActionDisplay(display.title);
  assertSafeActionDisplay(display.reason);
  assertSafeActionDisplay(display.suggestion);
  return display;
}

function safeSourceOccurrenceCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 1
    ? value
    : 1;
}

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

function reviewDiscoveryDraft(row: DiscoveryCandidateSource): ActionCandidateDraft | null {
  const ref = stableDiscoveryRef(row);
  const occurrenceCount = safeSourceOccurrenceCount(row.occurrence_count);
  const metadata = parseJsonObject(row.metadata);
  const display = buildDiscoveryActionDisplay(row.type, occurrenceCount >= 3);
  if (!display) return null;

  return {
    type: "action_review_discovery",
    entities: [ref],
    score: Math.max(0.1, Math.min(1, row.score)),
    actionable: safeActionable(row.actionable),
    displayTitle: display.title,
    displayReason: display.reason,
    suggestedAction: display.suggestion,
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
      source_occurrence_count: occurrenceCount,
      detected_at: row.detected_at,
      last_detected_at: row.last_detected_at ?? null,
      evidence: [{ source: "discovery", ref, kind: row.type }],
      source_metadata: metadata,
    },
  };
}

export function buildActionCandidatesFromDiscoveries(rows: DiscoveryCandidateSource[]): ActionCandidateDraft[] {
  const drafts: ActionCandidateDraft[] = [];
  for (const row of rows) {
    if (isActionCandidateType(row.type)) continue;
    if (QUIET_DISCOVERY_TYPES.has(row.type)) continue;
    if (row.auto_applicable === 1) continue;
    const occurrenceCount = row.occurrence_count ?? 1;
    const hasProposedActions = typeof row.proposed_actions === "string" && row.proposed_actions.trim().length > 0;
    const shouldPromote =
      row.actionable === "high" ||
      occurrenceCount >= 3 ||
      hasProposedActions ||
      HIGH_VALUE_DISCOVERY_TYPES.has(row.type);
    if (!shouldPromote) continue;
    const draft = reviewDiscoveryDraft(row);
    if (draft) drafts.push(draft);
  }
  return drafts;
}

function healthStableRef(action: RepairAction): string {
  const scope = action.code ?? (action.slug && action.slug !== "-" ? action.slug : "global");
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
 * Treat persisted display text as UNTRUSTED. display_title/reason/suggested_action in
 * discovery metadata were written by a past run_action_candidates, but the row is mutable
 * storage — a corrupted/migrated/third-party-updated row could carry hostile text (slugs,
 * paths, scores, SQL). Validate via assertSafeActionDisplay; on failure fall back to fixed
 * copy rather than echoing the raw value. #309 review fix.
 */
function safeDisplayText(text: unknown, fallback: string): string {
  const s = typeof text === "string" && text.trim().length > 0 ? text : fallback;
  try {
    assertSafeActionDisplay(s);
    return s;
  } catch {
    return fallback;
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
  const sourceType = source === "discovery" && typeof meta.source_type === "string" ? meta.source_type : "";
  const sourceOccurrenceCount = safeSourceOccurrenceCount(meta.source_occurrence_count);
  const discoveryDisplay = source === "discovery"
    ? buildDiscoveryActionDisplay(sourceType, sourceOccurrenceCount >= 3)
    : null;
  if (source === "discovery" && !discoveryDisplay) return null;
  const evidence: ActionEvidenceRef[] = Array.isArray(meta.evidence) ? meta.evidence as ActionEvidenceRef[] : [];
  return {
    type: row.type,
    entities: parseJsonArray(row.entities),
    score: row.score,
    actionable: safeActionable(row.actionable),
    displayTitle: discoveryDisplay?.title ?? safeDisplayText(meta.display_title, "有一项候选需要确认"),
    displayReason: discoveryDisplay?.reason ?? safeDisplayText(meta.display_reason, "这项信号需要人工复核后再处理。"),
    suggestedAction: discoveryDisplay?.suggestion ?? safeDisplayText(meta.suggested_action, "确认后再决定处理或忽略。"),
    evidence,
    proposedActions: parseActions(row.proposed_actions),
    metadata: {
      source,
      repair_group: row.type === "action_repair_preview" ? "auto_repairable" : "needs_review",
      source_type: source === "discovery" ? sourceType : undefined,
      dimension: source === "health" ? String(meta.dimension ?? "dim") : undefined,
      repair_kind: source === "health" ? ((meta.repair_kind as string | null | undefined) ?? null) : undefined,
      detected_at: row.detected_at,
      last_detected_at: row.last_detected_at ?? null,
      occurrence_count: source === "discovery" ? sourceOccurrenceCount : row.occurrence_count,
      source_occurrence_count: source === "discovery" ? sourceOccurrenceCount : undefined,
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

import type { CBrainDB } from "../../storage/sqlite.js";
import type { RepairAction, RepairPlan } from "./health-debt.js";

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

const DISPLAY_UNSAFE_PATTERNS = [
  /\bscore\b/i,
  /\bdedup_key\b/i,
  /\bdebug\b/i,
  /\bmetadata\b/i,
  /\bsql\b/i,
  /\bselect\s+\*\s+from\b/i,
  /\bentity\/[^\s]+/i,
  /\bconcept\/[^\s]+/i,
  /\brecords?\//i,
  /\/Users\//,
  /[A-Z]:\\/,
];

export function assertSafeActionDisplay(text: string): void {
  for (const pattern of DISPLAY_UNSAFE_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error(`unsafe display text for action candidate: ${pattern}`);
    }
  }
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

export function buildActionCandidatesFromHealthPlan(_plan: RepairPlan): ActionCandidateDraft[] {
  return [];
}

export class ActionCandidateManager {
  constructor(private readonly db: CBrainDB) {}

  persistDrafts(_drafts: ActionCandidateDraft[]): ActionCandidateReport {
    return {
      total: 0,
      inserted: 0,
      updated: 0,
      byType: {
        action_review_discovery: 0,
        action_health_review: 0,
        action_repair_preview: 0,
      },
      candidates: [],
    };
  }
}

export type { RepairAction };

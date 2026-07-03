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

export function buildActionCandidatesFromDiscoveries(_rows: DiscoveryCandidateSource[]): ActionCandidateDraft[] {
  return [];
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

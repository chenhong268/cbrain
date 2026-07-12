import type { TrustState } from "../provenance.js";

export type LifecycleStatus = "pending" | "current" | "superseded" | "rejected" | "invalidated";
export type FreshnessStatus = "fresh" | "stale" | "version_invalid";
export type AbstainReason = "insufficient_evidence" | "conflict" | "inactive_evidence_only" | "below_threshold" | "policy_prohibits";
export type HighImpactReason = "write_action" | "open_question_deep_reasoning" | "irreversible_real_world" | "high_value_entity";
export type ConfirmationRequirement =
  | { tier: "standard" }
  | { tier: "high_impact"; confirm: ("target" | "option" | "constraint")[]; reason: HighImpactReason };
export type ActionType = "review" | "dry_run" | "notify_draft";
export type EvidenceSource = "discovery" | "health" | "fsck" | "graph" | "timeline";

export interface ProposedAction {
  type: ActionType;
  target_ref: string;
  reason: string;
  rollback_note?: string;
}

export type RecommendationConclusion =
  | { kind: "propose"; action: ProposedAction; alternatives: ProposedAction[] }
  | { kind: "abstain"; reason: AbstainReason };

export interface DependencyDeclaration {
  slug?: string;
  table: "links" | "pages" | "tags" | "aliases" | "timeline" | "chunks" | "fts" | "lance" | "config";
  as: string;
  relation?: string;
  direction?: "outgoing" | "incoming";
  fields: string[];
  filter?: "active" | "all";
}

export interface DependencyManifest {
  rule_id: string;
  declarations: DependencyDeclaration[];
}

export interface EntityProjection {
  [as: string]: unknown;
}

export interface DecisionInputs {
  signals: Record<string, unknown>;
  inspected_claims?: string[];
  entity_snapshot: Record<string, EntityProjection>;
  evidence_refs: string[];
}

export interface EvidenceManifestEntry {
  source: EvidenceSource;
  ref: string;
  trust_state: TrustState;
}

export interface RecommendationConstraints {
  policy_version: string;
  ontology_version: string;
  schema_version: string;
}

export interface Applicability {
  audience: "user_only";
  auto_execute: false;
  requires_confirmation: ConfirmationRequirement;
}

export interface RecommendationProducer {
  rule_id: string;
  rule_version: string;
  code_hash: string;
  registry_ref: string;
}

export interface RecommendationImmutablePayload {
  namespace: string;
  maintenance_key: string;
  inputs_hash: string;
  conclusion: RecommendationConclusion;
  decision_inputs: DecisionInputs;
  evidence_manifest: EvidenceManifestEntry[];
  constraints: RecommendationConstraints;
  dependency_manifest: DependencyManifest;
  applicability: Applicability;
  risks: string[];
  gaps: string[];
  producer: RecommendationProducer;
}

export interface RecommendationRecord {
  record_id: string;
  payload: RecommendationImmutablePayload;
  fingerprint: string;
  created_at: string;
  last_revalidated_at: string;
  lifecycle_status: LifecycleStatus;
  freshness_status: FreshnessStatus;
  suppressed_until: string | null;
}

export const SCHEMA_VERSION = "rec-v1" as const;

/**
 * A rule is the full declarative behavior + input source (rev7 HIGH 1/M2).
 * `code_hash` (rule-runtime) covers the BEHAVIOR subset only — rule_id/version/registry_ref
 * are identity and excluded. readTemplate drives both projection (Task 9) and the generic runner.
 */
export interface RuleDefinition {
  rule_id: string;
  rule_version: string;
  registry_ref: string;
  readTemplate: { table: "links"; as: string; relation: string; direction: "outgoing" | "incoming"; fields: string[]; filter: "active" | "all" };
  candidateTrustState: "candidate";
  evidenceSource: EvidenceSource;
  evidenceRefTemplate: string;
  abstainReason: AbstainReason;
  propose: { type: ActionType; targetTemplate: string; reason: string };
}

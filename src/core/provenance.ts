// ─── DB Access Interface ─────────────────────────────────────

export interface ProvenanceStore {
  getLinkProvenanceRow(id: number): Record<string, unknown> | undefined;
  getTimelineProvenanceRow(id: number): Record<string, unknown> | undefined;
  updateTrustState(targetType: "link" | "timeline", id: number, newState: string): boolean;
  insertProvenanceHistory(targetType: string, targetId: number, oldState: string, newState: string, sourceCategory: string, reason: string | null): void;
  getProvenanceHistory(targetType: string, targetId: number): Array<{ id: number; old_trust_state: string; new_trust_state: string; source_category: string; reason: string | null; created_at: string }>;
}

// ─── Types ──────────────────────────────────────────────────

export type SourceCategory =
  | "explicit_input"
  | "imported_content"
  | "dialogue_extraction"
  | "agent_inference"
  | "user_confirmation"
  | "correction";

export type TrustState =
  | "trusted"
  | "user_thought"
  | "candidate"
  | "rejected"
  | "superseded";

export interface ProvenanceEnvelope {
  source_type: string;
  source_category: SourceCategory;
  source_page_slug?: string;
  evidence?: string;
  confidence: number;
  trust_state: TrustState;
  created_at: string;
}

export interface ProvenanceItem {
  target_type: "link" | "timeline";
  target_id: number;
  provenance: ProvenanceEnvelope;
}

export interface ProvenanceHistoryEntry {
  id: number;
  old_trust_state: string;
  new_trust_state: string;
  source_category: string;
  reason: string | null;
  created_at: string;
}

export interface ProvenanceInput {
  source_page_slug?: string;
  evidence?: string;
}

// ─── Helpers ────────────────────────────────────────────────

const SOURCE_TYPE_MAP: Record<string, { category: SourceCategory; trust: TrustState }> = {
  wikilink: { category: "imported_content", trust: "trusted" },
  manual: { category: "explicit_input", trust: "trusted" },
  agent: { category: "agent_inference", trust: "candidate" },
  "bidir-fix": { category: "agent_inference", trust: "candidate" },
  ner: { category: "agent_inference", trust: "candidate" },
  dialogue: { category: "dialogue_extraction", trust: "candidate" },
  writeback: { category: "agent_inference", trust: "candidate" },
  unknown: { category: "agent_inference", trust: "candidate" },
};

export function mapSourceType(sourceType: string | undefined): SourceCategory {
  return SOURCE_TYPE_MAP[sourceType ?? "unknown"]?.category ?? "agent_inference";
}

export function deriveTrustState(sourceType: string | undefined, confidence?: number): TrustState {
  const entry = SOURCE_TYPE_MAP[sourceType ?? "unknown"];
  if (!entry) return "candidate";
  if (confidence !== undefined && confidence < 0.3) return "candidate";
  return entry.trust;
}

// ─── ProvenanceManager ──────────────────────────────────────

export class ProvenanceManager {
  private store: ProvenanceStore;

  constructor(store: ProvenanceStore) {
    this.store = store;
  }

  getLinkProvenance(linkId: number): ProvenanceItem | null {
    const row = this.store.getLinkProvenanceRow(linkId);
    if (!row) return null;
    return {
      target_type: "link",
      target_id: linkId,
      provenance: this.rowToEnvelope(row),
    };
  }

  getTimelineProvenance(entryId: number): ProvenanceItem | null {
    const row = this.store.getTimelineProvenanceRow(entryId);
    if (!row) return null;
    return {
      target_type: "timeline",
      target_id: entryId,
      provenance: this.rowToEnvelope({
        ...row,
        confidence: 0.5,
        source_type: row.source_type ?? "unknown",
      }),
    };
  }

  setTrustState(
    targetType: "link" | "timeline",
    targetId: number,
    newState: TrustState,
    sourceCategory: SourceCategory,
    reason?: string,
  ): boolean {
    const table = targetType;
    const row = targetType === "link"
      ? this.store.getLinkProvenanceRow(targetId)
      : this.store.getTimelineProvenanceRow(targetId);
    if (!row) return false;

    const oldState = (row.trust_state as string) ?? "candidate";
    this.store.updateTrustState(table, targetId, newState);
    this.store.insertProvenanceHistory(targetType, targetId, oldState, newState, sourceCategory, reason ?? null);
    return true;
  }

  getCorrectionHistory(targetType: "link" | "timeline", targetId: number): ProvenanceHistoryEntry[] {
    return this.store.getProvenanceHistory(targetType, targetId);
  }

  private rowToEnvelope(row: Record<string, unknown>): ProvenanceEnvelope {
    const sourceType = row.source_type as string ?? "unknown";
    return {
      source_type: sourceType,
      source_category: mapSourceType(sourceType),
      source_page_slug: (row.source_page_slug as string) ?? undefined,
      evidence: (row.evidence as string) ?? undefined,
      confidence: (row.confidence as number) ?? 0.5,
      trust_state: (row.trust_state as TrustState) ?? "candidate",
      created_at: (row.created_at as string) ?? new Date().toISOString(),
    };
  }
}

import { createHash } from "node:crypto";
import type {
  CBrainDB,
  CandidateRow,
  CandidateType,
  CandidateStatus,
  FeedbackAction,
  CandidateFeedbackRow,
} from "../../storage/sqlite.js";

export type { CandidateRow, CandidateType, CandidateStatus, FeedbackAction, CandidateFeedbackRow };

// ─── Gate Constants ──────────────────────────────────────────────

export const GATE = {
  evidence: 3,
  persistence: 2,
  novelty: 0.5,
  action_value: 0.5,
  trust_risk: 0.3,
} as const;

export type GateDimension = keyof typeof GATE;

// ─── Review Output Types ─────────────────────────────────────────

export interface ReviewItem {
  id: number;
  title: string;
  candidate_type: CandidateType;
  summary: string | null;
}

export interface EvidenceItem {
  candidate_id: number;
  items: Array<{ source: string; dateRange: string; text: string }>;
}

export interface ScoreReport {
  candidate_id: number;
  scores: Record<string, number>;
  passed: boolean;
  failed_dimensions: GateDimension[];
}

export interface ActionItem {
  candidate_id: number;
  available: ("accept" | "reject" | "defer" | "disable")[];
}

export interface CompoundingReviewOutput {
  items: ReviewItem[];
  evidence: EvidenceItem[];
  scores: ScoreReport[];
  actions: ActionItem[];
  silence_reason?: string;
}

export interface UpsertCandidateInput {
  title: string;
  candidateType: CandidateType;
  summary?: string;
  evidence?: Array<{ source: string; dateRange: string; text: string }>;
  scores?: Record<string, number>;
  sourceSlugs: string[];
}

export interface CandidateFilters {
  status?: CandidateStatus;
  includeDeferred?: boolean;
  limit?: number;
  offset?: number;
}

const ACTION_TO_STATUS: Record<FeedbackAction, CandidateStatus> = {
  accept: "accepted",
  reject: "rejected",
  defer: "deferred",
  disable: "disabled",
  superseded: "superseded",
  reactivate: "pending",
};

function computeContentHash(title: string, candidateType: CandidateType, sourceSlugs: string[]): string {
  const payload = candidateType + "|" + title + "|" + [...sourceSlugs].sort().join(",");
  return createHash("sha256").update(payload).digest("hex");
}

export class CompoundingReviewManager {
  private db: CBrainDB;

  constructor(db: CBrainDB) {
    this.db = db;
  }

  upsertCandidate(input: UpsertCandidateInput): { id: number; isNew: boolean } {
    const displayTitle = input.title.slice(0, 30);
    const contentHash = computeContentHash(input.title, input.candidateType, input.sourceSlugs);

    return this.db.upsertCandidate(displayTitle, input.candidateType, contentHash, {
      summary: input.summary,
      evidenceJson: input.evidence ? JSON.stringify(input.evidence) : undefined,
      scoresJson: input.scores ? JSON.stringify(input.scores) : undefined,
      sourceSlugsJson: JSON.stringify(input.sourceSlugs),
    });
  }

  listCandidates(filters?: CandidateFilters): CandidateRow[] {
    return this.db.listCandidates(filters);
  }

  getCandidate(id: number): CandidateRow | null {
    return this.db.getCandidate(id);
  }

  transitionStatus(id: number, action: FeedbackAction, note?: string): boolean {
    const newStatus = ACTION_TO_STATUS[action];
    let updated = false;
    this.db.transaction(() => {
      const changed = this.db.updateCandidateStatus(id, newStatus);
      if (changed) {
        this.db.insertReviewFeedback(id, action, note);
        updated = true;
      }
    });
    return updated;
  }

  getFeedback(candidateId: number): CandidateFeedbackRow[] {
    return this.db.getReviewFeedback(candidateId);
  }

  count(status?: CandidateStatus): number {
    return this.db.countReviewCandidates(status);
  }
}

// ─── Output Compacting ──────────────────────────────────────────

const MAX_OUTPUT_ITEMS = 3;
const MAX_EVIDENCE_ITEMS = 3;
const MAX_TEXT_LEN = 160;
const MAX_SUMMARY_LEN = 160;

function compactText(text: string, maxLen = MAX_TEXT_LEN): string {
  return text.length <= maxLen ? text : text.slice(0, maxLen) + "…";
}

interface RawEvidenceItem {
  source?: string;
  dateRange?: string;
  text?: string;
  [key: string]: unknown;
}

function compactEvidence(raw: RawEvidenceItem[]): Array<{ source: string; dateRange: string; text: string }> {
  return raw.slice(0, MAX_EVIDENCE_ITEMS).map((e) => ({
    source: String(e.source ?? ""),
    dateRange: String(e.dateRange ?? ""),
    text: compactText(String(e.text ?? "")),
  }));
}

function safeParseEvidence(json: string | null): RawEvidenceItem[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeParseScores(json: string | null): Record<string, number> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function clampLimit(value: number | undefined, min: number, max: number, def: number): number {
  if (value === undefined) return def;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

// ─── Social Detection ────────────────────────────────────────────

const SOCIAL_KEYWORDS = ["关系", "联系", "合作", "认识", "朋友", "同事", "社交"];

export function isSocialCandidate(candidate: CandidateRow): boolean {
  const evidence = safeParseEvidence(candidate.evidence_json);
  return evidence.some((e) => {
    const t = e.text;
    return typeof t === "string" && SOCIAL_KEYWORDS.some((kw) => t.includes(kw));
  });
}

// ─── Review Generator ────────────────────────────────────────────

const ALL_DIMENSIONS: GateDimension[] = ["evidence", "persistence", "novelty", "action_value", "trust_risk"];
const STANDARD_ACTIONS: ("accept" | "reject" | "defer" | "disable")[] = ["accept", "reject", "defer", "disable"];

export interface GenerateOptions {
  includeDeferred?: boolean;
  limit?: number;
  maxOutput?: number;
}

export class ReviewGenerator {
  private manager: CompoundingReviewManager;

  constructor(manager: CompoundingReviewManager) {
    this.manager = manager;
  }

  generate(opts?: GenerateOptions): CompoundingReviewOutput {
    const scanLimit = clampLimit(opts?.limit, 1, 50, 20);
    const maxOutput = clampLimit(opts?.maxOutput, 1, 10, MAX_OUTPUT_ITEMS);

    const candidates = this.manager.listCandidates({
      includeDeferred: opts?.includeDeferred ?? false,
      limit: scanLimit,
    });

    const allFailed = new Map<number, GateDimension[]>();
    const passed: CandidateRow[] = [];

    for (const c of candidates) {
      const failures = this.evaluateGates(c);
      if (failures.length === 0) {
        passed.push(c);
      } else {
        allFailed.set(c.id, failures);
      }
    }

    if (passed.length === 0) {
      return {
        items: [],
        evidence: [],
        scores: [],
        actions: [],
        silence_reason: this.buildSilenceReason(candidates, allFailed),
      };
    }

    const selected = passed.slice(0, maxOutput);

    return {
      items: selected.map((c) => ({
        id: c.id,
        title: c.title,
        candidate_type: c.candidate_type,
        summary: c.summary ? compactText(c.summary, MAX_SUMMARY_LEN) : null,
      })),
      evidence: selected.map((c) => ({
        candidate_id: c.id,
        items: compactEvidence(safeParseEvidence(c.evidence_json)),
      })),
      scores: selected.map((c) => ({
        candidate_id: c.id,
        scores: safeParseScores(c.scores_json),
        passed: true,
        failed_dimensions: [],
      })),
      actions: selected.map((c) => ({
        candidate_id: c.id,
        available: [...STANDARD_ACTIONS],
      })),
    };
  }

  private evaluateGates(candidate: CandidateRow): GateDimension[] {
    const scores = safeParseScores(candidate.scores_json);
    if (Object.keys(scores).length === 0 && candidate.scores_json) {
      // malformed JSON → all dimensions fail
      return [...ALL_DIMENSIONS];
    }
    if (!candidate.scores_json) return [...ALL_DIMENSIONS];
    const failed: GateDimension[] = [];

    if ((scores.evidence ?? 0) < GATE.evidence) failed.push("evidence");
    if ((scores.persistence ?? 0) < GATE.persistence) failed.push("persistence");
    if ((scores.novelty ?? 0) < GATE.novelty) failed.push("novelty");
    if ((scores.action_value ?? 0) < GATE.action_value) failed.push("action_value");
    if ((scores.trust_risk ?? 1) > GATE.trust_risk) failed.push("trust_risk");

    return failed;
  }

  private buildSilenceReason(candidates: CandidateRow[], allFailed: Map<number, GateDimension[]>): string {
    if (candidates.length === 0) return "no_pending_candidates";

    const counts = new Map<GateDimension, number>();
    for (const dims of allFailed.values()) {
      for (const d of dims) {
        counts.set(d, (counts.get(d) ?? 0) + 1);
      }
    }

    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    return top ? `${top[0]}_insufficient` : "all_candidates_filtered";
  }
}

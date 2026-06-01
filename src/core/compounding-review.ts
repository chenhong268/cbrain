import { createHash } from "node:crypto";
import type {
  CBrainDB,
  CandidateRow,
  CandidateType,
  CandidateStatus,
  FeedbackAction,
  CandidateFeedbackRow,
} from "../storage/sqlite.js";

export type { CandidateRow, CandidateType, CandidateStatus, FeedbackAction, CandidateFeedbackRow };

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

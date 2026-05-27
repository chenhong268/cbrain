import type { EvidenceBoardResult, EvidenceItem } from "./evidence.js";

// ─── Types ────────────────────────────────────────────────────

export type Confidence = "high" | "medium" | "low";

export interface SourceRef {
  claim: string;
  source_slug: string;
}

export interface ConflictRef {
  claim: string;
  source_slugs: string[];
}

export interface GroundedAnswerResult {
  answer: string;
  confidence: Confidence;
  facts_used: SourceRef[];
  thoughts_used: SourceRef[];
  unresolved: string[];
  conflicts: ConflictRef[];
}

// ─── Internal helpers ─────────────────────────────────────────

const INSUFFICIENT_ANSWER = "目前没有足够的记录来回答这个问题。";

function itemToSourceRef(item: EvidenceItem): SourceRef {
  return { claim: item.claim, source_slug: item.source_slug };
}

function computeConfidence(board: EvidenceBoardResult): Confidence {
  const hasFacts = board.facts.length > 0;
  const hasThoughts = board.user_thoughts.length > 0;
  const hasUnresolved = board.gaps.length > 0;
  const hasConflicts = board.conflicts.length > 0;

  if (hasFacts && !hasConflicts && !hasUnresolved) return "high";
  if (hasFacts && (hasConflicts || hasUnresolved)) return "medium";
  if (!hasFacts && hasThoughts) return "medium";
  return "low";
}

function boardConflictsToRefs(board: EvidenceBoardResult): ConflictRef[] {
  return board.conflicts.map((c) => ({
    claim: c.claim,
    source_slugs: c.evidence.map((e) => e.source_slug),
  }));
}

// ─── GroundedAnswerer ─────────────────────────────────────────

export class GroundedAnswerer {
  synthesize(_question: string, board: EvidenceBoardResult): GroundedAnswerResult {
    const parts: string[] = [];

    const conflictedKeys = new Set<string>();
    for (const conflict of board.conflicts) {
      for (const e of conflict.evidence) {
        conflictedKeys.add(`${e.claim}\0${e.source_slug}`);
      }
    }

    for (const f of board.facts) {
      if (!conflictedKeys.has(`${f.claim}\0${f.source_slug}`)) {
        parts.push(`根据记录：${f.claim}。`);
      }
    }

    for (const t of board.user_thoughts) {
      if (!conflictedKeys.has(`${t.claim}\0${t.source_slug}`)) {
        parts.push(`你之前提到：${t.claim}。`);
      }
    }

    const factClaims = new Set(board.facts.map((f) => f.claim));
    const gapClaims = new Set(board.gaps);
    for (const c of board.candidates) {
      if (
        !conflictedKeys.has(`${c.claim}\0${c.source_slug}`) &&
        gapClaims.has(c.claim) &&
        !factClaims.has(c.claim)
      ) {
        parts.push(`尚待确认：${c.claim}。`);
      }
    }

    for (const conflict of board.conflicts) {
      const sides = conflict.evidence.map((e) => e.claim).join("；");
      parts.push(`关于「${conflict.claim}」存在矛盾信息：${sides}。`);
    }

    const answer = parts.length > 0 ? parts.join("") : INSUFFICIENT_ANSWER;

    return {
      answer,
      confidence: computeConfidence(board),
      facts_used: board.facts.map(itemToSourceRef),
      thoughts_used: board.user_thoughts.map(itemToSourceRef),
      unresolved: board.gaps,
      conflicts: boardConflictsToRefs(board),
    };
  }
}

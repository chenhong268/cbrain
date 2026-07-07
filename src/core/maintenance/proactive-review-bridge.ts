// proactive-review-bridge — the deliberate opt-in promotion path that connects
// the quiet proactive_connection discovery lane (#310/#311) into the existing
// Compounding Review system. This is the ONLY module that bridges the two; it
// lives under core/maintenance/ alongside the producer and the review manager.
//
// Boundaries (spec docs/superpowers/specs/2026-07-07-proactive-review-bridge-design.md):
// - promotion runs ONLY via get_compounding_reviews (refreshProactive, default true);
// - default recall/search/ingest/run_discovery/read_discoveries/next_actions stay quiet;
// - no page/link/alias writes; the only new write is upsertCandidate + best-effort
//   updateDiscoveryStatus on review action;
// - display is anonymous (fixed title + count-templated summary + labeled evidence);
// - no schema migration.

import { sanitizeDisplayText } from "../safety/display-safety.js";

export const PROACTIVE_DISCOVERY_TYPE = "proactive_connection";
export const PROACTIVE_CANDIDATE_TYPE = "supported_connection" as const;
export const PROACTIVE_REVIEW_TITLE = "潜在连接候选";
export const REVIEW_ACTION_VALUE = 0.5;
export const PROMOTION_LIMIT = 20;
// Larger than getDiscoveryLifecycleIndex's default (500) so an older source
// discovery is not silently missed by the act-time reverse lookup.
export const LIFECYCLE_LOOKUP_LIMIT = 5000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * D4 — map #311 proactive scoring into the 5 compounding-review gates.
 * Returns null on any malformed/missing field so the adapter skips fail-closed.
 *
 * persistence is the tightness lever: requires recurrence (occurrence≥2) OR
 * dual corroboration (timeline + co-occurrence both present). A one-shot
 * detection without dual corroboration fails persistence and is not promoted.
 *
 * evidence is an honest count (sharedNeighbors + supporting signals), not a
 * rescale, so it cannot weaken the global ≥3 gate.
 */
export function mapProactiveToReviewScores(
  metadata: unknown,
  occurrenceCount: number,
): Record<string, number> | null {
  if (!isRecord(metadata)) return null;
  const { signals, scoring, evidence } = metadata;
  if (!isRecord(signals) || !isRecord(scoring) || !isRecord(evidence)) return null;

  const sharedNeighbors = asNum(signals.shared_neighbors);
  const cooccurring = asNum(signals.cooccurring_sessions);
  if (sharedNeighbors === null || cooccurring === null) return null;

  const novelty = asNum(scoring.novelty);
  const risk = asNum(scoring.risk);
  if (novelty === null || risk === null) return null;

  const timelineRefs = Array.isArray(evidence.timeline_event_refs) ? evidence.timeline_event_refs : [];
  const hasTimeline = timelineRefs.length >= 1;
  const hasCooccur = cooccurring >= 1;
  const supporting = (hasCooccur ? 1 : 0) + (hasTimeline ? 1 : 0);

  const evidenceScore = sharedNeighbors + supporting; // gate ≥3
  const dualCorroboration = hasTimeline && hasCooccur;
  const occ = Math.min(Math.max(Math.floor(occurrenceCount), 0), 2);
  const persistence = occ + (dualCorroboration ? 1 : 0); // gate ≥2

  return {
    evidence: evidenceScore,
    persistence,
    novelty,
    action_value: REVIEW_ACTION_VALUE,
    trust_risk: risk,
  };
}

export interface ReviewCandidateDisplay {
  title: string;
  summary: string;
  evidence: Array<{ source: string; dateRange: string; text: string }>;
}

/**
 * D5 — build anonymous, review-safe display text.
 *
 * - title is a fixed constant so computeContentHash depends only on the entity
 *   pair (stable across page-title edits → idempotent promotion).
 * - summary is count-templated (aggregate numbers only — not PII).
 * - evidence uses fixed sanitized labels + count text. The ONLY external string
 *   is eventDate, which is run through sanitizeDisplayText.
 *
 * Raw slugs / event ids / session refs / scoring never reach display. Returns
 * null on malformed metadata so the adapter skips fail-closed.
 */
export function buildReviewCandidateDisplay(metadata: unknown): ReviewCandidateDisplay | null {
  if (!isRecord(metadata)) return null;
  const { signals, evidence } = metadata;
  if (!isRecord(signals) || !isRecord(evidence)) return null;

  const sharedNeighbors = asNum(signals.shared_neighbors);
  const cooccurring = asNum(signals.cooccurring_sessions);
  if (sharedNeighbors === null || cooccurring === null) return null;

  const timelineRefs = Array.isArray(evidence.timeline_event_refs) ? evidence.timeline_event_refs : [];

  const summary = `两条记忆通过 ${sharedNeighbors} 个共同邻居与 ${cooccurring} 次共现形成连接，值得复盘是否建立显式关联。`;

  const items: Array<{ source: string; dateRange: string; text: string }> = [
    { source: "共同上下文", dateRange: "", text: `${sharedNeighbors} 个共同连接的条目` },
  ];
  if (cooccurring >= 1) {
    items.push({ source: "共现会话", dateRange: "", text: `${cooccurring} 次共同出现` });
  }
  if (timelineRefs.length >= 1) {
    const first = timelineRefs.find(isRecord);
    const raw = first ? (typeof first.eventDate === "string" ? first.eventDate : "") : "";
    items.push({
      source: "时间线邻近",
      dateRange: sanitizeDisplayText(raw, ""),
      text: "存在时间线上的邻近事件",
    });
  }

  return { title: PROACTIVE_REVIEW_TITLE, summary, evidence: items.slice(0, 3) };
}

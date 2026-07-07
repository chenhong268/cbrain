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
import type { CBrainDB, CandidateRow, FeedbackAction } from "../../storage/sqlite.js";
import { GATE, type CompoundingReviewManager } from "./compounding-review.js";

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

export interface PromotionResult {
  promoted: number;
  skipped: number;
  seen: number;
}

function qualityOf(meta: unknown): number {
  if (!isRecord(meta) || !isRecord(meta.scoring)) return 0;
  return asNum((meta.scoring as Record<string, unknown>).quality) ?? 0;
}

/**
 * D4 gate precheck — mirrors ReviewGenerator.evaluateGates at write time so weak
 * candidates never enter the candidate table (acceptance #2: "weak not promoted").
 * trust_risk is a "lower is better" dimension (gate is an upper bound), inverted
 * vs the others. Imports GATE so thresholds stay a single source of truth.
 */
export function passesReviewGate(scores: Record<string, number>): boolean {
  return (
    (scores.evidence ?? 0) >= GATE.evidence &&
    (scores.persistence ?? 0) >= GATE.persistence &&
    (scores.novelty ?? 0) >= GATE.novelty &&
    (scores.action_value ?? 0) >= GATE.action_value &&
    (scores.trust_risk ?? 1) <= GATE.trust_risk
  );
}

/**
 * D1/D6 — read pending proactive discoveries, map scores + display, upsert as
 * supported_connection candidates. Idempotent via content_hash (fixed title +
 * sorted entity pair). Processes highest-quality first, capped at PROMOTION_LIMIT.
 *
 * Pre-loop filter is status==='pending' ONLY. All validity checks (malformed
 * metadata, gate fail, entities≠2) happen IN the loop so every skipped row is
 * counted — none vanish silently into a chain filter (HIGH #2). Weak candidates
 * fail the gate precheck and are skipped, never written (HIGH #1).
 */
export function promoteProactiveCandidatesToReview(
  db: CBrainDB,
  mgr: CompoundingReviewManager,
): PromotionResult {
  const rows = db.getDiscoveryLifecycleIndex(PROACTIVE_DISCOVERY_TYPE, LIFECYCLE_LOOKUP_LIMIT);

  const pending = rows
    .filter((r) => r.status === "pending")
    .map((r) => {
      let meta: unknown = null;
      try {
        meta = r.metadata ? JSON.parse(r.metadata) : null;
      } catch {
        meta = null;
      }
      return { r, meta, occ: r.occurrence_count };
    })
    .sort((a, b) => qualityOf(b.meta) - qualityOf(a.meta))
    .slice(0, PROMOTION_LIMIT);

  let promoted = 0;
  let skipped = 0;
  let seen = 0;
  for (const x of pending) {
    const scores = mapProactiveToReviewScores(x.meta, x.occ);
    const display = buildReviewCandidateDisplay(x.meta);
    if (!scores || !display) {
      skipped++; // malformed metadata → fail-closed
      continue;
    }
    if (!passesReviewGate(scores)) {
      skipped++; // weak → NOT written (HIGH #1, acceptance #2)
      continue;
    }
    let entities: unknown = [];
    try {
      entities = JSON.parse(x.r.entities);
    } catch {
      entities = [];
    }
    if (!Array.isArray(entities) || entities.length !== 2) {
      skipped++;
      continue;
    }
    const sourceSlugs = [...(entities as string[])].sort();

    const { isNew } = mgr.upsertCandidate({
      title: display.title,
      candidateType: PROACTIVE_CANDIDATE_TYPE,
      summary: display.summary,
      evidence: display.evidence,
      scores,
      sourceSlugs,
    });
    if (isNew) promoted++;
    else seen++;
  }

  return { promoted, skipped, seen };
}

export interface SyncResult {
  synced: boolean;
  reason: string;
}

/**
 * D8 — best-effort sync of the source proactive discovery lifecycle after a
 * successful review action. Called from the act_on_review_candidate MCP handler
 * AFTER transitionStatus has already committed the candidate status.
 *
 *   accept          → source discovery resolved
 *   reject / disable → source discovery dismissed
 *   defer           → no-op (source discovery stays pending; the deferred
 *                     candidate is excluded from default generate() output and
 *                     re-promotion is an idempotent timestamp bump, so defer
 *                     does not cause re-surfacing)
 *
 * Fail-open: any failure (source not found, malformed, throw) returns
 * {synced:false} and NEVER throws — the candidate status is authoritative.
 * Reverse-lookup uses LIFECYCLE_LOOKUP_LIMIT (>default 500) so an older source
 * discovery is not silently missed.
 */
export function syncProactiveDiscoveryOnReviewAction(
  db: CBrainDB,
  candidate: CandidateRow,
  action: FeedbackAction,
): SyncResult {
  if (candidate.candidate_type !== PROACTIVE_CANDIDATE_TYPE) {
    return { synced: false, reason: "not_proactive" };
  }
  let slugs: unknown = null;
  try {
    slugs = candidate.source_slugs_json ? JSON.parse(candidate.source_slugs_json) : null;
  } catch {
    slugs = null;
  }
  if (!Array.isArray(slugs) || slugs.length !== 2) {
    return { synced: false, reason: "no_pair" };
  }
  if (action === "defer") {
    return { synced: false, reason: "defer_no_op" };
  }

  let discoveryStatus: "resolved" | "dismissed";
  if (action === "accept") discoveryStatus = "resolved";
  else if (action === "reject" || action === "disable") discoveryStatus = "dismissed";
  else return { synced: false, reason: "action_unmapped" }; // superseded/reactivate not in MCP enum

  const pair = [...(slugs as string[])].sort();
  try {
    const rows = db.getDiscoveryLifecycleIndex(PROACTIVE_DISCOVERY_TYPE, LIFECYCLE_LOOKUP_LIMIT);
    const match = rows.find((r) => {
      let ents: unknown = [];
      try {
        ents = JSON.parse(r.entities);
      } catch {
        return false;
      }
      if (!Array.isArray(ents)) return false;
      const sorted = [...(ents as string[])].sort();
      return sorted.length === pair.length && sorted.every((v, i) => v === pair[i]);
    });
    if (!match) return { synced: false, reason: "source_not_found" };
    db.updateDiscoveryStatus(match.id, discoveryStatus);
    return { synced: true, reason: discoveryStatus };
  } catch {
    return { synced: false, reason: "error" };
  }
}

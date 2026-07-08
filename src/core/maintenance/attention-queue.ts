/**
 * Read-only unified attention queue / next-action surface. #309 / Slice 4 of #276.
 *
 * Takes the existing health-debt and discovery candidate draft streams (both already
 * classified by `planRepairs()` / discovery lifecycle) and produces a ranked, capped,
 * observe-only-hiding next-action list. Severity REUSES `RepairGroup` — this module
 * introduces no parallel taxonomy. It is a pure function: no DB, no writes, no
 * lifecycle transitions.
 *
 * Invariants:
 *   - severity is always a `RepairGroup` (blocked > auto_repairable > needs_review > observe_only).
 *   - discovery drafts always map to `needs_review`; never blocker / auto_repairable.
 *   - observe-only items never enter the default output; only `raw.observeOnlyItems`.
 *   - default cap is 3, hard ceiling; `cap` option cannot raise display output beyond 3.
 *   - no slug/path/score leakage: display-text fields come straight from sanitized
 *     drafts; internal refs live only on `sourceRefs` (raw/debug channel).
 */
import type { ActionCandidateDraft } from "./action-candidates.js";
import type { RepairGroup } from "./health-debt.js";

/** Freshness bucket assigned by the stale gate (#315). Pure, derived, never persisted. */
export type Freshness = "fresh" | "recurring" | "stale";

/** Issue #315 constants — named, not magic. */
export const FRESH_DAYS = 14;
export const RECURRING_MIN_OCCURRENCES = 3;

const MS_PER_DAY = 86_400_000;

/**
 * Parse a persisted discovery timestamp to epoch ms. SQLite `datetime('now')` emits
 * "YYYY-MM-DD HH:MM:SS" in UTC; normalize to ISO-UTC before parsing. Returns null for
 * missing/malformed input so callers fail OPEN (treat as fresh, never hide). #315
 */
export function parseDetectedAt(raw: string | null | undefined): number | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const iso = raw.includes("T") ? raw : `${raw.replace(" ", "T")}Z`;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

interface ClassifyFreshnessArgs {
  source: "health" | "discovery";
  severity: RepairGroup;
  detectedAt: string | null | undefined;
  lastDetectedAt: string | null | undefined;
  occurrenceCount: number | null | undefined;
  now: number;
}

/**
 * Pure freshness classification (#315).
 *   - health source is immune: structural health signals do not lose priority with age;
 *   - missing/malformed timestamp fails OPEN as fresh (never silently hidden);
 *   - discovery older than FRESH_DAYS with occurrence_count < RECURRING_MIN_OCCURRENCES is stale;
 *   - recurring (occurrence_count >= RECURRING_MIN_OCCURRENCES) stays eligible.
 * Effective timestamp is lastDetectedAt ?? detectedAt ("hasn't re-occurred recently").
 */
export function classifyFreshness(args: ClassifyFreshnessArgs): Freshness {
  if (args.source === "health") return "fresh";
  const ts = parseDetectedAt(args.lastDetectedAt) ?? parseDetectedAt(args.detectedAt);
  if (ts === null) return "fresh";
  const ageDays = (args.now - ts) / MS_PER_DAY;
  if (ageDays <= FRESH_DAYS) return "fresh";
  const occ = typeof args.occurrenceCount === "number" && args.occurrenceCount > 0 ? args.occurrenceCount : 0;
  return occ >= RECURRING_MIN_OCCURRENCES ? "recurring" : "stale";
}

/** Local next-action shape. severity reuses RepairGroup — no parallel taxonomy. */
export interface NextAction {
  severity: RepairGroup;
  source: "health" | "discovery";
  title: string;
  reason: string;
  suggestion: string;
  evidenceCount: number;
  groupKey: string;
  /** raw/debug only — stable refs, never reach default display */
  sourceRefs: string[];
  /** raw/debug + classification input — never reaches the public items[] surface (#315). */
  detectedAt?: string | null;
  lastDetectedAt?: string | null;
  occurrenceCount?: number;
  freshness?: Freshness;
}

export interface AttentionQueueSummary {
  totalInput: number;
  shownCount: number;
  hiddenObserveOnly: number;
  suppressedBeyondTop3: number;
}

export interface AttentionQueueRaw {
  observeOnlyItems: NextAction[];
  allItemsRanked: NextAction[];
}

export interface AttentionQueue {
  items: NextAction[];
  summary: AttentionQueueSummary;
  raw: AttentionQueueRaw | null;
}

export interface BuildAttentionQueueOptions {
  includeRaw?: boolean;
  /** Default 3; clamped to 3 — display output never exceeds 3. */
  cap?: number;
}

const DEFAULT_CAP = 3;

const SEVERITY_RANK: Record<RepairGroup, number> = {
  blocked: 0,
  auto_repairable: 1,
  needs_review: 2,
  observe_only: 3,
};

function draftSource(draft: ActionCandidateDraft): "health" | "discovery" {
  return draft.metadata.source === "health" ? "health" : "discovery";
}

/** Conservative: an unrecognized repair_group falls back to needs_review (never upgrades to blocker). */
function severityFromHealthMeta(meta: Record<string, unknown>): RepairGroup {
  const g = meta.repair_group;
  if (g === "blocked" || g === "auto_repairable" || g === "needs_review" || g === "observe_only") return g;
  return "needs_review";
}

function draftSeverity(draft: ActionCandidateDraft): RepairGroup {
  // Discovery never becomes a blocker (#309 invariant).
  return draftSource(draft) === "health" ? severityFromHealthMeta(draft.metadata) : "needs_review";
}

function healthGroupKey(draft: ActionCandidateDraft): string {
  const group = severityFromHealthMeta(draft.metadata);
  const dim = String(draft.metadata.dimension ?? "dim");
  const rawKind = draft.metadata.repair_kind;
  const kind = typeof rawKind === "string" && rawKind.length > 0 ? rawKind : group;
  return `health:${group}:${dim}:${kind}`;
}

function discoveryGroupKey(draft: ActionCandidateDraft): string {
  const t = String(draft.metadata.source_type ?? "discovery");
  return `discovery:${t}`;
}

function readMetaString(meta: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = meta[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function readMetaNumber(meta: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = meta[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

function toNextAction(draft: ActionCandidateDraft): NextAction {
  const source = draftSource(draft);
  const groupKey = source === "health" ? healthGroupKey(draft) : discoveryGroupKey(draft);
  const detectedAt = readMetaString(draft.metadata, "detected_at", "detectedAt");
  const lastDetectedAt = readMetaString(draft.metadata, "last_detected_at", "lastDetectedAt");
  const occurrenceCount = readMetaNumber(draft.metadata, "occurrence_count", "occurrenceCount");
  return {
    severity: draftSeverity(draft),
    source,
    title: draft.displayTitle,
    reason: draft.displayReason,
    suggestion: draft.suggestedAction,
    evidenceCount: 1,
    groupKey,
    sourceRefs: draft.entities.slice(),
    detectedAt,
    lastDetectedAt,
    occurrenceCount,
  };
}

function rankCompare(a: NextAction, b: NextAction): number {
  const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (s !== 0) return s;
  if (a.evidenceCount !== b.evidenceCount) return b.evidenceCount - a.evidenceCount;
  if (a.groupKey !== b.groupKey) return a.groupKey < b.groupKey ? -1 : 1;
  return 0;
}

/** Merge same-groupKey items: sum evidence, union sourceRefs. Stable first-seen order. */
function dedupAndMerge(actions: NextAction[]): NextAction[] {
  const map = new Map<string, NextAction>();
  for (const a of actions) {
    const prev = map.get(a.groupKey);
    if (!prev) {
      map.set(a.groupKey, { ...a, sourceRefs: a.sourceRefs.slice() });
    } else {
      prev.evidenceCount += a.evidenceCount;
      for (const ref of a.sourceRefs) if (!prev.sourceRefs.includes(ref)) prev.sourceRefs.push(ref);
    }
  }
  return [...map.values()];
}

/**
 * Build the ranked, capped, observe-hiding attention queue. Pure: reads nothing,
 * writes nothing. Both inputs are draft arrays produced upstream by the existing
 * `buildActionCandidatesFromHealthPlan` / `buildActionCandidatesFromDiscoveries`
 * builders — this function does not re-derive classification.
 */
export function buildAttentionQueue(
  healthDrafts: ActionCandidateDraft[],
  discoveryDrafts: ActionCandidateDraft[],
  options?: BuildAttentionQueueOptions,
): AttentionQueue {
  // Clamp BOTH bounds: negative cap would hit `slice(0, cap)` counting from the tail
  // and bypass the ≤3 ceiling. NaN/Infinity fall back to default. #309 adversarial fix.
  const requested = options?.cap;
  const cap = typeof requested === "number" && Number.isFinite(requested)
    ? Math.max(0, Math.min(requested, DEFAULT_CAP))
    : DEFAULT_CAP;
  const includeRaw = options?.includeRaw === true;

  const all = dedupAndMerge([
    ...healthDrafts.map(toNextAction),
    ...discoveryDrafts.map(toNextAction),
  ]);
  all.sort(rankCompare);

  const observeOnly = all.filter((a) => a.severity === "observe_only");
  const actionable = all.filter((a) => a.severity !== "observe_only");

  const shown = actionable.slice(0, cap);
  const suppressed = actionable.length - shown.length;

  return {
    items: shown,
    summary: {
      totalInput: healthDrafts.length + discoveryDrafts.length,
      shownCount: shown.length,
      hiddenObserveOnly: observeOnly.length,
      suppressedBeyondTop3: suppressed,
    },
    raw: includeRaw
      ? { observeOnlyItems: observeOnly, allItemsRanked: all }
      : null,
  };
}

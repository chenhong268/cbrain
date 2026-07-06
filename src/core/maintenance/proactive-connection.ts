import type { CBrainDB } from "../../storage/sqlite.js";

/**
 * #310 — Phase 0 proactive memory connection candidates.
 *
 * Quiet, opt-in, deterministic, evidence-backed discovery lane that reuses the
 * existing `discoveries` lifecycle. The detector is pure graph + co-occurrence
 * + timeline math (no embeddings, no LLM). Candidates are persisted by the
 * producer ({@link produceProactiveConnectionCandidates}) via `upsertDiscovery`
 * under the open-string type `proactive_connection`, so dedup / status / seen /
 * occurrence_count are inherited unchanged from the discoveries lifecycle.
 *
 * The detector returns pairs that pass Signal A (shared current-fact neighbors,
 * unlinked). Signal B (query-session co-occurrence) and Signal C (timeline
 * proximity) are gathered as supporting evidence. The producer applies the emit
 * rule (Signal A AND ≥1 supporting) before persisting — keeping the detector a
 * pure scoring function and the emit policy in one place.
 */

export interface ProactiveConnectionOptions {
  /** ISO timestamp; entity/concept pages updated after this are pivot candidates. */
  since?: string;
  /** Min shared current-fact neighbors for Signal A. Default 2. */
  minShared?: number;
  /** Min distinct query sessions for Signal B. Default 2. */
  minSessions?: number;
  /** Max days between latest timeline events for Signal C. Default 14. */
  maxTimelineDays?: number;
  /** Max candidates emitted per run. Default 20. */
  cap?: number;
}

export interface ProactiveConnectionCandidate {
  a: string;
  b: string;
  sharedNeighbors: number;
  coOccurringSessions: number;
  timelineProximityDays: number | null;
  signalA: boolean;
  signalB: boolean;
  signalC: boolean;
  score: number;
}

export interface ProactiveConnectionResult {
  total: number;
  inserted: number;
}

const DEFAULT_SINCE_DAYS = 30;
const DEFAULT_MIN_SHARED = 2;
const DEFAULT_MIN_SESSIONS = 2;
const DEFAULT_MAX_TIMELINE_DAYS = 14;
const DEFAULT_CAP = 20;

const MS_PER_DAY = 86_400_000;

/** Deterministic (0.01, 1] clamp; never 0 so rows stay sortable above true-zero. */
export function clamp01(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0.01;
  return Math.min(n, 1);
}

/** Order-independent pair key "alpha|beta" (sorted). */
export function pairKey(a: string, b: string): string {
  return [a, b].sort().join("|");
}

interface LocalAdjacency {
  neighbors: Map<string, Set<string>>;
}

/**
 * Build an undirected neighbor map from a bounded link batch. `batchGetLinksForSlugs`
 * already drops rejected/superseded edges (default `includeInactive=false`), so the
 * adjacency reflects only current-fact links — callers must not re-introduce dead edges.
 */
function buildLocalAdjacency(
  links: Map<string, { outgoing: Array<{ to_slug: string }>; incoming: Array<{ from_slug: string }> }>,
): LocalAdjacency {
  const neighbors = new Map<string, Set<string>>();
  const addEdge = (a: string, b: string) => {
    if (a === b) return;
    let na = neighbors.get(a);
    if (!na) { na = new Set(); neighbors.set(a, na); }
    let nb = neighbors.get(b);
    if (!nb) { nb = new Set(); neighbors.set(b, nb); }
    na.add(b);
    nb.add(a);
  };
  for (const [slug, { outgoing, incoming }] of links) {
    for (const l of outgoing) addEdge(slug, l.to_slug);
    for (const l of incoming) addEdge(slug, l.from_slug);
  }
  return { neighbors };
}

/**
 * Build a pair→distinct-session-count map over the window. One pass over recent
 * sessions; each pair counts at most once per session regardless of in-session
 * repetition. Mirrors the read pattern of `LearnManager.updateCoOccurrences`
 * (learn.ts) but performs NO writes — Phase 0 is evidence-only.
 */
export function countPairCoOccurrencesAcrossSessions(
  db: CBrainDB,
  since: string,
): Map<string, number> {
  const map = new Map<string, number>();
  const sessions = db.getDistinctSessionsSince(since);
  for (const sid of sessions) {
    const pairs = db.getSessionCoOccurrences(sid);
    for (const p of pairs) {
      const key = pairKey(p.slug_a, p.slug_b);
      map.set(key, (map.get(key) ?? 0) + 1);
    }
  }
  return map;
}

/** Absolute day-gap between each side's latest dated event, or null if either side has none. */
export function timelineGapDays(
  eventsA: Array<{ event_date: string | null }>,
  eventsB: Array<{ event_date: string | null }>,
): number | null {
  const latest = (events: Array<{ event_date: string | null }>): number | null => {
    const ts = events
      .map((e) => (e.event_date ? Date.parse(e.event_date) : NaN))
      .filter((t) => Number.isFinite(t));
    return ts.length > 0 ? Math.max(...ts) : null;
  };
  const la = latest(eventsA);
  const lb = latest(eventsB);
  if (la === null || lb === null) return null;
  return Math.abs(la - lb) / MS_PER_DAY;
}

/**
 * Detect proactive connection candidates via a bounded sweep pivoted on
 * recently-updated entity/concept pages. For each pivot, a single bounded
 * `batchGetLinksForSlugs` builds the local one/two-hop neighborhood; two-hop
 * entities sharing ≥ `minShared` current-fact neighbors with the pivot (and not
 * directly linked to it) become Signal A candidates. Signals B/C are gathered
 * from a once-per-run co-occurrence map and a per-pivot timeline batch.
 *
 * Does NOT apply the emit rule — the producer does. Embedding similarity is
 * intentionally never used (issue #310 non-goal).
 */
export function detectProactiveConnections(
  db: CBrainDB,
  opts: ProactiveConnectionOptions = {},
): ProactiveConnectionCandidate[] {
  const minShared = opts.minShared ?? DEFAULT_MIN_SHARED;
  const minSessions = opts.minSessions ?? DEFAULT_MIN_SESSIONS;
  const maxTimelineDays = opts.maxTimelineDays ?? DEFAULT_MAX_TIMELINE_DAYS;
  const cap = opts.cap ?? DEFAULT_CAP;
  const since = opts.since ?? new Date(Date.now() - DEFAULT_SINCE_DAYS * MS_PER_DAY).toISOString();

  const out: ProactiveConnectionCandidate[] = [];
  const seen = new Set<string>();
  const coOccurMap = countPairCoOccurrencesAcrossSessions(db, since);
  const pivots = db.getEntityConceptPagesUpdatedSince(since);

  for (const pivot of pivots) {
    if (out.length >= cap) break;
    // Seed the batch scope with the pivot + its raw one-hop slugs. The adjacency
    // itself is built only from active links returned by batchGetLinksForSlugs,
    // so rejected/superseded edges never become evidence.
    const oneHop = db.getLinkNeighborSlugs(pivot.slug);
    const batch = db.batchGetLinksForSlugs([pivot.slug, ...oneHop]);
    const { neighbors } = buildLocalAdjacency(batch);
    const pivotNeighbors = neighbors.get(pivot.slug);
    if (!pivotNeighbors || pivotNeighbors.size === 0) continue;

    const candidateNodes: string[] = [];
    for (const node of neighbors.keys()) {
      if (node === pivot.slug) continue;
      if (pivotNeighbors.has(node)) continue; // directly linked → not a proactive candidate
      candidateNodes.push(node);
    }
    if (candidateNodes.length === 0) continue;

    const tlMap = db.batchGetTimelineForSlugs([pivot.slug, ...candidateNodes]);
    const pivotEvents = tlMap.get(pivot.slug) ?? [];

    for (const node of candidateNodes) {
      if (out.length >= cap) break;
      const nodeNeighbors = neighbors.get(node) ?? new Set<string>();
      let shared = 0;
      for (const n of pivotNeighbors) if (nodeNeighbors.has(n)) shared++;
      if (shared < minShared) continue;
      const key = pairKey(pivot.slug, node);
      if (seen.has(key)) continue;
      seen.add(key);

      const coOccurringSessions = coOccurMap.get(key) ?? 0;
      const signalB = coOccurringSessions >= minSessions;
      const gapDays = timelineGapDays(pivotEvents, tlMap.get(node) ?? []);
      const signalC = gapDays !== null && gapDays <= maxTimelineDays;
      const supporting = (signalB ? 1 : 0) + (signalC ? 1 : 0);
      const score = clamp01(
        0.34 + (signalB ? 0.22 : 0) + (signalC ? 0.22 : 0) + (supporting === 2 ? 0.11 : 0),
      );

      out.push({
        a: pivot.slug,
        b: node,
        sharedNeighbors: shared,
        coOccurringSessions,
        timelineProximityDays: signalC ? gapDays : null,
        signalA: true,
        signalB,
        signalC,
        score,
      });
    }
  }
  return out;
}

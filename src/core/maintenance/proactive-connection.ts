import type { CBrainDB } from "../../storage/sqlite.js";
import type { Logger } from "../logger.js";
import { runDiscoveryShadowVerifierFailOpen } from "../quality/shadow-verifier.js";

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
 * Evidence auditability (issue core): each candidate carries bounded CONCRETE
 * evidence refs — shared neighbor slugs, the two sides' latest timeline event
 * ids, and the opaque query-session ids that co-occurred — in
 * `metadata.evidence`. These refs are raw/debug audit data that let a reviewer
 * (human, Hermes, Codex) reconstruct WHY the candidate fired. They are NEVER
 * echoed into user-visible display text: display is generated at read time by
 * `formatDigestCard` from fixed anonymous copy + `safeTitle`, which sanitizes
 * page titles. Query TEXT is never stored (only opaque session ids).
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

/** A single timeline event referenced as evidence (slug + stable id + date). */
export interface TimelineEventRef {
  slug: string;
  eventId: number;
  eventDate: string | null;
}

interface CoOccurEntry {
  count: number;
  /** Bounded list of opaque session ids that co-occurred this pair. NO query text. */
  sessionRefs: string[];
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
  /**
   * Bounded concrete evidence refs for audit. Written into `metadata.evidence`
   * by the producer and NEVER read by `formatDigestCard` (user display is fixed
   * anonymous copy + safeTitle). Query text is never stored (opaque session
   * ids only).
   */
  sharedNeighborSlugs: string[];
  timelineEventRefs: TimelineEventRef[];
  coOccurringSessionRefs: string[];
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
/** Bound on evidence ref lists (shared-neighbor slugs, session refs). */
const MAX_REFS = 3;
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
 * Build a pair→{count, bounded sessionRefs} map over the window. One pass over
 * recent sessions; each pair counts at most once per session regardless of
 * in-session repetition. Only OPAQUE session ids are captured — query text is
 * never stored. Mirrors the read pattern of `LearnManager.updateCoOccurrences`
 * (learn.ts) but performs NO writes — Phase 0 is evidence-only.
 */
export function countPairCoOccurrencesAcrossSessions(
  db: CBrainDB,
  since: string,
  maxSessionRefs: number = MAX_REFS,
): Map<string, CoOccurEntry> {
  const map = new Map<string, CoOccurEntry>();
  const sessions = db.getDistinctSessionsSince(since);
  for (const sid of sessions) {
    const pairs = db.getSessionCoOccurrences(sid);
    for (const p of pairs) {
      const key = pairKey(p.slug_a, p.slug_b);
      const e = map.get(key) ?? { count: 0, sessionRefs: [] };
      e.count++;
      if (e.sessionRefs.length < maxSessionRefs) e.sessionRefs.push(sid);
      map.set(key, e);
    }
  }
  return map;
}

/** The latest dated event among `events`, as a stable audit ref; null if none has a parseable date. */
function latestEventRef(
  slug: string,
  events: Array<{ id: number; event_date: string | null }>,
): TimelineEventRef | null {
  let best: TimelineEventRef | null = null;
  let bestTs = -Infinity;
  for (const e of events) {
    if (!e.event_date) continue;
    const ts = Date.parse(e.event_date);
    if (!Number.isFinite(ts) || ts <= bestTs) continue;
    bestTs = ts;
    best = { slug, eventId: e.id, eventDate: e.event_date };
  }
  return best;
}

function gapDaysBetween(a: TimelineEventRef | null, b: TimelineEventRef | null): number | null {
  if (!a?.eventDate || !b?.eventDate) return null;
  const ta = Date.parse(a.eventDate);
  const tb = Date.parse(b.eventDate);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.abs(ta - tb) / MS_PER_DAY;
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
    const pivotLatest = latestEventRef(pivot.slug, tlMap.get(pivot.slug) ?? []);

    for (const node of candidateNodes) {
      if (out.length >= cap) break;
      const nodeNeighbors = neighbors.get(node) ?? new Set<string>();
      let shared = 0;
      const sharedSlugs: string[] = [];
      for (const n of pivotNeighbors) {
        if (nodeNeighbors.has(n)) {
          shared++;
          if (sharedSlugs.length < MAX_REFS) sharedSlugs.push(n);
        }
      }
      if (shared < minShared) continue;
      const key = pairKey(pivot.slug, node);
      if (seen.has(key)) continue;
      seen.add(key);

      const coOccurEntry = coOccurMap.get(key);
      const coOccurringSessions = coOccurEntry?.count ?? 0;
      const coOccurringSessionRefs = coOccurEntry?.sessionRefs ?? [];
      const signalB = coOccurringSessions >= minSessions;

      const nodeLatest = latestEventRef(node, tlMap.get(node) ?? []);
      const gapDays = gapDaysBetween(pivotLatest, nodeLatest);
      const signalC = gapDays !== null && gapDays <= maxTimelineDays;
      const timelineEventRefs: TimelineEventRef[] = [];
      if (pivotLatest) timelineEventRefs.push(pivotLatest);
      if (nodeLatest) timelineEventRefs.push(nodeLatest);

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
        sharedNeighborSlugs: sharedSlugs,
        timelineEventRefs,
        coOccurringSessionRefs,
      });
    }
  }
  return out;
}

/**
 * Persist proactive connection candidates into the `discoveries` table under the
 * open-string type `proactive_connection`. Applies the emit rule (Signal A AND
 * ≥1 supporting) before persisting, runs the fail-open shadow verifier before
 * every upsert (privacy + quality audit, never blocks), and writes bounded
 * CONCRETE evidence refs into `metadata.evidence` so each candidate is auditable
 * (which neighbors are shared, which timeline events are close, which sessions
 * co-occurred). Query text is never stored.
 *
 * Boundary: `metadata.evidence` is raw/debug audit data — `formatDigestCard`
 * never reads it; user display is fixed anonymous copy + `safeTitle`. Lifecycle
 * is inherited from `upsertDiscovery`: dedup via `${type}|sorted`, recurrence
 * bumps `occurrence_count`, and dismissed/resolved rows (status != pending) are
 * never resurrected because the conflict path never touches status/seen
 * (#172, #310 acceptance #4/#5).
 */
export function produceProactiveConnectionCandidates(
  db: CBrainDB,
  opts: ProactiveConnectionOptions & { dreamRun?: string; logger?: Logger | null } = {},
): ProactiveConnectionResult {
  const candidates = detectProactiveConnections(db, opts);
  let inserted = 0;
  for (const c of candidates) {
    // Emit rule: the strong signal (shared neighbors) needs ≥1 supporting
    // signal. Embedding similarity is never used (issue #310 non-goal).
    const supporting = (c.signalB ? 1 : 0) + (c.signalC ? 1 : 0);
    if (!(c.signalA && supporting >= 1)) continue;

    const entities = [c.a, c.b].sort();
    const metadata = {
      source: "proactive_connection",
      signals: {
        shared_neighbors: c.sharedNeighbors,
        cooccurring_sessions: c.coOccurringSessions,
        timeline_proximity_days: c.timelineProximityDays,
      },
      // Bounded concrete evidence refs so a reviewer can reconstruct WHY this
      // candidate fired. Raw/debug audit only — formatDigestCard never reads
      // this; display stays anonymous. NO query text (opaque session ids only).
      evidence: {
        shared_neighbor_slugs: c.sharedNeighborSlugs,
        timeline_event_refs: c.timelineEventRefs,
        cooccurring_session_refs: c.coOccurringSessionRefs,
      },
      pivot: "recently_ingested",
    };

    // Display texts are the candidate titles only — fixed display copy is
    // generated at read time by formatDigestCard (safeTitle sanitizes). The
    // verifier scans these titles for unsafe patterns (secret/slug/path).
    const displayTexts = [c.a, c.b]
      .map((slug) => db.getPage(slug)?.title ?? "")
      .filter((t) => t.length > 0);

    runDiscoveryShadowVerifierFailOpen({
      db,
      logger: opts.logger ?? null,
      input: {
        type: "proactive_connection",
        actionable: "low",
        score: c.score,
        autoApplicable: false,
        hasEvidence: true,
        hasProposedActions: false,
        displayTexts,
      },
    });

    const res = db.upsertDiscovery(
      "proactive_connection",
      entities,
      c.score,
      undefined,
      opts.dreamRun,
      "low",
      false,
      metadata,
    );
    if (res.inserted) inserted++;
  }
  return { total: candidates.length, inserted };
}

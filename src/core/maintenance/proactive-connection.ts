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
  /** #314 — count of candidates whose quality was boosted by accepted feedback (new insert OR recurrence). */
  feedbackBoosted: number;
  /** #314 — count of candidates suppressed by review feedback (Layer 3 evidence-identical to dismissed/resolved). */
  feedbackSuppressed: number;
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

// ─── #311 Phase 1 scoring ───────────────────────────────────────
//
// Pure scoring layer for proactive candidates. Produces 5 per-dimension scores +
// composite `quality` + the strengthened-gate classification. Stored ONLY in
// `metadata.scoring` (raw/debug audit) — `formatDigestCard` never reads it. The
// persisted `discoveries.score` is set to `quality`. All weights are named
// constants summing to 1.0 (Phase 1 defaults, confirmed at the 2026-07-07 review checkpoint).

/** Per-dimension weights (sum to 1.0). Phase 1 defaults. */
export const SCORE_WEIGHTS = {
  evidence: 0.35,
  novelty: 0.15,
  recurrence: 0.20,
  actionability: 0.10,
  safety: 0.20,
} as const;

/** #314 — quality boost per accepted-entity hit. A candidate has 2 entities → max boost 2 * FEEDBACK_BOOST = 0.10. */
export const FEEDBACK_BOOST = 0.05;

const SCORE_BASE_EVIDENCE = 0.40;
const SCORE_STEP_NEIGHBOR = 0.15; // per extra non-hub neighbor beyond minShared, up to 2
const SCORE_STEP_SIGNAL = 0.15; // per supporting signal (B / C)
const SCORE_RISK_BASE = 0.60;
const SCORE_RISK_SIGNAL = 0.20;
const SCORE_RISK_NEIGHBOR = 0.10;
const SCORE_NOVELTY_DECAY = 0.5;
const SCORE_RECURRENCE_TARGET = 5;
const SCORE_ACTIONABILITY_FLAT = 0.20;
/** Strong-signal threshold for gate path 1 (one above Phase 0 minShared=2). */
const STRONG_SHARED = 3;
/** Shared-neighbor global degree above which a neighbor is treated as a generic hub. */
const HUB_DEGREE_MAX = 20;

export interface ScoringInput {
  /** Non-hub shared current-fact neighbor count (post hub filter). */
  sharedNeighbors: number;
  signalB: boolean;
  signalC: boolean;
  /** Existing occurrence_count for the pair (0 if new). */
  occurrenceCount: number;
}

export type ProactiveGatePath = "strong_corroborated" | "multi_independent" | "rejected";

export interface ProactiveScore {
  evidence_strength: number;
  novelty: number;
  recurrence: number;
  actionability: number;
  risk: number;
  quality: number;
  gate_path: ProactiveGatePath;
}

/**
 * Score a proactive candidate on 5 dimensions + composite `quality` and classify
 * it under the strengthened gate (spec D1/D2). Dimensions are always computed
 * (useful for debug even when rejected). Gate rule:
 *   - `strong_corroborated`: sharedNeighbors ≥ STRONG_SHARED AND ≥1 supporting.
 *   - `multi_independent`: sharedNeighbors ≥ DEFAULT_MIN_SHARED AND signalB AND signalC.
 *   - `rejected` otherwise.
 * `sharedNeighbors` is the post-hub-filter count supplied by the detector.
 * Embedding/LLM never feed this (issue #311 non-goal).
 */
export function scoreProactiveConnectionCandidate(input: ScoringInput): ProactiveScore {
  const neighborBoost = Math.max(0, Math.min(input.sharedNeighbors - DEFAULT_MIN_SHARED, 2));
  const bN = input.signalB ? 1 : 0;
  const cN = input.signalC ? 1 : 0;

  const evidence_strength = clamp01(
    SCORE_BASE_EVIDENCE + SCORE_STEP_NEIGHBOR * neighborBoost + SCORE_STEP_SIGNAL * bN + SCORE_STEP_SIGNAL * cN,
  );
  const novelty = input.occurrenceCount === 0 ? 1 : clamp01(1 / (1 + SCORE_NOVELTY_DECAY * input.occurrenceCount));
  const recurrence = clamp01(input.occurrenceCount / SCORE_RECURRENCE_TARGET);
  const actionability = SCORE_ACTIONABILITY_FLAT;
  const risk = clamp01(
    SCORE_RISK_BASE - SCORE_RISK_SIGNAL * bN - SCORE_RISK_SIGNAL * cN - SCORE_RISK_NEIGHBOR * neighborBoost,
  );

  const quality = clamp01(
    SCORE_WEIGHTS.evidence * evidence_strength +
      SCORE_WEIGHTS.novelty * novelty +
      SCORE_WEIGHTS.recurrence * recurrence +
      SCORE_WEIGHTS.actionability * actionability +
      SCORE_WEIGHTS.safety * (1 - risk),
  );

  let gate_path: ProactiveGatePath;
  if (input.sharedNeighbors >= STRONG_SHARED && (input.signalB || input.signalC)) {
    gate_path = "strong_corroborated";
  } else if (input.sharedNeighbors >= DEFAULT_MIN_SHARED && input.signalB && input.signalC) {
    gate_path = "multi_independent";
  } else {
    gate_path = "rejected";
  }

  return { evidence_strength, novelty, recurrence, actionability, risk, quality, gate_path };
}

/**
 * #314 — bounded quality boost from accepted review feedback. A candidate gets
 * FEEDBACK_BOOST per entity that appears in the acceptedEntities set (derived
 * from resolved discoveries). A candidate has exactly 2 entities, so the boost
 * is construction-bounded at 2 * FEEDBACK_BOOST; clamp01 (applied by the caller)
 * enforces the (0.01, 1] quality invariant. Pure + deterministic; no DB access.
 *
 * The boost targets the `quality` composite (ranking), NOT any review gate
 * dimension, so it cannot rescue a weak candidate (acceptance #2).
 */
export function acceptedEntityBoost(entities: string[], acceptedEntities: Set<string>): number {
  let hits = 0;
  for (const e of entities) if (acceptedEntities.has(e)) hits++;
  return hits * FEEDBACK_BOOST;
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

    // #311 — global link degree per neighborhood slug, for the anti-generic hub
    // filter (spec D2). A shared neighbor whose active-link degree exceeds
    // HUB_DEGREE_MAX is a generic hub, not evidence of a real pair connection.
    const degrees = db.batchGetLinkDegrees([...neighbors.keys()]);
    const isHub = (slug: string): boolean => (degrees.get(slug) ?? 0) > HUB_DEGREE_MAX;

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
        if (isHub(n)) continue; // #311 — generic hub, not real evidence
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

      out.push({
        a: pivot.slug,
        b: node,
        sharedNeighbors: shared,
        coOccurringSessions,
        timelineProximityDays: signalC ? gapDays : null,
        signalA: true,
        signalB,
        signalC,
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
 * open-string type `proactive_connection`. Per-candidate pipeline (issue #311):
 * detect → score on 5 dimensions + composite `quality` → apply the strengthened
 * gate (`strong_corroborated` OR `multi_independent`, else reject) → cooldown
 * (skip exact dismissed dedup_key; suppress evidence-identical equivalents) →
 * run the fail-open shadow verifier → `upsertDiscovery` with `metadata.scoring`
 * (raw/debug) and `quality` as the row score. Bounded CONCRETE evidence refs are
 * written into `metadata.evidence` so each candidate is auditable. Query text is
 * never stored.
 *
 * Boundary: `metadata.evidence` AND `metadata.scoring` are raw/debug audit data —
 * `formatDigestCard` never reads either; user display is fixed anonymous copy +
 * `safeTitle`. Lifecycle is inherited from `upsertDiscovery`: dedup via
 * `${type}|sorted`, recurrence bumps `occurrence_count`, and dismissed/resolved
 * rows (status != pending) are never resurrected because the conflict path never
 * touches status/seen (#172, #310 acceptance #4/#5). #311 additionally SKIPS the
 * upsert for dismissed pairs so occurrence_count stays frozen on dead rows.
 */
export function produceProactiveConnectionCandidates(
  db: CBrainDB,
  opts: ProactiveConnectionOptions & { dreamRun?: string; logger?: Logger | null } = {},
): ProactiveConnectionResult {
  const candidates = detectProactiveConnections(db, opts);
  let inserted = 0;
  let feedbackBoosted = 0;
  let feedbackSuppressed = 0;

  // #311 — lifecycle index keyed by the canonical entities JSON (the same form
  // `upsertDiscovery` stores). Backs (a) exact-pair cooldown skip, (b) evidence-
  // identical equivalent suppression, (c) pre-upsert occurrence_count for
  // novelty/recurrence scoring. One query per run.
  type LifeEntry = { status: string; occurrence_count: number };
  const byEntities = new Map<string, LifeEntry>();
  const dismissedEvidence: Array<{ entities: string[]; slugs: Set<string>; count: number }> = [];
  // #314 — entities appearing in resolved (accepted) discoveries; backs the bounded quality boost.
  const acceptedEntities = new Set<string>();
  for (const row of db.getDiscoveryLifecycleIndex("proactive_connection")) {
    byEntities.set(row.entities, { status: row.status, occurrence_count: row.occurrence_count });
    if (row.status === "dismissed" || row.status === "resolved") {
      let slugs: string[] = [];
      let count = 0;
      if (row.metadata) {
        try {
          const meta = JSON.parse(row.metadata) as {
            evidence?: { shared_neighbor_slugs?: string[] };
            signals?: { shared_neighbors?: number };
          };
          slugs = meta.evidence?.shared_neighbor_slugs ?? [];
          count = meta.signals?.shared_neighbors ?? 0;
        } catch {
          slugs = [];
          count = 0;
        }
      }
      dismissedEvidence.push({ entities: JSON.parse(row.entities) as string[], slugs: new Set(slugs), count });
    }
    if (row.status === "resolved") {
      // #314 — accepted feedback: both entities of a resolved discovery become boost-eligible.
      try {
        const ents = JSON.parse(row.entities) as string[];
        if (Array.isArray(ents)) for (const e of ents) acceptedEntities.add(e);
      } catch {
        // malformed entities JSON → skip this row's contribution to acceptedEntities
      }
    }
  }

  for (const c of candidates) {
    const sortedEntities = [...new Set([c.a, c.b])].sort();
    const entitiesJson = JSON.stringify(sortedEntities);
    const existing = byEntities.get(entitiesJson);
    const occurrenceCount = existing?.occurrence_count ?? 0;

    // #311 scoring + strengthened gate (spec D1/D2). Dimensions are always
    // computed; gate_path decides persist vs reject. Embedding/LLM never feed
    // this (issue #311 non-goal).
    const sc = scoreProactiveConnectionCandidate({
      sharedNeighbors: c.sharedNeighbors,
      signalB: c.signalB,
      signalC: c.signalC,
      occurrenceCount,
    });
    if (sc.gate_path === "rejected") continue;

    // #311 cooldown layer 2: any non-pending existing row → skip upsert entirely.
    // `upsertDiscovery` never resurrects status by construction (its conflict path
    // never touches status/seen); this additionally avoids bumping occurrence_count
    // and overwriting score/metadata on a row the user has already acted on
    // (dismissed / resolved / seen — adversarial fix: 'seen' was previously bumped).
    if (existing && existing.status !== "pending") continue;

    // #311 cooldown layer 3 / spec D3: evidence-identical equivalent → suppress.
    // Same evidence neighborhood + shared entity = the same dismissed signal under
    // a different target. Partial overlap is deliberately NOT suppressed (would
    // falsely silence legitimate new connections). The FULL shared-neighbor COUNT
    // gates the comparison first (adversarial fix: the stored slug list is
    // truncated to MAX_REFS=3, so set-equality on it alone would false-match a
    // 3-neighbor candidate against a 4-neighbor dismissed pair).
    const candSlugs = new Set(c.sharedNeighborSlugs);
    if (candSlugs.size > 0) {
      const equivalent = dismissedEvidence.some((d) => {
        if (d.count !== c.sharedNeighbors) return false; // FULL count, not truncated slugs
        if (d.slugs.size === 0 || d.slugs.size !== candSlugs.size) return false;
        if (!d.entities.some((e) => sortedEntities.includes(e))) return false;
        for (const s of candSlugs) if (!d.slugs.has(s)) return false;
        return true;
      });
      if (equivalent) {
        feedbackSuppressed++;
        continue;
      }
    }

    // #314 — accepted-feedback boost on quality (NOT gate dims). Applied after the
    // #311 gate-reject (:474) and after Layer 2/3 suppression, so rejected and
    // suppressed candidates are never boosted. Recurrence of an existing pending
    // candidate IS boosted (upsertDiscovery persists score/metadata on recurrence).
    const acceptedHits = acceptedEntityBoost(sortedEntities, acceptedEntities);
    if (acceptedHits > 0) {
      sc.quality = clamp01(sc.quality + acceptedHits);
    }

    const metadata = {
      source: "proactive_connection",
      signals: {
        shared_neighbors: c.sharedNeighbors,
        cooccurring_sessions: c.coOccurringSessions,
        timeline_proximity_days: c.timelineProximityDays,
      },
      // Bounded concrete evidence refs — raw/debug audit only. formatDigestCard
      // never reads this; display stays anonymous + safeTitle-sanitized. NO query
      // text (opaque session ids only).
      evidence: {
        shared_neighbor_slugs: c.sharedNeighborSlugs,
        timeline_event_refs: c.timelineEventRefs,
        cooccurring_session_refs: c.coOccurringSessionRefs,
      },
      // #311 — per-dimension scores + composite quality + gate classification.
      // Raw/debug audit only; formatDigestCard never reads this. `quality` is also
      // persisted as the discoveries.score column (internal sort, never rendered).
      scoring: {
        evidence_strength: sc.evidence_strength,
        novelty: sc.novelty,
        recurrence: sc.recurrence,
        actionability: sc.actionability,
        risk: sc.risk,
        quality: sc.quality,
        gate_path: sc.gate_path,
        weights: SCORE_WEIGHTS,
        // #314 — feedback-learning audit (raw/debug only). feedback_boost is the
        // applied delta (0 if none); feedback_reason flags a boosted candidate.
        feedback_boost: acceptedHits,
        feedback_reason: acceptedHits > 0 ? "feedback_boosted" : null,
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
        score: sc.quality,
        autoApplicable: false,
        hasEvidence: true,
        hasProposedActions: false,
        displayTexts,
      },
    });

    const res = db.upsertDiscovery(
      "proactive_connection",
      sortedEntities,
      sc.quality,
      undefined,
      opts.dreamRun,
      "low",
      false,
      metadata,
    );
    if (res.inserted) inserted++;
    if (acceptedHits > 0) feedbackBoosted++; // new OR recurrence — upsertDiscovery persists the boost either way
  }
  return { total: candidates.length, inserted, feedbackBoosted, feedbackSuppressed };
}

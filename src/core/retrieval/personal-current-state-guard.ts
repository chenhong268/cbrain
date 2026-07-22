/**
 * #385 — personal current-state guard for content recall.
 *
 * A deterministic, bounded guard that activates ONLY for a closed grammar
 * combining first-person phrasing with action-oriented / current-state
 * intent. When activated it verifies a trusted subject-to-topic chain
 * before allowing reminder-like search material to be presented as a
 * current personal recommendation.
 *
 * Safety guarantee (phase 1): the guard FAILS CLOSED. If it cannot prove
 * a trusted subject/topic/current-state chain, it returns an explicit
 * insufficient-current-context outcome and the caller must NOT surface
 * the search material as current advice.
 *
 * It does NOT auto-infer closure from recency or word overlap — there is
 * no generic record-to-record fulfills/supersedes contract yet.
 *
 * Bounded budget: at most one graph hop with SQL-level LIMIT, plus a
 * bounded timeline window over the subject AND its trusted neighbors.
 * Non-personal queries short-circuit before any DB work.
 */
import type { CBrainDB, LinkRow } from "../../storage/sqlite.js";
import type { SearchResult } from "./search.js";
import { isPersonalCurrentStateQuery } from "./recall-intent.js";

export type PersonalGuardOutcome = "pass" | "insufficient_current_context";

export interface PersonalGuardResult {
  /** Whether the guard activated for this query. */
  activated: boolean;
  outcome: PersonalGuardOutcome;
  /** Resolved subject slug when activated. */
  subjectSlug?: string;
  /** Human-safe reason for insufficient outcome (no PII, no paths). */
  reason?: string;
  /**
   * When insufficient, the raw search material preserved as debug-only evidence.
   * The caller MUST prevent this from being interpreted as current advice.
   */
  debugSearchMaterial?: SearchResult[];
  /**
   * When the guard passes, the filtered result set containing ONLY candidates
   * with a verified trusted subject connection. The caller should use this
   * instead of the original results to avoid surfacing unrelated stale material.
   */
  filteredResults?: SearchResult[];
}

/** Minimal page lookup — avoids coupling the guard to the full PageManager. */
export interface GuardPageLookup {
  getBySlug(slug: string): { type: string; title?: string; body?: string } | null;
}

/** At most this many trusted links inspected (SQL LIMIT, one hop). */
const MAX_TRUSTED_LINKS = 10;
/** At most this many timeline rows inspected over subject + neighbors. */
const MAX_TIMELINE_BUDGET = 5;
/** Timeline lookback window in days for the bounded network query. */
const TIMELINE_LOOKBACK_DAYS = 365;

// ── Closed-grammar state markers for conflict detection (#385 regression #5) ──
//
// Phase 1 does NOT infer closure from these markers alone. They are used
// only to detect an *unresolvable* conflict (both completed and pending
// markers in trusted timeline evidence), which forces a fail-closed
// outcome rather than guessing which record is current.
const COMPLETED_MARKER = /已完成|完成|done|completed|finished|已结束|结案|已做/i;
const PENDING_MARKER = /待办|未完成|计划中|待复查|需复查|pending|scheduled|upcoming|todo|待完成|需完成/i;

function isEntityPersonType(type: string): boolean {
  return type === "entity" || type === "entity/person" || type.startsWith("entity/person");
}

/**
 * Apply the personal current-state guard.
 *
 * Returns `{ activated: false, outcome: "pass" }` for non-personal queries
 * (zero DB work, existing latency budget preserved).
 *
 * For personal current-state queries:
 * 1. Resolves the subject through the configured identity (fail-closed on missing).
 * 2. Fetches bounded trusted one-hop links (SQL LIMIT, explicit trust only).
 * 3. Filters candidates to ONLY those with a verified trusted subject connection.
 * 4. Inspects bounded timeline over subject + trusted neighbors.
 * 5. Either passes (with filtered results) or returns insufficient.
 */
export function applyPersonalCurrentStateGuard(
  db: CBrainDB,
  pages: GuardPageLookup,
  query: string,
  results: SearchResult[],
  identityPersonSlug: string | undefined,
): PersonalGuardResult {
  // Step 1: closed-grammar gate — must be a personal current-state query.
  if (!isPersonalCurrentStateQuery(query)) {
    return { activated: false, outcome: "pass" };
  }

  // Step 2: resolve subject deterministically.
  // Only an explicit configured identity that uniquely maps to entity/person.
  if (!identityPersonSlug) {
    return {
      activated: true,
      outcome: "insufficient_current_context",
      reason: "no identity mapping configured",
      debugSearchMaterial: results,
    };
  }

  const personPage = pages.getBySlug(identityPersonSlug);
  if (!personPage) {
    return {
      activated: true,
      outcome: "insufficient_current_context",
      reason: "identity page not found",
      debugSearchMaterial: results,
    };
  }

  if (!isEntityPersonType(personPage.type)) {
    return {
      activated: true,
      outcome: "insufficient_current_context",
      reason: "identity is not entity/person",
      debugSearchMaterial: results,
    };
  }

  // Step 3: bounded trusted one-hop link fetch (SQL LIMIT, explicit trust).
  // P2#5: uses getBoundedTrustedLinks so high-degree subjects never trigger
  // unbounded reads. P2#6: only trusted/user_thought, NOT null/legacy.
  const trustedLinks: LinkRow[] = db.getBoundedTrustedLinks(
    identityPersonSlug,
    MAX_TRUSTED_LINKS,
  );

  const trustedNeighbors = new Set<string>();
  for (const link of trustedLinks) {
    const neighbor = link.from_slug === identityPersonSlug
      ? link.to_slug
      : link.from_slug;
    trustedNeighbors.add(neighbor);
  }

  // Step 4 (P1#1): PER-CANDIDATE filtering, not some().
  // Only results with a verified trusted subject connection pass through.
  // Unrelated stale reminders are filtered out — they are NOT surfaced.
  const connectedResults = results.filter(
    (r) => r.slug === identityPersonSlug || trustedNeighbors.has(r.slug),
  );

  if (connectedResults.length === 0) {
    return {
      activated: true,
      outcome: "insufficient_current_context",
      subjectSlug: identityPersonSlug,
      reason: "no trusted subject-to-topic chain",
      debugSearchMaterial: results,
    };
  }

  // Step 5 (P1#2): inspect bounded timeline over subject AND trusted neighbors.
  // Uses getRecentEventsInNetwork which reads the subject's one-hop network
  // timeline with a SQL LIMIT — discovers newer records on related pages,
  // not just the subject's own timeline. Semantic event_date only.
  const networkTimeline = db.getRecentEventsInNetwork(
    [identityPersonSlug, ...trustedNeighbors],
    TIMELINE_LOOKBACK_DAYS,
    MAX_TIMELINE_BUDGET,
  );
  const trustedTimeline = networkTimeline; // getRecentEventsInNetwork already filters active

  const hasCompleted = trustedTimeline.some((t) => COMPLETED_MARKER.test(t.summary));
  const hasPending = trustedTimeline.some((t) => PENDING_MARKER.test(t.summary));

  // Phase 1: conflicting dated evidence (completed + pending without a
  // fulfills/supersedes contract) → cannot determine current state → fail closed.
  if (hasCompleted && hasPending) {
    return {
      activated: true,
      outcome: "insufficient_current_context",
      subjectSlug: identityPersonSlug,
      reason: "conflicting dated evidence",
      debugSearchMaterial: results,
    };
  }

  // Trusted subject-to-topic chain verified, no unresolved conflict.
  // Return the FILTERED results — caller should use these, not the originals.
  return {
    activated: true,
    outcome: "pass",
    subjectSlug: identityPersonSlug,
    filteredResults: connectedResults,
  };
}

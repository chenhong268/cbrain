/**
 * #385 — personal current-state guard for content recall.
 *
 * A deterministic, bounded guard that activates ONLY for a closed grammar
 * combining first-person phrasing with action-oriented / current-state
 * intent. When activated it verifies a trusted subject-to-topic chain
 * AND requires at least one trusted dated current-state evidence before
 * allowing reminder-like search material to be presented as a current
 * personal recommendation.
 *
 * Safety guarantee (phase 1): the guard FAILS CLOSED. It returns
 * insufficient-current-context if ANY of these cannot be proven:
 *   - configured identity uniquely mapping to entity/person
 *   - trusted (trusted/user_thought) subject-to-topic link
 *   - at least one trusted dated current-state evidence in the
 *     bounded subject+neighbor timeline scope
 *
 * It does NOT auto-infer closure from recency or word overlap — there is
 * no generic record-to-record fulfills/supersedes contract yet.
 *
 * Bounded budget: SQL-level LIMIT + ORDER BY on all queries, no graph
 * expansion beyond the initial trusted one-hop neighbor set.
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

// ── Closed-grammar state markers for conflict detection (#385 regression #5) ──
//
// Phase 1 does NOT infer closure from these markers alone. They are used
// only to detect an *unresolvable* conflict (both completed and pending
// markers in trusted timeline evidence), which forces a fail-closed
// outcome rather than guessing which record is current.
const COMPLETED_MARKER = /已完成|完成|done|completed|finished|已结束|结案|已做/i;
const PENDING_MARKER = /待办|未完成|计划中|待复查|需复查|pending|scheduled|upcoming|todo|待完成|需完成/i;

/**
 * #385 P1#4 — strict person type check.
 * Only accepts the canonical 'entity/person' type. Bare 'entity' (which
 * may be an organization, product, or other legacy entity) is rejected —
 * fail-closed requires explicit person identity.
 */
function isEntityPersonType(type: string): boolean {
  return type === "entity/person";
}

/**
 * Apply the personal current-state guard.
 *
 * Returns `{ activated: false, outcome: "pass" }` for non-personal queries
 * (zero DB work, existing latency budget preserved).
 *
 * For personal current-state queries:
 * 1. Resolves the subject through the configured identity (fail-closed on missing).
 * 2. Fetches bounded trusted one-hop links (SQL LIMIT + ORDER BY, explicit trust).
 * 3. Filters candidates to ONLY those with a verified trusted subject connection.
 * 4. Reads bounded trusted timeline DIRECTLY for subject + neighbors (no graph expansion).
 * 5. Requires at least one trusted dated current-state evidence (fail-closed on empty).
 * 6. Checks for conflicting completed+pending evidence (fail-closed on conflict).
 * 7. Either passes (with filtered results) or returns insufficient.
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

  // P1#4: only entity/person, not bare entity.
  if (!isEntityPersonType(personPage.type)) {
    return {
      activated: true,
      outcome: "insufficient_current_context",
      reason: "identity is not entity/person",
      debugSearchMaterial: results,
    };
  }

  // Step 3: bounded trusted one-hop link fetch (SQL LIMIT + ORDER BY, explicit trust).
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

  // Step 4: PER-CANDIDATE filtering — only trusted-connected candidates pass.
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

  // Step 5 (P1#1): read bounded trusted timeline DIRECTLY for subject + neighbors.
  // Uses getBoundedTrustedTimelineForSlugs — a dedicated method that reads
  // timeline for the EXACT slugs passed (no further graph expansion).
  // trust_state IN ('trusted','user_thought'), event_date IS NOT NULL,
  // ORDER BY event_date DESC with SQL LIMIT. Semantic dates only.
  const timelineScope = [identityPersonSlug, ...trustedNeighbors];
  const trustedTimeline = db.getBoundedTrustedTimelineForSlugs(
    timelineScope,
    MAX_TIMELINE_BUDGET,
  );

  // P1#2: require at least one trusted dated current-state evidence.
  // A trusted link alone is not sufficient — without dated evidence we
  // cannot prove a current-state chain. Fail closed.
  if (trustedTimeline.length === 0) {
    return {
      activated: true,
      outcome: "insufficient_current_context",
      subjectSlug: identityPersonSlug,
      reason: "no trusted dated current-state evidence",
      debugSearchMaterial: results,
    };
  }

  // Step 6: conflicting dated evidence detection.
  const hasCompleted = trustedTimeline.some((t) => COMPLETED_MARKER.test(t.summary));
  const hasPending = trustedTimeline.some((t) => PENDING_MARKER.test(t.summary));

  if (hasCompleted && hasPending) {
    return {
      activated: true,
      outcome: "insufficient_current_context",
      subjectSlug: identityPersonSlug,
      reason: "conflicting dated evidence",
      debugSearchMaterial: results,
    };
  }

  // Step 7: trusted subject-to-topic chain + dated evidence verified.
  return {
    activated: true,
    outcome: "pass",
    subjectSlug: identityPersonSlug,
    filteredResults: connectedResults,
  };
}

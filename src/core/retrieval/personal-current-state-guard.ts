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
 * Bounded budget: at most one graph hop + a fixed small timeline cap.
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
  /** When insufficient, the raw search material preserved as debug-only evidence. */
  debugSearchMaterial?: SearchResult[];
}

/** Minimal page lookup — avoids coupling the guard to the full PageManager. */
export interface GuardPageLookup {
  getBySlug(
    slug: string,
  ): { type: string; title?: string; body?: string } | null;
}

/** At most this many timeline rows inspected per activation. */
const MAX_TIMELINE_BUDGET = 5;

// ── Closed-grammar state markers for conflict detection (#385 regression #5) ──
//
// Phase 1 does NOT infer closure from these markers alone. They are used
// only to detect an *unresolvable* conflict (both completed and pending
// markers in trusted timeline evidence), which forces a fail-closed
// outcome rather than guessing which record is current.
const COMPLETED_MARKER =
  /已完成|完成|done|completed|finished|已结束|结案|已做/i;
const PENDING_MARKER =
  /待办|未完成|计划中|待复查|需复查|pending|scheduled|upcoming|todo|待完成|需完成/i;

/**
 * Trust filter: NULL (legacy), "trusted", or "user_thought".
 * Excludes "candidate" (unverified NER), "rejected", "superseded".
 */
function isTrustedOrUserThought(
  trustState: string | null | undefined,
): boolean {
  return (
    trustState === undefined ||
    trustState === null ||
    trustState === "trusted" ||
    trustState === "user_thought"
  );
}

function isEntityPersonType(type: string): boolean {
  return (
    type === "entity" ||
    type === "entity/person" ||
    type.startsWith("entity/person")
  );
}

/**
 * Apply the personal current-state guard.
 *
 * Returns `{ activated: false, outcome: "pass" }` for non-personal queries
 * (zero DB work, existing latency budget preserved).
 *
 * For personal current-state queries, resolves the subject through the
 * configured identity, inspects one hop of trusted links and a bounded
 * timeline window, and either passes or returns an explicit insufficient
 * outcome with the original search material preserved as debug evidence.
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
  // Ambiguous or absent mapping fails closed — no guessed subject, no
  // inference from filesystem ownership, profile text, or generic entities.
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

  // Step 3: one-hop inspection of trusted/user_thought links from subject.
  // Candidate NER links are evidence, not authority for a personal
  // current-state answer. At most one graph hop.
  const trustedLinks: LinkRow[] = [
    ...db.getOutgoingLinks(identityPersonSlug),
    ...db.getIncomingLinks(identityPersonSlug),
  ].filter((l) => isTrustedOrUserThought(l.trust_state));

  const trustedNeighbors = new Set<string>();
  for (const link of trustedLinks) {
    const neighbor =
      link.from_slug === identityPersonSlug ? link.to_slug : link.from_slug;
    trustedNeighbors.add(neighbor);
  }

  // Step 4: require a trusted subject-to-topic chain.
  // At least one search result must be the subject itself or a trusted
  // one-hop neighbor. Otherwise the guard cannot prove the answer is about
  // the subject's current state — fail closed, do not present stale
  // reminder-like material as current advice.
  const hasTrustedSubjectConnection = results.some(
    (r) => r.slug === identityPersonSlug || trustedNeighbors.has(r.slug),
  );

  if (!hasTrustedSubjectConnection) {
    return {
      activated: true,
      outcome: "insufficient_current_context",
      subjectSlug: identityPersonSlug,
      reason: "no trusted subject-to-topic chain",
      debugSearchMaterial: results,
    };
  }

  // Step 5: inspect timeline for conflicting dated evidence (bounded budget).
  // Uses semantic event_date only — never pages.updated_at.
  const timeline = db
    .getTimeline(identityPersonSlug)
    .slice(0, MAX_TIMELINE_BUDGET);
  const trustedTimeline = timeline.filter((t) =>
    isTrustedOrUserThought(t.trust_state),
  );

  const hasCompleted = trustedTimeline.some((t) =>
    COMPLETED_MARKER.test(t.summary),
  );
  const hasPending = trustedTimeline.some((t) =>
    PENDING_MARKER.test(t.summary),
  );

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
  return {
    activated: true,
    outcome: "pass",
    subjectSlug: identityPersonSlug,
  };
}

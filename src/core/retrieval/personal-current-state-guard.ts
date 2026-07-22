/**
 * #385 — personal current-state guard for content recall.
 *
 * A deterministic guard that activates ONLY for "current advice" queries
 * (first-person + action predicate). Historical fact recall
 * ("我上次血压是多少") does NOT activate.
 *
 * Safety guarantee (phase 1): for current-advice queries, the guard
 * returns insufficient — it cannot prove current state without structured
 * status/expiry/supersession. BUT when a trusted subject chain exists,
 * the guard reads bounded trusted timeline and returns it as auditable
 * HISTORICAL evidence (with trust_state preserved). The caller includes
 * this evidence in a degraded response so the user can see what was found
 * without it being presented as a confident current recommendation.
 *
 * Non-personal queries short-circuit before any DB work (zero overhead).
 */
import type { CBrainDB, LinkRow } from "../../storage/sqlite.js";
import type { SearchResult } from "./search.js";
import { isPersonalCurrentStateQuery } from "./recall-intent.js";

export type PersonalGuardOutcome = "pass" | "insufficient_current_context";

/** Historical timeline evidence preserved for auditability. */
export interface GuardTimelineEvidence {
  page_slug: string;
  event_date: string;
  summary: string;
  trust_state: string;
}

export interface PersonalGuardResult {
  activated: boolean;
  outcome: PersonalGuardOutcome;
  subjectSlug?: string;
  reason?: string;
  /** Original search material — caller must not present as current advice. */
  debugSearchMaterial?: SearchResult[];
  /**
   * #385 P1#1: trusted historical timeline evidence for auditability.
   * Returned even when outcome is insufficient — the caller includes it
   * in a degraded response so the user sees what was found.
   * trust_state is preserved so user_thought is distinguishable from fact.
   */
  historicalEvidence?: GuardTimelineEvidence[];
}

/** Minimal page lookup — avoids coupling the guard to the full PageManager. */
export interface GuardPageLookup {
  getBySlug(slug: string): { type: string; title?: string; body?: string } | null;
}

const MAX_TRUSTED_LINKS = 10;
const MAX_TIMELINE_BUDGET = 5;

function isEntityPersonType(type: string): boolean {
  return type === "entity/person";
}

export function applyPersonalCurrentStateGuard(
  db: CBrainDB,
  pages: GuardPageLookup,
  query: string,
  results: SearchResult[],
  identityPersonSlug: string | undefined,
): PersonalGuardResult {
  // Step 1: closed-grammar gate — non-personal queries pass through.
  if (!isPersonalCurrentStateQuery(query)) {
    return { activated: false, outcome: "pass" };
  }

  // Step 2: resolve subject deterministically.
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

  // Step 3: bounded trusted one-hop links.
  const trustedLinks: LinkRow[] = db.getBoundedTrustedLinks(identityPersonSlug, MAX_TRUSTED_LINKS);
  const trustedNeighbors = new Set<string>();
  for (const link of trustedLinks) {
    trustedNeighbors.add(link.from_slug === identityPersonSlug ? link.to_slug : link.from_slug);
  }
  const connectedResults = results.filter(
    (r) => r.slug === identityPersonSlug || trustedNeighbors.has(r.slug),
  );

  // P2#4: only claim "no chain" within the bounded inspection scope.
  if (connectedResults.length === 0) {
    return {
      activated: true,
      outcome: "insufficient_current_context",
      subjectSlug: identityPersonSlug,
      reason: "no trusted subject-to-topic chain found in bounded inspection",
      debugSearchMaterial: results,
    };
  }

  // Step 4 (P1#1 + P2#5): read bounded trusted timeline for connected candidates.
  // This evidence is returned for auditability — the user sees what CBrain has,
  // but the response stays degraded (phase-1 cannot prove current state).
  const timelineSlugs = connectedResults.slice(0, 3).map((r) => r.slug);
  const trustedTimeline = db.getBoundedTrustedTimelineForSlugs(timelineSlugs, MAX_TIMELINE_BUDGET);
  const historicalEvidence: GuardTimelineEvidence[] = trustedTimeline.map((t) => ({
    page_slug: t.page_slug,
    event_date: t.event_date,
    summary: t.summary,
    trust_state: t.trust_state ?? "trusted",
  }));

  // Step 5: phase-1 semantic limit — insufficient, but with auditable evidence.
  return {
    activated: true,
    outcome: "insufficient_current_context",
    subjectSlug: identityPersonSlug,
    reason: "phase-1 model cannot prove current state without structured status",
    debugSearchMaterial: results,
    historicalEvidence,
  };
}

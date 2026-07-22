/**
 * #385 — personal current-state guard for content recall.
 *
 * A deterministic guard that activates ONLY for a closed grammar combining
 * first-person phrasing with action-oriented / current-state intent.
 *
 * Safety guarantee (phase 1): the guard ALWAYS FAILS CLOSED for personal
 * current-state queries. The current CBrain model has no structured status,
 * expiry, or supersession contract. Regex matching on free-text timeline
 * summaries ("完成/计划中") cannot prove that a record reflects the subject's
 * CURRENT state about the SPECIFIC need the query asks about. Therefore:
 *
 *   - A 2018 "计划中" record does not prove something is still pending.
 *   - A "已完成提交代码" record does not prove a health checkup is complete.
 *   - A newer record on a related page does not supersede an older one.
 *
 * Per the issue's explicit semantic limit: "phase 1 must not auto-infer
 * closure from recency or word overlap." When current state cannot be
 * proven from structured evidence, the guard returns insufficient and
 * the caller must NOT present search material as current advice.
 *
 * Non-personal queries short-circuit before any DB work (zero overhead).
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
   * The original search material preserved as debug-only evidence.
   * The caller MUST prevent this from being interpreted as current advice.
   */
  debugSearchMaterial?: SearchResult[];
}

/** Minimal page lookup — avoids coupling the guard to the full PageManager. */
export interface GuardPageLookup {
  getBySlug(slug: string): { type: string; title?: string; body?: string } | null;
}

const MAX_TRUSTED_LINKS = 10;

/**
 * Only the canonical entity/person type is accepted as identity.
 * Bare 'entity' (which may be an org/product) is rejected.
 */
function isEntityPersonType(type: string): boolean {
  return type === "entity/person";
}

/**
 * Apply the personal current-state guard.
 *
 * For non-personal queries: returns `{ activated: false, outcome: "pass" }`
 * with zero DB work.
 *
 * For personal current-state queries: resolves the subject through the
 * configured identity, checks the trusted chain for an informative reason
 * field, then ALWAYS returns insufficient — phase-1 cannot prove current
 * state without structured status/expiry/supersession.
 */
export function applyPersonalCurrentStateGuard(
  db: CBrainDB,
  _pages: GuardPageLookup,
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

  const personPage = _pages.getBySlug(identityPersonSlug);
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

  // Step 3: check trusted chain (for informative reason field).
  const trustedLinks: LinkRow[] = db.getBoundedTrustedLinks(identityPersonSlug, MAX_TRUSTED_LINKS);
  const trustedNeighbors = new Set<string>();
  for (const link of trustedLinks) {
    trustedNeighbors.add(link.from_slug === identityPersonSlug ? link.to_slug : link.from_slug);
  }
  const hasTrustedConnection = results.some(
    (r) => r.slug === identityPersonSlug || trustedNeighbors.has(r.slug),
  );

  // Step 4: phase-1 semantic limit — ALWAYS fail closed.
  // The current model cannot prove current state from free-text timeline.
  // Even when a trusted chain exists, the guard cannot determine whether
  // the search material reflects the subject's CURRENT status about the
  // specific need the query asks about. Structured state/expiry/supersession
  // is a prerequisite for a pass path — see issue non-goals and semantic limit.
  return {
    activated: true,
    outcome: "insufficient_current_context",
    subjectSlug: identityPersonSlug,
    reason: hasTrustedConnection
      ? "phase-1 model cannot prove current state without structured status"
      : "no trusted subject-to-topic chain",
    debugSearchMaterial: results,
  };
}

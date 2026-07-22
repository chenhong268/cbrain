/**
 * #385 — personal current-state guard for content recall.
 *
 * A deterministic guard that activates for explicit current advice or
 * controlled medication current-state queries (first-person + closed grammar).
 * Historical fact recall ("我上次血压是多少") does NOT activate.
 *
 * Safety guarantee (phase 1): the guard returns insufficient — it cannot
 * prove current state without structured status/expiry/supersession. When a
 * trusted subject chain exists, it returns bounded same-subject context
 * candidates with explicit provenance. Topic relevance remains unverified;
 * the caller labels them as candidates rather than current evidence.
 *
 * Non-personal queries short-circuit before any DB work (zero overhead).
 */
import type { CBrainDB, LinkRow } from "../../storage/sqlite.js";
import { isSupportedSemanticEventDate } from "../../storage/sqlite.js";
import type { SearchResult } from "./search.js";
import { isPersonalCurrentStateQuery } from "./recall-intent.js";

export type PersonalGuardOutcome = "pass" | "insufficient_current_context";
export type PersonalGuardGap = "identity_mapping" | "subject_relation" | "structured_state";
export type GuardProvenance = "trusted" | "user_thought";

/** Same-subject context candidate; topic relevance is intentionally unverified. */
export interface SubjectContextCandidate {
  /** Internal auditable reference — the real page slug. Kept in raw for traceability. */
  source_page_slug: string;
  /** Safe human-readable label projected to structured surfaces. */
  source_title: string;
  event_date: string;
  summary: string;
  provenance: GuardProvenance;
  topic_relevance: "unverified";
}
export interface PersonalGuardResult {
  activated: boolean;
  outcome: PersonalGuardOutcome;
  subjectSlug?: string;
  gap?: PersonalGuardGap;
  reason?: string;
  /** Original search material — caller must not present as current advice. */
  debugSearchMaterial?: SearchResult[];
  /**
   * #385: bounded same-subject context candidates for auditability.
   * These are not asserted to be related to the query topic or current state.
   */
  subjectContextCandidates?: SubjectContextCandidate[];
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
      gap: "identity_mapping",
      reason: "no identity mapping configured",
      debugSearchMaterial: results,
    };
  }

  const personPage = pages.getBySlug(identityPersonSlug);
  if (!personPage) {
    return {
      activated: true,
      outcome: "insufficient_current_context",
      gap: "identity_mapping",
      reason: "identity page not found",
      debugSearchMaterial: results,
    };
  }

  if (!isEntityPersonType(personPage.type)) {
    return {
      activated: true,
      outcome: "insufficient_current_context",
      gap: "identity_mapping",
      reason: "identity is not entity/person",
      debugSearchMaterial: results,
    };
  }

  // Step 3: bounded trusted one-hop links.
  const trustedLinks: LinkRow[] = db.getBoundedTrustedLinks(identityPersonSlug, MAX_TRUSTED_LINKS);
  const trustedNeighbors = new Set<string>();
  for (const link of trustedLinks) {
    const neighbor: string = link.from_slug === identityPersonSlug ? link.to_slug : link.from_slug;
    if (neighbor !== identityPersonSlug) trustedNeighbors.add(neighbor);
  }
  const connectedResults = results.filter((r) => trustedNeighbors.has(r.slug));
  // P2#4: only claim "no chain" within the bounded inspection scope.
  if (connectedResults.length === 0) {
    return {
      activated: true,
      outcome: "insufficient_current_context",
      subjectSlug: identityPersonSlug,
      gap: "subject_relation",
      reason: "no trusted subject-to-topic chain found in bounded inspection",
      debugSearchMaterial: results,
    };
  }

  // Step 4 (P1#2): read bounded timeline for ALL trusted neighbors, not just
  // search-connected candidates. The results are same-subject candidates only:
  // link trust does not establish relevance to this query's topic.
  const timelineSlugs = [identityPersonSlug, ...trustedNeighbors];
  const trustedTimeline = db.getBoundedTrustedTimelineForSlugs(timelineSlugs, MAX_TIMELINE_BUDGET);
  const subjectContextCandidates: SubjectContextCandidate[] = trustedTimeline
    .filter((t) => (t.trust_state === "trusted" || t.trust_state === "user_thought") && isSupportedSemanticEventDate(t.event_date))
    .map((t) => {
      const page = pages.getBySlug(t.page_slug);
      return {
        source_page_slug: t.page_slug,
        source_title: page?.title ?? t.page_slug,
        event_date: t.event_date.trim(),
        summary: t.summary,
        provenance: t.trust_state as GuardProvenance,
        topic_relevance: "unverified" as const,
      };
    });
  // state/supersession is not structurally proven. This gap is distinct from
  // a missing subject-to-topic relation even when candidates are empty.
  return {
    activated: true,
    outcome: "insufficient_current_context",
    subjectSlug: identityPersonSlug,
    gap: "structured_state",
    reason: "trusted subject-to-topic chain found; current state lacks structured status",
    debugSearchMaterial: results,
    subjectContextCandidates,
  };
}

/**
 * #385 — personal current-state guard for content recall.
 *
 * A deterministic, bounded guard that activates ONLY for a closed grammar
 * combining first-person phrasing with action-oriented / current-state
 * intent. When activated it verifies a trusted subject-to-topic chain
 * AND requires per-candidate trusted dated current-state EVIDENCE —
 * not just any dated event, but one whose semantics express a current
 * state (completed/pending/action status).
 *
 * Safety guarantee (phase 1): the guard FAILS CLOSED. It returns
 * insufficient-current-context if ANY of these cannot be proven:
 *   - configured identity uniquely mapping to entity/person
 *   - trusted (trusted/user_thought) subject-to-topic link
 *   - PER-CANDIDATE trusted dated evidence whose semantics express a
 *     current state (completed or pending marker). A generic historical
 *     event like "首次创建" does NOT qualify.
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

/** Timeline evidence verified by the guard for a passing candidate. */
export interface GuardTimelineEvidence {
  page_slug: string;
  event_date: string;
  summary: string;
}

export interface PersonalGuardResult {
  activated: boolean;
  outcome: PersonalGuardOutcome;
  subjectSlug?: string;
  reason?: string;
  debugSearchMaterial?: SearchResult[];
  filteredResults?: SearchResult[];
  /**
   * #385 P1#2: the verified per-candidate timeline evidence that authorized
   * the pass. The caller MUST include this in the response so the
   * authorization is auditable and the semantic dates are visible.
   */
  verifiedTimeline?: GuardTimelineEvidence[];
}

/** Minimal page lookup — avoids coupling the guard to the full PageManager. */
export interface GuardPageLookup {
  getBySlug(slug: string): { type: string; title?: string; body?: string } | null;
}

const MAX_TRUSTED_LINKS = 10;
const MAX_TIMELINE_BUDGET = 5;

// ── Negation-aware status classification (P2#4) ──
//
// "还没完成/没有完成/not completed" must be classified as PENDING, not
// COMPLETED. The approach: detect negation+completion patterns as pending
// FIRST, then test for genuine completion. No string stripping — stripping
// would leave bare "完成" and cause a false completed match.

/** Negation + completion = pending (还没完成/没有完成/not completed/尚未完成). */
const NEGATED_COMPLETION = /还没(有)?完成|没有完成|尚未完成|not\s+completed|hasn'?t\s+completed|haven'?t\s+completed/i;

/** Genuine completion — "完成" NOT preceded by negation chars. */
const COMPLETED_MARKER = /(?:^|[^未待需还])完成|已完成|done|completed|finished|已结束|结案|已做/i;

/** Pending / open / scheduled state. */
const PENDING_MARKER = /待办|未完成|计划中|待复查|需复查|pending|scheduled|upcoming|todo|待完成|需完成|还没(有)?完成|没有完成|尚未完成/i;

function isCompleted(summary: string): boolean {
  // Negated completion is NOT completed.
  if (NEGATED_COMPLETION.test(summary)) return false;
  return COMPLETED_MARKER.test(summary);
}

function isPending(summary: string): boolean {
  // Negated completion IS pending.
  if (NEGATED_COMPLETION.test(summary)) return true;
  return PENDING_MARKER.test(summary);
}

/**
 * #385 P1#1: does a timeline entry express current-state semantics?
 * Must match completed OR pending marker. A generic historical event
 * (首次创建/建立/记录) does NOT qualify.
 */
function isCurrentStateEvidence(entry: { summary: string }): boolean {
  return isCompleted(entry.summary) || isPending(entry.summary);
}

function isEntityPersonType(type: string): boolean {
  return type === "entity/person";
}

/**
 * Apply the personal current-state guard.
 */
export function applyPersonalCurrentStateGuard(
  db: CBrainDB,
  pages: GuardPageLookup,
  query: string,
  results: SearchResult[],
  identityPersonSlug: string | undefined,
): PersonalGuardResult {
  // Step 1: closed-grammar gate.
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

  // Step 4: per-candidate trusted connection filter.
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

  // Step 5 (P1#1): per-candidate current-state evidence verification.
  // Each candidate must have ITS OWN trusted dated timeline entry that
  // expresses a current STATE (completed or pending). A generic historical
  // event does NOT qualify — the guard cannot prove current status from it.
  const verifiedResults: SearchResult[] = [];
  const verifiedTimeline: GuardTimelineEvidence[] = [];
  for (const candidate of connectedResults) {
    const candidateTimeline = db.getBoundedTrustedTimelineForSlugs([candidate.slug], MAX_TIMELINE_BUDGET);
    // P1#1: filter to current-state evidence only.
    const currentStateEntries = candidateTimeline.filter(isCurrentStateEvidence);
    if (currentStateEntries.length === 0) continue; // no current-state proof

    // P2#4: check for conflicting evidence (after negation normalization).
    const cCompleted = currentStateEntries.some((t) => isCompleted(t.summary));
    const cPending = currentStateEntries.some((t) => isPending(t.summary));
    if (cCompleted && cPending) continue; // unresolved conflict → skip

    verifiedResults.push(candidate);
    for (const t of currentStateEntries.slice(0, 2)) {
      verifiedTimeline.push({ page_slug: t.page_slug, event_date: t.event_date, summary: t.summary });
    }
  }

  if (verifiedResults.length === 0) {
    return {
      activated: true,
      outcome: "insufficient_current_context",
      subjectSlug: identityPersonSlug,
      reason: "no candidate with trusted current-state evidence",
      debugSearchMaterial: results,
    };
  }

  return {
    activated: true,
    outcome: "pass",
    subjectSlug: identityPersonSlug,
    filteredResults: verifiedResults,
    verifiedTimeline,
  };
}

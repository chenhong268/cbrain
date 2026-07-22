/**
 * #232 — temporal / historical recall intent detection.
 *
 * Pure regex, no LLM. Reuses keyword roots already in the codebase
 * (`QueryRouter.TEMPORAL_KEYWORDS` in query-router.ts, frontdoor content/grounded
 * signals in frontdoor-router.ts) and fills the gaps (`变化/后来/曾经/前任/现任`).
 * Shared by `deep_recall` and `cbrain_recall` so the two entry points trigger
 * evidence completion consistently.
 */

export type EvidenceMode = "auto" | "on" | "off";

export interface TemporalIntent {
  /** 之前/上次/最近/后来/曾经/时间线/变化… — "when/what-changed" queries. */
  temporal: boolean;
  /** 当时为什么这么定/怎么设计的/原来怎么说… — "why was this decided" history. */
  history: boolean;
  /** 前任/现任/之前vs现在… — former/current comparison. */
  formerCurrent: boolean;
}

const TEMPORAL_RE = /(之前|上次|下次|上周|这周|最近|后来|曾经|以前|当时|原来|时间线|什么时候|变化|进展|动态|last time|previously|before|what changed|changed)/;
const HISTORY_RE = /(为什么这么定|当时.*(怎么设计|为什么选|怎么定|怎么做|怎么说)|之前.*(怎么设计|为什么选|具体怎么说|为什么这么定)|原来怎么说|怎么设计的|why.*(decided|chosen)|what was the reasoning|how was.*decided)/;
const FORMER_CURRENT_RE = /(前任|现任|原任|之前.{0,8}现在|原来.{0,8}现在|former|current|previous.{0,8}now)/;
const STANDALONE_TEMPORAL_FRAMING_RE = /^(上次|之前|最近|以前|后来|曾经|当时|原来|previously|before)$/i;

/** Closed, anchored framing grammar for deterministic lexical support. */
export function isStandaloneTemporalFramingToken(token: string): boolean {
  if (typeof token !== "string") return false;
  try {
    return STANDALONE_TEMPORAL_FRAMING_RE.test(token.normalize("NFKC").trim());
  } catch {
    return false;
  }
}

export function detectTemporalIntent(query: string): TemporalIntent {
  return {
    temporal: TEMPORAL_RE.test(query),
    history: HISTORY_RE.test(query),
    formerCurrent: FORMER_CURRENT_RE.test(query),
  };
}

/**
 * Whether to run evidence completion.
 * - `off` → never
 * - `on`  → always
 * - `auto`→ only when the query carries temporal/history/former-current intent
 *           (so plain entity lookup stays fast and unchanged).
 */
export function shouldCompleteEvidence(query: string, mode: EvidenceMode): boolean {
  if (mode === "off") return false;
  if (mode === "on") return true;
  const i = detectTemporalIntent(query);
  return i.temporal || i.history || i.formerCurrent;
}

// ─── #385: personal current-state guard intent detection ──────────────

/**
 * First-person phrasing — the speaker refers to themselves as the subject.
 * `我(?!们)` excludes the collective "我们" while keeping "我的/我该/我最近".
 * Combined with action intent via AND, false positives fail closed safely.
 */
const FIRST_PERSON_CN = /我(?!们)/;
const FIRST_PERSON_EN = /\b(?:I|my|mine|myself)\b/;

export function isFirstPersonQuery(query: string): boolean {
  try {
    const normalized = query.normalize("NFKC").trim();
    return FIRST_PERSON_CN.test(normalized) || FIRST_PERSON_EN.test(normalized);
  } catch {
    return false;
  }
}

/**
 * Action-oriented / current-state intent for personal management.
 * Narrower than general temporal (#232): focuses on "what should I do now /
 * is something due / current status" rather than historical "what happened".
 */
const PERSONAL_ACTION_CN = /该不该|要不要|还要不要|需不需要|该去|该做|复查|体检|检查|吃药|用药|就诊|看病|预约|到期|过期|上次|最近|接下来|什么时候|多久|定期|周期|频率/;
const PERSONAL_ACTION_EN = /\b(?:should\s+i|do\s+i\s+need|is\s+it\s+time|overdue|due\s+for|checkup|appointment|medication|when\s+should\s+i|how\s+long|last\s+time|recently|next)\b/i;

/**
 * #385 — closed grammar for personal current-state queries.
 *
 * Activates the personal current-state guard only when BOTH conditions hold:
 * 1. First-person phrasing (the speaker is the subject)
 * 2. Action-oriented / current-state intent (not plain historical lookup)
 *
 * Deliberately narrow: avoids turning ordinary temporal queries into
 * unbounded graph traversal. When the grammar fires but the guard cannot
 * prove a trusted subject-to-topic chain, it fails closed to an explicit
 * insufficient-current-context outcome rather than presenting stale
 * reminder-like search material as current advice.
 */
export function isPersonalCurrentStateQuery(query: string): boolean {
  if (!isFirstPersonQuery(query)) return false;
  try {
    const normalized = query.normalize("NFKC").trim();
    return PERSONAL_ACTION_CN.test(normalized) || PERSONAL_ACTION_EN.test(normalized);
  } catch {
    return false;
  }
}

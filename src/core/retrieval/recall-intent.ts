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
const FIRST_PERSON_EN = /\b(?:I|my|mine|myself)\b/i;

export function isFirstPersonQuery(query: string): boolean {
  try {
    const normalized = query.normalize("NFKC").trim();
    return FIRST_PERSON_CN.test(normalized) || FIRST_PERSON_EN.test(normalized);
  } catch {
    return false;
  }
}

/**
 * #385 — personal current-state guard intent detection.
 *
 * The guard activates ONLY for "current advice" queries — the speaker
 * asks whether something should be done NOW or IS currently due/active.
 * Historical fact recall ("我上次血压是多少") must NOT trigger the guard.
 *
 * Two tiers:
 * - DIRECT action predicates: 该不该/需不需要/到期/overdue/am I currently… —
 *   trigger alone. These ask for a RECOMMENDATION or CURRENT STATUS.
 * - TIME markers (最近/上次) co-occurring with ACTION COMPOUND verbs
 *   (复查/看病/吃药/治疗…) — trigger together. Domain NOUNS alone
 *   (血压/睡眠/体检/血糖) do NOT trigger; they indicate fact recall.
 */

/** CN predicates that ask for current advice/status. */
const ACTION_PREDICATE_CN = /该不该|要不要|还要不要|需不需要|该去|该做|该吃|该看|该补|该换|该买|到期|过期|是否到期|什么时候到期|需不需要复查|要不要去看|该不该去|该不该吃|要不要复查|需不需要去|要不要吃药/;
/** EN predicates that ask for current advice/status — includes r6 current-state phrases. */
const ACTION_PREDICATE_EN = /\b(?:should\s+i|do\s+i\s+need|is\s+it\s+time|overdue|due\s+for|when\s+should\s+i|need\s+to\s+go|need\s+to\s+take|am\s+i\s+currently|currently\s+taking|currently\s+on|what\s+am\s+i\s+taking|still\s+taking)\b/i;

/**
 * ACTION COMPOUND verbs — multi-char phrases that express a health
 * management ACTION (复查/看病/吃药/治疗/随访/监测/用药/就诊), NOT bare
 * nouns (血压/睡眠/体检/血糖/心率/症状/剂量) that appear in fact recall.
 * r6: removed 体检/睡眠/血压/血糖/心率/症状/剂量/锻炼/作息/康复/恢复/过敏/疫苗/续签/报税
 * — these are topic nouns, not action predicates.
 */
const DOMAIN_ACTION_CN = /复查|看病|就诊|吃药|用药|治疗|随访|监测/;
const DOMAIN_ACTION_EN = /\b(?:checkup|follow-?up|prescription|therapy)\b/i;

const TIME_MARKER_CN = /上次|最近|什么时候|多久/;
const TIME_MARKER_EN = /\b(?:last\s+time|recently|how\s+long)\b/i;

function hasActionPredicate(query: string): boolean {
  return ACTION_PREDICATE_CN.test(query) || ACTION_PREDICATE_EN.test(query);
}

function hasTimeMarkerWithDomainAction(query: string): boolean {
  const hasTime = TIME_MARKER_CN.test(query) || TIME_MARKER_EN.test(query);
  if (!hasTime) return false;
  return DOMAIN_ACTION_CN.test(query) || DOMAIN_ACTION_EN.test(query);
}

/**
 * #385 — closed grammar for personal current-state (current-advice) queries.
 *
 * Activates ONLY when BOTH conditions hold:
 * 1. First-person phrasing (the speaker is the subject)
 * 2. Current-advice intent:
 *    - an explicit ACTION PREDICATE (该不该/需不需要/到期/overdue/am I
 *      currently…), OR
 *    - a TIME marker co-occurring with a DOMAIN ACTION compound verb
 *      (复查/看病/吃药/checkup/follow-up…).
 *
 * Fact-recall queries with domain nouns (血压/睡眠/体检/血糖) do NOT
 * trigger — "我上次血压是多少" is historical fact recall, not current advice.
 */
export function isPersonalCurrentStateQuery(query: string): boolean {
  if (!isFirstPersonQuery(query)) return false;
  try {
    const normalized = query.normalize("NFKC").trim();
    return hasActionPredicate(normalized) || hasTimeMarkerWithDomainAction(normalized);
  } catch {
    return false;
  }
}

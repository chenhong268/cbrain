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
 * The guard activates for explicit advice predicates OR a narrowly
 * controlled medication current-state query. Generic current-state
 * grammar remains excluded: "What am I currently reading?" must not
 * activate.
 */

/**
 * CN advice predicates — request a recommendation or current status.
 * Must be a PREDICATE (该不该/到期/该吃…), NOT a noun or time marker.
 */
const ACTION_PREDICATE_CN = /该不该|要不要|还要不要|需不需要|该去|该做|该吃|该看|该补|该换|该买|到期|过期|是否到期|什么时候到期|需不需要复查|要不要去看|该不该去|该不该吃|要不要复查|需不需要去|要不要吃药/;

/**
 * EN advice predicates — request a recommendation or current status.
 * Generic "am I currently" / "still taking" phrases are intentionally
 * absent; they are too broad without a controlled domain.
 */
const ACTION_PREDICATE_EN = /\b(?:should\s+i|do\s+i\s+need|is\s+it\s+time|overdue|due\s+for|when\s+should\s+i|need\s+to\s+go|need\s+to\s+take)\b/i;

/**
 * #385 r12: medication current-state detection via closed clause grammar.
 *
 * The first-person subject, medication verb, and inquiry structure MUST be
 * in the same contiguous clause. No full-text keyword co-occurrence, no
 * exclusion black-lists (those can suppress real current-state queries that
 * happen to mention "records" or "list" as a trailing request).
 *
 * CN: every alternative starts with 我 bound to the medication verb:
 *   我(time)?(prog)?吃(着)?(什么)?药         "我现在在吃什么药"
 *   我(time)?(verb)的是什么(药)?              "我现在吃的是什么药"
 *   我(time)?(服用|吃|用)的(药物|药)(有哪些)   "我现在服用的药物有哪些"
 *   我(time)?有(在)?(吃|服)药吗               "我有在吃药吗"
 *   我(time)?(是否|有无|有没有)(用|服|吃)药    "我目前是否用药"
 *
 * EN: every pattern is anchored to end-of-clause ($), so the verb must be
 * the predicate terminal (modulo time adverbs + punctuation):
 *   what medication(s) am I (currently) on/taking [tail]$
 *   am I (currently) on/taking (any) medication [tail]$
 *   what medication(s) do I (currently) take [tail]$
 *   do I (currently) take (any) medication [tail]$
 */
const MED_CLAUSE_CN =
  /我(?:现在|目前|当前|当下)?(?:正在|在)?(?:吃|服用|用|服)(?:着)?(?:什么|哪些|哪种)?(?:药|药物|药品)/;
const MED_CLAUSE_CN_REL =
  /我(?:现在|目前|当前|当下)?(?:吃|服|用)的是什么(?:药|药物)?|我(?:现在|目前|当前|当下)?(?:服用|吃|用)的(?:药物|药)(?:有哪些|是什么)/;
const MED_CLAUSE_CN_YN =
  /我(?:现在|目前|当前|当下)?有(?:在)?(?:吃|服)药吗|我(?:现在|目前|当前|当下)?(?:是否|有无|有没有)(?:用|服|吃)(?:药|过药)?/;

/** EN clause tail: optional time adverb + punctuation + end-of-string. */
const EN_TAIL = /(?:\s+(?:right\s+now|currently|today|now|at\s+the\s+moment))?\s*[?.!]?\s*$/i;
const MED_WHAT_ON_EN = new RegExp(
  "\\b(?:what|which)\\s+(?:medications?|medicines?|prescriptions?)\\s+am\\s+i\\s+(?:currently\\s+)?(?:on|taking)" + EN_TAIL.source,
  "i",
);
const MED_AM_I_EN = new RegExp(
  "\\bam\\s+i\\s+(?:currently\\s+)?(?:on|taking)\\s+(?:any\\s+)?(?:medications?|medicines?|prescriptions?|meds?)" + EN_TAIL.source,
  "i",
);
const MED_WHAT_DO_EN = new RegExp(
  "\\b(?:what|which)\\s+(?:medications?|medicines?|prescriptions?)\\s+do\\s+i\\s+(?:currently\\s+)?take" + EN_TAIL.source,
  "i",
);
const MED_DO_I_EN = new RegExp(
  "\\bdo\\s+i\\s+(?:currently\\s+)?take\\s+(?:any\\s+)?(?:medications?|medicines?|prescriptions?|meds?)" + EN_TAIL.source,
  "i",
);

function isMedicationCurrentStateQuery(query: string): boolean {
  // CN: clause-bound — 我 must be the subject of the medication verb.
  if (MED_CLAUSE_CN.test(query) || MED_CLAUSE_CN_REL.test(query) || MED_CLAUSE_CN_YN.test(query)) {
    return true;
  }
  // EN: end-anchored clauses — verb must be the clause terminal.
  if (MED_WHAT_ON_EN.test(query) || MED_AM_I_EN.test(query) || MED_WHAT_DO_EN.test(query) || MED_DO_I_EN.test(query)) {
    return true;
  }
  return false;
}

export function isPersonalCurrentStateQuery(query: string): boolean {
  if (!isFirstPersonQuery(query)) return false;
  try {
    const normalized = query.normalize("NFKC").trim();
    return (
      ACTION_PREDICATE_CN.test(normalized) ||
      ACTION_PREDICATE_EN.test(normalized) ||
      isMedicationCurrentStateQuery(normalized)
    );
  } catch {
    return false;
  }
}

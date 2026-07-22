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
 * #385 r10: medication current-state detection via closed clause grammar.
 *
 * CN: requires a medication ACTION verb (吃/服/服用/用药/服药/在吃/用着) +
 *     an inquiry structure (什么/哪些/是否/有无/吗), NOT generic 是什么/有哪些.
 *     Excludes 研究/记录/软件/文章/关注 — these are about medication as a
 *     research subject, not the speaker's current medication state.
 *
 * EN: matches only complete clause structures — "what medication am I on",
 *     "am I currently taking medication", "do I currently take medication".
 *     Bare "on" / "are" keyword co-occurrence is NOT a signal.
 */
const MED_VERB_CN = /(?:在吃|在服用|用着|吃着|服用|吃药|服药|用药|吃药|吃|服|用)/;
const MED_NOUN_CN = /(?:药|药物|药品|处方)/;
const MED_INQUIRY_CN = /(?:什么|哪些|是否|有无|吗|呢|哪种)/;
const MED_CURRENT_CN = /(?:现在|目前|当前|当下|正在)/;
const MED_EXCLUSION_CN = /(?:记录|软件|历史|管理系统?|清单|列表|明细|账单|费用|花了多少|研究|文章|关注|论文|参考|资料|笔记)/;

/** EN: "what medication am I on/taking" — complete clause, first person present. */
const MED_WHAT_CLAUSE_EN =
  /\b(?:what|which)\s+(?:medications?|medicines?|prescriptions?)\s+(?:am\s+i|do\s+i\s+(?:currently\s+)?take|are\s+you\s+taking)\b/i;
/** EN: "am I currently on/taking (any) medication" — complete clause. */
const MED_AM_I_CLAUSE_EN =
  /\bam\s+i\s+(?:currently\s+)?(?:on|taking)\s+(?:any\s+)?(?:medications?|medicines?|prescriptions?|my\s+meds?)\b/i;
/** EN: "do I currently take medication" — complete clause. */
const MED_DO_I_CLAUSE_EN =
  /\bdo\s+i\s+(?:currently\s+)?take\s+(?:any\s+)?(?:medications?|medicines?|prescriptions?)\b/i;
const MED_EXCLUSION_EN = /\b(?:history|record|software|list|log|cost|spent|paid|app|tracker?|article|paper|notes?|discussed|available|research|study|wrote?|reading)\b/i;

function isMedicationCurrentStateQuery(query: string): boolean {
  // CN: medication verb + medication noun + inquiry structure, minus exclusions.
  // Current marker is optional but strengthens the signal.
  if (MED_VERB_CN.test(query) && MED_NOUN_CN.test(query) && MED_INQUIRY_CN.test(query)) {
    return !MED_EXCLUSION_CN.test(query);
  }
  // CN: "是否用药" / "有服药吗" / "有在吃药吗" — the noun IS the verb compound.
  if (MED_CURRENT_CN.test(query) && /(?:是否|有无|有没有).{0,4}(?:用药|服药|吃药|在吃药)/.test(query)) {
    return !MED_EXCLUSION_CN.test(query);
  }
  if (/(?:有|在).{0,2}(?:吃药|服药|用药|服用).{0,2}(?:吗|呢)/.test(query)) {
    return !MED_EXCLUSION_CN.test(query);
  }
  // EN: only match complete clause structures
  if (MED_WHAT_CLAUSE_EN.test(query) || MED_AM_I_CLAUSE_EN.test(query) || MED_DO_I_CLAUSE_EN.test(query)) {
    return !MED_EXCLUSION_EN.test(query);
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

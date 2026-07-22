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
 * #385 r13: personal current-state guard intent detection.
 *
 * Architecture: split the query into clauses by CN/EN punctuation, then
 * apply subject-bound closed grammar to EACH clause individually.
 * No full-text keyword co-occurrence. No exclusion black-lists.
 * The first-person pronoun and the predicate must be in the SAME clause.
 */

/** Split a query into individual clauses by sentence/clause punctuation. */
function splitClauses(query: string): string[] {
  return query
    .split(/[？?!.！。；;\n，,、]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ── CN advice: 我 must be the subject ──

/** 我 + (time?) + predicate — direct subject, no intervening noun. */
const ADVICE_CN_DIRECT =
  /我(?:现在|目前|当前)?(?:该不该|要不要|还要不要|需不需要|该去|该做|该吃|该看|该补|该换|该买|需不需要复查|要不要去看|该不该去|该不该吃|要不要复查|需不需要去|要不要吃药)/;
/** 我的 + (health topic) + 到期/过期 — possessive health subject only. */
const ADVICE_CN_POSSESSIVE =
  /我的(?:体检|复查|检查|就诊|年检|签证|护照|许可|续签|药)(?:是否)?(?:到期|过期)/;

// ── EN advice: I/my must be the subject ──

/** (should|do) I ... — first person as grammatical subject. */
const ADVICE_EN_SUBJECT =
  /\b(?:should\s+i\b|do\s+i\s+need\b|do\s+i\s+need\s+to\s+(?:go|see|take)|is\s+it\s+time\s+(?:for|to)\b)/i;
/** my + (health topic) + overdue/due — possessive health subject. */
const ADVICE_EN_POSSESSIVE =
  /\bis\s+my\s+(?:checkup|appointment|exam|physical|medication|prescription)\s+(?:overdue|due)\b/i;
/** am I overdue/due for — first person subject. */
const ADVICE_EN_AM_I =
  /\bam\s+i\s+(?:overdue|due\s+for)\b/i;

// ── CN medication: 我 + verb + object in one clause, object has boundary ──

/** 我 + (time?) + (prog?) + 吃/服/用 + (着?) + (什么/哪些?) + med-object. */
const MED_CN_WHAT =
  /我(?:现在|目前|当前|当下)?(?:正在|在)?(?:吃|服用|用|服)(?:着)?(?:什么|哪些|哪种)?(?:药|药物|药品|处方)(?!膳|剂|妆|材|丸|膏|方|酒|店|房|油|费|棉|水|检|理)/;
/** 我 + (time?) + verb + 的是 + (什么/哪些) + med-object. */
const MED_CN_RELATIVE =
  /我(?:现在|目前|当前|当下)?(?:服用|吃|服|用)的是(?:什么|哪些)?(?:药|药物|药品)(?!膳|剂|妆|材|丸|膏|方|酒|店|房|油|费|棉|水|检|理)/;
/** 我 + (time?) + (服用|吃|用) + 的 + (药物|药) + (有哪些|是什么). */
const MED_CN_LIST =
  /我(?:现在|目前|当前|当下)?(?:服用|吃|用)的(?:药物|药)(?:有哪些|是什么)/;
/** 我 + (time?) + 有(在)?(吃|服)药 — yes/no inquiry. */
const MED_CN_YN_1 =
  /我(?:现在|目前|当前|当下)?有(?:在)?(?:吃|服)药/;
/** 我 + (time?) + 有没有(在)?(吃|服)药. */
const MED_CN_YN_2 =
  /我(?:现在|目前|当前|当下)?有没有(?:在)?(?:吃|服)药/;
/** 我 + (time?) + (是否|有无)(用|服|吃)(药|过药). */
const MED_CN_YN_3 =
  /我(?:现在|目前|当前|当下)?(?:是否|有无)(?:用|服|吃)(?:药|过药)/;

// ── EN medication: complete first-person clauses, per-clause anchored ──

/**
 * After `on|taking`, allow: end-of-clause, `for <indication>`, or the
 * medication object itself (for the `am I taking medication` pattern).
 * Disallow bare nouns that change meaning: notes, photos, etc.
 */
const MED_EN_TAIL = /(?:\s+(?:currently|right\s+now|now|today))?(?:\s+for\s+[\w\s]+?)?\s*$/i;
const MED_WHAT_ON_CLAUSE = new RegExp(
  "\\b(?:what|which)\\s+(?:medications?|medicines?|prescriptions?)\\s+am\\s+i\\s+(?:currently\\s+)?(?:on|taking)" + MED_EN_TAIL.source,
  "i",
);
const MED_AM_I_CLAUSE = new RegExp(
  "\\bam\\s+i\\s+(?:currently\\s+)?(?:on|taking)\\s+(?:any\\s+)?(?:medications?|medicines?|prescriptions?|meds?)" + MED_EN_TAIL.source,
  "i",
);
const MED_WHAT_DO_CLAUSE = new RegExp(
  "\\b(?:what|which)\\s+(?:medications?|medicines?|prescriptions?)\\s+do\\s+i\\s+(?:currently\\s+)?take" + MED_EN_TAIL.source,
  "i",
);
const MED_DO_I_CLAUSE = new RegExp(
  "\\bdo\\s+i\\s+(?:currently\\s+)?take\\s+(?:any\\s+)?(?:medications?|medicines?|prescriptions?|meds?)" + MED_EN_TAIL.source,
  "i",
);

/** Check a single clause for personal current-state intent. */
function isPersonalCurrentStateClause(clause: string): boolean {
  // CN advice: subject-bound within this clause
  if (ADVICE_CN_DIRECT.test(clause) || ADVICE_CN_POSSESSIVE.test(clause)) return true;
  // EN advice: subject-bound within this clause
  if (ADVICE_EN_SUBJECT.test(clause) || ADVICE_EN_POSSESSIVE.test(clause) || ADVICE_EN_AM_I.test(clause)) return true;
  // CN medication: 我 bound to verb, object has boundary
  if (
    MED_CN_WHAT.test(clause) || MED_CN_RELATIVE.test(clause) || MED_CN_LIST.test(clause) ||
    MED_CN_YN_1.test(clause) || MED_CN_YN_2.test(clause) || MED_CN_YN_3.test(clause)
  ) return true;
  // EN medication: complete first-person clause
  if (
    MED_WHAT_ON_CLAUSE.test(clause) || MED_AM_I_CLAUSE.test(clause) ||
    MED_WHAT_DO_CLAUSE.test(clause) || MED_DO_I_CLAUSE.test(clause)
  ) return true;
  return false;
}

export function isPersonalCurrentStateQuery(query: string): boolean {
  try {
    const normalized = query.normalize("NFKC").trim();
    for (const clause of splitClauses(normalized)) {
      if (isPersonalCurrentStateClause(clause)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

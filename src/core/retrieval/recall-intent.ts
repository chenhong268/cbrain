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
 * #385 r14: personal current-state guard intent detection.
 *
 * INVARIANTS (per Codex r13 review):
 *   1. Every matching alternative is self-contained: it carries its own
 *      first-person subject AND its inquiry structure — no external
 *      isFirstPersonQuery() gate, no exclusion black-lists.
 *   2. Clauses are split ONLY by sentence terminators (？！。；\n).
 *      Commas are intra-clause; they stay inside the clause for matching.
 *
 * CN medication patterns use a boundary assertion on the medication object:
 * `药/药物/药品` must be followed by a sentence/clause boundary
 * (？ ? ， , 。 ！ \n | end). This rejects 药膳/药盒/药记录 without a suffix
 * black-list. Commas inside the clause are absorbed by [，、,\s]* between
 * grammatical components so parentheticals don't break matching.
 *
 * EN medication patterns use `.*?` to bridge parentheticals between
 * `am I` / `do I` and `on|taking|take`, and a positive tail white-list
 * (indications, dosing times, time adverbs) anchored to clause end.
 */

/** Split ONLY by sentence terminators — never by commas. */
function splitClauses(query: string): string[] {
  return query
    .split(/[？?!.！。；;\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** CN intra-clause gap: absorbs commas, enumerations, spaces between components. */
const G = "[，、,\\s]*";

/**
 * CN medication object boundary: after 药/药物/药品, the next character must
 * NOT be a topic-changing character that turns "medication" into a
 * medication-related artifact (record/software/history/pill-box/food/etc).
 * This is a single-character negative lookahead, applied uniformly to ALL
 * CN medication branches. No word-level black-list, no positive enumeration.
 */
const MED_OBJ_END = "(?![记软历清列明账费管文论参资笔识研关实图盒膳剂妆材丸膏方酒店房油棉水检理])";

/** CN medication compound: verb + object. */
const MED_CN_OBJ = "(?:药|药物|药品)";
const MED_CN_VERB_OBJ = "(?:吃|服|用|服用)(?:药|药物|药品)";

// ── CN advice: 我 must be the subject ──

const ADVICE_CN_DIRECT = new RegExp(
  "我" + G + "(?:现在|目前|当前)?" + G + "(?:该不该|要不要|还要不要|需不需要|该去|该做|该吃|该看|该补|该换|该买|需不需要复查|要不要去看|该不该去|该不该吃|要不要复查|需不需要去|要不要吃药)",
);
const ADVICE_CN_POSSESSIVE =
  /我的(?:体检|复查|检查|就诊|年检|签证|护照|许可|续签|药)(?:是否)?(?:到期|过期)/;

// ── EN advice: each alternative carries its own first-person subject ──

const ADVICE_EN = new RegExp(
  "\\b(?:" +
    "should\\s+i\\b" +
    "|do\\s+i\\s+need\\b" +
    "|do\\s+i\\s+need\\s+to\\s+(?:go|see|take)\\b" +
    "|is\\s+it\\s+time\\s+for\\s+my\\b" +
    "|is\\s+it\\s+time\\s+for\\s+me\\s+to\\b" +
    "|is\\s+my\\s+(?:checkup|appointment|exam|physical|medication|prescription)\\s+(?:overdue|due)\\b" +
    "|am\\s+i\\s+(?:overdue|due\\s+for)\\b" +
  ")",
  "i",
);

// ── CN medication: subject + verb + REQUIRED interrogative + unified boundary ──

const MED_CN_WHAT = new RegExp(
  "我" + G + "(?:现在|目前|当前)?" + G + "(?:正在|在)?" + G +
    "(?:吃|服用|用|服)(?:着)?(?:什么|哪些|哪种)" + MED_CN_OBJ + MED_OBJ_END,
);
const MED_CN_RELATIVE = new RegExp(
  "我" + G + "(?:现在|目前|当前)?" + G + "(?:服用|吃|服|用)的" + G + "(?:是)?(?:什么|哪些|哪种)" + MED_CN_OBJ + MED_OBJ_END,
);
const MED_CN_LIST = new RegExp(
  "我" + G + "(?:现在|目前|当前)?" + G + "(?:服用|吃|用)的" + MED_CN_OBJ + "(?:有哪些|是什么)" + MED_OBJ_END,
);
/** YN: must terminate with 吗/呢 or clause boundary after the medication compound. */
const MED_CN_YN = new RegExp(
  "我" + G + "(?:现在|目前|当前)?" + G + "(?:" +
    "有[，、,\\s]*(?:在)?[，、,\\s]*" + MED_CN_VERB_OBJ + MED_OBJ_END + "[，、,\\s]*(?:吗|呢)" +
    "|有没有[，、,\\s]*(?:在)?[，、,\\s]*" + MED_CN_VERB_OBJ + MED_OBJ_END + "(?=[？?，,。！\n]|$)" +
    "|(?:是否|有无)" + MED_CN_VERB_OBJ + MED_OBJ_END + "(?=[？?，,。！\n]|$)" +
  ")",
);

// ── EN medication: tightly coupled first-person clauses with shared components ──
//
// NO `.*?` bridges. Subject (I) and verb (on/taking/take) must be adjacent
// modulo a SHARED controlled parenthetical + time adverb, used uniformly
// across all four clause structures. After the medication object, a positive
// tail white-list (indications and dosing by prepositional phrases, up to 6
// word tokens including apostrophes/hyphens) is accepted.

/** Controlled parenthetical — shared across all four patterns. */
const EN_PAREN = "(?:\\s*,\\s*(?:if\\s+any|according\\s+to\\s+[\\w'-]+(?:\\s+[\\w'-]+){0,2})\\s*,)?";
/** Optional time adverb — shared. */
const EN_TIME = "(?:\\s+(?:currently|right\\s+now|now))?";
/** Word token with apostrophe/hyphen support. */
const WT = "[\\w'-]+";

/** Positive tail: indication/dosing prepositional phrases (≤6 word tokens), then end. */
const MED_EN_TAIL = new RegExp(
  "(?:" +
    "\\s+for\\s+" + WT + "(?:\\s+" + WT + "){0,5}" +
    "|\\s+(?:at|in\\s+the|after|before|every|as|twice|once|three\\s+times|two\\s+times|with)\\s+" + WT + "(?:\\s+" + WT + "){0,5}" +
    "|\\s+(?:daily|currently|right\\s+now|now|today)" +
  ")?\\s*[?.!]?\\s*$",
  "i",
);

/** Pattern 1: what/which medication(s) [, if any,] am I [time] [paren] on/taking [tail] */
const MED_WHAT_ON_EN = new RegExp(
  "\\b(?:what|which)\\s+(?:medications?|medicines?|prescriptions?)" +
    "\\s*,?\\s*(?:if\\s+any\\s*,?)?\\s*" +
    "am\\s+i" + EN_TIME + EN_PAREN + "\\s+(?:on|taking)" + MED_EN_TAIL.source,
  "i",
);
/** Pattern 2: am I [time] [paren] on/taking (any) medication [tail] */
const MED_AM_I_EN = new RegExp(
  "\\bam\\s+i" + EN_TIME + EN_PAREN + "\\s+(?:on|taking)\\s+(?:any\\s+)?(?:medications?|medicines?|prescriptions?|meds?)" + MED_EN_TAIL.source,
  "i",
);
/** Pattern 3: what/which medication(s) do I [time] [paren] take [tail] */
const MED_WHAT_DO_EN = new RegExp(
  "\\b(?:what|which)\\s+(?:medications?|medicines?|prescriptions?)\\s+do\\s+i" + EN_TIME + EN_PAREN + "\\s+take" + MED_EN_TAIL.source,
  "i",
);
/** Pattern 4: do I [time] [paren] take (any) medication [tail] */
const MED_DO_I_EN = new RegExp(
  "\\bdo\\s+i" + EN_TIME + EN_PAREN + "\\s+take\\s+(?:any\\s+)?(?:medications?|medicines?|prescriptions?|meds?)" + MED_EN_TAIL.source,
  "i",
);

/** Check a single clause for personal current-state intent. */
function isPersonalCurrentStateClause(clause: string): boolean {
  if (ADVICE_CN_DIRECT.test(clause) || ADVICE_CN_POSSESSIVE.test(clause)) return true;
  if (ADVICE_EN.test(clause)) return true;
  if (MED_CN_WHAT.test(clause) || MED_CN_RELATIVE.test(clause) || MED_CN_LIST.test(clause) || MED_CN_YN.test(clause)) return true;
  if (MED_WHAT_ON_EN.test(clause) || MED_AM_I_EN.test(clause) || MED_WHAT_DO_EN.test(clause) || MED_DO_I_EN.test(clause)) return true;
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

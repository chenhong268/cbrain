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
 *
 * Two tiers:
 * - DIRECT action markers: explicit action/state predicates — trigger alone.
 *   Must be a PREDICATE (该不该/需不需要/到期/复查/体检…), NOT a bare noun
 *   like 检查/运动/保险 that appears in ordinary recall queries.
 * - TIME markers (最近/上次) co-occurring with a specific health/admin
 *   domain compound — triggers only together.
 */
const DIRECT_ACTION_CN = /该不该|要不要|还要不要|需不需要|该去|该做|复查|体检|吃药|用药|就诊|看病|预约挂号|到期|过期|接下来|定期|周期|频率|是否到期|什么时候到期|需不需要复查|要不要去看/;
const DIRECT_ACTION_EN = /\b(?:should\s+i|do\s+i\s+need|is\s+it\s+time|overdue|due\s+for|checkup|appointment|medication|when\s+should\s+i)\b/i;

const TIME_MARKER_CN = /上次|最近|什么时候|多久/;
const TIME_MARKER_EN = /\b(?:last\s+time|recently|how\s+long|next)\b/i;

/**
 * Health/management domain compounds that, WITH a time marker, indicate
 * current-state intent. Only multi-char phrases that unambiguously signal
 * a health/admin action — NOT bare nouns (运动/保险/检查/报告/提交) that
 * appear in ordinary recall (运动相机/保险箱/代码检查/研究报告/提交代码).
 */
const DOMAIN_CN = /复查|体检|看病|就诊|吃药|用药|治疗|随访|监测|指标|症状|疗程|剂量|恢复|康复|锻炼|饮食|睡眠|作息|血压|血糖|心率|过敏|疫苗|续签|报税/;
const DOMAIN_EN = /\b(?:checkup|appointment|medication|treatment|follow-?up|monitor|symptom|doctor|hospital|clinic|prescription|therapy|dose|recovery|workout|diet|sleep|allergy|vaccine|renewal|tax)\b/i;

function hasDirectActionIntent(query: string): boolean {
  return DIRECT_ACTION_CN.test(query) || DIRECT_ACTION_EN.test(query);
}

function hasTimeMarkerWithDomain(query: string): boolean {
  const hasTime = TIME_MARKER_CN.test(query) || TIME_MARKER_EN.test(query);
  if (!hasTime) return false;
  return DOMAIN_CN.test(query) || DOMAIN_EN.test(query);
}

/**
 * #385 — closed grammar for personal current-state queries.
 *
 * Activates the personal current-state guard only when BOTH conditions hold:
 * 1. First-person phrasing (the speaker is the subject)
 * 2. Action-oriented / current-state intent:
 *    - a DIRECT action predicate (该不该/要不要/复查/体检/到期…), OR
 *    - a TIME marker (上次/最近) co-occurring with a specific health/admin
 *      domain compound.
 *
 * Deliberately narrow: avoids turning ordinary temporal, historical, or
 * incidental-noun-match queries into guard activation. Bare nouns like
 * 检查/运动/保险 do NOT trigger — only explicit action predicates do.
 */
export function isPersonalCurrentStateQuery(query: string): boolean {
  if (!isFirstPersonQuery(query)) return false;
  try {
    const normalized = query.normalize("NFKC").trim();
    return hasDirectActionIntent(normalized) || hasTimeMarkerWithDomain(normalized);
  } catch {
    return false;
  }
}

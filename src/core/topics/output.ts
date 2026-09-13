import type { ChatMessage } from "../../llm/provider.js";
import {
  DEFAULT_TOPIC_BUDGETS,
  TopicBudgets,
  TopicClaim,
  TopicClaimKind,
  TopicModelOutput,
  TopicSourceSnapshot,
} from "./types.js";

const VALID_KINDS: ReadonlySet<string> = new Set<TopicClaimKind>(["observation", "user_thought", "candidate"]);

/** The validator's exact bounds, told to the model up front — a real-provider
 *  pilot (#512) showed outputs rejected for limits the prompt never stated.
 *  Generated from the SAME TopicBudgets the validator enforces, so the two can
 *  never drift apart. */
function systemPrompt(budgets: TopicBudgets): string {
  return `You compile source-backed topic pages for a personal knowledge base.

Rules:
- Output ONE JSON object, nothing else. No markdown fences.
- Shape: {"overview": claim[], "observations": claim[], "details": claim[], "open_questions": claim[]}
- "overview" is a 1-${budgets.maxOverviewClaims} claim summary: EVERY summary assertion carries the same citation as any other claim. There is no uncited free-text summary.
- "observations": 1-${budgets.maxObservations} claims (required, non-empty). "details": 0-${budgets.maxDetails} claims. "open_questions": 0-${budgets.maxOpenQuestions} claims.
- Every "text" is at most ${budgets.maxItemChars} characters; every "quote" is at most ${budgets.maxQuoteChars} characters.
- HARD LIMITS: any count or length over these bounds rejects the WHOLE output.
- A SHORT, PRECISE, CONTIGUOUS quote is best: copy just the one verbatim span that locates the assertion — never a whole paragraph, never merged sources.
- A FEW representative points per section are enough. NEVER pad to fill the limits; an empty "details"/"open_questions" is better than an invented or padded claim.
- Each claim: {"text": string, "kind": "observation"|"user_thought"|"candidate", "sourceSlug": string, "quote": string}
- "quote" MUST be an EXACT substring copied verbatim from the body of the source named by "sourceSlug". Never paraphrase, never merge two sources into one quote.
- "sourceSlug" MUST be one of the source slugs provided below.
- "kind" labels what the source says: "observation" = stated in the record; "user_thought" = the user's own thought recorded in the source; "candidate" = unconfirmed assertion needing verification.
- Only use facts from the provided SOURCE MATERIAL sections. Do not add outside knowledge. Do not invent dates, numbers, or names.
- Preserve the time context of historical statements. An old record's "current" state is not today's state; when its date is unknown, attribute the statement to the material without inventing a date.
- Storing an article or quotation does not mean the user endorses it. Only label a claim "user_thought" when the source explicitly records the user's own thought.
- You cannot assign trust states; corrections and rejections in the material are already removed — never resurrect them.
- Disagreements between sources go to "open_questions" or "details", never silently resolved.`;
}

/** Keep the final instruction after the full material: the real-provider
 *  pilot otherwise produced excessive detail despite the system limits.
 *  Concise targets never exceed the validator's configured bounds. */
function conciseDirective(budgets: TopicBudgets): string {
  const overview = Math.min(1, budgets.maxOverviewClaims);
  const observations = Math.min(3, budgets.maxObservations);
  const details = Math.min(2, budgets.maxDetails);
  const openQuestions = Math.min(1, budgets.maxOpenQuestions);
  const quoteUpper = Math.min(40, budgets.maxQuoteChars);
  const quoteLower = Math.min(10, quoteUpper);
  return `现在请输出精简的主题知识页 JSON：overview 只写 ${overview} 条；observations 只写 ${observations} 条综合要点；details 最多 ${details} 条；open_questions 最多 ${openQuestions} 条（没有原文依据就留空数组）。不要逐篇列摘要，不需要覆盖每份材料。每个 quote 选取对应来源中的一小段连续原文，建议 ${quoteLower}–${quoteUpper} 个字，保留原始 Markdown 符号；必须逐字复制，不要改写或补字。历史状态要保留材料时点；日期不明就写“材料记录”，不要当作今日状态。来源观点不等于用户认同。输出前核对数组条数和每条引用。只输出 JSON。`;
}

/** Build the bounded compile prompt. Source bodies are included in full —
 *  oversize material is rejected upstream, never truncated here. The explicit
 *  output limits come from `budgets` (the same bounds the validator enforces;
 *  defaults to DEFAULT_TOPIC_BUDGETS). Shape (tested against the real
 *  provider): system rules → material user message → final concise directive
 *  user message. */
export function buildTopicPrompt(title: string, snapshots: TopicSourceSnapshot[], budgets: TopicBudgets = DEFAULT_TOPIC_BUDGETS): ChatMessage[] {
  const sections = snapshots.map((s) => {
    const facts = s.usableFacts.length > 0
      ? `\n[治理事实] ${s.usableFacts
          .map((f) => (f.eventDate ? `${f.eventDate}: ${f.text}` : f.text))
          .join(" / ")}`
      : "";
    return `### SOURCE ${s.slug}\n${s.body}${facts}`;
  });
  const user = [
    `主题（topic）标题：${title}`,
    "",
    `可用来源 slug：${snapshots.map((s) => s.slug).join(", ")}`,
    "",
    "SOURCE MATERIAL（每条 claim 必须引用其中一个 slug 的原文；原文完整提供，未截断）：",
    "",
    sections.join("\n\n"),
  ].join("\n");
  return [
    { role: "system", content: systemPrompt(budgets) },
    { role: "user", content: user },
    { role: "user", content: conciseDirective(budgets) },
  ];
}

export type ParsedTopicOutput =
  | { ok: true; output: TopicModelOutput }
  | { ok: false; reason: string };

/** Parse and strictly validate untrusted model output. Bounds are hard: any
 *  violation rejects the WHOLE output — no silent truncation, no partial
 *  acceptance, and fabricated/unsupported/empty claims are fatal. */
export function parseTopicModelOutput(raw: string, snapshots: TopicSourceSnapshot[], budgets: TopicBudgets): ParsedTopicOutput {
  let cleaned = raw.trim();
  const fence = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) cleaned = fence[1];
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return { ok: false, reason: "not_json" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "not_object" };
  }
  const v = parsed as Record<string, unknown>;

  const bodiesBySlug = new Map(snapshots.map((s) => [s.slug, s.body]));

  const claims = (key: string, max: number, allowEmpty: boolean): { ok: true; claims: TopicClaim[] } | { ok: false; reason: string } => {
    if (!Array.isArray(v[key])) return { ok: false, reason: `${key}_missing` };
    const list = v[key] as unknown[];
    if (list.length === 0 && !allowEmpty) return { ok: false, reason: `${key}_empty` };
    if (list.length > max) return { ok: false, reason: `${key}_over_budget` };
    const out: TopicClaim[] = [];
    for (const item of list) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        return { ok: false, reason: `${key}_claim_not_object` };
      }
      const c = item as Record<string, unknown>;
      const text = typeof c.text === "string" ? c.text.trim() : "";
      if (!text) return { ok: false, reason: `${key}_claim_text_empty` };
      if (text.length > budgets.maxItemChars) return { ok: false, reason: `${key}_claim_text_over_budget` };
      const kind = typeof c.kind === "string" ? c.kind : "";
      if (!VALID_KINDS.has(kind)) return { ok: false, reason: `${key}_claim_kind_invalid` };
      const sourceSlug = typeof c.sourceSlug === "string" ? c.sourceSlug : "";
      if (!bodiesBySlug.has(sourceSlug)) return { ok: false, reason: `${key}_claim_source_not_selected` };
      const quote = typeof c.quote === "string" ? c.quote : "";
      if (!quote.trim()) return { ok: false, reason: `${key}_claim_quote_empty` };
      if (quote.length > budgets.maxQuoteChars) return { ok: false, reason: `${key}_claim_quote_over_budget` };
      if (!bodiesBySlug.get(sourceSlug)!.includes(quote)) {
        return { ok: false, reason: `${key}_claim_quote_not_in_source` };
      }
      // Rebuild from validated fields only — extra model fields (e.g. any
      // trust_state) are dropped, never persisted.
      out.push({ text, kind: kind as TopicClaimKind, sourceSlug, quote });
    }
    return { ok: true, claims: out };
  };

  // Every summary assertion is a cited claim — an overview arriving as a
  // plain string (the old uncited free-text bypass) fails validation.
  const overview = claims("overview", budgets.maxOverviewClaims, false);
  if (!overview.ok) return overview;
  const observations = claims("observations", budgets.maxObservations, false);
  if (!observations.ok) return observations;
  const details = claims("details", budgets.maxDetails, true);
  if (!details.ok) return details;
  const openQuestions = claims("open_questions", budgets.maxOpenQuestions, true);
  if (!openQuestions.ok) return openQuestions;

  return {
    ok: true,
    output: {
      overview: overview.claims,
      observations: observations.claims,
      details: details.claims,
      open_questions: openQuestions.claims,
    },
  };
}

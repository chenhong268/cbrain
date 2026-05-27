import type { LLMProvider } from "../llm/provider.js";
import type { EvidenceBoardResult, EvidenceItem } from "./evidence.js";

// ─── Types ────────────────────────────────────────────────────

export type Confidence = "high" | "medium" | "low";

export interface SourceRef {
  claim: string;
  source_slug: string;
}

export interface ConflictRef {
  claim: string;
  source_slugs: string[];
}

export interface GroundedAnswerResult {
  answer: string;
  confidence: Confidence;
  facts_used: SourceRef[];
  thoughts_used: SourceRef[];
  unresolved: string[];
  conflicts: ConflictRef[];
  degraded?: boolean;
}

export interface GroundedAnswererDeps {
  llm?: LLMProvider;
}

// ─── Internal helpers ─────────────────────────────────────────

const INSUFFICIENT_ANSWER = "目前没有足够的记录来回答这个问题。";
const MIN_OVERLAP = 3;

function itemToSourceRef(item: EvidenceItem): SourceRef {
  return { claim: item.claim, source_slug: item.source_slug };
}

function buildPartitionKeys(items: EvidenceItem[]): Set<string> {
  return new Set(items.map((i) => `${i.claim}\0${i.source_slug}`));
}

function computeConfidence(board: EvidenceBoardResult): Confidence {
  const hasFacts = board.facts.length > 0;
  const hasThoughts = board.user_thoughts.length > 0;
  const hasUnresolved = board.gaps.length > 0;
  const hasConflicts = board.conflicts.length > 0;

  if (hasFacts && !hasConflicts && !hasUnresolved) return "high";
  if (hasFacts && (hasConflicts || hasUnresolved)) return "medium";
  if (!hasFacts && hasThoughts) return "medium";
  return "low";
}

function hasUsableEvidence(board: EvidenceBoardResult): boolean {
  return board.facts.length > 0 || board.user_thoughts.length > 0 || board.candidates.length > 0;
}

function boardConflictsToRefs(board: EvidenceBoardResult): ConflictRef[] {
  return board.conflicts.map((c) => ({
    claim: c.claim,
    source_slugs: c.evidence.map((e) => e.source_slug),
  }));
}

function answerMentionsEvidence(answer: string, board: EvidenceBoardResult): boolean {
  const allClaims = [
    ...board.facts.map((f) => f.claim),
    ...board.user_thoughts.map((t) => t.claim),
    ...board.candidates.map((c) => c.claim),
    ...board.conflicts.map((cf) => cf.claim),
  ];

  const hasLongEnough = allClaims.some((c) => c.length >= MIN_OVERLAP);
  if (!hasLongEnough) return true;

  for (const claim of allClaims) {
    for (let i = 0; i <= claim.length - MIN_OVERLAP; i++) {
      if (answer.includes(claim.substring(i, i + MIN_OVERLAP))) return true;
    }
  }
  return false;
}

// ─── Deterministic synthesizer ────────────────────────────────

function synthesizeDeterministic(
  _question: string,
  board: EvidenceBoardResult,
): GroundedAnswerResult {
  const parts: string[] = [];

  for (const f of board.facts) {
    parts.push(`根据记录：${f.claim}。`);
  }

  for (const t of board.user_thoughts) {
    parts.push(`你之前提到：${t.claim}。`);
  }

  const gapClaims = new Set(board.gaps);
  for (const c of board.candidates) {
    if (gapClaims.has(c.claim)) {
      parts.push(`尚待确认：${c.claim}。`);
    }
  }

  for (const conflict of board.conflicts) {
    parts.push(`关于「${conflict.claim}」存在矛盾信息。`);
  }

  const answer = parts.length > 0 ? parts.join("") : INSUFFICIENT_ANSWER;

  return {
    answer,
    confidence: computeConfidence(board),
    facts_used: board.facts.map(itemToSourceRef),
    thoughts_used: board.user_thoughts.map(itemToSourceRef),
    unresolved: board.gaps,
    conflicts: boardConflictsToRefs(board),
    degraded: true,
  };
}

// ─── LLM synthesizer ─────────────────────────────────────────

const SYSTEM_PROMPT = `你是一个严谨的记忆回答合成器。根据提供的证据分区生成简洁回答。

规则：
- 只有 facts 分区的证据可以支撑客观事实陈述
- user_thoughts 只能表述为用户之前的想法或观点，不能作为外部事实
- candidates 只能作为待确认内容，不能断言为事实
- 冲突必须标注为未解决的分歧，不能静默裁决
- 证据不足时给出保守回答
- 回答必须简洁自然，只能涉及提供的证据中的内容

输出 JSON：
{
  "answer": "简洁的自然语言回答",
  "facts_used": [{"claim": "...", "source_slug": "..."}],
  "thoughts_used": [{"claim": "...", "source_slug": "..."}]
}

不要输出其他字段。answer 只能涉及提供的证据中的主题。source_slug 必须来自提供的证据，不能虚构。`;

function buildUserPrompt(question: string, board: EvidenceBoardResult): string {
  const sections: string[] = [`问题：${question}`, "", "=== 证据 ==="];

  if (board.facts.length > 0) {
    sections.push("", "[可信事实]");
    for (const f of board.facts) {
      sections.push(`- ${f.claim} (source: ${f.source_slug})`);
    }
  }

  if (board.user_thoughts.length > 0) {
    sections.push("", "[用户想法]");
    for (const t of board.user_thoughts) {
      sections.push(`- ${t.claim} (source: ${t.source_slug})`);
    }
  }

  if (board.candidates.length > 0) {
    sections.push("", "[候选信息-不可断言为事实]");
    for (const c of board.candidates) {
      sections.push(`- ${c.claim} (source: ${c.source_slug})`);
    }
  }

  if (board.conflicts.length > 0) {
    sections.push("", "[存在冲突]");
    for (const conflict of board.conflicts) {
      const sides = conflict.evidence.map((e) => `${e.claim} (${e.source_slug})`).join(" vs ");
      sections.push(`- ${conflict.claim}: ${sides}`);
    }
  }

  if (board.gaps.length > 0) {
    sections.push("", "[证据缺口]");
    for (const g of board.gaps) {
      sections.push(`- ${g}`);
    }
  }

  return sections.join("\n");
}

interface RawLLMAnswer {
  answer?: string;
  facts_used?: Array<{ claim?: string; source_slug?: string }>;
  thoughts_used?: Array<{ claim?: string; source_slug?: string }>;
}

function parseLLMResponse(raw: string): RawLLMAnswer | null {
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "");
    return JSON.parse(cleaned) as RawLLMAnswer;
  } catch {
    return null;
  }
}

function validateLLMOutput(parsed: RawLLMAnswer, board: EvidenceBoardResult): GroundedAnswerResult | null {
  if (!parsed.answer || typeof parsed.answer !== "string" || parsed.answer.trim().length === 0) return null;

  if (!answerMentionsEvidence(parsed.answer, board)) return null;

  const factKeys = buildPartitionKeys(board.facts);
  const thoughtKeys = buildPartitionKeys(board.user_thoughts);

  const factsUsed: SourceRef[] = [];
  if (Array.isArray(parsed.facts_used)) {
    for (const ref of parsed.facts_used) {
      if (!ref.claim || !ref.source_slug) return null;
      if (!factKeys.has(`${ref.claim}\0${ref.source_slug}`)) return null;
      factsUsed.push({ claim: ref.claim, source_slug: ref.source_slug });
    }
  }

  const thoughtsUsed: SourceRef[] = [];
  if (Array.isArray(parsed.thoughts_used)) {
    for (const ref of parsed.thoughts_used) {
      if (!ref.claim || !ref.source_slug) return null;
      if (!thoughtKeys.has(`${ref.claim}\0${ref.source_slug}`)) return null;
      thoughtsUsed.push({ claim: ref.claim, source_slug: ref.source_slug });
    }
  }

  return {
    answer: parsed.answer,
    confidence: computeConfidence(board),
    facts_used: factsUsed,
    thoughts_used: thoughtsUsed,
    unresolved: board.gaps,
    conflicts: boardConflictsToRefs(board),
  };
}

// ─── GroundedAnswerer ─────────────────────────────────────────

export class GroundedAnswerer {
  private llm?: LLMProvider;

  constructor(deps: GroundedAnswererDeps = {}) {
    this.llm = deps.llm;
  }

  async synthesize(question: string, board: EvidenceBoardResult): Promise<GroundedAnswerResult> {
    if (!this.llm || !hasUsableEvidence(board)) {
      return synthesizeDeterministic(question, board);
    }

    try {
      const messages = [
        { role: "system" as const, content: SYSTEM_PROMPT },
        { role: "user" as const, content: buildUserPrompt(question, board) },
      ];
      const raw = await this.llm.chat(messages);
      const parsed = parseLLMResponse(raw);
      if (!parsed) return synthesizeDeterministic(question, board);

      const validated = validateLLMOutput(parsed, board);
      if (!validated) return synthesizeDeterministic(question, board);

      return validated;
    } catch {
      return synthesizeDeterministic(question, board);
    }
  }
}

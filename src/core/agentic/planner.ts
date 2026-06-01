import type { LLMProvider } from "../../llm/provider.js";
import type { PlanResult } from "./plan.js";
import { SearchPlanBudget, type SearchPlanIntent, validateSearchPlan } from "./plan.js";

// --- Intent keywords (aligned with QueryRouter, not imported) ---

const RELATIONSHIP_KEYWORDS = ["关系", "联系", "之间", "关联"];
const COMPARISON_KEYWORDS = ["比较", "对比", "区别", "哪个好", "vs", "VS"];
const REVIEW_KEYWORDS = ["复盘", "总结", "回顾", "变化", "进展"];
const GAP_KEYWORDS = ["还", "有没有", "缺什么", "不足", "盲区", "遗漏", "不知道"];
const TEMPORAL_KEYWORDS = ["最近", "什么时候", "上次", "下周", "上周", "这周", "时间线"];

// --- Step templates per intent ---

type StepKind = "resolve" | "search" | "graph" | "timeline" | "page" | "chunks";
type StepInput = { kind: StepKind; input: string; mode?: "neighbors" | "traverse"; detail?: "brief" | "normal" | "full" };

function stepTemplates(intent: SearchPlanIntent, query: string): StepInput[] {
  switch (intent) {
    case "entity_lookup":
      return [{ kind: "resolve", input: query }, { kind: "page", input: query, detail: "normal" }];
    case "relationship":
      return [
        { kind: "resolve", input: query },
        { kind: "graph", input: query, mode: "traverse" },
        { kind: "page", input: query, detail: "normal" },
      ];
    case "timeline":
      return [
        { kind: "resolve", input: query },
        { kind: "timeline", input: query },
        { kind: "page", input: query, detail: "brief" },
      ];
    case "comparison":
      return [
        { kind: "resolve", input: query },
        { kind: "graph", input: query, mode: "neighbors" },
        { kind: "page", input: query, detail: "normal" },
        { kind: "chunks", input: query, detail: "brief" },
      ];
    case "review":
      return [
        { kind: "resolve", input: query },
        { kind: "timeline", input: query },
        { kind: "page", input: query, detail: "full" },
        { kind: "chunks", input: query, detail: "normal" },
      ];
    case "gap_analysis":
      return [
        { kind: "resolve", input: query },
        { kind: "graph", input: query, mode: "neighbors" },
        { kind: "chunks", input: query, detail: "brief" },
        { kind: "page", input: query, detail: "brief" },
      ];
  }
}

function classifyIntent(query: string): SearchPlanIntent {
  if (COMPARISON_KEYWORDS.some((kw) => query.includes(kw))) return "comparison";
  if (GAP_KEYWORDS.some((kw) => query.includes(kw))) return "gap_analysis";
  if (REVIEW_KEYWORDS.some((kw) => query.includes(kw))) return "review";
  if (TEMPORAL_KEYWORDS.some((kw) => query.includes(kw))) return "timeline";
  if (RELATIONSHIP_KEYWORDS.some((kw) => query.includes(kw))) return "relationship";
  return "entity_lookup";
}

// --- Fallback plan builder (reuses intent classification + step templates) ---

function resolveIntent(query: string, intentHint?: SearchPlanIntent): SearchPlanIntent {
  return intentHint ?? classifyIntent(query);
}

function buildFallback(query: string, reason: string, knownSlugs: string[] = [], intentHint?: SearchPlanIntent): PlanResult {
  const intent = resolveIntent(query, intentHint);
  const steps = stepTemplates(intent, query);
  return {
    status: "fallback",
    degraded_reason: reason,
    original_query: query,
    intent,
    entities: [...knownSlugs],
    steps,
    budget: SearchPlanBudget.parse({}),
  };
}

// --- Planner input ---

export interface PlannerInput {
  query: string;
  knownSlugs?: string[];
  intentHint?: SearchPlanIntent;
}

// --- Planner ---

export class SearchPlanner {
  constructor(private readonly llm?: LLMProvider) {}

  async plan(input: PlannerInput): Promise<PlanResult> {
    const { query } = input;
    if (!query.trim()) {
      return buildFallback(query, "Empty query", input.knownSlugs, input.intentHint);
    }

    if (!this.llm) return this.ruleBasedPlan(input);
    return this.llmPlan(input);
  }

  private ruleBasedPlan(input: PlannerInput): PlanResult {
    const { query, knownSlugs = [], intentHint } = input;
    const intent = resolveIntent(query, intentHint);
    const steps = stepTemplates(intent, query);

    return {
      intent,
      entities: knownSlugs.length > 0 ? [...knownSlugs] : [],
      steps,
      budget: SearchPlanBudget.parse({}),
    };
  }

  private async llmPlan(input: PlannerInput): Promise<PlanResult> {
    const { query, knownSlugs = [], intentHint } = input;

    try {
      const raw = await this.llm!.chat([
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(query, knownSlugs) },
      ]);

      const cleaned = raw.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "");
      const parsed: unknown = JSON.parse(cleaned);
      const result = validateSearchPlan(parsed);
      if (!("ok" in result)) return result;
      return buildFallback(query, result.reason, knownSlugs, intentHint);
    } catch (err) {
      return buildFallback(query, `LLM planning failed: ${err instanceof Error ? err.message : String(err)}`, knownSlugs, intentHint);
    }
  }
}

// --- LLM Prompt ---

const SYSTEM_PROMPT = `You are a search plan generator for a knowledge graph system.
Given a user query, produce a structured search plan as JSON.

Output schema:
{
  "intent": "entity_lookup" | "relationship" | "timeline" | "comparison" | "review" | "gap_analysis",
  "entities": ["slug1", "slug2"],
  "steps": [
    { "kind": "resolve" | "search" | "graph" | "timeline" | "page" | "chunks", "input": "...", "mode?": "neighbors" | "traverse", "detail?": "brief" | "normal" | "full" }
  ],
  "budget": { "max_llm_calls": 3, "max_searches": 8, "max_ms": 8000 }
}

Rules:
- steps: 1-10 items, kind must be from the enum above
- entities: slugs if known, empty array if unknown
- All values must use anonymized placeholders (实体A, 主题B, etc.)
- Output ONLY valid JSON, no markdown fences`;

function buildUserPrompt(query: string, knownSlugs: string[]): string {
  const slugHint = knownSlugs.length > 0 ? `\nKnown slugs: ${knownSlugs.join(", ")}` : "";
  return `Query: ${query}${slugHint}\n\nProduce a search plan.`;
}

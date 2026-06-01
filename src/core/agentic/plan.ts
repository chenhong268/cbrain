import { z } from "zod";

// --- Intent (aligned with QueryRouter.RouteResult.intent) ---

export const SearchPlanIntent = z.enum([
  "entity_lookup",
  "relationship",
  "timeline",
  "comparison",
  "review",
  "gap_analysis",
]);

export type SearchPlanIntent = z.infer<typeof SearchPlanIntent>;

// --- Step ---

export const SearchPlanStep = z.object({
  kind: z.enum(["resolve", "search", "graph", "timeline", "page", "chunks"]),
  input: z.string(),
  mode: z.enum(["neighbors", "traverse"]).optional(),
  detail: z.enum(["brief", "normal", "full"]).optional(),
});

export type SearchPlanStep = z.infer<typeof SearchPlanStep>;

// --- Budget ---

export const SearchPlanBudget = z.object({
  max_llm_calls: z.number().int().min(1).max(10).default(3),
  max_searches: z.number().int().min(1).max(20).default(8),
  max_ms: z.number().int().min(1000).max(30000).default(8000),
});

export type SearchPlanBudget = z.infer<typeof SearchPlanBudget>;

// --- Plan ---

export const SearchPlan = z.object({
  intent: SearchPlanIntent,
  entities: z.array(z.string()),
  steps: z.array(SearchPlanStep).min(1).max(10),
  budget: SearchPlanBudget,
});

export type SearchPlan = z.infer<typeof SearchPlan>;

// --- Fallback ---

export const PlanFallback = z.object({
  status: z.literal("fallback"),
  degraded_reason: z.string(),
  original_query: z.string(),
  intent: SearchPlanIntent,
  entities: z.array(z.string()),
  steps: z.array(SearchPlanStep).min(1).max(10),
  budget: SearchPlanBudget,
});

export type PlanFallback = z.infer<typeof PlanFallback>;

// --- Result type ---

export type PlanResult = SearchPlan | PlanFallback;

// --- Helper ---

export function isFallback(result: PlanResult): result is PlanFallback {
  return "status" in result && result.status === "fallback";
}

export interface SchemaValidationError {
  ok: false;
  reason: string;
}

export type SchemaValidationResult = SearchPlan | SchemaValidationError;

export function validateSearchPlan(json: unknown): SchemaValidationResult {
  const parsed = SearchPlan.safeParse(json);
  if (parsed.success) return parsed.data;
  return {
    ok: false,
    reason: `Schema validation failed: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
  };
}

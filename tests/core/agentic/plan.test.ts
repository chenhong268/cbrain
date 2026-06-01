import { describe, it, expect } from "bun:test";
import {
  SearchPlan,
  SearchPlanStep,
  PlanFallback,
  validateSearchPlan,
  isFallback,
} from "../../../src/core/agentic/plan.js";
import { SearchPlanner } from "../../../src/core/agentic/planner.js";
import type { LLMProvider } from "../../../src/llm/provider.js";

// --- Schema validation tests ---

describe("SearchPlan schema", () => {
  const validPlan = {
    intent: "relationship",
    entities: ["实体A", "实体B"],
    steps: [
      { kind: "resolve", input: "实体A 和 实体B" },
      { kind: "graph", input: "实体A", mode: "traverse" as const },
      { kind: "page", input: "实体A", detail: "normal" as const },
    ],
    budget: { max_llm_calls: 3, max_searches: 8, max_ms: 8000 },
  };

  it("parses a valid SearchPlan", () => {
    const result = SearchPlan.safeParse(validPlan);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.intent).toBe("relationship");
      expect(result.data.entities).toHaveLength(2);
      expect(result.data.steps).toHaveLength(3);
    }
  });

  it("rejects missing required fields", () => {
    const result = SearchPlan.safeParse({ intent: "entity_lookup" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown step kind", () => {
    const plan = { ...validPlan, steps: [{ kind: "unknown", input: "test" }] };
    const result = SearchPlan.safeParse(plan);
    expect(result.success).toBe(false);
  });

  it("rejects steps exceeding max (10)", () => {
    const steps = Array.from({ length: 11 }, (_, i) => ({ kind: "search" as const, input: `query ${i}` }));
    const plan = { ...validPlan, steps };
    const result = SearchPlan.safeParse(plan);
    expect(result.success).toBe(false);
  });

  it("fills budget defaults when omitted", () => {
    const plan = { intent: "entity_lookup" as const, entities: [], steps: [{ kind: "search" as const, input: "test" }] };
    const result = SearchPlan.parse({ ...plan, budget: {} });
    expect(result.budget.max_llm_calls).toBe(3);
    expect(result.budget.max_searches).toBe(8);
    expect(result.budget.max_ms).toBe(8000);
  });

  it("accepts empty entities array", () => {
    const plan = { ...validPlan, entities: [] };
    const result = SearchPlan.safeParse(plan);
    expect(result.success).toBe(true);
  });

  it("rejects invalid intent value", () => {
    const plan = { ...validPlan, intent: "invalid_intent" };
    const result = SearchPlan.safeParse(plan);
    expect(result.success).toBe(false);
  });
});

describe("SearchPlanStep schema", () => {
  it("parses step with optional mode and detail", () => {
    const step = { kind: "graph" as const, input: "实体A", mode: "traverse" as const, detail: "full" as const };
    const result = SearchPlanStep.parse(step);
    expect(result.mode).toBe("traverse");
    expect(result.detail).toBe("full");
  });

  it("parses step without optional fields", () => {
    const step = { kind: "resolve" as const, input: "实体A" };
    const result = SearchPlanStep.parse(step);
    expect(result.mode).toBeUndefined();
    expect(result.detail).toBeUndefined();
  });

  it("accepts chunks as valid step kind", () => {
    const step = { kind: "chunks" as const, input: "实体A", detail: "brief" as const };
    const result = SearchPlanStep.parse(step);
    expect(result.kind).toBe("chunks");
  });

  it("rejects recall as step kind", () => {
    const step = { kind: "recall", input: "实体A" };
    const result = SearchPlanStep.safeParse(step);
    expect(result.success).toBe(false);
  });
});

describe("PlanFallback schema", () => {
  const validFallback = {
    status: "fallback" as const,
    degraded_reason: "test",
    original_query: "实体A",
    intent: "entity_lookup" as const,
    entities: [] as string[],
    steps: [{ kind: "resolve" as const, input: "实体A" }, { kind: "search" as const, input: "实体A" }],
    budget: { max_llm_calls: 3, max_searches: 8, max_ms: 8000 },
  };

  it("parses a valid fallback with steps", () => {
    const result = PlanFallback.parse(validFallback);
    expect(result.status).toBe("fallback");
    expect(result.steps).toHaveLength(2);
    expect(result.degraded_reason).toBe("test");
  });

  it("rejects non-fallback status", () => {
    const fb = { ...validFallback, status: "error" };
    const result = PlanFallback.safeParse(fb);
    expect(result.success).toBe(false);
  });

  it("rejects fallback without steps", () => {
    const { steps, ...noSteps } = validFallback;
    const result = PlanFallback.safeParse(noSteps);
    expect(result.success).toBe(false);
  });
});

describe("validateSearchPlan", () => {
  it("returns SearchPlan for valid input", () => {
    const valid = {
      intent: "entity_lookup",
      entities: ["实体A"],
      steps: [{ kind: "resolve", input: "实体A" }],
      budget: {},
    };
    const result = validateSearchPlan(valid);
    expect("ok" in result && result.ok === false).toBe(false);
  });

  it("returns error result for invalid input", () => {
    const result = validateSearchPlan({ bad: true });
    expect("ok" in result && result.ok === false).toBe(true);
    if ("ok" in result && result.ok === false) {
      expect(result.reason).toContain("Schema validation failed");
    }
  });
});

// --- Planner tests ---

function mockLLM(response: string): LLMProvider {
  return {
    name: "mock",
    chat: async () => response,
  };
}

function failingLLM(error: Error): LLMProvider {
  return {
    name: "mock-fail",
    chat: async () => { throw error; },
  };
}

describe("SearchPlanner (rule-based, no LLM)", () => {
  const planner = new SearchPlanner();

  it("produces entity_lookup plan for simple query", async () => {
    const result = await planner.plan({ query: "实体A" });
    expect(isFallback(result)).toBe(false);
    if (!isFallback(result)) {
      expect(result.intent).toBe("entity_lookup");
      expect(result.steps.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("produces relationship plan when keywords present", async () => {
    const result = await planner.plan({ query: "实体A 和 实体B 什么关系" });
    expect(isFallback(result)).toBe(false);
    if (!isFallback(result)) {
      expect(result.intent).toBe("relationship");
    }
  });

  it("produces timeline plan for temporal query", async () => {
    const result = await planner.plan({ query: "实体A 最近怎么样" });
    expect(isFallback(result)).toBe(false);
    if (!isFallback(result)) {
      expect(result.intent).toBe("timeline");
    }
  });

  it("produces comparison plan", async () => {
    const result = await planner.plan({ query: "实体A 和 实体B 对比" });
    expect(isFallback(result)).toBe(false);
    if (!isFallback(result)) {
      expect(result.intent).toBe("comparison");
    }
  });

  it("produces gap_analysis plan", async () => {
    const result = await planner.plan({ query: "实体A 还有没有遗漏" });
    expect(isFallback(result)).toBe(false);
    if (!isFallback(result)) {
      expect(result.intent).toBe("gap_analysis");
    }
  });

  it("produces review plan", async () => {
    const result = await planner.plan({ query: "实体A 复盘" });
    expect(isFallback(result)).toBe(false);
    if (!isFallback(result)) {
      expect(result.intent).toBe("review");
    }
  });

  it("includes knownSlugs in entities", async () => {
    const result = await planner.plan({ query: "实体A", knownSlugs: ["slug-a", "slug-b"] });
    expect(isFallback(result)).toBe(false);
    if (!isFallback(result)) {
      expect(result.entities).toContain("slug-a");
      expect(result.entities).toContain("slug-b");
    }
  });

  it("returns fallback for empty query", async () => {
    const result = await planner.plan({ query: "" });
    expect(isFallback(result)).toBe(true);
  });

  it("returns fallback for whitespace-only query", async () => {
    const result = await planner.plan({ query: "   " });
    expect(isFallback(result)).toBe(true);
  });

  it("populates budget with defaults", async () => {
    const result = await planner.plan({ query: "实体A" });
    expect(isFallback(result)).toBe(false);
    if (!isFallback(result)) {
      expect(result.budget.max_llm_calls).toBe(3);
      expect(result.budget.max_searches).toBe(8);
      expect(result.budget.max_ms).toBe(8000);
    }
  });
});

describe("SearchPlanner (LLM-based)", () => {
  it("returns valid plan from LLM JSON", async () => {
    const llmResponse = JSON.stringify({
      intent: "relationship",
      entities: ["实体A", "实体B"],
      steps: [
        { kind: "resolve", input: "实体A 实体B" },
        { kind: "graph", input: "实体A", mode: "traverse" },
      ],
      budget: { max_llm_calls: 2, max_searches: 5, max_ms: 5000 },
    });
    const planner = new SearchPlanner(mockLLM(llmResponse));
    const result = await planner.plan({ query: "实体A 和 实体B 什么关系" });

    expect(isFallback(result)).toBe(false);
    if (!isFallback(result)) {
      expect(result.intent).toBe("relationship");
      expect(result.steps).toHaveLength(2);
      expect(result.budget.max_llm_calls).toBe(2);
    }
  });

  it("returns fallback plan with steps for invalid JSON from LLM", async () => {
    const planner = new SearchPlanner(mockLLM("not json at all"));
    const result = await planner.plan({ query: "实体A" });
    expect(isFallback(result)).toBe(true);
    if (isFallback(result)) {
      expect(result.original_query).toBe("实体A");
      expect(result.steps.length).toBeGreaterThanOrEqual(1);
      expect(result.budget).toBeDefined();
    }
  });

  it("returns fallback plan with degraded_reason for unknown step kind", async () => {
    const llmResponse = JSON.stringify({
      intent: "entity_lookup",
      entities: ["实体A"],
      steps: [{ kind: "unknown_kind", input: "实体A" }],
      budget: {},
    });
    const planner = new SearchPlanner(mockLLM(llmResponse));
    const result = await planner.plan({ query: "实体A" });
    expect(isFallback(result)).toBe(true);
    if (isFallback(result)) {
      expect(result.degraded_reason).toBeDefined();
      expect(result.steps.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("returns fallback plan when LLM throws", async () => {
    const planner = new SearchPlanner(failingLLM(new Error("timeout")));
    const result = await planner.plan({ query: "实体A" });
    expect(isFallback(result)).toBe(true);
    if (isFallback(result)) {
      expect(result.degraded_reason).toContain("timeout");
      expect(result.steps.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("strips markdown fences from LLM response", async () => {
    const plan = {
      intent: "entity_lookup",
      entities: ["实体A"],
      steps: [{ kind: "resolve", input: "实体A" }],
      budget: {},
    };
    const fenced = "```json\n" + JSON.stringify(plan) + "\n```";
    const planner = new SearchPlanner(mockLLM(fenced));
    const result = await planner.plan({ query: "实体A" });
    expect(isFallback(result)).toBe(false);
  });

  it("passes knownSlugs to LLM prompt context", async () => {
    let capturedPrompt = "";
    const spyLLM: LLMProvider = {
      name: "spy",
      chat: async (msgs) => {
        capturedPrompt = msgs.map((m) => m.content).join(" ");
        return JSON.stringify({
          intent: "entity_lookup",
          entities: ["slug-a"],
          steps: [{ kind: "resolve", input: "实体A" }],
          budget: {},
        });
      },
    };
    const planner = new SearchPlanner(spyLLM);
    await planner.plan({ query: "实体A", knownSlugs: ["slug-a"] });
    expect(capturedPrompt).toContain("slug-a");
  });
});

describe("SearchPlanner fallback intent awareness", () => {
  it("relationship query with invalid LLM JSON → fallback with graph step", async () => {
    const planner = new SearchPlanner(mockLLM("not json"));
    const result = await planner.plan({ query: "实体A 和 实体B 什么关系" });
    expect(isFallback(result)).toBe(true);
    if (isFallback(result)) {
      expect(result.intent).toBe("relationship");
      expect(result.steps.some((s) => s.kind === "graph")).toBe(true);
    }
  });

  it("timeline query with unknown step kind → fallback with timeline step", async () => {
    const llmResponse = JSON.stringify({
      intent: "timeline",
      entities: ["实体A"],
      steps: [{ kind: "unknown_kind", input: "实体A" }],
      budget: {},
    });
    const planner = new SearchPlanner(mockLLM(llmResponse));
    const result = await planner.plan({ query: "实体A 最近怎么样" });
    expect(isFallback(result)).toBe(true);
    if (isFallback(result)) {
      expect(result.intent).toBe("timeline");
      expect(result.steps.some((s) => s.kind === "timeline")).toBe(true);
    }
  });

  it("intentHint overrides keyword classification", async () => {
    const planner = new SearchPlanner(mockLLM("not json"));
    const result = await planner.plan({ query: "实体A", intentHint: "review" });
    expect(isFallback(result)).toBe(true);
    if (isFallback(result)) {
      expect(result.intent).toBe("review");
      expect(result.steps.some((s) => s.kind === "timeline")).toBe(true);
    }
  });

  it("fallback preserves knownSlugs", async () => {
    const planner = new SearchPlanner(failingLLM(new Error("boom")));
    const result = await planner.plan({ query: "实体A", knownSlugs: ["slug-x"] });
    expect(isFallback(result)).toBe(true);
    if (isFallback(result)) {
      expect(result.entities).toContain("slug-x");
    }
  });
});

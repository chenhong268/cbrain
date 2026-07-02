import { describe, it, expect } from "bun:test";
import { evaluateSufficiency, type CriticInput } from "../../../src/core/agentic/critic.js";
import type { EvidenceBoardResult } from "../../../src/core/retrieval/evidence.js";
import type { StepResult } from "../../../src/core/agentic/executor.js";

// --- Helpers ---

function emptyBoard(): EvidenceBoardResult {
  return { facts: [], user_thoughts: [], candidates: [], gaps: [], conflicts: [] };
}

function makeStep(kind: string, data: unknown): StepResult {
  return { kind: kind as StepResult["kind"], input: "page/entity-a", data, latencyMs: 5 };
}

function makeInput(overrides: Partial<CriticInput> = {}): CriticInput {
  return {
    intent: "entity_lookup",
    query: "测试查询",
    evidenceBoard: emptyBoard(),
    ...overrides,
  };
}

// --- relationship intent ---

describe("critic — relationship intent", () => {
  it("link evidence in board → sufficient", () => {
    const board: EvidenceBoardResult = {
      ...emptyBoard(),
      facts: [{ claim: "A relates to B", evidence_type: "fact", source_type: "link", source_slug: "page/entity-a", source_category: "agent_inference", trust_state: "trusted", confidence: 0.9 }],
    };
    const result = evaluateSufficiency(makeInput({ intent: "relationship", evidenceBoard: board }));

    expect(result.sufficient).toBe(true);
    expect(result.missing).toHaveLength(0);
    expect(result.confidence).toBe("high");
  });

  it("graph execution step with data → sufficient", () => {
    const result = evaluateSufficiency(makeInput({
      intent: "relationship",
      execution: {
        steps: [makeStep("graph", [{ slug: "page/entity-b", title: "B", type: "entity", depth: 1 }])],
        gaps: [],
        skipped: [],
        resolvedSlugs: new Map([["page/entity-a", "page/entity-a"]]),
        budgetUsed: { llmCalls: 0, searches: 0, ms: 10 },
        status: "ok",
      },
    }));

    expect(result.sufficient).toBe(true);
    expect(result.reasons).toContain("graph step produced results");
  });

  it("no link or graph evidence → insufficient + graph follow-up", () => {
    const result = evaluateSufficiency(makeInput({
      intent: "relationship",
      query: "实体A和实体B的关系",
      execution: {
        steps: [],
        gaps: [],
        skipped: [],
        resolvedSlugs: new Map([["实体A", "page/entity-a"]]),
        budgetUsed: { llmCalls: 0, searches: 0, ms: 5 },
        status: "ok",
      },
    }));

    expect(result.sufficient).toBe(false);
    expect(result.missing).toContain("relationship evidence missing");
    expect(result.follow_up_steps.length).toBeGreaterThan(0);
    expect(result.follow_up_steps[0].kind).toBe("graph");
    expect(result.follow_up_steps[0].mode).toBe("neighbors");
  });
});

// --- timeline intent ---

describe("critic — timeline intent", () => {
  it("timeline evidence in board → sufficient", () => {
    const board: EvidenceBoardResult = {
      ...emptyBoard(),
      facts: [{ claim: "事件发生", evidence_type: "fact", source_type: "timeline", source_slug: "page/entity-a", source_category: "agent_inference", trust_state: "trusted", confidence: 0.8 }],
    };
    const result = evaluateSufficiency(makeInput({ intent: "timeline", evidenceBoard: board }));

    expect(result.sufficient).toBe(true);
    expect(result.confidence).toBe("high");
  });

  it("timeline execution step with data → sufficient", () => {
    const result = evaluateSufficiency(makeInput({
      intent: "timeline",
      execution: {
        steps: [makeStep("timeline", [{ id: 1, summary: "事件", event_date: "2026-01-01" }])],
        gaps: [],
        skipped: [],
        resolvedSlugs: new Map(),
        budgetUsed: { llmCalls: 0, searches: 0, ms: 5 },
        status: "ok",
      },
    }));

    expect(result.sufficient).toBe(true);
    expect(result.reasons).toContain("timeline step produced results");
  });

  it("no timeline evidence → insufficient + timeline follow-up", () => {
    const result = evaluateSufficiency(makeInput({
      intent: "timeline",
      query: "实体A的时间线",
      execution: {
        steps: [],
        gaps: [],
        skipped: [],
        resolvedSlugs: new Map([["实体A", "page/entity-a"]]),
        budgetUsed: { llmCalls: 0, searches: 0, ms: 5 },
        status: "ok",
      },
    }));

    expect(result.sufficient).toBe(false);
    expect(result.missing).toContain("timeline evidence missing");
    expect(result.follow_up_steps[0].kind).toBe("timeline");
  });
});

// --- entity_lookup intent ---

describe("critic — entity_lookup intent", () => {
  it("trusted facts → sufficient + high confidence", () => {
    const board: EvidenceBoardResult = {
      ...emptyBoard(),
      facts: [{ claim: "实体A是X", evidence_type: "fact", source_type: "page", source_slug: "page/entity-a", source_category: "agent_inference", trust_state: "trusted", confidence: 0.9 }],
    };
    const result = evaluateSufficiency(makeInput({ intent: "entity_lookup", evidenceBoard: board }));

    expect(result.sufficient).toBe(true);
    expect(result.confidence).toBe("high");
  });

  it("page execution step with data → sufficient + medium confidence", () => {
    const result = evaluateSufficiency(makeInput({
      intent: "entity_lookup",
      execution: {
        steps: [makeStep("page", { slug: "page/entity-a", title: "实体A", type: "entity", body: "内容" })],
        gaps: [],
        skipped: [],
        resolvedSlugs: new Map([["实体A", "page/entity-a"]]),
        budgetUsed: { llmCalls: 0, searches: 0, ms: 5 },
        status: "ok",
      },
    }));

    expect(result.sufficient).toBe(true);
    expect(result.confidence).toBe("medium");
  });

  it("chunks execution step with data → sufficient", () => {
    const result = evaluateSufficiency(makeInput({
      intent: "entity_lookup",
      execution: {
        steps: [makeStep("chunks", [{ id: 1, chunk_index: 0, content: "文本", created_at: "2026-01-01" }])],
        gaps: [],
        skipped: [],
        resolvedSlugs: new Map([["page/entity-a", "page/entity-a"]]),
        budgetUsed: { llmCalls: 0, searches: 0, ms: 5 },
        status: "ok",
      },
    }));

    expect(result.sufficient).toBe(true);
  });

  it("candidate-only evidence → insufficient + not high confidence", () => {
    const board: EvidenceBoardResult = {
      ...emptyBoard(),
      candidates: [{ claim: "可能是X", evidence_type: "candidate", source_type: "page", source_slug: "page/entity-a", source_category: "agent_inference", trust_state: "candidate", confidence: 0.3 }],
    };
    const result = evaluateSufficiency(makeInput({ intent: "entity_lookup", evidenceBoard: board }));

    expect(result.sufficient).toBe(false);
    expect(result.confidence).toBe("low");
    expect(result.missing[0]).toContain("candidate");
  });

  it("no evidence at all → insufficient", () => {
    const result = evaluateSufficiency(makeInput({ intent: "entity_lookup" }));

    expect(result.sufficient).toBe(false);
    expect(result.missing).toContain("entity evidence missing");
    expect(result.follow_up_steps.length).toBeGreaterThan(0);
  });
});

// --- review intent (same rules as entity_lookup) ---

describe("critic — review intent", () => {
  it("uses entity_lookup rules — trusted facts → sufficient", () => {
    const board: EvidenceBoardResult = {
      ...emptyBoard(),
      facts: [{ claim: "评审事实", evidence_type: "fact", source_type: "page", source_slug: "page/entity-a", source_category: "agent_inference", trust_state: "trusted", confidence: 0.9 }],
    };
    const result = evaluateSufficiency(makeInput({ intent: "review", evidenceBoard: board }));

    expect(result.sufficient).toBe(true);
    expect(result.confidence).toBe("high");
  });
});

// --- comparison intent ---

describe("critic — comparison intent", () => {
  it("one source only → insufficient", () => {
    const board: EvidenceBoardResult = {
      ...emptyBoard(),
      facts: [{ claim: "事实A", evidence_type: "fact", source_type: "page", source_slug: "page/entity-a", source_category: "agent_inference", trust_state: "trusted", confidence: 0.9 }],
    };
    const result = evaluateSufficiency(makeInput({ intent: "comparison", evidenceBoard: board }));

    expect(result.sufficient).toBe(false);
    expect(result.missing[0]).toContain("comparison coverage");
    expect(result.follow_up_steps.length).toBeGreaterThan(0);
  });

  it("two distinct source slugs → sufficient", () => {
    const board: EvidenceBoardResult = {
      ...emptyBoard(),
      facts: [
        { claim: "事实A", evidence_type: "fact", source_type: "page", source_slug: "page/entity-a", source_category: "agent_inference", trust_state: "trusted", confidence: 0.9 },
        { claim: "事实B", evidence_type: "fact", source_type: "page", source_slug: "page/entity-b", source_category: "agent_inference", trust_state: "trusted", confidence: 0.9 },
      ],
    };
    const result = evaluateSufficiency(makeInput({ intent: "comparison", evidenceBoard: board }));

    expect(result.sufficient).toBe(true);
    expect(result.confidence).toBe("high");
  });

  it("execution with two page steps for different slugs → sufficient", () => {
    const result = evaluateSufficiency(makeInput({
      intent: "comparison",
      execution: {
        steps: [
          { kind: "page", input: "page/entity-a", data: { slug: "page/entity-a", title: "A" }, latencyMs: 5 },
          { kind: "page", input: "page/entity-b", data: { slug: "page/entity-b", title: "B" }, latencyMs: 5 },
        ],
        gaps: [],
        skipped: [],
        resolvedSlugs: new Map(),
        budgetUsed: { llmCalls: 0, searches: 0, ms: 10 },
        status: "ok",
      },
    }));

    expect(result.sufficient).toBe(true);
  });

  it("empty array data does not count as evidence source", () => {
    const result = evaluateSufficiency(makeInput({
      intent: "comparison",
      execution: {
        steps: [
          { kind: "chunks", input: "page/entity-a", data: [], latencyMs: 5 },
          { kind: "chunks", input: "page/entity-b", data: [], latencyMs: 5 },
        ],
        gaps: [],
        skipped: [],
        resolvedSlugs: new Map(),
        budgetUsed: { llmCalls: 0, searches: 0, ms: 10 },
        status: "ok",
      },
    }));

    expect(result.sufficient).toBe(false);
  });
});

// --- gap_analysis intent ---

describe("critic — gap_analysis intent", () => {
  it("execution gaps with evidence → sufficient", () => {
    const result = evaluateSufficiency(makeInput({
      intent: "gap_analysis",
      evidenceBoard: {
        ...emptyBoard(),
        facts: [{ claim: "已知事实", evidence_type: "fact", source_type: "page", source_slug: "page/entity-a", source_category: "agent_inference", trust_state: "trusted", confidence: 0.9 }],
      },
      execution: {
        steps: [],
        gaps: [{ step: { kind: "resolve", input: "主题C" }, error: "not found", latencyMs: 5 }],
        skipped: [],
        resolvedSlugs: new Map(),
        budgetUsed: { llmCalls: 0, searches: 0, ms: 5 },
        status: "partial",
      },
    }));

    expect(result.sufficient).toBe(true);
    expect(result.reasons).toContain("explicit gaps detected");
  });

  it("no gaps and no evidence → insufficient", () => {
    const result = evaluateSufficiency(makeInput({ intent: "gap_analysis" }));

    expect(result.sufficient).toBe(false);
    expect(result.missing).toContain("evidence or explicit gaps missing");
  });

  it("evidence but no gaps → sufficient", () => {
    const board: EvidenceBoardResult = {
      ...emptyBoard(),
      facts: [{ claim: "发现", evidence_type: "fact", source_type: "page", source_slug: "page/entity-a", source_category: "agent_inference", trust_state: "trusted", confidence: 0.8 }],
    };
    const result = evaluateSufficiency(makeInput({ intent: "gap_analysis", evidenceBoard: board }));

    expect(result.sufficient).toBe(true);
  });
});

// --- follow-up generation ---

describe("critic — follow-up generation", () => {
  it("follow_up_steps capped by maxFollowUpSteps", () => {
    const result = evaluateSufficiency(makeInput({
      intent: "entity_lookup",
      query: "主题C",
      maxFollowUpSteps: 1,
    }));

    expect(result.sufficient).toBe(false);
    expect(result.follow_up_steps.length).toBeLessThanOrEqual(1);
  });

  it("duplicate follow-up steps are deduplicated", () => {
    // entity_lookup missing produces search + page, but with maxFollowUpSteps=2
    // there should be no duplicates even if missing list has multiple entries
    const result = evaluateSufficiency(makeInput({
      intent: "entity_lookup",
      query: "主题C",
      maxFollowUpSteps: 5,
    }));

    const keys = result.follow_up_steps.map((s) => `${s.kind}:${s.input}:${s.mode ?? ""}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("sufficient evidence → no follow-up steps", () => {
    const board: EvidenceBoardResult = {
      ...emptyBoard(),
      facts: [{ claim: "事实", evidence_type: "fact", source_type: "page", source_slug: "page/entity-a", source_category: "agent_inference", trust_state: "trusted", confidence: 0.9 }],
    };
    const result = evaluateSufficiency(makeInput({ intent: "entity_lookup", evidenceBoard: board }));

    expect(result.sufficient).toBe(true);
    expect(result.follow_up_steps).toHaveLength(0);
  });
});

// --- confidence ---

describe("critic — confidence levels", () => {
  it("insufficient always → low", () => {
    const result = evaluateSufficiency(makeInput({ intent: "entity_lookup" }));
    expect(result.confidence).toBe("low");
  });

  it("page evidence without trusted facts → medium", () => {
    const result = evaluateSufficiency(makeInput({
      intent: "entity_lookup",
      execution: {
        steps: [makeStep("page", { slug: "page/entity-a", title: "实体A", body: "内容" })],
        gaps: [],
        skipped: [],
        resolvedSlugs: new Map(),
        budgetUsed: { llmCalls: 0, searches: 0, ms: 5 },
        status: "ok",
      },
    }));

    expect(result.sufficient).toBe(true);
    expect(result.confidence).toBe("medium");
  });

  it("trusted facts → high", () => {
    const board: EvidenceBoardResult = {
      ...emptyBoard(),
      facts: [{ claim: "确认事实", evidence_type: "fact", source_type: "page", source_slug: "page/entity-a", source_category: "agent_inference", trust_state: "trusted", confidence: 0.95 }],
    };
    const result = evaluateSufficiency(makeInput({ intent: "entity_lookup", evidenceBoard: board }));

    expect(result.sufficient).toBe(true);
    expect(result.confidence).toBe("high");
  });

  it("degraded execution caps confidence to low even with trusted facts", () => {
    const board: EvidenceBoardResult = {
      ...emptyBoard(),
      facts: [{ claim: "确认事实", evidence_type: "fact", source_type: "page", source_slug: "page/entity-a", source_category: "agent_inference", trust_state: "trusted", confidence: 0.95 }],
    };
    const result = evaluateSufficiency(makeInput({
      intent: "entity_lookup",
      evidenceBoard: board,
      execution: {
        steps: [],
        gaps: [],
        skipped: [],
        resolvedSlugs: new Map([["实体A", "page/entity-a"]]),
        budgetUsed: { llmCalls: 0, searches: 0, ms: 8000 },
        status: "degraded",
      },
    }));

    expect(result.sufficient).toBe(true);
    expect(result.confidence).toBe("low");
    expect(result.reasons).toContain("execution degraded — confidence capped");
  });
});

// --- relevance filtering ---

describe("critic — relevance filtering", () => {
  it("irrelevant facts don't count for gap_analysis", () => {
    const board: EvidenceBoardResult = {
      ...emptyBoard(),
      facts: [{ claim: "无关事实", evidence_type: "fact", source_type: "page", source_slug: "page/unrelated-entity", source_category: "agent_inference", trust_state: "trusted", confidence: 0.9 }],
    };
    const result = evaluateSufficiency(makeInput({
      intent: "gap_analysis",
      query: "实体A",
      evidenceBoard: board,
      execution: {
        steps: [],
        gaps: [],
        skipped: [],
        resolvedSlugs: new Map([["实体A", "page/entity-a"]]),
        budgetUsed: { llmCalls: 0, searches: 0, ms: 5 },
        status: "ok",
      },
    }));

    expect(result.sufficient).toBe(false);
    expect(result.missing).toContain("evidence or explicit gaps missing");
  });

  it("irrelevant sources don't count for comparison", () => {
    const board: EvidenceBoardResult = {
      ...emptyBoard(),
      facts: [
        { claim: "无关A", evidence_type: "fact", source_type: "page", source_slug: "page/unrelated-a", source_category: "agent_inference", trust_state: "trusted", confidence: 0.9 },
        { claim: "无关B", evidence_type: "fact", source_type: "page", source_slug: "page/unrelated-b", source_category: "agent_inference", trust_state: "trusted", confidence: 0.9 },
      ],
    };
    const result = evaluateSufficiency(makeInput({
      intent: "comparison",
      query: "实体A vs 实体B",
      evidenceBoard: board,
      execution: {
        steps: [],
        gaps: [],
        skipped: [],
        resolvedSlugs: new Map([["实体A", "page/entity-a"], ["实体B", "page/entity-b"]]),
        budgetUsed: { llmCalls: 0, searches: 0, ms: 5 },
        status: "ok",
      },
    }));

    expect(result.sufficient).toBe(false);
    expect(result.missing[0]).toContain("comparison coverage");
  });

  it("relevant facts count for gap_analysis when resolved slugs match", () => {
    const board: EvidenceBoardResult = {
      ...emptyBoard(),
      facts: [{ claim: "相关事实", evidence_type: "fact", source_type: "page", source_slug: "page/entity-a", source_category: "agent_inference", trust_state: "trusted", confidence: 0.9 }],
    };
    const result = evaluateSufficiency(makeInput({
      intent: "gap_analysis",
      query: "实体A",
      evidenceBoard: board,
      execution: {
        steps: [],
        gaps: [],
        skipped: [],
        resolvedSlugs: new Map([["实体A", "page/entity-a"]]),
        budgetUsed: { llmCalls: 0, searches: 0, ms: 5 },
        status: "ok",
      },
    }));

    expect(result.sufficient).toBe(true);
  });

  it("irrelevant user_thoughts don't count for gap_analysis", () => {
    const board: EvidenceBoardResult = {
      ...emptyBoard(),
      user_thoughts: [{ claim: "无关想法", evidence_type: "user_thought", source_type: "page", source_slug: "page/unrelated-entity", source_category: "agent_inference", trust_state: "trusted", confidence: 0.8 }],
    };
    const result = evaluateSufficiency(makeInput({
      intent: "gap_analysis",
      query: "实体A",
      evidenceBoard: board,
      execution: {
        steps: [],
        gaps: [],
        skipped: [],
        resolvedSlugs: new Map([["实体A", "page/entity-a"]]),
        budgetUsed: { llmCalls: 0, searches: 0, ms: 5 },
        status: "ok",
      },
    }));

    expect(result.sufficient).toBe(false);
    expect(result.missing).toContain("evidence or explicit gaps missing");
  });

  it("irrelevant candidates don't count for gap_analysis", () => {
    const board: EvidenceBoardResult = {
      ...emptyBoard(),
      candidates: [{ claim: "无关候选", evidence_type: "candidate", source_type: "page", source_slug: "page/unrelated-entity", source_category: "agent_inference", trust_state: "candidate", confidence: 0.4 }],
    };
    const result = evaluateSufficiency(makeInput({
      intent: "gap_analysis",
      query: "实体A",
      evidenceBoard: board,
      execution: {
        steps: [],
        gaps: [],
        skipped: [],
        resolvedSlugs: new Map([["实体A", "page/entity-a"]]),
        budgetUsed: { llmCalls: 0, searches: 0, ms: 5 },
        status: "ok",
      },
    }));

    expect(result.sufficient).toBe(false);
    expect(result.missing).toContain("evidence or explicit gaps missing");
  });
});

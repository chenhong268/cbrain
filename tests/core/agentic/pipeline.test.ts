import * as criticModule from "../../../src/core/agentic/critic.js";
import { describe, it, expect, spyOn } from "bun:test";
import {
  AgenticResearchPipeline,
  type PipelineInput,
} from "../../../src/core/agentic/pipeline.js";
import type { ExecutorContext } from "../../../src/core/agentic/executor.js";
import { CBrainDB } from "../../../src/storage/sqlite.js";
import { HybridSearch } from "../../../src/core/retrieval/search.js";
import { GraphManager } from "../../../src/core/graph/graph.js";

// --- Mock factories (same pattern as executor.test.ts) ---

type ResolveResult = Array<{ query: string; slug: string | null; title: string | null }>;

function mockDB(overrides: {
  resolveSlugs?: (queries: string[]) => ResolveResult;
  getTimeline?: (slug: string) => unknown[];
  searchTimeline?: (keyword?: string, dateFrom?: string, limit?: number) => unknown[];
  getChunksByPage?: (slug: string, opts?: { summaryLevel?: number }) => unknown[];
  getL1Summary?: (slug: string) => unknown;
  batchGetLinksForSlugs?: (slugs: string[], activeOnly?: boolean) => Map<string, { outgoing: unknown[]; incoming: unknown[] }>;
  batchGetTimelineForSlugs?: (slugs: string[], activeOnly?: boolean) => Map<string, unknown[]>;
  startSearchTraceSession?: (..._: unknown[]) => number;
  finishSearchTraceSession?: (..._: unknown[]) => void;
  addSearchTraceStep?: (..._: unknown[]) => void;
} = {}) {
  let sessionId = 0;
  return {
    resolveSlugs: overrides.resolveSlugs ??
      ((queries: string[]) =>
        queries.map((q) => ({ query: q, slug: `page/${q}`, title: `Title ${q}` }))),
    getTimeline: overrides.getTimeline ??
      ((_slug: string) => [{ id: 1, summary: "event", event_date: "2026-01-01", source: null, created_at: "2026-01-01" }]),
    searchTimeline: overrides.searchTimeline ??
      ((_keyword?: string) => [{ page_slug: "page/a", summary: "found", event_date: "2026-01-01", source: null }]),
    getChunksByPage: overrides.getChunksByPage ??
      ((_slug: string, _opts?: { summaryLevel?: number }) => []),
    getL1Summary: overrides.getL1Summary ?? ((_slug: string) => null),
    batchGetLinksForSlugs: overrides.batchGetLinksForSlugs ?? (() => new Map()),
    batchGetTimelineForSlugs: overrides.batchGetTimelineForSlugs ?? (() => new Map()),
    startSearchTraceSession: overrides.startSearchTraceSession ?? ((..._args: unknown[]) => ++sessionId),
    finishSearchTraceSession: overrides.finishSearchTraceSession ?? ((..._args: unknown[]) => {}),
    addSearchTraceStep: overrides.addSearchTraceStep ?? ((..._args: unknown[]) => {}),
  } as unknown as ExecutorContext["db"];
}

function mockSearch(overrides: { search?: (query: string, opts?: unknown) => Promise<unknown[]> } = {}) {
  return {
    search: overrides.search ??
      (async (_query: string, _opts?: unknown) => [
        { slug: "page/a", score: 0.9, snippet: "found", source: "hybrid" as const },
      ]),
  } as unknown as ExecutorContext["search"];
}

function mockGraph(overrides: { traverse?: (slug: string, opts?: unknown) => unknown[]; getRelatedEntities?: (slug: string, limit?: number) => unknown[] } = {}) {
  return {
    traverse: overrides.traverse ??
      ((_slug: string, _opts?: unknown) => [{ slug: "page/b", title: "Node B", type: "entity", depth: 1 }]),
    getRelatedEntities: overrides.getRelatedEntities ??
      ((_slug: string, _limit?: number) => [{ slug: "page/b", title: "Node B", type: "entity", depth: 1 }]),
  } as unknown as ExecutorContext["graph"];
}

function mockPages(overrides: { getBySlug?: (slug: string) => unknown } = {}) {
  return {
    getBySlug: overrides.getBySlug ??
      ((_slug: string) => ({ slug: "page/a", title: "Title A", type: "entity", body: "content" })),
  } as unknown as ExecutorContext["pages"];
}

function fakeClock(stepMs = 10) {
  let t = 0;
  return () => {
    t += stepMs;
    return t;
  };
}

function makeCtx(overrides: Partial<ExecutorContext> = {}): ExecutorContext {
  return {
    db: mockDB(),
    search: mockSearch(),
    graph: mockGraph(),
    pages: mockPages(),
    ...overrides,
  } as ExecutorContext;
}

function makeInput(overrides: Partial<PipelineInput> = {}): PipelineInput {
  return {
    query: "测试查询",
    ...overrides,
  };
}

function makeLink(slug: string, overrides: Record<string, unknown> = {}) {
  return {
    from_slug: slug,
    to_slug: `page/other-${slug}`,
    relation: "related_to",
    context: `事实 about ${slug}`,
    source_page_slug: slug,
    source_type: "agent_inference",
    trust_state: "trusted",
    confidence: 0.9,
    created_at: "2026-01-01",
    ...overrides,
  };
}

// --- Sufficient one-pass ---

describe("pipeline — sufficient one-pass", () => {
  it("entity_lookup with resolved slug and link evidence → ok", async () => {
    const linksMap = new Map<string, { outgoing: unknown[]; incoming: unknown[] }>();
    linksMap.set("page/实体A", {
      outgoing: [makeLink("page/实体A")],
      incoming: [],
    });

    const ctx = makeCtx({
      db: mockDB({
        batchGetLinksForSlugs: () => linksMap,
        batchGetTimelineForSlugs: () => new Map(),
      }),
      now: fakeClock(),
    });

    const result = await new AgenticResearchPipeline(ctx).run(
      makeInput({ query: "实体A是什么" }),
    );

    expect(result.status).toBe("ok");
    expect(result.critic.sufficient).toBe(true);
    expect(result.follow_up_execution).toBeUndefined();
    expect(result.answer_context.followUpPerformed).toBe(false);
    expect(result.trace_summary.passCount).toBe(1);
    expect(result.trace_summary.errors).toHaveLength(0);
  });
});

// --- Insufficient → sufficient after follow-up ---

describe("pipeline — insufficient then sufficient after follow-up", () => {
  it("empty first pass, follow-up produces evidence → partial", async () => {
    let dbCallCount = 0;
    let pageCallCount = 0;
    const linksMapPass2 = new Map<string, { outgoing: unknown[]; incoming: unknown[] }>();
    linksMapPass2.set("page/实体A", {
      outgoing: [makeLink("page/实体A")],
      incoming: [],
    });

    const ctx = makeCtx({
      db: mockDB({
        batchGetLinksForSlugs: () => {
          dbCallCount++;
          return dbCallCount <= 1 ? new Map() : linksMapPass2;
        },
        batchGetTimelineForSlugs: () => new Map(),
      }),
      pages: mockPages({
        getBySlug: () => {
          pageCallCount++;
          return pageCallCount <= 1
            ? null
            : { slug: "page/实体A", title: "实体A", type: "entity", body: "内容" };
        },
      }),
      now: fakeClock(),
    });

    const result = await new AgenticResearchPipeline(ctx).run(
      makeInput({ query: "实体A", knownSlugs: ["page/实体A"] }),
    );

    expect(result.follow_up_execution).toBeDefined();
    expect(result.answer_context.followUpPerformed).toBe(true);
    expect(result.trace_summary.passCount).toBe(2);
    // Sufficient after follow-up = partial
    expect(result.status).toBe("partial");
    expect(result.follow_up_critic?.sufficient).toBe(true);
    // Merged board should have facts from follow-up
    expect(result.evidence_board.facts.length).toBeGreaterThan(0);
  });
});

// --- Insufficient after follow-up ---

describe("pipeline — insufficient after follow-up", () => {
  it("both passes return empty evidence → insufficient", async () => {
    const ctx = makeCtx({
      db: mockDB({
        batchGetLinksForSlugs: () => new Map(),
        batchGetTimelineForSlugs: () => new Map(),
      }),
      pages: mockPages({ getBySlug: () => null }),
      now: fakeClock(),
    });

    const result = await new AgenticResearchPipeline(ctx).run(
      makeInput({ query: "实体A是什么" }),
    );

    expect(result.status).toBe("insufficient");
    expect(result.follow_up_execution).toBeDefined();
    expect(result.follow_up_critic?.sufficient).toBe(false);
    expect(result.trace_summary.passCount).toBe(2);
    expect(result.evidence_board.facts).toHaveLength(0);
  });
});

// --- Executor error isolation ---

describe("pipeline — executor error isolation", () => {
  it("executor throws → pipeline returns degraded result", async () => {
    const ctx = makeCtx({
      db: mockDB({
        batchGetLinksForSlugs: () => {
          throw new Error("DB connection lost");
        },
      }),
      now: fakeClock(),
    });

    const result = await new AgenticResearchPipeline(ctx).run(
      makeInput({ query: "实体A是什么" }),
    );

    // Should still return a result, not throw
    expect(result).toBeDefined();
    expect(result.status).toBe("degraded");
    expect(result.trace_summary.errors.length).toBeGreaterThan(0);
  });
});

// --- Budget degradation ---

describe("pipeline — budget degradation", () => {
  it("budget exhausted → degraded, no follow-up attempted", async () => {
    // Use a very tight budget that will degrade after first search
    const ctx = makeCtx({
      db: mockDB({
        batchGetLinksForSlugs: () => new Map(),
        batchGetTimelineForSlugs: () => new Map(),
      }),
      now: fakeClock(),
    });

    const result = await new AgenticResearchPipeline(ctx).run(
      makeInput({
        query: "实体A是什么",
        budgetOverride: { max_ms: 1, max_searches: 1, max_llm_calls: 1 },
      }),
    );

    // Execution should degrade due to budget
    expect(result.execution.status).toBe("degraded");
    // Pipeline status = degraded
    expect(result.status).toBe("degraded");
    // No follow-up attempted on degraded execution
    expect(result.follow_up_execution).toBeUndefined();
  });
});

// --- Sufficient one-pass (no follow-up needed) ---

describe("pipeline — sufficient one-pass skips follow-up", () => {
  it("entity_lookup with sufficient evidence → no follow-up", async () => {
    const linksMap = new Map<string, { outgoing: unknown[]; incoming: unknown[] }>();
    linksMap.set("page/实体A", {
      outgoing: [makeLink("page/实体A")],
      incoming: [],
    });

    const ctx = makeCtx({
      db: mockDB({
        batchGetLinksForSlugs: () => linksMap,
        batchGetTimelineForSlugs: () => new Map(),
      }),
      now: fakeClock(),
    });

    const result = await new AgenticResearchPipeline(ctx).run(
      makeInput({ query: "实体A", intentHint: "entity_lookup" }),
    );

    // entity_lookup with facts → sufficient, no follow-up needed
    expect(result.critic.sufficient).toBe(true);
    expect(result.follow_up_execution).toBeUndefined();
  });
});

// --- Planner fallback ---

describe("pipeline — planner fallback", () => {
  it("empty query triggers fallback plan → pipeline still runs", async () => {
    const linksMap = new Map<string, { outgoing: unknown[]; incoming: unknown[] }>();

    const ctx = makeCtx({
      db: mockDB({
        batchGetLinksForSlugs: () => linksMap,
        batchGetTimelineForSlugs: () => new Map(),
      }),
      now: fakeClock(),
    });

    const result = await new AgenticResearchPipeline(ctx).run(
      makeInput({ query: "" }),
    );

    // Planner returns fallback for empty query
    expect(result).toBeDefined();
    expect(result.intent).toBe("entity_lookup");
  });
});

// --- answer_context compactness ---

describe("pipeline — answer_context compactness", () => {
  it("answer_context has no page bodies, claims truncated", async () => {
    const longClaim = "A".repeat(200);
    const linksMap = new Map<string, { outgoing: unknown[]; incoming: unknown[] }>();
    linksMap.set("page/实体A", {
      outgoing: [{
        ...makeLink("page/实体A"),
        context: longClaim,
      }],
      incoming: [],
    });

    const ctx = makeCtx({
      db: mockDB({
        batchGetLinksForSlugs: () => linksMap,
        batchGetTimelineForSlugs: () => new Map(),
      }),
      now: fakeClock(),
    });

    const result = await new AgenticResearchPipeline(ctx).run(
      makeInput({ query: "实体A是什么" }),
    );

    const ac = result.answer_context;
    // Claims truncated to 100 + "..."
    for (const claim of ac.topClaims) {
      expect(claim.length).toBeLessThanOrEqual(103);
    }
    // No page body fields
    expect(Object.keys(ac)).not.toContain("body");
    expect(Object.keys(ac)).not.toContain("pageBody");
  });

  it("answer_context includes source slugs and gaps", async () => {
    const linksMap = new Map<string, { outgoing: unknown[]; incoming: unknown[] }>();
    linksMap.set("page/实体A", {
      outgoing: [makeLink("page/实体A")],
      incoming: [],
    });

    const ctx = makeCtx({
      db: mockDB({
        batchGetLinksForSlugs: () => linksMap,
        batchGetTimelineForSlugs: () => new Map(),
      }),
      now: fakeClock(),
    });

    const result = await new AgenticResearchPipeline(ctx).run(
      makeInput({ query: "实体A" }),
    );

    expect(result.answer_context.sourceSlugs.length).toBeGreaterThan(0);
    expect(result.answer_context.intent).toBe("entity_lookup");
  });
});

// --- Evidence board merging ---

describe("pipeline — evidence board merging", () => {
  it("follow-up adds new facts not in primary board", async () => {
    let dbCallCount = 0;
    let pageCallCount = 0;
    const linksPass2 = new Map<string, { outgoing: unknown[]; incoming: unknown[] }>();
    linksPass2.set("page/实体A", {
      outgoing: [
        makeLink("page/实体A", { context: "事实 from follow-up" }),
      ],
      incoming: [],
    });

    const ctx = makeCtx({
      db: mockDB({
        batchGetLinksForSlugs: () => {
          dbCallCount++;
          return dbCallCount <= 1 ? new Map() : linksPass2;
        },
        batchGetTimelineForSlugs: () => new Map(),
      }),
      pages: mockPages({
        getBySlug: () => {
          pageCallCount++;
          return pageCallCount <= 1
            ? null
            : { slug: "page/实体A", title: "实体A", type: "entity", body: "内容" };
        },
      }),
      now: fakeClock(),
    });

    const result = await new AgenticResearchPipeline(ctx).run(
      makeInput({ query: "实体A", knownSlugs: ["page/实体A"] }),
    );

    expect(result.follow_up_execution).toBeDefined();
    // Primary board was empty, follow-up board has facts → merged should have facts
    expect(result.evidence_board.facts.length).toBeGreaterThan(0);
    // The fact should be from the follow-up
    expect(result.evidence_board.facts.some((f) => f.claim.includes("follow-up"))).toBe(true);
  });
});

// --- Follow-up inherits budget override ---

describe("pipeline — follow-up inherits budget override", () => {
  it("follow-up degrades when inheriting max_searches: 0", async () => {
    // entity_lookup plan = [resolve, page] — no search steps, so first pass is OK.
    // pages.getBySlug returns null → no evidence → critic says insufficient.
    // Critic follow_up_steps include { kind: "search", ... }.
    // With max_searches: 0, the follow-up executor hits search budget → degraded.
    const ctx = makeCtx({
      db: mockDB({
        batchGetLinksForSlugs: () => new Map(),
        batchGetTimelineForSlugs: () => new Map(),
      }),
      pages: mockPages({ getBySlug: () => null }),
      now: fakeClock(),
    });

    const result = await new AgenticResearchPipeline(ctx).run(
      makeInput({
        query: "实体A",
        knownSlugs: ["page/实体A"],
        budgetOverride: { max_searches: 0 },
      }),
    );

    // First pass: no search steps, so not degraded
    expect(result.execution.status).toBe("ok");
    // First pass: insufficient evidence, critic wants follow-up
    expect(result.critic.sufficient).toBe(false);
    expect(result.critic.follow_up_steps.length).toBeGreaterThan(0);
    // Follow-up attempted
    expect(result.follow_up_execution).toBeDefined();
    // Follow-up inherits max_searches: 0 → search step triggers degraded
    expect(result.follow_up_execution!.status).toBe("degraded");
    // Pipeline overall = degraded because follow-up degraded
    expect(result.status).toBe("degraded");
  });

  it("returned plan reflects budgetOverride even without follow-up", async () => {
    const linksMap = new Map<string, { outgoing: unknown[]; incoming: unknown[] }>();
    linksMap.set("page/实体A", {
      outgoing: [makeLink("page/实体A")],
      incoming: [],
    });

    const ctx = makeCtx({
      db: mockDB({
        batchGetLinksForSlugs: () => linksMap,
        batchGetTimelineForSlugs: () => new Map(),
      }),
      now: fakeClock(),
    });

    const result = await new AgenticResearchPipeline(ctx).run(
      makeInput({
        query: "实体A",
        budgetOverride: { max_searches: 5 },
      }),
    );

    expect(result.plan.budget.max_searches).toBe(5);
  });
});

describe("one budget for the complete research request (#481)", () => {
  const searchPlan = (steps = 1) => JSON.stringify({
    intent: "entity_lookup", entities: [],
    steps: Array.from({ length: steps }, () => ({ kind: "search", input: "实体A" })),
    budget: { max_llm_calls: 3, max_searches: 8, max_ms: 8000 },
  });

  it("counts planning time/calls and does not replenish searches for follow-up", async () => {
    let clock = 0, calls = 0, searches = 0;
    const ctx = makeCtx({
      now: () => clock,
      llm: { name: "fixture", async chat() { calls++; clock += 200; return searchPlan(); } },
      search: mockSearch({ async search() { searches++; clock += 10; return []; } }),
    });
    const result = await new AgenticResearchPipeline(ctx).run({
      query: "实体A", budgetOverride: { max_searches: 1, max_llm_calls: 1, max_ms: 1000 },
    });
    expect(searches).toBe(1);
    expect(calls).toBe(1);
    expect(result.trace_summary.budgetUsed).toEqual({ searches: 1, llmCalls: 1, ms: 210 });
    expect(result.trace_summary.totalMs).toBe(210);
    expect(result.status).toBe("degraded");
  });

  it("counts failed planning attempts and still permits deterministic reads", async () => {
    let calls = 0;
    const ctx = makeCtx({ llm: { name: "fixture", async chat() { calls++; throw new Error("offline"); } } });
    const result = await new AgenticResearchPipeline(ctx).run({ query: "实体A", budgetOverride: { max_llm_calls: 1 } });
    expect(calls).toBe(1);
    expect(result.trace_summary.budgetUsed.llmCalls).toBe(1);
    expect(result.execution.steps.length).toBeGreaterThan(0);
  });

  it("real hybrid search cannot spend an untracked model call on expansion", async () => {
    const db = new CBrainDB(":memory:");
    let calls = 0;
    const llm = { name: "fixture", async chat() { calls++; return calls === 1 ? searchPlan() : "[]"; } };
    const embedding = {
      dimensions: 2,
      async embed() { return { embedding: [1, 0], tokenCount: 1 }; },
      async embedBatch() { return []; },
    };
    const graph = new GraphManager(db);
    const search = new HybridSearch(db, embedding, { search: async () => [] } as never, { llm, graph });
    try {
      const result = await new AgenticResearchPipeline(makeCtx({ db, search, graph, llm })).run({
        query: "实体A", budgetOverride: { max_llm_calls: 1, max_searches: 1 },
      });
      expect(calls).toBe(1);
      expect(result.trace_summary.budgetUsed.llmCalls).toBe(calls);
      expect(result.trace_summary.budgetUsed.searches).toBe(1);
    } finally { db.close(); }
  });

  it("counts failed searches before deciding whether another may start", async () => {
    let searches = 0;
    const ctx = makeCtx({
      llm: { name: "fixture", async chat() { return searchPlan(2); } },
      search: mockSearch({ async search() { searches++; throw new Error("offline"); } }),
    });
    const result = await new AgenticResearchPipeline(ctx).run({ query: "实体A", budgetOverride: { max_searches: 1 } });
    expect(searches).toBe(1);
    expect(result.trace_summary.budgetUsed.searches).toBe(1);
    expect(result.status).toBe("degraded");
  });

  for (const failure of ["throw", "slow"] as const) it(`preserves consumed budget when evidence collection is ${failure}`, async () => {
    let clock = 0;
    const ctx = makeCtx({
      now: () => clock,
      llm: { name: "fixture", async chat() { return searchPlan(); } },
      search: mockSearch({ async search() { clock += 10; return [{ slug: "page/a", score: 1, snippet: "实体A", source: "hybrid" }]; } }),
      db: mockDB({ batchGetLinksForSlugs() {
        if (failure === "throw") throw new Error("anonymous collection failure");
        clock += 1100;
        return new Map([["page/a", { outgoing: [makeLink("page/a")], incoming: [] }]]);
      } }),
    });
    const result = await new AgenticResearchPipeline(ctx).run({ query: "实体A", budgetOverride: { max_searches: 1, max_ms: 1000 } });
    expect(result.execution.budgetUsed.searches).toBe(1);
    expect(result.execution.steps.length).toBe(1);
    expect(result.trace_summary.budgetUsed.searches).toBe(1);
    expect(result.execution.status).toBe("degraded");
    expect(result.status).toBe("degraded");
    if (failure === "slow") expect(result.execution.totalMs).toBe(1110);
  });

  it("does not start a model when the caller has no model budget", async () => {
    let calls = 0;
    const ctx = makeCtx({ llm: { name: "fixture", async chat() { calls++; return searchPlan(); } } });
    const result = await new AgenticResearchPipeline(ctx).run({ query: "实体A", budgetOverride: { max_llm_calls: 0 } });
    expect(calls).toBe(0);
    expect(result.trace_summary.budgetUsed.llmCalls).toBe(0);
    expect(result.execution.steps.length).toBeGreaterThan(0);
  });

  it("a stalled planner returns degraded and a late plan cannot start searches", async () => {
    let searches = 0;
    let finish!: (plan: string) => void;
    const ctx = makeCtx({
      llm: { name: "fixture", chat: () => new Promise(resolve => { finish = resolve; }) },
      search: mockSearch({ async search() { searches++; return []; } }),
    });
    const result = await new AgenticResearchPipeline(ctx).run({ query: "实体A", budgetOverride: { max_ms: 30 } });
    expect(result.status).toBe("degraded");
    expect(result.trace_summary.budgetUsed.llmCalls).toBe(1);
    expect(result.trace_summary.totalMs).toBeGreaterThanOrEqual(25);
    finish(searchPlan());
    await Bun.sleep(5);
    expect(searches).toBe(0);
  }, 1000);

  it("a stalled search cannot keep the request open or start later steps", async () => {
    let searches = 0;
    let finish!: (result: []) => void;
    const ctx = makeCtx({
      llm: { name: "fixture", async chat() { return searchPlan(2); } },
      search: mockSearch({ search: () => { searches++; return new Promise(resolve => { finish = resolve; }); } }),
    });
    const result = await new AgenticResearchPipeline(ctx).run({ query: "实体A", budgetOverride: { max_ms: 30 } });
    expect(result.status).toBe("degraded");
    expect(result.trace_summary.budgetUsed.searches).toBe(1);
    finish([]);
    await Bun.sleep(5);
    expect(searches).toBe(1);
  }, 1000);
});


describe("pipeline — critic failures", () => {
  for (const failedPass of [1, 2]) {
    it(`retains evidence and fails closed when critic pass ${failedPass} throws`, async () => {
      const diagnostic = failedPass === 1 ? "critic_error" : "follow_up_critic_error";
      let calls = 0;
      const spy = spyOn(criticModule, "evaluateSufficiency").mockImplementation(() => {
        calls++;
        if (calls === failedPass) throw new Error("private-provider-detail");
        return { sufficient: false, confidence: "low", missing: ["evidence missing"],
          follow_up_steps: [{ kind: "page", input: "page/实体A", detail: "full" }], reasons: [] };
      });
      try {
        const result = await new AgenticResearchPipeline(makeCtx({
          db: mockDB({ batchGetTimelineForSlugs: () => new Map(), batchGetLinksForSlugs: () => new Map([
            ["page/实体A", { outgoing: [makeLink("page/实体A")], incoming: [] }],
          ]) }),
        })).run(makeInput({ query: "实体A是什么", knownSlugs: ["page/实体A"] }));
        expect(calls).toBe(failedPass);
        expect(result.status).toBe("degraded");
        expect(result.follow_up_critic?.sufficient ?? result.critic.sufficient).toBe(false);
        expect(result.answer_context.confidence).toBe("low");
        expect(result.evidence_board.facts.length).toBeGreaterThan(0);
        expect(result.answer_context.gaps).toContain(diagnostic);
        expect(result.trace_summary.errors).toContain(diagnostic);
        expect(JSON.stringify(result)).not.toContain("private-provider-detail");
        expect(result.trace_summary.passCount).toBe(failedPass);
      } finally {
        spy.mockRestore();
      }
    });
  }
});

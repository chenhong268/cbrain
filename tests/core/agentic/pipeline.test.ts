import { describe, it, expect } from "bun:test";
import {
  AgenticResearchPipeline,
  type PipelineInput,
} from "../../../src/core/agentic/pipeline.js";
import type { ExecutorContext } from "../../../src/core/agentic/executor.js";

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

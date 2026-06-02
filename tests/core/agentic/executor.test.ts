import { describe, it, expect } from "bun:test";
import { AgenticResearchExecutor, type ExecutorContext } from "../../../src/core/agentic/executor.js";
import type { PlanResult, SearchPlanStep } from "../../../src/core/agentic/plan.js";
import { SearchPlanBudget } from "../../../src/core/agentic/plan.js";

// --- Mock factories ---

type ResolveResult = Array<{ query: string; slug: string | null; title: string | null }>;

function mockDB(overrides: {
  resolveSlugs?: (queries: string[]) => ResolveResult;
  getTimeline?: (slug: string) => unknown[];
  searchTimeline?: (keyword?: string, dateFrom?: string, limit?: number) => unknown[];
  getChunksByPage?: (slug: string, opts?: { summaryLevel?: number }) => unknown[];
  batchGetLinksForSlugs?: (slugs: string[], activeOnly?: boolean) => Map<string, { outgoing: unknown[]; incoming: unknown[] }>;
  batchGetTimelineForSlugs?: (slugs: string[], activeOnly?: boolean) => Map<string, unknown[]>;
  startSearchTraceSession?: (..._: unknown[]) => number;
  finishSearchTraceSession?: (..._: unknown[]) => void;
  addSearchTraceStep?: (..._: unknown[]) => void;
} = {}) {
  let sessionId = 0;
  return {
    resolveSlugs: overrides.resolveSlugs ?? ((queries: string[]) =>
      queries.map((q) => ({ query: q, slug: `slug-${q}`, title: `Title ${q}` }))
    ),
    getTimeline: overrides.getTimeline ?? ((_slug: string) => [{ id: 1, summary: "event", event_date: "2026-01-01", source: null, created_at: "2026-01-01" }]),
    searchTimeline: overrides.searchTimeline ?? ((_keyword?: string) => [{ page_slug: "slug-a", summary: "found", event_date: "2026-01-01", source: null }]),
    getChunksByPage: overrides.getChunksByPage ?? ((_slug: string, _opts?: { summaryLevel?: number }) => [{ id: 1, chunk_index: 0, content: "chunk text", created_at: "2026-01-01" }]),
    batchGetLinksForSlugs: overrides.batchGetLinksForSlugs ?? (() => new Map()),
    batchGetTimelineForSlugs: overrides.batchGetTimelineForSlugs ?? (() => new Map()),
    startSearchTraceSession: overrides.startSearchTraceSession ?? ((..._args: unknown[]) => ++sessionId),
    finishSearchTraceSession: overrides.finishSearchTraceSession ?? ((..._args: unknown[]) => {}),
    addSearchTraceStep: overrides.addSearchTraceStep ?? ((..._args: unknown[]) => {}),
  } as unknown as ExecutorContext["db"];
}

function mockSearch(overrides: { search?: (query: string, opts?: unknown) => Promise<unknown[]> } = {}) {
  return {
    search: overrides.search ?? (async (_query: string, _opts?: unknown) => [
      { slug: "slug-a", score: 0.9, snippet: "found", source: "hybrid" as const },
    ]),
  } as unknown as ExecutorContext["search"];
}

function mockGraph(overrides: { traverse?: (slug: string, opts?: unknown) => unknown[]; getRelatedEntities?: (slug: string, limit?: number) => unknown[] } = {}) {
  return {
    traverse: overrides.traverse ?? ((_slug: string, _opts?: unknown) => [{ slug: "slug-b", title: "Node B", type: "entity", depth: 1 }]),
    getRelatedEntities: overrides.getRelatedEntities ?? ((_slug: string, _limit?: number) => [{ slug: "slug-b", title: "Node B", type: "entity", depth: 1 }]),
  } as unknown as ExecutorContext["graph"];
}

function mockPages(overrides: { getBySlug?: (slug: string) => unknown } = {}) {
  return {
    getBySlug: overrides.getBySlug ?? ((_slug: string) => ({ slug: "slug-a", title: "Title A", type: "entity", body: "content" })),
  } as unknown as ExecutorContext["pages"];
}

function fakeClock(stepMs = 10) {
  let t = 0;
  return () => { t += stepMs; return t; };
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

function makePlan(steps: SearchPlanStep[], entities: string[] = [], extra: Record<string, unknown> = {}): PlanResult {
  return {
    intent: "entity_lookup",
    entities,
    steps,
    budget: SearchPlanBudget.parse({}),
    ...extra,
  } as PlanResult;
}

// --- Step kind tests ---

describe("AgenticResearchExecutor — step dispatch", () => {
  it("resolve step calls db.resolveSlugs and populates resolvedSlugs", async () => {
    const db = mockDB({
      resolveSlugs: (queries) => queries.map((q) => ({ query: q, slug: "resolved-slug", title: "Resolved" })),
    });
    const executor = new AgenticResearchExecutor({ db, search: mockSearch(), graph: mockGraph(), pages: mockPages() });
    const result = await executor.execute(makePlan([{ kind: "resolve", input: "实体A" }]));

    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].kind).toBe("resolve");
    expect(result.resolvedSlugs.get("实体A")).toBe("resolved-slug");
  });

  it("search step calls search.search with _skipDecompose", async () => {
    let capturedOpts: unknown;
    const search = mockSearch({
      search: async (_query: string, opts?: unknown) => {
        capturedOpts = opts;
        return [{ slug: "s1", score: 0.8, snippet: "x", source: "hybrid" }];
      },
    });
    const executor = new AgenticResearchExecutor(makeCtx({ search }));
    const result = await executor.execute(makePlan([{ kind: "search", input: "test query" }]));

    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].kind).toBe("search");
    expect((capturedOpts as Record<string, unknown>)?._skipDecompose).toBe(true);
  });

  it("graph step with mode=neighbors calls graph.getRelatedEntities", async () => {
    let capturedSlug = "";
    let capturedLimit = 0;
    const graph = mockGraph({
      getRelatedEntities: (slug: string, limit?: number) => {
        capturedSlug = slug;
        capturedLimit = limit ?? 0;
        return [{ slug: "neighbor", title: "N", type: "entity", depth: 1 }];
      },
    });
    const executor = new AgenticResearchExecutor(makeCtx({ graph }));
    const plan = makePlan([
      { kind: "resolve", input: "实体A" },
      { kind: "graph", input: "实体A", mode: "neighbors" },
    ]);
    const result = await executor.execute(plan);

    expect(result.steps).toHaveLength(2);
    expect(result.steps[1].kind).toBe("graph");
    expect(capturedSlug).toBe("slug-实体A");
    expect(capturedLimit).toBe(25);
  });

  it("graph step with mode=traverse calls graph.traverse with maxDepth", async () => {
    let capturedOpts: unknown;
    const graph = mockGraph({
      traverse: (_slug: string, opts?: unknown) => {
        capturedOpts = opts;
        return [{ slug: "deep", title: "D", type: "entity", depth: 2 }];
      },
    });
    const executor = new AgenticResearchExecutor(makeCtx({ graph }));
    const result = await executor.execute(makePlan([{ kind: "graph", input: "slug-x", mode: "traverse" }], ["slug-x"]));

    expect(result.steps).toHaveLength(1);
    expect((capturedOpts as Record<string, unknown>)?.maxDepth).toBe(3);
  });

  it("timeline step with resolved slug calls db.getTimeline", async () => {
    let capturedSlug = "";
    const db = mockDB({
      getTimeline: (slug: string) => {
        capturedSlug = slug;
        return [{ id: 1, summary: "event", event_date: "2026-01-01", source: null, created_at: "2026-01-01" }];
      },
    });
    const executor = new AgenticResearchExecutor(makeCtx({ db }));
    const plan = makePlan([
      { kind: "resolve", input: "实体A" },
      { kind: "timeline", input: "实体A" },
    ]);
    const result = await executor.execute(plan);

    expect(result.steps).toHaveLength(2);
    expect(capturedSlug).toBe("slug-实体A");
  });

  it("timeline step without resolved slug calls db.searchTimeline", async () => {
    let capturedQuery = "";
    const db = mockDB({
      searchTimeline: (keyword?: string) => {
        capturedQuery = keyword ?? "";
        return [{ page_slug: "x", summary: "found", event_date: "2026-01-01", source: null }];
      },
    });
    const executor = new AgenticResearchExecutor(makeCtx({ db }));
    const result = await executor.execute(makePlan([{ kind: "timeline", input: "某关键词" }]));

    expect(result.steps).toHaveLength(1);
    expect(capturedQuery).toBe("某关键词");
  });

  it("page step calls pages.getBySlug with resolved slug", async () => {
    let capturedSlug = "";
    const pages = mockPages({
      getBySlug: (slug: string) => {
        capturedSlug = slug;
        return { slug, title: "T", type: "entity", body: "body" };
      },
    });
    const executor = new AgenticResearchExecutor(makeCtx({ pages }));
    const plan = makePlan([
      { kind: "resolve", input: "实体A" },
      { kind: "page", input: "实体A" },
    ]);
    const result = await executor.execute(plan);

    expect(result.steps).toHaveLength(2);
    expect(capturedSlug).toBe("slug-实体A");
  });

  it("chunks step calls db.getChunksByPage with slug", async () => {
    let capturedSlug = "";
    const db = mockDB({
      getChunksByPage: (slug: string) => {
        capturedSlug = slug;
        return [{ id: 1, chunk_index: 0, content: "text", created_at: "2026-01-01" }];
      },
    });
    const executor = new AgenticResearchExecutor(makeCtx({ db }));
    const result = await executor.execute(makePlan([{ kind: "chunks", input: "slug-x" }], ["slug-x"]));

    expect(result.steps).toHaveLength(1);
    expect(capturedSlug).toBe("slug-x");
  });
});

// --- Error isolation tests ---

describe("AgenticResearchExecutor — error isolation", () => {
  it("single step throw becomes gap, remaining steps continue", async () => {
    const pages = mockPages({
      getBySlug: () => { throw new Error("page boom"); },
    });
    const executor = new AgenticResearchExecutor(makeCtx({ pages }));
    const plan = makePlan(
      [
        { kind: "resolve", input: "a" },
        { kind: "page", input: "a" },
        { kind: "chunks", input: "slug-a" },
      ],
      ["slug-a"],
    );
    const result = await executor.execute(plan);

    expect(result.steps).toHaveLength(2);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0].step.kind).toBe("page");
    expect(result.gaps[0].error).toContain("page boom");
  });

  it("multiple step failures produce multiple gaps", async () => {
    const pages = mockPages({ getBySlug: () => { throw new Error("page fail"); } });
    const graph = mockGraph({
      traverse: () => { throw new Error("graph fail"); },
      getRelatedEntities: () => { throw new Error("graph fail"); },
    });
    const executor = new AgenticResearchExecutor(makeCtx({ pages, graph }));
    const plan = makePlan(
      [
        { kind: "page", input: "slug-a" },
        { kind: "graph", input: "slug-a" },
        { kind: "chunks", input: "slug-a" },
      ],
      ["slug-a"],
    );
    const result = await executor.execute(plan);

    expect(result.steps).toHaveLength(1);
    expect(result.gaps).toHaveLength(2);
  });

  it("all steps fail → results empty, gaps equal steps count", async () => {
    const pages = mockPages({ getBySlug: () => { throw new Error("fail"); } });
    const db = mockDB({
      resolveSlugs: () => { throw new Error("resolve fail"); },
    });
    const executor = new AgenticResearchExecutor(makeCtx({ pages, db }));
    const plan = makePlan([
      { kind: "resolve", input: "a" },
      { kind: "page", input: "a" },
    ]);
    const result = await executor.execute(plan);

    expect(result.steps).toHaveLength(0);
    expect(result.gaps).toHaveLength(2);
  });

  it("status is partial when gaps exist but no budget exhaustion", async () => {
    const pages = mockPages({ getBySlug: () => { throw new Error("fail"); } });
    const executor = new AgenticResearchExecutor(makeCtx({ pages }));
    const result = await executor.execute(makePlan(
      [{ kind: "page", input: "slug-a" }],
      ["slug-a"],
    ));

    expect(result.status).toBe("partial");
  });
});

// --- Budget tests ---

describe("AgenticResearchExecutor — budget enforcement", () => {
  it("max_searches exhausted → all remaining steps skipped + degraded", async () => {
    const search = mockSearch({
      search: async () => [{ slug: "s", score: 0.9, snippet: "x", source: "hybrid" as const }],
    });
    const executor = new AgenticResearchExecutor(makeCtx({ search }));
    const plan = makePlan(
      [
        { kind: "search", input: "q1" },
        { kind: "search", input: "q2" },
        { kind: "chunks", input: "slug-x" },
      ],
      [],
      { budget: SearchPlanBudget.parse({ max_searches: 1 }) },
    );
    const result = await executor.execute(plan);

    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].kind).toBe("search");
    expect(result.status).toBe("degraded");
    expect(result.degradedReason).toContain("Search budget exhausted");
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped[0].step.kind).toBe("search");
    expect(result.skipped[1].step.kind).toBe("chunks");
  });

  it("wall-clock budget exhausted → degraded with all remaining skipped", async () => {
    const clock = fakeClock(500);
    const executor = new AgenticResearchExecutor(makeCtx({ now: clock }));
    const plan = makePlan(
      [
        { kind: "resolve", input: "a" },
        { kind: "search", input: "a" },
        { kind: "page", input: "slug-a" },
      ],
      [],
      { budget: SearchPlanBudget.parse({ max_ms: 1000 }) },
    );
    const result = await executor.execute(plan);

    expect(result.status).toBe("degraded");
    expect(result.degradedReason).toContain("Wall-clock budget");
    expect(result.skipped.length).toBeGreaterThanOrEqual(1);
  });
});

// --- Resolve gap chain tests ---

describe("AgenticResearchExecutor — resolve gap chain", () => {
  it("resolve returns null → downstream slug-dependent steps skipped", async () => {
    const db = mockDB({
      resolveSlugs: (queries) => queries.map((q) => ({ query: q, slug: null, title: null })),
    });
    const executor = new AgenticResearchExecutor(makeCtx({ db }));
    const plan = makePlan([
      { kind: "resolve", input: "unknown" },
      { kind: "graph", input: "unknown", mode: "neighbors" },
      { kind: "page", input: "unknown" },
      { kind: "chunks", input: "unknown" },
    ]);
    const result = await executor.execute(plan);

    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].kind).toBe("resolve");
    expect(result.skipped).toHaveLength(3);
    expect(result.skipped.map((s) => s.step.kind)).toEqual(["graph", "page", "chunks"]);
    expect(result.skipped[0].reason).toContain("Unresolved entity");
  });

  it("resolve returns null → non-slug-dependent steps still execute", async () => {
    const db = mockDB({
      resolveSlugs: (queries) => queries.map((q) => ({ query: q, slug: null, title: null })),
    });
    const executor = new AgenticResearchExecutor(makeCtx({ db }));
    const plan = makePlan([
      { kind: "resolve", input: "unknown" },
      { kind: "search", input: "unknown" },
      { kind: "timeline", input: "unknown" },
      { kind: "page", input: "unknown" },
    ]);
    const result = await executor.execute(plan);

    expect(result.steps).toHaveLength(3);
    expect(result.steps.map((s) => s.kind)).toEqual(["resolve", "search", "timeline"]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].step.kind).toBe("page");
  });

  it("resolve returns null → gap appears in gaps array", async () => {
    const db = mockDB({
      resolveSlugs: (queries) => queries.map((q) => ({ query: q, slug: null, title: null })),
    });
    const executor = new AgenticResearchExecutor(makeCtx({ db }));
    const result = await executor.execute(makePlan([
      { kind: "resolve", input: "unknown-entity" },
    ]));

    expect(result.steps).toHaveLength(1);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0].step.kind).toBe("resolve");
    expect(result.gaps[0].error).toContain("no slug found");
  });
});

// --- Entity seeding tests ---

describe("AgenticResearchExecutor — entity seeding", () => {
  it("plan entities with / separator are seeded as resolved slugs", async () => {
    const executor = new AgenticResearchExecutor(makeCtx());
    const result = await executor.execute(makePlan(
      [{ kind: "page", input: "person/entity-a" }],
      ["person/entity-a"],
    ));

    expect(result.resolvedSlugs.get("person/entity-a")).toBe("person/entity-a");
  });

  it("plan entities without / are NOT seeded as resolved slugs", async () => {
    const executor = new AgenticResearchExecutor(makeCtx());
    const result = await executor.execute(makePlan(
      [{ kind: "search", input: "匿名名称" }],
      ["匿名名称"],
    ));

    // "匿名名称" has no "/" so it's not pre-seeded; search doesn't populate resolvedSlugs
    expect(result.resolvedSlugs.has("匿名名称")).toBe(false);
  });
});

// --- Fallback plan tests ---

describe("AgenticResearchExecutor — fallback plan", () => {
  it("PlanFallback with steps executes normally", async () => {
    const executor = new AgenticResearchExecutor(makeCtx());
    const fallback: PlanResult = {
      status: "fallback",
      degraded_reason: "LLM failed",
      original_query: "test query",
      intent: "entity_lookup",
      entities: [],
      steps: [
        { kind: "resolve", input: "test query" },
        { kind: "page", input: "test query" },
      ],
      budget: SearchPlanBudget.parse({}),
    };
    const result = await executor.execute(fallback);

    expect(result.steps).toHaveLength(2);
    expect(result.gaps).toHaveLength(0);
  });
});

// --- Trace tests ---

describe("AgenticResearchExecutor — trace", () => {
  it("creates trace session and records steps", async () => {
    const traceSteps: Array<{ sessionId: number; kind: string }> = [];
    const db = mockDB({
      startSearchTraceSession: () => 42,
      addSearchTraceStep: (input: unknown) => {
        const s = input as { sessionId: number; kind: string };
        traceSteps.push({ sessionId: s.sessionId, kind: s.kind });
      },
      finishSearchTraceSession: () => {},
    });
    const executor = new AgenticResearchExecutor(makeCtx({ db }));
    await executor.execute(makePlan([
      { kind: "resolve", input: "a" },
      { kind: "page", input: "a" },
    ]));

    expect(traceSteps).toHaveLength(2);
    expect(traceSteps[0].sessionId).toBe(42);
    expect(traceSteps[0].kind).toBe("resolve");
    expect(traceSteps[1].kind).toBe("page");
  });

  it("trace write failure does not block execution", async () => {
    const db = mockDB({
      startSearchTraceSession: () => { throw new Error("trace boom"); },
    });
    const executor = new AgenticResearchExecutor(makeCtx({ db }));
    const result = await executor.execute(makePlan([{ kind: "resolve", input: "a" }]));

    expect(result.steps).toHaveLength(1);
    expect(result.traceSessionId).toBeUndefined();
  });

  it("skipped steps appear in trace with status=skipped", async () => {
    const db = mockDB({
      resolveSlugs: (queries) => queries.map((q) => ({ query: q, slug: null, title: null })),
    });
    const executor = new AgenticResearchExecutor(makeCtx({ db }));
    const result = await executor.execute(makePlan([
      { kind: "resolve", input: "x" },
      { kind: "page", input: "x" },
    ]));

    expect(result.trace).toHaveLength(3);
    expect(result.trace[0].status).toBe("ok");
    expect(result.trace[1].status).toBe("gap");
    expect(result.trace[2].status).toBe("skipped");
    expect(result.trace[2].kind).toBe("page");
  });

  it("budget skipRemaining writes DB trace for each skipped step", async () => {
    const traceSteps: Array<{ kind: string; outputSummary: string }> = [];
    const db = mockDB({
      startSearchTraceSession: () => 99,
      addSearchTraceStep: (input: unknown) => {
        const s = input as { kind: string; outputSummary: string };
        traceSteps.push({ kind: s.kind, outputSummary: s.outputSummary });
      },
    });
    const executor = new AgenticResearchExecutor(makeCtx({ db }));
    await executor.execute(makePlan(
      [{ kind: "search", input: "q1" }, { kind: "search", input: "q2" }],
      [],
      { budget: SearchPlanBudget.parse({ max_searches: 1 }) },
    ));

    const skippedTraces = traceSteps.filter((t) => t.outputSummary.startsWith("skipped:"));
    expect(skippedTraces).toHaveLength(1);
    expect(skippedTraces[0].kind).toBe("search");
    expect(skippedTraces[0].outputSummary).toContain("Search budget exhausted");
  });

  it("partial execution writes degraded (not success) to finishSearchTraceSession", async () => {
    let capturedStatus = "";
    const db = mockDB({
      startSearchTraceSession: () => 1,
      finishSearchTraceSession: (_sessionId: unknown, opts: unknown) => {
        const o = opts as { status: string };
        capturedStatus = o.status;
      },
      resolveSlugs: () => [{ query: "x", slug: null, title: null }],
    });
    const pages = mockPages({ getBySlug: () => { throw new Error("fail"); } });
    const executor = new AgenticResearchExecutor(makeCtx({ db, pages }));
    await executor.execute(makePlan([
      { kind: "resolve", input: "x" },
      { kind: "page", input: "x" },
    ]));

    expect(capturedStatus).toBe("degraded");
  });
});

// --- Evidence board tests ---

describe("AgenticResearchExecutor — evidence board", () => {
  it("evidenceBoard is populated from resolved slugs", async () => {
    const linksMap = new Map<string, { outgoing: unknown[]; incoming: unknown[] }>();
    linksMap.set("slug-a", {
      outgoing: [{ from_slug: "slug-a", to_slug: "slug-b", relation: "related", context: "A relates to B", trust_state: "trusted", source_type: null, source_page_slug: null, confidence: 0.9, created_at: "2026-01-01" }],
      incoming: [],
    });
    const db = mockDB({
      resolveSlugs: (queries) => queries.map((q) => ({ query: q, slug: "slug-a", title: "A" })),
      batchGetLinksForSlugs: () => linksMap,
    });
    const executor = new AgenticResearchExecutor(makeCtx({ db }));
    const result = await executor.execute(makePlan([{ kind: "resolve", input: "entity" }]));

    expect(result.evidenceBoard).toBeDefined();
    expect(result.evidenceBoard.facts.length).toBeGreaterThan(0);
  });

  it("resolve fails + search hits → evidenceBoard has content", async () => {
    const linksMap = new Map<string, { outgoing: unknown[]; incoming: unknown[] }>();
    linksMap.set("search-hit-a", {
      outgoing: [{ from_slug: "search-hit-a", to_slug: "search-hit-b", relation: "related", context: "link evidence", trust_state: "trusted", source_type: null, source_page_slug: null, confidence: 0.9, created_at: "2026-01-01" }],
      incoming: [],
    });
    const db = mockDB({
      resolveSlugs: (queries) => queries.map((q) => ({ query: q, slug: null, title: null })),
      batchGetLinksForSlugs: () => linksMap,
      batchGetTimelineForSlugs: () => new Map(),
    });
    const search = mockSearch({
      search: async () => [{ slug: "search-hit-a", score: 0.9, snippet: "found", source: "hybrid" as const }],
    });
    const executor = new AgenticResearchExecutor(makeCtx({ db, search }));
    const result = await executor.execute(makePlan([
      { kind: "resolve", input: "unknown" },
      { kind: "search", input: "unknown" },
    ]));

    expect(result.evidenceBoard.facts.length).toBeGreaterThan(0);
  });

  it("search-derived slugs do NOT pollute resolvedSlugs", async () => {
    const db = mockDB({
      resolveSlugs: (queries) => queries.map((q) => ({ query: q, slug: null, title: null })),
      batchGetLinksForSlugs: () => new Map(),
      batchGetTimelineForSlugs: () => new Map(),
    });
    const search = mockSearch({
      search: async () => [{ slug: "search-hit-a", score: 0.9, snippet: "found", source: "hybrid" as const }],
    });
    const executor = new AgenticResearchExecutor(makeCtx({ db, search }));
    const result = await executor.execute(makePlan([
      { kind: "resolve", input: "unknown" },
      { kind: "search", input: "unknown" },
    ]));

    expect(result.resolvedSlugs.has("search-hit-a")).toBe(false);
  });

  it("search returns 30 results → per-step cap of 5 applied", async () => {
    const allSlugs: string[] = [];
    const search = mockSearch({
      search: async () => Array.from({ length: 30 }, (_, i) => ({
        slug: `hit-${i}`,
        score: 1 - i * 0.01,
        snippet: `result ${i}`,
        source: "hybrid" as const,
      })),
    });
    const db = mockDB({
      resolveSlugs: () => [{ query: "q", slug: null, title: null }],
      batchGetLinksForSlugs: (slugs: string[]) => {
        for (const s of slugs) allSlugs.push(s);
        return new Map();
      },
      batchGetTimelineForSlugs: () => new Map(),
    });
    const executor = new AgenticResearchExecutor(makeCtx({ db, search }));
    await executor.execute(makePlan([
      { kind: "resolve", input: "q" },
      { kind: "search", input: "q" },
    ]));

    // Per-step cap = 5, so only top 5 by score
    expect(allSlugs).toHaveLength(5);
    expect(allSlugs).toContain("hit-0");
    expect(allSlugs).toContain("hit-4");
    expect(allSlugs).not.toContain("hit-5");
  });

  it("multiple search steps cap total evidence at 20", async () => {
    let callIdx = 0;
    const allSlugs: string[] = [];
    const search = mockSearch({
      search: async () => {
        // Each call returns 8 unique results
        const offset = callIdx * 8;
        callIdx++;
        return Array.from({ length: 8 }, (_, i) => ({
          slug: `hit-${offset + i}`,
          score: 1 - (offset + i) * 0.001,
          snippet: `result ${offset + i}`,
          source: "hybrid" as const,
        }));
      },
    });
    const db = mockDB({
      resolveSlugs: (queries) => queries.map((q) => ({ query: q, slug: null, title: null })),
      batchGetLinksForSlugs: (slugs: string[]) => {
        for (const s of slugs) allSlugs.push(s);
        return new Map();
      },
      batchGetTimelineForSlugs: () => new Map(),
    });
    const executor = new AgenticResearchExecutor(makeCtx({ db, search }));
    await executor.execute(makePlan([
      { kind: "search", input: "q1" },
      { kind: "search", input: "q2" },
      { kind: "search", input: "q3" },
      { kind: "search", input: "q4" },
      { kind: "search", input: "q5" },
    ]));

    // 5 steps × 5 per-step = 25, but total cap = 20
    expect(allSlugs.length).toBeLessThanOrEqual(20);
  });

  it("empty search results produce empty evidence board", async () => {
    const db = mockDB({
      resolveSlugs: () => [{ query: "q", slug: null, title: null }],
      batchGetLinksForSlugs: () => new Map(),
      batchGetTimelineForSlugs: () => new Map(),
    });
    const search = mockSearch({
      search: async () => [],
    });
    const executor = new AgenticResearchExecutor(makeCtx({ db, search }));
    const result = await executor.execute(makePlan([
      { kind: "resolve", input: "q" },
      { kind: "search", input: "q" },
    ]));

    expect(result.evidenceBoard.facts).toHaveLength(0);
  });
});

// --- Status tests ---

describe("AgenticResearchExecutor — execution status", () => {
  it("all steps succeed → status=ok", async () => {
    const executor = new AgenticResearchExecutor(makeCtx());
    const result = await executor.execute(makePlan([{ kind: "resolve", input: "a" }]));

    expect(result.status).toBe("ok");
    expect(result.degradedReason).toBeUndefined();
  });

  it("budget exhaustion → status=degraded", async () => {
    const executor = new AgenticResearchExecutor(makeCtx());
    const result = await executor.execute(makePlan(
      [{ kind: "search", input: "q1" }, { kind: "search", input: "q2" }],
      [],
      { budget: SearchPlanBudget.parse({ max_searches: 1 }) },
    ));

    expect(result.status).toBe("degraded");
    expect(result.degradedReason).toContain("exhausted");
  });

  it("gaps but no budget issue → status=partial", async () => {
    const pages = mockPages({ getBySlug: () => { throw new Error("boom"); } });
    const executor = new AgenticResearchExecutor(makeCtx({ pages }));
    const result = await executor.execute(makePlan(
      [{ kind: "resolve", input: "a" }, { kind: "page", input: "a" }],
    ));

    expect(result.status).toBe("partial");
    expect(result.degradedReason).toBeUndefined();
  });
});

// --- Per-step search budget tests ---

describe("AgenticResearchExecutor — per-step search budget", () => {
  it("search skipped at 60% threshold but non-search steps continue", async () => {
    // Clock returns 300×callCount. With max_ms: 2000, stepMaxMs = floor(2000 * 0.6) = 1200.
    // Each executing step consumes 3 clock calls (elapsed + stepStart + latencyMs).
    let callCount = 0;
    const clock = () => { callCount++; return callCount * 300; };
    const executor = new AgenticResearchExecutor(makeCtx({ now: clock }));
    const plan = makePlan(
      [
        { kind: "search", input: "q1" },    // runs (elapsed=300 < 1200)
        { kind: "search", input: "q2" },    // skipped (elapsed=1200 >= 1200)
        { kind: "search", input: "q3" },    // skipped (elapsed=1500 >= 1200)
        { kind: "page", input: "slug-a" },  // runs (elapsed=1800 < 2000)
      ],
      [],
      { budget: SearchPlanBudget.parse({ max_ms: 2000, max_searches: 10 }) },
    );
    const result = await executor.execute(plan);

    expect(result.steps.map((s) => s.kind)).toEqual(["search", "page"]);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped.every((s) => s.step.kind === "search")).toBe(true);
    expect(result.status).toBe("degraded");
    expect(result.degradedReason).toContain("Per-step search budget");
  });
});

// --- Integration-like tests ---

describe("AgenticResearchExecutor — integration", () => {
  it("resolve → graph → page chain with resolvedSlugs flowing through", async () => {
    let graphSlug = "";
    let pageSlug = "";
    const graph = mockGraph({
      getRelatedEntities: (slug: string) => {
        graphSlug = slug;
        return [{ slug: "neighbor", title: "N", type: "entity", depth: 1 }];
      },
    });
    const pages = mockPages({
      getBySlug: (slug: string) => {
        pageSlug = slug;
        return { slug, title: "T", type: "entity", body: "content" };
      },
    });
    const executor = new AgenticResearchExecutor(makeCtx({ graph, pages }));
    const result = await executor.execute(makePlan([
      { kind: "resolve", input: "实体A" },
      { kind: "graph", input: "实体A", mode: "neighbors" },
      { kind: "page", input: "实体A" },
    ]));

    expect(result.steps).toHaveLength(3);
    expect(graphSlug).toBe("slug-实体A");
    expect(pageSlug).toBe("slug-实体A");
    expect(result.resolvedSlugs.get("实体A")).toBe("slug-实体A");
  });

  it("budgetUsed reflects actual execution", async () => {
    const executor = new AgenticResearchExecutor(makeCtx());
    const result = await executor.execute(makePlan([
      { kind: "search", input: "q1" },
      { kind: "search", input: "q2" },
    ]));

    expect(result.budgetUsed.searches).toBe(2);
    expect(result.budgetUsed.ms).toBeGreaterThanOrEqual(0);
  });

  it("trace entries cover all steps in order", async () => {
    const executor = new AgenticResearchExecutor(makeCtx());
    const result = await executor.execute(makePlan([
      { kind: "resolve", input: "a" },
      { kind: "search", input: "a" },
    ]));

    expect(result.trace).toHaveLength(2);
    expect(result.trace[0]).toEqual({ stepIndex: 0, kind: "resolve", input: "a", status: "ok", latencyMs: expect.any(Number) });
    expect(result.trace[1]).toEqual({ stepIndex: 1, kind: "search", input: "a", status: "ok", latencyMs: expect.any(Number) });
  });
});

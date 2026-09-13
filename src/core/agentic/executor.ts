import type { CBrainDB } from "../../storage/sqlite.js";
import type { HybridSearch } from "../retrieval/search.js";
import type { GraphManager, GraphNode } from "../graph/graph.js";
import type { PageManager } from "../page.js";
import type { LLMProvider } from "../../llm/provider.js";
import type {
  PlanResult,
  SearchPlanStep,
  SearchPlanBudget,
} from "./plan.js";
import { isFallback } from "./plan.js";
import { collectEvidenceForSlugs, type EvidenceBoardResult } from "../retrieval/evidence.js";
import { isTopicRow } from "../shared.js";

// --- Executor Context (minimal read-only subset of ToolContext) ---

export interface ExecutorContext {
  signal?: AbortSignal;
  db: CBrainDB;
  search: HybridSearch;
  graph: GraphManager;
  pages: PageManager;
  llm?: LLMProvider;
  /** Injectable clock for testing. Defaults to Date.now. */
  now?: () => number;
}

// --- Result types ---

export type ExecutionStatus = "ok" | "partial" | "degraded";

/** Per-step search budget as a fraction of total wall-clock budget. */
const STEP_SEARCH_BUDGET_RATIO = 0.6;

export interface StepResult {
  kind: SearchPlanStep["kind"];
  input: string;
  data: unknown;
  latencyMs: number;
  error?: string;
}

export interface SkippedStep {
  step: SearchPlanStep;
  reason: string;
}

export interface ExecutionGap {
  step: SearchPlanStep;
  error: string;
  latencyMs: number;
}

export interface ExecutionTraceEntry {
  stepIndex: number;
  kind: SearchPlanStep["kind"];
  input: string;
  status: "ok" | "gap" | "skipped";
  latencyMs: number;
  error?: string;
}

export interface ExecutionResult {
  status: ExecutionStatus;
  degradedReason?: string;
  steps: StepResult[];
  gaps: ExecutionGap[];
  skipped: SkippedStep[];
  resolvedSlugs: Map<string, string>;
  evidenceBoard: EvidenceBoardResult;
  trace: ExecutionTraceEntry[];
  totalMs: number;
  budgetUsed: { llmCalls: number; searches: number; ms: number };
  traceSessionId?: number;
}

// --- Internal state ---

interface ExecutionState {
  resolvedSlugs: Map<string, string>;
  evidenceSlugs: Set<string>;
  failedInputs: Set<string>;
  llmCalls: number;
  searchCalls: number;
}

// --- Detail → limit mapping ---

const DETAIL_LIMITS = {
  search: { brief: 5, normal: 10, full: 20 } as const,
  graph: { brief: 10, normal: 25, full: 50 } as const,
  chunks: { brief: 1, normal: undefined as number | undefined, full: 0 } as const,
};

function searchLimit(detail?: string): number {
  if (!detail || detail === "normal") return DETAIL_LIMITS.search.normal;
  return DETAIL_LIMITS.search[detail as keyof typeof DETAIL_LIMITS.search] ?? DETAIL_LIMITS.search.normal;
}

function graphLimit(detail?: string): number {
  if (!detail || detail === "normal") return DETAIL_LIMITS.graph.normal;
  return DETAIL_LIMITS.graph[detail as keyof typeof DETAIL_LIMITS.graph] ?? DETAIL_LIMITS.graph.normal;
}

function chunksSummaryLevel(detail?: string): number | undefined {
  if (!detail || detail === "normal") return undefined;
  return DETAIL_LIMITS.chunks[detail as keyof typeof DETAIL_LIMITS.chunks] ?? undefined;
}

// --- Helpers ---

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function queryForPlan(plan: PlanResult): string {
  if (isFallback(plan)) return plan.original_query;
  return plan.steps[0]?.input ?? "";
}

/** Check if a slug looks like a real slug (contains / separator) rather than a plain entity name. */
function isSlugLike(value: string): boolean {
  return value.includes("/");
}

// --- Step handlers ---

type StepHandler = (step: SearchPlanStep, state: ExecutionState, ctx: ExecutorContext) => Promise<StepResult>;

async function handleResolve(step: SearchPlanStep, state: ExecutionState, ctx: ExecutorContext): Promise<StepResult> {
  const results = ctx.db.resolveSlugs([step.input]);
  let resolved = false;
  for (const r of results) {
    if (r.slug) {
      state.resolvedSlugs.set(r.query, r.slug);
      state.evidenceSlugs.add(r.slug);
      resolved = true;
    }
  }
  if (!resolved) {
    state.failedInputs.add(step.input);
  }
  return { kind: "resolve", input: step.input, data: results, latencyMs: 0 };
}

const MAX_SEARCH_EVIDENCE_PER_STEP = 5;
const MAX_SEARCH_EVIDENCE_TOTAL = 20;

async function handleSearch(step: SearchPlanStep, state: ExecutionState, ctx: ExecutorContext): Promise<StepResult> {
  const resolved = state.resolvedSlugs.get(step.input);
  const hints = resolved ? { knownSlugs: [resolved], isComplex: false } : undefined;
  // Count attempts, including failures. Nested search must remain deterministic
  // with respect to chat-model use; planning owns the request's LLM budget.
  state.searchCalls++;
  const results = await ctx.search.search(step.input, {
    limit: searchLimit(step.detail),
    _skipDecompose: true,
    multiQuery: false,
    multiStep: false,
    _hints: hints,
    signal: ctx.signal,
  });
  ctx.signal?.throwIfAborted();
  const remaining = MAX_SEARCH_EVIDENCE_TOTAL - state.evidenceSlugs.size;
  if (remaining > 0) {
    const topResults = results
      .slice()
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SEARCH_EVIDENCE_PER_STEP)
      .slice(0, remaining);
    for (const r of topResults) {
      if (r.slug) {
        state.evidenceSlugs.add(r.slug);
      }
    }
  }
  return { kind: "search", input: step.input, data: results, latencyMs: 0 };
}

async function handleGraph(step: SearchPlanStep, state: ExecutionState, ctx: ExecutorContext): Promise<StepResult> {
  const slug = state.resolvedSlugs.get(step.input) ?? step.input;
  const limit = graphLimit(step.detail);
  let nodes: GraphNode[];

  if (step.mode === "traverse") {
    nodes = ctx.graph.traverse(slug, { maxDepth: 3, limit });
  } else {
    nodes = ctx.graph.getRelatedEntities(slug, limit);
  }

  return { kind: "graph", input: step.input, data: nodes, latencyMs: 0 };
}

async function handleTimeline(step: SearchPlanStep, state: ExecutionState, ctx: ExecutorContext): Promise<StepResult> {
  const slug = state.resolvedSlugs.get(step.input);
  let data: unknown;

  // #511: timeline rows whose provenance points at a generated topic page are
  // derived material — drop them in BOTH branches (slug-resolved and keyword
  // search; the latter now carries source_page_slug) so step results never
  // hand generated evidence to synthesis/critic.
  const isTopicProvenance = (row: { page_slug?: string; source_page_slug?: string | null }): boolean =>
    (row.page_slug != null && isTopicRow(ctx.db.getPage(row.page_slug)))
    || (row.source_page_slug != null && isTopicRow(ctx.db.getPage(row.source_page_slug)));

  if (slug) {
    data = isTopicRow(ctx.db.getPage(slug)) ? [] : ctx.db.getTimeline(slug).filter((row) => !isTopicProvenance(row));
  } else {
    data = ctx.db.searchTimeline(step.input).filter((row) => !isTopicProvenance(row));
  }

  return { kind: "timeline", input: step.input, data, latencyMs: 0 };
}

async function handlePage(step: SearchPlanStep, state: ExecutionState, ctx: ExecutorContext): Promise<StepResult> {
  const slug = state.resolvedSlugs.get(step.input) ?? step.input;
  // #511: a generated topic page is not original evidence — refuse instead of
  // bypassing freshness with its (possibly stale) cached body. Synthesis sees
  // an explicit refusal, never derived text.
  if (isTopicRow(ctx.db.getPage(slug))) {
    return { kind: "page", input: step.input, data: { refused: "topic_page_not_original_evidence", slug }, latencyMs: 0 };
  }
  const page = ctx.pages.getBySlug(slug);
  return { kind: "page", input: step.input, data: page, latencyMs: 0 };
}

async function handleChunks(step: SearchPlanStep, state: ExecutionState, ctx: ExecutorContext): Promise<StepResult> {
  const slug = state.resolvedSlugs.get(step.input) ?? step.input;
  // #511: indexed topic chunks are derived material — refuse, return nothing.
  if (isTopicRow(ctx.db.getPage(slug))) {
    return { kind: "chunks", input: step.input, data: { refused: "topic_chunks_not_original_evidence", slug }, latencyMs: 0 };
  }
  const data = ctx.db.getChunksByPage(slug, { summaryLevel: chunksSummaryLevel(step.detail) });
  return { kind: "chunks", input: step.input, data, latencyMs: 0 };
}

const DISPATCH: Record<SearchPlanStep["kind"], StepHandler> = {
  resolve: handleResolve,
  search: handleSearch,
  graph: handleGraph,
  timeline: handleTimeline,
  page: handlePage,
  chunks: handleChunks,
};

// --- Steps that require a resolved slug to work correctly ---

const SLUG_DEPENDENT_KINDS = new Set<SearchPlanStep["kind"]>(["graph", "page", "chunks"]);

// --- Executor ---

export class AgenticResearchExecutor {
  constructor(private readonly ctx: ExecutorContext) {}

  private now(): number {
    return this.ctx.now?.() ?? Date.now();
  }

  async execute(plan: PlanResult): Promise<ExecutionResult> {
    const startTime = this.now();
    const budget: SearchPlanBudget = plan.budget;
    const steps: StepResult[] = [];
    const gaps: ExecutionGap[] = [];
    const skipped: SkippedStep[] = [];
    const trace: ExecutionTraceEntry[] = [];
    const state: ExecutionState = {
      resolvedSlugs: new Map(),
      evidenceSlugs: new Set(),
      failedInputs: new Set(),
      llmCalls: 0,
      searchCalls: 0,
    };

    // Only seed entities that are confirmed slugs
    for (const entity of plan.entities) {
      if (isSlugLike(entity)) {
        state.resolvedSlugs.set(entity, entity);
        state.evidenceSlugs.add(entity);
      }
    }

    let traceSessionId: number | undefined;
    let degradedReason: string | undefined;

    // Start trace session (non-critical)
    try {
      traceSessionId = this.ctx.db.startSearchTraceSession({
        query: queryForPlan(plan),
        mode: "agentic",
        intent: plan.intent,
      });
    } catch {
      // trace failure must not block execution
    }

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      const elapsed = this.now() - startTime;

      if (this.ctx.signal?.aborted) {
        degradedReason = "Research cancelled";
        this.skipRemaining(plan.steps, i, degradedReason, skipped, trace, traceSessionId);
        break;
      }
      // --- Budget checks: any exhaustion = stop + degrade ---
      if (elapsed >= budget.max_ms) {
        degradedReason = `Wall-clock budget exhausted (${elapsed}ms >= ${budget.max_ms}ms)`;
        this.skipRemaining(plan.steps, i, degradedReason, skipped, trace, traceSessionId);
        break;
      }
      // Executor steps do not call a chat model. Exhausting the planner's LLM
      // budget must not block the remaining deterministic reads.
      if (state.searchCalls >= budget.max_searches && step.kind === "search") {
        degradedReason = `Search budget exhausted (${state.searchCalls} >= ${budget.max_searches})`;
        this.skipRemaining(plan.steps, i, degradedReason, skipped, trace, traceSessionId);
        break;
      }

      // --- Per-step search budget: skip search if elapsed > 60% of total ---
      if (step.kind === "search") {
        const stepMaxMs = Math.floor(budget.max_ms * STEP_SEARCH_BUDGET_RATIO);
        if (elapsed >= stepMaxMs) {
          if (!degradedReason) degradedReason = `Per-step search budget: ${elapsed}ms elapsed, search limit is ${stepMaxMs}ms`;
          skipped.push({ step, reason: degradedReason });
          trace.push({ stepIndex: i, kind: step.kind, input: step.input, status: "skipped", latencyMs: 0, error: degradedReason });
          this.recordTraceSkip(traceSessionId, i, step, degradedReason);
          continue;
        }
      }

      // --- Dependency check: slug-dependent steps need a resolved slug ---
      if (SLUG_DEPENDENT_KINDS.has(step.kind) && !state.resolvedSlugs.has(step.input) && state.failedInputs.has(step.input)) {
        skipped.push({ step, reason: `Unresolved entity: "${step.input}"` });
        trace.push({ stepIndex: i, kind: step.kind, input: step.input, status: "skipped", latencyMs: 0, error: `Unresolved entity: "${step.input}"` });
        this.recordTraceSkip(traceSessionId, i, step, `Unresolved entity: "${step.input}"`);
        continue;
      }

      const stepStart = this.now();
      let stepTimer: ReturnType<typeof setTimeout> | undefined;
      let stepTimedOut = false;
      const controller = new AbortController();
      const signal = this.ctx.signal ? AbortSignal.any([this.ctx.signal, controller.signal]) : controller.signal;
      let cancelStep: (() => void) | undefined;

      try {
        const handler = DISPATCH[step.kind];
        const result = await Promise.race([
          handler(step, state, { ...this.ctx, signal }),
          new Promise<never>((_, reject) => {
            stepTimer = setTimeout(() => {
              stepTimedOut = true;
              controller.abort(new Error("Research step deadline exhausted"));
            }, Math.max(0, budget.max_ms - (stepStart - startTime)));
            cancelStep = () => reject(new Error(stepTimedOut ? "Research step deadline exhausted" : "Research cancelled"));
            signal.addEventListener("abort", cancelStep, { once: true });
            if (signal.aborted) cancelStep();
          }),
        ]);
        signal.throwIfAborted();
        result.latencyMs = this.now() - stepStart;
        steps.push(result);
        trace.push({ stepIndex: i, kind: step.kind, input: step.input, status: "ok", latencyMs: result.latencyMs });

        this.recordTraceStep(traceSessionId, i, step, result);

        // resolve step completed but produced no slug → semantic gap
        if (step.kind === "resolve" && state.failedInputs.has(step.input)) {
          const gapError = `Resolve failed: "${step.input}" → no slug found`;
          gaps.push({ step, error: gapError, latencyMs: result.latencyMs });
          trace.push({ stepIndex: i, kind: step.kind, input: step.input, status: "gap", latencyMs: 0, error: gapError });
          this.recordTraceSkip(traceSessionId, i, step, gapError);
        }
      } catch (err) {
        const latencyMs = this.now() - stepStart;
        gaps.push({ step, error: errorMessage(err), latencyMs });
        trace.push({ stepIndex: i, kind: step.kind, input: step.input, status: "gap", latencyMs, error: errorMessage(err) });

        this.recordTraceError(traceSessionId, i, step, errorMessage(err), latencyMs);
        if (signal.aborted) {
          degradedReason = stepTimedOut ? "Research step deadline exhausted" : "Research cancelled";
          this.skipRemaining(plan.steps, i + 1, degradedReason, skipped, trace, traceSessionId);
          break;
        }
      } finally {
        if (stepTimer) clearTimeout(stepTimer);
        if (cancelStep) signal.removeEventListener("abort", cancelStep);
      }
    }

    // Collection is part of execution: failures must not erase spent calls or steps.
    const allSlugs = [...new Set([...state.resolvedSlugs.values(), ...state.evidenceSlugs])];
    let evidenceBoard: ReturnType<typeof collectEvidenceForSlugs>;
    try {
      evidenceBoard = collectEvidenceForSlugs(this.ctx.db, allSlugs);
    } catch (err) {
      degradedReason ??= `Evidence collection failed: ${errorMessage(err)}`;
      evidenceBoard = { facts: [], user_thoughts: [], candidates: [], conflicts: [], gaps: [degradedReason] };
    }
    const totalMs = this.now() - startTime;
    if (totalMs >= budget.max_ms && !degradedReason) degradedReason = "Wall-clock budget exhausted";

    const status: ExecutionStatus = degradedReason
      ? "degraded"
      : (gaps.length > 0 || skipped.length > 0 ? "partial" : "ok");

    // Finish trace session (non-critical)
    this.finishTrace(traceSessionId, plan.steps.length, steps.length, totalMs, state, status);

    return {
      status,
      degradedReason,
      steps,
      gaps,
      skipped,
      resolvedSlugs: state.resolvedSlugs,
      evidenceBoard,
      trace,
      totalMs,
      budgetUsed: { llmCalls: state.llmCalls, searches: state.searchCalls, ms: totalMs },
      traceSessionId,
    };
  }

  private skipRemaining(planSteps: SearchPlanStep[], fromIndex: number, reason: string, skipped: SkippedStep[], trace: ExecutionTraceEntry[], traceSessionId: number | undefined): void {
    for (let i = fromIndex; i < planSteps.length; i++) {
      const step = planSteps[i];
      skipped.push({ step, reason });
      trace.push({ stepIndex: i, kind: step.kind, input: step.input, status: "skipped", latencyMs: 0, error: reason });
      this.recordTraceSkip(traceSessionId, i, step, reason);
    }
  }

  private recordTraceStep(sessionId: number | undefined, index: number, step: SearchPlanStep, result: StepResult): void {
    if (sessionId === undefined) return;
    try {
      this.ctx.db.addSearchTraceStep({
        sessionId,
        stepIndex: index,
        kind: step.kind,
        inputJson: { input: step.input, mode: step.mode, detail: step.detail },
        outputSummary: `${step.kind} ok`,
        latencyMs: result.latencyMs,
      });
    } catch {
      // non-critical
    }
  }

  private recordTraceError(sessionId: number | undefined, index: number, step: SearchPlanStep, error: string, latencyMs: number): void {
    if (sessionId === undefined) return;
    try {
      this.ctx.db.addSearchTraceStep({
        sessionId,
        stepIndex: index,
        kind: step.kind,
        inputJson: { input: step.input, mode: step.mode, detail: step.detail },
        outputSummary: `error: ${error}`,
        latencyMs,
        error,
      });
    } catch {
      // non-critical
    }
  }

  private recordTraceSkip(sessionId: number | undefined, index: number, step: SearchPlanStep, reason: string): void {
    if (sessionId === undefined) return;
    try {
      this.ctx.db.addSearchTraceStep({
        sessionId,
        stepIndex: index,
        kind: step.kind,
        inputJson: { input: step.input, mode: step.mode, detail: step.detail },
        outputSummary: `skipped: ${reason}`,
        latencyMs: 0,
        error: reason,
      });
    } catch {
      // non-critical
    }
  }

  private finishTrace(sessionId: number | undefined, totalSteps: number, _successSteps: number, latencyMs: number, state: ExecutionState, status: ExecutionStatus): void {
    if (sessionId === undefined) return;
    try {
      const traceStatus = status === "ok" ? "success" : "degraded";
      this.ctx.db.finishSearchTraceSession(sessionId, {
        latencyMs,
        status: traceStatus,
        llmCalls: state.llmCalls,
        totalSteps,
      });
    } catch {
      // non-critical
    }
  }
}

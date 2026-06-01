import type { ExecutorContext } from "./executor.js";
import type { ExecutionResult } from "./executor.js";
import type { PlanResult, SearchPlanBudget, SearchPlanIntent } from "./plan.js";
import { SearchPlanBudget as SearchPlanBudgetSchema } from "./plan.js";
import { SearchPlanner, type PlannerInput } from "./planner.js";
import { AgenticResearchExecutor } from "./executor.js";
import { evaluateSufficiency, type Confidence, type SufficiencyDecision } from "./critic.js";
import type { EvidenceBoardResult, EvidenceItem } from "../evidence.js";

// --- Public types ---

export type { ExecutorContext as PipelineContext };

export interface PipelineInput {
  query: string;
  knownSlugs?: string[];
  intentHint?: SearchPlanIntent;
  budgetOverride?: Partial<SearchPlanBudget>;
}

export type PipelineStatus = "ok" | "partial" | "degraded" | "insufficient";

export interface TraceSummary {
  totalMs: number;
  totalSteps: number;
  passCount: number;
  errors: string[];
  budgetUsed: { llmCalls: number; searches: number; ms: number };
}

export interface AnswerContext {
  query: string;
  intent: SearchPlanIntent;
  confidence: Confidence;
  sourceSlugs: Array<{ slug: string; factCount: number }>;
  topClaims: string[];
  gaps: string[];
  followUpPerformed: boolean;
}

export interface PipelineResult {
  query: string;
  intent: SearchPlanIntent;
  status: PipelineStatus;
  plan: PlanResult;
  execution: ExecutionResult;
  critic: SufficiencyDecision;
  follow_up_execution?: ExecutionResult;
  follow_up_critic?: SufficiencyDecision;
  evidence_board: EvidenceBoardResult;
  trace_summary: TraceSummary;
  answer_context: AnswerContext;
}

// --- Helpers ---

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

const EMPTY_BOARD: EvidenceBoardResult = {
  facts: [],
  user_thoughts: [],
  candidates: [],
  gaps: [],
  conflicts: [],
};

function emptyExecutionResult(): ExecutionResult {
  return {
    status: "degraded",
    degradedReason: "pipeline executor error",
    steps: [],
    gaps: [],
    skipped: [],
    resolvedSlugs: new Map(),
    evidenceBoard: { ...EMPTY_BOARD },
    trace: [],
    totalMs: 0,
    budgetUsed: { llmCalls: 0, searches: 0, ms: 0 },
  };
}

function buildMinimalFallback(input: PipelineInput): PlanResult {
  return {
    status: "fallback",
    degraded_reason: "pipeline planner error",
    original_query: input.query,
    intent: input.intentHint ?? "entity_lookup",
    entities: input.knownSlugs ?? [],
    steps: [{ kind: "search", input: input.query }],
    budget: SearchPlanBudgetSchema.parse({}),
  };
}

function applyBudgetOverride(
  plan: PlanResult,
  override?: Partial<SearchPlanBudget>,
): PlanResult {
  if (!override) return plan;
  return { ...plan, budget: { ...plan.budget, ...override } };
}

function mergeEvidenceBoards(
  primary: EvidenceBoardResult,
  followUp: EvidenceBoardResult,
): EvidenceBoardResult {
  const seen = new Set<string>();
  const key = (item: EvidenceItem) => `${item.claim}\0${item.source_slug}\0${item.trust_state}`;

  const addItems = (acc: EvidenceItem[], items: EvidenceItem[]) => {
    for (const item of items) {
      const k = key(item);
      if (!seen.has(k)) {
        seen.add(k);
        acc.push(item);
      }
    }
  };

  const facts: EvidenceItem[] = [];
  const user_thoughts: EvidenceItem[] = [];
  const candidates: EvidenceItem[] = [];

  addItems(facts, primary.facts);
  addItems(facts, followUp.facts);
  addItems(user_thoughts, primary.user_thoughts);
  addItems(user_thoughts, followUp.user_thoughts);
  addItems(candidates, primary.candidates);
  addItems(candidates, followUp.candidates);

  return {
    facts,
    user_thoughts,
    candidates,
    gaps: [...new Set([...primary.gaps, ...followUp.gaps])],
    conflicts: [...primary.conflicts, ...followUp.conflicts],
  };
}

function determinePipelineStatus(
  execution: ExecutionResult,
  followUpExecution: ExecutionResult | undefined,
  critic: SufficiencyDecision,
  followUpCritic: SufficiencyDecision | undefined,
): PipelineStatus {
  if (execution.status === "degraded") return "degraded";
  if (followUpExecution?.status === "degraded") return "degraded";

  if (!critic.sufficient) {
    if (!followUpCritic) return "insufficient";
    return followUpCritic.sufficient ? "partial" : "insufficient";
  }

  return execution.status === "ok" ? "ok" : "partial";
}

function buildTraceSummary(
  execution: ExecutionResult,
  followUpExecution: ExecutionResult | undefined,
  errors: string[],
): TraceSummary {
  return {
    totalMs: execution.totalMs + (followUpExecution?.totalMs ?? 0),
    totalSteps: execution.trace.length + (followUpExecution?.trace.length ?? 0),
    passCount: followUpExecution ? 2 : 1,
    errors,
    budgetUsed: {
      llmCalls: execution.budgetUsed.llmCalls + (followUpExecution?.budgetUsed.llmCalls ?? 0),
      searches: execution.budgetUsed.searches + (followUpExecution?.budgetUsed.searches ?? 0),
      ms: execution.budgetUsed.ms + (followUpExecution?.budgetUsed.ms ?? 0),
    },
  };
}

function buildAnswerContext(
  input: PipelineInput,
  plan: PlanResult,
  board: EvidenceBoardResult,
  critic: SufficiencyDecision,
  followUpCritic: SufficiencyDecision | undefined,
  followUpPerformed: boolean,
): AnswerContext {
  const slugCounts = new Map<string, number>();
  for (const item of [...board.facts, ...board.user_thoughts, ...board.candidates]) {
    slugCounts.set(item.source_slug, (slugCounts.get(item.source_slug) ?? 0) + 1);
  }
  const sourceSlugs = [...slugCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([slug, factCount]) => ({ slug, factCount }));

  const topClaims = board.facts
    .slice(0, 10)
    .map((f) => (f.claim.length > 100 ? f.claim.slice(0, 100) + "..." : f.claim));

  const confidence = followUpCritic?.confidence ?? critic.confidence;

  return {
    query: input.query,
    intent: plan.intent,
    confidence,
    sourceSlugs,
    topClaims,
    gaps: board.gaps.slice(0, 5),
    followUpPerformed,
  };
}

// --- Pipeline ---

export class AgenticResearchPipeline {
  constructor(private readonly ctx: ExecutorContext) {}

  async run(input: PipelineInput): Promise<PipelineResult> {
    const errors: string[] = [];

    // --- Pass 1: Plan ---
    let plan: PlanResult;
    try {
      const plannerInput: PlannerInput = {
        query: input.query,
        knownSlugs: input.knownSlugs,
        intentHint: input.intentHint,
      };
      plan = await new SearchPlanner(this.ctx.llm).plan(plannerInput);
    } catch (err) {
      errors.push(`planner_error: ${errorMessage(err)}`);
      plan = buildMinimalFallback(input);
    }

    const planWithBudget = applyBudgetOverride(plan, input.budgetOverride);

    // --- Pass 1: Execute ---
    let execution: ExecutionResult;
    try {
      execution = await new AgenticResearchExecutor(this.ctx).execute(planWithBudget);
    } catch (err) {
      errors.push(`executor_error: ${errorMessage(err)}`);
      execution = emptyExecutionResult();
    }

    // --- Pass 1: Critique ---
    let critic: SufficiencyDecision;
    try {
      critic = evaluateSufficiency({
        intent: plan.intent,
        query: input.query,
        evidenceBoard: execution.evidenceBoard,
        execution,
      });
    } catch (err) {
      errors.push(`critic_error: ${errorMessage(err)}`);
      critic = {
        sufficient: true,
        confidence: "low",
        missing: [],
        follow_up_steps: [],
        reasons: ["critic failed, assuming sufficient"],
      };
    }

    // --- Follow-up pass (at most one) ---
    let followUpExecution: ExecutionResult | undefined;
    let followUpCritic: SufficiencyDecision | undefined;
    let mergedBoard = execution.evidenceBoard;

    if (
      !critic.sufficient &&
      critic.follow_up_steps.length > 0 &&
      execution.status !== "degraded"
    ) {
      const followUpPlan: PlanResult = { ...planWithBudget, steps: critic.follow_up_steps };

      try {
        followUpExecution = await new AgenticResearchExecutor(this.ctx).execute(followUpPlan);
      } catch (err) {
        errors.push(`follow_up_executor_error: ${errorMessage(err)}`);
      }

      if (followUpExecution) {
        mergedBoard = mergeEvidenceBoards(execution.evidenceBoard, followUpExecution.evidenceBoard);

        try {
          followUpCritic = evaluateSufficiency({
            intent: plan.intent,
            query: input.query,
            evidenceBoard: mergedBoard,
            execution: followUpExecution,
            maxFollowUpSteps: 0,
          });
        } catch (err) {
          errors.push(`follow_up_critic_error: ${errorMessage(err)}`);
          followUpCritic = {
            sufficient: true,
            confidence: "low",
            missing: [],
            follow_up_steps: [],
            reasons: ["follow-up critic failed, assuming sufficient"],
          };
        }
      }
    }

    const status = determinePipelineStatus(execution, followUpExecution, critic, followUpCritic);
    const followUpPerformed = !!followUpExecution;

    return {
      query: input.query,
      intent: planWithBudget.intent,
      status,
      plan: planWithBudget,
      execution,
      critic,
      follow_up_execution: followUpExecution,
      follow_up_critic: followUpCritic,
      evidence_board: mergedBoard,
      trace_summary: buildTraceSummary(execution, followUpExecution, errors),
      answer_context: buildAnswerContext(input, planWithBudget, mergedBoard, critic, followUpCritic, followUpPerformed),
    };
  }
}

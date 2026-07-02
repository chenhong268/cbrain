import type { SearchPlanIntent, SearchPlanStep } from "./plan.js";
import type { EvidenceBoardResult, EvidenceItem } from "../retrieval/evidence.js";
import type { ExecutionResult } from "./executor.js";

// --- Types ---

export interface CriticInput {
  intent: SearchPlanIntent;
  query: string;
  evidenceBoard: EvidenceBoardResult;
  execution?: Pick<ExecutionResult, "steps" | "gaps" | "skipped" | "resolvedSlugs" | "budgetUsed" | "status">;
  maxFollowUpSteps?: number;
}

export type Confidence = "high" | "medium" | "low";

export interface SufficiencyDecision {
  sufficient: boolean;
  confidence: Confidence;
  missing: string[];
  follow_up_steps: SearchPlanStep[];
  reasons: string[];
}

// --- Internal types ---

interface CheckResult {
  satisfied: boolean;
  missing: string[];
  reasons: string[];
}

// --- Board helpers ---

function hasSourceInBoard(board: EvidenceBoardResult, sourceType: string): boolean {
  return [...board.facts, ...board.user_thoughts].some((item) => item.source_type === sourceType);
}

function distinctSourceSlugs(board: EvidenceBoardResult): Set<string> {
  const slugs = new Set<string>();
  for (const item of [...board.facts, ...board.user_thoughts, ...board.candidates]) {
    slugs.add(item.source_slug);
  }
  return slugs;
}

// --- Relevance filter ---

function relevantFacts(board: EvidenceBoardResult, execution: CriticInput["execution"]): EvidenceItem[] {
  if (!execution) return board.facts;
  const slugValues = new Set(execution.resolvedSlugs.values());
  if (slugValues.size === 0) return board.facts;
  return board.facts.filter((f) => slugValues.has(f.source_slug));
}

function relevantItems(items: EvidenceItem[], execution: CriticInput["execution"]): EvidenceItem[] {
  if (!execution) return items;
  const slugValues = new Set(execution.resolvedSlugs.values());
  if (slugValues.size === 0) return items;
  return items.filter((item) => slugValues.has(item.source_slug));
}

function relevantSourceSlugs(board: EvidenceBoardResult, execution: CriticInput["execution"]): Set<string> {
  const all = distinctSourceSlugs(board);
  if (!execution) return all;
  const slugValues = new Set(execution.resolvedSlugs.values());
  if (slugValues.size === 0) return all;
  const result = new Set<string>();
  for (const s of all) {
    if (slugValues.has(s)) result.add(s);
  }
  return result;
}

// --- Execution helpers ---

function hasNonEmptyStep(steps: ExecutionResult["steps"], kind: string): boolean {
  return steps.some((s) => s.kind === kind && isNonEmpty(s.data));
}

function firstResolvedSlug(execution?: CriticInput["execution"]): string | undefined {
  if (!execution) return undefined;
  for (const slug of execution.resolvedSlugs.values()) return slug;
  return undefined;
}

function isNonEmpty(data: unknown): boolean {
  if (Array.isArray(data)) return data.length > 0;
  return data != null;
}

function executionStepInputs(steps: ExecutionResult["steps"], kinds: Set<string>): Set<string> {
  const inputs = new Set<string>();
  for (const s of steps) {
    if (kinds.has(s.kind) && isNonEmpty(s.data)) inputs.add(s.input);
  }
  return inputs;
}

// --- Intent checks ---

function checkRelationship(input: CriticInput): CheckResult {
  const hasLink = hasSourceInBoard(input.evidenceBoard, "link");
  const hasGraph = input.execution ? hasNonEmptyStep(input.execution.steps, "graph") : false;

  if (hasLink || hasGraph) {
    const reasons: string[] = [];
    if (hasLink) reasons.push("link evidence found");
    if (hasGraph) reasons.push("graph step produced results");
    return { satisfied: true, missing: [], reasons };
  }

  return {
    satisfied: false,
    missing: ["relationship evidence missing"],
    reasons: ["no link or graph evidence found for relationship intent"],
  };
}

function checkTimeline(input: CriticInput): CheckResult {
  const hasTimelineEv = hasSourceInBoard(input.evidenceBoard, "timeline");
  const hasTimelineStep = input.execution ? hasNonEmptyStep(input.execution.steps, "timeline") : false;

  if (hasTimelineEv || hasTimelineStep) {
    const reasons: string[] = [];
    if (hasTimelineEv) reasons.push("timeline evidence found");
    if (hasTimelineStep) reasons.push("timeline step produced results");
    return { satisfied: true, missing: [], reasons };
  }

  return {
    satisfied: false,
    missing: ["timeline evidence missing"],
    reasons: ["no timeline evidence found for timeline intent"],
  };
}

function checkEntityLookup(input: CriticInput): CheckResult {
  const board = input.evidenceBoard;
  const steps = input.execution?.steps ?? [];
  const hasTrustedFacts = board.facts.length > 0;
  const hasPageChunk = hasNonEmptyStep(steps, "page") || hasNonEmptyStep(steps, "chunks");

  if (hasTrustedFacts || hasPageChunk) {
    const reasons: string[] = [];
    if (hasTrustedFacts) reasons.push("trusted facts found");
    if (hasPageChunk) reasons.push("page or chunk evidence found");
    return { satisfied: true, missing: [], reasons };
  }

  if (board.candidates.length > 0) {
    return {
      satisfied: false,
      missing: ["only candidate evidence, no trusted facts"],
      reasons: ["candidate-only evidence is insufficient for entity lookup"],
    };
  }

  return {
    satisfied: false,
    missing: ["entity evidence missing"],
    reasons: ["no facts, page, or chunk evidence found"],
  };
}

function checkComparison(input: CriticInput): CheckResult {
  const boardSlugs = relevantSourceSlugs(input.evidenceBoard, input.execution);
  const execSlugs = input.execution
    ? executionStepInputs(input.execution.steps, new Set(["page", "chunks", "graph"]))
    : new Set<string>();
  const allSources = new Set([...boardSlugs, ...execSlugs]);

  if (allSources.size >= 2) {
    return {
      satisfied: true,
      missing: [],
      reasons: [`evidence from ${allSources.size} distinct sources`],
    };
  }

  return {
    satisfied: false,
    missing: ["comparison coverage incomplete — only one side has evidence"],
    reasons: ["comparison requires evidence from at least two distinct sources"],
  };
}

function checkGapAnalysis(input: CriticInput): CheckResult {
  const board = input.evidenceBoard;
  const execGaps = input.execution?.gaps ?? [];
  const hasExplicitGaps = board.gaps.length > 0 || execGaps.length > 0;
  const facts = relevantFacts(board, input.execution);
  const thoughts = relevantItems(board.user_thoughts, input.execution);
  const candidates = relevantItems(board.candidates, input.execution);
  const hasAnyEvidence = facts.length > 0 || thoughts.length > 0 || candidates.length > 0;

  if (hasExplicitGaps || hasAnyEvidence) {
    const reasons: string[] = [];
    if (hasExplicitGaps) reasons.push("explicit gaps detected");
    if (hasAnyEvidence) reasons.push("supporting evidence present");
    return { satisfied: true, missing: [], reasons };
  }

  return {
    satisfied: false,
    missing: ["evidence or explicit gaps missing"],
    reasons: ["gap analysis requires either evidence or explicit gaps to explain"],
  };
}

// --- Follow-up generation ---

function generateFollowUps(
  _intent: SearchPlanIntent,
  missing: string[],
  input: CriticInput,
  maxSteps: number,
): SearchPlanStep[] {
  if (missing.length === 0 || maxSteps <= 0) return [];

  const slug = firstResolvedSlug(input.execution) ?? input.query;
  const steps: SearchPlanStep[] = [];
  const seen = new Set<string>();

  const addStep = (step: SearchPlanStep) => {
    const key = `${step.kind}:${step.input}:${step.mode ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (steps.length < maxSteps) steps.push(step);
  };

  for (const m of missing) {
    if (steps.length >= maxSteps) break;

    if (m.includes("relationship")) {
      addStep({ kind: "graph", input: slug, mode: "neighbors", detail: "normal" });
    } else if (m.includes("timeline")) {
      addStep({ kind: "timeline", input: slug, detail: "normal" });
    } else if (m.includes("entity") || m.includes("trusted facts") || m.includes("candidate")) {
      addStep({ kind: "search", input: input.query, detail: "normal" });
      addStep({ kind: "page", input: slug, detail: "brief" });
    } else if (m.includes("comparison")) {
      addStep({ kind: "search", input: input.query, detail: "normal" });
      addStep({ kind: "page", input: slug, detail: "brief" });
    } else if (m.includes("gap")) {
      addStep({ kind: "search", input: input.query, detail: "full" });
    }
  }

  return steps;
}

// --- Confidence ---

function determineConfidence(sufficient: boolean, board: EvidenceBoardResult): Confidence {
  if (!sufficient) return "low";

  // Strong signal: trusted facts present
  if (board.facts.length > 0) return "high";

  // Sufficient but no facts (page/chunk execution, user thoughts, etc.)
  return "medium";
}

// --- Main export ---

export function evaluateSufficiency(input: CriticInput): SufficiencyDecision {
  const checks: Record<SearchPlanIntent, () => CheckResult> = {
    relationship: () => checkRelationship(input),
    timeline: () => checkTimeline(input),
    entity_lookup: () => checkEntityLookup(input),
    review: () => checkEntityLookup(input),
    comparison: () => checkComparison(input),
    gap_analysis: () => checkGapAnalysis(input),
  };

  const check = checks[input.intent]();
  const sufficient = check.missing.length === 0;
  const maxFollowUp = input.maxFollowUpSteps ?? 3;
  const followUps = generateFollowUps(input.intent, check.missing, input, maxFollowUp);
  let confidence = determineConfidence(sufficient, input.evidenceBoard);
  const reasons = [...check.reasons];

  if (sufficient && input.execution?.status === "degraded") {
    confidence = "low";
    reasons.push("execution degraded — confidence capped");
  }

  return {
    sufficient,
    confidence,
    missing: check.missing,
    follow_up_steps: followUps,
    reasons,
  };
}

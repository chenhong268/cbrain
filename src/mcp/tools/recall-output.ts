import { z } from "zod";
import type { ToolSummary } from "./format-result.js";

const OUTPUT_TEXT_MAX = 50_000;
const OUTPUT_LIST_MAX = 100;
const PROJECTED_TEXT_MAX = 2_000;
const PROJECTED_CLAIM_MAX = 500;
const PROJECTED_DATA_BUDGET = 12_000;

const SUMMARY_SCHEMA = z.object({
  status: z.enum(["ok", "empty", "degraded", "error"]),
  count: z.number(),
  truncated: z.boolean(),
  message: z.string().max(OUTPUT_TEXT_MAX),
  degraded_reason: z.string().max(OUTPUT_TEXT_MAX).optional(),
});

const AUDIT_SCHEMA = z.object({ raw: z.unknown() }).optional();
const HINT_SCHEMA = z.object({
  text: z.string().max(OUTPUT_TEXT_MAX).optional(),
  why: z.string().max(OUTPUT_TEXT_MAX).optional(),
});

export const QUERY_OUTPUT_SCHEMA = {
  schema_version: z.literal(1),
  summary: SUMMARY_SCHEMA,
  data: z.object({
    result_count: z.number(),
    results: z.array(z.object({ snippet: z.string().max(OUTPUT_TEXT_MAX).optional() })).max(OUTPUT_LIST_MAX),
    proactive_hints: z.array(HINT_SCHEMA).max(OUTPUT_LIST_MAX).optional(),
  }),
  audit: AUDIT_SCHEMA,
};

const RECALL_ENTITY_SCHEMA = z.object({
  title: z.string().max(OUTPUT_TEXT_MAX).optional(),
  type: z.string().max(OUTPUT_TEXT_MAX).optional(),
  quality: z.string().max(OUTPUT_TEXT_MAX).optional(),
  tier: z.number().optional(),
  snippet: z.string().max(OUTPUT_TEXT_MAX).optional(),
  tags: z.array(z.string().max(OUTPUT_TEXT_MAX)).max(OUTPUT_LIST_MAX).optional(),
  expiry_warning: z.string().max(OUTPUT_TEXT_MAX).optional(),
  birthday: z.string().max(OUTPUT_TEXT_MAX).optional(),
});

const RECALL_DATA_SCHEMA = z.object({
  result_summary: z.string().max(OUTPUT_TEXT_MAX).optional(),
  query: z.string().max(OUTPUT_TEXT_MAX).optional(),
  entities: z.array(RECALL_ENTITY_SCHEMA).max(OUTPUT_LIST_MAX),
  proactive_hints: z.array(HINT_SCHEMA).max(OUTPUT_LIST_MAX).optional(),
  related_context: z.string().max(OUTPUT_TEXT_MAX).optional(),
});

const GROUNDED_DATA_SCHEMA = z.object({
  answer: z.string().max(OUTPUT_TEXT_MAX),
  confidence: z.enum(["high", "medium", "low"]),
  facts: z.array(z.string().max(OUTPUT_TEXT_MAX)).max(OUTPUT_LIST_MAX),
  user_thoughts: z.array(z.string().max(OUTPUT_TEXT_MAX)).max(OUTPUT_LIST_MAX),
  candidates: z.array(z.string().max(OUTPUT_TEXT_MAX)).max(OUTPUT_LIST_MAX),
  conflicts: z.array(z.string().max(OUTPUT_TEXT_MAX)).max(OUTPUT_LIST_MAX),
  gaps: z.array(z.string().max(OUTPUT_TEXT_MAX)).max(OUTPUT_LIST_MAX),
  must_not_claim: z.array(z.string().max(OUTPUT_TEXT_MAX)).max(OUTPUT_LIST_MAX),
});

export const DEEP_RECALL_OUTPUT_SCHEMA = {
  schema_version: z.literal(1),
  summary: SUMMARY_SCHEMA,
  data: z.union([RECALL_DATA_SCHEMA, GROUNDED_DATA_SCHEMA]),
  audit: AUDIT_SCHEMA,
};

export const QUERY_DATA_KEYS: ReadonlySet<string> = new Set([
  "result_count", "results", "snippet", "proactive_hints", "text", "why",
]);

export const RECALL_DATA_KEYS: ReadonlySet<string> = new Set([
  "result_summary", "query", "entities", "title", "type", "quality", "tier", "snippet", "tags",
  "expiry_warning", "birthday", "proactive_hints", "text", "why", "related_context",
  "answer", "confidence", "facts", "user_thoughts", "candidates", "conflicts", "gaps", "must_not_claim",
]);

export const FRONTDOOR_DATA_KEYS: ReadonlySet<string> = new Set([
  "answer", "details", "query", "entities", "title", "type", "snippet", "summary", "confidence",
  "facts", "user_thoughts", "candidates", "conflicts", "gaps", "must_not_claim", "grounded_answer",
  "seed", "upward", "downward", "name", "events", "date", "result", "status", "evidence_board",
  "answer_context", "top_claims", "topic", "stats", "totalEntities", "totalLinks", "totalEvents",
  "results", "result_count", "proactive_hints", "text", "why", "matched_clues", "dimension", "hint_used",
  "evidence", "subject_context_candidates", "source_page_slug", "source_title", "event_date", "provenance", "topic_relevance",
]);

type SummaryKind = "recall" | "query" | "frontdoor";

const SUMMARY_MESSAGES: Record<SummaryKind, string> = {
  recall: "已完成记忆检索。",
  query: "已完成关键词检索。",
  frontdoor: "已完成 CBrain 检索。",
};

export function structuredSummary(summary: ToolSummary, kind: SummaryKind): ToolSummary {
  return {
    status: summary.status,
    count: summary.count,
    truncated: summary.truncated,
    message: SUMMARY_MESSAGES[kind],
    ...(summary.degraded_reason ? { degraded_reason: "检索结果不完整" } : {}),
  };
}

interface QueryProjectionInput {
  results?: Array<{ snippet?: unknown; slug?: unknown; score?: unknown; source?: unknown }>;
  proactive_hints?: HintProjectionInput[];
  search_meta?: unknown;
}

interface HintProjectionInput {
  text?: unknown;
  why?: unknown;
  rule?: unknown;
  score?: unknown;
  target_slug?: unknown;
  age_days?: unknown;
}

export function projectQueryData(payload: QueryProjectionInput): Record<string, unknown> {
  const results = (payload.results ?? []).slice(0, OUTPUT_LIST_MAX).map((item) => ({
    ...(typeof item.snippet === "string" ? { snippet: boundText(item.snippet) } : {}),
  }));
  const hints = projectHints(payload.proactive_hints);
  return enforceJsonBudget({
    result_count: results.length,
    results,
    ...(hints.length > 0 ? { proactive_hints: hints } : {}),
  });
}

interface RecallProjectionInput {
  display?: unknown;
  summary?: unknown;
  result_summary?: unknown;
  query?: unknown;
  entities?: Array<Record<string, unknown>>;
  proactive_hints?: HintProjectionInput[];
  related_context?: unknown;
  search_meta?: unknown;
}

const RECALL_ENTITY_KEYS = ["title", "type", "quality", "tier", "snippet", "tags", "expiry_warning", "birthday"] as const;

export function projectRecallData(payload: RecallProjectionInput): Record<string, unknown> {
  const entities = (payload.entities ?? []).slice(0, OUTPUT_LIST_MAX).map((entity) => {
    const out: Record<string, unknown> = {};
    for (const key of RECALL_ENTITY_KEYS) {
      const value = entity[key];
      if (key === "tier" && typeof value === "number" && Number.isFinite(value)) out.tier = value;
      else if (key === "tags" && Array.isArray(value)) out.tags = projectStrings(value, OUTPUT_LIST_MAX, PROJECTED_TEXT_MAX);
      else if (typeof value === "string") out[key] = boundText(value);
    }
    return out;
  });
  const hints = projectHints(payload.proactive_hints);
  return enforceJsonBudget({
    ...(typeof payload.result_summary === "string" ? { result_summary: boundText(payload.result_summary) } : {}),
    ...(typeof payload.query === "string" ? { query: boundText(payload.query) } : {}),
    entities,
    ...(hints.length > 0 ? { proactive_hints: hints } : {}),
    ...(typeof payload.related_context === "string" ? { related_context: boundText(payload.related_context) } : {}),
  });
}

export function projectGroundedRecallData(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    answer: typeof value.answer === "string" ? boundText(value.answer) : "",
    confidence: isConfidence(value.confidence) ? value.confidence : "low",
    facts: projectStrings(value.facts, OUTPUT_LIST_MAX, PROJECTED_CLAIM_MAX),
    user_thoughts: projectStrings(value.user_thoughts, OUTPUT_LIST_MAX, PROJECTED_CLAIM_MAX),
    candidates: projectStrings(value.candidates, OUTPUT_LIST_MAX, PROJECTED_CLAIM_MAX),
    conflicts: projectStrings(value.conflicts, OUTPUT_LIST_MAX, PROJECTED_CLAIM_MAX),
    gaps: projectStrings(value.gaps, OUTPUT_LIST_MAX, PROJECTED_CLAIM_MAX),
    must_not_claim: projectStrings(value.must_not_claim, OUTPUT_LIST_MAX, PROJECTED_CLAIM_MAX),
  };
  return enforceJsonBudget(out);
}

export function projectFrontdoorData(display: string, raw: Record<string, unknown>): Record<string, unknown> {
  const route = getRoute(raw);
  const details = projectFrontdoorDetails(route, raw);
  return enforceJsonBudget({
    answer: boundText(display, 1_000),
    ...(Object.keys(details).length > 0 ? { details } : {}),
  });
}

function getRoute(raw: Record<string, unknown>): string {
  const routing = asRecord(raw.routing);
  return typeof routing?.chosen_route === "string" ? routing.chosen_route : "content_recall";
}

function projectFrontdoorDetails(route: string, raw: Record<string, unknown>): Record<string, unknown> {
  switch (route) {
    case "grounded_recall": {
      const grounded = asRecord(raw.grounded_answer);
      return grounded ? { grounded_answer: projectGroundedRecallData(grounded) } : {};
    }
    case "episodic_recall":
      return projectEpisodeDetails(raw);
    case "hierarchy":
      return projectHierarchyDetails(raw);
    case "overview":
      return projectOverviewDetails(raw);
    case "relationship":
    case "reasoning":
      return projectAgenticDetails(raw);
    case "debug_search":
      return projectDebugDetails(raw);
    default:
      return projectContentDetails(raw);
  }
}

function projectContentDetails(raw: Record<string, unknown>): Record<string, unknown> {
  const entities = asRecords(raw.entities).slice(0, 10).map(projectNamedSnippet);
  const subjectContextCandidates = asRecords(raw.subject_context_candidates)
    .slice(0, 5)
    .map((item) => {
      const provenance =
        item.provenance === "trusted" || item.provenance === "user_thought"
          ? item.provenance
          : undefined;
      const candidate: Record<string, unknown> = {};
      if (typeof item.source_title === "string") {
        candidate.source_title = boundText(item.source_title, PROJECTED_CLAIM_MAX);
      }
      if (typeof item.event_date === "string") {
        candidate.event_date = boundText(item.event_date, 50);
      }
      if (typeof item.summary === "string") {
        candidate.summary = boundText(item.summary, PROJECTED_CLAIM_MAX);
      }
      if (provenance) candidate.provenance = provenance;
      candidate.topic_relevance = "unverified" as const;
      return candidate;
    });
  return {
    ...(typeof raw.query === "string" ? { query: boundText(raw.query, 1_000) } : {}),
    ...(entities.length > 0 ? { entities } : {}),
    ...(subjectContextCandidates.length > 0 ? { subject_context_candidates: subjectContextCandidates } : {}),
    ...(typeof raw.summary === "string" ? { summary: boundText(raw.summary) } : {}),
  };
}

function projectEpisodeDetails(raw: Record<string, unknown>): Record<string, unknown> {
  const candidates = asRecords(raw.candidates).slice(0, 5).map((candidate) => ({
    ...projectNamedSnippet(candidate),
    ...(isConfidence(candidate.confidence) ? { confidence: candidate.confidence } : {}),
    ...(Array.isArray(candidate.matched_clues)
      ? {
        matched_clues: asRecords(candidate.matched_clues).slice(0, 3).map((clue) => ({
          ...(typeof clue.dimension === "string" ? { dimension: boundText(clue.dimension, 100) } : {}),
          ...(typeof clue.hint_used === "string" ? { hint_used: boundText(clue.hint_used, 240) } : {}),
        })),
      }
      : {}),
    ...(Array.isArray(candidate.evidence)
      ? {
        evidence: asRecords(candidate.evidence).slice(0, 3).map((item) => ({
          ...(typeof item.date === "string" ? { date: boundText(item.date, 100) } : {}),
        })),
      }
      : {}),
  }));
  return {
    ...(typeof raw.query === "string" ? { query: boundText(raw.query, 1_000) } : {}),
    ...(typeof raw.summary === "string" ? { summary: boundText(raw.summary) } : {}),
    ...(candidates.length > 0 ? { candidates } : {}),
  };
}

function projectHierarchyDetails(raw: Record<string, unknown>): Record<string, unknown> {
  const seed = asRecord(raw.seed);
  return {
    ...(seed ? { seed: projectNamedSnippet(seed) } : {}),
    ...(Array.isArray(raw.upward) ? { upward: asRecords(raw.upward).slice(0, 20).map(projectNamedSnippet) } : {}),
    ...(Array.isArray(raw.downward) ? { downward: asRecords(raw.downward).slice(0, 20).map(projectNamedSnippet) } : {}),
  };
}

function projectOverviewDetails(raw: Record<string, unknown>): Record<string, unknown> {
  const stats = asRecord(raw.stats);
  return {
    ...(typeof raw.topic === "string" ? { topic: boundText(raw.topic, 1_000) } : {}),
    ...(Array.isArray(raw.entities) ? { entities: asRecords(raw.entities).slice(0, 10).map(projectNamedSnippet) } : {}),
    ...(stats
      ? {
        stats: Object.fromEntries(
          ["totalEntities", "totalLinks", "totalEvents"]
            .filter((key) => typeof stats[key] === "number")
            .map((key) => [key, stats[key]]),
        ),
      }
      : {}),
  };
}

function projectAgenticDetails(raw: Record<string, unknown>): Record<string, unknown> {
  const result = asRecord(raw.result);
  if (!result) return {};
  const board = asRecord(result.evidence_board);
  const context = asRecord(result.answer_context);
  const evidenceBoard = board
    ? {
      facts: projectClaims(board.facts),
      user_thoughts: projectClaims(board.user_thoughts),
      candidates: projectClaims(board.candidates),
      conflicts: projectClaims(board.conflicts),
      gaps: projectStrings(board.gaps, 6, PROJECTED_CLAIM_MAX),
    }
    : undefined;
  const answerContext = context
    ? {
      ...(isConfidence(context.confidence) ? { confidence: context.confidence } : {}),
      top_claims: projectStrings(context.topClaims, 6, PROJECTED_CLAIM_MAX),
      gaps: projectStrings(context.gaps, 6, PROJECTED_CLAIM_MAX),
    }
    : undefined;
  return {
    result: {
      ...(typeof result.status === "string" ? { status: result.status } : {}),
      ...(evidenceBoard ? { evidence_board: evidenceBoard } : {}),
      ...(answerContext ? { answer_context: answerContext } : {}),
    },
  };
}

function projectDebugDetails(raw: Record<string, unknown>): Record<string, unknown> {
  const results = asRecords(raw.results).slice(0, 20).map((item) => ({
    ...(typeof item.snippet === "string" ? { snippet: boundText(item.snippet) } : {}),
  }));
  return { result_count: results.length, results };
}

function projectNamedSnippet(value: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(typeof value.title === "string" ? { title: boundText(value.title, 500) } : {}),
    ...(typeof value.name === "string" ? { name: boundText(value.name, 500) } : {}),
    ...(typeof value.type === "string" ? { type: boundText(value.type, 200) } : {}),
    ...(typeof value.snippet === "string" ? { snippet: boundText(value.snippet) } : {}),
  };
}

function projectClaims(value: unknown): string[] {
  return asRecords(value).slice(0, 6).flatMap((item) => typeof item.claim === "string" ? [boundText(item.claim, PROJECTED_CLAIM_MAX)] : []);
}

function projectStrings(value: unknown, limit: number, maxLength: number): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").slice(0, limit).map((item) => boundText(item, maxLength))
    : [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.flatMap((item) => {
    const record = asRecord(item);
    return record ? [record] : [];
  }) : [];
}

function isConfidence(value: unknown): value is "high" | "medium" | "low" {
  return value === "high" || value === "medium" || value === "low";
}

function boundText(value: string, maxLength: number = PROJECTED_TEXT_MAX): string {
  const normalized = value.normalize("NFKC");
  return normalized.length <= maxLength ? normalized : normalized.slice(0, maxLength);
}

function enforceJsonBudget<T extends Record<string, unknown>>(value: T): T {
  while (JSON.stringify(value).length > PROJECTED_DATA_BUDGET) {
    const arrays: unknown[][] = [];
    collectNonEmptyArrays(value, arrays);
    if (arrays.length === 0) return {} as T;
    arrays.sort((a, b) => b.length - a.length);
    arrays[0].pop();
  }
  return value;
}

function collectNonEmptyArrays(value: unknown, out: unknown[][]): void {
  if (Array.isArray(value)) {
    if (value.length > 0) out.push(value);
    for (const item of value) collectNonEmptyArrays(item, out);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectNonEmptyArrays(item, out);
  }
}

function projectHints(hints: HintProjectionInput[] | undefined): Array<Record<string, string>> {
  return (hints ?? []).slice(0, 20).map((hint) => ({
    ...(typeof hint.text === "string" ? { text: boundText(hint.text) } : {}),
    ...(typeof hint.why === "string" ? { why: boundText(hint.why) } : {}),
  })).filter((hint) => Object.keys(hint).length > 0);
}

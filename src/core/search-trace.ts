import type { SearchTrace } from "./search.js";

export type SearchTraceStatus = "running" | "success" | "degraded" | "error";

export interface StartSearchTraceSessionInput {
  query: string;
  mode: string;
  intent?: string;
}

export interface FinishSearchTraceSessionInput {
  latencyMs?: number;
  status?: SearchTraceStatus;
  llmCalls?: number;
  totalSteps?: number;
  summaryJson?: Record<string, unknown>;
}

export interface AddSearchTraceStepInput {
  sessionId: number;
  stepIndex: number;
  kind: string;
  inputJson?: Record<string, unknown>;
  outputSummary?: string;
  latencyMs?: number;
  error?: string;
}

export interface SearchTraceSessionRow {
  id: number;
  query: string;
  mode: string;
  intent: string | null;
  started_at: string;
  ended_at: string | null;
  latency_ms: number | null;
  status: string;
  llm_calls: number;
  total_steps: number;
  summary_json: unknown | null;
}

export interface SearchTraceStepRow {
  id: number;
  session_id: number;
  step_index: number;
  kind: string;
  input_json: unknown | null;
  output_summary: string | null;
  latency_ms: number | null;
  error: string | null;
  created_at: string;
}

const TRACE_TIMING_FIELDS: Array<{ key: keyof SearchTrace; kind: string }> = [
  { key: "expand_ms", kind: "expand" },
  { key: "research_ms", kind: "research" },
  { key: "vector_ms", kind: "vector" },
  { key: "fts_ms", kind: "fts" },
  { key: "graph_ms", kind: "graph" },
  { key: "temporal_ms", kind: "temporal" },
  { key: "decompose_ms", kind: "decompose" },
  { key: "rerank_ms", kind: "rerank" },
];

export function traceToSteps(sessionId: number, trace: SearchTrace): AddSearchTraceStepInput[] {
  const steps: AddSearchTraceStepInput[] = [];
  let index = 0;
  for (const { key, kind } of TRACE_TIMING_FIELDS) {
    const ms = trace[key] as number | undefined;
    if (ms !== undefined && ms > 0) {
      steps.push({ sessionId, stepIndex: index++, kind, latencyMs: ms });
    }
  }
  return steps;
}

import { canonicalJson } from "./canonical.js";
import { normalizePayloadProse } from "./integrity.js";
import type { RecommendationRecordReader } from "./record-reader.js";
import type { ResolveResult } from "./registry.js";
import type { RecommendationRecord } from "./types.js";

export type ReplayResult =
  | { status: "not_found" }
  | { status: "replayed"; inputs_match: true }
  | { status: "rule_version_unavailable"; reason: "unknown" | "purged" | "incompatible" }
  | { status: "unverifiable"; reason: "integrity_failed" | "resolver_failed" | "producer_mismatch" | "runner_failed" }
  | { status: "conclusion_mismatch" };

export interface ExactRuleResolver {
  resolve(id: string, version: string): ResolveResult;
}

export interface ReplayDeps {
  readonly store: RecommendationRecordReader;
  readonly registry: ExactRuleResolver;
}

export function replayRecord(deps: ReplayDeps, recordId: string): ReplayResult {
  let record: RecommendationRecord | null;
  try {
    record = deps.store.getById(recordId);
  } catch {
    return { status: "unverifiable", reason: "integrity_failed" };
  }
  if (!record) return { status: "not_found" };

  const producer = record.payload.producer;
  let resolved: ResolveResult;
  try {
    resolved = deps.registry.resolve(producer.rule_id, producer.rule_version);
  } catch {
    return { status: "unverifiable", reason: "resolver_failed" };
  }
  if (resolved.status === "unavailable") {
    return { status: "rule_version_unavailable", reason: resolved.reason };
  }
  if (
    resolved.runner.code_hash !== producer.code_hash
    || resolved.def.registry_ref !== producer.registry_ref
    || resolved.def.rule_id !== producer.rule_id
    || resolved.def.rule_version !== producer.rule_version
  ) {
    return { status: "unverifiable", reason: "producer_mismatch" };
  }

  try {
    const conclusion = resolved.runner.decide(record.payload.decision_inputs);
    const normalizedConclusion = normalizePayloadProse({ ...record.payload, conclusion }).conclusion;
    return canonicalJson(normalizedConclusion) === canonicalJson(record.payload.conclusion)
      ? { status: "replayed", inputs_match: true }
      : { status: "conclusion_mismatch" };
  } catch {
    return { status: "unverifiable", reason: "runner_failed" };
  }
}

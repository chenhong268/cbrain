import { computeInputsHash } from "./integrity.js";
import type { DeclaredProjectionReader } from "./projection.js";
import type { RecommendationStore } from "./record-store.js";
import type { VersionedRuleRegistry } from "./registry.js";
import type { RecommendationConstraints, RecommendationRecord } from "./types.js";

/**
 * Recompute freshness and persist it (spec §5.3, §8.4). Dependency drift touches ONLY
 * freshness_status — lifecycle is never moved here. Order of checks matters:
 *   1. constraint (policy/ontology/schema) mismatch → version_invalid
 *   2. producer's rule_version not live in registry → version_invalid (no guess)
 *   3. resolved runner's code_hash/registry_ref ≠ record's producer metadata → version_invalid
 *      (this is the freshness-layer metadata check that catches a self-consistent-fingerprint
 *      record whose producer identity was swapped — integrity cannot, because the fingerprint
 *      was computed over the swapped payload)
 *   4. else inputs_hash over version-pinned captureInputs → fresh | stale
 */
export function recomputeAndPersistFreshness(
  record: RecommendationRecord,
  reader: DeclaredProjectionReader,
  registry: VersionedRuleRegistry,
  store: RecommendationStore,
  currentConstraints: RecommendationConstraints,
  now: string,
): { freshness: "fresh" | "stale" | "version_invalid" } {
  const c = record.payload.constraints;
  if (currentConstraints.policy_version !== c.policy_version || currentConstraints.ontology_version !== c.ontology_version || currentConstraints.schema_version !== c.schema_version) {
    store.updateFreshness(record.record_id, "version_invalid", now);
    return { freshness: "version_invalid" };
  }
  const r = registry.resolve(record.payload.producer.rule_id, record.payload.producer.rule_version);
  if (r.status !== "ok") {
    store.updateFreshness(record.record_id, "version_invalid", now);
    return { freshness: "version_invalid" };
  }
  if (r.runner.code_hash !== record.payload.producer.code_hash || r.def.registry_ref !== record.payload.producer.registry_ref) {
    store.updateFreshness(record.record_id, "version_invalid", now);
    return { freshness: "version_invalid" };
  }
  const freshness = computeInputsHash(r.runner.captureInputs(reader.read(record.payload.dependency_manifest.declarations))) === record.payload.inputs_hash ? "fresh" : "stale";
  store.updateFreshness(record.record_id, freshness, now);
  return { freshness };
}

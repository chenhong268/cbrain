import { DeclaredProjectionReader } from "./projection.js";
import { RecommendationStore } from "./record-store.js";
import { ontologyHash } from "./ontology.js";
import { policyHash } from "./versions.js";
import { SCHEMA_VERSION } from "./types.js";
import type { CBrainDB } from "../../storage/sqlite.js";
import type { VersionedRuleRegistry } from "./registry.js";
import type { DependencyDeclaration, DependencyManifest, EvidenceManifestEntry, RecommendationConstraints, RecommendationImmutablePayload, RecommendationRecord } from "./types.js";

export interface BuildRequest {
  rule_id: string;
  slugs: string[];
}

/**
 * Orchestrates one producer run: resolve the active runner, build a def-sourced dependency_manifest
 * (declarations come from readTemplate — the manifest IS the producer schema), capture frozen
 * decision_inputs, decide, and persist an immutable record. Fail-closes if no active version.
 * The record store is the single persistence entry (it computes inputs_hash + fingerprint +
 * integrity internally), so the manager never writes SQL.
 */
export class RecommendationManager {
  constructor(private db: CBrainDB, private registry: VersionedRuleRegistry) {}

  buildAndStore(req: BuildRequest, now: string): RecommendationRecord {
    const active = this.registry.resolveActive(req.rule_id);
    if (active.status !== "ok") throw new Error(`manager: producer ${req.rule_id} has no active version`);
    const { runner, def } = active;

    const slugs = [...new Set(req.slugs)].sort();
    const declarations: DependencyDeclaration[] = slugs.map((s) => ({ slug: s, ...def.readTemplate }));
    const dependency_manifest: DependencyManifest = { rule_id: req.rule_id, declarations };

    const decision_inputs = runner.captureInputs(new DeclaredProjectionReader(this.db).read(declarations));
    const conclusion = runner.decide(decision_inputs);
    const evidence_manifest: EvidenceManifestEntry[] = decision_inputs.evidence_refs.map((ref) => ({ source: def.evidenceSource, ref, trust_state: "candidate" }));
    const constraints: RecommendationConstraints = { policy_version: policyHash(this.registry), ontology_version: ontologyHash(), schema_version: SCHEMA_VERSION };

    const payload: RecommendationImmutablePayload = {
      namespace: "maintenance",
      maintenance_key: `${req.rule_id}:${JSON.stringify(slugs)}`,
      inputs_hash: "",
      conclusion,
      decision_inputs,
      evidence_manifest,
      constraints,
      dependency_manifest,
      applicability: { audience: "user_only", auto_execute: false, requires_confirmation: { tier: "standard" } },
      risks: [],
      gaps: [],
      producer: { rule_id: def.rule_id, rule_version: def.rule_version, code_hash: runner.code_hash, registry_ref: def.registry_ref },
    };

    return new RecommendationStore(this.db).createRecord(payload, now);
  }
}

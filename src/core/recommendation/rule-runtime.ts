import { canonicalJson, sha256Hex } from "./canonical.js";
import type { DecisionInputs, RecommendationConclusion, RuleDefinition } from "./types.js";

/**
 * Behavior-only identity hash (rev7 M2a). Covers ONLY the behavior subset
 * (readTemplate + candidateTrustState + evidenceSource + evidenceRefTemplate + abstainReason + propose).
 * rule_id / rule_version / registry_ref are IDENTITY and intentionally excluded, so bumping a
 * version without changing behavior leaves code_hash unchanged (lets old versions stay exact-resolvable
 * for replay without spuriously invalidating records).
 */
export function definitionCodeHash(def: RuleDefinition): string {
  return sha256Hex(canonicalJson({ readTemplate: def.readTemplate, candidateTrustState: def.candidateTrustState, evidenceSource: def.evidenceSource, evidenceRefTemplate: def.evidenceRefTemplate, abstainReason: def.abstainReason, propose: def.propose }));
}

interface LinkEdge {
  from: string;
  to: string;
  trust_state: string;
}

/**
 * Generic deterministic runner built from a RuleDefinition. `captureInputs` reads ONLY the
 * projection key named by `def.readTemplate.as` (not a hardcoded `reports_to`), so the same runner
 * serves any single-relation maintenance rule. `decide` is pure (no DB/LLM/network) — replayable.
 */
export function runRule(def: RuleDefinition): { code_hash: string; captureInputs: (projection: unknown) => DecisionInputs; decide: (di: DecisionInputs) => RecommendationConclusion } {
  const code_hash = definitionCodeHash(def);
  const as = def.readTemplate.as;

  const captureInputs = (projection: unknown): DecisionInputs => {
    const p = projection as Record<string, Record<string, LinkEdge[]>>;
    const slugs = Object.keys(p).sort();
    const candidates: LinkEdge[] = [];
    const entity_snapshot: Record<string, Record<string, unknown>> = {};
    for (const s of slugs) {
      const edges = p[s]?.[as] ?? [];
      entity_snapshot[s] = { [as]: edges };
      for (const e of edges) {
        if (e.trust_state === def.candidateTrustState) candidates.push(e);
      }
    }
    const evidence_refs = [...new Set(candidates.map((e) => def.evidenceRefTemplate.replace("{from}", e.from).replace("{to}", e.to)))].sort();
    return { signals: { candidate_count: candidates.length }, entity_snapshot, evidence_refs };
  };

  const decide = (di: DecisionInputs): RecommendationConclusion => {
    if (((di.signals.candidate_count as number) ?? 0) === 0) return { kind: "abstain", reason: def.abstainReason };
    const first = Object.keys(di.entity_snapshot).sort()[0] ?? "";
    return { kind: "propose", action: { type: def.propose.type, target_ref: def.propose.targetTemplate.replace("{first_slug}", first), reason: def.propose.reason }, alternatives: [] };
  };

  return { code_hash, captureInputs, decide };
}

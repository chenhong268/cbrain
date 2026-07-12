import { describe, expect, test } from "bun:test";
import { definitionCodeHash, runRule } from "../../../src/core/recommendation/rule-runtime.js";
import type { RuleDefinition } from "../../../src/core/recommendation/types.js";

const DEF: RuleDefinition = {
  rule_id: "health:known_relations", rule_version: "1.0.0", registry_ref: "cbrain.rules:maintenance.known_relations@1.0.0",
  readTemplate: { table: "links", as: "reports_to", relation: "reports_to", direction: "outgoing", fields: ["from", "to", "trust_state"], filter: "active" },
  candidateTrustState: "candidate", evidenceSource: "health", evidenceRefTemplate: "health:known_relations:{from}:{to}", abstainReason: "insufficient_evidence",
  propose: { type: "dry_run", targetTemplate: "health:known_relations:{first_slug}", reason: "存在待确认的 reports_to 候选边，建议人工复核" },
};

describe("definitionCodeHash (BEHAVIOR subset only)", () => {
  test("behavior change => hash change", () => {
    expect(definitionCodeHash({ ...DEF, abstainReason: "below_threshold" })).not.toBe(definitionCodeHash(DEF));
  });
  test("identity change only => hash UNCHANGED", () => {
    expect(definitionCodeHash({ ...DEF, rule_version: "1.1.0", registry_ref: "cbrain.rules:maintenance.known_relations@1.1.0" })).toBe(definitionCodeHash(DEF));
  });
});

describe("runRule (generic)", () => {
  test("code_hash === definitionCodeHash", () => {
    expect(runRule(DEF).code_hash).toBe(definitionCodeHash(DEF));
  });
  test("abstains when no candidate edge", () => {
    const r = runRule(DEF);
    expect(r.decide(r.captureInputs({ eA: { reports_to: [] } })).kind).toBe("abstain");
  });
  test("proposes + exact evidence ref", () => {
    const r = runRule(DEF);
    const di = r.captureInputs({ "entities/eA": { reports_to: [{ from: "entities/eA", to: "entities/eB", trust_state: "candidate" }] } });
    expect(di.evidence_refs).toEqual(["health:known_relations:entities/eA:entities/eB"]);
    expect(r.decide(di).kind).toBe("propose");
  });
  test("M2a: runRule reads def.readTemplate.as (NOT hardcoded reports_to)", () => {
    const defOtherRel: RuleDefinition = { ...DEF, readTemplate: { ...DEF.readTemplate, relation: "supported_by", as: "supported_by" } };
    const r = runRule(defOtherRel);
    // edges under `reports_to` are ignored; only `supported_by` edges are read
    const di = r.captureInputs({ eA: { reports_to: [{ from: "eA", to: "eB", trust_state: "candidate" }], supported_by: [{ from: "eA", to: "eC", trust_state: "candidate" }] } });
    expect(di.signals.candidate_count).toBe(1);
    expect(di.evidence_refs).toEqual(["health:known_relations:eA:eC"]);
  });
});

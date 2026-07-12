import { describe, expect, test } from "bun:test";
import { ontologyHash } from "../../../src/core/recommendation/ontology.js";
import { policyHash } from "../../../src/core/recommendation/versions.js";
import { VersionedRuleRegistry } from "../../../src/core/recommendation/registry.js";
import type { RuleDefinition } from "../../../src/core/recommendation/types.js";

const DEF: RuleDefinition = {
  rule_id: "d", rule_version: "1.0.0", registry_ref: "d@1.0.0",
  readTemplate: { table: "links", as: "reports_to", relation: "reports_to", direction: "outgoing", fields: ["from", "to", "trust_state"], filter: "active" },
  candidateTrustState: "candidate", evidenceSource: "health", evidenceRefTemplate: "d:{from}:{to}", abstainReason: "insufficient_evidence",
  propose: { type: "dry_run", targetTemplate: "d:{first_slug}", reason: "r" },
};

describe("ontology + versions", () => {
  test("ontologyHash is a real content hash of the bundled ontology.yaml", () => {
    expect(ontologyHash()).toMatch(/^[0-9a-f]{64}$/);
  });
  test("policyHash uses registry.policyManifest (active only)", () => {
    const reg = new VersionedRuleRegistry();
    reg.register(DEF);
    reg.setActive("d", "1.0.0");
    expect(policyHash(reg)).toMatch(/^[0-9a-f]{64}$/);
    const before = policyHash(reg);
    reg.register({ ...DEF, rule_version: "1.1.0", registry_ref: "d@1.1.0" });
    expect(policyHash(reg)).toBe(before);
  });
});

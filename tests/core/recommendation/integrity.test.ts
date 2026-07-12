import { describe, expect, test } from "bun:test";
import { canonicalDeclaration, checkIntegrity, computeFingerprint, computeInputsHash, validateDependencyDeclarations } from "../../../src/core/recommendation/integrity.js";
import type { DependencyDeclaration, RecommendationImmutablePayload, RecommendationRecord } from "../../../src/core/recommendation/types.js";
import { SCHEMA_VERSION } from "../../../src/core/recommendation/types.js";

const dupDecls: DependencyDeclaration[] = [
  { slug: "a", table: "links", as: "reports_to", relation: "reports_to", fields: ["from", "to"] },
  { slug: "a", table: "links", as: "reports_to", relation: "reports_to", fields: ["from", "to"] },
];

describe("duplicate declarations — isolated per entry", () => {
  test("computeFingerprint throws on duplicate (payload passed directly)", () => {
    expect(() => computeFingerprint(payloadWith(dupDecls))).toThrow(/duplicate.*slug.*as/);
  });
  test("checkIntegrity returns duplicate_declaration (record built with ARBITRARY fingerprint so it reaches the validator)", () => {
    const r: RecommendationRecord = { record_id: "r1", payload: payloadWith(dupDecls), fingerprint: "arbitrary-not-recomputed", created_at: "2026-07-12 10:00:00", last_revalidated_at: "2026-07-12 10:00:00", lifecycle_status: "pending", freshness_status: "fresh", suppressed_until: null };
    const x = checkIntegrity(r);
    expect(x.ok).toBe(false);
    if (!x.ok) expect(x.code).toBe("duplicate_declaration");
  });
  test("validateDependencyDeclarations throws on duplicate (shared fn)", () => {
    expect(() => validateDependencyDeclarations(dupDecls)).toThrow(/duplicate.*slug.*as/);
  });
});

describe("canonicalDeclaration omits absent optionals", () => {
  test("global (no slug) hashes cleanly", () => {
    expect(() => computeFingerprint(payloadWith([{ table: "config", as: "flag", fields: ["value"] }]))).not.toThrow();
    expect(JSON.stringify(canonicalDeclaration({ table: "config", as: "flag", fields: ["value"] }))).not.toContain('"slug"');
  });
  test("pages (no relation/filter) hashes cleanly", () => {
    expect(() => computeFingerprint(payloadWith([{ slug: "a", table: "pages", as: "page", fields: ["content_hash"] }]))).not.toThrow();
    const s = JSON.stringify(canonicalDeclaration({ slug: "a", table: "pages", as: "page", fields: ["content_hash"] }));
    expect(s).not.toContain('"relation"');
    expect(s).not.toContain('"filter"');
  });
  test("links default direction/filter round-trips", () => {
    const p = payloadWith([{ slug: "a", table: "links", as: "reports_to", relation: "reports_to", fields: ["from", "to"] }]);
    const fp = computeFingerprint(p);
    expect(computeFingerprint(JSON.parse(JSON.stringify(p)) as RecommendationImmutablePayload)).toBe(fp);
  });
});

function payloadWith(declarations: DependencyDeclaration[]): RecommendationImmutablePayload {
  const di = { signals: {}, entity_snapshot: {}, evidence_refs: [] as string[] };
  return { namespace: "maintenance", maintenance_key: "k", inputs_hash: "", conclusion: { kind: "abstain", reason: "insufficient_evidence" }, decision_inputs: di, evidence_manifest: [], constraints: { policy_version: "p", ontology_version: "o", schema_version: SCHEMA_VERSION }, dependency_manifest: { rule_id: "r", declarations }, applicability: { audience: "user_only", auto_execute: false, requires_confirmation: { tier: "standard" } }, risks: [], gaps: [], producer: { rule_id: "r", rule_version: "1", code_hash: "h", registry_ref: "r@1" } };
}

function basePayload(): RecommendationImmutablePayload {
  const di = { signals: { candidate_count: 1 }, entity_snapshot: { eA: { reports_to: [{ from: "eA", to: "eB", trust_state: "candidate" }] } }, evidence_refs: ["health:k:eA:eB"] };
  return { namespace: "maintenance", maintenance_key: "k", inputs_hash: "", conclusion: { kind: "propose", action: { type: "dry_run", target_ref: "health:k:eA", reason: "r" }, alternatives: [] }, decision_inputs: di, evidence_manifest: [{ source: "health", ref: "health:k:eA:eB", trust_state: "candidate" }], constraints: { policy_version: "p", ontology_version: "o", schema_version: SCHEMA_VERSION }, dependency_manifest: { rule_id: "r", declarations: [{ slug: "eA", table: "links", as: "reports_to", relation: "reports_to", direction: "outgoing", fields: ["from", "to", "trust_state"], filter: "active" }] }, applicability: { audience: "user_only", auto_execute: false, requires_confirmation: { tier: "standard" } }, risks: [], gaps: [], producer: { rule_id: "r", rule_version: "1", code_hash: "h", registry_ref: "r@1" } };
}

function rec(p: RecommendationImmutablePayload): RecommendationRecord {
  p.inputs_hash = computeInputsHash(p.decision_inputs);
  return { record_id: "r1", payload: p, fingerprint: computeFingerprint(p), created_at: "2026-07-12 10:00:00", last_revalidated_at: "2026-07-12 10:00:00", lifecycle_status: "pending", freshness_status: "fresh", suppressed_until: null };
}

describe("checkIntegrity", () => {
  test("clean passes", () => {
    expect(checkIntegrity(rec(basePayload())).ok).toBe(true);
  });
  test("inputs_hash tamper", () => {
    const r = rec(basePayload());
    r.payload.inputs_hash = "x";
    const x = checkIntegrity(r);
    expect(x.ok).toBe(false);
    if (!x.ok) expect(x.code).toBe("inputs_hash_mismatch");
  });
  test("fingerprint tamper — fixed code, no ref echo", () => {
    const r = rec(basePayload());
    r.payload.conclusion = { kind: "abstain", reason: "insufficient_evidence" };
    const x = checkIntegrity(r);
    expect(x.ok).toBe(false);
    if (!x.ok) {
      expect(x.code).toBe("fingerprint_mismatch");
      expect(x.message).not.toContain("health:k");
    }
  });
  test("cross: undeclared projection as-key", () => {
    const p = basePayload();
    (p.decision_inputs.entity_snapshot.eA as Record<string, unknown>).bogus = [];
    expect(checkIntegrity(rec(p)).ok).toBe(false);
  });
  test("cross: undeclared edge sub-field", () => {
    const p = basePayload();
    (p.decision_inputs.entity_snapshot.eA as { reports_to: Record<string, unknown>[] }).reports_to[0].extra = 1;
    expect(checkIntegrity(rec(p)).ok).toBe(false);
  });
  test("cross: evidence ref not projected", () => {
    const p = basePayload();
    p.evidence_manifest.push({ source: "health", ref: "health:k:eA:eC", trust_state: "candidate" });
    expect(checkIntegrity(rec(p)).ok).toBe(false);
  });
  test("cross: rule_id mismatch", () => {
    const p = basePayload();
    p.dependency_manifest.rule_id = "other";
    expect(checkIntegrity(rec(p)).ok).toBe(false);
  });
});

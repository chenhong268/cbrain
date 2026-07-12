import { describe, expect, test } from "bun:test";
import { VersionedRuleRegistry } from "../../../src/core/recommendation/registry.js";
import type { RuleDefinition } from "../../../src/core/recommendation/types.js";

function def(id: string, ver: string, behavior = "a"): RuleDefinition {
  return {
    rule_id: id, rule_version: ver, registry_ref: `${id}@${ver}`,
    readTemplate: { table: "links", as: behavior === "a" ? "reports_to" : "supported_by", relation: behavior === "a" ? "reports_to" : "supported_by", direction: "outgoing", fields: ["from", "to", "trust_state"], filter: "active" },
    candidateTrustState: "candidate", evidenceSource: "health", evidenceRefTemplate: `${id}:{from}:{to}`, abstainReason: "insufficient_evidence",
    propose: { type: "dry_run", targetTemplate: `${id}:{first_slug}`, reason: "r" },
  };
}

describe("VersionedRuleRegistry", () => {
  test("multiple live versions COEXIST; old exact-resolvable", () => {
    const reg = new VersionedRuleRegistry();
    reg.register(def("d", "1.0.0"));
    reg.register(def("d", "1.1.0"));
    expect(reg.resolve("d", "1.0.0").status).toBe("ok");
    expect(reg.resolve("d", "1.1.0").status).toBe("ok");
  });

  test("register does not grab active; setActive required", () => {
    const reg = new VersionedRuleRegistry();
    reg.register(def("d", "1.0.0"));
    expect(reg.resolveActive("d").status).toBe("unavailable");
    reg.setActive("d", "1.0.0");
    expect(reg.resolveActive("d").status).toBe("ok");
    expect(() => reg.setActive("d", "9.9.9")).toThrow(/live runner/);
  });

  test("registering an INACTIVE version does NOT change policyManifest", () => {
    const reg = new VersionedRuleRegistry();
    reg.register(def("d", "1.0.0"));
    reg.setActive("d", "1.0.0");
    const before = reg.policyManifest();
    reg.register(def("d", "1.1.0"));
    expect(reg.policyManifest()).toBe(before);
  });

  test("setActive changes policyManifest", () => {
    const reg = new VersionedRuleRegistry();
    reg.register(def("d", "1.0.0"));
    reg.register(def("d", "1.1.0"));
    reg.setActive("d", "1.0.0");
    const before = reg.policyManifest();
    reg.setActive("d", "1.1.0");
    expect(reg.policyManifest()).not.toBe(before);
    expect(reg.policyManifest()).toContain("active:d:1.1.0:");
  });

  test("post-register mutation of the ORIGINAL def does NOT change resolved behavior/code_hash/policyManifest", () => {
    const reg = new VersionedRuleRegistry();
    const d = def("d", "1.0.0");
    reg.register(d);
    reg.setActive("d", "1.0.0");
    const resolvedBefore = reg.resolveActive("d");
    if (resolvedBefore.status !== "ok") throw new Error();
    const manifestBefore = reg.policyManifest();
    const hashBefore = resolvedBefore.runner.code_hash;
    d.abstainReason = "below_threshold";
    d.propose.reason = "changed";
    d.readTemplate.fields.push("extra");
    const resolvedAfter = reg.resolveActive("d");
    if (resolvedAfter.status !== "ok") throw new Error();
    expect(resolvedAfter.runner.code_hash).toBe(hashBefore);
    expect(resolvedAfter.def.abstainReason).toBe("insufficient_evidence");
    expect(reg.policyManifest()).toBe(manifestBefore);
    expect(Object.isFrozen(resolvedAfter.def)).toBe(true);
    expect(Object.isFrozen((resolvedAfter.def as unknown as { readTemplate: object }).readTemplate)).toBe(true);
    const c = resolvedAfter.runner.decide(resolvedAfter.runner.captureInputs({ eA: { reports_to: [] } }));
    expect(c.kind).toBe("abstain");
    if (c.kind === "abstain") expect(c.reason).toBe("insufficient_evidence");
  });

  test("MED 1: re-register SAME content (different object) is idempotent no-op; DIFFERENT content throws", () => {
    const reg = new VersionedRuleRegistry();
    const d1 = def("d", "1.0.0");
    reg.register(d1);
    expect(() => reg.register(def("d", "1.0.0"))).not.toThrow();
    expect(() => reg.register({ ...def("d", "1.0.0"), abstainReason: "below_threshold" })).toThrow(/different definition/);
  });

  test("MED 2: same registry_ref bound to a different (rule_id,rule_version) is rejected", () => {
    const reg = new VersionedRuleRegistry();
    reg.register(def("d", "1.0.0"));
    const reuseRef: RuleDefinition = { ...def("e", "1.0.0"), registry_ref: "d@1.0.0" };
    expect(() => reg.register(reuseRef)).toThrow(/registry_ref 'd@1\.0\.0' already bound/);
  });

  test("markPurged takes NO codeHash arg; tombstone identity derived internally", () => {
    const reg = new VersionedRuleRegistry();
    reg.register(def("d", "1.0.0"));
    reg.register(def("d", "1.1.0"));
    reg.setActive("d", "1.1.0");
    const live0 = reg.resolve("d", "1.0.0");
    if (live0.status !== "ok") throw new Error();
    const expectedHash = live0.runner.code_hash;
    reg.markPurged("d", "1.0.0");
    expect(reg.resolve("d", "1.0.0").status).toBe("unavailable");
    expect(reg.registryAuditManifest()).toContain(`d@1.0.0:purged:${expectedHash}`);
    const liveActive = reg.resolve("d", "1.1.0");
    if (liveActive.status !== "ok") throw new Error();
    expect(() => reg.markPurged("d", "1.1.0")).toThrow(/cannot purge active/);
  });

  test("HIGH 1: unknown tombstone (no live, no existing) throws", () => {
    const reg = new VersionedRuleRegistry();
    expect(() => reg.markPurged("d", "9.9.9")).toThrow(/no live entry/);
    expect(() => reg.markIncompatible("d", "9.9.9")).toThrow(/no live entry/);
  });

  test("HIGH 1: same-state tombstone repeat is idempotent — original hash preserved", () => {
    const reg = new VersionedRuleRegistry();
    reg.register(def("d", "1.0.0"));
    reg.register(def("d", "1.1.0"));
    reg.setActive("d", "1.1.0");
    reg.markPurged("d", "1.0.0");
    const after1 = reg.registryAuditManifest();
    reg.markPurged("d", "1.0.0");
    expect(reg.registryAuditManifest()).toBe(after1);
  });

  test("HIGH 1: purged → incompatible is rejected (no state overwrite)", () => {
    const reg = new VersionedRuleRegistry();
    reg.register(def("d", "1.0.0"));
    reg.register(def("d", "1.1.0"));
    reg.setActive("d", "1.1.0");
    reg.markPurged("d", "1.0.0");
    expect(() => reg.markIncompatible("d", "1.0.0")).toThrow(/already purged/);
  });

  test("purging an inactive version does NOT change policyManifest", () => {
    const reg = new VersionedRuleRegistry();
    reg.register(def("d", "1.0.0"));
    reg.register(def("d", "1.1.0"));
    reg.setActive("d", "1.1.0");
    const before = reg.policyManifest();
    reg.markPurged("d", "1.0.0");
    expect(reg.policyManifest()).toBe(before);
  });

  test("rev9 HIGH: markIncompatible on the SOLE active version safely shuts it down (fail-closed)", () => {
    const reg = new VersionedRuleRegistry();
    reg.register(def("d", "1.0.0"));
    reg.setActive("d", "1.0.0");
    expect(() => reg.markIncompatible("d", "1.0.0")).not.toThrow();
    expect(reg.resolveActive("d").status).toBe("unavailable");
    expect(reg.policyManifest()).toBe("");
    expect(reg.resolve("d", "1.0.0").status).toBe("unavailable");
  });

  test("rev9: markPurged on active still refused (retention must switch first)", () => {
    const reg = new VersionedRuleRegistry();
    reg.register(def("d", "1.0.0"));
    reg.setActive("d", "1.0.0");
    expect(() => reg.markPurged("d", "1.0.0")).toThrow(/cannot purge active/);
  });
});

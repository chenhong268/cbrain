import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { CBrainDB } from "../../../src/storage/sqlite.js";
import { RecommendationStore } from "../../../src/core/recommendation/record-store.js";
import { computeFingerprint, computeInputsHash } from "../../../src/core/recommendation/integrity.js";
import type { RecommendationImmutablePayload } from "../../../src/core/recommendation/types.js";
import { SCHEMA_VERSION } from "../../../src/core/recommendation/types.js";

let db: CBrainDB;
let store: RecommendationStore;
let dir: string;

function mkPayload(codeHash: string, key = "k1"): RecommendationImmutablePayload {
  const di = { signals: { v: 1 }, entity_snapshot: { eA: { reports_to: [{ from: "eA", to: "eB", trust_state: "candidate" }] } }, evidence_refs: ["health:k:eA:eB"] };
  return {
    namespace: "maintenance", maintenance_key: key, inputs_hash: computeInputsHash(di),
    conclusion: { kind: "propose", action: { type: "dry_run", target_ref: "health:k:eA", reason: "r" }, alternatives: [] },
    decision_inputs: di, evidence_manifest: [{ source: "health", ref: "health:k:eA:eB", trust_state: "candidate" }],
    constraints: { policy_version: "p", ontology_version: "o", schema_version: SCHEMA_VERSION },
    dependency_manifest: { rule_id: "health:k", declarations: [{ slug: "eA", table: "links", as: "reports_to", relation: "reports_to", direction: "outgoing", fields: ["from", "to", "trust_state"], filter: "active" }] },
    applicability: { audience: "user_only", auto_execute: false, requires_confirmation: { tier: "standard" } },
    risks: [], gaps: [], producer: { rule_id: "health:k", rule_version: "1.0.0", code_hash: codeHash, registry_ref: "r@1.0.0" },
  };
}

describe("RecommendationStore", () => {
  afterEach(() => {
    db?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function open() {
    dir = mkdtempSync(join(tmpdir(), "cbrain-rec-store-"));
    db = new CBrainDB(`${dir}/db.sqlite`);
    store = new RecommendationStore(db);
  }

  test("createRecord computes fingerprint internally", () => {
    open();
    const p = mkPayload("h1");
    const r = store.createRecord(p, "2026-07-12 10:00:00");
    expect(r.fingerprint).toBe(computeFingerprint({ ...p, inputs_hash: computeInputsHash(p.decision_inputs) }));
    expect(r.lifecycle_status).toBe("pending");
    expect(r.freshness_status).toBe("fresh");
  });

  test("rejects auto_execute !== false", () => {
    open();
    const p = mkPayload("h1");
    expect(() => store.createRecord({ ...p, applicability: { ...p.applicability, auto_execute: true as unknown as false } }, "2026-07-12 10:00:00")).toThrow(/auto_execute/);
  });

  test("same fingerprint idempotent", () => {
    open();
    const p = mkPayload("h1");
    const r1 = store.createRecord(p, "2026-07-12 10:00:00");
    expect(store.createRecord(p, "2026-07-12 10:00:00").record_id).toBe(r1.record_id);
  });

  test("different fingerprint same key → atomic supersede; count stays 1", () => {
    open();
    store.createRecord(mkPayload("hA"), "2026-07-12 10:00:00");
    store.createRecord(mkPayload("hB"), "2026-07-12 10:00:01");
    expect(store.activeCountFor("k1")).toBe(1);
  });

  test("illegal now rejected", () => {
    open();
    expect(() => store.createRecord(mkPayload("h1"), "2026-13-45 99:99:99")).toThrow(/invalid now/);
    expect(() => store.createRecord(mkPayload("h1"), "bad")).toThrow(/invalid now/);
  });

  test("default TTL: reject without suppressedUntil → now+7d", () => {
    open();
    const p = mkPayload("h1");
    const r = store.createRecord(p, "2026-07-12 10:00:00");
    store.transitionLifecycle(r.record_id, "rejected", "2026-07-12 10:00:01", "declined");
    expect(store.getById(r.record_id)?.suppressed_until).toBe("2026-07-19 10:00:01");
    expect(() => store.createRecord(p, "2026-07-13 10:00:00")).toThrow(/suppressed/);
  });

  test("explicit null => permanent", () => {
    open();
    const p = mkPayload("h1");
    const r = store.createRecord(p, "2026-07-12 10:00:00");
    store.transitionLifecycle(r.record_id, "rejected", "2026-07-12 10:00:01", "declined", null);
    expect(store.getById(r.record_id)?.suppressed_until).toBeNull();
    expect(() => store.createRecord(p, "2099-01-01 00:00:00")).toThrow(/suppressed/);
  });

  test("illegal suppressedUntil rejected", () => {
    open();
    const p = mkPayload("h1");
    const r = store.createRecord(p, "2026-07-12 10:00:00");
    expect(() => store.transitionLifecycle(r.record_id, "rejected", "2026-07-12 10:00:01", "x", "bad")).toThrow(/invalid suppressed_until/);
  });

  test("F17: expired suppression allows re-create", () => {
    open();
    const p = mkPayload("h1");
    const r = store.createRecord(p, "2026-07-12 10:00:00");
    store.transitionLifecycle(r.record_id, "rejected", "2026-07-12 10:00:01", "declined", "2026-07-12 09:00:00");
    expect(() => store.createRecord(p, "2026-07-13 10:00:00")).not.toThrow();
  });

  test("real sibling: expired + permanent coexist → EXISTS blocks", () => {
    open();
    const p = mkPayload("h1");
    const r1 = store.createRecord(p, "2026-07-12 10:00:00");
    store.transitionLifecycle(r1.record_id, "rejected", "2026-07-12 10:00:01", "x", "2026-07-12 09:00:00");
    const r2 = store.createRecord(p, "2026-07-13 10:00:00");
    store.transitionLifecycle(r2.record_id, "rejected", "2026-07-13 10:00:01", "x", null);
    expect(() => store.createRecord(p, "2026-07-13 10:00:02")).toThrow(/suppressed/);
  });

  test("clearSuppression only on rejected + existing", () => {
    open();
    const p = mkPayload("h1");
    const r = store.createRecord(p, "2026-07-12 10:00:00");
    expect(() => store.clearSuppression(r.record_id, "2026-07-12 10:00:01", "reopen")).toThrow(/only allowed on rejected/);
    store.transitionLifecycle(r.record_id, "rejected", "2026-07-12 10:00:02", "x");
    expect(() => store.clearSuppression("nonexistent", "2026-07-12 10:00:03", "reopen")).toThrow(/not found/);
    store.clearSuppression(r.record_id, "2026-07-12 10:00:03", "reopen");
    expect(() => store.createRecord(p, "2026-07-13 10:00:00")).not.toThrow();
  });

  test("transitionLifecycle whitelist: superseded cannot regress", () => {
    open();
    const p = mkPayload("h1");
    const r = store.createRecord(p, "2026-07-12 10:00:00");
    store.transitionLifecycle(r.record_id, "superseded", "2026-07-12 10:00:01", "t");
    expect(() => store.transitionLifecycle(r.record_id, "pending", "2026-07-12 10:00:02", "r")).toThrow(/illegal.*transition/);
  });

  test("updateFreshness changes ONLY freshness", () => {
    open();
    const p = mkPayload("h1");
    const r = store.createRecord(p, "2026-07-12 10:00:00");
    store.updateFreshness(r.record_id, "stale", "2026-07-12 10:00:01");
    const re = store.getById(r.record_id);
    expect(re?.freshness_status).toBe("stale");
    expect(re?.lifecycle_status).toBe("pending");
  });

  test("createRecord supersede rolls back on partial failure", () => {
    const faultDir = mkdtempSync(join(tmpdir(), "cbrain-rec-fault-"));
    let fdb: CBrainDB | undefined;
    try {
      fdb = new CBrainDB(`${faultDir}/db.sqlite`);
      const fstore = new RecommendationStore(fdb);
      const created = fstore.createRecord(mkPayload("hA"), "2026-07-12 10:00:00");
      fdb.rawDb.exec("DROP TABLE recommendation_lifecycle_history");
      expect(() => fstore.createRecord(mkPayload("hB"), "2026-07-12 10:00:01")).toThrow();
      expect(fstore.activeCountFor("k1")).toBe(1);
      expect(fstore.getById(created.record_id)?.fingerprint).toBe(created.fingerprint);
    } finally {
      fdb?.close();
      rmSync(faultDir, { recursive: true, force: true });
    }
  });

  test("fingerprint survives store → DB → store reload", () => {
    open();
    const created = store.createRecord(mkPayload("h1"), "2026-07-12 10:00:00");
    const reloaded = store.getById(created.record_id);
    expect(reloaded?.fingerprint).toBe(created.fingerprint);
    expect(computeFingerprint(reloaded!.payload)).toBe(created.fingerprint);
  });
});

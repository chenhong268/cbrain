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

  test("HIGH-2b: DB CHECK rejects tampering row-level maintenance_key away from payload (root-cause)", () => {
    open();
    const r = store.createRecord(mkPayload("h1"), "2026-07-12 10:00:00");
    // The migration enforces maintenance_key/inputs_hash == payload at the DB layer, so a column
    // tamper is rejected at the UPDATE itself — write-side operations can trust the row columns.
    expect(() => db.rawDb.prepare("UPDATE recommendation_records SET maintenance_key=$k WHERE record_id=$id").run({ $k: "tampered-key", $id: r.record_id })).toThrow(/CHECK|constraint/i);
    expect(() => db.rawDb.prepare("UPDATE recommendation_records SET inputs_hash=$h WHERE record_id=$id").run({ $h: "tampered-hash", $id: r.record_id })).toThrow(/CHECK|constraint/i);
    // record is unchanged and still readable
    expect(store.getById(r.record_id)?.payload.maintenance_key).toBe("k1");
  });

  test("HIGH-2b: DB CHECK rejects tampering payload applicability.auto_execute to true", () => {
    open();
    const r = store.createRecord(mkPayload("h1"), "2026-07-12 10:00:00");
    // Flip auto_execute inside the payload JSON; the column stays 0, so the envelope CHECK
    // (auto_execute IS json_extract(payload, '$.applicability.auto_execute')) rejects the UPDATE.
    expect(() => db.rawDb.prepare("UPDATE recommendation_records SET payload = json_set(payload, '$.applicability.auto_execute', 1) WHERE record_id=$id").run({ $id: r.record_id })).toThrow(/CHECK|constraint/i);
    expect(store.getById(r.record_id)?.payload.applicability.auto_execute).toBe(false);
  });

  test("HIGH-A: write-side fail-closes when the active row has a bad envelope (DB CHECK bypassed via PRAGMA)", () => {
    open();
    const r1 = store.createRecord(mkPayload("h1"), "2026-07-12 10:00:00");
    // Simulate a CHECK bypass: tamper r1's payload maintenance_key so it diverges from the column.
    db.rawDb.exec("PRAGMA ignore_check_constraints=ON");
    db.rawDb.prepare("UPDATE recommendation_records SET payload = json_set(payload, '$.maintenance_key', 'evil') WHERE record_id=$id").run({ $id: r1.record_id });
    db.rawDb.exec("PRAGMA ignore_check_constraints=OFF");
    // r1 now has column maintenance_key='k1' but payload.maintenance_key='evil' (bad envelope).
    // A new createRecord for key 'k1' finds r1 active; the write side must detect the envelope
    // mismatch via fromRow and fail closed (throw) rather than supersede the corrupt row.
    expect(() => store.createRecord(mkPayload("h2"), "2026-07-12 10:00:01")).toThrow(/envelope mismatch/);
    // r1 was NOT superseded (the transaction rolled back). Read the column directly — getById would
    // itself throw on the bad-envelope row (fail-closed), which is the correct read-side behavior.
    const r1Status = (db.rawDb.prepare("SELECT lifecycle_status AS l FROM recommendation_records WHERE record_id=$id").get({ $id: r1.record_id }) as { l: string }).l;
    expect(r1Status).toBe("pending");
  });

  test("HIGH: row-level auto_execute=1 with payload false (CHECK bypassed) → getById throws (auto_execute not strictly false)", () => {
    open();
    const r = store.createRecord(mkPayload("h1"), "2026-07-12 10:00:00");
    db.rawDb.exec("PRAGMA ignore_check_constraints=ON");
    db.rawDb.prepare("UPDATE recommendation_records SET auto_execute=1 WHERE record_id=$id").run({ $id: r.record_id });
    db.rawDb.exec("PRAGMA ignore_check_constraints=OFF");
    // row auto_execute=1 but payload.applicability.auto_execute=false → decodeTrustedRow's absolute
    // auto_execute check rejects it (not silently accepted as "auto_execute:false").
    expect(() => store.getById(r.record_id)).toThrow(/auto_execute not strictly false/);
  });

  test("HIGH: row-level inputs_hash tampered (CHECK bypassed) → getById throws envelope mismatch", () => {
    open();
    const r = store.createRecord(mkPayload("h1"), "2026-07-12 10:00:00");
    db.rawDb.exec("PRAGMA ignore_check_constraints=ON");
    db.rawDb.prepare("UPDATE recommendation_records SET inputs_hash='deadbeef' WHERE record_id=$id").run({ $id: r.record_id });
    db.rawDb.exec("PRAGMA ignore_check_constraints=OFF");
    expect(() => store.getById(r.record_id)).toThrow(/envelope mismatch/);
  });

  test("HIGH-attack1: row+payload auto_execute=1/true double-tamper (self-consistent fp) → getById/createRecord fail, old record unchanged", () => {
    open();
    const r = store.createRecord(mkPayload("h1"), "2026-07-12 10:00:00");
    // double tamper: row=1, payload=true, fingerprint recomputed over the tampered payload (CHECK off)
    const row = db.rawDb.prepare("SELECT payload FROM recommendation_records WHERE record_id=$id").get({ $id: r.record_id }) as { payload: string };
    const tampered = JSON.parse(row.payload) as RecommendationImmutablePayload;
    (tampered.applicability as { auto_execute: boolean }).auto_execute = true;
    const newFp = computeFingerprint(tampered);
    db.rawDb.exec("PRAGMA ignore_check_constraints=ON");
    db.rawDb.prepare("UPDATE recommendation_records SET auto_execute=1, payload=$p, fingerprint=$fp WHERE record_id=$id").run({ $id: r.record_id, $p: JSON.stringify(tampered), $fp: newFp });
    db.rawDb.exec("PRAGMA ignore_check_constraints=OFF");
    // envelope is self-consistent (1==true) AND fingerprint matches, but auto_execute is not strictly
    // false → decodeTrustedRow's absolute check rejects it on every path.
    expect(() => store.getById(r.record_id)).toThrow(/auto_execute not strictly false/);
    expect(() => store.createRecord(mkPayload("h2"), "2026-07-12 10:00:01")).toThrow(/auto_execute not strictly false/);
    const status = (db.rawDb.prepare("SELECT lifecycle_status AS l FROM recommendation_records WHERE record_id=$id").get({ $id: r.record_id }) as { l: string }).l;
    expect(status).toBe("pending"); // NOT superseded (tx rolled back)
  });

  test("HIGH-attack2: active payload reason changed (CHECK on) → idempotent create does NOT return the bad record", () => {
    open();
    store.createRecord(mkPayload("h1"), "2026-07-12 10:00:00");
    // CHECK stays ON; change only the payload reason (fingerprint now mismatches; envelope still equal).
    db.rawDb.prepare("UPDATE recommendation_records SET payload = json_set(payload, '$.conclusion.action.reason', 'changed') WHERE record_id=(SELECT record_id FROM recommendation_records WHERE maintenance_key='k1')").run();
    // idempotent create with the ORIGINAL payload: active.fingerprint (column) === fingerprint(new),
    // but decodeTrustedRow(active) runs checkIntegrity → fingerprint_mismatch → throws (not returned).
    expect(() => store.createRecord(mkPayload("h1"), "2026-07-12 10:00:01")).toThrow(/integrity fingerprint_mismatch/);
  });

  test("HIGH-attack3: rejected payload reason changed (CHECK on) → no suppression, no create, integrity failure", () => {
    open();
    const p = mkPayload("h1");
    const r = store.createRecord(p, "2026-07-12 10:00:00");
    store.transitionLifecycle(r.record_id, "rejected", "2026-07-12 10:00:01", "declined");
    db.rawDb.prepare("UPDATE recommendation_records SET payload = json_set(payload, '$.conclusion.action.reason', 'changed') WHERE record_id=$id").run({ $id: r.record_id });
    // bad rejected row (fingerprint mismatch) → fail-closed integrity error: NOT suppressed, NOT created.
    expect(() => store.createRecord(p, "2026-07-13 10:00:00")).toThrow(/integrity fingerprint_mismatch/);
  });

  test("HIGH-attack4: envelope-corrupt rejected row → fail-closed (no silent skip, no false suppression)", () => {
    open();
    const p = mkPayload("h1");
    const r = store.createRecord(p, "2026-07-12 10:00:00");
    store.transitionLifecycle(r.record_id, "rejected", "2026-07-12 10:00:01", "declined"); // suppressed_until = 2026-07-19
    db.rawDb.exec("PRAGMA ignore_check_constraints=ON");
    db.rawDb.prepare("UPDATE recommendation_records SET payload = json_set(payload, '$.maintenance_key', 'evil') WHERE record_id=$id").run({ $id: r.record_id });
    db.rawDb.exec("PRAGMA ignore_check_constraints=OFF");
    // envelope-corrupt rejected row → decodeTrustedRow throws (fail-closed), not silently skipped.
    expect(() => store.createRecord(p, "2026-07-13 10:00:00")).toThrow(/envelope mismatch/);
  });
});

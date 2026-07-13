import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { canonicalJson } from "../../../src/core/recommendation/canonical.js";
import { diffRecordsById, type DiffEntry } from "../../../src/core/recommendation/diff.js";
import { computeInputsHash } from "../../../src/core/recommendation/integrity.js";
import { RecommendationRecordReader } from "../../../src/core/recommendation/record-reader.js";
import { RecommendationStore } from "../../../src/core/recommendation/record-store.js";
import { SCHEMA_VERSION, type RecommendationImmutablePayload, type RecommendationRecord } from "../../../src/core/recommendation/types.js";
import { CBrainDB } from "../../../src/storage/sqlite.js";

let db: CBrainDB | undefined;
let dir = "";

function basePayload(key = "rule:r:[entity/a]"): RecommendationImmutablePayload {
  const decisionInputs = {
    signals: { candidate_count: 1, confidence: 0.8 },
    inspected_claims: ["claim:a"],
    entity_snapshot: { "entity/a": { reports_to: [{ from: "entity/a", to: "entity/b", trust_state: "candidate" }] } },
    evidence_refs: ["health:r:entity/a:entity/b"],
  };
  return {
    namespace: "maintenance",
    maintenance_key: key,
    inputs_hash: computeInputsHash(decisionInputs),
    conclusion: {
      kind: "propose",
      action: { type: "dry_run", target_ref: "entity/a", reason: "review relation", rollback_note: "leave unchanged" },
      alternatives: [{ type: "review", target_ref: "entity/b", reason: "inspect related entity" }],
    },
    decision_inputs: decisionInputs,
    evidence_manifest: [{ source: "health", ref: decisionInputs.evidence_refs[0]!, trust_state: "candidate" }],
    constraints: { policy_version: "v1", ontology_version: "v1", schema_version: SCHEMA_VERSION },
    dependency_manifest: {
      rule_id: "rule:r",
      declarations: [{ slug: "entity/a", table: "links", as: "reports_to", relation: "reports_to", direction: "outgoing", fields: ["from", "to", "trust_state"], filter: "active" }],
    },
    applicability: { audience: "user_only", auto_execute: false, requires_confirmation: { tier: "standard" } },
    risks: ["risk:a"],
    gaps: ["gap:a"],
    producer: { rule_id: "rule:r", rule_version: "1.0.0", code_hash: "hash-r1", registry_ref: "rules:r@1.0.0" },
  };
}

function clonePayload(payload: RecommendationImmutablePayload): RecommendationImmutablePayload {
  return structuredClone(payload);
}

function open() {
  dir = mkdtempSync(join(tmpdir(), "cbrain-rec-diff-"));
  db = new CBrainDB(join(dir, "brain.sqlite"));
  const store = new RecommendationStore(db);
  return { store, reader: RecommendationRecordReader.fromStore(store) };
}

function pair(mutate: (payload: RecommendationImmutablePayload) => void, key = "rule:r:[entity/a]") {
  const { store, reader } = open();
  const left = store.createRecord(basePayload(key), "2026-07-13 10:00:00");
  const rightPayload = clonePayload(basePayload(key));
  mutate(rightPayload);
  const right = store.createRecord(rightPayload, "2026-07-13 10:00:01");
  return { store, reader, left, right };
}

function entriesFor(mutate: (payload: RecommendationImmutablePayload) => void): DiffEntry[] {
  const { reader, left, right } = pair(mutate);
  const result = diffRecordsById(reader, left.record_id, right.record_id);
  if (!result.ok) throw new Error(`unexpected diff failure: ${result.reason}`);
  return result.entries;
}

function insertTrustedClone(record: RecommendationRecord, id: string): void {
  db!.rawDb.prepare(`INSERT INTO recommendation_records
    (record_id, maintenance_key, fingerprint, inputs_hash, payload, auto_execute, created_at, last_revalidated_at, lifecycle_status, freshness_status, suppressed_until)
    SELECT $newId, maintenance_key, fingerprint, inputs_hash, payload, auto_execute, '2026-07-13 10:00:02', '2026-07-13 10:00:03', 'superseded', 'stale', '2026-07-20 10:00:00'
    FROM recommendation_records WHERE record_id=$oldId`).run({ $newId: id, $oldId: record.record_id });
}

describe("diffRecordsById", () => {
  afterEach(() => {
    db?.close();
    db = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  test("diff module exposes no raw-record bypass", async () => {
    expect(Object.keys(await import("../../../src/core/recommendation/diff.js"))).toEqual(["diffRecordsById"]);
  });

  test("missing and corrupt sides fail closed without partial entries", () => {
    const { store, reader } = open();
    const record = store.createRecord(basePayload(), "2026-07-13 10:00:00");
    expect(diffRecordsById(reader, "missing", record.record_id)).toEqual({ ok: false, reason: "not_found" });
    expect(diffRecordsById(reader, record.record_id, "missing")).toEqual({ ok: false, reason: "not_found" });

    db!.rawDb.prepare("UPDATE recommendation_records SET fingerprint='tampered' WHERE record_id=$id").run({ $id: record.record_id });
    expect(diffRecordsById(reader, record.record_id, "missing")).toEqual({ ok: false, reason: "integrity_failed" });
  });

  test("namespace or maintenance key mismatch is incomparable", () => {
    const { store, reader } = open();
    const left = store.createRecord(basePayload("slot:a"), "2026-07-13 10:00:00");
    const otherKey = store.createRecord(basePayload("slot:b"), "2026-07-13 10:00:01");
    expect(diffRecordsById(reader, left.record_id, otherKey.record_id)).toEqual({ ok: false, reason: "incomparable" });

    const otherNamespacePayload = basePayload("slot:a");
    otherNamespacePayload.namespace = "other";
    const otherNamespace = store.createRecord(otherNamespacePayload, "2026-07-13 10:00:02");
    expect(diffRecordsById(reader, left.record_id, otherNamespace.record_id)).toEqual({ ok: false, reason: "incomparable" });
  });

  test("mutable-only differences produce an empty diff", () => {
    const { store, reader } = open();
    const left = store.createRecord(basePayload(), "2026-07-13 10:00:00");
    insertTrustedClone(left, "00000000-0000-4000-8000-000000000002");
    expect(diffRecordsById(reader, left.record_id, "00000000-0000-4000-8000-000000000002"))
      .toEqual({ ok: true, entries: [] });
  });

  test("same values changing in two constraint fields remain two entries", () => {
    const entries = entriesFor((payload) => {
      payload.constraints.policy_version = "v2";
      payload.constraints.ontology_version = "v2";
    });
    expect(entries).toEqual([
      { axis: "constraint", key: "/constraints/ontology_version", change: "changed", before: '"v1"', after: '"v2"' },
      { axis: "constraint", key: "/constraints/policy_version", change: "changed", before: '"v1"', after: '"v2"' },
    ]);
  });

  test("only an alternative changes the option axis", () => {
    const entries = entriesFor((payload) => {
      if (payload.conclusion.kind !== "propose") throw new Error("fixture");
      payload.conclusion.alternatives.push({ type: "notify_draft", target_ref: "entity/c", reason: "draft notice" });
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.axis).toBe("option");
    expect(entries[0]?.change).toBe("added");
  });

  test("selected action changes only the conclusion axis", () => {
    const entries = entriesFor((payload) => {
      if (payload.conclusion.kind !== "propose") throw new Error("fixture");
      payload.conclusion.action.target_ref = "entity/b";
    });
    expect(entries).toEqual([{ axis: "conclusion", key: "/conclusion/action/target_ref", change: "changed", before: '"entity/a"', after: '"entity/b"' }]);
  });

  test("cross-kind emits kind, action removals, reason addition, and option removals", () => {
    const entries = entriesFor((payload) => {
      payload.conclusion = { kind: "abstain", reason: "below_threshold" };
    });
    expect(entries.filter((entry) => entry.axis === "conclusion").map((entry) => [entry.key, entry.change])).toEqual([
      ["/conclusion/action/reason", "removed"],
      ["/conclusion/action/rollback_note", "removed"],
      ["/conclusion/action/target_ref", "removed"],
      ["/conclusion/action/type", "removed"],
      ["/conclusion/kind", "changed"],
      ["/conclusion/reason", "added"],
    ]);
    expect(entries.filter((entry) => entry.axis === "option")).toHaveLength(1);
  });

  test("applicability, risks, and gaps belong to the constraint axis", () => {
    const entries = entriesFor((payload) => {
      payload.applicability.requires_confirmation = { tier: "high_impact", confirm: ["constraint", "target"], reason: "write_action" };
      payload.risks.push("risk:b");
      payload.gaps = [];
    });
    expect(new Set(entries.map((entry) => entry.axis))).toEqual(new Set(["constraint"]));
    expect(entries.map((entry) => entry.key)).toContain("/applicability/requires_confirmation/tier");
    expect(entries.map((entry) => entry.key)).toContain('/risks/"risk:b"');
    expect(entries.map((entry) => entry.key)).toContain('/gaps/"gap:a"');
  });

  test("evidence trust-state flip stays on evidence axis", () => {
    const entries = entriesFor((payload) => {
      payload.evidence_manifest[0]!.trust_state = "trusted";
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.axis).toBe("evidence");
    expect(entries[0]?.change).toBe("changed");
  });

  test("dependency descends into signals, entity snapshots, refs, claims, and declarations", () => {
    const entries = entriesFor((payload) => {
      payload.decision_inputs.signals.candidate_count = 2;
      payload.decision_inputs.entity_snapshot["entity/a"]!.reports_to = [{ from: "entity/a", to: "entity/c", trust_state: "candidate" }];
      payload.decision_inputs.evidence_refs.push("health:r:entity/a:entity/c");
      payload.decision_inputs.inspected_claims!.push("claim:b");
      payload.dependency_manifest.declarations[0]!.fields.push("weight");
    });
    const keys = entries.filter((entry) => entry.axis === "dependency").map((entry) => entry.key);
    expect(keys).toContain("/decision_inputs/signals/candidate_count");
    expect(keys).toContain("/decision_inputs/entity_snapshot/entity~1a/reports_to");
    expect(keys).toContain("/decision_inputs/evidence_refs/health:r:entity~1a:entity~1c");
    expect(keys).toContain("/decision_inputs/inspected_claims/claim:b");
    expect(keys).toContain("/dependency_manifest/declarations/slug/entity~1a/reports_to");
  });

  test("object and set order changes are semantic no-ops", () => {
    const { reader, left, right } = pair((payload) => {
      payload.decision_inputs.signals = { confidence: 0.8, candidate_count: 1 };
      payload.decision_inputs.evidence_refs.reverse();
      payload.decision_inputs.inspected_claims?.reverse();
      payload.evidence_manifest.reverse();
      payload.risks.reverse();
      payload.gaps.reverse();
      if (payload.conclusion.kind === "propose") payload.conclusion.alternatives.reverse();
      payload.dependency_manifest.declarations[0]!.fields.reverse();
    });
    expect(diffRecordsById(reader, left.record_id, right.record_id)).toEqual({ ok: true, entries: [] });
  });

  test("the same pair produces byte-identical output repeatedly", () => {
    const { reader, left, right } = pair((payload) => {
      payload.constraints.policy_version = "v2";
      payload.risks.push("risk:b");
      payload.decision_inputs.signals.candidate_count = 2;
    });
    expect(canonicalJson(diffRecordsById(reader, left.record_id, right.record_id)))
      .toBe(canonicalJson(diffRecordsById(reader, left.record_id, right.record_id)));
  });
});

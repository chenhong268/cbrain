import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { RecommendationRecordReader } from "../../../src/core/recommendation/record-reader.js";
import { computeInputsHash } from "../../../src/core/recommendation/integrity.js";
import { RecommendationStore } from "../../../src/core/recommendation/record-store.js";
import { SCHEMA_VERSION, type RecommendationImmutablePayload } from "../../../src/core/recommendation/types.js";
import { CBrainDB } from "../../../src/storage/sqlite.js";

let db: CBrainDB | undefined;
let dir = "";

function payload(): RecommendationImmutablePayload {
  const decisionInputs = {
    signals: { candidate_count: 1 },
    entity_snapshot: { "entity/a": { reports_to: [{ from: "entity/a", to: "entity/b", trust_state: "candidate" }] } },
    evidence_refs: ["health:relation:entity/a:entity/b"],
  };
  return {
    namespace: "maintenance",
    maintenance_key: "rule:r:[entity/a]",
    inputs_hash: computeInputsHash(decisionInputs),
    conclusion: { kind: "propose", action: { type: "dry_run", target_ref: "entity/a", reason: "review relation" }, alternatives: [] },
    decision_inputs: decisionInputs,
    evidence_manifest: [{ source: "health", ref: decisionInputs.evidence_refs[0]!, trust_state: "candidate" }],
    constraints: { policy_version: "p1", ontology_version: "o1", schema_version: SCHEMA_VERSION },
    dependency_manifest: {
      rule_id: "rule:r",
      declarations: [{ slug: "entity/a", table: "links", as: "reports_to", relation: "reports_to", direction: "outgoing", fields: ["from", "to", "trust_state"], filter: "active" }],
    },
    applicability: { audience: "user_only", auto_execute: false, requires_confirmation: { tier: "standard" } },
    risks: [],
    gaps: [],
    producer: { rule_id: "rule:r", rule_version: "1.0.0", code_hash: "hash-r1", registry_ref: "rules:r@1.0.0" },
  };
}

describe("RecommendationRecordReader", () => {
  afterEach(() => {
    db?.close();
    db = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  test("only a real RecommendationStore can create the nominal reader", () => {
    dir = mkdtempSync(join(tmpdir(), "cbrain-rec-reader-"));
    db = new CBrainDB(join(dir, "brain.sqlite"));
    const store = new RecommendationStore(db);
    const record = store.createRecord(payload(), "2026-07-13 10:00:00");

    const reader = RecommendationRecordReader.fromStore(store);

    expect(reader.getById(record.record_id)?.record_id).toBe(record.record_id);
    expect(Object.getOwnPropertyNames(RecommendationRecordReader.prototype).sort()).toEqual(["constructor", "getById"]);
  });

  test("ordinary structural objects cannot impersonate the nominal reader", () => {
    // @ts-expect-error private class state makes the reader nominal rather than structural
    const forged: RecommendationRecordReader = { getById: () => null };
    expect(forged.getById("missing")).toBeNull();
  });
});

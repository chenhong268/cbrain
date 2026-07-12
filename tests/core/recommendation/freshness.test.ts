import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CBrainDB } from "../../../src/storage/sqlite.js";
import { RecommendationStore } from "../../../src/core/recommendation/record-store.js";
import { DeclaredProjectionReader } from "../../../src/core/recommendation/projection.js";
import { recomputeAndPersistFreshness } from "../../../src/core/recommendation/freshness.js";
import { VersionedRuleRegistry } from "../../../src/core/recommendation/registry.js";
import { computeInputsHash } from "../../../src/core/recommendation/integrity.js";
import type { DependencyManifest, RecommendationImmutablePayload, RecommendationProducer, RuleDefinition } from "../../../src/core/recommendation/types.js";
import { SCHEMA_VERSION } from "../../../src/core/recommendation/types.js";

let DIR: string;
const A = "entities/eA";
const B = "entities/eB";

function seed(db: CBrainDB) {
  for (const s of [A, B]) db.rawDb.prepare(`INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count, tier) VALUES (?, 'entity', ?, ?, ?, 0, 3)`).run(s, s, `${s}.md`, `h-${s}`);
}
function link(db: CBrainDB, from: string, to: string, trust: string) {
  db.rawDb.prepare(`INSERT INTO links (from_slug, to_slug, relation, trust_state, source_type) VALUES (?, ?, 'reports_to', ?, 'agent')`).run(from, to, trust);
}

const decls: DependencyManifest = {
  rule_id: "health:known_relations",
  declarations: [A, B].map((s) => ({ slug: s, table: "links" as const, as: "reports_to", relation: "reports_to", direction: "outgoing" as const, fields: ["from", "to", "trust_state"], filter: "active" as const })),
};

const DEF: RuleDefinition = {
  rule_id: "health:known_relations", rule_version: "1.0.0", registry_ref: "cbrain.rules:maintenance.known_relations@1.0.0",
  readTemplate: { table: "links", as: "reports_to", relation: "reports_to", direction: "outgoing", fields: ["from", "to", "trust_state"], filter: "active" },
  candidateTrustState: "candidate", evidenceSource: "health", evidenceRefTemplate: "health:known_relations:{from}:{to}", abstainReason: "insufficient_evidence",
  propose: { type: "dry_run", targetTemplate: "health:known_relations:{first_slug}", reason: "r" },
};

function makeRegistry(): VersionedRuleRegistry {
  const reg = new VersionedRuleRegistry();
  reg.register(DEF);
  reg.setActive(DEF.rule_id, DEF.rule_version);
  return reg;
}

function payloadFor(db: CBrainDB, reg: VersionedRuleRegistry, producerOverride?: Partial<RecommendationProducer>): RecommendationImmutablePayload {
  const proj = new DeclaredProjectionReader(db).read(decls.declarations);
  const r = reg.resolveActive(DEF.rule_id);
  if (r.status !== "ok") throw new Error("no active");
  const di = r.runner.captureInputs(proj);
  const producer: RecommendationProducer = { rule_id: DEF.rule_id, rule_version: DEF.rule_version, code_hash: r.runner.code_hash, registry_ref: DEF.registry_ref, ...producerOverride };
  return {
    namespace: "maintenance", maintenance_key: `health:known_relations:${JSON.stringify([A, B])}`, inputs_hash: computeInputsHash(di),
    conclusion: { kind: "propose", action: { type: "dry_run", target_ref: `health:known_relations:${A}`, reason: "r" }, alternatives: [] },
    decision_inputs: di, evidence_manifest: di.evidence_refs.map((ref) => ({ source: "health", ref, trust_state: "candidate" as const })),
    constraints: { policy_version: "p", ontology_version: "o", schema_version: SCHEMA_VERSION }, dependency_manifest: decls,
    applicability: { audience: "user_only", auto_execute: false, requires_confirmation: { tier: "standard" } }, risks: [], gaps: [], producer,
  };
}

const CC = { policy_version: "p", ontology_version: "o", schema_version: SCHEMA_VERSION };

describe("DeclaredProjectionReader", () => {
  beforeEach(() => {
    DIR = mkdtempSync(join(tmpdir(), "cbrain-rec-fresh-"));
  });
  afterEach(() => {
    if (DIR) rmSync(DIR, { recursive: true, force: true });
  });
  test("preserves from/to/trust_state", () => {
    const db = new CBrainDB(`${DIR}/r1.sqlite`);
    seed(db);
    link(db, A, B, "candidate");
    const e = (new DeclaredProjectionReader(db).read(decls.declarations)[A] as { reports_to: { from: string; to: string; trust_state: string }[] }).reports_to[0];
    expect(e).toEqual({ from: A, to: B, trust_state: "candidate" });
    db.close();
  });
  test("fail-closed unsupported table", () => {
    const db = new CBrainDB(`${DIR}/r2.sqlite`);
    seed(db);
    expect(() => new DeclaredProjectionReader(db).read([{ slug: A, table: "lance", as: "x", fields: ["y"] }])).toThrow(/unsupported table/);
    db.close();
  });
  test("fail-closed undeclared field", () => {
    const db = new CBrainDB(`${DIR}/r3.sqlite`);
    seed(db);
    link(db, A, B, "candidate");
    expect(() => new DeclaredProjectionReader(db).read([{ slug: A, table: "links", as: "reports_to", relation: "reports_to", fields: ["from", "bogus"], filter: "active" }])).toThrow(/not available/);
    db.close();
  });
  test("duplicate (slug,as) via SHARED validator", () => {
    const db = new CBrainDB(`${DIR}/r4.sqlite`);
    seed(db);
    expect(() => new DeclaredProjectionReader(db).read([
      { slug: A, table: "links", as: "reports_to", relation: "reports_to", fields: ["from", "to"], filter: "active" },
      { slug: A, table: "links", as: "reports_to", relation: "reports_to", fields: ["from", "to"], filter: "active" },
    ])).toThrow(/duplicate.*slug.*as/);
    db.close();
  });
  test("inactive excluded", () => {
    const db = new CBrainDB(`${DIR}/r5.sqlite`);
    seed(db);
    link(db, A, B, "rejected");
    expect((new DeclaredProjectionReader(db).read(decls.declarations)[A] as { reports_to: unknown[] }).reports_to.length).toBe(0);
    db.close();
  });
});

describe("recomputeAndPersistFreshness", () => {
  beforeEach(() => {
    DIR = mkdtempSync(join(tmpdir(), "cbrain-rec-fresh-"));
  });
  afterEach(() => {
    if (DIR) rmSync(DIR, { recursive: true, force: true });
  });
  test("drift → persisted stale, lifecycle untouched", () => {
    const db = new CBrainDB(`${DIR}/f1.sqlite`);
    seed(db);
    link(db, A, B, "candidate");
    const reg = makeRegistry();
    const store = new RecommendationStore(db);
    const c = store.createRecord(payloadFor(db, reg), "2026-07-12 10:00:00");
    link(db, B, A, "candidate");
    const out = recomputeAndPersistFreshness(store.getById(c.record_id)!, new DeclaredProjectionReader(db), reg, store, CC, "2026-07-12 11:00:00");
    expect(out.freshness).toBe("stale");
    const re = store.getById(c.record_id);
    expect(re?.freshness_status).toBe("stale");
    expect(re?.lifecycle_status).toBe("pending");
    db.close();
  });
  test("A→B→A path 1 → fresh recovers", () => {
    const db = new CBrainDB(`${DIR}/f2.sqlite`);
    seed(db);
    link(db, A, B, "candidate");
    const reg = makeRegistry();
    const store = new RecommendationStore(db);
    const c = store.createRecord(payloadFor(db, reg), "2026-07-12 10:00:00");
    link(db, B, A, "candidate");
    recomputeAndPersistFreshness(store.getById(c.record_id)!, new DeclaredProjectionReader(db), reg, store, CC, "2026-07-12 11:00:00");
    db.rawDb.prepare("DELETE FROM links WHERE from_slug=? AND to_slug=?").run(B, A);
    recomputeAndPersistFreshness(store.getById(c.record_id)!, new DeclaredProjectionReader(db), reg, store, CC, "2026-07-12 12:00:00");
    expect(store.getById(c.record_id)?.freshness_status).toBe("fresh");
    db.close();
  });
  test("runner unavailable → version_invalid", () => {
    const db = new CBrainDB(`${DIR}/f3.sqlite`);
    seed(db);
    link(db, A, B, "candidate");
    const reg = makeRegistry();
    const store = new RecommendationStore(db);
    const c = store.createRecord(payloadFor(db, reg), "2026-07-12 10:00:00");
    expect(recomputeAndPersistFreshness(store.getById(c.record_id)!, new DeclaredProjectionReader(db), new VersionedRuleRegistry(), store, CC, "2026-07-12 11:00:00").freshness).toBe("version_invalid");
    db.close();
  });
  test("runner code_hash mismatch with record producer → version_invalid", () => {
    const db = new CBrainDB(`${DIR}/f4.sqlite`);
    seed(db);
    link(db, A, B, "candidate");
    const reg = makeRegistry();
    const store = new RecommendationStore(db);
    const c = store.createRecord(payloadFor(db, reg, { code_hash: "deadbeef" }), "2026-07-12 10:00:00");
    expect(recomputeAndPersistFreshness(store.getById(c.record_id)!, new DeclaredProjectionReader(db), reg, store, CC, "2026-07-12 11:00:00").freshness).toBe("version_invalid");
    db.close();
  });
  test("ontology mismatch (via explicit currentConstraints) → version_invalid", () => {
    const db = new CBrainDB(`${DIR}/f5.sqlite`);
    seed(db);
    link(db, A, B, "candidate");
    const reg = makeRegistry();
    const store = new RecommendationStore(db);
    const c = store.createRecord(payloadFor(db, reg), "2026-07-12 10:00:00");
    expect(recomputeAndPersistFreshness(store.getById(c.record_id)!, new DeclaredProjectionReader(db), reg, store, { policy_version: "p", ontology_version: "changed", schema_version: SCHEMA_VERSION }, "2026-07-12 11:00:00").freshness).toBe("version_invalid");
    db.close();
  });
});

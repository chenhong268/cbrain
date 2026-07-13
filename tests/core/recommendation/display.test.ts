import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { CBrainDB } from "../../../src/storage/sqlite.js";
import { RecommendationStore } from "../../../src/core/recommendation/record-store.js";
import { DeclaredProjectionReader } from "../../../src/core/recommendation/projection.js";
import { VersionedRuleRegistry } from "../../../src/core/recommendation/registry.js";
import { registerMaintenanceProducers, registerVersion } from "../../../src/core/recommendation/producers/index.js";
import { RecommendationManager } from "../../../src/core/recommendation/manager.js";
import { loadAndProjectDisplay } from "../../../src/core/recommendation/display.js";
import { policyHash } from "../../../src/core/recommendation/versions.js";
import { ontologyHash } from "../../../src/core/recommendation/ontology.js";
import { KNOWN_RELATIONS_DEF } from "../../../src/core/recommendation/producers/known-relations.js";
import type { RecommendationImmutablePayload } from "../../../src/core/recommendation/types.js";
import { SCHEMA_VERSION } from "../../../src/core/recommendation/types.js";

const A = "entities/eA";
const B = "entities/eB";

function seed(db: CBrainDB) {
  for (const s of [A, B]) db.rawDb.prepare(`INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count, tier) VALUES (?, 'entity', ?, ?, ?, 0, 3)`).run(s, s, `${s}.md`, `h-${s}`);
}
function link(db: CBrainDB, from: string, to: string, trust: string) {
  db.rawDb.prepare(`INSERT INTO links (from_slug, to_slug, relation, trust_state, source_type) VALUES (?, ?, 'reports_to', ?, 'agent')`).run(from, to, trust);
}

const dirs: string[] = [];
const dbs: CBrainDB[] = [];
function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "cbrain-rec-display-"));
  dirs.push(dir);
  const db = new CBrainDB(`${dir}/db.sqlite`);
  dbs.push(db);
  const reg = new VersionedRuleRegistry();
  registerMaintenanceProducers(reg);
  return { db, store: new RecommendationStore(db), reg, mgr: new RecommendationManager(db, reg) };
}

describe("loadAndProjectDisplay", () => {
  afterEach(() => {
    dbs.forEach((d) => {
      d.close();
    });
    dbs.length = 0;
    dirs.forEach((d) => {
      rmSync(d, { recursive: true, force: true });
    });
    dirs.length = 0;
  });

  test("real positive → display produced", () => {
    const { db, store, reg, mgr } = fresh();
    seed(db);
    link(db, A, B, "candidate");
    const created = mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:00");
    const out = loadAndProjectDisplay(created.record_id, { store, reader: new DeclaredProjectionReader(db), registry: reg, now: "2026-07-12 10:00:01" }, () => "实体A");
    expect(out.blocked).toBe(false);
    if (!out.blocked) {
      expect(out.target_display).toBe("实体A");
      expect(out.reason).toContain("候选边");
    }
    db.close();
  });

  test("HIGH-3: abstain record is NOT displayed (spec §9 default-hidden; reason deferred to audit surface)", () => {
    const { db, store, reg, mgr } = fresh();
    seed(db);
    // no candidate edge → producer abstains
    const created = mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:00");
    expect(created.payload.conclusion.kind).toBe("abstain");
    const out = loadAndProjectDisplay(created.record_id, { store, reader: new DeclaredProjectionReader(db), registry: reg, now: "2026-07-12 10:00:01" }, () => "x");
    expect(out.blocked).toBe(true);
    if (out.blocked) expect(out.reason).toBe("abstained");
    db.close();
  });

  test("drift after create, no manual refresh → blocked", () => {
    const { db, store, reg, mgr } = fresh();
    seed(db);
    link(db, A, B, "candidate");
    const created = mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:00");
    link(db, B, A, "candidate");
    expect(loadAndProjectDisplay(created.record_id, { store, reader: new DeclaredProjectionReader(db), registry: reg, now: "2026-07-12 10:00:01" }, () => "x").blocked).toBe(true);
    db.close();
  });

  test("active identity change (setActive to a differently-hashed version) → blocked", () => {
    const { db, store, reg, mgr } = fresh();
    seed(db);
    link(db, A, B, "candidate");
    const created = mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:00");
    registerVersion(reg, { ...KNOWN_RELATIONS_DEF, rule_version: "1.1.0", registry_ref: "cbrain.rules:maintenance.known_relations@1.1.0", abstainReason: "below_threshold" });
    reg.setActive("health:known_relations", "1.1.0");
    expect(loadAndProjectDisplay(created.record_id, { store, reader: new DeclaredProjectionReader(db), registry: reg, now: "2026-07-12 10:00:01" }, () => "x").blocked).toBe(true);
  });

  test("M2b: metadata mismatch — fingerprint SELF-CONSISTENT but code_hash wrong → blocked BY freshness (not integrity), persisted version_invalid", () => {
    const { db, store, reg } = fresh();
    seed(db);
    link(db, A, B, "candidate");
    const di = { signals: { candidate_count: 1 }, entity_snapshot: { [A]: { reports_to: [{ from: A, to: B, trust_state: "candidate" }] } }, evidence_refs: [`health:known_relations:${A}:${B}`] };
    const meta = reg.directory()[0];
    const payload: RecommendationImmutablePayload = {
      namespace: "maintenance", maintenance_key: `health:known_relations:${JSON.stringify([A, B])}`, inputs_hash: "",
      conclusion: { kind: "propose", action: { type: "dry_run", target_ref: `health:known_relations:${A}`, reason: "r" }, alternatives: [] },
      decision_inputs: di, evidence_manifest: [{ source: "health", ref: `health:known_relations:${A}:${B}`, trust_state: "candidate" }],
      constraints: { policy_version: policyHash(reg), ontology_version: ontologyHash(), schema_version: SCHEMA_VERSION },
      dependency_manifest: { rule_id: "health:known_relations", declarations: [A, B].map((s) => ({ slug: s, table: "links" as const, as: "reports_to", relation: "reports_to", direction: "outgoing" as const, fields: ["from", "to", "trust_state"], filter: "active" as const })) },
      applicability: { audience: "user_only", auto_execute: false, requires_confirmation: { tier: "standard" } }, risks: [], gaps: [],
      producer: { rule_id: meta.rule_id, rule_version: meta.rule_version, code_hash: "WRONG-NOT-THE-REAL-HASH", registry_ref: meta.registry_ref },
    };
    const rec = store.createRecord(payload, "2026-07-12 10:00:00");
    const out = loadAndProjectDisplay(rec.record_id, { store, reader: new DeclaredProjectionReader(db), registry: reg, now: "2026-07-12 10:00:01" }, () => "x");
    expect(out.blocked).toBe(true);
    expect(store.getById(rec.record_id)?.freshness_status).toBe("version_invalid");
    db.close();
  });

  test("hostile reason via REAL record → sanitized", () => {
    const { db, store, reg } = fresh();
    seed(db);
    link(db, A, B, "candidate");
    // entity_snapshot must mirror what captureInputs produces (every declared slug, incl. B with
    // an empty edge list) so the record is a genuine fresh one and the test reaches the display
    // projection — where the hostile reason must be sanitized.
    const di = { signals: { candidate_count: 1 }, entity_snapshot: { [A]: { reports_to: [{ from: A, to: B, trust_state: "candidate" }] }, [B]: { reports_to: [] } }, evidence_refs: [`health:known_relations:${A}:${B}`] };
    const meta = reg.directory()[0];
    const payload: RecommendationImmutablePayload = {
      namespace: "maintenance", maintenance_key: `health:known_relations:${JSON.stringify([A, B])}`, inputs_hash: "",
      conclusion: { kind: "propose", action: { type: "dry_run", target_ref: `health:known_relations:${A}`, reason: "score=0.9 internal-metric" }, alternatives: [] },
      decision_inputs: di, evidence_manifest: [{ source: "health", ref: `health:known_relations:${A}:${B}`, trust_state: "candidate" }],
      constraints: { policy_version: policyHash(reg), ontology_version: ontologyHash(), schema_version: SCHEMA_VERSION },
      dependency_manifest: { rule_id: "health:known_relations", declarations: [A, B].map((s) => ({ slug: s, table: "links" as const, as: "reports_to", relation: "reports_to", direction: "outgoing" as const, fields: ["from", "to", "trust_state"], filter: "active" as const })) },
      applicability: { audience: "user_only", auto_execute: false, requires_confirmation: { tier: "standard" } }, risks: [], gaps: [],
      producer: { rule_id: meta.rule_id, rule_version: meta.rule_version, code_hash: meta.code_hash, registry_ref: meta.registry_ref },
    };
    const rec = store.createRecord(payload, "2026-07-12 10:00:00");
    const out = loadAndProjectDisplay(rec.record_id, { store, reader: new DeclaredProjectionReader(db), registry: reg, now: "2026-07-12 10:00:01" }, () => "实体A");
    expect(out.blocked).toBe(false);
    if (!out.blocked) {
      expect(out.reason).not.toContain("score");
      expect(out.reason).not.toContain("internal-metric");
    }
    db.close();
  });

  test("HIGH-1: fullwidth internal term normalized at persist → cannot bypass the display guard", () => {
    const { db, store, reg } = fresh();
    seed(db);
    link(db, A, B, "candidate");
    const di = { signals: { candidate_count: 1 }, entity_snapshot: { [A]: { reports_to: [{ from: A, to: B, trust_state: "candidate" }] }, [B]: { reports_to: [] } }, evidence_refs: [`health:known_relations:${A}:${B}`] };
    const meta = reg.directory()[0];
    const payload: RecommendationImmutablePayload = {
      namespace: "maintenance", maintenance_key: `health:known_relations:${JSON.stringify([A, B])}`, inputs_hash: "",
      conclusion: { kind: "propose", action: { type: "dry_run", target_ref: `health:known_relations:${A}`, reason: "ｓｃｏｒｅ leak" }, alternatives: [] },
      decision_inputs: di, evidence_manifest: [{ source: "health", ref: `health:known_relations:${A}:${B}`, trust_state: "candidate" }],
      constraints: { policy_version: policyHash(reg), ontology_version: ontologyHash(), schema_version: SCHEMA_VERSION },
      dependency_manifest: { rule_id: "health:known_relations", declarations: [A, B].map((s) => ({ slug: s, table: "links" as const, as: "reports_to", relation: "reports_to", direction: "outgoing" as const, fields: ["from", "to", "trust_state"], filter: "active" as const })) },
      applicability: { audience: "user_only", auto_execute: false, requires_confirmation: { tier: "standard" } }, risks: [], gaps: [],
      producer: { rule_id: meta.rule_id, rule_version: meta.rule_version, code_hash: meta.code_hash, registry_ref: meta.registry_ref },
    };
    const rec = store.createRecord(payload, "2026-07-12 10:00:00");
    // persisted reason is the NORMALIZED ascii form — the raw fullwidth never reaches the DB
    expect((rec.payload.conclusion as { action: { reason: string } }).action.reason).toBe("score leak");
    const out = loadAndProjectDisplay(rec.record_id, { store, reader: new DeclaredProjectionReader(db), registry: reg, now: "2026-07-12 10:00:01" }, () => "实体A");
    expect(out.blocked).toBe(false);
    if (!out.blocked) {
      expect(out.reason).not.toContain("ｓｃｏｒｅ");
      expect(out.reason).not.toContain("score");
    }
    db.close();
  });

  test("MEDIUM: fullwidth unsafe title (target_display) is NFKC-normalized + blocked at display", () => {
    const { db, store, reg, mgr } = fresh();
    seed(db);
    link(db, A, B, "candidate");
    const created = mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:00");
    // resolveSafeTitle returns a title carrying a fullwidth internal term (ｓｃｏｒｅ); display must
    // NFKC-fold it before the guard and degrade to fallback rather than leak the raw fullwidth.
    const out = loadAndProjectDisplay(created.record_id, { store, reader: new DeclaredProjectionReader(db), registry: reg, now: "2026-07-12 10:00:01" }, () => "ｓｃｏｒｅ 实体A");
    // Assert we reached projection (blocked===false) BEFORE the not-contain checks, so an unexpected
    // block cannot make the test pass by skipping the assertions (no false green).
    expect(out.blocked).toBe(false);
    if (!out.blocked) {
      expect(out.target_display).not.toContain("ｓｃｏｒｅ");
      expect(out.target_display).not.toContain("score");
    }
    db.close();
  });

  test("HIGH-1b: post-write tamper of payload reason to fullwidth still blocked (NFKC at display layer)", () => {
    const { db, store, reg } = fresh();
    seed(db);
    link(db, A, B, "candidate");
    // persisted reason is ascii "score" (integrity does not reject the string; createRecord stores it).
    const di = { signals: { candidate_count: 1 }, entity_snapshot: { [A]: { reports_to: [{ from: A, to: B, trust_state: "candidate" }] }, [B]: { reports_to: [] } }, evidence_refs: [`health:known_relations:${A}:${B}`] };
    const meta = reg.directory()[0];
    const payload: RecommendationImmutablePayload = {
      namespace: "maintenance", maintenance_key: `health:known_relations:${JSON.stringify([A, B])}`, inputs_hash: "",
      conclusion: { kind: "propose", action: { type: "dry_run", target_ref: `health:known_relations:${A}`, reason: "score" }, alternatives: [] },
      decision_inputs: di, evidence_manifest: [{ source: "health", ref: `health:known_relations:${A}:${B}`, trust_state: "candidate" }],
      constraints: { policy_version: policyHash(reg), ontology_version: ontologyHash(), schema_version: SCHEMA_VERSION },
      dependency_manifest: { rule_id: "health:known_relations", declarations: [A, B].map((s) => ({ slug: s, table: "links" as const, as: "reports_to", relation: "reports_to", direction: "outgoing" as const, fields: ["from", "to", "trust_state"], filter: "active" as const })) },
      applicability: { audience: "user_only", auto_execute: false, requires_confirmation: { tier: "standard" } }, risks: [], gaps: [],
      producer: { rule_id: meta.rule_id, rule_version: meta.rule_version, code_hash: meta.code_hash, registry_ref: meta.registry_ref },
    };
    const rec = store.createRecord(payload, "2026-07-12 10:00:00");
    // post-write tamper: swap ascii "score" → fullwidth "ｓｃｏｒｅ" in the persisted payload JSON.
    // fingerprint stays valid (canonicalPayload normalizes both to "score"); only the display-layer
    // NFKC+guard catches the fullwidth.
    db.rawDb.prepare("UPDATE recommendation_records SET payload = REPLACE(payload, 'score', 'ｓｃｏｒｅ') WHERE record_id=$id").run({ $id: rec.record_id });
    const out = loadAndProjectDisplay(rec.record_id, { store, reader: new DeclaredProjectionReader(db), registry: reg, now: "2026-07-12 10:00:01" }, () => "实体A");
    expect(out.blocked).toBe(false);
    if (!out.blocked) {
      expect(out.reason).not.toContain("ｓｃｏｒｅ");
      expect(out.reason).not.toContain("score");
    }
    db.close();
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { CBrainDB } from "../../../../src/storage/sqlite.js";
import { registerMaintenanceProducers, registerVersion } from "../../../../src/core/recommendation/producers/index.js";
import { VersionedRuleRegistry } from "../../../../src/core/recommendation/registry.js";
import { RecommendationManager } from "../../../../src/core/recommendation/manager.js";
import { policyHash } from "../../../../src/core/recommendation/versions.js";
import { definitionCodeHash } from "../../../../src/core/recommendation/rule-runtime.js";
import { KNOWN_RELATIONS_DEF } from "../../../../src/core/recommendation/producers/known-relations.js";

const A = "entities/entityA";
const B = "entities/entityB";

function seed(db: CBrainDB) {
  for (const s of [A, B]) db.rawDb.prepare(`INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count, tier) VALUES (?, 'entity', ?, ?, ?, 0, 3)`).run(s, s, `${s}.md`, `h-${s}`);
}
function link(db: CBrainDB, from: string, to: string, trust: string) {
  db.rawDb.prepare(`INSERT INTO links (from_slug, to_slug, relation, trust_state, source_type) VALUES (?, ?, 'reports_to', ?, 'agent')`).run(from, to, trust);
}

const dirs: string[] = [];
const dbs: CBrainDB[] = [];
function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "cbrain-rec-producer-"));
  dirs.push(dir);
  const db = new CBrainDB(`${dir}/db.sqlite`);
  dbs.push(db);
  const reg = new VersionedRuleRegistry();
  registerMaintenanceProducers(reg);
  return { db, reg, mgr: new RecommendationManager(db, reg) };
}

describe("known_relations producer", () => {
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

  test("abstains when no candidate edge", () => {
    const { db, mgr } = fresh();
    seed(db);
    expect(mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:00").payload.conclusion.kind).toBe("abstain");
    db.close();
  });

  test("exact evidence ref + source from def", () => {
    const { db, mgr } = fresh();
    seed(db);
    link(db, A, B, "candidate");
    const r = mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:00");
    expect(r.payload.evidence_manifest[0].ref).toBe(`health:known_relations:${A}:${B}`);
    expect(r.payload.evidence_manifest[0].source).toBe("health");
    db.close();
  });

  test("normalized slugs", () => {
    const a = fresh();
    seed(a.db);
    link(a.db, A, B, "candidate");
    const r1 = a.mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [B, A, A] }, "2026-07-12 10:00:00");
    const r2 = a.mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:01");
    expect(r1.payload.maintenance_key).toBe(r2.payload.maintenance_key);
    expect(r1.fingerprint).toBe(r2.fingerprint);
    a.db.close();
  });

  test("inactive candidate excluded", () => {
    const { db, mgr } = fresh();
    seed(db);
    link(db, A, B, "rejected");
    expect(mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:00").payload.conclusion.kind).toBe("abstain");
    db.close();
  });

  test("code_hash === definitionCodeHash; policy_version === policyHash(registry)", () => {
    const { db, reg, mgr } = fresh();
    seed(db);
    link(db, A, B, "candidate");
    const r = mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:00");
    expect(r.payload.producer.code_hash).toBe(definitionCodeHash(KNOWN_RELATIONS_DEF));
    expect(r.payload.constraints.policy_version).toBe(policyHash(reg));
    db.close();
  });

  test("upgrade keeps v1 exact-resolvable; setActive(v2) changes policy", () => {
    const a = fresh();
    seed(a.db);
    link(a.db, A, B, "candidate");
    const r1 = a.mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:00");
    const DEF_V2 = { ...KNOWN_RELATIONS_DEF, rule_version: "1.1.0", registry_ref: "cbrain.rules:maintenance.known_relations@1.1.0", abstainReason: "below_threshold" as const };
    registerVersion(a.reg, DEF_V2);
    a.reg.setActive("health:known_relations", "1.1.0");
    expect(a.reg.resolve("health:known_relations", "1.0.0").status).toBe("ok");
    expect(policyHash(a.reg)).not.toBe(r1.payload.constraints.policy_version);
    const r2 = a.mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:01");
    expect(r2.payload.producer.code_hash).not.toBe(r1.payload.producer.code_hash);
    a.db.close();
  });
});

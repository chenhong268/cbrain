import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { canonicalJson } from "../../../src/core/recommendation/canonical.js";
import { computeInputsHash } from "../../../src/core/recommendation/integrity.js";
import { RecommendationRecordReader } from "../../../src/core/recommendation/record-reader.js";
import { RecommendationStore } from "../../../src/core/recommendation/record-store.js";
import { VersionedRuleRegistry, type ResolveResult } from "../../../src/core/recommendation/registry.js";
import { replayRecord, type ExactRuleResolver } from "../../../src/core/recommendation/replay.js";
import { SCHEMA_VERSION, type DecisionInputs, type RecommendationImmutablePayload, type RuleDefinition } from "../../../src/core/recommendation/types.js";
import { CBrainDB } from "../../../src/storage/sqlite.js";

let db: CBrainDB | undefined;
let dir = "";

function rule(version: string, reason = "review relation"): RuleDefinition {
  return {
    rule_id: "rule:r",
    rule_version: version,
    registry_ref: `rules:r@${version}`,
    readTemplate: { table: "links", as: "reports_to", relation: "reports_to", direction: "outgoing", fields: ["from", "to", "trust_state"], filter: "active" },
    candidateTrustState: "candidate",
    evidenceSource: "health",
    evidenceRefTemplate: "health:r:{from}:{to}",
    abstainReason: "insufficient_evidence",
    propose: { type: "dry_run", targetTemplate: "review:{first_slug}", reason },
  };
}

function openStore(): RecommendationStore {
  dir = mkdtempSync(join(tmpdir(), "cbrain-rec-replay-"));
  db = new CBrainDB(join(dir, "brain.sqlite"));
  return new RecommendationStore(db);
}

function persistFor(store: RecommendationStore, registry: VersionedRuleRegistry, version: string) {
  const resolved = registry.resolve("rule:r", version);
  if (resolved.status !== "ok") throw new Error("test setup: runner unavailable");
  const decisionInputs: DecisionInputs = {
    signals: { candidate_count: 1 },
    entity_snapshot: { "entity/a": { reports_to: [{ from: "entity/a", to: "entity/b", trust_state: "candidate" }] } },
    evidence_refs: ["health:r:entity/a:entity/b"],
  };
  const payload: RecommendationImmutablePayload = {
    namespace: "maintenance",
    maintenance_key: "rule:r:[entity/a]",
    inputs_hash: computeInputsHash(decisionInputs),
    conclusion: resolved.runner.decide(decisionInputs),
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
    producer: { rule_id: resolved.def.rule_id, rule_version: resolved.def.rule_version, code_hash: resolved.runner.code_hash, registry_ref: resolved.def.registry_ref },
  };
  return store.createRecord(payload, "2026-07-13 10:00:00");
}

function resolverWith(registry: VersionedRuleRegistry, transform: (result: ResolveResult) => ResolveResult): ExactRuleResolver {
  return { resolve: (id, version) => transform(registry.resolve(id, version)) };
}

describe("replayRecord", () => {
  afterEach(() => {
    db?.close();
    db = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  test("returns not_found without resolving a runner", () => {
    const store = openStore();
    let resolves = 0;
    const result = replayRecord({
      store: RecommendationRecordReader.fromStore(store),
      registry: { resolve: () => { resolves++; return { status: "unavailable", reason: "unknown" }; } },
    }, "missing");
    expect(result).toEqual({ status: "not_found" });
    expect(resolves).toBe(0);
  });

  test("replays the frozen v1 runner while v2 is active and stays byte-stable", () => {
    const store = openStore();
    const registry = new VersionedRuleRegistry();
    registry.register(rule("1.0.0"));
    registry.register(rule("2.0.0", "review updated relation"));
    registry.setActive("rule:r", "2.0.0");
    const record = persistFor(store, registry, "1.0.0");
    const deps = { store: RecommendationRecordReader.fromStore(store), registry };

    const first = replayRecord(deps, record.record_id);
    const second = replayRecord(deps, record.record_id);

    expect(first).toEqual({ status: "replayed", inputs_match: true });
    expect(canonicalJson(first)).toBe(canonicalJson(second));
  });

  test.each(["purged", "incompatible"] as const)("reports exact %s tombstone", (state) => {
    const store = openStore();
    const registry = new VersionedRuleRegistry();
    registry.register(rule("1.0.0"));
    registry.register(rule("2.0.0", "review updated relation"));
    registry.setActive("rule:r", "2.0.0");
    const record = persistFor(store, registry, "1.0.0");
    if (state === "purged") registry.markPurged("rule:r", "1.0.0");
    else registry.markIncompatible("rule:r", "1.0.0");

    expect(replayRecord({ store: RecommendationRecordReader.fromStore(store), registry }, record.record_id))
      .toEqual({ status: "rule_version_unavailable", reason: state });
  });

  test("reports unknown when the exact registry has no historical version", () => {
    const store = openStore();
    const sourceRegistry = new VersionedRuleRegistry();
    sourceRegistry.register(rule("1.0.0"));
    const record = persistFor(store, sourceRegistry, "1.0.0");
    const emptyRegistry = new VersionedRuleRegistry();

    expect(replayRecord({ store: RecommendationRecordReader.fromStore(store), registry: emptyRegistry }, record.record_id))
      .toEqual({ status: "rule_version_unavailable", reason: "unknown" });
  });

  test("fails integrity before registry resolution", () => {
    const store = openStore();
    const registry = new VersionedRuleRegistry();
    registry.register(rule("1.0.0"));
    const record = persistFor(store, registry, "1.0.0");
    db!.rawDb.prepare("UPDATE recommendation_records SET fingerprint='tampered' WHERE record_id=$id").run({ $id: record.record_id });
    let resolves = 0;

    const result = replayRecord({
      store: RecommendationRecordReader.fromStore(store),
      registry: { resolve: () => { resolves++; return registry.resolve("rule:r", "1.0.0"); } },
    }, record.record_id);

    expect(result).toEqual({ status: "unverifiable", reason: "integrity_failed" });
    expect(resolves).toBe(0);
  });

  test("pins producer code_hash and registry_ref before decide", () => {
    const store = openStore();
    const registry = new VersionedRuleRegistry();
    registry.register(rule("1.0.0"));
    const record = persistFor(store, registry, "1.0.0");
    let decides = 0;
    const mismatch = resolverWith(registry, (result) => result.status === "ok"
      ? { ...result, runner: { ...result.runner, code_hash: "different", decide: (inputs) => { decides++; return result.runner.decide(inputs); } } }
      : result);

    expect(replayRecord({ store: RecommendationRecordReader.fromStore(store), registry: mismatch }, record.record_id))
      .toEqual({ status: "unverifiable", reason: "producer_mismatch" });
    expect(decides).toBe(0);
  });

  test("returns conclusion_mismatch without calling captureInputs", () => {
    const store = openStore();
    const registry = new VersionedRuleRegistry();
    registry.register(rule("1.0.0"));
    const record = persistFor(store, registry, "1.0.0");
    let captures = 0;
    const changed = resolverWith(registry, (result) => result.status === "ok"
      ? { ...result, runner: {
        ...result.runner,
        captureInputs: () => { captures++; throw new Error("capture must remain hidden"); },
        decide: () => ({ kind: "abstain", reason: "below_threshold" }),
      } }
      : result);

    expect(replayRecord({ store: RecommendationRecordReader.fromStore(store), registry: changed }, record.record_id))
      .toEqual({ status: "conclusion_mismatch" });
    expect(captures).toBe(0);
  });

  test("sanitizes runner errors to a fixed enum", () => {
    const store = openStore();
    const registry = new VersionedRuleRegistry();
    registry.register(rule("1.0.0"));
    const record = persistFor(store, registry, "1.0.0");
    const throwing = resolverWith(registry, (result) => result.status === "ok"
      ? { ...result, runner: { ...result.runner, decide: () => { throw new Error(`/private/path ${record.record_id} payload`); } } }
      : result);

    const replayed = replayRecord({ store: RecommendationRecordReader.fromStore(store), registry: throwing }, record.record_id);
    expect(replayed).toEqual({ status: "unverifiable", reason: "runner_failed" });
    expect(JSON.stringify(replayed)).not.toContain(record.record_id);
    expect(JSON.stringify(replayed)).not.toContain("private/path");
    expect(JSON.stringify(replayed)).not.toContain("payload");
  });
});

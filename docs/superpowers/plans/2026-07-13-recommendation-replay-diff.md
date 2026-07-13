# Recommendation Replay and Deterministic Diff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a read-only, offline replay core and a trusted record-to-record deterministic diff core for recommendation records.

**Architecture:** A nominal `RecommendationRecordReader` facade is the only route from `RecommendationStore` into replay/diff. `replayRecord` resolves the exact historical runner and executes only frozen inputs. `diffRecordsById` fetches both trusted records before invoking a module-private five-axis diff, with RFC 6901 keys and canonical values.

**Tech Stack:** Bun, TypeScript, SQLite via `CBrainDB`, existing recommendation canonical/integrity/registry primitives.

## Global Constraints

- No MCP, CLI, HTTP, schema migration, LLM, embedding, search, vault, or network changes.
- No modification to `RecommendationStore`; use the nominal reader facade.
- Replay never calls `captureInputs` and never falls back to the active rule version.
- Diff has no public raw-record helper; both sides must enter through trusted `getById`.
- Diff keys are RFC 6901 JSON Pointers; escape each dynamic segment independently.
- All fixtures use anonymous placeholders such as `实体A`, `实体B`, `方案C`.
- Every behavior follows RED -> verify failure -> GREEN -> focused regression.

---

### Task 1: Nominal Trusted Reader Facade

**Files:**
- Create: `src/core/recommendation/record-reader.ts`
- Create: `tests/core/recommendation/record-reader.test.ts`

**Interfaces:**
- Consumes: `RecommendationStore.getById(id)`.
- Produces: `RecommendationRecordReader.fromStore(store)` and `reader.getById(id)`.

- [ ] **Step 1: Write the failing reader tests**

Create a temporary `CBrainDB`, a real `RecommendationStore`, and assert:

```ts
const reader = RecommendationRecordReader.fromStore(store);
expect(reader.getById(record.record_id)?.record_id).toBe(record.record_id);
expect(Object.getOwnPropertyNames(RecommendationRecordReader.prototype).sort())
  .toEqual(["constructor", "getById"]);

// @ts-expect-error ordinary structural objects cannot impersonate the nominal reader
const forged: RecommendationRecordReader = { getById: () => record };
void forged;
```

- [ ] **Step 2: Verify RED**

Run: `bun test tests/core/recommendation/record-reader.test.ts`

Expected: FAIL because `record-reader.ts` does not exist.

- [ ] **Step 3: Implement the minimal facade**

```ts
import { RecommendationStore } from "./record-store.js";
import type { RecommendationRecord } from "./types.js";

export class RecommendationRecordReader {
  readonly #store: RecommendationStore;

  private constructor(store: RecommendationStore) {
    this.#store = store;
  }

  static fromStore(store: RecommendationStore): RecommendationRecordReader {
    return new RecommendationRecordReader(store);
  }

  getById(id: string): RecommendationRecord | null {
    return this.#store.getById(id);
  }
}
```

- [ ] **Step 4: Verify GREEN and commit**

Run: `bun test tests/core/recommendation/record-reader.test.ts`

Expected: PASS.

Commit: `feat(rec): add trusted read facade (#330)`

---

### Task 2: Exact-Version Frozen-Input Replay

**Files:**
- Create: `src/core/recommendation/replay.ts`
- Create: `tests/core/recommendation/replay.test.ts`

**Interfaces:**
- Consumes: `RecommendationRecordReader`, `VersionedRuleRegistry.resolve`, `canonicalJson`.
- Produces: `ReplayResult`, `ExactRuleResolver`, `ReplayDeps`, `replayRecord`.

- [ ] **Step 1: Write independent failing replay tests**

Cover each status without compound fixtures:

```ts
expect(replayRecord(deps, "missing")).toEqual({ status: "not_found" });
expect(replayRecord(depsV1, recordV1.record_id)).toEqual({ status: "replayed", inputs_match: true });
expect(replayRecord(depsPurged, recordV1.record_id)).toEqual({ status: "rule_version_unavailable", reason: "purged" });
expect(replayRecord(depsIncompatible, recordV1.record_id)).toEqual({ status: "rule_version_unavailable", reason: "incompatible" });
expect(replayRecord(depsUnknown, recordV1.record_id)).toEqual({ status: "rule_version_unavailable", reason: "unknown" });
```

Also assert: active v2 does not replace frozen v1; tampered row returns `integrity_failed` before registry resolve; code hash/ref mismatch returns `producer_mismatch`; changed deterministic conclusion returns `conclusion_mismatch`; runner throw returns only `runner_failed`; `captureInputs` call count remains zero.

- [ ] **Step 2: Verify RED**

Run: `bun test tests/core/recommendation/replay.test.ts`

Expected: FAIL because `replay.ts` does not exist.

- [ ] **Step 3: Implement the replay state machine**

```ts
export type ReplayResult =
  | { status: "not_found" }
  | { status: "replayed"; inputs_match: true }
  | { status: "rule_version_unavailable"; reason: "unknown" | "purged" | "incompatible" }
  | { status: "unverifiable"; reason: "integrity_failed" | "producer_mismatch" | "runner_failed" }
  | { status: "conclusion_mismatch" };

export function replayRecord(deps: ReplayDeps, recordId: string): ReplayResult {
  let record;
  try {
    record = deps.store.getById(recordId);
  } catch {
    return { status: "unverifiable", reason: "integrity_failed" };
  }
  if (!record) return { status: "not_found" };
  const resolved = deps.registry.resolve(record.payload.producer.rule_id, record.payload.producer.rule_version);
  if (resolved.status === "unavailable") return { status: "rule_version_unavailable", reason: resolved.reason };
  const { producer } = record.payload;
  if (resolved.runner.code_hash !== producer.code_hash
    || resolved.def.registry_ref !== producer.registry_ref
    || resolved.def.rule_id !== producer.rule_id
    || resolved.def.rule_version !== producer.rule_version) {
    return { status: "unverifiable", reason: "producer_mismatch" };
  }
  let conclusion;
  try {
    conclusion = resolved.runner.decide(record.payload.decision_inputs);
  } catch {
    return { status: "unverifiable", reason: "runner_failed" };
  }
  return canonicalJson(conclusion) === canonicalJson(record.payload.conclusion)
    ? { status: "replayed", inputs_match: true }
    : { status: "conclusion_mismatch" };
}
```

- [ ] **Step 4: Verify GREEN and commit**

Run: `bun test tests/core/recommendation/replay.test.ts tests/core/recommendation/record-reader.test.ts`

Expected: PASS.

Commit: `feat(rec): replay frozen recommendations exactly (#330)`

---

### Task 3: Trusted Diff Envelope and Five-Axis Scalar Semantics

**Files:**
- Create: `src/core/recommendation/diff.ts`
- Create: `tests/core/recommendation/diff.test.ts`

**Interfaces:**
- Consumes: `RecommendationRecordReader`, `RecommendationRecord`, `canonicalJson`.
- Produces: `DiffAxis`, `DiffChange`, `DiffEntry`, `DiffOutcome`, `diffRecordsById`.

- [ ] **Step 1: Write failing trust/envelope tests**

Test missing/corrupt A and B separately, incomparable namespace/key, mutable-only changes, and runtime exports:

```ts
expect(await import("../../../src/core/recommendation/diff.js").then(Object.keys))
  .toEqual(["diffRecordsById"]);
expect(diffRecordsById(reader, missing, valid)).toEqual({ ok: false, reason: "not_found" });
expect(diffRecordsById(reader, corrupt, valid)).toEqual({ ok: false, reason: "integrity_failed" });
expect(diffRecordsById(reader, namespaceA, namespaceB)).toEqual({ ok: false, reason: "incomparable" });
```

- [ ] **Step 2: Verify RED**

Run: `bun test tests/core/recommendation/diff.test.ts`

Expected: FAIL because `diff.ts` does not exist.

- [ ] **Step 3: Implement trusted fetch, pointer encoding, entry ordering**

```ts
const AXIS_ORDER = { evidence: 0, constraint: 1, option: 2, dependency: 3, conclusion: 4 } as const;
const CHANGE_ORDER = { added: 0, changed: 1, removed: 2 } as const;

function escapePointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function pointer(...segments: string[]): string {
  return `/${segments.map(escapePointerSegment).join("/")}`;
}

export function diffRecordsById(reader: RecommendationRecordReader, idA: string, idB: string): DiffOutcome {
  let a;
  let b;
  try {
    a = reader.getById(idA);
    if (!a) return { ok: false, reason: "not_found" };
    b = reader.getById(idB);
    if (!b) return { ok: false, reason: "not_found" };
  } catch {
    return { ok: false, reason: "integrity_failed" };
  }
  return diffTrustedRecords(a, b);
}
```

Implement module-private helpers for scalar changes, set changes, dedup by full five-tuple, and full sorting. First cover `constraint`, `option`, and `conclusion`; cross-kind emits kind/action removals/reason additions.

- [ ] **Step 4: Verify GREEN and commit**

Run: `bun test tests/core/recommendation/diff.test.ts`

Expected: trust/envelope, scalar axes, cross-kind, same-value/different-key, and order tests PASS.

Commit: `feat(rec): add trusted deterministic recommendation diff (#330)`

---

### Task 4: Evidence and Dependency Field-Level Diff

**Files:**
- Modify: `src/core/recommendation/diff.ts`
- Modify: `tests/core/recommendation/diff.test.ts`

**Interfaces:**
- Extends module-private `diffTrustedRecords` without changing public exports.

- [ ] **Step 1: Write failing per-structure tests**

Use one fixture per behavior: evidence trust-state flip; signals key; entity snapshot slug/as; evidence ref; inspected claim; declaration add/remove/change; all array/object reorder no-op cases.

- [ ] **Step 2: Verify RED**

Run: `bun test tests/core/recommendation/diff.test.ts`

Expected: new evidence/dependency assertions FAIL while Task 3 tests remain green.

- [ ] **Step 3: Implement field-level maps**

Normalize each set to `Map<stablePointer, canonicalValue>`. Use these key forms exactly:

```ts
pointer("evidence_manifest", entry.source, entry.ref)
pointer("decision_inputs", "signals", signalKey)
pointer("decision_inputs", "entity_snapshot", slug, as)
pointer("decision_inputs", "evidence_refs", ref)
pointer("decision_inputs", "inspected_claims", claim)
declaration.slug === undefined
  ? pointer("dependency_manifest", "declarations", "global", declaration.as)
  : pointer("dependency_manifest", "declarations", "slug", declaration.slug, declaration.as)
```

Skip decision-input descent when `inputs_hash` is equal. Always compare declarations independently.

- [ ] **Step 4: Verify GREEN and commit**

Run: `bun test tests/core/recommendation/diff.test.ts tests/core/recommendation/integrity.test.ts`

Expected: PASS.

Commit: `feat(rec): explain evidence and dependency changes (#330)`

---

### Task 5: Adversarial Boundaries and Read-Only Proof

**Files:**
- Modify: `tests/core/recommendation/replay.test.ts`
- Modify: `tests/core/recommendation/diff.test.ts`
- Modify: `tests/core/recommendation/record-reader.test.ts`

**Interfaces:**
- No production API changes unless an attack proves a defect.

- [ ] **Step 1: Add separator collision attacks**

Use dynamic segments containing `.`, `:`, `::`, `[]`, `/`, and `~`. Assert distinct keys, correct `~0`/`~1` encoding, and no remove/add collapse into changed.

- [ ] **Step 2: Add version/integrity/error attacks**

Independently attack active-version substitution, self-consistent producer tamper, hidden `captureInputs`, partial diff, error text leakage, and repeated-call nondeterminism.

- [ ] **Step 3: Add read-only proof**

Before and after replay/diff, capture:

```ts
const totalChanges = db.rawDb.prepare("SELECT total_changes() AS n").get() as { n: number };
const records = db.rawDb.prepare("SELECT * FROM recommendation_records ORDER BY rowid").all();
const history = db.rawDb.prepare("SELECT * FROM recommendation_lifecycle_history ORDER BY rowid").all();
const policy = registry.policyManifest();
const audit = registry.registryAuditManifest();
```

Assert exact equality. Source-scan `replay.ts`/`diff.ts` imports and forbidden tokens; snapshot a temporary untouched Lance directory by relative names/mtime/size.

- [ ] **Step 4: Run focused adversarial suite**

Run: `bun test tests/core/recommendation/record-reader.test.ts tests/core/recommendation/replay.test.ts tests/core/recommendation/diff.test.ts`

Expected: all attacks PASS with no warnings.

- [ ] **Step 5: Commit**

Commit: `test(rec): adversarially verify replay and diff (#330)`

---

### Task 6: Full Verification and Spec Coverage Audit

**Files:**
- Modify only if a verified gate or audit finding requires a scoped correction.

- [ ] **Step 1: Run focused and adjacent suites**

Run: `bun test tests/core/recommendation/`

Expected: 0 failures.

- [ ] **Step 2: Run static gates**

Run: `bun run lint && bun run check:docs && git diff --check`

Expected: exit 0.

- [ ] **Step 3: Run full gate**

Run: `bun run check`

Expected: exit 0, 0 failed tests.

- [ ] **Step 4: Perform five-point adversarial self-review**

Verify with code and tests:

1. no exported raw-record diff path;
2. no active-version fallback or `captureInputs` call;
3. no dynamic path collision;
4. no partial diff/error leakage;
5. no DB/registry/Lance side effect.

- [ ] **Step 5: Privacy and scope audit**

Run a diff-only scan for local paths, real names, credentials, and non-anonymous fixtures. Confirm only spec/plan, three source modules, and three test modules changed.

- [ ] **Step 6: Commit any verified corrections separately**

Commit format: `fix(rec): address replay diff adversarial review (#330)`.

Do not push or close #330 during implementation handoff.


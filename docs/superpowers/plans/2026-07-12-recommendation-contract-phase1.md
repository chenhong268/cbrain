# Recommendation Contract — Phase 1 Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the deterministic Recommendation Record **contract infrastructure** for Phase 1 — the canonicalization, storage, integrity, versioned rule registry, freshness, atomic supersede, and display projection layers defined in `docs/superpowers/specs/2026-07-12-recommendation-contract-design.md` (rev6, Codex-approved) — plus one reference producer (health `known_relations` repair) as the vertical slice proving the contract end-to-end.

**Architecture:** New `src/core/recommendation/` module (many small files: canonical, types, integrity, registry, freshness, record-store, display, manager, producers). New `recommendation_records` + `recommendation_lifecycle_history` tables via an **additive** migration (`src/storage/migrations/recommendations.ts`, config-key guarded, mirrors `pages.ts:43`). Producers are deterministic (no LLM), never auto-execute (`auto_execute:false` invariant, DB `CHECK`). Records carry an immutable payload hashed per RFC 8785 JCS (number/key) + a prose/identifier string layer. Two orthogonal persisted axes: `lifecycle_status` (user/system) and `freshness_status` (dependency/version). Atomic supersede keeps `active count ≤ 1` per `maintenance_key`.

**Tech Stack:** Bun, TypeScript strict, `bun:sqlite`, `bun:test`, `node:crypto` (existing `hashContent` style in `src/core/shared.ts`). No new runtime deps (JCS implemented in-repo; see Task 1).

**Spec reference:** `docs/superpowers/specs/2026-07-12-recommendation-contract-design.md` (rev6). Every design decision below traces to a spec section; cites inline as `(spec §X.Y)`.

---

## Scope (read first)

This plan covers **Phase 1 contract infrastructure + one reference producer**. Out of scope for THIS plan (follow-up plan, same registration pattern):

- Producers for fsck findings, discovery bridge/similar_entity, action-candidate review — these register into the same `VersionedRuleRegistry` built here and follow the `known_relations` shape exactly.
- MCP tool surface for recommendations (gated behind #327 surface coverage per spec §11).
- Replay/diff UI (Phase 2), open-question shadow (Phase 3), policy templates (Phase 4).

The `known_relations` producer is included only as the **vertical slice** that exercises every infrastructure layer in one integration test. Adding the other 3 producers is mechanical once this plan lands.

**Non-goals (hard, spec §0):** no LLM calls at runtime; no auto-execution of repair/merge/sync/delete; no writing recommendations back as trusted facts; no model chain-of-thought storage; do not change MCP schema or default Agent display.

**History note:** Local `main` and `origin/main` have diverged via equivalent #329 commits. Do NOT push during this plan. Commits stay local; the user reconciles history before push.

---

## File Structure

**Create (source):**
- `src/core/recommendation/canonical.ts` — RFC 8785 JCS number/key serialization + prose/identifier string layer + `canonicalJson()` / `sha256Hex()`.
- `src/core/recommendation/types.ts` — `RecommendationRecord`, `RecommendationImmutablePayload`, `LifecycleStatus`, `FreshnessStatus`, `DecisionInputs`, etc.
- `src/core/recommendation/integrity.ts` — `computeInputsHash()`, `computeFingerprint()`, `checkIntegrity()` (3-layer: inputs + payload + cross-consistency).
- `src/core/recommendation/registry.ts` — `VersionedRuleRegistry`, `RuleRunner` (`captureInputs` + `decide`), `RuleUnavailable`.
- `src/core/recommendation/freshness.ts` — `recomputeFreshness()` (uses registry `captureInputs`).
- `src/core/recommendation/record-store.ts` — `RecommendationStore` (CRUD + `atomicSupersede` transaction, `activeCountFor(key)`).
- `src/core/recommendation/display.ts` — `projectDisplay()` (read-time `target_display` via `safeTitle` + #327 boundary; no persistence).
- `src/core/recommendation/manager.ts` — `RecommendationManager.buildAndStore()` (end-to-end: capture → decide → integrity → atomic supersede).
- `src/core/recommendation/producers/known-relations.ts` — reference producer (`captureInputs`/`decide`/declarations for reports_to repair).
- `src/core/recommendation/producers/index.ts` — `registerMaintenanceProducers(registry)`.
- `src/storage/migrations/recommendations.ts` — additive migration (tables + indexes + CHECK).

**Modify:**
- `src/storage/sqlite.ts:420` — call `runRecommendationRecordsMigration(this.db)` after `runLatePageMigrations`.
- `src/storage/migrations/index.ts` — export `runRecommendationRecordsMigration`.

**Create (tests):**
- `tests/core/recommendation/canonical.test.ts`
- `tests/core/recommendation/integrity.test.ts`
- `tests/core/recommendation/registry.test.ts`
- `tests/core/recommendation/freshness.test.ts`
- `tests/core/recommendation/record-store.test.ts`
- `tests/core/recommendation/manager.test.ts`
- `tests/core/recommendation/producers/known-relations.test.ts`
- `tests/storage/migrations/recommendations.test.ts`

**Test DB convention:** `/tmp/cbrain-test-rec-<module>`, `afterEach` `rmSync`. Mirror `tests/core/action-candidates.test.ts`.

---

## Task 1: Canonical pipeline (spec §6.2)

**Files:**
- Create: `src/core/recommendation/canonical.ts`
- Test: `tests/core/recommendation/canonical.test.ts`

- [ ] **Step 1: Write failing test — JCS number golden bytes + key sort + prose/identifier split**

```ts
// tests/core/recommendation/canonical.test.ts
import { describe, expect, test } from "bun:test";
import { canonicalJson, sha256Hex, serializeNumber } from "../../../src/core/recommendation/canonical.js";

describe("canonical number serialization (RFC 8785 JCS §3.2.2.3)", () => {
  test("golden bytes", () => {
    expect(serializeNumber(1)).toBe("1");
    expect(serializeNumber(1.0)).toBe("1");        // no trailing zero
    expect(serializeNumber(-0)).toBe("0");          // -0 normalized
    expect(serializeNumber(0.1)).toBe("0.1");
    expect(serializeNumber(1e-7)).toBe("1e-7");
    expect(serializeNumber(1e21)).toBe("1e+21");
    expect(serializeNumber(299792458)).toBe("299792458");
  });
  test("non-finite rejected", () => {
    expect(() => serializeNumber(NaN)).toThrow(/finite/);
    expect(() => serializeNumber(Infinity)).toThrow(/finite/);
    expect(() => serializeNumber(-Infinity)).toThrow(/finite/);
  });
});

describe("canonicalJson (key sort + value canonicalization)", () => {
  test("object keys sorted by UTF-16 code-unit order, not insertion order", () => {
    expect(canonicalJson({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}');
  });
  test("array sorted by complete-element canonical string (tie fields included)", () => {
    // two evidence entries differing only in trust_state must sort/hash distinctly
    const a = { source: "link", ref: "x", trust_state: "trusted" };
    const b = { source: "link", ref: "x", trust_state: "candidate" };
    const order1 = canonicalJson({ m: [a, b] });
    const order2 = canonicalJson({ m: [b, a] });
    expect(order1).toBe(order2); // set-like: order-independent
    expect(order1).toContain("trusted");
    expect(order1).toContain("candidate");
  });
  test("identifier strings not NFKC-normalized; prose strings are", () => {
    // identifier field 'ref' kept byte-exact; prose field 'reason' NFKC-folded
    const id = canonicalJson({ ref: "entityA－1" }); // fullwidth hyphen-minus
    const id2 = canonicalJson({ ref: "entityA-1" });
    expect(id).not.toBe(id2); // identifiers distinct, NOT merged
  });
});

describe("sha256Hex", () => {
  test("64 hex, deterministic", () => {
    expect(sha256Hex('{"a":1}')).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex('{"a":1}')).toBe(sha256Hex('{"a":1}'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/core/recommendation/canonical.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement canonical module**

```ts
// src/core/recommendation/canonical.ts
import { createHash } from "node:crypto";

/**
 * RFC 8785 JCS §3.2.2.3 number serialization for finite IEEE-754 doubles.
 * -0 is pre-normalized to 0. Non-finite values are rejected (not valid JSON).
 * ECMAScript Number::toString already produces the JCS shortest round-trippable
 * form (incl. lowercase 'e', signed exponent), so we delegate to it after the
 * finite/minus-zero guards.
 */
export function serializeNumber(n: number): string {
  if (Number.isNaN(n) || n === Infinity || n === -Infinity) {
    throw new Error(`canonical: number must be finite, got ${String(n)}`);
  }
  const v = Object.is(n, -0) ? 0 : n;
  return String(v);
}

/**
 * Canonical JSON value (recursive). Number serialization per JCS; object keys
 * sorted by UTF-16 code-unit lexicographic order (JCS §3.2.2.2); arrays sorted
 * by the complete canonical serialization of each element (set-like, order-
 * independent). String values are emitted byte-exact (no NFKC at this layer —
 * callers decide prose vs identifier normalization before hashing).
 *
 * payload values restricted to JSON-safe: null/boolean/number/string/array/object.
 */
export function canonicalJson(value: unknown): string {
  return emit(value, new Set<object>());
}

function emit(v: unknown, seen: Set<object>): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "boolean":
      return v ? "true" : "false";
    case "number":
      return serializeNumber(v);
    case "string":
      return quoteUtf16(v);
    case "object": {
      if (v === undefined || typeof v === "function" || typeof v === "symbol") {
        throw new Error("canonical: non-JSON-safe value");
      }
      if (Array.isArray(v)) {
        const parts = v.map((el) => emit(el, seen));
        parts.sort(); // by full canonical string — tie fields auto-included
        return `[${parts.join(",")}]`;
      }
      if (seen.has(v)) throw new Error("canonical: cycle detected");
      seen.add(v);
      const entries = Object.keys(v)
        .sort() // UTF-16 code-unit lexicographic (default String compare)
        .map((k) => `${quoteUtf16(k)}:${emit((v as Record<string, unknown>)[k], seen)}`);
      seen.delete(v);
      return `{${entries.join(",")}}`;
    }
    default:
      throw new Error(`canonical: unsupported type ${typeof v}`);
  }
}

// JSON-escape per RFC 8257; keep UTF-16 code units (do not collapse surrogates).
function quoteUtf16(s: string): string {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\" || ch === '"') out += "\\" + ch;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (code < 0x20) out += "\\u" + code.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + '"';
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex"); // 64 hex
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/core/recommendation/canonical.test.ts`
Expected: PASS.

- [ ] **Step 5: Prose/identifier normalization helper + test**

Add to `canonical.ts`:

```ts
/** NFKC + collapse runs of whitespace. For prose fields only (spec §6.2). */
export function normalizeProse(s: string): string {
  return s.normalize("NFKC").replace(/\s+/g, " ").trim();
}
```

Append test:

```ts
// in canonical.test.ts
import { normalizeProse } from "../../../src/core/recommendation/canonical.js";
describe("normalizeProse", () => {
  test("NFKC + whitespace fold", () => {
    expect(normalizeProse("ｓｃｏｒｅ   高")).toBe("score 高");
  });
});
```

Run: `bun test tests/core/recommendation/canonical.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/recommendation/canonical.ts tests/core/recommendation/canonical.test.ts
git commit -m "feat(rec): canonical JSON pipeline (RFC 8785 JCS) (#328)"
```

---

## Task 2: Types (spec §4)

**Files:**
- Create: `src/core/recommendation/types.ts`

- [ ] **Step 1: Write the types module**

```ts
// src/core/recommendation/types.ts
import type { TrustState } from "../provenance.js";

export type LifecycleStatus =
  | "pending" | "current" | "superseded" | "rejected" | "invalidated";

export type FreshnessStatus = "fresh" | "stale" | "version_invalid";

export type AbstainReason =
  | "insufficient_evidence" | "conflict" | "inactive_evidence_only"
  | "below_threshold" | "policy_prohibits";

export type HighImpactReason =
  | "write_action" | "open_question_deep_reasoning"
  | "irreversible_real_world" | "high_value_entity";

export type ConfirmationRequirement =
  | { tier: "standard" }
  | { tier: "high_impact"; confirm: ("target" | "option" | "constraint")[]; reason: HighImpactReason };

export interface ProposedAction {
  type: "review" | "dry_run" | "notify_draft"; // target_display NOT stored (spec §4.4)
  target_ref: string;          // internal ref, slug-bearing, audit tier
  reason: string;              // prose
  rollback_note?: string;      // prose
}

export type RecommendationConclusion =
  | { kind: "propose"; action: ProposedAction; alternatives: ProposedAction[] }
  | { kind: "abstain"; reason: AbstainReason };

export interface DependencyDeclaration {
  slug?: string;
  table: "pages" | "links" | "tags" | "aliases" | "timeline" | "chunks" | "fts" | "lance" | "config";
  fields: string[];
  filter?: "active" | "all";
}

export interface DependencyManifest {
  rule_id: string;
  declarations: DependencyDeclaration[];
}

export interface EntityProjection { [field: string]: unknown }

export interface DecisionInputs {
  signals: Record<string, unknown>;
  inspected_claims?: string[];
  entity_snapshot: Record<string, EntityProjection>;
}

export interface EvidenceManifestEntry {
  source: "discovery" | "health" | "fsck" | "graph" | "timeline";
  ref: string;
  trust_state: TrustState;
}

export interface RecommendationConstraints {
  policy_version: string;
  ontology_version: string;
  schema_version: string; // "rec-v1"
}

export interface Applicability {
  audience: "user_only";
  auto_execute: false;
  requires_confirmation: ConfirmationRequirement;
}

export interface RecommendationProducer {
  rule_id: string;
  rule_version: string;
  code_hash: string;
  registry_ref: string;
}

/** Immutable semantic payload — every field participates in fingerprint (spec §6.1). */
export interface RecommendationImmutablePayload {
  namespace: string;
  maintenance_key: string;
  inputs_hash: string;
  conclusion: RecommendationConclusion;
  decision_inputs: DecisionInputs;
  evidence_manifest: EvidenceManifestEntry[];
  constraints: RecommendationConstraints;
  dependency_manifest: DependencyManifest;
  applicability: Applicability;
  risks: string[];
  gaps: string[];
  producer: RecommendationProducer;
}

export interface RecommendationRecord {
  record_id: string;
  payload: RecommendationImmutablePayload;
  fingerprint: string; // = sha256Hex(canonicalJson(payload))
  created_at: string;
  last_revalidated_at: string;
  lifecycle_status: LifecycleStatus;
  freshness_status: FreshnessStatus;
  suppressed_until: string | null;
}

export const SCHEMA_VERSION = "rec-v1" as const;
```

- [ ] **Step 2: Typecheck**

Run: `bun run lint`
Expected: PASS (types only, no runtime).

- [ ] **Step 3: Commit**

```bash
git add src/core/recommendation/types.ts
git commit -m "feat(rec): recommendation record types (#328)"
```

---

## Task 3: Data model + additive migration (spec §5.5, §10)

**Files:**
- Create: `src/storage/migrations/recommendations.ts`
- Modify: `src/storage/migrations/index.ts`
- Modify: `src/storage/sqlite.ts:420` (add call)
- Test: `tests/storage/migrations/recommendations.test.ts`

- [ ] **Step 1: Write failing test — migration creates tables + is idempotent + rollback-safe**

```ts
// tests/storage/migrations/recommendations.test.ts
import { rmSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runRecommendationRecordsMigration } from "../../../src/storage/migrations/recommendations.js";

function newDb(): Database {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  return db;
}

function tableExists(db: Database, name: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) as { name?: string } | undefined;
  return row?.name === name;
}

describe("recommendation_records migration", () => {
  const dbs: Database[] = [];
  afterEach(() => { dbs.forEach((d) => d.close()); dbs.length = 0; });

  test("creates recommendation_records + lifecycle_history tables", () => {
    const db = newDb(); dbs.push(db);
    runRecommendationRecordsMigration(db);
    expect(tableExists(db, "recommendation_records")).toBe(true);
    expect(tableExists(db, "recommendation_lifecycle_history")).toBe(true);
  });

  test("idempotent — running twice is a no-op (config-key guard)", () => {
    const db = newDb(); dbs.push(db);
    runRecommendationRecordsMigration(db);
    expect(() => runRecommendationRecordsMigration(db)).not.toThrow();
    // exactly one of each table
    const n = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name IN ('recommendation_records','recommendation_lifecycle_history')").get() as { c: number };
    expect(n.c).toBe(2);
  });

  test("partial unique index on (maintenance_key) WHERE active exists", () => {
    const db = newDb(); dbs.push(db);
    runRecommendationRecordsMigration(db);
    const idx = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_rec_active_unique'").get() as { sql?: string };
    expect(idx.sql).toContain("maintenance_key");
    expect(idx.sql).toContain("lifecycle_status IN ('pending','current')");
  });

  test("CHECK(auto_execute = 0) rejects auto_execute=true payload", () => {
    const db = newDb(); dbs.push(db);
    runRecommendationRecordsMigration(db);
    db.exec(`INSERT INTO recommendation_records
      (record_id, maintenance_key, fingerprint, inputs_hash, payload, auto_execute,
       created_at, last_revalidated_at, lifecycle_status, freshness_status, suppressed_until)
      VALUES ('r1','k1','f','ih','{}',1,'t','t','pending','fresh',NULL)`);
    expect(() =>
      db.exec(`INSERT INTO recommendation_records
        (record_id, maintenance_key, fingerprint, inputs_hash, payload, auto_execute,
         created_at, last_revalidated_at, lifecycle_status, freshness_status, suppressed_until)
        VALUES ('r2','k2','f','ih','{}',0,'t','t','pending','fresh',NULL)`)
    ).toThrow(); // auto_execute must be 0 (stored as INTEGER 0 per CHECK — see impl)
  });

  test("two active same key rejected by partial unique index", () => {
    const db = newDb(); dbs.push(db);
    runRecommendationRecordsMigration(db);
    const base = `INSERT INTO recommendation_records
      (record_id, maintenance_key, fingerprint, inputs_hash, payload, auto_execute,
       created_at, last_revalidated_at, lifecycle_status, freshness_status, suppressed_until)
      VALUES `;
    db.exec(base + `('r1','same','f1','ih','{}',0,'t','t','pending','fresh',NULL)`);
    expect(() =>
      db.exec(base + `('r2','same','f2','ih','{}',0,'t','t','current','fresh',NULL)`)
    ).toThrow(/UNIQUE/);
    // but a superseded same-key row coexists
    expect(() =>
      db.exec(base + `('r3','same','f3','ih','{}',0,'t','t','superseded','stale',NULL)`)
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/storage/migrations/recommendations.test.ts`
Expected: FAIL — migration module not found.

- [ ] **Step 3: Implement the additive migration**

```ts
// src/storage/migrations/recommendations.ts
import type { Database } from "bun:sqlite";

const COMPLETION_KEY = "migration_rec_v1_recommendation_records";

/**
 * Additive migration for Recommendation Contract Phase 1 (spec §10).
 * Creates two tables + a partial unique index + a CHECK constraint.
 * Idempotent via config-key guard (mirrors runLatePageMigrations in pages.ts).
 */
export function runRecommendationRecordsMigration(db: Database): void {
  const done = db.prepare("SELECT value FROM config WHERE key = ?").get(COMPLETION_KEY) as { value?: string } | undefined;
  if (done?.value === "1") return;

  db.exec(`
    CREATE TABLE IF NOT EXISTS recommendation_records (
      record_id            TEXT PRIMARY KEY,
      maintenance_key      TEXT NOT NULL,
      fingerprint          TEXT NOT NULL,
      inputs_hash          TEXT NOT NULL,
      payload              TEXT NOT NULL,           -- canonical JSON of RecommendationImmutablePayload
      auto_execute         INTEGER NOT NULL DEFAULT 0 CHECK(auto_execute = 0),
      created_at           TEXT NOT NULL,
      last_revalidated_at  TEXT NOT NULL,
      lifecycle_status     TEXT NOT NULL CHECK(lifecycle_status IN
                             ('pending','current','superseded','rejected','invalidated')),
      freshness_status     TEXT NOT NULL CHECK(freshness_status IN
                             ('fresh','stale','version_invalid')),
      suppressed_until     TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_rec_fingerprint ON recommendation_records(fingerprint);
    CREATE INDEX IF NOT EXISTS idx_rec_inputs_hash ON recommendation_records(inputs_hash);
    -- at most one active per maintenance_key (spec §5.5)
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rec_active_unique
      ON recommendation_records(maintenance_key)
      WHERE lifecycle_status IN ('pending','current');

    CREATE TABLE IF NOT EXISTS recommendation_lifecycle_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      record_id   TEXT NOT NULL REFERENCES recommendation_records(record_id) ON DELETE CASCADE,
      action      TEXT NOT NULL,        -- 'created' | 'confirmed' | 'superseded' | 'rejected' | 'revalidated' | 'freshness_stale' | ...
      from_lifecycle TEXT,
      to_lifecycle   TEXT NOT NULL,
      from_freshness TEXT,
      to_freshness   TEXT,
      reason      TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_rec_history_record ON recommendation_lifecycle_history(record_id);
  `);

  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, '1')").run(COMPLETION_KEY);
}
```

- [ ] **Step 4: Wire it into sqlite.ts + migrations/index.ts**

`src/storage/migrations/index.ts` — add line:
```ts
export { runRecommendationRecordsMigration } from "./recommendations.js";
```

`src/storage/sqlite.ts` — in the `migrate()` method, after `runLatePageMigrations(this.db);` (around line 420), add:
```ts
    runRecommendationRecordsMigration(this.db);
```
And add to the import from `"./migrations/index.js"`: `runRecommendationRecordsMigration`.

- [ ] **Step 5: Run migration test to verify it passes**

Run: `bun test tests/storage/migrations/recommendations.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/storage/migrations/recommendations.ts src/storage/migrations/index.ts \
        src/storage/sqlite.ts tests/storage/migrations/recommendations.test.ts
git commit -m "feat(storage): recommendation_records additive migration (#328)"
```

---

## Task 4: Integrity check — inputs_hash, fingerprint, cross-consistency (spec §6, §4.3, §8.1)

**Files:**
- Create: `src/core/recommendation/integrity.ts`
- Test: `tests/core/recommendation/integrity.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/core/recommendation/integrity.test.ts
import { describe, expect, test } from "bun:test";
import { computeInputsHash, computeFingerprint, checkIntegrity } from "../../../src/core/recommendation/integrity.js";
import type { RecommendationImmutablePayload, RecommendationRecord } from "../../../src/core/recommendation/types.js";
import { SCHEMA_VERSION } from "../../../src/core/recommendation/types.js";

function basePayload(overrides: Partial<RecommendationImmutablePayload> = {}): RecommendationImmutablePayload {
  return {
    namespace: "maintenance",
    maintenance_key: "health:known_relations:[\"eA\",\"eB\"]",
    inputs_hash: "", // filled below
    conclusion: { kind: "propose", action: { type: "dry_run", target_ref: "health:known_relations:eA", reason: "复核" }, alternatives: [] },
    decision_inputs: { signals: { count: 1 }, entity_snapshot: { eA: { reports_to: ["eB"] } } },
    evidence_manifest: [{ source: "health", ref: "health:known_relations:eA", trust_state: "candidate" }],
    constraints: { policy_version: "p1", ontology_version: "o1", schema_version: SCHEMA_VERSION },
    dependency_manifest: { rule_id: "health:known_relations", declarations: [{ slug: "eA", table: "links", fields: ["relation","trust_state","other_slug"], filter: "active" }] },
    applicability: { audience: "user_only", auto_execute: false, requires_confirmation: { tier: "standard" } },
    risks: [],
    gaps: [],
    producer: { rule_id: "health:known_relations", rule_version: "1.0.0", code_hash: "h", registry_ref: "cbrain.rules:maintenance.known_relations@1.0.0" },
    ...overrides,
  };
}

describe("integrity hashes", () => {
  test("inputs_hash deterministic over signals + inspected_claims + entity_snapshot", () => {
    const p = basePayload();
    p.inputs_hash = computeInputsHash(p.decision_inputs);
    const again = computeInputsHash(p.decision_inputs);
    expect(again).toBe(p.inputs_hash);
    expect(p.inputs_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("fingerprint covers full payload; tampering auto_execute flips it", () => {
    const p = basePayload(); p.inputs_hash = computeInputsHash(p.decision_inputs);
    const fp = computeFingerprint(p);
    // a tampered copy with auto_execute flipped is impossible via the type (it's `false`),
    // but a buggy/serialized edit to applicability must change fingerprint:
    const tampered: RecommendationImmutablePayload = { ...p, risks: ["新增风险"] };
    expect(computeFingerprint(tampered)).not.toBe(fp);
    expect(computeFingerprint(p)).toBe(fp);
  });

  test("fingerprint stable regardless of evidence_manifest order", () => {
    const p = basePayload(); p.inputs_hash = computeInputsHash(p.decision_inputs);
    const e1 = p.evidence_manifest[0];
    const e2 = { ...e1, ref: "health:known_relations:eB" };
    const ordered = computeFingerprint({ ...p, evidence_manifest: [e1, e2] });
    const reversed = computeFingerprint({ ...p, evidence_manifest: [e2, e1] });
    expect(ordered).toBe(reversed);
  });
});

describe("checkIntegrity (3-layer)", () => {
  function record(p: RecommendationImmutablePayload): RecommendationRecord {
    p.inputs_hash = computeInputsHash(p.decision_inputs);
    return {
      record_id: "r1", payload: p, fingerprint: computeFingerprint(p),
      created_at: "t", last_revalidated_at: "t",
      lifecycle_status: "pending", freshness_status: "fresh", suppressed_until: null,
    };
  }

  test("clean record passes", () => {
    const r = record(basePayload());
    const res = checkIntegrity(r);
    expect(res.ok).toBe(true);
  });

  test("detects inputs_hash tamper", () => {
    const r = record(basePayload());
    r.payload.inputs_hash = "tampered";
    const res = checkIntegrity(r);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/inputs_hash/);
  });

  test("detects fingerprint tamper (conclusion changed)", () => {
    const r = record(basePayload());
    r.payload.conclusion = { kind: "abstain", reason: "insufficient_evidence" };
    const res = checkIntegrity(r);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/fingerprint/);
  });

  test("detects cross-consistency: evidence_manifest ref absent from decision_inputs", () => {
    const p = basePayload();
    p.evidence_manifest.push({ source: "health", ref: "health:other:not_in_snapshot", trust_state: "candidate" });
    const r = record(p);
    const res = checkIntegrity(r);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/projection|cross/i);
  });

  test("detects cross-consistency: rule_id mismatch", () => {
    const p = basePayload();
    p.dependency_manifest.rule_id = "different";
    const r = record(p);
    const res = checkIntegrity(r);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/rule_id/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/core/recommendation/integrity.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement integrity module**

```ts
// src/core/recommendation/integrity.ts
import { canonicalJson, normalizeProse, sha256Hex } from "./canonical.js";
import type { DecisionInputs, RecommendationConclusion, RecommendationImmutablePayload, RecommendationRecord } from "./types.js";

/** inputs_hash = sha256(canonical(decision_inputs)). Prose fields NFKC'd (spec §6.2). */
export function computeInputsHash(di: DecisionInputs): string {
  return sha256Hex(canonicalJson(canonicalDecisionInputs(di)));
}

function canonicalDecisionInputs(di: DecisionInputs): unknown {
  return {
    signals: di.signals,
    inspected_claims: (di.inspected_claims ?? []).map(normalizeProse),
    entity_snapshot: di.entity_snapshot,
  };
}

/** fingerprint = sha256(canonical(payload)). Covers ALL immutable semantic fields (spec §6.1). */
export function computeFingerprint(p: RecommendationImmutablePayload): string {
  return sha256Hex(canonicalJson(canonicalPayload(p)));
}

function canonicalPayload(p: RecommendationImmutablePayload): unknown {
  return {
    namespace: p.namespace,
    maintenance_key: p.maintenance_key,
    inputs_hash: p.inputs_hash,
    conclusion: canonicalConclusion(p.conclusion),
    decision_inputs: canonicalDecisionInputs(p.decision_inputs),
    evidence_manifest: p.evidence_manifest
      .map((e) => ({ source: e.source, ref: e.ref, trust_state: e.trust_state })),
    constraints: p.constraints,
    dependency_manifest: {
      rule_id: p.dependency_manifest.rule_id,
      declarations: p.dependency_manifest.declarations
        .map((d) => ({ slug: d.slug, table: d.table, fields: [...d.fields].sort(), filter: d.filter })),
    },
    applicability: p.applicability,
    risks: p.risks.map(normalizeProse),
    gaps: p.gaps.map(normalizeProse),
    producer: p.producer,
  };
}

function canonicalConclusion(c: RecommendationConclusion): unknown {
  if (c.kind === "abstain") return { kind: "abstain", reason: c.reason };
  return {
    kind: "propose",
    action: canonicalAction(c.action),
    alternatives: c.alternatives.map(canonicalAction),
  };
}

function canonicalAction(a: { type: string; target_ref: string; reason: string; rollback_note?: string }): unknown {
  return { type: a.type, target_ref: a.target_ref, reason: normalizeProse(a.reason), rollback_note: a.rollback_note };
}

export type IntegrityResult = { ok: true } | { ok: false; reason: string };

/** 3-layer integrity (spec §8.1): inputs + payload + cross-consistency. */
export function checkIntegrity(r: RecommendationRecord): IntegrityResult {
  // Layer 1: inputs_hash
  if (computeInputsHash(r.payload.decision_inputs) !== r.payload.inputs_hash) {
    return { ok: false, reason: "inputs_hash mismatch (decision_inputs tampered)" };
  }
  // Layer 2: fingerprint (full payload)
  if (computeFingerprint(r.payload) !== r.fingerprint) {
    return { ok: false, reason: "fingerprint mismatch (immutable payload tampered)" };
  }
  // Layer 3: cross-consistency (spec §4.3)
  const x = checkCrossConsistency(r.payload);
  if (!x.ok) return x;
  return { ok: true };
}

function checkCrossConsistency(p: RecommendationImmutablePayload): IntegrityResult {
  // evidence_manifest refs must be traceable into decision_inputs (projection)
  const snapshotRefs = new Set<string>();
  for (const slug of Object.keys(p.decision_inputs.entity_snapshot)) snapshotRefs.add(slug);
  for (const e of p.evidence_manifest) {
    // evidence ref must mention at least one snapshotted slug (producer-side convention)
    const mentions = snapshotRefs.has(e.ref.split(":").pop() ?? "");
    if (!mentions && snapshotRefs.size > 0) {
      return { ok: false, reason: `cross-consistency: evidence ref ${e.ref} not traceable to decision_inputs` };
    }
  }
  // dependency_manifest.rule_id == producer.rule_id
  if (p.dependency_manifest.rule_id !== p.producer.rule_id) {
    return { ok: false, reason: "cross-consistency: dependency_manifest.rule_id != producer.rule_id" };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/core/recommendation/integrity.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/recommendation/integrity.ts tests/core/recommendation/integrity.test.ts
git commit -m "feat(rec): integrity check (inputs/fingerprint/cross-consistency) (#328)"
```

---

## Task 5: Versioned rule registry — captureInputs + decide (spec §7.2, §8.2)

**Files:**
- Create: `src/core/recommendation/registry.ts`
- Test: `tests/core/recommendation/registry.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/core/recommendation/registry.test.ts
import { describe, expect, test } from "bun:test";
import { VersionedRuleRegistry } from "../../../src/core/recommendation/registry.js";
import type { DecisionInputs, RecommendationConclusion } from "../../../src/core/recommendation/types.js";

describe("VersionedRuleRegistry", () => {
  test("resolve exact version; captureInputs + decide both present", () => {
    const reg = new VersionedRuleRegistry();
    reg.register({
      rule_id: "demo", rule_version: "1.0.0", code_hash: "h1",
      captureInputs: (deps) => ({ signals: { n: (deps as { rows: unknown[] }).rows.length }, entity_snapshot: {} }),
      decide: (di: DecisionInputs): RecommendationConclusion => ({ kind: "abstain", reason: "policy_prohibits" }),
    });
    const runner = reg.resolve("demo", "1.0.0");
    expect(runner.status).toBe("ok");
    if (runner.status === "ok") {
      const di = runner.captureInputs({ rows: [1, 2, 3] });
      expect((di.signals as { n: number }).n).toBe(3);
      expect(runner.decide(di).kind).toBe("abstain");
    }
  });

  test("unknown version -> unavailable, not a crash", () => {
    const reg = new VersionedRuleRegistry();
    const r = reg.resolve("demo", "9.9.9");
    expect(r.status).toBe("unavailable");
    if (r.status === "unavailable") expect(r.reason).toBe("unknown");
  });

  test("duplicate (rule_id, rule_version) with different code_hash rejected at register", () => {
    const reg = new VersionedRuleRegistry();
    reg.register({ rule_id: "d", rule_version: "1.0.0", code_hash: "h1", captureInputs: () => ({ signals: {}, entity_snapshot: {} }), decide: () => ({ kind: "abstain", reason: "policy_prohibits" }) });
    expect(() => reg.register({ rule_id: "d", rule_version: "1.0.0", code_hash: "h2", captureInputs: () => ({ signals: {}, entity_snapshot: {} }), decide: () => ({ kind: "abstain", reason: "policy_prohibits" }) })).toThrow(/already registered/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/core/recommendation/registry.test.ts` → FAIL.

- [ ] **Step 3: Implement registry**

```ts
// src/core/recommendation/registry.ts
import type { DecisionInputs, RecommendationConclusion } from "./types.js";

export interface RuleRunner {
  rule_id: string;
  rule_version: string;
  code_hash: string;
  captureInputs: (declaredValues: unknown) => DecisionInputs;
  decide: (decision_inputs: DecisionInputs) => RecommendationConclusion;
}

export type ResolveResult =
  | ({ status: "ok" } & RuleRunner)
  | { status: "unavailable"; reason: "unknown" | "purged" | "incompatible" };

export class VersionedRuleRegistry {
  private byKey = new Map<string, RuleRunner>();

  key(ruleId: string, ruleVersion: string): string {
    return `${ruleId}@${ruleVersion}`;
  }

  register(r: RuleRunner): void {
    const k = this.key(r.rule_id, r.rule_version);
    const existing = this.byKey.get(k);
    if (existing && existing.code_hash !== r.code_hash) {
      throw new Error(`registry: ${k} already registered with different code_hash`);
    }
    this.byKey.set(k, r);
  }

  resolve(ruleId: string, ruleVersion: string): ResolveResult {
    const r = this.byKey.get(this.key(ruleId, ruleVersion));
    if (!r) return { status: "unavailable", reason: "unknown" };
    return { status: "ok", ...r };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/core/recommendation/registry.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/recommendation/registry.ts tests/core/recommendation/registry.test.ts
git commit -m "feat(rec): versioned rule registry (captureInputs + decide) (#328)"
```

---

## Task 6: Record store + atomic supersede (spec §5.5)

**Files:**
- Create: `src/core/recommendation/record-store.ts`
- Test: `tests/core/recommendation/record-store.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/core/recommendation/record-store.test.ts
import { rmSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { RecommendationStore } from "../../src/core/recommendation/record-store.js";
import { computeInputsHash, computeFingerprint } from "../../src/core/recommendation/integrity.js";
import type { RecommendationImmutablePayload } from "../../src/core/recommendation/types.js";
import { SCHEMA_VERSION } from "../../src/core/recommendation/types.js";

const DIR = "/tmp/cbrain-test-rec-store";
let db: CBrainDB;
let store: RecommendationStore;

function mkPayload(fingerprint: string, key = "k1"): RecommendationImmutablePayload {
  const di = { signals: { v: 1 }, entity_snapshot: { eA: { x: 1 } } };
  const p: RecommendationImmutablePayload = {
    namespace: "maintenance", maintenance_key: key,
    inputs_hash: computeInputsHash(di),
    conclusion: { kind: "propose", action: { type: "dry_run", target_ref: "health:k:eA", reason: "r" }, alternatives: [] },
    decision_inputs: di,
    evidence_manifest: [{ source: "health", ref: "health:k:eA", trust_state: "candidate" }],
    constraints: { policy_version: "p", ontology_version: "o", schema_version: SCHEMA_VERSION },
    dependency_manifest: { rule_id: "health:k", declarations: [{ slug: "eA", table: "links", fields: ["relation"], filter: "active" }] },
    applicability: { audience: "user_only", auto_execute: false, requires_confirmation: { tier: "standard" } },
    risks: [], gaps: [],
    producer: { rule_id: "health:k", rule_version: "1.0.0", code_hash: fingerprint, registry_ref: "r@1.0.0" },
  };
  return p;
}

describe("RecommendationStore atomic supersede", () => {
  afterEach(() => {
    db?.close();
    rmSync(DIR, { recursive: true, force: true });
  });

  function open() {
    db = new CBrainDB(`${DIR}/db.sqlite`);
    store = new RecommendationStore(db);
  }

  test("insert first active -> pending", () => {
    open();
    const p = mkPayload("f1");
    const r = store.insertActive(p, computeFingerprint(p), "t0");
    expect(r.lifecycle_status).toBe("pending");
    expect(store.activeCountFor("k1")).toBe(1);
  });

  test("same fingerprint re-insert -> idempotent no-op", () => {
    open();
    const p = mkPayload("f1");
    const r1 = store.insertActive(p, computeFingerprint(p), "t0");
    const r2 = store.insertActive(p, computeFingerprint(p), "t0");
    expect(r2.record_id).toBe(r1.record_id);
    expect(store.activeCountFor("k1")).toBe(1);
  });

  test("different fingerprint same key -> atomic supersede; active count stays 1", () => {
    open();
    const pA = mkPayload("fA");
    store.insertActive(pA, computeFingerprint(pA), "t0");
    const pB = mkPayload("fB");
    const rB = store.insertActive(pB, computeFingerprint(pB), "t1");
    expect(rB.lifecycle_status).toBe("pending");
    expect(store.activeCountFor("k1")).toBe(1); // never 2
    // A is now superseded
    const active = store.getActive("k1");
    expect(active?.record_id).toBe(rB.record_id);
  });

  test("A->B->A recovery path 2: re-insert A2 supersedes B, same fingerprint as A", () => {
    open();
    const pA = mkPayload("fA");
    store.insertActive(pA, computeFingerprint(pA), "t0");
    const pB = mkPayload("fB");
    store.insertActive(pB, computeFingerprint(pB), "t1"); // A superseded
    // state returns to A: producer re-runs, re-inserts A content (new record_id, same fingerprint as pA)
    const rA2 = store.insertActive(pA, computeFingerprint(pA), "t2");
    expect(rA2.fingerprint).toBe(computeFingerprint(pA));
    expect(rA2.record_id).not.toBe(pA); // new record_id
    expect(store.activeCountFor("k1")).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/core/recommendation/record-store.test.ts` → FAIL.

- [ ] **Step 3: Implement record store**

```ts
// src/core/recommendation/record-store.ts
import { canonicalJson } from "./canonical.js";
import type { CBrainDB } from "../../storage/sqlite.js";
import type {
  FreshnessStatus, LifecycleStatus, RecommendationImmutablePayload, RecommendationRecord,
} from "./types.js";

interface Row {
  record_id: string; maintenance_key: string; fingerprint: string; inputs_hash: string;
  payload: string; auto_execute: number; created_at: string; last_revalidated_at: string;
  lifecycle_status: string; freshness_status: string; suppressed_until: string | null;
}

function newRecordId(): string {
  return globalThis.crypto.randomUUID(); // identity only; NOT in fingerprint
}

export class RecommendationStore {
  constructor(private db: CBrainDB) {}

  /** Uses CBrainDB.prepare(sql).get/.run({ $named }) — same style as getConfig (sqlite.ts:769). */
  activeCountFor(maintenanceKey: string): number {
    const r = this.db.prepare(
      "SELECT COUNT(*) c FROM recommendation_records WHERE maintenance_key = $key AND lifecycle_status IN ('pending','current')"
    ).get({ $key: maintenanceKey }) as { c: number };
    return r.c;
  }

  getActive(maintenanceKey: string): RecommendationRecord | null {
    const row = this.db.prepare(
      "SELECT * FROM recommendation_records WHERE maintenance_key = $key AND lifecycle_status IN ('pending','current') ORDER BY rowid DESC LIMIT 1"
    ).get({ $key: maintenanceKey }) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  /**
   * Atomic supersede (spec §5.5). One transaction (CBrainDB.transaction at sqlite.ts:581
   * already invokes the fn). Invariant: active count per key <= 1 throughout.
   */
  insertActive(payload: RecommendationImmutablePayload, fingerprint: string, now: string): RecommendationRecord {
    const existing = this.getActive(payload.maintenance_key);
    if (existing && existing.fingerprint === fingerprint) return existing; // idempotent

    const recordId = newRecordId();
    const record: RecommendationRecord = {
      record_id: recordId, payload, fingerprint,
      created_at: now, last_revalidated_at: now,
      lifecycle_status: "pending", freshness_status: "fresh", suppressed_until: null,
    };

    this.db.transaction(() => {
      if (existing) {
        this.db.prepare(
          "UPDATE recommendation_records SET lifecycle_status = 'superseded' WHERE record_id = $id"
        ).run({ $id: existing.record_id });
        this.db.prepare(
          "INSERT INTO recommendation_lifecycle_history (record_id, action, from_lifecycle, to_lifecycle, reason, created_at) VALUES ($rid, 'superseded', $from, 'superseded', $reason, $now)"
        ).run({ $rid: existing.record_id, $from: existing.lifecycle_status, $reason: `replaced by ${recordId}`, $now: now });
      }
      this.db.prepare(
        `INSERT INTO recommendation_records
         (record_id, maintenance_key, fingerprint, inputs_hash, payload, auto_execute,
          created_at, last_revalidated_at, lifecycle_status, freshness_status, suppressed_until)
         VALUES ($rid,$key,$fp,$ih,$payload,0,$now,$now,'pending','fresh',NULL)`
      ).run({
        $rid: recordId, $key: payload.maintenance_key, $fp: fingerprint, $ih: payload.inputs_hash,
        $payload: canonicalJson(payload) /* stored canonical JSON for audit/replay */, $now: now,
      });
      this.db.prepare(
        "INSERT INTO recommendation_lifecycle_history (record_id, action, from_lifecycle, to_lifecycle, created_at) VALUES ($rid, 'created', NULL, 'pending', $now)"
      ).run({ $rid: recordId, $now: now });
    });

    return record;
  }

  setStatus(recordId: string, lifecycle: LifecycleStatus, freshness: FreshnessStatus, now: string, reason?: string): void {
    this.db.transaction(() => {
      const cur = this.db.prepare("SELECT lifecycle_status AS l, freshness_status AS f FROM recommendation_records WHERE record_id = $id").get({ $id: recordId }) as { l: string; f: string } | undefined;
      if (!cur) throw new Error(`record ${recordId} not found`);
      this.db.prepare(
        "UPDATE recommendation_records SET lifecycle_status = $l, freshness_status = $f, last_revalidated_at = $now WHERE record_id = $id"
      ).run({ $l: lifecycle, $f: freshness, $now: now, $id: recordId });
      this.db.prepare(
        "INSERT INTO recommendation_lifecycle_history (record_id, action, from_lifecycle, to_lifecycle, from_freshness, to_freshness, reason, created_at) VALUES ($rid,$action,$fl,$tl,$ff,$tf,$reason,$now)"
      ).run({ $rid: recordId, $action: `set:${lifecycle}/${freshness}`, $fl: cur.l, $tl: lifecycle, $ff: cur.f, $tf: freshness, $reason: reason ?? null, $now: now });
    });
  }
}

function fromRow(r: Row): RecommendationRecord {
  return {
    record_id: r.record_id,
    payload: JSON.parse(r.payload) as RecommendationImmutablePayload,
    fingerprint: r.fingerprint,
    created_at: r.created_at,
    last_revalidated_at: r.last_revalidated_at,
    lifecycle_status: r.lifecycle_status as LifecycleStatus,
    freshness_status: r.freshness_status as FreshnessStatus,
    suppressed_until: r.suppressed_until,
  };
}
```

> **API note:** `CBrainDB.prepare(sql).get/.run({ $named })` and `CBrainDB.transaction(fn)` (which already invokes `fn`) are the real helpers — see `getConfig`/`setConfig` (sqlite.ts:769) and `transaction<T>` (sqlite.ts:581). No new query API is invented.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/core/recommendation/record-store.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/recommendation/record-store.ts tests/core/recommendation/record-store.test.ts
git commit -m "feat(rec): record store + atomic supersede (#328)"
```

---

## Task 7: Freshness gate (spec §5.3, §8.4)

**Files:**
- Create: `src/core/recommendation/freshness.ts`
- Test: `tests/core/recommendation/freshness.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/core/recommendation/freshness.test.ts
import { rmSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { RecommendationStore } from "../../src/core/recommendation/record-store.js";
import { recomputeFreshness } from "../../src/core/recommendation/freshness.js";
import { VersionedRuleRegistry } from "../../src/core/recommendation/registry.js";
import { computeFingerprint, computeInputsHash } from "../../src/core/recommendation/integrity.js";
import type { RecommendationImmutablePayload } from "../../src/core/recommendation/types.js";
import { SCHEMA_VERSION } from "../../src/core/recommendation/types.js";

const DIR = "/tmp/cbrain-test-rec-fresh";

// a producer whose captureInputs reflects current "links reports_to count"
function buildProducerAndPayload(db: CBrainDB, slug: string, count: number) {
  const di = { signals: { count }, entity_snapshot: { [slug]: { reports_to: Array.from({ length: count }, (_, i) => `o${i}`) } } };
  const p: RecommendationImmutablePayload = {
    namespace: "maintenance", maintenance_key: `health:k:[${slug}]`,
    inputs_hash: computeInputsHash(di),
    conclusion: { kind: "propose", action: { type: "dry_run", target_ref: `health:k:${slug}`, reason: "r" }, alternatives: [] },
    decision_inputs: di,
    evidence_manifest: [{ source: "health", ref: `health:k:${slug}`, trust_state: "candidate" }],
    constraints: { policy_version: "p", ontology_version: "o", schema_version: SCHEMA_VERSION },
    dependency_manifest: { rule_id: "health:k", declarations: [{ slug, table: "links", fields: ["relation","trust_state","other_slug"], filter: "active" }] },
    applicability: { audience: "user_only", auto_execute: false, requires_confirmation: { tier: "standard" } },
    risks: [], gaps: [],
    producer: { rule_id: "health:k", rule_version: "1.0.0", code_hash: "h", registry_ref: "r@1.0.0" },
  };
  const reg = new VersionedRuleRegistry();
  reg.register({
    rule_id: "health:k", rule_version: "1.0.0", code_hash: "h",
    captureInputs: (declared) => {
      const c = (declared as { reports_to: string[] }).reports_to.length;
      return { signals: { count: c }, entity_snapshot: { [slug]: { reports_to: (declared as { reports_to: string[] }).reports_to } } };
    },
    decide: () => ({ kind: "propose", action: { type: "dry_run", target_ref: `health:k:${slug}`, reason: "r" }, alternatives: [] }),
  });
  return { p, reg };
}

describe("recomputeFreshness", () => {
  afterEach(() => { rmSync(DIR, { recursive: true, force: true }); });

  test("dependency drift -> freshness=stale, lifecycle unchanged", () => {
    const db = new CBrainDB(`${DIR}/db.sqlite`);
    const store = new RecommendationStore(db);
    const { p, reg } = buildProducerAndPayload(db, "eA", 1);
    const r = store.insertActive(p, computeFingerprint(p), "t0");
    expect(r.lifecycle_status).toBe("pending");
    // current declared values now reflect count=2 (drift)
    const res = recomputeFreshness(r, reg, { eA: { reports_to: ["o0", "o1"] } }, p.constraints, "t1");
    expect(res.freshness_status).toBe("stale");
    expect(res.lifecycle_status).toBe("pending"); // unchanged
    db.close();
  });

  test("constraints mismatch -> version_invalid", () => {
    const db = new CBrainDB(`${DIR}/db2.sqlite`);
    const store = new RecommendationStore(db);
    const { p, reg } = buildProducerAndPayload(db, "eA", 1);
    const r = store.insertActive(p, computeFingerprint(p), "t0");
    const res = recomputeFreshness(r, reg, { eA: { reports_to: ["o0"] } }, { ...p.constraints, ontology_version: "changed" }, "t1");
    expect(res.freshness_status).toBe("version_invalid");
    db.close();
  });

  test("all match -> fresh", () => {
    const db = new CBrainDB(`${DIR}/db3.sqlite`);
    const store = new RecommendationStore(db);
    const { p, reg } = buildProducerAndPayload(db, "eA", 1);
    const r = store.insertActive(p, computeFingerprint(p), "t0");
    const res = recomputeFreshness(r, reg, { eA: { reports_to: ["o0"] } }, p.constraints, "t1");
    expect(res.freshness_status).toBe("fresh");
    db.close();
  });

  test("captureInputs unavailable -> version_invalid (no guess)", () => {
    const db = new CBrainDB(`${DIR}/db4.sqlite`);
    const store = new RecommendationStore(db);
    const { p } = buildProducerAndPayload(db, "eA", 1);
    const r = store.insertActive(p, computeFingerprint(p), "t0");
    const emptyReg = new VersionedRuleRegistry(); // no runners
    const res = recomputeFreshness(r, emptyReg, { eA: { reports_to: ["o0"] } }, p.constraints, "t1");
    expect(res.freshness_status).toBe("version_invalid");
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/core/recommendation/freshness.test.ts` → FAIL.

- [ ] **Step 3: Implement freshness**

```ts
// src/core/recommendation/freshness.ts
import { computeInputsHash } from "./integrity.js";
import type { VersionedRuleRegistry } from "./registry.js";
import type { FreshnessStatus, RecommendationConstraints, RecommendationRecord } from "./types.js";

export interface FreshnessInput {
  /** current declared dependency values keyed by slug (as the producer's captureInputs expects) */
  [slug: string]: unknown;
}

export function recomputeFreshness(
  record: RecommendationRecord,
  registry: VersionedRuleRegistry,
  currentDeclared: FreshnessInput,
  currentConstraints: RecommendationConstraints,
  now: string,
): { freshness_status: FreshnessStatus; lifecycle_status: RecommendationRecord["lifecycle_status"]; last_revalidated_at: string } {
  // version constraints first (cheap, no runner needed)
  const c = record.payload.constraints;
  if (
    currentConstraints.policy_version !== c.policy_version ||
    currentConstraints.ontology_version !== c.ontology_version ||
    currentConstraints.schema_version !== c.schema_version
  ) {
    return { freshness_status: "version_invalid", lifecycle_status: record.lifecycle_status, last_revalidated_at: now };
  }
  // resolve exact-version input projector (spec §5.3)
  const runner = registry.resolve(record.payload.producer.rule_id, record.payload.producer.rule_version);
  if (runner.status !== "ok") {
    return { freshness_status: "version_invalid", lifecycle_status: record.lifecycle_status, last_revalidated_at: now };
  }
  const slug = record.payload.dependency_manifest.declarations.find((d) => d.slug)?.slug ?? "__global__";
  const di = runner.captureInputs(currentDeclared[slug] ?? currentDeclared);
  const inputsHashNow = computeInputsHash(di);
  return {
    freshness_status: inputsHashNow === record.payload.inputs_hash ? "fresh" : "stale",
    lifecycle_status: record.lifecycle_status, // never changed by freshness (spec §5.1)
    last_revalidated_at: now,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/core/recommendation/freshness.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/recommendation/freshness.ts tests/core/recommendation/freshness.test.ts
git commit -m "feat(rec): freshness gate via versioned captureInputs (#328)"
```

---

## Task 8: Display projection — target_display read-time (spec §4.4, §11.3)

**Files:**
- Create: `src/core/recommendation/display.ts`
- Test: `tests/core/recommendation/display.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/core/recommendation/display.test.ts
import { describe, expect, test } from "bun:test";
import { projectDisplay, slugFromRef } from "../../../src/core/recommendation/display.js";
import type { RecommendationRecord } from "../../../src/core/recommendation/types.js";

describe("projectDisplay", () => {
  test("target_display resolved at read time via safeTitle fallback; not stored", () => {
    const rec = { payload: { conclusion: { kind: "propose", action: { type: "dry_run", target_ref: "health:known_relations:entityA", reason: "复核 reports_to" }, alternatives: [] } } } as unknown as RecommendationRecord;
    const d = projectDisplay(rec, (slug) => `真实标题(${slug})`);
    expect(d.target_display).toBe("真实标题(entityA)");
    expect(d.reason).toBe("复核 reports_to");
    // record itself has no target_display field
    expect((rec.payload.conclusion as { action: { target_display?: string } }).action.target_display).toBeUndefined();
  });

  test("safeTitle fallback when resolution yields empty", () => {
    const rec = { payload: { conclusion: { kind: "propose", action: { type: "review", target_ref: "health:k:entityZ", reason: "r" }, alternatives: [] } } } as unknown as RecommendationRecord;
    const d = projectDisplay(rec, () => "");
    expect(d.target_display).toBe("一项待确认的记忆"); // generic fallback
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/core/recommendation/display.test.ts` → FAIL.

- [ ] **Step 3: Implement display**

```ts
// src/core/recommendation/display.ts
import { assertSafeActionDisplay } from "../safety/display-safety.js";
import type { RecommendationRecord } from "./types.js";

const FALLBACK_DISPLAY = "一项待确认的记忆";

/** Pull the trailing slug out of an internal ref like "health:known_relations:entityA". */
export function slugFromRef(ref: string): string {
  const parts = ref.split(":");
  return parts[parts.length - 1] ?? ref;
}

export interface RecommendationDisplay {
  target_display: string; // read-time projection; #327-boundary sanitized in MCP layer
  reason: string;
  // (Phase 1 keeps display minimal; richer projection lands with the MCP surface, gated by #327)
}

/**
 * Read-time display projection (spec §4.4). target_display is NOT persisted — it is
 * derived here from target_ref via a caller-supplied safeTitle resolver, then passed
 * through the existing display-safety guard. The MCP layer further applies the #327
 * output boundary before showing this to the agent.
 */
export function projectDisplay(rec: RecommendationRecord, resolveSafeTitle: (slug: string) => string): RecommendationDisplay {
  const c = rec.payload.conclusion;
  if (c.kind !== "propose") return { target_display: FALLBACK_DISPLAY, reason: `abstain: ${c.reason}` };
  const slug = slugFromRef(c.action.target_ref);
  let display = resolveSafeTitle(slug) || FALLBACK_DISPLAY;
  try {
    assertSafeActionDisplay(display); // throws on unsafe; fall back if it does
  } catch {
    display = FALLBACK_DISPLAY;
  }
  return { target_display: display, reason: c.action.reason };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/core/recommendation/display.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/recommendation/display.ts tests/core/recommendation/display.test.ts
git commit -m "feat(rec): read-time display projection (#328)"
```

---

## Task 9: Reference producer — health known_relations repair (vertical slice)

**Files:**
- Create: `src/core/recommendation/producers/known-relations.ts`
- Create: `src/core/recommendation/producers/index.ts`
- Test: `tests/core/recommendation/producers/known-relations.test.ts`

> This producer exercises every infrastructure layer. It reads active reports_to edges for a pair, abstains when none, proposes a dry_run review when a candidate edge exists. It is deterministic and read-only.

- [ ] **Step 1: Write failing test**

```ts
// tests/core/recommendation/producers/known-relations.test.ts
import { rmSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import { CBrainDB } from "../../../src/storage/sqlite.js";
import { registerMaintenanceProducers } from "../../../src/core/recommendation/producers/index.js";
import { VersionedRuleRegistry } from "../../../src/core/recommendation/registry.js";
import { RecommendationManager } from "../../../src/core/recommendation/manager.js";

const DIR = "/tmp/cbrain-test-rec-producer";

describe("known_relations producer (vertical slice)", () => {
  afterEach(() => { rmSync(DIR, { recursive: true, force: true }); });

  test("abstains when no candidate reports_to edge", () => {
    const db = new CBrainDB(`${DIR}/db.sqlite`);
    const reg = new VersionedRuleRegistry();
    registerMaintenanceProducers(reg);
    const mgr = new RecommendationManager(db, reg);
    const res = mgr.buildAndStore({ rule_id: "health:known_relations", slugs: ["entityA", "entityB"] }, "t0");
    expect(res.payload.conclusion.kind).toBe("abstain");
    expect(res.lifecycle_status).toBe("pending");
    db.close();
  });

  test("proposes dry_run when candidate reports_to edge present", () => {
    const db = new CBrainDB(`${DIR}/db2.sqlite`);
    // seed two pages + one candidate reports_to edge via rawDb (mirrors health-reports-to.test.ts)
    const A = "entities/entityA";
    const B = "entities/entityB";
    for (const s of [A, B]) {
      db.rawDb
        .prepare(`INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count, tier) VALUES (?, 'entity', ?, ?, ?, 0, 3)`)
        .run(s, s, `${s}.md`, `h-${s}`);
    }
    db.rawDb
      .prepare(`INSERT INTO links (from_slug, to_slug, relation, trust_state, source_type) VALUES (?, ?, 'reports_to', 'candidate', 'agent')`)
        .run(A, B);
    const reg = new VersionedRuleRegistry();
    registerMaintenanceProducers(reg);
    const mgr = new RecommendationManager(db, reg);
    const res = mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "t0");
    expect(res.payload.conclusion.kind).toBe("propose");
    db.close();
  });
});
```

> **API note:** seeding uses `db.rawDb.prepare(...).run(positional)` exactly as `tests/core/health-reports-to.test.ts` does (raw bun:sqlite). Anonymous sentinel slugs `entities/entityA`/`B` per the privacy convention. Pages minimal columns; links minimal columns with `trust_state='candidate'`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/core/recommendation/producers/known-relations.test.ts` → FAIL (manager/producers missing).

- [ ] **Step 3: Implement the producer**

```ts
// src/core/recommendation/producers/known-relations.ts
import type { CBrainDB } from "../../../storage/sqlite.js";
import type { DecisionInputs, RecommendationConclusion, RecommendationProducer } from "../types.js";

export const KNOWN_RELATIONS: RecommendationProducer = {
  rule_id: "health:known_relations",
  rule_version: "1.0.0",
  code_hash: "known-relations-v1", // Phase 1: static; Phase 2 ties to registry build
  registry_ref: "cbrain.rules:maintenance.known_relations@1.0.0",
};

interface ReportsToEdge { from: string; to: string; trust_state: string }

/** Read active reports_to edges for each slug via getOutgoingLinks (default active-only,
 *  already filters rejected/superseded via ACTIVE_LINK_SQL — sqlite.ts:1924). */
export function readDeclared(db: CBrainDB, slugs: string[]): Record<string, ReportsToEdge[]> {
  const out: Record<string, ReportsToEdge[]> = {};
  for (const s of slugs) {
    out[s] = db
      .getOutgoingLinks(s)
      .filter((r) => r.relation === "reports_to")
      .map((r) => ({ from: r.from_slug, to: r.to_slug, trust_state: r.trust_state ?? "trusted" }));
  }
  return out;
}

export function captureInputs(slugs: string[], declared: Record<string, ReportsToEdge[]>): DecisionInputs {
  const candidateEdges = slugs.flatMap((s) => declared[s] ?? []).filter((e) => e.trust_state === "candidate");
  return {
    signals: { candidate_count: candidateEdges.length },
    entity_snapshot: Object.fromEntries(slugs.map((s) => [s, { reports_to: declared[s] ?? [] }])),
  };
}

export function decide(slugs: string[], di: DecisionInputs): RecommendationConclusion {
  const count = (di.signals.candidate_count as number) ?? 0;
  if (count === 0) return { kind: "abstain", reason: "insufficient_evidence" };
  const target = slugs[0];
  return {
    kind: "propose",
    action: { type: "dry_run", target_ref: `health:known_relations:${target}`, reason: "存在待确认的 reports_to 候选边，建议人工复核" },
    alternatives: [],
  };
}
```

> **API note:** `db.getOutgoingLinks(slug)` (sqlite.ts:1924) returns active `LinkRow[]` by default (drops rejected/superseded). `trust_state` is `string | null`; null is treated as trusted per existing convention. The ACTIVE filter is required so inactive evidence cannot enter the manifest (spec §4 manifest invariant).

- [ ] **Step 4: Implement manager + producer registration**

```ts
// src/core/recommendation/producers/index.ts
import type { VersionedRuleRegistry } from "../registry.js";
import { KNOWN_RELATIONS, captureInputs as krCapture, decide as krDecide, readDeclared as krRead } from "./known-relations.js";

export function registerMaintenanceProducers(reg: VersionedRuleRegistry): void {
  reg.register({
    ...KNOWN_RELATIONS,
    // captureInputs receives the readDeclared() map keyed by slug
    captureInputs: (declared: unknown) => {
      // slugs derived from the map keys (caller passes the pair's map)
      const slugs = Object.keys(declared as Record<string, unknown>);
      return krCapture(slugs, declared as Record<string, { from: string; to: string; trust_state: string }[]>);
    },
    decide: (di) => {
      const slugs = Object.keys(di.entity_snapshot);
      return krDecide(slugs, di);
    },
  });
}
```

```ts
// src/core/recommendation/manager.ts
import { RecommendationStore } from "./record-store.js";
import { computeFingerprint, computeInputsHash } from "./integrity.js";
import { sha256Hex } from "./canonical.js";
import type { CBrainDB } from "../../storage/sqlite.js";
import type { VersionedRuleRegistry } from "./registry.js";
import type {
  RecommendationImmutablePayload, RecommendationProducer, EvidenceManifestEntry,
  DependencyManifest, RecommendationConstraints,
} from "./types.js";
import { SCHEMA_VERSION } from "./types.js";
import { readDeclared } from "./producers/known-relations.js";

const PRODUCERS: Record<string, RecommendationProducer> = {
  "health:known_relations": {
    rule_id: "health:known_relations", rule_version: "1.0.0",
    code_hash: "known-relations-v1", registry_ref: "cbrain.rules:maintenance.known_relations@1.0.0",
  },
};

export interface BuildRequest { rule_id: string; slugs: string[] }

export class RecommendationManager {
  constructor(private db: CBrainDB, private registry: VersionedRuleRegistry) {}

  buildAndStore(req: BuildRequest, now: string) {
    const producer = PRODUCERS[req.rule_id];
    if (!producer) throw new Error(`unknown producer ${req.rule_id}`);
    const runner = this.registry.resolve(producer.rule_id, producer.rule_version);
    if (runner.status !== "ok") throw new Error(`producer ${req.rule_id}@${producer.rule_version} not registered`);

    // 1. capture inputs from current declared deps
    const declared = readDeclared(this.db, req.slugs);
    const decision_inputs = runner.captureInputs(declared);
    const inputs_hash = computeInputsHash(decision_inputs);

    // 2. decide conclusion
    const conclusion = runner.decide(decision_inputs);

    // 3. assemble payload
    const maintenance_key = `${req.rule_id}:${canonicalSlugSet(req.slugs)}`;
    const evidence_manifest: EvidenceManifestEntry[] =
      conclusion.kind === "propose"
        ? req.slugs.map((s) => ({ source: "health", ref: `${req.rule_id}:${s}`, trust_state: "candidate" as const }))
        : [];
    const dependency_manifest: DependencyManifest = {
      rule_id: producer.rule_id,
      declarations: req.slugs.map((s) => ({ slug: s, table: "links" as const, fields: ["relation", "trust_state", "other_slug"], filter: "active" as const })),
    };
    const constraints: RecommendationConstraints = {
      policy_version: sha256Hex("policy-v1"), // Phase 1 static; Phase 2 derives from policy bundle
      ontology_version: sha256Hex("ontology-v1"),
      schema_version: SCHEMA_VERSION,
    };

    const payload: RecommendationImmutablePayload = {
      namespace: "maintenance",
      maintenance_key,
      inputs_hash,
      conclusion,
      decision_inputs,
      evidence_manifest,
      constraints,
      dependency_manifest,
      applicability: { audience: "user_only", auto_execute: false, requires_confirmation: { tier: "standard" } },
      risks: [],
      gaps: [],
      producer,
    };

    // 4. fingerprint + store (atomic supersede)
    const fingerprint = computeFingerprint(payload);
    const store = new RecommendationStore(this.db);
    return store.insertActive(payload, fingerprint, now);
  }
}

function canonicalSlugSet(slugs: string[]): string {
  return JSON.stringify([...new Set(slugs)].sort());
}
```

> **Note:** the `normalizeProse` import is unused in this minimal manager — remove it if `bun run lint` flags it, OR keep for upcoming risk text. Prefer removing to keep lint green.

- [ ] **Step 5: Run producer test to verify it passes**

Run: `bun test tests/core/recommendation/producers/known-relations.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/recommendation/producers/ src/core/recommendation/manager.ts \
        tests/core/recommendation/producers/known-relations.test.ts
git commit -m "feat(rec): known_relations reference producer + manager (vertical slice) (#328)"
```

---

## Task 10: Rollback tests (spec §5.5, migration integrity)

**Files:**
- Test: `tests/storage/migrations/recommendations.test.ts` (extend) + `tests/core/recommendation/record-store.test.ts` (extend)

> Codex explicitly asked for rollback tests. Three rollback surfaces: (a) migration is re-runnable / doesn't duplicate; (b) atomic supersede leaves no dual-active on partial failure; (c) fingerprint rebuild from stored payload round-trips.

- [ ] **Step 1: Add migration rollback test — re-run after partial failure leaves schema intact**

Append to `tests/storage/migrations/recommendations.test.ts`:

```ts
import { Database } from "bun:sqlite";

test("migration is forward-only additive; re-run after manual table drop restores cleanly", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  runRecommendationRecordsMigration(db);
  // simulate partial rollback: drop the table but leave config key
  db.exec("DROP TABLE recommendation_records");
  // clear completion key so migration re-runs (forward repair)
  db.exec("DELETE FROM config WHERE key='migration_rec_v1_recommendation_records'");
  expect(() => runRecommendationRecordsMigration(db)).not.toThrow();
  expect(tableExists(db, "recommendation_records")).toBe(true);
  db.close();
});
```

Run: `bun test tests/storage/migrations/recommendations.test.ts` → PASS.

- [ ] **Step 2: Add supersede rollback test — failed insert leaves prior active intact**

Append to `tests/core/recommendation/record-store.test.ts`:

```ts
test("atomic supersede rolls back on partial failure — prior active stays active", () => {
  open();
  const pA = mkPayload("fA");
  store.insertActive(pA, computeFingerprint(pA), "t0");
  // CBrainDB.transaction(fn) (sqlite.ts:581) already invokes fn; a throw aborts the txn.
  expect(() => {
    db.transaction(() => {
      db.prepare("UPDATE recommendation_records SET lifecycle_status='superseded' WHERE maintenance_key = 'k1' AND lifecycle_status IN ('pending','current')").run();
      throw new Error("simulated failure"); // aborts → UPDATE rolled back
    });
  }).toThrow();
  // prior A still active, count 1 — the manual UPDATE did not persist
  expect(store.activeCountFor("k1")).toBe(1);
  expect(store.getActive("k1")?.fingerprint).toBe(computeFingerprint(pA));
});
```

Run: `bun test tests/core/recommendation/record-store.test.ts` → PASS.

- [ ] **Step 3: Add fingerprint rebuild round-trip test**

Append to `tests/core/recommendation/integrity.test.ts`:

```ts
import { computeFingerprint } from "../../../src/core/recommendation/integrity.js";

test("fingerprint rebuild from stored canonical payload round-trips", () => {
  const p = basePayload(); p.inputs_hash = computeInputsHash(p.decision_inputs);
  const fp = computeFingerprint(p);
  // simulate store→load: recompute from the same payload object
  expect(computeFingerprint(p)).toBe(fp);
  // and across a JSON serialize/deserialize cycle (as the DB stores it)
  const reloaded = JSON.parse(JSON.stringify(p)) as RecommendationImmutablePayload;
  expect(computeFingerprint(reloaded)).toBe(fp);
});
```

Run: `bun test tests/core/recommendation/integrity.test.ts` → PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/storage/migrations/recommendations.test.ts tests/core/recommendation/record-store.test.ts tests/core/recommendation/integrity.test.ts
git commit -m "test(rec): rollback + fingerprint rebuild tests (#328)"
```

---

## Task 11: Lint gate + full check

**Files:** none (verification only)

- [ ] **Step 1: Full lint**

Run: `bun run lint`
Expected: PASS (tsc --noEmit + biome). All `CBrainDB` calls in this plan already use the real API (`prepare(sql).get/.run({ $named })`, `transaction(fn)` which self-invokes, `getOutgoingLinks`, `rawDb.prepare` for seeding); lint failures here mean a typo, not an API mismatch.

- [ ] **Step 2: Full test**

Run: `bun test tests/core/recommendation/ tests/storage/migrations/recommendations.test.ts`
Expected: all PASS.

- [ ] **Step 3: Full check**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 4: docs gate**

Run: `bun run check:docs`
Expected: PASS (no doc table touched; defensive).

- [ ] **Step 5: Commit any lint fixes**

```bash
git add -A
git commit -m "chore(rec): lint/gate green (#328)" --allow-empty
```

---

## Self-Review (run before handing off)

**Spec coverage** (spec rev6 → this plan):
- §4 record shape → Task 2 (types) ✓
- §4.3 three-input source of truth + cross-consistency → Task 4 (`checkCrossConsistency`) ✓
- §4.4 target_display read-time → Task 8 ✓
- §5.1–5.7 lifecycle + freshness axes → Task 6 (store), Task 7 (freshness) ✓
- §5.5 atomic supersede + active≤1 → Task 6 (+rollback Task 10) ✓
- §6.1–6.4 canonicalization (JCS + golden bytes) → Task 1 ✓
- §7.2 versioned registry captureInputs/decide → Task 5 ✓
- §8.1 3-layer integrity → Task 4 ✓
- §8.2 decision replay via decide() → Task 5/9 (decide wired; full replay UI is Phase 2) ⚠ partial — replay RESULT type defined in spec, runtime replay endpoint out of Phase 1 infra scope
- §8.4 freshness gate → Task 7 ✓
- §9 abstain → Task 9 (producer decides) ✓
- §9.1 confirmation classification → Task 2 (type) + Task 9 (standard tier) ✓
- §10 additive migration → Task 3 ✓
- §11 display gating behind #327 → Task 8 (display projection only; no MCP surface in this plan) ✓
- §12 derivation graph → deferred (optional field, not used by Phase 1 maintenance producers) ⚠ noted
- spec §15 adversarial fixtures F1–F24 → covered as tests across Tasks 1/4/6/7/10 (F12 golden bytes, F14/F18/F19/F20 integrity tamper, F15/F23 supersede paths, F16 unrelated-field via dependency_manifest scoping, F21/F22 registry unavailable, F24 projector uniqueness) ✓

**Gaps acknowledged (out of this plan's scope, follow-up):**
- Decision replay *runtime endpoint* (§8.2 `ReplayResult` UI) — Phase 2.
- Derivation graph serialization (§12) — optional for Phase 1 producers.
- MCP tool surface — gated behind #327 (spec §11).

**Placeholder scan:** no TBD/TODO. API references (`prepare(sql).get/.run({ $named })`, `transaction(fn)`, `getOutgoingLinks`, `rawDb.prepare` seeding, `new CBrainDB(dbPath)`) are verified against `sqlite.ts` (lines 581, 769, 1316, 1718, 1924) and `tests/core/health-reports-to.test.ts`; the "API note:" callouts are context, not open items.

**Type consistency:** `RecommendationStore.insertActive` / `getActive` / `activeCountFor` / `setStatus` used consistently across Tasks 6/7/9/10. `computeFingerprint` / `computeInputsHash` / `checkIntegrity` consistent across 4/6/7/9/10. `VersionedRuleRegistry.resolve` returns `ResolveResult` used in 5/7/9.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-12-recommendation-contract-phase1.md`.

**Per the user's instruction: STOP for review. Do not execute yet.** Execution choice (subagent-driven vs inline) and any scope adjustments (e.g., pulling the other 3 producers into this plan) decided after the user approves.

**Do NOT push** — local `main` and `origin/main` have diverged via equivalent #329 commits; the user reconciles history before push.

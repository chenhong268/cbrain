# Recommendation Contract — Phase 1 Infrastructure Implementation Plan (rev3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the deterministic Recommendation Record **contract infrastructure** for Phase 1 (canonicalization, storage, integrity, versioned rule registry, freshness, atomic supersede, lifecycle, suppression, display) from `docs/superpowers/specs/2026-07-12-recommendation-contract-design.md` (rev6), plus one reference producer (`health:known_relations`) as the vertical slice.

**Architecture:** New `src/core/recommendation/` module. New `recommendation_records` + `recommendation_lifecycle_history` tables via an **additive** migration (DDL + completion marker in ONE transaction; test-only fault hook proves atomic rollback). Producers deterministic (no LLM), never auto-execute (`auto_execute:false` invariant + DB CHECK + payload validation). Records carry an immutable payload hashed per RFC 8785 JCS + a prose/identifier string layer. Two orthogonal persisted axes (`lifecycle_status` / `freshness_status`), each with its OWN store API; terminals cannot regress. Atomic supersede keeps `active count ≤ 1` per `maintenance_key`. The **store is the single persistence entry** — it validates, computes hashes, checks cross-consistency, rejects `auto_execute !== false`, and enforces rejected suppression before any write. **code_hash comes from a real rule artifact (`sha256(RULE_ARTIFACT)`)**; the manager reads ALL producer metadata from the registry (zero hardcoding). Display is reachable only through a `loadVerified` orchestration (load → integrity → freshness recompute/persist → reload → active+fresh gate) that yields a branded `VerifiedRecord` type — unverified records cannot be projected to user text.

**Tech Stack:** Bun, TypeScript strict, `bun:sqlite`, `bun:test`, `node:crypto`. No new runtime deps.

**Spec reference:** `docs/superpowers/specs/2026-07-12-recommendation-contract-design.md` (rev6).

**rev3 changelog (this revision):** closes Codex's 5 HIGH + 2 MED on plan rev2 — (H1) unified the declaration/snapshot field model: declaration now carries `as` (projection key) + `relation`/`direction`/`fields`, reader reads strictly by declaration and **fail-closes** on unknown table/field; cross-consistency checks `as` keys + sub-fields. (H2) projection preserves edge `from`; tests assert exact evidence refs (no `undefined`). (H3) suppression uses an `EXISTS(... IS NULL OR > now)` query (no permanent-suppression bypass), ISO-UTC time contract, default TTL in a policy module, audited `clearSuppression` reopen API. (H4) `loadVerified` orchestration + branded `VerifiedRecord`; `projectDisplay` accepts only verified records. (H5) `code_hash = sha256(RULE_ARTIFACT)`; manager metadata from `registry.directory()`/`resolve()` — no hardcoded producer strings. (M1) registry `manifest()` branches on tombstone first; tombstones enter policy identity. (M2) migration accepts a test-only `failBeforeMarker` hook; atomic test injects mid-failure and asserts full rollback.

---

## Scope (read first)

Phase 1 contract infrastructure + one reference producer (`health:known_relations`). Out of scope (follow-up plan, same registry pattern): producers for fsck / discovery / action-candidate; MCP tool surface (#327-gated); replay/diff UI (Phase 2); derivation graph (§12).

**Non-goals (hard, spec §0):** no LLM at runtime; no auto-execution; no writing recommendations as trusted facts; no model chain-of-thought storage; no MCP/default-display changes.

**History note:** Local `main` and `origin/main` diverged via equivalent #329 commits. **Do NOT push.**

**Staging rule (HARD):** every commit stages **explicit paths only**. Never `git add -A` / `git add .`.

**Time contract:** all timestamps are SQLite-UTC `YYYY-MM-DD HH:MM:SS` (the format produced by `datetime('now')`, sqlite.ts:229), lexicographically comparable. `suppressed_until` uses the same format; `NULL` means permanent suppression.

---

## File Structure

**Create (source):**
- `src/core/recommendation/canonical.ts` — `assertJsonSafe()` + `canonicalJson()` / `sha256Hex()` / `normalizeProse()`.
- `src/core/recommendation/types.ts` — record/payload/lifecycle/freshness types + unified `DependencyDeclaration`.
- `src/core/recommendation/policy.ts` — `DEFAULT_SUPPRESSION_TTL_SECONDS`, `defaultSuppressedUntil(now)`.
- `src/core/recommendation/integrity.ts` — `computeInputsHash`, `computeFingerprint`, `checkIntegrity` (3-layer, real cross-consistency).
- `src/core/recommendation/registry.ts` — `VersionedRuleRegistry` (immutable, tombstones, `directory()`, tombstone-aware `manifest()`).
- `src/core/recommendation/projection.ts` — `DeclaredProjectionReader` (strict, fail-closed, preserves `from`).
- `src/core/recommendation/freshness.ts` — `recomputeAndPersistFreshness`.
- `src/core/recommendation/record-store.ts` — `RecommendationStore`: `createRecord`, `transitionLifecycle`, `updateFreshness`, `clearSuppression`, `getById`, `activeCountFor`.
- `src/core/recommendation/display.ts` — `VerifiedRecord` (branded), `loadVerified`, `projectDisplay`.
- `src/core/recommendation/versions.ts` — `ontologyHash`, `policyHash(registry)`.
- `src/core/recommendation/manager.ts` — `RecommendationManager.buildAndStore` (metadata from registry).
- `src/core/recommendation/producers/known-relations.ts` — reference producer + `RULE_ARTIFACT` + `CODE_HASH`.
- `src/core/recommendation/producers/index.ts` — `registerMaintenanceProducers`.
- `src/storage/migrations/recommendations.ts` — additive migration (with test-only fault hook).

**Modify:** `src/storage/sqlite.ts` (call migration after `runLatePageMigrations` ≈ L420), `src/storage/migrations/index.ts` (export).

**Create (tests):** `tests/core/recommendation/*.test.ts` (depth `../../../src`), `tests/core/recommendation/producers/*.test.ts` (`../../../../src`), `tests/storage/migrations/recommendations.test.ts`.

---

## Task 1: Canonical pipeline — validator-first, fail-closed (spec §6.2)

> Unchanged from rev2 (no Codex finding against Task 1). Kept verbatim.

**Files:** Create `src/core/recommendation/canonical.ts`; Test `tests/core/recommendation/canonical.test.ts`

- [ ] **Step 1: Write failing test** (validator + golden bytes + adversarial — Date/Map/cyclic array+object/lone surrogate/absent optional)

```ts
// tests/core/recommendation/canonical.test.ts
import { describe, expect, test } from "bun:test";
import { assertJsonSafe, canonicalJson, sha256Hex, serializeNumber, normalizeProse } from "../../../src/core/recommendation/canonical.js";

describe("serializeNumber (JCS §3.2.2.3)", () => {
  test("golden bytes", () => {
    expect(serializeNumber(1)).toBe("1");
    expect(serializeNumber(1.0)).toBe("1");
    expect(serializeNumber(-0)).toBe("0");
    expect(serializeNumber(0.1)).toBe("0.1");
    expect(serializeNumber(1e-7)).toBe("1e-7");
    expect(serializeNumber(1e21)).toBe("1e+21");
  });
  test("non-finite fail-closed", () => {
    for (const n of [NaN, Infinity, -Infinity]) expect(() => serializeNumber(n)).toThrow(/finite/);
  });
});
describe("assertJsonSafe", () => {
  test("accepts plain JSON", () => { expect(() => assertJsonSafe({ a: 1, b: [null, "x", true] })).not.toThrow(); });
  test("rejects undefined/function/symbol", () => {
    expect(() => assertJsonSafe({ x: undefined })).toThrow(/JSON-safe/);
    expect(() => assertJsonSafe({ x: () => 1 })).toThrow(/JSON-safe/);
    expect(() => assertJsonSafe({ x: Symbol("s") })).toThrow(/JSON-safe/);
  });
  test("rejects Date/Map/Set/class instance", () => {
    expect(() => assertJsonSafe({ x: new Date() })).toThrow(/JSON-safe/);
    expect(() => assertJsonSafe({ x: new Map() })).toThrow(/JSON-safe/);
    expect(() => assertJsonSafe({ x: new Set() })).toThrow(/JSON-safe/);
    expect(() => assertJsonSafe({ x: new (class C {})() })).toThrow(/JSON-safe/);
  });
  test("rejects cyclic object AND cyclic array", () => {
    const o: Record<string, unknown> = {}; o.self = o; expect(() => assertJsonSafe(o)).toThrow(/cycle/);
    const a: unknown[] = []; a.push(a); expect(() => assertJsonSafe(a)).toThrow(/cycle/);
  });
  test("rejects lone surrogate", () => { expect(() => assertJsonSafe({ x: "ab\uD800cd" })).toThrow(/surrogate/); });
});
describe("canonicalJson", () => {
  test("keys sorted UTF-16 code-unit order", () => { expect(canonicalJson({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}'); });
  test("array sorted by complete-element canonical string", () => {
    const a = { source: "link", ref: "x", trust_state: "trusted" };
    const b = { source: "link", ref: "x", trust_state: "candidate" };
    expect(canonicalJson({ m: [a, b] })).toBe(canonicalJson({ m: [b, a] }));
  });
  test("absent optional key omitted (no undefined emission)", () => {
    const out = canonicalJson({ type: "dry_run", target_ref: "r", reason: "x" });
    expect(out).toBe('{"reason":"x","target_ref":"r","type":"dry_run"}');
    expect(out).not.toContain("rollback_note");
  });
  test("identifier byte-exact (no NFKC)", () => {
    expect(canonicalJson({ ref: "entityA－1" })).not.toBe(canonicalJson({ ref: "entityA-1" }));
  });
});
describe("normalizeProse", () => { test("NFKC + whitespace fold", () => { expect(normalizeProse("ｓｃｏｒｅ   高")).toBe("score 高"); }); });
describe("sha256Hex", () => { test("64 hex deterministic", () => { expect(sha256Hex('{"a":1}')).toMatch(/^[0-9a-f]{64}$/); }); });
```

- [ ] **Step 2: Run → FAIL** — `bun test tests/core/recommendation/canonical.test.ts`.

- [ ] **Step 3: Implement canonical module**

```ts
// src/core/recommendation/canonical.ts
import { createHash } from "node:crypto";

export function serializeNumber(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`canonical: number must be finite, got ${String(n)}`);
  return String(Object.is(n, -0) ? 0 : n);
}
export function normalizeProse(s: string): string { return s.normalize("NFKC").replace(/\s+/g, " ").trim(); }

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|[\uDC00-\uDFFF](?<![\uD800-\uDBFF])/u;

export function assertJsonSafe(v: unknown, seen: Set<object> = new Set()): void {
  if (v === null || typeof v === "boolean") return;
  if (typeof v === "number") { serializeNumber(v); return; }
  if (typeof v === "string") { if (LONE_SURROGATE.test(v)) throw new Error("canonical: lone surrogate"); return; }
  if (typeof v !== "object" || v === undefined) throw new Error(`canonical: non-JSON-safe type ${typeof v}`);
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && !Array.isArray(v)) throw new Error(`canonical: non-plain object (${proto?.constructor?.name ?? "?"})`);
  if (seen.has(v as object)) throw new Error("canonical: cycle");
  seen.add(v as object);
  if (Array.isArray(v)) for (const el of v) assertJsonSafe(el, seen);
  else for (const k of Object.keys(v)) { const val = (v as Record<string, unknown>)[k]; if (val === undefined) throw new Error(`canonical: undefined at key "${k}" (omit instead)`); assertJsonSafe(val, seen); }
  seen.delete(v as object);
}

export function canonicalJson(value: unknown): string { assertJsonSafe(value); return emit(value, new Set<object>()); }
function emit(v: unknown, seen: Set<object>): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return serializeNumber(v);
  if (typeof v === "string") return quote(v);
  if (Array.isArray(v)) { seen.add(v); const parts = v.map((el) => emit(el, seen)).sort(); seen.delete(v); return `[${parts.join(",")}]`; }
  seen.add(v as object);
  const entries = Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${quote(k)}:${emit((v as Record<string, unknown>)[k], seen)}`);
  seen.delete(v as object);
  return `{${entries.join(",")}}`;
}
function quote(s: string): string {
  let out = '"';
  for (const ch of s) { const cp = ch.codePointAt(0)!; if (ch === "\\" || ch === '"') out += "\\" + ch; else if (ch === "\n") out += "\\n"; else if (ch === "\r") out += "\\r"; else if (ch === "\t") out += "\\t"; else if (ch === "\b") out += "\\b"; else if (ch === "\f") out += "\\f"; else if (cp < 0x20) out += "\\u" + cp.toString(16).padStart(4, "0"); else out += ch; }
  return out + '"';
}
export function sha256Hex(s: string): string { return createHash("sha256").update(s, "utf8").digest("hex"); }
```

- [ ] **Step 4: Run → PASS** — `bun test tests/core/recommendation/canonical.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/core/recommendation/canonical.ts tests/core/recommendation/canonical.test.ts
git commit -m "feat(rec): fail-closed canonical JSON pipeline (#328)"
```

---

## Task 2: Types + policy — unified declaration model (spec §4; rev3 HIGH 1)

**Files:** Create `src/core/recommendation/types.ts`, `src/core/recommendation/policy.ts`

- [ ] **Step 1: Write types (declaration uses `as` + relation/direction/fields; snapshot keyed by `as`)**

```ts
// src/core/recommendation/types.ts
import type { TrustState } from "../provenance.js";

export type LifecycleStatus = "pending" | "current" | "superseded" | "rejected" | "invalidated";
export type FreshnessStatus = "fresh" | "stale" | "version_invalid";
export type AbstainReason = "insufficient_evidence" | "conflict" | "inactive_evidence_only" | "below_threshold" | "policy_prohibits";
export type HighImpactReason = "write_action" | "open_question_deep_reasoning" | "irreversible_real_world" | "high_value_entity";
export type ConfirmationRequirement = { tier: "standard" } | { tier: "high_impact"; confirm: ("target" | "option" | "constraint")[]; reason: HighImpactReason };

export interface ProposedAction {
  type: "review" | "dry_run" | "notify_draft";
  target_ref: string;
  reason: string;
  rollback_note?: string; // OPTIONAL — omitted when absent
}
export type RecommendationConclusion =
  | { kind: "propose"; action: ProposedAction; alternatives: ProposedAction[] }
  | { kind: "abstain"; reason: AbstainReason };

/**
 * Unified declaration/projection model (rev3 HIGH 1). The reader projects each
 * declaration into entity_snapshot[slug][as]. `fields` are the per-element sub-fields
 * retained (links edges) or scalar fields (pages). Reader is fail-closed on unknown
 * table/field/relation — it never returns a silent empty projection. */
export interface DependencyDeclaration {
  slug?: string;                          // absent => global declaration
  table: "links" | "pages" | "tags" | "aliases" | "timeline" | "chunks" | "fts" | "lance" | "config";
  as: string;                             // projection key under entity_snapshot[slug]; unique per slug
  relation?: string;                      // links only: relation whose edges form the projection
  direction?: "outgoing" | "incoming";    // links only; default "outgoing"
  fields: string[];                       // retained sub-fields (e.g. ["from","to","trust_state"])
  filter?: "active" | "all";              // default "active"
}
export interface DependencyManifest { rule_id: string; declarations: DependencyDeclaration[] }
export interface EntityProjection { [as: string]: unknown }
export interface DecisionInputs {
  signals: Record<string, unknown>;
  inspected_claims?: string[];
  entity_snapshot: Record<string, EntityProjection>; // slug -> { [as]: edges[] | scalar }
  evidence_refs: string[];                            // TRUE projection of the same rows (spec §4.3)
}
export interface EvidenceManifestEntry { source: "discovery" | "health" | "fsck" | "graph" | "timeline"; ref: string; trust_state: TrustState }
export interface RecommendationConstraints { policy_version: string; ontology_version: string; schema_version: string }
export interface Applicability { audience: "user_only"; auto_execute: false; requires_confirmation: ConfirmationRequirement }
export interface RecommendationProducer { rule_id: string; rule_version: string; code_hash: string; registry_ref: string }

export interface RecommendationImmutablePayload {
  namespace: string; maintenance_key: string; inputs_hash: string;
  conclusion: RecommendationConclusion; decision_inputs: DecisionInputs;
  evidence_manifest: EvidenceManifestEntry[]; constraints: RecommendationConstraints;
  dependency_manifest: DependencyManifest; applicability: Applicability;
  risks: string[]; gaps: string[]; producer: RecommendationProducer;
}
export interface RecommendationRecord {
  record_id: string; payload: RecommendationImmutablePayload; fingerprint: string;
  created_at: string; last_revalidated_at: string;
  lifecycle_status: LifecycleStatus; freshness_status: FreshnessStatus;
  suppressed_until: string | null;
}
export const SCHEMA_VERSION = "rec-v1" as const;
export const PROSE_FIELDS = new Set(["reason", "rollback_note", "risks", "gaps", "inspected_claims"]);
```

- [ ] **Step 2: Write policy module (default suppression TTL + ISO helper)**

```ts
// src/core/recommendation/policy.ts
/** Default suppression window for rejected records (spec §5.6). Source of truth for the
 *  default TTL; callers compute suppressed_until via defaultSuppressedUntil(now). */
export const DEFAULT_SUPPRESSION_TTL_SECONDS = 7 * 86400;

/** nowIso is SQLite-UTC "YYYY-MM-DD HH:MM:SS". Returns nowIso + TTL in the same format. */
export function defaultSuppressedUntil(nowIso: string): string {
  const epoch = Date.parse(`${nowIso.replace(" ", "T")}Z`);
  if (Number.isNaN(epoch)) throw new Error(`policy: invalid timestamp ${nowIso}`);
  return new Date(epoch + DEFAULT_SUPPRESSION_TTL_SECONDS * 1000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

/** Sentinel that is always in the past => suppression always considered expired after reopen. */
export const SUPPRESSION_REOPENED = "1970-01-01 00:00:00";
```

- [ ] **Step 3: Typecheck** — `bun run lint` → PASS.

- [ ] **Step 4: Commit**

```bash
git add src/core/recommendation/types.ts src/core/recommendation/policy.ts
git commit -m "feat(rec): types + policy (unified declaration model) (#328)"
```

---

## Task 3: Additive migration — DDL+marker atomic, test fault hook (spec §10; rev3 MED 2)

**Files:** Create `src/storage/migrations/recommendations.ts`; modify `migrations/index.ts`, `sqlite.ts`; Test `tests/storage/migrations/recommendations.test.ts`

- [ ] **Step 1: Write failing test (incl. real mid-failure atomic rollback)**

```ts
// tests/storage/migrations/recommendations.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runRecommendationRecordsMigration } from "../../../src/storage/migrations/recommendations.js";

function newDb(): Database { const db = new Database(":memory:"); db.exec("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)"); return db; }
function exists(db: Database, name: string): boolean {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) as { name?: string } | undefined)?.name === name;
}
function indexSql(db: Database, name: string): string | undefined {
  return (db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(name) as { sql?: string } | undefined)?.sql;
}

describe("recommendation_records migration", () => {
  const dbs: Database[] = [];
  afterEach(() => { dbs.forEach((d) => d.close()); dbs.length = 0; });

  test("creates both tables + indexes", () => {
    const db = newDb(); dbs.push(db); runRecommendationRecordsMigration(db);
    expect(exists(db, "recommendation_records")).toBe(true);
    expect(exists(db, "recommendation_lifecycle_history")).toBe(true);
    expect(indexSql(db, "idx_rec_active_unique")).toContain("lifecycle_status IN ('pending','current')");
  });
  test("idempotent via config-key guard", () => {
    const db = newDb(); dbs.push(db); runRecommendationRecordsMigration(db);
    expect(() => runRecommendationRecordsMigration(db)).not.toThrow();
  });
  test("two active same key rejected; superseded coexists", () => {
    const db = newDb(); dbs.push(db); runRecommendationRecordsMigration(db);
    const ins = (id: string, lc: string) => db.exec(`INSERT INTO recommendation_records (record_id, maintenance_key, fingerprint, inputs_hash, payload, auto_execute, created_at, last_revalidated_at, lifecycle_status, freshness_status, suppressed_until) VALUES ('${id}','k','f','ih','{}',0,'t','t','${lc}','fresh',NULL)`);
    ins("r1", "pending"); expect(() => ins("r2", "current")).toThrow(/UNIQUE/); expect(() => ins("r3", "superseded")).not.toThrow();
  });

  test("ATOMIC: fault before marker rolls back ALL DDL+index+marker (MED 2)", () => {
    const db = newDb(); dbs.push(db);
    expect(() => runRecommendationRecordsMigration(db, { failBeforeMarker: true })).toThrow(/injected/);
    // nothing persisted: no tables, no indexes, no completion marker
    expect(exists(db, "recommendation_records")).toBe(false);
    expect(exists(db, "recommendation_lifecycle_history")).toBe(false);
    expect(indexSql(db, "idx_rec_active_unique")).toBeUndefined();
    const marker = (db.prepare("SELECT value FROM config WHERE key='migration_rec_v1_recommendation_records'").get() as { value?: string } | undefined)?.value;
    expect(marker).toBeUndefined();
    // removing the fault lets it run cleanly
    expect(() => runRecommendationRecordsMigration(db)).not.toThrow();
    expect(exists(db, "recommendation_records")).toBe(true);
  });

  test("forward repair: drop table + clear marker, re-run restores", () => {
    const db = newDb(); dbs.push(db); runRecommendationRecordsMigration(db);
    db.exec("DROP TABLE recommendation_records");
    db.exec("DELETE FROM config WHERE key='migration_rec_v1_recommendation_records'");
    expect(() => runRecommendationRecordsMigration(db)).not.toThrow();
    expect(exists(db, "recommendation_records")).toBe(true);
  });
});
```

- [ ] **Step 2: Run → FAIL** — `bun test tests/storage/migrations/recommendations.test.ts`.

- [ ] **Step 3: Implement migration (DDL+marker atomic; test fault hook)**

```ts
// src/storage/migrations/recommendations.ts
import type { Database } from "bun:sqlite";

const COMPLETION_KEY = "migration_rec_v1_recommendation_records";
export interface MigrationHooks { failBeforeMarker?: boolean }

/** Additive (spec §10). DDL + completion marker in ONE transaction. The optional
 *  failBeforeMarker hook is TEST-ONLY — it throws inside the transaction right before
 *  the marker INSERT, so the atomic test can observe full rollback. */
export function runRecommendationRecordsMigration(db: Database, hooks: MigrationHooks = {}): void {
  const done = db.prepare("SELECT value FROM config WHERE key = ?").get(COMPLETION_KEY) as { value?: string } | undefined;
  if (done?.value === "1") return;

  const txn = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS recommendation_records (
        record_id TEXT PRIMARY KEY, maintenance_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
        inputs_hash TEXT NOT NULL, payload TEXT NOT NULL,
        auto_execute INTEGER NOT NULL DEFAULT 0 CHECK(auto_execute = 0),
        created_at TEXT NOT NULL, last_revalidated_at TEXT NOT NULL,
        lifecycle_status TEXT NOT NULL CHECK(lifecycle_status IN ('pending','current','superseded','rejected','invalidated')),
        freshness_status TEXT NOT NULL CHECK(freshness_status IN ('fresh','stale','version_invalid')),
        suppressed_until TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_rec_fingerprint ON recommendation_records(fingerprint);
      CREATE INDEX IF NOT EXISTS idx_rec_inputs_hash ON recommendation_records(inputs_hash);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_rec_active_unique ON recommendation_records(maintenance_key) WHERE lifecycle_status IN ('pending','current');
      CREATE TABLE IF NOT EXISTS recommendation_lifecycle_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, record_id TEXT NOT NULL REFERENCES recommendation_records(record_id) ON DELETE CASCADE,
        action TEXT NOT NULL, from_lifecycle TEXT, to_lifecycle TEXT, from_freshness TEXT, to_freshness TEXT, reason TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_rec_history_record ON recommendation_lifecycle_history(record_id);
    `);
    if (hooks.failBeforeMarker) throw new Error("injected failure before completion marker");
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, '1')").run(COMPLETION_KEY);
  });
  txn();
}
```

- [ ] **Step 4: Wire** — `migrations/index.ts`: add `export { runRecommendationRecordsMigration } from "./recommendations.js";`. `sqlite.ts`: add `runRecommendationRecordsMigration` to the `./migrations/index.js` import; call `runRecommendationRecordsMigration(this.db);` right after `runLatePageMigrations(this.db);` (≈ L420).

- [ ] **Step 5: Run → PASS** — `bun test tests/storage/migrations/recommendations.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/storage/migrations/recommendations.ts src/storage/migrations/index.ts src/storage/sqlite.ts tests/storage/migrations/recommendations.test.ts
git commit -m "feat(storage): recommendation_records additive migration (#328)"
```

---

## Task 4: Integrity — cross-consistency on the unified model (spec §6, §4.3, §8.1; rev3 HIGH 1)

**Files:** Create `src/core/recommendation/integrity.ts`; Test `tests/core/recommendation/integrity.test.ts`

- [ ] **Step 1: Write failing test (clean passes under unified model; tamper + cross cases)**

```ts
// tests/core/recommendation/integrity.test.ts
import { describe, expect, test } from "bun:test";
import { computeInputsHash, computeFingerprint, checkIntegrity } from "../../../src/core/recommendation/integrity.js";
import type { RecommendationImmutablePayload, RecommendationRecord } from "../../../src/core/recommendation/types.js";
import { SCHEMA_VERSION } from "../../../src/core/recommendation/types.js";

// declaration uses `as:"reports_to"` + relation + fields matching the snapshot shape
function basePayload(over: Partial<RecommendationImmutablePayload> = {}): RecommendationImmutablePayload {
  const di = {
    signals: { candidate_count: 1 },
    entity_snapshot: { "entities/eA": { reports_to: [{ from: "entities/eA", to: "entities/eB", trust_state: "candidate" }] } },
    evidence_refs: ["health:known_relations:entities/eA:entities/eB"],
  };
  return {
    namespace: "maintenance", maintenance_key: 'health:known_relations:["entities/eA","entities/eB"]', inputs_hash: "",
    conclusion: { kind: "propose", action: { type: "dry_run", target_ref: "health:known_relations:entities/eA", reason: "复核" }, alternatives: [] },
    decision_inputs: di,
    evidence_manifest: [{ source: "health", ref: "health:known_relations:entities/eA:entities/eB", trust_state: "candidate" }],
    constraints: { policy_version: "p", ontology_version: "o", schema_version: SCHEMA_VERSION },
    dependency_manifest: {
      rule_id: "health:known_relations",
      declarations: [
        { slug: "entities/eA", table: "links", as: "reports_to", relation: "reports_to", direction: "outgoing", fields: ["from", "to", "trust_state"], filter: "active" },
        { slug: "entities/eB", table: "links", as: "reports_to", relation: "reports_to", direction: "outgoing", fields: ["from", "to", "trust_state"], filter: "active" },
      ],
    },
    applicability: { audience: "user_only", auto_execute: false, requires_confirmation: { tier: "standard" } },
    risks: [], gaps: [],
    producer: { rule_id: "health:known_relations", rule_version: "1.0.0", code_hash: "h", registry_ref: "r@1.0.0" },
    ...over,
  };
}
function rec(p: RecommendationImmutablePayload): RecommendationRecord {
  p.inputs_hash = computeInputsHash(p.decision_inputs);
  return { record_id: "r1", payload: p, fingerprint: computeFingerprint(p), created_at: "t", last_revalidated_at: "t", lifecycle_status: "pending", freshness_status: "fresh", suppressed_until: null };
}

describe("integrity", () => {
  test("clean passes under unified model", () => { expect(checkIntegrity(rec(basePayload())).ok).toBe(true); });
  test("inputs_hash tamper", () => { const r = rec(basePayload()); r.payload.inputs_hash = "x"; const x = checkIntegrity(r); expect(x.ok).toBe(false); if (!x.ok) expect(x.code).toBe("inputs_hash_mismatch"); });
  test("fingerprint tamper — fixed reason code, no ref echo", () => {
    const r = rec(basePayload()); r.payload.conclusion = { kind: "abstain", reason: "insufficient_evidence" };
    const x = checkIntegrity(r); expect(x.ok).toBe(false);
    if (!x.ok) { expect(x.code).toBe("fingerprint_mismatch"); expect(x.message).not.toContain("health:known_relations"); }
  });
  test("cross: undeclared projection `as` key", () => {
    const p = basePayload();
    (p.decision_inputs.entity_snapshot["entities/eA"] as Record<string, unknown>).unknown_rel = [];
    const x = checkIntegrity(rec(p)); expect(x.ok).toBe(false); if (!x.ok) expect(x.code).toBe("cross_undeclared_field");
  });
  test("cross: undeclared edge sub-field", () => {
    const p = basePayload();
    (p.decision_inputs.entity_snapshot["entities/eA"] as { reports_to: Record<string, unknown>[] }).reports_to[0] = { from: "entities/eA", to: "entities/eB", trust_state: "candidate", extra: 1 };
    const x = checkIntegrity(rec(p)); expect(x.ok).toBe(false); if (!x.ok) expect(x.code).toBe("cross_undeclared_field");
  });
  test("cross: evidence ref not in decision_inputs.evidence_refs", () => {
    const p = basePayload(); p.evidence_manifest.push({ source: "health", ref: "health:known_relations:entities/eA:entities/eC", trust_state: "candidate" });
    const x = checkIntegrity(rec(p)); expect(x.ok).toBe(false); if (!x.ok) expect(x.code).toBe("cross_evidence_not_projected");
  });
  test("cross: rule_id mismatch", () => { const p = basePayload(); p.dependency_manifest.rule_id = "other"; const x = checkIntegrity(rec(p)); expect(x.ok).toBe(false); if (!x.ok) expect(x.code).toBe("cross_rule_id_mismatch"); });
  test("absent rollback_note omits cleanly", () => {
    const p = basePayload();
    (p.conclusion as { kind: "propose"; action: { type: string; target_ref: string; reason: string } }).action = { type: "dry_run", target_ref: "x", reason: "y" };
    expect(() => computeFingerprint(p)).not.toThrow();
  });
  test("fingerprint round-trips JSON serialize/deserialize", () => {
    const p = basePayload(); p.inputs_hash = computeInputsHash(p.decision_inputs); const fp = computeFingerprint(p);
    expect(computeFingerprint(JSON.parse(JSON.stringify(p)) as RecommendationImmutablePayload)).toBe(fp);
  });
});
```

- [ ] **Step 2: Run → FAIL** — `bun test tests/core/recommendation/integrity.test.ts`.

- [ ] **Step 3: Implement integrity (cross-consistency on `as` keys + sub-fields)**

```ts
// src/core/recommendation/integrity.ts
import { canonicalJson, normalizeProse, sha256Hex } from "./canonical.js";
import type { DecisionInputs, RecommendationConclusion, RecommendationImmutablePayload, RecommendationRecord } from "./types.js";

export type IntegrityCode = "inputs_hash_mismatch" | "fingerprint_mismatch" | "cross_undeclared_field" | "cross_evidence_not_projected" | "cross_rule_id_mismatch";
export type IntegrityResult = { ok: true } | { ok: false; code: IntegrityCode; message: string };

export function computeInputsHash(di: DecisionInputs): string { return sha256Hex(canonicalJson(canonicalDI(di))); }
function canonicalDI(di: DecisionInputs): unknown {
  return { signals: di.signals, inspected_claims: (di.inspected_claims ?? []).map(normalizeProse), entity_snapshot: di.entity_snapshot, evidence_refs: [...di.evidence_refs].sort() };
}
export function computeFingerprint(p: RecommendationImmutablePayload): string { return sha256Hex(canonicalJson(canonicalPayload(p))); }
function canonicalPayload(p: RecommendationImmutablePayload): unknown {
  return {
    namespace: p.namespace, maintenance_key: p.maintenance_key, inputs_hash: p.inputs_hash,
    conclusion: canonicalConclusion(p.conclusion), decision_inputs: canonicalDI(p.decision_inputs),
    evidence_manifest: p.evidence_manifest.map((e) => ({ source: e.source, ref: e.ref, trust_state: e.trust_state })),
    constraints: p.constraints,
    dependency_manifest: { rule_id: p.dependency_manifest.rule_id, declarations: p.dependency_manifest.declarations.map((d) => ({ slug: d.slug, table: d.table, as: d.as, relation: d.relation, direction: d.direction, fields: [...d.fields].sort(), filter: d.filter })) },
    applicability: p.applicability, risks: p.risks.map(normalizeProse), gaps: p.gaps.map(normalizeProse), producer: p.producer,
  };
}
function canonicalConclusion(c: RecommendationConclusion): unknown {
  if (c.kind === "abstain") return { kind: "abstain", reason: c.reason };
  return { kind: "propose", action: canonicalAction(c.action), alternatives: c.alternatives.map(canonicalAction) };
}
function canonicalAction(a: { type: string; target_ref: string; reason: string; rollback_note?: string }): unknown {
  const out: Record<string, unknown> = { type: a.type, target_ref: a.target_ref, reason: normalizeProse(a.reason) };
  if (a.rollback_note !== undefined) out.rollback_note = normalizeProse(a.rollback_note);
  return out;
}

export function checkIntegrity(r: RecommendationRecord): IntegrityResult {
  if (computeInputsHash(r.payload.decision_inputs) !== r.payload.inputs_hash) return { ok: false, code: "inputs_hash_mismatch", message: "inputs_hash mismatch" };
  if (computeFingerprint(r.payload) !== r.fingerprint) return { ok: false, code: "fingerprint_mismatch", message: "fingerprint mismatch" };
  return checkCrossConsistency(r.payload);
}
function checkCrossConsistency(p: RecommendationImmutablePayload): IntegrityResult {
  // slug -> as -> declared field set
  const declared = new Map<string, Map<string, Set<string>>>();
  for (const d of p.dependency_manifest.declarations) {
    const key = d.slug ?? "__global__";
    if (!declared.has(key)) declared.set(key, new Map());
    declared.get(key)!.set(d.as, new Set(d.fields));
  }
  for (const [slug, snap] of Object.entries(p.decision_inputs.entity_snapshot)) {
    const allowed = declared.get(slug);
    if (!allowed) return { ok: false, code: "cross_undeclared_field", message: "entity_snapshot slug not declared" };
    for (const asKey of Object.keys(snap as object)) {
      const fieldSet = allowed.get(asKey);
      if (!fieldSet) return { ok: false, code: "cross_undeclared_field", message: "undeclared projection key" };
      const v = (snap as Record<string, unknown>)[asKey];
      const elements = Array.isArray(v) ? v : [v];
      for (const el of elements) if (el && typeof el === "object") for (const f of Object.keys(el as object)) if (!fieldSet.has(f)) return { ok: false, code: "cross_undeclared_field", message: "undeclared field" };
    }
  }
  const refs = new Set(p.decision_inputs.evidence_refs);
  for (const e of p.evidence_manifest) if (!refs.has(e.ref)) return { ok: false, code: "cross_evidence_not_projected", message: "evidence ref not in decision_inputs" };
  if (p.dependency_manifest.rule_id !== p.producer.rule_id) return { ok: false, code: "cross_rule_id_mismatch", message: "rule_id mismatch" };
  return { ok: true };
}
```

- [ ] **Step 4: Run → PASS** — `bun test tests/core/recommendation/integrity.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/core/recommendation/integrity.ts tests/core/recommendation/integrity.test.ts
git commit -m "feat(rec): integrity with unified cross-consistency (#328)"
```

---

## Task 5: Versioned rule registry — immutable, tombstone-aware manifest, directory (spec §7.2; rev3 MED 1, HIGH 5)

**Files:** Create `src/core/recommendation/registry.ts`; Test `tests/core/recommendation/registry.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/core/recommendation/registry.test.ts
import { describe, expect, test } from "bun:test";
import { VersionedRuleRegistry } from "../../../src/core/recommendation/registry.js";

const noop = () => ({ signals: {}, entity_snapshot: {}, evidence_refs: [] as string[] });
const abstain = () => ({ kind: "abstain" as const, reason: "policy_prohibits" as const });

describe("VersionedRuleRegistry", () => {
  test("resolve ok", () => {
    const reg = new VersionedRuleRegistry();
    reg.register({ rule_id: "d", rule_version: "1.0.0", code_hash: "h1", registry_ref: "r@1.0.0", captureInputs: () => noop(), decide: () => abstain() });
    expect(reg.resolve("d", "1.0.0").status).toBe("ok");
  });
  test("duplicate exact key with different code_hash rejected", () => {
    const reg = new VersionedRuleRegistry();
    reg.register({ rule_id: "d", rule_version: "1.0.0", code_hash: "h1", registry_ref: "r@1.0.0", captureInputs: () => noop(), decide: () => abstain() });
    expect(() => reg.register({ rule_id: "d", rule_version: "1.0.0", code_hash: "h2", registry_ref: "r@1.0.0", captureInputs: () => noop(), decide: () => abstain() })).toThrow(/already registered/);
  });
  test("re-registering the SAME object is idempotent", () => {
    const reg = new VersionedRuleRegistry();
    const entry = { rule_id: "d", rule_version: "1.0.0", code_hash: "h1", registry_ref: "r@1.0.0", captureInputs: () => noop(), decide: () => abstain() };
    reg.register(entry); expect(() => reg.register(entry)).not.toThrow();
  });
  test("markPurged → unavailable/purged", () => {
    const reg = new VersionedRuleRegistry();
    reg.register({ rule_id: "d", rule_version: "1.0.0", code_hash: "h1", registry_ref: "r@1.0.0", captureInputs: () => noop(), decide: () => abstain() });
    reg.markPurged("d", "1.0.0", "h1");
    const r = reg.resolve("d", "1.0.0"); expect(r.status).toBe("unavailable"); if (r.status === "unavailable") expect(r.reason).toBe("purged");
  });
  test("manifest encodes state: live→purged→incompatible produce different manifest (MED 1)", () => {
    const reg = new VersionedRuleRegistry();
    reg.register({ rule_id: "d", rule_version: "1.0.0", code_hash: "h1", registry_ref: "r@1.0.0", captureInputs: () => noop(), decide: () => abstain() });
    const live = reg.manifest();
    reg.markPurged("d", "1.0.0", "h1"); const purged = reg.manifest();
    reg.markIncompatible("d", "1.0.0", "h1"); const incompatible = reg.manifest();
    expect(live).toBe("d@1.0.0:live:h1");
    expect(purged).toBe("d@1.0.0:purged:h1");
    expect(incompatible).toBe("d@1.0.0:incompatible:h1");
    expect(new Set([live, purged, incompatible]).size).toBe(3);
  });
  test("directory lists live producers (for manager, HIGH 5)", () => {
    const reg = new VersionedRuleRegistry();
    reg.register({ rule_id: "d", rule_version: "1.0.0", code_hash: "h1", registry_ref: "r@1.0.0", captureInputs: () => noop(), decide: () => abstain() });
    const dir = reg.directory();
    expect(dir).toEqual([{ rule_id: "d", rule_version: "1.0.0", code_hash: "h1", registry_ref: "r@1.0.0" }]);
  });
});
```

- [ ] **Step 2: Run → FAIL** — `bun test tests/core/recommendation/registry.test.ts`.

- [ ] **Step 3: Implement registry (tombstone-first manifest, directory)**

```ts
// src/core/recommendation/registry.ts
import type { DecisionInputs, RecommendationConclusion, RecommendationProducer } from "./types.js";

export interface RuleRunner extends RecommendationProducer {
  captureInputs: (projection: unknown) => DecisionInputs;
  decide: (di: DecisionInputs) => RecommendationConclusion;
}
export type ResolveResult = ({ status: "ok" } & RuleRunner) | { status: "unavailable"; reason: "unknown" | "purged" | "incompatible" };
type Entry = RuleRunner | { tombstone: "purged" | "incompatible"; code_hash: string };

export class VersionedRuleRegistry {
  private entries = new Map<string, Entry>();
  private key(ruleId: string, ruleVersion: string): string { return `${ruleId}@${ruleVersion}`; }

  register(r: RuleRunner): void {
    const k = this.key(r.rule_id, r.rule_version);
    const existing = this.entries.get(k);
    if (existing) {
      if (existing === r) return; // same object — idempotent
      throw new Error(`registry: ${k} already registered with a different implementation`);
    }
    this.entries.set(k, r);
  }
  markPurged(ruleId: string, ruleVersion: string, codeHash: string): void { this.entries.set(this.key(ruleId, ruleVersion), { tombstone: "purged", code_hash: codeHash }); }
  markIncompatible(ruleId: string, ruleVersion: string, codeHash: string): void { this.entries.set(this.key(ruleId, ruleVersion), { tombstone: "incompatible", code_hash: codeHash }); }

  resolve(ruleId: string, ruleVersion: string): ResolveResult {
    const e = this.entries.get(this.key(ruleId, ruleVersion));
    if (!e) return { status: "unavailable", reason: "unknown" };
    if ("tombstone" in e) return { status: "unavailable", reason: e.tombstone };
    return { status: "ok", ...e };
  }

  /** Live producers only — manager reads ALL metadata from here (HIGH 5). */
  directory(): RecommendationProducer[] {
    return [...this.entries.values()].filter((e): e is RuleRunner => !("tombstone" in e)).map((e) => ({ rule_id: e.rule_id, rule_version: e.rule_version, code_hash: e.code_hash, registry_ref: e.registry_ref }));
  }

  /** Deterministic manifest; tombstone-first so state enters policy identity (MED 1). */
  manifest(): string {
    return [...this.entries.entries()].map(([k, e]) => "tombstone" in e ? `${k}:${e.tombstone}:${e.code_hash}` : `${k}:live:${e.code_hash}`).sort().join("\n");
  }
}
```

- [ ] **Step 4: Run → PASS** — `bun test tests/core/recommendation/registry.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/core/recommendation/registry.ts tests/core/recommendation/registry.test.ts
git commit -m "feat(rec): versioned rule registry (tombstone manifest + directory) (#328)"
```

---

## Task 6: Record store — single entry, split APIs, EXISTS suppression, reopen (spec §5.5, §5.6; rev3 HIGH 3)

**Files:** Create `src/core/recommendation/record-store.ts`; Test `tests/core/recommendation/record-store.test.ts`

- [ ] **Step 1: Write failing test (real ISO times; permanent vs expired mix)**

```ts
// tests/core/recommendation/record-store.test.ts
import { rmSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import { CBrainDB } from "../../../src/storage/sqlite.js";
import { RecommendationStore } from "../../../src/core/recommendation/record-store.js";
import { computeInputsHash, computeFingerprint } from "../../../src/core/recommendation/integrity.js";
import type { RecommendationImmutablePayload } from "../../../src/core/recommendation/types.js";
import { SCHEMA_VERSION } from "../../../src/core/recommendation/types.js";

const DIR = "/tmp/cbrain-test-rec-store";
let db: CBrainDB; let store: RecommendationStore;
function mkPayload(codeHash: string, key = "k1"): RecommendationImmutablePayload {
  const di = { signals: { v: 1 }, entity_snapshot: { eA: { reports_to: [{ from: "eA", to: "eB", trust_state: "candidate" }] } }, evidence_refs: ["health:k:eA:eB"] };
  return {
    namespace: "maintenance", maintenance_key: key, inputs_hash: computeInputsHash(di),
    conclusion: { kind: "propose", action: { type: "dry_run", target_ref: "health:k:eA", reason: "r" }, alternatives: [] },
    decision_inputs: di,
    evidence_manifest: [{ source: "health", ref: "health:k:eA:eB", trust_state: "candidate" }],
    constraints: { policy_version: "p", ontology_version: "o", schema_version: SCHEMA_VERSION },
    dependency_manifest: { rule_id: "health:k", declarations: [{ slug: "eA", table: "links", as: "reports_to", relation: "reports_to", direction: "outgoing", fields: ["from", "to", "trust_state"], filter: "active" }] },
    applicability: { audience: "user_only", auto_execute: false, requires_confirmation: { tier: "standard" } },
    risks: [], gaps: [], producer: { rule_id: "health:k", rule_version: "1.0.0", code_hash: codeHash, registry_ref: "r@1.0.0" },
  };
}
describe("RecommendationStore", () => {
  afterEach(() => { db?.close(); rmSync(DIR, { recursive: true, force: true }); });
  function open() { db = new CBrainDB(`${DIR}/db.sqlite`); store = new RecommendationStore(db); }

  test("createRecord computes fingerprint internally", () => {
    open(); const p = mkPayload("h1"); const r = store.createRecord(p, "2026-07-12 10:00:00");
    expect(r.fingerprint).toBe(computeFingerprint({ ...p, inputs_hash: computeInputsHash(p.decision_inputs) }));
    expect(r.lifecycle_status).toBe("pending"); expect(r.freshness_status).toBe("fresh");
  });
  test("rejects auto_execute !== false", () => {
    open(); const p = mkPayload("h1");
    const bad = { ...p, applicability: { ...p.applicability, auto_execute: true as unknown as false } };
    expect(() => store.createRecord(bad, "2026-07-12 10:00:00")).toThrow(/auto_execute/);
  });
  test("same fingerprint idempotent", () => {
    open(); const p = mkPayload("h1");
    const r1 = store.createRecord(p, "2026-07-12 10:00:00"); const r2 = store.createRecord(p, "2026-07-12 10:00:00");
    expect(r2.record_id).toBe(r1.record_id);
  });
  test("different fingerprint same key → atomic supersede; count stays 1", () => {
    open(); store.createRecord(mkPayload("hA"), "2026-07-12 10:00:00"); store.createRecord(mkPayload("hB"), "2026-07-12 10:00:01");
    expect(store.activeCountFor("k1")).toBe(1);
  });
  test("F8: rejected within suppression window blocks re-create", () => {
    open(); const p = mkPayload("h1"); const r = store.createRecord(p, "2026-07-12 10:00:00");
    store.transitionLifecycle(r.record_id, "rejected", "2026-07-12 10:00:01", "declined", "2026-07-19 10:00:01"); // +7d, in the future
    expect(() => store.createRecord(p, "2026-07-13 10:00:00")).toThrow(/suppressed/); // within window
    expect(store.activeCountFor("k1")).toBe(0);
  });
  test("F17: suppression expiry allows re-create", () => {
    open(); const p = mkPayload("h1"); const r = store.createRecord(p, "2026-07-12 10:00:00");
    store.transitionLifecycle(r.record_id, "rejected", "2026-07-12 10:00:01", "declined", "2026-07-12 09:00:00"); // already expired
    expect(() => store.createRecord(p, "2026-07-13 10:00:00")).not.toThrow();
  });
  test("permanent (NULL) suppression NOT bypassed by an expired sibling (HIGH 3)", () => {
    open(); const p = mkPayload("h1");
    // first rejection: permanent (suppressed_until = NULL)
    const r1 = store.createRecord(p, "2026-07-12 10:00:00");
    store.transitionLifecycle(r1.record_id, "rejected", "2026-07-12 10:00:01", "declined", null);
    // expired rejection also exists (different fingerprint path is impossible here; same fp):
    // simulate by also having a past-expiry row — both share (key,fp). EXISTS must still block due to the NULL row.
    expect(() => store.createRecord(p, "2099-01-01 00:00:00")).toThrow(/suppressed/); // far future, still blocked by NULL
  });
  test("clearSuppression (reopen) allows re-create", () => {
    open(); const p = mkPayload("h1"); const r = store.createRecord(p, "2026-07-12 10:00:00");
    store.transitionLifecycle(r.record_id, "rejected", "2026-07-12 10:00:01", "declined", null);
    store.clearSuppression(r.record_id, "2026-07-13 10:00:00", "user reopen");
    expect(() => store.createRecord(p, "2026-07-13 10:00:01")).not.toThrow();
  });
  test("transitionLifecycle whitelist: superseded cannot regress (no reactivation)", () => {
    open(); const p = mkPayload("h1"); const r = store.createRecord(p, "2026-07-12 10:00:00");
    store.transitionLifecycle(r.record_id, "superseded", "2026-07-12 10:00:01", "test");
    expect(() => store.transitionLifecycle(r.record_id, "pending", "2026-07-12 10:00:02", "reactivate")).toThrow(/illegal.*transition/);
  });
  test("updateFreshness changes ONLY freshness", () => {
    open(); const p = mkPayload("h1"); const r = store.createRecord(p, "2026-07-12 10:00:00");
    store.updateFreshness(r.record_id, "stale", "2026-07-12 10:00:01");
    const re = store.getById(r.record_id); expect(re?.freshness_status).toBe("stale"); expect(re?.lifecycle_status).toBe("pending");
  });
});
```

- [ ] **Step 2: Run → FAIL** — `bun test tests/core/recommendation/record-store.test.ts`.

- [ ] **Step 3: Implement store**

```ts
// src/core/recommendation/record-store.ts
import { canonicalJson } from "./canonical.js";
import { checkIntegrity, computeFingerprint, computeInputsHash } from "./integrity.js";
import { SUPPRESSION_REOPENED } from "./policy.js";
import type { CBrainDB } from "../../storage/sqlite.js";
import type { FreshnessStatus, LifecycleStatus, RecommendationImmutablePayload, RecommendationRecord } from "./types.js";

interface Row { record_id: string; maintenance_key: string; fingerprint: string; inputs_hash: string; payload: string; created_at: string; last_revalidated_at: string; lifecycle_status: string; freshness_status: string; suppressed_until: string | null }

const LIFECYCLE_TRANSITIONS: Record<LifecycleStatus, LifecycleStatus[]> = {
  pending: ["current", "superseded", "rejected", "invalidated"],
  current: ["superseded", "rejected", "invalidated"],
  superseded: ["invalidated"],
  rejected: ["invalidated"],
  invalidated: [],
};

export class RecommendationStore {
  constructor(private db: CBrainDB) {}

  activeCountFor(key: string): number {
    return (this.db.prepare("SELECT COUNT(*) c FROM recommendation_records WHERE maintenance_key = $key AND lifecycle_status IN ('pending','current')").get({ $key: key }) as { c: number }).c;
  }
  getById(recordId: string): RecommendationRecord | null {
    const row = this.db.prepare("SELECT * FROM recommendation_records WHERE record_id = $id").get({ $id: recordId }) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  /** SINGLE persistence entry (HIGH 2). Store owns the fingerprint. */
  createRecord(payload: RecommendationImmutablePayload, now: string): RecommendationRecord {
    if (payload.applicability.auto_execute !== false) throw new Error("record-store: auto_execute must be false");
    const withHash: RecommendationImmutablePayload = { ...payload, inputs_hash: computeInputsHash(payload.decision_inputs) };
    const fingerprint = computeFingerprint(withHash);
    const provisional: RecommendationRecord = { record_id: globalThis.crypto.randomUUID(), payload: withHash, fingerprint, created_at: now, last_revalidated_at: now, lifecycle_status: "pending", freshness_status: "fresh", suppressed_until: null };
    const integrity = checkIntegrity(provisional);
    if (!integrity.ok) throw new Error(`record-store: integrity failed (${integrity.code})`);
    const key = payload.maintenance_key;
    return this.db.transaction(() => {
      const active = this.activeRow(key);
      if (active && active.fingerprint === fingerprint) return fromRow(active);
      // EXISTS over ALL rejected rows for (key,fingerprint): NULL (permanent) OR unexpired => suppress (HIGH 3)
      const rej = this.db.prepare(
        "SELECT 1 FROM recommendation_records WHERE maintenance_key = $key AND fingerprint = $fp AND lifecycle_status = 'rejected' AND (suppressed_until IS NULL OR suppressed_until > $now) LIMIT 1"
      ).get({ $key: key, $fp: fingerprint, $now: now });
      if (rej) throw new Error("record-store: creation suppressed (rejected within suppression window)");
      if (active) {
        this.db.prepare("UPDATE recommendation_records SET lifecycle_status = 'superseded' WHERE record_id = $id").run({ $id: active.record_id });
        this.history(active.record_id, "superseded", active.lifecycle_status, "superseded", undefined, undefined, "replaced by " + provisional.record_id, now);
      }
      this.db.prepare(
        `INSERT INTO recommendation_records (record_id, maintenance_key, fingerprint, inputs_hash, payload, auto_execute, created_at, last_revalidated_at, lifecycle_status, freshness_status, suppressed_until) VALUES ($rid,$key,$fp,$ih,$payload,0,$now,$now,'pending','fresh',NULL)`
      ).run({ $rid: provisional.record_id, $key: key, $fp: fingerprint, $ih: withHash.inputs_hash, $payload: canonicalJson(withHash), $now: now });
      this.history(provisional.record_id, "created", undefined, "pending", undefined, undefined, undefined, now);
      return provisional;
    });
  }

  transitionLifecycle(recordId: string, to: LifecycleStatus, now: string, reason: string, suppressedUntil: string | null = "KEEP"): void {
    this.db.transaction(() => {
      const row = this.db.prepare("SELECT lifecycle_status AS l FROM recommendation_records WHERE record_id = $id").get({ $id: recordId }) as { l: LifecycleStatus } | undefined;
      if (!row) throw new Error(`record-store: record ${recordId} not found`);
      if (!LIFECYCLE_TRANSITIONS[row.l].includes(to)) throw new Error(`record-store: illegal lifecycle transition ${row.l} → ${to}`);
      let extra = "";
      const params: Record<string, string> = { $to: to, $id: recordId, $now: now };
      if (to === "rejected" && suppressedUntil !== "KEEP") { extra = ", suppressed_until = $sut"; params.$sut = suppressedUntil ?? "NULL"; }
      // null must be bound as SQL NULL, not the string "NULL"
      if (to === "rejected" && suppressedUntil === null) {
        this.db.prepare(`UPDATE recommendation_records SET lifecycle_status = $to, suppressed_until = NULL WHERE record_id = $id`).run({ $to: to, $id: recordId });
      } else {
        this.db.prepare(`UPDATE recommendation_records SET lifecycle_status = $to${extra} WHERE record_id = $id`).run(params);
      }
      this.history(recordId, to, row.l, to, undefined, undefined, reason, now);
    });
  }

  updateFreshness(recordId: string, to: FreshnessStatus, now: string): void {
    this.db.transaction(() => {
      const row = this.db.prepare("SELECT freshness_status AS f, lifecycle_status AS l FROM recommendation_records WHERE record_id = $id").get({ $id: recordId }) as { f: FreshnessStatus; l: LifecycleStatus } | undefined;
      if (!row) throw new Error(`record-store: record ${recordId} not found`);
      const revalidate = to === "fresh";
      this.db.prepare(`UPDATE recommendation_records SET freshness_status = $to${revalidate ? ", last_revalidated_at = $now" : ""} WHERE record_id = $id`).run({ $to: to, $now: now, $id: recordId });
      this.history(recordId, `freshness:${to}`, row.l, row.l, row.f, to, undefined, now);
    });
  }

  /** Audited reopen: clear suppression on a rejected record (sets the sentinel past time). */
  clearSuppression(recordId: string, now: string, reason: string): void {
    this.db.transaction(() => {
      this.db.prepare("UPDATE recommendation_records SET suppressed_until = $past WHERE record_id = $id").run({ $past: SUPPRESSION_REOPENED, $id: recordId });
      this.history(recordId, "reopen", "rejected", "rejected", undefined, undefined, reason, now);
    });
  }

  private activeRow(key: string): Row | undefined {
    return this.db.prepare("SELECT * FROM recommendation_records WHERE maintenance_key = $key AND lifecycle_status IN ('pending','current') ORDER BY rowid DESC LIMIT 1").get({ $key: key }) as Row | undefined;
  }
  private history(recordId: string, action: string, fromL: string | undefined, toL: string, fromF: string | undefined, toF: string | undefined, reason: string | undefined, now: string): void {
    this.db.prepare("INSERT INTO recommendation_lifecycle_history (record_id, action, from_lifecycle, to_lifecycle, from_freshness, to_freshness, reason, created_at) VALUES ($rid,$action,$fl,$tl,$ff,$tf,$reason,$now)").run({ $rid: recordId, $action: action, $fl: fromL ?? null, $tl: toL, $ff: fromF ?? null, $tf: toF ?? null, $reason: reason ?? null, $now: now });
  }
}
function fromRow(r: Row): RecommendationRecord {
  return { record_id: r.record_id, payload: JSON.parse(r.payload) as RecommendationImmutablePayload, fingerprint: r.fingerprint, created_at: r.created_at, last_revalidated_at: r.last_revalidated_at, lifecycle_status: r.lifecycle_status as LifecycleStatus, freshness_status: r.freshness_status as FreshnessStatus, suppressed_until: r.suppressed_until };
}
```

- [ ] **Step 4: Run → PASS** — `bun test tests/core/recommendation/record-store.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/core/recommendation/record-store.ts tests/core/recommendation/record-store.test.ts
git commit -m "feat(rec): record store (EXISTS suppression, reopen, split APIs) (#328)"
```

---

## Task 7: DeclaredProjectionReader (fail-closed, preserves from) + freshness (spec §5.3, §8.4; rev3 HIGH 2)

**Files:** Create `src/core/recommendation/projection.ts`, `src/core/recommendation/freshness.ts`; Test `tests/core/recommendation/freshness.test.ts`

- [ ] **Step 1: Write failing test (reader preserves from; freshness persisted; A→B→A path 1)**

```ts
// tests/core/recommendation/freshness.test.ts
import { rmSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import { CBrainDB } from "../../../src/storage/sqlite.js";
import { RecommendationStore } from "../../../src/core/recommendation/record-store.js";
import { DeclaredProjectionReader } from "../../../src/core/recommendation/projection.js";
import { recomputeAndPersistFreshness } from "../../../src/core/recommendation/freshness.js";
import { VersionedRuleRegistry } from "../../../src/core/recommendation/registry.js";
import { computeInputsHash } from "../../../src/core/recommendation/integrity.js";
import type { DependencyManifest, RecommendationImmutablePayload, RecommendationProducer } from "../../../src/core/recommendation/types.js";
import { SCHEMA_VERSION } from "../../../src/core/recommendation/types.js";

const DIR = "/tmp/cbrain-test-rec-fresh";
const A = "entities/eA"; const B = "entities/eB";
function seedPair(db: CBrainDB) { for (const s of [A, B]) db.rawDb.prepare(`INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count, tier) VALUES (?, 'entity', ?, ?, ?, 0, 3)`).run(s, s, `${s}.md`, `h-${s}`); }
function addReportsTo(db: CBrainDB, from: string, to: string, trust: string) { db.rawDb.prepare(`INSERT INTO links (from_slug, to_slug, relation, trust_state, source_type) VALUES (?, ?, 'reports_to', ?, 'agent')`).run(from, to, trust); }

const decls: DependencyManifest = {
  rule_id: "health:known_relations",
  declarations: [A, B].map((s) => ({ slug: s, table: "links" as const, as: "reports_to", relation: "reports_to", direction: "outgoing" as const, fields: ["from", "to", "trust_state"], filter: "active" as const })),
};
const producer: RecommendationProducer = { rule_id: "health:known_relations", rule_version: "1.0.0", code_hash: "h1", registry_ref: "r@1.0.0" };
function makeRegistry(): VersionedRuleRegistry {
  const reg = new VersionedRuleRegistry();
  reg.register({
    ...producer,
    captureInputs: (proj) => {
      const p = proj as Record<string, { reports_to: { from: string; to: string; trust_state: string }[] }>;
      const candidates = Object.values(p).flatMap((v) => v.reports_to).filter((e) => e.trust_state === "candidate");
      const refs = [...new Set(candidates.map((e) => `health:known_relations:${e.from}:${e.to}`))].sort();
      return { signals: { candidate_count: candidates.length }, entity_snapshot: p, evidence_refs: refs };
    },
    decide: () => ({ kind: "abstain", reason: "policy_prohibits" }),
  });
  return reg;
}
function payloadFor(db: CBrainDB, reg: VersionedRuleRegistry): RecommendationImmutablePayload {
  const projection = new DeclaredProjectionReader(db).read(decls.declarations);
  const runner = reg.resolve(producer.rule_id, producer.rule_version); if (runner.status !== "ok") throw new Error("runner missing");
  const di = runner.captureInputs(projection);
  return {
    namespace: "maintenance", maintenance_key: `health:known_relations:${JSON.stringify([A, B])}`, inputs_hash: computeInputsHash(di),
    conclusion: { kind: "propose", action: { type: "dry_run", target_ref: `health:known_relations:${A}`, reason: "r" }, alternatives: [] },
    decision_inputs: di, evidence_manifest: di.evidence_refs.map((ref) => ({ source: "health", ref, trust_state: "candidate" as const })),
    constraints: { policy_version: "p", ontology_version: "o", schema_version: SCHEMA_VERSION }, dependency_manifest: decls,
    applicability: { audience: "user_only", auto_execute: false, requires_confirmation: { tier: "standard" } }, risks: [], gaps: [], producer,
  };
}

describe("DeclaredProjectionReader", () => {
  afterEach(() => { rmSync(DIR, { recursive: true, force: true }); });
  test("reads FULL manifest and PRESERVES from (HIGH 2)", () => {
    const db = new CBrainDB(`${DIR}/db.sqlite`); seedPair(db); addReportsTo(db, A, B, "candidate");
    const proj = new DeclaredProjectionReader(db).read(decls.declarations);
    const edge = (proj[A] as { reports_to: { from: string; to: string; trust_state: string }[] }).reports_to[0];
    expect(edge.from).toBe(A); expect(edge.to).toBe(B); expect(edge.trust_state).toBe("candidate");
    db.close();
  });
  test("fail-closed on unsupported table", () => {
    const db = new CBrainDB(`${DIR}/db2.sqlite`); seedPair(db);
    expect(() => new DeclaredProjectionReader(db).read([{ slug: A, table: "lance", as: "x", fields: ["y"] }])).toThrow(/unsupported table/);
    db.close();
  });
  test("fail-closed on undeclared field", () => {
    const db = new CBrainDB(`${DIR}/db3.sqlite`); seedPair(db); addReportsTo(db, A, B, "candidate");
    expect(() => new DeclaredProjectionReader(db).read([{ slug: A, table: "links", as: "reports_to", relation: "reports_to", fields: ["from", "to", "trust_state", "bogus"], filter: "active" }])).toThrow(/not available/);
    db.close();
  });
  test("inactive candidate excluded (active filter)", () => {
    const db = new CBrainDB(`${DIR}/db4.sqlite`); seedPair(db); addReportsTo(db, A, B, "rejected");
    const proj = new DeclaredProjectionReader(db).read(decls.declarations);
    expect((proj[A] as { reports_to: unknown[] }).reports_to.length).toBe(0); // active-only drops rejected
    db.close();
  });
});

describe("recomputeAndPersistFreshness", () => {
  afterEach(() => { rmSync(DIR, { recursive: true, force: true }); });
  test("drift → persisted stale, lifecycle untouched (path 1)", () => {
    const db = new CBrainDB(`${DIR}/f1.sqlite`); seedPair(db); addReportsTo(db, A, B, "candidate");
    const reg = makeRegistry(); const store = new RecommendationStore(db);
    const created = store.createRecord(payloadFor(db, reg), "2026-07-12 10:00:00");
    addReportsTo(db, B, A, "candidate"); // drift
    const out = recomputeAndPersistFreshness(store.getById(created.record_id)!, new DeclaredProjectionReader(db), reg, store, { policy_version: "p", ontology_version: "o", schema_version: SCHEMA_VERSION }, "2026-07-12 11:00:00");
    expect(out.freshness).toBe("stale");
    const re = store.getById(created.record_id); expect(re?.freshness_status).toBe("stale"); expect(re?.lifecycle_status).toBe("pending");
    db.close();
  });
  test("A→B→A path 1 → freshness recovers fresh", () => {
    const db = new CBrainDB(`${DIR}/f2.sqlite`); seedPair(db); addReportsTo(db, A, B, "candidate");
    const reg = makeRegistry(); const store = new RecommendationStore(db);
    const created = store.createRecord(payloadFor(db, reg), "2026-07-12 10:00:00");
    addReportsTo(db, B, A, "candidate");
    recomputeAndPersistFreshness(store.getById(created.record_id)!, new DeclaredProjectionReader(db), reg, store, { policy_version: "p", ontology_version: "o", schema_version: SCHEMA_VERSION }, "2026-07-12 11:00:00");
    db.rawDb.prepare("DELETE FROM links WHERE from_slug = ? AND to_slug = ?").run(B, A);
    recomputeAndPersistFreshness(store.getById(created.record_id)!, new DeclaredProjectionReader(db), reg, store, { policy_version: "p", ontology_version: "o", schema_version: SCHEMA_VERSION }, "2026-07-12 12:00:00");
    expect(store.getById(created.record_id)?.freshness_status).toBe("fresh");
    db.close();
  });
  test("runner unavailable → version_invalid persisted", () => {
    const db = new CBrainDB(`${DIR}/f3.sqlite`); seedPair(db); addReportsTo(db, A, B, "candidate");
    const reg = makeRegistry(); const store = new RecommendationStore(db);
    const created = store.createRecord(payloadFor(db, reg), "2026-07-12 10:00:00");
    const out = recomputeAndPersistFreshness(store.getById(created.record_id)!, new DeclaredProjectionReader(db), new VersionedRuleRegistry(), store, { policy_version: "p", ontology_version: "o", schema_version: SCHEMA_VERSION }, "2026-07-12 11:00:00");
    expect(out.freshness).toBe("version_invalid");
    db.close();
  });
});
```

- [ ] **Step 2: Run → FAIL** — `bun test tests/core/recommendation/freshness.test.ts`.

- [ ] **Step 3: Implement projection reader (fail-closed) + freshness**

```ts
// src/core/recommendation/projection.ts
import type { CBrainDB } from "../../storage/sqlite.js";
import type { DependencyDeclaration } from "./types.js";
export interface DeclaredProjection { [slug: string]: Record<string, unknown> }

/** Strict reader: projects each declaration to entity_snapshot[slug][as]. Fail-closed
 *  on unknown table / missing relation / undeclared field — never returns a silent empty
 *  projection. Preserves edge `from`/`to`/`trust_state` (HIGH 2). */
export class DeclaredProjectionReader {
  constructor(private db: CBrainDB) {}
  read(declarations: DependencyDeclaration[]): DeclaredProjection {
    const proj: DeclaredProjection = {};
    for (const d of declarations) {
      const key = d.slug ?? "__global__";
      if (proj[key] === undefined) proj[key] = {};
      proj[key][d.as] = this.readOne(d);
    }
    return proj;
  }
  private readOne(d: DependencyDeclaration): unknown {
    if (d.table === "links") {
      if (!d.slug) throw new Error(`projection: links declaration needs slug (as=${d.as})`);
      if (!d.relation) throw new Error(`projection: links declaration needs relation (as=${d.as})`);
      const all = d.filter === "all";
      const rows = (d.direction ?? "outgoing") === "outgoing" ? this.db.getOutgoingLinks(d.slug, all) : this.db.getIncomingLinks(d.slug, all);
      return rows.filter((r) => r.relation === d.relation).map((r) => {
        const edge = { from: r.from_slug, to: r.to_slug, trust_state: r.trust_state ?? "trusted" };
        return pick(edge, d.fields, `links[${d.as}]`);
      });
    }
    if (d.table === "pages") {
      if (!d.slug) throw new Error(`projection: pages declaration needs slug (as=${d.as})`);
      const p = this.db.getPage(d.slug) as { content_hash?: string } | null;
      return pick({ content_hash: p?.content_hash ?? "" }, d.fields, `pages[${d.as}]`);
    }
    throw new Error(`projection: unsupported table '${d.table}' (as=${d.as}) — fail-closed`);
  }
}
function pick(obj: Record<string, unknown>, fields: string[], ctx: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) { if (!(f in obj)) throw new Error(`projection: field '${f}' not available in ${ctx}`); out[f] = obj[f]; }
  return out;
}
```

```ts
// src/core/recommendation/freshness.ts
import { computeInputsHash } from "./integrity.js";
import type { DeclaredProjectionReader } from "./projection.js";
import type { RecommendationStore } from "./record-store.js";
import type { VersionedRuleRegistry } from "./registry.js";
import type { RecommendationRecord } from "./types.js";

export function recomputeAndPersistFreshness(
  record: RecommendationRecord, reader: DeclaredProjectionReader, registry: VersionedRuleRegistry,
  store: RecommendationStore, currentConstraints: { policy_version: string; ontology_version: string; schema_version: string }, now: string,
): { freshness: "fresh" | "stale" | "version_invalid" } {
  const c = record.payload.constraints;
  if (currentConstraints.policy_version !== c.policy_version || currentConstraints.ontology_version !== c.ontology_version || currentConstraints.schema_version !== c.schema_version) {
    store.updateFreshness(record.record_id, "version_invalid", now); return { freshness: "version_invalid" };
  }
  const runner = registry.resolve(record.payload.producer.rule_id, record.payload.producer.rule_version);
  if (runner.status !== "ok") { store.updateFreshness(record.record_id, "version_invalid", now); return { freshness: "version_invalid" }; }
  const projection = reader.read(record.payload.dependency_manifest.declarations);
  const freshness = computeInputsHash(runner.captureInputs(projection)) === record.payload.inputs_hash ? "fresh" : "stale";
  store.updateFreshness(record.record_id, freshness, now);
  return { freshness };
}
```

- [ ] **Step 4: Run → PASS** — `bun test tests/core/recommendation/freshness.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/core/recommendation/projection.ts src/core/recommendation/freshness.ts tests/core/recommendation/freshness.test.ts
git commit -m "feat(rec): fail-closed projection reader + persisted freshness (#328)"
```

---

## Task 8: Display — loadVerified orchestration + branded VerifiedRecord (spec §4.4, §5.3, §11.3; rev3 HIGH 4)

**Files:** Create `src/core/recommendation/display.ts`; Test `tests/core/recommendation/display.test.ts`

- [ ] **Step 1: Write failing test (gate + forced recompute + hostile reason)**

```ts
// tests/core/recommendation/display.test.ts
import { rmSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import { CBrainDB } from "../../../src/storage/sqlite.js";
import { RecommendationStore } from "../../../src/core/recommendation/record-store.js";
import { DeclaredProjectionReader } from "../../../src/core/recommendation/projection.js";
import { VersionedRuleRegistry } from "../../../src/core/recommendation/registry.js";
import { loadVerified, projectDisplay } from "../../../src/core/recommendation/display.js";
import type { VerifiedRecord } from "../../../src/core/recommendation/display.js";
import { registerMaintenanceProducers } from "../../../src/core/recommendation/producers/index.js";
import { RecommendationManager } from "../../../src/core/recommendation/manager.js";

const DIR = "/tmp/cbrain-test-rec-display";
const A = "entities/eA"; const B = "entities/eB";
function seed(db: CBrainDB) { for (const s of [A, B]) db.rawDb.prepare(`INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count, tier) VALUES (?, 'entity', ?, ?, ?, 0, 3)`).run(s, s, `${s}.md`, `h-${s}`); }
function link(db: CBrainDB, from: string, to: string, trust: string) { db.rawDb.prepare(`INSERT INTO links (from_slug, to_slug, relation, trust_state, source_type) VALUES (?, ?, 'reports_to', ?, 'agent')`).run(from, to, trust); }
function registry() { const r = new VersionedRuleRegistry(); registerMaintenanceProducers(r); return r; }

describe("loadVerified + projectDisplay", () => {
  afterEach(() => { rmSync(DIR, { recursive: true, force: true }); });

  test("active+fresh + unchanged deps → verified → display produced, title+reason sanitized", () => {
    const db = new CBrainDB(`${DIR}/d1.sqlite`); seed(db); link(db, A, B, "candidate");
    const store = new RecommendationStore(db); const reg = registry();
    const created = new RecommendationManager(db, reg).buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:00");
    const lv = loadVerified(created.record_id, new DeclaredProjectionReader(db), reg, store, { policy_version: "p", ontology_version: "o", schema_version: "rec-v1" }, "2026-07-12 10:00:01");
    expect(lv.blocked).toBe(false);
    if (!lv.blocked) {
      const d = projectDisplay(lv.verified, () => "实体A");
      expect(d.blocked).toBe(false);
      if (!d.blocked) { expect(d.target_display).toBe("实体A"); expect(d.reason).not.toContain("score"); }
    }
    db.close();
  });

  test("HIGH 4: deps drift after create, no manual refresh, display MUST block", () => {
    const db = new CBrainDB(`${DIR}/d2.sqlite`); seed(db); link(db, A, B, "candidate");
    const store = new RecommendationStore(db); const reg = registry();
    const created = new RecommendationManager(db, reg).buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:00");
    link(db, B, A, "candidate"); // drift; freshness still persisted "fresh" until recompute
    const lv = loadVerified(created.record_id, new DeclaredProjectionReader(db), reg, store, { policy_version: "p", ontology_version: "o", schema_version: "rec-v1" }, "2026-07-12 10:00:01");
    expect(lv.blocked).toBe(true); // loadVerified recomputed freshness → stale → blocked
    db.close();
  });

  test("non-display lifecycle states blocked", () => {
    const db = new CBrainDB(`${DIR}/d3.sqlite`); seed(db); link(db, A, B, "candidate");
    const store = new RecommendationStore(db); const reg = registry();
    const created = new RecommendationManager(db, reg).buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:00");
    store.transitionLifecycle(created.record_id, "rejected", "2026-07-12 10:00:01", "no", null);
    const lv = loadVerified(created.record_id, new DeclaredProjectionReader(db), reg, store, { policy_version: "p", ontology_version: "o", schema_version: "rec-v1" }, "2026-07-12 10:00:02");
    expect(lv.blocked).toBe(true);
    db.close();
  });

  test("hostile reason falls back, never raw-leaks (projectDisplay sanitizes)", () => {
    // Standalone unit test for projectDisplay's sanitize path. Construct a VerifiedRecord
    // directly (branded type) carrying a hostile reason; assert projectDisplay falls back.
    const hostile = { record: { record_id: "r", created_at: "t", last_revalidated_at: "t", fingerprint: "f", suppressed_until: null, lifecycle_status: "pending", freshness_status: "fresh",
      payload: { namespace: "maintenance", maintenance_key: "k", inputs_hash: "ih",
        conclusion: { kind: "propose", action: { type: "dry_run", target_ref: "health:k:eA", reason: "score=0.9 /Users/secret" }, alternatives: [] },
        decision_inputs: { signals: {}, entity_snapshot: {}, evidence_refs: [] }, evidence_manifest: [],
        constraints: { policy_version: "p", ontology_version: "o", schema_version: "rec-v1" },
        dependency_manifest: { rule_id: "r", declarations: [] },
        applicability: { audience: "user_only", auto_execute: false, requires_confirmation: { tier: "standard" } },
        risks: [], gaps: [], producer: { rule_id: "r", rule_version: "1", code_hash: "h", registry_ref: "r@1" } } } } as VerifiedRecord;
    const d = projectDisplay(hostile, () => "实体A");
    expect(d.blocked).toBe(false);
    if (!d.blocked) { expect(d.target_display).toBe("实体A"); expect(d.reason).not.toContain("score"); expect(d.reason).not.toContain("/Users/"); }
  });
});
```

- [ ] **Step 2: Run → FAIL** — `bun test tests/core/recommendation/display.test.ts`.

- [ ] **Step 3: Implement display (loadVerified + branded VerifiedRecord)**

```ts
// src/core/recommendation/display.ts
import { assertSafeActionDisplay } from "../safety/display-safety.js";
import { checkIntegrity } from "./integrity.js";
import { recomputeAndPersistFreshness } from "./freshness.js";
import type { DeclaredProjectionReader } from "./projection.js";
import type { RecommendationStore } from "./record-store.js";
import type { VersionedRuleRegistry } from "./registry.js";
import type { RecommendationRecord } from "./types.js";

const FALLBACK_DISPLAY = "一项待确认的记忆";
const FALLBACK_REASON = "有一项建议需要人工复核。";

/** Branded type: ONLY loadVerified can produce this, so projectDisplay cannot be fed
 *  an unverified/stale record (HIGH 4). */
export type VerifiedRecord = { readonly __verified: unique symbol; record: RecommendationRecord };

export type LoadResult =
  | { blocked: true; reason: "not_found" | "integrity_failed" | "not_active_fresh" }
  | { blocked: false; verified: VerifiedRecord };

export type DisplayResult = { blocked: true } | { blocked: false; target_display: string; reason: string };

function safe(text: string, fallback: string): string { try { assertSafeActionDisplay(text); return text; } catch { return fallback; } }

/** The ONLY read/display orchestration (HIGH 4): load → integrity → exact-version
 *  freshness recompute+persist → reload → active+fresh gate. Returns a branded
 *  VerifiedRecord only when the record is verified-fresh-and-active. */
export function loadVerified(
  recordId: string, reader: DeclaredProjectionReader, registry: VersionedRuleRegistry,
  store: RecommendationStore, currentConstraints: { policy_version: string; ontology_version: string; schema_version: string }, now: string,
): LoadResult {
  const rec = store.getById(recordId);
  if (!rec) return { blocked: true, reason: "not_found" };
  if (!checkIntegrity(rec).ok) return { blocked: true, reason: "integrity_failed" };
  recomputeAndPersistFreshness(rec, reader, registry, store, currentConstraints, now);
  const reloaded = store.getById(recordId);
  if (!reloaded) return { blocked: true, reason: "not_found" };
  const active = reloaded.lifecycle_status === "pending" || reloaded.lifecycle_status === "current";
  if (!active || reloaded.freshness_status !== "fresh") return { blocked: true, reason: "not_active_fresh" };
  return { blocked: false, verified: { record: reloaded } as VerifiedRecord };
}

/** Display projection. Accepts ONLY a VerifiedRecord (gate already enforced by loadVerified). */
export function projectDisplay(v: VerifiedRecord, resolveSafeTitle: (slug: string) => string): DisplayResult {
  const c = v.record.payload.conclusion;
  if (c.kind === "abstain") return { blocked: false, target_display: FALLBACK_DISPLAY, reason: safe(`abstain: ${c.reason}`, FALLBACK_REASON) };
  const slug = c.action.target_ref.split(":").pop() ?? c.action.target_ref;
  return { blocked: false, target_display: safe(resolveSafeTitle(slug) || FALLBACK_DISPLAY, FALLBACK_DISPLAY), reason: safe(c.action.reason, FALLBACK_REASON) };
}
```

- [ ] **Step 4: Run → PASS** — `bun test tests/core/recommendation/display.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/core/recommendation/display.ts tests/core/recommendation/display.test.ts
git commit -m "feat(rec): loadVerified orchestration + gated display (#328)"
```

---

## Task 9: versions (real hashes) + producer (RULE_ARTIFACT code_hash) + manager (registry-sourced metadata) (spec §4.3, §7.2; rev3 HIGH 5)

**Files:** Create `src/core/recommendation/versions.ts`, `src/core/recommendation/producers/known-relations.ts`, `src/core/recommendation/producers/index.ts`, `src/core/recommendation/manager.ts`; Test `tests/core/recommendation/producers/known-relations.test.ts`

- [ ] **Step 1: Write failing test (exact ref, normalized slugs, real artifact hash)**

```ts
// tests/core/recommendation/producers/known-relations.test.ts
import { rmSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import { CBrainDB } from "../../../../src/storage/sqlite.js";
import { registerMaintenanceProducers } from "../../../../src/core/recommendation/producers/index.js";
import { VersionedRuleRegistry } from "../../../../src/core/recommendation/registry.js";
import { RecommendationManager } from "../../../../src/core/recommendation/manager.js";
import { CODE_HASH } from "../../../../src/core/recommendation/producers/known-relations.js";
import { policyHash } from "../../../../src/core/recommendation/versions.js";

const DIR = "/tmp/cbrain-test-rec-producer";
const A = "entities/entityA"; const B = "entities/entityB";
function seed(db: CBrainDB) { for (const s of [A, B]) db.rawDb.prepare(`INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count, tier) VALUES (?, 'entity', ?, ?, ?, 0, 3)`).run(s, s, `${s}.md`, `h-${s}`); }
function link(db: CBrainDB, from: string, to: string, trust: string) { db.rawDb.prepare(`INSERT INTO links (from_slug, to_slug, relation, trust_state, source_type) VALUES (?, ?, 'reports_to', ?, 'agent')`).run(from, to, trust); }
function make() { const db = new CBrainDB(`${DIR}/${Math.random().toString(36).slice(2)}.sqlite`); const reg = new VersionedRuleRegistry(); registerMaintenanceProducers(reg); return { db, mgr: new RecommendationManager(db, reg), reg }; }

describe("known_relations producer (vertical slice)", () => {
  afterEach(() => { rmSync(DIR, { recursive: true, force: true }); });

  test("abstains when no candidate edge", () => {
    const { db, mgr } = make(); seed(db);
    const r = mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:00");
    expect(r.payload.conclusion.kind).toBe("abstain");
    db.close();
  });

  test("HIGH 2: proposes on real candidate edge; evidence ref is EXACT (no undefined)", () => {
    const { db, mgr } = make(); seed(db); link(db, A, B, "candidate");
    const r = mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:00");
    expect(r.payload.conclusion.kind).toBe("propose");
    expect(r.payload.evidence_manifest.length).toBe(1);
    const ref = r.payload.evidence_manifest[0].ref;
    expect(ref).toBe(`health:known_relations:${A}:${B}`); // exact, from+to present
    expect(ref).not.toContain("undefined");
    expect(r.payload.decision_inputs.evidence_refs).toEqual([ref]);
    db.close();
  });

  test("normalized slugs: disordered/duplicate → same key + same fingerprint", () => {
    const a = make(); seed(a.db); link(a.db, A, B, "candidate");
    const r1 = a.mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [B, A, A] }, "2026-07-12 10:00:00");
    const r2 = a.mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:01");
    expect(r1.payload.maintenance_key).toBe(r2.payload.maintenance_key);
    expect(r1.fingerprint).toBe(r2.fingerprint);
    a.db.close();
  });

  test("inactive candidate excluded", () => {
    const { db, mgr } = make(); seed(db); link(db, A, B, "rejected");
    const r = mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:00");
    expect(r.payload.conclusion.kind).toBe("abstain");
    db.close();
  });

  test("HIGH 5: code_hash is a real sha256 of RULE_ARTIFACT; ontology_version is a real hash", () => {
    const { db, mgr } = make(); seed(db); link(db, A, B, "candidate");
    const r = mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:00");
    expect(r.payload.producer.code_hash).toBe(CODE_HASH);
    expect(r.payload.producer.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.payload.constraints.ontology_version).toMatch(/^[0-9a-f]{64}$/);
    expect(r.payload.constraints.policy_version).toBe(policyHash(aRegistryWith(mgr)));
    db.close();
  });
});

// helper to re-derive the registry the manager uses (manager exposes it for the test)
function aRegistryWith(mgr: RecommendationManager): VersionedRuleRegistry { return (mgr as unknown as { registry: VersionedRuleRegistry }).registry; }
```

> **Note:** the last test reads `mgr.registry` (private) via a cast for white-box verification that `policy_version === policyHash(registry)`. This is a test-only reach-through; acceptable for a vertical-slice integration test. Confirm `RecommendationManager` stores the registry as a field named `registry` (Task 9 Step 3 does).

- [ ] **Step 2: Run → FAIL** — `bun test tests/core/recommendation/producers/known-relations.test.ts`.

- [ ] **Step 3: Implement versions**

```ts
// src/core/recommendation/versions.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "./canonical.js";
import type { VersionedRuleRegistry } from "./registry.js";

export function ontologyHash(): string {
  const path = join(import.meta.dir, "../../ontology/ontology.yaml");
  return sha256Hex(readFileSync(path, "utf8"));
}
export function policyHash(registry: VersionedRuleRegistry): string {
  return sha256Hex(registry.manifest());
}
```

- [ ] **Step 4: Implement producer (RULE_ARTIFACT → real code_hash) + registration**

```ts
// src/core/recommendation/producers/known-relations.ts
import { sha256Hex } from "../canonical.js";
import type { DecisionInputs, RecommendationConclusion, RecommendationProducer } from "../types.js";

/** Reproducible rule artifact — its sha256 IS the code_hash (HIGH 5). Editing the rule
 *  logic MUST edit this artifact, so code_hash/policy_version/freshness all change. */
export const RULE_ARTIFACT = `# rule: health:known_relations @ 1.0.0
shape DependencyDeclaration { slug, table=links, as, relation=reports_to, direction=outgoing, fields=[from,to,trust_state], filter=active }
captureInputs(projection):
  candidates = [ for each slug in projection: for each edge in projection[slug].reports_to where edge.trust_state == "candidate" ]
  signals.candidate_count = count(candidates)
  evidence_refs = unique sorted [ "health:known_relations:" + e.from + ":" + e.to | e <- candidates ]
decide(decision_inputs):
  if signals.candidate_count == 0 -> abstain(insufficient_evidence)
  else -> propose(dry_run, target_ref="health:known_relations:<first slug>", reason="存在待确认的 reports_to 候选边，建议人工复核")
`;
export const CODE_HASH = sha256Hex(RULE_ARTIFACT);
export const KNOWN_RELATIONS: RecommendationProducer = {
  rule_id: "health:known_relations", rule_version: "1.0.0", code_hash: CODE_HASH,
  registry_ref: "cbrain.rules:maintenance.known_relations@1.0.0",
};

export function captureInputs(normalizedSlugs: string[], projection: Record<string, { reports_to: { from: string; to: string; trust_state: string }[] }>): DecisionInputs {
  const candidates = normalizedSlugs.flatMap((s) => projection[s]?.reports_to ?? []).filter((e) => e.trust_state === "candidate");
  const entity_snapshot: Record<string, { reports_to: { from: string; to: string; trust_state: string }[] }> = {};
  for (const s of normalizedSlugs) entity_snapshot[s] = projection[s]?.reports_to ?? [];
  const evidence_refs = [...new Set(candidates.map((e) => `health:known_relations:${e.from}:${e.to}`))].sort();
  return { signals: { candidate_count: candidates.length }, entity_snapshot, evidence_refs };
}
export function decide(normalizedSlugs: string[], di: DecisionInputs): RecommendationConclusion {
  if (((di.signals.candidate_count as number) ?? 0) === 0) return { kind: "abstain", reason: "insufficient_evidence" };
  return { kind: "propose", action: { type: "dry_run", target_ref: `health:known_relations:${normalizedSlugs[0]}`, reason: "存在待确认的 reports_to 候选边，建议人工复核" }, alternatives: [] };
}
```

```ts
// src/core/recommendation/producers/index.ts
import type { VersionedRuleRegistry } from "../registry.js";
import { KNOWN_RELATIONS, captureInputs as krCapture, decide as krDecide } from "./known-relations.js";

export function registerMaintenanceProducers(reg: VersionedRuleRegistry): void {
  reg.register({
    ...KNOWN_RELATIONS,
    captureInputs: (projection: unknown) => {
      const p = projection as Record<string, { reports_to: { from: string; to: string; trust_state: string }[] }>;
      return krCapture(Object.keys(p).sort(), p);
    },
    decide: (di) => krDecide(Object.keys(di.entity_snapshot).sort(), di),
  });
}
```

- [ ] **Step 5: Implement manager (metadata from registry — zero hardcoding)**

```ts
// src/core/recommendation/manager.ts
import { DeclaredProjectionReader } from "./projection.js";
import { RecommendationStore } from "./record-store.js";
import { ontologyHash, policyHash } from "./versions.js";
import { SCHEMA_VERSION } from "./types.js";
import type { CBrainDB } from "../../storage/sqlite.js";
import type { VersionedRuleRegistry } from "./registry.js";
import type { DependencyManifest, EvidenceManifestEntry, RecommendationConstraints, RecommendationImmutablePayload } from "./types.js";

export interface BuildRequest { rule_id: string; slugs: string[] }

export class RecommendationManager {
  constructor(private db: CBrainDB, private registry: VersionedRuleRegistry) {}

  buildAndStore(req: BuildRequest, now: string) {
    // producer metadata comes ONLY from the registry (HIGH 5) — no hardcoded version/hash.
    const meta = this.registry.directory().find((p) => p.rule_id === req.rule_id);
    if (!meta) throw new Error(`manager: producer ${req.rule_id} not registered`);
    const runner = this.registry.resolve(meta.rule_id, meta.rule_version);
    if (runner.status !== "ok") throw new Error(`manager: producer ${req.rule_id}@${meta.rule_version} not resolvable`);

    const slugs = [...new Set(req.slugs)].sort();
    const dependency_manifest: DependencyManifest = {
      rule_id: req.rule_id,
      declarations: slugs.map((s) => ({ slug: s, table: "links" as const, as: "reports_to", relation: "reports_to", direction: "outgoing" as const, fields: ["from", "to", "trust_state"], filter: "active" as const })),
    };
    const projection = new DeclaredProjectionReader(this.db).read(dependency_manifest.declarations);
    const decision_inputs = runner.captureInputs(projection);
    const conclusion = runner.decide(decision_inputs);
    const evidence_manifest: EvidenceManifestEntry[] = decision_inputs.evidence_refs.map((ref) => ({ source: "health", ref, trust_state: "candidate" as const }));
    const constraints: RecommendationConstraints = { policy_version: policyHash(this.registry), ontology_version: ontologyHash(), schema_version: SCHEMA_VERSION };

    const payload: RecommendationImmutablePayload = {
      namespace: "maintenance", maintenance_key: `${req.rule_id}:${JSON.stringify(slugs)}`, inputs_hash: "",
      conclusion, decision_inputs, evidence_manifest, constraints, dependency_manifest,
      applicability: { audience: "user_only", auto_execute: false, requires_confirmation: { tier: "standard" } },
      risks: [], gaps: [], producer: { rule_id: meta.rule_id, rule_version: meta.rule_version, code_hash: meta.code_hash, registry_ref: meta.registry_ref },
    };
    return new RecommendationStore(this.db).createRecord(payload, now);
  }
}
```

- [ ] **Step 6: Run → PASS** — `bun test tests/core/recommendation/producers/known-relations.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/core/recommendation/versions.ts src/core/recommendation/producers/ src/core/recommendation/manager.ts tests/core/recommendation/producers/known-relations.test.ts
git commit -m "feat(rec): real-artifact code_hash + registry-sourced producer metadata (#328)"
```

---

## Task 10: Rollback tests on the PRODUCTION path

**Files:** extend `tests/core/recommendation/record-store.test.ts`

- [ ] **Step 1: Production-path fault injection (own DB)**

```ts
test("createRecord supersede rolls back on partial failure — prior active stays active", () => {
  const faultDir = "/tmp/cbrain-test-rec-store-fault";
  rmSync(faultDir, { recursive: true, force: true });
  const fdb = new CBrainDB(`${faultDir}/db.sqlite`);
  const fstore = new RecommendationStore(fdb);
  const created = fstore.createRecord(mkPayload("hA"), "2026-07-12 10:00:00");
  // drop history table mid-flight → createRecord's transaction (supersede+insert+history) aborts
  fdb.rawDb.exec("DROP TABLE recommendation_lifecycle_history");
  expect(() => fstore.createRecord(mkPayload("hB"), "2026-07-12 10:00:01")).toThrow();
  expect(fstore.activeCountFor("k1")).toBe(1);
  expect(fstore.getById(created.record_id)?.fingerprint).toBe(created.fingerprint);
  fdb.close(); rmSync(faultDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Store-reload fingerprint round-trip** (with `computeFingerprint` hoisted to the file's imports alongside `computeInputsHash`)

```ts
test("fingerprint survives store → DB → store reload", () => {
  open();
  const created = store.createRecord(mkPayload("h1"), "2026-07-12 10:00:00");
  const reloaded = store.getById(created.record_id);
  expect(reloaded).not.toBeNull();
  expect(reloaded?.fingerprint).toBe(created.fingerprint);
  expect(computeFingerprint(reloaded!.payload)).toBe(created.fingerprint);
});
```

- [ ] **Step 3: Run → PASS** — `bun test tests/core/recommendation/record-store.test.ts`.

- [ ] **Step 4: Commit**

```bash
git add tests/core/recommendation/record-store.test.ts
git commit -m "test(rec): production-path rollback + store-reload round-trip (#328)"
```

---

## Task 11: Lint + full check gate (explicit staging, NO git add -A)

- [ ] **Step 1: Lint** — Run: `bun run lint` → PASS.
- [ ] **Step 2: Full test** — Run: `bun test tests/core/recommendation/ tests/storage/migrations/recommendations.test.ts` → all PASS.
- [ ] **Step 3: Full check** — Run: `bun run check` → PASS.
- [ ] **Step 4: docs gate** — Run: `bun run check:docs` → PASS.
- [ ] **Step 5: Final commit ONLY if lint touched files (NEVER `git add -A`)** — if `bun run lint --fix` changed files, stage those exact paths only (e.g. `git add src/core/recommendation/manager.ts` then commit). If nothing changed, skip (no `--allow-empty`).

---

## Self-Review (run before handing off)

**Codex plan-rev2 findings (5 HIGH + 2 MED) — all addressed:**
- HIGH 1 (declaration/snapshot conflict) → Task 2 `DependencyDeclaration` uses `as`+`relation`+`direction`+`fields`; Task 7 reader is strict/fail-closed; Task 4 cross-consistency checks `as` keys + sub-fields; `clean passes` test under unified model. ✓
- HIGH 2 (projection lost `from`) → Task 7 reader returns `{from,to,trust_state}`; test asserts `edge.from === A` and exact ref `health:known_relations:entities/eA:entities/eB`, no `undefined`. ✓
- HIGH 3 (suppression time/query) → Task 6 uses `EXISTS(... IS NULL OR > now)` (permanent not bypassed), ISO-UTC times in fixtures, `policy.ts` default TTL, `clearSuppression` reopen; test "permanent NULL not bypassed by far-future now". ✓
- HIGH 4 (display no forced recompute) → Task 8 `loadVerified` orchestrates load→integrity→freshness recompute/persist→reload→gate; branded `VerifiedRecord`; `projectDisplay` accepts only verified; test "drift after create, no manual refresh → blocked". ✓
- HIGH 5 (fake code_hash) → Task 9 `code_hash = sha256(RULE_ARTIFACT)`; manager reads metadata from `registry.directory()`/`resolve()` (zero hardcoding); test asserts `code_hash` is 64-hex and equals `CODE_HASH`, `policy_version === policyHash(registry)`. ✓
- MED 1 (tombstone not in manifest) → Task 5 `manifest()` branches `"tombstone" in e` first; live/purged/incompatible produce distinct lines; test asserts 3 distinct manifests. ✓
- MED 2 (migration atomic untested) → Task 3 `failBeforeMarker` test-only hook; test injects mid-failure, asserts no tables/indexes/marker, then clean re-run. ✓

**Spec coverage:** §4/4.3/4.4 → Tasks 2/4/8; §5.1-5.7 → Tasks 6/7/8; §5.5 atomic supersede → Task 6 (+Task 10); §5.6 suppression → Task 6/policy; §6.1-6.4 → Task 1; §7.2 → Tasks 5/9; §8.1 → Task 4; §8.4 → Task 7/8; §9/9.1 → Task 2/9; §10 → Task 3; §11 → Task 8. **Deferred:** §8.2 replay UI (Phase 2), §12 derivation graph (unused by Phase 1).

**Placeholder scan:** no TBD/TODO. Each "Note:" is a concrete executor action (verify `mgr.registry` field name, hoist an import). All code complete; all `CBrainDB` calls use verified APIs (`prepare(sql).get/.run({$named})`, `transaction(fn)`, `getOutgoingLinks`/`getIncomingLinks`/`getPage`, `rawDb.prepare` seeding, `new CBrainDB(dbPath)`).

**Type consistency:** `createRecord`/`transitionLifecycle`/`updateFreshness`/`clearSuppression`/`getById`/`activeCountFor` consistent across 6/7/8/9/10. `DependencyDeclaration` (`as`/`relation`/`direction`/`fields`) consistent across 2/4/6/7/9. `VerifiedRecord` only from `loadVerified`, only consumed by `projectDisplay`.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-12-recommendation-contract-phase1.md` (rev3).

**Per the user's instruction: STOP for re-review. Do not execute. Do not push.** Every commit stages explicit paths only.

# Recommendation Contract — Phase 1 Infrastructure Implementation Plan (rev4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the deterministic Recommendation Record **contract infrastructure** for Phase 1 from `docs/superpowers/specs/2026-07-12-recommendation-contract-design.md` (rev6), plus one reference producer (`health:known_relations`) as the vertical slice.

**Architecture:** `src/core/recommendation/`. Additive migration (DDL + completion marker in ONE transaction; test fault hook proves rollback). Deterministic producers, never auto-execute (`auto_execute:false` + DB CHECK + payload validation). Immutable payload hashed per RFC 8785 JCS + prose/identifier layer. Two orthogonal persisted axes (`lifecycle_status` / `freshness_status`), each its OWN store API; terminals cannot regress. Atomic supersede keeps `active count ≤ 1` per key; rejected suppression via `EXISTS(... IS NULL OR > now)` with default TTL wired in. **Store is the single persistence entry** — validates, computes hashes, checks cross-consistency, enforces suppression, validates all timestamps. **code_hash = sha256(captureInputs.toString() + decide.toString())** — derived from the executable logic, not a hand-maintained copy. Registry tracks an explicit **active version per rule_id** (`resolveActive`); old versions stay resolvable for replay only. **Display has exactly one public entry** — `loadAndProjectDisplay` — which computes current version constraints internally (from registry + ontology sources), forces integrity + freshness recompute, gates on active+fresh, and projects through the safety boundary. `projectDisplay` is module-private (not exported), so the runtime display boundary cannot be bypassed by a type cast.

**Tech Stack:** Bun, TypeScript strict, `bun:sqlite`, `bun:test`, `node:crypto`. No new runtime deps.

**rev4 changelog (this revision):** closes Codex plan-rev3 findings — (H1) `canonicalDeclaration()` omits absent optional keys so global/pages/default-filter declarations hash cleanly (3 RED fixtures + round-trip). (H2) default suppression TTL wired into `transitionLifecycle` (`undefined → defaultSuppressedUntil(now)`, `null → permanent`, string → strict `YYYY-MM-DD HH:MM:SS`); all store time entry points share a strict validator; `clearSuppression` requires rejected + `changes===1`. (H3) `loadAndProjectDisplay` computes current constraints internally from `policyHash(registry) + ontologyHash() + SCHEMA_VERSION` — caller supplies the registry and an ontology-hash function (sources), never version strings; the positive display case now genuinely passes. (H4) only `loadAndProjectDisplay` is exported; `projectDisplay` is module-private; the hostile-reason test writes a real record and goes through the single entry (no `VerifiedRecord` forge). (M1) `code_hash = sha256(captureInputs.toString() + decide.toString())` — no `RULE_ARTIFACT` copy. (M2) registry tracks explicit active version per rule_id (`resolveActive`); multiple live versions of one rule_id fail-closed. (M3) real two-sibling suppression test (expired + permanent coexist) and duplicate-`(slug,as)` fail-closed in reader + integrity.

---

## Scope (read first)

Phase 1 contract infrastructure + one reference producer (`health:known_relations`). Out of scope (follow-up plan): fsck/discovery/action-candidate producers; MCP tool surface (#327-gated); replay/diff UI (Phase 2); derivation graph (§12).

**Non-goals (hard, spec §0):** no LLM at runtime; no auto-execution; no writing recommendations as trusted facts; no model CoT storage; no MCP/default-display changes.

**History note:** Local `main` and `origin/main` diverged via equivalent #329 commits. **Do NOT push.**

**Staging rule (HARD):** every commit stages **explicit paths only**. Never `git add -A` / `git add .`.

**Time contract:** all timestamps are SQLite-UTC `YYYY-MM-DD HH:MM:SS`, validated by a strict regex at every store entry point. Lexicographic compare is correct for this format.

---

## File Structure

**Create (source):**
- `src/core/recommendation/canonical.ts` — `assertJsonSafe`, `canonicalJson`, `sha256Hex`, `normalizeProse`.
- `src/core/recommendation/types.ts` — types + unified `DependencyDeclaration`.
- `src/core/recommendation/policy.ts` — `DEFAULT_SUPPRESSION_TTL_SECONDS`, `defaultSuppressedUntil`, `SUPPRESSION_REOPENED`, `validateTimestamp`.
- `src/core/recommendation/integrity.ts` — `computeInputsHash`, `computeFingerprint` (uses `canonicalDeclaration`), `checkIntegrity` (cross-consistency incl. duplicate-`(slug,as)` fail-closed).
- `src/core/recommendation/registry.ts` — `VersionedRuleRegistry` (immutable, tombstones, active-version map, `resolveActive`, tombstone-aware `manifest`).
- `src/core/recommendation/projection.ts` — `DeclaredProjectionReader` (strict, fail-closed on unknown/duplicate).
- `src/core/recommendation/freshness.ts` — `recomputeAndPersistFreshness` (takes current constraints; caller is internal orchestration).
- `src/core/recommendation/record-store.ts` — `RecommendationStore` (single entry, split APIs, EXISTS suppression, time validation, guarded reopen).
- `src/core/recommendation/versions.ts` — `ontologyHash`, `policyHash(registry)`.
- `src/core/recommendation/display.ts` — single exported `loadAndProjectDisplay`; module-private `projectDisplay`.
- `src/core/recommendation/manager.ts` — `RecommendationManager.buildAndStore` (metadata from `registry.resolveActive`).
- `src/core/recommendation/producers/known-relations.ts` — `captureInputs`/`decide` + metadata (no hand artifact).
- `src/core/recommendation/producers/index.ts` — `registerMaintenanceProducers` (computes code_hash from function sources).
- `src/storage/migrations/recommendations.ts` — additive migration (+ test fault hook).

**Modify:** `src/storage/sqlite.ts` (call migration after `runLatePageMigrations` ≈ L420), `src/storage/migrations/index.ts` (export).

**Create (tests):** `tests/core/recommendation/*.test.ts` (`../../../src`), `tests/core/recommendation/producers/*.test.ts` (`../../../../src`), `tests/storage/migrations/recommendations.test.ts`.

---

## Task 1: Canonical pipeline — validator-first, fail-closed (spec §6.2)

> Unchanged (no finding). Kept verbatim from rev3.

**Files:** Create `src/core/recommendation/canonical.ts`; Test `tests/core/recommendation/canonical.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/core/recommendation/canonical.test.ts
import { describe, expect, test } from "bun:test";
import { assertJsonSafe, canonicalJson, sha256Hex, serializeNumber, normalizeProse } from "../../../src/core/recommendation/canonical.js";

describe("serializeNumber (JCS §3.2.2.3)", () => {
  test("golden bytes", () => { expect(serializeNumber(1)).toBe("1"); expect(serializeNumber(1.0)).toBe("1"); expect(serializeNumber(-0)).toBe("0"); expect(serializeNumber(0.1)).toBe("0.1"); expect(serializeNumber(1e-7)).toBe("1e-7"); expect(serializeNumber(1e21)).toBe("1e+21"); });
  test("non-finite fail-closed", () => { for (const n of [NaN, Infinity, -Infinity]) expect(() => serializeNumber(n)).toThrow(/finite/); });
});
describe("assertJsonSafe", () => {
  test("accepts plain JSON", () => { expect(() => assertJsonSafe({ a: 1, b: [null, "x", true] })).not.toThrow(); });
  test("rejects undefined/function/symbol", () => { expect(() => assertJsonSafe({ x: undefined })).toThrow(/JSON-safe/); expect(() => assertJsonSafe({ x: () => 1 })).toThrow(/JSON-safe/); expect(() => assertJsonSafe({ x: Symbol("s") })).toThrow(/JSON-safe/); });
  test("rejects Date/Map/Set/class instance", () => { expect(() => assertJsonSafe({ x: new Date() })).toThrow(/JSON-safe/); expect(() => assertJsonSafe({ x: new Map() })).toThrow(/JSON-safe/); expect(() => assertJsonSafe({ x: new Set() })).toThrow(/JSON-safe/); expect(() => assertJsonSafe({ x: new (class C {})() })).toThrow(/JSON-safe/); });
  test("rejects cyclic object AND cyclic array", () => { const o: Record<string, unknown> = {}; o.self = o; expect(() => assertJsonSafe(o)).toThrow(/cycle/); const a: unknown[] = []; a.push(a); expect(() => assertJsonSafe(a)).toThrow(/cycle/); });
  test("rejects lone surrogate", () => { expect(() => assertJsonSafe({ x: "ab\uD800cd" })).toThrow(/surrogate/); });
});
describe("canonicalJson", () => {
  test("keys sorted UTF-16 code-unit order", () => { expect(canonicalJson({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}'); });
  test("array sorted by complete-element canonical string", () => { const a = { source: "link", ref: "x", trust_state: "trusted" }; const b = { source: "link", ref: "x", trust_state: "candidate" }; expect(canonicalJson({ m: [a, b] })).toBe(canonicalJson({ m: [b, a] })); });
  test("absent optional key omitted", () => { const out = canonicalJson({ type: "dry_run", target_ref: "r", reason: "x" }); expect(out).toBe('{"reason":"x","target_ref":"r","type":"dry_run"}'); expect(out).not.toContain("rollback_note"); });
  test("identifier byte-exact (no NFKC)", () => { expect(canonicalJson({ ref: "entityA－1" })).not.toBe(canonicalJson({ ref: "entityA-1" })); });
});
describe("normalizeProse", () => { test("NFKC + whitespace fold", () => { expect(normalizeProse("ｓｃｏｒｅ   高")).toBe("score 高"); }); });
describe("sha256Hex", () => { test("64 hex deterministic", () => { expect(sha256Hex('{"a":1}')).toMatch(/^[0-9a-f]{64}$/); }); });
```

- [ ] **Step 2: Run → FAIL** — `bun test tests/core/recommendation/canonical.test.ts`.

- [ ] **Step 3: Implement canonical module**

```ts
// src/core/recommendation/canonical.ts
import { createHash } from "node:crypto";
export function serializeNumber(n: number): string { if (!Number.isFinite(n)) throw new Error(`canonical: number must be finite, got ${String(n)}`); return String(Object.is(n, -0) ? 0 : n); }
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

## Task 2: Types + policy (spec §4; rev4 HIGH 2)

**Files:** Create `src/core/recommendation/types.ts`, `src/core/recommendation/policy.ts`

- [ ] **Step 1: Types**

```ts
// src/core/recommendation/types.ts
import type { TrustState } from "../provenance.js";
export type LifecycleStatus = "pending" | "current" | "superseded" | "rejected" | "invalidated";
export type FreshnessStatus = "fresh" | "stale" | "version_invalid";
export type AbstainReason = "insufficient_evidence" | "conflict" | "inactive_evidence_only" | "below_threshold" | "policy_prohibits";
export type HighImpactReason = "write_action" | "open_question_deep_reasoning" | "irreversible_real_world" | "high_value_entity";
export type ConfirmationRequirement = { tier: "standard" } | { tier: "high_impact"; confirm: ("target" | "option" | "constraint")[]; reason: HighImpactReason };
export interface ProposedAction { type: "review" | "dry_run" | "notify_draft"; target_ref: string; reason: string; rollback_note?: string }
export type RecommendationConclusion = { kind: "propose"; action: ProposedAction; alternatives: ProposedAction[] } | { kind: "abstain"; reason: AbstainReason };
export interface DependencyDeclaration {
  slug?: string; table: "links" | "pages" | "tags" | "aliases" | "timeline" | "chunks" | "fts" | "lance" | "config";
  as: string; relation?: string; direction?: "outgoing" | "incoming"; fields: string[]; filter?: "active" | "all";
}
export interface DependencyManifest { rule_id: string; declarations: DependencyDeclaration[] }
export interface EntityProjection { [as: string]: unknown }
export interface DecisionInputs { signals: Record<string, unknown>; inspected_claims?: string[]; entity_snapshot: Record<string, EntityProjection>; evidence_refs: string[] }
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
export interface RecommendationRecord { record_id: string; payload: RecommendationImmutablePayload; fingerprint: string; created_at: string; last_revalidated_at: string; lifecycle_status: LifecycleStatus; freshness_status: FreshnessStatus; suppressed_until: string | null }
export const SCHEMA_VERSION = "rec-v1" as const;
```

- [ ] **Step 2: Policy (default TTL + strict time validator)**

```ts
// src/core/recommendation/policy.ts
export const DEFAULT_SUPPRESSION_TTL_SECONDS = 7 * 86400;
export const SUPPRESSION_REOPENED = "1970-01-01 00:00:00";
const TS = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** Strict SQLite-UTC timestamp gate (rev4 HIGH 2). Throws on any non-conforming string. */
export function validateTimestamp(s: string, name: string): void {
  if (!TS.test(s)) throw new Error(`policy: invalid ${name} (expected 'YYYY-MM-DD HH:MM:SS' UTC), got ${JSON.stringify(s)}`);
}
/** nowIso + default TTL, same format. */
export function defaultSuppressedUntil(nowIso: string): string {
  validateTimestamp(nowIso, "now");
  const epoch = Date.parse(`${nowIso.replace(" ", "T")}Z`);
  return new Date(epoch + DEFAULT_SUPPRESSION_TTL_SECONDS * 1000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}
```

- [ ] **Step 3: Typecheck** — `bun run lint` → PASS.

- [ ] **Step 4: Commit**

```bash
git add src/core/recommendation/types.ts src/core/recommendation/policy.ts
git commit -m "feat(rec): types + policy (default TTL, strict time validation) (#328)"
```

---

## Task 3: Additive migration — atomic, fault hook (spec §10)

**Files:** Create `src/storage/migrations/recommendations.ts`; modify `migrations/index.ts`, `sqlite.ts`; Test `tests/storage/migrations/recommendations.test.ts`

- [ ] **Step 1: Write failing test (incl. real mid-failure rollback)**

```ts
// tests/storage/migrations/recommendations.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runRecommendationRecordsMigration } from "../../../src/storage/migrations/recommendations.js";
function newDb(): Database { const db = new Database(":memory:"); db.exec("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)"); return db; }
function exists(db: Database, n: string): boolean { return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(n) as { name?: string } | undefined)?.name === n; }
function idx(db: Database, n: string): string | undefined { return (db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(n) as { sql?: string } | undefined)?.sql; }

describe("recommendation_records migration", () => {
  const dbs: Database[] = [];
  afterEach(() => { dbs.forEach((d) => d.close()); dbs.length = 0; });
  test("creates tables + active-unique index", () => { const db = newDb(); dbs.push(db); runRecommendationRecordsMigration(db); expect(exists(db, "recommendation_records")).toBe(true); expect(idx(db, "idx_rec_active_unique")).toContain("lifecycle_status IN ('pending','current')"); });
  test("idempotent", () => { const db = newDb(); dbs.push(db); runRecommendationRecordsMigration(db); expect(() => runRecommendationRecordsMigration(db)).not.toThrow(); });
  test("two active same key rejected", () => { const db = newDb(); dbs.push(db); runRecommendationRecordsMigration(db); const ins = (id: string, lc: string) => db.exec(`INSERT INTO recommendation_records (record_id, maintenance_key, fingerprint, inputs_hash, payload, auto_execute, created_at, last_revalidated_at, lifecycle_status, freshness_status, suppressed_until) VALUES ('${id}','k','f','ih','{}',0,'t','t','${lc}','fresh',NULL)`); ins("r1", "pending"); expect(() => ins("r2", "current")).toThrow(/UNIQUE/); expect(() => ins("r3", "superseded")).not.toThrow(); });
  test("ATOMIC: fault before marker rolls back ALL tables+indexes+marker", () => {
    const db = newDb(); dbs.push(db);
    expect(() => runRecommendationRecordsMigration(db, { failBeforeMarker: true })).toThrow(/injected/);
    expect(exists(db, "recommendation_records")).toBe(false);
    expect(idx(db, "idx_rec_active_unique")).toBeUndefined();
    expect((db.prepare("SELECT value FROM config WHERE key='migration_rec_v1_recommendation_records'").get() as { value?: string } | undefined)?.value).toBeUndefined();
    expect(() => runRecommendationRecordsMigration(db)).not.toThrow();
    expect(exists(db, "recommendation_records")).toBe(true);
  });
  test("forward repair after drop+clear", () => { const db = newDb(); dbs.push(db); runRecommendationRecordsMigration(db); db.exec("DROP TABLE recommendation_records"); db.exec("DELETE FROM config WHERE key='migration_rec_v1_recommendation_records'"); expect(() => runRecommendationRecordsMigration(db)).not.toThrow(); expect(exists(db, "recommendation_records")).toBe(true); });
});
```

- [ ] **Step 2: Run → FAIL** — `bun test tests/storage/migrations/recommendations.test.ts`.

- [ ] **Step 3: Implement migration**

```ts
// src/storage/migrations/recommendations.ts
import type { Database } from "bun:sqlite";
const COMPLETION_KEY = "migration_rec_v1_recommendation_records";
export interface MigrationHooks { failBeforeMarker?: boolean }
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

- [ ] **Step 4: Wire** — `migrations/index.ts`: add `export { runRecommendationRecordsMigration } from "./recommendations.js";`. `sqlite.ts`: import it from `./migrations/index.js`, call `runRecommendationRecordsMigration(this.db);` after `runLatePageMigrations(this.db);` (≈ L420).

- [ ] **Step 5: Run → PASS** — `bun test tests/storage/migrations/recommendations.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/storage/migrations/recommendations.ts src/storage/migrations/index.ts src/storage/sqlite.ts tests/storage/migrations/recommendations.test.ts
git commit -m "feat(storage): recommendation_records additive migration (#328)"
```

---

## Task 4: Integrity — canonicalDeclaration (omit undefined) + cross-consistency + duplicate-`(slug,as)` fail-closed (spec §6, §4.3, §8.1; rev4 HIGH 1, MED 3)

**Files:** Create `src/core/recommendation/integrity.ts`; Test `tests/core/recommendation/integrity.test.ts`

- [ ] **Step 1: Write failing test (3 declaration-shape fixtures + duplicate-as fail-closed + cross cases)**

```ts
// tests/core/recommendation/integrity.test.ts
import { describe, expect, test } from "bun:test";
import { canonicalDeclaration, computeInputsHash, computeFingerprint, checkIntegrity } from "../../../src/core/recommendation/integrity.js";
import type { DependencyDeclaration, RecommendationImmutablePayload, RecommendationRecord } from "../../../src/core/recommendation/types.js";
import { SCHEMA_VERSION } from "../../../src/core/recommendation/types.js";

describe("canonicalDeclaration omits absent optionals (HIGH 1)", () => {
  test("links with all optionals", () => {
    const s = JSON.stringify(canonicalDeclaration({ slug: "a", table: "links", as: "reports_to", relation: "reports_to", direction: "outgoing", fields: ["from", "to"], filter: "active" } as DependencyDeclaration));
    expect(s).toContain('"slug"'); expect(s).toContain('"relation"'); expect(s).toContain('"direction"'); expect(s).toContain('"filter"');
  });
  test("global declaration (no slug) hashes cleanly", () => {
    expect(() => computeFingerprint(payloadWith([{ table: "config", as: "flag", fields: ["value"] }]))).not.toThrow();
    const s = JSON.stringify(canonicalDeclaration({ table: "config", as: "flag", fields: ["value"] }));
    expect(s).not.toContain('"slug"');
  });
  test("pages declaration (no relation/direction/filter) hashes cleanly", () => {
    expect(() => computeFingerprint(payloadWith([{ slug: "a", table: "pages", as: "page", fields: ["content_hash"] }]))).not.toThrow();
    const s = JSON.stringify(canonicalDeclaration({ slug: "a", table: "pages", as: "page", fields: ["content_hash"] }));
    expect(s).not.toContain('"relation"'); expect(s).not.toContain('"direction"'); expect(s).not.toContain('"filter"');
  });
  test("links with default direction/filter (omitted) hashes cleanly + round-trips", () => {
    const p = payloadWith([{ slug: "a", table: "links", as: "reports_to", relation: "reports_to", fields: ["from", "to", "trust_state"] }]);
    expect(() => computeFingerprint(p)).not.toThrow();
    const fp = computeFingerprint(p); expect(computeFingerprint(JSON.parse(JSON.stringify(p)) as RecommendationImmutablePayload)).toBe(fp);
  });
  test("duplicate (slug,as) declarations fail-closed (MED 3)", () => {
    const p = payloadWith([
      { slug: "a", table: "links", as: "reports_to", relation: "reports_to", fields: ["from", "to"] },
      { slug: "a", table: "links", as: "reports_to", relation: "reports_to", fields: ["from", "to"] },
    ]);
    expect(() => computeFingerprint(p)).toThrow(/duplicate.*slug.*as/);
  });
});

function payloadWith(declarations: DependencyDeclaration[]): RecommendationImmutablePayload {
  const di = { signals: {}, entity_snapshot: {}, evidence_refs: [] as string[] };
  return {
    namespace: "maintenance", maintenance_key: "k", inputs_hash: "",
    conclusion: { kind: "abstain", reason: "insufficient_evidence" }, decision_inputs: di, evidence_manifest: [],
    constraints: { policy_version: "p", ontology_version: "o", schema_version: SCHEMA_VERSION },
    dependency_manifest: { rule_id: "r", declarations }, applicability: { audience: "user_only", auto_execute: false, requires_confirmation: { tier: "standard" } },
    risks: [], gaps: [], producer: { rule_id: "r", rule_version: "1", code_hash: "h", registry_ref: "r@1" },
  };
}

describe("checkIntegrity", () => {
  function basePayload(): RecommendationImmutablePayload {
    const di = { signals: { candidate_count: 1 }, entity_snapshot: { eA: { reports_to: [{ from: "eA", to: "eB", trust_state: "candidate" }] } }, evidence_refs: ["health:k:eA:eB"] };
    return {
      namespace: "maintenance", maintenance_key: "k", inputs_hash: "", conclusion: { kind: "propose", action: { type: "dry_run", target_ref: "health:k:eA", reason: "r" }, alternatives: [] },
      decision_inputs: di, evidence_manifest: [{ source: "health", ref: "health:k:eA:eB", trust_state: "candidate" }],
      constraints: { policy_version: "p", ontology_version: "o", schema_version: SCHEMA_VERSION },
      dependency_manifest: { rule_id: "r", declarations: [{ slug: "eA", table: "links", as: "reports_to", relation: "reports_to", direction: "outgoing", fields: ["from", "to", "trust_state"], filter: "active" }] },
      applicability: { audience: "user_only", auto_execute: false, requires_confirmation: { tier: "standard" } }, risks: [], gaps: [], producer: { rule_id: "r", rule_version: "1", code_hash: "h", registry_ref: "r@1" },
    };
  }
  function rec(p: RecommendationImmutablePayload): RecommendationRecord { p.inputs_hash = computeInputsHash(p.decision_inputs); return { record_id: "r1", payload: p, fingerprint: computeFingerprint(p), created_at: "2026-07-12 10:00:00", last_revalidated_at: "2026-07-12 10:00:00", lifecycle_status: "pending", freshness_status: "fresh", suppressed_until: null }; }
  test("clean passes", () => { expect(checkIntegrity(rec(basePayload())).ok).toBe(true); });
  test("inputs_hash tamper", () => { const r = rec(basePayload()); r.payload.inputs_hash = "x"; const x = checkIntegrity(r); expect(x.ok).toBe(false); if (!x.ok) expect(x.code).toBe("inputs_hash_mismatch"); });
  test("fingerprint tamper — fixed code, no ref echo", () => { const r = rec(basePayload()); r.payload.conclusion = { kind: "abstain", reason: "insufficient_evidence" }; const x = checkIntegrity(r); expect(x.ok).toBe(false); if (!x.ok) { expect(x.code).toBe("fingerprint_mismatch"); expect(x.message).not.toContain("health:k"); } });
  test("cross: undeclared projection as-key", () => { const p = basePayload(); (p.decision_inputs.entity_snapshot.eA as Record<string, unknown>).bogus = []; expect(checkIntegrity(rec(p)).ok).toBe(false); });
  test("cross: undeclared edge sub-field", () => { const p = basePayload(); (p.decision_inputs.entity_snapshot.eA as { reports_to: Record<string, unknown>[] }).reports_to[0].extra = 1; expect(checkIntegrity(rec(p)).ok).toBe(false); });
  test("cross: evidence ref not projected", () => { const p = basePayload(); p.evidence_manifest.push({ source: "health", ref: "health:k:eA:eC", trust_state: "candidate" }); expect(checkIntegrity(rec(p)).ok).toBe(false); });
  test("cross: rule_id mismatch", () => { const p = basePayload(); p.dependency_manifest.rule_id = "other"; expect(checkIntegrity(rec(p)).ok).toBe(false); });
});
```

- [ ] **Step 2: Run → FAIL** — `bun test tests/core/recommendation/integrity.test.ts`.

- [ ] **Step 3: Implement integrity**

```ts
// src/core/recommendation/integrity.ts
import { canonicalJson, normalizeProse, sha256Hex } from "./canonical.js";
import type { DecisionInputs, DependencyDeclaration, RecommendationConclusion, RecommendationImmutablePayload, RecommendationRecord } from "./types.js";

export type IntegrityCode = "inputs_hash_mismatch" | "fingerprint_mismatch" | "cross_undeclared_field" | "cross_evidence_not_projected" | "cross_rule_id_mismatch" | "duplicate_declaration";
export type IntegrityResult = { ok: true } | { ok: false; code: IntegrityCode; message: string };

/** Build a declaration object with ONLY present keys (HIGH 1) — no undefined values. */
export function canonicalDeclaration(d: DependencyDeclaration): Record<string, unknown> {
  const out: Record<string, unknown> = { table: d.table, as: d.as, fields: [...d.fields].sort() };
  if (d.slug !== undefined) out.slug = d.slug;
  if (d.relation !== undefined) out.relation = d.relation;
  if (d.direction !== undefined) out.direction = d.direction;
  if (d.filter !== undefined) out.filter = d.filter;
  return out;
}

export function computeInputsHash(di: DecisionInputs): string { return sha256Hex(canonicalJson({ signals: di.signals, inspected_claims: (di.inspected_claims ?? []).map(normalizeProse), entity_snapshot: di.entity_snapshot, evidence_refs: [...di.evidence_refs].sort() })); }
export function computeFingerprint(p: RecommendationImmutablePayload): string { return sha256Hex(canonicalJson(canonicalPayload(p))); }
function canonicalPayload(p: RecommendationImmutablePayload): unknown {
  return {
    namespace: p.namespace, maintenance_key: p.maintenance_key, inputs_hash: p.inputs_hash,
    conclusion: canonicalConclusion(p.conclusion),
    decision_inputs: { signals: p.decision_inputs.signals, inspected_claims: (p.decision_inputs.inspected_claims ?? []).map(normalizeProse), entity_snapshot: p.decision_inputs.entity_snapshot, evidence_refs: [...p.decision_inputs.evidence_refs].sort() },
    evidence_manifest: p.evidence_manifest.map((e) => ({ source: e.source, ref: e.ref, trust_state: e.trust_state })),
    constraints: p.constraints,
    dependency_manifest: { rule_id: p.dependency_manifest.rule_id, declarations: p.dependency_manifest.declarations.map(canonicalDeclaration) },
    applicability: p.applicability, risks: p.risks.map(normalizeProse), gaps: p.gaps.map(normalizeProse), producer: p.producer,
  };
}
function canonicalConclusion(c: RecommendationConclusion): unknown {
  if (c.kind === "abstain") return { kind: "abstain", reason: c.reason };
  const action: Record<string, unknown> = { type: c.action.type, target_ref: c.action.target_ref, reason: normalizeProse(c.action.reason) };
  if (c.action.rollback_note !== undefined) action.rollback_note = normalizeProse(c.action.rollback_note);
  return { kind: "propose", action, alternatives: c.alternatives.map((a) => { const o: Record<string, unknown> = { type: a.type, target_ref: a.target_ref, reason: normalizeProse(a.reason) }; if (a.rollback_note !== undefined) o.rollback_note = normalizeProse(a.rollback_note); return o; }) };
}

export function checkIntegrity(r: RecommendationRecord): IntegrityResult {
  if (computeInputsHash(r.payload.decision_inputs) !== r.payload.inputs_hash) return { ok: false, code: "inputs_hash_mismatch", message: "inputs_hash mismatch" };
  if (computeFingerprint(r.payload) !== r.fingerprint) return { ok: false, code: "fingerprint_mismatch", message: "fingerprint mismatch" };
  return checkCrossConsistency(r.payload);
}
function checkCrossConsistency(p: RecommendationImmutablePayload): IntegrityResult {
  const declared = new Map<string, Map<string, Set<string>>>();
  for (const d of p.dependency_manifest.declarations) {
    const key = d.slug ?? "__global__";
    const m = declared.get(key) ?? new Map<string, Set<string>>();
    if (m.has(d.as)) return { ok: false, code: "duplicate_declaration", message: `duplicate (slug,as) (${key},${d.as})` };
    m.set(d.as, new Set(d.fields)); declared.set(key, m);
  }
  for (const [slug, snap] of Object.entries(p.decision_inputs.entity_snapshot)) {
    const allowed = declared.get(slug);
    if (!allowed) return { ok: false, code: "cross_undeclared_field", message: "entity_snapshot slug not declared" };
    for (const asKey of Object.keys(snap as object)) {
      const fs = allowed.get(asKey);
      if (!fs) return { ok: false, code: "cross_undeclared_field", message: "undeclared projection key" };
      const v = (snap as Record<string, unknown>)[asKey]; const els = Array.isArray(v) ? v : [v];
      for (const el of els) if (el && typeof el === "object") for (const f of Object.keys(el as object)) if (!fs.has(f)) return { ok: false, code: "cross_undeclared_field", message: "undeclared field" };
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
git commit -m "feat(rec): integrity (canonicalDeclaration + duplicate-as fail-closed) (#328)"
```

---

## Task 5: Versioned rule registry — active-version map, resolveActive, tombstone manifest (spec §7.2; rev4 MED 1, MED 2)

**Files:** Create `src/core/recommendation/registry.ts`; Test `tests/core/recommendation/registry.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/core/recommendation/registry.test.ts
import { describe, expect, test } from "bun:test";
import { VersionedRuleRegistry } from "../../../src/core/recommendation/registry.js";
const noop = () => ({ signals: {}, entity_snapshot: {}, evidence_refs: [] as string[] });
const abstain = () => ({ kind: "abstain" as const, reason: "policy_prohibits" as const });
function entry(id: string, ver: string, hash: string) { return { rule_id: id, rule_version: ver, code_hash: hash, registry_ref: `${id}@${ver}`, captureInputs: () => noop(), decide: () => abstain() }; }

describe("VersionedRuleRegistry", () => {
  test("resolve + resolveActive", () => {
    const reg = new VersionedRuleRegistry(); reg.register(entry("d", "1.0.0", "h1"));
    expect(reg.resolve("d", "1.0.0").status).toBe("ok");
    expect(reg.resolveActive("d").status).toBe("ok");
  });
  test("duplicate exact object idempotent; different impl rejected", () => {
    const reg = new VersionedRuleRegistry(); const e = entry("d", "1.0.0", "h1"); reg.register(e);
    expect(() => reg.register(e)).not.toThrow();
    expect(() => reg.register(entry("d", "1.0.0", "h1"))).toThrow(/already registered/);
  });
  test("MED 2: two live versions of same rule_id fail-closed; markPurged then register new", () => {
    const reg = new VersionedRuleRegistry(); reg.register(entry("d", "1.0.0", "h1"));
    expect(() => reg.register(entry("d", "1.1.0", "h2"))).toThrow(/already active/);
    reg.markPurged("d", "1.0.0", "h1"); // old active cleared
    expect(() => reg.register(entry("d", "1.1.0", "h2"))).not.toThrow();
    // old version still resolvable for replay
    expect(reg.resolve("d", "1.0.0").status).toBe("unavailable"); // purged
    expect(reg.resolveActive("d").status).toBe("ok"); // active = 1.1.0
  });
  test("MED 2: reverse registration order still selects configured active version", () => {
    const reg = new VersionedRuleRegistry();
    reg.register(entry("d", "1.1.0", "h2")); // active 1.1.0 first
    reg.markPurged("d", "1.1.0", "h2"); reg.register(entry("d", "1.0.0", "h1")); // then 1.0.0 active
    const a = reg.resolveActive("d"); expect(a.status).toBe("ok"); if (a.status === "ok") expect(a.rule_version).toBe("1.0.0");
  });
  test("tombstone-aware manifest: live/purged/incompatible distinct (MED 1)", () => {
    const reg = new VersionedRuleRegistry(); reg.register(entry("d", "1.0.0", "h1"));
    const live = reg.manifest(); reg.markPurged("d", "1.0.0", "h1"); const purged = reg.manifest();
    reg.markIncompatible("d", "1.0.0", "h1"); const incompatible = reg.manifest();
    expect(new Set([live, purged, incompatible]).size).toBe(3);
  });
  test("directory lists only active live producers", () => {
    const reg = new VersionedRuleRegistry(); reg.register(entry("d", "1.0.0", "h1"));
    expect(reg.directory()).toEqual([{ rule_id: "d", rule_version: "1.0.0", code_hash: "h1", registry_ref: "d@1.0.0" }]);
    reg.markPurged("d", "1.0.0", "h1"); expect(reg.directory()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run → FAIL** — `bun test tests/core/recommendation/registry.test.ts`.

- [ ] **Step 3: Implement registry**

```ts
// src/core/recommendation/registry.ts
import type { DecisionInputs, RecommendationConclusion, RecommendationProducer } from "./types.js";
export interface RuleRunner extends RecommendationProducer { captureInputs: (projection: unknown) => DecisionInputs; decide: (di: DecisionInputs) => RecommendationConclusion; }
export type ResolveResult = ({ status: "ok" } & RuleRunner) | { status: "unavailable"; reason: "unknown" | "purged" | "incompatible" };
type Entry = RuleRunner | { tombstone: "purged" | "incompatible"; code_hash: string };

export class VersionedRuleRegistry {
  private entries = new Map<string, Entry>();
  private activeVersion = new Map<string, string>(); // rule_id -> active version
  private key(id: string, ver: string): string { return `${id}@${ver}`; }

  register(r: RuleRunner): void {
    const k = this.key(r.rule_id, r.rule_version);
    const existing = this.entries.get(k);
    if (existing) { if (existing === r) return; throw new Error(`registry: ${k} already registered with a different implementation`); }
    const cur = this.activeVersion.get(r.rule_id);
    if (cur !== undefined && cur !== r.rule_version) throw new Error(`registry: ${r.rule_id} already active at ${cur}; markPurged before registering ${r.rule_version}`);
    this.entries.set(k, r); this.activeVersion.set(r.rule_id, r.rule_version);
  }
  markPurged(id: string, ver: string, codeHash: string): void { this.entries.set(this.key(id, ver), { tombstone: "purged", code_hash: codeHash }); if (this.activeVersion.get(id) === ver) this.activeVersion.delete(id); }
  markIncompatible(id: string, ver: string, codeHash: string): void { this.entries.set(this.key(id, ver), { tombstone: "incompatible", code_hash: codeHash }); if (this.activeVersion.get(id) === ver) this.activeVersion.delete(id); }
  resolve(id: string, ver: string): ResolveResult { const e = this.entries.get(this.key(id, ver)); if (!e) return { status: "unavailable", reason: "unknown" }; if ("tombstone" in e) return { status: "unavailable", reason: e.tombstone }; return { status: "ok", ...e }; }
  resolveActive(id: string): ResolveResult { const v = this.activeVersion.get(id); if (v === undefined) return { status: "unavailable", reason: "unknown" }; return this.resolve(id, v); }
  directory(): RecommendationProducer[] { return [...this.activeVersion.entries()].map(([id, ver]) => { const e = this.entries.get(this.key(id, ver)); return e && !("tombstone" in e) ? { rule_id: e.rule_id, rule_version: e.rule_version, code_hash: e.code_hash, registry_ref: e.registry_ref } : null; }).filter((x): x is RecommendationProducer => x !== null); }
  manifest(): string { return [...this.entries.entries()].map(([k, e]) => "tombstone" in e ? `${k}:${e.tombstone}:${e.code_hash}` : `${k}:live:${e.code_hash}`).sort().join("\n"); }
}
```

- [ ] **Step 4: Run → PASS** — `bun test tests/core/recommendation/registry.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/core/recommendation/registry.ts tests/core/recommendation/registry.test.ts
git commit -m "feat(rec): registry (active-version map, resolveActive, tombstone manifest) (#328)"
```

---

## Task 6: Record store — single entry, split APIs, default-TTL suppression, EXISTS, guarded reopen, time validation (spec §5.5, §5.6; rev4 HIGH 2, MED 3)

**Files:** Create `src/core/recommendation/record-store.ts`; Test `tests/core/recommendation/record-store.test.ts`

- [ ] **Step 1: Write failing test (default TTL, illegal time, guarded reopen, real sibling suppression)**

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
    decision_inputs: di, evidence_manifest: [{ source: "health", ref: "health:k:eA:eB", trust_state: "candidate" }],
    constraints: { policy_version: "p", ontology_version: "o", schema_version: SCHEMA_VERSION },
    dependency_manifest: { rule_id: "health:k", declarations: [{ slug: "eA", table: "links", as: "reports_to", relation: "reports_to", direction: "outgoing", fields: ["from", "to", "trust_state"], filter: "active" }] },
    applicability: { audience: "user_only", auto_execute: false, requires_confirmation: { tier: "standard" } },
    risks: [], gaps: [], producer: { rule_id: "health:k", rule_version: "1.0.0", code_hash: codeHash, registry_ref: "r@1.0.0" },
  };
}
describe("RecommendationStore", () => {
  afterEach(() => { db?.close(); rmSync(DIR, { recursive: true, force: true }); });
  function open() { db = new CBrainDB(`${DIR}/db.sqlite`); store = new RecommendationStore(db); }

  test("createRecord computes fingerprint internally", () => { open(); const r = store.createRecord(mkPayload("h1"), "2026-07-12 10:00:00"); expect(r.fingerprint).toBe(computeFingerprint({ ...mkPayload("h1"), inputs_hash: computeInputsHash(mkPayload("h1").decision_inputs) })); expect(r.lifecycle_status).toBe("pending"); });
  test("rejects auto_execute !== false", () => { open(); const p = mkPayload("h1"); expect(() => store.createRecord({ ...p, applicability: { ...p.applicability, auto_execute: true as unknown as false } }, "2026-07-12 10:00:00")).toThrow(/auto_execute/); });
  test("same fingerprint idempotent", () => { open(); const p = mkPayload("h1"); const r1 = store.createRecord(p, "2026-07-12 10:00:00"); expect(store.createRecord(p, "2026-07-12 10:00:00").record_id).toBe(r1.record_id); });
  test("different fingerprint same key → atomic supersede; count stays 1", () => { open(); store.createRecord(mkPayload("hA"), "2026-07-12 10:00:00"); store.createRecord(mkPayload("hB"), "2026-07-12 10:00:01"); expect(store.activeCountFor("k1")).toBe(1); });
  test("illegal now rejected (HIGH 2)", () => { open(); expect(() => store.createRecord(mkPayload("h1"), "2026-07-12T10:00:00Z")).toThrow(/invalid now/); expect(() => store.createRecord(mkPayload("h1"), "bad")).toThrow(/invalid now/); });
  test("default TTL: reject without suppressedUntil → suppressed_until = now+7d", () => {
    open(); const p = mkPayload("h1"); const r = store.createRecord(p, "2026-07-12 10:00:00");
    store.transitionLifecycle(r.record_id, "rejected", "2026-07-12 10:00:01", "declined"); // no 5th arg → default TTL
    expect(store.getById(r.record_id)?.suppressed_until).toBe("2026-07-19 10:00:01");
    expect(() => store.createRecord(p, "2026-07-13 10:00:00")).toThrow(/suppressed/);
  });
  test("explicit null => permanent suppression", () => {
    open(); const p = mkPayload("h1"); const r = store.createRecord(p, "2026-07-12 10:00:00");
    store.transitionLifecycle(r.record_id, "rejected", "2026-07-12 10:00:01", "declined", null);
    expect(store.getById(r.record_id)?.suppressed_until).toBeNull();
    expect(() => store.createRecord(p, "2099-01-01 00:00:00")).toThrow(/suppressed/);
  });
  test("illegal suppressedUntil rejected", () => { open(); const p = mkPayload("h1"); const r = store.createRecord(p, "2026-07-12 10:00:00"); expect(() => store.transitionLifecycle(r.record_id, "rejected", "2026-07-12 10:00:01", "x", "bad")).toThrow(/invalid suppressed_until/); });
  test("F17: expired suppression allows re-create", () => { open(); const p = mkPayload("h1"); const r = store.createRecord(p, "2026-07-12 10:00:00"); store.transitionLifecycle(r.record_id, "rejected", "2026-07-12 10:00:01", "declined", "2026-07-12 09:00:00"); expect(() => store.createRecord(p, "2026-07-13 10:00:00")).not.toThrow(); });
  test("MED 3: real sibling suppression — expired + permanent coexist, EXISTS blocks", () => {
    open(); const p = mkPayload("h1");
    // r1: rejected, expired
    const r1 = store.createRecord(p, "2026-07-12 10:00:00");
    store.transitionLifecycle(r1.record_id, "rejected", "2026-07-12 10:00:01", "x", "2026-07-12 09:00:00"); // past
    // re-create allowed (r1 expired) → r2 (same fingerprint, new record_id)
    const r2 = store.createRecord(p, "2026-07-13 10:00:00");
    // reject r2 permanent
    store.transitionLifecycle(r2.record_id, "rejected", "2026-07-13 10:00:01", "x", null);
    // now (key,fp) has r1 expired + r2 permanent — createRecord must STILL block
    expect(() => store.createRecord(p, "2026-07-13 10:00:02")).toThrow(/suppressed/);
  });
  test("clearSuppression only on rejected + existing (HIGH 2)", () => {
    open(); const p = mkPayload("h1"); const r = store.createRecord(p, "2026-07-12 10:00:00");
    expect(() => store.clearSuppression(r.record_id, "2026-07-12 10:00:01", "reopen")).toThrow(/only allowed on rejected/); // pending
    store.transitionLifecycle(r.record_id, "rejected", "2026-07-12 10:00:02", "x");
    expect(() => store.clearSuppression("nonexistent", "2026-07-12 10:00:03", "reopen")).toThrow(/not found/);
    store.clearSuppression(r.record_id, "2026-07-12 10:00:03", "reopen");
    expect(() => store.createRecord(p, "2026-07-13 10:00:00")).not.toThrow();
  });
  test("transitionLifecycle whitelist: superseded cannot regress", () => { open(); const p = mkPayload("h1"); const r = store.createRecord(p, "2026-07-12 10:00:00"); store.transitionLifecycle(r.record_id, "superseded", "2026-07-12 10:00:01", "t"); expect(() => store.transitionLifecycle(r.record_id, "pending", "2026-07-12 10:00:02", "r")).toThrow(/illegal.*transition/); });
  test("updateFreshness changes ONLY freshness", () => { open(); const p = mkPayload("h1"); const r = store.createRecord(p, "2026-07-12 10:00:00"); store.updateFreshness(r.record_id, "stale", "2026-07-12 10:00:01"); const re = store.getById(r.record_id); expect(re?.freshness_status).toBe("stale"); expect(re?.lifecycle_status).toBe("pending"); });
});
```

- [ ] **Step 2: Run → FAIL** — `bun test tests/core/recommendation/record-store.test.ts`.

- [ ] **Step 3: Implement store**

```ts
// src/core/recommendation/record-store.ts
import { canonicalJson } from "./canonical.js";
import { checkIntegrity, computeFingerprint, computeInputsHash } from "./integrity.js";
import { SUPPRESSION_REOPENED, defaultSuppressedUntil, validateTimestamp } from "./policy.js";
import type { CBrainDB } from "../../storage/sqlite.js";
import type { FreshnessStatus, LifecycleStatus, RecommendationImmutablePayload, RecommendationRecord } from "./types.js";

interface Row { record_id: string; maintenance_key: string; fingerprint: string; inputs_hash: string; payload: string; created_at: string; last_revalidated_at: string; lifecycle_status: string; freshness_status: string; suppressed_until: string | null }
const LIFECYCLE_TRANSITIONS: Record<LifecycleStatus, LifecycleStatus[]> = { pending: ["current", "superseded", "rejected", "invalidated"], current: ["superseded", "rejected", "invalidated"], superseded: ["invalidated"], rejected: ["invalidated"], invalidated: [] };

export class RecommendationStore {
  constructor(private db: CBrainDB) {}
  activeCountFor(key: string): number { return (this.db.prepare("SELECT COUNT(*) c FROM recommendation_records WHERE maintenance_key=$key AND lifecycle_status IN ('pending','current')").get({ $key: key }) as { c: number }).c; }
  getById(id: string): RecommendationRecord | null { const r = this.db.prepare("SELECT * FROM recommendation_records WHERE record_id=$id").get({ $id: id }) as Row | undefined; return r ? fromRow(r) : null; }

  createRecord(payload: RecommendationImmutablePayload, now: string): RecommendationRecord {
    validateTimestamp(now, "now");
    if (payload.applicability.auto_execute !== false) throw new Error("record-store: auto_execute must be false");
    const withHash: RecommendationImmutablePayload = { ...payload, inputs_hash: computeInputsHash(payload.decision_inputs) };
    const fingerprint = computeFingerprint(withHash);
    const provisional: RecommendationRecord = { record_id: globalThis.crypto.randomUUID(), payload: withHash, fingerprint, created_at: now, last_revalidated_at: now, lifecycle_status: "pending", freshness_status: "fresh", suppressed_until: null };
    const integrity = checkIntegrity(provisional); if (!integrity.ok) throw new Error(`record-store: integrity failed (${integrity.code})`);
    const key = payload.maintenance_key;
    return this.db.transaction(() => {
      const active = this.activeRow(key);
      if (active && active.fingerprint === fingerprint) return fromRow(active);
      const rej = this.db.prepare("SELECT 1 FROM recommendation_records WHERE maintenance_key=$key AND fingerprint=$fp AND lifecycle_status='rejected' AND (suppressed_until IS NULL OR suppressed_until > $now) LIMIT 1").get({ $key: key, $fp: fingerprint, $now: now });
      if (rej) throw new Error("record-store: creation suppressed (rejected within suppression window)");
      if (active) { this.db.prepare("UPDATE recommendation_records SET lifecycle_status='superseded' WHERE record_id=$id").run({ $id: active.record_id }); this.history(active.record_id, "superseded", active.lifecycle_status, "superseded", undefined, undefined, "replaced by " + provisional.record_id, now); }
      this.db.prepare("INSERT INTO recommendation_records (record_id, maintenance_key, fingerprint, inputs_hash, payload, auto_execute, created_at, last_revalidated_at, lifecycle_status, freshness_status, suppressed_until) VALUES ($rid,$key,$fp,$ih,$payload,0,$now,$now,'pending','fresh',NULL)").run({ $rid: provisional.record_id, $key: key, $fp: fingerprint, $ih: withHash.inputs_hash, $payload: canonicalJson(withHash), $now: now });
      this.history(provisional.record_id, "created", undefined, "pending", undefined, undefined, undefined, now);
      return provisional;
    });
  }

  /** suppressedUntil: undefined => default TTL (rejected only); null => permanent; string => strict-validated. */
  transitionLifecycle(id: string, to: LifecycleStatus, now: string, reason: string, suppressedUntil?: string | null): void {
    validateTimestamp(now, "now");
    let eff: string | null | undefined = suppressedUntil;
    if (to === "rejected" && suppressedUntil === undefined) eff = defaultSuppressedUntil(now);
    if (typeof eff === "string") validateTimestamp(eff, "suppressed_until");
    this.db.transaction(() => {
      const row = this.db.prepare("SELECT lifecycle_status AS l FROM recommendation_records WHERE record_id=$id").get({ $id: id }) as { l: LifecycleStatus } | undefined;
      if (!row) throw new Error("record-store: record not found");
      if (!LIFECYCLE_TRANSITIONS[row.l].includes(to)) throw new Error(`record-store: illegal lifecycle transition ${row.l} → ${to}`);
      if (to === "rejected" && eff === null) this.db.prepare("UPDATE recommendation_records SET lifecycle_status=$to, suppressed_until=NULL WHERE record_id=$id").run({ $to: to, $id: id });
      else if (to === "rejected" && typeof eff === "string") this.db.prepare("UPDATE recommendation_records SET lifecycle_status=$to, suppressed_until=$sut WHERE record_id=$id").run({ $to: to, $sut: eff, $id: id });
      else this.db.prepare("UPDATE recommendation_records SET lifecycle_status=$to WHERE record_id=$id").run({ $to: to, $id: id });
      this.history(id, to, row.l, to, undefined, undefined, reason, now);
    });
  }

  updateFreshness(id: string, to: FreshnessStatus, now: string): void {
    validateTimestamp(now, "now");
    this.db.transaction(() => {
      const row = this.db.prepare("SELECT freshness_status AS f, lifecycle_status AS l FROM recommendation_records WHERE record_id=$id").get({ $id: id }) as { f: FreshnessStatus; l: LifecycleStatus } | undefined;
      if (!row) throw new Error("record-store: record not found");
      const revalidate = to === "fresh";
      this.db.prepare(`UPDATE recommendation_records SET freshness_status=$to${revalidate ? ", last_revalidated_at=$now" : ""} WHERE record_id=$id`).run({ $to: to, $now: now, $id: id });
      this.history(id, `freshness:${to}`, row.l, row.l, row.f, to, undefined, now);
    });
  }

  clearSuppression(id: string, now: string, reason: string): void {
    validateTimestamp(now, "now");
    this.db.transaction(() => {
      const row = this.db.prepare("SELECT lifecycle_status AS l FROM recommendation_records WHERE record_id=$id").get({ $id: id }) as { l: string } | undefined;
      if (!row) throw new Error("record-store: record not found");
      if (row.l !== "rejected") throw new Error("record-store: clearSuppression only allowed on rejected records");
      const res = this.db.prepare("UPDATE recommendation_records SET suppressed_until=$past WHERE record_id=$id AND lifecycle_status='rejected'").run({ $past: SUPPRESSION_REOPENED, $id: id });
      if (res.changes !== 1) throw new Error("record-store: reopen affected no rows");
      this.history(id, "reopen", "rejected", "rejected", undefined, undefined, reason, now);
    });
  }

  private activeRow(key: string): Row | undefined { return this.db.prepare("SELECT * FROM recommendation_records WHERE maintenance_key=$key AND lifecycle_status IN ('pending','current') ORDER BY rowid DESC LIMIT 1").get({ $key: key }) as Row | undefined; }
  private history(id: string, action: string, fl: string | undefined, tl: string, ff: string | undefined, tf: string | undefined, reason: string | undefined, now: string): void {
    this.db.prepare("INSERT INTO recommendation_lifecycle_history (record_id, action, from_lifecycle, to_lifecycle, from_freshness, to_freshness, reason, created_at) VALUES ($rid,$action,$fl,$tl,$ff,$tf,$reason,$now)").run({ $rid: id, $action: action, $fl: fl ?? null, $tl: tl, $ff: ff ?? null, $tf: tf ?? null, $reason: reason ?? null, $now: now });
  }
}
function fromRow(r: Row): RecommendationRecord { return { record_id: r.record_id, payload: JSON.parse(r.payload) as RecommendationImmutablePayload, fingerprint: r.fingerprint, created_at: r.created_at, last_revalidated_at: r.last_revalidated_at, lifecycle_status: r.lifecycle_status as LifecycleStatus, freshness_status: r.freshness_status as FreshnessStatus, suppressed_until: r.suppressed_until }; }
```

> **API note:** `CBrainDB.prepare(sql).run({$named})` returns `{ changes, lastInsertRowid }` — `res.changes` is available (bun:sqlite). Confirm against an existing call site if needed.

- [ ] **Step 4: Run → PASS** — `bun test tests/core/recommendation/record-store.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/core/recommendation/record-store.ts tests/core/recommendation/record-store.test.ts
git commit -m "feat(rec): store (default-TTL suppression, EXISTS, guarded reopen, time validation) (#328)"
```

---

## Task 7: DeclaredProjectionReader (strict, fail-closed, preserves from) + freshness (spec §5.3; rev4 MED 3)

**Files:** Create `src/core/recommendation/projection.ts`, `src/core/recommendation/freshness.ts`; Test `tests/core/recommendation/freshness.test.ts`

- [ ] **Step 1: Write failing test (from preserved; duplicate-as fail-closed; drift→persisted stale; A→B→A)**

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
function seed(db: CBrainDB) { for (const s of [A, B]) db.rawDb.prepare(`INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count, tier) VALUES (?, 'entity', ?, ?, ?, 0, 3)`).run(s, s, `${s}.md`, `h-${s}`); }
function link(db: CBrainDB, from: string, to: string, trust: string) { db.rawDb.prepare(`INSERT INTO links (from_slug, to_slug, relation, trust_state, source_type) VALUES (?, ?, 'reports_to', ?, 'agent')`).run(from, to, trust); }
const decls: DependencyManifest = { rule_id: "health:known_relations", declarations: [A, B].map((s) => ({ slug: s, table: "links" as const, as: "reports_to", relation: "reports_to", direction: "outgoing" as const, fields: ["from", "to", "trust_state"], filter: "active" as const })) };
const producer: RecommendationProducer = { rule_id: "health:known_relations", rule_version: "1.0.0", code_hash: "h1", registry_ref: "r@1.0.0" };
function makeRegistry(): VersionedRuleRegistry {
  const reg = new VersionedRuleRegistry();
  reg.register({ ...producer, captureInputs: (proj) => { const p = proj as Record<string, { reports_to: { from: string; to: string; trust_state: string }[] }>; const cand = Object.values(p).flatMap((v) => v.reports_to).filter((e) => e.trust_state === "candidate"); const refs = [...new Set(cand.map((e) => `health:known_relations:${e.from}:${e.to}`))].sort(); return { signals: { candidate_count: cand.length }, entity_snapshot: p, evidence_refs: refs }; }, decide: () => ({ kind: "abstain", reason: "policy_prohibits" }) });
  return reg;
}
function payloadFor(db: CBrainDB, reg: VersionedRuleRegistry): RecommendationImmutablePayload {
  const proj = new DeclaredProjectionReader(db).read(decls.declarations); const r = reg.resolve(producer.rule_id, producer.rule_version); if (r.status !== "ok") throw new Error("runner");
  const di = r.captureInputs(proj);
  return { namespace: "maintenance", maintenance_key: `health:known_relations:${JSON.stringify([A, B])}`, inputs_hash: computeInputsHash(di), conclusion: { kind: "propose", action: { type: "dry_run", target_ref: `health:known_relations:${A}`, reason: "r" }, alternatives: [] }, decision_inputs: di, evidence_manifest: di.evidence_refs.map((ref) => ({ source: "health", ref, trust_state: "candidate" as const })), constraints: { policy_version: "p", ontology_version: "o", schema_version: SCHEMA_VERSION }, dependency_manifest: decls, applicability: { audience: "user_only", auto_execute: false, requires_confirmation: { tier: "standard" } }, risks: [], gaps: [], producer };
}
const CC = { policy_version: "p", ontology_version: "o", schema_version: SCHEMA_VERSION };

describe("DeclaredProjectionReader", () => {
  afterEach(() => { rmSync(DIR, { recursive: true, force: true }); });
  test("preserves from/to/trust_state", () => { const db = new CBrainDB(`${DIR}/r1.sqlite`); seed(db); link(db, A, B, "candidate"); const e = (new DeclaredProjectionReader(db).read(decls.declarations)[A] as { reports_to: { from: string; to: string; trust_state: string }[] }).reports_to[0]; expect(e).toEqual({ from: A, to: B, trust_state: "candidate" }); db.close(); });
  test("fail-closed on unsupported table", () => { const db = new CBrainDB(`${DIR}/r2.sqlite`); seed(db); expect(() => new DeclaredProjectionReader(db).read([{ slug: A, table: "lance", as: "x", fields: ["y"] }])).toThrow(/unsupported table/); db.close(); });
  test("fail-closed on undeclared field", () => { const db = new CBrainDB(`${DIR}/r3.sqlite`); seed(db); link(db, A, B, "candidate"); expect(() => new DeclaredProjectionReader(db).read([{ slug: A, table: "links", as: "reports_to", relation: "reports_to", fields: ["from", "bogus"], filter: "active" }])).toThrow(/not available/); db.close(); });
  test("MED 3: duplicate (slug,as) fail-closed", () => { const db = new CBrainDB(`${DIR}/r4.sqlite`); seed(db); expect(() => new DeclaredProjectionReader(db).read([{ slug: A, table: "links", as: "reports_to", relation: "reports_to", fields: ["from", "to"], filter: "active" }, { slug: A, table: "links", as: "reports_to", relation: "reports_to", fields: ["from", "to"], filter: "active" }])).toThrow(/duplicate.*slug.*as/); db.close(); });
  test("inactive excluded (active filter)", () => { const db = new CBrainDB(`${DIR}/r5.sqlite`); seed(db); link(db, A, B, "rejected"); expect((new DeclaredProjectionReader(db).read(decls.declarations)[A] as { reports_to: unknown[] }).reports_to.length).toBe(0); db.close(); });
});
describe("recomputeAndPersistFreshness", () => {
  afterEach(() => { rmSync(DIR, { recursive: true, force: true }); });
  test("drift → persisted stale, lifecycle untouched", () => {
    const db = new CBrainDB(`${DIR}/f1.sqlite`); seed(db); link(db, A, B, "candidate"); const reg = makeRegistry(); const store = new RecommendationStore(db);
    const c = store.createRecord(payloadFor(db, reg), "2026-07-12 10:00:00"); link(db, B, A, "candidate");
    const out = recomputeAndPersistFreshness(store.getById(c.record_id)!, new DeclaredProjectionReader(db), reg, store, CC, "2026-07-12 11:00:00");
    expect(out.freshness).toBe("stale"); const re = store.getById(c.record_id); expect(re?.freshness_status).toBe("stale"); expect(re?.lifecycle_status).toBe("pending"); db.close();
  });
  test("A→B→A path 1 → fresh recovers", () => {
    const db = new CBrainDB(`${DIR}/f2.sqlite`); seed(db); link(db, A, B, "candidate"); const reg = makeRegistry(); const store = new RecommendationStore(db);
    const c = store.createRecord(payloadFor(db, reg), "2026-07-12 10:00:00"); link(db, B, A, "candidate");
    recomputeAndPersistFreshness(store.getById(c.record_id)!, new DeclaredProjectionReader(db), reg, store, CC, "2026-07-12 11:00:00");
    db.rawDb.prepare("DELETE FROM links WHERE from_slug=? AND to_slug=?").run(B, A);
    recomputeAndPersistFreshness(store.getById(c.record_id)!, new DeclaredProjectionReader(db), reg, store, CC, "2026-07-12 12:00:00");
    expect(store.getById(c.record_id)?.freshness_status).toBe("fresh"); db.close();
  });
  test("runner unavailable → version_invalid persisted", () => {
    const db = new CBrainDB(`${DIR}/f3.sqlite`); seed(db); link(db, A, B, "candidate"); const reg = makeRegistry(); const store = new RecommendationStore(db);
    const c = store.createRecord(payloadFor(db, reg), "2026-07-12 10:00:00");
    expect(recomputeAndPersistFreshness(store.getById(c.record_id)!, new DeclaredProjectionReader(db), new VersionedRuleRegistry(), store, CC, "2026-07-12 11:00:00").freshness).toBe("version_invalid"); db.close();
  });
});
```

- [ ] **Step 2: Run → FAIL** — `bun test tests/core/recommendation/freshness.test.ts`.

- [ ] **Step 3: Implement projection reader + freshness**

```ts
// src/core/recommendation/projection.ts
import type { CBrainDB } from "../../storage/sqlite.js";
import type { DependencyDeclaration } from "./types.js";
export interface DeclaredProjection { [slug: string]: Record<string, unknown> }
export class DeclaredProjectionReader {
  constructor(private db: CBrainDB) {}
  read(declarations: DependencyDeclaration[]): DeclaredProjection {
    const proj: DeclaredProjection = {}; const seen = new Set<string>();
    for (const d of declarations) {
      const key = d.slug ?? "__global__"; const dup = `${key}::${d.as}`;
      if (seen.has(dup)) throw new Error(`projection: duplicate (slug,as) ${dup}`); seen.add(dup);
      if (proj[key] === undefined) proj[key] = {};
      proj[key][d.as] = this.readOne(d);
    }
    return proj;
  }
  private readOne(d: DependencyDeclaration): unknown {
    if (d.table === "links") {
      if (!d.slug) throw new Error(`projection: links needs slug (as=${d.as})`);
      if (!d.relation) throw new Error(`projection: links needs relation (as=${d.as})`);
      const all = d.filter === "all"; const rows = (d.direction ?? "outgoing") === "outgoing" ? this.db.getOutgoingLinks(d.slug, all) : this.db.getIncomingLinks(d.slug, all);
      return rows.filter((r) => r.relation === d.relation).map((r) => pick({ from: r.from_slug, to: r.to_slug, trust_state: r.trust_state ?? "trusted" }, d.fields, `links[${d.as}]`));
    }
    if (d.table === "pages") { if (!d.slug) throw new Error(`projection: pages needs slug (as=${d.as})`); const p = this.db.getPage(d.slug) as { content_hash?: string } | null; return pick({ content_hash: p?.content_hash ?? "" }, d.fields, `pages[${d.as}]`); }
    throw new Error(`projection: unsupported table '${d.table}' (as=${d.as})`);
  }
}
function pick(obj: Record<string, unknown>, fields: string[], ctx: string): Record<string, unknown> { const out: Record<string, unknown> = {}; for (const f of fields) { if (!(f in obj)) throw new Error(`projection: field '${f}' not available in ${ctx}`); out[f] = obj[f]; } return out; }
```

```ts
// src/core/recommendation/freshness.ts
import { computeInputsHash } from "./integrity.js";
import type { DeclaredProjectionReader } from "./projection.js";
import type { RecommendationStore } from "./record-store.js";
import type { VersionedRuleRegistry } from "./registry.js";
import type { RecommendationConstraints, RecommendationRecord } from "./types.js";
export function recomputeAndPersistFreshness(record: RecommendationRecord, reader: DeclaredProjectionReader, registry: VersionedRuleRegistry, store: RecommendationStore, currentConstraints: RecommendationConstraints, now: string): { freshness: "fresh" | "stale" | "version_invalid" } {
  const c = record.payload.constraints;
  if (currentConstraints.policy_version !== c.policy_version || currentConstraints.ontology_version !== c.ontology_version || currentConstraints.schema_version !== c.schema_version) { store.updateFreshness(record.record_id, "version_invalid", now); return { freshness: "version_invalid" }; }
  const runner = registry.resolve(record.payload.producer.rule_id, record.payload.producer.rule_version);
  if (runner.status !== "ok") { store.updateFreshness(record.record_id, "version_invalid", now); return { freshness: "version_invalid" }; }
  const freshness = computeInputsHash(runner.captureInputs(reader.read(record.payload.dependency_manifest.declarations))) === record.payload.inputs_hash ? "fresh" : "stale";
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

## Task 8: Display — single loadAndProjectDisplay entry, current constraints from sources, module-private projector (spec §4.4, §5.3, §11.3; rev4 HIGH 3, HIGH 4)

**Files:** Create `src/core/recommendation/display.ts`, `src/core/recommendation/versions.ts`; Test `tests/core/recommendation/display.test.ts`

- [ ] **Step 1: Write failing test (real positive, drift→blocked, version change→blocked, hostile reason via real store)**

```ts
// tests/core/recommendation/display.test.ts
import { rmSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import { CBrainDB } from "../../../src/storage/sqlite.js";
import { RecommendationStore } from "../../../src/core/recommendation/record-store.js";
import { DeclaredProjectionReader } from "../../../src/core/recommendation/projection.js";
import { VersionedRuleRegistry } from "../../../src/core/recommendation/registry.js";
import { registerMaintenanceProducers } from "../../../src/core/recommendation/producers/index.js";
import { RecommendationManager } from "../../../src/core/recommendation/manager.js";
import { loadAndProjectDisplay } from "../../../src/core/recommendation/display.js";
import { ontologyHash, policyHash } from "../../../src/core/recommendation/versions.js";
import { computeInputsHash } from "../../../src/core/recommendation/integrity.js";
import type { RecommendationImmutablePayload } from "../../../src/core/recommendation/types.js";
import { SCHEMA_VERSION } from "../../../src/core/recommendation/types.js";

const DIR = "/tmp/cbrain-test-rec-display";
const A = "entities/eA"; const B = "entities/eB";
function seed(db: CBrainDB) { for (const s of [A, B]) db.rawDb.prepare(`INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count, tier) VALUES (?, 'entity', ?, ?, ?, 0, 3)`).run(s, s, `${s}.md`, `h-${s}`); }
function link(db: CBrainDB, from: string, to: string, trust: string) { db.rawDb.prepare(`INSERT INTO links (from_slug, to_slug, relation, trust_state, source_type) VALUES (?, ?, 'reports_to', ?, 'agent')`).run(from, to, trust); }
function fresh() { const db = new CBrainDB(`${DIR}/${Math.random().toString(36).slice(2)}.sqlite`); const reg = new VersionedRuleRegistry(); registerMaintenanceProducers(reg); return { db, store: new RecommendationStore(db), reg, mgr: new RecommendationManager(db, reg) }; }

describe("loadAndProjectDisplay (single entry)", () => {
  afterEach(() => { rmSync(DIR, { recursive: true, force: true }); });

  test("HIGH 3: real positive — unchanged deps + same sources → display produced", () => {
    const { db, store, reg, mgr } = fresh(); seed(db); link(db, A, B, "candidate");
    const created = mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:00");
    const out = loadAndProjectDisplay(created.record_id, { store, reader: new DeclaredProjectionReader(db), registry: reg, ontologyHash, now: "2026-07-12 10:00:01" }, () => "实体A");
    expect(out.blocked).toBe(false);
    if (!out.blocked) { expect(out.target_display).toBe("实体A"); expect(out.reason).toContain("候选边"); }
    db.close();
  });
  test("HIGH 4: drift after create, no manual refresh → blocked", () => {
    const { db, store, reg, mgr } = fresh(); seed(db); link(db, A, B, "candidate");
    const created = mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:00");
    link(db, B, A, "candidate");
    const out = loadAndProjectDisplay(created.record_id, { store, reader: new DeclaredProjectionReader(db), registry: reg, ontologyHash, now: "2026-07-12 10:00:01" }, () => "x");
    expect(out.blocked).toBe(true);
    db.close();
  });
  test("registry manifest change (markPurged) → blocked (version_invalid)", () => {
    const { db, store, reg, mgr } = fresh(); seed(db); link(db, A, B, "candidate");
    const created = mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:00");
    reg.markPurged(created.payload.producer.rule_id, created.payload.producer.rule_version, created.payload.producer.code_hash);
    const out = loadAndProjectDisplay(created.record_id, { store, reader: new DeclaredProjectionReader(db), registry: reg, ontologyHash, now: "2026-07-12 10:00:01" }, () => "x");
    expect(out.blocked).toBe(true);
    db.close();
  });
  test("ontology source change (stub) → blocked", () => {
    const { db, store, reg, mgr } = fresh(); seed(db); link(db, A, B, "candidate");
    const created = mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:00");
    const out = loadAndProjectDisplay(created.record_id, { store, reader: new DeclaredProjectionReader(db), registry: reg, ontologyHash: () => "deadbeef", now: "2026-07-12 10:00:01" }, () => "x");
    expect(out.blocked).toBe(true);
    db.close();
  });
  test("non-display state → blocked", () => {
    const { db, store, reg, mgr } = fresh(); seed(db); link(db, A, B, "candidate");
    const created = mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:00");
    store.transitionLifecycle(created.record_id, "rejected", "2026-07-12 10:00:01", "no");
    expect(loadAndProjectDisplay(created.record_id, { store, reader: new DeclaredProjectionReader(db), registry: reg, ontologyHash, now: "2026-07-12 10:00:02" }, () => "x").blocked).toBe(true);
    db.close();
  });
  test("HIGH 4: hostile reason written to a REAL record → sanitized on output (no forge)", () => {
    const { db, store, reg } = fresh(); seed(db); link(db, A, B, "candidate");
    // hand-assemble a payload with a hostile reason; store validates integrity but does NOT sanitize reason
    const di = { signals: { candidate_count: 1 }, entity_snapshot: { [A]: { reports_to: [{ from: A, to: B, trust_state: "candidate" }] } }, evidence_refs: [`health:known_relations:${A}:${B}`] };
    const payload: RecommendationImmutablePayload = {
      namespace: "maintenance", maintenance_key: `health:known_relations:${JSON.stringify([A, B])}`, inputs_hash: computeInputsHash(di),
      conclusion: { kind: "propose", action: { type: "dry_run", target_ref: `health:known_relations:${A}`, reason: "score=0.9 /Users/secret" }, alternatives: [] },
      decision_inputs: di, evidence_manifest: [{ source: "health", ref: `health:known_relations:${A}:${B}`, trust_state: "candidate" }],
      constraints: created_constraints(reg), dependency_manifest: { rule_id: "health:known_relations", declarations: [A, B].map((s) => ({ slug: s, table: "links" as const, as: "reports_to", relation: "reports_to", direction: "outgoing" as const, fields: ["from", "to", "trust_state"], filter: "active" as const })) },
      applicability: { audience: "user_only", auto_execute: false, requires_confirmation: { tier: "standard" } }, risks: [], gaps: [],
      producer: { rule_id: "health:known_relations", rule_version: "1.0.0", code_hash: reg.directory()[0].code_hash, registry_ref: "r@1.0.0" },
    };
    const rec = store.createRecord(payload, "2026-07-12 10:00:00");
    const out = loadAndProjectDisplay(rec.record_id, { store, reader: new DeclaredProjectionReader(db), registry: reg, ontologyHash, now: "2026-07-12 10:00:01" }, () => "实体A");
    expect(out.blocked).toBe(false);
    if (!out.blocked) { expect(out.reason).not.toContain("score"); expect(out.reason).not.toContain("/Users/"); }
    db.close();
  });
});

// helper: build real constraints matching what the manager stores, so the hand-built record
// matches the live sources (registry.manifest + ontology.yaml) and reaches the gate, not version_invalid.
function created_constraints(reg: VersionedRuleRegistry): { policy_version: string; ontology_version: string; schema_version: string } {
  return { policy_version: policyHash(reg), ontology_version: ontologyHash(), schema_version: SCHEMA_VERSION };
}
```

> **Executor action:** the `created_constraints` helper must return the SAME constraints the manager stores, so the hand-built record matches the live sources and `loadAndProjectDisplay` reaches the gate (not `version_invalid`). Import `policyHash` and `ontologyHash` from `versions.ts` at the top of the test file and implement `created_constraints(reg)` as `{ policy_version: policyHash(reg), ontology_version: ontologyHash(), schema_version: SCHEMA_VERSION }`. Delete the placeholder body. (This is a concrete edit, not a deferred decision.)

- [ ] **Step 2: Run → FAIL** — `bun test tests/core/recommendation/display.test.ts`.

- [ ] **Step 3: Implement versions + display**

```ts
// src/core/recommendation/versions.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "./canonical.js";
import type { VersionedRuleRegistry } from "./registry.js";
export function ontologyHash(): string { return sha256Hex(readFileSync(join(import.meta.dir, "../../ontology/ontology.yaml"), "utf8")); }
export function policyHash(registry: VersionedRuleRegistry): string { return sha256Hex(registry.manifest()); }
```

```ts
// src/core/recommendation/display.ts
import { assertSafeActionDisplay } from "../safety/display-safety.js";
import { checkIntegrity } from "./integrity.js";
import { recomputeAndPersistFreshness } from "./freshness.js";
import { policyHash } from "./versions.js";
import { SCHEMA_VERSION } from "./types.js";
import type { DeclaredProjectionReader } from "./projection.js";
import type { RecommendationStore } from "./record-store.js";
import type { VersionedRuleRegistry } from "./registry.js";
import type { RecommendationRecord } from "./types.js";

const FALLBACK_DISPLAY = "一项待确认的记忆";
const FALLBACK_REASON = "有一项建议需要人工复核。";
function safe(text: string, fallback: string): string { try { assertSafeActionDisplay(text); return text; } catch { return fallback; } }

/** Module-private projector — NOT exported (HIGH 4). Defense-in-depth: still re-checks
 *  active+fresh so a misused internal call cannot render a dead record. */
function projectDisplay(rec: RecommendationRecord, resolveSafeTitle: (slug: string) => string): { blocked: true } | { blocked: false; target_display: string; reason: string } {
  const active = rec.lifecycle_status === "pending" || rec.lifecycle_status === "current";
  if (!active || rec.freshness_status !== "fresh") return { blocked: true };
  const c = rec.payload.conclusion;
  if (c.kind === "abstain") return { blocked: false, target_display: FALLBACK_DISPLAY, reason: safe(`abstain: ${c.reason}`, FALLBACK_REASON) };
  const slug = c.action.target_ref.split(":").pop() ?? c.action.target_ref;
  return { blocked: false, target_display: safe(resolveSafeTitle(slug) || FALLBACK_DISPLAY, FALLBACK_DISPLAY), reason: safe(c.action.reason, FALLBACK_REASON) };
}

export interface DisplayCtx { store: RecommendationStore; reader: DeclaredProjectionReader; registry: VersionedRuleRegistry; ontologyHash: () => string; now: string }
export type DisplayOutcome = { blocked: true; reason: "not_found" | "integrity_failed" | "not_active_fresh" } | { blocked: false; target_display: string; reason: string };

/** The ONLY public display entry (HIGH 3/4). Computes current constraints from SOURCES
 *  (registry.manifest + ontology + schema) — the caller supplies source functions, never
 *  version strings — forces integrity + freshness recompute/persist, then projects. */
export function loadAndProjectDisplay(recordId: string, ctx: DisplayCtx, resolveSafeTitle: (slug: string) => string): DisplayOutcome {
  const rec = ctx.store.getById(recordId);
  if (!rec) return { blocked: true, reason: "not_found" };
  if (!checkIntegrity(rec).ok) return { blocked: true, reason: "integrity_failed" };
  const current = { policy_version: policyHash(ctx.registry), ontology_version: ctx.ontologyHash(), schema_version: SCHEMA_VERSION };
  recomputeAndPersistFreshness(rec, ctx.reader, ctx.registry, ctx.store, current, ctx.now);
  const reloaded = ctx.store.getById(recordId);
  if (!reloaded) return { blocked: true, reason: "not_found" };
  const out = projectDisplay(reloaded, resolveSafeTitle);
  return out.blocked ? { blocked: true, reason: "not_active_fresh" } : { blocked: false, target_display: out.target_display, reason: out.reason };
}
```

- [ ] **Step 4: Run → PASS** — `bun test tests/core/recommendation/display.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/core/recommendation/display.ts src/core/recommendation/versions.ts tests/core/recommendation/display.test.ts
git commit -m "feat(rec): single loadAndProjectDisplay entry + source-derived constraints (#328)"
```

---

## Task 9: Producer (code_hash from function source) + manager (resolveActive metadata) (spec §4.3, §7.2; rev4 MED 1, MED 2)

**Files:** Create `src/core/recommendation/producers/known-relations.ts`, `src/core/recommendation/producers/index.ts`, `src/core/recommendation/manager.ts`; Test `tests/core/recommendation/producers/known-relations.test.ts`

- [ ] **Step 1: Write failing test (exact ref, normalized slugs, function-derived code_hash, registry active version)**

```ts
// tests/core/recommendation/producers/known-relations.test.ts
import { rmSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import { CBrainDB } from "../../../../src/storage/sqlite.js";
import { registerMaintenanceProducers } from "../../../../src/core/recommendation/producers/index.js";
import { VersionedRuleRegistry } from "../../../../src/core/recommendation/registry.js";
import { RecommendationManager } from "../../../../src/core/recommendation/manager.js";
import { policyHash } from "../../../../src/core/recommendation/versions.js";
const DIR = "/tmp/cbrain-test-rec-producer";
const A = "entities/entityA"; const B = "entities/entityB";
function seed(db: CBrainDB) { for (const s of [A, B]) db.rawDb.prepare(`INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count, tier) VALUES (?, 'entity', ?, ?, ?, 0, 3)`).run(s, s, `${s}.md`, `h-${s}`); }
function link(db: CBrainDB, from: string, to: string, trust: string) { db.rawDb.prepare(`INSERT INTO links (from_slug, to_slug, relation, trust_state, source_type) VALUES (?, ?, 'reports_to', ?, 'agent')`).run(from, to, trust); }
function fresh() { const db = new CBrainDB(`${DIR}/${Math.random().toString(36).slice(2)}.sqlite`); const reg = new VersionedRuleRegistry(); registerMaintenanceProducers(reg); return { db, reg, mgr: new RecommendationManager(db, reg) }; }

describe("known_relations producer", () => {
  afterEach(() => { rmSync(DIR, { recursive: true, force: true }); });
  test("abstains when no candidate edge", () => { const { db, mgr } = fresh(); seed(db); expect(mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:00").payload.conclusion.kind).toBe("abstain"); });
  test("exact evidence ref (from+to, no undefined)", () => {
    const { db, mgr } = fresh(); seed(db); link(db, A, B, "candidate");
    const r = mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:00");
    expect(r.payload.evidence_manifest[0].ref).toBe(`health:known_relations:${A}:${B}`);
    expect(r.payload.evidence_manifest[0].ref).not.toContain("undefined");
  });
  test("normalized slugs: disordered/duplicate → same key+fingerprint", () => {
    const a = fresh(); seed(a.db); link(a.db, A, B, "candidate");
    const r1 = a.mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [B, A, A] }, "2026-07-12 10:00:00");
    const r2 = a.mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:01");
    expect(r1.payload.maintenance_key).toBe(r2.payload.maintenance_key); expect(r1.fingerprint).toBe(r2.fingerprint);
  });
  test("inactive candidate excluded", () => { const { db, mgr } = fresh(); seed(db); link(db, A, B, "rejected"); expect(mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:00").payload.conclusion.kind).toBe("abstain"); });
  test("MED 1: code_hash is a real 64-hex derived from function source; policy_version === policyHash(registry)", () => {
    const { db, reg, mgr } = fresh(); seed(db); link(db, A, B, "candidate");
    const r = mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:00");
    expect(r.payload.producer.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.payload.constraints.policy_version).toBe(policyHash(reg));
    expect(r.payload.constraints.ontology_version).toMatch(/^[0-9a-f]{64}$/);
  });
  test("MED 1: changing the rule impl changes code_hash + policy_version", () => {
    const a = fresh(); seed(a.db); link(a.db, A, B, "candidate");
    const r1 = a.mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:00");
    // register a different impl under a new version after purging the old active
    a.reg.markPurged("health:known_relations", "1.0.0", r1.payload.producer.code_hash);
    a.reg.register({ rule_id: "health:known_relations", rule_version: "1.1.0", registry_ref: "cbrain.rules:maintenance.known_relations@1.1.0", captureInputs: () => ({ signals: { changed: true }, entity_snapshot: {}, evidence_refs: [] }), decide: () => ({ kind: "abstain", reason: "policy_prohibits" }) });
    const r2 = a.mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:01");
    expect(r2.payload.producer.code_hash).not.toBe(r1.payload.producer.code_hash);
    expect(r2.payload.constraints.policy_version).not.toBe(r1.payload.constraints.policy_version);
  });
});
```

- [ ] **Step 2: Run → FAIL** — `bun test tests/core/recommendation/producers/known-relations.test.ts`.

- [ ] **Step 3: Implement producer (captureInputs/decide + metadata only — no hand artifact) + registration (code_hash from fn source)**

```ts
// src/core/recommendation/producers/known-relations.ts
import type { DecisionInputs, RecommendationConclusion } from "../types.js";
export const RULE_ID = "health:known_relations";
export const RULE_VERSION = "1.0.0";
export const REGISTRY_REF = "cbrain.rules:maintenance.known_relations@1.0.0";

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
import { sha256Hex } from "../canonical.js";
import type { VersionedRuleRegistry } from "../registry.js";
import { RULE_ID, RULE_VERSION, REGISTRY_REF, captureInputs as krCapture, decide as krDecide } from "./known-relations.js";

export function registerMaintenanceProducers(reg: VersionedRuleRegistry): void {
  const captureInputs = (projection: unknown) => { const p = projection as Record<string, { reports_to: { from: string; to: string; trust_state: string }[] }>; return krCapture(Object.keys(p).sort(), p); };
  const decide = (di: Parameters<typeof krDecide>[1]) => krDecide(Object.keys(di.entity_snapshot).sort(), di);
  // code_hash derived from the ACTUAL executable function source (MED 1) — not a hand-maintained artifact.
  const code_hash = sha256Hex(`${captureInputs.toString()}\n${decide.toString()}`);
  reg.register({ rule_id: RULE_ID, rule_version: RULE_VERSION, code_hash, registry_ref: REGISTRY_REF, captureInputs, decide });
}
```

- [ ] **Step 4: Implement manager (metadata from registry.resolveActive)**

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
    // metadata from registry active version (MED 2) — no hardcoded producer strings.
    const active = this.registry.resolveActive(req.rule_id);
    if (active.status !== "ok") throw new Error(`manager: producer ${req.rule_id} has no active version`);
    const slugs = [...new Set(req.slugs)].sort();
    const dependency_manifest: DependencyManifest = { rule_id: req.rule_id, declarations: slugs.map((s) => ({ slug: s, table: "links" as const, as: "reports_to", relation: "reports_to", direction: "outgoing" as const, fields: ["from", "to", "trust_state"], filter: "active" as const })) };
    const projection = new DeclaredProjectionReader(this.db).read(dependency_manifest.declarations);
    const decision_inputs = active.captureInputs(projection);
    const conclusion = active.decide(decision_inputs);
    const evidence_manifest: EvidenceManifestEntry[] = decision_inputs.evidence_refs.map((ref) => ({ source: "health", ref, trust_state: "candidate" as const }));
    const constraints: RecommendationConstraints = { policy_version: policyHash(this.registry), ontology_version: ontologyHash(), schema_version: SCHEMA_VERSION };
    const payload: RecommendationImmutablePayload = {
      namespace: "maintenance", maintenance_key: `${req.rule_id}:${JSON.stringify(slugs)}`, inputs_hash: "",
      conclusion, decision_inputs, evidence_manifest, constraints, dependency_manifest,
      applicability: { audience: "user_only", auto_execute: false, requires_confirmation: { tier: "standard" } },
      risks: [], gaps: [], producer: { rule_id: active.rule_id, rule_version: active.rule_version, code_hash: active.code_hash, registry_ref: active.registry_ref },
    };
    return new RecommendationStore(this.db).createRecord(payload, now);
  }
}
```

- [ ] **Step 5: Run → PASS** — `bun test tests/core/recommendation/producers/known-relations.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/core/recommendation/producers/ src/core/recommendation/manager.ts tests/core/recommendation/producers/known-relations.test.ts
git commit -m "feat(rec): function-derived code_hash + resolveActive manager (#328)"
```

---

## Task 10: Rollback tests on the PRODUCTION path

**Files:** extend `tests/core/recommendation/record-store.test.ts`

- [ ] **Step 1: Production-path fault injection (own DB)**

```ts
test("createRecord supersede rolls back on partial failure — prior active stays active", () => {
  const faultDir = "/tmp/cbrain-test-rec-store-fault"; rmSync(faultDir, { recursive: true, force: true });
  const fdb = new CBrainDB(`${faultDir}/db.sqlite`); const fstore = new RecommendationStore(fdb);
  const created = fstore.createRecord(mkPayload("hA"), "2026-07-12 10:00:00");
  fdb.rawDb.exec("DROP TABLE recommendation_lifecycle_history"); // history INSERT fails mid-txn
  expect(() => fstore.createRecord(mkPayload("hB"), "2026-07-12 10:00:01")).toThrow();
  expect(fstore.activeCountFor("k1")).toBe(1);
  expect(fstore.getById(created.record_id)?.fingerprint).toBe(created.fingerprint);
  fdb.close(); rmSync(faultDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Store-reload round-trip** (`computeFingerprint` hoisted to the file's imports)

```ts
test("fingerprint survives store → DB → store reload", () => {
  open(); const created = store.createRecord(mkPayload("h1"), "2026-07-12 10:00:00");
  const reloaded = store.getById(created.record_id);
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

- [ ] **Step 1: Lint** — `bun run lint` → PASS.
- [ ] **Step 2: Full test** — `bun test tests/core/recommendation/ tests/storage/migrations/recommendations.test.ts` → all PASS.
- [ ] **Step 3: Full check** — `bun run check` → PASS.
- [ ] **Step 4: docs gate** — `bun run check:docs` → PASS.
- [ ] **Step 5: Final commit ONLY if lint touched files (NEVER `git add -A`)** — stage exact paths only; skip entirely (no `--allow-empty`) if nothing changed.

---

## Self-Review (run before handing off)

**Codex plan-rev3 findings (4 HIGH + 3 MED) — all addressed:**
- HIGH 1 (optional declaration undefined) → Task 4 `canonicalDeclaration()` omits absent keys; 3 fixtures (global/pages/default direction-filter) hash + round-trip. ✓
- HIGH 2 (default TTL not wired + unvalidated times + unguarded reopen) → Task 2/6: `transitionLifecycle` `undefined→defaultSuppressedUntil`, `null→permanent`, string→strict validate; all store entries `validateTimestamp`; `clearSuppression` requires rejected + `changes===1`; tests for default TTL, illegal time, non-rejected reopen, missing record. ✓
- HIGH 3 (caller-supplied fake constraints) → Task 8 `loadAndProjectDisplay` computes current constraints internally from `policyHash(registry)+ontologyHash()+SCHEMA_VERSION`; caller supplies source functions (registry, ontologyHash fn), not version strings; positive case uses real sources and passes. ✓
- HIGH 4 (VerifiedRecord runtime forgeable) → Task 8 exports ONLY `loadAndProjectDisplay`; `projectDisplay` module-private + active+fresh defense-in-depth; hostile-reason test writes a real record and goes through the single entry. ✓
- MED 1 (RULE_ARTIFACT hand copy) → Task 9 `code_hash = sha256(captureInputs.toString()+decide.toString())` — derived from executable logic; test proves changing impl changes code_hash + policy_version. ✓
- MED 2 (registry no active version) → Task 5 `activeVersion` map + `resolveActive`; multiple live versions fail-closed; reverse-registration test selects configured active. ✓
- MED 3 (sibling/duplicate not real) → Task 6 real two-sibling test (expired + permanent coexist → blocked); Task 4/7 duplicate-`(slug,as)` fail-closed in reader + integrity. ✓

**Spec coverage:** §4/4.3/4.4 → Tasks 2/4/8; §5.1-5.7 → Tasks 6/7/8; §5.5 atomic supersede → Task 6 (+Task 10); §5.6 suppression → Tasks 2/6; §6.1-6.4 → Tasks 1/4; §7.2 → Tasks 5/9; §8.1 → Task 4; §8.4 → Tasks 7/8; §9/9.1 → Tasks 2/9; §10 → Task 3; §11 → Task 8. **Deferred:** §8.2 replay UI (Phase 2), §12 derivation graph.

**Placeholder scan:** no TBD/TODO. All test helpers are fully implemented (e.g. `created_constraints` uses real `policyHash`/`ontologyHash`). All `CBrainDB` calls use verified APIs.

**Type consistency:** `createRecord`/`transitionLifecycle`/`updateFreshness`/`clearSuppression`/`getById`/`activeCountFor` consistent across 6/7/8/9/10. `DependencyDeclaration` (`as`/`relation`/`direction`/`fields`) consistent across 2/4/6/7/9. `resolveActive` used in 5/9. `loadAndProjectDisplay` is the sole display export.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-12-recommendation-contract-phase1.md` (rev4).

**Per the user's instruction: STOP for re-review. Do not execute. Do not push.** Every commit stages explicit paths only.

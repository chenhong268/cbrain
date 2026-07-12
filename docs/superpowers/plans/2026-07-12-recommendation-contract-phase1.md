# Recommendation Contract — Phase 1 Infrastructure Implementation Plan (rev5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the deterministic Recommendation Record **contract infrastructure** for Phase 1 from `docs/superpowers/specs/2026-07-12-recommendation-contract-design.md` (rev6), plus one reference producer (`health:known_relations`) as the vertical slice.

**Architecture:** `src/core/recommendation/`. Additive migration (DDL + completion marker in ONE transaction; test fault hook proves rollback). Deterministic producers, never auto-execute. Immutable payload hashed per RFC 8785 JCS + prose/identifier layer. Two orthogonal persisted axes (`lifecycle_status` / `freshness_status`), each its OWN store API; terminals cannot regress. Atomic supersede keeps `active count ≤ 1`; rejected suppression via `EXISTS(... IS NULL OR > now)` with default TTL wired in; **all timestamps semantically validated** (parse + UTC round-trip). Store is the single persistence entry. **Rules are typed declarative `RuleDefinition`s** executed by a generic runner; `code_hash = sha256(canonical(definition))` — the definition is the single source of both behavior and identity (no wrapper `toString`). The registry holds **multiple immutable live runners per rule_id coexisting** (old versions stay exact-resolvable for replay); an explicit `setActive` switches the active version and enters policy identity. Display has exactly one public entry — `loadAndProjectDisplay(recordId, {store, reader, registry, now})` — which uses the module-internal production ontology hash (no caller-injectable version source), forces integrity + freshness recompute (which **verifies the resolved runner's code_hash/registry_ref match the record's producer metadata**), gates on active+fresh, and projects through the safety boundary. `projectDisplay` is module-private.

**Tech Stack:** Bun, TypeScript strict, `bun:sqlite`, `bun:test`, `node:crypto`. No new runtime deps.

**rev5 changelog:** closes Codex plan-rev4 findings — (H1) single `validateDependencyDeclarations()` called in `canonicalPayload`/`checkIntegrity`/reader, so `computeFingerprint` itself throws on duplicate `(slug,as)`; 3-entry RED coverage. (H2) registry allows multiple live runners per rule_id; `register` no longer grabs/purges active; new `setActive(ruleId,version)` (target must be live); `manifest()` encodes the active mapping so switching active changes policy identity; `markPurged` refuses the active version; old versions remain exact-resolvable. (H3) rules are typed declarative `RuleDefinition` + generic `runRule`; `code_hash = sha256(canonical(def))` — derived from the definition (data), not wrapper `toString`; upgrade fixture uses the same factory producing complete metadata. (H4) `loadAndProjectDisplay` takes NO ontology parameter (uses module-internal production `ontologyHash()`); ontology test injection via a non-exported `__setDisplayOntologySourceForTest` seam only; freshness requires the resolved runner's `code_hash`+`registry_ref` to match the record's producer metadata, else `version_invalid`. (M1) `validateTimestamp` does parse + UTC round-trip (rejects impossible dates). (M2) removed stale executor notes / duplicate headings; every test closes its DB.

---

## Scope (read first)

Phase 1 contract infrastructure + one reference producer (`health:known_relations`). Out of scope (follow-up plan): fsck/discovery/action-candidate producers; MCP tool surface (#327-gated); replay/diff UI (Phase 2); derivation graph (§12).

**Non-goals (hard, spec §0):** no LLM at runtime; no auto-execution; no writing recommendations as trusted facts; no model CoT storage; no MCP/default-display changes.

**History note:** Local `main` and `origin/main` diverged via equivalent #329 commits. **Do NOT push.**

**Staging rule (HARD):** every commit stages **explicit paths only**. Never `git add -A` / `git add .`.

**Time contract:** timestamps are SQLite-UTC `YYYY-MM-DD HH:MM:SS`, semantically validated (parse + UTC round-trip). Lexicographic compare is correct for this format.

---

## File Structure

**Create (source):**
- `src/core/recommendation/canonical.ts` — `assertJsonSafe`, `canonicalJson`, `sha256Hex`, `normalizeProse`.
- `src/core/recommendation/types.ts` — types + `DependencyDeclaration` + `RuleDefinition`.
- `src/core/recommendation/policy.ts` — `validateTimestamp` (semantic), `defaultSuppressedUntil`, `DEFAULT_SUPPRESSION_TTL_SECONDS`, `SUPPRESSION_REOPENED`.
- `src/core/recommendation/integrity.ts` — `validateDependencyDeclarations` (shared), `computeInputsHash`, `computeFingerprint`, `checkIntegrity`.
- `src/core/recommendation/registry.ts` — `VersionedRuleRegistry` (multi-live, `setActive`, active-aware manifest), `RuleRunner`.
- `src/core/recommendation/rule-runtime.ts` — `runRule(def)` generic runner + `definitionCodeHash(def)`.
- `src/core/recommendation/projection.ts` — `DeclaredProjectionReader` (strict, fail-closed, duplicate-`(slug,as)` guarded).
- `src/core/recommendation/freshness.ts` — `recomputeAndPersistFreshness` (verifies exact runner metadata).
- `src/core/recommendation/record-store.ts` — `RecommendationStore` (single entry, split APIs, EXISTS suppression, guarded reopen, time validation).
- `src/core/recommendation/versions.ts` — `ontologyHash`, `policyHash(registry)`.
- `src/core/recommendation/display.ts` — single exported `loadAndProjectDisplay`; module-private `projectDisplay`; module-level ontology source + test seam.
- `src/core/recommendation/manager.ts` — `RecommendationManager.buildAndStore` (metadata from `resolveActive`).
- `src/core/recommendation/producers/known-relations.ts` — exports `KNOWN_RELATIONS_DEF: RuleDefinition` (declarative, single source).
- `src/core/recommendation/producers/index.ts` — `registerMaintenanceProducers` (runRule + register + setActive).
- `src/storage/migrations/recommendations.ts` — additive migration (+ test fault hook).

**Modify:** `src/storage/sqlite.ts` (call migration after `runLatePageMigrations` ≈ L420), `src/storage/migrations/index.ts` (export).

**Create (tests):** `tests/core/recommendation/*.test.ts` (`../../../src`), `tests/core/recommendation/producers/*.test.ts` (`../../../../src`), `tests/storage/migrations/recommendations.test.ts`.

---

## Task 1: Canonical pipeline — validator-first, fail-closed (spec §6.2)

> Unchanged (no finding). Kept verbatim.

**Files:** Create `src/core/recommendation/canonical.ts`; Test `tests/core/recommendation/canonical.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/core/recommendation/canonical.test.ts
import { describe, expect, test } from "bun:test";
import { assertJsonSafe, canonicalJson, sha256Hex, serializeNumber, normalizeProse } from "../../../src/core/recommendation/canonical.js";
describe("serializeNumber", () => { test("golden bytes", () => { expect(serializeNumber(1)).toBe("1"); expect(serializeNumber(1.0)).toBe("1"); expect(serializeNumber(-0)).toBe("0"); expect(serializeNumber(0.1)).toBe("0.1"); expect(serializeNumber(1e-7)).toBe("1e-7"); expect(serializeNumber(1e21)).toBe("1e+21"); }); test("non-finite fail-closed", () => { for (const n of [NaN, Infinity, -Infinity]) expect(() => serializeNumber(n)).toThrow(/finite/); }); });
describe("assertJsonSafe", () => { test("accepts plain JSON", () => { expect(() => assertJsonSafe({ a: 1, b: [null, "x", true] })).not.toThrow(); }); test("rejects undefined/function/symbol", () => { expect(() => assertJsonSafe({ x: undefined })).toThrow(/JSON-safe/); expect(() => assertJsonSafe({ x: () => 1 })).toThrow(/JSON-safe/); expect(() => assertJsonSafe({ x: Symbol("s") })).toThrow(/JSON-safe/); }); test("rejects Date/Map/Set/class", () => { expect(() => assertJsonSafe({ x: new Date() })).toThrow(/JSON-safe/); expect(() => assertJsonSafe({ x: new Map() })).toThrow(/JSON-safe/); expect(() => assertJsonSafe({ x: new Set() })).toThrow(/JSON-safe/); expect(() => assertJsonSafe({ x: new (class C {})() })).toThrow(/JSON-safe/); }); test("rejects cyclic object/array", () => { const o: Record<string, unknown> = {}; o.self = o; expect(() => assertJsonSafe(o)).toThrow(/cycle/); const a: unknown[] = []; a.push(a); expect(() => assertJsonSafe(a)).toThrow(/cycle/); }); test("rejects lone surrogate", () => { expect(() => assertJsonSafe({ x: "ab\uD800cd" })).toThrow(/surrogate/); }); });
describe("canonicalJson", () => { test("keys sorted", () => { expect(canonicalJson({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}'); }); test("array sorted by full element", () => { const a = { source: "link", ref: "x", trust_state: "trusted" }; const b = { source: "link", ref: "x", trust_state: "candidate" }; expect(canonicalJson({ m: [a, b] })).toBe(canonicalJson({ m: [b, a] })); }); test("absent optional omitted", () => { expect(canonicalJson({ type: "dry_run", target_ref: "r", reason: "x" })).not.toContain("rollback_note"); }); test("identifier byte-exact", () => { expect(canonicalJson({ ref: "entityA－1" })).not.toBe(canonicalJson({ ref: "entityA-1" })); }); });
describe("normalizeProse", () => { test("NFKC + fold", () => { expect(normalizeProse("ｓｃｏｒｅ   高")).toBe("score 高"); }); });
describe("sha256Hex", () => { test("64 hex", () => { expect(sha256Hex('{"a":1}')).toMatch(/^[0-9a-f]{64}$/); }); });
```

- [ ] **Step 2: Run → FAIL** — `bun test tests/core/recommendation/canonical.test.ts`.

- [ ] **Step 3: Implement**

```ts
// src/core/recommendation/canonical.ts
import { createHash } from "node:crypto";
export function serializeNumber(n: number): string { if (!Number.isFinite(n)) throw new Error(`canonical: number must be finite, got ${String(n)}`); return String(Object.is(n, -0) ? 0 : n); }
export function normalizeProse(s: string): string { return s.normalize("NFKC").replace(/\s+/g, " ").trim(); }
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|[\uDC00-\uDFFF](?<![\uD800-\uDBFF])/u;
export function assertJsonSafe(v: unknown, seen: Set<object> = new Set()): void {
  if (v === null || typeof v === "boolean") return;
  if (typeof v === "number") { serializeNumber(v); return; }
  if (typeof v === "string") { if (LONE.test(v)) throw new Error("canonical: lone surrogate"); return; }
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
function quote(s: string): string { let out = '"'; for (const ch of s) { const cp = ch.codePointAt(0)!; if (ch === "\\" || ch === '"') out += "\\" + ch; else if (ch === "\n") out += "\\n"; else if (ch === "\r") out += "\\r"; else if (ch === "\t") out += "\\t"; else if (ch === "\b") out += "\\b"; else if (ch === "\f") out += "\\f"; else if (cp < 0x20) out += "\\u" + cp.toString(16).padStart(4, "0"); else out += ch; } return out + '"'; }
export function sha256Hex(s: string): string { return createHash("sha256").update(s, "utf8").digest("hex"); }
```

- [ ] **Step 4: Run → PASS**.
- [ ] **Step 5: Commit**

```bash
git add src/core/recommendation/canonical.ts tests/core/recommendation/canonical.test.ts
git commit -m "feat(rec): fail-closed canonical JSON pipeline (#328)"
```

---

## Task 2: Types + policy (semantic time validation) (spec §4; rev5 MEDIUM 1)

**Files:** Create `src/core/recommendation/types.ts`, `src/core/recommendation/policy.ts`

- [ ] **Step 1: Types (incl. declarative RuleDefinition)**

```ts
// src/core/recommendation/types.ts
import type { TrustState } from "../provenance.js";
export type LifecycleStatus = "pending" | "current" | "superseded" | "rejected" | "invalidated";
export type FreshnessStatus = "fresh" | "stale" | "version_invalid";
export type AbstainReason = "insufficient_evidence" | "conflict" | "inactive_evidence_only" | "below_threshold" | "policy_prohibits";
export type HighImpactReason = "write_action" | "open_question_deep_reasoning" | "irreversible_real_world" | "high_value_entity";
export type ConfirmationRequirement = { tier: "standard" } | { tier: "high_impact"; confirm: ("target" | "option" | "constraint")[]; reason: HighImpactReason };
export type ActionType = "review" | "dry_run" | "notify_draft";
export interface ProposedAction { type: ActionType; target_ref: string; reason: string; rollback_note?: string }
export type RecommendationConclusion = { kind: "propose"; action: ProposedAction; alternatives: ProposedAction[] } | { kind: "abstain"; reason: AbstainReason };
export interface DependencyDeclaration { slug?: string; table: "links" | "pages" | "tags" | "aliases" | "timeline" | "chunks" | "fts" | "lance" | "config"; as: string; relation?: string; direction?: "outgoing" | "incoming"; fields: string[]; filter?: "active" | "all" }
export interface DependencyManifest { rule_id: string; declarations: DependencyDeclaration[] }
export interface EntityProjection { [as: string]: unknown }
export interface DecisionInputs { signals: Record<string, unknown>; inspected_claims?: string[]; entity_snapshot: Record<string, EntityProjection>; evidence_refs: string[] }
export interface EvidenceManifestEntry { source: "discovery" | "health" | "fsck" | "graph" | "timeline"; ref: string; trust_state: TrustState }
export interface RecommendationConstraints { policy_version: string; ontology_version: string; schema_version: string }
export interface Applicability { audience: "user_only"; auto_execute: false; requires_confirmation: ConfirmationRequirement }
export interface RecommendationProducer { rule_id: string; rule_version: string; code_hash: string; registry_ref: string }
export interface RecommendationImmutablePayload { namespace: string; maintenance_key: string; inputs_hash: string; conclusion: RecommendationConclusion; decision_inputs: DecisionInputs; evidence_manifest: EvidenceManifestEntry[]; constraints: RecommendationConstraints; dependency_manifest: DependencyManifest; applicability: Applicability; risks: string[]; gaps: string[]; producer: RecommendationProducer }
export interface RecommendationRecord { record_id: string; payload: RecommendationImmutablePayload; fingerprint: string; created_at: string; last_revalidated_at: string; lifecycle_status: LifecycleStatus; freshness_status: FreshnessStatus; suppressed_until: string | null }
export const SCHEMA_VERSION = "rec-v1" as const;

/** Declarative rule definition — the SINGLE source of a rule's behavior AND identity.
 *  code_hash = sha256(canonical(definition)). The generic runner interprets it. (rev5 HIGH 3) */
export interface RuleDefinition {
  rule_id: string; rule_version: string; registry_ref: string;
  /** Phase 1 rule kind: count active candidate edges of one relation across declared slugs. */
  candidateRelation: string;
  evidenceRefTemplate: string;   // e.g. "health:known_relations:{from}:{to}"
  abstainReason: AbstainReason;
  propose: { type: ActionType; targetTemplate: string; reason: string };
}
```

- [ ] **Step 2: Policy (semantic timestamp validator)**

```ts
// src/core/recommendation/policy.ts
export const DEFAULT_SUPPRESSION_TTL_SECONDS = 7 * 86400;
export const SUPPRESSION_REOPENED = "1970-01-01 00:00:00";
const TS = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

/** Semantic timestamp gate (rev5 MEDIUM 1): regex shape, field ranges, AND UTC round-trip
 *  so impossible dates (e.g. 2026-13-45, 2026-02-30, non-leap 02-29) are rejected. */
export function validateTimestamp(s: string, name: string): void {
  const m = TS.exec(s);
  if (!m) throw new Error(`policy: invalid ${name} format, got ${JSON.stringify(s)}`);
  const [, Y, Mo, D, H, Mi, S] = m;
  const y = +Y, mo = +Mo, d = +D, h = +H, mi = +Mi, sec = +S;
  if (mo < 1 || mo > 12) throw new Error(`policy: invalid ${name} month`);
  if (d < 1 || d > 31) throw new Error(`policy: invalid ${name} day`);
  if (h > 23 || mi > 59 || sec > 59) throw new Error(`policy: invalid ${name} time`);
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, sec));
  const back = `${dt.getUTCFullYear().toString().padStart(4, "0")}-${(dt.getUTCMonth() + 1).toString().padStart(2, "0")}-${dt.getUTCDate().toString().padStart(2, "0")} ${dt.getUTCHours().toString().padStart(2, "0")}:${dt.getUTCMinutes().toString().padStart(2, "0")}:${dt.getUTCSeconds().toString().padStart(2, "0")}`;
  if (back !== s) throw new Error(`policy: invalid ${name} date (round-trip mismatch)`);
}
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
git commit -m "feat(rec): types (RuleDefinition) + policy (semantic time validation) (#328)"
```

---

## Task 3: Additive migration — atomic, fault hook (spec §10)

**Files:** Create `src/storage/migrations/recommendations.ts`; modify `migrations/index.ts`, `sqlite.ts`; Test `tests/storage/migrations/recommendations.test.ts`

- [ ] **Step 1: Write failing test**

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
  test("ATOMIC: fault before marker rolls back ALL", () => { const db = newDb(); dbs.push(db); expect(() => runRecommendationRecordsMigration(db, { failBeforeMarker: true })).toThrow(/injected/); expect(exists(db, "recommendation_records")).toBe(false); expect(idx(db, "idx_rec_active_unique")).toBeUndefined(); expect((db.prepare("SELECT value FROM config WHERE key='migration_rec_v1_recommendation_records'").get() as { value?: string } | undefined)?.value).toBeUndefined(); expect(() => runRecommendationRecordsMigration(db)).not.toThrow(); expect(exists(db, "recommendation_records")).toBe(true); });
  test("forward repair", () => { const db = newDb(); dbs.push(db); runRecommendationRecordsMigration(db); db.exec("DROP TABLE recommendation_records"); db.exec("DELETE FROM config WHERE key='migration_rec_v1_recommendation_records'"); expect(() => runRecommendationRecordsMigration(db)).not.toThrow(); expect(exists(db, "recommendation_records")).toBe(true); });
});
```

- [ ] **Step 2: Run → FAIL**.
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

- [ ] **Step 4: Wire** — `migrations/index.ts`: add `export { runRecommendationRecordsMigration } from "./recommendations.js";`. `sqlite.ts`: import from `./migrations/index.js`; call `runRecommendationRecordsMigration(this.db);` after `runLatePageMigrations(this.db);` (≈ L420).
- [ ] **Step 5: Run → PASS**.
- [ ] **Step 6: Commit**

```bash
git add src/storage/migrations/recommendations.ts src/storage/migrations/index.ts src/storage/sqlite.ts tests/storage/migrations/recommendations.test.ts
git commit -m "feat(storage): recommendation_records additive migration (#328)"
```

---

## Task 4: Integrity — shared declaration validator + cross-consistency (spec §6, §4.3, §8.1; rev5 HIGH 1)

**Files:** Create `src/core/recommendation/integrity.ts`; Test `tests/core/recommendation/integrity.test.ts`

- [ ] **Step 1: Write failing test (canonicalDeclaration optionals + duplicate fails in fingerprint/integrity/reader + cross cases)**

```ts
// tests/core/recommendation/integrity.test.ts
import { describe, expect, test } from "bun:test";
import { canonicalDeclaration, validateDependencyDeclarations, computeInputsHash, computeFingerprint, checkIntegrity } from "../../../src/core/recommendation/integrity.js";
import type { DependencyDeclaration, RecommendationImmutablePayload, RecommendationRecord } from "../../../src/core/recommendation/types.js";
import { SCHEMA_VERSION } from "../../../src/core/recommendation/types.js";

describe("canonicalDeclaration omits absent optionals", () => {
  test("global declaration (no slug) hashes cleanly", () => { expect(() => computeFingerprint(payloadWith([{ table: "config", as: "flag", fields: ["value"] }]))).not.toThrow(); expect(JSON.stringify(canonicalDeclaration({ table: "config", as: "flag", fields: ["value"] }))).not.toContain('"slug"'); });
  test("pages declaration (no relation/direction/filter) hashes cleanly", () => { expect(() => computeFingerprint(payloadWith([{ slug: "a", table: "pages", as: "page", fields: ["content_hash"] }]))).not.toThrow(); const s = JSON.stringify(canonicalDeclaration({ slug: "a", table: "pages", as: "page", fields: ["content_hash"] })); expect(s).not.toContain('"relation"'); expect(s).not.toContain('"filter"'); });
  test("links default direction/filter round-trips", () => { const p = payloadWith([{ slug: "a", table: "links", as: "reports_to", relation: "reports_to", fields: ["from", "to"] }]); expect(() => computeFingerprint(p)).not.toThrow(); const fp = computeFingerprint(p); expect(computeFingerprint(JSON.parse(JSON.stringify(p)) as RecommendationImmutablePayload)).toBe(fp); });
});
describe("validateDependencyDeclarations (shared, HIGH 1)", () => {
  test("computeFingerprint throws on duplicate (slug,as)", () => { const p = payloadWith([{ slug: "a", table: "links", as: "reports_to", relation: "reports_to", fields: ["from", "to"] }, { slug: "a", table: "links", as: "reports_to", relation: "reports_to", fields: ["from", "to"] }]); expect(() => computeFingerprint(p)).toThrow(/duplicate.*slug.*as/); });
  test("checkIntegrity reports duplicate on store entry", () => { const p = basePayload(); p.dependency_manifest.declarations.push({ ...p.dependency_manifest.declarations[0] }); const r = rec(p); const x = checkIntegrity(r); expect(x.ok).toBe(false); if (!x.ok) expect(x.code).toBe("duplicate_declaration"); });
});
function payloadWith(declarations: DependencyDeclaration[]): RecommendationImmutablePayload {
  const di = { signals: {}, entity_snapshot: {}, evidence_refs: [] as string[] };
  return { namespace: "maintenance", maintenance_key: "k", inputs_hash: "", conclusion: { kind: "abstain", reason: "insufficient_evidence" }, decision_inputs: di, evidence_manifest: [], constraints: { policy_version: "p", ontology_version: "o", schema_version: SCHEMA_VERSION }, dependency_manifest: { rule_id: "r", declarations }, applicability: { audience: "user_only", auto_execute: false, requires_confirmation: { tier: "standard" } }, risks: [], gaps: [], producer: { rule_id: "r", rule_version: "1", code_hash: "h", registry_ref: "r@1" } };
}
function basePayload(): RecommendationImmutablePayload {
  const di = { signals: { candidate_count: 1 }, entity_snapshot: { eA: { reports_to: [{ from: "eA", to: "eB", trust_state: "candidate" }] } }, evidence_refs: ["health:k:eA:eB"] };
  return { namespace: "maintenance", maintenance_key: "k", inputs_hash: "", conclusion: { kind: "propose", action: { type: "dry_run", target_ref: "health:k:eA", reason: "r" }, alternatives: [] }, decision_inputs: di, evidence_manifest: [{ source: "health", ref: "health:k:eA:eB", trust_state: "candidate" }], constraints: { policy_version: "p", ontology_version: "o", schema_version: SCHEMA_VERSION }, dependency_manifest: { rule_id: "r", declarations: [{ slug: "eA", table: "links", as: "reports_to", relation: "reports_to", direction: "outgoing", fields: ["from", "to", "trust_state"], filter: "active" }] }, applicability: { audience: "user_only", auto_execute: false, requires_confirmation: { tier: "standard" } }, risks: [], gaps: [], producer: { rule_id: "r", rule_version: "1", code_hash: "h", registry_ref: "r@1" } };
}
function rec(p: RecommendationImmutablePayload): RecommendationRecord { p.inputs_hash = computeInputsHash(p.decision_inputs); return { record_id: "r1", payload: p, fingerprint: computeFingerprint(p), created_at: "2026-07-12 10:00:00", last_revalidated_at: "2026-07-12 10:00:00", lifecycle_status: "pending", freshness_status: "fresh", suppressed_until: null }; }
describe("checkIntegrity", () => {
  test("clean passes", () => { expect(checkIntegrity(rec(basePayload())).ok).toBe(true); });
  test("inputs_hash tamper", () => { const r = rec(basePayload()); r.payload.inputs_hash = "x"; const x = checkIntegrity(r); expect(x.ok).toBe(false); if (!x.ok) expect(x.code).toBe("inputs_hash_mismatch"); });
  test("fingerprint tamper — fixed code, no ref echo", () => { const r = rec(basePayload()); r.payload.conclusion = { kind: "abstain", reason: "insufficient_evidence" }; const x = checkIntegrity(r); expect(x.ok).toBe(false); if (!x.ok) { expect(x.code).toBe("fingerprint_mismatch"); expect(x.message).not.toContain("health:k"); } });
  test("cross: undeclared projection as-key", () => { const p = basePayload(); (p.decision_inputs.entity_snapshot.eA as Record<string, unknown>).bogus = []; expect(checkIntegrity(rec(p)).ok).toBe(false); });
  test("cross: undeclared edge sub-field", () => { const p = basePayload(); (p.decision_inputs.entity_snapshot.eA as { reports_to: Record<string, unknown>[] }).reports_to[0].extra = 1; expect(checkIntegrity(rec(p)).ok).toBe(false); });
  test("cross: evidence ref not projected", () => { const p = basePayload(); p.evidence_manifest.push({ source: "health", ref: "health:k:eA:eC", trust_state: "candidate" }); expect(checkIntegrity(rec(p)).ok).toBe(false); });
  test("cross: rule_id mismatch", () => { const p = basePayload(); p.dependency_manifest.rule_id = "other"; expect(checkIntegrity(rec(p)).ok).toBe(false); });
});
```

- [ ] **Step 2: Run → FAIL**.
- [ ] **Step 3: Implement integrity (shared validator called in canonicalPayload + checkIntegrity)**

```ts
// src/core/recommendation/integrity.ts
import { canonicalJson, normalizeProse, sha256Hex } from "./canonical.js";
import type { DecisionInputs, DependencyDeclaration, RecommendationConclusion, RecommendationImmutablePayload, RecommendationRecord } from "./types.js";

export type IntegrityCode = "inputs_hash_mismatch" | "fingerprint_mismatch" | "cross_undeclared_field" | "cross_evidence_not_projected" | "cross_rule_id_mismatch" | "duplicate_declaration";
export type IntegrityResult = { ok: true } | { ok: false; code: IntegrityCode; message: string };

/** SINGLE declaration validator (rev5 HIGH 1) — shared by canonicalPayload (=> computeFingerprint
 *  => store.createRecord), checkIntegrity, and the projection reader. */
export function validateDependencyDeclarations(declarations: DependencyDeclaration[]): void {
  const seen = new Set<string>();
  for (const d of declarations) { const key = `${d.slug ?? "__global__"}::${d.as}`; if (seen.has(key)) throw new Error(`integrity: duplicate (slug,as) ${key}`); seen.add(key); }
}
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
  validateDependencyDeclarations(p.dependency_manifest.declarations); // throws on duplicate => fingerprint path covered
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
  const a: Record<string, unknown> = { type: c.action.type, target_ref: c.action.target_ref, reason: normalizeProse(c.action.reason) };
  if (c.action.rollback_note !== undefined) a.rollback_note = normalizeProse(c.action.rollback_note);
  return { kind: "propose", action: a, alternatives: c.alternatives.map((x) => { const o: Record<string, unknown> = { type: x.type, target_ref: x.target_ref, reason: normalizeProse(x.reason) }; if (x.rollback_note !== undefined) o.rollback_note = normalizeProse(x.rollback_note); return o; }) };
}
export function checkIntegrity(r: RecommendationRecord): IntegrityResult {
  try { validateDependencyDeclarations(r.payload.dependency_manifest.declarations); } catch { return { ok: false, code: "duplicate_declaration", message: "duplicate declaration" }; }
  if (computeInputsHash(r.payload.decision_inputs) !== r.payload.inputs_hash) return { ok: false, code: "inputs_hash_mismatch", message: "inputs_hash mismatch" };
  if (computeFingerprint(r.payload) !== r.fingerprint) return { ok: false, code: "fingerprint_mismatch", message: "fingerprint mismatch" };
  return checkCrossConsistency(r.payload);
}
function checkCrossConsistency(p: RecommendationImmutablePayload): IntegrityResult {
  const declared = new Map<string, Map<string, Set<string>>>();
  for (const d of p.dependency_manifest.declarations) { const key = d.slug ?? "__global__"; const m = declared.get(key) ?? new Map<string, Set<string>>(); m.set(d.as, new Set(d.fields)); declared.set(key, m); }
  for (const [slug, snap] of Object.entries(p.decision_inputs.entity_snapshot)) {
    const allowed = declared.get(slug); if (!allowed) return { ok: false, code: "cross_undeclared_field", message: "slug not declared" };
    for (const asKey of Object.keys(snap as object)) { const fs = allowed.get(asKey); if (!fs) return { ok: false, code: "cross_undeclared_field", message: "undeclared projection key" }; const v = (snap as Record<string, unknown>)[asKey]; const els = Array.isArray(v) ? v : [v]; for (const el of els) if (el && typeof el === "object") for (const f of Object.keys(el as object)) if (!fs.has(f)) return { ok: false, code: "cross_undeclared_field", message: "undeclared field" }; }
  }
  const refs = new Set(p.decision_inputs.evidence_refs);
  for (const e of p.evidence_manifest) if (!refs.has(e.ref)) return { ok: false, code: "cross_evidence_not_projected", message: "evidence ref not projected" };
  if (p.dependency_manifest.rule_id !== p.producer.rule_id) return { ok: false, code: "cross_rule_id_mismatch", message: "rule_id mismatch" };
  return { ok: true };
}
```

> The reader (Task 7) calls `validateDependencyDeclarations` too — the SAME function — so all three entries (fingerprint/integrity/reader) share one contract.

- [ ] **Step 4: Run → PASS**.
- [ ] **Step 5: Commit**

```bash
git add src/core/recommendation/integrity.ts tests/core/recommendation/integrity.test.ts
git commit -m "feat(rec): integrity (shared declaration validator) (#328)"
```

---

## Task 5: Registry — multi-live runners, setActive, active-aware manifest (spec §7.2; rev5 HIGH 2)

**Files:** Create `src/core/recommendation/registry.ts`; Test `tests/core/recommendation/registry.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/core/recommendation/registry.test.ts
import { describe, expect, test } from "bun:test";
import { VersionedRuleRegistry } from "../../../src/core/recommendation/registry.js";
function runner(id: string, ver: string, hash: string) { return { rule_id: id, rule_version: ver, code_hash: hash, registry_ref: `${id}@${ver}`, captureInputs: () => ({ signals: {}, entity_snapshot: {}, evidence_refs: [] as string[] }), decide: () => ({ kind: "abstain" as const, reason: "policy_prohibits" as const }) }; }
describe("VersionedRuleRegistry", () => {
  test("multiple live versions of one rule_id COEXIST (HIGH 2)", () => {
    const reg = new VersionedRuleRegistry();
    reg.register(runner("d", "1.0.0", "h1")); reg.register(runner("d", "1.1.0", "h2")); // no purge needed
    expect(reg.resolve("d", "1.0.0").status).toBe("ok");   // old still exact-resolvable (replay)
    expect(reg.resolve("d", "1.1.0").status).toBe("ok");
  });
  test("register does NOT auto-grab active; resolveActive unknown until setActive", () => {
    const reg = new VersionedRuleRegistry(); reg.register(runner("d", "1.0.0", "h1"));
    expect(reg.resolveActive("d").status).toBe("unavailable");
    reg.setActive("d", "1.0.0"); expect(reg.resolveActive("d").status).toBe("ok");
  });
  test("setActive target must be a live runner", () => {
    const reg = new VersionedRuleRegistry(); reg.register(runner("d", "1.0.0", "h1"));
    expect(() => reg.setActive("d", "9.9.9")).toThrow(/unregistered/);
    reg.markPurged("d", "1.0.0", "h1"); expect(() => reg.setActive("d", "1.0.0")).toThrow(/tombstoned/);
  });
  test("reverse registration order — setActive selects configured version", () => {
    const reg = new VersionedRuleRegistry();
    reg.register(runner("d", "1.1.0", "h2")); reg.register(runner("d", "1.0.0", "h1"));
    reg.setActive("d", "1.0.0"); const a = reg.resolveActive("d"); expect(a.status).toBe("ok"); if (a.status === "ok") expect(a.rule_version).toBe("1.0.0");
  });
  test("setActive changes manifest => policy hash changes", () => {
    const reg = new VersionedRuleRegistry(); reg.register(runner("d", "1.0.0", "h1")); reg.register(runner("d", "1.1.0", "h2"));
    reg.setActive("d", "1.0.0"); const m1 = reg.manifest(); reg.setActive("d", "1.1.0"); const m2 = reg.manifest();
    expect(m1).not.toBe(m2); expect(m2).toContain("active:d:1.1.0");
  });
  test("markPurged refuses the active version; allowed on retired versions", () => {
    const reg = new VersionedRuleRegistry(); reg.register(runner("d", "1.0.0", "h1")); reg.register(runner("d", "1.1.0", "h2"));
    reg.setActive("d", "1.1.0");
    expect(() => reg.markPurged("d", "1.1.0", "h2")).toThrow(/cannot purge active/); // active must switch first
    expect(() => reg.markPurged("d", "1.0.0", "h1")).not.toThrow();                   // retired (non-active) ok
    expect(reg.resolve("d", "1.0.0").status).toBe("unavailable");                     // purged
    expect(reg.resolveActive("d").status).toBe("ok");                                 // active 1.1.0 unaffected
  });
  test("manifest encodes live/purged/incompatible distinctly", () => {
    const reg = new VersionedRuleRegistry(); reg.register(runner("d", "1.0.0", "h1")); reg.setActive("d", "1.0.0");
    const live = reg.manifest(); reg.markIncompatible("d", "1.0.0", "h1"); const inc = reg.manifest();
    expect(live).not.toBe(inc);
  });
  test("directory lists only active live producers", () => {
    const reg = new VersionedRuleRegistry(); reg.register(runner("d", "1.0.0", "h1")); reg.setActive("d", "1.0.0");
    expect(reg.directory()).toEqual([{ rule_id: "d", rule_version: "1.0.0", code_hash: "h1", registry_ref: "d@1.0.0" }]);
  });
});
```

- [ ] **Step 2: Run → FAIL**.
- [ ] **Step 3: Implement registry**

```ts
// src/core/recommendation/registry.ts
import type { DecisionInputs, RecommendationConclusion, RecommendationProducer } from "./types.js";
export interface RuleRunner extends RecommendationProducer { captureInputs: (projection: unknown) => DecisionInputs; decide: (di: DecisionInputs) => RecommendationConclusion; }
export type ResolveResult = ({ status: "ok" } & RuleRunner) | { status: "unavailable"; reason: "unknown" | "purged" | "incompatible" };
type Entry = RuleRunner | { tombstone: "purged" | "incompatible"; code_hash: string };
export class VersionedRuleRegistry {
  private entries = new Map<string, Entry>();
  private activeVersion = new Map<string, string>();
  private key(id: string, ver: string): string { return `${id}@${ver}`; }
  /** Register an immutable runner. Does NOT change active version (HIGH 2). */
  register(r: RuleRunner): void { const k = this.key(r.rule_id, r.rule_version); const ex = this.entries.get(k); if (ex) { if (ex === r) return; throw new Error(`registry: ${k} already registered differently`); } this.entries.set(k, r); }
  /** Switch active version (must be a live runner). Enters manifest/policy identity. */
  setActive(id: string, ver: string): void { const e = this.entries.get(this.key(id, ver)); if (!e) throw new Error(`registry: setActive target unregistered ${id}@${ver}`); if ("tombstone" in e) throw new Error(`registry: setActive target tombstoned ${id}@${ver}`); this.activeVersion.set(id, ver); }
  markPurged(id: string, ver: string, codeHash: string): void { if (this.activeVersion.get(id) === ver) throw new Error(`registry: cannot purge active ${id}@${ver}; setActive another first`); this.entries.set(this.key(id, ver), { tombstone: "purged", code_hash: codeHash }); }
  markIncompatible(id: string, ver: string, codeHash: string): void { if (this.activeVersion.get(id) === ver) this.activeVersion.delete(id); this.entries.set(this.key(id, ver), { tombstone: "incompatible", code_hash: codeHash }); }
  resolve(id: string, ver: string): ResolveResult { const e = this.entries.get(this.key(id, ver)); if (!e) return { status: "unavailable", reason: "unknown" }; if ("tombstone" in e) return { status: "unavailable", reason: e.tombstone }; return { status: "ok", ...e }; }
  resolveActive(id: string): ResolveResult { const v = this.activeVersion.get(id); if (v === undefined) return { status: "unavailable", reason: "unknown" }; return this.resolve(id, v); }
  directory(): RecommendationProducer[] { return [...this.activeVersion.entries()].map(([id, ver]) => { const e = this.entries.get(this.key(id, ver)); return e && !("tombstone" in e) ? { rule_id: e.rule_id, rule_version: e.rule_version, code_hash: e.code_hash, registry_ref: e.registry_ref } : null; }).filter((x): x is RecommendationProducer => x !== null); }
  manifest(): string {
    const lines: string[] = [];
    for (const [k, e] of this.entries) lines.push("tombstone" in e ? `${k}:${e.tombstone}:${e.code_hash}` : `${k}:live:${e.code_hash}`);
    for (const [id, ver] of this.activeVersion) lines.push(`active:${id}:${ver}`);
    return lines.sort().join("\n");
  }
}
```

- [ ] **Step 4: Run → PASS**.
- [ ] **Step 5: Commit**

```bash
git add src/core/recommendation/registry.ts tests/core/recommendation/registry.test.ts
git commit -m "feat(rec): registry (multi-live runners, setActive, active-aware manifest) (#328)"
```

---

## Task 6: Rule runtime — generic runner over declarative RuleDefinition (rev5 HIGH 3)

**Files:** Create `src/core/recommendation/rule-runtime.ts`; Test `tests/core/recommendation/rule-runtime.test.ts`

- [ ] **Step 1: Write failing test (code_hash from definition; def change → hash+behavior change)**

```ts
// tests/core/recommendation/rule-runtime.test.ts
import { describe, expect, test } from "bun:test";
import { definitionCodeHash, runRule } from "../../../src/core/recommendation/rule-runtime.js";
import type { RuleDefinition } from "../../../src/core/recommendation/types.js";

const DEF: RuleDefinition = { rule_id: "health:known_relations", rule_version: "1.0.0", registry_ref: "cbrain.rules:maintenance.known_relations@1.0.0", candidateRelation: "reports_to", evidenceRefTemplate: "health:known_relations:{from}:{to}", abstainReason: "insufficient_evidence", propose: { type: "dry_run", targetTemplate: "health:known_relations:{first_slug}", reason: "存在待确认的 reports_to 候选边，建议人工复核" } };

describe("runRule (declarative single source)", () => {
  test("code_hash is sha256 of the definition (data, not wrapper)", () => {
    expect(definitionCodeHash(DEF)).toMatch(/^[0-9a-f]{64}$/);
    expect(runRule(DEF).code_hash).toBe(definitionCodeHash(DEF));
  });
  test("abstains when no candidate edge", () => {
    const r = runRule(DEF);
    const di = r.captureInputs({ eA: { reports_to: [] } });
    expect(r.decide(di).kind).toBe("abstain");
  });
  test("proposes + exact evidence ref when candidate edge present (no undefined)", () => {
    const r = runRule(DEF);
    const di = r.captureInputs({ "entities/eA": { reports_to: [{ from: "entities/eA", to: "entities/eB", trust_state: "candidate" }] } });
    expect(di.evidence_refs).toEqual(["health:known_relations:entities/eA:entities/eB"]);
    const c = r.decide(di); expect(c.kind).toBe("propose");
  });
  test("HIGH 3: changing the definition changes code_hash AND behavior", () => {
    const def2: RuleDefinition = { ...DEF, rule_version: "1.1.0", abstainReason: "below_threshold" };
    expect(definitionCodeHash(def2)).not.toBe(definitionCodeHash(DEF));
    const r2 = runRule(def2);
    const di = r2.captureInputs({ eA: { reports_to: [] } });
    const c = r2.decide(di); expect(c.kind).toBe("abstain"); if (c.kind === "abstain") expect(c.reason).toBe("below_threshold");
  });
});
```

- [ ] **Step 2: Run → FAIL**.
- [ ] **Step 3: Implement rule runtime**

```ts
// src/core/recommendation/rule-runtime.ts
import { canonicalJson, sha256Hex } from "./canonical.js";
import type { DecisionInputs, RecommendationConclusion, RuleDefinition } from "./types.js";

/** code_hash = sha256(canonical(definition)). The definition is DATA — single source of
 *  behavior + identity. No wrapper toString, stable across transpile/pack (rev5 HIGH 3). */
export function definitionCodeHash(def: RuleDefinition): string {
  return sha256Hex(canonicalJson({
    rule_id: def.rule_id, rule_version: def.rule_version, registry_ref: def.registry_ref,
    candidateRelation: def.candidateRelation, evidenceRefTemplate: def.evidenceRefTemplate,
    abstainReason: def.abstainReason, propose: def.propose,
  }));
}

/** Generic runner that interprets a RuleDefinition. Phase 1 rule kind: count active
 *  candidate edges of candidateRelation across declared slugs; abstain if zero, else propose. */
export function runRule(def: RuleDefinition): { code_hash: string; captureInputs: (projection: unknown) => DecisionInputs; decide: (di: DecisionInputs) => RecommendationConclusion } {
  const code_hash = definitionCodeHash(def);
  const captureInputs = (projection: unknown): DecisionInputs => {
    const p = projection as Record<string, Record<string, { from: string; to: string; trust_state: string }[]>>;
    const slugs = Object.keys(p).sort();
    const candidates: { from: string; to: string; trust_state: string }[] = [];
    const entity_snapshot: Record<string, Record<string, unknown>> = {};
    for (const s of slugs) {
      const edges = p[s]?.[def.candidateRelation] ?? [];
      entity_snapshot[s] = { [def.candidateRelation]: edges };
      for (const e of edges) if (e.trust_state === "candidate") candidates.push(e);
    }
    const evidence_refs = [...new Set(candidates.map((e) => def.evidenceRefTemplate.replace("{from}", e.from).replace("{to}", e.to)))].sort();
    return { signals: { candidate_count: candidates.length }, entity_snapshot, evidence_refs };
  };
  const decide = (di: DecisionInputs): RecommendationConclusion => {
    if (((di.signals.candidate_count as number) ?? 0) === 0) return { kind: "abstain", reason: def.abstainReason };
    const first = Object.keys(di.entity_snapshot).sort()[0] ?? "";
    return { kind: "propose", action: { type: def.propose.type, target_ref: def.propose.targetTemplate.replace("{first_slug}", first), reason: def.propose.reason }, alternatives: [] };
  };
  return { code_hash, captureInputs, decide };
}
```

- [ ] **Step 4: Run → PASS**.
- [ ] **Step 5: Commit**

```bash
git add src/core/recommendation/rule-runtime.ts tests/core/recommendation/rule-runtime.test.ts
git commit -m "feat(rec): declarative rule runtime (definition-derived code_hash) (#328)"
```

---

## Task 7: DeclaredProjectionReader (strict, fail-closed, shared dup check) + freshness (verifies runner metadata) (spec §5.3; rev5 HIGH 4)

**Files:** Create `src/core/recommendation/projection.ts`, `src/core/recommendation/freshness.ts`; Test `tests/core/recommendation/freshness.test.ts`

- [ ] **Step 1: Write failing test (from preserved; dup fail-closed via shared validator; drift→stale; A→B→A; metadata mismatch→version_invalid)**

```ts
// tests/core/recommendation/freshness.test.ts
import { rmSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import { CBrainDB } from "../../../src/storage/sqlite.js";
import { RecommendationStore } from "../../../src/core/recommendation/record-store.js";
import { DeclaredProjectionReader } from "../../../src/core/recommendation/projection.js";
import { recomputeAndPersistFreshness } from "../../../src/core/recommendation/freshness.js";
import { VersionedRuleRegistry } from "../../../src/core/recommendation/registry.js";
import { runRule } from "../../../src/core/recommendation/rule-runtime.js";
import { validateDependencyDeclarations, computeInputsHash } from "../../../src/core/recommendation/integrity.js";
import type { DependencyManifest, RecommendationImmutablePayload, RecommendationProducer, RuleDefinition } from "../../../src/core/recommendation/types.js";
import { SCHEMA_VERSION } from "../../../src/core/recommendation/types.js";

const DIR = "/tmp/cbrain-test-rec-fresh";
const A = "entities/eA"; const B = "entities/eB";
function seed(db: CBrainDB) { for (const s of [A, B]) db.rawDb.prepare(`INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count, tier) VALUES (?, 'entity', ?, ?, ?, 0, 3)`).run(s, s, `${s}.md`, `h-${s}`); }
function link(db: CBrainDB, from: string, to: string, trust: string) { db.rawDb.prepare(`INSERT INTO links (from_slug, to_slug, relation, trust_state, source_type) VALUES (?, ?, 'reports_to', ?, 'agent')`).run(from, to, trust); }
const decls: DependencyManifest = { rule_id: "health:known_relations", declarations: [A, B].map((s) => ({ slug: s, table: "links" as const, as: "reports_to", relation: "reports_to", direction: "outgoing" as const, fields: ["from", "to", "trust_state"], filter: "active" as const })) };
const DEF: RuleDefinition = { rule_id: "health:known_relations", rule_version: "1.0.0", registry_ref: "cbrain.rules:maintenance.known_relations@1.0.0", candidateRelation: "reports_to", evidenceRefTemplate: "health:known_relations:{from}:{to}", abstainReason: "insufficient_evidence", propose: { type: "dry_run", targetTemplate: "health:known_relations:{first_slug}", reason: "r" } };
function makeRegistry(): VersionedRuleRegistry { const reg = new VersionedRuleRegistry(); const r = runRule(DEF); reg.register({ rule_id: DEF.rule_id, rule_version: DEF.rule_version, registry_ref: DEF.registry_ref, code_hash: r.code_hash, captureInputs: r.captureInputs, decide: r.decide }); reg.setActive(DEF.rule_id, DEF.rule_version); return reg; }
function payloadFor(db: CBrainDB, reg: VersionedRuleRegistry, producerOverride?: Partial<RecommendationProducer>): RecommendationImmutablePayload {
  const proj = new DeclaredProjectionReader(db).read(decls.declarations); const runner = reg.resolveActive(DEF.rule_id); if (runner.status !== "ok") throw new Error("no active");
  const di = runner.captureInputs(proj);
  const producer: RecommendationProducer = { rule_id: DEF.rule_id, rule_version: DEF.rule_version, code_hash: runner.code_hash, registry_ref: DEF.registry_ref, ...producerOverride };
  return { namespace: "maintenance", maintenance_key: `health:known_relations:${JSON.stringify([A, B])}`, inputs_hash: computeInputsHash(di), conclusion: { kind: "propose", action: { type: "dry_run", target_ref: `health:known_relations:${A}`, reason: "r" }, alternatives: [] }, decision_inputs: di, evidence_manifest: di.evidence_refs.map((ref) => ({ source: "health", ref, trust_state: "candidate" as const })), constraints: { policy_version: "p", ontology_version: "o", schema_version: SCHEMA_VERSION }, dependency_manifest: decls, applicability: { audience: "user_only", auto_execute: false, requires_confirmation: { tier: "standard" } }, risks: [], gaps: [], producer };
}
const CC = { policy_version: "p", ontology_version: "o", schema_version: SCHEMA_VERSION };

describe("DeclaredProjectionReader", () => {
  afterEach(() => { rmSync(DIR, { recursive: true, force: true }); });
  test("preserves from/to/trust_state", () => { const db = new CBrainDB(`${DIR}/r1.sqlite`); seed(db); link(db, A, B, "candidate"); const e = (new DeclaredProjectionReader(db).read(decls.declarations)[A] as { reports_to: { from: string; to: string; trust_state: string }[] }).reports_to[0]; expect(e).toEqual({ from: A, to: B, trust_state: "candidate" }); db.close(); });
  test("fail-closed unsupported table", () => { const db = new CBrainDB(`${DIR}/r2.sqlite`); seed(db); expect(() => new DeclaredProjectionReader(db).read([{ slug: A, table: "lance", as: "x", fields: ["y"] }])).toThrow(/unsupported table/); db.close(); });
  test("fail-closed undeclared field", () => { const db = new CBrainDB(`${DIR}/r3.sqlite`); seed(db); link(db, A, B, "candidate"); expect(() => new DeclaredProjectionReader(db).read([{ slug: A, table: "links", as: "reports_to", relation: "reports_to", fields: ["from", "bogus"], filter: "active" }])).toThrow(/not available/); db.close(); });
  test("duplicate (slug,as) via SHARED validator", () => { const db = new CBrainDB(`${DIR}/r4.sqlite`); seed(db); expect(() => new DeclaredProjectionReader(db).read([{ slug: A, table: "links", as: "reports_to", relation: "reports_to", fields: ["from", "to"], filter: "active" }, { slug: A, table: "links", as: "reports_to", relation: "reports_to", fields: ["from", "to"], filter: "active" }])).toThrow(/duplicate.*slug.*as/); db.close(); });
  test("inactive excluded (active filter)", () => { const db = new CBrainDB(`${DIR}/r5.sqlite`); seed(db); link(db, A, B, "rejected"); expect((new DeclaredProjectionReader(db).read(decls.declarations)[A] as { reports_to: unknown[] }).reports_to.length).toBe(0); db.close(); });
});
describe("recomputeAndPersistFreshness", () => {
  afterEach(() => { rmSync(DIR, { recursive: true, force: true }); });
  test("drift → persisted stale, lifecycle untouched", () => { const db = new CBrainDB(`${DIR}/f1.sqlite`); seed(db); link(db, A, B, "candidate"); const reg = makeRegistry(); const store = new RecommendationStore(db); const c = store.createRecord(payloadFor(db, reg), "2026-07-12 10:00:00"); link(db, B, A, "candidate"); const out = recomputeAndPersistFreshness(store.getById(c.record_id)!, new DeclaredProjectionReader(db), reg, store, CC, "2026-07-12 11:00:00"); expect(out.freshness).toBe("stale"); const re = store.getById(c.record_id); expect(re?.freshness_status).toBe("stale"); expect(re?.lifecycle_status).toBe("pending"); db.close(); });
  test("A→B→A path 1 → fresh recovers", () => { const db = new CBrainDB(`${DIR}/f2.sqlite`); seed(db); link(db, A, B, "candidate"); const reg = makeRegistry(); const store = new RecommendationStore(db); const c = store.createRecord(payloadFor(db, reg), "2026-07-12 10:00:00"); link(db, B, A, "candidate"); recomputeAndPersistFreshness(store.getById(c.record_id)!, new DeclaredProjectionReader(db), reg, store, CC, "2026-07-12 11:00:00"); db.rawDb.prepare("DELETE FROM links WHERE from_slug=? AND to_slug=?").run(B, A); recomputeAndPersistFreshness(store.getById(c.record_id)!, new DeclaredProjectionReader(db), reg, store, CC, "2026-07-12 12:00:00"); expect(store.getById(c.record_id)?.freshness_status).toBe("fresh"); db.close(); });
  test("runner unavailable → version_invalid", () => { const db = new CBrainDB(`${DIR}/f3.sqlite`); seed(db); link(db, A, B, "candidate"); const reg = makeRegistry(); const store = new RecommendationStore(db); const c = store.createRecord(payloadFor(db, reg), "2026-07-12 10:00:00"); expect(recomputeAndPersistFreshness(store.getById(c.record_id)!, new DeclaredProjectionReader(db), new VersionedRuleRegistry(), store, CC, "2026-07-12 11:00:00").freshness).toBe("version_invalid"); db.close(); });
  test("HIGH 4: runner code_hash mismatch with record producer → version_invalid", () => {
    const db = new CBrainDB(`${DIR}/f4.sqlite`); seed(db); link(db, A, B, "candidate"); const reg = makeRegistry(); const store = new RecommendationStore(db);
    // record claims a wrong code_hash but is otherwise self-consistent (integrity doesn't check vs registry)
    const c = store.createRecord(payloadFor(db, reg, { code_hash: "deadbeef" }), "2026-07-12 10:00:00");
    const out = recomputeAndPersistFreshness(store.getById(c.record_id)!, new DeclaredProjectionReader(db), reg, store, CC, "2026-07-12 11:00:00");
    expect(out.freshness).toBe("version_invalid");
    db.close();
  });
});

// ensure validateDependencyDeclarations is the same function the reader uses (compile-time import sanity)
void validateDependencyDeclarations;
```

- [ ] **Step 2: Run → FAIL**.
- [ ] **Step 3: Implement projection reader (shared validator) + freshness (metadata check)**

```ts
// src/core/recommendation/projection.ts
import type { CBrainDB } from "../../storage/sqlite.js";
import { validateDependencyDeclarations } from "./integrity.js";
import type { DependencyDeclaration } from "./types.js";
export interface DeclaredProjection { [slug: string]: Record<string, unknown> }
export class DeclaredProjectionReader {
  constructor(private db: CBrainDB) {}
  read(declarations: DependencyDeclaration[]): DeclaredProjection {
    validateDependencyDeclarations(declarations); // SAME validator as fingerprint/integrity (HIGH 1)
    const proj: DeclaredProjection = {};
    for (const d of declarations) { const key = d.slug ?? "__global__"; if (proj[key] === undefined) proj[key] = {}; proj[key][d.as] = this.readOne(d); }
    return proj;
  }
  private readOne(d: DependencyDeclaration): unknown {
    if (d.table === "links") { if (!d.slug) throw new Error(`projection: links needs slug (as=${d.as})`); if (!d.relation) throw new Error(`projection: links needs relation (as=${d.as})`); const all = d.filter === "all"; const rows = (d.direction ?? "outgoing") === "outgoing" ? this.db.getOutgoingLinks(d.slug, all) : this.db.getIncomingLinks(d.slug, all); return rows.filter((r) => r.relation === d.relation).map((r) => pick({ from: r.from_slug, to: r.to_slug, trust_state: r.trust_state ?? "trusted" }, d.fields, `links[${d.as}]`)); }
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
  // HIGH 4: verify the resolved runner IS the one that produced this record (exact identity)
  if (runner.code_hash !== record.payload.producer.code_hash || runner.registry_ref !== record.payload.producer.registry_ref) { store.updateFreshness(record.record_id, "version_invalid", now); return { freshness: "version_invalid" }; }
  const freshness = computeInputsHash(runner.captureInputs(reader.read(record.payload.dependency_manifest.declarations))) === record.payload.inputs_hash ? "fresh" : "stale";
  store.updateFreshness(record.record_id, freshness, now);
  return { freshness };
}
```

- [ ] **Step 4: Run → PASS**.
- [ ] **Step 5: Commit**

```bash
git add src/core/recommendation/projection.ts src/core/recommendation/freshness.ts tests/core/recommendation/freshness.test.ts
git commit -m "feat(rec): fail-closed reader + freshness (exact runner metadata check) (#328)"
```

---

## Task 8: Record store (single entry, suppression, guarded reopen) (spec §5.5, §5.6)

> Same as rev4 (default TTL wired, EXISTS suppression, clearSuppression guards, time validation). Kept compact; full TDD in rev4 applies.

**Files:** Create `src/core/recommendation/record-store.ts`; Test `tests/core/recommendation/record-store.test.ts`

- [ ] **Step 1: Write failing test** — identical to rev4 Task 6 Step 1 (createRecord computes fingerprint; rejects auto_execute; idempotent; atomic supersede; illegal now rejected; default TTL → now+7d; null → permanent; illegal suppressedUntil rejected; F17 expired; MED 3 real sibling expired+permanent; clearSuppression only on rejected+existing; superseded cannot regress; updateFreshness only freshness). Re-use the rev4 test body verbatim (it already closes HIGH 2/MED 3 from prior rounds). Ensure every `new CBrainDB(...)` is paired with `db.close()` in its test.

- [ ] **Step 2: Run → FAIL**.
- [ ] **Step 3: Implement store** — identical to rev4 Task 6 Step 3 (`createRecord` with `validateTimestamp(now)`, auto_execute check, computeInputsHash/computeFingerprint/checkIntegrity, EXISTS suppression, atomic supersede; `transitionLifecycle` with `undefined→defaultSuppressedUntil`/`null→permanent`/string→strict; `updateFreshness`; `clearSuppression` requires rejected + `changes===1`). Imports `validateTimestamp`, `defaultSuppressedUntil`, `SUPPRESSION_REOPENED` from `./policy.js`.

- [ ] **Step 4: Run → PASS**.
- [ ] **Step 5: Commit**

```bash
git add src/core/recommendation/record-store.ts tests/core/recommendation/record-store.test.ts
git commit -m "feat(rec): record store (single entry, suppression, guarded reopen) (#328)"
```

> **Executor note:** the rev4 Task 6 test + impl are re-used unchanged here (they had no rev5 finding against them). Copy them verbatim from git history `16578ae` if helpful; the only invariant is every DB handle is closed.

---

## Task 9: Display — single entry, no public ontology param, test seam (spec §4.4, §5.3, §11.3; rev5 HIGH 4)

**Files:** Create `src/core/recommendation/versions.ts`, `src/core/recommendation/display.ts`; Test `tests/core/recommendation/display.test.ts`

- [ ] **Step 1: Write failing test (real positive; drift→blocked; manifest change→blocked; ontology via non-exported seam; metadata mismatch→blocked; hostile reason via real record)**

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
import { loadAndProjectDisplay, __setDisplayOntologySourceForTest } from "../../../src/core/recommendation/display.js";
import { ontologyHash, policyHash } from "../../../src/core/recommendation/versions.js";
import { computeInputsHash } from "../../../src/core/recommendation/integrity.js";
import type { RecommendationImmutablePayload } from "../../../src/core/recommendation/types.js";
import { SCHEMA_VERSION } from "../../../src/core/recommendation/types.js";

const DIR = "/tmp/cbrain-test-rec-display";
const A = "entities/eA"; const B = "entities/eB";
function seed(db: CBrainDB) { for (const s of [A, B]) db.rawDb.prepare(`INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count, tier) VALUES (?, 'entity', ?, ?, ?, 0, 3)`).run(s, s, `${s}.md`, `h-${s}`); }
function link(db: CBrainDB, from: string, to: string, trust: string) { db.rawDb.prepare(`INSERT INTO links (from_slug, to_slug, relation, trust_state, source_type) VALUES (?, ?, 'reports_to', ?, 'agent')`).run(from, to, trust); }
function fresh() { const db = new CBrainDB(`${DIR}/${Math.random().toString(36).slice(2)}.sqlite`); const reg = new VersionedRuleRegistry(); registerMaintenanceProducers(reg); return { db, store: new RecommendationStore(db), reg, mgr: new RecommendationManager(db, reg) }; }

describe("loadAndProjectDisplay", () => {
  afterEach(() => { rmSync(DIR, { recursive: true, force: true }); __setDisplayOntologySourceForTest(null); });
  test("real positive — unchanged deps + production sources → display produced", () => {
    const { db, store, reg, mgr } = fresh(); seed(db); link(db, A, B, "candidate");
    const created = mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:00");
    const out = loadAndProjectDisplay(created.record_id, { store, reader: new DeclaredProjectionReader(db), registry: reg, now: "2026-07-12 10:00:01" }, () => "实体A");
    expect(out.blocked).toBe(false); if (!out.blocked) { expect(out.target_display).toBe("实体A"); expect(out.reason).toContain("候选边"); }
    db.close();
  });
  test("drift after create, no manual refresh → blocked", () => {
    const { db, store, reg, mgr } = fresh(); seed(db); link(db, A, B, "candidate");
    const created = mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:00");
    link(db, B, A, "candidate");
    expect(loadAndProjectDisplay(created.record_id, { store, reader: new DeclaredProjectionReader(db), registry: reg, now: "2026-07-12 10:00:01" }, () => "x").blocked).toBe(true);
    db.close();
  });
  test("registry manifest change (setActive to a differently-hashed version) → blocked", () => {
    const { db, store, reg, mgr } = fresh(); seed(db); link(db, A, B, "candidate");
    const created = mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:00");
    // switch active away to a different version → policy_version (manifest) changes
    reg.setActive("health:known_relations", "1.0.0"); // no-op if already; instead register a v2 and switch
    // (registerMaintenanceProducers only registered 1.0.0; simulate policy change via markIncompatible of a non-active tombstone path)
    reg.markIncompatible("health:known_relations", "1.0.0", created.payload.producer.code_hash);
    expect(loadAndProjectDisplay(created.record_id, { store, reader: new DeclaredProjectionReader(db), registry: reg, now: "2026-07-12 10:00:01" }, () => "x").blocked).toBe(true);
    db.close();
  });
  test("ontology drift via NON-exported test seam → blocked; restore restores", () => {
    const { db, store, reg, mgr } = fresh(); seed(db); link(db, A, B, "candidate");
    const created = mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:00");
    __setDisplayOntologySourceForTest(() => "deadbeef");
    expect(loadAndProjectDisplay(created.record_id, { store, reader: new DeclaredProjectionReader(db), registry: reg, now: "2026-07-12 10:00:01" }, () => "x").blocked).toBe(true);
    __setDisplayOntologySourceForTest(null); // restore production source
    expect(loadAndProjectDisplay(created.record_id, { store, reader: new DeclaredProjectionReader(db), registry: reg, now: "2026-07-12 10:00:02" }, () => "x").blocked).toBe(false);
    db.close();
  });
  test("HIGH 4: producer metadata mismatch → blocked", () => {
    const { db, store, reg, mgr } = fresh(); seed(db); link(db, A, B, "candidate");
    const created = mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:00");
    // tamper the persisted record's producer.code_hash directly (simulates a self-consistent-but-mismatched record)
    db.rawDb.prepare("UPDATE recommendation_records SET payload = json_set(payload, '$.producer.code_hash', $h) WHERE record_id = $id").run({ $h: "tampered", $id: created.record_id });
    expect(loadAndProjectDisplay(created.record_id, { store, reader: new DeclaredProjectionReader(db), registry: reg, now: "2026-07-12 10:00:01" }, () => "x").blocked).toBe(true);
    db.close();
  });
  test("hostile reason written to a REAL record → sanitized on output", () => {
    const { db, store, reg } = fresh(); seed(db); link(db, A, B, "candidate");
    const di = { signals: { candidate_count: 1 }, entity_snapshot: { [A]: { reports_to: [{ from: A, to: B, trust_state: "candidate" }] } }, evidence_refs: [`health:known_relations:${A}:${B}`] };
    const meta = reg.directory()[0];
    const payload: RecommendationImmutablePayload = { namespace: "maintenance", maintenance_key: `health:known_relations:${JSON.stringify([A, B])}`, inputs_hash: computeInputsHash(di), conclusion: { kind: "propose", action: { type: "dry_run", target_ref: `health:known_relations:${A}`, reason: "score=0.9 /Users/secret" }, alternatives: [] }, decision_inputs: di, evidence_manifest: [{ source: "health", ref: `health:known_relations:${A}:${B}`, trust_state: "candidate" }], constraints: { policy_version: policyHash(reg), ontology_version: ontologyHash(), schema_version: SCHEMA_VERSION }, dependency_manifest: { rule_id: "health:known_relations", declarations: [A, B].map((s) => ({ slug: s, table: "links" as const, as: "reports_to", relation: "reports_to", direction: "outgoing" as const, fields: ["from", "to", "trust_state"], filter: "active" as const })) }, applicability: { audience: "user_only", auto_execute: false, requires_confirmation: { tier: "standard" } }, risks: [], gaps: [], producer: { rule_id: meta.rule_id, rule_version: meta.rule_version, code_hash: meta.code_hash, registry_ref: meta.registry_ref } };
    const rec = store.createRecord(payload, "2026-07-12 10:00:00");
    const out = loadAndProjectDisplay(rec.record_id, { store, reader: new DeclaredProjectionReader(db), registry: reg, now: "2026-07-12 10:00:01" }, () => "实体A");
    expect(out.blocked).toBe(false); if (!out.blocked) { expect(out.reason).not.toContain("score"); expect(out.reason).not.toContain("/Users/"); }
    db.close();
  });
});
```

> **Note on the manifest-change test:** `registerMaintenanceProducers` registers only 1.0.0; to exercise a policy-identity change without a second rule version, the test uses `markIncompatible` on the active version (registry clears active on incompatible → manifest changes AND resolveActive becomes unavailable). Both paths yield `version_invalid`. Confirm `markIncompatible` clears the active mapping (it does, per Task 5).

- [ ] **Step 2: Run → FAIL**.
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
import { ontologyHash, policyHash } from "./versions.js";
import { SCHEMA_VERSION } from "./types.js";
import type { DeclaredProjectionReader } from "./projection.js";
import type { RecommendationStore } from "./record-store.js";
import type { VersionedRuleRegistry } from "./registry.js";
import type { RecommendationRecord } from "./types.js";

const FALLBACK_DISPLAY = "一项待确认的记忆";
const FALLBACK_REASON = "有一项建议需要人工复核。";
function safe(text: string, fallback: string): string { try { assertSafeActionDisplay(text); return text; } catch { return fallback; } }

// Module-level ontology source. Production uses the real bundled ontology hash.
// Tests inject a stub via the NON-exported-for-production seam below (rev5 HIGH 4):
// there is NO ontology parameter on the public API.
let ontologySource: (() => string) | null = null;
function currentOntologyHash(): string { return ontologySource ? ontologySource() : ontologyHash(); }
/** TEST-ONLY seam (not a public runtime parameter). Pass null to restore production. */
export function __setDisplayOntologySourceForTest(fn: (() => string) | null): void { ontologySource = fn; }

function projectDisplay(rec: RecommendationRecord, resolveSafeTitle: (slug: string) => string): { blocked: true } | { blocked: false; target_display: string; reason: string } {
  const active = rec.lifecycle_status === "pending" || rec.lifecycle_status === "current";
  if (!active || rec.freshness_status !== "fresh") return { blocked: true };
  const c = rec.payload.conclusion;
  if (c.kind === "abstain") return { blocked: false, target_display: FALLBACK_DISPLAY, reason: safe(`abstain: ${c.reason}`, FALLBACK_REASON) };
  const slug = c.action.target_ref.split(":").pop() ?? c.action.target_ref;
  return { blocked: false, target_display: safe(resolveSafeTitle(slug) || FALLBACK_DISPLAY, FALLBACK_DISPLAY), reason: safe(c.action.reason, FALLBACK_REASON) };
}

export interface DisplayCtx { store: RecommendationStore; reader: DeclaredProjectionReader; registry: VersionedRuleRegistry; now: string }
export type DisplayOutcome = { blocked: true; reason: "not_found" | "integrity_failed" | "not_active_fresh" } | { blocked: false; target_display: string; reason: string };

/** The ONLY public display entry. Current version constraints computed internally from
 *  policyHash(registry) + the module production ontology hash + SCHEMA — the caller cannot
 *  supply or override version sources (rev5 HIGH 4). Forces integrity + freshness (which
 *  verifies exact runner metadata), then projects via the module-private projector. */
export function loadAndProjectDisplay(recordId: string, ctx: DisplayCtx, resolveSafeTitle: (slug: string) => string): DisplayOutcome {
  const rec = ctx.store.getById(recordId);
  if (!rec) return { blocked: true, reason: "not_found" };
  if (!checkIntegrity(rec).ok) return { blocked: true, reason: "integrity_failed" };
  const current = { policy_version: policyHash(ctx.registry), ontology_version: currentOntologyHash(), schema_version: SCHEMA_VERSION };
  recomputeAndPersistFreshness(rec, ctx.reader, ctx.registry, ctx.store, current, ctx.now);
  const reloaded = ctx.store.getById(recordId);
  if (!reloaded) return { blocked: true, reason: "not_found" };
  const out = projectDisplay(reloaded, resolveSafeTitle);
  return out.blocked ? { blocked: true, reason: "not_active_fresh" } : { blocked: false, target_display: out.target_display, reason: out.reason };
}
```

- [ ] **Step 4: Run → PASS**.
- [ ] **Step 5: Commit**

```bash
git add src/core/recommendation/versions.ts src/core/recommendation/display.ts tests/core/recommendation/display.test.ts
git commit -m "feat(rec): single display entry, no public version-source param (#328)"
```

---

## Task 10: Producer (declarative def) + manager (resolveActive) (spec §4.3, §7.2)

**Files:** Create `src/core/recommendation/producers/known-relations.ts`, `src/core/recommendation/producers/index.ts`, `src/core/recommendation/manager.ts`; Test `tests/core/recommendation/producers/known-relations.test.ts`

- [ ] **Step 1: Write failing test (exact ref; normalized slugs; definition-derived code_hash; upgrade via factory changes hash+policy)**

```ts
// tests/core/recommendation/producers/known-relations.test.ts
import { rmSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import { CBrainDB } from "../../../../src/storage/sqlite.js";
import { registerMaintenanceProducers, registerVersion } from "../../../../src/core/recommendation/producers/index.js";
import { VersionedRuleRegistry } from "../../../../src/core/recommendation/registry.js";
import { RecommendationManager } from "../../../../src/core/recommendation/manager.js";
import { policyHash } from "../../../../src/core/recommendation/versions.js";
import { definitionCodeHash } from "../../../../src/core/recommendation/rule-runtime.js";
import { KNOWN_RELATIONS_DEF } from "../../../../src/core/recommendation/producers/known-relations.js";
const DIR = "/tmp/cbrain-test-rec-producer";
const A = "entities/entityA"; const B = "entities/entityB";
function seed(db: CBrainDB) { for (const s of [A, B]) db.rawDb.prepare(`INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count, tier) VALUES (?, 'entity', ?, ?, ?, 0, 3)`).run(s, s, `${s}.md`, `h-${s}`); }
function link(db: CBrainDB, from: string, to: string, trust: string) { db.rawDb.prepare(`INSERT INTO links (from_slug, to_slug, relation, trust_state, source_type) VALUES (?, ?, 'reports_to', ?, 'agent')`).run(from, to, trust); }
function fresh() { const db = new CBrainDB(`${DIR}/${Math.random().toString(36).slice(2)}.sqlite`); const reg = new VersionedRuleRegistry(); registerMaintenanceProducers(reg); return { db, reg, mgr: new RecommendationManager(db, reg) }; }

describe("known_relations producer", () => {
  afterEach(() => { rmSync(DIR, { recursive: true, force: true }); });
  test("abstains when no candidate edge", () => { const { db, mgr } = fresh(); seed(db); expect(mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:00").payload.conclusion.kind).toBe("abstain"); db.close(); });
  test("exact evidence ref (from+to)", () => { const { db, mgr } = fresh(); seed(db); link(db, A, B, "candidate"); const r = mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:00"); expect(r.payload.evidence_manifest[0].ref).toBe(`health:known_relations:${A}:${B}`); expect(r.payload.evidence_manifest[0].ref).not.toContain("undefined"); db.close(); });
  test("normalized slugs: disordered/duplicate → same key+fingerprint", () => { const a = fresh(); seed(a.db); link(a.db, A, B, "candidate"); const r1 = a.mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [B, A, A] }, "2026-07-12 10:00:00"); const r2 = a.mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:01"); expect(r1.payload.maintenance_key).toBe(r2.payload.maintenance_key); expect(r1.fingerprint).toBe(r2.fingerprint); a.db.close(); });
  test("inactive candidate excluded", () => { const { db, mgr } = fresh(); seed(db); link(db, A, B, "rejected"); expect(mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:00").payload.conclusion.kind).toBe("abstain"); db.close(); });
  test("HIGH 3: code_hash is the definition hash; policy_version === policyHash(registry)", () => { const { db, reg, mgr } = fresh(); seed(db); link(db, A, B, "candidate"); const r = mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:00"); expect(r.payload.producer.code_hash).toBe(definitionCodeHash(KNOWN_RELATIONS_DEF)); expect(r.payload.constraints.policy_version).toBe(policyHash(reg)); db.close(); });
  test("HIGH 2+3: registering v2 via the same factory keeps v1 exact-resolvable; setActive(v2) changes policy hash; record from v2 differs", () => {
    const a = fresh(); seed(a.db); link(a.db, A, B, "candidate");
    const r1 = a.mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:00");
    // register v2 (different definition) via the same factory, switch active; v1 stays resolvable
    const DEF_V2 = { ...KNOWN_RELATIONS_DEF, rule_version: "1.1.0", abstainReason: "below_threshold" as const };
    registerVersion(a.reg, DEF_V2); a.reg.setActive("health:known_relations", "1.1.0");
    expect(a.reg.resolve("health:known_relations", "1.0.0").status).toBe("ok");      // v1 still resolvable (replay)
    expect(policyHash(a.reg)).not.toBe(r1.payload.constraints.policy_version);        // active switch changed policy identity
    const r2 = a.mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:01");
    expect(r2.payload.producer.code_hash).not.toBe(r1.payload.producer.code_hash);
    a.db.close();
  });
});
```

- [ ] **Step 2: Run → FAIL**.
- [ ] **Step 3: Implement producer definition + registration factory (runRule + register + setActive) + manager**

```ts
// src/core/recommendation/producers/known-relations.ts
import type { RuleDefinition } from "../types.js";
export const KNOWN_RELATIONS_DEF: RuleDefinition = {
  rule_id: "health:known_relations", rule_version: "1.0.0", registry_ref: "cbrain.rules:maintenance.known_relations@1.0.0",
  candidateRelation: "reports_to", evidenceRefTemplate: "health:known_relations:{from}:{to}",
  abstainReason: "insufficient_evidence",
  propose: { type: "dry_run", targetTemplate: "health:known_relations:{first_slug}", reason: "存在待确认的 reports_to 候选边，建议人工复核" },
};
```

```ts
// src/core/recommendation/producers/index.ts
import { runRule } from "../rule-runtime.js";
import type { VersionedRuleRegistry } from "../registry.js";
import type { RuleDefinition } from "../types.js";
import { KNOWN_RELATIONS_DEF } from "./known-relations.js";

/** Build a complete RuleRunner from a definition (single source) and register it. */
export function registerVersion(reg: VersionedRuleRegistry, def: RuleDefinition): void {
  const r = runRule(def);
  reg.register({ rule_id: def.rule_id, rule_version: def.rule_version, registry_ref: def.registry_ref, code_hash: r.code_hash, captureInputs: r.captureInputs, decide: r.decide });
}
export function registerMaintenanceProducers(reg: VersionedRuleRegistry): void {
  registerVersion(reg, KNOWN_RELATIONS_DEF);
  reg.setActive(KNOWN_RELATIONS_DEF.rule_id, KNOWN_RELATIONS_DEF.rule_version);
}
```

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
    const active = this.registry.resolveActive(req.rule_id);
    if (active.status !== "ok") throw new Error(`manager: producer ${req.rule_id} has no active version`);
    const slugs = [...new Set(req.slugs)].sort();
    const dependency_manifest: DependencyManifest = { rule_id: req.rule_id, declarations: slugs.map((s) => ({ slug: s, table: "links" as const, as: "reports_to", relation: "reports_to", direction: "outgoing" as const, fields: ["from", "to", "trust_state"], filter: "active" as const })) };
    const decision_inputs = active.captureInputs(new DeclaredProjectionReader(this.db).read(dependency_manifest.declarations));
    const conclusion = active.decide(decision_inputs);
    const evidence_manifest: EvidenceManifestEntry[] = decision_inputs.evidence_refs.map((ref) => ({ source: "health", ref, trust_state: "candidate" as const }));
    const constraints: RecommendationConstraints = { policy_version: policyHash(this.registry), ontology_version: ontologyHash(), schema_version: SCHEMA_VERSION };
    const payload: RecommendationImmutablePayload = { namespace: "maintenance", maintenance_key: `${req.rule_id}:${JSON.stringify(slugs)}`, inputs_hash: "", conclusion, decision_inputs, evidence_manifest, constraints, dependency_manifest, applicability: { audience: "user_only", auto_execute: false, requires_confirmation: { tier: "standard" } }, risks: [], gaps: [], producer: { rule_id: active.rule_id, rule_version: active.rule_version, code_hash: active.code_hash, registry_ref: active.registry_ref } };
    return new RecommendationStore(this.db).createRecord(payload, now);
  }
}
```

- [ ] **Step 4: Run → PASS**.
- [ ] **Step 5: Commit**

```bash
git add src/core/recommendation/producers/ src/core/recommendation/manager.ts tests/core/recommendation/producers/known-relations.test.ts
git commit -m "feat(rec): declarative producer + resolveActive manager (#328)"
```

---

## Task 11: Rollback tests on the PRODUCTION path

**Files:** extend `tests/core/recommendation/record-store.test.ts`

- [ ] **Step 1: Production-path fault injection (own DB, closed)**

```ts
test("createRecord supersede rolls back on partial failure", () => {
  const faultDir = "/tmp/cbrain-test-rec-store-fault"; rmSync(faultDir, { recursive: true, force: true });
  const fdb = new CBrainDB(`${faultDir}/db.sqlite`); const fstore = new RecommendationStore(fdb);
  const created = fstore.createRecord(mkPayload("hA"), "2026-07-12 10:00:00");
  fdb.rawDb.exec("DROP TABLE recommendation_lifecycle_history");
  expect(() => fstore.createRecord(mkPayload("hB"), "2026-07-12 10:00:01")).toThrow();
  expect(fstore.activeCountFor("k1")).toBe(1);
  expect(fstore.getById(created.record_id)?.fingerprint).toBe(created.fingerprint);
  fdb.close(); rmSync(faultDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Store-reload round-trip** (`computeFingerprint` hoisted to imports)

```ts
test("fingerprint survives store → DB → store reload", () => {
  open(); const created = store.createRecord(mkPayload("h1"), "2026-07-12 10:00:00");
  const reloaded = store.getById(created.record_id);
  expect(reloaded?.fingerprint).toBe(created.fingerprint);
  expect(computeFingerprint(reloaded!.payload)).toBe(created.fingerprint);
});
```

- [ ] **Step 3: Run → PASS**.
- [ ] **Step 4: Commit**

```bash
git add tests/core/recommendation/record-store.test.ts
git commit -m "test(rec): production-path rollback + store-reload round-trip (#328)"
```

---

## Task 12: Lint + full check gate (explicit staging, NO git add -A)

- [ ] **Step 1: Lint** — `bun run lint` → PASS.
- [ ] **Step 2: Full test** — `bun test tests/core/recommendation/ tests/storage/migrations/recommendations.test.ts` → all PASS, no leaked DB handles.
- [ ] **Step 3: Full check** — `bun run check` → PASS.
- [ ] **Step 4: docs gate** — `bun run check:docs` → PASS.
- [ ] **Step 5: Final commit ONLY if lint touched files (NEVER `git add -A`)** — stage exact paths; skip entirely (no `--allow-empty`) if nothing changed.

---

## Self-Review (run before handing off)

**Codex plan-rev4 findings (4 HIGH + 2 MED) — all addressed:**
- HIGH 1 (duplicate test/impl mismatch) → Task 4 single `validateDependencyDeclarations()` called in `canonicalPayload` (so `computeFingerprint`/`store.createRecord` throw), `checkIntegrity`, and the reader (Task 7). Tests cover all three entries. ✓
- HIGH 2 (purge-to-upgrade breaks replay) → Task 5 registry allows multiple live runners per rule_id; `register` does not grab/purge active; explicit `setActive` (live target only); `manifest()` encodes `active:rule@version`; `markPurged` refuses the active version; old versions stay exact-resolvable. ✓
- HIGH 3 (code_hash hashes wrapper) → Task 6 typed declarative `RuleDefinition` + generic `runRule`; `code_hash = sha256(canonical(def))` — derived from data, stable across transpile; upgrade fixture via `registerVersion` factory produces complete metadata; test proves def change → code_hash + behavior change. ✓
- HIGH 4 (display ontology injection + freshness no metadata check) → Task 9 `loadAndProjectDisplay` has NO ontology parameter (uses module production `ontologyHash()`; test stub via non-exported `__setDisplayOntologySourceForTest` seam only); Task 7 freshness requires resolved runner `code_hash`+`registry_ref` match record's producer metadata, else `version_invalid`. ✓
- MEDIUM 1 (timestamp format only) → Task 2 `validateTimestamp` does parse + UTC round-trip; rejects impossible dates. ✓
- MEDIUM 2 (stale note/dup headings/handles) → no stale executor notes; no duplicate Task headings (12 tasks, distinct); every test DB closed. ✓

**Spec coverage:** §4/4.3/4.4 → Tasks 2/4/9; §5.1-5.7 → Tasks 8/7/9; §5.5 atomic supersede → Task 8 (+Task 11); §5.6 suppression → Tasks 2/8; §6.1-6.4 → Tasks 1/4; §7.2 → Tasks 5/6/10; §8.1 → Task 4; §8.4 → Tasks 7/9; §9/9.1 → Tasks 2/10; §10 → Task 3; §11 → Task 9. **Deferred:** §8.2 replay UI (Phase 2), §12 derivation graph.

**Placeholder scan:** no TBD/TODO. Task 8 re-uses the rev4 store test/impl verbatim (no rev5 finding against them) — that's a concrete cross-reference, not a placeholder. All `CBrainDB` calls use verified APIs; every test closes its DB.

**Type consistency:** `RuleDefinition`/`runRule`/`definitionCodeHash` consistent across 6/10. `validateDependencyDeclarations` shared across 4/7. `registerVersion`/`registerMaintenanceProducers`/`setActive` consistent across 5/10. `loadAndProjectDisplay` sole display export.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-12-recommendation-contract-phase1.md` (rev5).

**Per the user's instruction: STOP for re-review. Do not execute. Do not push.** Every commit stages explicit paths only.

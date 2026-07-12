# Recommendation Contract — Phase 1 Infrastructure Implementation Plan (rev6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the deterministic Recommendation Record **contract infrastructure** for Phase 1 from `docs/superpowers/specs/2026-07-12-recommendation-contract-design.md` (rev6), plus one reference producer (`health:known_relations`) as the vertical slice.

**Architecture:** `src/core/recommendation/`. Additive migration (DDL + completion marker in ONE transaction; test fault hook proves rollback). Deterministic producers, never auto-execute. Immutable payload hashed per RFC 8785 JCS + prose/identifier layer. Two orthogonal persisted axes (`lifecycle_status` / `freshness_status`), each its OWN store API; terminals cannot regress. Atomic supersede keeps `active count ≤ 1`; rejected suppression via `EXISTS(... IS NULL OR > now)` with default TTL wired in; all timestamps semantically validated. Store is the single persistence entry. **A rule is a typed declarative `RuleDefinition` that is the single source of both behavior and input shape** (dependency template, candidate trust state, evidence source, decision templates); a generic `runRule` executes it; `code_hash = sha256(canonical(BEHAVIOR subset of def))` — implementation identity, excludes rule_id/version/registry_ref (same behavior ⇒ same code_hash across versions). The registry stores definitions (immutable), allows multiple live versions per rule_id (old versions stay exact-resolvable for replay); an explicit `setActive` switches active and enters **`policyManifest`** (active rule@version:code_hash only — adding/cleaning inactive replay stock does NOT change policyHash). Display has exactly one public entry — `loadAndProjectDisplay(recordId, {store, reader, registry, now})` — which hard-depends on the module production `ontologyHash()` (no exported/mutable version source; ontology drift is tested at the freshness layer via explicit `currentConstraints`), forces integrity + freshness (which verifies the resolved runner's `code_hash`+`registry_ref` match the record's producer metadata), gates on active+fresh, and projects through the safety boundary.

**Tech Stack:** Bun, TypeScript strict, `bun:sqlite`, `bun:test`, `node:crypto`. No new runtime deps.

**rev6 changelog:** closes Codex plan-rev5 findings — (H1) duplicate-declaration tests now isolated per entry: a `computeFingerprint` test passes a payload directly; a `checkIntegrity` test builds a record with an arbitrary fingerprint so it reaches `validateDependencyDeclarations`; a reader test reads dup declarations — each actually hits its target. (H2) removed the public ontology test seam; `display.ts` hard-imports `ontologyHash` with NO module-mutable state; ontology mismatch is covered by the freshness focused test (explicit `currentConstraints`); no display-side ontology test. (H3) split `policyManifest()` (active rule@version:code_hash only — used for `policyHash`) from `registryAuditManifest()` (all live/tombstone — audit/replay inventory only); registering or purging INACTIVE versions does not change `policyHash`. (M1) `RuleDefinition` now carries the full `readTemplate` + `candidateTrustState` + `evidenceSource`; the manager generates the dependency manifest and evidence source from the active definition — zero rule-specific hardcoding. (M2) `definitionCodeHash` hashes the BEHAVIOR subset only (excludes rule_id/version/registry_ref); isolated tests prove behavior-change ⇒ hash change and identity-change ⇒ hash UNCHANGED. (M3) the store task is fully self-contained (test + impl inline); no cross-commit copy; no duplicate headings.

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
- `src/core/recommendation/types.ts` — types incl. `DependencyDeclaration`, `RuleDefinition` (with `readTemplate`/`candidateTrustState`/`evidenceSource`).
- `src/core/recommendation/policy.ts` — `validateTimestamp` (semantic), `defaultSuppressedUntil`, `DEFAULT_SUPPRESSION_TTL_SECONDS`, `SUPPRESSION_REOPENED`.
- `src/core/recommendation/integrity.ts` — `validateDependencyDeclarations` (shared), `computeInputsHash`, `computeFingerprint`, `checkIntegrity`.
- `src/core/recommendation/registry.ts` — `VersionedRuleRegistry` (stores definitions; multi-live; `setActive`; `policyManifest` vs `registryAuditManifest`).
- `src/core/recommendation/rule-runtime.ts` — `runRule(def)`, `definitionCodeHash(def)` (behavior subset).
- `src/core/recommendation/projection.ts` — `DeclaredProjectionReader` (strict, fail-closed, shared dup check).
- `src/core/recommendation/freshness.ts` — `recomputeAndPersistFreshness` (verifies exact runner metadata).
- `src/core/recommendation/record-store.ts` — `RecommendationStore` (single entry, split APIs, EXISTS suppression, guarded reopen, time validation).
- `src/core/recommendation/ontology.ts` — `ontologyHash()` (real bundled ontology content).
- `src/core/recommendation/versions.ts` — `policyHash(registry)` (uses `policyManifest`).
- `src/core/recommendation/display.ts` — single exported `loadAndProjectDisplay`; module-private `projectDisplay`; hard-imports `ontologyHash` (NO seam).
- `src/core/recommendation/manager.ts` — `RecommendationManager.buildAndStore` (manifest + evidence source from active definition).
- `src/core/recommendation/producers/known-relations.ts` — `KNOWN_RELATIONS_DEF: RuleDefinition`.
- `src/core/recommendation/producers/index.ts` — `registerMaintenanceProducers`, `registerVersion`.
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

- [ ] **Step 2: Run → FAIL**.
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

## Task 2: Types + policy (semantic time) (spec §4; rev6 MEDIUM 1)

**Files:** Create `src/core/recommendation/types.ts`, `src/core/recommendation/policy.ts`

- [ ] **Step 1: Types — RuleDefinition is the full behavior+input source**

```ts
// src/core/recommendation/types.ts
import type { TrustState } from "../provenance.js";
export type LifecycleStatus = "pending" | "current" | "superseded" | "rejected" | "invalidated";
export type FreshnessStatus = "fresh" | "stale" | "version_invalid";
export type AbstainReason = "insufficient_evidence" | "conflict" | "inactive_evidence_only" | "below_threshold" | "policy_prohibits";
export type HighImpactReason = "write_action" | "open_question_deep_reasoning" | "irreversible_real_world" | "high_value_entity";
export type ConfirmationRequirement = { tier: "standard" } | { tier: "high_impact"; confirm: ("target" | "option" | "constraint")[]; reason: HighImpactReason };
export type ActionType = "review" | "dry_run" | "notify_draft";
export type EvidenceSource = "discovery" | "health" | "fsck" | "graph" | "timeline";
export interface ProposedAction { type: ActionType; target_ref: string; reason: string; rollback_note?: string }
export type RecommendationConclusion = { kind: "propose"; action: ProposedAction; alternatives: ProposedAction[] } | { kind: "abstain"; reason: AbstainReason };
export interface DependencyDeclaration { slug?: string; table: "links" | "pages" | "tags" | "aliases" | "timeline" | "chunks" | "fts" | "lance" | "config"; as: string; relation?: string; direction?: "outgoing" | "incoming"; fields: string[]; filter?: "active" | "all" }
export interface DependencyManifest { rule_id: string; declarations: DependencyDeclaration[] }
export interface EntityProjection { [as: string]: unknown }
export interface DecisionInputs { signals: Record<string, unknown>; inspected_claims?: string[]; entity_snapshot: Record<string, EntityProjection>; evidence_refs: string[] }
export interface EvidenceManifestEntry { source: EvidenceSource; ref: string; trust_state: TrustState }
export interface RecommendationConstraints { policy_version: string; ontology_version: string; schema_version: string }
export interface Applicability { audience: "user_only"; auto_execute: false; requires_confirmation: ConfirmationRequirement }
export interface RecommendationProducer { rule_id: string; rule_version: string; code_hash: string; registry_ref: string }
export interface RecommendationImmutablePayload { namespace: string; maintenance_key: string; inputs_hash: string; conclusion: RecommendationConclusion; decision_inputs: DecisionInputs; evidence_manifest: EvidenceManifestEntry[]; constraints: RecommendationConstraints; dependency_manifest: DependencyManifest; applicability: Applicability; risks: string[]; gaps: string[]; producer: RecommendationProducer }
export interface RecommendationRecord { record_id: string; payload: RecommendationImmutablePayload; fingerprint: string; created_at: string; last_revalidated_at: string; lifecycle_status: LifecycleStatus; freshness_status: FreshnessStatus; suppressed_until: string | null }
export const SCHEMA_VERSION = "rec-v1" as const;

/** Declarative rule — SINGLE source of behavior AND input shape. The manager generates the
 *  dependency manifest and evidence source from `readTemplate`/`evidenceSource`; the generic
 *  runner executes the rest. `definitionCodeHash` hashes the BEHAVIOR subset only. (rev6 M1) */
export interface RuleDefinition {
  rule_id: string; rule_version: string; registry_ref: string;
  /** Declaration template WITHOUT slug (the manager stamps one slug per requested entity). */
  readTemplate: { table: "links"; as: string; relation: string; direction: "outgoing" | "incoming"; fields: string[]; filter: "active" | "all" };
  candidateTrustState: "candidate";
  evidenceSource: EvidenceSource;
  evidenceRefTemplate: string;   // e.g. "health:known_relations:{from}:{to}"
  abstainReason: AbstainReason;
  propose: { type: ActionType; targetTemplate: string; reason: string };
}
```

- [ ] **Step 2: Policy (semantic timestamp)**

```ts
// src/core/recommendation/policy.ts
export const DEFAULT_SUPPRESSION_TTL_SECONDS = 7 * 86400;
export const SUPPRESSION_REOPENED = "1970-01-01 00:00:00";
const TS = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
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
git commit -m "feat(rec): types (full-source RuleDefinition) + policy (semantic time) (#328)"
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

## Task 4: Integrity — shared declaration validator + cross-consistency (spec §6, §4.3, §8.1; rev6 HIGH 1)

**Files:** Create `src/core/recommendation/integrity.ts`; Test `tests/core/recommendation/integrity.test.ts`

- [ ] **Step 1: Write failing test — duplicate DECLARATIONS isolated per entry (fingerprint/integrity/reader)**

```ts
// tests/core/recommendation/integrity.test.ts
import { describe, expect, test } from "bun:test";
import { canonicalDeclaration, validateDependencyDeclarations, computeInputsHash, computeFingerprint, checkIntegrity } from "../../../src/core/recommendation/integrity.js";
import type { DependencyDeclaration, RecommendationImmutablePayload, RecommendationRecord } from "../../../src/core/recommendation/types.js";
import { SCHEMA_VERSION } from "../../../src/core/recommendation/types.js";

const dupDecls: DependencyDeclaration[] = [
  { slug: "a", table: "links", as: "reports_to", relation: "reports_to", fields: ["from", "to"] },
  { slug: "a", table: "links", as: "reports_to", relation: "reports_to", fields: ["from", "to"] },
];

describe("duplicate declarations — isolated per entry (HIGH 1)", () => {
  test("computeFingerprint throws on duplicate (hits fingerprint path)", () => {
    // payload is built WITHOUT calling computeFingerprint; the throw happens inside computeFingerprint
    const p = payloadWith(dupDecls);
    expect(() => computeFingerprint(p)).toThrow(/duplicate.*slug.*as/);
  });
  test("checkIntegrity returns duplicate_declaration (hits integrity path, NOT fingerprint)", () => {
    // build a record MANUALLY with an arbitrary fingerprint so we reach checkIntegrity's validator
    const p = payloadWith(dupDecls);
    const r: RecommendationRecord = { record_id: "r1", payload: p, fingerprint: "arbitrary-not-recomputed", created_at: "2026-07-12 10:00:00", last_revalidated_at: "2026-07-12 10:00:00", lifecycle_status: "pending", freshness_status: "fresh", suppressed_until: null };
    const x = checkIntegrity(r);
    expect(x.ok).toBe(false);
    if (!x.ok) expect(x.code).toBe("duplicate_declaration");
  });
  test("reader throws on duplicate via the SAME validator (covered in Task 7)", () => {
    expect(() => validateDependencyDeclarations(dupDecls)).toThrow(/duplicate.*slug.*as/);
  });
});

describe("canonicalDeclaration omits absent optionals", () => {
  test("global (no slug) hashes cleanly", () => { expect(() => computeFingerprint(payloadWith([{ table: "config", as: "flag", fields: ["value"] }]))).not.toThrow(); expect(JSON.stringify(canonicalDeclaration({ table: "config", as: "flag", fields: ["value"] }))).not.toContain('"slug"'); });
  test("pages (no relation/direction/filter) hashes cleanly", () => { expect(() => computeFingerprint(payloadWith([{ slug: "a", table: "pages", as: "page", fields: ["content_hash"] }]))).not.toThrow(); const s = JSON.stringify(canonicalDeclaration({ slug: "a", table: "pages", as: "page", fields: ["content_hash"] })); expect(s).not.toContain('"relation"'); expect(s).not.toContain('"filter"'); });
  test("links default direction/filter round-trips", () => { const p = payloadWith([{ slug: "a", table: "links", as: "reports_to", relation: "reports_to", fields: ["from", "to"] }]); const fp = computeFingerprint(p); expect(computeFingerprint(JSON.parse(JSON.stringify(p)) as RecommendationImmutablePayload)).toBe(fp); });
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
- [ ] **Step 3: Implement integrity**

```ts
// src/core/recommendation/integrity.ts
import { canonicalJson, normalizeProse, sha256Hex } from "./canonical.js";
import type { DecisionInputs, DependencyDeclaration, RecommendationConclusion, RecommendationImmutablePayload, RecommendationRecord } from "./types.js";

export type IntegrityCode = "inputs_hash_mismatch" | "fingerprint_mismatch" | "cross_undeclared_field" | "cross_evidence_not_projected" | "cross_rule_id_mismatch" | "duplicate_declaration";
export type IntegrityResult = { ok: true } | { ok: false; code: IntegrityCode; message: string };

/** SINGLE declaration validator (rev6 HIGH 1) — shared by canonicalPayload (=> computeFingerprint
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
  validateDependencyDeclarations(p.dependency_manifest.declarations);
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

- [ ] **Step 4: Run → PASS**.
- [ ] **Step 5: Commit**

```bash
git add src/core/recommendation/integrity.ts tests/core/recommendation/integrity.test.ts
git commit -m "feat(rec): integrity (shared declaration validator) (#328)"
```

---

## Task 5: Registry — definitions, multi-live, setActive, split manifests (spec §7.2; rev6 HIGH 2, HIGH 3)

**Files:** Create `src/core/recommendation/registry.ts`; Test `tests/core/recommendation/registry.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/core/recommendation/registry.test.ts
import { describe, expect, test } from "bun:test";
import { VersionedRuleRegistry } from "../../../src/core/recommendation/registry.js";
import { policyHash } from "../../../src/core/recommendation/versions.js";
import type { RuleDefinition } from "../../../src/core/recommendation/types.js";
function def(id: string, ver: string, behavior = "a"): RuleDefinition {
  return { rule_id: id, rule_version: ver, registry_ref: `${id}@${ver}`, readTemplate: { table: "links", as: "reports_to", relation: behavior === "a" ? "reports_to" : "supported_by", direction: "outgoing", fields: ["from", "to", "trust_state"], filter: "active" }, candidateTrustState: "candidate", evidenceSource: "health", evidenceRefTemplate: `${id}:{from}:{to}`, abstainReason: "insufficient_evidence", propose: { type: "dry_run", targetTemplate: `${id}:{first_slug}`, reason: "r" } };
}
describe("VersionedRuleRegistry", () => {
  test("multiple live versions COEXIST; old stays exact-resolvable (replay)", () => {
    const reg = new VersionedRuleRegistry();
    reg.register(def("d", "1.0.0")); reg.register(def("d", "1.1.0"));
    expect(reg.resolve("d", "1.0.0").status).toBe("ok");
    expect(reg.resolve("d", "1.1.0").status).toBe("ok");
  });
  test("register does not grab active; setActive required (live target only)", () => {
    const reg = new VersionedRuleRegistry(); reg.register(def("d", "1.0.0"));
    expect(reg.resolveActive("d").status).toBe("unavailable");
    reg.setActive("d", "1.0.0"); expect(reg.resolveActive("d").status).toBe("ok");
    expect(() => reg.setActive("d", "9.9.9")).toThrow(/unregistered/);
  });
  test("reverse registration order — setActive selects configured version", () => {
    const reg = new VersionedRuleRegistry(); reg.register(def("d", "1.1.0")); reg.register(def("d", "1.0.0")); reg.setActive("d", "1.0.0");
    const a = reg.resolveActive("d"); expect(a.status).toBe("ok"); if (a.status === "ok") expect(a.def.rule_version).toBe("1.0.0");
  });
  test("HIGH 3: registering an INACTIVE version does NOT change policyHash", () => {
    const reg = new VersionedRuleRegistry(); reg.register(def("d", "1.0.0")); reg.setActive("d", "1.0.0");
    const before = policyHash(reg);
    reg.register(def("d", "1.1.0")); // inactive (not set active)
    expect(policyHash(reg)).toBe(before);
  });
  test("setActive changes policyHash", () => {
    const reg = new VersionedRuleRegistry(); reg.register(def("d", "1.0.0")); reg.register(def("d", "1.1.0")); reg.setActive("d", "1.0.0");
    const before = policyHash(reg); reg.setActive("d", "1.1.0");
    expect(policyHash(reg)).not.toBe(before);
  });
  test("markPurged on inactive version does NOT change policyHash; refuses active", () => {
    const reg = new VersionedRuleRegistry(); reg.register(def("d", "1.0.0")); reg.register(def("d", "1.1.0")); reg.setActive("d", "1.1.0");
    const before = policyHash(reg);
    const live0 = reg.resolve("d", "1.0.0"); if (live0.status !== "ok") throw new Error("v1 must be live");
    reg.markPurged("d", "1.0.0", live0.runner.code_hash);
    expect(policyHash(reg)).toBe(before);             // purging inactive didn't affect policy
    expect(reg.resolve("d", "1.0.0").status).toBe("unavailable"); // purged gone
    const liveActive = reg.resolve("d", "1.1.0"); if (liveActive.status !== "ok") throw new Error("v active must be live");
    expect(() => reg.markPurged("d", "1.1.0", liveActive.runner.code_hash)).toThrow(/cannot purge active/);
  });
  test("auditManifest includes all live/tombstone; policyManifest only active", () => {
    const reg = new VersionedRuleRegistry(); reg.register(def("d", "1.0.0")); reg.register(def("d", "1.1.0")); reg.setActive("d", "1.1.0");
    expect(reg.policyManifest().split("\n").length).toBe(1);            // one active line
    expect(reg.registryAuditManifest().split("\n").length).toBeGreaterThanOrEqual(2); // live + active
  });
});
```

- [ ] **Step 2: Run → FAIL**.
- [ ] **Step 3: Implement registry**

```ts
// src/core/recommendation/registry.ts
import { runRule } from "./rule-runtime.js";
import type { DecisionInputs, RecommendationConclusion, RecommendationProducer, RuleDefinition } from "./types.js";

export interface RuleRunner extends RecommendationProducer { captureInputs: (projection: unknown) => DecisionInputs; decide: (di: DecisionInputs) => RecommendationConclusion }
export type ResolveResult = ({ status: "ok"; runner: RuleRunner; def: RuleDefinition }) | { status: "unavailable"; reason: "unknown" | "purged" | "incompatible" };
interface LiveEntry { def: RuleDefinition; runner: RuleRunner; }
interface Tombstone { tombstone: "purged" | "incompatible"; code_hash: string; }

export class VersionedRuleRegistry {
  private live = new Map<string, LiveEntry>();
  private tombstones = new Map<string, Tombstone>();
  private activeVersion = new Map<string, string>();
  private key(id: string, ver: string): string { return `${id}@${ver}`; }

  /** Register an immutable definition. Derives the runner. Does NOT change active. */
  register(def: RuleDefinition): void {
    const k = this.key(def.rule_id, def.rule_version);
    const ex = this.live.get(k);
    if (ex) { if (ex.def === def) return; throw new Error(`registry: ${k} already registered differently`); }
    if (this.tombstones.has(k)) throw new Error(`registry: ${k} is tombstoned`);
    this.live.set(k, { def, runner: runRule(def) });
  }
  /** Switch active to a live version. Enters policy identity. */
  setActive(id: string, ver: string): void {
    const k = this.key(id, ver);
    if (!this.live.has(k)) throw new Error(`registry: setActive target ${k} not a live runner`);
    this.activeVersion.set(id, ver);
  }
  /** Purge a version that is genuinely beyond retention. Refuses the active version. */
  markPurged(id: string, ver: string, codeHash: string): void {
    if (this.activeVersion.get(id) === ver) throw new Error(`registry: cannot purge active ${id}@${ver}; setActive another first`);
    this.live.delete(this.key(id, ver));
    this.tombstones.set(this.key(id, ver), { tombstone: "purged", code_hash: codeHash });
  }
  markIncompatible(id: string, ver: string, codeHash: string): void {
    if (this.activeVersion.get(id) === ver) this.activeVersion.delete(id);
    this.live.delete(this.key(id, ver));
    this.tombstones.set(this.key(id, ver), { tombstone: "incompatible", code_hash: codeHash });
  }
  resolve(id: string, ver: string): ResolveResult {
    const k = this.key(id, ver);
    const e = this.live.get(k); if (e) return { status: "ok", runner: e.runner, def: e.def };
    const t = this.tombstones.get(k); if (t) return { status: "unavailable", reason: t.tombstone };
    return { status: "unavailable", reason: "unknown" };
  }
  resolveActive(id: string): ResolveResult { const v = this.activeVersion.get(id); if (v === undefined) return { status: "unavailable", reason: "unknown" }; return this.resolve(id, v); }
  directory(): RecommendationProducer[] {
    return [...this.activeVersion.entries()].map(([id, ver]) => { const e = this.live.get(this.key(id, ver)); return e ? { rule_id: e.def.rule_id, rule_version: e.def.rule_version, code_hash: e.runner.code_hash, registry_ref: e.def.registry_ref } : null; }).filter((x): x is RecommendationProducer => x !== null);
  }
  /** CURRENT policy identity: active rule@version:code_hash only. Inactive replay stock and
   *  tombstones do NOT appear here, so managing retention cannot invalidate current records. */
  policyManifest(): string {
    return [...this.activeVersion.entries()].map(([id, ver]) => { const e = this.live.get(this.key(id, ver))!; return `active:${id}:${ver}:${e.runner.code_hash}:${e.def.registry_ref}`; }).sort().join("\n");
  }
  /** Audit/replay inventory: all live + tombstones + active. Not used for policyHash. */
  registryAuditManifest(): string {
    const lines: string[] = [];
    for (const [k, e] of this.live) lines.push(`${k}:live:${e.runner.code_hash}`);
    for (const [k, t] of this.tombstones) lines.push(`${k}:${t.tombstone}:${t.code_hash}`);
    for (const [id, ver] of this.activeVersion) lines.push(`active:${id}:${ver}`);
    return lines.sort().join("\n");
  }
}
// (definitionCodeHash is exported from rule-runtime.ts; registry does not re-export it.)
```

- [ ] **Step 4: Run → PASS**.
- [ ] **Step 5: Commit**

```bash
git add src/core/recommendation/registry.ts tests/core/recommendation/registry.test.ts
git commit -m "feat(rec): registry (definitions, multi-live, split manifests) (#328)"
```

---

## Task 6: Rule runtime — generic runner + behavior-only code_hash (rev6 MEDIUM 1, MEDIUM 2)

**Files:** Create `src/core/recommendation/rule-runtime.ts`; Test `tests/core/recommendation/rule-runtime.test.ts`

- [ ] **Step 1: Write failing test — code_hash is BEHAVIOR-only; isolate behavior vs identity**

```ts
// tests/core/recommendation/rule-runtime.test.ts
import { describe, expect, test } from "bun:test";
import { definitionCodeHash, runRule } from "../../../src/core/recommendation/rule-runtime.js";
import type { RuleDefinition } from "../../../src/core/recommendation/types.js";

const DEF: RuleDefinition = { rule_id: "health:known_relations", rule_version: "1.0.0", registry_ref: "cbrain.rules:maintenance.known_relations@1.0.0", readTemplate: { table: "links", as: "reports_to", relation: "reports_to", direction: "outgoing", fields: ["from", "to", "trust_state"], filter: "active" }, candidateTrustState: "candidate", evidenceSource: "health", evidenceRefTemplate: "health:known_relations:{from}:{to}", abstainReason: "insufficient_evidence", propose: { type: "dry_run", targetTemplate: "health:known_relations:{first_slug}", reason: "存在待确认的 reports_to 候选边，建议人工复核" } };

describe("definitionCodeHash (BEHAVIOR subset only, M2)", () => {
  test("M2: changing ONLY a behavior field changes code_hash", () => {
    const behaviorChanged: RuleDefinition = { ...DEF, abstainReason: "below_threshold" }; // same version, different behavior
    expect(definitionCodeHash(behaviorChanged)).not.toBe(definitionCodeHash(DEF));
  });
  test("M2: changing ONLY identity (version/ref) does NOT change code_hash", () => {
    const identityChanged: RuleDefinition = { ...DEF, rule_version: "1.1.0", registry_ref: "cbrain.rules:maintenance.known_relations@1.1.0" }; // same behavior
    expect(definitionCodeHash(identityChanged)).toBe(definitionCodeHash(DEF));
  });
});
describe("runRule (generic, uses def fully — M1)", () => {
  test("code_hash === definitionCodeHash", () => { expect(runRule(DEF).code_hash).toBe(definitionCodeHash(DEF)); });
  test("abstains when no candidate edge", () => { const r = runRule(DEF); expect(r.decide(r.captureInputs({ eA: { reports_to: [] } })).kind).toBe("abstain"); });
  test("proposes + exact evidence ref", () => {
    const r = runRule(DEF);
    const di = r.captureInputs({ "entities/eA": { reports_to: [{ from: "entities/eA", to: "entities/eB", trust_state: "candidate" }] } });
    expect(di.evidence_refs).toEqual(["health:known_relations:entities/eA:entities/eB"]);
    expect(di.evidence_refs[0]).not.toContain("undefined");
    expect(r.decide(di).kind).toBe("propose");
  });
  test("candidate trust state comes from def (not hardcoded)", () => {
    const defTrusted: RuleDefinition = { ...DEF, candidateTrustState: "candidate", readTemplate: { ...DEF.readTemplate, relation: "supported_by", as: "supported_by" } };
    const r = runRule(defTrusted);
    const di = r.captureInputs({ eA: { supported_by: [{ from: "eA", to: "eB", trust_state: "candidate" }] } });
    expect(di.evidence_refs.length).toBe(1); // reads def.readTemplate.as, not hardcoded reports_to
  });
});
```

- [ ] **Step 2: Run → FAIL**.
- [ ] **Step 3: Implement rule runtime**

```ts
// src/core/recommendation/rule-runtime.ts
import { canonicalJson, sha256Hex } from "./canonical.js";
import type { DecisionInputs, RecommendationConclusion, RuleDefinition } from "./types.js";

/** BEHAVIOR-only hash (rev6 M2). Excludes rule_id/rule_version/registry_ref: two versions of the
 *  SAME implementation share a code_hash; a behavior edit changes it. */
export function definitionCodeHash(def: RuleDefinition): string {
  return sha256Hex(canonicalJson({
    readTemplate: def.readTemplate, candidateTrustState: def.candidateTrustState,
    evidenceSource: def.evidenceSource, evidenceRefTemplate: def.evidenceRefTemplate,
    abstainReason: def.abstainReason, propose: def.propose,
  }));
}

/** Generic runner. Reads def.readTemplate.as from the projection, counts edges whose
 *  trust_state === def.candidateTrustState, builds evidence_refs from def.evidenceRefTemplate,
 *  and decides from def.abstainReason / def.propose. No rule-specific hardcoding. */
export function runRule(def: RuleDefinition): { code_hash: string; captureInputs: (projection: unknown) => DecisionInputs; decide: (di: DecisionInputs) => RecommendationConclusion } {
  const code_hash = definitionCodeHash(def);
  const as = def.readTemplate.as;
  const captureInputs = (projection: unknown): DecisionInputs => {
    const p = projection as Record<string, Record<string, { from: string; to: string; trust_state: string }[]>>;
    const slugs = Object.keys(p).sort();
    const candidates: { from: string; to: string; trust_state: string }[] = [];
    const entity_snapshot: Record<string, Record<string, unknown>> = {};
    for (const s of slugs) { const edges = p[s]?.[as] ?? []; entity_snapshot[s] = { [as]: edges }; for (const e of edges) if (e.trust_state === def.candidateTrustState) candidates.push(e); }
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
git commit -m "feat(rec): generic rule runtime (behavior-only code_hash) (#328)"
```

---

## Task 7: DeclaredProjectionReader + freshness (metadata check) (spec §5.3; rev6 HIGH 2)

**Files:** Create `src/core/recommendation/projection.ts`, `src/core/recommendation/freshness.ts`; Test `tests/core/recommendation/freshness.test.ts`

- [ ] **Step 1: Write failing test (from preserved; dup via shared validator; drift; A→B→A; runner unavailable; metadata mismatch; ontology mismatch via currentConstraints)**

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
import type { DependencyManifest, RecommendationImmutablePayload, RecommendationProducer, RuleDefinition } from "../../../src/core/recommendation/types.js";
import { SCHEMA_VERSION } from "../../../src/core/recommendation/types.js";

const DIR = "/tmp/cbrain-test-rec-fresh";
const A = "entities/eA"; const B = "entities/eB";
function seed(db: CBrainDB) { for (const s of [A, B]) db.rawDb.prepare(`INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count, tier) VALUES (?, 'entity', ?, ?, ?, 0, 3)`).run(s, s, `${s}.md`, `h-${s}`); }
function link(db: CBrainDB, from: string, to: string, trust: string) { db.rawDb.prepare(`INSERT INTO links (from_slug, to_slug, relation, trust_state, source_type) VALUES (?, ?, 'reports_to', ?, 'agent')`).run(from, to, trust); }
const decls: DependencyManifest = { rule_id: "health:known_relations", declarations: [A, B].map((s) => ({ slug: s, table: "links" as const, as: "reports_to", relation: "reports_to", direction: "outgoing" as const, fields: ["from", "to", "trust_state"], filter: "active" as const })) };
const DEF: RuleDefinition = { rule_id: "health:known_relations", rule_version: "1.0.0", registry_ref: "cbrain.rules:maintenance.known_relations@1.0.0", readTemplate: { table: "links", as: "reports_to", relation: "reports_to", direction: "outgoing", fields: ["from", "to", "trust_state"], filter: "active" }, candidateTrustState: "candidate", evidenceSource: "health", evidenceRefTemplate: "health:known_relations:{from}:{to}", abstainReason: "insufficient_evidence", propose: { type: "dry_run", targetTemplate: "health:known_relations:{first_slug}", reason: "r" } };
function makeRegistry(): VersionedRuleRegistry { const reg = new VersionedRuleRegistry(); reg.register(DEF); reg.setActive(DEF.rule_id, DEF.rule_version); return reg; }
function payloadFor(db: CBrainDB, reg: VersionedRuleRegistry, producerOverride?: Partial<RecommendationProducer>): RecommendationImmutablePayload {
  const proj = new DeclaredProjectionReader(db).read(decls.declarations); const r = reg.resolveActive(DEF.rule_id); if (r.status !== "ok") throw new Error("no active");
  const di = r.runner.captureInputs(proj);
  const producer: RecommendationProducer = { rule_id: DEF.rule_id, rule_version: DEF.rule_version, code_hash: r.runner.code_hash, registry_ref: DEF.registry_ref, ...producerOverride };
  return { namespace: "maintenance", maintenance_key: `health:known_relations:${JSON.stringify([A, B])}`, inputs_hash: computeInputsHash(di), conclusion: { kind: "propose", action: { type: "dry_run", target_ref: `health:known_relations:${A}`, reason: "r" }, alternatives: [] }, decision_inputs: di, evidence_manifest: di.evidence_refs.map((ref) => ({ source: "health", ref, trust_state: "candidate" as const })), constraints: { policy_version: "p", ontology_version: "o", schema_version: SCHEMA_VERSION }, dependency_manifest: decls, applicability: { audience: "user_only", auto_execute: false, requires_confirmation: { tier: "standard" } }, risks: [], gaps: [], producer };
}
const CC = { policy_version: "p", ontology_version: "o", schema_version: SCHEMA_VERSION };

describe("DeclaredProjectionReader", () => {
  afterEach(() => { rmSync(DIR, { recursive: true, force: true }); });
  test("preserves from/to/trust_state", () => { const db = new CBrainDB(`${DIR}/r1.sqlite`); seed(db); link(db, A, B, "candidate"); const e = (new DeclaredProjectionReader(db).read(decls.declarations)[A] as { reports_to: { from: string; to: string; trust_state: string }[] }).reports_to[0]; expect(e).toEqual({ from: A, to: B, trust_state: "candidate" }); db.close(); });
  test("fail-closed unsupported table", () => { const db = new CBrainDB(`${DIR}/r2.sqlite`); seed(db); expect(() => new DeclaredProjectionReader(db).read([{ slug: A, table: "lance", as: "x", fields: ["y"] }])).toThrow(/unsupported table/); db.close(); });
  test("fail-closed undeclared field", () => { const db = new CBrainDB(`${DIR}/r3.sqlite`); seed(db); link(db, A, B, "candidate"); expect(() => new DeclaredProjectionReader(db).read([{ slug: A, table: "links", as: "reports_to", relation: "reports_to", fields: ["from", "bogus"], filter: "active" }])).toThrow(/not available/); db.close(); });
  test("duplicate (slug,as) via SHARED validator", () => { const db = new CBrainDB(`${DIR}/r4.sqlite`); seed(db); expect(() => new DeclaredProjectionReader(db).read([{ slug: A, table: "links", as: "reports_to", relation: "reports_to", fields: ["from", "to"], filter: "active" }, { slug: A, table: "links", as: "reports_to", relation: "reports_to", fields: ["from", "to"], filter: "active" }])).toThrow(/duplicate.*slug.*as/); db.close(); });
  test("inactive excluded", () => { const db = new CBrainDB(`${DIR}/r5.sqlite`); seed(db); link(db, A, B, "rejected"); expect((new DeclaredProjectionReader(db).read(decls.declarations)[A] as { reports_to: unknown[] }).reports_to.length).toBe(0); db.close(); });
});
describe("recomputeAndPersistFreshness", () => {
  afterEach(() => { rmSync(DIR, { recursive: true, force: true }); });
  test("drift → persisted stale, lifecycle untouched", () => { const db = new CBrainDB(`${DIR}/f1.sqlite`); seed(db); link(db, A, B, "candidate"); const reg = makeRegistry(); const store = new RecommendationStore(db); const c = store.createRecord(payloadFor(db, reg), "2026-07-12 10:00:00"); link(db, B, A, "candidate"); const out = recomputeAndPersistFreshness(store.getById(c.record_id)!, new DeclaredProjectionReader(db), reg, store, CC, "2026-07-12 11:00:00"); expect(out.freshness).toBe("stale"); const re = store.getById(c.record_id); expect(re?.freshness_status).toBe("stale"); expect(re?.lifecycle_status).toBe("pending"); db.close(); });
  test("A→B→A path 1 → fresh recovers", () => { const db = new CBrainDB(`${DIR}/f2.sqlite`); seed(db); link(db, A, B, "candidate"); const reg = makeRegistry(); const store = new RecommendationStore(db); const c = store.createRecord(payloadFor(db, reg), "2026-07-12 10:00:00"); link(db, B, A, "candidate"); recomputeAndPersistFreshness(store.getById(c.record_id)!, new DeclaredProjectionReader(db), reg, store, CC, "2026-07-12 11:00:00"); db.rawDb.prepare("DELETE FROM links WHERE from_slug=? AND to_slug=?").run(B, A); recomputeAndPersistFreshness(store.getById(c.record_id)!, new DeclaredProjectionReader(db), reg, store, CC, "2026-07-12 12:00:00"); expect(store.getById(c.record_id)?.freshness_status).toBe("fresh"); db.close(); });
  test("runner unavailable → version_invalid", () => { const db = new CBrainDB(`${DIR}/f3.sqlite`); seed(db); link(db, A, B, "candidate"); const reg = makeRegistry(); const store = new RecommendationStore(db); const c = store.createRecord(payloadFor(db, reg), "2026-07-12 10:00:00"); expect(recomputeAndPersistFreshness(store.getById(c.record_id)!, new DeclaredProjectionReader(db), new VersionedRuleRegistry(), store, CC, "2026-07-12 11:00:00").freshness).toBe("version_invalid"); db.close(); });
  test("runner code_hash mismatch with record producer → version_invalid", () => { const db = new CBrainDB(`${DIR}/f4.sqlite`); seed(db); link(db, A, B, "candidate"); const reg = makeRegistry(); const store = new RecommendationStore(db); const c = store.createRecord(payloadFor(db, reg, { code_hash: "deadbeef" }), "2026-07-12 10:00:00"); expect(recomputeAndPersistFreshness(store.getById(c.record_id)!, new DeclaredProjectionReader(db), reg, store, CC, "2026-07-12 11:00:00").freshness).toBe("version_invalid"); db.close(); });
  test("HIGH 2: ontology mismatch (via explicit currentConstraints) → version_invalid", () => { const db = new CBrainDB(`${DIR}/f5.sqlite`); seed(db); link(db, A, B, "candidate"); const reg = makeRegistry(); const store = new RecommendationStore(db); const c = store.createRecord(payloadFor(db, reg), "2026-07-12 10:00:00"); expect(recomputeAndPersistFreshness(store.getById(c.record_id)!, new DeclaredProjectionReader(db), reg, store, { policy_version: "p", ontology_version: "changed", schema_version: SCHEMA_VERSION }, "2026-07-12 11:00:00").freshness).toBe("version_invalid"); db.close(); });
});
```

- [ ] **Step 2: Run → FAIL**.
- [ ] **Step 3: Implement projection reader + freshness**

```ts
// src/core/recommendation/projection.ts
import type { CBrainDB } from "../../storage/sqlite.js";
import { validateDependencyDeclarations } from "./integrity.js";
import type { DependencyDeclaration } from "./types.js";
export interface DeclaredProjection { [slug: string]: Record<string, unknown> }
export class DeclaredProjectionReader {
  constructor(private db: CBrainDB) {}
  read(declarations: DependencyDeclaration[]): DeclaredProjection {
    validateDependencyDeclarations(declarations); // shared validator (HIGH 1)
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
  const r = registry.resolve(record.payload.producer.rule_id, record.payload.producer.rule_version);
  if (r.status !== "ok") { store.updateFreshness(record.record_id, "version_invalid", now); return { freshness: "version_invalid" }; }
  if (r.runner.code_hash !== record.payload.producer.code_hash || r.def.registry_ref !== record.payload.producer.registry_ref) { store.updateFreshness(record.record_id, "version_invalid", now); return { freshness: "version_invalid" }; }
  const freshness = computeInputsHash(r.runner.captureInputs(reader.read(record.payload.dependency_manifest.declarations))) === record.payload.inputs_hash ? "fresh" : "stale";
  store.updateFreshness(record.record_id, freshness, now);
  return { freshness };
}
```

- [ ] **Step 4: Run → PASS**.
- [ ] **Step 5: Commit**

```bash
git add src/core/recommendation/projection.ts src/core/recommendation/freshness.ts tests/core/recommendation/freshness.test.ts
git commit -m "feat(rec): fail-closed reader + freshness (metadata + ontology checks) (#328)"
```

---

## Task 8: Record store — single entry, suppression, guarded reopen (self-contained) (spec §5.5, §5.6)

**Files:** Create `src/core/recommendation/record-store.ts`; Test `tests/core/recommendation/record-store.test.ts`

- [ ] **Step 1: Write failing test (full coverage; every DB closed)**

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
  return { namespace: "maintenance", maintenance_key: key, inputs_hash: computeInputsHash(di), conclusion: { kind: "propose", action: { type: "dry_run", target_ref: "health:k:eA", reason: "r" }, alternatives: [] }, decision_inputs: di, evidence_manifest: [{ source: "health", ref: "health:k:eA:eB", trust_state: "candidate" }], constraints: { policy_version: "p", ontology_version: "o", schema_version: SCHEMA_VERSION }, dependency_manifest: { rule_id: "health:k", declarations: [{ slug: "eA", table: "links", as: "reports_to", relation: "reports_to", direction: "outgoing", fields: ["from", "to", "trust_state"], filter: "active" }] }, applicability: { audience: "user_only", auto_execute: false, requires_confirmation: { tier: "standard" } }, risks: [], gaps: [], producer: { rule_id: "health:k", rule_version: "1.0.0", code_hash: codeHash, registry_ref: "r@1.0.0" } };
}
describe("RecommendationStore", () => {
  afterEach(() => { db?.close(); rmSync(DIR, { recursive: true, force: true }); });
  function open() { db = new CBrainDB(`${DIR}/db.sqlite`); store = new RecommendationStore(db); }
  test("createRecord computes fingerprint internally", () => { open(); const p = mkPayload("h1"); const r = store.createRecord(p, "2026-07-12 10:00:00"); expect(r.fingerprint).toBe(computeFingerprint({ ...p, inputs_hash: computeInputsHash(p.decision_inputs) })); expect(r.lifecycle_status).toBe("pending"); expect(r.freshness_status).toBe("fresh"); });
  test("rejects auto_execute !== false", () => { open(); const p = mkPayload("h1"); expect(() => store.createRecord({ ...p, applicability: { ...p.applicability, auto_execute: true as unknown as false } }, "2026-07-12 10:00:00")).toThrow(/auto_execute/); });
  test("same fingerprint idempotent", () => { open(); const p = mkPayload("h1"); const r1 = store.createRecord(p, "2026-07-12 10:00:00"); expect(store.createRecord(p, "2026-07-12 10:00:00").record_id).toBe(r1.record_id); });
  test("different fingerprint same key → atomic supersede; count stays 1", () => { open(); store.createRecord(mkPayload("hA"), "2026-07-12 10:00:00"); store.createRecord(mkPayload("hB"), "2026-07-12 10:00:01"); expect(store.activeCountFor("k1")).toBe(1); });
  test("illegal now rejected", () => { open(); expect(() => store.createRecord(mkPayload("h1"), "2026-13-45 99:99:99")).toThrow(/invalid now/); expect(() => store.createRecord(mkPayload("h1"), "bad")).toThrow(/invalid now/); });
  test("default TTL: reject without suppressedUntil → now+7d", () => { open(); const p = mkPayload("h1"); const r = store.createRecord(p, "2026-07-12 10:00:00"); store.transitionLifecycle(r.record_id, "rejected", "2026-07-12 10:00:01", "declined"); expect(store.getById(r.record_id)?.suppressed_until).toBe("2026-07-19 10:00:01"); expect(() => store.createRecord(p, "2026-07-13 10:00:00")).toThrow(/suppressed/); });
  test("explicit null => permanent", () => { open(); const p = mkPayload("h1"); const r = store.createRecord(p, "2026-07-12 10:00:00"); store.transitionLifecycle(r.record_id, "rejected", "2026-07-12 10:00:01", "declined", null); expect(store.getById(r.record_id)?.suppressed_until).toBeNull(); expect(() => store.createRecord(p, "2099-01-01 00:00:00")).toThrow(/suppressed/); });
  test("illegal suppressedUntil rejected", () => { open(); const p = mkPayload("h1"); const r = store.createRecord(p, "2026-07-12 10:00:00"); expect(() => store.transitionLifecycle(r.record_id, "rejected", "2026-07-12 10:00:01", "x", "bad")).toThrow(/invalid suppressed_until/); });
  test("F17: expired suppression allows re-create", () => { open(); const p = mkPayload("h1"); const r = store.createRecord(p, "2026-07-12 10:00:00"); store.transitionLifecycle(r.record_id, "rejected", "2026-07-12 10:00:01", "declined", "2026-07-12 09:00:00"); expect(() => store.createRecord(p, "2026-07-13 10:00:00")).not.toThrow(); });
  test("real sibling: expired + permanent coexist → EXISTS blocks", () => {
    open(); const p = mkPayload("h1");
    const r1 = store.createRecord(p, "2026-07-12 10:00:00"); store.transitionLifecycle(r1.record_id, "rejected", "2026-07-12 10:00:01", "x", "2026-07-12 09:00:00");
    const r2 = store.createRecord(p, "2026-07-13 10:00:00"); store.transitionLifecycle(r2.record_id, "rejected", "2026-07-13 10:00:01", "x", null);
    expect(() => store.createRecord(p, "2026-07-13 10:00:02")).toThrow(/suppressed/);
  });
  test("clearSuppression only on rejected + existing", () => {
    open(); const p = mkPayload("h1"); const r = store.createRecord(p, "2026-07-12 10:00:00");
    expect(() => store.clearSuppression(r.record_id, "2026-07-12 10:00:01", "reopen")).toThrow(/only allowed on rejected/);
    store.transitionLifecycle(r.record_id, "rejected", "2026-07-12 10:00:02", "x");
    expect(() => store.clearSuppression("nonexistent", "2026-07-12 10:00:03", "reopen")).toThrow(/not found/);
    store.clearSuppression(r.record_id, "2026-07-12 10:00:03", "reopen");
    expect(() => store.createRecord(p, "2026-07-13 10:00:00")).not.toThrow();
  });
  test("transitionLifecycle whitelist: superseded cannot regress", () => { open(); const p = mkPayload("h1"); const r = store.createRecord(p, "2026-07-12 10:00:00"); store.transitionLifecycle(r.record_id, "superseded", "2026-07-12 10:00:01", "t"); expect(() => store.transitionLifecycle(r.record_id, "pending", "2026-07-12 10:00:02", "r")).toThrow(/illegal.*transition/); });
  test("updateFreshness changes ONLY freshness", () => { open(); const p = mkPayload("h1"); const r = store.createRecord(p, "2026-07-12 10:00:00"); store.updateFreshness(r.record_id, "stale", "2026-07-12 10:00:01"); const re = store.getById(r.record_id); expect(re?.freshness_status).toBe("stale"); expect(re?.lifecycle_status).toBe("pending"); });
});
```

- [ ] **Step 2: Run → FAIL**.
- [ ] **Step 3: Implement store (full, self-contained)**

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
  private history(id: string, action: string, fl: string | undefined, tl: string, ff: string | undefined, tf: string | undefined, reason: string | undefined, now: string): void { this.db.prepare("INSERT INTO recommendation_lifecycle_history (record_id, action, from_lifecycle, to_lifecycle, from_freshness, to_freshness, reason, created_at) VALUES ($rid,$action,$fl,$tl,$ff,$tf,$reason,$now)").run({ $rid: id, $action: action, $fl: fl ?? null, $tl: tl, $ff: ff ?? null, $tf: tf ?? null, $reason: reason ?? null, $now: now }); }
}
function fromRow(r: Row): RecommendationRecord { return { record_id: r.record_id, payload: JSON.parse(r.payload) as RecommendationImmutablePayload, fingerprint: r.fingerprint, created_at: r.created_at, last_revalidated_at: r.last_revalidated_at, lifecycle_status: r.lifecycle_status as LifecycleStatus, freshness_status: r.freshness_status as FreshnessStatus, suppressed_until: r.suppressed_until }; }
```

- [ ] **Step 4: Run → PASS**.
- [ ] **Step 5: Commit**

```bash
git add src/core/recommendation/record-store.ts tests/core/recommendation/record-store.test.ts
git commit -m "feat(rec): record store (single entry, suppression, guarded reopen) (#328)"
```

---

## Task 9: Ontology + versions + display (single entry, no seam) (spec §4.4, §5.3, §11.3; rev6 HIGH 2)

**Files:** Create `src/core/recommendation/ontology.ts`, `src/core/recommendation/versions.ts`, `src/core/recommendation/display.ts`; Test `tests/core/recommendation/display.test.ts`

- [ ] **Step 1: Write failing test (real positive; drift→blocked; active identity change→blocked; metadata mismatch→blocked; hostile reason via real record)**

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
import { policyHash } from "../../../src/core/recommendation/versions.js";
import { ontologyHash } from "../../../src/core/recommendation/ontology.js";
import { computeInputsHash } from "../../../src/core/recommendation/integrity.js";
import type { RecommendationImmutablePayload } from "../../../src/core/recommendation/types.js";
import { SCHEMA_VERSION } from "../../../src/core/recommendation/types.js";

const DIR = "/tmp/cbrain-test-rec-display";
const A = "entities/eA"; const B = "entities/eB";
function seed(db: CBrainDB) { for (const s of [A, B]) db.rawDb.prepare(`INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count, tier) VALUES (?, 'entity', ?, ?, ?, 0, 3)`).run(s, s, `${s}.md`, `h-${s}`); }
function link(db: CBrainDB, from: string, to: string, trust: string) { db.rawDb.prepare(`INSERT INTO links (from_slug, to_slug, relation, trust_state, source_type) VALUES (?, ?, 'reports_to', ?, 'agent')`).run(from, to, trust); }
function fresh() { const db = new CBrainDB(`${DIR}/${Math.random().toString(36).slice(2)}.sqlite`); const reg = new VersionedRuleRegistry(); registerMaintenanceProducers(reg); return { db, store: new RecommendationStore(db), reg, mgr: new RecommendationManager(db, reg) }; }

describe("loadAndProjectDisplay", () => {
  afterEach(() => { rmSync(DIR, { recursive: true, force: true }); });
  test("real positive — unchanged deps + production sources → display produced", () => {
    const { db, store, reg, mgr } = fresh(); seed(db); link(db, A, B, "candidate");
    const created = mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:00");
    const out = loadAndProjectDisplay(created.record_id, { store, reader: new DeclaredProjectionReader(db), registry: reg, now: "2026-07-12 10:00:01" }, () => "实体A");
    expect(out.blocked).toBe(false); if (!out.blocked) { expect(out.target_display).toBe("实体A"); expect(out.reason).toContain("候选边"); }
    db.close();
  });
  test("drift after create, no manual refresh → blocked", () => {
    const { db, store, reg, mgr } = fresh(); seed(db); link(db, A, B, "candidate");
    const created = mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:00"); link(db, B, A, "candidate");
    expect(loadAndProjectDisplay(created.record_id, { store, reader: new DeclaredProjectionReader(db), registry: reg, now: "2026-07-12 10:00:01" }, () => "x").blocked).toBe(true);
    db.close();
  });
  test("active identity change (markIncompatible) → blocked", () => {
    const { db, store, reg, mgr } = fresh(); seed(db); link(db, A, B, "candidate");
    const created = mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:00");
    reg.markIncompatible("health:known_relations", "1.0.0", created.payload.producer.code_hash); // active cleared + manifest changes
    expect(loadAndProjectDisplay(created.record_id, { store, reader: new DeclaredProjectionReader(db), registry: reg, now: "2026-07-12 10:00:01" }, () => "x").blocked).toBe(true);
    db.close();
  });
  test("producer metadata mismatch → blocked", () => {
    const { db, store, reg, mgr } = fresh(); seed(db); link(db, A, B, "candidate");
    const created = mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:00");
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

- [ ] **Step 2: Run → FAIL**.
- [ ] **Step 3: Implement ontology + versions + display**

```ts
// src/core/recommendation/ontology.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "./canonical.js";
export function ontologyHash(): string { return sha256Hex(readFileSync(join(import.meta.dir, "../../ontology/ontology.yaml"), "utf8")); }
```

```ts
// src/core/recommendation/versions.ts
import { sha256Hex } from "./canonical.js";
import type { VersionedRuleRegistry } from "./registry.js";
/** CURRENT policy identity — active rule@version:code_hash only (rev6 HIGH 3). */
export function policyHash(registry: VersionedRuleRegistry): string { return sha256Hex(registry.policyManifest()); }
```

```ts
// src/core/recommendation/display.ts
import { assertSafeActionDisplay } from "../safety/display-safety.js";
import { checkIntegrity } from "./integrity.js";
import { recomputeAndPersistFreshness } from "./freshness.js";
import { ontologyHash } from "./ontology.js";
import { policyHash } from "./versions.js";
import { SCHEMA_VERSION } from "./types.js";
import type { DeclaredProjectionReader } from "./projection.js";
import type { RecommendationStore } from "./record-store.js";
import type { VersionedRuleRegistry } from "./registry.js";
import type { RecommendationRecord } from "./types.js";

const FALLBACK_DISPLAY = "一项待确认的记忆";
const FALLBACK_REASON = "有一项建议需要人工复核。";
function safe(text: string, fallback: string): string { try { assertSafeActionDisplay(text); return text; } catch { return fallback; } }
// NOTE: NO module-mutable ontology state, NO exported test seam (rev6 HIGH 2). display imports
// the production ontologyHash directly; ontology drift is covered by the freshness focused test.
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
export function loadAndProjectDisplay(recordId: string, ctx: DisplayCtx, resolveSafeTitle: (slug: string) => string): DisplayOutcome {
  const rec = ctx.store.getById(recordId);
  if (!rec) return { blocked: true, reason: "not_found" };
  if (!checkIntegrity(rec).ok) return { blocked: true, reason: "integrity_failed" };
  const current = { policy_version: policyHash(ctx.registry), ontology_version: ontologyHash(), schema_version: SCHEMA_VERSION };
  recomputeAndPersistFreshness(rec, ctx.reader, ctx.registry, ctx.store, current, ctx.now);
  const reloaded = ctx.store.getById(recordId); if (!reloaded) return { blocked: true, reason: "not_found" };
  const out = projectDisplay(reloaded, resolveSafeTitle);
  return out.blocked ? { blocked: true, reason: "not_active_fresh" } : { blocked: false, target_display: out.target_display, reason: out.reason };
}
```

- [ ] **Step 4: Run → PASS**.
- [ ] **Step 5: Commit**

```bash
git add src/core/recommendation/ontology.ts src/core/recommendation/versions.ts src/core/recommendation/display.ts tests/core/recommendation/display.test.ts
git commit -m "feat(rec): ontology/versions/display (single entry, no seam) (#328)"
```

---

## Task 10: Producer (declarative def) + manager (def-sourced manifest) (spec §4.3, §7.2; rev6 MEDIUM 1)

**Files:** Create `src/core/recommendation/producers/known-relations.ts`, `src/core/recommendation/producers/index.ts`, `src/core/recommendation/manager.ts`; Test `tests/core/recommendation/producers/known-relations.test.ts`

- [ ] **Step 1: Write failing test (exact ref; normalized slugs; def-derived code_hash; upgrade keeps v1 resolvable)**

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
  test("exact evidence ref", () => { const { db, mgr } = fresh(); seed(db); link(db, A, B, "candidate"); const r = mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:00"); expect(r.payload.evidence_manifest[0].ref).toBe(`health:known_relations:${A}:${B}`); expect(r.payload.evidence_manifest[0].source).toBe("health"); db.close(); });
  test("normalized slugs", () => { const a = fresh(); seed(a.db); link(a.db, A, B, "candidate"); const r1 = a.mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [B, A, A] }, "2026-07-12 10:00:00"); const r2 = a.mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:01"); expect(r1.payload.maintenance_key).toBe(r2.payload.maintenance_key); expect(r1.fingerprint).toBe(r2.fingerprint); a.db.close(); });
  test("inactive candidate excluded", () => { const { db, mgr } = fresh(); seed(db); link(db, A, B, "rejected"); expect(mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:00").payload.conclusion.kind).toBe("abstain"); db.close(); });
  test("code_hash === definitionCodeHash; policy_version === policyHash(registry)", () => { const { db, reg, mgr } = fresh(); seed(db); link(db, A, B, "candidate"); const r = mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:00"); expect(r.payload.producer.code_hash).toBe(definitionCodeHash(KNOWN_RELATIONS_DEF)); expect(r.payload.constraints.policy_version).toBe(policyHash(reg)); db.close(); });
  test("upgrade: register v2 (factory) keeps v1 exact-resolvable; setActive(v2) changes policy; v2 record differs", () => {
    const a = fresh(); seed(a.db); link(a.db, A, B, "candidate");
    const r1 = a.mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:00");
    const DEF_V2 = { ...KNOWN_RELATIONS_DEF, rule_version: "1.1.0", registry_ref: "cbrain.rules:maintenance.known_relations@1.1.0", abstainReason: "below_threshold" as const };
    registerVersion(a.reg, DEF_V2); a.reg.setActive("health:known_relations", "1.1.0");
    expect(a.reg.resolve("health:known_relations", "1.0.0").status).toBe("ok");       // v1 still resolvable
    expect(policyHash(a.reg)).not.toBe(r1.payload.constraints.policy_version);
    const r2 = a.mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "2026-07-12 10:00:01");
    expect(r2.payload.producer.code_hash).not.toBe(r1.payload.producer.code_hash);    // behavior differs (abstainReason)
    a.db.close();
  });
});
```

- [ ] **Step 2: Run → FAIL**.
- [ ] **Step 3: Implement producer definition + factory + manager (manifest from def.readTemplate, evidence source from def.evidenceSource)**

```ts
// src/core/recommendation/producers/known-relations.ts
import type { RuleDefinition } from "../types.js";
export const KNOWN_RELATIONS_DEF: RuleDefinition = {
  rule_id: "health:known_relations", rule_version: "1.0.0", registry_ref: "cbrain.rules:maintenance.known_relations@1.0.0",
  readTemplate: { table: "links", as: "reports_to", relation: "reports_to", direction: "outgoing", fields: ["from", "to", "trust_state"], filter: "active" },
  candidateTrustState: "candidate",
  evidenceSource: "health",
  evidenceRefTemplate: "health:known_relations:{from}:{to}",
  abstainReason: "insufficient_evidence",
  propose: { type: "dry_run", targetTemplate: "health:known_relations:{first_slug}", reason: "存在待确认的 reports_to 候选边，建议人工复核" },
};
```

```ts
// src/core/recommendation/producers/index.ts
import type { VersionedRuleRegistry } from "../registry.js";
import type { RuleDefinition } from "../types.js";
import { KNOWN_RELATIONS_DEF } from "./known-relations.js";
export function registerVersion(reg: VersionedRuleRegistry, def: RuleDefinition): void { reg.register(def); }
export function registerMaintenanceProducers(reg: VersionedRuleRegistry): void { reg.register(KNOWN_RELATIONS_DEF); reg.setActive(KNOWN_RELATIONS_DEF.rule_id, KNOWN_RELATIONS_DEF.rule_version); }
```

```ts
// src/core/recommendation/manager.ts
import { DeclaredProjectionReader } from "./projection.js";
import { RecommendationStore } from "./record-store.js";
import { ontologyHash } from "./ontology.js";
import { policyHash } from "./versions.js";
import { SCHEMA_VERSION } from "./types.js";
import type { CBrainDB } from "../../storage/sqlite.js";
import type { VersionedRuleRegistry } from "./registry.js";
import type { DependencyDeclaration, DependencyManifest, EvidenceManifestEntry, RecommendationConstraints, RecommendationImmutablePayload } from "./types.js";

export interface BuildRequest { rule_id: string; slugs: string[] }
export class RecommendationManager {
  constructor(private db: CBrainDB, private registry: VersionedRuleRegistry) {}
  buildAndStore(req: BuildRequest, now: string) {
    const active = this.registry.resolveActive(req.rule_id);
    if (active.status !== "ok") throw new Error(`manager: producer ${req.rule_id} has no active version`);
    const { runner, def } = active;
    const slugs = [...new Set(req.slugs)].sort();
    // dependency manifest GENERATED from def.readTemplate — zero rule-specific hardcoding (rev6 M1)
    const declarations: DependencyDeclaration[] = slugs.map((s) => ({ slug: s, ...def.readTemplate }));
    const dependency_manifest: DependencyManifest = { rule_id: req.rule_id, declarations };
    const decision_inputs = runner.captureInputs(new DeclaredProjectionReader(this.db).read(declarations));
    const conclusion = runner.decide(decision_inputs);
    const evidence_manifest: EvidenceManifestEntry[] = decision_inputs.evidence_refs.map((ref) => ({ source: def.evidenceSource, ref, trust_state: "candidate" }));
    const constraints: RecommendationConstraints = { policy_version: policyHash(this.registry), ontology_version: ontologyHash(), schema_version: SCHEMA_VERSION };
    const payload: RecommendationImmutablePayload = { namespace: "maintenance", maintenance_key: `${req.rule_id}:${JSON.stringify(slugs)}`, inputs_hash: "", conclusion, decision_inputs, evidence_manifest, constraints, dependency_manifest, applicability: { audience: "user_only", auto_execute: false, requires_confirmation: { tier: "standard" } }, risks: [], gaps: [], producer: { rule_id: def.rule_id, rule_version: def.rule_version, code_hash: runner.code_hash, registry_ref: def.registry_ref } };
    return new RecommendationStore(this.db).createRecord(payload, now);
  }
}
```

- [ ] **Step 4: Run → PASS**.
- [ ] **Step 5: Commit**

```bash
git add src/core/recommendation/producers/ src/core/recommendation/manager.ts tests/core/recommendation/producers/known-relations.test.ts
git commit -m "feat(rec): declarative producer + def-sourced manager (#328)"
```

---

## Task 11: Rollback tests on the PRODUCTION path

**Files:** extend `tests/core/recommendation/record-store.test.ts`

- [ ] **Step 1: Production-path fault injection**

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
- [ ] **Step 5: Final commit ONLY if lint touched files (NEVER `git add -A`)** — stage exact paths; skip (no `--allow-empty`) if nothing changed.

---

## Self-Review (run before handing off)

**Codex plan-rev5 findings (3 HIGH + 3 MED) — all addressed:**
- HIGH 1 (duplicate test throws before target) → Task 4 three isolated tests: `computeFingerprint` (payload passed directly), `checkIntegrity` (record built with arbitrary fingerprint → reaches `validateDependencyDeclarations`), reader (Task 7). Each hits its target. ✓
- HIGH 2 (ontology seam public export) → Task 9 `display.ts` has NO mutable state and NO exported seam; hard-imports `ontologyHash`; ontology drift is covered by the freshness focused test (Task 7, explicit `currentConstraints.ontology_version` mismatch). ✓
- HIGH 3 (policy hash includes all replay stock) → Task 5 split `policyManifest()` (active rule@version:code_hash only) from `registryAuditManifest()` (all live/tombstone); `policyHash` uses `policyManifest`; tests prove registering/purging inactive versions does NOT change `policyHash`, while `setActive` does. ✓
- MEDIUM 1 (RuleDefinition incomplete; manager hardcodes) → Task 2 `RuleDefinition` carries `readTemplate`/`candidateTrustState`/`evidenceSource`; Task 10 manager generates the dependency manifest and evidence source from the active definition — no `reports_to`/`health` hardcoding. ✓
- MEDIUM 2 (code-hash test changes version+behavior) → Task 6 `definitionCodeHash` hashes the BEHAVIOR subset only (excludes rule_id/version/registry_ref); isolated tests: behavior-change ⇒ hash changes, identity-change ⇒ hash UNCHANGED. ✓
- MEDIUM 3 (Task 8 not self-contained; dup headings) → Task 8 store is fully inline (test + impl); 12 distinct Task headings; every test closes its DB. ✓

**Spec coverage:** §4/4.3/4.4 → Tasks 2/4/9; §5.1-5.7 → Tasks 8/7/9; §5.5 atomic supersede → Task 8 (+Task 11); §5.6 suppression → Tasks 2/8; §6.1-6.4 → Tasks 1/4; §7.2 → Tasks 5/6/10; §8.1 → Task 4; §8.4 → Tasks 7/9; §9/9.1 → Tasks 2/10; §10 → Task 3; §11 → Task 9. **Deferred:** §8.2 replay UI (Phase 2), §12 derivation graph.

**Placeholder scan:** no TBD/TODO, no illustrative casts/notes. All `CBrainDB` calls use verified APIs; every test closes its DB.

**Type consistency:** `RuleDefinition` (with `readTemplate`/`candidateTrustState`/`evidenceSource`) consistent across 2/5/6/10. `definitionCodeHash` behavior-only consistent across 5/6/10. `policyManifest`/`registryAuditManifest` consistent across 5/9. `validateDependencyDeclarations` shared across 4/7. `loadAndProjectDisplay` sole display export; `projectDisplay` module-private.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-12-recommendation-contract-phase1.md` (rev6).

**Per the user's instruction: STOP for re-review. Do not execute. Do not push.** Every commit stages explicit paths only.

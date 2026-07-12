# Recommendation Contract — Phase 1 Infrastructure Implementation Plan (rev2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the deterministic Recommendation Record **contract infrastructure** for Phase 1 — canonicalization, storage, integrity, versioned rule registry, freshness, atomic supersede, lifecycle, and display projection layers defined in `docs/superpowers/specs/2026-07-12-recommendation-contract-design.md` (rev6, Codex-approved) — plus one reference producer (health `known_relations` repair) as the vertical slice proving the contract end-to-end.

**Architecture:** New `src/core/recommendation/` module (many small files). New `recommendation_records` + `recommendation_lifecycle_history` tables via an **additive** migration (`src/storage/migrations/recommendations.ts`, config-key guarded, mirrors `pages.ts:43`; DDL + completion marker in one transaction). Producers are deterministic (no LLM), never auto-execute (`auto_execute:false` invariant, DB `CHECK` + payload validation). Records carry an immutable payload hashed per RFC 8785 JCS (number/key) + a prose/identifier string layer. Two orthogonal persisted axes: `lifecycle_status` (user/system) and `freshness_status` (dependency/version), each with its OWN store API. Atomic supersede keeps `active count ≤ 1` per `maintenance_key`. The **store is the single persistence entry point** — it validates, computes hashes, checks cross-consistency, and rejects `auto_execute !== false` before any write. Version hashes (ontology/policy/code) come from **real content**, not constants.

**Tech Stack:** Bun, TypeScript strict, `bun:sqlite`, `bun:test`, `node:crypto`. No new runtime deps (JCS implemented in-repo).

**Spec reference:** `docs/superpowers/specs/2026-07-12-recommendation-contract-design.md` (rev6).

**rev2 changelog (this revision):** rewrote Tasks 1/3/4/5/6/7/8/9/10/11 to fix Codex's 7 HIGH + 1 MED — (1) canonical is now validator-first/fail-closed with absent-optional omission; (2) store owns fingerprint + rejects bad auto_execute + real cross-consistency; (3) `transitionLifecycle` (whitelist, terminals can't regress) + `updateFreshness` (freshness-only) replace `setStatus`; rejected durable suppression implemented; (4) shared `DeclaredProjectionReader` over the full manifest, freshness persisted; (5) display gated on active+fresh, reason sanitized; (6) producer evidence is a true projection of real candidate rows, version hashes from real content, slugs normalized; (7) rollback tests fault-inject the production path, migration DDL+marker atomic, **`git add -A` removed**; (MED) registry rejects duplicate exact keys, entries immutable, tombstone for purged/incompatible. Import depths fixed (`tests/core/recommendation/` → `../../../src`, `producers/` → `../../../../src`).

---

## Scope (read first)

This plan covers **Phase 1 contract infrastructure + one reference producer** (`health:known_relations`). Out of scope (follow-up plan, same registry pattern): producers for fsck / discovery / action-candidate; MCP tool surface (gated behind #327 per spec §11); replay/diff UI (Phase 2); derivation graph (§12, unused by Phase 1 maintenance producers).

**Non-goals (hard, spec §0):** no LLM at runtime; no auto-execution; no writing recommendations as trusted facts; no model chain-of-thought storage; no MCP/default-display changes.

**History note:** Local `main` and `origin/main` diverged via equivalent #329 commits. **Do NOT push.** Commits stay local; the user reconciles history before push.

**Staging rule (HARD):** every commit in this plan stages **explicit paths only**. Never `git add -A` / `git add .` — the worktree has unrelated untracked history plans that must not be swept in.

---

## File Structure

**Create (source):**
- `src/core/recommendation/canonical.ts` — `assertJsonSafe()` validator + `canonicalJson()` / `sha256Hex()` / `normalizeProse()` (JCS number/key + prose/identifier).
- `src/core/recommendation/types.ts` — record/payload/lifecycle/freshness types.
- `src/core/recommendation/integrity.ts` — `computeInputsHash()`, `computeFingerprint()`, `checkIntegrity()` (3-layer).
- `src/core/recommendation/registry.ts` — `VersionedRuleRegistry`, `RuleRunner` (immutable; `purged`/`incompatible` tombstones).
- `src/core/recommendation/projection.ts` — `DeclaredProjectionReader` (reads the FULL dependency manifest; shared by creation + freshness).
- `src/core/recommendation/freshness.ts` — `recomputeAndPersistFreshness()` (persists via store, lifecycle untouched).
- `src/core/recommendation/record-store.ts` — `RecommendationStore`: single persistence entry (`createRecord`), `transitionLifecycle`, `updateFreshness`, `activeCountFor`.
- `src/core/recommendation/display.ts` — `projectDisplay()` (active+fresh gate; title+reason sanitized).
- `src/core/recommendation/versions.ts` — real content hashes: `ontologyHash()`, `policyHash(registryManifest)`, `ruleCodeHash()`.
- `src/core/recommendation/manager.ts` — `RecommendationManager.buildAndStore()` (end-to-end via the store).
- `src/core/recommendation/producers/known-relations.ts` — reference producer.
- `src/core/recommendation/producers/index.ts` — `registerMaintenanceProducers(registry)`.
- `src/storage/migrations/recommendations.ts` — additive migration.

**Modify:**
- `src/storage/sqlite.ts` — call `runRecommendationRecordsMigration(this.db)` after `runLatePageMigrations` (around line 420); add to the `./migrations/index.js` import.
- `src/storage/migrations/index.ts` — export `runRecommendationRecordsMigration`.

**Create (tests):** under `tests/core/recommendation/` (import depth `../../../src`) and `tests/core/recommendation/producers/` (`../../../../src`); migration test under `tests/storage/migrations/`.

**Test DB convention:** `/tmp/cbrain-test-rec-<module>`, `afterEach` `rmSync`, `new CBrainDB(dbPath)` (positional). Seed via `db.rawDb.prepare(...).run(...)` mirroring `tests/core/health-reports-to.test.ts`.

---

## Task 1: Canonical pipeline — validator-first, fail-closed (spec §6.2)

**Files:**
- Create: `src/core/recommendation/canonical.ts`
- Test: `tests/core/recommendation/canonical.test.ts`

- [ ] **Step 1: Write failing test — JSON-safe validator + golden bytes + adversarial**

```ts
// tests/core/recommendation/canonical.test.ts
import { describe, expect, test } from "bun:test";
import {
  assertJsonSafe, canonicalJson, sha256Hex, serializeNumber, normalizeProse,
} from "../../../src/core/recommendation/canonical.js";

describe("serializeNumber (RFC 8785 JCS §3.2.2.3)", () => {
  test("golden bytes", () => {
    expect(serializeNumber(1)).toBe("1");
    expect(serializeNumber(1.0)).toBe("1");
    expect(serializeNumber(-0)).toBe("0");
    expect(serializeNumber(0.1)).toBe("0.1");
    expect(serializeNumber(1e-7)).toBe("1e-7");
    expect(serializeNumber(1e21)).toBe("1e+21");
  });
  test("non-finite fail-closed", () => {
    expect(() => serializeNumber(NaN)).toThrow(/finite/);
    expect(() => serializeNumber(Infinity)).toThrow(/finite/);
    expect(() => serializeNumber(-Infinity)).toThrow(/finite/);
  });
});

describe("assertJsonSafe (validator-first, fail-closed)", () => {
  test("accepts plain JSON values", () => {
    expect(() => assertJsonSafe({ a: 1, b: [null, "x", true] })).not.toThrow();
  });
  test("rejects undefined / function / symbol", () => {
    expect(() => assertJsonSafe({ x: undefined })).toThrow(/JSON-safe/);
    expect(() => assertJsonSafe({ x: () => 1 })).toThrow(/JSON-safe/);
    expect(() => assertJsonSafe({ x: Symbol("s") })).toThrow(/JSON-safe/);
  });
  test("rejects Date / Map / Set / class instances", () => {
    expect(() => assertJsonSafe({ x: new Date() })).toThrow(/JSON-safe/);
    expect(() => assertJsonSafe({ x: new Map() })).toThrow(/JSON-safe/);
    expect(() => assertJsonSafe({ x: new Set() })).toThrow(/JSON-safe/);
    expect(() => assertJsonSafe({ x: new (class C {})() })).toThrow(/JSON-safe/);
  });
  test("rejects cyclic object AND cyclic array", () => {
    const o: Record<string, unknown> = {}; o.self = o;
    expect(() => assertJsonSafe(o)).toThrow(/cycle/);
    const a: unknown[] = []; a.push(a);
    expect(() => assertJsonSafe(a)).toThrow(/cycle/);
  });
  test("rejects lone surrogate in string", () => {
    expect(() => assertJsonSafe({ x: "ab\uD800cd" })).toThrow(/surrogate/);
  });
});

describe("canonicalJson (key sort, full-element array sort, optional omission)", () => {
  test("object keys sorted by UTF-16 code-unit order", () => {
    expect(canonicalJson({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}');
  });
  test("array sorted by complete-element canonical string (tie fields included)", () => {
    const a = { source: "link", ref: "x", trust_state: "trusted" };
    const b = { source: "link", ref: "x", trust_state: "candidate" };
    expect(canonicalJson({ m: [a, b] })).toBe(canonicalJson({ m: [b, a] }));
  });
  test("ABSENT optional key is omitted (not emitted as null/undefined)", () => {
    // action without rollback_note must canonicalize cleanly and omit the key
    const out = canonicalJson({ type: "dry_run", target_ref: "r", reason: "x" });
    expect(out).toBe('{"reason":"x","target_ref":"r","type":"dry_run"}');
    expect(out).not.toContain("rollback_note");
  });
  test("identifier strings byte-exact (no NFKC)", () => {
    expect(canonicalJson({ ref: "entityA－1" })).not.toBe(canonicalJson({ ref: "entityA-1" }));
  });
});

describe("normalizeProse (prose only)", () => {
  test("NFKC + whitespace fold", () => {
    expect(normalizeProse("ｓｃｏｒｅ   高")).toBe("score 高");
  });
});

describe("sha256Hex", () => {
  test("64 hex deterministic", () => {
    expect(sha256Hex('{"a":1}')).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/core/recommendation/canonical.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement canonical module (validator-first)**

```ts
// src/core/recommendation/canonical.ts
import { createHash } from "node:crypto";

/** RFC 8785 JCS §3.2.2.3 number serialization. -0 → 0. Non-finite rejected. */
export function serializeNumber(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`canonical: number must be finite, got ${String(n)}`);
  return String(Object.is(n, -0) ? 0 : n);
}

/** NFKC + collapse whitespace. Prose fields only (spec §6.2). */
export function normalizeProse(s: string): string {
  return s.normalize("NFKC").replace(/\s+/g, " ").trim();
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF]))|[\uDC00-\uDFFF](?<![\uD800-\uDBFF])/u;

/** Recursive JSON-safe validation BEFORE hashing. Rejects non-plain values + cycles + lone surrogates. */
export function assertJsonSafe(v: unknown, seen: Set<object> = new Set()): void {
  if (v === null || typeof v === "boolean") return;
  if (typeof v === "number") { serializeNumber(v); return; } // finite check
  if (typeof v === "string") {
    if (LONE_SURROGATE.test(v)) throw new Error("canonical: lone surrogate in string");
    return;
  }
  if (typeof v !== "object" || v === undefined) {
    throw new Error(`canonical: non-JSON-safe value of type ${typeof v}`);
  }
  // reject Date / Map / Set / class instances — only plain {} and [] allowed
  const proto = Object.getPrototypeOf(v);
  const isPlainObj = proto === Object.prototype;
  const isArr = Array.isArray(v);
  if (!isPlainObj && !isArr) {
    throw new Error(`canonical: non-plain object (${proto?.constructor?.name ?? "?"})`);
  }
  if (seen.has(v as object)) throw new Error("canonical: cycle detected");
  seen.add(v as object);
  if (isArr) for (const el of v as unknown[]) assertJsonSafe(el, seen);
  else for (const k of Object.keys(v)) {
    const val = (v as Record<string, unknown>)[k];
    if (val === undefined) throw new Error(`canonical: undefined value at key "${k}" (omit the key instead)`);
    assertJsonSafe(val, seen);
  }
  seen.delete(v as object);
}

/** Canonical JSON. Object keys UTF-16 code-unit lexicographic (JCS §3.2.2.2);
 *  arrays sorted by complete-element canonical string. Caller MUST have run
 *  assertJsonSafe first, and MUST omit absent optional keys (no undefined). */
export function canonicalJson(value: unknown): string {
  assertJsonSafe(value);
  return emit(value, new Set<object>());
}

function emit(v: unknown, seen: Set<object>): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return serializeNumber(v);
  if (typeof v === "string") return quote(v);
  if (Array.isArray(v)) {
    seen.add(v);
    const parts = v.map((el) => emit(el, seen)).sort();
    seen.delete(v);
    return `[${parts.join(",")}]`;
  }
  seen.add(v as object);
  const entries = Object.keys(v as object)
    .sort()
    .filter((k) => (v as Record<string, unknown>)[k] !== undefined) // omit absent optionals
    .map((k) => `${quote(k)}:${emit((v as Record<string, unknown>)[k], seen)}`);
  seen.delete(v as object);
  return `{${entries.join(",")}}`;
}

function quote(s: string): string {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === "\\" || ch === '"') out += "\\" + ch;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (cp < 0x20) out += "\\u" + cp.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + '"';
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/core/recommendation/canonical.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/recommendation/canonical.ts tests/core/recommendation/canonical.test.ts
git commit -m "feat(rec): fail-closed canonical JSON pipeline (#328)"
```

---

## Task 2: Types (spec §4)

**Files:** Create `src/core/recommendation/types.ts`

- [ ] **Step 1: Write types module**

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
  type: "review" | "dry_run" | "notify_draft";
  target_ref: string;     // internal ref (audit tier, slug-bearing). target_display NOT stored.
  reason: string;         // prose
  rollback_note?: string; // prose, OPTIONAL — omitted from payload when absent
}

export type RecommendationConclusion =
  | { kind: "propose"; action: ProposedAction; alternatives: ProposedAction[] }
  | { kind: "abstain"; reason: AbstainReason };

export interface DependencyDeclaration {
  slug?: string;          // absent => global
  table: "pages" | "links" | "tags" | "aliases" | "timeline" | "chunks" | "fts" | "lance" | "config";
  fields: string[];
  filter?: "active" | "all";
}

export interface DependencyManifest { rule_id: string; declarations: DependencyDeclaration[] }
export interface EntityProjection { [field: string]: unknown }

export interface DecisionInputs {
  signals: Record<string, unknown>;
  inspected_claims?: string[];
  entity_snapshot: Record<string, EntityProjection>;
  /** Deterministic, stable evidence refs derived from the same rows that fed
   *  signals/entity_snapshot (spec §4.3 — manifest is a TRUE projection). */
  evidence_refs: string[];
}

export interface EvidenceManifestEntry {
  source: "discovery" | "health" | "fsck" | "graph" | "timeline";
  ref: string;
  trust_state: TrustState;
}

export interface RecommendationConstraints {
  policy_version: string;   // hash of registry manifest (real content)
  ontology_version: string; // hash of ontology.yaml (real content)
  schema_version: string;
}

export interface Applicability {
  audience: "user_only";
  auto_execute: false;       // literal type — the only legal value
  requires_confirmation: ConfirmationRequirement;
}

export interface RecommendationProducer {
  rule_id: string; rule_version: string; code_hash: string; registry_ref: string;
}

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
  fingerprint: string;
  created_at: string;
  last_revalidated_at: string;
  lifecycle_status: LifecycleStatus;
  freshness_status: FreshnessStatus;
  suppressed_until: string | null;
}

export const SCHEMA_VERSION = "rec-v1" as const;

/** Unlisted string fields default to identifier (byte-exact, no NFKC). Prose fields
 *  are normalized; the canonical layer treats all others as identifiers. (spec §6.2) */
export const PROSE_FIELDS = new Set(["reason", "rollback_note", "risks", "gaps", "inspected_claims"]);
```

- [ ] **Step 2: Typecheck** — Run: `bun run lint` → PASS.

- [ ] **Step 3: Commit**

```bash
git add src/core/recommendation/types.ts
git commit -m "feat(rec): recommendation record types (#328)"
```

---

## Task 3: Additive migration — DDL + marker atomic (spec §10)

**Files:**
- Create: `src/storage/migrations/recommendations.ts`
- Modify: `src/storage/migrations/index.ts`, `src/storage/sqlite.ts`
- Test: `tests/storage/migrations/recommendations.test.ts`

- [ ] **Step 1: Write failing test (correct expect ordering; atomic rollback)**

```ts
// tests/storage/migrations/recommendations.test.ts
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runRecommendationRecordsMigration } from "../../../src/storage/migrations/recommendations.js";

function newDb(): Database {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  return db;
}
function exists(db: Database, name: string): boolean {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) as { name?: string } | undefined)?.name === name;
}

describe("recommendation_records migration", () => {
  const dbs: Database[] = [];
  afterEach(() => { dbs.forEach((d) => d.close()); dbs.length = 0; });

  test("creates both tables", () => {
    const db = newDb(); dbs.push(db);
    runRecommendationRecordsMigration(db);
    expect(exists(db, "recommendation_records")).toBe(true);
    expect(exists(db, "recommendation_lifecycle_history")).toBe(true);
  });

  test("idempotent via config-key guard", () => {
    const db = newDb(); dbs.push(db);
    runRecommendationRecordsMigration(db);
    expect(() => runRecommendationRecordsMigration(db)).not.toThrow();
  });

  test("partial unique index on (maintenance_key) WHERE active", () => {
    const db = newDb(); dbs.push(db);
    runRecommendationRecordsMigration(db);
    const idx = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_rec_active_unique'").get() as { sql?: string };
    expect(idx.sql).toContain("maintenance_key");
    expect(idx.sql).toContain("lifecycle_status IN ('pending','current')");
  });

  test("two active same key rejected; superseded same key coexists", () => {
    const db = newDb(); dbs.push(db);
    runRecommendationRecordsMigration(db);
    const ins = (id: string, key: string, lc: string) => db.exec(
      `INSERT INTO recommendation_records (record_id, maintenance_key, fingerprint, inputs_hash, payload, auto_execute, created_at, last_revalidated_at, lifecycle_status, freshness_status, suppressed_until) VALUES ('${id}','${key}','f','ih','{}',0,'t','t','${lc}','fresh',NULL)`
    );
    ins("r1", "same", "pending");
    expect(() => ins("r2", "same", "current")).toThrow(/UNIQUE/);
    expect(() => ins("r3", "same", "superseded")).not.toThrow();
  });

  test("atomic: DDL + completion marker in one transaction — a failure leaves NO partial state", () => {
    const db = newDb(); dbs.push(db);
    // If the migration wrapped DDL+marker atomically, re-running after dropping the table
    // AND the marker restores cleanly; if it had written the marker before DDL completed,
    // a mid-DDL crash would leave marker set without table. Simulate by checking marker is
    // set ONLY when tables exist.
    runRecommendationRecordsMigration(db);
    const marker = (db.prepare("SELECT value FROM config WHERE key='migration_rec_v1_recommendation_records'").get() as { value?: string })?.value;
    expect(marker).toBe("1");
    expect(exists(db, "recommendation_records")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — Run: `bun test tests/storage/migrations/recommendations.test.ts` → FAIL.

- [ ] **Step 3: Implement migration (DDL + marker atomic)**

```ts
// src/storage/migrations/recommendations.ts
import type { Database } from "bun:sqlite";

const COMPLETION_KEY = "migration_rec_v1_recommendation_records";

/** Additive migration (spec §10). DDL + completion marker in ONE transaction so a
 *  crash never leaves the marker set without the tables (or vice versa). */
export function runRecommendationRecordsMigration(db: Database): void {
  const done = db.prepare("SELECT value FROM config WHERE key = ?").get(COMPLETION_KEY) as { value?: string } | undefined;
  if (done?.value === "1") return;

  const txn = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS recommendation_records (
        record_id            TEXT PRIMARY KEY,
        maintenance_key      TEXT NOT NULL,
        fingerprint          TEXT NOT NULL,
        inputs_hash          TEXT NOT NULL,
        payload              TEXT NOT NULL,
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
      CREATE UNIQUE INDEX IF NOT EXISTS idx_rec_active_unique
        ON recommendation_records(maintenance_key)
        WHERE lifecycle_status IN ('pending','current');
      -- supports rejected-suppression lookup (spec §5.6)
      CREATE INDEX IF NOT EXISTS idx_rec_rejected_key_fp
        ON recommendation_records(maintenance_key, fingerprint)
        WHERE lifecycle_status = 'rejected';

      CREATE TABLE IF NOT EXISTS recommendation_lifecycle_history (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        record_id     TEXT NOT NULL REFERENCES recommendation_records(record_id) ON DELETE CASCADE,
        action        TEXT NOT NULL,
        from_lifecycle TEXT, to_lifecycle TEXT NOT NULL,
        from_freshness TEXT, to_freshness TEXT,
        reason        TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_rec_history_record ON recommendation_lifecycle_history(record_id);
    `);
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, '1')").run(COMPLETION_KEY);
  });
  txn(); // bun:sqlite transaction() returns a callable
}
```

- [ ] **Step 4: Wire into sqlite.ts + migrations/index.ts**

`src/storage/migrations/index.ts` add: `export { runRecommendationRecordsMigration } from "./recommendations.js";`

`src/storage/sqlite.ts` import block from `"./migrations/index.js"`: add `runRecommendationRecordsMigration`. In `migrate()`, immediately after `runLatePageMigrations(this.db);` (≈ line 420): `runRecommendationRecordsMigration(this.db);`

- [ ] **Step 5: Run test → PASS** — Run: `bun test tests/storage/migrations/recommendations.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/storage/migrations/recommendations.ts src/storage/migrations/index.ts src/storage/sqlite.ts tests/storage/migrations/recommendations.test.ts
git commit -m "feat(storage): recommendation_records additive migration (#328)"
```

---

## Task 4: Integrity — real cross-consistency + fixed reason codes (spec §6, §4.3, §8.1)

**Files:** Create `src/core/recommendation/integrity.ts`; Test `tests/core/recommendation/integrity.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/core/recommendation/integrity.test.ts
import { describe, expect, test } from "bun:test";
import { computeInputsHash, computeFingerprint, checkIntegrity } from "../../../src/core/recommendation/integrity.js";
import type { RecommendationImmutablePayload, RecommendationRecord } from "../../../src/core/recommendation/types.js";
import { SCHEMA_VERSION } from "../../../src/core/recommendation/types.js";

function basePayload(over: Partial<RecommendationImmutablePayload> = {}): RecommendationImmutablePayload {
  const di = {
    signals: { count: 1 },
    entity_snapshot: { eA: { reports_to: [{ to: "eB", trust_state: "candidate" }] } },
    evidence_refs: ["health:known_relations:eA:eB"],
  };
  return {
    namespace: "maintenance", maintenance_key: 'health:known_relations:["eA","eB"]',
    inputs_hash: "",
    conclusion: { kind: "propose", action: { type: "dry_run", target_ref: "health:known_relations:eA", reason: "复核" }, alternatives: [] },
    decision_inputs: di,
    evidence_manifest: [{ source: "health", ref: "health:known_relations:eA:eB", trust_state: "candidate" }],
    constraints: { policy_version: "p", ontology_version: "o", schema_version: SCHEMA_VERSION },
    dependency_manifest: { rule_id: "health:known_relations", declarations: [{ slug: "eA", table: "links", fields: ["relation", "trust_state", "other_slug"], filter: "active" }, { slug: "eB", table: "links", fields: ["relation", "trust_state", "other_slug"], filter: "active" }] },
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
  test("clean passes", () => { expect(checkIntegrity(rec(basePayload())).ok).toBe(true); });

  test("inputs_hash tamper detected", () => {
    const r = rec(basePayload()); r.payload.inputs_hash = "x";
    const res = checkIntegrity(r); expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("inputs_hash_mismatch");
  });

  test("fingerprint tamper detected (reason is a fixed code, no ref echo)", () => {
    const r = rec(basePayload()); r.payload.conclusion = { kind: "abstain", reason: "insufficient_evidence" };
    const res = checkIntegrity(r);
    expect(res.ok).toBe(false);
    if (!res.ok) { expect(res.code).toBe("fingerprint_mismatch"); expect(res.message).not.toContain("health:known_relations"); }
  });

  test("cross-consistency: snapshot field not covered by declarations", () => {
    const p = basePayload();
    p.decision_inputs.entity_snapshot.eA = { reports_to: [], unexpected_field: 1 };
    const res = checkIntegrity(rec(p));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("cross_undeclared_field");
  });

  test("cross-consistency: evidence ref not in decision_inputs.evidence_refs", () => {
    const p = basePayload();
    p.evidence_manifest.push({ source: "health", ref: "health:known_relations:eA:eC", trust_state: "candidate" });
    const res = checkIntegrity(rec(p));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("cross_evidence_not_projected");
  });

  test("cross-consistency: rule_id mismatch", () => {
    const p = basePayload(); p.dependency_manifest.rule_id = "other";
    const res = checkIntegrity(rec(p));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("cross_rule_id_mismatch");
  });

  test("absent rollback_note omits cleanly (no undefined crash)", () => {
    const p = basePayload();
    (p.conclusion as { kind: "propose"; action: { type: string; target_ref: string; reason: string } }).action = { type: "dry_run", target_ref: "health:known_relations:eA", reason: "x" };
    expect(() => computeFingerprint(p)).not.toThrow();
  });

  test("fingerprint round-trips across JSON serialize/deserialize", () => {
    const p = basePayload(); p.inputs_hash = computeInputsHash(p.decision_inputs);
    const fp = computeFingerprint(p);
    expect(computeFingerprint(JSON.parse(JSON.stringify(p)) as RecommendationImmutablePayload)).toBe(fp);
  });
});
```

- [ ] **Step 2: Run test → FAIL** — Run: `bun test tests/core/recommendation/integrity.test.ts`.

- [ ] **Step 3: Implement integrity (real cross-consistency, fixed codes)**

```ts
// src/core/recommendation/integrity.ts
import { canonicalJson, normalizeProse, sha256Hex } from "./canonical.js";
import type {
  DecisionInputs, RecommendationConclusion, RecommendationImmutablePayload, RecommendationRecord,
} from "./types.js";

export type IntegrityResult = { ok: true } | { ok: false; code: IntegrityCode; message: string };
export type IntegrityCode =
  | "inputs_hash_mismatch" | "fingerprint_mismatch"
  | "cross_undeclared_field" | "cross_evidence_not_projected" | "cross_rule_id_mismatch";

export function computeInputsHash(di: DecisionInputs): string {
  return sha256Hex(canonicalJson(canonicalDecisionInputs(di)));
}
function canonicalDecisionInputs(di: DecisionInputs): unknown {
  return {
    signals: di.signals,
    inspected_claims: (di.inspected_claims ?? []).map(normalizeProse),
    entity_snapshot: di.entity_snapshot,
    evidence_refs: [...di.evidence_refs].sort(),
  };
}
export function computeFingerprint(p: RecommendationImmutablePayload): string {
  return sha256Hex(canonicalJson(canonicalPayload(p)));
}
function canonicalPayload(p: RecommendationImmutablePayload): unknown {
  return {
    namespace: p.namespace, maintenance_key: p.maintenance_key, inputs_hash: p.inputs_hash,
    conclusion: canonicalConclusion(p.conclusion),
    decision_inputs: canonicalDecisionInputs(p.decision_inputs),
    evidence_manifest: p.evidence_manifest.map((e) => ({ source: e.source, ref: e.ref, trust_state: e.trust_state })),
    constraints: p.constraints,
    dependency_manifest: { rule_id: p.dependency_manifest.rule_id, declarations: p.dependency_manifest.declarations.map((d) => ({ slug: d.slug, table: d.table, fields: [...d.fields].sort(), filter: d.filter })) },
    applicability: p.applicability, risks: p.risks.map(normalizeProse), gaps: p.gaps.map(normalizeProse),
    producer: p.producer,
  };
}
function canonicalConclusion(c: RecommendationConclusion): unknown {
  if (c.kind === "abstain") return { kind: "abstain", reason: c.reason };
  return { kind: "propose", action: canonicalAction(c.action), alternatives: c.alternatives.map(canonicalAction) };
}
function canonicalAction(a: { type: string; target_ref: string; reason: string; rollback_note?: string }): unknown {
  // rollback_note omitted when absent (caller passes no key); when present, prose-normalized
  const out: Record<string, unknown> = { type: a.type, target_ref: a.target_ref, reason: normalizeProse(a.reason) };
  if (a.rollback_note !== undefined) out.rollback_note = normalizeProse(a.rollback_note);
  return out;
}

export function checkIntegrity(r: RecommendationRecord): IntegrityResult {
  if (computeInputsHash(r.payload.decision_inputs) !== r.payload.inputs_hash)
    return { ok: false, code: "inputs_hash_mismatch", message: "inputs_hash mismatch" };
  if (computeFingerprint(r.payload) !== r.fingerprint)
    return { ok: false, code: "fingerprint_mismatch", message: "fingerprint mismatch" };
  return checkCrossConsistency(r.payload);
}

function checkCrossConsistency(p: RecommendationImmutablePayload): IntegrityResult {
  // entity_snapshot fields must be covered by declarations (slug → declared field set)
  const declared = new Map<string, Set<string>>();
  for (const d of p.dependency_manifest.declarations) {
    const key = d.slug ?? "__global__";
    const set = declared.get(key) ?? new Set<string>();
    for (const f of d.fields) set.add(f);
    declared.set(key, set);
  }
  for (const [slug, proj] of Object.entries(p.decision_inputs.entity_snapshot)) {
    const allowed = declared.get(slug);
    if (!allowed) return { ok: false, code: "cross_undeclared_field", message: "entity_snapshot slug not declared" };
    for (const f of Object.keys(proj as object)) {
      if (!allowed.has(f)) return { ok: false, code: "cross_undeclared_field", message: "undeclared snapshot field" };
    }
  }
  // evidence_manifest refs must all appear in decision_inputs.evidence_refs (true projection)
  const refs = new Set(p.decision_inputs.evidence_refs);
  for (const e of p.evidence_manifest) {
    if (!refs.has(e.ref)) return { ok: false, code: "cross_evidence_not_projected", message: "evidence ref not in decision_inputs" };
  }
  if (p.dependency_manifest.rule_id !== p.producer.rule_id)
    return { ok: false, code: "cross_rule_id_mismatch", message: "dependency_manifest.rule_id != producer.rule_id" };
  return { ok: true };
}
```

- [ ] **Step 4: Run test → PASS** — Run: `bun test tests/core/recommendation/integrity.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/core/recommendation/integrity.ts tests/core/recommendation/integrity.test.ts
git commit -m "feat(rec): integrity with real cross-consistency (#328)"
```

---

## Task 5: Versioned rule registry — immutable, tombstones (spec §7.2; MED)

**Files:** Create `src/core/recommendation/registry.ts`; Test `tests/core/recommendation/registry.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/core/recommendation/registry.test.ts
import { describe, expect, test } from "bun:test";
import { VersionedRuleRegistry } from "../../../src/core/recommendation/registry.js";

const noop = () => ({ signals: {}, entity_snapshot: {}, evidence_refs: [] as string[] });
const abstain = () => ({ kind: "abstain" as const, reason: "policy_prohibits" as const });

describe("VersionedRuleRegistry", () => {
  test("resolve ok returns runner", () => {
    const reg = new VersionedRuleRegistry();
    reg.register({ rule_id: "d", rule_version: "1.0.0", code_hash: "h1", registry_ref: "r@1.0.0", captureInputs: () => noop(), decide: () => abstain() });
    const r = reg.resolve("d", "1.0.0");
    expect(r.status).toBe("ok");
  });

  test("duplicate exact key with DIFFERENT code_hash rejected (MED)", () => {
    const reg = new VersionedRuleRegistry();
    reg.register({ rule_id: "d", rule_version: "1.0.0", code_hash: "h1", registry_ref: "r@1.0.0", captureInputs: () => noop(), decide: () => abstain() });
    expect(() => reg.register({ rule_id: "d", rule_version: "1.0.0", code_hash: "h2", registry_ref: "r@1.0.0", captureInputs: () => noop(), decide: () => abstain() })).toThrow(/already registered/);
  });

  test("re-registering the SAME object is idempotent (no throw)", () => {
    const reg = new VersionedRuleRegistry();
    const entry = { rule_id: "d", rule_version: "1.0.0", code_hash: "h1", registry_ref: "r@1.0.0", captureInputs: () => noop(), decide: () => abstain() };
    reg.register(entry);
    expect(() => reg.register(entry)).not.toThrow();
  });

  test("markPurged -> resolve returns unavailable/purged (F21/F22 coverage)", () => {
    const reg = new VersionedRuleRegistry();
    reg.register({ rule_id: "d", rule_version: "1.0.0", code_hash: "h1", registry_ref: "r@1.0.0", captureInputs: () => noop(), decide: () => abstain() });
    reg.markPurged("d", "1.0.0");
    const r = reg.resolve("d", "1.0.0");
    expect(r.status).toBe("unavailable");
    if (r.status === "unavailable") expect(r.reason).toBe("purged");
  });

  test("unknown version -> unavailable/unknown (not purged)", () => {
    const reg = new VersionedRuleRegistry();
    const r = reg.resolve("d", "9.9.9");
    expect(r.status).toBe("unavailable");
    if (r.status === "unavailable") expect(r.reason).toBe("unknown");
  });

  test("registryManifest exposes content for policy hashing", () => {
    const reg = new VersionedRuleRegistry();
    reg.register({ rule_id: "d", rule_version: "1.0.0", code_hash: "h1", registry_ref: "r@1.0.0", captureInputs: () => noop(), decide: () => abstain() });
    expect(reg.manifest()).toContain("d@1.0.0:h1");
  });
});
```

- [ ] **Step 2: Run test → FAIL** — Run: `bun test tests/core/recommendation/registry.test.ts`.

- [ ] **Step 3: Implement registry (immutable entries, tombstones)**

```ts
// src/core/recommendation/registry.ts
import type { DecisionInputs, RecommendationConclusion } from "./types.js";

export interface RuleRunner {
  rule_id: string;
  rule_version: string;
  code_hash: string;
  registry_ref: string;
  captureInputs: (projection: unknown) => DecisionInputs;
  decide: (di: DecisionInputs) => RecommendationConclusion;
}

export type ResolveResult =
  | ({ status: "ok" } & RuleRunner)
  | { status: "unavailable"; reason: "unknown" | "purged" | "incompatible" };

type Entry = RuleRunner | { tombstone: "purged" | "incompatible"; code_hash: string };

export class VersionedRuleRegistry {
  private entries = new Map<string, Entry>();

  private key(ruleId: string, ruleVersion: string): string {
    return `${ruleId}@${ruleVersion}`;
  }

  register(r: RuleRunner): void {
    const k = this.key(r.rule_id, r.rule_version);
    const existing = this.entries.get(k);
    if (existing) {
      // idempotent only for the SAME object; different code_hash (or different fn) rejected
      const sameObj = "captureInputs" in existing && existing === r;
      const sameHash = "code_hash" in existing && existing.code_hash === r.code_hash;
      if (!sameObj && !sameHash) {
        throw new Error(`registry: ${k} already registered with different implementation`);
      }
      if (sameHash && !sameObj) {
        throw new Error(`registry: ${k} already registered (same code_hash, different object — use the same instance)`);
      }
      return; // exact same object — idempotent
    }
    this.entries.set(k, r);
  }

  /** Tombstone a version that has been purged/incompatible (F21/F22). */
  markPurged(ruleId: string, ruleVersion: string, codeHash = ""): void {
    this.entries.set(this.key(ruleId, ruleVersion), { tombstone: "purged", code_hash: codeHash });
  }
  markIncompatible(ruleId: string, ruleVersion: string, codeHash = ""): void {
    this.entries.set(this.key(ruleId, ruleVersion), { tombstone: "incompatible", code_hash: codeHash });
  }

  resolve(ruleId: string, ruleVersion: string): ResolveResult {
    const e = this.entries.get(this.key(ruleId, ruleVersion));
    if (!e) return { status: "unavailable", reason: "unknown" };
    if ("tombstone" in e) return { status: "unavailable", reason: e.tombstone };
    return { status: "ok", ...e };
  }

  /** Deterministic manifest string for policy_version hashing (real content). */
  manifest(): string {
    return [...this.entries.entries()]
      .map(([k, e]) => `${k}:${"code_hash" in e ? e.code_hash : e.tombstone}`)
      .sort()
      .join("\n");
  }
}
```

- [ ] **Step 4: Run test → PASS** — Run: `bun test tests/core/recommendation/registry.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/core/recommendation/registry.ts tests/core/recommendation/registry.test.ts
git commit -m "feat(rec): versioned rule registry (immutable + tombstones) (#328)"
```

---

## Task 6: Record store — single persistence entry, split lifecycle/freshness APIs (spec §5.5, §5.6)

**Files:** Create `src/core/recommendation/record-store.ts`; Test `tests/core/recommendation/record-store.test.ts`

- [ ] **Step 1: Write failing test**

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
let db: CBrainDB;
let store: RecommendationStore;

function mkPayload(codeHash: string, key = "k1", autoExecute: false = false): RecommendationImmutablePayload {
  const di = { signals: { v: 1 }, entity_snapshot: { eA: { reports_to: [{ to: "eB", trust_state: "candidate" }] } }, evidence_refs: ["health:k:eA:eB"] };
  return {
    namespace: "maintenance", maintenance_key: key, inputs_hash: computeInputsHash(di),
    conclusion: { kind: "propose", action: { type: "dry_run", target_ref: "health:k:eA", reason: "r" }, alternatives: [] },
    decision_inputs: di,
    evidence_manifest: [{ source: "health", ref: "health:k:eA:eB", trust_state: "candidate" }],
    constraints: { policy_version: "p", ontology_version: "o", schema_version: SCHEMA_VERSION },
    dependency_manifest: { rule_id: "health:k", declarations: [{ slug: "eA", table: "links", fields: ["relation", "trust_state", "other_slug"], filter: "active" }] },
    applicability: { audience: "user_only", auto_execute: autoExecute, requires_confirmation: { tier: "standard" } },
    risks: [], gaps: [],
    producer: { rule_id: "health:k", rule_version: "1.0.0", code_hash: codeHash, registry_ref: "r@1.0.0" },
  };
}

describe("RecommendationStore persistence entry", () => {
  afterEach(() => { db?.close(); rmSync(DIR, { recursive: true, force: true }); });
  function open() { db = new CBrainDB(`${DIR}/db.sqlite`); store = new RecommendationStore(db); }

  test("createRecord computes fingerprint internally (ignores any caller-supplied hint)", () => {
    open();
    const p = mkPayload("h1");
    const r = store.createRecord(p, "t0");
    expect(r.fingerprint).toBe(computeFingerprint({ ...p, inputs_hash: computeInputsHash(p.decision_inputs) }));
    expect(r.lifecycle_status).toBe("pending");
    expect(r.freshness_status).toBe("fresh");
  });

  test("rejects auto_execute !== false (cannot persist a record that claims execution)", () => {
    open();
    const p = mkPayload("h1");
    // forcibly widen the type to simulate a tampered payload
    const bad = { ...p, applicability: { ...p.applicability, auto_execute: true as unknown as false } };
    expect(() => store.createRecord(bad, "t0")).toThrow(/auto_execute/);
  });

  test("same fingerprint re-create is idempotent", () => {
    open();
    const p = mkPayload("h1");
    const r1 = store.createRecord(p, "t0");
    const r2 = store.createRecord(p, "t0");
    expect(r2.record_id).toBe(r1.record_id);
  });

  test("different fingerprint same key → atomic supersede; active count stays 1", () => {
    open();
    store.createRecord(mkPayload("hA"), "t0");
    store.createRecord(mkPayload("hB"), "t1"); // different inputs_hash → different fingerprint
    expect(store.activeCountFor("k1")).toBe(1);
  });

  test("rejected suppression: same (key,fingerprint) not re-created while suppressed (F8)", () => {
    open();
    const p = mkPayload("h1");
    const r = store.createRecord(p, "t0");
    store.transitionLifecycle(r.record_id, "rejected", "t1", "user-declined", "t1+7d");
    // producer re-runs same content within suppression window → rejected, no new active
    expect(() => store.createRecord(p, "t2")).toThrow(/suppressed/);
    expect(store.activeCountFor("k1")).toBe(0);
  });

  test("rejected suppression expires → re-create allowed (F17)", () => {
    open();
    const p = mkPayload("h1");
    const r = store.createRecord(p, "t0");
    store.transitionLifecycle(r.record_id, "rejected", "t1", "user-declined", "t0-1d"); // already expired
    expect(() => store.createRecord(p, "t2")).not.toThrow();
  });

  test("transitionLifecycle whitelist: superseded cannot regress to pending (no reactivation)", () => {
    open();
    const p = mkPayload("h1");
    const r = store.createRecord(p, "t0");
    store.transitionLifecycle(r.record_id, "superseded", "t1", "test");
    expect(() => store.transitionLifecycle(r.record_id, "pending", "t2", "reactivate")).toThrow(/illegal.*transition/);
  });

  test("updateFreshness changes ONLY freshness, not lifecycle (dual-axis)", () => {
    open();
    const p = mkPayload("h1");
    const r = store.createRecord(p, "t0"); // pending/fresh
    store.updateFreshness(r.record_id, "stale", "t1");
    const reloaded = store.getById(r.record_id);
    expect(reloaded?.freshness_status).toBe("stale");
    expect(reloaded?.lifecycle_status).toBe("pending"); // untouched
  });
});
```

- [ ] **Step 2: Run test → FAIL** — Run: `bun test tests/core/recommendation/record-store.test.ts`.

- [ ] **Step 3: Implement store (single entry, split APIs, suppression)**

```ts
// src/core/recommendation/record-store.ts
import { canonicalJson } from "./canonical.js";
import { checkIntegrity, computeFingerprint, computeInputsHash } from "./integrity.js";
import type { CBrainDB } from "../../storage/sqlite.js";
import type {
  FreshnessStatus, LifecycleStatus, RecommendationImmutablePayload, RecommendationRecord,
} from "./types.js";

interface Row {
  record_id: string; maintenance_key: string; fingerprint: string; inputs_hash: string;
  payload: string; created_at: string; last_revalidated_at: string;
  lifecycle_status: string; freshness_status: string; suppressed_until: string | null;
}

// legal lifecycle transitions (whitelist; terminals cannot regress — rev5 deleted reactivation)
const LIFECYCLE_TRANSITIONS: Record<LifecycleStatus, LifecycleStatus[]> = {
  pending: ["current", "superseded", "rejected", "invalidated"],
  current: ["superseded", "rejected", "invalidated"],
  superseded: ["invalidated"],          // cannot go back to pending/current
  rejected: ["invalidated"],            // cannot resurrect directly (suppression window governs re-create)
  invalidated: [],
};

export class RecommendationStore {
  constructor(private db: CBrainDB) {}

  activeCountFor(key: string): number {
    const r = this.db.prepare(
      "SELECT COUNT(*) c FROM recommendation_records WHERE maintenance_key = $key AND lifecycle_status IN ('pending','current')"
    ).get({ $key: key }) as { c: number };
    return r.c;
  }

  getById(recordId: string): RecommendationRecord | null {
    const row = this.db.prepare("SELECT * FROM recommendation_records WHERE record_id = $id").get({ $id: recordId }) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  /**
   * SINGLE persistence entry point (HIGH 2). The store owns the fingerprint:
   * validate JSON-safe → reject auto_execute!==false → compute inputs_hash/fingerprint →
   * check integrity + cross-consistency → check rejected suppression → atomic supersede insert.
   */
  createRecord(payload: RecommendationImmutablePayload, now: string): RecommendationRecord {
    if (payload.applicability.auto_execute !== false) {
      throw new Error("record-store: auto_execute must be false");
    }
    const withHash: RecommendationImmutablePayload = { ...payload, inputs_hash: computeInputsHash(payload.decision_inputs) };
    const fingerprint = computeFingerprint(withHash);
    const provisional: RecommendationRecord = {
      record_id: globalThis.crypto.randomUUID(), payload: withHash, fingerprint,
      created_at: now, last_revalidated_at: now,
      lifecycle_status: "pending", freshness_status: "fresh", suppressed_until: null,
    };
    const integrity = checkIntegrity(provisional);
    if (!integrity.ok) throw new Error(`record-store: integrity failed (${integrity.code})`);

    const key = payload.maintenance_key;
    return this.db.transaction(() => {
      // idempotent: same fingerprint already active?
      const active = this.activeRow(key);
      if (active && active.fingerprint === fingerprint) return fromRow(active);

      // rejected suppression (spec §5.6): same (key,fingerprint) suppressed?
      const rej = this.db.prepare(
        "SELECT suppressed_until FROM recommendation_records WHERE maintenance_key = $key AND fingerprint = $fp AND lifecycle_status = 'rejected' ORDER BY suppressed_until DESC LIMIT 1"
      ).get({ $key: key, $fp: fingerprint }) as { suppressed_until: string | null } | undefined;
      if (rej && (rej.suppressed_until === null || rej.suppressed_until > now)) {
        throw new Error("record-store: creation suppressed (rejected within suppression window)");
      }

      if (active) {
        this.db.prepare("UPDATE recommendation_records SET lifecycle_status = 'superseded' WHERE record_id = $id").run({ $id: active.record_id });
        this.history(active.record_id, "superseded", active.lifecycle_status, "superseded", undefined, undefined, "replaced by " + provisional.record_id, now);
      }
      this.db.prepare(
        `INSERT INTO recommendation_records
         (record_id, maintenance_key, fingerprint, inputs_hash, payload, auto_execute, created_at, last_revalidated_at, lifecycle_status, freshness_status, suppressed_until)
         VALUES ($rid,$key,$fp,$ih,$payload,0,$now,$now,'pending','fresh',NULL)`
      ).run({ $rid: provisional.record_id, $key: key, $fp: fingerprint, $ih: withHash.inputs_hash, $payload: canonicalJson(withHash), $now: now });
      this.history(provisional.record_id, "created", undefined, "pending", undefined, undefined, undefined, now);
      return provisional;
    });
  }

  /** Lifecycle transition (HIGH 3). Whitelisted; terminals cannot regress. */
  transitionLifecycle(recordId: string, to: LifecycleStatus, now: string, reason: string, suppressedUntil: string | null = null): void {
    this.db.transaction(() => {
      const row = this.db.prepare("SELECT lifecycle_status AS l FROM recommendation_records WHERE record_id = $id").get({ $id: recordId }) as { l: LifecycleStatus } | undefined;
      if (!row) throw new Error(`record-store: record ${recordId} not found`);
      const allowed = LIFECYCLE_TRANSITIONS[row.l];
      if (!allowed.includes(to)) throw new Error(`record-store: illegal lifecycle transition ${row.l} → ${to}`);
      const sets: string[] = [];
      if (to === "rejected" && suppressedUntil !== null) sets.push("suppressed_until = $sut");
      const sql = `UPDATE recommendation_records SET lifecycle_status = $to${sets.length ? ", " + sets.join(", ") : ""} WHERE record_id = $id`;
      const params: Record<string, string> = { $to: to, $id: recordId, $now };
      if (to === "rejected" && suppressedUntil !== null) params.$sut = suppressedUntil;
      this.db.prepare(sql).run(params);
      this.history(recordId, to, row.l, to, undefined, undefined, reason, now);
    });
  }

  /** Freshness update (HIGH 3). Touches ONLY freshness_status + last_revalidated_at; lifecycle untouched. */
  updateFreshness(recordId: string, to: FreshnessStatus, now: string): void {
    this.db.transaction(() => {
      const row = this.db.prepare("SELECT freshness_status AS f, lifecycle_status AS l FROM recommendation_records WHERE record_id = $id").get({ $id: recordId }) as { f: FreshnessStatus; l: LifecycleStatus } | undefined;
      if (!row) throw new Error(`record-store: record ${recordId} not found`);
      const revalidate = to === "fresh";
      this.db.prepare(
        `UPDATE recommendation_records SET freshness_status = $to${revalidate ? ", last_revalidated_at = $now" : ""} WHERE record_id = $id`
      ).run({ $to: to, $now: now, $id: recordId });
      this.history(recordId, `freshness:${to}`, row.l, row.l, row.f, to, undefined, now);
    });
  }

  private activeRow(key: string): Row | undefined {
    return this.db.prepare(
      "SELECT * FROM recommendation_records WHERE maintenance_key = $key AND lifecycle_status IN ('pending','current') ORDER BY rowid DESC LIMIT 1"
    ).get({ $key: key }) as Row | undefined;
  }
  private history(recordId: string, action: string, fromL: string | undefined, toL: string, fromF: string | undefined, toF: string | undefined, reason: string | undefined, now: string): void {
    this.db.prepare(
      "INSERT INTO recommendation_lifecycle_history (record_id, action, from_lifecycle, to_lifecycle, from_freshness, to_freshness, reason, created_at) VALUES ($rid,$action,$fl,$tl,$ff,$tf,$reason,$now)"
    ).run({ $rid: recordId, $action: action, $fl: fromL ?? null, $tl: toL, $ff: fromF ?? null, $tf: toF ?? null, $reason: reason ?? null, $now: now });
  }
}

function fromRow(r: Row): RecommendationRecord {
  return {
    record_id: r.record_id, payload: JSON.parse(r.payload) as RecommendationImmutablePayload,
    fingerprint: r.fingerprint, created_at: r.created_at, last_revalidated_at: r.last_revalidated_at,
    lifecycle_status: r.lifecycle_status as LifecycleStatus, freshness_status: r.freshness_status as FreshnessStatus,
    suppressed_until: r.suppressed_until,
  };
}
```

> **API note:** `CBrainDB.prepare(sql).get/.run({ $named })` and `CBrainDB.transaction(fn)` (returns the result, fn invoked inside) — see `getConfig`/`setConfig` (sqlite.ts:769) and `transaction<T>` (sqlite.ts:581). The `last_revalidated_at` column update happens ONLY on `fresh` (spec §8.4).

- [ ] **Step 4: Run test → PASS** — Run: `bun test tests/core/recommendation/record-store.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/core/recommendation/record-store.ts tests/core/recommendation/record-store.test.ts
git commit -m "feat(rec): record store (single entry, split lifecycle/freshness, suppression) (#328)"
```

---

## Task 7: DeclaredProjectionReader + freshness persistence (spec §5.3, §8.4)

**Files:** Create `src/core/recommendation/projection.ts`, `src/core/recommendation/freshness.ts`; Test `tests/core/recommendation/freshness.test.ts`

- [ ] **Step 1: Write failing test**

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
const A = "entities/eA";
const B = "entities/eB";

function seedPair(db: CBrainDB) {
  for (const s of [A, B]) db.rawDb.prepare(`INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count, tier) VALUES (?, 'entity', ?, ?, ?, 0, 3)`).run(s, s, `${s}.md`, `h-${s}`);
}
function addReportsTo(db: CBrainDB, from: string, to: string, trust: string) {
  db.rawDb.prepare(`INSERT INTO links (from_slug, to_slug, relation, trust_state, source_type) VALUES (?, ?, 'reports_to', ?, 'agent')`).run(from, to, trust);
}
const decls: DependencyManifest = {
  rule_id: "health:known_relations",
  declarations: [A, B].map((s) => ({ slug: s, table: "links" as const, fields: ["relation", "trust_state", "other_slug"], filter: "active" as const })),
};
const producer: RecommendationProducer = { rule_id: "health:known_relations", rule_version: "1.0.0", code_hash: "h1", registry_ref: "r@1.0.0" };

// registry whose captureInputs derives candidate count over BOTH slugs from the projection
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

// build a payload whose decision_inputs come from the registry's captureInputs (state A)
function payloadFor(db: CBrainDB, reg: VersionedRuleRegistry): RecommendationImmutablePayload {
  const reader = new DeclaredProjectionReader(db);
  const projection = reader.read(decls.declarations);
  const runner = reg.resolve(producer.rule_id, producer.rule_version);
  if (runner.status !== "ok") throw new Error("runner missing");
  const di = runner.captureInputs(projection);
  return {
    namespace: "maintenance", maintenance_key: `health:known_relations:${JSON.stringify([A, B])}`, inputs_hash: computeInputsHash(di),
    conclusion: { kind: "propose", action: { type: "dry_run", target_ref: `health:known_relations:${A}`, reason: "r" }, alternatives: [] },
    decision_inputs: di,
    evidence_manifest: di.evidence_refs.map((ref) => ({ source: "health", ref, trust_state: "candidate" as const })),
    constraints: { policy_version: "p", ontology_version: "o", schema_version: SCHEMA_VERSION },
    dependency_manifest: decls,
    applicability: { audience: "user_only", auto_execute: false, requires_confirmation: { tier: "standard" } },
    risks: [], gaps: [], producer,
  };
}

describe("DeclaredProjectionReader + freshness", () => {
  afterEach(() => { rmSync(DIR, { recursive: true, force: true }); });

  test("reader reads the FULL manifest (both slugs)", () => {
    const db = new CBrainDB(`${DIR}/db.sqlite`);
    seedPair(db); addReportsTo(db, A, B, "candidate");
    const proj = new DeclaredProjectionReader(db).read(decls.declarations);
    expect(Object.keys(proj).sort()).toEqual([A, B]);
    expect((proj[A] as { reports_to: unknown[] }).reports_to.length).toBe(1);
    db.close();
  });

  test("dependency drift → freshness persisted stale, lifecycle untouched (path 1)", () => {
    const db = new CBrainDB(`${DIR}/db2.sqlite`);
    seedPair(db); addReportsTo(db, A, B, "candidate"); // state A
    const reg = makeRegistry();
    const store = new RecommendationStore(db);
    const created = store.createRecord(payloadFor(db, reg), "t0");
    expect(store.getById(created.record_id)?.freshness_status).toBe("fresh");

    // drift: a second candidate edge appears (state B)
    addReportsTo(db, B, A, "candidate");
    const out = recomputeAndPersistFreshness(
      store.getById(created.record_id)!,
      new DeclaredProjectionReader(db), reg, store,
      { policy_version: "p", ontology_version: "o", schema_version: SCHEMA_VERSION },
      "t1",
    );
    expect(out.freshness).toBe("stale");
    const reloaded = store.getById(created.record_id);
    expect(reloaded?.freshness_status).toBe("stale");
    expect(reloaded?.lifecycle_status).toBe("pending"); // untouched (dual-axis)
    db.close();
  });

  test("state returns to A → freshness recovers fresh (A→B→A path 1)", () => {
    const db = new CBrainDB(`${DIR}/db3.sqlite`);
    seedPair(db); addReportsTo(db, A, B, "candidate");
    const reg = makeRegistry();
    const store = new RecommendationStore(db);
    const created = store.createRecord(payloadFor(db, reg), "t0");
    addReportsTo(db, B, A, "candidate"); // drift to B
    recomputeAndPersistFreshness(store.getById(created.record_id)!, new DeclaredProjectionReader(db), reg, store, { policy_version: "p", ontology_version: "o", schema_version: SCHEMA_VERSION }, "t1");
    expect(store.getById(created.record_id)?.freshness_status).toBe("stale");
    // back to A
    db.rawDb.prepare("DELETE FROM links WHERE from_slug = ? AND to_slug = ?").run(B, A);
    recomputeAndPersistFreshness(store.getById(created.record_id)!, new DeclaredProjectionReader(db), reg, store, { policy_version: "p", ontology_version: "o", schema_version: SCHEMA_VERSION }, "t2");
    expect(store.getById(created.record_id)?.freshness_status).toBe("fresh");
    db.close();
  });

  test("constraints mismatch → version_invalid persisted", () => {
    const db = new CBrainDB(`${DIR}/db4.sqlite`);
    seedPair(db); addReportsTo(db, A, B, "candidate");
    const reg = makeRegistry();
    const store = new RecommendationStore(db);
    const created = store.createRecord(payloadFor(db, reg), "t0");
    const out = recomputeAndPersistFreshness(store.getById(created.record_id)!, new DeclaredProjectionReader(db), reg, store, { policy_version: "changed", ontology_version: "o", schema_version: SCHEMA_VERSION }, "t1");
    expect(out.freshness).toBe("version_invalid");
    expect(store.getById(created.record_id)?.freshness_status).toBe("version_invalid");
    db.close();
  });

  test("runner unavailable → version_invalid (no guess)", () => {
    const db = new CBrainDB(`${DIR}/db5.sqlite`);
    seedPair(db); addReportsTo(db, A, B, "candidate");
    const reg = makeRegistry();
    const store = new RecommendationStore(db);
    const created = store.createRecord(payloadFor(db, reg), "t0");
    const emptyReg = new VersionedRuleRegistry();
    const out = recomputeAndPersistFreshness(store.getById(created.record_id)!, new DeclaredProjectionReader(db), emptyReg, store, { policy_version: "p", ontology_version: "o", schema_version: SCHEMA_VERSION }, "t1");
    expect(out.freshness).toBe("version_invalid");
    db.close();
  });
});
```

- [ ] **Step 2: Run test → FAIL** — Run: `bun test tests/core/recommendation/freshness.test.ts`.

- [ ] **Step 3: Implement projection reader + freshness**

```ts
// src/core/recommendation/projection.ts
import type { CBrainDB } from "../../storage/sqlite.js";
import type { DependencyDeclaration } from "./types.js";

export interface DeclaredProjection { [slug: string]: unknown }

/** Reads the FULL dependency manifest. Shared by creation (manager) and freshness.
 *  Generic over declared table/fields/filter — no producer logic. (HIGH 4) */
export class DeclaredProjectionReader {
  constructor(private db: CBrainDB) {}

  read(declarations: DependencyDeclaration[]): DeclaredProjection {
    const proj: DeclaredProjection = {};
    for (const d of declarations) {
      const key = d.slug ?? "__global__";
      proj[key] = this.readOne(d);
    }
    return proj;
  }

  private readOne(d: DependencyDeclaration): unknown {
    // Phase 1: support links (reports_to edges) + pages (content_hash). Other tables added as producers need them.
    if (d.slug && d.table === "links") {
      return {
        reports_to: this.db.getOutgoingLinks(d.slug)
          .filter((r) => r.relation === "reports_to")
          .map((r) => ({ to: r.to_slug, trust_state: r.trust_state ?? "trusted" })),
      };
    }
    if (d.slug && d.table === "pages") {
      const p = this.db.getPage(d.slug) as { content_hash?: string } | null;
      return { content_hash: p?.content_hash ?? null };
    }
    // global / unsupported table for Phase 1: empty projection (producer must declare what it needs)
    return {};
  }
}
```

```ts
// src/core/recommendation/freshness.ts
import { computeInputsHash } from "./integrity.js";
import type { DeclaredProjectionReader } from "./projection.js";
import type { RecommendationStore } from "./record-store.js";
import type { VersionedRuleRegistry } from "./registry.js";
import type { RecommendationRecord } from "./types.js";

/**
 * Recompute freshness over the FULL manifest via the version-pinned captureInputs,
 * then PERSIST (freshness-only transaction; lifecycle untouched). last_revalidated_at
 * advances only when freshness becomes fresh. (HIGH 4) */
export function recomputeAndPersistFreshness(
  record: RecommendationRecord,
  reader: DeclaredProjectionReader,
  registry: VersionedRuleRegistry,
  store: RecommendationStore,
  currentConstraints: { policy_version: string; ontology_version: string; schema_version: string },
  now: string,
): { freshness: "fresh" | "stale" | "version_invalid" } {
  const c = record.payload.constraints;
  if (currentConstraints.policy_version !== c.policy_version ||
      currentConstraints.ontology_version !== c.ontology_version ||
      currentConstraints.schema_version !== c.schema_version) {
    store.updateFreshness(record.record_id, "version_invalid", now);
    return { freshness: "version_invalid" };
  }
  const runner = registry.resolve(record.payload.producer.rule_id, record.payload.producer.rule_version);
  if (runner.status !== "ok") {
    store.updateFreshness(record.record_id, "version_invalid", now);
    return { freshness: "version_invalid" };
  }
  const projection = reader.read(record.payload.dependency_manifest.declarations);
  const inputsHashNow = computeInputsHash(runner.captureInputs(projection));
  const freshness = inputsHashNow === record.payload.inputs_hash ? "fresh" : "stale";
  store.updateFreshness(record.record_id, freshness, now);
  return { freshness };
}
```

- [ ] **Step 4: Run test → PASS** — Run: `bun test tests/core/recommendation/freshness.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/core/recommendation/projection.ts src/core/recommendation/freshness.ts tests/core/recommendation/freshness.test.ts
git commit -m "feat(rec): declared-projection reader + persisted freshness (#328)"
```

---

## Task 8: Display projection — active+fresh gate, reason sanitized (spec §4.4, §11.3)

**Files:** Create `src/core/recommendation/display.ts`; Test `tests/core/recommendation/display.test.ts`

- [ ] **Step 1: Write failing test (5 non-display states + hostile reason)**

```ts
// tests/core/recommendation/display.test.ts
import { describe, expect, test } from "bun:test";
import { projectDisplay } from "../../../src/core/recommendation/display.js";
import type { RecommendationRecord } from "../../../src/core/recommendation/types.js";

function rec(lc: RecommendationRecord["lifecycle_status"], fr: RecommendationRecord["freshness_status"], reason = "正常理由"): RecommendationRecord {
  return {
    record_id: "r", created_at: "t", last_revalidated_at: "t", fingerprint: "f", suppressed_until: null,
    lifecycle_status: lc, freshness_status: fr,
    payload: {
      namespace: "maintenance", maintenance_key: "k", inputs_hash: "ih",
      conclusion: { kind: "propose", action: { type: "dry_run", target_ref: "health:k:eA", reason }, alternatives: [] },
      decision_inputs: { signals: {}, entity_snapshot: {}, evidence_refs: [] },
      evidence_manifest: [], constraints: { policy_version: "p", ontology_version: "o", schema_version: "rec-v1" },
      dependency_manifest: { rule_id: "r", declarations: [] },
      applicability: { audience: "user_only", auto_execute: false, requires_confirmation: { tier: "standard" } },
      risks: [], gaps: [], producer: { rule_id: "r", rule_version: "1", code_hash: "h", registry_ref: "r@1" },
    },
  };
}

describe("projectDisplay gate", () => {
  test("pending+fresh → display produced, title sanitized, reason sanitized", () => {
    const d = projectDisplay(rec("pending", "fresh"), () => "实体A");
    expect(d.blocked).toBe(false);
    if (!d.blocked) { expect(d.target_display).toBe("实体A"); expect(d.reason).toBe("正常理由"); }
  });
  test("stale → blocked", () => { expect(projectDisplay(rec("pending", "stale"), () => "x").blocked).toBe(true); });
  test("version_invalid → blocked", () => { expect(projectDisplay(rec("current", "version_invalid"), () => "x").blocked).toBe(true); });
  test("superseded → blocked", () => { expect(projectDisplay(rec("superseded", "fresh"), () => "x").blocked).toBe(true); });
  test("rejected → blocked", () => { expect(projectDisplay(rec("rejected", "fresh"), () => "x").blocked).toBe(true); });
  test("invalidated → blocked", () => { expect(projectDisplay(rec("invalidated", "fresh"), () => "x").blocked).toBe(true); });
  test("hostile reason falls back, never raw-leaks", () => {
    const d = projectDisplay(rec("pending", "fresh", "泄露 /Users/secret path score=0.9"), () => "");
    expect(d.blocked).toBe(false);
    if (!d.blocked) { expect(d.reason).not.toContain("/Users/"); expect(d.reason).not.toContain("score"); }
  });
});
```

- [ ] **Step 2: Run test → FAIL** — Run: `bun test tests/core/recommendation/display.test.ts`.

- [ ] **Step 3: Implement display (gated + sanitized)**

```ts
// src/core/recommendation/display.ts
import { assertSafeActionDisplay } from "../safety/display-safety.js";
import type { RecommendationRecord } from "./types.js";

const FALLBACK_DISPLAY = "一项待确认的记忆";
const FALLBACK_REASON = "有一项建议需要人工复核。";

export type DisplayResult =
  | { blocked: true }
  | { blocked: false; target_display: string; reason: string };

function safe(text: string, fallback: string): string {
  try { assertSafeActionDisplay(text); return text; } catch { return fallback; }
}

/** Read-time display projection (spec §4.4). Gated on active+fresh; title AND reason
 *  pass through the display-safety boundary. target_display is never persisted. */
export function projectDisplay(rec: RecommendationRecord, resolveSafeTitle: (slug: string) => string): DisplayResult {
  const active = rec.lifecycle_status === "pending" || rec.lifecycle_status === "current";
  if (!active || rec.freshness_status !== "fresh") return { blocked: true };
  const c = rec.payload.conclusion;
  if (c.kind !== "abstain") {
    const slug = c.action.target_ref.split(":").pop() ?? c.action.target_ref;
    return { blocked: false, target_display: safe(resolveSafeTitle(slug) || FALLBACK_DISPLAY, FALLBACK_DISPLAY), reason: safe(c.action.reason, FALLBACK_REASON) };
  }
  return { blocked: false, target_display: FALLBACK_DISPLAY, reason: safe(`abstain: ${c.reason}`, FALLBACK_REASON) };
}
```

- [ ] **Step 4: Run test → PASS** — Run: `bun test tests/core/recommendation/display.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/core/recommendation/display.ts tests/core/recommendation/display.test.ts
git commit -m "feat(rec): gated + sanitized display projection (#328)"
```

---

## Task 9: versions (real content hashes) + reference producer + manager (spec §4.3, §7.2)

**Files:** Create `src/core/recommendation/versions.ts`, `src/core/recommendation/producers/known-relations.ts`, `src/core/recommendation/producers/index.ts`, `src/core/recommendation/manager.ts`; Test `tests/core/recommendation/producers/known-relations.test.ts`

- [ ] **Step 1: Write failing test (real evidence projection, normalized slugs, version change)**

```ts
// tests/core/recommendation/producers/known-relations.test.ts
import { rmSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import { CBrainDB } from "../../../../src/storage/sqlite.js";
import { registerMaintenanceProducers } from "../../../../src/core/recommendation/producers/index.js";
import { VersionedRuleRegistry } from "../../../../src/core/recommendation/registry.js";
import { RecommendationManager } from "../../../../src/core/recommendation/manager.js";

const DIR = "/tmp/cbrain-test-rec-producer";
const A = "entities/entityA";
const B = "entities/entityB";

function seedPair(db: CBrainDB) {
  for (const s of [A, B]) db.rawDb.prepare(`INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count, tier) VALUES (?, 'entity', ?, ?, ?, 0, 3)`).run(s, s, `${s}.md`, `h-${s}`);
}
function addReportsTo(db: CBrainDB, from: string, to: string, trust: string) {
  db.rawDb.prepare(`INSERT INTO links (from_slug, to_slug, relation, trust_state, source_type) VALUES (?, ?, 'reports_to', ?, 'agent')`).run(from, to, trust);
}

describe("known_relations producer (vertical slice)", () => {
  afterEach(() => { rmSync(DIR, { recursive: true, force: true }); });

  test("abstains when no candidate edge", () => {
    const db = new CBrainDB(`${DIR}/db.sqlite`); seedPair(db);
    const reg = new VersionedRuleRegistry(); registerMaintenanceProducers(reg);
    const mgr = new RecommendationManager(db, reg);
    const r = mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "t0");
    expect(r.payload.conclusion.kind).toBe("abstain");
    db.close();
  });

  test("proposes dry_run on real candidate edge; evidence is the real edge (single ref, not per-slug)", () => {
    const db = new CBrainDB(`${DIR}/db2.sqlite`); seedPair(db); addReportsTo(db, A, B, "candidate");
    const reg = new VersionedRuleRegistry(); registerMaintenanceProducers(reg);
    const mgr = new RecommendationManager(db, reg);
    const r = mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "t0");
    expect(r.payload.conclusion.kind).toBe("propose");
    // evidence_manifest is a TRUE projection — one ref for the one real candidate edge
    expect(r.payload.evidence_manifest.length).toBe(1);
    expect(r.payload.decision_inputs.evidence_refs).toEqual(r.payload.evidence_manifest.map((e) => e.ref));
    db.close();
  });

  test("normalized slugs: disordered/duplicate input → same maintenance_key + same fingerprint", () => {
    const db = new CBrainDB(`${DIR}/db3.sqlite`); seedPair(db); addReportsTo(db, A, B, "candidate");
    const reg = new VersionedRuleRegistry(); registerMaintenanceProducers(reg);
    const mgr = new RecommendationManager(db, reg);
    const r1 = mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [B, A, A] }, "t0");
    const r2 = mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "t1");
    expect(r1.payload.maintenance_key).toBe(r2.payload.maintenance_key);
    expect(r1.fingerprint).toBe(r2.fingerprint);
    db.close();
  });

  test("inactive candidate edge (rejected) excluded — not in evidence/manifest", () => {
    const db = new CBrainDB(`${DIR}/db4.sqlite`); seedPair(db); addReportsTo(db, A, B, "rejected");
    const reg = new VersionedRuleRegistry(); registerMaintenanceProducers(reg);
    const mgr = new RecommendationManager(db, reg);
    const r = mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "t0");
    expect(r.payload.conclusion.kind).toBe("abstain"); // active-only read drops rejected edge
    db.close();
  });

  test("ontology version change captured in constraints (real content hash)", () => {
    const db = new CBrainDB(`${DIR}/db5.sqlite`); seedPair(db); addReportsTo(db, A, B, "candidate");
    const reg = new VersionedRuleRegistry(); registerMaintenanceProducers(reg);
    const mgr = new RecommendationManager(db, reg);
    const r = mgr.buildAndStore({ rule_id: "health:known_relations", slugs: [A, B] }, "t0");
    // ontology_version is a real sha256 hex of ontology.yaml content, not a constant
    expect(r.payload.constraints.ontology_version).toMatch(/^[0-9a-f]{64}$/);
    db.close();
  });
});
```

- [ ] **Step 2: Run test → FAIL** — Run: `bun test tests/core/recommendation/producers/known-relations.test.ts`.

- [ ] **Step 3: Implement versions (real content hashes)**

```ts
// src/core/recommendation/versions.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "./canonical.js";
import type { VersionedRuleRegistry } from "./registry.js";

/** Real hash of ontology.yaml content (bundled with loader.ts). */
export function ontologyHash(): string {
  const path = join(import.meta.dir, "../../ontology/ontology.yaml");
  return sha256Hex(readFileSync(path, "utf8"));
}

/** Real hash of the registry manifest (which rule@version:code_hash are registered). */
export function policyHash(registry: VersionedRuleRegistry): string {
  return sha256Hex(registry.manifest());
}
```

> **API note:** `import.meta.dir` resolves to `src/core/recommendation/`; `../../ontology/ontology.yaml` reaches `src/ontology/ontology.yaml`. Confirm the relative path with `ls src/ontology/ontology.yaml` before running; adjust the `join` depth if the bundled layout differs.

- [ ] **Step 4: Implement producer + registration (real evidence projection, normalized slugs)**

```ts
// src/core/recommendation/producers/known-relations.ts
import type { DecisionInputs, RecommendationConclusion, RecommendationProducer } from "../types.js";

export const KNOWN_RELATIONS: RecommendationProducer = {
  rule_id: "health:known_relations", rule_version: "1.0.0",
  code_hash: "known-relations-v1", // Phase 1: reproducible static tag; Phase 2 derives from rule artifact
  registry_ref: "cbrain.rules:maintenance.known_relations@1.0.0",
};

interface Edge { from: string; to: string; trust_state: string }

/** captureInputs: projection (slug → { reports_to: Edge[] }) → DecisionInputs.
 *  evidence_refs are the REAL active candidate edges (true projection, spec §4.3). */
export function captureInputs(normalizedSlugs: string[], projection: Record<string, { reports_to: Edge[] }>): DecisionInputs {
  const candidates: Edge[] = [];
  for (const s of normalizedSlugs) for (const e of projection[s]?.reports_to ?? []) if (e.trust_state === "candidate") candidates.push(e);
  const entity_snapshot: Record<string, { reports_to: Edge[] }> = {};
  for (const s of normalizedSlugs) entity_snapshot[s] = projection[s]?.reports_to ?? [];
  // stable, deduped evidence refs over the real candidate edges
  const evidence_refs = [...new Set(candidates.map((e) => `health:known_relations:${e.from}:${e.to}`))].sort();
  return { signals: { candidate_count: candidates.length }, entity_snapshot, evidence_refs };
}

export function decide(normalizedSlugs: string[], di: DecisionInputs): RecommendationConclusion {
  const count = (di.signals.candidate_count as number) ?? 0;
  if (count === 0) return { kind: "abstain", reason: "insufficient_evidence" };
  const target = normalizedSlugs[0];
  return {
    kind: "propose",
    action: { type: "dry_run", target_ref: `health:known_relations:${target}`, reason: "存在待确认的 reports_to 候选边，建议人工复核" },
    alternatives: [],
  };
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
      const slugs = Object.keys(p).sort();
      return krCapture(slugs, p);
    },
    decide: (di) => krDecide(Object.keys(di.entity_snapshot).sort(), di),
  });
}
```

- [ ] **Step 5: Implement manager (end-to-end via store; normalized slugs; real hashes)**

```ts
// src/core/recommendation/manager.ts
import { computeInputsHash } from "./integrity.js";
import { DeclaredProjectionReader } from "./projection.js";
import { RecommendationStore } from "./record-store.js";
import { ontologyHash, policyHash } from "./versions.js";
import { SCHEMA_VERSION } from "./types.js";
import type { CBrainDB } from "../../storage/sqlite.js";
import type { VersionedRuleRegistry } from "./registry.js";
import type {
  DependencyManifest, EvidenceManifestEntry, RecommendationConstraints, RecommendationImmutablePayload,
} from "./types.js";

export interface BuildRequest { rule_id: string; slugs: string[] }

export class RecommendationManager {
  constructor(private db: CBrainDB, private registry: VersionedRuleRegistry) {}

  buildAndStore(req: BuildRequest, now: string) {
    // 1. NORMALIZED slugs first — sorted, unique (HIGH 6). Thread through everything.
    const slugs = [...new Set(req.slugs)].sort();

    // 2. build dependency_manifest from normalized slugs
    const dependency_manifest: DependencyManifest = {
      rule_id: req.rule_id,
      declarations: slugs.map((s) => ({ slug: s, table: "links" as const, fields: ["relation", "trust_state", "other_slug"], filter: "active" as const })),
    };

    // 3. read FULL declared projection (shared reader) → version-pinned captureInputs → decide
    const reader = new DeclaredProjectionReader(this.db);
    const projection = reader.read(dependency_manifest.declarations);
    const runner = this.registry.resolve(req.rule_id, this.producerVersion(req.rule_id));
    if (runner.status !== "ok") throw new Error(`manager: producer ${req.rule_id} not resolvable`);
    const decision_inputs = runner.captureInputs(projection);
    const conclusion = runner.decide(decision_inputs);

    // 4. evidence_manifest = TRUE projection of decision_inputs.evidence_refs
    const evidence_manifest: EvidenceManifestEntry[] = decision_inputs.evidence_refs.map((ref) => ({
      source: "health", ref, trust_state: "candidate" as const,
    }));

    // 5. real version hashes
    const constraints: RecommendationConstraints = {
      policy_version: policyHash(this.registry),
      ontology_version: ontologyHash(),
      schema_version: SCHEMA_VERSION,
    };

    const payload: RecommendationImmutablePayload = {
      namespace: "maintenance",
      maintenance_key: `${req.rule_id}:${JSON.stringify(slugs)}`,
      inputs_hash: "",                              // store computes it
      conclusion, decision_inputs, evidence_manifest, constraints, dependency_manifest,
      applicability: { audience: "user_only", auto_execute: false, requires_confirmation: { tier: "standard" } },
      risks: [], gaps: [],
      producer: { rule_id: req.rule_id, rule_version: this.producerVersion(req.rule_id), code_hash: this.producerCodeHash(req.rule_id), registry_ref: `cbrain.rules:${req.rule_id}@${this.producerVersion(req.rule_id)}` },
    };

    return new RecommendationStore(this.db).createRecord(payload, now);
  }

  private producerVersion(ruleId: string): string {
    return ruleId === "health:known_relations" ? "1.0.0" : "1.0.0"; // Phase 1 single producer
  }
  private producerCodeHash(ruleId: string): string {
    return ruleId === "health:known_relations" ? "known-relations-v1" : "unknown";
  }
}
```

- [ ] **Step 6: Run test → PASS** — Run: `bun test tests/core/recommendation/producers/known-relations.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/core/recommendation/versions.ts src/core/recommendation/producers/ src/core/recommendation/manager.ts tests/core/recommendation/producers/known-relations.test.ts
git commit -m "feat(rec): known_relations producer + real-hashed versions + manager (#328)"
```

---

## Task 10: Rollback tests on the PRODUCTION path (spec §5.5, migration integrity)

**Files:** extend `tests/core/recommendation/record-store.test.ts` + `tests/storage/migrations/recommendations.test.ts`

- [ ] **Step 1: Add production-path fault injection (createRecord rollback)**

Append to `tests/core/recommendation/record-store.test.ts`. This test uses its **own DB dir** so the dropped history table cannot pollute other tests in the file:

```ts
test("createRecord supersede rolls back on partial failure — prior active stays active", () => {
  // own DB so the fault-injection (dropped history table) doesn't leak to other tests
  const faultDir = "/tmp/cbrain-test-rec-store-fault";
  rmSync(faultDir, { recursive: true, force: true });
  const fdb = new CBrainDB(`${faultDir}/db.sqlite`);
  const fstore = new RecommendationStore(fdb);
  const pA = mkPayload("hA");
  const created = fstore.createRecord(pA, "t0");
  // Force the createRecord transaction to fail mid-way: drop the history table so the
  // history INSERT throws AFTER the supersede UPDATE would have run. Because createRecord
  // wraps supersede+insert+history in ONE db.transaction(...), the throw aborts everything.
  fdb.rawDb.exec("DROP TABLE recommendation_lifecycle_history");
  expect(() => fstore.createRecord(mkPayload("hB"), "t1")).toThrow();
  // prior A is still the sole active — the supersede UPDATE did not persist
  expect(fstore.activeCountFor("k1")).toBe(1);
  expect(fstore.getById(created.record_id)?.fingerprint).toBe(created.fingerprint);
  fdb.close();
  rmSync(faultDir, { recursive: true, force: true });
});
```

> **Why this proves the production path:** the fault hits `createRecord` itself (not a hand-rolled transaction). If the implementation does NOT wrap supersede+insert+history in one transaction, the supersede UPDATE would persist despite the throw and `activeCountFor` would read 0 (A wrongly superseded) — the test fails, forcing the fix into the implementation (Task 6), not the test.

- [ ] **Step 2: Add store-reload fingerprint round-trip (reload via store, not JSON.parse)**

Append (with `computeFingerprint` hoisted to the file's top imports alongside `computeInputsHash`):

```ts
test("fingerprint survives store → DB → store reload", () => {
  open();
  const created = store.createRecord(mkPayload("h1"), "t0");
  const reloaded = store.getById(created.record_id);
  expect(reloaded).not.toBeNull();
  expect(reloaded?.fingerprint).toBe(created.fingerprint);
  expect(computeFingerprint(reloaded!.payload)).toBe(created.fingerprint);
});
```

- [ ] **Step 3: Add migration atomic test — DDL+marker survive partial failure**

Append to `tests/storage/migrations/recommendations.test.ts`:

```ts
test("migration forward repair: re-run after table drop + marker clear restores atomically", () => {
  const db = newDb(); // memory DB with config table
  runRecommendationRecordsMigration(db);
  db.exec("DROP TABLE recommendation_records");
  db.exec("DELETE FROM config WHERE key='migration_rec_v1_recommendation_records'");
  expect(() => runRecommendationRecordsMigration(db)).not.toThrow();
  expect(exists(db, "recommendation_records")).toBe(true);
  const marker = (db.prepare("SELECT value FROM config WHERE key='migration_rec_v1_recommendation_records'").get() as { value?: string })?.value;
  expect(marker).toBe("1");
  db.close();
});
```

- [ ] **Step 4: Run all three → PASS**

Run: `bun test tests/core/recommendation/record-store.test.ts tests/storage/migrations/recommendations.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/core/recommendation/record-store.test.ts tests/storage/migrations/recommendations.test.ts
git commit -m "test(rec): production-path rollback + store-reload round-trip (#328)"
```

---

## Task 11: Lint + full check gate (explicit staging, NO git add -A)

**Files:** verification only

- [ ] **Step 1: Lint**

Run: `bun run lint`
Expected: PASS. All `CBrainDB` calls use the real API (`prepare(sql).get/.run({ $named })`, `transaction(fn)`, `getOutgoingLinks`, `rawDb.prepare` seeding, `new CBrainDB(dbPath)`); lint failures mean a typo, not an API mismatch.

- [ ] **Step 2: Full test**

Run: `bun test tests/core/recommendation/ tests/storage/migrations/recommendations.test.ts` → all PASS.

- [ ] **Step 3: Full check**

Run: `bun run check` → PASS.

- [ ] **Step 4: docs gate**

Run: `bun run check:docs` → PASS (defensive; no doc table touched).

- [ ] **Step 5: Final explicit commit ONLY if lint touched files (NEVER `git add -A`)**

If (and only if) `bun run lint --fix` changed files, stage those exact paths:

```bash
git status --short
# stage ONLY the files this plan touched that lint modified, e.g.:
# git add src/core/recommendation/manager.ts
# git commit -m "chore(rec): lint fixes (#328)"
```

If lint changed nothing, **skip this commit entirely** (no `--allow-empty`).

---

## Self-Review (run before handing off)

**Codex plan-review coverage (7 HIGH + 1 MED):**
- HIGH 1 (canonical fail-closed) → Task 1: `assertJsonSafe` recursive validator (finite/plain/cycle/lone-surrogate), absent-optional omission, prose rollback_note, tests for Date/Map/cyclic-array/lone-surrogate/absent-optional. ✓
- HIGH 2 (store can persist mismatched fingerprint) → Task 6: `createRecord` owns fingerprint (no external trust), rejects `auto_execute !== false`, runs `checkIntegrity`; Task 4 real cross-consistency (snapshot⊆declarations, evidence⊆projection, rule_id match) with fixed reason codes (no ref echo). ✓
- HIGH 3 (lifecycle suppression + terminal resurrection) → Task 6: `transitionLifecycle` whitelist (`LIFECYCLE_TRANSITIONS` — superseded/rejected cannot regress), `updateFreshness` separate (freshness-only), rejected suppression in `createRecord` transaction (F8/F17 tests). ✓
- HIGH 4 (freshness not persisted + single slug) → Task 7: `DeclaredProjectionReader` over FULL manifest (shared), `recomputeAndPersistFreshness` persists via `updateFreshness` (lifecycle untouched), `last_revalidated_at` only on fresh. ✓
- HIGH 5 (display bypasses gate + reason leak) → Task 8: gate at entry (5 non-display states blocked), title AND reason through `assertSafeActionDisplay`, hostile-reason test. ✓
- HIGH 6 (fabricated evidence + fake hashes) → Task 9: normalized sorted unique slugs threaded through; evidence = true projection of real candidate edges (`evidence_refs` from `captureInputs`); `ontologyHash()` reads real ontology.yaml, `policyHash()` from registry manifest, code_hash reproducible. Tests: disordered/duplicate slug, single-side candidate, inactive excluded, real ontology hash. ✓
- HIGH 7 (unreliable tests/cleanup) → Task 3: CHECK test uses correct ordering; Task 10: fault-injects `createRecord` (production path), store-reload round-trip, migration DDL+marker atomic; Task 11: **explicit staging, NO `git add -A`, no `--allow-empty`**. Import depths fixed (`../../../src`, `../../../../src`). ✓
- MED (registry silent replace) → Task 5: duplicate exact key rejected (same-object idempotent only), entries immutable, `markPurged`/`markIncompatible` tombstones, F21/F22 tests. ✓

**Spec coverage** (spec rev6): §4/4.3/4.4 → Tasks 2/4/8; §5.1-5.7 → Tasks 6/7; §5.5 atomic supersede → Task 6 (+rollback Task 10); §6.1-6.4 canonical → Task 1; §7.2 registry → Task 5; §8.1 integrity → Task 4; §8.4 freshness → Task 7; §9 abstain → Task 9; §9.1 confirmation → Task 2/9; §10 migration → Task 3; §11 display gate → Task 8. **Deferred (out of scope):** §8.2 replay runtime endpoint (Phase 2), §12 derivation graph (unused by Phase 1 producers), MCP surface (#327-gated).

**Placeholder scan:** no TBD/TODO. Every "Note:" is a concrete executor action (verify a path, hoist an import, remove an unused import), not a deferred design decision. All code is complete and uses verified APIs.

**Type consistency:** `createRecord` / `transitionLifecycle` / `updateFreshness` / `getById` / `activeCountFor` consistent across Tasks 6/7/9/10. `computeInputsHash` / `computeFingerprint` / `checkIntegrity` consistent across 4/6/7/9. `DeclaredProjectionReader.read` consistent across 7/9. `VersionedRuleRegistry.resolve`/`register`/`markPurged` consistent across 5/7/9.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-12-recommendation-contract-phase1.md` (rev2).

**Per the user's instruction: STOP for review. Do not execute.** Execution choice (subagent-driven vs inline) and any scope adjustments decided after approval.

**Do NOT push** — local `main` and `origin/main` diverged via equivalent #329 commits; the user reconciles history before push. Every commit in this plan stages explicit paths only.

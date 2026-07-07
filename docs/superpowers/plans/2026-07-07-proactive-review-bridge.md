# proactive_connection Phase 2 — Compounding Review Bridge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bridge high-quality pending `proactive_connection` discoveries into the existing Compounding Review system via `get_compounding_reviews` only, preserving every default-quiet guarantee.

**Architecture:** A new adapter module (`proactive-review-bridge.ts`) reads pending proactive discoveries, maps #311 scoring into the 5 review gates (persistence gate is the quietness lever), sanitizes display to anonymous count-templated text, and upserts them as `supported_connection` candidates. `act_on_review_candidate` best-effort syncs the source discovery lifecycle. No schema migration; no second review framework.

**Tech Stack:** TypeScript (strict), Bun, bun:sqlite, Zod, MCP SDK.

**Spec:** `docs/superpowers/specs/2026-07-07-proactive-review-bridge-design.md`

---

## Execution rules

- **TDD per task**: write the RED test first (anonymous sentinels only — `entity-alpha`, `entity-beta`, `concept-x`, `session-s1`; NO real names/slugs/paths/secrets, NO `宏哥`, NO credential-like strings even in negative assertions), watch it fail, then GREEN. No production code without a failing test.
- **Worktree absolute paths**: every Read/Edit/Write inside the worktree uses the worktree absolute path; relative paths land in the main repo (memory `worktree-relative-write-main-repo`). Re-Read in-worktree before Edit even if main repo was read (memory `worktree-edit-needs-worktree-read`).
- **Surgical diffs**: match existing style (no semicolons in TS per house style; biome lint is on). Clean only the dead code this change creates.
- **No push, no close**: commit on the worktree branch only; do not push, do not close #312. Hand back for review.
- **Gates**: `bun run lint` (tsc + biome) + `bun test` must both pass; `bun run check` runs both.
- **Spec + plan are committed deliverables** for #312 (precedent: #310 `5659bae`, #311 `36c658d`).

## Files

**Source (create / edit)**
- Create: `src/core/maintenance/proactive-review-bridge.ts` — pure score mapping + pure display builder + promotion adapter + lifecycle sync helper.
- Edit: `src/core/safety/display-safety.ts` — add non-throwing `sanitizeDisplayText(text, fallback)` (shared; the throwing `assertSafeActionDisplay` already establishes this module owns display guards).
- Edit: `src/mcp/tools/compounding-review.ts` — `get_compounding_reviews` gains `refreshProactive?: boolean` (default true, applied with `?? true` because the SDK does not reapply zod `.default()` — memory `mcp-zod-default-not-reapplied`); `act_on_review_candidate` calls the sync helper after a successful transition.

**Tests (create / edit)**
- Create: `tests/core/maintenance/proactive-review-bridge.test.ts` — score mapping (incl. fail-closed), display builder (incl. secrecy), promotion (idempotency / dedup / weak-skip / pending-only / beyond-default-limit), sync (mapping / fail-open / reverse-lookup / defer-no-op).
- Edit: `tests/mcp/compounding-review.test.ts` (new file — no MCP test exists for these tools today) — `refreshProactive:true` promotes, `refreshProactive:false` is pure-read (no bridge call, zero writes), `act_on_review_candidate` syncs discovery lifecycle + fail-open when source missing + no page/link side effects.
- Edit: `tests/core/safety/display-safety.test.ts` (if exists; else add to the bridge test file) — `sanitizeDisplayText` returns fallback on unsafe, text otherwise.

The 4-file `git grep -l proactive_connection -- src/` invariant from #311 becomes 5 files (adds `proactive-review-bridge.ts`); this is expected and the structural test in `tests/core/maintenance/proactive-connection.test.ts` must be updated to allow-list the new file (it asserts the source-confinement of the *producer lane*; the bridge is the deliberate opt-in promotion path). Verify the exact assertion at execution time and add `proactive-review-bridge.ts` to its allow-list.

---

## Task 1: Worktree + baseline

**Files:** none

- [ ] **Step 1: Create worktree**
  Run: `EnterWorktree` → name `feat-312-review-bridge`.
- [ ] **Step 2: Confirm baseline green**
  Run (in worktree): `bun install && bun run lint && bun test`
  Expected: lint clean; all existing tests pass. If `node_modules` missing → `bun install` first (memory `worktree-fresh-node-modules-gate`).
- [ ] **Step 3: Verify spec+plan are present** (committed on main before worktree)
  Run: `ls docs/superpowers/specs/2026-07-07-proactive-review-bridge-design.md docs/superpowers/plans/2026-07-07-proactive-review-bridge.md`
  Expected: both exist. If missing, the worktree branched before the doc commits — rebase onto local main.

---

## Task 2: Non-throwing sanitize helper (display-safety.ts)

**Files:**
- Modify: `src/core/safety/display-safety.ts` (append after `assertSafeActionDisplay`)
- Test: `tests/core/maintenance/proactive-review-bridge.test.ts` (top of file — see Step 1)

- [ ] **Step 1: Write the failing test** (in the new bridge test file)

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { sanitizeDisplayText } from "../../../src/core/safety/display-safety.js";

describe("sanitizeDisplayText", () => {
  test("returns text when safe", () => {
    expect(sanitizeDisplayText("2026-06-01", "")).toBe("2026-06-01");
    expect(sanitizeDisplayText("正常文本", "fallback")).toBe("正常文本");
  });
  test("returns fallback when a hostile pattern matches", () => {
    expect(sanitizeDisplayText("DROP TABLE pages; --", "X")).toBe("X");
    expect(sanitizeDisplayText("/etc/passwd", "X")).toBe("X");
    expect(sanitizeDisplayText("score: 0.9 dedup_key", "X")).toBe("X");
  });
});
```

- [ ] **Step 2: Run test → FAIL**
  Run: `bun test tests/core/maintenance/proactive-review-bridge.test.ts`
  Expected: FAIL — `sanitizeDisplayText` is not exported.
- [ ] **Step 3: Implement**

Append to `src/core/safety/display-safety.ts`:

```typescript
export function sanitizeDisplayText(text: string, fallback: string): string {
  for (const pattern of DISPLAY_UNSAFE_PATTERNS) {
    if (pattern.test(text)) return fallback
  }
  return text
}
```

- [ ] **Step 4: Run test → PASS**
  Run: `bun test tests/core/maintenance/proactive-review-bridge.test.ts`
  Expected: PASS.
- [ ] **Step 5: Commit**
  `git add src/core/safety/display-safety.ts tests/core/maintenance/proactive-review-bridge.test.ts && git commit -m "feat(safety): add non-throwing sanitizeDisplayText helper (#312)"`

---

## Task 3: Pure score mapping — `mapProactiveToReviewScores`

**Files:**
- Create: `src/core/maintenance/proactive-review-bridge.ts`
- Test: `tests/core/maintenance/proactive-review-bridge.test.ts`

- [ ] **Step 1: Write the failing tests** (append to the bridge test file)

```typescript
import {
  mapProactiveToReviewScores,
  PROACTIVE_REVIEW_TITLE,
  REVIEW_ACTION_VALUE,
} from "../../../src/core/maintenance/proactive-review-bridge.js";

function meta(opts: Partial<{
  sn: number; co: number; timelineRefs: unknown[]; novelty: number; risk: number;
}> = {}) {
  return {
    source: "proactive_connection",
    signals: { shared_neighbors: opts.sn ?? 3, cooccurring_sessions: opts.co ?? 1, timeline_proximity_days: null },
    evidence: {
      shared_neighbor_slugs: ["concept-x"],
      timeline_event_refs: opts.timelineRefs ?? [{ slug: "entity-alpha", eventId: 1, eventDate: "2026-06-01" }],
      cooccurring_session_refs: ["session-s1"],
    },
    scoring: {
      evidence_strength: 0.85, novelty: opts.novelty ?? 0.9, recurrence: 0.2,
      actionability: 0.2, risk: opts.risk ?? 0.1, quality: 0.7, gate_path: "strong_corroborated", weights: {},
    },
    pivot: "recently_ingested",
  };
}

describe("mapProactiveToReviewScores", () => {
  test("strong pair + both supporting signals → evidence/persistence pass all gates", () => {
    const s = mapProactiveToReviewScores(meta({ sn: 3, co: 1, timelineRefs: [{ slug: "a", eventId: 1, eventDate: "2026-06-01" }] }), 1)!;
    expect(s).not.toBeNull();
    expect(s.evidence).toBeGreaterThanOrEqual(3);   // 3 + 2 supporting
    expect(s.persistence).toBeGreaterThanOrEqual(2); // dual corroboration → 1+1=2
    expect(s.novelty).toBe(0.9);
    expect(s.action_value).toBe(REVIEW_ACTION_VALUE);
    expect(s.trust_risk).toBe(0.1);
  });

  test("one-shot detection without dual corroboration → persistence FAILS gate", () => {
    // occurrence=1, timeline present but NO co-occurrence → no dual corroboration
    const s = mapProactiveToReviewScores(meta({ sn: 3, co: 0, timelineRefs: [{ slug: "a", eventId: 1, eventDate: "2026-06-01" }] }), 1)!;
    expect(s.persistence).toBe(1); // min(1,2)=1 + 0 → fails ≥2 (the tightness lever)
    expect(s.evidence).toBeGreaterThanOrEqual(3);
  });

  test("recurrence alone (occurrence≥2, no dual) → persistence passes", () => {
    const s = mapProactiveToReviewScores(meta({ sn: 3, co: 0, timelineRefs: [] }), 2)!;
    expect(s.persistence).toBe(2); // min(2,2)=2 + 0
  });

  test("returns null when signals missing (fail-closed)", () => {
    expect(mapProactiveToReviewScores({ source: "proactive_connection" }, 1)).toBeNull();
    expect(mapProactiveToReviewScores(null, 1)).toBeNull();
  });

  test("returns null when scoring.novelty/risk missing (fail-closed)", () => {
    const m = meta();
    delete (m.scoring as Record<string, unknown>).novelty;
    expect(mapProactiveToReviewScores(m, 1)).toBeNull();
  });

  test("returns null when metadata is malformed (gate attack #6)", () => {
    expect(mapProactiveToReviewScores("not-an-object", 1)).toBeNull();
    expect(mapProactiveToReviewScores({ signals: "nope" }, 1)).toBeNull();
  });
});
```

- [ ] **Step 2: Run → FAIL** (`bun test tests/core/maintenance/proactive-review-bridge.test.ts`) — module not found.
- [ ] **Step 3: Implement** — create `src/core/maintenance/proactive-review-bridge.ts`:

```typescript
import type { CBrainDB, CandidateRow, FeedbackAction } from "../../storage/sqlite.js";
import type { CompoundingReviewManager } from "./compounding-review.js";
import { sanitizeDisplayText } from "../safety/display-safety.js";

export const PROACTIVE_DISCOVERY_TYPE = "proactive_connection";
export const PROACTIVE_CANDIDATE_TYPE = "supported_connection" as const;
export const PROACTIVE_REVIEW_TITLE = "潜在连接候选";
export const REVIEW_ACTION_VALUE = 0.5;
export const PROMOTION_LIMIT = 20;
export const LIFECYCLE_LOOKUP_LIMIT = 5000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function asNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * D4 — map #311 proactive scoring into the 5 compounding-review gates.
 * Returns null on any malformed/missing field so the adapter skips fail-closed.
 * persistence is the tightness lever: requires recurrence (occurrence≥2) OR
 * dual corroboration (timeline + co-occurrence both present).
 */
export function mapProactiveToReviewScores(
  metadata: unknown,
  occurrenceCount: number,
): Record<string, number> | null {
  if (!isRecord(metadata)) return null;
  const { signals, scoring, evidence } = metadata;
  if (!isRecord(signals) || !isRecord(scoring) || !isRecord(evidence)) return null;

  const sharedNeighbors = asNum(signals.shared_neighbors);
  const cooccurring = asNum(signals.cooccurring_sessions);
  if (sharedNeighbors === null || cooccurring === null) return null;

  const novelty = asNum(scoring.novelty);
  const risk = asNum(scoring.risk);
  if (novelty === null || risk === null) return null;

  const timelineRefs = Array.isArray(evidence.timeline_event_refs) ? evidence.timeline_event_refs : [];
  const hasTimeline = timelineRefs.length >= 1;
  const hasCooccur = cooccurring >= 1;
  const supporting = (hasCooccur ? 1 : 0) + (hasTimeline ? 1 : 0);

  const evidenceScore = sharedNeighbors + supporting; // gate ≥3
  const dualCorroboration = hasTimeline && hasCooccur;
  const occ = Math.min(Math.max(Math.floor(occurrenceCount), 0), 2);
  const persistence = occ + (dualCorroboration ? 1 : 0); // gate ≥2

  return {
    evidence: evidenceScore,
    persistence,
    novelty,
    action_value: REVIEW_ACTION_VALUE,
    trust_risk: risk,
  };
}
```

- [ ] **Step 4: Run → PASS**.
- [ ] **Step 5: Commit** — `git commit -m "feat(review-bridge): pure proactive→review score mapping (#312)"` (add both files).

---

## Task 4: Pure display builder — `buildReviewCandidateDisplay`

**Files:**
- Modify: `src/core/maintenance/proactive-review-bridge.ts`
- Test: `tests/core/maintenance/proactive-review-bridge.test.ts`

- [ ] **Step 1: Write failing tests** (append)

```typescript
import { buildReviewCandidateDisplay } from "../../../src/core/maintenance/proactive-review-bridge.js";

describe("buildReviewCandidateDisplay", () => {
  test("fixed anonymous title; count-templated summary; labeled evidence", () => {
    const d = buildReviewCandidateDisplay(meta({ sn: 3, co: 2, timelineRefs: [{ slug: "entity-alpha", eventId: 7, eventDate: "2026-06-01" }] }))!;
    expect(d.title).toBe(PROACTIVE_REVIEW_TITLE);
    expect(d.summary).toContain("3");
    expect(d.summary).toContain("2");
    expect(d.evidence.length).toBe(3); // 共同上下文 + 共现会话 + 时间线邻近
    expect(d.evidence.map((e) => e.source).sort()).toEqual(["共现会话", "共同上下文", "时间线邻近"]);
  });

  test("no raw slugs / event ids / session refs / scores leak into display", () => {
    const d = buildReviewCandidateDisplay(meta({ sn: 3, co: 1, timelineRefs: [{ slug: "entity-alpha", eventId: 99, eventDate: "2026-06-01" }] }))!;
    const blob = JSON.stringify(d);
    expect(blob).not.toContain("entity-alpha");
    expect(blob).not.toContain("concept-x");
    expect(blob).not.toContain("session-s1");
    expect(blob).not.toContain("eventId");
    expect(blob).not.toContain("score");
    expect(blob).not.toContain("dedup_key");
  });

  test("hostile eventDate is sanitized to empty dateRange (privacy attack #4)", () => {
    const d = buildReviewCandidateDisplay(meta({ sn: 3, co: 1, timelineRefs: [{ slug: "a", eventId: 1, eventDate: "DROP TABLE pages; --" }] }))!;
    const tl = d.evidence.find((e) => e.source === "时间线邻近")!;
    expect(tl.dateRange).toBe("");
  });

  test("returns null on malformed metadata", () => {
    expect(buildReviewCandidateDisplay(null)).toBeNull();
    expect(buildReviewCandidateDisplay({ signals: {} })).toBeNull();
  });
});
```

- [ ] **Step 2: Run → FAIL** (`buildReviewCandidateDisplay` not exported).
- [ ] **Step 3: Implement** — append to `proactive-review-bridge.ts`:

```typescript
export interface ReviewCandidateDisplay {
  title: string;
  summary: string;
  evidence: Array<{ source: string; dateRange: string; text: string }>;
}

/**
 * D5 — build anonymous, review-safe display. Fixed title (stable hash);
 * count-templated summary; labeled evidence with NO raw slugs / ids / scores.
 * The only external string is eventDate, which is sanitized.
 */
export function buildReviewCandidateDisplay(metadata: unknown): ReviewCandidateDisplay | null {
  if (!isRecord(metadata)) return null;
  const { signals, evidence } = metadata;
  if (!isRecord(signals) || !isRecord(evidence)) return null;
  const sharedNeighbors = asNum(signals.shared_neighbors);
  const cooccurring = asNum(signals.cooccurring_sessions);
  if (sharedNeighbors === null || cooccurring === null) return null;

  const timelineRefs = Array.isArray(evidence.timeline_event_refs) ? evidence.timeline_event_refs : [];

  const summary = `两条记忆通过 ${sharedNeighbors} 个共同邻居与 ${cooccurring} 次共现形成连接，值得复盘是否建立显式关联。`;

  const items: Array<{ source: string; dateRange: string; text: string }> = [
    { source: "共同上下文", dateRange: "", text: `${sharedNeighbors} 个共同连接的条目` },
  ];
  if (cooccurring >= 1) {
    items.push({ source: "共现会话", dateRange: "", text: `${cooccurring} 次共同出现` });
  }
  if (timelineRefs.length >= 1) {
    const first = timelineRefs.find(isRecord);
    const raw = first ? (typeof first.eventDate === "string" ? first.eventDate : "") : "";
    items.push({
      source: "时间线邻近",
      dateRange: sanitizeDisplayText(raw, ""),
      text: "存在时间线上的邻近事件",
    });
  }

  return { title: PROACTIVE_REVIEW_TITLE, summary, evidence: items.slice(0, 3) };
}
```

- [ ] **Step 4: Run → PASS**.
- [ ] **Step 5: Commit** — `git commit -m "feat(review-bridge): anonymous display builder with secrecy (#312)"`.

---

## Task 5: Promotion adapter — `promoteProactiveCandidatesToReview`

**Files:**
- Modify: `src/core/maintenance/proactive-review-bridge.ts`
- Test: `tests/core/maintenance/proactive-review-bridge.test.ts`

- [ ] **Step 1: Write failing tests** (append; needs CBrainDB + CompoundingReviewManager)

```typescript
import { rmSync, mkdtempSync } from "node:fs";   // MEDIUM #3: mkdtemp per-test
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CBrainDB } from "../../../src/storage/sqlite.js";
import { CompoundingReviewManager } from "../../../src/core/maintenance/compounding-review.js";
import { promoteProactiveCandidatesToReview } from "../../../src/core/maintenance/proactive-review-bridge.js";

const promoDirs: string[] = [];
function makeDb(): CBrainDB {
  // mkdtemp per call — no fixed dir (MEDIUM #3: avoids concurrency / crash-leave pollution).
  const dir = mkdtempSync(join(tmpdir(), "cbrain-test-prb-promo-"));
  promoDirs.push(dir);
  return new CBrainDB(join(dir, "t.sqlite"));
}
function seedProactive(db: CBrainDB, entities: string[], opts: Partial<{ sn: number; co: number; timeline: boolean; novelty: number; risk: number; quality: number; }> = {}) {
  const m = {
    source: "proactive_connection",
    signals: { shared_neighbors: opts.sn ?? 3, cooccurring_sessions: opts.co ?? 1, timeline_proximity_days: null },
    evidence: {
      shared_neighbor_slugs: ["concept-x"],
      timeline_event_refs: opts.timeline === false ? [] : [{ slug: "entity-alpha", eventId: 1, eventDate: "2026-06-01" }],
      cooccurring_session_refs: opts.co ? ["session-s1"] : [],
    },
    scoring: { evidence_strength: 0.85, novelty: opts.novelty ?? 0.9, recurrence: 0.2, actionability: 0.2, risk: opts.risk ?? 0.1, quality: opts.quality ?? 0.7, gate_path: "strong_corroborated", weights: {} },
    pivot: "recently_ingested",
  };
  return db.upsertDiscovery("proactive_connection", entities, opts.quality ?? 0.7, undefined, undefined, "low", false, m);
}

describe("promoteProactiveCandidatesToReview", () => {
  afterEach(() => { for (const d of promoDirs) rmSync(d, { recursive: true, force: true }); promoDirs.length = 0; });

  test("strong pending discovery → 1 supported_connection candidate (acceptance #1)", () => {
    const db = makeDb(); const mgr = new CompoundingReviewManager(db);
    seedProactive(db, ["entity-alpha", "entity-beta"], { sn: 3, co: 1, timeline: true });
    const r = promoteProactiveCandidatesToReview(db, mgr);
    expect(r.promoted).toBe(1);
    const list = mgr.listCandidates({ includeDeferred: true, limit: 50 });
    expect(list.length).toBe(1);
    expect(list[0].candidate_type).toBe("supported_connection");
    expect(list[0].source_slugs_json).toBe(JSON.stringify(["entity-alpha", "entity-beta"]));
    db.close();
  });

  test("promoting twice is idempotent — no duplicate, only timestamp bump (acceptance #3, attack #1)", () => {
    const db = makeDb(); const mgr = new CompoundingReviewManager(db);
    seedProactive(db, ["entity-alpha", "entity-beta"]);
    promoteProactiveCandidatesToReview(db, mgr);
    const r2 = promoteProactiveCandidatesToReview(db, mgr);
    expect(r2.promoted).toBe(0);
    expect(mgr.count()).toBeLessThanOrEqual(1);
    expect(mgr.listCandidates({ includeDeferred: true, limit: 50 }).length).toBe(1);
    db.close();
  });

  test("one-shot weak-persistence discovery NOT written — gate precheck (HIGH #1, acceptance #2)", () => {
    const db = makeDb(); const mgr = new CompoundingReviewManager(db);
    // occurrence=1, no timeline, no co-occurrence → persistence=1 → fails gate ≥2
    seedProactive(db, ["entity-alpha", "entity-beta"], { sn: 3, co: 0, timeline: false });
    const r = promoteProactiveCandidatesToReview(db, mgr);
    // Weak candidate must NOT enter the candidate table at all (gate precheck).
    expect(r.promoted).toBe(0);
    expect(r.skipped).toBeGreaterThanOrEqual(1);
    expect(mgr.listCandidates({ includeDeferred: true, limit: 50 }).length).toBe(0);
    db.close();
  });

  test("low-trust-risk discovery NOT written — every gate dimension prechecked", () => {
    const db = makeDb(); const mgr = new CompoundingReviewManager(db);
    // Strong on persistence/evidence but risk above the ≤0.3 gate → must skip.
    seedProactive(db, ["entity-alpha", "entity-beta"], { sn: 3, co: 1, timeline: true, risk: 0.9 });
    const r = promoteProactiveCandidatesToReview(db, mgr);
    expect(r.promoted).toBe(0);
    expect(r.skipped).toBeGreaterThanOrEqual(1);
    expect(mgr.listCandidates({ includeDeferred: true, limit: 50 }).length).toBe(0);
    db.close();
  });

  test("dismissed/resolved discoveries are NOT promoted (acceptance #2)", () => {
    const db = makeDb(); const mgr = new CompoundingReviewManager(db);
    const { id } = seedProactive(db, ["entity-alpha", "entity-beta"]);
    db.updateDiscoveryStatus(id, "dismissed");
    const r = promoteProactiveCandidatesToReview(db, mgr);
    expect(r.promoted).toBe(0);
    expect(mgr.listCandidates({ includeDeferred: true, limit: 50 }).length).toBe(0);
    db.close();
  });

  test("malformed-metadata discovery skipped fail-closed (attack #6)", () => {
    const db = makeDb(); const mgr = new CompoundingReviewManager(db);
    db.upsertDiscovery("proactive_connection", ["entity-alpha", "entity-beta"], 0.7, undefined, undefined, "low", false, { source: "proactive_connection" /* no signals/scoring */ });
    const r = promoteProactiveCandidatesToReview(db, mgr);
    expect(r.promoted).toBe(0);
    expect(r.skipped).toBeGreaterThanOrEqual(1);
    db.close();
  });
});
```

- [ ] **Step 2: Run → FAIL** (`promoteProactiveCandidatesToReview` not exported).
- [ ] **Step 3: Implement** — append to `proactive-review-bridge.ts`.

  **Design note (HIGH #1 fix):** promotion MUST precheck the review gates — a
  weak candidate (any mapped score below its gate threshold) is NOT written to
  `compounding_review_candidates` (`skipped++`), per acceptance #2 "weak not
  promoted". Import `GATE` from `compounding-review.ts` so the thresholds are a
  single source of truth; `ReviewGenerator` still applies the gates at read time
  as defense-in-depth. Add to the import block at the top of the file:

```typescript
import { GATE } from "./compounding-review.js";
```

  Then append:

```typescript
export interface PromotionResult {
  promoted: number;
  skipped: number;
  seen: number;
}

function qualityOf(meta: unknown): number {
  if (!isRecord(meta) || !isRecord(meta.scoring)) return 0;
  return asNum((meta.scoring as Record<string, unknown>).quality) ?? 0;
}

/**
 * D4 gate precheck — mirrors ReviewGenerator.evaluateGates at write time so weak
 * candidates never enter the candidate table (acceptance #2). trust_risk is a
 * "lower is better" dimension (gate is an upper bound), inverted vs the others.
 */
export function passesReviewGate(scores: Record<string, number>): boolean {
  return (
    (scores.evidence ?? 0) >= GATE.evidence &&
    (scores.persistence ?? 0) >= GATE.persistence &&
    (scores.novelty ?? 0) >= GATE.novelty &&
    (scores.action_value ?? 0) >= GATE.action_value &&
    (scores.trust_risk ?? 1) <= GATE.trust_risk
  );
}

/**
 * D1/D6 — read pending proactive discoveries, map scores + display, upsert as
 * supported_connection candidates. Idempotent via content_hash (fixed title +
 * sorted entity pair). Processes highest-quality first, capped at PROMOTION_LIMIT.
 *
 * Pre-loop filter is status==='pending' ONLY. All validity checks (malformed
 * metadata, gate fail, entities≠2) happen IN the loop so every skipped row is
 * counted — none vanish silently into a chain filter (HIGH #2). Weak candidates
 * fail the gate precheck and are skipped, never written (HIGH #1).
 */
export function promoteProactiveCandidatesToReview(
  db: CBrainDB,
  mgr: CompoundingReviewManager,
): PromotionResult {
  const rows = db.getDiscoveryLifecycleIndex(PROACTIVE_DISCOVERY_TYPE, LIFECYCLE_LOOKUP_LIMIT);

  const pending = rows
    .filter((r) => r.status === "pending")
    .map((r) => {
      let meta: unknown = null;
      try { meta = r.metadata ? JSON.parse(r.metadata) : null; } catch { meta = null; }
      return { r, meta, occ: r.occurrence_count };
    })
    .sort((a, b) => qualityOf(b.meta) - qualityOf(a.meta))
    .slice(0, PROMOTION_LIMIT);

  let promoted = 0;
  let skipped = 0;
  let seen = 0;
  for (const x of pending) {
    const scores = mapProactiveToReviewScores(x.meta, x.occ);
    const display = buildReviewCandidateDisplay(x.meta);
    if (!scores || !display) { skipped++; continue; }         // malformed → fail-closed
    if (!passesReviewGate(scores)) { skipped++; continue; }   // weak → not promoted (HIGH #1)
    let entities: unknown = [];
    try { entities = JSON.parse(x.r.entities); } catch { entities = []; }
    if (!Array.isArray(entities) || entities.length !== 2) { skipped++; continue; }
    const sourceSlugs = [...(entities as string[])].sort();

    const { isNew } = mgr.upsertCandidate({                   // use return value, not count() delta (MEDIUM #4)
      title: display.title,
      candidateType: PROACTIVE_CANDIDATE_TYPE,
      summary: display.summary,
      evidence: display.evidence,
      scores,
      sourceSlugs,
    });
    if (isNew) promoted++; else seen++;
  }
  return { promoted, skipped, seen };
}
```

- [ ] **Step 4: Run → PASS**.
- [ ] **Step 5: Commit** — `git commit -m "feat(review-bridge): idempotent promotion adapter (#312)"`.

---

## Task 6: Lifecycle sync helper — `syncProactiveDiscoveryOnReviewAction`

**Files:**
- Modify: `src/core/maintenance/proactive-review-bridge.ts`
- Test: `tests/core/maintenance/proactive-review-bridge.test.ts`

- [ ] **Step 1: Write failing tests** (append)

```typescript
import { syncProactiveDiscoveryOnReviewAction } from "../../../src/core/maintenance/proactive-review-bridge.js";

const syncDirs: string[] = [];
function makeSyncDb(): CBrainDB {
  const dir = mkdtempSync(join(tmpdir(), "cbrain-test-prb-sync-")); // MEDIUM #3
  syncDirs.push(dir);
  return new CBrainDB(join(dir, "t.sqlite"));
}
function bridgeCandidate(mgr: CompoundingReviewManager, pair: string[]) {
  return mgr.upsertCandidate({
    title: PROACTIVE_REVIEW_TITLE,
    candidateType: "supported_connection",
    summary: "两条记忆通过 3 个共同邻居与 1 次共现形成连接。",
    evidence: [{ source: "共同上下文", dateRange: "", text: "3 个共同连接的条目" }],
    scores: { evidence: 5, persistence: 2, novelty: 0.9, action_value: 0.5, trust_risk: 0.1 },
    sourceSlugs: [...pair].sort(),
  });
}

describe("syncProactiveDiscoveryOnReviewAction", () => {
  beforeEach(() => {});
  afterEach(() => { for (const d of syncDirs) rmSync(d, { recursive: true, force: true }); syncDirs.length = 0; });

  test("accept → source discovery resolved (acceptance #5)", () => {
    const db = makeSyncDb(); const mgr = new CompoundingReviewManager(db);
    const { id: dId } = seedProactive(db, ["entity-alpha", "entity-beta"]);
    const { id: cId } = bridgeCandidate(mgr, ["entity-alpha", "entity-beta"]);
    const cand = mgr.getCandidate(cId)!;
    const r = syncProactiveDiscoveryOnReviewAction(db, cand, "accept");
    expect(r.synced).toBe(true);
    const d = db.getDiscoveryLifecycleIndex("proactive_connection", 50).find((x) => x.id === dId)!;
    expect(d.status).toBe("resolved");
    db.close();
  });

  test("reject / disable → source discovery dismissed", () => {
    const db = makeSyncDb(); const mgr = new CompoundingReviewManager(db);
    const { id: dId } = seedProactive(db, ["entity-alpha", "entity-beta"]);
    const { id: cId } = bridgeCandidate(mgr, ["entity-alpha", "entity-beta"]);
    for (const action of ["reject", "disable"] as const) {
      const r = syncProactiveDiscoveryOnReviewAction(db, mgr.getCandidate(cId)!, action);
      expect(r.synced).toBe(true);
    }
    const d = db.getDiscoveryLifecycleIndex("proactive_connection", 50).find((x) => x.id === dId)!;
    expect(d.status).toBe("dismissed");
    db.close();
  });

  test("defer → source discovery stays pending (D8 decision, hard constraint #7)", () => {
    const db = makeSyncDb(); const mgr = new CompoundingReviewManager(db);
    const { id: dId } = seedProactive(db, ["entity-alpha", "entity-beta"]);
    const { id: cId } = bridgeCandidate(mgr, ["entity-alpha", "entity-beta"]);
    const r = syncProactiveDiscoveryOnReviewAction(db, mgr.getCandidate(cId)!, "defer");
    expect(r.synced).toBe(false);
    expect(r.reason).toBe("defer_no_op");
    const d = db.getDiscoveryLifecycleIndex("proactive_connection", 50).find((x) => x.id === dId)!;
    expect(d.status).toBe("pending");
    db.close();
  });

  test("source missing → fail-open, no throw, no rollback signal (hard constraint #9)", () => {
    const db = makeSyncDb(); const mgr = new CompoundingReviewManager(db);
    // candidate whose pair has NO matching discovery
    const { id: cId } = bridgeCandidate(mgr, ["entity-gamma", "entity-delta"]);
    const r = syncProactiveDiscoveryOnReviewAction(db, mgr.getCandidate(cId)!, "accept");
    expect(r.synced).toBe(false);
    expect(r.reason).toBe("source_not_found");
    db.close();
  });

  test("non-proactive candidate → no-op", () => {
    const db = makeSyncDb(); const mgr = new CompoundingReviewManager(db);
    const { id } = mgr.upsertCandidate({ title: "主题观察", candidateType: "theme_convergence", sourceSlugs: ["a", "b"] });
    const r = syncProactiveDiscoveryOnReviewAction(db, mgr.getCandidate(id)!, "accept");
    expect(r.synced).toBe(false);
    expect(r.reason).toBe("not_proactive");
    db.close();
  });

  test("reverse-lookup finds discovery beyond the default lifecycle limit of 500 (limit hardening)", () => {
    const db = makeSyncDb(); const mgr = new CompoundingReviewManager(db);
    // Seed 510 discoveries; the target is the FIRST inserted (lowest id, last in DESC order).
    let targetId = -1;
    for (let i = 0; i < 510; i++) {
      const pair = [`entity-${i}-a`, `entity-${i}-b`];
      const res = seedProactive(db, pair);
      if (i === 0) targetId = res.id;
    }
    const { id: cId } = bridgeCandidate(mgr, ["entity-0-a", "entity-0-b"]);
    const r = syncProactiveDiscoveryOnReviewAction(db, mgr.getCandidate(cId)!, "accept");
    expect(r.synced).toBe(true);
    const d = db.getDiscoveryLifecycleIndex("proactive_connection", 1000).find((x) => x.id === targetId)!;
    expect(d.status).toBe("resolved");
    db.close();
  });
});
```

- [ ] **Step 2: Run → FAIL** (`syncProactiveDiscoveryOnReviewAction` not exported).
- [ ] **Step 3: Implement** — append to `proactive-review-bridge.ts`:

```typescript
export interface SyncResult {
  synced: boolean;
  reason: string;
}

/**
 * D8 — best-effort sync of the source proactive discovery lifecycle after a
 * successful review action. accept→resolved, reject/disable→dismissed,
 * defer→no-op (discovery stays pending). Fail-open: any failure returns
 * {synced:false} and NEVER throws — candidate status is authoritative.
 */
export function syncProactiveDiscoveryOnReviewAction(
  db: CBrainDB,
  candidate: CandidateRow,
  action: FeedbackAction,
): SyncResult {
  if (candidate.candidate_type !== PROACTIVE_CANDIDATE_TYPE) {
    return { synced: false, reason: "not_proactive" };
  }
  let slugs: unknown = null;
  try { slugs = candidate.source_slugs_json ? JSON.parse(candidate.source_slugs_json) : null; } catch { slugs = null; }
  if (!Array.isArray(slugs) || slugs.length !== 2) {
    return { synced: false, reason: "no_pair" };
  }
  if (action === "defer") {
    return { synced: false, reason: "defer_no_op" };
  }
  let discoveryStatus: "resolved" | "dismissed";
  if (action === "accept") discoveryStatus = "resolved";
  else if (action === "reject" || action === "disable") discoveryStatus = "dismissed";
  else return { synced: false, reason: "action_unmapped" };

  const pair = [...(slugs as string[])].sort();
  try {
    const rows = db.getDiscoveryLifecycleIndex(PROACTIVE_DISCOVERY_TYPE, LIFECYCLE_LOOKUP_LIMIT);
    const match = rows.find((r) => {
      let ents: unknown = [];
      try { ents = JSON.parse(r.entities); } catch { return false; }
      if (!Array.isArray(ents)) return false;
      const sorted = [...(ents as string[])].sort();
      return sorted.length === pair.length && sorted.every((v, i) => v === pair[i]);
    });
    if (!match) return { synced: false, reason: "source_not_found" };
    db.updateDiscoveryStatus(match.id, discoveryStatus);
    return { synced: true, reason: discoveryStatus };
  } catch {
    return { synced: false, reason: "error" };
  }
}
```

- [ ] **Step 4: Run → PASS**.
- [ ] **Step 5: Commit** — `git commit -m "feat(review-bridge): best-effort discovery lifecycle sync (#312)"`.

---

## Task 7: MCP wiring — `get_compounding_reviews` + `act_on_review_candidate`

**Files:**
- Modify: `src/mcp/tools/compounding-review.ts`
- Create: `tests/mcp/compounding-review.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";

const mcpDirs: string[] = [];
function mcpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cbrain-test-prb-mcp-")); // MEDIUM #3
  mcpDirs.push(dir);
  return dir;
}
afterEach(() => { for (const d of mcpDirs) rmSync(d, { recursive: true, force: true }); mcpDirs.length = 0; });

const FakeEmb = {
  embed: async (t: string) => ({ embedding: new Array(128).fill(0), tokenCount: t.length }),
  embedBatch: async (ts: string[]) => ts.map((t) => ({ embedding: new Array(128).fill(0), tokenCount: t.length })),
};
const FakeLance = {
  connect: async () => {}, addChunks: async () => {}, search: async () => [], fullTextSearch: async () => [],
  deleteByPageSlug: async () => {}, deleteRawChunksByPageSlug: async () => {}, close: async () => {}, createFTSIndex: async () => {},
};

async function makeServer(db: CBrainDB, dir: string) {
  const { createServer } = await import("../../src/mcp/server.js");
  return createServer({ db, embedding: FakeEmb as any, lance: FakeLance as any, vaultPath: dir, dbPath: join(dir, "t.sqlite"), runtimePath: dir });
}
// Invocation pattern per tests/mcp/hierarchy.test.ts:39-46 — _registeredTools[name].handler(args)
async function callTool(server: any, name: string, args: Record<string, unknown> = {}) {
  const tool = server._registeredTools[name];
  if (!tool) throw new Error(`Tool ${name} not found`);
  const result = await tool.handler(args);
  return { data: JSON.parse(result.content[0].text), isError: result.isError ?? false };
}

function seedProactive(db: CBrainDB, entities: string[]) {
  const meta = {
    source: "proactive_connection",
    signals: { shared_neighbors: 3, cooccurring_sessions: 1, timeline_proximity_days: null },
    evidence: { shared_neighbor_slugs: ["concept-x"], timeline_event_refs: [{ slug: "entity-alpha", eventId: 1, eventDate: "2026-06-01" }], cooccurring_session_refs: ["session-s1"] },
    scoring: { evidence_strength: 0.85, novelty: 0.9, recurrence: 0.2, actionability: 0.2, risk: 0.1, quality: 0.7, gate_path: "strong_corroborated", weights: {} },
    pivot: "recently_ingested",
  };
  return db.upsertDiscovery("proactive_connection", entities, 0.7, undefined, undefined, "low", false, meta);
}
function candidateCount(db: CBrainDB): number {
  return (db.rawDb.query("SELECT COUNT(*) as c FROM compounding_review_candidates").get() as { c: number }).c;
}

describe("get_compounding_reviews — refreshProactive", () => {
  test("default (no arg) bridges a strong proactive discovery into review output", async () => {
    const dir = mcpDir();
    const db = new CBrainDB(join(dir, "t.sqlite"));
    seedProactive(db, ["entity-alpha", "entity-beta"]);
    const server = await makeServer(db, dir);
    const { data } = await callTool(server, "get_compounding_reviews", {});
    expect(data.items.length).toBe(1);
    expect(data.items[0].candidate_type).toBe("supported_connection");
    db.close();
  });

  test("refreshProactive:false is pure read — zero candidate writes (hard constraint #8)", async () => {
    const dir = mcpDir();
    const db = new CBrainDB(join(dir, "t.sqlite"));
    seedProactive(db, ["entity-alpha", "entity-beta"]);
    const before = candidateCount(db);
    const server = await makeServer(db, dir);
    const { data } = await callTool(server, "get_compounding_reviews", { refreshProactive: false });
    expect(candidateCount(db)).toBe(before); // no write
    expect(data.items.length).toBe(0); // nothing promoted → silence
    db.close();
  });
});

describe("act_on_review_candidate — discovery sync", () => {
  test("accept on a bridged candidate marks source discovery resolved (acceptance #5)", async () => {
    const dir = mcpDir();
    const db = new CBrainDB(join(dir, "t.sqlite"));
    const { id: dId } = seedProactive(db, ["entity-alpha", "entity-beta"]);
    const server = await makeServer(db, dir);
    await callTool(server, "get_compounding_reviews", {}); // promote
    const candId = (db.rawDb.query("SELECT id FROM compounding_review_candidates LIMIT 1").get() as { id: number }).id;
    const { data } = await callTool(server, "act_on_review_candidate", { id: candId, action: "accept" });
    expect(data.new_status).toBe("accepted");
    const d = db.getDiscoveryLifecycleIndex("proactive_connection", 50).find((x) => x.id === dId)!;
    expect(d.status).toBe("resolved");
    db.close();
  });

  test("act never creates pages/links (side-effect attack #5)", async () => {
    const dir = mcpDir();
    const db = new CBrainDB(join(dir, "t.sqlite"));
    seedProactive(db, ["entity-alpha", "entity-beta"]);
    const server = await makeServer(db, dir);
    await callTool(server, "get_compounding_reviews", {});
    const candId = (db.rawDb.query("SELECT id FROM compounding_review_candidates LIMIT 1").get() as { id: number }).id;
    await callTool(server, "act_on_review_candidate", { id: candId, action: "reject" });
    expect(db.listPages({ limit: 1000 }).length).toBe(0);
    expect((db.rawDb.query("SELECT COUNT(*) as c FROM links").get() as { c: number }).c).toBe(0);
    db.close();
  });

  test("source missing → fail-open: candidate status succeeds, no error (hard constraint #9)", async () => {
    const dir = mcpDir();
    const db = new CBrainDB(join(dir, "t.sqlite"));
    // Manually insert a supported_connection candidate whose pair has NO matching discovery.
    const mgr = new (await import("../../src/core/maintenance/compounding-review.js")).CompoundingReviewManager(db);
    const { id } = mgr.upsertCandidate({
      title: "潜在连接候选", candidateType: "supported_connection",
      summary: "x", scores: { evidence: 5, persistence: 2, novelty: 0.9, action_value: 0.5, trust_risk: 0.1 },
      sourceSlugs: ["entity-gamma", "entity-delta"],
    });
    const server = await makeServer(db, dir);
    const { data, isError } = await callTool(server, "act_on_review_candidate", { id, action: "accept" });
    expect(isError).toBe(false);
    expect(data.new_status).toBe("accepted"); // candidate still updated
    db.close();
  });

  test("defer then get_compounding_reviews(refreshProactive:true) → not re-emitted, no new row (hard constraint #7)", async () => {
    const dir = mcpDir();
    const db = new CBrainDB(join(dir, "t.sqlite"));
    seedProactive(db, ["entity-alpha", "entity-beta"]);
    const server = await makeServer(db, dir);
    const first = await callTool(server, "get_compounding_reviews", {}); // promote
    expect(first.data.items.length).toBe(1);
    const candId = first.data.items[0].id;
    await callTool(server, "act_on_review_candidate", { id: candId, action: "defer" });
    // Second review generation with refreshProactive defaulting true:
    const second = await callTool(server, "get_compounding_reviews", {});
    expect(second.data.items.length).toBe(0); // deferred → excluded from default output (includeDeferred:false)
    expect(candidateCount(db)).toBe(1); // no new row (idempotent upsert on the deferred candidate)
    db.close();
  });
});
```

  Note: the `_registeredTools[name].handler(args)` invocation mirrors `tests/mcp/hierarchy.test.ts:39-46`. If `createServer` returns a wrapper where `_registeredTools` is shaped differently, adapt the `callTool` helper to match — do not change the assertions.

- [ ] **Step 2: Run → FAIL** (`refreshProactive` not in schema; sync not wired).
- [ ] **Step 3: Implement** — edit `src/mcp/tools/compounding-review.ts`:

  Replace the `get_compounding_reviews` registration (lines 7-25) with:

```typescript
server.registerTool("get_compounding_reviews", {
  description:
    "生成复利洞察：只有通过全部5个门槛（证据充分性、持久性、新颖性、行动价值、信任风险）的候选才会出现在结果中。" +
    "没通过门槛的候选会被过滤，返回 silence_reason 说明原因。" +
    "默认会先把 pending 的 proactive_connection 候选桥接进来（幂等，不改动图谱）；传 refreshProactive=false 可纯读。",
  inputSchema: {
    includeDeferred: z.boolean().optional().default(false).describe("是否包含推迟的候选"),
    limit: z.number().int().min(1).max(50).optional().default(20).describe("最多扫描的候选数量（1-50）"),
    refreshProactive: z.boolean().optional().default(true).describe("是否先把 proactive_connection 候选桥接进 review（默认 true，幂等）"),
  },
}, async ({ includeDeferred, limit, refreshProactive }) => {
  const refresh = refreshProactive ?? true; // SDK 不重新应用 zod .default()，必须 ?? true
  if (refresh) {
    promoteProactiveCandidatesToReview(ctx.db, ctx.compoundingReview);
  }
  const generator = new ReviewGenerator(ctx.compoundingReview);
  const result = generator.generate({ includeDeferred, limit });
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
});
```

  In `act_on_review_candidate` (lines 36-61), after `const candidate = ctx.compoundingReview.getCandidate(id);` add:

```typescript
    if (candidate) {
      // D8 — best-effort sync of the source proactive discovery lifecycle.
      // Fail-open: return value is intentionally ignored; candidate status is authoritative.
      syncProactiveDiscoveryOnReviewAction(ctx.db, candidate, action);
    }
```

  Add imports at the top:

```typescript
import { promoteProactiveCandidatesToReview, syncProactiveDiscoveryOnReviewAction } from "../../core/maintenance/proactive-review-bridge.js";
```

- [ ] **Step 4: Run → PASS**.
- [ ] **Step 5: Commit** — `git commit -m "feat(mcp): wire proactive review bridge into compounding review tools (#312)"`.

---

## Task 8: Quiet regression + structural-invariant update

**Files:**
- Modify: `tests/core/maintenance/proactive-connection.test.ts` (the 4-file allow-list assertion — locate it, add `proactive-review-bridge.ts`)
- Test: `tests/core/maintenance/proactive-review-bridge.test.ts` (quiet-surface regression)

- [ ] **Step 1: Locate the structural assertion**
  Run (worktree): `grep -n "git grep -l proactive_connection" tests/core/maintenance/proactive-review-bridge.test.ts tests/core/maintenance/proactive-connection.test.ts`
  Expected: a test in `proactive-connection.test.ts` that asserts the allow-listed source files for `proactive_connection`. Read the exact assertion.
- [ ] **Step 2: Write the failing quiet-surface test** (append to bridge test file)

```typescript
import { buildActionCandidatesFromDiscoveries } from "../../../src/core/maintenance/action-candidates.js";

describe("quiet-surface regression (acceptance #6, attack #2)", () => {
  test("a promoted proactive discovery stays absent from next_actions action candidates", () => {
    const db = makeDb(); const mgr = new CompoundingReviewManager(db);
    seedProactive(db, ["entity-alpha", "entity-beta"], { sn: 3, co: 1, timeline: true, quality: 0.99 });
    promoteProactiveCandidatesToReview(db, mgr);
    // The discovery is still pending + actionable='low'; next_actions must skip it (G3).
    const rows = db.getUnseenDiscoveries(50);
    const actions = buildActionCandidatesFromDiscoveries(rows);
    // proactive_connection is in QUIET_DISCOVERY_TYPES → produces zero action candidates
    expect(actions.length).toBe(0);
    db.close();
  });
});
```

  (If `buildActionCandidatesFromDiscoveries` returns a different shape, adjust the assertion to confirm no proactive-derived action candidate is produced. The intent is: zero action rows from a proactive discovery.)

- [ ] **Step 3: Run the new test → PASS by construction** (the bridge does not touch G3). If it FAILS, the bridge accidentally widened the quiet filter — fix at the source, not the test.
- [ ] **Step 4: Update the 4-file structural allow-list** to include `src/core/maintenance/proactive-review-bridge.ts`. The assertion currently expects exactly the 4 producer-lane files; add the bridge as the 5th (it is the deliberate opt-in promotion path, still under `src/core/maintenance/`). Re-run → PASS.
- [ ] **Step 5: Commit** — `git commit -m "test(review-bridge): quiet-surface regression + allow-list bridge (#312)"`.

---

## Task 9: Adversarial review (9 attacks — required before handoff)

Run a Workflow with independent attacker agents, each given the spec + the diff + a constructed hostile fixture for its attack. Each attacker returns `{attack, finding, verdict}` (CONFIRMED/PLAUSIBLE/CLEAN).

- [ ] **Step 1: Spawn the 9 attackers in parallel** (workflow or `parallel` agents):

  1. **Duplicate promotion** — promote same discovery twice in one run + via repeated `get_compounding_reviews`; assert exactly one candidate row, only `last_seen_at` bumps.
  2. **Quiet-surface** — maximal-score proactive discovery still absent from default `read_discoveries` / `run_discovery` digest / `next_actions`.
  3. **Feedback sync** — `reject`/`disable` → discovery `dismissed` → re-run review → no new candidate (terminal upsert no-op) + discovery not re-promoted.
  4. **Privacy** — hostile page titles / raw source slugs / scoring metadata / session refs / event ids in the source discovery do NOT leak into review `title`/`summary`/`evidence`.
  5. **Side-effect** — accept/reject/defer/disable never write pages/links/aliases/external actions; only candidate + feedback + (best-effort) discovery status.
  6. **Gate attack** — discovery missing `metadata.scoring`/`metadata.signals` (or malformed JSON) → skipped, no candidate, no throw.
  7. **Deferred no re-float (hard)** — after `defer`, `get_compounding_reviews(refreshProactive:true)` does NOT re-emit the candidate in default output AND creates no new candidate row.
  8. **Pure-read escape hatch (hard)** — `get_compounding_reviews(refreshProactive:false)` calls neither the bridge nor upsertCandidate; zero candidate writes.
  9. **Sync fail-open (hard)** — source discovery unresolvable → `act_on_review_candidate` returns success with new candidate status; no rollback, no error.

- [ ] **Step 2: Triage** — for any CONFIRMED/PLAUSIBLE finding, write a RED regression test that reproduces it, then fix at the source (not the test), GREEN. Re-run the specific attacker.
- [ ] **Step 3: Commit any fixes** — `git commit -m "fix(review-bridge): <attack> finding from adversarial review (#312)"` per fix.

---

## Task 10: Verify + hand back

- [ ] **Step 1: Focused**
  Run: `bun test tests/core/maintenance/proactive-review-bridge.test.ts tests/mcp/compounding-review.test.ts tests/core/maintenance/proactive-connection.test.ts tests/core/review-generator.test.ts`
  Expected: all PASS.
- [ ] **Step 2: Lint**
  Run: `bun run lint`
  Expected: tsc + biome clean.
- [ ] **Step 3: Full gate**
  Run: `bun run check`
  Expected: lint clean + full `bun test` green (record the pass count).
- [ ] **Step 4: Anonymization final scan**
  Run: `grep -rniE "宏哥|bearer|sk-|api[_-]?key|/Users/" src/core/maintenance/proactive-review-bridge.ts src/mcp/tools/compounding-review.ts tests/core/maintenance/proactive-review-bridge.test.ts tests/mcp/compounding-review.test.ts`
  Expected: CLEAN (no matches).
- [ ] **Step 5: Hand back**
  Summarize: files changed, test counts, adversarial-review outcome (9 attacks → N clean / M fixed). Do NOT push, do NOT close #312. Hand back for reviewer review.

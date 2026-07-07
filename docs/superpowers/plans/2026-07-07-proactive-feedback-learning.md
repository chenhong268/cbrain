# proactive_connection Phase 3a — Review Feedback Learning — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic feedback-learning layer to the proactive producer: a new candidate sharing an entity with a previously accepted (resolved) pair gets a bounded `quality` boost; rejected/disabled suppression (Layer 3) and deferred-neutrality are codified with tests.

**Architecture:** No new file, no schema change. `proactive-connection.ts` extends its existing lifecycle-index pre-pass to also build an `acceptedEntities` set from `resolved` discoveries, and applies a bounded boost to `sc.quality` (never to gate dims) between Layer 3 and metadata construction. Reason codes land in `metadata.scoring`; the producer return gains two audit counters.

**Tech Stack:** TypeScript (strict), Bun, bun:sqlite, bun:test.

**Spec:** `docs/superpowers/specs/2026-07-07-proactive-feedback-learning-design.md`

---

## Execution rules

- **TDD per task**: write the RED test first (anonymous sentinels only — `entity-alpha/beta/gamma`, `concept-delta`, `project-cfg`, `session-s1`; NO real names/paths/secrets, NO `宏哥`, NO credential-like strings even in negative assertions). Watch it fail, then GREEN. No production code without a failing test.
- **Hostile payloads runtime-assembled**: any secrecy/privacy test payload that has a credential/path shape must be assembled via runtime concatenation (`"s" + "k-..."`) so the source stays free of recognizable sensitive patterns (memory `public-tests-anonymous-placeholders`).
- **Worktree absolute paths**: every Read/Edit/Write inside the worktree uses the worktree absolute path; relative paths land in the main repo (memory `worktree-relative-write-main-repo`). Re-Read in-worktree before Edit even if main repo was read.
- **Surgical diffs**: match existing style (semicolons yes for this file — `proactive-connection.ts` uses them). Clean only the dead code this change creates.
- **No push, no close**: commit on the worktree branch only; do not push, do not close #314. Hand back for review.
- **Gates**: `bun run lint` (tsc + biome) + `bun test` must both pass; `bun run check` runs both.
- **Spec + plan are committed deliverables** for #314 (precedent: #310/#311/#312).

## Files

**Source (edit)**
- `src/core/maintenance/proactive-connection.ts` — add `FEEDBACK_BOOST` constant, extend `ProactiveConnectionResult`, add pure `acceptedEntityBoost` helper, build `acceptedEntities` in the pre-pass, apply boost + reason codes in the loop, update the return. The 6-file `git grep -l proactive_connection -- src/` allow-list is UNCHANGED (no new file, no new literal).

**Tests (edit)**
- `tests/core/maintenance/proactive-connection.test.ts` — new `describe("acceptedEntityBoost (#314)")` unit tests + new `describe("produceProactiveConnectionCandidates feedback learning (#314)")` integration tests (boost applies, no-rescue on both gates, rejected-suppress, partial-not-suppressed, deferred-neutral). The file already uses one fixed `/tmp/cbrain-test-proactive-connection` dir with `beforeEach`/`afterEach` cleanup — reuse it (do not introduce a new dir).
- `tests/core/maintenance/proactive-review-bridge.test.ts` — add one structural assertion that `passesReviewGate` (imported from the bridge) does not read `quality` or `feedback_boost` (source-grep test), locking the "boost cannot bypass the #312 review gate" invariant.

---

## Task 1: Worktree + baseline

**Files:** none

- [ ] **Step 1: Create worktree**
  Run: `EnterWorktree` → name `feat-314-feedback-learning`.
- [ ] **Step 2: Fast-forward to local main** (memory `worktree-fresh-base-misses-local-main` — fresh worktree bases off origin/main and misses local doc commits)
  Run (in worktree): `git merge main --ff-only && git log --oneline -1`
  Expected: HEAD is `588a953 docs(proactive): fix #314 spec acceptance #2...` (the latest #314 spec commit on local main). If the spec/plan files are missing, the worktree branched before the doc commits — re-run the merge.
- [ ] **Step 3: Baseline green**
  Run: `bun install && bun run lint && bun test tests/core/maintenance/proactive-connection.test.ts`
  Expected: lint clean; existing producer tests pass. `bun install` first if `node_modules` missing (memory `worktree-fresh-node-modules-gate`).

---

## Task 2: `FEEDBACK_BOOST` constant + `ProactiveConnectionResult` extension + pure `acceptedEntityBoost` helper

**Files:**
- Modify: `src/core/maintenance/proactive-connection.ts` (constant near `SCORE_WEIGHTS` ~line 117; type at line 77-80; new helper near `scoreProactiveConnectionCandidate`)
- Test: `tests/core/maintenance/proactive-connection.test.ts` (new `describe` block after the existing `scoreProactiveConnectionCandidate` block ~line 159)

- [ ] **Step 1: Write the failing unit tests** (append after the `scoreProactiveConnectionCandidate (#311)` describe block)

```typescript
describe("acceptedEntityBoost (#314)", () => {
  it("0 hits → 0 boost", () => {
    expect(acceptedEntityBoost(["entity-alpha", "entity-beta"], new Set())).toBe(0);
  });
  it("1 hit → FEEDBACK_BOOST", () => {
    expect(acceptedEntityBoost(["entity-alpha", "entity-gamma"], new Set(["entity-alpha"]))).toBe(FEEDBACK_BOOST);
  });
  it("2 hits → 2 * FEEDBACK_BOOST (both entities accepted)", () => {
    expect(
      acceptedEntityBoost(["entity-alpha", "entity-beta"], new Set(["entity-alpha", "entity-beta"])),
    ).toBe(2 * FEEDBACK_BOOST);
  });
  it("never exceeds 2 * FEEDBACK_BOOST (a candidate has only 2 entities)", () => {
    expect(acceptedEntityBoost(["entity-alpha", "entity-beta"], new Set(["entity-alpha", "entity-beta", "entity-gamma"]))).toBe(
      2 * FEEDBACK_BOOST,
    );
  });
});
```

  Add to the test file's existing import from `proactive-connection.js` (line 6-11) the new exports `acceptedEntityBoost` and `FEEDBACK_BOOST` (they will not exist yet → RED).

- [ ] **Step 2: Run → FAIL**
  Run: `bun test tests/core/maintenance/proactive-connection.test.ts`
  Expected: FAIL — `acceptedEntityBoost` / `FEEDBACK_BOOST` not exported.
- [ ] **Step 3: Implement** — in `src/core/maintenance/proactive-connection.ts`:

  3a. Extend the result type (replace lines 77-80):

```typescript
export interface ProactiveConnectionResult {
  total: number;
  inserted: number;
  /** #314 — count of candidates whose quality was boosted by accepted feedback. */
  feedbackBoosted: number;
  /** #314 — count of candidates suppressed by review feedback (Layer 3 evidence-identical to dismissed/resolved). */
  feedbackSuppressed: number;
}
```

  3b. Add the constant immediately after `SCORE_WEIGHTS` (after line 117):

```typescript
/** #314 — quality boost per accepted-entity hit. A candidate has 2 entities → max boost 2 * FEEDBACK_BOOST = 0.10. */
export const FEEDBACK_BOOST = 0.05;
```

  3c. Add the pure helper immediately after `scoreProactiveConnectionCandidate` (after line 197):

```typescript
/**
 * #314 — bounded quality boost from accepted review feedback. A candidate gets
 * FEEDBACK_BOOST per entity that appears in the acceptedEntities set (derived
 * from resolved discoveries). A candidate has exactly 2 entities, so the boost
 * is construction-bounded at 2 * FEEDBACK_BOOST; clamp01 (applied by the caller)
 * enforces the (0.01, 1] quality invariant. Pure + deterministic; no DB access.
 *
 * The boost targets the `quality` composite (ranking), NOT any review gate
 * dimension, so it cannot rescue a weak candidate (acceptance #2).
 */
export function acceptedEntityBoost(entities: string[], acceptedEntities: Set<string>): number {
  let hits = 0;
  for (const e of entities) if (acceptedEntities.has(e)) hits++;
  return hits * FEEDBACK_BOOST;
}
```

- [ ] **Step 4: Run → PASS**
  Run: `bun test tests/core/maintenance/proactive-connection.test.ts`
  Expected: PASS (the new unit tests; the producer still returns `{ total, inserted }` at this point — the return-shape change lands in Task 3, but TS won't complain yet because callers in this file don't destructure strictly. If biome/tsc flags the existing `return { total, inserted };` as missing the new fields, leave it — Task 3 fixes it).
- [ ] **Step 5: Commit**
  `git add src/core/maintenance/proactive-connection.ts tests/core/maintenance/proactive-connection.test.ts && git commit -m "feat(proactive): FEEDBACK_BOOST + acceptedEntityBoost pure helper (#314)"`

---

## Task 3: Build `acceptedEntities` in the pre-pass + apply boost in the loop + reason codes + return counters

**Files:**
- Modify: `src/core/maintenance/proactive-connection.ts:412-434` (pre-pass), `:477-508` (boost + metadata), `:541-543` (return)
- Test: `tests/core/maintenance/proactive-connection.test.ts` (new `describe` after the `acceptedEntityBoost` block)

- [ ] **Step 1: Write the failing integration test**

```typescript
describe("produceProactiveConnectionCandidates feedback learning (#314)", () => {
  it("accepted resolved pair boosts a future candidate sharing an entity (acceptance #1)", () => {
    // Seed accepted history: a resolved [entity-alpha, entity-beta] discovery.
    const accepted = db.upsertDiscovery(
      "proactive_connection",
      ["entity-alpha", "entity-beta"],
      0.7,
      undefined,
      undefined,
      "low",
      false,
      { source: "proactive_connection", signals: { shared_neighbors: 3, cooccurring_sessions: 1, timeline_proximity_days: null }, evidence: { shared_neighbor_slugs: ["concept-delta"], timeline_event_refs: [], cooccurring_session_refs: [] }, scoring: { evidence_strength: 0.85, novelty: 0.9, recurrence: 0.2, actionability: 0.2, risk: 0.1, quality: 0.7, gate_path: "strong_corroborated", weights: {} }, pivot: "recently_ingested" },
    );
    db.updateDiscoveryStatus(accepted.id, "resolved");

    // Seed a NEW candidate [entity-alpha, entity-gamma] (shares entity-alpha) that
    // passes the #311 gate on its own (3 shared neighbors + 1 supporting signal).
    seedSharedEntityGamma(db); // helper defined below — 3 shared neighbors + co-occur
    const res = produceProactiveConnectionCandidates(db, { since: "1970-01-01" });

    // The [alpha, gamma] discovery was created + boosted.
    const row = db
      .getDiscoveryLifecycleIndex("proactive_connection", 50)
      .find((r) => r.id !== accepted.id)!;
    const meta = JSON.parse(row.metadata ?? "{}");
    expect(meta.scoring.feedback_boost).toBe(FEEDBACK_BOOST); // 1 entity hit (alpha)
    expect(meta.scoring.feedback_reason).toBe("feedback_boosted");
    expect(res.feedbackBoosted).toBe(1);

    // Baseline: same graph WITHOUT the resolved pair → no boost. Compute the
    // expected unboosted quality from the pure scorer and assert the +FEEDBACK_BOOST delta.
    const baseline = scoreProactiveConnectionCandidate({
      sharedNeighbors: 3,
      signalB: true,
      signalC: false,
      occurrenceCount: 0,
    }).quality;
    expect(meta.scoring.quality).toBeCloseTo(baseline + FEEDBACK_BOOST, 5);
  });

  it("no accepted history → no boost, feedback_reason null (D1/D2 negative)", () => {
    seedSharedEntityGamma(db);
    const res = produceProactiveConnectionCandidates(db, { since: "1970-01-01" });
    const row = db.getDiscoveryLifecycleIndex("proactive_connection", 50)[0];
    const meta = JSON.parse(row.metadata ?? "{}");
    expect(meta.scoring.feedback_boost).toBe(0);
    expect(meta.scoring.feedback_reason).toBeNull();
    expect(res.feedbackBoosted).toBe(0);
  });
});

/** Seed [entity-alpha, entity-gamma] sharing 3 current-fact neighbors (type entity/project), unlinked, + 2 co-occur sessions → strong_corroborated (sn=3 + signalB). Mirrors the existing seedSharedPair conventions. */
function seedSharedEntityGamma(db: CBrainDB): void {
  seedPage(db, "entity-alpha", "Alpha");
  seedPage(db, "entity-gamma", "Gamma");
  for (const s of ["concept-delta", "project-cfg", "concept-epsilon"]) {
    seedPage(db, s, s, "entity/project"); // shared-neighbor type matches seedSharedPair
    seedLink(db, "entity-alpha", s);
    seedLink(db, "entity-gamma", s);
  }
  // 2 distinct sessions → signalB (co-occur ≥ DEFAULT_MIN_SESSIONS=2).
  seedQueryLog(db, "session-s1", ["entity-alpha", "entity-gamma"]);
  seedQueryLog(db, "session-s2", ["entity-alpha", "entity-gamma"]);
}
```

  Ensure `scoreProactiveConnectionCandidate` is imported in the test file (it already is — used by the existing #311 block).

- [ ] **Step 2: Run → FAIL**
  Run: `bun test tests/core/maintenance/proactive-connection.test.ts`
  Expected: FAIL — `meta.scoring.feedback_boost` is undefined (boost not applied yet); `res.feedbackBoosted` is undefined (return not extended).
- [ ] **Step 3: Implement** — edit `src/core/maintenance/proactive-connection.ts`:

  3a. Add `acceptedEntities` next to `dismissedEvidence` in the pre-pass (after line 413):

```typescript
  const dismissedEvidence: Array<{ entities: string[]; slugs: Set<string>; count: number }> = [];
  // #314 — entities appearing in resolved (accepted) discoveries; backs the bounded quality boost.
  const acceptedEntities = new Set<string>();
```

  3b. Inside the `for (const row of db.getDiscoveryLifecycleIndex(...))` loop, after the `dismissedEvidence.push(...)` block (after line 433), add a resolved-entities branch:

```typescript
    if (row.status === "resolved") {
      try {
        const ents = JSON.parse(row.entities) as string[];
        if (Array.isArray(ents)) for (const e of ents) acceptedEntities.add(e);
      } catch {
        // malformed entities JSON → skip this row's contribution to acceptedEntities
      }
    }
```

  3c. Declare the counters near `let inserted = 0;` (after line 405):

```typescript
  let inserted = 0;
  let feedbackBoosted = 0;
  let feedbackSuppressed = 0;
```

  3d. In the loop, AFTER the Layer 3 `if (equivalent) continue;` block (after line 477) and BEFORE `const metadata = {` (line 479), insert the boost:

```typescript
    // #314 — accepted-feedback boost on quality (NOT gate dims). Applied after
    // suppression checks so suppressed candidates are never boosted; after the
    // #311 gate-reject (:451) so gate_path=rejected candidates never reach here.
    const acceptedHits = acceptedEntityBoost(sortedEntities, acceptedEntities);
    if (acceptedHits > 0) {
      sc.quality = clamp01(sc.quality + acceptedHits);
    }
```

  Also flip the Layer 3 `continue` to count suppression. Replace `if (equivalent) continue;` (line 476) with:

```typescript
      if (equivalent) {
        feedbackSuppressed++;
        continue;
      }
```

  3e. Extend `metadata.scoring` (inside the `scoring: { ... }` object, after `weights: SCORE_WEIGHTS,` ~line 505):

```typescript
        feedback_boost: acceptedHits,
        feedback_reason: acceptedHits > 0 ? "feedback_boosted" : null,
```

  3f. Increment `feedbackBoosted` on a successful upsert. After `if (res.inserted) inserted++;` (line 541):

```typescript
    if (res.inserted) {
      inserted++;
      if (acceptedHits > 0) feedbackBoosted++;
    }
```

  3g. Update the return (replace line 543):

```typescript
  return { total: candidates.length, inserted, feedbackBoosted, feedbackSuppressed };
```

- [ ] **Step 4: Run → PASS**
  Run: `bun test tests/core/maintenance/proactive-connection.test.ts`
  Expected: PASS.
- [ ] **Step 5: Commit**
  `git commit -m "feat(proactive): apply accepted-feedback quality boost in producer (#314)"`

---

## Task 4: Boost-cannot-rescue tests (lock BOTH gate invariants — reviewer hard requirement)

**Files:**
- Modify: `tests/core/maintenance/proactive-connection.test.ts` (append to the `produceProactiveConnectionCandidates feedback learning (#314)` describe)
- Modify: `tests/core/maintenance/proactive-review-bridge.test.ts` (structural source-grep test)

- [ ] **Step 1: Write the failing tests** — append to the #314 describe block in `proactive-connection.test.ts`:

```typescript
  it("#311 emit gate NOT weakened: gate_path=rejected candidate sharing an accepted entity is NOT upserted (acceptance #2a)", () => {
    // Accepted history on entity-alpha.
    const accepted = db.upsertDiscovery("proactive_connection", ["entity-alpha", "entity-beta"], 0.7, undefined, undefined, "low", false, { source: "proactive_connection", signals: { shared_neighbors: 3, cooccurring_sessions: 1, timeline_proximity_days: null }, evidence: { shared_neighbor_slugs: ["concept-delta"], timeline_event_refs: [], cooccurring_session_refs: [] }, scoring: { evidence_strength: 0.85, novelty: 0.9, recurrence: 0.2, actionability: 0.2, risk: 0.1, quality: 0.7, gate_path: "strong_corroborated", weights: {} }, pivot: "recently_ingested" });
    db.updateDiscoveryStatus(accepted.id, "resolved");

    // Seed a WEAK candidate [entity-alpha, entity-gamma] that only shares 2 neighbors
    // with 1 supporting signal → gate_path=rejected (proactive-connection.ts:187-193).
    seedWeakAlphaGamma(db); // 2 shared neighbors + co-occur only → rejected
    const res = produceProactiveConnectionCandidates(db, { since: "1970-01-01", minShared: 2 });

    // No NEW discovery for [alpha, gamma] (only the pre-seeded accepted row exists).
    const proactiveRows = db.getDiscoveryLifecycleIndex("proactive_connection", 50);
    expect(proactiveRows.length).toBe(1); // just the accepted [alpha, beta]
    expect(res.feedbackBoosted).toBe(0); // rejected candidate never reached the boost
  });

  it("#312 review gate NOT bypassed: boosted but review-gate-failing candidate is absent from get_compounding_reviews (acceptance #2b)", async () => {
    // Accepted history on entity-alpha.
    const accepted = db.upsertDiscovery("proactive_connection", ["entity-alpha", "entity-beta"], 0.7, undefined, undefined, "low", false, { source: "proactive_connection", signals: { shared_neighbors: 3, cooccurring_sessions: 1, timeline_proximity_days: null }, evidence: { shared_neighbor_slugs: ["concept-delta"], timeline_event_refs: [], cooccurring_session_refs: [] }, scoring: { evidence_strength: 0.85, novelty: 0.9, recurrence: 0.2, actionability: 0.2, risk: 0.1, quality: 0.7, gate_path: "strong_corroborated", weights: {} }, pivot: "recently_ingested" });
    db.updateDiscoveryStatus(accepted.id, "resolved");

    // Seed [alpha, gamma] as strong_corroborated (sn=3 + co-occur) but ONE-SHOT
    // (occurrence=0, no dual corroboration) → review persistence < 2 → fails gate.
    seedSharedEntityGamma(db);
    produceProactiveConnectionCandidates(db, { since: "1970-01-01" });

    // The [alpha, gamma] discovery IS upserted with a boost...
    const agRow = db
      .getDiscoveryLifecycleIndex("proactive_connection", 50)
      .find((r) => r.id !== accepted.id)!;
    const agMeta = JSON.parse(agRow.metadata ?? "{}");
    expect(agMeta.scoring.feedback_reason).toBe("feedback_boosted");

    // ...but it does NOT appear in the review output (persistence gate fails).
    const { promoteProactiveCandidatesToReview } = await import("../../../src/core/maintenance/proactive-review-bridge.js");
    const { CompoundingReviewManager } = await import("../../../src/core/maintenance/compounding-review.js");
    const mgr = new CompoundingReviewManager(db);
    promoteProactiveCandidatesToReview(db, mgr);
    const list = mgr.listCandidates({ includeDeferred: true, limit: 50 });
    expect(list.length).toBe(0); // boosted but review-gate-failing → not promoted
    db.close();
  });

/** Seed [entity-alpha, entity-gamma] sharing 2 current-fact neighbors, unlinked, + signalB only (no signalC) → gate_path=rejected (path 2 needs B AND C). */
function seedWeakAlphaGamma(db: CBrainDB): void {
  seedPage(db, "entity-alpha", "Alpha");
  seedPage(db, "entity-gamma", "Gamma");
  for (const s of ["concept-delta", "project-cfg"]) {
    seedPage(db, s, s, "entity/project");
    seedLink(db, "entity-alpha", s);
    seedLink(db, "entity-gamma", s);
  }
  // signalB (2 sessions) but NO signalC → sn=2 + B only → rejected (needs B AND C for path 2).
  seedQueryLog(db, "session-s1", ["entity-alpha", "entity-gamma"]);
  seedQueryLog(db, "session-s2", ["entity-alpha", "entity-gamma"]);
}
```

- [ ] **Step 2: Write the structural gate-isolation test** — append to `tests/core/maintenance/proactive-review-bridge.test.ts`. This is the reviewer requirement: prove `passesReviewGate` does not read `quality` or `feedback_boost`. Uses a runtime check (refactor-safe — no source-grep) by importing the function and showing boost keys cannot change its decision.

```typescript
import { passesReviewGate } from "../../../src/core/maintenance/proactive-review-bridge.js";

describe("passesReviewGate — boost cannot bypass the review gate (#314)", () => {
  const passing = { evidence: 4, persistence: 3, novelty: 0.8, action_value: 0.6, trust_risk: 0.2 };
  const failingPersistence = { ...passing, persistence: 1 }; // < GATE.persistence (2)

  test("quality and feedback_boost keys do not change a passing decision", () => {
    expect(passesReviewGate(passing)).toBe(true);
    expect(passesReviewGate({ ...passing, quality: 0.0 } as Record<string, number>)).toBe(true);
    expect(passesReviewGate({ ...passing, feedback_boost: 0.0 } as Record<string, number>)).toBe(true);
  });

  test("a failing gate stays failing regardless of quality/feedback_boost (boost cannot rescue)", () => {
    expect(passesReviewGate(failingPersistence)).toBe(false);
    expect(passesReviewGate({ ...failingPersistence, quality: 1, feedback_boost: 1 } as Record<string, number>)).toBe(false);
  });
});
```

  If `passesReviewGate` is not already exported from the bridge, export it (`export function passesReviewGate(...)` — it already is, per #312).

- [ ] **Step 3: Run → expected outcomes**
  Run: `bun test tests/core/maintenance/proactive-connection.test.ts tests/core/maintenance/proactive-review-bridge.test.ts`
  Expected: PASS by construction (the boost is on `quality` only; the producer's `:451` gate-reject already skips `gate_path=rejected`; `passesReviewGate` reads only the 5 dims). If the #312b test fails (the boosted candidate appears in review), the boost leaked into a gate dim — fix at the source, not the test.
- [ ] **Step 4: Commit**
  `git commit -m "test(proactive): boost-cannot-rescue on both gates + structural gate-isolation (#314)"`

---

## Task 5: Rejected-suppress + partial-not-suppressed + deferred-neutral tests (acceptance #3/#4/#5)

**Files:**
- Modify: `tests/core/maintenance/proactive-connection.test.ts` (append to the #314 describe)

- [ ] **Step 1: Write the tests** — append to the #314 describe. These mirror the existing #311 equivalent-suppression / partial-overlap fixtures (lines ~458-477, ~493-522) and add the #314 audit-counter + reason-code assertions. NOTE: `feedbackSuppressed` counts Layer-3 evidence-identical suppressions; exact-pair recurrence of a dismissed pair is skipped at Layer 2 (`:458`) and is NOT counted (it is the existing cooldown, not a feedback suppression of a new candidate).

```typescript
  it("rejected (dismissed) evidence-identical candidate is suppressed + feedbackSuppressed counts it (acceptance #3)", () => {
    // [alpha, beta] shares {project-gamma, concept-delta}; multi_independent via B+C.
    seedSharedPair(db, { sessions: true, timeline: true });
    produceProactiveConnectionCandidates(db, { since: "1970-01-01" });
    const [ab] = db.getDiscoveriesByType("proactive_connection", 10);
    db.updateDiscoveryStatus(ab.id, "dismissed");

    // NEW pair [alpha, zeta] with the SAME evidence neighborhood {gamma, delta} + B+C.
    seedPage(db, "entity-zeta", "Zeta");
    seedLink(db, "entity-zeta", "project-gamma");
    seedLink(db, "entity-zeta", "concept-delta");
    seedQueryLog(db, "s5", ["entity-alpha", "entity-zeta"]);
    seedQueryLog(db, "s6", ["entity-alpha", "entity-zeta"]);
    seedTimeline(db, "entity-zeta", "2026-06-08");
    const res = produceProactiveConnectionCandidates(db, { since: "1970-01-01" });

    // [alpha, zeta] is evidence-identical to the dismissed [alpha, beta] → Layer-3-suppressed.
    const rows = db.getDiscoveriesByType("proactive_connection", 10);
    expect(rows.some((r) => JSON.parse(r.entities).includes("entity-zeta"))).toBe(false);
    expect(res.feedbackSuppressed).toBeGreaterThanOrEqual(1);
  });

  it("partial evidence overlap is NOT suppressed (acceptance #4)", () => {
    seedSharedPair(db, { sessions: true, timeline: true });
    produceProactiveConnectionCandidates(db, { since: "1970-01-01" });
    const [ab] = db.getDiscoveriesByType("proactive_connection", 10);
    db.updateDiscoveryStatus(ab.id, "dismissed");

    // zeta shares only ONE dismissed-evidence neighbor + a fresh one → evidence set differs.
    seedPage(db, "entity-zeta", "Zeta");
    seedPage(db, "concept-fresh", "Fresh", "concept/concept");
    seedLink(db, "entity-zeta", "project-gamma"); // overlaps dismissed evidence
    seedLink(db, "entity-zeta", "concept-fresh"); // but adds a different neighbor
    seedLink(db, "entity-alpha", "concept-fresh");
    seedQueryLog(db, "s5", ["entity-alpha", "entity-zeta"]);
    seedQueryLog(db, "s6", ["entity-alpha", "entity-zeta"]);
    seedTimeline(db, "entity-zeta", "2026-06-08");
    const res = produceProactiveConnectionCandidates(db, { since: "1970-01-01" });

    expect(res.feedbackSuppressed).toBe(0); // evidence-DIFFERENT → not suppressed
    const rows = db.getDiscoveriesByType("proactive_connection", 10);
    expect(rows.some((r) => JSON.parse(r.entities).includes("entity-zeta"))).toBe(true);
  });

  it("deferred (pending) pair is neutral: recurs normally, no boost, no suppress (acceptance #5)", () => {
    seedSharedPair(db, { sessions: true, timeline: true });
    produceProactiveConnectionCandidates(db, { since: "1970-01-01" });
    const [ab] = db.getDiscoveriesByType("proactive_connection", 10);
    expect(ab.status).toBe("pending"); // #312 defer leaves the discovery pending

    // Produce again — the pending pair recurs (Layer 2 allows pending), occurrence bumps.
    const res = produceProactiveConnectionCandidates(db, { since: "1970-01-01" });
    expect(res.feedbackSuppressed).toBe(0);
    expect(res.feedbackBoosted).toBe(0); // no accepted history
    const [after] = db.getDiscoveriesByType("proactive_connection", 10);
    expect(after.occurrence_count).toBeGreaterThan(1);
    expect(JSON.parse(after.metadata ?? "{}").scoring.feedback_reason).toBeNull();
  });
```

- [ ] **Step 2: Run → PASS** (Layer 3 already implements these; the tests lock the behavior under #314's audit counters).
  Run: `bun test tests/core/maintenance/proactive-connection.test.ts`
  If the partial-overlap test fails (Layer 3 suppresses), the evidence sets are accidentally equal — fix the fixture (ensure the new neighbor set differs), not the impl.
- [ ] **Step 3: Commit**
  `git commit -m "test(proactive): rejected-suppress + partial-not-suppressed + deferred-neutral (#314)"`

---

## Task 6: Privacy scan + structural allow-list unchanged

**Files:** none (verification only)

- [ ] **Step 1: Privacy grep on touched files**
  Run: `grep -rniE "宏哥|bearer|sk-|api[_-]?key|/Users/" src/core/maintenance/proactive-connection.ts tests/core/maintenance/proactive-connection.test.ts tests/core/maintenance/proactive-review-bridge.test.ts`
  Expected: CLEAN (no matches). The #314 tests use only anonymous sentinels (`entity-alpha/beta/gamma`, `concept-delta/zeta/epsilon`, `project-cfg`, `session-s1`); no hostile payloads are needed for feedback-learning tests. If a match appears, runtime-assemble it (memory `public-tests-anonymous-placeholders`).
- [ ] **Step 2: Structural allow-list still 6 files**
  Run: `bun test tests/core/maintenance/proactive-connection.test.ts -t "proactive_connection appears only"`
  Expected: PASS — the allow-list is unchanged (no new source file, no new `proactive_connection` literal). If it FAILS, a new file/string leaked — fix at the source.
- [ ] **Step 3: Quiet-surface regression still green**
  Run: `bun test tests/core/maintenance/proactive-review-bridge.test.ts tests/mcp/compounding-review.test.ts`
  Expected: PASS — the boost touches only `discoveries.score`/`metadata.scoring`; G1/G2/G3 + the #312 bridge tests are unaffected.

---

## Task 7: Adversarial review (8 attacks — required before handoff)

Run a Workflow OR parallel `Agent` attackers, each given the spec + the diff + a constructed fixture. Each returns `{attack, verdict: CONFIRMED|PLAUSIBLE|CLEAN, finding, evidence, suggested_fix}`.

- [ ] **Step 1: Spawn 8 attackers in parallel**

  1. **Boost-rescue (two fronts)** — (a) a `gate_path=rejected` candidate sharing an accepted entity is NOT upserted; (b) a `strong_corroborated` but `persistence<2` candidate sharing an accepted entity IS upserted with boost but NOT promoted to review.
  2. **Over-boost** — a candidate with BOTH entities in acceptedEntities gets exactly `2 * FEEDBACK_BOOST = 0.10`; the (0.01, 1] clamp holds even when baseline quality is high.
  3. **Accepted-identical leak** — a new candidate evidence-identical to an accepted (resolved) pair is SUPPRESSED by Layer 3 (not boosted) — accepted must not bypass "don't re-emit the same connection."
  4. **Rejected-evasion** — a candidate exact or evidence-identical to a rejected (dismissed) pair is suppressed even after the dismissed discovery has a high occurrence_count.
  5. **Deferred-as-reject** — a deferred pair (discovery pending) recurs (occurrence bump) and is NOT suppressed by its own status.
  6. **Quiet-surface** — a boosted candidate's `discoveries.score` bump does not surface it in default `read_discoveries`/`run_discovery`/`next_actions` (G1/G2/G3) and does not change `get_compounding_reviews` ordering for a review-gate-failing candidate.
  7. **Privacy** — `metadata.scoring.feedback_boost`/`feedback_reason` + the producer return contain no slugs/paths/scores-leaked-into-display; reason codes are stable anonymous strings; display never reads feedback fields.
  8. **Feedback-write** — the boost path performs NO write beyond `upsertDiscovery` (no page/link/alias/external); the `feedbackSuppressed` counter is a return-only audit int, not a persisted write.

- [ ] **Step 2: Triage** — for any CONFIRMED/PLAUSIBLE finding, write a RED regression test reproducing it, fix at the source (not the test), GREEN, re-run the attacker.
- [ ] **Step 3: Commit any fixes** — `git commit -m "fix(proactive): <attack> finding from #314 adversarial review"` per fix.

---

## Task 8: Verify + hand back

- [ ] **Step 1: Focused**
  Run: `bun test tests/core/maintenance/proactive-connection.test.ts tests/core/maintenance/proactive-review-bridge.test.ts tests/mcp/compounding-review.test.ts tests/core/review-generator.test.ts`
  Expected: all PASS.
- [ ] **Step 2: Lint**
  Run: `bun run lint`
  Expected: tsc + biome clean.
- [ ] **Step 3: Full gate**
  Run: `bun run check`
  Expected: lint clean + full `bun test` green (record the pass count; baseline is 3424 from #312 — #314 adds the new feedback-learning tests).
- [ ] **Step 4: Docs regen** (only if any tool description changed — #314 changes NONE, but verify)
  Run: `bun bin/check-docs-consistency.ts`
  Expected: passes (no tool description changed; if it fails, the doc inventory drifted — run `--update` only if a description genuinely changed, which it should not).
- [ ] **Step 5: Final anonymization scan**
  Run: `grep -rniE "宏哥|bearer|sk-|api[_-]?key|/Users/" src/core/maintenance/proactive-connection.ts tests/core/maintenance/proactive-connection.test.ts tests/core/maintenance/proactive-review-bridge.test.ts`
  Expected: CLEAN.
- [ ] **Step 6: Hand back**
  Summarize: files changed, test counts, adversarial-review outcome (8 attacks → N clean / M fixed). Do NOT push, do NOT close #314. Hand back for reviewer review.

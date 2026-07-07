# proactive_connection Phase 3a — Review Feedback Learning Design Spec

**Issue:** #314 (parent #235 Phase 3a; follows #310/#311/#312 — merged to main)
**Phase:** 3a — turn review accept/reject/defer feedback into a deterministic scoring/cooldown signal for FUTURE proactive candidates
**Status:** design

## Context

#310/#311/#312 completed the first three phases: a quiet `proactive_connection` candidate pool, evidence scoring + noise control, and routing eligible discoveries into Compounding Review with lifecycle sync (accept→resolved, reject/disable→dismissed, defer→pending).

The remaining Phase 3 question is whether review feedback can become an explicit learning signal — making future *similar* high-quality candidates rank slightly higher when the user has accepted connections in the same area, and keeping suppression reliable for rejected ones — WITHOUT turning CBrain into a notification/fact-writing system.

The key constraint, confirmed by reading the post-#312 code: **an accepted pair can never recur** (Layer 2 at `proactive-connection.ts:458` skips any non-pending discovery, and #312 syncs accept→resolved). So the accepted-boost can only ever apply to a *different* pair that shares an entity with an accepted one. And the boost must target the `quality` composite (a ranking dimension), NOT any of the 5 review gate dimensions, so it cannot rescue a weak candidate.

All examples, fixtures, docs, and tests use **anonymous sentinels only**.

## Goal

Add a small, deterministic feedback-learning layer to the proactive producer:

- a new candidate sharing an entity with a previously **accepted** pair gets a small bounded `quality` boost (still must pass all evidence gates on its own);
- **rejected/disabled** pairs continue to suppress exact + evidence-identical candidates (existing Layer 3, now codified);
- **deferred** pairs stay neutral (recurrence allowed, no boost, no suppress from the deferred status itself);
- auditable raw/debug reason codes; no display change; no new table; no new file.

## Preserved boundaries (do not break)

Verified against post-#312 code:

- **No facts / links / pages / aliases / external actions.** The only write is `upsertDiscovery` (existing) with adjusted `metadata.scoring` + `score`.
- **No change to recall / search / ingest / `next_actions` / default discovery.** The boost is on the proactive discovery's `quality`/`score` only; quiet gates G1/G2/G3 untouched.
- **Boost cannot rescue weak.** Boost targets `sc.quality` only; the #312 review gate (`passesReviewGate` over `evidence/persistence/novelty/action_value/trust_risk`) and the #311 emit gate (`gate_path`) are derived from signals, not `quality`, so a boost cannot flip either.
- **No new schema, no new source file.** Logic lives in `proactive-connection.ts` (producer). The 6-file `git grep -l proactive_connection -- src/` allow-list is unchanged.
- **Display unchanged.** `formatDigestCard` never reads `metadata.scoring`; the review card display (#312) carries only gate dims + sanitized anonymous text, not `quality` or feedback fields.
- **#310/#311/#312 lifecycle intact.** Resolved/dismissed discoveries still skip at Layer 2; Layer 3 equivalent-suppression unchanged.

## Integration map (existing surfaces — read-only reuse)

| surface | location | what Phase 3a uses |
|---|---|---|
| producer lifecycle pre-pass | `proactive-connection.ts:414-434` | already iterates `getDiscoveryLifecycleIndex`; Phase 3a additionally collects resolved discoveries' entities into `acceptedEntities` |
| Layer 2 non-pending skip | `proactive-connection.ts:458` | unchanged — accepted pairs (resolved) never recur |
| Layer 3 equivalent-suppression | `proactive-connection.ts:467-477` | unchanged — rejects exact/evidence-identical to dismissed/resolved |
| scoring | `proactive-connection.ts:445-450` (`scoreProactiveConnectionCandidate`) | boost applied to `sc.quality` AFTER scoring, BEFORE metadata construction |
| metadata.scoring | `proactive-connection.ts:497-506` | gains `feedback_boost` + `feedback_reason` (raw/debug only) |
| upsertDiscovery score arg | `proactive-connection.ts:534` | receives boosted `sc.quality` → `discoveries.score` |
| #312 bridge `qualityOf` sort | `proactive-review-bridge.ts:171` | naturally reflects boosted `metadata.scoring.quality` for promotion priority |

**Critical facts driving the design:**

1. `acceptedEntities` is derivable from the **discovery lifecycle alone** — `accept`→`resolved` via #312's sync. No `compounding_review_*` reads needed (deferred vs unreviewed both = `pending` = neutral, so the distinction is irrelevant to boost/suppress).
2. Layer 3 already suppresses evidence-identical to **resolved** discoveries too (the pre-pass at `:414` includes `status === "resolved"`), so a new candidate that is evidence-identical to an accepted pair is suppressed, not boosted — the boost only reaches *similar-but-different* pairs (shared entity, different evidence).
3. The boost lands on `sc.quality`, which flows to `discoveries.score` + `metadata.scoring.quality`. The #312 bridge's `mapProactiveToReviewScores` derives gate dims from signals (not `quality`), and `qualityOf` sorts on `metadata.scoring.quality` — so the boost affects promotion priority + explicit-read ranking, never gate-passing.

## Design decisions

### D1 — Feedback signal from discovery lifecycle only (no review-table reads)

The producer's existing pre-pass over `getDiscoveryLifecycleIndex("proactive_connection")` already sees every discovery's `status`. Phase 3a extends it to also build an `acceptedEntities: Set<string>` from rows with `status === "resolved"` (each resolved discovery contributes both its entities). No query against `compounding_review_candidates` / `compounding_review_feedback` is added — their signal is fully mirrored in discovery status via #312, and the deferred-vs-unreviewed distinction does not affect boost/suppress/neutral (both are `pending`).

### D2 — Accepted boost: entity-level, bounded, on `quality` only

For a new candidate that has passed the #311 emit gate (`gate_path !== "rejected"`, `:451`) and is NOT Layer-2/Layer-3 suppressed:

```
hits   = count of the candidate's entities present in acceptedEntities   // a candidate has exactly 2 entities → hits ∈ {0,1,2}
boost  = hits * FEEDBACK_BOOST                                            // FEEDBACK_BOOST = 0.05 → max boost 0.10
sc.quality = clamp01(sc.quality + boost)
```

A separate `CAP` constant is unnecessary: a candidate has only 2 entities, so `boost` is bounded at `2 * FEEDBACK_BOOST = 0.10` by construction; `clamp01` then enforces the existing (0.01, 1] `quality` invariant. `FEEDBACK_BOOST` is a named, tunable constant. The boost is applied between Layer 3 (`:477`) and metadata construction (`:479`), so suppressed candidates are never boosted.

Because the boost only touches `sc.quality` (not `evidence_strength`/`risk`/etc., and not the review gate dims), it cannot flip `gate_path` or pass a `passesReviewGate` failure. A weak candidate (insufficient evidence) still fails the review evidence gate at promotion time regardless of the boost.

### D3 — Rejected/disabled suppression: reuse Layer 3 (no new logic)

Layer 3 (`:467-477`) already suppresses candidates that are evidence-identical (full shared-neighbor count + set equality + ≥1 shared entity) to any `dismissed` or `resolved` discovery. Via #312, `reject`/`disable` → source discovery `dismissed`, so rejected/disabled feedback already suppresses exact + evidence-identical recurrence. Phase 3a adds NO new suppression code — it only adds regression tests that lock the behavior under review feedback + increments a `feedbackSuppressed` audit counter in the producer return.

Partial evidence overlap is deliberately NOT suppressed (Layer 3 requires set equality) — locked by test.

### D4 — Deferred is neutral (the default)

`defer` → source discovery stays `pending` (#312). Pending discoveries are not in `acceptedEntities` (only `resolved`) and not in the Layer-3 dismissed/resolved set, so a deferred pair recurs normally (occurrence bump) with no boost and no suppress from its own deferred status. A deferred pair may still be boosted by an *unrelated* accepted entity (correct — the deferred status is neutral, but the candidate is still evaluated on its merits). No code is needed for neutrality; it is the default. Locked by test.

### D5 — Reason codes + producer-return audit

- `metadata.scoring.feedback_boost: number` (the applied boost, 0 if none) and `metadata.scoring.feedback_reason: "feedback_boosted" | null` — raw/debug only; never read by display.
- `ProactiveConnectionResult` gains `feedbackBoosted: number` and `feedbackSuppressed: number` counts. Backward-compatible addition (existing callers ignore new fields). Suppressed candidates are not upserted, so per-candidate audit is via the persisted dismissed/resolved discoveries (which carry the evidence that triggered suppression), not a row on the suppressed candidate.

### D6 — In-producer helper, no new file

The accepted-entity build + boost live in `proactive-connection.ts` (a `buildAcceptedEntitySet` helper + inline boost in the loop). Rationale: (a) avoids a new file that would trip the 6-file `git grep -l proactive_connection -- src/` allow-list; (b) the producer already owns the lifecycle-index read, so the accepted set is a natural extension of the existing pre-pass; (c) file stays ~620 lines (under the 800 cap). Splitting into a `proactive-feedback-learning.ts` is deferred until the file crosses ~700 lines.

## Data model changes

- **No DDL, no migration, no new table, no new file.**
- `metadata.scoring.feedback_boost` + `metadata.scoring.feedback_reason` are added by the producer (metadata is already a JSON string column; no schema change).
- `ProactiveConnectionResult` type gains two number fields.

## Acceptance criteria → mechanism

1. Accepted feedback boosts a future evidence-backed candidate → D2 (entity-level boost on `quality`; test: seed resolved [a,b], produce [a,c] sharing entity a → quality is +0.05 vs the no-feedback baseline).
2. Boost cannot rescue a weak candidate — neither the #311 emit gate NOR the #312 review gate → D2 (boost on `quality` only, applied AFTER the `:451` gate-reject). Two test cases:
   - **#311 emit gate not weakened**: a `gate_path="rejected"` candidate (e.g. `sharedNeighbors=2` with only one supporting signal — fails the strong/multi-independent paths at `proactive-connection.ts:187-193`) sharing an entity with an accepted pair is NOT upserted; `feedbackBoosted` does not increment for it.
   - **#312 review gate not bypassed**: a candidate that PASSES the #311 gate but FAILS the review gate (e.g. `sharedNeighbors=3 + one supporting signal` → `strong_corroborated`, upserted with boosted `quality`, but one-shot without dual corroboration → `mapProactiveToReviewScores` yields `persistence < 2` → `passesReviewGate` fails) is NOT promoted into review. Plus a structural assertion that `passesReviewGate` does not read `metadata.scoring.quality` or `feedback_boost`.
3. Rejected/disabled suppresses exact or evidence-identical → D3 (Layer 3; test: seed dismissed [a,b] via evidence {x,y,z}, produce evidence-identical [a,c] → not upserted; `feedbackSuppressed` increments).
4. Partial overlap NOT suppressed → D3 (Layer 3 set-equality; test: dismissed {x,y,z} vs new {x,y,w} → upserted normally).
5. Deferred neutral → D4 (test: seed deferred [a,b] — discovery pending — produce [a,b] recurrence → occurrence bumps, no boost from its own status, no suppress).
6. #310/#311/#312 lifecycle intact → Layer 2/3 unchanged; existing #311/#312 tests still pass.
7. Default surfaces quiet → boost on `discoveries.score` only; G1/G2/G3 + structural tests unchanged.
8. Display sanitized → display never reads `metadata.scoring`; no feedback field reaches any card.
9. Raw/debug auditable → D5 (`feedback_boost`, `feedback_reason`, producer-return counts).
10. Full gate passes → `bun run check`.

## Adversarial review targets (required before handoff)

1. **Boost-rescue attack (two fronts)**: (a) a `gate_path="rejected"` candidate (e.g. `sharedNeighbors=2` + one supporting signal) sharing an accepted entity is NOT upserted — the #311 emit gate is not weakened; (b) a `strong_corroborated` but review-gate-failing candidate (e.g. one-shot without dual corroboration → `persistence < 2`) sharing an accepted entity IS upserted with boosted `quality` but NOT promoted into review — the boost cannot flip `gate_path` or any `passesReviewGate` dimension.
2. **Over-boost attack**: a candidate sharing BOTH entities with accepted pairs must receive at most `2 * FEEDBACK_BOOST = 0.10` boost, and the (0.01, 1] clamp must hold.
3. **Accepted-identical leak attack**: a new candidate evidence-identical to an accepted pair must be SUPPRESSED by Layer 3 (not boosted) — accepted must not bypass the "don't re-emit the same connection" guarantee.
4. **Rejected-evasion attack**: a candidate exact or evidence-identical to a rejected/disabled pair must be suppressed even after the discovery has recurred once (occurrence bump on a still-pending sibling must not wash out the dismissed evidence).
5. **Deferred-as-reject attack**: a deferred pair must recur (occurrence bump) and must NOT be suppressed by its own deferred status.
6. **Quiet-surface attack**: a boosted candidate's `discoveries.score` bump must not surface it in default `read_discoveries`/`run_discovery`/`next_actions` (G1/G2/G3).
7. **Privacy attack**: `metadata.scoring` feedback fields + producer return contain no slugs/paths/scores-leaked-into-display; reason codes are stable anonymous strings.
8. **Feedback-write attack**: the boost path performs NO write beyond `upsertDiscovery` (no page/link/alias/external).

## Known limitations / deferred

- **Boost effect is marginal when <20 pending discoveries**: the boost affects promotion priority (top `PROMOTION_LIMIT=20`) + `discoveries.score` ranking in explicit reads. `ReviewGenerator`'s top-3 surfacing order is by candidate-table order, not `quality`, so the boost does not directly reorder review output. Accepted — the issue asks for a ranking signal, not a review-surfacing change; making `ReviewGenerator` order by `quality` is a separate #312-scope decision.
- **Entity-level boost can be broad for hub entities**: a popular entity in many accepted pairs boosts all its candidates (bounded by `2 * FEEDBACK_BOOST = 0.10` per candidate, since a candidate has only 2 entities). Accepted for Phase 3a; evidence-level boost (narrower) is a deferred alternative if this proves noisy.
- **No review-table attribution**: reason codes say `feedback_boosted` but do not cite the specific accepted review candidate id (would require reading `compounding_review_candidates`). The resolved discovery itself is the auditable anchor.
- **Slug-rename edge**: a renamed entity changes the `acceptedEntities` membership; a resolved discovery under the old slug stops boosting. Inherited #311 limitation.

## Resolved decisions (confirmed 2026-07-07)

1. **Feedback signal source** — discovery lifecycle only (`resolved`=accepted, `dismissed`=rejected, `pending`=neutral). No `compounding_review_*` reads (YAGNI; the deferred-vs-unreviewed distinction is irrelevant to boost/suppress/neutral).
2. **Boost similarity** — entity-level (candidate shares ≥1 entity with a resolved pair's entities).
3. **Boost magnitude** — `FEEDBACK_BOOST = 0.05` per accepted-entity hit (max `0.10` for a 2-entity candidate), on `sc.quality` only; no separate cap (construction-bounded + `clamp01`).
4. **No new file** — logic in `proactive-connection.ts`; 6-file structural allow-list unchanged.

# proactive_connection Phase 1 — Scoring & Noise Control — Implementation Plan

**Issue:** #311 (parent #235)
**Spec:** `docs/superpowers/specs/2026-07-07-proactive-candidate-scoring-design.md`
**Branch:** `feat/311-proactive-scoring` (worktree)
**Decisions:** locked — see spec "Resolved decisions".

## Execution rules

- **TDD per phase**: write RED tests first (anonymous sentinels only — no real names/slugs/paths/secrets), watch them fail, then GREEN. No production code without a failing test.
- **Worktree absolute paths**: every Read/Edit/Write inside the worktree uses the worktree absolute path; relative paths land in the main repo (memory `worktree-relative-write-main-repo`). Re-Read in-worktree before Edit even if main repo was read (memory `worktree-edit-needs-worktree-read`).
- **Surgical diffs**: match existing style; no drive-by refactors. Clean only the dead code this change creates.
- **No push, no close**: commit on the worktree branch only; do not push, do not close #311. Hand back for review.
- **Gates**: `bun run lint` (tsc + biome) + `bun test` must both pass; `bun run check` runs both.
- **Anonymization**: tests/docs use only synthetic sentinels (`entity-alpha`, `project-cfg`, `concept-delta`, `concept-popular-hub`). No credential-like strings (auth-header prefixes, secret-key prefixes), real names, or paths — anonymous sentinels only, even in negative assertions (memory `public-tests-anonymous-placeholders`, `plan-files-untracked-anonymized`).
- This spec + plan are committed deliverables for #311 (precedent: #310 `5659bae`), so reviewers can audit the scoring/gate/cooldown decisions alongside the code.

## Files

**Source (edit)**
- `src/storage/sqlite.ts` — 2 new read-only methods (`batchGetLinkDegrees`, `getDiscoveryLifecycleIndex`).
- `src/core/maintenance/proactive-connection.ts` — pure scoring helper + strengthened gate + hub filter + producer cooldown/equivalent skip + metadata.scoring.
- `src/core/maintenance/discovery-digest.ts` — `safeTitle` returns the anonymous fallback (never a raw slug) when the page lookup is null (adversarial secrecy fix).
- `src/core/safety/display-safety.ts` — `DISPLAY_UNSAFE_PATTERNS` hardened: Unix absolute paths, destructive SQL, JWT first-segment regex (adversarial secrecy fix; shared module — carries no `proactive_connection` literal).

**Tests (new + edit)**
- `tests/core/maintenance/proactive-connection.test.ts` — scoring / gate / hub / cooldown / equivalent + adversarial-fix cases.
- `tests/core/discovery-digest.test.ts` — scoring-fields-not-in-card + adversarial secrecy cases (Unix path / SQL / missing-page slug / JWT).
- `tests/mcp/proactive-connection.test.ts` — fixtures updated for the strengthened gate (added timeline).
- `tests/storage/sqlite.test.ts` — `batchGetLinkDegrees` (incl. self-loop) + `getDiscoveryLifecycleIndex`.

The 4-file `git grep -l proactive_connection -- src/` structural-isolation invariant stays intact (D5): `display-safety.ts` is a shared safety module, not a proactive-specific one.

## Phases

### Phase 0 — Worktree
- `EnterWorktree` → `feat/311-proactive-scoring`. Confirm `bun run lint` + a focused test are green on the fresh worktree (baseline; memory `worktree-fresh-node-modules-gate` — `bun install` if node_modules missing).

### Phase 1 — Storage layer (D2 hub filter + D4 cooldown read)
RED (`tests/core/maintenance/proactive-connection.test.ts` or a sqlite-focused test block):
- `batchGetLinkDegrees(slugs)` returns active-link count per slug; excluded/superseded edges not counted; missing slug → 0.
- `getDiscoveryLifecycleIndex('proactive_connection', limit)` returns ALL rows (any status); column shape `{id, dedup_key, entities, metadata, last_detected_at, occurrence_count, status}`; producer derives dismissed set + occurrence_count; respects limit.

GREEN:
- Add `batchGetLinkDegrees` and `getDiscoveryLifecycleIndex` to `CBrainDB` (`sqlite.ts`, near the discovery methods ~line 2570+). Parameterized queries; count both `from_slug` and `to_slug` over active links.

### Phase 2 — Scoring helper (D1, D6) — pure, unit-tested
RED:
- `scoreProactiveConnectionCandidate` returns the 5 dimensions + `quality` + `gate_path`, matching the spec formulas for: bare-min (sn=2,B,C → path 2), strong (sn=3,B → path 1), rejected (sn=2, no supporting).
- `quality` equals the weighted sum; weights read from named constants; (0.01, 1] clamp holds at boundaries.
- `occurrence_count` flows in: novelty=1 when 0, decays otherwise; recurrence scales with count.
GREEN:
- Export pure `scoreProactiveConnectionCandidate(input)` + `SCORE_WEIGHTS`, `SCORE_BASE` constants from `proactive-connection.ts`. No DB access.

### Phase 3 — Strengthened gate + hub filter (D2) — detector
RED:
- A shared neighbor whose degree > `HUB_DEGREE_MAX` (20) is NOT counted in `sharedNeighbors` and is excluded from `sharedNeighborSlugs`. Fixture: pair shares 2 neighbors, one is a hub (degree 25) → sharedNeighbors drops to 1 → no candidate (below minShared).
- Non-hub shared neighbor (degree 5) counts normally.
- Path 1 (sn≥3 + ≥1 supporting) and Path 2 (sn≥2 + B + C) both persist; sn=2 + only one supporting → rejected (was accepted in Phase 0 — strengthens the gate).
- Evidence-first: candidate with empty `sharedNeighborSlugs` (constructed) is rejected by the gate predicate.
GREEN:
- Detector calls `batchGetLinkDegrees` once per pivot batch; filters hub neighbors before counting. Producer applies the strengthened gate via the pure predicate from Phase 2.
- **Watch existing Phase 0 tests**: `respects the cap`, `Signal A: shared >=2 neighbors` etc. still pass (fixtures use low-degree neighbors). Adjust only if a fixture legitimately needs a hub.

### Phase 4 — Cooldown + equivalent suppression (D3, D4) — producer
RED:
- Exact-pair cooldown: dismissed pair → re-run produce → no new insert AND `occurrence_count` NOT bumped (producer skips upsert). (Phase 0 asserted "not resurrected"; Phase 1 additionally asserts occurrence_count frozen.)
- Equivalent cooldown: dismiss pair {alpha,beta} with evidence {cfg,delta}; construct a new candidate {alpha,gamma} whose `shared_neighbor_slugs` set is also {cfg,delta} → producer suppresses (no insert). Partial overlap ({cfg,other}) → NOT suppressed.
- Resolved pair behaves same as dismissed.
- `metadata.scoring.suppressed` reason logged via producer return / `_debug` (not persisted on a discoveries row — suppressed candidates aren't upserted).
GREEN:
- Producer reads `getDiscoveryLifecycleIndex('proactive_connection', N)` once per run; builds a dismissed set keyed by canonical entities JSON + an evidence-set index; skips upsert for exact-dismissed pairs and for evidence-identical equivalents.

### Phase 5 — metadata.scoring + score column (D6, D7) — producer
RED:
- Persisted row `metadata.scoring` carries the 5 dimensions + `quality` + `gate_path` + `weights`.
- `discoveries.score` equals `quality` (not the old flat formula).
- Bounded: `metadata` size stays small (scoring adds ~10 numbers, no new ref lists).
GREEN:
- Producer builds `metadata.scoring` from the pure helper output; passes `quality` as the score arg to `upsertDiscovery`.

### Phase 6 — Display isolation (acceptance #3, #7)
RED (`tests/core/discovery-digest.test.ts`):
- `formatDigestCard` proactive case with `metadata.scoring` populated → card blob contains none of: `evidence_strength`, `novelty`, `recurrence`, `risk`, `quality`, `gate_path`, numeric score string, `shared_neighbor_slugs`.
- Hostile title + scoring metadata present → card still sanitized (existing secrecy test extended to include scoring metadata).
GREEN: should pass by construction (card never reads metadata); assertion-only. If it leaks, fix at `formatDigestCard`.

### Phase 7 — Quiet regression (acceptance #6)
RED (`tests/core/maintenance/proactive-connection.test.ts` structural-isolation block + new assertions):
- `git grep -l proactive_connection -- src/` still returns exactly the 4 allow-listed files (D5 — no new file).
- A persisted proactive row with score=1.0, actionable='high' (forcibly) still does NOT appear in `buildActionCandidatesFromDiscoveries` output (G3 holds regardless of score).
- No new import of proactive-connection into recall/search/ingest paths (extend the existing readFileSync forbidden-list check if needed).
GREEN: should pass by construction. If a regression, fix at the gate, not the test.

### Phase 8 — Adversarial review (6 attacks — required before handoff)
Run a Workflow with 6 independent attacker agents, each given the spec + the diff + a constructed hostile fixture for its attack:
1. generic-overlap noise (popular-hub shared neighbor).
2. duplicate/equivalent spam (re-found via other pivot + same-evidence-different-target).
3. dismissed/resolved recurrence (exact + equivalent).
4. score/debug leakage into display (hostile title + scoring fields).
5. accidental default surfacing (score=1.0 → next_actions/read/run still quiet).
6. hidden automatic actions/writes (only upsertDiscovery + verifier log; producer skip reduces writes).
Fix any confirmed finding (TDD a regression test first). Re-run until dry.

### Phase 9 — Verify
- Focused: `bun test tests/core/maintenance/proactive-connection.test.ts tests/core/discovery-digest.test.ts`.
- `bun run typecheck`.
- `bun run lint`.
- Full `bun run check`.

### Phase 10 — Hand back
- Summarize: decisions, files changed, test counts, adversarial-review outcome. Do NOT push, do NOT close #311. Fast-forward nothing. Hand back for reviewer review.

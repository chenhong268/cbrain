# proactive_connection Phase 1 — Scoring & Noise Control Design Spec

**Issue:** #311 (parent #235, follows #310 Phase 0 — merged to main)
**Phase:** 1 — evidence scoring + noise control; default-quiet preserved
**Status:** implemented on `worktree-feat+311-proactive-scoring` (commit `8f532a4`); awaiting 宏哥 review

## Context

#310 Phase 0 shipped a quiet, opt-in, evidence-backed `proactive_connection` candidate lane that reuses the existing `discoveries` lifecycle. It persists candidates with bounded concrete evidence refs, and a default-quiet contract enforced by three gates (G1/G2/G3). The emit rule is deliberately simple (Signal A + ≥1 supporting) and the score is flat.

The next risk is **noise**: generic graph-overlap pairs, duplicate/equivalent candidates re-found through a different pivot/order, and a dismissed candidate resurfacing under a different shape. Before any Compounding Review / notification / surfacing phase, Phase 1 hardens quality so the lane stays trustworthy.

Phase 1 is still **not** a notification system and performs **no** automatic action beyond `upsertDiscovery` + verifier logs.

All examples, fixtures, docs, and tests use **anonymous sentinels only**.

## Goal

Add evidence scoring + noise control on top of the Phase 0 lane, preserving every Phase 0 boundary:
- default-quiet unchanged (G1/G2/G3 untouched);
- no notifications, no external actions, no auto page edits, no auto merge/link/trust;
- no LLM-only insight — detector stays pure graph + co-occurrence + timeline math;
- scoring details are raw/debug-only — never echoed into display.

## Preserved boundaries (do not break)

Verified against #310 code + integration points (file:line in the #311 integration map):

- **Three quiet gates**: G1 `read_discoveries` round-robin over `['bridge','trend','gap','contradiction']` only (`discoveries.ts:122`); G2 `run_discovery` digest filter `wantsProactive || type!=='proactive_connection'` (`discoveries.ts:248`); G3 `buildActionCandidatesFromDiscoveries` skips `QUIET_DISCOVERY_TYPES={'proactive_connection'}` before any promotion check (`action-candidates.ts:95/160`) + read-side `isActionCandidateType` (`action-candidates.ts:330`).
- **`isDigestExcluded` NOT extended** for `proactive_connection` (`discovery-digest.ts:52`) — extending it would also hide the explicit `read_discoveries({typeFilter})` path.
- **Display/raw split**: `formatDigestCard` proactive case (`discovery-digest.ts:222`) = fixed anonymous copy + `safeTitle`; never reads `metadata`. `DigestCard` carries no score field.
- **Lifecycle**: `upsertDiscovery` conflict path touches only `score`/`metadata`/`last_detected_at`/`occurrence_count` — **never** `status`/`seen` (the not-resurrected guarantee).
- **Verifier fail-open absolute** before every upsert.
- **`actionable='low'` immutable** for `proactive_connection` (raising it corrupts explicit-read sort ordering at `discovery-digest.ts:272-277`).
- **Open-string type**; hard cap 20 candidates/run.

## Design decisions

### D1 — Pure scoring layer (scope #1, acceptance #1/#3)

New pure helper `scoreProactiveConnectionCandidate(input)` returns per-dimension scores + a composite `quality`. Stored ONLY in `metadata.scoring` (raw/debug). `formatDigestCard` never reads it. The persisted `discoveries.score` column is set to `quality` (replaces Phase 0's flat formula), preserving the (0.01, 1] clamp invariant.

Dimensions (Phase 1 defaults — named constants, tunable):

| dimension | meaning | formula (Phase 1 default) |
|---|---|---|
| `evidence_strength` | how much concrete evidence backs the pair | `clamp01(0.40 + 0.15·min(sharedNeighbors−2, 2) + 0.15·(B?1:0) + 0.15·(C?1:0))` |
| `novelty` | pair is new vs recurring | `occurrenceCount===0 ? 1 : clamp01(1/(1+0.5·occurrenceCount))` |
| `recurrence` | signal robustness across re-detections | `clamp01(occurrenceCount/5)` |
| `actionability` | user can act (no auto-action) | fixed `0.20` (Phase 1; neighbor-type-derived value deferred) |
| `risk` | noise risk (inverse of corroboration) | `clamp01(0.60 − 0.20·(B?1:0) − 0.20·(C?1:0) − 0.10·min(sharedNeighbors−2, 2))` |

Composite:

```
quality = clamp01(
  W_EVIDENCE   · evidence_strength   // 0.35
+ W_NOVELTY    · novelty             // 0.15
+ W_RECURRENCE · recurrence          // 0.20
+ W_ACTION     · actionability       // 0.10
+ W_SAFETY     · (1 − risk)          // 0.20
)                                     // weights sum to 1.0
```

Weights are named constants; Phase 1 picks defensible defaults, tuning is a separate decision.

`cooldown` is **not** a persisted dimension — it is a gate predicate (D4). Persisted candidates all passed cooldown, so a continuous cooldown score carries no information; persisted as a gate outcome only.

### D2 — Strengthened emit gate (scope #2, acceptance #2)

Phase 0 gate: `Signal A AND ≥1 supporting`. Phase 1 strengthens to:

> Persist iff **(strong signal + corroboration)** OR **(multiple independent supporting signals)** — AND evidence refs are non-empty — AND no counted shared neighbor is a hub.

- **Path 1 (strong + corroboration)**: `sharedNeighbors ≥ STRONG_SHARED (=3)` AND `≥1 supporting (B or C)`.
- **Path 2 (multi-independent)**: `sharedNeighbors ≥ minShared (=2)` AND `signalB AND signalC` (both supporting).
- **Evidence-first**: `sharedNeighborSlugs.length > 0` (always true once A passes; made an explicit predicate so "no concrete refs → reject" is enforced in code, not by coincidence).
- **Anti-generic hub filter**: a shared neighbor whose **global** link degree exceeds `HUB_DEGREE_MAX (=20)` does NOT count toward `sharedNeighbors` and is excluded from evidence refs. This directly blocks "two entities both link to a popular hub" generic overlap — the exact noise the issue names. Hub filtering happens inside the detector before score/gate.

New storage method: `batchGetLinkDegrees(slugs[]): Map<slug, number>` counts active links (`from_slug` or `to_slug`). Called once per pivot batch (bounded by the batch scope, not per-candidate).

Embeddings/LLM remain unused (non-goal). Hard cap 20/run unchanged.

### D3 — Dedup / equivalent suppression (scope #3, acceptance #4)

- **Exact pair** (including order/pivot re-detection): `pairKey` (sorted) + `discoveryDedupKey` already dedup. Unchanged.
- **Equivalent shape (same evidence, different target)**: before upsert, if any dismissed/resolved `proactive_connection` row shares ≥1 entity with the candidate AND its `metadata.evidence.shared_neighbor_slugs` set equals the candidate's set (set equality), suppress. This is the narrowest deterministic "equivalent" relation short of fuzzy matching — it catches "A connects via the exact same evidence neighborhood already judged as noise." Partial/fuzzy overlap is deliberately **not** suppressed (false-positive suppression of legitimate new connections).

### D4 — Dismissed-category cooldown (scope #4, acceptance #5) — no schema migration

Three layers, all reusing the existing lifecycle:

1. **Exact pair**: existing not-resurrected guarantee — `upsertDiscovery` conflict path never touches `status`/`seen`. A dismissed pair never re-surfaces. No new code; locked by test.
2. **Producer-side skip** (cleanliness): before upsert, look up the candidate's canonical entities in a lifecycle index — the new method `getDiscoveryLifecycleIndex(type, limit)` returns ALL rows of the type (any status); the producer derives the dismissed set + pre-upsert `occurrence_count` from it. If the exact pair is dismissed/resolved → skip upsert entirely (do not bump `occurrence_count` on a dead row; this freezes `last_detected_at` as the dismiss-time proxy). Correctness already holds via layer 1; this avoids noisy recurrence bumps on dead rows.
3. **Equivalent cooldown**: D3's evidence-identical suppression applies to dismissed/resolved rows — a new candidate whose evidence set matches a dismissed candidate's is suppressed.

No `dismissed_at` column, no schema migration, no metadata-clobber hazard (the producer **skips** rather than upserts suppressed pairs, so the conflict-path wholesale metadata replace never runs for them).

**Limitation (documented)**: slug renames change the `dedup_key` → a renamed pair re-surfaces as fresh (rare; CLAUDE.md "slug 改名遗漏" pitfall). Time-bounded cooldown windows and alias-aware semantic equivalence are deferred — Phase 1 suppresses deterministically and conservatively, favoring quiet per the issue.

### D5 — File organization (scope #1 note)

Keep scoring in `src/core/maintenance/proactive-connection.ts` for Phase 1: export a pure `scoreProactiveConnectionCandidate` helper + the strengthened-gate and equivalent/cooldown predicates from the same file. Rationale — the #310 structural-isolation test (`tests/core/maintenance/proactive-connection.test.ts:305`) asserts `git grep -l proactive_connection -- src/` matches exactly the 4 allow-listed files; adding a 5th file forces an allow-list edit that weakens that guard's intent. The file lands ~500 lines (under the 800 cap); the pure helper is still independently unit-testable via direct export. Split into `proactive-connection-scoring.ts` is deferred until the file crosses ~600 lines.

### D6 — `metadata.scoring` shape

```jsonc
{
  "source": "proactive_connection",
  "signals": { "shared_neighbors": 3, "cooccurring_sessions": 2, "timeline_proximity_days": 9 },
  "evidence": {
    "shared_neighbor_slugs": ["project-cfg", "concept-delta"],
    "timeline_event_refs": [{ "slug": "entity-alpha", "eventId": 7, "eventDate": "2026-06-01" }, { "slug": "entity-beta", "eventId": 9, "eventDate": "2026-06-10" }],
    "cooccurring_session_refs": ["s1", "s2"]
  },
  "scoring": {
    "evidence_strength": 0.85,
    "novelty": 1.0,
    "recurrence": 0.01,
    "actionability": 0.20,
    "risk": 0.10,
    "quality": 0.65,
    "gate_path": "strong_corroborated",
    "suppressed": null,
    "weights": { "evidence": 0.35, "novelty": 0.15, "recurrence": 0.20, "actionability": 0.10, "safety": 0.20 }
  },
  "pivot": "recently_ingested"
}
```

`gate_path ∈ {'strong_corroborated','multi_independent','rejected'}`. `suppressed` is `null` for persisted rows, or the reason (`'cooldown_exact' | 'cooldown_equivalent' | 'insufficient_evidence' | 'hub_only'`) when the producer skips (the skipped candidate is NOT persisted, so this field is for in-producer logging/`_debug` only — never reaches the discoveries table). `formatDigestCard` MUST NOT read `metadata.scoring`; locked by display-isolation test.

### D7 — Score column semantics

`discoveries.score` = `quality` (was Phase 0 flat formula). Used only for sort ordering in explicit reads (`discovery-digest.ts:276`); never rendered. The (0.01, 1] clamp invariant is preserved.

## Data model changes

- **No DDL, no migration.** Two new read-only `CBrainDB` methods:
  - `batchGetLinkDegrees(slugs: string[]): Map<string, number>` — for D2 hub filter.
  - `getDiscoveryLifecycleIndex(type: string, limit: number): Array<{ id, dedup_key, entities, metadata, last_detected_at, occurrence_count, status }>` — backs D4 cooldown AND D1 occurrence scoring; returns ALL rows of the type (any status) in one query, producer derives the dismissed set + occurrence_count. Column list modeled on `getDiscoveryById`.
- `metadata.scoring` is added by the producer (metadata is already a JSON string column; no schema change).

## Acceptance criteria → mechanism

1. strong evidence-backed → nonzero score + persists → D1 `quality` + D2 gate (path 1/2).
2. weak/generic insufficient evidence → rejected → D2 strengthened gate (hub filter + strong/multi path) + evidence-first predicate.
3. score/debug in raw metadata, absent from default display/cards → D6 + display-isolation test (formatDigestCard must not read `metadata.scoring`).
4. duplicate/equivalent → no multiple visible rows → D3 (pairKey/dedup_key + evidence-identical suppression).
5. dismissed/resolved (or equivalent) → quiet on repeated generation → D4 three-layer cooldown.
6. default `run_discovery`/`read_discoveries`/recall/search/ingest/`next_actions` quiet → preserved G1/G2/G3 + structural-isolation test extended to assert no new scoring read paths leak.
7. display sanitized (no slugs/paths/scores/SQL/debug/secrets/raw evidence) → preserved `safeTitle` + new "scoring fields never in card blob" test.
8. focused tests + project gates pass → verification target (typecheck + lint + full `bun run check`).

## Adversarial review targets (6 attacks — required before handoff)

1. **generic-overlap noise** → D2 hub filter (a shared neighbor linked to > HUB_DEGREE_MAX entities is rejected; construct a fixture where the only shared neighbor is a popular hub).
2. **duplicate/equivalent candidate spam** → D3 evidence-identical suppression + `dedup_key` (construct a candidate re-found via the other pivot and via a different target sharing the same evidence set).
3. **dismissed/resolved recurrence** → D4 three layers (dismiss exact pair → re-run → no surface; dismiss pair → emit candidate with identical evidence set → suppressed).
4. **score/debug leakage into display** → D6 display-isolation + secrecy (hostile page title + scoring fields never appear in card blob).
5. **accidental default surfacing** via run/read/`next_actions` → G1/G2/G3 untouched + regression tests (score=1.0 proactive still excluded from `next_actions`; proactive never in default read/run).
6. **hidden automatic actions/writes** beyond `upsertDiscovery` + verifier logs → the producer skip only **reduces** writes; assert no new write path is introduced.

## Adversarial review outcome (6 attackers, each constructed + ran a real bun attack)

- **Attacks 1 / 5 / 6 → clean** (generic-overlap hub filter, default-surfacing gates, hidden-writes surface all held).
- **Attack 2 (HIGH, #311 bug — fixed):** equivalent-suppression compared the TRUNCATED `sharedNeighborSlugs` (MAX_REFS=3), so a 4-neighbor dismissed pair stored `[g1,g2,g3]` and false-matched a new candidate sharing exactly those 3 → over-suppressed a legitimate distinct candidate. **Fix:** gate the comparison on the FULL `shared_neighbors` count (from `metadata.signals`, untruncated) before set-equality on the bounded slug sample. Regression test added.
- **Attack 3 (HIGH, #311 bug — fixed):** producer cooldown skip listed only `dismissed`/`resolved`; `status='seen'` (a documented, MCP-reachable status) was resurrected — occurrence bumped, score/metadata overwritten. **Fix:** skip ANY non-pending status (`existing.status !== 'pending'`), matching `updateDiscoveryStatus`'s own "non-pending = user acted" invariant. Regression test added. (MEDIUM sub-finding: `discoveries.status` has no CHECK constraint → weird strings could slip in; the `!== 'pending'` skip makes this moot for the producer path. Adding the CHECK is defense-in-depth, deferred to avoid schema churn.)
- **Attack 4 (HIGH, inherited #309 secrecy gaps on the proactive surface — fixed):** the #311 scoring fields themselves never leak, but the inherited `safeTitle`/`assertSafeActionDisplay` pattern set leaked hostile page titles into the proactive card: Unix absolute paths (`/etc/passwd`), destructive SQL (`DROP TABLE pages; --`), and raw hyphen-form slugs when the referenced page is missing; plus a pre-existing JWT regex gap. **Fix:** broadened `DISPLAY_UNSAFE_PATTERNS` (Unix-path regex, destructive-SQL regex, JWT first-segment `{8,}`→`+`), and `safeTitle` now returns the anonymous fallback (never the raw slug) when the page lookup is null. This touched `src/core/safety/display-safety.ts` (slight scope expansion, justified by acceptance #7 — the proactive card is the #311 surface); the 4-file `proactive_connection` source-confinement invariant is preserved (display-safety.ts is a shared safety module, not a proactive-specific one). 4 regression tests added.

Net: 7 confirmed findings, all fixed with regression tests; `bun run check` green (3392 pass).

## Known limitations / deferred

- Slug-rename resurrect window (dedup_key changes). Accepted; documented in D4.
- Time-bounded cooldown window (re-surface after N days). Deferred — Phase 1 suppresses deterministically; permanent quiet favors the issue's "stay quiet" intent.
- Alias-aware semantic equivalence. Deferred — requires entity-resolution wiring and carries false-positive suppression risk.
- `cleanupOldDiscoveries` has no production caller (inherited Phase 0 gap); unaffected by Phase 1.
- `actionability` is a fixed constant in Phase 1; deriving from neighbor entity-types is deferred.
- `formatDigestCard`'s other cases (bridge/trend/gap/similar_entity) still do not call `assertSafeActionDisplay` (inherited Phase 0 gap); out of scope here.

## Resolved decisions (宏哥 confirmed 2026-07-07)

1. **D1 weights & dimension set** — ✅ proposed 5-dimension weighted composite (evidence_strength 0.35 / recurrence 0.20 / safety 0.20 / novelty 0.15 / actionability 0.10; actionability flat 0.20).
2. **D2 hub filter** — ✅ global-degree hub filter, `HUB_DEGREE_MAX=20`, via new `batchGetLinkDegrees`.
3. **D3/D4 "equivalent"** — ✅ evidence-identical suppression (shared ≥1 entity AND identical `shared_neighbor_slugs` set); partial/fuzzy overlap deliberately not suppressed.
4. **D5 file org** — ✅ keep scoring in `proactive-connection.ts` (preserve the 4-file structural-isolation invariant); split deferred.

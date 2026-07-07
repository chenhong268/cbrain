# proactive_connection Phase 2 — Compounding Review Bridge Design Spec

**Issue:** #312 (parent #235, follows #310 Phase 0 + #311 Phase 1 — merged to main)
**Phase:** 2 — route high-quality proactive candidates into the EXISTING Compounding Review system
**Status:** design

## Context

#310 + #311 produce quiet, evidence-gated, scored `proactive_connection` discoveries. The quality gate is in place; default-quiet is enforced by three independent layers (G1/G2/G3). The next user-visible phase is to surface the strongest of these ONLY inside a low-frequency, explicit Compounding Review flow.

CBrain already ships the review machinery — `compounding_review_candidates`, `CompoundingReviewManager`, `ReviewGenerator` (5 gates), and MCP tools `get_compounding_reviews` / `act_on_review_candidate`. Phase 2 **connects** the proactive lane to that existing system. It does **not** create a second review framework, does **not** touch the quiet defaults of any other surface, and performs **no** automatic action beyond candidate upsert + best-effort discovery lifecycle sync.

All examples, fixtures, docs, and tests use **anonymous sentinels only**.

## Goal

When the user explicitly generates Compounding Review, eligible pending `proactive_connection` discoveries are promoted into `compounding_review_candidates` (type `supported_connection`), rendered as a bounded, sanitized review set, and acted on through the existing review action path. Normal recall / search / ingest / default discovery / `next_actions` remain quiet.

## Preserved boundaries (do not break)

Verified against current code (file:line in the integration map below):

- **Three quiet gates untouched**: G1 `read_discoveries` round-robin over `['bridge','trend','gap','contradiction']` only (`discoveries.ts:122`); G2 `run_discovery` digest filter `wantsProactive || type!=='proactive_connection'` (`discoveries.ts:248`); G3 `buildActionCandidatesFromDiscoveries` skips `QUIET_DISCOVERY_TYPES={'proactive_connection'}` (`action-candidates.ts:94,160`).
- **`isDigestExcluded` NOT extended** for `proactive_connection` (`discovery-digest.ts:52`) — extending it would also hide the explicit `read_discoveries({typeFilter})` path.
- **No new write side effects**: accept/reject/defer/disable never write pages, links, aliases, or external actions. The only new write is `updateDiscoveryStatus` (best-effort) on the source discovery.
- **No retune of #311**: scoring/gate/cooldown logic in `proactive-connection.ts` is read-only here.
- **No notifications, no LLM-only candidates, no auto merge/link/trust.**
- **No schema migration.**

## Integration map (existing surfaces — read-only reuse)

| surface | location | what Phase 2 uses |
|---|---|---|
| `CompoundingReviewManager.upsertCandidate` | `compounding-review.ts:96` | write candidate row (idempotent via `content_hash`) |
| `CompoundingReviewManager.transitionStatus` | `compounding-review.ts:116` | action → status (candidate + feedback audit, transactional) |
| `ReviewGenerator` + `GATE` | `compounding-review.ts:15-21,219-292` | read-side 5-gate filter; `MAX_OUTPUT_ITEMS=3` (`:140`) |
| `computeContentHash` | `compounding-review.ts:84-87` | `candidateType + title + sorted(sourceSlugs)` |
| upsert conflict semantics | `sqlite.ts:3506-3543` | pending/deferred → bump ts; terminal → no-op; **never overwrites scores/evidence** |
| `candidate_type` CHECK | `sqlite.ts:137,382` | `supported_connection` already declared, currently unused |
| `discoveryDedupKey` | `sqlite.ts:2493-2496` | `type\|sorted(entities)` — reverse-lookup key |
| `getDiscoveryLifecycleIndex` | `sqlite.ts:2615` | all rows of a type (any status) — backs source-ref recovery |
| `updateDiscoveryStatus` | `sqlite.ts:2557-2564` | id-keyed status mutation (+ derived `seen`) |
| proactive `metadata` shape | `proactive-connection.ts:479-508` | signals / evidence / scoring source for mapping |
| `display-safety.ts` | shared safety module | `safeTitle` + `DISPLAY_UNSAFE_PATTERNS` (hardened in #311) |

**Critical non-obvious facts driving the design:**

1. `supported_connection` is declared in the `CandidateType` union and CHECK constraint but has **no producer today** — the reserved home for bridged candidates, no DDL needed.
2. `compounding_review_candidates` has **no external source-ref column** (no `discovery_id` / `metadata_json`). Open JSON columns are `evidence_json` and `source_slugs_json` only.
3. Upsert on `content_hash` conflict **never overwrites** `scores_json`/`evidence_json`/`summary` — only timestamps (pending/deferred) or nothing (terminal). Promotion is idempotent by construction; later score improvements do **not** back-propagate (accepted for Phase 2).
4. `get_compounding_reviews` has **no sanitization layer** — `title`/`summary`/`evidence[].source/text` are returned verbatim. The bridge MUST sanitize before `upsertCandidate`.
5. `act_on_review_candidate` today has **zero side effects** beyond the candidate row + feedback audit.
6. All discovery mutations are **id-keyed**, never slug-keyed. Recovering the source discovery requires an entity-pair → id resolution (the producer already does this at `proactive-connection.ts:414-434`).

## Design decisions

### D1 — Promotion adapter (scope #1, new file)

New module `src/core/maintenance/proactive-review-bridge.ts` exports:

- `promoteProactiveCandidatesToReview(db, compoundingReview): { promoted: number; skipped: number; seen: number }` — reads pending `proactive_connection` discoveries, maps scores, sanitizes display, and upserts eligible items as `supported_connection` candidates. Iterates pending rows ordered by `score` desc, capped at `PROMOTION_LIMIT = 20` (sane ceiling; the review output is separately capped at `MAX_OUTPUT_ITEMS=3` by `ReviewGenerator`).
- Pure helpers (unit-testable, no DB): `mapProactiveToReviewScores(metadata, occurrenceCount)`, `buildReviewCandidateDisplay(...)`.

The adapter is the **only** place that bridges the two systems. It depends on `CompoundingReviewManager` (for upsert) + the existing discovery read methods. `proactive-connection.ts` is **not** edited unless a tiny exported helper is unavoidable; the producer's metadata shape is read as-is.

### D2 — candidateType = `supported_connection` (scope #3)

Already in the CHECK constraint (`sqlite.ts:382`) and type union (`sqlite.ts:137`). Zero schema change. This is the semantic home: a proactive candidate is a connection backed by shared-neighbor + co-occurrence/timeline evidence.

### D3 — Source ref recovery, no migration (scope #3, acceptance #3/#5)

`source_slugs_json` = the discovery's two canonical entity slugs (sorted). This is simultaneously:

- the `computeContentHash` input (stable per pair), and
- the reverse-lookup key for lifecycle sync.

At `act_on_review_candidate` time, the sync helper resolves the source discovery by scanning `getDiscoveryLifecycleIndex('proactive_connection', LIMIT)` for a row whose `entities` JSON matches the candidate's `source_slugs_json` pair, then calls `updateDiscoveryStatus(id, ...)`. `dedup_key` uniqueness guarantees at most one match. No new column, no migration, fully testable.

**Limit handling (hard constraint)**: `getDiscoveryLifecycleIndex` takes a `limit` (default 500). The bridge sync helper passes a deliberately large `LIMIT` (e.g. 5000) so an older source discovery is not silently missed. A regression test locks this: a target discovery sitting beyond the first 20 rows still resolves. If a large limit proves insufficient in practice, the fallback is a new read-only `getDiscoveryByEntities(type, entities)` keyed on `dedup_key` — deferred (adds surface); Phase 2 ships large-limit + test.

### D4 — Score mapping (TIGHT — confirmed decision)

Review gates (`compounding-review.ts:15-21`): `evidence ≥ 3`, `persistence ≥ 2`, `novelty ≥ 0.5`, `action_value ≥ 0.5`, `trust_risk ≤ 0.3`. Proactive dimensions are (0,1]; review evidence/persistence are counts. The mapping is honest (counts come from real signals), not a rescale that would weaken gates.

| review dim | source | formula | gate |
|---|---|---|---|
| `evidence` | `metadata.signals` | `sharedNeighbors + supportingSignalCount` where `supportingSignalCount = (cooccurring_sessions≥1?1:0) + (timeline_event_refs.length≥1?1:0)` | ≥3 |
| `persistence` | `metadata.signals` + occurrence | `min(occurrence_count, 2) + (timelineAndCooccur ? 1 : 0)`, capped at 3; where `timelineAndCooccur = timeline_event_refs.length≥1 AND cooccurring_sessions≥1` | ≥2 |
| `novelty` | `metadata.scoring.novelty` | verbatim | ≥0.5 |
| `action_value` | review constant | `REVIEW_ACTION_VALUE = 0.5` (a proactive connection is reviewable by construction — distinct from #311's flat 0.20 actionability) | ≥0.5 |
| `trust_risk` | `metadata.scoring.risk` | verbatim | ≤0.3 |

**The tightness lever is `persistence`.** A one-shot detection (`occurrence_count=1`, no dual corroboration) → `persistence=1` → fails ≥2 → not surfaced. Compounding Review only shows connections that have **compounded**: recurred (`occurrence_count≥2`) or multi-signal corroborated (timeline + co-occurrence both present). This realizes "只放过最强候选" without an arbitrary `gate_path` pre-filter; the review gates do the work.

All persisted proactive rows already passed #311's emit gate (`gate_path ∈ {'strong_corroborated','multi_independent'}`), so `evidence ≥ 3` and `trust_risk ≤ 0.3` hold for the promoted set by construction (verified against #311 formulas). `novelty`/`persistence` remain the discriminating gates.

**Fail-closed (adversarial #6)**: if `metadata.scoring` or `metadata.signals` is absent/malformed, `mapProactiveToReviewScores` returns `null` and the adapter **skips** the row. No candidate is created from a malformed discovery.

### D5 — Display sanitization (scope #3/#7, acceptance #4/#7)

The bridge builds anonymous, review-safe text before `upsertCandidate`. Reuses `display-safety.ts` (`safeTitle`, `DISPLAY_UNSAFE_PATTERNS` — hardened in #311).

- **title** (≤30 chars, **fixed anonymous constant** = `"潜在连接候选"`): identical across all proactive candidates. This guarantees the dedup hash depends only on `(candidateType, sourceSlugs)` — page-title edits between promotion runs cannot create a duplicate. Distinct pairs are distinguished by `summary` + `sourceSlugs` (the latter internal, never displayed).
- **summary**: sanitized, readable, aggregate natural copy — e.g. `"两条记忆通过 N 个共同邻居与 K 次共现形成连接，值得复盘是否建立显式关联。"`. Uses `safeLabel(slug)` (page-title lookup → `safeTitle`; hostile/missing → `"条目"`) for readability. **Not** part of `computeContentHash`, so it may vary across runs without affecting idempotency. Counts are fine (aggregate, non-PII); **no** slugs, paths, scores, gate_path, or raw refs.
- **evidence[].source**: sanitized labels (`"共同上下文"` / `"时间线邻近"` / `"共现会话"`) — **never** raw slugs or session ids.
- **evidence[].text**: aggregate description (`"3 个共同连接的条目"`) — **never** the raw `shared_neighbor_slugs` / `timeline_event_refs` / `cooccurring_session_refs`.
- **evidence[].dateRange**: derived from `timeline_event_refs[].eventDate` when present; else omitted. Dates are aggregate.

Raw `metadata.evidence` (slugs, event ids, session refs) and `metadata.scoring` stay in the discoveries row only — **never** copied into candidate `evidence_json`/`scores_json` are the mapped review scores only, which are counts/(0,1] numbers (not debug labels).

### D6 — Idempotency (acceptance #3)

`content_hash = "supported_connection" + "|" + title + "|" + sorted(sourceSlugs).join(",")`. With `title` a fixed constant, the hash reduces to a function of `sorted(sourceSlugs)` alone — fully stable across page-title edits and re-promotions. Re-promotion of the same pending pair → hash collision → upsert bumps `last_seen_at`/`updated_at` only (no duplicate, no score overwrite). Promotion of a pair whose candidate is already `accepted/rejected/disabled/superseded` → silent no-op (terminal status respected). The only hash-breaking edge is a slug rename (changes `sourceSlugs` itself) — see Known limitations.

### D7 — Trigger: `get_compounding_reviews` only (scope #6, acceptance #1/#6)

`get_compounding_reviews` input gains `refreshProactive?: boolean` (default **true** — confirmed decision). Handler:

1. If `refreshProactive !== false` → call `promoteProactiveCandidatesToReview(db, ctx.compoundingReview)` (idempotent, bounded by the existing 20/run proactive cap reflected in pending rows).
2. Then `new ReviewGenerator(ctx.compoundingReview).generate({ includeDeferred, limit })` as today.

The `refreshProactive: false` escape hatch supports pure reads (tests, dry inspection). **No other surface** (recall/search/ingest/run_discovery/read_discoveries/next_actions) calls the adapter — the bridge is reachable only through this one explicit review tool.

### D8 — Lifecycle feedback sync (scope #5, acceptance #5)

In the `act_on_review_candidate` MCP handler, **after** `transitionStatus` succeeds (candidate status is primary), run a best-effort sync when `candidate.candidate_type === 'supported_connection'` and `source_slugs_json.length === 2`:

| review action | candidate status | source discovery status |
|---|---|---|
| `accept` | accepted | `resolved` |
| `reject` | rejected | `dismissed` |
| `disable` | disabled | `dismissed` |
| `defer` | deferred | **unchanged (stays `pending`)** |

**`defer` rationale (explicit choice, per issue)**: defer = "not now from this review surface", not "this connection is dead". The discovery remains a valid pending signal; the deferred candidate row is excluded from default `generate()` output (`includeDeferred=false` default), and re-promotion is an idempotent timestamp bump — so defer does not cause re-surfacing. Marking it `seen` would conflate cleanup-protection semantics; leaving it `pending` is the minimal honest mapping.

Sync resolves the discovery id via D3's entity-pair reverse lookup, then `updateDiscoveryStatus(id, status)`. **Fail-open**: if the source discovery cannot be found (already cleaned up, renamed, or metadata malformed), log + continue — the candidate status update is NOT rolled back. This matches the issue's "best-effort ... only if the candidate status update succeeded".

A small helper `syncProactiveDiscoveryOnReviewAction(db, candidate, action)` lives in the bridge module; the MCP handler calls it. `CompoundingReviewManager` stays discovery-agnostic.

## Data model changes

- **No DDL, no migration.** `supported_connection` is already in the CHECK constraint.
- **No new `CBrainDB` methods required** — reuses `getDiscoveryLifecycleIndex`, `updateDiscoveryStatus`, existing candidate upsert/transition.
- New code: `src/core/maintenance/proactive-review-bridge.ts` (adapter + pure helpers) + wiring in `src/mcp/tools/compounding-review.ts`.

## Acceptance criteria → mechanism

1. high-quality pending → 1 candidate row → D1 + D4 + D7 (`refreshProactive:true`).
2. weak/dismissed/resolved/duplicate not promoted → D4 (malformed → skip) + producer-side `status='pending'` filter (only pending discoveries read) + D6 (terminal candidate status → no-op on re-promotion; deferred → no re-surface).
3. twice idempotent → D6 `content_hash` + upsert conflict semantics.
4. bounded output + privacy → D5 sanitization + existing `ReviewGenerator` compacting (`MAX_OUTPUT_ITEMS=3`, `MAX_EVIDENCE_ITEMS=3`).
5. `act_on_review_candidate` syncs both → D8.
6. normal surfaces quiet → G1/G2/G3 untouched + adapter scoped to `get_compounding_reviews` only (structural test: `git grep` for the adapter's import).
7. display sanitized → D5 + secrecy tests (hostile title/slugs/scoring → no leak in review output).
8. full gate green → `bun run check`.

## Adversarial review targets (6 attacks — required before handoff)

1. **Duplicate promotion**: same discovery promoted twice in one run + via repeated `get_compounding_reviews` → exactly one candidate row, only `last_seen_at` bumps (D6).
2. **Quiet-surface**: a proactive discovery with maximal mapped scores still absent from default `read_discoveries`/`run_discovery`/`next_actions` (G1/G2/G3 + adapter scoping).
3. **Feedback sync**: `reject`/`disable` on a candidate → source discovery `dismissed` → re-run review → candidate stays terminal (D6) and discovery not re-promoted as a new candidate.
4. **Privacy**: hostile page titles, raw source slugs, scoring metadata, session refs, event ids in the source discovery → none leak into review `title`/`summary`/`evidence` (D5).
5. **Side-effect**: `accept`/`reject`/`defer`/`disable` never write pages/links/aliases/external actions — only candidate row + feedback audit + (best-effort) discovery status (D8).
6. **Gate attack**: a proactive discovery missing `metadata.scoring`/`metadata.signals` (or malformed JSON) → `mapProactiveToReviewScores` returns null → adapter skips, no candidate, no throw (D4 fail-closed).
7. **Deferred no re-float (hard)**: after `defer`, a second `get_compounding_reviews(refreshProactive:true)` does NOT re-emit that candidate in default output AND does not create a new candidate row — the existing deferred row gets at most a timestamp bump (D6 + `includeDeferred:false` default).
8. **Pure-read escape hatch (hard)**: `get_compounding_reviews(refreshProactive:false)` calls neither the bridge nor `upsertCandidate` — zero candidate writes; identical to today's behavior (D7).
9. **Sync fail-open (hard)**: when the source discovery cannot be resolved (renamed/cleaned/malformed), `act_on_review_candidate` still returns success with the candidate's new status — candidate state is NOT rolled back and no error is surfaced (D8).

## Adversarial review outcome (6 attackers, each constructed + ran a real bun attack)

- **Attacks 1 / 2 / 3 / 5 / 6 → CLEAN**: duplicate-promotion idempotency (incl. duplicated source rows, occurrence/metadata drift, weak-candidate residue), quiet-surface across all default consumers (max-score proactive stays silent; bridge is the sole trigger), feedback-sync reappearance (reject/disable/accept loops + source_not_found edge), side-effect audit (zero writes to pages/links/aliases/timeline/tags/chunks/versions across happy + both throwing fallback paths), and gate fail-closed (malformed metadata + weak-but-valid → skipped by `passesReviewGate`, never written).
- **Attack 4 (CONFIRMED — fixed)**: the bridge's only injectable field is `metadata.evidence.timeline_event_refs[].eventDate` → `evidence[].dateRange`. The plan's blacklist (`sanitizeDisplayText`) leaks non-`SELECT *` SQL injection (`UNION SELECT`, `SELECT col FROM`, `UPDATE <table> SET`), Slack tokens (`xox[bpra]-`), Google API keys (`AIza…`), `password is <word>` phrasing, and markdown/URL exfil — classes a blacklist can't cover without false-positive risk on legitimate text. **Fix**: since `eventDate` is a date field (sourced from timeline `event_date`, parsed via `Date.parse`), switch to a **`Date.parse` whitelist** as the primary defense (any non-date payload → `""`) with `sanitizeDisplayText` kept as defense-in-depth backup. Regression test covers all 16 hostile payloads + valid-ISO-date preservation. This is a deviation from the plan's blacklist-only D5, justified by the review finding; it closes the whole eventDate surface without growing the shared blacklist.
- **Attack 3 benign note**: re-`accept` on a previously-rejected candidate flips the source discovery `dismissed → resolved`. Producer treats both identically (`proactive-connection.ts` skips any non-`pending`), so no functional impact; the candidate never re-outputs. Not fixed (audit-record nuance only).
- **Attack 6 PLAUSIBLE note**: a non-array `timeline_event_refs` is coerced to `[]` rather than fail-closing the row. Out of spec (D4 fail-closed covers missing/malformed `signals`/`scoring`), and degrades fail-safe (no leak/crash). Not fixed.

Net: 1 confirmed finding, fixed with a regression test (whitelist); `bun run check` green (3424 pass).

## Known limitations / deferred

- **No score back-propagation**: upsert conflict never overwrites scores; a candidate's review scores are a promotion-time snapshot. Accepted — issue does not require live refresh.
- **Slug-rename edge**: if an entity slug is renamed after promotion, the candidate's stored `source_slugs_json` no longer matches the discovery's current entities → reverse lookup at act-time may miss, and a re-promotion under the new slug creates a distinct candidate row. Rare; CLAUDE.md "slug 改名遗漏" pitfall. The old candidate row remains terminal-stable and does not re-surface.
- **`superseded`/`reactivate`** actions exist in the manager type system but are not in the MCP enum (`compounding-review.ts:33`); D8 covers only `accept`/`reject`/`defer`/`disable`.
- **Promotion writes during a "read" tool**: `get_compounding_reviews` semantically shifts to write-then-read when `refreshProactive:true` (default). Idempotent + bounded; `refreshProactive:false` preserves pure read. Documented in the tool description.

## Resolved decisions (confirmed 2026-07-07)

1. **`refreshProactive` default `true`** — opening review auto-promotes (idempotent, gated); `false` for pure reads.
2. **Tight score mapping** — `persistence` gate ≥2 is the quietness lever (recurrence or dual corroboration required); no extra `gate_path` pre-filter.
3. **`defer` → source discovery stays `pending`** — minimal honest mapping; cleanup-protection semantics not conflated.
4. **No schema migration** — source ref recovered via `source_slugs_json` entity pair + `getDiscoveryLifecycleIndex` reverse lookup.

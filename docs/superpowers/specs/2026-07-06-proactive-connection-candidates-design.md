# proactive_connection Candidates — Design Spec

**Issue:** #310 (parent #235)
**Phase:** 0 — quiet, opt-in, evidence-backed candidate lane
**Status:** implemented on `feat/310-proactive-connection`

## Context

CBrain answers questions and exposes diagnostics, but does not quietly notice when a newly accumulated memory may connect to older memory in a useful way. Phase 0 is NOT a notification system — it is a reviewable, evidence-backed candidate pool that reuses the existing `discoveries` lifecycle.

Existing infrastructure is reused unchanged:

- `discoveries` table (`dedup_key`, `status`, `seen`, `occurrence_count`) — `upsertDiscovery`
- `read_discoveries` / `run_discovery` / `update_discovery_status` MCP tools
- `runDiscoveryShadowVerifierFailOpen` fail-open verifier
- `formatDigestCard` display layer + `assertSafeActionDisplay` guard

`proactive_connection` is an **open-string discovery type** (precedent: `knowledge_map_*`, `action_*`), NOT added to the closed `DiscoveryType` union. The old in-memory proactive engine (`src/core/retrieval/proactive.ts`, rules `network_timeline`/`shared_connection`/`expiry_alert`) is untouched — it returns per-recall hints and never persists.

## Goal

A user or agent can ask "are there useful memory connections worth reviewing?" and get a small, auditable, evidence-backed set — without default recall/ingest/search pushing suggestions.

## Non-goals

- No notifications, no auto accept/merge/edit, no new connector behavior.
- No LLM planner / LLM-only insight. Detector is pure graph + co-occurrence + timeline math.
- No new storage table / migration.
- No dream schedule stage (deferred to a later #235 phase).
- No real names/slugs/paths/secrets in tests/docs/comments — anonymous sentinels only.

## Detection (deterministic, bounded)

`detectProactiveConnections(db, opts)` is pure graph + co-occurrence + timeline math. **Embedding similarity is never used.**

- **Pivot set**: `db.getEntityConceptPagesUpdatedSince(since)` (default 30d) — recently-updated entity/concept pages.
- **Per pivot**: one bounded `batchGetLinksForSlugs([pivot, ...oneHop])` builds a local undirected adjacency (current-fact links only — rejected/superseded edges dropped by `batchGetLinksForSlugs`).
- **Signal A (strong)**: a two-hop entity `P` shares ≥ `minShared` (=2) current-fact neighbors with the pivot AND is not directly linked to it.
- **Signal B (supporting)**: the pair co-occurs in ≥ `minSessions` (=2) distinct query sessions. Built once per run from `getDistinctSessionsSince` + `getSessionCoOccurrences`.
- **Signal C (supporting)**: each side has a dated timeline event and the two latest events are within `maxTimelineDays` (=14).

**Emit rule (in producer)**: persist iff `Signal A AND ≥1 supporting`. Signal A alone is detected but NOT persisted. Hard cap (=20) candidates per run.

## Evidence auditability (issue core)

Each candidate carries **bounded concrete evidence refs** so a reviewer (human, Hermes, Codex) can reconstruct WHY it fired:

| field | shape | bound |
|---|---|---|
| `sharedNeighborSlugs` | the shared neighbor slugs (e.g. `entity-alpha`, `project-beta`) | top 3 |
| `timelineEventRefs` | `{ slug, eventId, eventDate }` per side (latest event) | ≤ 2 |
| `coOccurringSessionRefs` | opaque session ids | top 3 |

These are written to `discoveries.metadata.evidence`. **Query text is never stored** — only opaque session ids. Counts (shared_neighbors / cooccurring_sessions / timeline_proximity_days) are kept in `metadata.signals` for ranking/sort.

## Display vs raw/debug evidence boundary (critical)

This is the central boundary the reviewer flagged. The two must stay cleanly separated:

| layer | contents | guard |
|---|---|---|
| **User display** (`formatDigestCard` → `cards[].title/why_it_matters/evidence/suggested_action`) | fixed anonymous copy ("可能的连接：X 与 Y", "综合图谱、检索与时间线索") + resolved page titles via `safeTitle` | `safeTitle` wraps `resolveTitle` in `assertSafeActionDisplay` try/catch → fixed fallback ("一条记忆") on hostile/missing title. **Never reads `metadata.evidence`.** One hostile row does not fail the whole read. |
| **Raw/debug audit** (`discoveries.metadata.evidence`) | bounded concrete refs (slugs, event ids, opaque session ids) | refs are slug/id/session — never title text, never query text, never secrets. Bounded top-3. |
| **Counts** (`discoveries.metadata.signals`) | shared_neighbors, cooccurring_sessions, timeline_proximity_days | ranking/sort only |

A hostile page title (e.g. a pasted credential used as a title) cannot leak: `metadata.evidence` stores only the slug ref (not the title text), and `formatDigestCard` sanitizes the title via `safeTitle` before it reaches display. The shadow verifier additionally scans candidate titles (`displayTexts`) for unsafe patterns — fail-open, observe-only, never blocks persistence.

## Opt-in triggers (only these)

- `run_discovery({ types: ["proactive_connection"] })` — dispatches to the producer (independent of `DiscoveryManager.runDiscovery`).
- `read_discoveries({ typeFilter: "proactive_connection" })` — explicit read.

## Default-quiet gates (acceptance #6 + #7)

Three independent chokepoints keep the lane quiet unless explicitly requested:

- **G1 (read default)**: `read_discoveries` round-robin iterates only `['bridge','trend','gap','contradiction']` — `proactive_connection` is never queried without an explicit `typeFilter`.
- **G2 (run digest)**: `run_discovery` post-run digest filter excludes `proactive_connection` unless `wantsProactive` — historical pending rows never leak into a default run.
- **G3 (next_actions)**: `buildActionCandidatesFromDiscoveries` skips `QUIET_DISCOVERY_TYPES` (proactive_connection) before the promotion gate — `next_actions` never surfaces it even when `occurrence_count>=3` or `actionable==='high'`.

`isDigestExcluded` is intentionally NOT extended — that would also hide the explicit `read_discoveries({typeFilter})` path.

## Lifecycle (inherited, acceptance #4/#5)

- **Dedup**: `dedup_key = proactive_connection|[sorted entities]`.
- **Recurrence**: `upsertDiscovery` conflict path bumps `occurrence_count` + updates `score`/`metadata`/`last_detected_at` — **never** touches `status`/`seen`/`suggestion`/`proposed_actions`. Dismissed/resolved rows stay dismissed.
- **Verifier**: `runDiscoveryShadowVerifierFailOpen` runs before every upsert (fail-open absolute — verifier failure never blocks persistence).

## Acceptance criteria → mechanism

1. strong evidence → candidate: emit rule (A + supporting)
2. weak/generic similarity → no candidate: embedding unused; A alone not persisted
3. metadata auditable + display concise: `metadata.evidence` bounded refs; `formatDigestCard` anonymous + `safeTitle`
4. dismissed/resolved not resurrected: `upsertDiscovery` conflict path by construction
5. repeated → occurrence bump: `upsertDiscovery` recurrence
6. default digest quiet: G1 + G2
7. `next_actions` quiet: G3
8. verifier fail-open: by construction

## Adversarial review (6 independent agents + constructed inputs)

- **F1** generic similarity → pass (embedding unused; A alone not persisted)
- **F2** dismissed/resolved → pass (conflict path; latent cleanup-resurrect window noted but `cleanupOldDiscoveries` has no production caller)
- **F3** display leak → **found & fixed** (`safeTitle` guard)
- **F4** default noise → pass (G1/G2/G3 load-bearing)
- **F5** hidden auto-action → pass (only writes are upsertDiscovery + verifier addIngestLog)
- **secrecy** (hostile title) → **found & fixed** (same `safeTitle` root cause)

## Known limitations / future work

- `cleanupOldDiscoveries` (no production caller today) would delete never-read pending rows after N days; producer re-inserts them. Phase 0 acceptable; revisit if a later #235 phase adds scheduling.
- Broader gap (out of scope): `formatDigestCard`'s other cases (bridge/trend/gap/similar_entity) also do not call `assertSafeActionDisplay`. A separate issue should adopt the `safeTitle` pattern across the digest lane.

# Similar Entity Discovery (#246) — Design Spec

> Issue: #246 · Parent roadmap: #228 · Date: 2026-06-30 · Level: L
> Phase 1 scope. Semantic embedding strategy deferred (see Non-goals).

## Goal

Add a conservative, **on-demand** discovery lane that proactively surfaces likely-duplicate `entity/%` / `concept/%` page pairs for human/Agent review, persists them through the existing `discoveries` lifecycle, and routes confirmed merges through the existing `merge_entities` workflow.

The missing capability today is: *"show me likely duplicate entities that need review."* Discovery is manual. With continuous NER stub creation, duplicate pages outpace manual cleanup.

This is a **governance / cleanup lane**, not a daily knowledge-insight lane. That distinction drives every design decision below.

## Hard constraints (execution brief — every task honors)

1. **No auto-merge.** Only review candidates + evidence. Confirmed merges go through existing `merge_entities` dry-run/execute only.
2. **No auto-alias.** Embedding/name similarity never writes an alias. (N/A in Phase 1 — no embedding — but the rule stands for all strategies.)
3. **No page/link mutation.** Execute/upsert writes ONLY a `discoveries` candidate row. Never `aliases`, `pages`, `links`, `tags`, or `timeline`.
4. **No LLM planner.** Detection is pure deterministic functions. No LLM call in any detection path.
5. **Default daily discovery excludes `similar_entity`.** It never appears in default `run_discovery`, the default daily digest, or default `read_discoveries`. See §10.
6. **Dismissed/resolved never resurrect as pending.** Reused from existing `upsertDiscovery` lifecycle (#172).
7. **Public tests/docs use only anonymous placeholders** (`实体A`, `实体B`, `组织C`, `主题D`). No real names/orgs/products/paths, even as negative assertions.

## Architecture — Approach A

Three layers, each independently testable:

1. **`src/core/name-similarity.ts`** — pure shared helpers extracted from `entity-resolver.ts` plus new primitives. No DB, no LLM, no I/O.
2. **`src/core/similar-entity-detector.ts`** — pure detector: takes the page universe + alias map + link degrees, returns `DetectionResult[]` with `type: "similar_entity"`. No DB writes, no LLM.
3. **`DiscoveryManager`** — gains a **structurally separate** method `runSimilarEntityDetection()` that fetches pages/aliases/adjacency from DB, calls the detector, and feeds results through the **existing** dedup → `upsertDiscovery` loop. This method is **never called by `runDiscovery()`**.

Why structural separation (not a flag): the CLI `cbrain discover` calls `runDiscovery()` with no args, and `runDiscovery(undefined)` currently means "run all types". To guarantee `similar_entity` can never leak through that path, it lives behind a different method, invoked only by explicit opt-in callers.

Helpers are extracted (not duplicated) so the detector and NER resolver share one normalization truth. The extraction is behavior-preserving: `entity-resolver.ts` imports the same functions it used to define inline.

## Components

### name-similarity.ts (new, pure)

Extracted from `entity-resolver.ts` (module-private there today):
- `normalizeForComparison(name): string` — lowercase; strip whitespace/hyphen/underscore/dot; strip parentheticals; strip non-letter/number (`[^\p{L}\p{N}]`). **Unchanged behavior.**
- `isSignificantSubstring(shorter, longer): boolean` — diff ≥ 3 OR shorter ≥ 60% of longer. **Unchanged.**

New primitives:
- `tokenizeForBlocking(name): Set<string>` — produces blocking keys (see §6).
- `boundedLevenshtein(a, b, maxDistance): number | null` — early-exit Levenshtein; returns `null` as soon as cost exceeds `maxDistance` (so cheap rejects dominate). Used with `maxDistance = 2`.
- `hasCjk(s): boolean` — true if string contains any CJK ideograph. Drives bigram blocking.
- `titleCanonicalScore(title, slug): number` — higher = more canonical (see §8).

`entity-resolver.ts` is edited only to delete its local copies and import these. No behavior change; existing resolver tests stay green unchanged (the gate).

### similar-entity-detector.ts (new, pure)

```ts
interface DetectorPage { slug: string; title: string; type: string; }
interface PageQuality {
  isStub: boolean;       // mirrors findEmptyShells: mention_count=0 ∧ no links ∧ no aliases ∧ no tags
  bodyChars: number;     // SUM(length(chunk.content)) — completeness proxy (pages has no summary column)
  chunkCount: number;    // number of chunks
  mentionCount: number;  // raw, for canonical tiebreak
  aliasCount: number;
  tagCount: number;
}
interface DetectorInput {
  pages: DetectorPage[];                        // entity/% + concept/% only (caller pre-filters)
  registeredAliasesBySlug: Map<string, Set<string>>; // aliases TABLE only, normalized, NEVER includes own title
  linkDegree: Map<string, number>;              // slug → undirected link count
  qualityBySlug: Map<string, PageQuality>;      // all per-page signals the orchestrator precomputes
}
function detectSimilarEntities(input: DetectorInput, opts?): DetectionResult[];
```

Two alias-key sets — do NOT mix (HIGH fix):
- **`registeredAliasesBySlug`** (input) — strings from the `aliases` table only, normalized. **Excludes the page's own title.** Used **only** for `match_kind` determination (`alias_shadow_page`, `shared_alias`). Using own-title-inclusive set here would misclassify `name_exact`/`name_normalized` pairs as alias pairs.
- **blocking keys** (derived inside the detector) — title (full normalized + tokens/bigrams) ∪ `registeredAliasesBySlug` ∪ acronym. Used **only** to generate candidate pairs (§6). Never consulted for `match_kind`.

`isStub` is a data field on `PageQuality`, not a closure — the detector never touches DB state, so it is fully deterministic and unit-testable from plain maps. Same input → same output, no side effects.

### DiscoveryManager wiring

- `DiscoveryType` union gains `"similar_entity"`.
- New method `runSimilarEntityDetection(): Promise<DiscoveryReport>` — builds `DetectorInput` from DB in bulk (`getEntityConceptPages`; `registeredAliasesBySlug` via one bulk alias load, **excluding own titles**; `linkDegree` via existing `buildAdjacency`; `qualityBySlug` via one bulk page-quality load using the shared `findEmptyShells` stub predicate), calls `detectSimilarEntities`, then runs the **same** dedup-by-sorted-pair → `upsertDiscovery` → count loop that `runDiscovery` uses.
- `runDiscovery(types?)` is **untouched** — it must not reference `similar_entity`. The detector is not in its type switch.

## Detection strategies (Phase 1 — deterministic, no embedding)

`match_kind` values stored in metadata: `name_exact | name_normalized | name_substring | edit_distance | alias_shadow_page | shared_alias`.

### Strategy ordering per pair

For each candidate pair (A, B) of independent pages (see §6 for how pairs are generated), evaluate in priority order; emit the **highest-priority** match that fires:

1. **`alias_shadow_page`** (highest priority, highest value — §5 alias rule).
2. **`shared_alias`** — A and B share ≥1 normalized alias string.
3. **`name_exact`** — raw titles equal (case-insensitive).
4. **`name_normalized`** — `normalizeForComparison` equal, raw differs.
5. **`name_substring`** — one normalized title contains the other, passes `isSignificantSubstring`.
6. **`edit_distance`** — `boundedLevenshtein(normalizeForComparison(A), normalizeForComparison(B), 2) ≤ 2`.

### Alias rule (correction #2 — alias is a signal source, not a filter)

`match_kind` alias checks use **`registeredAliasesBySlug` only** (aliases table, normalized, **no own title**). This is what prevents a plain `name_exact`/`name_normalized` collision from being misread as an alias relationship.

Given two independent pages A and B, compute:
- `aTitleAliasedToB` = `normalizeForComparison(A.title)` ∈ `registeredAliasesBySlug.get(B)`.
- `bTitleAliasedToA` = symmetric.
- `sharedAlias` = `registeredAliasesBySlug.get(A)` ∩ `registeredAliasesBySlug.get(B)` ≠ ∅.

Rules:
- **`aTitleAliasedToB` XOR `bTitleAliasedToA`** → emit `alias_shadow_page` candidate, **high** actionable. This is the strongest dirty-data signal: A's title is already registered as B's alias, yet A still exists as a separate page (a leftover orphan the resolver didn't clean up). `recommended_target` = the page owning the other's title (the alias holder).
- **Both directions fire** (each title is registered as the other's alias) → still emit `alias_shadow_page`, but resolve `recommended_target` via canonical scoring (§8); set `ambiguous_target: true` if that ties.
- **`sharedAlias`** (and no shadow) → emit `shared_alias` candidate, **high** actionable.
- **Otherwise** → apply name strategies (exact/normalized/substring/edit-distance). There is **no alias-based skip** for page pairs: iterating only over real pages, the "alias already points to canonical with no orphan page" case never produces a pair, so it is automatically excluded.

The naive "A.title ∈ B.aliases → skip" is explicitly rejected: that case is the single most valuable candidate, not noise.

### Type gate (applies to ALL strategies)

For every pair before emitting:
- `same_type` = A.type === B.type.
- `affine_type` = `getOntology().areTypesAffine(A.type, B.type)`.
- If neither → **drop the pair** (never compare across non-affine types).
- Cross-layer (e.g. record ↔ derived) is additionally blocked by `canMerge(A.type, B.type)`.
- `type_gate` field in metadata: `same_type | affine_type`.

### Actionable mapping

| Strategy | same_type | affine_type |
|---|---|---|
| `alias_shadow_page` | high | high |
| `shared_alias` | high | medium |
| `name_exact` / `name_normalized` | high | medium |
| `name_substring` | high (with guards) | medium |
| `edit_distance` | medium | medium |

(Phase 1 emits only high + medium. `low` is reserved for the deferred semantic-only strategy.)

## Blocking — avoid O(n²) (correction #1)

Strategies substring/edit-distance are **only evaluated on pairs that share ≥1 blocking key**. `tokenizeForBlocking(title)` produces the union of:
- the full normalized title (catches exact/normalized for free),
- each normalized alias string,
- ASCII/alnum tokens (split on `[^\p{L}\p{N}]`),
- **CJK bigrams** when `hasCjk(title)`: every 2-char sliding window of the normalized title (handles Chinese names that have no whitespace tokens),
- optional acronym/initial key for mixed-script titles.

Two pages are a candidate pair iff their blocking-key sets intersect. Build an inverted index `key → slug[]`; emit pairs within each bucket. This bounds work to O(shared-key pairs), not O(n²).

Blocking keys are derived **inside the detector** via `tokenizeForBlocking(title)` fed by each page's title plus its `registeredAliasesBySlug` entry. They are used **only** to generate candidate pairs. `match_kind` is decided afterward (§5) from `registeredAliasesBySlug` and name comparisons — never from blocking keys. `alias_shadow_page` / `shared_alias` evaluation also runs on every emitted candidate pair (the shadow signal is too high-value to gate on blocking alone, and the registered-alias sets are small).

Caps (module constants):
- `MAX_PAIRS_EVALUATED` — total candidate pairs tested per run (safety cap; e.g. 5000). If exceeded, stop evaluating and set `truncated: true` in the raw report.
- `MAX_CANDIDATES` — total candidates emitted per run (e.g. 100), after deterministic ranking. Ranking priority is applied **before truncation** (sort by actionable → name_score → same_type-before-affine → slug pair), per the rank-priority-before-truncate rule.

## Canonical target scoring + ambiguous rule (correction #3)

`recommended_target` is the suggested merge sink. Scored by a deterministic lexicographic comparison, NOT mention_count alone. All per-page signals come from `qualityBySlug` (+ `linkDegree`):

1. **Non-stub beats stub.** `qualityBySlug.get(slug).isStub` (mirrors `findEmptyShells`: `mention_count=0 ∧ no links ∧ no aliases ∧ no tags`). Non-stub wins outright.
2. **Completeness.** `bodyChars` higher wins (from chunks SUM — `pages` has no summary column); tiebreak by `chunkCount` higher.
3. **link_degree** (from `DetectorInput.linkDegree`) higher wins.
4. **mention_count** (`qualityBySlug.mentionCount`) higher wins.
5. **title canonicalness** (`titleCanonicalScore`): shorter, fewer parentheticals, fewer alias traces, slug with fewer path segments. Higher wins.

The first discriminator that differs picks the target. slug lexicographic is **not** used to force a choice — it is arbitrary to the user.

**Ambiguous rule:** if A and B tie on discriminators 1–5 (both stub-or-not, equal completeness, equal link_degree, equal mention_count, equal title-canonicalness) → do **not** set `recommended_target`; set metadata `ambiguous_target: true`. Do not force a recommendation when the data doesn't clearly favor one side. (A high-frequency but empty stub must never be picked as target just because it's mentioned often.)

## Persistence & lifecycle (fully reused — zero new persistence logic)

- `upsertDiscovery("similar_entity", [slugA, slugB], score, undefined, undefined, actionable, false, metadata)`.
- `dedup_key` is computed from sorted unique slugs → (A,B) and (B,A) collide. ✓
- On conflict: `ON CONFLICT(dedup_key) DO NOTHING` then recurrence UPDATE touches **only** `score / metadata / last_detected_at / occurrence_count` — never `status / seen`. ✓
- `getDiscoveriesByType("similar_entity")` filters `seen=0 AND status='pending'`, so dismissed/resolved rows are invisible as pending and survive `cleanupOldDiscoveries` (seen=1). ✓
- metadata fields: `match_kind`, `name_score`, `edit_distance?`, `type_gate`, `recommended_target?`, `ambiguous_target?`, `reason_code`, `shared_alias?`.

`inserted: false` on recurrence means it does not count toward the run's `total` (matches existing semantics).

## Surface exclusion rules (correction #1 — default surfaces must exclude)

`similar_entity` rows may exist in the `discoveries` table (after an explicit trigger), but they must **not** leak into any default surface.

| Surface | Shows `similar_entity`? |
|---|---|
| Default `run_discovery` (no `types`) | **No** — not in fast set; detector behind separate method. |
| Default daily digest (`getUnseenDiscoveries` → digest) | **No** — filter `r.type !== "similar_entity"` alongside the existing KM-type filter. |
| Default `read_discoveries` (no `typeFilter`) | **No** — not in the round-robin `activeTypes`; not a KM surface. |
| `read_discoveries({ typeFilter: "similar_entity" })` | **Yes** (explicit). |
| `run_discovery({ types: ["similar_entity"] })` | **Yes** (explicit opt-in) → routes to `runSimilarEntityDetection()`. |
| `find_similar_entities` (MCP) | **Yes** (dedicated). |
| `cbrain similar-entities --execute` (CLI) | **Yes** (dedicated). |

Implementation: wherever the digest reads unseen discoveries (`run_discovery` handler's `newRows`, and any shared helper), exclude `similar_entity` with the same pattern used for KM types today. This is the belt-and-suspenders defense on top of the structural separation in §3.

`formatDigestCard` gains a `similar_entity` case (natural language) so the dedicated surface can render it — but the default digest pipeline never feeds it one.

## Surfaces

### MCP `find_similar_entities` (new, dedicated)
- **Default: persists.** Agent explicitly calls it to enter the lifecycle. Option `dryRun?: boolean = false` for debug (no upsert).
- Input: `limit?: number` (default 20), `scope?: "entity" | "concept"` (slug-namespace filter, NOT ontology `page.type`), `dryRun?: boolean`.
- Runs detector → upsert (unless dryRun) → returns bounded **pending** candidates.
- Output has two layers:
  - **`display`** — user-facing natural language. Contains titles + match reason + confidence level (高/中). **Must not** expose raw score, edit_distance, slug, vector distance, debug, or filter internals.
  - **structured payload (raw)** — for the Agent to act: includes `match_kind`, `slug_a`, `slug_b`, `recommended_target`, `ambiguous_target`, `type_gate`, `score`. The Agent needs slugs to call `merge_entities`.
- Suggested review action text always points to `merge_entities` dry-run/execute; no new executor.

### CLI `cbrain similar-entities` (new, sibling to `dedup-types`)
- **Default: dry-run** (prints candidates, no upsert). Safe for humans.
- `--execute` upserts. `--scope <entity|concept>` filters slug namespace (NOT ontology type). Naming matches `dedup-types [--dry-run|--execute]`.

### `run_discovery` opt-in (handler-layer routing — MEDIUM fix)

The opt-in split happens in the **MCP tool handler / CLI command**, never inside `DiscoveryManager.runDiscovery()`:

- `DiscoveryManager.runDiscovery(types?)` **never references `similar_entity`**. Its type switch is untouched. `runDiscovery(undefined)` runs only bridge/trend/gap(/contradiction). This is the structural guarantee of "default not polluted".
- The MCP `run_discovery` handler inspects `types`:
  - if `types` is omitted → call `runDiscovery(undefined)` only. No similar_entity.
  - if `types` includes `similar_entity` → strip it, call `runDiscovery(rest)` for any normal types, **then separately** call `runSimilarEntityDetection()` (persists), and merge the two reports for the response payload. The merged report's digest path still excludes `similar_entity` rows (§10), so the user-facing digest stays clean even when the Agent explicitly asked for both.
- `types` without `similar_entity` → normal `runDiscovery(types)`, never touches the detector.

This makes "default excludes" and "opt-in routes to the dedicated method" both true without any contradiction in `DiscoveryManager`.

## Display vs raw (privacy + UX)

- `display` / user-facing digest cards: natural language only. Confidence as 高/中. Reason as a phrase ("名称高度相似，类型相同，疑似重复"). Never raw score, distance, slug, `_debug`, filter names.
- `raw` / Agent payload: score, `match_kind`, `edit_distance`, slugs, `recommended_target` allowed.
- This mirrors the existing digest contract (`display` + `raw` split in `read_discoveries`).

## File structure

**New:**
- `src/core/name-similarity.ts`
- `src/core/similar-entity-detector.ts`
- `tests/core/name-similarity.test.ts`
- `tests/core/similar-entity-detector.test.ts`
- `tests/mcp/find-similar-entities.test.ts`
- `tests/cli/similar-entities.test.ts`

**Modified (behavior-preserving edits where noted):**
- `src/core/entity-resolver.ts` — delete local `normalizeForComparison` / `isSignificantSubstring`, import from `name-similarity.ts`. **Behavior unchanged.** Existing suite stays green.
- `src/core/discovery.ts` — add `"similar_entity"` to `DiscoveryType`; add `runSimilarEntityDetection()`. Do **not** touch `runDiscovery`'s switch.
- `src/core/discovery-digest.ts` — add `similar_entity` case to `formatDigestCard`; ensure `shouldFilterDiscovery` / digest feed excludes it from the default path (§10).
- `src/mcp/tools/discoveries.ts` — add `"similar_entity"` to the `typeFilter` enum (read side only); register `find_similar_entities`; route `run_discovery({types:[similar_entity]})`.
- `src/cli/commands/maintenance.ts` — add `similar-entities` command.

No ontology change. No sqlite schema migration (`type` is TEXT). No LanceDB change.

## Acceptance criteria

1. Same-type anonymous title variants produce one `similar_entity` candidate.
2. Normalized punctuation/case variants produce a **high**-actionable candidate.
3. Similar-looking but genuinely different entities are **not** high-actionable.
4. `record` / source pages are ignored.
5. **alias-shadow duplicate** (A.title is B's alias, A still an independent page) is detected as a **high**-actionable `alias_shadow_page` candidate.
6. Dismissed/resolved candidates do **not** resurrect as pending on recurrence.
7. Discovery dedup is stable across repeated runs (same pair → recurrence bump, no duplicate visible rows).
8. **Default daily discovery / default `read_discoveries` contain no `similar_entity` rows.**
9. **Dry-run writes nothing** to `discoveries`; execute/upsert writes only a discovery candidate (no alias/page/link/tag write).
10. User-facing digest uses natural language, exposes no raw `score`/`distance`/slug/`_debug`/filter internals.
11. `merge_entities` remains the only execution path for confirmed merges.
12. Tests/docs use only `实体A`/`实体B`/`组织C`/`主题D`-style placeholders.
13. `ambiguous_target` is set (and no `recommended_target`) when discriminators 1–5 tie.

## Non-goals (Phase 1)

- No semantic embedding strategy (strategy 4 from the issue). Deferred — the entity-resolver embedding infra exists, but Phase 1 ships deterministic name/alias strategies only. Embedding may rank/confidence later; it never writes.
- No `SIMILAR_TO` ontology relation or graph edge.
- No MinHash / Jaccard body-overlap.
- No LanceDB schema migration / page-level vectors.
- No record/source-page merging.
- No bulk confirm flow into `batch_merge_pages` (after candidate quality is proven).
- No automatic stub/shell deletion (that stays with `clean-shells`).

## Open risks (flag during planning)

1. **`getEntityConceptPages` scale** — if the vault has thousands of entity/concept pages, the inverted-index blocking + caps must hold. Verify `MAX_PAIRS_EVALUATED` is not hit prematurely on a realistic vault; if it is, raise or tighten blocking keys (not silently truncate — `truncated: true` must surface in raw).
2. **Bulk input loading** — `registeredAliasesBySlug` and `qualityBySlug` are built per run for every entity/concept page. Use bulk queries (one alias load, one page-quality load), never N+1 `getAliases`/`getPage` per slug. Confirm bulk loaders exist or add them.
3. **Stub predicate parity** — `PageQuality.isStub` must mirror `findEmptyShells` exactly (`mention_count=0 ∧ no links ∧ no aliases ∧ no tags`). Extract a shared predicate (used by both `findEmptyShells` and the quality builder) rather than re-stating the SQL in two places.
4. **Two-set separation audit (HIGH fix)** — during planning, verify the detector implementation never consults blocking keys for `match_kind`, and that `registeredAliasesBySlug` is built without the page's own title. A regression here silently turns `name_exact` into `alias_shadow_page`.
5. **`run_discovery` routing** — confirm the MCP handler (not `DiscoveryManager.runDiscovery`) detects `types.includes("similar_entity")`, calls `runSimilarEntityDetection()` separately, and merges reports without polluting the digest payload.
6. **Default-digest leakage audit** — enumerate every call site that builds a digest from `getUnseenDiscoveries` / round-robin and confirm each excludes `similar_entity`. The structural separation is the primary guarantee; the filters are defense-in-depth.

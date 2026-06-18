# v2.0 Release-Candidate Gate

> Offline, repeatable go/no-go gate for v2.0 release-candidate hardening.
> Run by the release manager after the feature inventory is complete (#153) and
> before cutting the release tag.

## Why this gate exists

`gate:offline` proves the packed artifact can boot from a clean install and reach
first recall. It does **not** prove the kernel behaves well as a memory used
through natural-language journeys. This gate fills that gap: it drives the real
MCP handler path Hermes uses over eight anonymous journeys and asserts on
reliability, bounded performance, graceful degradation, response compactness,
and privacy.

- Fully offline. No network, no real LLM/provider call, no real vault access.
- Anonymous synthetic fixture only — no real-world identifiers anywhere.
- Leaves the checkout, real config, vault, runtime, and existing reports untouched.

## Run it

```bash
bun run gate:rc
```

- **stdout** — machine-readable JSON report (the single source of truth).
- **stderr** — a concise terminal summary for humans.
- **Exit codes** — `0` = go, `1` = no-go (a journey/privacy/cleanup check failed), `2` = fatal (gate bug).

## How to read the report

```jsonc
{
  "gate": "v2-rc",
  "verdict": "go",              // go | no-go
  "journeys": [ … ],            // eight journey results (see below)
  "privacy":   { "passed": true, "assertions": […] },
  "budgets":   {
    "baselines":      { "exact-recall": 26, "topic-recall": 14, … },  // constant SQL count, measured WITH scale fillers
    "headroom_mult":  2,                                              // small fixed margin: budget = baseline × mult
    "hang_ceiling_ms": 5000,
    "display_chars":   600
  },
  "slowest_journey": { "id": "exact-recall", "duration_ms": 5 },
  "failed_stage": null,         // first failing journey id, or "privacy" / "cleanup" / "fatal"
  "reason":     null,           // one-line why it failed
  "next_action": null,          // what to investigate first
  "cleanup":    { "verified": true, "path": "<cleaned>" },
  "duration_ms": 34
}
```

- **verdict** — `go` only when every journey passed, privacy is clean, and the
  temporary HOME/vault/runtime was removed.
- **failed_stage / reason / next_action** — populated on `no-go`; start there.
- **slowest_journey** — identifies the slowest journey for trend watching across
  release candidates (timing is for hang detection, not micro-benchmarking).

### The eight journeys

| Journey | Tool | What it proves |
|:--------|:-----|:---------------|
| `exact-recall` | `deep_recall` | An exact title entity is recalled; response is private + compact |
| `topic-recall` | `deep_recall` | A NON-title body phrase recalls the expected page as a HEALTHY (`status=ok`, non-degraded) hit via the vector+FTS hybrid path |
| `grounded-recall` | `deep_recall` (grounded) | Evidence board (facts/candidates/gaps/conflicts) is returned |
| `relationship-lookup` | `graph_query` | Relationships traverse from a seed entity |
| `episodic-person` | `recall_episode` | A person is found from absolute time/topic/context clues, and the matched clue dimensions are verified |
| `version-history` | `get_versions` | Provenance/version history is returned |
| `degraded-search` | `deep_recall` | A vector-index fault degrades gracefully: `status=degraded`, FTS fallback keeps a result, `search_meta.degraded=true`, user-safe wording, never an error |
| `empty-search` | `deep_recall` | A no-match query is graceful (`status=empty`), not an error |

Each journey result records `duration_ms`, `query_count`, `query_budget` (that
journey's per-journey budget), `display_chars`, `timed_out`, and the per-check
`assertions`.

### What is asserted, per journey

- **Privacy** — no slug path, filesystem path, stack trace, vector/embedding,
  debug term, or credential in `display` (the user-facing layer). `raw` keeps
  full structured data for follow-up expansion.
- **Compactness** — first-response `display` within the `display_chars` budget
  (short-message channel default).
- **Operation budget** — SQL statement count ≤ that journey's `baseline ×
  headroom_mult` (catches N+1 regressions deterministically, unlike wall-clock).
- **Hang ceiling** — every journey is bounded by `hang_ceiling_ms`; a handler
  that never resolves is caught, not hung forever.

### Per-journey query budget policy

Rather than one loose universal threshold, each journey has a **measured
constant baseline** (SQL statements on the anonymous fixture) and the budget is
`baseline × headroom_mult` (×2, a small fixed margin). The counts are fully
deterministic — verified zero variance across runs — so the headroom can stay
tight.

**Scale sensitivity (#184 round 2).** The fixture seeds **60 anonymous
irrelevant persons** alongside the five core pages, so the scale-sensitive
journeys (`episodic-person`, `relationship-lookup`) run over a realistically
sized set. The batch DB methods are true `IN`-clause batches, so a CORRECT
implementation's query count is a constant that does **not** grow as pages grow
(`episodic-person` stays at 6 queries over 62 persons). A per-page N+1
regression multiplies a journey's DB work with the page/person count and trips
`no-go` at that journey — 60+ queries would breach the 12 budget. A
five-page-only fixture cannot expose this; the scale fillers can.

The baselines live in `QUERY_BASELINE` inside `bin/check-v2-rc-gate.ts`; raise
one only when a journey legitimately gains a constant query. This is
deterministic and CI-stable — it is not a wall-clock micro-benchmark.

### Fixture realism — why normal recall is healthy, not degraded

A non-exact recall (`topic-recall`) must be a healthy `status=ok` result, never
degraded. Two things make the offline fixture behave like a real, well-used
memory instead of a cold never-used index:

- **A real vector signal.** The LanceDB stand-in runs cosine nearest-neighbour
  over the seeded page-body embeddings (a bag-of-character model), so a
  body-phrase query hits the matching page through the vector path — not only
  FTS. An unrelated query with zero shared characters gets no vector hit.
- **Core-concept weights.** The central concept (`method-alpha`) carries real
  `activity_weight`/`hotness_score`, exactly like a production memory that has
  been queried and recently touched. RRF alone (`≈ 1/(k+rank)`) stays below the
  low-score threshold; the weights push a normal hybrid score above it.

This does **not** weaken any production degradation threshold — it only makes
the fixture behave like a real used memory. The only journey that is
intentionally degraded is `degraded-search`, which forces a vector-index error.

## Release decision

| Verdict | Meaning | Action |
|:--------|:--------|:-------|
| `go` (exit 0) | All journeys, privacy, and cleanup pass | Proceed toward tag |
| `no-go` (exit 1) | A real journey failed, or a leak, or tmp leaked | Read `failed_stage` + `next_action`; do not tag |
| exit 2 | The gate itself threw | Gate bug — fix the gate, not the product |

`gate:rc` is one of three gates required for v2.0. The release manager also runs:

```bash
bun run check        # lint + typecheck + unit/integration tests
bun run gate:offline # fresh-install → first-recall (packed artifact)
bun run gate:rc      # this gate (journey quality)
```

All three must be green.

## Performance report (`gate:perf`)

`gate:rc` answers *go/no-go*; it does not surface where time or query budget is
being spent. `gate:perf` is a deterministic performance acceptance report that
**reuses the exact same anonymous journeys and MCP handler path** as `gate:rc`
and adds a performance view — observability first, no optimization (#188).

```bash
bun run gate:perf
```

- **stdout** — machine-readable `v2-perf` JSON report.
- **stderr** — a concise terminal summary for the release manager.
- **Exit codes** — `0` = go (all journeys within hard budgets), `1` = no-go (a
  journey over budget / failed / timed out, or cleanup failed), `2` = fatal.

### What the perf report adds

Per journey: `duration_ms`, `query_count`, `query_budget`,
`query_budget_utilization` (fraction of budget used), `display_chars`, `passed`,
`timed_out`.

Top-level:

| Field | Meaning |
|:------|:--------|
| `slowest_journey` | The journey with the largest `duration_ms` across this run |
| `highest_query_utilization_journey` | The journey closest to its query budget |
| `total_duration_ms` | Sum of per-journey durations (wall-clock trend signal) |
| `warnings` | Sanitized strings — a journey at **≥80%** of its query budget, or **≥80%** of the hang ceiling |
| `thresholds` | The `warn_budget_pct` / `warn_hang_pct` / `hang_ceiling_ms` knobs |
| `verdict` | Same HARD rules as `gate:rc` — a journey over budget/failed/timed-out or cleanup failure is `no-go` |

### How to interpret it

- **Verdict is the gate.** High utilization or a slow journey is a WARNING, not a
  failure — it tells the release manager where to look first if a user reports
  slow recall. A `go` still releases; a `no-go` does not.
- **Watch the hottest journey.** If `highest_query_utilization_journey` trends
  toward 100% across release candidates, an N+1 or unbounded scan is creeping in.
- **Compare across runs.** `slowest_journey` + `total_duration_ms` are the trend
  needles; they are not strict sub-second thresholds (those would be flaky across
  machines), so compare deltas, not absolutes.
- **Privacy is unchanged.** Warnings expose only journey ids + counts — never
  paths, content, or credentials.

### Non-goals (unchanged by this report)

`gate:perf` does not tune search ranking, NER, EntityResolver, LanceDB, or
SQLite; it does not add LLM calls; it does not change public MCP schemas or touch
the user vault/runtime.

## Fault injection (test-only)

The gate accepts env vars that inject a deterministic fault so the test suite
can prove failures produce `no-go`, clean temporary state, and leak no internal
detail. These are ignored in production runs.

| Env var | Fault | Expected |
|:--------|:------|:---------|
| `RC_FAULT_RETRIEVAL=1` | Recall is emptied; a must-hit journey misses | `no-go`, `failed_stage` = `exact-recall` |
| `RC_FAULT_PRIVACY_LEAK=1` | A banned token is injected into a journey display | `no-go`, `privacy.passed` = false, and the report echoes none of it |
| `RC_FAULT_QUERY_BUDGET=1` | Every SQL statement is counted ×1000, breaching budgets | `no-go`, `failed_stage` = `exact-recall`, reason names `query budget` |
| `RC_FAULT_HANG=1` | A handler never resolves | `no-go`, the journey's `timed_out` = true, caught within the ceiling |

The `degraded-search` journey forces a vector-index error on every run (no env
var needed) so the production degradation path is exercised on every gate run,
not only under fault injection.

See `tests/release/v2-rc-gate.test.ts` for the canonical assertions.

## Non-goals

- No new search, NER, ontology, or agentic capability.
- No production-data benchmark and no access to the real user vault.
- No strict sub-second threshold (would be flaky across machines).
- Does not change public tool schemas, version, or tags.

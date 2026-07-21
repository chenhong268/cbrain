# v2.0 RC Manual Readiness Checklist

> The final human-gated acceptance for v2.0 release-candidate sign-off.
> Run by the release manager **after** `bun run gate:v2-preflight` is green.
> The automated preflight gate proves the offline kernel is correct; this
> checklist covers the three things only a human + real environment can catch.

## Why this exists

`gate:v2-preflight` aggregates eight offline gates (`offline-first-recall`,
`rc-journeys`, `hermes-dialogue`, `performance`, `docs-consistency`,
`resolver-pilot`, `storage-consistency`, `recall-quality-matrix`). They are deterministic and fully
offline — they cannot drive a real Hermes conversation, measure end-to-end
latency on real search traffic, or validate a
version-pinned install against an external ref. Those three remain human /
environment responsibilities. This checklist fixes them in one place so the
RC decision does not depend on oral memory.

> **Repository vs operator scope (#379):** `gate:v2-preflight` runs from a clean checkout with no `cbrain.json`. Its `storage-consistency` stage uses an anonymous in-process fixture DB (gate id `consistency`, mode `repository-fixture`) and never opens operator vault/SQLite/LanceDB. Operator profile health is a separate gate: `bun run gate:profile-storage` (gate id `profile-storage-consistency`, mode `operator-profile`) — required only when validating a real profile, and run by the operator/release manager independently of the preflight.

**Green preflight is necessary, not sufficient.** All three items below must
also be recorded before tagging.

## The three manual gates

### 1. Real Hermes dialogue observation

Drive CBrain through real conversation via Hermes (not the offline fixtures)
for several rounds of genuine use. Watch for what the offline gates cannot
see:

- **Recall routing** — natural-language queries land on the intended path
  (content recall vs. grounded recall vs. episodic person vs. graph) without
  the user having to think about tool names.
- **Output clarity** — first responses are short, lead with the answer, and
  read as natural language (the copy-humanization work holds up in real flow).
- **No raw / debug leakage** — `display` never surfaces slugs, paths, scores,
  stack traces, or internal jargon; the `raw` layer stays hidden behind Hermes.
- **No excessive tool traces** — Hermes does not narrate every internal call
  or echo mechanical status reports back to the user.

Record: a short note per round (what was asked, did routing and output feel
right, any leak or over-narration). Cover a spread of recall / capture /
relationship queries, not just one path.

### 2. Real performance p95 sampling

Collect end-to-end latency from real search traffic — not the offline
`gate:perf` fixture (that is a deterministic budget check, not a latency
measure). Sources: real search traces from Hermes use, or the perf diagnose
output. Record the p95 for the three recall families:

| Recall path | p95 (ms) | Notes |
|:--|:--|:--|
| content recall (`deep_recall`) | | |
| front-door routing (`cbrain_recall`) | | |
| grounded recall | | |

There is no hard sub-second threshold (latency is machine-dependent); the goal
is to record a baseline so a regression in a later RC is visible, and to
confirm recall stays usable on the real environment. A sudden outlier or a
path that consistently times out is a signal to investigate before tagging.

### 3. Version-pinned install smoke

Once the RC tag (or release ref) exists, run a fresh install pinned to that
ref on a clean environment and confirm CBrain boots and reaches first recall.

- Install from the RC ref (not a dirty working tree).
- `cbrain serve` starts without manual intervention.
- First recall returns a result end-to-end.

This complements `gate:offline` (which boots the packed artifact) by proving
the version-pinned install path itself is intact.

Record: the ref installed, the environment, and pass/fail of boot + first
recall.

## Go / No-Go

**No-go (blocks the RC) — any one of these:**

- **Data corruption** — wrong, lost, or duplicated knowledge; broken sync.
- **Privacy leakage** — real names, paths, credentials, or `raw` / debug
  reaching the user.
- **Startup blocker** — `cbrain serve` cannot boot, or first recall is
  unreachable.
- **Install failure** — the version-pinned install does not complete or boot.
- **Core recall unavailable** — content / front-door / grounded recall broken
  or consistently timing out on real traffic.

**Does NOT block (track separately, do not gate the RC):**

- Minor copy / wording polish (e.g. remaining tightening in the #206 style).
- Non-core `WARN` from `gate:perf` — utilization warnings are observability,
  not failures (see `v2-rc-gate-acceptance.md`).
- Post-2.0 enhancements and feature requests.

## Recording results

Keep the signed-off result of each manual gate alongside the RC (release
notes, the RC issue, or wherever the candidate is tracked). A later RC re-runs
all three.

## Non-goals

- No production code changes, no new tools, no gate-logic extension.
- No new recall / NER / search optimization.
- Does not replace `gate:v2-preflight` — it runs after it.

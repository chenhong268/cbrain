# Operational and Abstract Recall Quality Matrix Implementation Plan

> **For implementing agent:** REQUIRED SUB-SKILLS: `superpowers:test-driven-development`, `superpowers:verification-before-completion`. Execute tasks in order. Do not change production retrieval/routing algorithms.

**Goal:** Complete #336 by upgrading the existing recall-quality gate to a
fixture-driven v2 matrix that distinguishes contract, recall, wrong-source,
false-ok, and sufficiency failures while preserving the #324 nine-case suite.

**Architecture:** Keep the executable entrypoint at
`bin/check-recall-quality-matrix.ts`. Put strict schemas, the pure quality
oracle, metrics, baseline comparison, and public-report projection in
`bin/lib/recall-quality-matrix.ts`. Execute real semantic cases through the
production `cbrain_recall` registration over a temporary SQLite/vault and a
deterministic in-memory vector stand-in. Operational cases compare the #336
fixture to the canonical Agent contract and never call semantic handlers.

**Tech stack:** Bun, TypeScript, `bun:test`, Zod-free explicit JSON validation,
SQLite, MCP `McpServer`, SHA-256, existing CBrain retrieval/frontdoor code.

**Base:** `28a61ca`

**Spec:** `docs/superpowers/specs/2026-07-16-operational-abstract-recall-quality-matrix-design.md`

**Issue:** #336
**Follow-up:** #337

## Global constraints

1. Use TDD: add a focused failing assertion, run it and observe the expected
   failure, then add the minimum implementation.
2. Do not edit:
   - `src/core/retrieval/**`
   - `src/core/recall/**`
   - `src/embedding/**`
   - `src/mcp/tools/**`
   - database migrations
3. Do not add fixture-specific branches to production code.
4. Do not read the configured/live CBrain vault or config.
5. Do not emit queries, hashes, sources, titles, bodies, snippets, answer
   points, scores, routes, paths, errors, or environment values in public JSON.
6. Preserve the ordered #324 IDs:
   `zh_exact`, `en_exact`, `mixed_alias`, `abstract_topic`, `honest_empty`,
   `temporal_evidence`, `relationship_route`, `operational_contract`,
   `bounded_runtime`.
7. A current semantic failure may enter the baseline only as an exact signature
   linked to `#337`. Route, legacy, unclassified degradation, schema, execution, privacy,
   and determinism failures are never baselineable.
8. Never add a baseline auto-update flag or alternate production fixture path.
9. Commit only paths in this worktree; preserve unrelated/untracked user files.

---

## Task 1: Strict anonymous fixture schemas

**Files:**

- Create: `bin/lib/recall-quality-matrix.ts`
- Create: `tests/fixtures/recall-quality-corpus.jsonl`
- Create: `tests/fixtures/recall-quality-cases.jsonl`
- Create: `tests/fixtures/recall-quality-baseline.json`
- Modify: `tests/bin/recall-quality-matrix.test.ts`

### Step 1: Add failing schema tests

Replace the test file's top-level import with imports for pure loader functions
that do not exist yet. Add a `fixture schema` describe block covering:

- valid controlled corpus and tagged cases;
- exact field allowlists for corpus, route-contract, semantic, and baseline;
- duplicate case/source/point IDs;
- closed reportable case-ID grammar;
- source/title/point-ID grammars;
- unknown source/point references;
- exhaustive, disjoint `allowed_sources`/`must_not_sources` partition;
- answerable `allowed_sources === expected_sources`;
- unanswerable `allowed_sources === []`;
- answerable status exactly `["ok"]`;
- unanswerable status exactly `["empty"]`;
- semantic tool/route exactly `cbrain_recall`/`content_recall`;
- finite space-delimited safe-token vocabulary;
- control character, traversal, absolute path, email, credential, and unique
  sentinel rejection;
- malformed JSON and unknown fields;
- no CLI/options/environment field for alternate fixture paths.

Expose test-only pure signatures:

```ts
export function parseRecallQualityCorpus(text: string): RecallCorpus;
export function parseRecallQualityCases(
  text: string,
  corpus: RecallCorpus,
): readonly RecallQualityCase[];
export function parseRecallQualityBaseline(
  text: string,
  cases: readonly RecallQualityCase[],
  corpus: RecallCorpus,
): RecallQualityBaseline;
```

### Step 2: Prove RED

Run:

```bash
bun test tests/bin/recall-quality-matrix.test.ts -t "fixture schema"
```

Expected: module/export or assertion failure because the strict loader is not
implemented.

### Step 3: Implement the minimum parser

In `bin/lib/recall-quality-matrix.ts`:

- define readonly tagged-union types;
- define `SAFE_FIXTURE_TOKENS` as a finite set used by every semantic free-text
  field;
- parse JSONL line by line without reflecting raw text in thrown public errors;
- validate exact keys with a reusable `assertExactKeys` helper;
- validate all cross-file references after individual row parsing;
- parse baseline JSON as an exact array with fixed failure enums and
  `follow_up === "#337"`;
- make thrown errors carry stable internal codes, not raw row text.

Create an initial anonymous corpus with at least four sources. Use only IDs
`source_a`... and titles `匿名记录A`.... Store answer points as
`{point_id,text}` and timeline rows as fixed ISO dates plus safe-token text.

Create final semantic rows for at least:

- `content_positive_01`, `content_negative_01`;
- `abstract_positive_01`, `abstract_negative_01`.

Test the route-case schema with in-memory synthetic rows. Do not add the real
operational rows to the canonical cases file until Task 3 can first prove the
missing-contract failure and then add the canonical near-miss row with its real
hash.

Start baseline as `[]`. Do not guess current failures before executing the real
integration.

### Step 4: Prove GREEN

```bash
bun test tests/bin/recall-quality-matrix.test.ts -t "fixture schema"
git diff --check
```

### Step 5: Commit

```bash
git add bin/lib/recall-quality-matrix.ts tests/bin/recall-quality-matrix.test.ts tests/fixtures/recall-quality-corpus.jsonl tests/fixtures/recall-quality-cases.jsonl tests/fixtures/recall-quality-baseline.json
git commit -m "test: define recall quality fixture contracts"
```

---

## Task 2: Pure truth table, metrics, and exact baseline

**Files:**

- Modify: `bin/lib/recall-quality-matrix.ts`
- Modify: `tests/bin/recall-quality-matrix.test.ts`

### Step 1: Add failing oracle tests

Use small hand-built observations. Cover every truth-table edge:

- answerable exact source+all points+ok -> no failures;
- answerable empty -> `recall_miss`;
- answerable wrong candidate+ok -> `recall_miss`, `wrong_source`,
  `irrelevant_but_ok`;
- expected source without required point -> `recall_miss`;
- required point appearing under a wrong source does not satisfy coverage;
- expected source plus any extra non-allowed source -> `wrong_source`;
- unanswerable empty+empty -> no failures;
- unanswerable non-empty+empty/degraded -> `unexpected_recall` regardless of
  source;
- unanswerable empty+ok -> `irrelevant_but_ok` and `status_mismatch`;
- degraded response always -> `degraded_response`;
- a degraded response without evidence proof additionally ->
  `unclassified_degraded`;
- expected coverage plus insufficient evidence ->
  `insufficient_false_positive`;
- semantic tool/frontdoor mismatch -> `route_mismatch`.

Add metric tests that lock exact numerator, denominator, and six-decimal rate:

- route accuracy across route-contract and semantic cases;
- Recall@3 as expected-source micro coverage;
- wrong-source and irrelevant-but-ok case rates;
- insufficiency denominator includes only answerable, expected-covered,
  sufficiency-applicable observations.

Add exact-baseline tests:

- exact ranked top3 + point IDs + statuses + degradation kind -> known failure;
- source order, point coverage, failure code, status, or degradation drift ->
  regression;
- baseline entry now passing -> unexpected pass;
- known failure -> `strict:no-go`, `ci:go`;
- unexpected pass -> both no-go;
- route/unclassified-degradation/non-baselineable failure never accepted;
- no failures/no baseline -> both go.

### Step 2: Prove RED

```bash
bun test tests/bin/recall-quality-matrix.test.ts -t "quality oracle|metrics|baseline"
```

### Step 3: Implement evaluator and projector

Add pure functions:

```ts
export function evaluateRecallCase(
  testCase: RecallQualityCase,
  observation: RecallQualityObservation,
): EvaluatedRecallCase;

export function aggregateRecallMetrics(
  cases: readonly EvaluatedRecallCase[],
): RecallQualityMetrics;

export function compareRecallBaseline(
  cases: readonly EvaluatedRecallCase[],
  baseline: RecallQualityBaseline,
): BaselineComparison;
```

Rules:

- create a sorted unique failure-code set;
- compare ranked top3 arrays; sort only per-source matched point IDs;
- keep source/point identifiers internal;
- treat any `route_mismatch` and `unclassified_degraded` as
  non-baselineable;
- compute `strict_verdict` only when CI integrity is valid and raw failures are
  zero;
- do not implement primary-outcome precedence;
- do not let `allowed_statuses` suppress another failure.

### Step 4: Prove GREEN

```bash
bun test tests/bin/recall-quality-matrix.test.ts -t "quality oracle|metrics|baseline"
git diff --check
```

### Step 5: Commit

```bash
git add bin/lib/recall-quality-matrix.ts tests/bin/recall-quality-matrix.test.ts
git commit -m "test: add exact recall quality oracle"
```

---

## Task 3: Operational contract positive and historical near-miss

**Files:**

- Modify: `skills/agent-facing.routing-eval.jsonl`
- Modify: `tests/fixtures/recall-quality-cases.jsonl`
- Modify: `bin/check-recall-quality-matrix.ts`
- Modify: `bin/lib/recall-quality-matrix.ts`
- Modify: `tests/bin/recall-quality-matrix.test.ts`

### Step 1: Add failing operational tests and fixture references

Compute SHA-256 over the intended anonymous historical input and use it in
`operational_negative_01` before the canonical row exists. Use the hash of one
existing current-state operational input for `operational_positive_01`.

Cover:

- positive resolves to canonical `operational -> next_actions`,
  `include_raw:false`, and all three forbidden recall/debug tools;
- historical near-miss resolves to canonical
  `content_recall -> cbrain_recall(normal)` and forbids `next_actions`;
- missing hash, duplicate canonical hash, changed tool/args/category, and
  missing forbidden tool fail;
- route observation actual values come from canonical data, expected values
  from #336 fixture;
- poison semantic factory throws if called, and call count remains zero for
  both route cases;
- route mismatch is non-baselineable;
- docs consistency still accepts the updated canonical profile.

### Step 2: Prove RED

```bash
bun test tests/bin/recall-quality-matrix.test.ts -t "operational contract"
bun run check:docs
```

Expected: the new runner/export assertions fail before implementation; docs may
also fail because the referenced historical contract row is not canonical yet.

### Step 3: Add the canonical row and implement the executor

Add one anonymous canonical row to
`skills/agent-facing.routing-eval.jsonl`:

```json
{"input":"此前记录过哪些系统体验问题","category":"content_recall","expected_tool":"cbrain_recall","expected_args":{"detail":"normal"},"forbidden_tools":["next_actions","query"],"forbidden_output_terms":[],"rationale":"此前记录过 → 历史内容回忆，不是当前运行状态"}
```

Add a canonical Agent-profile loader that:

- hashes input only in memory;
- never copies input/hash/rationale into the public report;
- resolves exactly one row per fixture;
- dispatches validation by expected tool (`next_actions` current state versus
  `cbrain_recall` historical near-miss);
- accepts a poison semantic factory in tests but never calls it.

### Step 4: Prove GREEN and commit

```bash
bun test tests/bin/recall-quality-matrix.test.ts -t "operational contract"
bun run check:docs
git diff --check
git add skills/agent-facing.routing-eval.jsonl tests/fixtures/recall-quality-cases.jsonl bin/check-recall-quality-matrix.ts bin/lib/recall-quality-matrix.ts tests/bin/recall-quality-matrix.test.ts
git commit -m "test: lock operational recall contract cases"
```

---

## Task 4: Establish hermetic worker, then execute real semantic recall

**Files:**

- Modify: `bin/check-recall-quality-matrix.ts`
- Modify: `bin/lib/recall-quality-matrix.ts`
- Modify: `tests/fixtures/recall-quality-corpus.jsonl`
- Modify: `tests/fixtures/recall-quality-cases.jsonl`
- Modify: `tests/bin/recall-quality-matrix.test.ts`

### Step 1: Add failing integration tests

First lock the execution topology, then require real production handler output:

- both suites start only inside a subprocess with temporary HOME/XDG and no
  inherited `CBRAIN_*` variables;
- the parent accepts only `--strict`; a fixed internal environment marker—not an
  argv flag—starts the canonical worker and cannot select fixtures or faults;
- create a bare `McpServer`; call `buildContext` only inside the closed worker
  with temporary vault/runtime/profile paths; call `registerFrontdoorTools`
  only and assert `jobs.start()` is never invoked;
- assert actual frontdoor route is `content_recall` and tool is
  `cbrain_recall`;
- assert content answerable, content unanswerable/near-noise, abstract
  answerable, and abstract unanswerable cases execute;
- assert top-three titles/snippets map to internal source/point IDs only;
- assert normal call arguments are `detail:"normal"`, `include_raw:true`;
- assert no LLM provider exists and no network adapter is called;
- assert live evidence envelopes normalize `sufficient` and
  `partial|insufficient` correctly;
- assert live evidence-derived degraded output maps to
  `degradationKind:"evidence"`;
- use a synthetic production-shaped envelope only for the mapper unit test that
  a degraded response without evidence proof becomes
  `degradationKind:"unclassified"` and non-baselineable; do not claim the real
  frontdoor exposes infrastructure reasons;
- vector-on finds the no-shared-token abstract source;
- vector-on uses real `cbrain_recall`, calls Lance search, and returns the source;
- an FTS-only control uses the production `HybridSearch.search` API directly
  with `strategy:"fts"` on the same context/query/data and does not return the
  source; it is explicitly not presented as a frontdoor call;
- vector comparison changes retrieval candidates, never final observations;
- vector ties sort by page slug and chunk index.

### Step 2: Prove RED

```bash
bun test tests/bin/recall-quality-matrix.test.ts -t "semantic integration|vector differential|evidence mapper"
```

### Step 3: Implement isolation before the deterministic harness

- parent validates CLI usage and spawns the same module with a fixed
  `RECALL_QUALITY_INTERNAL_WORKER=1` marker;
- child env contains required PATH/locale, that one fixed marker, and temporary
  HOME/XDG values; all inherited `CBRAIN_*` variables are absent;
- manual use of the marker can only run the same canonical read-only gate and
  still emits the same allowlisted report;
- create the temporary root before any context or suite starts;
- put DB close and root removal in nested `try/finally` blocks.

Then implement the deterministic harness:

Refactor the v1 helpers rather than duplicating them:

- seed pages/chunks/FTS/timeline in fixture order;
- use a fixed low-dimensional concept embedding whose mapping is confined to
  the test gate;
- implement in-memory cosine search and explicit tie-break;
- make `fullTextSearch` deterministic and keep production SQLite FTS path
  available;
- instantiate a bare MCP server/context without `createServer` or JobQueue
  start;
- extract `summary.status`, `raw.routing.chosen_route`,
  `raw.evidence_pack.coverage.coverage_status`,
  top-three synthetic titles, and snippets;
- map `partial` to `insufficient`;
- map degraded+evidence-insufficient to `evidence`; otherwise degraded becomes
  `unclassified` without inventing a hidden reason;
- never return raw values from the harness's public API.

Do not change any file under the production retrieval/tool directories.

### Step 4: Prove GREEN

```bash
bun test tests/bin/recall-quality-matrix.test.ts -t "semantic integration|vector differential|evidence mapper"
git diff --check
git diff --name-only 28a61ca...HEAD
```

The diff-name check must show no forbidden production file.

### Step 5: Commit

```bash
git add bin/check-recall-quality-matrix.ts bin/lib/recall-quality-matrix.ts tests/fixtures/recall-quality-corpus.jsonl tests/fixtures/recall-quality-cases.jsonl tests/bin/recall-quality-matrix.test.ts
git commit -m "test: execute deterministic semantic recall matrix"
```

---

## Task 5: Preserve legacy v1 and build the v2 report with an empty baseline

**Files:**

- Modify: `bin/check-recall-quality-matrix.ts`
- Modify: `bin/lib/recall-quality-matrix.ts`
- Modify: `tests/bin/recall-quality-matrix.test.ts`

### Step 1: Add failing legacy/report tests

Pin:

- exact ordered legacy ID list and retrieval/router/evidence lanes;
- legacy failure is `legacy_regression` and non-baselineable;
- `bounded_runtime` uses injected clock/timeout semantics, not the real
  five-second wall clock;
- v2 report contains fixed fields only;
- report includes schema version, mode, `strict_verdict`, `ci_verdict`, selected
  `verdict`, quality status, metrics, category/failure counts, safe per-case
  disposition, legacy summary, privacy/determinism state, fingerprint, advisory
  duration;
- report never contains source/point/query/hash/title/body/snippet/path/score/
  vector/route-debug/error fields or sentinels;
- fault injection mutates observations or raw envelopes, never a final pass
  boolean;
- exact known failure default/strict verdict behavior using pure injected data;
- regression/unexpected pass exit 1;
- usage/missing/malformed/schema bootstrap exit 2;
- unknown flags and `--cases`/`--corpus`/path environment overrides are rejected;
- no baseline update/install/write flag exists.

### Step 2: Prove RED

```bash
bun test tests/bin/recall-quality-matrix.test.ts -t "legacy v1|v2 report|CLI exit"
```

### Step 3: Implement report projection

- preserve the nine existing cases in an internal `legacy_v1` suite;
- replace their free-form fixture labels with controlled anonymous values if
  needed, without changing asserted behavior;
- remove the real 5-second verdict dependency and use injected boundedness;
- build public JSON from a literal allowlist, never object spreading raw data;
- canonicalize JSON keys and hash stable fields excluding advisory duration;
- expose no free-form error. Bootstrap output uses only fixed code enums;
- parse only `--strict`; reject every other argument;
- keep `RECALL_MATRIX_FAULT` out of production CLI. Test fault injection stays
  in exported internal functions.

### Step 4: Prove report behavior before baseline ratcheting

```bash
bun test tests/bin/recall-quality-matrix.test.ts
git diff --check
```

With the canonical baseline still empty, an observed current semantic failure
is expected to make the real gate no-go. Do not baseline it until all isolation,
cleanup, and reproducibility tests in Task 6 pass.

### Step 5: Commit

```bash
git add bin/check-recall-quality-matrix.ts bin/lib/recall-quality-matrix.ts tests/bin/recall-quality-matrix.test.ts
git commit -m "test: preserve legacy recall gate in v2 report"
```

---

## Task 6: Harden cleanup/reproducibility, then ratchet the final baseline

**Files:**

- Modify: `bin/check-recall-quality-matrix.ts`
- Modify: `bin/lib/recall-quality-matrix.ts`
- Modify: `tests/bin/recall-quality-matrix.test.ts`

### Step 1: Add failing isolation tests

Cover:

- both legacy and #336 suites still run only after isolation starts;
- worker subprocess environment contains only required PATH/locale and
  temporary HOME/XDG variables;
- inherited `CBRAIN_*` sentinels are absent;
- real configured vault/config paths cannot be opened (inject throwing spies);
- constructor/open/handler/DB-close failures all remove temporary root;
- DB close failure cannot skip `rm`;
- environment outside the subprocess remains unchanged;
- three fresh roots produce byte-identical stable report fields and identical
  fingerprint;
- advisory duration differences do not change fingerprint or verdict;
- stdout/stderr remain sentinel-free on success and every failure path.

### Step 2: Prove RED

```bash
bun test tests/bin/recall-quality-matrix.test.ts -t "isolation|cleanup|reproducibility|privacy sentinel"
```

### Step 3: Harden the existing worker boundary

- use nested `try/finally` so DB close and root deletion are independent;
- exchange only the allowlisted report between worker and parent;
- cap stderr/stdout capture and replace failures with fixed bootstrap codes;
- compute fingerprint from stable canonical JSON in the worker;
- keep real wall-clock duration advisory.

The worker marker remains a fixed internal execution mode, not a fixture/fault/
baseline update interface.

### Step 4: Observe failures in the final topology

Run with the baseline still empty:

```bash
bun test tests/bin/recall-quality-matrix.test.ts
bun run gate:recall-quality
```

Only stable semantic retrieval/evidence failures intended for #337 may be
ratcheted. Route, legacy, unclassified-degraded, schema, execution, privacy, or
determinism failures must be fixed in the harness.

### Step 5: Record only exact #337 failures

Manually add each baselineable current signature to
`tests/fixtures/recall-quality-baseline.json`: controlled case ID, sorted
failure codes, answer status, degradation kind, evidence sufficiency, ranked
top3 source IDs with sorted matched point IDs, and `follow_up:"#337"`.

Add a test that the baseline equals current observations. Never add wildcard,
skip, broad allowed status, snapshot rewrite, or update command.

### Step 6: Prove GREEN and commit

```bash
bun test tests/bin/recall-quality-matrix.test.ts -t "isolation|cleanup|reproducibility|privacy sentinel"
bun test tests/bin/recall-quality-matrix.test.ts
bun run gate:recall-quality
set +e
bun bin/check-recall-quality-matrix.ts --strict
strict_exit=$?
set -e
baseline_count=$(jq 'length' tests/fixtures/recall-quality-baseline.json)
if [ "$baseline_count" -gt 0 ]
then
  test "$strict_exit" -eq 1
else
  test "$strict_exit" -eq 0
fi
git diff --check
git add bin/check-recall-quality-matrix.ts bin/lib/recall-quality-matrix.ts tests/bin/recall-quality-matrix.test.ts tests/fixtures/recall-quality-baseline.json
git commit -m "test: ratchet hermetic recall quality baseline"
```

---

## Task 7: Documentation, full gates, and adversarial close-out

**Files:**

- Modify only if required: `package.json`
- Modify only if required: docs referenced by `check:docs`
- Modify: `docs/superpowers/plans/2026-07-16-operational-abstract-recall-quality-matrix.md`

### Step 1: Verify command wiring

Keep:

```json
"gate:recall-quality": "bun bin/check-recall-quality-matrix.ts"
```

Keep default `gate:recall-quality` inside `check:ci`. Do not add `--strict` to
CI. Add no new package dependency.

### Step 2: Run focused and full verification fresh

```bash
bun test tests/bin/recall-quality-matrix.test.ts
bun run gate:recall-quality
bun run check:docs
bun run lint
bun run check:ci
bun run check
git diff --check
git status --short
git diff --name-only 28a61ca...HEAD
```

Acceptance:

- focused tests: 0 failures;
- default gate: exit 0, CI go;
- strict gate: exit 1 only when the exact #337 baseline is non-empty;
- docs/lint/check:ci/full check: 0 failures;
- diff check clean;
- changed paths fit the spec allowlist;
- no real identities, paths, credentials, fixture content, or raw errors in
  generated output.

### Step 3: Run three fresh adversarial reviews

Dispatch read-only reviewers with separate briefs:

1. **Oracle/baseline anti-gaming:** try to make wrong source, false-ok,
   unanswerable leakage, degraded response, pass→regress, or source/point drift
   stay green.
2. **Route/retrieval reality:** verify operational near-miss, poison spy, real
   frontdoor handler, vector on/off differential, live evidence mapper, and
   legacy preservation.
3. **Privacy/determinism/CI:** inspect output allowlist, closed env, cleanup,
   canonical-only CLI, fingerprint, exit 0/1/2, and CI non-strict wiring.

Fix every HIGH/MEDIUM with TDD and rerun all affected gates. Repeat adversarial
review until all three approve.

### Step 4: Final implementation commit if needed

If review fixes remain unstaged:

```bash
git add <explicit in-scope paths only>
git commit -m "test: complete recall quality matrix v2"
```

Never use `git add .`.

### Step 5: Stop at the local implementation handoff

The implementation agent stops after local commits, verification, and the
evidence packet. It must not push, open/merge a PR, close #336, or remove the
worktree/branch. Those are separate independent reviewer/release-manager actions after
the implementation handoff is accepted.

## Final evidence packet

The close-out report must include:

- spec commit and implementation commit(s);
- local implementation commit SHA(s);
- focused/default/strict gate results;
- docs/lint/full-check counts;
- changed-path allowlist result;
- three adversarial review verdicts;
- exact number of baseline known failures and their follow-up issue (`#337`),
  without exposing internal source/query data;
- residual risk: Agent contract is not a live host-model route guarantee, and
  deterministic test embedding is not a production semantic quality score.

# Recall Candidate Honesty Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` task-by-task. Every implementation
> task uses TDD and receives separate specification and quality reviews.

**Goal:** Complete #337 by preventing weak FTS/vector candidates from making
`content_recall` claim success, while preserving bounded-exact FTS-only and
no-shared-token vector positives without adding a retrieval/DB/network/LLM call.

**Architecture:** `content_recall` opts into transient retrieval support.
Channel producers attach deeply frozen scalar evidence in a module-private
WeakMap; fusion preserves original/derived provenance without changing rank.
FTS/temporal use query-denominated local lexical coverage. The original vector
query optionally receives stored vectors in the same Lance call, computes local
cosine, and discards vectors before public results. A pure candidate gate filters
before sealed detail, page hydration, and evidence completion.

**Tech stack:** Bun, TypeScript strict mode, bun:test, SQLite FTS, LanceDB,
existing MCP front-door formatters and recall-quality gate.

**Issue:** #337 (parent #333; depends on merged #336 / PR #350)

**Base:** `21f0087`

**Approved spec:**
`docs/superpowers/specs/2026-07-16-recall-candidate-honesty-design.md`
at `64d7512` (three adversarial reviewers approved).

**Worktree:** use an isolated issue worktree selected at execution time; do not
record a user-specific absolute path in this public plan.

---

## Non-negotiable gates

- Do not edit cases, corpus, evaluator/oracle, router, embedding provider,
  schema, migration, package, or lockfile.
- Do not access a live vault or use private identities in code/tests/docs.
- Do not add a search, FTS, DB, Lance, embedding, network, fallback, or LLM call.
- Do not accept graph-only, derived-vector-only, opaque-hybrid, or missing
  support.
- Non-opted-in search, `deep_recall`, and non-content front-door behavior must
  remain unchanged.
- Rejected slugs must be filtered before sealed-detail, page, or evidence reads.
- The implementation history ends with exactly one implementation commit and
  one later baseline-only ratchet commit. Temporary task commits are squashed.
- Never auto-update the baseline.

## Expected file set

**Create:**

- `src/core/retrieval/retrieval-support.ts`
- `src/core/retrieval/content-relevance.ts`
- `tests/core/retrieval-support.test.ts`
- `tests/core/search-support.test.ts`
- `tests/core/content-relevance.test.ts`
- `tests/mcp/frontdoor-relevance.test.ts`
- `tests/storage/lancedb-search-vector.test.ts`

**Modify:**

- `src/storage/lancedb.ts`
- `src/core/retrieval/search.ts`
- `src/core/retrieval/recall-intent.ts` (anchored standalone temporal framing
  helper; existing broad intent detection remains unchanged)
- `src/mcp/tools/frontdoor.ts`
- `bin/check-recall-quality-matrix.ts`
- `tests/mcp/recall-evidence.test.ts` (anonymous fixture wording only; preserves
  the #232 evidence-pack assertion without relying on a fuzzy edit)
- `tests/bin/recall-quality-matrix.test.ts`
- `tests/fixtures/recall-quality-baseline.json` (Task 7 only)
- this plan only for checked progress, if needed

The file set is exact. No production or test path outside it may change.

### Task execution protocol for Tasks 1-5

Before Task 1, the plan must be committed and `git status --porcelain` empty.
For each task, a fresh implementer follows RED → GREEN, runs the listed focused
commands, stages exactly the paths named in that task's **Files** list, runs
`git diff --cached --check`, machine-compares `git diff --cached --name-only`
against that exact list, and makes a temporary checkpoint commit.
A separate specification reviewer runs first; a separate code-quality reviewer
runs only after spec compliance is approved. The implementer fixes findings and
amends its checkpoint until both reviewers approve. Record every checkpoint SHA
in the execution ledger. Task 6 soft-squashes these temporary commits into the
single required implementation commit.

---

## Phase 1 — Pure evidence contracts

### Task 1: Build private support storage and lexical/cosine primitives

**Files:**

- Create `src/core/retrieval/retrieval-support.ts`
- Create `tests/core/retrieval-support.test.ts`

- [ ] **Step 1: Write failing metadata privacy/immutability tests**

Cover:

- `attachRetrievalSupport` returns the same `SearchResult` object;
- getter returns a shared frozen empty summary for unattached objects;
- attached summary is copied into a fresh null-prototype tree;
- input objects and the `SearchResult` are not frozen;
- evidence leaf, channel node, and outer object are frozen;
- required non-finite `rankScore` drops the leaf;
- invalid optional cosine/coverage drops only that field;
- metadata is absent from `Reflect.ownKeys`, descriptors, keys, spread, and JSON;
- mutation attempts do not alter the stored summary.

Run and confirm RED because the module does not exist:

```bash
bun test tests/core/retrieval-support.test.ts
```

- [ ] **Step 2: Write failing Unicode/locality tests**

Pin exact values for:

- canonical four matrix phrases: strong content `0.8`, both noise shapes `<0.6`;
- spaced/unspaced Han equivalence;
- vocabulary-free bounded exact compact CJK positives with no fuzzy edits;
- semantic controls for `目的`/`打的`, three-particle chaining, hard boundaries,
  raw horizontal-whitespace locality, and over-160 spans;
- wrong subject/quarter/version/canonical-ID substitutions reject;
- long shared-suffix substitution and over-budget single-paragraph mutations;
- exact-plus-conflict precedence, relocated negation/state negatives, and an
  oversized tokenizer input that must fail closed without throwing;
- one-to-three query units require complete support;
- long query + one evidence unit is exactly `0.2`;
- local three-of-five is `0.6`;
- the same three terms separated by sentence punctuation, paragraph breaks,
  more than 160 code points, or at least three discarded single-character gap
  slots are `<0.6`;
- repeated units do not inflate the numerator;
- `RFC 7231`, `RFC-7231`, and `RFC7231` share one canonical unit;
- NFKC/full-width/case normalization;
- mixed BMP/supplementary Han produces code-point, not UTF-16, n-grams;
- empty/malformed input returns zero.

Also pin cosine behavior: scale invariance, `0.8` boundary/tolerance, just below
tolerance, zero norm, length mismatch, NaN, and infinity.

Run the expanded file again and confirm the lexical/cosine cases are collected
and still RED before implementing:

```bash
bun test tests/core/retrieval-support.test.ts
```

- [ ] **Step 3: Implement the smallest pure module**

Export only the types/constants/helpers approved by the spec:

```ts
export type RetrievalSupportChannel =
  | "exact" | "vector" | "fts" | "graph" | "temporal";
export type RetrievalQueryOrigin = "original" | "derived";

export const CONTENT_LEXICAL_MIN_COVERAGE = 0.6;
export const CONTENT_LEXICAL_WINDOW_UNITS = 5;
export const CONTENT_LEXICAL_MAX_WINDOW_SPAN = 160;
export const CONTENT_VECTOR_MIN_COSINE = 0.8;
export const CONTENT_VECTOR_EPSILON = 1e-6;

export function attachRetrievalSupport(...): SearchResult;
export function getRetrievalSupport(...): RetrievalSupport;
export function computeRootLexicalCoverage(...): number;
export function computeCosineSimilarity(...): number | undefined;
```

Implementation constraints:

- module-private WeakMap and shared frozen empty value;
- no DB/storage/page/evidence import;
- `Array.from`/code-point offsets for Han;
- evidence slot/gap and hard-boundary model from spec §7;
- bounded 4-64-code-point exact compact CJK rule from spec §7.3, implemented by
  linear KMP with exact alphanumeric runs, no fuzzy edits, and a
  100,000-code-point tokenizer input cap;
  it cannot bypass the 1-3-unit complete-match or 160-code-point raw-span rules;
- no document-wide `present anywhere` shortcut;
- no stopword/private vocabulary.

- [ ] **Step 4: Verify GREEN and mutation controls**

```bash
bun test tests/core/retrieval-support.test.ts
bun run typecheck
git diff --check
```

- [ ] **Step 5: Request separate spec and quality reviews**

The spec reviewer attacks formula values and privacy surface. The quality
reviewer attacks Unicode iteration, prototype copying, mutation, complexity,
and unnecessary abstraction. Fix every HIGH/MEDIUM before Task 2.

---

### Task 2: Add optional same-query Lance vector selection

**Files:**

- Modify `src/storage/lancedb.ts`
- Create `tests/storage/lancedb-search-vector.test.ts`

- [ ] **Step 1: Write failing real-Lance contract tests**

Using a temporary 2,048-dimensional Lance table, assert:

- omitted/false `includeVector` preserves the exact runtime result keys;
- true adds only a normalized `Float32Array` vector;
- on/off results have identical `(pageSlug, chunkIndex, _distance)` order;
- squared-L2 tie/order remains production behavior;
- unit and scaled vectors produce identical local cosine decisions;
- the current real Lance Arrow return value normalizes to `Float32Array`;
- temporary database closes and is removed on success and injected failure.

Run RED:

```bash
bun test tests/storage/lancedb-search-vector.test.ts
```

- [ ] **Step 2: Implement the narrow storage option**

Add:

```ts
export interface LanceSearchOptions {
  readonly includeVector?: boolean;
}

export interface SearchResult {
  // existing fields unchanged
  vector?: Float32Array;
}

async search(queryVector, limit = 10, options?: LanceSearchOptions)
```

Build the `.select(...)` list from the option. Normalize `row.vector` only when
requested. Do not change distance type, ordering, limit, schema, or any other
Lance method.

- [ ] **Step 3: Verify storage and existing callers**

```bash
bun test tests/storage/lancedb-search-vector.test.ts tests/core/lance-rebuild.test.ts
bun run typecheck
git diff --check
```

- [ ] **Step 4: Run two independent reviews**

Require proof that the default result shape is unchanged and that vector
selection is the same query, not a second probe.

---

## Phase 2 — Retrieval support propagation

### Task 3: Capture native support without changing search behavior

**Files:**

- Modify `src/core/retrieval/search.ts`
- Create `tests/core/search-support.test.ts`

- [ ] **Step 1: Write RED tests for opt-in and direct channels**

Assert:

- default search returns shared empty support and does not compute lexical
  coverage or request stored vectors;
- opted-in exact attaches original exact support;
- opted-in FTS uses full chunk content before public `slice(0, 200)`;
- a strong match beginning after character 200 retains strong coverage;
- temporal attaches root-query coverage; graph attaches rank-only support;
- original vector requests `includeVector:true`, stores cosine only, and drops
  vector from public `SearchResult`;
- missing/malformed/zero-norm returned vectors store no cosine;
- derived vector calls omit `includeVector` and store rank-only support.

- [ ] **Step 2: Write RED provenance/fusion tests**

Cover exact/hoisted-FTS/standard/expansion/decomposition separately:

- outer standard query is `original`;
- expansion index 0 keeps caller origin; generated variants are `derived`;
- a derived call never promotes its first variant;
- every decomposition child remains present and receives the root query plus
  `derived` provenance for exact/FTS/graph/temporal evidence;
- capture mode shares a one-shot override across children; only a non-exact
  child that already reaches vector search can claim it for the original outer
  query, while exact children stay zero-vector and every child remains present;
- reused hoisted FTS retains original support;
- nested fusion flattens exact/vector/FTS/graph/temporal evidence;
- original/derived evidence remains separate;
- strongest scalar selection follows spec §5.2;
- opaque hybrid has empty support;
- RRF score/order/snippet/limit/activity/hotness snapshots are unchanged;
- support trees remain deeply frozen after fusion.

Run RED:

```bash
bun test tests/core/search-support.test.ts tests/core/search.test.ts
```

- [ ] **Step 3: Implement support context and producers**

Add the four internal `SearchOptions` fields and a small internal context
resolver. Thread it explicitly through:

- exact fast path;
- strategy-specific paths;
- hoisted FTS probe;
- `searchSingleQuery` and `searchWithExpansion`;
- decomposition child `search` calls;
- vector/FTS/graph/temporal producers;
- both `mergeRankedResults` sites.

Only `capture && origin === "original"` may request candidate vectors. FTS
coverage is computed while full `r.content` is present. Attach support to the
selected per-slug vector result (preserve current chunk/page selection logic).
For decomposition, preserve all generated children and share one mutable
one-shot vector override. Exact children do not claim it; the first ordinary
child uses it in an already-existing vector call. All non-vector producers
remain derived, and an all-exact decomposition adds zero vector calls.

- [ ] **Step 4: Verify no rank/call regression**

For LLM decomposition, verify the child count is unchanged, actual
embedding/Lance calls do not exceed the legacy path, only one existing call can
request stored vectors for the original query, an exact first child is retained,
all-exact children make zero vector calls, and a failure in the original vector
slot remains fail-open without dropping successful children.

```bash
bun test tests/core/search-support.test.ts \
  tests/core/search.test.ts \
  tests/core/search.decompose.test.ts \
  tests/core/search.escalation-budget.test.ts \
  tests/core/search-latency-gate.test.ts \
  tests/core/sealed-detail-bounds.test.ts
bun run typecheck
git diff --check
```

- [ ] **Step 5: Two-stage review**

The specification reviewer traces every origin/root branch. The quality
reviewer attacks accidental vector payload fanout, support loss in fusion,
rank drift, missing full-content FTS, and default-path overhead.

---

## Phase 3 — Honesty boundary

### Task 4: Filter content candidates before all hydration

**Files:**

- Create `src/core/retrieval/content-relevance.ts`
- Create `tests/core/content-relevance.test.ts`
- Modify `src/mcp/tools/frontdoor.ts`
- Create `tests/mcp/frontdoor-relevance.test.ts`

- [ ] **Step 1: Write RED pure decision tests**

Pin the ordered truth table:

1. original exact => `exact`;
2. original cosine plus epsilon >= 0.8 => `strong_vector`;
3. FTS/temporal coverage >= 0.6 => `strong_lexical`;
4. derived exact requires root lexical >= 0.6;
5. graph-only, derived-vector-only, weak/multiple weak, missing support, invalid
   scalar, and opaque hybrid => `insufficient_support`.

Also assert filtering preserves relative order and retains strong rank 2/3.

- [ ] **Step 2: Write RED front-door sequencing tests**

Use poisoned spies to prove:

- content search called exactly once with
  `{ limit, _captureSupport:true, _skipDetailEnrich:true }` and no `multiStep`;
- rejected slugs never reach `pages.getBySlug`, sealed raw reads, timeline
  evidence assembly, or formatter raw payload;
- zero accepted => existing `empty` status/message;
- accepted only => page/evidence work only for accepted slugs;
- exact, strong FTS-only, vector-only, and temporal-only positives succeed;
- weak temporal still follows honesty, accepted temporal with incomplete
  evidence retains existing `degraded` behavior;
- embedding unavailable preserves strong FTS-only content;
- non-content route and `deep_recall` sealed-detail behavior/counters are
  byte-identical to base fixtures.

Add an explicit privacy matrix using unique synthetic field/value/reason/vector
sentinels. Exercise legacy and structured transport with `include_raw` both true
and false, plus query/debug raw, compact/audit, captured logger arguments,
`SearchTrace`, and forced error text. Assert MCP `content`, `structuredContent`,
raw payloads, logs, traces, and errors contain none of the sentinel names,
values, support fields, decision reasons, root query, or candidate vector. For a
surface that cannot receive an attached object, add a structural import test:
only `search.ts` and `content-relevance.ts` may import the support accessor; no
formatter/logger/transport module may do so.

Run RED:

```bash
bun test tests/core/content-relevance.test.ts tests/mcp/frontdoor-relevance.test.ts
```

- [ ] **Step 3: Implement pure gate and integrate only content route**

The pure module reads WeakMap support, emits only the four internal reasons, and
has no DB/storage import. In `runContentRecall`, request support/skip detail,
filter immediately, then derive slugs/entities/evidence from accepted results.
Do not log or serialize reasons, scalars, query units, or vectors.

- [ ] **Step 4: Verify focused front door and privacy sentinels**

```bash
bun test tests/core/content-relevance.test.ts \
  tests/mcp/frontdoor-relevance.test.ts \
  tests/mcp/frontdoor.test.ts \
  tests/mcp/recall-query-output-boundary.test.ts \
  tests/core/sealed-detail-display.test.ts
bun run typecheck
git diff --check
```

- [ ] **Step 5: Two-stage review**

Require reviewers to attack all-insufficient gaming, hydration-before-filter,
structured/legacy leaks, and non-content behavior drift.

---

## Phase 4 — Production matrix and auditable ratchet

### Task 5: Align the #336 stand-in and freeze absolute counters

**Files:**

- Modify `bin/check-recall-quality-matrix.ts`
- Modify `tests/bin/recall-quality-matrix.test.ts`
- Do **not** modify baseline yet

- [ ] **Step 1: Write RED differential/counter tests**

Change tests before the fake:

- fake squared-L2 sorts and limits all candidates without semantic filtering;
- negative distance-1 candidates enter top-N and are later removed by honesty;
- fake returns vector only for `includeVector:true`;
- include on/off order is identical;
- four semantic invocations + explicit controls pin:
  handler 4, HybridSearch.search 5, embedding 4, FTS 5, Lance 5, LLM 0,
  network 0, job-start 0, advanced fallback 0, support-only DB 0;
- abstract vector positive still has no shared tokens and production FTS miss;
- content positive returns only source A; both negatives empty; abstract positive
  returns only source C;
- privacy output contains no support field/reason/vector/sentinel.

- [ ] **Step 2: Make canonical tests valid in both ratchet phases**

The final test code must accept exactly two states, selected by the parsed
baseline length:

- pre-ratchet baseline length 3 => semantic cases all pass, comparison has
  exactly 3 unexpected passes, default/strict no-go and CLI exit 1;
- final baseline length 0 => semantic cases all pass, counts all zero,
  default/strict go and CLI exit 0.

No other baseline length/state is accepted. This allows Task 6 to prove the old
baseline stale and Task 7 to change only the JSON file.

- [ ] **Step 3: Implement production-shaped fake and counters**

Replace cosine/filtering inside `createGateVectorIndex` with squared-L2 sort,
stable tie-breaks, limit, and optional vector. Instrument controlled counters
without adding public/private values to the report. Spy `CBrainDB.ftsSearch` and
the fixed support-only DB boundary.

- [ ] **Step 4: Run matrix-focused tests with baseline still untouched**

```bash
bun test tests/bin/recall-quality-matrix.test.ts
git diff -- tests/fixtures/recall-quality-baseline.json
git diff -- tests/fixtures/recall-quality-cases.jsonl \
  tests/fixtures/recall-quality-corpus.jsonl \
  bin/lib/recall-quality-matrix.ts
git diff --check
```

Expected: unit tests pass under the exact pre-ratchet branch; the baseline,
cases, corpus, and evaluator diffs are empty.

- [ ] **Step 5: Two-stage review**

One reviewer attacks fake/production divergence and counters. Another attacks
oracle/baseline gaming, privacy, cleanup, and controlled fixture drift.

---

### Task 6: Form the single implementation commit and prove stale baseline

**Files:** all implementation/test files from Tasks 1-5; baseline untouched.

- [ ] **Step 1: Run implementation-focused green suite**

```bash
bun test tests/core/retrieval-support.test.ts \
  tests/storage/lancedb-search-vector.test.ts \
  tests/core/search-support.test.ts \
  tests/core/content-relevance.test.ts \
  tests/mcp/frontdoor-relevance.test.ts \
  tests/bin/recall-quality-matrix.test.ts
bun run lint
git diff --check
```

- [ ] **Step 2: Squash temporary task commits**

Record the plan commit SHA. Verify the baseline is byte-identical to `21f0087`,
then use a non-destructive soft reset to the plan commit and create one commit:

```bash
git diff --exit-code 21f0087 -- tests/fixtures/recall-quality-baseline.json
git reset --soft <PLAN_COMMIT_SHA>
git add -- bin/check-recall-quality-matrix.ts \
  src/core/retrieval/content-relevance.ts \
  src/core/retrieval/recall-intent.ts \
  src/core/retrieval/retrieval-support.ts \
  src/core/retrieval/search.ts \
  src/mcp/tools/frontdoor.ts \
  src/storage/lancedb.ts \
  tests/bin/recall-quality-matrix.test.ts \
  tests/core/content-relevance.test.ts \
  tests/core/retrieval-support.test.ts \
  tests/core/search-support.test.ts \
  tests/mcp/frontdoor-relevance.test.ts \
  tests/mcp/recall-evidence.test.ts \
  tests/storage/lancedb-search-vector.test.ts
bun -e 'const expected=["bin/check-recall-quality-matrix.ts","src/core/retrieval/content-relevance.ts","src/core/retrieval/recall-intent.ts","src/core/retrieval/retrieval-support.ts","src/core/retrieval/search.ts","src/mcp/tools/frontdoor.ts","src/storage/lancedb.ts","tests/bin/recall-quality-matrix.test.ts","tests/core/content-relevance.test.ts","tests/core/retrieval-support.test.ts","tests/core/search-support.test.ts","tests/mcp/frontdoor-relevance.test.ts","tests/mcp/recall-evidence.test.ts","tests/storage/lancedb-search-vector.test.ts"].sort(); const actual=Bun.spawnSync(["git","diff","--cached","--name-only"]).stdout.toString().trim().split("\n").filter(Boolean).sort(); if(JSON.stringify(actual)!==JSON.stringify(expected)){console.error({expected,actual});process.exit(1)}'
git diff --cached --check
git commit -m "fix: enforce honest content recall candidates"
```

Inspect the commit allowlist and whitespace:

```bash
git show --check --stat HEAD
git diff --name-only <PLAN_COMMIT_SHA>..HEAD
test -z "$(git status --porcelain)"
```

- [ ] **Step 3: Run both old-baseline gates and capture proof**

Do not use `&&`, because exit 1 is expected:

```bash
bun bin/check-recall-quality-matrix.ts > /tmp/337-default-pre-ratchet.json
code=$?
test "$code" -eq 1
bun bin/check-recall-quality-matrix.ts --strict > /tmp/337-strict-pre-ratchet.json
code=$?
test "$code" -eq 1
bun -e 'const files=Bun.argv.slice(1); const modes=["default","strict"]; const fail=(m)=>{throw new Error(m)}; for(let i=0;i<files.length;i++){const r=JSON.parse(await Bun.file(files[i]).text()); if(r.gate!=="recall-quality-matrix"||r.schema_version!==2||r.mode!==modes[i]||r.code!==undefined)fail(`bad envelope ${i}`); if(r.verdict!=="no-go"||r.strict_verdict!=="no-go"||r.ci_verdict!=="no-go")fail(`bad verdict ${i}`); if(JSON.stringify(r.counts)!==JSON.stringify({known_failures:0,regressions:0,unexpected_passes:3}))fail(`bad counts ${i}`); const semantic=r.cases.filter((c)=>c.kind==="semantic_recall"); if(semantic.length!==4||semantic.some((c)=>c.failure_codes.length!==0)||semantic.filter((c)=>c.disposition==="unexpected_pass").length!==3)fail(`bad semantic ${i}`); const m=r.metrics; for(const [name,n,d] of [["route_accuracy",6,6],["recall_at_3",2,2],["wrong_source_rate",0,4],["irrelevant_but_ok_rate",0,4],["insufficient_false_positive_rate",0,2]]){if(m[name].numerator!==n||m[name].denominator!==d)fail(`bad metric ${name} ${i}`)} if(!/^[a-f0-9]{64}$/.test(r.reproducibility_fingerprint))fail(`bad fingerprint ${i}`)}' /tmp/337-default-pre-ratchet.json /tmp/337-strict-pre-ratchet.json
shasum -a 256 /tmp/337-default-pre-ratchet.json /tmp/337-strict-pre-ratchet.json
```

The machine assertion above proves both files are non-error schema-v2 reports
and asserts exactly:

- semantic pass 4/4;
- known failures 0;
- regressions 0;
- unexpected passes 3;
- default/strict verdict no-go;
- route 6/6, relevant Recall@3 2/2, wrong-source and irrelevant-but-ok 0.

Save the two SHA-256 values for Task 7's commit message. Do not commit raw
reports.

- [ ] **Step 4: Adversarial implementation review**

Three independent reviewers inspect the single commit:

1. algorithm/retrieval correctness;
2. architecture/performance/call counts;
3. oracle/privacy/baseline evidence.

Fix any HIGH/MEDIUM by amending the implementation commit, rerun Step 3, and
obtain fresh fingerprints.

---

### Task 7: Apply the baseline-only ratchet

**Files:**

- Modify only `tests/fixtures/recall-quality-baseline.json`

- [ ] **Step 1: Replace canonical baseline with an empty array**

Use `apply_patch`; do not run or create an updater.

- [ ] **Step 2: Prove the staged allowlist**

```bash
test -z "$(git diff --cached --name-only)"
git diff -- tests/fixtures/recall-quality-baseline.json
git diff --exit-code HEAD -- tests/fixtures/recall-quality-cases.jsonl \
  tests/fixtures/recall-quality-corpus.jsonl \
  bin/lib/recall-quality-matrix.ts \
  bin/check-recall-quality-matrix.ts
```

Only the baseline JSON may differ from the implementation commit.

- [ ] **Step 3: Commit with pre-ratchet proof**

The commit body records the default/strict pre-ratchet counts and both SHA-256
fingerprints, without raw reports or private paths:

```bash
git add -- tests/fixtures/recall-quality-baseline.json
test "$(git diff --cached --name-only)" = "tests/fixtures/recall-quality-baseline.json"
git diff --cached -- tests/fixtures/recall-quality-baseline.json
git diff --cached --check
test -z "$(git diff --name-only)"
test -z "$(git ls-files --others --exclude-standard)"
git commit -m "test: ratchet recall quality baseline" \
  -m "Pre-ratchet: known=0 regressions=0 unexpected=3; default=<sha256>; strict=<sha256>"
test "$(git diff-tree --no-commit-id --name-only -r HEAD)" = "tests/fixtures/recall-quality-baseline.json"
test -z "$(git status --porcelain)"
```

- [ ] **Step 4: Prove both gates GREEN**

```bash
bun run gate:recall-quality
bun bin/check-recall-quality-matrix.ts --strict
bun test tests/bin/recall-quality-matrix.test.ts
```

Expected counts: known 0, regressions 0, unexpected 0; both exits 0.

- [ ] **Step 5: Baseline-only review**

An independent reviewer verifies the commit changes one file only, the prior
implementation commit retained the old baseline, fingerprints/counts are in the
message, and cases/corpus/evaluator/bin implementation are untouched.

---

## Phase 5 — Whole-branch verification and delivery

### Task 8: Run full gates, adversarial branch review, and publish

At the start of this phase, bind the release base from the verified four-commit
topology once; every later command consumes this value:

```bash
export BASE_SHA=$(git rev-parse HEAD~4)
```

- [ ] **Step 1: Run focused, budget, privacy, and legacy gates**

```bash
bun test tests/core/retrieval-support.test.ts \
  tests/storage/lancedb-search-vector.test.ts \
  tests/core/search-support.test.ts \
  tests/core/content-relevance.test.ts \
  tests/mcp/frontdoor-relevance.test.ts \
  tests/core/search.escalation-budget.test.ts \
  tests/core/search-latency-gate.test.ts \
  tests/core/sealed-detail-bounds.test.ts \
  tests/mcp/recall-query-output-boundary.test.ts \
  tests/bin/recall-quality-matrix.test.ts
bun run gate:recall-quality
bun bin/check-recall-quality-matrix.ts --strict
```

- [ ] **Step 2: Run repository gates**

```bash
bun run check:docs
bun run lint
bun run check:ci
bun run check
git diff --check "$BASE_SHA"..HEAD
git status --short
```

- [ ] **Step 3: Run privacy and scope scans**

First run a fail-closed path/topology assertion (the approved history is exactly
four commits after the release base):

```bash
bun -e 'const base=Bun.argv[1]; const run=(args)=>{const p=Bun.spawnSync(args); if(p.exitCode!==0)throw new Error(p.stderr.toString()); return p.stdout.toString().trim().split("\n").filter(Boolean)}; const impl=["bin/check-recall-quality-matrix.ts","src/core/retrieval/content-relevance.ts","src/core/retrieval/recall-intent.ts","src/core/retrieval/retrieval-support.ts","src/core/retrieval/search.ts","src/mcp/tools/frontdoor.ts","src/storage/lancedb.ts","tests/bin/recall-quality-matrix.test.ts","tests/core/content-relevance.test.ts","tests/core/retrieval-support.test.ts","tests/core/search-support.test.ts","tests/mcp/frontdoor-relevance.test.ts","tests/mcp/recall-evidence.test.ts","tests/storage/lancedb-search-vector.test.ts"].sort(); const spec=["docs/superpowers/specs/2026-07-16-recall-candidate-honesty-design.md"]; const plan=["docs/superpowers/plans/2026-07-16-recall-candidate-honesty.md"]; const baseline=["tests/fixtures/recall-quality-baseline.json"]; const eq=(a,b,label)=>{a=[...a].sort();b=[...b].sort();if(JSON.stringify(a)!==JSON.stringify(b))throw new Error(`${label}: ${JSON.stringify({a,b})}`)}; eq(run(["git","diff","--name-only",`${base}..HEAD`]),[...spec,...plan,...impl,...baseline],"branch paths"); eq(run(["git","diff-tree","--no-commit-id","--name-only","-r","HEAD"]),baseline,"baseline commit"); eq(run(["git","diff-tree","--no-commit-id","--name-only","-r","HEAD^"]),impl,"implementation commit"); eq(run(["git","diff-tree","--no-commit-id","--name-only","-r","HEAD~2"]),plan,"plan commit"); eq(run(["git","diff-tree","--no-commit-id","--name-only","-r","HEAD~3"]),spec,"spec commit"); const subjects=run(["git","log","--reverse","--format=%s",`${base}..HEAD`]); const expectedSubjects=["docs: design honest content recall candidates","docs: plan honest content recall implementation","fix: enforce honest content recall candidates","test: ratchet recall quality baseline"]; if(JSON.stringify(subjects)!==JSON.stringify(expectedSubjects))throw new Error(`subjects: ${JSON.stringify({subjects,expectedSubjects})}`); if(run(["git","rev-list","--count",`${base}..HEAD`])[0]!=="4")throw new Error("commit count")' "$BASE_SHA"
test -z "$(git status --porcelain)"
```

Review changed files and scan for private identities/paths, support leakage,
debug fields, raw vectors, and forbidden scope. Confirm:

- no real names/organizations/products/items in new fixtures/docs;
- no vault/profile/credential path;
- no `vectorCosineSimilarity`, `rootLexicalCoverage`, rank score, decision
  reason, vector, root query, or sentinel in any MCP/report output;
- no package/lock/schema/migration/router/provider drift;
- only spec, plan, one implementation commit, and one baseline-only commit are
  present after base.

- [ ] **Step 4: Three whole-branch adversarial reviews**

Reviewers independently attack:

1. false-green/oracle/baseline gaming and all-insufficient behavior;
2. retrieval correctness, language controls, fusion/provenance, exact/FTS/vector
   regressions, and fake/real Lance parity;
3. privacy, public API, call/latency budgets, cleanup, commit topology, and
   release risk.

Fix every HIGH/MEDIUM. Amend only the implementation commit for implementation
defects. Because HEAD is the baseline commit, use this deterministic sequence;
never run `git commit --amend` while the ratchet commit is HEAD:

```bash
RATCHET_SHA=$(git rev-parse HEAD)
git reset --mixed HEAD^
git restore --source=HEAD --staged --worktree -- tests/fixtures/recall-quality-baseline.json
# Apply reviewed implementation fixes, stage the exact Task 6 allowlist,
# rerun focused tests, then amend the implementation commit.
git commit --amend --no-edit
# Rerun Task 6 Step 3 and obtain fresh pre-ratchet fingerprints.
# Reapply baseline [] with apply_patch, then repeat every Task 7 staging,
# commit-message, one-file, and final-green assertion.
```

`RATCHET_SHA` is a reflog/safety reference only; do not cherry-pick the stale
ratchet because its fingerprints no longer certify the amended implementation.

- [ ] **Step 5: Publish and close only after CI**

Before pushing, fetch and compare the tested base to `origin/main`:

```bash
git fetch origin
git rev-parse origin/main
```

If main advanced, rebase the four commits onto `origin/main`, set `BASE_SHA` to
the new parent, rerun all Task 8 gates/topology assertions, and re-prove the old
baseline from a temporary worktree at `HEAD^` (the implementation commit). The
temporary worktree must be removed afterward. Regenerate fingerprints if they
changed; amend/recreate only the baseline commit message while keeping its
one-file diff. Do not publish evidence from the pre-rebase tree.

After fetch/rebase and before rerunning gates, enforce the linear base binding:

```bash
export BASE_SHA=$(git rev-parse HEAD~4)
test "$(git rev-parse "$BASE_SHA")" = "$(git rev-parse origin/main)"
git merge-base --is-ancestor origin/main HEAD
```

Push `codex/fix-337-recall-honesty` and open a ready PR whose body contains the
exact closing keyword `Closes #337`. Wait for required CI on the final pushed
head SHA, then merge. Verify through GitHub that the PR is merged, its merge SHA
is reachable from `origin/main`, and issue #337 state is `CLOSED`. If the closing
keyword did not close it, explicitly close #337 with a comment linking the
merged PR. Only then update local main with a non-destructive fast-forward that
preserves its user-owned untracked files and delete the remote feature branch.
Do not touch a live vault or live target during release.

Final report includes:

- spec/plan/implementation/baseline/merge SHAs;
- pre-ratchet counts and report fingerprints;
- post-ratchet default/strict metrics;
- focused/full/CI results;
- adversarial reviewer verdicts;
- residual risks: conservative hard boundaries, synthetic-not-production-p95,
  copied vector payload up to 122,880 bytes on at most one content Lance call,
  and derived-vector-only recall remaining intentionally insufficient.

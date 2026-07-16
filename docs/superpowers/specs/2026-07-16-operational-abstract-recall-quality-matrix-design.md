# Operational and Abstract Recall Quality Matrix Design

**Issue:** #336  
**Parent:** #333  
**Depends on:** #335（已通过 PR #349 合并）  
**Follow-up fix:** #337  
**Status:** Design approved by adversarial review

## 1. Problem first

The current #324 gate proves that nine anonymous smoke cases remain green. It
does not make the recent Hermes failures measurable:

1. current-state questions can drift from the Agent contract into semantic
   recall;
2. abstract/content questions can return an unrelated source with status
   `ok`;
3. route, retrieval, source, and sufficiency failures are not separated;
4. a known current failure cannot make `main` permanently red, but a broad
   waiver would hide later regressions.

#336 creates a deterministic quality oracle and an exact baseline gate. It
does not repair ranking, sufficiency, embeddings, or routing. Those fixes remain
in #337.

## 2. Chosen approach

Keep `bun run gate:recall-quality` as the single entrypoint and upgrade its
report to schema v2. The v2 gate has two suites:

- `legacy_v1`: the exact nine #324 case IDs and lane assertions;
- `issue_336`: fixture-driven operational, content, and abstract cases.

The new suite records independent failure codes, compares the observed failure
set with an exact reviewed baseline, and emits both raw-quality and CI verdicts.

Rejected alternatives:

- adding more hard-coded booleans to the v1 script, because data, oracle, and
  waiver policy would remain mixed;
- validating routing JSON only, because it cannot detect wrong source or
  false-ok retrieval;
- fixing the observed recall failures in the same issue, because that would
  destroy the before-state #337 needs to repair.

## 3. Scope and non-goals

### In scope

- categories `operational_meta`, `content_meta`, `abstract_concept`;
- at least two cases per category;
- positive and negative expectations per category;
- contract-only operational evaluation, with zero semantic calls;
- real `cbrain_recall` execution over an isolated anonymous temporary brain;
- a deterministic in-memory vector stand-in used by the production retrieval
  path;
- route accuracy, Recall@3, wrong-source, irrelevant-but-ok, and insufficient
  false-positive metrics;
- exact known-failure signatures linked to #337;
- privacy-safe JSON output, deterministic fingerprint, and fault tests;
- preservation of all nine #324 cases.

### Explicit non-goals

- no edits to production search, ranking, router, sufficiency, embedding,
  reranker, prompts, schema, or MCP tool behavior;
- no runtime guard inside `cbrain_recall` for misrouted operational questions;
- no real vault, config, user query, identity, path, or external service;
- no auto-update command for fixtures or baseline;
- no online or long-running benchmark.

The implementation diff allowlist is:

- `bin/check-recall-quality-matrix.ts`;
- `bin/lib/recall-quality-matrix.ts`;
- `tests/bin/recall-quality-matrix.test.ts`;
- `tests/fixtures/recall-quality-*.jsonl` and baseline JSON;
- `skills/agent-facing.routing-eval.jsonl` only if the historical operational
  near-miss contract row is absent;
- this spec, its implementation plan, and package/docs references required by
  the gate.

Any change under `src/core/retrieval/`, `src/core/recall/`, `src/embedding/`,
`src/mcp/tools/`, or DB migrations is an automatic scope failure for #336.

## 4. Fixture contracts

### 4.1 Controlled anonymous text

Reportable case IDs use the closed grammar:

```text
^(operational|content|abstract)_(positive|negative)_[0-9]{2}$
```

Corpus source IDs use `^source_[a-z]$`; titles use
`^匿名(记录|主题)[A-Z]$`. All semantic query/body/answer-point strings are
space-separated tokens from a checked-in finite `SAFE_FIXTURE_TOKENS` set plus
an allowlist of punctuation. Validation rejects any token outside that set.

Operational input is not duplicated in the #336 file. Each operational case
references a canonical `skills/agent-facing.routing-eval.jsonl` row by the
SHA-256 of its exact input; the loader resolves it in memory. Canonical rows are
already anonymous product fixtures. Neither the input nor its hash is reported.

Fixture validation also rejects duplicate/unknown fields, control characters,
path traversal, email/phone/credential shapes, absolute paths, malformed JSON,
unknown source references, and duplicate IDs. Sentinels cover `case_id` as well
as every free-text field.

### 4.2 Corpus

`tests/fixtures/recall-quality-corpus.jsonl` contains synthetic sources:

```json
{"source_id":"source_a","title":"匿名记录A","type":"record","body":"系统 恢复 边界 明确 责任","answer_points":[{"point_id":"point_a","text":"恢复 边界"}],"timeline":[{"date":"2025-01-01","text":"恢复 边界 已 记录"}]}
```

Every row has exactly `source_id`, `title`, `type`, `body`, `answer_points`,
and `timeline`. `type` is `record` or `insight`; answer points are non-empty,
use `^point_[a-z]$`, and bind a stable ID to controlled text. Timeline is an
empty or non-empty array of fixed ISO dates plus controlled text. The corpus
contains relevant sources and lexical near-noise sources.

### 4.3 Tagged case union

`tests/fixtures/recall-quality-cases.jsonl` contains two row shapes.

Route-contract case:

```json
{
  "case_id":"operational_positive_01",
  "category":"operational_meta",
  "kind":"route_contract",
  "canonical_input_sha256":"<64 lowercase hex>",
  "expected_tool":"next_actions",
  "expected_args":{"include_raw":false},
  "forbidden_tools":["query","cbrain_recall","deep_recall"]
}
```

Semantic case:

```json
{
  "case_id":"abstract_positive_01",
  "category":"abstract_concept",
  "kind":"semantic_recall",
  "query":"稳定 治理 为什么 需要 恢复 边界",
  "expected_tool":"cbrain_recall",
  "expected_frontdoor_route":"content_recall",
  "oracle":"answerable",
  "expected_sources":["source_a"],
  "allowed_sources":["source_a"],
  "required_answer_points":[{"source_id":"source_a","point_ids":["point_a"],"match":"all"}],
  "must_not_sources":["source_b"],
  "allowed_statuses":["ok"]
}
```

Semantic rules:

- `oracle` is `answerable` or `unanswerable`;
- answerable cases require at least one expected source and a point rule for
  every expected source;
- unanswerable cases require empty expected-source and answer-point arrays;
- `expected_tool` is always `cbrain_recall` and
  `expected_frontdoor_route` is always `content_recall` in #336;
- `allowed_sources` and `must_not_sources` form an exact, disjoint partition of
  every corpus source. For answerable cases `allowed_sources` equals
  `expected_sources`; for unanswerable cases it is empty;
- `must_not_sources` is always non-empty;
- `allowed_statuses` is still explicit per fixture, but validation requires the
  exact normal-state singleton: answerable `['ok']`, unanswerable `['empty']`;
- content and abstract cases use expected Agent arguments
  `detail:"normal"`, `include_raw:true`; the loader cross-checks
  `detail:"normal"` against canonical content-recall rows;
- production CLI reads canonical paths only; it accepts no fixture path flag or
  environment override. Tests may inject parsed rows into pure functions.

The fixtures include:

- current-state operational rows whose canonical contract is `next_actions`,
  including forbidden recall tools;
- an operational historical/content near-miss row such as “此前记录过哪些系统
  体验问题”, whose canonical contract is `content_recall -> cbrain_recall`
  and forbids `next_actions`; if absent, #336 adds this anonymous contract row;
- content answerable and unanswerable/near-noise cases;
- abstract answerable and unanswerable/near-noise cases;
- an abstract answerable case whose query and correct source share no FTS token.
  A controlled test embedding maps their different safe tokens to one concept
  vector. Integration must prove vector-on returns the expected source,
  vector-off/FTS-only does not, and the vector search spy was called. The
  difference must come from retrieval candidates, not observation mutation;
- answerable historical/evidence cases that seed timeline evidence and exercise
  both live `sufficient` and live `partial`/`insufficient` envelope mapping.

## 5. Execution architecture

### 5.1 Pure library

`bin/lib/recall-quality-matrix.ts` owns:

- strict fixture parsing;
- observation-to-failure evaluation;
- metric aggregation;
- exact baseline comparison;
- allowlisted report construction and fingerprinting.

It has no DB, filesystem-path, MCP, network, clock, or environment dependency.

### 5.2 Gate orchestrator

`bin/check-recall-quality-matrix.ts` owns I/O:

1. load and validate canonical fixture text without executing either suite;
2. immediately place the temporary root under an outer `finally` after
   `mkdtemp`;
3. run both suites in a subprocess with an explicit closed environment: only
   required `PATH`/locale plus temporary `HOME`, `XDG_CONFIG_HOME`,
   `XDG_DATA_HOME`; every inherited `CBRAIN_*` variable is absent;
4. create temporary DB/vault/runtime state and seed corpus deterministically;
5. preserve and execute all nine legacy #324 cases inside the same isolation,
   using explicit bare contexts rather than `createServer`/JobQueue;
6. seed an in-memory cosine index, with ties ordered by
   `pageSlug + chunkIndex`;
7. register only `cbrain_recall` on a bare MCP server/context via
   `registerFrontdoorTools`; do not call `createServer` or start JobQueue;
8. evaluate route contracts without constructing or invoking any semantic
   handler;
9. call real `cbrain_recall` for semantic cases with `detail:"normal"`,
   `include_raw:true`, no multi-query/LLM path, and normal production routing;
10. convert top-three synthetic returned sources and source-bound answer points
    to an internal observation;
11. evaluate, aggregate, compare baseline, emit allowlisted JSON;
12. close DB in an inner `try/finally` and remove the root in the outer
    `finally`, so close failure cannot prevent deletion.

Constructor/open/handler/close failure tests must prove cleanup and environment
restoration. The CLI must not expose raw thrown messages or stack traces.

### 5.3 Operational contract boundary

Operational evaluation is explicitly `route_contract`, not a production
runtime classifier claim. Every current-state referenced canonical row
requires:

- `category === "operational"`;
- `expected_tool === "next_actions"`;
- `expected_args.include_raw === false`;
- all three forbidden tools `query`, `cbrain_recall`, `deep_recall`.

The historical near-miss row instead requires canonical
`category:"content_recall"`, `expected_tool:"cbrain_recall"`,
`expected_args.detail:"normal"`, and `forbidden_tools` containing
`next_actions`. This is the operational-family negative: a superficially
similar question about stored history must not be treated as current state.

`actual_tool` in the observation is the independently maintained canonical
Agent-contract value; `expected_tool` comes from the #336 fixture. The metric
name remains `route_accuracy` to satisfy #336. The operational component is
labelled `agent_contract`, never runtime; the aggregate mixed scope is defined
in section 7.

All semantic handler factories are poison spies in the operational executor;
their call count must remain zero. This proves the gate itself never evaluates
operational intent through semantic recall. It does not claim an Agent runtime
cannot ignore the contract; a runtime guard, if needed, belongs to #337.

## 6. Observation and quality oracle

A semantic observation contains internal-only:

```ts
type SemanticObservation = {
  caseId: string;
  actualTool: string;
  actualFrontdoorRoute: string;
  answerStatus: "ok" | "empty" | "degraded";
  degradationKind: "none" | "evidence" | "infrastructure";
  evidenceSufficiency: "sufficient" | "insufficient" | "not_applicable";
  top3: readonly Array<{
    sourceId: string;
    matchedPointIds: readonly string[];
  }>;
};
```

`answerStatus:"degraded"` means the response is degraded for any reason; it
does not itself imply evidence insufficiency. `evidenceSufficiency` is derived
only from `raw.evidence_pack.coverage.coverage_status` when an evidence pack is
present: production `sufficient` stays `sufficient`; both `partial` and
`insufficient` normalize to `insufficient`; absence becomes `not_applicable`.
Infrastructure degraded reasons map to `degradationKind:"infrastructure"` and
never set `evidenceSufficiency`; evidence-only degradation maps to `evidence`;
non-degraded output maps to `none`. Infrastructure takes precedence if both
kinds are present. Answer points are scanned only in top-three snippets and
remain bound to their returned source.

For an answerable case, expected coverage is true only when:

1. every declared expected source is present in top three; **and**
2. for each source, its source-bound point rule is satisfied (`all` means all
   phrases, `any` means at least one).

Answer points never substitute for a missing expected source. An unanswerable
case has expected coverage only when top three is empty.

The evaluator emits a sorted set of independent failure codes, not one
precedence-dependent primary outcome:

- `route_mismatch`: tool/route contract differs;
- `recall_miss`: answerable expected coverage is false;
- `unexpected_recall`: an unanswerable case returns any top-three source;
- `wrong_source`: any top-three source is outside `allowed_sources` (equivalent
  to a `must_not_sources` hit because the partition is exhaustive);
- `irrelevant_but_ok`: status is `ok` while an answerable case lacks expected
  coverage, or for any unanswerable case even when top three is empty;
- `insufficient_false_positive`: answerable expected coverage is true while
  `evidenceSufficiency === "insufficient"`;
- `status_mismatch`: normalized status is outside `allowed_statuses`;
- `degraded_response`: `answerStatus === "degraded"`, independent of evidence
  sufficiency;
- `infrastructure_degraded`: `degradationKind === "infrastructure"`;
- `legacy_regression`, `privacy_failure`, `nondeterministic`, or
  `execution_failure` for non-baselineable gate failures.

Therefore an empty answerable result is always `recall_miss`. A non-empty
unanswerable result is always `unexpected_recall`, independent of status or
source identity; `ok` on any unanswerable result is also
`irrelevant_but_ok`. A false-ok answerable result may intentionally carry both
`recall_miss` and `irrelevant_but_ok`; exact baseline comparison sees both.
`allowed_statuses` is an additional contract only and cannot suppress another
failure code.

Fault tests mutate observations—insert forbidden sources, remove expected
sources, or change status/sufficiency. They never flip a final `passed` boolean.

## 7. Metrics

All metrics use integer numerator/denominator plus a rate rounded to six
decimals:

- `route_accuracy`: all cases whose expected tool/route contract matches divided
  by all cases. Operational observations come from the canonical Agent contract;
  semantic observations come from the executed frontdoor route. The report
  labels this mixed scope `agent_contract_plus_frontdoor` and also reports
  per-category numerators/denominators;
- `recall_at_3`: sum of expected sources found in top three divided by total
  expected sources across answerable semantic cases;
- `wrong_source_rate`: semantic cases with a forbidden top-three source divided
  by semantic cases;
- `irrelevant_but_ok_rate`: semantic cases with that flag divided by semantic
  cases;
- `insufficient_false_positive_rate`: answerable semantic cases with expected
  coverage but insufficient evidence status divided by answerable semantic
  cases where expected coverage is true and
  `evidenceSufficiency !== "not_applicable"`; the eligible denominator is
  always reported. Recall misses never dilute this rate.

Rates are descriptive. Any per-case undeclared failure still fails the gate;
an average can never waive it.

## 8. Exact baseline and verdicts

`tests/fixtures/recall-quality-baseline.json` is a reviewed exact failure set.
Each entry contains:

```json
{
  "case_id":"abstract_positive_02",
  "failure_codes":["irrelevant_but_ok","recall_miss","wrong_source"],
  "answer_status":"ok",
  "degradation_kind":"none",
  "evidence_sufficiency":"not_applicable",
  "top3":[{"source_id":"source_b","matched_point_ids":[]}],
  "follow_up":"#337"
}
```

The ranked `top3` array and sorted per-source matched point IDs are part of the
signature, so loss of additional required evidence or source-order drift cannot
hide inside the same coarse failure codes. Source/point identities are internal
synthetic IDs and never enter the report.
Only semantic retrieval/evidence-status/sufficiency failures may be baselined,
and `degradation_kind` is part of the exact signature. Any `route_mismatch`
(operational or semantic), `infrastructure_degraded`, plus legacy, schema,
execution, privacy, and determinism failures, is non-baselineable. Mapper tests
cover evidence-only, infrastructure-only, and combined degraded envelopes.

Comparison is exact:

- observed signature equals baseline signature: `known_failure`;
- observed new/different signature: `regression`;
- baseline entry now passes: `unexpected_pass`;
- no failure and no baseline: `pass`.

`unexpected_pass` intentionally makes both CI and strict verdicts no-go. A
repair such as #337 must remove the stale baseline entry in the same reviewed
change. This prevents a later return to the old failure from being silently
accepted.

The report contains:

- `strict_verdict`: `go` only when CI integrity is valid (no regression,
  unexpected pass, or non-baselineable failure) **and** raw quality has zero
  failures;
- `ci_verdict`: `go` only when observed failure signatures equal the reviewed
  baseline and there are no unexpected passes/non-baselineable failures;
- `verdict`: equals `ci_verdict` normally and `strict_verdict` under
  `--strict`;
- `quality_status`: `pass`, `known_failure`, or `regression`;
- counts of known failures, regressions, and unexpected passes.

Normal known baseline: `strict_verdict:no-go`, `ci_verdict:go`, `verdict:go`,
exit 0. `--strict` on the same data emits `verdict:no-go`,
`strict_failure:true`, and exits 1. Strict mode does not enter `check:ci`.

Exhaustive exit policy:

- `0`: selected verdict is go;
- `1`: valid report with regression/unexpected pass, or strict known failure;
- `2`: CLI usage, missing/malformed/schema-invalid fixture/baseline, or failure
  before a valid evaluation report exists.

No command writes or updates the baseline.

## 9. Report privacy and determinism

The v2 report is built from a field allowlist. It may contain only:

- fixed gate/schema/mode/verdict/quality enums;
- fixed metric names, integer counts, booleans, and rates;
- controlled case IDs, category, sorted failure codes, and baseline
  disposition;
- legacy case IDs/lane pass-fail;
- `reproducibility_fingerprint` and advisory duration/boundedness scalars.

It never contains input/hash, source IDs, slugs, titles, bodies, snippets,
answer points, scores, vectors, raw routing, free-form error text, filesystem
paths, environment values, credentials, or stack traces.

Three full runs in fresh isolated roots must have identical stable reports and
SHA-256 fingerprint after excluding advisory duration. The fingerprint is
computed from canonical JSON key ordering. Real wall-clock duration is
advisory only and never changes quality/verdict. Boundedness tests use an
injected clock/timeout; the outer job may retain a generous process timeout,
but no 5-second wall-clock threshold participates in gate semantics.

Privacy tests inject unique sentinels into case ID, canonical input, query,
title, body, source ID, answer point, malformed JSON, and thrown errors. Tests
prove those values exist only in the in-memory fixture/observation boundary and
never enter the returned report, stdout, or stderr. The gate never logs or
serializes the raw observation as an output artifact.

## 10. Legacy preservation

The following #324 IDs and assertions remain pinned:

```text
zh_exact
en_exact
mixed_alias
abstract_topic
honest_empty
temporal_evidence
relationship_route
operational_contract
bounded_runtime
```

Their existing retrieval/router/evidence semantics stay unchanged in
`legacy_v1`. The v2 gate fails with non-baselineable `legacy_regression` if any
fails. Tests assert the exact ordered ID list and lane outcomes. #336 may
replace legacy free-form fixture labels with controlled anonymous tokens while
preserving the behavior being tested. `bounded_runtime` preserves its
boundedness intent using an injected-clock/timeout assertion; the v1 five-second
wall-clock comparison does not carry into verdict semantics.

## 11. TDD and verification

Implementation order:

1. fixture/schema/privacy-loader tests fail;
2. failure-set truth-table and metric tests fail;
3. exact baseline, unexpected-pass, strict, and exit tests fail;
4. operational canonical-contract and poison-spy tests fail;
5. real content/abstract/vector integration tests fail;
6. legacy preservation tests fail against v2 aggregation;
7. isolation, cleanup, three-run fingerprint, CLI-boundary, and fault tests
   fail;
8. minimal implementation makes each group pass.

Required commands:

```bash
bun test tests/bin/recall-quality-matrix.test.ts
bun run gate:recall-quality
bun run check:docs
bun run lint
bun run check
git diff --check
```

Additional review gates:

- `git diff --name-only 28a61ca...HEAD` must fit the allowlist in section 3;
- an explicit scan must prove no forbidden production path changed;
- three fresh adversarial reviews cover baseline anti-gaming, oracle/retrieval
  correctness, and privacy/determinism/CI boundaries.

## 12. Acceptance mapping

| #336 acceptance | Mechanism |
|---|---|
| Three anonymous categories with positive/negative | strict tagged fixtures and controlled vocabulary |
| Operational never enters semantic recall | route-contract executor and poison spies; scoped claim |
| Stable irrelevant-but-ok detection | independent exact failure codes and observation mutations |
| Consecutive deterministic results | three isolated runs and stable fingerprint |
| Machine-readable summary/nonzero failure | v2 report and exhaustive exit policy |
| CI not permanently red | exact reviewed baseline; strict/raw quality remains no-go |
| No algorithm change | file allowlist and forbidden production-path review gate |
| Preserve previous protection | pinned legacy nine-case suite |

## 13. Residual risks

1. `route_accuracy` measures canonical Agent-contract conformance, not actual
   host model behavior. A live host canary is separate work.
2. The deterministic vector stand-in is not a production embedding model. It
   proves repeatable pipeline/oracle behavior, not absolute semantic quality.
3. A baseline can still be intentionally changed in review; linking every
   entry to #337 and exact signatures makes that change visible, not impossible.
4. Controlled fixture text is less natural than production language. #337 must
   keep separate adversarial paraphrase coverage when changing algorithms.
5. Private tool registration details remain a test-harness seam; focused tests
   will detect SDK registration changes.

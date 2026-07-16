# Recall Candidate Honesty Design

**Issue:** #337

**Parent:** #333

**Depends on:** #336, merged through PR #350

**Status:** Approved for implementation planning after three adversarial reviews

## 1. Problem and evidence

The #336 matrix has two passing operational contract cases and four semantic
cases. Three semantic cases are exact known failures:

1. the content positive finds the required source at rank 1 but also returns a
   weak FTS-only source;
2. the content negative returns a weak FTS-only source and is marked degraded
   only because a temporal marker triggers evidence completion;
3. the abstract negative returns two weak FTS-only sources and is marked `ok`
   because the content front door treats every non-empty candidate set as
   answerable.

The abstract positive is a required control: it has no lexical overlap with its
expected source and succeeds through vector support alone.

Read-only tracing established the shared root cause:

- long FTS queries use OR-ed trigrams, so partial overlap intentionally enters
  the candidate pool;
- RRF keeps ranks but discards channel-native strength and channel identity;
- `runContentRecall` has no query-relative candidate acceptance step;
- temporal evidence coverage measures whether a page has material, not whether
  that material answers the query;
- the existing fused-score gate cannot distinguish a weak rank-1 FTS result
  from a legitimate rank-1 single-channel result.

The defect is therefore at the boundary between retrieval candidates and the
front door's claim that those candidates are relevant memories.

## 2. Goals

1. Remove the three exact #337 failure signatures without weakening the oracle.
2. Preserve the no-shared-token vector positive, exact lookup, and strong
   FTS-only fallback.
3. Derive `ok` or `empty` from accepted candidates rather than raw candidate
   count.
4. Add no search, database, network, fallback, or LLM call.
5. Preserve search ranking and all non-content front-door routes.
6. Keep channel support internal, deeply immutable, and absent from every
   serialized or reflected result.

## 3. Non-goals

- Do not change the Agent-facing operational contract or duplicate
  `next_actions` inside `cbrain_recall`; the operational matrix already passes.
- Do not change FTS trigram OR semantics, RRF ordering, activity/hotness weights,
  embedding providers, reranking, or router classification.
- Do not add a default LLM sufficiency check or a second retrieval pass.
- Do not change `multiStep`/`ResearchManager`; `content_recall` does not enable
  that advanced path, and its result-rewriting contract is outside this defect.
- Do not change MCP tool count, schemas, storage, migrations, ontology, or
  fallback limits.
- Do not make every abstract query empty or degraded.
- Do not tune against a real vault or include real identities in fixtures.

## 4. Considered approaches

### A. Preserve internal channel support and gate before enrichment — chosen

`mergeRankedResults` already sees each raw channel result before RRF erases its
identity. Preserve a bounded support summary on the fused candidate, then run a
pure content-candidate gate in `runContentRecall` before page hydration and
evidence completion.

Advantages: zero extra calls, retains exact/vector/FTS distinctions, leaves rank
calculation unchanged, and permits deterministic unit tests. The opted-in
vector channel has the explicit bounded same-query payload cost in section 6.1.

### B. Re-probe FTS and vector after fusion — rejected

This can reconstruct support but repeats database and vector work. It breaks the
single-probe pattern, increases latency, and creates new timeout/fallback paths.

### C. Raise the global RRF threshold or tighten FTS — rejected

A single-channel rank-1 weak FTS hit and a valid vector-only or FTS-only hit have
nearly identical fused scores. A global threshold would delete protected
fallbacks. Changing FTS OR semantics would alter all search/query consumers,
far beyond the proven front-door defect.

## 5. Internal support contract

### 5.1 Shape

Create `src/core/retrieval/retrieval-support.ts`. Metadata lives in a
module-private `WeakMap<object, RetrievalSupport>` rather than on the result
object:

```ts
export type RetrievalSupportChannel =
  | "exact"
  | "vector"
  | "fts"
  | "graph"
  | "temporal";

export type RetrievalQueryOrigin = "original" | "derived";

export interface RetrievalChannelEvidence {
  readonly rankScore: number;
  readonly vectorCosineSimilarity?: number;
  readonly rootLexicalCoverage?: number;
}

export interface RetrievalChannelSupport {
  readonly original?: RetrievalChannelEvidence;
  readonly derived?: RetrievalChannelEvidence;
}

export type RetrievalSupport = Readonly<Partial<
  Record<RetrievalSupportChannel, RetrievalChannelSupport>
>>;

export function attachRetrievalSupport(
  result: SearchResult,
  support: RetrievalSupport,
): SearchResult;
export function getRetrievalSupport(result: SearchResult): RetrievalSupport;
```

Attachment copies only the declared finite scalar fields into a fresh,
null-prototype tree; every copied evidence leaf, channel object, and outer
summary is then frozen before storage. It never freezes the `SearchResult` or a
caller-owned input object. Attachment returns the same result object after
associating it in the WeakMap; the getter returns either that deeply frozen
value or one shared frozen empty summary. No symbol, descriptor, or string key
is added to `SearchResult`, so reflection, spread, and serialization cannot
discover the metadata.

`SearchOptions` gains four `@internal` propagation fields:

```ts
_captureSupport?: boolean;
_supportRootQuery?: string;
_supportOrigin?: RetrievalQueryOrigin;
_supportVectorOverride?: {
  readonly query: string;
  readonly origin: RetrievalQueryOrigin;
  claimed: boolean;
};
```

Support capture is opt-in. Only `content_recall` sets `_captureSupport:true`;
without it, direct channels skip lexical/support construction and fusion finds
no metadata to attach. This keeps non-content search CPU and allocation behavior
unchanged apart from a constant boolean branch.

For the `multiStep:false` standard path used by content recall, the first
opted-in outer `search(query)` establishes `rootQuery=query` and
`origin="original"`. Provenance is then propagated at both recursive call sites
rather than assumed to pass through one common entry point:

- every decomposition child calls `search(subQuery, ...)` with the outer root
  query and `origin="derived"`; no child is removed or replaced. In capture
  mode, all children share a one-shot override that can be claimed only when a
  child reaches its already-existing vector call. The first non-exact child to
  claim it uses the outer query with `origin="original"`; exact children retain
  the legacy zero-vector fast path. If all children are exact, no root-vector
  call is created and the gate fails closed on derived evidence. This preserves
  every child and adds zero embedding, Lance, database, or retrieval calls;
- `searchWithExpansion` passes the current root query and origin into every
  direct `searchSingleQuery` call. Its first/original query keeps the caller's
  origin; generated variants are always `derived`. A nested derived call can
  never promote its first variant back to `original`.

The exact fast path, hoisted FTS probe, vector/FTS/graph/temporal channel calls,
and both fusion sites receive that explicit context. Tests poison each branch
independently so missing propagation cannot be hidden by another channel.

### 5.2 Fusion behavior

For every slug, `mergeRankedResults`:

1. preserves existing ranks, best snippet, RRF score, activity bonus, hotness
   bonus, ordering, and limit behavior byte-for-byte;
2. collects the strongest bounded evidence separately for original and derived
   queries in each contributing channel;
3. flattens support already attached to nested fused results, so multi-query or
   decomposition fusion does not turn the support into an opaque `hybrid`
   channel;
4. attaches a frozen support summary to the returned result.

"Strongest" is channel-specific and deterministic: maximum valid cosine
similarity for vector, maximum lexical coverage for FTS/temporal/exact, then
maximum finite native rank score as a stable tie-breaker. Graph uses maximum
finite rank score only. Invalid scalar values are omitted rather than compared.
Specifically, a non-finite required `rankScore` drops the entire evidence leaf;
an invalid optional cosine/coverage drops only that optional field. Cosine must
also be within `[-1,1]` and coverage within `[0,1]`.

Direct results are explicitly attached at their production point. No support is
reconstructed from a public `SearchResult`. An opaque `source:"hybrid"`
without WeakMap metadata has no trusted support and fails closed.

### 5.3 Privacy and compatibility

The WeakMap support must not appear in:

- `Reflect.ownKeys`, property descriptors, `Object.keys`, object spread, or
  `JSON.stringify`;
- legacy or structured MCP content;
- query/debug raw output;
- recall compact or audit output;
- logs, traces, fingerprints, or error messages.

The public `SearchResult` string-key shape remains unchanged.
Support is a transient retrieval-internal contract, not a promise to arbitrary
post-processing copies of a result. Its only new consumer requests
`_skipDetailEnrich:true` and evaluates the original fused objects before any
sealed-detail spread can replace them.

## 6. Channel-native evidence capture

### 6.1 Vector metric contract

The current Lance query keeps its default L2 metric and therefore keeps its
existing ranking byte-for-byte. Absolute L2 is not an honesty boundary because
`EmbeddingProvider` does not guarantee unit-normalized vectors. For the
original query of an opted-in content search only, the same Lance query
additionally selects the stored candidate vector. `HybridSearch.vectorSearch`
computes cosine from the already available query vector and returned candidate
vector, stores only the scalar, then discards the candidate vector before
constructing public `SearchResult`. Derived expansion/decomposition vector
queries omit `includeVector`; their vector support is rank-only because derived
cosine cannot accept a candidate. The sole decomposition exception is one
existing vector call claimed through a shared one-shot override: it executes
the original outer query, requests the stored vector, and records original
provenance. Exact children never claim the override and keep their zero-vector
fast path. All child-query evidence stays derived; if every child is exact, no
root-vector evidence is fabricated.

`LanceDBManager.search` gains an optional `{ includeVector: true }`; false or
omitted preserves its existing selected columns and result shape. When true,
the storage result carries a normalized `Float32Array` representation of the
stored Arrow vector. This adds no query and changes no ranking, but its bounded
payload/CPU cost applies to at most one original-query Lance call per content
recall. With front-door limit at most 5 and the existing `limit * 3` Lance
fanout, at most 15 candidate vectors are selected (122,880 Float32 payload bytes
at 2,048 dimensions, before Arrow overhead) and locally compared per call.

The fixed acceptance boundary and Float32 comparison tolerance are:

```ts
export const CONTENT_VECTOR_MIN_COSINE = 0.8;
export const CONTENT_VECTOR_EPSILON = 1e-6;
```

A finite cosine in `[-1,1]` passes when
`cosine + CONTENT_VECTOR_EPSILON >= CONTENT_VECTOR_MIN_COSINE`. Zero-norm,
missing, malformed, NaN, or infinite vectors fail closed. Scale-equivalent
non-unit vectors must yield the same decision.

The #336 vector stand-in must compute squared L2 solely for production-shaped
ordering, return top-N without a semantic quality pre-filter, and include the
stored vector only when requested. A real temporary `LanceDBManager` contract
test verifies squared-L2 order, optional vector selection, Float32 normalization,
and local cosine for unit and scaled non-unit vectors. A negative fixture vector
must enter the top-N candidate pool and be rejected by the content gate rather
than disappearing inside the stand-in.

Only vector evidence computed for the original query can independently accept a
candidate. Derived-query vector evidence retains rank support for fusion but no
cosine and cannot prove root-query relevance. Tests assert every derived Lance
call omits `includeVector` and that includeVector on/off returns identical
`(pageSlug, chunkIndex, _distance)` order.

### 6.2 Full-hit lexical evidence

FTS support is calculated inside `HybridSearch.ftsSearch(query, ...)` while the
full matched chunk content is still available, before `slice(0, 200)` creates
the public snippet. The support stores only `rootLexicalCoverage`, never the
content, units, query, or matched text.

Temporal candidates calculate the same scalar against their bounded
summary/title. Graph support remains rank-only and cannot independently accept
a content candidate. Derived-query candidates always calculate coverage against
`_supportRootQuery`, not the generated query. Exact support records the same
root-query lexical scalar for its title/snippet so a derived exact result cannot
bypass the root query.

This is pure computation on data already returned by the existing search. It
adds no DB/vector/search call and preserves late FTS hits beyond character 200.

## 7. Deterministic lexical support

Create a pure helper in `retrieval-support.ts`:

```ts
export const CONTENT_LEXICAL_MIN_COVERAGE = 0.6;
export const CONTENT_LEXICAL_WINDOW_UNITS = 5;
export const CONTENT_LEXICAL_MAX_WINDOW_SPAN = 160;

export function computeRootLexicalCoverage(
  rootQuery: string,
  evidenceText: string,
): number;
```

### 7.1 Units

1. normalize both strings with Unicode NFKC and lowercase, then iterate with
   `Array.from` or an equivalent Unicode code-point iterator. Han lengths and
   n-gram slices are code-point based, never UTF-16 `string.length`/`slice`;
2. query tokenization emits only lexical units; evidence tokenization emits
   ordered segments of positioned slots, where a slot is either a lexical unit
   or a non-matching gap;
3. line/paragraph breaks and sentence-strength punctuation (`. ! ? ; 。！？；`
   and Unicode equivalents) close the current evidence segment. No window may
   cross that boundary;
4. discarded one-code-point lexical tokens and other non-whitespace weak
   separators emit an evidence gap slot rather than disappearing. Horizontal
   whitespace alone is not a gap, preserving spaced/unspaced forms;
5. inside each maximal Han-and-horizontal-whitespace region, remove horizontal
   whitespace to form a compact Han sequence. Length 2 is one unit, length 3-4
   uses overlapping bigrams, and length at least 5 uses overlapping trigrams;
6. a Latin/digit run containing both letters and digits is one canonical ID
   unit; an alphabetic run followed by a numeric run separated only by
   whitespace, hyphen, underscore, or slash is replaced by their compacted ID
   unit, with the components not also emitted. Thus `RFC 7231`, `RFC-7231`, and
   `RFC7231` each emit the same single `rfc7231` unit;
7. other Latin/digit runs of length at least 2 are units; their starting and
   ending code-point offsets are retained in evidence slots.

Use Unicode property escapes (`\p{Script=Han}`, `\p{L}`, `\p{N}`) rather than a
BMP-only range.

### 7.2 Query-denominated local coverage

Let `requiredUnits = min(5, uniqueQueryUnitCount)`. Within each evidence segment,
evaluate every consecutive window of one through five slots whose first-to-last
raw span is at most 160 normalized Unicode code points. Count the distinct query
units in the window, divide by `requiredUnits`, take the maximum, and clamp it to
`[0,1]`. Gap slots consume one of the five positions but never enter the
numerator.

The denominator never shrinks merely because evidence is short. A long query
plus a one-unit evidence fragment therefore scores at most `1/5 = 0.2`, not
`1/1`. Repeating one evidence unit cannot inflate the distinct-match numerator.
There is no document-wide "present anywhere" view: three query words scattered
across distant paragraphs, strong punctuation boundaries, or more than 160 code
points cannot bypass local coherence.

Empty query/evidence units return zero. After computing the raw maximum, queries
with one to three unique units return zero unless the raw value is exactly 1;
longer queries return the raw value and pass at `>= 0.6`. Thus a two-unit query
with one generic match is rejected, while a complete two-unit phrase passes.

The fixed local window prevents a long document from diluting a strong late
match while rejecting isolated generic units. A long natural question can still
pass on three locally coherent topic units in a five-unit window. The 160
code-point span is a public deterministic locality bound (below the existing
200-character public snippet boundary), locked by synthetic boundary tests and
not tuned on a private vault.

### 7.3 Bounded compact-phrase rule

Generic fuzzy edits are not semantically safe for Chinese: deleting or inserting
one Han character cannot distinguish a structural particle from `不`、`未`、`仅`,
a subject marker, or a quarter/version digit. The honesty gate therefore adds no
edit-distance positive. It uses one vocabulary-free exact compact rule instead.

Normalize as above and retain normalized code-point offsets while removing
horizontal whitespace. For a 4-64-code-point CJK-bearing query, a compact exact
occurrence in one evidence segment contributes coverage `1` only when its
first-to-last raw span is at most 160 code points. Weak punctuation/separators
participate in that exact comparison; a multi-hard-boundary query cannot obtain
one occurrence and therefore fails closed if its ordinary score looks strong.
Matching uses a linear-time KMP scan. Alphanumeric runs remain exact naturally.

For every CJK-bearing query with more than three lexical units, regardless of
horizontal whitespace, an ordinary unit/window score at or above `0.6` is
accepted only when that bounded exact compact occurrence exists. One narrow
exception is centralized in `recall-intent.ts` as an anchored, closed
`isStandaloneTemporalFramingToken` grammar: if the first whitespace-delimited
token is entirely one approved deictic framing token, it may be omitted, but the
entire remaining compact phrase must occur exactly. Substring matches such as an
ID, entity, quarter, or negation concatenated with a temporal word are rejected.
The canonical `上次 系统 恢复 边界` case therefore retains its ordinary `0.8`
scalar only because `上次` is standalone and `系统恢复边界` is exact evidence.

This fail-closed rule prevents spaces or shared suffixes from hiding a deleted,
inserted, substituted, or relocated subject, negation, status, quarter,
responsibility, version, or identifier; punctuation cannot disable the rule. It
deliberately does not treat non-exact CJK FTS overlap as "strong" during vector
failure; normal semantic vector evidence can still accept a natural paraphrase.
That recall-vs-honesty tradeoff is local to opted-in content recall and is the
point of #337, not an edit-distance language model disguised as deterministic
support.

The 64-code-point limit bounds exact-positive KMP queries; it is not a safety
escape. Longer CJK-bearing queries still enter the guard, cannot obtain this
bounded exact positive, and therefore fail closed on lexical support. The
front-door query cap and tokenizer's 100,000-code-point cap remain outer bounds.

Lexical tokenization stops fail-closed above 100,000 normalized Unicode code
points and appends Han slots iteratively rather than spreading an unbounded
array. KMP is linear and its positive query length is capped at 64, so a single
oversized paragraph cannot create superlinear alignment work or overflow the stack. The
anonymous legacy front-door evidence fixture uses a true bounded exact phrase;
it no longer treats a relocated particle as proof of relevance.

Required public synthetic controls include:

- spaced and unspaced Han forms of the same topic;
- only a first standalone temporal framing token may be omitted, and the
  remainder must be an exact bounded compact phrase;
- a bounded exact compact phrase and controls proving `目的`/`打的` are not
  stripped, repeated particles do not bridge, and hard or over-160 boundaries
  (including horizontal whitespace) reject;
- wrong subject, quarter, version, and canonical-ID substitutions reject;
- long shared suffixes, deleted constraints, inserted negation, and relocated
  state characters reject;
- an exact window wins when the evidence also contains a conflicting comparison,
  and a 100,000+-code-point single paragraph fails closed without throwing;
- a long natural question whose topic phrase is locally coherent;
- the same three-of-five query units scattered outside every five-unit window;
- three matching units separated by discarded one-character tokens, strong
  punctuation, paragraph breaks, and a raw span over 160 code points;
- a long query against one matching evidence unit (exact score `0.2`);
- a two-unit partial-noise negative;
- a complete short two-unit positive;
- a long FTS chunk whose only strong hit begins after character 200;
- English question framing around a three-token topic;
- the three ID separator forms above;
- repeated units, punctuation, full-width forms, and extended Han.
  The extended-Han control locks the exact units and score for a mixed BMP and
  supplementary-plane sequence.

## 8. Deterministic candidate credibility

Create `src/core/retrieval/content-relevance.ts` with a pure decision function:

```ts
export interface ContentCandidateDecision {
  readonly accepted: boolean;
  readonly reason:
    | "exact"
    | "strong_vector"
    | "strong_lexical"
    | "insufficient_support";
}

export function assessContentCandidate(
  query: string,
  result: SearchResult,
): ContentCandidateDecision;

export function filterContentCandidates(
  query: string,
  results: readonly SearchResult[],
): SearchResult[];
```

### 8.1 Acceptance truth table

Evaluate alternatives in order:

| Evidence | Accepted | Reason |
|---|---:|---|
| original-query exact support | yes | `exact` |
| original-query vector cosine `+ 1e-6 >= 0.8` | yes | `strong_vector` |
| any FTS or temporal root-query lexical coverage `>= 0.6` | yes | `strong_lexical` |
| derived exact with root-query lexical coverage `>= 0.6` | yes | `strong_lexical` |
| graph-only support | no | `insufficient_support` |
| support missing, weak vector, or weak lexical overlap | no | `insufficient_support` |

Multiple weak channels and derived vector hits do not become strong merely by
being numerous. The gate
does not change scores or order; it only removes candidates. A strong candidate
at rank 2 or 3 remains in its original relative order.

The constants are fixed by expanded public synthetic contracts, the local cosine
contract, and the unchanged Lance ranking metric, not real data. Boundary tests
lock equality and just-outside cases.

## 9. Front-door integration

Only the `content_recall` branch changes:

```text
one existing search with `_captureSupport:true, _skipDetailEnrich:true`
  -> pure candidate filter
  -> accepted slugs/entities
  -> optional temporal evidence completion
  -> existing formatter
```

Requirements:

1. call
   `ctx.search.search(query, { limit, _captureSupport: true, _skipDetailEnrich: true })`
   exactly once; the content route never consumes `result.detail`, so this
   removes no user-visible behavior;
2. filter before `pages.getBySlug`, evidence completion, or formatting;
3. if zero candidates remain, pass an empty entity list to the existing
   formatter, producing existing `status:"empty"` and user-facing wording;
4. if candidates remain, assemble evidence only for accepted slugs;
5. retain current evidence-based degraded behavior for accepted temporal
   candidates whose coverage is incomplete;
6. do not emit support, thresholds, scores, query terms, or rejection reasons;
7. assert that rejected slugs never reach sealed-detail reads, page hydration,
   or evidence completion;
8. do not add learning, logging, proactive hints, fallback, or LLM work.

All other front-door routes and `deep_recall` behavior remain unchanged.

## 10. Baseline ratchet

The ratchet is deliberately two-commit and history-auditable:

1. the implementation commit leaves the current three baseline signatures
   byte-identical;
2. run default and strict gates with JSON output; both must exit 1 with exactly
   three `unexpected_passes`, zero known failures, and zero regressions;
3. save both raw controlled outputs outside the repository, compute SHA-256
   fingerprints, and record the counts/fingerprints in the next commit message;
4. a baseline-only commit replaces the file with `[]`. That commit may change
   only `tests/fixtures/recall-quality-baseline.json`; cases, corpus, evaluator,
   oracle, and implementation must have zero diff;
5. rerun default and strict gates; both must exit 0 with no failures or
   unexpected passes.

The second commit is a data ratchet, not a second implementation commit. This
preserves the issue's single implementation-commit boundary while making it
impossible for the final green tree to hide whether the old oracle first
observed the expected improvements.

After ratcheting:

- known failures: 0;
- regressions: 0;
- unexpected passes: 0;
- default gate: exit 0;
- strict gate: exit 0;
- route accuracy: 6/6;
- relevant Recall@3: 2/2;
- wrong-source, irrelevant-but-ok, and insufficient-false-positive rates: 0.

No baseline updater, selector, wildcard, or auto-write path is allowed.

## 11. TDD and validation matrix

### 11.1 Support preservation

- pre-enrichment/`_skipDetailEnrich` exact/vector/FTS support is readable
  internally and deeply frozen;
- the default non-opted-in search path returns the shared empty support and
  performs no lexical support computation;
- multi-channel fusion stores each channel's bounded native scalar evidence;
- nested fusion preserves underlying channels;
- support does not affect RRF order or score;
- original/derived evidence remains separate through nested fusion;
- WeakMap metadata is absent from reflection, descriptors, spread, JSON, and
  public envelopes;
- a caller cannot mutate any channel leaf or outer support object.

### 11.2 Candidate decision

- exact accepted regardless of score;
- cosine at `0.8 - 1e-6` accepted; outside tolerance rejected;
- scaled non-unit vectors produce the same cosine decision;
- zero-norm and malformed vectors are rejected;
- no-token-overlap strong vector accepted;
- derived-query vector alone rejected;
- derived exact requires root-query lexical support;
- strong FTS-only rich record/page accepted;
- strong FTS-only late hit after character 200 accepted;
- weak generic/partial FTS rejected;
- a locally coherent temporal-only positive passes; a weak temporal candidate
  fails the same lexical threshold; graph-only is insufficient;
- multiple weak channels rejected;
- opaque hybrid rejected;
- strong rank-2/rank-3 candidates retained;
- CJK spaced/unspaced, English, mixed case, punctuation, repeated units, short
  queries, and empty query units are deterministic.

### 11.3 Production front door

- #336 semantic cases become 4/4 pass without changing fixtures or oracle;
- content positive contains only its allowed source;
- both negative cases are `empty` with no candidate;
- abstract positive remains `ok` and Recall@3 remains 1;
- exact and strong FTS-only front-door cases remain successful;
- embedding unavailable still preserves strong FTS-only content;
- the #336 hermetic lane pins absolute counters: four handler invocations, five
  `HybridSearch.search` calls including its explicit FTS control, four embedding
  calls, five FTS probes, five Lance calls including its explicit tie-order
  probe, zero LLM, zero network, zero job-start, zero advanced-fallback calls,
  and zero DB calls attributable only to support/filtering;
- an LLM-provider-enabled, FTS-sufficient focused content lane pins absolute
  counters for one handler call: front-door search 1, embedding 1, Lance 1,
  FTS 1, LLM 0, network 0, advanced fallback 0, and support-only DB probes 0;
- the front door still calls `ctx.search.search` once and adds no DB/vector
  probe;
- content recall never enables `multiStep`/`ResearchManager`;
- rejected candidates are never detail-hydrated, page-hydrated, or sent to
  evidence completion;
- `retrieval-support.ts` and `content-relevance.ts` import no DB/storage manager,
  expose synchronous pure decisions, and pass with DB/page/evidence methods
  poisoned. Existing `resolveSlugs`, `getPageByTitle`, FTS, timeline, page, and
  evidence counters may decrease after rejection but may not increase over the
  frozen base-path count;
- legacy v1 nine-case lane remains unchanged.

### 11.4 Adversarial close-out

Three independent reviewers attack:

1. oracle/baseline gaming and all-insufficient false greens;
2. channel-support integrity, nested fusion, thresholds, and retrieval
   regressions;
3. metadata privacy, call/latency budgets, cleanup, and public API drift.

Privacy tests use synthetic sentinel scalar values and cover legacy/structured
output, `include_raw` true/false, query/debug raw, compact/audit output, logs,
trace, and error text. They assert that support field names, decision reasons,
candidate vectors, and sentinel values never appear. A non-opted-in
`deep_recall` sealed-detail case and one non-content front-door route must retain
their pre-change output and absolute call counts.

Run focused tests, existing latency/escalation-budget gates, default/strict
quality gates, docs, lint, CI, full check, changed-path allowlist, diff check,
and privacy scan before publication. The acceptance claim is structural and
synthetic; no test in this issue may be described as real production p95.

## 12. Allowed files

Expected implementation paths:

- `src/core/retrieval/search.ts`
- `src/core/retrieval/retrieval-support.ts`
- `src/core/retrieval/content-relevance.ts`
- `src/storage/lancedb.ts` for optional same-query vector selection only
- `src/mcp/tools/frontdoor.ts`
- `bin/check-recall-quality-matrix.ts` for the production-shaped vector
  stand-in and fixed counters only
- focused tests under `tests/core/`, `tests/mcp/`, and
  `tests/bin/recall-quality-matrix.test.ts`
- `tests/fixtures/recall-quality-baseline.json`
- this spec and its implementation plan

No package, lockfile, migration, ontology, tool-profile, production fixture,
router, embedding-provider, or storage-schema change is allowed.

## 13. Residual boundaries

- The operational result validates the Agent contract, not a live host model's
  compliance.
- Fixed lexical/vector thresholds are deterministic safety gates, not a general
  semantic-quality score.
- Derived-query vector-only candidates are conservatively rejected because
  their cosine is not relative to the root query. This prevents a generated
  subquery from manufacturing relevance; future work may define a separately
  audited derived-query semantic contract.
- A candidate can still be topically relevant yet insufficient to answer a
  nuanced question; #337 prevents the proven false-success modes without adding
  an LLM judge.
- The matrix remains synthetic and must not be described as production p95 or
  real-vault quality.

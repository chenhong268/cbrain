# Existing-Capability Experience Optimization Design

**Status:** Approved after three adversarial review rounds
**Date:** 2026-07-20
**Scope:** Existing CBrain capabilities only

## 1. Decision

CBrain enters an existing-capability optimization period. The primary objective is
not to add another product stage, but to make the capabilities that already exist
faster, clearer, more relevant, more predictable, and easier to use.

Privacy, factual honesty, data integrity, state consistency, runtime reliability,
and reversible deployment are non-tradeable guardrails. A proposal that regresses
any guardrail is rejected rather than balanced against speed or convenience.

Within those guardrails, the permanent priority order is:

1. human task-completion experience;
2. relevance, honesty, and comprehensibility;
3. Hermes routing and tool-use correctness;
4. end-to-end latency;
5. code performance and maintenance cost.

All lower priorities serve the human experience. A technically faster or cleaner
implementation is not an improvement if it makes the answer less useful, less
honest, or harder to understand.

## 2. Problem

CBrain has accumulated broad capability and strong automated coverage, but the
remaining friction is concentrated in real use rather than missing primitives:

- abstract questions can still return empty or low-relevance results;
- an advanced fallback can label low-quality unrelated candidates as successful;
- operational suggestions can be safe but too generic to act on;
- successful ordinary searches are usually fast, while a small slow/degraded tail
  can take many seconds;
- Hermes may obey the tool contract yet still produce an answer that feels vague,
  verbose, or difficult to trust;
- several implementation files are large, but their size alone does not prove a
  user-facing problem or justify a rewrite.

Recent private aggregate diagnostics establish problem signals without exporting
query text or private entities into this repository:

- 54 recent search sessions were observed;
- successful-session p95 was approximately 671 ms;
- among five slow or latency-warning sessions, the nearest-rank p95 and maximum
  were approximately 21.5 s;
- research was the dominant slow-step category, followed by decomposition and
  expansion;
- a private abstract-query replay produced low-quality unrelated candidates after
  the ordinary front door returned empty.

The original snapshot did not retain enough privacy-safe execution metadata to be
reproduced as a release baseline. Its numbers are diagnostic evidence, not service
objectives. Every future measured comparison records a UTC observation window,
code/runtime and skill-pack version, tool profile, output mode, privacy-safe config
digest, selection predicate, sample count, timing boundary, percentile method, and
aggregation digest without retaining private content. A journey receives a latency
budget only when it enters an approved issue.

## 3. Product Outcome

A user should not need to understand CBrain's tool names, routing layers, storage
model, scores, slugs, debug fields, or maintenance architecture to complete an
existing task.

The target experience is:

- the right existing capability is selected without the user changing wording;
- the answer leads with the useful conclusion;
- unsupported or low-relevance results are labelled honestly;
- a suggestion is actionable, or it remains silent;
- common journeys complete in one interaction where the evidence is sufficient;
- advanced journeys remain bounded and explain failure without leaking internals;
- performance work reduces waiting without reducing answer quality.

## 4. Scope

This optimization period covers:

- capture and update feedback;
- concrete, abstract, grounded, episodic, relationship, and provenance recall;
- Profile-backed preferences;
- operational status and next actions;
- discovery summaries;
- correction behavior;
- graph and timeline answers;
- Hermes routing and response composition;
- measured latency of existing execution paths;
- targeted maintainability improvements inside code touched by an approved user
  journey.

## 5. Non-goals

The optimization period does not authorize:

- a new knowledge kernel or product roadmap phase;
- a new MCP tool;
- a new database table or migration;
- a new daemon, queue, framework, or external dependency;
- an unbounded LLM planner or additional autonomous write permission;
- a broad rewrite justified only by file size;
- a generic test framework built for a single regression;
- automatic repair, merge, deletion, or lifecycle decisions that currently require
  user confirmation;
- changing timeout thresholds merely to hide slow execution;
- adding more LLM calls to disguise weak retrieval, routing, or wording.

Crossing one of these boundaries requires a separate user decision explaining the
human benefit and why a simpler adjustment to an existing path is insufficient.

## 6. Core User Journeys

The optimization baseline contains twelve existing-capability journeys.

| ID | Journey | Expected human outcome |
|---|---|---|
| J1 | Save ordinary information | The user understands what was saved without seeing internals. |
| J2 | Add information to an existing entity or relationship | The update target and effect are clear; unrelated content is not created. |
| J3 | Recall a concrete fact | The relevant fact is returned directly with bounded context. |
| J4 | Recall an abstract decision and its rationale | Conceptual wording reaches relevant evidence without unrelated filler. |
| J5 | Verify whether something was discussed before | The answer distinguishes found, not found, and insufficient evidence. |
| J6 | Explain a relationship | The answer states the relationship and useful path without exposing graph internals. |
| J7 | Recover a person or event from context | The system uses contextual clues and represents uncertainty honestly. |
| J8 | Read or update a stable preference | Profile behavior reduces repeated explanation and stays explicitly governed. |
| J9 | Ask whether CBrain is currently healthy | Runtime availability and knowledge freshness are distinguished. |
| J10 | Ask what should be handled next | Suggestions are specific enough to act on, or no suggestion is shown. |
| J11 | Read existing discoveries | The digest is concise, low-noise, and does not claim a new detection run. |
| J12 | Correct wrong information | The user understands what changed and the old statement no longer appears current. |

Three failure journeys are mandatory:

| ID | Failure journey | Required behavior |
|---|---|---|
| F1 | No relevant memory exists | Return an honest empty/insufficient result without filler. |
| F2 | Only low-relevance candidates exist | Do not present the result as successful or as an answer. |
| F3 | Runtime, freshness, or output-boundary evidence is incomplete | Report that the state is unverified and give a bounded next action. |

## 7. Experience Matrix

Each journey records five dimensions only:

1. **Task completion:** complete / partial / failed.
2. **Relevance and honesty:** whether the response answers the task and avoids
   unsupported claims.
3. **Comprehensibility:** whether the response is concise, natural, and free of
   unnecessary internal terminology.
4. **User effort:** whether the user must rephrase, repeat context, or perform manual
   recovery.
5. **Wait time:** measured against a journey-specific budget.

The catalogue is not automatically a twelve-journey release suite. When a journey
enters an issue, the issue adds one lightweight journey card containing:

- an anonymous case ID, exact anonymous request, and corpus/fixture digest;
- preconditions and the allowed route/call count;
- expected public status plus required and forbidden answer properties;
- tool-envelope checks and, where Hermes composes the answer, final-answer checks;
- timing start/end, warm/cold condition, repetitions, percentile method, and the
  journey-specific advisory or blocking budget;
- the evaluator and any required human qualitative confirmation;
- deterministic reason codes for any red or yellow result.

The card lives in the issue or PR evidence. This design does not authorize a new
generic journey schema, runner, database, or reporting framework. Existing gates
are extended only when they already execute the affected production boundary.
Deterministic release assertions cover the tool envelope and skill contract. A
model-dependent Hermes answer is recorded as named qualitative confirmation and
cannot override a failing deterministic assertion or protected control.
Before/after comparisons pair the same public case ID, exact fixture digest, and
configuration digest. Private aggregate trends never substitute for this pairing.

Cards use red, yellow, and green rather than a weighted total score:

- **Red:** task failure, misleading answer, unsafe behavior, or a required next
  action with no actionable path.
- **Yellow:** task completes but is slow, vague, verbose, or requires avoidable
  follow-up.
- **Green:** every blocking repetition declared in advance by the journey card
  passes, the answer is clear and honest, and the run stays within budget. Any
  misleading claim or privacy leak is red; intermittent avoidable vagueness or
  verbosity is yellow. For F1/F2, an honest empty/insufficient answer is successful
  abstention and therefore can be green.

A total score is forbidden because it can hide a severe red journey behind many
easy green cases.

## 8. Evidence Layers and Privacy

Validation has two layers.

### 8.1 Public deterministic layer

- Anonymous fixtures use placeholders such as Entity A, Topic B, and Event C.
- Existing test infrastructure is extended only where it can reproduce an approved
  journey regression.
- Public fixtures, issue descriptions, logs, reports, and docs contain no private
  entity, organization, product, location, query text, vault content, or local path.

### 8.2 Private real-use layer

- Tool calls that appear read-only can still write search traces, query logs, and
  activity metadata. Deliberate replay therefore runs only in a disposable
  environment using an anonymous fixture and scratch database. This optimization
  period does not perform deliberate private replay or build a private snapshot
  system. The disposable environment writes only beneath its temporary root and
  performs no writes to the live vault, database, Lance index, profile, or runtime.
- The live environment is used only to observe calls arising from the user's normal
  activity. It is not an active replay target.
- Committed evidence contains only anonymous case IDs, aggregate latency,
  red/yellow/green outcomes, and controlled reason codes.
- Real queries, result text, identifiers, paths, credentials, and vault excerpts are
  never committed or pasted into public issues.
- Write journeys use isolated anonymous fixtures for automated testing. Normal
  private usage can provide qualitative confirmation, but the optimization process
  does not generate synthetic writes in the live vault.

The disposable protocol fails closed before startup. Its configuration file and
the resolved `vaultPath`, `dbPath` (including WAL/SHM), `lancePath`, `runtimePath`,
profile directory, outputs, and logs must all remain beneath one newly created
temporary root after symlink resolution. Any missing, escaping, or live path aborts
the run. It launches only the stdio MCP path, so no watcher starts. Because the
existing stdio server still starts its job runner, the scratch database must contain
no pending job, and the receipt records that job state is unchanged before/after;
this spec does not add a background-disable switch. The corpus and retrieval
dependencies are anonymous and deterministic.

Hermes itself uses the same temporary root for its working directory, `HOME`,
`HERMES_HOME`, `TMPDIR`, and XDG config/cache/data/state directories. The launch
environment is an explicit allowlist containing only the required runtime variables
and provider credentials; credential values never enter the receipt. Non-CBrain
tools, plugins, personal profile data, and unrelated skills are disabled. The
reviewed CBrain skill pack is copied into the isolated Hermes root and identified by
digest. Any resolved Hermes or CBrain writable path outside the temporary root
aborts the run. The manual receipt records only root-independent config/skill
digests, path-isolation results, job-state result, and teardown result; the temporary
root is removed after the run. This is a protocol check, not a new production
isolation subsystem or snapshot implementation.

If private real-use evidence conflicts with the anonymous fixture, the real-use
result establishes that a problem exists. Code does not change until a safe,
anonymous reproduction or a narrow deterministic invariant is available.

Existing telemetry may contain queries; this contract prevents their export rather
than claiming they were never stored. Private natural-use trends are advisory and
are not presented as paired, same-workload before/after proof.

## 9. Prioritization

Candidate work is ordered by:

1. misleading behavior or task failure;
2. frequency in ordinary use;
3. avoidable user effort;
4. strength of evidence;
5. implementation and rollback risk.

Only the highest one or two red/yellow journeys enter a development iteration.
Discovery volume, test count, code size, or roadmap novelty do not independently
create priority.

## 10. Initial Optimization Order

### 10.1 First: bounded-fallback diagnosis, then abstract-recall honesty

Current private evidence indicates a possible two-call journey failure: an abstract
request returns empty at `cbrain_recall`, then the Hermes bounded fallback invokes
`deep_recall` and can surface unrelated low-quality candidates while claiming
success. The existing #337 front-door candidate-honesty implementation and its
passing quality matrix are protected controls; they do not reproduce this two-call
boundary and are not authorized for redesign.

Before an implementation plan exists, a bounded diagnosis must freeze one anonymous
state machine:

```text
anonymous request class
  -> cbrain_recall actual/expected public envelope
  -> documented fallback trigger
  -> at most one deep_recall(detail="brief", limit=3)
  -> deep_recall actual public envelope
  -> Hermes actual/expected final-answer properties
```

The diagnosis identifies whether the defect is in `deep_recall` candidate
credibility, public status formatting, the skill fallback contract, or Hermes final
composition. It also fixes the output mode under test and records the current user
harm without private content. If this exact chain cannot be reproduced anonymously,
or is not distinct from #337, the slice stops without production changes.

The primary reproduction uses the output mode and `include_raw:false` setting of the
reviewed Hermes deployment. The journey card records that mode explicitly. Any
implementation must then protect the other supported public mode; `include_raw:true`
is an audit compatibility check, not an Agent answer source.

The anonymous F2 reproduction uses a healthy runtime whose first envelope is
`empty`; runtime/freshness `degraded` is an excluded F3 condition and must not be
generalized into this fix. The diagnosis records the second envelope without
prejudging whether that tool is defective. The journey-level oracle is that Hermes
leads with the absence of sufficiently relevant memory, does not promote a
low-support candidate to fact, exposes no internal field, and stops after the one
fallback. Only if evidence locates the seam in `deep_recall` credibility or status
may the implementation issue require its envelope to become `empty` with count zero.
If the seam is the skill or Hermes composition, `deep_recall`'s independent contract
is preserved.

The diagnosis permits three minimal honest terminal shapes and selects the smallest
one supported by evidence: the skill stops after the front-door empty result; one
fallback occurs and the skill/Hermes layer abstains without promoting its candidates;
or one fallback occurs and the tool itself returns an honest empty envelope. A fix
does not have to preserve the second call merely because the current workflow makes
it.

If new evidence selects a `deep_recall` change, #337's front-door behavior and
quality outcomes remain protected. Its historical non-goal that left `deep_recall`
unchanged may be superseded only explicitly: the issue must name the affected #337
tests/contracts, explain why the existing fused-score gate is insufficient at this
new seam, and pass the #361 public-behavior approval before implementation.

Only after that reproduction may the first implementation slice:

- extend existing recall-quality infrastructure only if it executes the identified
  production boundary;
- distinguish usable evidence from low-quality candidates at the response-status
  boundary;
- prefer empty/insufficient over unrelated filler;
- preserve concrete recall behavior and its fast path;
- avoid a new retriever, reranker, tool, LLM call, table, or framework;
- keep the existing public status enum (`ok`, `empty`, `degraded`, `error`); if the
  reproduced seam is the tool status, map insufficient low-support results to an
  existing honest status rather than adding a new public enum;
- cover legacy and structured output where the identified boundary supports both;
- record exact before/after results on the anonymous case and use later natural
  private activity only as qualitative follow-up without exporting private content.

The first slice is not authorized to improve every abstract query or redesign the
retrieval stack. It fixes only the honesty boundary demonstrated by the reproduced
journey.

### 10.2 Second: actionable next actions

After the first slice passes, inspect the existing next-action journey. Repeated,
generic review messages are a yellow/red experience even if their structured
payload is compact.

The next slice should make an existing suggestion understandable and actionable, or
silence it when safe public information is insufficient. It must not auto-run the
suggested operation or expose private/internal identifiers.

### 10.3 Third: measured slow-path reduction

Ordinary successful queries are not a target for broad optimization while their
current latency is acceptable. Performance work begins with the measured slow tail:

- research steps that add no user-visible value;
- unnecessary expansion or decomposition;
- budget exhaustion that returns weak evidence after a long wait.

The preferred optimization is to skip, bound, or reuse work. Raising timeouts or
adding concurrent speculative LLM calls is not an acceptable default.

### 10.4 Later: existing-function polish

Profile, ingest feedback, correction, provenance, discovery, graph, timeline,
health, and status are ordered only after the journey matrix supplies evidence.
There is no pre-authorized subsystem-by-subsystem rewrite.

## 11. Optimization-Period Complexity Boundary

The permanent anti-overengineering contract is defined once in `AGENTS.md` by #361
and is not redefined here. Its evidence requirements, two-existing-consumer rule,
scope triggers, and extraction limits govern every issue in this period.

This period adds only these narrower constraints:

- one issue targets one primary journey and one user-observable behavior change;
- each change has an independent code/config deployment rollback;
- no net-new tool, table, migration, daemon, framework, or default LLM call;
- no generic production module or behavior-preserving extraction for the first
  fallback slice unless the #361 review gate separately approves it;
- no test or process infrastructure beyond the smallest extension of an existing
  gate that executes the affected boundary.

## 12. Development Loop

Each optimization issue follows six steps.

1. **Reproduce:** capture one user-style request, current outcome, latency, and
   avoidable recovery steps.
2. **Bound:** identify one primary journey, non-goals, and the complexity budget.
3. **Make the smallest change:** only after reproduction passes, adjust an existing
   condition, budget, ranking, or wording before considering a new component.
4. **Verify automatically:** add only the anonymous fixtures needed to prevent the
   regression.
5. **Verify real use:** exercise the primary daily Hermes path against an isolated
   anonymous fixture; observe the live deployment only through user-initiated normal
   activity. Check another enabled cohort only when shared behavior is affected.
6. **Release narrowly:** include at most one or two related experience issues in a
   patch release.

Codex reviews goal correctness, human experience, Hermes behavior, performance,
data safety, privacy, rollback, code complexity, and test quality. Claude Code
implements only an approved issue boundary.

## 13. Failure and Rollback Rules

- Automated green plus unchanged real experience is not completion.
- Faster but less relevant output is a regression and must roll back.
- More complete but materially harder-to-read output is not accepted by default.
- This optimization period does not add a net-new default LLM call. Any exception
  exits this spec and requires a separate user decision.
- A complexity-budget violation pauses the issue for user approval.
- Live-vault writes are not part of replay or release verification unless the user
  explicitly performs the normal write journey.
- Each patch names the previous reviewed code/config deployment, the rollback steps,
  and the post-rollback verification. Rollback does not erase telemetry or restore
  user data, and no data-destructive rollback is implied.
- Before release, the previous reviewed artifact is started through its existing
  stdio or HTTP entry point, but with a temporary configuration whose vault,
  database, Lance, runtime, profile, log, and working paths satisfy the disposable
  root contract in Section 8.2. HTTP rehearsal also uses an isolated loopback port
  that is not the live service port. The process entry point and working directory
  prove the artifact root; HTTP health or the stdio MCP initialization receipt must
  report the expected version, and the selected entry point must pass its existing
  health/status probe. The receipt also names the exact production deployment steps
  that select that artifact.
  The live-release verifier is required only when it natively supports the target
  being verified, including after an actual production rollback; it is not
  repurposed for an arbitrary disposable label or port. The fixed structured-cohort
  rollback is not proof for an arbitrary patch. If the actual deployment mechanism
  cannot select the previous reviewed artifact, release is blocked rather than
  papering over the gap with `git revert` instructions or creating a new verifier.
- A slice stops without implementation when it cannot reproduce anonymously, cannot
  identify a seam distinct from an already-fixed contract, crosses a #361 trigger
  without approval, or fails to improve its real-use confirmation after one patch.
- A quality, privacy, call-budget, or protected-control regression blocks release
  and triggers rollback or rejection.

## 14. Release Gate

Existing docs, recall-quality, and host-canary gates do not execute the complete
two-call semantic journey and cannot alone approve the first patch. The identified
production seam must gain the smallest focused deterministic test in its existing
gate. In addition, Codex reviews the one-time manual journey receipt; this is an
explicit human release gate, not a claim that CI consumes journey cards.

The receipt records only allowlisted fields: public case/fixture digest, reviewed
code/skill/config digests, output mode, expected and actual call sequence, public
envelope statuses/counts, final-answer property results, blocking repetition count,
isolation result (including before/after job-state result), teardown result,
protected-gate results, evaluator, and verdict. Missing fields, any third CBrain
call, any failed blocking repetition, an isolation failure, or a protected-control
regression is a release failure.

An experience patch may ship only when:

- the active journey card improves from red/yellow or removes its measured source of
  user effort;
- existing full gates pass, and the journey's named shared-path controls do not
  regress; a patch does not create a new twelve-journey gate;
- focused tests, full checks, docs gates, and privacy scans pass;
- both the public tool envelope and the primary daily Hermes final answer satisfy
  the active card when Hermes composition is in scope;
- latency changes are reported on the same public case/fixture/config digests with
  the same timing boundary and aggregation method;
- the change remains within the issue's complexity budget;
- the rollback path is explicit and executable.

## 15. Optimization-Period Exit Criteria

These are human decision criteria, not a new automated governance gate. The
optimization period can be reconsidered when:

- each catalogue journey either has a current card or is explicitly deferred with
  evidence that it is low-frequency and has no observed problem; deferred journeys
  do not count as green and remain visible in the next decision;
- high-frequency journeys identified from privacy-safe aggregate use complete
  within the interaction and latency budgets frozen in their cards;
- low-relevance candidates no longer masquerade as successful answers;
- ordinary and advanced paths meet the explicit budgets in their active cards;
- next-action output is actionable or silent;
- honesty and safety journeys are green, and each remaining yellow has an explicit
  residual-risk decision.

Meeting these criteria does not automatically authorize a new product stage. It
only provides evidence for the next user decision.

## 16. Adversarial Review Checklist

Before approving an issue or release, attack the proposal with these questions:

1. Is this improving the user's task, or only an internal metric?
2. Can an unrelated result become faster while remaining misleading?
3. Is the test synthetic-green but real-use-yellow/red?
4. Is a new abstraction being created for one case?
5. Does the change add an LLM call, timeout path, state machine, or background job
   that the user benefit does not justify?
6. Can the output become longer, more technical, or less actionable?
7. Can private replay data leak into fixtures, logs, docs, issue text, or reports?
8. Does a shared-path change regress concrete recall, capture, correction, or
   operational routing?
9. Is rollback based on a reviewed deployment rather than destructive data restore?
10. Would doing nothing be better than showing a low-value suggestion?

## 17. Next Reviewable Step

Do not create an implementation plan yet. First produce the bounded anonymous
two-call reproduction in Section 10.1 using an anonymous fixture and scratch
database, while treating #337 as a protected control. There is no deliberate private
replay. The resulting evidence must identify one production seam, the observed
public envelopes, the smallest legal target terminal shape, Hermes final-answer
properties, call count, output mode, confirmation outcome, and teardown receipt.

This is a one-time manual protocol, not a new runner: pin the reviewed skill-pack
digest and Hermes/runtime configuration digest, connect Hermes to the isolated
anonymous fixture, send the single anonymous request for the card's declared
repetitions, record the actual one- or two-call sequence and each public envelope,
record final-answer property results, assert that no third CBrain call occurs, and
remove the disposable resources. The existing structured-host canary remains a
host/output protected control and is not extended to simulate this semantic
workflow.

If the reproduction passes, amend or link this spec with that privacy-safe evidence
and then plan only the minimal honesty fix. If it fails, close this slice without
production changes and re-prioritize from fresh journey evidence.

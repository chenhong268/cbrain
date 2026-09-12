# Structured final-answer acceptance — #412

## Final decision — 2026-09-12

The bounded human comparison in #412 is complete: **no-go for advancing to a
structured cohort; retain legacy output**. This is completion of the trial,
not approval for Stage B or a global default change. Documentation cleanup #506
records this final disposition; parent #333 remains the capability roadmap.

| Initial case | Human preference |
| --- | --- |
| Supported answer | Legacy |
| Missing information | Structured |
| Incomplete retrieval | Legacy |
| Dated relationship | Structured |
| Brief decision | Neither: both too verbose |

Only the brief-decision case was repeated, using the same question and captured
tool evidence with an identical additional instruction for both modes: give a
short conclusion and direct reason, preserve uncertainty, and omit the checklist.
The tester selected legacy. Original ratings and rejected intermediate attempts
are retained; the two rounds are not combined into a statistical win rate.
There is no consistent usability benefit here sufficient to justify the cohort.

At closure, the running service reported legacy output and the service definition
had no configured cohort. No cohort was launched. Exact-candidate Stage B host,
transport and rollback gates were not executed for this no-go decision and are
not claimed passed. Both output implementations remain available. A future trial
requires new concrete benefit evidence, a separately bounded proposal and fresh
launch gates, including the #408 prerequisite.

The accepted brief-decision guidance was applied separately to the operator's
resident Hermes instructions for new sessions and verified with the actual prompt
loader. It is not packaged as a CBrain output-mode change. Private real-question
answers remain separate from this anonymous comparison and are not published here.

The sections below preserve the initial experiment and its then-current checks;
they are historical evidence, not fresh host-release proof. No more human retests
are scheduled in this trial.

## Smallest repeated trial

Five fixed anonymous questions cover supported recall, absent information,
failed retrieval, a dated relationship, and a one-sentence decision. Both modes
use the same fixture content and questions. Ten unedited final Chinese answers
were generated and presented as five randomly labelled A/B pairs. The tester may
prefer either answer, accept both, or reject both; the label key is retained
separately until evaluation.

Execution used CBrain base `0c3dc834822be41852c151d261e327ed7ab970b5` plus the
local correction accompanying this report, and installed Hermes `0.21.1`
(checkout `45a6101f36576367359c171cd5820ee76a3d047b`). The final-answer model was
Hermes's configured `deepseek-flash`.

The trial is deliberately a final-answer exercise, not a new end-to-end host
gate. Real CBrain handlers ran through the MCP SDK's in-memory transport against
anonymous temporary SQLite/vault fixtures. Embedding/vector dependencies were
deterministic fixtures; one embedding failure was injected. Captured results
passed through the current Hermes MCP result renderer, then into its real
`AIAgent.run_conversation` with an identical answer instruction. Tools, memory,
context files and background review were disabled; Hermes state was disposable.
No gateway, live knowledge store, cohort or output-mode configuration was changed.
The default remains legacy.

This tests synthesis from fixed tool evidence. It does not establish natural
routing, Telegram delivery, live retrieval quality, or current rollout readiness.
Human evaluation cannot be replaced by the automated observations below.

## Reproduced defect and correction

An embedding failure with zero usable results was rendered as “no related
memory.” The formatter preferred the empty branch to the failure state; content
and grounded front-door routes also discarded search failure metadata. This
made a failed search look like evidence that no record existed.

The local correction carries actual retrieval failure to the empty response in
both output modes and explains that the search did not complete. A healthy empty
search remains empty. A successful deterministic/FTS answer remains usable even
when the vector channel fails. Search ranking, storage, permissions, tool lists,
defaults and retry budgets are unchanged. No runtime framework was introduced.

Eight new regression cases failed before the correction and passed afterward:
legacy/structured × ordinary/grounded deep recall and ordinary/grounded front-door
recall. Existing healthy-empty golden responses remain unchanged. The existing
identity fixture deliberately injects an embedding outage; its negative cases
now assert zero results with a degraded status rather than claiming a successful
empty search.

## Observations before human evaluation

- All ten answers were generated; no model failure or missing final answer occurred.
- Supported-answer and one-sentence cases preserved the condition for expanding
  the trial and did not claim the checks had already passed.
- The missing-information case did not invent a date.
- After correction, both failed-retrieval answers distinguished failed search
  from missing records.
- Both timeline answers preserved the two supplied dates. Structured was shorter;
  legacy exposed internal provenance/trust vocabulary.
- Usability is not a clean pass: legacy's missing-information answer exposed
  `empty` and a tool name; structured's failure answer exposed `degraded` and
  a result count. These observations are retained, not edited out of the samples.
- Recorded final-answer durations were 744–1,927 ms. These are single executions,
  not an end-to-end latency benchmark or evidence of a performance winner.

The current Hermes renderer prefers usable text content and does not duplicate
structuredContent. The July host evidence described an older projection path;
its readiness conclusion cannot be reused for this candidate.

## Verification

- Before correction: 16 existing tests passed and all 8 added failure cases failed.
- Focused output/transport/real ingest-to-recall checks: 75 passed, 0 failed.
- Empty-result, fallback and content-admission regression checks: 87 passed, 0 failed.
- `bun run check:ci`: 4,944 passed, 0 failed, including source/test type checks,
  lint, documentation consistency and the recall-quality gate.
- No cohort was enabled. Exact-candidate real-host and rollback release gates
  have not been claimed or substituted with these local checks.

## Trial disposition

#412 closes with the final no-go decision above. No rollout state needs restoration
because this trial did not enable a cohort. #506 reconciles this report with the
recorded decision; it does not authorize deletion of either output path or another
trial. Prior host-canary reports remain dated historical evidence.

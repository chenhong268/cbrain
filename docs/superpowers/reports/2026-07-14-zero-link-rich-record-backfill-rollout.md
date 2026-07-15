# Issue #342 Production Rollout Report

Initial report date: 2026-07-14
Finalized date: 2026-07-15

## Scope

This report records the complete production rollout audit for Issue #342, including corrective retries and matched rollbacks. It contains scalar operational evidence only. It intentionally excludes record names, slugs, source text, credentials, archive names, user paths, and repair payloads.

- `initialReviewedCodeSha`: `9e3dce5bc7a453615edb0a6e317c9c0271a9a6ff`
- `finalReviewedCodeSha`: `3a292e6aea0e731181ac142e62fe8a64a4261e17`
- rollout sequence authorized: `5 -> 20 -> 50`
- final rollout execution: `batch 5 retained -> batch 20 retained -> batch 50 attempted -> stop -> matched rollback of batch 50`
- merge, tag, and release: not performed

## Preflight baseline

All writers were stopped before backup and preflight. A fresh private full backup was created and verified before the canary.

| Check | Baseline |
|---|---:|
| zero-link rich records | 170 |
| actionable repair candidates | 167 |
| active rich-zero-link candidates | 3 |
| repair state conflicts | 0 |
| queue integrity conflicts | 0 |
| commit-unknown outcomes | 0 |
| foreign-key violations | 0 |
| pages without chunks | 22 |
| malformed hierarchy relations | 1 |
| Lance state | ok |

The existing consistency gate was already non-green because of one malformed hierarchy relation and 22 pages without chunks. These were recorded as pre-existing debt and were not changed under Issue #342.

## Batch 5 result

A second fresh private full backup was created and verified immediately before enqueue.

| Metric | Result |
|---|---:|
| selected | 5 |
| new jobs | 4 |
| requeued jobs | 1 |
| processed | 2 |
| failed | 3 |
| timed out | 0 |
| skipped | 0 |
| resolved | 2 |
| terminal no-link outcomes | 0 |
| commit-unknown outcomes | 0 |
| integrity conflicts | 0 |
| pending/running children after finalization | 0 |
| manifest finalized | yes |

The consumer returned a failure exit because three provider calls failed. Post-batch verification also found a new consistency regression: pages without chunks increased from 22 to 36. Both observations are stop conditions. Batches 20 and 50 were not enqueued.

## Rollback and verification

The matched batch-5 backup was restored while all writers remained stopped. The two resolved canary writes and the three failed repair states were therefore removed together.

| Check | After rollback |
|---|---:|
| zero-link rich records | 170 |
| actionable repair candidates | 167 |
| active rich-zero-link candidates | 3 |
| resolved/failed Issue #342 jobs | 0 / 0 |
| repair state conflicts | 0 |
| queue integrity conflicts | 0 |
| commit-unknown outcomes | 0 |
| foreign-key violations | 0 |
| pages without chunks | 22 |
| malformed hierarchy relations | 1 |
| Lance state | ok |

The restored values match the preflight baseline. No unrelated baseline repair was attempted.

## Guarded runtime recovery

After rollback verification, the only enabled persistent writer entrypoint was pinned to the initial reviewed code SHA in a detached, clean deployment worktree whose tracked source was read-only. Other persistent CBrain writer entrypoints remained disabled and were updated so that they could not fall back to the still older runtime.

Starting that guarded writer reopened production writes. The matched full-backup rollback authority therefore expired at that point; any later runtime failure must be handled by stopping writers and repairing forward from current state.

Runtime acceptance evidence:

- HTTP health returned `ok=true`, version `2.0.7`.
- Exactly one CBrain writer process was active and it resolved to the reviewed deployment worktree.
- The deployment worktree remained clean; its tracked-file digest was unchanged and tracked files were not owner-writable.
- MCP initialization and a read-only status call succeeded.
- Unified `job` list/status operations matched the `job_list` and `job_status` compatibility aliases.
- Live NER job projections passed the repair privacy-shape check.
- Active pending/running Issue #342-marked repair jobs: 0.
- An older runtime was rejected by the single-writer gate; it opened no secondary port and changed no jobs.
- A forced guarded-runtime restart changed the process ID, restored health, and accepted a fresh MCP session.

## Verification gates

Before production rollout, the reviewed code passed:

- full repository check: 4,050 pass, 0 fail;
- focused Issue #342 suite: 332 pass, 0 fail in independent review;
- type checks, test type checks, Biome, diff check, CLI bundle, and changed-file privacy scan;
- 21 rounds of adversarial review with no remaining CRITICAL, HIGH, or plan-shaping MEDIUM finding.

## Decision and residual risk

The implementation is ready for code review, but the production data backfill is not approved to progress beyond the canary.

Residual risks:

1. Provider reliability is insufficient for the next repair batch: three of five canary attempts failed.
2. The two successful attempts correlated with a new pages-without-chunks regression; the matched rollback removed it, but the causal path requires separate diagnosis before retrying the rollout.
3. Three active rich-zero-link candidates and the pre-existing consistency debt remain outside Issue #342.
4. The guarded runtime must remain pinned until equivalent reviewed guards are merged and deployed through the normal release path.

No merge, tag, release, or further production batch is authorized by this report.

## Corrective canary retry — 2026-07-15

The page-without-chunks regression was traced to NER-created stub pages that were written after the source-page index phase while the maintenance watcher was stopped. Corrective commit `da171f238287264de058a3a890a295683a7bfad0` limits immediate stub indexing to validated manifest-owned repairs, writes the final relation-updated body to SQLite chunks, FTS, and Lance before job completion, and leaves ordinary deferred NER on the existing watcher-owned path.

Before the retry, all writers were stopped and a new private full backup was created and verified. The preflight baseline matched the restored historical baseline:

| Check | Corrective baseline |
|---|---:|
| zero-link rich records | 170 |
| actionable repair candidates | 167 |
| active rich-zero-link candidates | 3 |
| repair state conflicts | 0 |
| queue integrity conflicts | 0 |
| commit-unknown outcomes | 0 |
| foreign-key violations | 0 |
| pages without chunks | 22 |
| malformed hierarchy relations | 1 |
| Lance state | ok |

A distinct fresh full backup was created and verified immediately before the five-item retry.

| Metric | Corrective canary |
|---|---:|
| selected | 5 |
| new jobs | 4 |
| requeued jobs | 1 |
| processed | 0 |
| failed | 5 |
| timed out | 0 |
| skipped | 0 |
| resolved | 0 |
| terminal no-link outcomes | 0 |
| commit-unknown outcomes | 0 |
| integrity conflicts | 0 |
| pending/running children after finalization | 0 |
| manifest finalized | yes |

The retry stopped before batches 20 and 50 because every provider call failed and the canary produced zero resolved records. The finalized failure ledger was retained: there was no commit-unknown state and no new data consistency regression requiring matched-backup rollback.

| Check | After corrective canary |
|---|---:|
| zero-link rich records | 170 |
| actionable repair candidates | 162 |
| active rich-zero-link candidates | 3 |
| resolved/failed Issue #342 jobs | 0 / 5 |
| repair state conflicts | 0 |
| queue integrity conflicts | 0 |
| commit-unknown outcomes | 0 |
| foreign-key violations | 0 |
| pages without chunks | 22 |
| malformed hierarchy relations | 1 |
| Lance state | ok |

Because the provider produced zero successful attempts, this retry did not exercise the corrected successful-stub path against production data and therefore cannot by itself prove that the original regression is gone in production. It confirms only that the all-provider-failure outcome introduced no new storage consistency debt; the successful-stub path is covered by focused SQLite, FTS, and Lance regression tests. The production backfill remains non-useful while the configured provider fails all selected requests.

The only enabled persistent writer now runs from a detached, clean, read-only deployment worktree at the corrective commit. Persistent disabled writer entries were also updated to that commit. Runtime acceptance passed health, exact commit/digest verification, single-writer rejection of the older runtime, a forced process restart, MCP reconnect, unified/alias job-shape parity, and protected-repair privacy projection. The restart reopened writes, so both fresh backup authorities are now expired and must not be applied to later live state.

Corrective verification passed the focused regression suite (77 pass, 0 fail), the broader Issue #342 suite (209 pass, 0 fail), the full repository suite (4,061 pass, 0 fail), type checks, test type checks, Biome, docs consistency, diff checks, changed-file privacy scanning, executable rollback-runbook fixtures, and an independent adversarial review with no actionable finding.

Final decision: the code correction is ready for PR review, but the data rollout remains stopped after the five-item canary. No merge, tag, or release was performed. Further production batches require a separate provider-reliability correction and a new preflight plus fresh matched backup.

## Final corrective rollout — 2026-07-15

This section supersedes the earlier rollout decisions while preserving them as audit history. Two additional runtime defects were found before the final retry:

1. The configured provider could exceed the bounded extraction window. Commit `43ae0457ecf622d8970b4dc610c9c67680214c2e` corrected provider timeout and retry behavior without exposing provider responses.
2. The repair CLI created a `ContentPipeline` with a Lance manager that it had not connected. Commit `7e9590e12a7309b5b57b5c3f8636b168590d5be3` connected and closed the same Lance instance only for manifest-owned repair mode; ordinary and audit modes retained zero Lance lifecycle calls.

### Intermediate canary and second rollback

The five-item production canary at `7e9590e12a7309b5b57b5c3f8636b168590d5be3` selected five items, created four jobs, and requeued one job. It processed two items and failed three. All three failures became `commit_unknown`, so the manifest remained unfinalized. The run also raised pages without chunks from 22 to 35 and produced four missing Lance page-vector coverages. Batches 20 and 50 were not started.

All writers remained stopped. The matched database, vault, and Lance snapshot was restored and verified. The restored scalar state was:

| Check | Restored value |
|---|---:|
| zero-link rich records | 170 |
| actionable repair candidates | 162 |
| active rich-zero-link candidates | 3 |
| resolved outcomes | 0 |
| retained earlier failed outcomes | 5 |
| commit-unknown outcomes | 0 |
| repair state conflicts | 0 |
| queue integrity conflicts | 0 |
| foreign-key violations | 0 |
| pages without chunks | 22 |
| malformed hierarchy relations | 1 |
| Lance state | ok |

The root cause was deterministic: NER type correction could move an existing entity to a new canonical slug, while later relation, fact, duplicate, and mention handling retained the old slug. The stale endpoint caused a foreign-key failure after the commit fence. The same move also left raw and L1 Lance rows under the old slug.

Commit `3a292e6aea0e731181ac142e62fe8a64a4261e17` closes that path by propagating the actual slug returned from type correction, remapping later resolution and mention-skip state, and migrating raw plus L1 Lance rows with a two-phase exact verification. The new side is read back and verified before the old rows are deleted; a silent short write therefore leaves the old index intact and stops the batch as `commit_unknown`. Target-vector conflicts fail closed without overwriting existing rows.

An isolated replay against a private production snapshot processed and resolved all five selected items, finalized the manifest, produced zero endpoint or foreign-key errors, and retained the 22-page pre-existing missing-chunk baseline.

### Final production batches

All writers were stopped before the final preflight. The preflight baseline matched the restored state above. A fresh private database, vault, and Lance backup was created and verified before preflight and again immediately before each requested batch.

| Metric | Batch 5 | Batch 20 | Batch 50 attempt |
|---|---:|---:|---:|
| selected | 5 | 20 | 50 |
| new jobs | 4 | 18 | 49 |
| requeued jobs | 1 | 2 | 1 |
| processed | 5 | 20 | 49 |
| failed | 0 | 0 | 1 |
| timed out | 0 | 0 | 0 |
| skipped | 0 | 0 | 0 |
| resolved | 5 | 20 | 49 |
| commit-unknown | 0 | 0 | 1 |
| pending/running at terminal check | 0 / 0 | 0 / 0 | 0 / 0 |
| manifest finalized | yes | yes | no |
| result retained | yes | yes | no |

Batch 5 and batch 20 passed every stop gate. After each batch, foreign-key violations remained zero, pages without chunks remained 22, Lance remained `ok`, repair state and queue integrity conflicts remained zero, and the digest of unrelated active jobs was unchanged.

Batch 50 triggered the mandatory stop condition after 49 resolved outcomes and one `commit_unknown`. The manifest correctly remained unfinalized. Although the immediate storage checks showed no new foreign-key, missing-chunk, or Lance regression, partial results were not retained. The matched pre-batch-50 database, vault, and Lance snapshot was restored while all writers remained stopped. The restored Lance tree matched the staged snapshot digest before the quarantined post-batch tree was removed. Two earlier staging attempts had aborted before restore or rename; their verified extraction-only directories were removed after the successful rollback.

### Final retained production state

The matched rollback removed the complete batch-50 attempt and preserved the successful batches 5 and 20:

| Check | Final value |
|---|---:|
| zero-link rich records | 145 |
| actionable repair candidates | 137 |
| active rich-zero-link candidates | 3 |
| resolved outcomes retained by this rollout | 25 |
| failed outcomes retained from the earlier canary | 5 |
| terminal no-link outcomes | 0 |
| commit-unknown outcomes | 0 |
| unfinalized manifests | 0 |
| repair state conflicts | 0 |
| queue integrity conflicts | 0 |
| foreign-key violations | 0 |
| pages without chunks | 22 |
| malformed hierarchy relations | 1 |
| Lance state | ok |

The final fsck shape is identical to the accepted baseline except for the reduced zero-link debt: zero critical findings, one pre-existing hierarchy error, and two warnings for remaining zero-link debt and the unchanged 22-page missing-chunk debt.

### Final verification and runtime acceptance

The final corrective code passed:

- focused adversarial suite: 135 pass, 0 fail, 505 assertions;
- full repository suite: 4,085 pass, 0 fail, 20,166 assertions;
- source and test type checks, Biome, docs consistency, diff checks, and changed-file privacy scanning;
- independent mutation review covering raw migration, L1 migration, old-row deletion, exact verification, and mention-skip remapping;
- injected Lance add, raw-delete, L1-delete, pre-delete-read, final-read, silent-short-write, and target-conflict failures.

The independent adversarial code review returned PASS with no CRITICAL, HIGH, MEDIUM, or LOW finding.

After proving zero unfinalized manifests, all persistent entrypoints were pinned to the final reviewed SHA. The single enabled writer runs from a detached, clean deployment worktree with read-only tracked files and a verified tracked-file digest. The alternate HTTP entry and watcher remain disabled.

Runtime acceptance passed:

- HTTP health reported `ok=true`, version `2.0.7`;
- exactly one writer process ran from the reviewed deployment;
- a forced restart changed the process and restored health;
- a fresh MCP session initialized and listed 98 tools;
- read-only `status` succeeded;
- unified `job` list/status responses matched their compatibility aliases;
- 33 protected repair projections exposed no id, payload, result, error, slug, batch identifier, or source fingerprint;
- the prior deployment runtime was rejected by the single-writer gate and changed no job state.

Reopening the reviewed writer permanently expired every preflight and per-batch backup as rollback authority. Those archives must not be applied to future live state.

Final decision: Issue #342 satisfies its safe-stop production acceptance path. Twenty-five repairs are retained; the batch-50 attempt was fully rolled back after its single commit-unknown outcome. The remaining 145 records, including 137 actionable candidates, require a new governed rollout rather than an automatic retry. The branch and PR remain unmerged, untagged, and unreleased.

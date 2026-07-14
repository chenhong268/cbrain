# Issue #342 Production Rollout Report

Date: 2026-07-14

## Scope

This report records the production canary for Issue #342. It contains scalar operational evidence only. It intentionally excludes record names, slugs, source text, credentials, archive names, user paths, and repair payloads.

- `reviewedCodeSha`: `9e3dce5bc7a453615edb0a6e317c9c0271a9a6ff`
- rollout sequence authorized: `5 -> 20 -> 50`
- rollout sequence completed: `5 -> stop -> rollback`
- merge, tag, and release: not performed

## Preflight baseline

All writers were stopped before backup and preflight. A fresh private full backup was created and verified before the canary.

| Check | Baseline |
|---|---:|
| zero-link rich records | 170 |
| actionable repair candidates | 167 |
| active legacy NER jobs | 3 |
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
| active legacy NER jobs | 3 |
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

After rollback verification, the only enabled persistent writer entrypoint was pinned to the reviewed code SHA in a detached, clean deployment worktree whose tracked source was read-only. Other persistent CBrain writer entrypoints remained disabled and were updated so that they cannot fall back to the older runtime.

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
3. Three legacy active NER jobs and the pre-existing consistency debt remain outside Issue #342.
4. The guarded runtime must remain pinned until equivalent reviewed guards are merged and deployed through the normal release path.

No merge, tag, release, or further production batch is authorized by this report.

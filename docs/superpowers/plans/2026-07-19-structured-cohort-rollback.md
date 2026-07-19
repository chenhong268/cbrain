# Structured Cohort Rollback Implementation Plan

**Goal:** Make the real Hermes rollout gate honest by providing one fixed,
tested, cohort-only rollback command without touching live state.

**Architecture:** A deterministic core validates a strict receipt and fixed
launchd target, atomically changes only the output-boundary key, restarts that
job through an injected adapter, and verifies a mode-bearing loopback health
response. CLI and host-canary layers consume the same core.

## Task 1 — RED contracts

- Add core state-machine tests for success, no-op, retry, lock, target drift,
  mutation/restart/health failures, idempotency, and unrelated-file invariance.
- Add receipt/plist parser mutations: duplicate/extra keys, symlink, ownership,
  mode, digest, label, program, port, and Unicode/path payloads.
- Add CLI tests for exact closed JSON and absence of arbitrary target flags.
- Add health test for the safe `output_boundary` enum.
- Add host-gate RED proving readiness remains blocked until executable proof.

Commit the failing tests separately.

## Task 2 — Deterministic core

- Create `src/core/release/structured-cohort-rollback.ts`.
- Export fixed IDs, strict types, canonical deployment digest, validator, and
  `rollbackStructuredCohort(deps)` with injected filesystem/process/health/time.
- Implement lock, contained managed backup, same-directory atomic mutation,
  one-way state machine, restart scope, bounded health poll, and stable errors.
- Ensure no source exception or external output enters the public result.

Run focused tests to GREEN and mutation-test each failure branch.

## Task 3 — CLI and health

- Register `structured-cohort rollback --json` in the existing CLI command tree.
- Production adapter resolves config/runtime/home/uid, invokes fixed system
  binaries with argument arrays, and never uses a shell.
- Extend `/health` with `output_boundary` and preserve existing fields.
- Add offline CLI fixture support only through injected test entrypoints, not a
  public target flag.

Run CLI, HTTP, type, and lint suites.

## Task 4 — Release proof integration

- Add an isolated repository-owned rollback fixture/proof to the host canary.
- Set the closed rollback command ID only from successful proof evidence.
- Add fail-closed mutations and update the canary report contract.
- Freeze a new evidence manifest after code review, run the full real Hermes
  matrix, and write a new anonymous report. Do not roll out.

## Task 5 — Review and release

- Run docs and full checks, diff check, and changed-file privacy scan.
- Dispatch three read-only adversarial reviewers for target confinement,
  transaction/retry, and gate/privacy/live-state integrity.
- Fix all blocking findings with RED/GREEN evidence.
- Push, open a ready PR closing #357, wait for CI, merge, verify #357 closed,
  update #333/#327, and clean only the owned worktree/branch.

## Adversarial review addendum (2026-07-19)

The first three reviewers blocked the initial implementation. Before evidence
freeze, add RED/GREEN coverage and corrections for: production-adapter gate
proof, exact entrypoint/argv/port binding, cohort/digest/PID health identity,
backup and parent symlink/hardlink/TOCTOU confinement, process-birth stale-lock
recovery, explicit launchctl status handling, Unicode duplicate keys, and
closed config-error JSON. Re-dispatch independent review after the fixes; no
live cohort or service operation is part of this addendum.

The second review additionally requires active-profile identity to flow through
receipt, plist, wrapper and health; runtime execution of the wrapper; exact
launch policy; per-fault state assertions; bounded PID publication polling; and
an exact approved-plist recheck immediately before bootstrap.

The final transaction pass replaces PID/path stale-lock recovery with a kernel
advisory lock and binds the exact loaded config bytes through a private-keyed
health attestation. The receipt freezes that attestation at rollout creation;
the adapter rejects drift before target loading and revalidates after the health
request resolves, including the exact approved legacy plist. The service derives
the attestation from the same bytes it parses into runtime dependencies rather
than re-reading the config path. It also rejects non-canonical XML key encodings.
If bootstrap cannot publish a verified PID or health, the adapter boots out and
proves the exact fixed job is not loaded; cleanup failure is a closed result.
The outer canary supervisor accepts `ready/go` only when the closed public report
carries the fixed rollback command ID and the supervisor independently proves
that claim. It requires a clean source, binds the current commit to the approved
manifest and checkpoint, verifies the trusted Bun digest, and runs the fixed
proof entrypoint in a private closed environment. Null remains blocked/no-go;
unknown IDs and child-only fixed-ID claims fail closed.

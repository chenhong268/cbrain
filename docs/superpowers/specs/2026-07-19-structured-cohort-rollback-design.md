# Structured Cohort Rollback Design

Issue: #357  
Date: 2026-07-19  
Status: Approved for implementation

## 1. Problem and invariant

The real Hermes host is compatible with CBrain structured output, but a rollout
must not begin until one repository-owned command can restore only the named
pilot cohort to legacy and prove the restarted process actually uses legacy.

The safety invariant is stronger than “set an environment variable”: the
command may mutate only one fixed dedicated launchd job, must never accept an
arbitrary execution target, and must leave enough durable state for a failed
restart to be retried without guessing.

## 2. Public command and identities

```text
cbrain structured-cohort rollback --json
```

The implementation owns these constants:

```text
command_id = cbrain-structured-cohort-rollback-v1
cohort_id  = cbrain-structured-pilot-v1
label      = ai.cbrain.structured-cohort-v1
plist      = ~/Library/LaunchAgents/ai.cbrain.structured-cohort-v1.plist
receipt    = <runtimePath>/rollout/structured-cohort-v1.json
```

There is no `--target`, `--label`, `--plist`, `--command`, `--force`, or
`--mode` option. The command cannot target the existing default service.

## 3. Managed receipt

The future rollout operation must create a mode-0600 regular JSON receipt:

```json
{
  "schema_version": 1,
  "command_id": "cbrain-structured-cohort-rollback-v1",
  "cohort_id": "cbrain-structured-pilot-v1",
  "health_port": 3401,
  "deployment_digest": "<sha256>"
}
```

The digest binds canonical `{label, program_arguments, health_port}`. Program
arguments come from the plist and must point to the repository-owned
`bin/cbrain-serve-http.sh`, include `serve --http`, and contain no shell
interpreter/callback. Receipt and plist symlinks, non-regular files, wrong
ownership, unsafe permissions, non-loopback ports, duplicate JSON keys, extra
keys, or digest drift fail before mutation. Diagnostics never print content or
paths.

## 4. State machine

1. Resolve the active CBrain config and derive the receipt path.
2. Acquire an exclusive bounded lock under `runtimePath/rollout`.
3. Validate receipt, fixed plist path, ownership, permissions, label, program,
   environment, health port, and deployment digest.
4. If mode is `structured`, copy the exact plist to a mode-0600 managed backup,
   create a same-directory temporary plist, change only
   `EnvironmentVariables.CBRAIN_OUTPUT_BOUNDARY` to `legacy`, validate the
   complete resulting plist, then atomically rename it over the cohort plist.
5. Restart only `gui/<uid>/ai.cbrain.structured-cohort-v1` using argument-vector
   `launchctl bootout` followed by `launchctl bootstrap`. “Not loaded” is
   accepted only as the expected bootout condition; bootstrap failure is fatal.
6. Poll only `http://127.0.0.1:<receipt-port>/health` with a fixed deadline.
   Success requires `{ok:true, output_boundary:"legacy"}`.
7. Return a closed JSON receipt and release the lock.

If the plist is already legacy and health proves legacy, return `already_legacy`
without restart. If it is legacy but unhealthy (for example, a previous
bootstrap failed), restart and verify. Repeated successful calls are therefore
idempotent; partial failure is retryable. The command never silently restores
structured mode because rollback is one-way.

## 5. Result contract

Success:

```json
{
  "schema_version": 1,
  "status": "rolled_back|already_legacy",
  "command_id": "cbrain-structured-cohort-rollback-v1",
  "cohort_id": "cbrain-structured-pilot-v1",
  "mode": "legacy",
  "restart_performed": true,
  "health_verified": true
}
```

Failure is exit 1 with `{schema_version,status:"failed",code}`. Codes are a
closed allowlist such as `RECEIPT_INVALID`, `TARGET_INVALID`, `LOCKED`,
`MUTATION_FAILED`, `RESTART_FAILED`, and `HEALTH_NOT_VERIFIED`. No error message,
stack, path, label supplied by disk, command output, or response body is copied.

## 6. Health and release gate

`GET /health` adds the safe enum `output_boundary: legacy|structured`. Existing
fields and status remain unchanged.

The real Hermes gate may set
`rollback_command_id=cbrain-structured-cohort-rollback-v1` only when a
repository-owned isolated rollback proof has just exercised the same production
orchestrator through mutation, restart adapter, and health verification. A
boolean constant or documentation claim is insufficient. Proof failure keeps
the field null and the overall verdict no-go.

## 7. Testing

TDD tests cover success, already-legacy no-op, recovery after restart failure,
malformed/duplicate-key/extra-key receipt, bad digest, symlink/path/permission/
ownership faults, wrong label/program/mode/port, lock contention, atomic
mutation failure, bootout/bootstrap failure, health timeout/wrong mode, logger
and subprocess privacy, exact closed JSON, and unchanged unrelated files.

The host gate test must mutate its isolated fixture, prove only the cohort target
changed, and then evaluate rollout readiness as ready. Fault injection must
restore `ROLLBACK_NOT_EXECUTABLE` without weakening host compatibility.

## 8. Non-goals

- No live cohort creation, rollout, restart, or config change.
- No change to the global legacy default.
- No arbitrary process execution or caller-selected filesystem target.
- No vault, database, ontology, search, ranking, or Hermes-private mutation.
- No claim that structured content isolates prompt injection.

## 9. Adversarial review

Before merge, independent reviewers attack target substitution, symlinks and
TOCTOU, receipt/plist ambiguity, restart scope, partial-failure retry,
concurrency, health spoofing, privacy, gate self-attestation, and live-state
preservation. Every CRITICAL/HIGH/MEDIUM finding requires a RED/GREEN fix.

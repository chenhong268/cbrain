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
  "config_identity": "<random-sha256-shaped-rollout-id>",
  "config_attestation": "<hmac-sha256-of-frozen-config-bytes>",
  "health_port": 3401,
  "deployment_digest": "<sha256>"
}
```

The digest binds canonical `{label, program_arguments, health_port}`. Program
arguments come from the plist and must be exactly the canonical, regular,
owned `bin/cbrain-serve-http.sh serve --http --port <receipt-port>` argv. The
wrapper preserves its no-argument default while forwarding this reviewed argv.
For cohort argv it preserves the canonical active `CBRAIN_CONFIG` supplied by
the fixed plist; it never substitutes a package-root profile. The receipt's
private random config identity is passed only to the cohort and used as an HMAC
key over the config bytes frozen when the receipt is created. Health exposes
only that attestation, never the key, config bytes, or path. The command rejects
the target unless the current bytes match the receipt's frozen attestation,
snapshots those bytes, and revalidates them before and after the health request,
so another profile cannot be adopted as new truth or satisfy rollback health.
Receipt and plist symlinks, hardlinks, non-regular files, wrong
ownership, unsafe permissions, non-loopback ports, duplicate JSON keys, extra
keys, or digest drift fail before mutation. Diagnostics never print content or
paths.

## 4. State machine

1. Resolve the active CBrain config and derive the receipt path.
2. Acquire a nonblocking kernel advisory lock on the private fixed lock file
   under `runtimePath/rollout`. The kernel releases it on process death; there
   is no PID-file stale-reclaim race and the lock inode is never unlinked.
3. Validate receipt, fixed plist path, canonical active config path, ownership,
   permissions, label, exact launch policy (`RunAtLoad`, `KeepAlive`, process
   type and throttle), environment, health port, and deployment digest.
4. If mode is `structured`, copy the exact plist to a mode-0600 managed backup,
   create a same-directory temporary plist, change only
   `EnvironmentVariables.CBRAIN_OUTPUT_BOUNDARY` to `legacy`, validate the
   complete resulting plist, then atomically rename it over the cohort plist.
   Managed directories cannot be symlinks. Input is read through a no-follow
   file descriptor, and inode plus exact bytes are revalidated before rename.
   An existing backup is accepted only when it is a private, single-link exact
   copy of the audited original; it is never chmod-adopted.
5. Restart only `gui/<uid>/ai.cbrain.structured-cohort-v1` using argument-vector
   `launchctl bootout` followed by `launchctl bootstrap`. “Not loaded” is
   accepted only as the expected bootout condition; bootstrap failure is fatal.
6. Poll only `http://127.0.0.1:<receipt-port>/health` with redirects disabled
   and a fixed deadline. Success requires legacy mode plus the fixed cohort ID,
   receipt config identity and deployment digest, and the PID reported by
   `launchctl print` after bootstrap. This prevents another profile or an
   unrelated loopback service from proving health.
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

`GET /health` adds the safe enum `output_boundary: legacy|structured`. Only the
dedicated cohort also emits its fixed cohort ID, keyed config attestation,
deployment digest, and process ID; the default service keeps its existing
privacy-safe field set.

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

### 9.1 Adversarial correction (2026-07-19)

The first implementation review reproduced four classes of bypass: a pure
in-memory gate proof, suffix-only program and unbound health-port validation,
backup symlink following, and an unrecoverable empty lock. It also found
Unicode-escaped duplicate receipt keys, parent-directory symlinks, hardlink/
TOCTOU substitution, over-broad bootout error handling, and a config-error path
that printed a private path instead of closed JSON.

The approved runtime correction is the stricter contract now stated above:
the gate exercises the production filesystem adapter with only launchctl and
HTTP transports replaced by spies; target and health identities are bound;
managed files/directories use no-follow, ownership, mode, link-count, inode and
byte checks; restart accepts only launchctl's explicit not-loaded status; and
the CLI uses the non-printing config loader. This correction narrows the attack
surface without changing the public command or touching live state.

The second review found that the wrapper could replace the active profile with
a package-root config and that the first fault probes returned null without
proving their faults. The final contract therefore binds a random config
identity end-to-end, preserves the active config in cohort mode, executes the
wrapper inside the isolated proof, checks each expected failure code and side
effect, requires an exact runnable launch policy, polls the named PID, and
revalidates approved plist bytes immediately before bootstrap.

The transaction review then found that a same-path config byte change was not
bound and that path-based stale-lock reclamation still admitted a two-reclaimer
race. The final implementation snapshots the active config and verifies a
startup HMAC attestation, and replaces path ownership with a kernel `flock`.

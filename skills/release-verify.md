# Live-Release Verification

Use this when diagnosing CBrain release/runtime version coherence. The active
deployment is resolved from the **loaded launchd service**, never from the shell
working directory — a stale development checkout or retained rollback worktree
must not be mistaken for the running deployment.

## Contract — always

Run the checkout-independent bootstrap. It reads the loaded `ai.cbrain.serve`
service evidence, derives the active root, and spawns the verifier from that
active root by absolute path:

```sh
sh <skill-pack-target>/release-verify-bootstrap.sh --json
```

The bootstrap works with no global `cbrain` on PATH and from any cwd (including
a stale `2.0.7` checkout while the service runs `2.0.8`).

## Forbidden

- Do **not** fall back to caller cwd (`bun run src/cli/index.ts ...`).
- Do **not** treat an inactive checkout or rollback worktree as the deployment root.
- Do **not** fabricate a version mismatch by reading a stale checkout.
- On verifier failure, report **"runtime version unverified"** and surface the
  stable code/layer. Never splice evidence to announce a mismatch the verifier
  did not assert.

## Reading results

- `status: "pass"` — the active deployment is coherent: HTTP `/health` version
  equals the active-root `package.json`, the canonical `skills/MANIFEST.json`
  `packVersion`, and every required skill-pack target compares `current`. The
  caller cwd and any rollback candidate are reported `inactive` for explanation
  only and never affect this verdict.
- `status: "fail"` with a stable `code` — the active runtime version is
  unverified at the given `layer`.

## Stable failure codes (distinct layers, never collapsed)

`SERVICE_NOT_FOUND`, `MULTIPLE_SERVICE_OWNERS`, `SERVICE_EVIDENCE_INVALID`,
`PROCESS_NOT_RUNNING`, `PROCESS_GENERATION_CHANGED`, `EXECUTABLE_ROOT_MISMATCH`,
`LISTENER_COUNT_INVALID`, `LISTENER_OWNER_MISMATCH`, `HTTP_UNAVAILABLE`,
`HTTP_RESPONSE_INVALID`, `ACTIVE_PACKAGE_INVALID`, `ACTIVE_MANIFEST_INVALID`,
`ACTIVE_VERSION_MISMATCH`, `TARGET_SET_EMPTY`, `TARGET_VERIFICATION_FAILED`,
`VERIFIER_ROOT_MISMATCH`.

## Required skill targets

Set `CBRAIN_REQUIRED_SKILL_TARGETS` (colon-separated absolute paths) to the
Hermes skill install path(s) that must match the active-root skill pack. If
unset, the standard Hermes skill path is probed. A missing/stale/incompatible/
unverified target fails with `TARGET_VERIFICATION_FAILED`; an empty set fails
with `TARGET_SET_EMPTY`.

The verifier is read-only. It performs no install, overwrite, delete, restart,
rollback, or repair.

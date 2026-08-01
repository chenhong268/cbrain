# CI Test Inventory (#381)

Source-of-truth directories covered by `bun run check:ci` (the PR gate):
`tests/bin/`, `tests/core/`, `tests/storage/`, `tests/mcp/`, `tests/http/`.

## Snapshot (at #381)

| Dir | Files | Tests |
|-----|-------|-------|
| tests/core | 137 | 2649 |
| tests/storage | 21 | 211 |
| tests/mcp | 50 | 943 |
| tests/http | 4 | 24 |
| **total** | **212** | **3827** |

## Auto-inclusion rule

`check:ci` passes the five dirs as **directory arguments** to `bun test`:
`bun test tests/bin/ tests/core/ tests/storage/ tests/mcp/ tests/http/`. bun
recurses into each dir, so any new `*.test.ts` under them is automatically
picked up — it cannot silently stay outside the PR gate. The contract test
`tests/bin/ci-workflow.test.ts` (describe `check:ci PR-test ratchet (#381)`)
asserts these dirs are exact standalone tokens of the `bun test` segment.

## Exclusions: 0

No per-file whitelist, no exclusion framework. All four dirs are PR-safe under
the current execution model.

## Caveats — why "0 exclusions" is scoped, not absolute

- **State isolation varies.** Most suites use `mkdtempSync` temp dirs, but 106
  target files contain literal `/tmp/` path patterns and at least two use fixed
  directories (e.g. `tests/mcp/recall-latency-warning.test.ts`,
  `tests/http/mcp-per-session.test.ts` → `/tmp/cbrain-test-per-session`).
- **Timing.** 8 target files use `Bun.sleep` / `setTimeout`;
  `recall-latency-warning.test.ts` has a real ~2100 ms delay.
- **Loopback.** 3 `tests/http` files bind in-process servers on `127.0.0.1`
  with dynamic ports — no external network, but they are real local servers.

These are deterministic and green today, so they are NOT excluded. The
"0 exclusions" verdict holds for the **current single-job, non-`--parallel`
run**. If `bun test --parallel`, concurrent same-workspace jobs, or sharding
are ever enabled, fixed-temp-path collisions (notably
`/tmp/cbrain-test-per-session`) must be remediated first.

## Final compatibility evidence

GitHub Linux CI (`.github/workflows/ci.yml`, ubuntu-latest, frozen lockfile,
no secrets) is the authoritative PR-safe signal. A clean local run is
necessary but not sufficient — a clean HOME with no provider keys does not by
itself prove Linux equivalence.

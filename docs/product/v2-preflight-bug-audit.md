# v2.0 Preflight Bug Audit

This is the release-manager entry point for the final v2.0 bug and experience
audit. It does not add new product behavior. It aggregates the existing owned
gates so the go/no-go decision is repeatable instead of conversational.

```bash
bun run gate:v2-preflight
```

## What It Runs

| Stage | Command | Purpose |
|:--|:--|:--|
| `offline-first-recall` | `bun run gate:offline` | Fresh install can reach first recall without live network assumptions |
| `rc-journeys` | `bun run gate:rc` | Core anonymous recall journeys pass with privacy, compactness, budgets, cleanup |
| `hermes-dialogue` | `bun run gate:hermes` | Hermes-style natural dialogue journeys stay useful and user-safe |
| `performance` | `bun run gate:perf` | Deterministic performance report stays within hard budgets |
| `docs-consistency` | `bun run check:docs` | Public docs match current version, tools, commands, and install claims |
| `resolver-pilot` | `bin/check-resolver-pilot.sh` | Agent routing and skill coverage do not drift silently |
| `storage-consistency` | `bun run gate:consistency` | Storage fsck + repair-plan stays green (no silent drift) |
| `recall-quality-matrix` | `bun run gate:recall-quality` | Anonymous Chinese, English, mixed, abstract, temporal, relationship, operational, and honest-empty recall lanes stay green |

## Report Contract

`stdout` is a stable JSON report:

```jsonc
{
  "gate": "v2-preflight",
  "verdict": "go",
  "checks": [
    {
      "id": "hermes-dialogue",
      "status": "pass",
      "exit_code": 0,
      "stdout_tail": "...",
      "stderr_tail": "..."
    }
  ],
  "failed_stage": null,
  "next_action": null
}
```

`stderr` is a concise human summary. `exit 0` means go; non-zero means no-go.

## Decision Rule

- `go`: all required stages pass. The release manager may proceed to the next
  RC/release decision.
- `no-go`: stop at `failed_stage`, inspect `stdout_tail` and `stderr_tail`, fix
  that underlying gate, then rerun `bun run gate:v2-preflight`.

## Manual RC checklist (after preflight is green)

A green `gate:v2-preflight` is necessary but not sufficient. The offline gates
cannot drive a real Hermes conversation, measure latency on real search
traffic, or validate a version-pinned install — those stay human /
environment responsibilities. The release manager must complete the items in
[`v2-rc-release-checklist.md`](./v2-rc-release-checklist.md) (real Hermes
dialogue observation, real performance p95 sampling, version-pinned install
smoke) before cutting the RC tag.

## Non-goals

- No new recall, NER, ontology, search, or write behavior.
- No access to real vault data.
- No network-dependent install validation. Network install checks remain
  separate because they depend on external services.

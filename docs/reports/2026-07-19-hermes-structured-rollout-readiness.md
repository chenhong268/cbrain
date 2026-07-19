# Hermes structured rollout readiness — Issue #357

Date: 2026-07-19
Approved evidence commit: `cea16e15287db7fd255fb421508ea09ef47fa39c`

## Decision

| Dimension | Result |
|---|---|
| Overall verdict | **go** |
| Host compatibility | **compatible** |
| Rollout readiness | **ready** |
| Rollback command | `cbrain-structured-cohort-rollback-v1` |
| Primary matrix | 24/24 completed |
| AB/BA repetitions | 12/12 completed |
| Reason codes | none |

Issue #357 closes the rollout blocker recorded by #353. The outer host
supervisor independently verified the fixed rollback proof from an approved,
read-only source/dependency/Bun snapshot and accepted the worker report only
after its evidence manifest exactly matched the approved manifest.

This result authorizes a separate bounded cohort proposal. It did **not** create
a cohort, change the global legacy default, restart a live CBrain service, or
modify a live vault or configuration.

## Runtime and rollback proof

The formal runner used the real Hermes host path with disposable loopback MCP
and inference endpoints. Runtime versions were CBrain `2.0.7`, Hermes `0.18.0`,
Bun `1.3.14`, and the frozen offline tokenizer artifact `0.12.0`.

| Proof | Result |
|---|---|
| Real Hermes host | verified |
| Hermes runtime snapshot | read-only and verified |
| CBrain execution snapshot | read-only and verified |
| Rollback proof snapshot | read-only and independently verified |
| Approved public evidence manifest | exact match |
| Fixed rollback command receipt | verified |
| Live service fingerprint | unchanged |
| Owned process/session/handle/lock/temp cleanup | verified |
| Semantic answer quality | not measured |

The rollback proof exercised the production rollback orchestrator against an
isolated fixture. Its home, runtime directory, config, receipt and plist were
private temporary state; launchctl and health transports were bounded spies.
The proof covered mutation, fixed-target restart arguments, legacy health,
backup invariants, lock reuse and unrelated-file preservation.

## Case and size gates

All normal, empty, include-raw and error cases passed for `query`,
`deep_recall` and `cbrain_recall` in both legacy and structured modes. Every
case advertised the expected tool/schema, performed exactly one correlated
CBrain call, completed the Hermes round trip, preserved projection/privacy
contracts and cleaned its owned resources.

Token counts below are the conservative worst structured versus best legacy
wrappers across both AB and BA orderings.

| Pair | Legacy | Structured | Ratio | Growth | Gate |
|---|---:|---:|---:|---:|---|
| query normal | 435 | 328 | 0.7540 | 0 | pass |
| query empty | 286 | 241 | 0.8427 | 0 | pass |
| deep_recall normal | 400 | 481 | 1.2025 | 81 | pass |
| deep_recall empty | 237 | 279 | 1.1772 | 42 | pass |
| cbrain_recall normal | 378 | 431 | 1.1402 | 53 | pass |
| cbrain_recall empty | 366 | 333 | 0.9098 | 0 | pass |

## Adversarial review

Independent review repeatedly blocked earlier candidates and reproduced these
material failures before the approved run:

- a worker could self-assert the fixed rollback command ID;
- the public report could substitute a different self-consistent manifest;
- live source or Bun could change between proof verification and execution;
- snapshot freezing removed executable bits from the fixed wrapper;
- the macOS `/tmp` to `/private/tmp` alias made the formal proof unreachable.

Each failure received a regression test and a fail-closed correction. The final
review verdict was **READY**, with no remaining HIGH or MEDIUM finding. The
formal runner then verified the exact final checkpoint rather than a prior
candidate.

## Verification evidence

- `bun run check`: 4,682 pass, 4 intentional real-host skips, 0 fail across
  277 files; 22,976 assertions.
- Formal real Hermes canary: exit 0, `go`, compatible, ready, 24/24 primary and
  12/12 repetitions, no reason codes.
- `git diff --check`, Python compilation, TypeScript checks, lint and changed
  file privacy scans passed before the report commit.

Evidence-generation digest:
`d0137f3728391ee5d5b5b3ff82ee1651af18fb32af80c9dddf7c2a3a16278c3e`

```json
{
  "algorithm": "sha256-canonical-json-v1",
  "checkpoint_tree_digest": "634f2eb862c9dce251e0b38e9f342413b6f9a7827ac6c1d4bb8021f3dcccbce7",
  "checkpoint_blob_count": 595,
  "bun_binary_digest": "e0c90ec15d33363e6b70713d56bc3b2c7585c17f40a0fe0f8fd9305901d4e233",
  "bun_version": "1.3.14",
  "node_modules_tree_digest": "4f976fb6ad9fb550ade890c9f5c00593fbd00103a86d5109be451bb46f2ab69a",
  "node_modules_file_count": 6286,
  "package_manifest_digest": "f4b1950c82660f0978dd54a1de589d3e899fbb9e2b043c6f8cc29521c484044a",
  "lockfile_digest": "b7bc7f21b4746da17774404ff721e2ade97c7aa7b2ea1e0e689a14b835fbe3e3",
  "hermes_runtime_manifest_digest": "ec443e4083e6452f4ed2a646421578e23abfbd983083d51ea21450139f454686",
  "tokenizer_blob_digest": "223921b76ee99bde995b7ff738513eef100fb51d18c93597a113bcffe865b2a7",
  "fixture_schema_digest": "bcdfa44e6f40a84b01e38745d6148e3c64e0761454f8aa1e77672168b442997d",
  "semantic_config_template_digest": "cd70feb39c724f5902b3bdde576fe49615a61ffa8ead96c55a6e1798f3547db5",
  "tool_schema_digest": "63980eb14ee524bb29e2aa6ed727f6e90caebd71e609cbe8948cc727030ac1cc"
}
```

## Residual boundaries and next step

- Semantic retrieval quality is outside this gate.
- Rollback remains intentionally fixed to the named future cohort; it cannot
  target the default service or an arbitrary path/label.
- A launchctl refusal can still make a real rollback fail closed with a stable
  code; it cannot be treated as success.
- Copying and hashing the proof snapshot adds bounded release-gate time but no
  steady-state service cost.

The next action is to review and approve a separate minimal cohort rollout
proposal. Until that happens, keep the live default on legacy.

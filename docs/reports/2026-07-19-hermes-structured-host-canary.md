# Hermes structured host canary report — Issue #353

Date: 2026-07-19
Checkpoint: `47b1c4c08425f9f68fec98294094ea14a15879f8`

## Decision

| Dimension | Result |
|---|---|
| Overall verdict | **no-go** |
| Host compatibility | **compatible** |
| Rollout readiness | **blocked** |
| Primary matrix | 24/24 completed |
| AB/BA repetitions | 12/12 completed |
| Reason codes | `ROLLBACK_NOT_EXECUTABLE` |

Issue #353 closes the host validation-error incompatibility found by #338.
All six real Hermes error cases sent the anonymous sensitive input and received
the fixed CBrain error without direct echo, validator detail, audit exposure,
or internal surface exposure. Both legacy and structured projections passed.

No rollout was performed. The overall verdict remains **no-go** only because
there is no audited executable cohort rollback command. Host compatibility is
therefore established independently from rollout readiness; the live default
must remain legacy until the rollback gate is implemented and verified.

## Scope and runtime proof

The repository-owned runner used the real Hermes `chat -q -Q --cli` host path
against disposable loopback MCP and inference endpoints. It ran CBrain `2.0.7`,
Hermes `0.18.0`, Bun `1.3.14`, and the frozen offline `tiktoken` `0.12.0`
artifact.

| Proof | Result |
|---|---|
| Real Hermes host | verified |
| Hermes runtime snapshot | read-only and verified |
| CBrain execution snapshot | read-only and verified |
| Offline tokenizer artifact | verified |
| Relevant live processes observed | 7 |
| Live service fingerprint | unchanged |
| Owned process/session/handle/lock/temp cleanup | verified |
| Semantic answer quality | **not measured** |

The canary measures host projection, contract privacy, exact wrapper size, and
owned cleanup. It does not establish retrieval relevance or semantic answer
quality.

## Case contract result

| Branch | Cases | Projection result | Privacy result |
|---|---:|---|---|
| normal | 6/6 | passed | no internal or sensitive surface exposure |
| empty | 6/6 | passed | true-empty contract preserved |
| include_raw | 6/6 | passed | opt-in audit contract and redaction preserved |
| error | 6/6 | passed | sensitive input sent; no direct or audit echo |

Every case advertised the expected tool and schema, performed exactly one
correlated CBrain call, completed the Hermes round trip, closed its MCP session,
removed its owned resources, and preserved both runtime snapshots. Error cases
projected only the fixed `Invalid tool arguments.` result. Their
`error_redaction_exercised` field is false because Hermes did not need to redact
an already-safe CBrain result.

## Default-context size gates

Token counts use the frozen offline `cl100k_base` artifact. The values below
are the conservative worst structured versus best legacy wrappers across both
AB and BA orderings.

| Pair | Legacy tokens | Structured tokens | Structured / legacy | Growth tokens | Gate |
|---|---:|---:|---:|---:|---|
| query normal | 435 | 328 | 0.7540 | 0 | pass |
| query empty | 286 | 241 | 0.8427 | 0 | pass |
| deep_recall normal | 400 | 481 | 1.2025 | 81 | pass |
| deep_recall empty | 237 | 279 | 1.1772 | 42 | pass |
| cbrain_recall normal | 378 | 431 | 1.1402 | 53 | pass |
| cbrain_recall empty | 366 | 333 | 0.9098 | 0 | pass |

All six predeclared growth gates passed in both orderings. The opt-in
`include_raw` branches were measured and passed their contracts, but are not
treated as default-context size gates.

## Adversarial review evidence

Three independent read-only reviewers attacked protocol lifecycle, privacy,
and host/release behavior after the implementation fixes. Their second-round
verdicts were all PASS with no CRITICAL, HIGH, MEDIUM, or actionable LOW
finding. Additional probes covered:

- malformed outer `tools/call` envelopes over in-memory and real stdio
  transports;
- both SDK-like prefixes returned by registered and legacy handlers;
- concurrent invalid, output-validation, and delayed business-error calls;
- nested, array, Unicode, multiline, long, and path-like rejected values;
- logger callback and real write failures;
- overlapping installs restored out of order;
- both output modes across `query`, `deep_recall`, and `cbrain_recall`.

The remaining technical risk is the documented adapter dependency on the MCP
SDK 1.29.0 private `_requestHandlers` map. Registration fails closed if the map
is not observable, and the frozen dependency digest plus transport contracts
make an SDK drift detectable. Any SDK upgrade must rerun the full review and
host gate.

## Evidence identity

Evidence-generation digest:
`06b4100ba8decbd41b913e650c8dee3802b8e84d137288e70e149604076030da`

```json
{
  "algorithm": "sha256-canonical-json-v1",
  "checkpoint_tree_digest": "626e808844bf614cc118a311d908606acba6d3e42f3817f36bdc0eb954619f34",
  "checkpoint_blob_count": 589,
  "bun_binary_digest": "e0c90ec15d33363e6b70713d56bc3b2c7585c17f40a0fe0f8fd9305901d4e233",
  "bun_version": "1.3.14",
  "node_modules_tree_digest": "4f976fb6ad9fb550ade890c9f5c00593fbd00103a86d5109be451bb46f2ab69a",
  "node_modules_file_count": 6286,
  "package_manifest_digest": "15325161441b08b6e5f74bd4fdcbb2b2d8e42392d3a19973b899c1f83b4b1dc1",
  "lockfile_digest": "b7bc7f21b4746da17774404ff721e2ade97c7aa7b2ea1e0e689a14b835fbe3e3",
  "hermes_runtime_manifest_digest": "ec443e4083e6452f4ed2a646421578e23abfbd983083d51ea21450139f454686",
  "tokenizer_blob_digest": "223921b76ee99bde995b7ff738513eef100fb51d18c93597a113bcffe865b2a7",
  "fixture_schema_digest": "bcdfa44e6f40a84b01e38745d6148e3c64e0761454f8aa1e77672168b442997d",
  "semantic_config_template_digest": "cd70feb39c724f5902b3bdde576fe49615a61ffa8ead96c55a6e1798f3547db5",
  "tool_schema_digest": "63980eb14ee524bb29e2aa6ed727f6e90caebd71e609cbe8948cc727030ac1cc"
}
```

The independent reviewer matrix and the formal frozen runner agreed on the
aggregate verdict, reason code, matrix counts, six repeated size pairs, safe
error projection, unchanged live fingerprint, and verified cleanup.

## Required follow-up

1. Define a repository-owned, bounded, auditable cohort rollback command.
2. Test rollback success, no-op, failure, idempotency, privacy, and live-state
   preservation from an isolated fixture.
3. Rerun this host gate from the rollback implementation checkpoint before any
   structured cohort proposal.

Until that follow-up is complete, keep the live default on legacy and do not
start a structured cohort.

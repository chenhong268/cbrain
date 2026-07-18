# Hermes structured host canary report — Issue #338

Date: 2026-07-18
Checkpoint: `20bf2f8ce31a13f3017c5ce163fedc4955e4b6ff`

## Decision

| Dimension | Result |
|---|---|
| Overall verdict | **no-go** |
| Host compatibility | **incompatible** |
| Rollout readiness | **blocked** |
| Primary matrix | 24/24 completed |
| AB/BA repetitions | 12/12 completed |
| Reason codes | `CASE_CONTRACT_FAILED`, `ROLLBACK_NOT_EXECUTABLE` |

The structured boundary must not be enabled for a Hermes cohort from this evidence. The real host completed all cases, but all six error cases exposed the anonymous sensitive input through the model-visible MCP error projection. The same failure occurred in legacy and structured mode, so this is a host/error-boundary incompatibility rather than a structured-only regression.

No rollout was performed. There is also no audited executable cohort rollback command; `rollout_readiness` therefore remains blocked independently of host compatibility.

## Scope and runtime proof

The canary used the real Hermes `chat -q -Q --cli` host path against disposable loopback MCP and inference endpoints. It ran CBrain `2.0.7`, Hermes `0.18.0`, Bun `1.3.14`, and the offline `tiktoken` `0.12.0` implementation.

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

The canary measures host projection, contracts, privacy, and exact wrapper size. It does not establish retrieval relevance or semantic answer quality.

## Case contract result

| Branch | Cases | Projection result | Privacy result |
|---|---:|---|---|
| normal | 6/6 | passed | no internal or sensitive surface exposure |
| empty | 6/6 | passed | no internal or sensitive surface exposure |
| include_raw | 6/6 | passed | audit available and anonymous sentinels redacted |
| error | 0/6 | failed | anonymous sensitive input echoed in the model-visible MCP error |

Every case advertised the expected tool/schema, performed exactly one correlated CBrain call, completed the Hermes round trip, closed its MCP session, removed its owned resources, and preserved both runtime snapshots. The error cases failed only the error projection/redaction contract; `surface_internal_exposed` remained false.

## Exact host context sizes

Token counts use the frozen offline `cl100k_base` artifact. Code units count the exact model-visible Hermes wrapper. Normal and empty rows use the conservative worst structured versus best legacy value from both AB and BA orderings; both orderings had identical values and passed their observation contracts.

| Tool | Branch | Legacy result tokens | Structured text tokens | Structured content tokens | Legacy wrapper tokens | Structured wrapper tokens | Token delta | Legacy code units | Structured code units | Code-unit delta |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| query | normal | 310 | 131 | 77 | 435 | 328 | -107 | 1,333 | 1,010 | -323 |
| query | empty | 175 | 87 | 44 | 286 | 241 | -45 | 937 | 795 | -142 |
| query | include_raw | 442 | 327 | 201 | 581 | 720 | +139 | 1,847 | 2,245 | +398 |
| query | error | 128 | 128 | 0 | 224 | 224 | 0 | 850 | 850 | 0 |
| deep_recall | normal | 289 | 206 | 136 | 400 | 481 | +81 | 1,143 | 1,375 | +232 |
| deep_recall | empty | 140 | 105 | 60 | 237 | 279 | +42 | 739 | 901 | +162 |
| deep_recall | include_raw | 750 | 612 | 426 | 933 | 1,297 | +364 | 2,850 | 3,817 | +967 |
| deep_recall | error | 113 | 113 | 0 | 208 | 208 | 0 | 812 | 812 | 0 |
| cbrain_recall | normal | 257 | 183 | 118 | 378 | 431 | +53 | 1,263 | 1,251 | -12 |
| cbrain_recall | empty | 247 | 133 | 82 | 366 | 333 | -33 | 1,225 | 1,017 | -208 |
| cbrain_recall | include_raw | 306 | 385 | 235 | 432 | 833 | +401 | 1,480 | 2,761 | +1,281 |
| cbrain_recall | error | 122 | 122 | 0 | 219 | 219 | 0 | 842 | 842 | 0 |

All six predeclared normal/empty growth gates passed:

| Pair | Structured / legacy | Growth tokens | Gate |
|---|---:|---:|---|
| query normal | 0.7540 | 0 | pass |
| query empty | 0.8427 | 0 | pass |
| deep_recall normal | 1.2025 | 81 | pass |
| deep_recall empty | 1.1772 | 42 | pass |
| cbrain_recall normal | 1.1402 | 53 | pass |
| cbrain_recall empty | 0.9098 | 0 | pass |

The larger opt-in `include_raw` wrappers are reported, not treated as default-context gate failures. In particular, `cbrain_recall include_raw` nearly doubled wrapper tokens; this remains an explicit opt-in cost to monitor after the host error boundary is fixed.

## Evidence identity

Evidence-generation digest: `025c565aa76088901ae316161f66b43fc3509a85d55bdfb56ff5ddfaa3de47b0`

```json
{
  "algorithm": "sha256-canonical-json-v1",
  "checkpoint_tree_digest": "3f642192ca41a714318f1305b5b8daacdd191d83958fb70d28db9fd3dfb14e4b",
  "checkpoint_blob_count": 584,
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

Two consecutive executions from this frozen checkpoint produced the same aggregate verdict, reason codes, matrix counts, six repeated normal/empty size-pair measurements, evidence identity, live-fingerprint result, and cleanup result. The second execution retained only the closed public summary; its temporary 0600 raw JSON was deleted immediately after parsing.

## Required follow-up

1. Fix the Hermes/MCP error projection so validation errors never echo tool arguments or credential/path-like input into model-visible content. Preserve a fixed, privacy-safe error envelope and test all three tools in both output modes.
2. Rerun this complete canary from a newly reviewed and frozen checkpoint. Do not reuse this no-go result as rollout evidence.
3. Define and test a repository-owned cohort rollback command before any structured rollout proposal.

Until all three are complete, keep the live default on legacy and do not start a structured cohort.

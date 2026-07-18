# Hermes Structured Host Canary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Do not run the real canary until the plan passes three independent adversarial reviews.

**Goal:** Run a real, isolated Hermes host canary against temporary legacy and structured CBrain runtimes, then publish a privacy-safe decision record for Issue #338.

**Architecture:** A repository-owned Python supervisor starts before any temporary root exists, binds its expected shell parent's microsecond birth identity, acquires the outer kernel lock, creates one device/inode-bound private root, and launches the Bun bootstrap as leader of an isolated process group. Bootstrap, lock helper, and worker remain in that group. Each Hermes case begins in the bootstrap group through a registered launcher; the launcher must complete a token-bound supervisor acknowledgement before becoming its own process-group leader and executing the no-fork-sandboxed host. The supervisor therefore owns both the bootstrap group and every exact PID/start-registered Hermes process even if the host calls `setsid`/`setpgid`. A pre-frozen, read-only CBrain/Bun/node_modules snapshot creates a frozen anonymous SQLite fixture plus empty LanceDB; each tool/branch pair clones it into fresh legacy and structured CBrain contexts exposed through case-exclusive random loopback MCP servers and observing proxies. Every case launches a separately verified, read-only Hermes/Python runtime snapshot through the real `chat -q -Q --cli` path with an empty temporary `HOME`, `HERMES_HOME`, working directory, and strict environment allowlist. A bearer-authenticated local Chat Completions SSE stub drives one advertised, prefixed MCP tool call; it verifies the matching tool result that Hermes sends back to the model and returns a digest-bound final marker. The harness holds exact evidence only in memory, recursively validates the closed public schema, emits only after cleanup attempts and lock release, proves live services are unchanged, explicitly closes observed MCP sessions, and removes only resources owned by the current run.

**Tech Stack:** Bun/TypeScript, CBrain MCP-over-HTTP, SQLite, LanceDB, Hermes Agent v0.18.0 host, OpenAI Chat Completions SSE, and the installed Hermes Python `tiktoken` implementation using `cl100k_base`.

## First-principles success definition

Issue #338 is not asking whether CBrain's SDK response is valid; #331 already proves that. It asks whether the real Hermes host advertises the intended MCP tool, calls it once, projects CBrain's text and structured payload into the next model request without losing user-visible facts, preserves the intended trust boundary, and can do so without touching live state.

The canary therefore requires a complete evidence chain for every case:

1. the installed Hermes runtime bytes match a pre-frozen, independently reviewed runtime manifest;
2. Hermes's first streamed model request advertises the exact prefixed MCP tool and its expected input schema;
3. the SSE stub emits exactly one tool call with a unique model-side call ID;
4. the case-exclusive observing MCP proxy records exactly one CBrain `tools/call` with the exact expected name and arguments;
5. Hermes's second model request contains exactly one matching `role=tool` message with the same call ID;
6. the projected message satisfies the per-case content and boundary truth table;
7. the final Hermes stdout marker is derived from the captured tool-message digest, not hard-coded success;
8. all observed MCP sessions, owned processes, handles, locks, and temporary files are gone;
9. the before/after live-service fingerprint is identical.

The model-side call ID does not enter MCP. Correlation is deliberately two-hop: assistant/tool messages share the model call ID; an exclusive listener/session plus exact name/arguments and one receipt bind the MCP hop. This deterministic stub verifies host transport and projection. It does **not** measure open-ended model reasoning quality; the public report must say `semantic_answer_quality_not_measured=true`.

## Frozen case matrix and output truth table

Run `2 output modes × 3 tools × 4 branches = 24` unique primary cases. The 12 default normal/empty cases receive one additional opposite-order measurement run, for 36 real host executions total; repetitions never substitute for primary matrix completeness.

- Modes: `legacy`, `structured`.
- Tools: `query`, `deep_recall`, `cbrain_recall`.
- Branches: `normal`, `empty`, `include_raw`, `error`.
- Model-visible tool names: `mcp_cbrain_canary_query`, `mcp_cbrain_canary_deep_recall`, and `mcp_cbrain_canary_cbrain_recall`.

The error branch uses a real invalid argument through the advertised tool schema, not an inference-stub error. The empty branch uses an empty but real LanceDB plus nonmatching FTS query, so it cannot become a false vector hit.

| Mode/tool | normal and empty | include_raw | error |
|---|---|---|---|
| legacy `query` | top-level legacy raw present | same legacy raw contract | sanitized MCP error, no stack/path/credential |
| legacy `deep_recall` | compact, no raw | top-level legacy raw present | sanitized MCP error, no stack/path/credential |
| legacy `cbrain_recall` | top-level legacy raw present | same legacy raw contract | sanitized MCP error, no stack/path/credential |
| structured, all three | Hermes wrapper contains `result` plus `structuredContent`; no top-level raw or audit | wrapper contains matching text/structured audit; `audit.raw` present and redacted | sanitized MCP error, no stack/path/credential |

Structured `display`, `summary`, and `data` must not expose slug, score, routing, latency, credential, path, or stack material. Structured `audit.raw` may retain documented locator metadata such as slug/score, but must not retain credential or path sentinels. Scanners must inspect these surfaces separately.

Audit usability is tool-specific. Structured `query(include_raw)` must retain documented query locator/raw metadata; structured `deep_recall(include_raw)` must retain its documented recall locator/raw metadata; structured `cbrain_recall(include_raw)` must retain frontdoor routing/route-specific raw metadata and is not required to invent query-style slug/score locators. All other structured branches have audit contract `none`.正文里的同名字符串不能冒充结构化 audit 证据。

Projection shape is branch-aware:

- every legacy success is `legacy_result_only`;
- every structured `normal`, `empty`, or `include_raw` success is `result_plus_structured`;
- every legacy or structured `error` is `mcp_error_only`, with no result component and no `structuredContent`.

Only `result_plus_structured` cases run text/structured consistency checks. Error cases instead require the exact error-only shape and the error contract.

Normal and `include_raw` use three distinct, fixed-length anonymous sentinels: a query-only marker, a result-title marker, and a result-body marker. Only the latter two count toward answer completeness. Empty requires `status=empty`, `count=0`, and absence of both result markers. Error requires MCP error evidence and absence of raw stack/path/credential material.

## Predeclared verdict gates

The report separates `host_compatibility` from `rollout_readiness`. `host_compatibility=compatible` is allowed only when every host-canary gate passes:

- all 24 primary cases and 12 declared size repetitions complete through the real Hermes host;
- frozen runtime identity, advertised tool/schema, two-hop one-call correlation, host projection, and final digest marker are verified for every case;
- every cell in the output truth table matches exactly;
- normal and `include_raw` preserve both result-only answer markers;
- empty and error cases meet their semantic and sanitization contracts;
- all cases have their branch-specific projection kind; structured non-error cases additionally have text/structured consistency;
- synthetic credential/path redaction and the tool-specific audit contract are non-vacuously demonstrated for every structured `include_raw` case;
- exact `cl100k_base` counting succeeds for all paired samples with one tokenizer version;
- for every default `normal`/`empty` pair, let `S` be the worst observed structured wrapper and `L` the best observed legacy peer across AB/BA repetitions, then define growth as `max(0, S - L)`: growth must be at most 128 tokens; if `L >= 128`, `S` must also be at most `1.25 × L`; if `L < 128`, `S` must be at most `L + 32`; shrinkage is always allowed, and aggregate medians are informational and cannot mask a failing pair;
- live fingerprint, isolation, privacy, and cleanup gates pass.

`rollout_readiness=ready` additionally requires a bounded cohort and a tested, repository-owned one-command rollback selected from a closed command ID allowlist. It may not contain a local service label/path or an untested placeholder. Creating that wrapper or naming a live cohort is outside #338, so compatibility may be proven while rollout remains `blocked`. The overall issue verdict is `go` only when both fields pass; compatible-but-blocked is `no-go` with `ROLLBACK_NOT_EXECUTABLE`, without downgrading the host evidence.

The 128-token absolute ceiling bounds material per-call context growth; the 25% relative ceiling prevents large responses from consuming a materially larger context share; the 32-token small-base floor avoids unstable percentages on tiny empty wrappers while still bounding fixed schema overhead. These are release-risk budgets chosen before observing canary results. The `include_raw` and error size deltas are informational because their shapes differ intentionally. A host compatibility pass does not authorize production rollout. Any mandatory host failure yields `host_compatibility=incompatible`; a preflight/runtime failure before a trustworthy comparison yields `unverified` and overall `fatal`. The output-boundary default remains unchanged in this issue.

## Global constraints

- Never modify, restart, reload, or signal live Hermes/CBrain state. Live config/plist/wrapper bytes may be read only for the required fingerprint; never parse secret values, inspect vault/database/Lance contents, or expose hashed input.
- Never inherit the parent environment wholesale or copy credentials. All canary endpoints are loopback and use generated credentials.
- Only anonymous synthetic fixtures may enter tests, logs, prompts, reports, or commits.
- The public report is a closed aggregate schema. It contains no arbitrary error/stdout/stderr strings, absolute paths, credentials, raw messages, private content, exact PID, service label, session ID, slug, score, routing value, or latency value.
- Exact runtime paths, process identities, config metadata, tool messages, and session identifiers exist only in memory and are discarded after evaluation.
- Cleanup may signal/delete only resources whose PID/start identity or directory device/inode ownership was recorded by this run. It may never signal or delete a baseline, a replaced path, or another run's resource.
- Machine failure cannot run synchronous cleanup. Wrapper SIGKILL is covered by the already-running Python supervisor, which verifies parent/child microsecond birth identities, converges the bootstrap group plus every acknowledged Hermes birth through TERM/KILL, removes only the original device/inode-bound root, and releases its outer advisory lock last. The report must not claim an impossible machine-failure guarantee.

---

### Task 1: Lock the closed report contract and 24-case evaluator

**Files:**
- Create: `bin/lib/hermes-structured-host-canary.ts`
- Create: `tests/release/hermes-structured-host-canary.test.ts`

- [ ] **Step 1: Write failing contract tests**

Define closed enums and explicit expectations rather than a generic “raw leaked” flag:

```ts
type OutputMode = "legacy" | "structured";
type ToolName = "query" | "deep_recall" | "cbrain_recall";
type Branch = "normal" | "empty" | "include_raw" | "error";
type TokenMethod = "tiktoken_cl100k_base_exact";
type ProjectionKind = "legacy_result_only" | "result_plus_structured" | "mcp_error_only";
type AuditContract = "none" | "query_locator_metadata" | "deep_locator_metadata" | "frontdoor_routing_metadata";

interface CanaryCaseResult {
  case_id: string;
  mode: OutputMode;
  tool: ToolName;
  branch: Branch;
  runtime_identity_verified: boolean;
  advertised_tool_verified: boolean;
  advertised_schema_verified: boolean;
  cbrain_invocation_count: number;
  cbrain_call_verified: boolean;
  mcp_session_verified: boolean;
  session_cleanup_verified: boolean;
  case_cleanup_verified: boolean;
  semantic_config_verified: boolean;
  host_projection_verified: boolean;
  round_trip_verified: boolean;
  result_title_present: boolean;
  result_body_present: boolean;
  empty_contract_verified: boolean;
  error_contract_verified: boolean;
  legacy_raw_present: boolean;
  default_audit_present: boolean;
  expected_audit_contract: AuditContract;
  audit_contract_verified: boolean;
  audit_redaction_exercised: boolean;
  sensitive_input_sent: boolean;
  direct_error_sensitive_echo_observed: boolean;
  error_redaction_exercised: boolean;
  audit_sensitive_exposed: boolean;
  surface_internal_exposed: boolean;
  expected_projection_kind: ProjectionKind;
  observed_projection_kind: ProjectionKind;
  projection_contract_verified: boolean;
  text_structured_consistent: boolean | null;
  token_method: TokenMethod;
  result_text_tokens: number;
  structured_content_tokens: number;
  wrapper_total_tokens: number;
  wrapper_total_code_units: number;
}

type DefaultBranch = "normal" | "empty";
type ModeOrder = "legacy_then_structured" | "structured_then_legacy";

interface SizePairEvidence {
  pair_id: string;
  tool: ToolName;
  branch: DefaultBranch;
  ab: { order: "legacy_then_structured"; legacy_tokens: number; structured_tokens: number; legacy_code_units: number; structured_code_units: number };
  ba: { order: "structured_then_legacy"; legacy_tokens: number; structured_tokens: number; legacy_code_units: number; structured_code_units: number; legacy_contract_verified: boolean; structured_contract_verified: boolean };
  worst_structured_tokens: number;
  best_legacy_tokens: number;
  growth_tokens: number;
  ratio: number | null;
  absolute_gate_passed: boolean;
  relative_or_floor_gate_passed: boolean;
}

interface PublicEvidenceManifest {
  algorithm: "sha256-canonical-json-v1";
  checkpoint_tree_digest: string;
  checkpoint_blob_count: number;
  bun_binary_digest: string;
  bun_version: string;
  node_modules_tree_digest: string;
  node_modules_file_count: number;
  package_manifest_digest: string;
  lockfile_digest: string;
  hermes_runtime_manifest_digest: string;
  tokenizer_blob_digest: string;
  fixture_schema_digest: string;
  semantic_config_template_digest: string;
  tool_schema_digest: string;
}
```

Tests must assert `expected_cases=24`, primary exact uniqueness, the frozen truth table, all three projection kinds, paired size-threshold behavior, and fail-closed handling of every false boolean/count mismatch. Size evidence must contain exactly six unique tool/default-branch pairs and exactly 12 additional executions: every pair has one AB and one BA observation, each mode appears once per order, selectors equal the actual worst/best cells, and growth/ratio/gates recompute exactly. Reject missing, duplicate, mislabeled, or cross-pair observations. Structured error tests require `mcp_error_only` and `text_structured_consistent=null`; success tests reject that shape. Add independent negative tests for an incomplete matrix, wrong host, missing advertised tool/schema, zero or duplicate CBrain calls, false answer markers, false empty/error status, projection mismatch, incorrect raw/audit location, sensitive audit data, surface internals, tokenizer mismatch, live drift, cleanup failure, and privacy leakage. Test `host_compatibility` independently from `rollout_readiness`; a missing rollback blocks overall go but does not rewrite compatible host evidence.

Privacy tests include Unix/Windows absolute paths, bearer/API-key/JWT/PEM patterns, session identifiers, and arbitrary stdout/stderr strings. The fixed-key `evidence_manifest` accepts only public versions, counts, and lowercase SHA-256 digests; it rejects paths, unknown keys, random values, or bytes. Tests canonical-serialize that object and recompute the aggregate evidence-generation digest, then reject any component/aggregate mismatch. `sanitizeCanaryReport()` rejects invalid input; it never replaces or forwards it.

- [ ] **Step 2: Verify RED**

Run: `bun test tests/release/hermes-structured-host-canary.test.ts`

- [ ] **Step 3: Implement minimal types, truth-table evaluator, and closed sanitizer**

The report stores only booleans, counts, ratios, closed reason codes, public version/revision identifiers, and aggregate live-service counts. No map of unknown keys and no captured string is permitted.

- [ ] **Step 4: Verify GREEN**

Run: `bun test tests/release/hermes-structured-host-canary.test.ts`

---

### Task 2: Freeze runtime bytes and construct a hermetic Hermes launch

**Files:**
- Modify: `bin/lib/hermes-structured-host-canary.ts`
- Modify: `tests/release/hermes-structured-host-canary.test.ts`
- Create: `tests/fixtures/hermes-structured-host-runtime-manifest.json`
- Create: `tests/fixtures/cl100k_base.tiktoken`

- [ ] **Step 1: Write failing runtime/isolation tests**

With injectable process/filesystem adapters, assert the exact preflight order:

1. resolve executable realpath, shebang/interpreter, and candidate import root using filesystem operations only—do not execute or import Hermes;
2. stat the candidate install-root `.env`, default managed scope, and any parent-provided managed-scope directory; any existing scope is fatal before a Hermes process/import, listener, or DB;
3. create dedicated empty identity-probe `HOME`, `HERMES_HOME`, `cwd`, and `TMPDIR`;
4. compare current interpreter/launcher/bootstrap/dependency/module bytes and relevant git state against a pre-frozen reviewed manifest;
5. construct one owned runtime snapshot from the frozen git commit plus byte-verified venv and Python base, perform only the reviewed relocation transforms, and verify the destination aggregate;
6. make the snapshot read-only and prove its project root has no `.env` and every resolved runtime module belongs to the snapshot;
7. only then execute the snapshot's `hermes --version` under the same strict allowlist used by real cases;
8. keep the read-only snapshot for all cases, then remove it during owned cleanup.

Tests must also assert:

- the manifest contains expected public version, git commit, interpreter/launcher relation, complete copied Python-base/venv/source canonical tree digests, import-map digest, tokenizer-blob digest, SHA-256 values, and one aggregate digest, but no absolute path;
- same-HEAD modification of any copied executable/module/dependency/stdlib/bootstrap file, editable-import remapping, and a self-consistent alternate checkout are fatal;
- unrelated dirty paths outside the closed loaded-module set do not pass by self-report: they are allowed only when plugins are disabled and the manifested source bytes/relevant paths are clean against HEAD;
- executable/import-root/revision/manifest drift is fatal;
- a synthetic install-root `.env`, default managed scope, or parent managed override fails before any Hermes execution/import; no sentinel reaches a probe process or network request;
- each case receives new empty `HOME`, `HERMES_HOME`, `cwd`, and `TMPDIR` directories with mode `0700`;
- temporary config has `plugins.enabled: []`, only one MCP server, only loopback URLs, no hooks/fallbacks/skills, and `tools.tool_search.enabled: off`;
- the child environment is created from an allowlist, not spread from `process.env`;
- parent secret, proxy, profile, plugin, provider, fallback, `PYTHONPATH`, and CBrain/Hermes override sentinels do not reach config, child, or inference requests;
- the generated `.env` has exactly one key, `OPENAI_API_KEY=<per-case random>`, and the stub observes that value only as its Bearer credential;
- the snapshot builder excludes only a closed list of `.git`, every `.env`, user state, logs, `__pycache__`, `.pyc`, and non-input caches; copies source from the frozen commit rather than the mutable checkout; includes every other Python-base/venv/source byte in the approved canonical digest; byte-verifies the clone before and after relocation; and rejects any unexpected transform or load from an excluded file;
- every identity/case process executes the snapshot interpreter plus snapshot launcher, resolves Hermes/dependency modules inside the read-only snapshot, and never opens the original install root;
- phase-boundary attacks that create an original install-root `.env` or mutate an original module after preflight cannot enter the snapshot process; every spawn also rechecks snapshot aggregate/read-only identity before and after execution;
- runtime stdout/stderr are bounded in memory and never copied into the report.

- [ ] **Step 2: Verify RED**

Run: `bun test tests/release/hermes-structured-host-canary.test.ts`

- [ ] **Step 3: Generate and independently approve the frozen runtime manifest**

The manifest has two static layers, both generated without importing Hermes:

1. **Python runtime layer:** the complete copied Python base and venv canonical trees, including interpreter, stdlib (`json`, `ssl`, `asyncio`, and all other modules), native extensions, all site-packages distributions, `pyvenv.cfg`, every active `.pth`, editable finder mapping, and any `sitecustomize`/`usercustomize`. The exclusion list is limited to non-executable caches/logs/state and is itself frozen. Set `PYTHONNOUSERSITE=1` in every probe/case. Version strings or `RECORD` bytes alone are insufficient.
2. **Application layer:** the complete tracked Hermes source tree materialized from the frozen commit, plus any separately approved runtime artifact. Plugin config remains empty, but no copied executable source gets to escape the tree digest merely because it is expected not to load.

A fresh host-authenticity reviewer must inspect the candidate source/bootstrap/dependency closure and approve the public version, commit, file set, and aggregate digest. Commit that approved manifest in its own immutable checkpoint before any real canary. The runtime accepts an expected aggregate digest supplied from that approved commit/record, verifies the fixture blob itself first, then compares current bytes; it must never generate and accept its own expected digest in one invocation.

The current checkout may contain unrelated dirty files. Do not modify them. Manifested files must match their reviewed bytes and be clean relative to the frozen commit; if a dirty file can affect loaded plugins, provider routing, bootstrap/import mapping, dependencies, or the canary path, stop fatal instead of guessing.

Build one relocation-safe runtime snapshot after verification. Materialize tracked source from the frozen commit, not from mutable working-tree bytes. Clone/copy the complete approved venv and resolved Python-base payload into the owned root, excluding only the frozen non-input list and all `.env`. Rewrite only the venv interpreter symlink, `pyvenv.cfg` home, launcher invocation, and editable finder root using a closed transform list; compute both pre-relocation normalized and post-relocation aggregate digests. Any other byte difference is fatal. Make the snapshot read-only. A sanitized import-resolution trace must fail if any Python/native executable module loads outside the manifested snapshot, except an explicit code-signed OS shared-library allowlist whose identity is recorded in the platform fingerprint.

This snapshot is the access boundary against TOCTOU: identity and all canary processes execute only its interpreter/launcher. Recheck the snapshot aggregate and permissions immediately before and after every spawn. Creating or mutating `.env`/modules in the original install after preflight cannot affect execution. Fault tests inject original and snapshot drift at every phase boundary; original drift is isolated and reported, while snapshot drift is fatal before the next case.

- [ ] **Step 4: Implement preflight and isolated launch specification**

Use the real chat path from the verified snapshot, which performs bounded MCP discovery and normal CLI cleanup:

```bash
hermes chat -q '<controlled anonymous prompt>' -Q --cli \
  --max-turns 4 --ignore-rules --source tool \
  --model canary-model --provider custom --toolsets mcp-cbrain_canary
```

Set `HERMES_IGNORE_RULES=1` explicitly as defense in depth. Use only absolute executable paths and a minimal PATH required by that installation. Point `HERMES_MANAGED_DIR` at a known nonexistent child of the temporary root after separately proving the default managed scope is absent. Do not use the broken top-level `--oneshot` path.

Generate config equivalent to:

```yaml
model:
  default: canary-model
  provider: custom
  base_url: http://127.0.0.1:<random>/v1
  api_mode: chat_completions
agent:
  max_turns: 4
plugins:
  enabled: []
tools:
  tool_search:
    enabled: off
mcp_servers:
  cbrain_canary:
    url: http://127.0.0.1:<random>/mcp
    enabled: true
    headers:
      X-CBrain-Tool-Profile: full
    tools:
      include: [query, deep_recall, cbrain_recall]
```

Before proceeding, capture the first model request and prove the advertised MCP set is exactly the three prefixed target tools, with no rules/memory/skill/plugin sentinel, extra MCP surface, non-loopback endpoint, or external fallback. Absence becomes a boolean gate; raw system content is never persisted.

- [ ] **Step 5: Verify GREEN**

Run: `bun test tests/release/hermes-structured-host-canary.test.ts`

---

### Task 3: Implement the authenticated streaming inference state machine

**Files:**
- Modify: `bin/lib/hermes-structured-host-canary.ts`
- Modify: `tests/release/hermes-structured-host-canary.test.ts`

- [ ] **Step 1: Write failing protocol tests**

Test a fresh state machine and exclusive MCP listener/session per case. Random auth/case nonces stay in the stub transport/prompt only and never enter the measured CBrain tool payload:

1. requests require a random high-entropy bearer token and case nonce;
2. first `POST /v1/chat/completions` must have `stream=true`, exactly the three configured prefixed tools advertised once with normalized JSON Schemas exactly equal to frozen expected schemas, and no tool-search bridge substitution;
3. stub emits valid Chat Completions SSE chunks for one tool call, including fragmented arguments, `finish_reason=tool_calls`, usage, and `[DONE]`;
4. second request must contain exactly one matching assistant tool call and one `role=tool` message with the same model-side call ID/name;
5. no unexpected or repeated tool calls are allowed;
6. the separate MCP hop is bound by that case's exclusive listener/session, exact expected tool name/arguments, and exactly one receipt—never by claiming the model call ID entered MCP;
7. final SSE assistant response contains a marker derived from SHA-256 of the captured tool-role content plus case nonce;
8. Hermes stdout after `trimEnd()` equals that single digest marker and contains no extra nonempty line;
9. non-streaming requests, replayed calls, wrong credentials, extra turns, invalid state transitions, and oversized bodies/streams fail closed.

- [ ] **Step 2: Verify RED**

Run: `bun test tests/release/hermes-structured-host-canary.test.ts`

- [ ] **Step 3: Freeze the tokenizer data and implement loopback SSE/token metrics**

Support only authenticated `GET /v1/models` and `POST /v1/chat/completions`. Bind `127.0.0.1`, port `0`. Cap request bodies and captured output.

Independently acquire the official `cl100k_base.tiktoken` data artifact during implementation, before the canary evidence run. Verify its SHA-256 against the expected digest declared by the approved installed tiktoken source, have a reviewer approve it, commit it as a read-only fixture, and include its blob hash in both runtime manifest and evidence-generation ID. The real canary must never download it.

Before making the runtime snapshot read-only, copy that verified blob into an owned `TIKTOKEN_CACHE_DIR` inside it using tiktoken's expected cache key, set the variable explicitly, and prohibit fallback to user/shared `TMPDIR` caches. A socket guard fails any tokenizer or Hermes non-loopback connection before I/O. Tests cover valid offline counting, missing/corrupt blob fatal before network, shared-cache sentinel rejection, and owned-cache cleanup.

Invoke the exact Python interpreter in the verified snapshot to import its installed `tiktoken`, record the public tokenizer version, reverify the data hash, and count `cl100k_base` exactly. If artifact/import/version/encoding fails, stop with `fatal`; estimates are forbidden. Count deterministic JSON serializations of:

- the `result` text component;
- the `structuredContent` component, or zero for legacy;
- the exact complete Hermes tool-role `content` string;
- UTF-16 code units for the same complete content.

Do not treat stub `usage` as provider-measured usage. Keep every actual Hermes wrapper byte-for-byte unchanged for exact counting. Because documented legacy fields such as `latency_ms` are volatile, repeat each default normal/empty pair in both AB and BA mode order from fresh snapshots; apply the conservative gate to worst structured versus best legacy actual counts. The swap-order invariant covers semantic/projection booleans, not exact token equality. Report repetition range/variability and default, empty, include-raw, and error separately rather than hiding them in one p95. Never normalize volatile fields and call the result actual host context size.

- [ ] **Step 4: Verify GREEN**

Run: `bun test tests/release/hermes-structured-host-canary.test.ts`

---

### Task 4: Build paired immutable CBrain runtimes and an observing MCP proxy

**Files:**
- Modify: `bin/lib/hermes-structured-host-canary.ts`
- Modify: `tests/release/hermes-structured-host-canary.test.ts`

- [ ] **Step 1: Write failing corpus/proxy tests**

Assert:

- one `mkdtemp` root owns a frozen fixture snapshot, disposable direct-preflight clones, isolated legacy/structured pair clones, empty LanceDBs, proxies, servers, and per-case homes;
- the frozen SQLite page/chunk/FTS fixture uses fixed anonymous query/title/body/audit/locator strings and fixed-length credential/path sentinels constructed from fragments at runtime, so measured payload size is reproducible without committing a secret-looking literal;
- bearer credentials and correlation nonces are random but never enter tool arguments or measured tool payloads;
- every LanceDB is opened and usable but contains no chunk vector rows;
- direct preflight uses disposable clones, proves normal results contain title/body markers, empty results have `status=empty` and `count=0`, and error args produce MCP errors, then destroys those clones;
- each of the 12 tool/branch pairs creates fresh legacy and structured SQLite/Lance/context/cache instances from the same frozen snapshot; the six default normal/empty pairs run a second fresh AB/BA repetition for conservative size variability;
- swapping legacy/structured execution order leaves semantic/projection booleans unchanged; actual token/code-unit counts may vary and are preserved as observed;
- output-boundary env is set only while building each immutable context and restored before any child launch;
- all listeners bind random loopback ports;
- proxy forwards bytes/headers faithfully, records MCP initialize/session IDs and parsed `tools/call` receipts, and never logs bodies;
- each case has exactly one matching tool call with expected arguments on its exclusive MCP session; no unsupported nonce is injected;
- every observed session receives explicit DELETE; a post-delete request proves it is no longer accepted;
- initialize interruption, tool timeout, child TERM/KILL, and server-stop faults still leave zero observed sessions.

- [ ] **Step 2: Verify RED**

Run: `bun test tests/release/hermes-structured-host-canary.test.ts`

- [ ] **Step 3: Implement frozen snapshots, paired contexts, proxy, and 24-case args**

Use `CBrainDB`, `LanceDBManager`, deterministic embeddings, `buildContext`, and `createHttpServer`, but do not insert a deterministic vector. Build the fixture once, checkpoint/close it, then clone it for direct preflight and each pair before opening new handles. Query logs, activity weights, search traces, and caches can mutate only that case's clone; they can never affect its peer's initial state or a later pair. The real empty LanceDB prevents unrelated queries from matching the anonymous row.

Arguments:

```ts
const common = {
  normal: { query: queryMarker, include_raw: false },
  empty: { query: missingMarker, include_raw: false },
  include_raw: { query: queryMarker, include_raw: true },
};
```

Add `strategy: "fts"` for `query`; `detail: "brief", limit: 3` for `deep_recall`; only supported fields for `cbrain_recall`. Create a tool-specific invalid type or enum for each error branch. Where possible, construct the invalid value from fixed-length synthetic credential/path fragments and record whether the direct MCP validation error actually echoes it. If it does, require the Hermes error projection to redact it. If validation never echoes input, publish `error_sensitive_echo_exercised=false` and claim only sanitized error shape/absence—never non-vacuous error redaction. The proxy does not inject unsupported nonce fields; case exclusivity, exact name/arguments, and one receipt provide the MCP-side correlation.

Parse the exact Hermes projection using the frozen truth table. For structured success wrappers, require parseable `result`, `structuredContent`, matching `schema_version`, `summary`, and `data`; error uses the error-only contract. Under the current schema, the same audit object is emitted in text JSON and `structuredContent`, so require exact audit equality whenever audit is present; only `display` remains text-only. Any future intentional schema change requires a new reviewed manifest/plan, not a relaxed canary. Scan surface fields and audit fields independently. Redaction is valid only if the tool-specific structured audit contract survives while credential/path sentinels do not: query/deep require their own locator/raw metadata, while frontdoor requires routing/route-specific raw metadata.

- [ ] **Step 4: Verify GREEN with the existing SDK boundary tests**

Run:

```bash
bun test tests/release/hermes-structured-host-canary.test.ts \
  tests/http/recall-output-boundary-canary.test.ts
```

---

### Task 5: Make ownership, signals, concurrency, and live fingerprint fail closed

**Files:**
- Modify: `bin/lib/hermes-structured-host-canary.ts`
- Modify: `tests/release/hermes-structured-host-canary.test.ts`

- [ ] **Step 1: Write failing lifecycle/fingerprint attack tests**

Cover:

- an atomic single-run lock acquired before ports/DBs; a live owner causes fatal without touching it;
- a parent-bound kernel advisory lock that rejects contenders while the owner lives and releases automatically after owner death;
- the bootstrap starts as the supervisor-owned session/PGID leader; each Hermes launcher registers and receives an acknowledgement before changing PGID, then keeps the same PID/start identity through `exec` so the supervisor can terminate it directly even after it leaves the bootstrap group;
- timeout and SIGINT/SIGTERM/SIGHUP use one idempotent cleanup promise, TERM, bounded wait, identity recheck, then KILL;
- the macOS `sandbox-exec` no-fork policy is behaviorally self-verified before Hermes starts, so a fast fork/double-fork cannot escape containment; if the policy is unavailable the canary fails closed;
- stdout/stderr and cleanup waits are bounded;
- stable live snapshots pass; PID/start/config metadata drift, inventory changes, unreadable evidence, or inconsistent double reads fail;
- wrapper/script based services resolve their actual config/env references; unclassified suspected Hermes/CBrain services fail before resource creation;
- config evidence compares bytes plus device/inode/mode/size/mtime/ctime, not hash alone;
- no baseline PID is ever signaled;
- only this run's temp root/lock is removed; no global prefix deletion is allowed.

- [ ] **Step 2: Verify RED**

Run: `bun test tests/release/hermes-structured-host-canary.test.ts`

- [ ] **Step 3: Implement ownership and read-only fingerprint adapters**

The live inventory uses stable double-read snapshots and explicit platform adapters. Relevant launchd jobs include plist bytes, executable/wrapper bytes, and conservatively parsed literal config/env references. Relevant manual processes include executable identity and explicit argv config references. A suspected service that cannot be classified or whose evidence cannot be read causes fatal before any canary listener starts.

Keep exact service metadata in memory. Public output includes only aggregate count and equality booleans for process identity, start identity, config metadata, and inventory. Never scan or hash vault/database content.

The persistent lock inodes are mode `0600`; ownership is a live kernel `flock`, not mutable owner metadata. The supervisor holds an outer lease from before root creation until every registered process/root cleanup attempt completes, so the bootstrap helper's earlier exit cannot admit a competing canary. The POSIX wrapper starts that supervisor before any root exists. The supervisor installs signal handlers, binds its expected shell parent and child-group leader microsecond birth identities, then creates and binds recursive cleanup to the original `0700` root's device/inode. Bootstrap/helper/worker stay in the bootstrap group; every Hermes process completes a private token-bound registration handshake before it may become a separate group leader. Local cleanup uses direct identity-checked PIDs, while wrapper death or non-cooperation converges the bootstrap group plus all registered Hermes births through TERM/KILL. The outer lease is released only after those attempts and root cleanup.

- [ ] **Step 4: Verify GREEN and fault cleanup**

Run:

```bash
bun test tests/release/hermes-structured-host-canary.test.ts
/bin/sh bin/run-hermes-structured-host-canary.sh \
  --bun "$(command -v bun)" --hermes "$(command -v hermes)" \
  --approved-commit "$APPROVED_EVIDENCE_COMMIT" --fault matrix
```

The fault command must exit nonzero, emit only a closed aggregate report, leave live fingerprints unchanged, and prove current-run cleanup.

---

### Task 6: Add the orchestrator CLI and run the real host canary

**Files:**
- Create: `bin/run-hermes-structured-host-canary.sh`
- Create: `bin/bootstrap-hermes-structured-host-canary.ts`
- Create: `bin/check-hermes-structured-host-canary.ts`
- Modify: `package.json`
- Modify: `tests/release/hermes-structured-host-canary.test.ts`

- [ ] **Step 1: Write failing orchestration tests**

With injected runtime, fingerprint, process, and server adapters, prove phase order:

1. a minimal shell wrapper rejects invalid or managed inputs and starts a fixed Python supervisor without creating any temporary state;
2. the supervisor installs parent-death/signal handling, creates private empty bootstrap HOME/cwd/TMPDIR, and launches the first Bun with a closed environment;
3. that first Bun uses `--no-env-file`, an explicit empty config, and a bootstrap file with only platform built-in imports;
4. bootstrap acquires the ownership lock and constructs/verifies the read-only CBrain/Bun/node_modules snapshot before importing any CBrain/harness module;
5. the snapshot worker uses filesystem-only checks to reject install/managed env sources and compare the frozen Hermes runtime manifest;
6. build/verify the read-only owned Hermes snapshot, then run its sanitized identity/import-resolution probe;
7. complete the stable live preflight;
8. create only temporary CBrain resources and a frozen anonymous fixture snapshot;
9. direct-check disposable clones;
10. run isolated legacy/structured pairs for all 24 primary cases plus AB/BA default size repetitions;
11. close observed sessions and servers;
12. close Lance/SQLite handles and remove owned roots, including both runtime snapshots;
13. recapture stable live fingerprint;
14. recompute the pre-frozen evidence-generation ID and evaluate one closed report bound to that unchanged ID;
15. remove owned snapshots, release the kernel lock, and remove the supervisor-owned bootstrap root;
16. emit the already-validated closed report only after cleanup succeeds.

Inject faults at every boundary and assert the same cleanup path. Do not allow an overall `go` result with a partial matrix, blocked rollout readiness, or semantic-quality claim.

- [ ] **Step 2: Implement the pre-Bun sanitized bootstrap and worker CLI**

`bin/run-hermes-structured-host-canary.sh` is a small reviewed POSIX wrapper with no profile sourcing or dynamic code. It accepts absolute `--bun` and `--hermes` paths, sets `umask 077`, rejects managed scope before launching child code, installs signal forwarding, and starts the fixed repository-owned Python supervisor. The supervisor creates all private bootstrap directories and invokes the first Bun with an explicit closed environment; it passes only fixed locale/system PATH values, owned paths, the two validated executable arguments, and a separately named parent managed-scope path solely for existence rejection. Fault injection is a closed CLI enum, never inherited wholesale.

The first Bun invocation is direct—not `bun run`—and uses `--no-env-file`, `--config=/dev/null`, and `--cwd=<empty-owned-dir>` with an absolute bootstrap entry. The bootstrap module statically imports only Bun/Node platform built-ins. It constructs and verifies the CBrain execution snapshot before spawning the copied Bun worker; no CBrain source, external dependency, evaluator, config loader, or harness static import may occur earlier.

Tests run the real wrapper against controlled repositories and parent environments containing `.env`, `.env.local`, mode-specific env files, parent secret sentinels, user/project `bunfig.toml` preloads, and managed-scope sentinels. From the first line of JS and every import-time module onward, secret/preload sentinels must be absent; the managed path is visible only to the explicit existence check and never forwarded. Assert the first Bun flags and empty cwd/home exactly.

Expose a convenience alias, explicitly not valid as evidence because an outer `bun run` may already have loaded dotenv:

```json
"gate:hermes-structured": "sh bin/run-hermes-structured-host-canary.sh --bun \"$BUN_EXEC_PATH\" --hermes \"$HERMES_EXEC_PATH\" --approved-commit \"$APPROVED_EVIDENCE_COMMIT\""
```

The worker CLI writes one privacy-safe JSON object to stdout and a fixed, path-free status line to stderr. Exit codes: `0=go`, `1=no-go`, `2=fatal`. No arbitrary exception text or child output crosses the public boundary.

- [ ] **Step 3: Run focused verification**

Run:

```bash
bun test tests/release/hermes-structured-host-canary.test.ts \
  tests/http/recall-output-boundary-canary.test.ts
bun run check:docs
git diff --check
```

- [ ] **Step 4: Commit and freeze the CBrain execution snapshot**

Commit the reviewed manifest/artifact checkpoint first, then the tested harness/CLI implementation. The evidence run requires a clean checkpoint commit; no uncommitted runtime byte may execute.

Before creating any listener/database, build a read-only owned CBrain execution snapshot:

- materialize tracked repository blobs from the checkpoint commit except `docs/**`, and assert no runtime import/read attempts to access excluded docs;
- clone/copy the complete installed `node_modules` payload with a frozen exclusion list limited to non-input caches/logs, and canonical-tree hash it;
- copy the exact Bun executable, record public version and binary hash, and use that copied binary for every harness process;
- verify `package.json` plus lockfile and the installed dependency tree, including the actual MCP SDK/Lance/SQLite code, not just version ranges;
- run every harness import from the snapshot and fail on executable module resolution outside it, except the separately verified Hermes snapshot and code-signed OS allowlist;
- make the snapshot read-only and reverify its aggregate/permissions before and after every phase.

Compute the evidence-generation ID **before** any canary resource from a canonical JSON manifest containing only:

- all tracked blob IDs from the checkpoint commit except `docs/**` (therefore report/wording-only docs do not alter the ID, while source/tests/fixtures do);
- Bun version/binary digest, full copied `node_modules` canonical digest/count, package/lockfile digests;
- approved Hermes runtime-manifest blob and aggregate digest, tokenizer blob digest, and fixed fixture-schema digest;
- a canonical semantic config template in which auth, random ports, temp roots, process/session/run IDs, and timestamps are fixed typed placeholders.

Exclude `.git`, `docs/**`, untracked/ignored files, live/user config, vault/DB content, raw messages, and all ephemeral values. At runtime, validate every generated config against the canonical template and placeholder types. The public report exposes the canonical component digests/public versions and resulting SHA-256 so it can be recomputed; the private random run ID is separate. Any snapshot/input drift during the run is fatal, even if bytes later revert.

Run the three adversarial implementation reviewers against this clean checkpoint and canonical evidence manifest **before** the real canary. A C/H/M fix creates a new commit, invalidates the snapshot/evidence ID, and repeats this step.

- [ ] **Step 5: Run the real canary once from frozen snapshots**

Invoke the POSIX wrapper directly with absolute Bun/Hermes arguments; never use `bun run` for evidence:

```bash
/bin/sh bin/run-hermes-structured-host-canary.sh \
  --bun "$(command -v bun)" --hermes "$(command -v hermes)" \
  --approved-commit "$APPROVED_EVIDENCE_COMMIT"
```

Use a private `mktemp` output file with mode `0600` and a signal trap; do not use a shared fixed filename. The harness itself controls live-state proof and cleanup. Delete the transient machine report after producing the aggregate decision document.

Expected: 24 primary real Hermes cases plus 12 default size repetitions complete, or the command fails closed with exact aggregate reason codes. Never weaken a gate to force `go`; a compatible host with no tested rollback remains an honest overall `no-go` while preserving `host_compatibility=compatible`. Record the fixed privacy-safe public evidence manifest and its aggregate digest, but never local paths, raw bytes, or ephemeral inputs.

---

### Task 7: Publish the anonymous decision record and finish #338

**Files:**
- Create: `docs/reports/2026-07-17-hermes-structured-host-canary.md`

- [ ] **Step 1: Write the report from the closed machine result**

Include only:

- public CBrain/Hermes/tokenizer versions and source revisions, without local paths;
- a fixed-key public evidence manifest containing algorithm/version, checkpoint tree digest/blob count, Bun version/binary digest, node_modules tree digest/file count, package/lockfile digests, Hermes runtime-manifest digest, tokenizer blob digest, fixture-schema digest, and semantic-config-template digest—never paths, random values, or raw bytes;
- the evidence-generation digest recomputed from that manifest's canonical JSON;
- 24-case primary completion, 12-run size repetition completion, and mandatory-gate counts;
- per-tool, per-branch paired legacy/structured exact token and code-unit deltas;
- component sizes for result text, structuredContent, and complete Hermes wrapper;
- raw/internal default exposure, opt-in audit availability, and non-vacuous redaction booleans;
- proof booleans for tool advertisement, one-call correlation, text-plus-structured projection, final digest round trip, and real host use;
- explicit `semantic_answer_quality_not_measured=true`;
- aggregate live inventory and equality booleans;
- owned process/session/handle/lock/temp cleanup booleans;
- explicit distinction between output shrinking/labeling and security isolation;
- separate `host_compatibility` and `rollout_readiness`, plus overall `go`, `no-go`, or `fatal`, with only stable reason codes;
- whether sensitive input was actually echoed by the direct error path; when false, label error redaction unexercised rather than passed.

If compatible, recommend a small dedicated cohort and fixed observation window. Predeclare monitoring and automatic stop thresholds for parse failures, answer incompleteness, tool errors, context growth, latency, and cleanup/session anomalies. The proposed rollout remains a separate authorized change. Its design must provide one executable rollback command that targets only the named cohort, restores `CBRAIN_OUTPUT_BOUNDARY=legacy`, restarts only that cohort, verifies health, and fails closed. The closed machine report carries only `rollback_command_id` from an allowlist or `null`; Markdown may print an exact command only for an audited repository-owned ID, never a local label/path or placeholder. Until such a command exists and is tested, report `rollout_readiness=blocked` and do not claim production rollout readiness.

- [ ] **Step 2: Privacy and adversarial scans**

Delete transient evidence. Run repository privacy guards plus explicit scans for paths, credentials, real identities, raw messages, PID/session/slug/score/routing/latency values, and arbitrary child errors. Review report claims against machine booleans; no narrative may upgrade an informational metric into a pass.

- [ ] **Step 3: Full verification before completion**

Run:

```bash
bun run check
bun run check:ci
bun run check:docs
git diff --check
git status --short
```

- [ ] **Step 4: Independent adversarial review**

Dispatch three fresh reviewers for:

1. Hermes host authenticity, SSE protocol, and evidence-chain validity;
2. environment/live-state/process/session/lock cleanup safety;
3. output truth table, redaction, token statistics, verdict honesty, and privacy.

Fix every CRITICAL/HIGH/MEDIUM finding and repeat review, up to five rounds. Do not ask the user to act as reviewer.

Any change to the harness, evaluator, case config, fixture schema/content, runtime manifest, or other evidence-generation input invalidates the previous machine result and report. Delete them, rerun Task 6 focused/full relevant verification and the entire 24-primary plus 12-repetition real canary, regenerate the report with a new evidence-generation ID, repeat privacy scans, and then repeat all affected reviews. Documentation-only wording changes under the explicitly excluded `docs/**` set may reuse evidence only when all reviewers confirm the canonical evidence inputs are unchanged.

#### Adversarial review correction — 2026-07-18

The first implementation checkpoint was rejected because its evidence manifest was generated after execution, its real-host schema and MCP-call assertions were weaker than their names, and its live/cleanup proof did not cover the full isolation boundary. The corrected gate therefore:

- loads a checked-in expected evidence manifest and compares independently observed Bun, dependency, checkpoint, runtime, tokenizer, fixture, config-template, and exact three-tool-schema identities before accepting evidence;
- obtains the three full schemas from a direct isolated `tools/list` preflight and requires Hermes to advertise the exact normalized definitions;
- binds every case to one exact tool name, canonical arguments, one MCP session, verified DELETE plus post-delete rejection, semantic config, process-group cleanup, and owned-root removal;
- uses anonymous path and credential sentinels so opt-in audit redaction and error-path echo detection are non-vacuous;
- captures the pre-run live fingerprint before any Hermes import/version probe and includes precise process birth identity, matching launchd jobs, and relevant config/launcher bytes plus metadata;
- rejects any existing managed scope before Hermes can load it, never steals a live kernel lock, and emits no complete result until the bootstrap snapshot, kernel lease, and outer root have been removed.

The sensitive error probe is observational. If the real MCP validation path echoes the anonymous sentinel, the canary must report `host_compatibility=incompatible`; the harness must not sanitize the observation or weaken the gate to obtain a passing verdict.

#### Adversarial review correction r2 — 2026-07-18

The final evidence checkpoint also incorporates the second adversarial round and real-run harness corrections:

- legacy answer completeness scans the complete model-visible legacy result, while structured completeness excludes audit-only fields;
- direct MCP error echo, model-visible projected echo, and redaction exercise are recorded as separate booleans, so an unexercised sanitized error cannot be presented as proof of redaction;
- an externally selected approved commit freezes the evidence manifest; a self-consistent but unapproved checkout is rejected;
- the complete CBrain and Hermes snapshot identities are checked before and after every real case, with 76 checks per snapshot across the 24 + 12 matrix;
- a parent-bound kernel `flock`, OS PID/start checks, process-group termination, private worker commit markers, and outer-root cleanup replace stale owner records and long-lived Bun subprocess-state assumptions;
- the recognized live fingerprint is explicitly scoped to relevant processes, matching launchd rows, and fixed or referenced service artifacts;
- the historical run at harness revision `1863a60` was invalidated by later lifecycle hardening and is not release evidence for the final checkpoint.

#### Adversarial review correction r3 — 2026-07-18

The third adversarial round replaces best-effort descendant polling and wrapper-only cleanup with deterministic containment:

- every Hermes case runs under a behaviorally verified macOS `deny process-fork` policy; an unavailable or ineffective kernel policy is fatal;
- all 12 BA repetitions run the same full host/schema/call/session/projection/privacy/cleanup case contract as the 24 primary cases;
- worker output and exit status commit atomically through a digest-bound marker, and dead workers fail immediately rather than waiting for the global deadline;
- a single Python supervisor starts before any root/Bun process, retains parent-death responsibility until cleanup, and uses microsecond process identity, one bootstrap group plus acknowledged Hermes births, TERM/KILL convergence, and device/inode-bound root cleanup;
- the Hermes install source rejects `.env` files before snapshot/import/version activity, with a behavioral byte-preservation test.

#### Adversarial review correction r4 — 2026-07-18

The fourth adversarial round removes the dual-guardian lifecycle and its detached-process gaps:

- the shell wrapper never owns temporary state; a fixed Python supervisor installs signal handling before creating the private root;
- bootstrap, lock helper, and worker share the supervisor-created process group; each no-fork Hermes case must register its exact PID/start with the supervisor before becoming a separate group leader, closing both detached-orphan and `setsid` escape paths;
- wrapper death and interrupt tests track the exact device/inode-owned root and prove cleanup against non-cooperative children;
- process-group probing treats macOS permission errors as non-empty, reaps the group leader during convergence, and contains cleanup failures without leaking a traceback or skipping root removal;
- a supervisor-held outer `flock` remains active through process/root cleanup, preventing an early helper exit from admitting a concurrent canary;
- complete results are recursively validated against the closed public schema; cleanup failure emits only a fixed fatal envelope after cleanup attempts and outer-lock release.

#### Adversarial review correction r5 — 2026-07-18

The fifth adversarial round closes the supervisor's remaining availability and serialization boundaries:

- a 15-minute supervisor-wide monotonic deadline covers bootstrap work that occurs before the worker's own deadline; expiry converges registered births and the bootstrap group, removes the owned root, and releases the outer lock without external intervention;
- parent liveness requires both the original microsecond birth identity and the current direct-parent relationship, so shell reparenting is detected before the wrapper is reaped;
- stdout and stderr are continuously drained through bounded pipes rather than unbounded temporary files; exceeding either byte budget fails closed and enters the same cleanup path;
- strict JSON parsing rejects duplicate keys at every object level and all non-finite extensions, while public integer and ratio fields are limited to finite JavaScript-safe values;
- the plan's public interfaces and launcher lifecycle text are synchronized with the final closed schema and acknowledged-registration process model.

#### Adversarial review correction r6 — 2026-07-18

The sixth adversarial round closes cross-field evidence consistency rather than validating shape alone:

- the supervisor independently recomputes every case truth-table contract, each AB/BA size formula and threshold, the canonical evidence digest, ordered reason codes, matrix counts, host compatibility, rollout state, and final verdict before forwarding a complete result;
- truthful closed `no-go` evidence remains publishable when a case contract or size observation fails, while a contradictory `go`, partial count, false runtime claim, or mismatched formula is rejected;
- `schema_version` requires the exact integer type, preventing Python's boolean/integer equality from accepting `true` as version `1`.

#### Adversarial review correction r7 — 2026-07-18

The seventh adversarial round closes a blocking filesystem-node edge in the private registration channel:

- registration requests are opened with `O_NOFOLLOW | O_NONBLOCK`, then accepted only as same-owner, single-link regular files between 1 and 512 bytes;
- exact-size bounded reads and the same strict JSON parser run only after the file-type check, so a FIFO, device, socket, oversized file, short read, duplicate key, or non-finite value cannot block or enter the registry;
- malformed formulas are rejected at the public boundary; a truthful size `no-go` is publishable only for self-consistent over-budget measurements or explicitly failed AB/BA observation contracts.

- [ ] **Step 5: Commit, publish, CI, and issue state**

Commit history now contains the approved plan, independently approved runtime-manifest/tokenizer checkpoint, reviewed harness checkpoint used by the evidence snapshot, and final report commit. Confirm the worktree is clean and diff is issue-scoped. Then push `codex/338-structured-canary`, open a ready PR linked to #338, wait for GitHub CI, and merge only if green. Close #338 with the aggregate verdict/evidence. Update #333: close it only if #338 fulfills the parent completion standard; otherwise leave it open with the exact host-side gap. Never modify the live rollout default in this issue.

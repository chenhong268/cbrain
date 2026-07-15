# Governed Daily Agent Profile Design

**Issue:** #335

**Parent:** #333

**Dependency:** #334 is merged and closed.
**Status:** Approved by the user for independent implementation on 2026-07-15.

## 1. Problem

CBrain has a unified `profile` MCP tool and durable Profile storage, but the
daily `agent` tool profile exposes no Profile operation. At the same time, the
canonical signal skills tell the Agent to persist explicit preferences through
legacy aliases and an argument shape that the runtime does not accept.

The result is a non-executable contract: explicit stable preferences remain in
an Agent's private memory instead of entering CBrain's governed Profile path.

The first slice must restore that path without granting a daily Agent broad
Profile administration or inferred-write authority.

## 2. Evidence and constraints

- `AGENT_ALLOWLIST` currently contains exactly 20 tools and excludes `profile`.
- The unified `profile` tool is already exposed to `debug` and `full` sessions.
- The legacy aliases remain registered for compatibility but are absent from
  the daily profile.
- `ProfileManager.updateEntries()` validates and writes entries sequentially.
  Calling it before a whole batch is policy-valid can therefore create a
  partial write.
- `get_profile` envelopes include total counts and module names. Returning
  those values after filtering only the entry list would still reveal metadata
  about scoped/private Profile content.
- CBrain has no authenticated daily-Agent identity that can safely resolve
  `scoped` visibility.

## 3. Considered approaches

### 3.1 Recommended: action-level policy in the unified handler

Expose only `profile` to the daily profile, then enforce a deterministic policy
inside the unified handler when `ctx.toolProfile === "agent"`.

Advantages:

- one real tool name and one real schema;
- no alias revival;
- full/debug compatibility remains local and explicit;
- the permission boundary is testable through the real MCP protocol;
- later identity-aware scopes can extend one policy point.

### 3.2 Separate read/write tools for daily Agents

Create new tools such as `profile_get_open` and `profile_update_explicit`.

Rejected because it expands the inventory, duplicates the unified schema and
envelopes, and creates another migration path for skills.

### 3.3 Expose the unified tool without handler restrictions

Rejected because tool-surface filtering alone cannot distinguish `get` from
`remove/reload`, or explicit open writes from observed/inferred private writes.

## 4. Daily tool-surface contract

Replace `append_page` with `profile` in `AGENT_ALLOWLIST`.

- The daily profile remains at 20 tools and MUST remain `<= 20`.
- `append_page` remains registered and available to `full`; this issue does not
  delete or rename it.
- `put_page` remains the daily page-update path.
- `profile` remains available in `debug` and `full` exactly as before.
- The four legacy aliases remain full-profile compatibility tools and MUST NOT
  be added to the daily allowlist.

This is a capability swap, not a net expansion of the daily surface.

## 5. Agent action policy

The following policy applies only when `ctx.toolProfile === "agent"`.

### 5.1 `action=get`

- With no `scope`, the handler MUST force `scope: "open"`.
- Explicit `scope: "open"` is allowed.
- Explicit `scope: "scoped"` or `scope: "private"` fails closed.
- Other filters (`category`, `type`, `tags`, `ids`) may further narrow the
  already-open set.
- The response's `meta.total`, `meta.filtered`, display count, and summary count
  MUST be derived only from returned open entries.
- `loaded_modules` MUST be empty for the daily response. Module names and
  hidden-scope counts are not part of the daily read contract.

No authenticated Agent identity exists in this slice, so no scoped/private
fallback is allowed.

### 5.2 `action=update`

Every entry in the batch MUST satisfy all of the following before any call to
`ProfileManager.updateEntries()`:

- the batch is non-empty;
- the full Profile entry input is structurally valid;
- `source` is present and exactly `explicit`;
- `scope` is exactly `open`;
- `agents` is absent or empty;
- `id` values are unique within the batch;
- the target ID is new, or its current Profile entry has `scope: "open"`.

The preflight MUST inspect every target ID against the current Profile snapshot.
An existing `scoped` or `private` target fails with the same generic
`PROFILE_UPDATE_INVALID` result as every other policy failure. This prevents an
Agent that guesses or remembers a hidden ID from overwriting that entry and
downgrading it to open visibility.

Updating an existing open entry is allowed even when it originated in an
enabled `profile.d` module. This preserves the existing source-file writeback
semantics needed to change an explicit preference. Module names and source
paths remain hidden. Source-file ownership policy is deferred; this slice does
not introduce a second writable Profile store.

Validation is whole-batch and deterministic. If any entry fails, the handler
returns one privacy-safe error and performs zero Profile writes. The error MUST
not echo an entry ID, content, path, module name, or parser detail.

This issue guarantees zero side effects for invalid policy/schema batches. It
does not redesign the existing Profile storage transaction model for an I/O
failure after a valid batch has entered `ProfileManager`.

### 5.3 `action=remove` and `action=reload`

Both actions fail closed for the daily profile. `ids` or other arguments do not
change the result. The handler MUST not call `removeEntries()` or `reload()`.

### 5.4 Error contract

Daily policy failures use a compact MCP error result:

```json
{
  "error": {
    "code": "PROFILE_SCOPE_FORBIDDEN",
    "message": "Daily Agent sessions can read open Profile entries only."
  }
}
```

Stable codes:

- `PROFILE_ACTION_FORBIDDEN` for daily remove/reload;
- `PROFILE_SCOPE_FORBIDDEN` for scoped/private get;
- `PROFILE_UPDATE_INVALID` for an empty, duplicate, non-explicit, non-open,
  agent-targeted, structurally invalid handler payload, or hidden-target update
  batch.

Messages may explain the allowed contract but never identify which entry
failed. MCP `isError` MUST be `true`.

The stable codes apply to inputs that reach the registered handler. Inputs
rejected earlier by the MCP SDK's Zod schema (for example a missing required
field or invalid enum value) use the protocol's standard Invalid Params error.
Those failures must still happen before the handler, perform zero writes, and
contain no submitted Profile body, local path, or stack trace. This issue does
not weaken the public schema into an untyped payload merely to normalize parser
errors.

## 6. Agent-aware tool description and shared schema

The unified tool registration MUST use an Agent-aware description when
`ctx.toolProfile === "agent"`. It must state that daily sessions support only
open `get` and explicit open `update`, and that aliases, remove, and reload are
unavailable.

The Agent registration MUST not claim that observed is the default source.
`source` remains required in the Agent-facing schema and its field description
must identify `explicit` as the only daily value.

The Agent-facing `source` schema deliberately retains the
`explicit | observed | inferred` enum but has no default. A missing source is
therefore rejected by MCP Zod, while well-formed `observed` and `inferred`
attempts reach the handler and receive stable `PROFILE_UPDATE_INVALID` errors.
Real protocol tests MUST lock both the no-default schema and these two handler
denials.

The action and scope enums may continue to include forbidden values so a
well-formed attempted `remove`, `reload`, `scoped`, or `private` call reaches
the deterministic handler denial instead of becoming transport-dependent
Invalid Params. Their field descriptions must mark those values as forbidden
for daily sessions. Full/debug registrations retain the existing description,
source default, and schema compatibility.

## 7. Full and debug compatibility

When `ctx.toolProfile` is `full` or `debug`, `profile` keeps the existing
behavior for get/update/remove/reload, including scoped/private access and
observed/inferred writes.

The legacy aliases keep their existing full-profile behavior. This issue does
not add action policy to the aliases because they are not discoverable in the
daily profile.

`maintenance` continues not to expose `profile`.

## 8. Canonical skill contract

`skills/signal-router.md` and `skills/signal-detector.md` must use only the
unified daily call shape for an explicit preference:

```text
profile({
  action: "update",
  entries: [{
    id: "response-length-short",
    type: "preference",
    category: "communication",
    scope: "open",
    content: "回复保持简洁",
    source: "explicit"
  }]
})
```

The skills MUST NOT instruct a daily Agent to call `get_profile`,
`update_profile`, `remove_profile`, or `reload_profile`. They MUST NOT describe
observed/inferred writes as a daily behavior. Preference persistence remains
triggered only by an explicit user statement.

The example is synthetic and contains no user identity or private vault fact.

## 9. Drift gate

Add a deterministic docs-consistency check scoped to the two signal skill
files. It must:

1. fail if either file is missing;
2. fail if either file contains a legacy Profile alias;
3. require the unified `profile` update call, `entries`, `scope: "open"`, and
   `source: "explicit"` in the operational guidance;
4. reject daily guidance for remove/reload or observed/inferred writes;
5. report only file names and contract tokens, never matching prose or Profile
   content.

The checker is a lexical drift guard, not a parser or authorization layer. The
runtime handler and MCP protocol tests remain the security-relevant truth.

## 10. Test strategy

Implementation follows strict red-green-refactor order.

### 10.1 Surface tests

- daily `tools/list` contains `profile` and excludes `append_page` and all four
  aliases;
- daily count stays `<= 20`;
- full still contains `append_page`, unified `profile`, and aliases;
- debug still contains unified `profile`;
- maintenance still excludes it;
- daily `tools/list` description/schema states open get + explicit open update,
  does not claim aliases are available, and does not advertise an observed
  source default.

### 10.2 Policy unit/integration tests

Use anonymous temporary Profile files and the real registered handler to prove:

- default and explicit-open get return only open entries;
- daily get leaks no scoped/private entry, total, module name, content, or ID;
- scoped/private get fails with the stable code;
- an explicit open preference/constraint/context/habit update succeeds;
- remove/reload fail without mutation;
- empty entries, missing source, observed source, inferred source, private or
  scoped scope, non-empty agents, duplicate IDs, malformed fields, and mixed
  valid/invalid batches all fail with zero file and in-memory side effects;
- collisions with an existing scoped/private ID, including a mixed batch with
  a new valid entry, fail generically with zero side effects;
- updating an existing open entry succeeds without exposing its source module;
- errors contain no temporary absolute path or submitted Profile content.

Malformed values rejected by MCP Zod are asserted as standard Invalid Params;
policy-valid shapes rejected by the handler are asserted against the stable
Profile policy codes.

### 10.3 Real protocol tests

Through a real Agent-profile MCP handshake over in-memory and HTTP transports:

- discover the bounded surface;
- call open get and explicit open update successfully;
- call forbidden actions and verify MCP `isError` plus stable code;
- verify a rejected mixed batch does not create `profile.yaml` or change an
  existing file.

### 10.4 Compatibility and docs tests

- full/debug unified actions remain compatible;
- existing alias tests remain green;
- mutation cases for the skill drift checker fail as intended;
- `check:docs`, resolver pilot, focused tests, lint, full `bun run check`,
  `git diff --check`, and privacy scans pass.

## 11. Privacy boundary

- No real names, organizations, products, paths, email addresses, credentials,
  Profile content, or vault facts in public docs, fixtures, diagnostics, PR
  text, or issue comments.
- Temporary test paths are synthetic and MUST not appear in returned errors.
- Daily reads expose open entries only; hidden-scope aggregate metadata and
  module names are treated as private.
- Daily errors are fail-closed and non-reflective.

## 12. Non-goals

- No automatic preference inference or observed-write promotion.
- No authenticated Agent identity or scoped/private authorization.
- No Profile YAML schema, database, ontology, vault, or migration change.
- No removal of compatibility aliases.
- No Profile storage transaction redesign for valid-batch I/O failures.
- No module source-ownership or symlink policy. Existing open module entries
  retain current writeback behavior; deployments should keep module ownership
  under their existing operational controls.
- No migration or deletion of Hermes-owned memory.
- No structured-output rollout or recall/ranking change.

## 13. Acceptance

1. A real daily Agent discovers and can call unified `profile`.
2. The daily surface remains bounded at 20 or fewer tools.
3. Daily reads and their metadata contain open Profile data only.
4. Daily writes require a non-empty, whole-batch-valid set of explicit open
   entries and produce no partial side effect on invalid input.
5. Daily remove/reload and scoped/private access fail closed.
6. Full/debug and full-only aliases remain compatible.
7. Canonical signal skills use the real unified schema and are protected by a
   deterministic drift gate.
8. Focused, protocol, docs, privacy, lint, and full test gates pass.

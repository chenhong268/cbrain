# MCP Validation Error Boundary Design

**Issue:** #353
**Date:** 2026-07-19
**Status:** Approved for implementation

## 1. Problem

`@modelcontextprotocol/sdk` 1.29.0 validates `tools/call` arguments before a
CBrain tool handler runs. On validation failure, the SDK formats the complete
validator detail into an error `CallToolResult`. Enum failures can therefore
copy the rejected value into model-visible MCP text.

CBrain currently wraps `McpServer.registerTool()` handlers in
`attachMcpTools()`, but that wrapper executes after SDK input validation. It
cannot sanitize this failure path. The real Hermes host canary proved the same
exposure for `query`, `deep_recall`, and `cbrain_recall` in both legacy and
structured modes.

The required result is a shared, deterministic boundary that prevents rejected
arguments, validator detail, credentials, paths, stack traces, and routing
internals from reaching MCP output or logs while preserving all successful
tool contracts.

## 2. Root-cause trace

```text
Hermes tools/call request
  -> MCP transport
  -> SDK CallToolRequest handler
  -> SDK validateToolInput(tool, arguments, name)
  -> Zod failure includes rejected value
  -> SDK createToolError(raw validator message)
  -> model-visible CallToolResult

  CBrain registered handler is never invoked.
```

The fault is the position of the existing CBrain catch boundary, not the three
recall implementations or structured output formatting.

## 3. Approaches considered

### A. Decorate the SDK CallTool request handler — selected

Before the first tool registration, temporarily decorate the public
`Server.setRequestHandler()` method on the `McpServer.server` instance. When
the SDK installs its `CallToolRequestSchema` handler, wrap that handler. The
wrapper lets the SDK perform its normal validation and execution, then replaces
only a returned input-validation error with the fixed CBrain error result.

After tool registration, restore the original `setRequestHandler` method. The
registered wrapper remains closed over the SDK handler, so normal calls still
use the SDK implementation and future unrelated request-handler registrations
are not intercepted.

Advantages:

- one boundary covers stdio and HTTP sessions because both call
  `attachMcpTools()`;
- no SDK fork or `node_modules` modification;
- no per-tool duplication;
- successful results and non-validation handler failures remain unchanged;
- the wrapper sees the completed error result and never needs to inspect or
  serialize `request.params.arguments`.

Cost: this is an adapter around the SDK registration lifecycle. Contract tests
must fail if a future SDK version changes that lifecycle.

#### Runtime correction — 2026-07-19 adversarial review

The original design above assumed the supplied `CallToolRequestSchema` handler
was the outermost validation point. Source inspection and a malformed-envelope
transport test proved that SDK 1.29.0 adds two outer layers: `Server` validates
the canonical call request and `Protocol` parses the registration schema before
the supplied handler runs. `Server` also parses and clones a completed
`CallToolResult`, so result-object identity cannot prove handler provenance.

The corrected adapter still observes the public registration lifecycle, then
wraps the final `tools/call` entry in the SDK dispatch map. It applies the
canonical `CallToolRequestSchema` before either outer validator can serialize
diagnostics, delegates every valid request to the complete SDK handler, and
fails closed during registration if that dispatch entry is not observable.
Because this touches one private SDK map, its lifecycle is explicitly locked by
transport tests; it remains preferable to overriding validation methods or
forking the SDK.

To distinguish SDK input failures from business errors that intentionally use
the same text prefix, `attachMcpTools()` records handler execution against the
SDK's per-request `extra` object. The dispatch wrapper consumes that one-call
marker. It never scans arguments or trusts forgeable result text alone.

### B. Override private `McpServer.validateToolInput` or `createToolError`

This is smaller but depends directly on private SDK members declared private in
the shipped type definitions. It would be easy for an SDK update to bypass the
override silently. Rejected.

### C. Change each tool schema or handler

Schema error maps can still be reformatted by the SDK, handlers never run for
invalid inputs, and three local patches would not protect future tools.
Rejected as incomplete and duplicative.

### D. Patch or fork the MCP SDK

This would make dependency installation and upgrades unsafe and moves a CBrain
policy into third-party code. Rejected.

## 4. Exact contract

### 4.1 Model-visible result

Every SDK input-validation failure from a registered CBrain tool returns:

```json
{
  "content": [
    {
      "type": "text",
      "text": "Invalid tool arguments."
    }
  ],
  "isError": true
}
```

The string is fixed. It contains no tool name, rejected value, validation path,
expected enum, schema detail, stack trace, mode, or routing field.

Hermes may project the fixed text into its own `{ "error": "..." }` wrapper;
the CBrain result itself does not create a second JSON envelope.

### 4.2 Detection

Malformed `tools/call` envelopes that fail the canonical request schema are
replaced immediately. For canonical requests, the adapter replaces a returned
result only when all of these are true:

1. the request schema being registered is `CallToolRequestSchema`;
2. the returned value is a `CallToolResult` with `isError === true`;
3. at least one content item is text;
4. the first text starts with either `Input validation error:` or the SDK
   `MCP error -32602: Input validation error:` wrapper;
5. the registered CBrain handler was not invoked for this request.

The match is anchored at the start and bounded to these two forms. Additional
content cannot make a recognized validation failure fall back to the unsafe
result; the whole result is replaced.

All other results pass through byte-for-byte. The adapter never scans request
arguments for secret-looking values and never relies on a credential blacklist.

### 4.3 Operator diagnostic

For each replaced result, log one warning with:

- module: `mcp`;
- message/code: `MCP_INPUT_INVALID`;
- optional `tool` only after the SDK has already resolved it to a registered
  tool and it matches the bounded tool-name grammar.

The log must not include arguments, validator detail, raw error text, stack
trace, output mode, request identifiers, local paths, or credentials. Failure
to write the warning must not re-expose the original error or fail a read-only
tool call.

## 5. Components

### `src/mcp/validation-error-boundary.ts`

Owns the fixed error text, stable operator code, canonical request boundary,
input-validation result classifier, per-request handler provenance marker,
safe result builder, and one function that installs the temporary
request-handler decorator.

The module exports a narrow interface:

```ts
export const MCP_INPUT_INVALID_CODE = "MCP_INPUT_INVALID";
export const MCP_INPUT_INVALID_TEXT = "Invalid tool arguments.";

export function installMcpValidationErrorBoundary(
  server: McpServer,
  logger: Pick<Logger, "warn">,
): () => void;

// Internal integration hook used only by attachMcpTools() wrappers.
export function markMcpHandlerInvocation(args: unknown[]): void;
```

The returned function restores the original `Server.setRequestHandler`. Calling
it more than once is safe; overlapping installs are reference-counted so
out-of-order restores cannot leave a stale decorator. `attachMcpTools()`
installs the decorator before registration and restores it in `finally`,
including if registration throws.

### `src/mcp/server.ts`

Keeps existing profile gating and handler sanitization. Its `registerTool` and
legacy `tool` wrappers additionally record that a real handler began executing;
the legacy wrapper still does not catch or rewrite thrown errors. It adds the
install/restore lifecycle around `registerAllTools()`.

### `src/core/logger.ts`

Logger write failures emit only the stable `LOGGER_WRITE_FAILED` marker. OS
error messages are not printed because they may contain absolute paths. An
`ENOENT` caused by removed test/runtime directories remains silently ignored.

## 6. Testing

### Unit/transport contract

Add a focused real `InMemoryTransport + Client.callTool()` suite proving:

- a schema receives an anonymous credential/path-like rejected enum value;
- the handler is not called;
- the returned result is exactly the fixed shape;
- neither result nor persisted log contains the sentinel, validator detail,
  expected enum, or stack;
- `MCP_INPUT_INVALID` and only a safe tool name are logged;
- normal success, explicit handler `isError`, thrown handler errors, unknown
  tool calls, and output-validation errors are not reclassified;
- both recognized prefixes returned by a handler remain unchanged;
- malformed outer envelopes do not expose canonical schema diagnostics;
- nested, Unicode, multiline, and long rejected values remain absent;
- overlapping installs and registration failure restore `setRequestHandler`;
- logger write and callback failures cannot disclose paths or rejected values.

### Real CBrain surfaces

Extend the existing HTTP canary preflight across:

```text
query × legacy
query × structured
deep_recall × legacy
deep_recall × structured
cbrain_recall × legacy
cbrain_recall × structured
```

Each request must contain the anonymous sensitive sentinel, return `isError`,
omit all sentinel/validator/stack material, and leave normal, empty, and
`include_raw` results unchanged.

Update the existing Profile pre-handler validation test to assert the same
fixed boundary and zero writes. This prevents old tests from preserving the
unsafe SDK detail as an expected contract.

### Release proof

After implementation review, freeze a new checkpoint and run the complete real
Hermes host canary. Acceptance is 24/24 primary cases and 12/12 AB/BA cases,
including all 6/6 error cases, with live fingerprints and owned cleanup intact.

## 7. Non-goals

- Do not change the live output mode or enable a structured cohort.
- Do not add the cohort rollback command in this issue.
- Do not change successful legacy or structured envelopes.
- Do not redesign all handler-generated error messages.
- Do not add credential/path pattern lists.
- Do not modify tool schemas, search, ranking, Profile policy, vault data,
  database schema, ontology, or Hermes private configuration.
- Do not claim this boundary prevents prompt injection in successful untrusted
  tool content.

## 8. Rollback

The change is additive and centralized. Reverting the implementation commit
removes the adapter and restores SDK 1.29.0 behavior; no data or configuration
migration is involved. The live default remains legacy throughout.

## 9. Adversarial review checklist

1. Can nested, Unicode, multiline, or very long rejected values escape?
2. Can a handler forge the SDK prefix and cause an unintended rewrite?
3. Can SDK upgrade or registration order bypass the boundary?
4. Can logs contain the raw validator error through another path?
5. Does HTTP use a separate registration path?
6. Are successful and existing handler-error bytes unchanged?
7. Does registration failure leave a monkey-patched method installed?
8. Can an attacker-controlled tool name enter logs?
9. Does the real host still project both modes consistently?

Any unresolved item blocks merge.

# MCP Validation Error Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace SDK pre-handler input-validation detail with one fixed privacy-safe MCP result across CBrain stdio and HTTP transports.

**Architecture:** Install a temporary decorator around the low-level public `Server.setRequestHandler()` while `McpServer` registers tools. The decorator wraps only the SDK `CallToolRequestSchema` handler, replaces recognized SDK input-validation `CallToolResult` values, emits a bounded operator code, and passes every other result through unchanged. Restore the registration method in `finally` so only the installed call-tool handler retains the boundary.

**Tech Stack:** TypeScript 5.9, Bun 1.3, `@modelcontextprotocol/sdk` 1.29.0, Zod 3, Bun test, MCP InMemory and Streamable HTTP transports.

## Global Constraints

- Follow `docs/superpowers/specs/2026-07-19-mcp-validation-error-boundary-design.md` exactly.
- Write and run each regression test before production code; record the expected RED.
- Do not modify `node_modules`, dependency versions, tool schemas, database schema, ontology, search, ranking, or live configuration.
- Do not change successful legacy/structured results or non-validation handler errors.
- Never put rejected arguments, validator detail, paths, credentials, stack traces, or private identifiers in output, logs, fixtures, commits, or reports.
- Use anonymous synthetic sentinels only.
- Keep `CBRAIN_OUTPUT_BOUNDARY` default at `legacy`.
- Do not implement rollout or cohort rollback in this issue.

---

### Task 1: Lock the failing shared transport contract

**Files:**
- Create: `tests/mcp/validation-error-boundary.test.ts`
- Modify: `tests/mcp/profile-agent-policy.test.ts`

**Interfaces:**
- Consumes: `attachMcpTools(server, ctx)` and real MCP `Client.callTool()`.
- Produces: a RED contract for exact fixed output, zero handler calls, bounded logs, and preservation of unrelated errors.

- [ ] **Step 1: Create an InMemory transport fixture with a real invalid enum**

Use a temporary CBrain context, call `attachMcpTools()`, then register a synthetic
tool through the already-decorated `McpServer`:

```ts
const SENTINEL = "api_key=sk-anonymous0000000000000000 /private/fixture/credential.txt";
let handlerCalls = 0;
server.registerTool(
  "validation_boundary_probe",
  { inputSchema: { strategy: z.enum(["fts", "vector"]) } },
  async () => {
    handlerCalls += 1;
    return { content: [{ type: "text" as const, text: "handler-ran" }] };
  },
);

const result = await client.callTool({
  name: "validation_boundary_probe",
  arguments: { strategy: SENTINEL },
});

expect(result).toEqual({
  content: [{ type: "text", text: "Invalid tool arguments." }],
  isError: true,
});
expect(handlerCalls).toBe(0);
```

Read the temporary Logger output and assert it contains `MCP_INPUT_INVALID` and
`validation_boundary_probe`, but not the sentinel, `Input validation error`,
`invalid_enum_value`, `stack`, or any absolute temporary path.

- [ ] **Step 2: Add pass-through and restoration cases**

In the same test file, prove:

```ts
expect(await callNormalTool()).toEqual(normalResult);
expect(await callExplicitHandlerError()).toEqual(explicitHandlerError);
expect(await callThrownHandlerError()).toEqual(existingSanitizedThrownError);
expect(await callUnknownTool()).not.toEqual(fixedInputValidationResult);
```

Add a registration-failure fixture that throws inside tool registration and
asserts the low-level `server.server.setRequestHandler` reference is restored.

- [ ] **Step 3: Update the existing Profile pre-handler expectation**

Replace expectations that preserve raw SDK detail with:

```ts
expect(typedResult).toEqual({
  content: [{ type: "text", text: "Invalid tool arguments." }],
  isError: true,
});
expect(JSON.stringify(typedResult)).not.toContain("Input validation error");
```

Keep all existing byte and in-memory zero-write assertions.

- [ ] **Step 4: Run RED**

Run:

```bash
bun test tests/mcp/validation-error-boundary.test.ts tests/mcp/profile-agent-policy.test.ts
```

Expected: FAIL because invalid values still appear in the SDK error and the
fixed result/constants do not exist. Confirm the handler remains uncalled so
the test exercises pre-handler validation.

- [ ] **Step 5: Commit only the RED tests**

```bash
git add tests/mcp/validation-error-boundary.test.ts tests/mcp/profile-agent-policy.test.ts
git commit -m "test(mcp): expose validation error leakage"
```

---

### Task 2: Implement the centralized validation-error adapter

**Files:**
- Create: `src/mcp/validation-error-boundary.ts`
- Modify: `src/mcp/server.ts`
- Test: `tests/mcp/validation-error-boundary.test.ts`

**Interfaces:**
- Consumes: `McpServer`, `CallToolRequestSchema`, and `Pick<Logger, "warn">`.
- Produces:

```ts
export const MCP_INPUT_INVALID_CODE: "MCP_INPUT_INVALID";
export const MCP_INPUT_INVALID_TEXT: "Invalid tool arguments.";
export function installMcpValidationErrorBoundary(
  server: McpServer,
  logger: Pick<Logger, "warn">,
): () => void;
```

- [ ] **Step 1: Implement pure classification and fixed result construction**

Create `src/mcp/validation-error-boundary.ts` with bounded record checks. The
classifier must accept only an `isError === true` result whose first text item
starts with one of:

```ts
const INPUT_VALIDATION_PREFIXES = [
  "Input validation error:",
  "MCP error -32602: Input validation error:",
] as const;
```

Return a fresh exact result:

```ts
{
  content: [{ type: "text" as const, text: MCP_INPUT_INVALID_TEXT }],
  isError: true as const,
}
```

Do not inspect request arguments or copy any source error field.

- [ ] **Step 2: Install the temporary request-registration decorator**

Capture `server.server.setRequestHandler`, replace it with a type-compatible
decorator, and compare the schema by identity with `CallToolRequestSchema`.
For that schema only, wrap the SDK handler:

```ts
const result = await sdkHandler(request, extra);
if (!isInputValidationResult(result)) return result;

const tool = safeToolName(request);
try {
  logger.warn("mcp", MCP_INPUT_INVALID_CODE, tool ? { tool } : undefined);
} catch {
  // Logging failure must not re-expose the rejected result.
}
return fixedInputValidationResult();
```

`safeToolName()` may return a value only when the request has
`params.name` matching `/^[a-z0-9_]{1,64}$/`. It must not read
`params.arguments`.

Return an idempotent restore closure that reinstates the exact original method.

- [ ] **Step 3: Integrate with `attachMcpTools()`**

In `src/mcp/server.ts`, install the adapter after profile selection but before
the first `origRegister()` call. Wrap only `registerAllTools()`:

```ts
const restoreValidationBoundary = installMcpValidationErrorBoundary(server, ctx.logger);
try {
  registerAllTools(server, ctx);
} finally {
  restoreValidationBoundary();
}
```

Keep the existing `registerTool` and `server.tool` patches unchanged except for
the surrounding lifecycle.

- [ ] **Step 4: Run GREEN and refactor**

```bash
bun test tests/mcp/validation-error-boundary.test.ts tests/mcp/profile-agent-policy.test.ts tests/mcp/attach-tools.test.ts
bun run typecheck
bun run typecheck:tests
bun run lint
```

Expected: all pass, no warnings. Refactor only names/types; do not broaden which
errors are replaced.

- [ ] **Step 5: Commit implementation**

```bash
git add src/mcp/validation-error-boundary.ts src/mcp/server.ts tests/mcp/validation-error-boundary.test.ts tests/mcp/profile-agent-policy.test.ts
git commit -m "fix(mcp): redact pre-handler validation errors"
```

---

### Task 3: Cover the six real HTTP CBrain cases

**Files:**
- Modify: `tests/release/hermes-structured-host-canary.test.ts`
- Test: `tests/release/hermes-structured-host-canary.test.ts`

**Interfaces:**
- Consumes: `createAnonymousFixtureSnapshot()`, `buildCanaryToolArguments()`, and Streamable HTTP MCP transport.
- Produces: all three affected tools × both output modes with non-vacuous sensitive input and clean direct MCP output.

- [ ] **Step 1: Expand the direct preflight matrix**

Run the existing disposable snapshot once per mode:

```ts
for (const mode of ["legacy", "structured"] as const) {
  const runtime = await fixture.openRuntime(mode, `direct-preflight-${mode}`);
  // connect real StreamableHTTPClientTransport
  for (const tool of tools) {
    const invalid = await client.callTool({
      name: tool,
      arguments: buildCanaryToolArguments(tool, "error"),
    });
    const invalidText = JSON.stringify(invalid);
    expect(invalid).toEqual({
      content: [{ type: "text", text: "Invalid tool arguments." }],
      isError: true,
    });
    expect(invalidText).not.toContain(ANONYMOUS_FIXTURE_MARKERS.sensitive_credential);
    expect(invalidText).not.toContain(ANONYMOUS_FIXTURE_MARKERS.sensitive_path);
    expect(invalidText).not.toContain("Input validation error");
    expect(invalidText).not.toMatch(/stack trace|Traceback|\n\s+at\s+/i);
  }
}
```

Retain normal and empty assertions. Add `include_raw` checks if the loop
refactor would otherwise stop exercising them.

- [ ] **Step 2: Prove the test is non-vacuous**

Before calling each invalid case, serialize the constructed arguments and
assert both anonymous sensitive markers are present. The handler-side result
must omit them. Do not weaken or remove the error branch.

- [ ] **Step 3: Run focused HTTP and MCP suites**

```bash
bun test tests/release/hermes-structured-host-canary.test.ts
bun test tests/mcp/
```

Expected: all non-host tests pass; only the predeclared external real-host
cases remain skipped when their explicit environment is absent.

- [ ] **Step 4: Commit transport coverage**

```bash
git add tests/release/hermes-structured-host-canary.test.ts
git commit -m "test(hermes): lock validation error redaction"
```

---

### Task 4: Verification, adversarial review, and frozen host evidence

**Files:**
- Modify: `docs/reports/2026-07-19-hermes-structured-host-canary.md` only if the real frozen run succeeds.
- Modify: issue/PR metadata after local verification; no live configuration files.

**Interfaces:**
- Consumes: Tasks 1–3 and the existing isolated host canary runner.
- Produces: reviewed implementation, full local gates, frozen 24/24 + 12/12 report, and merge-ready evidence.

- [ ] **Step 1: Run local gates**

```bash
bun run check:docs
bun run check
git diff --check origin/main...HEAD
```

Expected: `4631 + new tests` pass, 4 environment-gated tests skipped, 0 fail.
Run a changed-file privacy scan for local paths, credentials, private names,
emails, and vault-derived content.

- [ ] **Step 2: Dispatch three adversarial reviewers**

Use independent Agents for:

1. protocol/SDK lifecycle bypasses and handler-forged prefixes;
2. model-visible/log privacy and hostile input mutations;
3. stdio/HTTP/real-host isolation, cleanup, and regression scope.

Fix every CRITICAL/HIGH/MEDIUM finding with a new RED-GREEN cycle. Reviewers
must inspect actual diff and tests, not summaries.

- [ ] **Step 3: Freeze and run the complete real host canary**

Use the existing repository-owned isolated runner and a newly reviewed
checkpoint. Run all 24 primary and 12 AB/BA cases. Require:

```text
primary=24/24
ab_ba=12/12
normal_empty_include_raw=18/18
error=6/6
host_compatibility=compatible
live_fingerprint=unchanged
owned_cleanup=verified
```

The report must explicitly keep rollout disabled and state that rollback
readiness remains a separate gate.

- [ ] **Step 4: Final verification and delivery commit**

```bash
bun run check:docs
bun run check
git diff --check origin/main...HEAD
git status --short --branch
```

Commit only new report/review adjustments:

```bash
git add docs/reports/2026-07-19-hermes-structured-host-canary.md <review-fix-files>
git commit -m "test(hermes): verify safe validation error projection"
```

Push, open a PR that closes #353, wait for CI, merge only when green, verify
#353 closed, update #333/#327 with the new evidence, and remove the owned
worktree/branch without modifying the user's main worktree.

---

## Plan self-review

- Spec coverage: root cause, centralized boundary, exact output, bounded log,
  six real cases, no rollout, canary rerun, rollback separation, and privacy are
  each mapped to a task.
- Placeholder scan: no deferred implementation markers or implicit “similar”
  steps.
- Type consistency: constants and `installMcpValidationErrorBoundary()` match
  the approved spec; all later tasks consume the same names and exact output.
- Scope: one runtime behavior change plus its evidence; rollout/rollback remains
  outside #353.

## Adversarial review addendum — 2026-07-19

The first GREEN implementation followed the planned public-handler wrapper,
but three independent reviews found that SDK 1.29.0 performs canonical request
validation outside it and clones returned results. The implementation phase is
therefore extended with the following TDD corrections before evidence freeze:

1. malformed outer `tools/call` envelopes must return the same fixed result;
2. handler provenance must prevent either SDK-like prefix from rewriting a
   legitimate business error, including multi-content results;
3. overlapping boundary installs must restore safely out of order;
4. Logger fallback output must not print OS messages or absolute paths;
5. the environment-gated real Hermes matrix must expect six directly safe
   error cases and only the independent rollback gate to remain blocked;
6. the frozen source digest/count and report must be regenerated only after
   these corrections pass focused, full, and adversarial review.

The runtime correction and its private dispatch-map dependency are documented
in the spec. The final commit identifier is recorded only in delivery evidence,
not inside its own source commit.

# Recall / Query Structured Output Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Migrate `cbrain_recall`, `deep_recall`, and `query` to the #327 structured output boundary without changing legacy output or recall behavior.

**Architecture:** Add a pure recall/query projection module with exact direct-tool schemas and named key policies. Extend the existing result builder with caller-supplied data keys while preserving its graph/timeline default. Each handler keeps its current legacy branch and uses the shared builder only in structured mode. Real MCP transport and isolated HTTP canary tests close the validation gap.

**Tech Stack:** Bun, TypeScript, Zod, MCP SDK `InMemoryTransport` and Streamable HTTP transport.

## Global Constraints

- `legacy` remains the rollout default and is byte-compatible.
- No search, ranking, routing, evidence, DB, LLM, tool-profile, or Hermes configuration change.
- No duplicated safety regex; use the existing shared normalizer and audit redactor.
- All fixtures use anonymous synthetic names.
- Production code follows a witnessed RED test.

---

### Task 1: Tool-specific structured data policy

**Files:**
- Modify: `src/mcp/tools/result-builder.ts`
- Create: `src/mcp/tools/recall-output.ts`
- Test: `tests/mcp/recall-output.test.ts`

**Interfaces:**
- `BuildToolResultInput.dataKeys?: ReadonlySet<string>`
- `sanitizeUntrustedData(value, allowedKeys?)`
- `RECALL_DATA_KEYS`, `QUERY_DATA_KEYS`, `FRONTDOOR_DATA_KEYS`
- direct-tool Zod output schemas and pure projection helpers

- [ ] Write unit tests that fail because caller-specific keys are dropped and internal keys survive the wished-for projections.
- [ ] Run `bun test tests/mcp/recall-output.test.ts` and confirm RED for missing exports/behavior.
- [ ] Implement the smallest pure projections and optional data key policy. Keep graph/timeline default key set unchanged.
- [ ] Run the focused test and existing output-boundary tests; confirm GREEN.

### Task 2: `query` structured branch

**Files:**
- Modify: `src/mcp/tools/search.ts`
- Test: `tests/mcp/recall-query-output-boundary.test.ts`

- [ ] Write RED tests for legacy exact text, structured default raw removal, opt-in audit, and conditional outputSchema.
- [ ] Add `include_raw` input and a structured-only builder branch. Preserve the existing legacy return expression exactly.
- [ ] Run focused tests and verify both modes.

### Task 3: `deep_recall` structured branches

**Files:**
- Modify: `src/mcp/tools/recall.ts`
- Test: `tests/mcp/recall-query-output-boundary.test.ts`
- Test: `tests/mcp/recall-payload-budget.test.ts`

- [ ] Add RED coverage for empty, grounded-empty, grounded, normal compact, and include-raw branches.
- [ ] Centralize only structured serialization through a local helper; leave each legacy payload byte-compatible.
- [ ] Register the exact output schema only in structured mode.
- [ ] Verify #231 compact legacy tests and new structured tests are GREEN.

### Task 4: Frontdoor structured projection

**Files:**
- Modify: `src/mcp/tools/frontdoor.ts`
- Test: `tests/mcp/frontdoor.test.ts`
- Test: `tests/mcp/recall-query-output-boundary.test.ts`

- [ ] Write RED tests for content, grounded, hierarchy, episodic/debug or agentic representative routes; each must retain non-empty semantic data but omit routing/raw by default.
- [ ] Add `include_raw` and the route-aware bounded projection. Do not advertise a loose outputSchema.
- [ ] Keep the legacy envelope exact and verify all existing routing tests.

### Task 5: Real transport and hostile fixtures

**Files:**
- Modify: `tests/mcp/output-trust-boundary-transport.test.ts`
- Test: `tests/mcp/recall-query-output-boundary.test.ts`

- [ ] Add `InMemoryTransport + Client.callTool` RED tests for all three tools in both modes.
- [ ] Add independent credential/path/fullwidth/Cc-Cf/slug/normal-title fixtures through real handlers.
- [ ] Verify schema advertisement and SDK output validation for direct tools; verify frontdoor structured content without a false schema.

### Task 6: Isolated HTTP canary and documentation

**Files:**
- Create: `bin/check-recall-output-boundary-canary.ts`
- Create: `tests/http/recall-output-boundary-canary.test.ts`
- Modify: `docs/hermes-integration.md`
- Modify: `CHANGELOG.md`

- [ ] Write a failing black-box test for an isolated loopback server using temporary storage and structured mode.
- [ ] Implement the bounded canary: initialize, list tools, call three tools, assert no default raw/audit, close server, clean temp state.
- [ ] Document that the canary does not alter live Hermes and that rollout remains legacy.

### Task 7: Verification and adversarial review

- [ ] Run focused MCP/HTTP tests.
- [ ] Run `bun run lint`, `bun run check:docs`, `git diff --check`, privacy grep, then `bun run check`.
- [ ] Attack at least: legacy drift, missing conditional schema, raw alias bypass, nested credential/path, frontdoor route data loss, #231 budget regression, and live-process/config mutation.
- [ ] Fix every CRITICAL/HIGH/MEDIUM finding and rerun affected gates.
- [ ] Commit spec/plan separately if useful; squash production/test work to one implementation commit before integration.


# Format Envelope Helpers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce repeated MCP formatter envelope boilerplate without changing public output.

**Architecture:** Add small internal helper functions in `src/mcp/tools/format-result.ts`, then migrate only low-risk branches that already return standard `ToolSummary` envelopes. Existing tests act as the byte-contract guard.

**Tech Stack:** TypeScript, Bun test, existing MCP formatter tests.

---

## Files

- Modify: `src/mcp/tools/format-result.ts`
- Verify: `tests/mcp/v193-ux-gate.test.ts`
- Verify: `tests/mcp/version-profile-envelope.test.ts`
- Verify: `tests/mcp/graph-timeline-envelope.test.ts`

## Task 1: Add Internal Helper Functions

- [ ] **Step 1: Add helper functions after `toolEnvelope`**

Add:

```ts
type ToolSummaryOptions = Partial<Omit<ToolSummary, "status" | "count" | "message">>;

function makeSummary(
  status: ToolSummary["status"],
  count: number,
  message: string,
  options: ToolSummaryOptions = {},
): ToolSummary {
  return {
    status,
    count,
    truncated: false,
    message,
    ...options,
  };
}

function okEnvelope<T>(raw: T, display: string, count: number, message: string, options?: ToolSummaryOptions) {
  return toolEnvelope(raw, display, makeSummary("ok", count, message, options));
}

function emptyEnvelope<T>(raw: T, display: string, message: string, options?: ToolSummaryOptions) {
  return toolEnvelope(raw, display, makeSummary("empty", 0, message, options));
}

function errorEnvelope<T>(raw: T, display: string, message: string, options?: ToolSummaryOptions) {
  return toolEnvelope(raw, display, makeSummary("error", 0, message, options));
}
```

- [ ] **Step 2: Run typecheck**

Run:

```bash
bun run typecheck
```

Expected: pass.

## Task 2: Migrate Low-risk Formatter Branches

- [ ] **Step 1: Update `formatGetPageEnvelope`**

Replace direct `toolEnvelope(... { status, count, truncated, message })` calls with `emptyEnvelope` / `okEnvelope`. Preserve exact display and message strings.

- [ ] **Step 2: Update `formatVersionsEnvelope`**

Replace direct object returns with `emptyEnvelope` / `okEnvelope`. Preserve exact display, summary count, truncated, and raw values.

- [ ] **Step 3: Update `formatRevertEnvelope`**

Replace direct object returns with `okEnvelope` / `errorEnvelope`. Preserve exact display and messages.

- [ ] **Step 4: Update `formatRemoveProfileEnvelope`**

Replace direct object returns with `emptyEnvelope` / `okEnvelope`. Preserve exact display, count, and messages.

## Task 3: Verify Formatter Contracts

- [ ] **Step 1: Run focused tests**

Run:

```bash
bun test tests/mcp/v193-ux-gate.test.ts tests/mcp/version-profile-envelope.test.ts tests/mcp/graph-timeline-envelope.test.ts
```

Expected: pass.

- [ ] **Step 2: Run type/lint gates**

Run:

```bash
bun run typecheck
bun run typecheck:tests
bun run lint
```

Expected: all pass.

## Task 4: Adversarial Review and Full Gate

- [ ] **Step 1: Review likely failure modes**

Check:

- migrated branches still sanitize display where they did before
- helper defaults do not override custom `truncated`
- `raw` remains unchanged
- no real/private examples appear in diff

- [ ] **Step 2: Run full gate**

Run:

```bash
bun run check
```

Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add src/mcp/tools/format-result.ts docs/superpowers/specs/2026-07-05-format-envelope-helpers-design.md docs/superpowers/plans/2026-07-05-format-envelope-helpers.md
git commit -m "refactor(mcp): consolidate envelope formatter helpers"
```

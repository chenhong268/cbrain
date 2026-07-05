# Envelope Helper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce repeated MCP envelope construction in low-risk formatter branches without changing public JSON shape or wording.

**Architecture:** Add a tiny generic `toolEnvelope()` helper inside `src/mcp/tools/format-result.ts`. Migrate only `formatQueryEnvelope`, `formatGetPageEnvelope`, and `formatGetPagesEnvelope` to use it. Existing formatter tests remain the public contract.

**Tech Stack:** TypeScript, Bun tests, existing MCP formatter test suites.

---

## Files

- Modify: `src/mcp/tools/format-result.ts`
- Modify: `tests/mcp/envelope.test.ts`

## Task 1: Helper Contract

- [ ] Write failing test importing `toolEnvelope` from `format-result.ts`.
- [ ] Assert it returns `{ display, summary, raw }`, preserves the exact raw object identity, and keeps optional summary fields.
- [ ] Run `bun test tests/mcp/envelope.test.ts` and verify RED because `toolEnvelope` is missing.
- [ ] Implement `toolEnvelope<T>(raw, display, summary): { display; summary; raw }`.
- [ ] Run `bun test tests/mcp/envelope.test.ts` and verify GREEN.

## Task 2: Migrate Query/GetPage/GetPages

- [ ] Add exact-output regression checks for migrated formatter branches before refactor.
- [ ] Run them to ensure they pass on current behavior.
- [ ] Refactor `formatQueryEnvelope`, `formatGetPageEnvelope`, and `formatGetPagesEnvelope` to call `toolEnvelope`.
- [ ] Run `bun test tests/mcp/envelope.test.ts tests/mcp/ux-contract.test.ts`.

## Task 3: Verification And Adversarial Review

- [ ] Verify no display/summary wording changed for migrated formatters.
- [ ] Verify raw object identity is preserved.
- [ ] Verify sanitization behavior did not weaken.
- [ ] Verify `next_steps` and `degraded_reason` remain in the same branches.
- [ ] Run `git diff --check`, `bun run lint`, `bun run typecheck`, and `bun run check`.

# Unified Tag Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a unified `tag` MCP tool behind compatibility aliases without removing `get_tags`, `add_tag`, or `remove_tag`.

**Architecture:** Refactor `src/mcp/tools/tags.ts` into small internal action handlers and register both the new `tag` tool and the existing old-name tools against those handlers. Keep response JSON shapes unchanged.

**Tech Stack:** TypeScript, MCP SDK server tool registration, Bun tests.

---

## Files

- Modify: `src/mcp/tools/tags.ts`
- Modify: `src/mcp/tool-profiles.ts`
- Modify: `tests/mcp/server.test.ts`
- Modify: `tests/mcp/tool-profiles.test.ts`

## Task 1: Red Tests For Unified Tool

- [ ] Add `tag` to the full inventory expectation in `tests/mcp/server.test.ts`.
- [ ] Add tests for `tag` action `list`, `add`, and `remove`.
- [ ] Use anonymous slugs and tag names only.
- [ ] Run `bun test tests/mcp/server.test.ts` and verify RED because `tag` is not registered.

## Task 2: Implement Shared Tag Handlers

- [ ] In `src/mcp/tools/tags.ts`, extract internal async functions for list/add/remove.
- [ ] Register new `tag` tool with `action: z.enum(["list", "add", "remove"])`, `slug`, and optional `tag`.
- [ ] Route old tools through the same internal functions.
- [ ] Preserve old response shapes exactly.
- [ ] Run `bun test tests/mcp/server.test.ts` and verify GREEN.

## Task 3: Tool Profile Compatibility

- [ ] Add `tag` to `DEBUG_ALLOWLIST`.
- [ ] Add tool-profile tests that debug allows `tag` and agent excludes `tag`.
- [ ] Run `bun test tests/mcp/tool-profiles.test.ts tests/mcp/server.test.ts`.

## Task 4: Verification And Adversarial Review

- [ ] Run `git diff --check`.
- [ ] Run `bun run typecheck`.
- [ ] Run `bun run lint`.
- [ ] Run `bun run check`.
- [ ] Verify old tools remain registered.
- [ ] Verify agent profile remains <= 20 and unchanged.
- [ ] Verify no private examples appear in tests/docs.
